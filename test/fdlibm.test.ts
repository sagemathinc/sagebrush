import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The elementary functions of src/runtime/fdlibm.ts and libm.ts give the same
// bits in every JavaScript engine (TimeTravel replays a session in another
// browser: design/timetravel-replay.md), and those ported from glibc are
// glibc's.  (Their agreement with the Rust libm crate they are ported from is
// checked by bench/libm-oracle, which needs Rust.)

const runtime = join(__dirname, "..", "src", "runtime");
// a script computing every function on pseudo-random inputs: a hash of the bits per function
const SCRIPT = `
const FD = require(${JSON.stringify(join(runtime, "fdlibm.js"))});
const L = require(${JSON.stringify(join(runtime, "libm.js"))});
let s = 12345;
const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; s ^= s << 13; s >>>= 0; return s / 4294967296; };
const F = new Float64Array(1), U = new Uint32Array(F.buffer);
const xs = [0, -0, 1, -1, Infinity, -Infinity, NaN, 5e-324, 1e-310, 1.7976931348623157e308, Math.PI, 1e22, 709.78, -745];
for (let i = 0; i < 40000; i++) xs.push((rnd() - 0.5) * 2 ** (rnd() * 60 - 30));
for (let i = 0; i < 4000; i++) { U[0] = (rnd() * 4294967296) >>> 0; U[1] = (rnd() * 4294967296) >>> 0; xs.push(F[0]); }
const fns = {
  sin: FD.sin, cos: FD.cos, tan: FD.tan, asin: FD.asin, acos: FD.acos, atan: FD.atan, sinh: FD.sinh, cosh: FD.cosh,
  tanh: FD.tanh, asinh: FD.asinh, acosh: FD.acosh, atanh: FD.atanh, expm1: FD.expm1, log2: FD.log2, log10: FD.log10,
  cbrt: FD.cbrt, atan2: (x) => FD.atan2(x, 0.7), hypot: (x) => FD.v8hypot(x, 1.3, x / 3),
  exp: L.glibcExp, log: L.glibcLog, log1p: L.glibcLog1p, pow: (x) => L.glibcPow(Math.abs(x), 1.37), powi: (x) => L.glibcPow(x, 7),
};
const out = {};
for (const [k, f] of Object.entries(fns)) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  // (NaNs alike: engines differ in a NaN's sign and payload bits)
  for (const x of xs) { const v = f(x); F[0] = v === v ? v : NaN; if (v !== v) { U[0] = 0; U[1] = 0x7ff80000; } for (const w of [U[0], U[1]]) { h1 = Math.imul(h1 ^ w, 2654435761); h2 = Math.imul(h2 ^ w, 1597334677); } }
  out[k] = (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}
console.log(JSON.stringify(out));
`;

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("elementary functions: the same bits in V8 (node) and JavaScriptCore (bun)", { skip: !has("bun") && "no bun here" }, () => {
  const file = join(mkdtempSync(join(tmpdir(), "fdlibm-")), "bits.js");
  writeFileSync(file, SCRIPT);
  const v8 = JSON.parse(execFileSync(process.execPath, [file], { encoding: "utf8" }));
  const jsc = JSON.parse(execFileSync("bun", [file], { encoding: "utf8" }));
  assert.equal(Object.keys(v8).length, 23);
  assert.deepEqual(jsc, v8);
});

test("exp, log, log1p, pow, cosh, log10: glibc's bits (CPython's math)", { skip: !has("python3") && "no python3 here" }, () => {
  const FD = require(join(runtime, "fdlibm.js"));
  const L = require(join(runtime, "libm.js"));
  let s = 777;
  const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; s ^= s << 13; s >>>= 0; return s / 4294967296; };
  const n = 20000;
  const pos = Array.from({ length: n }, () => 2 ** (rnd() * 200 - 100) * (1 + rnd()));
  const sm = Array.from({ length: n }, () => (rnd() - 0.5) * 2 ** (rnd() * 12 - 4));
  const py = Array.from({ length: n }, () => (rnd() - 0.5) * 80);
  const file = join(mkdtempSync(join(tmpdir(), "glibc-")), "in.json");
  writeFileSync(file, JSON.stringify({ pos, sm, py }));
  // (bits as strings: JSON numbers are doubles)
  const ref = JSON.parse(execFileSync("python3", ["-c", `
import json, math, struct
d = json.load(open(${JSON.stringify(file)}))
b = lambda v: str(struct.unpack('<q', struct.pack('<d', v))[0])
def safe(f, *a):
    try: return b(f(*a))
    except (OverflowError, ValueError): return None
print(json.dumps({
  'exp': [safe(math.exp, x) for x in d['sm']], 'log': [b(math.log(x)) for x in d['pos']],
  'log1p': [b(math.log1p(x)) for x in d['pos']], 'log10': [b(math.log10(x)) for x in d['pos']],
  'cosh': [safe(math.cosh, x) for x in d['sm']], 'pow': [safe(math.pow, x, y) for x, y in zip(d['pos'], d['py'])],
}))`], { encoding: "utf8", maxBuffer: 1 << 26 }));
  const F = new Float64Array(1), B = new BigInt64Array(F.buffer);
  const bits = (v: number) => ((F[0] = v), B[0].toString());
  const check = (name: string, f: (i: number) => number) => {
    let bad = 0, ex = "";
    ref[name].forEach((r: string | null, i: number) => {
      if (r !== null && bits(f(i)) !== r) { bad++; ex ||= `#${i}`; }
    });
    assert.equal(bad, 0, `${name}: ${bad} of ${n} differ from glibc (${ex})`);
  };
  check("exp", (i) => L.glibcExp(sm[i]));
  check("log", (i) => L.glibcLog(pos[i]));
  check("log1p", (i) => L.glibcLog1p(pos[i]));
  check("log10", (i) => FD.log10(pos[i]));
  check("cosh", (i) => FD.cosh(sm[i]));
  check("pow", (i) => L.glibcPow(pos[i], py[i]));
});
