"""AI intelligence layer API (/api/ai/*).

Runs entirely on the MockProvider (deterministic, network-free) and the
in-memory fake_db. Contracts under test: deterministic insights, briefing
generation + fingerprint caching, trade review persisted onto the journal,
session reviews, SSE query streaming + conversation history CRUD, auth gates
(viewer read-only), the per-minute LLM budget, Mongo-down 503s, and that no
provider identity or internal ids ever leak to the browser.
"""
import json

import pytest
from fastapi.testclient import TestClient
from pymongo.errors import PyMongoError

from app import ai_providers, ai_service, db as db_mod, main as main_mod
from app.config import settings

BASE_MS = 1_754_000_000_000


@pytest.fixture(autouse=True)
def _fresh_ai_state(monkeypatch):
    ai_providers.reset_provider()
    ai_service.reset_state()

    # Keep tests hermetic: the briefing's best-effort live-risk lookup must
    # never dial the real exchange from the suite.
    async def no_live_context():
        return None, None

    monkeypatch.setattr(ai_service, "_live_risk_context", no_live_context)
    yield
    ai_providers.reset_provider()
    ai_service.reset_state()


@pytest.fixture
def viewer_client():
    fake_viewer = {"u": "vwr", "r": "viewer", "sid": "sid-v"}
    main_mod.app.dependency_overrides[main_mod.current_user] = lambda: fake_viewer
    client = TestClient(main_mod.app)
    yield client
    main_mod.app.dependency_overrides.clear()


def _seed_trades(fake_db, n=10, *, base_ms=None):
    """n alternating win/loss closed trades + journal entries on the losers."""
    base = base_ms if base_ms is not None else BASE_MS
    for i in range(n):
        pnl = "20" if i % 2 == 0 else "-30"
        closed = base + i * 3_600_000
        row = {
            "orderId": f"ord{i}", "symbol": "BTCUSDT", "side": "Sell", "qty": "1",
            "avgEntryPrice": "100", "avgExitPrice": "110", "closedPnl": pnl,
            "leverage": "10", "createdTime": str(closed - 3_600_000),
            "updatedTime": str(closed),
        }
        _id = f"ord{i}:{closed}"
        fake_db[db_mod.CLOSED_PNL][_id] = {**row, "_id": _id, "tsMs": closed, "syncedAt": "X"}
        if i % 2 == 1:
            fake_db[db_mod.JOURNAL][_id] = {
                "_id": _id, "symbol": "BTCUSDT", "tsMs": closed,
                "mistakes": ["No Stop Loss"], "tags": ["Breakout"], "confidence": 4,
            }


def _sse_events(text):
    events = []
    for line in text.splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line[6:]))
    return events


def _freeze_now(monkeypatch, now_ms):
    monkeypatch.setattr(main_mod.time, "time", lambda: now_ms / 1000)
    monkeypatch.setattr(ai_service.time, "time", lambda: now_ms / 1000)


# --------------------------------------------------------------------------
# Status / templates
# --------------------------------------------------------------------------
def test_status_reports_capabilities_not_provider_identity(admin_client):
    resp = admin_client.get("/api/ai/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ready"] is True and body["live"] is False
    assert "provider" not in body and "mock" not in json.dumps(body).lower()


def test_templates_listed(admin_client):
    body = admin_client.get("/api/ai/templates").json()
    ids = [t["id"] for t in body["templates"]]
    assert "find-mistakes" in ids and "review-journal" in ids
    assert all(t["prompt"] for t in body["templates"])


# --------------------------------------------------------------------------
# Deterministic insights (no LLM)
# --------------------------------------------------------------------------
def test_insights_computed_from_mirror(admin_client, fake_db, monkeypatch):
    _freeze_now(monkeypatch, BASE_MS + 40 * 3_600_000)
    _seed_trades(fake_db)
    body = admin_client.get("/api/ai/insights").json()
    assert body["stats"]["trades"] == 10
    assert body["stats"]["wins"] == 5
    assert any(f["id"] == "mistake-common" for f in body["findings"])
    assert body["byMistake"][0]["label"] == "No Stop Loss"
    assert "ord0" not in json.dumps(body), "internal ids never reach the browser"


def test_insights_open_to_viewer(viewer_client, fake_db):
    assert viewer_client.get("/api/ai/insights").status_code == 200


def test_insights_mongo_down_503(admin_client, monkeypatch):
    async def boom(*a, **k):
        raise PyMongoError("down")
    monkeypatch.setattr(db_mod, "query_history", boom)
    resp = admin_client.get("/api/ai/insights")
    assert resp.status_code == 503
    assert resp.json()["detail"] == "history database unavailable"


