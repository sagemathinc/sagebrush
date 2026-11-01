// The sync service's routes on sagebrush.space (design/sync-server.md §2,
// §5).  Every request is authenticated here, by sharing's session
// (web/share/server.ts sessionOf), and then reaches exactly one object, the
// account's, which it names by the account it authenticated:
//
//   POST /api/sync/v1/enable             turn sync on for this account (allowlisted on dev)
//   GET  /api/sync/v1/account            the account socket (upgrade; Origin checked)
//   POST /api/sync/v1/blobs/check        {blobs: [{sha256, size}]} -> {missing}
//   PUT  /api/sync/v1/blob/<sha256>      the bytes (R2 checks the hash)
//   GET  /api/sync/v1/blob/<sha256>      303 to a signed URL on the user-content domain
//
// and, on the user-content Worker (web/files), /p/<key>: a signed read (§5.4).
//
// Without the sync bindings (production today), every route is a 404:
// the bindings are the flag (§11).  Before authentication, an IP limit
// (SYNC_PREAUTH, Cloudflare's rate-limiting binding) comes first (§2).

import { adminLength, bindPurge, sessionOf, signedWith, type ShareEnv } from "../share/server.ts";
import { parseRange } from "../share/files.ts";
import { accountHash, fields, hmacHex, isNat, isSha, same, LIMITS, URL_MS, SyncError, type Result } from "../sync-protocol/protocol.ts";
import { allowed, gate, testMode, type SyncEnv } from "./env.ts";
import type { SyncAccount } from "./account.ts";

export interface RateLimit { limit(o: { key: string }): Promise<{ success: boolean }> }
/** How long before its reservation ends an upload is cut off (§5.4, CORR-5E2-2). */
const PUT_MARGIN_MS = 60_000;
declare class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number);
}

export type Env = SyncEnv & ShareEnv & {
  /** a test seam: this account id's enable stops after its registration, as if its answer were held (CORR-A62-1) */
  SYNC_TEST_HOLD_ENABLE?: string;
  /** a test seam: registering this account id in D1 fails, as an outage would (CORR-00F-1) */
  SYNC_TEST_FAIL_ENROLL?: string;
  /** tests only: CoCalc's purge of this account id fails to reach its account object */
  SYNC_TEST_FAIL_PURGE?: string;
  /** a test seam: the Worker's immediate delete after a failed finalize is off, so durability is shown without it */
  SYNC_TEST_NO_WORKER_DELETE?: string; SYNC_PREAUTH?: RateLimit; SYNC_FILES_LIMIT?: RateLimit; SYNC_ADMIN_LIMIT?: RateLimit; SYNC_SITE_ORIGIN?: string; LIMITS_KEY?: string };

/** An admin call's body: at most this many bytes (LIMIT-5E2-1). */
const ADMIN_BODY = 4096;
/**
 * Before any work on an admin call (LIMIT-5E2-1): the per-IP admin limit
 * (mandatory: without it, sync's admin routes are off), then, for a POST,
 * a declared Content-Length of at most ADMIN_BODY, judged by sharing's own
 * adminLength, so a purge gets the same 411 or 413 whether or not sync is on
 * (none, empty, not ASCII digits or 0: 411; over 4096: 413).  A refusal here
 * reads no body and calls no object and no database.
 */
async function adminGate(req: Request, env: Env): Promise<Response | null> {
  if (!env.SYNC_ADMIN_LIMIT || !env.SYNC_ACCOUNT) return err(404, "sync is not enabled here");
  if (!(await env.SYNC_ADMIN_LIMIT.limit({ key: req.headers.get("cf-connecting-ip") ?? "unknown" })).success) return err(429, "too many requests");
  if (req.method === "POST") {
    const bad = adminLength(req.headers.get("content-length"));
    if (bad === 411) return err(411, "a body with its Content-Length is required");
    if (bad === 413) return err(413, "too large");
  }
  return null;
}
/** A body read to at most `max` bytes, as text, or null if it is longer (whatever its headers say). */
async function readBounded(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) all.set(p, (at += p.length) - p.length);
  return new TextDecoder().decode(all);
}

// (typed and nosniff, as sharing's: security audit G-3a)
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
/**
 * A request from this site's own pages: Origin says so, or, for a GET
 * (which browsers send without Origin from the same origin), Sec-Fetch-Site.
 */
const sameSite = (req: Request) => {
  const o = req.headers.get("origin");
  if (o !== null) return o === new URL(req.url).origin;
  return req.method === "GET" && req.headers.get("sec-fetch-site") === "same-origin" && req.headers.get("upgrade") === null;
};
const answer = <T>(r: Result<T>, ok: (v: T) => Response) => ("error" in r ? err(STATUS[r.error.code] ?? 400, r.error.code, { message: r.error.message, ...r.error.detail }) : ok(r.ok));

const STATUS: Partial<Record<SyncError["code"], number>> = { conflict: 409, forbidden: 403, deleting: 409, readonly: 409, invalid: 400, limit: 413, rate: 429, busy: 503, missing: 404, storage_full: 507 };

