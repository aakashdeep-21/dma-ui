"""Out-of-band execution alerts (order fills / TP-SL / liquidations) → Telegram.

Runs as a background task started by the app lifespan, INDEPENDENT of any browser
WebSocket — so alerts fire even when no dashboard tab is open (the whole point).

Design / safety:
  * READ-ONLY on the exchange: it only polls dma_client.get_executions (the same
    signed read the History tab uses), plus a best-effort dma_client.get_closed_pnl
    read to attach realized PnL to closing fills. It has NO write capability
    whatsoever.
  * Outbound only, to a FIXED Telegram chat (api.telegram.org). The bot token and
    chat id are secrets read from the environment; nothing here is user-supplied.
  * Opt-in: if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset the watcher logs
    once and exits — no polling, no errors, zero effect on the rest of the app.
  * Fail-safe: every poll + send is wrapped; a Telegram or upstream error is
    logged and NEVER crashes the loop or touches the trading/dashboard path.
  * Idempotent: a bounded set of seen execIds prevents duplicate alerts. The
    first poll after startup BASELINES (records current fills, sends nothing) so
    history is never replayed. In-memory only — a restart re-baselines, so any
    fills during a restart window are not alerted (a known, documented gap).
  * Bounded window: each poll scans only the newest NOTIFY_EXEC_LIMIT executions;
    if more than that occur within a single poll interval, the oldest of the
    overflow are not alerted — raise NOTIFY_EXEC_LIMIT or lower NOTIFY_POLL_INTERVAL
    for very high fill rates. (Designed for manual / low-frequency trading.)
"""
import asyncio
import logging
from collections import OrderedDict
from datetime import datetime, timezone

import httpx

from . import dma_client
from .config import settings

# Extra poll periods to sit out when the EXCHANGE rate-limits the fill poll —
# alerts are best-effort; hammering a throttled API prolongs the throttle.
_RATE_LIMIT_EXTRA_POLLS = 2

logger = logging.getLogger("dma-ui.notifier")

# Dedicated outbound client (Telegram only). Closed by the lifespan on shutdown.
# trust_env=False for parity with the signed + market-data clients: ambient
# HTTP(S)_PROXY / SSL_CERT_FILE env vars must not be able to reroute or re-anchor
# TLS on this request — its URL path embeds the bot token.
_client = httpx.AsyncClient(timeout=15, trust_env=False)

# Insertion-ordered set of execIds already processed, trimmed to a bound.
_seen: "OrderedDict[str, None]" = OrderedDict()
_SEEN_MAX = 1000


async def aclose() -> None:
    await _client.aclose()


def _enabled() -> bool:
    return bool(settings.TELEGRAM_BOT_TOKEN and settings.TELEGRAM_CHAT_ID)


def _remember(exec_id: str) -> None:
    _seen[exec_id] = None
    while len(_seen) > _SEEN_MAX:
        _seen.popitem(last=False)


async def _send(text: str) -> str:
    """Send a PLAIN-TEXT Telegram message (no parse mode, so any exchange-supplied
    string is inert). Returns one of:
      * "sent"          — confirmed delivery (HTTP 200)
      * "rate_limited"  — Telegram is throttling us (429, still 429 after one retry)
      * "failed"        — any other error

    Honors a 429 Retry-After ONCE (bounded to 30s). NEVER raises, and NEVER logs
    the exception instance, the URL, or the response body — all can embed the bot
    token; we log only the integer status or the exception TYPE name. The caller
    stops the current poll on "rate_limited" so one throttled burst can't stall
    the loop for minutes (undelivered fills stay unseen and retry next poll)."""
    url = f"https://api.telegram.org/bot{settings.TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": settings.TELEGRAM_CHAT_ID,
        "text": text,
        "disable_web_page_preview": True,
    }
    for attempt in (1, 2):
        try:
            resp = await _client.post(url, json=payload)
        except httpx.HTTPError as exc:
            logger.warning("telegram send error: %s", type(exc).__name__)
            return "failed"
        if resp.status_code == 200:
            return "sent"
        if resp.status_code == 429:
            if attempt == 1:
                # Respect Telegram's backoff (parameters.retry_after / Retry-After), retry once.
                retry_after = 1.0
                try:
                    params = (resp.json() or {}).get("parameters") or {}
                    retry_after = float(params.get("retry_after") or resp.headers.get("Retry-After") or 1)
                except (ValueError, TypeError):
                    retry_after = 1.0
                await asyncio.sleep(min(max(retry_after, 0.0), 30.0))
                continue
            return "rate_limited"  # still throttled after one retry
        logger.warning("telegram send failed: HTTP %s", resp.status_code)
        return "failed"
    return "rate_limited"