# --------------------------------------------------------------------------
# Briefing (+ caching)
# --------------------------------------------------------------------------
def test_briefing_generates_and_caches(admin_client, fake_db, monkeypatch):
    _freeze_now(monkeypatch, BASE_MS + 40 * 3_600_000)
    _seed_trades(fake_db)
    first = admin_client.post("/api/ai/briefing", json={"rangeDays": 7}).json()
    assert "Rule-based analysis" in first["text"]
    assert first["live"] is False and first["cached"] is False
    assert first["evidence"]["stats"]["trades"] == 10

    second = admin_client.post("/api/ai/briefing", json={"rangeDays": 7}).json()
    assert second["cached"] is True, "unchanged data must serve from cache"

    # New data changes the fingerprint -> regenerate.
    _seed_trades(fake_db, n=12)
    third = admin_client.post("/api/ai/briefing", json={"rangeDays": 7}).json()
    assert third["cached"] is False


def test_briefing_requires_admin(viewer_client):
    assert viewer_client.post("/api/ai/briefing", json={}).status_code == 403


def test_briefing_bad_range_400(admin_client):
    assert admin_client.post(
        "/api/ai/briefing", json={"rangeDays": "soon"}).status_code == 400


# --------------------------------------------------------------------------
# Trade review — persisted onto the journal entry
# --------------------------------------------------------------------------
def test_trade_review_persists_ai_review_on_journal(admin_client, fake_db, monkeypatch):
    _freeze_now(monkeypatch, BASE_MS + 40 * 3_600_000)
    _seed_trades(fake_db)
    trade_id = f"ord0:{BASE_MS}"  # a trade with NO journal entry yet
    resp = admin_client.post("/api/ai/trade-review", json={"tradeId": trade_id})
    assert resp.status_code == 200
    body = resp.json()
    assert body["tradeId"] == trade_id
    assert body["trade"]["symbol"] == "BTCUSDT"
    assert "orderId" not in json.dumps(body["trade"])

    doc = fake_db[db_mod.JOURNAL][trade_id]
    assert doc["aiReview"]["text"] == body["text"]
    assert doc["symbol"] == "BTCUSDT" and doc["tsMs"] == BASE_MS

    # And the journal API surfaces it (full shape only; list shape gets a flag).
    entry = admin_client.get(f"/api/journal/entry/{trade_id}").json()["entry"]
    assert entry["aiReview"]["text"] == body["text"]
    listed = admin_client.get("/api/journal/entries").json()["entries"]
    mine = next(e for e in listed if e["id"] == trade_id)
    assert mine["hasAiReview"] is True and "aiReview" not in mine


def test_trade_review_unknown_trade_404(admin_client, fake_db):
    resp = admin_client.post(
        "/api/ai/trade-review", json={"tradeId": f"ghost:{BASE_MS}"})
    assert resp.status_code == 404


def test_trade_review_invalid_id_400(admin_client, fake_db):
    assert admin_client.post(
        "/api/ai/trade-review", json={"tradeId": "not valid!"}).status_code == 400


# --------------------------------------------------------------------------
# Session review
# --------------------------------------------------------------------------
def test_session_review_day_and_validation(admin_client, fake_db, monkeypatch):
    _freeze_now(monkeypatch, BASE_MS + 40 * 3_600_000)
    _seed_trades(fake_db)
    resp = admin_client.post(
        "/api/ai/session-review", json={"period": "day", "atMs": BASE_MS})
    assert resp.status_code == 200
    assert "Rule-based analysis" in resp.json()["text"]

    assert admin_client.post(
        "/api/ai/session-review", json={"period": "quarter"}).status_code == 400


def test_session_review_empty_period_is_honest(admin_client, fake_db):
    resp = admin_client.post(
        "/api/ai/session-review", json={"period": "day", "atMs": 946684800000})
    assert resp.status_code == 200
    assert "No closed trades" in resp.json()["text"]


