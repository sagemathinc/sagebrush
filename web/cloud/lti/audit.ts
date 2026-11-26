// The audit log (plan-lti-r5 §11.4): who, what, when.  Never student work,
// never names.  Written before the action it records, so nothing audited is
// ever done unaudited; at the cap, the action is refused (§15.1).

import type { D1 } from "./db.ts";
import { byteLength, LtiError } from "./util.ts";

export interface AuditEntry { action: string; actor_ref?: string | null; owner_ref?: string | null; rid?: string | null; detail?: Record<string, unknown> }

export async function audit(db: D1, e: AuditEntry): Promise<number> {
  const detail = JSON.stringify(e.detail ?? {});
  const actor = e.actor_ref ?? null, owner = e.owner_ref ?? null, rid = e.rid ?? null;
  if (byteLength(detail) > 768 || (actor !== null && byteLength(actor) > 64) || (owner !== null && byteLength(owner) > 64)) throw new LtiError(413, "too_large");
  const size = 8 + 8 + e.action.length + (actor === null ? 0 : byteLength(actor)) + (owner === null ? 0 : byteLength(owner)) + (rid === null ? 0 : rid.length) + byteLength(detail) + 16;
  try {
    const r = await db.prepare("INSERT INTO audit (at, action, actor_ref, owner_ref, rid, detail, size) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING rowid AS id").bind(Date.now(), e.action, actor, owner, rid, detail, size).first<{ id: number }>();
    return r!.id;
  } catch (err) {
    if (String((err as Error)?.message ?? err).includes("quota")) throw new LtiError(503, "audit_full");
    throw new LtiError(503, "audit_unavailable");
  }
}

/**
 * Remove an audit row written for an action that was then refused (quota, a
 * collision, a stale revision): a refusal leaves nothing behind, so refused
 * requests can't fill the bounded log (LIMIT-PR8-2).  The row is still
 * written first (§11.4); a crash between the two leaves an entry for an
 * action that didn't happen, never an action without its entry.
 */
export async function unaudit(db: D1, id: number): Promise<void> {
  await db.prepare("DELETE FROM audit WHERE rowid = ?").bind(id).run();
}
