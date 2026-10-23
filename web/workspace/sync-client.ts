// The sync client's sender (design/sync-client.md §3, C1, L2, L3, L4; step 3): the one tab per device and
// namespace that holds the Web Lock, opens the account socket, and sends the outbox.
//
// - The namespace is the account's hash (from /api/share/me's account_id, hashed as the server hashes it), the
//   generation, and this workspace's device.  The generation is read from GET /api/sync/v1/status before the
//   lock is asked for (the lock is per namespace), and checked against `welcome`'s: if they differ, the socket
//   is closed and the client starts again with the new namespace, whose outbox is its own (C1).
// - Each connection takes a new lease (switchTo), and sends only records read under it.  On `welcome`, every
//   record not yet accepted is sent again, unchanged, from the lowest, in dseq order: the server answers one it
//   has decided with its stored decision (lost acks, §5.2).
// - An `ack`'s per-op decisions go to the outbox (Outbox.acked): accepted records stay until their echo; a refused
//   one is removed, and the rebuild is asked for (`sync:<ns>:rebuild`), which step 4 does.  A top-level error
//   (`rate`, `busy`, `order`, `invalid`, `readonly`, …) or a closed socket never removes a record: the sender
//   waits for what is in flight, then sends again from the lowest undecided record, after its timer.
// - This device's echo in an `index` (its device, a dseq in the outbox, the same op) confirms its record
//   (Outbox.confirmed).  Step 3 applies nothing else from the server and keeps no cursor: the cursor is in memory
//   only, and other devices' ops go to `onIndex`, which step 4 gives (with the confirmed index and its cursor,
//   written in one transaction, C3).  The log is read only as far as it must be (daybreak3's LIMIT-PR58-3): from just
//   before the oldest record accepted and awaiting its echo (else from the in-memory cursor), up to a fixed target,
//   the newest such record's seq (and, with onIndex, welcome's index_head), in pulls paced by a bucket, at most
//   CLIENT.replayPages pages a connection; a `more` page that doesn't move the cursor is refused.
// - A data file's bytes go up before its op: `blobs/check` (at most 1,000 hashes a request), then
//   `PUT /blob/<sha256>` for those missing, at most 2 at once, each reserving size × COPIES from the page's
//   reservation before its bytes are read (L2).  An op whose bytes can't be uploaded yet (a timer, storage_full)
//   isn't sent, nor any after it: a `missing` refusal would be final.  One whose bytes this device no longer has,
//   or that the server refuses for good (too large), is sent all the same: the server decides (C1).
// - Pace (L3): at most 1,500 ops a minute (a token bucket counting resends too), at most 8 requests unanswered.
//   Each kind of work has one retry timer, persisted in meta (`sync:<ns>:retry:<kind>`), so a reload or a
//   reconnect doesn't reset it: retry_after when the server gives one, else 1 s doubling to 60 s, ±20%.
// - storage_full pauses uploads (`sync:<ns>:paused`) until its retry_after, a `welcome` with another generation
//   or state, or the person's resume().
import { COPIES, LEGACY_MAX, type Workspace } from "./api";
import { inTx, req } from "./db";
import { Outbox, Fenced, switchTo, sender, type OutboxRecord, type WireOp } from "./sync-outbox";
import { bytesFor } from "./sync-pins";
import { reserve } from "./reserve";
import { accountHash, Bucket } from "../sync-protocol/protocol";

export const CLIENT = {
  /** ops in one `ops` message (the server's opsPerMessage) */
  opsPerMessage: 500,
  /** requests unanswered on the socket (the server's inflight) */
  inflight: 8,
  /** ops a minute, resends included (under the server's 2,000) */
  opsPerMinute: 1500,
  /** the retry timers: from `min`, doubling to `max`, ±`jitter` */
  backoff: { min: 1000, max: 60_000, jitter: 0.2 },
  /** hashes in one blobs/check */
  checkItems: 1000,
  /** uploads at once (a secondary cap: the reservation decides, L2) */
  uploadsAtOnce: 2,
  /** the largest single PUT the server takes (share/server.ts MAX_PUT) */
  maxPut: 95 * 2 ** 20,
  /** refusals kept for the Sync panel */
  refusalsKept: 100,
  /** index pages read at most in one slice of a connection (each at most 1,000 ops and 1 MiB: LIMIT-PR58-3);
   * then a rest of `replayRestMs`, and the next slice, until the target is reached */
  replayPages: 64,
  replayRestMs: 60_000,
  /** pulls: at most `pullBurst` at once, then `pullsPerSecond` */
  pullBurst: 4,
  pullsPerSecond: 2,
};

/** The clock the client's timers and pace use (a fake one in tests). */
export type Clock = { now(): number; after(ms: number, f: () => void): () => void; random(): number };
export const realClock: Clock = {
  now: () => Date.now(),
  after: (ms, f) => {
    const h = setTimeout(f, ms);
    return () => clearTimeout(h);
  },
  random: () => Math.random(),
};

/** The kinds of work with a retry timer each (L3). */
export type Work = "ops" | "index" | "check" | "upload" | "url" | "fetch" | "enable" | "connect";
type Timer = { at: number; n: number };
type Paused = { why: "storage_full"; at: number; until?: number; generation: number; state: string };
/** What the foot shows (step 5). */
export type SyncStatus = {
  state: "off" | "waiting" | "connecting" | "syncing" | "synced" | "offline" | "paused";
  ns?: string;
  /** records waiting to go up */
  waiting?: number;
  /** why it is paused or offline, in the server's words where it gave them */
  reason?: string;
  /** when a timer or pause ends */
  resumesAt?: number;
  lastSynced?: number;
};
/** An op of the server's log, as an `index` message carries it. */
export type IndexOp = WireOp & { seq: number; device: string };
/** A page of the server's log: step 4's confirmed index takes it (C3); step 3 gives it to no one. */
export type IndexPage = { ns: string; ops: IndexOp[]; more: boolean };
export type Refusal = { dseq: number; code: string; path: string; at: number };

export type ClientOptions = {
  /** the site's origin (the page's) */
  origin?: string;
  /** this device's name, as the server lists it */
  name?: string;
  clock?: Clock;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** each page of the server's log, in order (step 4) */
  onIndex?: (page: IndexPage) => Promise<void>;
};

