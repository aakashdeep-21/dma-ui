"""Shared test setup.

Required env vars are forced BEFORE importing app.* — importing app.main runs the
fail-fast startup validation, so the process must look correctly configured. We
use a valid Ed25519 hex seed and non-placeholder secrets so the guards pass.
"""
import os

os.environ["DMA_API_KEY"] = "testkey"
os.environ["DMA_API_SECRET"] = "00" * 32  # valid 32-byte Ed25519 seed (hex)
os.environ["ADMIN_USERNAME"] = "adm"
os.environ["ADMIN_PASSWORD"] = "Str0ng-Admin-Pass-9f3a2b"
os.environ["VIEWER_USERNAME"] = "vwr"
os.environ["VIEWER_PASSWORD"] = "Str0ng-Viewer-Pass-7c1d4e"
os.environ["SESSION_SECRET"] = "unit-test-session-secret-0123456789abcdef"
os.environ["TRADE_TOKEN"] = "unit-test-trade-token-0123456789abcdef"

import json  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import dma_client, main as main_mod  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """Clear the module-level auth-failure buckets around each test so no test
    depends (even incidentally) on rate-limit state left behind by another —
    keeps the suite order-independent under pytest-randomly/xdist."""
    main_mod._auth_failures.clear()
    yield
    main_mod._auth_failures.clear()


class _FakeResp:
    """Minimal stand-in for an httpx.Response."""

    def __init__(self, status: int, data: dict):
        self.status_code = status
        self._data = data
        self.text = json.dumps(data)

    def json(self):
        return self._data


@pytest.fixture
def fake_upstream(monkeypatch):
    """Replace the signed httpx client so no real network call is made and tests
    control the exact upstream envelope returned. Records the last POST body."""
    calls = {"post_body": None, "resp": _FakeResp(200, {"retCode": 0, "result": {}})}

    async def fake_post(url, headers=None, content=None):
        calls["post_body"] = content
        return calls["resp"]

    async def fake_get(url, headers=None):
        return calls["resp"]

    monkeypatch.setattr(dma_client._client, "post", fake_post)
    monkeypatch.setattr(dma_client._client, "get", fake_get)
    return calls


@pytest.fixture
def admin_client(monkeypatch):
    """TestClient with the auth gates overridden to a fake admin, so route-level
    VALIDATION can be tested in isolation from the auth machinery. Also captures
    the body passed to each dma_client write wrapper."""
    captured = {}

    async def _cap(name):
        async def fn(body_or_symbol=None, *args, **kwargs):
            captured[name] = {"arg0": body_or_symbol, "args": args, "kwargs": kwargs}
            return {"retCode": 0, "result": {"orderId": "test-1"}}
        return fn

    async def fake_create_order(body):
        captured["create_order"] = body
        return {"retCode": 0, "result": {"orderId": "test-1"}}

    async def fake_set_leverage(symbol, buy, sell):
        captured["set_leverage"] = {"symbol": symbol, "buy": buy, "sell": sell}
        return {"retCode": 0, "result": {}}

    async def fake_transfer(direction, amount, quote_asset, client_txn_id=None):
        captured["transfer"] = {
            "direction": direction, "amount": amount,
            "quote_asset": quote_asset, "client_txn_id": client_txn_id,
        }
        return {"success": True, "status": "COMPLETED"}

    monkeypatch.setattr(dma_client, "create_order", fake_create_order)
    monkeypatch.setattr(dma_client, "set_leverage", fake_set_leverage)
    monkeypatch.setattr(dma_client, "transfer_funds", fake_transfer)

    fake_admin = {"u": "adm", "r": "admin", "sid": "test-sid"}
    main_mod.app.dependency_overrides[main_mod.require_trade_token] = lambda: fake_admin
    main_mod.app.dependency_overrides[main_mod.require_admin] = lambda: fake_admin
    main_mod.app.dependency_overrides[main_mod.current_user] = lambda: fake_admin

    client = TestClient(main_mod.app)
    client.captured = captured
    yield client
    main_mod.app.dependency_overrides.clear()
