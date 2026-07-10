"""FastAPI application: serves the trading UI, proxies signed DMA calls, and
streams a live positions/orders/PnL feed over a WebSocket.

Security model:
  * API key/secret live only in the backend (env vars) and are used to sign
    every upstream request. The browser never sees them.
  * Two login roles: 'admin' may trade; 'viewer' is read-only.
  * Every write endpoint requires BOTH the admin role AND a valid per-request
    trade token (the X-Trade-Token header), checked against TRADE_TOKEN.
    Writes are fail-closed: no token configured -> no writes possible.
"""
import asyncio
import logging
import math
import re
import sys
import time
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import (
    Body,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from bson.errors import BSONError
from pathlib import Path
from pymongo.errors import PyMongoError
from starlette.responses import Response as StarletteResponse

from . import auth, db, dma_client, history_sync, market_data, notifier, signer
from .config import settings

def _configure_logging() -> None:
    """Route normal logs to stdout and only warnings/errors to stderr.

    Railway tags ANYTHING on stderr as level=error and colors it red. By
    default uvicorn and httpx log INFO to stderr, so successful 200s and
    startup messages show up as scary red "errors". This sends INFO->stdout
    (normal) and WARNING+->stderr (genuinely red so real problems stand out),
    and silences httpx's per-request chatter (3 lines every poll).
    """
    fmt = logging.Formatter("%(levelname)s %(name)s: %(message)s")

    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setFormatter(fmt)
    stdout_handler.addFilter(lambda record: record.levelno < logging.WARNING)

    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setFormatter(fmt)
    stderr_handler.setLevel(logging.WARNING)

    root = logging.getLogger()
    root.handlers = [stdout_handler, stderr_handler]
    root.setLevel(logging.INFO)

    # uvicorn installs its own stderr handlers; clear them and let records flow
    # to our root handlers so they're split by level (stdout vs stderr) too.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True

    # httpx logs every upstream request at INFO — pure noise. Keep warnings+.
    logging.getLogger("httpx").setLevel(logging.WARNING)


_configure_logging()
logger = logging.getLogger("dma-ui")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # MongoDB (history store): verify connectivity and indexes as a BACKGROUND
    # task so a down/slow Mongo can never delay serving the trading routes.
    # History endpoints return 503 until it recovers; missing CONFIG still
    # fails fast at import, and the sync scheduler re-runs ensure_indexes
    # before each run so a failed boot-time attempt self-heals.
    async def _init_db() -> None:
        try:
            await db.ping()
            await db.ensure_indexes()
            logger.info("mongo connected db=%s", settings.MONGO_DB_NAME)
        except Exception:
            logger.exception(
                "mongo unavailable at startup — history reads/sync degraded until it recovers"
            )

    db_init = asyncio.create_task(_init_db())
    # Background execution-alert watcher (Telegram). Runs for the app's lifetime,
    # independent of any browser; a no-op if alerts aren't configured.
    watcher = asyncio.create_task(notifier.run_watcher())
    # Background history sync: the ONLY place the exchange's trade/closed-PnL
    # history is fetched from; the dashboard reads MongoDB.
    syncer = asyncio.create_task(history_sync.run_scheduler())
    try:
        yield
    finally:
        for task in (db_init, watcher, syncer):
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        # Cleanly close the shared upstream HTTP clients and the DB client.
        await dma_client.aclose()
        await market_data.aclose()
        await notifier.aclose()
        await db.aclose()


app = FastAPI(title="DMA Trading UI", lifespan=lifespan)

STATIC_DIR = Path(__file__).resolve().parent / "static"

# Fail fast: refuse to start if any required secret is missing. Critically,
# an empty SESSION_SECRET would let itsdangerous sign cookies with a known
# empty key, allowing anyone to forge an admin session. Better to crash the
# deploy loudly than to serve a forgeable, real-money app.
_missing_env = settings.missing_required()
if _missing_env:
    raise RuntimeError(
        "Refusing to start — missing required environment variables: "
        + ", ".join(_missing_env)
    )

# Refuse to boot on placeholder/weak secrets (e.g. a verbatim .env.example): a
# known SESSION_SECRET lets anyone forge an admin cookie, and a guessable
# password/trade token is a direct path to the money controls.
_insecure_env = settings.insecure_required()
if _insecure_env:
    raise RuntimeError("Refusing to start — insecure configuration: " + "; ".join(_insecure_env))

# A malformed signing key must fail the deploy, not the first live trade.
if not signer.secret_is_valid_ed25519_hex(settings.DMA_API_SECRET):
    raise RuntimeError("Refusing to start — DMA_API_SECRET is not a valid Ed25519 hex key")

# Misconfigured Mongo TLS would fail every connection at runtime with a much
# murkier error — fail the deploy instead. Exactly one of PATH (a PEM-encoded
# file on disk, .pem/.crt alike; never committed — see .gitignore) or CONTENT
# (pasted PEM text, for hosts like Railway with no file on disk) may be set.
if settings.MONGO_TLS_CA_FILE and settings.MONGO_TLS_CA_PEM:
    raise RuntimeError(
        "Refusing to start — set only ONE of MONGO_TLS_CA_FILE / MONGO_TLS_CA_PEM"
    )
if settings.MONGO_TLS_CA_FILE and not Path(settings.MONGO_TLS_CA_FILE).is_file():
    raise RuntimeError(
        "Refusing to start — MONGO_TLS_CA_FILE points to a missing file: "
        + settings.MONGO_TLS_CA_FILE
    )
if settings.MONGO_TLS_CA_PEM and "-----BEGIN" not in settings.MONGO_TLS_CA_PEM:
    raise RuntimeError(
        "Refusing to start — MONGO_TLS_CA_PEM is set but does not look like PEM "
        "certificate content (expected '-----BEGIN CERTIFICATE-----'); did you "
        "paste a file PATH instead? Use MONGO_TLS_CA_FILE for paths."
    )

for _w in settings.warn_weak():
    logger.warning("config: %s", _w)


# --------------------------------------------------------------------------
# Security headers (defense-in-depth) — stamped on EVERY response.
#   * CSP + frame-ancestors 'none' / X-Frame-Options: DENY -> no clickjacking of
#     the authenticated real-money SPA (the X-Trade-Token CSRF defense does not
#     stop UI-redress framing).
#   * script-src 'self' -> a future escaping regression can't execute injected JS.
#     (All scripts are external files; style-src keeps 'unsafe-inline' for the
#     HTML's style="" attributes.)
# --------------------------------------------------------------------------
_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
    "base-uri 'none'; object-src 'none'; form-action 'self'"
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["Content-Security-Policy"] = _CSP
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    return resp


# --------------------------------------------------------------------------
# Lightweight in-process rate limiting for the auth endpoints (single replica,
# so a module dict suffices). Counts only FAILED attempts and clears on success,
# so a legitimate operator typing the right secret is never locked out. Best-
# effort (resets on restart); an edge/CDN limiter is still recommended.
# --------------------------------------------------------------------------
_FAIL_WINDOW = 300.0  # seconds
_FAIL_MAX = 10        # failures per key per window before a 429

_auth_failures: dict[str, list[float]] = {}


def _client_ip(request: Request) -> str:
    """Best-effort real client IP for rate-limit bucketing.

    X-Forwarded-For is ``<client-supplied…>, <hop appended by proxy 1>, …`` — each
    trusted proxy APPENDS the address it saw, on the RIGHT. The leftmost value is
    fully client-controlled, so keying rate limits on it lets an attacker rotate a
    fake XFF per request and dodge the login / trade-token lockout. We instead take
    the hop `TRUSTED_PROXY_HOPS` from the right — the value our own proxy chain
    added, which the client cannot forge. Default 1 (Railway's single proxy); set
    TRUSTED_PROXY_HOPS=2 when an edge proxy (e.g. Cloudflare) sits in front, so all
    clients don't collapse into one shared bucket (a lockout-DoS). Falls back to the
    socket peer when no XFF is present.
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        hops = [h.strip() for h in xff.split(",") if h.strip()]
        if hops:
            idx = len(hops) - settings.TRUSTED_PROXY_HOPS
            return hops[idx] if idx >= 0 else hops[0]
    return request.client.host if request.client else "unknown"


def _rate_limited(bucket_key: str) -> bool:
    now = time.monotonic()
    times = [t for t in _auth_failures.get(bucket_key, []) if now - t < _FAIL_WINDOW]
    _auth_failures[bucket_key] = times
    return len(times) >= _FAIL_MAX


def _record_failure(bucket_key: str) -> None:
    _auth_failures.setdefault(bucket_key, []).append(time.monotonic())


def _clear_failures(bucket_key: str) -> None:
    _auth_failures.pop(bucket_key, None)


# --------------------------------------------------------------------------
# Auth dependencies
# --------------------------------------------------------------------------
def current_user(request: Request) -> dict:
    token = request.cookies.get(auth.COOKIE_NAME)
    user = auth.verify_session_token(token)
    # Enforce the single active session PER ROLE: a valid-but-superseded cookie
    # (an older tab/device after a newer same-role login) is rejected.
    if not user or not auth.is_active_session(user.get("r"), user.get("sid")):
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user.get("r") != auth.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Admin role required")
    return user


TRADE_TOKEN_HEADER = "X-Trade-Token"


def require_trade_token(request: Request, user: dict = Depends(require_admin)) -> dict:
    """Gate for ALL write operations.

    Requires (a) a valid admin session AND (b) a correct trade token supplied
    in the X-Trade-Token header on this specific request. Fail-closed: if the
    server has no TRADE_TOKEN configured, every write is rejected.

    The custom header also doubles as CSRF protection: a cross-site page cannot
    set custom headers without a CORS preflight that this server never grants.
    """
    if not settings.TRADE_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="Trade token is not configured on the server; writes are disabled",
        )
    provided = request.headers.get(TRADE_TOKEN_HEADER, "")
    if not auth.verify_trade_token(provided):
        raise HTTPException(
            status_code=403, detail="Invalid or missing trade token"
        )
    return user


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _safe_float(value) -> float:
    # Reject inf/nan: float("inf")/float("nan") parse fine, but json.dumps emits
    # Infinity/NaN (invalid JSON) which makes the browser's JSON.parse throw and
    # drops the entire WebSocket frame. Coerce non-finite values to 0.0.
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if math.isfinite(result) else 0.0


# Single source, shared with the alert watcher (app/notifier.py). Aliased rather
# than wrapped so there is no needless indirection.
_extract_list = dma_client.extract_list


# Bybit-v5 linear symbols are upper-case alphanumeric (e.g. BTCUSDT, 1000PEPEUSDT).
_SYMBOL_RE = re.compile(r"^[A-Z0-9]{1,20}$")
# Coins/settle assets are shorter upper-case alphanumerics (USDT, USDC, BTC, …).
_COIN_RE = re.compile(r"^[A-Z0-9]{1,15}$")


def _valid_symbol(sym) -> bool:
    return isinstance(sym, str) and bool(_SYMBOL_RE.match(sym))


def _require_symbol(symbol) -> str:
    """Uppercase + validate a REQUIRED symbol; raise 400 on a bad format so a
    garbage value never reaches the signed upstream."""
    sym = str(symbol).upper()
    if not _valid_symbol(sym):
        raise HTTPException(status_code=400, detail="symbol has an invalid format")
    return sym


def _norm_symbol_opt(symbol):
    """Uppercase + validate an OPTIONAL symbol param. None/blank passes through as
    None (these endpoints legitimately query the full list when no symbol is
    given); a provided-but-malformed symbol is rejected with 400."""
    if symbol is None or (isinstance(symbol, str) and not symbol.strip()):
        return None
    return _require_symbol(symbol)


def _norm_coin_opt(coin):
    """Uppercase + validate an OPTIONAL coin param (None/blank -> None)."""
    if coin is None or (isinstance(coin, str) and not coin.strip()):
        return None
    c = str(coin).upper()
    if not _COIN_RE.match(c):
        raise HTTPException(status_code=400, detail="coin has an invalid format")
    return c


def _positive_finite(value) -> bool:
    """True iff `value` parses to a FINITE number > 0.

    Money-path guard: a bare `float(x) <= 0` check lets 'inf'/'1e400' through
    (inf <= 0 is False), which would serialise as invalid JSON to the exchange.
    Requiring math.isfinite closes that.
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(number) and number > 0


# Monotonic dashboard-snapshot counter. Both the WS push and the /api/dashboard
# GET call build_dashboard in this one process, so a per-build increment lets the
# client order snapshots by data-assembly time regardless of transport (the client
# renders the highest `gen` seen and drops older ones). Incremented with no await
# between read and write, so it is race-free under the event loop's single thread.
_dashboard_gen = 0


async def build_dashboard() -> dict:
    """Fetch positions, open orders and balance; compute a PnL summary."""
    positions_raw, orders_raw, balance_raw = await asyncio.gather(
        dma_client.get_positions(),
        dma_client.get_open_orders(),
        dma_client.get_wallet_balance(),
        return_exceptions=True,
    )

    errors = {}

    positions = []
    if isinstance(positions_raw, Exception):
        errors["positions"] = str(positions_raw)
    else:
        positions = _extract_list(positions_raw)

    orders = []
    if isinstance(orders_raw, Exception):
        errors["orders"] = str(orders_raw)
    else:
        orders = _extract_list(orders_raw)

    balance = None
    if isinstance(balance_raw, Exception):
        errors["balance"] = str(balance_raw)
    else:
        balance = balance_raw

    total_unrealised = sum(_safe_float(p.get("unrealisedPnl")) for p in positions)
    total_position_value = sum(_safe_float(p.get("positionValue")) for p in positions)

    # Stamp at assembly time (no await between here and return, so it reflects the
    # order in which concurrent builds finished reading the exchange).
    global _dashboard_gen
    _dashboard_gen += 1

    return {
        "type": "dashboard",
        "gen": _dashboard_gen,
        "positions": positions,
        "orders": orders,
        "balance": balance,
        "summary": {
            "totalUnrealisedPnl": total_unrealised,
            "totalPositionValue": total_position_value,
            "openPositions": len([p for p in positions if _safe_float(p.get("size"))]),
            "openOrders": len(orders),
            "settleCoin": settings.SETTLE_COIN,
        },
        "errors": errors,
    }


# Force browsers to revalidate the HTML shell on every load so a deploy's new
# markup is never paired with a stale cached app.js/styles.css.
_NO_CACHE = {"Cache-Control": "no-cache"}


# --------------------------------------------------------------------------
# Page routes
# --------------------------------------------------------------------------
@app.get("/login")
def login_page():
    return FileResponse(STATIC_DIR / "login.html", headers=_NO_CACHE)


@app.get("/")
def index(request: Request):
    token = request.cookies.get(auth.COOKIE_NAME)
    user = auth.verify_session_token(token)
    # Mirror current_user: don't serve the app shell to a superseded session
    # (the data APIs/WS would reject it anyway; this keeps the redirect consistent).
    if not user or not auth.is_active_session(user.get("r"), user.get("sid")):
        return RedirectResponse(url="/login", status_code=302)
    return FileResponse(STATIC_DIR / "index.html", headers=_NO_CACHE)


@app.get("/healthz")
def healthz():
    missing = settings.missing_required()
    code = 200 if not missing else 503
    return JSONResponse(
        status_code=code,
        content={"status": "ok" if not missing else "unconfigured", "missing": missing},
    )


# --------------------------------------------------------------------------
# Auth API
# --------------------------------------------------------------------------
@app.post("/api/login")
def api_login(request: Request, payload: dict = Body(...)):
    ip = _client_ip(request)
    if _rate_limited(f"login:{ip}"):
        raise HTTPException(
            status_code=429,
            detail="Too many failed attempts; wait a few minutes and try again",
        )
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    role = auth.authenticate(username, password)
    if not role:
        _record_failure(f"login:{ip}")
        raise HTTPException(status_code=401, detail="Invalid username or password")
    _clear_failures(f"login:{ip}")

    # Mint a new session id and make it THE active session FOR THIS ROLE — this
    # evicts any other same-role session, but never the other role's.
    sid = auth.new_session_id()
    auth.set_active_session(role, sid)
    token = auth.create_session_token(username, role, sid)
    resp = JSONResponse({"username": username, "role": role})
    resp.set_cookie(
        key=auth.COOKIE_NAME,
        value=token,
        max_age=settings.SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=True,  # Railway serves over HTTPS
    )
    return resp


@app.post("/api/logout")
def api_logout(request: Request):
    # Only clear the active session if this cookie IS the active one (so a stale
    # tab's logout can't evict a newer session).
    data = auth.verify_session_token(request.cookies.get(auth.COOKIE_NAME))
    if data:
        auth.clear_active_session(data.get("r"), data.get("sid"))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE_NAME)
    return resp


