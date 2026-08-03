"use strict";
/* ===========================================================================
   EXECUTION WORKSPACE — professional trading ladder, previews, quick actions,
   position/order intelligence for the Trade tab.

   Architecture (same contract as charts.js / risk.js / journal.js / ai.js):
     * Loaded BEFORE app.js; defines only — no DOM/network/storage at load.
       app.js boots it (wireExec) and feeds it the surfaces it already owns:
       the order-book poll (exLadderIngest), every dashboard snapshot
       (exIngest), and the ticket's input events (exPreviewTick).
     * Pure, DOM-free core first (ladder building, grouping, order lifecycle,
       execution stats, break-even/preview math, view-state sanitizer) so
       tests/test_snap.mjs can extract and regression-test the math.
     * SAFETY IS INHERITED, NEVER REIMPLEMENTED: every action this module
       exposes (quick closes, cancel-all, break-even stop, ladder-to-ticket)
       funnels into the EXISTING app.js flows — the same typed confirmations,
       the same writeApi/trade-token transport, the same server-side
       revalidation. Nothing here talks to a write endpoint directly, and no
       keyboard path can skip a confirmation.
     * Data honesty: previews are labelled estimates (fees assume the worst
       rate, the liquidation preview excludes maintenance margin, break-even
       assumes taker both ways); numbers we cannot compute are "—", never 0.
     * Performance: the ladder repaints only rows whose content changed, and
       the whole rebuild is O(levels) per book poll.
   =========================================================================== */

// ---------------------------------------------------------------------------
// 1. Pure core (one-line consts + column-0 functions — snap-harness contract)
// ---------------------------------------------------------------------------
const EX_GROUPINGS = ["1", "2", "5", "10", "25", "50"];
const EX_ROWS_OPTIONS = ["8", "12", "16", "24"];
const EX_ORDER_SORTS = ["time", "symbol", "price", "filled"];
const EX_ORDER_SIDES = ["all", "Buy", "Sell"];
const EX_STATUS_LABELS = { New: "Working", PartiallyFilled: "Partial", Untriggered: "Untriggered", Filled: "Filled", Cancelled: "Cancelled", Rejected: "Rejected", Deactivated: "Deactivated", Expired: "Expired" };

// Coerce ANY value into a valid execution-workspace view state (the workspace
// persistence trust boundary — unknown fields dropped, invalid defaulted).
function exSanitizeViewState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const ord = src.orders && typeof src.orders === "object" ? src.orders : {};
  return {
    grouping: EX_GROUPINGS.includes(src.grouping) ? src.grouping : "1",
    rows: EX_ROWS_OPTIONS.includes(src.rows) ? src.rows : "12",
    follow: src.follow !== false, // default: auto-follow the market
    orders: {
      side: EX_ORDER_SIDES.includes(ord.side) ? ord.side : "all",
      search: typeof ord.search === "string" ? ord.search.slice(0, 40) : "",
      sort: EX_ORDER_SORTS.includes(ord.sort) ? ord.sort : "time",
      dir: ord.dir === "asc" ? "asc" : "desc",
    },
  };
}

// Snap a raw price onto a grouping bucket. Bids round DOWN and asks round UP
// so grouped levels can never cross the spread. `step` is tick × multiplier.
function exBucket(price, step, isBid) {
  if (!(step > 0)) return price;
  const buckets = price / step;
  const snapped = isBid ? Math.floor(buckets + 1e-9) : Math.ceil(buckets - 1e-9);
  // Reconstruct at fixed precision: step is derived from the tick string, so
  // its decimals bound the result's decimals (float drift must not mint
  // 100.10000000001 rows that break row-diffing).
  return Number((snapped * step).toFixed(10));
}

// Build the ladder model from a Bybit-v5 orderbook envelope
// ({result:{b:[["price","size"],…], a:[…]}}), already sorted best-first by
// the venue. Options: tick (instrument tick size), grouping (multiplier
// string from EX_GROUPINGS), rows (levels per side to keep), last, mark.
// Returns rows ordered for display: asks worst→best (top→middle), then bids
// best→worst (middle→bottom), plus spread metadata and bar scales.
function exBuildLadder(book, opts) {
  const o = opts || {};
  const res = (book && book.result) || {};
  const step = (Number(o.tick) > 0 ? Number(o.tick) : 0) * (Number(o.grouping) || 1);
  const rows = Math.max(1, Number(o.rows) || 12);

  function sideLevels(levels, isBid) {
    const acc = new Map(); // insertion order = best→worst (venue sorted)
    for (const lvl of levels || []) {
      const price = Number(lvl && lvl[0]);
      const size = Number(lvl && lvl[1]);
      if (!isFinite(price) || !isFinite(size) || size <= 0) continue;
      const key = step > 0 ? exBucket(price, step, isBid) : price;
      acc.set(key, (acc.get(key) || 0) + size);
    }
    let cum = 0;
    const out = [];
    for (const [price, size] of acc) {
      if (out.length >= rows) break;
      cum += size;
      out.push({ price, size, cum });
    }
    return out;
  }

  const bids = sideLevels(res.b, true);
  const asks = sideLevels(res.a, false);
  const bestBid = bids.length ? bids[0].price : null;
  const bestAsk = asks.length ? asks[0].price : null;
  const maxSize = Math.max(1e-12, ...bids.map((r) => r.size), ...asks.map((r) => r.size));
  const maxCum = Math.max(1e-12, ...bids.map((r) => r.cum), ...asks.map((r) => r.cum));
  for (const r of bids) { r.sizePct = r.size / maxSize * 100; r.cumPct = r.cum / maxCum * 100; }
  for (const r of asks) { r.sizePct = r.size / maxSize * 100; r.cumPct = r.cum / maxCum * 100; }

  const spread = bestBid != null && bestAsk != null ? Number((bestAsk - bestBid).toFixed(10)) : null;
  const mid = bestBid != null && bestAsk != null ? (bestAsk + bestBid) / 2 : null;
  return {
    asks: asks.slice().reverse(), // display: worst ask on top, best at spread
    bids,                          // display: best bid under spread
    bestBid, bestAsk, spread,
    spreadPct: spread != null && mid ? spread / mid * 100 : null,
    last: isFinite(Number(o.last)) ? Number(o.last) : null,
    mark: isFinite(Number(o.mark)) ? Number(o.mark) : null,
    totalBid: bids.length ? bids[bids.length - 1].cum : 0,
    totalAsk: asks.length ? asks[asks.length - 1].cum : 0,
  };
}

