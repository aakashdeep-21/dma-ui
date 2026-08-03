"""Serialization + deterministic intelligence engine (app/ai_context.py).

The serializers are the AI layer's privacy boundary: everything is built from
explicit allowlists, so these tests inject hostile/extra fields and assert
they can never reach a provider. The analytics are pure functions tested on
synthetic trade sets with known answers.
"""
import json
from datetime import datetime

from app import ai_context

BASE_MS = 1_750_000_000_000


def _row(i=0, *, pnl="10", side="Sell", symbol="BTCUSDT", qty="1",
         entry="100", exit_px="110", hold_min=60, closed_ms=None, **extra):
    closed = closed_ms if closed_ms is not None else BASE_MS + i * 3_600_000
    return {
        "orderId": f"ord{i}", "symbol": symbol, "side": side, "qty": qty,
        "avgEntryPrice": entry, "avgExitPrice": exit_px, "closedPnl": pnl,
        "leverage": "10", "createdTime": str(closed - hold_min * 60000),
        "updatedTime": str(closed), **extra,
    }


def _trades(rows, entries=None):
    return ai_context.build_trades(rows, entries or [])


# --------------------------------------------------------------------------
# Serialization / privacy boundary
# --------------------------------------------------------------------------
def test_serializer_is_a_strict_allowlist():
    hostile = _row(
        0,
        apiKey="LEAKED-KEY", secret="LEAKED-SECRET", cookie="LEAKED-COOKIE",
        sessionToken="LEAKED-TOKEN", execId="exec-123", accountId="acct-9",
    )
    trade = ai_context.serialize_trade(hostile)
    dumped = json.dumps(trade)
    for needle in ("LEAKED", "apiKey", "secret", "cookie", "sessionToken",
                   "orderId", "ord0", "execId", "accountId"):
        assert needle not in dumped, f"{needle} escaped the allowlist"
    # And what IS there is typed, not raw strings.
    assert trade["pnl"] == 10.0
    assert trade["direction"] == "long", "a Sell close means the position was long"
    assert trade["holdMinutes"] == 60.0
    assert trade["notional"] == 100.0


def test_serialize_trade_tolerates_garbage_numbers():
    t = ai_context.serialize_trade(_row(0, pnl="nan", qty="inf", entry="junk"))
    assert t["pnl"] == 0.0 and t["qty"] is None and t["entryPrice"] is None


def test_serialize_trade_requires_a_close_time():
    assert ai_context.serialize_trade({"symbol": "BTCUSDT", "closedPnl": "5"}) is None


def test_journal_serializer_excerpts_and_allowlists():
    entry = {
        "id": "ord0:123", "strategy": "Momentum", "tags": ["Breakout"],
        "mistakes": ["Late Entry"], "confidence": 4, "rating": True,  # bool must not pass as score
        "notes": "x" * 5000, "aiReview": {"text": "internal"}, "createdAtMs": 1,
    }
    j = ai_context.serialize_journal_entry(entry)
    assert len(j["notes"]) <= ai_context.NOTES_EXCERPT_LEN + 1
    assert j["confidence"] == 4 and j["rating"] is None
    assert "aiReview" not in json.dumps(j) and "createdAtMs" not in json.dumps(j)


def test_account_and_position_serializers():
    balance = {"result": {"list": [{
        "totalEquity": "1000", "totalAvailableBalance": "800",
        "totalInitialMargin": "100", "totalMaintenanceMargin": "20",
        "totalMarginBalance": "1000", "totalPerpUPL": "5",
        "accountLSKey": "SHOULD-NOT-LEAK",
    }]}}
    acct = ai_context.serialize_account(balance)
    assert acct["marginUtilPct"] == 10.0
    assert "SHOULD-NOT-LEAK" not in json.dumps(acct)

    pos = ai_context.serialize_position({
        "symbol": "BTCUSDT", "side": "Buy", "size": "1", "positionValue": "50000",
        "leverage": "10", "markPrice": "100000", "liqPrice": "90000",
        "unrealisedPnl": "12.5", "positionIdx": 0, "bustPrice": "hidden",
    })
    assert pos["liqDistancePct"] == 10.0
    assert "bustPrice" not in json.dumps(pos) and "positionIdx" not in json.dumps(pos)


def test_build_trades_joins_journal_then_discards_the_key():
    rows = [_row(0), _row(1, pnl="-5")]
    entries = [{"id": f"ord0:{rows[0]['updatedTime']}", "strategy": "VWAP", "tags": ["A"]}]
    trades = _trades(rows, entries)
    assert len(trades) == 2
    joined = next(t for t in trades if t.get("journal"))
    assert joined["journal"]["strategy"] == "VWAP"
    assert "ord0" not in json.dumps(trades)


# --------------------------------------------------------------------------
# Analytics on synthetic data with known answers
# --------------------------------------------------------------------------
def test_overall_stats():
    trades = _trades([_row(0, pnl="10"), _row(1, pnl="20"), _row(2, pnl="-15")])
    s = ai_context.overall_stats(trades)
    assert s["trades"] == 3 and s["wins"] == 2 and s["losses"] == 1
    assert s["netPnl"] == 15.0 and s["profitFactor"] == 2.0
    assert s["winRatePct"] == 66.7
    assert s["avgWin"] == 15.0 and s["avgLoss"] == 15.0


