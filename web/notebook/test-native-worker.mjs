// ci: checks.3 order=45 runner=bun
// The page's side of the app's engine subprocess (native-worker.js) against a
// fake of the app's shell (engine_start, engine_send, engine_ack, engine_stop
// and the frame channel), with the engine's answers made here: no engine, or
// one that never starts or never greets (the page's own worker instead); the
// order of frames, a close never ahead of its interpreter's open and runs; an
// engine that ends while nothing runs (the next run fails, so the kernel
// restarts); every bound (bytes waiting before the greeting, bytes waiting
// for the shell, a hand-over that never completes); Stop sent urgent, ahead
// of a stalled queue, and coalesced; acknowledgements of what the page took;
// no deadline left running once what it bounds is done.  Every wait is
// bounded.
//   bun web/notebook/test-native-worker.mjs
import { NativeWorker, LIMITS, _resetEngine } from "./native-worker.js";
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
// (the deadlines still running: each timer of startMs or sendMs, until it fires or is cleared)
const live = new Map();
const st0 = globalThis.setTimeout, ct0 = globalThis.clearTimeout;
globalThis.setTimeout = (f, ms, ...a) => {
  const id = st0(() => { live.delete(id); f(...a); }, ms);
  if (ms === LIMITS.startMs || ms === LIMITS.sendMs) live.set(id, ms);
  return id;
};
globalThis.clearTimeout = (id) => { live.delete(id); ct0(id); };

/** A fake shell: `start` answers engine_start (true, false, or "hang"); `greet` whether the engine says hello;
 * `hold(frame)` keeps a hand-over pending until released.  sent: each frame the engine got, decoded. */
function fakeCore({ start = true, greet = true, hold = () => false } = {}) {
  const c = { sent: [], urgent: [], acks: 0, stops: 0, channel: null, held: [], calls: [] };
  c.Channel = class { constructor() { this.onmessage = null; c.channel = this; } };
  c.reply = (m) => c.channel.onmessage(encode(m).buffer);
  c.invoke = async (cmd, args, opts) => {
    c.calls.push(cmd);
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
    n += p.length + 4;
    core.channel.onmessage(p.buffer);
  }
  ok(await until(() => core.acks - a0 === n), `acknowledgements: the bytes of the frames taken, each with its length (${core.acks - a0} of ${n})`);
  ok(w.got.filter((d) => d.id === 9).length === 5, "...and each delivered");
}

