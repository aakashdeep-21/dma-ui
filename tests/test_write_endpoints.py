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
        "positionIdx": "1",             # valid hedge leg, string form -> int
        "reduceOnly": "yes",            # truthy string -> real bool True
        "closeOnTrigger": True,         # stray -> dropped
        "orderLinkId": "attacker",      # stray -> dropped
    })
    assert r.status_code == 200, r.text
    body = admin_client.captured["create_order"]
    assert body["symbol"] == "BTCUSDT"
    assert body["side"] == "Buy"
    assert body["qty"] == "0.5"
    assert body["positionIdx"] == 1
    assert body["reduceOnly"] is True
    assert "closeOnTrigger" not in body
    assert "orderLinkId" not in body


@pytest.mark.parametrize("idx", [5, -1, "x", 3])
def test_order_create_rejects_invalid_position_idx(admin_client, idx):
    # A garbled positionIdx is a clean local 400, never a silent clamp to 0
    # (which would target the wrong semantics on a hedge-mode account).
    r = admin_client.post("/api/order/create", json={
        "symbol": "BTCUSDT", "side": "Buy", "orderType": "Market", "qty": "1",
        "positionIdx": idx,
    })
    assert r.status_code == 400
    assert "positionIdx" in r.text


def test_order_create_rejects_underscored_numbers(admin_client):
    # Python's float() accepts "70_000" but the raw string is forwarded to the
    # exchange, which does not — reject locally instead.
    r = admin_client.post("/api/order/create", json={
        "symbol": "BTCUSDT", "side": "Buy", "orderType": "Market", "qty": "1_0",
    })
    assert r.status_code == 400


def test_trading_stop_rejects_underscored_price(admin_client):
    r = admin_client.post("/api/position/trading-stop", json={
        "symbol": "BTCUSDT", "takeProfit": "70_000",
    })
    assert r.status_code == 400


# ---- timeInForce allowlist --------------------------------------------------

def test_time_in_force_allowlist(admin_client):
    base = {"symbol": "BTCUSDT", "side": "Buy", "orderType": "Limit",
            "qty": "1", "price": "100"}
    # Bad value -> 400.
    r = admin_client.post("/api/order/create", json={**base, "timeInForce": "GTX"})
    assert r.status_code == 400 and "timeInForce" in r.text
    # PostOnly on a Market order is contradictory -> 400.
    r = admin_client.post("/api/order/create", json={
        "symbol": "BTCUSDT", "side": "Buy", "orderType": "Market", "qty": "1",
        "timeInForce": "PostOnly",
    })
    assert r.status_code == 400
    # PostOnly on Limit is forwarded.
    r = admin_client.post("/api/order/create", json={**base, "timeInForce": "PostOnly"})
    assert r.status_code == 200
    assert admin_client.captured["create_order"]["timeInForce"] == "PostOnly"
    # GTC is the exchange default: omitted for byte-compat with pre-TIF bodies.
    r = admin_client.post("/api/order/create", json={**base, "timeInForce": "GTC"})
    assert r.status_code == 200
    assert "timeInForce" not in admin_client.captured["create_order"]
    # Omitted entirely -> omitted.
    r = admin_client.post("/api/order/create", json=base)
    assert "timeInForce" not in admin_client.captured["create_order"]


# ---- request body size cap --------------------------------------------------

