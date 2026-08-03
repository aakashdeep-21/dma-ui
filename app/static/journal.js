"use strict";
/* ===========================================================================
   TRADING JOURNAL — the "Journal" tab (data-pane="history").

   Architecture (same contract as charts.js / risk.js):
     * This file is loaded BEFORE app.js and only DEFINES consts + functions —
       no DOM access, no network, no storage at load time. app.js boots it
       (wireJournal) and calls onJournalActive() when the tab is shown.
     * Pure, DOM-free core first (sanitizers, join, filters, stats, calendar,
       markdown) so tests/test_snap.mjs can extract them; then engine state;
       then the DOM manager (fetch / autosave / render / wire).
     * Data honesty: every number on screen is either an exchange record from
       the MongoDB mirror or the user's own annotation — never fabricated.
       Missing data renders as "—" and stale mirrors keep their ⚠ label.
     * Journal WRITES (notes/tags/scores) are admin-only annotation calls to
       /api/journal/* — they move no money and never touch the exchange.
       Viewers get a read-only journal. Nothing here can reach writeApi.
     * Performance: reads are range-bounded and excerpt-only (full note text
       loads only when a trade card is expanded); the list renders in pages
       of JN_PAGE with day grouping; autosave is debounced and sends only the
       fields that changed.

   The trade identity is the Closed-PnL record's natural id
   `orderId:updatedTime` — the SAME id the backend mirror stores, so a journal
   entry always re-attaches to its trade without duplicating exchange data.
   =========================================================================== */

// ---------------------------------------------------------------------------
// 1. Pure core — vocabulary (one-line consts: extracted by tests/test_snap.mjs)
// ---------------------------------------------------------------------------
const JN_VIEWS = ["overview", "trades", "calendar", "insights", "fills"];
const JN_RANGES = ["1", "7", "30", "all", "custom"];
const JN_RESULTS = ["all", "win", "loss"];
const JN_SIDES = ["all", "long", "short"];
const JN_STATUSES = ["pending", "reviewed", "needs_attention", "excellent", "follow_up"];
const JN_STATUS_FILTERS = ["all", "queue", "pending", "reviewed", "needs_attention", "excellent", "follow_up", "noted", "unjournaled"];
const JN_SORTS = ["time", "pnl", "rating", "confidence", "duration"];
const JN_STATUS_LABELS = { pending: "To review", reviewed: "Reviewed", needs_attention: "Needs attention", excellent: "Excellent", follow_up: "Follow-up" };
const JN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const JN_MONTH_RE = /^\d{4}-\d{2}$/;
const JN_ID_RE = /^[A-Za-z0-9:_\-]{3,120}$/;
const JN_PAGE = 120;
const JN_EXCERPT = 240;
const JN_VIEW_LABELS = { overview: "Overview", trades: "Trades", calendar: "Calendar", insights: "Insights", fills: "Fills" };

// Coerce ANY value into a valid journal view state (the workspace persistence
// trust boundary — unknown fields dropped, invalid values defaulted).
function jnSanitizeViewState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const str = (v, cap) => (typeof v === "string" ? v.slice(0, cap) : "");
  const score = (v) => (Number.isInteger(v) && v >= 1 && v <= 5 ? v : 0);
  const tags = Array.isArray(src.tags)
    ? src.tags.filter((t) => typeof t === "string" && t).map((t) => t.slice(0, 60)).slice(0, 10)
    : [];
  return {
    view: JN_VIEWS.includes(src.view) ? src.view : "overview",
    range: JN_RANGES.includes(src.range) ? src.range : "30",
    from: JN_DATE_RE.test(src.from || "") ? src.from : "",
    to: JN_DATE_RE.test(src.to || "") ? src.to : "",
    search: str(src.search, 80),
    result: JN_RESULTS.includes(src.result) ? src.result : "all",
    side: JN_SIDES.includes(src.side) ? src.side : "all",
    status: JN_STATUS_FILTERS.includes(src.status) ? src.status : "all",
    strategy: str(src.strategy, 60),
    mistake: str(src.mistake, 60),
    tags,
    confMin: score(src.confMin),
    rateMin: score(src.rateMin),
    sort: JN_SORTS.includes(src.sort) ? src.sort : "time",
    dir: src.dir === "asc" ? "asc" : "desc",
    calMonth: JN_MONTH_RE.test(src.calMonth || "") ? src.calMonth : "",
  };
}

// The journal identity of one closed-PnL row (matches the backend id rules),
// or null when the row can't carry an entry (no usable identity).
function jnTradeId(row) {
  const oid = row && row.orderId;
  const upd = row && row.updatedTime;
  if (!oid || !upd) return null;
  const id = String(oid) + ":" + String(upd);
  return JN_ID_RE.test(id) ? id : null;
}

// Join closed-PnL rows with journal entries (by id) into reviewable trade
// objects. `entries` is the /api/journal/entries list (excerpt shape).
function jnJoin(closedList, entries) {
  const byId = Object.create(null); // null-proto: keys are external data
  (entries || []).forEach((e) => { if (e && e.id) byId[e.id] = e; });
  return (closedList || []).map((row) => {
    const id = jnTradeId(row);
    const pnl = Number(row.closedPnl);
    const closeTs = Number(row.updatedTime ?? row.createdTime);
    const openTs = Number(row.createdTime);
    return {
      id,
      row,
      entry: (id && byId[id]) || null,
      sym: String(row.symbol || ""),
      side: String(row.side || ""), // exchange side of the CLOSING order; Sell closes a long
      pnl: isFinite(pnl) ? pnl : 0,
      ts: isFinite(closeTs) ? closeTs : 0,
      openTs: isFinite(openTs) && openTs > 0 ? openTs : 0,
      durMs: isFinite(closeTs) && isFinite(openTs) && closeTs > openTs ? closeTs - openTs : 0,
    };
  });
}

// Direction of the position that was closed: the closing order's side is the
// OPPOSITE of the position (a Sell closes a long). Unknown side -> "".
function jnDirection(trade) {
  const s = String(trade.side || "").toLowerCase();
  return s === "sell" ? "long" : s === "buy" ? "short" : "";
}

function jnEffectiveStatus(trade) {
  if (!trade.entry) return "";
  return JN_STATUSES.includes(trade.entry.reviewStatus) ? trade.entry.reviewStatus : "pending";
}

// A trade is "in the review queue" until it has been actively reviewed:
// no entry yet, or an entry still marked pending / needs_attention / follow_up.
function jnInQueue(trade) {
  const st = jnEffectiveStatus(trade);
  return !trade.entry || st === "pending" || st === "needs_attention" || st === "follow_up";
}

function jnMatchesSearch(trade, q) {
  if (!q) return true;
  const e = trade.entry;
  const hay = [
    trade.sym, jnDirection(trade),
    e ? e.strategy : "", e ? e.setup : "",
    e ? (e.tags || []).join(" ") : "",
    e ? (e.mistakes || []).join(" ") : "",
    e ? e.notesExcerpt || e.notes || "" : "",
    e ? e.lessonsExcerpt || e.lessons || "" : "",
    e ? JN_STATUS_LABELS[jnEffectiveStatus(trade)] || "" : "",
  ].join(" ").toLowerCase();
  return q.split(/\s+/).every((w) => !w || hay.includes(w));
}

// Apply every active filter (they combine as AND). Pure: view is a sanitized
// view state, trades come from jnJoin.
function jnFilterTrades(trades, view) {
  const q = (view.search || "").trim().toLowerCase();
  return trades.filter((t) => {
    if (view.result === "win" && !(t.pnl > 0)) return false;
    if (view.result === "loss" && !(t.pnl < 0)) return false;
    if (view.side !== "all" && jnDirection(t) !== view.side) return false;
    const st = jnEffectiveStatus(t);
    if (view.status === "queue" && !jnInQueue(t)) return false;
    else if (view.status === "noted" && !(t.entry && t.entry.hasNotes)) return false;
    else if (view.status === "unjournaled" && t.entry) return false;
    else if (JN_STATUSES.includes(view.status)) {
      if (view.status === "pending") { if (t.entry && st !== "pending") return false; if (!t.entry) return false; }
      else if (st !== view.status) return false;
    }
    if (view.strategy) {
      const s = t.entry ? t.entry.strategy || "" : "";
      if (view.strategy === "(none)" ? s !== "" : s !== view.strategy) return false;
    }
    if (view.mistake && !(t.entry && (t.entry.mistakes || []).includes(view.mistake))) return false;
    if (view.tags.length) {
      const has = t.entry ? t.entry.tags || [] : [];
      if (!view.tags.every((tag) => has.includes(tag))) return false;
    }
    if (view.confMin && !(t.entry && t.entry.confidence >= view.confMin)) return false;
    if (view.rateMin && !(t.entry && t.entry.rating >= view.rateMin)) return false;
    return jnMatchesSearch(t, q);
  });
}

function jnSortTrades(trades, sort, dir) {
  const mul = dir === "asc" ? 1 : -1;
  const key = {
    time: (t) => t.ts,
    pnl: (t) => t.pnl,
    rating: (t) => (t.entry && t.entry.rating) || 0,
    confidence: (t) => (t.entry && t.entry.confidence) || 0,
    duration: (t) => t.durMs,
  }[sort] || ((t) => t.ts);
  return trades.slice().sort((a, b) => (key(a) - key(b)) * mul || b.ts - a.ts);
}

// Local-time day key ("YYYY-MM-DD") — the calendar and day grouping both use
// the TRADER's local day, matching how the daily-PnL summary always worked.
function jnDayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// Group an already-sorted trade list into day buckets (order preserved).
function jnGroupDays(trades) {
  const days = [];
  const idx = {};
  trades.forEach((t) => {
    const key = t.ts ? jnDayKey(t.ts) : "unknown";
    if (!(key in idx)) {
      idx[key] = days.length;
      days.push({ key, trades: [], pnl: 0, wins: 0 });
    }
    const day = days[idx[key]];
    day.trades.push(t);
    day.pnl += t.pnl;
    if (t.pnl > 0) day.wins++;
  });
  return days;
}

