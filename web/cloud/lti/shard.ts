// `LaunchShard`: 16 Durable Objects per registration, routed by the first hex
// digit of `state` (plan-lti-r5 §2.1, §3.3, §15.3).  It holds login
// transactions and launch tickets in time buckets, and is the authority for
// their single use.  Every transition is one synchronous step of this object
// (no await between its check and its write), so two racing requests can't
// both win.

import { DurableObject } from "cloudflare:workers";
import { byteLength, randomHex, same, testGate, testMode } from "./util.ts";

export const BUCKET_MS = 120_000;
export const LOGIN_MS = 600_000; // a pending transaction: 10 min
export const LAUNCHED_MS = 120_000; // a launched (storage-mode) transaction: 2 min
export const TICKET_MS = 120_000; // a launch ticket: 2 min, single use
export const SHARD_ROWS = 2000;
export const SHARD_BYTES = 4 * 1024 * 1024;
// tombstones keep their key: charged their measured size (charge errata, LIMIT-STAGEA1-3)
export const TX_TOMBSTONE = 208;
export const TICKET_TOMBSTONE = 112;
/** a used deep-link row keeps its 32-character id: the ticket tombstone's shape exactly, so its measured charge */
export const DL_TOMBSTONE = TICKET_TOMBSTONE;
/** a login transaction row, all columns counted (amendment 2 r1 §2.1) */
export const ROW_MAX = 2048;
/** The row's fixed columns besides its JSON (state 64, status, expires, bucket, size): counted in its ≤ 1 KiB. */
const FIXED = 96;
/** The stored JSON omits `state`, which is the row's key (a 64-hex column already counted in FIXED). */
const pack = (t: LoginTx) => JSON.stringify({ ...t, state: undefined });
const unpack = (state: string, data: string): LoginTx => ({ ...(JSON.parse(data) as Omit<LoginTx, "state">), state });

/** A login transaction T (§3.3).  `status` goes pending → (launched →) consumed. */
export interface LoginTx {
  state: string;
  nonce: string;
  rid: string;
  iss: string;
  client_id: string;
  deployment: string | null;
  target: string;
  login_hint: string;
  message_hint: string | null;
  mode: "storage" | "cookie";
  /** the window named by lti_storage_target, for storage mode */
  storage_target: string | null;
  created: number;
}

/** What a launch ticket carries to the session (§3.4): the validated launch, never the raw token. */
export interface LaunchClaims {
  rid: string;
  deployment: string;
  context: string;
  context_title: string | null;
  resource_link: string | null;
  sub: string;
  role: "instructor" | "learner" | "guest";
  /** for an instructor only: a TA or a full instructor (amendment 5 r5 §1); absent otherwise */
  staff?: "instructor" | "ta";
  message_type: string;
  target: string;
  launched_at: number;
  return_url: string | null;
  /** a deep-link request's settings (r5 §4.1–4.2); in a ticket, replaced by `dl_ref` */
  dl?: DeepLinkRequest;
  /** the deep-link transaction this ticket opens (`<digit>:<id>`, in the same shard) */
  dl_ref?: string;
  /** the launch's AGS endpoint claim (r5 §5.1), validated; recorded on the placement */
  ags?: { scope: string[]; lineitems?: string; lineitem?: string };
  /** the assignment a deep-linked placement names (custom `sb_assignment`), if well formed; checked at launch (amendment 3) */
  aid?: string;
  /** amendment 3 r15 §4: the placement's pin (sb_assignment, sb_rev, sb_item), checked at every launch */
  sb?: { aid: string; rev: number; item: string | null } | { bad: true };
}

/** What r5 §4 keeps of a deep-link request: everything the response is built from, never from the browser. */
export interface DeepLinkRequest {
  return_url: string;
  /** the request's `data` claim, as JSON text, exactly; absent if the request had none */
  data_json?: string;
  accept_types: string[];
  accept_multiple: boolean;
  targets: string[];
  accept_lineitem: boolean;
  auto_create?: boolean;
}

/** A stored deep-link transaction (r5 §4.1): 30 minutes, single use. */
export interface DeepLinkTx extends DeepLinkRequest {
  rid: string;
  deployment: string;
  context: string;
  sub: string;
}
export const DL_MS = 30 * 60_000;
export const DL_ROW_MAX = 1024;

type Answer<T> = { ok: true; value: T } | { ok: false; code: string };
const no = <T>(code: string): Answer<T> => ({ ok: false, code });

