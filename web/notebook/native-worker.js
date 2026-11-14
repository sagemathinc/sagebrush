// The desktop app's engine subprocess (app/engine/, design/native-desktop.md
// §2) as the page sees it: one engine for the page, started through the
// app's shell (app/src-tauri/src/engine.rs), and a NativeWorker per
// interpreter, with a Worker's interface, as RunnerWorker has.  The engine
// holds the interpreter's shared words and translates, as the sandboxed
// runner's frame does, so this speaks that frame's messages: Stop is
// {runnerInterrupt}, input() is answered by {runnerInput}, live data by
// {runnerLive} (web/notebook/worker-kernel.js sends them when a ready
// message says the words are held elsewhere).
//
// Where the app has no engine (none configured), or it doesn't start and
// greet within LIMITS.startMs, each NativeWorker is the page's own Web Worker
// instead (`fallback`), as before.
//
// What may wait is bounded, and every bound fails closed:
// - frames to the engine go one at a time, each handed to the app's shell
//   before the next (which only queues it: the shell's own bound is
//   SEND_MAX); at most LIMITS.pendingMax bytes may wait here, and a hand-over
//   that takes LIMITS.sendMs ends the engine.  A Stop goes urgent, ahead of
//   that queue (its cutoff says which runs it covers, so it may pass a run
//   still on its way: that run is then skipped), one at a time: while one is
//   being handed over, only the latest Stop of each interpreter waits.
//   Everything else, a close too, keeps its order, so nothing an interpreter
//   was asked to do follows its close.
// - what an interpreter is asked before the engine has greeted waits in it, at
//   most LIMITS.queueMax bytes as encoded and LIMITS.queueItems messages (past
//   either the interpreter fails, as for a message that can't be encoded); a
//   terminated one drops it.
// - every deadline is cleared when what it bounds settles.
// - frames from the engine are acknowledged once handled (engine_ack, a few
//   at a time): the shell gives the page only a window of unacknowledged bytes.
// An engine that ends fails each of its interpreters, then and at each later
// message, so the page's kernel starts a new one (and with it a new engine).
import { encode, decode } from "../../app/engine/frames.mjs";

const PROTOCOL = { min: 1, max: 1 };
const FRAME_MAX = 512 * 1024 * 1024;
export const LIMITS = { startMs: 15000, sendMs: 30000, pendingMax: FRAME_MAX + 64 * 1024 * 1024, queueMax: FRAME_MAX + 64 * 1024 * 1024, queueItems: 1024 };
let engine = null; // a promise of the running engine, or of null (none)

