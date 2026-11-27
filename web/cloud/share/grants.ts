// Grants (grants design d1, d1r1): what a Sagebrush account may use beyond the free plan, for a window that always ends,
// and the admin routes that make and revoke them.  Only with AUTH_PROVIDER "workos": Sagebrush's own sign-in and its
// own admins, never cocalc.ai's.  A grant opens access only; no grant raises or bypasses a spending control.
//
//   POST /api/admin/grants                { request_id, account_id, storage_bytes?, private_links?, remote?, gpu?,
//                                           seats?, valid_from?, valid_until, note? } -> { grant }
//   POST /api/admin/grants/<id>/revoke    { reason } -> { grant }
//   GET  /api/admin/grants?account=<id>   { grants, audit }
//
// An admin request needs, in order: a live session; its account in SAGEBRUSH_ADMINS (parsed exactly, adminSet); a
// re-authentication of that very session within ADMIN_REAUTH_MS (sessions.reauth_ms, a forced AuthKit sign-in); and
// for a write, POST, same-origin (checked by the router), JSON, at most ADMIN_BODY_MAX bytes and ADMIN_RATE.  Every
// refusal writes nothing and says nothing about who is an admin.
import type { D1 } from "./server.ts";

/** A grant's storage cap and longest window, as the migration's CHECKs (seconds). */
export const GRANT_STORAGE_MAX = 1099511627776;
export const GRANT_WINDOW_MAX_S = 2 * 365 * 86400;
/** How fresh an admin's re-authentication must be (ms), and an admin's writes per minute. */
export const ADMIN_REAUTH_MS = 300_000;
export const ADMIN_RATE = Object.freeze({ limit: 30, windowS: 60 });
export const ADMIN_BODY_MAX = 4096;

const ACCOUNT = /^[0-9a-f-]{36}$/;
const GRANT_ID = /^[a-z2-7]{26}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * SAGEBRUSH_ADMINS parsed exactly (d1r1 G3): comma-separated account ids, each trimmed, empty entries dropped.  Any
 * entry outside the account-id grammar makes the whole list invalid: no admins at all, and `why` says so.  Missing or
 * empty: no admins.  Membership is exact (a Set).
 */
export function adminSet(raw: string | undefined): { admins: ReadonlySet<string>; why: string | null } {
  const entries = (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const bad = entries.find((s) => !ACCOUNT.test(s));
  if (bad !== undefined) return { admins: new Set(), why: "SAGEBRUSH_ADMINS has an entry that isn't an account id: no admins" };
  return { admins: new Set(entries), why: null };
}

/** The SQL condition that grant row g is active at ?t, its time parameter */
const ACTIVE = (t: string) => `g.revoked_at IS NULL AND g.valid_from <= ${t} AND ${t} < g.valid_until`;

/**
 * What the account's grants active at t give: the largest storage (never a sum) and whether any gives private links,
 * remote computers or GPU access.  One read of the primary, no cache; a failed read throws (the caller answers 503).
 */
export async function grantTotals(db: D1, account: string, t: number): Promise<{ count: number; storage_bytes: number | null; private_links: boolean; remote: boolean; gpu: boolean }> {
  const r = await db.prepare(`SELECT COUNT(*) AS n, MAX(g.storage_bytes) AS s, MAX(g.private_links) AS p, MAX(g.remote) AS r, MAX(g.gpu) AS q
    FROM grants g WHERE g.account_id = ?1 AND ${ACTIVE("?2")}`).bind(account, t).first<{ n: number; s: number | null; p: number | null; r: number | null; q: number | null }>();
  if (!r || !Number.isSafeInteger(r.n)) throw new Error("grants unreadable");
  return { count: r.n, storage_bytes: r.s ?? null, private_links: r.p === 1, remote: r.r === 1, gpu: r.q === 1 };
}

/** The access an account's grants open now; any failure is no access (false), never a fallback.  `gpu` only decides
 * whether the page offers GPU: sagebrush-gpu's own membership and billing are the one gate on GPU use, and no grant is
 * ever money (grants design d1r1 G1). */
export async function entitlements(db: D1, account: string, t: number): Promise<{ remote: boolean; gpu: boolean }> {
  try {
    const g = await grantTotals(db, account, t);
    return { remote: g.remote, gpu: g.gpu };
  } catch {
    return { remote: false, gpu: false };
  }
}

/** The admin's session, as the mounting code resolves it: the account, and its re-authentication (ms) or null. */
export type AdminSession = { kind: "ok"; id: string; session: string; reauthMs: number | null } | { kind: "none" } | { kind: "unavailable" };
/** The acting admin: the account and the token hash of the session it was checked with. */
type Actor = { id: string; session: string };
/** SQL: the actor's own session still exists and its account isn't being deleted (?s session hash, ?a account). Every
 * write carries it, so an admin purged after its checks writes nothing: the purge deletes its sessions in the batch
 * that anonymizes, and a write either commits before that batch (and is anonymized by it) or matches no session. */
const ACTOR_LIVE = (s: string, a: string) => `EXISTS (SELECT 1 FROM sessions s JOIN accounts a ON a.account_id = s.account_id WHERE s.token_hash = ${s} AND s.account_id = ${a} AND a.deleting IS NULL)`;
const actorLive = async (db: D1, actor: Actor) => !!(await db.prepare(`SELECT 1 AS x WHERE ${ACTOR_LIVE("?1", "?2")}`).bind(actor.session, actor.id).first());
const signedOut = () => json(401, { error: "sign in first" });
export interface AdminDeps {
  session(req: Request): Promise<AdminSession>;
  /** the Worker's clock (ms); tests replace it */
  now(): number;
  sha256Hex(s: string): Promise<string>;
  /** tests only (the deployed route sets none): runs just before a grant's write batch, after every check */
  beforeWrite?: () => Promise<void>;
}

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: HEADERS });
/** the one refusal for "not an admin" and for a stale or missing re-authentication alike: nothing about who is one */
const forbidden = () => json(403, { error: "admin only", reauth: "/auth/login?reauth=1" });
const GRANT_COLS = "id, account_id, storage_bytes, private_links, remote, gpu, seats, valid_from, valid_until, source, source_ref, note, created_at, created_by, revoked_at, revoked_by, revoke_reason";

