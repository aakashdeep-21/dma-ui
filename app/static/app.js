"use strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const settleCoin = () => state.settleCoin || "USDT";
// tradeToken is held ONLY in memory for this tab — never persisted.
const state = {
  role: null,
  settleCoin: "USDT",
  currency: "USDT", // display lens: "USDT" | "INR" (read-only views only)
  tradeToken: "",
  writeInFlight: false,
  orderLastPrice: null,
  symbolLeverage: null, // { symbol, leverage } — the exchange's real leverage for the order-ticket symbol
  prevPos: {},
  lastPositions: [],
  lastOrders: [],
  expandedPos: new Set(),
  expandedOrders: new Set(),
  sortPos: { key: null, dir: 1 },
  sortOrders: { key: null, dir: 1 },
  // --- account snapshot (read-only; for sizing + confirm context) ---
  available: null,
  equity: null,
  // --- order-ticket / market-data context ---
  activeSymbol: "",
  specs: {}, // symbol -> { tickSize, qtyStep, minOrderQty, maxOrderQty, maxLeverage }
  lastExplorer: null, // { render, data } of the last API Explorer query, for re-render on currency toggle
  // --- live-feed health (staleness watchdog) ---
  connState: "connecting", // connecting | live | off
  connDegraded: false,
  feedError: null,
  lastFrameAt: null,
  frameGaps: [], // recent inter-frame gaps (seconds) for an adaptive threshold
};

// ---------------------------------------------------------------------------
// Notification center: every toast is ALSO recorded here (newest first, last
// 50), so a missed 4.5s toast is never lost information. In-memory only by
// design — entries can carry money figures, so nothing persists past the tab;
// rendered text is `.priv` so privacy mode masks the log like everything else.
// ---------------------------------------------------------------------------
const _notifLog = [];
const _NOTIF_MAX = 50;
let _notifUnread = 0;

function recordNotification(msg, type) {
  _notifLog.unshift({ ts: Date.now(), type: type || "info", msg: String(msg) });
  if (_notifLog.length > _NOTIF_MAX) _notifLog.pop();
  const panel = document.getElementById("notif-panel");
  if (panel && !panel.hidden) renderNotifList();
  else { _notifUnread++; paintNotifBadge(); }
}

function paintNotifBadge() {
  const badge = document.getElementById("notif-badge");
  if (!badge) return;
  badge.hidden = _notifUnread === 0;
  badge.textContent = _notifUnread > 9 ? "9+" : String(_notifUnread);
}

function renderNotifList() {
  const listEl = document.getElementById("notif-list");
  if (!listEl) return;
  listEl.innerHTML = _notifLog.length
    ? _notifLog.map((n) =>
        `<div class="notif-item"><span class="dot ${esc(n.type)}"></span>` +
        `<div class="nt"><span class="msg priv">${esc(n.msg)}</span>` +
        `<span class="t">${new Date(n.ts).toLocaleTimeString()}</span></div></div>`
      ).join("")
    : `<div class="notif-empty muted">No notifications this session.</div>`;
}

function wireNotifCenter() {
  const btn = document.getElementById("notif-btn");
  const panel = document.getElementById("notif-panel");
  if (!btn || !panel) return;
  const close = () => { panel.hidden = true; };
  btn.addEventListener("click", () => {
    if (panel.hidden) {
      _notifUnread = 0;
      paintNotifBadge();
      renderNotifList();
      panel.hidden = false;
    } else close();
  });
  const clearBtn = document.getElementById("notif-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => { _notifLog.length = 0; renderNotifList(); });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) close(); });
}

// Non-blocking toast notifications for action outcomes.
function toast(msg, type = "info", ms = 4500) {
  if (!msg) return;
  recordNotification(msg, type);
  // Errors/warnings go to an assertive alert region so a failed or blocked action
  // interrupts a screen reader instead of queuing politely (and possibly expiring
  // before it is read); info/success stay polite.
  const assertive = type === "neg" || type === "warn";
  const wrap = document.getElementById(assertive ? "toasts-alert" : "toasts");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = "toast " + (type || "");
  // Prefix severity so it isn't carried by the left-border colour alone.
  const prefix = type === "neg" ? "Error: " : type === "warn" ? "Warning: " : "";
  el.textContent = prefix + msg;
  el.title = "Dismiss";
  wrap.appendChild(el);
  // Cap the stack so a burst of fills/errors can never bury the order rail's Submit.
  while (wrap.children.length > 4) wrap.firstChild.remove();
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  };
  el.addEventListener("click", remove); // click to dismiss
  setTimeout(remove, ms);
}

// Client-side sort of an array of objects by a key (auto numeric vs string).
function applySort(rows, sortState) {
  if (!sortState || !sortState.key) return rows;
  const k = sortState.key;
  const dir = sortState.dir;
  return rows.slice().sort((a, b) => {
    const av = a[k];
    const bv = b[k];
    const an = Number(av);
    const bn = Number(bv);
    const numeric = av !== "" && bv !== "" && isFinite(an) && isFinite(bn);
    if (numeric) return (an - bn) * dir;
    return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
  });
}

// Reflect the active sort column/direction on the (static) table headers.
function updateSortIndicators() {
  [["#positions-table", state.sortPos], ["#orders-table", state.sortOrders]].forEach(([sel, st]) => {
    const tbl = document.querySelector(sel);
    if (!tbl) return;
    tbl.querySelectorAll("thead th[data-sortkey]").forEach((th) => {
      const active = th.dataset.sortkey === st.key;
      th.setAttribute("data-dir", active ? (st.dir > 0 ? "asc" : "desc") : "");
      th.setAttribute("aria-sort", active ? (st.dir > 0 ? "ascending" : "descending") : "none");
      // Make headers keyboard-operable (idempotent — runs every render).
      if (!th.hasAttribute("tabindex")) {
        th.setAttribute("tabindex", "0");
        th.setAttribute("role", "button");
      }
    });
  });
}

// Small key/value detail grid for an expanded row. Skips empty values. A third
// truthy tuple element ([k, v, true]) marks that value as a private account
// figure, so the privacy toggle masks it (money/size) while leaving neutral
// fields like ids, modes and timestamps readable.
function detailGrid(pairs) {
  const items = pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== "—")
    .map(([k, v, priv]) => `<div><span class="dt-k">${esc(k)}</span><span class="dt-v mono${priv ? " priv" : ""}">${esc(v)}</span></div>`)
    .join("");
  return `<div class="detail-grid">${items || '<span class="muted">No extra detail.</span>'}</div>`;
}

// Assign a tbody's HTML only when it actually CHANGED. The live feed re-renders
// every poll tick, but between ticks the markup is often byte-identical (idle
// orders table, PnL flat at display precision) — and a needless innerHTML swap
// tears down the DOM subtree, kills any text selection the user has open, and
// costs a reparse+layout for zero visual change. Building the string is cheap;
// comparing it is the dirty-check (same pattern as the chart SVG signature).
const _tbodyCache = new WeakMap();
function setTbodyHTML(body, html) {
  if (_tbodyCache.get(body) === html) return;
  _tbodyCache.set(body, html);
  body.innerHTML = html;
}

// Skeleton shimmer rows for the initial loading state.
function renderLoading() {
  const skel = (cols) =>
    Array.from({ length: 5 }, () =>
      "<tr>" + Array.from({ length: cols }, () => '<td><span class="skel"></span></td>').join("") + "</tr>"
    ).join("");
  const admin = state.role === "admin";
  const pb = document.getElementById("positions-body");
  const ob = document.getElementById("orders-body");
  if (pb) setTbodyHTML(pb, skel(admin ? 12 : 11));
  if (ob) setTbodyHTML(ob, skel(admin ? 8 : 7));
}

// Pick the account object from a wallet-balance payload that actually carries
// the totals we need (defensive — never assume list[0]).
function walletAccount(balance) {
  const list = balance?.result?.list || [];
  for (const acct of list) {
    if (acct && (acct.totalEquity !== undefined || acct.totalWalletBalance !== undefined)) return acct;
  }
  return list[0] || null;
}

// Global single-flight lock for ALL write actions. The live tables are rebuilt
// via innerHTML every few seconds, which destroys the button nodes a per-button
// `disabled` flag lives on — so that flag alone can't prevent a duplicate
// close/cancel across a re-render. This lock spans the whole click→confirm→send
// lifecycle, so only one write can ever be in progress at a time.
async function withWriteLock(fn) {
  if (state.writeInFlight) {
    toast("Another trading action is in progress — please wait.", "warn");
    return;
  }
  state.writeInFlight = true;
  try {
    return await fn();
  } finally {
    state.writeInFlight = false;
  }
}

// Escape any exchange-/server-controlled string before putting it into HTML.
// Exchange data (symbol, side, orderStatus, …) is untrusted and is rendered
// via innerHTML below — without this, a crafted value could execute script in
// the admin's authenticated tab (which holds the in-memory trade token).
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function fmtNum(value, digits = 2) {
  const n = Number(value);
  if (!isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// Consistent percent formatting (single source so sign/precision never drift).
function fmtPct(n, withSign = true) {
  if (!isFinite(n)) return "";
  return `${withSign && n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

// Money/PnL formatting that ALWAYS carries an explicit sign, so a gain and a
// loss are never distinguishable by colour alone (accessibility + glance-safety
// on a real-money tool). A real minus sign (U+2212) aligns better in columns.
function fmtSigned(value, digits = 2) {
  const n = Number(value);
  if (!isFinite(n)) return "—";
  const body = fmtNum(Math.abs(n), digits);
  if (n > 0) return "+" + body;
  if (n < 0) return "−" + body;
  return body;
}

// --- Currency display lens --------------------------------------------------
// INR mode shows every READ-side USDT value ×INR_RATE, labelled INR. It is a
// pure display transform: WRITE surfaces (order ticket, TP/SL & confirm modals,
// transfer, and the rail order book that click-fills the USDT price input) ALWAYS
// stay in USDT, because orders are sent to the exchange in USDT. Only currency
// amounts and prices convert — never quantities (base coin), leverage, counts,
// times, or percentages/ratios (which are currency-invariant).
// Default matches the server's INR_RATE default; overwritten from /api/me at
// boot (loadMe) so the deployed rate is configured in ONE place (the env).
let INR_RATE = 94;
function rate() { return state.currency === "INR" ? INR_RATE : 1; }
function curUnit() { return state.currency === "INR" ? "INR" : settleCoin(); }
function cvtNum(v) { const n = Number(v); return isFinite(n) ? n * rate() : NaN; }
// Converting formatters for the already-formatted dashboard cells. In USDT mode
// rate()===1, so output is byte-identical to fmtNum / fmtSigned.
function fmtMoney(v, digits = 2) { return fmtNum(cvtNum(v), digits); }
function fmtMoneySigned(v, digits = 2) { return fmtSigned(cvtNum(v), digits); }
// For explorer/markets tables that print RAW exchange strings: leave them
// untouched in USDT mode (no formatting regression); convert + format only in
// INR mode, preserving the value's own decimal precision unless overridden.
function cvtCell(v, digits) {
  // Returns SAFE HTML for innerHTML/raw-column contexts. USDT mode: escaped raw
  // value (byte-identical to main). INR mode: numeric string (already safe).
  if (state.currency !== "INR") return esc(cell(v));
  const n = Number(v);
  if (!isFinite(n)) return esc(cell(v));
  const d = digits != null ? digits : decimalsOf(v);
  return fmtNum(n * INR_RATE, d);
}

// Funding rate as a signed percentage (the API returns a raw decimal, e.g.
// 0.0001 = +0.0100%). Returns safe HTML coloured by sign for buildTable raw cells.
function fmtFundingHTML(value) {
  const n = Number(value);
  if (!isFinite(n)) return "—";
  const pctVal = n * 100;
  const sign = pctVal > 0 ? "+" : pctVal < 0 ? "−" : "";
  return `<span class="${pnlClass(n)}">${sign}${Math.abs(pctVal).toFixed(4)}%</span>`;
}

// Human feed-age label for the connection pill.
function fmtAge(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Decimal places implied by a step string (e.g. "0.001" -> 3) so snapped
// quantities/prices render at the instrument's own precision. Handles
// exponential notation ("1e-7" -> 7) defensively, though exchanges normally
// return plain decimals.
function decimalsOf(step) {
  let s = String(step);
  if (/e/i.test(s)) {
    const n = Number(step);
    if (!isFinite(n)) return 0;
    s = n.toFixed(20); // expand exponential into fixed notation
  }
  const i = s.indexOf(".");
  if (i < 0) return 0;
  s = s.replace(/0+$/, ""); // trim trailing zeros from the expanded form
  return Math.max(0, s.length - i - 1);
}

// Floor `value` to the nearest multiple of `step` (used by the %-sizing helper).
// Returns a string at the step's precision. Returns null if step is unusable.
function snapToStep(value, step) {
  const v = Number(value);
  const st = Number(step);
  if (!(v >= 0) || !(st > 0)) return null;
  // Add a tiny epsilon before flooring so IEEE-754 division error doesn't drop a
  // whole lot step: e.g. 0.3 / 0.1 === 2.9999999999999996, which would floor to 2
  // and silently under-size the order by a full step. The epsilon is far smaller
  // than any real step, so it never rounds a genuinely-below value up.
  const snapped = Math.floor(v / st + 1e-9) * st;
  return snapped.toFixed(decimalsOf(step));
}

// --- Projected PnL at a TP/SL price ---------------------------------------
// Bybit exposes no projected-PnL field, so we compute it. For LINEAR (USDT)
// contracts the gross result of exiting `size` at `exitPrice` is
// (exit - entry) * size for a long (sign-flipped for a short) — this is exactly
// Bybit's documented closedPnl = cumExitValue - cumEntryValue (minus fees),
// where cumValue = price * qty for linear.
//
// Fee policy (per account): taker 0.035%, maker 0.014%. TP/SL in Full mode
// trigger MARKET exits, so the exit fee is the TAKER fee. We subtract ONLY the
// exit fee (the entry fee is already reflected in an existing position's
// realised PnL, and is excluded for new orders by request).
// Account fee rate confirmed 2026-06 (taker tier). TP/SL in Full mode are
// MARKET exits, so the exit leg always pays the TAKER fee. This rate affects
// ONLY the displayed projected-PnL estimate — never an order/TP/SL we send.
// If the account's fee tier changes, update this value.
const TAKER_FEE_RATE = 0.00035; // 0.035%
// Maker tier for the same account (see the taker note above). Used ONLY for
// the entry-fee estimate in the ticket — never in anything sent to the venue.
const MAKER_FEE_RATE = 0.00014; // 0.014%

// Returns { net, gross, exitFee, roi } or null if inputs are incomplete.
// roi is null when leverage is unknown (e.g. the order form).
function projectedPnl({ side, entry, exitPrice, size, leverage }) {
  const e = Number(entry);
  const x = Number(exitPrice);
  const q = Number(size);
  if (!(e > 0) || !(x > 0) || !(q > 0)) return null;
  const isLong = String(side).toLowerCase() === "buy";
  const gross = isLong ? (x - e) * q : (e - x) * q;
  const exitFee = x * q * TAKER_FEE_RATE; // market exit => taker
  const net = gross - exitFee;
  let roi = null;
  const lev = Number(leverage);
  if (lev > 0) {
    const margin = (e * q) / lev;
    if (margin > 0) roi = (net / margin) * 100;
  }
  return { net, gross, exitFee, roi };
}

// Single source of truth for the colored "<net> (<roi>%)" markup, shared by the
// table badge, the TP/SL modal preview and the order-form preview so they can
// never diverge. `r` is a projectedPnl() result.
// `convert` defaults to true (read context, e.g. the positions table). Write
// surfaces (order form + TP/SL modal previews) pass false to stay in USDT. ROI%
// is a ratio and never converts.
function projAmount(r, withRoi, convert = true) {
  if (!r) return "";
  const roi =
    withRoi && r.roi != null ? ` (${r.roi >= 0 ? "+" : ""}${r.roi.toFixed(2)}%)` : "";
  const amt = convert ? fmtMoneySigned(r.net) : fmtSigned(r.net);
  return `<span class="${pnlClass(r.net)}">${amt}${roi}</span>`;
}

// Small projected net PnL (ROI%) badge for a table cell.
function projHintHTML(args) {
  const r = projectedPnl(args);
  if (!r) return "";
  return `<div class="pnl-hint">${projAmount(r, true)}</div>`;
}

function pnlClass(value) {
  const n = Number(value);
  if (!isFinite(n) || n === 0) return "flat";
  return n > 0 ? "pos" : "neg";
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail || data.error || `Request failed (${res.status})`;
    const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    // Money-path callers need to distinguish a DEFINITIVE 4xx rejection from an
    // INDETERMINATE 5xx (e.g. the transfer idempotency-key lifecycle below).
    err.status = res.status;
    throw err;
  }
  return data;
}

// All WRITE operations go through here: requires the trade token to be present
// and attaches it as the X-Trade-Token header. The server independently
// verifies it; this is the client-side gate + transport.
async function writeApi(path, body) {
  if (!state.tradeToken) {
    throw new Error("Enter the trade token to unlock trading.");
  }
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Trade-Token": state.tradeToken },
    body: JSON.stringify(body || {}),
  });
}

// Client-owned idempotency keys for fund transfers, keyed by transfer INTENT
// (direction|amount|asset) and kept until that transfer resolves DEFINITIVELY:
//  * confirmed success  -> cleared (a later identical transfer is a new intent);
//  * definitive 4xx     -> cleared (the exchange evaluated and REFUSED — reusing
//    the key after fixing the cause could be replay-deduped into a no-op);
//  * indeterminate 5xx / network error -> KEPT, so the retry reuses the SAME
//    key and the exchange dedups instead of moving funds twice.
// Persisted per-tab in sessionStorage so a page refresh during that uncertainty
// window cannot mint a fresh key for the same unresolved intent.
const _TXN_STORE_KEY = "dma.transferTxnIds";
const _transferTxnIds = (() => {
  try { return JSON.parse(sessionStorage.getItem(_TXN_STORE_KEY) || "{}") || {}; }
  catch (e) { return {}; }
})();
function _persistTxnIds() {
  try { sessionStorage.setItem(_TXN_STORE_KEY, JSON.stringify(_transferTxnIds)); } catch (e) {}
}
function _uuid() {
  if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Fallback (non-secure contexts): unique enough for a client idempotency key.
  return "txn-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}
function transferTxnId(intentKey) {
  if (!_transferTxnIds[intentKey]) {
    _transferTxnIds[intentKey] = _uuid();
    _persistTxnIds();
  }
  return _transferTxnIds[intentKey];
}
function clearTransferTxnId(intentKey) {
  delete _transferTxnIds[intentKey];
  _persistTxnIds();
}

// Build the confirm-modal body. A plain string is shown as-is (textContent,
// safe); a { head, lines:[[k,v]], note } object renders a small escaped
// key/value summary so high-stakes writes show notional / PnL / size at a glance.
function setConfirmMessage(message) {
  const el = $("#confirm-message");
  if (!el) return;
  if (message && typeof message === "object") {
    const head = message.head ? `<p class="cm-head">${esc(message.head)}</p>` : "";
    const lines = (message.lines || [])
      .map(([k, v]) => `<div class="cm-line"><span class="cm-k">${esc(k)}</span><span class="cm-v">${esc(v)}</span></div>`)
      .join("");
    const note = message.note ? `<p class="muted" style="margin:8px 0 0">${esc(message.note)}</p>` : "";
    el.innerHTML = head + lines + note;
  } else {
    el.textContent = String(message ?? "");
  }
}

// Keep Tab focus inside an open modal; returns a function to remove the trap.
function focusTrap(container) {
  if (!container) return () => {};
  const sel =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';
  const onKey = (e) => {
    if (e.key !== "Tab") return;
    const items = Array.from(container.querySelectorAll(sel)).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  container.addEventListener("keydown", onKey);
  return () => container.removeEventListener("keydown", onKey);
}

// Restore focus to the element that had it before a modal opened.
function restoreFocus(prev) {
  if (prev && typeof prev.focus === "function" && document.contains(prev)) {
    try { prev.focus(); } catch (e) { /* element no longer focusable */ }
  }
}

// Typed-confirm modal: the user must type the word "confirm" to proceed.
// Resolves false on cancel; on proceed resolves { percent } (100 unless the
// caller passed opts.percents and the user picked a different portion) — an
// object, so every existing truthiness check (`if (!ok)`) works unchanged.
// opts.percents: optional array of portion buttons (e.g. [25,50,75,100]);
// opts.hint(pct): optional per-selection helper line rendered under them.
let _confirmOpen = false;
function typedConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    // Only one confirm modal may be open at a time. A second trigger (e.g.
    // clicking another Close button) is ignored rather than stacking listeners
    // on the shared overlay, which could otherwise fire two writes at once.
    if (_confirmOpen) {
      resolve(false);
      return;
    }
    _confirmOpen = true;
    const overlay = $("#confirm-overlay");
    const input = $("#confirm-input");
    const proceed = $("#confirm-proceed");
    const cancel = $("#confirm-cancel");
    const choices = $("#confirm-choices");
    const prevFocus = document.activeElement;
    setConfirmMessage(message);

    // Optional portion buttons (percent values are our own constants, not data).
    let percent = 100;
    const paintChoices = () => {
      choices.querySelectorAll("button[data-pct]").forEach((b) => {
        const on = Number(b.dataset.pct) === percent;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      const hintEl = choices.querySelector(".choices-hint");
      if (hintEl) hintEl.textContent = opts.hint ? opts.hint(percent) : "";
    };
    const onChoice = (e) => {
      const b = e.target.closest("button[data-pct]");
      if (!b) return;
      percent = Number(b.dataset.pct);
      paintChoices();
    };
    if (choices) {
      if (Array.isArray(opts.percents) && opts.percents.length) {
        choices.hidden = false;
        choices.innerHTML =
          `<div class="choices-btns" role="group" aria-label="Portion to apply">` +
          opts.percents
            .map((p) => `<button type="button" data-pct="${Number(p)}" aria-pressed="${Number(p) === 100}">${Number(p) === 100 ? "Full" : Number(p) + "%"}</button>`)
            .join("") +
          `</div><div class="choices-hint muted"></div>`;
        choices.addEventListener("click", onChoice);
        paintChoices();
      } else {
        choices.hidden = true;
        choices.innerHTML = "";
      }
    }

    input.value = "";
    proceed.disabled = true;
    overlay.hidden = false;
    input.focus();
    const untrap = focusTrap(overlay.querySelector(".modal"));

    const cleanup = (result) => {
      overlay.hidden = true;
      input.removeEventListener("input", onInput);
      proceed.removeEventListener("click", onProceed);
      cancel.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKey);
      overlay.removeEventListener("click", onOverlay);
      if (choices) {
        choices.removeEventListener("click", onChoice);
        choices.hidden = true;
        choices.innerHTML = ""; // never leak stale portion buttons into the next confirm
      }
      untrap();
      restoreFocus(prevFocus);
      _confirmOpen = false;
      resolve(result ? { percent } : false);
    };
    const isValid = () => input.value.trim().toLowerCase() === "confirm";
    const onInput = () => { proceed.disabled = !isValid(); };
    const onProceed = () => { if (isValid()) cleanup(true); };
    const onCancel = () => cleanup(false);
    const onKey = (e) => {
      if (e.key === "Enter" && isValid()) onProceed();
      if (e.key === "Escape") onCancel();
    };
    const onOverlay = (e) => { if (e.target === overlay) onCancel(); };

    input.addEventListener("input", onInput);
    proceed.addEventListener("click", onProceed);
    cancel.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKey);
    overlay.addEventListener("click", onOverlay);
  });
}

// ---------------------------------------------------------------------------
// Session / role
// ---------------------------------------------------------------------------
async function loadMe() {
  const me = await api("/api/me");
  state.role = me.role;
  // Display-only USDT→INR lens rate, configured server-side (env INR_RATE).
  const inr = Number(me.inrRate);
  if (isFinite(inr) && inr > 0) INR_RATE = inr;
  $("#user-name").textContent = me.username;
  const rolePill = $("#user-role");
  rolePill.textContent = me.role;
  rolePill.classList.add(me.role === "admin" ? "role-admin" : "role-viewer");
  if (me.role !== "admin") {
    document.body.classList.add("viewer");
    document.querySelectorAll(".admin-only").forEach((el) => el.remove());
  }
}

$("#logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/login";
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderSummary(d) {
  const summary = d.summary || {};
  state.settleCoin = summary.settleCoin || state.settleCoin;
  const coin = settleCoin();

  const upl = Number(summary.totalUnrealisedPnl);
  const pnlEl = $("#stat-pnl");
  pnlEl.textContent = `${fmtMoneySigned(summary.totalUnrealisedPnl)} ${curUnit()}`;
  // `priv` kept on every reassignment so the privacy mask survives re-renders.
  pnlEl.className = "stat-value priv " + pnlClass(summary.totalUnrealisedPnl);

  // Live PnL in the tab title so the terminal is glanceable from another
  // window. Suppressed in privacy mode — window titles leak to task switchers,
  // window lists and screen shares, which is exactly what that mode hides from.
  document.title = document.body.classList.contains("privacy-on") || !isFinite(upl)
    ? "DMA Terminal — Dashboard"
    : `${fmtMoneySigned(summary.totalUnrealisedPnl)} ${curUnit()} · DMA Terminal`;

  $("#stat-positions").textContent = summary.openPositions ?? "—";
  $("#stat-orders").textContent = summary.openOrders ?? "—";

  // Scope chip: make explicit which settlement universe the view is filtered to,
  // so an empty table reads as "none in USDT", not "none anywhere".
  const scope = $("#scope-chip");
  if (scope) scope.textContent = coin ? `${coin} PERP` : "";

  // The rail order book always quotes the settle coin (never the INR lens); keep
  // its unit chip in sync with the real settle coin rather than a hardcoded USDT.
  const bookUnit = $("#book-unit");
  if (bookUnit && coin) bookUnit.textContent = coin;

  // --- Account-health bar (all from the wallet-balance payload) ---
  const acct = walletAccount(d.balance);
  const num = (v) => (v !== undefined && v !== "" && isFinite(Number(v)) ? Number(v) : null);

  let equity = acct ? num(acct.totalEquity) ?? num(acct.totalWalletBalance) : null;
  if (equity == null && acct) {
    const c = (acct.coin || []).find((x) => x.coin === coin);
    equity = num(c?.equity) ?? num(c?.walletBalance);
  }
  const available = acct ? num(acct.totalAvailableBalance) : null;
  const usedMargin = acct ? num(acct.totalInitialMargin) : null;
  const maintMargin = acct ? num(acct.totalMaintenanceMargin) : null;

  const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  setText("#stat-equity", equity != null ? `${fmtMoney(equity)} ${curUnit()}` : "—");
  setText("#stat-available", available != null ? `avail ${fmtMoney(available)}` : "");
  setText("#stat-margin-used", usedMargin != null ? `${fmtMoney(usedMargin)} ${curUnit()}` : "—");

  // Cache for the order-ticket sizing helper + enriched confirm context.
  state.available = available;
  state.equity = equity;
  updateSizingAvail();

  // PnL % relative to used (initial) margin → ROE-style; fall back to equity.
  const pnlPctEl = $("#stat-pnl-pct");
  if (pnlPctEl) {
    const base = usedMargin && usedMargin > 0 ? usedMargin : equity;
    if (isFinite(upl) && base && base > 0) {
      pnlPctEl.textContent = fmtPct((upl / base) * 100);
      pnlPctEl.className = "stat-sub priv " + pnlClass(upl);
    } else {
      pnlPctEl.textContent = "";
    }
  }

  // Margin ratio = maintenance margin ÷ margin balance (higher = closer to
  // liquidation). Prefer the exchange's own accountMMRate when present so the
  // figure matches Bybit's liquidation math exactly.
  const ratioEl = $("#stat-margin-ratio");
  const meter = $("#margin-meter");
  if (ratioEl && meter) {
    let ratio = null;
    const mmRate = acct ? num(acct.accountMMRate) : null;
    if (mmRate != null) {
      ratio = mmRate * 100;
    } else {
      const marginBal = acct ? num(acct.totalMarginBalance) ?? equity : equity;
      if (maintMargin != null && marginBal && marginBal > 0) ratio = (maintMargin / marginBal) * 100;
    }
    const bar = meter.querySelector("span");
    if (ratio != null && isFinite(ratio)) {
      ratioEl.textContent = fmtPct(ratio, false);
      bar.style.width = Math.min(100, Math.max(0, ratio)).toFixed(1) + "%";
      meter.className = "meter" + (ratio >= 80 ? " danger" : ratio >= 50 ? " warn" : "");
      meter.setAttribute("aria-label", "Margin ratio " + fmtPct(ratio, false));
      ratioEl.className = "stat-value priv" + (ratio >= 80 ? " neg" : ratio >= 50 ? " warn" : "");
    } else {
      ratioEl.textContent = "—";
      ratioEl.className = "stat-value priv";
      bar.style.width = "0%";
      meter.className = "meter";
      meter.setAttribute("aria-label", "Margin ratio unavailable");
    }
  }
}

function renderPositions(positions) {
  const body = $("#positions-body");
  state.lastPositions = positions || [];
  const rows = state.lastPositions.filter((p) => Number(p.size) !== 0);
  if (!rows.length) {
    // colspan="99" spans all columns regardless of count/role (same as the detail
    // rows) — no hardcoded per-role count to drift when a column is added.
    const hint = state.role === "admin"
      ? `<div class="empty-hint">Use the order ticket on the right to open a position.</div>`
      : "";
    setTbodyHTML(body, `<tr><td colspan="99" class="muted center empty-cell">No open positions${hint}</td></tr>`);
    return;
  }
  const isAdmin = state.role === "admin";
  const hasVal = (v) => v !== undefined && v !== null && v !== "" && Number(v) !== 0;
  const nextPrev = {};
  const sorted = applySort(rows, state.sortPos);
  const html = sorted
    .map((p) => {
      const pnl = p.unrealisedPnl;
      const key = `${p.symbol}/${p.positionIdx ?? 0}`;
      const expanded = state.expandedPos.has(key);
      const actions = isAdmin
        ? `<td class="row-actions">
            <button class="btn-ghost sm" data-trade="${esc(p.symbol)}" title="Load ${esc(p.symbol)} into the order ticket">⇄</button>
            <button class="btn-ghost sm" data-tpsl='${esc(JSON.stringify({
              symbol: p.symbol,
              positionIdx: p.positionIdx ?? 0,
              side: p.side,
              size: p.size,
              leverage: p.leverage,
              avgPrice: p.avgPrice,
              markPrice: p.markPrice,
              breakEvenPrice: p.breakEvenPrice,
              takeProfit: p.takeProfit,
              stopLoss: p.stopLoss,
            }))}'>TP/SL</button>
            <button class="btn-danger sm" data-close='${esc(JSON.stringify({
              symbol: p.symbol,
              side: p.side,
              qty: p.size,
              positionIdx: p.positionIdx ?? 0,
            }))}'>Close</button>
          </td>`
        : "";
      const tpCell = hasVal(p.takeProfit)
        ? `${fmtMoney(p.takeProfit, 4)}${projHintHTML({ side: p.side, entry: p.avgPrice, exitPrice: p.takeProfit, size: p.size, leverage: p.leverage })}`
        : "—";
      const slCell = hasVal(p.stopLoss)
        ? `${fmtMoney(p.stopLoss, 4)}${projHintHTML({ side: p.side, entry: p.avgPrice, exitPrice: p.stopLoss, size: p.size, leverage: p.leverage })}`
        : "—";

      // Break-even (incl. fees) under entry.
      const beSub = hasVal(p.breakEvenPrice)
        ? `<span class="cell-sub">BE ${fmtMoney(p.breakEvenPrice, 4)}</span>`
        : "";

      // Liquidation distance % + a proximity gauge under the liq price. The
      // gauge fills (and reddens) as mark approaches the liquidation price — the
      // single most safety-critical signal per position, now glanceable.
      let liqCell = "—";
      if (hasVal(p.liqPrice)) {
        liqCell = fmtMoney(p.liqPrice, 4);
        const mark = Number(p.markPrice);
        const liq = Number(p.liqPrice);
        if (isFinite(mark) && mark > 0 && isFinite(liq)) {
          const dist = (Math.abs(mark - liq) / mark) * 100;
          const cls = dist < 5 ? "neg" : dist < 10 ? "warn" : "";
          const gcls = dist < 5 ? "danger" : dist < 10 ? "warn" : "";
          const prox = Math.min(100, Math.max(0, 100 - dist)); // closer to liq => fuller
          liqCell += `<span class="cell-sub ${cls}">${dist.toFixed(2)}% away</span>`;
          liqCell += `<span class="cell-gauge ${gcls}" role="img" aria-label="${dist.toFixed(1)}% from liquidation"><i style="width:${prox.toFixed(1)}%"></i></span>`;
        }
      }

      // ROE % (unrealised PnL ÷ position initial margin) under the PnL.
      let roeSub = "";
      const im = Number(p.positionIM);
      if (isFinite(im) && im > 0 && isFinite(Number(pnl))) {
        roeSub = `<span class="cell-sub ${pnlClass(pnl)}">${fmtPct((Number(pnl) / im) * 100)}</span>`;
      }

      // Change-flash on the PnL cell — only on a MEANINGFUL move, otherwise it
      // would flash every tick (PnL drifts constantly) and become pure noise.
      const cur = Number(pnl);
      const prev = state.prevPos[key];
      let flash = "";
      if (
        prev !== undefined &&
        isFinite(cur) &&
        Math.abs(cur - prev) >= Math.max(0.01, Math.abs(prev) * 0.001)
      ) {
        flash = cur > prev ? " flash-up" : " flash-down";
      }
      if (isFinite(cur)) nextPrev[key] = cur;

      const detail = detailGrid([
        ["Break-even", hasVal(p.breakEvenPrice) ? fmtMoney(p.breakEvenPrice, 4) : "", true],
        ["Initial margin", p.positionIM ? fmtMoney(p.positionIM) : "", true],
        ["Maint. margin", p.positionMM ? fmtMoney(p.positionMM) : "", true],
        ["Realized PnL", p.curRealisedPnl !== undefined && p.curRealisedPnl !== "" ? fmtMoney(p.curRealisedPnl) : "", true],
        ["Cum. realized", p.cumRealisedPnl ? fmtMoney(p.cumRealisedPnl) : "", true],
        ["Position value", fmtMoney(p.positionValue), true],
        ["TP/SL mode", p.tpslMode],
        ["Position idx", p.positionIdx],
        ["Opened", fmtTime(p.createdTime)],
        ["Updated", fmtTime(p.updatedTime)],
      ]);

      return `<tr class="exp-row${expanded ? " expanded" : ""}${(p.side || "").toLowerCase() === "buy" ? " side-buy" : " side-sell"}" data-pkey="${esc(key)}" role="button" tabindex="0" aria-expanded="${expanded}">
        <td class="mono card-head"><span class="caret">${expanded ? "▾" : "▸"}</span>${esc(p.symbol)}</td>
        <td data-label="Side" class="side-cell ${(p.side || "").toLowerCase() === "buy" ? "pos" : "neg"}">${esc(p.side)}</td>
        <td data-label="Size" class="mono priv">${fmtNum(p.size, 4)}</td>
        <td data-label="Entry" class="mono priv">${fmtMoney(p.avgPrice, 4)}${beSub}</td>
        <td data-label="Mark" class="mono">${fmtMoney(p.markPrice, 4)}</td>
        <td data-label="Liq." class="mono priv">${liqCell}</td>
        <td data-label="Lev" class="mono priv">${esc(p.leverage ?? "—")}x</td>
        <td data-label="Value" class="mono priv">${fmtMoney(p.positionValue)}</td>
        <td data-label="Unrealised PnL" class="mono priv ${pnlClass(pnl)}${flash}">${fmtMoneySigned(pnl)}${roeSub}</td>
        <td data-label="TP" class="mono priv">${tpCell}</td>
        <td data-label="SL" class="mono priv">${slCell}</td>
        ${actions}
      </tr>
      <tr class="detail-row"${expanded ? "" : " hidden"}><td colspan="99">${detail}</td></tr>`;
    })
    .join("");
  setTbodyHTML(body, html);
  state.prevPos = nextPrev;
  // Drop expanded-state for positions that no longer exist (avoid unbounded growth).
  const liveKeys = new Set(sorted.map((p) => `${p.symbol}/${p.positionIdx ?? 0}`));
  state.expandedPos.forEach((k) => { if (!liveKeys.has(k)) state.expandedPos.delete(k); });
  updateSortIndicators();
}

function renderOrders(orders) {
  const body = $("#orders-body");
  state.lastOrders = orders || [];
  const rows = state.lastOrders;
  // Hide the bulk-destructive "Cancel all" when there's nothing to cancel, so a
  // live wipe-everything button never sits on an empty panel. (Null for viewers.)
  const cancelAllBtn = document.getElementById("cancel-all-btn");
  if (cancelAllBtn) cancelAllBtn.hidden = !rows.length;
  if (!rows.length) {
    const hint = state.role === "admin"
      ? `<div class="empty-hint">Place an order from the ticket to see it here.</div>`
      : "";
    setTbodyHTML(body, `<tr><td colspan="99" class="muted center empty-cell">No open orders${hint}</td></tr>`);
    updateSortIndicators();
    return;
  }
  const isAdmin = state.role === "admin";
  const sorted = applySort(rows, state.sortOrders);
  const html = sorted
    .map((o) => {
      const key = o.orderId || `${o.symbol}/${o.orderLinkId || ""}`;
      const expanded = state.expandedOrders.has(key);
      const actions = isAdmin
        ? `<td class="row-actions">
            <button class="btn-ghost sm" data-amend='${esc(JSON.stringify({
              symbol: o.symbol,
              orderId: o.orderId,
              side: o.side,
              // Amend the UNFILLED remainder when the order is partially filled.
              qty: Number(o.leavesQty) > 0 ? o.leavesQty : o.qty,
              price: o.price,
            }))}' title="Cancel this order and edit it in the ticket">✎</button>
            <button class="btn-danger sm" data-cancel='${esc(JSON.stringify({
              symbol: o.symbol,
              orderId: o.orderId,
            }))}'>Cancel</button></td>`
        : "";

      // Fill progress + flags as small badges under the type cell.
      const filled = Number(o.cumExecQty);
      const total = Number(o.qty);
      const hasFill = isFinite(filled) && isFinite(total) && total > 0 && filled > 0;
      const fillPct = hasFill ? Math.min(100, (filled / total) * 100) : 0;
      const fillSub = hasFill
        ? `<span class="cell-sub">${fmtNum(filled, 4)}/${fmtNum(total, 4)} filled</span>` +
          `<span class="cell-gauge" role="img" aria-label="${fillPct.toFixed(0)}% filled"><i style="width:${fillPct.toFixed(1)}%"></i></span>`
        : "";
      const badges =
        (o.reduceOnly ? '<span class="badge">reduce</span>' : "") +
        (o.closeOnTrigger ? '<span class="badge">close</span>' : "") +
        (o.stopOrderType ? `<span class="badge">${esc(o.stopOrderType)}</span>` : "");

      const detail = detailGrid([
        ["Order ID", o.orderId],
        ["Order link ID", o.orderLinkId],
        ["Time in force", o.timeInForce],
        ["Reduce only", o.reduceOnly === undefined ? "" : String(o.reduceOnly)],
        ["Close on trigger", o.closeOnTrigger === undefined ? "" : String(o.closeOnTrigger)],
        ["Stop order type", o.stopOrderType],
        ["Trigger by", o.triggerBy],
        ["Cum. exec qty", o.cumExecQty, true],
        ["Leaves qty", o.leavesQty, true],
        ["Created", fmtTime(o.createdTime)],
        ["Updated", fmtTime(o.updatedTime)],
      ]);

      return `<tr class="exp-row${expanded ? " expanded" : ""}${(o.side || "").toLowerCase() === "buy" ? " side-buy" : " side-sell"}" data-okey="${esc(key)}" role="button" tabindex="0" aria-expanded="${expanded}">
        <td class="mono card-head"><span class="caret">${expanded ? "▾" : "▸"}</span>${esc(o.symbol)}</td>
        <td data-label="Side" class="side-cell ${(o.side || "").toLowerCase() === "buy" ? "pos" : "neg"}">${esc(o.side)}</td>
        <td data-label="Type">${esc(o.orderType)}${badges}</td>
        <td data-label="Qty" class="mono priv">${fmtNum(o.qty, 4)}${fillSub}</td>
        <td data-label="Price" class="mono priv">${o.price && Number(o.price) ? fmtMoney(o.price, 4) : "—"}</td>
        <td data-label="Trigger" class="mono priv">${o.triggerPrice && Number(o.triggerPrice) ? fmtMoney(o.triggerPrice, 4) : "—"}</td>
        <td data-label="Status">${esc(o.orderStatus)}</td>
        ${actions}
      </tr>
      <tr class="detail-row"${expanded ? "" : " hidden"}><td colspan="99">${detail}</td></tr>`;
    })
    .join("");
  // The upstream open-orders call is capped at 50 — a full page means MORE may
  // exist on the exchange that this table cannot show. Never present a capped
  // page as the complete set.
  const capNote = rows.length >= 50
    ? `<tr><td colspan="99" class="muted center">Showing 50 open orders (the feed's cap) — more may be open on the exchange.</td></tr>`
    : "";
  setTbodyHTML(body, html + capNote);
  const liveKeys = new Set(sorted.map((o) => o.orderId || `${o.symbol}/${o.orderLinkId || ""}`));
  state.expandedOrders.forEach((k) => { if (!liveKeys.has(k)) state.expandedOrders.delete(k); });
  updateSortIndicators();
}