/** The sync API's response to req, or null if req is not for it. */
export async function handleSync(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  // signing out ends the session's sync sockets too, before sharing deletes the session (§2)
  if (p === "/auth/logout" && req.method === "POST") {
    if (env.SYNC_ACCOUNT && env.SHARE_DB && req.headers.get("origin") === url.origin) {
      const who = await sessionOf(req, env);
      if (who && (await env.SHARE_DB.prepare("SELECT 1 AS x FROM sync_accounts WHERE account_hash = ?1 AND state <> 'purged'").bind(await accountHash(who.id)).first())) {
        // the revoke is recorded before the session goes; if it can't be, the sign-out fails, and
        // the session stays, rather than signing out while a socket could still write (CORR-6D6-2)
        try {
          await env.SYNC_ACCOUNT.get(env.SYNC_ACCOUNT.idFromName("acct:" + (await accountHash(who.id)))).revoke({ session: who.session, expires: who.expires * 1000 });
        } catch {
          return err(503, "busy", { message: "signing out didn't finish; try again" });
        }
      }
    }
    return null;
  }
  // CoCalc's signed calls (§6, §9): a plan notice, and its purge of a deleted account, which
  // sharing then handles too (sync's part runs from the account object's alarm)
  if (p === "/api/admin/limits" && req.method === "POST") return (await adminGate(req, env)) ?? adminLimits(req, env);
  if (p === "/api/admin/purge" && req.method === "POST") {
    if (env.SYNC_ACCOUNT && env.SHARE_DB) {
      // (gated here first: sharing then reads the same request, which has passed the same bounds)
      const no = await adminGate(req, env);
      if (no) return no;
      const refused = await adminSyncPurge(req.clone(), env);
      if (refused) return refused;
    }
    return null;
  }
  // CoCalc's signed question, for its emails (§6.2): when an account's synced data will be deleted
  const sr = p.match(/^\/api\/admin\/sync-retention\/([0-9a-f-]{8,100})$/i);
  if (sr && req.method === "GET") return (await adminGate(req, env)) ?? adminSyncRetention(req, env, sr[1]);
  const sp = p.match(/^\/api\/admin\/sync-purge\/([0-9a-f-]{8,64})(?:\/([0-9a-f-]{8,100}))?$/i);
  if (sp && req.method === "GET") return (await adminGate(req, env)) ?? adminSyncPurgeStatus(req, env, sp[1], sp[2]);
  if (!p.startsWith("/api/sync/")) return null;
  // (the pre-authentication limit is part of the flag: without it, sync is off, LIMIT-321-1)
  if (!env.SYNC_ACCOUNT || !env.SYNC_DOC || !env.SHARE_DB || !env.SYNC_PREAUTH) return err(404, "sync is not enabled here");
  // before anything that reads a session: one limit per IP, whatever the request claims
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  // (the limit counts a minute: a refused page waits that long, LIMIT-SYNC-STATUS-1)
  if (!(await env.SYNC_PREAUTH.limit({ key: ip })).success) return err(429, "too many requests", { retry_after: 60_000 });
  const m = req.method;
  // every sync request is state-changing or a socket: both come only from this site's pages
  if (!sameSite(req)) return err(403, "cross-site request");
  const who = await sessionOf(req, env);
  if (!who) return err(401, "sign in first");
  // the page's question, whether this account may turn sync on and how it is: it never creates or
  // registers anything.  Off the allowlist it is answered here, before any object is asked (the page
  // hides its switch then: the reason is for the page's logic, not to show)
  if (p === "/api/sync/v1/status" && m === "GET") {
    // (the account the answer is for, as its hash: from this same request's session, never from anything the caller
    // sends; the page checks it against /api/share/me's, so an answer computed for another session is never taken as
    // its own (PR #130, astra3's CORR-PR130-4))
    const account = await accountHash(who.id);
    if (!allowed(env, who.id)) return json({ available: false, reason: "not_allowlisted", state: "off", account });
    return json({ ...(await env.SYNC_ACCOUNT.get(env.SYNC_ACCOUNT.idFromName("acct:" + account)).status({ account: who.id })), account });
  }
  if (!allowed(env, who.id)) return err(403, "sync isn't enabled for this account");
  const hash = await accountHash(who.id);
  const stub = env.SYNC_ACCOUNT.get(env.SYNC_ACCOUNT.idFromName("acct:" + hash));
  if (p === "/api/sync/v1/enable" && m === "POST") {
    // The account object decides (CORR-02C-1): it answers the generation, registering, or refuses
    // while a deletion runs.  Nothing is taken until D1 records that generation and the object hears
    // so (CORR-00F-1: the daily inventory finds an account's objects by its row).
    const e = await stub.enable({ account: who.id, hash });
    if ("error" in e) return answer(e, json);
    // (a test seam: the registration is held here, after the account object answered and before D1,
    // for generation 1 only; the test then sends the rest itself, through /__test/register)
    if (testMode(env) && (env.SYNC_TEST_HOLD_ENABLE ?? "").split(",").includes(who.id) && e.ok.generation === 1) return json({ held: e.ok.generation });
    return register(env, stub, who.id, hash, e.ok.generation);
  }
  if (p === "/api/sync/v1/delete" && m === "POST") {
    // (the generation the device was given, by enable or the socket's welcome: a late request for an
    // older one leaves a newer alone, CORR-3ED-1)
    const b = (await req.json().catch(() => null)) as { confirm?: unknown; generation?: unknown } | null;
    if (b?.confirm !== "delete" || !Number.isSafeInteger(b.generation) || (b.generation as number) < 1) return err(400, "invalid", { message: 'send {"confirm": "delete", "generation": <the account\'s generation>}' });
    const rid = crypto.randomUUID();
    const r = await stub.purge({ request_id: rid, kind: "self", generation: b.generation as number });
    await recordPurge(env, hash, r, "self");
    return json(r, 202);
  }
  if (p === "/api/sync/v1/account" && m === "GET") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return err(426, "a WebSocket upgrade");
    const h = new Headers(req.headers);
    // (the object trusts only these, which only this Worker can send it)
    h.set("x-sync-account", who.id);
    h.set("x-sync-session", who.session);
    h.set("x-sync-expires", String(who.expires * 1000));
    return stub.fetch(new Request(req.url, { method: "GET", headers: h }));
  }
  const dg = p.match(/^\/api\/sync\/v1\/doc\/([0-9a-f]{64})\/([0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  if (dg && m === "GET") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return err(426, "a WebSocket upgrade");
    // (phase 1 and 2: the account's own documents; another owner's come with collaboration)
    if (dg[1] !== hash) return err(404, "unknown_doc");
    const h = new Headers(req.headers);
    h.set("x-sync-account", who.id);
    h.set("x-sync-session", who.session);
    return env.SYNC_DOC.get(env.SYNC_DOC.idFromName(`doc:${dg[1]}:${dg[2]}`)).fetch(new Request(req.url, { method: "GET", headers: h }));
  }
  // (the client's binding on its blob requests: the account hash and generation whose outbox the bytes are for,
  // checked by the account object before anything is reserved or answered, CORR-PR58-1)
  const bindAccount = req.headers.get("x-sync-account"), bindGen = req.headers.get("x-sync-generation");
  if ((bindAccount !== null && !/^[0-9a-f]{64}$/.test(bindAccount)) || (bindGen !== null && !/^\d{1,15}$/.test(bindGen))) return err(400, "invalid", { message: "x-sync-account is an account hash, x-sync-generation a number" });
  const bind = { ...(bindAccount !== null ? { account: bindAccount } : {}), ...(bindGen !== null ? { generation: Number(bindGen) } : {}) };
  if (p === "/api/sync/v1/blobs/check" && m === "POST") {
    if (!/^application\/json\b/.test(req.headers.get("content-type") ?? "")) return err(415, "JSON only");
    const text = await req.text();
    if (text.length > 128 << 10) return err(413, "limit");
    let blobs: string[];
    try {
      const b = fields(JSON.parse(text), ["blobs"], "check");
      if (!Array.isArray(b.blobs) || b.blobs.length > LIMITS.checkItems) throw new SyncError("limit", "at most " + LIMITS.checkItems);
      blobs = b.blobs.map((x) => {
        const o = fields(x, ["sha256", "size"], "blob");
        if (!isSha(o.sha256) || !isNat(o.size)) throw new SyncError("invalid", "blob");
        return o.sha256;
      });
    } catch (e) {
      return err(e instanceof SyncError && e.code === "limit" ? 413 : 400, e instanceof SyncError ? e.code : "invalid");
    }
    return answer(await stub.missing({ account: who.id, blobs, bind }), (missing) => json({ missing }));
  }
  const g = p.match(/^\/api\/sync\/v1\/blob\/([0-9a-f]{64})$/);
  if (g && m === "PUT") return putBlob(req, env, stub, who.id, g[1], bind);
  if (g && m === "GET") {
    if (!env.SYNC_URL_KEY || !env.FILES_ORIGIN) return err(404, "reading blobs is not enabled here");
    const r = await stub.read({ account: who.id, sha256: g[1], who: "devices" });
    if ("error" in r) return answer(r, json);
    const exp = Date.now() + URL_MS;
    const sig = await hmacHex(env.SYNC_URL_KEY, `p\n${r.ok.key}\n${exp}`);
    const to = new URL(`/p/${r.ok.key}`, env.FILES_ORIGIN);
    to.searchParams.set("exp", String(exp));
    to.searchParams.set("sig", sig);
    return new Response(null, { status: 303, headers: { location: to.toString(), "cache-control": "no-store" } });
  }
  return err(404, "not found");
}

/**
 * The rest of turning sync on, once the account object has answered
 * `generation` (CORR-02C-1): D1 records it, then the object is told, and only
 * then takes writes.  D1's row only moves forward: a write for an older
 * generation than it holds changes nothing, so a registration held for any
 * time can't take the row back.  If the object answers that the generation
 * was retired meanwhile, its row (and only its) is marked purged, as no
 * storage will hold it again.  Exported for the test entry, which resumes a
 * registration held by its seam.
 */
export async function register(env: Env, stub: ReturnType<NonNullable<Env["SYNC_ACCOUNT"]>["get"]>, account: string, hash: string, generation: number): Promise<Response> {
  const db = env.SHARE_DB!;
  let reg: { state: string; generation: number } | null;
  try {
    if (testMode(env) && env.SYNC_TEST_FAIL_ENROLL === account) throw new Error("D1 unavailable (test seam)");
    await db.prepare("INSERT INTO sync_accounts (account_hash, prefix, state, created, generation) VALUES (?1, substr(?1, 1, 32), 'active', ?2, ?3) ON CONFLICT(account_hash) DO UPDATE SET state = 'active', request_id = NULL, kind = NULL, finished = NULL, docs = NULL, bytes = NULL, claim_bytes = 0, generation = excluded.generation WHERE sync_accounts.generation < excluded.generation")
      .bind(hash, Math.floor(Date.now() / 1000), generation).run();
    reg = await db.prepare("SELECT state, generation FROM sync_accounts WHERE account_hash = ?1").bind(hash).first<{ state: string; generation: number }>();
  } catch {
    // (the object stays registering, taking nothing; turning sync on again goes on from here)
    return err(503, "busy", { message: "turning sync on didn't finish; try again" });
  }
  // (the row is past this generation, or this generation's deletion has begun: nothing to confirm)
  if (reg?.generation !== generation || reg.state !== "active") return err(409, "conflict", { message: "turning sync on met another change; try again" });
  const c = await stub.confirm({ account, generation });
  if ("error" in c && typeof c.error.detail?.retired === "number") {
    await gate(env, "register-cleanup");
    await db.prepare("UPDATE sync_accounts SET state = 'purged', finished = ?2, docs = COALESCE(docs, 0), bytes = COALESCE(bytes, 0), claim_bytes = 0 WHERE account_hash = ?1 AND generation = ?3 AND state = 'active'")
      .bind(hash, Math.floor(Date.now() / 1000), generation).run();
  }
  return answer(c, json);
}

/**
 * D1's record of a purge the account object has answered (CORR-02C-1): what
 * it says, for the generation it names, never more.  `deleting`: that
 * generation's row, unless it is purged already (its deletion finished
 * first).  `none`: every generation up to the highest retired, none of which
 * any storage can hold again.  `stale`: nothing.
 */
async function recordPurge(env: Env, hash: string, r: { state: string; request_id: string; kind?: string; generation?: number; retired?: number }, kind: "self" | "admin"): Promise<void> {
  const db = env.SHARE_DB!;
  if (r.state === "deleting" && r.generation !== undefined) {
    await gate(env, "record-deleting");
    await db.prepare("UPDATE sync_accounts SET state = 'deleting', request_id = ?2, kind = ?3 WHERE account_hash = ?1 AND generation = ?4 AND state <> 'purged'").bind(hash, r.request_id, r.kind ?? kind, r.generation).run();
  } else if (r.state === "none" && (r.retired ?? 0) > 0) {
    await gate(env, "record-none");
    const now = Math.floor(Date.now() / 1000);
    const marks = [db.prepare("UPDATE sync_accounts SET state = 'purged', finished = ?2, request_id = ?3, kind = ?4, docs = COALESCE(docs, 0), bytes = COALESCE(bytes, 0), claim_bytes = 0 WHERE account_hash = ?1 AND generation <= ?5 AND state <> 'purged'")
      .bind(hash, now, r.request_id, kind, r.retired)];
    await db.batch(marks);
  }
}

/** POST /api/admin/limits (§6): CoCalc's signed plan notice, with LIMITS_KEY (never PURGE_KEY). */
async function adminLimits(req: Request, env: Env): Promise<Response> {
  if (!env.SYNC_ACCOUNT || !env.LIMITS_KEY) return err(404, "sync is not enabled here");
  const body = await readBounded(req, ADMIN_BODY);
  // (a body longer than the Content-Length that passed the gate: a second line, its own answer)
  if (body === null) return err(400, "bad request", { message: "the body is longer than it said" });
  if (!(await signedWith(req, env.LIMITS_KEY, body))) return err(401, "bad signature");
  let v: { request_id?: unknown; account_id?: unknown; issued?: unknown; limits?: unknown };
  try {
    v = JSON.parse(body);
  } catch {
    return err(400, "bad request");
  }
  if (typeof v.account_id !== "string" || !v.account_id || v.account_id.length > 100 || typeof v.request_id !== "string" || !Number.isSafeInteger(v.issued) || !v.limits || typeof v.limits !== "object") return err(400, "bad request");
  const stub = env.SYNC_ACCOUNT.get(env.SYNC_ACCOUNT.idFromName("acct:" + (await accountHash(v.account_id))));
  return answer(await stub.notice({ account: v.account_id, issued: v.issued as number, limits: v.limits }), json);
}

/**
 * Sync's part of CoCalc's signed purge (§9): the account object deletes
 * everything it holds.  Null lets sharing's part go on; a response refuses
 * the whole purge, only for a correctly signed request whose id is already
 * another account's (CORR-E0D-1).  Nothing else refuses it: sharing's
 * deletion never waits on sync's bookkeeping.
 */
async function adminSyncPurge(req: Request, env: Env): Promise<Response | null> {
  const body = await readBounded(req, ADMIN_BODY);
  if (body === null || !(await signedWith(req, env.PURGE_KEY, body))) return null;
  let v: { request_id?: unknown; account_id?: unknown };
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof v.account_id !== "string" || !v.account_id || v.account_id.length > 100 || typeof v.request_id !== "string" || !/^[0-9a-f-]{8,64}$/i.test(v.request_id)) return null;
  const hash = await accountHash(v.account_id);
  const db = env.SHARE_DB!;
  // The request id is bound to this account BEFORE any account object is asked (CORR-E9C-1), by the
  // purge's own record, sharing's: one D1 row, made at most once for the id, which sharing's part of
  // this same request makes anyway, and whose pending run the scheduled job finishes whatever becomes
  // of this request.  So of two requests naming one new id for two accounts, exactly one binds it; the
  // other is refused here, its account object never touched; and sync adds no row of its own to bind
  // (LIMIT-5DC-1).
  if ((await bindPurge(env, v.account_id, v.request_id, "admin")) === "conflict") return err(409, "conflict", { message: "this request id belongs to another account's purge" });
  await gate(env, "purge-bound");
  // The account object decides, whatever D1 says (an account still registering has no row yet; no
  // generation named, as whatever it holds goes, CORR-02C-1).  Every purge is admitted: sharing's
  // deletion never waits on sync's bookkeeping.  If the object can't be reached, the whole purge
  // answers 503, for CoCalc to send again, and sync has recorded nothing (CORR-5D0-1).
  let r: Awaited<ReturnType<SyncAccount["purge"]>>;
  try {
    if (testMode(env) && env.SYNC_TEST_FAIL_PURGE === v.account_id) throw new Error("the account object is unavailable (test seam)");
    r = await env.SYNC_ACCOUNT!.get(env.SYNC_ACCOUNT!.idFromName("acct:" + hash)).purge({ request_id: v.request_id, kind: "admin" });
  } catch {
    return err(503, "busy", { message: "sync's part of the purge didn't start; send it again" });
  }
  await recordPurge(env, hash, r, "admin");
  // CoCalc's receipt, by its own id (CORR-1C2-1), written once the object has answered, and only for
  // an account that held sync state: so the table never holds more than RECEIPTS_PER_ACCOUNT x the
  // accounts that ever had sync state (LIMIT-233-1, CORR-5D0-1, LIMIT-5DC-1).  The id is this
  // account's already (above), so no other account's receipt can hold it.  A new id evicts the
  // account's oldest in the same transaction; a retried id keeps its receipt.  Whatever a receipt
  // says, the status call asks the object itself unless the receipt says purged, so a completion that
  // ran before this write, or an evicted receipt, never misleads it.
  if (!(r.state === "none" && (r.retired ?? 0) === 0)) {
    const now = Math.floor(Date.now() / 1000);
    const done = r.state === "none";
    await db.batch([
      db.prepare("DELETE FROM sync_admin_requests WHERE request_id IN (SELECT request_id FROM sync_admin_requests WHERE account_hash = ?2 AND NOT EXISTS (SELECT 1 FROM sync_admin_requests WHERE request_id = ?1) ORDER BY rowid DESC LIMIT -1 OFFSET ?3)")
        .bind(v.request_id, hash, RECEIPTS_PER_ACCOUNT - 1),
      db.prepare("INSERT OR IGNORE INTO sync_admin_requests (request_id, account_hash, state, created, finished, docs, bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)")
        .bind(v.request_id, hash, done ? "purged" : "deleting", now, done ? now : null, done ? 0 : null),
    ]);
  }
  return null;
}