// Order lifecycle from what the venue actually exposes: the open-order row
// (created/updated/status/fill counters) + the executions mirror's fills for
// that orderId. Events are honest — no synthesized "submitted/accepted"
// stages the gateway never reports.
function exOrderTimeline(order, fills) {
  const events = [];
  const created = Number(order && order.createdTime);
  if (isFinite(created) && created > 0) {
    events.push({ tsMs: created, kind: "created", label: "Created" });
  }
  const mine = (fills || [])
    .filter((f) => f && f.orderId === order.orderId && Number(f.execQty) > 0
      && String(f.execType || "Trade") === "Trade")
    .sort((a, b) => Number(a.execTime) - Number(b.execTime));
  for (const f of mine) {
    events.push({
      tsMs: Number(f.execTime), kind: "fill",
      label: `Filled ${f.execQty} @ ${f.execPrice}`,
      qty: Number(f.execQty), price: Number(f.execPrice),
      maker: f.isMaker === true || f.isMaker === "true",
    });
  }
  const status = String(order && order.orderStatus || "");
  const updated = Number(order && order.updatedTime);
  if (status && status !== "New" && isFinite(updated) && updated > 0) {
    events.push({
      tsMs: updated, kind: "status",
      label: EX_STATUS_LABELS[status] || status,
    });
  }
  const total = Number(order && order.qty) || 0;
  const filled = Number(order && order.cumExecQty) || 0;
  return {
    events,
    progress: {
      filledQty: filled, totalQty: total,
      pct: total > 0 ? Math.min(100, filled / total * 100) : 0,
    },
  };
}

// Execution statistics over a fills window + the matching closed-PnL rows.
// Slippage is deliberately absent: the venue exposes no reference price at
// submit time, and a fabricated benchmark would be worse than none.
function exExecStats(fills, closedRows) {
  const trades = (fills || []).filter(
    (f) => f && Number(f.execQty) > 0 && String(f.execType || "Trade") === "Trade");
  let volume = 0, fees = 0, maker = 0, qtySum = 0, pxQty = 0;
  const orders = new Set();
  for (const f of trades) {
    const value = Number(f.execValue);
    const fee = Number(f.execFee);
    const qty = Number(f.execQty);
    const px = Number(f.execPrice);
    if (isFinite(value)) volume += value;
    if (isFinite(fee)) fees += fee;
    if (f.isMaker === true || f.isMaker === "true") maker++;
    if (isFinite(qty) && isFinite(px)) { qtySum += qty; pxQty += qty * px; }
    if (f.orderId) orders.add(f.orderId);
  }
  let entryQty = 0, entryPxQty = 0, exitQty = 0, exitPxQty = 0, wins = 0;
  const closes = (closedRows || []).filter((r) => r && isFinite(Number(r.closedPnl)));
  for (const r of closes) {
    const q = Number(r.qty ?? r.closedSize);
    const e = Number(r.avgEntryPrice);
    const x = Number(r.avgExitPrice);
    if (isFinite(q) && q > 0) {
      if (isFinite(e)) { entryQty += q; entryPxQty += q * e; }
      if (isFinite(x)) { exitQty += q; exitPxQty += q * x; }
    }
    if (Number(r.closedPnl) > 0) wins++;
  }
  return {
    fills: trades.length,
    orders: orders.size,
    fillsPerOrder: orders.size ? Number((trades.length / orders.size).toFixed(2)) : null,
    volume: Number(volume.toFixed(4)),
    fees: Number(fees.toFixed(6)),
    makerPct: trades.length ? Number((maker / trades.length * 100).toFixed(1)) : null,
    avgFillPrice: qtySum > 0 ? Number((pxQty / qtySum).toFixed(8)) : null,
    closes: closes.length,
    closeWinPct: closes.length ? Number((wins / closes.length * 100).toFixed(1)) : null,
    avgEntry: entryQty > 0 ? Number((entryPxQty / entryQty).toFixed(8)) : null,
    avgExit: exitQty > 0 ? Number((exitPxQty / exitQty).toFixed(8)) : null,
  };
}

// Break-even exit price assuming TAKER fees on both legs (the conservative
// bound — a maker entry only makes reality better than this number).
function exBreakEven(entryPrice, side, feeRate) {
  const e = Number(entryPrice);
  const f = Number(feeRate);
  if (!isFinite(e) || e <= 0 || !isFinite(f) || f < 0 || f >= 1) return null;
  const long = String(side).toLowerCase() === "buy";
  const be = long ? e * (1 + f) / (1 - f) : e * (1 - f) / (1 + f);
  return Number(be.toFixed(8));
}