function renderErrors(errors) {
  // Surface upstream errors inline in the updated label, non-blocking.
  const label = $("#positions-updated");
  if (errors && Object.keys(errors).length) {
    label.textContent = "⚠ " + Object.values(errors)[0];
    label.classList.add("neg");
  } else {
    const t = new Date();
    label.textContent = "updated " + t.toLocaleTimeString();
    label.classList.remove("neg");
  }
}

// Highest server-authored dashboard generation rendered so far. Every dashboard
// snapshot (WS push AND the /api/dashboard GET) carries `gen`, a monotonic counter
// stamped server-side at data-assembly time, so freshness is ordered by when the
// exchange reads completed — not by which transport happened to arrive first.
// A snapshot older than the last rendered one is dropped, so neither a post-write
// GET nor a routine WS frame can clobber the other with staler data. Reset to 0 on
// WS reconnect (a redeploy restarts the server counter). Equal gen still renders,
// so a currency-toggle re-render of the cached snapshot is unaffected.
let _lastDashSeq = 0;
function renderDashboard(d) {
  const gen = Number(d && d.gen);
  if (isFinite(gen)) {
    if (gen < _lastDashSeq) return; // an older snapshot lost the race; keep the newer one
    _lastDashSeq = gen;
  }
  state.lastDashboard = d; // kept so a currency toggle can re-render instantly
  renderSummary(d);
  renderPositions(d.positions);
  renderOrders(d.orders);
  renderErrors(d.errors);
  notifyPositionChanges(d);
  renderRiskOverview(d);
}

// ---------------------------------------------------------------------------
// Risk overview — derived entirely from the snapshot the tables already
// render (no extra requests): gross/net exposure, long/short split, margin
// utilization, nearest liquidation, largest position. Every figure is `.priv`.
// ---------------------------------------------------------------------------
let _lastRiskHTML = null;
function renderRiskOverview(d) {
  const body = document.getElementById("risk-body");
  if (!body) return;
  // Partial snapshot (positions read failed upstream): keep the last good view
  // rather than painting "no exposure" over live risk.
  if (d.errors && d.errors.positions) return;
  const rows = (d.positions || []).filter((p) => Number(p.size) !== 0);
  const num = (v) => (v !== undefined && v !== "" && isFinite(Number(v)) ? Number(v) : null);

  let long = 0, short = 0, largest = null, nearestLiq = null;
  rows.forEach((p) => {
    const value = Number(p.positionValue) || 0;
    if ((p.side || "").toLowerCase() === "buy") long += value; else short += value;
    if (!largest || value > largest.value) largest = { value, sym: String(p.symbol || "?") };
    const mark = Number(p.markPrice), liq = Number(p.liqPrice);
    if (isFinite(mark) && mark > 0 && isFinite(liq) && liq > 0) {
      const dist = (Math.abs(mark - liq) / mark) * 100;
      if (!nearestLiq || dist < nearestLiq.dist) nearestLiq = { dist, sym: String(p.symbol || "?") };
    }
  });
  const gross = long + short;
  const net = long - short;
  const longPct = gross > 0 ? (long / gross) * 100 : 50;
  const acct = walletAccount(d.balance);
  const im = acct ? num(acct.totalInitialMargin) : null;
  const marginBal = acct ? num(acct.totalMarginBalance) : null;
  const util = im != null && marginBal && marginBal > 0 ? (im / marginBal) * 100 : null;

  let html;
  if (!rows.length) {
    html = `<p class="muted center" style="padding:20px 12px">No open positions — no market exposure.</p>`;
  } else {
    const liqCls = nearestLiq ? (nearestLiq.dist < 5 ? "neg" : nearestLiq.dist < 10 ? "warn" : "pos") : "flat";
    const utilCls = util != null ? (util >= 80 ? "neg" : util >= 50 ? "warn" : "pos") : "flat";
    html =
      `<div class="risk-grid">` +
        jTile("Gross exposure", `${fmtMoney(gross)} ${esc(curUnit())}`, "flat") +
        jTile("Net exposure", `${fmtMoneySigned(net)}`, pnlClass(net)) +
        jTile("Margin utilization", util != null ? fmtPct(util, false) : "—", utilCls) +
        jTile("Nearest liquidation",
          nearestLiq ? `${esc(nearestLiq.sym)} · ${nearestLiq.dist.toFixed(1)}%` : "—", liqCls) +
        jTile("Largest position",
          largest ? `${esc(largest.sym)} · ${fmtMoney(largest.value)}` : "—", "flat") +
        jTile("Open positions", String(rows.length), "flat") +
      `</div>` +
      `<div class="risk-split" role="img" aria-label="Long ${longPct.toFixed(0)} percent of gross exposure">` +
        `<span class="rs-long" style="width:${longPct.toFixed(1)}%"></span>` +
        `<span class="rs-short" style="width:${(100 - longPct).toFixed(1)}%"></span>` +
      `</div>` +
      `<div class="risk-split-labels">` +
        `<span class="pos priv">Long ${fmtMoney(long)}</span>` +
        `<span class="neg priv">Short ${fmtMoney(short)}</span>` +
      `</div>`;
  }
  if (html === _lastRiskHTML) return; // dirty-check like the tables
  _lastRiskHTML = html;
  body.innerHTML = html;
}

// In-app fill/close awareness: announce position open/close/size changes by
// diffing consecutive snapshots, so a TP firing while the user is on another
// tab (or a limit entry filling) is surfaced without needing Telegram. Only
// POSITIONS are diffed — an order-row disappearance is ambiguous (fill vs
// cancel vs expiry), but a position change is an unambiguous money-state fact.
// key -> {size, side, symbol}; null until the first full snapshot (baseline).
let _posChangeBaseline = null;
function notifyPositionChanges(d) {
  // A PARTIAL snapshot (the positions read failed upstream this cycle) must
  // never be diffed: its empty list would read as "everything closed".
  if (d.errors && d.errors.positions) return;
  const cur = {};
  (d.positions || []).forEach((p) => {
    const size = Number(p.size);
    if (isFinite(size) && size !== 0) {
      cur[`${p.symbol}/${p.positionIdx ?? 0}`] = { size, side: p.side, symbol: p.symbol };
    }
  });
  if (_posChangeBaseline === null) { _posChangeBaseline = cur; return; }
  const prev = _posChangeBaseline;
  _posChangeBaseline = cur;
  // Privacy mode: announce the event, never the figures (toasts are on-screen).
  const priv = document.body.classList.contains("privacy-on");
  for (const k in cur) {
    if (!prev[k]) {
      toast(`Position opened: ${cur[k].side} ${cur[k].symbol}${priv ? "" : " " + fmtNum(cur[k].size, 4)}`, "info", 6000);
    } else if (prev[k].size !== cur[k].size) {
      toast(
        priv
          ? `${cur[k].symbol} position size changed`
          : `${cur[k].symbol} size ${fmtNum(prev[k].size, 4)} → ${fmtNum(cur[k].size, 4)}`,
        "info", 6000
      );
    }
  }
  for (const k in prev) {
    if (!cur[k]) toast(`Position closed: ${prev[k].symbol}`, "info", 6000);
  }
}

// ---------------------------------------------------------------------------
// Action handlers (admin)
// ---------------------------------------------------------------------------
function ensureToken() {
  if (!state.tradeToken) {
    toast("Enter the trade token (top of the order rail on the Dashboard) to unlock trading.", "warn");
    return false;
  }
  return true;
}

// Safely read a JSON payload embedded in a row button's data-* attribute.
// A malformed attribute must never throw an uncaught error inside the delegated
// click handler (which would make the button silently do nothing).
function parseRowData(el, attr) {
  try {
    return JSON.parse(el.getAttribute(attr));
  } catch (err) {
    toast("Could not read position/order data — please refresh and retry.", "neg");
    return null;
  }
}