/**
 * GET /api/admin/sync-retention/<account_id> (signed with LIMITS_KEY, a plan
 * matter): the account's sync state, when its plan stopped including sync
 * (`readonly_since`, ms) and when its synced data will be deleted
 * (`purge_after`, ms), both null if it isn't read-only.  CoCalc sends its
 * emails from this (§6.2): at the start, and about 14 days before
 * purge_after, asking again first.  404: the account never synced.
 */
async function adminSyncRetention(req: Request, env: Env, account: string): Promise<Response> {
  if (!env.SYNC_ACCOUNT || !(await signedWith(req, env.LIMITS_KEY, ""))) return err(401, "bad signature");
  const r = await env.SYNC_ACCOUNT.get(env.SYNC_ACCOUNT.idFromName("acct:" + (await accountHash(account)))).retentionOf({ account });
  return r ? json({ account_id: account, ...r, now: Date.now() }) : err(404, "this account never synced");
}

/**
 * GET /api/admin/sync-purge/<request_id>[/<account_id>] (signed): where
 * sync's part of a purge is (CORR-5D0-1).  A receipt that says purged answers
 * with its counts.  Otherwise the account object answers, the authority:
 * `deleting`, `purged`, or `never_synced` (nothing to delete: done).  The
 * account is the receipt's, or the one named in the path; naming it is what
 * makes the answer certain after a receipt is evicted or for an account that
 * never synced.  404 only means sync's part never started (no receipt, and
 * the account object has had no CoCalc purge): send the purge again.  It
 * never means done.
 */