const key = (ns: string, what: string) => `sync:${ns}:${what}`;
const mismatchKey = (ns: string, dseq: number) => key(ns, "mismatch:" + String(dseq).padStart(16, "0"));
/** this workspace's stored bytes were once found longer or shorter than their metadata (LIMIT-PR58-2) */
const UNTRUSTED = "sync:bytes-untrusted";
/** a narrow upload read in progress (cleared in the transaction that reads; left by a page killed in it) */
const READING = "sync:bytes-reading";
const META = "meta";
const isNat = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
// (the fields of an op that make it this op: what an echo must repeat of its record)
const SAME = ["dseq", "t", "by", "op", "path", "to", "kind", "ref", "fid", "sha256", "size", "base", "parent"] as const;
const sameOp = (a: WireOp, b: Record<string, unknown>) => SAME.every((k) => (a as Record<string, unknown>)[k] === b[k]);

type Pending = { kind: "ops"; recs: OutboxRecord[] } | { kind: "index" };
type Conn = {
  ns: string;
  /** the account's hash and the generation this connection is bound to: sent in hello and on every blob request,
   * and checked by the server against the socket's and the request's own session (CORR-PR58-1) */
  account: string;
  generation: number;
  ob: Outbox;
  ws: WebSocket;
  welcomed: boolean;
  /** writes allowed: the account is active and nothing paused them */
  writable: boolean;
  /** sending stopped until the rebuild (step 4): the server's `invalid` "rebuild", or this device's log diverged */
  halted?: string;
  /** the next dseq to send; undefined: from the lowest record not accepted */
  next?: number;
  /** send again from the lowest, once nothing is in flight */
  resync: boolean;
  req: number;
  pending: Map<number, Pending>;
  pulling: boolean;
  /** the seq the log is read up to on this connection: the newest accepted record awaiting its echo, and (with
   * onIndex) welcome's index_head; only ever raised, by those and by acks' accepted seqs */
  target: number;
  /** index pages read in this slice of the connection (hello's and pulls'), at most CLIENT.replayPages */
  pages: number;
  /** what the server holds, what it doesn't, and what can't go up, by hash (this connection's) */
  have: Set<string>;
  missing: Set<string>;
  final: Set<string>;
  gone: Set<string>;
  /** the messages handled one at a time, in order */
  chain: Promise<void>;
  end: (why: End) => void;
};
type End = "closed" | "generation" | "revoked" | "fenced" | "stopped" | "deleting";

/** The sync client for workspace `w`: start() runs it until stop(). */
export class SyncClient {
  readonly clock: Clock;
  private origin: string;
  private fetch: typeof fetch;
  private WS: typeof WebSocket;
  private stopped = false;
  private abort = new AbortController();
  private cancels = new Set<() => void>();
  /** the wake-ups scheduled, at most one per kind (daybreak3's LIMIT-PR58-1) */
  private wakes = new Map<string, { at: number; cancel: () => void }>();
  private pullBucket: Bucket;
  private conn: Conn | null = null;
  private running = false;
  private again = false;
  private bucket: Bucket;
  /** the retry timers of `timerNs` ("-": before a namespace is known, in memory only) */
  private timers = new Map<string, Timer>();
  private timerNs = "-";
  private paused: Paused | null = null;
  /** the server's log as far as this page has read it: in memory only (step 3, D2) */
  private cursor = 0;
  private cursorNs = "";
  private subs = new Set<(s: SyncStatus) => void>();
  private unwatch: (() => void) | null = null;
  status: SyncStatus = { state: "off" };
  /** (tests: what the client did) */
  readonly stats = { connects: 0, opsMessages: 0, opsSent: 0, checks: 0, puts: 0, putsAtOnce: 0, maxPutsAtOnce: 0, pulls: 0, maxInflight: 0, maxOps: 0, wakesFired: 0, maxWakes: 0, mismatches: 0, pages: 0, readsAtOnce: 0, maxReadsAtOnce: 0, wideReads: 0 };

  constructor(readonly w: Workspace, private opts: ClientOptions = {}) {
    this.clock = opts.clock ?? realClock;
    this.origin = opts.origin ?? globalThis.location?.origin ?? "";
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.WS = opts.WebSocket ?? globalThis.WebSocket;
    this.bucket = new Bucket(CLIENT.opsPerMessage, CLIENT.opsPerMinute / 60, this.clock.now());
    this.pullBucket = new Bucket(CLIENT.pullBurst, CLIENT.pullsPerSecond, this.clock.now());
  }

  /** `f(status)` on each change; returns how to stop. */
  onStatus(f: (s: SyncStatus) => void): () => void {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }
  private say(s: SyncStatus) {
    this.status = s;
    for (const f of this.subs) try { f(s); } catch (e) { console.warn("sync status:", e); }
  }

  /** Runs until stop(), or until the server says sync is off for this account, or the session ends. */
  async start(): Promise<void> {
    this.unwatch = this.w.watch(() => this.kick());
    try {
      while (!this.stopped) {
        const ns = await this.namespace();
        if (!ns) return;
        const end = await this.locked(ns);
        if (end === "revoked" || end === "fenced" || end === "stopped") return;
      }
    } finally {
      this.unwatch?.();
      this.unwatch = null;
    }
  }

  /** Stops: the socket closed, every timer cancelled, the lock let go.  The durable state stays. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    for (const c of this.cancels) c();
    this.cancels.clear();
    this.unwake();
    const c = this.conn;
    if (c) {
      c.end("stopped");
      try { c.ws.close(1000, "stopped"); } catch {}
    }
    if (this.status.state !== "off") this.say({ ...this.status, state: "off" });
  }

  /** The person's action: a storage_full pause lifted, and every timer of this namespace ended. */
  async resume(): Promise<void> {
    const c = this.conn;
    if (!c) return;
    this.paused = null;
    await this.metaPut(key(c.ns, "paused"), undefined);
    for (const k of [...this.timers.keys()]) await this.timerOk(c.ns, k as Work);
    this.kick();
  }

  /** (tests) the in-memory cursor, and what is in flight */
  debug() {
    const c = this.conn;
    return { cursor: this.cursor, wakes: this.wakes.size, target: c?.target, pages: c?.pages, ns: c?.ns, inflight: c?.pending.size ?? 0, next: c?.next, writable: c?.writable, halted: c?.halted, paused: this.paused };
  }

  // ---- the namespace: the account and its generation (D1)

