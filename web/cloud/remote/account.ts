// RemoteAccount: one Durable Object per account, the only authority for what an account's remotes may use (core
// design remote-v1 §5, r1.3 SEC1, r1.7 AGENT-BOUNDS-1).  Its state is in its own SQLite storage, never only in memory,
// so it survives eviction and hibernation:
//
// - the UTC-day byte budget (2 GiB), counted as the bytes it has granted: a relay forwards only against a byte lease
//   reserved here first.  A lease is kind-aware (max(4 MiB, the kind's largest message), rounded up to a whole 4 MiB:
//   4 MiB for runners, 16 MiB for agents), stamped with its UTC day and void after it, and at most 2 are outstanding
//   per remote.  Settling a lease records what was consumed (for reporting) but never gives today's grant back, so
//   today's forwarded bytes <= today's grants <= 2 GiB, exactly;
// - the connected slots: at most 2 peers connected per account, of any kind.  A slot is held by (remote_id, gen); the
//   same remote's newer connection takes its own slot over, and a release frees it only if that gen still holds it,
//   so a late release can't free a newer holder;
// - reporting: per-day totals written to D1 (remote_usage) at most once a minute, from this object's alarm.  D1 is
//   never the authority.
//
// Reached only by the account's RemoteRelay objects (never from a request directly), over fetch:
//   POST /lease   {remote_id, kind}         -> 200 {id, day, bytes} | 429 {error: "leases" | "budget"}
//   POST /settle  {id, consumed}            -> 200 {}  (idempotent; a lease of a past day settles too)
//   POST /acquire {remote_id, gen}          -> 200 {}  | 429 {error: "connected"}
//   POST /release {remote_id, gen}          -> 200 {released: boolean}
import { DurableObject } from "cloudflare:workers";
import { RELAY_CAPS, type Kind } from "./relay-caps.ts";

const MiB = 1024 * 1024;
export const ACCOUNT_LIMITS = Object.freeze({
  dayBytes: 2 * 1024 * MiB,
  leasesPerRemote: 2,
  connected: 2,
  reportMs: 60_000,
});

/** A kind's lease: max(4 MiB, its largest message either way), rounded up to a whole 4 MiB (AGENT-BOUNDS-1). */
export function leaseBytes(kind: Kind): number {
  let largest = 0;
  for (const c of Object.values(RELAY_CAPS[kind])) if (c) largest = Math.max(largest, c.pageToPeer, c.peerToPage);
  return Math.ceil(Math.max(4 * MiB, largest) / (4 * MiB)) * 4 * MiB;
}

/** The UTC day of a time (ms): "2026-11-06". */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface AccountEnv {
  SHARE_DB?: D1Database;
}

const json = (status: number, body: unknown) => Response.json(body, { status });
const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const isGen = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

