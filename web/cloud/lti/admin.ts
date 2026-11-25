// The admin calls from cocalc.ai (plan-lti-r5 §17.1).  cocalc.ai authorizes
// the human for the owner; the tool authenticates cocalc.ai (HMAC with
// LTI_KEY over method, path, timestamp and body, ≤ 5 min old, a request id
// kept a day) and enforces owner consistency itself, so a signed request alone
// can't move anything between owners.

import { audit } from "./audit.ts";
import { contentRead, gateOf, type ContentEnv } from "./content.ts";
import type { Stmt, WriteResult } from "./gate.ts";
import { getRegistration, guarded, insertRegistrationStmts, codeSize, deploymentSize, listForOwner, regSize, type Bootstrap, type D1, type OwnerKind } from "./db.ts";
import { envName, type Env } from "./env.ts";
import { checkedUrl, matchesPreset, policyDigest, presetHosts, PRESETS, validatePolicy, type Preset } from "./policy.ts";
import { byteLength, derivedKey, fail, hmacHex, json, LtiError, randomHex, readBounded, same, sha256Hex, testGate } from "./util.ts";

export const ADMIN_BODY = 8192;
export const SKEW_MS = 5 * 60_000;
export const CODE_MS = 24 * 3600_000;
const DAY = 24 * 3600_000;

type AdminEnv = Env & Required<Pick<Env, "LTI_ORIGIN" | "LTI_DB" | "LTI_AUDIT" | "LTI_KEY" | "LTI_REG">>;

const isRef = (v: unknown, max = 64): v is string => typeof v === "string" && v.length >= 1 && v.length <= max && /^[A-Za-z0-9_.:-]+$/.test(v);
const isOwnerKind = (v: unknown): v is OwnerKind => v === "license" || v === "organization";
const isHex = (v: unknown, n: number): v is string => typeof v === "string" && v.length === n && /^[0-9a-f]+$/.test(v);

/** Authenticate a cocalc.ai admin call; answers its JSON body.  Replays are refused by request_id. */
async function authenticated(req: Request, env: AdminEnv): Promise<Record<string, unknown>> {
  if (req.method !== "POST") throw new LtiError(405, "method");
  const t = req.headers.get("x-lti-time"), sig = req.headers.get("x-lti-signature");
  if (!t || !/^\d{13}$/.test(t) || !sig || !/^[0-9a-f]{64}$/.test(sig)) throw new LtiError(401, "signature");
  if (Math.abs(Date.now() - Number(t)) > SKEW_MS) throw new LtiError(401, "stale");
  const body = await readBounded(req, ADMIN_BODY);
  if (body === null) throw new LtiError(413, "too_large");
  const path = new URL(req.url).pathname;
  const want = await hmacHex(env.LTI_KEY, `POST\n${path}\n${t}\n${body}`);
  if (!same(want, sig)) throw new LtiError(401, "signature");
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    throw new LtiError(400, "json");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new LtiError(400, "json");
  const b = v as Record<string, unknown>;
  await admitRequest(env, b.request_id);
  return b;
}

/** §17.1's replay rule for every admin call: a request id is kept a day, and a second use is refused (409). */
export async function admitRequest(env: { LTI_DB: D1 }, requestId: unknown): Promise<void> {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(requestId)) throw new LtiError(400, "request_id");
  const now = Date.now();
  // (request ids older than a day go, a page at a time, then this one is recorded: a replay hits the primary key)
  await env.LTI_DB.prepare("DELETE FROM admin_requests WHERE request_id IN (SELECT request_id FROM admin_requests WHERE at < ? LIMIT 100)").bind(now - DAY).run();
  await guarded(() => env.LTI_DB.prepare("INSERT INTO admin_requests (request_id, at) VALUES (?, ?)").bind(requestId, now).run()).catch((e) => {
    if (e instanceof LtiError && e.code === "exists") throw new LtiError(409, "replay");
    throw e;
  });
}

