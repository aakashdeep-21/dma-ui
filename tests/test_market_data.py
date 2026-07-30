"""Public kline proxy (app/market_data.py): whitelist, limit bucketing,
cache TTL and single-flight — this module had zero coverage despite being the
only back-pressure between the browser's chart polling and a third-party API.
"""
import asyncio
import json

import pytest

from app import market_data, scanner
from app.config import settings


class _Resp:
    def __init__(self, status, data):
        self.status_code = status
        self._data = data
        self.text = json.dumps(data)

    def json(self):
        return self._data


@pytest.fixture
def fake_kline(monkeypatch):
    """Counted fake upstream + clean cache; TTL pinned long for determinism."""
    calls = {"n": 0, "resp": _Resp(200, {"retCode": 0, "result": {"list": []}})}

    async def fake_get(url, params=None):
        calls["n"] += 1
        return calls["resp"]

    monkeypatch.setattr(market_data._client, "get", fake_get)
    monkeypatch.setattr(settings, "CHART_CACHE_TTL", 5.0)
    market_data._cache.clear()
    market_data._locks.clear()
    yield calls
    market_data._cache.clear()
    market_data._locks.clear()


@pytest.fixture
def empty_universe():
    """Scanner has observed nothing → only the static allowlist passes."""
    saved = dict(scanner._histories)
    scanner._histories.clear()
    yield
    scanner._histories.clear()
    scanner._histories.update(saved)


# ---- validation (the SSRF/abuse guard) --------------------------------------

def test_validate_rejects_off_whitelist_symbol(empty_universe):
    with pytest.raises(market_data.MarketDataError) as ei:
        market_data._validate("DOGEUSDT", "1m")
    assert ei.value.status == 400


def test_validate_accepts_scanner_known_symbol(empty_universe):
    """The live venue universe (as observed by the scanner) extends the static
    allowlist — a real market charts without env changes."""
    scanner._histories["DOGEUSDT"] = scanner.SymbolHistory()
    assert market_data._validate("DOGEUSDT", "1m") == ("DOGEUSDT", "1")
    # …but the set stays bounded by what the venue lists: junk still fails.
    with pytest.raises(market_data.MarketDataError):
        market_data._validate("TOTALLYFAKE", "1m")


def test_validate_static_allowlist_still_works_without_scanner(empty_universe):
    assert market_data._validate("BTCUSDT", "1m") == ("BTCUSDT", "1")


def test_validate_rejects_unknown_interval():
    with pytest.raises(market_data.MarketDataError) as ei:
        market_data._validate("BTCUSDT", "42")
    assert ei.value.status == 400


@pytest.mark.parametrize("raw,code", [
    ("1m", "1"), ("1", "1"), ("1h", "60"), ("1H", "60"), ("60", "60"),
    # Multi-chart additions: the full ladder the chart toolbar offers.
    ("3m", "3"), ("3", "3"), ("30m", "30"), ("30", "30"),
    ("4h", "240"), ("240", "240"), ("1d", "D"), ("D", "D"), ("d", "D"),
])
def test_validate_maps_interval_labels(raw, code):
    assert market_data._validate("BTCUSDT", raw) == ("BTCUSDT", code)


# ---- limit bucketing (bounds the cache-key cardinality) ----------------------

@pytest.mark.parametrize("raw,bucket", [
    (None, 200), ("abc", 200), (1, 60), (60, 60), (61, 160),
    (200, 200), (201, 500), (999, 1000), (5000, 1000), (0, 60), (-5, 60),
])
def test_bucket_limit(raw, bucket):
    assert market_data._bucket_limit(raw) == bucket


# ---- cache + single-flight ---------------------------------------------------

def test_cache_serves_repeat_calls_within_ttl(fake_kline):
    asyncio.run(market_data.get_kline("BTCUSDT", "1m", 60))
    asyncio.run(market_data.get_kline("BTCUSDT", "1m", 60))
    assert fake_kline["n"] == 1, "second call within TTL must be a cache hit"
    # A different limit bucket is a different key.
    asyncio.run(market_data.get_kline("BTCUSDT", "1m", 500))
    assert fake_kline["n"] == 2


def test_concurrent_cold_misses_coalesce_to_one_upstream_call(fake_kline):
    async def burst():
        await asyncio.gather(*(market_data.get_kline("ETHUSDT", "5m", 60) for _ in range(5)))

    asyncio.run(burst())
    assert fake_kline["n"] == 1, "single-flight: N concurrent misses = 1 upstream GET"


# ---- upstream failures never leak raw statuses -------------------------------

def test_upstream_http_error_maps_to_502(fake_kline):
    fake_kline["resp"] = _Resp(500, {"retMsg": "boom"})
    with pytest.raises(market_data.MarketDataError) as ei:
        asyncio.run(market_data.get_kline("BTCUSDT", "1m", 60))
    assert ei.value.status == 502


def test_upstream_nonzero_retcode_maps_to_502(fake_kline):
    fake_kline["resp"] = _Resp(200, {"retCode": 10001, "retMsg": "bad"})
    with pytest.raises(market_data.MarketDataError) as ei:
        asyncio.run(market_data.get_kline("BTCUSDT", "1m", 60))
    assert ei.value.status == 502


def test_rejected_symbol_never_reaches_upstream(fake_kline, empty_universe):
    with pytest.raises(market_data.MarketDataError):
        asyncio.run(market_data.get_kline("EVILUSDT", "1m", 60))
    assert fake_kline["n"] == 0
