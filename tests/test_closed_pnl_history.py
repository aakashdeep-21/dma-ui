"""Windowed, cursor-free Closed-PnL history (dma_client.get_closed_pnl).

The gateway caps closed-pnl at 100 records / 7-day span and returns only the last
7 days with no time range. get_closed_pnl walks the last ~month as several <=7-day
windows (startTime/endTime, NO cursor — the cursor is percent-encoded and our
signer would sign it differently than it sends it -> "Invalid signature"), merges,
dedups, and subdivides a saturated window BY TIME. These tests pin that behaviour.
"""
import asyncio
import json
from urllib.parse import urlparse, parse_qs

import pytest

from app import dma_client

DAY_MS = 24 * 60 * 60 * 1000
FIXED_NOW_MS = 1_800_000_000_000  # frozen clock so window boundaries are deterministic


class _Resp:
    def __init__(self, status, data):
        self.status_code = status
        self._data = data
        self.text = json.dumps(data)

    def json(self):
        return self._data


def _rec(order_id, updated_ms, pnl="1.0", symbol="BTCUSDT"):
    return {"orderId": order_id, "updatedTime": str(updated_ms), "closedPnl": pnl, "symbol": symbol}


def _install(monkeypatch, handler):
    """Freeze the clock and route every signed GET to `handler(start_ms, end_ms)`,
    which returns the record list for that query. Records the requested URLs."""
    monkeypatch.setattr(dma_client.time, "time", lambda: FIXED_NOW_MS / 1000)
    urls: list[str] = []

    async def fake_get(url, headers=None):
        urls.append(url)
        q = parse_qs(urlparse(url).query)
        start, end = int(q["startTime"][0]), int(q["endTime"][0])
        return _Resp(200, {"retCode": 0, "result": {"category": "linear", "list": handler(start, end)}})

    monkeypatch.setattr(dma_client._client, "get", fake_get)
    return urls


def _page(dataset, start, end):
    """Mimic the gateway: records in [start, end], newest-first, capped at 100."""
    hits = [r for r in dataset if start <= int(r["updatedTime"]) <= end]
    hits.sort(key=lambda r: int(r["updatedTime"]), reverse=True)
    return hits[:dma_client._HISTORY_PAGE_LIMIT]


def _assert_windowed_no_cursor(urls):
    for url in urls:
        q = parse_qs(urlparse(url).query)
        assert "startTime" in q and "endTime" in q, f"missing time range: {url}"
        assert "cursor" not in q, f"cursor must never be sent: {url}"
        span = int(q["endTime"][0]) - int(q["startTime"][0])
        assert span <= dma_client._HISTORY_WINDOW_MS, f"window > 7d: {url}"


def test_default_month_is_five_windows_with_time_range_and_no_cursor(monkeypatch):
    # One record per window, none saturated -> exactly one GET per <=7-day window.
    urls = _install(monkeypatch, lambda s, e: [_rec(f"o-{s}", e - 1)])
    out = asyncio.run(dma_client.get_closed_pnl())

    assert len(urls) == 5, "30 days / 7-day windows -> 5 calls"
    _assert_windowed_no_cursor(urls)
    lst = out["result"]["list"]
    assert len(lst) == 5
    # newest-first
    times = [int(r["updatedTime"]) for r in lst]
    assert times == sorted(times, reverse=True)
    assert out["retCode"] == 0
    assert out["result"]["truncated"] is False
    assert out["result"]["category"] == "linear"


def test_symbol_is_forwarded_to_every_window(monkeypatch):
    urls = _install(monkeypatch, lambda s, e: [])
    asyncio.run(dma_client.get_closed_pnl(symbol="ETHUSDT"))
    assert urls, "should still issue window calls"
    for url in urls:
        q = parse_qs(urlparse(url).query)
        assert q.get("symbol") == ["ETHUSDT"]
        assert q.get("category") == ["linear"]


def test_boundary_duplicate_is_deduped(monkeypatch):
    # Same (orderId, updatedTime) returned by every window -> kept once.
    dup = _rec("same-order", FIXED_NOW_MS - 1000)
    _install(monkeypatch, lambda s, e: [dict(dup)])
    out = asyncio.run(dma_client.get_closed_pnl())
    assert len(out["result"]["list"]) == 1


