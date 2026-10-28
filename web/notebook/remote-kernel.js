// A notebook kernel on CoCalc's compute gateway (remote-client.js): the
// notebook's Kernel interface (web/notebook/types.ts), with the code running
// in a Python kernel of the person's own invisible CoCalc compute project
// (later, on a GPU pod).  Parsing and the reactive engine stay in the page.
//
// One request at a time: the page's own queue is the only queue (the
// gateway keeps none, and refuses a run while the kernel is busy), and each
// request ends in exactly one terminal: done(ms, {error}), stopped(message)
// or skipped().  Nothing is ever resubmitted automatically, except the one
// identical resend of a run whose acknowledgement was lost (the gateway
// admits a request at most once, by its id and digest).
//
//   const kernel = new RemoteKernel({ client, notebook: fid, path, kernel: "python3" });
//   kernel.on("status", (text) => ...);
//   await kernel.start();
//
// The wire shapes (the gateway implements the same):
//   POST /bindings {notebook, kernel, path, client} -> {binding, epoch, incarnation, state}
//   POST /bindings/{b}/runs {request, epoch, generation, incarnation, kind: "run", payload} -> {request, state}
//     refused: 409 busy | epoch | fencing; 410 quarantined; 429/503 with Retry-After
//   GET  /bindings/{b}/runs/{request}/events?after=<seq> -> a text/event-stream of
//     {seq, type: "start" | "stream" | "display" | "clear" | "terminal", ...}
//   GET  /bindings/{b}/runs/{request} -> {request, state, outcome?}
//   POST /bindings/{b}/interrupt | /restart {epoch, op_id}; /complete {epoch, op_id, code, cursor_pos}
//   POST /bindings/{b}/takeover {client} -> {epoch, state, applied_before_takeover, in_flight}
// A terminal's outcome is {status, reason?, detail?, ms?, ename?, incarnation?}.

import { GatewayError, StreamError } from "./remote-client.js";

