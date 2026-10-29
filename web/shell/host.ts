// ShellHost: the page's mediator between the shell worker and the workspace (plan-bash-shell r3 §2–§3,
// addendum D8 r3).  The worker never holds the Workspace or any handle to it: each file call of an
// invocation is one fs.request (web/shell/loader.ts), which this answers with workspace verbs, each checked
// at use.
//
// - **Principals** (r3 §2.1), bound by the page when it opens a run, never named by a request: the person
//   (the whole workspace), or a grant (folders by fid, write or not, live() re-read at every use, and an
//   explicit actor for the op log: an agent's pairing grant in step 7, a document's interpreter grants in
//   step 5).
// - **Every request checked at use** (§2.2): the run's random 64-bit id, the canonical path (Trash refused),
//   the mode, the grant inside the verb's locked section through the workspace's admit option, on the
//   resolved entry's identity (api.ts AdmitCheck), revocation at every use, the fast paths (the top, what is
//   pending) included.
// - **Writes bound to identity** (§3.2): every redirection target is the observation made at its open (a
//   present file's fid and rev, for `>>` its bytes too, from one readUpTo; or absent), checked under the
//   lock at commit, never re-observed within the invocation.
// - **Redirections** (§3.3 rules 1–9): an open with `>` of an existing file is a pending truncation, of an
//   absent path a pending creation, both seen as empty by this invocation and committed at its ordinary end
//   (or before another mutation of that path); a non-empty write or append is one commit.  Each invocation
//   ends clean (F9): what it had pending is committed or retired, and its observations go with it, as a
//   finished `bash -c` keeps nothing open.
// - **The outcome is the host's** (D8 point 5): when an invocation ends, before anything pending is
//   committed or anything published, its outcome comes from what this host recorded and did: Stop (row 1),
//   a lost worker (2), a revoked or expired grant (3), a limit (4), a fault (5), else ordinary (6).
//   Rows 1–5 latch the run's terminal state and close its admission in the same step that records them.
// - **The fence is per workspace verb** (CORR-BASH-S2-2): every verb this host calls is asked `admit`
//   holding the workspace's lock before it changes anything, and the admit refuses once the run is latched.
//   That is the linearization point: a verb whose admit passed before the latch finishes (the one allowance
//   of D8), and every later one, a pending commit, a copy's next duplicate, a waiter on the lock, does
//   nothing.  A rejection of the shell's exec() is ordinary only if it names one of this invocation's own
//   refusals (provenance).
// - **Limits and the run ledger** (step 3: r3 §4, erratum r8c E2; web/shell/limits.ts).  The config is validated
//   when the host is made, sent once to each worker it starts (host level 3's init), and every run keeps a ledger
//   the page charges at exactly one point per key, never refunded (r8c E2's table): `invocations` before dispatch;
//   `ops` and `written_bytes` at each mutating transaction's own admit, inside its locked section; `cp_entries` and
//   `cp_bytes` reserved by the cp -r preflight, before its first mutation; `output_bytes` with what the module
//   delivers, by its own count (ruling C); `script_ms` from the page's clock, dispatch to end, on every path.  The
//   12 page and module keys end the run typed (row 4, exit 125, `bash: bash.<key> exceeded (<value>)`); the 6 keys
//   just-bash enforces, and its fixed output backstop, are ordinary outcomes, never classified from their text.
// - **Stop covers startup** (CORR-BASH-S2-1): a Stop while the worker starts never dispatches the script;
//   it settles at once if the start finishes within the 2 s grace (the worker that started for it is ended),
//   else at the grace, the start abandoned and its worker ended when it comes.
import { Workspace, WorkspaceError, OutOfScope, identOf, type AdmitCheck, type Entry } from "../workspace/api";
import { normPath, parentOf, nameOf, within, TRASH, PathError } from "../workspace/paths";
import { ShellUnavailableError, type Shell, type ShellOutcome, type FsRequest, type FsAnswer } from "./loader";
export { BashConfigError, BASH_RANGES, OUTPUT_BACKSTOP } from "./limits";
import { boundedJson, TooLarge } from "./bounded-json";
import { validateBash, executionLimitsOf, limitWords, wrap, LIMIT_EXIT, OUTPUT_BACKSTOP, type BashLimits, type LimitKey } from "./limits";

/** Who a run belongs to (r3 §2.1).  A grant names its actor, always: "person" (a document of the person's,
 * under its interpreter's grants) or "agent:<name>" (a paired agent); anything else is refused before work. */
export type Principal =
  | { kind: "person" }
  | {
      kind: "grant";
      /** the op log's actor for its changes */
      actor: "person" | `agent:${string}`;
      /** the granted folders, by fid (design/capabilities.md §6): each covers what is inside it at the moment of use */
      folders: ReadonlySet<string>;
      write: boolean;
      /** read at every use: "ok", or the grant has been revoked or has expired */
      live: () => "ok" | "revoked" | "expired";
    };

/** A change the run committed, as results list them (r3 §5.3): local until sync says more (step 3). */
export type OpRecord = { verb: "write" | "create" | "mkdir" | "rename" | "remove" | "duplicate"; path: string; to?: string; rev?: number; committed: "local" };

/**
 * What an invocation came to (D8 point 5's rows): an ordinary end with the shell's final status (row 6),
 * or a typed one, which the forms raise (r3 §7.4) and which never carries a status.  `ops`: exactly what was
 * committed.
 */
export type HostOutcome =
  | { kind: "exit"; code: number; stdout: string; stderr: string; ops: OpRecord[]; truncated?: true }
  | { kind: "interrupted"; row: 1; ops: OpRecord[] }
  | { kind: "unavailable"; row: 2 | 3 | 5; reason: string; ops: OpRecord[] }
  | { kind: "limit"; row: 4; key: LimitKey; value: number; code: 125; stderr: string; ops: OpRecord[] };

/** A run's ledger (r3 §4.4, r8c E2): what it has been charged, by key; never refunded. */
export type Ledger = { invocations: number; script_ms: number; output_bytes: number; ops: number; written_bytes: number; cp_entries: number; cp_bytes: number };

/** The pending entries a run may hold at once (r3 §3.3 rule 2): past it, EMFILE. */
export const MAX_PENDING = 64;
/** How long Stop waits for the shell (or its start) to unwind before the worker is ended (r3 §4.3). */
export const STOP_GRACE_MS = 2000;
/** The bytes one read may return by default (bash.read_bytes's default, r3 §4.2 B). */
export const READ_BYTES = 64 * 2 ** 20;
/** The host level whose shell reaches files through this mediator (fs.request, web/shell/host-levels.json):
 * a package that needs less is the in-memory shell of step 1, which a workspace surface never runs (F12). */
