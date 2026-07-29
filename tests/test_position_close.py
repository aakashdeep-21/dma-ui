"""Position close (full + percent slice): live re-derivation, lot-step flooring."""
import pytest

from app import dma_client


LIVE_POSITION = {
    "symbol": "SOLUSDT", "side": "Buy", "size": "1.5",
    "positionIdx": 0, "leverage": "10",
}


@pytest.fixture
def live_position(monkeypatch):
    async def fake_positions():
        return {"result": {"list": [dict(LIVE_POSITION)]}}

    monkeypatch.setattr(dma_client, "get_positions", fake_positions)


@pytest.fixture
def instrument_step(monkeypatch):
    spec = {"step": "0.1"}

    async def fake_instruments(symbol=None):
        lot = {} if spec["step"] is None else {"qtyStep": spec["step"]}
        return {"result": {"list": [{"symbol": symbol, "lotSizeFilter": lot}]}}

    monkeypatch.setattr(dma_client, "get_instruments", fake_instruments)
    return spec


def test_close_full_uses_exact_exchange_size(admin_client, live_position):
    r = admin_client.post("/api/position/close", json={"symbol": "SOLUSDT"})
    assert r.status_code == 200, r.text
    body = admin_client.captured["create_order"]
    assert body["qty"] == "1.5"          # the exchange's own string, untouched
    assert body["side"] == "Sell"        # opposite of the live Buy leg
    assert body["reduceOnly"] is True
    assert body["orderType"] == "Market"


def test_close_percent_100_matches_full_close(admin_client, live_position):
    r = admin_client.post("/api/position/close", json={"symbol": "SOLUSDT", "percent": 100})
    assert r.status_code == 200, r.text
    assert admin_client.captured["create_order"]["qty"] == "1.5"


@pytest.mark.parametrize("percent", [0, -5, 150, "abc", "inf", "nan"])
def test_close_rejects_bad_percent(admin_client, live_position, percent):
    r = admin_client.post("/api/position/close", json={"symbol": "SOLUSDT", "percent": percent})
    assert r.status_code == 400, (percent, r.text)
    assert "percent" in r.text


def test_close_percent_floors_to_lot_step(admin_client, live_position, instrument_step):
    # 50% of 1.5 = 0.75 → floored to the 0.1 step = 0.7 (never rounded up).
    r = admin_client.post("/api/position/close", json={"symbol": "SOLUSDT", "percent": 50})
    assert r.status_code == 200, r.text
    body = admin_client.captured["create_order"]
    assert body["qty"] == "0.7"
    assert body["reduceOnly"] is True


def test_close_percent_exact_multiple_is_untouched(admin_client, live_position, instrument_step):
    # 20% of 1.5 = 0.3, already on-step — must come out exactly, no drift.
    r = admin_client.post("/api/position/close", json={"symbol": "SOLUSDT", "percent": 20})
    assert r.status_code == 200, r.text
    assert admin_client.captured["create_order"]["qty"] == "0.3"


def test_close_percent_below_one_step_is_rejected(admin_client, live_position, instrument_step):
    # 5% of 1.5 = 0.075 → floors to zero 0.1-lots → clean 400, no order sent.
    admin_client.captured.pop("create_order", None)
    r = admin_client.post("/api/position/close", json={"symbol": "SOLUSDT", "percent": 5})
    assert r.status_code == 400, r.text
    assert "lot step" in r.text
    assert "create_order" not in admin_client.captured


def test_close_percent_without_lot_step_is_502(admin_client, live_position, instrument_step):
    # Unknown lot step → refuse the partial (full close still works, no step needed).
    instrument_step["step"] = None
    admin_client.captured.pop("create_order", None)
    r = admin_client.post("/api/position/close", json={"symbol": "SOLUSDT", "percent": 50})
    assert r.status_code == 502, r.text
    assert "create_order" not in admin_client.captured
    # Full close is unaffected by the missing spec.
    r = admin_client.post("/api/position/close", json={"symbol": "SOLUSDT"})
    assert r.status_code == 200
    assert admin_client.captured["create_order"]["qty"] == "1.5"


def test_close_percent_rejects_mismatched_instrument(admin_client, live_position, monkeypatch):
    # The lot step drives the derived qty — an instrument answer for a DIFFERENT
    # symbol must never be trusted (gateway has deviated from v5 filtering before).
    async def wrong_symbol(symbol=None):
        return {"result": {"list": [{"symbol": "ETHUSDT", "lotSizeFilter": {"qtyStep": "0.1"}}]}}

    monkeypatch.setattr(dma_client, "get_instruments", wrong_symbol)
    admin_client.captured.pop("create_order", None)
    r = admin_client.post("/api/position/close", json={"symbol": "SOLUSDT", "percent": 50})
    assert r.status_code == 502, r.text
    assert "create_order" not in admin_client.captured


def test_close_no_open_position_is_400(admin_client, monkeypatch):
    async def fake_positions():
        return {"result": {"list": []}}

    monkeypatch.setattr(dma_client, "get_positions", fake_positions)
    r = admin_client.post("/api/position/close", json={"symbol": "SOLUSDT"})
    assert r.status_code == 400
