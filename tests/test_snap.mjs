// Node regression test for the money-sizing math in app/static/app.js.
// app.js is a browser script (touches window/document), so we extract the two
// pure, DOM-free functions by source and evaluate them in isolation. This guards
// the snapToStep IEEE-754 floor fix (a wrong floor silently under-sizes orders).
import fs from "node:fs";
import assert from "node:assert/strict";

const src = fs.readFileSync(new URL("../app/static/app.js", import.meta.url), "utf8");

function extractFn(name) {
  const start = src.search(new RegExp(`function ${name}\\s*\\(`));
  if (start < 0) throw new Error(`function ${name} not found in app.js`);
  // The body brace is the first "{" AFTER the parameter list closes — the
  // params may themselves be a destructuring pattern containing braces
  // (e.g. projectedPnl({ side, entry, ... })), so match the parens first.
  let i = src.indexOf("(", start);
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")" && --parens === 0) break;
  }
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const factory = new Function(
  extractFn("decimalsOf") + "\n" + extractFn("snapToStep") +
  "\nreturn { decimalsOf, snapToStep };"
);
const { snapToStep } = factory();

// The core M2 regression: 0.3 / 0.1 === 2.9999999999999996 must NOT floor to 0.2.
assert.equal(snapToStep("0.3", "0.1"), "0.3");
assert.equal(snapToStep("2.5", "0.1"), "2.5");
assert.equal(snapToStep("0.6", "0.1"), "0.6");
// The epsilon must not over-round a genuinely-below value up a step.
assert.equal(snapToStep("1.29", "0.1"), "1.2");
assert.equal(snapToStep("0.05", "0.1"), "0.0"); // below one lot step -> 0
assert.equal(snapToStep("100", "0.001"), "100.000");
// Guards.
assert.equal(snapToStep("-1", "0.1"), null);
assert.equal(snapToStep("1", "0"), null);

// ---------------------------------------------------------------------------
// projectedPnl — the figure shown before EVERY TP/SL commit and in the order
// ticket preview. Pure function; the fee constant is extracted from app.js so
// these tests track the deployed rate, not a copy.
// ---------------------------------------------------------------------------
const feeLine = src.match(/const TAKER_FEE_RATE = [0-9.]+;.*/);
if (!feeLine) throw new Error("TAKER_FEE_RATE constant not found in app.js");
const pnlFactory = new Function(
  feeLine[0] + "\n" + extractFn("projectedPnl") + "\nreturn { projectedPnl };"
);
const { projectedPnl } = pnlFactory();
const close = (a, b) => Math.abs(a - b) < 1e-9;

// Long take-profit: gross (110-100)×2 = 20; market exit pays taker on the way out.
let r = projectedPnl({ side: "Buy", entry: 100, exitPrice: 110, size: 2 });
assert.ok(close(r.gross, 20), `gross ${r.gross}`);
assert.ok(close(r.exitFee, 110 * 2 * 0.00035), `fee ${r.exitFee}`);
assert.ok(close(r.net, 20 - 110 * 2 * 0.00035), `net ${r.net}`);
assert.equal(r.roi, null, "no leverage -> no ROI (never shown against a guess)");

// Short profit with leverage: margin = entry×size÷lev; ROI = net/margin.
r = projectedPnl({ side: "Sell", entry: 100, exitPrice: 90, size: 1, leverage: 10 });
assert.ok(close(r.gross, 10));
assert.ok(close(r.net, 10 - 90 * 0.00035));
assert.ok(close(r.roi, ((10 - 90 * 0.00035) / 10) * 100), `roi ${r.roi}`);

// Long stop-loss: the loss is gross MINUS the fee (more negative, never less).
r = projectedPnl({ side: "Buy", entry: 100, exitPrice: 95, size: 1 });
assert.ok(close(r.gross, -5));
assert.ok(r.net < -5, "exit fee must deepen a loss, not offset it");

// Case-insensitive side; string inputs (the form supplies strings).
r = projectedPnl({ side: "buy", entry: "100", exitPrice: "101", size: "1" });
assert.ok(close(r.gross, 1));

// Incomplete/invalid inputs -> null, never a fabricated preview.
assert.equal(projectedPnl({ side: "Buy", entry: 0, exitPrice: 1, size: 1 }), null);
assert.equal(projectedPnl({ side: "Buy", entry: 1, exitPrice: NaN, size: 1 }), null);
assert.equal(projectedPnl({ side: "Buy", entry: 1, exitPrice: 2, size: -1 }), null);

// ---------------------------------------------------------------------------
// Workspace document operations — the PURE core of the workspace system
// (creation, rename, duplicate, delete, v1 migration, corrupt-storage
// recovery, import validation). Extracted from app.js and run DOM-free.
// ---------------------------------------------------------------------------
function extractConst(name) {
  const m = src.match(new RegExp(`^const ${name} = .*?;`, "m"));
  if (!m) throw new Error(`const ${name} not found in app.js`);
  return m[0];
}
const wsConsts = ["WS_SCHEMA_VERSION", "WS_MAX", "WS_PANEL_IDS", "WS_TABS",
  "WS_CHART_VIEWS", "WS_INTERVALS", "WS_SYMBOL_RE",
  // wsSanitizeState also references the watchlist view allowlists…
  "WL_FILTERS", "WL_SORTS",
  // …and the scanner view sanitizer + its allowlists.
  "SC_SYMBOL_RE", "SC_METRICS", "SC_SORTS", "SC_PRESETS", "SC_SECTION_IDS"].map(extractConst).join("\n");
const wsFns = ["wsId", "scSanitizeViewState", "wsSanitizeState", "wsMakeWorkspace", "wsSanitizeWorkspace",
  "wsNewDoc", "wsMigrateFromV1", "wsParseDoc", "wsValidateImport",
  "wsCreate", "wsDuplicate", "wsRename", "wsDelete"].map(extractFn).join("\n");
const WS = new Function(wsConsts + "\n" + wsFns +
  "\nreturn { wsSanitizeState, wsNewDoc, wsMigrateFromV1, wsParseDoc, wsValidateImport, wsCreate, wsDuplicate, wsRename, wsDelete };")();

