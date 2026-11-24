// `LtiContentGate` (plan-lti-r5 amendment 3 r15 §2.5): one SQLite-backed
// Durable Object per environment, outside every D1, so no D1 restore changes
// it.  It is the only writer of LtiContent's fenced tables (bundles,
// assignments, assignment_revisions, the instructor's pin updates, the scan,
// sweep and lease rows): a ticket's batch runs here, on the gate's own
// binding, after the chain insert that makes it commit only as the exact
// successor of the previous call (CORR-LTI5A3-3).  One call is in flight at a
// time; an uncertain one is resolved by a tombstone, never aged out.
//
// Tickets, admission, the probe, the chain and resolution (A3-1); checkpoints,
// delete intents and the restore runbook's steps (A3-2).  The wake that sweeps
// and scans is content-wake.ts; it writes only through this gate.

import { DurableObject } from "cloudflare:workers";
import type { D1, D1Result } from "./db.ts";
import { randomHex, testMode } from "./util.ts";

export type TicketKind = "upload" | "assignment" | "pin" | "wake";
export type GateMode = "normal" | "paused" | "recovering";
/** One statement of a fenced batch, as plain data (it crosses a DO call). */
export interface Stmt { sql: string; params?: unknown[] }
export type WriteResult =
  | { ok: true; results: D1Result[]; chain?: D1Result["meta"] }
  | { ok: false; status: number; code: string; committed?: boolean; message?: string };

/**
 * Each kind's worst case in calls, tombstones included (r9): an operation stops
 * at its first failed or uncertain call, whose tombstone is then its last call.
 */
export const WEIGHT: Record<TicketKind, number> = { upload: 3, assignment: 2, pin: 2, wake: 0 };
/** Lifetimes (r11/r12): ≥ 120 s, longer than any checkpoint interval; an upload's deadline + 60 s. */
export const UPLOAD_DEADLINE_MS = 10 * 60_000;
const LIFE_MS: Record<TicketKind, number> = { upload: UPLOAD_DEADLINE_MS + 60_000, assignment: 120_000, pin: 120_000, wake: 5 * 60_000 };
/** Live tickets per kind (LIMIT-LTI5A3-6): assignment writes and pin updates share 200. */
const LIVE_CAP: Record<TicketKind, number> = { upload: 100, assignment: 200, pin: 200, wake: 2 };
const STORED_CAP = 1000;
const ISSUE_CLEANUP = 20;
const ALARM_CLEANUP = 500;
/** Every call's gate-side deadline (r11): D1's maximum query duration. */
const CALL_DEADLINE_MS = 30_000;
const PROBE_CALLS = 20;
const PROBE_MAX_AGE_MS = 2 * 3600_000;
const PROBE_TAIL_MS = 1000;
const LIVE_GUARD_MS = 5000;
const PROBE_EVERY_MS = 3600_000;
/** The least R that admits (call tokens/s): a chain of ≤ 250 ms per call (S ≥ 4/s).  The environment's burst is at
 * least the heaviest ticket's weight (envCap), so a slower chain admits fewer tickets, never none of a kind. */
