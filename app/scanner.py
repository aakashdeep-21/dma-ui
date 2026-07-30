"""Market Scanner data engine — read-only market intelligence for the terminal.

WHAT THIS IS
============
One background sampler polls the exchange's PUBLIC ticker list (via the same
signed read-only `dma_client.get_tickers` call the Watch tab already uses —
one request returns the whole linear universe) on a fixed cadence, keeps a
compact rolling price/volume/funding history per symbol, and pre-computes a
scanner snapshot (top-mover / volatility / volume / funding metrics plus a
sparkline series per symbol). The `/api/scanner` route serves that snapshot
straight from memory: N open tabs cost ZERO extra exchange calls — exactly the
same shared-poll economics as the dashboard's WebSocket broadcaster.

ISOLATION / SAFETY
==================
Read-only by construction: this module only ever calls `get_tickers` (a market
read) and exposes a snapshot dict. It holds no write capability, no order
state, and fabricates nothing — any metric whose source data is missing (the
gateway omits the field, or the rolling window hasn't filled since boot) is
`None`, and the UI renders it as "—" with a warm-up cue.

FUTURE-PROOFING
===============
Metrics are computed by small independent "providers" registered in
`_PROVIDERS`. A new metric (open-interest delta, an AI signal, …) is one new
provider function appended to the list — the snapshot envelope, endpoint and
frontend row-patching all key off field names, so nothing structural changes.
"""
import asyncio
import logging
import math
import re
import time
from array import array
from bisect import bisect_left, bisect_right

from . import dma_client
from .config import settings

logger = logging.getLogger("dma-ui.scanner")

# Rolling-history depth: a little over the largest lookback window (1h) so the
# 1h metrics stay computable while old samples are trimmed.
HISTORY_MS = 65 * 60_000
# Lookback windows for short-horizon change metrics (label -> milliseconds).
WINDOWS_MS = {"m5": 5 * 60_000, "m15": 15 * 60_000, "h1": 60 * 60_000}
# Sparkline: at most this many points, spanning up to the full history window.
SPARK_POINTS = 30
# A window metric is only computed when history reaches this share of the
# window — otherwise it is None (shortened baselines would overstate moves).
WINDOW_MIN_COVERAGE = 0.85

# Same charset rule as the trading routes' symbol validation (main._SYMBOL_RE);
# duplicated here so this module stays importable standalone (tests, tools).
_SYMBOL_RE = re.compile(r"^[A-Z0-9]{1,20}$")

# After an upstream rate limit, sit out this many EXTRA sample intervals.
_RATE_LIMIT_EXTRA_CYCLES = 3
# Drop a symbol's history after it has been absent from the ticker list this
# long (delisted / renamed) so the store cannot grow without bound.
_PRUNE_AFTER_MS = 10 * 60_000