async function adminSyncPurgeStatus(req: Request, env: Env, rid: string, account: string | undefined): Promise<Response> {
  if (!env.SHARE_DB || !(await signedWith(req, env.PURGE_KEY, ""))) return err(401, "bad signature");
  const r = await env.SHARE_DB.prepare("SELECT account_hash, state, docs, bytes FROM sync_admin_requests WHERE request_id = ?1").bind(rid).first<{ account_hash: string; state: string; docs: number | null; bytes: number | null }>();
  const named = account ? await accountHash(account) : undefined;
  if (r && named && r.account_hash !== named) return err(409, "conflict", { message: "this request id belongs to another account's purge" });
  if (r?.state === "purged") return json({ request_id: rid, state: "purged", docs: r.docs, bytes: r.bytes, source: "receipt" });
  const hash = r?.account_hash ?? named;
  if (!hash || !env.SYNC_ACCOUNT) return err(404, "no such request", { message: "name the account to ask it: /api/admin/sync-purge/<request_id>/<account_id>" });
  const st = await env.SYNC_ACCOUNT.get(env.SYNC_ACCOUNT.idFromName("acct:" + hash)).purgeState();
  if (st.state === "not_requested") return err(404, "no such request", { state: "not_requested", message: "sync's part of this purge never started; send the purge again" });
  return json({ request_id: rid, state: st.state, source: "account" });
}

