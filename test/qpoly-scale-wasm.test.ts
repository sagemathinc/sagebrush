// qpoly_scale, qpoly_derivative, qpoly_integral and qpoly_add on the
// production engine module (wasm/sagebrush-engine.wasm): a Stop's wall-clock
// latency on the calibration's slowest shapes.  The engine asks the host
// every 2^20 work units; units differ in cost, so the latency is measured:
// the host's flag is set partway through a call (at a wall-clock time T),
// and the call must trap within the deadline after T.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEADLINE_MS = 50;
// (each calibration call at least this long, 4x the deadline: a shorter
// one could end within the deadline of T whether or not Stop works)
const MIN_CALL_MS = 200;

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

// (the calibration's shapes, each long enough, at least MIN_CALL_MS, that a
// Stop at a quarter or half of the call is tested, not outrun by the call's
// own end)
const shapes: [string, string, string, string][] = [
  ["product-heavy: the 64th derivative of 20,000 1900-bit integers", "qpoly_derivative", range(20000, (i) => `${hx(i + 1)}${"a".repeat(475)}`), "40"],
  ["token-heavy: the integral of 600,000 small rationals", "qpoly_integral", range(600000, (i) => `${hx(((i * 31) % 4093) + 1)}/${hx((i % 61) + 2)}`), "1/3"],
  ["sum-heavy: two 50,000-term polynomials with large coprime denominators", "qpoly_add", range(50000, (i) => `${hx(i + 1)}${"c".repeat(60)}/${hx(2 * i + 1)}${"f".repeat(40)}`), range(50000, (i) => `-${hx(i + 7)}${"9".repeat(60)}/${hx(2 * i + 3)}${"e".repeat(40)}`)],
  ["gcd-heavy: 24,000 rationals by a 500/400-bit rational", "qpoly_scale", range(24000, (i) => `${hx(i * 7 + 1)}${"d".repeat(150)}/${hx((i % 97) + 3)}${"b".repeat(100)}`), `-${"e7".repeat(62)}/${"9".repeat(100)}`],
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
