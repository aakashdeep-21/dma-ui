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
