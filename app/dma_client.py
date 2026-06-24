"""Thin async client for the CoinSwitch DMA API.

Every call is signed server-side with the Ed25519 key from the environment;
the API key/secret never leave the backend. Convenience wrappers cover the
endpoints used by the dashboard and the trading panel.
"""
import json

import httpx

from .config import settings
from .signer import build_signed_request


class DMAError(Exception):
    """Raised when the exchange returns an error or is unreachable."""

    def __init__(self, status: int, detail):
        self.status = status
        self.detail = detail
        super().__init__(f"DMA error {status}: {detail}")


async def _request(method: str, path: str, params: dict | None = None, body: dict | None = None):
    if not settings.DMA_API_SECRET or not settings.DMA_API_KEY:
        raise DMAError(500, "DMA_API_KEY / DMA_API_SECRET are not configured")

    signature, epoch, full_path = build_signed_request(
        method, path, settings.DMA_API_SECRET, params
    )
    url = settings.DMA_BASE_URL + full_path
    headers = {
        "Content-Type": "application/json",
        "X-AUTH-SIGNATURE": signature,
        "X-AUTH-APIKEY": settings.DMA_API_KEY,
        "X-AUTH-EPOCH": epoch,
    }

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            if method.upper() == "GET":
                resp = await client.get(url, headers=headers)
            else:
                # Body is sent compact and is NOT part of the signature.
                content = json.dumps(body or {}, separators=(",", ":"))
                resp = await client.post(url, headers=headers, content=content)
    except httpx.HTTPError as exc:
        raise DMAError(502, f"upstream request failed: {exc}") from exc

    try:
        data = resp.json()
    except ValueError:
        data = {"raw": resp.text}

    if resp.status_code >= 400:
        raise DMAError(resp.status_code, data)
    return data


# --- Read endpoints -------------------------------------------------------

async def get_positions():
    return await _request(
        "GET",
        "/v5/position/list",
        params={"category": settings.CATEGORY, "settleCoin": settings.SETTLE_COIN},
    )


async def get_open_orders():
    return await _request(
        "GET",
        "/v5/order/realtime",
        params={
            "category": settings.CATEGORY,
            "settleCoin": settings.SETTLE_COIN,
            "limit": "50",
        },
    )


async def get_wallet_balance():
    return await _request(
        "GET",
        "/v5/account/wallet-balance",
        params={"accountType": settings.ACCOUNT_TYPE, "coin": settings.SETTLE_COIN},
    )


async def get_instruments(symbol: str | None = None):
    params = {"category": settings.CATEGORY}
    if symbol:
        params["symbol"] = symbol
    return await _request("GET", "/v5/market/instruments-info", params=params)


async def get_closed_pnl(symbol: str | None = None):
    params = {"category": settings.CATEGORY}
    if symbol:
        params["symbol"] = symbol
    return await _request("GET", "/v5/position/closed-pnl", params=params)


# --- Write endpoints (admin only at the route layer) ----------------------

async def create_order(body: dict):
    payload = {"category": settings.CATEGORY, **body}
    return await _request("POST", "/v5/order/create", body=payload)


async def cancel_order(symbol: str, order_id: str):
    body = {"category": settings.CATEGORY, "symbol": symbol, "orderId": order_id}
    return await _request("POST", "/v5/order/cancel", body=body)


async def cancel_all(symbol: str | None = None):
    body = {"category": settings.CATEGORY, "settleCoin": settings.SETTLE_COIN}
    if symbol:
        body["symbol"] = symbol
    return await _request("POST", "/v5/order/cancel-all", body=body)


async def set_leverage(symbol: str, buy_leverage: str, sell_leverage: str):
    body = {
        "category": settings.CATEGORY,
        "symbol": symbol,
        "buyLeverage": str(buy_leverage),
        "sellLeverage": str(sell_leverage),
    }
    return await _request("POST", "/v5/position/set-leverage", body=body)
