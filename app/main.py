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
import sys
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
from pathlib import Path

from . import auth, dma_client
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
    yield
    # Cleanly close the shared upstream HTTP client on shutdown.
    await dma_client.aclose()


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


# --------------------------------------------------------------------------
# Auth dependencies
# --------------------------------------------------------------------------
def current_user(request: Request) -> dict:
    token = request.cookies.get(auth.COOKIE_NAME)
    user = auth.verify_session_token(token)
    if not user:
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


def _extract_list(payload) -> list:
    if isinstance(payload, dict):
        result = payload.get("result")
        if isinstance(result, dict) and isinstance(result.get("list"), list):
            return result["list"]
    return []


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

    return {
        "type": "dashboard",
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


# --------------------------------------------------------------------------
# Page routes
# --------------------------------------------------------------------------
@app.get("/login")
def login_page():
    return FileResponse(STATIC_DIR / "login.html")


@app.get("/")
def index(request: Request):
    token = request.cookies.get(auth.COOKIE_NAME)
    if not auth.verify_session_token(token):
        return RedirectResponse(url="/login", status_code=302)
    return FileResponse(STATIC_DIR / "index.html")


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
def api_login(payload: dict = Body(...)):
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    role = auth.authenticate(username, password)
    if not role:
        raise HTTPException(status_code=401, detail="Invalid username or password")

    token = auth.create_session_token(username, role)
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
def api_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE_NAME)
    return resp


@app.get("/api/me")
def api_me(user: dict = Depends(current_user)):
    return {"username": user.get("u"), "role": user.get("r")}


# --------------------------------------------------------------------------
# Read API (any logged-in user)
# --------------------------------------------------------------------------
@app.get("/api/dashboard")
async def api_dashboard(user: dict = Depends(current_user)):
    return await build_dashboard()


@app.get("/api/positions")
async def api_positions(user: dict = Depends(current_user)):
    return await dma_client.get_positions()


@app.get("/api/orders")
async def api_orders(user: dict = Depends(current_user)):
    return await dma_client.get_open_orders()


@app.get("/api/balance")
async def api_balance(user: dict = Depends(current_user)):
    return await dma_client.get_wallet_balance()


@app.get("/api/instruments")
async def api_instruments(symbol: str | None = None, user: dict = Depends(current_user)):
    return await dma_client.get_instruments(symbol)


@app.get("/api/closed-pnl")
async def api_closed_pnl(symbol: str | None = None, user: dict = Depends(current_user)):
    return await dma_client.get_closed_pnl(symbol)


@app.get("/api/withdrawable")
async def api_withdrawable(coin: str | None = None, user: dict = Depends(current_user)):
    return await dma_client.get_withdrawable(coin)


@app.get("/api/executions")
async def api_executions(
    symbol: str | None = None,
    limit: str | None = None,
    startTime: str | None = None,
    endTime: str | None = None,
    user: dict = Depends(current_user),
):
    return await dma_client.get_executions(symbol, limit, startTime, endTime)


@app.get("/api/account-info")
async def api_account_info(user: dict = Depends(current_user)):
    return await dma_client.get_account_info()


@app.get("/api/server-time")
async def api_server_time(user: dict = Depends(current_user)):
    return await dma_client.get_server_time()


@app.get("/api/tickers")
async def api_tickers(symbol: str | None = None, user: dict = Depends(current_user)):
    return await dma_client.get_tickers(symbol)


@app.get("/api/orderbook")
async def api_orderbook(symbol: str, user: dict = Depends(current_user)):
    return await dma_client.get_orderbook(symbol)


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
    if str(side).lower() not in ("buy", "sell"):
        raise HTTPException(status_code=400, detail="side must be Buy or Sell")
    try:
        if float(qty) <= 0:
            raise ValueError
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="qty must be a number greater than 0")
    if str(order_type).lower() == "limit":
        price = payload.get("price")
        try:
            if price is None or float(price) <= 0:
                raise ValueError
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=400, detail="price must be greater than 0 for a Limit order"
            )
    return await dma_client.create_order(payload)


@app.post("/api/order/cancel")
async def api_cancel_order(payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    symbol = payload.get("symbol")
    order_id = payload.get("orderId")
    if not symbol or not order_id:
        raise HTTPException(status_code=400, detail="symbol and orderId are required")
    return await dma_client.cancel_order(symbol, order_id)


@app.post("/api/order/cancel-all")
async def api_cancel_all(payload: dict = Body(default={}), user: dict = Depends(require_trade_token)):
    symbol = (payload or {}).get("symbol")
    return await dma_client.cancel_all(symbol)


@app.post("/api/position/set-leverage")
async def api_set_leverage(payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    symbol = payload.get("symbol")
    buy = payload.get("buyLeverage")
    sell = payload.get("sellLeverage", buy)
    if not symbol or buy is None:
        raise HTTPException(status_code=400, detail="symbol and buyLeverage are required")
    return await dma_client.set_leverage(symbol, buy, sell)


@app.post("/api/position/close")
async def api_close_position(payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    """Close a position with a reduce-only market order in the opposite side.

    The side / size / positionIdx are re-derived from the LIVE exchange
    position — never trusted from the client — so a stale or forged request
    can't close the wrong size or side. reduceOnly guarantees this can only
    ever reduce, never open or flip, a position.
    """
    symbol = payload.get("symbol")
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")

    req_idx = payload.get("positionIdx")
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

    pos = matches[0]
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


@app.post("/api/account/set-margin-mode")
async def api_set_margin_mode(payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    mode = payload.get("setMarginMode") or payload.get("mode")
    if not mode:
        raise HTTPException(status_code=400, detail="setMarginMode is required")
    return await dma_client.set_margin_mode(mode)


@app.post("/api/funds/transfer")
async def api_transfer_funds(payload: dict = Body(...), user: dict = Depends(require_trade_token)):
    direction = payload.get("direction")
    amount = payload.get("amount")
    quote_asset = payload.get("quote_asset") or payload.get("quoteAsset")
    if not direction or amount is None or not quote_asset:
        raise HTTPException(
            status_code=400, detail="direction, amount and quote_asset are required"
        )
    if str(direction).upper() not in ("IN", "OUT"):
        raise HTTPException(status_code=400, detail="direction must be IN or OUT")
    try:
        amount_val = float(amount)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="amount must be a number")
    if amount_val <= 0:
        raise HTTPException(status_code=400, detail="amount must be greater than 0")
    return await dma_client.transfer_funds(
        str(direction).upper(), amount, quote_asset, payload.get("client_txn_id")
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
    return JSONResponse(status_code=status, content={"error": exc.detail})


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
    if not user:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    try:
        while True:
            try:
                data = await build_dashboard()
            except dma_client.DMAError as exc:
                data = {"type": "error", "error": str(exc.detail)}
            except Exception as exc:  # defensive: keep the socket alive
                logger.exception("dashboard build failed")
                data = {"type": "error", "error": str(exc)}
            await websocket.send_json(data)
            await asyncio.sleep(settings.POLL_INTERVAL)
    except WebSocketDisconnect:
        return
    except Exception:
        logger.exception("websocket loop error")
        try:
            await websocket.close()
        except Exception:
            pass


# Static assets (css/js). Mounted last so it doesn't shadow API routes.
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