def _f(value):
    """Parse to a FINITE float or None. The single trust boundary for every
    number leaving this module: a missing/garbled/inf field becomes None (the
    UI's "—"), never a fake 0 and never invalid JSON."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _round_sig(value, digits=6):
    """Round to `digits` significant figures — keeps spark arrays and derived
    ratios compact on the wire without visibly changing any price."""
    if value == 0:
        return 0.0
    return round(value, digits - 1 - int(math.floor(math.log10(abs(value)))))


class SymbolHistory:
    """Compact rolling history for ONE symbol: parallel `array('d')` columns
    (timestamps ms, last price, 24h turnover, funding rate) appended in
    lockstep and trimmed together. ~6 KB per symbol at a 10s cadence, so the
    whole universe stays a few MB. Funding may be absent upstream — stored as
    NaN so the columns keep identical lengths (NaN is quarantined by _f on the
    way out and never serialized)."""

    __slots__ = ("ts", "price", "turnover", "funding")

    def __init__(self):
        self.ts = array("d")
        self.price = array("d")
        self.turnover = array("d")
        self.funding = array("d")

    def append(self, ts_ms: float, price: float, turnover, funding) -> None:
        self.ts.append(ts_ms)
        self.price.append(price)
        self.turnover.append(turnover if turnover is not None else math.nan)
        self.funding.append(funding if funding is not None else math.nan)

    def trim(self, cutoff_ms: float) -> None:
        idx = bisect_left(self.ts, cutoff_ms)
        if idx:
            del self.ts[:idx]
            del self.price[:idx]
            del self.turnover[:idx]
            del self.funding[:idx]

    def __len__(self) -> int:
        return len(self.ts)

    def covers(self, now_ms: float, window_ms: int) -> bool:
        """True when history reaches far enough back to honestly measure a
        `window_ms` change (see WINDOW_MIN_COVERAGE)."""
        return bool(self.ts) and (now_ms - self.ts[0]) >= window_ms * WINDOW_MIN_COVERAGE

    def at(self, target_ms: float, column: str):
        """Column value from the sample NEAREST target_ms, or None when the
        nearest sample is too far away to stand in for it (more than half a
        window of drift would silently change what the metric measures)."""
        if not self.ts:
            return None
        i = bisect_right(self.ts, target_ms)
        candidates = []
        if i > 0:
            candidates.append(i - 1)
        if i < len(self.ts):
            candidates.append(i)
        best = min(candidates, key=lambda j: abs(self.ts[j] - target_ms))
        return _f(getattr(self, column)[best])

    def min_max_price(self, since_ms: float):
        """(min, max) of price over samples newer than since_ms, or None."""
        i = bisect_left(self.ts, since_ms)
        window = self.price[i:]
        if not window:
            return None
        return (min(window), max(window))

    def spark(self, now_ms: float, points: int = SPARK_POINTS) -> list:
        """Evenly downsampled price series over the retained history (newest
        last, first/last samples always kept). [] until 2+ samples exist."""
        n = len(self.price)
        if n < 2:
            return []
        if n <= points:
            return [_round_sig(v) for v in self.price]
        step = (n - 1) / (points - 1)
        return [_round_sig(self.price[round(k * step)]) for k in range(points)]


def pct_change(now_price, then_price):
    """Percent change (as a PERCENT number, +2.5 == +2.5%) or None. Never
    divides by zero and never invents a change from missing data."""
    now_p, then_p = _f(now_price), _f(then_price)
    if now_p is None or then_p is None or then_p == 0:
        return None
    return _round_sig((now_p - then_p) / then_p * 100.0)


# ---------------------------------------------------------------------------
# Metric providers — each is (ticker_dict, SymbolHistory|None, now_ms) -> dict
# of row fields. Kept independent so new metrics plug in by appending here.
# ---------------------------------------------------------------------------
def _price_provider(t, hist, now_ms):
    return {
        "last": _f(t.get("lastPrice")),
        "mark": _f(t.get("markPrice")),
        "high24h": _f(t.get("highPrice24h")),
        "low24h": _f(t.get("lowPrice24h")),
        "bid1": _f(t.get("bid1Price")),
        "ask1": _f(t.get("ask1Price")),
    }


def _change_provider(t, hist, now_ms):
    """24h from the ticker; 1h prefers the ticker's own prevPrice1h (exact,
    warm from the first sample) and falls back to our rolling history; 15m/5m
    only exist in the history. Uncovered windows are None — never estimated."""
    last = _f(t.get("lastPrice"))
    pct24h = _f(t.get("price24hPcnt"))
    out = {"pct24h": _round_sig(pct24h * 100.0) if pct24h is not None else None}

    pct1h = pct_change(last, t.get("prevPrice1h"))
    for label, key in (("m5", "pct5m"), ("m15", "pct15m"), ("h1", "pct1h")):
        if key == "pct1h" and pct1h is not None:
            out[key] = pct1h
            continue
        window = WINDOWS_MS[label]
        if hist is not None and hist.covers(now_ms, window):
            out[key] = pct_change(last, hist.at(now_ms - window, "price"))
        else:
            out[key] = None
    return out


def _volatility_provider(t, hist, now_ms):
    """Two honest volatility reads: the exchange's own 24h high-low range, and
    the realized 15m range from our sampled history (a fast "moving right now"
    signal). Both are percent-of-last numbers."""
    last = _f(t.get("lastPrice"))
    high, low = _f(t.get("highPrice24h")), _f(t.get("lowPrice24h"))
    range24h = None
    if last and high is not None and low is not None and high >= low:
        range24h = _round_sig((high - low) / last * 100.0)
    vol15m = None
    if last and hist is not None and hist.covers(now_ms, WINDOWS_MS["m15"]):
        mm = hist.min_max_price(now_ms - WINDOWS_MS["m15"])
        if mm is not None:
            vol15m = _round_sig((mm[1] - mm[0]) / last * 100.0)
    return {"range24hPct": range24h, "vol15mPct": vol15m}


def _volume_provider(t, hist, now_ms):
    """turnover24h/volume24h straight from the ticker; turnoverDelta15m is the
    change of the ROLLING 24h turnover over the last 15 minutes — positive
    means activity is accelerating vs. the day's baseline, negative decaying."""
    turnover = _f(t.get("turnover24h"))
    delta = None
    if turnover is not None and hist is not None and hist.covers(now_ms, WINDOWS_MS["m15"]):
        then = hist.at(now_ms - WINDOWS_MS["m15"], "turnover")
        if then is not None:
            delta = _round_sig(turnover - then)
    return {
        "turnover24h": turnover,
        "volume24h": _f(t.get("volume24h")),
        "turnoverDelta15m": delta,
    }


