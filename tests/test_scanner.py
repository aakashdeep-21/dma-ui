"""Market Scanner engine + endpoint tests (app/scanner.py, /api/scanner).

The scanner is read-only market intelligence: these tests pin down the honesty
rules (windowed metrics are None until the rolling history actually covers the
window — never estimated from a shorter baseline), the metric math, snapshot
assembly, the memory-only serving contract of /api/scanner, and the sampler's
resilience to upstream failures.
"""
import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from app import dma_client, main as main_mod, scanner


MIN = 60_000  # one minute in ms


@pytest.fixture(autouse=True)
def _fresh_scanner_state():
    """Each test starts with an empty scanner (module-level sampler state)."""
    scanner._histories.clear()
    scanner._last_seen_ms.clear()
    scanner._snapshot = None
    scanner._last_sample_ms = None
    scanner._last_error = None
    yield
    scanner._histories.clear()
    scanner._last_seen_ms.clear()
    scanner._snapshot = None
    scanner._last_sample_ms = None
    scanner._last_error = None


def ticker(sym="BTCUSDT", last="100", **extra):
    t = {"symbol": sym, "lastPrice": last}
    t.update(extra)
    return t


def feed(sym, prices, *, start_ms=0, step_ms=10_000, **extra):
    """Ingest a series of samples for one symbol; returns the final now_ms."""
    now = start_ms
    for i, p in enumerate(prices):
        now = start_ms + i * step_ms
        scanner.ingest([ticker(sym, str(p), **extra)], now)
    return now


# ---- SymbolHistory ----------------------------------------------------------

def test_history_append_trim_and_lookup():
    h = scanner.SymbolHistory()
    for i in range(10):
        h.append(i * 1000, 100.0 + i, 1000.0 + i, 0.0001)
    assert len(h) == 10
    h.trim(4000)  # drop everything strictly older than t=4000
    assert len(h) == 6
    assert h.ts[0] == 4000
    # Nearest-sample lookup returns the closest column value.
    assert h.at(5400, "price") == 105.0
    assert h.at(5600, "price") == 106.0
    assert h.min_max_price(7000) == (107.0, 109.0)


def test_history_at_handles_nan_funding_as_none():
    h = scanner.SymbolHistory()
    h.append(0, 100.0, 500.0, None)  # gateway omitted funding
    assert h.at(0, "funding") is None
    assert h.at(0, "turnover") == 500.0


def test_history_covers_requires_real_span():
    h = scanner.SymbolHistory()
    h.append(0, 100.0, None, None)
    now = 15 * MIN
    assert h.covers(now, 15 * MIN) is True     # full window behind us
    assert h.covers(now, 60 * MIN) is False    # only 15m of history for a 1h ask
    assert scanner.SymbolHistory().covers(now, MIN) is False  # empty history


def test_spark_downsamples_and_keeps_endpoints():
    h = scanner.SymbolHistory()
    for i in range(400):
        h.append(i * 10_000, float(i), None, None)
    s = h.spark(400 * 10_000)
    assert len(s) == scanner.SPARK_POINTS
    assert s[0] == 0.0 and s[-1] == 399.0
    assert s == sorted(s)  # monotone input stays monotone after downsampling
    # Short histories come through whole; a single point is not a trend.
    h2 = scanner.SymbolHistory()
    h2.append(0, 1.0, None, None)
    assert h2.spark(0) == []
    h2.append(1000, 2.0, None, None)
    assert h2.spark(1000) == [1.0, 2.0]


# ---- metric math -------------------------------------------------------------

def test_pct_change_guards():
    assert scanner.pct_change(110, 100) == 10.0
    assert scanner.pct_change(95, 100) == -5.0
    assert scanner.pct_change(100, 0) is None        # no divide-by-zero
    assert scanner.pct_change(100, None) is None
    assert scanner.pct_change("garbage", 100) is None
    assert scanner.pct_change(float("inf"), 100) is None


def test_windowed_metrics_none_until_covered_then_computed():
    # 10 samples over 90s: 15m/1h windows are NOT covered -> None (honest).
    now = feed("ETHUSDT", [100 + i for i in range(10)])
    row = scanner._snapshot["rows"][0]
    assert row["pct15m"] is None
    assert row["pct1h"] is None
    assert row["vol15mPct"] is None
    assert row["turnoverDelta15m"] is None

    # Extend to > 15 minutes of history: pct15m/vol15m become real numbers.
    prices = [110.0] * 100  # 100 more samples * 10s = ~16.6 min flat at 110
    now = feed("ETHUSDT", prices, start_ms=now + 10_000)
    row = scanner._snapshot["rows"][0]
    assert row["pct15m"] == 0.0            # flat window -> 0% (not None)
    assert row["vol15mPct"] == 0.0
    assert row["pct1h"] is None            # 1h still not covered


