// `Fleet`: one Durable Object per environment (plan-lti-r5 §2.1, §15.4): the
// global ceiling on outbound fetches, ≤ 500 a second.  Each outbound call takes
// a Fleet reservation after its `Reg` one.  Its bucket is in SQLite, so the
// ceiling survives eviction.

import { DurableObject } from "cloudflare:workers";

export const FLEET_OUTBOUND_PER_S = 500;

export class LtiFleet extends DurableObject {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS buckets (kind TEXT PRIMARY KEY, tokens REAL NOT NULL, updated INTEGER NOT NULL)");
  }

  /** Tests only: set the bucket's tokens (0 exhausts it until it refills). */
  testTokens(tokens: number): boolean {
    if ((globalThis as { __SAGEBRUSH_LTI_TEST__?: boolean }).__SAGEBRUSH_LTI_TEST__ !== true) return false;
    // (an exhausted bucket is dated an hour ahead, so it can't refill during the test)
    this.sql.exec("INSERT OR REPLACE INTO buckets (kind, tokens, updated) VALUES ('outbound', ?, ?)", tokens, tokens < 1 ? Date.now() + 3600_000 : Date.now());
    return true;
  }

  /** One outbound fetch, or refused. */
  reserve(): boolean {
    const now = Date.now();
    const r = [...this.sql.exec("SELECT tokens, updated FROM buckets WHERE kind = 'outbound'")][0] as { tokens: number; updated: number } | undefined;
    const tokens = r ? Math.min(FLEET_OUTBOUND_PER_S, r.tokens + ((now - r.updated) * FLEET_OUTBOUND_PER_S) / 1000) : FLEET_OUTBOUND_PER_S;
    if (tokens < 1) return false;
    this.sql.exec("INSERT OR REPLACE INTO buckets (kind, tokens, updated) VALUES ('outbound', ?, ?)", tokens - 1, now);
    return true;
  }
}