// New document: one Default workspace, active, schema v2.
let doc = WS.wsNewDoc();
assert.equal(doc.version, 2);
assert.equal(doc.workspaces.length, 1);
assert.equal(doc.workspaces[0].name, "Default");
assert.equal(doc.activeId, doc.workspaces[0].id);

// Create: adds + activates; the limit is enforced.
const created = WS.wsCreate(doc, "BTC Scalping", { density: "compact" });
assert.ok(created && doc.activeId === created.id);
assert.equal(created.state.density, "compact");
while (WS.wsCreate(doc, "x")) { /* fill to the cap */ }
assert.equal(doc.workspaces.length, 20, "WS_MAX enforced");
assert.equal(WS.wsCreate(doc, "over"), null);

// Rename: trims, caps at 40 chars, rejects empty.
assert.equal(WS.wsRename(doc, created.id, "  Swing Trading  "), true);
assert.equal(doc.workspaces.find((w) => w.id === created.id).name, "Swing Trading");
assert.equal(WS.wsRename(doc, created.id, "   "), false);
assert.equal(WS.wsRename(doc, created.id, "y".repeat(80)).valueOf(), true);
assert.equal(doc.workspaces.find((w) => w.id === created.id).name.length, 40);

// Duplicate: independent deep copy.
doc = WS.wsNewDoc();
const orig = doc.workspaces[0];
orig.state.collapsed = { charts: true };
const dup = WS.wsDuplicate(doc, orig.id);
assert.ok(dup && dup.id !== orig.id && dup.name.endsWith(" copy"));
dup.state.collapsed.charts = false;
assert.equal(orig.state.collapsed.charts, true, "duplicate must not share state");

// Delete: never the last one; deleting the active re-activates another.
assert.equal(WS.wsDelete(doc, dup.id), true);
assert.equal(WS.wsDelete(doc, orig.id), false, "last workspace is undeletable");
const d2 = WS.wsNewDoc();
const w2 = WS.wsCreate(d2, "two");
assert.equal(d2.activeId, w2.id);
WS.wsDelete(d2, w2.id);
assert.equal(d2.activeId, d2.workspaces[0].id, "active moves after deleting it");

// v1 migration: order/collapsed/legacy density carried into Default.
const mig = WS.wsParseDoc(null, JSON.stringify({ order: ["orders", "positions"], collapsed: { book: true } }), "compact");
assert.equal(mig.migrated, true);
const mst = mig.doc.workspaces[0].state;
assert.deepEqual(mst.order, ["orders", "positions"]);
assert.equal(mst.collapsed.book, true);
assert.equal(mst.density, "compact");

// Corrupt storage: fresh defaults + corrupt flag (caller quarantines the blob).
assert.equal(WS.wsParseDoc("{not json", null, null).corrupt, true);
assert.equal(WS.wsParseDoc(JSON.stringify({ version: 99, workspaces: [] }), null, null).corrupt, true,
  "future schema versions are quarantined, never half-read");
assert.equal(WS.wsParseDoc(null, null, null).corrupt, false);

// Round-trip: a valid doc survives parse unchanged in the fields that matter.
const rt = WS.wsParseDoc(JSON.stringify(d2), null, null);
assert.equal(rt.corrupt, false);
assert.equal(rt.doc.workspaces.length, d2.workspaces.length);
assert.equal(rt.doc.activeId, d2.activeId);

// State sanitization: hostile/garbage values are coerced to safe defaults.
const dirty = WS.wsSanitizeState({
  order: ["positions", "positions", "<script>", "charts"],
  collapsed: { charts: true, evil: true },
  density: "ultra",
  chart: { view: "3d", interval: "42", single: "btc<img>" },
  tab: "admin",
  bookSymbol: "sol usdt",
});
assert.deepEqual(dirty.order, ["positions", "charts"], "unknown/dup panel ids dropped");
assert.deepEqual(Object.keys(dirty.collapsed), ["charts"]);
assert.equal(dirty.density, "comfortable");
assert.equal(dirty.chart.view, "grid");
assert.equal(dirty.chart.interval, "15");
assert.equal(dirty.chart.single, "BTCUSDT");
assert.equal(dirty.tab, "dashboard");
assert.equal(dirty.bookSymbol, "");

// Import validation: accepts the export envelope + bare workspaces; rejects junk.
assert.equal(WS.wsValidateImport(null), null);
assert.equal(WS.wsValidateImport({ kind: "theme" }), null);
assert.equal(WS.wsValidateImport({ kind: "workspace" }), null);
const imp = WS.wsValidateImport({
  kind: "workspace", workspace: { name: "Research", state: { tab: "history" } },
});
assert.ok(imp && imp.name === "Research" && imp.state.tab === "history");
assert.ok(imp.id.startsWith("ws_"), "import mints a FRESH id");
const bare = WS.wsValidateImport({ name: "Bare", state: { density: "compact" } });
assert.ok(bare && bare.state.density === "compact");

// ---------------------------------------------------------------------------
// Watchlist document operations — the PURE core of the Watchlist & Market
// Monitor (CRUD, symbol ops, favorites, sort/filter view, alert evaluation,
// corrupt-storage recovery, import validation). DOM-free, extracted from app.js.
// ---------------------------------------------------------------------------
const wlConsts = ["WL_SCHEMA_VERSION", "WL_MAX_LISTS", "WL_MAX_SYMBOLS", "WL_MAX_ALERTS",
  "WL_SYMBOL_RE", "WL_FILTERS", "WL_SORTS", "WL_ALERT_KINDS", "WL_MOVER_PCT"].map(extractConst).join("\n");
const wlFns = ["wlId", "wlSanitizeSymbol", "wlSanitizeSymbols", "wlSanitizeList", "wlSanitizeAlert",
  "wlNewDoc", "wlParseDoc", "wlValidateImport", "wlFindList", "wlCreate", "wlRename", "wlDuplicate",
  "wlDelete", "wlAddSymbol", "wlRemoveSymbol", "wlReorder", "wlMoveSymbol", "wlToggleFav",
  "wlEvalAlert", "wlComputeView"].map(extractFn).join("\n");