async def notify(text: str) -> None:
    """Out-of-band OPERATIONAL alert (e.g. "history sync is failing") to the same
    fixed Telegram chat as the fill alerts. No-op when alerts aren't configured;
    shares _send's guarantees (never raises, never logs the bot token). Fire and
    forget: callers don't care whether Telegram actually accepted it."""
    if not _enabled():
        return
    await _send(text)


def _label(ex: dict) -> str | None:
    """Human alert label for an execution, or None to skip (non-order events)."""
    exec_type = str(ex.get("execType") or "")
    stop = str(ex.get("stopOrderType") or "")
    stop_l = stop.lower()  # match case-insensitively so a re-cased/new variant still labels correctly
    if exec_type == "BustTrade":
        return "⚠️ Liquidation"
    if exec_type == "AdlTrade":
        return "⚠️ Auto-deleverage"
    if exec_type != "Trade":
        return None  # Funding / Settle / Delivery / etc. — not an order execution
    if "takeprofit" in stop_l:
        return "\U0001f3af Take-Profit executed"
    if "stoploss" in stop_l:
        return "\U0001f6d1 Stop-Loss executed"
    if "trailingstop" in stop_l:
        return "\U0001f6d1 Trailing-Stop executed"
    if stop and stop_l != "unknownstoporder":
        return f"⚙️ {stop} executed"
    return "✅ Order filled"


def _is_closing(ex: dict) -> bool:
    """True when this fill reduced a position (Bybit sets closedSize > 0)."""
    try:
        return float(ex.get("closedSize") or 0) > 0
    except (TypeError, ValueError):
        return False


async def _resolve_pnl(ex: dict) -> str | None:
    """Realized PnL for this fill, best-effort. Prefer the fill's own
    execPnl/closedPnl when the envelope carries it; otherwise, for closing fills
    only, look up the closing order's closed-pnl record (a signed READ, same data
    the History tab shows). Any lookup failure — including the record not being
    written yet — just means no PnL line; the alert itself is never delayed or
    dropped over it."""
    pnl = ex.get("execPnl")
    if pnl in (None, ""):
        pnl = ex.get("closedPnl")
    if pnl not in (None, ""):
        return pnl
    order_id = ex.get("orderId")
    if not _is_closing(ex) or not order_id:
        return None
    try:
        data = await dma_client.get_closed_pnl(symbol=ex.get("symbol"), days=1)
        records = [r for r in dma_client.extract_list(data) if r.get("orderId") == order_id]
    except Exception as exc:
        logger.warning("closed-pnl lookup for alert failed: %s", type(exc).__name__)
        return None
    if not records:
        return None
    if len(records) == 1:
        return records[0].get("closedPnl")
    # One closing order can (rarely) produce several closed-pnl records; sum them.
    try:
        total = sum(float(r.get("closedPnl") or 0) for r in records)
    except (TypeError, ValueError):
        return records[0].get("closedPnl")
    return f"{total:.8f}".rstrip("0").rstrip(".")