function bootstrapOf(b: Record<string, unknown>, env: AdminEnv): { preset: Preset; bootstrap: Bootstrap } {
  if (!PRESETS.includes(b.preset as Preset)) throw new LtiError(400, "preset");
  const hosts = b.bootstrap_hosts;
  if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > 4 || !hosts.every((h) => typeof h === "string" && h.length <= 253)) throw new LtiError(400, "bootstrap_hosts");
  const norm = (hosts as string[]).map((h) => h.toLowerCase());
  for (const h of norm) {
    const u = checkedUrl(`https://${h}/`, envName(env)!);
    if (u.hostname !== h) throw new LtiError(400, "bootstrap_hosts");
  }
  if (new Set(norm).size !== norm.length || !presetHosts(b.preset as Preset, norm)) throw new LtiError(400, "bootstrap_hosts");
  if (b.expected_issuer !== undefined && (typeof b.expected_issuer !== "string" || b.expected_issuer.length > 255)) throw new LtiError(400, "expected_issuer");
  return { preset: b.preset as Preset, bootstrap: { hosts: norm, ...(b.expected_issuer !== undefined ? { expected_issuer: b.expected_issuer as string } : {}) } };
}

/** POST /lti/admin/codes */
async function codes(b: Record<string, unknown>, env: AdminEnv): Promise<Response> {
  if (!isRef(b.owner_ref) || !isOwnerKind(b.owner_kind) || !isRef(b.actor_ref)) throw new LtiError(400, "params");
  const { preset, bootstrap } = bootstrapOf(b, env);
  const now = Date.now();
  // (expired codes go first, a page at a time, so the live cap counts only live ones)
  await env.LTI_DB.prepare("DELETE FROM codes WHERE code_hash IN (SELECT code_hash FROM codes WHERE expires <= ? AND state = 'live' LIMIT 20)").bind(now).run();
  await audit(env.LTI_AUDIT, { action: "code.issue", actor_ref: b.actor_ref, owner_ref: b.owner_ref, detail: { preset, hosts: bootstrap.hosts } });
  const code = randomHex(32);
  const hash = await sha256Hex(code);
  const bs = JSON.stringify(bootstrap);
  await guarded(() =>
    env.LTI_DB.prepare("INSERT INTO codes (code_hash, owner_ref, owner_kind, preset, bootstrap, expires, state, size) VALUES (?, ?, ?, ?, ?, ?, 'live', ?)")
      .bind(hash, b.owner_ref, b.owner_kind, preset, bs, now + CODE_MS, codeSize(b.owner_ref as string, bs)).run(),
  );
  return json({ code, url: `${env.LTI_ORIGIN}/lti/register?code=${code}`, expires: now + CODE_MS });
}

/** POST /lti/admin/registrations: that owner's registrations, and only those. */
async function registrations(b: Record<string, unknown>, env: AdminEnv): Promise<Response> {
  if (!isRef(b.owner_ref)) throw new LtiError(400, "params");
  const rs = await listForOwner(env.LTI_DB, b.owner_ref);
  return json({ registrations: rs.map((r) => ({ rid: r.rid, state: r.state, iss: r.iss, client_id: r.client_id, preset: r.preset, policy: r.policy, policy_version: r.policy_version, policy_digest: r.policy_digest, staff_approved: r.staff_digest !== null && r.staff_digest === r.policy_digest })) });
}