const WL = new Function(wlConsts + "\n" + wlFns +
  "\nreturn { wlSanitizeSymbol, wlNewDoc, wlParseDoc, wlValidateImport, wlFindList, wlCreate, wlRename, wlDuplicate, wlDelete, wlAddSymbol, wlRemoveSymbol, wlReorder, wlMoveSymbol, wlToggleFav, wlEvalAlert, wlComputeView };")();

// Symbol sanitization is the trust boundary.
assert.equal(WL.wlSanitizeSymbol("btcusdt"), "BTCUSDT");
assert.equal(WL.wlSanitizeSymbol(" ethusdt "), "ETHUSDT");
assert.equal(WL.wlSanitizeSymbol("bad-sym!"), null);
assert.equal(WL.wlSanitizeSymbol("<script>"), null);
assert.equal(WL.wlSanitizeSymbol(""), null);

// New doc seeds one "Favorites" list, active.
let wdoc = WL.wlNewDoc();
assert.equal(wdoc.version, 1);
assert.equal(wdoc.lists.length, 1);
assert.equal(wdoc.lists[0].name, "Favorites");
assert.deepEqual(wdoc.lists[0].symbols, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
assert.equal(wdoc.activeId, wdoc.lists[0].id);

// CRUD.
const wl2 = WL.wlCreate(wdoc, "Scalping");
assert.ok(wl2 && wdoc.activeId === wl2.id && wdoc.lists.length === 2);
assert.equal(WL.wlRename(wdoc, wl2.id, "  Swing  "), true);
assert.equal(WL.wlFindList(wdoc, wl2.id).name, "Swing");
assert.equal(WL.wlRename(wdoc, wl2.id, "   "), false); // empty rejected

// Add / dedup / remove symbols.
assert.equal(WL.wlAddSymbol(wdoc, wl2.id, "solusdt"), true);
assert.equal(WL.wlFindList(wdoc, wl2.id).symbols[0], "SOLUSDT");
assert.equal(WL.wlAddSymbol(wdoc, wl2.id, "SOLUSDT"), false, "duplicate rejected");
assert.equal(WL.wlAddSymbol(wdoc, wl2.id, "bad!"), false, "invalid rejected");
WL.wlAddSymbol(wdoc, wl2.id, "XRPUSDT");
assert.equal(WL.wlRemoveSymbol(wdoc, wl2.id, "SOLUSDT"), true);
assert.deepEqual(WL.wlFindList(wdoc, wl2.id).symbols, ["XRPUSDT"]);

// Favorites toggle (only for symbols present in the list).
WL.wlAddSymbol(wdoc, wl2.id, "BTCUSDT");
assert.equal(WL.wlToggleFav(wdoc, wl2.id, "BTCUSDT"), true);
assert.ok(WL.wlFindList(wdoc, wl2.id).favs.includes("BTCUSDT"));
WL.wlToggleFav(wdoc, wl2.id, "BTCUSDT");
assert.ok(!WL.wlFindList(wdoc, wl2.id).favs.includes("BTCUSDT"));
assert.equal(WL.wlToggleFav(wdoc, wl2.id, "NOTINLIST"), false);

// Reorder within a list (custom order).
const rl = WL.wlCreate(wdoc, "Order");
["AUSDT", "BUSDT", "CUSDT"].forEach((s) => WL.wlAddSymbol(wdoc, rl.id, s));
WL.wlReorder(wdoc, rl.id, "CUSDT", "AUSDT"); // move C before A
assert.deepEqual(WL.wlFindList(wdoc, rl.id).symbols, ["CUSDT", "AUSDT", "BUSDT"]);

// Move between lists.
assert.equal(WL.wlMoveSymbol(wdoc, rl.id, wl2.id, "BUSDT"), true);
assert.ok(!WL.wlFindList(wdoc, rl.id).symbols.includes("BUSDT"));
assert.ok(WL.wlFindList(wdoc, wl2.id).symbols.includes("BUSDT"));

// Delete: last list is undeletable; deleting the active re-activates another.
const dd = WL.wlNewDoc();
const only = dd.lists[0];
assert.equal(WL.wlDelete(dd, only.id), false, "last list undeletable");
const extra = WL.wlCreate(dd, "extra");
assert.equal(dd.activeId, extra.id);
WL.wlDelete(dd, extra.id);
assert.equal(dd.activeId, dd.lists[0].id, "active moves after deleting it");

// Corrupt / future-version storage → fresh defaults + corrupt flag.
assert.equal(WL.wlParseDoc("{bad json").corrupt, true);
assert.equal(WL.wlParseDoc(JSON.stringify({ version: 99, lists: [] })).corrupt, true);
assert.equal(WL.wlParseDoc(null).corrupt, false);
const rtWl = WL.wlParseDoc(JSON.stringify(wdoc));
assert.equal(rtWl.corrupt, false);
assert.equal(rtWl.doc.lists.length, wdoc.lists.length);
// Sanitization drops hostile symbols on load.
const poisoned = WL.wlParseDoc(JSON.stringify({
  version: 1, activeId: "x",
  lists: [{ id: "x", name: "P", symbols: ["BTCUSDT", "bad!", "<script>", "ETHUSDT", "BTCUSDT"] }],
}));
assert.deepEqual(poisoned.doc.lists[0].symbols, ["BTCUSDT", "ETHUSDT"], "invalid/dupe symbols dropped");

// Import validation.
assert.equal(WL.wlValidateImport(null), null);
assert.equal(WL.wlValidateImport({ kind: "theme" }), null);
const wimp = WL.wlValidateImport({ kind: "watchlist", list: { name: "Imported", symbols: ["btcusdt", "junk!"] } });
assert.ok(wimp && wimp.name === "Imported");
assert.deepEqual(wimp.symbols, ["BTCUSDT"]);
assert.ok(wimp.id.startsWith("wl_"), "import mints a fresh id");

// Alert evaluation (pure; one-shot edge for above/below via prevPrice).
assert.equal(WL.wlEvalAlert({ kind: "above", value: 100 }, { lastPrice: 101 }, 99), true, "crossed up");
assert.equal(WL.wlEvalAlert({ kind: "above", value: 100 }, { lastPrice: 101 }, 100.5), false, "already above → no re-fire");
assert.equal(WL.wlEvalAlert({ kind: "below", value: 100 }, { lastPrice: 99 }, 101), true, "crossed down");
assert.equal(WL.wlEvalAlert({ kind: "pct_up", value: 5 }, { price24hPcnt: 0.06 }), true);
assert.equal(WL.wlEvalAlert({ kind: "pct_down", value: -5 }, { price24hPcnt: -0.06 }), true);
assert.equal(WL.wlEvalAlert({ kind: "funding_abs", value: 0.05 }, { fundingRate: -0.001 }), true, "|−0.1%| ≥ 0.05%");
assert.equal(WL.wlEvalAlert({ kind: "funding_abs", value: 0.5 }, { fundingRate: 0.0001 }), false);

// Sort + filter view (pure). index maps symbol → metrics.
const idx = {
  AAA: { lastPrice: 10, price24hPcnt: 0.08, turnover24h: 300, fundingRate: 0.001, openInterest: 5 },
  BBB: { lastPrice: 30, price24hPcnt: -0.02, turnover24h: 900, fundingRate: -0.002, openInterest: 9 },
  CCC: { lastPrice: 20, price24hPcnt: 0.01, turnover24h: 100, fundingRate: 0.003, openInterest: 1 },
};
const syms = ["AAA", "BBB", "CCC"];
// Custom keeps order, favorites float to top.
assert.deepEqual(WL.wlComputeView(syms, ["CCC"], idx, { filter: "all", sort: "custom" }), ["CCC", "AAA", "BBB"]);
// Sort by price descending / ascending.
assert.deepEqual(WL.wlComputeView(syms, [], idx, { sort: "price", dir: "desc" }), ["BBB", "CCC", "AAA"]);
assert.deepEqual(WL.wlComputeView(syms, [], idx, { sort: "price", dir: "asc" }), ["AAA", "CCC", "BBB"]);
// Sort by 24h % / volume.
assert.deepEqual(WL.wlComputeView(syms, [], idx, { sort: "pct", dir: "desc" }), ["AAA", "CCC", "BBB"]);
assert.deepEqual(WL.wlComputeView(syms, [], idx, { sort: "vol", dir: "desc" }), ["BBB", "AAA", "CCC"]);
// Filters combine with search.
assert.deepEqual(WL.wlComputeView(syms, [], idx, { filter: "gainers", sort: "symbol", dir: "asc" }), ["AAA", "CCC"]);
assert.deepEqual(WL.wlComputeView(syms, [], idx, { filter: "losers" }), ["BBB"]);
assert.deepEqual(WL.wlComputeView(syms, [], idx, { filter: "movers" }), ["AAA"], "only |24h|≥5%");
assert.deepEqual(WL.wlComputeView(syms, ["BBB"], idx, { filter: "fav" }), ["BBB"]);
assert.deepEqual(WL.wlComputeView(syms, [], idx, { filter: "all", query: "bb" }), ["BBB"]);

// Large watchlist: cap + dedup enforced through the sanitizer at load.
const big = [];
for (let i = 0; i < 600; i++) big.push("S" + i + "USDT");
const bigDoc = WL.wlParseDoc(JSON.stringify({ version: 1, activeId: "b", lists: [{ id: "b", name: "Big", symbols: big }] }));
assert.equal(bigDoc.doc.lists[0].symbols.length, 500, "WL_MAX_SYMBOLS cap enforced on load");

// ---------------------------------------------------------------------------
// Market Scanner core — the PURE engine of the Scan tab (metric accessors,
// rule engine, presets/filters/search/sort pipeline, section ranking, alert
// evaluation, storage sanitization, workspace view state). DOM-free.
// ---------------------------------------------------------------------------
const scConsts = ["SC_SCHEMA_VERSION", "SC_MAX_SCANS", "SC_MAX_RULES", "SC_MAX_ALERTS",
  "SC_MAX_LOG", "SC_MAX_FAVS", "SC_SYMBOL_RE", "SC_TOP_N", "SC_METRICS", "SC_OPS",
  "SC_SORTS", "SC_PRESETS", "SC_SECTION_IDS", "SC_ALERT_KINDS", "SC_ALERT_COOLDOWN_MS"]
  .map(extractConst).join("\n");
const scFns = ["scId", "scMetric", "scSanitizeRule", "scEvalRule", "scScanMatches",
  "scSanitizeScan", "scSanitizeAlert", "scAlertLabel", "scTopMovers", "scEvalAlerts",
  "scSanitizeLogEntry", "scNewDoc", "scParseDoc", "scSanitizeViewState", "scFuzzyScore",
  "scComputeView", "scSectionRows"].map(extractFn).join("\n");
const SC = new Function(scConsts + "\n" + scFns +
  "\nreturn { scMetric, scSanitizeRule, scEvalRule, scScanMatches, scSanitizeScan, scSanitizeAlert, scAlertLabel, scTopMovers, scEvalAlerts, scNewDoc, scParseDoc, scSanitizeViewState, scFuzzyScore, scComputeView, scSectionRows };")();

// Row factory shaped like /api/scanner rows (percent metrics are PERCENT
// numbers; fundingRate stays a fraction exactly as the exchange reports it).
const scRow = (symbol, over) => Object.assign({
  symbol, last: 100, pct5m: 0, pct15m: 0, pct1h: 0, pct24h: 0,
  high24h: 110, low24h: 90, range24hPct: 20, vol15mPct: 0.2,
  turnover24h: 1e6, turnoverDelta15m: 0, fundingRate: 0.0001, fundingDelta1h: 0,
  openInterestValue: 5e6, bid1: 99.9, ask1: 100.1, spark: [1, 2],
}, over || {});

// --- metric accessor: derived metrics + the null trust boundary ---
assert.equal(SC.scMetric(scRow("A"), "last"), 100);
assert.equal(SC.scMetric(scRow("A", { fundingRate: 0.0005 }), "fundingPct"), 0.05, "funding fraction → percent");
assert.equal(SC.scMetric(scRow("A", { fundingDelta1h: -0.0002 }), "fundingDelta1hPct"), -0.02);
assert.ok(Math.abs(SC.scMetric(scRow("A", { last: 99, high24h: 100 }), "distHigh24hPct") - 1) < 1e-9);
assert.ok(Math.abs(SC.scMetric(scRow("A", { last: 91, low24h: 90 }), "distLow24hPct") - (1 / 90) * 100) < 1e-9);
assert.ok(Math.abs(SC.scMetric(scRow("A"), "spreadPct") - 0.2) < 1e-9);
assert.equal(SC.scMetric(scRow("A", { pct15m: null }), "pct15m"), null, "null stays null");
assert.equal(SC.scMetric(scRow("A", { pct15m: "garbage" }), "pct15m"), null);
assert.equal(SC.scMetric(scRow("A", { fundingRate: null }), "fundingPct"), null);
assert.equal(SC.scMetric(null, "last"), null);

// --- rule engine: operators, null-metric refusal, AND/OR ---
assert.equal(SC.scEvalRule({ metric: "pct24h", op: "gte", value: 5 }, scRow("A", { pct24h: 5 })), true);
assert.equal(SC.scEvalRule({ metric: "pct24h", op: "gt", value: 5 }, scRow("A", { pct24h: 5 })), false);
assert.equal(SC.scEvalRule({ metric: "pct24h", op: "lte", value: -5 }, scRow("A", { pct24h: -6 })), true);
assert.equal(SC.scEvalRule({ metric: "pct24h", op: "absGte", value: 5 }, scRow("A", { pct24h: -6 })), true);
assert.equal(SC.scEvalRule({ metric: "pct24h", op: "absLte", value: 5 }, scRow("A", { pct24h: -6 })), false);
assert.equal(SC.scEvalRule({ metric: "pct15m", op: "gte", value: 0 }, scRow("A", { pct15m: null })), false,
  "a missing metric can NEVER satisfy a rule — warmup must not fake matches");
const andScan = SC.scSanitizeScan({ id: "s1", name: "big movers", mode: "and", rules: [
  { metric: "pct24h", op: "absGte", value: 5 }, { metric: "turnover24h", op: "gte", value: 1e6 }] });
assert.ok(andScan);
assert.equal(SC.scScanMatches(andScan, scRow("A", { pct24h: 6, turnover24h: 2e6 })), true);
assert.equal(SC.scScanMatches(andScan, scRow("A", { pct24h: 6, turnover24h: 1 })), false, "AND needs all");
const orScan = SC.scSanitizeScan({ id: "s2", mode: "or", rules: [
  { metric: "pct24h", op: "gte", value: 5 }, { metric: "fundingPct", op: "absGte", value: 0.05 }] });
assert.equal(SC.scScanMatches(orScan, scRow("A", { pct24h: 0, fundingRate: 0.001 })), true, "OR needs one");
assert.equal(SC.scScanMatches(orScan, scRow("A", { pct24h: 0 })), false);
// Sanitization: bad rules dropped; a scan with no valid rule is rejected.
const dirtyScan = SC.scSanitizeScan({ id: "s3", mode: "xor", rules: [
  { metric: "nope", op: "gte", value: 1 }, { metric: "pct24h", op: "gte", value: "7" },
  { metric: "pct24h", op: "gte", value: "NaN" }] });
assert.equal(dirtyScan.mode, "and", "unknown mode → and");
assert.equal(dirtyScan.rules.length, 1, "invalid metric / non-numeric value dropped");
assert.equal(SC.scSanitizeScan({ id: "s4", rules: [{ metric: "nope", op: "gt", value: 1 }] }), null);
assert.equal(SC.scSanitizeScan({ rules: [{ metric: "pct24h", op: "gt", value: 1 }] }), null, "id required");

// --- alert sanitization ---
assert.equal(SC.scSanitizeAlert(null), null);
assert.equal(SC.scSanitizeAlert({ kind: "unknown", symbol: "BTCUSDT", value: 1 }), null);
const tm = SC.scSanitizeAlert({ kind: "top_mover" });
assert.ok(tm && tm.symbol === "*" && tm.value === 10, "top_mover defaults: any symbol, rank 10");
assert.equal(SC.scSanitizeAlert({ kind: "top_mover", value: 99 }).value, 10, "out-of-range rank → default");
assert.equal(SC.scSanitizeAlert({ kind: "vol_double", symbol: "*", baseline: 100 }), null,
  "vol_double needs a concrete symbol");
assert.equal(SC.scSanitizeAlert({ kind: "vol_double", symbol: "BTCUSDT" }), null, "…and a baseline");
assert.ok(SC.scSanitizeAlert({ kind: "vol_double", symbol: "btcusdt", baseline: 5e6 }).symbol === "BTCUSDT");
assert.equal(SC.scSanitizeAlert({ kind: "vol15m", symbol: "BTCUSDT", value: 0 }), null, "threshold must be > 0");
assert.ok(SC.scSanitizeAlert({ kind: "funding_abs", symbol: "*", value: 0.05 }));

// --- alert evaluation ---
const mkIdx = (rows) => { const o = {}; rows.forEach((r) => { o[r.symbol] = r; }); return o; };
{
  const rows = [scRow("AAA", { pct24h: 9 }), scRow("BBB", { pct24h: 8 }), scRow("CCC", { pct24h: 7 })];
  const top = SC.scTopMovers(rows, 25);
  assert.deepEqual(top, ["AAA", "BBB", "CCC"]);
  const alert = SC.scSanitizeAlert({ kind: "top_mover", value: 3 });
  // First snapshot (prev null): NOTHING fires — boot is not "entering".
  assert.equal(SC.scEvalAlerts([alert], { index: mkIdx(rows), topMovers: top, prevTopMovers: null }, 1000).length, 0);
  // Sitting on the board: no fire. New entrant: fires once.
  assert.equal(SC.scEvalAlerts([alert], { index: mkIdx(rows), topMovers: top, prevTopMovers: top }, 1000).length, 0);
  const fired = SC.scEvalAlerts([alert], { index: mkIdx(rows), topMovers: top, prevTopMovers: ["AAA", "BBB", "ZZZ"] }, 1000);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].symbol, "CCC");
  // Rank semantics: moving 4th → 2nd ENTERS a top-3 board even though the
  // symbol sat on the deeper (25-rank) board before.
  const deepPrev = ["AAA", "BBB", "DDD", "CCC"];
  const nowTop = ["AAA", "CCC", "BBB", "DDD"];
  const f2 = SC.scEvalAlerts([alert], { index: mkIdx(rows), topMovers: nowTop, prevTopMovers: deepPrev }, 1000);
  assert.deepEqual(f2.map((f) => f.symbol), ["CCC"]);
  // Cooldown: a recent lastFired suppresses the re-fire.
  const cooled = SC.scSanitizeAlert({ kind: "top_mover", value: 3, lastFired: { CCC: 900 } });
  assert.equal(SC.scEvalAlerts([cooled], { index: mkIdx(rows), topMovers: top, prevTopMovers: ["AAA", "BBB", "ZZZ"] }, 1000).length, 0);
  assert.equal(SC.scEvalAlerts([cooled], { index: mkIdx(rows), topMovers: top, prevTopMovers: ["AAA", "BBB", "ZZZ"] },
    900 + 30 * 60000 + 1).length, 1, "…and expires after the cooldown");
}
{
  const a = SC.scSanitizeAlert({ kind: "vol_double", symbol: "AAA", baseline: 1e6 });
  const under = [scRow("AAA", { turnover24h: 1.9e6 })];
  const over = [scRow("AAA", { turnover24h: 2e6 })];
  assert.equal(SC.scEvalAlerts([a], { index: mkIdx(under), topMovers: [], prevTopMovers: [] }, 1).length, 0);
  assert.equal(SC.scEvalAlerts([a], { index: mkIdx(over), topMovers: [], prevTopMovers: [] }, 1).length, 1);
}
{
  const vol = SC.scSanitizeAlert({ kind: "vol15m", symbol: "*", value: 2 });
  const mv = SC.scSanitizeAlert({ kind: "move15m", symbol: "AAA", value: 1 });
  const fn = SC.scSanitizeAlert({ kind: "funding_abs", symbol: "*", value: 0.05 });
  const rows = [scRow("AAA", { vol15mPct: 2.5, pct15m: -1.2, fundingRate: -0.001 }),
                scRow("BBB", { vol15mPct: 0.1, pct15m: 0.1, fundingRate: 0.0001 })];
  const fired = SC.scEvalAlerts([vol, mv, fn], { index: mkIdx(rows), topMovers: [], prevTopMovers: [] }, 1);
  const bySym = fired.map((f) => f.alert.kind + ":" + f.symbol).sort();
  assert.deepEqual(bySym, ["funding_abs:AAA", "move15m:AAA", "vol15m:AAA"],
    "wildcard scans every symbol; |−1.2%| ≥ 1 and |−0.1%| funding ≥ 0.05 fire");
  // Warm-up honesty: null metrics never fire threshold alerts.
  const cold = [scRow("AAA", { vol15mPct: null, pct15m: null })];
  assert.equal(SC.scEvalAlerts([vol, mv], { index: mkIdx(cold), topMovers: [], prevTopMovers: [] }, 1).length, 0);
}

