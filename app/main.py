"""FastAPI application: serves the trading UI, proxies signed DMA calls, and
streams a live positions/orders/PnL feed over a WebSocket.

Security model:
  * API key/secret live only in the backend (env vars) and are used to sign
    every upstream request. The browser never sees them.
  * Two login roles: 'admin' may trade; 'viewer' is read-only.
  * All write endpoints require the admin role.
"""
import asyncio
import logging

from fastapi import (
    Body,
    Cookie,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from . import auth, dma_client
from .config import settings

logger = logging.getLogger("dma-ui")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="DMA Trading UI")

STATIC_DIR = Path(__file__).resolve().parent / "static"


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


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _safe_float(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


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
    return {"status": "ok", "configured": not missing, "missing": missing}


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


# --------------------------------------------------------------------------
# Write API (admin only)
# --------------------------------------------------------------------------
@app.post("/api/order/create")
async def api_create_order(payload: dict = Body(...), user: dict = Depends(require_admin)):
    return await dma_client.create_order(payload)


@app.post("/api/order/cancel")
async def api_cancel_order(payload: dict = Body(...), user: dict = Depends(require_admin)):
    symbol = payload.get("symbol")
    order_id = payload.get("orderId")
    if not symbol or not order_id:
        raise HTTPException(status_code=400, detail="symbol and orderId are required")
    return await dma_client.cancel_order(symbol, order_id)


@app.post("/api/order/cancel-all")
async def api_cancel_all(payload: dict = Body(default={}), user: dict = Depends(require_admin)):
    symbol = (payload or {}).get("symbol")
    return await dma_client.cancel_all(symbol)


@app.post("/api/position/set-leverage")
async def api_set_leverage(payload: dict = Body(...), user: dict = Depends(require_admin)):
    symbol = payload.get("symbol")
    buy = payload.get("buyLeverage")
    sell = payload.get("sellLeverage", buy)
    if not symbol or buy is None:
        raise HTTPException(status_code=400, detail="symbol and buyLeverage are required")
    return await dma_client.set_leverage(symbol, buy, sell)


@app.post("/api/position/close")
async def api_close_position(payload: dict = Body(...), user: dict = Depends(require_admin)):
    """Close a position with a reduce-only market order in the opposite side."""
    symbol = payload.get("symbol")
    side = payload.get("side")  # current position side: Buy / Sell
    qty = payload.get("qty")
    if not symbol or not side or not qty:
        raise HTTPException(status_code=400, detail="symbol, side and qty are required")
    close_side = "Sell" if str(side).lower() == "buy" else "Buy"
    order = {
        "symbol": symbol,
        "side": close_side,
        "orderType": "Market",
        "qty": str(qty),
        "reduceOnly": True,
        "positionIdx": payload.get("positionIdx", 0),
    }
    return await dma_client.create_order(order)


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
@app.websocket("/ws")
async def ws_feed(websocket: WebSocket):
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
