// Remotes, step (b2a): the relay (core design remote-v1 r1.9 §3, §5, §13.6; terminal addendum T1.4 §T2; both DESIGN
// CLEAR).  One RemoteRelay Durable Object per remote (named by its remote_id) joins the remote's one peer leg (the
// runner or agent, dialing out) and its page legs (the person's pages, on this site), as a pipe for text messages:
//
//   - legs reach it only through the Worker (server.ts), which authenticated them first: the peer by the Worker's
//     challenge and the enrolled key (verifyChallenge), a page by its session, its account owning the remote; the
//     headers it sets here are its own, never a client's;
//   - the peer's challenge is consumed here, once: a durable used-set of challenge ids, each kept until its expiry,
//     at most 4 outstanding (4429 past that; an unexpired consumed id is never evicted, r1.8);
//   - a newer peer replaces the older one (4009), after it was authenticated; a peer leg's loss closes its pages
//     (4001); a revoked remote (a durable write here, the linearization point, §3) closes both legs (4403) and is
//     refused for good;
//   - each page leg has a generation, never reused (a durable counter), and a channel from the caps table (kernel,
//     terminal; agent for agents).  The peer learns of it by page-open {conn, kind, chan, gen} and of its end by
//     page-close {conn, gen}; the peer ends one page by close {gen};
//   - on the peer leg every application message carries its page's generation, `<gen>\n`, added here to a page's
//     messages and taken off the peer's (the relay reads at most 17 bytes of it, and never parses the rest, §13.5);
//     a peer message for a generation with no page attached is answered dropped {gen, bytes} and not forwarded;
//   - controls are recognized only by the exact prefix {"relay":" and strict-parsed (<= 256 bytes, the one
//     serialization, fixed keys in order); each op from one side only (peer: close; both: ping, answered by
//     here, its pong charged like any control (r1.10: no platform auto-response, which would answer outside the
//     relay's accounting: astra's #109 r2 note)); an application message is never parsed;
//   - text only (binary: 1003); each message's UTF-8 bytes are counted whole against its channel's caps (1009);
//   - every buffer here is bounded: the relay forwards at once or closes, except that a leg's frames may wait for a
//     byte lease in its queue, bounded by its allowance (b5: queues, charged); what a receiver hasn't
//     read yet (the runtime's send queue to it) is bounded by its window, proved by receipts (§5).  Everything sent to
//     a receiver is charged against it, data and the relay's own controls (page-open, page-close, dropped) alike, each
//     message its bytes plus a fixed overhead (so empty and small messages count); after every receiptEvery charged
//     bytes the relay sends {"relay":"receipt","r","upto"} behind them, the receiver acks the token (only a token issued
//     to that very connection, once, cumulative), and a message that would put the receiver over its window, or find
//     all 16 tokens outstanding, closes its sender (or whoever caused a control) 1013, unsent.
//
// Account accounting (the day budget and its leases, connected slots, rate buckets, the deadline alarm) is step b2b.  Not bound in any deployment until step b4 (@sagebrush): until then this class is exported and unused.
import { DurableObject } from "cloudflare:workers";

import { RELAY_CAPS, PEER_WINDOW, capsFor, peerWindow, type Kind, type Chan } from "./relay-caps.ts";
export { RELAY_CAPS, PEER_WINDOW };
export const RELAY_LIMITS = Object.freeze({
  control: 256, // a control message's bytes
  challenges: 4, // consumed, unexpired challenge ids per remote
  prefix: 17, // the generation prefix's most bytes (16 digits and the newline)
  tokens: 16, // receipts outstanding per receiver connection
  receiptEvery: 1024 * 1024, // bytes forwarded to a receiver between receipts (at most a quarter of its window)
  overhead: 256, // what each message sent to a receiver is charged on top of its bytes (so empty and small ones count)
});
const SAFE = 2 ** 53 - 1;
const enc = new TextEncoder();
const CONTROL = '{"relay":"';
const PREFIX = /^([1-9][0-9]{0,15})\n/;
const PING = '{"relay":"ping"}';
const PONG = '{"relay":"pong"}';

// (close codes: §5, §10, §13.6)
export const CLOSE = Object.freeze({
  runnerGone: 4001, // a page whose peer left
  replaced: 4009, // a peer (or a page) replaced by a newer one
  forbidden: 4403, // revoked
  closedByPeer: 4000, // a page the peer ended (close {gen})
});

/** A receiver connection's account of what it hasn't acknowledged (§5): bytes sent to it, the highest receipted
 * `upto` it acked, bytes since the last receipt, and its open tokens. */
type Rx = { sent: number; acked: number; since: number; tokens: [string, number][] };
// (ping: the time of the leg's last valid ping, or of its accept (r1.11); bucket: its rate tokens and their time)
type Bucket = { t: number; at: number };
type PeerAtt = { leg: "peer"; pg: number; account: string; kind: Kind; rx: Rx; ping: number; bucket: Bucket; ended?: boolean };
type PageAtt = { leg: "page"; gen: number; conn: string; kind: Kind; chan: Chan; account: string; rx: Rx; ping: number; bucket: Bucket; ended?: boolean };
type Att = PeerAtt | PageAtt;

const newRx = (): Rx => ({ sent: 0, acked: 0, since: 0, tokens: [] });
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const bytes = (s: string) => enc.encode(s).length;

/**
 * A control message, strictly (§5, r1.8 R17-CONTROL), or null: <= 256 bytes, `relay` first, then exactly the op's
 * keys in order, each value checked, and the text exactly its one serialization.  `ops` are the ops this side may
 * send, with their keys.
 */
