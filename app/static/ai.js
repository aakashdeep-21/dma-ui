"use strict";
/* ===========================================================================
   AI INTELLIGENCE LAYER — the "Coach" tab (data-pane="ai").

   Architecture (same contract as charts.js / risk.js / journal.js):
     * Loaded BEFORE app.js; this file only DEFINES consts + functions — no
       DOM access, no network, no storage at load time. app.js boots it
       (wireAI) and calls onAIActive() when the tab is shown.
     * Pure, DOM-free core first (sanitizer, SSE parser) so
       tests/test_snap.mjs can extract them; then engine state; then the DOM
       manager (fetch / stream / render / wire).
     * Provider-blind: the UI renders capabilities the server reports
       (live/streaming) and NEVER knows or shows which LLM produced a
       response. live=false means deterministic rule-based analysis and is
       labelled honestly everywhere.
     * READ-ONLY by construction: nothing here can reach writeApi or any
       trade endpoint. The AI writes only its own conversations and the
       journal's server-owned aiReview field (via /api/ai/trade-review).
     * Not a chatbot: answers render as full-width insight cards with the
       question as a header and the computed evidence attached — no bubbles.
   =========================================================================== */

// ---------------------------------------------------------------------------
// 1. Pure core (one-line consts + column-0 functions: snap-harness extractable)
// ---------------------------------------------------------------------------
const AI_VIEWS = ["briefing", "ask", "reviews", "patterns"];
const AI_RANGES = ["7", "30", "90"];
const AI_PERIODS = ["day", "week", "month"];
const AI_VIEW_LABELS = { briefing: "Briefing", ask: "Ask", reviews: "Reviews", patterns: "Patterns" };
const AI_SEVERITY_LABELS = { warn: "Fix this", good: "Keep doing", info: "Worth knowing" };
const AI_CONV_ID_RE = /^[0-9a-f]{32}$/;

// Coerce ANY value into a valid AI view state (workspace persistence boundary).
function aiSanitizeViewState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    view: AI_VIEWS.includes(src.view) ? src.view : "briefing",
    range: AI_RANGES.includes(src.range) ? src.range : "30",
    period: AI_PERIODS.includes(src.period) ? src.period : "day",
    convSearch: typeof src.convSearch === "string" ? src.convSearch.slice(0, 60) : "",
  };
}

// Incremental SSE parser: feed it the buffered text so far, get every
// complete `data: {...}` event plus the unconsumed remainder. Pure, so the
// streaming protocol is unit-testable without a socket.
function aiSseParse(buffer) {
  const events = [];
  let rest = String(buffer || "");
  let idx;
  while ((idx = rest.indexOf("\n\n")) >= 0) {
    const chunk = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        events.push(JSON.parse(line.slice(5)));
      } catch (e) { /* partial/garbled frame: skip, keep the stream alive */ }
    }
  }
  return { events, rest };
}

// ---------------------------------------------------------------------------
// 2. Engine state
// ---------------------------------------------------------------------------
let _aiView = aiSanitizeViewState(null); // pure call — safe at load time
let _aiStatus = null;        // {ready, live, streaming, callsPerMin}
let _aiTemplates = [];
let _aiBriefing = null;      // last briefing result (per current range)
let _aiBriefingBusy = false;
let _aiInsights = null;      // deterministic /api/ai/insights payload
let _aiInsightsAt = 0;
let _aiInsightsRange = "";
let _aiReviews = {};         // "period:dateKey" -> result
let _aiReviewBusy = false;
let _aiConvs = [];           // conversation metas
let _aiConv = null;          // active conversation (full, with messages)
let _aiAsking = false;
let _aiWired = false;
const _aiPaneCache = {};

function aiPaneVisible() {
  const pane = document.querySelector('[data-pane="ai"]');
  return !!pane && !pane.hidden && !document.hidden;
}

function aiCanGenerate() {
  return state && state.role === "admin";
}

function aiSet(id, html) {
  if (_aiPaneCache[id] === html) return;
  const el = document.getElementById(id);
  if (!el) return;
  _aiPaneCache[id] = html;
  el.innerHTML = html;
}

function aiInvalidate() {
  Object.keys(_aiPaneCache).forEach((k) => delete _aiPaneCache[k]);
}

