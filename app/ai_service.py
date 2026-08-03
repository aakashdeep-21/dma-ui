"""AI coach orchestration: prompts, evidence assembly, caching, conversations.

This is the glue between the sanitized evidence built by app/ai_context.py and
the provider abstraction in app/ai_providers.py. Design rules:

  * The AI layer is READ-ONLY. Nothing here imports dma_client's write
    wrappers; the only exchange calls are the same read endpoints the
    dashboard uses (positions/balance for risk observations), and both are
    optional — every feature degrades gracefully without them.
  * Prompts always embed ONE fenced ```json evidence block (the pack from
    ai_context.evidence_pack). The system prompt instructs the model to cite
    those numbers and never invent its own; the MockProvider renders the same
    block deterministically, so the surface works with no key configured.
  * Expensive generations are cached in-process, keyed by a FINGERPRINT of
    the underlying data — a briefing regenerates when trades changed, not on
    every click, and a cache hit costs no tokens.
  * A process-wide calls-per-minute budget guards runaway token spend; the
    HTTP layer maps AIBusyError to 429.

Trade reviews persist onto the trade's journal entry (`aiReview`, written
server-side only — the journal PUT allowlist can never touch it), so a review
lives with the trade forever and shows up inside the Journal tab.
"""
import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timedelta

from . import ai_context, ai_providers, db, dma_client, journal
from .config import settings

logger = logging.getLogger("dma-ui.ai")

DAY_MS = 86_400_000

SYSTEM_PROMPT = """You are the resident trading coach inside a private cryptocurrency \
futures trading terminal. You analyze ONE trader's own historical performance data.

Rules you must always follow:
- Explain what HAPPENED and WHY, grounded in the evidence JSON provided. Cite its \
numbers; never invent statistics that are not in the evidence.
- Analyze historical behavior only. Never predict prices or markets, never recommend \
entering or exiting any position, and never give financial or investment advice. \
Behavioral recommendations (sizing discipline, stopping after losses, journaling \
habits) are your job; trade calls are not.
- Every recommendation must state its WHY, pointing at the evidence.
- Be direct and specific, like a good coach reviewing film. No hedging boilerplate, \
no disclaimers beyond a single short one when relevant.
- Format with markdown-lite only: **bold**, *italic*, `code`, # headings, - lists, \
> quotes. Keep sections tight; prefer bullets over prose walls.
- If the evidence is too thin to support a conclusion, say so plainly instead of \
stretching it."""

# Prompt templates surfaced in the UI (id/label/prompt). These are ordinary
# questions routed through the query pipeline, so new ones are data, not code.
TEMPLATES = (
    {"id": "review-today", "label": "Review today's trading",
     "prompt": "Review my trading today: what happened, what did I do well, what hurt me?"},
    {"id": "find-mistakes", "label": "Find my mistakes",
     "prompt": "What are my biggest and most repeated mistakes, and what do they cost me?"},
    {"id": "best-strategy", "label": "Which strategy works best?",
     "prompt": "Which of my strategies and setups actually perform best, with the numbers?"},
    {"id": "review-risk", "label": "Review my risk",
     "prompt": "Review my current risk posture and how my risk-taking has been trending."},
    {"id": "suggest-improvements", "label": "Suggest improvements",
     "prompt": "Based on my history, what specific behavior changes would improve my results?"},
    {"id": "compare-month", "label": "What changed this month?",
     "prompt": "Compare my recent trading to earlier in the period: what changed in my behavior and results?"},
    {"id": "review-journal", "label": "Review my journal",
     "prompt": "Summarize the themes in my journal: common tags, lessons, and what my notes say I keep repeating."},
)


class AIBusyError(Exception):
    """Per-minute LLM call budget exhausted (mapped to 429 by the routes)."""


# --------------------------------------------------------------------------
# Cost guardrails: call budget + fingerprint cache
# --------------------------------------------------------------------------
_call_times: list[float] = []


def _charge_llm_call() -> None:
    now = time.monotonic()
    while _call_times and now - _call_times[0] > 60.0:
        _call_times.pop(0)
    if len(_call_times) >= settings.AI_CALLS_PER_MIN:
        raise AIBusyError(
            f"AI call budget reached ({settings.AI_CALLS_PER_MIN}/min); try again shortly"
        )
    _call_times.append(now)


_cache: dict[str, tuple[float, dict]] = {}


def _fingerprint(kind: str, params: str, trades: list[dict]) -> str:
    newest = trades[0]["closedMs"] if trades else 0
    total = round(sum(t["pnl"] for t in trades), 6)
    return f"{kind}:{params}:{len(trades)}:{newest}:{total}"


