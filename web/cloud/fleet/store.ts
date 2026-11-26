// The fleet Worker's D1 store (FLEET_DB): the atomic contracts the core's pure handlers state, met by single D1
// statements or single D1 batches (fleet Worker design r1.6 §2). D1 runs a batch as one transaction and serializes write
// batches, so every condition of a decision is evaluated by SQL inside its batch, never from values read before it.
// (no import of the fleet core here: the Worker reaches it only through its installer, in server.ts)

/** The first-lease gate's margin: the core's LEASE_GATE_MARGIN_MS, which test-fleet.mjs checks this equals. */
export const GATE_MARGIN_MS = 300_000;

export interface D1Result<T> { results: T[]; meta?: { changes?: number } }
export interface D1Stmt {
  bind(...v: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
}
export interface D1 { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<D1Result<unknown>[]> }

export const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/** The closed set of decisions the batch may store (§2.4). */
export const DECISIONS = Object.freeze(["ok", "unknown_host", "host_revoked", "agent_revoked", "not_granted", "stale_generation"]);
const ID = /^[a-z2-7]{25}[aeimquy4]$/;

/**
 * The first-lease gate, ONE fragment for both of its uses (the lease decision and a transfer's apply, §2.3, §2.5): TRUE
 * or FALSE, never NULL, over the pending row `p`, with the decision's time bound at ?8. Open when the old host's
 * verified ack for this move is recorded, when the old host never held a lease, or strictly after its last expiry plus
 * the margin. Every term is EXISTS / NOT EXISTS or COALESCE: a NULL anywhere keeps it closed.
 */
export const GATE_OPEN_SQL =
  `(COALESCE(p.acked, 0) = 1` +
  ` OR NOT EXISTS (SELECT 1 FROM lease_clock c WHERE c.agent = p.agent AND c.host = p.from_host)` +
  ` OR EXISTS (SELECT 1 FROM lease_clock c WHERE c.agent = p.agent AND c.host = p.from_host AND ?8 > c.expires_at + ${GATE_MARGIN_MS}))`;

// ---- leases.issue: the five statements of one batch (§2), each with its own bindings
//   (reserve binds ?4 = now; the others:) ?1 host  ?2 nonce  ?3 lease_id  ?4 fleet  ?5 agent  ?6 host_key  ?7 gen  ?8 now  ?9 ttl_ms  ?10 request
export const ISSUE_SQL = Object.freeze({
  reserve: "INSERT OR IGNORE INTO lease_nonces (host, nonce, lease_id, decided, created_ms) VALUES (?1, ?2, ?3, NULL, ?4)",
  decide:
    "UPDATE lease_nonces SET decided = CASE" +
    " WHEN NOT EXISTS (SELECT 1 FROM fleet_hosts WHERE host = ?1 AND fleet = ?4) THEN 'unknown_host'" +
    " WHEN EXISTS (SELECT 1 FROM fleet_hosts WHERE host = ?1 AND revoked = 1) THEN 'host_revoked'" +
    " WHEN NOT EXISTS (SELECT 1 FROM fleet_hosts WHERE host = ?1 AND fingerprint = ?6) THEN 'not_granted'" +
    // (no agent row: refused BEFORE any agent-field condition, so a missing row can never fall through, §2 H1)
    " WHEN NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent = ?5) THEN 'not_granted'" +
    " WHEN NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent = ?5 AND fleet = ?4) THEN 'not_granted'" +
    " WHEN EXISTS (SELECT 1 FROM fleet_agents WHERE agent = ?5 AND revoked = 1) THEN 'agent_revoked'" +
    " WHEN NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent = ?5 AND host = ?1) THEN 'not_granted'" +
    " WHEN NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent = ?5 AND entry_gen = ?7) THEN 'stale_generation'" +
    ` WHEN EXISTS (SELECT 1 FROM lease_pending p WHERE p.agent = ?5 AND p.to_host = ?1 AND NOT ${GATE_OPEN_SQL}) THEN 'not_granted'` +
    " ELSE 'ok' END" +
    " WHERE host = ?1 AND nonce = ?2 AND lease_id = ?3 AND decided IS NULL",
  clock:
    "INSERT INTO lease_clock (agent, host, expires_at, lease_id, gen, request)" +
    " SELECT ?5, ?1, ?8 + ?9, ?3, ?7, ?10 WHERE EXISTS (SELECT 1 FROM lease_nonces WHERE host = ?1 AND nonce = ?2 AND lease_id = ?3 AND decided = 'ok')" +
    " ON CONFLICT (agent, host) DO UPDATE SET expires_at = MAX(expires_at, excluded.expires_at), lease_id = excluded.lease_id," +
    " gen = excluded.gen, request = excluded.request",
  settle:
    "DELETE FROM lease_pending WHERE agent = ?5 AND to_host = ?1" +
    " AND EXISTS (SELECT 1 FROM lease_nonces WHERE host = ?1 AND nonce = ?2 AND lease_id = ?3 AND decided = 'ok')",
  read: "SELECT lease_id, decided FROM lease_nonces WHERE host = ?1 AND nonce = ?2",
});

export interface IssueDecision { fleet: string; agent: string; host: string; host_key: string; gen: number; nonce: string; request: string; lease_id: string; ttl_ms: number; now: number }

/** The store's half of leases.issue (lease-service.mjs's contract): one batch, then step 5's strict reading. */
export async function issueLease(db: D1, d: IssueDecision): Promise<{ ok: true } | { refused: string }> {
  // (the safe-integer bound, before the batch and without a rounded sum: the CHECK on expires_at is the second guard)
  if (!Number.isSafeInteger(d.now) || !Number.isSafeInteger(d.ttl_ms) || d.now < 0 || d.ttl_ms <= 0 || d.ttl_ms > MAX_SAFE - d.now) throw new Error("the lease's expiry is out of range");
  const S = ISSUE_SQL;
  const res = await db.batch([
    db.prepare(S.reserve).bind(d.host, d.nonce, d.lease_id, d.now),
    db.prepare(S.decide).bind(d.host, d.nonce, d.lease_id, d.fleet, d.agent, d.host_key, d.gen, d.now),
    db.prepare(S.clock).bind(d.host, d.nonce, d.lease_id, null, d.agent, null, d.gen, d.now, d.ttl_ms, d.request),
    db.prepare(S.settle).bind(d.host, d.nonce, d.lease_id, null, d.agent),
    db.prepare(S.read).bind(d.host, d.nonce),
  ]);
  return readDecision(res[4]?.results, d.lease_id);
}

/**
 * Step 5's reading (§2.4, SEC H4): exactly one row, its stored decision a non-NULL member of the closed set, its
 * lease_id well formed; then another lease_id is the ordinary replay, and ours is its decision. Anything else throws,
 * which the handler answers 503 with nothing signed.
 */
export function readDecision(rows: unknown, leaseId: string): { ok: true } | { refused: string } {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("the lease decision: not exactly one row");
  const r = rows[0] as { lease_id?: unknown; decided?: unknown };
  if (typeof r.lease_id !== "string" || !ID.test(r.lease_id)) throw new Error("the lease decision: a malformed lease_id");
  if (typeof r.decided !== "string" || !DECISIONS.includes(r.decided)) throw new Error("the lease decision: no closed decision");
  if (r.lease_id !== leaseId) return { refused: "replay" };
  return r.decided === "ok" ? { ok: true } : { refused: r.decided };
}

/** bucket(key, limit, window_ms): at most `limit` trues for `key` in ANY window of `window_ms`, across instances. */
export async function bucket(db: D1, key: string, limit: number, windowMs: number, now: number, id: string): Promise<boolean> {
  const res = await db.batch([
    db.prepare("DELETE FROM fleet_bucket_hits WHERE key = ?1 AND t <= ?2 - ?3").bind(key, now, windowMs),
    db.prepare("INSERT INTO fleet_bucket_hits (key, t, id) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM fleet_bucket_hits WHERE key = ?1 AND t > ?2 - ?4) < ?5")
      .bind(key, now, id, windowMs, limit),
  ]);
  return (res[1]?.meta?.changes ?? 0) === 1;
}

/** The host's CURRENT pairing, or null. */
export async function hostRow(db: D1, host: string): Promise<{ fleet: string; sign_key: string; fingerprint: string; revoked: number } | null> {
  return db.prepare("SELECT fleet, sign_key, fingerprint, revoked FROM fleet_hosts WHERE host = ?1").bind(host).first();
}

/** A fleet's chain entries, in order (the core replays them). */
export async function chainEntries(db: D1, fleet: string): Promise<string[]> {
  const r = await db.prepare("SELECT bytes FROM fleet_chain_entries WHERE fleet = ?1 ORDER BY seq").bind(fleet).all<{ bytes: string }>();
  return r.results.map((x) => x.bytes);
}
