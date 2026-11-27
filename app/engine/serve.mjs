// The Sagebrush engine as the app's subprocess (design/native-desktop.md §2),
// on a pair of streams; app/engine/main.mjs runs it on stdin and stdout.
//
// The root folder holds the page's worker and its files (web/dist, or the app's copy of
// it, app/dist).  Frames (app/engine/frames.mjs) come in on stdin and go out
// on stdout; stderr is the engine's log.  When stdin ends (the app quit or
// died), every interpreter stops and the engine exits.
//
// The conversation, after which every message is one of these:
//   in:  {hello: {protocol: {min, max}, client, want}}   first, and once
//   out: {hello: {protocol, engine, build, caps}}        the version both speak (the highest), and what this engine has
//        {incompatible: {protocol: {min, max}}}           no version in common: the engine then exits, nothing run
//   in:  {open: sid, name}      start an interpreter (sid: 1 to 64 of [A-Za-z0-9_-]; name: the Web Worker's name,
//                               which carries TimeTravel replay's parameters, web/replay-env.ts)
//        {to: sid, m}           a message for it: the page's worker protocol (src/notebook-session.ts, web/worker.ts)
//        {close: sid}           stop it
//   out: {from: sid, m}         its message to the page
//        {error: sid, message}  it failed (an exception that ended its thread)
//        {error: sid, message, fault: true, code: "engine_fault"}  its native engine faulted: its process ends
//                               nonzero after this, and {closed: sid} follows (design N1 r3)
//        {closed: sid}          it stopped (closed, or its thread ended)
//        {protocolError: text}  a message this engine doesn't take: the engine exits (never dropped silently)
//
// Each interpreter is a Node worker thread running the page's worker unchanged
// (app/engine/thread.mjs).  The words it shares with whoever holds it (Stop's
// flag, the permission epoch, input()'s and live data's answers) can't cross a
// pipe, so this engine holds them and translates, exactly as the sandboxed
// runner's frame does in the browser (web/runner/index.html): the page's
// {runnerInterrupt: upTo}, {runnerInput: id, key, text} and {runnerLive: id,
// key, answer} are written into those words here, and {fsWrite}'s epoch is
// stored before the policy goes on.  This thread never runs Python, so a Stop
// is acted on as soon as its frame is read.
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { encode, decode, frame, frameReader } from "./frames.mjs";

// the protocol versions this engine speaks (no compatibility promise before 1.0: design/native-desktop.md §2.1)
export const PROTOCOL = { min: 1, max: 1 };
export const ENGINE_VERSION = "0.1.0";
const SID = /^[A-Za-z0-9_-]{1,64}$/;
const LIVE_BYTES = 8 + (8 << 20);
// What may wait to be written to the app, at most (bytes): past it, the app isn't reading (hung, or gone without
// closing the pipe), and the engine stops at once (exit 4) rather than keep its interpreters' output in memory.
// Room for the largest frame, and more.
export const OUT_MAX = 1024 * 1024 * 1024;

// An interpreter's heap, in MiB, by default: the computer's memory as this process may have it, a container's limit
// (constrainedMemory, bytes; 0 for none) where there is one, and never past it; at least 1 GiB where there is none.
export function defaultHeapMb(total, cap) {
  const mine = Math.floor((cap > 0 ? Math.min(total, cap) : total) / 2 ** 20);
  return cap > 0 ? Math.max(1, mine) : Math.max(1024, mine);
}

/** The engine on a pair of streams: `input` (frames in), `write(bytes)` (frames out), `queued()` (the bytes written
 * and not yet taken by the reader), `exit(code, now)` (`now`: at once, without waiting for what is queued),
 * `onDrain(f)` (f called whenever what was queued has gone out). */