const ENVELOPE_MIME = "application/vnd.sagebrush.envelope.v1+json";
const clip = (s, n = 300) => String(s ?? "").slice(0, n);

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
  kernelReplaced: "\nNot run: this notebook's kernel was replaced; variables are gone.\n",
  unknown: "\nThe connection to the remote kernel was lost; whether this ran is unknown.\n",
  unreachable: "\nNot run: the remote kernel could not be reached.\n",
  restarted: "\nInterpreter restarted.\n",
  closed: "\nThe remote kernel was disconnected.\n",
  tooLarge: "(an output message was over the size limit, so it was not shown; the rest of this run's output is not shown either)\n",
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
  constructor({ client, notebook, path = "", kernel = "python3", clientId, sleep }) {
    this.client = client;
    this.notebook = notebook;
    this.path = path;
    this.kernelName = kernel;
    this.clientId = clientId ?? Math.random().toString(36).slice(2, 10);
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.generation = 0; // a new kernel (bind, restart, replacement): what an older one made is stale
    this.binding = null;
    this.epoch = null;
    this.incarnation = null;
    this.ready = false;
    this.closed = false;
    this.needsFence = false; // after an unknown outcome: take the binding over (fence) before more work
    this.moved = false; // another tab took it over
    this.queue = []; // {code, opts, sink, generation}
    this.current = null; // the job being run: {..., request, ctx, abort}
    this.nextN = 1;
    this.nextOp = 1;
    this.recoveredAt = null; // the incarnation an observed restart was last recovered from (one recovery each)
    this.listeners = { status: [], restart: [], ready: [], loading: [] };
    this.targetSink = () => null;
  }

  on(event, f) { (this.listeners[event] ??= []).push(f); return () => { this.listeners[event] = this.listeners[event].filter((g) => g !== f); }; }
  emit(event, ...args) { for (const f of this.listeners[event] ?? []) f(...args); }

  /** Bind to a kernel in the compute project (a new binding): a new generation. */
  async start() {
    this.ready = false;
    this.emit("status", "connecting…");
    try {
      const r = await this.client.request("POST", "/bindings", { notebook: this.notebook, kernel: this.kernelName, path: this.path, client: this.clientId });
      this.binding = r.binding;
      this.epoch = r.epoch;
      this.incarnation = r.incarnation ?? null;
      this.generation++;
      this.needsFence = false;
      this.moved = false;
      this.ready = true;
      this.emit("status", "ready (remote)");
      this.emit("ready");
      this.pump();
      return true;
    } catch (e) {
      this.emit("status", `error: the remote kernel did not start: ${clip(e?.message ?? e)}`);
      for (const j of this.queue.splice(0)) j.sink.stopped(`\nThe remote kernel did not start: ${clip(e?.message ?? e)}\n`);
      return false;
    }
  }

  /**
   * Run code; `sink` receives what happens to it (types.ts OutputSink).
   * opts: {mode, cell, forget, mangle, seed, scoped}, as for WorkerKernel.
   */
  execute(code, opts, sink) {
    const s = once(sink);
    if (this.closed) return s.stopped(NOTES.closed);
    if (this.moved) return s.stopped(NOTES.moved);
    this.queue.push({ code, opts: opts ?? {}, sink: s, generation: this.generation });
    this.pump();
  }

  // the next queued run, once the one before it has its terminal
  pump() {
    if (this.current || !this.ready || this.closed || !this.queue.length) return;
    const job = this.queue.shift();
    this.current = job;
    this.runJob(job)
      .catch((e) => job.sink.stopped(`\nThe remote kernel failed: ${clip(e?.message ?? e)}\n`))
      .finally(() => {
        if (this.current === job) this.current = null;
        this.pump();
      });
  }

  // (a callback for this request and kernel is current only if nothing changed since it was sent)
  stale(ctx) {
    return ctx.generation !== this.generation || ctx.binding !== this.binding;
  }

  async runJob(job) {
    // (queued before a restart: its kernel is gone)
    if (job.generation !== this.generation) return job.sink.stopped(NOTES.restarted);
    if (this.needsFence && !(await this.takeover())) return;
    if (job.generation !== this.generation) return job.sink.stopped(NOTES.kernelReplaced);
    const request = `rq.${this.clientId}.${this.generation}.${this.nextN++}`;
    const ctx = { binding: this.binding, epoch: this.epoch, generation: this.generation, request };
    job.request = request;
    job.ctx = ctx;
    const o = job.opts;
    const payload = {
      code: job.code,
      mode: o.mode ?? "python",
      ...(o.cell ? { cell: String(o.cell) } : {}),
      ...(o.forget?.length ? { forget: [...o.forget] } : {}),
      ...(o.mangle && o.cell ? { mangle: String(o.cell).replace(/[^A-Za-z0-9]/g, "") } : {}),
      ...(o.seed ? { seed: o.seed } : {}),
      ...(o.scoped && Object.keys(o.scoped).length ? { scoped: { ...o.scoped } } : {}),
    };
    const body = { request, epoch: ctx.epoch, generation: ctx.generation, incarnation: this.incarnation, kind: "run", payload };
    const admitted = await this.submit(job, body);
    if (!admitted) return;
    await this.follow(job, ctx);
  }

  // POST the run; true once the gateway has it.  A lost answer is resent
  // once, identically (the gateway's at-most-once admission returns the
  // existing request); a second loss is an unknown outcome.
  async submit(job, body) {
    const path = `/bindings/${this.binding}/runs`;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.client.request("POST", path, body);
        return true;
      } catch (e) {
        if (!(e instanceof GatewayError)) {
          if (attempt === 0) continue;
          this.needsFence = true;
          job.sink.stopped(NOTES.unknown);
          return false;
        }
        if (e.code === "busy") job.sink.stopped(NOTES.busy);
        else if (e.code === "epoch") this.movedAway(job);
        else if (e.code === "fencing") { this.needsFence = true; job.sink.stopped(NOTES.notHanded); }
        else if (e.code === "quarantined") { await this.replace(); job.sink.stopped(NOTES.kernelReplaced); }
        else job.sink.stopped(`\nNot run: ${clip(e.message)}\n`);
        return false;
      }
    }
  }

  // The run's events until its terminal: reconnecting after a break, from
  // the last event seen; if it can't, the run's recorded outcome; if that is
  // unreachable too, unknown (and the binding is fenced before more work).
  async follow(job, ctx) {
    const sink = job.sink;
    const path = `/bindings/${ctx.binding}/runs/${encodeURIComponent(ctx.request)}`;
    let after = 0, failures = 0, started = false;
    const abort = new AbortController();
    job.abort = abort;
    while (!sink.ended && !this.stale(ctx)) {
      try {
        for await (const ev of this.client.events(`${path}/events`, after, abort.signal)) {
          if (sink.ended || this.stale(ctx)) return;
          failures = 0;
          if (Number.isFinite(ev.seq)) after = Math.max(after, ev.seq);
          if (ev.type === "start") { if (!started) { started = true; sink.start(); } }
          else if (ev.type === "stream") sink.out(String(ev.text ?? ""), ev.name === "stderr");
          else if (ev.type === "display") {
            // (a hidden run's envelope is the gateway's, never output: refused if it appears)
            if (ev.data && typeof ev.data === "object" && !(ENVELOPE_MIME in ev.data)) sink.display(ev.data);
          } else if (ev.type === "clear") sink.clear();
          else if (ev.type === "terminal") return this.finish(job, ctx, ev.outcome);
        }
        // (the stream ended without a terminal: reconnect)
        failures++;
      } catch (e) {
        if (sink.ended || this.stale(ctx)) return;
        if (e instanceof StreamError && e.tooLarge) {
          sink.out(NOTES.tooLarge, true);
          return this.awaitOutcome(job, ctx);
        }
        if (e instanceof GatewayError && (e.status === 404 || e.status === 410)) return this.awaitOutcome(job, ctx);
        failures++;
      }
      if (failures > 5) return this.awaitOutcome(job, ctx);
      await this.sleep(Math.min(8000, 500 * 2 ** (failures - 1)));
    }
  }

  // The run's outcome without its events: asked until it is terminal (the
  // run may still be going), giving up as unknown after repeated failures.
  async awaitOutcome(job, ctx) {
    const path = `/bindings/${ctx.binding}/runs/${encodeURIComponent(ctx.request)}`;
    let failures = 0, wait = 500;
    while (!job.sink.ended && !this.stale(ctx)) {
      try {
        const r = await this.client.request("GET", path);
        failures = 0;
        if (r?.outcome) return this.finish(job, ctx, r.outcome);
      } catch (e) {
        if (++failures > 5) break;
      }
      await this.sleep(wait);
      wait = Math.min(5000, wait * 2);
    }
    if (job.sink.ended || this.stale(ctx)) return;
    this.needsFence = true;
    job.sink.stopped(NOTES.unknown);
  }

  // A terminal, to the cell: only a user-phase ok is a success (done without error).
  finish(job, ctx, outcome) {
    if (job.sink.ended || this.stale(ctx)) return;
    const o = outcome && typeof outcome === "object" ? outcome : { status: "unknown" };
    const ms = Number.isFinite(o.ms) ? o.ms : 0;
    if (o.status === "ok") return job.sink.done(ms, { error: false });
    if (o.status === "error") return job.sink.done(ms, { error: true, ...(o.ename === "KeyboardInterrupt" ? { interrupted: true } : {}) });
    job.sink.stopped(outcomeNote(o));
    if (o.status === "unknown" || !["refused", "stopped", "setup-failed", "restarted-before-run"].includes(o.status)) this.needsFence = true;
    if (o.status === "restarted-before-run") this.recover(o.incarnation);
  }

  // An observed restart (the helper was missing, or another incarnation
  // answered): one recovery, a restart that bootstraps the helper; a second
  // in a row is left to the person (the status says so).
  recover(incarnation) {
    const key = `${this.binding}:${incarnation ?? this.incarnation}`;
    if (this.recoveredAt === key) {
      this.emit("status", "error: the remote kernel keeps restarting; restart it, or reconnect");
      return;
    }
    this.recoveredAt = key;
    this.restart(NOTES.restartedBeforeRun);
  }

  /** Interrupt what is running (the gateway signals the kernel); queued runs are skipped. */
  interrupt() {
    for (const j of this.queue.splice(0)) j.sink.skipped();
    if (!this.current || !this.binding) return;
    this.control("interrupt").catch((e) => this.emit("status", `error: Stop failed: ${clip(e?.message ?? e)}`));
  }

  /**
   * A fresh kernel (the gateway restarts it and bootstraps its helper).
   * Once the restart is done: a new generation, queued runs are told
   * `message`, and the running one is told the kernel was restarted (the
   * gateway settled it so).  If the restart fails, nothing changes but the status.
   */
  restart(message = NOTES.restarted) {
    if (!this.binding) return;
    this.emit("status", "restarting…");
    this.control("restart")
      .then((r) => {
        const o = r?.outcome ?? r;
        if (o?.status && o.status !== "done") throw new Error(outcomeNote(o)?.trim() || "the restart was refused");
        const running = this.current;
        this.generation++;
        if (o?.incarnation !== undefined) this.incarnation = o.incarnation;
        for (const j of this.queue.splice(0)) j.sink.stopped(message);
        if (running) { running.abort?.abort(); running.sink.stopped(NOTES.stoppedRestart); }
        this.emit("status", "ready (remote)");
        this.emit("restart");
      })
      .catch((e) => this.emit("status", `error: the restart failed: ${clip(e?.message ?? e)}`));
  }

  // A control op (interrupt, restart): its own op id, the current epoch.
  control(kind) {
    return this.client.request("POST", `/bindings/${this.binding}/${kind}`, { epoch: this.epoch, op_id: `op.${this.clientId}.${this.nextOp++}` });
  }

  /** Questions: {complete: text} -> {matches, prefix}; anything else, or a failure: `fallback`. */
  async ask(msg, mode, fallback) {
    if (msg?.complete === undefined || !this.ready || !this.binding) return fallback;
    try {
      const code = String(msg.complete);
      const r = await this.client.request("POST", `/bindings/${this.binding}/complete`, { epoch: this.epoch, op_id: `op.${this.clientId}.${this.nextOp++}`, code, cursor_pos: code.length });
      return { matches: Array.isArray(r?.matches) ? r.matches.slice(0, 500).map(String) : [], prefix: String(r?.prefix ?? "") };
    } catch {
      return fallback;
    }
  }

  /** @interact needs the in-page engine: not on a remote kernel. */
  interact(_id, _values, sink) {
    once(sink).stopped("\n@interact is not available on a remote kernel.\n");
  }

  /**
   * Take the binding over (fence): after an unknown outcome, or in a new
   * tab.  true once the gateway's fence is acknowledged and nothing from
   * before is still executing.
   */
  async takeover() {
    const deadline = Date.now() + 100_000; // (the gateway's own fence wait)
    let wait = 500;
    for (;;) {
      let r;
      try {
        r = await this.client.request("POST", `/bindings/${this.binding}/takeover`, { client: this.clientId });
      } catch (e) {
        if (e instanceof GatewayError && e.code === "quarantined") return this.replaceFor();
        this.emit("status", `error: the remote kernel could not be reached: ${clip(e?.message ?? e)}`);
        this.failCurrent(NOTES.unreachable);
        return false;
      }
      if (r.state === "quarantined") return this.replaceFor();
      if (r.state === "ready") {
        this.epoch = r.epoch;
        this.needsFence = false;
        const applied = Array.isArray(r.applied_before_takeover) ? r.applied_before_takeover : [];
        if (applied.some((a) => a?.kind === "restart" || a?.kind === "delete")) {
          this.generation++;
          this.emit("status", "the remote kernel was restarted before this tab took it over; variables are gone");
          this.emit("restart");
        }
        if (Array.isArray(r.in_flight) && r.in_flight.length) {
          this.emit("status", "a run from the previous tab is still executing");
          this.failCurrent(NOTES.inFlight);
          this.needsFence = true; // (asked again before the next run)
          return false;
        }
        return true;
      }
      // fencing: the gateway refuses new work until its fence is acknowledged
      if (Date.now() + wait > deadline) return this.replaceFor();
      await this.sleep(wait);
      wait = Math.min(5000, wait * 2);
    }
  }

  // (the current job, told why it did not run)
  failCurrent(note) { this.current?.sink.stopped(note); }

  // The binding could not be handed over safely: a new one (a fresh kernel, a new generation).
  async replaceFor() {
    await this.replace();
    this.failCurrent(NOTES.kernelReplaced);
    return false;
  }
  async replace() {
    this.binding = null;
    this.emit("status", "This notebook's kernel couldn't be handed over safely; starting a fresh kernel");
    // (the job that found this out is still current, so start() runs nothing else yet)
    const ok = await this.start();
    if (ok) this.emit("restart");
  }

  // Another tab owns the binding now: this one stops, its queue skipped.
  movedAway(job) {
    this.moved = true;
    this.ready = false;
    job?.sink.stopped(NOTES.moved);
    for (const j of this.queue.splice(0)) j.sink.stopped(NOTES.moved);
    this.emit("status", "this notebook's kernel is in use in another tab");
  }

  /** Disconnect: what was running or queued is told `message` (the kernel itself is the gateway's). */
  close(message = NOTES.closed) {
    this.closed = true;
    this.ready = false;
    for (const j of this.queue.splice(0)) j.sink.stopped(message);
    if (this.current) { this.current.abort?.abort(); this.current.sink.stopped(message); }
  }
}