// before the greeting, each message measured as encoded: nested binary values, every key, UTF-8
{
  _resetEngine();
  const save = { ...LIMITS };
  LIMITS.queueMax = 100000;
  const core = fakeCore({ hold: (m) => !!m.hello });
  const { w } = worker(core);
  let deep = new Uint8Array(200000);
  for (let i = 0; i < 20; i++) deep = { d: [deep] };
  w.postMessage({ files: [["/x", deep]] });
  ok(w.errors.length === 1 && /too much was asked/.test(w.errors[0]), `before the greeting: a binary value nested 20 deep counts in full (${w.errors})`);
  _resetEngine();
  const c2 = fakeCore({ hold: (m) => !!m.hello });
  const { w: w2 } = worker(c2);
  w2.postMessage({ text: "\u20ac".repeat(40000) }); // (120000 bytes as UTF-8, 40000 code units)
  ok(w2.errors.length === 1, "before the greeting: text counts as UTF-8");
  _resetEngine();
  const c3 = fakeCore({ hold: (m) => !!m.hello });
  const { w: w3 } = worker(c3);
  w3.postMessage({ buffer: new SharedArrayBuffer(8) });
  ok(w3.errors.length === 1 && /can't be sent/.test(w3.errors[0]), `before the greeting: a message that can't be encoded fails the interpreter (${w3.errors})`);
  _resetEngine();
  LIMITS.queueItems = 3;
  const c4 = fakeCore({ hold: (m) => !!m.hello });
  const { w: w4 } = worker(c4);
  for (let i = 0; i < 3; i++) w4.postMessage(null);
  ok(w4.errors.length === 0, "before the greeting: three messages wait");
  w4.postMessage(null);
  ok(w4.errors.length === 1, "...a fourth passes the item bound: the interpreter fails");
  Object.assign(LIMITS, save);
  for (const c of [core, c2, c3, c4]) for (const r of c.held) r();
}

// Stops: one handed over at a time, only the latest of an interpreter waiting
{
  _resetEngine();
  const core = fakeCore({ hold: (m) => m.m?.runnerInterrupt !== undefined });
  LIMITS.sendMs = 60000;
  const { w } = worker(core);
  await until(() => w.native);
  w._message({ ready: true, interruptible: true });
  for (let i = 1; i <= 50; i++) w.interrupt(i);
  await tick(20);
  ok(core.held.length === 1, `50 Stops while one is handed over: one hand-over at a time (${core.held.length})`);
  core.held[0]();
  ok(await until(() => core.held.length === 2), "...then one more: the latest waiting");
  core.held[1]();
  ok(await until(() => core.urgent.length === 2) && core.urgent[0].m.runnerInterrupt === 1 && core.urgent[1].m.runnerInterrupt === 50, `...the first and the latest cutoff, no others (${core.urgent.map((m) => m.m.runnerInterrupt)})`);
  LIMITS.sendMs = 300;
}

// before the greeting, what waits is a copy taken when it was asked: a later change to the caller's object changes
// neither what is sent nor what was counted
{
  _resetEngine();
  const save = LIMITS.queueMax;
  LIMITS.queueMax = 64;
  const core = fakeCore({ hold: (m) => !!m.hello });
  const { w } = worker(core);
  const m = { x: "" };
  w.postMessage(m);
  m.x = "y".repeat(1024);
  ok(w.errors.length === 0, "a message changed after it was asked: still within the bound it was counted at");
  await until(() => core.held.length === 1);
  LIMITS.queueMax = save;
  core.held[0]();
  ok(await until(() => core.sent.some((f) => f.to !== undefined)), "...then sent");
  const sent = core.sent.find((f) => f.to !== undefined);
  ok(sent.m.x === "", `...as it was when asked, not as changed (${JSON.stringify(sent.m.x).slice(0, 20)})`);
}

// a waiting Stop goes when its interpreter is terminated; the engine's end clears them all
{
  _resetEngine();
  const core = fakeCore({ hold: (m) => m.m?.runnerInterrupt !== undefined });
  LIMITS.sendMs = 60000;
  const { w } = worker(core);
  const { w: w2 } = worker(core);
  await until(() => w.native && w2.native);
  w._message({ ready: true, interruptible: true });
  w2._message({ ready: true, interruptible: true });
  w.interrupt(1); // (handed over, held)
  w2.interrupt(2); // (waits)
  await until(() => core.held.length === 1);
  w2.terminate();
  core.held[0]();
  // (every hand-over that follows released too, so a Stop still waiting would be seen)
  for (let i = 0; i < 20; i++) { await tick(10); for (const r of core.held.splice(0)) r(); }
  ok(core.urgent.length >= 1 && !core.urgent.some((m) => m.to === w2.sid), `a terminated interpreter's waiting Stop is not sent (${core.urgent.map((m) => m.to)})`);
  LIMITS.sendMs = 300;
}

// startup's deadline is cleared however the start ends, a rejected engine_start too
{
  _resetEngine();
  live.clear();
  const core = fakeCore();
  core.invoke = async (cmd) => { if (cmd === "engine_start") throw new Error("no"); };
  let own = null;
  const w = new NativeWorker(core, { name: "n", fallback: () => (own = new FakeWorker()) });
  ok(await until(() => own !== null), "a rejected engine_start: the page's own worker");
  await tick(20);
  ok(live.size === 0, `...and no deadline still running (${live.size})`);
}

// how an engine ends, and what follows: a malformed frame, a protocol error, an unsendable message each end it; after
// the end nothing more reaches the shell (no frame, no acknowledgement) and a new interpreter starts a new engine
for (const [what, end] of [
  ["a malformed frame", (core) => core.channel.onmessage(new Uint8Array([1, 2]).buffer)],
  ["a protocol error", (core) => core.reply({ protocolError: "an unknown message" })],
  ["an unsendable message", (core, w) => w.postMessage({ x: new SharedArrayBuffer(8) })],
]) {
  _resetEngine();
  const core = fakeCore({ hold: (m) => m.m?.id === 99 });
  const { w } = worker(core);
  await until(() => w.native);
  w.postMessage({ id: 99, code: "1" }); // (held by the shell)
  w.postMessage({ id: 100, code: "2" }); // (waits behind it)
  // (a frame taken just before the end, so an acknowledgement would be due)
  core.channel.onmessage(encode({ from: w.sid, m: { id: 99, stream: "stdout", text: "x" } }).buffer);
  end(core, w);
  ok(w.errors.length === 1 && core.stops >= 1, `${what}: the engine ends, the interpreter fails (${w.errors})`);
  const n = core.calls.length;
  for (const r of core.held.splice(0)) r();
  await tick(50);
  const after = core.calls.slice(n);
  ok(!after.includes("engine_send") && !core.sent.some((m) => m.m?.id === 100), `${what}: nothing queued reaches the shell after the end (${after})`);
  ok(!after.includes("engine_ack"), `${what}: no acknowledgement after the end`);
  const starts = core.calls.filter((c) => c === "engine_start").length;
  const { w: w2 } = worker(core);
  ok(await until(() => w2.native) && core.calls.filter((c) => c === "engine_start").length === starts + 1, `${what}: a new interpreter starts a new engine`);
}

// more than pendingMax bytes in all, over hand-overs that complete, keeps the engine: the bound is on what waits
{
  _resetEngine();
  const save = LIMITS.pendingMax;
  const core = fakeCore();
  const { w } = worker(core);
  await until(() => w.native);
  LIMITS.pendingMax = 5000;
  for (let i = 0; i < 5; i++) {
    w.postMessage({ files: [["/f" + i, new Uint8Array(3000)]] });
    await until(() => core.sent.filter((m) => m.m?.files).length === i + 1);
  }
  ok(w.errors.length === 0 && w.native, "15000 bytes over five completed hand-overs, under a 5000-byte bound: the engine stays");
  LIMITS.pendingMax = save;
}

// after an interpreter's {closed}, nothing more is delivered to it; after terminate(), no error is said
{
  _resetEngine();
  const core = fakeCore();
  const { w } = worker(core);
  await until(() => w.native);
  core.reply({ closed: w.sid });
  const before = w.got.length;
  core.channel.onmessage(encode({ from: w.sid, m: { id: 5, stream: "stdout", text: "late" } }).buffer);
  ok(w.got.length === before, "after its {closed}: a late message for it is not delivered");
  const { w: w2 } = worker(core);
  await until(() => w2.native);
  w2.terminate();
  core.channel.onmessage(encode({ error: w2.sid, message: "late" }).buffer);
  core.reply({ engineExit: "ended" });
  w2.postMessage({ id: 1, code: "1" });
  await tick(30);
  ok(w2.errors.length === 0, `after terminate(): no error is said, whatever comes (${w2.errors})`);
  // (an interpreter whose engine ended, asked once more, then terminated before that failure is said: not said)
  const { w: w3 } = worker(core);
  await until(() => w3.native);
  core.reply({ engineExit: "ended" });
  const n3 = w3.errors.length;
  w3.postMessage({ id: 2, code: "1" });
  w3.terminate();
  await tick(30);
  ok(w3.errors.length === n3, `a failure due when terminate() comes is not said after it (${w3.errors.length - n3} more)`);
}

// Stops A, B, A while one is held: the later A replaces the earlier, so after the held one, B goes, then A
{
  _resetEngine();
  const core = fakeCore({ hold: (m) => m.m?.runnerInterrupt !== undefined });
  LIMITS.sendMs = 60000;
  const { w: a } = worker(core);
  const { w: b } = worker(core);
  const { w: c } = worker(core);
  await until(() => a.native && b.native && c.native);
  for (const x of [a, b, c]) x._message({ ready: true, interruptible: true });
  c.interrupt(1); // (handed over, held)
  await until(() => core.held.length === 1);
  a.interrupt(2);
  b.interrupt(3);
  a.interrupt(4);
  for (let i = 0; i < 20; i++) { await tick(10); for (const r of core.held.splice(0)) r(); }
  ok(JSON.stringify(core.urgent.map((m) => [m.to === a.sid ? "A" : m.to === b.sid ? "B" : "C", m.m.runnerInterrupt])) === '[["C",1],["B",3],["A",4]]', `Stops A, B, A while one is held: B, then the later A (${JSON.stringify(core.urgent.map((m) => m.m.runnerInterrupt))})`);
  LIMITS.sendMs = 300;
}

// a ready message without interruptible: no Stop by message (the kernel restarts instead)
{
  _resetEngine();
  const core = fakeCore();
  const { w } = worker(core);
  await until(() => w.native);
  w._message({ ready: true, interruptible: false });
  ok(w.interrupt === undefined, "ready without interruptible: no interrupt");
}

// no deadline left running once what it bounds is done
{
  _resetEngine();
  live.clear();
  const core = fakeCore();
  const { w } = worker(core);
  await until(() => w.native);
  for (let i = 0; i < 20; i++) w.postMessage({ id: 100 + i, code: "1" });
  await until(() => core.sent.length === 22);
  await tick(20);
  ok(live.size === 0, `after a start and 22 hand-overs: no deadline still running (${live.size})`);
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
