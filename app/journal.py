"""Trading-journal domain logic: validation, shaping and defaults.

The journal turns each completed trade (a Closed-PnL record) into a reviewable
learning record — notes, strategy, setup, tags, mistakes, confidence /
execution / rating scores, lessons and a review-workflow status. Entries are
stored in their own MongoDB collection (app/db.py JOURNAL) keyed by the SAME
natural identity as the Closed-PnL mirror (`orderId:updatedTime`), so no
exchange data is ever duplicated: the frontend joins entries onto its trade
rows by id. Only two tiny fields are denormalized onto an entry — `symbol` and
`tsMs` (the trade's close time) — because the range/symbol indexes need them;
they are stamped once on insert and never updated.

This module is deliberately framework-free (no FastAPI imports): routes in
main.py catch JournalValidationError and map it to a 400. Every write field is
allowlisted and capped here — a journal entry is user-authored free text headed
for other browsers' DOM, so unknown fields must never be stored and stored
strings must never be unbounded.

Future-proofing (deliberate, cheap):
  * `attachments` exists in the stored shape (always [] today) so screenshots /
    chart images / voice notes can attach later without a migration.
  * `schemaVersion` is stamped on every entry.
  * Catalogs (tags / strategies / mistakes) are open-ended user-defined lists
    with colors, not enums — new review dimensions are a catalog away.
"""
import re
import time

# --- Field caps (shared by entry + meta validation, and by the tests) ---
NOTES_MAX = 20_000        # chars; ~3-4k words, still far below the 64KB body cap
LESSONS_MAX = 5_000
SETUP_MAX = 200
STRATEGY_MAX = 60
LABEL_MAX = 60            # one tag / mistake / catalog name
TAGS_MAX = 20             # per entry
MISTAKES_MAX = 20         # per entry
CATALOG_TAGS_MAX = 200
CATALOG_STRATEGIES_MAX = 100
CATALOG_MISTAKES_MAX = 100
EXCERPT_LEN = 240
SCHEMA_VERSION = 1

REVIEW_STATUSES = ("pending", "reviewed", "needs_attention", "excellent", "follow_up")

