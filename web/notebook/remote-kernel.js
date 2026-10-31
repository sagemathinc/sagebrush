// A notebook kernel on CoCalc's compute gateway (remote-client.js): the
// notebook's Kernel interface (web/notebook/types.ts), with the code running
// in a Python kernel of the person's own invisible CoCalc compute project
// (later, on a GPU pod).  Parsing and the reactive engine stay in the page.
//
// One request at a time: the page's own queue is the only queue (the
// gateway keeps none, and refuses a run while the kernel is busy), and each
// request ends in exactly one terminal: done(ms, {error}), stopped(message)
// or skipped().  Nothing is ever resubmitted automatically, except the one
// identical resend of a run whose answer was lost (the gateway admits a
// request at most once, by its id and digest).
//
// Lifecycle.  The kernel's state is one immutable record, `lc` (binding,
// epoch, generation, incarnation, phase), replaced as a whole on every
// change.  Every asynchronous step captures the record it started under and,
// after each await, does nothing unless it is still current: a late answer
// for an old binding, generation or epoch never changes, stops or replaces
// what came after it.  Lifecycle operations (bind, restart, takeover,
// replacement) run one at a time, and no run starts while one is pending.
// When the binding or generation changes, or the kernel closes or moves to
// another tab, the running request is told why and released at once, and
// everything it was waiting for is aborted, so a reply that never comes can't
// hold the queue.
//
//   const kernel = new RemoteKernel({ client, notebook: fid, path, kernel: "python3" });
//   kernel.on("status", (text) => ...);
//   await kernel.start();
//
// The wire shapes (the gateway implements the same):
//   POST /bindings {notebook, kernel, path, client} -> {binding, epoch, incarnation, state}
//   POST /bindings/{b}/runs {request, epoch, generation, incarnation, kind: "run", payload} -> {request, state}
//     refused: 409 busy | epoch | fencing | conflict; 410 quarantined; 429/503 with Retry-After
//   GET  /bindings/{b}/runs/{request}/events?after=<seq> -> a text/event-stream of
//     {seq, type: "start" | "stream" | "display" | "clear" | "terminal", ...}, seq = 1, 2, 3, ...
//   GET  /bindings/{b}/runs/{request} -> {request, state, outcome?}; a 404 is not proof that the
//     request was never admitted (nothing promises a late copy can't still be), so the page never reads it as such
//   POST /bindings/{b}/interrupt | /restart {epoch, op_id} -> {outcome: {status: "done", incarnation} | {status: "refused", reason}}
//   POST /bindings/{b}/complete {epoch, op_id, code, cursor_pos} -> {matches, prefix}
//   POST /bindings/{b}/takeover {client} -> {state: "fencing" | "quarantined"} or
//     {state: "ready", epoch, applied_before_takeover: [{op_id, kind}], in_flight: [{op_id, kind}], incarnation}
//     (when ready, both lists are required, every entry with string op_id and kind; incarnation is
//     required whenever a restart or delete was applied; anything less is not evidence of anything)
// A terminal's outcome is {status, reason?, detail?, ms?, ename?, incarnation?}.
//
// Approval (web/notebook/remote-gate.js):
// a run given `opts.gate` is checked when it is dispatched, and admitted by
// a guard the client calls synchronously right before the fetch that sends
// it (after the token and the proof are ready), so nothing can change
// between its last check and its send.  Until it is admitted, anything that
// ends it is "not run" (skipped with {notRun}), never a stopped run.  With
// `requireGate`, code is never sent without a gate, and an empty-code request
// (forgetting names) only with its `forgetGuard`.

import { GatewayError, StreamError, NotSentError, AmbiguousError } from "./remote-client.js";
import { newWaveState, waveDecide, waveRecord, waveRunResult, waveStop, sameDecision, waveEnvelopeInvalid } from "../../src/wave-policy.ts";

const ENVELOPE_MIME = "application/vnd.sagebrush.envelope.v1+json";
const clip = (s, n = 300) => String(s ?? "").slice(0, n);
const ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;
const isInt = (n) => Number.isInteger(n) && n >= 0;
// (an applied control op, or a run still executing: {op_id, kind}, both strings)
const isOpEntry = (a) => !!a && typeof a === "object" && !Array.isArray(a) && typeof a.op_id === "string" && typeof a.kind === "string";
// A takeover's answer, complete: a known state; when ready, its epoch and
// both lists, every entry well formed, and the new incarnation whenever a
// restart or delete is among the applied ops.  Missing evidence is never
// read as an empty list.
function validTakeover(r) {
  if (!r || !["ready", "fencing", "quarantined"].includes(r.state)) return false;
  if (r.state !== "ready") return true;
  if (!isInt(r.epoch)) return false;
  if (!Array.isArray(r.applied_before_takeover) || !r.applied_before_takeover.every(isOpEntry)) return false;
  if (!Array.isArray(r.in_flight) || !r.in_flight.every(isOpEntry)) return false;
  if (r.applied_before_takeover.some((a) => a.kind === "restart" || a.kind === "delete") && !isInt(r.incarnation)) return false;
  return true;
}