// --- storage document: corrupt recovery + caps ---
assert.equal(SC.scParseDoc("{nope").corrupt, true);
assert.equal(SC.scParseDoc(JSON.stringify({ version: 99 })).corrupt, true, "future schema quarantined");
assert.equal(SC.scParseDoc(null).corrupt, false);
{
  const doc = SC.scNewDoc();
  doc.favs = ["BTCUSDT", "bad sym!", "ethusdt", "BTCUSDT"];
  doc.scans = new Array(30).fill(0).map((_, i) => ({ id: "s" + i, name: "n" + i, rules: [{ metric: "pct24h", op: "gt", value: i }] }));
  doc.alerts = [{ kind: "vol15m", symbol: "BTCUSDT", value: 1 }, { kind: "vol15m", symbol: "BTCUSDT", value: -1 }];
  doc.log = [{ ts: 1, msg: "x".repeat(500) }, { msg: "" }];
  const rt = SC.scParseDoc(JSON.stringify(doc));
  assert.equal(rt.corrupt, false);
  assert.deepEqual(rt.doc.favs, ["BTCUSDT", "ETHUSDT"], "favs sanitized + deduped");
  assert.equal(rt.doc.scans.length, 20, "SC_MAX_SCANS cap");
  assert.equal(rt.doc.alerts.length, 1, "invalid alert dropped");
  assert.equal(rt.doc.log.length, 1);
  assert.equal(rt.doc.log[0].msg.length, 140, "log messages capped");
}

