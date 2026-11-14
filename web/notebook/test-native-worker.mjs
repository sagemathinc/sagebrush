// ci: checks.3 order=45 runner=bun
// The page's side of the app's engine subprocess (native-worker.js) against a
// fake of the app's shell (engine_start, engine_send, engine_ack, engine_stop
// and the frame channel), with the engine's answers made here: no engine, or
// one that never starts or never greets (the page's own worker instead); the
// order of frames, a close never ahead of its interpreter's open and runs; an
// engine that ends while nothing runs (the next run fails, so the kernel
// restarts); every bound (bytes waiting before the greeting, bytes waiting
// for the shell, a hand-over that never completes); Stop sent urgent, ahead
// of a stalled queue; acknowledgements of what the page took.  Every wait is
// bounded.
//   bun web/notebook/test-native-worker.mjs
import { NativeWorker, LIMITS, _resetEngine, approxBytes } from "./native-worker.js";
import { encode, decode } from "../../app/engine/frames.mjs";

let failed = 0, passed = 0;
const ok = (c, what) => (c ? passed++ : (failed++, console.log("FAIL " + what)));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms = 3000) {
  for (let t = 0; t < ms; t += 10) {
    if (f()) return true;
    await tick(10);
  }
  return false;
}
LIMITS.startMs = 300;
LIMITS.sendMs = 300;

/** A fake shell: `start` answers engine_start (true, false, or "hang"); `greet` whether the engine says hello;
 * `hold(frame)` keeps a hand-over pending until released.  sent: each frame the engine got, decoded. */
function fakeCore({ start = true, greet = true, hold = () => false } = {}) {
  const c = { sent: [], urgent: [], acks: 0, stops: 0, channel: null, held: [] };
  c.Channel = class { constructor() { this.onmessage = null; c.channel = this; } };
  c.reply = (m) => c.channel.onmessage(encode(m).buffer);
  c.invoke = async (cmd, args, opts) => {
    if (cmd === "engine_start") return start === "hang" ? new Promise(() => {}) : start;
    if (cmd === "engine_stop") { c.stops++; return; }
    if (cmd === "engine_ack") { c.acks += args.bytes; return; }
    if (cmd === "engine_send") {
      const m = decode(args);
      const urgent = !!opts?.headers?.["Sagebrush-Urgent"];
      if (hold(m)) await new Promise((r) => c.held.push(r));
      (urgent ? c.urgent : c.sent).push(m);
      if (m.hello && greet) setTimeout(() => c.reply({ hello: { protocol: 1, engine: "0.1.0", build: "0".repeat(16), caps: [] } }), 0);
      return;
    }
    throw new Error("unknown command " + cmd);
  };
  return c;
}
class FakeWorker {
  constructor() { this.got = []; this.onmessage = null; this.onerror = null; this.terminated = false; }
  postMessage(m) { this.got.push(m); }
  terminate() { this.terminated = true; }
}
const worker = (core) => {
  let own = null;
  const w = new NativeWorker(core, { name: "n", fallback: () => (own = new FakeWorker()) });
  w.errors = [];
  w.onerror = (e) => w.errors.push(e.message);
  w.got = [];
  w.onmessage = (e) => w.got.push(e.data);
  return { w, own: () => own };
};

// no engine: the page's own worker, with everything asked so far, in order
for (const [start, what] of [[false, "no engine configured"], ["hang", "an engine_start that never answers"]]) {
  _resetEngine();
  const core = fakeCore({ start });
  const { w, own } = worker(core);
  w.postMessage({ init: { limits: null } });
  w.postMessage({ id: 1, code: "1" });
  ok(await until(() => own() !== null, 2000), `${what}: the page's own worker`);
  ok(own()?.got.map((m) => m.id ?? "init").join() === "init,1", `${what}: given what was asked, in order`);
  ok(!w.native, `${what}: not native`);
  if (start === "hang") ok(core.stops === 1, `${what}: the shell is told to stop it`);
}
{
  _resetEngine();
  const core = fakeCore({ greet: false });
  const { w, own } = worker(core);
  ok(await until(() => own() !== null, 2000) && core.stops >= 1, "an engine that never greets: stopped, and the page's own worker");
}

// the order of frames: hello, open, then what was asked, in order
{
  _resetEngine();
  const core = fakeCore();
  const { w } = worker(core);
  w.postMessage({ init: { limits: null } });
  w.postMessage({ id: 1, code: "x = 1" });
  ok(await until(() => core.sent.length === 4), "frames: four sent");
  ok(JSON.stringify(core.sent.map((m) => Object.keys(m)[0] + (m.m ? ":" + Object.keys(m.m)[0] : ""))) === '["hello","open","to:init","to:id"]', `frames: hello, open, then in order (${JSON.stringify(core.sent)})`);
  ok(w.native, "the engine's interpreter");
}

// terminate while the hello is still being handed over: the close follows its open and its runs, never ahead
{
  _resetEngine();
  const core = fakeCore({ hold: (m) => !!m.hello });
  const { w } = worker(core);
  w.postMessage({ init: { limits: null } });
  w.postMessage({ id: 1, code: "while True: pass" });
  await tick(20);
  ok(core.held.length === 1, "terminate during the hello: the hello is held");
  // (the worker is attached once the engine greets; here it isn't yet: terminate drops what it queued)
  w.terminate();
  core.held[0]();
  await until(() => core.sent.length >= 1, 1000);
  await tick(50);
  const keys = core.sent.map((m) => Object.keys(m)[0]);
  ok(!keys.includes("open") && !keys.includes("to"), `terminate before the engine greeted: nothing of it is sent (${keys})`);
}
{
  // the same with the worker attached and its frames still queued behind a held hand-over
  _resetEngine();
  const core = fakeCore({ hold: (m) => m.open !== undefined });
  const { w } = worker(core);
  w.postMessage({ init: { limits: null } });
  w.postMessage({ id: 1, code: "while True: pass" });
  ok(await until(() => core.held.length === 1), "terminate while its open is held: the open is held");
  w.terminate();
  core.held[0]();
  ok(await until(() => core.sent.some((m) => m.close !== undefined)), "...its close is sent");
  const keys = core.sent.map((m) => Object.keys(m)[0] + (m.m ? ":" + Object.keys(m.m)[0] : ""));
  ok(keys.indexOf("close") > keys.indexOf("to:id") && keys.indexOf("close") > keys.indexOf("open"), `...after its open and its runs, never ahead (${keys})`);
}