/** What the page says when a request ends without running, or is stopped (the plan's §9.4 notes). */
export const NOTES = {
  busy: "\nNot run: the kernel is busy with another tab's run.\n",
  moved: "\nNot run: this notebook's kernel moved to another tab.\n",
  inFlight: "\nNot run: a run from the previous tab is still executing; stop it or wait, then run again.\n",
  deadline: "\nNot run: access expired before it started.\n",
  sendRefused: "\nNot run: the kernel didn't accept it.\n",
  notHanded: "\nNot run: it couldn't be handed to the kernel. Run it again.\n",
  noProcess: "\nNot run: the kernel wasn't running.\n",
  beforeCode: "\nNot run: interrupted before your code ran.\n",
  stoppedRestart: "\nStopped: the kernel was restarted.\n",
  restartedBeforeRun: "\nNot run: the remote kernel restarted before your code ran; variables are gone. Run it again.\n",
  kernelReplaced: "\nStopped: this notebook's kernel was replaced; variables are gone.\n",
  unknown: "\nThe connection to the remote kernel was lost; whether this ran is unknown.\n",
  unreachable: "\nNot run: the remote kernel could not be reached.\n",
  restarted: "\nInterpreter restarted.\n",
  closed: "\nThe remote kernel was disconnected.\n",
  tooLarge: "(an output message was over the size limit, so it was not shown; the rest of this run's output is not shown either)\n",
  changed: "\nNot run: it changed since it was checked.\n",
  checkFailed: "\nNot run: it couldn't be checked.\n",
  noGate: "\nNot run: a remote run must be approved first.\n",
  notReady: "\nNot run: the remote kernel isn't ready.\n",
  stoppedBeforeStart: "\nStopped before it ran.\n",
};

// (a refusal's reason -> its note: the gateway's no-effect terminals, [G] §6.2.3)
const REFUSED = {
  deadline: NOTES.deadline,
  "send-refused": NOTES.sendRefused,
  "crash-before-handoff": NOTES.notHanded,
  "reset-before-handoff": NOTES.notHanded,
  "restart-before-handoff": NOTES.notHanded,
  cancelled: NOTES.notHanded,
  "stale-generation": NOTES.notHanded,
  "stale-incarnation": NOTES.notHanded,
  "no-prep": NOTES.notHanded,
  "no-process": NOTES.noProcess,
  "interrupted before your code ran": NOTES.beforeCode,
  busy: NOTES.busy,
};

/** The note for an outcome that is not a completed run: a string, or null for ok/error. */
export function outcomeNote(o) {
  switch (o?.status) {
    case "ok":
    case "error":
      return null;
    case "refused":
      return REFUSED[o.reason] ?? `\nNot run: the gateway refused it (${clip(o.reason, 80) || "no reason given"}).\n`;
    case "stopped":
      return /restart/.test(o.reason ?? "") ? NOTES.stoppedRestart : NOTES.beforeCode;
    case "setup-failed":
      return `\nNot run: the remote kernel's setup failed${o.detail || o.reason ? ` (${clip(o.detail || o.reason)})` : ""}.\n`;
    case "restarted-before-run":
      return NOTES.restartedBeforeRun;
    default:
      return NOTES.unknown;
  }
}

// A sink that takes exactly one terminal (done, stopped or skipped); output
// after it is ignored, so a late event can never write into a finished cell.
function once(sink) {
  let ended = false;
  const live = (f) => (...a) => { if (!ended) return f?.(...a); };
  const end = (f) => (...a) => { if (ended) return; ended = true; return f?.(...a); };
  return {
    get ended() { return ended; },
    start: live(sink.start?.bind(sink)),
    out: live(sink.out.bind(sink)),
    display: live(sink.display.bind(sink)),
    interact: live(sink.interact?.bind(sink)),
    clear: live(sink.clear.bind(sink)),
    done: end(sink.done.bind(sink)),
    stopped: end(sink.stopped.bind(sink)),
    skipped: end(sink.skipped ? sink.skipped.bind(sink) : () => sink.stopped("")),
  };
}