def _fmt_pnl(pnl) -> str | None:
    """PnL line in the settle coin AND INR at the fixed USDT_INR_RATE, e.g.
    "PnL -12.34 USDT (₹-1,159.96)". The exchange's own string is kept for the
    settle-coin figure so no precision is invented; the INR figure is omitted if
    the value doesn't parse or the rate is disabled (<= 0)."""
    if pnl in (None, ""):
        return None
    line = f"PnL {pnl} {settings.SETTLE_COIN}"
    rate = settings.USDT_INR_RATE
    if rate <= 0:
        return line
    try:
        inr = float(pnl) * rate
    except (TypeError, ValueError):
        return line
    return f"{line} (₹{inr:,.2f})"


def _fmt(ex: dict, label: str, pnl=None) -> str:
    coin = settings.SETTLE_COIN
    sym = ex.get("symbol", "?")
    side = ex.get("side", "")
    qty = ex.get("execQty", "")
    price = ex.get("execPrice", "")
    lines = [f"{label} · {sym}", f"{side} {qty} @ {price} {coin}".strip()]
    val = ex.get("execValue")
    if val not in (None, ""):
        lines.append(f"Value {val} {coin}")
    pnl_line = _fmt_pnl(pnl)
    if pnl_line:
        lines.append(pnl_line)
    try:
        ts = datetime.fromtimestamp(int(ex.get("execTime")) / 1000, tz=timezone.utc)
        lines.append(ts.strftime("%Y-%m-%d %H:%M:%S UTC"))
    except (TypeError, ValueError):
        pass
    return "\n".join(lines)


async def _poll_once(baseline: bool) -> None:
    """One execution poll. On baseline=True, record current fills WITHOUT alerting
    (so startup never replays history); afterwards, alert on each new execId. An
    alertable fill is marked seen ONLY after Telegram confirms delivery, so a
    dropped alert (e.g. a 429) is retried on the next poll rather than lost."""
    data = await dma_client.get_executions(limit=str(settings.NOTIFY_EXEC_LIMIT))
    # Copy before mutating: extract_list returns the actual result.list object from
    # the parsed response, and reverse()/sort() would reorder it in place. Harmless
    # today (the response isn't reused), but a latent aliasing hazard if that ever
    # changes — mirror the market_data mutation warning and never touch the source.
    execs = list(dma_client.extract_list(data))
    # The API returns newest-first; reverse, then stable-sort ascending, so even
    # same-millisecond fills are alerted in chronological order.
    execs.reverse()
    execs.sort(key=lambda e: int(e.get("execTime") or 0))
    for ex in execs:
        exec_id = ex.get("execId")
        if not exec_id or exec_id in _seen:
            continue
        if baseline:
            _remember(exec_id)
            continue
        label = _label(ex)
        if label is None:
            _remember(exec_id)  # not an order execution (funding/settle/…) — skip for good
            continue
        # Remember ONLY on confirmed delivery; an undelivered alert stays unseen
        # and is retried next poll (no permanent loss on a transient 429/outage).
        result = await _send(_fmt(ex, label, await _resolve_pnl(ex)))
        if result == "sent":
            _remember(exec_id)
        elif result == "rate_limited":
            # Telegram is throttling us: stop this poll rather than burning up to
            # 30s per remaining fill. Unseen fills (this one included) retry on the
            # next poll, still in chronological order — no loss, no reordering.
            break
        # "failed" (non-429): leave unseen and continue; retried next poll.


async def run_watcher() -> None:
    """Background loop: poll executions, push Telegram alerts. Started from the
    app lifespan, cancelled on shutdown. Returns immediately if not configured."""
    if not _enabled():
        logger.info("execution alerts disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID unset)")
        return
    logger.info("execution alerts enabled; polling executions every %ss", settings.NOTIFY_POLL_INTERVAL)
    baseline = True
    while True:
        extra = 0.0
        try:
            await _poll_once(baseline)
            baseline = False  # only leave baseline mode after a successful poll
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("execution-alert poll failed")  # never break the loop
            if dma_client.is_rate_limit(exc):
                extra = settings.NOTIFY_POLL_INTERVAL * _RATE_LIMIT_EXTRA_POLLS
        await asyncio.sleep(settings.NOTIFY_POLL_INTERVAL + extra)
