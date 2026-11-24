// The daily quota reconciliation (plan-lti-r5 §15.1): recount each scope and
// repair a counter that differs, with an alert.  Since triggers make every
// change atomic, a difference means corruption, not drift.  Bounded reads:
// the registry's tables are small at their caps (≤ 100 registrations, ≤ 20
// codes, ≤ 50 deployments each), so a full recount reads a few thousand rows.
// (The audit log's paged recount, with retention deleting under the cursor, is
// a stage-C follow-up; its counter is trigger-maintained meanwhile.)
//
// Each repair is ONE statement, whose recount is a subquery of the same
// UPDATE (CORR-LTIMAP-5): the count and the write see one snapshot, so a
// concurrent insert or delete either precedes both or follows both, and a
// correct counter is never overwritten with a stale total.  RETURNING names
// only the rows that changed.

import type { D1 } from "./db.ts";

/** codes are charged 16,384 B fixed + 1,536 B a row (charge errata), the same as the quota trigger. */
const CODES = "(SELECT count(*) FROM codes)";

export async function reconcileRegistry(db: D1): Promise<string[]> {
  const fixed: string[] = [];
  const fix = async (scope: string, kind: string, n: string, bytes: string, ...bind: unknown[]) => {
    const r = await db
      .prepare(`UPDATE quota SET count = ${n}, bytes = ${bytes} WHERE scope = ? AND kind = ? AND (count IS NOT ${n} OR bytes IS NOT ${bytes}) RETURNING count, bytes`)
      .bind(...bind, ...bind, scope, kind, ...bind, ...bind)
      .all<{ count: number; bytes: number }>();
    for (const x of r.results) fixed.push(`${scope}/${kind}: -> ${x.count}/${x.bytes}`);
  };
  await fix("env", "codes", CODES, `16384 + 1536 * ${CODES}`);
  await fix("env", "registrations", "(SELECT count(*) FROM registrations)", "(SELECT coalesce(sum(size), 0) FROM registrations)");
  await fix("env", "pending", "(SELECT count(*) FROM registrations WHERE state IN ('bootstrapping', 'pending'))", "bytes");
  const rids = await db.prepare("SELECT rid FROM registrations LIMIT 100").all<{ rid: string }>();
  for (const { rid } of rids.results) {
    await fix(rid, "deployments", "(SELECT count(*) FROM deployments WHERE rid = ?)", "(SELECT coalesce(sum(size), 0) FROM deployments WHERE rid = ?)", rid);
  }
  return fixed;
}