document.addEventListener("click", async (e) => {
  const tradeBtn = e.target.closest("[data-trade]");
  if (tradeBtn) {
    loadSymbolIntoTicket(tradeBtn.getAttribute("data-trade"));
    return;
  }

  const tpslBtn = e.target.closest("[data-tpsl]");
  if (tpslBtn) {
    const payload = parseRowData(tpslBtn, "data-tpsl");
    if (!payload) return;
    if (!ensureToken()) return;
    openTpslModal(payload);
    return;
  }

  const closeBtn = e.target.closest("[data-close]");
  if (closeBtn) {
    const payload = parseRowData(closeBtn, "data-close");
    if (!payload) return;
    if (!ensureToken()) return;
    await withWriteLock(async () => {
      // Enrich the confirm with the load-bearing fact: the unrealised PnL this
      // close will realise (looked up from the live position snapshot).
      const pos = (state.lastPositions || []).find(
        (p) => p.symbol === payload.symbol &&
          String(p.positionIdx ?? 0) === String(payload.positionIdx ?? 0)
      );
      const lines = [
        ["Symbol", payload.symbol],
        ["Action", "Close · market reduce-only"],
        ["Size (live)", String(payload.qty)],
      ];
      if (pos && isFinite(Number(pos.unrealisedPnl))) {
        lines.push(["Unrealised PnL to realise", `${fmtSigned(pos.unrealisedPnl)} ${settleCoin()}`]);
      }
      const liveQty = Number(payload.qty);
      const ok = await typedConfirm({
        head: `Close ${payload.symbol}`,
        lines,
        note: "Sends a market order on the opposite side; reduce-only can only shrink the position.",
      }, {
        // Partial close: pick the portion of the LIVE position to exit. The
        // server re-derives the size from the exchange and floors the slice to
        // the lot step — the figure here is a preview, never the payload qty.
        percents: [25, 50, 75, 100],
        hint: (pct) =>
          pct === 100
            ? "Closes the entire position."
            : `Closes ≈ ${isFinite(liveQty) ? fmtNum((liveQty * pct) / 100, 4) : "…"} of ${payload.qty} (exact size floors to the lot step server-side).`,
      });
      if (!ok) return;
      const pct = Number(ok.percent) > 0 && Number(ok.percent) < 100 ? Number(ok.percent) : 100;
      closeBtn.disabled = true;
      const row = closeBtn.closest("tr");
      try {
        // percent omitted on a full close — the request stays byte-identical to
        // the pre-partial-close behaviour (server echoes the exact live size).
        await writeApi("/api/position/close", pct < 100 ? { ...payload, percent: pct } : payload);
        toast(`✓ Close order sent for ${payload.symbol}${pct < 100 ? ` (${pct}%)` : ""}`, "pos");
        // Optimistic dim only when the whole row is on its way out.
        if (row && pct === 100) row.style.opacity = "0.45";
        refreshDashboardSoon();
      } catch (err) {
        toast("Close failed: " + err.message, "neg");
      } finally {
        closeBtn.disabled = false;
      }
    });
    return;
  }

  const amendBtn = e.target.closest("[data-amend]");
  if (amendBtn) {
    const payload = parseRowData(amendBtn, "data-amend");
    if (!payload) return;
    if (!ensureToken()) return;
    await withWriteLock(async () => {
      // Amend = cancel + edit in the ticket. The venue exposes no verified
      // in-place amend on this gateway, and cancel-then-resubmit keeps the
      // ticket as the ONE write surface; nothing is re-placed until submit.
      const ok = await typedConfirm({
        head: `Amend ${payload.symbol} order`,
        lines: [
          ["Order", String(payload.orderId)],
          ["Current", `${payload.side} ${payload.qty}${payload.price && Number(payload.price) ? " @ " + payload.price : ""}`],
        ],
        note: "Cancels this order and loads its parameters into the ticket to adjust and resubmit. Nothing is re-placed until you submit.",
      });
      if (!ok) return;
      amendBtn.disabled = true;
      try {
        await writeApi("/api/order/cancel", { symbol: payload.symbol, orderId: payload.orderId });
        toast("✓ Order cancelled — adjust and resubmit from the ticket", "pos");
        prefillTicketFromOrder(payload);
        refreshDashboardSoon();
      } catch (err) {
        toast("Amend failed: " + err.message, "neg");
      } finally {
        amendBtn.disabled = false;
      }
    });
    return;
  }

  const cancelBtn = e.target.closest("[data-cancel]");
  if (cancelBtn) {
    const payload = parseRowData(cancelBtn, "data-cancel");
    if (!payload) return;
    if (!ensureToken()) return;
    await withWriteLock(async () => {
      const ok = await typedConfirm(`Cancel order ${payload.orderId} (${payload.symbol})?`);
      if (!ok) return;
      cancelBtn.disabled = true;
      const row = cancelBtn.closest("tr");
      try {
        await writeApi("/api/order/cancel", payload);
        toast(`✓ Cancel sent for ${payload.symbol}`, "pos");
        if (row) row.style.opacity = "0.45"; // optimistic: row is being cancelled
        refreshDashboardSoon();
      } catch (err) {
        toast("Cancel failed: " + err.message, "neg");
      } finally {
        cancelBtn.disabled = false;
      }
    });
  }
});

// Restore keyboard focus to a row after a re-render destroys-and-rebuilds it
// (matched by its stable data key rather than a CSS selector, to avoid any
// selector-injection from exchange-controlled symbols).
function focusRowByKey(containerSel, attr, key) {
  document.querySelectorAll(`${containerSel} tr.exp-row`).forEach((r) => {
    if (r.dataset[attr] === key) r.focus();
  });
}

// Expand/collapse a position or order row. Used by both pointer and keyboard.
function toggleRowExpand(row) {
  if (row.matches("#positions-body tr.exp-row")) {
    const key = row.dataset.pkey;
    state.expandedPos.has(key) ? state.expandedPos.delete(key) : state.expandedPos.add(key);
    renderPositions(state.lastPositions);
    focusRowByKey("#positions-body", "pkey", key);
    return true;
  }
  if (row.matches("#orders-body tr.exp-row")) {
    const key = row.dataset.okey;
    state.expandedOrders.has(key) ? state.expandedOrders.delete(key) : state.expandedOrders.add(key);
    renderOrders(state.lastOrders);
    focusRowByKey("#orders-body", "okey", key);
    return true;
  }
  return false;
}

// Toggle the sort for a sortable header. Used by both pointer and keyboard.
function sortByHeader(th) {
  const table = th.closest("table");
  const st = table.id === "positions-table" ? state.sortPos : state.sortOrders;
  const key = th.dataset.sortkey;
  if (st.key === key) st.dir *= -1;
  else { st.key = key; st.dir = 1; }
  if (table.id === "positions-table") renderPositions(state.lastPositions);
  else renderOrders(state.lastOrders);
}

document.addEventListener("click", (e) => {
  // Sortable header click → sort.
  const th = e.target.closest("table.sortable thead th[data-sortkey]");
  if (th) { sortByHeader(th); return; }
  // Row click (not on an action control) → expand/collapse.
  if (e.target.closest("button, a, input, select")) return;
  const row = e.target.closest("#positions-body tr.exp-row, #orders-body tr.exp-row");
  if (row) toggleRowExpand(row);
});

// Keyboard parity: Enter/Space activates a focused sortable header or row.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
  const el = e.target;
  if (!el || !el.closest) return;
  const th = el.closest("table.sortable thead th[data-sortkey]");
  if (th && el === th) { e.preventDefault(); sortByHeader(th); return; }
  const row = el.closest("#positions-body tr.exp-row, #orders-body tr.exp-row");
  if (row && el === row) { e.preventDefault(); toggleRowExpand(row); }
});

// ---------------------------------------------------------------------------
// TP/SL modal for an existing position (Full mode, market exit). The trade
// token is required; positionIdx is sent and re-verified server-side.
// ---------------------------------------------------------------------------
let _tpslOpen = false;
function openTpslModal(pos) {
  if (_tpslOpen) return;
  _tpslOpen = true;
  // Set once cleanup runs so a late finally/catch from an in-flight write can't
  // write to (or re-enable) this modal's shared DOM nodes after they've been
  // handed to a reopened modal.
  let closed = false;
  const _prevFocus = document.activeElement;

  const overlay = $("#tpsl-overlay");
  const tpInput = $("#tpsl-tp");
  const slInput = $("#tpsl-sl");
  const trigger = $("#tpsl-trigger");
  const out = $("#tpsl-result");
  const preview = $("#tpsl-preview");
  const applyBtn = $("#tpsl-apply");
  const cancelBtn = $("#tpsl-cancel");

  const cur = (v) =>
    v !== undefined && v !== null && v !== "" && Number(v) !== 0 ? String(v) : "";

  // Live "projected net PnL (ROI%)" preview as the user types a TP/SL price.
  const previewLine = (label, price) => {
    const r = projectedPnl({
      side: pos.side, entry: pos.avgPrice, exitPrice: price, size: pos.size, leverage: pos.leverage,
    });
    if (!r) return "";
    // Write surface — keep the projected PnL in USDT (convert=false) to match the
    // USDT-denominated inputs above it.
    return `<div>${label} @ ${esc(price)}: ${projAmount(r, true, false)} ${esc(settleCoin())} <span class="muted">net of exit fee</span></div>`;
  };
  const updatePreview = () => {
    const tp = tpInput.value.trim();
    const sl = slInput.value.trim();
    let html = "";
    if (tp && Number(tp) > 0) html += previewLine("TP", tp);
    if (sl && Number(sl) > 0) html += previewLine("SL", sl);
    preview.innerHTML = html;
  };

  $("#tpsl-title").textContent = `Set TP / SL — ${pos.symbol}`;
  $("#tpsl-context").textContent = `${pos.side} · entry ${fmtNum(pos.avgPrice, 4)} · mark ${fmtNum(pos.markPrice, 4)} · prices in USDT`;
  tpInput.value = cur(pos.takeProfit);
  slInput.value = cur(pos.stopLoss);
  trigger.value = "LastPrice";

  // One-click presets: PRE-FILL only (the user still reviews + applies with the
  // trade token, and the server re-derives the position — nothing is sent from
  // here). Direction-aware: SL lands on the losing side of mark, TP on the
  // winning side; BE = break-even (fees included) with entry as the fallback.
  const presets = document.getElementById("tpsl-presets");
  const markPx = Number(pos.markPrice);
  const isLong = String(pos.side).toLowerCase() === "buy";
  const bePx = Number(pos.breakEvenPrice) > 0 ? Number(pos.breakEvenPrice) : Number(pos.avgPrice);
  const tickSize = (state.specs[pos.symbol] || {}).tickSize;
  const snapPx = (v) => {
    const snapped = tickSize != null ? snapToStep(v, tickSize) : null;
    return snapped != null && Number(snapped) > 0 ? snapped : String(Number(v.toFixed(4)));
  };
  const onPreset = (ev) => {
    const b = ev.target.closest("button[data-kind]");
    if (!b) return;
    let px;
    if (b.dataset.be) {
      px = bePx;
    } else {
      const pct = Number(b.dataset.pct) / 100;
      const dir = b.dataset.kind === "sl" ? (isLong ? -1 : 1) : (isLong ? 1 : -1);
      px = markPx * (1 + dir * pct);
    }
    if (!(px > 0)) return;
    (b.dataset.kind === "sl" ? slInput : tpInput).value = snapPx(px);
    updatePreview();
  };
  if (presets) {
    if (isFinite(markPx) && markPx > 0) {
      const slBtn = (pct) => `<button type="button" data-kind="sl" data-pct="${pct}" title="Stop ${pct}% beyond mark, against the position">${pct}%</button>`;
      const tpBtn = (pct) => `<button type="button" data-kind="tp" data-pct="${pct}" title="Target ${pct}% beyond mark, in the position's favour">${pct}%</button>`;
      presets.innerHTML =
        `<span class="pp-k">SL</span>` +
        (bePx > 0 ? `<button type="button" data-kind="sl" data-be="1" title="Stop at break-even (fees included)">BE</button>` : "") +
        [1, 2, 5].map(slBtn).join("") +
        `<span class="pp-k">TP</span>` + [1, 2, 5].map(tpBtn).join("");
      presets.addEventListener("click", onPreset);
    } else {
      presets.innerHTML = "";
    }
  }
  out.textContent = "";
  out.className = "result-msg";
  applyBtn.disabled = false; // clear a stuck-disabled state from a prior write
  overlay.hidden = false;
  updatePreview();
  tpInput.focus();
  const _untrap = focusTrap(overlay.querySelector(".modal"));

  const cleanup = () => {
    closed = true;
    overlay.hidden = true;
    applyBtn.removeEventListener("click", onApply);
    cancelBtn.removeEventListener("click", onCancel);
    overlay.removeEventListener("click", onOverlay);
    document.removeEventListener("keydown", onKey);
    tpInput.removeEventListener("input", updatePreview);
    slInput.removeEventListener("input", updatePreview);
    if (presets) {
      presets.removeEventListener("click", onPreset);
      presets.innerHTML = ""; // never leak this position's presets into the next open
    }
    _untrap();
    restoreFocus(_prevFocus);
    _tpslOpen = false;
  };
  const onCancel = () => cleanup();
  const onOverlay = (ev) => { if (ev.target === overlay) cleanup(); };
  const onKey = (ev) => { if (ev.key === "Escape") cleanup(); };

  const onApply = () => {
    const tp = tpInput.value.trim();
    const sl = slInput.value.trim();
    if (!tp && !sl) {
      out.textContent = "Enter a Take Profit and/or Stop Loss (0 to cancel).";
      out.className = "result-msg neg";
      return;
    }
    for (const [name, v] of [["Take Profit", tp], ["Stop Loss", sl]]) {
      if (v && !(Number(v) >= 0)) {
        out.textContent = `${name} must be a number ≥ 0 (0 cancels).`;
        out.className = "result-msg neg";
        return;
      }
    }
    const body = { symbol: pos.symbol, positionIdx: pos.positionIdx, triggerBy: trigger.value };
    if (tp) body.takeProfit = tp;
    if (sl) body.stopLoss = sl;

    out.textContent = "Applying…";
    out.className = "result-msg";
    applyBtn.disabled = true;
    withWriteLock(async () => {
      try {
        await writeApi("/api/position/trading-stop", body);
        // The write settled; surface the outcome regardless of modal state.
        toast(`✓ TP/SL applied for ${pos.symbol}`, "pos");
        refreshDashboardSoon();
        if (closed) return; // modal already dismissed — don't touch its shared DOM
        out.textContent = "✓ TP/SL applied";
        out.className = "result-msg pos";
        setTimeout(cleanup, 800);
      } catch (err) {
        if (closed) return;
        out.textContent = "✗ " + err.message;
        out.className = "result-msg neg";
      } finally {
        if (!closed) applyBtn.disabled = false;
      }
    });
  };

  applyBtn.addEventListener("click", onApply);
  cancelBtn.addEventListener("click", onCancel);
  overlay.addEventListener("click", onOverlay);
  document.addEventListener("keydown", onKey);
  tpInput.addEventListener("input", updatePreview);
  slInput.addEventListener("input", updatePreview);
}

// Run a token-gated write while disabling its submit button. The trade token
// is always required; the typed-"confirm" modal is shown unless the spec sets
// skipConfirm (used for lower-risk actions like set-leverage).
// `gather` returns {body, confirmMsg, successMsg, skipConfirm?} or null to abort.
async function runWrite(submitBtn, out, gather) {
  if (out) { out.textContent = ""; out.className = "result-msg"; }
  if (!ensureToken()) return;
  await withWriteLock(async () => {
    let spec;
    try {
      spec = gather();
    } catch (err) {
      if (out) { out.textContent = "✗ " + err.message; out.classList.add("neg"); }
      return;
    }
    if (!spec) return;
    const ok = spec.skipConfirm ? true : await typedConfirm(spec.confirmMsg);
    if (!ok) return;
    const prevLabel = submitBtn ? submitBtn.textContent : null;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Working…"; }
    try {
      const res = await writeApi(spec.path, spec.body);
      const msg = spec.successMsg(res);
      if (out) { out.textContent = msg; out.classList.add("pos"); }
      if (msg) toast(msg, "pos");
      if (spec.onSuccess) spec.onSuccess();
    } catch (err) {
      if (out) { out.textContent = "✗ " + err.message; out.classList.add("neg"); }
      toast(err.message, "neg");
      if (spec.onError) {
        try { spec.onError(err); } catch (e) { /* never mask the original failure */ }
      }
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = prevLabel; }
    }
  });
}