/** POST /lti/admin/approve: rid's owner, the current version and digest, and a preset match or this digest's staff approval. */
async function approve(b: Record<string, unknown>, env: AdminEnv): Promise<Response> {
  if (!isRef(b.owner_ref) || !isHex(b.rid, 32) || typeof b.policy_version !== "number" || !isHex(b.policy_digest, 64) || !isRef(b.actor_ref)) throw new LtiError(400, "params");
  const r = await getRegistration(env.LTI_DB, b.rid);
  // (another owner's registration is answered as missing, not forbidden: it reveals nothing)
  if (!r || r.owner_ref !== b.owner_ref) throw new LtiError(404, "registration");
  if (r.state !== "pending" || !r.policy || r.policy_version !== b.policy_version || r.policy_digest !== b.policy_digest) throw new LtiError(409, "stale_policy");
  const presetOk = r.preset !== null && matchesPreset(r.policy, r.preset, r.bootstrap.hosts) && (r.bootstrap.expected_issuer === undefined || r.bootstrap.expected_issuer === r.policy.issuer);
  if (!presetOk && r.staff_digest !== r.policy_digest) throw new LtiError(403, "staff_approval_required");
  await audit(env.LTI_AUDIT, { action: "registration.approve", actor_ref: b.actor_ref, owner_ref: r.owner_ref, rid: r.rid, detail: { policy_version: r.policy_version, policy_digest: r.policy_digest, preset_match: presetOk } });
  const res = await guarded(() =>
    env.LTI_DB.prepare("UPDATE registrations SET state = 'approved', approved_digest = policy_digest WHERE rid = ? AND owner_ref = ? AND state = 'pending' AND policy_version = ? AND policy_digest = ? RETURNING rid")
      .bind(r.rid, b.owner_ref, b.policy_version, b.policy_digest).all(),
  );
  // (RETURNING, not meta.changes: D1 counts the quota triggers' writes too)
  if (res.results.length !== 1) throw new LtiError(409, "stale_policy");
  return json({ rid: r.rid, state: "approved" });
}

/** POST /lti/admin/staff-approve: a staff approval for this digest only. */
async function staffApprove(b: Record<string, unknown>, env: AdminEnv): Promise<Response> {
  if (!isHex(b.rid, 32) || !isHex(b.policy_digest, 64) || !isRef(b.staff_ref)) throw new LtiError(400, "params");
  const r = await getRegistration(env.LTI_DB, b.rid);
  if (!r) throw new LtiError(404, "registration");
  if (r.state !== "pending" || r.policy_digest !== b.policy_digest) throw new LtiError(409, "stale_policy");
  await audit(env.LTI_AUDIT, { action: "registration.staff_approve", actor_ref: b.staff_ref, owner_ref: r.owner_ref, rid: r.rid, detail: { policy_digest: b.policy_digest } });
  const res = await env.LTI_DB.prepare("UPDATE registrations SET staff_digest = ? WHERE rid = ? AND state = 'pending' AND policy_digest = ? RETURNING rid").bind(b.policy_digest, r.rid, b.policy_digest).all();
  // (RETURNING, not meta.changes: D1 counts the quota triggers' writes too)
  if (res.results.length !== 1) throw new LtiError(409, "stale_policy");
  return json({ rid: r.rid, staff_digest: b.policy_digest });
}

/** POST /lti/admin/policy: a staff edit of a registration's policy.  The version goes up, and it is pending again: old approvals no longer match. */
async function editPolicy(b: Record<string, unknown>, env: AdminEnv): Promise<Response> {
  if (!isRef(b.owner_ref) || !isHex(b.rid, 32) || !isRef(b.staff_ref)) throw new LtiError(400, "params");
  const r = await getRegistration(env.LTI_DB, b.rid);
  if (!r || r.owner_ref !== b.owner_ref) throw new LtiError(404, "registration");
  if (r.state === "revoked") throw new LtiError(409, "revoked");
  const p = validatePolicy(b.policy, envName(env)!);
  const ps = JSON.stringify(p);
  const digest = await policyDigest(p);
  const size = regSize({ owner_ref: r.owner_ref, iss: p.issuer, client_id: r.client_id, bootstrap: JSON.stringify(r.bootstrap), policy: ps });
  await audit(env.LTI_AUDIT, { action: "registration.policy", actor_ref: b.staff_ref, owner_ref: r.owner_ref, rid: r.rid, detail: { policy_version: r.policy_version + 1, policy_digest: digest } });
  await testGate("policy_update");
  const res = await guarded(() =>
    env.LTI_DB.prepare("UPDATE registrations SET policy = ?, iss = ?, policy_version = policy_version + 1, policy_digest = ?, staff_digest = NULL, approved_digest = NULL, state = 'pending', size = ? WHERE rid = ? AND policy_version = ? AND state = ? AND state <> 'revoked' RETURNING rid")
      .bind(ps, p.issuer, digest, size, r.rid, r.policy_version, r.state).all(),
  );
  // (RETURNING, not meta.changes: D1 counts the quota triggers' writes too)
  if (res.results.length !== 1) throw new LtiError(409, "stale_policy");
  return json({ rid: r.rid, state: "pending", policy_version: r.policy_version + 1, policy_digest: digest });
}

