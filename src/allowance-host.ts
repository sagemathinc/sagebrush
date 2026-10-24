// Opt-in limits (scope item G): the host's scope state machine.  Design:
// /scratch/sagebrush-reviews/design-optin-limits-g-r3.md §1.2–1.3, §3.1–3.2,
// §4.2 and §5; implementation order plan-optin-limits-g-impl-r3, PR G-1.
//
// A pure library.  The host (the page, the grader harness, the runner) owns
// one ScopeHost and gives it a monotonic clock, a timer and a terminator; the
// ScopeHost owns the ledgers, the latches and the arbitration between a
// computation finishing and its grace running out.  Nothing here touches a
// runtime: G-3 to G-5 wire the stop word, the exceptions and the real hosts
// to it.  Times are monotonic seconds from the injected clock.
//
// The rules it keeps, from the design:
// - every dimension has its own ledgers; no minimum is taken across them;
// - a wall budget counts busy time only: a notebook or question scope's
//   budget is paused while nothing runs in it (§1.3);
// - a scope's exhaustion is latched once, with its first hit, and is never
//   overwritten (§3.1); an execution's stop has one primary cause, the first
//   by the host's time of request, ties in the fixed order of §3.2, and the
//   rest in `also`;
// - the grace deadline is first_hit + grace, fixed when the first allowance
//   latches; completion is compared with it at the host boundary by the
//   clock, whenever the timer's callback runs, and completion AT the
//   deadline is late (§4.2; astra's r3 check 1);
// - recognition_s is set only from a recognition the runtime reported, never
//   from a stop having been requested (check 2);
// - terminated is published only once the terminator confirms the end
//   (check 3), and a failed termination is a host error;
// - each execution has exactly one terminal result; timers carry their
//   execution's generation, and a stale callback is a no-op;
// - a work reservation is checked against every ledger before the substep
//   starts and taken from all of them or none; a refusal names the innermost
//   ledger that fails, the call's own work= budget counting as innermost
//   (§5.1; impl r3 G-4);
// - reaching a count limit exactly is success: an allowance of N steps lets
//   exactly N steps run, and the stop is the next one attempted (the runtime
//   reports it with stepRefused), as a reservation that fills a work ledger
//   exactly fits.  A builtin's chunk charge that overshoots N latches too.
//   Wall time is the exception: completion at the expiry is late (above).
import { type Allowance, type AllowanceScope, graceSeconds, isScopeId } from "./allowance";

export type StopCause = "memory" | "server" | "cancel" | "allowance" | "call";
/** Exact ties at one poll resolve in this order (design §3.2). */
const CAUSE_ORDER: Record<StopCause, number> = { memory: 0, server: 1, cancel: 2, allowance: 3, call: 4 };

export interface HostClock {
  (): number;
}
export interface HostTimers {
  /** Calls `fire` at (or, if delayed, after) monotonic time `at`. */
  set(at: number, fire: () => void): unknown;
  clear(handle: unknown): void;
}
export interface HostTerminator {
  /** Ends and replaces the worker or process running execution `generation`; the host reports the end through ScopeHost.terminated. */
  terminate(generation: number): void;
}
export interface HostSignals {
  /** The host sets the tagged stop for a latched allowance (G-3 wires this to the stop word). */
  stop?(generation: number, scopeId: string): void;
  /** The one terminal result of an execution. */
  result?(r: ExecutionResult): void;
}

export interface Spend {
  charged: number;
  measured: number;
  spent_at_most: number;
}
export type LimitKind = "wall" | "steps" | "work";
export interface Latch {
  scope_id: string;
  scope_kind: AllowanceScope;
  source: Allowance["source"];
  kind: LimitKind;
  family?: string;
  schedule?: string;
  allowance: number;
  first_hit_mono: number;
  generation: number;
}
export interface CauseRecord {
  cause: StopCause;
  at: number;
  scope_id?: string;
}
export interface ExecutionResult {
  generation: number;
  scope_id: string;
  /** complete: no stop; limit: an allowance is the primary cause; stopped: another cause is; unattempted: an enclosing scope was already exhausted; host_error: termination failed. */
  status: "complete" | "limit" | "stopped" | "unattempted" | "host_error";
  primary: CauseRecord | null;
  also: CauseRecord[];
  /** Every scope of this execution's chain latched during it, in latch order. */
  latches: Latch[];
  hard: boolean;
  terminated: boolean;
  recognition_s: number | null;
  handback_s: number | null;
  terminated_after_s: number | null;
  busy_s: number;
  /** The spend and latch of every scope of the chain, innermost first, after this execution. */
  scopes: ScopeRecord[];
  error?: string;
}
export interface ScopeRecord {
  scope_id: string;
  scope_kind: AllowanceScope;
  exhausted: boolean;
  latch: Latch | null;
  wall_s?: Spend;
  steps?: Spend;
  work?: Record<string, Spend>;
}