  private hashOf: { account: string; hash: string } | null = null;
  /** The namespace now, or null when sync is off or unavailable for this account (said in the status). */
  private async namespace(): Promise<string | null> {
    for (;;) {
      if (this.stopped) return null;
      await this.waitTimer(this.timerNs, "connect");
      if (this.stopped) return null;
      this.say({ state: "connecting" });
      try {
        // (asked every time: the page's session may be another account's since the last connection, CORR-PR58-1;
        // and the socket and blob requests then carry the account and generation, which the server checks)
        {
          const me = await this.http("GET", "/api/share/me");
          if (me.status === 401) return this.offWith("sign in first");
          if (!me.ok) throw new Retry(me.retryAfter);
          const account = (me.body as { account_id?: unknown }).account_id;
          if (typeof account !== "string" || !account) throw new Retry();
          this.hashOf = { account, hash: await accountHash(account) };
        }
        const st = await this.http("GET", "/api/sync/v1/status");
        if (st.status === 401) return this.offWith("sign in first");
        if (!st.ok) throw new Retry(st.retryAfter);
        const b = st.body as { available?: boolean; reason?: string; state?: string; generation?: number; retry_after?: number };
        if (!b.available) {
          if (b.reason === "cocalc_unreachable") throw new Retry(isNat(b.retry_after) ? b.retry_after : undefined);
          return this.offWith(b.reason ?? "unavailable");
        }
        if (b.state === "off" || !isNat(b.generation) || b.generation < 1) return this.offWith("sync is off for this account");
        // (registering, deleting: not yet, or not now; asked again on the timer)
        if (b.state === "registering" || b.state === "deleting") {
          this.say({ state: "paused", reason: b.state });
          throw new Retry();
        }
        return `${this.hashOf.hash}:${b.generation}:${this.w.device}`;
      } catch (e) {
        if (this.stopped) return null;
        const ra = e instanceof Retry ? e.retryAfter : undefined;
        const at = await this.timerFail(this.timerNs, "connect", ra);
        if (this.status.state !== "paused") this.say({ state: "offline", reason: "can't reach the server", resumesAt: at });
      }
    }
  }
  private offWith(reason: string): null {
    this.say({ state: "off", reason });
    return null;
  }

  // ---- the lock, and connections under it

  private async locked(ns: string): Promise<End> {
    if (this.cursorNs !== ns) {
      // (another namespace: its own log, read from its start)
      this.cursor = 0;
      this.cursorNs = ns;
      this.paused = null;
    }
    this.say({ state: "waiting", ns });
    try {
      return await sender(ns, async () => {
        await this.loadDurable(ns);
        // (one connection at a time; after one ends, the namespace is asked again, unless it ended for good)
        return this.connection(ns);
      }, { signal: this.abort.signal });
    } catch (e) {
      if (this.stopped) return "stopped";
      throw e;
    }
  }

  private async connection(ns: string): Promise<End> {
    await this.waitTimer(ns, "connect");
    if (this.stopped) return "stopped";
    let lease;
    try {
      lease = await switchTo(this.w, ns);
    } catch (e) {
      if (e instanceof Fenced) return "fenced";
      throw e;
    }
    const ob = new Outbox(this.w, lease);
    // (a namespace's scan starts here, at the latest op, until step 4's first sync sends the tree as it was)
    if ((await ob.status()).scanned === undefined) await ob.begin(await this.w.lastSeq());
    // (where the log is read from, and to: the records accepted and awaiting their echo, LIMIT-PR58-3)
    const awaiting = await this.awaitingEcho(ob);
    const start = awaiting ? awaiting.lo - 1 : this.cursor;
    // (stopped while this connection was being prepared: no socket is opened)
    if (this.stopped) return "stopped";
    const url = this.origin.replace(/^http/, "ws") + "/api/sync/v1/account";
    this.stats.connects++;
    const ws = new this.WS(url);
    return new Promise<End>((done) => {
      let ended = false;
      const c: Conn = {
        ns, account: ns.split(":")[0], generation: Number(ns.split(":")[1]), ob, ws, welcomed: false, writable: false, resync: false, req: 0, pending: new Map(), pulling: false, target: awaiting?.hi ?? 0, pages: 0,
        have: new Set(), missing: new Set(), final: new Set(), gone: new Set(), chain: Promise.resolve(),
        end: (why) => {
          if (ended) return;
          ended = true;
          if (this.conn === c) this.conn = null;
          this.unwake();
          try { ws.close(1000, why); } catch {}
          void (async () => {
            if (why === "closed" && !this.stopped) {
              const at = await this.timerFail(ns, "connect");
              this.say({ state: "offline", ns, reason: "disconnected", resumesAt: at, waiting: this.status.waiting });
            }
            done(why);
          })();
        },
      };
      this.conn = c;
      this.cursor = start;
      ws.onopen = () => {
        this.send(c, { t: "hello", v: 1, device: this.w.device, name: (this.opts.name ?? "browser").slice(0, 100), index_after: start, account: c.account, generation: c.generation });
      };
      ws.onmessage = (ev) => {
        c.chain = c.chain.then(() => this.message(c, ev.data)).catch((e) => {
          if (e instanceof Fenced) return c.end("fenced");
          console.warn("sync:", e);
          c.end("closed");
        });
      };
      ws.onclose = (ev) => {
        // (4401: the session ended; 4410: the account's synced data is being deleted)
        c.chain = c.chain.then(() => c.end(ev.code === 4401 ? "revoked" : ev.code === 4410 ? "deleting" : "closed"));
      };
      ws.onerror = () => {};
    });
  }

  private send(c: Conn, m: Record<string, unknown>) {
    try {
      c.ws.send(JSON.stringify(m));
    } catch {
      c.end("closed");
    }
  }
  private ask(c: Conn, m: Record<string, unknown>, p: Pending): number {
    const r = ++c.req;
    c.pending.set(r, p);
    this.stats.maxInflight = Math.max(this.stats.maxInflight, c.pending.size);
    this.send(c, { ...m, req: r });
    return r;
  }

  // ---- what the server says