@app.get("/api/me")
def api_me(user: dict = Depends(current_user)):
    return {"username": user.get("u"), "role": user.get("r")}


@app.post("/api/verify-trade-token")
def api_verify_trade_token(
    request: Request, payload: dict = Body(...), user: dict = Depends(require_admin)
):
    """Check whether a trade token is correct so the UI can give immediate
    feedback when it's entered (instead of only failing on the first write).
    Admin-only and constant-time; additionally rate-limited so it can't be used
    as an online guessing oracle even after an admin session is obtained.
    """
    ip = _client_ip(request)
    if _rate_limited(f"tradetoken:{ip}"):
        raise HTTPException(status_code=429, detail="Too many attempts; wait a few minutes")
    valid = auth.verify_trade_token(payload.get("token") or "")
    if valid:
        _clear_failures(f"tradetoken:{ip}")
    else:
        _record_failure(f"tradetoken:{ip}")
    return {"valid": valid}


# --------------------------------------------------------------------------
# Read API (any logged-in user)
# --------------------------------------------------------------------------
@app.get("/api/dashboard")
async def api_dashboard(user: dict = Depends(current_user)):
    return await build_dashboard()


@app.get("/api/positions")
async def api_positions(user: dict = Depends(current_user)):
    return await dma_client.get_positions()