/**
 * The daily inventory (§9, CORR-5E2-2): every object under s/, a page at a
 * time, resuming where the last run stopped.  An object older than
 * INVENTORY_AGE whose account is purged or unknown, or whose account object
 * doesn't know its key, is deleted.  R2 gives no bound on when a put that
 * has sent its last byte commits, so this is what stays responsible for a
 * late commit, whenever it lands, even after its account is deleted or
 * turned on again: a live account keeps every key it knows.
 */
export async function syncScheduled(env: Env, opts: { deadlineMs?: number; prefix?: string } = {}): Promise<{ pages: number; checked: number; deleted: number; calls: number; pruned: number; stopped: boolean }> {
  const out = { pages: 0, checked: 0, deleted: 0, calls: 0, pruned: 0, stopped: false };
  if (!env.SYNC_ACCOUNT || !env.SHARE_DB || !env.SHARE_BUCKET) return out;
  const db = env.SHARE_DB;
  const test = testMode(env);
  // (a wall-clock bound on the whole run, LIMIT-SYNC-CRON-1: every call it makes, D1, R2 or an
  // account object, starts only before the deadline and is waited for only until it; past it the
  // run stops where it is.  Each step is safe to stop after: a prune or a delete that lands late
  // only does what the run meant, and a page's cursor moves only after the page is done)
  const deadline = Date.now() + (test && opts.deadlineMs !== undefined ? opts.deadlineMs : INVENTORY_DEADLINE_MS);
  const step = async <T>(call: () => Promise<T>): Promise<{ v: T } | null> => {
    // (once stopped, stopped: a timer may fire a moment before the clock reads the deadline)
    if (out.stopped || Date.now() >= deadline) {
      out.stopped = true;
      return null;
    }
    out.calls++;
    const r = await beforeDeadline(call(), deadline);
    if (!r) out.stopped = true;
    return r;
  };
  const [page, pages] = test ? [50, 2] : [INVENTORY_PAGE, INVENTORY_PAGES];
  const old = Date.now() - (test ? 1000 : INVENTORY_AGE_MS);
  // CoCalc's purge receipts past their polling lifetime (CORR-1C2-1): 30 days after they finished,
  // 90 if they never did.  Each by its own partial index, a page at a time until none is left or
  // PRUNE_PAGES are done: 2 x PRUNE_PAGES x PRUNE_PAGE a run, twice what a day admits, so a backlog
  // (missed runs) drains too (LIMIT-233-1).
  const [prunePage, prunePages] = test ? [50, 3] : [PRUNE_PAGE, PRUNE_PAGES];
  const nowS = Math.floor(Date.now() / 1000);
  for (const [sql, before] of [
    ["DELETE FROM sync_admin_requests WHERE request_id IN (SELECT request_id FROM sync_admin_requests WHERE state = 'purged' AND finished < ?1 LIMIT ?2)", nowS - (test ? 2 : RECEIPT_TTL_MS / 1000)],
    ["DELETE FROM sync_admin_requests WHERE request_id IN (SELECT request_id FROM sync_admin_requests WHERE state = 'deleting' AND created < ?1 LIMIT ?2)", nowS - (test ? 6 : (3 * RECEIPT_TTL_MS) / 1000)],
  ] as const) {
    for (let n = 0; n < prunePages; n++) {
      const r = await step(() => db.prepare(sql).bind(before, prunePage).run() as unknown as Promise<{ meta?: { changes?: number } }>);
      if (!r) return out;
      const changed = r.v?.meta?.changes ?? 0;
      out.pruned += changed;
      if (changed < prunePage) break;
    }
  }
  // (a bound on the calls a run makes, LIMIT-268-1: a page is begun only if its worst case still
  // fits: the cursor read and the list, the account lookup, an account call per object, the delete
  // and the cursor write)
  const worst = 2 + 1 + page + 1 + 1;
  for (let n = 0; n < pages && out.calls + worst <= INVENTORY_CALLS; n++) {
    const at = await step(() => db.prepare("SELECT v FROM meta WHERE k = 'sync_inventory_cursor'").first<{ v: string }>());
    if (!at) return out;
    const cursor = at.v?.v;
    const listed = await step(() => env.SHARE_BUCKET!.list({ prefix: test && opts.prefix ? opts.prefix : "s/", limit: page, ...(cursor ? { cursor } : {}) }));
    if (!listed) return out;
    const l = listed.v;
    const byPrefix = new Map<string, string[]>();
    for (const o of l.objects) {
      if (new Date(o.uploaded).valueOf() > old) continue;
      const p = o.key.split("/")[1] ?? "";
      byPrefix.set(p, [...(byPrefix.get(p) ?? []), o.key]);
    }
    const known = new Set<string>();
    if (byPrefix.size) {
      // one lookup for the whole page, by the indexed prefix
      const found = await step(() => db.prepare("SELECT account_hash, prefix, state FROM sync_accounts WHERE prefix IN (SELECT value FROM json_each(?1))").bind(JSON.stringify([...byPrefix.keys()])).all<{ account_hash: string; prefix: string; state: string }>());
      if (!found) return out;
      // one call to each live account the page names, with its keys; a run that stops before all
      // have answered deletes nothing of the page (a key a slow account knows must not be lost)
      for (const a of found.v.results) {
        if (a.state === "purged") continue;
        const r = await step(() => env.SYNC_ACCOUNT!.get(env.SYNC_ACCOUNT!.idFromName("acct:" + a.account_hash)).knownKeys({ keys: byPrefix.get(a.prefix) ?? [] }));
        if (!r) return out;
        for (const k of r.v.known) known.add(k);
      }
      // one delete for the page
      const gone = [...byPrefix.values()].flat().filter((k) => !known.has(k));
      if (gone.length) {
        if (!(await step(() => env.SHARE_BUCKET!.delete(gone)))) return out;
        out.deleted += gone.length;
      }
    }
    // (the cursor moves only past a page done in full)
    if (!(await step(() => db.prepare("INSERT INTO meta (k, v) VALUES ('sync_inventory_cursor', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1").bind(l.truncated ? (l.cursor ?? "") : "").run()))) return out;
    out.pages++;
    out.checked += l.objects.length;
    if (!l.truncated) break;
  }
  return out;
}
/** The inventory's pages: objects in each, at most this many a run, and at most this many calls a run (LIMIT-268-1). */
const INVENTORY_PAGE = 100, INVENTORY_PAGES = 5, INVENTORY_CALLS = 400;
/**
 * How long a run may take (LIMIT-SYNC-CRON-1), the whole of it: no call starts past it, and none is
 * waited for beyond it.  Cloudflare ends a cron at 15 minutes; this leaves 5.
 */