def _cache_get(key: str) -> dict | None:
    hit = _cache.get(key)
    if not hit:
        return None
    expiry, payload = hit
    if time.monotonic() > expiry:
        _cache.pop(key, None)
        return None
    return payload


def _cache_put(key: str, payload: dict) -> None:
    if settings.AI_CACHE_TTL_S <= 0:
        return
    if len(_cache) > 64:  # tiny bound; entries are small dicts
        _cache.clear()
    _cache[key] = (time.monotonic() + settings.AI_CACHE_TTL_S, payload)


def reset_state() -> None:
    """Test seam: clear the cache and the call budget."""
    _cache.clear()
    _call_times.clear()


# --------------------------------------------------------------------------
# Evidence assembly (Mongo reads via the same helpers the dashboard uses)
# --------------------------------------------------------------------------
async def load_trades(start_ms: int, end_ms: int) -> list[dict]:
    closed, entries = await asyncio.gather(
        db.query_history(db.CLOSED_PNL, symbol=None, start_ms=start_ms,
                         end_ms=end_ms, limit=10_000),
        db.journal_query(symbol=None, start_ms=max(0, start_ms - 600_000),
                         end_ms=end_ms + 600_000, limit=10_000),
    )
    return ai_context.build_trades(closed, entries)


async def _live_risk_context() -> tuple[list | None, dict | None]:
    """Open positions + account margin picture, sanitized. Best-effort: a
    down exchange must never block a briefing about historical behavior."""
    try:
        positions_raw, balance_raw = await asyncio.gather(
            dma_client.get_positions(), dma_client.get_wallet_balance(),
        )
        positions = [
            p for p in dma_client.extract_list(positions_raw)
            if isinstance(p, dict) and str(p.get("size", "0")) not in ("", "0")
        ]
        return positions, ai_context.serialize_account(balance_raw)
    except Exception:
        logger.warning("ai briefing: live risk context unavailable; continuing without it")
        return None, None


def _prompt_with_evidence(instruction: str, pack: dict) -> str:
    return (
        instruction
        + "\n\n## Evidence (computed from the trader's own history — cite these numbers)\n"
        + "```json\n" + json.dumps(pack, separators=(",", ":")) + "\n```\n"
    )


def _evidence_lite(pack: dict) -> dict:
    """The slice of the evidence the UI shows alongside a generated text
    (findings + stats), so every narrative ships with its receipts."""
    return {"stats": pack.get("stats"), "findings": pack.get("findings", [])}


def _provider():
    return ai_providers.get_provider()


def _result(text: str, pack: dict, *, cached: bool = False) -> dict:
    p = _provider()
    return {
        "text": text,
        "generatedAtMs": int(time.time() * 1000),
        "live": p.live,          # false => deterministic rule-based output
        "cached": cached,
        "evidence": _evidence_lite(pack),
    }


# --------------------------------------------------------------------------
# Generations
# --------------------------------------------------------------------------
def _clamp_tz(tz_offset_min) -> int | None:
    """Browser-reported minutes east of UTC, bounded to real-world offsets;
    None/garbage means 'server local' (the pre-tz behavior)."""
    try:
        tz = int(tz_offset_min)
    except (TypeError, ValueError):
        return None
    return max(-960, min(960, tz))


def _trader_day_start_ms(now_ms: int, tz: int | None) -> int:
    """Epoch ms of midnight in the TRADER's timezone (server-local when tz is
    None) — 'today' must follow the trader's calendar, not the deploy's."""
    if tz is None:
        dt = datetime.fromtimestamp(now_ms / 1000).replace(
            hour=0, minute=0, second=0, microsecond=0)
        return int(dt.timestamp() * 1000)
    shifted = ai_context.local_dt(now_ms, tz).replace(
        hour=0, minute=0, second=0, microsecond=0)
    return int(shifted.timestamp() * 1000) - tz * 60_000


async def briefing(range_days: int, tz_offset_min=None) -> dict:
    range_days = max(1, min(int(range_days or 7), 90))
    tz = _clamp_tz(tz_offset_min)
    now_ms = int(time.time() * 1000)
    trades = await load_trades(now_ms - range_days * DAY_MS, now_ms)

    key = _fingerprint("briefing", f"{range_days}:{tz}", trades)
    cached = _cache_get(key)
    if cached:
        return {**cached, "cached": True}

    positions, account = await _live_risk_context()
    today_trades = [
        t for t in trades if t["closedMs"] >= _trader_day_start_ms(now_ms, tz)
    ]
    pack = ai_context.evidence_pack(
        trades, range_label=f"last {range_days} days",
        positions=positions, account=account, tz_offset_min=tz,
        extra={"today": ai_context.overall_stats(today_trades)},
    )
    instruction = (
        "Write the trader's intelligence briefing with EXACTLY these markdown-lite "
        "sections:\n"
        "# Today\n# This period\n# Insights\n# Risk observations\n"
        "# Recent mistakes\n# Improvement suggestions\n# Journal highlights\n"
        "Each section: 1-4 tight bullets grounded in the evidence. If a section has "
        "no evidence (e.g. no trades today), say so in one line."
    )
    _charge_llm_call()
    text = await _provider().generate(
        SYSTEM_PROMPT, [{"role": "user", "content": _prompt_with_evidence(instruction, pack)}]
    )
    result = _result(text, pack)
    _cache_put(key, result)
    return result


