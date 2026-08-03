"""Serialization layer + deterministic trading-intelligence engine.

Two jobs, deliberately in one module because the second must only ever see
the output of the first:

1. SERIALIZATION (the privacy boundary). Everything that leaves this process
   toward an LLM provider is built here from EXPLICIT FIELD ALLOWLISTS —
   a record is reduced to the named fields or dropped, so credentials, API
   secrets, cookies, internal ids (orderId/execId), and any field the
   exchange adds tomorrow can never ride along. Numbers are parsed and
   rounded; raw upstream strings never pass through verbatim.

2. DETERMINISTIC ANALYTICS. Streaks, weekday/hour performance, per-symbol/
   strategy/tag/mistake breakdowns, confidence calibration, drawdown,
   overtrading/revenge-trading detection, behavior change. These are computed
   in Python — never by the LLM — and serve double duty: they render directly
   in the UI as evidence cards (honest numbers with no model in the loop),
   and they are embedded into prompts as the evidence pack the narrative must
   cite. The AI explains; it never invents the numbers.

Everything here is pure (no I/O): callers fetch rows from Mongo and pass them
in, which is also what keeps the whole engine unit-testable.
"""
import math
from datetime import datetime, timezone

# --- caps on what an LLM prompt may carry ---
MAX_TRADES_FOR_LLM = 30      # newest N serialized trades in an evidence pack
MAX_FINDINGS_FOR_LLM = 12
NOTES_EXCERPT_LEN = 240
LESSONS_EXCERPT_LEN = 240

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
# Hour-of-day buckets for session analysis (local time).
HOUR_BUCKETS = (
    ("00:00–05:59", 0, 6),
    ("06:00–11:59", 6, 12),
    ("12:00–17:59", 12, 18),
    ("18:00–21:59", 18, 22),
    ("22:00–23:59", 22, 24),
)


def _f(value, digits: int = 4):
    """Finite float rounded to `digits`, else None — the only way a number
    enters a serialized payload."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(n):
        return None
    return round(n, digits)


def _ms(value):
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _clip(value, cap: int) -> str:
    # Backticks are stripped so free text (journal notes) can never terminate
    # the ```json evidence fence a prompt embeds this payload in.
    s = str(value or "").replace("`", "'")
    return s if len(s) <= cap else s[:cap] + "…"


def local_dt(ms: int, tz_offset_min: int | None) -> datetime:
    """The trader's wall-clock datetime for an epoch-ms stamp. tz_offset_min
    is minutes EAST of UTC as reported by the browser (IST = +330); None
    falls back to the server's local timezone (the pre-tz behavior)."""
    if tz_offset_min is None:
        return datetime.fromtimestamp(ms / 1000)
    # Shift the epoch by the offset and read it in UTC: the resulting fields
    # (weekday/hour/...) are the trader's wall clock.
    return datetime.fromtimestamp(ms / 1000 + tz_offset_min * 60, tz=timezone.utc)


# --------------------------------------------------------------------------
# Serializers (the allowlists)
# --------------------------------------------------------------------------
def serialize_trade(row: dict, entry: dict | None = None) -> dict | None:
    """One closed trade reduced to its allowlisted, typed essentials. The
    closing order's side is inverted into the position's direction (a Sell
    close means the position was long). Returns None for rows with no usable
    close time. NOTE: no orderId/execId — the LLM never needs identities."""
    closed_ms = _ms(row.get("updatedTime")) or _ms(row.get("createdTime"))
    if closed_ms is None:
        return None
    opened_ms = _ms(row.get("createdTime"))
    side = str(row.get("side", "")).lower()
    hold_min = None
    if opened_ms and closed_ms > opened_ms:
        hold_min = round((closed_ms - opened_ms) / 60000, 1)
    qty = _f(row.get("qty") if row.get("qty") not in (None, "") else row.get("closedSize"))
    entry_px = _f(row.get("avgEntryPrice"), 8)
    out = {
        "symbol": str(row.get("symbol", ""))[:20],
        "direction": "long" if side == "sell" else "short" if side == "buy" else "unknown",
        "qty": qty,
        "notional": _f((qty or 0) * (entry_px or 0), 2) if qty and entry_px else None,
        "entryPrice": entry_px,
        "exitPrice": _f(row.get("avgExitPrice"), 8),
        "pnl": _f(row.get("closedPnl")) or 0.0,
        "leverage": _f(row.get("leverage"), 2),
        "openedMs": opened_ms,
        "closedMs": closed_ms,
        "holdMinutes": hold_min,
    }
    if entry:
        out["journal"] = serialize_journal_entry(entry)
    return out