/** POST /lti/admin/manual: a manual registration, staff-approved, at version 1 (§7.1, §17.1). */
async function manual(b: Record<string, unknown>, env: AdminEnv): Promise<Response> {
  if (!isRef(b.owner_ref) || !isOwnerKind(b.owner_kind) || !isRef(b.staff_ref)) throw new LtiError(400, "params");
  if (typeof b.client_id !== "string" || b.client_id.length < 1 || b.client_id.length > 255) throw new LtiError(400, "client_id");
  const deps = b.deployments;
  if (!Array.isArray(deps) || deps.length < 1 || deps.length > 50 || !deps.every((d) => typeof d === "string" && d.length >= 1 && d.length <= 255)) throw new LtiError(400, "deployments");
  const p = validatePolicy(b.policy, envName(env)!);
  const ps = JSON.stringify(p);
  const digest = await policyDigest(p);
  const rid = randomHex(16);
  const bs = JSON.stringify({ hosts: [] });
  await audit(env.LTI_AUDIT, { action: "registration.manual", actor_ref: b.staff_ref, owner_ref: b.owner_ref, rid, detail: { policy_digest: digest } });
  await guarded(() =>
    env.LTI_DB.batch([
      ...insertRegistrationStmts(env.LTI_DB, { rid, owner_ref: b.owner_ref as string, owner_kind: b.owner_kind as OwnerKind, state: "approved", iss: p.issuer, client_id: b.client_id as string, preset: null, bootstrap: bs, policy: ps, policy_version: 1, policy_digest: digest, staff_digest: digest, approved_digest: digest, created: Date.now() }),
      ...(deps as string[]).map((d) => env.LTI_DB.prepare("INSERT INTO deployments (rid, deployment_id, size) VALUES (?, ?, ?)").bind(rid, d, deploymentSize(d))),
    ]),
  );
  return json({ rid, state: "approved", policy_version: 1, policy_digest: digest });
}

/** POST /lti/admin/revoke */
async function revoke(b: Record<string, unknown>, env: AdminEnv): Promise<Response> {
  if (!isRef(b.owner_ref) || !isHex(b.rid, 32) || !isRef(b.actor_ref)) throw new LtiError(400, "params");
  const r = await getRegistration(env.LTI_DB, b.rid);
  if (!r || r.owner_ref !== b.owner_ref) throw new LtiError(404, "registration");
  await audit(env.LTI_AUDIT, { action: "registration.revoke", actor_ref: b.actor_ref, owner_ref: r.owner_ref, rid: r.rid });
  await env.LTI_DB.prepare("UPDATE registrations SET state = 'revoked' WHERE rid = ? AND owner_ref = ?").bind(r.rid, b.owner_ref).run();
  return json({ rid: r.rid, state: "revoked" });
}

const regStub = (env: AdminEnv, rid: string) => env.LTI_REG.get(env.LTI_REG.idFromName(rid));
const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v);
const answer = <T>(r: { ok: true; value: T } | { ok: false; code: string }, status = 409) => (r.ok ? json(r.value) : fail(r.code === "erasure_capacity" ? 503 : r.code === "stale" ? 400 : status, r.code));