// --- workspace view state (persisted per workspace) ---
{
  const st = SC.scSanitizeViewState(null);
  assert.equal(st.preset, "all");
  assert.equal(st.sort, "pct24h");
  assert.equal(st.dir, "desc");
  assert.deepEqual(st.sections.order, ["movers", "losers", "volume", "volatility", "funding", "active", "watchlist", "alerts"]);
  const dirty = SC.scSanitizeViewState({
    preset: "evil", sort: "<script>", dir: "sideways", pinFavs: 1, cards: false,
    filters: { priceMin: "5", priceMax: "junk", turnoverMin: 1e6, unknown: 4 },
    sections: { order: ["alerts", "alerts", "nope", "movers"], collapsed: { movers: true, evil: true } },
    sel: "btc usdt", scroll: -50,
  });
  assert.equal(dirty.preset, "all", "unknown preset → all");
  assert.equal(dirty.sort, "pct24h");
  assert.equal(dirty.pinFavs, true);
  assert.equal(dirty.cards, false);
  assert.equal(dirty.filters.priceMin, 5);
  assert.equal(dirty.filters.priceMax, null, "non-numeric filter → off");
  assert.equal(dirty.filters.unknown, undefined, "unknown filter keys dropped");
  assert.equal(dirty.sections.order[0], "alerts");
  assert.equal(dirty.sections.order.length, 8, "missing sections appended, dupes/unknowns dropped");
  assert.deepEqual(Object.keys(dirty.sections.collapsed), ["movers"]);
  assert.equal(dirty.sel, "", "invalid symbol dropped");
  assert.equal(dirty.scroll, 0, "negative scroll clamped");
  assert.equal(SC.scSanitizeViewState({ preset: "scan:scan_abc123" }).preset, "scan:scan_abc123",
    "custom scan preset ids survive");
  // Workspace integration end-to-end: wsSanitizeState carries the scanner view.
  const ws = WS.wsSanitizeState({ tab: "scanner", scanner: { preset: "momentum", sort: "turnover24h", dir: "asc" } });
  assert.equal(ws.tab, "scanner", "scanner is a valid workspace tab");
  assert.equal(ws.scanner.preset, "momentum");
  assert.equal(ws.scanner.sort, "turnover24h");
  assert.equal(ws.scanner.dir, "asc");
  assert.equal(WS.wsSanitizeState({}).scanner.preset, "all", "default scanner state always present");
}