export function parseControl(text: string, ops: Record<string, string[]>): Record<string, unknown> | null {
  if (!text.startsWith(CONTROL) || bytes(text) > RELAY_LIMITS.control) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const op = o.relay;
  if (typeof op !== "string" || !Object.hasOwn(ops, op)) return null;
  const keys = ["relay", ...ops[op]];
  if (Object.keys(o).join() !== keys.join()) return null;
  for (const k of ops[op]) {
    const x = o[k];
    if (k === "gen" && !(Number.isInteger(x) && (x as number) >= 1 && (x as number) <= SAFE)) return null;
    if (k === "r" && !(typeof x === "string" && /^[A-Za-z0-9_-]{22}$/.test(x))) return null;
  }
  // (the one serialization: no whitespace, no escapes, no duplicate keys (JSON.parse keeps the last; the re-serialized
  // text then differs), integers only)
  return JSON.stringify(o) === text ? o : null;
}
export const PEER_OPS: Record<string, string[]> = { close: ["gen"], ack: ["r"], ping: [] };

/** What a peer's text is: a control (strictly parsed), an application message for a generation, or neither (1008). */
export function classifyPeer(text: string): { control: Record<string, unknown> } | { gen: number; payload: string } | null {
  if (text.startsWith(CONTROL)) {
    const c = parseControl(text, PEER_OPS);
    return c ? { control: c } : null;
  }
  const m = PREFIX.exec(text.slice(0, RELAY_LIMITS.prefix));
  const gen = m ? Number(m[1]) : NaN;
  return m && gen <= SAFE ? { gen, payload: text.slice(m[0].length) } : null;
}
export const PAGE_OPS: Record<string, string[]> = { ack: ["r"], ping: [] };

export interface RelayEnv {
  REMOTE_RELAY?: DurableObjectNamespace;
  REMOTE_ACCOUNT?: DurableObjectNamespace;
}

// (b2b, §5: the account's leases, the per-leg rate, and dead legs (r1.11))
export const RELAY_ACCOUNTING = Object.freeze({
  rate: { runner: 50, agent: 120 } as Record<Kind, number>, // messages per second per leg, from a durable bucket
  burst: 200,
  deadMs: 40_000, // a leg with no valid ping for this long is dead (r1.11: the relay's own record of its pings)
});
/** A byte lease from the account (account.ts): `consumed` is written before each send it pays for. */
type Lease = { id: string; day: string; granted: number; consumed: number };
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** A frame waiting in its sending leg's queue (b5): its payload's bytes (what it consumes), what it is charged against
 * the leg's allowance, and its send (which re-finds and checks its receiver). */
type Frame = { n: number; cost: number; send: () => boolean; target: () => boolean };
/** A leg's queue (b5): its frames in arrival order, the sum of their costs (the head frame's included until it is sent
 * or dropped), whether its one drain runs, and its cancellation (a drop: the suspended drain settles at once).  Owned by
 * the `queues` map: dropping it deletes the entry, empties it (the payloads and their sends released) and cancels it. */
type Queue = { frames: Frame[]; bytes: number; draining: boolean; dead: boolean; waiter: ((v: boolean | typeof CANCELLED) => void) | null; job: LeaseJob | null };
/** A turn waiting its place among the stored leases' read-modify-writes: removed, unrun, when its queue is dropped. */
type LeaseJob = { f: () => Promise<unknown>; done: (ok: boolean, v: unknown) => void; q: Queue | null; pending: boolean };
const CANCELLED = Symbol("cancelled");
const SKIPPED = Symbol("skipped"); // (a frame whose receiver is gone before its debit: dropped, never charged)

