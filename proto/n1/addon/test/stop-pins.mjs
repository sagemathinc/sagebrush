// #825 N1-1, uncounted: Stop from the main thread reaches an engine call blocked in a worker (host word, no
// SIGINT handler); stale and duplicate stops are inert; the add-on is reusable after a stop.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const addon = createRequire(import.meta.url)(process.env.SB_N1_ADDON);
if (!isMainThread) {
  const { op, token, ms } = workerData;
  const t0 = performance.now();
  let r;
  if (op === "spin") r = addon.spin(ms, BigInt(token));
  else if (op === "aplist") r = addon.call(JSON.stringify({ fn: "aplist", a: [0, 0, 1, -1, 0], n: ms }), BigInt(token));
  else if (op === "moments") r = addon.moments([0, 0, 1, -1, 0], ms, BigInt(token));
  parentPort.postMessage({ r: r.slice(0, 60), ms: performance.now() - t0 });
} else {
  const run = (op, token, ms) => new Promise((res) => { const w = new Worker(new URL(import.meta.url), { workerData: { op, token, ms } }); w.once("message", (m) => { w.terminate(); res(m); }); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  // 1. Stop during a blocking call
  let p = run("spin", 11, 5000); await sleep(200);
  assert.equal(addon.stop(99n), false, "stale token inert");
  assert.equal(addon.stop(11n), true);
  assert.equal(addon.stop(11n), false, "duplicate stop inert");
  let m = await p; assert.equal(m.r, '{"interrupted":true}'); out.push(`stop during spin: interrupted after ${m.ms.toFixed(0)} ms`);
  // 2. reuse after a stop
  m = await run("spin", 12, 100); assert.equal(m.r, '{"ok":"done"}'); out.push(`next call after stop: done in ${m.ms.toFixed(0)} ms`);
  // 3. late stop after the call ended does nothing to the next call
  assert.equal(addon.stop(12n), false, "late stop inert");
  m = await run("spin", 13, 100); assert.equal(m.r, '{"ok":"done"}'); out.push("late stop: inert, next call done");
  // 4. Stop during a rayon-parallel engine call (moments, all cores; it checks per prime)
  p = run("moments", 14, 200000000); await sleep(300);
  assert.equal(addon.stop(14n), true);
  m = await p; assert.equal(m.r, '{"interrupted":true}'); out.push(`stop during parallel moments(2e8): interrupted after ${m.ms.toFixed(0)} ms`);
  m = await run("aplist", 15, 1000); assert.ok(m.r.startsWith('{"ok":[['), m.r); out.push("an engine call after the stopped parallel call: ok");
  // 4b. aplist itself now checks per prime (#831): an accepted stop ends it
  p = run("aplist", 16, 20000000); await sleep(200);
  assert.equal(addon.stop(16n), true);
  m = await p; assert.equal(m.r, '{"interrupted":true}'); out.push(`stop during aplist(2e7): interrupted after ${m.ms.toFixed(0)} ms (#831's checks)`);
  // 5. no SIGINT handler installed by the add-on
  out.push(`SIGINT listeners in this process: ${process.listenerCount("SIGINT")}`);
  console.log(out.join("\n"));
}
