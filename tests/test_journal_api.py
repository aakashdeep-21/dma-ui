"""Trading Journal API (/api/journal/*).

Entries annotate completed trades by the Closed-PnL natural id
(`orderId:updatedTime`) without duplicating exchange data; catalogs live in a
Journal-Meta singleton. Reads are for any logged-in user; writes are
admin-only (no trade token — journal writes move no money). Contracts under
test: allowlisted partial upserts, validation caps, excerpt-only list reads,
catalog validation, cross-entry relabel, viewer denial, Mongo-down 503s.
"""
import pytest
from fastapi.testclient import TestClient
from pymongo.errors import PyMongoError

from app import db as db_mod, journal, main as main_mod

ENTRY_ID = "ord-123:1750000000000"
TS_MS = 1_750_000_000_000


@pytest.fixture
def viewer_client():
    """Logged-in read-only viewer: current_user resolves, require_admin runs
    for real and must 403 on every journal write."""
    fake_viewer = {"u": "vwr", "r": "viewer", "sid": "sid-v"}
    main_mod.app.dependency_overrides[main_mod.current_user] = lambda: fake_viewer
    client = TestClient(main_mod.app)
    yield client
    main_mod.app.dependency_overrides.clear()


def _put(client, entry_id=ENTRY_ID, **fields):
    payload = {"symbol": "BTCUSDT", "tsMs": TS_MS, **fields}
    return client.put(f"/api/journal/entry/{entry_id}", json=payload)


# --------------------------------------------------------------------------
# Entry CRUD
# --------------------------------------------------------------------------
def test_put_creates_entry_and_get_returns_full_text(admin_client, fake_db):
    resp = _put(
        admin_client,
        notes="Clean breakout above resistance.\nWaited for the retest.",
        lessons="Patience paid.",
        setup="Range break + volume",
        strategy="Breakout",
        tags=["Breakout", "Trend"],
        mistakes=["Late Entry"],
        confidence=4,
        executionQuality=3,
        rating=5,
        reviewStatus="reviewed",
    )
    assert resp.status_code == 200
    entry = resp.json()["entry"]
    assert entry["id"] == ENTRY_ID
    assert entry["symbol"] == "BTCUSDT" and entry["tsMs"] == TS_MS
    assert entry["notes"].startswith("Clean breakout")
    assert entry["tags"] == ["Breakout", "Trend"]
    assert entry["mistakes"] == ["Late Entry"]
    assert entry["confidence"] == 4 and entry["rating"] == 5
    assert entry["reviewStatus"] == "reviewed"
    assert entry["attachments"] == [], "attachment slot reserved for the future"
    assert entry["noteWords"] == 8
    assert entry["createdAtMs"] and entry["updatedAtMs"]

    got = admin_client.get(f"/api/journal/entry/{ENTRY_ID}").json()["entry"]
    assert got["notes"] == entry["notes"] and got["lessons"] == "Patience paid."


def test_put_is_a_partial_update(admin_client, fake_db):
    _put(admin_client, notes="original notes", confidence=2)
    resp = _put(admin_client, rating=4)
    assert resp.status_code == 200
    entry = admin_client.get(f"/api/journal/entry/{ENTRY_ID}").json()["entry"]
    assert entry["notes"] == "original notes", "untouched fields must survive"
    assert entry["confidence"] == 2
    assert entry["rating"] == 4


def test_insert_only_fields_never_drift(admin_client, fake_db):
    _put(admin_client, notes="x")
    created = fake_db[db_mod.JOURNAL][ENTRY_ID]["createdAtMs"]
    # A later save with a DIFFERENT symbol/tsMs must not rewrite the join keys.
    resp = admin_client.put(
        f"/api/journal/entry/{ENTRY_ID}",
        json={"symbol": "ETHUSDT", "tsMs": TS_MS + 5_000, "rating": 3},
    )
    assert resp.status_code == 200
    doc = fake_db[db_mod.JOURNAL][ENTRY_ID]
    assert doc["symbol"] == "BTCUSDT" and doc["tsMs"] == TS_MS
    assert doc["createdAtMs"] == created