function aiMd(text) {
  // jnMarkdown (journal.js) escapes first, then layers markdown-lite back.
  return typeof jnMarkdown === "function" ? jnMarkdown(text) : esc(String(text || ""));
}

// ---------------------------------------------------------------------------
// 3. Fetch layer
// ---------------------------------------------------------------------------
// Browser minutes EAST of UTC (IST = +330): sent with every analysis request
// so day/session boundaries follow the trader's clock, not the deploy's.
function aiTz() {
  return -new Date().getTimezoneOffset();
}

async function aiEnsureStatus() {
  if (_aiStatus) return;
  try {
    const [status, templates] = await Promise.all([
      api("/api/ai/status"), api("/api/ai/templates"),
    ]);
    _aiStatus = status;
    _aiTemplates = templates.templates || [];
    aiPaintStatus();
  } catch (e) {
    // Leave _aiStatus null so the next tab entry retries — a transient blip
    // must not stick a "rule-based" label onto a live-provider deploy.
    const el = document.getElementById("ai-status-badge");
    if (el) el.innerHTML = `<span class="ai-badge ai-rules">status unavailable</span>`;
  }
}

function aiRangeBounds() {
  const days = Number(_aiView.range) || 30;
  const end = Date.now();
  return { start: end - days * 86400000, end };
}

async function aiFetchInsights(force) {
  const fresh = Date.now() - _aiInsightsAt < 60000 && _aiInsightsRange === _aiView.range;
  if (_aiInsights && fresh && !force) return;
  const { start, end } = aiRangeBounds();
  try {
    _aiInsights = await api(`/api/ai/insights?startTime=${start}&endTime=${end}&tzOffsetMin=${aiTz()}`);
    _aiInsightsAt = Date.now();
    _aiInsightsRange = _aiView.range;
  } catch (e) {
    _aiInsights = { error: e && e.message ? e.message : "failed to load insights" };
  }
  aiInvalidate();
  aiRender();
}

async function aiFetchConvs() {
  try {
    _aiConvs = (await api("/api/ai/conversations")).conversations || [];
  } catch (e) {
    _aiConvs = [];
  }
  aiInvalidate();
  aiRender();
}

async function aiOpenConv(id) {
  if (_aiAsking) {
    toast("Wait for the current answer to finish first.", "info", 2500);
    return;
  }
  try {
    _aiConv = await api("/api/ai/conversations/" + encodeURIComponent(id));
  } catch (e) {
    toast("Could not open the conversation: " + (e.message || "error"), "neg");
    return;
  }
  aiInvalidate();
  aiRender();
}

// Generate a trade review (called from the Journal tab's editor too).
async function aiReviewTrade(tradeId) {
  return api("/api/ai/trade-review", {
    method: "POST", body: JSON.stringify({ tradeId }),
  });
}