function wireTradeToken() {
  const field = $("#trade-token");
  const status = $("#token-status");
  if (!field) return;
  let timer;
  const setStatus = (text, cls) => {
    status.textContent = text;
    status.className = "token-status " + cls;
  };
  // Verify the token with the server (debounced) so the user sees VALID/INVALID
  // the moment they enter it, not only when they first try to trade.
  const verify = async (token) => {
    try {
      const res = await api("/api/verify-trade-token", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      if (field.value.trim() !== token) return; // field changed since request
      setStatus(res.valid ? "VALID" : "INVALID", res.valid ? "ready" : "invalid");
    } catch (e) {
      if (field.value.trim() !== token) return;
      setStatus("CHECK FAILED", "invalid");
    }
  };
  const sync = () => {
    const token = field.value.trim();
    state.tradeToken = token;
    clearTimeout(timer);
    if (!token) {
      setStatus("LOCKED", "locked");
      return;
    }
    setStatus("CHECKING…", "checking");
    timer = setTimeout(() => verify(token), 400);
  };
  field.addEventListener("input", sync);
  sync();
}

function wireAdminForms() {
  if (state.role !== "admin") return;

  wireTradeToken();

  // Toggle the limit-only fields (price + time-in-force) for limit orders.
  const orderType = $("#order-type");
  const limitFields = document.querySelectorAll(".limit-only");
  const syncLimit = () => {
    limitFields.forEach((el) => { el.style.display = orderType.value === "Limit" ? "" : "none"; });
  };
  orderType.addEventListener("change", syncLimit);
  syncLimit();

  $("#order-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    runWrite(f.querySelector("button[type=submit]"), $("#order-result"), () => {
      const body = {
        symbol: f.symbol.value.trim().toUpperCase(),
        side: f.side.value,
        orderType: f.orderType.value,
        qty: f.qty.value.trim(),
        positionIdx: 0,
      };
      // The order is ALWAYS sent as a base-coin qty. In Margin mode that qty was
      // derived from the margin input; a blank/zero derived qty means no price was
      // resolvable or the margin rounded below the lot step. Defence-in-depth:
      // reject qty <= 0 here too (the server also validates) so nothing invalid can
      // reach the money path. This blocks no order the exchange would have accepted.
      const sizedByMargin = f.sizeMode.value === "margin";
      if (!body.symbol) throw new Error("symbol is required");
      if (!body.qty || !(Number(body.qty) > 0)) {
        throw new Error(
          sizedByMargin
            ? "Enter a margin amount — plus a limit price (or wait for the market price) — so a quantity can be derived"
            : "quantity is required"
        );
      }
      if (f.orderType.value === "Limit") {
        body.price = f.price.value.trim();
        if (!body.price) throw new Error("limit price is required for a Limit order");
        // GTC is the exchange default — omitted so a default order's payload
        // stays byte-identical to before the TIF control existed.
        const tif = f.timeInForce.value;
        if (tif && tif !== "GTC") body.timeInForce = tif;
      }
      if (f.reduceOnly.checked) body.reduceOnly = true;

      // Optional TP/SL attached at order creation.
      const tp = f.takeProfit.value.trim();
      const sl = f.stopLoss.value.trim();
      if ((tp || sl) && body.reduceOnly) {
        throw new Error("Take Profit / Stop Loss cannot be set on a reduce-only order");
      }
      if (tp) {
        if (!(Number(tp) > 0)) throw new Error("Take Profit must be greater than 0");
        body.takeProfit = tp;
      }
      if (sl) {
        if (!(Number(sl) > 0)) throw new Error("Stop Loss must be greater than 0");
        body.stopLoss = sl;
      }

      // Advisory spec checks — these NEVER block a submit. The server stays
      // authoritative (exactly as before this change); any concern is surfaced
      // as a warning in the confirm modal so the order is still sent and the
      // exchange decides. This guarantees no order main would have sent is blocked.
      const spec = state.specs[body.symbol];
      const specWarnings = [];
      if (spec) {
        const qn = Number(body.qty);
        if (spec.minOrderQty != null && qn < Number(spec.minOrderQty))
          specWarnings.push(`Qty ${body.qty} is below the ${body.symbol} minimum (${spec.minOrderQty}); the exchange may reject it.`);
        if (spec.maxOrderQty != null && Number(spec.maxOrderQty) > 0 && qn > Number(spec.maxOrderQty))
          specWarnings.push(`Qty ${body.qty} exceeds the ${body.symbol} maximum (${spec.maxOrderQty}); the exchange may reject it.`);
        // Off-tick prices are rejected by the exchange only AFTER the whole
        // confirm ceremony — warn up front instead. snapToStep returns the
        // floored on-grid multiple, so any difference means off-grid. Advisory
        // only, like every spec check (the server/exchange stay authoritative).
        if (spec.tickSize != null) {
          const offTick = (v) => {
            const snapped = snapToStep(v, spec.tickSize);
            return snapped != null && Number(snapped) !== Number(v);
          };
          [["Price", body.price], ["Take Profit", body.takeProfit], ["Stop Loss", body.stopLoss]]
            .forEach(([name, v]) => {
              if (v && offTick(v))
                specWarnings.push(`${name} ${v} is not a multiple of the ${body.symbol} tick size (${spec.tickSize}); the exchange may reject it.`);
            });
        }
      }

      // A Market order sized by margin derives qty from the last fetched price,
      // which refreshes on symbol/type change (not continuously). Warn if it has
      // gone stale so a drifted quote isn't trusted blindly for the size. (Leverage
      // no longer needs an "assumed" warning — the qty is derived from the exchange's
      // real leverage, and margin sizing refuses to proceed when it isn't known.)
      if (sizedByMargin && String(body.orderType).toLowerCase() === "market") {
        const lp = state.orderLastPrice;
        const ageMs = lp && lp.symbol === body.symbol && lp.ts ? Date.now() - lp.ts : null;
        if (ageMs != null && ageMs > 15000) {
          specWarnings.push(`The market price used to size this order is ${Math.round(ageMs / 1000)}s old; re-select the symbol to refresh it if the price may have moved.`);
        }
      }
      // Leverage is fetched on symbol select / after an in-app change, but not
      // continuously — warn if it's old so an out-of-band change (exchange app)
      // isn't silently sized against.
      if (sizedByMargin) {
        const symLev = state.symbolLeverage;
        const ageMs = symLev && symLev.symbol === body.symbol && symLev.ts ? Date.now() - symLev.ts : null;
        if (ageMs != null && ageMs > 300000) {
          specWarnings.push(`Leverage for ${body.symbol} was read ${Math.round(ageMs / 60000)}m ago; if you changed it on the exchange since, re-select the symbol to refresh.`);
        }
      }

      // Enriched confirm: show notional, estimated initial margin and
      // %-of-available so the size is legible before a real-money write.
      // Entry = limit price, else live last.
      let entry = body.price ? Number(body.price) : null;
      if (entry == null && state.orderLastPrice && state.orderLastPrice.symbol === body.symbol) {
        entry = Number(state.orderLastPrice.price);
      }
      const lev = sizingLeverage();
      const lines = [
        ["Side / Type", `${body.side} ${body.orderType}`],
        ["Symbol", body.symbol],
        ["Quantity", String(body.qty)],
      ];
      if (sizedByMargin && lev > 0 && Number(f.margin.value.trim()) > 0) {
        lines.push(["Margin (requested)", `${fmtNum(Number(f.margin.value.trim()))} ${settleCoin()} (${lev}×)`]);
      }
      if (body.price) lines.push(["Limit price", String(body.price)]);
      if (body.timeInForce) lines.push(["Time in force", body.timeInForce]);
      if (entry && Number(body.qty) > 0) {
        const notional = Number(body.qty) * entry;
        lines.push(["Notional", `${fmtNum(notional)} ${settleCoin()}${body.price ? "" : " (est.)"}`]);
        // Reduce-only closes an existing position and commits no new margin, so the
        // initial-margin estimate would be misleading; also omit it if leverage is
        // unknown (never shown against a guess).
        if (!body.reduceOnly && lev > 0) lines.push(["Est. initial margin", `${fmtNum(notional / lev)} ${settleCoin()} (${lev}×)`]);
        if (state.available && state.available > 0) {
          lines.push(["≈ % of available", fmtPct((notional / state.available) * 100, false)]);
        }
      }
      if (body.takeProfit) lines.push(["Take Profit", String(body.takeProfit)]);
      if (body.stopLoss) lines.push(["Stop Loss", String(body.stopLoss)]);
      if (body.reduceOnly) lines.push(["Reduce only", "yes"]);
      return {
        path: "/api/order/create",
        body,
        confirmMsg: { head: `Submit ${body.side} ${body.orderType} order`, lines, note: specWarnings.length ? "⚠ " + specWarnings.join(" ") : undefined },
        successMsg: (res) => "✓ Order submitted" + (res.result?.orderId ? ` (${res.result.orderId})` : ""),
        onSuccess: () => {
          f.reset();
          // Re-sync segmented toggles + dependent UI to the reset select values.
          f.side.dispatchEvent(new Event("change", { bubbles: true }));
          f.orderType.dispatchEvent(new Event("change", { bubbles: true }));
          f.sizeMode.dispatchEvent(new Event("change", { bubbles: true }));
          state.symbolLeverage = null; // symbol cleared by reset; drop its cached leverage
          syncLimit();
          updateOrderPreview();
          // Repaint the Submit label AFTER runWrite's finally restores the pre-submit
          // label, so it reflects the reset form (no stale symbol) rather than the
          // label captured at submit time.
          setTimeout(paintSubmit, 0);
          refreshDashboardSoon(); // surface the new resting order / position promptly
        },
      };
    });
  });

  // --- live notional + projected-PnL preview for the order form ---
  // Entry is the limit price for Limit orders; for Market orders we use the
  // symbol's live last price (from the tickers API) as an estimate. Shows a
  // notional (qty × price) hint always, and a projected-PnL preview when TP/SL
  // are set. ROI is omitted here ($ only) because the form has no leverage input.
  const orderForm = $("#order-form");
  const orderPreview = $("#order-pnl-preview");
  const orderNotional = $("#order-notional");
  let _lastPriceTimer;

  // Declared as hoisted functions (not const arrows) so the order-form
  // onSuccess closure above can call updateOrderPreview regardless of source
  // ordering — avoids any "before initialization" footgun on the trade path.
  async function fetchMarketPrice(symbol) {
    if (!symbol) return;
    try {
      const data = await api(`/api/tickers?symbol=${encodeURIComponent(symbol)}`);
      const t = ((data.result && data.result.list) || [])[0];
      if (t && t.lastPrice) state.orderLastPrice = { symbol, price: t.lastPrice, ts: Date.now() };
    } catch (e) {
      /* preview simply won't render for market until a price is available */
    }
    updateOrderPreview();
  }

  // The account's REAL leverage for the active symbol, fetched from the exchange
  // on symbol change (see fetchSymbolLeverage) and used by the %-buttons and the
  // Margin→Quantity conversion. It is NEVER sent with the order. Returns null when
  // it isn't known yet (still loading, fetch failed, or no symbol) — callers must
  // then refuse to size rather than guess, since a wrong leverage mis-sizes real
  // money. Guarded by symbol so a stale value is never used for a different coin.
  function sizingLeverage() {
    const sl = state.symbolLeverage;
    if (!sl || sl.symbol !== orderForm.symbol.value.trim().toUpperCase()) return null;
    const lev = Number(sl.leverage);
    return lev > 0 && isFinite(lev) ? lev : null;
  }

  // Render the read-only leverage chip: a value, "loading" while a fetch is in
  // flight for the current symbol, or "unavailable" if the fetch couldn't resolve it.
  function updateLeverageDisplay() {
    const el = document.getElementById("sizing-lev-display");
    if (!el) return;
    const sym = orderForm.symbol.value.trim().toUpperCase();
    const sl = state.symbolLeverage;
    if (!sym) { el.innerHTML = "lev —"; return; }
    if (!sl || sl.symbol !== sym) { el.innerHTML = 'lev <span class="muted">…</span>'; return; }
    el.innerHTML = sl.leverage > 0
      ? `lev <b>${esc(String(sl.leverage))}×</b>`
      : 'lev <span class="warn">unavailable</span>';
  }

  // Monotonic token so a slower reply for the SAME symbol can't overwrite a newer
  // one (e.g. symbol re-selected, or a set-leverage re-fetch races the initial).
  let _levSeq = 0;

  // Fetch the exchange's real leverage for `symbol` and cache it in state. Guards:
  //  * out-of-order: applied only if it's still the LATEST request AND the field
  //    still holds this symbol (covers same-symbol and cross-symbol races);
  //  * fail-open: on error, leverage is marked unknown (null) — the ticket keeps
  //    working (Quantity mode unaffected; Margin mode refuses to guess);
  //  * empty symbol clears it. A cached record with leverage===null means
  //    "resolved but unavailable" (distinct from "still loading" = no record yet).
  async function fetchSymbolLeverage(symbol) {
    const sym = (symbol || "").trim().toUpperCase();
    const seq = ++_levSeq;
    if (!sym) { state.symbolLeverage = null; updateLeverageDisplay(); return; }
    let leverage = null;
    try {
      const data = await api(`/api/position/leverage?symbol=${encodeURIComponent(sym)}`);
      const lev = Number(data && data.leverage);
      if (lev > 0 && isFinite(lev)) leverage = lev;
    } catch (e) {
      /* leave leverage null -> sizing refuses to guess; never blocks the ticket */
    }
    if (seq !== _levSeq || orderForm.symbol.value.trim().toUpperCase() !== sym) return; // superseded
    state.symbolLeverage = { symbol: sym, leverage, ts: Date.now() };
    updateLeverageDisplay();
    updateOrderPreview();
  }

  // Base coin of a linear USDT symbol (e.g. "SOLUSDT" -> "SOL") for labelling the
  // derived quantity. Display-only; falls back to the raw symbol.
  function baseCoin(symbol) {
    const s = String(symbol || "").toUpperCase();
    const q = settleCoin();
    return s.endsWith(q) && s.length > q.length ? s.slice(0, -q.length) : s;
  }

  // Entry price used for sizing/preview: the typed limit price for a Limit order,
  // else the symbol's live last price (an estimate) for a Market order. Returns
  // { price: NaN } when no usable price is available yet.
  function resolveEntryPrice() {
    const symbol = orderForm.symbol.value.trim().toUpperCase();
    if (orderForm.orderType.value === "Limit") {
      const p = Number(orderForm.price.value.trim());
      return { price: p > 0 ? p : NaN, estimate: false };
    }
    if (state.orderLastPrice && state.orderLastPrice.symbol === symbol) {
      const p = Number(state.orderLastPrice.price);
      return { price: p > 0 ? p : NaN, estimate: true };
    }
    return { price: NaN, estimate: false };
  }

  // Margin sizing: in 'Margin' mode the user enters the USDT margin to commit and
  // we DERIVE the authoritative base-coin quantity (qty = margin × lev ÷ price),
  // floored to the lot step. The order payload is ALWAYS the qty field — the
  // margin value is never sent to the exchange. Re-run on every relevant change
  // so qty can never lag its inputs. No-op (never touches qty) in 'Quantity' mode.
  function recomputeMarginQty(price) {
    if (orderForm.sizeMode.value !== "margin") return;
    const margin = Number(orderForm.margin.value.trim());
    const lev = sizingLeverage();
    const sym = orderForm.symbol.value.trim().toUpperCase();
    // Need margin, price AND the real leverage — never guess leverage on the money
    // path. A null leverage (still loading / fetch failed) clears qty so the submit
    // guard blocks it and the hint explains why.
    if (!(margin > 0) || !(price > 0) || !(lev > 0)) { orderForm.qty.value = ""; return; }
    const spec = state.specs[sym];
    // Never derive a qty without the instrument's lot step: an unfloored qty is
    // rejected by the exchange and would make the notional/margin preview wrong.
    // Clear qty until the spec loads (fetchInstrumentSpec re-runs this on arrival).
    if (!spec || spec.qtyStep == null) { orderForm.qty.value = ""; return; }
    const snapped = snapToStep((margin * lev) / price, spec.qtyStep);
    // Flooring to the lot step can round a tiny margin down to 0 — treat that as
    // "no quantity" so the submit guard blocks it rather than sending qty "0".
    orderForm.qty.value = snapped && Number(snapped) > 0 ? snapped : "";
  }

  function updateOrderPreview() {
    const symbol = orderForm.symbol.value.trim().toUpperCase();
    const side = orderForm.side.value;
    const { price: entryNum, estimate } = resolveEntryPrice();

    updateLeverageDisplay();

    // In Margin mode, re-derive qty BEFORE reading it so the notional/PnL below
    // and the submitted order all reflect the current margin/lev/price inputs.
    recomputeMarginQty(entryNum);

    const qty = orderForm.qty.value.trim();
    const tp = orderForm.takeProfit.value.trim();
    const sl = orderForm.stopLoss.value.trim();
    const entry = entryNum > 0 ? String(entryNum) : "";
    const marginMode = orderForm.sizeMode.value === "margin";
    const lev = sizingLeverage(); // real leverage, or null if not known yet

    // Sizing hint: notional (qty × price) and the initial margin it implies
    // (notional ÷ leverage). In Margin mode we also lead with the resolved qty so
    // the exact size being ordered is always visible before submit. Reduce-only
    // orders commit no new margin, so the margin figure is omitted for them.
    if (orderNotional) {
      const marginTyped = Number(orderForm.margin.value.trim());
      const reduceOnly = orderForm.reduceOnly.checked;
      const spec = state.specs[symbol];
      if (Number(qty) > 0 && entryNum > 0) {
        const notional = Number(qty) * entryNum;
        const parts = [];
        if (marginMode) parts.push(`→ <b>${esc(qty)}</b> ${esc(baseCoin(symbol))}`);
        parts.push(`${fmtNum(notional)} ${esc(settleCoin())} notional${estimate ? " (at market)" : ""}`);
        // Margin figure only when the real leverage is known (never shown against a guess).
        if (!reduceOnly && lev > 0) parts.push(`margin ≈ <b>${fmtNum(notional / lev)}</b> ${esc(settleCoin())} <span class="muted">(${lev}×)</span>`);
        // Entry-fee estimate: a market order pays taker; a limit can fill either
        // side, so show the maker–taker band (Post-Only pins it to maker).
        if (orderForm.orderType.value === "Market") {
          parts.push(`fee ≈ ${fmtNum(notional * TAKER_FEE_RATE, 4)}`);
        } else if (orderForm.timeInForce && orderForm.timeInForce.value === "PostOnly") {
          parts.push(`fee ≈ ${fmtNum(notional * MAKER_FEE_RATE, 4)} <span class="muted">(maker)</span>`);
        } else {
          parts.push(`fee ≈ ${fmtNum(notional * MAKER_FEE_RATE, 4)}–${fmtNum(notional * TAKER_FEE_RATE, 4)}`);
        }
        orderNotional.innerHTML = parts.join('<span class="sep">·</span>');
      } else if (marginMode && marginTyped > 0 && !(entryNum > 0)) {
        orderNotional.innerHTML = `<span class="warn">enter a limit price (or wait for the market price) to size by margin</span>`;
      } else if (marginMode && marginTyped > 0 && !(lev > 0)) {
        // Distinguish "still fetching" (no record for this symbol yet) from
        // "resolved but no leverage available" (fetch returned/failed) so the hint
        // doesn't say "loading…" forever after a failure or on a hedge account.
        const resolved = state.symbolLeverage && state.symbolLeverage.symbol === symbol;
        orderNotional.innerHTML = resolved
          ? `<span class="warn">leverage unavailable for ${esc(baseCoin(symbol))} — size by Quantity, or set leverage under Account</span>`
          : `<span class="muted">loading leverage for ${esc(baseCoin(symbol))}…</span>`;
      } else if (marginMode && marginTyped > 0 && (!spec || spec.qtyStep == null)) {
        orderNotional.innerHTML = `<span class="muted">loading ${esc(baseCoin(symbol))} contract details…</span>`;
      } else if (marginMode && marginTyped > 0 && entryNum > 0) {
        const minTxt = spec && spec.minOrderQty != null ? ` (min ${esc(spec.minOrderQty)})` : "";
        orderNotional.innerHTML = `<span class="warn">margin too small for one lot step${minTxt} — increase margin or leverage</span>`;
      } else {
        orderNotional.textContent = "";
      }
    }

    if (!entry || !qty || (!tp && !sl) || orderForm.reduceOnly.checked) {
      orderPreview.innerHTML = "";
      return;
    }
    const line = (label, price) => {
      if (!(Number(price) > 0)) return "";
      const r = projectedPnl({ side, entry, exitPrice: price, size: qty });
      if (!r) return "";
      const note = estimate ? `net of exit fee · est. entry ${esc(entry)}` : "net of exit fee";
      // Write surface (order ticket) — keep the projected PnL in USDT (convert=false)
      // to match the USDT label and the USDT-denominated inputs.
      return `<div>${label} @ ${esc(price)}: ${projAmount(r, false, false)} ${esc(settleCoin())} <span class="muted">${note}</span></div>`;
    };
    orderPreview.innerHTML = line("TP", tp) + line("SL", sl);
  }

  // A preview must never interfere with typing into the order form: any error
  // here is swallowed so it can't disrupt the (separate) submit handler.
  ["input", "change"].forEach((ev) =>
    orderForm.addEventListener(ev, (e) => {
      try {
        if (e.target.name === "symbol") {
          const sym = orderForm.symbol.value.trim().toUpperCase();
          clearTimeout(_lastPriceTimer);
          _lastPriceTimer = setTimeout(() => {
            fetchSymbolLeverage(sym);  // REAL account leverage — issued first (drives margin sizing)
            fetchMarketPrice(sym);     // live last price (sizing + market preview)
            fetchInstrumentSpec(sym);  // tick/lot filters -> spec strip
            setActiveSymbol(sym);      // load the order-book widget for this symbol
          }, 400);
        } else if (e.target.name === "orderType" && orderForm.orderType.value === "Market") {
          const sym = orderForm.symbol.value.trim().toUpperCase();
          clearTimeout(_lastPriceTimer);
          _lastPriceTimer = setTimeout(() => fetchMarketPrice(sym), 400);
        }
        updateOrderPreview();
      } catch (err) {
        console.debug("order preview update failed", err);
      }
    })
  );

  // %-of-balance sizing: "commit X% of available as margin". In Margin mode we fill
  // the margin field (qty is derived from it once leverage/price load); in Quantity
  // mode we fill qty directly using the REAL leverage. Both resolve to the SAME
  // size: qty = (avail × pct × lev) ÷ price. Leverage is never part of the payload.
  const sizingBtns = document.getElementById("sizing-btns");
  if (sizingBtns) {
    sizingBtns.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-pct]");
      if (!b) return;
      const pct = Number(b.dataset.pct) / 100;
      const avail = Number(state.available);
      const sym = orderForm.symbol.value.trim().toUpperCase();
      if (!(avail > 0)) { toast("Available balance not loaded yet.", "warn"); return; }
      if (orderForm.sizeMode.value === "margin") {
        // The margin <input> shows a raw balance-derived figure that CSS privacy
        // masking cannot hide (it masks text, not input values). Don't leak the
        // balance on screen while privacy mode is on.
        if (document.body.classList.contains("privacy-on")) {
          toast("Turn off privacy mode to size by % (it would show your balance).", "warn");
          return;
        }
        // Setting the margin is valid regardless of leverage; qty derives once the
        // real leverage (and price) are available.
        orderForm.margin.value = String(Number((avail * pct).toFixed(2)));
        updateOrderPreview();
        return;
      }
      // Quantity mode also writes a balance-derived figure (the qty) into a
      // visible input. CSS privacy masks text, not <input> values, so — exactly
      // like the Margin branch above — refuse to size by % while privacy is on
      // rather than paint the (balance-derived) size on screen.
      if (document.body.classList.contains("privacy-on")) {
        toast("Turn off privacy mode to size by % (it would show your balance).", "warn");
        return;
      }
      // Quantity mode needs the real leverage to convert margin→qty.
      const lev = sizingLeverage();
      if (!(lev > 0)) { toast("Leverage not loaded yet for this symbol.", "warn"); return; }
      let price = orderForm.orderType.value === "Limit" ? Number(orderForm.price.value) : NaN;
      if (!(price > 0) && state.orderLastPrice && state.orderLastPrice.symbol === sym) {
        price = Number(state.orderLastPrice.price);
      }
      if (!(price > 0)) { toast("Enter a symbol (and price for a Limit) to size by %.", "warn"); return; }
      const qty = (avail * pct * lev) / price;
      const spec = state.specs[sym];
      // Mirror recomputeMarginQty: never write an unfloored/full-precision qty.
      // Without the lot step the value isn't snapped (and can render as "1e-7"),
      // which the exchange rejects — clear it and prompt to retry once specs load.
      if (!spec || spec.qtyStep == null) {
        orderForm.qty.value = "";
        toast("Contract details still loading — try again in a moment.", "warn");
        updateOrderPreview();
        return;
      }
      const snapped = snapToStep(qty, spec.qtyStep);
      orderForm.qty.value = snapped && Number(snapped) > 0 ? snapped : "";
      updateOrderPreview();
    });
  }

  // Segmented Buy/Sell & Market/Limit toggles mirror the (sr-only) <select>s,
  // which remain the source of truth — so every existing handler keeps working.
  const wireSegment = (segId, selectEl) => {
    const seg = document.querySelector(segId);
    if (!seg || !selectEl) return;
    const buttons = Array.from(seg.querySelectorAll("button"));
    const paint = () =>
      buttons.forEach((b) => {
        const on = b.dataset.val === selectEl.value;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
    buttons.forEach((b) =>
      b.addEventListener("click", () => {
        if (selectEl.value === b.dataset.val) return;
        selectEl.value = b.dataset.val;
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
        selectEl.dispatchEvent(new Event("input", { bubbles: true }));
        paint();
      })
    );
    // Arrow-key navigation between the mutually-exclusive options (expected of a
    // segmented single-select), moving focus and selection to the adjacent button.
    seg.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      const enabled = buttons.filter((b) => !b.disabled);
      if (enabled.length < 2) return;
      const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      const cur = enabled.indexOf(document.activeElement);
      const next = enabled[((cur < 0 ? 0 : cur) + dir + enabled.length) % enabled.length];
      if (next) { e.preventDefault(); next.click(); next.focus(); }
    });
    // Keep the buttons in sync if the select is reset/changed programmatically
    // (e.g. f.reset() after a successful order).
    selectEl.addEventListener("change", paint);
    paint();
  };
  wireSegment("#seg-side", orderForm.side);
  wireSegment("#seg-type", orderForm.orderType);
  wireSegment("#seg-sizemode", orderForm.sizeMode);

  // Reinforce Buy/Sell intent at the point of commit: colour + label the Submit
  // button to match the selected side (green Buy / red Sell), so a mistoggled side
  // has a last-line-of-defense cue right where the click happens. Reads the side
  // <select> (source of truth); presentation only — the order payload is unchanged.
  const submitBtn = orderForm.querySelector('button[type="submit"]');
  function paintSubmit() {
    if (!submitBtn) return;
    const isBuy = orderForm.side.value === "Buy";
    submitBtn.classList.toggle("submit-buy", isBuy);
    submitBtn.classList.toggle("submit-sell", !isBuy);
    const sym = orderForm.symbol.value.trim().toUpperCase();
    submitBtn.textContent = `${isBuy ? "Buy" : "Sell"}${sym ? " " + sym : ""} order`;
  }
  orderForm.side.addEventListener("change", paintSubmit);
  orderForm.symbol.addEventListener("input", paintSubmit);
  paintSubmit();

  // 'Size by' toggle: show the Quantity input or the Margin input (never both).
  // The Margin field is a sizing helper only — it derives qty (see
  // recomputeMarginQty) and is never part of the order payload.
  const syncSizeMode = () => {
    const marginMode = orderForm.sizeMode.value === "margin";
    // Carry the size across a Quantity→Margin switch: seed the (empty) margin
    // field from the qty already entered so toggling modes never silently
    // discards a size the user typed. Margin = qty × price ÷ leverage.
    if (marginMode && !orderForm.margin.value.trim()) {
      const { price } = resolveEntryPrice();
      const qtyNum = Number(orderForm.qty.value.trim());
      const lev = sizingLeverage();
      if (qtyNum > 0 && price > 0 && lev > 0) {
        orderForm.margin.value = String(Number(((qtyNum * price) / lev).toFixed(2)));
      }
    }
    document.querySelectorAll(".sizeby-qty").forEach((el) => (el.style.display = marginMode ? "none" : ""));
    document.querySelectorAll(".sizeby-margin").forEach((el) => (el.style.display = marginMode ? "" : "none"));
    updateOrderPreview();
  };
  orderForm.sizeMode.addEventListener("change", syncSizeMode);
  syncSizeMode();

  // Reduce-only closes a known position size — committing fresh margin is
  // meaningless there — so lock the form to Quantity mode while it's checked.
  const marginModeBtn = document.querySelector('#seg-sizemode button[data-val="margin"]');
  const syncReduceOnly = () => {
    const ro = orderForm.reduceOnly.checked;
    if (marginModeBtn) {
      marginModeBtn.disabled = ro; // native: a disabled button can't be clicked
      marginModeBtn.setAttribute("aria-disabled", String(ro));
    }
    if (ro && orderForm.sizeMode.value === "margin") {
      orderForm.sizeMode.value = "qty"; // preserves the last derived qty in the field
      orderForm.sizeMode.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  orderForm.reduceOnly.addEventListener("change", syncReduceOnly);
  syncReduceOnly();

  $("#leverage-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    runWrite(f.querySelector("button[type=submit]"), $("#leverage-result"), () => {
      const body = {
        symbol: f.symbol.value.trim().toUpperCase(),
        buyLeverage: f.buyLeverage.value.trim(),
        sellLeverage: f.sellLeverage.value.trim(),
      };
      if (!body.symbol || !body.buyLeverage || !body.sellLeverage)
        throw new Error("symbol and both leverage values are required");

      const reqLev = Math.max(Number(body.buyLeverage) || 0, Number(body.sellLeverage) || 0);
      const spec = state.specs[body.symbol];
      // Advisory only — NEVER blocks (server stays authoritative, as before).
      // An over-max request is surfaced as a warning and forces the typed confirm.
      const overMax = !!(spec && spec.maxLeverage != null && reqLev > Number(spec.maxLeverage));

      // Keep the no-prompt convenience for routine changes, but require the
      // typed confirm for a large jump (≥2× the current leverage, or ≥25x) since
      // that materially moves the liquidation price.
      const posForSym = (state.lastPositions || []).find(
        (p) => p.symbol === body.symbol && Number(p.size) !== 0
      );
      const curLev = posForSym ? Number(posForSym.leverage) : null;
      const bigJump = reqLev >= 25 || (curLev && curLev > 0 && reqLev >= curLev * 2);
      const lvLines = [
        ["Buy leverage", `${body.buyLeverage}×`],
        ["Sell leverage", `${body.sellLeverage}×`],
      ];
      if (curLev) lvLines.push(["Current", `${curLev}×`]);
      return {
        path: "/api/position/set-leverage",
        body,
        skipConfirm: !bigJump && !overMax, // trade token still required regardless
        confirmMsg: {
          head: `Set leverage — ${body.symbol}`,
          lines: lvLines,
          note: overMax
            ? `⚠ ${reqLev}x exceeds the ${body.symbol} maximum (${spec.maxLeverage}x); the exchange may reject it.`
            : "Higher leverage moves your liquidation price closer to the mark.",
        },
        successMsg: () => `✓ Leverage set for ${body.symbol}`,
        onSuccess: () => {
          refreshDashboardSoon();
          // If the ticket is on this symbol, refresh its leverage so the sizer
          // reflects the change immediately.
          if (orderForm.symbol.value.trim().toUpperCase() === body.symbol) fetchSymbolLeverage(body.symbol);
        },
      };
    });
  });

  const cancelAll = $("#cancel-all-btn");
  if (cancelAll) {
    cancelAll.addEventListener("click", () => {
      runWrite(cancelAll, null, () => ({
        path: "/api/order/cancel-all",
        body: {},
        confirmMsg: `Cancel ALL open orders for ${settleCoin()}.`,
        successMsg: () => "✓ Cancel-all sent",
        onSuccess: () => refreshDashboardSoon(),
      })).catch((err) => toast("Cancel-all failed: " + err.message, "neg"));
    });
  }

  $("#margin-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    runWrite(f.querySelector("button[type=submit]"), $("#margin-result"), () => {
      const body = { setMarginMode: f.setMarginMode.value };
      return {
        path: "/api/account/set-margin-mode",
        body,
        confirmMsg: `Set account margin mode to ${body.setMarginMode}.`,
        successMsg: () => `✓ Margin mode set to ${body.setMarginMode}`,
      };
    });
  });

  $("#transfer-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    runWrite(f.querySelector("button[type=submit]"), $("#transfer-result"), () => {
      const amount = Number(f.amount.value);
      if (!(amount > 0) || !isFinite(amount)) throw new Error("amount must be a finite number greater than 0");
      const body = {
        direction: f.direction.value,
        amount,
        quote_asset: f.quote_asset.value,
      };
      // Idempotency key OWNED by the client, keyed on the exact transfer intent
      // (direction+amount+asset). A retry after a local timeout reuses the SAME
      // id, so the exchange dedups it instead of moving funds twice. It is cleared
      // ONLY on confirmed success, so a genuinely-repeated identical transfer
      // later gets a fresh id (and is not wrongly deduped as a replay).
      const intentKey = `${body.direction}|${body.amount}|${body.quote_asset}`;
      body.client_txn_id = transferTxnId(intentKey);
      return {
        path: "/api/funds/transfer",
        body,
        confirmMsg: `Transfer ${body.amount} ${body.quote_asset} (${body.direction}). This moves real funds.`,
        // The backend only resolves on a POSITIVELY confirmed transfer (exchange
        // txn_id present), so this is a real confirmation, not a hedge. Show the
        // txn id when the exchange returns one.
        successMsg: (res) => {
          const txn = res && res.data && (res.data.txn_id || res.data.txnId);
          return "✓ Transfer completed" + (txn ? ` (txn ${txn})` : "");
        },
        onSuccess: () => { clearTransferTxnId(intentKey); f.reset(); refreshDashboardSoon(); },
        // Definitive 4xx = the exchange evaluated and refused this transfer —
        // rotate the key so a corrected retry isn't replay-deduped into a no-op.
        // 5xx/network errors keep the key: that retry MUST dedup.
        onError: (err) => {
          if (err && err.status >= 400 && err.status < 500) clearTransferTxnId(intentKey);
        },
      };
    });
  });
}

// ---------------------------------------------------------------------------
// API Explorer (read-only queries, available to any logged-in user)
// Each query renders a formatted table; raw JSON stays available via a toggle.
// ---------------------------------------------------------------------------