export const MEDIATED_FS_LEVEL = 2;
/** The host level whose shell takes the limits (step 3's init): a workspace run needs it, since an older shell
 * would run with just-bash's own defaults, which r3 §4.2 A rules out. */
export const CONFIGURED_LEVEL = 3;
/** script_ms's watchdog: the page ends the worker this long after the run's remaining time (r3 §4.2 A). */
export const WATCHDOG_SLACK_MS = 1000;
/** The actors a grant may name (r3 §2.1). */
const ACTOR = /^(person|agent:[\w.-]{1,64})$/;

/** A refusal of a request: an errno, what the shell prints, recorded under an id of the run's. */
class Refusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
/** Outside the grant: the refusal the workspace's list() filters on (and a refusal like any other elsewhere). */
class ScopeRefusal extends OutOfScope {
  readonly code = "EACCES";
}
/** The grant was revoked or expired at a use (row 3). */
class Revoked extends Error {}
/** The run is latched: a verb asked after it does nothing (the fence). */
class Fenced extends Error {}
/** A limit reached at a charging point (row 4): thrown before the verb changes anything. */
class LimitHit extends Error {
  constructor(readonly key: LimitKey) {
    super(`bash.${key} exceeded`);
  }
}

// The words the workspace's refusals print with (r3 §3.1's table).
const REASON: Record<string, string> = { ENOENT: "No such file or directory", EEXIST: "File exists", ECONFLICT: "changed elsewhere", ENOTDIR: "Not a directory", EISDIR: "Is a directory", EACCES: "Permission denied" };
function refusalOf(err: unknown, p: string): Refusal | null {
  if (err instanceof Refusal) return err;
  if (err instanceof ScopeRefusal) return new Refusal("EACCES", err.message);
  if (err instanceof PathError) return new Refusal("EINVAL", `${p}: ${err.message}`);
  if (!(err instanceof WorkspaceError)) return null;
  const code = { exists: "EEXIST", missing: "ENOENT", conflict: "ECONFLICT", storage: "ENOSPC", invalid: "EINVAL", quarantined: "EROFS", busy: "EBUSY" }[err.code as string] ?? (err.code === "limit" ? (/at most \d+ bytes|larger than/.test(err.message) ? "EFBIG" : "ENOSPC") : null);
  if (!code) return null;
  return new Refusal(code, `${p}: ${REASON[code] ?? err.message}`);
}
const refuse = (code: string, p: string, why = REASON[code]) => new Refusal(code, `${p}: ${why}`);
// (the verbs that change something, and so need write: a duplicate's destination, not its source)
const MUTATES = (c: AdmitCheck) => c.op === "create" || c.op === "write" || c.op === "mkdir" || c.op === "rename" || c.op === "remove" || (c.op === "duplicate" && c.role === "destination");

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const concat = (a: Uint8Array, b: Uint8Array) => {
  const c = new Uint8Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
};
const EMPTY = new Uint8Array(0);
const expectOf = (e: Entry) => ({ kind: e.kind, ref: e.ref, fid: e.fid, created: e.created });
const why = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 200);

/** A redirection target's observation (§3.2): the file as this invocation saw it at the open, or after its own commit. */
type Obs = { fid: string; rev: number; bytes?: Uint8Array };
type Terminal = { row: 1 } | { row: 2 | 3 | 5; reason: string } | { row: 4; key: LimitKey; value: number };
const utf8 = (s: string) => new TextEncoder().encode(s).length;

/** One run (r3 §4.4): one execution request, with its own id, ledger and fence, and one or more invocations. */
export class ShellRun {
  readonly id = hex(8);
  /** the latched terminal condition (D8 point 5's fence): once set, nothing more is admitted */
  terminal: Terminal | null = null;
  readonly ops: OpRecord[] = [];
  /** the refusals made, by id, with the invocation each was made in */
  private refusals = new Map<string, number>();
  private obs = new Map<string, Obs>();
  private pending = new Map<string, "trunc" | "create">();
  private queue: Promise<unknown> = Promise.resolve();
  private invocation = 0;
  private stopping: AbortController | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private onGrace: (() => void) | null = null;
  private used: Ledger = { invocations: 0, script_ms: 0, output_bytes: 0, ops: 0, written_bytes: 0, cp_entries: 0, cp_bytes: 0 };
  /** how many times script_ms's watchdog ended this run's worker (the tests' counter, G1) */
  watchdogFired = 0;

  constructor(private host: ShellHost, readonly principal: Principal) {
    if (principal.kind === "grant" && !(typeof principal.actor === "string" && ACTOR.test(principal.actor))) throw new TypeError(`a grant names its actor, "person" or "agent:<name>" (not ${JSON.stringify(principal.actor)})`);
  }

  /** Latch a terminal condition and close admission, in this one step (the fence). */
  latch(t: Terminal) {
    if (!this.terminal) this.terminal = t;
  }
  /** What the run has been charged (a copy). */
  ledger(): Readonly<Ledger> {
    return { ...this.used };
  }
  private get limits(): BashLimits {
    return this.host.limits;
  }
  private limitHit(key: LimitKey) {
    this.latch({ row: 4, key, value: key === "read_bytes" ? this.host.readBytes : this.limits[key]! });
  }

  /** Stop (r3 §4.3, row 1): latched at once; the shell's signal aborted; the worker (or its start) ended if it hasn't unwound within 2 s. */
  stop() {
    this.latch({ row: 1 });
    this.stopping?.abort();
    if (this.stopping && !this.stopTimer)
      this.stopTimer = setTimeout(() => {
        this.host.endShell("it didn't stop within 2 s");
        this.onGrace?.();
      }, STOP_GRACE_MS);
  }