// ---------------------------------------------------------------------------
// 4. Ask pipeline (SSE streaming into an insight card)
// ---------------------------------------------------------------------------
async function aiAsk(question) {
  question = String(question || "").trim();
  if (!question || _aiAsking) return;
  if (!aiCanGenerate()) {
    toast("AI generation requires the admin role.", "warn");
    return;
  }
  _aiAsking = true;
  const thread = document.getElementById("ai-thread");
  if (thread) {
    thread.insertAdjacentHTML("beforeend", aiExchangeHtml(
      { role: "user", content: question },
      { role: "assistant", content: "", pending: true },
    ));
    thread.scrollTop = thread.scrollHeight;
    delete _aiPaneCache["ai-content"];
  }
  const liveCard = document.getElementById("ai-live-answer");
  const askBtn = document.getElementById("ai-ask-btn");
  if (askBtn) { askBtn.disabled = true; askBtn.textContent = "Thinking…"; }

  let answer = "";
  try {
    const resp = await fetch("/api/ai/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        tzOffsetMin: aiTz(),
        conversationId: _aiConv && AI_CONV_ID_RE.test(_aiConv.id || "") ? _aiConv.id : undefined,
      }),
    });
    if (resp.status === 401) { window.location.href = "/login"; return; }
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.detail || data.error || `Request failed (${resp.status})`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let convId = null;
    let failed = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      const parsed = aiSseParse(buffer);
      buffer = parsed.rest;
      for (const ev of parsed.events) {
        if (ev.type === "start") convId = ev.conversationId;
        else if (ev.type === "delta") {
          answer += ev.text || "";
          if (liveCard) {
            liveCard.innerHTML = aiMd(answer);
            liveCard.classList.add("streaming");
          }
        } else if (ev.type === "error") failed = ev.error || "AI request failed";
      }
      if (done) break;
    }
    if (failed) throw new Error(failed);
    if (liveCard) {
      liveCard.classList.remove("streaming");
      liveCard.removeAttribute("id");
    }
    // Keep local state consistent without refetching the whole conversation.
    if (!_aiConv || _aiConv.id !== convId) {
      _aiConv = { id: convId, title: question.slice(0, 80), pinned: false, messages: [] };
    }
    _aiConv.messages = (_aiConv.messages || []).concat([
      { role: "user", content: question, tsMs: Date.now() },
      { role: "assistant", content: answer, tsMs: Date.now() },
    ]);
    aiFetchConvs(); // refresh sidebar ordering/titles (async; re-renders)
  } catch (e) {
    if (liveCard) {
      liveCard.classList.remove("streaming");
      liveCard.innerHTML = `<span class="neg">⚠ ${esc(e.message || "AI request failed")}</span>`;
      liveCard.removeAttribute("id");
    }
    delete _aiPaneCache["ai-content"];
  } finally {
    _aiAsking = false;
    const btn = document.getElementById("ai-ask-btn");
    if (btn) { btn.disabled = false; btn.textContent = "Ask"; }
  }
}

// ---------------------------------------------------------------------------
// 5. Render helpers
// ---------------------------------------------------------------------------
function aiPaintStatus() {
  const el = document.getElementById("ai-status-badge");
  if (!el || !_aiStatus) return;
  el.innerHTML = _aiStatus.live
    ? `<span class="ai-badge ai-live">AI connected</span>`
    : `<span class="ai-badge ai-rules" title="Set AI_PROVIDER + AI_API_KEY on the server to enable narrative coaching. All numbers stay computed either way.">rule-based mode</span>`;
}

function aiResultMeta(result) {
  if (!result) return "";
  const bits = [];
  if (result.generatedAtMs) bits.push("Generated " + esc(fmtTime(result.generatedAtMs)));
  if (result.cached) bits.push("cached — data unchanged");
  bits.push(result.live ? "AI narrative" : "rule-based");
  bits.push("analyzes past behavior only — never trade advice");
  return `<div class="ai-meta muted">${bits.join(" · ")}</div>`;
}

function aiFindingCard(f) {
  const ev = f.evidence && typeof f.evidence === "object"
    ? Object.entries(f.evidence)
        .filter(([, v]) => v !== null && typeof v !== "object")
        .slice(0, 6)
        .map(([k, v]) => `<span class="ai-ev"><i>${esc(k)}</i> <b class="priv">${esc(String(v))}</b></span>`)
        .join("")
    : "";
  return `<div class="ai-finding ai-sev-${esc(f.severity || "info")}">` +
    `<div class="ai-finding-head"><span class="ai-sevtag">${esc(AI_SEVERITY_LABELS[f.severity] || "Note")}</span>` +
    `<h4>${esc(f.title || "")}</h4></div>` +
    (f.detail ? `<p>${esc(f.detail)}</p>` : "") +
    (ev ? `<div class="ai-evrow">${ev}</div>` : "") +
    `</div>`;
}

function aiMiniTable(title, rows, opts = {}) {
  if (!rows || !rows.length) return "";
  const top = rows.slice(0, opts.limit || 7);
  return `<div class="ai-widget"><h3>${esc(title)}</h3>` +
    `<table class="ai-table"><thead><tr><th style="text-align:left">${esc(opts.labelHead || "")}</th>` +
    `<th>Trades</th><th>Win %</th><th>Net</th></tr></thead><tbody>` +
    top.map((r) =>
      `<tr><td style="text-align:left">${esc(r.label)}</td><td class="mono">${r.trades}</td>` +
      `<td class="mono">${r.winRatePct}%</td>` +
      `<td class="mono ${pnlClass(r.pnl)} priv">${fmtMoneySigned(r.pnl)}</td></tr>`).join("") +
    `</tbody></table></div>`;
}

