"use strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const settleCoin = () => state.settleCoin || "USDT";
// tradeToken is held ONLY in memory for this tab — never persisted.
const state = { role: null, settleCoin: "USDT", tradeToken: "", writeInFlight: false };

// Global single-flight lock for ALL write actions. The live tables are rebuilt
// via innerHTML every few seconds, which destroys the button nodes a per-button
// `disabled` flag lives on — so that flag alone can't prevent a duplicate
// close/cancel across a re-render. This lock spans the whole click→confirm→send
// lifecycle, so only one write can ever be in progress at a time.
async function withWriteLock(fn) {
  if (state.writeInFlight) {
    alert("Another trading action is in progress — please wait for it to finish.");
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

  const pnlEl = $("#stat-pnl");
  pnlEl.textContent = `${fmtNum(summary.totalUnrealisedPnl)} ${settleCoin()}`;
  pnlEl.className = "stat-value " + pnlClass(summary.totalUnrealisedPnl);

  $("#stat-positions").textContent = summary.openPositions ?? "—";
  $("#stat-orders").textContent = summary.openOrders ?? "—";

  // Wallet equity (Bybit-style nested structure). Be defensive: never show a
  // wrong number — fall back to the settle-coin entry, else show "—".
  let equity = "—";
  try {
    const list = d.balance?.result?.list || [];
    for (const acct of list) {
      const top = acct.totalEquity ?? acct.totalWalletBalance;
      if (top !== undefined && top !== "" && isFinite(Number(top))) {
        equity = `${fmtNum(top)} ${settleCoin()}`;
        break;
      }
      const coin = (acct.coin || []).find((c) => c.coin === settleCoin());
      const ceq = coin?.equity ?? coin?.walletBalance;
      if (ceq !== undefined && ceq !== "" && isFinite(Number(ceq))) {
        equity = `${fmtNum(ceq)} ${settleCoin()}`;
        break;
      }
    }
  } catch (e) {
    console.debug("equity parse failed", e);
  }
  $("#stat-equity").textContent = equity;
}

function renderPositions(positions) {
  const body = $("#positions-body");
  const rows = (positions || []).filter((p) => Number(p.size) !== 0);
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="11" class="muted center">No open positions</td></tr>`;
    return;
  }
  const isAdmin = state.role === "admin";
  const hasVal = (v) => v !== undefined && v !== null && v !== "" && Number(v) !== 0;
  body.innerHTML = rows
    .map((p) => {
      const pnl = p.unrealisedPnl;
      const actions = isAdmin
        ? `<td class="row-actions">
            <button class="btn-ghost sm" data-tpsl='${esc(JSON.stringify({
              symbol: p.symbol,
              positionIdx: p.positionIdx ?? 0,
              side: p.side,
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
      return `<tr>
        <td class="mono">${esc(p.symbol)}</td>
        <td class="${(p.side || "").toLowerCase() === "buy" ? "pos" : "neg"}">${esc(p.side)}</td>
        <td class="mono">${fmtNum(p.size, 4)}</td>
        <td class="mono">${fmtNum(p.avgPrice, 4)}</td>
        <td class="mono">${fmtNum(p.markPrice, 4)}</td>
        <td class="mono">${esc(p.leverage ?? "—")}x</td>
        <td class="mono">${fmtNum(p.positionValue)}</td>
        <td class="mono ${pnlClass(pnl)}">${fmtNum(pnl)}</td>
        <td class="mono pos">${hasVal(p.takeProfit) ? fmtNum(p.takeProfit, 4) : "—"}</td>
        <td class="mono neg">${hasVal(p.stopLoss) ? fmtNum(p.stopLoss, 4) : "—"}</td>
        ${actions}
      </tr>`;
    })
    .join("");
}

function renderOrders(orders) {
  const body = $("#orders-body");
  const rows = orders || [];
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted center">No open orders</td></tr>`;
    return;
  }
  const isAdmin = state.role === "admin";
  body.innerHTML = rows
    .map((o) => {
      const actions = isAdmin
        ? `<td><button class="btn-danger sm" data-cancel='${esc(JSON.stringify({
            symbol: o.symbol,
            orderId: o.orderId,
          }))}'>Cancel</button></td>`
        : "";
      return `<tr>
        <td class="mono">${esc(o.symbol)}</td>
        <td class="${(o.side || "").toLowerCase() === "buy" ? "pos" : "neg"}">${esc(o.side)}</td>
        <td>${esc(o.orderType)}</td>
        <td class="mono">${fmtNum(o.qty, 4)}</td>
        <td class="mono">${o.price && Number(o.price) ? fmtNum(o.price, 4) : "—"}</td>
        <td class="mono">${o.triggerPrice && Number(o.triggerPrice) ? fmtNum(o.triggerPrice, 4) : "—"}</td>
        <td>${esc(o.orderStatus)}</td>
        ${actions}
      </tr>`;
    })
    .join("");
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
    alert("Enter the trade token (top of the admin panel) to unlock trading.");
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
    alert("Could not read position/order data — please refresh and retry.");
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
      } catch (err) {
        alert("Close failed: " + err.message);
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
      } catch (err) {
        alert("Cancel failed: " + err.message);
      } finally {
        cancelBtn.disabled = false;
      }
    });
  }
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
  const applyBtn = $("#tpsl-apply");
  const cancelBtn = $("#tpsl-cancel");

  const cur = (v) =>
    v !== undefined && v !== null && v !== "" && Number(v) !== 0 ? String(v) : "";

  $("#tpsl-title").textContent = `Set TP / SL — ${pos.symbol}`;
  $("#tpsl-context").textContent = `${pos.side} · entry ${fmtNum(pos.avgPrice, 4)} · mark ${fmtNum(pos.markPrice, 4)}`;
  tpInput.value = cur(pos.takeProfit);
  slInput.value = cur(pos.stopLoss);
  trigger.value = "LastPrice";
  out.textContent = "";
  out.className = "result-msg";
  overlay.hidden = false;
  tpInput.focus();

  const cleanup = () => {
    overlay.hidden = true;
    applyBtn.removeEventListener("click", onApply);
    cancelBtn.removeEventListener("click", onCancel);
    overlay.removeEventListener("click", onOverlay);
    document.removeEventListener("keydown", onKey);
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
      if (out) { out.textContent = spec.successMsg(res); out.classList.add("pos"); }
      if (spec.onSuccess) spec.onSuccess();
    } catch (err) {
      if (out) { out.textContent = "✗ " + err.message; out.classList.add("neg"); }
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = prevLabel; }
    }
  });
}

function wireTradeToken() {
  const field = $("#trade-token");
  const status = $("#token-status");
  if (!field) return;
  const sync = () => {
    state.tradeToken = field.value.trim();
    if (state.tradeToken) {
      status.textContent = "READY";
      status.className = "token-status ready";
    } else {
      status.textContent = "LOCKED";
      status.className = "token-status locked";
    }
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
        onSuccess: () => { f.reset(); syncLimit(); },
      };
    });
  });

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
        successMsg: () => "",
      })).catch((err) => alert("Cancel-all failed: " + err.message));
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

  ws.onopen = () => setConn("live");
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
  ws.onclose = () => {
    setConn("off");
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
  // Render an immediate snapshot, then rely on the WS for live updates.
  try {
    const d = await api("/api/dashboard");
    renderDashboard(d);
  } catch (e) {}
  connectWS();
})();