def _funding_provider(t, hist, now_ms):
    """Funding rate as the exchange reports it (a FRACTION, 0.0001 == 0.01%),
    plus its 1h drift from history. Both None when the gateway omits funding —
    the UI then hides the funding surfaces rather than showing zeros."""
    rate = _f(t.get("fundingRate"))
    delta = None
    if rate is not None and hist is not None and hist.covers(now_ms, WINDOWS_MS["h1"]):
        then = hist.at(now_ms - WINDOWS_MS["h1"], "funding")
        if then is not None:
            delta = _round_sig(rate - then)
    next_ms = None
    raw_next = t.get("nextFundingTime")
    if raw_next not in (None, ""):
        try:
            next_ms = int(raw_next)
        except (TypeError, ValueError):
            next_ms = None
    return {"fundingRate": rate, "fundingDelta1h": delta, "nextFundingTime": next_ms}


def _open_interest_provider(t, hist, now_ms):
    return {
        "openInterest": _f(t.get("openInterest")),
        "openInterestValue": _f(t.get("openInterestValue")),
    }


def _spark_provider(t, hist, now_ms):
    if hist is None:
        return {"spark": [], "sparkSpanMs": 0}
    series = hist.spark(now_ms)
    span = int(hist.ts[-1] - hist.ts[0]) if len(hist) >= 2 else 0
    return {"spark": series, "sparkSpanMs": span}


_PROVIDERS = [
    _price_provider,
    _change_provider,
    _volatility_provider,
    _volume_provider,
    _funding_provider,
    _open_interest_provider,
    _spark_provider,
]


# ---------------------------------------------------------------------------
# Sampler state (single event loop — no locks needed; mutated only by the
# sampler task, read by the route).
# ---------------------------------------------------------------------------
_histories: dict[str, SymbolHistory] = {}
_last_seen_ms: dict[str, float] = {}
_snapshot: dict | None = None
_last_sample_ms: int | None = None
_last_error: str | None = None


def last_sample_ms() -> int | None:
    """Epoch-ms of the last successful sample (for /healthz), or None."""
    return _last_sample_ms