interface Ledger {
  budget: number;
  charged: number;
  measured: number;
}
class Scope {
  wall: Ledger | null = null;
  steps: Ledger | null = null;
  work = new Map<string, Ledger>();
  latch: Latch | null = null;
  closed = false;
  constructor(
    readonly id: string,
    readonly kind: AllowanceScope,
    readonly allowance: Allowance | null,
    readonly parent: Scope | null,
  ) {
    if (allowance) {
      if (allowance.wall_s !== undefined) this.wall = { budget: allowance.wall_s, charged: 0, measured: 0 };
      if (allowance.steps !== undefined) this.steps = { budget: allowance.steps, charged: 0, measured: 0 };
      for (const [f, n] of Object.entries(allowance.work ?? {})) this.work.set(f, { budget: n, charged: 0, measured: 0 });
    }
  }
  chain(): Scope[] {
    const out: Scope[] = [];
    for (let s: Scope | null = this; s; s = s.parent) out.push(s);
    return out; // innermost first
  }
}

interface Reservation {
  family: string;
  bound: number;
  ledgers: Ledger[];
}
class Execution {
  state: "running" | "terminating" | "done" = "running";
  causes: CauseRecord[] = [];
  latches: Latch[] = [];
  firstHit: number | null = null;
  graceDeadline: number | null = null;
  recognitionAt: number | null = null;
  wallTimer: unknown = null;
  wallTimerAt: number | null = null;
  graceTimer: unknown = null;
  reservations = new Map<number, Reservation>();
  nextReservation = 1;
  constructor(
    readonly generation: number,
    readonly leaf: Scope,
    readonly start: number,
  ) {}
}

export interface ScopeHostOptions {
  clock: HostClock;
  timers: HostTimers;
  terminator: HostTerminator;
  signals?: HostSignals;
  /** The runtime's steps schedule version, recorded with a steps latch (design §4.3). */
  stepsSchedule?: string;
}

const fail = (m: string): never => {
  throw new Error(`allowance host: ${m}`);
};
const count = (n: unknown, what: string): number => (Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : fail(`${what} must be a non-negative integer`));

export class ScopeHost {
  private scopes = new Map<string, Scope>();
  private generation = 0;
  private current: Execution | null = null;
  constructor(private readonly o: ScopeHostOptions) {}

  // ----- scopes ------------------------------------------------------------

  /** Opens a notebook or question scope, which lasts across the cells and tests run in it. */
  open(id: string, kind: "notebook" | "question", allowance: Allowance | null, parentId?: string): void {
    if (!isScopeId(id)) fail(`bad scope id ${JSON.stringify(id)}`);
    if (this.scopes.has(id)) fail(`scope ${id} is already open`);
    if (allowance && allowance.scope !== kind) fail(`an allowance for a ${allowance.scope} scope can't arm a ${kind} scope`);
    const parent = parentId === undefined ? null : this.scope(parentId);
    if (kind === "notebook" && parent) fail("a notebook scope has no parent");
    if (kind === "question" && parent?.kind !== "notebook") fail("a question scope's parent is the notebook scope");
    this.scopes.set(id, new Scope(id, kind, allowance, parent));
  }

  /** Closes a notebook or question scope at the run's end or the kernel's restart; returns its record. */
  close(id: string): ScopeRecord {
    const s = this.scope(id);
    if (this.current && this.current.leaf.chain().includes(s)) fail(`scope ${id} has a running execution`);
    for (const c of this.scopes.values()) if (c.parent === s && !c.closed) fail(`scope ${id} has an open child ${c.id}`);
    s.closed = true;
    this.scopes.delete(id);
    return this.record(s);
  }

  /** What a scope has spent, and its latch (for sagebrush.allowance() and the records). */
  record(s: Scope | string): ScopeRecord {
    const sc = typeof s === "string" ? this.scope(s) : s;
    const spend = (l: Ledger | null): Spend | undefined => (l ? { charged: l.charged, measured: l.measured, spent_at_most: l.charged } : undefined);
    const work: Record<string, Spend> = {};
    for (const [f, l] of sc.work) work[f] = spend(l)!;
    return {
      scope_id: sc.id,
      scope_kind: sc.kind,
      exhausted: sc.latch !== null,
      latch: sc.latch,
      wall_s: spend(sc.wall),
      steps: spend(sc.steps),
      work: sc.work.size ? work : undefined,
    };
  }

