// The in-browser kernel: Sagebrush's interpreter in a Web Worker
// (web/worker.ts -> sagebrush-worker.js), behind the notebook's Kernel
// interface (web/notebook/types.ts).  Anything with a Worker's interface
// works: the page's RemoteWorker runs Python natively behind `sagebrush
// notebook`'s local server.
//
//   const kernel = new WorkerKernel({ createWorker: () => new Worker("sagebrush-worker.js", { type: "module" }) });
//   kernel.on("status", (text) => ...);
//   kernel.on("loading", (what) => ...);  // a mode's library is being fetched ("Sage"), or done (null)
//   kernel.start();

const STOPPED = "\nStopped: it did not stop when interrupted, so the interpreter was restarted; variables are gone.\n";

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

// input(): the answer to a worker's {input, buffer} (web/worker.ts's stdin),
// given at most once: reply(text) writes the line, reply(null) end of input.
// Int32 [0] the state (1 a line, 2 end of input), [1] its length in bytes,
// then its UTF-8 bytes, cut to fit at a character's boundary.  When the
// buffer isn't here (the runner's frame keeps it, web/runner/index.html),
// send(text) asks the frame to write it.  reply.retire() closes it unanswered
// (the question is over: its run asked another, was stopped or ended), and
// calls reply.onretire, set by whoever shows the question.
function answerInput(buffer, send) {
  let done = false;
  const reply = (text) => {
    if (done) return;
    done = true;
    if (!(typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer) || buffer.byteLength < 8) return send(text == null ? null : String(text));
    const ctl = new Int32Array(buffer, 0, 2);
    if (Atomics.load(ctl, 0) !== 0) return;
    if (text == null) {
      Atomics.store(ctl, 0, 2);
    } else {
      const max = buffer.byteLength - 8, enc = new TextEncoder();
      let s = String(text), bytes = enc.encode(s);
      while (bytes.length > max) bytes = enc.encode((s = Array.from(s).slice(0, -Math.max(1, Math.ceil((bytes.length - max) / 4))).join("")));
      new Uint8Array(buffer, 8, bytes.length).set(bytes);
      Atomics.store(ctl, 1, bytes.length);
      Atomics.store(ctl, 0, 1);
    }
    Atomics.notify(ctl, 0);
  };
  reply.retire = () => {
    if (done) return;
    done = true;
    reply.onretire?.();
  };
  return reply;
}

// (how long a check may wait for the interpreter to take it up: what runs
// before it is the board's code, which has its own bounds)
// (a test may set less: globalThis.__sbEvaluateStartMs)
const evaluateStartMs = () => Number(globalThis.__sbEvaluateStartMs) || 30_000;

// The library's chunks the worker fetched and installed (web/lib-lazy.ts),
// for the service worker to keep (web/sw.js): it keeps a chunk as it passes
// through it, and a page it did not control when it loaded (a first visit)
// fetched its first chunks past it, so offline they would be missing.  Told
// to the service worker once it controls the page; nothing to do if it
// already did at load (every fetch then went through it).
// (reading it throws in an opaque origin: a sandboxed frame, web/board's)
let sw;
try {
  sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
} catch {}
const controlledAtLoad = !!sw?.controller;
const unkept = new Set();
function flushChunks() {
  const c = sw?.controller;
  if (!c || !unkept.size) return;
  try {
    c.postMessage({ keep: [...unkept] });
  } catch {}
  unkept.clear();
}
function keepChunk(file) {
  if (!sw || controlledAtLoad || typeof file !== "string") return;
  unkept.add(file);
  flushChunks();
}
sw?.addEventListener?.("controllerchange", flushChunks);

// The optional package set's files the live interpreters use (web/
// pkgset-browser.ts), pinned in the service worker's package cache while
// they run: told every 2 minutes, kept 10 minutes after (web/sw.js).  Never
// permanent: a set no interpreter uses can be evicted, and is fetched again.
const pkgPins = new Map(); // kernel uid -> [sha256]
let pinTimer = null;
function pinPackages() {
  const all = [...new Set([...pkgPins.values()].flat())].slice(0, 64);
  try {
    if (all.length) sw?.controller?.postMessage({ pkgPin: all });
  } catch {}
  if (!pkgPins.size && pinTimer) {
    clearInterval(pinTimer);
    pinTimer = null;
  } else if (pkgPins.size && !pinTimer) pinTimer = setInterval(pinPackages, 2 * 60 * 1000);
}