async def find_trade(trade_id: str) -> tuple[dict | None, dict | None]:
    """(closed row, journal entry) for one `orderId:updatedTime` id. The close
    time is embedded in the id, so the row lookup is a 1ms-window read."""
    order_id, _, updated = trade_id.rpartition(":")
    try:
        ts = int(updated)
    except ValueError:
        return None, None
    rows = await db.query_history(db.CLOSED_PNL, symbol=None, start_ms=ts, end_ms=ts, limit=50)
    row = next(
        (r for r in rows
         if str(r.get("orderId")) == order_id and str(r.get("updatedTime")) == updated),
        None,
    )
    entry = await db.journal_get(trade_id)
    return row, entry


async def trade_review(trade_id: str) -> dict:
    row, entry = await find_trade(trade_id)
    if row is None:
        raise LookupError("trade not found in the history mirror")
    trade = ai_context.serialize_trade(row, entry)
    ts = trade["closedMs"]
    # Context: the surrounding 30 days, so the review can compare this trade
    # against the trader's own baseline (not a market prediction).
    trades = await load_trades(ts - 30 * DAY_MS, ts + DAY_MS)
    pack = ai_context.evidence_pack(
        trades, range_label="30 days around this trade",
        extra={"tradeUnderReview": trade},
    )
    instruction = (
        "Review ONE completed trade (`tradeUnderReview` in the evidence) against the "
        "trader's own 30-day baseline. Sections:\n"
        "# Verdict\n# Entry quality\n# Exit quality\n# Risk & sizing\n"
        "# Execution\n# What to do differently\n"
        "Judge process, not outcome: a profitable trade can be a bad trade. 1-3 "
        "bullets per section, each grounded in the evidence numbers."
    )
    _charge_llm_call()
    text = await _provider().generate(
        SYSTEM_PROMPT, [{"role": "user", "content": _prompt_with_evidence(instruction, pack)}]
    )
    review = {"text": text, "generatedAtMs": int(time.time() * 1000), "live": _provider().live}
    # Persist onto the journal entry (creating a bare entry if none exists) so
    # the review lives with the trade inside the Journal tab.
    await db.journal_upsert(
        trade_id,
        {"aiReview": review, "updatedAtMs": review["generatedAtMs"]},
        insert_fields=journal.insert_fields(trade["symbol"], ts),
    )
    return {**_result(text, pack), "tradeId": trade_id, "trade": trade}


def _period_bounds(period: str, at_ms: int, tz: int | None = None) -> tuple[int, int, str]:
    # Clamp to a sane epoch range: datetime.fromtimestamp raises
    # OverflowError/OSError on absurd stamps, which must be a 400, not a 500.
    at_ms = max(0, min(int(at_ms), 4_102_444_800_000))  # <= year 2100
    at = ai_context.local_dt(at_ms, tz)
    day_start = at.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "day":
        start = day_start
        end = start + timedelta(days=1)
        label = start.strftime("%A, %b %d %Y")
    elif period == "week":
        start = day_start - timedelta(days=day_start.weekday())
        end = start + timedelta(days=7)
        label = f"week of {start.strftime('%b %d %Y')}"
    elif period == "month":
        start = day_start.replace(day=1)
        end = (start + timedelta(days=32)).replace(day=1)
        label = start.strftime("%B %Y")
    else:
        raise ValueError("period must be day, week or month")
    # Aware datetimes here mean "trader wall clock read as UTC" — undo the
    # shift to get real epoch bounds (see ai_context.local_dt).
    shift_ms = (tz or 0) * 60_000 if tz is not None else 0
    start_ms = int(start.timestamp() * 1000) - shift_ms
    end_ms = int(end.timestamp() * 1000) - 1 - shift_ms
    return start_ms, end_ms, label