function jnMonthShift(monthStr, delta) {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth();
  if (JN_MONTH_RE.test(monthStr || "")) {
    y = Number(monthStr.slice(0, 4));
    m = Number(monthStr.slice(5, 7)) - 1;
  }
  const d = new Date(y, m + delta, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

// Month model for the calendar: Monday-first weeks covering the whole month,
// each cell carrying that local day's aggregate (count / pnl / wins / noted).
function jnCalendarModel(trades, monthStr) {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth();
  if (JN_MONTH_RE.test(monthStr || "")) {
    y = Number(monthStr.slice(0, 4));
    m = Number(monthStr.slice(5, 7)) - 1;
  }
  const byDay = {};
  trades.forEach((t) => {
    if (!t.ts) return;
    const key = jnDayKey(t.ts);
    const d = byDay[key] || (byDay[key] = { count: 0, pnl: 0, wins: 0, noted: 0 });
    d.count++;
    d.pnl += t.pnl;
    if (t.pnl > 0) d.wins++;
    if (t.entry && t.entry.hasNotes) d.noted++;
  });
  const first = new Date(y, m, 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7)); // back to Monday
  const weeks = [];
  const cursor = new Date(start);
  do {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const key = jnDayKey(cursor.getTime());
      week.push({
        key,
        dayNum: cursor.getDate(),
        inMonth: cursor.getMonth() === m,
        ...(byDay[key] || { count: 0, pnl: 0, wins: 0, noted: 0 }),
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  } while (cursor.getMonth() === m);
  return {
    year: y, month: m,
    monthKey: y + "-" + String(m + 1).padStart(2, "0"),
    weeks,
  };
}

// Aggregate stats over a trade list (already range/filter-scoped by caller).
function jnStats(trades) {
  const s = {
    count: trades.length, wins: 0, losses: 0, total: 0,
    grossWin: 0, grossLoss: 0, journaled: 0, noted: 0, reviewed: 0, queue: 0,
    ratedSum: 0, ratedCount: 0,
  };
  trades.forEach((t) => {
    s.total += t.pnl;
    if (t.pnl > 0) { s.wins++; s.grossWin += t.pnl; }
    else if (t.pnl < 0) { s.losses++; s.grossLoss += -t.pnl; }
    if (t.entry) s.journaled++;
    if (t.entry && t.entry.hasNotes) s.noted++;
    const st = jnEffectiveStatus(t);
    if (st === "reviewed" || st === "excellent") s.reviewed++;
    if (jnInQueue(t)) s.queue++;
    if (t.entry && t.entry.rating) { s.ratedSum += t.entry.rating; s.ratedCount++; }
  });
  s.winRate = s.count ? (s.wins / s.count) * 100 : 0;
  s.profitFactor = s.grossLoss > 0 ? s.grossWin / s.grossLoss : (s.grossWin > 0 ? Infinity : 0);
  s.expectancy = s.count ? s.total / s.count : 0;
  s.avgWin = s.wins ? s.grossWin / s.wins : 0;
  s.avgLoss = s.losses ? s.grossLoss / s.losses : 0;
  s.avgRating = s.ratedCount ? s.ratedSum / s.ratedCount : 0;
  return s;
}

// Generic label breakdown: getLabels(trade) -> array of labels; returns
// [{label, count, wins, pnl}] (caller sorts). Used for strategies / tags /
// mistakes so the three analyses can never drift apart.
function jnBreakdown(trades, getLabels) {
  // Null-proto: labels are user-authored free text — a tag literally named
  // "__proto__" or "constructor" must be an ordinary key, not a prototype hit.
  const acc = Object.create(null);
  trades.forEach((t) => {
    (getLabels(t) || []).forEach((label) => {
      if (!label) return;
      const a = acc[label] || (acc[label] = { label, count: 0, wins: 0, pnl: 0 });
      a.count++;
      if (t.pnl > 0) a.wins++;
      a.pnl += t.pnl;
    });
  });
  return Object.values(acc);
}

// Score calibration (confidence or executionQuality or rating): buckets 1..5
// with count / wins / pnl, so "does my confidence predict outcomes?" is a
// direct read.
function jnScoreBuckets(trades, field) {
  const buckets = [1, 2, 3, 4, 5].map((score) => ({ score, count: 0, wins: 0, pnl: 0 }));
  trades.forEach((t) => {
    const v = t.entry && t.entry[field];
    if (!Number.isInteger(v) || v < 1 || v > 5) return;
    const b = buckets[v - 1];
    b.count++;
    if (t.pnl > 0) b.wins++;
    b.pnl += t.pnl;
  });
  return buckets;
}

function jnWordCount(text) {
  const s = String(text || "").trim();
  return s ? s.split(/\s+/).length : 0;
}

function jnExcerptText(text) {
  const s = String(text || "");
  if (s.length <= JN_EXCERPT) return s;
  let cut = s.slice(0, JN_EXCERPT);
  const sp = cut.lastIndexOf(" ");
  if (sp > JN_EXCERPT / 2) cut = cut.slice(0, sp);
  return cut + "…";
}

// Client mirror of the server's list shape (app/journal.py shape_entry
// full=False) so a freshly-saved full entry can replace its list-read version
// without a refetch.
function jnListShape(full) {
  const e = Object.assign({}, full);
  const notes = e.notes || "";
  const lessons = e.lessons || "";
  delete e.notes;
  delete e.lessons;
  e.notesExcerpt = jnExcerptText(notes);
  e.lessonsExcerpt = jnExcerptText(lessons);
  e.noteWords = jnWordCount(notes);
  e.hasNotes = !!notes;
  e.hasLessons = !!lessons;
  return e;
}

// Markdown-lite -> safe HTML. The input is ESCAPED FIRST (so no tag can ever
// survive), then a small trusted subset is layered back: #/##/### headings,
// - lists, > quotes, **bold**, *italic*, `code`. Deliberately tiny — this is
// a note preview, not a document engine.
function jnMarkdown(text) {
  const escFn = typeof esc === "function" ? esc : (s) => String(s);
  const inline = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  const out = [];
  let list = false, quote = false;
  const closeBlocks = () => {
    if (list) { out.push("</ul>"); list = false; }
    if (quote) { out.push("</blockquote>"); quote = false; }
  };
  String(text || "").split("\n").forEach((rawLine) => {
    const line = escFn(rawLine);
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { closeBlocks(); out.push(`<h4 class="jn-md-h${h[1].length}">${inline(h[2])}</h4>`); return; }
    if (/^[-*]\s+/.test(line)) {
      if (quote) { out.push("</blockquote>"); quote = false; }
      if (!list) { out.push("<ul>"); list = true; }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
      return;
    }
    if (/^&gt;\s?/.test(line)) {
      if (list) { out.push("</ul>"); list = false; }
      if (!quote) { out.push("<blockquote>"); quote = true; }
      out.push(inline(line.replace(/^&gt;\s?/, "")) + "<br/>");
      return;
    }
    closeBlocks();
    if (line.trim() === "") { out.push("<div class='jn-md-gap'></div>"); return; }
    out.push(`<p>${inline(line)}</p>`);
  });
  closeBlocks();
  return out.join("");
}

// ---------------------------------------------------------------------------
// 2. Engine state (module-private; reset only by refetch/workspace apply)
// ---------------------------------------------------------------------------
let _jnView = jnSanitizeViewState(null); // pure call — safe at load time
let _jnData = null;        // {closed, exec, entries[], errors:{}, syncedLabel, truncated}
let _jnTrades = [];        // joined trade objects (newest-first)
let _jnMeta = null;        // catalogs {tags, strategies, mistakes}
let _jnMetaIsDefault = false;
let _jnSeq = 0;            // monotonic fetch token (newest load owns the screen)
let _jnLoaded = false;
let _jnLoadedAt = 0;
let _jnExpandedId = null;  // id of the open trade card (transient, not persisted)
const _jnFullEntry = {};   // id -> full entry (loaded on expand)
let _jnDirty = null;       // {id, sym, ts, fields:{}} pending autosave
const _jnDirtyBacklog = Object.create(null); // id -> failed dirty batches awaiting retry
let _jnSaving = null;      // in-flight flush promise (serializes saves vs fetch/delete)
const _jnDeleted = Object.create(null);      // ids deleted this session (blocks stale echoes)
const _jnEntryLoading = Object.create(null); // id -> in-flight GET (dedupe on expand)
let _jnSaveTimer = null;
let _jnSaveState = "idle"; // idle | dirty | saving | saved | error
let _jnNotesPreview = false;
let _jnRenderLimit = JN_PAGE;
let _jnWired = false;
let _jnSearchTimer = null;
const _jnPaneCache = {};

function jnPaneVisible() {
  const pane = document.querySelector('[data-pane="history"]');
  return !!pane && !pane.hidden && !document.hidden;
}

function jnCanEdit() {
  return state && state.role === "admin";
}

function jnSet(id, html) {
  if (_jnPaneCache[id] === html) return;
  const el = document.getElementById(id);
  if (!el) return;
  _jnPaneCache[id] = html;
  el.innerHTML = html;
}

function jnInvalidate() {
  Object.keys(_jnPaneCache).forEach((k) => delete _jnPaneCache[k]);
}

// ---------------------------------------------------------------------------
// 3. Fetch layer
// ---------------------------------------------------------------------------
// Both mirror reads + the journal entries read share ONE window so PnL, fee
// analytics and annotations always describe the same period.
function jnQueries() {
  const v = _jnView;
  const now = Date.now();
  let startMs, endMs;
  if (v.range === "all") {
    startMs = 0; endMs = now;
  } else if (v.range === "custom") {
    const from = v.from ? new Date(v.from + "T00:00:00") : null;
    const to = v.to ? new Date(v.to + "T23:59:59.999") : null;
    if (!from || !to || !isFinite(from.getTime()) || !isFinite(to.getTime()) ||
        from.getTime() > to.getTime()) return null;
    startMs = from.getTime(); endMs = to.getTime();
  } else {
    endMs = now;
    startMs = now - Number(v.range) * 86400000;
  }
  let hist;
  if (v.range === "1" || v.range === "7" || v.range === "30") {
    hist = "?days=" + v.range; // keep the server's preset semantics byte-identical
  } else {
    hist = "?startTime=" + startMs + "&endTime=" + endMs;
  }
  // Entries window padded ±10 min: presets are resolved on the SERVER clock
  // for the mirrors but here for entries, and a boundary trade's annotation
  // must never fall out of the join over clock skew. Extra entries that match
  // no on-screen trade are simply never rendered.
  const pad = 10 * 60 * 1000;
  return {
    hist,
    entries: "?startTime=" + Math.max(0, startMs - pad) + "&endTime=" + (endMs + pad),
  };
}

async function jnFetchMeta(force) {
  if (_jnMeta && !force) return;
  try {
    const res = await api("/api/journal/meta");
    _jnMeta = res.meta || { tags: [], strategies: [], mistakes: [] };
    _jnMetaIsDefault = !!res.isDefault;
  } catch (e) {
    if (!_jnMeta) _jnMeta = { tags: [], strategies: [], mistakes: [] };
  }
}

async function jnFetch() {
  const content = document.getElementById("jn-content");
  if (!content) return;
  await jnFlushSave(); // never lose an in-progress edit to a refresh
  const queries = jnQueries();
  const sumEl = document.getElementById("jn-summary");
  if (!queries) {
    if (sumEl) {
      sumEl.hidden = false;
      sumEl.textContent = "Pick a valid From/To range (From must not be after To).";
    }
    return;
  }
  const seq = ++_jnSeq;
  _jnLoadedAt = Date.now();
  if (!_jnData) content.innerHTML = loadingMsg("Loading journal…");
  const [closed, exec, entries] = await Promise.allSettled([
    api("/api/closed-pnl" + queries.hist),
    api("/api/executions" + queries.hist),
    api("/api/journal/entries" + queries.entries),
  ]);
  await jnFetchMeta(false);
  if (seq !== _jnSeq) return; // superseded — a newer load owns the screen
  _jnData = {
    closed: closed.status === "fulfilled" ? closed.value : null,
    closedErr: closed.status === "rejected" ? closed.reason : null,
    exec: exec.status === "fulfilled" ? exec.value : null,
    execErr: exec.status === "rejected" ? exec.reason : null,
    entries: entries.status === "fulfilled" ? (entries.value.entries || []) : [],
    entriesErr: entries.status === "rejected" ? entries.reason : null,
    entriesTruncated: entries.status === "fulfilled" ? !!entries.value.truncated : false,
  };
  _jnLoaded = true;
  jnRecompute();
  jnInvalidate();
  jnPaintControls();
  jnRender();
}

function jnRecompute() {
  const closedList = _jnData && _jnData.closed ? listOf(_jnData.closed) : [];
  _jnTrades = jnJoin(closedList, _jnData ? _jnData.entries : []);
}

// ---------------------------------------------------------------------------
// 4. Autosave layer — debounced, field-level, flush-on-blur/collapse/leave
// ---------------------------------------------------------------------------
function jnPaintSaveState() {
  const el = document.getElementById("jn-savestate");
  if (!el) return;
  const label = {
    idle: "", dirty: "Unsaved…", saving: "Saving…",
    saved: "Saved ✓", error: "⚠ Save failed — will retry",
  }[_jnSaveState] || "";
  el.textContent = label;
  el.className = "jn-savestate" + (_jnSaveState === "error" ? " neg" : _jnSaveState === "saved" ? " pos" : " muted");
}

function jnMarkDirty(trade, field, value) {
  if (!jnCanEdit() || !trade.id) return;
  delete _jnDeleted[trade.id]; // typing again re-creates a deleted entry
  if (_jnDirty && _jnDirty.id !== trade.id) jnFlushSave(); // switching cards: save the old one first
  if (!_jnDirty || _jnDirty.id !== trade.id) {
    _jnDirty = { id: trade.id, sym: trade.sym, ts: trade.ts, fields: {} };
  }
  _jnDirty.fields[field] = value;
  _jnSaveState = "dirty";
  jnPaintSaveState();
  clearTimeout(_jnSaveTimer);
  _jnSaveTimer = setTimeout(jnFlushSave, 900);
}

// Flush every pending save (the live dirty buffer + any failed backlog).
// Serialized: concurrent callers wait for the in-flight pass, then drain what
// is left, so awaiting this REALLY means "all my edits reached the server (or
// sit in the retry backlog with the error state shown)". A failed batch is
// kept per-id — losing it because the user moved to another card would be a
// silent data loss — and a retry timer re-arms until it lands.
async function jnFlushSave() {
  clearTimeout(_jnSaveTimer);
  while (_jnSaving) await _jnSaving;
  const batch = [];
  if (_jnDirty && Object.keys(_jnDirty.fields).length) batch.push(_jnDirty);
  _jnDirty = null;
  Object.keys(_jnDirtyBacklog).forEach((id) => {
    const pending = _jnDirtyBacklog[id];
    delete _jnDirtyBacklog[id];
    const dup = batch.find((d) => d.id === id);
    if (dup) dup.fields = { ...pending.fields, ...dup.fields };
    else batch.push(pending);
  });
  if (!batch.length) return;
  _jnSaveState = "saving";
  jnPaintSaveState();
  _jnSaving = (async () => {
    let failed = false;
    for (const dirty of batch) {
      if (_jnDeleted[dirty.id]) continue; // deleted since — nothing to save
      try {
        const res = await api("/api/journal/entry/" + encodeURIComponent(dirty.id), {
          method: "PUT",
          body: JSON.stringify({ symbol: dirty.sym, tsMs: dirty.ts, ...dirty.fields }),
        });
        if (res.entry) jnAbsorbEntry(res.entry);
      } catch (e) {
        failed = true;
        if (_jnDirty && _jnDirty.id === dirty.id) {
          // Newer live keystrokes win over the failed batch's fields.
          _jnDirty.fields = { ...dirty.fields, ..._jnDirty.fields };
        } else {
          _jnDirtyBacklog[dirty.id] = dirty;
        }
        toast("Journal save failed: " + (e && e.message ? e.message : "unknown error"), "neg");
      }
    }
    const pendingLeft = _jnDirty || Object.keys(_jnDirtyBacklog).length;
    _jnSaveState = failed ? "error" : (pendingLeft ? "dirty" : "saved");
    if (failed || pendingLeft) {
      clearTimeout(_jnSaveTimer);
      _jnSaveTimer = setTimeout(jnFlushSave, failed ? 5000 : 900);
    }
    jnPaintSaveState();
  })();
  try {
    await _jnSaving;
  } finally {
    _jnSaving = null;
  }
}

// Fold a freshly-saved FULL entry back into every client cache: the full-entry
// cache, the list-read entries array, the joined trade, and the on-screen row
// summary cell (without re-rendering the open editor under the user's cursor).
function jnAbsorbEntry(full) {
  // A late save echo must never resurrect an entry deleted since the save
  // started (the delete path already discarded its pending edits).
  if (_jnDeleted[full.id]) return;
  // Never let a save RESPONSE overwrite keystrokes typed while it was in
  // flight: anything still pending for this entry wins over the server echo
  // (it is about to be saved by the next flush anyway).
  const merged = { ...full };
  if (_jnDirty && _jnDirty.id === full.id) Object.assign(merged, _jnDirty.fields);
  _jnFullEntry[full.id] = merged;
  const shaped = jnListShape(merged);
  if (_jnData && Array.isArray(_jnData.entries)) {
    const i = _jnData.entries.findIndex((e) => e.id === full.id);
    if (i >= 0) _jnData.entries[i] = shaped; else _jnData.entries.push(shaped);
  }
  const trade = _jnTrades.find((t) => t.id === full.id);
  if (trade) {
    trade.entry = shaped;
    const cellEl = document.querySelector(`.jn-row[data-jnid="${CSS.escape(full.id)}"] .jn-c-j`);
    if (cellEl) {
      cellEl.innerHTML = jnJournalCell(trade);
      delete _jnPaneCache["jn-content"]; // DOM diverged from the cached string
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Shared render helpers
// ---------------------------------------------------------------------------
function jnSafeColor(color) {
  // Colors land inside style="" attributes; the server already validates
  // #rrggbb but clamp client-side too so a hostile stored value can never
  // smuggle extra CSS declarations.
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color) ? color : "";
}

function jnTagColor(name) {
  if (!_jnMeta) return "";
  const key = String(name).toLowerCase();
  const hit = (_jnMeta.tags || []).find((t) => t.name.toLowerCase() === key);
  return hit ? jnSafeColor(hit.color) : "";
}

function jnTagChip(name, extraCls, dataAttr) {
  const color = jnTagColor(name);
  const dot = color ? `<i class="jn-tagdot" style="background:${esc(color)}"></i>` : "";
  return `<span class="jn-tag${extraCls ? " " + extraCls : ""}"${dataAttr || ""}>${dot}${esc(name)}</span>`;
}

function jnStars(n) {
  const v = Number.isInteger(n) && n >= 1 && n <= 5 ? n : 0;
  return v ? "★".repeat(v) + "☆".repeat(5 - v) : "";
}

function jnStatusChip(trade) {
  const st = jnEffectiveStatus(trade);
  if (!st) return `<span class="jn-status jn-st-none" title="No journal entry yet">—</span>`;
  return `<span class="jn-status jn-st-${esc(st)}">${esc(JN_STATUS_LABELS[st] || st)}</span>`;
}

// The compact journal summary cell on a trade row (also patched in place
// after an autosave — see jnAbsorbEntry).
function jnJournalCell(trade) {
  if (!trade.id) return `<span class="muted" title="This record has no stable identity to journal against">n/a</span>`;
  const e = trade.entry;
  const parts = [jnStatusChip(trade)];
  if (e) {
    if (e.rating) parts.push(`<span class="jn-mini" title="Trade rating">${jnStars(e.rating)}</span>`);
    if (e.hasNotes) parts.push(`<span class="jn-mini" title="${esc(e.noteWords + " words of notes")}">✎ ${esc(String(e.noteWords))}w</span>`);
    if ((e.mistakes || []).length) parts.push(`<span class="jn-mini warn" title="${esc(e.mistakes.join(", "))}">⚠ ${e.mistakes.length}</span>`);
    const tags = e.tags || [];
    tags.slice(0, 3).forEach((t) => parts.push(jnTagChip(t)));
    if (tags.length > 3) parts.push(`<span class="jn-mini muted">+${tags.length - 3}</span>`);
    if (e.strategy) parts.push(`<span class="jn-mini jn-strat" title="Strategy">${esc(e.strategy)}</span>`);
  }
  return parts.join("");
}

function jnRangeTrades() {
  return _jnTrades;
}

function jnFilteredTrades() {
  return jnSortTrades(jnFilterTrades(_jnTrades, _jnView), _jnView.sort, _jnView.dir);
}

function jnSyncedLabel() {
  if (!_jnData || !_jnData.closed) return "";
  const closedMs = Number(_jnData.closed.result && _jnData.closed.result.lastSyncedMs);
  let nowMs = Number(_jnData.closed.result && _jnData.closed.result.nowMs);
  if (_jnData.exec) {
    const execMs = Number(_jnData.exec.result && _jnData.exec.result.lastSyncedMs);
    const execNow = Number(_jnData.exec.result && _jnData.exec.result.nowMs);
    if (isFinite(execNow) && execNow > 0) nowMs = execNow;
    const stamps = [closedMs, execMs].filter((v) => isFinite(v) && v > 0);
    return stamps.length === 2 ? fmtSynced(Math.min(...stamps), nowMs) : "syncing…";
  }
  return fmtSynced(closedMs, nowMs);
}

// ---------------------------------------------------------------------------
// 6. Top-level render
// ---------------------------------------------------------------------------
function jnRender() {
  if (!document.getElementById("jn-content")) return;
  jnPaintSummary();
  const view = _jnView.view;
  if (!_jnData) return;
  if (view === "overview") jnRenderOverview();
  else if (view === "trades") jnRenderTrades();
  else if (view === "calendar") jnRenderCalendar();
  else if (view === "insights") jnRenderInsights();
  else if (view === "fills") jnRenderFills();
}

function jnPaintSummary() {
  const sumEl = document.getElementById("jn-summary");
  const syncEl = document.getElementById("jn-synced");
  if (syncEl) syncEl.textContent = _jnData && _jnData.closed ? "Synced " + jnSyncedLabel() + " · times local" : "";
  if (!sumEl) return;
  if (!_jnData) { sumEl.hidden = true; return; }
  if (!_jnData.closed) {
    sumEl.hidden = false;
    sumEl.innerHTML = `<span class="neg">⚠ ${esc((_jnData.closedErr && _jnData.closedErr.message) || "history unavailable")}</span>`;
    return;
  }
  const s = jnStats(_jnTrades);
  const truncated = !!(_jnData.closed.result && _jnData.closed.result.truncated) || _jnData.entriesTruncated;
  const entriesNote = _jnData.entriesErr
    ? ` · <span class="warn">journal entries unavailable (${esc(_jnData.entriesErr.message || "error")})</span>` : "";
  sumEl.hidden = false;
  sumEl.innerHTML =
    `${s.count} trades · ` +
    `<span class="${pnlClass(s.total)} priv">${fmtMoneySigned(s.total)} ${esc(curUnit())}</span> · ` +
    `Win rate <span class="priv">${s.count ? Math.round(s.winRate) : 0}%</span> · ` +
    `Journaled ${s.journaled}/${s.count} · Review queue ${s.queue}` +
    (truncated ? ` · <span class="warn">⚠ partial (row cap reached)</span>` : "") +
    entriesNote;
}

// --- 6a. Overview -----------------------------------------------------------
function jnRenderOverview() {
  const trades = jnRangeTrades();
  const s = jnStats(trades);
  const fmtPF = s.profitFactor === Infinity ? "∞" : fmtNum(s.profitFactor, 2);
  const tiles =
    `<div class="jn-tiles">` +
    jnTile("Trades", String(s.count)) +
    jnTile("Win rate", s.count ? Math.round(s.winRate) + "%" : "—", pnlClass(s.winRate - 50)) +
    jnTile("Net PnL", fmtMoneySigned(s.total) + " " + esc(curUnit()), pnlClass(s.total)) +
    jnTile("Profit factor", s.count ? fmtPF : "—", s.profitFactor >= 1 ? "pos" : "neg") +
    jnTile("Expectancy / trade", s.count ? fmtMoneySigned(s.expectancy) : "—", pnlClass(s.expectancy)) +
    jnTile("Avg rating", s.ratedCount ? fmtNum(s.avgRating, 1) + " ★" : "—") +
    jnTile("Journaled", s.count ? Math.round((s.journaled / s.count) * 100) + "%" : "—") +
    jnTile("Reviewed", s.count ? Math.round((s.reviewed / s.count) * 100) + "%" : "—") +
    `</div>`;

  // Review queue: newest first — review a trade while it is fresh in memory.
  const queue = trades.filter(jnInQueue).sort((a, b) => b.ts - a.ts);
  const queueRows = queue.slice(0, 8).map((t) => {
    const dir = jnDirection(t);
    return `<button class="jn-qitem" data-jnopen="${esc(t.id || "")}" ${t.id ? "" : "disabled"}>` +
      `<span class="mono muted">${esc(fmtTime(t.ts))}</span>` +
      `<span class="mono">${esc(t.sym)}</span>` +
      `<span class="${dir === "long" ? "pos" : "neg"}">${esc(dir.toUpperCase() || "?")}</span>` +
      `<span class="mono ${pnlClass(t.pnl)} priv">${fmtMoneySigned(t.pnl)}</span>` +
      jnStatusChip(t) +
      `</button>`;
  }).join("");
  const queueCard = jnWidget("Review queue",
    queue.length ? `${queue.length} awaiting review` : "All caught up",
    queue.length
      ? `<div class="jn-qlist">${queueRows}</div>` +
        (queue.length > 8 ? `<button class="btn-ghost sm" data-jnact="queue-all">See all ${queue.length} →</button>` : "")
      : `<p class="muted center" style="padding:14px">Every trade in this range has been reviewed. 🎉</p>`);

  // Recent notes (by last edit).
  const noted = trades
    .filter((t) => t.entry && t.entry.hasNotes)
    .sort((a, b) => (b.entry.updatedAtMs || 0) - (a.entry.updatedAtMs || 0))
    .slice(0, 6);
  const notesCard = jnWidget("Recent notes", noted.length ? "" : null,
    noted.length
      ? noted.map((t) =>
          `<button class="jn-noteitem" data-jnopen="${esc(t.id)}">` +
          `<span class="jn-noteitem-head"><span class="mono">${esc(t.sym)}</span>` +
          `<span class="mono ${pnlClass(t.pnl)} priv">${fmtMoneySigned(t.pnl)}</span>` +
          `<span class="muted">${esc(fmtTime(t.entry.updatedAtMs || t.ts))}</span></span>` +
          `<span class="jn-noteitem-x">${esc(t.entry.notesExcerpt || "")}</span>` +
          `</button>`).join("")
      : emptyMsg("No notes yet — expand a trade and start writing."));

  // Common mistakes (count + what they cost).
  const mistakes = jnBreakdown(trades, (t) => (t.entry && t.entry.mistakes) || [])
    .sort((a, b) => b.count - a.count).slice(0, 6);
  const mistakesCard = jnWidget("Common mistakes", null,
    mistakes.length
      ? `<table class="jn-minitable"><tbody>` + mistakes.map((m) =>
          `<tr data-jnmkfilter="${esc(m.label)}" role="button" tabindex="0">` +
          `<td>${esc(m.label)}</td><td class="mono num">${m.count}×</td>` +
          `<td class="mono num ${pnlClass(m.pnl)} priv">${fmtMoneySigned(m.pnl)}</td></tr>`).join("") +
        `</tbody></table>`
      : emptyMsg("No mistakes recorded. Tag them honestly — they are the raw material of improvement."));

  // Strategy breakdown.
  const strategies = jnBreakdown(trades, (t) => (t.entry && t.entry.strategy ? [t.entry.strategy] : []))
    .sort((a, b) => b.pnl - a.pnl).slice(0, 6);
  const stratCard = jnWidget("Strategy breakdown", null,
    strategies.length
      ? `<table class="jn-minitable"><tbody>` + strategies.map((x) =>
          `<tr data-jnstfilter="${esc(x.label)}" role="button" tabindex="0">` +
          `<td>${esc(x.label)}</td><td class="mono num">${x.count}</td>` +
          `<td class="mono num">${x.count ? Math.round((x.wins / x.count) * 100) : 0}%</td>` +
          `<td class="mono num ${pnlClass(x.pnl)} priv">${fmtMoneySigned(x.pnl)}</td></tr>`).join("") +
        `</tbody></table>`
      : emptyMsg("Assign strategies to trades to see which ones actually pay."));

  // Tag distribution (click a tag to filter the trade list by it).
  const tagDist = jnBreakdown(trades, (t) => (t.entry && t.entry.tags) || [])
    .sort((a, b) => b.count - a.count).slice(0, 18);
  const tagsCard = jnWidget("Tag distribution", null,
    tagDist.length
      ? `<div class="jn-tagcloud">` + tagDist.map((x) =>
          `<button class="jn-tag jn-tag-btn" data-jntagfilter="${esc(x.label)}">` +
          (jnTagColor(x.label) ? `<i class="jn-tagdot" style="background:${esc(jnTagColor(x.label))}"></i>` : "") +
          `${esc(x.label)} <span class="muted">${x.count}</span></button>`).join("") + `</div>`
      : emptyMsg("No tags yet."));

  // Mini calendar (this month, compact).
  const cal = jnCalendarModel(trades, _jnView.calMonth);
  const miniCal = jnWidget("Calendar", jnMonthTitle(cal), jnCalendarGrid(cal, true) +
    `<button class="btn-ghost sm" data-jnact="open-calendar" style="margin-top:8px">Full calendar →</button>`);

  jnSet("jn-content",
    tiles +
    `<div class="jn-cards">` +
    queueCard + notesCard + mistakesCard + stratCard + tagsCard + miniCal +
    `</div>`);
}

function jnTile(label, valueHtml, cls) {
  return `<div class="jn-tile"><div class="k">${esc(label)}</div><div class="v priv ${cls || ""}">${valueHtml}</div></div>`;
}

function jnWidget(title, meta, bodyHtml) {
  return `<div class="jn-widget"><div class="jn-widget-head"><h3>${esc(title)}</h3>` +
    (meta ? `<span class="muted">${esc(meta)}</span>` : "") + `</div>${bodyHtml}</div>`;
}

// --- 6b. Trades list --------------------------------------------------------
function jnRenderTrades() {
  if (_jnData && !_jnData.closed) {
    // A failed history read must read as a FAILURE, not as "no trades".
    jnSet("jn-content", errorMsg(_jnData.closedErr && _jnData.closedErr.message));
    return;
  }
  const trades = jnFilteredTrades();
  if (!trades.length) {
    jnSet("jn-content", emptyMsg(_jnTrades.length
      ? "No trades match the current filters."
      : "No closed trades in this range."));
    return;
  }
  const capped = trades.slice(0, _jnRenderLimit);
  let html = "";
  if (_jnView.sort === "time") {
    jnGroupDays(capped).forEach((day) => {
      html += `<div class="jn-day"><div class="jn-day-head">` +
        `<span>${esc(jnDayLabel(day.key))}</span>` +
        `<span class="muted">${day.trades.length} trade${day.trades.length === 1 ? "" : "s"}</span>` +
        `<span class="mono ${pnlClass(day.pnl)} priv">${fmtMoneySigned(day.pnl)}</span>` +
        `<span class="muted">${Math.round((day.wins / day.trades.length) * 100)}% win</span>` +
        `</div>` + day.trades.map(jnTradeRow).join("") + `</div>`;
    });
  } else {
    html += `<div class="jn-day">` + capped.map(jnTradeRow).join("") + `</div>`;
  }
  if (trades.length > _jnRenderLimit) {
    html += `<button class="btn-ghost sm jn-more" data-jnact="more">Show more (${trades.length - _jnRenderLimit} remaining)</button>`;
  }
  jnSet("jn-content", `<div class="jn-list">${html}</div>`);
  if (_jnExpandedId) jnMountEditor(_jnExpandedId);
}

function jnDayLabel(key) {
  if (!JN_DATE_RE.test(key)) return key;
  const d = new Date(key + "T12:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

function jnTradeRow(t) {
  const dir = jnDirection(t);
  const r = t.row;
  const expanded = t.id && t.id === _jnExpandedId;
  const time = t.ts ? new Date(t.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "—";
  const qty = r.qty ?? r.closedSize;
  const lev = r.leverage ? ` × ${esc(String(r.leverage))}x` : "";
  return `<div class="jn-row${expanded ? " exp" : ""}" data-jnid="${esc(t.id || "")}" role="button" tabindex="0" aria-expanded="${expanded}">` +
    `<span class="jn-c-time mono muted">${esc(time)}</span>` +
    `<span class="jn-c-sym mono">${esc(t.sym)}</span>` +
    `<span class="jn-c-side ${dir === "long" ? "pos" : "neg"}">${esc((dir || "?").toUpperCase())}</span>` +
    `<span class="jn-c-qty mono muted priv">${esc(cell(qty))}${lev}</span>` +
    `<span class="jn-c-px mono muted">${esc(cell(r.avgEntryPrice))} → ${esc(cell(r.avgExitPrice))}</span>` +
    `<span class="jn-c-dur mono muted">${t.durMs ? esc(fmtDuration(t.durMs)) : "—"}</span>` +
    `<span class="jn-c-pnl mono ${pnlClass(t.pnl)} priv">${fmtMoneySigned(t.pnl)}</span>` +
    `<span class="jn-c-j">${jnJournalCell(t)}</span>` +
    `</div>` +
    (expanded ? `<div class="jn-card" data-jncard="${esc(t.id)}">${loadingMsg("Loading entry…")}</div>` : "");
}

// --- 6c. Expanded trade card (facts + timeline + editor) --------------------
async function jnMountEditor(id) {
  const trade = _jnTrades.find((t) => t.id === id);
  if (!trade) return;
  let full = _jnFullEntry[id];
  if (full === undefined) {
    // Deduped load: a re-render while the GET is in flight reuses the same
    // request instead of firing a second identical one.
    if (!_jnEntryLoading[id]) {
      _jnEntryLoading[id] = api("/api/journal/entry/" + encodeURIComponent(id))
        .finally(() => { delete _jnEntryLoading[id]; });
    }
    try {
      const res = await _jnEntryLoading[id];
      full = res.entry; // may be null (no entry yet)
      _jnFullEntry[id] = full;
    } catch (e) {
      const h = document.querySelector(`.jn-card[data-jncard="${CSS.escape(id)}"]`);
      if (h) h.innerHTML = errorMsg("Could not load the journal entry: " + (e.message || "error"));
      return;
    }
    if (_jnExpandedId !== id) return; // collapsed while loading
  }
  // Re-query AFTER any await: a re-render may have replaced the node.
  const holder = document.querySelector(`.jn-card[data-jncard="${CSS.escape(id)}"]`);
  if (!holder) return;
  holder.innerHTML = jnEditorHtml(trade, full);
  delete _jnPaneCache["jn-content"]; // DOM diverged from the cached string
  jnPaintSaveState();
}

function jnEntryOrBlank(full) {
  return full || {
    notes: "", lessons: "", setup: "", strategy: "", tags: [], mistakes: [],
    confidence: null, executionQuality: null, rating: null, reviewStatus: "pending",
  };
}

function jnEditorHtml(trade, full) {
  const e = jnEntryOrBlank(full);
  const r = trade.row;
  const canEdit = jnCanEdit();
  const fills = jnTradeFills(trade);
  const fees = fills.reduce((acc, f) => {
    const v = Number(f.execFee);
    return isFinite(v) ? acc + v : acc;
  }, 0);

  const facts =
    `<div class="jn-factgrid">` +
    jnFact("Opened", trade.openTs ? fmtTime(trade.openTs) : "—") +
    jnFact("Closed", fmtTime(trade.ts)) +
    jnFact("Held", trade.durMs ? fmtDuration(trade.durMs) : "—") +
    jnFact("Qty", esc(cell(r.qty ?? r.closedSize)), true) +
    jnFact("Entry", esc(cell(r.avgEntryPrice))) +
    jnFact("Exit", esc(cell(r.avgExitPrice))) +
    jnFact("Leverage", r.leverage ? esc(String(r.leverage)) + "x" : "—") +
    jnFact("Closed PnL", `<span class="${pnlClass(trade.pnl)}">${fmtMoneySigned(trade.pnl)} ${esc(curUnit())}</span>`, true) +
    jnFact("Fees (window)", fills.length ? `<span>${fmtMoney(fees, 4)}</span>` : "—", true) +
    `</div>`;

  const timeline = jnTimelineHtml(trade, fills, full);

  return `<div class="jn-card-cols">` +
    `<div class="jn-facts"><h3>Trade</h3>${facts}<h3>Timeline</h3>${timeline}</div>` +
    `<div class="jn-form${canEdit ? "" : " jn-ro"}">` +
    `<div class="jn-form-head"><h3>Review</h3><span id="jn-savestate" class="jn-savestate muted"></span>` +
    (canEdit && full ? `<button class="btn-ghost sm" data-jnact="delentry" title="Delete this journal entry (the trade itself is exchange history and stays)">Delete entry</button>` : "") +
    `</div>` +
    jnStatusSegHtml(e, canEdit) +
    `<div class="jn-frow">` +
    `<label class="jn-lbl">Strategy${jnStrategySelect(e, canEdit)}</label>` +
    `<label class="jn-lbl">Setup<input id="jn-setup" maxlength="200" value="${esc(e.setup || "")}" placeholder="e.g. Range break + retest" ${canEdit ? "" : "disabled"}/></label>` +
    `</div>` +
    `<div class="jn-frow">` +
    jnScoreRow("Confidence", "confidence", e.confidence, canEdit) +
    jnScoreRow("Execution", "executionQuality", e.executionQuality, canEdit) +
    jnScoreRow("Rating", "rating", e.rating, canEdit) +
    `</div>` +
    `<div class="jn-lbl">Tags${jnLabelPicker("tags", e.tags || [], canEdit)}</div>` +
    `<div class="jn-lbl">Mistakes${jnLabelPicker("mistakes", e.mistakes || [], canEdit)}</div>` +
    `<div class="jn-lbl jn-notes-lbl">Notes` +
    `<span class="jn-notes-tools">` +
    `<button class="btn-ghost sm${_jnNotesPreview ? "" : " active"}" data-jnact="write">Write</button>` +
    `<button class="btn-ghost sm${_jnNotesPreview ? " active" : ""}" data-jnact="preview">Preview</button>` +
    `<span class="muted" id="jn-wc">${jnWordCount(e.notes)} words</span></span>` +
    (_jnNotesPreview
      ? `<div class="jn-md" id="jn-notes-preview">${e.notes ? jnMarkdown(e.notes) : '<p class="muted">Nothing to preview.</p>'}</div>`
      : `<textarea id="jn-notes" rows="7" maxlength="20000" placeholder="Why did you take this trade? What did you see? What was the plan — and did you follow it?&#10;&#10;Markdown-lite: **bold**, *italic*, \`code\`, # heading, - list, > quote" ${canEdit ? "" : "disabled"}>${esc(e.notes || "")}</textarea>`) +
    `</div>` +
    `<div class="jn-lbl">Lessons learned<textarea id="jn-lessons" rows="2" maxlength="5000" placeholder="One honest sentence beats a page of hindsight." ${canEdit ? "" : "disabled"}>${esc(e.lessons || "")}</textarea></div>` +
    (canEdit ? "" : `<p class="muted" style="margin:4px 0 0">Read-only — journal edits require the admin role.</p>`) +
    `</div></div>`;
}

function jnFact(k, vHtml, priv) {
  return `<div class="jn-fact"><span class="k">${esc(k)}</span><span class="v mono${priv ? " priv" : ""}">${vHtml}</span></div>`;
}

// Fills observed for this symbol between open and close (± a minute) in the
// SAME fetched window — honestly labelled: it is the mirror's view, filtered
// client-side, not a per-order lookup.
function jnTradeFills(trade) {
  if (!_jnData || !_jnData.exec) return [];
  const lo = (trade.openTs || trade.ts) - 60000;
  const hi = trade.ts + 60000;
  return listOf(_jnData.exec).filter((x) => {
    if (String(x.symbol || "") !== trade.sym) return false;
    const t = Number(x.execTime);
    return isFinite(t) && t >= lo && t <= hi;
  }).sort((a, b) => Number(a.execTime) - Number(b.execTime));
}

function jnTimelineHtml(trade, fills, full) {
  const items = [];
  if (trade.openTs) items.push({ t: trade.openTs, cls: "open", html: `Position opened` });
  fills.forEach((f) => {
    const t = Number(f.execTime);
    if (!isFinite(t)) return;
    if (String(f.execType || "") === "Funding") {
      items.push({ t, cls: "funding", html: `Funding <span class="mono priv">${esc(cell(f.execFee))}</span>` });
    } else {
      items.push({
        t, cls: String(f.side || "").toLowerCase() === "buy" ? "buy" : "sell",
        html: `${esc(cell(f.side))} fill <span class="mono priv">${esc(cell(f.execQty))}</span> @ <span class="mono">${esc(cell(f.execPrice))}</span>`,
      });
    }
  });
  items.push({ t: trade.ts, cls: "close", html: `Position closed · <span class="mono ${pnlClass(trade.pnl)} priv">${fmtMoneySigned(trade.pnl)}</span>` });
  if (full && full.createdAtMs) items.push({ t: full.createdAtMs, cls: "journal", html: `Journal entry created` });
  if (full && full.updatedAtMs && full.updatedAtMs !== full.createdAtMs) {
    items.push({ t: full.updatedAtMs, cls: "journal", html: `Review last updated` });
  }
  items.sort((a, b) => a.t - b.t);
  return `<ol class="jn-timeline">` + items.map((it) =>
    `<li class="jn-tl-${it.cls}"><span class="mono muted">${esc(fmtTime(it.t))}</span><span>${it.html}</span></li>`).join("") + `</ol>`;
}

function jnStatusSegHtml(e, canEdit) {
  const cur = JN_STATUSES.includes(e.reviewStatus) ? e.reviewStatus : "pending";
  return `<div class="jn-stseg" role="group" aria-label="Review status">` +
    JN_STATUSES.map((st) =>
      `<button class="jn-stbtn jn-st-${st}${st === cur ? " active" : ""}" data-jnstatus="${st}" aria-pressed="${st === cur}" ${canEdit ? "" : "disabled"}>${esc(JN_STATUS_LABELS[st])}</button>`).join("") +
    `</div>`;
}

function jnStrategySelect(e, canEdit) {
  const known = jnKnownStrategies();
  const cur = e.strategy || "";
  if (cur && !known.includes(cur)) known.push(cur);
  return `<select id="jn-strategy" ${canEdit ? "" : "disabled"}>` +
    `<option value="">— none —</option>` +
    known.map((s) => `<option value="${esc(s)}"${s === cur ? " selected" : ""}>${esc(s)}</option>`).join("") +
    (canEdit ? `<option value="__new__">＋ New strategy…</option>` : "") +
    `</select>`;
}

function jnKnownStrategies() {
  const set = [];
  const push = (n) => { if (n && !set.includes(n)) set.push(n); };
  if (_jnMeta) (_jnMeta.strategies || []).forEach((s) => push(s.name));
  _jnTrades.forEach((t) => { if (t.entry) push(t.entry.strategy); });
  return set;
}

function jnKnownLabels(kind) {
  // kind: "tags" | "mistakes" — catalog first, then anything observed on entries.
  const set = [];
  const push = (n) => { if (n && !set.includes(n)) set.push(n); };
  if (_jnMeta) ((kind === "tags" ? _jnMeta.tags : _jnMeta.mistakes) || []).forEach((x) => push(x.name));
  _jnTrades.forEach((t) => { if (t.entry) ((kind === "tags" ? t.entry.tags : t.entry.mistakes) || []).forEach(push); });
  return set;
}

function jnStarRowSpan(field, label, value, canEdit) {
  const v = Number.isInteger(value) ? value : 0;
  return `<span class="jn-starrow" role="group" aria-label="${esc(label)} 1 to 5">` +
    [1, 2, 3, 4, 5].map((n) =>
      `<button class="jn-star${n <= v ? " on" : ""}" data-jnstar="${field}:${n}" aria-pressed="${n === v}" title="${esc(label)} ${n}/5" ${canEdit ? "" : "disabled"}>★</button>`).join("") +
    `</span>`;
}

function jnScoreRow(label, field, value, canEdit) {
  return `<div class="jn-lbl">${esc(label)}${jnStarRowSpan(field, label, value, canEdit)}</div>`;
}

function jnLabelPicker(kind, selected, canEdit) {
  const all = jnKnownLabels(kind);
  selected.forEach((s) => { if (!all.includes(s)) all.push(s); });
  const chips = all.map((name) => {
    const on = selected.includes(name);
    const color = kind === "tags" ? jnTagColor(name) : "";
    const dot = color ? `<i class="jn-tagdot" style="background:${esc(color)}"></i>` : "";
    return `<button class="jn-tag jn-tag-btn${on ? " on" : ""}${kind === "mistakes" ? " jn-mk" : ""}" data-jnpick="${kind}:${esc(name)}" aria-pressed="${on}" ${canEdit ? "" : "disabled"}>${dot}${esc(name)}</button>`;
  }).join("");
  const adder = canEdit
    ? `<span class="jn-add"><input id="jn-add-${kind}" maxlength="60" placeholder="＋ add ${kind === "tags" ? "tag" : "mistake"}…" /></span>`
    : "";
  return `<div class="jn-picker">${chips}${adder}</div>`;
}

// --- 6d. Calendar -----------------------------------------------------------
function jnMonthTitle(cal) {
  return new Date(cal.year, cal.month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function jnCalendarGrid(cal, mini) {
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const maxAbs = Math.max(1, ...cal.weeks.flat().map((c) => Math.abs(c.pnl)));
  const todayKey = jnDayKey(Date.now());
  let html = `<div class="jn-cal${mini ? " mini" : ""}" role="grid" aria-label="Trading calendar">` +
    `<div class="jn-cal-row jn-cal-head" role="row">` + wd.map((d) => `<span>${d}</span>`).join("") + `</div>`;
  cal.weeks.forEach((week) => {
    html += `<div class="jn-cal-row" role="row">` + week.map((c) => {
      const tint = c.count ? Math.min(0.55, 0.15 + 0.4 * (Math.abs(c.pnl) / maxAbs)) : 0;
      const bg = c.count
        ? (c.pnl > 0 ? `background:rgba(0,201,141,${tint})` : c.pnl < 0 ? `background:rgba(255,77,103,${tint})` : "")
        : "";
      const cls = "jn-cal-cell" + (c.inMonth ? "" : " out") + (c.key === todayKey ? " today" : "") + (c.count ? " has" : "");
      const body = c.count && !mini
        ? `<span class="jn-cal-n">${c.count}t</span>` +
          `<span class="jn-cal-pnl mono priv ${pnlClass(c.pnl)}">${fmtMoneySigned(c.pnl)}</span>` +
          `<span class="jn-cal-wr muted">${Math.round((c.wins / c.count) * 100)}%${c.noted ? " ✎" : ""}</span>`
        : (c.count && mini ? `<span class="jn-cal-n">${c.count}</span>` : "");
      return `<button class="${cls}" style="${bg}" data-jnday="${c.key}" ${c.count ? "" : 'tabindex="-1"'} aria-label="${c.key}: ${c.count} trades">` +
        `<span class="jn-cal-d">${c.dayNum}</span>${body}</button>`;
    }).join("") + `</div>`;
  });
  return html + `</div>`;
}

function jnRenderCalendar() {
  const cal = jnCalendarModel(jnRangeTrades(), _jnView.calMonth);
  const monthTrades = jnRangeTrades().filter((t) => t.ts && jnDayKey(t.ts).slice(0, 7) === cal.monthKey);
  const s = jnStats(monthTrades);
  const head =
    `<div class="jn-cal-nav">` +
    `<button class="btn-ghost sm" data-jnact="cal-prev" aria-label="Previous month">←</button>` +
    `<h3>${esc(jnMonthTitle(cal))}</h3>` +
    `<button class="btn-ghost sm" data-jnact="cal-next" aria-label="Next month">→</button>` +
    `<button class="btn-ghost sm" data-jnact="cal-today">Today</button>` +
    `<span class="muted">${s.count} trades · <span class="mono ${pnlClass(s.total)} priv">${fmtMoneySigned(s.total)}</span> · ${s.count ? Math.round(s.winRate) : 0}% win</span>` +
    `</div>`;
  jnSet("jn-content", head + jnCalendarGrid(cal, false) +
    `<p class="muted" style="margin-top:8px">Click a day to open its trades. ✎ marks days with notes. ` +
    `Days outside the fetched range show no data — widen the range above if needed.</p>`);
}

// --- 6e. Insights -----------------------------------------------------------
function jnRenderInsights() {
  const trades = jnRangeTrades();
  // Fee/maker/taker tallies for the classic analytics block (same math the
  // History tab always used).
  let fees = null, maker = null, taker = null;
  if (_jnData.exec) {
    listOf(_jnData.exec).forEach((x) => {
      const f = Number(x.execFee);
      if (isFinite(f)) fees = (fees || 0) + f;
      if (x.isMaker === true || x.isMaker === "true") maker = (maker || 0) + 1;
      else if (x.isMaker === false || x.isMaker === "false") taker = (taker || 0) + 1;
    });
    if (fees == null) fees = 0;
    maker = maker || 0; taker = taker || 0;
  }

  const strat = jnBreakdown(trades, (t) => (t.entry && t.entry.strategy ? [t.entry.strategy] : [])).sort((a, b) => b.pnl - a.pnl);
  const tags = jnBreakdown(trades, (t) => (t.entry && t.entry.tags) || []).sort((a, b) => b.pnl - a.pnl);
  const mistakes = jnBreakdown(trades, (t) => (t.entry && t.entry.mistakes) || []).sort((a, b) => a.pnl - b.pnl);
  const noted = trades.filter((t) => t.entry && t.entry.hasNotes);
  const unnoted = trades.filter((t) => !(t.entry && t.entry.hasNotes));
  const sNoted = jnStats(noted), sUnnoted = jnStats(unnoted);

  const best = strat[0], worst = strat.length > 1 ? strat[strat.length - 1] : null;
  const topTag = tags[0];
  const costliest = mistakes[0];
  const commonest = mistakes.slice().sort((a, b) => b.count - a.count)[0];

  const highlights = `<div class="jn-tiles">` +
    jnTile("Best strategy", best ? esc(best.label) + ` <span class="pos">${fmtMoneySigned(best.pnl)}</span>` : "—") +
    jnTile("Worst strategy", worst ? esc(worst.label) + ` <span class="${pnlClass(worst.pnl)}">${fmtMoneySigned(worst.pnl)}</span>` : "—") +
    jnTile("Most profitable tag", topTag && topTag.pnl > 0 ? esc(topTag.label) + ` <span class="pos">${fmtMoneySigned(topTag.pnl)}</span>` : "—") +
    jnTile("Costliest mistake", costliest && costliest.pnl < 0 ? esc(costliest.label) + ` <span class="neg">${fmtMoneySigned(costliest.pnl)}</span>` : "—") +
    jnTile("Most common mistake", commonest ? `${esc(commonest.label)} <span class="muted">${commonest.count}×</span>` : "—") +
    jnTile("Journaled trades", `<span class="${sNoted.total >= sUnnoted.total ? "pos" : ""}">${fmtMoneySigned(sNoted.expectancy)}</span>/t vs <span>${fmtMoneySigned(sUnnoted.expectancy)}</span>/t`) +
    `</div>`;

  const table = (rows, labelHead) => rows.length
    ? `<div class="table-wrap"><table class="jn-table"><thead><tr><th style="text-align:left">${esc(labelHead)}</th><th>Trades</th><th>Win %</th><th>Total</th><th>Avg</th></tr></thead><tbody>` +
      rows.map((x) =>
        `<tr><td style="text-align:left">${esc(x.label)}</td><td class="mono">${x.count}</td>` +
        `<td class="mono">${x.count ? Math.round((x.wins / x.count) * 100) : 0}%</td>` +
        `<td class="mono ${pnlClass(x.pnl)} priv">${fmtMoneySigned(x.pnl)}</td>` +
        `<td class="mono ${pnlClass(x.pnl)} priv">${fmtMoneySigned(x.count ? x.pnl / x.count : 0)}</td></tr>`).join("") +
      `</tbody></table></div>`
    : emptyMsg("Nothing recorded yet.");

  const calib = (field, title, hint) => {
    const buckets = jnScoreBuckets(trades, field);
    const any = buckets.some((b) => b.count);
    if (!any) return jnWidget(title, null, emptyMsg(hint));
    const maxN = Math.max(1, ...buckets.map((b) => b.count));
    return jnWidget(title, null, `<div class="jn-calib">` + buckets.map((b) =>
      `<div class="jn-calib-row"><span class="jn-calib-k mono">${jnStars(b.score)}</span>` +
      `<span class="jn-calib-bar"><i style="width:${Math.round((b.count / maxN) * 100)}%"></i></span>` +
      `<span class="mono muted">${b.count}</span>` +
      `<span class="mono">${b.count ? Math.round((b.wins / b.count) * 100) + "%" : "—"}</span>` +
      `<span class="mono ${pnlClass(b.pnl)} priv">${b.count ? fmtMoneySigned(b.pnl / b.count) : "—"}</span></div>`).join("") +
      `<div class="jn-calib-row jn-calib-head"><span class="jn-calib-k"></span><span class="jn-calib-bar muted">count</span><span class="muted">n</span><span class="muted">win</span><span class="muted">avg</span></div></div>`);
  };

  jnSet("jn-content",
    highlights +
    `<div id="history-analytics" class="analytics" hidden></div>` +
    `<div class="jn-cards">` +
    jnWidget("Strategy performance", null, table(strat, "Strategy")) +
    jnWidget("Tag performance", null, table(tags.slice(0, 12), "Tag")) +
    jnWidget("Mistake cost", null, table(mistakes.slice(0, 12), "Mistake")) +
    calib("confidence", "Confidence calibration", "Rate your confidence on entries to compare conviction against outcomes.") +
    calib("executionQuality", "Execution quality", "Score how well you executed the plan (independent of PnL).") +
    calib("rating", "Trade rating", "Rate trade quality — a good loss can outrank a lucky win.") +
    `</div>`);
  // The classic PnL analytics (equity curve, drawdown, PF, per-symbol,
  // weekday) render into the #history-analytics container just created.
  const closedList = _jnData.closed ? listOf(_jnData.closed) : [];
  if (closedList.length && typeof renderHistoryAnalytics === "function") {
    renderHistoryAnalytics(closedList, fees, maker, taker);
  }
}

// --- 6f. Fills (executions — the preserved trade-history table) --------------
function jnRenderFills() {
  if (_jnData.exec) {
    jnSet("jn-content", renderExecutions(_jnData.exec));
  } else {
    jnSet("jn-content", errorMsg(_jnData.execErr && _jnData.execErr.message));
  }
}

// ---------------------------------------------------------------------------
// 7. Control painting (toolbar reflects _jnView; options reflect the catalogs)
// ---------------------------------------------------------------------------
function jnPaintControls() {
  const seg = document.getElementById("jn-views");
  if (seg) seg.querySelectorAll("button").forEach((b) => {
    const on = b.dataset.jnview === _jnView.view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  const set = (id, val) => { const el = document.getElementById(id); if (el && el.value !== val) el.value = val; };
  set("jn-range", _jnView.range);
  const from = document.getElementById("jn-from");
  const to = document.getElementById("jn-to");
  if (from && to) {
    from.hidden = to.hidden = _jnView.range !== "custom";
    if (_jnView.from) from.value = _jnView.from;
    if (_jnView.to) to.value = _jnView.to;
  }
  set("jn-search", _jnView.search);
  set("jn-f-result", _jnView.result);
  set("jn-f-side", _jnView.side);
  set("jn-f-status", _jnView.status);
  set("jn-f-conf", String(_jnView.confMin));
  set("jn-f-rating", String(_jnView.rateMin));
  set("jn-sort", _jnView.sort + ":" + _jnView.dir);

  // Dynamic option lists (strategy / mistake) — union of catalog + observed.
  const fillSel = (id, values, current, anyLabel, extra) => {
    const el = document.getElementById(id);
    if (!el) return;
    let html = `<option value="">${esc(anyLabel)}</option>` + (extra || "");
    values.forEach((v) => { html += `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(v)}</option>`; });
    // A restored filter value not (yet) in the option union must stay VISIBLE
    // as the active filter, not silently display as "Any" while still filtering.
    if (current && current !== "(none)" && !values.includes(current)) {
      html += `<option value="${esc(current)}" selected>${esc(current)}</option>`;
    }
    el.innerHTML = html;
    el.value = current || "";
  };
  fillSel("jn-f-strategy", jnKnownStrategies(), _jnView.strategy, "Any strategy",
    `<option value="(none)"${_jnView.strategy === "(none)" ? " selected" : ""}>(no strategy)</option>`);
  fillSel("jn-f-mistake", jnKnownLabels("mistakes"), _jnView.mistake, "Any mistake");

  // Tag filter bar: active chips (click to remove) + an add-select.
  const bar = document.getElementById("jn-tagbar");
  if (bar) {
    const avail = jnKnownLabels("tags").filter((t) => !_jnView.tags.includes(t));
    bar.innerHTML =
      _jnView.tags.map((t) => jnTagChip(t + " ✕", "on jn-tag-btn", ` role="button" tabindex="0" data-jntagoff="${esc(t)}"`)).join("") +
      (avail.length
        ? `<select id="jn-f-tag" aria-label="Filter by tag"><option value="">+ tag filter</option>` +
          avail.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("") + `</select>`
        : "");
  }
  const clear = document.getElementById("jn-clear");
  if (clear) clear.hidden = !jnHasActiveFilters();
}

function jnHasActiveFilters() {
  const v = _jnView;
  return !!(v.search || v.result !== "all" || v.side !== "all" || v.status !== "all" ||
    v.strategy || v.mistake || v.tags.length || v.confMin || v.rateMin);
}

function jnViewChanged(opts = {}) {
  _jnRenderLimit = JN_PAGE;
  if (opts.collapse !== false && _jnExpandedId) { jnFlushSave(); _jnExpandedId = null; }
  jnInvalidate();
  jnPaintControls();
  if (opts.refetch) jnFetch();
  else jnRender();
  if (typeof wsAutoSave === "function") wsAutoSave();
}

// ---------------------------------------------------------------------------
// 8. Actions
// ---------------------------------------------------------------------------
function jnSwitchView(view) {
  if (!JN_VIEWS.includes(view) || _jnView.view === view) return;
  _jnView.view = view;
  jnViewChanged({ collapse: false });
}

function jnGotoDay(key) {
  if (!JN_DATE_RE.test(key)) return;
  _jnView.view = "trades";
  _jnView.range = "custom";
  _jnView.from = key;
  _jnView.to = key;
  jnViewChanged({ refetch: true });
}

function jnOpenTrade(id) {
  if (!id) return;
  _jnView.view = "trades";
  // If the current filters hide this trade, relax them (keep the range).
  const present = () => jnFilteredTrades().some((t) => t.id === id);
  if (!present()) {
    Object.assign(_jnView, {
      search: "", result: "all", side: "all", status: "all",
      strategy: "", mistake: "", tags: [], confMin: 0, rateMin: 0,
    });
  }
  const idx = jnFilteredTrades().findIndex((t) => t.id === id);
  if (idx >= _jnRenderLimit) _jnRenderLimit = idx + JN_PAGE;
  _jnExpandedId = id;
  _jnNotesPreview = false;
  jnInvalidate();
  jnPaintControls();
  jnRender();
  const row = document.querySelector(`.jn-row[data-jnid="${CSS.escape(id)}"]`);
  if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
  if (typeof wsAutoSave === "function") wsAutoSave();
}

function jnReviewNext() {
  const next = jnRangeTrades().filter((t) => t.id && jnInQueue(t)).sort((a, b) => b.ts - a.ts)[0];
  if (next) jnOpenTrade(next.id);
  else toast("Review queue is empty — every trade in this range is reviewed.", "pos");
}

function jnToggleExpand(id) {
  if (!id) return;
  if (_jnExpandedId === id) {
    jnFlushSave();
    _jnExpandedId = null;
  } else {
    jnFlushSave();
    _jnExpandedId = id;
    _jnNotesPreview = false;
  }
  jnInvalidate();
  jnRender();
}

function jnCurrentTrade() {
  return _jnTrades.find((t) => t.id === _jnExpandedId) || null;
}

// Toggle a tag/mistake on the open entry (chip click), saving via autosave.
function jnPickLabel(kind, name) {
  const trade = jnCurrentTrade();
  if (!trade) return;
  const full = jnEntryOrBlank(_jnFullEntry[trade.id]);
  const list = (kind === "tags" ? full.tags : full.mistakes) || [];
  const next = list.includes(name) ? list.filter((x) => x !== name) : list.concat([name]);
  if (kind === "tags") full.tags = next; else full.mistakes = next;
  _jnFullEntry[trade.id] = full;
  jnMarkDirty(trade, kind, next);
  // Repaint just the picker row + row cell (never the textareas).
  const holder = document.querySelector(`.jn-card[data-jncard="${CSS.escape(trade.id)}"]`);
  if (holder) {
    const pickers = holder.querySelectorAll(".jn-picker");
    const idx = kind === "tags" ? 0 : 1;
    if (pickers[idx]) {
      pickers[idx].outerHTML = jnLabelPicker(kind, next, jnCanEdit());
      delete _jnPaneCache["jn-content"]; // DOM diverged from the cached string
    }
  }
}

// Add a brand-new label from the editor input: applies it to the entry AND
// (admin) registers it in the catalog so it becomes reusable everywhere.
async function jnAddLabel(kind, rawName) {
  const name = String(rawName || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) return;
  const known = jnKnownLabels(kind);
  const existing = known.find((k) => k.toLowerCase() === name.toLowerCase());
  jnPickLabel(kind, existing || name);
  if (!existing && _jnMeta && jnCanEdit()) {
    const listKey = kind === "tags" ? "tags" : "mistakes";
    _jnMeta[listKey] = (_jnMeta[listKey] || []).concat([{ name, color: "" }]);
    try {
      await api("/api/journal/meta", { method: "PUT", body: JSON.stringify(_jnMeta) });
      _jnMetaIsDefault = false;
    } catch (e) {
      toast("Could not save the new label to the catalog: " + (e.message || "error"), "warn");
    }
  }
}

async function jnNewStrategy() {
  const name = (window.prompt("New strategy name:") || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const trade = jnCurrentTrade();
  if (!name || !trade) return null;
  if (_jnMeta && jnCanEdit() &&
      !(_jnMeta.strategies || []).some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    _jnMeta.strategies = (_jnMeta.strategies || []).concat([{ name, color: "" }]);
    try {
      await api("/api/journal/meta", { method: "PUT", body: JSON.stringify(_jnMeta) });
      _jnMetaIsDefault = false;
    } catch (e) { /* the entry still saves; catalog can be retried later */ }
  }
  return name;
}

async function jnDeleteEntry() {
  const trade = jnCurrentTrade();
  if (!trade || !_jnFullEntry[trade.id]) return;
  if (!window.confirm("Delete this journal entry (notes, tags, scores)? The trade itself is exchange history and stays.")) return;
  // Discard THIS entry's pending edits, then let any other in-flight save
  // finish before deleting — otherwise a late PUT could re-create the entry
  // server-side an instant after the DELETE.
  if (_jnDirty && _jnDirty.id === trade.id) _jnDirty = null;
  delete _jnDirtyBacklog[trade.id];
  await jnFlushSave();
  _jnDeleted[trade.id] = true; // blocks any stale save echo from resurrecting it
  try {
    await api("/api/journal/entry/" + encodeURIComponent(trade.id), { method: "DELETE" });
  } catch (e) {
    delete _jnDeleted[trade.id];
    toast("Delete failed: " + (e.message || "error"), "neg");
    return;
  }
  delete _jnFullEntry[trade.id];
  trade.entry = null;
  if (_jnData) _jnData.entries = (_jnData.entries || []).filter((x) => x.id !== trade.id);
  _jnSaveState = "idle";
  jnInvalidate();
  jnRender();
  toast("Journal entry deleted.", "info");
}

// ---------------------------------------------------------------------------
// 9. Label manager (catalog editor: rename / recolor / delete, admin-only)
// ---------------------------------------------------------------------------
let _jnMetaDraft = null;

async function jnOpenLabels() {
  // Usable before the first journal fetch too: pull the catalogs on demand.
  if (!_jnMeta) await jnFetchMeta(false);
  if (!_jnMeta) { toast("Journal catalogs unavailable right now.", "warn"); return; }
  _jnMetaDraft = JSON.parse(JSON.stringify({
    tags: _jnMeta.tags || [], strategies: _jnMeta.strategies || [], mistakes: _jnMeta.mistakes || [],
  }));
  // Remember original names so SAVE can translate edits into entry-wide renames.
  ["tags", "strategies", "mistakes"].forEach((k) => _jnMetaDraft[k].forEach((x) => { x._orig = x.name; }));
  jnPaintLabels();
  const ov = document.getElementById("jn-meta-overlay");
  if (ov) { ov.hidden = false; const inp = ov.querySelector("input"); if (inp) inp.focus(); }
}

function jnCloseLabels() {
  const ov = document.getElementById("jn-meta-overlay");
  if (ov) ov.hidden = true;
  _jnMetaDraft = null;
}

function jnLabelUsage(kind, name) {
  let n = 0;
  _jnTrades.forEach((t) => {
    if (!t.entry) return;
    if (kind === "strategies") { if (t.entry.strategy === name) n++; }
    else if (((kind === "tags" ? t.entry.tags : t.entry.mistakes) || []).includes(name)) n++;
  });
  return n;
}

function jnPaintLabels() {
  const body = document.getElementById("jn-meta-body");
  if (!body || !_jnMetaDraft) return;
  const section = (kind, title, colored) =>
    `<div class="jn-meta-sec"><h3>${esc(title)}</h3>` +
    _jnMetaDraft[kind].map((x, i) =>
      `<div class="jn-meta-row">` +
      (colored ? `<input type="color" value="${esc(jnSafeColor(x.color) || "#5661e0")}" data-jnmetacolor="${kind}:${i}" aria-label="Color" title="Chip color"/>` : "") +
      `<input value="${esc(x.name)}" maxlength="60" data-jnmetaname="${kind}:${i}" aria-label="Name"/>` +
      `<span class="muted mono">${jnLabelUsage(kind, x._orig || x.name)}×</span>` +
      `<button class="btn-ghost sm" data-jnmetadel="${kind}:${i}" title="Remove from catalog AND strip from every entry">✕</button>` +
      `</div>`).join("") +
    `<div class="jn-meta-row"><input placeholder="＋ add ${esc(title.toLowerCase())}…" maxlength="60" data-jnmetaadd="${kind}"/></div>` +
    `</div>`;
  body.innerHTML =
    (_jnMetaIsDefault
      ? `<p class="muted">These are starter suggestions — Save stores your own catalog.</p>` : "") +
    section("tags", "Tags", true) +
    section("strategies", "Strategies", false) +
    section("mistakes", "Mistakes", false) +
    `<p class="muted">Renames propagate to every entry on save. Removing a label strips it from every entry (the notes stay).</p>`;
}

async function jnSaveLabels() {
  if (!_jnMetaDraft) return;
  const btn = document.getElementById("jn-meta-save");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    // 1. Apply renames + removals to the ENTRIES first (server-side rewrite).
    const kindMap = { tags: "tag", strategies: "strategy", mistakes: "mistake" };
    for (const kind of ["tags", "strategies", "mistakes"]) {
      const draft = _jnMetaDraft[kind];
      // A row whose name was blanked out counts as a DELETION (it is dropped
      // from the catalog below, so its entries must be stripped too).
      const kept = new Set(
        draft.filter((x) => x._orig && String(x.name || "").trim()).map((x) => x._orig)
      );
      for (const x of draft) {
        const name = String(x.name || "").replace(/\s+/g, " ").trim();
        if (x._orig && name && name !== x._orig) {
          await api("/api/journal/meta/rename", {
            method: "POST",
            body: JSON.stringify({ kind: kindMap[kind], from: x._orig, to: name }),
          });
        }
      }
      for (const orig of (_jnMeta[kind] || []).map((x) => x.name)) {
        if (!kept.has(orig)) {
          await api("/api/journal/meta/rename", {
            method: "POST",
            body: JSON.stringify({ kind: kindMap[kind], from: orig, to: null }),
          });
        }
      }
    }
    // 2. Persist the catalog itself.
    // Draft colors only change via the color inputs' input events, so an
    // untouched colorless label keeps color:"" (the picker's default swatch
    // value is presentation-only and never read back).
    const clean = (arr) => arr
      .map((x) => ({ name: String(x.name || "").replace(/\s+/g, " ").trim(), color: x.color || "" }))
      .filter((x) => x.name);
    const payload = {
      tags: clean(_jnMetaDraft.tags),
      strategies: clean(_jnMetaDraft.strategies),
      mistakes: clean(_jnMetaDraft.mistakes),
    };
    const res = await api("/api/journal/meta", { method: "PUT", body: JSON.stringify(payload) });
    _jnMeta = res.meta;
    _jnMetaIsDefault = false;
    jnCloseLabels();
    Object.keys(_jnFullEntry).forEach((k) => delete _jnFullEntry[k]); // renamed server-side
    toast("Labels saved.", "pos");
    jnFetch(); // entries changed server-side — re-sync the view
  } catch (e) {
    toast("Label save failed: " + (e.message || "error"), "neg");
    if (btn) { btn.disabled = false; btn.textContent = "Save"; }
  }
}

// ---------------------------------------------------------------------------
// 10. Workspace + lifecycle contract (called from app.js)
// ---------------------------------------------------------------------------
function jnCaptureViewState() { return jnSanitizeViewState(_jnView); }

function jnApplyViewState(raw) {
  jnFlushSave();
  _jnView = jnSanitizeViewState(raw);
  _jnExpandedId = null;
  _jnRenderLimit = JN_PAGE;
  jnInvalidate();
  jnPaintControls();
  if (!_jnLoaded) return;
  // The restored range may differ from what is cached — refetch honestly, but
  // only when the journal is actually on screen; otherwise just mark the data
  // unloaded so the next tab entry fetches (a workspace switch on another tab
  // must not cost a ~10k-row read).
  if (jnPaneVisible()) jnFetch();
  else _jnLoaded = false;
}

function jnRerenderCurrency() {
  jnInvalidate();
  if (_jnLoaded) jnRender();
}

function onJournalActive() {
  if (!_jnLoaded) { jnFetch(); return; }
  // The mirror syncs every minute; a view older than that is quietly stale.
  if (Date.now() - _jnLoadedAt > 60000) jnFetch();
}

// ---------------------------------------------------------------------------
// 11. Wiring (called once from app.js boot, BEFORE wireWorkspaces)
// ---------------------------------------------------------------------------
function wireJournal() {
  if (_jnWired) return;
  _jnWired = true;
  const pane = document.querySelector('[data-pane="history"]');
  if (!pane) return;

  // Viewer role: hide the label-manager launcher (server enforces anyway).
  if (!jnCanEdit()) {
    const lb = document.getElementById("jn-labels");
    if (lb) lb.hidden = true;
  }

  // -- toolbar --
  const seg = document.getElementById("jn-views");
  if (seg) seg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-jnview]");
    if (b) jnSwitchView(b.dataset.jnview);
  });
  const range = document.getElementById("jn-range");
  const from = document.getElementById("jn-from");
  const to = document.getElementById("jn-to");
  if (range) range.addEventListener("change", () => {
    _jnView.range = JN_RANGES.includes(range.value) ? range.value : "30";
    if (_jnView.range === "custom" && !_jnView.from && !_jnView.to) {
      const now = new Date();
      _jnView.to = toDateInputValue(now);
      _jnView.from = toDateInputValue(new Date(now.getTime() - 30 * 86400000));
    }
    jnViewChanged({ refetch: true });
  });
  [[from, "from"], [to, "to"]].forEach(([el, key]) => {
    if (el) el.addEventListener("change", () => {
      _jnView[key] = JN_DATE_RE.test(el.value) ? el.value : "";
      jnViewChanged({ refetch: true });
    });
  });
  const search = document.getElementById("jn-search");
  if (search) search.addEventListener("input", () => {
    clearTimeout(_jnSearchTimer);
    _jnSearchTimer = setTimeout(() => {
      _jnView.search = search.value.slice(0, 80);
      _jnRenderLimit = JN_PAGE;
      jnInvalidate();
      jnRender();
      const clear = document.getElementById("jn-clear");
      if (clear) clear.hidden = !jnHasActiveFilters();
      if (typeof wsAutoSave === "function") wsAutoSave();
    }, 250);
  });
  const refresh = document.getElementById("jn-refresh");
  if (refresh) refresh.addEventListener("click", () => jnFetch());
  const labelsBtn = document.getElementById("jn-labels");
  if (labelsBtn) labelsBtn.addEventListener("click", jnOpenLabels);

  // -- filter bar --
  const bindSel = (id, apply) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => { apply(el.value); jnViewChanged(); });
  };
  bindSel("jn-f-result", (v) => { _jnView.result = JN_RESULTS.includes(v) ? v : "all"; });
  bindSel("jn-f-side", (v) => { _jnView.side = JN_SIDES.includes(v) ? v : "all"; });
  bindSel("jn-f-status", (v) => { _jnView.status = JN_STATUS_FILTERS.includes(v) ? v : "all"; });
  bindSel("jn-f-strategy", (v) => { _jnView.strategy = v.slice(0, 60); });
  bindSel("jn-f-mistake", (v) => { _jnView.mistake = v.slice(0, 60); });
  bindSel("jn-f-conf", (v) => { _jnView.confMin = Math.max(0, Math.min(5, Number(v) || 0)); });
  bindSel("jn-f-rating", (v) => { _jnView.rateMin = Math.max(0, Math.min(5, Number(v) || 0)); });
  bindSel("jn-sort", (v) => {
    const [sort, dir] = String(v).split(":");
    _jnView.sort = JN_SORTS.includes(sort) ? sort : "time";
    _jnView.dir = dir === "asc" ? "asc" : "desc";
  });
  const clear = document.getElementById("jn-clear");
  if (clear) clear.addEventListener("click", () => {
    Object.assign(_jnView, {
      search: "", result: "all", side: "all", status: "all",
      strategy: "", mistake: "", tags: [], confMin: 0, rateMin: 0,
    });
    jnViewChanged();
  });
  const tagbar = document.getElementById("jn-tagbar");
  if (tagbar) {
    tagbar.addEventListener("change", (e) => {
      if (e.target && e.target.id === "jn-f-tag" && e.target.value) {
        if (!_jnView.tags.includes(e.target.value)) _jnView.tags = _jnView.tags.concat([e.target.value]).slice(0, 10);
        jnViewChanged();
      }
    });
    tagbar.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-jntagoff]");
      if (chip) { _jnView.tags = _jnView.tags.filter((t) => t !== chip.dataset.jntagoff); jnViewChanged(); }
    });
  }

  // -- delegated content interactions --
  pane.addEventListener("click", (e) => {
    const act = e.target.closest("[data-jnact]");
    if (act) {
      const a = act.dataset.jnact;
      if (a === "more") { _jnRenderLimit += JN_PAGE; jnInvalidate(); jnRender(); }
      else if (a === "open-calendar") jnSwitchView("calendar");
      else if (a === "queue-all") { _jnView.status = "queue"; _jnView.view = "trades"; jnViewChanged(); }
      else if (a === "cal-prev") { _jnView.calMonth = jnMonthShift(_jnView.calMonth, -1); jnViewChanged({ collapse: false }); }
      else if (a === "cal-next") { _jnView.calMonth = jnMonthShift(_jnView.calMonth, 1); jnViewChanged({ collapse: false }); }
      else if (a === "cal-today") { _jnView.calMonth = ""; jnViewChanged({ collapse: false }); }
      else if (a === "delentry") jnDeleteEntry();
      else if (a === "write" || a === "preview") {
        const trade = jnCurrentTrade();
        if (trade) {
          const ta = document.getElementById("jn-notes");
          if (ta) { // capture latest text before swapping to preview
            const full = jnEntryOrBlank(_jnFullEntry[trade.id]);
            full.notes = ta.value;
            _jnFullEntry[trade.id] = full;
          }
          _jnNotesPreview = a === "preview";
          jnMountEditor(trade.id);
        }
      }
      return;
    }
    const day = e.target.closest("[data-jnday]");
    if (day && day.dataset.jnday) {
      const model = jnCalendarModel(jnRangeTrades(), _jnView.calMonth);
      const cellData = model.weeks.flat().find((c) => c.key === day.dataset.jnday);
      if (cellData && cellData.count) jnGotoDay(day.dataset.jnday);
      return;
    }
    const open = e.target.closest("[data-jnopen]");
    if (open && open.dataset.jnopen) { jnOpenTrade(open.dataset.jnopen); return; }
    const tagf = e.target.closest("[data-jntagfilter]");
    if (tagf) {
      if (!_jnView.tags.includes(tagf.dataset.jntagfilter)) _jnView.tags = _jnView.tags.concat([tagf.dataset.jntagfilter]).slice(0, 10);
      _jnView.view = "trades";
      jnViewChanged();
      return;
    }
    const mkf = e.target.closest("[data-jnmkfilter]");
    if (mkf) { _jnView.mistake = mkf.dataset.jnmkfilter; _jnView.view = "trades"; jnViewChanged(); return; }
    const stf = e.target.closest("[data-jnstfilter]");
    if (stf) { _jnView.strategy = stf.dataset.jnstfilter; _jnView.view = "trades"; jnViewChanged(); return; }
    const pick = e.target.closest("[data-jnpick]");
    if (pick) {
      const [kind, ...rest] = pick.dataset.jnpick.split(":");
      jnPickLabel(kind, rest.join(":"));
      return;
    }
    const star = e.target.closest("[data-jnstar]");
    if (star) {
      const [field, nStr] = star.dataset.jnstar.split(":");
      const trade = jnCurrentTrade();
      if (trade) {
        const full = jnEntryOrBlank(_jnFullEntry[trade.id]);
        const n = Number(nStr);
        const next = full[field] === n ? null : n; // clicking the same star clears
        full[field] = next;
        _jnFullEntry[trade.id] = full;
        jnMarkDirty(trade, field, next);
        const row = star.closest(".jn-starrow");
        const label = { confidence: "Confidence", executionQuality: "Execution", rating: "Rating" }[field] || field;
        if (row) {
          row.outerHTML = jnStarRowSpan(field, label, next, jnCanEdit());
          delete _jnPaneCache["jn-content"]; // DOM diverged from the cached string
        }
      }
      return;
    }
    const stbtn = e.target.closest("[data-jnstatus]");
    if (stbtn) {
      const trade = jnCurrentTrade();
      if (trade) {
        const full = jnEntryOrBlank(_jnFullEntry[trade.id]);
        full.reviewStatus = stbtn.dataset.jnstatus;
        _jnFullEntry[trade.id] = full;
        jnMarkDirty(trade, "reviewStatus", full.reviewStatus);
        const segEl = stbtn.closest(".jn-stseg");
        if (segEl) {
          segEl.outerHTML = jnStatusSegHtml(full, jnCanEdit());
          delete _jnPaneCache["jn-content"]; // DOM diverged from the cached string
        }
      }
      return;
    }
    const row = e.target.closest(".jn-row[data-jnid]");
    if (row && row.dataset.jnid && !e.target.closest("a,button,select,input,textarea")) {
      jnToggleExpand(row.dataset.jnid);
    }
  });

  // Editor field autosave (delegated: the editor is re-created per expand).
  pane.addEventListener("input", (e) => {
    const trade = jnCurrentTrade();
    if (!trade) return;
    const id = e.target && e.target.id;
    if (id === "jn-notes") {
      const wc = document.getElementById("jn-wc");
      if (wc) wc.textContent = jnWordCount(e.target.value) + " words";
      const full = jnEntryOrBlank(_jnFullEntry[trade.id]);
      full.notes = e.target.value;
      _jnFullEntry[trade.id] = full;
      jnMarkDirty(trade, "notes", e.target.value);
    } else if (id === "jn-lessons") {
      const full = jnEntryOrBlank(_jnFullEntry[trade.id]);
      full.lessons = e.target.value;
      _jnFullEntry[trade.id] = full;
      jnMarkDirty(trade, "lessons", e.target.value);
    } else if (id === "jn-setup") {
      const full = jnEntryOrBlank(_jnFullEntry[trade.id]);
      full.setup = e.target.value;
      _jnFullEntry[trade.id] = full;
      jnMarkDirty(trade, "setup", e.target.value);
    }
  });
  pane.addEventListener("change", async (e) => {
    const trade = jnCurrentTrade();
    if (!trade) return;
    if (e.target && e.target.id === "jn-strategy") {
      let v = e.target.value;
      if (v === "__new__") {
        v = (await jnNewStrategy()) || "";
        if (!v) {
          // Prompt cancelled: restore the previous selection — cancelling must
          // never save an emptied strategy.
          e.target.value = jnEntryOrBlank(_jnFullEntry[trade.id]).strategy || "";
          return;
        }
        if (!Array.from(e.target.options).some((o) => o.value === v)) {
          const opt = document.createElement("option");
          opt.value = v; opt.textContent = v;
          e.target.insertBefore(opt, e.target.lastElementChild);
        }
        e.target.value = v;
      }
      const full = jnEntryOrBlank(_jnFullEntry[trade.id]);
      full.strategy = v;
      _jnFullEntry[trade.id] = full;
      jnMarkDirty(trade, "strategy", v);
    }
  });
  // New-label inputs (Enter to add).
  pane.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target && (e.target.id === "jn-add-tags" || e.target.id === "jn-add-mistakes")) {
      e.preventDefault();
      const kind = e.target.id === "jn-add-tags" ? "tags" : "mistakes";
      jnAddLabel(kind, e.target.value);
      e.target.value = "";
      return;
    }
    // Keyboard parity for expandable rows and role=button table rows.
    if ((e.key === "Enter" || e.key === " ") && e.target) {
      const row = e.target.closest && e.target.closest('.jn-row[data-jnid], [data-jnmkfilter], [data-jnstfilter], [data-jntagoff]');
      if (row && !["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(e.target.tagName)) {
        e.preventDefault();
        row.click();
      }
    }
  });
  // Flush pending edits when a textarea loses focus or the tab is hidden.
  pane.addEventListener("focusout", (e) => {
    if (e.target && ["jn-notes", "jn-lessons", "jn-setup"].includes(e.target.id)) jnFlushSave();
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) jnFlushSave(); });

  // -- label manager overlay --
  const ov = document.getElementById("jn-meta-overlay");
  if (ov) {
    ov.addEventListener("click", (e) => {
      if (e.target === ov || e.target.closest("#jn-meta-close")) { jnCloseLabels(); return; }
      if (e.target.closest("#jn-meta-save")) { jnSaveLabels(); return; }
      const del = e.target.closest("[data-jnmetadel]");
      if (del) {
        const [kind, i] = del.dataset.jnmetadel.split(":");
        _jnMetaDraft[kind].splice(Number(i), 1);
        jnPaintLabels();
      }
    });
    ov.addEventListener("input", (e) => {
      const nameAttr = e.target.getAttribute && e.target.getAttribute("data-jnmetaname");
      const colorAttr = e.target.getAttribute && e.target.getAttribute("data-jnmetacolor");
      if (nameAttr) {
        const [kind, i] = nameAttr.split(":");
        _jnMetaDraft[kind][Number(i)].name = e.target.value;
      } else if (colorAttr) {
        const [kind, i] = colorAttr.split(":");
        _jnMetaDraft[kind][Number(i)].color = e.target.value;
      }
    });
    ov.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { jnCloseLabels(); return; }
      if (e.key === "Enter" && e.target.getAttribute && e.target.getAttribute("data-jnmetaadd")) {
        e.preventDefault();
        const kind = e.target.getAttribute("data-jnmetaadd");
        const name = String(e.target.value || "").replace(/\s+/g, " ").trim().slice(0, 60);
        if (name && !_jnMetaDraft[kind].some((x) => x.name.toLowerCase() === name.toLowerCase())) {
          _jnMetaDraft[kind].push({ name, color: "" });
          jnPaintLabels();
          const again = document.querySelector(`[data-jnmetaadd="${kind}"]`);
          if (again) again.focus();
        }
      }
    });
  }

  jnPaintControls();
}