export class WorkerKernel {
  static count = 0;
  /**
   * @param {object} o
   * @param {() => Worker} o.createWorker a new worker (or anything with postMessage/onmessage/terminate)
   * @param {(worker: Worker) => Promise<void> | void} [o.onStart] called with each new worker before code runs (e.g. to send it files); nothing but its limits ({init}) is sent to the worker until it is done
   * @param {(message: any) => boolean | void} [o.onMessage] sees each message first; returning true consumes it (e.g. fsChanged)
   * @param {string | null} [o.limits] the engine's limits, a JSON text (src/limits.ts): the deployment's
   *   or the course's, never a document's; omitted or null for the defaults.  Every worker this kernel
   *   starts, restarts too, is given the same value first ({init}), and runs nothing before it is valid;
   *   anything else supplied (an object, a number...) is passed on as it is, for the worker to refuse:
   *   settings given wrongly are never the defaults (astra CORR-FF93-1)
   */
  constructor({ createWorker, onStart, onMessage, limits = null }) {
    this.uid = ++WorkerKernel.count; // (one of several: a page may run one per notebook)
    this.createWorker = createWorker;
    this.limits = limits === undefined ? null : limits;
    this.onStart = onStart;
    this.onMessage = onMessage;
    this.worker = null;
    this.nextId = 1;
    this.generation = 0; // a new interpreter: interacts and prompts from before are stale
    this.version = "";
    this.ready = false;
    this.started = Promise.resolve();
    this.startError = null;
    this.interruptFlag = null;
    // id -> a sink {start(), out(text, isErr), display(bundle), interact(spec),
    // clear(), done(ms), stopped(message), skipped()} for running code, or
    // {reply(message)} for a question
    this.pending = new Map();
    this.listeners = { status: [], restart: [], ready: [], run: [], execute: [], loading: [] };
    // TimeTravel's journal: id -> what a run is ({kind, code, ...}), its
    // output hash and timing; reported by the "run" event when it is done
    this.runs = new Map();
    this.interrupted = new Set();
    // X1: each language's environment in this worker, per mode: {gen, token,
    // state: "pending" | "ready"}; requests that load it (a run, Tab, check,
    // a warm-up) settle the entry they were sent with, by id (modeClaims), and
    // only that entry: a late answer from an old worker or for an older entry
    // changes nothing.  A new worker starts with none.
    this.modeState = new Map();
    this.modeClaims = new Map();
    this.modeToken = 0;
    this.readyInfo = null; // the worker's ready message (seeded, startup clock)
    // input() questions shown and not yet answered: reply -> its run's id
    this.inputs = new Map();
    // where output addressed to an @interact goes (set by the notebook)
    this.targetSink = () => null;
  }

  on(event, f) { (this.listeners[event] ??= []).push(f); return () => { this.listeners[event] = this.listeners[event].filter((g) => g !== f); }; }
  emit(event, ...args) { for (const f of this.listeners[event] ?? []) f(...args); }

