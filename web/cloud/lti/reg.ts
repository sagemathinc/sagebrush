// `Reg`: one Durable Object per registration (plan-lti-r5 §2.1, §15.2).  It is
// the authority for every registration-wide rate and concurrency cap, by
// reserve / commit / release, and it caches the platform's JWKS.  State is in
// the object's SQLite, so a cap survives eviction.

import { DurableObject } from "cloudflare:workers";
import type { Jwk } from "./jwt.ts";
import { categoryHosts, trustedFetch, type EnvName, type Policy } from "./policy.ts";
import { LtiError, randomHex } from "./util.ts";
import { Mapping, type Answer, type HandleKind, type Issued, type MappingEnv } from "./mapping.ts";
import { AgsReg } from "./ags.ts";

/** Each reservation kind's rate bucket and concurrency (§15.2). */
export const KINDS: Record<string, { capacity?: number; perMs?: number; concurrent?: number }> = {
  launch: { capacity: 600, perMs: 60_000 / 600 },
  jwks: { capacity: 1, perMs: 60_000 },
  dynreg: { concurrent: 1 },
  // cocalc.ai calls: entitlements and amendment 1's purge and re-issue pages share it (§15.4: 60 a minute)
  entitlement: { capacity: 60, perMs: 1000 },
  // AGS: ≤ 10/s and ≤ 4 at once per registration, tokens and score posts alike (§15.2, §15.4)
  ags: { capacity: 10, perMs: 100, concurrent: 4 },
};
/** r5 §15.4's outbound budget: ≤ 200,000 subrequests a registration a UTC day, reserved per call, never refunded. */
export const OUTBOUND_PER_DAY = 200_000;
export const LEASE_MS = 30_000;
const JWKS_TTL_MS = 3600_000;

export type RegEnv = MappingEnv & { TOOL_KEY?: string };