// --- fuzzy search ---
assert.equal(SC.scFuzzyScore("BTCUSDT", "BTC"), 3, "prefix");
assert.equal(SC.scFuzzyScore("WBTCUSDT", "BTC"), 2, "substring");
assert.equal(SC.scFuzzyScore("BTCUSDT", "BCT"), 1, "in-order subsequence (B…C…T)");
assert.equal(SC.scFuzzyScore("BTCUSDT", "TDB"), 0, "out-of-order letters never match");
assert.equal(SC.scFuzzyScore("BTCUSDT", "bud"), 1, "subsequence, case-insensitive");
assert.equal(SC.scFuzzyScore("BTCUSDT", "XRP"), 0);
assert.equal(SC.scFuzzyScore("BTCUSDT", ""), 0);

// --- the view pipeline: presets → filters → search → sort ---
{
  const rows = [
    scRow("UPUSDT", { pct24h: 12, pct15m: 1, pct1h: 3, turnover24h: 9e6, openInterestValue: 9e6 }),
    scRow("DOWNUSDT", { pct24h: -9, pct15m: 0.5, pct1h: -2, turnover24h: 5e6, openInterestValue: 5e6 }),
    scRow("FLATUSDT", { pct24h: 0.2, pct15m: 0.05, pct1h: 0.1, turnover24h: 1e6, openInterestValue: 1e6 }),
    scRow("WARMUSDT", { pct24h: 3, pct15m: null, pct1h: null, vol15mPct: null, turnover24h: 3e6, openInterestValue: 3e6 }),
    scRow("HIUSDT", { pct24h: 4, pct15m: -0.6, pct1h: -1.4, turnover24h: 7e6, openInterestValue: 7e6, last: 5000 }),
  ];
  const view = (over) => Object.assign({ preset: "all", query: "", sort: "pct24h", dir: "desc", pinFavs: false, filters: {} }, over || {});
  const syms = (out) => out.map((r) => r.symbol);

  assert.deepEqual(syms(SC.scComputeView(rows, view(), {})),
    ["UPUSDT", "HIUSDT", "WARMUSDT", "FLATUSDT", "DOWNUSDT"], "default: 24h% desc");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ dir: "asc" }), {})),
    ["DOWNUSDT", "FLATUSDT", "WARMUSDT", "HIUSDT", "UPUSDT"]);
  // Nulls sink regardless of direction.
  assert.deepEqual(syms(SC.scComputeView(rows, view({ sort: "pct15m", dir: "desc" }), {})).pop(), "WARMUSDT");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ sort: "pct15m", dir: "asc" }), {})).pop(), "WARMUSDT");
  // Presets.
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "gainers" }), {})),
    ["UPUSDT", "HIUSDT", "WARMUSDT", "FLATUSDT"]);
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "losers" }), {})), ["DOWNUSDT"]);
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "momentum" }), {})), ["UPUSDT", "HIUSDT"],
    "same-direction 15m+1h moves, either sign; warming rows excluded");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "meanrevert" }), {})), ["DOWNUSDT"],
    "|24h|≥8 with 15m pulling the other way");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "highvolume" }), {})), ["UPUSDT", "HIUSDT"],
    "top decile by turnover (5-sample quantile lands at 7e6)");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "largecaps" }), {})), ["UPUSDT", "HIUSDT"],
    "top quintile by OI value");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "smallcaps" }), {})),
    ["WARMUSDT", "FLATUSDT", "DOWNUSDT"], "bottom half by OI value");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "active" }), {})), ["UPUSDT", "HIUSDT", "DOWNUSDT"],
    "|15m| ≥ 0.3 only; WARMUSDT's null 15m is not active");
  const nearHigh = [scRow("BRKUSDT", { last: 109.8, high24h: 110, low24h: 90 }), scRow("MIDUSDT", { last: 100 })];
  assert.deepEqual(syms(SC.scComputeView(nearHigh, view({ preset: "breakout" }), {})), ["BRKUSDT"]);
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "favorites" }), { favs: ["FLATUSDT"] })), ["FLATUSDT"]);
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "watchlist" }), { watch: ["HIUSDT", "NOPEUSDT"] })), ["HIUSDT"]);
  // Custom scan preset via ctx.scans.
  const scan = SC.scSanitizeScan({ id: "x1", name: "hot", rules: [{ metric: "pct24h", op: "absGte", value: 8 }] });
  assert.deepEqual(syms(SC.scComputeView(rows, view({ preset: "scan:x1" }), { scans: [scan] })), ["UPUSDT", "DOWNUSDT"]);
  // Filters combine; rows missing a filtered metric are excluded.
  assert.deepEqual(syms(SC.scComputeView(rows, view({ filters: { turnoverMin: 5e6, pct24hAbsMin: 5 } }), {})),
    ["UPUSDT", "DOWNUSDT"]);
  assert.deepEqual(syms(SC.scComputeView(rows, view({ filters: { vol15mMin: 0.1 } }), {})).includes("WARMUSDT"), false,
    "null vol15m cannot pass a volatility filter");
  assert.deepEqual(syms(SC.scComputeView(rows, view({ filters: { priceMin: 1000 } }), {})), ["HIUSDT"]);
  // Search filters the universe…
  assert.deepEqual(syms(SC.scComputeView(rows, view({ query: "UP" }), {})), ["UPUSDT"]);
  // …and ranks matches: a prefix match outranks a substring match even when
  // the active sort would order them the other way.
  assert.deepEqual(syms(SC.scComputeView([scRow("ZUPUSDT"), scRow("UPZUSDT")],
    view({ query: "UP", sort: "symbol", dir: "asc" }), {})), ["UPZUSDT", "ZUPUSDT"]);
  // Pinned favorites float, groups keep sort inside.
  assert.deepEqual(syms(SC.scComputeView(rows, view({ pinFavs: true }), { favs: ["FLATUSDT", "DOWNUSDT"] })),
    ["FLATUSDT", "DOWNUSDT", "UPUSDT", "HIUSDT", "WARMUSDT"]);
}