export class RemoteAccount extends DurableObject<AccountEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: AccountEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, granted INTEGER NOT NULL, consumed INTEGER NOT NULL, reported INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, remote_id TEXT NOT NULL, day TEXT NOT NULL, bytes INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS slots (remote_id TEXT PRIMARY KEY, gen INTEGER NOT NULL)`);
  }

  /** The clock (ms).  (Tests: a subclass with a logical one.) */
  protected now(): number {
    return Date.now();
  }
  /** Peers connected at once per account.  (Tests: a subclass may relax it where slots aren't the subject.) */
  protected connectedCap(): number {
    return ACCOUNT_LIMITS.connected;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (req.method !== "POST") return json(405, { error: "method" });
    let b: Record<string, unknown>;
    try {
      b = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: "body" });
    }
    if (!b || typeof b !== "object") return json(400, { error: "body" });
    switch (path) {
      case "/lease":
        return await this.lease(b);
      case "/settle":
        return await this.settle(b);
      case "/acquire":
        return this.acquire(b);
      case "/release":
        return this.release(b);
      default:
        return json(404, { error: "path" });
    }
  }

  private account(): string | null {
    return (this.sql.exec(`SELECT v FROM meta WHERE k = 'account'`).toArray()[0]?.v as string | undefined) ?? null;
  }

  private async lease(b: Record<string, unknown>): Promise<Response> {
    const kind = b.kind;
    if (!isId(b.remote_id) || (kind !== "runner" && kind !== "agent")) return json(400, { error: "request" });
    if (typeof b.account === "string" && !this.account()) this.sql.exec(`INSERT OR IGNORE INTO meta VALUES ('account', ?)`, b.account);
    const day = utcDay(this.now());
    // (outstanding: today's, not settled; a past day's are void whatever their state)
    const open = this.sql.exec(`SELECT COUNT(*) AS n FROM leases WHERE remote_id = ? AND day = ? AND settled = 0`, b.remote_id, day).one().n as number;
    if (open >= ACCOUNT_LIMITS.leasesPerRemote) return json(429, { error: "leases" });
    const bytes = leaseBytes(kind);
    const row = this.sql.exec(`SELECT granted FROM days WHERE day = ?`, day).toArray()[0];
    const granted = (row?.granted as number | undefined) ?? 0;
    if (granted + bytes > ACCOUNT_LIMITS.dayBytes) return json(429, { error: "budget" });
    const id = crypto.randomUUID();
    // (one transaction: the grant counted and the lease recorded together, or neither)
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO days (day, granted, consumed) VALUES (?, ?, 0) ON CONFLICT(day) DO UPDATE SET granted = granted + excluded.granted`, day, bytes);
      this.sql.exec(`INSERT INTO leases (id, remote_id, day, bytes) VALUES (?, ?, ?, ?)`, id, b.remote_id, day, bytes);
    });
    await this.arm();
    return json(200, { id, day, bytes });
  }

  private async settle(b: Record<string, unknown>): Promise<Response> {
    const consumed = b.consumed;
    if (typeof b.id !== "string" || typeof consumed !== "number" || !Number.isSafeInteger(consumed) || consumed < 0) return json(400, { error: "request" });
    const row = this.sql.exec(`SELECT day, bytes, settled FROM leases WHERE id = ?`, b.id).toArray()[0];
    if (!row) return json(404, { error: "lease" });
    if (row.settled) return json(200, {});
    const used = Math.min(consumed, row.bytes as number);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE leases SET settled = 1 WHERE id = ?`, b.id);
      this.sql.exec(`UPDATE days SET consumed = consumed + ? WHERE day = ?`, used, row.day);
    });
    await this.arm();
    return json(200, {});
  }

  private acquire(b: Record<string, unknown>): Response {
    if (!isId(b.remote_id) || !isGen(b.gen)) return json(400, { error: "request" });
    const mine = this.sql.exec(`SELECT gen FROM slots WHERE remote_id = ?`, b.remote_id).toArray()[0];
    if (mine) {
      // (the same remote's newer connection takes its own slot over; an older gen never takes it back)
      if ((mine.gen as number) > b.gen) return json(409, { error: "stale" });
      this.sql.exec(`UPDATE slots SET gen = ? WHERE remote_id = ?`, b.gen, b.remote_id);
      return json(200, {});
    }
    const held = this.sql.exec(`SELECT COUNT(*) AS n FROM slots`).one().n as number;
    if (held >= this.connectedCap()) return json(429, { error: "connected" });
    this.sql.exec(`INSERT INTO slots (remote_id, gen) VALUES (?, ?)`, b.remote_id, b.gen);
    return json(200, {});
  }

  private release(b: Record<string, unknown>): Response {
    if (!isId(b.remote_id) || !isGen(b.gen)) return json(400, { error: "request" });
    const freed = this.sql.exec(`DELETE FROM slots WHERE remote_id = ? AND gen = ? RETURNING remote_id`, b.remote_id, b.gen).toArray().length > 0;
    return json(200, { released: freed });
  }

  // ---- reporting: D1 at most once a minute, only while there is something new to say
  private async arm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(this.now() + ACCOUNT_LIMITS.reportMs);
  }

  async alarm(): Promise<void> {
    const account = this.account();
    const db = this.env.SHARE_DB;
    // (forgotten days: kept 3 days for reporting, then removed with their leases)
    const keep = utcDay(this.now() - 3 * 86400_000);
    const rows = this.sql.exec(`SELECT day, granted, consumed FROM days WHERE reported < granted + consumed`).toArray();
    if (db && account) {
      for (const r of rows) {
        await db.prepare(`INSERT INTO remote_usage (account, day, granted, consumed) VALUES (?, ?, ?, ?)
                          ON CONFLICT(account, day) DO UPDATE SET granted = excluded.granted, consumed = excluded.consumed`)
          .bind(account, r.day, r.granted, r.consumed).run();
        this.sql.exec(`UPDATE days SET reported = ? WHERE day = ?`, (r.granted as number) + (r.consumed as number), r.day);
      }
    }
    this.sql.exec(`DELETE FROM leases WHERE day < ?`, keep);
    this.sql.exec(`DELETE FROM days WHERE day < ? AND reported >= granted + consumed`, keep);
  }
}