function aiGenerateGate(buttonHtml) {
  return aiCanGenerate()
    ? buttonHtml
    : `<span class="muted">AI generation requires the admin role.</span>`;
}

// ---------------------------------------------------------------------------
// 6. Views
// ---------------------------------------------------------------------------
function aiRender() {
  if (!document.getElementById("ai-content") || !AI_VIEWS.includes(_aiView.view)) return;
  aiPaintControls();
  if (_aiView.view === "briefing") aiRenderBriefing();
  else if (_aiView.view === "ask") aiRenderAsk();
  else if (_aiView.view === "reviews") aiRenderReviews();
  else if (_aiView.view === "patterns") aiRenderPatterns();
}

function aiRenderBriefing() {
  const controls =
    `<div class="ai-toolbar">` +
    aiGenerateGate(`<button class="btn-primary sm" id="ai-brief-btn" data-aiact="briefing" ${_aiBriefingBusy ? "disabled" : ""}>${_aiBriefingBusy ? "Generating…" : (_aiBriefing ? "Regenerate briefing" : "Generate briefing")}</button>`) +
    `<span class="muted">Range: last ${esc(_aiView.range)} days (change it in the header)</span>` +
    `</div>`;
  let body;
  if (_aiBriefing && _aiBriefing.error) {
    body = errorMsg(_aiBriefing.error);
  } else if (_aiBriefing) {
    const findings = (_aiBriefing.evidence && _aiBriefing.evidence.findings) || [];
    body =
      `<div class="ai-report">${aiMd(_aiBriefing.text)}</div>` +
      aiResultMeta(_aiBriefing) +
      (findings.length
        ? `<h3 class="ai-h3">Receipts — the computed evidence behind this briefing</h3>` +
          `<div class="ai-findings">${findings.map(aiFindingCard).join("")}</div>`
        : "");
  } else {
    body = `<p class="muted center" style="padding:26px 12px">Your daily intelligence briefing: what happened, what it means, ` +
      `where the risk is, and what to work on — grounded in your own numbers.<br/>` +
      `Generate one to get started.</p>`;
  }
  aiSet("ai-content", controls + body);
}

function aiExchangeHtml(q, a) {
  return `<div class="ai-exchange">` +
    `<div class="ai-q"><span class="ai-qmark">Q</span>${esc(q.content)}</div>` +
    `<div class="ai-a${a.pending ? " streaming" : ""}"${a.pending ? ' id="ai-live-answer"' : ""}>` +
    (a.pending ? `<span class="muted">Analyzing your history…</span>` : aiMd(a.content)) +
    `</div></div>`;
}

function aiConvItemHtml(c) {
  return `<div class="ai-convitem${_aiConv && _aiConv.id === c.id ? " active" : ""}" data-aiconv="${esc(c.id)}" role="button" tabindex="0">` +
    `<span class="ai-convtitle">${c.pinned ? "📌 " : ""}${esc(c.title)}</span>` +
    `<span class="muted">${esc(fmtTime(c.updatedAtMs))}</span>` +
    (aiCanGenerate()
      ? `<span class="ai-convacts">` +
        `<button title="${c.pinned ? "Unpin" : "Pin"}" data-aipin="${esc(c.id)}">${c.pinned ? "★" : "☆"}</button>` +
        `<button title="Rename" data-airename="${esc(c.id)}">✎</button>` +
        `<button title="Export as JSON" data-aiexport="${esc(c.id)}">⇩</button>` +
        `<button title="Delete" data-aidel="${esc(c.id)}">✕</button></span>`
      : "") +
    `</div>`;
}

function aiConvListHtml() {
  const q = (_aiView.convSearch || "").toLowerCase();
  const convs = _aiConvs.filter((c) => !q || (c.title || "").toLowerCase().includes(q));
  return convs.length ? convs.map(aiConvItemHtml).join("")
    : `<p class="muted" style="padding:10px">${_aiConvs.length ? "No matches." : "No conversations yet."}</p>`;
}