// --- formatting helpers ---
function cell(v) {
  return v === undefined || v === null || v === "" ? "—" : v;
}
function sideClass(side) {
  return String(side || "").toLowerCase() === "buy" ? "pos" : "neg";
}
function fmtTime(ms) {
  if (ms === undefined || ms === null || ms === "") return "—";
  const n = Number(ms);
  if (!isFinite(n)) return esc(String(ms));
  const d = new Date(n > 1e12 ? n : n * 1000); // ms vs seconds
  return d.toLocaleString();
}
function pct(v) {
  const n = Number(v);
  return isFinite(n) ? (n * 100).toFixed(2) + "%" : "—";
}
function emptyMsg(msg) {
  return `<p class="muted center" style="padding:18px">${esc(msg || "No data")}</p>`;
}
// Standard ERROR block for panel bodies: bordered + tinted so a failure reads
// as a failure at a glance (not as data or an empty state), and role="alert"
// so screen readers announce it with the same urgency as the error toasts.
function errorMsg(msg) {
  return `<div class="error-block" role="alert">⚠ ${esc(msg || "Request failed")}</div>`;
}
// Standard LOADING line (subtle pulse via CSS; stilled under reduced motion).
function loadingMsg(label) {
  return `<p class="loading-msg muted">${esc(label || "Loading…")}</p>`;
}
function listOf(data) {
  const r = data && data.result;
  if (r && Array.isArray(r.list)) return r.list;
  if (Array.isArray(r)) return r;
  return [];
}
// Build a table. columns: [{label, get:(row)=>value, cls?:(row)=>className,
// raw?:(row)=>html, priv?:bool}]. `raw` injects pre-built HTML for a cell (used
// for sign-coloured funding %, fill/range gauges). IMPORTANT: a raw producer
// must build its HTML only from numeric/own values — never from unescaped
// exchange strings. `priv: true` marks the column as a private account figure
// (money/size/PnL) so the privacy toggle masks it; leave it off for public
// market columns (prices on Tickers, instrument specs, …). Every cell carries
// data-label so the mobile card layout can label values.
function buildTable(rows, columns) {
  const head = columns.map((c) => `<th>${esc(c.label)}</th>`).join("");
  const body = rows
    .map(
      (r) =>
        "<tr>" +
        columns
          .map((c) => {
            const extra = (c.priv ? " priv" : "") + (c.cls ? " " + c.cls(r) : "");
            const lbl = ` data-label="${esc(c.label)}"`;
            // c.money => currency-convert the value (INR mode) via cvtCell;
            // c.raw => caller-built safe HTML; otherwise escaped raw value.
            const inner = c.raw ? c.raw(r)
              : c.money ? cvtCell(c.get(r), c.digits)
              : esc(cell(c.get(r)));
            return `<td class="mono${extra}"${lbl}>${inner}</td>`;
          })
          .join("") +
        "</tr>"
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// Inline 24h low→high range bar with a marker at the last price. Returns safe
// HTML built only from coerced numbers.
function rangeGaugeHTML(low, high, last) {
  const lo = Number(low), hi = Number(high), lp = Number(last);
  // Marker position is a ratio within [low, high] — currency-invariant. Only the
  // displayed last-price text converts (cvtCell).
  if (!(hi > lo) || !isFinite(lp)) return cvtCell(last);
  const posPct = Math.min(100, Math.max(0, ((lp - lo) / (hi - lo)) * 100));
  return `${cvtCell(last)}<span class="range-gauge" role="img" aria-label="24h range position ${posPct.toFixed(0)}%"><span class="mark" style="left:${posPct.toFixed(1)}%"></span></span>`;
}
// Key/value table for a single object.
function buildKV(obj, fields) {
  const entries = fields
    ? fields.map((f) => [f.label, obj ? obj[f.key] : undefined])
    : Object.entries(obj || {});
  if (!entries.length) return emptyMsg();
  const rows = entries
    .map(([k, v]) => {
      const val = v && typeof v === "object" ? JSON.stringify(v) : v;
      return `<tr><th>${esc(k)}</th><td class="mono">${esc(cell(val))}</td></tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="kv"><tbody>${rows}</tbody></table></div>`;
}
// Generic fallback: array-of-objects → table; object → kv; else raw.
function autoRender(data) {
  const list = listOf(data);
  if (list.length) {
    const keys = Object.keys(list[0]);
    return buildTable(
      list,
      keys.map((k) => ({ label: k, get: (r) => (r[k] && typeof r[k] === "object" ? JSON.stringify(r[k]) : r[k]) }))
    );
  }
  const r = data && data.result;
  if (r && typeof r === "object" && !Array.isArray(r)) return buildKV(r);
  return `<pre class="json-view">${esc(JSON.stringify(data, null, 2))}</pre>`;
}

// --- per-endpoint renderers ---
function renderWallet(data) {
  const acct = listOf(data)[0];
  if (!acct) return autoRender(data);
  // Third tuple element = private account figure (masked by the privacy toggle).
  const rows = [
    ["Account Type", esc(cell(acct.accountType))],
    ["Total Equity", cvtCell(acct.totalEquity, 2), true],
    ["Wallet Balance", cvtCell(acct.totalWalletBalance, 2), true],
    ["Available Balance", cvtCell(acct.totalAvailableBalance, 2), true],
    ["Margin Balance", cvtCell(acct.totalMarginBalance, 2), true],
    ["Unrealised PnL", cvtCell(acct.totalPerpUPL, 2), true],
    ["Initial Margin", cvtCell(acct.totalInitialMargin, 2), true],
    ["Maint. Margin", cvtCell(acct.totalMaintenanceMargin, 2), true],
    ["Display Currency", esc(curUnit())],
  ];
  const summary =
    `<div class="table-wrap"><table class="kv"><tbody>` +
    rows.map(([k, v, priv]) => `<tr><th>${esc(k)}</th><td class="mono${priv ? " priv" : ""}">${v}</td></tr>`).join("") +
    `</tbody></table></div>`;
  const coins = acct.coin || [];
  // Per-coin balances (equity/wallet/available/PnL) are denominated in the
  // COIN's own units (e.g. BTC), so the ×94 INR lens only applies to the settle
  // coin (USDT). For other coins show the native amount unchanged. usdValue is a
  // USD-equivalent, so it converts for every row.
  const coinAmt = (c, v) => (c.coin === settleCoin() ? cvtCell(v, 2) : esc(cell(v)));
  const coinTable = coins.length
    ? buildTable(coins, [
        { label: "Coin", get: (c) => c.coin },
        { label: "Equity", raw: (c) => coinAmt(c, c.equity), priv: true },
        { label: "Wallet Bal", raw: (c) => coinAmt(c, c.walletBalance), priv: true },
        { label: "Available", raw: (c) => coinAmt(c, c.availableToWithdraw ?? c.availableToBorrow), priv: true },
        { label: "Unreal PnL", raw: (c) => coinAmt(c, c.unrealisedPnl), cls: (c) => pnlClass(c.unrealisedPnl), priv: true },
        { label: "Realised PnL", raw: (c) => coinAmt(c, c.cumRealisedPnl), cls: (c) => pnlClass(c.cumRealisedPnl), priv: true },
        { label: `Value (${curUnit()})`, get: (c) => c.usdValue, money: true, digits: 2, priv: true },
      ])
    : "";
  return summary + coinTable;
}

function renderAccountInfo(data) {
  return data && data.result ? buildKV(data.result) : autoRender(data);
}

// Withdrawable amounts are monetary (USDT) → convert in INR mode. Only fields
// whose key names a money amount are converted (defensive: never rescale a
// stray non-monetary number); everything else is shown raw + escaped.
const _MONEY_KEY = /amount|balance|withdraw|available|equity|margin|value|pnl/i;
function renderWithdrawable(data) {
  const r = data && data.result;
  if (!r || typeof r !== "object" || Array.isArray(r)) return autoRender(data);
  const kv = (obj) => {
    const rows = Object.entries(obj).map(([k, v]) => {
      const isNum = v !== "" && v !== null && typeof v !== "object" && isFinite(Number(v));
      const isMoney = isNum && _MONEY_KEY.test(k);
      const html = isMoney ? cvtCell(v, 2) : esc(cell(v));
      // Money amounts are private (masked by the privacy toggle); other fields stay.
      return `<tr><th>${esc(k)}</th><td class="mono${isMoney ? " priv" : ""}">${html}</td></tr>`;
    });
    return `<div class="table-wrap"><table class="kv"><tbody>${rows.join("")}</tbody></table></div>`;
  };
  return Array.isArray(r.list) ? r.list.map(kv).join("") : kv(r);
}

function renderServerTime(data) {
  const r = (data && data.result) || {};
  const sec = r.timeSecond ?? (data && data.time ? Number(data.time) / 1000 : null);
  const dt = sec != null && isFinite(Number(sec)) ? new Date(Number(sec) * 1000) : null;
  return buildKV({
    "timeSecond": r.timeSecond,
    "timeNano": r.timeNano,
    "Parsed (UTC)": dt ? dt.toISOString() : "—",
    "Local time": dt ? dt.toLocaleString() : "—",
  });
}

function renderInstruments(data) {
  const list = listOf(data);
  if (!list.length) return emptyMsg("No instruments");
  return buildTable(list, [
    { label: "Symbol", get: (i) => i.symbol },
    { label: "Status", get: (i) => i.status },
    { label: "Type", get: (i) => i.contractType },
    { label: "Base", get: (i) => i.baseCoin },
    { label: "Quote", get: (i) => i.quoteCoin },
    { label: "Settle", get: (i) => i.settleCoin },
    { label: "Tick Size", get: (i) => i.priceFilter && i.priceFilter.tickSize },
    { label: "Qty Step", get: (i) => i.lotSizeFilter && i.lotSizeFilter.qtyStep },
    { label: "Min Qty", get: (i) => i.lotSizeFilter && i.lotSizeFilter.minOrderQty },
    { label: "Max Qty", get: (i) => i.lotSizeFilter && i.lotSizeFilter.maxOrderQty },
    { label: "Max Lev", get: (i) => i.leverageFilter && i.leverageFilter.maxLeverage },
  ]);
}

// Cap the number of ROWS painted into the DOM for history tables. An "Overall"
// read can return up to 10k rows per mirror; rendering them all in one
// innerHTML janks for seconds (and can OOM a phone tab). Totals and analytics
// are always computed over the FULL list — only the visible rows are capped.
const HISTORY_RENDER_MAX = 500;

function _renderCapNote(total) {
  if (total <= HISTORY_RENDER_MAX) return "";
  return `<p class="muted" style="padding:8px 16px">Showing the ${HISTORY_RENDER_MAX} newest of ${total} records — totals above cover all of them. Narrow the range or filter by symbol to see older rows.</p>`;
}

function renderClosedPnl(data) {
  const list = listOf(data);
  if (!list.length) return emptyMsg("No closed PnL records");
  // The server merges several <=7-day windows (a month by default). `truncated`
  // means a safety cap stopped it short, so this total may be incomplete — say so
  // rather than presenting a partial figure as the full picture.
  const truncated = !!(data && data.result && data.result.truncated);
  const truncNote = truncated
    ? ` · <span class="neg" title="A fetch cap was hit; some older records may be missing.">⚠ partial</span>`
    : "";
  const total = list.reduce((s, r) => s + (Number(r.closedPnl) || 0), 0);
  const table = buildTable(list.slice(0, HISTORY_RENDER_MAX), [
    { label: "Closed At", get: (r) => fmtTime(r.updatedTime ?? r.createdTime) },
    { label: "Symbol", get: (r) => r.symbol },
    { label: "Side", get: (r) => r.side, cls: (r) => sideClass(r.side) },
    { label: "Qty", get: (r) => r.qty ?? r.closedSize, priv: true },
    { label: "Entry", get: (r) => r.avgEntryPrice, money: true, priv: true },
    { label: "Exit", get: (r) => r.avgExitPrice, money: true, priv: true },
    { label: "Closed PnL", get: (r) => r.closedPnl, cls: (r) => pnlClass(r.closedPnl), money: true, digits: 2, priv: true },
    { label: "Leverage", get: (r) => r.leverage, priv: true },
  ]);
  return (
    `<div class="explorer-summary">Total closed PnL: <span class="${pnlClass(total)} priv">${fmtMoney(total)} ${esc(curUnit())}</span> · ${list.length} record(s)${truncNote}</div>` +
    table + _renderCapNote(list.length)
  );
}

function renderExecutions(data) {
  const list = listOf(data);
  if (!list.length) return emptyMsg("No trades");
  return buildTable(list.slice(0, HISTORY_RENDER_MAX), [
    { label: "Time", get: (r) => fmtTime(r.execTime) },
    { label: "Symbol", get: (r) => r.symbol },
    { label: "Side", get: (r) => r.side, cls: (r) => sideClass(r.side) },
    { label: "Type", get: (r) => r.orderType },
    { label: "Exec Qty", get: (r) => r.execQty, priv: true },
    { label: "Exec Price", get: (r) => r.execPrice, money: true, priv: true },
    { label: "Exec Value", get: (r) => r.execValue, money: true, digits: 2, priv: true },
    { label: "Fee", get: (r) => r.execFee, money: true, digits: 4, priv: true },
    { label: "Maker", get: (r) => r.isMaker },
  ]) + _renderCapNote(list.length);
}

function renderTickers(data) {
  const list = listOf(data);
  if (!list.length) return emptyMsg("No tickers");
  return buildTable(list, [
    { label: "Symbol", get: (t) => t.symbol },
    { label: "Last", get: (t) => t.lastPrice, money: true },
    { label: "Mark", get: (t) => t.markPrice, money: true },
    { label: "Index", get: (t) => t.indexPrice, money: true },
    { label: "24h %", get: (t) => pct(t.price24hPcnt), cls: (t) => pnlClass(t.price24hPcnt) },
    { label: "24h High", get: (t) => t.highPrice24h, money: true },
    { label: "24h Low", get: (t) => t.lowPrice24h, money: true },
    { label: "Bid", get: (t) => t.bid1Price, money: true },
    { label: "Ask", get: (t) => t.ask1Price, money: true },
    { label: "Funding", raw: (t) => fmtFundingHTML(t.fundingRate) },
    { label: "Open Int", get: (t) => t.openInterest },
  ]);
}

function renderOrderBook(data) {
  const r = (data && data.result) || {};
  const bids = r.b || [];
  const asks = r.a || [];
  if (!bids.length && !asks.length) return autoRender(data);
  // Fall back to the generic renderer if the rows aren't [price, size] pairs.
  if (!bids.every(Array.isArray) || !asks.every(Array.isArray)) return autoRender(data);
  return (
    `<div class="explorer-summary">${esc(cell(r.s))} — order book (${esc(curUnit())})</div>` +
    `<div class="book-widget" style="padding:8px 0 12px">${renderBookLadder(data, { depth: 25, convert: true })}</div>`
  );
}

function renderPositionsTable(data) {
  const list = listOf(data).filter((p) => Number(p.size) !== 0);
  if (!list.length) return emptyMsg("No open positions");
  return buildTable(list, [
    { label: "Symbol", get: (p) => p.symbol },
    { label: "Side", get: (p) => p.side, cls: (p) => sideClass(p.side) },
    { label: "Size", get: (p) => p.size, priv: true },
    { label: "Entry", get: (p) => p.avgPrice, money: true, priv: true },
    { label: "Mark", get: (p) => p.markPrice, money: true },
    { label: "Lev", get: (p) => (p.leverage ? p.leverage + "x" : "—"), priv: true },
    { label: "Value", get: (p) => p.positionValue, money: true, priv: true },
    { label: "Unreal PnL", get: (p) => p.unrealisedPnl, cls: (p) => pnlClass(p.unrealisedPnl), money: true, digits: 2, priv: true },
  ]);
}

function renderOrdersTable(data) {
  const list = listOf(data);
  if (!list.length) return emptyMsg("No open orders");
  return buildTable(list, [
    { label: "Symbol", get: (o) => o.symbol },
    { label: "Side", get: (o) => o.side, cls: (o) => sideClass(o.side) },
    { label: "Type", get: (o) => o.orderType },
    { label: "Qty", get: (o) => o.qty, priv: true },
    { label: "Price", get: (o) => o.price, money: true, priv: true },
    { label: "Trigger", get: (o) => o.triggerPrice, money: true, priv: true },
    { label: "Status", get: (o) => o.orderStatus },
  ]);
}

const EXPLORER_QUERIES = [
  { label: "Wallet Balance", path: "/api/balance", render: renderWallet },
  { label: "Withdrawable", path: "/api/withdrawable", render: renderWithdrawable },
  { label: "Account Info", path: "/api/account-info", render: renderAccountInfo },
  { label: "Server Time", path: "/api/server-time", render: renderServerTime },
  { label: "Positions", path: "/api/positions", render: renderPositionsTable },
  { label: "Open Orders", path: "/api/orders", render: renderOrdersTable },
  { label: "Instruments", path: "/api/instruments", sym: true, render: renderInstruments },
  { label: "Tickers", path: "/api/tickers", sym: true, render: renderTickers },
  { label: "Order Book", path: "/api/orderbook", sym: true, symRequired: true, render: renderOrderBook },
  { label: "Closed PnL", path: "/api/closed-pnl", sym: true, render: renderClosedPnl },
  { label: "Trades History", path: "/api/executions", sym: true, render: renderExecutions },
];

// Render a formatted explorer result + its collapsible raw JSON. Shared by the
// query click handler and the currency-toggle re-render so they never diverge.
function renderExplorerOutput(out, render, data) {
  const raw = `<details class="raw-json"><summary>Raw JSON</summary><pre class="json-view">${esc(
    JSON.stringify(data, null, 2)
  )}</pre></details>`;
  out.innerHTML = (render || autoRender)(data) + raw;
}

function wireExplorer() {
  const container = $("#explorer-buttons");
  const out = $("#explorer-result");
  if (!container) return;

  EXPLORER_QUERIES.forEach((q) => {
    const btn = document.createElement("button");
    btn.className = "btn-ghost sm";
    btn.textContent = q.label;
    btn.addEventListener("click", async () => {
      const symbol = $("#explorer-symbol").value.trim().toUpperCase();
      if (q.symRequired && !symbol) {
        out.innerHTML = errorMsg(`"${q.label}" requires a symbol.`);
        return;
      }
      let url = q.path;
      if (q.sym && symbol) url += `?symbol=${encodeURIComponent(symbol)}`;
      out.innerHTML = loadingMsg(`Loading ${q.label}…`);
      try {
        const data = await api(url);
        // Cache so a currency toggle can re-render this result in the new unit.
        state.lastExplorer = { render: q.render || autoRender, data };
        renderExplorerOutput(out, state.lastExplorer.render, data);
      } catch (err) {
        state.lastExplorer = null;
        out.innerHTML = errorMsg(err.message);
      }
    });
    container.appendChild(btn);
  });
}

// ---------------------------------------------------------------------------
// Tabs + Markets + History (read-only, available to both roles)
// ---------------------------------------------------------------------------
function wireTabs() {
  const tabs = document.getElementById("tabs");
  if (!tabs) return;
  const panes = document.querySelectorAll("main .pane");
  const show = (name, focus = false) => {
    // Keep the ARIA tab state and roving tabindex in lockstep with `active`, so a
    // screen reader announces the selected view and only the active tab is a Tab stop.
    tabs.querySelectorAll(".tab").forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    panes.forEach((p) => { p.hidden = p.dataset.pane !== name; });
    if (name !== "markets") clearInterval(_marketsTimer); // stop polling when away
    if (name === "markets") onMarketsActive();
    if (name === "history") onHistoryActive();
    if (name === "account") onAccountActive();
    // The order-book widget only polls while the dashboard is visible.
    if (name === "dashboard") { if (state.activeSymbol) startBookPolling(); }
    else stopBookPolling();
    // Live charts poll only while the dashboard is visible too.
    if (name === "dashboard") startChartPolling();
    else stopChartPolling();
  };
  tabs.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  // Arrow/Home/End roving expected of a tablist. Viewer-hidden tabs are removed
  // from the DOM (loadMe), so the live NodeList is already the reachable set.
  tabs.addEventListener("keydown", (e) => {
    // Up/Down mirror Left/Right: the nav renders as a VERTICAL rail on desktop
    // (aria-orientation=vertical) and horizontal on mobile — support both axes.
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    const list = Array.from(tabs.querySelectorAll(".tab"));
    if (!list.length) return;
    const cur = list.indexOf(document.activeElement);
    let idx;
    if (e.key === "Home") idx = 0;
    else if (e.key === "End") idx = list.length - 1;
    else {
      const fwd = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      idx = ((cur < 0 ? 0 : cur) + fwd + list.length) % list.length;
    }
    e.preventDefault();
    show(list[idx].dataset.tab, true);
  });
}

let _marketsData = null;
let _marketsTimer = null;
async function fetchMarkets() {
  const body = document.getElementById("markets-body");
  try {
    _marketsData = await api("/api/tickers");
    renderMarkets();
  } catch (e) {
    if (body) body.innerHTML = errorMsg(e.message);
  }
}
function renderMarkets() {
  const body = document.getElementById("markets-body");
  if (!body) return;
  const filter = (document.getElementById("markets-filter").value || "").trim().toUpperCase();
  let list = listOf(_marketsData);
  if (filter) list = list.filter((t) => String(t.symbol || "").toUpperCase().includes(filter));
  if (!list.length) { body.innerHTML = emptyMsg("No matching symbols"); return; }
  list = list.slice().sort((a, b) => (Number(b.turnover24h) || 0) - (Number(a.turnover24h) || 0));
  body.innerHTML = buildTable(list.slice(0, 200), [
    { label: "Symbol", get: (t) => t.symbol },
    { label: "Last", raw: (t) => rangeGaugeHTML(t.lowPrice24h, t.highPrice24h, t.lastPrice) },
    { label: "Mark", get: (t) => t.markPrice, money: true },
    { label: "24h %", get: (t) => pct(t.price24hPcnt), cls: (t) => pnlClass(t.price24hPcnt) },
    { label: "24h High", get: (t) => t.highPrice24h, money: true },
    { label: "24h Low", get: (t) => t.lowPrice24h, money: true },
    { label: "Funding", raw: (t) => fmtFundingHTML(t.fundingRate) },
    { label: "Open Int", get: (t) => t.openInterest },
    { label: "Turnover 24h", get: (t) => t.turnover24h, money: true, digits: 0 },
  ]) + (list.length > 200 ? `<p class="muted" style="padding:8px 16px">Showing top 200 by turnover. Filter to narrow.</p>` : "");
}
function onMarketsActive() {
  if (!_marketsData) fetchMarkets();
  clearInterval(_marketsTimer);
  // Capture the id locally so the self-clearing callback cancels ITS OWN interval,
  // not whatever _marketsTimer happens to point at after a re-entry.
  const id = setInterval(() => {
    const pane = document.querySelector('[data-pane="markets"]');
    if (!pane || pane.hidden) { clearInterval(id); return; }
    // Skip (don't cancel) the tick while the BROWSER tab is backgrounded — the
    // full-tickers poll is pure waste with nothing on screen; it resumes on the
    // next tick once the tab is visible again.
    if (!document.hidden) fetchMarkets();
  }, 15000);
  _marketsTimer = id;
}

let _historyLoaded = false;
function toDateInputValue(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function historyQuery() {
  // Presets ride the server's `days` param (1 = last 24h, 7 = 168h, 30 = 720h);
  // Custom sends explicit epoch-ms bounds — From at local midnight, To at local
  // end-of-day, so a single-day pick covers that whole day. Returns null when
  // the custom range is missing/inverted (caller shows the error).
  const filter = (document.getElementById("history-filter").value || "").trim().toUpperCase();
  const rangeEl = document.getElementById("history-range");
  const params = new URLSearchParams();
  if (rangeEl && rangeEl.value === "all") {
    // Overall = everything the mirror holds (epoch 0 → now); the server's
    // 10k row cap + `truncated` flag still bound the response.
    params.set("startTime", "0");
    params.set("endTime", String(Date.now()));
  } else if (rangeEl && rangeEl.value === "custom") {
    const fromEl = document.getElementById("history-from");
    const toEl = document.getElementById("history-to");
    const from = fromEl && fromEl.value ? new Date(fromEl.value + "T00:00:00") : null;
    const to = toEl && toEl.value ? new Date(toEl.value + "T23:59:59.999") : null;
    if (!from || !to || !isFinite(from.getTime()) || !isFinite(to.getTime()) ||
        from.getTime() > to.getTime()) {
      return null;
    }
    params.set("startTime", String(from.getTime()));
    params.set("endTime", String(to.getTime()));
  } else {
    params.set("days", rangeEl ? rangeEl.value : "30");
  }
  if (filter) params.set("symbol", filter);
  return "?" + params.toString();
}
function fmtSynced(ms, serverNowMs) {
  // History is served from the server's MongoDB mirror (synced ~every minute).
  // Flag a stamp that has stopped advancing — stale data on a money view must
  // never look current. Staleness is measured against the SERVER's clock
  // (result.nowMs) so a skewed browser clock can't fake or mask it.
  if (!isFinite(ms) || ms <= 0) return "syncing…";
  const now = isFinite(serverNowMs) && serverNowMs > 0 ? serverNowMs : Date.now();
  const stale = now - ms > 15 * 60 * 1000;
  return fmtTime(ms) + (stale ? " ⚠ stale" : "");
}
// Monotonic token: a newer refresh (range/filter change, Refresh click) makes
// every still-in-flight older fetch drop its results, so two overlapping loads
// can never interleave rows from different windows on screen.
let _historySeq = 0;
// Last fetched payloads — the currency toggle re-renders from here instead of
// refetching (an "Overall" read can be ~10k rows per collection).
let _historyCache = null;
let _historyLoadedAt = 0; // when the on-screen history window was last fetched

async function fetchHistory() {
  const closedEl = document.getElementById("history-closed");
  const execEl = document.getElementById("history-exec");
  const sumEl = document.getElementById("history-summary");
  // Both fetches share ONE window (a preset or the custom From/To range) so
  // the fee tally lines up with the PnL period; the symbol filter narrows both.
  const histQuery = historyQuery();
  if (!histQuery) {
    sumEl.hidden = false;
    sumEl.textContent = "Pick a valid From/To range (From must not be after To).";
    return;
  }
  const seq = ++_historySeq;
  _historyLoadedAt = Date.now();
  closedEl.innerHTML = loadingMsg();
  execEl.innerHTML = loadingMsg();
  // Parallel: the two reads are independent Mongo queries, so waiting for one
  // before starting the other only added latency.
  const [closed, exec] = await Promise.allSettled([
    api("/api/closed-pnl" + histQuery),
    api("/api/executions" + histQuery),
  ]);
  if (seq !== _historySeq) return; // superseded — a newer load owns the screen
  _historyCache = {
    closed: closed.status === "fulfilled" ? closed.value : null,
    closedErr: closed.status === "rejected" ? closed.reason : null,
    exec: exec.status === "fulfilled" ? exec.value : null,
    execErr: exec.status === "rejected" ? exec.reason : null,
  };
  renderHistoryResults(_historyCache);
}

// Pure render of already-fetched history payloads (fetchHistory + the currency
// toggle both come through here so the two views can never diverge).
function renderHistoryResults(res) {
  const closedEl = document.getElementById("history-closed");
  const execEl = document.getElementById("history-exec");
  const sumEl = document.getElementById("history-summary");
  const analyticsEl = document.getElementById("history-analytics");

  let closedList = [];
  let closedSyncedMs = NaN;
  let serverNowMs = NaN;
  let fees = null, maker = null, taker = null;

  if (res.exec) {
    listOf(res.exec).forEach((r) => {
      const f = Number(r.execFee);
      if (isFinite(f)) fees = (fees || 0) + f;
      if (r.isMaker === true || r.isMaker === "true") maker = (maker || 0) + 1;
      else if (r.isMaker === false || r.isMaker === "false") taker = (taker || 0) + 1;
    });
    if (fees == null) fees = 0;
    maker = maker || 0;
    taker = taker || 0;
  }

  if (res.closed) {
    closedList = listOf(res.closed);
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const todayMs = startOfDay.getTime();
    let total = 0, today = 0, wins = 0;
    closedList.forEach((r) => {
      const v = Number(r.closedPnl) || 0;
      total += v;
      if (v > 0) wins++;
      const t = Number(r.updatedTime ?? r.createdTime);
      if (isFinite(t) && t >= todayMs) today += v;
    });
    closedSyncedMs = Number(res.closed.result && res.closed.result.lastSyncedMs);
    serverNowMs = Number(res.closed.result && res.closed.result.nowMs);
    // The tab renders BOTH mirrors (closed-PnL rows + trade fee analytics), so
    // show the OLDER of the two sync stamps — the label must never claim more
    // freshness than the stalest data on screen.
    let syncedLabel = fmtSynced(closedSyncedMs, serverNowMs);
    if (res.exec) {
      const execSyncedMs = Number(res.exec.result && res.exec.result.lastSyncedMs);
      const execNowMs = Number(res.exec.result && res.exec.result.nowMs);
      if (isFinite(execNowMs) && execNowMs > 0) serverNowMs = execNowMs;
      const stamps = [closedSyncedMs, execSyncedMs].filter((v) => isFinite(v) && v > 0);
      syncedLabel = stamps.length === 2 ? fmtSynced(Math.min(...stamps), serverNowMs) : "syncing…";
    }
    sumEl.hidden = false;
    sumEl.innerHTML =
      `Realized today: <span class="${pnlClass(today)} priv">${fmtMoneySigned(today)} ${esc(curUnit())}</span> · ` +
      `Total (recent ${closedList.length}): <span class="${pnlClass(total)} priv">${fmtMoneySigned(total)}</span> · ` +
      `Win rate: <span class="priv">${closedList.length ? Math.round((wins / closedList.length) * 100) : 0}%</span> · ` +
      `Last synced: <span id="history-synced" class="muted">${syncedLabel}</span> · times local`;
    renderHistoryAnalytics(closedList, fees, maker, taker);
    closedEl.innerHTML = renderClosedPnl(res.closed);
  } else {
    sumEl.hidden = true;
    if (analyticsEl) { analyticsEl.hidden = true; analyticsEl.innerHTML = ""; }
    closedEl.innerHTML = errorMsg(res.closedErr && res.closedErr.message);
  }

  if (res.exec) {
    execEl.innerHTML = renderExecutions(res.exec);
  } else {
    execEl.innerHTML = errorMsg(res.execErr && res.execErr.message);
  }
}
function onHistoryActive() {
  if (!_historyLoaded) { _historyLoaded = true; fetchHistory(); return; }
  // Re-entering the tab later: the mirror syncs every minute, so a view older
  // than that is quietly stale — refresh it (a cheap Mongo read), instead of
  // presenting hours-old rows under a frozen "Last synced" stamp.
  if (Date.now() - _historyLoadedAt > 60_000) fetchHistory();
}

function wireMarketsHistory() {
  const mf = document.getElementById("markets-filter");
  if (mf) mf.addEventListener("input", () => { if (_marketsData) renderMarkets(); });
  const mr = document.getElementById("markets-refresh");
  if (mr) mr.addEventListener("click", fetchMarkets);
  const hr = document.getElementById("history-refresh");
  if (hr) hr.addEventListener("click", fetchHistory);
  const hf = document.getElementById("history-filter");
  if (hf) hf.addEventListener("keydown", (e) => { if (e.key === "Enter") fetchHistory(); });
  const hrange = document.getElementById("history-range");
  const hfrom = document.getElementById("history-from");
  const hto = document.getElementById("history-to");
  if (hrange) hrange.addEventListener("change", () => {
    const custom = hrange.value === "custom";
    if (hfrom && hto) {
      hfrom.hidden = hto.hidden = !custom;
      if (custom && !hfrom.value && !hto.value) {
        // Prefill the last 30 days so the pickers open on a valid range.
        const now = new Date();
        hto.value = toDateInputValue(now);
        hfrom.value = toDateInputValue(new Date(now.getTime() - 30 * 86400000));
      }
    }
    fetchHistory();
  });
  [hfrom, hto].forEach((el) => { if (el) el.addEventListener("change", fetchHistory); });
  const ar = document.getElementById("account-refresh");
  if (ar) ar.addEventListener("click", loadAccountOverview);
}

// ---------------------------------------------------------------------------
// Live WebSocket feed (with auto-reconnect)
// ---------------------------------------------------------------------------
// Adaptive staleness threshold derived from observed inter-frame gaps, so it
// adjusts to whatever POLL_INTERVAL the server actually uses (default ~5s).
function staleThreshold() {
  const g = state.frameGaps;
  if (g && g.length) {
    const s = g.slice().sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)];
    return Math.max(8, med * 2.5);
  }
  return 14; // no samples yet; generous floor (~2.5× a 5s poll)
}

// Render the connection pill from the AGE of the last frame — not just from
// socket open/close. A silently half-open socket (onmessage simply stops, no
// close event) would otherwise keep showing "live" over frozen PnL; here the
// age keeps climbing until it crosses the threshold and flips to "stale".
function renderConn() {
  const el = $("#conn-status");
  if (!el) return;
  if (state.connState === "off") {
    el.className = "conn conn-off";
    el.textContent = "reconnecting…";
    document.body.classList.remove("stale-data");
    return;
  }
  if (state.lastFrameAt == null) {
    // Socket may be open but no frame has landed yet — keep label and colour
    // consistent ("connecting…", neutral) until the first frame arrives.
    el.className = "conn conn-off";
    el.textContent = "connecting…";
    document.body.classList.remove("stale-data");
    return;
  }
  const age = (Date.now() - state.lastFrameAt) / 1000;
  const stale = age > staleThreshold() || !!state.feedError;
  if (stale) {
    el.className = "conn conn-stale";
    el.textContent = state.feedError ? "stale · feed error" : `stale · ${fmtAge(age)} ago`;
    document.body.classList.add("stale-data");
  } else if (state.connDegraded) {
    el.className = "conn conn-stale";
    el.textContent = `degraded · ${fmtAge(age)} ago`;
    document.body.classList.remove("stale-data");
  } else {
    el.className = "conn conn-on";
    el.textContent = `live · ${fmtAge(age)} ago`;
    document.body.classList.remove("stale-data");
  }
}

let _connTimer = null;
function startConnWatchdog() {
  if (_connTimer) return;
  _connTimer = setInterval(renderConn, 1000);
}

// Record the arrival of a frame and the gap since the previous one.
function recordFrame() {
  const now = Date.now();
  if (state.lastFrameAt != null) {
    const gap = (now - state.lastFrameAt) / 1000;
    if (gap > 0 && gap < 600) {
      state.frameGaps.push(gap);
      if (state.frameGaps.length > 8) state.frameGaps.shift();
    }
  }
  state.lastFrameAt = now;
}

function connectWS() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
  let opened = false;

  ws.onopen = () => {
    opened = true;
    state.connState = "live";
    renderConn();
  };
  ws.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (e) {
      return;
    }
    if (msg.type === "dashboard") {
      renderDashboard(msg);
      recordFrame();
      state.connState = "live";
      state.feedError = null;
      // If any upstream call failed this cycle, the tables may be incomplete —
      // flag it (degraded) rather than presenting it as fully "live".
      state.connDegraded = msg.errors && Object.keys(msg.errors).length > 0;
      renderConn();
    } else if (msg.type === "error") {
      // Whole refresh failed: keep last rows but flag clearly as stale.
      recordFrame();
      state.connState = "live";
      state.feedError = msg.error || "feed error";
      renderConn();
      const label = $("#positions-updated");
      label.textContent = "⚠ " + msg.error;
      label.classList.add("neg");
    }
  };
  ws.onclose = (evt) => {
    // 1008 = server explicitly revoked this (accepted) session — e.g. a newer
    // login evicted us under the single-session rule. Redirect to login.
    if (evt && evt.code === 1008) {
      window.location.href = "/login";
      return;
    }
    state.connState = "off";
    // Forget the last-frame time so the first frame after a reconnect starts a
    // fresh baseline — an outage gap must not be recorded as a normal poll gap
    // (which would inflate the adaptive stale threshold).
    state.lastFrameAt = null;
    // Reset the dashboard generation floor: a redeploy restarts the server-side
    // gen counter at 0, so a stale in-memory floor would otherwise drop every
    // frame from the new server and freeze the dashboard until a page reload.
    _lastDashSeq = 0;
    renderConn();
    if (!opened) {
      // The socket never upgraded. Browsers report an auth/handshake rejection
      // as 1006 (indistinguishable from a network drop), so don't blindly
      // reconnect-loop: probe /api/me — api() redirects to /login on 401, and
      // otherwise we reconnect. finally() reconnects on success/network errors;
      // on a 401 the redirect has already navigated away.
      api("/api/me").finally(() => setTimeout(connectWS, 3000));
      return;
    }
    setTimeout(connectWS, 3000);
  };
  ws.onerror = () => ws.close();
}

// ---------------------------------------------------------------------------
// Order ticket: %-sizing, active symbol, instrument specs & order-book widget
// ---------------------------------------------------------------------------

// Debounced one-shot dashboard refresh after a write, so a closed/cancelled row
// disappears (and a new order/position appears) without waiting for the next WS
// tick. Read-only GET of the same snapshot the socket pushes.
let _refreshTimer = null;
function refreshDashboardSoon() {
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(async () => {
    // renderDashboard drops this snapshot if a newer-`gen` frame already rendered
    // (and renders it if it is the fresher one), so no ordering guard is needed here.
    try { renderDashboard(await api("/api/dashboard")); } catch (e) { /* WS will catch up */ }
  }, 150);
}

function updateSizingAvail() {
  const el = document.getElementById("sizing-avail");
  if (!el) return;
  el.textContent = state.available != null
    ? `avail ${fmtNum(state.available)} ${settleCoin()}`
    : "avail —";
}

// Copy a symbol into the order ticket and load its market data — the ⇄ button
// on a position row (row-to-action wiring).
function loadSymbolIntoTicket(sym) {
  const symbol = (sym || "").trim().toUpperCase();
  const form = document.getElementById("order-form");
  if (!form || !symbol) return;
  form.symbol.value = symbol;
  form.symbol.dispatchEvent(new Event("input", { bubbles: true })); // price+spec+book+preview
  setActiveSymbol(symbol);
  try { form.qty.focus({ preventScroll: true }); } catch (e) {}
  form.scrollIntoView({ block: "nearest" });
  toast(`Loaded ${symbol} into the order ticket`, "info", 2500);
}

// Load a (just-cancelled) order's parameters into the ticket for amend-style
// editing. Display/prefill only — the ticket's normal validate/confirm/submit
// path is unchanged and nothing is sent until the user submits.
function prefillTicketFromOrder(o) {
  const form = document.getElementById("order-form");
  if (!form) return;
  const hasPrice = o.price && Number(o.price) > 0;
  form.symbol.value = String(o.symbol || "").toUpperCase();
  form.side.value = String(o.side) === "Sell" ? "Sell" : "Buy";
  form.side.dispatchEvent(new Event("change", { bubbles: true }));
  form.orderType.value = hasPrice ? "Limit" : "Market";
  form.orderType.dispatchEvent(new Event("change", { bubbles: true }));
  if (form.sizeMode.value !== "qty") {
    form.sizeMode.value = "qty"; // amend edits an explicit qty, never margin-derived
    form.sizeMode.dispatchEvent(new Event("change", { bubbles: true }));
  }
  form.qty.value = o.qty != null ? String(o.qty) : "";
  form.price.value = hasPrice ? String(o.price) : "";
  form.symbol.dispatchEvent(new Event("input", { bubbles: true })); // spec+leverage+book+preview
  try { (hasPrice ? form.price : form.qty).focus({ preventScroll: true }); } catch (e) {}
  form.scrollIntoView({ block: "nearest" });
}

// --- instrument specs (tick/lot/leverage filters) ---
async function fetchInstrumentSpec(symbol) {
  const sym = (symbol || "").trim().toUpperCase();
  if (!sym) { renderSpecStrip(null); return; }
  if (state.specs[sym]) { renderSpecStrip(state.specs[sym]); return; }
  try {
    const data = await api(`/api/instruments?symbol=${encodeURIComponent(sym)}`);
    const i = ((data.result && data.result.list) || [])[0];
    if (!i) { renderSpecStrip(null); return; }
    state.specs[sym] = {
      symbol: sym,
      tickSize: i.priceFilter && i.priceFilter.tickSize,
      qtyStep: i.lotSizeFilter && i.lotSizeFilter.qtyStep,
      minOrderQty: i.lotSizeFilter && i.lotSizeFilter.minOrderQty,
      maxOrderQty: i.lotSizeFilter && i.lotSizeFilter.maxOrderQty,
      maxLeverage: i.leverageFilter && i.leverageFilter.maxLeverage,
    };
    renderSpecStrip(state.specs[sym]);
    // Re-run order-form sizing now the lot step is known, so a Margin-derived qty
    // snaps to the step as soon as the spec arrives (the first derive may have run
    // with an unsnapped value while this request was in flight).
    const oform = document.getElementById("order-form");
    if (oform && oform.symbol && oform.symbol.value.trim().toUpperCase() === sym) {
      oform.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } catch (e) {
    renderSpecStrip(null); // never block trading on a spec-fetch failure
  }
}

function renderSpecStrip(spec) {
  const el = document.getElementById("order-spec");
  if (!el) return;
  if (!spec) { el.hidden = true; el.innerHTML = ""; return; }
  // Display only — show the instrument's filters as a reference strip. We do NOT
  // set min/step on the inputs: they are type=text (so those attrs are inert),
  // and the authoritative check is the non-blocking specWarnings shown in the
  // confirm modal (the server stays authoritative on acceptance).
  const parts = [];
  if (spec.tickSize != null) parts.push(`tick <b>${esc(spec.tickSize)}</b>`);
  if (spec.qtyStep != null) parts.push(`step <b>${esc(spec.qtyStep)}</b>`);
  if (spec.minOrderQty != null) parts.push(`min <b>${esc(spec.minOrderQty)}</b>`);
  if (spec.maxOrderQty != null) parts.push(`max <b>${esc(spec.maxOrderQty)}</b>`);
  if (spec.maxLeverage != null) parts.push(`maxLev <b>${esc(spec.maxLeverage)}x</b>`);
  el.innerHTML = parts.join("");
  el.hidden = parts.length === 0;
}

// --- active symbol + live order-book widget ---
function setActiveSymbol(sym) {
  const symbol = (sym || "").trim().toUpperCase();
  if (!symbol) return;
  if (symbol !== state.activeSymbol) {
    state.activeSymbol = symbol;
    const lbl = document.getElementById("book-symbol");
    if (lbl) lbl.textContent = symbol;
    loadBook();
  }
  startBookPolling();
}

let _bookTimer = null;
function startBookPolling() {
  stopBookPolling();
  _bookTimer = setInterval(() => {
    const pane = document.querySelector('[data-pane="dashboard"]');
    if (!state.activeSymbol || !pane || pane.hidden) { stopBookPolling(); return; }
    if (document.hidden) return; // backgrounded browser tab: skip, don't cancel
    const bookSec = document.querySelector('[data-wpanel="book"]');
    if (bookSec && bookSec.classList.contains("collapsed")) return; // panel folded away
    loadBook();
  }, 4000);
}
function stopBookPolling() { if (_bookTimer) { clearInterval(_bookTimer); _bookTimer = null; } }

async function loadBook() {
  const el = document.getElementById("book-widget");
  if (!el || !state.activeSymbol) return;
  try {
    const data = await api(`/api/orderbook?symbol=${encodeURIComponent(state.activeSymbol)}`);
    el.innerHTML = renderBookLadder(data, { clickable: true, depth: 8 });
  } catch (e) {
    el.innerHTML = `<p class="muted book-empty">Order book unavailable: ${esc(e.message)}</p>`;
  }
}

// Shared depth-ladder renderer (rail widget + API explorer): cumulative-size
// shading + a spread/mid row. Bars are sized from coerced numbers only.
function renderBookLadder(data, opts = {}) {
  const depth = opts.depth || 12;
  const clickable = opts.clickable ? " clickable" : "";
  const r = (data && data.result) || {};
  const bids = (r.b || []).filter(Array.isArray).slice(0, depth);
  const asks = (r.a || []).filter(Array.isArray).slice(0, depth);
  if (!bids.length && !asks.length) return `<p class="muted book-empty">No depth.</p>`;
  const sz = (row) => Number(row[1]) || 0;
  const maxSz = Math.max(1, ...bids.map(sz), ...asks.map(sz));
  // data-px stays the RAW (USDT) price so click-to-fill always feeds the USDT
  // price input correctly; only the displayed price converts (explorer view).
  const pxDisp = (px) => (opts.convert ? cvtCell(px) : esc(px));
  const money = (v) => (opts.convert ? fmtMoney(v, 4) : fmtNum(v, 4));
  const rowHTML = (side, px, size) => {
    const w = (Number(size) || 0) / maxSz * 100;
    // When clickable, make each level keyboard-operable (role/tabindex + label)
    // so the price can be picked without a mouse. px is upstream data — escape it.
    const kb = opts.clickable ? ` role="button" tabindex="0" title="Click to fill the limit price" aria-label="Use price ${esc(px)}"` : "";
    return `<div class="book-row ${side}${clickable}" data-px="${esc(px)}"${kb}>` +
      `<span class="depth" style="width:${w.toFixed(1)}%"></span>` +
      `<span class="px">${pxDisp(px)}</span><span class="sz">${esc(size)}</span></div>`;
  };
  const asksHtml = asks.slice().reverse().map((a) => rowHTML("ask", a[0], a[1])).join("");
  const bidsHtml = bids.map((b) => rowHTML("bid", b[0], b[1])).join("");
  const bestBid = bids.length ? Number(bids[0][0]) : null;
  const bestAsk = asks.length ? Number(asks[0][0]) : null;
  let spread = "";
  if (bestBid && bestAsk && bestAsk >= bestBid) {
    const mid = (bestBid + bestAsk) / 2;
    const bps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10000 : 0; // ratio: no convert
    spread = `<div class="book-spread"><span class="mid">${money(mid)}</span>` +
      `<span class="sp">spread ${money(bestAsk - bestBid)} · ${bps.toFixed(1)} bps</span></div>`;
  }
  return asksHtml + spread + bidsHtml;
}

// Pre-fill the limit price from a book level (switching to Limit if needed).
// Shared by pointer + keyboard so the two paths can never diverge.
function fillPriceFromBookRow(br) {
  const form = document.getElementById("order-form");
  if (!form) return;
  if (form.orderType.value !== "Limit") {
    form.orderType.value = "Limit";
    form.orderType.dispatchEvent(new Event("change", { bubbles: true }));
  }
  form.price.value = br.getAttribute("data-px");
  form.price.dispatchEvent(new Event("input", { bubbles: true }));
}
document.addEventListener("click", (e) => {
  const br = e.target.closest(".book-row.clickable[data-px]");
  if (br) fillPriceFromBookRow(br);
});
// Keyboard parity for clickable book rows AND clickable chart cards (both are
// non-<button> elements made operable with role="button" tabindex="0").
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
  if (!e.target || !e.target.closest) return;
  const br = e.target.closest(".book-row.clickable[data-px]");
  if (br && e.target === br) { e.preventDefault(); fillPriceFromBookRow(br); return; }
  const card = e.target.closest(".cc-card.clickable[data-trade]");
  if (card && e.target === card) { e.preventDefault(); loadSymbolIntoTicket(card.getAttribute("data-trade")); }
});