const INVENTORY_DEADLINE_MS = 10 * 60_000;
/** A call's answer, or null if the deadline passes first: a late answer is then let go (disposed). */
async function beforeDeadline<T>(p: Promise<T>, deadline: number): Promise<{ v: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), Math.max(0, deadline - Date.now()))));
  try {
    const r = await Promise.race([p.then((v) => ({ v })), late]);
    if (r === null) p.then((x) => (x as Partial<Disposable> | null)?.[Symbol.dispose]?.(), () => {});
    return r;
  } finally {
    clearTimeout(timer);
  }
}
/** How old an object must be before the inventory may delete it: far beyond any upload's reservation. */
const INVENTORY_AGE_MS = 2 * 86400_000;
/** How long CoCalc may poll a purge's status after it finished (CORR-1C2-1). */
const RECEIPT_TTL_MS = 30 * 86400_000;
/** At most this many purge receipts an account keeps (LIMIT-233-1): a new id evicts the oldest. */
const RECEIPTS_PER_ACCOUNT = 8;
/** The prune's pages: 2 kinds x 10 pages x 1,000 = 20,000 a run, at least twice RECEIPTS_PER_DAY each kind. */
const PRUNE_PAGE = 1000, PRUNE_PAGES = 10;

/**
 * An upload (§5.4): reserve, stream to R2 with the SHA-256 for R2 to
 * check, and finalize.  A failure between the two gives the reservation
 * and the object back at once (the alarm and the inventory catch the rest).
 */