def test_pct1h_prefers_exchange_prev_price_over_history():
    scanner.ingest([ticker("BTCUSDT", "105", prevPrice1h="100")], 0)
    row = scanner._snapshot["rows"][0]
    assert row["pct1h"] == 5.0  # exact from the ticker, warm from sample one


def test_pct24h_and_range_from_ticker():
    scanner.ingest(
        [ticker("BTCUSDT", "100", price24hPcnt="-0.034", highPrice24h="120", lowPrice24h="80")], 0
    )
    row = scanner._snapshot["rows"][0]
    assert row["pct24h"] == -3.4
    assert row["range24hPct"] == 40.0
    # Inverted high/low (bad upstream data) must not mint a negative range.
    scanner.ingest(
        [ticker("BTCUSDT", "100", highPrice24h="80", lowPrice24h="120")], 1000
    )
    assert scanner._snapshot["rows"][0]["range24hPct"] is None


def test_turnover_delta_measures_15m_drift():
    base = 20 * MIN
    # 20 minutes of samples with turnover24h rising 100 per 10s step.
    for i in range(121):
        scanner.ingest([ticker("SOLUSDT", "50", turnover24h=str(1_000_000 + i * 100))], i * 10_000)
    row = scanner._snapshot["rows"][0]
    # 15m = 90 steps of +100 = +9000 (nearest-sample lookup keeps it exact).
    assert row["turnoverDelta15m"] == 9000.0
    assert row["turnover24h"] == 1_000_000 + 120 * 100
    assert base  # silence lint for the intermediate constant


def test_funding_metrics_and_absence():
    # Funding present: rate + 1h drift (needs 1h coverage) + capability flag.
    for i in range(370):  # ~61.5 min at 10s
        scanner.ingest(
            [ticker("XRPUSDT", "1", fundingRate=str(0.0001 + i * 0.000001), nextFundingTime="1700000000000")],
            i * 10_000,
        )
    row = scanner._snapshot["rows"][0]
    assert row["fundingRate"] == pytest.approx(0.0001 + 369 * 0.000001)
    assert row["fundingDelta1h"] == pytest.approx(0.00036, abs=1e-6)
    assert row["nextFundingTime"] == 1700000000000
    assert scanner._snapshot["capabilities"]["funding"] is True

    # Funding absent (gateway doesn't supply it): None everywhere, flag off.
    scanner._histories.clear()
    scanner.ingest([ticker("NOFUNDUSDT", "2")], 0)
    row = scanner._snapshot["rows"][0]
    assert row["fundingRate"] is None
    assert row["fundingDelta1h"] is None
    assert scanner._snapshot["capabilities"]["funding"] is False


# ---- snapshot assembly ---------------------------------------------------------

def test_ingest_skips_unusable_rows_and_counts_universe():
    snap = scanner.ingest(
        [
            ticker("BTCUSDT", "100"),
            ticker("bad sym!", "100"),      # invalid symbol charset
            ticker("ETHUSDT", "not-a-price"),
            ticker("ZEROUSDT", "0"),        # zero price can't anchor metrics
            {"symbol": None},
            "not-a-dict",
            ticker("SOLUSDT", "50", price24hPcnt="inf"),  # non-finite field -> None, row kept
        ],
        0,
    )
    syms = [r["symbol"] for r in snap["rows"]]
    assert syms == ["BTCUSDT", "SOLUSDT"]
    assert snap["universe"] == 2
    assert snap["rows"][1]["pct24h"] is None  # inf quarantined, never serialized


def test_ingest_prunes_vanished_symbols():
    scanner.ingest([ticker("OLDUSDT", "1"), ticker("BTCUSDT", "2")], 0)
    assert "OLDUSDT" in scanner._histories
    # OLDUSDT disappears from the universe; after the prune horizon it is dropped.
    scanner.ingest([ticker("BTCUSDT", "2")], scanner._PRUNE_AFTER_MS + 1)
    assert "OLDUSDT" not in scanner._histories
    assert "BTCUSDT" in scanner._histories


