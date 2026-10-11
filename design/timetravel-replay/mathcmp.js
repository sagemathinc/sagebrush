// Math.* in two JavaScript engines (design/timetravel-replay.md): the same
// pseudo-random inputs; writes each function's result bits to argv[2].
//   node mathcmp.js /tmp/m-v8.json && bun mathcmp.js /tmp/m-jsc.json, then compare
let s = 12345;
const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
const xs = [];
for (let i = 0; i < 200000; i++) xs.push((rnd() - 0.5) * 2 ** (rnd() * 40 - 20));
const fns = { sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: (x) => Math.exp(x % 700), log: (x) => Math.log(Math.abs(x)), pow: (x) => Math.pow(Math.abs(x), 1.37), atan2: (x) => Math.atan2(x, 0.7), atan: Math.atan, asin: (x) => Math.asin(x % 1), sinh: (x) => Math.sinh(x % 700), tanh: Math.tanh, cbrt: Math.cbrt, hypot: (x) => Math.hypot(x, 1.3), log1p: (x) => Math.log1p(Math.abs(x)), expm1: (x) => Math.expm1(x % 700) };
const out = {};
for (const [k, f] of Object.entries(fns)) {
  const a = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) a[i] = f(xs[i]);
  out[k] = Array.from(new Uint32Array(a.buffer));
}
require("fs").writeFileSync(process.argv[2], JSON.stringify(out));
