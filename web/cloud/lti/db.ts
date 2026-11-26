// D1 access for LtiRegistry (plan-lti-r5 §15.1).  Every capped table's
// admission is a trigger (migrations/0001_registry.sql); this file computes the
// encoded sizes those triggers check and keeps the statements in one place.

import type { Policy, Preset } from "./policy.ts";
import { byteLength, LtiError } from "./util.ts";

export interface D1Result<T = unknown> { results: T[]; meta: { changes: number; rows_read?: number; rows_written?: number } }
export interface D1Prepared { bind(...v: unknown[]): D1Prepared; first<T = Record<string, unknown>>(): Promise<T | null>; all<T = Record<string, unknown>>(): Promise<D1Result<T>>; run(): Promise<D1Result> }
export interface D1 { prepare(sql: string): D1Prepared; batch(stmts: D1Prepared[]): Promise<D1Result[]> }

export type OwnerKind = "license" | "organization";
export interface Bootstrap { hosts: string[]; expected_issuer?: string }

export interface Registration {
  rid: string;
  owner_ref: string;
  owner_kind: OwnerKind;
  state: "bootstrapping" | "pending" | "approved" | "revoked";
  iss: string | null;
  client_id: string | null;
  preset: Preset | null;
  bootstrap: Bootstrap;
  policy: Policy | null;
  policy_version: number;
  policy_digest: string | null;
  staff_digest: string | null;
  approved_digest: string | null;
  created: number;
}

/** Each registration's own quota rows (§15.1), inserted in the same batch as the registration. */
export const PER_REG_QUOTA: [string, number, number][] = [["deployments", 50, 50 * 512], ["placements", 10_000, 10_000 * 1024]];

/** The encoded size, as the table's CHECK computes it. */
export function regSize(r: { owner_ref: string; iss: string | null; client_id: string | null; bootstrap: string; policy: string | null }): number {
  return 32 + byteLength(r.owner_ref) + 16 + 16 + (r.iss === null ? 0 : byteLength(r.iss)) + (r.client_id === null ? 0 : byteLength(r.client_id)) + 16 + byteLength(r.bootstrap) + (r.policy === null ? 0 : byteLength(r.policy)) + 8 + 3 * 64 + 8;
}
export const codeSize = (owner_ref: string, bootstrap: string): number => 64 + byteLength(owner_ref) + 16 + 16 + byteLength(bootstrap) + 8 + 8 + 32;
export const deploymentSize = (d: string): number => 32 + byteLength(d) + 8;

/** The Worker-side encoded-byte checks, before any transaction (§15.1). */
export function checkRegBytes(r: { owner_ref: string; iss: string | null; client_id: string | null; bootstrap: string; policy: string | null }): void {
  if (byteLength(r.owner_ref) > 64 || (r.iss !== null && byteLength(r.iss) > 255) || (r.client_id !== null && byteLength(r.client_id) > 255) || byteLength(r.bootstrap) > 512 || (r.policy !== null && byteLength(r.policy) > 2560) || regSize(r) > 4096)
    throw new LtiError(413, "too_large");
}

function row(r: Record<string, unknown>): Registration {
  return {
    rid: r.rid as string,
    owner_ref: r.owner_ref as string,
    owner_kind: r.owner_kind as OwnerKind,
    state: r.state as Registration["state"],
    iss: r.iss as string | null,
    client_id: r.client_id as string | null,
    preset: r.preset as Preset | null,
    bootstrap: JSON.parse(r.bootstrap as string),
    policy: r.policy === null ? null : JSON.parse(r.policy as string),
    policy_version: r.policy_version as number,
    policy_digest: r.policy_digest as string | null,
    staff_digest: r.staff_digest as string | null,
    approved_digest: r.approved_digest as string | null,
    created: r.created as number,
  };
}

export async function getRegistration(db: D1, rid: string): Promise<Registration | null> {
  const r = await db.prepare("SELECT * FROM registrations WHERE rid = ?").bind(rid).first();
  return r ? row(r) : null;
}

/** §3.1: by (iss, client_id); with no client_id, iss must have exactly one approved registration. */
export async function findForLogin(db: D1, iss: string, clientId: string | null): Promise<Registration | null> {
  if (clientId !== null) {
    const r = await db.prepare("SELECT * FROM registrations WHERE iss = ? AND client_id = ? AND state = 'approved'").bind(iss, clientId).first();
    return r ? row(r) : null;
  }
  const rs = await db.prepare("SELECT * FROM registrations WHERE iss = ? AND state = 'approved' LIMIT 2").bind(iss).all();
  return rs.results.length === 1 ? row(rs.results[0] as Record<string, unknown>) : null;
}

export async function listForOwner(db: D1, owner: string): Promise<Registration[]> {
  const rs = await db.prepare("SELECT * FROM registrations WHERE owner_ref = ? ORDER BY created LIMIT 100").bind(owner).all();
  return rs.results.map((r) => row(r as Record<string, unknown>));
}

export async function hasDeployment(db: D1, rid: string, d: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM deployments WHERE rid = ? AND deployment_id = ?").bind(rid, d).first()) !== null;
}