// Ticket preview: everything the trader should see BEFORE submitting.
// Inputs are plain numbers (the render layer parses/validates the form).
// All values are estimates and labelled so in the UI:
//   * fees assume the given rate on the entry notional only;
//   * liqEstimate is the leverage-only bound (excludes maintenance margin —
//     the real liquidation sits slightly closer);
//   * post-trade position assumes one-way mode on the same symbol.
function exTicketPreview(p) {
  const qty = Number(p.qty);
  const px = Number(p.price);
  if (!isFinite(qty) || qty <= 0 || !isFinite(px) || px <= 0) return null;
  const lev = isFinite(Number(p.leverage)) && Number(p.leverage) > 0 ? Number(p.leverage) : null;
  const fee = isFinite(Number(p.feeRate)) ? Number(p.feeRate) : 0;
  const buy = String(p.side).toLowerCase() === "buy";
  const notional = qty * px;
  const out = {
    notional: Number(notional.toFixed(4)),
    margin: lev ? Number((notional / lev).toFixed(4)) : null,
    fee: Number((notional * fee).toFixed(6)),
    liqEstimate: lev && lev > 1
      ? Number((buy ? px * (1 - 1 / lev) : px * (1 + 1 / lev)).toFixed(8))
      : null,
  };
  // Post-trade position (one-way): existing signed size ± this order.
  const posQty = isFinite(Number(p.positionQty)) ? Number(p.positionQty) : 0;
  const posSigned = String(p.positionSide).toLowerCase() === "sell" ? -posQty : posQty;
  const orderSigned = buy ? qty : -qty;
  const afterSigned = posSigned + orderSigned;
  out.position = {
    beforeQty: posSigned,
    afterQty: Number(afterSigned.toFixed(8)),
    afterSide: afterSigned > 0 ? "long" : afterSigned < 0 ? "short" : "flat",
    reduces: posSigned !== 0 && Math.sign(orderSigned) !== Math.sign(posSigned),
    flips: posSigned !== 0 && Math.sign(afterSigned) === Math.sign(orderSigned)
      && Math.sign(afterSigned) !== Math.sign(posSigned) && afterSigned !== 0,
  };
  // Bracket risk/reward vs THIS order's price.
  const tp = Number(p.tp);
  const sl = Number(p.sl);
  if (isFinite(tp) && tp > 0) {
    out.projectedProfit = Number(((buy ? tp - px : px - tp) * qty).toFixed(4));
  }
  if (isFinite(sl) && sl > 0) {
    out.projectedLoss = Number(((buy ? px - sl : sl - px) * qty).toFixed(4));
  }
  if (out.projectedProfit != null && out.projectedLoss != null && out.projectedLoss > 0) {
    out.riskReward = Number((out.projectedProfit / out.projectedLoss).toFixed(2));
  }
  return out;
}

// Open-order list filter (search + side), pure so it is snap-testable. Sort
// stays with the existing table-header machinery; this only narrows rows.
function exFilterOrders(rows, view) {
  const v = view || {};
  const q = String(v.search || "").trim().toLowerCase();
  return (rows || []).filter((o) => {
    if (!o) return false;
    if (v.side && v.side !== "all" && String(o.side) !== v.side) return false;
    if (!q) return true;
    const hay = [o.symbol, o.side, o.orderType, o.orderStatus, o.stopOrderType,
      o.timeInForce, o.orderId].map((x) => String(x || "").toLowerCase()).join(" ");
    return q.split(/\s+/).every((w) => !w || hay.includes(w));
  });
}

// Position insights beyond the exchange row: break-even (fees), ROE on the
// exchange's own initial margin when present, funding/fee tallies computed
// from the executions mirror by the caller.
function exPositionInsights(pos, opts) {
  const o = opts || {};
  const entry = Number(pos && pos.avgPrice);
  const size = Number(pos && pos.size);
  const upl = Number(pos && pos.unrealisedPnl);
  const im = Number(pos && pos.positionIM);
  const created = Number(pos && pos.createdTime);
  return {
    breakEven: exBreakEven(entry, pos && pos.side, o.feeRate),
    roePct: isFinite(upl) && isFinite(im) && im > 0
      ? Number((upl / im * 100).toFixed(2)) : null,
    holdingMs: isFinite(created) && created > 0 && o.nowMs > created
      ? o.nowMs - created : null,
    notional: isFinite(entry) && isFinite(size) ? Number((entry * size).toFixed(4)) : null,
    fundingPaid: isFinite(Number(o.fundingPaid)) ? Number(Number(o.fundingPaid).toFixed(6)) : null,
    feesPaid: isFinite(Number(o.feesPaid)) ? Number(Number(o.feesPaid).toFixed(6)) : null,
  };
}

// ---------------------------------------------------------------------------
// 2. Engine state
// ---------------------------------------------------------------------------
let _exView = exSanitizeViewState(null); // pure call — safe at load time
let _exLastBook = null;      // last orderbook envelope (re-render without refetch)
let _exFrozen = false;       // pointer over the ladder = pause repaints
let _exPendingBook = null;   // book that arrived while frozen (painted on leave)
let _exRowCache = [];        // last rendered ladder row strings (diff repaint)
let _exDailyTimer = null;
let _exWired = false;
let _exExecCache = "";

function exPaneVisible() {
  const pane = document.querySelector('[data-pane="dashboard"]');
  return !!pane && !pane.hidden && !document.hidden;
}

