"""Username/password authentication with two roles, backed by signed cookies.

Credentials live in environment variables (ADMIN_* and VIEWER_*). On a
successful login we hand back a tamper-proof signed cookie carrying the
username, role and a session id.

Single active session PER ROLE: the server keeps one current session id per
role (admin, viewer) in memory. Each login mints a new id and replaces the one
for THAT role, so a second admin login evicts the earlier admin session — but a
viewer login can never evict the admin (and vice-versa). Keying by role matters
on a real-money app: the lower-trust viewer credential must not be able to knock
the trading admin offline (a denial-of-control during a live market). In-memory
is intentional: it needs a single replica and resets on restart (everyone
re-logs-in); the cookie is still cryptographically signed regardless.
"""
import hmac
import secrets

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import settings

# __Host- prefix: the browser refuses to store this cookie unless it is Secure,
# path=/, and host-locked (no Domain attribute) — so no subdomain or insecure
# transport can ever plant or override the session cookie. Sessions are
# in-memory (reset on deploy anyway), so renaming costs nothing. Browsers treat
# localhost as a secure context, so local dev keeps working.
COOKIE_NAME = "__Host-dma_session"
ROLE_ADMIN = "admin"
ROLE_VIEWER = "viewer"

# The currently-active session id PER ROLE. A role missing/None means no one is
# logged in with that role (also the state after a restart). Dict get/set is
# atomic under CPython's GIL, so there is no torn read/write.
_active_sessions: dict[str, str] = {}


def new_session_id() -> str:
    return secrets.token_urlsafe(16)


def set_active_session(role: str, sid: str) -> None:
    """Make `sid` the one active session FOR THIS ROLE (evicts the prior one of
    the same role only). If two same-role logins race, the last one scheduled
    wins and self-heals on the next login — acceptable for a 1-2 user terminal.
    """
    _active_sessions[role] = sid


def is_active_session(role: str | None, sid: str | None) -> bool:
    return bool(role) and bool(sid) and _active_sessions.get(role) == sid


def clear_active_session(role: str | None, sid: str | None) -> None:
    """Clear this role's active session, but only if `sid` is the current one, so
    a stale tab logging out cannot evict a newer session of the same role."""
    if role and sid and _active_sessions.get(role) == sid:
        _active_sessions.pop(role, None)


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(settings.SESSION_SECRET, salt="dma-session-v1")


def _matches(candidate: str, expected: str) -> bool:
    """Constant-time comparison that is safe when expected is empty.

    Encodes to UTF-8 bytes first: hmac.compare_digest raises TypeError on a str
    containing non-ASCII, which would turn a login/token attempt into an HTTP 500
    (log-spam / DoS). Byte comparison stays constant-time and accepts any input.
    """
    if not expected:
        return False
    return hmac.compare_digest(candidate.encode("utf-8"), expected.encode("utf-8"))


def authenticate(username: str, password: str) -> str | None:
    """Return the role ('admin'/'viewer') for valid credentials, else None."""
    if _matches(username, settings.ADMIN_USERNAME) and _matches(
        password, settings.ADMIN_PASSWORD
    ):
        return ROLE_ADMIN
    if _matches(username, settings.VIEWER_USERNAME) and _matches(
        password, settings.VIEWER_PASSWORD
    ):
        return ROLE_VIEWER
    return None


def create_session_token(username: str, role: str, sid: str) -> str:
    return _serializer().dumps({"u": username, "r": role, "sid": sid})


def verify_session_token(token: str | None) -> dict | None:
    """Return {'u': username, 'r': role, 'sid': ...} for a valid token, else None.

    NOTE: this only checks the signature/expiry. Callers must ALSO check
    is_active_session(payload['r'], payload['sid']) to enforce the per-role
    single-session rule.
    """
    if not token:
        return None
    try:
        return _serializer().loads(token, max_age=settings.SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None


def verify_trade_token(provided: str | None) -> bool:
    """Constant-time check of the per-write trade token.

    Fail-closed: if no TRADE_TOKEN is configured on the server, this always
    returns False so that no write operation can proceed.
    """
    if not settings.TRADE_TOKEN:
        return False
    if not provided:
        return False
    # Encode to bytes so a non-ASCII token can't raise (see _matches).
    return hmac.compare_digest(provided.encode("utf-8"), settings.TRADE_TOKEN.encode("utf-8"))