export function serve({ root, memory, input, write, queued, exit, onDrain, outMax = OUT_MAX }) {
  const worker = join(root, "sagebrush-worker.js");
  if (!existsSync(worker)) throw new Error(`no sagebrush-worker.js in ${root} (build it: bun web/build.ts)`);
  root = realpathSync(root);
  const build = createHash("sha256").update(readFileSync(worker)).digest("hex").slice(0, 16);
  // Memory: each interpreter's heap may grow to all of this computer's memory, as a program's does in Sage or Magma:
  // the person's own computer and their own computation, with no cap of ours, the operating system the limit. Two notebooks running at once may together ask for more than the computer has, as two programs may.
  // (`memory` MB: the tests' own setting, smaller; not a person's.)
  const heapMb = Number.isFinite(memory) && memory > 0 ? Math.floor(memory) : defaultHeapMb(totalmem(), Number(process.constrainedMemory?.() || 0));
  const sessions = new Map();
  let greeted = false, ended = false;
  const send = (msg) => {
    if (ended) return;
    let p;
    try {
      p = encode(msg);
    } catch (e) {
      // (a message that can't be sent is said as an error of its interpreter, never dropped)
      if (msg.from !== undefined) p = encode({ error: msg.from, message: `a message that can't be sent: ${String(e?.message ?? e)}` });
      else throw e;
    }
    write(frame(p));
    if (queued() > outMax) {
      // (the app isn't reading: stop now, with nothing more queued; the app sees the engine end)
      process.stderr.write(`sagebrush engine: the app hasn't read ${queued()} bytes of output; stopping\n`);
      end(4, null, true);
    }
  };
  const end = (code, why, now = false) => {
    if (ended) return;
    if (why) send({ protocolError: why });
    ended = true;
    for (const s of sessions.values()) s.terminate();
    sessions.clear();
    exit(code, now);
  };

  // The native engine (#7, design N1 r3 S2): one session per OS process, as the addon's claim requires. With an
  // addon installed (SAGEBRUSH_ADDON, and SAGEBRUSH_ENGINE not wasm), each session runs in a child engine of its own,
  // this same program, whose frames are relayed both ways unchanged; the child (SAGEBRUSH_SESSION_PROCESS=1) runs its
  // one session in a thread as before. A child that ends unexpectedly ends its session with {error}, then {closed}.
  const perProcess = !!process.env.SAGEBRUSH_ADDON && process.env.SAGEBRUSH_ENGINE !== "wasm" && process.env.SAGEBRUSH_SESSION_PROCESS !== "1";
  // (backpressure: while the app has a relay's worth unread, the children's output waits in the children, bounded
  // there by the same outMax; a child that stops for it, status 4, means the app isn't reading, and this engine stops)
  const RELAY_HIGH = Math.min(outMax, 2 ** 20);
  const held = new Set();
  if (perProcess) onDrain?.(() => { for (const c of held) c.resume(); held.clear(); });

  function openChild(sid, name) {
    const args = [fileURLToPath(new URL("./main.mjs", import.meta.url)), "--stdio", "--root", root, "--out-max", String(outMax / 2 ** 20)];
    if (Number.isFinite(memory) && memory > 0) args.push("--memory", String(Math.floor(memory)));
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, SAGEBRUSH_SESSION_PROCESS: "1" } });
    // (the page's messages wait until the child has its session open: it answers hello first)
    const s = { child, relay: true, fault: false, pending: [] };
    const toChild = (msg) => { try { child.stdin.write(frame(encode(msg))); } catch {} };
    const finish = (why) => {
      if (sessions.get(sid) !== s) return;
      sessions.delete(sid);
      if (why) send({ error: sid, message: why });
      send({ closed: sid });
    };
    const reader = frameReader((p) => {
      if (sessions.get(sid) !== s) return;
      let msg;
      try {
        msg = decode(p);
      } catch (e) {
        child.kill();
        return finish(`the session's engine sent a malformed frame: ${String(e?.message ?? e)}`);
      }
      if (msg.hello) {
        toChild({ open: sid, name });
        for (const d of s.pending) toChild({ to: sid, m: d });
        s.pending = null;
        return;
      }
      if (msg.from === sid) return send(msg);
      if (msg.error === sid) {
        if (msg.fault) s.fault = true;
        return send(msg);
      }
      if (msg.closed === sid) { finish(null); child.kill(); return; }
      // (the child's own refusal: its session can't go on)
      child.kill();
      return finish(`the session's engine stopped: ${JSON.stringify(msg).slice(0, 1000)}`);
    });
    child.stdout.on("data", (c) => {
      try {
        reader.push(c);
      } catch (e) {
        child.kill();
        finish(`the session's engine sent a malformed frame: ${String(e?.message ?? e)}`);
      }
      if (onDrain && queued() > RELAY_HIGH && !ended) { child.stdout.pause(); held.add(child.stdout); }
    });
    child.stdin.on("error", () => {});
    child.on("error", (e) => finish(`the session's engine could not start: ${String(e?.message ?? e)}`));
    child.on("exit", (code, signal) => {
      held.delete(child.stdout);
      if (code === 4 && sessions.get(sid) === s) return end(4, null, true);
      finish(s.fault ? null : `the session's engine ended (${signal ?? `status ${code}`})`);
    });
    s.post = (d) => (s.pending ? s.pending.push(d) : toChild({ to: sid, m: d }));
    s.terminate = () => { toChild({ close: sid }); child.kill(); };
    sessions.set(sid, s);
    toChild({ hello: { protocol: PROTOCOL } });
  }

  function open(sid, name) {
    if (perProcess) return openChild(sid, name);
    // (the runner frame's state, per interpreter: web/runner/index.html)
    // (ask: the one refused change asked while its run waits (web/worker.ts fsAsk), {key, buffer}, as the runner's frame
    // keeps it: an allow's epoch is stored in the shared word BEFORE its answer is written; anything else answers no)
    const s = { thread: null, flag: null, epoch: null, inputs: new Map(), lives: new Map(), ask: null, engine: null };
    s.post = (d) => toSession(s, d);
    s.terminate = () => s.thread.terminate();
    s.askNo = () => { if (s.ask) { giveInput(s.ask.buffer, null); s.ask = null; } };
    s.thread = new Worker(new URL("./thread.mjs", import.meta.url), { workerData: { root, name, memory: heapMb }, resourceLimits: { maxOldGenerationSizeMb: heapMb }, stdout: false, stderr: false });
    const retire = (map, id) => { for (const [k, e] of map) if (id === undefined || e.id === id) map.delete(k); };
    s.retire = (id) => { retire(s.inputs, id); retire(s.lives, id); };
    s.thread.on("message", (d) => {
      if (sessions.get(sid) !== s || !d || typeof d !== "object") return;
      // (the thread's own notice of its native engine: kept for ready, not the page's)
      if (d.nativeEngine && typeof d.nativeEngine === "object") { s.engine = d.nativeEngine; return; }
      // (the native engine faulted: this process is faulted for good (the addon refuses every later call), so the
      // session ends with the fault frame and the process exits nonzero once it is written (design N1 r3))
      if (typeof d.engineFault === "string") {
        send({ error: sid, message: d.engineFault, fault: true, code: "engine_fault" });
        return end(5);
      }
      if (d.liveData && d.buffer instanceof SharedArrayBuffer && d.buffer.byteLength === LIVE_BYTES) {
        // (a key already open keeps its destination: the duplicate goes no further)
        if (typeof d.liveData.key !== "string" || s.lives.has(d.liveData.key)) return;
        retire(s.lives, d.id);
        s.lives.set(d.liveData.key, { id: d.id, buffer: d.buffer });
        d = { ...d, buffer: null };
      }
      if (d.fsAsk && d.buffer instanceof SharedArrayBuffer && d.buffer.byteLength >= 8) {
        s.askNo();
        if (typeof d.fsAsk.key === "string" && d.fsAsk.key.length <= 64) s.ask = { key: d.fsAsk.key, buffer: d.buffer };
        d = { ...d, buffer: null };
      }
      if (d.input && d.buffer instanceof SharedArrayBuffer && d.buffer.byteLength >= 8) {
        retire(s.inputs, d.id);
        if (typeof d.input.key === "string") s.inputs.set(d.input.key, { id: d.id, buffer: d.buffer });
        d = { ...d, buffer: null };
      }
      if (d.done || d.skipped) s.retire(d.id);
      if (d.ready) {
        if (d.interrupt instanceof SharedArrayBuffer) s.flag = new Int32Array(d.interrupt);
        if (d.epoch instanceof SharedArrayBuffer) s.epoch = new Int32Array(d.epoch);
        // (the words stay here; the page is told they are held for it, as by the runner's frame)
        d = { ...d, interrupt: null, interruptible: !!s.flag, epoch: null, epochShared: !!s.epoch, progress: null, engine: { native: !!s.engine?.loaded, threads: true, why: String(s.engine?.why ?? "") } };
      }
      send({ from: sid, m: d });
    });
    s.thread.on("error", (e) => { if (sessions.get(sid) === s) send({ error: sid, message: String(e?.stack ?? e).slice(0, 4096) }); });
    s.thread.on("exit", () => {
      if (sessions.get(sid) !== s) return;
      sessions.delete(sid);
      send({ closed: sid });
    });
    sessions.set(sid, s);
  }

  function toSession(s, d) {
    if (d && typeof d === "object") {
      if (typeof d.runnerInterrupt === "number") {
        s.retire(); // (every open input() and live data request is over)
        s.askNo();
        if (s.flag) {
          Atomics.store(s.flag, 1, d.runnerInterrupt);
          // (bit 0, and the word notified: a time.sleep waits on it, src/runtime/interrupt.ts requestCtrlC)
          Atomics.or(s.flag, 0, 1);
          Atomics.notify(s.flag, 0);
        }
        return;
      }
      // (the new epoch stored BEFORE the policy goes on to the interpreter: a run in flight refuses at its next change)
      if (d.fsWrite && Number.isInteger(d.fsWrite.epoch) && s.epoch) Atomics.store(s.epoch, 0, d.fsWrite.epoch);
      if (typeof d.runnerAsk === "string") {
        if (s.ask && s.ask.key === d.runnerAsk) {
          const a = s.ask;
          s.ask = null;
          if (typeof d.answer === "string" && Number.isInteger(d.epoch) && d.epoch > 0 && s.epoch) { Atomics.store(s.epoch, 0, d.epoch); giveInput(a.buffer, d.answer); }
          else giveInput(a.buffer, null);
        }
        return;
      }
      if (typeof d.runnerInput === "number") {
        const e = typeof d.key === "string" ? s.inputs.get(d.key) : undefined;
        if (e && e.id === d.runnerInput) { s.inputs.delete(d.key); giveInput(e.buffer, d.text); }
        return;
      }
      if (typeof d.runnerLive === "number") {
        const e = typeof d.key === "string" ? s.lives.get(d.key) : undefined;
        if (e && e.id === d.runnerLive) { s.lives.delete(d.key); giveLive(e.buffer, d.answer); }
        return;
      }
    }
    s.thread.postMessage(d);
  }

  function onMessage(msg) {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return end(2, "a message that isn't an object");
    if (!greeted) {
      const h = msg.hello, p = h?.protocol;
      if (!h || !p || !Number.isInteger(p.min) || !Number.isInteger(p.max)) return end(2, "the first message must be {hello: {protocol: {min, max}}}");
      greeted = true;
      const v = Math.min(p.max, PROTOCOL.max);
      if (v < Math.max(p.min, PROTOCOL.min)) {
        send({ incompatible: { protocol: PROTOCOL } });
        return end(3);
      }
      return send({ hello: { protocol: v, engine: ENGINE_VERSION, build, caps: ["threads", "files", "stop-word", "input", "live-data"] } });
    }
    const keys = Object.keys(msg);
    if (msg.open !== undefined && keys.every((k) => k === "open" || k === "name")) {
      if (typeof msg.open !== "string" || !SID.test(msg.open)) return end(2, "open: a session id is 1 to 64 of A-Z, a-z, 0-9, _ and -");
      if (sessions.has(msg.open)) return end(2, `open: session ${msg.open} is open already`);
      return open(msg.open, typeof msg.name === "string" ? msg.name.slice(0, 4096) : "");
    }
    if (msg.to !== undefined && keys.length === 2 && keys.includes("m")) {
      const s = sessions.get(msg.to);
      // (a message for an interpreter that has just stopped: its {closed} is on its way, and the page restarts it)
      if (s) s.post(msg.m);
      return;
    }
    if (msg.close !== undefined && keys.length === 1) {
      const s = sessions.get(msg.close);
      if (s) { sessions.delete(msg.close); s.terminate(); send({ closed: msg.close }); }
      return;
    }
    return end(2, `an unknown message (${keys.slice(0, 4).join(", ").slice(0, 200)})`);
  }

  const reader = frameReader((p) => {
    if (ended) return;
    let msg;
    try {
      msg = decode(p);
    } catch (e) {
      return end(2, `a malformed frame: ${String(e?.message ?? e)}`);
    }
    onMessage(msg);
  });
  input.on("data", (c) => {
    if (ended) return;
    try {
      reader.push(c);
    } catch (e) {
      end(2, String(e?.message ?? e));
    }
  });
  input.on("end", () => end(0));
  input.on("error", () => end(0));
  return { sessions };
}

