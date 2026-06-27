"""Username/password authentication with two roles, backed by signed cookies.

Credentials live in environment variables (ADMIN_* and VIEWER_*). On a
successful login we hand back a tamper-proof signed cookie carrying the
username, role and a session id.

Single active session (GLOBAL): the server keeps ONE current session id in
memory. Each login mints a new id and replaces it, so any earlier session
(any account, any tab, any device) is immediately invalidated — only one login
is ever active at a time. In-memory is intentional: it needs a single replica
and resets on restart (everyone re-logs-in); there is no security downside,
since the cookie is still cryptographically signed.
"""
import hmac
import secrets

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import settings

COOKIE_NAME = "dma_session"
ROLE_ADMIN = "admin"
ROLE_VIEWER = "viewer"

# The single currently-active session id (global across all users). None means
# no one is logged in (also the state after a restart).
_active_session_id: str | None = None


def new_session_id() -> str:
    return secrets.token_urlsafe(16)


def set_active_session(sid: str) -> None:
    """Make `sid` the one and only active session (evicts all others).

    Single-assignment of a module global is atomic under CPython's GIL, so there
    is no torn read/write. If two logins happen at the exact same instant, the
    last one scheduled wins (best-effort ordering) and the situation self-heals
    on the next login — acceptable for a 1-2 user terminal.
    """
    global _active_session_id
    _active_session_id = sid


def is_active_session(sid: str | None) -> bool:
    return bool(sid) and sid == _active_session_id


def clear_active_session(sid: str | None) -> None:
    """Clear the active session, but only if `sid` is the current one, so a
    stale tab logging out cannot evict a newer session."""
    global _active_session_id
    if sid and sid == _active_session_id:
        _active_session_id = None


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(settings.SESSION_SECRET, salt="dma-session-v1")


def _matches(candidate: str, expected: str) -> bool:
    """Constant-time comparison that is safe when expected is empty."""
    if not expected:
        return False
    return hmac.compare_digest(candidate, expected)


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
    is_active_session(payload['sid']) to enforce the single-session rule.
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
    return hmac.compare_digest(provided, settings.TRADE_TOKEN)
