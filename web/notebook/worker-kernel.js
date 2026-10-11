// The in-browser kernel: Sagebrush's interpreter in a Web Worker
// (web/worker.ts -> sagebrush-worker.js), behind the notebook's Kernel
// interface (web/notebook/types.ts).  Anything with a Worker's interface
// works: the page's RemoteWorker runs Python natively behind `sagebrush
// notebook`'s local server.
//
//   const kernel = new WorkerKernel({ createWorker: () => new Worker("sagebrush-worker.js", { type: "module" }) });
//   kernel.on("status", (text) => ...);
//   kernel.start();

const STOPPED = "\nStopped (it did not respond to the interrupt, so the interpreter was restarted; variables are gone).\n";

// A fast 53-bit hash of a run's output messages (cyrb53, fed incrementally),
// for TimeTravel replay to check that a replayed run printed the same.
function hashInit() { return [0xdeadbeef, 0x41c6ce57]; }
function hashAdd(h, s) {
  let [h1, h2] = h;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h[0] = h1; h[1] = h2;
}
function hashEnd(h) {
  let [h1, h2] = h;
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
// (a display bundle with its keys in order)
const canon = (o) => JSON.stringify(o, Object.keys(o ?? {}).sort());

export class WorkerKernel {
  static count = 0;
  /**
   * @param {object} o
   * @param {() => Worker} o.createWorker a new worker (or anything with postMessage/onmessage/terminate)
   * @param {(worker: Worker) => Promise<void> | void} [o.onStart] called with each new worker before code runs (e.g. to send it files)
   * @param {(message: any) => boolean | void} [o.onMessage] sees each message first; returning true consumes it (e.g. fsChanged)
   */
  constructor({ createWorker, onStart, onMessage }) {
    this.uid = ++WorkerKernel.count; // (one of several: a page may run one per notebook)
    this.createWorker = createWorker;
    this.onStart = onStart;
    this.onMessage = onMessage;
    this.worker = null;
    this.nextId = 1;
    this.generation = 0; // a new interpreter: interacts and prompts from before are stale
    this.version = "";
    this.ready = false;
    this.started = Promise.resolve();
    this.interruptFlag = null;
    // id -> a sink {start(), out(text, isErr), display(bundle), interact(spec),
    // clear(), done(ms), stopped(message), skipped()} for running code, or
    // {reply(message)} for a question
    this.pending = new Map();
    this.listeners = { status: [], restart: [], ready: [], run: [], execute: [] };
    // TimeTravel's journal: id -> what a run is ({kind, code, ...}), its
    // output hash and timing; reported by the "run" event when it is done
    this.runs = new Map();
    this.interrupted = new Set();
    this.readyInfo = null; // the worker's ready message (seeded, startup clock)
    // where output addressed to an @interact goes (set by the notebook)
    this.targetSink = () => null;
  }

  on(event, f) { (this.listeners[event] ??= []).push(f); return () => { this.listeners[event] = this.listeners[event].filter((g) => g !== f); }; }
  emit(event, ...args) { for (const f of this.listeners[event] ?? []) f(...args); }

  start() {
    this.ready = false;
    this.emit("status", "loading…");
    this.generation++;
    const t0 = performance.now();
    const w = (this.worker = this.createWorker());
    this.started = Promise.resolve(this.onStart?.(w));
    w.onmessage = (ev) => {
      const m = ev.data;
      if (this.onMessage?.(m)) return;
      if (m.ready) {
        this.readyInfo = { seeded: !!m.seeded, startup: m.startup?.clock ?? [], ms: performance.now() - t0, version: m.version || "" };
        this.version = m.version || "";
        this.interruptFlag = m.interrupt ? new Int32Array(m.interrupt) : null;
        this.ready = true;
        this.emit("status", `ready (sagebrush ${this.version}, ${Math.round(performance.now() - t0)} ms)`);
        this.emit("ready");
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      if (p.reply) { this.pending.delete(m.id); return p.reply(m); }
      if (m.skipped) { this.pending.delete(m.id); this.runs.delete(m.id); return p.skipped ? p.skipped() : p.stopped(""); }
      const r = this.runs.get(m.id);
      if (r) {
        if (m.start) r.t = Date.now(), r.t0 = performance.now();
        const at = m.target != null ? "@" + m.target : "";
        if (m.stream) hashAdd(r.h, `${at}${m.stream}:${m.text}`);
        if (m.display) hashAdd(r.h, `${at}display:${canon(m.display)}`);
        if (m.interact) hashAdd(r.h, `${at}interact:${canon(m.interact)}`);
        if (m.clear) hashAdd(r.h, `${at}clear`);
      }
      if (m.start) p.start?.();
      // output of an @interact's function goes to that interact's area
      const dest = m.target != null ? this.targetSink(m.target) : p;
      if (dest) {
        if (m.stream) dest.out(m.text, m.stream === "stderr");
        if (m.display) dest.display(m.display);
        if (m.interact) dest.interact(m.interact);
        if (m.clear) dest.clear();
      }
      if (m.done) {
        this.pending.delete(m.id);
        // (Stop: it ended with the KeyboardInterrupt it was sent)
        const interrupted = this.interrupted.has(m.id) && !!m.error;
        if (r) this.finishRun(m, r);
        else this.interrupted.delete(m.id);
        p.done(m.ms, { error: !!m.error, ...(interrupted ? { interrupted: true } : {}), ...(m.files ? { files: m.files } : {}), ...(m.names ? { names: m.names } : {}) });
      }
    };
    // (a worker that failed may never answer: what waits on it is told, and a
    // new one starts, rather than waiting forever)
    w.onerror = (e) => {
      this.emit("status", "error: " + (e.message || e));
      if (w === this.worker && this.pending.size) this.restart(`\nThe interpreter failed (${e.message || "an error in its worker"}) and was restarted; variables are gone.\n`);
    };
  }

  /**
   * Run code; `sink` receives what happens to it.
   * opts: {mode: "python"|"sage"|"magma", repl, cell (the notebook cell's id,
   * for the journal), clock (TimeTravel replay: the clock values to replay),
   * forget (global names to delete first: the reactive notebook), mangle
   * (the cell's `_` names are its own: the reactive notebook), seed (64 hex
   * digits: the run's entropy, the reactive notebook's per-cell seeds)}
   * The sink's done(ms, {error, interrupted, files}) says whether the code
   * raised (interrupted: KeyboardInterrupt from interrupt()), and
   * which files it read and wrote ({reads, writes}: paths).
   */
  execute(code, opts, sink) {
    if (!this.worker) return sink.stopped?.("\nThe interpreter was stopped.\n");
    const id = this.nextId++;
    this.pending.set(id, sink);
    const forget = { ...(opts.forget?.length ? { forget: [...opts.forget] } : {}), ...(opts.mangle && opts.cell ? { mangle: String(opts.cell).replace(/[^A-Za-z0-9]/g, "") } : {}), ...(opts.seed ? { seed: opts.seed } : {}) };
    const run = { kind: "code", code, mode: opts.mode, ...(opts.repl ? { repl: true } : {}), ...(opts.cell ? { cell: opts.cell } : {}), ...forget };
    this.track(id, run);
    this.worker.postMessage({ id, code, sage: opts.mode === "sage", magma: opts.mode === "magma", ...(opts.repl ? { repl: true } : {}), ...(opts.clock ? { clock: opts.clock } : {}), ...forget });
  }

  // The journal (TimeTravel): "execute" as a run is asked for (the page
  // saves the document's version then), "run" when it is done.
  track(id, run) {
    const r = { ...run, gen: this.generation, h: hashInit(), t: 0, t0: 0 };
    this.runs.set(id, r);
    this.emit("execute", r);
  }
  finishRun(m, r) {
    this.runs.delete(m.id);
    const rec = { ...r, ms: r.t0 ? performance.now() - r.t0 : m.ms, out: hashEnd(r.h) };
    delete rec.h; delete rec.t0;
    if (m.clock?.length) rec.clock = m.clock;
    if (m.overflow) rec.overflow = true;
    if (m.extra) rec.extra = m.extra;
    if (m.unused) rec.unused = m.unused;
    if (m.error) rec.error = true;
    if (this.interrupted.delete(m.id)) rec.status = "interrupted";
    this.emit("run", rec);
  }

  /** Ask the interpreter a question ({complete: text} or {check: source}); resolves to its reply, or `fallback` if it restarts. */
  ask(msg, mode, fallback) {
    return new Promise((resolve) => {
      if (!this.worker) return resolve(fallback);
      const id = this.nextId++;
      this.pending.set(id, { reply: resolve, stopped: () => resolve(fallback) });
      this.worker.postMessage({ id, sage: mode === "sage", magma: mode === "magma", ...msg });
    });
  }

  /** Rerun an @interact's function with new values (opts.clock: TimeTravel replay). */
  interact(iid, values, sink, opts = {}) {
    if (!this.worker) return sink.stopped?.("\nThe interpreter was stopped.\n");
    const id = this.nextId++;
    this.pending.set(id, sink);
    // (a copy: the journal's document freezes what it is given, and the
    // notebook keeps changing its own values object)
    this.track(id, { kind: "interact", iid, values: JSON.parse(JSON.stringify(values)) });
    this.worker.postMessage({ id, interact: iid, values, ...(opts.clock ? { clock: opts.clock } : {}) });
  }

  /** Send the worker anything else (files). */
  post(msg) { this.worker?.postMessage(msg); }

  // Interrupt what is running: KeyboardInterrupt in the worker (Python loops
  // and the Rust engines check a flag shared with this page), keeping every
  // variable; queued runs are skipped.  Where that is impossible (no
  // SharedArrayBuffer), or if the program does not stop within 2 s (a loop
  // that never checks), restart the interpreter.
  interrupt(message = STOPPED) {
    if ((!this.interruptFlag && !this.worker.interrupt) || this.pending.size === 0) return this.restart(message);
    const waiting = [...this.pending.keys()];
    for (const id of waiting) if (this.runs.has(id)) this.interrupted.add(id); // (the journal: not exactly replayable)
    if (this.interruptFlag) {
      Atomics.store(this.interruptFlag, 1, this.nextId - 1);
      Atomics.store(this.interruptFlag, 0, 1);
    } else this.worker.interrupt(this.nextId - 1);
    const gen = this.generation;
    setTimeout(() => {
      if (this.generation === gen && waiting.some((id) => this.pending.has(id))) this.restart(message);
    }, 2000);
  }

  /** A fresh interpreter; what was running or queued is told `message`. */
  restart(message = "\nInterpreter restarted.\n") {
    this.worker?.terminate();
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.runs.clear();
    this.interrupted.clear();
    for (const p of pending) p.stopped(message);
    this.start();
    this.emit("restart");
  }

  /** Stop for good: what was running or queued is told `message`. */
  close(message = "\nThe interpreter was stopped.\n") {
    this.worker?.terminate();
    this.worker = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.runs.clear();
    this.interrupted.clear();
    for (const p of pending) (p.stopped ?? p.reply)?.(message);
  }
}