# Same identity charset the sync mints ids from (orderId hex/uuid + ":" +
# updatedTime digits). Anything else is rejected before it can reach a query.
_ENTRY_ID_RE = re.compile(r"^[A-Za-z0-9:_\-]{3,120}$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
# Reject control characters in single-line fields; notes/lessons keep \n and \t.
_CTRL_INLINE = re.compile(r"[\x00-\x1f\x7f]")
_CTRL_BLOCK = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class JournalValidationError(ValueError):
    """Invalid client input; routes map this to HTTP 400 with .args[0]."""


def _fail(msg: str):
    raise JournalValidationError(msg)


def valid_entry_id(entry_id) -> bool:
    return isinstance(entry_id, str) and bool(_ENTRY_ID_RE.match(entry_id))


def _clean_block_text(value, name: str, cap: int) -> str:
    """Multi-line text field: normalize newlines, strip disallowed control
    chars, enforce the cap. Empty string is a legitimate 'cleared' value."""
    if not isinstance(value, str):
        _fail(f"{name} must be a string")
    text = value.replace("\r\n", "\n").replace("\r", "\n")
    text = _CTRL_BLOCK.sub("", text)
    if len(text) > cap:
        _fail(f"{name} must be at most {cap} characters")
    return text


def _clean_inline_text(value, name: str, cap: int) -> str:
    """Single-line field: collapse whitespace runs (incl. newlines/tabs) to
    single spaces FIRST, then strip the remaining control chars."""
    if not isinstance(value, str):
        _fail(f"{name} must be a string")
    text = " ".join(value.split())
    text = _CTRL_INLINE.sub("", text)
    if len(text) > cap:
        _fail(f"{name} must be at most {cap} characters")
    return text


def _clean_labels(value, name: str, max_items: int) -> list[str]:
    """Tag/mistake lists: trimmed, control-char-free, deduped
    case-insensitively (first spelling wins), order-preserving."""
    if not isinstance(value, list):
        _fail(f"{name} must be a list of strings")
    if len(value) > max_items:
        _fail(f"{name} must have at most {max_items} items")
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        label = _clean_inline_text(item, f"each {name} item", LABEL_MAX)
        if not label:
            continue
        key = label.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(label)
    return out


def _clean_score(value, name: str):
    """1..5 integer scores (confidence / executionQuality / rating); None (or
    0) clears the score. Bools are rejected — True is an int in Python."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        _fail(f"{name} must be an integer from 1 to 5 (or null to clear)")
    if value == 0:
        return None
    if not 1 <= value <= 5:
        _fail(f"{name} must be an integer from 1 to 5 (or null to clear)")
    return value


# PUT allowlist: payload key -> cleaner. Anything not listed here is silently
# dropped (mass-assignment defense, same stance as the order endpoints).
_FIELD_CLEANERS = {
    "notes": lambda v: _clean_block_text(v, "notes", NOTES_MAX),
    "lessons": lambda v: _clean_block_text(v, "lessons", LESSONS_MAX),
    "setup": lambda v: _clean_inline_text(v, "setup", SETUP_MAX),
    "strategy": lambda v: _clean_inline_text(v, "strategy", STRATEGY_MAX),
    "tags": lambda v: _clean_labels(v, "tags", TAGS_MAX),
    "mistakes": lambda v: _clean_labels(v, "mistakes", MISTAKES_MAX),
    "confidence": lambda v: _clean_score(v, "confidence"),
    "executionQuality": lambda v: _clean_score(v, "executionQuality"),
    "rating": lambda v: _clean_score(v, "rating"),
}


def clean_entry_fields(payload: dict) -> dict:
    """Validated $set fields from a PUT payload. Partial by design (autosave
    sends only what changed); returns {} when nothing recognizable was sent."""
    if not isinstance(payload, dict):
        _fail("payload must be an object")
    fields: dict = {}
    for key, cleaner in _FIELD_CLEANERS.items():
        if key in payload:
            fields[key] = cleaner(payload[key])
    if "reviewStatus" in payload:
        status = payload["reviewStatus"]
        if status not in REVIEW_STATUSES:
            _fail("reviewStatus must be one of: " + ", ".join(REVIEW_STATUSES))
        fields["reviewStatus"] = status
    return fields


def insert_fields(symbol: str, ts_ms: int) -> dict:
    """Insert-only fields stamped on an entry's FIRST write: the denormalized
    join keys (symbol/tsMs — validated by the route against the same rules as
    every trade endpoint), creation stamp, and the reserved future-proof
    fields. Never part of $set, so they can never drift from the trade."""
    return {
        "symbol": symbol,
        "tsMs": ts_ms,
        "createdAtMs": int(time.time() * 1000),
        "attachments": [],       # reserved: screenshots / chart images / voice notes
        "schemaVersion": SCHEMA_VERSION,
    }


def _excerpt(text: str) -> str:
    if len(text) <= EXCERPT_LEN:
        return text
    cut = text[:EXCERPT_LEN]
    # Prefer a word boundary so the ellipsis never splits a word mid-way.
    space = cut.rfind(" ")
    if space > EXCERPT_LEN // 2:
        cut = cut[:space]
    return cut + "…"


def shape_entry(doc: dict, *, full: bool) -> dict:
    """API shape for a stored entry. `full=False` (list reads) carries an
    excerpt + word count instead of the whole notes/lessons text so a
    thousands-of-trades range read stays small; the full text loads only when
    a trade card is expanded (GET one entry)."""
    notes = doc.get("notes") or ""
    lessons = doc.get("lessons") or ""
    out = {
        "id": doc.get("_id"),
        "symbol": doc.get("symbol"),
        "tsMs": doc.get("tsMs"),
        "setup": doc.get("setup") or "",
        "strategy": doc.get("strategy") or "",
        "tags": doc.get("tags") or [],
        "mistakes": doc.get("mistakes") or [],
        "confidence": doc.get("confidence"),
        "executionQuality": doc.get("executionQuality"),
        "rating": doc.get("rating"),
        "reviewStatus": doc.get("reviewStatus") or "pending",
        "attachments": doc.get("attachments") or [],
        "createdAtMs": doc.get("createdAtMs"),
        "updatedAtMs": doc.get("updatedAtMs"),
        "noteWords": len(notes.split()),
        "hasNotes": bool(notes),
        "hasLessons": bool(lessons),
    }
    if full:
        out["notes"] = notes
        out["lessons"] = lessons
        # Server-written AI review (never client-writable: it is not in the
        # PUT allowlist — only /api/ai/trade-review can set it).
        out["aiReview"] = doc.get("aiReview")
    else:
        out["notesExcerpt"] = _excerpt(notes)
        out["lessonsExcerpt"] = _excerpt(lessons)
        out["hasAiReview"] = bool(doc.get("aiReview"))
    return out


# --- Catalogs (Journal-Meta singleton) ---

def default_meta() -> dict:
    """Starter catalogs served (flagged isDefault) until the user saves their
    own — so the pickers are useful from the first trade, not empty."""
    def items(names, colors=None):
        return [
            {"name": n, "color": (colors or {}).get(n, "")} for n in names
        ]
    tag_colors = {
        "Breakout": "#3fb68b", "Momentum": "#3fa7dd", "Scalp": "#e0a458",
        "Swing": "#9b7ede", "Reversal": "#dd7bb0", "Trend": "#4ecdc4",
        "FOMO": "#e05c5c", "Revenge": "#c0392b", "News": "#d4b13f",
        "Range": "#7f8fa6",
    }
    return {
        "tags": items(
            ["Breakout", "Momentum", "Scalp", "Swing", "Reversal", "Trend",
             "Range", "News", "FOMO", "Revenge"], tag_colors),
        "strategies": items(
            ["Momentum", "Breakout", "VWAP", "Range", "Mean Reversion",
             "Trend Following"]),
        "mistakes": items(
            ["Late Entry", "Early Exit", "No Stop Loss", "Oversized Position",
             "Emotional Trade", "Ignored Plan", "Chased Entry", "Moved Stop"]),
        "updatedAtMs": None,
    }


def _clean_catalog(value, name: str, max_items: int) -> list[dict]:
    if not isinstance(value, list):
        _fail(f"{name} must be a list")
    if len(value) > max_items:
        _fail(f"{name} must have at most {max_items} items")
    out: list[dict] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            _fail(f"each {name} item must be an object with a name")
        label = _clean_inline_text(item.get("name"), f"each {name} name", LABEL_MAX)
        if not label:
            _fail(f"{name} names must not be empty")
        key = label.lower()
        if key in seen:
            _fail(f"duplicate {name} name: {label}")
        seen.add(key)
        color = item.get("color") or ""
        if color and not (isinstance(color, str) and _COLOR_RE.match(color)):
            _fail(f"{name} colors must be #rrggbb hex strings")
        out.append({"name": label, "color": color})
    return out


def clean_meta(payload: dict) -> dict:
    """Validated full replacement for the catalogs doc."""
    if not isinstance(payload, dict):
        _fail("payload must be an object")
    return {
        "tags": _clean_catalog(payload.get("tags", []), "tags", CATALOG_TAGS_MAX),
        "strategies": _clean_catalog(
            payload.get("strategies", []), "strategies", CATALOG_STRATEGIES_MAX),
        "mistakes": _clean_catalog(
            payload.get("mistakes", []), "mistakes", CATALOG_MISTAKES_MAX),
        "updatedAtMs": int(time.time() * 1000),
    }


# Rename targets: request "kind" -> entry field. Strategy is scalar; the
# array/scalar split is handled by db.journal_relabel.
RELABEL_FIELDS = {"tag": "tags", "strategy": "strategy", "mistake": "mistakes"}


def clean_relabel(payload: dict) -> tuple[str, str, str | None]:
    """Validated (field, old, new) for a catalog-wide rename; new=None removes
    the label from every entry instead."""
    if not isinstance(payload, dict):
        _fail("payload must be an object")
    kind = payload.get("kind")
    if kind not in RELABEL_FIELDS:
        _fail("kind must be one of: " + ", ".join(RELABEL_FIELDS))
    old = _clean_inline_text(payload.get("from"), "from", LABEL_MAX)
    if not old:
        _fail("from must not be empty")
    new_raw = payload.get("to")
    new = None
    if new_raw not in (None, ""):
        new = _clean_inline_text(new_raw, "to", LABEL_MAX)
        cap = STRATEGY_MAX if kind == "strategy" else LABEL_MAX
        if len(new) > cap:
            _fail(f"to must be at most {cap} characters")
    return RELABEL_FIELDS[kind], old, new