async def session_review(period: str, at_ms: int | None, tz_offset_min=None) -> dict:
    tz = _clamp_tz(tz_offset_min)
    start_ms, end_ms, label = _period_bounds(
        period, at_ms or int(time.time() * 1000), tz)
    trades = await load_trades(start_ms, end_ms)
    key = _fingerprint("session", f"{period}:{start_ms}:{tz}", trades)
    cached = _cache_get(key)
    if cached:
        return {**cached, "cached": True}
    if not trades:
        pack = ai_context.evidence_pack([], range_label=label)
        return _result(f"No closed trades in the {label} window — nothing to review.", pack)

    best = max(trades, key=lambda t: t["pnl"])
    worst = min(trades, key=lambda t: t["pnl"])
    most_mistagged = max(
        trades, key=lambda t: len((t.get("journal") or {}).get("mistakes") or []),
    )
    pack = ai_context.evidence_pack(
        trades, range_label=label, tz_offset_min=tz,
        extra={
            "bestTrade": best, "worstTrade": worst,
            "mostMistakesTrade": most_mistagged
            if (most_mistagged.get("journal") or {}).get("mistakes") else None,
        },
    )
    instruction = (
        f"Write the trader's {period} review for {label}. Sections:\n"
        "# Summary\n# Best trade\n# Worst trade\n# Patterns of the period\n# One thing to carry forward\n"
        "Use bestTrade/worstTrade/mostMistakesTrade from the evidence where present. "
        "1-3 bullets per section."
    )
    _charge_llm_call()
    text = await _provider().generate(
        SYSTEM_PROMPT, [{"role": "user", "content": _prompt_with_evidence(instruction, pack)}]
    )
    result = _result(text, pack)
    _cache_put(key, result)
    return result


# --------------------------------------------------------------------------
# Natural-language queries + conversation history
# --------------------------------------------------------------------------
QUERY_RANGE_DAYS = 90     # evidence window backing every free-form question
MAX_HISTORY_TURNS = 8     # prior messages replayed to the provider
MAX_QUESTION_LEN = 2000


def new_conversation_doc(title: str) -> dict:
    now = int(time.time() * 1000)
    return {
        "_id": uuid.uuid4().hex,
        "title": (title or "New conversation")[:80],
        "pinned": False,
        "createdAtMs": now,
        "updatedAtMs": now,
        "messages": [],
    }


async def prepare_query(question: str, conversation_id: str | None,
                        tz_offset_min=None) -> dict:
    """Everything the streaming route needs: the target conversation,
    provider messages (history + evidence-grounded question), and the
    evidence slice for the UI. Charges the LLM budget. A NEW conversation is
    only built here (`newDoc`) — record_exchange persists it after the first
    successful answer, so a 429 or a failed stream never litters the sidebar
    with empty conversations."""
    question = str(question or "").strip()
    if not question:
        raise ValueError("question is required")
    if len(question) > MAX_QUESTION_LEN:
        raise ValueError(f"question must be at most {MAX_QUESTION_LEN} characters")

    conv = None
    new_doc = None
    if conversation_id:
        conv = await db.ai_conv_get(conversation_id)
        if conv is None:
            raise LookupError("conversation not found")
    _charge_llm_call()  # after validation, before any expensive work
    if conv is None:
        new_doc = new_conversation_doc(question)

    now_ms = int(time.time() * 1000)
    trades = await load_trades(now_ms - QUERY_RANGE_DAYS * DAY_MS, now_ms)
    pack = ai_context.evidence_pack(
        trades, range_label=f"last {QUERY_RANGE_DAYS} days",
        tz_offset_min=_clamp_tz(tz_offset_min),
    )

    history = [
        {"role": m["role"], "content": m["content"]}
        for m in ((conv or {}).get("messages") or [])[-MAX_HISTORY_TURNS:]
        if m.get("role") in ("user", "assistant") and m.get("content")
    ]
    messages = history + [{"role": "user", "content": _prompt_with_evidence(question, pack)}]
    return {
        "conversationId": (conv or new_doc)["_id"],
        "question": question,
        "system": SYSTEM_PROMPT,
        "messages": messages,
        "evidence": _evidence_lite(pack),
        "newDoc": new_doc,
    }


async def record_exchange(prep: dict, answer: str) -> None:
    now = int(time.time() * 1000)
    msgs = [
        {"role": "user", "content": prep["question"], "tsMs": now},
        {"role": "assistant", "content": answer, "tsMs": now},
    ]
    new_doc = prep.get("newDoc")
    if new_doc is not None:
        doc = dict(new_doc)
        doc["messages"] = msgs
        doc["updatedAtMs"] = now
        await db.ai_conv_create(doc)
    else:
        await db.ai_conv_append(prep["conversationId"], msgs, now)


def status() -> dict:
    """Capabilities only — deliberately not the provider identity (the UI must
    never know or show which provider generated a response)."""
    p = _provider()
    return {
        "ready": True,
        "live": p.live,
        "streaming": p.streaming,
        "callsPerMin": settings.AI_CALLS_PER_MIN,
    }