@app.get("/api/position/leverage")
async def api_position_leverage(symbol: str, user: dict = Depends(require_admin)):
    """The account's CURRENT leverage for a symbol — present even with no open
    position. Admin-only (only the order ticket uses it) and read-only; returns
    just the leverage value, not the full position record.

    Returns ONLY the one-way (positionIdx 0) leg's leverage. On a hedge-mode
    account (no idx-0 leg; separate buy/sell leverage) it returns null rather than
    guess a leg — the order ticket then falls back to its safe 'unavailable' path
    instead of sizing against the wrong side's leverage."""
    sym = _require_symbol(symbol)
    entries = _extract_list(await dma_client.get_position_by_symbol(sym))
    one_way = next(
        (e for e in entries if str(e.get("positionIdx")) == "0" and e.get("leverage")),
        None,
    )
    return {"symbol": sym, "leverage": (one_way or {}).get("leverage")}


@app.get("/api/orders")
async def api_orders(user: dict = Depends(current_user)):
    return await dma_client.get_open_orders()


@app.get("/api/balance")
async def api_balance(user: dict = Depends(current_user)):
    return await dma_client.get_wallet_balance()


@app.get("/api/instruments")
async def api_instruments(symbol: str | None = None, user: dict = Depends(current_user)):
    return await dma_client.get_instruments(_norm_symbol_opt(symbol))


