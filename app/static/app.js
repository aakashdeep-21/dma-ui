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
  } catch (e) {}
  $("#stat-equity").textContent = equity;
}

function renderPositions(positions) {
  const body = $("#positions-body");
  const rows = (positions || []).filter((p) => Number(p.size) !== 0);
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" class="muted center">No open positions</td></tr>`;
    return;
  }
  const isAdmin = state.role === "admin";
  body.innerHTML = rows
    .map((p) => {
      const pnl = p.unrealisedPnl;
      const actions = isAdmin
        ? `<td><button class="btn-danger sm" data-close='${JSON.stringify({
            symbol: p.symbol,
            side: p.side,
            qty: p.size,
            positionIdx: p.positionIdx ?? 0,
          }).replace(/'/g, "&#39;")}'>Close</button></td>`
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
        ? `<td><button class="btn-danger sm" data-cancel='${JSON.stringify({
            symbol: o.symbol,
            orderId: o.orderId,
          }).replace(/'/g, "&#39;")}'>Cancel</button></td>`
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

document.addEventListener("click", async (e) => {
  const closeBtn = e.target.closest("[data-close]");
  if (closeBtn) {
    const payload = JSON.parse(closeBtn.getAttribute("data-close"));
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
    const payload = JSON.parse(cancelBtn.getAttribute("data-cancel"));
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

// Run a token-gated, typed-confirmed write while disabling its submit button.
// `gather` returns {body, confirmMsg, successMsg} or null to abort.
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
    const ok = await typedConfirm(spec.confirmMsg);
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
      const priceTxt = body.price ? ` @ ${body.price}` : "";
      return {
        path: "/api/order/create",
        body,
        confirmMsg: `Submit ${body.side} ${body.orderType} order: ${body.qty} ${body.symbol}${priceTxt}${body.reduceOnly ? " (reduce-only)" : ""}.`,
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
        confirmMsg: `Set ${body.symbol} leverage to buy ${body.buyLeverage}x / sell ${body.sellLeverage}x.`,
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
        successMsg: () => "✓ Transfer submitted",
        onSuccess: () => f.reset(),
      };
    });
  });
}

// ---------------------------------------------------------------------------
// API Explorer (read-only queries, available to any logged-in user)
// ---------------------------------------------------------------------------
const EXPLORER_QUERIES = [
  { label: "Wallet Balance", path: "/api/balance" },
  { label: "Fiat Balance", path: "/api/fiat-balance" },
  { label: "Withdrawable", path: "/api/withdrawable" },
  { label: "Account Info", path: "/api/account-info" },
  { label: "Server Time", path: "/api/server-time" },
  { label: "Positions", path: "/api/positions" },
  { label: "Open Orders", path: "/api/orders" },
  { label: "Instruments", path: "/api/instruments", sym: true },
  { label: "Risk Limit", path: "/api/risk-limit", sym: true, symRequired: true },
  { label: "Closed PnL", path: "/api/closed-pnl", sym: true },
  { label: "Trades History", path: "/api/executions", sym: true },
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
        out.textContent = `"${q.label}" requires a symbol.`;
        out.className = "json-view neg";
        return;
      }
      let url = q.path;
      if (q.sym && symbol) url += `?symbol=${encodeURIComponent(symbol)}`;
      out.textContent = `Loading ${q.label}…`;
      out.className = "json-view";
      try {
        const data = await api(url);
        out.textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        out.textContent = "Error: " + err.message;
        out.className = "json-view neg";
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
