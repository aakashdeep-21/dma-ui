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
  tradeToken: "",
  writeInFlight: false,
  orderLastPrice: null,
  prevPos: {},
  lastPositions: [],
  lastOrders: [],
  expandedPos: new Set(),
  expandedOrders: new Set(),
  sortPos: { key: null, dir: 1 },
  sortOrders: { key: null, dir: 1 },
};

// Non-blocking toast notifications for action outcomes.
function toast(msg, type = "info", ms = 4500) {
  const wrap = document.getElementById("toasts");
  if (!wrap || !msg) return;
  const el = document.createElement("div");
  el.className = "toast " + (type || "");
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  }, ms);
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
    });
  });
}

// Small key/value detail grid for an expanded row. Skips empty values.
function detailGrid(pairs) {
  const items = pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== "—")
    .map(([k, v]) => `<div><span class="dt-k">${esc(k)}</span><span class="dt-v mono">${esc(v)}</span></div>`)
    .join("");
  return `<div class="detail-grid">${items || '<span class="muted">No extra detail.</span>'}</div>`;
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
  if (pb) pb.innerHTML = skel(admin ? 12 : 11);
  if (ob) ob.innerHTML = skel(admin ? 8 : 7);
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
function projAmount(r, withRoi) {
  if (!r) return "";
  const roi =
    withRoi && r.roi != null ? ` (${r.roi >= 0 ? "+" : ""}${r.roi.toFixed(2)}%)` : "";
  return `<span class="${pnlClass(r.net)}">${fmtNum(r.net)}${roi}</span>`;
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
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
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

// Typed-confirm modal: the user must type the word "confirm" to proceed.
// Returns a Promise<boolean>.
let _confirmOpen = false;
function typedConfirm(message) {
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
    $("#confirm-message").textContent = message;
    input.value = "";
    proceed.disabled = true;
    overlay.hidden = false;
    input.focus();

    const cleanup = (result) => {
      overlay.hidden = true;
      input.removeEventListener("input", onInput);
      proceed.removeEventListener("click", onProceed);
      cancel.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKey);
      overlay.removeEventListener("click", onOverlay);
      _confirmOpen = false;
      resolve(result);
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
  pnlEl.textContent = `${fmtNum(summary.totalUnrealisedPnl)} ${coin}`;
  pnlEl.className = "stat-value " + pnlClass(summary.totalUnrealisedPnl);

  $("#stat-positions").textContent = summary.openPositions ?? "—";
  $("#stat-orders").textContent = summary.openOrders ?? "—";

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
  setText("#stat-equity", equity != null ? `${fmtNum(equity)} ${coin}` : "—");
  setText("#stat-available", available != null ? `avail ${fmtNum(available)}` : "");
  setText("#stat-margin-used", usedMargin != null ? `${fmtNum(usedMargin)} ${coin}` : "—");

  // PnL % relative to used (initial) margin → ROE-style; fall back to equity.
  const pnlPctEl = $("#stat-pnl-pct");
  if (pnlPctEl) {
    const base = usedMargin && usedMargin > 0 ? usedMargin : equity;
    if (isFinite(upl) && base && base > 0) {
      pnlPctEl.textContent = fmtPct((upl / base) * 100);
      pnlPctEl.className = "stat-sub " + pnlClass(upl);
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
      ratioEl.className = "stat-value" + (ratio >= 80 ? " neg" : ratio >= 50 ? " warn" : "");
    } else {
      ratioEl.textContent = "—";
      ratioEl.className = "stat-value";
      bar.style.width = "0%";
      meter.className = "meter";
    }
  }
}

function renderPositions(positions) {
  const body = $("#positions-body");
  state.lastPositions = positions || [];
  const rows = state.lastPositions.filter((p) => Number(p.size) !== 0);
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="12" class="muted center">No open positions</td></tr>`;
    return;
  }
  const isAdmin = state.role === "admin";
  const hasVal = (v) => v !== undefined && v !== null && v !== "" && Number(v) !== 0;
  const nextPrev = {};
  const sorted = applySort(rows, state.sortPos);
  body.innerHTML = sorted
    .map((p) => {
      const pnl = p.unrealisedPnl;
      const key = `${p.symbol}/${p.positionIdx ?? 0}`;
      const expanded = state.expandedPos.has(key);
      const actions = isAdmin
        ? `<td class="row-actions">
            <button class="btn-ghost sm" data-tpsl='${esc(JSON.stringify({
              symbol: p.symbol,
              positionIdx: p.positionIdx ?? 0,
              side: p.side,
              size: p.size,
              leverage: p.leverage,
              avgPrice: p.avgPrice,
              markPrice: p.markPrice,
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
        ? `${fmtNum(p.takeProfit, 4)}${projHintHTML({ side: p.side, entry: p.avgPrice, exitPrice: p.takeProfit, size: p.size, leverage: p.leverage })}`
        : "—";
      const slCell = hasVal(p.stopLoss)
        ? `${fmtNum(p.stopLoss, 4)}${projHintHTML({ side: p.side, entry: p.avgPrice, exitPrice: p.stopLoss, size: p.size, leverage: p.leverage })}`
        : "—";

      // Break-even (incl. fees) under entry.
      const beSub = hasVal(p.breakEvenPrice)
        ? `<span class="cell-sub">BE ${fmtNum(p.breakEvenPrice, 4)}</span>`
        : "";

      // Liquidation distance % under the liq price.
      let liqCell = "—";
      if (hasVal(p.liqPrice)) {
        liqCell = fmtNum(p.liqPrice, 4);
        const mark = Number(p.markPrice);
        const liq = Number(p.liqPrice);
        if (isFinite(mark) && mark > 0 && isFinite(liq)) {
          const dist = (Math.abs(mark - liq) / mark) * 100;
          const cls = dist < 5 ? "neg" : dist < 10 ? "warn" : "";
          liqCell += `<span class="cell-sub ${cls}">${dist.toFixed(2)}% away</span>`;
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
        ["Break-even", hasVal(p.breakEvenPrice) ? fmtNum(p.breakEvenPrice, 4) : ""],
        ["Initial margin", p.positionIM ? fmtNum(p.positionIM) : ""],
        ["Maint. margin", p.positionMM ? fmtNum(p.positionMM) : ""],
        ["Realized PnL", p.curRealisedPnl !== undefined && p.curRealisedPnl !== "" ? fmtNum(p.curRealisedPnl) : ""],
        ["Cum. realized", p.cumRealisedPnl ? fmtNum(p.cumRealisedPnl) : ""],
        ["Position value", fmtNum(p.positionValue)],
        ["TP/SL mode", p.tpslMode],
        ["Position idx", p.positionIdx],
        ["Opened", fmtTime(p.createdTime)],
        ["Updated", fmtTime(p.updatedTime)],
      ]);

      return `<tr class="exp-row${expanded ? " expanded" : ""}" data-pkey="${esc(key)}">
        <td class="mono card-head"><span class="caret">${expanded ? "▾" : "▸"}</span>${esc(p.symbol)}</td>
        <td data-label="Side" class="${(p.side || "").toLowerCase() === "buy" ? "pos" : "neg"}">${esc(p.side)}</td>
        <td data-label="Size" class="mono">${fmtNum(p.size, 4)}</td>
        <td data-label="Entry" class="mono">${fmtNum(p.avgPrice, 4)}${beSub}</td>
        <td data-label="Mark" class="mono">${fmtNum(p.markPrice, 4)}</td>
        <td data-label="Liq." class="mono">${liqCell}</td>
        <td data-label="Lev" class="mono">${esc(p.leverage ?? "—")}x</td>
        <td data-label="Value" class="mono">${fmtNum(p.positionValue)}</td>
        <td data-label="Unrealised PnL" class="mono ${pnlClass(pnl)}${flash}">${fmtNum(pnl)}${roeSub}</td>
        <td data-label="TP" class="mono">${tpCell}</td>
        <td data-label="SL" class="mono">${slCell}</td>
        ${actions}
      </tr>
      <tr class="detail-row"${expanded ? "" : " hidden"}><td colspan="99">${detail}</td></tr>`;
    })
    .join("");
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
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted center">No open orders</td></tr>`;
    updateSortIndicators();
    return;
  }
  const isAdmin = state.role === "admin";
  const sorted = applySort(rows, state.sortOrders);
  body.innerHTML = sorted
    .map((o) => {
      const key = o.orderId || `${o.symbol}/${o.orderLinkId || ""}`;
      const expanded = state.expandedOrders.has(key);
      const actions = isAdmin
        ? `<td class="row-actions"><button class="btn-danger sm" data-cancel='${esc(JSON.stringify({
            symbol: o.symbol,
            orderId: o.orderId,
          }))}'>Cancel</button></td>`
        : "";

      // Fill progress + flags as small badges under the type cell.
      const filled = Number(o.cumExecQty);
      const total = Number(o.qty);
      const fillSub =
        isFinite(filled) && isFinite(total) && total > 0 && filled > 0
          ? `<span class="cell-sub">${fmtNum(filled, 4)}/${fmtNum(total, 4)} filled</span>`
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
        ["Cum. exec qty", o.cumExecQty],
        ["Leaves qty", o.leavesQty],
        ["Created", fmtTime(o.createdTime)],
        ["Updated", fmtTime(o.updatedTime)],
      ]);

      return `<tr class="exp-row${expanded ? " expanded" : ""}" data-okey="${esc(key)}">
        <td class="mono card-head"><span class="caret">${expanded ? "▾" : "▸"}</span>${esc(o.symbol)}</td>
        <td data-label="Side" class="${(o.side || "").toLowerCase() === "buy" ? "pos" : "neg"}">${esc(o.side)}</td>
        <td data-label="Type">${esc(o.orderType)}${badges}</td>
        <td data-label="Qty" class="mono">${fmtNum(o.qty, 4)}${fillSub}</td>
        <td data-label="Price" class="mono">${o.price && Number(o.price) ? fmtNum(o.price, 4) : "—"}</td>
        <td data-label="Trigger" class="mono">${o.triggerPrice && Number(o.triggerPrice) ? fmtNum(o.triggerPrice, 4) : "—"}</td>
        <td data-label="Status">${esc(o.orderStatus)}</td>
        ${actions}
      </tr>
      <tr class="detail-row"${expanded ? "" : " hidden"}><td colspan="99">${detail}</td></tr>`;
    })
    .join("");
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