  private async message(c: Conn, raw: unknown) {
    if (this.conn !== c) return;
    if (typeof raw !== "string") return c.end("closed");
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw);
    } catch {
      return c.end("closed");
    }
    if (!m || typeof m !== "object") return c.end("closed");
    switch (m.t) {
      case "welcome":
        return this.welcome(c, m);
      case "index":
        return this.index(c, m);
      case "ack":
        return this.ack(c, m);
      case "error":
        return this.error(c, m);
      case "revoked":
        this.say({ state: "off", ns: c.ns, reason: "signed out" });
        return c.end("revoked");
      default:
        // (changed, watching, batches: slice 2's)
        return;
    }
  }

  private async welcome(c: Conn, m: Record<string, unknown>) {
    if (m.v !== 1 || !isNat(m.generation) || !isNat(m.next_dseq) || typeof m.state !== "string") return c.end("closed");
    // (another generation than the namespace's: a new namespace, read again from the status)
    if (m.generation !== c.generation) return c.end("generation");
    await this.timerOk(c.ns, "connect");
    c.welcomed = true;
    // (step 4's confirmed index reads the whole log as it stood: up to the head welcome gives, no further)
    if (this.opts.onIndex && isNat(m.index_head)) c.target = Math.max(c.target, m.index_head);
    c.writable = m.state === "active";
    // (storage_full lifts on a welcome with another generation or state than when it began)
    if (this.paused && (this.paused.generation !== m.generation || this.paused.state !== m.state)) {
      this.paused = null;
      await this.metaPut(key(c.ns, "paused"), undefined);
    }
    // (the server has decided dseqs this device never allocated: its log isn't this namespace's any more, as after
    // a restore of an older copy of the workspace; nothing more is sent until the rebuild, step 4)
    const st = await c.ob.status();
    if (m.next_dseq > st.nextDseq) await this.halt(c, "diverged", `the server has decided up to dseq ${m.next_dseq - 1}; this device allocated up to ${st.nextDseq - 1}`);
    else {
      const rb = await this.metaGet<{ why: string }>(key(c.ns, "rebuild"));
      if (rb?.why === "invalid" || rb?.why === "diverged") c.halted = rb.why;
    }
    if (this.paused?.until) this.wake(c, "unpause", this.paused.until, () => this.unpause(c));
    if (!c.writable) this.say({ state: "paused", ns: c.ns, reason: m.state === "readonly" ? "read-only" : String(m.state) });
    this.kick();
  }

  private async index(c: Conn, m: Record<string, unknown>) {
    if (isNat(m.req)) {
      c.pending.delete(m.req);
      c.pulling = false;
      await this.timerOk(c.ns, "index");
    }
    if (!Array.isArray(m.ops) || typeof m.more !== "boolean") return c.end("closed");
    // (a page that says there is more but moves nothing: refused, rather than asked again for ever)
    if (m.more && m.ops.length === 0) return c.end("closed");
    c.pages++;
    this.stats.pages++;
    const ops: IndexOp[] = [];
    let last = this.cursor;
    for (const o of m.ops as Record<string, unknown>[]) {
      // (what comes down is untrusted until checked: in order, past the cursor, with its seq, device and dseq)
      if (!o || typeof o !== "object" || !isNat(o.seq) || o.seq <= last || typeof o.device !== "string" || !isNat(o.dseq)) return c.end("closed");
      last = o.seq;
      ops.push(o as unknown as IndexOp);
    }
    // (this device's echoes: their records confirmed, if each is the very op of its record)
    const mine = ops.filter((o) => o.device === this.w.device);
    if (mine.length) {
      const lo = mine[0].dseq, hi = mine[mine.length - 1].dseq;
      const recs = new Map((await c.ob.records(lo, Math.max(1, hi - lo + 1))).map((r) => [r.dseq, r]));
      const ok: number[] = [];
      for (const o of mine) {
        const r = recs.get(o.dseq);
        if (!r) continue;
        if (!sameOp(r.op, o as unknown as Record<string, unknown>)) {
          await this.halt(c, "diverged", `the server's op ${o.seq} for dseq ${o.dseq} isn't this device's record`);
          return;
        }
        ok.push(o.dseq);
      }
      if (ok.length) await c.ob.confirmed(ok);
    }
    if (this.opts.onIndex && ops.length) await this.opts.onIndex({ ns: c.ns, ops, more: m.more });
    this.cursor = last;
    // (no further than the target: past it, pages are another time's, LIMIT-PR58-3)
    if (!m.more && c.target > last) c.target = last;
    this.pull(c);
    this.kick();
  }

  /** The next page of the log, if the cursor is short of the target: one pull at a time, paced (a bucket), at
   * most CLIENT.replayPages pages a slice, then a rest of CLIENT.replayRestMs before the next slice. */
  private pull(c: Conn) {
    if (this.conn !== c || c.pulling || this.cursor >= c.target) return;
    // (a slice's pages read: the rest of the way after a rest, on this connection (daybreak3's question 2 on
    // LIMIT-PR58-3); at most CLIENT.replayPages pages, 64 MiB, a rest and a slice)
    if (c.pages >= CLIENT.replayPages) {
      // (the first rest's end stands until the slice resumes: a pull asked for meanwhile (each ack asks) never moves
      // it later, astra's narrowed CORR-PR58-4)
      if (this.wakes.has("replay")) return;
      return this.wake(c, "replay", this.clock.now() + CLIENT.replayRestMs, () => {
        c.pages = 0;
        this.pull(c);
      });
    }
    if (c.pending.size >= CLIENT.inflight) return;
    // (the index timer, however the pull was asked for (a page, an ack, a reconnect): woken at its end, when the
    // timer is checked again, so a prolonged one waits on, CORR-PR58-3)
    const left = this.left(c.ns, "index");
    if (left > 0) return this.wake(c, "index", this.clock.now() + left, () => this.pull(c));
    const wait = this.pullBucket.take(1, this.clock.now());
    if (wait > 0) return this.wake(c, "pull", this.clock.now() + wait, () => this.pull(c));
    c.pulling = true;
    this.stats.pulls++;
    this.ask(c, { t: "pull_index", after: this.cursor }, { kind: "index" });
  }

  /** The seqs of the records accepted and awaiting their echo, lowest and highest (read in pages: the outbox is
   * bounded, 10,000 records at most). */
  private async awaitingEcho(ob: Outbox): Promise<{ lo: number; hi: number } | null> {
    let lo = Infinity, hi = 0, at = 1;
    for (;;) {
      const page = await ob.records(at, 500);
      for (const r of page) if (r.accepted !== undefined) {
        lo = Math.min(lo, r.accepted);
        hi = Math.max(hi, r.accepted);
      }
      if (page.length < 500) break;
      at = page[page.length - 1].dseq + 1;
    }
    return hi > 0 ? { lo, hi } : null;
  }

  private async ack(c: Conn, m: Record<string, unknown>) {
    if (!isNat(m.req)) return;
    const p = c.pending.get(m.req);
    if (!p || p.kind !== "ops") return;
    c.pending.delete(m.req);
    if (!Array.isArray(m.ops)) return c.end("closed");
    const results = m.ops as ({ dseq: number; seq: number } | { dseq: number; code: string })[];
    await c.ob.acked(results);
    await this.timerOk(c.ns, "ops");
    const byDseq = new Map(p.recs.map((r) => [r.dseq, r]));
    const refused = results.filter((d): d is { dseq: number; code: string } => "code" in d);
    if (refused.length) {
      // (a refusal is final: the record is gone; the index is rebuilt from the server's log and what is queued, step 4)
      const now = this.clock.now();
      const list = (await this.metaGet<Refusal[]>(key(c.ns, "refused"))) ?? [];
      for (const d of refused) list.push({ dseq: d.dseq, code: String(d.code).slice(0, 64), path: byDseq.get(d.dseq)?.op.path ?? "", at: now });
      await this.metaPut(key(c.ns, "refused"), list.slice(-CLIENT.refusalsKept));
      await this.flagRebuild(c.ns, "refused");
    }
    // (accepted ones wait for their echo: the log is read on, to the newest of them, and no further)
    for (const d of results) if ("seq" in d && isNat(d.seq)) c.target = Math.max(c.target, d.seq);
    this.pull(c);
    this.kick();
  }

  private async error(c: Conn, m: Record<string, unknown>) {
    const code = String(m.code ?? "");
    const detail = (m.detail && typeof m.detail === "object" ? m.detail : {}) as { message?: string; retry_after?: number; next_dseq?: number };
    const ra = isNat(detail.retry_after) ? detail.retry_after : undefined;
    const p = isNat(m.req) ? c.pending.get(m.req) : undefined;
    if (isNat(m.req)) c.pending.delete(m.req);
    // (pushed by the server: the plan ended, or a deletion began)
    if (!isNat(m.req)) {
      if (code === "readonly" || code === "deleting") {
        c.writable = false;
        this.say({ state: "paused", ns: c.ns, reason: code === "readonly" ? "read-only" : "deleting" });
        return;
      }
      // (a refused hello: not this account's sync, not now; asked again on the timer)
      if (!c.welcomed) return c.end("closed");
      return;
    }
    if (p?.kind === "index") {
      c.pulling = false;
      const at = await this.timerFail(c.ns, "index", ra);
      this.wake(c, "index", at, () => this.pull(c));
      return;
    }
    if (p?.kind !== "ops") return;
    // (nothing top-level removes a record: they are sent again, from the lowest undecided, once nothing is in flight)
    c.resync = true;
    if (code === "invalid" && /rebuild/.test(detail.message ?? "")) {
      await this.halt(c, "invalid", detail.message ?? "rebuild");
      return;
    }
    if (code === "readonly" || code === "deleting") {
      c.writable = false;
      this.say({ state: "paused", ns: c.ns, reason: code === "readonly" ? "read-only" : "deleting" });
    }
    if (code === "forbidden") return c.end("closed");
    // (order: a gap, after an earlier message failed; resent from the lowest, so no timer of its own beyond the first)
    if (code === "order") {
      const st = await c.ob.status();
      const first = (await this.undecided(c, 1, 1))[0];
      if (isNat(detail.next_dseq) && detail.next_dseq < (first?.dseq ?? st.nextDseq) && c.pending.size === 0) {
        // (the server waits for a dseq this device no longer has undecided: its records aren't the server's)
        const have = await c.ob.records(detail.next_dseq, 1);
        if (!have.length || have[0].dseq !== detail.next_dseq) {
          await this.halt(c, "diverged", `the server waits for dseq ${detail.next_dseq}, which this device has decided`);
          return;
        }
      }
    }
    await this.timerFail(c.ns, "ops", ra);
    this.kick();
  }

  // ---- sending

  /** The sender run again (now, or once the current run ends). */
  kick() {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void (async () => {
      try {
        do {
          this.again = false;
          const c = this.conn;
          if (c) await this.drain(c);
        } while (this.again && !this.stopped);
      } catch (e) {
        const c = this.conn;
        if (e instanceof Fenced) c?.end("fenced");
        else {
          console.warn("sync: sending", e);
          c?.end("closed");
        }
      } finally {
        this.running = false;
      }
    })();
  }

  private async drain(c: Conn) {
    if (this.conn !== c || !c.welcomed) return;
    const st0 = await c.ob.status();
    if (!c.writable || c.halted) {
      this.showWaiting(c, st0.count);
      return;
    }
    // (the scan: local changes made into records, as the outbox has room)
    await c.ob.scan();
    if (c.resync) {
      if (c.pending.size > 0 && [...c.pending.values()].some((p) => p.kind === "ops")) return;
      c.resync = false;
      c.next = undefined;
    }
    const left = this.left(c.ns, "ops");
    if (left > 0) {
      this.wake(c, "ops", this.clock.now() + left, () => this.kick());
      this.showWaiting(c, (await c.ob.status()).count, this.clock.now() + left);
      return;
    }
    for (;;) {
      if (this.conn !== c || c.resync || c.halted || !c.writable) return;
      const opsInFlight = [...c.pending.values()].filter((p) => p.kind === "ops").length;
      if (c.pending.size >= CLIENT.inflight) return;
      const recs = await this.undecided(c, c.next ?? 1, CLIENT.opsPerMessage);
      if (!recs.length) {
        const st = await c.ob.status();
        // (synced only once every op logged here is scanned: one logged since this run's scan is the next run's)
        const caughtUp = (st.scanned ?? 0) >= (await this.w.lastSeq());
        if (opsInFlight === 0 && st.count === 0 && caughtUp) this.say({ state: "synced", ns: c.ns, waiting: 0, lastSynced: this.clock.now() });
        else this.showWaiting(c, st.count);
        return;
      }
      this.showWaiting(c, (await c.ob.status()).count);
      const n = await this.blobsFor(c, recs);
      if (this.conn !== c || c.resync) return;
      if (n === 0) {
        // (waiting on bytes: a pause or a timer an upload just set is said)
        this.showWaiting(c, (await c.ob.status()).count);
        return;
      }
      const batch = recs.slice(0, n);
      const wait = this.bucket.take(batch.length, this.clock.now());
      if (wait === Infinity) throw new Error("sync: a message larger than the pace allows");
      if (wait > 0) {
        this.wake(c, "pace", this.clock.now() + wait, () => this.kick());
        return;
      }
      this.stats.opsMessages++;
      this.stats.opsSent += batch.length;
      this.stats.maxOps = Math.max(this.stats.maxOps, batch.length);
      this.ask(c, { t: "ops", ops: batch.map((r) => r.op) }, { kind: "ops", recs: batch });
      c.next = batch[batch.length - 1].dseq + 1;
      if (n < recs.length) return;
    }
  }

  /** At most `n` records not yet accepted, from dseq `from`, in order. */
  private async undecided(c: Conn, from: number, n: number): Promise<OutboxRecord[]> {
    const out: OutboxRecord[] = [];
    let at = from;
    for (;;) {
      const page = await c.ob.records(at, n);
      for (const r of page) if (r.accepted === undefined && out.length < n) out.push(r);
      if (out.length >= n || page.length < n) return out;
      at = page[page.length - 1].dseq + 1;
    }
  }

  private showWaiting(c: Conn, count: number, resumesAt?: number) {
    if (!c.writable) return this.say({ ...this.status, ns: c.ns, waiting: count });
    if (c.halted) return this.say({ state: "paused", ns: c.ns, waiting: count, reason: c.halted === "diverged" ? "this device's changes need a rebuild" : "the server asks for a rebuild" });
    if (this.paused) return this.say({ state: "paused", ns: c.ns, waiting: count, reason: "storage full", ...(this.paused.until ? { resumesAt: this.paused.until } : {}) });
    this.say({ state: count ? "syncing" : "synced", ns: c.ns, waiting: count, ...(resumesAt ? { resumesAt } : {}), ...(count ? {} : { lastSynced: this.clock.now() }) });
  }

  // ---- blobs (§5.4, L2, L4)

  /**
   * The bytes of `recs`' data files checked and uploaded, as far as can be now: returns how many of `recs`, from
   * the first, may be sent (every data file among them is held by the server, or can't ever be uploaded from
   * here: the server decides it).
   */
  private async blobsFor(c: Conn, recs: OutboxRecord[]): Promise<number> {
    const files = recs.filter((r) => r.op.kind === "file" && r.op.sha256 !== undefined);
    const known = (sha: string) => c.have.has(sha) || c.final.has(sha) || c.gone.has(sha);
    // (checked: what this connection hasn't asked about, in pages of at most 1,000)
    const ask: { sha256: string; size: number }[] = [];
    const seen = new Set<string>();
    for (const r of files) {
      const sha = r.op.sha256!;
      if (known(sha) || c.missing.has(sha) || seen.has(sha)) continue;
      seen.add(sha);
      ask.push({ sha256: sha, size: r.op.size ?? 0 });
    }
    for (let i = 0; i < ask.length && this.conn === c; i += CLIENT.checkItems) {
      // (a check timer, persisted, maybe from before a reload: woken at its end, CORR-PR58-2)
      if (this.left(c.ns, "check") > 0) {
        this.wake(c, "check", this.clock.now() + this.left(c.ns, "check"), () => this.kick());
        break;
      }
      const page = ask.slice(i, i + CLIENT.checkItems);
      this.stats.checks++;
      const r = await this.http("POST", "/api/sync/v1/blobs/check", { blobs: page }, this.binding(c));
      if (this.conn !== c) break;
      if (!r.ok) {
        // (another account's session, or another generation: this connection ends, and the namespace is read again)
        if (r.status === 401 || r.status === 403 || (r.status === 409 && r.code === "conflict")) c.end("closed");
        else this.wake(c, "check", await this.timerFail(c.ns, "check", r.retryAfter), () => this.kick());
        break;
      }
      await this.timerOk(c.ns, "check");
      const missing = new Set(Array.isArray((r.body as { missing?: unknown }).missing) ? ((r.body as { missing: string[] }).missing) : []);
      for (const b of page) (missing.has(b.sha256) ? c.missing : c.have).add(b.sha256);
    }
    // (uploads: those missing, in the records' order, at most CLIENT.uploadsAtOnce at once)
    const todo: OutboxRecord[] = [];
    const queued = new Set<string>();
    for (const r of files) {
      const sha = r.op.sha256!;
      if (c.missing.has(sha) && !queued.has(sha)) {
        queued.add(sha);
        todo.push(r);
      }
    }
    let stop = false;
    const one = async (r: OutboxRecord) => {
      const sha = r.op.sha256!;
      const out = await this.upload(c, r);
      if (out === "wait") stop = true;
      else {
        c.missing.delete(sha);
        (out === "have" ? c.have : out === "gone" ? c.gone : c.final).add(sha);
      }
    };
    let at = 0;
    const lanes = Array.from({ length: Math.min(CLIENT.uploadsAtOnce, todo.length) }, async () => {
      while (!stop && at < todo.length && this.conn === c) await one(todo[at++]);
    });
    await Promise.all(lanes);
    let n = 0;
    for (const r of recs) {
      if (r.op.kind === "file" && r.op.sha256 !== undefined && !known(r.op.sha256)) break;
      n++;
    }
    return n;
  }

  /** One data file's bytes uploaded: "have" (the server holds them), "gone" (this device no longer has them),
   * "final" (the server will never take them: too large, or not these bytes), or "wait" (not now). */
  private async upload(c: Conn, r: OutboxRecord): Promise<"have" | "gone" | "final" | "wait"> {
    const size = r.op.size ?? 0;
    if (size > CLIENT.maxPut) return "final";
    if (!c.writable) return "wait";
    // (a storage_full pause with an end: over once it has passed, durably; else woken at its end, CORR-PR58-2)
    if (this.paused?.until !== undefined && this.paused.until <= this.clock.now()) {
      this.paused = null;
      await this.metaPut(key(c.ns, "paused"), undefined);
    }
    if (this.paused) {
      if (this.paused.until !== undefined) this.wake(c, "unpause", this.paused.until, () => this.unpause(c));
      return "wait";
    }
    if (this.left(c.ns, "upload") > 0) {
      this.wake(c, "upload", this.clock.now() + this.left(c.ns, "upload"), () => this.kick());
      return "wait";
    }
    // (bytes found before not to be what their record says: never read again, LIMIT-PR58-2)
    if (await this.mismatched(c.ns, r.dseq)) return "gone";
    // (the reservation first, before any bytes are read, held until the request is done: L2.  It is the stored
    // size × COPIES: every writer of fileBytes and versionBytes stores a value in the same transaction as metadata
    // made from that value's own length, so they agree (api.ts: write, create, adopt's move, the migrator's move,
    // putVersion).  IndexedDB gives no value's length without reading it whole, so a value changed outside the
    // workspace's own verbs is found only by reading it: as the migrator's rule has it (daybreak2), that costs one
    // read past the reservation, once.  Here reads go one at a time, so at most one such value is held at once,
    // and the first found marks this workspace's stored bytes untrusted, durably: every upload's read after that
    // takes the largest reservation, LEGACY_MAX × COPIES, which has the page's reservation to itself.  So in a
    // workspace's whole life at most one value is ever held beyond what its reader reserved (LIMIT-PR58-2))
    let wide = await this.untrusted();
    for (;;) {
      const need = wide ? Math.max(size, LEGACY_MAX) * COPIES : size * COPIES;
      const token = await reserve(need);
      try {
        if (this.conn !== c) return "wait";
        if (token.n < need) throw new Error("sync: a reservation that doesn't cover an upload");
        // (the flag checked again where reads go one at a time: one found meanwhile by another upload's read means
        // this one is read under the largest reservation, not the one it took before)
        const bytes = await this.oneRead(async () => {
          if (!wide && (await this.untrusted())) return "widen" as const;
          // (a narrow read is announced durably first: one that never ends (the page killed while it held the
          // value) leaves this mark, and the next start then reads wide, daybreak3's third round)
          if (!wide) await this.metaPut(READING, { ns: c.ns, dseq: r.dseq });
          return bytesFor(this.w, r, token, { mismatch: mismatchKey(c.ns, r.dseq), untrusted: UNTRUSTED, reading: READING, ns: c.ns, dseq: r.dseq });
        });
        if (bytes === "widen") {
          wide = true;
          continue;
        }
        if (wide) this.stats.wideReads++;
        if (bytes === "mismatch" || bytes === "length") {
          // (not this device's bytes for that record: sent all the same, as bytes gone are, and the server decides
          // (C1); the file's present state goes as its own write after, by the pending summary's successor path)
          this.stats.mismatches++;
          await this.noteMismatch(c, r.dseq);
          return "gone";
        }
        if (!bytes) return "gone";
        if (bytes.length !== size || bytes.length > CLIENT.maxPut) return "gone";
        // (the connection still the one these bytes are for: never sent under another lease, CORR-PR58-1)
        if (this.conn !== c) return "wait";
        this.stats.puts++;
        this.stats.putsAtOnce++;
        this.stats.maxPutsAtOnce = Math.max(this.stats.maxPutsAtOnce, this.stats.putsAtOnce);
        let res;
        try {
          res = await this.http("PUT", `/api/sync/v1/blob/${r.op.sha256}`, bytes, this.binding(c));
        } finally {
          this.stats.putsAtOnce--;
        }
        // (an answer for a connection that is no longer the current one changes nothing: no pause, timer, status or
        // wake-up of the next one, whatever it says, astra's narrowed CORR-PR58-1)
        if (this.conn !== c) return "wait";
        if (res.ok) {
          await this.timerOk(c.ns, "upload");
          return "have";
        }
        if (res.status === 413 || res.status === 400) return "final";
        if (res.status === 507) {
          this.paused = { why: "storage_full", at: this.clock.now(), generation: c.generation, state: "active", ...(res.retryAfter !== undefined ? { until: this.clock.now() + res.retryAfter } : {}) };
          await this.metaPut(key(c.ns, "paused"), this.paused);
          if (this.paused.until) this.wake(c, "unpause", this.paused.until, () => this.unpause(c));
          return "wait";
        }
        if (res.status === 409 && (res.code === "readonly" || res.code === "deleting")) {
          c.writable = false;
          this.say({ state: "paused", ns: c.ns, reason: res.code === "readonly" ? "read-only" : "deleting" });
          return "wait";
        }
        if (res.status === 401 || res.status === 403 || (res.status === 409 && res.code === "conflict")) {
          c.end("closed");
          return "wait";
        }
        this.wake(c, "upload", await this.timerFail(c.ns, "upload", res.retryAfter), () => this.kick());
        return "wait";
      } finally {
        token();
      }
    }
  }

  // (records whose bytes weren't what they say: one durable mark each, `sync:<ns>:mismatch:<dseq>`, so each is read
  // at most once however long it stays undecided; the marks of records already decided (below the outbox's lowest
  // dseq) are deleted as new ones are made, so they number at most the outbox's records)
  private async mismatched(ns: string, dseq: number): Promise<boolean> {
    return (await this.metaGet(mismatchKey(ns, dseq))) !== undefined;
  }
  private async noteMismatch(c: Conn, dseq: number) {
    const low = (await c.ob.records(1, 1))[0]?.dseq ?? dseq;
    await inTx(this.w.ws, META, "readwrite", async (tx) => {
      const meta = tx.objectStore(META);
      meta.put(1, mismatchKey(c.ns, dseq));
      if (low > 1) meta.delete(IDBKeyRange.bound(mismatchKey(c.ns, 0), mismatchKey(c.ns, low), false, true));
    });
  }
  /** Whether the stored bytes are untrusted: one was found another length than its metadata, or a narrow read was
   * cut short (its mark left: it may have held such a value), which is made durable here. */
  private async untrusted(): Promise<boolean> {
    return inTx(this.w.ws, META, "readwrite", async (tx) => {
      const meta = tx.objectStore(META);
      if ((await req(meta.get(UNTRUSTED))) !== undefined) return true;
      // (while this page reads, the mark is its own read's, not one cut short)
      if (this.stats.readsAtOnce > 0) return false;
      const cut = await req(meta.get(READING));
      if (cut === undefined) return false;
      meta.put({ cut }, UNTRUSTED);
      meta.delete(READING);
      return true;
    });
  }
  /** `f`, the only upload read running: bytes read one value at a time (LIMIT-PR58-2). */
  private reading: Promise<unknown> = Promise.resolve();
  private oneRead<T>(f: () => Promise<T>): Promise<T> {
    const run = this.reading.then(async () => {
      this.stats.readsAtOnce++;
      this.stats.maxReadsAtOnce = Math.max(this.stats.maxReadsAtOnce, this.stats.readsAtOnce);
      try {
        return await f();
      } finally {
        this.stats.readsAtOnce--;
      }
    });
    this.reading = run.catch(() => {});
    return run;
  }

  private async unpause(c: Conn) {
    if (!this.paused?.until || this.paused.until > this.clock.now()) return;
    this.paused = null;
    await this.metaPut(key(c.ns, "paused"), undefined);
    this.kick();
  }

  // ---- the rebuild (step 4 does it; step 3 asks for it)

  private async flagRebuild(ns: string, why: "refused" | "invalid" | "diverged", detail?: string) {
    const cur = await this.metaGet<{ why: string }>(key(ns, "rebuild"));
    // (a halt is never lowered to a plain refusal's flag)
    if (cur && cur.why !== "refused" && why === "refused") return;
    await this.metaPut(key(ns, "rebuild"), { why, at: this.clock.now(), ...(detail ? { detail: detail.slice(0, 300) } : {}) });
  }
  private async halt(c: Conn, why: "invalid" | "diverged", detail: string) {
    c.halted = why;
    await this.flagRebuild(c.ns, why, detail);
    this.showWaiting(c, (await c.ob.status()).count);
  }

  // ---- timers (L3), persisted

  private async loadDurable(ns: string) {
    const all = await inTx(this.w.ws, META, "readonly", async (tx) => {
      const meta = tx.objectStore(META);
      const prefix = key(ns, "retry:");
      const keys = (await req(meta.getAllKeys(IDBKeyRange.bound(prefix, prefix + "￿")))) as string[];
      const out: [string, Timer][] = [];
      for (const k of keys) out.push([k.slice(prefix.length), (await req(meta.get(k))) as Timer]);
      const paused = (await req(meta.get(key(ns, "paused")))) as Paused | undefined;
      return { out, paused };
    });
    this.timers = new Map(all.out.filter(([, t]) => t && isNat(t.n) && typeof t.at === "number"));
    this.timerNs = ns;
    this.paused = all.paused ?? null;
    if (this.paused?.until !== undefined && this.paused.until <= this.clock.now()) this.paused = null;
  }
  /** ms left on `kind`'s timer. */
  private left(ns: string, kind: Work): number {
    if (ns !== this.timerNs) return 0;
    const t = this.timers.get(kind);
    return t ? Math.max(0, t.at - this.clock.now()) : 0;
  }
  private async waitTimer(ns: string, kind: Work) {
    const ms = this.left(ns, kind);
    if (ms > 0) await this.sleep(ms);
  }
  /** `kind` failed: its timer set (retry_after, else the next step of its backoff), persisted; returns when it ends. */
  private async timerFail(ns: string, kind: Work, retryAfter?: number): Promise<number> {
    const prev = ns === this.timerNs ? this.timers.get(kind) : undefined;
    const n = (prev?.n ?? 0) + 1;
    const { min, max, jitter } = CLIENT.backoff;
    const base = Math.min(max, min * 2 ** (n - 1));
    const ms = retryAfter !== undefined ? retryAfter : Math.round(base * (1 + (this.clock.random() * 2 - 1) * jitter));
    const t = { at: this.clock.now() + ms, n };
    if (ns === this.timerNs) {
      this.timers.set(kind, t);
      if (ns !== "-") await this.metaPut(key(ns, "retry:" + kind), t);
    }
    return t.at;
  }
  private async timerOk(ns: string, kind: Work) {
    if (ns !== this.timerNs || !this.timers.has(kind)) return;
    this.timers.delete(kind);
    this.unwake(kind);
    if (ns !== "-") await this.metaPut(key(ns, "retry:" + kind), undefined);
  }
  /** `f` at `at`, as the one wake-up of `kind`: one already set for the same time is kept, one for another time
   * replaced, so however often it is asked for (an edit during a backoff asks each time), at most one is pending
   * per kind (LIMIT-PR58-1).  Ended with the connection, on success of its kind, and by stop(). */
  private wake(c: Conn, kind: string, at: number, f: () => void) {
    // (only for the current connection: a late answer to an older one sets, replaces or cancels nothing of the
    // next one's, astra's narrowed CORR-PR58-1)
    if (this.conn !== c) return;
    const cur = this.wakes.get(kind);
    if (cur && cur.at === at) return;
    cur?.cancel();
    const cancel = this.clock.after(Math.max(0, at - this.clock.now()), () => {
      if (this.wakes.get(kind)?.cancel !== cancel) return;
      this.wakes.delete(kind);
      this.stats.wakesFired++;
      if (!this.stopped) f();
    });
    this.wakes.set(kind, { at, cancel });
    this.stats.maxWakes = Math.max(this.stats.maxWakes, this.wakes.size);
  }
  private unwake(kind?: string) {
    for (const [k, w] of this.wakes) if (kind === undefined || k === kind) {
      w.cancel();
      this.wakes.delete(k);
    }
  }
  private sleep(ms: number): Promise<void> {
    return new Promise((ok) => {
      const cancel = this.clock.after(ms, () => {
        this.cancels.delete(stop);
        ok();
      });
      const stop = () => {
        cancel();
        ok();
      };
      this.cancels.add(stop);
    });
  }

  // ---- meta, and HTTP

  private async metaGet<T>(k: string): Promise<T | undefined> {
    return inTx(this.w.ws, META, "readonly", (tx) => req(tx.objectStore(META).get(k))) as Promise<T | undefined>;
  }
  private async metaPut(k: string, v: unknown) {
    await inTx(this.w.ws, META, "readwrite", async (tx) => {
      const meta = tx.objectStore(META);
      if (v === undefined) meta.delete(k);
      else meta.put(v, k);
    });
  }

  /** The headers that bind a blob request to a connection's account and generation (CORR-PR58-1). */
  private binding(c: Conn): Record<string, string> {
    return { "x-sync-account": c.account, "x-sync-generation": String(c.generation) };
  }

  private async http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ ok: boolean; status: number; body: unknown; code?: string; retryAfter?: number }> {
    let res: Response;
    try {
      const init: RequestInit = { method, credentials: "same-origin", headers: { ...headers } };
      if (body instanceof Uint8Array) {
        init.body = body as BodyInit;
        (init.headers as Record<string, string>)["content-type"] = "application/octet-stream";
      } else if (body !== undefined) {
        init.body = JSON.stringify(body);
        (init.headers as Record<string, string>)["content-type"] = "application/json";
      }
      res = await this.fetch(this.origin + path, init);
    } catch {
      return { ok: false, status: 0, body: null };
    }
    let b: unknown = null;
    try {
      b = await res.json();
    } catch {}
    const o = (b && typeof b === "object" ? b : {}) as { error?: unknown; retry_after?: unknown };
    const h = res.headers.get("retry-after");
    const ra = isNat(o.retry_after) ? o.retry_after : h && /^\d{1,7}$/.test(h) ? Number(h) * 1000 : undefined;
    return { ok: res.ok, status: res.status, body: b, ...(typeof o.error === "string" ? { code: o.error } : {}), ...(ra !== undefined ? { retryAfter: ra } : {}) };
  }
}

class Retry extends Error {
  constructor(readonly retryAfter?: number) { super("retry"); }
}