// input()'s answer, into the buffer its interpreter waits on (web/runner/index.html giveInput)
function giveInput(buffer, text) {
  const ctl = new Int32Array(buffer, 0, 2);
  if (Atomics.load(ctl, 0) !== 0) return;
  if (typeof text !== "string") {
    Atomics.store(ctl, 0, 2);
  } else {
    const max = buffer.byteLength - 8, enc = new TextEncoder();
    let s = text, bytes = enc.encode(s);
    while (bytes.length > max) bytes = enc.encode((s = Array.from(s).slice(0, -Math.max(1, Math.ceil((bytes.length - max) / 4))).join("")));
    new Uint8Array(buffer, 8, bytes.length).set(bytes);
    Atomics.store(ctl, 1, bytes.length);
    Atomics.store(ctl, 0, 1);
  }
  Atomics.notify(ctl, 0);
}

// live data's answer, likewise (web/runner/index.html giveLive): the interpreter checks it again
function giveLive(buffer, answer) {
  const ctl = new Int32Array(buffer, 0, 2);
  if (Atomics.load(ctl, 0) !== 0) return;
  let bytes;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(answer));
  } catch {
    bytes = null;
  }
  if (!bytes || bytes.length > buffer.byteLength - 8) bytes = new TextEncoder().encode('{"error":"unavailable"}');
  new Uint8Array(buffer, 8, bytes.length).set(bytes);
  Atomics.store(ctl, 1, bytes.length);
  Atomics.store(ctl, 0, 1);
  Atomics.notify(ctl, 0);
}