async function putBlob(req: Request, env: Env, stub: ReturnType<NonNullable<Env["SYNC_ACCOUNT"]>["get"]>, account: string, sha256: string, bind: { account?: string; generation?: number } = {}): Promise<Response> {
  const len = req.headers.get("content-length");
  if (!len || !/^\d{1,12}$/.test(len)) return err(411, "Content-Length is required");
  const size = Number(len);
  const r = await stub.reserve({ account, sha256, size, bind });
  if ("error" in r) return answer(r, json);
  if ("have" in r.ok) return json({ sha256, have: true });
  const { id, key, expires } = r.ok;
  // The reservation's end is enforced on the upload itself (CORR-5E2-2): the body streams to R2
  // through a stream that is aborted a margin before it, and R2 makes an object only from a put that
  // completes.  So once a reservation has ended, no write of its key can still appear: a put that
  // finished in time is finalized, or its key is deleted when the reservation ends; one that didn't
  // never exists.
  const deadline = expires - (testMode(env) ? 1000 : PUT_MARGIN_MS);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(0, deadline - Date.now()));
  let stored: { size: number } | null = null;
  try {
    const fixed = new FixedLengthStream(size);
    req.body!.pipeTo(fixed.writable, { signal: ac.signal }).catch(() => {});
    stored = await env.SHARE_BUCKET!.put(key, fixed.readable, { sha256 });
  } catch {
    stored = null;
  } finally {
    clearTimeout(timer);
  }
  if (!stored && Date.now() >= deadline) {
    await stub.abandon({ id });
    return err(408, "busy", { message: "this upload took too long; send it again" });
  }
  // (R2 checks the SHA-256, and the runtime ends a request whose body isn't its Content-Length, so a
  // stored size that differs is not expected; it is still checked, a second line, LIMIT-7FB-4)
  if (!stored || stored.size !== size) {
    await stub.abandon({ id });
    return err(400, "invalid", { message: "the bytes don't match their SHA-256 or their length" });
  }
  const f = await stub.finalize({ account, id, size: stored.size });
  // (not finalized: nothing will own this object, so it goes now; the account's outbox has it too
  // when it can, CORR-5E2-2)
  if ("error" in f && !(testMode(env) && env.SYNC_TEST_NO_WORKER_DELETE)) await env.SHARE_BUCKET!.delete(key).catch(() => {});
  return answer(f, (v) => json(v, 201));
}

