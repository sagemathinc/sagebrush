// Assignment and Grade Services, the registration side (plan-lti-r5 §5.2,
// §15.2; amendment 1 r6 for the per-deployment token binding): access tokens
// cached per (env, rid, deployment, token_aud, exact scope set) with single
// flight, and the AGS queue's charged set, fenced by incarnation.

import { fullScopes } from "./claims.ts";
import { signRs256, type Jwk } from "./jwt.ts";
import { categoryHosts, trustedFetch, type EnvName, type Policy } from "./policy.ts";
import { LtiError, randomHex } from "./util.ts";

export const TOKEN_ENTRIES = 200;
export const CHARGE_CAP = 100_000;
export const AGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (k TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS charged (qid TEXT PRIMARY KEY, inc INTEGER NOT NULL, course TEXT NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS charged_course ON charged (course);
`;

export interface AgsEnv { ENV?: string; TOOL_KEY?: string }
type R<T> = { ok: true; value: T } | { ok: false; code: string };

export class AgsReg {
  private inflight = new Map<string, Promise<R<string>>>();
  /**
   * `reserve`/`commit`: the per-registration `ags` rate and concurrency lease; `unit`: one outbound fetch's
   * day and Fleet units (LIMIT-PR9-1), taken before EVERY fetch, retries included, failing closed.
   */
  constructor(private sql: SqlStorage, private env: AgsEnv, private reserve: (k: string) => string | null, private commit: (l: string) => void, private unit: () => Promise<boolean>) {
    sql.exec(AGS_SCHEMA);
  }

  /**
   * An access token for one deployment and an exact scope set (§5.2, amendment 1): cached until 60 s
   * before it expires; concurrent requests for one key share one acquisition.  `stale` names a token a
   * 401 just refused: it is dropped if it is still the cached one, and a fresh one is acquired.
   */
  async token(p: { policy: Policy; clientId: string; deployment: string; scopes: string[]; stale?: string }, held = false): Promise<R<string>> {
    const aud = p.policy.token_aud ?? p.policy.token_endpoint;
    const scopes = [...new Set(p.scopes)].sort();
    const key = JSON.stringify([this.env.ENV ?? "", p.deployment, aud, scopes]);
    if (p.stale) this.sql.exec("DELETE FROM tokens WHERE k = ? AND token = ?", key, p.stale);
    const now = Date.now();
    const c = [...this.sql.exec("SELECT token, expires FROM tokens WHERE k = ?", key)][0] as { token: string; expires: number } | undefined;
    if (c && c.expires - 60_000 > now) return { ok: true, value: c.token };
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const job = this.acquire(p.policy, p.clientId, p.deployment, scopes, aud, key, held).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  private async acquire(policy: Policy, clientId: string, deployment: string, scopes: string[], aud: string, key: string, held: boolean): Promise<R<string>> {
    if (!this.env.TOOL_KEY) return { ok: false, code: "not_configured" };
    // (inside call(), the operation's own reservation covers its token: §5.2 "under the same reservations")
    const lease = held ? null : this.reserve("ags");
    if (!held && !lease) return { ok: false, code: "rate" };
    try {
      const now = Math.floor(Date.now() / 1000);
      const assertion = await signRs256({
        iss: clientId, sub: clientId, aud, iat: now, exp: now + 300, jti: randomHex(16),
        ...(policy.token_deployment_claim === "assertion" ? { "https://purl.imsglobal.org/spec/lti/claim/deployment_id": deployment } : {}),
      }, JSON.parse(this.env.TOOL_KEY) as Jwk & { kid: string });
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
        scope: fullScopes(scopes).join(" "),
      }).toString();
      if (!(await this.unit())) return { ok: false, code: "rate" };
      const r = await trustedFetch((this.env.ENV ?? "prod") as EnvName, categoryHosts(policy, "token_endpoint"), policy.token_endpoint, { method: "POST", body, contentType: "application/x-www-form-urlencoded" }, { maxBytes: 16 * 1024, timeoutMs: 5000, maxRedirects: 0 });
      if (r.status !== 200) return { ok: false, code: `token_status_${r.status}` };
      const j = JSON.parse(r.body) as { access_token?: unknown; expires_in?: unknown };
      if (typeof j.access_token !== "string" || j.access_token.length > 4096) return { ok: false, code: "token_shape" };
      const ttl = typeof j.expires_in === "number" && j.expires_in > 0 ? Math.min(j.expires_in, 86_400) : 3600;
      // (bounded: at most 200 entries, the oldest expiry dropped first)
      const n = (this.sql.exec("SELECT count(*) AS n FROM tokens").one() as { n: number }).n;
      if (n >= TOKEN_ENTRIES) this.sql.exec("DELETE FROM tokens WHERE k IN (SELECT k FROM tokens ORDER BY expires LIMIT ?)", n - TOKEN_ENTRIES + 1);
      this.sql.exec("INSERT OR REPLACE INTO tokens (k, token, expires) VALUES (?, ?, ?)", key, j.access_token, Date.now() + ttl * 1000);
      return { ok: true, value: j.access_token };
    } catch (e) {
      return { ok: false, code: e instanceof LtiError ? e.code : "token_failed" };
    } finally {
      if (lease) this.commit(lease);
    }
  }

  /**
   * One AGS operation (§5.2): under one `ags` reservation, with a token for exactly this deployment and
   * these scopes, each of which the placement's latest launch granted.  A 401 drops the token it used,
   * refreshes once and retries once; the status of the last try is returned for the caller to judge
   * (a second 401 or any 403 means the grant is missing).
   */
  async call(p: { policy: Policy; clientId: string; deployment: string; scopes: string[]; grant: string[]; method: "GET" | "POST"; url: string; body?: string; contentType?: string; accept: string; maxBytes: number }): Promise<R<{ status: number; body: string; link: string | null }>> {
    if (!p.scopes.length || !p.scopes.every((s) => p.grant.includes(s))) return { ok: false, code: "scope_not_granted" };
    const lease = this.reserve("ags");
    if (!lease) return { ok: false, code: "rate" };
    try {
      let stale: string | undefined;
      for (let attempt = 0; ; attempt++) {
        const t = await this.token({ policy: p.policy, clientId: p.clientId, deployment: p.deployment, scopes: p.scopes, stale }, true);
        if (!t.ok) return t;
        if (!(await this.unit())) return { ok: false, code: "rate" };
        const r = await trustedFetch((this.env.ENV ?? "prod") as EnvName, categoryHosts(p.policy, "service"), p.url, { method: p.method, body: p.body, contentType: p.contentType, accept: p.accept, bearer: t.value }, { maxBytes: p.maxBytes, timeoutMs: 10_000, maxRedirects: p.method === "POST" ? 0 : 2 });
        if (r.status === 401 && attempt === 0) {
          stale = t.value;
          continue;
        }
        return { ok: true, value: { status: r.status, body: r.body, link: r.headers.get("link") } };
      }
    } catch (e) {
      return { ok: false, code: e instanceof LtiError ? e.code : "fetch_failed" };
    } finally {
      this.commit(lease);
    }
  }

  /** §15.2: charge one queued key at its incarnation — insert, retry, transfer (higher inc) or stale. */
  charge(qid: string, inc: number, course: string): "ok" | "full" | "stale" {
    const r = [...this.sql.exec("SELECT inc FROM charged WHERE qid = ?", qid)][0] as { inc: number } | undefined;
    const now = Date.now();
    if (!r) {
      const n = (this.sql.exec("SELECT count(*) AS n FROM charged").one() as { n: number }).n;
      if (n >= CHARGE_CAP) return "full";
      this.sql.exec("INSERT INTO charged (qid, inc, course, updated) VALUES (?, ?, ?, ?)", qid, inc, course, now);
      return "ok";
    }
    if (r.inc === inc) return "ok";
    if (r.inc < inc) {
      this.sql.exec("UPDATE charged SET inc = ?, updated = ? WHERE qid = ?", inc, now, qid);
      return "ok";
    }
    return "stale";
  }

  /** §15.2: release deletes only an entry at this incarnation or older; idempotent. */
  release(qid: string, inc: number): "done" {
    this.sql.exec("DELETE FROM charged WHERE qid = ? AND inc <= ?", qid, inc);
    return "done";
  }

  /** (tests) */
  chargedCount(): number {
    return (this.sql.exec("SELECT count(*) AS n FROM charged").one() as { n: number }).n;
  }
}
