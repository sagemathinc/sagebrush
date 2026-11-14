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
// Where the app has no engine (none configured), or it doesn't start or
// greet, each NativeWorker is the page's own Web Worker instead (`fallback`),
// as before.
import { encode, decode } from "../../app/engine/frames.mjs";

const PROTOCOL = { min: 1, max: 1 };
let engine = null; // a promise of the running engine, or of null (none)

/** The engine, started once (again after it ended): {send, sessions, caps}, or null where there is none. */
function startEngine(core) {
  if (engine) return engine;
  engine = (async () => {
    const sessions = new Map(); // sid -> NativeWorker
    let greet, alive = true;
    const greeted = new Promise((res) => (greet = res));
    const channel = new core.Channel();
    channel.onmessage = (data) => {
      let m;
      try {
        m = decode(data instanceof Uint8Array ? data : new Uint8Array(data instanceof ArrayBuffer ? data : Array.from(data)));
      } catch (e) {
        return ended(`the engine sent a malformed frame (${String(e?.message ?? e)})`);
      }
      if (m.hello || m.incompatible) return greet(m);
      if (m.engineExit !== undefined) return ended(`the engine ${m.engineExit}`);
      if (m.protocolError !== undefined) return ended(`the engine refused a message: ${String(m.protocolError).slice(0, 300)}`);
      const sid = m.from ?? m.error ?? m.closed;
      const w = typeof sid === "string" ? sessions.get(sid) : undefined;
      if (!w) return;
      if (m.from !== undefined) w._message(m.m);
      else if (m.error !== undefined) w._error(String(m.message ?? "an error in the interpreter"));
      else { sessions.delete(sid); w._closed(); }
    };
    // (the engine gone: every interpreter in it reports it, and the next interpreter starts a new engine)
    const ended = (why) => {
      if (!alive) return;
      alive = false;
      greet(null);
      if (engine === me) engine = null;
      for (const w of sessions.values()) w._error(why);
      sessions.clear();
    };
    // frames to the engine in order, each after the one before is handed over; a Stop goes at once (its cutoff,
    // upTo, says which runs it covers, so it may pass a run still on its way: that run is then skipped)
    let queue = Promise.resolve();
    const post = (msg) => core.invoke("engine_send", encode(msg));
    const send = (msg, now = false) => {
      if (!alive) return;
      if (now) post(msg).catch((e) => ended(String(e?.message ?? e)));
      else queue = queue.then(() => alive && post(msg)).catch((e) => ended(String(e?.message ?? e)));
    };
    if (!(await core.invoke("engine_start", { onFrame: channel }))) return null;
    send({ hello: { protocol: PROTOCOL, client: "sagebrush-app", want: [] } });
    const h = await Promise.race([greeted, new Promise((res) => setTimeout(() => res(null), 15000))]);
    if (!h?.hello) {
      ended(h?.incompatible ? "the engine speaks another protocol version" : "the engine didn't answer");
      core.invoke("engine_stop").catch(() => {});
      return null;
    }
    return { send, sessions, caps: h.hello.caps ?? [], version: h.hello.engine, alive: () => alive };
  })().catch(() => null);
  const me = engine;
  return engine;
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
    this.closed = false;
    this.engine = null;
    startEngine(core).then((e) => {
      if (this.closed) return;
      if (!e) {
        // (no engine: the page's own worker, and everything asked of this one so far, in order)
        const w = (this.inner = fallback());
        w.onmessage = (ev) => this.onmessage?.(ev);
        w.onerror = (ev) => this.onerror?.(ev);
        for (const m of this.queue.splice(0)) w.postMessage(m);
        return;
      }
      this.engine = e;
      e.sessions.set(this.sid, this);
      e.send({ open: this.sid, name });
      for (const m of this.queue.splice(0)) e.send({ to: this.sid, m });
    });
  }
  _message(d) {
    if (d && d.ready) this.interruptible = !!d.interruptible;
    this.onmessage?.({ data: d });
  }
  _error(message) {
    if (!this.closed) this.onerror?.({ message });
  }
  _closed() {
    if (!this.closed) this.onerror?.({ message: "the engine stopped this interpreter" });
  }
  /** (whether this interpreter is the engine's: false while it starts, and where it is the page's own worker) */
  get native() {
    return !!this.engine;
  }
  postMessage(m) {
    if (this.inner) return this.inner.postMessage(m);
    if (this.closed) return;
    if (!this.engine) return void this.queue.push(m);
    this.engine.send({ to: this.sid, m });
  }
  // Stop, as for the runner: the engine sets the interrupt word (worker-kernel.js calls it with its cutoff)
  get interrupt() {
    if (this.inner) return this.inner.interrupt;
    return this.interruptible ? (upTo) => this.engine?.send({ to: this.sid, m: { runnerInterrupt: upTo } }, true) : undefined;
  }
  terminate() {
    if (this.closed) return;
    this.closed = true;
    this.inner?.terminate();
    if (this.engine) {
      this.engine.sessions.delete(this.sid);
      this.engine.send({ close: this.sid }, true);
    }
  }
}
