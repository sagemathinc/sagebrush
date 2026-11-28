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
//        {state: sid}           what it is doing, for a client that comes back to it (the remote host's reattach,
//                               design/remote-r3.md): answered in stream order with
//   out: {state: sid, open: true, busy, queued, seq}   busy: the id of the run that has started and not finished, or
//                               null; queued: the ids of runs sent to it and not started, in order (a run: a message
//                               to it with an id and code, interact or evaluate; started at its {id, start}, finished
//                               at its {id, done} or {id, skipped}; the worker runs one at a time, and a second
//                               run's start while one is busy ends the engine, loudly: a protocolError, exit 5); seq: how many {from: sid}
//                               messages came before this answer (counted as each is written, on the writer this
//                               answer goes out on, so it is exactly the frames before it; from 0 at each open)
//        {state: sid, open: false}   no such interpreter (never opened, or closed)
//   out: {from: sid, m}         its message to the page
//        {error: sid, message}  it failed (an exception that ended its thread)
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
 * and not yet taken by the reader), `exit(code, now)` (`now`: at once, without waiting for what is queued). */
export function serve({ root, memory, input, write, queued, exit, outMax = OUT_MAX }) {
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
    let p, from = msg.from;
    try {
      p = encode(msg);
    } catch (e) {
      // (a message that can't be sent is said as an error of its interpreter, never dropped)
      if (msg.from !== undefined) p = encode({ error: msg.from, message: `a message that can't be sent: ${String(e?.message ?? e)}` });
      else throw e;
      from = undefined;
    }
    write(frame(p));
    // (seq: counted here, as each {from: sid} frame is written, on the same writer as {state}'s answer, so that
    // answer's seq is exactly the frames before it: no race)
    if (from !== undefined) { const s = sessions.get(from); if (s) s.seq++; }
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
    for (const s of sessions.values()) s.thread.terminate();
    sessions.clear();
    exit(code, now);
  };

  function open(sid, name) {
    // (the runner frame's state, per interpreter: web/runner/index.html)
    // (ask: the one refused change asked while its run waits (web/worker.ts fsAsk), {key, buffer}, as the runner's frame
    // keeps it: an allow's epoch is stored in the shared word BEFORE its answer is written; anything else answers no)
    // (runs: queued ids in order, busy the started one, seq the {from} messages sent: the answer to {state})
    const s = { thread: null, flag: null, epoch: null, inputs: new Map(), lives: new Map(), ask: null, queued: [], busy: null, seq: 0 };
    s.askNo = () => { if (s.ask) { giveInput(s.ask.buffer, null); s.ask = null; } };
    s.thread = new Worker(new URL("./thread.mjs", import.meta.url), { workerData: { root, name, memory: heapMb }, resourceLimits: { maxOldGenerationSizeMb: heapMb }, stdout: false, stderr: false });
    const retire = (map, id) => { for (const [k, e] of map) if (id === undefined || e.id === id) map.delete(k); };
    s.retire = (id) => { retire(s.inputs, id); retire(s.lives, id); };
    s.thread.on("message", (d) => {
      if (sessions.get(sid) !== s || !d || typeof d !== "object") return;
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
      if (d.id !== undefined && d.start) {
        // (the worker runs one at a time (src/notebook-session.ts): {state}'s busy is one id. A second start while one
        // is busy would make it wrong, so it ends the engine, loudly, never a state silently corrupted)
        if (s.busy !== null && s.busy !== d.id) return end(5, `state: run ${String(d.id).slice(0, 64)} started in ${sid} while run ${String(s.busy).slice(0, 64)} is busy (the worker runs one at a time)`);
        const i = s.queued.indexOf(d.id);
        if (i >= 0) { s.queued.splice(i, 1); s.busy = d.id; }
      }
      if (d.id !== undefined && (d.done || d.skipped)) {
        if (s.busy === d.id) s.busy = null;
        const i = s.queued.indexOf(d.id);
        if (i >= 0) s.queued.splice(i, 1);
      }
      if (d.ready) {
        if (d.interrupt instanceof SharedArrayBuffer) s.flag = new Int32Array(d.interrupt);
        if (d.epoch instanceof SharedArrayBuffer) s.epoch = new Int32Array(d.epoch);
        // (the words stay here; the page is told they are held for it, as by the runner's frame)
        d = { ...d, interrupt: null, interruptible: !!s.flag, epoch: null, epochShared: !!s.epoch, progress: null, engine: { native: false, threads: true } };
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
    if (d && typeof d === "object" && d.id !== undefined && (d.code !== undefined || d.interact !== undefined || d.evaluate !== undefined)) s.queued.push(d.id);
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
      return send({ hello: { protocol: v, engine: ENGINE_VERSION, build, caps: ["threads", "files", "stop-word", "input", "live-data", "state"] } });
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
      if (s) toSession(s, msg.m);
      return;
    }
    if (msg.close !== undefined && keys.length === 1) {
      const s = sessions.get(msg.close);
      if (s) { sessions.delete(msg.close); s.thread.terminate(); send({ closed: msg.close }); }
      return;
    }
    if (msg.state !== undefined && keys.length === 1) {
      if (typeof msg.state !== "string" || !SID.test(msg.state)) return end(2, "state: a session id is 1 to 64 of A-Z, a-z, 0-9, _ and -");
      const s = sessions.get(msg.state);
      return send(s ? { state: msg.state, open: true, busy: s.busy, queued: [...s.queued], seq: s.seq } : { state: msg.state, open: false });
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
