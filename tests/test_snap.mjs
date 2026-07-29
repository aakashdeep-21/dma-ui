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
  "WS_CHART_VIEWS", "WS_INTERVALS", "WS_SYMBOL_RE"].map(extractConst).join("\n");
const wsFns = ["wsId", "wsSanitizeState", "wsMakeWorkspace", "wsSanitizeWorkspace",
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

console.log("snapToStep + projectedPnl + workspace-core regression tests passed");