  /** One invocation of the run: `{ SCRIPT\n}` (D8 point 1) in `cwd`, classified by this host. */
  async invoke(script: string, opts: { stdin?: string; cwd?: string } = {}): Promise<HostOutcome> {
    const n = ++this.invocation;
    if (this.terminal) return this.typed();
    const L = this.limits;
    // (bash.invocations: charged at admission, before dispatch, a refused one included; never given back)
    this.used.invocations++;
    if (L.invocations !== null && this.used.invocations > L.invocations) {
      this.limitHit("invocations");
      return this.typed();
    }
    // (bash.source_bytes: the script's UTF-8, before it is sent.  It bounds only this script: a file it sources is a
    // read, bounded by bash.read_bytes (typed); just-bash's maxSourceBytes doesn't check `source` or `.`)
    if (utf8(script) > L.source_bytes!) {
      this.limitHit("source_bytes");
      return this.typed();
    }
    // (bash.script_ms: the run's remaining time; none left, nothing more is admitted)
    const remainingMs = L.script_ms === null ? Number.POSITIVE_INFINITY : L.script_ms - this.used.script_ms;
    if (remainingMs <= 0) {
      this.limitHit("script_ms");
      return this.typed();
    }
    const allowance = L.output_bytes! - this.used.output_bytes;
    const ctl = (this.stopping = new AbortController());
    const grace = new Promise<null>((res) => (this.onGrace = () => res(null)));
    let o: ShellOutcome | null = null;
    // (script_ms, r2 (astra2 R2): ONE debit, from dispatch through finalization (the queue's last answer and the
    // pending commits of ordinary()), and the watchdog armed for all of it; debited once, on every path)
    let watchdog: ReturnType<typeof setTimeout> | null = null, t0: number | null = null;
    const debit = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
      if (t0 !== null) this.used.script_ms += performance.now() - t0;
      t0 = null;
    };
    try {
      let shell: Shell | null;
      try {
        // (the start is part of the invocation: a Stop during it arms the same grace)
        shell = await Promise.race([this.host.shellFor(), grace]);
      } catch (err) {
        this.latch({ row: 2, reason: err instanceof ShellUnavailableError ? err.reason : why(err) });
        return this.typed();
      }
      if (this.terminal || !shell) {
        // (stopped while starting: nothing is dispatched, and the worker that started for it is ended)
        this.host.endShell("stopped while it started");
        return this.typed();
      }
      // (script_ms's watchdog: the worker ended at the remaining time + 1 s, whatever just-bash does by then)
      watchdog = Number.isFinite(remainingMs)
        ? setTimeout(() => {
            this.watchdogFired++;
            this.limitHit("script_ms");
            this.host.endShell("its script_ms ran out");
          }, Math.ceil(remainingMs) + WATCHDOG_SLACK_MS)
        : null;
      t0 = performance.now();
      const started = t0, budget = remainingMs;
      this.overTime = () => performance.now() - started >= budget;
      try {
        o = await shell.exec(wrap(script), {
          stdin: opts.stdin, cwd: opts.cwd ?? "/", run: this.id, signal: ctl.signal, onRequest: (r) => this.admit(n, r),
          // (just-bash takes a safe integer or +Infinity.  Rounded up, plus its clock's 1 ms grain: when just-bash's own
          // deadline ends the invocation, the page's clock, which started first, has passed the remaining time too)
          limits: { maxExecutionTimeMs: Number.isFinite(remainingMs) ? Math.ceil(remainingMs) + 1 : remainingMs }, allowance,
        });
      } catch (err) {
        // (the worker was lost, or ended by Stop's grace or the watchdog: row 2 unless something came first)
        this.latch({ row: 2, reason: err instanceof ShellUnavailableError ? err.reason : why(err) });
      }
      this.cut = false;
      if (o) this.observe(o, allowance);
      this.deadlineHit();
      const out = await this.decide(n, o);
      if (this.cut && out.kind === "exit") out.truncated = true;
      // (the invocation has ended, its pending commits included: its time debited; reaching the run's time is typed)
      debit();
      if (L.script_ms !== null && this.used.script_ms >= L.script_ms) {
        this.limitHit("script_ms");
        return this.typed();
      }
      return out;
    } finally {
      this.overTime = () => false;
      debit();
      // (the lifecycle ends with the outcome: finalization above ran inside it, Stop and its grace included)
      this.stopping = null;
      this.onGrace = null;
      if (this.stopTimer) clearTimeout(this.stopTimer);
      this.stopTimer = null;
      // (F9: the invocation ends clean; nothing pending or observed carries into the next)
      this.pending.clear();
      this.obs.clear();
    }
  }

  // The outcome of a dispatched invocation, its finalization included (D8 point 5's rows, then an ordinary end).
  private async decide(n: number, o: ShellOutcome | null): Promise<HostOutcome> {
    // (everything admitted has finished before the outcome is decided: the last request's answer may still be in the queue)
    await this.queue.catch(() => {});
    this.deadlineHit();
    // (D8 point 5: the host's facts first; the shell's status never decides a typed outcome)
    if (this.terminal) return this.typed();
    if (o && "limit" in o) return this.typed();
    if (o && "rejected" in o) {
      const r = o.rejected.refusal;
      // (provenance: only a refusal this host recorded for this very invocation; never inferred from what came last)
      if (r === null || this.refusals.get(r) !== n) {
        this.latch({ row: 5, reason: `internal error: the shell's run failed (${o.rejected.message.slice(0, 200)})` });
        return this.typed();
      }
      return await this.ordinary({ code: 1, stdout: "", stderr: o.rejected.message.endsWith("\n") ? o.rejected.message : o.rejected.message + "\n" });
    }
    return await this.ordinary(o!.exit);
  }

  // What the module says of a result (host level 3): a typed limit of its own (only bash.pipeline_width, at its
  // configured value), or its output count, checked against what arrived and charged (ruling C).  Anything else
  // is a broken protocol (row 5).
  private observe(o: ShellOutcome, allowance: number) {
    if ("limit" in o) {
      if (o.limit.key === "pipeline_width" && o.limit.value === this.limits.pipeline_width) this.limitHit("pipeline_width");
      else this.latch({ row: 5, reason: `internal error: the shell reported a limit it doesn't enforce (${JSON.stringify(o.limit).slice(0, 100)})` });
      return;
    }
    const c = o.output;
    // (the length bound only: a UTF-16 unit is 1 to 3 UTF-8 bytes; the exact count is the module's, in the worker.
    // The cap is the allowance and the fixed backstop both (r2, astra5 B3-A5-2), and the two flags must agree with it)
    const units = "exit" in o ? o.exit.stdout.length + o.exit.stderr.length : o.rejected.message.length;
    const cap = Math.min(allowance, OUTPUT_BACKSTOP);
    if (!c || c.deliveredBytes > cap || c.deliveredBytes < units || c.deliveredBytes > 3 * units || c.exceeded !== c.producedBytes > allowance || c.truncated !== (!c.exceeded && c.producedBytes > cap)) {
      this.latch({ row: 5, reason: `internal error: the shell's output count doesn't hold (${JSON.stringify(c ?? null)}, ${units} units, allowance ${allowance})` });
      return;
    }
    this.used.output_bytes += c.deliveredBytes;
    if (c.exceeded) this.limitHit("output_bytes");
    this.cut = c.truncated;
  }
  // (the last result was an ordinary one cut at the backstop: its outcome says so, never typed)
  private cut = false;
  // (r3, astra2: the run's time observed apart from its one debit: true once dispatch-to-now reaches the remaining
  // script_ms; checked when the shell's result comes, after the queue's last answer, and before each pending commit,
  // so a run out of time commits nothing more.  A verb already admitted finishes, D8's one allowance)
  private overTime: () => boolean = () => false;
  private deadlineHit(): boolean {
    if (this.terminal || !this.overTime()) return false;
    this.limitHit("script_ms");
    return true;
  }

  private typed(): HostOutcome {
    // (pending truncations and creations are dropped, unflushed: rule 7)
    this.pending.clear();
    const t = this.terminal!, ops = [...this.ops];
    if (t.row === 1) return { kind: "interrupted", row: 1, ops };
    if (t.row === 4) return { kind: "limit", row: 4, key: t.key, value: t.value, code: LIMIT_EXIT, stderr: limitWords(t.key, t.value), ops };
    return { kind: "unavailable", row: t.row, reason: t.reason, ops };
  }

  // An ordinary end (row 6): what is pending committed (D8 point 4), each commit one fenced verb, then the
  // shell's final status.  A pending commit refused now (changed elsewhere meanwhile) is said on stderr,
  // makes a 0 status 1, and is retired, not tried again.  A latch during it (Stop, revocation, a fault) makes
  // the outcome typed, with only what was already admitted committed.
  private async ordinary(r: { code: number; stdout: string; stderr: string }): Promise<HostOutcome> {
    let { code, stderr } = r;
    for (const p of [...this.pending.keys()].sort()) {
      if (this.terminal || this.deadlineHit()) return this.typed();
      try {
        await this.commit(p, EMPTY);
      } catch (err) {
        if (err instanceof Fenced) return this.typed();
        if (err instanceof LimitHit) {
          this.limitHit(err.key);
          return this.typed();
        }
        if (err instanceof Revoked) {
          this.latch({ row: 3, reason: "access was revoked" });
          return this.typed();
        }
        const ref = refusalOf(err, p);
        if (!ref) {
          this.latch({ row: 5, reason: `internal error: ${why(err)}` });
          return this.typed();
        }
        stderr += `bash: ${ref.message}\n`;
        if (code === 0) code = 1;
      }
    }
    if (this.terminal) return this.typed();
    return { kind: "exit", code, stdout: r.stdout, stderr, ops: [...this.ops] };
  }

  // Each request in turn: at most one at a time, so after a latch at most the one workspace verb already
  // admitted finishes, and the rest are refused without workspace work.
  private admit(n: number, r: FsRequest): Promise<FsAnswer> {
    const next = this.queue.then(() => this.answer(n, r));
    this.queue = next.catch(() => {});
    return next;
  }

  private async answer(n: number, { op, args }: FsRequest): Promise<FsAnswer> {
    if (this.terminal || n !== this.invocation) return { err: { code: "EBADF", message: "this run has ended" } };
    const p = typeof args[0] === "string" ? args[0] : "";
    try {
      return { ok: await this.verb(op, args) };
    } catch (err) {
      if (err instanceof Fenced) return { err: { code: "EBADF", message: "this run has ended" } };
      if (err instanceof LimitHit) {
        // (row 4: latched before the answer goes back; nothing of the verb was done)
        this.limitHit(err.key);
        return { err: { code: "EDQUOT", message: `bash.${err.key} exceeded` } };
      }
      if (err instanceof Revoked) {
        // (row 3: latched before the answer goes back; the refusal is EACCES, but not an ordinary one)
        this.latch({ row: 3, reason: "access was revoked" });
        return { err: { code: "EACCES", message: `${p}: access was revoked` } };
      }
      const ref = refusalOf(err, p);
      if (!ref) {
        // (row 5: a failure, not a refusal; latched before the answer goes back)
        this.latch({ row: 5, reason: `internal error: ${why(err)}` });
        return { err: { code: "EIO", message: `${p}: internal error` } };
      }
      const id = hex(8);
      this.refusals.set(id, n);
      return { err: { code: ref.code, message: ref.message, refusal: id } };
    }
  }

  // ---------------------------------------------------------------- the verbs (r3 §3.1)

  private get ws(): Workspace {
    return this.host.workspaceFor(this.principal);
  }
  // (the canonical path, §2.2 step 3: the workspace's own rules; Trash is the workspace's, never the shell's)
  private canon(p: unknown): string {
    const q = normPath(p);
    if (within(q, TRASH) && q !== "/") throw refuse("EACCES", q, "Trash is the workspace's: restore or empty it in the file browser");
    return q;
  }
  /**
   * The check at use, for every workspace verb this host calls (§2.2 steps 4–6), asked by the workspace holding
   * its lock, before anything changes: the fence first (the linearization point: latched, nothing more
   * happens), then the grant's liveness, coverage by folder fid, write for a mutation, and the kinds a shell
   * may change (data files, folders: never writes into a notebook or board, never copies one).
   */
  private readonly check = (c: AdmitCheck): void => {
    // (r3: out of time is the fence too, at the verb's own admission, inside its locked section)
    if (this.terminal || this.deadlineHit()) throw new Fenced();
    const pr = this.principal;
    if (pr.kind === "grant") {
      if (pr.live() !== "ok") throw new Revoked();
      const covered = c.chain.some((e) => !!e.fid && pr.folders.has(e.fid)) || (c.entry?.kind === "folder" && !!c.entry.fid && pr.folders.has(c.entry.fid));
      if (!covered) throw new ScopeRefusal(`${c.path}: Permission denied (outside this shell's access)`);
      if (MUTATES(c) && !pr.write) throw refuse("EROFS", c.path, "Read-only file system (this shell may only read)");
    }
    if (c.op === "write" && c.entry && c.entry.kind !== "file") throw refuse("EACCES", c.path, "a notebook or board: edit it in its editor");
    if (c.op === "duplicate" && c.role === "source" && c.entry && c.entry.kind === "folder") throw refuse("EISDIR", c.path);
    if (c.op === "duplicate" && c.role === "source" && c.entry && c.entry.kind !== "file" && c.entry.kind !== "folder") throw refuse("EACCES", c.path, "a notebook or board: copy it in the file browser");
  };
  /**
   * The check at use with the charge of one mutating transaction (r8c E2, A1): `ops` by 1 and `written_bytes` by its
   * bytes, at the transaction's own admit (a target's, or a rename's or duplicate's destination), inside the verb's
   * locked section, before anything changes, once; refused (LimitHit) past either key.  A duplicate's bytes are its
   * source's size, from the source's admit.  Never refunded, whatever the verb does after.  `snapshot` (cp -r's walk,
   * r2, daybreak3 BASH3-D3-1): the source must still be the entry the preflight measured, by identity and rev, at its
   * own admit under the lock; one changed since (grown, replaced) is refused, so no byte beyond the reservation is
   * copied.
   */
  private charging(bytes: number | "source", snapshot?: Entry): (c: AdmitCheck) => void {
    let charged = false, size = 0;
    return (c) => {
      this.check(c);
      if (c.op === "duplicate" && c.role === "source") {
        if (snapshot && (!c.entry || c.entry.fid !== snapshot.fid || (c.entry.rev ?? 0) !== (snapshot.rev ?? 0) || (c.entry.size ?? 0) !== (snapshot.size ?? 0)))
          throw refuse("ECONFLICT", c.path, "changed during the copy (it is no longer what was measured)");
        size = c.entry?.size ?? 0;
      }
      if (charged || !MUTATES(c) || !(c.role === "target" || c.role === "destination")) return;
      charged = true;
      this.charge(1, bytes === "source" ? size : bytes);
    };
  }
  private charge(ops: number, bytes: number) {
    const L = this.limits;
    if (this.used.ops + ops > L.ops!) throw new LimitHit("ops");
    if (this.used.written_bytes + bytes > L.written_bytes!) throw new LimitHit("written_bytes");
    this.used.ops += ops;
    this.used.written_bytes += bytes;
  }
  // (the cp -r preflight's room: the workspace's own limits for `n` more entries, b's folder getting one; refused as
  // the workspace refuses, ENOSPC, nothing copied.  A copy can still stop partway for a reason outside the shell)
  private async room(b: string, n: number) {
    const lim = this.ws.limits;
    if ((await this.ws.entryCount()) + n > lim.maxEntries) throw new Refusal("ENOSPC", `${b}: the workspace would hold more than ${lim.maxEntries} entries`);
    const up = parentOf(b);
    if ((await this.ws.list(up, { admit: () => this.gate() })).length + 1 > lim.maxFolderEntries) throw new Refusal("ENOSPC", `${b}: ${up} would hold more than ${lim.maxFolderEntries} entries`);
  }
  // (bash.read_bytes: a read over it is a limit, not an errno)
  private async readCapped(p: string) {
    try {
      return await this.ws.readUpTo(p, this.host.readBytes, { admit: this.check });
    } catch (err) {
      if (err instanceof WorkspaceError && err.code === "limit" && /larger than/.test(err.message)) throw new LimitHit("read_bytes");
      throw err;
    }
  }
  /** The fence and the grant's liveness, for an answer that calls no workspace verb (the top, what is pending). */
  private gate() {
    if (this.terminal) throw new Fenced();
    if (this.principal.kind === "grant" && this.principal.live() !== "ok") throw new Revoked();
  }
  // (§2.2 steps 5–6: a mutation needs write, refused before any verb; and again at use, in check)
  private mutating(p: string) {
    this.gate();
    if (this.principal.kind === "grant" && !this.principal.write) throw refuse("EROFS", p, "Read-only file system (this shell may only read)");
  }
  private record(o: OpRecord) {
    this.ops.push(o);
  }

  private async verb(op: string, args: unknown[]): Promise<unknown> {
    switch (op) {
      case "read": return this.read(this.canon(args[0]));
      case "exists": return this.exists(this.canon(args[0]));
      case "stat": return this.statOf(this.canon(args[0]));
      case "list": return this.list(this.canon(args[0]));
      case "write": return this.write(this.canon(args[0]), bytes(args[1]));
      case "append": return this.append(this.canon(args[0]), bytes(args[1]));
      case "mkdir": return this.mkdir(this.canon(args[0]), args[1] === true);
      case "create": return this.createEmpty(this.canon(args[0]));
      case "rm": return this.rm(this.canon(args[0]), args[1] === true, args[2] === true);
      case "mv": return this.mv(this.canon(args[0]), this.canon(args[1]));
      case "cp": return this.cp(this.canon(args[0]), this.canon(args[1]), args[2] === true);
    }
    throw new Refusal("ENOTSUP", `${String(args[0] ?? "")}: ${op} isn't supported`);
  }

  private async read(p: string): Promise<Uint8Array> {
    this.gate();
    if (p === "/") throw refuse("EISDIR", p);
    if (this.pending.has(p)) return EMPTY;
    const e = await this.ws.stat(p, { admit: this.check });
    if (!e) throw refuse("ENOENT", p);
    if (e.kind === "folder") throw refuse("EISDIR", p);
    if (e.kind === "file") return (await this.readCapped(p)).content;
    // (a notebook or board reads as its JSON text: admitted, entry and content in one locked read (F10), and
    // serialized only up to the cap, so one over it is refused before its whole text exists)
    const r = await this.ws.read(p, { admit: this.check });
    if (r.entry.kind === "folder") throw refuse("EISDIR", p);
    if (r.entry.kind === "file") return (await this.readCapped(p)).content;
    try {
      return boundedJson(r.content, this.host.readBytes);
    } catch (err) {
      if (err instanceof TooLarge) throw new LimitHit("read_bytes");
      throw err;
    }
  }
  private async exists(p: string): Promise<boolean> {
    this.gate();
    // (the top is always there; no grant names it, and saying so tells nothing)
    if (p === "/" || this.pending.has(p)) return true;
    try {
      return !!(await this.ws.stat(p, { admit: this.check }));
    } catch (err) {
      // (outside the grant is "not there" to a probe: nothing told, nothing refused)
      if (err instanceof ScopeRefusal) return false;
      throw err;
    }
  }
  // (`identity`: the entry's own (a data file's or folder's fid, a document's ref), which just-bash's mv and cp
  // compare to tell whether two paths are one file)
  private async statOf(p: string): Promise<{ kind: string; size: number; mtime: number; identity: string }> {
    this.gate();
    if (p === "/") return { kind: "folder", size: 0, mtime: 0, identity: "top" };
    if (this.pending.has(p)) return { kind: "file", size: 0, mtime: Date.now(), identity: "pending:" + p };
    const e = await this.ws.stat(p, { admit: this.check });
    if (!e) throw refuse("ENOENT", p);
    return { kind: e.kind === "folder" ? "folder" : "file", size: e.size ?? 0, mtime: e.updated, identity: identOf(e) ?? "path:" + e.path };
  }
  private async list(p: string): Promise<{ name: string; kind: string }[]> {
    this.gate();
    const e = p === "/" ? undefined : await this.ws.stat(p, { admit: this.check });
    if (p !== "/" && !e) throw refuse("ENOENT", p);
    if (e && e.kind !== "folder") throw refuse("ENOTDIR", p);
    // (the top itself, which no grant names, may be listed: what it shows is only what the grant covers)
    const top = (c: AdmitCheck) => (c.role === "target" && c.path === "/" ? this.gate() : this.check(c));
    const out = (await this.ws.list(p, { admit: top })).map((x) => ({ name: nameOf(x.path), kind: x.kind === "folder" ? "folder" : "file" }));
    const have = new Set(out.map((x) => x.name));
    for (const q of this.pending.keys()) if (parentOf(q) === p && !have.has(nameOf(q))) out.push({ name: nameOf(q), kind: "file" });
    // (bash.list_entries: a listing longer than it is a limit)
    if (out.length > this.limits.list_entries!) throw new LimitHit("list_entries");
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // The target of a redirection's open, observed (§3.2): a data file's (fid, rev), absent, or refused.
  private async target(p: string, withBytes: boolean): Promise<Obs | null> {
    if (p === "/") throw refuse("EISDIR", p);
    const e = await this.ws.stat(p, { admit: this.check });
    if (e && e.kind === "folder") throw refuse("EISDIR", p);
    if (e && e.kind !== "file") throw refuse("EACCES", p, "a notebook or board: edit it in its editor");
    if (!e) {
      const up = parentOf(p), f = up === "/" ? null : await this.ws.stat(up, { admit: this.check });
      if (up !== "/" && !f) throw refuse("ENOENT", p);
      if (f && f.kind !== "folder") throw refuse("ENOTDIR", p);
      return null;
    }
    if (!withBytes) return { fid: e.fid!, rev: e.rev ?? 0 };
    // (`>>`: the entry and its bytes from one readUpTo, never a stat and then a separate read)
    // (and it must be the file just stated: changed between the two, it is a conflict, never a mixed observation)
    const r = await this.readCapped(p);
    if (r.entry.fid !== e.fid || (r.entry.rev ?? 0) !== (e.rev ?? 0)) throw refuse("ECONFLICT", p);
    return { fid: r.entry.fid!, rev: r.entry.rev ?? 0, bytes: r.content };
  }
  private hold(p: string, kind: "trunc" | "create") {
    if (!this.pending.has(p) && this.pending.size >= MAX_PENDING) throw refuse("EMFILE", p, `more than ${MAX_PENDING} redirections are pending in this run`);
    this.pending.set(p, kind);
  }
  // One commit of `b` as `p`'s whole contents, on its observation (rules 3, 4): a write with (base, fid), or an
  // exclusive create for a pending creation; the observation is then the commit's.  Write and kind are checked
  // again at the commit, in check (permissions at use, not carried from the open).
  private async commit(p: string, b: Uint8Array) {
    try {
      await this.commitNow(p, b);
    } catch (err) {
      // (a refused or failed commit is retired with its observation: never tried again, at the end or later)
      this.pending.delete(p);
      this.obs.delete(p);
      throw err;
    }
  }
  private async commitNow(p: string, b: Uint8Array) {
    // (bash.write_bytes: one commit's whole content, before any verb)
    if (b.length > this.limits.write_bytes!) throw new LimitHit("write_bytes");
    const pend = this.pending.get(p), o = this.obs.get(p);
    if (pend === "create" || (!o && pend === undefined)) {
      let e: Entry;
      try {
        e = await this.ws.create(p, { content: b, admit: this.charging(b.length) });
      } catch (err) {
        // (someone else made it meanwhile: of two creators exactly one wins, the newcomer untouched)
        if (err instanceof WorkspaceError && err.code === "exists") throw refuse("ECONFLICT", p);
        throw err;
      }
      this.pending.delete(p);
      this.obs.set(p, { fid: e.fid!, rev: e.rev ?? 0, bytes: b });
      this.record({ verb: "create", path: p, rev: e.rev ?? 0, committed: "local" });
      return;
    }
    if (!o) throw new Error(`${p}: a commit without its observation`);
    let out: { entry: Entry; rev: number };
    try {
      out = await this.ws.write(p, b, { base: o.rev, fid: o.fid, keepEmpty: false, admit: this.charging(b.length) });
    } catch (err) {
      if (err instanceof WorkspaceError && err.code === "missing") throw refuse("ECONFLICT", p);
      throw err;
    }
    this.pending.delete(p);
    this.obs.set(p, { fid: out.entry.fid!, rev: out.rev, bytes: b });
    this.record({ verb: "write", path: p, rev: out.rev, committed: "local" });
  }
  // What is pending at `p` (or under it) committed now: before another mutation of it (rule 1).
  private async flush(p: string) {
    for (const q of [...this.pending.keys()].sort()) if (within(q, p)) await this.commit(q, EMPTY);
  }

  private async write(p: string, b: Uint8Array) {
    this.mutating(p);
    if (b.length === 0) {
      // (rules 1 and 2: the open of `>`; an observation this invocation already holds is kept, never re-made)
      if (this.pending.has(p)) return;
      if (!this.obs.has(p)) {
        const o = await this.target(p, false);
        if (o) this.obs.set(p, o);
        return this.hold(p, o ? "trunc" : "create");
      }
      return this.hold(p, "trunc");
    }
    if (!this.pending.has(p) && !this.obs.has(p)) {
      const o = await this.target(p, false);
      if (o) this.obs.set(p, o);
    }
    await this.commit(p, b);
  }
  private async append(p: string, b: Uint8Array) {
    this.mutating(p);
    if (b.length === 0) {
      // (rules 2 and 5: the open of `>>`; the observation, with the bytes, taken once)
      if (this.pending.has(p) || this.obs.get(p)?.bytes) return;
      const o = await this.target(p, true);
      if (o) this.obs.set(p, o);
      else this.hold(p, "create");
      return;
    }
    if (this.pending.has(p)) return this.commit(p, b);
    let o = this.obs.get(p);
    if (!o?.bytes) {
      const t = await this.target(p, true);
      if (!t) {
        this.hold(p, "create");
        return this.commit(p, b);
      }
      this.obs.set(p, (o = t));
    }
    await this.commit(p, concat(o.bytes!, b));
  }
  private async mkdir(p: string, recursive: boolean) {
    this.mutating(p);
    const e = await this.ws.stat(p, { admit: this.check });
    if (e && (!recursive || e.kind !== "folder")) throw refuse("EEXIST", p);
    if (e) return;
    if (!recursive) {
      const up = parentOf(p), f = up === "/" ? null : await this.ws.stat(up, { admit: this.check });
      if (up !== "/" && !f) throw refuse("ENOENT", p);
      if (f && f.kind !== "folder") throw refuse("ENOTDIR", p);
    }
    await this.ws.mkdir(p, { admit: this.charging(0) });
    this.record({ verb: "mkdir", path: p, committed: "local" });
  }
  private async createEmpty(p: string) {
    this.mutating(p);
    if (this.pending.has(p)) throw refuse("EEXIST", p);
    await this.ws.create(p, { content: EMPTY, admit: this.charging(0) });
    this.record({ verb: "create", path: p, rev: 0, committed: "local" });
  }
  private forget(p: string) {
    for (const q of [...this.obs.keys()]) if (within(q, p)) this.obs.delete(q);
  }
  private async rm(p: string, recursive: boolean, force: boolean) {
    this.mutating(p);
    if (p === "/") throw refuse("EACCES", p, "the top folder can't be removed");
    await this.flush(p);
    const e = await this.ws.stat(p, { admit: this.check });
    if (!e) {
      if (force) return;
      throw refuse("ENOENT", p);
    }
    if (e.kind === "folder" && !recursive) throw refuse("EISDIR", p);
    // (always to Trash, everything in it, as one op; a large folder's rewrite settled before the next request: §3.4)
    await this.ws.remove(p, expectOf(e), undefined, { admit: this.charging(0) });
    await this.ws.rewriteSettled();
    this.forget(p);
    this.record({ verb: "remove", path: p, committed: "local" });
  }
  private async mv(a: string, b: string) {
    this.mutating(a);
    await this.flush(a);
    const e = await this.ws.stat(a, { admit: this.check });
    if (!e) throw refuse("ENOENT", a);
    if (await this.ws.stat(b, { admit: this.check })) throw refuse("EEXIST", b);
    await this.ws.rename(a, b, { expect: expectOf(e), admit: this.charging(0) });
    await this.ws.rewriteSettled();
    this.forget(a);
    this.record({ verb: "rename", path: a, to: b, committed: "local" });
  }
  // cp (§3.4): a data file, one duplicate; a folder (-r), walked first under admit, every descendant
  // admitted, or nothing is copied; then exactly F + D ops, each a fenced verb of its own.  Documents are
  // copied in the file browser: a folder holding one copies nothing (F11), and each duplicate's own admit
  // checks the kind again, so a source replaced by a document after the walk isn't copied either.
  private async cp(a: string, b: string, recursive: boolean) {
    this.mutating(b);
    await this.flush(a);
    const e = await this.ws.stat(a, { admit: this.check });
    if (!e) throw refuse("ENOENT", a);
    if (await this.ws.stat(b, { admit: this.check })) throw refuse("EEXIST", b);
    if (e.kind !== "folder") {
      if (e.kind !== "file") throw refuse("EACCES", a, "a notebook or board: copy it in the file browser");
      await this.ws.duplicate(a, b, { admit: this.charging("source") });
      this.record({ verb: "duplicate", path: a, to: b, committed: "local" });
      return;
    }
    if (!recursive) throw refuse("EISDIR", a);
    // (the walk: an entry outside the grant is noted, and refuses the whole copy; a revocation or a fault in
    // the walk is the walk's error, never a shorter tree)
    let refused: ScopeRefusal | null = null;
    const walk = (c: AdmitCheck) => {
      try {
        this.check(c);
      } catch (err) {
        if (err instanceof ScopeRefusal) refused ??= err;
        throw err;
      }
    };
    const all = await this.ws.list(a, { recursive: true, admit: walk });
    if (refused) throw refused;
    const doc = all.find((x) => x.kind !== "file" && x.kind !== "folder");
    if (doc) throw refuse("EACCES", doc.path, "a notebook or board: copy it in the file browser");
    // (the limit-dependent preflight, r3 §3.4 and r8c E2 item 5, before the first mutation; refused, nothing copied:
    // F + D <= bash.cp_entries, bytes <= bash.cp_bytes, F + D <= the remaining ops, bytes <= the remaining
    // written_bytes, and the workspace's room for F + D more entries, b's folder's included.  cp_entries and cp_bytes
    // are then reserved, never given back; each mkdir and duplicate also charges ops and written_bytes at its admit)
    const F = all.filter((x) => x.kind === "file").length, D = all.length - F + 1;
    const bytes = all.reduce((t, x) => t + (x.kind === "file" ? (x.size ?? 0) : 0), 0);
    const L = this.limits;
    if (this.used.cp_entries + F + D > L.cp_entries!) throw new LimitHit("cp_entries");
    if (this.used.cp_bytes + bytes > L.cp_bytes!) throw new LimitHit("cp_bytes");
    if (this.used.ops + F + D > L.ops!) throw new LimitHit("ops");
    if (this.used.written_bytes + bytes > L.written_bytes!) throw new LimitHit("written_bytes");
    await this.room(b, F + D);
    this.used.cp_entries += F + D;
    this.used.cp_bytes += bytes;
    const to = (q: string) => b + q.slice(a.length);
    await this.ws.mkdir(b, { admit: this.charging(0) });
    this.record({ verb: "mkdir", path: b, committed: "local" });
    for (const x of all.sort((u, v) => (u.path < v.path ? -1 : 1))) {
      if (x.kind === "folder") {
        await this.ws.mkdir(to(x.path), { admit: this.charging(0) });
        this.record({ verb: "mkdir", path: to(x.path), committed: "local" });
      } else {
        await this.ws.duplicate(x.path, to(x.path), { admit: this.charging("source", x) });
        this.record({ verb: "duplicate", path: x.path, to: to(x.path), committed: "local" });
      }
    }
  }
}

