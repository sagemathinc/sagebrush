// src/runtime/fdlibm.ts against the Rust libm crate it is ported from,
// compiled to WebAssembly (no fused multiply-adds there, as in JavaScript):
// every function bit for bit on 2*10^6 inputs.  From the repository root:
//   (cd bench/libm-oracle && cargo build --release --target wasm32-unknown-unknown)
//   npx tsc -p . && N=2000000 node bench/libm-oracle/check.mjs     (bun, deno: other engines)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = require("../../dist/src/runtime/fdlibm.js");
const w = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL("target/wasm32-unknown-unknown/release/sbmath.wasm", import.meta.url)))).exports;
let s = 12345 >>> 0;
const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; s ^= s << 13; s >>>= 0; return s / 4294967296; };
const F = new Float64Array(1), U = new Uint32Array(F.buffer);
const anyBits = () => { U[0] = (rnd() * 4294967296) >>> 0; U[1] = (rnd() * 4294967296) >>> 0; return F[0]; };
const specials = [0, -0, 1, -1, 0.5, -0.5, 2, Infinity, -Infinity, NaN, 5e-324, -5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, -1.7976931348623157e308,
  Math.PI, Math.PI / 2, Math.PI / 4, 3 * Math.PI / 2, 2 * Math.PI, 1e22, 1e300, 709.78, 710, -745, -746, 1e-310, 0.9999999999999999, 1.0000000000000002];
const gens = {
  wide: () => (rnd() - 0.5) * 2 ** (rnd() * 60 - 30),
  huge: () => (rnd() - 0.5) * 2 ** (rnd() * 2000 - 1000),
  bits: anyBits,
  unit: () => rnd() * 2 - 1,
  near1: () => 1 + (rnd() - 0.5) * 2 ** (-rnd() * 50),
  exp: () => (rnd() - 0.5) * 1500,
};
const same = (a, b) => Object.is(a, b) || (a !== a && b !== b);
const N = +(process.env.N ?? 1000000);
let bad = 0;
for (const name of ["sin", "cos", "tan", "asin", "acos", "atan", "muslSinh", "muslCosh", "muslTanh", "asinh", "acosh", "atanh", "exp", "muslExpm1", "log", "log2", "muslLog10", "log1p", "cbrt", "atan2", "hypot"]) {
  const two = name === "atan2" || name === "hypot";
  const f = L[name], g = w[name.replace(/^musl(.)/, (_m, c) => c.toLowerCase())];
  let diff = 0, n = 0, ex = "";
  const test = (x, y) => { n++; const a = two ? f(x, y) : f(x), b = two ? g(x, y) : g(x); if (!same(a, b)) { diff++; if (!ex) ex = `${name}(${x}${two ? ", " + y : ""}) = ${a} vs ${b}`; } };
  for (const x of specials) { if (two) for (const y of specials) test(x, y); else test(x, 0); }
  for (const gk of Object.keys(gens)) for (let i = 0; i < N / 6; i++) test(gens[gk](), gens[gk]());
  if (diff) bad++;
  console.log(`${name.padEnd(6)} ${diff ? "DIFF " + diff + " of " + n + "  e.g. " + ex : "identical on " + n}`);
}
console.log(bad ? `${bad} functions differ` : "all identical");