def test_oversized_body_is_rejected_413(admin_client):
    r = admin_client.post(
        "/api/login", content=b"x" * (70 * 1024),
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 413
    # Security headers still wrap the early 413 (middleware ordering).
    assert r.headers.get("x-frame-options") == "DENY"


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
# "1e400" overflows float() to inf — must be caught by the isfinite check.
@pytest.mark.parametrize("amount", ["inf", "nan", "1e400", -1, 0])
def test_transfer_rejects_bad_amount(admin_client, amount):
    r = admin_client.post("/api/funds/transfer", json={
        "direction": "OUT", "amount": amount, "quote_asset": "USDT",
        "client_txn_id": "intent-1",
    })
    assert r.status_code == 400
    assert "amount" in r.text  # pinned to the amount check, not an unrelated 400


def test_transfer_forwards_idempotency_key(admin_client):
    r = admin_client.post("/api/funds/transfer", json={
        "direction": "OUT", "amount": 10, "quote_asset": "USDT",
        "client_txn_id": "intent-42",
    })
    assert r.status_code == 200, r.text
    assert admin_client.captured["transfer"]["client_txn_id"] == "intent-42"


def test_transfer_idempotency_key_stripped_but_preserved(admin_client):
    # The dedup key is invariant-critical: whitespace is trimmed but the value
    # itself must reach the exchange byte-identical (a changed key = a NEW
    # transfer at the exchange, defeating retry dedup).
    r = admin_client.post("/api/funds/transfer", json={
        "direction": "OUT", "amount": 10, "quote_asset": "USDT",
        "client_txn_id": "  intent-42  ",
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


# ---- position/leverage read (symbol-scoped; drives order-ticket sizing) ----

def test_position_leverage_reads_size0_record(admin_client, monkeypatch):
    from app import dma_client

    async def fake(symbol):
        return {"result": {"list": [
            {"symbol": symbol, "leverage": "5", "size": "0", "positionIdx": 0},
        ]}}

    monkeypatch.setattr(dma_client, "get_position_by_symbol", fake)
    r = admin_client.get("/api/position/leverage?symbol=solusdt")
    assert r.status_code == 200
    assert r.json() == {"symbol": "SOLUSDT", "leverage": "5"}


def test_position_leverage_bad_symbol(admin_client):
    assert admin_client.get("/api/position/leverage?symbol=SOL-USDT!").status_code == 400


def test_position_leverage_empty_list(admin_client, monkeypatch):
    from app import dma_client

    async def fake(symbol):
        return {"result": {"list": []}}

    monkeypatch.setattr(dma_client, "get_position_by_symbol", fake)
    r = admin_client.get("/api/position/leverage?symbol=BTCUSDT")
    assert r.status_code == 200 and r.json()["leverage"] is None


def test_position_leverage_one_way_returns_idx0(admin_client, monkeypatch):
    from app import dma_client

    async def fake(symbol):
        return {"result": {"list": [
            {"symbol": symbol, "leverage": "7", "positionIdx": 0},
        ]}}

    monkeypatch.setattr(dma_client, "get_position_by_symbol", fake)
    assert admin_client.get("/api/position/leverage?symbol=ETHUSDT").json()["leverage"] == "7"


def test_position_leverage_hedge_returns_null(admin_client, monkeypatch):
    # A hedge-mode account has NO idx-0 leg (buy=idx1, sell=idx2 with different
    # leverage). The endpoint must refuse to guess a leg and return null so the
    # ticket falls back to its safe "unavailable" path.
    from app import dma_client

    async def fake(symbol):
        return {"result": {"list": [
            {"symbol": symbol, "leverage": "5", "positionIdx": 1},
            {"symbol": symbol, "leverage": "20", "positionIdx": 2},
        ]}}

    monkeypatch.setattr(dma_client, "get_position_by_symbol", fake)
    assert admin_client.get("/api/position/leverage?symbol=ETHUSDT").json()["leverage"] is None


def test_position_leverage_requires_auth():
    # No auth override here (unlike the admin_client fixture): the endpoint must
    # reject an unauthenticated request rather than reach the exchange.
    from fastapi.testclient import TestClient
    from app import main as main_mod

    with TestClient(main_mod.app) as c:
        assert c.get("/api/position/leverage?symbol=BTCUSDT").status_code == 401


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


def test_rate_limit_keys_on_rightmost_xff_hop(admin_client):
    # Default TRUSTED_PROXY_HOPS=1: a rotating LEFTMOST X-Forwarded-For
    # (attacker-controlled) must NOT reset the bucket — the trusted proxy's
    # RIGHTMOST hop is the real key. Same rightmost => still locked out despite a
    # fresh spoofed leftmost each request.
    for i in range(12):
        admin_client.post(
            "/api/login", json={"username": "x", "password": "bad"},
            headers={"x-forwarded-for": f"1.2.3.{i}, 198.51.100.50"},
        )
    r = admin_client.post(
        "/api/login", json={"username": "x", "password": "bad"},
        headers={"x-forwarded-for": "9.9.9.9, 198.51.100.50"},
    )
    assert r.status_code == 429


def test_rate_limit_two_trusted_hops_keys_on_real_client(admin_client, monkeypatch):
    # With an edge proxy in front (TRUSTED_PROXY_HOPS=2, e.g. Cloudflare -> Railway),
    # the real client is the 2nd-from-right hop. Rotating the rightmost (the value
    # the edge/LB appended) must NOT escape the bucket; same real client stays locked.
    from app import main as main_mod
    monkeypatch.setattr(main_mod.settings, "TRUSTED_PROXY_HOPS", 2)
    for i in range(12):
        admin_client.post(
            "/api/login", json={"username": "x", "password": "bad"},
            headers={"x-forwarded-for": f"203.0.113.77, 10.0.0.{i}"},
        )
    r = admin_client.post(
        "/api/login", json={"username": "x", "password": "bad"},
        headers={"x-forwarded-for": "203.0.113.77, 10.0.0.250"},
    )
    assert r.status_code == 429


# ---- dashboard snapshot carries a monotonic generation stamp --------------

def test_dashboard_gen_is_monotonic(fake_upstream):
    # fake_upstream's default resp (retCode 0, empty result) lets build_dashboard
    # complete offline; assert the generation stamp is present and strictly rising.
    import asyncio
    from app import main as main_mod
    d1 = asyncio.run(main_mod.build_dashboard())
    d2 = asyncio.run(main_mod.build_dashboard())
    assert isinstance(d1["gen"], int) and d2["gen"] > d1["gen"]


# ---- set-margin-mode allowlist -------------------------------------------

@pytest.mark.parametrize("payload", [{}, {"setMarginMode": ""}, {"setMarginMode": "HYPER_MARGIN"}, {"mode": "isolated"}])
def test_set_margin_mode_rejects_bad(admin_client, payload):
    assert admin_client.post("/api/account/set-margin-mode", json=payload).status_code == 400


def test_set_margin_mode_normalizes_and_forwards(admin_client, monkeypatch):
    from app import dma_client
    captured = {}

    async def fake(mode):
        captured["mode"] = mode
        return {"retCode": 0, "result": {}}

    monkeypatch.setattr(dma_client, "set_margin_mode", fake)
    r = admin_client.post("/api/account/set-margin-mode", json={"setMarginMode": "isolated_margin"})
    assert r.status_code == 200
    assert captured["mode"] == "ISOLATED_MARGIN"  # upper-cased before forwarding


# ---- trading-stop triggerBy allowlist (fails fast, before the position lookup) --

def test_trading_stop_rejects_bad_trigger_by(admin_client):
    r = admin_client.post("/api/position/trading-stop", json={
        "symbol": "BTCUSDT", "takeProfit": "70000", "triggerBy": "Bogus",
    })
    assert r.status_code == 400
    assert "triggerBy" in r.text


# ---- symbol format validation on read + cancel endpoints ------------------

def test_orderbook_rejects_bad_symbol(admin_client):
    assert admin_client.get("/api/orderbook?symbol=BTC-USD!").status_code == 400


def test_instruments_rejects_bad_symbol(admin_client):
    assert admin_client.get("/api/instruments?symbol=B*T").status_code == 400


def test_instruments_allows_omitted_symbol(admin_client, monkeypatch):
    from app import dma_client

    async def fake(sym=None):
        assert sym is None  # blank/omitted stays None (full-list query)
        return {"result": {"list": []}}

    monkeypatch.setattr(dma_client, "get_instruments", fake)
    assert admin_client.get("/api/instruments").status_code == 200


def test_cancel_order_rejects_bad_symbol(admin_client):
    r = admin_client.post("/api/order/cancel", json={"symbol": "BTC/USD", "orderId": "1"})
    assert r.status_code == 400


def test_withdrawable_rejects_bad_coin(admin_client):
    assert admin_client.get("/api/withdrawable?coin=US*T").status_code == 400