def test_get_missing_entry_is_null_not_404(admin_client, fake_db):
    resp = admin_client.get(f"/api/journal/entry/{ENTRY_ID}")
    assert resp.status_code == 200
    assert resp.json()["entry"] is None


def test_delete_entry(admin_client, fake_db):
    _put(admin_client, notes="x")
    assert admin_client.delete(f"/api/journal/entry/{ENTRY_ID}").json()["deleted"] is True
    assert admin_client.delete(f"/api/journal/entry/{ENTRY_ID}").json()["deleted"] is False
    assert ENTRY_ID not in fake_db[db_mod.JOURNAL]


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------
@pytest.mark.parametrize("payload,fragment", [
    ({"notes": "x" * (journal.NOTES_MAX + 1)}, "notes"),
    ({"lessons": "x" * (journal.LESSONS_MAX + 1)}, "lessons"),
    ({"setup": "x" * (journal.SETUP_MAX + 1)}, "setup"),
    ({"strategy": "x" * (journal.STRATEGY_MAX + 1)}, "strategy"),
    ({"tags": [f"t{i}" for i in range(journal.TAGS_MAX + 1)]}, "tags"),
    ({"tags": "not-a-list"}, "tags"),
    ({"tags": ["x" * (journal.LABEL_MAX + 1)]}, "tags"),
    ({"confidence": 6}, "confidence"),
    ({"confidence": True}, "confidence"),
    ({"confidence": "high"}, "confidence"),
    ({"rating": -1}, "rating"),
    ({"reviewStatus": "amazing"}, "reviewStatus"),
    ({"notes": 42}, "notes"),
])
def test_put_field_validation_rejected(admin_client, fake_db, payload, fragment):
    resp = _put(admin_client, **payload)
    assert resp.status_code == 400
    assert fragment in resp.json()["detail"]
    assert ENTRY_ID not in fake_db[db_mod.JOURNAL], "invalid input must write nothing"


def test_put_requires_some_journal_field(admin_client, fake_db):
    resp = admin_client.put(
        f"/api/journal/entry/{ENTRY_ID}",
        json={"symbol": "BTCUSDT", "tsMs": TS_MS, "hacker": "field"},
    )
    assert resp.status_code == 400
    assert "no journal fields" in resp.json()["detail"]


def test_put_unknown_fields_never_stored(admin_client, fake_db):
    _put(admin_client, notes="x", reduceOnly=True, isAdmin=1)
    doc = fake_db[db_mod.JOURNAL][ENTRY_ID]
    assert "reduceOnly" not in doc and "isAdmin" not in doc


@pytest.mark.parametrize("bad", [
    {"symbol": "bad symbol!", "tsMs": TS_MS},
    {"symbol": "BTCUSDT", "tsMs": "not-a-number"},
    {"symbol": "BTCUSDT", "tsMs": 0},
    {"symbol": "BTCUSDT"},
])
def test_put_requires_valid_join_keys(admin_client, fake_db, bad):
    resp = admin_client.put(f"/api/journal/entry/{ENTRY_ID}", json={**bad, "notes": "x"})
    assert resp.status_code == 400


@pytest.mark.parametrize("bad_id", ["ab", "has space", "semi;colon", "x" * 121, "dot.ted"])
def test_bad_entry_id_rejected(admin_client, fake_db, bad_id):
    assert _put(admin_client, entry_id=bad_id).status_code == 400
    assert admin_client.get(f"/api/journal/entry/{bad_id}").status_code == 400


def test_tags_trimmed_and_deduped_case_insensitively(admin_client, fake_db):
    resp = _put(admin_client, tags=["  Breakout ", "breakout", "FOMO", ""])
    assert resp.json()["entry"]["tags"] == ["Breakout", "FOMO"]


def test_zero_score_clears(admin_client, fake_db):
    _put(admin_client, confidence=4)
    resp = _put(admin_client, confidence=0)
    assert resp.json()["entry"]["confidence"] is None