function aiRenderAsk() {
  // Never rebuild the thread mid-stream: the live answer card and its
  // pending exchange are not in _aiConv.messages yet, so a rebuild would
  // orphan them (deltas writing into a detached node).
  if (_aiAsking) return;
  const sidebar =
    `<div class="ai-side">` +
    `<input id="ai-conv-search" placeholder="Search conversations…" value="${esc(_aiView.convSearch)}" aria-label="Search conversations"/>` +
    `<button class="btn-ghost sm" data-aiact="newconv">＋ New conversation</button>` +
    `<div class="ai-convlist">` + aiConvListHtml() + `</div></div>`;

  const messages = (_aiConv && _aiConv.messages) || [];
  const pairs = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      const a = messages[i + 1] && messages[i + 1].role === "assistant" ? messages[i + 1] : { content: "" };
      pairs.push(aiExchangeHtml(messages[i], a));
    }
  }
  const chips = _aiTemplates.map((t) =>
    `<button class="ai-chip" data-aitpl="${esc(t.id)}" title="${esc(t.prompt)}">${esc(t.label)}</button>`).join("");
  const mainCol =
    `<div class="ai-maincol">` +
    `<div class="ai-thread" id="ai-thread">` +
    (pairs.length ? pairs.join("")
      : `<p class="muted center" style="padding:22px 12px">Ask questions about your own trading history — ` +
        `“Why did I lose money this week?”, “Which strategy performs best?”, “Show my longest winning streak.”</p>`) +
    `</div>` +
    `<div class="ai-composer">` +
    `<div class="ai-chips">${chips}</div>` +
    (aiCanGenerate()
      ? `<div class="ai-askrow"><textarea id="ai-question" rows="2" maxlength="2000" placeholder="Ask about your trading history…"></textarea>` +
        `<button class="btn-primary sm" id="ai-ask-btn" data-aiact="ask">Ask</button></div>`
      : `<p class="muted">Asking requires the admin role; conversations above are readable.</p>`) +
    `</div></div>`;
  aiSet("ai-content", `<div class="ai-askgrid">${sidebar}${mainCol}</div>`);
  const thread = document.getElementById("ai-thread");
  if (thread) thread.scrollTop = thread.scrollHeight;
}

function aiRenderReviews() {
  const dateVal = document.getElementById("ai-rev-date") ? document.getElementById("ai-rev-date").value : "";
  const seg = AI_PERIODS.map((p) =>
    `<button class="seg-neutral${_aiView.period === p ? " active" : ""}" data-aiperiod="${p}" aria-pressed="${_aiView.period === p}">${p[0].toUpperCase() + p.slice(1)}</button>`).join("");
  const key = _aiView.period + ":" + (dateVal || "today");
  const result = _aiReviews[key];
  const controls =
    `<div class="ai-toolbar">` +
    `<div class="segment ai-seg">${seg}</div>` +
    `<input type="date" id="ai-rev-date" value="${esc(dateVal)}" aria-label="Review date"/>` +
    aiGenerateGate(`<button class="btn-primary sm" data-aiact="review" ${_aiReviewBusy ? "disabled" : ""}>${_aiReviewBusy ? "Generating…" : "Generate review"}</button>`) +
    `</div>`;
  let body;
  if (result && result.error) body = errorMsg(result.error);
  else if (result) {
    body = `<div class="ai-report">${aiMd(result.text)}</div>` + aiResultMeta(result);
  } else {
    body = `<p class="muted center" style="padding:26px 12px">Session reviews: pick a day, week or month and generate a ` +
      `structured recap — best trade, worst trade, the patterns of the period, and one thing to carry forward.</p>`;
  }
  aiSet("ai-content", controls + body);
}