def serialize_journal_entry(entry: dict) -> dict:
    """The trader's OWN annotations (safe by nature, still allowlisted +
    excerpted so a prompt never carries unbounded text)."""
    def _score(v):
        return v if isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 5 else None

    return {
        "strategy": _clip(entry.get("strategy"), 60),
        "setup": _clip(entry.get("setup"), 200),
        "tags": [_clip(t, 60) for t in (entry.get("tags") or [])[:20]],
        "mistakes": [_clip(m, 60) for m in (entry.get("mistakes") or [])[:20]],
        "confidence": _score(entry.get("confidence")),
        "executionQuality": _score(entry.get("executionQuality")),
        "rating": _score(entry.get("rating")),
        "reviewStatus": _clip(entry.get("reviewStatus"), 20),
        "notes": _clip(entry.get("notesExcerpt") or entry.get("notes"), NOTES_EXCERPT_LEN),
        "lessons": _clip(entry.get("lessonsExcerpt") or entry.get("lessons"), LESSONS_EXCERPT_LEN),
    }


def serialize_position(p: dict) -> dict:
    """Live position for risk observations — sizes and distances only."""
    mark = _f(p.get("markPrice"), 8)
    liq = _f(p.get("liqPrice"), 8)
    liq_dist = None
    if mark and liq and mark > 0:
        liq_dist = round(abs(mark - liq) / mark * 100, 2)
    return {
        "symbol": str(p.get("symbol", ""))[:20],
        "side": str(p.get("side", ""))[:4],
        "size": _f(p.get("size")),
        "value": _f(p.get("positionValue"), 2),
        "leverage": _f(p.get("leverage"), 2),
        "unrealisedPnl": _f(p.get("unrealisedPnl"), 2),
        "liqDistancePct": liq_dist,
    }


def serialize_account(balance: dict | None) -> dict | None:
    """Margin picture from the wallet envelope (totals only, allowlisted)."""
    if not isinstance(balance, dict):
        return None
    accounts = (((balance.get("result") or {}).get("list")) or [])
    acct = next((a for a in accounts if isinstance(a, dict) and a.get("totalEquity")), None)
    if not acct:
        return None
    equity = _f(acct.get("totalEquity"), 2)
    im = _f(acct.get("totalInitialMargin"), 2)
    margin_bal = _f(acct.get("totalMarginBalance"), 2)
    util = None
    if im is not None and margin_bal:
        util = round(im / margin_bal * 100, 2)
    return {
        "equity": equity,
        "available": _f(acct.get("totalAvailableBalance"), 2),
        "initialMargin": im,
        "maintenanceMargin": _f(acct.get("totalMaintenanceMargin"), 2),
        "marginUtilPct": util,
        "unrealisedPnl": _f(acct.get("totalPerpUPL"), 2),
    }


def build_trades(closed_rows: list, journal_entries: list) -> list[dict]:
    """Serialized trades joined with their journal annotations, newest-first.
    The join key (orderId:updatedTime) is used HERE and then discarded — it
    never appears in the serialized output."""
    by_id = {}
    for e in journal_entries or []:
        # Accept both the raw Mongo doc (_id) and the API shape (id).
        key = e.get("id") or e.get("_id") if isinstance(e, dict) else None
        if key:
            by_id[key] = e
    out = []
    for row in closed_rows or []:
        if not isinstance(row, dict):
            continue
        key = None
        if row.get("orderId") and row.get("updatedTime"):
            key = f"{row['orderId']}:{row['updatedTime']}"
        trade = serialize_trade(row, by_id.get(key))
        if trade is not None:
            out.append(trade)
    out.sort(key=lambda t: t["closedMs"], reverse=True)
    return out