function newGrantId(): string {
  const a = "abcdefghijklmnopqrstuvwxyz234567";
  return [...crypto.getRandomValues(new Uint8Array(26))].map((x) => a[x & 31]).join("");
}

/** The grant routes (/api/admin/grants...), or null for any other path. `adminsRaw`: SAGEBRUSH_ADMINS. */
export async function handleGrantsAdmin(req: Request, url: URL, db: D1, adminsRaw: string | undefined, deps: AdminDeps): Promise<Response | null> {
  const p = url.pathname;
  const revoke = /^\/api\/admin\/grants\/([^/]+)\/revoke$/.exec(p);
  if (p !== "/api/admin/grants" && !revoke) return null;
  const write = req.method === "POST";
  if (!write && !(req.method === "GET" && !revoke)) return json(405, { error: "method not allowed" });
  // 1. a live session
  let s: AdminSession;
  try { s = await deps.session(req); } catch { return json(503, { error: "sign-in can't be checked right now" }); }
  if (s.kind === "unavailable") return json(503, { error: "sign-in can't be checked right now" });
  if (s.kind !== "ok") return json(401, { error: "sign in first" });
  // 2. the allow-list, exactly
  const { admins, why } = adminSet(adminsRaw);
  if (why) console.log(why);
  if (!admins.has(s.id)) return forbidden();
  // 3. a fresh re-authentication of this very session
  const t = deps.now();
  if (s.reauthMs === null || !Number.isSafeInteger(s.reauthMs) || !(t - s.reauthMs <= ADMIN_REAUTH_MS)) return forbidden();
  const tS = Math.floor(t / 1000);
  if (!write) {
    const account = url.searchParams.get("account") ?? "";
    if (!ACCOUNT.test(account)) return json(400, { error: "account: an account id" });
    const grants = (await db.prepare(`SELECT ${GRANT_COLS} FROM grants WHERE account_id = ?1 ORDER BY created_at DESC, id`).bind(account).all()).results;
    const audit = (await db.prepare("SELECT a.grant_id, a.at, a.actor, a.action, a.detail FROM grant_audit a JOIN grants g ON g.id = a.grant_id WHERE g.account_id = ?1 ORDER BY a.id").bind(account).all()).results;
    return json(200, { grants, audit });
  }
  // 4. a write's shape: JSON, bounded
  if (!/^application\/json\b/.test(req.headers.get("content-type") ?? "")) return json(415, { error: "JSON only" });
  const len = req.headers.get("content-length");
  if (len === null || !/^[0-9]+$/.test(len) || Number(len) > ADMIN_BODY_MAX) return json(413, { error: "a body of at most 4096 bytes, with its content-length" });
  const text = await req.text();
  if (new TextEncoder().encode(text).length > ADMIN_BODY_MAX) return json(413, { error: "a body of at most 4096 bytes, with its content-length" });
  let b: Record<string, unknown>;
  try { b = JSON.parse(text); } catch { return json(400, { error: "a JSON object is required" }); }
  if (!b || typeof b !== "object" || Array.isArray(b)) return json(400, { error: "a JSON object is required" });
  // 5. the admin's rate
  const actor: Actor = { id: s.id, session: s.session };
  const hit = await db.batch([
    db.prepare("DELETE FROM grant_admin_hits WHERE admin = ?1 AND t <= ?2").bind(s.id, tS - ADMIN_RATE.windowS),
    db.prepare(`INSERT INTO grant_admin_hits (admin, t, id) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM grant_admin_hits WHERE admin = ?1 AND t > ?4) < ?5 AND ${ACTOR_LIVE("?6", "?1")}`)
      .bind(s.id, tS, newGrantId(), tS - ADMIN_RATE.windowS, ADMIN_RATE.limit, s.session),
  ]);
  if (Number((hit[1] as { meta?: { changes?: number } })?.meta?.changes ?? 0) !== 1)
    return (await actorLive(db, actor)) ? json(429, { error: "too many grant changes; wait a minute", retry_after_s: ADMIN_RATE.windowS }) : signedOut();
  if (!revoke) return createGrant(db, actor, b, tS, deps);
  let id: string;
  try { id = decodeURIComponent(revoke[1]); } catch { return json(404, { error: "no such grant" }); }
  return revokeGrant(db, actor, id, b, tS, deps);
}