const R_FLOOR = 1;
/** Checkpoints (r9–r15): every 10 min; quiet gaps of 2.0–2.1 s; entry within 10 s, else postponed once by 1 min. */
const CKPT_EVERY_MS = 10 * 60_000;
const CKPT_ENTRY_MS = 10_000;
const CKPT_POSTPONE_MS = 60_000;
/** Every live ticket needs this much left at a checkpoint's start: the 74.2 s interval + 5 s queue + one 30 s call. */
const CKPT_MARGIN_MS = 110_000;
const CKPT_KEEP_MS = 30 * 86400_000;
const CKPT_CAP = 5000;
/** D4 r3: each of the checkpoint's storage transactions (the entry revocation, the margin re-check) has a 1 s budget. */
const CKPT_TXN_BUDGET_MS = 1000;
const INTENTS_MAX = 20;
const INTENT_KEYS_MAX = 1000;
const MARKER_MISSES_MAX = 3;
const D1_NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
/** A bundle incarnation's key (§2.1): `o/<owner digest>/<sha256>/<token>`. */
const KEY_RE = /^o\/[0-9a-f]{32}\/[0-9a-f]{64}\/[0-9a-f]{32}$/;
/** An unresolved call's retry, by the alarm (r15 §2.5). */
const RESOLVE_RETRY_MS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner TEXT, issued INTEGER NOT NULL, expires INTEGER NOT NULL, w INTEGER NOT NULL, calls_used INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0, recovery INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS tickets_expires ON tickets (expires);
CREATE TABLE IF NOT EXISTS calls (seq INTEGER PRIMARY KEY, instance TEXT NOT NULL, ticket TEXT, sent INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints (k INTEGER PRIMARY KEY, nonce TEXT NOT NULL, d1_time INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS checkpoints_time ON checkpoints (d1_time);
CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, keys TEXT NOT NULL, issued INTEGER NOT NULL, ticket TEXT NOT NULL, mode TEXT NOT NULL, recovery INTEGER NOT NULL);
`;

/** Tests: one deliberate timer a checkpoint awaited: requested and actual durations (real ms, monotonic), and its overshoot. */
interface TimerRec { kind: "sleep" | "deadline" | "budget"; label: string; requested_gate_ms: number; scale: number; virtual: boolean; requested_real_ms: number; sched_mono: number; fired_mono: number | null; resumed_mono: number; elapsed_real_ms: number; overshoot_real_ms: number; overshoot_gate_ms: number; sched_wall: number; sched_gate: number; resumed_gate: number; won: "timer" | "work" }
interface Ticket { id: string; kind: TicketKind; owner: string | null; issued: number; expires: number; w: number; calls_used: number; spent: number; mode: GateMode; recovery: number }
export interface Checkpoint { k: number; nonce: string; d1_time: number }
interface Bucket { tokens: number; at: number }
/**
 * Tests: answer lost after commit; never sent; delayed; held back and sent later (`late`), after resolution; or
 * `vanish`: the instance dies right after recording the call, its ticket's count kept and nothing else done.
 */
type Seam = { op: "drop_answer" | "fail_before_send" | "delay" | "late" | "vanish"; ms?: number; count: number; calls_only?: boolean; writes_only?: boolean };

/** A refused call's code, from D1's own constraint form (`D1_ERROR: <code>: SQLITE_CONSTRAINT …`), or null. */
export function abortCode(message: string): string | null {
  const t = /^D1_ERROR: ([a-z_]+): SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?$/.exec(message);
  if (t) return t[1];
  const u = /^D1_ERROR: UNIQUE constraint failed: ([a-z_]+)\.[a-z_]+(?:, [a-z_]+\.[a-z_]+)*: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_(?:UNIQUE|PRIMARYKEY)\))?$/.exec(message);
  return u ? `unique:${u[1]}` : null;
}

export class LtiContentGate extends DurableObject<{ LTI_CONTENT?: D1 }> {
  private sql: SqlStorage;
  /** This instance's id: a call record with another one's is unknown (its instance died with it outstanding). */
  private instance = randomHex(16);
  private queue: Promise<unknown> = Promise.resolve();
  private queued: number[] = [];
  /** D4 r2: a checkpoint's hold: while set, every queue item waits at the front before doing anything. */
  private hold: Promise<void> | null = null;
  /** Queue items running now (started, not parked at the hold): at most one, by the queue. */
  private active = 0;
  /** The seq this instance has in flight now (its record is not an unknown call to resolve). */
  private inflight: number | null = null;
  private buckets = new Map<string, Bucket>();
  /** The gate's own work (r15 §2.5): 1 call/s, capacity 1; resolution of unknown and uncertain calls waits on it. */
  private internal: Bucket = { tokens: 1, at: 0 };
  /** The one resolution attempt queued or in flight, shared by everyone who asks (LIMIT-PRIVATE15-A3-1-1). */
  private resolution: Promise<boolean> | null = null;
  private probing = false;
  private skew = 0;
  private deadlineMs = CALL_DEADLINE_MS;
  private seam: Seam | null = null;
  private lateBatches: ReturnType<D1["prepare"]>[][] = [];
  /** Tests: every D1 batch this instance has sent (calls, tombstones, probes). */
  private sends = 0;
  /** Tests: the tombstone attempts among them. */
  private tombstones = 0;
  /** A checkpoint's entry (issue paused, waiting to start) or interval (issue paused, the queue held). */
  private ckpt: "none" | "entering" | "interval" = "none";
  /** Tests: the gate's clock runs `scale` times real time (its sleeps and its now()). */
  private scale = 1;
  private scaleBase = 0;
  /** Tests: the next timed checkpoint transaction of this name reports an overrun of its budget. */
  private txnOverrun: string | null = null;
  private testRelease: (() => void) | null = null;
  /** Tests: the next n resolutions' final reads never answer. */
  private parkReads = 0;
  /** Tests: a real-clock wait between a resolution's budget and its tombstone's send (it moves no gate clock). */
  private resolveGapRealMs = 0;
  /** Tests: every mode change, with its caller. */
  private modeLog: { v: string; at: number; by: string }[] = [];
  /** Tests: a virtual gate clock: now() stands still, and each sleep advances it by exactly its length. */
  private virtual: number | null = null;
  /** Tests: one queue item counted as in flight that never finishes, until released. */
  private stuck = false;
  /**
   * Tests: during checkpointNow(), each deliberate timer the checkpoint itself awaits (its sleeps, its own call's deadline,
   * its tombstone's and read's shared budget), as it ran, and the phase marks: the scaled-clock lateness instrumentation
   * (#18, astra3's and daybreak3's timing rulings). Null outside a checkpoint and outside test mode.
   */
  private timerLog: TimerRec[] | null = null;
  /** Tests: a fixed requested gap length (gate ms) in place of 2000 + random(100), for the ×10 bound case only. */
  private gapMs: number | null = null;
  private marks: Record<string, { gate: number; mono: number; wall: number }> = {};

  constructor(ctx: DurableObjectState, env: { LTI_CONTENT?: D1 }) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    // (a tickets table made before the mode column: tickets now record the mode they were issued in)
    if (!this.sql.exec("PRAGMA table_info(tickets)").toArray().some((c) => (c as { name: string }).name === "mode")) this.sql.exec("ALTER TABLE tickets ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal'");
  }

  // ---- small state
  private now(): number {
    if (this.virtual !== null) return this.virtual;
    const real = Date.now();
    return this.scale === 1 ? real + this.skew : this.scaleBase + (real - this.scaleBase) * this.scale + this.skew;
  }
  /** A wait of `ms` on the gate's clock; `own`: one the checkpoint itself awaits (recorded in tests). */
  private async sleep(ms: number, own = false, label = "sleep"): Promise<void> {
    const s = this.timerStart(own);
    let fired: number | null = null;
    if (this.virtual !== null) {
      this.virtual += ms;
      await new Promise((r) => setTimeout(r, 0));
      if (s) fired = performance.now();
    } else {
      await new Promise<void>((r) => setTimeout(() => {
        if (s) fired = performance.now();
        r();
      }, ms / this.scale));
    }
    this.timerEnd("sleep", label, s, ms, this.virtual !== null ? 0 : ms / this.scale, fired, "timer");
  }
  /** Tests: a deliberate timer's start, when the checkpoint itself awaits it inside checkpointNow(). */
  private timerStart(own: boolean): { mono: number; wall: number; gate: number } | null {
    return own && this.timerLog ? { mono: performance.now(), wall: Date.now(), gate: this.now() } : null;
  }
  /** Tests: its end. The overshoot is the resumption's lateness past the requested real duration, for a timer that won. */
  private timerEnd(kind: TimerRec["kind"], label: string, s: { mono: number; wall: number; gate: number } | null, requestedGate: number, requestedReal: number, fired: number | null, won: "timer" | "work"): void {
    if (!s || !this.timerLog || this.timerLog.length >= 1000) return;
    const resumed = performance.now(), elapsed = resumed - s.mono;
    const over = won === "timer" ? Math.max(0, elapsed - requestedReal) : 0;
    this.timerLog.push({ kind, label, requested_gate_ms: requestedGate, scale: this.scale, virtual: this.virtual !== null, requested_real_ms: requestedReal, sched_mono: s.mono, fired_mono: fired, resumed_mono: resumed, elapsed_real_ms: elapsed, overshoot_real_ms: over, overshoot_gate_ms: this.virtual !== null ? 0 : over * this.scale, sched_wall: s.wall, sched_gate: s.gate, resumed_gate: this.now(), won });
  }
  private mark(k: string): void {
    if (this.timerLog) this.marks[k] = { gate: this.now(), mono: performance.now(), wall: Date.now() };
  }
  /** Tests: checkpoints only when asked (checkpointNow), so other tests never meet one; stored, as an evicted instance would lose a field. */
  private get manualCheckpoints(): boolean {
    return testMode() && this.get("test_manual_ckpt") === "1";
  }
  private recoveryId(): number {
    return Number(this.get("recovery_id") ?? 0);
  }
  private get(k: string): string | null {
    const r = [...this.sql.exec("SELECT v FROM meta WHERE k = ?", k)][0] as { v: string } | undefined;
    return r ? r.v : null;
  }
  private set(k: string, v: string | number): void {
    if (k === "mode" && testMode()) this.modeLog.push({ v: String(v), at: Date.now(), by: (new Error().stack ?? "").split("\n").slice(2, 5).map((l) => l.trim()).join(" < ") });
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, String(v));
  }
  private mode(): GateMode {
    return (this.get("mode") as GateMode | null) ?? "normal";
  }
  private db(): D1 {
    if (!this.env.LTI_CONTENT) throw new Error("LTI_CONTENT unbound");
    return this.env.LTI_CONTENT;
  }
  private ticket(id: string): Ticket | undefined {
    return [...this.sql.exec("SELECT * FROM tickets WHERE id = ?", id)][0] as unknown as Ticket | undefined;
  }
  private pending(): { seq: number; instance: string; ticket: string | null; kind: string } | undefined {
    return [...this.sql.exec("SELECT seq, instance, ticket, kind FROM calls")][0] as never;
  }
  /** A call record that isn't the one in flight here: another instance's, or an uncertain one left unresolved. */
  private unresolved(): boolean {
    const p = this.pending();
    return !!p && p.seq !== this.inflight;
  }

  // ---- the rates (r10/r11): measured by the probe, failing closed
  /** R, the ticket bucket's rate (call tokens/s), or null when issue must fail closed. */
  private rate(): number | null {
    const at = Number(this.get("probe_at") ?? 0);
    const ok = this.get("probe_ok") === "1";
    const R = Number(this.get("probe_r") ?? 0);
    if (!ok || !at || this.now() - at > PROBE_MAX_AGE_MS || !(R >= R_FLOOR)) return null;
    return R;
  }
  private take(key: string, rate: number, cap: number, n: number): boolean {
    const now = this.now();
    const b = this.buckets.get(key) ?? { tokens: cap, at: now };
    // (a clock that moved back past the last refill counts as no time passed, never as a debt, as for the internal
    // bucket: TEST-PRIVATE18-D4-CHAIN-1)
    const tokens = Math.min(cap, b.tokens + (Math.max(0, now - b.at) * rate) / 1000);
    if (tokens < n) {
      this.buckets.set(key, { tokens, at: now });
      return false;
    }
    this.buckets.set(key, { tokens: tokens - n, at: now });
    return true;
  }
  private give(key: string, cap: number, n: number): void {
    const b = this.buckets.get(key);
    if (b) b.tokens = Math.min(cap, b.tokens + n);
  }
  private ownerCap(R: number): number {
    return Math.max(3, R / 3);
  }
  /** The environment bucket's burst: R, or the heaviest ticket's weight if R is less (its refill is R/s either way). */
  private envCap(R: number): number {
    return Math.max(R, WEIGHT.upload);
  }

  /**
   * The probe (r10): 20 back-to-back internal chain calls, one in flight, with
   * issue paused.  S = 20 / elapsed over all of them; T = min(30, S / 2); R = T − 1.
   * Any call over 1 s, or any failure, fails issue closed until a good probe.
   */
  async probe(): Promise<{ ok: boolean; S: number; R: number; max_ms: number; code?: string }> {
    // (never while paused: a restore's first new-timeline write must be its marker, CORR-LTI18-2; the last result stands)
    if (this.mode() === "paused") return { ok: false, S: 0, R: 0, max_ms: 0, code: "paused" };
    this.probing = true;
    try {
      // (any unresolved call first, outside the timing: its wait for the internal bucket isn't the chain's speed)
      let worst = 0, failed = !(await this.enqueue(() => this.settled()).catch(() => false));
      const t0 = Date.now();
      for (let i = 0; i < PROBE_CALLS && !failed; i++) {
        let took = 0;
        // (a probe call already waiting rechecks in the queue: a pause that came meanwhile stops it before it sends;
        // its time is measured from its start, so a checkpoint's hold isn't counted as the chain's speed)
        const r = await this.enqueue(async (): Promise<WriteResult> => {
          if (this.mode() === "paused") return { ok: false, status: 503, code: "paused" };
          const t = Date.now();
          const out = await this.call(null, "probe", []);
          took = Date.now() - t;
          return out;
        });
        if (!r.ok && r.code === "paused") return { ok: false, S: 0, R: 0, max_ms: worst, code: "paused" };
        worst = Math.max(worst, took);
        if (!r.ok || worst > PROBE_TAIL_MS) failed = true;
      }
      const elapsed = (Date.now() - t0) / 1000;
      const S = failed ? 0 : PROBE_CALLS / Math.max(elapsed, 0.001);
      const R = Math.min(30, 0.5 * S) - 1;
      this.ctx.storage.transactionSync(() => {
        this.set("probe_at", this.now());
        this.set("probe_ok", failed ? 0 : 1);
        this.set("probe_r", failed ? 0 : R);
      });
      if (failed || R < R_FLOOR) console.log("ALERT lti gate: issue fails closed", JSON.stringify({ failed, worst, R }));
      await this.rearm();
      return { ok: !failed && R >= R_FLOOR, S, R, max_ms: worst };
    } finally {
      this.probing = false;
    }
  }

  // ---- tickets
  /**
   * Issue a ticket (§2.5): mode, the probe, the live guard and an unresolved call
   * first; then the stored and live caps (after ≤ 20 expired rows go); then the
   * weighted buckets, environment and owner.  Nothing is stored on a refusal.
   */
  async issue(kind: TicketKind, owner: string | null): Promise<{ ok: true; id: string; expires: number; deadline: number } | { ok: false; status: number; code: string; retry_after?: number }> {
    const closed = (): boolean => {
      const mode = this.mode();
      return mode === "paused" || (mode === "recovering" && kind !== "wake");
    };
    if (closed()) return { ok: false, status: 503, code: "paused" };
    if (kind !== "wake" && !owner) return { ok: false, status: 400, code: "owner" };
    // (no probe yet, or the last one older than 2 h, as after a long pause, when none runs: probe now, as at startup;
    // a failed probe isn't retried here: issue stays closed until the next good one)
    const probeAt = Number(this.get("probe_at") ?? 0);
    if ((!probeAt || this.now() - probeAt > PROBE_MAX_AGE_MS) && !this.probing) await this.probe();
    // (the mode again after the probe's await: a pause during it refuses as paused, CORR-LTI15-1, CORR-LTI18-2)
    if (closed()) return { ok: false, status: 503, code: "paused" };
    if (this.probing) return { ok: false, status: 429, code: "probing", retry_after: 3000 };
    // (issue pauses for a checkpoint's entry and its whole interval, r11–r15)
    if (this.ckpt !== "none") return { ok: false, status: 429, code: "checkpoint", retry_after: 3000 };
    // (an unknown or uncertain call: its one resolution is started, never waited for here, SELF-A3-1-1)
    if (this.unresolved()) {
      void this.resolveSoon();
      return { ok: false, status: 429, code: "resolving", retry_after: 3000 };
    }
    const now = this.now();
    if (this.queued.length && now - this.queued[0] > LIVE_GUARD_MS) return { ok: false, status: 429, code: "busy", retry_after: 2000 };
    const R = this.rate();
    if (R === null) return { ok: false, status: 503, code: "gate_closed" };
    const w = WEIGHT[kind];
    const res = this.ctx.storage.transactionSync(() => {
      // (the mode again, with no await between it and the insert: a pause during the probe admits nothing, CORR-LTI15-1)
      if (closed()) return { ok: false as const, status: 503, code: "paused" };
      if (this.unresolved()) return { ok: false as const, status: 429, code: "resolving", retry_after: 3000 };
      if (this.ckpt !== "none") return { ok: false as const, status: 429, code: "checkpoint", retry_after: 3000 };
      this.sql.exec("DELETE FROM tickets WHERE id IN (SELECT id FROM tickets WHERE expires < ? ORDER BY expires LIMIT ?)", now, ISSUE_CLEANUP);
      const stored = (this.sql.exec("SELECT count(*) AS n FROM tickets").one() as { n: number }).n;
      const kinds = kind === "upload" || kind === "wake" ? [kind] : ["assignment", "pin"];
      const live = (this.sql.exec(`SELECT count(*) AS n FROM tickets WHERE expires > ? AND kind IN (${kinds.map(() => "?").join(",")})`, now, ...kinds).one() as { n: number }).n;
      if (stored >= STORED_CAP || live >= LIVE_CAP[kind]) return { ok: false as const, status: 503, code: "gate_full" };
      // (the gate's own work has its own bucket; tickets of a weight take theirs, environment then owner)
      if (w > 0) {
        if (!this.take("env", R, this.envCap(R), w)) return { ok: false as const, status: 429, code: "rate", retry_after: Math.ceil((1000 * w) / R) };
        if (!this.take(`owner:${owner}`, R / 3, this.ownerCap(R), w)) {
          this.give("env", this.envCap(R), w);
          return { ok: false as const, status: 429, code: "rate", retry_after: Math.ceil((3000 * w) / R) };
        }
      }
      const id = randomHex(16);
      const expires = now + LIFE_MS[kind];
      // (the mode and recovery id it was issued in: a wake's intents and writes count only in those, §2.5)
      this.sql.exec("INSERT INTO tickets (id, kind, owner, issued, expires, w, mode, recovery) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, kind, owner, now, expires, w, this.mode(), this.recoveryId());
      // (max_deadline is a scalar of its own: deleting rows never loses it)
      if (expires > Number(this.get("max_deadline") ?? 0)) this.set("max_deadline", expires);
      return { ok: true as const, id, expires, deadline: kind === "upload" ? now + UPLOAD_DEADLINE_MS : expires };
    });
    if (res.ok) await this.arm();
    return res;
  }

  /** A ticket's return: it is no longer live, and its unspent tokens go back (capped). */
  async giveBack(id: string): Promise<{ ok: true }> {
    const t = this.ticket(id);
    if (!t) return { ok: true };
    this.sql.exec("DELETE FROM tickets WHERE id = ?", id);
    const R = this.rate();
    const unspent = Math.max(0, t.w - t.calls_used);
    if (R !== null && unspent > 0) {
      this.give("env", this.envCap(R), unspent);
      this.give(`owner:${t.owner}`, this.ownerCap(R), unspent);
    }
    return { ok: true };
  }

  /** Live tickets (returned or expired ones aren't, whether or not their row is still there). */
  live(): number {
    return (this.sql.exec("SELECT count(*) AS n FROM tickets WHERE expires > ?", this.now()).one() as { n: number }).n;
  }

  // ---- fenced writes
  /**
   * Run a ticket's batch (§2.5), the chain insert first.  Checked when it
   * reaches the front of the queue, not only on arrival (r13): the ticket live,
   * not spent, and with room for this call and its possible tombstone within w.
   */
  async write(id: string, stmts: Stmt[]): Promise<WriteResult> {
    if (!Array.isArray(stmts) || stmts.length === 0 || stmts.length > 20) return { ok: false, status: 400, code: "batch" };
    // (a wake's pages are the gate's own work: they wait on its 1 call/s bucket, never on the ticket bucket's)
    if (this.ticket(id)?.kind === "wake") await this.internalToken();
    const arrived = this.now();
    this.queued.push(arrived);
    try {
      return await this.enqueue(async () => {
        this.queued.splice(this.queued.indexOf(arrived), 1);
        // (an unknown call first: its resolution may spend this very ticket, so the ticket is read after it, CORR-LTI15-2)
        if (!(await this.settled())) return { ok: false, status: 503, code: "resolving" };
        const t = this.ticket(id);
        if (!t || t.expires <= this.now()) return { ok: false, status: 409, code: "ticket_expired" };
        // (a weighted ticket keeps room for this call and its own possible tombstone; a wake's pages went on the gate's own bucket)
        if (t.spent || (t.w > 0 && t.calls_used + 2 > t.w)) return { ok: false, status: 409, code: "ticket_spent" };
        // (a wake counts only in the mode and recovery it was issued in: an old normal wake can't write in a recovery)
        if (t.kind === "wake" && (t.mode !== this.mode() || t.recovery !== this.recoveryId())) return { ok: false, status: 409, code: "ticket_expired" };
        // (a pause stops issue only: a live ticket finishes or expires, and the runbook waits for live = 0, §2.5)
        if (this.mode() === "recovering" && t.kind !== "wake") return { ok: false, status: 503, code: "paused" };
        return this.call(t, "write", stmts);
      });
    } finally {
      const i = this.queued.indexOf(arrived);
      if (i >= 0) this.queued.splice(i, 1);
    }
  }

  private enqueue<T>(f: () => Promise<T>): Promise<T> {
    // (D4 r2: an item that hasn't started when a checkpoint decides waits at the front until its protected part ends)
    const g = async (): Promise<T> => {
      while (this.hold) await this.hold;
      this.active++;
      try {
        return await f();
      } finally {
        this.active--;
      }
    };
    const run = this.queue.then(g, g);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * One call on the chain (inside the queue): resolve any earlier unknown or
   * uncertain call first; record {seq, instance, ticket} with the ticket's count
   * in one storage transaction; send; delete the record on a definitive outcome.
   */
  private async call(t: Ticket | null, kind: "write" | "probe" | "checkpoint", stmts: Stmt[], nonce?: string): Promise<WriteResult & { seq?: number }> {
    // (a write settled before reading its ticket; this is the probe's, and a no-op for a write)
    if (!(await this.settled())) return { ok: false, status: 503, code: "resolving" };
    const seq = Number(this.get("next_seq") ?? 1);
    this.ctx.storage.transactionSync(() => {
      this.set("next_seq", seq + 1);
      this.sql.exec("INSERT INTO calls (seq, instance, ticket, sent, kind) VALUES (?, ?, ?, ?, ?)", seq, this.instance, t?.id ?? null, this.now(), kind);
      if (t) this.sql.exec("UPDATE tickets SET calls_used = calls_used + 1 WHERE id = ?", t.id);
    });
    this.inflight = seq;
    try {
      return { ...(await this.sendCall(t, kind, seq, stmts, nonce)), seq };
    } finally {
      this.inflight = null;
    }
  }

  private async sendCall(t: Ticket | null, kind: "write" | "probe" | "checkpoint", seq: number, stmts: Stmt[], nonce?: string): Promise<WriteResult> {
    if (this.seam?.op === "vanish" && testMode()) {
      // (tests: the instance dies here, the record and the ticket's count persisted, its answer never seen)
      if (--this.seam.count <= 0) this.seam = null;
      return { ok: false, status: 503, code: "vanished" };
    }
    const db = this.db();
    const chain = kind === "write"
      ? db.prepare("INSERT INTO gate_calls (seq, kind, deadline) VALUES (?, 'write', ?)").bind(seq, t!.expires)
      : kind === "checkpoint"
        ? db.prepare("INSERT INTO gate_calls (seq, kind, nonce) VALUES (?, 'checkpoint', ?)").bind(seq, nonce!)
        : db.prepare("INSERT INTO gate_calls (seq, kind) VALUES (?, 'probe')").bind(seq);
    const batch = [chain, ...stmts.map((s) => db.prepare(s.sql).bind(...(s.params ?? [])))];
    const answer = await this.send(batch, false, kind, undefined, kind === "checkpoint");
    if (answer.ok) {
      this.sql.exec("DELETE FROM calls WHERE seq = ?", seq);
      return { ok: true, results: answer.results.slice(1), chain: answer.results[0]?.meta };
    }
    // (refused or uncertain: the ticket is spent; the tombstone, or the committed row, decides, CORR-LTI5A3-5)
    if (t) this.sql.exec("UPDATE tickets SET spent = 1 WHERE id = ?", t.id);
    // (the gate's own call's tombstone, the probe's here, and a wake's, waits on the internal bucket; a weighted
    // ticket's is paid by its weight within R, daybreak3's ruling 965f621c; a pending resolution took its token in settled())
    if (!t || t.kind === "wake") await this.internalToken(kind === "checkpoint");
    const outcome = await this.resolve(seq, t, kind === "checkpoint");
    const code = answer.message ? abortCode(answer.message) : null;
    if (outcome === "committed") return { ok: false, status: 503, code: "uncertain_committed", committed: true };
    if (outcome === "unresolved") await this.ctx.storage.setAlarm(Date.now() + RESOLVE_RETRY_MS);
    if (outcome === "never") return { ok: false, status: code ? 409 : 503, code: code ?? "uncertain", committed: false, message: code ? undefined : "the call didn't commit; start again" };
    return { ok: false, status: 503, code: "resolving" };
  }

  /**
   * Send one batch with the 30 s gate-side deadline: ok, or an error (definitive or not; resolution decides).
   * `untilGate`: a shared budget's end on the GATE clock, so what is left of it is measured there too, and a
   * virtual clock is exact: real time between computing a budget and using it moves no gate time.
   */
  private async send(batch: ReturnType<D1["prepare"]>[], tombstone = false, kind: string = "write", untilGate?: number, own = false): Promise<{ ok: true; results: D1Result[] } | { ok: false; message?: string }> {
    // (every attempt counts, sent or not: the internal rate is about attempts)
    this.sends++;
    // (a `calls_only` seam leaves tombstones alone, so every uncertain call still resolves; `writes_only`, a ticket's writes only)
    const seam = this.seam && testMode() && !(tombstone && this.seam.calls_only) && !(this.seam.writes_only && (tombstone || kind !== "write")) ? this.seam : null;
    if (seam) {
      if (--seam.count <= 0) this.seam = null;
      if (seam.op === "fail_before_send") return { ok: false };
      if (seam.op === "late") {
        this.lateBatches.push(batch);
        return { ok: false };
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // (gate ms left, then real ms for the timer: the scale is applied once, at the end)
    const limitGate = untilGate === undefined ? this.deadlineMs : Math.max(0, untilGate - this.now());
    const limit = limitGate / this.scale;
    const ts = this.timerStart(own);
    let fired: number | null = null;
    try {
      const results = await Promise.race([
        // (a delayed batch is still sent, and may commit, after its deadline fires: as D1's own may)
        seam?.op === "delay" ? new Promise((r) => setTimeout(r, seam.ms ?? 0)).then(() => this.db().batch(batch)) : this.db().batch(batch),
        // (its own 30 s, or what is left of a shared budget: a resolution's tombstone and read share one, CORR-LTI18-4)
        new Promise<never>((_, no) => (timer = setTimeout(() => {
          if (ts) fired = performance.now();
          no(new Error("gate deadline"));
        }, limit))),
      ]);
      if (seam?.op === "drop_answer") return { ok: false };
      return { ok: true, results };
    } catch (e) {
      return { ok: false, message: String((e as Error)?.message ?? e) };
    } finally {
      if (timer) clearTimeout(timer);
      this.timerEnd("deadline", kind, ts, limitGate, limit, fired, fired !== null ? "timer" : "work");
    }
  }

  /**
   * Resolution (astra, r7; never ageing): a tombstone at `seq` under the
   * successor rule, then a read of row `seq`.  A write, checkpoint or probe
   * there means committed; the tombstone taking it means never.  An uncertain
   * tombstone leaves the record, and the next call tries again first.
   */
  private async resolve(seq: number, t: Ticket | null, own = false): Promise<"committed" | "never" | "unresolved"> {
    const db = this.db();
    // (CORR-LTI18-4: one budget, the call deadline's 30 s, for the tombstone AND the read of row seq together; a
    // missing answer from either is unresolved: the record stays and the next call or the alarm tries again, so a
    // resolution never holds the queue, or a checkpoint's hold, past it)
    // (its end on the gate clock, in gate ms: on a real or scaled clock the same deadline as before; on the virtual
    // clock exact, since only sleeps move it, never the real time the D1 calls take, sage's option (a))
    const until = this.now() + this.deadlineMs;
    if (this.resolveGapRealMs > 0 && testMode()) await new Promise((r) => setTimeout(r, this.resolveGapRealMs));
    this.tombstones++;
    const ts = await this.send([db.prepare("INSERT INTO gate_calls (seq, kind) VALUES (?, 'tombstone')").bind(seq)], true, "tombstone", until, own);
    // (a tombstone counts against its ticket's weight: it was charged for at issue)
    if (t) this.sql.exec("UPDATE tickets SET calls_used = calls_used + 1 WHERE id = ?", t.id);
    if (!ts.ok && !(ts.message && abortCode(ts.message)?.startsWith("unique:gate_calls"))) {
      // (the tombstone's own answer is uncertain: the record stays; one in flight, so nothing passes it)
      if (!ts.message || !abortCode(ts.message)) return "unresolved";
    }
    let row: { kind: string } | null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budgetGate = Math.max(0, until - this.now());
    const budget = budgetGate / this.scale;
    const bs = this.timerStart(own);
    let fired: number | null = null;
    try {
      // (tests: `park_read` holds this read's answer forever, as a D1 read that never answers)
      const parked = this.parkReads > 0 && testMode();
      if (parked) this.parkReads--;
      const read = parked ? new Promise<never>(() => {}) : db.prepare("SELECT kind FROM gate_calls WHERE seq = ?").bind(seq).first<{ kind: string }>();
      row = await Promise.race([read, new Promise<never>((_, no) => (timer = setTimeout(() => {
        if (bs) fired = performance.now();
        no(new Error("resolution budget"));
      }, budget)))]);
    } catch {
      return "unresolved";
    } finally {
      if (timer) clearTimeout(timer);
      this.timerEnd("budget", "read", bs, budgetGate, budget, fired, fired !== null ? "timer" : "work");
    }
    if (!row) return "unresolved";
    this.sql.exec("DELETE FROM calls WHERE seq = ?", seq);
    return row.kind === "tombstone" ? "never" : "committed";
  }

  /** Inside the queue: none unresolved, or its resolution now (on the internal bucket); true when none is left. */
  private async settled(): Promise<boolean> {
    if (!this.unresolved()) return true;
    await this.internalToken();
    return this.resolvePending();
  }

  /** Outside the queue: the one coalesced resolution attempt, queued if none is (issue and the alarm share it). */
  private resolveSoon(): Promise<boolean> {
    if (!this.resolution) {
      this.resolution = this.enqueue(() => this.settled())
        .catch(() => false)
        .then(async (ok) => {
          if (!ok) await this.ctx.storage.setAlarm(Date.now() + RESOLVE_RETRY_MS);
          return ok;
        })
        .finally(() => {
          this.resolution = null;
        });
    }
    return this.resolution;
  }

  /** One token of the gate's own bucket (1/s, capacity 1), waited for: its calls never take the ticket bucket's. */
  // (on the gate's own clock, as every gate timer: a token taken before a checkpoint's decision has refilled by its
  // call's possible tombstone, ≥ one 2.0 s gap later; a wake page's refills during its own call, so call + wait +
  // resolution ≤ 60 s, D4 r3 step f)
  private async internalToken(own = false): Promise<void> {
    for (;;) {
      const now = this.now();
      // (a clock that moved back, as a test's skew reset does, counts as no time passed, never as a debt)
      const tokens = Math.min(1, Math.max(0, this.internal.tokens) + Math.max(0, now - this.internal.at) / 1000);
      if (tokens >= 1) {
        this.internal = { tokens: tokens - 1, at: now };
        return;
      }
      this.internal = { tokens, at: now };
      await this.sleep(Math.ceil((1 - tokens) * 1000), own, "token");
    }
  }

  private async resolvePending(): Promise<boolean> {
    const p = this.pending();
    if (!p) return true;
    const t = p.ticket ? this.ticket(p.ticket) ?? null : null;
    if (t) this.sql.exec("UPDATE tickets SET spent = 1 WHERE id = ?", t.id);
    return (await this.resolve(p.seq, null)) !== "unresolved";
  }

  // ---- checkpoints (r9–r15): the trusted restore heads
  /**
   * One checkpoint (§2.5, "Issue pauses for the whole checkpoint interval"; the A3-2 delta D4). Issue pauses;
   * the first attempt starts only if, within 10 s, the queue drains and every live ticket has ≥ 110 s left, else
   * it is postponed once by 1 min with issue resumed. The second attempt revokes every live ticket with < 110 s
   * left. Then the decision (D4 r2): the hold is set, so no queue item that hasn't started can start until the
   * protected part ends; the one in flight finishes by its own deadlines (≤ 30 s + 30 s). The protected part
   * starts with nothing running; it fails closed if a call is unresolved; else it revokes again every ticket
   * with < 110 s left (every ticket live at its start has ≥ 110 s), then a 2.0–2.1 s gap, the checkpoint call
   * (its resolution if uncertain; the gate's own, outside the queue), another gap: ≤ 64.2 s. The in-flight item's
   * wait is capped at decision + 61 s (abandoned there), so decision to end ≤ 61 s + 64.2 s = 125.2 s, plus timer
   * lateness; from the due time, sent ≤ 135.1 s and ended ≤ 197.2 s, each plus its alarms' firing delays (D4 r3).
   * Logged only once its answer gives D1's time; never written when the log is full after cleanup.
   */
  /**
   * One checkpoint (below); in tests, with the timers it awaited and its phase marks (the scaled-clock lateness
   * instrumentation: diagnostics only, the bounds stay raw).
   */
  async checkpointNow(): Promise<Awaited<Promise<{ outcome: "done" | "postponed" | "skipped" | "full" | "uncertain" | "failed" | "abandoned"; k?: number; revoked?: number; interval_ms?: number; protected_ms?: number; min_left_at_start?: number; sent?: boolean; sends_in_protected?: number; gaps?: number[]; late_ms?: number; cleaned?: number; attempt?: number; fire_delay_ms?: number; due_to_sent_ms?: number; due_to_end_ms?: number; decision_to_end_ms?: number; txn_ms?: number[]; due_at?: number }>> & { timers?: TimerRec[]; marks?: Record<string, { gate: number; mono: number; wall: number }> }> {
    // (a call while one runs, which is skipped, leaves the running one's record alone)
    if (!testMode() || this.timerLog) return this.checkpointRun();
    this.timerLog = [];
    this.marks = {};
    try {
      const r = await this.checkpointRun();
      return { ...r, timers: this.timerLog, marks: this.marks };
    } finally {
      this.timerLog = null;
    }
  }

  private async checkpointRun(): Promise<{ outcome: "done" | "postponed" | "skipped" | "full" | "uncertain" | "failed" | "abandoned"; k?: number; revoked?: number; interval_ms?: number; protected_ms?: number; min_left_at_start?: number; sent?: boolean; sends_in_protected?: number; gaps?: number[]; late_ms?: number; cleaned?: number; attempt?: number; fire_delay_ms?: number; due_to_sent_ms?: number; due_to_end_ms?: number; decision_to_end_ms?: number; txn_ms?: number[]; due_at?: number }> {
    if (this.mode() !== "normal" || this.ckpt !== "none") return { outcome: "skipped" };
    const now = this.now();
    // (D4 r3 §3: how late this attempt itself fired against its own schedule, the due time or its postponement)
    const fire_delay_ms = Math.max(0, now - Number(this.get("ckpt_next") ?? now));
    const cleaned = this.sql.exec("DELETE FROM checkpoints WHERE k IN (SELECT k FROM checkpoints WHERE d1_time < ? ORDER BY d1_time LIMIT 2)", now - CKPT_KEEP_MS).rowsWritten;
    if ((this.sql.exec("SELECT count(*) AS n FROM checkpoints").one() as { n: number }).n >= CKPT_CAP) {
      console.log("ALERT lti gate: the checkpoint log is full; no checkpoint written", JSON.stringify({ cap: CKPT_CAP }));
      this.set("ckpt_next", now + CKPT_EVERY_MS);
      return { outcome: "full" };
    }
    const second = this.get("ckpt_attempt") === "1";
    const t0 = this.now();
    this.mark("t0");
    // (how late this attempt starts against the 10-min schedule, D4; the bounds from the due time are D4 r3's above)
    const due0 = Number(this.get("ckpt_due") ?? this.get("ckpt_next") ?? t0);
    const late_ms = Math.max(0, t0 - due0);
    const attempt = second ? 2 : 1;
    const txn_ms: number[] = [];
    // (D4 r3: a synchronous storage transaction can't be preempted; its time is measured, and an overrun of its
    // budget is detected afterwards, alerted, and the attempt abandoned: nothing sent, the hold released, retried
    // in 1 min; never a checkpoint counted inside the bound)
    const timed = (f: () => number, which: string): number | null => {
      const s = Date.now();
      const n = f();
      const ms = Date.now() - s + (this.txnOverrun === which && testMode() ? 1500 : 0);
      if (this.txnOverrun === which) this.txnOverrun = null;
      txn_ms.push(ms);
      if (ms > CKPT_TXN_BUDGET_MS) {
        console.log("ALERT lti gate: a checkpoint transaction overran its budget; the attempt is abandoned", JSON.stringify({ which, ms }));
        return null;
      }
      return n;
    };
    const abandon = () => {
      this.set("ckpt_next", this.now() + CKPT_POSTPONE_MS);
      return { outcome: "abandoned" as const, attempt, fire_delay_ms, txn_ms, sent: false, late_ms, due_at: due0 };
    };
    this.ckpt = "entering";
    try {
      let revoked = 0;
      if (second) {
        // (r15: the second attempt revokes; monotone, nothing waited for)
        const n = timed(() => this.revokeShort(), "entry");
        if (n === null) return abandon();
        revoked = n;
        if (revoked) console.log("lti gate: checkpoint revoked tickets", JSON.stringify({ revoked }));
      } else if (!(await this.entryReady())) {
        this.ctx.storage.transactionSync(() => {
          this.set("ckpt_attempt", 1);
          this.set("ckpt_next", this.now() + CKPT_POSTPONE_MS);
          if (!this.get("ckpt_due")) this.set("ckpt_due", Math.min(due0, t0));
        });
        return { outcome: "postponed", late_ms, attempt, fire_delay_ms, due_at: due0 };
      }
      this.ckpt = "interval";
      const nonce = randomHex(16);
      const gaps: number[] = [];
      const gap = async () => {
        const g = this.now();
        await this.sleep(this.gapMs ?? 2000 + Math.random() * 100, true, "gap");
        gaps.push(this.now() - g);
      };
      // (D4 r3: the internal token before the decision, so its wait never lengthens the hold)
      await this.internalToken(true);
      // (the decision: the hold)
      let release!: () => void;
      this.hold = new Promise<void>((r) => (release = r));
      const tDecision = this.now();
      this.mark("decision");
      let tStart = 0, minLeft = Infinity, sent = false, sends_in_protected = 0, sentAt = 0, abandoned = false;
      let r: WriteResult & { seq?: number } = { ok: false, status: 503, code: "abandoned" };
      try {
        // (the one item in flight at the decision finishes; nothing else can start. Its call and its resolution are
        // each bounded by 30 s (CORR-LTI18-4), so this ends within 60 s; at decision + 60 s + 1 s the attempt is
        // abandoned, alerted, nothing sent: a checkpoint is never written while an item is still running. An absolute
        // deadline, and no poll sleeps past it (BOUND-PRIVATE18-D4-1))
        const inflightDeadline = tDecision + 2 * CALL_DEADLINE_MS + 1000;
        for (let at = this.now(); this.active > 0 && at < inflightDeadline; at = this.now()) await this.sleep(Math.min(50, inflightDeadline - at), true, "inflight_poll");
        if (this.active > 0) {
          console.log("ALERT lti gate: the item in flight outlasted its bound; the checkpoint attempt is abandoned");
          abandoned = true;
        }
        tStart = this.now();
        this.mark("start");
        if (abandoned) {
          // (nothing more: the hold is released below, and no checkpoint is sent)
        } else if (this.unresolved()) {
          // (no checkpoint past an unresolved call: the attempt fails closed now; the chain resolves it after, D4)
          r = { ok: false, status: 503, code: "resolving" };
        } else {
          // (the margin judged at the protected part's start; monotone; its transaction timed, as the entry's)
          const n = timed(() => this.revokeShort(), "recheck");
          if (n === null) abandoned = true;
          else revoked += n;
        }
        if (!abandoned && !this.unresolved()) {
          const at = this.now();
          const left = (this.sql.exec("SELECT min(expires) AS m FROM tickets WHERE expires > ?", at).one() as { m: number | null }).m;
          minLeft = left === null ? Infinity : left - at;
          const s0 = this.sends;
          await gap();
          sent = true;
          sentAt = this.now();
          r = await this.call(null, "checkpoint", [{ sql: `SELECT ${D1_NOW} AS now` }], nonce);
          await gap();
          sends_in_protected = this.sends - s0;
        }
      } finally {
        this.hold = null;
        release();
      }
      this.mark("end");
      const decision_to_end_ms = this.now() - tDecision;
      if (abandoned) return { ...abandon(), decision_to_end_ms };
      const protected_ms = this.now() - tStart;
      const due_to_sent_ms = sent ? sentAt - due0 : undefined, due_to_end_ms = this.now() - due0;
      const min_left_at_start = Number.isFinite(minLeft) ? minLeft : null;
      // (the next one is due 10 min after this one was due, so lateness never accumulates)
      const due = Math.min(due0, t0);
      this.ctx.storage.transactionSync(() => {
        this.set("ckpt_attempt", 0);
        this.set("ckpt_next", r.ok ? Math.max(this.now() + 1000, due + CKPT_EVERY_MS) : this.now() + CKPT_POSTPONE_MS);
        if (r.ok) this.sql.exec("DELETE FROM meta WHERE k = 'ckpt_due'");
      });
      const interval_ms = this.now() - t0;
      if (!r.ok) {
        console.log("ALERT lti gate: checkpoint not logged", JSON.stringify({ code: r.code }));
        return { outcome: r.code === "uncertain_committed" ? "uncertain" : "failed", revoked, interval_ms, protected_ms, min_left_at_start: min_left_at_start ?? undefined, sent, sends_in_protected, gaps, late_ms, attempt, fire_delay_ms, due_to_sent_ms, due_to_end_ms, decision_to_end_ms, txn_ms, due_at: due0 };
      }
      const d1Time = Number((r.results[0]?.results?.[0] as { now?: number } | undefined)?.now);
      this.sql.exec("INSERT INTO checkpoints (k, nonce, d1_time) VALUES (?, ?, ?)", r.seq!, nonce, d1Time);
      return { outcome: "done", k: r.seq, revoked, interval_ms, protected_ms, min_left_at_start: min_left_at_start ?? Number.MAX_SAFE_INTEGER, sent, sends_in_protected, gaps, late_ms, cleaned, attempt, fire_delay_ms, due_to_sent_ms, due_to_end_ms, decision_to_end_ms, txn_ms, due_at: due0 };
    } finally {
      this.ckpt = "none";
    }
  }

  /**
   * Revoke (expire now, and spent, in one transaction) every live ticket with < 110 s left; how many. Spent as well:
   * a revoked ticket stays revoked whatever the clock does after (TEST-PRIVATE18-REVOKE-1), as write and intent refuse it.
   */
  private revokeShort(): number {
    return this.ctx.storage.transactionSync(() => {
      const at = this.now();
      const n = (this.sql.exec("SELECT count(*) AS n FROM tickets WHERE expires > ? AND expires < ?", at, at + CKPT_MARGIN_MS).one() as { n: number }).n;
      this.sql.exec("UPDATE tickets SET expires = ?, spent = 1 WHERE expires > ? AND expires < ?", at, at, at + CKPT_MARGIN_MS);
      return n;
    });
  }

  /** The first attempt's start condition, waited for ≤ 10 s: nothing queued or in flight, every live ticket ≥ 110 s left. */
  private async entryReady(): Promise<boolean> {
    const end = this.now() + CKPT_ENTRY_MS;
    for (;;) {
      const now = this.now();
      const drained = this.queued.length === 0 && this.inflight === null && !this.unresolved();
      const short = (this.sql.exec("SELECT count(*) AS n FROM tickets WHERE expires > ? AND expires < ?", now, now + CKPT_MARGIN_MS).one() as { n: number }).n;
      if (drained && short === 0) return true;
      if (now >= end) return false;
      await this.sleep(50, true, "entry_poll");
    }
  }

  /** The newest checkpoints, for the runbook's choice (step 3). */
  checkpoints(limit = 20): Checkpoint[] {
    return this.sql.exec("SELECT k, nonce, d1_time FROM checkpoints ORDER BY k DESC LIMIT ?", Math.min(500, Math.max(1, limit))).toArray() as unknown as Checkpoint[];
  }

  // ---- delete intents (CORR-LTI5A3-3): an R2 delete is announced here first, and resolved after its success
  /**
   * Admit an intent only for a live wake ticket issued in the current mode and recovery id, never while
   * paused, and never past 20 unresolved (then an alert; deletes stop until an operator looks).
   */
  intent(ticketId: string, keys: string[]): { ok: true; id: string } | { ok: false; code: string } {
    const t = this.ticket(ticketId);
    const mode = this.mode();
    // (a spent ticket announces nothing: a revoked one stays revoked after a backward clock step, TEST-PRIVATE18-REVOKE-1)
    if (!t || t.kind !== "wake" || t.spent || t.expires <= this.now()) return { ok: false, code: "ticket" };
    if (mode === "paused" || t.mode !== mode || t.recovery !== this.recoveryId()) return { ok: false, code: "mode" };
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > INTENT_KEYS_MAX || !keys.every((k) => typeof k === "string" && KEY_RE.test(k))) return { ok: false, code: "keys" };
    if ((this.sql.exec("SELECT count(*) AS n FROM intents").one() as { n: number }).n >= INTENTS_MAX) {
      console.log("ALERT lti gate: 20 unresolved delete intents; deletes stop until an operator looks");
      return { ok: false, code: "intents_full" };
    }
    const id = randomHex(16);
    this.sql.exec("INSERT INTO intents (id, keys, issued, ticket, mode, recovery) VALUES (?, ?, ?, ?, ?, ?)", id, JSON.stringify(keys), this.now(), t.id, mode, this.recoveryId());
    return { ok: true, id };
  }
  /** After the delete call's success: the intent is gone. A failure, timeout or dead worker leaves it unresolved. */
  resolveIntent(id: string): { ok: true } {
    this.sql.exec("DELETE FROM intents WHERE id = ?", id);
    return { ok: true };
  }
  /** The unresolved intents (≤ 20): their keys are suspect, across resume and every later recovery. */
  intents(): { id: string; keys: string[]; issued: number }[] {
    return (this.sql.exec("SELECT id, keys, issued FROM intents ORDER BY issued").toArray() as { id: string; keys: string; issued: number }[]).map((r) => ({ id: r.id, keys: JSON.parse(r.keys) as string[], issued: r.issued }));
  }
  /** An operator's close, only after a HEAD of every key found nothing (the admin call checks; §2.5). */
  closeIntent(id: string): { ok: boolean } {
    return { ok: this.sql.exec("DELETE FROM intents WHERE id = ?", id).rowsWritten > 0 };
  }

  // ---- the restore runbook (§2.5): pause, quiet, marker, recover, resume
  /**
   * Step 1. A marker from before this pause no longer counts (a new restore may follow), but `restore_open`, set by
   * the first marker attempt, survives every pause: only a completed recovery's resume clears it (CORR-LTI18-1).
   * Pausing a recovery leaves `recover` (a new recovery id), never a plain resume.
   */
  pause(): { mode: GateMode } {
    const was = this.mode();
    if (was !== "paused") this.ctx.storage.transactionSync(() => {
      this.set("mode", "paused");
      this.set("marker_ok", 0);
      if (was === "recovering") this.set("recovery_paused", 1);
    });
    return { mode: "paused" };
  }
  /** Quiet (step 2): paused, nothing live, no call outstanding or queued, no checkpoint running. */
  quiet(): { quiet: boolean; mode: GateMode; live: number; calls: number; queued: number; intents: number } {
    const live = this.live(), calls = this.pending() ? 1 : 0, queued = this.queued.length;
    const intents = (this.sql.exec("SELECT count(*) AS n FROM intents").one() as { n: number }).n;
    const mode = this.mode();
    return { quiet: mode === "paused" && live === 0 && calls === 0 && queued === 0 && this.inflight === null && this.ckpt === "none", mode, live, calls, queued, intents };
  }
  /**
   * Step 3's marker, the first write to the restored database: `seq` from the gate's own counter, `from_seq`
   * and the nonce from its log. An abort is a redo (a stale call landed above k), or a miss (row k absent or
   * the head below k); after 3 misses the runbook stops, failing closed.
   */
  async marker(k: number): Promise<{ ok: true; seq: number } | { ok: false; code: "not_quiet" | "no_checkpoint" | "redo" | "missed" | "stopped" | "uncertain"; misses?: number }> {
    if (!this.quiet().quiet) return { ok: false, code: "not_quiet" };
    const misses = Number(this.get("marker_misses") ?? 0);
    if (misses >= MARKER_MISSES_MAX) return { ok: false, code: "stopped", misses };
    const cp = [...this.sql.exec("SELECT k, nonce FROM checkpoints WHERE k = ?", k)][0] as { k: number; nonce: string } | undefined;
    if (!cp) return { ok: false, code: "no_checkpoint" };
    // (from the first marker on, a restore is open: it ends only through a completed recovery, never a plain resume;
    // a new marker attempt is a new restore, so a paused recovery's own resumption no longer applies)
    this.ctx.storage.transactionSync(() => {
      this.set("restore_open", 1);
      this.set("recovery_paused", 0);
    });
    return this.enqueue(async () => {
      const seq = Number(this.get("next_seq") ?? 1);
      this.set("next_seq", seq + 1);
      const db = this.db();
      const a = await this.send([db.prepare("INSERT INTO gate_calls (seq, kind, from_seq, nonce) VALUES (?, 'marker', ?, ?)").bind(seq, cp.k, cp.nonce)]);
      const read = async () => db.prepare("SELECT (SELECT max(seq) FROM gate_calls) AS head, (SELECT kind FROM gate_calls WHERE seq = ?) AS at_k, (SELECT kind FROM gate_calls WHERE seq = ?) AS at_seq").bind(cp.k, seq).first<{ head: number | null; at_k: string | null; at_seq: string | null }>();
      let ok = a.ok;
      if (!ok && !(a.message && abortCode(a.message) === "marker_head")) {
        // (uncertain: the row decides; a late marker landing later only makes a redo's marker abort, which converges)
        const r = await read().catch(() => null);
        if (r?.at_seq !== "marker") return { ok: false as const, code: "uncertain" as const };
        ok = true;
      }
      if (ok) {
        this.ctx.storage.transactionSync(() => {
          this.set("marker_ok", 1);
          this.set("marker_misses", 0);
        });
        return { ok: true as const, seq };
      }
      const r = await read().catch(() => null);
      const missed = !r || r.at_k === null || (r.head ?? 0) < cp.k;
      if (!missed) return { ok: false as const, code: "redo" as const };
      this.set("marker_misses", misses + 1);
      if (misses + 1 >= MARKER_MISSES_MAX) {
        console.log("ALERT lti gate: the restore missed its checkpoint 3 times; the runbook stops", JSON.stringify({ k: cp.k }));
        return { ok: false as const, code: "stopped" as const, misses: misses + 1 };
      }
      return { ok: false as const, code: "missed" as const, misses: misses + 1 };
    });
  }
  /**
   * Step 4: only wakes run; a new recovery id from the gate's own counter; the unresolved intents' keys stay
   * suspect. Needs a committed marker since the pause, or a paused recovery to restart (no restore since).
   */
  recover(): { ok: true; recovery_id: number } | { ok: false; code: "not_quiet" | "no_marker" } {
    if (!this.quiet().quiet) return { ok: false, code: "not_quiet" };
    if (this.get("marker_ok") !== "1" && this.get("recovery_paused") !== "1") return { ok: false, code: "no_marker" };
    const rid = Number(this.get("recovery_counter") ?? 0) + 1;
    this.ctx.storage.transactionSync(() => {
      this.set("recovery_counter", rid);
      this.set("recovery_id", rid);
      this.set("recovery_done", 0);
      this.set("marker_ok", 0);
      this.set("recovery_paused", 0);
      this.set("restore_open", 1);
      this.set("mode", "recovering");
    });
    return { ok: true, recovery_id: rid };
  }
  /**
   * What a wake needs (§2.5 step 4): the mode, the recovery id, and the suspect set as **tokens** (≤ 20,000 of 32
   * hex): a wake compares tokens only, so it never carries the full keys (LIMIT-PRIVATE18-2).
   */
  recoveryState(): { mode: GateMode; recovery_id: number; done: boolean; suspect: string[] } {
    const rid = this.recoveryId();
    const tokens = this.intents().flatMap((i) => i.keys.map((k) => k.slice(k.lastIndexOf("/") + 1)));
    return { mode: this.mode(), recovery_id: rid, done: Number(this.get("recovery_done") ?? 0) === rid && rid > 0, suspect: tokens };
  }
  /** Step 7, the worker's report: this recovery's cycle completed (its final batch, with the valid_cycle advance, committed). */
  recoveryDone(ticketId: string, rid: number): { ok: boolean } {
    const t = this.ticket(ticketId);
    if (this.mode() !== "recovering" || rid !== this.recoveryId() || !t || t.kind !== "wake" || t.recovery !== rid) return { ok: false };
    this.set("recovery_done", rid);
    return { ok: true };
  }
  /** Reopen: from recovering only once its cycle is reported (closing the restore); from a pause only with no restore open. */
  resume(): { ok: true; mode: GateMode } | { ok: false; code: "recovery_running" | "restore_open" } {
    const mode = this.mode();
    if (mode === "recovering" && Number(this.get("recovery_done") ?? 0) !== this.recoveryId()) return { ok: false, code: "recovery_running" };
    if (mode === "paused" && this.get("restore_open") === "1") return { ok: false, code: "restore_open" };
    this.ctx.storage.transactionSync(() => {
      if (mode === "recovering") this.set("restore_open", 0);
      this.set("mode", "normal");
    });
    return { ok: true, mode: "normal" };
  }
  /** Tests only: set the mode directly (the runbook's methods are the only way otherwise). */
  async setMode(mode: GateMode): Promise<{ mode: GateMode } | null> {
    if (!testMode()) return null;
    if (mode !== "normal" && mode !== "paused" && mode !== "recovering") throw new Error("mode");
    this.set("mode", mode);
    return { mode };
  }

  // ---- the alarm: ≤ 500 expired tickets a minute while any row exists; the probe hourly
  /** At issue: cleanup within a minute (an earlier alarm stands). */
  private async arm(): Promise<void> {
    const next = Date.now() + 60_000;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > next) await this.ctx.storage.setAlarm(next);
  }
  /**
   * The next alarm (LIMIT-PRIVATE15-A3-1-2): 5 s while a call is unresolved; a minute while any ticket row
   * exists; otherwise only the hourly probe's.
   */
  private async rearm(): Promise<void> {
    const rows = (this.sql.exec("SELECT count(*) AS n FROM tickets").one() as { n: number }).n;
    // (paused: no probe is due, so it doesn't set the pace)
    const probeIn = this.mode() === "paused" ? PROBE_EVERY_MS : Number(this.get("probe_at") ?? 0) + PROBE_EVERY_MS - this.now();
    let delay = this.unresolved() ? RESOLVE_RETRY_MS : rows > 0 ? 60_000 : Math.max(1000, probeIn);
    // (and the next checkpoint, in normal mode: every 10 min, or its postponement's minute)
    if (this.mode() === "normal" && !this.manualCheckpoints) delay = Math.min(delay, Math.max(1000, Number(this.get("ckpt_next") ?? 0) - this.now()));
    await this.ctx.storage.setAlarm(Date.now() + delay / this.scale);
  }
  async alarm(): Promise<void> {
    if (this.unresolved() && !(await this.resolveSoon())) return;
    this.sql.exec("DELETE FROM tickets WHERE id IN (SELECT id FROM tickets WHERE expires < ? ORDER BY expires LIMIT ?)", this.now(), ALARM_CLEANUP);
    this.sql.exec("DELETE FROM checkpoints WHERE k IN (SELECT k FROM checkpoints WHERE d1_time < ? ORDER BY d1_time LIMIT ?)", this.now() - CKPT_KEEP_MS, ALARM_CLEANUP);
    if (this.mode() === "normal" && !this.manualCheckpoints && this.now() >= Number(this.get("ckpt_next") ?? 0)) {
      const c = await this.checkpointNow();
      // (tests: every attempt's record, in storage: an evicted and recreated instance keeps it; the last 500)
      if (testMode()) {
        const h = JSON.parse(this.get("test_ckpt_history") ?? "[]") as unknown[];
        h.push({ outcome: c.outcome, due_at: c.due_at, late_ms: c.late_ms, revoked: c.revoked, interval_ms: c.interval_ms, attempt: c.attempt, fire_delay_ms: c.fire_delay_ms, due_to_sent_ms: c.due_to_sent_ms, due_to_end_ms: c.due_to_end_ms, decision_to_end_ms: c.decision_to_end_ms, protected_ms: c.protected_ms, txn_ms: c.txn_ms, sent: c.sent, at: this.now() });
        this.set("test_ckpt_history", JSON.stringify(h.slice(-500)));
      }
    }
    if (this.mode() !== "paused" && this.now() - Number(this.get("probe_at") ?? 0) >= PROBE_EVERY_MS) await this.probe();
    else await this.rearm();
  }

  // ---- tests only (no-ops outside test mode)
  async testState(): Promise<{ mode: GateMode; tickets: Ticket[]; calls: unknown[]; next_seq: number; R: number | null; max_deadline: number; alarm: number | null; sends: number; tombstones: number; ckpt_next: number; ckpt: string; recovery_id: number; intents: number; checkpoints: number; ckpt_history: unknown[] } | null> {
    if (!testMode()) return null;
    return {
      alarm: await this.ctx.storage.getAlarm(),
      sends: this.sends,
      tombstones: this.tombstones,
      mode: this.mode(),
      tickets: [...this.sql.exec("SELECT * FROM tickets")] as unknown as Ticket[],
      calls: [...this.sql.exec("SELECT * FROM calls")],
      next_seq: Number(this.get("next_seq") ?? 1),
      R: this.rate(),
      max_deadline: Number(this.get("max_deadline") ?? 0),
      ckpt_next: Number(this.get("ckpt_next") ?? 0),
      ckpt: this.ckpt,
      hold: this.hold !== null,
      active: this.active,
      recovery_id: this.recoveryId(),
      intents: (this.sql.exec("SELECT count(*) AS n FROM intents").one() as { n: number }).n,
      checkpoints: (this.sql.exec("SELECT count(*) AS n FROM checkpoints").one() as { n: number }).n,
      ckpt_history: JSON.parse(this.get("test_ckpt_history") ?? "[]"),
      mode_log: this.modeLog.slice(-12),
      probe_meta: { at: this.get("probe_at"), ok: this.get("probe_ok"), r: this.get("probe_r"), now: this.now() },
    };
  }
  /** Tests: the gate's clock offset, a D1 seam for the next call(s), the call deadline, a probe result, a restart, filler tickets. */
  testSeam(op: { skew?: number; seam?: Seam; probe?: { ok: boolean; R: number; at?: number }; restart?: boolean; fill?: number; fillKind?: TicketKind; clear?: boolean; bucket?: "reset"; deadline_ms?: number; alarm?: boolean; unprobe?: boolean; clear_seam?: boolean; txn_overrun?: "entry" | "recheck"; hold?: boolean; resolve_gap_real_ms?: number; park_read?: number; checkpoints?: "manual" | "auto"; scale?: number; ckpt_fill?: number; ckpt_fill_age_ms?: number; ckpt_next?: number; ckpt_attempt?: number; issued_ago?: { id: string; ms: number }; virtual?: boolean; stuck_active?: boolean; rearm?: boolean; alarm_in?: number; gap_ms?: number }): boolean {
    if (!testMode()) return false;
    if (op.virtual === true && this.virtual === null) this.virtual = this.now();
    if (op.virtual === false) this.virtual = null;
    if (op.stuck_active === true && !this.stuck) {
      this.stuck = true;
      this.active++;
    }
    if (op.stuck_active === false && this.stuck) {
      this.stuck = false;
      this.active--;
    }
    if (op.skew !== undefined) this.skew = op.skew;
    if (op.deadline_ms !== undefined) this.deadlineMs = op.deadline_ms || CALL_DEADLINE_MS;
    if (op.clear) this.sql.exec("DELETE FROM tickets WHERE owner = 'fill'");
    if (op.seam) this.seam = op.seam;
    if (op.clear_seam) this.seam = null;
    if (op.txn_overrun) this.txnOverrun = op.txn_overrun;
    if (op.park_read !== undefined) this.parkReads = op.park_read;
    if (op.resolve_gap_real_ms !== undefined) this.resolveGapRealMs = op.resolve_gap_real_ms;
    // (a checkpoint's hold, by itself: the queue's items wait at the front until it is released)
    if (op.hold === true && !this.hold) this.hold = new Promise<void>((r) => (this.testRelease = r));
    if (op.hold === false && this.hold) {
      this.hold = null;
      this.testRelease?.();
    }
    if (op.probe) {
      this.set("probe_at", op.probe.at ?? this.now());
      this.set("probe_ok", op.probe.ok ? 1 : 0);
      this.set("probe_r", op.probe.R);
    }
    if (op.restart) this.instance = randomHex(16);
    if (op.bucket === "reset") this.buckets.clear();
    if (op.unprobe) this.sql.exec("DELETE FROM meta WHERE k IN ('probe_at', 'probe_ok', 'probe_r')");
    if (op.alarm) void this.alarm();
    // (the runtime's own alarm, armed now; `alarm` calls the handler directly, beside any scheduled one)
    if (op.rearm) void this.rearm();
    // (the alarm, moved `alarm_in` ms ahead: no alarm's cleanup runs inside a test's window)
    if (op.alarm_in !== undefined) void this.ctx.storage.setAlarm(Date.now() + op.alarm_in);
    // (a fixed requested gap, within the protocol's [2000, 2100]; 0 restores the random one)
    if (op.gap_ms !== undefined) this.gapMs = op.gap_ms >= 2000 && op.gap_ms <= 2100 ? op.gap_ms : null;
    if (op.checkpoints) this.set("test_manual_ckpt", op.checkpoints === "manual" ? 1 : 0);
    if (op.scale !== undefined) {
      this.scaleBase = Date.now();
      this.scale = op.scale || 1;
    }
    if (op.ckpt_attempt !== undefined) this.set("ckpt_attempt", op.ckpt_attempt);
    if (op.ckpt_next !== undefined) {
      this.set("ckpt_next", op.ckpt_next);
      this.sql.exec("DELETE FROM meta WHERE k = 'ckpt_due'");
    }
    // (a full or nearly full log, of old-looking rows below every real k)
    if (op.ckpt_fill !== undefined) {
      this.sql.exec("DELETE FROM checkpoints WHERE k < 0");
      for (let i = 0; i < op.ckpt_fill; i++) this.sql.exec("INSERT INTO checkpoints (k, nonce, d1_time) VALUES (?, 'fill', ?)", -1 - i, this.now() - (op.ckpt_fill_age_ms ?? 86400_000));
    }
    // (a ticket as if issued `ms` earlier: less time left, for the barrier's tests)
    if (op.issued_ago) this.sql.exec("UPDATE tickets SET expires = expires - ?, issued = issued - ? WHERE id = ?", op.issued_ago.ms, op.issued_ago.ms, op.issued_ago.id);
    if (op.fill) {
      const now = this.now();
      for (let i = 0; i < op.fill; i++) this.sql.exec("INSERT INTO tickets (id, kind, owner, issued, expires, w) VALUES (?, ?, 'fill', ?, ?, 2)", randomHex(16), op.fillKind ?? "assignment", now, now + 60_000);
    }
    return true;
  }
  /** Tests: send the (first n) batches the `late` seam held back, now, in order; each one's D1 answer. */
  async testReleaseLate(n?: number): Promise<string[] | null> {
    if (!testMode()) return null;
    const out: string[] = [];
    for (const b of this.lateBatches.splice(0, n ?? this.lateBatches.length)) {
      try {
        await this.db().batch(b);
        out.push("committed");
      } catch (e) {
        out.push(String((e as Error)?.message ?? e));
      }
    }
    return out;
  }
}
