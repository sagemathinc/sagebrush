// The history store's own JSON writer (stores.js jsonText, jsonTextSize: inertJson's copy written by writeJson)
// against JSON.stringify, the oracle: on astra's 5,000 generated inputs (from her size-property.mjs on 89685b0c:
// strings with escapes, lone surrogates and control characters, -0 and extreme numbers, null-prototype objects,
// undefined properties), the same text and the same measured size; invalid data and cycles refused.
//   bun web/notebook/test-json-text.mjs
import { jsonText, jsonTextSize } from "./stores.js";
let seed = 1; const rnd = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
const text = ["", "雪", "😀", "\\", "\"", "\n", "\u0000", "\ud800", "\udfff", "a\tb", "\u001f\u007f  "];
const scalar = () => [null, true, false, -0, 1e-9, 1e21, Number.MIN_VALUE, Number.MAX_VALUE, Math.floor(rnd() * 1e6), text[Math.floor(rnd() * text.length)]][Math.floor(rnd() * 10)];
function gen(depth) { if (!depth || rnd() < 0.5) return scalar(); if (rnd() < 0.5) return Array.from({ length: Math.floor(rnd() * 5) }, () => gen(depth - 1)); const o = Object.create(rnd() < 0.2 ? null : Object.prototype); for (let i = 0, n = Math.floor(rnd() * 5); i < n; i++) o[text[Math.floor(rnd() * text.length)] + i] = rnd() < 0.2 ? undefined : gen(depth - 1); return o; }
let checks = 0;
const fail = (what) => { console.error("FAIL: " + what); process.exit(1); };
for (let i = 0; i < 5000; i++) {
  const v = gen(5), e = JSON.stringify(v), n = e.length;
  if (jsonText(v) !== e) fail(`text differs: ${JSON.stringify({ v, e, t: jsonText(v) })}`);
  checks++;
  for (const max of [n, n + 10, n - 1]) { const actual = jsonTextSize(v, max), expected = n <= max ? n : -1; if (actual !== expected) fail(JSON.stringify({ v, max, n, actual, expected })); checks++; }
}
for (const v of [NaN, Infinity, -Infinity, undefined, [undefined]]) { if (jsonTextSize(v, 1e6) !== -1 || jsonText(v) !== null) fail("invalid accepted"); checks++; }
const cycle = {}; cycle.self = cycle; const ac = []; ac.push(ac); let dag = {}; for (let i = 0; i < 40; i++) dag = { l: dag, r: dag };
for (const v of [cycle, ac, dag]) { if (jsonTextSize(v, 33554432) !== -1) fail("cycle or oversized DAG accepted"); checks++; }
console.log(`ok: the history's JSON writer against JSON.stringify, ${checks} checks`);