// --- overview-card ranking ---
{
  const rows = [
    scRow("AAA", { pct24h: 9, pct15m: 2, vol15mPct: 3, turnover24h: 1e6, fundingRate: 0.002, fundingDelta1h: 0.0001 }),
    scRow("BBB", { pct24h: -7, pct15m: -3, vol15mPct: 4, turnover24h: 9e6, fundingRate: -0.003, fundingDelta1h: -0.0009 }),
    scRow("CCC", { pct24h: 2, pct15m: 0.5, vol15mPct: 1, turnover24h: 5e6, fundingRate: 0.0005, fundingDelta1h: 0.0004 }),
  ];
  const sy = (res) => res.rows.map((r) => r.symbol);
  assert.deepEqual(sy(SC.scSectionRows(rows, "movers", {})), ["AAA", "CCC"]);
  assert.deepEqual(sy(SC.scSectionRows(rows, "losers", {})), ["BBB"]);
  assert.deepEqual(sy(SC.scSectionRows(rows, "volume", {})), ["BBB", "CCC", "AAA"]);
  assert.deepEqual(sy(SC.scSectionRows(rows, "volatility", {})), ["BBB", "AAA", "CCC"]);
  assert.equal(SC.scSectionRows(rows, "volatility", {}).metric, "vol15mPct");
  // Volatility falls back to 24h range while 15m warms — and says so.
  const warm = rows.map((r) => scRow(r.symbol, { vol15mPct: null, range24hPct: r.turnover24h / 1e6 }));
  assert.equal(SC.scSectionRows(warm, "volatility", {}).metric, "range24hPct");
  assert.deepEqual(sy(SC.scSectionRows(rows, "funding", { fundingMode: "pos" })), ["AAA", "CCC", "BBB"]);
  assert.deepEqual(sy(SC.scSectionRows(rows, "funding", { fundingMode: "neg" })), ["BBB", "CCC", "AAA"]);
  assert.deepEqual(sy(SC.scSectionRows(rows, "funding", { fundingMode: "delta" })), ["BBB", "CCC", "AAA"]);
  assert.deepEqual(sy(SC.scSectionRows(rows, "active", {})), ["BBB", "AAA", "CCC"], "by |15m|");
  assert.deepEqual(sy(SC.scSectionRows(rows, "watchlist", { watch: ["CCC", "BBB"] })), ["BBB", "CCC"]);
  assert.deepEqual(sy(SC.scSectionRows(rows, "movers", { limit: 1 })), ["AAA"], "limit respected");
  // No funding data → empty rows (the DOM shows the capability note instead).
  const noFund = rows.map((r) => scRow(r.symbol, { fundingRate: null, fundingDelta1h: null }));
  assert.equal(SC.scSectionRows(noFund, "funding", {}).rows.length, 0);
}