  // ----- executions --------------------------------------------------------

  /**
   * Starts one cell or test (the leaf scope) inside an open scope.  Returns
   * its generation, or an unattempted result if an enclosing scope is
   * already exhausted (design §3.1: the remaining cells and tests aren't run).
   */
  run(id: string, kind: "cell" | "test", allowance: Allowance | null, parentId: string): number | ExecutionResult {
    if (this.current) fail("an execution is already running (one thread of execution, §5.1)");
    if (!isScopeId(id)) fail(`bad scope id ${JSON.stringify(id)}`);
    if (allowance && allowance.scope !== kind) fail(`an allowance for a ${allowance.scope} scope can't arm a ${kind} scope`);
    if (this.scopes.has(id)) fail(`scope ${id} is already open`);
    const parent = this.scope(parentId);
    const generation = ++this.generation;
    const leaf = new Scope(id, kind, allowance, parent);
    const exhausted = parent.chain().find((s) => s.latch);
    if (exhausted) {
      const r: ExecutionResult = { ...this.blank(generation, id), status: "unattempted", primary: null };
      this.o.signals?.result?.(r);
      return r;
    }
    const x = new Execution(generation, leaf, this.o.clock());
    this.current = x;
    this.armWall(x);
    return generation;
  }

  /** The least remaining steps balance over the active steps ledgers, or null if none is armed (the runtime's countdown, design §5.2). */
  stepsRemaining(generation: number): number | null {
    const x = this.live(generation);
    if (!x) return null;
    let least: number | null = null;
    for (const s of x.leaf.chain()) if (s.steps) least = Math.min(least ?? Infinity, Math.max(0, s.steps.budget - s.steps.charged));
    return least;
  }

  /**
   * The runtime reports n steps taken since its last report; every steps
   * ledger is debited.  Taking exactly a ledger's N steps is within it; a
   * ledger charged past N (a builtin's chunk charge overshooting) latches.
   */
  steps(generation: number, n: number, at: number = this.o.clock()): void {
    const x = this.live(generation);
    if (!x) return;
    count(n, "steps");
    for (const s of x.leaf.chain()) {
      if (!s.steps) continue;
      s.steps.charged += n;
      s.steps.measured += n;
    }
    // innermost first, so a tie names the innermost ledger
    for (const s of x.leaf.chain()) if (s.steps && s.steps.charged > s.steps.budget) this.latch(x, s, "steps", s.steps.budget, at);
    this.checkGrace(x, this.o.clock());
  }

  /**
   * The runtime's countdown was at zero and it refused the next step (after
   * reporting the steps it took): every steps ledger with nothing left
   * latches, innermost first.  It's a runtime error if none is at zero.
   */
  stepRefused(generation: number, at: number = this.o.clock()): void {
    const x = this.live(generation);
    if (!x) return;
    const spent = x.leaf.chain().filter((s) => s.steps && s.steps.charged >= s.steps.budget);
    if (spent.length === 0) fail("a step was refused with steps left in every ledger");
    for (const s of spent) this.latch(x, s, "steps", s.steps!.budget, at);
    this.checkGrace(x, this.o.clock());
  }

  /**
   * Reserves a charged substep's bound against every work ledger of its
   * family (and the call's own remaining work=, if it has one).  If any
   * can't hold it, nothing is reserved and the substep doesn't start: the
   * innermost failing ledger is named; the call's own budget fails with
   * cause "call" and latches nothing; an allowance ledger latches its scope.
   */
  reserve(generation: number, family: string, bound: number, callRemaining?: number): { ok: true; id: number } | { ok: false; cause: "call" } | { ok: false; cause: "allowance"; scope_id: string } | { ok: false; cause: "gone" } {
    const x = this.live(generation);
    if (!x) return { ok: false, cause: "gone" };
    count(bound, "a reservation's bound");
    if (callRemaining !== undefined && bound > count(callRemaining, "the call's remaining work")) return { ok: false, cause: "call" };
    const chain = x.leaf.chain().filter((s) => s.work.has(family));
    const failing = chain.find((s) => {
      const l = s.work.get(family)!;
      return l.charged + bound > l.budget;
    });
    if (failing) {
      const now = this.o.clock();
      this.latch(x, failing, "work", failing.work.get(family)!.budget, now, family);
      this.checkGrace(x, now);
      return { ok: false, cause: "allowance", scope_id: failing.id };
    }
    const ledgers = chain.map((s) => s.work.get(family)!);
    for (const l of ledgers) l.charged += bound;
    const id = x.nextReservation++;
    x.reservations.set(id, { family, bound, ledgers });
    return { ok: true, id };
  }

