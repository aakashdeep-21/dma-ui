"""dma_client._request money-safety invariants."""
import asyncio
import json

import pytest

from app import dma_client


class _Resp:
    def __init__(self, status, data):
        self.status_code = status
        self._data = data
        self.text = json.dumps(data)

    def json(self):
        return self._data


def _resp(status, data):
    return _Resp(status, data)


def test_http_200_with_nonzero_retcode_is_an_error(fake_upstream):
    # The exchange returns HTTP 200 with retCode!=0 for business rejections
    # (insufficient balance, qty below min, ...). These MUST raise, never be
    # reported as success.
    fake_upstream["resp"] = _resp(200, {"retCode": 110007, "retMsg": "insufficient balance"})
    with pytest.raises(dma_client.DMAError) as ei:
        asyncio.run(dma_client.get_positions())
    assert "insufficient balance" in str(ei.value.detail)


def test_retcode_zero_passes_through(fake_upstream):
    fake_upstream["resp"] = _resp(200, {"retCode": 0, "result": {"list": []}})
    data = asyncio.run(dma_client.get_positions())
    assert data["retCode"] == 0


def test_non_finite_number_never_serialised_to_money_path(fake_upstream):
    # allow_nan=False backstop: a NaN/Infinity in a write body raises instead of
    # emitting invalid JSON (which some parsers coerce to a huge/zero number).
    with pytest.raises(dma_client.DMAError) as ei:
        asyncio.run(dma_client.create_order({"symbol": "BTCUSDT", "qty": float("inf")}))
    assert ei.value.status == 400
    assert fake_upstream["post_body"] is None  # never reached the network


# ---- transfer failure detection (substring stems, not an exact blocklist) ----

# The real success envelope (captured from a live DMA transfer):
#   {"data": {..., "txn_id": "<uuid>"}, "message": "transfer successful"}
_REAL_SUCCESS = {
    "data": {
        "amount": 1,
        "client_txn_id": "85326c01-6643-47dd-a9b1-b49966ba1513",
        "direction": "OUT",
        "quote_asset": "INR",
        "txn_id": "019f238c-816c-7255-bafb-d395503de886",
    },
    "message": "transfer successful",
}


def test_transfer_real_success_response_confirmed(fake_upstream):
    # The exact live response must be accepted (txn_id present).
    fake_upstream["resp"] = _resp(200, _REAL_SUCCESS)
    data = asyncio.run(dma_client.transfer_funds("OUT", 1, "INR", "85326c01-6643-47dd-a9b1-b49966ba1513"))
    assert data["data"]["txn_id"] == "019f238c-816c-7255-bafb-d395503de886"


def test_transfer_confirmed_by_success_bool(fake_upstream):
    fake_upstream["resp"] = _resp(200, {"success": True, "message": "ok"})
    assert asyncio.run(dma_client.transfer_funds("OUT", "1", "INR", "txn-ok2"))["success"] is True


@pytest.mark.parametrize(
    "status",
    ["failed", "FAILURE", "error", "Rejected", "declined", "cancelled",
     "insufficient_balance", "DENIED", "invalid_amount", "processing_failed", "refused"],
)
def test_transfer_failure_statuses_raise(fake_upstream, status):
    fake_upstream["resp"] = _resp(200, {"status": status, "message": "nope"})
    with pytest.raises(dma_client.DMAError):
        asyncio.run(dma_client.transfer_funds("OUT", "10", "USDT", "txn-fail"))


def test_transfer_explicit_error_field_raises(fake_upstream):
    fake_upstream["resp"] = _resp(200, {"success": False, "error": "bad request"})
    with pytest.raises(dma_client.DMAError):
        asyncio.run(dma_client.transfer_funds("OUT", "10", "USDT", "txn-err"))


def test_transfer_unsuccessful_message_raises(fake_upstream):
    # "transfer unsuccessful" contains "success" — the "unsuccess" failure stem must
    # catch it BEFORE any positive check, so it can never read as a success.
    fake_upstream["resp"] = _resp(200, {"data": {}, "message": "transfer unsuccessful"})
    with pytest.raises(dma_client.DMAError):
        asyncio.run(dma_client.transfer_funds("OUT", "1", "INR", "txn-uns"))


@pytest.mark.parametrize("body", [{"status": "pending"}, {"status": "processing"}, {}, {"message": "queued"}])
def test_transfer_unconfirmed_raises(fake_upstream, body):
    # No txn_id, no explicit success, no failure signal -> INDETERMINATE. On a money
    # move this must RAISE (operator verifies), never be reported as completed.
    fake_upstream["resp"] = _resp(200, body)
    with pytest.raises(dma_client.DMAError):
        asyncio.run(dma_client.transfer_funds("OUT", "1", "INR", "txn-ind"))