  start() {
    this.ready = false;
    this.context = null;
    clearTimeout(this.libTimer);
    this.libShown = false;
    this.emit("status", "loading…");
    this.generation++;
    this.modeState.clear();
    this.modeClaims.clear();
    const t0 = performance.now();
    const w = (this.worker = this.createWorker());
    // (the worker's first message: its limits, web/worker.ts's init gate)
    try {
      w.postMessage({ init: { limits: this.limits } });
    } catch {
      // (a value postMessage can't copy, a function say: refused all the same)
      w.postMessage({ init: { limits: { uncloneable: typeof this.limits } } });
    }
    // (a barrier: every run, interact, question and check waits for onStart,
    // e.g. the notebook's package set resolved and durably pinned (index.html);
    // if it fails, what waits is stopped, and the next one starts a new
    // worker: nothing ever runs in one whose start failed, astra's CORR-PR68-3)
    this.startError = null;
    // (with nothing to wait for, what is asked goes to the worker at once, as
    // before; else it is queued until the start is done)
    this.startDone = !this.onStart;
    this.queued = 0;
    let begun;
    try {
      begun = Promise.resolve(this.onStart?.(w));
    } catch (e) {
      begun = Promise.reject(e);
    }
    this.started = begun.then(() => {
      if (w === this.worker) this.startDone = true;
    }, (e) => {
      if (w !== this.worker) return;
      this.startError = e ?? new Error("it did not start");
      const message = `\nThe interpreter did not start: ${String(this.startError?.message ?? this.startError).slice(0, 300)}\n`;
      this.emit("status", "error: " + message.trim());
      const pending = [...this.pending.values()];
      this.pending.clear();
      this.runs.clear();
      this.interrupted.clear();
      // (X1: the languages' entries of an interpreter that never started are
      // gone, so the next user action asks again; nothing asks by itself,
      // astra2's X1-CODE-START)
      this.modeState.clear();
      this.modeClaims.clear();
      for (const p of pending) p.stopped(message);
    });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (this.onMessage?.(m)) return;
      if (m.initFailed !== undefined) {
        this.emit("status", `error: This engine's settings are invalid: ${String(m.initFailed).slice(0, 300)}; ask the site's administrator.`);
        return;
      }
      if (m.ready) {
        this.readyInfo = { seeded: !!m.seeded, startup: m.startup?.clock ?? [], ms: performance.now() - t0, version: m.version || "" };
        this.version = m.version || "";
        this.interruptFlag = m.interrupt ? new Int32Array(m.interrupt) : null;
        this.context = m.context ?? null;
        this.ready = true;
        this.readyText = `ready (sagebrush ${this.version}, ${Math.round(performance.now() - t0)} ms)`;
        this.emit("status", this.readyText);
        this.emit("ready");
        return;
      }
      // a mode's library, fetched the first time it runs (web/lib-lazy.ts):
      // said once it has taken 300 ms, until it is here, in the status and
      // ("loading" event) on the cells waiting for it
      if (m.libChunk !== undefined) return keepChunk(m.libChunk);
      if (m.pkgUsed !== undefined) {
        if (w === this.worker && Array.isArray(m.pkgUsed)) pkgPins.set(this.uid, m.pkgUsed.filter((d) => typeof d === "string" && /^[0-9a-f]{64}$/.test(d)));
        return pinPackages();
      }
      if (m.pkgsetError !== undefined) return this.emit("status", `optional packages are off: ${String(m.pkgsetError).slice(0, 300)}`);
      if (m.libLoading !== undefined) {
        clearTimeout(this.libTimer);
        if (m.libLoading) this.libTimer = setTimeout(() => { this.libShown = true; this.emit("status", `loading ${m.libLoading}…`); this.emit("loading", m.libLoading); }, 300);
        else if (this.libShown) { this.libShown = false; this.emit("status", this.readyText); this.emit("loading", null); }
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      // (a request's one terminal message settles the language entry it was sent with)
      if (p.reply || m.skipped || m.done) this.settleMode(m.id, m.modeReady === true);
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
      // input(): the worker waits on m.buffer for a line (web/worker.ts's stdin);
      // the answer names this request (its key), and the run's earlier
      // question, if still shown, is over
      if (m.input) {
        this.retireInputs(m.id);
        const key = m.input.key;
        const reply = answerInput(m.buffer, (text) => w.postMessage({ runnerInput: m.id, key, text }));
        this.inputs.set(reply, m.id);
        if (dest?.input) dest.input(String(m.input.prompt ?? ""), reply);
        else reply(null);
      }
      if (dest) {
        if (m.stream) dest.out(m.text, m.stream === "stderr");
        if (m.display) dest.display(m.display);
        if (m.interact) dest.interact(m.interact);
        if (m.clear) dest.clear();
      }
      if (m.done) {
        this.retireInputs(m.id);
        this.pending.delete(m.id);
        // (Stop: it ended with the KeyboardInterrupt it was sent)
        const interrupted = this.interrupted.has(m.id) && !!m.error;
        if (r) this.finishRun(m, r);
        else this.interrupted.delete(m.id);
        p.done(m.ms, { error: !!m.error, ...(interrupted ? { interrupted: true } : {}), ...(m.files ? { files: m.files } : {}), ...(m.names ? { names: m.names } : {}), ...(typeof m.evaluated === "string" ? { evaluated: m.evaluated } : {}) });
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
   * opts: {mode: "python"|"sage"|"magma"|"matlab", repl, cell (the notebook cell's id,
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
    this.retryStart();
    const id = this.nextId++;
    this.pending.set(id, sink);
    const forget = { ...(opts.forget?.length ? { forget: [...opts.forget] } : {}), ...(opts.mangle && opts.cell ? { mangle: String(opts.cell).replace(/[^A-Za-z0-9]/g, "") } : {}), ...(opts.seed ? { seed: opts.seed } : {}), ...(opts.scoped && Object.keys(opts.scoped).length ? { scoped: { ...opts.scoped } } : {}) };
    const run = { kind: "code", code, mode: opts.mode, ...(opts.repl ? { repl: true } : {}), ...(opts.cell ? { cell: opts.cell } : {}), ...forget };
    // (what the run is, and the document version its code is from, are taken
    // now ("execute"); it goes to the worker once the start is done, and into
    // the journal when it is done ("run"))
    this.track(id, run);
    this.claim(id, opts.mode);
    this.whenStarted(id, sink, () => this.worker.postMessage({ id, code, sage: opts.mode === "sage", magma: opts.mode === "magma", matlab: opts.mode === "matlab", ...(opts.repl ? { repl: true } : {}), ...(opts.clock ? { clock: opts.clock } : {}), ...forget }));
  }

  // after the start, in the order asked, if this is still pending in the same worker
  whenStarted(id, entry, f) {
    const w = this.worker;
    if (this.startDone && !this.startError && this.queued === 0) return f();
    this.queued++;
    this.started.then(() => {
      if (w !== this.worker) return;
      this.queued--;
      if (!this.startError && this.pending.get(id) === entry) f();
    });
  }
  // a worker whose start failed is replaced before anything more is asked of it
  retryStart() {
    if (!this.startError) return;
    this.worker?.terminate();
    this.start();
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
    if (m.files?.sources?.length) rec.sources = m.files.sources;
    if (m.error) rec.error = true;
    if (this.interrupted.delete(m.id)) rec.status = "interrupted";
    this.emit("run", rec);
  }

  /** X1: the language entry for `mode` in this worker, made pending if there
   * is none (synchronously: a storm of triggers finds it); null for Python,
   * which loads nothing.  `fresh`: whether it was just made. */
  modeEntry(mode) {
    if (mode !== "sage" && mode !== "magma" && mode !== "matlab") return null;
    let e = this.modeState.get(mode);
    const fresh = !e || e.gen !== this.generation;
    if (fresh) this.modeState.set(mode, (e = { gen: this.generation, token: ++this.modeToken, state: "pending" }));
    return { e, fresh };
  }
  /** Settle request id's language entry: ready, or gone (the next trigger tries again), if it is still that entry. */
  settleMode(id, ready) {
    const c = this.modeClaims.get(id);
    if (!c) return;
    this.modeClaims.delete(id);
    if (this.modeState.get(c.mode) !== c.e) return;
    if (ready) c.e.state = "ready";
    else this.modeState.delete(c.mode);
  }
  claim(id, mode) {
    const r = this.modeEntry(mode);
    if (r) this.modeClaims.set(id, { mode, e: r.e });
  }
  /** X1: load `mode`'s environment now, for a user's action (selecting the
   * mode, pointing at or typing in a code cell): at most one warm-up while
   * its entry is pending or ready; resolves to the worker's answer, or null
   * if nothing was sent. */
  warm(mode) {
    if (!this.worker) return Promise.resolve(null);
    // (a worker whose start failed is replaced first, so the entry is the new
    // interpreter's, astra2's X1-CODE-START)
    this.retryStart();
    const r = this.modeEntry(mode);
    if (!r || !r.fresh) return Promise.resolve(null);
    return this.ask({ warm: true }, mode, { warmed: null, restarted: true }, r.e);
  }

  /** Ask the interpreter a question ({complete: text}, {check: source} or {warm: true}); resolves to its reply, or `fallback` if it restarts. */
  ask(msg, mode, fallback, entry0 = null) {
    return new Promise((resolve) => {
      if (!this.worker) return resolve(fallback);
      this.retryStart();
      const id = this.nextId++;
      const entry = { reply: resolve, stopped: () => resolve(fallback) };
      this.pending.set(id, entry);
      if (entry0) this.modeClaims.set(id, { mode, e: entry0 });
      else if (msg.complete !== undefined || msg.check !== undefined) this.claim(id, mode);
      this.whenStarted(id, entry, () => this.worker.postMessage({ id, sage: mode === "sage", magma: mode === "magma", matlab: mode === "matlab", ...msg }));
    });
  }

  /** Rerun an @interact's function with new values (opts.clock: TimeTravel replay). */
  interact(iid, values, sink, opts = {}) {
    if (!this.worker) return sink.stopped?.("\nThe interpreter was stopped.\n");
    this.retryStart();
    const id = this.nextId++;
    this.pending.set(id, sink);
    // (a copy: the journal's document freezes what it is given, and the
    // notebook keeps changing its own values object)
    this.track(id, { kind: "interact", iid, values: JSON.parse(JSON.stringify(values)) });
    this.whenStarted(id, sink, () => this.worker.postMessage({ id, interact: iid, values, ...(opts.clock ? { clock: opts.clock } : {}) }));
  }

  /**
   * A board question's check, or a computed hint (src/notebook-session.ts
   * `evaluate`): `code` run seeing the board's names, with `answer` bound;
   * resolves to its verdict ({ok, value | error, timedOut?}).  Within `ms` of
   * its start (else interrupted: out of time), and all of it, its wait to be
   * taken up too, by `by` (an absolute Date.now deadline) if given, else
   * that wait within 30 s.  Not a run of the notebook's: not in the journal.
   */
  evaluate(code, answer, mode, ms, by) {
    return new Promise((resolve) => {
      if (!this.worker) return resolve({ ok: false, error: "the interpreter is not running" });
      this.retryStart();
      const id = this.nextId++;
      let timer = null, over = false, waiting = null;
      const finish = (r) => { clearTimeout(timer); clearTimeout(waiting); resolve(r); };
      const nothing = () => {};
      const entry = {
        // (its deadline from when it starts: not while the board's own code still runs before it)
        start: () => {
          clearTimeout(waiting);
          // (within `ms` of its start, and by `by` if given)
          const left = by === undefined ? ms : Math.min(ms, by - Date.now());
          if (ms > 0 && !timer) timer = setTimeout(() => { over = true; this.interrupt(); }, Math.max(0, left));
        },
        out: nothing, display: nothing, interact: nothing, clear: nothing,
        done: (_ms, x) => {
          if (over) return finish({ ok: false, error: `it ran out of time (${ms} ms)`, timedOut: true });
          try { finish(x?.evaluated ? JSON.parse(x.evaluated) : { ok: false, error: "it could not run" }); } catch { finish({ ok: false, error: "it could not run" }); }
        },
        stopped: () => finish(over ? { ok: false, error: `it ran out of time (${ms} ms)`, timedOut: true } : { ok: false, error: "the interpreter stopped" }),
      };
      this.pending.set(id, entry);
      this.whenStarted(id, entry, () => this.worker.postMessage({ id, code: "", evaluate: { code, answer }, sage: mode === "sage", magma: mode === "magma", matlab: mode === "matlab" }));
      // (an interpreter that never takes it up: given up after evaluateStartMs,
      // or at `by`, an absolute deadline (Date.now) for the whole of it, the
      // caller's remaining allowance, HARD-729-1)
      const pickup = by === undefined ? evaluateStartMs() : Math.max(0, by - Date.now());
      waiting = setTimeout(() => { this.pending.delete(id); finish({ ok: false, error: "the interpreter did not take it up" }); }, pickup);
    });
  }

  /** Send the worker anything else (files). */
  post(msg) { this.worker?.postMessage(msg); }

  // Interrupt what is running: KeyboardInterrupt in the worker (Python loops
  // and the Rust engines check a flag shared with this page), keeping every
  // variable; queued runs are skipped.  Where that is impossible (no
  // SharedArrayBuffer), or if the program does not stop within 2 s (a loop
  // that never checks), restart the interpreter.
  interrupt(message = STOPPED) {
    // (a question shown before the Stop is over, answered or not: what the
    // program asks after catching the KeyboardInterrupt is a new one)
    this.retireInputs();
    if ((!this.interruptFlag && !this.worker.interrupt) || this.pending.size === 0) return this.restart(message);
    const waiting = [...this.pending.keys()];
    for (const id of waiting) if (this.runs.has(id)) this.interrupted.add(id); // (the journal: not exactly replayable)
    if (this.interruptFlag) {
      Atomics.store(this.interruptFlag, 1, this.nextId - 1);
      // (bit 0 of a word of bits, src/runtime/interrupt.ts: or'd, so a frame
      // request, a soft stop or an armed allowance stays; the notify wakes a
      // time.sleep)
      Atomics.or(this.interruptFlag, 0, 1);
      Atomics.notify(this.interruptFlag, 0);
    } else this.worker.interrupt(this.nextId - 1);
    const gen = this.generation;
    setTimeout(() => {
      if (this.generation === gen && waiting.some((id) => this.pending.has(id))) this.restart(message);
    }, 2000);
  }

  // input() questions still shown, of run `id` or all, closed unanswered
  retireInputs(id) {
    for (const [reply, rid] of this.inputs) {
      if (id !== undefined && rid !== id) continue;
      this.inputs.delete(reply);
      reply.retire();
    }
  }

  /** A fresh interpreter; what was running or queued is told `message`. */
  restart(message = "\nInterpreter restarted.\n") {
    this.worker?.terminate();
    this.retireInputs();
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
    this.retireInputs();
    pkgPins.delete(this.uid);
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.runs.clear();
    this.interrupted.clear();
    for (const p of pending) (p.stopped ?? p.reply)?.(message);
  }
}
