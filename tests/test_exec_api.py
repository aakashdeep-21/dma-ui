"""Execution-workspace backend touchpoints.

The workspace is almost entirely frontend (it rides the existing snapshot
feed and write endpoints); the one backend addition is the orderbook depth
parameter for the trading ladder, which must be validated locally so garbage
never reaches the signed upstream.
"""


def test_orderbook_depth_passthrough(admin_client, fake_upstream):
    fake_upstream["resp"]._data = {
        "retCode": 0,
        "result": {"s": "BTCUSDT", "b": [["100", "2"]], "a": [["101", "3"]]},
    }
    resp = admin_client.get("/api/orderbook?symbol=BTCUSDT&limit=50")
    assert resp.status_code == 200
    assert resp.json()["retCode"] == 0


def test_orderbook_depth_validation(admin_client, fake_upstream):
    assert admin_client.get("/api/orderbook?symbol=BTCUSDT&limit=0").status_code == 400
    assert admin_client.get("/api/orderbook?symbol=BTCUSDT&limit=201").status_code == 400
    assert admin_client.get("/api/orderbook?symbol=BTCUSDT&limit=soon").status_code == 400
    # No limit keeps the old behavior (upstream default).
    assert admin_client.get("/api/orderbook?symbol=BTCUSDT").status_code == 200