const bucketOf = (expires: number) => Math.floor(expires / BUCKET_MS) + 1;

export class LtiLaunchShard extends DurableObject {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tx (state TEXT PRIMARY KEY, status TEXT NOT NULL, expires INTEGER NOT NULL, bucket INTEGER NOT NULL, data TEXT NOT NULL, corr TEXT, idt_hash TEXT, claims TEXT, size INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tx_bucket ON tx (bucket);
      CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, used INTEGER NOT NULL, expires INTEGER NOT NULL, bucket INTEGER NOT NULL, claims TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tickets_bucket ON tickets (bucket);
      CREATE TABLE IF NOT EXISTS dl (id TEXT PRIMARY KEY, used INTEGER NOT NULL, expires INTEGER NOT NULL, bucket INTEGER NOT NULL, data TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS dl_bucket ON dl (bucket);`);
  }

  private usage(): { rows: number; bytes: number } {
    const a = this.sql.exec("SELECT count(*) AS n, coalesce(sum(size), 0) AS b FROM tx").one() as { n: number; b: number };
    const b = this.sql.exec("SELECT count(*) AS n, coalesce(sum(size), 0) AS b FROM tickets").one() as { n: number; b: number };
    const c = this.sql.exec("SELECT count(*) AS n, coalesce(sum(size), 0) AS b FROM dl").one() as { n: number; b: number };
    return { rows: a.n + b.n + c.n, bytes: a.b + b.b + c.b };
  }

  private fits(size: number, rows = 1): boolean {
    const u = this.usage();
    return u.rows + rows <= SHARD_ROWS && u.bytes + size <= SHARD_BYTES;
  }

  /** A new login transaction, pending for 10 minutes.  Refused when the shard is full (§15.3). */
  begin(t: LoginTx): Answer<null> {
    const now = Date.now();
    this.sweep(now);
    const data = pack(t);
    const size = byteLength(data) + FIXED;
    // (the exact serialized row, JSON escapes included, against amendment 2's 2 KiB; atomic: nothing is written on refusal)
    if (size > ROW_MAX) return no("too_large");
    if (!this.fits(size)) return no("shard_full");
    const expires = now + LOGIN_MS;
    this.sql.exec("INSERT INTO tx (state, status, expires, bucket, data, size) VALUES (?, 'pending', ?, ?, ?, ?)", t.state, expires, bucketOf(expires), data, size);
    void this.arm();
    return { ok: true, value: null };
  }

  /** The pending transaction for `state`, if it exists and hasn't expired.  Nothing changes. */
  pending(state: string): LoginTx | null {
    const r = [...this.sql.exec("SELECT status, expires, data FROM tx WHERE state = ?", state)][0] as { status: string; expires: number; data: string } | undefined;
    if (!r || r.status !== "pending" || r.expires <= Date.now()) return null;
    return unpack(state, r.data);
  }

  /**
   * Cookie mode: pending → consumed, and a ticket, atomically (§3.3 step 2).
   * With no claims (a guest, §3.2), it is consumed and no ticket is made.
   */
  consume(state: string, claims: LaunchClaims | null): Answer<string | null> {
    const now = Date.now();
    const r = [...this.sql.exec("SELECT status, expires FROM tx WHERE state = ?", state)][0] as { status: string; expires: number } | undefined;
    if (!r || r.status !== "pending" || r.expires <= now) return no("state");
    if (claims === null) {
      this.tombstone(state);
      return { ok: true, value: null };
    }
    return this.ticket(claims, now, state);
  }

  /**
   * The storage page's fallback (§3.3 step 1): a pending storage-mode
   * transaction becomes cookie mode, server-side, since browser JS can't set
   * an HttpOnly cookie or change the persisted mode itself.
   */
  toCookie(state: string): LoginTx | null {
    const now = Date.now();
    const r = [...this.sql.exec("SELECT status, expires, data FROM tx WHERE state = ?", state)][0] as { status: string; expires: number; data: string } | undefined;
    if (!r || r.status !== "pending" || r.expires <= now) return null;
    const t = unpack(state, r.data);
    if (t.mode !== "storage") return null;
    t.mode = "cookie";
    this.sql.exec("UPDATE tx SET data = ? WHERE state = ?", pack(t), state);
    return t;
  }

  /** Storage mode: pending → launched, recording corr and the id_token's hash, for 2 minutes (§3.3). */
  launch(state: string, corr: string, idtHash: string, claims: LaunchClaims): Answer<null> {
    const now = Date.now();
    const r = [...this.sql.exec("SELECT status, expires, size FROM tx WHERE state = ?", state)][0] as { status: string; expires: number; size: number } | undefined;
    if (!r || r.status !== "pending" || r.expires <= now) return no("state");
    const c = JSON.stringify(claims);
    const extra = byteLength(c) + 96;
    const u = this.usage();
    if (r.size + extra > ROW_MAX) return no("too_large");
    if (u.bytes + extra > SHARD_BYTES) return no("shard_full");
    const expires = Math.min(r.expires, now + LAUNCHED_MS);
    this.sql.exec("UPDATE tx SET status = 'launched', corr = ?, idt_hash = ?, claims = ?, expires = ?, bucket = ?, size = size + ? WHERE state = ?", corr, idtHash, c, expires, bucketOf(expires), extra, state);
    return { ok: true, value: null };
  }

  /**
   * §3.3 step 3: consume T iff it is `launched`, unexpired, and corr, state and
   * nonce all match; then a launch ticket.  A second verify finds it consumed.
   */
  verify(corr: string, state: string, nonce: string): Answer<string> {
    const now = Date.now();
    const r = [...this.sql.exec("SELECT status, expires, data, corr, claims FROM tx WHERE state = ?", state)][0] as { status: string; expires: number; data: string; corr: string | null; claims: string | null } | undefined;
    if (!r || r.status !== "launched" || r.expires <= now || !r.corr || !r.claims) return no("state");
    const t = unpack(state, r.data);
    if (!same(r.corr, corr) || !same(t.nonce, nonce)) return no("mismatch");
    return this.ticket(JSON.parse(r.claims), now, state);
  }

  /**
   * A launch ticket: 128 random bits, 2 minutes, single use (§3.3), made as
   * `state`'s transaction is consumed, in one step.  The whole transition is
   * admitted before anything is written (CORR-LTIDL-1, LIMIT-PR8-1): the
   * ticket's exact row, a deep link's row beside it, and the consumed
   * transaction's change to its tombstone, against both caps, so a deep link
   * takes its two rows or none.  A refusal writes nothing: the transaction
   * stays pending, to be retried.
   */
  private ticket(claims: LaunchClaims, now: number, state: string): Answer<string> {
    const cur = [...this.sql.exec("SELECT size FROM tx WHERE state = ?", state)][0] as { size: number } | undefined;
    if (!cur) return no("state");
    let dl: { id: string; data: string; size: number } | null = null;
    let tc = claims;
    if (claims.dl) {
      // a deep-link request: its transaction is stored here, beside the ticket, and the ticket names it (r5 §4.1)
      const tx: DeepLinkTx = { ...claims.dl, rid: claims.rid, deployment: claims.deployment, context: claims.context, sub: claims.sub };
      const data = JSON.stringify(tx);
      dl = { id: randomHex(16), data, size: byteLength(data) + 64 };
      if (dl.size > DL_ROW_MAX) return no("deep_link_too_large");
      tc = { ...claims, dl: undefined, dl_ref: dl.id };
    }
    const c = JSON.stringify(tc);
    const size = byteLength(c) + 96;
    if (size > 1024) return no("too_large");
    if (!this.fits(size + (dl?.size ?? 0) + (TX_TOMBSTONE - cur.size), dl ? 2 : 1)) return no("shard_full");
    const id = randomHex(16);
    const expires = now + TICKET_MS;
    this.sql.exec("INSERT INTO tickets (id, used, expires, bucket, claims, size) VALUES (?, 0, ?, ?, ?, ?)", id, expires, bucketOf(expires), c, size);
    if (dl) {
      const exp = now + DL_MS;
      this.sql.exec("INSERT INTO dl (id, used, expires, bucket, data, size) VALUES (?, 0, ?, ?, ?, ?)", dl.id, exp, Math.floor(exp / BUCKET_MS) + 1, dl.data, dl.size);
    }
    this.tombstone(state);
    void this.arm();
    return { ok: true, value: id };
  }

  /** Redeem a launch ticket once (§3.3): it becomes a tombstone until its bucket expires. */
  redeem(id: string): Answer<LaunchClaims> {
    const now = Date.now();
    const r = [...this.sql.exec("SELECT used, expires, claims FROM tickets WHERE id = ?", id)][0] as { used: number; expires: number; claims: string } | undefined;
    if (!r || r.used || r.expires <= now) return no("ticket");
    this.sql.exec("UPDATE tickets SET used = 1, claims = '', size = ? WHERE id = ?", TICKET_TOMBSTONE, id);
    return { ok: true, value: JSON.parse(r.claims) };
  }

  /** A used transaction is replaced by a ≤ 64 B tombstone until its bucket expires, so replays stay refused. */
  private tombstone(state: string): void {
    this.sql.exec("UPDATE tx SET status = 'consumed', data = '', corr = NULL, idt_hash = NULL, claims = NULL, size = ? WHERE state = ?", TX_TOMBSTONE, state);
  }

  /** Delete whole expired buckets: at most one per call (§15.3). */
  private sweep(now: number): boolean {
    const r = this.sql.exec("SELECT min(b) AS b FROM (SELECT min(bucket) AS b FROM tx UNION ALL SELECT min(bucket) AS b FROM tickets UNION ALL SELECT min(bucket) AS b FROM dl)").one() as { b: number | null };
    if (r.b === null || r.b * BUCKET_MS > now) return false;
    this.sql.exec("DELETE FROM tx WHERE bucket = ?", r.b);
    this.sql.exec("DELETE FROM tickets WHERE bucket = ?", r.b);
    this.sql.exec("DELETE FROM dl WHERE bucket = ?", r.b);
    return true;
  }

  private async arm(): Promise<void> {
    const r = this.sql.exec("SELECT min(b) AS b FROM (SELECT min(bucket) AS b FROM tx UNION ALL SELECT min(bucket) AS b FROM tickets UNION ALL SELECT min(bucket) AS b FROM dl)").one() as { b: number | null };
    if (r.b !== null) {
      const at = r.b * BUCKET_MS;
      const cur = await this.ctx.storage.getAlarm();
      if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
    }
  }

  async alarm(): Promise<void> {
    // (tests only: a byte-exact level check holds the sweep, so no bucket expires in its middle)
    await testGate("shard_sweep");
    this.sweep(Date.now());
    await this.arm();
  }

  /** A live deep-link transaction, unchanged. */
  dlGet(id: string): DeepLinkTx | null {
    const r = [...this.sql.exec("SELECT used, expires, data FROM dl WHERE id = ?", id)][0] as { used: number; expires: number; data: string } | undefined;
    if (!r || r.used || r.expires <= Date.now()) return null;
    return JSON.parse(r.data);
  }

  /** Consume a deep-link transaction once (r5 §4.5): it becomes a tombstone until its bucket expires. */
  dlConsume(id: string): DeepLinkTx | null {
    const t = this.dlGet(id);
    if (!t) return null;
    this.sql.exec("UPDATE dl SET used = 1, data = '', size = ? WHERE id = ?", DL_TOMBSTONE, id);
    return t;
  }

  /** (tests) rows and bytes held */
  stats(): { rows: number; bytes: number } {
    return this.usage();
  }

  /** Tests only: rows and charged bytes, by kind and status. */
  testStats(): { tx: { status: string; n: number; bytes: number }[]; tickets: { used: number; n: number; bytes: number }[] } {
    if (!testMode()) throw new Error("test only");
    return {
      tx: [...this.sql.exec("SELECT status, count(*) AS n, sum(size) AS bytes FROM tx GROUP BY status")] as never,
      tickets: [...this.sql.exec("SELECT used, count(*) AS n, sum(size) AS bytes FROM tickets GROUP BY used")] as never,
    };
  }


  /** Tests only: the shard's rows and bytes, and a padding row of `bytes` charged bytes (or none) to reach an exact level. */
  testLevel(a: { pad?: number; padRows?: number }): { rows: number; bytes: number } {
    if (!testMode()) throw new Error("test only");
    this.sql.exec("DELETE FROM tx WHERE status = 'pad'");
    const exp = Date.now() + 3600_000;
    // (padRows rows of 1 B each, then one row carrying the rest of `pad`)
    for (let i = 0; i < (a.padRows ?? 0); i++) this.sql.exec("INSERT INTO tx (state, status, expires, bucket, data, size) VALUES (?, 'pad', ?, ?, '', 1)", "pad" + randomHex(30), exp, bucketOf(exp));
    if (a.pad) this.sql.exec("INSERT INTO tx (state, status, expires, bucket, data, size) VALUES (?, 'pad', ?, ?, '', ?)", "pad" + randomHex(30), exp, bucketOf(exp), a.pad);
    return this.usage();
  }

}