/** POST /lti/admin/erase (amendment 1 r6 §4.1): erase_id bound to the current incarnation; issued_at ≤ 25 days old. */
async function erase(b: Record<string, unknown>, env: AdminEnv): Promise<Response> {
  if (!isRef(b.owner_ref) || !isHex(b.rid, 32) || typeof b.sub !== "string" || b.sub.length < 1 || b.sub.length > 255 || !isId(b.erase_id) || typeof b.issued_at !== "number" || !isRef(b.actor_ref)) throw new LtiError(400, "params");
  const r = await getRegistration(env.LTI_DB, b.rid);
  if (!r || r.owner_ref !== b.owner_ref) throw new LtiError(404, "registration");
  // (the audit row names the action, erase_id and rid only: never a handle or the subject)
  await audit(env.LTI_AUDIT, { action: "person.erase", actor_ref: b.actor_ref, owner_ref: r.owner_ref, rid: r.rid, detail: { erase_id: b.erase_id } });
  const personInt = await derivedKey("person", r.rid, b.sub);
  return answer(await regStub(env, r.rid).startErase(r.rid, { erase_id: b.erase_id, person_int: personInt, issued_at: b.issued_at }));
}

/** POST /lti/admin/mapping-hold: the restore procedure's first step (§2.4). */
async function mappingHold(b: Record<string, unknown>, env: AdminEnv): Promise<Response> {
  if (!isHex(b.rid, 32) || !isRef(b.staff_ref)) throw new LtiError(400, "params");
  const r = await getRegistration(env.LTI_DB, b.rid);
  if (!r) throw new LtiError(404, "registration");
  await audit(env.LTI_AUDIT, { action: "mapping.hold", actor_ref: b.staff_ref, owner_ref: r.owner_ref, rid: r.rid });
  await regStub(env, r.rid).mappingHold(r.rid);
  return json({ rid: r.rid, hold: true });
}

/** POST /lti/admin/reported-handles: cocalc.ai's (seq, handle, kind) records, for recovery (§2.4 step 2). */
async function reportedHandles(b: Record<string, unknown>, env: AdminEnv): Promise<Response> {
  if (!isHex(b.rid, 32) || !isRef(b.staff_ref) || !Array.isArray(b.handles) || b.handles.length > 200) throw new LtiError(400, "params");
  const hs = b.handles as { seq: unknown; handle: unknown; kind: unknown }[];
  if (!hs.every((h) => typeof h.seq === "number" && Number.isInteger(h.seq) && h.seq > 0 && isHex(h.handle, 32) && (h.kind === "person" || h.kind === "member" || h.kind === "course"))) throw new LtiError(400, "handles");
  const r = await getRegistration(env.LTI_DB, b.rid);
  if (!r) throw new LtiError(404, "registration");
  await audit(env.LTI_AUDIT, { action: "mapping.reconcile", actor_ref: b.staff_ref, owner_ref: r.owner_ref, rid: r.rid, detail: { count: hs.length } });
  return answer(await regStub(env, r.rid).reconcile(r.rid, hs as { seq: number; handle: string; kind: "person" | "member" | "course" }[]));
}