export class LtiReg extends DurableObject<RegEnv> {
  private sql: SqlStorage;
  private map: Mapping;
  private ags: AgsReg;
  constructor(ctx: DurableObjectState, env: RegEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS buckets (kind TEXT PRIMARY KEY, tokens REAL NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, kind TEXT NOT NULL, expires INTEGER NOT NULL, rate INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS leases_expires ON leases (expires);
      CREATE TABLE IF NOT EXISTS jwks (one INTEGER PRIMARY KEY CHECK (one = 1), uri TEXT NOT NULL, keys TEXT NOT NULL, fetched INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbound_day (day INTEGER PRIMARY KEY, n INTEGER NOT NULL);`);
    this.map = new Mapping(this.sql, env, () => this.ridOf(), (at) => this.armAt(at), () => this.reserveOut());
    this.ags = new AgsReg(this.sql, env, (k) => this.reserve(k), (l) => this.commit(l), () => this.outUnit());
  }

  /** This object's registration id, recorded on first use and checked on every mapping call. */
  private ridOf(): string {
    const r = [...this.sql.exec("SELECT v FROM meta WHERE k = 'rid'")][0] as { v: string } | undefined;
    if (!r) throw new Error("rid unknown");
    return r.v;
  }
  private bindRid(rid: string): void {
    const r = [...this.sql.exec("SELECT v FROM meta WHERE k = 'rid'")][0] as { v: string } | undefined;
    if (!r) this.sql.exec("INSERT INTO meta (k, v) VALUES ('rid', ?)", rid);
    else if (r.v !== rid) throw new Error("rid mismatch");
  }
  private async armAt(at: number): Promise<void> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
  }

  // ---- AGS (§5.2, §15.2)
  agsCall(rid: string, p: Parameters<AgsReg["call"]>[0]) {
    this.bindRid(rid);
    return this.ags.call(p);
  }
  agsCharge(rid: string, qid: string, inc: number, course: string) {
    this.bindRid(rid);
    return this.ags.charge(qid, inc, course);
  }
  agsRelease(rid: string, qid: string, inc: number) {
    this.bindRid(rid);
    return this.ags.release(qid, inc);
  }
  agsChargedCount() {
    return this.ags.chargedCount();
  }

  // ---- the handle mapping and erasure (amendment 1 r6), each naming its registration
  async issue(rid: string, personInt: string, course: string): Promise<Answer<Issued>> {
    this.bindRid(rid);
    try {
      return await this.map.issue(personInt, course);
    } catch (e) {
      return { ok: false, code: e instanceof LtiError ? e.code : "error" };
    }
  }
  async startErase(rid: string, e: { erase_id: string; person_int: string; issued_at: number }) {
    this.bindRid(rid);
    return this.map.startErase(e);
  }
  async mappingHold(rid: string): Promise<void> {
    this.bindRid(rid);
    await this.map.hold();
  }
  async mappingRelease(rid: string, epochId: string, reportedSeq: number) {
    this.bindRid(rid);
    return this.map.release(epochId, reportedSeq);
  }
  reconcile(rid: string, handles: { seq: number; handle: string; kind: HandleKind }[]) {
    this.bindRid(rid);
    return this.map.reconcile(handles);
  }
  resolveLost(rid: string, d: Parameters<Mapping["resolveLost"]>[0]) {
    this.bindRid(rid);
    return this.map.resolveLost(d);
  }
  inspectMapping(rid: string) {
    this.bindRid(rid);
    return this.map.inspect();
  }
  /** (tests only) a bucket's raw state and the live leases of a kind */
  inspectBucket(kind: string): { tokens: number | null; updated: number | null; leases: number } | null {
    if ((globalThis as { __SAGEBRUSH_LTI_TEST__?: boolean }).__SAGEBRUSH_LTI_TEST__ !== true) return null;
    const b = [...this.sql.exec("SELECT tokens, updated FROM buckets WHERE kind = ?", kind)][0] as { tokens: number; updated: number } | undefined;
    const n = this.sql.exec("SELECT count(*) AS n FROM leases WHERE kind = ?", kind).one() as { n: number };
    return { tokens: b?.tokens ?? null, updated: b?.updated ?? null, leases: n.n };
  }

  /** (tests only; off outside the test entry) */
  testSeam(rid: string, op: Parameters<Mapping["testSeam"]>[0]): boolean {
    this.bindRid(rid);
    return this.map.testSeam(op);
  }

  /** (tests) run one wake of erasure work now; with `due`, every job is made due first */
  async runStep(rid: string, due = false): Promise<number | null> {
    this.bindRid(rid);
    if (due) this.sql.exec("UPDATE erasures SET next_at = 0");
    return this.map.step();
  }

  /**
   * One outbound fetch's day and Fleet units (r5 §15.4): the registration's daily budget, then Fleet.
   * False means no fetch is made.  Fleet unbound is refused (fail closed); a day unit taken before a Fleet
   * refusal stays spent: an overcount, never an undercount.
   */
  async outUnit(): Promise<boolean> {
    const day = Math.floor(Date.now() / 86_400_000);
    const used = ([...this.sql.exec("SELECT n FROM outbound_day WHERE day = ?", day)][0] as { n: number } | undefined)?.n ?? 0;
    const fleet = this.env.LTI_FLEET;
    if (used >= OUTBOUND_PER_DAY || !fleet) return false;
    this.sql.exec("INSERT INTO outbound_day (day, n) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET n = n + 1", day);
    this.sql.exec("DELETE FROM outbound_day WHERE day < ?", day - 2);
    return await fleet.get(fleet.idFromName("fleet")).reserve();
  }

  /**
   * The entitlement envelope for one cocalc.ai call (amendment 1 r6 §4.3): the
   * shared bucket, then the day's outbound budget, then Fleet.  All or nothing;
   * null means no fetch is made.
   */
  async reserveOut(): Promise<{ release(): void } | null> {
    const lease = this.reserve("entitlement");
    if (!lease) return null;
    if (!(await this.outUnit())) {
      this.release(lease);
      return null;
    }
    return { release: () => this.commit(lease) };
  }

  /** Tests only: set today's outbound count (to exhaust or restore the daily budget). */
  testOutboundDay(n: number): boolean {
    if ((globalThis as { __SAGEBRUSH_LTI_TEST__?: boolean }).__SAGEBRUSH_LTI_TEST__ !== true) return false;
    const day = Math.floor(Date.now() / 86_400_000);
    this.sql.exec("INSERT INTO outbound_day (day, n) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET n = excluded.n", day, n);
    return true;
  }

  /** Tests only: put a bucket deep in debt (refused for a long time), or clear it (full again). */
  testBucket(kind: string, spent: boolean): boolean {
    if ((globalThis as { __SAGEBRUSH_LTI_TEST__?: boolean }).__SAGEBRUSH_LTI_TEST__ !== true) return false;
    if (spent) this.sql.exec("INSERT OR REPLACE INTO buckets (kind, tokens, updated) VALUES (?, -1000000, ?)", kind, Date.now());
    else this.sql.exec("DELETE FROM buckets WHERE kind = ?", kind);
    return true;
  }

  /** Tests only: refill a bucket, as a minute's wait would (a long test file spends the launch bucket). */
  testRefill(kind: string): boolean {
    if ((globalThis as { __SAGEBRUSH_LTI_TEST__?: boolean }).__SAGEBRUSH_LTI_TEST__ !== true) return false;
    this.sql.exec("DELETE FROM buckets WHERE kind = ?", kind);
    return true;
  }

  /** Reserve one unit of `kind`.  Refused (null) if its bucket or its concurrency doesn't allow it. */
  reserve(kind: string): string | null {
    const k = KINDS[kind];
    if (!k) throw new Error("unknown kind");
    const now = Date.now();
    this.expire(now);
    if (k.concurrent !== undefined) {
      const n = this.sql.exec("SELECT count(*) AS n FROM leases WHERE kind = ?", kind).one().n as number;
      if (n >= k.concurrent) return null;
    }
    let rate = 0;
    if (k.capacity !== undefined) {
      const tokens = this.tokens(kind, now);
      if (tokens < 1) return null;
      this.sql.exec("INSERT OR REPLACE INTO buckets (kind, tokens, updated) VALUES (?, ?, ?)", kind, tokens - 1, now);
      rate = 1;
    }
    const id = randomHex(16);
    this.sql.exec("INSERT INTO leases (id, kind, expires, rate) VALUES (?, ?, ?, ?)", id, kind, now + LEASE_MS, rate);
    void this.arm();
    return id;
  }

  /** The lease's use is recorded: its rate token stays spent, its concurrency slot is freed. */
  commit(lease: string): void {
    this.sql.exec("DELETE FROM leases WHERE id = ?", lease);
  }

  /** An unused reservation is given back, rate token and all. */
  release(lease: string): void {
    const rows = [...this.sql.exec("SELECT kind, rate FROM leases WHERE id = ?", lease)];
    if (!rows.length) return;
    this.sql.exec("DELETE FROM leases WHERE id = ?", lease);
    const { kind, rate } = rows[0] as { kind: string; rate: number };
    if (rate) this.giveBack(kind);
  }

  private tokens(kind: string, now: number): number {
    const k = KINDS[kind];
    const r = [...this.sql.exec("SELECT tokens, updated FROM buckets WHERE kind = ?", kind)][0] as { tokens: number; updated: number } | undefined;
    if (!r) return k.capacity!;
    return Math.min(k.capacity!, r.tokens + (now - r.updated) / k.perMs!);
  }

  private giveBack(kind: string): void {
    const now = Date.now();
    const k = KINDS[kind];
    this.sql.exec("INSERT OR REPLACE INTO buckets (kind, tokens, updated) VALUES (?, ?, ?)", kind, Math.min(k.capacity!, this.tokens(kind, now) + 1), now);
  }

  /** Expired leases are released (§2.1: a lease expires in 30 s). */
  private expire(now: number): void {
    for (const l of [...this.sql.exec("SELECT id FROM leases WHERE expires <= ? LIMIT 100", now)]) this.release((l as { id: string }).id);
  }

  private async arm(): Promise<void> {
    const r = [...this.sql.exec("SELECT min(expires) AS e FROM leases")][0] as { e: number | null };
    if (r.e !== null) await this.armAt(r.e);
  }

  async alarm(): Promise<void> {
    this.expire(Date.now());
    await this.arm();
    // erasure work, ≤ 50 items a wake (amendment 1 r6 §4.3)
    const hasRid = [...this.sql.exec("SELECT v FROM meta WHERE k = 'rid'")].length > 0;
    if (hasRid) {
      const next = await this.map.step();
      if (next !== null) await this.armAt(next);
    }
  }

  /**
   * The signing key `kid` from the platform's JWKS (§3.2): cached for an hour;
   * an unknown kid allows one refetch per minute, through trustedFetch.  It
   * answers a result, not an exception, since errors cross the RPC boundary
   * without their type.
   */
  async jwk(policy: Policy, kid: string, env: EnvName): Promise<{ jwk: Jwk | null } | { status: number; code: string }> {
    try {
      return { jwk: await this.jwkOrThrow(policy, kid, env) };
    } catch (e) {
      if (e instanceof LtiError) return { status: e.status, code: e.code };
      return { status: 502, code: "jwks_failed" };
    }
  }

  private async jwkOrThrow(policy: Policy, kid: string, env: EnvName): Promise<Jwk | null> {
    const now = Date.now();
    const cached = [...this.sql.exec("SELECT uri, keys, fetched FROM jwks WHERE one = 1")][0] as { uri: string; keys: string; fetched: number } | undefined;
    const usable = cached && cached.uri === policy.jwks_uri && now - cached.fetched < JWKS_TTL_MS;
    if (usable) {
      const k = (JSON.parse(cached.keys) as Jwk[]).find((x) => x.kid === kid);
      if (k) return k;
    }
    const lease = this.reserve("jwks");
    if (!lease) {
      if (usable) return null;
      throw new LtiError(503, "jwks_rate");
    }
    try {
      const r = await trustedFetch(env, categoryHosts(policy, "jwks_uri"), policy.jwks_uri, {}, { maxBytes: 64 * 1024, timeoutMs: 5000 });
      if (r.status !== 200) throw new LtiError(502, "jwks_status");
      let body: { keys?: Jwk[] };
      try {
        body = JSON.parse(r.body);
      } catch {
        throw new LtiError(502, "jwks_shape");
      }
      if (!body || !Array.isArray(body.keys) || body.keys.length > 20) throw new LtiError(502, "jwks_shape");
      const keys = body.keys.filter((k) => k && typeof k === "object" && k.kty === "RSA" && typeof k.kid === "string");
      this.sql.exec("INSERT OR REPLACE INTO jwks (one, uri, keys, fetched) VALUES (1, ?, ?, ?)", policy.jwks_uri, JSON.stringify(keys), now);
      return keys.find((x) => x.kid === kid) ?? null;
    } finally {
      this.commit(lease);
    }
  }
}