// ---------------------------------------------------------------------------
// History analytics (CSP-safe inline SVG; built from data already fetched)
// ---------------------------------------------------------------------------
function svgAreaChart(values, opts = {}) {
  const w = opts.w || 320, h = opts.h || 90, pad = 6;
  if (!values || values.length < 2) return `<p class="muted" style="font-size:12px">Not enough data to chart.</p>`;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const dx = (w - pad * 2) / (values.length - 1);
  const x = (i) => pad + i * dx;
  const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${pts.join(" L")}`;
  const area = `M${x(0).toFixed(1)},${(h - pad).toFixed(1)} L${pts.join(" L")} L${x(values.length - 1).toFixed(1)},${(h - pad).toFixed(1)} Z`;
  const end = values[values.length - 1];
  // Colours via `style` (not presentation attributes) so CSS var() resolves.
  const col = end >= (values[0] || 0) ? "var(--pos)" : "var(--neg)";
  const zeroY = (min <= 0 && max >= 0) ? y(0).toFixed(1) : null;
  const zeroLine = zeroY ? `<line x1="${pad}" y1="${zeroY}" x2="${w - pad}" y2="${zeroY}" style="stroke:var(--border)" stroke-dasharray="3 3"/>` : "";
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Cumulative PnL curve">` +
    `<path d="${area}" style="fill:${col};fill-opacity:0.12"/>` + zeroLine +
    `<path d="${line}" style="fill:none;stroke:${col};stroke-width:1.5"/>` +
    `<circle cx="${x(values.length - 1).toFixed(1)}" cy="${y(end).toFixed(1)}" r="2.6" style="fill:${col}"/></svg>`;
}

