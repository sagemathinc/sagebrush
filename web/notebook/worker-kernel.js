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

export class WorkerKernel {
  /**
   * @param {object} o
   * @param {() => Worker} o.createWorker a new worker (or anything with postMessage/onmessage/terminate)
   * @param {(worker: Worker) => Promise<void> | void} [o.onStart] called with each new worker before code runs (e.g. to send it files)
   * @param {(message: any) => boolean | void} [o.onMessage] sees each message first; returning true consumes it (e.g. fsChanged)
   */
  constructor({ createWorker, onStart, onMessage }) {
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
    this.listeners = { status: [], restart: [], ready: [] };
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
      if (m.skipped) { this.pending.delete(m.id); return p.skipped ? p.skipped() : p.stopped(""); }
      if (m.start) p.start?.();
      // output of an @interact's function goes to that interact's area
      const dest = m.target != null ? this.targetSink(m.target) : p;
      if (dest) {
        if (m.stream) dest.out(m.text, m.stream === "stderr");
        if (m.display) dest.display(m.display);
        if (m.interact) dest.interact(m.interact);
        if (m.clear) dest.clear();
      }
      if (m.done) { this.pending.delete(m.id); p.done(m.ms); }
    };
    w.onerror = (e) => this.emit("status", "error: " + (e.message || e));
  }

  /** Run code; `sink` receives what happens to it.  opts: {mode: "python"|"sage"|"magma", repl} */
  execute(code, opts, sink) {
    const id = this.nextId++;
    this.pending.set(id, sink);
    this.worker.postMessage({ id, code, sage: opts.mode === "sage", magma: opts.mode === "magma", ...(opts.repl ? { repl: true } : {}) });
  }

  /** Ask the interpreter a question ({complete: text} or {check: source}); resolves to its reply, or `fallback` if it restarts. */
  ask(msg, mode, fallback) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, { reply: resolve, stopped: () => resolve(fallback) });
      this.worker.postMessage({ id, sage: mode === "sage", magma: mode === "magma", ...msg });
    });
  }

  /** Rerun an @interact's function with new values. */
  interact(iid, values, sink) {
    const id = this.nextId++;
    this.pending.set(id, sink);
    this.worker.postMessage({ id, interact: iid, values });
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
    for (const p of pending) p.stopped(message);
    this.start();
    this.emit("restart");
  }

  close() {
    this.worker?.terminate();
    this.pending.clear();
  }
}
