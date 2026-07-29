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

console.log("snapToStep + projectedPnl regression tests passed");