/** A new grant from an admin request, or the same grant again for an exact retry of its request_id. */
async function createGrant(db: D1, actor: Actor, b: Record<string, unknown>, t: number, deps: AdminDeps): Promise<Response> {
  const admin = actor.id;
  const bad = (what: string) => json(400, { error: what });
  const known = new Set(["request_id", "account_id", "storage_bytes", "private_links", "remote", "gpu", "seats", "valid_from", "valid_until", "note"]);
  const extra = Object.keys(b).find((k) => !known.has(k));
  if (extra !== undefined) return bad(`unknown field: ${extra.slice(0, 40)}`);
  if (typeof b.request_id !== "string" || !REQUEST_ID.test(b.request_id)) return bad("request_id: 8 to 64 of A-Z a-z 0-9 _ -");
  if (typeof b.account_id !== "string" || !ACCOUNT.test(b.account_id)) return bad("account_id: an account id");
  const flag = (v: unknown) => v === undefined || v === null || v === true;
  if (!flag(b.private_links) || !flag(b.remote) || !flag(b.gpu)) return bad("private_links, remote, gpu: true, or absent");
  const storage = b.storage_bytes ?? null, seats = b.seats ?? null;
  if (storage !== null && !(Number.isSafeInteger(storage) && (storage as number) >= 0 && (storage as number) <= GRANT_STORAGE_MAX)) return bad(`storage_bytes: a whole number, 0 to ${GRANT_STORAGE_MAX}`);
  if (seats !== null && !(Number.isSafeInteger(seats) && (seats as number) >= 1 && (seats as number) <= 1000)) return bad("seats: 1 to 1000");
  // (the request's own shape: what doesn't depend on the clock, so an exact retry is judged the same at any time)
  const until = b.valid_until;
  if ((b.valid_from !== undefined && b.valid_from !== null && !(Number.isSafeInteger(b.valid_from) && (b.valid_from as number) >= 0)) || !Number.isSafeInteger(until)) return bad("valid_from, valid_until: whole seconds");
  if (b.note !== undefined && b.note !== null && !(typeof b.note === "string" && b.note.length <= 500)) return bad("note: at most 500 characters, and no personal data");
  const pl = b.private_links === true ? 1 : null, rm = b.remote === true ? 1 : null, gp = b.gpu === true ? 1 : null;
  if (storage === null && pl === null && rm === null && gp === null && seats === null) return bad("a grant gives at least one thing");
  const note = typeof b.note === "string" && b.note !== "" ? b.note : null;
  // (the request's exact meaning: its retry is recognized by request_id, and a different body under it refused)
  // (valid_from as asked, absent as null: an absent one defaults to now, which a retry a second later mustn't change)
  const hash = await deps.sha256Hex(JSON.stringify([b.account_id, storage, pl, rm, gp, seats, b.valid_from ?? null, until, note]));
  const prior = await db.prepare(`SELECT ${GRANT_COLS}, request_hash FROM grants WHERE source = 'admin' AND source_ref = ?1`).bind(b.request_id).first<Record<string, unknown>>();
  if (prior) return prior.request_hash === hash ? json(200, { grant: strip(prior), retried: true }) : json(409, { error: "this request_id was used for another grant" });
  // (a new grant only: its window, from now when valid_from is absent, must still be ahead)
  const from = (b.valid_from ?? t) as number;
  if (!((until as number) > from && (until as number) - from <= GRANT_WINDOW_MAX_S)) return bad("valid_until: after valid_from, and at most 2 years after it");
  if (!((until as number) > t)) return bad("valid_until: in the future");
  const id = newGrantId();
  if (deps.beforeWrite) await deps.beforeWrite();
  try {
    await db.batch([
      // (the holder exists, isn't being deleted and isn't disabled: checked by the insert itself)
      db.prepare(`INSERT INTO grants (id, account_id, storage_bytes, private_links, remote, gpu, seats, valid_from, valid_until, source, source_ref, request_hash, note, created_at, created_by)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'admin', ?10, ?11, ?12, ?13, ?14
        WHERE EXISTS (SELECT 1 FROM accounts WHERE account_id = ?2 AND deleting IS NULL AND disabled IS NULL) AND ${ACTOR_LIVE("?15", "?14")}`)
        .bind(id, b.account_id, storage, pl, rm, gp, seats, from, until, b.request_id, hash, note, t, admin, actor.session),
      db.prepare("INSERT INTO grant_audit (grant_id, at, actor, action, detail) SELECT ?1, ?2, ?3, 'create', NULL WHERE EXISTS (SELECT 1 FROM grants WHERE id = ?1)").bind(id, t, admin),
    ]);
  } catch {
    // (a concurrent request with the same request_id won: read it as a retry)
    const won = await db.prepare(`SELECT ${GRANT_COLS}, request_hash FROM grants WHERE source = 'admin' AND source_ref = ?1`).bind(b.request_id).first<Record<string, unknown>>();
    if (won) return won.request_hash === hash ? json(200, { grant: strip(won), retried: true }) : json(409, { error: "this request_id was used for another grant" });
    return json(503, { error: "the grant couldn't be written; try again" });
  }
  const row = await db.prepare(`SELECT ${GRANT_COLS} FROM grants WHERE id = ?1`).bind(id).first();
  if (row) return json(201, { grant: row });
  return (await actorLive(db, actor)) ? json(404, { error: "no such account, or it can't hold a grant" }) : signedOut();
}