# --------------------------------------------------------------------------
# Deterministic analytics
# --------------------------------------------------------------------------
def overall_stats(trades: list[dict]) -> dict:
    wins = [t for t in trades if t["pnl"] > 0]
    losses = [t for t in trades if t["pnl"] < 0]
    gross_win = sum(t["pnl"] for t in wins)
    gross_loss = -sum(t["pnl"] for t in losses)
    holds = [t["holdMinutes"] for t in trades if t.get("holdMinutes")]
    total = sum(t["pnl"] for t in trades)
    return {
        "trades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "winRatePct": round(len(wins) / len(trades) * 100, 1) if trades else 0.0,
        "netPnl": round(total, 4),
        "grossWin": round(gross_win, 4),
        "grossLoss": round(gross_loss, 4),
        "profitFactor": round(gross_win / gross_loss, 2) if gross_loss > 0 else None,
        "expectancy": round(total / len(trades), 4) if trades else 0.0,
        "avgWin": round(gross_win / len(wins), 4) if wins else 0.0,
        "avgLoss": round(gross_loss / len(losses), 4) if losses else 0.0,
        "largestWin": round(max((t["pnl"] for t in trades), default=0.0), 4),
        "largestLoss": round(min((t["pnl"] for t in trades), default=0.0), 4),
        "avgHoldMinutes": round(sum(holds) / len(holds), 1) if holds else None,
        "journaled": sum(1 for t in trades if t.get("journal")),
        "noted": sum(1 for t in trades if (t.get("journal") or {}).get("notes")),
    }


def breakdown(trades: list[dict], labels_of) -> list[dict]:
    """Generic label aggregation: labels_of(trade) -> iterable of labels."""
    acc: dict = {}
    for t in trades:
        for label in labels_of(t) or ():
            if not label:
                continue
            a = acc.setdefault(label, {"label": label, "trades": 0, "wins": 0, "pnl": 0.0})
            a["trades"] += 1
            if t["pnl"] > 0:
                a["wins"] += 1
            a["pnl"] += t["pnl"]
    out = []
    for a in acc.values():
        a["pnl"] = round(a["pnl"], 4)
        a["winRatePct"] = round(a["wins"] / a["trades"] * 100, 1)
        a["avgPnl"] = round(a["pnl"] / a["trades"], 4)
        out.append(a)
    out.sort(key=lambda a: a["pnl"], reverse=True)
    return out


def by_weekday(trades, tz_offset_min: int | None = None):
    return breakdown(
        trades, lambda t: [WEEKDAYS[local_dt(t["closedMs"], tz_offset_min).weekday()]])


def by_hour_bucket(trades, tz_offset_min: int | None = None):
    def bucket(t):
        hour = local_dt(t["closedMs"], tz_offset_min).hour
        return [label for label, lo, hi in HOUR_BUCKETS if lo <= hour < hi]
    return breakdown(trades, bucket)


def by_symbol(trades):
    return breakdown(trades, lambda t: [t["symbol"]])


def by_strategy(trades):
    return breakdown(trades, lambda t: [(t.get("journal") or {}).get("strategy") or None])


def by_tag(trades):
    return breakdown(trades, lambda t: (t.get("journal") or {}).get("tags") or [])


def by_mistake(trades):
    return breakdown(trades, lambda t: (t.get("journal") or {}).get("mistakes") or [])


def confidence_calibration(trades):
    def conf(t):
        c = (t.get("journal") or {}).get("confidence")
        return [f"confidence {c}"] if c else []
    rows = breakdown(trades, conf)
    rows.sort(key=lambda a: a["label"])
    return rows


def streaks(trades: list[dict]) -> dict:
    """Longest win/loss streaks and the current one, oldest→newest."""
    ordered = sorted(trades, key=lambda t: t["closedMs"])
    longest_win = longest_loss = 0
    run = 0  # positive = win run, negative = loss run
    for t in ordered:
        if t["pnl"] > 0:
            run = run + 1 if run > 0 else 1
            longest_win = max(longest_win, run)
        elif t["pnl"] < 0:
            run = run - 1 if run < 0 else -1
            longest_loss = max(longest_loss, -run)
        else:
            run = 0
    return {"longestWin": longest_win, "longestLoss": longest_loss, "current": run}


def drawdown(trades: list[dict]) -> dict:
    """Deepest fall from a running equity peak (cumulative realized PnL,
    baseline 0), with the period it spanned."""
    ordered = sorted(trades, key=lambda t: t["closedMs"])
    cum = peak = 0.0
    peak_ms = None
    max_dd = 0.0
    dd_start = dd_end = None
    for t in ordered:
        cum += t["pnl"]
        if cum > peak:
            peak = cum
            peak_ms = t["closedMs"]
        dd = peak - cum
        if dd > max_dd:
            max_dd = dd
            dd_start, dd_end = peak_ms, t["closedMs"]
    return {"maxDrawdown": round(max_dd, 4), "startMs": dd_start, "endMs": dd_end}