// Compact human duration for the journal's holding-time stat.
function fmtDuration(ms) {
  if (!isFinite(ms) || ms <= 0) return "—";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function renderHistoryAnalytics(closedList, fees, makerCount, takerCount) {
  const el = document.getElementById("history-analytics");
  if (!el) return;
  const list = (closedList || []).slice().sort(
    (a, b) => Number(a.updatedTime ?? a.createdTime) - Number(b.updatedTime ?? b.createdTime)
  );
  if (!list.length) { el.hidden = true; el.innerHTML = ""; return; }
  let cum = 0;
  let curve = list.map((r) => (cum += Number(r.closedPnl) || 0));
  // Max drawdown over the FULL cumulative series (before any downsampling):
  // deepest fall from a running equity peak, baseline 0.
  let peak = 0, maxDD = 0;
  curve.forEach((v) => {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  });
  // Downsample very long curves: a 10k-point SVG path janks layout for zero
  // visual gain in a ~320px-wide chart. Cumulative values are computed over
  // the FULL list first, so sampling changes resolution, never the shape/end.
  if (curve.length > 800) {
    const stride = Math.ceil(curve.length / 600);
    const lastIdx = curve.length - 1;
    curve = curve.filter((_, i) => i % stride === 0 || i === lastIdx);
  }
  const wins = list.filter((r) => (Number(r.closedPnl) || 0) > 0).length;
  const losses = list.length - wins;
  const winPct = list.length ? (wins / list.length) * 100 : 0;
  const total = curve[curve.length - 1] || 0;

  // Profit/loss BOOKED: split realised PnL by sign. grossLoss accumulates the
  // negative records (so it is ≤ 0). "Positive PnL %" is the share of profit in
  // the total gross flow (profit ÷ (profit + |loss|)) — the amount-weighted
  // analogue of win rate, so a few big losses pull it down even at a high win rate.
  let grossWin = 0, grossLoss = 0;
  list.forEach((r) => { const v = Number(r.closedPnl) || 0; if (v > 0) grossWin += v; else grossLoss += v; });
  const grossLossAbs = Math.abs(grossLoss);
  const flow = grossWin + grossLossAbs;
  const posPct = flow > 0 ? (grossWin / flow) * 100 : 0;

  // --- Journal statistics (all derived from the already-fetched list) ---
  const pnls = list.map((r) => Number(r.closedPnl) || 0);
  const profitFactor = grossLossAbs > 0 ? grossWin / grossLossAbs : (grossWin > 0 ? Infinity : 0);
  const expectancy = total / list.length;      // mean net PnL per closed trade
  const avgWin = wins ? grossWin / wins : 0;
  const avgLoss = losses ? grossLoss / losses : 0; // ≤ 0 by construction
  const largestWin = Math.max(0, ...pnls);
  const largestLoss = Math.min(0, ...pnls);
  // Holding time: closed-pnl rows carry createdTime (open) + updatedTime (close).
  let holdSum = 0, holdN = 0;
  list.forEach((r) => {
    const a = Number(r.createdTime), b = Number(r.updatedTime);
    if (isFinite(a) && isFinite(b) && b > a) { holdSum += b - a; holdN++; }
  });
  const avgHoldMs = holdN ? holdSum / holdN : NaN;

  // Risk-adjusted statistics — PER-TRADE variants (each closed trade is one
  // observation; not annualized, and labeled as such). All guarded against
  // zero-variance/zero-loss degenerate cases: null renders as "—".
  const meanPnl = total / list.length;
  const variance = pnls.reduce((s, v) => s + (v - meanPnl) * (v - meanPnl), 0) / list.length;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? meanPnl / stdev : null;
  const downside = pnls.filter((v) => v < 0);
  const downsideDev = Math.sqrt(downside.reduce((s, v) => s + v * v, 0) / list.length);
  const sortino = downsideDev > 0 ? meanPnl / downsideDev : null;
  const winRate = wins / list.length;
  const winLossRatio = avgLoss < 0 ? avgWin / Math.abs(avgLoss) : null;
  const kelly = winLossRatio && winLossRatio > 0
    ? Math.max(-100, Math.min(100, (winRate - (1 - winRate) / winLossRatio) * 100))
    : null;
  const recovery = maxDD > 0 ? total / maxDD : null;

  // Breakdowns for the journal: PnL by symbol (top 5 by magnitude) + weekday.
  const bySymbol = {};
  list.forEach((r) => {
    const sym = String(r.symbol || "?");
    (bySymbol[sym] = bySymbol[sym] || { pnl: 0, n: 0 });
    bySymbol[sym].pnl += Number(r.closedPnl) || 0;
    bySymbol[sym].n++;
  });
  const topSymbols = Object.entries(bySymbol)
    .sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))
    .slice(0, 5);
  const weekday = Array.from({ length: 7 }, () => 0);
  list.forEach((r) => {
    const t = Number(r.updatedTime ?? r.createdTime);
    if (isFinite(t)) weekday[new Date(t).getDay()] += Number(r.closedPnl) || 0;
  });
  const weekdayMax = Math.max(1e-9, ...weekday.map(Math.abs));
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const coin = curUnit();
  const feeStr = fees != null && isFinite(fees) ? `${fmtMoney(fees)} ${coin}` : "—";
  const mt = (makerCount != null && takerCount != null) ? `${makerCount} / ${takerCount}` : "—";
  el.hidden = false;
  // Every `.v` (and the bars/curve, handled in CSS) is a private account figure,
  // masked by the privacy toggle; the `.k` labels stay readable.
  el.innerHTML =
    `<div class="chart-card"><div class="chart-title">Cumulative closed PnL (recent ${list.length})</div>${svgAreaChart(curve)}</div>` +
    `<div class="stat-figs">` +
      `<div class="figrow"><span class="k">Net realised</span><span class="v priv ${pnlClass(total)}">${fmtMoneySigned(total)} ${esc(coin)}</span></div>` +
      `<div class="figrow"><span class="k">Win rate</span><span class="v priv">${winPct.toFixed(0)}%</span></div>` +
      `<div class="wl-bar" role="img" aria-label="${wins} wins, ${losses} losses"><span class="w" style="width:${winPct.toFixed(1)}%"></span><span class="l" style="width:${(100 - winPct).toFixed(1)}%"></span></div>` +
      `<div class="figrow"><span class="k">Wins / Losses</span><span class="v priv">${wins} / ${losses}</span></div>` +
      `<div class="figrow"><span class="k">Profit booked</span><span class="v priv pos">${fmtMoneySigned(grossWin)} ${esc(coin)}</span></div>` +
      `<div class="figrow"><span class="k">Loss booked</span><span class="v priv neg">${fmtMoneySigned(grossLoss)} ${esc(coin)}</span></div>` +
      `<div class="figrow"><span class="k">Positive PnL %</span><span class="v priv">${posPct.toFixed(0)}%</span></div>` +
      `<div class="posneg-bar" role="img" aria-label="${posPct.toFixed(0)}% of booked PnL is profit"><span class="p" style="width:${posPct.toFixed(1)}%"></span><span class="n" style="width:${(100 - posPct).toFixed(1)}%"></span></div>` +
      `<div class="figrow"><span class="k">Fees (maker/taker)</span><span class="v priv">${esc(mt)}</span></div>` +
      `<div class="figrow"><span class="k">Total fees</span><span class="v priv neg">${esc(feeStr)}</span></div>` +
    `</div>` +
    // Journal tiles: the derived performance statistics a trading journal is
    // expected to carry. Every value is money-derived, so all are `priv`.
    `<div class="journal-grid">` +
      jTile("Profit factor", profitFactor === Infinity ? "∞" : profitFactor.toFixed(2),
        profitFactor >= 1 ? "pos" : "neg") +
      jTile("Expectancy / trade", `${fmtMoneySigned(expectancy)}`, pnlClass(expectancy)) +
      jTile("Avg win", fmtMoneySigned(avgWin), "pos") +
      jTile("Avg loss", fmtMoneySigned(avgLoss), "neg") +
      jTile("Largest win", fmtMoneySigned(largestWin), "pos") +
      jTile("Largest loss", fmtMoneySigned(largestLoss), "neg") +
      jTile("Max drawdown", fmtMoneySigned(-maxDD), maxDD > 0 ? "neg" : "flat") +
      jTile("Avg hold time", esc(fmtDuration(avgHoldMs)), "flat") +
      jTile("Sharpe (per-trade)", sharpe != null ? sharpe.toFixed(2) : "—", sharpe != null ? pnlClass(sharpe) : "flat") +
      jTile("Sortino (per-trade)", sortino != null ? sortino.toFixed(2) : "—", sortino != null ? pnlClass(sortino) : "flat") +
      jTile("Kelly %", kelly != null ? `${kelly.toFixed(0)}%` : "—", kelly != null ? pnlClass(kelly) : "flat") +
      jTile("Recovery factor", recovery != null ? recovery.toFixed(2) : "—", recovery != null ? pnlClass(recovery) : "flat") +
    `</div>` +
    // Breakdown row: where the PnL came from (symbols) and when (weekdays).
    `<div class="journal-breakdown">` +
      `<div class="jb-card"><div class="chart-title">PnL by symbol · top ${topSymbols.length}</div>` +
        topSymbols.map(([sym, s]) =>
          `<div class="jb-row"><span class="jb-sym mono">${esc(sym)}</span>` +
          `<span class="jb-n muted">${s.n}×</span>` +
          `<span class="jb-v priv ${pnlClass(s.pnl)}">${fmtMoneySigned(s.pnl)}</span></div>`
        ).join("") +
      `</div>` +
      `<div class="jb-card"><div class="chart-title">PnL by weekday</div><div class="wd-bars">` +
        weekday.map((v, i) => {
          const h = Math.max(3, (Math.abs(v) / weekdayMax) * 46);
          return `<div class="wd-col" title="${weekdayNames[i]}">` +
            `<i class="${v >= 0 ? "up" : "down"}" style="height:${h.toFixed(0)}px"></i>` +
            `<span>${weekdayNames[i][0]}</span></div>`;
        }).join("") +
      `</div></div>` +
    `</div>`;
}

// One journal statistic tile (label + masked value). Values arrive from fmt*
// helpers (plain text) or pre-escaped strings — never raw exchange data.
function jTile(label, value, cls) {
  return `<div class="j-tile"><div class="k">${esc(label)}</div><div class="v priv ${cls || ""}">${value}</div></div>`;
}

// ---------------------------------------------------------------------------
// Account & risk overview (folds the explorer's wallet/account reads into a
// first-class, glanceable section). Read-only.
// ---------------------------------------------------------------------------
let _accountLoaded = false;
function onAccountActive() { if (!_accountLoaded) { _accountLoaded = true; loadAccountOverview(); } }

async function loadAccountOverview() {
  const el = document.getElementById("account-overview");
  if (!el) return;
  el.innerHTML = loadingMsg("Loading account…");
  try {
    const [bal, info, withdraw] = await Promise.all([
      api("/api/balance").catch(() => null),
      api("/api/account-info").catch(() => null),
      api("/api/withdrawable").catch(() => null),
    ]);
    const acct = listOf(bal)[0];
    const coin = curUnit();
    const num = (v) => (v !== undefined && v !== "" && isFinite(Number(v)) ? Number(v) : null);
    const cards = [];
    if (acct) {
      const mb = num(acct.totalMarginBalance);
      const mm = num(acct.totalMaintenanceMargin);
      const im = num(acct.totalInitialMargin);
      const avail = num(acct.totalAvailableBalance);
      const util = (im != null && mb && mb > 0) ? (im / mb) * 100 : null;
      const mmRate = num(acct.accountMMRate);
      const ratio = mmRate != null ? mmRate * 100 : (mm != null && mb && mb > 0 ? (mm / mb) * 100 : null);
      // Every account-overview card is a private money/ratio figure → `priv`.
      const card = (k, v, cls) => cards.push(`<div class="acct-card"><div class="k">${esc(k)}</div><div class="v priv ${cls || ""}">${v}</div></div>`);
      card("Equity", `${fmtMoney(num(acct.totalEquity))} ${esc(coin)}`);
      card("Available", `${fmtMoney(avail)} ${esc(coin)}`);
      card("Unrealised PnL", `${fmtMoneySigned(acct.totalPerpUPL)} ${esc(coin)}`, pnlClass(acct.totalPerpUPL));
      card("Margin used (IM)", `${fmtMoney(im)} ${esc(coin)}`);
      card("Maint. margin", `${fmtMoney(mm)} ${esc(coin)}`);
      if (util != null) card("Margin utilization", fmtPct(util, false), util >= 80 ? "neg" : util >= 50 ? "warn" : "");
      if (ratio != null) card("Account margin ratio", fmtPct(ratio, false), ratio >= 80 ? "neg" : ratio >= 50 ? "warn" : "");
    }
    const head = cards.length ? `<div class="acct-grid">${cards.join("")}</div>` : "";
    const walletTbl = bal ? renderWallet(bal) : "";
    const infoTbl = (info && info.result) ? `<div class="explorer-summary">Account info</div>${renderAccountInfo(info)}` : "";
    const wdTbl = withdraw ? `<div class="explorer-summary">Withdrawable (${esc(curUnit())})</div>${renderWithdrawable(withdraw)}` : "";
    el.innerHTML = (head + walletTbl + infoTbl + wdTbl) || emptyMsg("No account data");
  } catch (e) {
    el.innerHTML = errorMsg(e.message);
  }
}

// ---------------------------------------------------------------------------
// Privacy toggle — hide every account figure (balances, sizes, PnL, performance)
// behind a fixed **** mask. A DISPLAY-ONLY lens: it flips body.privacy-on, which
// CSS uses to mask `.priv` elements + neutralise their gauges. It never touches
// the data model (state.available, sizing math, confirms, submissions all read
// real numbers from JS), so there is no monetary/security impact. Public market
// data (Markets, Live Charts, order book, tickers) is unmarked and stays visible.
// Preference persists in localStorage (like the currency lens); never the token.
// ---------------------------------------------------------------------------
function wirePrivacyToggle() {
  const btn = document.getElementById("privacy-toggle");
  if (!btn) return;
  let on = false;
  try { on = localStorage.getItem("dma.privacy") === "on"; } catch (e) {}
  const apply = () => {
    document.body.classList.toggle("privacy-on", on);
    btn.setAttribute("aria-pressed", String(on));
    const label = on ? "Show account figures" : "Hide account figures";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    // The tab title carries live PnL (see renderSummary) — scrub it the moment
    // privacy turns on; the next snapshot restores it after privacy turns off.
    if (on) document.title = "DMA Terminal — Dashboard";
  };
  apply(); // restore saved state before the first snapshot renders (no flash)
  btn.addEventListener("click", () => {
    on = !on;
    try { localStorage.setItem("dma.privacy", on ? "on" : "off"); } catch (e) {}
    apply();
  });
}

// ---------------------------------------------------------------------------
// Currency display toggle (USDT / INR) — read-only display lens
// ---------------------------------------------------------------------------
function wireCurrencyToggle() {
  const seg = document.getElementById("ccy-toggle");
  if (!seg) return;
  let saved = null;
  try { saved = localStorage.getItem("dma.currency"); } catch (e) {}
  if (saved === "INR" || saved === "USDT") state.currency = saved;
  const paint = () => {
    seg.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.ccy === state.currency;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  };
  seg.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      if (state.currency === b.dataset.ccy) return;
      state.currency = b.dataset.ccy;
      try { localStorage.setItem("dma.currency", state.currency); } catch (e) {}
      paint();
      rerenderForCurrency();
    })
  );
  paint();
}

// Re-render every loaded read-only view in the newly selected currency. Write
// surfaces (order ticket, modals, rail order book) are USDT and need no redraw.
function rerenderForCurrency() {
  if (state.lastDashboard) renderDashboard(state.lastDashboard);
  if (_marketsData) renderMarkets();
  // Re-render history from the cached payloads — a currency flip is a pure
  // display change and must not refetch (an "Overall" read is ~10k rows/mirror).
  if (_historyLoaded) {
    if (_historyCache) renderHistoryResults(_historyCache);
    else fetchHistory();
  }
  if (_accountLoaded) loadAccountOverview();
  if (state.lastExplorer) {
    const out = document.getElementById("explorer-result");
    if (out) renderExplorerOutput(out, state.lastExplorer.render, state.lastExplorer.data);
  }
}

// Keep the sticky order-rail's offset in sync with the ACTUAL header height, so
// a taller/wrapped header (narrow window) never overlaps the rail. Display-only.
function syncHeaderHeight() {
  const el = document.querySelector(".sticky-top");
  if (el) document.documentElement.style.setProperty("--header-h", el.offsetHeight + "px");
}

// ---------------------------------------------------------------------------
// Live candlestick charts (read-only public market data via /api/klines).
// Bybit kline → hand-drawn SVG candles (CSP-safe, like svgAreaChart). Polls
// every 1s WHILE the Dashboard tab is visible — independent of the 5s account
// feed — and pauses when the tab/pane is hidden. No write or account data.
// ---------------------------------------------------------------------------
// Must mirror the server-side CHART_SYMBOLS whitelist (the server stays
// authoritative and rejects anything off-list). dp = price decimal places.
const CHART_SYMBOLS = [
  { id: "BTCUSDT", label: "BTC", dp: 1 },
  { id: "ETHUSDT", label: "ETH", dp: 2 },
  { id: "SOLUSDT", label: "SOL", dp: 2 },
];
const CHART_LIMIT = { grid: 60, single: 160 };
// Single source for the interval set: the #chart-iv buttons AND the footer label
// both derive from this. The backend _INTERVALS map stays the authoritative gate.
const CHART_INTERVALS = [
  { code: "1", label: "1m" },
  { code: "5", label: "5m" },
  { code: "15", label: "15m" },
  { code: "60", label: "1H" },
];
// Poll cadence per candle interval: a 1m candle changes every tick, a 1H one
// barely moves for minutes — matching the request rate to the data's actual
// change rate cuts most of the continuous load on the public kline proxy
// (a region-fragile third-party dependency) with no visible latency cost.
const CHART_POLL_MS = { "1": 2000, "5": 3000, "15": 5000, "60": 10000 };
const chartState = {
  view: "grid",         // "grid" | "single"
  interval: "15",       // Bybit kline code (1 | 5 | 15 | 60) — the SELECTED interval
  loadedInterval: "15", // interval the on-screen candles were actually fetched with
  loadedView: null,     // view the on-screen candles were fetched at (grid=60 vs single=160 candles)
  loadedSingle: null,   // single-view symbol the on-screen candles were fetched for
  single: "BTCUSDT",
  data: {},             // symbol -> ascending candle[] {o,h,l,c,v}
  failures: {},         // symbol -> consecutive fetch failures (drives the empty-state note)
  fetching: false,      // single-flight guard so poll ticks never pile up
  pending: false,       // a control change arrived mid-fetch -> fetch once more after
};
let _chartTimer = null;

function chartSymById(id) {
  return CHART_SYMBOLS.find((s) => s.id === id) || CHART_SYMBOLS[0];
}
function intervalLabel(code) {
  const m = CHART_INTERVALS.find((i) => i.code === code);
  return m ? m.label : code;
}
// Compact HH:MM for the candle time axis (a candle's `start` is epoch-ms).
function fmtClock(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Parse a Bybit kline payload into ascending {o,h,l,c,v} numbers. Bybit returns
// result.list as [start, open, high, low, close, volume, turnover] strings,
// NEWEST first — iterate in reverse to get chronological order.
function parseKline(data) {
  const list = (data && data.result && data.result.list) || [];
  const out = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const k = list[i];
    if (!Array.isArray(k) || k.length < 5) continue;
    const t = Number(k[0]);
    const o = Number(k[1]), h = Number(k[2]), l = Number(k[3]), c = Number(k[4]), v = Number(k[5]);
    if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    out.push({ t: isFinite(t) ? t : 0, o, h, l, c, v: isFinite(v) ? v : 0 });
  }
  return out;
}

// Horizontal plot geometry shared by renderCandles AND the crosshair
// hit-testing — one source so hover→candle mapping can never drift from
// what is actually drawn.
const CC_GEOM = { W: 600, L: 6, R: 6 };

