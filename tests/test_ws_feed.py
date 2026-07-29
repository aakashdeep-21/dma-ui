"""Shared WebSocket broadcaster: one dashboard poll fans out to every socket.

Uses `with TestClient(...)` so the lifespan runs on ONE portal event loop —
the lazily-started broadcaster task then lives (and is cancelled at shutdown)
on the same loop as the websocket connections.
"""
import pytest
from starlette.websockets import WebSocketDisconnect
from fastapi.testclient import TestClient

from app import auth, main as main_mod


@pytest.fixture
def ws_env(monkeypatch, fake_upstream):
    """Fast poll interval + a clean broadcaster/session slate per test."""
    monkeypatch.setattr(main_mod.settings, "POLL_INTERVAL", 0.05)
    saved_sessions = dict(auth._active_sessions)
    main_mod._ws_clients.clear()
    main_mod._ws_last_frame = None
    main_mod._ws_broadcast_task = None
    yield
    main_mod._ws_clients.clear()
    main_mod._ws_last_frame = None
    main_mod._ws_broadcast_task = None
    auth._active_sessions.clear()
    auth._active_sessions.update(saved_sessions)


def _admin_cookie() -> tuple[str, str]:
    sid = auth.new_session_id()
    auth.set_active_session(auth.ROLE_ADMIN, sid)
    return auth.create_session_token("adm", auth.ROLE_ADMIN, sid), sid


def _receive_gens(ws, count: int) -> list[int]:
    gens = []
    for _ in range(count):
        msg = ws.receive_json()
        if msg.get("type") == "dashboard":
            gens.append(msg["gen"])
    return gens


def test_ws_rejects_unauthenticated(ws_env):
    with TestClient(main_mod.app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws"):
                pass


def test_two_sockets_share_one_poll(ws_env):
    # With per-connection polling every build_dashboard had a unique `gen`, so
    # two sockets could never see the same one. The shared broadcaster sends the
    # SAME frame to every socket — their gen streams must overlap.
    token, _sid = _admin_cookie()
    with TestClient(main_mod.app) as client:
        headers = {"cookie": f"{auth.COOKIE_NAME}={token}"}
        with client.websocket_connect("/ws", headers=headers) as ws1:
            with client.websocket_connect("/ws", headers=headers) as ws2:
                g1 = _receive_gens(ws1, 4)
                g2 = _receive_gens(ws2, 4)
    assert set(g1) & set(g2), (g1, g2)


def test_evicted_session_is_closed_with_1008(ws_env):
    token, _sid = _admin_cookie()
    with TestClient(main_mod.app) as client:
        headers = {"cookie": f"{auth.COOKIE_NAME}={token}"}
        with client.websocket_connect("/ws", headers=headers) as ws:
            ws.receive_json()  # feed is live
            # A newer same-role login supersedes this session…
            auth.set_active_session(auth.ROLE_ADMIN, auth.new_session_id())
            # …so the broadcaster must close this socket with 1008 (policy
            # violation), which the SPA maps to a redirect to /login.
            with pytest.raises(WebSocketDisconnect) as exc_info:
                for _ in range(50):
                    ws.receive_json()
            assert exc_info.value.code == 1008


def test_ws_error_frames_are_sanitized(ws_env, monkeypatch):
    # An unexpected build failure must surface as a generic error frame — never
    # the internal exception text (it can carry paths/keys/upstream envelopes).
    async def boom():
        raise RuntimeError("secret internal detail")

    monkeypatch.setattr(main_mod, "build_dashboard", boom)
    token, _sid = _admin_cookie()
    with TestClient(main_mod.app) as client:
        headers = {"cookie": f"{auth.COOKIE_NAME}={token}"}
        with client.websocket_connect("/ws", headers=headers) as ws:
            msg = ws.receive_json()
    assert msg["type"] == "error"
    assert "secret internal detail" not in msg["error"]


def test_broadcaster_survives_a_failing_cycle(ws_env, monkeypatch):
    # The shared poller is the ONE feed for every tab and nothing restarts it
    # until a new connection — a cycle failure must never kill the loop.
    calls = {"n": 0}
    real = main_mod._ws_build_frame

    async def flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("cycle exploded")
        return await real()

    monkeypatch.setattr(main_mod, "_ws_build_frame", flaky)
    token, _sid = _admin_cookie()
    with TestClient(main_mod.app) as client:
        headers = {"cookie": f"{auth.COOKIE_NAME}={token}"}
        with client.websocket_connect("/ws", headers=headers) as ws:
            msg = ws.receive_json()  # frame from cycle 2+ — the loop survived
    assert msg["type"] in ("dashboard", "error")
    assert calls["n"] >= 2


def test_rate_limited_build_requests_cooldown(ws_env, monkeypatch):
    import asyncio
    from app import dma_client

    async def throttled():
        raise dma_client.DMAError(400, "Too many visits!", ret_code=10006)

    monkeypatch.setattr(main_mod, "build_dashboard", throttled)
    payload, cooldown = asyncio.run(main_mod._ws_build_frame())
    assert cooldown == main_mod.settings.POLL_INTERVAL * main_mod._WS_RATE_LIMIT_EXTRA_CYCLES
    assert '"error"' in payload

    async def rejected():
        raise dma_client.DMAError(400, "params error", ret_code=10001)

    monkeypatch.setattr(main_mod, "build_dashboard", rejected)
    _, cooldown = asyncio.run(main_mod._ws_build_frame())
    assert cooldown == 0.0  # ordinary rejections never slow the feed


def test_nan_from_exchange_is_sanitized_not_dropped(ws_env, fake_upstream, monkeypatch):
    import asyncio
    import json as _json

    # Python's json.loads ACCEPTS literal NaN — simulate a degraded exchange
    # response carrying one inside a raw position record.
    fake_upstream["resp"].json = lambda: {
        "retCode": 0,
        "result": {"list": [{"symbol": "BTCUSDT", "size": "1", "unrealisedPnl": float("nan")}]},
    }
    data = asyncio.run(main_mod.build_dashboard())
    # Serializable as STRICT JSON (the browser can parse the frame)…
    _json.dumps(data, allow_nan=False)
    # …and the poisoned cell is the honest string form, never a fake number.
    assert data["positions"][0]["unrealisedPnl"] == "nan"
