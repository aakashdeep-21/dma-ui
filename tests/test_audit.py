"""Audit trail on money operations + order-create idempotency/ambiguity handling."""
import json
import logging

import pytest
from fastapi.testclient import TestClient

from app import dma_client, main as main_mod
from app.config import settings

AUDIT = "dma-ui.audit"


def _audit_records(caplog):
    out = []
    for rec in caplog.records:
        if rec.name == AUDIT:
            out.append((rec.levelname, json.loads(rec.getMessage())))
    return out


ORDER = {"symbol": "BTCUSDT", "side": "Buy", "orderType": "Market", "qty": "0.5"}


def test_order_create_success_is_audited(admin_client, caplog):
    with caplog.at_level(logging.INFO, logger=AUDIT):
        r = admin_client.post("/api/order/create", json=ORDER)
    assert r.status_code == 200
    recs = _audit_records(caplog)
    assert len(recs) == 1
    level, entry = recs[0]
    assert level == "INFO"
    assert entry["audit"] == "order.create"
    assert entry["user"] == "adm" and entry["role"] == "admin"
    assert entry["ip"]  # client address captured
    assert entry["body"]["symbol"] == "BTCUSDT" and entry["body"]["qty"] == "0.5"
    assert entry["outcome"] == "ok"
    assert entry["orderId"] == "test-1"  # exchange id recorded for reconciliation
    # The trade token must never appear anywhere near an audit line.
    assert settings.TRADE_TOKEN not in caplog.text


def test_rejected_write_is_audited_and_still_raises(admin_client, monkeypatch, caplog):
    async def boom(body):
        raise dma_client.DMAError(400, {"retMsg": "insufficient balance", "reqId": "sekret"})

    monkeypatch.setattr(dma_client, "create_order", boom)
    with caplog.at_level(logging.INFO, logger=AUDIT):
        r = admin_client.post("/api/order/create", json=ORDER)
    assert r.status_code == 400  # behaviour unchanged: the error still propagates
    level, entry = _audit_records(caplog)[0]
    assert level == "WARNING"
    assert entry["outcome"] == "rejected" and entry["status"] == 400
    assert entry["error"] == "insufficient balance"
    assert "sekret" not in json.dumps(entry)  # sanitized message only, no raw envelope


def test_transfer_is_audited_with_idempotency_key(admin_client, caplog):
    with caplog.at_level(logging.INFO, logger=AUDIT):
        r = admin_client.post("/api/funds/transfer", json={
            "direction": "OUT", "amount": 10, "quote_asset": "USDT",
            "client_txn_id": "intent-77",
        })
    assert r.status_code == 200
    _, entry = _audit_records(caplog)[0]
    assert entry["audit"] == "funds.transfer"
    assert entry["body"]["client_txn_id"] == "intent-77"
    assert entry["outcome"] == "ok"


def test_login_success_and_failure_are_audited():
    client = TestClient(main_mod.app)
    import logging as _logging
    records = []

    class _Capture(_logging.Handler):
        def emit(self, rec):
            records.append(json.loads(rec.getMessage()))

    h = _Capture()
    _logging.getLogger(AUDIT).addHandler(h)
    try:
        client.post("/api/login", json={"username": "whoops-my-password", "password": "x"},
                    headers={"x-forwarded-for": "203.0.113.44"})
        client.post("/api/login", json={"username": settings.ADMIN_USERNAME,
                                        "password": settings.ADMIN_PASSWORD},
                    headers={"x-forwarded-for": "203.0.113.44"})
    finally:
        _logging.getLogger(AUDIT).removeHandler(h)
    fail = next(r for r in records if r["outcome"] == "invalid")
    ok = next(r for r in records if r["outcome"] == "ok")
    # Failed attempts must NOT record the typed username (often a password).
    assert "user" not in fail and fail["ip"] == "203.0.113.44"
    assert ok["user"] == settings.ADMIN_USERNAME and ok["role"] == "admin"


# ---- order idempotency tag (env-gated) + ambiguous-timeout messaging --------

def test_order_link_id_off_by_default(admin_client):
    r = admin_client.post("/api/order/create", json=ORDER)
    assert r.status_code == 200
    assert "orderLinkId" not in admin_client.captured["create_order"]


def test_order_link_id_when_enabled_is_server_generated(admin_client, monkeypatch):
    monkeypatch.setattr(settings, "SEND_ORDER_LINK_ID", True)
    # A client-supplied tag must still be ignored (mass-assignment allowlist).
    r = admin_client.post("/api/order/create", json={**ORDER, "orderLinkId": "attacker"})
    assert r.status_code == 200
    link = admin_client.captured["create_order"]["orderLinkId"]
    assert link.startswith("dma-") and link != "attacker"
    assert len(link) <= 36  # Bybit v5 hard cap on orderLinkId length


@pytest.mark.parametrize("status", [502, 504])
def test_upstream_5xx_on_create_warns_about_ambiguity(admin_client, monkeypatch, status):
    async def timeout(body):
        raise dma_client.DMAError(status, "upstream request failed: timeout")

    monkeypatch.setattr(dma_client, "create_order", timeout)
    r = admin_client.post("/api/order/create", json=ORDER)
    assert r.status_code == status
    assert "MAY still have been placed" in r.json()["error"]
    assert "Check Open Orders" in r.json()["error"]


def test_business_rejection_message_is_not_rewritten(admin_client, monkeypatch):
    # A 4xx is a DEFINITIVE rejection — the ambiguity warning must not appear.
    async def rejected(body):
        raise dma_client.DMAError(400, {"retMsg": "qty too small"})

    monkeypatch.setattr(dma_client, "create_order", rejected)
    r = admin_client.post("/api/order/create", json=ORDER)
    assert r.status_code == 400
    assert r.json()["error"] == "qty too small"