/** POST /lti/admin/lost-handle: an operator's decision for one lost handle; seq, handle and kind must all match. */
async function lostHandle(b: Record<string, unknown>, env: AdminEnv): Promise<Response> {
  if (!isHex(b.rid, 32) || !isRef(b.staff_ref) || typeof b.seq !== "number" || !isHex(b.handle, 32) || !(b.kind === "person" || b.kind === "member" || b.kind === "course") || !(b.decision === "bind" || b.decision === "retire")) throw new LtiError(400, "params");
  const r = await getRegistration(env.LTI_DB, b.rid);
  if (!r) throw new LtiError(404, "registration");
  let personInt: string | undefined, course: string | undefined;
  if (b.decision === "bind") {
    const str = (v: unknown) => typeof v === "string" && v.length >= 1 && v.length <= 255;
    if (b.kind !== "course") {
      if (!str(b.sub)) throw new LtiError(400, "sub");
      personInt = await derivedKey("person", r.rid, b.sub as string);
    }
    if (b.kind !== "person") {
      if (!str(b.deployment) || !str(b.context)) throw new LtiError(400, "course");
      course = await derivedKey("course", r.rid, b.deployment as string, b.context as string);
    }
  }
  await audit(env.LTI_AUDIT, { action: "mapping.lost_handle", actor_ref: b.staff_ref, owner_ref: r.owner_ref, rid: r.rid, detail: { seq: b.seq, kind: b.kind, decision: b.decision } });
  return answer(await regStub(env, r.rid).resolveLost(r.rid, { seq: b.seq as number, handle: b.handle as string, kind: b.kind as "person" | "member" | "course", decision: b.decision as "bind" | "retire", person_int: personInt, course }));
}

/** POST /lti/admin/mapping-release: clears both holds only at or above every witness, with no lost handle unresolved. */
async function mappingRelease(b: Record<string, unknown>, env: AdminEnv): Promise<Response> {
  if (!isHex(b.rid, 32) || !isRef(b.staff_ref) || !isHex(b.epoch_id, 32) || typeof b.reported_seq !== "number") throw new LtiError(400, "params");
  const r = await getRegistration(env.LTI_DB, b.rid);
  if (!r) throw new LtiError(404, "registration");
  await audit(env.LTI_AUDIT, { action: "mapping.release", actor_ref: b.staff_ref, owner_ref: r.owner_ref, rid: r.rid, detail: { reported_seq: b.reported_seq } });
  return answer(await regStub(env, r.rid).mappingRelease(r.rid, b.epoch_id, b.reported_seq));
}

/**
 * POST /lti/admin/assignment (amendment 3 r15 §1, §3): create an assignment, or
 * publish a revision of the owner's own from the signed `expected_rev`.  Owner
 * first (404), then the CAS (409 `stale_rev`); the public catalog needs staff,
 * on every revision of an assignment that is or becomes public.  The batch runs
 * in the gate, under a ticket (§2.5).  Audit: an intent row before, an outcome
 * row after; an intent with no outcome reads as "not known to have happened".
 */