# --- History reads (MongoDB-backed) ---
# /api/closed-pnl and /api/executions serve the dashboard from the MongoDB
# mirror maintained by app/history_sync.py; the exchange is no longer called on
# the read path (only the sync — and the Telegram notifier's live fill poll —
# talk to it). Responses keep the exact upstream v5 envelope
# {"retCode":0,"result":{"list":[...],"truncated":...,"category":...}} so the
# frontend renders unchanged.

_HISTORY_READ_MAX = 10_000  # superset of the old ~6k effective ceiling
# The gateway's default span when no range is given = its 7-day window rule.
_EXPLORER_LOOKBACK_MS = dma_client._HISTORY_WINDOW_MS


def _clamp_days(days: int | None) -> int:
    # Parity with the exchange-side clamp (None/0 -> default, bounded 1..max),
    # sourced from the same constants so the two can never drift apart.
    return max(1, min(int(days or dma_client._HISTORY_DEFAULT_DAYS), dma_client._HISTORY_MAX_DAYS))


def _parse_ms(value: str | None, name: str) -> int | None:
    if value is None or value.strip() == "":
        return None
    if not re.fullmatch(r"\d{1,17}", value.strip()):
        raise HTTPException(status_code=400, detail=f"{name} must be an epoch-milliseconds integer")
    return int(value.strip())