def test_notes_newlines_normalized_and_ctrl_stripped(admin_client, fake_db):
    resp = _put(admin_client, notes="a\r\nb\x00c", setup="one\ntwo\tthree")
    entry = resp.json()["entry"]
    assert entry["notes"] == "a\nbc"
    assert entry["setup"] == "one two three", "single-line fields collapse whitespace"


# --------------------------------------------------------------------------
# List reads: range, symbol filter, excerpts
# --------------------------------------------------------------------------
def test_entries_range_symbol_and_excerpts(admin_client, fake_db):
    long_notes = ("alpha beta gamma delta " * 30).strip()  # ~690 chars
    _put(admin_client, entry_id="o1:1000000000001", notes=long_notes)
    admin_client.put(
        "/api/journal/entry/o2:1000000000002",
        json={"symbol": "ETHUSDT", "tsMs": TS_MS + 2_000, "rating": 3},
    )

    body = admin_client.get("/api/journal/entries").json()
    assert [e["id"] for e in body["entries"]] == ["o2:1000000000002", "o1:1000000000001"], \
        "newest-first, no bounds = all time"
    assert body["truncated"] is False

    first = next(e for e in body["entries"] if e["id"] == "o1:1000000000001")
    assert "notes" not in first, "list reads must never carry full text"
    assert first["notesExcerpt"].endswith("…")
    assert len(first["notesExcerpt"]) <= journal.EXCERPT_LEN + 1
    assert first["noteWords"] == len(long_notes.split())
    assert first["hasNotes"] is True

    only_eth = admin_client.get("/api/journal/entries?symbol=ETHUSDT").json()["entries"]
    assert [e["id"] for e in only_eth] == ["o2:1000000000002"]

    ranged = admin_client.get(
        f"/api/journal/entries?startTime={TS_MS + 1}&endTime={TS_MS + 10_000}"
    ).json()["entries"]
    assert [e["id"] for e in ranged] == ["o2:1000000000002"]

    assert admin_client.get(
        f"/api/journal/entries?startTime={TS_MS}"
    ).status_code == 400, "one-sided range is a caller error"


# --------------------------------------------------------------------------
# Catalogs (meta) + relabel
# --------------------------------------------------------------------------
def test_meta_defaults_until_saved(admin_client, fake_db):
    body = admin_client.get("/api/journal/meta").json()
    assert body["isDefault"] is True
    names = [t["name"] for t in body["meta"]["tags"]]
    assert "Breakout" in names and "FOMO" in names
    assert [s["name"] for s in body["meta"]["strategies"]].count("Momentum") == 1
    assert "No Stop Loss" in [m["name"] for m in body["meta"]["mistakes"]]

    saved = admin_client.put("/api/journal/meta", json={
        "tags": [{"name": "Breakout", "color": "#3fb68b"}],
        "strategies": [{"name": "VWAP"}],
        "mistakes": [{"name": "Late Entry"}],
    })
    assert saved.status_code == 200
    body = admin_client.get("/api/journal/meta").json()
    assert body["isDefault"] is False
    assert body["meta"]["tags"] == [{"name": "Breakout", "color": "#3fb68b"}]
    assert body["meta"]["updatedAtMs"]


@pytest.mark.parametrize("payload,fragment", [
    ({"tags": [{"name": "A", "color": "red"}]}, "color"),
    ({"tags": [{"name": "A"}, {"name": "a"}]}, "duplicate"),
    ({"tags": [{"name": ""}]}, "empty"),
    ({"tags": ["plain-string"]}, "object"),
    ({"strategies": [{"name": "x" * (journal.LABEL_MAX + 1)}]}, "name"),
])
def test_meta_validation(admin_client, fake_db, payload, fragment):
    resp = admin_client.put("/api/journal/meta", json=payload)
    assert resp.status_code == 400
    assert fragment in resp.json()["detail"]