// Hand-drawn candlestick SVG + right-hand price scale. Inputs are coerced
// NUMBERS only — no exchange string ever reaches innerHTML here, so this is
// XSS-safe by construction (the price-scale labels go through fmtNum).
function renderCandles(svg, axisEl, timeEl, candles, dp) {
  if (!svg) return;
  if (!candles || !candles.length) {
    svg.innerHTML = "";
    if (axisEl) axisEl.innerHTML = "";
    if (timeEl) timeEl.innerHTML = "";
    svg.dataset.sig = ""; // reset so a later non-empty set always repaints
    return;
  }
  // Dirty-check: at a 1-per-few-seconds poll the candles are usually identical
  // between ticks (esp. 15m/1H). Tearing down + reparsing the whole SVG subtree
  // each time is the hottest cost in the app; skip it when nothing changed. The
  // signature keys on dp (precision), count, and the last candle's t/o/h/l/c —
  // an interval/view switch changes the set (or uses a different <svg>), so it
  // always repaints. (Never reached on the empty branch above.)
  const lastC = candles[candles.length - 1];
  const sig = `${dp}|${candles.length}|${lastC.t}|${lastC.o}|${lastC.h}|${lastC.l}|${lastC.c}`;
  if (svg.dataset.sig === sig) return;
  svg.dataset.sig = sig;
  // SVG geometry (user-space units; preserveAspectRatio="none" stretches X/Y to
  // the element box): W/H = viewBox size; L/R/T/B = inner padding; volH = bottom
  // volume-strip height; gap = price↔volume separation. The price band is the
  // vertical range [T, priceBottom]; the volume bars sit below it.
  const { W, L, R } = CC_GEOM;
  const H = 210, T = 10, B = 6, volH = 34, gap = 8;
  const priceBottom = H - B - volH - gap;
  let min = Infinity, max = -Infinity, maxV = 0;
  candles.forEach((c) => {
    if (c.l < min) min = c.l;
    if (c.h > max) max = c.h;
    if (c.v > maxV) maxV = c.v;
  });
  // 8% vertical headroom so wicks aren't flush to the edges; fall back to a tiny
  // band for a (near-)flat series, then to 1 so the span is never 0.
  const padR = (max - min) * 0.08 || Math.abs(max) * 0.001 || 1;
  min -= padR; max += padR;
  const span = (max - min) || 1;
  if (!(maxV > 0)) maxV = 1;
  // body = 62% of each candle's horizontal slot (leaves the inter-candle gap); ≥1.4px.
  const n = candles.length, plotW = W - L - R, step = plotW / n, bodyW = Math.max(1.4, step * 0.62);
  const y = (p) => T + (priceBottom - T) * (1 - (p - min) / span);
  const parts = [];
  for (let g = 1; g <= 3; g++) {
    const gy = (T + (priceBottom - T) * g / 4).toFixed(1);
    parts.push(`<line class="cs-grid" x1="0" y1="${gy}" x2="${W}" y2="${gy}"/>`);
  }
  candles.forEach((cd, i) => {
    const xc = L + (i + 0.5) * step;
    const cls = cd.c >= cd.o ? "cs-up" : "cs-down";
    parts.push(`<line class="${cls}" x1="${xc.toFixed(1)}" y1="${y(cd.h).toFixed(1)}" x2="${xc.toFixed(1)}" y2="${y(cd.l).toFixed(1)}" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
    const yo = y(cd.o), yc = y(cd.c), top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yo - yc));
    parts.push(`<rect class="${cls}" x="${(xc - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${hgt.toFixed(1)}"/>`);
    const bh = (cd.v / maxV) * volH;
    parts.push(`<rect class="${cls}" x="${(xc - bodyW / 2).toFixed(1)}" y="${(H - B - bh).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bh.toFixed(1)}" fill-opacity="0.28"/>`);
  });
  const last = candles[candles.length - 1];
  const lastCls = last.c >= last.o ? "cs-up" : "cs-down";
  parts.push(`<line class="${lastCls}" x1="0" y1="${y(last.c).toFixed(1)}" x2="${W}" y2="${y(last.c).toFixed(1)}" stroke-width="1" stroke-dasharray="4 4" opacity="0.55" vector-effect="non-scaling-stroke"/>`);
  svg.innerHTML = parts.join("");
  if (axisEl) {
    const a = [];
    const levels = 5;
    for (let k = 0; k < levels; k++) {
      const f = k / (levels - 1);
      const price = max - f * span;
      const topPct = ((T + f * (priceBottom - T)) / H * 100).toFixed(2);
      a.push(`<span class="cc-ax-lbl" style="top:${topPct}%">${fmtNum(price, dp)}</span>`);
    }
    const fLast = (max - last.c) / span;
    const ltop = ((T + fLast * (priceBottom - T)) / H * 100).toFixed(2);
    a.push(`<span class="cc-ax-last ${last.c >= last.o ? "pos" : "neg"}" style="top:${ltop}%">${fmtNum(last.c, dp)}</span>`);
    axisEl.innerHTML = a.join("");
  }
  if (timeEl) {
    // Time axis: a few HH:MM labels under the plot. Labels are HTML (not SVG text)
    // so they stay crisp under the stretched viewBox; the row is inset by the
    // price gutter (CSS) to align with the plot. Interior labels sit centred on
    // their candle's x; the first/last are pinned to the row edges instead (so
    // they can't clip past the plot), which reads as the visible time range.
    const t = [], seen = {};
    [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1].forEach((i) => {
      if (i < 0 || i >= n || seen[i]) return;
      seen[i] = 1;
      let style;
      if (i === 0) style = "left:0";
      else if (i === n - 1) style = "right:0";
      else style = `left:${(((L + (i + 0.5) * step) / W) * 100).toFixed(1)}%;transform:translateX(-50%)`;
      t.push(`<span class="cc-t" style="${style}">${fmtClock(candles[i].t)}</span>`);
    });
    timeEl.innerHTML = t.join("");
  }
}

// Static card shell (built once). suffix = "BTCUSDT"… for grid cards, "single"
// for the single-view card. Labels are our own constants but still escaped.
function chartCardHTML(sm, suffix) {
  return (
    `<div class="cc-head">` +
      `<div class="cc-sym"><b>${esc(sm.label)}</b><span>${esc(sm.id)} · Perp</span></div>` +
      `<div class="cc-px"><span class="cc-last mono" id="cc-last-${suffix}">—</span><span class="cc-chg mono" id="cc-chg-${suffix}">—</span></div>` +
    `</div>` +
    `<div class="cc-chart${suffix === "single" ? " lg" : ""}">` +
      `<svg class="cs" id="cs-${suffix}" viewBox="0 0 600 210" preserveAspectRatio="none" role="img" aria-label="${esc(sm.label)} candlesticks"></svg>` +
      `<div class="cc-axis" id="cax-${suffix}"></div>` +
      `<div class="cc-cross" id="ccx-${suffix}" hidden></div>` +
    `</div>` +
    `<div class="cc-times" id="ctime-${suffix}"></div>` +
    `<div class="cc-foot"><span id="cfoot-${suffix}">—</span><span class="muted" id="civ-${suffix}"></span></div>`
  );
}

function buildChartDom() {
  const ivSeg = document.getElementById("chart-iv");
  if (ivSeg && !ivSeg.children.length) {
    ivSeg.innerHTML = CHART_INTERVALS.map((iv) => {
      const on = iv.code === chartState.interval;
      return `<button type="button" class="seg-neutral${on ? " active" : ""}" data-iv="${esc(iv.code)}" aria-pressed="${on}">${esc(iv.label)}</button>`;
    }).join("");
  }
  const symSeg = document.getElementById("chart-sym");
  if (symSeg && !symSeg.children.length) {
    symSeg.innerHTML = CHART_SYMBOLS.map((s) => {
      const on = s.id === chartState.single;
      return `<button type="button" class="seg-neutral${on ? " active" : ""}" data-sym="${esc(s.id)}" aria-pressed="${on}">${esc(s.label)}</button>`;
    }).join("");
  }
  const grid = document.getElementById("charts-grid");
  if (grid && !grid.children.length) {
    // data-trade reuses the existing delegated click → loadSymbolIntoTicket wiring;
    // role/tabindex/aria-label + the shared keydown handler make it keyboard-operable.
    grid.innerHTML = CHART_SYMBOLS.map(
      (s) => `<div class="cc-card clickable" data-trade="${esc(s.id)}" role="button" tabindex="0" title="Load ${esc(s.id)} into the order ticket" aria-label="Load ${esc(s.id)} into the order ticket">${chartCardHTML(s, s.id)}</div>`
    ).join("");
  }
  const single = document.getElementById("charts-single");
  if (single && !single.children.length) {
    single.innerHTML = `<div class="cc-card">${chartCardHTML(chartSymById(chartState.single), "single")}</div>`;
  }
  // Crosshair wiring — once per card (the shells are built once).
  if (grid && !grid.dataset.crossWired) {
    grid.dataset.crossWired = "1";
    CHART_SYMBOLS.forEach((s) => wireChartCrosshair(s.id, () => s.id));
  }
  if (single && !single.dataset.crossWired) {
    single.dataset.crossWired = "1";
    wireChartCrosshair("single", () => chartState.loadedSingle || chartState.single);
  }
}

// Crosshair: hovering a chart shows a vertical hairline snapped to the candle
// under the cursor and swaps the card footer to that candle's time + OHLC.
// Display-only: reads the already-fetched arrays, never fetches or re-renders.
function wireChartCrosshair(suffix, symIdFn) {
  const svg = document.getElementById(`cs-${suffix}`);
  const cross = document.getElementById(`ccx-${suffix}`);
  const foot = document.getElementById(`cfoot-${suffix}`);
  if (!svg || !cross || !foot) return;
  const chartBox = svg.parentElement; // .cc-chart (position: relative)
  const onMove = (e) => {
    const symId = symIdFn();
    const sm = chartSymById(symId);
    const arr = chartState.data[symId];
    const rect = svg.getBoundingClientRect();
    if (!arr || !arr.length || rect.width <= 0) { cross.hidden = true; return; }
    const frac = (e.clientX - rect.left) / rect.width;
    if (frac < 0 || frac > 1) { cross.hidden = true; return; }
    const n = arr.length;
    const step = (CC_GEOM.W - CC_GEOM.L - CC_GEOM.R) / n;
    let idx = Math.floor((frac * CC_GEOM.W - CC_GEOM.L) / step);
    idx = Math.max(0, Math.min(n - 1, idx));
    const c = arr[idx];
    // Snap the hairline to the hovered candle's centre, in on-screen pixels.
    const xc = CC_GEOM.L + (idx + 0.5) * step;
    const boxRect = chartBox.getBoundingClientRect();
    cross.style.left = ((rect.left - boxRect.left) + (xc / CC_GEOM.W) * rect.width).toFixed(1) + "px";
    cross.hidden = false;
    foot.dataset.hover = "1"; // freeze the periodic H/L repaint while inspecting
    foot.textContent =
      `${fmtClock(c.t)}  O ${fmtNum(c.o, sm.dp)}  H ${fmtNum(c.h, sm.dp)}  L ${fmtNum(c.l, sm.dp)}  C ${fmtNum(c.c, sm.dp)}`;
  };
  const onLeave = () => {
    cross.hidden = true;
    delete foot.dataset.hover;
    updateChartHeader(chartSymById(symIdFn()), suffix); // restore the H/L line
  };
  chartBox.addEventListener("mousemove", onMove);
  chartBox.addEventListener("mouseleave", onLeave);
}

function updateChartHeader(sm, suffix) {
  const arr = chartState.data[sm.id];
  if (!arr || !arr.length) {
    // Never-loaded chart: after repeated failures, say so instead of leaving a
    // silently blank card (the one known deploy pitfall — a US-region host is
    // geo-blocked from the public kline API — previously had no on-screen cue).
    const footEl = document.getElementById(`cfoot-${suffix}`);
    if (footEl && (chartState.failures[sm.id] || 0) >= 2) {
      footEl.textContent = "data unavailable — kline source unreachable (region-blocked?)";
    }
    return;
  }
  const last = arr[arr.length - 1], first = arr[0];
  const chg = first.o ? (last.c / first.o - 1) * 100 : 0;
  const lastEl = document.getElementById(`cc-last-${suffix}`);
  if (lastEl) lastEl.textContent = fmtNum(last.c, sm.dp);
  const chgEl = document.getElementById(`cc-chg-${suffix}`);
  if (chgEl) {
    chgEl.textContent = `${chg > 0 ? "▲ +" : chg < 0 ? "▼ " : ""}${chg.toFixed(2)}%`;
    chgEl.className = "cc-chg mono " + (chg > 0 ? "pos" : chg < 0 ? "neg" : "flat");
  }
  let hi = -Infinity, lo = Infinity;
  arr.forEach((c) => { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; });
  const footEl = document.getElementById(`cfoot-${suffix}`);
  // While the crosshair is inspecting a candle, its OHLC readout owns the
  // footer — don't let the periodic repaint stomp it mid-hover.
  if (footEl && footEl.dataset.hover !== "1") {
    footEl.textContent = `H ${fmtNum(hi, sm.dp)}  L ${fmtNum(lo, sm.dp)}`;
  }
  const ivEl = document.getElementById(`civ-${suffix}`);
  // Label from the interval the on-screen data was fetched with (not the freshly
  // selected one) so the footer can never describe candles it doesn't show.
  if (ivEl) ivEl.textContent = `${intervalLabel(chartState.loadedInterval)} · ${arr.length} candles`;
}

function renderCharts() {
  const grid = document.getElementById("charts-grid");
  const single = document.getElementById("charts-single");
  const symSeg = document.getElementById("chart-sym");
  if (chartState.view === "grid") {
    if (grid) grid.hidden = false;
    if (single) single.hidden = true;
    if (symSeg) symSeg.hidden = true;
    CHART_SYMBOLS.forEach((s) => {
      renderCandles(document.getElementById(`cs-${s.id}`), document.getElementById(`cax-${s.id}`), document.getElementById(`ctime-${s.id}`), chartState.data[s.id], s.dp);
      updateChartHeader(s, s.id);
    });
  } else {
    if (grid) grid.hidden = true;
    if (single) single.hidden = false;
    if (symSeg) symSeg.hidden = false;
    const s = chartSymById(chartState.single);
    const head = single && single.querySelector(".cc-sym");
    if (head) head.innerHTML = `<b>${esc(s.label)}</b><span>${esc(s.id)} · Perp</span>`;
    renderCandles(document.getElementById("cs-single"), document.getElementById("cax-single"), document.getElementById("ctime-single"), chartState.data[s.id], s.dp);
    updateChartHeader(s, "single");
  }
}

async function fetchCharts() {
  // Single-flight: if a batch is already running, record that the selection may
  // have changed and let the in-flight batch trigger ONE more fetch when it ends,
  // so a control click during a poll tick is never silently dropped.
  if (chartState.fetching) { chartState.pending = true; return; }
  // Snapshot the params for THIS batch so the URL, the rendered data, and the
  // footer label are always mutually consistent even if a control changes mid-flight.
  const iv = chartState.interval;
  const view = chartState.view;
  const syms = view === "grid" ? CHART_SYMBOLS.map((s) => s.id) : [chartState.single];
  const limit = view === "grid" ? CHART_LIMIT.grid : CHART_LIMIT.single;
  chartState.fetching = true;
  try {
    await Promise.all(
      syms.map(async (id) => {
        try {
          const data = await api(
            `/api/klines?symbol=${encodeURIComponent(id)}&interval=${encodeURIComponent(iv)}&limit=${limit}`
          );
          chartState.data[id] = parseKline(data);
          delete chartState.failures[id];
        } catch (e) {
          // Keep the previous candles on a transient error — never blank the
          // chart — but count the failure so a never-loaded card can say WHY
          // it is empty (e.g. the US-region kline geo-block).
          chartState.failures[id] = (chartState.failures[id] || 0) + 1;
        }
      })
    );
    chartState.loadedInterval = iv; // the on-screen candles now reflect `iv`
    chartState.loadedView = view;   // ...and this view's candle count (grid 60 vs single 160)
    chartState.loadedSingle = view === "single" ? syms[0] : chartState.loadedSingle;
    renderCharts();
  } finally {
    chartState.fetching = false;
    if (chartState.pending) { chartState.pending = false; fetchCharts(); }
  }
}

function chartsVisible() {
  const pane = document.querySelector('[data-pane="dashboard"]');
  const panel = document.getElementById("charts-panel");
  // A collapsed charts panel shows nothing — polling for it is pure waste.
  const collapsed = panel && panel.classList.contains("collapsed");
  return !!pane && !pane.hidden && !document.hidden && !collapsed;
}
// True when the on-screen candles already match the current interval + view, so
// a start (tab switch / visibility flap) can reuse them instead of firing a fresh
// kline burst against the region-constrained public proxy on every transition.
function chartsDataFresh() {
  // Must match the interval AND the view the candles were fetched at — grid caches
  // 60 candles, single caches 160, so grid data is NOT fresh for single view (and
  // a single-symbol switch invalidates too). Otherwise a visibility flap could
  // paint the wrong-resolution series as "fresh".
  if (chartState.loadedInterval !== chartState.interval) return false;
  if (chartState.loadedView !== chartState.view) return false;
  if (chartState.view === "single" && chartState.loadedSingle !== chartState.single) return false;
  const syms = chartState.view === "grid" ? CHART_SYMBOLS.map((s) => s.id) : [chartState.single];
  return syms.every((id) => Array.isArray(chartState.data[id]) && chartState.data[id].length);
}
function startChartPolling() {
  stopChartPolling();
  if (!chartsVisible()) return;
  // Only burst an immediate fetch when the cache can't already paint the current
  // view/interval; otherwise repaint from cache and let the interval refresh it.
  if (chartsDataFresh()) renderCharts();
  else fetchCharts();
  // Cadence follows the selected candle interval (CHART_POLL_MS): the render
  // dirty-check makes extra polls cheap to PAINT, but the request itself is
  // pure waste when the candle can't have changed.
  _chartTimer = setInterval(() => {
    if (!chartsVisible()) { stopChartPolling(); return; }
    fetchCharts();
  }, CHART_POLL_MS[chartState.interval] || 2000);
}
function stopChartPolling() {
  if (_chartTimer) { clearInterval(_chartTimer); _chartTimer = null; }
}

function wireCharts() {
  const panel = document.getElementById("charts-panel");
  if (!panel) return;
  buildChartDom();
  const repaintSeg = (seg, btn) =>
    seg.querySelectorAll("button").forEach((x) => {
      const on = x === btn;
      x.classList.toggle("active", on);
      x.setAttribute("aria-pressed", String(on));
    });

  const viewSeg = document.getElementById("chart-view");
  if (viewSeg) viewSeg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (!b) return;
    chartState.view = b.getAttribute("data-view");
    repaintSeg(viewSeg, b);
    renderCharts();
    fetchCharts(); // single view / different limit may need fresh data
  });

  const symSeg = document.getElementById("chart-sym");
  if (symSeg) symSeg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sym]");
    if (!b) return;
    chartState.single = b.getAttribute("data-sym");
    repaintSeg(symSeg, b);
    renderCharts();
    fetchCharts();
  });

  const ivSeg = document.getElementById("chart-iv");
  if (ivSeg) ivSeg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-iv]");
    if (!b) return;
    chartState.interval = b.getAttribute("data-iv");
    repaintSeg(ivSeg, b);
    // Restart (not just fetch): the poll timer must adopt the new interval's
    // cadence (CHART_POLL_MS); startChartPolling also issues the fresh fetch.
    startChartPolling();
  });

  // Fullscreen: the whole charts panel becomes a fixed overlay (Esc exits).
  // Pure CSS-class toggle; polling/rendering are untouched and keep running.
  const expandBtn = document.getElementById("chart-expand");
  if (expandBtn) {
    const setFull = (on) => {
      panel.classList.toggle("chart-full", on);
      expandBtn.setAttribute("aria-pressed", String(on));
    };
    expandBtn.addEventListener("click", () => setFull(!panel.classList.contains("chart-full")));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panel.classList.contains("chart-full")) setFull(false);
    });
  }

  // Pause polling when the browser tab is backgrounded; resume when visible.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopChartPolling();
    else startChartPolling();
  });

  startChartPolling();
}

// ---------------------------------------------------------------------------
// Workspace system — collapse any panel; drag (or Arrow-key) the dashboard's
// main panels into your own order; both persist locally. PRESENTATION ONLY:
// panels keep their ids and inner DOM, so every renderer and poller is
// untouched; collapsing charts/book additionally pauses their polling.
// ---------------------------------------------------------------------------
const _WS_KEY = "dma.workspace.v1";
function _wsState() {
  try { return JSON.parse(localStorage.getItem(_WS_KEY) || "{}") || {}; } catch (e) { return {}; }
}
function _wsSave(st) {
  try { localStorage.setItem(_WS_KEY, JSON.stringify(st)); } catch (e) {}
}

function wireWorkspace() {
  const main = document.querySelector(".workspace-main");
  const st = _wsState();

  // Restore the saved order of the main panels (unknown ids are ignored, so a
  // stale saved layout can never lose a panel).
  if (main && Array.isArray(st.order)) {
    st.order.forEach((id) => {
      const sec = main.querySelector(`:scope > [data-wpanel="${CSS.escape(id)}"]`);
      if (sec) main.appendChild(sec);
    });
  }
  const persistOrder = () => {
    if (!main) return;
    const next = _wsState();
    next.order = Array.from(main.querySelectorAll(":scope > [data-wpanel]")).map((s) => s.dataset.wpanel);
    _wsSave(next);
  };

  document.querySelectorAll("[data-wpanel]").forEach((sec) => {
    const head = sec.querySelector(".panel-head");
    const id = sec.dataset.wpanel;
    if (!head) return;
    const reorderable = main && sec.parentElement === main;
    const tools = document.createElement("span");
    tools.className = "wpanel-tools";
    tools.innerHTML =
      (reorderable
        ? `<button type="button" class="wpanel-btn wpanel-drag" draggable="true" title="Drag to reorder (Arrow keys work too)" aria-label="Reorder ${esc(id)} panel">⁙</button>`
        : "") +
      `<button type="button" class="wpanel-btn wpanel-collapse" title="Collapse panel" aria-expanded="true" aria-label="Collapse ${esc(id)} panel">▾</button>`;
    head.appendChild(tools);

    const collapseBtn = tools.querySelector(".wpanel-collapse");
    const applyCollapsed = (on) => {
      sec.classList.toggle("collapsed", on);
      collapseBtn.setAttribute("aria-expanded", String(!on));
      collapseBtn.textContent = on ? "▸" : "▾";
      // Collapsed panels stop paying for data they don't show.
      if (id === "charts") { if (on) stopChartPolling(); else startChartPolling(); }
    };
    if (st.collapsed && st.collapsed[id]) applyCollapsed(true);
    collapseBtn.addEventListener("click", () => {
      const on = !sec.classList.contains("collapsed");
      applyCollapsed(on);
      const next = _wsState();
      next.collapsed = next.collapsed || {};
      next.collapsed[id] = on;
      _wsSave(next);
    });

    const dragBtn = tools.querySelector(".wpanel-drag");
    if (dragBtn) {
      dragBtn.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", id);
        e.dataTransfer.effectAllowed = "move";
        sec.classList.add("dragging");
      });
      dragBtn.addEventListener("dragend", () => { sec.classList.remove("dragging"); persistOrder(); });
      // Keyboard parity for reordering (a11y): Arrow keys swap with a sibling.
      dragBtn.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const sib = e.key === "ArrowUp" ? sec.previousElementSibling : sec.nextElementSibling;
        if (!sib || !sib.dataset || !sib.dataset.wpanel) return;
        if (e.key === "ArrowUp") main.insertBefore(sec, sib);
        else main.insertBefore(sib, sec);
        persistOrder();
        dragBtn.focus();
      });
    }
  });

  if (main) {
    main.addEventListener("dragover", (e) => {
      const dragging = main.querySelector(":scope > .dragging");
      if (!dragging) return;
      e.preventDefault();
      const over = e.target.closest("[data-wpanel]");
      if (!over || over === dragging || over.parentElement !== main) return;
      const rect = over.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      main.insertBefore(dragging, before ? over : over.nextSibling);
    });
    main.addEventListener("drop", (e) => e.preventDefault());
  }
}

// ---------------------------------------------------------------------------
// Table density — compact mode for information-dense sessions; persisted.
// ---------------------------------------------------------------------------
function applyDensity() {
  let compact = false;
  try { compact = localStorage.getItem("dma.density") === "compact"; } catch (e) {}
  document.body.classList.toggle("density-compact", compact);
}
function toggleDensity() {
  const compact = !document.body.classList.contains("density-compact");
  document.body.classList.toggle("density-compact", compact);
  try { localStorage.setItem("dma.density", compact ? "compact" : "comfortable"); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts reference ("?")
// ---------------------------------------------------------------------------
function wireKeysHelp() {
  const overlay = document.getElementById("keys-overlay");
  if (!overlay) return;
  const close = () => { overlay.hidden = true; };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  const btn = document.getElementById("keys-close");
  if (btn) btn.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) close(); });
}
function openKeysHelp() {
  const overlay = document.getElementById("keys-overlay");
  if (overlay) overlay.hidden = false;
}

// ---------------------------------------------------------------------------
// Command palette (Ctrl/Cmd + K) — navigation & display actions ONLY. Every
// action just .click()s an existing on-screen control, so no new code path
// can ever reach a write endpoint; the standing rule that no keyboard
// shortcut trades is preserved by construction.
// ---------------------------------------------------------------------------
function wireCommandPalette() {
  const overlay = document.getElementById("cmdk-overlay");
  const input = document.getElementById("cmdk-input");
  const listEl = document.getElementById("cmdk-list");
  if (!overlay || !input || !listEl) return;
  let items = [];
  let sel = 0;
  let prevFocus = null;

  // Built fresh at each open/keystroke from the CURRENT DOM, so viewer-removed
  // controls (admin tabs, the ticket) never appear for a viewer session.
  const buildActions = () => {
    const acts = [];
    document.querySelectorAll("#tabs .tab").forEach((b) => {
      const label = (b.textContent || "").replace(/\s+/g, " ").trim();
      acts.push({ label: `Go to ${label}`, hint: "nav", run: () => b.click() });
    });
    if (document.getElementById("order-form")) {
      acts.push({
        label: "Focus order ticket", hint: "/",
        run: () => {
          const pane = document.querySelector('[data-pane="dashboard"]');
          const dashTab = document.querySelector('#tabs .tab[data-tab="dashboard"]');
          if (pane && pane.hidden && dashTab) dashTab.click();
          const f = document.getElementById("order-form");
          try { f.symbol.focus(); f.symbol.select(); } catch (e) {}
        },
      });
    }
    acts.push({
      label: "Toggle privacy mode", hint: "display",
      run: () => { const b = document.getElementById("privacy-toggle"); if (b) b.click(); },
    });
    document.querySelectorAll("#ccy-toggle button").forEach((b) => {
      acts.push({ label: `Display currency: ${b.dataset.ccy}`, hint: "display", run: () => b.click() });
    });
    const expand = document.getElementById("chart-expand");
    if (expand) acts.push({ label: "Expand / collapse charts", hint: "esc exits", run: () => expand.click() });
    [["markets-refresh", "Refresh markets"], ["history-refresh", "Refresh journal"],
     ["account-refresh", "Refresh account"]].forEach(([id, label]) => {
      const b = document.getElementById(id);
      if (b) acts.push({ label, hint: "read-only", run: () => b.click() });
    });
    acts.push({
      label: document.body.classList.contains("density-compact")
        ? "Table density: comfortable" : "Table density: compact",
      hint: "display", run: toggleDensity,
    });
    acts.push({
      label: "Notifications", hint: "log",
      run: () => { const b = document.getElementById("notif-btn"); if (b) b.click(); },
    });
    acts.push({ label: "Keyboard shortcuts", hint: "?", run: openKeysHelp });
    acts.push({
      label: "Reset workspace layout", hint: "reload",
      run: () => {
        try { localStorage.removeItem(_WS_KEY); } catch (e) {}
        toast("Workspace layout reset — reload to apply", "info");
      },
    });
    const logout = document.getElementById("logout-btn");
    if (logout) acts.push({ label: "Log out", hint: "session", run: () => logout.click() });
    return acts;
  };

  const paint = () => {
    const q = input.value.trim().toLowerCase();
    items = buildActions().filter((a) => !q || a.label.toLowerCase().includes(q));
    sel = Math.min(sel, Math.max(0, items.length - 1));
    listEl.innerHTML = items.length
      ? items.map((a, i) =>
          `<div class="cmdk-item${i === sel ? " sel" : ""}" role="option" aria-selected="${i === sel}" data-i="${i}">` +
          `<span>${esc(a.label)}</span><span class="hint">${esc(a.hint)}</span></div>`
        ).join("")
      : `<div class="cmdk-empty">No matching command</div>`;
  };

  const close = () => {
    overlay.hidden = true;
    input.value = "";
    restoreFocus(prevFocus);
  };
  const open = () => {
    // Never stack over a live trade dialog — those own the keyboard.
    const confirmOv = document.getElementById("confirm-overlay");
    const tpslOv = document.getElementById("tpsl-overlay");
    if ((confirmOv && !confirmOv.hidden) || (tpslOv && !tpslOv.hidden)) return;
    prevFocus = document.activeElement;
    sel = 0;
    overlay.hidden = false;
    paint();
    input.focus();
  };
  const runSelected = () => {
    const action = items[sel];
    close();
    if (action) action.run();
  };

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "k") {
      e.preventDefault();
      if (overlay.hidden) open(); else close();
    }
  });
  const hintBtn = document.getElementById("cmdk-hint");
  if (hintBtn) hintBtn.addEventListener("click", open);
  input.addEventListener("input", () => { sel = 0; paint(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); runSelected(); }
  });
  listEl.addEventListener("click", (e) => {
    const it = e.target.closest(".cmdk-item[data-i]");
    if (!it) return;
    sel = Number(it.dataset.i);
    runSelected();
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
}

// ---------------------------------------------------------------------------
// Global keys — "/" jumps to the ticket, "B"/"S" jump to it with the side
// pre-selected (form state only — identical to clicking the segment), "?"
// opens the shortcut reference. NAVIGATION/PREFILL ONLY: no keyboard shortcut
// ever submits, modifies or cancels anything. All ignored while typing, and
// the ticket keys are inert for viewers (no ticket exists for them).
// ---------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if (e.key === "?") { e.preventDefault(); openKeysHelp(); return; }
  const key = e.key.toLowerCase();
  if (e.key !== "/" && key !== "b" && key !== "s") return;
  const form = document.getElementById("order-form");
  if (!form) return;
  e.preventDefault();
  const pane = document.querySelector('[data-pane="dashboard"]');
  if (pane && pane.hidden) {
    const dashTab = document.querySelector('#tabs .tab[data-tab="dashboard"]');
    if (dashTab) dashTab.click();
  }
  if (key === "b" || key === "s") {
    form.side.value = key === "b" ? "Buy" : "Sell";
    form.side.dispatchEvent(new Event("change", { bubbles: true })); // repaints segment + submit
  }
  try {
    // "/" (or an empty ticket) → symbol; a ready ticket with B/S → quantity.
    const target = e.key === "/" || !form.symbol.value.trim() ? form.symbol : form.qty;
    target.focus();
    if (target === form.symbol) target.select();
  } catch (err) { /* focus is best-effort */ }
});

// Arrow-key navigation between focused table rows (dashboard grids): the rows
// are already focusable buttons (Enter expands); ↑/↓ now moves between them.
document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const row = e.target && e.target.closest &&
    e.target.closest("#positions-body tr.exp-row, #orders-body tr.exp-row");
  if (!row || e.target !== row) return;
  e.preventDefault();
  let next = row;
  do {
    next = e.key === "ArrowDown" ? next.nextElementSibling : next.previousElementSibling;
  } while (next && !next.classList.contains("exp-row"));
  if (next) next.focus();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function init() {
  try {
    await loadMe();
  } catch (e) {
    window.location.href = "/login";
    return;
  }
  wireAdminForms();
  wireExplorer();
  wireTabs();
  wireMarketsHistory();
  wireCharts(); // live candlestick charts (read-only; polls while dashboard visible)
  wireWorkspace(); // panel collapse/reorder, persisted locally (display-only)
  wireCommandPalette(); // Ctrl/Cmd+K — navigation & display actions only
  wireNotifCenter(); // session notification log (every toast, recoverable)
  wireKeysHelp(); // "?" shortcut reference
  applyDensity(); // restore saved table density
  wirePrivacyToggle(); // restore saved privacy state BEFORE the first render (no flash)
  wireCurrencyToggle(); // restore saved currency BEFORE the first render
  renderLoading(); // skeleton rows until the first snapshot lands
  updateSizingAvail();
  // Render an immediate snapshot, then rely on the WS for live updates.
  try {
    const d = await api("/api/dashboard");
    renderDashboard(d);
  } catch (e) {}
  connectWS();
  startConnWatchdog(); // escalate the pill to "stale" if frames stop arriving
  syncHeaderHeight();
  // Throttle to one measurement per frame so a resize drag doesn't thrash layout.
  let _rhTick = false;
  window.addEventListener("resize", () => {
    if (_rhTick) return;
    _rhTick = true;
    requestAnimationFrame(() => { _rhTick = false; syncHeaderHeight(); });
  });
})();