function bytes(x: unknown): Uint8Array {
  if (x instanceof Uint8Array) return x;
  throw new Refusal("EINVAL", "a write's content is bytes");
}

/**
 * The page's shell host: one shell worker (from `start`, again after it is lost or ended by Stop), and the
 * workspace, which it never hands to the worker.  `run(principal)` opens a run; `exec` is one run of one
 * invocation (a panel line, a %%bash cell, a verb call).
 */
export class ShellHost {
  private shell: Shell | null = null;
  private starting: Promise<Shell> | null = null;
  // (the current start's own cancellation: one per start, shared by the runs waiting on it, aborted by endShell)
  private startCtl: AbortController | null = null;
  // (a started shell taking its init: endShell ends it too, so an init that never answers can't leave a worker)
  private configuring: Shell | null = null;
  private views = new Map<string, Workspace>();
  /** the config, validated when the host is made (r3 §4.1): every key resolved */
  readonly limits: BashLimits;
  /** the bytes one read may return: bash.read_bytes (`opts.readBytes`, the tests' smaller cap, overrides it) */
  readonly readBytes: number;
  /** the limits the current worker's just-bash resolved at its init (the census: web/shell/limits.ts) */
  resolved: Readonly<Record<string, number>> | null = null;
  /** why each worker was ended by the host (Stop's grace, the watchdog), the last 100: the tests' record (G1) */
  readonly endings: string[] = [];