def test_streaks_and_drawdown():
    pnls = ["10", "-5", "-5", "-5", "20", "20"]
    trades = _trades([_row(i, pnl=p) for i, p in enumerate(pnls)])
    st = ai_context.streaks(trades)
    assert st == {"longestWin": 2, "longestLoss": 3, "current": 2}
    dd = ai_context.drawdown(trades)
    assert dd["maxDrawdown"] == 15.0  # peak 10 → trough -5


def test_weekday_breakdown_uses_local_weekday():
    trades = _trades([_row(0)])
    label = ai_context.by_weekday(trades)[0]["label"]
    expected = ai_context.WEEKDAYS[datetime.fromtimestamp(trades[0]["closedMs"] / 1000).weekday()]
    assert label == expected


def test_weekday_and_hour_follow_the_trader_timezone():
    # 2026-08-03 22:30 UTC is a Monday; +330 min (IST) makes it Tuesday 04:00.
    ms = 1_785_536_200_000
    utc = ai_context.local_dt(ms, 0)
    trades = _trades([_row(0, closed_ms=ms)])
    utc_label = ai_context.by_weekday(trades, 0)[0]["label"]
    ist_label = ai_context.by_weekday(trades, 330)[0]["label"]
    ist = ai_context.local_dt(ms, 330)
    assert ist_label == ai_context.WEEKDAYS[ist.weekday()]
    if utc.weekday() != ist.weekday():
        assert utc_label != ist_label
    ist_bucket = ai_context.by_hour_bucket(trades, 330)[0]["label"]
    assert any(lo <= ist.hour < hi for label, lo, hi in ai_context.HOUR_BUCKETS
               if label == ist_bucket)


def test_revenge_trading_detection():
    loss = _row(0, pnl="-50", qty="1", closed_ms=BASE_MS)
    # Re-entry 5 min later on the SAME symbol at DOUBLE size (opens 5m after the loss).
    revenge = _row(1, pnl="-20", qty="2", closed_ms=BASE_MS + 35 * 60000, hold_min=30)
    unrelated = _row(2, pnl="5", symbol="ETHUSDT", qty="9", closed_ms=BASE_MS + 6 * 60000, hold_min=1)
    rev = ai_context.revenge_trades(_trades([loss, revenge, unrelated]))
    assert rev["count"] == 1
    assert rev["pnlOfRevengeTrades"] == -20.0


def test_overtrading_burst_detection():
    dense = [_row(i, closed_ms=BASE_MS + i * 5 * 60000, hold_min=1) for i in range(6)]
    burst = ai_context.overtrading_bursts(_trades(dense))
    assert burst["maxTradesInWindow"] == 6 and burst["flagged"] is True
    sparse = [_row(i, closed_ms=BASE_MS + i * 7_200_000) for i in range(6)]
    assert ai_context.overtrading_bursts(_trades(sparse))["flagged"] is False


def test_findings_loss_asymmetry_and_mistakes():
    rows = []
    for i in range(4):
        rows.append(_row(i, pnl="10"))
    for i in range(4, 8):
        rows.append(_row(i, pnl="-30"))
    entries = [
        {"id": f"ord{i}:{rows[i]['updatedTime']}", "mistakes": ["No Stop Loss"], "tags": []}
        for i in range(4, 8)
    ]
    result = ai_context.findings(_trades(rows, entries))
    ids = [f["id"] for f in result]
    assert "loss-asymmetry" in ids
    assert "mistake-common" in ids
    asym = next(f for f in result if f["id"] == "loss-asymmetry")
    assert asym["severity"] == "warn"
    assert asym["evidence"]["ratio"] == 3.0
    assert all(set(f) == {"id", "severity", "title", "detail", "evidence"} for f in result)


def test_findings_confidence_inversion():
    rows, entries = [], []
    for i in range(4):  # high confidence, all losers
        rows.append(_row(i, pnl="-10"))
        entries.append({"id": f"ord{i}:{rows[i]['updatedTime']}", "confidence": 5})
    for i in range(4, 8):  # low confidence, all winners
        rows.append(_row(i, pnl="10"))
        entries.append({"id": f"ord{i}:{rows[i]['updatedTime']}", "confidence": 1})
    result = ai_context.findings(_trades(rows, entries))
    assert any(f["id"] == "confidence-inverted" for f in result)


def test_findings_empty_input():
    assert ai_context.findings([]) == []


def test_evidence_pack_shape_and_caps():
    rows = [_row(i, pnl="1") for i in range(60)]
    pack = ai_context.evidence_pack(_trades(rows), range_label="last 30 days")
    assert pack["rangeLabel"] == "last 30 days"
    assert len(pack["recentTrades"]) == ai_context.MAX_TRADES_FOR_LLM
    assert pack["stats"]["trades"] == 60
    assert "ord0" not in json.dumps(pack), "no identities in a prompt payload"
    # Positions/account only when supplied.
    assert "openPositions" not in pack and "account" not in pack