function exActivePosition() {
  const sym = state.activeSymbol;
  if (!sym) return null;
  return (state.lastPositions || []).find(
    (p) => p.symbol === sym && Number(p.size) > 0) || null;
}

function exSpecTick() {
  const spec = state.specs && state.specs[state.activeSymbol];
  return spec && Number(spec.tickSize) > 0 ? Number(spec.tickSize) : 0;
}

// ---------------------------------------------------------------------------
// 3. Trading ladder (renders into #book-widget; keeps the .book-row.clickable
//    [data-px] contract so app.js's click/keyboard handlers work unchanged)
// ---------------------------------------------------------------------------
function exLadderMarkers() {
  const sym = state.activeSymbol;
  const last = state.orderLastPrice && state.orderLastPrice.symbol === sym
    ? Number(state.orderLastPrice.price) : null;
  const pos = exActivePosition();
  const mark = pos ? Number(pos.markPrice) : null;
  return { last: isFinite(last) ? last : null, mark: isFinite(mark) ? mark : null };
}

function exPxDecimals() {
  const tick = exSpecTick();
  return tick ? decimalsOf(String(tick)) : 2;
}

function exLadderRowHtml(r, side, dec, entryPx) {
  const isEntry = entryPx != null && Math.abs(r.price - entryPx) < 1e-9;
  return `<div class="book-row ${side} clickable${isEntry ? " ex-entry" : ""}" data-px="${r.price}" role="button" tabindex="0" ` +
    `title="Click to fill the limit price" aria-label="Use price ${r.price}">` +
    `<span class="depth" style="width:${r.sizePct.toFixed(1)}%"></span>` +
    `<span class="cumbar" style="width:${r.cumPct.toFixed(1)}%"></span>` +
    `<span class="cum">${fmtNum(r.cum, 3)}</span>` +
    `<span class="sz">${fmtNum(r.size, 3)}</span>` +
    `<span class="px">${fmtNum(r.price, dec)}</span>` +
    `</div>`;
}

function exRenderLadder(book, force) {
  const el = document.getElementById("book-widget");
  if (!el) return;
  // Stale-symbol guards: the venue's envelope names its symbol (result.s).
  const incoming = book && book.result;
  const prevRes = _exLastBook && _exLastBook.result;
  if (incoming && incoming.s && state.activeSymbol
      && String(incoming.s) !== state.activeSymbol) {
    // Late response from a PREVIOUS symbol: drop it — and if the painted
    // rows are from that symbol too, clear them rather than leave them
    // clickable under the new label.
    if (prevRes && prevRes.s && String(prevRes.s) !== state.activeSymbol) {
      _exLastBook = null;
      _exPendingBook = null;
      _exRowCache = [];
      el.innerHTML = `<p class="muted book-empty">Loading depth…</p>`;
    }
    return;
  }
  if (incoming && incoming.s && prevRes && prevRes.s
      && String(incoming.s) !== String(prevRes.s)) {
    // First book of a NEW symbol: repaint immediately even when Follow is
    // off or the pointer froze the old ladder — the freeze belonged to the
    // previous symbol's view.
    _exRowCache = [];
    _exPendingBook = null;
    force = true;
  }
  _exLastBook = book || _exLastBook;
  const cached = _exLastBook && _exLastBook.result;
  if (cached && cached.s && state.activeSymbol
      && String(cached.s) !== state.activeSymbol) {
    _exLastBook = null;
    _exPendingBook = null;
    _exRowCache = [];
    el.innerHTML = `<p class="muted book-empty">Loading depth…</p>`;
    return;
  }
  if (!force) {
    if (!_exView.follow) return; // Follow off: hold the current paint (Center repaints)
    if (_exFrozen) { _exPendingBook = book; return; } // pointer over the ladder
  }
  if (!_exLastBook) return;
  const markers = exLadderMarkers();
  const ladder = exBuildLadder(_exLastBook, {
    tick: exSpecTick(), grouping: _exView.grouping, rows: Number(_exView.rows),
    last: markers.last, mark: markers.mark,
  });
  const dec = exPxDecimals();
  if (!ladder.bids.length && !ladder.asks.length) {
    _exRowCache = [];
    el.innerHTML = `<p class="muted book-empty">No depth.</p>`;
    return;
  }
  const pos = exActivePosition();
  const entryPx = pos ? Number(pos.avgPrice) : null;
  const total = ladder.totalBid + ladder.totalAsk;
  const bidShare = total > 0 ? ladder.totalBid / total * 100 : 50;
  const spreadRow =
    `<div class="book-spread ex-spread">` +
    `<span class="mid">${ladder.spread != null ? fmtNum((ladder.bestAsk + ladder.bestBid) / 2, dec) : "—"}</span>` +
    `<span class="sp">${ladder.spread != null
      ? `spread ${fmtNum(ladder.spread, dec)}${ladder.spreadPct != null ? ` · ${(ladder.spreadPct * 100).toFixed(1)} bps` : ""}`
      : "no spread"}` +
    `${markers.last != null ? ` · last <b class="${markers.mark != null && markers.last >= markers.mark ? "pos" : "neg"}">${fmtNum(markers.last, dec)}</b>` : ""}` +
    `${markers.mark != null ? ` · mark ${fmtNum(markers.mark, dec)}` : ""}</span>` +
    `</div>`;
  const rows = [
    ...ladder.asks.map((r) => exLadderRowHtml(r, "ask", dec, entryPx)),
    spreadRow,
    ...ladder.bids.map((r) => exLadderRowHtml(r, "bid", dec, entryPx)),
  ];
  const footer =
    `<div class="ex-book-total" role="img" aria-label="Depth imbalance: ${bidShare.toFixed(0)}% bid">` +
    `<span class="ex-bidbar" style="width:${bidShare.toFixed(1)}%"></span>` +
    `<span class="ex-total-b priv">Σ bid ${fmtNum(ladder.totalBid, 2)}</span>` +
    `<span class="ex-total-a priv">Σ ask ${fmtNum(ladder.totalAsk, 2)}</span>` +
    `</div>`;
  const container = el.querySelector(".ex-ladder");
  // Full rebuild when the shape changed; otherwise patch only changed rows so
  // the pointer/focus never jumps and repaint cost stays tiny.
  if (!container || _exRowCache.length !== rows.length) {
    el.innerHTML = `<div class="ex-ladder">${rows.join("")}</div>${footer}`;
    _exRowCache = rows;
    return;
  }
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] !== _exRowCache[i]) {
      const node = container.children[i];
      const focused = node && node.contains(document.activeElement);
      if (node && !focused) {
        node.outerHTML = rows[i];
        _exRowCache[i] = rows[i];
      }
    }
  }
  const foot = el.querySelector(".ex-book-total");
  if (foot) foot.outerHTML = footer;
}

