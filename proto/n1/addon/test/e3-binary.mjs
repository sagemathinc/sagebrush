// #825 N1-1 E3, uncounted development run: JSON vs binary for a reply-heavy call (aplist) and a
// request-heavy call (det). Kernel, encode/copy and decode are timed separately; results are checked equal.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const a = createRequire(import.meta.url)(process.env.SB_N1_ADDON);
const N = Number(process.env.E3_REPS ?? 7);
const med = (xs) => xs.slice().sort((x, y) => x - y)[xs.length >> 1];
const curve = [0, 0, 1, -1, 0];
// aplist: reply-only experiment
const J = { kernel: [], encode: [], decode: [] }, B = { kernel: [], encode: [], decode: [] }, F = { kernel: [], encode: [], decode: [] };
let pj, pb, pf;
for (let i = 0; i <= N; i++) {
  const rj = a.aplistJson(curve, 199999);
  let t = performance.now(); const oj = JSON.parse(rj.reply).ok; const dj = performance.now() - t;
  const rb = a.aplistBin(curve, 199999);
  t = performance.now();
  const dv = new DataView(rb.reply.buffer, rb.reply.byteOffset, rb.reply.byteLength), ob = [];
  for (let o = 0; o < dv.byteLength; o += 16) { const ap = dv.getBigInt64(o + 8, true); ob.push([Number(dv.getBigUint64(o, true)), ap === -(2n ** 63n) ? null : Number(ap)]); }
  const db = performance.now() - t;
  const rf = a.aplistF64(curve, 199999);
  t = performance.now();
  const fa = new Float64Array(rf.reply.buffer.slice(rf.reply.byteOffset, rf.reply.byteOffset + rf.reply.byteLength)), of = [];
  for (let o = 0; o < fa.length; o += 2) of.push([fa[o], Number.isNaN(fa[o + 1]) ? null : fa[o + 1]]);
  const df = performance.now() - t;
  if (i === 0) { pj = oj; pb = ob; pf = of; continue; }
  F.kernel.push(rf.kernelMs); F.encode.push(rf.encodeMs); F.decode.push(df);
  J.kernel.push(rj.kernelMs); J.encode.push(rj.encodeMs); J.decode.push(dj);
  B.kernel.push(rb.kernelMs); B.encode.push(rb.encodeMs); B.decode.push(db);
}
assert.deepEqual(pb, pj, "binary and JSON aplist agree");
assert.deepEqual(pf, pj, "f64 binary and JSON aplist agree");
// det: request experiment (the reply is ~540 digits either way)
let x = 12345n; const v = [];
for (let i = 0; i < 40000; i++) { x = (x * 1103515245n + 12345n) % 2147483648n; v.push(Number(x % 201n) - 100); }
const DT = { build: [], decode: [], kernel: [] }, DB = { build: [], decode: [], kernel: [] };
let dt0, db0;
for (let i = 0; i <= N; i++) {
  let t = performance.now(); const rows = []; for (let r = 0; r < 200; r++) rows.push(v.slice(r * 200, r * 200 + 200).join(",")); const text = rows.join(";"); const bt = performance.now() - t;
  const rt = a.detText(text);
  t = performance.now(); const arr = Int32Array.from(v); const bb = performance.now() - t;
  const rb = a.detBin(arr, 200);
  if (i === 0) { dt0 = rt.det; db0 = rb.det; continue; }
  DT.build.push(bt); DT.decode.push(rt.decodeMs); DT.kernel.push(rt.kernelMs);
  DB.build.push(bb); DB.decode.push(rb.decodeMs); DB.kernel.push(rb.kernelMs);
}
assert.equal(db0, dt0, "binary and text det agree");
const f = (o) => Object.entries(o).map(([k, xs]) => `${k} ${med(xs).toFixed(2)}`).join(", ");
console.log(`E3 (uncounted; median of ${N}, ms; ${new Date().toISOString()}; load ${(await import("node:os")).loadavg()[0].toFixed(1)})`);
console.log(`aplist(199999) 17,984 pairs, reply-only: JSON  ${f(J)}  (reply ${JSON.stringify({ ok: pj }).length} B)`);
console.log(`aplist(199999) 17,984 pairs, reply-only: binary i64 ${f(B)}  (reply ${pb.length * 16} B)`);
console.log(`aplist(199999) 17,984 pairs, reply-only: binary f64 ${f(F)}  (reply ${pf.length * 16} B; decode includes one copy into an aligned buffer)`);
console.log(`det 200x200, request: text   ${f(DT)}  (det ${dt0.replace("-", "").length} digits)`);
console.log(`det 200x200, request: binary ${f(DB)}`);