def overtrading_bursts(trades: list[dict], window_min: int = 60, threshold: int = 5) -> dict:
    """Densest N-minute window; flagged when it holds >= threshold trades."""
    times = sorted(t["closedMs"] for t in trades)
    best = 0
    best_at = None
    j = 0
    for i in range(len(times)):
        while times[i] - times[j] > window_min * 60000:
            j += 1
        if i - j + 1 > best:
            best = i - j + 1
            best_at = times[j]
    return {"maxTradesInWindow": best, "windowMinutes": window_min,
            "atMs": best_at, "flagged": best >= threshold}


def revenge_trades(trades: list[dict], within_min: int = 10) -> dict:
    """Re-entries on the SAME symbol within `within_min` of a loss, sized
    larger than the losing trade — the classic revenge signature. Counted on
    open time when available (else close time)."""
    ordered = sorted(trades, key=lambda t: t["closedMs"])
    count = 0
    pnl_after = 0.0
    for i, t in enumerate(ordered):
        if t["pnl"] >= 0:
            continue
        for later in ordered[i + 1:]:
            start = later.get("openedMs") or later["closedMs"]
            if start - t["closedMs"] > within_min * 60000:
                break
            if (later["symbol"] == t["symbol"] and start >= t["closedMs"]
                    and (later.get("qty") or 0) > (t.get("qty") or 0)):
                count += 1
                pnl_after += later["pnl"]
                break
    return {"count": count, "pnlOfRevengeTrades": round(pnl_after, 4),
            "windowMinutes": within_min}