def ingest(tickers: list, now_ms: float) -> dict:
    """Fold one ticker-list sample into the rolling histories and build the
    snapshot. Pure-ish (module state in, module state out) and synchronous so
    tests can drive it without the sampler loop."""
    global _snapshot, _last_sample_ms
    rows = []
    capabilities = {"funding": False, "openInterest": False, "pct1h": False}

    for t in tickers:
        if not isinstance(t, dict):
            continue
        sym = str(t.get("symbol") or "").strip().upper()
        last = _f(t.get("lastPrice"))
        if not _SYMBOL_RE.match(sym) or last is None or last <= 0:
            continue  # unusable row: no valid symbol/price to anchor metrics on

        hist = _histories.get(sym)
        if hist is None:
            hist = _histories[sym] = SymbolHistory()
        hist.append(now_ms, last, _f(t.get("turnover24h")), _f(t.get("fundingRate")))
        hist.trim(now_ms - HISTORY_MS)
        _last_seen_ms[sym] = now_ms

        row: dict = {"symbol": sym}
        for provider in _PROVIDERS:
            row.update(provider(t, hist, now_ms))
        rows.append(row)

        if row.get("fundingRate") is not None:
            capabilities["funding"] = True
        if row.get("openInterest") is not None or row.get("openInterestValue") is not None:
            capabilities["openInterest"] = True
        if row.get("pct1h") is not None:
            capabilities["pct1h"] = True

    # Prune symbols that vanished from the universe (delisted/renamed).
    cutoff = now_ms - _PRUNE_AFTER_MS
    for sym in [s for s, seen in _last_seen_ms.items() if seen < cutoff]:
        _last_seen_ms.pop(sym, None)
        _histories.pop(sym, None)

    history_ms = 0
    if rows:
        oldest = min(h.ts[0] for h in _histories.values() if len(h))
        history_ms = int(now_ms - oldest)

    _snapshot = {
        "type": "scanner",
        "asOfMs": int(now_ms),
        "intervalMs": int(settings.SCANNER_SAMPLE_INTERVAL * 1000),
        "universe": len(rows),
        # How far back the rolling history reaches — the UI turns this into a
        # single honest "warming up: Xm/65m" cue for the windowed metrics.
        "historyMs": history_ms,
        "capabilities": capabilities,
        "rows": rows,
    }
    _last_sample_ms = int(now_ms)
    return _snapshot


def snapshot_response() -> dict:
    """What /api/scanner returns: the latest snapshot plus server-clock context
    (the client measures staleness against nowMs, so a skewed browser clock
    can neither cry wolf nor hide a stalled feed)."""
    base = _snapshot or {
        "type": "scanner",
        "asOfMs": None,
        "intervalMs": int(settings.SCANNER_SAMPLE_INTERVAL * 1000),
        "universe": 0,
        "historyMs": 0,
        "capabilities": {"funding": False, "openInterest": False, "pct1h": False},
        "rows": [],
    }
    return {
        **base,
        "nowMs": int(time.time() * 1000),
        "enabled": settings.SCANNER_ENABLED,
        "error": _last_error,
    }


async def _sample_once() -> float:
    """One sampler cycle. Returns EXTRA cooldown seconds (0 normally; >0 after
    an upstream rate limit). Never raises — the loop must outlive any single
    failure, and a failed cycle keeps the previous snapshot serving."""
    global _last_error
    try:
        data = await dma_client.get_tickers()
    except dma_client.DMAError as exc:
        _last_error = "market data temporarily unavailable"
        logger.warning("scanner sample failed: %s", exc.detail)
        if dma_client.is_rate_limit(exc):
            cooldown = settings.SCANNER_SAMPLE_INTERVAL * _RATE_LIMIT_EXTRA_CYCLES
            logger.warning("scanner: upstream rate limit — backing off %.0fs extra", cooldown)
            return cooldown
        return 0.0
    except Exception:
        _last_error = "market data temporarily unavailable"
        logger.exception("scanner sample failed unexpectedly")
        return 0.0
    try:
        ingest(dma_client.extract_list(data), time.time() * 1000)
        _last_error = None
    except Exception:
        # A malformed upstream payload must not kill the sampler.
        logger.exception("scanner ingest failed")
        _last_error = "market data temporarily unavailable"
    return 0.0


async def run_sampler() -> None:
    """Background task (started from the app lifespan, like the notifier and
    history sync). One upstream read per interval feeds every viewer; a
    disabled scanner (SCANNER_ENABLED=0) starts nothing."""
    if not settings.SCANNER_ENABLED:
        logger.info("scanner disabled (SCANNER_ENABLED=0) — /api/scanner serves empty")
        return
    logger.info(
        "scanner sampler started: interval=%.0fs history=%dmin",
        settings.SCANNER_SAMPLE_INTERVAL, HISTORY_MS // 60_000,
    )
    while True:
        cooldown = await _sample_once()
        await asyncio.sleep(settings.SCANNER_SAMPLE_INTERVAL + cooldown)