  /** A substep completed with this actual charge: the rest of its bound is refunded to every ledger it was reserved from (§5.1). */
  settle(generation: number, id: number, actual: number): void {
    const x = this.live(generation);
    if (!x) return; // after termination the open reservation is forfeit (§5.3)
    const r = x.reservations.get(id) ?? fail(`no open reservation ${id}`);
    count(actual, "a substep's actual charge");
    if (actual > r.bound) fail(`a substep charged ${actual}, more than its bound ${r.bound}: the bound wasn't sound`);
    for (const l of r.ledgers) {
      l.charged -= r.bound - actual;
      l.measured += actual;
    }
    x.reservations.delete(id);
  }

  /** The runtime recognized the stop at a poll (it reports this as it happens). */
  recognized(generation: number, at: number = this.o.clock()): void {
    const x = this.live(generation);
    if (x && x.firstHit !== null && x.recognitionAt === null) x.recognitionAt = at;
  }

  /** A stop that isn't an allowance's: a cancel, a memory guard, a server bound, or the call's own deadline=/work=. */
  stopRequested(generation: number, cause: Exclude<StopCause, "allowance">, at: number = this.o.clock()): void {
    const x = this.live(generation);
    if (!x) return;
    x.causes.push({ cause, at });
  }

  /**
   * The execution's result reached the host boundary: the stopped call's
   * result or exception reached the scope's exit, and control is back in
   * the host.  Returns its one terminal result, or "discarded" if this
   * completion lost to the grace deadline (or arrived after termination).
   */
  finish(generation: number, at: number = this.o.clock()): ExecutionResult | "discarded" {
    const x = this.live(generation);
    if (!x) return "discarded";
    this.wallUpTo(x, at);
    // completion AT the deadline is late: "before" excludes equality
    if (x.graceDeadline !== null && at >= x.graceDeadline) {
      this.terminate(x);
      return "discarded";
    }
    const busy = at - x.start;
    this.chargeWall(x, busy);
    const p = this.primary(x);
    const r: ExecutionResult = {
      ...this.blank(x.generation, x.leaf.id),
      status: p === null ? "complete" : p.cause === "allowance" ? "limit" : "stopped",
      primary: p,
      also: this.also(x, p),
      latches: [...x.latches],
      recognition_s: x.firstHit !== null && x.recognitionAt !== null ? x.recognitionAt - x.firstHit : null,
      handback_s: x.recognitionAt !== null ? at - x.recognitionAt : null,
      busy_s: busy,
    };
    this.end(x, r);
    return r;
  }

  /** The terminator's report: the worker or process running `generation` has ended (ok) or couldn't be ended. */
  terminated(generation: number, ok: boolean, at: number = this.o.clock()): ExecutionResult | null {
    const x = this.current;
    if (!x || x.generation !== generation || x.state !== "terminating") return null;
    const busy = at - x.start;
    this.chargeWall(x, busy);
    // the open reservations are charged in full: the ledgers keep them (§5.3)
    x.reservations.clear();
    const p = this.primary(x);
    const r: ExecutionResult = ok
      ? {
          ...this.blank(x.generation, x.leaf.id),
          status: p?.cause === "allowance" ? "limit" : "stopped",
          primary: p,
          also: this.also(x, p),
          latches: [...x.latches],
          hard: true,
          terminated: true,
          recognition_s: x.firstHit !== null && x.recognitionAt !== null ? x.recognitionAt - x.firstHit : null,
          handback_s: null,
          terminated_after_s: x.firstHit !== null ? at - x.firstHit : null,
          busy_s: busy,
        }
      : {
          ...this.blank(x.generation, x.leaf.id),
          status: "host_error",
          primary: p,
          also: this.also(x, p),
          latches: [...x.latches],
          hard: true,
          busy_s: busy,
          error: "the host couldn't end the computation after its grace period",
        };
    this.end(x, r);
    return r;
  }

  // ----- internals ---------------------------------------------------------

  private scope(id: string): Scope {
    return this.scopes.get(id) ?? fail(`no open scope ${id}`);
  }
  private live(generation: number): Execution | null {
    const x = this.current;
    return x && x.generation === generation && x.state === "running" ? x : null;
  }
  private blank(generation: number, id: string): ExecutionResult {
    return { generation, scope_id: id, status: "complete", primary: null, also: [], latches: [], hard: false, terminated: false, recognition_s: null, handback_s: null, terminated_after_s: null, busy_s: 0, scopes: [] };
  }

