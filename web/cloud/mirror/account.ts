// MirrorAccount: one Durable Object per account, the log mirror's only authority and its sole sequencer (plan r7,
// design B; SEC pins S1-S5, S8; amendments A1 and A2).  Reached only by this Worker (web/cloud/mirror/server.ts), over
// RPC, with the account id the Worker authenticated; it never sees a segment's bytes or a plaintext key.
//
// What it keeps, in its own SQLite storage:
// - the account's wrapped data key (one DEK per account, ruling (a)), in one row per KEK version (rotation);
// - conversations, each under a server-random locator (S1), never derived from its id;
// - streams, one per (conversation, log_instance): the next mirror position n, the agent's last seq, the last digest;
// - segments, each its R2 key's record: both ranges, the previous digest, the digest, key_id, nonce, sizes;
// - reservations (S2, H6's reserve, upload and commit; a reservation is "raising" until D1 has its claim, then "live"): the range, nonce and segment id each holds, burned if it is
//   abandoned; at most one per stream, so two pages racing one cursor can't both win;
// - the nonce counter: one for the account, every value used once (S3), refused at NONCE_MAX, never wrapped;
// - an outbox of R2 deletions, and tombstones of the locators and key_ids that are gone (S5).
//
// The budget (A2): the bytes the mirror holds are claimed in D1's budget_claims, holder "mirror", the account's one
// storage_bytes.  This object is the only writer of that row, and every write goes through one chain, one at a time,
// and sets an absolute value: what it holds now (segments, live reservations, objects waiting in the outbox).  A raise
// is conditional on everything else in the budget plus the new value fitting storage_bytes, and comes before what it
// pays for; a lowering comes after the bytes are gone, and only ever lowers.  So a crash anywhere leaves at most an
// overclaim, which the alarm repairs.  The object remembers the value D1 last confirmed (`claimed`): a raise the claim
// already covers only reads (the whole budget against today's cap), and a commit leaves its lowering to the alarm,
// LOWER_MS later.  So a conversation that
// appends turn after turn costs D1 a write now and then, not two each time; the claim stays above what is held.
import { DurableObject } from "cloudflare:workers";
import { SHARING_USED, budgetClaims, claimsWritable } from "../share/server.ts";
import { KEY_ID, LOCATOR, NONCE_MAX, WRAPPED, ZERO_DIGEST, locatorOf, type Wrapped } from "./crypto.ts";
import { LOG_INSTANCE, MIRROR_CAPS } from "../../workspace/agent-chat/mirror-format.ts";

export const MIRROR_LIMITS = Object.freeze({
  conversations: 500,
  /** log instances (agent runs) a conversation may have */
  streams: 32,
  /** a reservation's life: the Worker stops writing to R2 well before it ends (server.ts PUT_MARGIN_MS) */
  reserveMs: 120_000,
  /** an expired reservation's object is deleted this long after its end, past any write still on its way */
  lateMs: 60_000,
  /** outbox rows one alarm works through */
  outboxStep: 100,
  /** tombstones kept (oldest dropped first: locators and key_ids are random, never made twice) */
  tombs: 10_000,
  /** a conversation id, as the agent bounds it */
  conversationBytes: 256,
  locatorTries: 4,
  /** how soon after a commit the alarm lowers the claim to what is held */
  lowerMs: 5_000,
  /** after a lowering failed (D1 unavailable), how soon the alarm tries again: an overclaim is never left without one */
  lowerRetryMs: 30_000,
  /** a raise asks for this much more than it needs, when that fits, so the appends after it write nothing to D1 */
  headroom: 4 * 1024 * 1024,
});

export interface MirrorEnv {
  SHARE_DB?: D1Database;
  MIRROR_BUCKET?: R2Bucket;
  /** "on": claims may be written (share/server.ts claimsWritable); checked again here before every raise */
  BUDGET_CLAIMS?: string;
}

/** Why a page marked a stream stale (S6d): its entries differ from the runner's, the runner doesn't have them, they are
 *  from a run the live runner isn't, or another page holds the same range with other entries. */
export const STALE_REASONS = ["differs", "missing_on_runner", "other_run", "conflict"] as const;
export type StaleReason = (typeof STALE_REASONS)[number];
export interface Stale {
  stale_from: number | null;
  stale_reason: StaleReason | null;
}

export type MirrorCode = "forbidden" | "off" | "missing" | "conflict" | "busy" | "limit" | "storage_full" | "mode" | "expired" | "mismatch" | "exhausted" | "invalid";
export type R<T> = { ok: T } | { error: { code: MirrorCode; message?: string } };
const fail = (code: MirrorCode, message?: string): { error: { code: MirrorCode; message?: string } } => ({ error: { code, ...(message ? { message } : {}) } });

export interface RangeIn {
  log_instance: string;
  first_n: number;
  last_n: number;
  first_seq: number;
  last_seq: number;
}
export interface Reserved {
  res: string;
  key: string;
  segment: number;
  nonce: number;
  prev: string;
  bytes: number;
  expires: number;
  wraps: Wrapped[];
}
export interface SegmentRecord {
  locator: string;
  segment: number;
  log_instance: string;
  first_n: number;
  last_n: number;
  first_seq: number;
  last_seq: number;
  prev: string;
  digest: string;
  key_id: string;
  nonce: number;
  len: number;
  size: number;
}