function renderDashboard(d) {
  renderSummary(d);
  renderPositions(d.positions);
  renderOrders(d.orders);
  renderErrors(d.errors);
}

// ---------------------------------------------------------------------------
// Action handlers (admin)
// ---------------------------------------------------------------------------
function ensureToken() {
  if (!state.tradeToken) {
    toast("Enter the trade token (Trade tab) to unlock trading.", "warn");
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
      const ok = await typedConfirm(
        `Close ${payload.symbol} position (size ${payload.qty}) with a market reduce-only order?`
      );
      if (!ok) return;
      closeBtn.disabled = true;
      try {
        await writeApi("/api/position/close", payload);
        toast(`✓ Close order sent for ${payload.symbol}`, "pos");
      } catch (err) {
        toast("Close failed: " + err.message, "neg");
      } finally {
        closeBtn.disabled = false;
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
      try {
        await writeApi("/api/order/cancel", payload);
        toast(`✓ Cancel sent for ${payload.symbol}`, "pos");
      } catch (err) {
        toast("Cancel failed: " + err.message, "neg");
      } finally {
        cancelBtn.disabled = false;
      }
    });
  }
});

// Expand/collapse a position or order row (ignore clicks on the action buttons).
document.addEventListener("click", (e) => {
  if (e.target.closest("button, a, input, select")) return;
  const posRow = e.target.closest("#positions-body tr.exp-row");
  if (posRow) {
    const key = posRow.dataset.pkey;
    state.expandedPos.has(key) ? state.expandedPos.delete(key) : state.expandedPos.add(key);
    renderPositions(state.lastPositions);
    return;
  }
  const ordRow = e.target.closest("#orders-body tr.exp-row");
  if (ordRow) {
    const key = ordRow.dataset.okey;
    state.expandedOrders.has(key) ? state.expandedOrders.delete(key) : state.expandedOrders.add(key);
    renderOrders(state.lastOrders);
  }
});