  // the absolute expiry of each wall scope of the chain, from what it has left
  private expiries(x: Execution): { s: Scope; at: number }[] {
    const out: { s: Scope; at: number }[] = [];
    for (const s of x.leaf.chain()) if (s.wall && !s.latch) out.push({ s, at: x.start + (s.wall.budget - s.wall.charged) });
    return out;
  }
  private armWall(x: Execution): void {
    if (x.wallTimer !== null) this.o.timers.clear(x.wallTimer);
    x.wallTimer = x.wallTimerAt = null;
    const next = this.expiries(x).reduce((m, e) => Math.min(m, e.at), Infinity);
    if (next === Infinity) return;
    const g = x.generation;
    x.wallTimerAt = next;
    x.wallTimer = this.o.timers.set(next, () => this.wallFired(g));
  }
  private wallFired(generation: number): void {
    const x = this.live(generation);
    if (!x) return; // a stale timer can't affect the next execution
    x.wallTimer = x.wallTimerAt = null;
    const now = this.o.clock();
    this.wallUpTo(x, now);
    this.checkGrace(x, now);
    if (x.state === "running") this.armWall(x);
  }
  // latch every wall scope whose expiry is at or before `now`, at its expiry
  // (not at when the callback ran), earliest first, innermost first on a tie
  private wallUpTo(x: Execution, now: number): void {
    const due = this.expiries(x).filter((e) => e.at <= now);
    due.sort((a, b) => a.at - b.at);
    for (const e of due) if (x.state === "running") this.latch(x, e.s, "wall", e.s.wall!.budget, e.at);
  }
  private chargeWall(x: Execution, busy: number): void {
    for (const s of x.leaf.chain())
      if (s.wall) {
        s.wall.charged += busy;
        s.wall.measured += busy;
      }
  }

  private latch(x: Execution, s: Scope, kind: LimitKind, allowance: number, at: number, family?: string): void {
    if (s.latch) return; // once: the cause and the first hit are never overwritten
    const a = s.allowance!;
    const l: Latch = { scope_id: s.id, scope_kind: s.kind, source: a.source, kind, allowance, first_hit_mono: at, generation: x.generation };
    if (family !== undefined) l.family = family;
    if (kind === "steps" && this.o.stepsSchedule !== undefined) l.schedule = this.o.stepsSchedule;
    s.latch = l;
    x.latches.push(l);
    x.causes.push({ cause: "allowance", at, scope_id: s.id });
    if (x.firstHit === null) {
      // the grace deadline is fixed by the first latch, and nothing resets it
      x.firstHit = at;
      x.graceDeadline = at + graceSeconds(a);
      this.o.signals?.stop?.(x.generation, s.id);
      const g = x.generation;
      x.graceTimer = this.o.timers.set(x.graceDeadline, () => this.graceFired(g));
    }
  }
  // termination proceeds once the host's clock reaches the grace deadline,
  // whether or not the timer's callback has run yet
  private checkGrace(x: Execution, now: number): void {
    if (x.state === "running" && x.graceDeadline !== null && now >= x.graceDeadline) this.terminate(x);
  }
  private graceFired(generation: number): void {
    const x = this.live(generation);
    if (!x) return;
    x.graceTimer = null;
    this.checkGrace(x, this.o.clock());
  }
  private terminate(x: Execution): void {
    if (x.state !== "running") return;
    x.state = "terminating";
    this.clearTimers(x);
    this.o.terminator.terminate(x.generation);
  }
  private clearTimers(x: Execution): void {
    if (x.wallTimer !== null) this.o.timers.clear(x.wallTimer);
    if (x.graceTimer !== null) this.o.timers.clear(x.graceTimer);
    x.wallTimer = x.graceTimer = x.wallTimerAt = null;
  }
  private end(x: Execution, r: ExecutionResult): void {
    this.clearTimers(x);
    r.scopes = x.leaf.chain().map((s) => this.record(s));
    x.state = "done";
    this.current = null;
    this.o.signals?.result?.(r);
  }

  // the first cause by the host's time of request; exact ties in §3.2's order
  private primary(x: Execution): CauseRecord | null {
    let p: CauseRecord | null = null;
    for (const c of x.causes) if (!p || c.at < p.at || (c.at === p.at && CAUSE_ORDER[c.cause] < CAUSE_ORDER[p.cause])) p = c;
    return p;
  }
  private also(x: Execution, p: CauseRecord | null): CauseRecord[] {
    return x.causes.filter((c) => c !== p).sort((a, b) => a.at - b.at || CAUSE_ORDER[a.cause] - CAUSE_ORDER[b.cause]);
  }
}