async function assignment(b: Record<string, unknown>, env: AdminEnv): Promise<Response> {
  const str = (v: unknown, max: number) => typeof v === "string" && v.length >= 1 && byteLength(v) <= max;
  if (!isRef(b.owner_ref) || !isRef(b.actor_ref) || (b.staff_ref !== undefined && !isRef(b.staff_ref)) || !str(b.title, 255) || !["browser", "cocalc", "either"].includes(b.runtime_policy as string) || typeof b.max_points !== "number" || !(b.max_points >= 0 && b.max_points <= 100000) || !["institution", "public"].includes(b.visibility as string) || !isHex(b.bundle_sha, 64)) throw new LtiError(400, "params");
  // (creation has neither; a revision has both, and the tool never substitutes a revision it read itself)
  if ((b.aid === undefined) !== (b.expected_rev === undefined)) throw new LtiError(400, "expected_rev");
  if (b.aid !== undefined && (!isHex(b.aid, 32) || !Number.isSafeInteger(b.expected_rev) || (b.expected_rev as number) < 1)) throw new LtiError(400, "aid");
  const content = contentEnv(env);
  const owner = b.owner_ref as string;
  const creating = b.aid === undefined;
  const aid = creating ? randomHex(16) : (b.aid as string);
  const expected = creating ? 0 : (b.expected_rev as number);
  const action = creating ? "assignment.create" : "assignment.revise";
  await audit(env.LTI_AUDIT, { action, actor_ref: b.actor_ref as string, owner_ref: owner, detail: { request_id: b.request_id, aid, expected_rev: creating ? null : expected, staff_ref: b.staff_ref ?? null } });
  const outcome = async (o: string, rev?: number) => {
    await audit(env.LTI_AUDIT, { action: `${action}.outcome`, actor_ref: b.actor_ref as string, owner_ref: owner, detail: { request_id: b.request_id, aid, outcome: o, ...(rev ? { rev } : {}) } });
  };
  let current: { owner_ref: string; visibility: string } | null = null;
  if (!creating) {
    current = await contentRead(content).first<{ owner_ref: string; visibility: string }>("SELECT owner_ref, visibility FROM assignments WHERE aid = ?", aid);
    // (the owner before anything else: another owner's assignment is a missing one, whatever expected_rev says)
    if (!current || current.owner_ref !== owner) {
      await outcome("not_found");
      throw new LtiError(404, "assignment");
    }
  }
  if ((b.visibility === "public" || current?.visibility === "public") && b.staff_ref === undefined) {
    await outcome("staff_required");
    throw new LtiError(403, "staff_required");
  }
  const now = Date.now();
  const stmts: Stmt[] = creating
    ? [
        { sql: "INSERT OR IGNORE INTO owners (owner_ref, created) VALUES (?, ?)", params: [owner, now] },
        { sql: "INSERT INTO assignments (aid, owner_ref, title, rev, runtime_policy, max_points, visibility, bundle_sha, updated) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)", params: [aid, owner, b.title, b.runtime_policy, b.max_points, b.visibility, b.bundle_sha, now] },
        { sql: "INSERT INTO assignment_revisions (aid, rev, owner_ref, bundle_sha, runtime_policy, max_points, created) VALUES (?, 1, ?, ?, ?, ?, ?)", params: [aid, owner, b.bundle_sha, b.runtime_policy, b.max_points, now] },
      ]
    : [
        { sql: "UPDATE assignments SET rev = rev + 1, title = ?, runtime_policy = ?, max_points = ?, visibility = ?, bundle_sha = ?, updated = ? WHERE aid = ? AND owner_ref = ? AND rev = ?", params: [b.title, b.runtime_policy, b.max_points, b.visibility, b.bundle_sha, now, aid, owner, expected] },
        { sql: "INSERT INTO assignment_revisions (aid, rev, owner_ref, bundle_sha, runtime_policy, max_points, created) VALUES (?, ?, ?, ?, ?, ?, ?)", params: [aid, expected + 1, owner, b.bundle_sha, b.runtime_policy, b.max_points, now] },
      ];
  const r = await gatedWrite(content, "assignment", owner, stmts);
  const rev = creating ? 1 : expected + 1;
  if (r.ok) {
    await outcome("ok", rev);
    return json({ aid, rev });
  }
  // (both aborts mean stale: the trigger's, and the primary key's when the current rev is exactly expected + 1)
  const code = r.code === "unique:assignment_revisions" ? "stale_rev" : r.code;
  if (code === "uncertain_committed") {
    await outcome("ok", rev);
    return json({ aid, rev });
  }
  const known: Record<string, number> = { stale_rev: 409, quota: 507, no_bundle: 404 };
  if (known[code]) {
    await outcome(code);
    throw new LtiError(known[code], code);
  }
  throw new LtiError(r.status, code);
}

/**
 * One gated operation: a ticket of `kind`, one write, the ticket returned.  An
 * expired or spent ticket (409) is the gate's, never the caller's: the
 * operation is answered 503 and starts again with a new ticket.
 */
export async function gatedWrite(env: ContentEnv, kind: "assignment" | "pin", owner: string, stmts: Stmt[]): Promise<WriteResult> {
  const gate = gateOf(env);
  await testGate(`${kind}_before_issue`);
  const t = await gate.issue(kind, owner);
  if (!t.ok) throw new LtiError(t.status, t.code);
  try {
    await testGate(`${kind}_before_write`);
    const r = await gate.write(t.id, stmts);
    if (!r.ok && (r.code === "ticket_expired" || r.code === "ticket_spent")) return { ok: false, status: 503, code: r.code };
    return r;
  } finally {
    await gate.giveBack(t.id);
  }
}