def oversized_positions(trades: list[dict], factor: float = 2.0) -> dict:
    """Trades whose notional exceeds `factor` × the median notional."""
    notionals = sorted(t["notional"] for t in trades if t.get("notional"))
    if len(notionals) < 4:
        return {"count": 0, "pnl": 0.0, "medianNotional": None}
    median = notionals[len(notionals) // 2]
    big = [t for t in trades if t.get("notional") and t["notional"] > factor * median]
    return {"count": len(big), "pnl": round(sum(t["pnl"] for t in big), 4),
            "medianNotional": round(median, 2),
            "winRatePct": round(sum(1 for t in big if t["pnl"] > 0) / len(big) * 100, 1) if big else None}


def behavior_change(trades: list[dict]) -> dict | None:
    """First half vs second half of the period (by trade order): direction of
    travel for win rate, sizing and journaling discipline."""
    ordered = sorted(trades, key=lambda t: t["closedMs"])
    if len(ordered) < 8:
        return None
    mid = len(ordered) // 2
    def _half(chunk):
        s = overall_stats(chunk)
        notionals = [t["notional"] for t in chunk if t.get("notional")]
        return {
            "trades": s["trades"], "winRatePct": s["winRatePct"], "netPnl": s["netPnl"],
            "avgNotional": round(sum(notionals) / len(notionals), 2) if notionals else None,
            "journaledPct": round(s["journaled"] / s["trades"] * 100, 1) if s["trades"] else 0,
        }
    return {"firstHalf": _half(ordered[:mid]), "secondHalf": _half(ordered[mid:])}


# --------------------------------------------------------------------------
# Findings — thresholded observations with the evidence attached. Severity:
# "good" (reinforce), "warn" (costly habit), "info" (worth knowing).
# --------------------------------------------------------------------------
def _finding(fid, severity, title, detail, evidence):
    return {"id": fid, "severity": severity, "title": title, "detail": detail,
            "evidence": evidence}


def findings(trades: list[dict], tz_offset_min: int | None = None) -> list[dict]:
    out: list[dict] = []
    if not trades:
        return out
    stats = overall_stats(trades)

    # Loss/win asymmetry — the single most common account-killer.
    if stats["avgWin"] and stats["avgLoss"] and stats["losses"] >= 3 and stats["wins"] >= 3:
        ratio = stats["avgLoss"] / stats["avgWin"] if stats["avgWin"] else None
        if ratio and ratio >= 1.5:
            out.append(_finding(
                "loss-asymmetry", "warn", "Average loser dwarfs average winner",
                f"Your average losing trade (-{stats['avgLoss']}) is {round(ratio, 1)}× your "
                f"average winner (+{stats['avgWin']}). Cutting losers at 1× your average "
                "winner would have materially changed the period.",
                {"avgWin": stats["avgWin"], "avgLoss": stats["avgLoss"], "ratio": round(ratio, 2)}))

    # Hold-time asymmetry: sitting in losers, cutting winners.
    win_holds = [t["holdMinutes"] for t in trades if t["pnl"] > 0 and t.get("holdMinutes")]
    loss_holds = [t["holdMinutes"] for t in trades if t["pnl"] < 0 and t.get("holdMinutes")]
    if len(win_holds) >= 3 and len(loss_holds) >= 3:
        avg_w = sum(win_holds) / len(win_holds)
        avg_l = sum(loss_holds) / len(loss_holds)
        if avg_w > 0 and avg_l / avg_w >= 2:
            out.append(_finding(
                "hold-asymmetry", "warn", "Losers are held far longer than winners",
                f"Losing trades are held {round(avg_l)} min on average vs {round(avg_w)} min "
                "for winners — the signature of hoping instead of cutting.",
                {"avgWinHoldMin": round(avg_w, 1), "avgLossHoldMin": round(avg_l, 1)}))

    # Weekday edge (needs a real sample).
    for row in by_weekday(trades, tz_offset_min):
        if row["trades"] >= 5 and row["pnl"] < 0 and row["winRatePct"] < 40:
            out.append(_finding(
                f"weekday-{row['label'].lower()}", "warn",
                f"{row['label']}s are costing you money",
                f"{row['trades']} trades on {row['label']}s: {row['winRatePct']}% win rate, "
                f"{row['pnl']} net.",
                row))
            break  # one weekday warning is enough

    # Session / late-hours edge.
    for row in by_hour_bucket(trades, tz_offset_min):
        if row["trades"] >= 5 and row["pnl"] < 0 and row["winRatePct"] < 40:
            out.append(_finding(
                "session-weak", "warn", f"Weak results in the {row['label']} session",
                f"{row['trades']} trades closed {row['label']}: {row['winRatePct']}% win rate, "
                f"{row['pnl']} net.",
                row))
            break

    # Symbol edge, both directions.
    symbols = [r for r in by_symbol(trades) if r["trades"] >= 5]
    if symbols:
        best, worst = symbols[0], symbols[-1]
        if best["pnl"] > 0 and best["winRatePct"] >= 55:
            out.append(_finding("symbol-best", "good", f"{best['label']} is your edge",
                                f"{best['trades']} trades, {best['winRatePct']}% win rate, "
                                f"+{best['pnl']} net.", best))
        if worst["pnl"] < 0 and worst is not best:
            out.append(_finding("symbol-worst", "warn", f"{worst['label']} keeps taking it back",
                                f"{worst['trades']} trades, {worst['winRatePct']}% win rate, "
                                f"{worst['pnl']} net.", worst))

    # Strategy edge (journal-derived).
    strategies = [r for r in by_strategy(trades) if r["trades"] >= 3]
    if strategies:
        best, worst = strategies[0], strategies[-1]
        if best["pnl"] > 0:
            out.append(_finding("strategy-best", "good", f"“{best['label']}” is working",
                                f"{best['trades']} trades, {best['winRatePct']}% win rate, "
                                f"+{best['pnl']} net.", best))
        if worst["pnl"] < 0 and worst is not best:
            out.append(_finding("strategy-worst", "warn", f"“{worst['label']}” is not working",
                                f"{worst['trades']} trades, {worst['winRatePct']}% win rate, "
                                f"{worst['pnl']} net.", worst))

    # Recurring mistakes and their bill.
    mistakes = by_mistake(trades)
    if mistakes:
        commonest = max(mistakes, key=lambda r: r["trades"])
        if commonest["trades"] >= 3:
            out.append(_finding(
                "mistake-common", "warn", f"Most repeated mistake: {commonest['label']}",
                f"Tagged on {commonest['trades']} trades totalling {commonest['pnl']}.",
                commonest))

    # Confidence calibration inversion.
    calib = {r["label"]: r for r in confidence_calibration(trades)}
    high = calib.get("confidence 4"), calib.get("confidence 5")
    low = calib.get("confidence 1"), calib.get("confidence 2")
    high_rows = [r for r in high if r and r["trades"] >= 3]
    low_rows = [r for r in low if r and r["trades"] >= 3]
    if high_rows and low_rows:
        hi_wr = sum(r["wins"] for r in high_rows) / sum(r["trades"] for r in high_rows) * 100
        lo_wr = sum(r["wins"] for r in low_rows) / sum(r["trades"] for r in low_rows) * 100
        if hi_wr + 5 < lo_wr:
            out.append(_finding(
                "confidence-inverted", "warn", "Your confidence is inverted",
                f"High-confidence trades win {round(hi_wr)}% vs {round(lo_wr)}% for "
                "low-confidence ones — conviction is not translating into edge.",
                {"highConfWinRatePct": round(hi_wr, 1), "lowConfWinRatePct": round(lo_wr, 1)}))

    # Streaks.
    st = streaks(trades)
    if st["longestLoss"] >= 4:
        out.append(_finding(
            "loss-streak", "warn", f"Longest losing streak: {st['longestLoss']} trades",
            "Consider a hard stop after 3 consecutive losses — streaks compound "
            "emotional errors.", st))
    if st["longestWin"] >= 5:
        out.append(_finding("win-streak", "good",
                            f"Longest winning streak: {st['longestWin']} trades", "", st))

    # Revenge trading.
    rev = revenge_trades(trades)
    if rev["count"] >= 2:
        out.append(_finding(
            "revenge", "warn", "Revenge-trading pattern detected",
            f"{rev['count']} times you re-entered the same symbol within "
            f"{rev['windowMinutes']} min of a loss at a LARGER size; those trades "
            f"netted {rev['pnlOfRevengeTrades']}.",
            rev))

    # Overtrading bursts.
    burst = overtrading_bursts(trades)
    if burst["flagged"]:
        out.append(_finding(
            "overtrading", "warn",
            f"{burst['maxTradesInWindow']} trades inside {burst['windowMinutes']} minutes",
            "Bursts like this usually mean reacting to the last trade instead of "
            "the next setup.", burst))

    # Oversized positions.
    big = oversized_positions(trades)
    if big["count"] >= 2 and (big["pnl"] or 0) < 0:
        out.append(_finding(
            "oversizing", "warn", "Oversized positions are net losers",
            f"{big['count']} trades ran at >2× your median notional "
            f"({big['medianNotional']}) and netted {big['pnl']}.",
            big))

    # Drawdown.
    dd = drawdown(trades)
    if dd["maxDrawdown"] > 0 and stats["grossWin"] > 0 and dd["maxDrawdown"] >= 0.5 * stats["grossWin"]:
        out.append(_finding(
            "drawdown", "info", f"Deepest drawdown: {dd['maxDrawdown']}",
            "Measured on realized PnL from the period's equity peak.", dd))

    # Journal discipline.
    if stats["trades"] >= 10:
        pct = stats["journaled"] / stats["trades"] * 100
        if pct < 50:
            out.append(_finding(
                "journal-coverage", "info", "Most trades are unjournaled",
                f"Only {round(pct)}% of trades carry a journal entry — the patterns "
                "above get sharper with more annotations.",
                {"journaledPct": round(pct, 1), "trades": stats["trades"]}))

    order = {"warn": 0, "good": 1, "info": 2}
    out.sort(key=lambda f: order.get(f["severity"], 3))
    return out


# --------------------------------------------------------------------------
# Evidence pack — the ONE structure ai_service embeds into prompts.
# --------------------------------------------------------------------------
def evidence_pack(trades: list[dict], *, range_label: str,
                  positions: list | None = None, account: dict | None = None,
                  extra: dict | None = None, tz_offset_min: int | None = None) -> dict:
    pack = {
        "rangeLabel": range_label,
        "stats": overall_stats(trades),
        "findings": findings(trades, tz_offset_min)[:MAX_FINDINGS_FOR_LLM],
        "byWeekday": by_weekday(trades, tz_offset_min),
        "bySymbol": by_symbol(trades)[:10],
        "byStrategy": by_strategy(trades)[:10],
        "byMistake": by_mistake(trades)[:10],
        "streaks": streaks(trades),
        "drawdown": drawdown(trades),
        "recentTrades": trades[:MAX_TRADES_FOR_LLM],
    }
    if positions is not None:
        pack["openPositions"] = [serialize_position(p) for p in positions if isinstance(p, dict)]
    if account is not None:
        pack["account"] = account
    if extra:
        pack.update(extra)
    return pack