function aiRenderPatterns() {
  if (!_aiInsights) {
    aiSet("ai-content", loadingMsg("Computing patterns…"));
    return;
  }
  if (_aiInsights.error) {
    aiSet("ai-content", errorMsg(_aiInsights.error));
    return;
  }
  const d = _aiInsights;
  const s = d.stats || {};
  const tiles =
    `<div class="ai-tiles">` +
    aiTile("Trades", String(s.trades ?? 0)) +
    aiTile("Win rate", (s.winRatePct ?? 0) + "%") +
    aiTile("Net PnL", fmtMoneySigned(s.netPnl || 0), pnlClass(s.netPnl)) +
    aiTile("Profit factor", s.profitFactor == null ? "—" : String(s.profitFactor)) +
    aiTile("Longest win streak", String((d.streaks || {}).longestWin ?? "—")) +
    aiTile("Longest loss streak", String((d.streaks || {}).longestLoss ?? "—")) +
    aiTile("Max drawdown", fmtMoney((d.drawdown || {}).maxDrawdown || 0)) +
    aiTile("Avg hold (min)", s.avgHoldMinutes == null ? "—" : String(s.avgHoldMinutes)) +
    `</div>`;
  const findings = (d.findings || []).length
    ? `<div class="ai-findings">${d.findings.map(aiFindingCard).join("")}</div>`
    : emptyMsg("No notable patterns detected in this range — either clean trading or not enough data yet.");
  let change = "";
  if (d.behaviorChange) {
    const a = d.behaviorChange.firstHalf, b = d.behaviorChange.secondHalf;
    change = `<div class="ai-widget"><h3>Behavior change (first half → second half)</h3>` +
      `<table class="ai-table"><thead><tr><th style="text-align:left"></th><th>First half</th><th>Second half</th></tr></thead><tbody>` +
      [["Trades", a.trades, b.trades], ["Win rate", a.winRatePct + "%", b.winRatePct + "%"],
       ["Net PnL", fmtMoneySigned(a.netPnl), fmtMoneySigned(b.netPnl)],
       ["Avg notional", a.avgNotional ?? "—", b.avgNotional ?? "—"],
       ["Journaled", a.journaledPct + "%", b.journaledPct + "%"]]
        .map(([k, x, y]) => `<tr><td style="text-align:left">${k}</td><td class="mono priv">${x}</td><td class="mono priv">${y}</td></tr>`).join("") +
      `</tbody></table></div>`;
  }
  aiSet("ai-content",
    `<div class="ai-toolbar"><span class="muted">Deterministic pattern detection — every number is computed from your ` +
    `history, no model in the loop. Range: last ${esc(_aiView.range)} days.</span>` +
    `<button class="btn-ghost sm" data-aiact="refresh-insights">Refresh</button></div>` +
    tiles +
    `<h3 class="ai-h3">Findings</h3>` + findings +
    `<div class="ai-cards">` +
    aiMiniTable("By weekday", d.byWeekday, { labelHead: "Day" }) +
    aiMiniTable("By session (local time)", d.byHour, { labelHead: "Hours" }) +
    aiMiniTable("By symbol", d.bySymbol, { labelHead: "Symbol" }) +
    aiMiniTable("By strategy", d.byStrategy, { labelHead: "Strategy" }) +
    aiMiniTable("By tag", d.byTag, { labelHead: "Tag" }) +
    aiMiniTable("Mistake cost", d.byMistake, { labelHead: "Mistake" }) +
    aiMiniTable("Confidence calibration", d.calibration, { labelHead: "Confidence" }) +
    change +
    `</div>`);
}

function aiTile(label, valueHtml, cls) {
  return `<div class="ai-tile"><div class="k">${esc(label)}</div><div class="v priv ${cls || ""}">${valueHtml}</div></div>`;
}