# --------------------------------------------------------------------------
# Query (SSE) + conversations
# --------------------------------------------------------------------------
def test_query_streams_and_persists_conversation(admin_client, fake_db):
    _seed_trades(fake_db)
    resp = admin_client.post("/api/ai/query", json={"question": "Why did I lose money?"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = _sse_events(resp.text)
    kinds = [e["type"] for e in events]
    assert kinds[0] == "start" and kinds[-1] == "done" and "delta" in kinds
    conv_id = events[0]["conversationId"]
    answer = "".join(e["text"] for e in events if e["type"] == "delta")
    assert "Rule-based analysis" in answer

    stored = fake_db[db_mod.AI_CONVERSATIONS][conv_id]
    assert [m["role"] for m in stored["messages"]] == ["user", "assistant"]
    assert stored["messages"][0]["content"] == "Why did I lose money?"
    assert stored["messages"][1]["content"] == answer

    # Continue the same conversation.
    resp2 = admin_client.post(
        "/api/ai/query", json={"question": "And what should I change?", "conversationId": conv_id})
    events2 = _sse_events(resp2.text)
    assert events2[0]["conversationId"] == conv_id
    assert len(fake_db[db_mod.AI_CONVERSATIONS][conv_id]["messages"]) == 4


def test_query_validation(admin_client, fake_db):
    assert admin_client.post("/api/ai/query", json={"question": "  "}).status_code == 400
    assert admin_client.post(
        "/api/ai/query", json={"question": "q", "conversationId": "zz"}).status_code == 400
    assert admin_client.post(
        "/api/ai/query", json={"question": "q", "conversationId": "a" * 32}).status_code == 404


def test_conversation_crud_and_ordering(admin_client, fake_db):
    _seed_trades(fake_db)
    for q in ("first question", "second question"):
        admin_client.post("/api/ai/query", json={"question": q})
    convs = admin_client.get("/api/ai/conversations").json()["conversations"]
    assert len(convs) == 2
    assert all(set(c) == {"id", "title", "pinned", "createdAtMs", "updatedAtMs"} for c in convs)

    older = convs[-1]["id"]
    assert admin_client.patch(
        f"/api/ai/conversations/{older}", json={"pinned": True, "title": "My pinned chat"}
    ).status_code == 200
    convs = admin_client.get("/api/ai/conversations").json()["conversations"]
    assert convs[0]["id"] == older and convs[0]["title"] == "My pinned chat"

    full = admin_client.get(f"/api/ai/conversations/{older}").json()
    assert len(full["messages"]) == 2

    assert admin_client.delete(f"/api/ai/conversations/{older}").json()["deleted"] is True
    assert admin_client.get(f"/api/ai/conversations/{older}").status_code == 404

    assert admin_client.patch(
        f"/api/ai/conversations/{'b' * 32}", json={"title": "x"}).status_code == 404
    assert admin_client.patch(
        f"/api/ai/conversations/{'b' * 32}", json={}).status_code == 400


def test_viewer_reads_conversations_but_cannot_mutate_or_query(viewer_client, fake_db):
    assert viewer_client.get("/api/ai/conversations").status_code == 200
    assert viewer_client.post("/api/ai/query", json={"question": "q"}).status_code == 403
    assert viewer_client.patch(
        f"/api/ai/conversations/{'c' * 32}", json={"title": "x"}).status_code == 403
    assert viewer_client.delete(f"/api/ai/conversations/{'c' * 32}").status_code == 403
    assert viewer_client.post("/api/ai/trade-review", json={"tradeId": "a:1"}).status_code == 403
    assert viewer_client.post("/api/ai/session-review", json={"period": "day"}).status_code == 403


# --------------------------------------------------------------------------
# Cost guardrail
# --------------------------------------------------------------------------
def test_llm_budget_429_and_no_orphan_conversation(admin_client, fake_db, monkeypatch):
    monkeypatch.setattr(settings, "AI_CALLS_PER_MIN", 1)
    _seed_trades(fake_db)
    assert admin_client.post("/api/ai/query", json={"question": "one"}).status_code == 200
    resp = admin_client.post("/api/ai/query", json={"question": "two"})
    assert resp.status_code == 429
    assert "budget" in resp.json()["detail"]
    # The rejected question must not leave an empty conversation behind.
    assert len(fake_db[db_mod.AI_CONVERSATIONS]) == 1


def test_session_review_absurd_atms_is_400_not_500(admin_client, fake_db):
    resp = admin_client.post(
        "/api/ai/session-review", json={"period": "day", "atMs": 10 ** 30})
    assert resp.status_code in (200, 400)  # clamped or rejected — never a 500


def test_query_accepts_tz_offset(admin_client, fake_db):
    _seed_trades(fake_db)
    resp = admin_client.post(
        "/api/ai/query", json={"question": "why?", "tzOffsetMin": 330})
    assert resp.status_code == 200
    resp = admin_client.get("/api/ai/insights?tzOffsetMin=330")
    assert resp.status_code == 200
