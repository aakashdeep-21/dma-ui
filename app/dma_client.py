"""Thin async client for the CoinSwitch DMA API.

Every call is signed server-side with the Ed25519 key from the environment;
the API key/secret never leave the backend. Convenience wrappers cover the
endpoints used by the dashboard and the trading panel.
"""
import json
import uuid

import httpx

from .config import settings
from .signer import build_signed_request


class DMAError(Exception):
    """Raised when the exchange returns an error or is unreachable."""

    def __init__(self, status: int, detail):
        self.status = status
        self.detail = detail
        super().__init__(f"DMA error {status}: {detail}")


# One shared async client reused across all calls (connection pooling / keep-alive)
# instead of a new client + TLS handshake per request. Closed on app shutdown.
# trust_env=False: ignore ambient HTTP(S)_PROXY / SSL_CERT_FILE env vars so a
# misconfigured or hostile environment can't reroute or re-anchor the SIGNED
# trading traffic through a proxy/MITM.
_client = httpx.AsyncClient(timeout=20, trust_env=False)


async def aclose() -> None:
    await _client.aclose()


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
        if method.upper() == "GET":
            resp = await _client.get(url, headers=headers)
        else:
            # Body is sent compact and is NOT part of the signature.
            # allow_nan=False: refuse to serialise NaN/Infinity (invalid JSON that
            # some parsers coerce to huge/zero numbers) into a money request — a
            # last-ditch guard behind the per-endpoint finite-number validation.
            try:
                content = json.dumps(body or {}, separators=(",", ":"), allow_nan=False)
            except ValueError as exc:
                raise DMAError(400, "request body contains a non-finite number") from exc
            resp = await _client.post(url, headers=headers, content=content)
    except httpx.HTTPError as exc:
        raise DMAError(502, f"upstream request failed: {exc}") from exc

    try:
        data = resp.json()
    except ValueError:
        data = {"raw": resp.text}

    if resp.status_code >= 400:
        raise DMAError(resp.status_code, data)

    # CRITICAL for a money app: the v5 DMA/Bybit API returns HTTP 200 with a
    # non-zero `retCode` for business-level rejections (insufficient balance,
    # qty below min, reduce-only would increase, position-idx mismatch, etc.).
    # Without this check those would be reported to the user as SUCCESS. We
    # only treat an EXPLICIT non-zero retCode as an error, so endpoints that
    # use a different envelope (e.g. the funds-transfer path) are unaffected.
    if isinstance(data, dict):
        ret_code = data.get("retCode")
        if ret_code not in (None, 0, "0"):
            detail = data.get("retMsg") or data
            raise DMAError(400, detail)
    return data


def extract_list(payload) -> list:
    """Dig the v5 `result.list` array out of a response envelope, else []."""
    if isinstance(payload, dict):
        result = payload.get("result")
        if isinstance(result, dict) and isinstance(result.get("list"), list):
            return result["list"]
    return []


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


async def get_withdrawable(coin: str | None = None):
    return await _request(
        "GET",
        "/v5/account/withdrawal",
        params={"coinName": coin or settings.SETTLE_COIN},
    )


async def get_executions(
    symbol: str | None = None,
    limit: str | None = None,
    start_time: str | None = None,
    end_time: str | None = None,
):
    """Trades / execution history."""
    params = {"category": settings.CATEGORY}
    if symbol:
        params["symbol"] = symbol
    if limit:
        params["limit"] = str(limit)
    if start_time:
        params["startTime"] = str(start_time)
    if end_time:
        params["endTime"] = str(end_time)
    return await _request("GET", "/v5/execution/list", params=params)


async def get_account_info():
    return await _request("GET", "/v5/account/info")


async def get_server_time():
    return await _request("GET", "/v5/market/time")


async def get_tickers(symbol: str | None = None):
    params = {"category": settings.CATEGORY}
    if symbol:
        params["symbol"] = symbol
    return await _request("GET", "/v5/market/tickers", params=params)


async def get_orderbook(symbol: str, limit: str | None = None):
    params = {"category": settings.CATEGORY, "symbol": symbol}
    if limit:
        params["limit"] = str(limit)
    return await _request("GET", "/v5/market/orderbook", params=params)


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


async def set_margin_mode(mode: str):
    return await _request(
        "POST", "/v5/account/set-margin-mode", body={"setMarginMode": mode}
    )


async def set_trading_stop(body: dict):
    """Passthrough to /v5/position/trading-stop (set/cancel TP/SL).

    This is a thin passthrough; the route layer owns the policy (tpslMode,
    re-derived positionIdx, validated takeProfit/stopLoss where "0" cancels)
    and builds the body. `category` is injected here.
    """
    payload = {"category": settings.CATEGORY, **body}
    return await _request("POST", "/v5/position/trading-stop", body=payload)


async def transfer_funds(direction: str, amount, quote_asset: str, client_txn_id: str | None = None):
    body = {
        "client_txn_id": client_txn_id or str(uuid.uuid4()),
        "direction": direction,
        "amount": amount,
        "quote_asset": quote_asset,
    }
    data = await _request("POST", "/dma/api/v1/funds/transfer", body=body)
    # This endpoint uses a non-v5 envelope (no retCode), so _request can't
    # auto-detect a business rejection. Conservatively flag common failure
    # shapes so a DECLINED transfer is never reported to the operator as
    # success. (Unknown success shapes still pass through — see the softened
    # "verify your balance" wording in the UI.)
    if isinstance(data, dict):
        if data.get("success") is False or data.get("error"):
            raise DMAError(400, data.get("error") or data.get("message") or data)
        status = str(data.get("status", "")).lower()
        if status in ("failed", "failure", "error", "rejected", "declined", "cancelled"):
            raise DMAError(400, data.get("message") or data.get("retMsg") or data)
    return data