def _history_envelope(rows: list, truncated: bool, kind: str) -> dict:
    return {
        "retCode": 0,
        "retMsg": "OK",
        "result": {
            "category": settings.CATEGORY,
            "list": rows,
            "truncated": truncated,
            # Epoch-ms of the last completed sync for this collection (None
            # until the first run after boot) — the dashboard shows it so the
            # user knows how fresh the history is. nowMs is the SERVER clock
            # at response time: the browser measures staleness against it so
            # a skewed client clock can neither cry wolf nor hide staleness.
            "lastSyncedMs": history_sync.last_synced_ms(kind),
            "nowMs": int(time.time() * 1000),
        },
    }


async def _query_history_or_503(kind: str, *, symbol, start_ms: int, end_ms: int, limit: int) -> list:
    """History reads fail soft: a Mongo outage yields 503 for these endpoints
    while every trading function keeps working off the live exchange."""
    try:
        return await db.query_history(
            kind, symbol=symbol, start_ms=start_ms, end_ms=end_ms, limit=limit
        )
    except (PyMongoError, BSONError, OSError):
        # OSError covers the lazy client construction path too (TLS CA temp
        # file I/O, ssl.SSLError) — those must degrade to the same sanitized
        # 503, never a raw 500 with internal detail.
        logger.exception("history read failed (%s): mongo unavailable", kind)
        raise HTTPException(status_code=503, detail="history database unavailable")


@app.get("/api/closed-pnl")
async def api_closed_pnl(
    symbol: str | None = None,
    days: int | None = None,
    user: dict = Depends(current_user),
):
    # Same lookback semantics the exchange fetch had (default 30d, clamp 1..31),
    # now served from MongoDB.
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - _clamp_days(days) * 86_400_000
    rows = await _query_history_or_503(
        db.CLOSED_PNL, symbol=_norm_symbol_opt(symbol),
        start_ms=start_ms, end_ms=end_ms, limit=_HISTORY_READ_MAX,
    )
    return _history_envelope(rows, len(rows) >= _HISTORY_READ_MAX, db.CLOSED_PNL)


@app.get("/api/withdrawable")
async def api_withdrawable(coin: str | None = None, user: dict = Depends(current_user)):
    return await dma_client.get_withdrawable(_norm_coin_opt(coin))


@app.get("/api/executions")
async def api_executions(
    symbol: str | None = None,
    limit: str | None = None,
    startTime: str | None = None,
    endTime: str | None = None,
    days: int | None = None,
    user: dict = Depends(current_user),
):
    # When `days` is given (the History tab), cover the same period as closed
    # PnL (default 30d, clamp 1..31; limit/startTime/endTime ignored — exactly
    # the old behaviour). Otherwise mirror the gateway's single-page semantics
    # the API Explorer relied on: limit 1..100 (default 50), default span the
    # last 7 days. Both read MongoDB; the Telegram notifier still calls
    # dma_client.get_executions directly for its live fill alerts.
    sym = _norm_symbol_opt(symbol)
    now_ms = int(time.time() * 1000)
    if days is not None:
        start_ms = now_ms - _clamp_days(days) * 86_400_000
        rows = await _query_history_or_503(
            db.TRADES, symbol=sym, start_ms=start_ms, end_ms=now_ms,
            limit=_HISTORY_READ_MAX,
        )
        return _history_envelope(rows, len(rows) >= _HISTORY_READ_MAX, db.TRADES)

    try:
        cap = int(limit) if limit not in (None, "") else 50
    except ValueError:
        raise HTTPException(status_code=400, detail="limit must be an integer")
    cap = max(1, min(cap, 100))
    start_ms = _parse_ms(startTime, "startTime")
    end_ms = _parse_ms(endTime, "endTime")
    if start_ms is None and end_ms is None:
        start_ms, end_ms = now_ms - _EXPLORER_LOOKBACK_MS, now_ms
    elif start_ms is None:
        start_ms = max(0, end_ms - _EXPLORER_LOOKBACK_MS)
    elif end_ms is None:
        end_ms = start_ms + _EXPLORER_LOOKBACK_MS
    if start_ms > end_ms:
        # The old gateway rejected inverted ranges; a silent empty list here
        # could be misread as "the account had no fills".
        raise HTTPException(status_code=400, detail="startTime must not exceed endTime")
    rows = await _query_history_or_503(
        db.TRADES, symbol=sym, start_ms=start_ms, end_ms=end_ms, limit=cap
    )
    return _history_envelope(rows, len(rows) >= cap, db.TRADES)


@app.get("/api/account-info")
async def api_account_info(user: dict = Depends(current_user)):
    return await dma_client.get_account_info()


@app.get("/api/server-time")
async def api_server_time(user: dict = Depends(current_user)):
    return await dma_client.get_server_time()


@app.get("/api/tickers")
async def api_tickers(symbol: str | None = None, user: dict = Depends(current_user)):
    return await dma_client.get_tickers(_norm_symbol_opt(symbol))


@app.get("/api/orderbook")
async def api_orderbook(symbol: str, user: dict = Depends(current_user)):
    return await dma_client.get_orderbook(_require_symbol(symbol))


