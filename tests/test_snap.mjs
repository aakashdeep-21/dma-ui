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
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
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

console.log("snapToStep regression tests passed");