// The run payload of a checked spec (remote-approval.ts RunSpec): exactly its bytes.
export function payloadOf(spec) {
  const op = spec.options;
  return {
    code: spec.source,
    mode: spec.mode,
    cell: spec.id,
    ...(op.forget?.length ? { forget: [...op.forget] } : {}),
    ...(op.mangle ? { mangle: op.mangle } : {}),
    ...(op.seed ? { seed: op.seed } : {}),
    ...(op.scoped && Object.keys(op.scoped).length ? { scoped: { ...op.scoped } } : {}),
  };
}
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export class RemoteKernel {
  /**
   * @param {object} o
   * @param {import("./remote-client.js").RemoteClient} o.client
   * @param {string} o.notebook the notebook's stable file id
   * @param {string} [o.path] its path (for the binding's name only)
   * @param {string} [o.kernel] the kernel spec (default python3)
   * @param {string} [o.clientId] this page's id in request ids (default: random)
   * @param {(ms: number) => Promise<void>} [o.sleep] (tests: a faster clock)
   */
  constructor({ client, notebook, path = "", kernel = "python3", clientId, sleep, requireGate = false }) {
    this.client = client;
    this.notebook = notebook;
    this.path = path;
    this.kernelName = kernel;
    this.clientId = clientId ?? Math.random().toString(36).slice(2, 10);
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.requireGate = !!requireGate;
    // phase: "idle" (no binding), "ready", "moved" (another tab took it), "closed"
    this.lc = Object.freeze({ serial: 0, binding: null, epoch: null, generation: 0, incarnation: null, phase: "idle" });
    // aborted whenever the binding, generation or phase changes: everything begun under the old one
    this.abortCtl = new AbortController();
    this.lifeChain = Promise.resolve();
    this.lifeOps = 0;
    this.needsFence = false; // after an unknown outcome: take the binding over (fence) before more work
    this.queue = []; // {code, opts, sink, generation (null: asked before its binding existed)}
    this.current = null; // the job being run: {..., lc, request}
    this.nextN = 1;
    this.nextOp = 1;
    this.recoveredAt = null; // the incarnation an observed restart was last recovered from (one recovery each)
    this.listeners = { status: [], restart: [], ready: [], loading: [], lifecycle: [] };
    this.targetSink = () => null;
    // (what a run asked of this kernel while it is not ready is told: its own note when the page set one, e.g.
    // a preview whose connect failed; NOTES.notReady otherwise)
    this.notReadyNote = null;
  }

  get generation() { return this.lc.generation; }
  get binding() { return this.lc.binding; }
  get epoch() { return this.lc.epoch; }
  get incarnation() { return this.lc.incarnation; }
  get ready() { return this.lc.phase === "ready"; }
  get moved() { return this.lc.phase === "moved"; }
  get closed() { return this.lc.phase === "closed"; }
  /** A remote kernel: the notebook runs it only through a gate (remote-gate.js) and only in the reactive notebook. */
  get remote() { return true; }

  on(event, f) { (this.listeners[event] ??= []).push(f); return () => { this.listeners[event] = this.listeners[event].filter((g) => g !== f); }; }
  emit(event, ...args) { for (const f of this.listeners[event] ?? []) f(...args); }

  // A new lifecycle record.  If the binding, generation or phase changed:
  // everything begun under the old one is aborted, and the running request
  // is told `note` and released now (its late answers are stale).
  setLc(patch, note) {
    const old = this.lc;
    const lc = Object.freeze({ ...old, ...patch, serial: old.serial + 1 });
    this.lc = lc;
    // (synchronously, before anything else: approvals and records follow the kernel)
    this.emit("lifecycle", old, lc);
    if (lc.binding !== old.binding || lc.generation !== old.generation || lc.phase !== old.phase) {
      this.abortCtl.abort();
      this.abortCtl = new AbortController();
      const j = this.current;
      this.current = null;
      if (j) this.notSent(j, note ?? NOTES.restarted);
    }
    return lc;
  }

  // A job ended before it ran: a gated job not yet admitted is not run (no attempt
  // exists); anything else (ungated, or admitted) is stopped, as before.
  notSent(job, note) {
    if (job.opts.gate && !job.admitted) job.sink.skipped({ notRun: "skip", note });
    else job.sink.stopped(note);
  }

  // Lifecycle operations, one at a time; no run starts while one is pending.
  lifecycle(fn) {
    this.lifeOps++;
    const p = this.lifeChain.then(() => fn());
    this.lifeChain = p.catch(() => {});
    return p.finally(() => {
      this.lifeOps--;
      this.pump();
    });
  }

  opId() { return `op.${this.clientId}.${this.nextOp++}`; }

  /** Bind to a kernel in the compute project (a new binding): a new generation. */
  start() { return this.lifecycle(() => this.bind()); }

  async bind() {
    const lc0 = this.lc;
    if (lc0.phase === "closed" || lc0.phase === "moved") return false;
    this.emit("status", "connecting…");
    let r, err = null;
    try {
      r = await this.client.request("POST", "/bindings", { notebook: this.notebook, kernel: this.kernelName, path: this.path, client: this.clientId }, { signal: this.abortCtl.signal });
    } catch (e) {
      err = e;
    }
    if (this.lc !== lc0) return false; // (closed meanwhile: this answer is stale)
    if (!err && !(typeof r.binding === "string" && ID_RE.test(r.binding) && isInt(r.epoch) && (r.incarnation == null || isInt(r.incarnation)))) {
      err = new AmbiguousError("the gateway's answer to bind was not valid");
    }
    if (err) {
      this.emit("status", `error: the remote kernel did not start: ${clip(err?.message ?? err)}`);
      for (const j of this.queue.splice(0)) this.notSent(j, `\nThe remote kernel did not start: ${clip(err?.message ?? err)}\n`);
      return false;
    }
    this.needsFence = false;
    this.setLc({ binding: r.binding, epoch: r.epoch, incarnation: r.incarnation ?? null, generation: lc0.generation + 1, phase: "ready" }, NOTES.kernelReplaced);
    this.emit("status", "ready (remote)");
    this.emit("ready");
    return true;
  }

  /**
   * Run code; `sink` receives what happens to it (types.ts OutputSink).
   * opts: {mode, cell, forget, mangle, seed, scoped}, as for WorkerKernel;
   * `gate` (remote-gate.js) to check and admit it; `forgetGuard` for an
   * empty-code request, called right before it is sent.
   */
  execute(code, opts, sink) {
    const s = once(sink);
    const o = opts ?? {};
    // (a gated run may have any code, an empty cell's too; without a gate, only a forget's empty code with its guard)
    if (this.requireGate && !o.gate && !(code === "" && o.forgetGuard)) return s.stopped(NOTES.noGate);
    if (o.gate) {
      // (a gated run is checked against the kernel it is queued for: only a ready one)
      if (!this.ready) return s.skipped({ notRun: "skip", note: this.notReadyNote ?? NOTES.notReady });
    }
    if (this.closed) return s.stopped(NOTES.closed);
    if (this.moved) return s.stopped(NOTES.moved);
    // (no binding, and none being made: nothing would ever run it)
    if (this.lc.phase === "idle" && !this.lifeOps) return s.stopped(NOTES.unreachable);
    // (asked while no binding exists, being made: it runs on the kernel that comes next, so its
    // generation is the one current when it is sent, not the one before the binding)
    this.queue.push({ code, opts: o, sink: s, generation: this.lc.phase === "idle" ? null : this.lc.generation });
    this.pump();
  }

  /**
   * One wave (the waves design r3; web/notebook/remote-gate.js host.executeWave): the whole action in one request.
   * `w`: {entries: [{cell, auto, est, parents, desc, defs} and either {place, note?} (a placeholder: never sent) or
   * {code, opts, sink} (opts as for execute; the sink, the cell's)], policy, forget ({names} or null), mode}; `gate`:
   * the wave's ({check, sameRun, admitWave, stillAdmitted}).  Resolves to {refused} (checked, nothing sent), or to
   * {decisions, ran, submits, roundTrips, ms}: each entry's decision as the gateway made it and this page replayed
   * it (src/wave-policy.ts; a difference is a protocol error: the entries not yet ended are unknown, and the
   * binding fenced).  Each sendable entry's sink gets its run's events and terminal; one that doesn't run is
   * skipped, silently (the scheduler shows why).
   */
  executeWave(w, gate) {
    return new Promise((resolve) => {
      const entries = w.entries.map((e) => (e.place ? { ...e } : { ...e, sink: once(e.sink) }));
      const sendable = entries.filter((e) => !e.place);
      let settled = false;
      const result = { decisions: entries.map(() => undefined), ran: 0, submits: 0, roundTrips: 0, ms: 0 };
      const t0 = Date.now();
      const finish = (extra = {}) => {
        if (settled) return;
        settled = true;
        result.ms = Date.now() - t0;
        resolve({ ...result, ...extra });
      };
      // (the job's own sink: what is told to the whole wave goes to every entry not yet ended)
      const fan = {
        get ended() { return settled; },
        start() {},
        out() {},
        display() {},
        interact() {},
        clear() {},
        done() { finish(); },
        stopped(note) {
          entries.forEach((e, k) => {
            if (e.place || e.sink.ended) return;
            result.decisions[k] ??= { kind: "run" };
            e.sink.stopped(note);
          });
          finish();
        },
        skipped(info) {
          for (const e of sendable) e.sink.skipped(info);
          finish(info?.note ? { refused: info.note } : { refused: "\nNot run.\n" });
        },
      };
      if (!gate) return fan.stopped(NOTES.noGate);
      if (!this.ready) return fan.skipped({ notRun: "skip", note: this.notReadyNote ?? NOTES.notReady });
      if (this.closed) return fan.stopped(NOTES.closed);
      if (this.moved) return fan.stopped(NOTES.moved);
      this.queue.push({ wave: { ...w, entries }, result, started: t0, code: null, opts: { gate }, sink: fan, generation: this.lc.generation });
      this.pump();
    });
  }

  // the next queued run, once the one before it has its terminal, and no lifecycle operation is pending
  pump() {
    if (this.current || this.lifeOps || this.lc.phase !== "ready" || !this.queue.length) return;
    const job = this.queue.shift();
    this.current = job;
    // (job.settled: the whole run, its finally included, settled; tests use it)
    job.settled = this.runJob(job)
      .catch((e) => { if (this.current === job) this.notSent(job, `\nThe remote kernel failed: ${clip(e?.message ?? e)}\n`); })
      .finally(() => {
        if (this.current === job) this.current = null;
        this.pump();
      });
  }

  async runJob(job) {
    // (queued before a restart: its kernel is gone)
    if (job.generation !== null && job.generation !== this.lc.generation) return this.notSent(job, NOTES.restarted);
    if (job.generation === null) job.generation = this.lc.generation;
    if (this.needsFence) {
      const ok = await this.lifecycle(() => this.takeover(job));
      if (!ok || this.current !== job) return;
    }
    if (job.generation !== this.lc.generation) return this.notSent(job, NOTES.kernelReplaced);
    const lc = (job.lc = this.lc);
    const signal = this.abortCtl.signal;
    const request = (job.request = `rq.${this.clientId}.${lc.generation}.${this.nextN++}`);
    if (job.wave) return this.runWave(job, lc, signal, request);
    const o = job.opts;
    let payload, guard;
    if (o.gate) {
      // the check, on one snapshot (approvals, document, kernel, the cell and its ancestors)
      let v;
      try {
        v = await o.gate.check(request);
      } catch {
        return this.current === job ? this.notSent(job, NOTES.checkFailed) : undefined;
      }
      if (this.current !== job) return; // (already told why)
      if (this.lc !== lc) return this.notSent(job, NOTES.changed);
      if (!v.send) return job.sink.skipped({ notRun: "wait" in v ? "wait" : "skip", note: `\nNot run: ${"wait" in v ? v.wait : v.skip}.\n` });
      const planned = v.plan[0];
      // the bytes sent are the bytes checked: the payload is the checked spec's, and the job's own must agree
      if (!o.gate.sameRun(job.code, o, planned.run)) return this.notSent(job, NOTES.changed);
      payload = payloadOf(planned.run);
      // admitted at the first fetch, synchronously before it; a nonce retry or the identical
      // resend only if that admission still holds (never admitted again)
      guard = () => {
        if (job.admitted) return o.gate.stillAdmitted(v);
        if (!o.gate.admit(v)) return false;
        job.admitted = true;
        job.planned = planned;
        o.gate.admitted?.(planned);
        return true;
      };
    } else {
      payload = {
        code: job.code,
        mode: o.mode ?? "python",
        ...(o.cell ? { cell: String(o.cell) } : {}),
        ...(o.forget?.length ? { forget: [...o.forget] } : {}),
        ...(o.mangle && o.cell ? { mangle: String(o.cell).replace(/[^A-Za-z0-9]/g, "") } : {}),
        ...(o.seed ? { seed: o.seed } : {}),
        ...(o.scoped && Object.keys(o.scoped).length ? { scoped: { ...o.scoped } } : {}),
      };
      // (forgetting names: whatever was computed with them is invalidated right before they go)
      if (o.forgetGuard) guard = () => { o.forgetGuard(); return true; };
    }
    const body = deepFreeze({ request, epoch: lc.epoch, generation: lc.generation, incarnation: lc.incarnation, kind: "run", payload });
    if (!(await this.submit(job, body, signal, guard))) return;
    if (this.current !== job) return;
    await this.follow(job, signal);
  }

  // A wave's check, its one submit and its stream.  The check is the batch's (every sendable entry, in order, on one
  // snapshot); the bytes sent are the bytes checked, entry by entry; admission is the gate's one transition
  // (admitWave), at the first fetch, and a retry of that same send only while stillAdmitted holds.
  async runWave(job, lc, signal, request) {
    const w = job.wave, g = job.opts.gate;
    let v;
    try {
      v = await g.check(request);
    } catch {
      return this.current === job ? this.notSent(job, NOTES.checkFailed) : undefined;
    }
    if (this.current !== job) return;
    if (this.lc !== lc) return this.notSent(job, NOTES.changed);
    if (!v.send) return job.sink.skipped({ notRun: "wait" in v ? "wait" : "skip", note: `\nNot run: ${"wait" in v ? v.wait : v.skip}.\n` });
    const sendable = w.entries.filter((e) => !e.place);
    if (v.plan.length !== sendable.length || sendable.some((e, i) => !g.sameRun(e.code, e.opts ?? {}, v.plan[i].run))) return this.notSent(job, NOTES.changed);
    let i = 0;
    const entries = w.entries.map((e) => {
      const policy = { cell: e.cell, auto: e.auto, est: e.est, parents: e.parents, desc: e.desc, defs: e.defs ?? [] };
      return e.place ? { ...policy, place: e.place, ...(e.note ? { note: e.note } : {}) } : { ...policy, ...payloadOf(v.plan[i++].run) };
    });
    const body = deepFreeze({
      request, epoch: lc.epoch, generation: lc.generation, incarnation: lc.incarnation, kind: "wave",
      payload: { mode: w.mode, forget: [...(w.forget?.names ?? [])], policy: { budget: w.policy.budget, all: w.policy.all }, entries }, // (as the scheduler gave them: validated below, never coerced)
    });
    // (the whole envelope, as the gateway validates it, before anything is admitted)
    const bad = waveEnvelopeInvalid(body.payload);
    if (bad !== null) return this.notSent(job, `\nNot run: the wave was malformed (${bad}).\n`);
    await g.sending?.(body.payload); // (the audit: the bytes about to be sent)
    if (this.current !== job) return;
    if (this.lc !== lc) return this.notSent(job, NOTES.changed);
    job.st = newWaveState();
    job.next = 0;
    const guard = () => {
      job.result.submits++;
      job.result.roundTrips++;
      if (job.admitted) {
        const ok = g.stillAdmitted(v);
        g.attempt?.("resend", ok);
        return ok;
      }
      if (!g.admitWave(v)) {
        g.attempt?.("send", false);
        return false;
      }
      g.attempt?.("send", true);
      job.admitted = true;
      g.admitted?.(v);
      return true;
    };
    if (!(await this.submit(job, body, signal, guard))) return;
    if (this.current !== job) return;
    await this.follow(job, signal);
  }

  // One entry's end, in order: replayed (the same decision, from the same state), recorded, and told to its cell.
  // false: a protocol error (out of order, or another decision than the replay's).
  waveEnd(job, k, end) {
    const w = job.wave;
    if (k !== job.next || !end || typeof end.decision !== "object") return false;
    const e = w.entries[k];
    const mine = waveDecide(w.policy, job.st, k, e);
    if (!sameDecision(mine, end.decision)) return false;
    job.next++;
    job.result.decisions[k] = end.decision;
    if (mine.kind !== "run") {
      waveRecord(job.st, k, e, mine);
      e.sink?.skipped({ notRun: "skip" });
      return true;
    }
    const o = end.outcome && typeof end.outcome === "object" && !Array.isArray(end.outcome) ? end.outcome : { status: "unknown" };
    waveRecord(job.st, k, e, mine, waveRunResult(o));
    job.result.ran++;
    const ms = Number.isFinite(o.ms) ? o.ms : 0;
    if (o.status === "ok") e.sink.done(ms, { error: false });
    else if (o.status === "error") {
      if (o.ename === "KeyboardInterrupt" && !e.sawErrorText) e.sink.out("KeyboardInterrupt\n", true);
      e.sink.done(ms, { error: true, ...(o.ename === "KeyboardInterrupt" ? { interrupted: true } : {}) });
    } else {
      e.sink.stopped(outcomeNote(o));
      if (!["refused", "stopped", "setup-failed", "restarted-before-run"].includes(o.status)) this.needsFence = true;
    }
    return true;
  }

  // The wave's terminal: done (every entry ended before it), or the run's outcome for whatever hadn't ended.
  waveTerminal(job, outcome) {
    const o = outcome && typeof outcome === "object" && !Array.isArray(outcome) ? outcome : { status: "unknown" };
    if (o.status === "done" && job.next === job.wave.entries.length) {
      this.emit("status", `ready (remote) · ${job.result.ran} cell${job.result.ran === 1 ? "" : "s"}, ${job.result.submits} submit${job.result.submits === 1 ? "" : "s"}, ${job.result.roundTrips} round trips, ${((Date.now() - job.started) / 1000).toFixed(1)} s`);
      return job.sink.done();
    }
    if (o.status === "done") return this.waveBroken(job);
    job.sink.stopped(outcomeNote(o));
    if (!["refused", "stopped", "setup-failed", "restarted-before-run"].includes(o.status)) this.needsFence = true;
    if (o.status === "restarted-before-run") this.recover(job.lc, isInt(o.incarnation) ? o.incarnation : null);
  }

  // A wave that answered something this page doesn't agree with: what hadn't ended is unknown, and the binding fenced.
  waveBroken(job) {
    this.needsFence = true;
    job.sink.stopped(NOTES.unknown);
  }

  // POST the run; true once the gateway has it.  On the first attempt: not
  // sent is not run, and a typed refusal is not run (or moved, fenced,
  // replaced).  Sent without a valid answer (lost, unreadable, oversized):
  // the run may have been admitted, and that stays so (latched) whatever a
  // later attempt hears: it is resent once, identically (the gateway admits
  // a request at most once), and if that doesn't succeed, only the
  // request's own record decides; without it, the outcome is unknown and
  // the binding is fenced.
  // (`guard`: the client calls it right before each fetch; both attempts share it)
  async submit(job, body, signal, guard) {
    const path = `/bindings/${job.lc.binding}/runs`;
    let mayBeAdmitted = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let err = null;
      try {
        await this.client.request("POST", path, body, { signal, ...(guard ? { guard } : {}) });
      } catch (e) {
        err = e;
      }
      if (this.current !== job) return false; // (stale: the job was already told why)
      if (!err) return true;
      // (a retry's refusal, or a failure to send it, says nothing about the first attempt)
      if (mayBeAdmitted) return this.reconcileSubmit(job, err, signal);
      if (err instanceof NotSentError) {
        // (not admitted: not run; admitted, then refused before a retry was sent: stopped)
        if (job.opts.gate && !job.admitted) job.sink.skipped({ notRun: "skip", note: err.stale ? NOTES.changed : `\nNot run: ${clip(err.message)}\n` });
        else job.sink.stopped(err.stale ? NOTES.changed : `\nNot run: ${clip(err.message)}\n`);
        return false;
      }
      if (err instanceof GatewayError) {
        await this.notAdmitted(job, err);
        return false;
      }
      mayBeAdmitted = true;
    }
    return false;
  }

  // A typed refusal of a request that was never admitted: its note, and what it means for the kernel.
  async notAdmitted(job, err) {
    if (err.code === "busy") job.sink.stopped(NOTES.busy);
    else if (err.code === "epoch") {
      // (only an answer for the current record means another tab has it)
      if (this.lc === job.lc) this.movedAway();
      else job.sink.stopped(NOTES.notHanded);
    } else if (err.code === "fencing") {
      this.needsFence = true;
      job.sink.stopped(NOTES.notHanded);
    } else if (err.code === "quarantined") {
      job.sink.stopped(NOTES.kernelReplaced);
      const lc = job.lc;
      await this.lifecycle(() => this.replace(lc));
    } else if (err.code === "conflict") {
      this.needsFence = true;
      job.sink.stopped(NOTES.unknown);
    } else job.sink.stopped(`\nNot run: ${clip(err.message)}\n`);
  }

  // After an attempt that may have been admitted, the request's own record:
  // found, it was admitted (follow it).  Anything else, a "not-found"
  // included, proves nothing (the gateway doesn't promise that a request id
  // it hasn't seen yet can never be admitted later), so the outcome is
  // unknown, and fenced (and if the retry said another tab has the binding,
  // this one stops taking work).
  async reconcileSubmit(job, retryErr, signal) {
    const path = `/bindings/${job.lc.binding}/runs/${encodeURIComponent(job.request)}`;
    let r = null, err = null;
    try {
      r = await this.client.request("GET", path, undefined, { signal });
    } catch (e) {
      err = e;
    }
    if (this.current !== job) return false;
    if (!err && r.request === job.request) return true;
    this.needsFence = true;
    if (retryErr instanceof GatewayError && retryErr.code === "epoch" && this.lc === job.lc) this.movedAway(NOTES.unknown);
    else job.sink.stopped(NOTES.unknown);
    return false;
  }

  // The run's events until its terminal, each exactly once and in order
  // (seq 1, 2, 3, ...; a replayed one is skipped, a gap reconnects from the
  // last one seen); after a break, reconnecting; if it can't, the run's
  // recorded outcome; if that is unreachable too, unknown (and fenced).
  async follow(job, signal) {
    const sink = job.sink;
    const path = `/bindings/${job.lc.binding}/runs/${encodeURIComponent(job.request)}`;
    let after = 0, failures = 0, started = false;
    while (this.current === job && !sink.ended) {
      try {
        if (job.wave) job.result.roundTrips++;
        for await (const ev of this.client.events(path, after, signal)) {
          if (this.current !== job || sink.ended) return;
          if (!Number.isInteger(ev.seq) || ev.seq <= after) continue; // (a replay or a duplicate)
          if (ev.seq !== after + 1) break; // (a gap: reconnect from the last one seen)
          after = ev.seq;
          failures = 0;
          if (job.wave) {
            // (a wave's events: each entry's to its cell, in order; its end replayed; the wave's terminal last)
            if (ev.type === "terminal") return this.waveTerminal(job, ev.outcome);
            // (a Stop the gateway latched with no entry running: the entries after it are not run, as the policy says)
            if (ev.type === "stop") {
              if (!Number.isInteger(ev.before) || ev.before !== job.next) return this.waveBroken(job);
              waveStop(job.st);
              continue;
            }
            const e = Number.isInteger(ev.entry) ? job.wave.entries[ev.entry] : undefined;
            // (a placeholder has only its end; any other entry's events are the next one's)
            if (!e || (ev.type !== "end" && (e.place || ev.entry !== job.next))) return this.waveBroken(job);
            if (ev.type === "end") {
              if (!this.waveEnd(job, ev.entry, ev)) return this.waveBroken(job);
            } else if (ev.type === "start") {
              if (!e.started) { e.started = true; e.sink.start(); }
            } else if (ev.type === "stream") {
              if (ev.name === "stderr") e.sawErrorText = true;
              e.sink.out(String(ev.text ?? ""), ev.name === "stderr");
            } else if (ev.type === "display") {
              if (ev.data && typeof ev.data === "object" && !Array.isArray(ev.data) && !(ENVELOPE_MIME in ev.data)) e.sink.display(ev.data);
            } else if (ev.type === "clear") e.sink.clear();
            continue;
          }
          if (ev.type === "start") { if (!started) { started = true; sink.start(); } }
          else if (ev.type === "stream") {
            if (ev.name === "stderr") job.sawErrorText = true;
            sink.out(String(ev.text ?? ""), ev.name === "stderr");
          }
          else if (ev.type === "display") {
            // (a hidden run's envelope is the gateway's, never output: refused if it appears)
            if (ev.data && typeof ev.data === "object" && !Array.isArray(ev.data) && !(ENVELOPE_MIME in ev.data)) sink.display(ev.data);
          } else if (ev.type === "clear") sink.clear();
          else if (ev.type === "terminal") return this.finish(job, ev.outcome);
        }
        failures++;
      } catch (e) {
        if (this.current !== job || sink.ended) return;
        if (e instanceof StreamError && e.tooLarge) {
          sink.out(NOTES.tooLarge, true);
          return this.awaitOutcome(job, signal);
        }
        if (e instanceof GatewayError && (e.status === 404 || e.status === 410)) return this.awaitOutcome(job, signal);
        failures++;
      }
      if (failures > 5) return this.awaitOutcome(job, signal);
      await this.sleep(Math.min(8000, 500 * 2 ** (failures - 1)));
    }
  }

  // The run's outcome without its events: asked until it is terminal (the
  // run may still be going), giving up as unknown after repeated failures.
  async awaitOutcome(job, signal) {
    const path = `/bindings/${job.lc.binding}/runs/${encodeURIComponent(job.request)}`;
    let failures = 0, wait = 500;
    while (this.current === job && !job.sink.ended) {
      let r = null;
      try {
        if (job.wave) job.result.roundTrips++;
        r = await this.client.request("GET", path, undefined, { signal });
        failures = 0;
      } catch {
        failures++;
      }
      if (this.current !== job || job.sink.ended) return;
      if (job.wave && r?.outcome && typeof r.outcome === "object") {
        // (the entries' ends the stream didn't bring, from the record, without their output; then the terminal)
        const ends = Array.isArray(r.entries) ? r.entries : [];
        // (a Stop latched before an entry: replayed there, as the stream's stop event)
        const stopAt = (k) => { if (r.stop === k && !job.st.stopped) waveStop(job.st); };
        stopAt(job.next);
        while (job.next < job.wave.entries.length && ends[job.next]) {
          if (!this.waveEnd(job, job.next, ends[job.next])) return this.waveBroken(job);
          stopAt(job.next);
        }
        return this.waveTerminal(job, r.outcome);
      }
      if (r?.outcome && typeof r.outcome === "object") return this.finish(job, r.outcome);
      if (failures > 5) break;
      await this.sleep(wait);
      wait = Math.min(5000, wait * 2);
    }
    if (this.current !== job || job.sink.ended) return;
    this.needsFence = true;
    job.sink.stopped(NOTES.unknown);
  }

  // A terminal, to the cell: only a user-phase ok is a success (done without error).
  finish(job, outcome) {
    if (this.current !== job || job.sink.ended) return;
    const o = outcome && typeof outcome === "object" && !Array.isArray(outcome) ? outcome : { status: "unknown" };
    const ms = Number.isFinite(o.ms) ? o.ms : 0;
    if (o.status === "ok") return job.sink.done(ms, { error: false });
    if (o.status === "error") {
      // (an interrupted run whose stream carried no error text says so, as an interpreter's traceback would)
      if (o.ename === "KeyboardInterrupt" && !job.sawErrorText) job.sink.out("KeyboardInterrupt\n", true);
      return job.sink.done(ms, { error: true, ...(o.ename === "KeyboardInterrupt" ? { interrupted: true } : {}) });
    }
    job.sink.stopped(outcomeNote(o));
    if (!["refused", "stopped", "setup-failed", "restarted-before-run"].includes(o.status)) this.needsFence = true;
    if (o.status === "restarted-before-run") this.recover(job.lc, isInt(o.incarnation) ? o.incarnation : null);
  }

  // An observed restart (the helper was missing, or another incarnation
  // answered): one recovery, a restart that bootstraps the helper; a second
  // in a row is left to the person (the status says so).
  recover(lc, incarnation) {
    const key = `${lc.binding}:${incarnation ?? lc.incarnation}`;
    if (this.recoveredAt === key) {
      this.emit("status", "error: the remote kernel keeps restarting; restart it, or reconnect");
      return;
    }
    this.recoveredAt = key;
    // (exactly the record the failed run saw: if anything changed before it runs, it is not needed)
    this.lifecycle(() => (this.lc === lc ? this.restartOp(NOTES.restartedBeforeRun, lc) : undefined));
  }

  /** Interrupt what is running (the gateway signals the kernel); queued runs, never sent, are stopped before they ran. */
  interrupt() {
    for (const j of this.queue.splice(0)) j.sink.stopped(NOTES.stoppedBeforeStart);
    const job = this.current, lc = this.lc;
    if (!job?.lc || lc.phase !== "ready") return;
    this.client.request("POST", `/bindings/${lc.binding}/interrupt`, { epoch: lc.epoch, op_id: this.opId() }, { signal: this.abortCtl.signal })
      .catch((e) => { if (this.lc === lc) this.emit("status", `error: Stop failed: ${clip(e?.message ?? e)}`); });
  }

  /**
   * A fresh kernel (the gateway restarts it and bootstraps its helper).
   * Once the gateway reports the restart done: a new generation, queued runs
   * are told `message`, and the running one is told the kernel was
   * restarted.  A refusal changes nothing but the status; an invalid or lost
   * answer is checked with the gateway (a takeover lists what was applied)
   * before anything else runs.
   */
  restart(message = NOTES.restarted) {
    const lc = this.lc;
    return this.lifecycle(() => this.restartOp(message, lc));
  }

  async restartOp(message, lcAsked) {
    const lc0 = this.lc;
    // (asked of a kernel that has changed since: already restarted, replaced or closed)
    if (lc0.phase !== "ready" || lc0.binding !== lcAsked.binding || lc0.generation !== lcAsked.generation) return;
    this.emit("status", "restarting…");
    const opId = this.opId();
    let r, err = null;
    try {
      r = await this.client.request("POST", `/bindings/${lc0.binding}/restart`, { epoch: lc0.epoch, op_id: opId }, { signal: this.abortCtl.signal });
    } catch (e) {
      err = e;
    }
    if (this.lc !== lc0) return; // (stale: closed, moved or replaced meanwhile)
    if (!err) {
      const o = r.outcome;
      if (o && o.status === "done" && isInt(o.incarnation)) return this.restarted(message, o.incarnation);
      if (o && o.status === "refused" && typeof o.reason === "string") {
        this.emit("status", `error: the restart failed: ${outcomeNote(o).trim()}`);
        return;
      }
      err = new AmbiguousError("the gateway's answer to restart was not valid");
    }
    if (err instanceof NotSentError || err instanceof GatewayError) {
      this.emit("status", `error: the restart failed: ${clip(err.message)}`);
      return;
    }
    // (sent, without a valid answer: whether it restarted is found out first)
    this.emit("status", "the restart's answer was lost; checking with the gateway…");
    this.needsFence = true;
    await this.takeover(null, { opId, message });
  }

  // The gateway reported the restart done.
  restarted(message, incarnation) {
    for (const j of this.queue.splice(0)) this.notSent(j, message);
    this.setLc({ generation: this.lc.generation + 1, incarnation }, NOTES.stoppedRestart);
    this.emit("status", "ready (remote)");
    this.emit("restart");
  }

  // (a control op's request: the current epoch, its own op id)
  control(kind, lc, opId) {
    return this.client.request("POST", `/bindings/${lc.binding}/${kind}`, { epoch: lc.epoch, op_id: opId }, { signal: this.abortCtl.signal });
  }

  /** Questions: {complete: text} -> {matches, prefix}; anything else, a failure, or a kernel that changed meanwhile: `fallback`. */
  async ask(msg, mode, fallback) {
    const lc0 = this.lc;
    if (msg?.complete === undefined || lc0.phase !== "ready") return fallback;
    try {
      const code = String(msg.complete);
      const r = await this.client.request("POST", `/bindings/${lc0.binding}/complete`, { epoch: lc0.epoch, op_id: this.opId(), code, cursor_pos: code.length }, { signal: this.abortCtl.signal });
      if (this.lc !== lc0) return fallback;
      return { matches: Array.isArray(r.matches) ? r.matches.slice(0, 500).map(String) : [], prefix: String(r.prefix ?? "") };
    } catch {
      return fallback;
    }
  }

  /** @interact needs the in-page engine: not on a remote kernel. */
  interact(_id, _values, sink) {
    once(sink).stopped("\n@interact is not available on a remote kernel.\n");
  }

  /**
   * Take the binding over (fence), as a lifecycle operation: after an
   * unknown outcome, a lost restart answer, or in a new tab.  true once the
   * gateway's fence is acknowledged, nothing applied meanwhile changed the
   * kernel, and nothing from before is still executing.  `job`: the run
   * waiting for it (told why if it can't go ahead); `lost`: a restart whose
   * answer was lost, looked for among the applied control ops.
   */
  async takeover(job, lost = null) {
    if (job && this.current !== job) return false;
    const deadline = Date.now() + 100_000; // (the gateway's own fence wait)
    let wait = 500;
    for (;;) {
      const lc0 = this.lc;
      if (lc0.phase !== "ready") return false;
      let r, err = null;
      try {
        r = await this.client.request("POST", `/bindings/${lc0.binding}/takeover`, { client: this.clientId }, { signal: this.abortCtl.signal });
      } catch (e) {
        err = e;
      }
      if (this.lc !== lc0 || (job && this.current !== job)) return false;
      if (err instanceof GatewayError && err.code === "quarantined") return this.replace(lc0);
      if (!err && !validTakeover(r)) err = new AmbiguousError("the gateway's answer to takeover was incomplete or not valid");
      if (err) {
        // (no complete evidence: nothing is concluded, and the fence stays)
        this.emit("status", `error: the remote kernel could not be checked: ${clip(err?.message ?? err)}`);
        this.needsFence = true;
        if (job) this.notSent(job, NOTES.unreachable);
        return false;
      }
      if (r.state === "quarantined") return this.replace(lc0);
      if (r.state === "ready") {
        this.needsFence = false;
        this.setLc({ epoch: r.epoch });
        const applied = r.applied_before_takeover;
        if (lost && applied.some((a) => a.op_id === lost.opId && a.kind === "restart")) {
          this.restarted(lost.message, r.incarnation);
          return false;
        }
        if (applied.some((a) => a.kind === "restart" || a.kind === "delete")) {
          for (const j of this.queue.splice(0)) this.notSent(j, NOTES.kernelReplaced);
          this.setLc({ generation: this.lc.generation + 1, incarnation: r.incarnation }, NOTES.kernelReplaced);
          this.emit("status", "the remote kernel was restarted before this tab took it over; variables are gone");
          this.emit("restart");
          return false;
        }
        if (r.in_flight.length) {
          this.emit("status", "a run from the previous tab is still executing");
          this.needsFence = true; // (asked again before the next run)
          if (job) this.notSent(job, NOTES.inFlight);
          return false;
        }
        if (lost) this.emit("status", "ready (remote); the restart did not happen");
        return true;
      }
      // fencing: the gateway refuses new work until its fence is acknowledged
      if (Date.now() + wait > deadline) return this.replace(lc0);
      await this.sleep(wait);
      if (this.lc !== lc0 || (job && this.current !== job)) return false;
      wait = Math.min(5000, wait * 2);
    }
  }

  // The binding could not be handed over safely: a new one (a fresh kernel,
  // a new generation), if `lc0`'s binding is still the current one.  Run
  // inside a lifecycle operation.  Always false: nothing from before goes ahead.
  async replace(lc0) {
    // (exactly the record it was asked for: queued behind a restart, it must
    // never replace the kernel that restart made, even on the same binding)
    if (this.lc !== lc0 || this.lc.phase !== "ready") return false;
    this.emit("status", "This notebook's kernel couldn't be handed over safely; starting a fresh kernel");
    for (const j of this.queue.splice(0)) this.notSent(j, NOTES.kernelReplaced);
    this.setLc({ binding: null, phase: "idle" }, NOTES.kernelReplaced);
    if (await this.bind()) this.emit("restart");
    return false;
  }

  // Another tab owns the binding now: this one stops, its queue skipped.
  // (`note`: what the running request is told; NOTES.moved unless its own outcome is unknown)
  movedAway(note = NOTES.moved) {
    for (const j of this.queue.splice(0)) this.notSent(j, NOTES.moved);
    this.setLc({ phase: "moved" }, note);
    this.emit("status", "this notebook's kernel is in use in another tab");
  }

  /** Disconnect: what was running or queued is told `message` (the kernel itself is the gateway's). */
  close(message = NOTES.closed) {
    if (this.closed) return;
    for (const j of this.queue.splice(0)) this.notSent(j, message);
    this.setLc({ phase: "closed" }, message);
  }
}