// an engine that ends while nothing runs: the interpreter fails now, and again at the next run (no silent drop)
{
  _resetEngine();
  const core = fakeCore();
  const { w } = worker(core);
  w.postMessage({ init: { limits: null } });
  await until(() => core.sent.length === 3);
  core.reply({ engineExit: "ended" });
  ok(w.errors.length === 1 && /the engine ended/.test(w.errors[0]), `the engine ends while idle: the interpreter fails (${w.errors})`);
  ok(core.stops >= 1 && !w.native, "...the shell is told to stop it, and it isn't native any more");
  const before = core.sent.length;
  w.postMessage({ id: 2, code: "1" });
  ok(await until(() => w.errors.length === 2), "the next run: the interpreter fails again (the kernel restarts it)");
  ok(core.sent.length === before, "...and nothing is sent to the ended engine");
  // (a new interpreter starts a new engine)
  const { w: w2 } = worker(core);
  ok(await until(() => w2.native), "a new interpreter: a new engine, greeted");
}

// bounds
{
  // before the greeting: at most queueMax bytes wait in an interpreter
  _resetEngine();
  const save = LIMITS.queueMax;
  LIMITS.queueMax = 1000;
  const core = fakeCore({ hold: (m) => !!m.hello });
  const { w } = worker(core);
  w.postMessage({ files: [["/a", new Uint8Array(600)]] });
  ok(w.errors.length === 0, "before the greeting: 600 bytes wait");
  w.postMessage({ files: [["/b", new Uint8Array(600)]] });
  ok(w.errors.length === 1 && /too much was asked/.test(w.errors[0]), `...600 more pass the bound: the interpreter fails (${w.errors})`);
  await until(() => core.held.length === 1);
  core.held[0]();
  await tick(50);
  ok(!core.sent.some((m) => m.to !== undefined), "...and nothing it was asked is sent");
  LIMITS.queueMax = save;
}
{
  // waiting for the shell: at most pendingMax bytes; past it the engine ends
  _resetEngine();
  const save = LIMITS.pendingMax;
  const core = fakeCore({ hold: (m) => m.to !== undefined });
  const { w } = worker(core);
  ok(await until(() => w.native), "pending bound: the engine greets");
  LIMITS.pendingMax = 5000;
  LIMITS.sendMs = 60000;
  w.postMessage({ files: [["/a", new Uint8Array(3000)]] }); // (held by the shell)
  w.postMessage({ files: [["/b", new Uint8Array(3000)]] }); // (waits here: 6000 > 5000)
  ok(w.errors.length === 1 && /isn't taking messages/.test(w.errors[0]) && core.stops >= 1, `...past it: the engine ends, the interpreter fails (${w.errors})`);
  LIMITS.pendingMax = save;
  LIMITS.sendMs = 300;
  for (const r of core.held) r();
}
{
  // a hand-over that never completes ends the engine
  _resetEngine();
  const core = fakeCore({ hold: (m) => m.to !== undefined && m.m?.id === 7 });
  const { w } = worker(core);
  await until(() => w.native);
  w.postMessage({ id: 7, code: "1" });
  ok(await until(() => w.errors.length === 1, 2000) && /in time/.test(w.errors[0]), `a hand-over that never completes: the engine ends (${w.errors})`);
}

// Stop: urgent, ahead of a stalled queue
{
  _resetEngine();
  const core = fakeCore({ hold: (m) => m.to !== undefined && m.m?.files !== undefined });
  LIMITS.sendMs = 60000;
  const { w } = worker(core);
  await until(() => w.native);
  w._message({ ready: true, interruptible: true });
  w.postMessage({ files: [["/big", new Uint8Array(10)]] }); // (held)
  w.postMessage({ id: 3, code: "1" }); // (waits behind it)
  await tick(20);
  w.interrupt(3);
  ok(await until(() => core.urgent.length === 1), "Stop: sent urgent while the queue is held");
  ok(core.urgent[0].m.runnerInterrupt === 3 && !core.sent.some((m) => m.m?.id === 3), "...ahead of the run still waiting");
  for (const r of core.held) r();
  LIMITS.sendMs = 300;
}

// acknowledgements: what the page took, summed
{
  _resetEngine();
  const core = fakeCore();
  const { w } = worker(core);
  await until(() => w.native);
  await tick(20);
  const a0 = core.acks;
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const p = encode({ from: w.sid, m: { id: 9, stream: "stdout", text: "x".repeat(100) } });
    n += p.length;
    core.channel.onmessage(p.buffer);
  }
  ok(await until(() => core.acks - a0 === n), `acknowledgements: the bytes of the frames taken (${core.acks - a0} of ${n})`);
  ok(w.got.filter((d) => d.id === 9).length === 5, "...and each delivered");
}

ok(approxBytes({ files: [["/a", new Uint8Array(1000)]] }) >= 1000, "approxBytes counts binary values");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
