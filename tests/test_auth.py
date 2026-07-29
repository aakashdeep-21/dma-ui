"""Auth invariants: credential checks, per-role single-session, token handling."""
from app import auth
from app.config import settings


def test_authenticate_valid_and_invalid():
    assert auth.authenticate(settings.ADMIN_USERNAME, settings.ADMIN_PASSWORD) == auth.ROLE_ADMIN
    assert auth.authenticate(settings.VIEWER_USERNAME, settings.VIEWER_PASSWORD) == auth.ROLE_VIEWER
    assert auth.authenticate(settings.ADMIN_USERNAME, "wrong") is None
    assert auth.authenticate("nobody", "wrong") is None


def test_authenticate_non_ascii_does_not_crash():
    # hmac.compare_digest raises on non-ASCII str; _matches must encode first.
    assert auth.authenticate("üser", "pä55") is None
    assert auth.verify_trade_token("nön-ascii-tökén") is False


def test_per_role_single_session_isolation():
    # A viewer login must NOT evict a live admin session (denial-of-control guard).
    auth.set_active_session(auth.ROLE_ADMIN, "admin-sid")
    auth.set_active_session(auth.ROLE_VIEWER, "viewer-sid")
    assert auth.is_active_session(auth.ROLE_ADMIN, "admin-sid") is True
    assert auth.is_active_session(auth.ROLE_VIEWER, "viewer-sid") is True
    # A second admin login evicts the earlier ADMIN session only.
    auth.set_active_session(auth.ROLE_ADMIN, "admin-sid-2")
    assert auth.is_active_session(auth.ROLE_ADMIN, "admin-sid") is False
    assert auth.is_active_session(auth.ROLE_ADMIN, "admin-sid-2") is True
    assert auth.is_active_session(auth.ROLE_VIEWER, "viewer-sid") is True  # untouched


def test_clear_only_clears_own_current_session():
    auth.set_active_session(auth.ROLE_ADMIN, "a1")
    auth.clear_active_session(auth.ROLE_ADMIN, "stale")  # not current -> no-op
    assert auth.is_active_session(auth.ROLE_ADMIN, "a1") is True
    auth.clear_active_session(auth.ROLE_ADMIN, "a1")
    assert auth.is_active_session(auth.ROLE_ADMIN, "a1") is False


def test_session_token_round_trip():
    tok = auth.create_session_token("adm", auth.ROLE_ADMIN, "sid-9")
    data = auth.verify_session_token(tok)
    assert data == {"u": "adm", "r": auth.ROLE_ADMIN, "sid": "sid-9"}
    assert auth.verify_session_token("garbage") is None
    assert auth.verify_session_token(None) is None


def test_trade_token_fail_closed_when_unset(monkeypatch):
    monkeypatch.setattr(settings, "TRADE_TOKEN", "")
    assert auth.verify_trade_token("anything") is False
    monkeypatch.setattr(settings, "TRADE_TOKEN", "the-secret")
    assert auth.verify_trade_token("the-secret") is True
    assert auth.verify_trade_token("nope") is False
    assert auth.verify_trade_token(None) is False


def test_me_serves_configured_inr_rate(admin_client, monkeypatch):
    # The frontend's display-only INR lens reads its rate from /api/me so the
    # deployed rate is configured in one place (env INR_RATE), not in app.js.
    monkeypatch.setattr(settings, "INR_RATE", 87.5)
    body = admin_client.get("/api/me").json()
    assert body["inrRate"] == 87.5
    assert body["role"] == "admin"