function exCenterLadder() {
  // With a fixed row count the ladder is always centered on the spread — a
  // manual Center is "repaint from the freshest book now" (even while the
  // Follow toggle is off).
  _exPendingBook = null;
  _exFrozen = false;
  exRenderLadder(_exLastBook, true);
}

// ---------------------------------------------------------------------------
// 4. Ticket preview strip (estimates the existing preview does not show:
//    liquidation bound, post-trade position, bracket risk/reward)
// ---------------------------------------------------------------------------
function exPreviewTick() {
  const el = document.getElementById("ex-preview");
  const form = document.getElementById("order-form");
  if (!el || !form) return;
  const sym = String(form.symbol.value || "").trim().toUpperCase();
  const type = form.orderType.value;
  const isMarket = type === "Market";
  const tif = form.timeInForce ? form.timeInForce.value : "GTC";
  const px = isMarket
    ? (state.orderLastPrice && state.orderLastPrice.symbol === sym
        ? Number(state.orderLastPrice.price) : NaN)
    : Number(form.price.value);
  const lev = state.symbolLeverage && state.symbolLeverage.symbol === sym
    ? Number(state.symbolLeverage.leverage) : null;
  const pos = (state.lastPositions || []).find(
    (p) => p.symbol === sym && Number(p.size) > 0);
  const takerish = isMarket || tif === "IOC" || tif === "FOK";
  const preview = exTicketPreview({
    side: form.side.value, qty: form.qty.value, price: px,
    leverage: lev, feeRate: takerish ? TAKER_FEE_RATE : MAKER_FEE_RATE,
    tp: form.takeProfit.value, sl: form.stopLoss.value,
    positionQty: pos ? pos.size : 0, positionSide: pos ? pos.side : "",
  });
  if (!preview) { el.hidden = true; el.innerHTML = ""; return; }
  const dec = exPxDecimals();
  const bits = [];
  if (preview.liqEstimate != null) {
    bits.push(`<span title="Leverage-only bound — the real liquidation sits slightly closer (maintenance margin excluded)">liq ≈ <b class="priv">${fmtNum(preview.liqEstimate, dec)}</b></span>`);
  }
  const after = preview.position;
  if (after.reduces || after.flips || after.beforeQty !== 0) {
    const label = after.flips
      ? `<b class="warn">FLIPS to ${after.afterSide} ${fmtNum(Math.abs(after.afterQty), 4)}</b>`
      : `→ ${after.afterSide === "flat" ? "<b class=\"pos\">flat</b>" : `${after.afterSide} <b class="priv">${fmtNum(Math.abs(after.afterQty), 4)}</b>`}`;
    bits.push(`<span title="Post-trade position (one-way mode)">pos ${label}</span>`);
  }
  if (preview.riskReward != null) {
    bits.push(`<span title="Projected profit at TP vs projected loss at SL (excl. fees)">R:R <b class="${preview.riskReward >= 1.5 ? "pos" : preview.riskReward < 1 ? "neg" : ""}">${preview.riskReward}</b>` +
      ` <i class="ex-rr"><i style="width:${Math.min(100, preview.riskReward / (preview.riskReward + 1) * 100).toFixed(0)}%"></i></i></span>`);
  } else if (preview.projectedProfit != null || preview.projectedLoss != null) {
    if (preview.projectedProfit != null) bits.push(`<span>TP → <b class="pos priv">+${fmtNum(preview.projectedProfit, 2)}</b></span>`);
    if (preview.projectedLoss != null) bits.push(`<span>SL → <b class="neg priv">−${fmtNum(Math.abs(preview.projectedLoss), 2)}</b></span>`);
  }
  if (!bits.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = `<span class="ex-prev-tag" title="Estimates only — fees assume ${takerish ? "taker" : "maker"} rate; liquidation excludes maintenance margin">est.</span>` + bits.join("<span class=\"ex-dot\">·</span>");
}

// ---------------------------------------------------------------------------
// 5. Quick actions (prep + existing confirmed flows only — nothing here can
//    submit, cancel or close without the SAME ceremony the tables use)
// ---------------------------------------------------------------------------
function exPaintQuickActions() {
  const panel = document.getElementById("ex-quick");
  if (!panel) return;
  const pos = exActivePosition();
  const sym = state.activeSymbol || "";
  const orders = (state.lastOrders || []).length;
  const label = panel.querySelector("#ex-qa-context");
  if (label) {
    label.innerHTML = pos
      ? `${esc(sym)} · <span class="${pos.side === "Buy" ? "pos" : "neg"}">${pos.side === "Buy" ? "LONG" : "SHORT"}</span> <span class="priv">${esc(String(pos.size))}</span> · uPnL <span class="${pnlClass(pos.unrealisedPnl)} priv">${fmtNum(Number(pos.unrealisedPnl) || 0, 2)}</span>`
      : sym ? `${esc(sym)} · no open position` : "Pick a symbol in the ticket";
  }
  // setAttribute stores the value verbatim (no HTML parsing), so the JSON
  // must NOT be esc()'d here — that idiom is only for attributes embedded in
  // HTML strings (as the tables do).
  const payload = pos ? JSON.stringify({
    symbol: pos.symbol, side: pos.side, qty: pos.size,
    positionIdx: pos.positionIdx ?? 0,
  }) : "";
  panel.querySelectorAll("[data-ex-close-pct]").forEach((b) => {
    b.disabled = !pos;
    if (pos) {
      b.setAttribute("data-close", payload);
      b.setAttribute("data-close-pct", b.getAttribute("data-ex-close-pct"));
    } else {
      b.removeAttribute("data-close");
    }
  });
  const be = panel.querySelector("#ex-qa-be");
  if (be) be.disabled = !pos;
  const ca = panel.querySelector("#ex-qa-cancelall");
  if (ca) ca.disabled = !orders;
}

function exQuickPrep(side) {
  const form = document.getElementById("order-form");
  if (!form) return;
  form.side.value = side;
  form.side.dispatchEvent(new Event("change", { bubbles: true }));
  form.orderType.value = "Market";
  form.orderType.dispatchEvent(new Event("change", { bubbles: true }));
  const target = form.symbol.value ? form.qty : form.symbol;
  target.focus();
  if (target.select) target.select();
}

function exQuickBreakEven() {
  // Opens the EXISTING TP/SL modal (its own ceremony + trade token) with the
  // break-even preset one click away — never applies anything by itself.
  const pos = exActivePosition();
  if (!pos || typeof openTpslModal !== "function") return;
  if (typeof ensureToken === "function" && !ensureToken()) return;
  openTpslModal({
    symbol: pos.symbol, positionIdx: pos.positionIdx ?? 0, side: pos.side,
    size: pos.size, leverage: pos.leverage, avgPrice: pos.avgPrice,
    markPrice: pos.markPrice, breakEvenPrice: pos.breakEvenPrice,
    takeProfit: pos.takeProfit, stopLoss: pos.stopLoss,
  });
}

// ---------------------------------------------------------------------------
// 6. Positions / orders extras (consumed by app.js render functions)
// ---------------------------------------------------------------------------
function exDailyFills() {
  // The risk module already maintains a shared day window (closed + fills)
  // with single-flight fetching — reuse it instead of polling twice.
  return (typeof _rkDaily !== "undefined" && _rkDaily && !_rkDaily.error)
    ? _rkDaily : null;
}

function exPositionExtras(p) {
  const daily = exDailyFills();
  let funding = null, fees = null;
  if (daily && daily.exec) {
    funding = 0; fees = 0;
    for (const f of daily.exec) {
      if (!f || f.symbol !== p.symbol) continue;
      const fee = Number(f.execFee);
      if (!isFinite(fee)) continue;
      if (String(f.execType || "") === "Funding") funding += fee;
      else fees += fee;
    }
  }
  const ins = exPositionInsights(p, {
    feeRate: TAKER_FEE_RATE, nowMs: Date.now(),
    fundingPaid: funding, feesPaid: fees,
  });
  return [
    ["BE incl. fees (taker×2)", ins.breakEven != null ? fmtNum(ins.breakEven, exPxDecimals()) : "—", true],
    ["ROE (on initial margin)", ins.roePct != null ? `${ins.roePct}%` : "—", true],
    ["Holding time", ins.holdingMs != null ? fmtDuration(ins.holdingMs) : "—"],
    ["Funding (today)", ins.fundingPaid != null ? fmtNum(ins.fundingPaid, 6) : "—", true],
    ["Trade fees (today)", ins.feesPaid != null ? fmtNum(ins.feesPaid, 6) : "—", true],
  ];
}

function exOrderExtras(o) {
  const daily = exDailyFills();
  const tl = exOrderTimeline(o, daily ? daily.exec : []);
  if (!tl.events.length) return [];
  const line = tl.events
    .map((e) => `${fmtTime(e.tsMs)} — ${e.label}${e.kind === "fill" ? (e.maker ? " (maker)" : " (taker)") : ""}`)
    .join("  →  ");
  const rows = [["Lifecycle", line]];
  if (tl.progress.totalQty > 0 && tl.progress.filledQty > 0) {
    rows.push(["Fill progress",
      `${tl.progress.filledQty}/${tl.progress.totalQty} (${tl.progress.pct.toFixed(0)}%)`, true]);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 7. Execution panel (stats + recent fills, from the shared day window)
// ---------------------------------------------------------------------------
async function exRefreshExec(force) {
  const daily = exDailyFills();
  const stale = !daily || !daily.at || Date.now() - daily.at > 55000;
  if ((stale || force) && typeof rkFetchDaily === "function") {
    await rkFetchDaily();
  }
  exRenderExecPanel();
}

function exRenderExecPanel() {
  const el = document.getElementById("ex-exec-body");
  if (!el) return;
  const daily = exDailyFills();
  if (!daily) {
    el.innerHTML = `<p class="muted center" style="padding:14px">Today's executions are loading…</p>`;
    _exExecCache = "";
    return;
  }
  const stats = exExecStats(daily.exec, daily.closed);
  const dec = exPxDecimals();
  const tile = (k, v, cls) =>
    `<div class="ex-tile"><div class="k">${esc(k)}</div><div class="v priv ${cls || ""}">${v}</div></div>`;
  const tiles =
    `<div class="ex-tiles">` +
    tile("Fills today", String(stats.fills)) +
    tile("Orders", stats.orders + (stats.fillsPerOrder ? ` <span class="muted">(${stats.fillsPerOrder} fills/ord)</span>` : "")) +
    tile("Volume", fmtMoney(stats.volume, 2)) +
    tile("Fees", fmtMoney(stats.fees, 4)) +
    tile("Maker", stats.makerPct != null ? stats.makerPct + "%" : "—",
      stats.makerPct != null && stats.makerPct >= 50 ? "pos" : "") +
    tile("Closes (win)", stats.closes ? `${stats.closes} <span class="${pnlClass(stats.closeWinPct - 50)}">(${stats.closeWinPct}%)</span>` : "—") +
    tile("Avg entry", stats.avgEntry != null ? fmtMoney(stats.avgEntry, dec) : "—") +
    tile("Avg exit", stats.avgExit != null ? fmtMoney(stats.avgExit, dec) : "—") +
    `</div>`;
  const fills = (daily.exec || [])
    .filter((f) => f && Number(f.execQty) > 0 && String(f.execType || "Trade") === "Trade")
    .sort((a, b) => Number(b.execTime) - Number(a.execTime))
    .slice(0, 12);
  const fillRows = fills.map((f) =>
    `<tr><td class="mono" data-label="Time">${esc(fmtTime(f.execTime))}</td>` +
    `<td class="mono" data-label="Symbol" style="text-align:left">${esc(String(f.symbol || ""))}</td>` +
    `<td class="mono ${sideClass(f.side)}" data-label="Side">${esc(String(f.side || ""))}</td>` +
    `<td class="mono priv" data-label="Qty">${esc(String(f.execQty))}</td>` +
    `<td class="mono" data-label="Price">${esc(String(f.execPrice))}</td>` +
    `<td class="mono priv" data-label="Fee">${esc(String(f.execFee ?? "—"))}</td>` +
    `<td class="mono" data-label="M/T">${(f.isMaker === true || f.isMaker === "true") ? "M" : "T"}</td></tr>`).join("");
  const table = fills.length
    ? `<div class="table-wrap ex-fills"><table><thead><tr><th>Time</th><th style="text-align:left">Symbol</th>` +
      `<th>Side</th><th>Qty</th><th>Price</th><th>Fee</th><th>M/T</th></tr></thead>` +
      `<tbody>${fillRows}</tbody></table></div>`
    : `<p class="muted center" style="padding:10px">No fills today yet.</p>`;
  const note = `<p class="muted ex-note">From the history mirror (synced ~every minute) · slippage is not shown — the venue exposes no reference price at submit time.</p>`;
  const html = tiles + table + note;
  if (html === _exExecCache) return;
  _exExecCache = html;
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// 8. Snapshot ingest + orders toolbar (called from app.js)
// ---------------------------------------------------------------------------
function exIngest() {
  exPaintQuickActions();
  // Mark/last markers may have moved — refresh the ladder from cache (no
  // network) and the ticket preview (position may have changed underneath).
  if (exPaneVisible() && !_exFrozen && _exLastBook) exRenderLadder(_exLastBook);
  exPreviewTick();
}

function exApplyOrderFilters(rows) {
  return exFilterOrders(rows, _exView.orders);
}

function exPaintOrdersToolbar() {
  const search = document.getElementById("ex-ord-search");
  const side = document.getElementById("ex-ord-side");
  if (search && search.value !== _exView.orders.search) search.value = _exView.orders.search;
  if (side && side.value !== _exView.orders.side) side.value = _exView.orders.side;
}

function exRerenderCurrency() {
  _exExecCache = "";
  exRenderExecPanel();
}

// ---------------------------------------------------------------------------
// 9. Workspace + lifecycle contract
// ---------------------------------------------------------------------------
function exCaptureViewState() { return exSanitizeViewState(_exView); }

function exApplyViewState(raw) {
  _exView = exSanitizeViewState(raw);
  exPaintOrdersToolbar();
  const group = document.getElementById("ex-group");
  if (group) group.value = _exView.grouping;
  const rowsSel = document.getElementById("ex-rows");
  if (rowsSel) rowsSel.value = _exView.rows;
  exPaintFollow();
  _exRowCache = [];
  if (_exLastBook) exRenderLadder(_exLastBook, true);
  // Re-apply the restored order filter — but only once a snapshot has painted
  // (at boot this runs before the first frame; the skeleton must stay).
  if (state.lastDashboard) renderOrders(state.lastOrders);
}

function exPaintFollow() {
  const btn = document.getElementById("ex-follow");
  if (!btn) return;
  btn.classList.toggle("active", _exView.follow);
  btn.setAttribute("aria-pressed", String(_exView.follow));
  btn.textContent = _exView.follow ? "Follow" : "Frozen";
  btn.title = _exView.follow
    ? "Auto-follow: the ladder repaints with every depth poll"
    : "Frozen: the ladder holds this snapshot until you press Center or re-enable Follow";
}

function exFollowEnabled() { return _exView.follow; }

function onExecActive() {
  clearInterval(_exDailyTimer);
  exRefreshExec(false);
  _exDailyTimer = setInterval(() => {
    const pane = document.querySelector('[data-pane="dashboard"]');
    if (!pane || pane.hidden) { clearInterval(_exDailyTimer); return; }
    if (document.hidden) return; // backgrounded browser tab: skip, keep the timer
    exRefreshExec(false);
  }, 60000);
}

// ---------------------------------------------------------------------------
// 10. Wiring (called once from app.js boot, BEFORE wireWorkspaces)
// ---------------------------------------------------------------------------
function wireExec() {
  if (_exWired) return;
  _exWired = true;

  // Ladder controls.
  const group = document.getElementById("ex-group");
  if (group) group.addEventListener("change", () => {
    _exView.grouping = EX_GROUPINGS.includes(group.value) ? group.value : "1";
    _exRowCache = [];
    exRenderLadder(_exLastBook, true);
    if (typeof wsAutoSave === "function") wsAutoSave();
  });
  const rowsSel = document.getElementById("ex-rows");
  if (rowsSel) rowsSel.addEventListener("change", () => {
    _exView.rows = EX_ROWS_OPTIONS.includes(rowsSel.value) ? rowsSel.value : "12";
    _exRowCache = [];
    exRenderLadder(_exLastBook, true);
    if (typeof wsAutoSave === "function") wsAutoSave();
  });
  const follow = document.getElementById("ex-follow");
  if (follow) follow.addEventListener("click", () => {
    _exView.follow = !_exView.follow;
    exPaintFollow();
    if (_exView.follow) exCenterLadder();
    if (typeof wsAutoSave === "function") wsAutoSave();
  });
  const center = document.getElementById("ex-center");
  if (center) center.addEventListener("click", exCenterLadder);

  // Freeze while the pointer is over the ladder (rows must not shift under a
  // click), releasing the buffered book on leave.
  const widget = document.getElementById("book-widget");
  if (widget) {
    widget.addEventListener("pointerenter", () => { _exFrozen = true; });
    widget.addEventListener("pointerleave", () => {
      _exFrozen = false;
      if (_exPendingBook) { const b = _exPendingBook; _exPendingBook = null; exRenderLadder(b); }
    });
    // Arrow-key navigation between ladder rows (Enter/Space activation is
    // already handled by app.js's existing book-row handler).
    widget.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const row = e.target.closest && e.target.closest(".book-row.clickable");
      if (!row) return;
      e.preventDefault();
      let next = e.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
      while (next && !next.classList.contains("clickable")) {
        next = e.key === "ArrowUp" ? next.previousElementSibling : next.nextElementSibling;
      }
      if (next) next.focus();
    });
  }

  // Ticket preview + qty/price arrow-nudge (never submits anything).
  const form = document.getElementById("order-form");
  if (form) {
    form.addEventListener("input", exPreviewTick);
    form.addEventListener("change", exPreviewTick);
    form.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const name = e.target && e.target.name;
      if (name !== "qty" && name !== "price") return;
      const spec = state.specs && state.specs[String(form.symbol.value || "").trim().toUpperCase()];
      const step = name === "qty" ? Number(spec && spec.qtyStep) : Number(spec && spec.tickSize);
      if (!(step > 0)) return;
      e.preventDefault();
      const cur = Number(e.target.value) || 0;
      const next = Math.max(0, cur + (e.key === "ArrowUp" ? step : -step));
      const snapped = snapToStep(next + step / 2, step); // snap DOWN onto the grid
      if (snapped != null) {
        e.target.value = snapped;
        form.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
  }

  // Quick actions: prep buttons are local; write buttons carry data-close /
  // open the TP/SL modal, so app.js's delegated handler runs the SAME
  // confirmation ceremony as the table buttons.
  const quick = document.getElementById("ex-quick");
  if (quick) {
    const buy = quick.querySelector("#ex-qa-buy");
    if (buy) buy.addEventListener("click", () => exQuickPrep("Buy"));
    const sell = quick.querySelector("#ex-qa-sell");
    if (sell) sell.addEventListener("click", () => exQuickPrep("Sell"));
    const be = quick.querySelector("#ex-qa-be");
    if (be) be.addEventListener("click", exQuickBreakEven);
    const ca = quick.querySelector("#ex-qa-cancelall");
    if (ca) ca.addEventListener("click", () => {
      const real = document.getElementById("cancel-all-btn");
      if (real && !real.hidden) real.click();
    });
  }

  // Orders toolbar (filtering narrows the existing table; sort untouched).
  const search = document.getElementById("ex-ord-search");
  if (search) search.addEventListener("input", () => {
    _exView.orders.search = search.value.slice(0, 40);
    if (state.lastOrders) renderOrders(state.lastOrders);
    if (typeof wsAutoSave === "function") wsAutoSave();
  });
  const side = document.getElementById("ex-ord-side");
  if (side) side.addEventListener("change", () => {
    _exView.orders.side = EX_ORDER_SIDES.includes(side.value) ? side.value : "all";
    if (state.lastOrders) renderOrders(state.lastOrders);
    if (typeof wsAutoSave === "function") wsAutoSave();
  });
  const execRefresh = document.getElementById("ex-exec-refresh");
  if (execRefresh) execRefresh.addEventListener("click", () => exRefreshExec(true));

  exPaintFollow();
  exPaintOrdersToolbar();
}
