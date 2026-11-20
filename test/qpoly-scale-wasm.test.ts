// qpoly_scale, qpoly_derivative, qpoly_add, qpoly_sub and qpoly_eval on the
// production engine module (wasm/sagebrush-engine.wasm): a Stop's wall-clock
// latency on the calibration's slowest shapes.  The engine asks the host
// every 2^20 work units; units differ in cost, so the latency is measured:
// the host's flag is set partway through a call (at a wall-clock time T),
// and the call must trap within the deadline after T.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// (a smoke deadline for a shared CI runner, where parallel test files contend
// for the CPUs: the engine's 2^20-unit poll cadence, a few ms of work, is
// pinned strictly by the native Stop tests)
const DEADLINE_MS = 200;
// (each calibration call at least this long, 4x the deadline: a shorter
// one could end within the deadline of T whether or not Stop works)
const MIN_CALL_MS = 800;

let flag: () => number = () => 0;
const mod = new WebAssembly.Module(readFileSync(join(__dirname, "..", "..", "wasm", "sagebrush-engine.wasm")));

function instance() {
  return new WebAssembly.Instance(mod, { sagebrush: { interrupted: () => flag() } }).exports as any;
}

/** One call: the reply, and the moment the engine returned it, read before
 * the host decodes and frees the reply (host work no Stop can interrupt: a
 * several-MB reply's decoding can take tens of ms on a loaded host). */
function call(e: any, request: string): { out: string; returned: number } {
  const req = new TextEncoder().encode(request);
  const p = e.sb_alloc(req.length);
  new Uint8Array(e.memory.buffer, p, req.length).set(req);
  const r = e.sb_call(p, req.length);
  const returned = performance.now();
  const out = new TextDecoder().decode(new Uint8Array(e.memory.buffer, r, e.sb_reply_len()));
  e.sb_free(p, req.length);
  return { out, returned };
}

const range = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join(",");
const hx = (n: number) => n.toString(16);

// (pairs whose denominators are a large P times pseudo-random 48-limb
// cofactors: each pair's gcds run Lehmer over the whole length)
const P = BigInt("0x" + "9e3779b97f4a7c15".repeat(64));
let seed = 0x2026n;
const rnd = (limbs: number) => {
  let v = 0n;
  for (let i = 0; i < limbs; i++) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    v = (v << 64n) | seed;
  }
  return v | 1n;
};
const rpairs = (n: number, sign: string) => range(n, () => `${sign}${rnd(4).toString(16)}/${(P * rnd(48)).toString(16)}`);

// (shapes long enough, at least MIN_CALL_MS, that a Stop at a quarter or
// half of the call is tested, not outrun by the call's own end, within the
// request's 16 MiB and the reply's and memory's caps; the integral's work is
// too little per request byte to reach it, and its Stop is pinned by the
// native tests)
const shapes: [string, string, string, string][] = [
  ["product-heavy: the 1500th derivative of 6000 10,000-bit integers", "qpoly_derivative", range(6000, (i) => `${hx(i + 1)}${"a".repeat(2560)}`), "5dc"],
  ["gcd-heavy: 44,000 rationals by a 500/1600-bit rational", "qpoly_scale", range(44000, (i) => `${hx(i * 7 + 1)}${"d".repeat(150)}/${hx((i % 97) + 3)}${"b".repeat(100)}`), `-${"e7".repeat(62)}/${"9".repeat(400)}`],
  ["sum-heavy: 2500 pairs over denominators sharing a 4096-bit factor", "qpoly_add", rpairs(2500, ""), rpairs(2500, "-")],
  ["difference-heavy: 2500 pairs over denominators sharing a 4096-bit factor", "qpoly_sub", rpairs(2500, ""), rpairs(2500, "")],
  // (an evaluation's whole cap is about 1.2 s here: two shapes near it)
  ["product-heavy: a_i = 1/(i+1), 9000 terms, at -7/3", "qpoly_eval", range(9000, (i) => `1/${hx(i + 1)}`), "-7/3"],
  ["q = 1: 700 400-bit integers at a 2000-bit integer", "qpoly_eval", range(700, (i) => `${hx(i + 1)}${"5".repeat(100)}`), "d".repeat(500)],
];

for (const [name, fn, a, b] of shapes) {
  test(`${fn}: a Stop mid-run traps within ${DEADLINE_MS} ms (${name})`, () => {
    const req = `{"fn":"${fn}","a":"${a}","b":"${b}"}`;
    flag = () => 0;
    // (the calibration's instance made before t0: ms is the engine's alone)
    const calibration = instance();
    const t0 = performance.now();
    const { out: full, returned } = call(calibration, req);
    const ms = returned - t0;
    if (full.includes("unknown fn")) return;
    assert.ok(full.startsWith('{"ok"'), full.slice(0, 200));
    assert.ok(ms >= MIN_CALL_MS, `${name}: the call took ${ms.toFixed(1)} ms, under ${MIN_CALL_MS}: too short to test a Stop`);
    for (const frac of [0.25, 0.5]) {
      // (the instance made before T: its instantiation isn't the Stop's)
      const e = instance();
      const T = performance.now() + ms * frac;
      flag = () => (performance.now() >= T ? 1 : 0);
      // (the engine's own end: its return, or the trap)
      let trapped = false;
      let after: number;
      try {
        after = call(e, req).returned;
      } catch {
        after = performance.now();
        trapped = true;
      }
      flag = () => 0;
      // (a call that finished before T had nothing to stop)
      if (!trapped) {
        assert.ok(after < T + DEADLINE_MS, `${name}: ran past the flag without trapping`);
        continue;
      }
      assert.ok(after - T <= DEADLINE_MS, `${name}: the Stop took ${(after - T).toFixed(2)} ms after the flag`);
    }
  });
}