const isPos = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const staleOf = (s: Record<string, SqlStorageValue> | undefined): Stale => ({
  stale_from: s?.stale_from === null || s?.stale_from === undefined ? null : Number(s.stale_from),
  stale_reason: s?.stale_reason === null || s?.stale_reason === undefined ? null : (String(s.stale_reason) as StaleReason),
});
const DIGEST = /^[0-9a-f]{64}$/;
/** An R2 key: acct/<account hash>/conv/<locator>/<segment, 12 digits> (r7 §2). */
export const objectKey = (hash: string, locator: string, segment: number) => `acct/${hash}/conv/${locator}/${String(segment).padStart(12, "0")}`;
const convPrefix = (hash: string, locator: string) => `acct/${hash}/conv/${locator}/`;
const acctPrefix = (hash: string) => `acct/${hash}/`;

export class MirrorAccount extends DurableObject<MirrorEnv> {
  protected sql: SqlStorage;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: MirrorEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS wraps (key_id TEXT NOT NULL, kek TEXT NOT NULL, wrapped TEXT NOT NULL, PRIMARY KEY (key_id, kek))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS convs (conversation TEXT PRIMARY KEY, locator TEXT NOT NULL UNIQUE, mode TEXT NOT NULL, next_segment INTEGER NOT NULL, created INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS streams (locator TEXT NOT NULL, log_instance TEXT NOT NULL, next_n INTEGER NOT NULL, last_seq INTEGER NOT NULL, last_digest TEXT NOT NULL, PRIMARY KEY (locator, log_instance))`);
    // (M2: a stream's stale marker, from the position on which a page found it disagrees with the runner (S6d); added
    //  to a table an earlier version made, where existing rows read NULL: not stale)
    const cols = this.sql.exec(`PRAGMA table_info(streams)`).toArray().map((c) => String(c.name));
    if (!cols.includes("stale_from")) this.sql.exec(`ALTER TABLE streams ADD COLUMN stale_from INTEGER`);
    if (!cols.includes("stale_reason")) this.sql.exec(`ALTER TABLE streams ADD COLUMN stale_reason TEXT`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS segments (locator TEXT NOT NULL, segment INTEGER NOT NULL, log_instance TEXT NOT NULL, first_n INTEGER NOT NULL, last_n INTEGER NOT NULL, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, prev TEXT NOT NULL, digest TEXT NOT NULL, key_id TEXT NOT NULL, nonce INTEGER NOT NULL, len INTEGER NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (locator, segment))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS segments_stream ON segments (locator, log_instance, first_n)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, locator TEXT NOT NULL, log_instance TEXT NOT NULL, segment INTEGER NOT NULL, first_n INTEGER NOT NULL, last_n INTEGER NOT NULL, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, prev TEXT NOT NULL, key_id TEXT NOT NULL, nonce INTEGER NOT NULL, bytes INTEGER NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, prefix INTEGER NOT NULL, bytes INTEGER NOT NULL, due INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tombs (kind TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (kind, id))`);
  }

  // ---- seams (overridden by the test object only)
  protected now(): number {
    return Date.now();
  }
  protected random(n: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  // ---- small helpers
  private get(k: string): string | undefined {
    const r = this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
    return r ? String(r.v) : undefined;
  }
  private set(k: string, v: string | number) {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, String(v));
  }
  private one(q: string, ...b: unknown[]): Record<string, SqlStorageValue> | undefined {
    return this.sql.exec(q, ...b).toArray()[0];
  }
  private num(q: string, ...b: unknown[]): number {
    return Number(this.one(q, ...b)?.n ?? 0);
  }
  /** The account this object is for: set by its first call, and every later call must name the same one. */
  private own(account: string, hash: string): boolean {
    if (typeof account !== "string" || !account || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return false;
    const a = this.get("account");
    if (a === undefined) {
      this.set("account", account);
      this.set("hash", hash);
      return true;
    }
    return a === account && this.get("hash") === hash;
  }
  private on(): boolean {
    return this.get("state") === "on";
  }
  private wrapsOf(key_id: string): Wrapped[] {
    return this.sql.exec(`SELECT key_id, kek, wrapped FROM wraps WHERE key_id = ?`, key_id).toArray().map((r) => ({ key_id: String(r.key_id), kek: String(r.kek), wrapped: String(r.wrapped) }));
  }
  private currentKey(): string | undefined {
    const k = this.get("key_id");
    return k && this.num(`SELECT COUNT(*) AS n FROM wraps WHERE key_id = ?`, k) > 0 ? k : undefined;
  }
  private tomb(kind: "locator" | "key", id: string) {
    this.sql.exec(`INSERT OR IGNORE INTO tombs (kind, id, at) VALUES (?, ?, ?)`, kind, id, this.now());
    const over = this.num(`SELECT COUNT(*) AS n FROM tombs`) - MIRROR_LIMITS.tombs;
    if (over > 0) this.sql.exec(`DELETE FROM tombs WHERE rowid IN (SELECT rowid FROM tombs ORDER BY at, rowid LIMIT ?)`, over);
  }
  private tombed(kind: "locator" | "key", id: string): boolean {
    return !!this.one(`SELECT 1 AS x FROM tombs WHERE kind = ? AND id = ?`, kind, id);
  }
  /** What the mirror holds against the budget now: committed segments, live reservations, objects waiting to go. */
  protected held(): number {
    return this.num(`SELECT (SELECT COALESCE(SUM(size), 0) FROM segments) + (SELECT COALESCE(SUM(bytes), 0) FROM reservations WHERE state = 'live') + (SELECT COALESCE(SUM(bytes), 0) FROM outbox) AS n`);
  }
  private wake(at: number) {
    void this.ctx.storage.getAlarm().then((cur) => {
      if (cur === null || cur > at) return this.ctx.storage.setAlarm(at);
    });
  }

  // ---- the budget chain (A2)

  /** f, after every earlier step of the chain has finished (each awaited in turn). */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const p = this.chain.then(f, f);
    this.chain = p.catch(() => {});
    return p;
  }
  /**
   * Raise the mirror's claim to `held() + extra` (with headroom when that fits too), if everything else in the account's
   * budget plus that fits `limit`: one conditional statement, so a race with sharing or sync lets at most the budget
   * through.  True if it did, or if the claim D1 last confirmed covers it already and the whole budget is within `limit`.
   */
  private raise(extra: number, limit: number): Promise<boolean> {
    return this.serial(async () => {
      const db = this.env.SHARE_DB;
      // (the one writer of a claim: only where every check of the budget counts it)
      if (!db || !(await claimsWritable(this.env))) return false;
      const target = this.held() + extra;
      const account = this.get("account")!, hash = this.get("hash")!;
      // (the claim D1 last confirmed covers it already, and everything in the budget, that claim included, is within
      // today's cap: one read, no write.  Not otherwise: after a cap comes down, or another holder grew under a higher
      // one, the conditional below decides, and old headroom is never spent past the current cap)
      const claimed = this.get("claimed");
      if (claimed !== undefined && Number(claimed) >= target) {
        const all = await db.prepare(
          `SELECT (${SHARING_USED}) + (SELECT COALESCE(SUM(bytes), 0) FROM budget_claims WHERE account_id = ?1)
             + (SELECT COALESCE(SUM(claim_bytes), 0) FROM sync_accounts WHERE account_hash = ?3 AND state <> 'purged') AS n`,
        ).bind(account, Math.floor(this.now() / 1000), hash).first<{ n: number }>();
        if (all && all.n <= limit) return true;
      }
      // (with headroom if that fits, else exactly: at the budget's edge, a raise is never refused for the headroom)
      for (const want of [target + MIRROR_LIMITS.headroom, target]) {
        // (everything in the budget but this holder's own row: sharing's bytes, the other holders', sync's claim)
        const r = await db.prepare(
          `INSERT INTO budget_claims (account_id, holder, bytes) SELECT ?1, 'mirror', ?3 WHERE (${SHARING_USED})
             + (SELECT COALESCE(SUM(bytes), 0) FROM budget_claims WHERE account_id = ?1 AND holder <> 'mirror')
             + (SELECT COALESCE(SUM(claim_bytes), 0) FROM sync_accounts WHERE account_hash = ?5 AND state <> 'purged')
             + ?3 <= ?4
           ON CONFLICT (account_id, holder) DO UPDATE SET bytes = excluded.bytes`,
        ).bind(account, Math.floor(this.now() / 1000), want, limit, hash).run();
        if ((r.meta?.changes ?? 0) === 1) {
          this.set("claimed", want);
          return true;
        }
      }
      return false;
    });
  }
  /** Lower the mirror's claim to what it holds now (never raise it: only raise() may, under its condition). */
  private lower(): Promise<void> {
    return this.serial(async () => {
      const db = this.env.SHARE_DB;
      const account = this.get("account");
      // (a lowering only ever lowers: it needs the table, not the binding)
      if (!db || !account || !(await budgetClaims(this.env))) return;
      // (forgotten first: if this write's answer is lost, the next raise writes rather than trusting a value D1 may not have)
      this.sql.exec(`DELETE FROM meta WHERE k = 'claimed'`);
      const r = await db.prepare(`UPDATE budget_claims SET bytes = MIN(bytes, ?2) WHERE account_id = ?1 AND holder = 'mirror' RETURNING bytes`).bind(account, this.held()).first<{ bytes: number }>();
      if (r) this.set("claimed", r.bytes);
    });
  }

  // ---- the account

  /** On or off, the encryption mode, conversations and bytes held. */
  async status(a: { account: string; hash: string }): Promise<R<{ state: string; mode: string; conversations: number; bytes: number; pending: number }>> {
    if (!this.own(a.account, a.hash)) return fail("forbidden");
    // (pending: R2 deletions still to do; the page says "Mirrored history deleted" only once it is 0)
    return { ok: { state: this.get("state") ?? "off", mode: this.get("mode") ?? "B", conversations: this.num(`SELECT COUNT(*) AS n FROM convs`), bytes: this.held(), pending: this.num(`SELECT COUNT(*) AS n FROM outbox`) } };
  }

  /** Turn the mirror on with the Worker's freshly wrapped DEK; if it is on with a key already, that key stays. */
  async enable(a: { account: string; hash: string; wrapped: Wrapped }): Promise<R<{ key_id: string }>> {
    if (!this.own(a.account, a.hash)) return fail("forbidden");
    const cur = this.currentKey();
    if (this.on() && cur) return { ok: { key_id: cur } };
    const w = a.wrapped;
    if (!w || !KEY_ID.test(w.key_id) || typeof w.kek !== "string" || !WRAPPED.test(w.wrapped) || this.tombed("key", w.key_id)) return fail("invalid");
    this.sql.exec(`DELETE FROM wraps`);
    // (an account's purge deletes the claim's row in D1 behind this object: what it last confirmed is forgotten)
    this.sql.exec(`DELETE FROM meta WHERE k = 'claimed'`);
    this.sql.exec(`INSERT INTO wraps (key_id, kek, wrapped) VALUES (?, ?, ?)`, w.key_id, w.kek, w.wrapped);
    this.set("key_id", w.key_id);
    this.set("state", "on");
    if (!this.get("mode")) this.set("mode", "B");
    return { ok: { key_id: w.key_id } };
  }

  /** Keep a rewrap of the current key under a newer KEK (rotation), dropping its other wraps. */
  async storeWrap(a: { account: string; hash: string; wrapped: Wrapped }): Promise<R<Record<string, never>>> {
    if (!this.own(a.account, a.hash)) return fail("forbidden");
    const w = a.wrapped;
    if (!this.on() || !w || w.key_id !== this.currentKey() || !WRAPPED.test(w.wrapped) || typeof w.kek !== "string") return fail("conflict");
    this.sql.exec(`INSERT INTO wraps (key_id, kek, wrapped) VALUES (?, ?, ?) ON CONFLICT (key_id, kek) DO UPDATE SET wrapped = excluded.wrapped`, w.key_id, w.kek, w.wrapped);
    this.sql.exec(`DELETE FROM wraps WHERE key_id = ? AND kek <> ?`, w.key_id, w.kek);
    return { ok: {} };
  }

  /**
   * Turn the mirror off (S5), also when the account's data is purged (an account sharing has marked deleting takes no
   * requests until its purge has finished, so nothing turns it on meanwhile): every wrapped DEK
   * version, every index row and reservation goes now, in one synchronous step; every object, and the account's
   * whole prefix, goes into the outbox; the locators and the key are tombstoned.  The objects' bytes stay claimed
   * until they are deleted.
   */
  async disable(a: { account: string; hash: string }): Promise<R<{ pending: number }>> {
    if (!this.own(a.account, a.hash)) return fail("forbidden");
    const hash = this.get("hash")!;
    const t = this.now();
    // (a mirror never turned on holds nothing: an account's purge reaches every account's object, and finds most so)
    if (this.get("state") === undefined && this.num(`SELECT (SELECT COUNT(*) FROM wraps) + (SELECT COUNT(*) FROM convs) + (SELECT COUNT(*) FROM reservations) + (SELECT COUNT(*) FROM outbox) AS n`) === 0)
      return { ok: { pending: 0 } };
    const inFlight = this.num(`SELECT COUNT(*) AS n FROM reservations WHERE state = 'live'`);
    for (const r of this.sql.exec(`SELECT locator, segment, size FROM segments`).toArray())
      this.sql.exec(`INSERT INTO outbox (key, prefix, bytes, due) VALUES (?, 0, ?, ?)`, objectKey(hash, String(r.locator), Number(r.segment)), Number(r.size), t);
    this.collectReservations(`SELECT * FROM reservations`, t);
    for (const r of this.sql.exec(`SELECT locator FROM convs`).toArray()) this.tomb("locator", String(r.locator));
    for (const r of this.sql.exec(`SELECT DISTINCT key_id FROM wraps`).toArray()) this.tomb("key", String(r.key_id));
    this.sql.exec(`DELETE FROM wraps`);
    this.sql.exec(`DELETE FROM segments`);
    this.sql.exec(`DELETE FROM streams`);
    this.sql.exec(`DELETE FROM convs`);
    this.sql.exec(`DELETE FROM meta WHERE k = 'key_id'`);
    // (the whole prefix now, and, if an upload was under way, once more after its write could have landed)
    this.sql.exec(`INSERT INTO outbox (key, prefix, bytes, due) VALUES (?, 1, 0, ?)`, acctPrefix(hash), t);
    if (inFlight > 0) this.sql.exec(`INSERT INTO outbox (key, prefix, bytes, due) VALUES (?, 1, 0, ?)`, acctPrefix(hash), t + MIRROR_LIMITS.reserveMs + MIRROR_LIMITS.lateMs);
    this.set("state", "off");
    this.set("epoch", Number(this.get("epoch") ?? 0) + 1);
    this.wake(t);
    return { ok: { pending: this.num(`SELECT COUNT(*) AS n FROM outbox`) } };
  }

  /** How many R2 deletions are still to do (an account's purge waits for none). */
  async pending(a: { account: string; hash: string }): Promise<R<{ pending: number; state: string }>> {
    if (!this.own(a.account, a.hash)) return fail("forbidden");
    return { ok: { pending: this.num(`SELECT COUNT(*) AS n FROM outbox`), state: this.get("state") ?? "off" } };
  }

  // ---- conversations

  /** The conversation's locator: allocated server-random on first use (S1, test mechanic 5), the same one after. */
  async conv(a: { account: string; hash: string; conversation: string }): Promise<R<{ locator: string }>> {
    if (!this.own(a.account, a.hash)) return fail("forbidden");
    if (!this.on()) return fail("off");
    const c = a.conversation;
    if (typeof c !== "string" || !c || new TextEncoder().encode(c).length > MIRROR_LIMITS.conversationBytes) return fail("invalid");
    const have = this.one(`SELECT locator FROM convs WHERE conversation = ?`, c);
    if (have) return { ok: { locator: String(have.locator) } };
    if (this.num(`SELECT COUNT(*) AS n FROM convs`) >= MIRROR_LIMITS.conversations) return fail("limit", `at most ${MIRROR_LIMITS.conversations} conversations`);
    // (no await between the check and the insert: two allocations can't both take one candidate)
    for (let i = 0; i < MIRROR_LIMITS.locatorTries; i++) {
      const locator = locatorOf(this.random(16));
      if (this.one(`SELECT 1 AS x FROM convs WHERE locator = ?`, locator) || this.tombed("locator", locator)) continue;
      this.sql.exec(`INSERT INTO convs (conversation, locator, mode, next_segment, created) VALUES (?, ?, ?, 1, ?)`, c, locator, this.get("mode") ?? "B", this.now());
      return { ok: { locator } };
    }
    return fail("busy", "no free locator");
  }

  /** The account's conversations, and what each stream has mirrored (the page uploads from there). */
  async list(a: { account: string; hash: string }): Promise<R<{ conversations: { conversation: string; locator: string; mode: string; streams: ({ log_instance: string; next_n: number; last_seq: number; last_digest: string } & Stale)[] }[] }>> {
    if (!this.own(a.account, a.hash)) return fail("forbidden");
    if (!this.on()) return fail("off");
    const streams = this.sql.exec(`SELECT * FROM streams ORDER BY log_instance`).toArray();
    return {
      ok: {
        conversations: this.sql.exec(`SELECT conversation, locator, mode FROM convs ORDER BY created`).toArray().map((c) => ({
          conversation: String(c.conversation),
          locator: String(c.locator),
          mode: String(c.mode),
          streams: streams.filter((s) => s.locator === c.locator).map((s) => ({ log_instance: String(s.log_instance), next_n: Number(s.next_n), last_seq: Number(s.last_seq), last_digest: String(s.last_digest), ...staleOf(s) })),
        })),
      },
    };
  }

  /**
   * Mark a stream stale from position `from_n` (S6d): only an existing stream, only a committed position
   * (1 <= from_n < next_n).  Monotonic: an earlier position replaces both the position and the reason, an equal or
   * later one changes nothing, and nothing clears a mark but deleting the stream.  No bodies, no digests.
   */
  async markStale(a: { account: string; hash: string; locator: string; log_instance: string; from_n: number; reason: string }): Promise<R<Stale>> {
    if (!this.own(a.account, a.hash)) return fail("forbidden");
    if (!this.on()) return fail("off");
    if (!LOCATOR.test(a.locator) || typeof a.log_instance !== "string" || !LOG_INSTANCE.test(a.log_instance) || !(STALE_REASONS as readonly string[]).includes(a.reason) || !isPos(a.from_n)) return fail("invalid");
    if (this.tombed("locator", a.locator)) return fail("missing");
    const s = this.one(`SELECT next_n FROM streams WHERE locator = ? AND log_instance = ?`, a.locator, a.log_instance);
    if (!s) return fail("missing"); // (never a new row: a mark can't add streams past MIRROR_LIMITS.streams)
    if (a.from_n >= Number(s.next_n)) return fail("invalid");
    this.sql.exec(`UPDATE streams SET stale_from = ?, stale_reason = ? WHERE locator = ? AND log_instance = ? AND (stale_from IS NULL OR stale_from > ?)`, a.from_n, a.reason, a.locator, a.log_instance, a.from_n);
    return { ok: staleOf(this.one(`SELECT stale_from, stale_reason FROM streams WHERE locator = ? AND log_instance = ?`, a.locator, a.log_instance)!) };
  }

  /** Delete one conversation: its objects into the outbox, its rows now, its locator tombstoned. */
  async deleteConv(a: { account: string; hash: string; locator: string }): Promise<R<Record<string, never>>> {
    if (!this.own(a.account, a.hash)) return fail("forbidden");
    if (!this.on()) return fail("off");
    if (!this.one(`SELECT 1 AS x FROM convs WHERE locator = ?`, a.locator)) return fail("missing");
    const hash = this.get("hash")!;
    const t = this.now();
    for (const r of this.sql.exec(`SELECT segment, size FROM segments WHERE locator = ?`, a.locator).toArray())
      this.sql.exec(`INSERT INTO outbox (key, prefix, bytes, due) VALUES (?, 0, ?, ?)`, objectKey(hash, a.locator, Number(r.segment)), Number(r.size), t);
    this.collectReservations(`SELECT * FROM reservations WHERE locator = ?`, t, a.locator);
    this.sql.exec(`DELETE FROM segments WHERE locator = ?`, a.locator);
    this.sql.exec(`DELETE FROM streams WHERE locator = ?`, a.locator);
    this.sql.exec(`DELETE FROM convs WHERE locator = ?`, a.locator);
    this.tomb("locator", a.locator);
    this.sql.exec(`INSERT INTO outbox (key, prefix, bytes, due) VALUES (?, 1, 0, ?), (?, 1, 0, ?)`, convPrefix(hash, a.locator), t, convPrefix(hash, a.locator), t + MIRROR_LIMITS.reserveMs + MIRROR_LIMITS.lateMs);
    this.wake(t);
    return { ok: {} };
  }

  // ---- appending: reserve, seal, commit (S2, S3, S4, S8)

  /**
   * Reserve the next segment of a stream, before the Worker reads the body: the range must continue the stream
   * exactly (or be exactly a committed segment's: `dup`, for an idempotent retry); the conversation in mode B; no other
   * reservation on the stream; a nonce and a segment id taken (burned if this goes no further); and the budget raised
   * in D1 for `bytes` first.  Only then is the reservation live.
   */
  async reserve(a: { account: string; hash: string; locator: string; range: RangeIn; bytes: number; limit: number }): Promise<R<Reserved | { dup: { segment: number; digest: string } }>> {
    if (!this.own(a.account, a.hash)) return fail("forbidden");
    if (!this.on()) return fail("off");
    const g = a.range;
    if (!LOCATOR.test(a.locator) || !g || typeof g.log_instance !== "string" || !LOG_INSTANCE.test(g.log_instance) || ![g.first_n, g.last_n, g.first_seq, g.last_seq].every(isPos)
      || g.last_n < g.first_n || g.last_n - g.first_n + 1 > MIRROR_CAPS.entries || g.last_seq - g.first_seq < g.last_n - g.first_n
      || !isPos(a.bytes) || !Number.isSafeInteger(a.limit) || a.limit < 0) return fail("invalid");
    if (this.tombed("locator", a.locator)) return fail("missing");
    const conv = this.one(`SELECT mode, next_segment FROM convs WHERE locator = ?`, a.locator);
    if (!conv) return fail("missing");
    // (S8: once C is on, for the account or this conversation, no B segment is taken)
    if ((this.get("mode") ?? "B") !== "B" || conv.mode !== "B") return fail("mode", "this conversation is encrypted on your devices");
    const key_id = this.currentKey();
    if (!key_id || this.tombed("key", key_id)) return fail("off");
    const s = this.one(`SELECT next_n, last_seq, last_digest FROM streams WHERE locator = ? AND log_instance = ?`, a.locator, g.log_instance);
    const next = s ? Number(s.next_n) : 1;
    if (g.first_n !== next) {
      const d = this.one(`SELECT segment, digest, first_seq, last_seq FROM segments WHERE locator = ? AND log_instance = ? AND first_n = ? AND last_n = ?`, a.locator, g.log_instance, g.first_n, g.last_n);
      if (d && Number(d.first_seq) === g.first_seq && Number(d.last_seq) === g.last_seq) return { ok: { dup: { segment: Number(d.segment), digest: String(d.digest) } } };
      return fail("conflict", g.first_n > next ? "a gap" : "an overlap");
    }
    if (s && g.first_seq <= Number(s.last_seq)) return fail("conflict", "agent numbers must increase");
    if (!s && this.num(`SELECT COUNT(*) AS n FROM streams WHERE locator = ?`, a.locator) >= MIRROR_LIMITS.streams) return fail("limit", `at most ${MIRROR_LIMITS.streams} agent runs a conversation`);
    if (this.one(`SELECT 1 AS x FROM reservations WHERE locator = ? AND log_instance = ?`, a.locator, g.log_instance)) return fail("busy", "another upload of this conversation is under way");
    const used = Number(this.get("nonce") ?? 0);
    if (used >= NONCE_MAX) return fail("exhausted", "this account's key can seal no more segments");
    const nonce = used + 1;
    this.set("nonce", nonce); // (taken now: burned whatever happens next)
    const segment = Number(conv.next_segment);
    this.sql.exec(`UPDATE convs SET next_segment = ? WHERE locator = ?`, segment + 1, a.locator);
    const id = Array.from(this.random(16), (x) => x.toString(16).padStart(2, "0")).join("");
    const t = this.now();
    const expires = t + MIRROR_LIMITS.reserveMs;
    const prev = s ? String(s.last_digest) : ZERO_DIGEST;
    this.sql.exec(`INSERT INTO reservations (id, locator, log_instance, segment, first_n, last_n, first_seq, last_seq, prev, key_id, nonce, bytes, state, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'raising', ?)`,
      id, a.locator, g.log_instance, segment, g.first_n, g.last_n, g.first_seq, g.last_seq, prev, key_id, nonce, a.bytes, expires);
    this.wake(expires);
    // (the claim first; a crash from here on leaves at most an overclaim)
    let raised = false;
    try {
      raised = await this.raise(a.bytes, a.limit);
    } catch {
      this.sql.exec(`DELETE FROM reservations WHERE id = ? AND state = 'raising'`, id);
      return fail("busy", "storage can't be checked now; try again");
    }
    if (!raised) {
      this.sql.exec(`DELETE FROM reservations WHERE id = ? AND state = 'raising'`, id);
      return fail("storage_full", "This account does not have enough free storage for this upload.");
    }
    // (turned off, or the conversation deleted, while D1 answered: the reservation went with it)
    if (this.sql.exec(`UPDATE reservations SET state = 'live' WHERE id = ? AND state = 'raising'`, id).rowsWritten !== 1) {
      this.wake(this.now());
      return fail("off");
    }
    return { ok: { res: id, key: objectKey(this.get("hash")!, a.locator, segment), segment, nonce, prev, bytes: a.bytes, expires, wraps: this.wrapsOf(key_id) } };
  }

  /**
   * Commit a live reservation with what the Worker sealed: the plaintext's digest and length, and the object's size
   * and SHA-256.  The object R2 holds must be exactly that one, else it is refused and collected.  Then the segment is
   * the stream's next; the alarm lowers the claim to what is held.
   */
  async commit(a: { account: string; hash: string; res: string; digest: string; len: number; size: number; sha: string }): Promise<R<{ segment: number; digest: string }>> {
    if (!this.own(a.account, a.hash)) return fail("forbidden");
    const r = this.one(`SELECT * FROM reservations WHERE id = ? AND state = 'live'`, a.res);
    if (!r) return fail("missing");
    if (Number(r.expires) <= this.now()) return fail("expired");
    if (!DIGEST.test(a.digest) || !DIGEST.test(a.sha) || !isPos(a.len) || !isPos(a.size) || a.size > Number(r.bytes)) return fail("invalid");
    const key = objectKey(this.get("hash")!, String(r.locator), Number(r.segment));
    const head = await this.env.MIRROR_BUCKET!.head(key);
    const sha = head?.checksums?.sha256 ? Array.from(new Uint8Array(head.checksums.sha256), (x) => x.toString(16).padStart(2, "0")).join("") : null;
    const again = this.one(`SELECT 1 AS x FROM reservations WHERE id = ? AND state = 'live'`, a.res);
    if (!again) return fail("off");
    if (!head || head.size !== a.size || sha !== a.sha) {
      this.collectReservations(`SELECT * FROM reservations WHERE id = ?`, this.now(), a.res);
      this.wake(this.now());
      return fail("mismatch", "the stored object isn't the one sealed");
    }
    const s = this.one(`SELECT next_n FROM streams WHERE locator = ? AND log_instance = ?`, r.locator, r.log_instance);
    if ((s ? Number(s.next_n) : 1) !== Number(r.first_n)) return fail("conflict"); // (never: one reservation a stream)
    this.sql.exec(`INSERT INTO segments (locator, segment, log_instance, first_n, last_n, first_seq, last_seq, prev, digest, key_id, nonce, len, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.locator, r.segment, r.log_instance, r.first_n, r.last_n, r.first_seq, r.last_seq, r.prev, a.digest, r.key_id, r.nonce, a.len, a.size);
    this.sql.exec(`INSERT INTO streams (locator, log_instance, next_n, last_seq, last_digest) VALUES (?, ?, ?, ?, ?) ON CONFLICT (locator, log_instance) DO UPDATE SET next_n = excluded.next_n, last_seq = excluded.last_seq, last_digest = excluded.last_digest`,
      r.locator, r.log_instance, Number(r.last_n) + 1, r.last_seq, a.digest);
    this.sql.exec(`DELETE FROM reservations WHERE id = ?`, a.res);
    // (the claim comes down to what is held by the alarm, soon: until then, an overclaim of at most this reservation)
    this.wake(this.now() + MIRROR_LIMITS.lowerMs);
    return { ok: { segment: Number(r.segment), digest: a.digest } };
  }

  /** Give a reservation up (the Worker refused the body, or failed): its object, if any, is collected. */
  async abandon(a: { account: string; hash: string; res: string }): Promise<R<Record<string, never>>> {
    if (!this.own(a.account, a.hash)) return fail("forbidden");
    this.collectReservations(`SELECT * FROM reservations WHERE id = ?`, this.now(), a.res);
    this.wake(this.now());
    return { ok: {} };
  }

  /**
   * Reservations into the outbox (their objects may exist, or still arrive: deleted after lateMs, and claimed until
   * then), and gone.  One that never went live has nothing to collect.
   */
  private collectReservations(q: string, t: number, ...b: unknown[]) {
    const hash = this.get("hash")!;
    for (const r of this.sql.exec(q, ...b).toArray()) {
      if (r.state !== "raising") this.sql.exec(`INSERT INTO outbox (key, prefix, bytes, due) VALUES (?, 0, ?, ?)`, objectKey(hash, String(r.locator), Number(r.segment)), Number(r.bytes), Math.max(t, Number(r.expires)) + MIRROR_LIMITS.lateMs);
      this.sql.exec(`DELETE FROM reservations WHERE id = ?`, r.id);
    }
  }

  // ---- reading (S6)

  /**
   * The stream's segment that starts at position `after + 1`, with what the reader checks it against: its record,
   * the previous segment's digest (the chain), and the key's wraps.  `end` if there is none.
   */
  async readPlan(a: { account: string; hash: string; locator: string; log_instance: string; after: number }): Promise<R<({ end: true } | { seg: SegmentRecord; key: string; chain: string; wraps: Wrapped[]; account: string }) & Stale>> {
    if (!this.own(a.account, a.hash)) return fail("forbidden");
    if (!this.on()) return fail("off");
    if (!LOCATOR.test(a.locator) || !LOG_INSTANCE.test(a.log_instance) || !Number.isSafeInteger(a.after) || a.after < 0) return fail("invalid");
    if (this.tombed("locator", a.locator) || !this.one(`SELECT 1 AS x FROM convs WHERE locator = ?`, a.locator)) return fail("missing");
    const stale = staleOf(this.one(`SELECT stale_from, stale_reason FROM streams WHERE locator = ? AND log_instance = ?`, a.locator, a.log_instance));
    const r = this.one(`SELECT * FROM segments WHERE locator = ? AND log_instance = ? AND first_n = ?`, a.locator, a.log_instance, a.after + 1);
    if (!r) return { ok: { end: true, ...stale } };
    const seg: SegmentRecord = {
      locator: String(r.locator), segment: Number(r.segment), log_instance: String(r.log_instance), first_n: Number(r.first_n), last_n: Number(r.last_n),
      first_seq: Number(r.first_seq), last_seq: Number(r.last_seq), prev: String(r.prev), digest: String(r.digest), key_id: String(r.key_id), nonce: Number(r.nonce), len: Number(r.len), size: Number(r.size),
    };
    const before = a.after === 0 ? null : this.one(`SELECT digest FROM segments WHERE locator = ? AND log_instance = ? AND last_n = ?`, a.locator, a.log_instance, a.after);
    if (a.after !== 0 && !before) return fail("missing");
    // (a key that is gone, or tombstoned: a restored index reads nothing)
    if (this.tombed("key", seg.key_id) || seg.key_id !== this.currentKey()) return fail("missing");
    return { ok: { seg, key: objectKey(this.get("hash")!, seg.locator, seg.segment), chain: before ? String(before.digest) : ZERO_DIGEST, wraps: this.wrapsOf(seg.key_id), account: this.get("account")!, ...stale } };
  }

  // ---- the alarm: expired reservations, the outbox, the claim

  async alarm(): Promise<void> {
    const t = this.now();
    // (expired: one still raising never went live, so it has no object; a live one may)
    this.collectReservations(`SELECT * FROM reservations WHERE expires <= ?`, t, t);
    const bucket = this.env.MIRROR_BUCKET;
    if (bucket) {
      for (const r of this.sql.exec(`SELECT id, key, prefix FROM outbox WHERE due <= ? ORDER BY id LIMIT ?`, t, MIRROR_LIMITS.outboxStep).toArray()) {
        try {
          if (Number(r.prefix)) {
            const l = await bucket.list({ prefix: String(r.key), limit: 1000 });
            if (l.objects.length) await bucket.delete(l.objects.map((o) => o.key));
            if (l.objects.length || l.truncated) continue; // (again: done once a list finds nothing)
          } else await bucket.delete(String(r.key));
          this.sql.exec(`DELETE FROM outbox WHERE id = ?`, r.id);
        } catch {
          // (R2 failed: the row stays, and the next alarm tries again)
        }
      }
    }
    // (the bytes are gone first, then the claim: and a stale overclaim is repaired here even if nobody writes again)
    let lowered = true;
    try {
      await this.lower();
    } catch {
      lowered = false; // (D1 failed: the overclaim stays, and an alarm comes back for it below, whatever else is pending)
    }
    const next = this.one(`SELECT MIN(x) AS n FROM (SELECT MIN(expires) AS x FROM reservations UNION ALL SELECT MIN(due) AS x FROM outbox)`);
    let at = next?.n === null || next?.n === undefined ? null : Math.max(Number(next.n), this.now() + 1000);
    if (at === null && this.num(`SELECT COUNT(*) AS n FROM outbox`) + this.num(`SELECT COUNT(*) AS n FROM reservations`) > 0) at = this.now() + 1000;
    if (!lowered) at = Math.min(at ?? Infinity, this.now() + MIRROR_LIMITS.lowerRetryMs);
    if (at !== null) await this.ctx.storage.setAlarm(at);
  }
}