/**
 * POST /lti/admin/content-gate (amendment 3 r15 §2.5's restore runbook, staff only, every step audited):
 * `status` (quiet, the newest checkpoints, the unresolved intents), `pause`, `marker` {k}, `recover`,
 * `resume`, and `close-intent` {intent_id}, which closes an unresolved intent only after a HEAD of every
 * one of its keys finds no object.
 */
async function contentGate(b: Record<string, unknown>, env: AdminEnv): Promise<Response> {
  const ops = ["status", "pause", "marker", "recover", "resume", "close-intent"];
  if (!isRef(b.staff_ref) || !ops.includes(b.op as string)) throw new LtiError(400, "params");
  if (b.op === "marker" && !(Number.isSafeInteger(b.k) && (b.k as number) > 0)) throw new LtiError(400, "k");
  if (b.op === "close-intent" && !isHex(b.intent_id, 32)) throw new LtiError(400, "intent_id");
  const gate = gateOf(contentEnv(env));
  await audit(env.LTI_AUDIT, { action: `content.${b.op}`, actor_ref: b.staff_ref, detail: { request_id: b.request_id, ...(b.k ? { k: b.k } : {}), ...(b.intent_id ? { intent_id: b.intent_id } : {}) } });
  switch (b.op) {
    case "status":
      return json({ ...(await gate.quiet()), recovery: await gate.recoveryState().then((r) => ({ mode: r.mode, recovery_id: r.recovery_id, done: r.done, suspect: r.suspect.length })), checkpoints: await gate.checkpoints(20) });
    case "pause":
      return json(await gate.pause());
    case "marker":
      return json(await gate.marker(b.k as number));
    case "recover":
      return json(await gate.recover());
    case "resume":
      return json(await gate.resume());
    default: {
      const bucket = (env as { LTI_BUNDLES?: R2Bucket }).LTI_BUNDLES;
      if (!bucket) throw new LtiError(503, "not_configured");
      const it = (await gate.intents()).find((i) => i.id === b.intent_id);
      if (!it) throw new LtiError(404, "intent");
      // (an existence check never makes a key usable; it only shows a late delete has nothing left to remove)
      for (const k of it.keys) if (await bucket.head(k)) return json({ ok: false, code: "object_exists", key: k }, 409);
      return json(await gate.closeIntent(it.id));
    }
  }
}

function contentEnv(env: AdminEnv): ContentEnv {
  if (!env.LTI_CONTENT || !env.LTI_GATE) throw new LtiError(503, "not_configured");
  return env;
}

const CALLS: Record<string, (b: Record<string, unknown>, env: AdminEnv) => Promise<Response>> = {
  "/lti/admin/assignment": assignment,
  "/lti/admin/content-gate": contentGate,
  "/lti/admin/erase": erase,
  "/lti/admin/mapping-hold": mappingHold,
  "/lti/admin/reported-handles": reportedHandles,
  "/lti/admin/lost-handle": lostHandle,
  "/lti/admin/mapping-release": mappingRelease,
  "/lti/admin/codes": codes,
  "/lti/admin/registrations": registrations,
  "/lti/admin/approve": approve,
  "/lti/admin/staff-approve": staffApprove,
  "/lti/admin/policy": editPolicy,
  "/lti/admin/manual": manual,
  "/lti/admin/revoke": revoke,
};

export async function handleAdmin(req: Request, env: AdminEnv): Promise<Response> {
  const path = new URL(req.url).pathname;
  const call = CALLS[path];
  if (!call) return fail(404, "not_found");
  try {
    const b = await authenticated(req, env);
    return await call(b, env);
  } catch (e) {
    if (e instanceof LtiError) return fail(e.status, e.code);
    throw e;
  }
}

