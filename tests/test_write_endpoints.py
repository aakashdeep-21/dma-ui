"""Route-level validation on the WRITE/money path (auth gates overridden)."""
import pytest


# ---- order/create: numeric + symbol validation ----------------------------

@pytest.mark.parametrize("qty", ["inf", "-inf", "nan", "0", "-1", "abc", ""])
def test_order_create_rejects_bad_qty(admin_client, qty):
    r = admin_client.post("/api/order/create", json={
        "symbol": "BTCUSDT", "side": "Buy", "orderType": "Market", "qty": qty,
    })
    assert r.status_code == 400, (qty, r.text)


def test_order_create_rejects_bad_symbol(admin_client):
    r = admin_client.post("/api/order/create", json={
        "symbol": "BTC-USDT!", "side": "Buy", "orderType": "Market", "qty": "1",
    })
    assert r.status_code == 400


def test_order_create_limit_requires_valid_price(admin_client):
    base = {"symbol": "BTCUSDT", "side": "Buy", "orderType": "Limit", "qty": "1"}
    assert admin_client.post("/api/order/create", json=base).status_code == 400
    assert admin_client.post("/api/order/create", json={**base, "price": "inf"}).status_code == 400
    assert admin_client.post("/api/order/create", json={**base, "price": "0"}).status_code == 400


def test_order_create_reduce_only_with_tpsl_rejected(admin_client):
    r = admin_client.post("/api/order/create", json={
        "symbol": "BTCUSDT", "side": "Sell", "orderType": "Market", "qty": "1",
        "reduceOnly": True, "takeProfit": "70000",
    })
    assert r.status_code == 400


def test_order_create_allowlist_and_coercion(admin_client):
    # Stray/forged fields must NOT be forwarded; types must be coerced/normalised.
    r = admin_client.post("/api/order/create", json={
        "symbol": "btcusdt", "side": "buy", "orderType": "Market", "qty": "0.5",
        "positionIdx": 5,               # invalid -> clamped to 0
        "reduceOnly": "yes",            # truthy string -> real bool True
        "closeOnTrigger": True,         # stray -> dropped
        "orderLinkId": "attacker",      # stray -> dropped
    })
    assert r.status_code == 200, r.text
    body = admin_client.captured["create_order"]
    assert body["symbol"] == "BTCUSDT"
    assert body["side"] == "Buy"
    assert body["qty"] == "0.5"
    assert body["positionIdx"] == 0
    assert body["reduceOnly"] is True
    assert "closeOnTrigger" not in body
    assert "orderLinkId" not in body


# ---- set-leverage ---------------------------------------------------------

@pytest.mark.parametrize("lev", ["inf", "0", "-5", "nan", "x"])
def test_set_leverage_rejects_non_finite(admin_client, lev):
    r = admin_client.post("/api/position/set-leverage", json={
        "symbol": "BTCUSDT", "buyLeverage": lev,
    })
    assert r.status_code == 400


def test_set_leverage_happy(admin_client):
    r = admin_client.post("/api/position/set-leverage", json={
        "symbol": "btcusdt", "buyLeverage": "10",
    })
    assert r.status_code == 200
    assert admin_client.captured["set_leverage"]["symbol"] == "BTCUSDT"


# ---- funds/transfer: mandatory idempotency key + finite amount ------------

def test_transfer_requires_client_txn_id(admin_client):
    r = admin_client.post("/api/funds/transfer", json={
        "direction": "OUT", "amount": 10, "quote_asset": "USDT",
    })
    assert r.status_code == 400
    assert "client_txn_id" in r.text


# "inf"/"nan" are sent as strings — a browser's JSON.stringify(Infinity) yields
# null, so a non-finite number can only reach the server as a string anyway.
@pytest.mark.parametrize("amount", ["inf", "nan", -1, 0])
def test_transfer_rejects_bad_amount(admin_client, amount):
    r = admin_client.post("/api/funds/transfer", json={
        "direction": "OUT", "amount": amount, "quote_asset": "USDT",
        "client_txn_id": "intent-1",
    })
    assert r.status_code == 400


def test_transfer_forwards_idempotency_key(admin_client):
    r = admin_client.post("/api/funds/transfer", json={
        "direction": "OUT", "amount": 10, "quote_asset": "USDT",
        "client_txn_id": "intent-42",
    })
    assert r.status_code == 200, r.text
    assert admin_client.captured["transfer"]["client_txn_id"] == "intent-42"


# ---- DMAError handler must not leak the raw upstream envelope (S6) ---------

def test_dma_error_handler_returns_only_retmsg(admin_client, monkeypatch):
    from app import dma_client

    async def boom(body):
        raise dma_client.DMAError(400, {"retMsg": "insufficient balance", "reqId": "sekret-123"})

    monkeypatch.setattr(dma_client, "create_order", boom)
    r = admin_client.post("/api/order/create", json={
        "symbol": "BTCUSDT", "side": "Buy", "orderType": "Market", "qty": "1",
    })
    assert r.status_code == 400
    body = r.json()
    assert body["error"] == "insufficient balance"
    assert "sekret-123" not in r.text  # internal diagnostics not forwarded


# ---- security headers on every response (S3) ------------------------------

def test_security_headers_present(admin_client):
    r = admin_client.get("/login")
    assert "frame-ancestors 'none'" in r.headers.get("content-security-policy", "")
    assert r.headers.get("x-frame-options") == "DENY"
    assert r.headers.get("x-content-type-options") == "nosniff"


# ---- login rate limiting (S1) — uses a distinct fake IP for isolation -----

def test_login_rate_limited_after_failures(admin_client):
    hdr = {"x-forwarded-for": "203.0.113.9"}
    last = None
    for _ in range(12):
        last = admin_client.post("/api/login", json={"username": "x", "password": "bad"}, headers=hdr)
    assert last.status_code == 429
