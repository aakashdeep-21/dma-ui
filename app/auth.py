"""Username/password authentication with two roles, backed by signed cookies.

Credentials live in environment variables (ADMIN_* and VIEWER_*). On a
successful login we hand back a tamper-proof signed cookie carrying the
username and role; no server-side session store is needed.
"""
import hmac

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import settings

COOKIE_NAME = "dma_session"
ROLE_ADMIN = "admin"
ROLE_VIEWER = "viewer"


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


def create_session_token(username: str, role: str) -> str:
    return _serializer().dumps({"u": username, "r": role})


def verify_session_token(token: str | None) -> dict | None:
    """Return {'u': username, 'r': role} for a valid token, else None."""
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