  /**
   * `start(signal)` starts a shell worker (startShell(S, at, { signal })); an abort of `signal` must end what
   * it has started (its fetches, its worker), ready or not (CORR-BASH-S2-R2-1).  `opts.bash`: the `bash` config
   * (deployment config, a course policy record, a grading or shared-compute host; never a document, URL or user
   * code), validated here, before any worker starts: a BashConfigError names its key.
   */
  constructor(private ws: Workspace, private start: (signal: AbortSignal) => Promise<Shell>, opts: { readBytes?: number; bash?: unknown } = {}) {
    this.limits = validateBash(opts.bash);
    this.readBytes = opts.readBytes ?? this.limits.read_bytes!;
  }

  /**
   * The shell, started (again) if there is none or it has closed.  Only a shell whose verified package
   * reaches files through this mediator is used (F12): an older one is ended and refused, never run on its
   * own in-memory files in the workspace's name.  Each start has its own signal: endShell (Stop's grace) aborts
   * it, so a start that never gets ready is ended (its fetch or its worker), and a start that comes anyway is
   * ended when it comes and never installed.  Runs that wait at once share one start; a later start is another,
   * with its own signal, which no earlier abort reaches.
   */
  shellFor(): Promise<Shell> {
    if (this.shell && this.shell.state === "open") return Promise.resolve(this.shell);
    this.shell = null;
    if (!this.starting) {
      const ctl = new AbortController();
      let started: Promise<Shell>;
      try {
        started = Promise.resolve(this.start(ctl.signal));
      } catch (err) {
        started = Promise.reject(err);
      }
      const p: Promise<Shell> = started.then(
        async (s) => {
          if (this.starting !== p) {
            s.terminate();
            throw new ShellUnavailableError("its start was abandoned");
          }
          // (a shell that can't take the limits would run with just-bash's own: refused, as an older one is)
          if (!(s.hostReq >= CONFIGURED_LEVEL)) {
            this.starting = this.startCtl = null;
            s.terminate();
            throw new ShellUnavailableError("this document's package set has an older shell; update the set");
          }
          // (the worker's one init, before anything is dispatched: r3 §4.1)
          let resolved: Record<string, number>;
          this.configuring = s;
          try {
            resolved = await s.configure({ limits: executionLimitsOf(this.limits), pipelineWidth: this.limits.pipeline_width! });
          } catch (err) {
            s.terminate();
            if (this.starting === p) this.starting = this.startCtl = null;
            throw err instanceof ShellUnavailableError ? err : new ShellUnavailableError(`its limits were refused: ${why(err)}`);
          } finally {
            if (this.configuring === s) this.configuring = null;
          }
          if (this.starting !== p) {
            s.terminate();
            throw new ShellUnavailableError("its start was abandoned");
          }
          this.starting = this.startCtl = null;
          this.resolved = Object.freeze(resolved);
          this.shell = s;
          return s;
        },
        (err) => {
          if (this.starting === p) this.starting = this.startCtl = null;
          throw err;
        },
      );
      this.starting = p;
      this.startCtl = ctl;
    }
    return this.starting;
  }
  /** Ends the shell worker, or cancels its start (Stop's grace, r3 §4.3): what it was running fails, and the next run starts a fresh one. */
  endShell(why: string) {
    this.endings.push(why);
    if (this.endings.length > 100) this.endings.shift();
    this.shell?.terminate();
    this.shell = null;
    this.configuring?.terminate();
    this.configuring = null;
    this.starting = null;
    this.startCtl?.abort(new ShellUnavailableError(`its start was cancelled: ${why}`));
    this.startCtl = null;
  }
  /** The workspace as the principal changes it: its actor in the op log (r3 §2.1); never handed out. */
  workspaceFor(p: Principal): Workspace {
    if (p.kind === "person" || p.actor === "person") return this.ws;
    let v = this.views.get(p.actor);
    if (!v) {
      if (!ACTOR.test(p.actor)) throw new TypeError("an actor is agent:<name>");
      v = Object.create(this.ws) as Workspace;
      v.actor = p.actor;
      this.views.set(p.actor, v);
    }
    return v;
  }
  /** A run of the principal's; a grant without a valid actor is refused here, before any work. */
  run(principal: Principal): ShellRun {
    return new ShellRun(this, principal);
  }
  /** One run of one invocation; `signal` is Stop. */
  async exec(principal: Principal, script: string, opts: { stdin?: string; cwd?: string; signal?: AbortSignal } = {}): Promise<HostOutcome> {
    const r = this.run(principal);
    const onAbort = () => r.stop();
    if (opts.signal?.aborted) r.stop();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await r.invoke(script, opts);
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}