/** Revoke a grant, first revocation wins: a second one answers the grant as the first left it. */
async function revokeGrant(db: D1, actor: Actor, id: string, b: Record<string, unknown>, t: number, deps: AdminDeps): Promise<Response> {
  const admin = actor.id;
  if (!GRANT_ID.test(id)) return json(404, { error: "no such grant" });
  const extra = Object.keys(b).find((k) => k !== "reason");
  if (extra !== undefined) return json(400, { error: `unknown field: ${extra.slice(0, 40)}` });
  if (!(typeof b.reason === "string" && b.reason.length >= 1 && b.reason.length <= 200)) return json(400, { error: "reason: 1 to 200 characters, and no personal data" });
  if (deps.beforeWrite) await deps.beforeWrite();
  await db.batch([
    db.prepare(`UPDATE grants SET revoked_at = ?2, revoked_by = ?3, revoke_reason = ?4 WHERE id = ?1 AND revoked_at IS NULL AND ${ACTOR_LIVE("?5", "?3")}`).bind(id, t, admin, b.reason, actor.session),
    // (the audit row only for the revocation that took effect: the grant's revoked_at is this one's)
    db.prepare("INSERT INTO grant_audit (grant_id, at, actor, action, detail) SELECT ?1, ?2, ?3, 'revoke', NULL WHERE EXISTS (SELECT 1 FROM grants WHERE id = ?1 AND revoked_at = ?2 AND revoked_by = ?3) AND NOT EXISTS (SELECT 1 FROM grant_audit WHERE grant_id = ?1 AND action = 'revoke')").bind(id, t, admin),
  ]);
  if (!(await actorLive(db, actor))) return signedOut();
  const row = await db.prepare(`SELECT ${GRANT_COLS} FROM grants WHERE id = ?1`).bind(id).first();
  return row ? json(200, { grant: row }) : json(404, { error: "no such grant" });
}

const strip = (r: Record<string, unknown>) => {
  const { request_hash: _h, ...rest } = r;
  return rest;
};