export class RemoteRelay extends DurableObject<RelayEnv> {
  // (b5: each sending leg's frames waiting to be paid for and sent, in order, bounded by its allowance; memory only, as
  // the awaits they wait on are.  A leg's end deletes its entry: that one deletion drops its frames and refunds them)
  private queues = new Map<WebSocket, Queue>();
  private fetching: Promise<boolean> | null = null; // (one lease request at a time, shared by whoever needs it)
  // (the legs waiting on that request's answer: one entry per live queue at most, removed when told or dropped)
  private fetchWaiters = new Set<(v: boolean | typeof CANCELLED) => void>();
  private revoking = false; // (a revoke has begun here: set before its durable write, which a later instance reads)
  // (every read-modify-write of the stored leases runs alone, in order: legs resuming together from one lease request
  // would otherwise each spend their own copy of the same credit, and one write would lose the other's (astra's LEASE-1))
  private leaseJobs: LeaseJob[] = [];
  private leaseBusy = false;
  private settling = new Set<Promise<void>>(); // (settlements under way: a lease request waits for them)

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    // (no auto-response for heartbeats (r1.10): a pong the runtime sent by itself would escape the relay's accounting,
    // so a leg pinging without reading could grow its own send queue without bound (astra's #109 r2 note).  Pings
    // are answered here, each pong charged to that leg's window like any control; the cost (a wake per heartbeat) is
    // measured at b4.)
  }

  /** The clock (ms).  (Tests: a subclass with a logical one.) */
  protected now(): number {
    return Date.now();
  }

  /** A leg's rate: messages per second and the burst.  (Tests: a subclass may relax it for floods that aren't about it.) */
  protected rateOf(kind: Kind): { rate: number; burst: number } {
    return { rate: RELAY_ACCOUNTING.rate[kind], burst: RELAY_ACCOUNTING.burst };
  }

  private att(ws: WebSocket): Att {
    return ws.deserializeAttachment() as Att;
  }

  // ---- the account (account.ts): slots and byte leases
  private async acct(account: string, op: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const ns = this.env.REMOTE_ACCOUNT!;
    const r = await ns.get(ns.idFromName(account)).fetch(`https://account/${op}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: r.status, body: ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  }
  /** Run f alone among the stored leases' read-modify-writes, in order (LEASE-1); its failure doesn't stop the ones
   * after it.  A payment's turn (q given) waits as a removable job: a drop of q takes it out unrun and resolves it
   * CANCELLED, so a dead leg leaves nothing queued behind a held turn (daybreak3's B5-CANCEL-LEASED-1). */
  private leased<T>(f: () => Promise<T>, q: Queue | null = null): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: LeaseJob = { f, q, pending: true, done: (ok, v) => (ok ? resolve(v as T) : reject(v)) };
      if (q) q.job = job;
      this.leaseJobs.push(job);
      void this.leaseRun();
    });
  }
  private async leaseRun(): Promise<void> {
    if (this.leaseBusy) return;
    this.leaseBusy = true;
    try {
      for (let job = this.leaseJobs.shift(); job; job = this.leaseJobs.shift()) {
        job.pending = false;
        if (job.q && job.q.job === job) job.q.job = null;
        try {
          job.done(true, await job.f());
        } catch (e) {
          job.done(false, e);
        }
      }
    } finally {
      this.leaseBusy = false;
    }
  }
  /** Today's unconsumed leases and their credit; a past day's are void (§5 r1.7): settled with the account, never spent.
   * (Only inside leased().) */
  private async credit(): Promise<{ day: string; leases: Lease[]; credit: number }> {
    const day = utcDay(this.now());
    const all = (await this.ctx.storage.get<Lease[]>("leases")) ?? [];
    const leases = all.filter((l) => l.day === day && l.consumed < l.granted);
    if (leases.length !== all.length) {
      await this.ctx.storage.put("leases", leases);
      for (const l of all) if (!leases.includes(l)) this.settleSoon(l);
    }
    return { day, leases, credit: leases.reduce((n, l) => n + l.granted - l.consumed, 0) };
  }
  /** Settle a lease the relay is done with, tracked: a lease request waits for every settlement already under way, so
   * the account never counts a spent lease as outstanding against a refill (daybreak3's B5-SETTLE-REFILL-1). */
  private settleSoon(l: Lease): void {
    const p: Promise<void> = this.settle(l).finally(() => this.settling.delete(p));
    this.settling.add(p);
  }
  private async settle(l: Lease): Promise<void> {
    const account = await this.ctx.storage.get<string>("account");
    if (account && this.env.REMOTE_ACCOUNT) await this.acct(account, "settle", { id: l.id, consumed: l.consumed }).catch(() => {});
  }
  /** A new lease from the account (one request at a time, shared): true if one was granted.  One granted after a
   * revoke (its request was out when the revoke settled the leases) is never installed: settled at once, unspent
   * (daybreak3's ENGINE-2). */
  private reserve(account: string, kind: Kind): Promise<boolean> {
    if (this.fetching) return this.fetching;
    const waiters = (this.fetchWaiters = new Set());
    this.fetching = (async () => {
      try {
        // (the settlements under way first: the slots they free are this request's to use (B5-SETTLE-REFILL-1))
        while (this.settling.size) await Promise.all([...this.settling]);
        const remote = await this.ctx.storage.get<string>("remote");
        const r = await this.acct(account, "lease", { remote_id: remote, kind, account });
        if (r.status !== 200) return false;
        const l: Lease = { id: r.body.id as string, day: r.body.day as string, granted: r.body.bytes as number, consumed: 0 };
        const installed = await this.leased(async () => {
          if (await this.ctx.storage.get("revoked")) return false;
          const leases = (await this.ctx.storage.get<Lease[]>("leases")) ?? [];
          leases.push(l);
          await this.ctx.storage.put("leases", leases);
          return true;
        });
        if (!installed) await this.settle(l);
        return installed;
      } catch {
        return false;
      }
    })().finally(() => {
      this.fetching = null;
    });
    // (its one reaction: every leg still waiting on this request is told its answer)
    void this.fetching.then((ok) => {
      for (const w of [...waiters]) w(ok);
    });
    return this.fetching;
  }
  /** Consume n bytes of today's leases, durably (before the send it pays for): a lease used up is settled and dropped. */
  private async consume(n: number, leases: Lease[]): Promise<void> {
    let left = n;
    for (const l of leases) {
      const take = Math.min(left, l.granted - l.consumed);
      l.consumed += take;
      left -= take;
      if (!left) break;
    }
    const open = leases.filter((l) => l.consumed < l.granted);
    await this.ctx.storage.put("leases", open);
    for (const l of leases) if (!open.includes(l)) this.settleSoon(l);
  }
  /** A leg's allowance for waiting frames (b5): a page's, its channel's receive window; the peer's, one kind-wide
   * window across all its pages (it multiplexes them, so one counter bounds them all). */
  private allowance(a: Att): number {
    return a.leg === "page" ? capsFor(a.kind, (a as PageAtt).chan)!.window : peerWindow(a.kind)!;
  }
  /** Drop a leg's queue, once: the entry deleted (its allowance refunded), its frames released (payloads and sends, the
   * head's too: the drain holds none across its awaits), and its drain cancelled, so nothing of it waits on the account's
   * answer (astra's B5-RETAIN-1). */
  private drop(ws: WebSocket): void {
    const q = this.queues.get(ws);
    if (!q) return;
    this.queues.delete(ws);
    q.frames = [];
    q.bytes = 0;
    // (cancelled: its payment stops at its next step, charging nothing and asking for no lease; a wait for the account's
    // answer is let go now, its entry removed (B5-CANCEL-PAY-1))
    q.dead = true;
    q.waiter?.(CANCELLED);
    const job = q.job;
    if (job?.pending) {
      job.pending = false;
      q.job = null;
      this.leaseJobs.splice(this.leaseJobs.indexOf(job), 1);
      job.done(true, CANCELLED);
    }
  }
  /**
   * An application frame from `from` (§5, b5): admitted at once, in arrival order, before any await, against its leg's
   * allowance at `cost` (its bytes, its prefix's and RELAY_LIMITS.overhead, so empty and tiny frames count); one that
   * doesn't fit closes the leg 1013, and nothing it sent is forwarded after that.  Admitted, it waits its turn in the
   * leg's queue, which one drain at a time pays for and sends.  The handler that started the drain awaits it.
   */
  private charged(from: WebSocket, a: Att, n: number, cost: number, send: () => boolean, target: () => boolean): Promise<void> {
    let q = this.queues.get(from);
    if (!q) this.queues.set(from, (q = { frames: [], bytes: 0, draining: false, dead: false, waiter: null, job: null }));
    if (q.bytes + cost > this.allowance(a)) {
      this.close(from, 1013, "too much waiting for the account's byte lease");
      return Promise.resolve();
    }
    q.frames.push({ n, cost, send, target });
    q.bytes += cost;
    return q.draining ? Promise.resolve() : this.drain(from, a, q);
  }
  /**
   * A leg's one drain: its frames in order, each paid for (today's lease credit, reserved from the account if short)
   * and then sent, or not.  The head frame stays counted in the allowance until it is sent or dropped.  After every
   * await: the queue still this leg's (an end deleted it: nothing more, and nothing of it reaches a replacement leg),
   * the consumption written before the send, then the final check: the sender live, the remote not revoked, the lease
   * still today's.  Refused (the day's budget): the leg closes 4429, its queue dropped, nothing sent.
   */
  private async drain(from: WebSocket, a: Att, q: Queue): Promise<void> {
    q.draining = true;
    try {
      while (this.queues.get(from) === q && q.frames.length) {
        // (only the head's size across the awaits, never the frame itself: a drop meanwhile releases it at once)
        const { n, target } = q.frames[0];
        const c = await this.payFor(a, n, q, target);
        // (the payment's linearization point is its debit write (@sagebrush, Nov 7): an end of the leg, or a revoke, seen
        // before the write begins charges nothing (payFor's checks); one during or after it may leave this one frame paid
        // and unsent, at most its bytes, recorded as paidUnsent.  From here to the send nothing awaits.  The queue still
        // this leg's: every end of the leg (its close, a replacement, a revoke) drops it first, so this is the sender's
        // liveness check too, and a frame of an ended leg never goes on, to anyone; a revoke begun meanwhile (`revoking`,
        // set before its durable write) stops it too)
        if (c === CANCELLED) return;
        if (c === SKIPPED) {
          // (its receiver gone before the debit: dropped unpaid, the next frame's turn (B5-PAID-UNSENT-2))
          const f = q.frames.shift()!;
          q.bytes -= f.cost;
          continue;
        }
        const paid = c !== null && c !== "revoked";
        if (this.queues.get(from) !== q) return paid ? this.paidUnsent(n) : undefined;
        if (c === null) return this.close(from, 4429, "the account's relay budget for today is used up");
        if (c === "revoked" || this.revoking) {
          if (paid) this.paidUnsent(n);
          return this.drop(from);
        }
        const f = q.frames.shift()!;
        q.bytes -= f.cost;
        // (paid from a lease that was yesterday's by the time it was spent: never sent, as before, and recorded; the
        // next is paid today)
        if (utcDay(this.now()) !== c.day) {
          this.paidUnsent(n);
          continue;
        }
        // (a known no-send after the debit (the receiver gone or replaced meanwhile, its window refusing, the socket's
        // send failing) is recorded once, as paid and unsent (B5-PAID-UNSENT-2))
        if (!f.send()) this.paidUnsent(n);
        // (kept ahead (b5): while traffic flows, two leases open (the most a remote may hold), so the next burst finds
        // credit; the second is never asked for at accept: an idle connection holds one (@sagebrush's policy, Nov 7))
        if (c.leases.filter((l) => l.consumed < l.granted).length < 2) void this.reserve(a.account, a.kind);
      }
    } catch (e) {
      if (this.queues.get(from) === q) this.drop(from);
      throw e;
    } finally {
      q.draining = false;
      if (this.queues.get(from) === q && !q.frames.length) this.queues.delete(from);
    }
  }
  /** Bytes paid for frames that were then not sent (their leg ended, or a revoke began, during or after the debit
   * write; or the day turned): counted durably, at most one frame per leg each time, so the charge is visible. */
  private paidUnsent(n: number): void {
    void this.leased(async () => {
      await this.ctx.storage.put("paidUnsent", ((await this.ctx.storage.get<number>("paidUnsent")) ?? 0) + n);
    });
  }
  /** Pay n bytes for q's head: the credit read and its consumption in one leased() turn (LEASE-1); short, a lease
   * reserved (outside leased(): the reserve enters it itself) and the credit read again.  Revoked: nothing spent.  null:
   * refused.  q dropped meanwhile: CANCELLED, at its next step: its leased() turn removed unrun, or inside the turn
   * right before the debit write begins, so a frame cancelled before its debit is never charged and never asks for a
   * lease (@sagebrush, Nov 7: B5-CANCEL-PAY-1). */
  private async payFor(a: Att, n: number, q: Queue, target: () => boolean): Promise<{ day: string; leases: Lease[]; credit: number } | "revoked" | null | typeof CANCELLED | typeof SKIPPED> {
    const pay = () => this.leased(async () => {
      if (q.dead) return CANCELLED;
      if (!target()) return SKIPPED;
      if (this.revoking || (await this.ctx.storage.get("revoked"))) return "revoked" as const;
      const c = await this.credit();
      if (c.credit < n) return null;
      // (the last checks, synchronous, right before the debit write begins: the payment's linearization point)
      if (q.dead) return CANCELLED;
      if (this.revoking) return "revoked" as const;
      if (!target()) return SKIPPED; // (its receiver gone before the debit: never charged)
      await this.consume(n, c.leases);
      return c;
    }, q);
    // (another leg's drain may spend a lease this one waited for: a few rounds, then the account's answer stands)
    for (let round = 0; round < 3; round++) {
      const c = await pay();
      if (c) return c;
      const ok = await this.leaseWait(a, q);
      if (ok === CANCELLED) return CANCELLED;
      if (!ok) return pay();
    }
    return pay();
  }
  /** Wait for a lease request's answer (starting one if none is out), as q's one waiter: an entry in that request's
   * waiter set, which its one reaction resolves; a drop of q resolves and removes it at once (CANCELLED), so a cancelled
   * leg leaves nothing attached to the account's answer (B5-CANCEL-PAY-1).  At most one waiter per live queue. */
  private leaseWait(a: Att, q: Queue): Promise<boolean | typeof CANCELLED> {
    if (q.dead) return Promise.resolve(CANCELLED);
    void this.reserve(a.account, a.kind);
    const set = this.fetchWaiters;
    return new Promise((resolve) => {
      const w = (v: boolean | typeof CANCELLED) => {
        set.delete(w);
        if (q.waiter === w) q.waiter = null;
        resolve(v);
      };
      set.add(w);
      q.waiter = w;
    });
  }

  // ---- dead legs (r1.11): one alarm at the earliest deadline, while a page is attached
  private async arm(): Promise<void> {
    const pages = this.pages();
    if (!pages.length) return this.ctx.storage.deleteAlarm();
    const legs = [...this.peers(), ...pages];
    await this.ctx.storage.setAlarm(Math.min(...legs.map((w) => this.att(w).ping)) + RELAY_ACCOUNTING.deadMs);
  }
  /** The alarm: every leg rereads its own last ping now; one RELAY_ACCOUNTING.deadMs stale is closed (a peer 4001, a page
   * 1001), whatever the alarm was set for; then the next deadline, or none without a page.  An alarm that fires with
   * no page left (set before the last one went) closes nothing: it is only cancelled (astra's ALARM-1). */
  async alarm(): Promise<void> {
    if (!this.pages().length) return this.ctx.storage.deleteAlarm();
    const now = this.now();
    for (const w of [...this.peers(), ...this.pages()]) {
      const a = this.att(w);
      if (now - a.ping < RELAY_ACCOUNTING.deadMs) continue;
      if (a.leg === "peer") this.close(w, CLOSE.runnerGone, "no ping for 40 s");
      else this.close(w, 1001, "no ping for 40 s");
    }
    await this.arm();
  }
  private async release(a: PeerAtt): Promise<void> {
    const remote = await this.ctx.storage.get<string>("remote");
    if (remote && this.env.REMOTE_ACCOUNT) await this.acct(a.account, "release", { remote_id: remote, gen: a.pg }).catch(() => {});
  }
  // (the legs still open: one this relay closed may linger in getWebSockets until its close completes, and must
  // never be taken for the peer, or for a page, again)
  private live(w: WebSocket): boolean {
    try {
      return w.readyState === WebSocket.OPEN && !(this.att(w) as Att).ended;
    } catch {
      return false;
    }
  }
  private peers(): WebSocket[] {
    return this.ctx.getWebSockets("peer").filter((w) => this.live(w));
  }
  private pages(): WebSocket[] {
    return this.ctx.getWebSockets("page").filter((w) => this.live(w));
  }
  private page(gen: number): WebSocket | undefined {
    return this.ctx.getWebSockets(`g:${gen}`).find((w) => this.live(w));
  }
  /** Send on a leg: true if the runtime took it (a local send failure, the leg already gone, is false: its close
   * handler does the rest). */
  private send(ws: WebSocket | undefined, text: string): boolean {
    if (!ws) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }
  /** Close a leg from here, and settle what its end means at once (a page's page-close, a peer's pages), not only
   * when (or if) its close handler runs; settling twice is harmless. */
  private close(ws: WebSocket, code: number, reason: string): void {
    this.drop(ws);
    const wasLive = this.live(ws);
    try {
      ws.close(code, reason);
    } catch {
      // (already closed)
    }
    if (wasLive) this.gone(ws);
  }
  /** End a peer leg from here: marked first, so nothing it still sends is taken, and it is never taken for the peer. */
  private endPeer(p: WebSocket, code: number, reason: string): void {
    this.drop(p);
    const a = this.att(p) as PeerAtt;
    if (a.ended) return;
    a.ended = true;
    p.serializeAttachment(a);
    try {
      p.close(code, reason);
    } catch {
      // (already closed)
    }
  }
  /** End a page from here: marked first, so its own close handler doesn't announce it again; `announce` sends the
   * peer its page-close now (not when the peer itself is going: it never hears of that page again). */
  private endPage(p: WebSocket, code: number, reason: string, announce: boolean): void {
    this.drop(p);
    const a = this.att(p) as PageAtt;
    if (a.ended) return;
    a.ended = true;
    p.serializeAttachment(a);
    try {
      p.close(code, reason);
    } catch {
      // (already closed)
    }
    if (announce) this.pageClose(a);
  }
  private pageOpen(peer: WebSocket | undefined, a: PageAtt, kind: Kind): void {
    if (peer) this.sendControl(peer, peer, this.att(peer), JSON.stringify({ relay: "page-open", conn: a.conn, kind, chan: a.chan, gen: a.gen }));
  }
  private pageClose(a: PageAtt): void {
    for (const p of this.peers()) this.sendControl(p, p, this.att(p), JSON.stringify({ relay: "page-close", conn: a.conn, gen: a.gen }));
  }

  /** The Worker's internal requests: the legs' upgrades (authenticated there) and revoke. */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const h = req.headers;
    const no = (status: number, error: string) => Response.json({ error }, { status });
    if (url.pathname === "/revoke") return this.revoke();
    if (h.get("upgrade")?.toLowerCase() !== "websocket") return no(426, "upgrade required");
    if (await this.ctx.storage.get("revoked")) return no(403, "revoked");
    const account = h.get("x-r-account") ?? "";
    // (accounting is mandatory: without the account's object nothing is admitted (b2b))
    if (!this.env.REMOTE_ACCOUNT) return no(503, "accounting unavailable");
    const remote = h.get("x-r-remote") ?? "";
    if (!/^r[A-Za-z0-9_-]{20}$/.test(remote)) return no(400, "bad request");
    if ((await this.ctx.storage.get("remote")) !== remote) await this.ctx.storage.put("remote", remote);
    if (url.pathname === "/peer") return this.acceptPeer(account, h.get("x-r-kind") as Kind, h.get("x-r-chal") ?? "", Number(h.get("x-r-exp")));
    if (url.pathname === "/page") return this.acceptPage(account, h.get("x-r-kind") as Kind, h.get("x-r-chan") as Chan);
    return no(404, "not found");
  }

  private async acceptPeer(account: string, kind: Kind, chal: string, exp: number): Promise<Response> {
    const no = (status: number, error: string) => Response.json({ error }, { status });
    if (peerWindow(kind) === null || !/^[A-Za-z0-9_-]{22}$/.test(chal) || !Number.isFinite(exp)) return no(400, "bad request");
    // (the challenge, once: the used-set holds each id until its own expiry, at most `challenges` at a time; an
    // unexpired used id is never dropped to make room (r1.8))
    const now = Math.floor(Date.now() / 1000);
    const used = await this.ctx.storage.list<number>({ prefix: "chal:" });
    const gone: string[] = [];
    let live = 0;
    for (const [k, e] of used) {
      if (e < now) gone.push(k);
      else live++;
    }
    if (gone.length) await this.ctx.storage.delete(gone);
    if (used.has(`chal:${chal}`) && !gone.includes(`chal:${chal}`)) return no(403, "challenge used");
    if (exp < now) return no(403, "challenge expired");
    if (live >= RELAY_LIMITS.challenges) return no(429, "too many connections");
    const pg = ((await this.ctx.storage.get<number>("peerGen")) ?? 0) + 1;
    await this.ctx.storage.put({ [`chal:${chal}`]: exp, peerGen: pg, account, kind });
    if (await this.ctx.storage.get("revoked")) return no(403, "revoked"); // (a revoke during the awaits above)
    // (a connected slot from the account (§5: at most 2 per account), held by this generation; then, after that await,
    // the checks again: not revoked, and still the newest peer (a newer one holds the slot with its own gen))
    const remote = await this.ctx.storage.get<string>("remote");
    const slot = await this.acct(account, "acquire", { remote_id: remote, gen: pg });
    if (slot.status === 429) return no(429, "connected");
    if (slot.status !== 200) return no(409, "superseded");
    // (refused after the slot was granted: it goes back, this generation's only, so a newer holder keeps its own;
    // no leg was accepted whose end would give it back (daybreak3's ENGINE-1, astra's SLOT-1))
    const refuse = async (status: number, error: string) => {
      await this.acct(account, "release", { remote_id: remote, gen: pg }).catch(() => {});
      return no(status, error);
    };
    if (await this.ctx.storage.get("revoked")) return refuse(403, "revoked");
    if ((await this.ctx.storage.get<number>("peerGen")) !== pg) return refuse(409, "superseded");
    // ---- from here to the accept, nothing awaits
    const old = this.peers();
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["peer"]);
    const t0 = this.now();
    pair[1].serializeAttachment({ leg: "peer", pg, account, kind, rx: newRx(), ping: t0, bucket: { t: this.rateOf(kind).burst, at: t0 } } satisfies PeerAtt);
    // (the newer peer, authenticated, replaces the older; the pages, paired with the older, end too: they reconnect
    // and pair again with the new one (R1, R9))
    for (const o of old) this.endPeer(o, CLOSE.replaced, "replaced by a newer connection with this key");
    for (const p of this.pages()) this.endPage(p, CLOSE.runnerGone, "the remote reconnected", false);
    void this.reserve(account, kind); // (a lease ready before the first message, so it doesn't wait)
    await this.arm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async acceptPage(account: string, kind: Kind, chan: Chan): Promise<Response> {
    const no = (status: number, error: string) => Response.json({ error }, { status });
    const caps = capsFor(kind, chan);
    if (!caps) return no(400, "unknown channel");
    const gen = ((await this.ctx.storage.get<number>("gen")) ?? 0) + 1;
    await this.ctx.storage.put("gen", gen); // (never reused, across hibernation and eviction)
    if (await this.ctx.storage.get("revoked")) return no(403, "revoked");
    // ---- from here to the accept, nothing awaits
    const peer = this.peers()[0];
    if (!peer || (this.att(peer) as PeerAtt).kind !== kind) return no(503, "the remote isn't connected");
    const same = this.pages().filter((p) => (this.att(p) as PageAtt).chan === chan);
    const t0 = this.now();
    const a: PageAtt = { leg: "page", gen, conn: b64url(crypto.getRandomValues(new Uint8Array(12))), kind, chan, account, rx: newRx(), ping: t0, bucket: { t: this.rateOf(kind).burst, at: t0 } };
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["page", `g:${gen}`]);
    pair[1].serializeAttachment(a);
    // (at most `legs` pages of a channel: the oldest gives way (4009), its page-close before the new page-open)
    const live = same.filter((p) => !(this.att(p) as PageAtt).ended);
    if (live.length >= caps.legs) {
      const oldest = live.sort((x, y) => (this.att(x) as PageAtt).gen - (this.att(y) as PageAtt).gen)[0];
      this.endPage(oldest, CLOSE.replaced, "opened in another page", true);
    }
    this.pageOpen(peer, a, kind);
    await this.arm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** The linearization point of a revoke (§3): the durable write, then, in the same turn, both legs closed. */
  private async revoke(): Promise<Response> {
    this.revoking = true; // (in memory, before the durable write: no payment or send begins from here on (b5))
    await this.ctx.storage.put("revoked", Date.now());
    for (const p of this.pages()) this.endPage(p, CLOSE.forbidden, "revoked", false);
    const peers = this.peers();
    for (const p of peers) {
      this.send(p, '{"relay":"revoked"}');
      this.endPeer(p, CLOSE.forbidden, "revoked");
    }
    // (then the account: the slot back, the leases settled; after the linearization point, so never before it)
    if (this.env.REMOTE_ACCOUNT) {
      for (const p of peers) await this.release(this.att(p) as PeerAtt);
      // (taken in a leased() turn, so no consumption or new lease is lost between the read and the clear (LEASE-1))
      const left = await this.leased(async () => {
        const ls = (await this.ctx.storage.get<Lease[]>("leases")) ?? [];
        await this.ctx.storage.put("leases", []);
        return ls;
      });
      for (const l of left) await this.settle(l);
    }
    await this.ctx.storage.deleteAlarm();
    return Response.json({ ok: true });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const a = this.att(ws);
    // (a leg this relay ended (a replaced peer, a page closed or replaced): nothing it still sends is taken)
    if (!this.live(ws)) return;
    if (typeof raw !== "string") return this.close(ws, 1003, "text messages only");
    // (the leg's rate, from its durable bucket (§5): over it, closed 4008; nothing is held back)
    const { rate, burst } = this.rateOf(a.kind);
    const now = this.now();
    const t = Math.min(burst, a.bucket.t + ((now - a.bucket.at) * rate) / 1000);
    if (t < 1) return this.close(ws, 4008, "rate");
    a.bucket = { t: t - 1, at: now };
    ws.serializeAttachment(a);
    if (a.leg === "peer") return this.fromPeer(ws, a, raw);
    return this.fromPage(ws, a, raw);
  }

  private async fromPeer(ws: WebSocket, a: PeerAtt, text: string): Promise<void> {
    const k = classifyPeer(text);
    if (!k) return this.close(ws, 1008, "neither a control nor a prefixed application message");
    if ("control" in k) {
      const c = k.control;
      if (c.relay === "ping") {
        a.ping = this.now(); // (a valid ping only: r1.11)
        this.sendControl(ws, ws, a, PONG);
        return;
      }
      if (c.relay === "close") {
        // (the peer ends one page: only the page now attached with that generation; anything else is ignored)
        const p = this.page(c.gen as number);
        if (p) this.endPage(p, CLOSE.closedByPeer, "closed by the remote", true);
        return;
      }
      return this.ack(ws, a, c.r as string);
    }
    // (an application message: its generation prefix, read at most 17 bytes in; the payload is never parsed)
    const { gen, payload } = k;
    const n = bytes(payload);
    const p = this.page(gen);
    if (!p || (this.att(p) as PageAtt).ended) {
      // (no page attached with that generation: never forwarded, answered once (§13.6), the answer counted against the
      // peer's own window like anything else sent to it)
      this.sendControl(ws, ws, a, JSON.stringify({ relay: "dropped", gen, bytes: n }));
      return;
    }
    const pa = this.att(p) as PageAtt;
    const caps = capsFor(a.kind, pa.chan)!;
    if (n > caps.peerToPage) return this.close(ws, 1009, "a message over its channel's cap");
    // (charged against the peer's one allowance: the whole frame, its prefix too, and the per-frame overhead (b5))
    // (the receiver: the same page, still live; checked before the debit and again at the send)
    const there = () => {
      const q = this.page(gen);
      return q === p && this.live(q);
    };
    await this.charged(ws, a, n, bytes(text) + RELAY_LIMITS.overhead, () => there() && this.forward(ws, p, this.att(p) as PageAtt, payload, n, caps.window), there);
  }

  /**
   * Send `text` (n bytes) to the receiver `to`, or close the sender 1013, sending nothing: the receiver's unacknowledged
   * bytes plus this whole message must fit its window, and a token must be free for the receipt this may need (§5).
   * After the data, behind it on the same socket, a receipt once receiptEvery bytes (or a quarter of the window) went.
   */
  private forward(from: WebSocket, to: WebSocket, ta: Att, text: string, n: number, window: number): boolean {
    const rx = ta.rx;
    // (every message is charged its bytes and a fixed overhead, so empty and small ones are bounded too (astra))
    const w = n + RELAY_LIMITS.overhead;
    if (rx.sent - rx.acked + w > window || rx.tokens.length >= RELAY_LIMITS.tokens) {
      this.close(from, 1013, "the receiver isn't reading");
      return false;
    }
    return this.push(to, ta, text, w, window);
  }

  /** Send, charge, and once receiptEvery (or a quarter of the window) has gone since the last, a receipt behind it. */
  private push(to: WebSocket, ta: Att, text: string, w: number, window: number): boolean {
    const rx = ta.rx;
    // (not sent: nothing of it is the receiver's, no bytes outstanding, no receipt (daybreak3's B5-SEND-ACCOUNT-1))
    if (!this.send(to, text)) return false;
    rx.sent += w;
    rx.since += w;
    if (rx.since >= Math.min(RELAY_LIMITS.receiptEvery, window / 4) && rx.tokens.length < RELAY_LIMITS.tokens) {
      const r = b64url(crypto.getRandomValues(new Uint8Array(16)));
      rx.tokens.push([r, rx.sent]);
      rx.since = 0;
      this.send(to, JSON.stringify({ relay: "receipt", r, upto: rx.sent }));
    }
    to.serializeAttachment(ta);
    return true;
  }

  /** A control from the relay to a receiver (page-open, page-close, dropped), charged against the receiver's window
   * like data; one that doesn't fit closes `offender` (whose action caused it) 1013, unsent. */
  private sendControl(offender: WebSocket, to: WebSocket, ta: Att, text: string): boolean {
    const rx = ta.rx;
    const window = ta.leg === "page" ? capsFor(ta.kind, ta.chan)!.window : peerWindow(ta.kind)!;
    const w = bytes(text) + RELAY_LIMITS.overhead;
    if (rx.sent - rx.acked + w > window) {
      this.close(offender, 1013, "the receiver isn't reading");
      return false;
    }
    return this.push(to, ta, text, w, window);
  }

  /** An ack: only a token issued to this very connection, still open; cumulative (every token up to it closes). */
  private ack(ws: WebSocket, a: Att, r: string): void {
    const i = a.rx.tokens.findIndex(([t]) => t === r);
    if (i < 0) return this.close(ws, 1008, "an unknown receipt");
    a.rx.acked = Math.max(a.rx.acked, a.rx.tokens[i][1]);
    a.rx.tokens.splice(0, i + 1);
    ws.serializeAttachment(a);
  }

  private async fromPage(ws: WebSocket, a: PageAtt, text: string): Promise<void> {
    if (text.startsWith(CONTROL)) {
      const c = parseControl(text, PAGE_OPS);
      if (!c) return this.close(ws, 1008, "a malformed control");
      if (c.relay === "ping") {
        a.ping = this.now(); // (a valid ping only: r1.11)
        this.sendControl(ws, ws, a, PONG);
        return;
      }
      return this.ack(ws, a, c.r as string);
    }
    const peer = this.peers()[0];
    if (!peer) return this.close(ws, CLOSE.runnerGone, "the remote isn't connected");
    const kind = (this.att(peer) as PeerAtt).kind;
    const n = bytes(text);
    if (n > capsFor(kind, a.chan)!.pageToPeer) return this.close(ws, 1009, "a message over its channel's cap");
    const head = `${a.gen}\n`; // (ASCII: its bytes are its length)
    // (the receiver: the same peer (replaced or gone: nothing is sent); checked before the debit and again at the send)
    const there = () => this.peers()[0] === peer;
    await this.charged(ws, a, head.length + n, head.length + n + RELAY_LIMITS.overhead, () => there() && this.forward(ws, peer, this.att(peer), head + text, head.length + n, peerWindow(kind)!), there);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.gone(ws); // (settled once: a leg this relay ended was settled then)
    try {
      ws.close(1000, "closed"); // (completes the close handshake)
    } catch {
      // (already closed)
    }
  }
  async webSocketError(ws: WebSocket): Promise<void> {
    this.gone(ws);
  }
  private gone(ws: WebSocket): void {
    this.drop(ws);
    let a: Att;
    try {
      a = this.att(ws);
    } catch {
      return;
    }
    if (!a) return;
    if (a.ended) return;
    a.ended = true;
    ws.serializeAttachment(a);
    if (a.leg === "page") {
      this.pageClose(a);
      void this.arm(); // (the last page gone: no alarm)
      return;
    }
    void this.release(a); // (its slot, if this generation still holds it: a newer peer's isn't touched)
    // (the peer left: its pages end (4001), unless a newer peer already replaced it (it ended them then))
    if (this.peers().length) return;
    for (const p of this.pages()) this.endPage(p, CLOSE.runnerGone, "the remote disconnected", false);
    void this.arm();
  }
}
