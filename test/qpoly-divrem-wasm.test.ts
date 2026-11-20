// qpoly_divrem on the production engine module (wasm/sagebrush-engine.wasm):
// a Stop's wall-clock latency on the calibration's slowest shapes.  The
// engine asks the host every 2^20 work units; units differ in cost, so the
// latency is measured: the host's flag is set partway through a call (at a
// wall-clock time T), and the call must trap within the deadline after T.
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

const tok = (n: number, d: number) => (n < 0 ? "-" : "") + (d === 1 ? Math.abs(n).toString(16) : Math.abs(n).toString(16) + "/" + d.toString(16));
const range = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join(",");

// (the calibration's longest shape, cancel-heavy, and a longer update-heavy:
// each call long enough, at least MIN_CALL_MS, that a Stop at a quarter or
// half of it is tested, not outrun by the call's own end)
const shapes: [string, string, string][] = [
  ["cancel-heavy: dense 1000 / non-monic 500", range(1001, (i) => tok(3 * i + 1, (i % 12) + 1)), range(501, (i) => tok(3 * i + 6, (i % 12) + 1))],
  ["update-heavy: 2400 / non-monic 1200", range(2401, (i) => tok(((i * 7919) % 201) - 100, 1)), range(1201, (i) => (i === 1200 ? "3" : tok(((i * 104729) % 19) - 9, 1)))],
];

for (const [name, a, b] of shapes) {
  test(`qpoly_divrem: a Stop mid-run traps within ${DEADLINE_MS} ms (${name})`, () => {
    const req = `{"fn":"qpoly_divrem","a":"${a}","b":"${b}"}`;
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