def test_saturated_window_is_subdivided_by_time_and_fully_recovered(monkeypatch):
    # 100 records spread across a single 7-day window: the full-span query saturates
    # (==limit), so it must bisect by time and recover ALL of them, no cursor, no loss.
    start = FIXED_NOW_MS - 7 * DAY_MS
    step = (7 * DAY_MS) // 100
    dataset = [_rec(f"o{i}", start + i * step) for i in range(100)]
    urls = _install(monkeypatch, lambda s, e: _page(dataset, s, e))

    out = asyncio.run(dma_client.get_closed_pnl(days=7))

    assert len(urls) > 1, "a saturated window must subdivide"
    _assert_windowed_no_cursor(urls)
    lst = out["result"]["list"]
    assert len(lst) == 100, "every record recovered via time subdivision"
    assert len({r["orderId"] for r in lst}) == 100
    assert out["result"]["truncated"] is False


def test_records_denser_than_one_instant_can_hold_are_flagged_truncated(monkeypatch):
    # 200 records at the SAME timestamp: time subdivision can never separate them,
    # so we keep one capped page (100) and MUST flag truncated (never show a partial
    # total as complete on a money view).
    ts = FIXED_NOW_MS - 1000
    dataset = [_rec(f"o{i}", ts) for i in range(200)]
    urls = _install(monkeypatch, lambda s, e: _page(dataset, s, e))

    out = asyncio.run(dma_client.get_closed_pnl(days=7))

    assert out["result"]["truncated"] is True
    assert len(out["result"]["list"]) == dma_client._HISTORY_PAGE_LIMIT
    assert len(urls) <= dma_client._HISTORY_MAX_REQUESTS
    _assert_windowed_no_cursor(urls)


@pytest.mark.parametrize("days,expected_windows", [
    (None, 5),   # default 30 days
    (0, 5),      # falsy -> default
    (7, 1),
    (1000, 5),   # clamped to the 31-day (1-month) cap -> 5 windows
])
def test_days_is_clamped_and_windowed(monkeypatch, days, expected_windows):
    urls = _install(monkeypatch, lambda s, e: [])  # empty pages -> one GET per window
    asyncio.run(dma_client.get_closed_pnl(days=days))
    assert len(urls) == expected_windows


# --- Executions history (same windowing helper, execId dedup, execTime sort) ---

def _exec(exec_id, order_id, exec_time, fee="0.1"):
    return {"execId": exec_id, "orderId": order_id, "execTime": str(exec_time),
            "execFee": fee, "symbol": "BTCUSDT"}


def test_executions_history_is_windowed_over_the_month_no_cursor(monkeypatch):
    urls = _install(monkeypatch, lambda s, e: [_exec(f"x-{s}", f"o-{s}", e - 1)])
    out = asyncio.run(dma_client.get_executions_history())

    assert len(urls) == 5, "30 days / 7-day windows -> 5 calls, matching closed-pnl"
    assert all("/v5/execution/list" in u for u in urls)
    _assert_windowed_no_cursor(urls)
    assert out["retCode"] == 0
    assert out["result"]["truncated"] is False
    assert len(out["result"]["list"]) == 5


def test_executions_multiple_fills_of_same_order_are_not_deduped(monkeypatch):
    # One order, three fills: SAME orderId, DISTINCT execId, SAME execTime. Dedup
    # keys on the unique execId (never orderId), so all three must survive — dropping
    # any would understate the fee tally. This is the executions-specific correctness
    # guarantee that keying on orderId would have broken.
    ts = FIXED_NOW_MS - 1000
    fills = [_exec("e1", "ord-1", ts, "0.10"),
             _exec("e2", "ord-1", ts, "0.20"),
             _exec("e3", "ord-1", ts, "0.30")]
    _install(monkeypatch, lambda s, e: [dict(f) for f in fills] if s <= ts <= e else [])

    out = asyncio.run(dma_client.get_executions_history(days=7))
    lst = out["result"]["list"]
    assert {r["execId"] for r in lst} == {"e1", "e2", "e3"}
    assert abs(sum(float(r["execFee"]) for r in lst) - 0.60) < 1e-9
