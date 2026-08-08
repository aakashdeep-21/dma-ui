"""Telegram execution-alert formatting: realized PnL in USDT + INR.

Covers _fmt_pnl (dual-currency line), _resolve_pnl (envelope value preferred,
closed-pnl lookup fallback for closing fills, never raises) and _fmt wiring.
"""
import pytest

from app import dma_client, notifier
from app.config import settings

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


# --- _fmt_pnl -----------------------------------------------------------------


def test_fmt_pnl_shows_usdt_and_inr(monkeypatch):
    monkeypatch.setattr(settings, "USDT_INR_RATE", 94.0)
    assert notifier._fmt_pnl("-12.34") == "PnL -12.34 USDT (₹-1,159.96)"
    assert notifier._fmt_pnl("100") == "PnL 100 USDT (₹9,400.00)"


def test_fmt_pnl_keeps_exchange_precision(monkeypatch):
    monkeypatch.setattr(settings, "USDT_INR_RATE", 94.0)
    # The settle-coin figure is the exchange's own string, untouched.
    assert notifier._fmt_pnl("0.12345678").startswith("PnL 0.12345678 USDT")


def test_fmt_pnl_rate_disabled_hides_inr(monkeypatch):
    monkeypatch.setattr(settings, "USDT_INR_RATE", 0.0)
    assert notifier._fmt_pnl("-12.34") == "PnL -12.34 USDT"


def test_fmt_pnl_unparseable_value_falls_back_to_usdt_only(monkeypatch):
    monkeypatch.setattr(settings, "USDT_INR_RATE", 94.0)
    assert notifier._fmt_pnl("n/a") == "PnL n/a USDT"


def test_fmt_pnl_empty_is_none():
    assert notifier._fmt_pnl(None) is None
    assert notifier._fmt_pnl("") is None


# --- _resolve_pnl ---------------------------------------------------------------


async def test_resolve_prefers_envelope_execpnl(monkeypatch):
    async def boom(**kwargs):  # lookup must NOT run when the fill carries PnL
        raise AssertionError("closed-pnl lookup should not be called")

    monkeypatch.setattr(dma_client, "get_closed_pnl", boom)
    assert await notifier._resolve_pnl({"execPnl": "5.5", "closedSize": "1"}) == "5.5"
    assert await notifier._resolve_pnl({"closedPnl": "-2.0", "closedSize": "1"}) == "-2.0"


async def test_resolve_non_closing_fill_skips_lookup(monkeypatch):
    async def boom(**kwargs):
        raise AssertionError("closed-pnl lookup should not be called")

    monkeypatch.setattr(dma_client, "get_closed_pnl", boom)
    assert await notifier._resolve_pnl({"closedSize": "0", "orderId": "o1"}) is None
    assert await notifier._resolve_pnl({"orderId": "o1"}) is None


async def test_resolve_falls_back_to_closed_pnl_lookup(monkeypatch):
    calls = {}

    async def fake_closed_pnl(symbol=None, days=None):
        calls["symbol"], calls["days"] = symbol, days
        return {
            "result": {
                "list": [
                    {"orderId": "other", "closedPnl": "999"},
                    {"orderId": "o1", "closedPnl": "-7.25"},
                ]
            }
        }

    monkeypatch.setattr(dma_client, "get_closed_pnl", fake_closed_pnl)
    ex = {"symbol": "BTCUSDT", "orderId": "o1", "closedSize": "0.5"}
    assert await notifier._resolve_pnl(ex) == "-7.25"
    assert calls == {"symbol": "BTCUSDT", "days": 1}


async def test_resolve_sums_multiple_records_for_one_order(monkeypatch):
    async def fake_closed_pnl(symbol=None, days=None):
        return {
            "result": {
                "list": [
                    {"orderId": "o1", "closedPnl": "1.5"},
                    {"orderId": "o1", "closedPnl": "2.25"},
                ]
            }
        }

    monkeypatch.setattr(dma_client, "get_closed_pnl", fake_closed_pnl)
    ex = {"symbol": "BTCUSDT", "orderId": "o1", "closedSize": "1"}
    assert await notifier._resolve_pnl(ex) == "3.75"


async def test_resolve_lookup_failure_never_raises(monkeypatch):
    async def fake_closed_pnl(symbol=None, days=None):
        raise RuntimeError("upstream down")

    monkeypatch.setattr(dma_client, "get_closed_pnl", fake_closed_pnl)
    ex = {"symbol": "BTCUSDT", "orderId": "o1", "closedSize": "1"}
    assert await notifier._resolve_pnl(ex) is None


async def test_resolve_no_matching_record_is_none(monkeypatch):
    async def fake_closed_pnl(symbol=None, days=None):
        return {"result": {"list": [{"orderId": "other", "closedPnl": "1"}]}}

    monkeypatch.setattr(dma_client, "get_closed_pnl", fake_closed_pnl)
    ex = {"symbol": "BTCUSDT", "orderId": "o1", "closedSize": "1"}
    assert await notifier._resolve_pnl(ex) is None


# --- _fmt wiring ------------------------------------------------------------


def test_fmt_includes_dual_currency_pnl_line(monkeypatch):
    monkeypatch.setattr(settings, "USDT_INR_RATE", 94.0)
    ex = {
        "symbol": "BTCUSDT",
        "side": "Sell",
        "execQty": "0.01",
        "execPrice": "60000",
        "execValue": "600",
        "execTime": "1754600000000",
    }
    msg = notifier._fmt(ex, "✅ Order filled", pnl="12.5")
    assert "PnL 12.5 USDT (₹1,175.00)" in msg
    assert "✅ Order filled · BTCUSDT" in msg


def test_fmt_without_pnl_has_no_pnl_line():
    ex = {"symbol": "BTCUSDT", "side": "Buy", "execQty": "1", "execPrice": "100"}
    assert "PnL" not in notifier._fmt(ex, "✅ Order filled", pnl=None)