/** Statements inserting a registration with its per-registration quota rows (one batch, so they commit together). */
export function insertRegistrationStmts(db: D1, r: Omit<Registration, "bootstrap" | "policy"> & { bootstrap: string; policy: string | null }): D1Prepared[] {
  checkRegBytes(r);
  const size = regSize(r);
  return [
    ...PER_REG_QUOTA.map(([kind, c, b]) => db.prepare("INSERT INTO quota (scope, kind, cap_count, cap_bytes) VALUES (?, ?, ?, ?)").bind(r.rid, kind, c, b)),
    db
      .prepare("INSERT INTO registrations (rid, owner_ref, owner_kind, state, iss, client_id, preset, bootstrap, policy, policy_version, policy_digest, staff_digest, approved_digest, created, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(r.rid, r.owner_ref, r.owner_kind, r.state, r.iss, r.client_id, r.preset, r.bootstrap, r.policy, r.policy_version, r.policy_digest, r.staff_digest, r.approved_digest, r.created, size),
  ];
}

/** True iff a D1 error is a trigger's quota refusal. */
export function isQuota(e: unknown): boolean {
  return String((e as Error)?.message ?? e).includes("quota");
}

/**
 * A D1 refusal proven to have committed nothing (CORR-LTIDL-2): the whole message is SQLite's own
 * constraint form, either one of this schema's RAISE(ABORT, 'quota' | 'owner_immutable') triggers or a
 * UNIQUE / PRIMARY KEY violation, and every one of those aborts its statement and its batch.
 */
export class DbRefusal extends LtiError {}
const TRIGGER_ABORT = /^D1_ERROR: (quota|owner_immutable): SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?$/;
const UNIQUE_ABORT = /^D1_ERROR: UNIQUE constraint failed: [a-z_]+\.[a-z_]+(?:, [a-z_]+\.[a-z_]+)*: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_(?:UNIQUE|PRIMARYKEY)\))?$/;
/** The confirmed refusal a D1 error message proves, if it is exactly one of SQLite's abort forms; otherwise null. */
export function confirmedRefusal(message: string): "quota" | "owner_immutable" | "exists" | null {
  const t = TRIGGER_ABORT.exec(message);
  if (t) return t[1] as "quota" | "owner_immutable";
  return UNIQUE_ABORT.test(message) ? "exists" : null;
}

/**
 * Run, mapping a quota refusal to 429 and a uniqueness clash to 409.  Only an exact SQLite abort form is
 * a DbRefusal (nothing committed); a message that merely mentions one of those words keeps its old HTTP
 * mapping but stays an unknown outcome.
 */
export async function guarded<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    const sure = confirmedRefusal(message);
    if (sure) throw new DbRefusal(sure === "quota" ? 429 : 409, sure);
    if (isQuota(e)) throw new LtiError(429, "quota");
    if (message.includes("UNIQUE")) throw new LtiError(409, "exists");
    if (message.includes("owner_immutable")) throw new LtiError(409, "owner_immutable");
    throw e;
  }
}

/** Split a migration into statements, keeping each trigger's BEGIN … END; whole. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inTrigger = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace(/--.*$/, "").trimEnd();
    if (!line.trim()) continue;
    cur.push(line);
    if (/^\s*CREATE\s+TRIGGER/i.test(line)) inTrigger = true;
    if (inTrigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line)) {
      out.push(cur.join("\n").replace(/;\s*$/, ""));
      cur = [];
      inTrigger = false;
    }
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

/** A placement's latest AGS grant (r5 §5.1). */
export interface Placement { placement: string; rid: string; deployment: string; course: string; resource_link: string; aid: string | null; ags_scope: string[] | null; lineitems: string | null; lineitem: string | null; updated?: number }

export const placementSize = (deployment: string, resourceLink: string, scope: string | null, lineitems: string | null, lineitem: string | null): number =>
  32 + 32 + byteLength(deployment) + 32 + byteLength(resourceLink) + 32 + (scope === null ? 0 : byteLength(scope)) + (lineitems === null ? 0 : byteLength(lineitems)) + (lineitem === null ? 0 : byteLength(lineitem)) + 8 + 8;

/** Record a launch's grant on its placement: a newer launch replaces it (§5.1).  Admission by trigger (§15.1). */
export async function upsertPlacement(db: D1, p: Omit<Placement, "ags_scope"> & { ags_scope: string[] | null }): Promise<void> {
  const scope = p.ags_scope === null ? null : JSON.stringify(p.ags_scope);
  const size = placementSize(p.deployment, p.resource_link, scope, p.lineitems, p.lineitem);
  if (size > 1024) throw new LtiError(413, "placement_too_large");
  await guarded(() =>
    db.prepare("INSERT INTO placements (placement, rid, deployment, course, resource_link, aid, ags_scope, lineitems, lineitem, updated, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (placement) DO UPDATE SET aid = excluded.aid, ags_scope = excluded.ags_scope, lineitems = excluded.lineitems, lineitem = excluded.lineitem, updated = excluded.updated, size = excluded.size")
      .bind(p.placement, p.rid, p.deployment, p.course, p.resource_link, p.aid, scope, p.lineitems, p.lineitem, Date.now(), size).run(),
  );
}

export async function getPlacement(db: D1, placement: string): Promise<Placement | null> {
  const r = await db.prepare("SELECT placement, rid, deployment, course, resource_link, aid, ags_scope, lineitems, lineitem, updated FROM placements WHERE placement = ?").bind(placement).first<Record<string, unknown>>();
  if (!r) return null;
  return { ...(r as unknown as Placement), ags_scope: r.ags_scope === null ? null : JSON.parse(r.ags_scope as string) };
}