def test_relabel_tag_across_entries(admin_client, fake_db):
    _put(admin_client, entry_id="o1:1000000000001", tags=["Scalp", "FOMO"])
    _put(admin_client, entry_id="o2:1000000000002", tags=["FOMO"])
    _put(admin_client, entry_id="o3:1000000000003", tags=["Trend"])

    resp = admin_client.post(
        "/api/journal/meta/rename", json={"kind": "tag", "from": "FOMO", "to": "Chased"}
    )
    assert resp.status_code == 200 and resp.json()["modified"] == 2
    assert fake_db[db_mod.JOURNAL]["o1:1000000000001"]["tags"] == ["Scalp", "Chased"]
    assert fake_db[db_mod.JOURNAL]["o2:1000000000002"]["tags"] == ["Chased"]
    assert fake_db[db_mod.JOURNAL]["o3:1000000000003"]["tags"] == ["Trend"]

    # to=null removes the label entirely.
    resp = admin_client.post(
        "/api/journal/meta/rename", json={"kind": "tag", "from": "Chased", "to": None}
    )
    assert resp.json()["modified"] == 2
    assert fake_db[db_mod.JOURNAL]["o2:1000000000002"]["tags"] == []


def test_relabel_strategy_scalar(admin_client, fake_db):
    _put(admin_client, entry_id="o1:1000000000001", strategy="VWAP")
    resp = admin_client.post(
        "/api/journal/meta/rename",
        json={"kind": "strategy", "from": "VWAP", "to": "VWAP Fade"},
    )
    assert resp.json()["modified"] == 1
    assert fake_db[db_mod.JOURNAL]["o1:1000000000001"]["strategy"] == "VWAP Fade"


def test_relabel_validation(admin_client, fake_db):
    assert admin_client.post(
        "/api/journal/meta/rename", json={"kind": "nope", "from": "a", "to": "b"}
    ).status_code == 400
    assert admin_client.post(
        "/api/journal/meta/rename", json={"kind": "tag", "from": "", "to": "b"}
    ).status_code == 400


# --------------------------------------------------------------------------
# Auth: viewer read-only; writes admin-only
# --------------------------------------------------------------------------
def test_viewer_reads_ok_writes_denied(viewer_client, fake_db):
    assert viewer_client.get("/api/journal/entries").status_code == 200
    assert viewer_client.get("/api/journal/meta").status_code == 200
    assert viewer_client.get(f"/api/journal/entry/{ENTRY_ID}").status_code == 200

    put = viewer_client.put(
        f"/api/journal/entry/{ENTRY_ID}",
        json={"symbol": "BTCUSDT", "tsMs": TS_MS, "notes": "hi"},
    )
    assert put.status_code == 403
    assert viewer_client.delete(f"/api/journal/entry/{ENTRY_ID}").status_code == 403
    assert viewer_client.put("/api/journal/meta", json={"tags": []}).status_code == 403
    assert viewer_client.post(
        "/api/journal/meta/rename", json={"kind": "tag", "from": "a", "to": "b"}
    ).status_code == 403
    assert not fake_db[db_mod.JOURNAL]


# --------------------------------------------------------------------------
# Mongo down: sanitized 503, never a raw 500
# --------------------------------------------------------------------------
def test_mongo_down_degrades_to_503(admin_client, monkeypatch):
    async def boom(*args, **kwargs):
        raise PyMongoError("connection refused")

    for helper in ("journal_query", "journal_get", "journal_upsert",
                   "journal_delete", "journal_meta_get", "journal_meta_set",
                   "journal_relabel"):
        monkeypatch.setattr(db_mod, helper, boom)

    assert admin_client.get("/api/journal/entries").status_code == 503
    assert admin_client.get(f"/api/journal/entry/{ENTRY_ID}").status_code == 503
    assert _put(admin_client, notes="x").status_code == 503
    assert admin_client.delete(f"/api/journal/entry/{ENTRY_ID}").status_code == 503
    assert admin_client.get("/api/journal/meta").status_code == 503
    assert admin_client.post(
        "/api/journal/meta/rename", json={"kind": "tag", "from": "a", "to": "b"}
    ).status_code == 503
