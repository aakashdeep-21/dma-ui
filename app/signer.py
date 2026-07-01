"""Ed25519 request signing for the CoinSwitch DMA API.

Ported from the original sign_server.py `/dma-sign` endpoint. The signed
message is:

    method + path(+querystring) + epoch_ms

signed with the account's Ed25519 secret key (hex). The signature, the epoch
and the resulting full path are returned so the HTTP client can send exactly
the same path it signed (this is the invariant the exchange validates against).

Note: for POST requests the request body is intentionally NOT part of the
signature, matching the exchange's scheme and the original sign_server.
"""
import time
from urllib.parse import urlencode, unquote_plus

from nacl.signing import SigningKey


def _epoch_ms() -> str:
    return str(int(time.time() * 1000))


def secret_is_valid_ed25519_hex(secret_key_hex: str) -> bool:
    """Return True iff `secret_key_hex` is a usable Ed25519 seed.

    Called at startup so a malformed DMA_API_SECRET fails the deploy loudly
    instead of surfacing as an unhandled 500 on the FIRST signed request (which
    would look like an exchange outage mid-trade). Never logs the key.
    """
    try:
        SigningKey(bytes.fromhex(secret_key_hex))
        return True
    except (ValueError, TypeError):
        return False


def build_signed_request(
    method: str,
    path: str,
    secret_key_hex: str,
    params: dict | None = None,
) -> tuple[str, str, str]:
    """Build a signed DMA request.

    Args:
        method: HTTP method, e.g. "GET" or "POST".
        path: API path beginning with "/", e.g. "/v5/position/list".
        secret_key_hex: Ed25519 private key as a hex string (DMA_API_SECRET).
        params: query params for GET requests.

    Returns:
        (signature_hex, epoch_ms, full_path) where full_path is the path that
        must actually be requested (path + encoded query string).
    """
    method = method.upper()
    full_path = path
    if method == "GET" and params:
        query = urlencode(params)
        connector = "&" if "?" in path else "?"
        full_path = path + connector + query

    # The exchange validates against the URL-decoded path, matching the
    # original sign_server (which applied unquote_plus before signing).
    sign_path = unquote_plus(full_path)
    epoch = _epoch_ms()
    message = method + sign_path + epoch

    signing_key = SigningKey(bytes.fromhex(secret_key_hex))
    signature = signing_key.sign(message.encode("utf-8")).signature.hex()
    return signature, epoch, full_path