@app.get("/api/klines")
async def api_klines(
    symbol: str,
    interval: str,
    limit: str | None = None,
    user: dict = Depends(current_user),
):
    """Public OHLC candles for the dashboard charts. Read-only and isolated from
    the signed trading path: served by `market_data` (no API key, no signing),
    with the symbol/interval validated against a server-side whitelist. Requires
    a logged-in session like every other read endpoint."""
    return await market_data.get_kline(symbol, interval, limit)


# --------------------------------------------------------------------------
# Write API (admin only)
# --------------------------------------------------------------------------
@app.post("/api/order/create")
async def api_create_order(payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    symbol = payload.get("symbol")
    side = payload.get("side")
    order_type = payload.get("orderType")
    qty = payload.get("qty")
    if not symbol or not side or not order_type or qty is None:
        raise HTTPException(
            status_code=400, detail="symbol, side, orderType and qty are required"
        )
    symbol = str(symbol).upper()
    if not _valid_symbol(symbol):
        raise HTTPException(status_code=400, detail="symbol has an invalid format")
    if str(side).lower() not in ("buy", "sell"):
        raise HTTPException(status_code=400, detail="side must be Buy or Sell")
    if str(order_type).lower() not in ("market", "limit"):
        raise HTTPException(status_code=400, detail="orderType must be Market or Limit")
    if not _positive_finite(qty):
        raise HTTPException(status_code=400, detail="qty must be a finite number greater than 0")

    # Build the OUTBOUND body from an explicit ALLOWLIST — never forward the raw
    # client payload. Mass-assignment defense: a stray/forged field (closeOnTrigger,
    # orderLinkId, a client-chosen positionIdx, a truthy-string reduceOnly) must not
    # silently reach the exchange. Only these validated fields are sent.
    order: dict = {
        "symbol": symbol,
        "side": "Buy" if str(side).lower() == "buy" else "Sell",
        "orderType": "Limit" if str(order_type).lower() == "limit" else "Market",
        "qty": str(qty).strip(),
    }

    # positionIdx: one-way mode uses 0. Accept only 0/1/2; default to 0.
    try:
        pos_idx = int(payload.get("positionIdx", 0))
    except (TypeError, ValueError):
        pos_idx = 0
    order["positionIdx"] = pos_idx if pos_idx in (0, 1, 2) else 0

    if order["orderType"] == "Limit":
        price = payload.get("price")
        if not _positive_finite(price):
            raise HTTPException(
                status_code=400,
                detail="price must be a finite number greater than 0 for a Limit order",
            )
        order["price"] = str(price).strip()

    # reduceOnly must be a real bool (not a truthy string) before it can gate risk.
    reduce_only = bool(payload.get("reduceOnly"))

    # Optional TP/SL attached at order creation.
    take_profit = payload.get("takeProfit")
    stop_loss = payload.get("stopLoss")
    has_tpsl = take_profit not in (None, "") or stop_loss not in (None, "")
    if has_tpsl and reduce_only:
        # Bybit rejects TP/SL combined with reduceOnly; catch it early.
        raise HTTPException(
            status_code=400,
            detail="takeProfit/stopLoss cannot be set on a reduce-only order",
        )
    for name, value in (("takeProfit", take_profit), ("stopLoss", stop_loss)):
        if value in (None, ""):
            continue
        if not _positive_finite(value):
            raise HTTPException(
                status_code=400, detail=f"{name} must be a finite number greater than 0"
            )
        order[name] = str(value).strip()

    if reduce_only:
        order["reduceOnly"] = True

    return await dma_client.create_order(order)


@app.post("/api/order/cancel")
async def api_cancel_order(payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    symbol = payload.get("symbol")
    order_id = payload.get("orderId")
    if not symbol or not order_id:
        raise HTTPException(status_code=400, detail="symbol and orderId are required")
    return await dma_client.cancel_order(_require_symbol(symbol), order_id)


@app.post("/api/order/cancel-all")
async def api_cancel_all(payload: dict = Body(default={}), user: dict = Depends(require_trade_token)):
    symbol = _norm_symbol_opt((payload or {}).get("symbol"))
    return await dma_client.cancel_all(symbol)


@app.post("/api/position/set-leverage")
async def api_set_leverage(payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    symbol = payload.get("symbol")
    buy = payload.get("buyLeverage")
    sell = payload.get("sellLeverage", buy)
    if not symbol or buy is None:
        raise HTTPException(status_code=400, detail="symbol and buyLeverage are required")
    symbol = str(symbol).upper()
    if not _valid_symbol(symbol):
        raise HTTPException(status_code=400, detail="symbol has an invalid format")
    for name, value in (("buyLeverage", buy), ("sellLeverage", sell)):
        if not _positive_finite(value):
            raise HTTPException(
                status_code=400, detail=f"{name} must be a finite number greater than 0"
            )
    return await dma_client.set_leverage(symbol, buy, sell)


async def _resolve_open_position(symbol, req_idx=None) -> dict:
    """Return the single LIVE open position for a symbol (optionally a specific
    positionIdx). Raises HTTPException(400) if none or ambiguous.

    Callers use the returned authoritative positionIdx/side/size — never the
    client's — so a stale or forged request can't target the wrong leg.
    """
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")
    positions = _extract_list(await dma_client.get_positions())
    matches = [
        p
        for p in positions
        if str(p.get("symbol", "")).upper() == str(symbol).upper()
        and _safe_float(p.get("size")) > 0
    ]
    if req_idx is not None:
        matches = [p for p in matches if str(p.get("positionIdx")) == str(req_idx)]
    if not matches:
        raise HTTPException(status_code=400, detail=f"No open position found for {symbol}")
    if len(matches) > 1:
        raise HTTPException(
            status_code=400,
            detail=f"Multiple open positions for {symbol}; specify positionIdx",
        )
    return matches[0]


@app.post("/api/position/close")
async def api_close_position(payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    """Close a position with a reduce-only market order in the opposite side.

    The side / size / positionIdx are re-derived from the LIVE exchange
    position — never trusted from the client — so a stale or forged request
    can't close the wrong size or side. reduceOnly guarantees this can only
    ever reduce, never open or flip, a position.
    """
    pos = await _resolve_open_position(payload.get("symbol"), payload.get("positionIdx"))
    size = _safe_float(pos.get("size"))
    side = str(pos.get("side", ""))
    if size <= 0 or side.lower() not in ("buy", "sell"):
        raise HTTPException(status_code=400, detail="Position has no closable size")

    order = {
        "symbol": pos.get("symbol"),
        "side": "Sell" if side.lower() == "buy" else "Buy",
        "orderType": "Market",
        # Echo back the exchange's own size string (validated >0 above),
        # stripped of stray whitespace — avoids any reformatting drift.
        "qty": str(pos.get("size")).strip(),
        "reduceOnly": True,
        "positionIdx": pos.get("positionIdx", 0),
    }
    return await dma_client.create_order(order)


@app.post("/api/position/trading-stop")
async def api_trading_stop(payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    """Set or cancel TP/SL on an existing position (Full mode, market exit).

    positionIdx is re-derived from the LIVE position so the stop always attaches
    to the correct leg (critical in hedge mode). A value of "0" cancels that
    leg; at least one of takeProfit/stopLoss must be supplied.
    """
    take_profit = payload.get("takeProfit")
    stop_loss = payload.get("stopLoss")

    def _validate(name, value):
        # Empty/None => not supplied (leave that leg untouched). "0" => cancel.
        if value in (None, ""):
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{name} must be a number")
        if not math.isfinite(number):
            raise HTTPException(status_code=400, detail=f"{name} must be a finite number")
        if number < 0:
            raise HTTPException(status_code=400, detail=f"{name} must be >= 0 (0 cancels)")
        return str(value).strip()

    tp = _validate("takeProfit", take_profit)
    sl = _validate("stopLoss", stop_loss)
    if tp is None and sl is None:
        raise HTTPException(
            status_code=400, detail="at least one of takeProfit or stopLoss is required"
        )

    # Validate the trigger source (allowlist, like every other write field) BEFORE
    # the upstream position lookup, so a bad value fails fast without a wasted
    # round-trip and can never be forwarded to silently no-op the stop.
    trigger_by = payload.get("triggerBy")
    if trigger_by and str(trigger_by) not in ("LastPrice", "MarkPrice", "IndexPrice"):
        raise HTTPException(
            status_code=400, detail="triggerBy must be LastPrice, MarkPrice or IndexPrice"
        )

    pos = await _resolve_open_position(payload.get("symbol"), payload.get("positionIdx"))

    body = {
        "symbol": pos.get("symbol"),
        "tpslMode": "Full",
        "positionIdx": pos.get("positionIdx", 0),
    }
    if tp is not None:
        body["takeProfit"] = tp
    if sl is not None:
        body["stopLoss"] = sl
    if trigger_by:  # already allowlist-validated above
        body["tpTriggerBy"] = trigger_by
        body["slTriggerBy"] = trigger_by
    return await dma_client.set_trading_stop(body)


@app.post("/api/account/set-margin-mode")
async def api_set_margin_mode(payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    mode = payload.get("setMarginMode") or payload.get("mode")
    if not mode:
        raise HTTPException(status_code=400, detail="setMarginMode is required")
    # Allowlist the mode like every other write field (side/orderType/direction).
    # Small fixed domain, so a forged/garbled value is rejected locally with a
    # clean 400 instead of being forwarded for the exchange to reject.
    mode = str(mode).upper()
    if mode not in ("ISOLATED_MARGIN", "REGULAR_MARGIN", "PORTFOLIO_MARGIN"):
        raise HTTPException(
            status_code=400,
            detail="setMarginMode must be ISOLATED_MARGIN, REGULAR_MARGIN or PORTFOLIO_MARGIN",
        )
    return await dma_client.set_margin_mode(mode)


@app.post("/api/funds/transfer")
async def api_transfer_funds(payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    direction = payload.get("direction")
    amount = payload.get("amount")
    quote_asset = payload.get("quote_asset") or payload.get("quoteAsset")
    client_txn_id = payload.get("client_txn_id")
    if not direction or amount is None or not quote_asset:
        raise HTTPException(
            status_code=400, detail="direction, amount and quote_asset are required"
        )
    # Idempotency is MANDATORY on the money-movement path. The client owns a stable
    # id per transfer intent so a retry after a local timeout is a no-op at the
    # exchange (the dedup key is unchanged) instead of a second, real transfer.
    if not isinstance(client_txn_id, str) or not client_txn_id.strip():
        raise HTTPException(status_code=400, detail="client_txn_id is required for a transfer")
    if str(direction).upper() not in ("IN", "OUT"):
        raise HTTPException(status_code=400, detail="direction must be IN or OUT")
    if not _positive_finite(amount):
        raise HTTPException(status_code=400, detail="amount must be a finite number greater than 0")
    return await dma_client.transfer_funds(
        str(direction).upper(), amount, quote_asset, client_txn_id.strip()
    )


# --------------------------------------------------------------------------
# DMA error handling
# --------------------------------------------------------------------------
@app.exception_handler(dma_client.DMAError)
async def dma_error_handler(request: Request, exc: dma_client.DMAError):
    # Never let an UPSTREAM auth error (coinswitch 401/403 — e.g. a bad API
    # key) reach the browser as 401/403. Those codes have local meaning here:
    # the frontend treats 401 as "session expired" and would wrongly redirect
    # a logged-in user to /login. Remap upstream auth failures to 502 so they
    # are clearly "exchange rejected the request", not "you are logged out".
    status = exc.status
    if status in (401, 403):
        status = 502
    # Do not forward the full upstream envelope to the browser — it can carry
    # reflected params, request ids and internal diagnostics. Surface only a
    # concise message; log the full detail server-side for debugging.
    detail = exc.detail
    if isinstance(detail, dict):
        message = (
            detail.get("retMsg")
            or detail.get("message")
            or detail.get("error")
            or "The exchange rejected the request"
        )
        logger.warning("upstream DMA error %s: %s", exc.status, detail)
    else:
        message = str(detail)
    return JSONResponse(status_code=status, content={"error": message})


@app.exception_handler(market_data.MarketDataError)
async def market_data_error_handler(request: Request, exc: market_data.MarketDataError):
    # Read-only public-data errors. Never remapped to 401/403 (those would make
    # the frontend think the session expired); validation failures are 400 and
    # upstream issues are 502, both safe for the browser to see.
    return JSONResponse(status_code=exc.status, content={"error": exc.detail})


# --------------------------------------------------------------------------
# WebSocket live feed
# --------------------------------------------------------------------------
def _ws_origin_ok(websocket: WebSocket) -> bool:
    """Reject cross-origin WebSocket handshakes (defense in depth)."""
    origin = websocket.headers.get("origin")
    if not origin:
        return True  # non-browser client; still needs a valid session cookie
    return urlparse(origin).netloc == websocket.headers.get("host", "")


@app.websocket("/ws")
async def ws_feed(websocket: WebSocket):
    if not _ws_origin_ok(websocket):
        await websocket.close(code=1008)
        return
    token = websocket.cookies.get(auth.COOKIE_NAME)
    user = auth.verify_session_token(token)
    if not user or not auth.is_active_session(user.get("r"), user.get("sid")):
        await websocket.close(code=1008)
        return

    await websocket.accept()
    try:
        while True:
            # If this session was superseded by a newer same-role login, close
            # with 1008 so the (now evicted) tab redirects itself to /login.
            if not auth.is_active_session(user.get("r"), user.get("sid")):
                await websocket.close(code=1008)
                return
            try:
                data = await build_dashboard()
            except dma_client.DMAError as exc:
                data = {"type": "error", "error": str(exc.detail)}
            except Exception as exc:  # defensive: keep the socket alive
                logger.exception("dashboard build failed")
                data = {"type": "error", "error": str(exc)}
            # Re-check RIGHT BEFORE sending: build_dashboard can take up to ~20s,
            # and the session may have been evicted in that window — don't push a
            # final account-data frame to an already-superseded socket.
            if not auth.is_active_session(user.get("r"), user.get("sid")):
                await websocket.close(code=1008)
                return
            await websocket.send_json(data)
            await asyncio.sleep(settings.POLL_INTERVAL)
    except WebSocketDisconnect:
        return
    except RuntimeError as exc:
        # A client that vanishes WHILE a send is in flight surfaces as a
        # RuntimeError ("Cannot call send once a close message has been sent"),
        # not WebSocketDisconnect — a normal disconnect, not a server fault. A
        # genuine RuntimeError from build_dashboard is already caught inside the
        # loop, so this is the send-side close: return quietly (debug only) so it
        # doesn't spam stderr as a red "error" on every abrupt tab close.
        logger.debug("websocket closed during send: %s", exc)
        return
    except Exception:
        logger.exception("websocket loop error")
        try:
            await websocket.close()
        except Exception:
            pass


class NoCacheStaticFiles(StaticFiles):
    """Serve static assets with Cache-Control: no-cache so browsers always
    revalidate. The server still returns 304 when the file is unchanged (cheap),
    but immediately after a deploy the browser fetches the new app.js/styles.css
    instead of pairing fresh HTML with a stale cached script.
    """

    def file_response(self, *args, **kwargs) -> StarletteResponse:
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


# Static assets (css/js). Mounted last so it doesn't shadow API routes.
app.mount("/static", NoCacheStaticFiles(directory=STATIC_DIR), name="static")