function aiPaintControls() {
  const seg = document.getElementById("ai-views");
  if (seg) seg.querySelectorAll("button").forEach((b) => {
    const on = b.dataset.aiview === _aiView.view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  const range = document.getElementById("ai-range");
  if (range && range.value !== _aiView.range) range.value = _aiView.range;
}

// ---------------------------------------------------------------------------
// 7. Actions + workspace/lifecycle contract (called from app.js)
// ---------------------------------------------------------------------------
function aiSwitchView(view) {
  if (!AI_VIEWS.includes(view) || _aiView.view === view) return;
  if (_aiAsking) {
    toast("Wait for the current answer to finish first.", "info", 2500);
    return;
  }
  _aiView.view = view;
  aiInvalidate();
  aiRender();
  if (view === "patterns") aiFetchInsights(false);
  if (view === "ask" && !_aiConvs.length) aiFetchConvs();
  if (typeof wsAutoSave === "function") wsAutoSave();
}

async function aiGenerateBriefing() {
  if (_aiBriefingBusy || !aiCanGenerate()) return;
  _aiBriefingBusy = true;
  aiInvalidate();
  aiRender();
  try {
    _aiBriefing = await api("/api/ai/briefing", {
      method: "POST",
      body: JSON.stringify({ rangeDays: Number(_aiView.range), tzOffsetMin: aiTz() }),
    });
  } catch (e) {
    _aiBriefing = { error: e && e.message ? e.message : "briefing failed" };
  }
  _aiBriefingBusy = false;
  aiInvalidate();
  aiRender();
}

async function aiGenerateReview() {
  if (_aiReviewBusy || !aiCanGenerate()) return;
  const dateEl = document.getElementById("ai-rev-date");
  const dateVal = dateEl ? dateEl.value : "";
  const atMs = dateVal ? new Date(dateVal + "T12:00:00").getTime() : Date.now();
  const key = _aiView.period + ":" + (dateVal || "today");
  _aiReviewBusy = true;
  aiInvalidate();
  aiRender();
  try {
    _aiReviews[key] = await api("/api/ai/session-review", {
      method: "POST",
      body: JSON.stringify({ period: _aiView.period, atMs, tzOffsetMin: aiTz() }),
    });
  } catch (e) {
    _aiReviews[key] = { error: e && e.message ? e.message : "review failed" };
  }
  _aiReviewBusy = false;
  aiInvalidate();
  aiRender();
  const el = document.getElementById("ai-rev-date");
  if (el && dateVal) el.value = dateVal;
}

function aiExportConv(id) {
  const conv = _aiConv && _aiConv.id === id ? Promise.resolve(_aiConv)
    : api("/api/ai/conversations/" + encodeURIComponent(id));
  Promise.resolve(conv).then((doc) => {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ai-conversation-${(doc.title || "chat").replace(/[^a-z0-9-]+/gi, "-").slice(0, 40)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }).catch((e) => toast("Export failed: " + (e.message || "error"), "neg"));
}

function aiCaptureViewState() { return aiSanitizeViewState(_aiView); }

function aiApplyViewState(raw) {
  _aiView = aiSanitizeViewState(raw);
  aiInvalidate();
  if (aiPaneVisible()) {
    aiRender();
    // A workspace switch on this very tab skips onAIActive (the tab button
    // is already active) — fetch what the restored view needs, or the pane
    // strands on "Computing patterns…" / an empty conversation list.
    if (_aiView.view === "patterns") aiFetchInsights(false);
    if (_aiView.view === "ask" && !_aiConvs.length) aiFetchConvs();
  }
}

function onAIActive() {
  aiEnsureStatus().then(() => {
    aiRender();
    if (_aiView.view === "patterns") aiFetchInsights(false);
    if (_aiView.view === "ask" && !_aiConvs.length) aiFetchConvs();
  });
}

// ---------------------------------------------------------------------------
// 8. Wiring (called once from app.js boot, BEFORE wireWorkspaces)
// ---------------------------------------------------------------------------
function wireAI() {
  if (_aiWired) return;
  _aiWired = true;
  const pane = document.querySelector('[data-pane="ai"]');
  if (!pane) return;

  const seg = document.getElementById("ai-views");
  if (seg) seg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-aiview]");
    if (b) aiSwitchView(b.dataset.aiview);
  });
  const range = document.getElementById("ai-range");
  if (range) range.addEventListener("change", () => {
    _aiView.range = AI_RANGES.includes(range.value) ? range.value : "30";
    _aiBriefing = null; // a briefing is range-specific
    aiInvalidate();
    aiRender();
    if (_aiView.view === "patterns") aiFetchInsights(true);
    if (typeof wsAutoSave === "function") wsAutoSave();
  });

  pane.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-aiact]");
    if (act) {
      const a = act.dataset.aiact;
      if (a === "briefing") aiGenerateBriefing();
      else if (a === "review") aiGenerateReview();
      else if (a === "refresh-insights") aiFetchInsights(true);
      else if (a === "ask") {
        if (_aiAsking) return; // never clear the textarea while a stream runs
        const ta = document.getElementById("ai-question");
        if (ta && ta.value.trim()) { const v = ta.value; ta.value = ""; aiAsk(v); }
      } else if (a === "newconv") {
        if (_aiAsking) return;
        _aiConv = null;
        aiInvalidate();
        aiRender();
      }
      return;
    }
    const period = e.target.closest("[data-aiperiod]");
    if (period) {
      _aiView.period = AI_PERIODS.includes(period.dataset.aiperiod) ? period.dataset.aiperiod : "day";
      aiInvalidate();
      aiRender();
      if (typeof wsAutoSave === "function") wsAutoSave();
      return;
    }
    const tpl = e.target.closest("[data-aitpl]");
    if (tpl) {
      const t = _aiTemplates.find((x) => x.id === tpl.dataset.aitpl);
      const ta = document.getElementById("ai-question");
      if (t && ta) { ta.value = t.prompt; ta.focus(); }
      return;
    }
    const pin = e.target.closest("[data-aipin]");
    if (pin) {
      const id = pin.dataset.aipin;
      const meta = _aiConvs.find((c) => c.id === id);
      try {
        await api("/api/ai/conversations/" + encodeURIComponent(id), {
          method: "PATCH", body: JSON.stringify({ pinned: !(meta && meta.pinned) }),
        });
        aiFetchConvs();
      } catch (err) { toast("Pin failed: " + (err.message || "error"), "neg"); }
      return;
    }
    const rename = e.target.closest("[data-airename]");
    if (rename) {
      const id = rename.dataset.airename;
      const meta = _aiConvs.find((c) => c.id === id);
      const title = (window.prompt("Conversation title:", meta ? meta.title : "") || "").trim();
      if (!title) return;
      try {
        await api("/api/ai/conversations/" + encodeURIComponent(id), {
          method: "PATCH", body: JSON.stringify({ title: title.slice(0, 80) }),
        });
        if (_aiConv && _aiConv.id === id) _aiConv.title = title;
        aiFetchConvs();
      } catch (err) { toast("Rename failed: " + (err.message || "error"), "neg"); }
      return;
    }
    const exp = e.target.closest("[data-aiexport]");
    if (exp) { aiExportConv(exp.dataset.aiexport); return; }
    const del = e.target.closest("[data-aidel]");
    if (del) {
      const id = del.dataset.aidel;
      if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
      try {
        await api("/api/ai/conversations/" + encodeURIComponent(id), { method: "DELETE" });
        if (_aiConv && _aiConv.id === id) _aiConv = null;
        aiFetchConvs();
      } catch (err) { toast("Delete failed: " + (err.message || "error"), "neg"); }
      return;
    }
    const item = e.target.closest("[data-aiconv]");
    if (item && !e.target.closest("button")) aiOpenConv(item.dataset.aiconv);
  });

  pane.addEventListener("input", (e) => {
    if (e.target && e.target.id === "ai-conv-search") {
      _aiView.convSearch = e.target.value.slice(0, 60);
      // Repaint only the list (keep focus in the search box) — via the SAME
      // item builder the full render uses, so action buttons never vanish.
      const listWrap = pane.querySelector(".ai-convlist");
      if (listWrap) {
        delete _aiPaneCache["ai-content"];
        listWrap.innerHTML = aiConvListHtml();
      }
      if (typeof wsAutoSave === "function") wsAutoSave();
    }
  });

  pane.addEventListener("change", (e) => {
    // Date change invalidates the displayed review (it is keyed period:date).
    if (e.target && e.target.id === "ai-rev-date") {
      const v = e.target.value;
      aiInvalidate();
      aiRender();
      const el = document.getElementById("ai-rev-date");
      if (el) el.value = v; // survive the re-render
    }
  });

  pane.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && e.target && e.target.id === "ai-question") {
      e.preventDefault();
      if (_aiAsking) return; // never discard the question while a stream runs
      const v = e.target.value;
      if (v.trim()) { e.target.value = ""; aiAsk(v); }
    }
    if ((e.key === "Enter" || e.key === " ") && e.target && e.target.matches && e.target.matches("[data-aiconv]")) {
      e.preventDefault();
      aiOpenConv(e.target.dataset.aiconv);
    }
  });
}