def test_history_ms_reports_rolling_span():
    feed("BTCUSDT", [100] * 61, step_ms=MIN)  # 60 min of samples
    snap = scanner._snapshot
    # Trim keeps ~65 min; span reported from the oldest retained sample.
    assert 59 * MIN <= snap["historyMs"] <= scanner.HISTORY_MS


def test_snapshot_json_serializable(tmp_path):
    import json
    feed("BTCUSDT", [100, 101, 102], fundingRate="0.0001")
    payload = scanner.snapshot_response()
    encoded = json.dumps(payload, allow_nan=False)  # raises on NaN/inf leakage
    assert "BTCUSDT" in encoded


# ---- /api/scanner endpoint -----------------------------------------------------

def test_endpoint_requires_login():
    r = TestClient(main_mod.app).get("/api/scanner")
    assert r.status_code == 401


def test_endpoint_serves_snapshot_from_memory(admin_client, monkeypatch):
    async def boom(*a, **k):  # any upstream call would be a contract violation
        raise AssertionError("/api/scanner must never call the exchange")

    monkeypatch.setattr(dma_client, "get_tickers", boom)
    scanner.ingest([ticker("BTCUSDT", "100", price24hPcnt="0.01")], time.time() * 1000)
    r = admin_client.get("/api/scanner")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "scanner"
    assert body["universe"] == 1
    assert body["rows"][0]["symbol"] == "BTCUSDT"
    assert body["enabled"] is True
    assert body["error"] is None
    assert isinstance(body["nowMs"], int)
    assert body["capabilities"].keys() >= {"funding", "openInterest", "pct1h"}


def test_endpoint_before_first_sample_is_empty_not_error(admin_client):
    r = admin_client.get("/api/scanner")
    assert r.status_code == 200
    body = r.json()
    assert body["rows"] == []
    assert body["asOfMs"] is None
    assert body["universe"] == 0


def test_healthz_reports_scanner_age(monkeypatch):
    monkeypatch.setattr(scanner, "_last_sample_ms", int(time.time() * 1000) - 30_000)
    r = TestClient(main_mod.app).get("/healthz")
    assert r.status_code == 200
    age = r.json()["scannerAgeSeconds"]
    assert 25 <= age <= 35
    monkeypatch.setattr(scanner, "_last_sample_ms", None)
    assert TestClient(main_mod.app).get("/healthz").json()["scannerAgeSeconds"] is None


# ---- sampler resilience ----------------------------------------------------------

def test_sample_once_ingests_and_clears_error(monkeypatch):
    async def fake_tickers():
        return {"retCode": 0, "result": {"list": [ticker("BTCUSDT", "100")]}}

    monkeypatch.setattr(dma_client, "get_tickers", fake_tickers)
    scanner._last_error = "market data temporarily unavailable"
    cooldown = asyncio.run(scanner._sample_once())
    assert cooldown == 0.0
    assert scanner._last_error is None
    assert scanner._snapshot["universe"] == 1
    assert scanner.last_sample_ms() is not None


def test_sample_once_survives_upstream_failure_and_keeps_snapshot(monkeypatch):
    scanner.ingest([ticker("BTCUSDT", "100")], 0)  # a previous good snapshot

    async def fail():
        raise dma_client.DMAError(502, "upstream down")

    monkeypatch.setattr(dma_client, "get_tickers", fail)
    cooldown = asyncio.run(scanner._sample_once())
    assert cooldown == 0.0
    assert scanner._snapshot["universe"] == 1          # old data still served
    assert scanner._last_error is not None             # but flagged as stale
    assert scanner.snapshot_response()["error"] is not None


def test_sample_once_backs_off_on_rate_limit(monkeypatch):
    async def limited():
        raise dma_client.DMAError(429, {"retCode": 10006, "retMsg": "too many"})

    monkeypatch.setattr(dma_client, "get_tickers", limited)
    cooldown = asyncio.run(scanner._sample_once())
    assert cooldown == scanner.settings.SCANNER_SAMPLE_INTERVAL * scanner._RATE_LIMIT_EXTRA_CYCLES


def test_sample_once_survives_unexpected_exception(monkeypatch):
    async def explode():
        raise RuntimeError("boom")

    monkeypatch.setattr(dma_client, "get_tickers", explode)
    cooldown = asyncio.run(scanner._sample_once())  # must not raise
    assert cooldown == 0.0
    assert scanner._last_error is not None