/**
 * A signed read on the user-content Worker (§5.4): /p/<key>?exp&sig, for
 * 5 minutes, ranges allowed, as shared files are served: an attachment,
 * nosniff, a sandboxing CSP, private, and CORS for sagebrush.space only.
 */
export async function handleSyncFiles(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/p\/(s\/[0-9a-f]{32}\/[0-9a-f]{36})$/);
  if (!m) return null;
  const base: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "cross-origin",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
    ...(env.SYNC_SITE_ORIGIN ? { "access-control-allow-origin": env.SYNC_SITE_ORIGIN, vary: "origin", "access-control-expose-headers": "content-length, content-range" } : {}),
  };
  const no = (status: number, text: string) => new Response(text, { status, headers: { ...base, "content-type": "text/plain; charset=utf-8" } });
  // (the per-IP limit is part of the flag here too: without it, no signed read is served, LIMIT-7FB-2)
  if (!env.SYNC_URL_KEY || !env.SHARE_BUCKET || !env.SYNC_FILES_LIMIT) return no(404, "not found");
  // before anything touches R2: one limit per IP, so a reusable URL can't be replayed without bound
  if (!(await env.SYNC_FILES_LIMIT.limit({ key: req.headers.get("cf-connecting-ip") ?? "unknown" })).success) return no(429, "too many requests");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...base, "access-control-allow-methods": "GET, HEAD", "access-control-allow-headers": "range", "access-control-max-age": "600" } });
  if (req.method !== "GET" && req.method !== "HEAD") return no(405, "method not allowed");
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!Number.isSafeInteger(exp) || exp < Date.now() || exp > Date.now() + URL_MS + 60_000) return no(403, "this link has expired");
  if (!same(sig, await hmacHex(env.SYNC_URL_KEY, `p\n${m[1]}\n${exp}`))) return no(403, "not a valid link");
  const head = await env.SHARE_BUCKET.head(m[1]);
  if (!head) return no(404, "not found");
  const range = parseRange(req.headers.get("range"), head.size);
  if (range === "bad") return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${head.size}` } });
  const headers = { ...base, "content-type": "application/octet-stream", "content-disposition": "attachment", "accept-ranges": "bytes" };
  if (req.method === "HEAD") return new Response(null, { headers: { ...headers, "content-length": String(head.size) } });
  const o = await env.SHARE_BUCKET.get(m[1], range ? { range } : {});
  if (!o) return no(404, "not found");
  if (range) return new Response(o.body, { status: 206, headers: { ...headers, "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`, "content-length": String(range.length) } });
  return new Response(o.body, { headers: { ...headers, "content-length": String(head.size) } });
}