// --- performance guard: the full pipeline over a large universe ---
{
  const big = [];
  for (let i = 0; i < 2000; i++) {
    big.push(scRow("S" + i + "USDT", {
      pct24h: (i % 41) - 20, pct15m: ((i * 7) % 11) - 5, pct1h: ((i * 3) % 13) - 6,
      turnover24h: 1e4 + i * 1e4, last: 1 + (i % 500),
    }));
  }
  const t0 = Date.now();
  let out;
  for (let k = 0; k < 10; k++) {
    out = SC.scComputeView(big, { preset: "momentum", query: "S1", sort: "turnover24h", dir: "desc",
      filters: { turnoverMin: 1e5 } }, { favs: [], watch: [], scans: [] });
  }
  const elapsed = Date.now() - t0;
  assert.ok(out.length > 0 && out.length < big.length);
  for (let k = 1; k < out.length; k++) {
    const sPrev = SC.scFuzzyScore(out[k - 1].symbol, "S1");
    const sCur = SC.scFuzzyScore(out[k].symbol, "S1");
    assert.ok(sCur > 0, "search applied");
    assert.ok(sPrev >= sCur, "ranked by match quality first");
    if (sPrev === sCur) {
      assert.ok(SC.scMetric(out[k - 1], "turnover24h") >= SC.scMetric(out[k], "turnover24h"),
        "sorted by turnover within equal match rank");
    }
  }
  assert.ok(elapsed < 2000, `10 full pipeline passes over 2000 symbols took ${elapsed}ms (must stay interactive)`);
}

console.log("snapToStep + projectedPnl + workspace-core + watchlist-core + scanner-core regression tests passed");
