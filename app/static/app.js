"use strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const settleCoin = () => state.settleCoin || "USDT";
const state = { role: null, settleCoin: "USDT" };

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

  // Wallet equity (Bybit-style nested structure, best-effort).
  let equity = "—";
  try {
    const list = d.balance?.result?.list || [];
    if (list.length) {
      const acct = list[0];
      const eq = acct.totalEquity ?? acct.totalWalletBalance;
      if (eq !== undefined) equity = `${fmtNum(eq)} ${settleCoin()}`;
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
        <td class="mono">${p.symbol ?? ""}</td>
        <td class="${(p.side || "").toLowerCase() === "buy" ? "pos" : "neg"}">${p.side ?? ""}</td>
        <td class="mono">${fmtNum(p.size, 4)}</td>
        <td class="mono">${fmtNum(p.avgPrice, 4)}</td>
        <td class="mono">${fmtNum(p.markPrice, 4)}</td>
        <td class="mono">${p.leverage ?? "—"}x</td>
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
        <td class="mono">${o.symbol ?? ""}</td>
        <td class="${(o.side || "").toLowerCase() === "buy" ? "pos" : "neg"}">${o.side ?? ""}</td>
        <td>${o.orderType ?? ""}</td>
        <td class="mono">${fmtNum(o.qty, 4)}</td>
        <td class="mono">${o.price && Number(o.price) ? fmtNum(o.price, 4) : "—"}</td>
        <td class="mono">${o.triggerPrice && Number(o.triggerPrice) ? fmtNum(o.triggerPrice, 4) : "—"}</td>
        <td>${o.orderStatus ?? ""}</td>
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
document.addEventListener("click", async (e) => {
  const closeBtn = e.target.closest("[data-close]");
  if (closeBtn) {
    const payload = JSON.parse(closeBtn.getAttribute("data-close"));
    if (!confirm(`Close ${payload.symbol} position (${payload.qty})?`)) return;
    closeBtn.disabled = true;
    try {
      await api("/api/position/close", { method: "POST", body: JSON.stringify(payload) });
    } catch (err) {
      alert("Close failed: " + err.message);
    } finally {
      closeBtn.disabled = false;
    }
    return;
  }

  const cancelBtn = e.target.closest("[data-cancel]");
  if (cancelBtn) {
    const payload = JSON.parse(cancelBtn.getAttribute("data-cancel"));
    if (!confirm(`Cancel order ${payload.orderId}?`)) return;
    cancelBtn.disabled = true;
    try {
      await api("/api/order/cancel", { method: "POST", body: JSON.stringify(payload) });
    } catch (err) {
      alert("Cancel failed: " + err.message);
    } finally {
      cancelBtn.disabled = false;
    }
  }
});

function wireAdminForms() {
  if (state.role !== "admin") return;

  // Toggle the price field for limit orders.
  const orderType = $("#order-type");
  const limitField = document.querySelector(".limit-only");
  const syncLimit = () => {
    limitField.style.display = orderType.value === "Limit" ? "" : "none";
  };
  orderType.addEventListener("change", syncLimit);
  syncLimit();

  $("#order-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const out = $("#order-result");
    out.textContent = "";
    out.className = "result-msg";
    const body = {
      symbol: f.symbol.value.trim().toUpperCase(),
      side: f.side.value,
      orderType: f.orderType.value,
      qty: f.qty.value.trim(),
      positionIdx: 0,
    };
    if (f.orderType.value === "Limit") body.price = f.price.value.trim();
    if (f.reduceOnly.checked) body.reduceOnly = true;

    if (!confirm(`Submit ${body.side} ${body.orderType} ${body.qty} ${body.symbol}?`)) return;
    try {
      const res = await api("/api/order/create", { method: "POST", body: JSON.stringify(body) });
      out.textContent = "✓ Order submitted" + (res.result?.orderId ? ` (${res.result.orderId})` : "");
      out.classList.add("pos");
      f.reset();
      syncLimit();
    } catch (err) {
      out.textContent = "✗ " + err.message;
      out.classList.add("neg");
    }
  });

  $("#leverage-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const out = $("#leverage-result");
    out.textContent = "";
    out.className = "result-msg";
    const body = {
      symbol: f.symbol.value.trim().toUpperCase(),
      buyLeverage: f.buyLeverage.value.trim(),
      sellLeverage: f.sellLeverage.value.trim(),
    };
    try {
      await api("/api/position/set-leverage", { method: "POST", body: JSON.stringify(body) });
      out.textContent = `✓ Leverage set for ${body.symbol}`;
      out.classList.add("pos");
    } catch (err) {
      out.textContent = "✗ " + err.message;
      out.classList.add("neg");
    }
  });

  const cancelAll = $("#cancel-all-btn");
  if (cancelAll) {
    cancelAll.addEventListener("click", async () => {
      if (!confirm("Cancel ALL open orders?")) return;
      try {
        await api("/api/order/cancel-all", { method: "POST", body: JSON.stringify({}) });
      } catch (err) {
        alert("Cancel-all failed: " + err.message);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Live WebSocket feed (with auto-reconnect)
// ---------------------------------------------------------------------------
function setConn(connected) {
  const el = $("#conn-status");
  el.textContent = connected ? "live" : "reconnecting…";
  el.className = "conn " + (connected ? "conn-on" : "conn-off");
}

function connectWS() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${window.location.host}/ws`);

  ws.onopen = () => setConn(true);
  ws.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (e) {
      return;
    }
    if (msg.type === "dashboard") {
      renderDashboard(msg);
    } else if (msg.type === "error") {
      const label = $("#positions-updated");
      label.textContent = "⚠ " + msg.error;
      label.classList.add("neg");
    }
  };
  ws.onclose = () => {
    setConn(false);
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
  // Render an immediate snapshot, then rely on the WS for live updates.
  try {
    const d = await api("/api/dashboard");
    renderDashboard(d);
  } catch (e) {}
  connectWS();
})();