/** `p`, or `onTimeout()`'s value (or throw) after `ms`; the timer is cleared when `p` settles. */
function bounded(p, ms, onTimeout) {
  let t;
  const timeout = new Promise((res, rej) => { t = setTimeout(() => { try { res(onTimeout()); } catch (e) { rej(e); } }, ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** The engine, started once (again after it ended): {send, sessions, alive}, or null where there is none. */
export function startEngine(core) {
  if (engine) return engine;
  const me = (engine = (async () => {
    const sessions = new Map(); // sid -> NativeWorker
    let greet, alive = true;
    const greeted = new Promise((res) => (greet = res));
    // (the whole start, the shell's and the engine's greeting, within one deadline, cleared when it is done)
    let startTimer;
    const deadline = new Promise((res) => (startTimer = setTimeout(() => res("timeout"), LIMITS.startMs)));
    // acknowledgements, a few at a time
    let unacked = 0, ackTimer = null;
    const ack = (n) => {
      unacked += n;
      if (ackTimer === null) ackTimer = setTimeout(() => { const b = unacked; unacked = 0; ackTimer = null; if (alive) core.invoke("engine_ack", { bytes: b }).catch(() => {}); }, 0);
    };
    const channel = new core.Channel();
    channel.onmessage = (data) => {
      let bytes, m;
      try {
        bytes = data instanceof Uint8Array ? data : new Uint8Array(data instanceof ArrayBuffer ? data : Array.from(data));
        m = decode(bytes);
      } catch (e) {
        return ended(`the engine sent a malformed frame (${String(e?.message ?? e)})`);
      }
      // (each frame acknowledged as the shell charges it: its payload and its 4-byte length)
      ack(bytes.length + 4);
      if (m.hello || m.incompatible) return greet(m);
      if (m.engineExit !== undefined) return ended(`the engine ${m.engineExit}`);
      if (m.protocolError !== undefined) return ended(`the engine refused a message: ${String(m.protocolError).slice(0, 300)}`);
      const sid = m.from ?? m.error ?? m.closed;
      const w = typeof sid === "string" ? sessions.get(sid) : undefined;
      if (!w) return;
      if (m.from !== undefined) w._message(m.m);
      else if (m.error !== undefined) w._error(String(m.message ?? "an error in the interpreter"));
      else { sessions.delete(sid); w._dead("the engine stopped this interpreter"); }
    };
    // (the engine gone: each of its interpreters fails, now and at its next message; the next starts a new engine)
    const ended = (why) => {
      if (!alive) return;
      alive = false;
      greet(null);
      if (engine === me) engine = null;
      core.invoke("engine_stop").catch(() => {});
      for (const w of sessions.values()) w._dead(why);
      sessions.clear();
    };
    let queue = Promise.resolve(), pending = 0;
    const handOver = (payload, urgent) =>
      bounded(core.invoke("engine_send", payload, urgent ? { headers: { "Sagebrush-Urgent": "1" } } : undefined), LIMITS.sendMs, () => {
        throw new Error("the engine didn't take a message in time");
      });
    // Stops: one handed over at a time; meanwhile the latest of each interpreter waits (an earlier one's cutoff is
    // covered by the later one's, the kernel's cutoffs only grow)
    const urgentNext = new Map(); // sid -> payload
    let urgentBusy = false;
    const pumpUrgent = () => {
      if (urgentBusy || !alive || urgentNext.size === 0) return;
      const [sid, payload] = urgentNext.entries().next().value;
      urgentNext.delete(sid);
      urgentBusy = true;
      handOver(payload, true).then(() => { urgentBusy = false; pumpUrgent(); }, (e) => ended(String(e?.message ?? e)));
    };
    const send = (msg, urgent = false) => {
      if (!alive) return false;
      let payload;
      try {
        payload = encode(msg);
      } catch (e) {
        ended(`a message the engine can't be sent: ${String(e?.message ?? e)}`);
        return false;
      }
      if (urgent) {
        urgentNext.delete(msg.to);
        urgentNext.set(msg.to, payload);
        pumpUrgent();
        return true;
      }
      if (pending + payload.length > LIMITS.pendingMax) {
        ended("the engine isn't taking messages");
        return false;
      }
      pending += payload.length;
      queue = queue
        .then(() => (alive ? handOver(payload, false) : undefined))
        .catch((e) => ended(String(e?.message ?? e)))
        .finally(() => { pending -= payload.length; });
      return true;
    };
    const started = await Promise.race([core.invoke("engine_start", { onFrame: channel }), deadline]);
    if (started !== true) {
      clearTimeout(startTimer);
      alive = false;
      if (engine === me) engine = null;
      if (started === "timeout") core.invoke("engine_stop").catch(() => {});
      return null;
    }
    send({ hello: { protocol: PROTOCOL, client: "sagebrush-app", want: [] } });
    const h = await Promise.race([greeted, deadline]);
    clearTimeout(startTimer);
    if (!h?.hello) {
      ended(h?.incompatible ? "the engine speaks another protocol version" : "the engine didn't answer");
      return null;
    }
    return { send, sessions, alive: () => alive };
  })().catch(() => {
    if (engine === me) engine = null;
    return null;
  }));
  return me;
}

/** (tests) forget the engine, so the next interpreter starts another */
export function _resetEngine() {
  engine = null;
}

let next = 0;
export class NativeWorker {
  /** core: the app's IPC (window.__TAURI__.core); fallback(): the page's own Worker, where there is no engine. */
  constructor(core, { name = "", fallback }) {
    this.onmessage = null;
    this.onerror = null;
    this.interruptible = false;
    this.inner = null;
    this.sid = `w${++next}${Math.random().toString(36).slice(2, 8)}`;
    this.queue = [];
    this.queued = 0;
    this.closed = false;
    this.deadWhy = null;
    this.engine = null;
    startEngine(core).then((e) => {
      if (this.closed || this.deadWhy) return;
      if (!e) {
        // (no engine: the page's own worker, and everything asked of this one so far, in order)
        const w = (this.inner = fallback());
        w.onmessage = (ev) => this.onmessage?.(ev);
        w.onerror = (ev) => this.onerror?.(ev);
        for (const m of this.queue.splice(0)) w.postMessage(m);
        this.queued = 0;
        return;
      }
      this.engine = e;
      e.sessions.set(this.sid, this);
      e.send({ open: this.sid, name });
      for (const m of this.queue.splice(0)) e.send({ to: this.sid, m });
      this.queued = 0;
    });
  }
  _message(d) {
    if (d && d.ready) this.interruptible = !!d.interruptible;
    this.onmessage?.({ data: d });
  }
  _error(message) {
    if (!this.closed) this.onerror?.({ message });
  }
  // (this interpreter can't run anything any more: said now, and again at each later message, so a run asked after
  // it, while nothing was pending, still restarts it)
  _dead(why) {
    if (this.closed || this.deadWhy) return;
    this.deadWhy = why;
    this.queue = [];
    this.queued = 0;
    this.onerror?.({ message: why });
  }
  /** (whether this interpreter is the engine's: false while it starts, and where it is the page's own worker) */
  get native() {
    return !!this.engine && !this.deadWhy;
  }
  postMessage(m) {
    if (this.inner) return this.inner.postMessage(m);
    if (this.closed) return;
    if (this.deadWhy) return void setTimeout(() => !this.closed && this.onerror?.({ message: this.deadWhy }), 0);
    if (!this.engine) {
      // (measured as it will be sent: encoded, its frame's envelope aside)
      let n;
      try {
        n = encode(m).length;
      } catch (e) {
        return this._dead(`a message this interpreter can't be sent: ${String(e?.message ?? e)}`);
      }
      if (this.queued + n > LIMITS.queueMax || this.queue.length >= LIMITS.queueItems) return this._dead("too much was asked of this interpreter before the engine started");
      this.queue.push(m);
      this.queued += n;
      return;
    }
    if (!this.engine.send({ to: this.sid, m })) this._dead("the engine stopped");
  }
  // Stop, as for the runner: the engine sets the interrupt word (worker-kernel.js calls it with its cutoff)
  get interrupt() {
    if (this.inner) return this.inner.interrupt;
    return this.interruptible && !this.deadWhy ? (upTo) => this.engine?.send({ to: this.sid, m: { runnerInterrupt: upTo } }, true) : undefined;
  }
  terminate() {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.queued = 0;
    this.inner?.terminate();
    if (this.engine) {
      this.engine.sessions.delete(this.sid);
      // (in order, after everything already sent: never ahead of its own open or its runs)
      this.engine.send({ close: this.sid });
    }
  }
}