// Click a sortable column header to sort that table (toggles asc/desc).
document.addEventListener("click", (e) => {
  const th = e.target.closest("table.sortable thead th[data-sortkey]");
  if (!th) return;
  const table = th.closest("table");
  const st = table.id === "positions-table" ? state.sortPos : state.sortOrders;
  const key = th.dataset.sortkey;
  if (st.key === key) st.dir *= -1;
  else { st.key = key; st.dir = 1; }
  if (table.id === "positions-table") renderPositions(state.lastPositions);
  else renderOrders(state.lastOrders);
});

// ---------------------------------------------------------------------------
// TP/SL modal for an existing position (Full mode, market exit). The trade
// token is required; positionIdx is sent and re-verified server-side.
// ---------------------------------------------------------------------------
let _tpslOpen = false;
function openTpslModal(pos) {
  if (_tpslOpen) return;
  _tpslOpen = true;

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
    return `<div>${label} @ ${esc(price)}: ${projAmount(r, true)} ${esc(settleCoin())} <span class="muted">net of exit fee</span></div>`;
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
  $("#tpsl-context").textContent = `${pos.side} · entry ${fmtNum(pos.avgPrice, 4)} · mark ${fmtNum(pos.markPrice, 4)}`;
  tpInput.value = cur(pos.takeProfit);
  slInput.value = cur(pos.stopLoss);
  trigger.value = "LastPrice";
  out.textContent = "";
  out.className = "result-msg";
  overlay.hidden = false;
  updatePreview();
  tpInput.focus();

  const cleanup = () => {
    overlay.hidden = true;
    applyBtn.removeEventListener("click", onApply);
    cancelBtn.removeEventListener("click", onCancel);
    overlay.removeEventListener("click", onOverlay);
    document.removeEventListener("keydown", onKey);
    tpInput.removeEventListener("input", updatePreview);
    slInput.removeEventListener("input", updatePreview);
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
        out.textContent = "✓ TP/SL applied";
        out.className = "result-msg pos";
        toast(`✓ TP/SL applied for ${pos.symbol}`, "pos");
        setTimeout(cleanup, 800);
      } catch (err) {
        out.textContent = "✗ " + err.message;
        out.className = "result-msg neg";
      } finally {
        applyBtn.disabled = false;
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

  // Toggle the price field for limit orders.
  const orderType = $("#order-type");
  const limitField = document.querySelector(".limit-only");
  const syncLimit = () => {
    limitField.style.display = orderType.value === "Limit" ? "" : "none";
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
      if (!body.symbol || !body.qty) throw new Error("symbol and quantity are required");
      if (f.orderType.value === "Limit") {
        body.price = f.price.value.trim();
        if (!body.price) throw new Error("limit price is required for a Limit order");
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

      const priceTxt = body.price ? ` @ ${body.price}` : "";
      const tpslTxt =
        (body.takeProfit ? ` TP ${body.takeProfit}` : "") +
        (body.stopLoss ? ` SL ${body.stopLoss}` : "");
      return {
        path: "/api/order/create",
        body,
        confirmMsg: `Submit ${body.side} ${body.orderType} order: ${body.qty} ${body.symbol}${priceTxt}${body.reduceOnly ? " (reduce-only)" : ""}${tpslTxt}.`,
        successMsg: (res) => "✓ Order submitted" + (res.result?.orderId ? ` (${res.result.orderId})` : ""),
        onSuccess: () => {
          f.reset();
          // Re-sync segmented toggles + dependent UI to the reset select values.
          f.side.dispatchEvent(new Event("change", { bubbles: true }));
          f.orderType.dispatchEvent(new Event("change", { bubbles: true }));
          syncLimit();
          updateOrderPreview();
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
      if (t && t.lastPrice) state.orderLastPrice = { symbol, price: t.lastPrice };
    } catch (e) {
      /* preview simply won't render for market until a price is available */
    }
    updateOrderPreview();
  }

  function updateOrderPreview() {
    const symbol = orderForm.symbol.value.trim().toUpperCase();
    const side = orderForm.side.value;
    const qty = orderForm.qty.value.trim();
    const isLimit = orderForm.orderType.value === "Limit";
    const tp = orderForm.takeProfit.value.trim();
    const sl = orderForm.stopLoss.value.trim();
    let entry = "";
    let estimate = false;
    if (isLimit) {
      entry = orderForm.price.value.trim();
    } else if (state.orderLastPrice && state.orderLastPrice.symbol === symbol) {
      entry = state.orderLastPrice.price;
      estimate = true;
    }

    // Notional value hint (qty × price) so position size is obvious — shows
    // independently of TP/SL.
    if (orderNotional) {
      const notional = Number(qty) * Number(entry);
      orderNotional.textContent =
        Number(qty) > 0 && Number(entry) > 0
          ? `≈ ${fmtNum(notional)} ${settleCoin()} notional${estimate ? " (at market price)" : ""}`
          : "";
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
      return `<div>${label} @ ${esc(price)}: ${projAmount(r, false)} ${esc(settleCoin())} <span class="muted">${note}</span></div>`;
    };
    orderPreview.innerHTML = line("TP", tp) + line("SL", sl);
  }

  // A preview must never interfere with typing into the order form: any error
  // here is swallowed so it can't disrupt the (separate) submit handler.
  ["input", "change"].forEach((ev) =>
    orderForm.addEventListener(ev, (e) => {
      try {
        if (e.target.name === "symbol" || e.target.name === "orderType") {
          if (orderForm.orderType.value === "Market") {
            const sym = orderForm.symbol.value.trim().toUpperCase();
            clearTimeout(_lastPriceTimer);
            _lastPriceTimer = setTimeout(() => fetchMarketPrice(sym), 400);
          }
        }
        updateOrderPreview();
      } catch (err) {
        console.debug("order preview update failed", err);
      }
    })
  );

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
    // Keep the buttons in sync if the select is reset/changed programmatically
    // (e.g. f.reset() after a successful order).
    selectEl.addEventListener("change", paint);
    paint();
  };
  wireSegment("#seg-side", orderForm.side);
  wireSegment("#seg-type", orderForm.orderType);

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
      return {
        path: "/api/position/set-leverage",
        body,
        skipConfirm: true, // trade token still required; no typed-confirm for leverage
        successMsg: () => `✓ Leverage set for ${body.symbol}`,
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
      if (!(amount > 0)) throw new Error("amount must be greater than 0");
      const body = {
        direction: f.direction.value,
        amount,
        quote_asset: f.quote_asset.value,
      };
      return {
        path: "/api/funds/transfer",
        body,
        confirmMsg: `Transfer ${body.amount} ${body.quote_asset} (${body.direction}). This moves real funds.`,
        successMsg: () => "✓ Transfer request submitted — verify your balance to confirm it completed",
        onSuccess: () => f.reset(),
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
function listOf(data) {
  const r = data && data.result;
  if (r && Array.isArray(r.list)) return r.list;
  if (Array.isArray(r)) return r;
  return [];
}
// Build a table. columns: [{label, get:(row)=>value, cls?:(row)=>className}]
function buildTable(rows, columns) {
  const head = columns.map((c) => `<th>${esc(c.label)}</th>`).join("");
  const body = rows
    .map(
      (r) =>
        "<tr>" +
        columns
          .map((c) => {
            const extra = c.cls ? " " + c.cls(r) : "";
            return `<td class="mono${extra}">${esc(cell(c.get(r)))}</td>`;
          })
          .join("") +
        "</tr>"
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
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
  const summary = buildKV(acct, [
    { label: "Account Type", key: "accountType" },
    { label: "Total Equity", key: "totalEquity" },
    { label: "Wallet Balance", key: "totalWalletBalance" },
    { label: "Available Balance", key: "totalAvailableBalance" },
    { label: "Margin Balance", key: "totalMarginBalance" },
    { label: "Unrealised PnL", key: "totalPerpUPL" },
    { label: "Initial Margin", key: "totalInitialMargin" },
    { label: "Maint. Margin", key: "totalMaintenanceMargin" },
  ]);
  const coins = acct.coin || [];
  const coinTable = coins.length
    ? buildTable(coins, [
        { label: "Coin", get: (c) => c.coin },
        { label: "Equity", get: (c) => c.equity },
        { label: "Wallet Bal", get: (c) => c.walletBalance },
        { label: "Available", get: (c) => c.availableToWithdraw ?? c.availableToBorrow },
        { label: "Unreal PnL", get: (c) => c.unrealisedPnl, cls: (c) => pnlClass(c.unrealisedPnl) },
        { label: "Realised PnL", get: (c) => c.cumRealisedPnl, cls: (c) => pnlClass(c.cumRealisedPnl) },
        { label: "USD Value", get: (c) => c.usdValue },
      ])
    : "";
  return summary + coinTable;
}

function renderAccountInfo(data) {
  return data && data.result ? buildKV(data.result) : autoRender(data);
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

function renderClosedPnl(data) {
  const list = listOf(data);
  if (!list.length) return emptyMsg("No closed PnL records");
  const total = list.reduce((s, r) => s + (Number(r.closedPnl) || 0), 0);
  const table = buildTable(list, [
    { label: "Closed At", get: (r) => fmtTime(r.updatedTime ?? r.createdTime) },
    { label: "Symbol", get: (r) => r.symbol },
    { label: "Side", get: (r) => r.side, cls: (r) => sideClass(r.side) },
    { label: "Qty", get: (r) => r.qty ?? r.closedSize },
    { label: "Entry", get: (r) => r.avgEntryPrice },
    { label: "Exit", get: (r) => r.avgExitPrice },
    { label: "Closed PnL", get: (r) => r.closedPnl, cls: (r) => pnlClass(r.closedPnl) },
    { label: "Leverage", get: (r) => r.leverage },
  ]);
  return (
    `<div class="explorer-summary">Total closed PnL: <span class="${pnlClass(total)}">${fmtNum(total)}</span> · ${list.length} record(s)</div>` +
    table
  );
}

function renderExecutions(data) {
  const list = listOf(data);
  if (!list.length) return emptyMsg("No trades");
  return buildTable(list, [
    { label: "Time", get: (r) => fmtTime(r.execTime) },
    { label: "Symbol", get: (r) => r.symbol },
    { label: "Side", get: (r) => r.side, cls: (r) => sideClass(r.side) },
    { label: "Type", get: (r) => r.orderType },
    { label: "Exec Qty", get: (r) => r.execQty },
    { label: "Exec Price", get: (r) => r.execPrice },
    { label: "Exec Value", get: (r) => r.execValue },
    { label: "Fee", get: (r) => r.execFee },
    { label: "Maker", get: (r) => r.isMaker },
  ]);
}

function renderTickers(data) {
  const list = listOf(data);
  if (!list.length) return emptyMsg("No tickers");
  return buildTable(list, [
    { label: "Symbol", get: (t) => t.symbol },
    { label: "Last", get: (t) => t.lastPrice },
    { label: "Mark", get: (t) => t.markPrice },
    { label: "Index", get: (t) => t.indexPrice },
    { label: "24h %", get: (t) => pct(t.price24hPcnt), cls: (t) => pnlClass(t.price24hPcnt) },
    { label: "24h High", get: (t) => t.highPrice24h },
    { label: "24h Low", get: (t) => t.lowPrice24h },
    { label: "Bid", get: (t) => t.bid1Price },
    { label: "Ask", get: (t) => t.ask1Price },
    { label: "Funding", get: (t) => t.fundingRate },
    { label: "Open Int", get: (t) => t.openInterest },
  ]);
}

function renderOrderBook(data) {
  const r = (data && data.result) || {};
  const bids = r.b || [];
  const asks = r.a || [];
  const n = Math.max(bids.length, asks.length);
  if (!n) return autoRender(data);
  // Fall back to the generic renderer if the rows aren't [price, size] pairs.
  if (!bids.every(Array.isArray) || !asks.every(Array.isArray)) return autoRender(data);
  let body = "";
  for (let i = 0; i < n; i++) {
    const b = bids[i] || ["", ""];
    const a = asks[i] || ["", ""];
    body += `<tr><td class="mono pos">${esc(cell(b[1]))}</td><td class="mono pos">${esc(cell(b[0]))}</td><td class="mono neg">${esc(cell(a[0]))}</td><td class="mono neg">${esc(cell(a[1]))}</td></tr>`;
  }
  return (
    `<div class="explorer-summary">${esc(cell(r.s))} — order book</div>` +
    `<div class="table-wrap"><table><thead><tr><th>Bid Size</th><th>Bid Price</th><th>Ask Price</th><th>Ask Size</th></tr></thead><tbody>${body}</tbody></table></div>`
  );
}

function renderPositionsTable(data) {
  const list = listOf(data).filter((p) => Number(p.size) !== 0);
  if (!list.length) return emptyMsg("No open positions");
  return buildTable(list, [
    { label: "Symbol", get: (p) => p.symbol },
    { label: "Side", get: (p) => p.side, cls: (p) => sideClass(p.side) },
    { label: "Size", get: (p) => p.size },
    { label: "Entry", get: (p) => p.avgPrice },
    { label: "Mark", get: (p) => p.markPrice },
    { label: "Lev", get: (p) => (p.leverage ? p.leverage + "x" : "—") },
    { label: "Value", get: (p) => p.positionValue },
    { label: "Unreal PnL", get: (p) => p.unrealisedPnl, cls: (p) => pnlClass(p.unrealisedPnl) },
  ]);
}

function renderOrdersTable(data) {
  const list = listOf(data);
  if (!list.length) return emptyMsg("No open orders");
  return buildTable(list, [
    { label: "Symbol", get: (o) => o.symbol },
    { label: "Side", get: (o) => o.side, cls: (o) => sideClass(o.side) },
    { label: "Type", get: (o) => o.orderType },
    { label: "Qty", get: (o) => o.qty },
    { label: "Price", get: (o) => o.price },
    { label: "Trigger", get: (o) => o.triggerPrice },
    { label: "Status", get: (o) => o.orderStatus },
  ]);
}

const EXPLORER_QUERIES = [
  { label: "Wallet Balance", path: "/api/balance", render: renderWallet },
  { label: "Withdrawable", path: "/api/withdrawable", render: autoRender },
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
        out.innerHTML = `<p class="neg" style="padding:14px">"${esc(q.label)}" requires a symbol.</p>`;
        return;
      }
      let url = q.path;
      if (q.sym && symbol) url += `?symbol=${encodeURIComponent(symbol)}`;
      out.innerHTML = `<p class="muted" style="padding:14px">Loading ${esc(q.label)}…</p>`;
      try {
        const data = await api(url);
        const formatted = (q.render || autoRender)(data);
        const raw = `<details class="raw-json"><summary>Raw JSON</summary><pre class="json-view">${esc(
          JSON.stringify(data, null, 2)
        )}</pre></details>`;
        out.innerHTML = formatted + raw;
      } catch (err) {
        out.innerHTML = `<p class="neg" style="padding:14px">Error: ${esc(err.message)}</p>`;
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
  const show = (name) => {
    tabs.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    panes.forEach((p) => { p.hidden = p.dataset.pane !== name; });
    if (name !== "markets") clearInterval(_marketsTimer); // stop polling when away
    if (name === "markets") onMarketsActive();
    if (name === "history") onHistoryActive();
  };
  tabs.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
}

let _marketsData = null;
let _marketsTimer = null;
async function fetchMarkets() {
  const body = document.getElementById("markets-body");
  try {
    _marketsData = await api("/api/tickers");
    renderMarkets();
  } catch (e) {
    if (body) body.innerHTML = `<p class="neg" style="padding:14px">Error: ${esc(e.message)}</p>`;
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
    { label: "Last", get: (t) => t.lastPrice },
    { label: "Mark", get: (t) => t.markPrice },
    { label: "24h %", get: (t) => pct(t.price24hPcnt), cls: (t) => pnlClass(t.price24hPcnt) },
    { label: "24h High", get: (t) => t.highPrice24h },
    { label: "24h Low", get: (t) => t.lowPrice24h },
    { label: "Funding", get: (t) => t.fundingRate },
    { label: "Open Int", get: (t) => t.openInterest },
    { label: "Turnover 24h", get: (t) => t.turnover24h },
  ]) + (list.length > 200 ? `<p class="muted" style="padding:8px 16px">Showing top 200 by turnover. Filter to narrow.</p>` : "");
}
function onMarketsActive() {
  if (!_marketsData) fetchMarkets();
  clearInterval(_marketsTimer);
  _marketsTimer = setInterval(() => {
    const pane = document.querySelector('[data-pane="markets"]');
    if (pane && !pane.hidden) fetchMarkets();
    else clearInterval(_marketsTimer);
  }, 15000);
}

let _historyLoaded = false;
async function fetchHistory() {
  const filter = (document.getElementById("history-filter").value || "").trim().toUpperCase();
  const symParam = filter ? `?symbol=${encodeURIComponent(filter)}` : "";
  const closedEl = document.getElementById("history-closed");
  const execEl = document.getElementById("history-exec");
  const sumEl = document.getElementById("history-summary");
  closedEl.innerHTML = `<p class="muted" style="padding:14px">Loading…</p>`;
  try {
    const closed = await api("/api/closed-pnl" + symParam);
    const list = listOf(closed);
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const todayMs = startOfDay.getTime();
    let total = 0, today = 0, wins = 0;
    list.forEach((r) => {
      const v = Number(r.closedPnl) || 0;
      total += v;
      if (v > 0) wins++;
      const t = Number(r.updatedTime ?? r.createdTime);
      if (isFinite(t) && t >= todayMs) today += v;
    });
    sumEl.hidden = false;
    sumEl.innerHTML =
      `Realized today: <span class="${pnlClass(today)}">${fmtNum(today)} ${esc(settleCoin())}</span> · ` +
      `Total (recent ${list.length}): <span class="${pnlClass(total)}">${fmtNum(total)}</span> · ` +
      `Win rate: ${list.length ? Math.round((wins / list.length) * 100) : 0}%`;
    closedEl.innerHTML = renderClosedPnl(closed);
  } catch (e) {
    sumEl.hidden = true;
    closedEl.innerHTML = `<p class="neg" style="padding:14px">Error: ${esc(e.message)}</p>`;
  }
  try {
    const exec = await api("/api/executions" + symParam);
    execEl.innerHTML = renderExecutions(exec);
  } catch (e) {
    execEl.innerHTML = `<p class="neg" style="padding:14px">Error: ${esc(e.message)}</p>`;
  }
}
function onHistoryActive() {
  if (!_historyLoaded) { _historyLoaded = true; fetchHistory(); }
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
}

// ---------------------------------------------------------------------------
// Live WebSocket feed (with auto-reconnect)
// ---------------------------------------------------------------------------
function setConn(stateName) {
  const el = $("#conn-status");
  const map = {
    live: ["live", "conn-on"],
    stale: ["stale — check data", "conn-stale"],
    off: ["reconnecting…", "conn-off"],
  };
  const [text, cls] = map[stateName] || map.off;
  el.textContent = text;
  el.className = "conn " + cls;
}

function connectWS() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
  let opened = false;

  ws.onopen = () => {
    opened = true;
    setConn("live");
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
      // If any upstream call failed this cycle, the tables may be incomplete
      // or stale — never present that as fully "live".
      const degraded = msg.errors && Object.keys(msg.errors).length > 0;
      setConn(degraded ? "stale" : "live");
    } else if (msg.type === "error") {
      // Whole refresh failed: keep last rows but flag clearly as stale.
      setConn("stale");
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
    setConn("off");
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
  renderLoading(); // skeleton rows until the first snapshot lands
  // Render an immediate snapshot, then rely on the WS for live updates.
  try {
    const d = await api("/api/dashboard");
    renderDashboard(d);
  } catch (e) {}
  connectWS();
})();
