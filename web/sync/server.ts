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

import { sessionOf, signedWith, type ShareEnv } from "../share/server.ts";
import { parseRange } from "../share/files.ts";
import { accountHash, fields, hmacHex, isNat, isSha, same, LIMITS, URL_MS, SyncError, type Result } from "./protocol.ts";
import { allowed, type SyncEnv } from "./env.ts";

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
  /** a test seam: the Worker's immediate delete after a failed finalize is off, so durability is shown without it */
  SYNC_TEST_NO_WORKER_DELETE?: string; SYNC_PREAUTH?: RateLimit; SYNC_FILES_LIMIT?: RateLimit; SYNC_ADMIN_LIMIT?: RateLimit; SYNC_SITE_ORIGIN?: string; LIMITS_KEY?: string };

/** An admin call's body: at most this many bytes (LIMIT-5E2-1). */
const ADMIN_BODY = 4096;
/**
 * Before any work on an admin call (LIMIT-5E2-1): the per-IP admin limit
 * (mandatory: without it, sync's admin routes are off), then, for a POST,
 * a declared Content-Length of at most ADMIN_BODY.  A refusal here reads no
 * body and calls no object and no database.
 */
async function adminGate(req: Request, env: Env): Promise<Response | null> {
  if (!env.SYNC_ADMIN_LIMIT || !env.SYNC_ACCOUNT) return err(404, "sync is not enabled here");
  if (!(await env.SYNC_ADMIN_LIMIT.limit({ key: req.headers.get("cf-connecting-ip") ?? "unknown" })).success) return err(429, "too many requests");
  if (req.method === "POST") {
    const cl = req.headers.get("content-length");
    if (cl === null) return err(411, "Content-Length is required");
    if (!/^\d{1,6}$/.test(cl) || Number(cl) < 1 || Number(cl) > ADMIN_BODY) return err(413, "bad request");
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

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
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
      await adminSyncPurge(req.clone(), env);
    }
    return null;
  }
  const sp = p.match(/^\/api\/admin\/sync-purge\/([0-9a-f-]{8,64})$/i);
  if (sp && req.method === "GET") return (await adminGate(req, env)) ?? adminSyncPurgeStatus(req, env, sp[1]);
  if (!p.startsWith("/api/sync/")) return null;
  // (the pre-authentication limit is part of the flag: without it, sync is off, LIMIT-321-1)
  if (!env.SYNC_ACCOUNT || !env.SYNC_DOC || !env.SHARE_DB || !env.SYNC_PREAUTH) return err(404, "sync is not enabled here");
  // before anything that reads a session: one limit per IP, whatever the request claims
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.SYNC_PREAUTH.limit({ key: ip })).success) return err(429, "too many requests");
  const m = req.method;
  // every sync request is state-changing or a socket: both come only from this site's pages
  if (!sameSite(req)) return err(403, "cross-site request");
  const who = await sessionOf(req, env);
  if (!who) return err(401, "sign in first");
  if (!allowed(env, who.id)) return err(403, "sync isn't enabled for this account");
  const hash = await accountHash(who.id);
  const stub = env.SYNC_ACCOUNT.get(env.SYNC_ACCOUNT.idFromName("acct:" + hash));
  if (p === "/api/sync/v1/enable" && m === "POST") {
    // (a purge still running, or the account's record says it is being deleted: not yet)
    const rec = await env.SHARE_DB.prepare("SELECT state FROM sync_accounts WHERE account_hash = ?1").bind(hash).first<{ state: string }>();
    if (rec?.state === "deleting") return err(409, "deleting", { message: "this account's synced data is still being deleted" });
    let reg: { state: string; generation: number } | null = null;
    // The account is registered in D1 first, and only then given storage (CORR-00F-1): the daily
    // inventory finds an account's objects by this row, so an account object that could take writes
    // without it would see its own files deleted.  A failure here leaves no storage at all; a row
    // whose account object then fails to start holds nothing, which is harmless.
    try {
      if (env.SYNC_TEST_FAIL_ENROLL && env.SYNC_TEST_FAIL_ENROLL === who.id) throw new Error("D1 unavailable (test seam)");
      // (generation 1 for a new row; a purged one made active again gets the next; an active row keeps its own)
      await env.SHARE_DB.prepare("INSERT INTO sync_accounts (account_hash, prefix, state, created, generation) VALUES (?1, substr(?1, 1, 32), 'active', ?2, 1) ON CONFLICT(account_hash) DO UPDATE SET state = 'active', request_id = NULL, kind = NULL, finished = NULL, docs = NULL, bytes = NULL, generation = sync_accounts.generation + 1 WHERE sync_accounts.state = 'purged'").bind(hash, Math.floor(Date.now() / 1000)).run();
      reg = await env.SHARE_DB.prepare("SELECT state, generation FROM sync_accounts WHERE account_hash = ?1").bind(hash).first<{ state: string; generation: number }>();
      if (reg?.state !== "active") return err(409, "deleting", { message: "this account's synced data is still being deleted" });
    } catch {
      return err(503, "busy", { message: "turning sync on didn't finish; try again" });
    }
    // (a test seam: the registration's answer is held here, before the account object is reached, as
    // astra's first-enable trace holds it; the test then sends what it would, CORR-A62-1)
    if (env.SYNC_TEST_HOLD_ENABLE && env.SYNC_TEST_HOLD_ENABLE === who.id) return json({ held: reg.generation });
    // (the account object checks the generation against its own, and against the highest it has
    // retired: a purge since this read, or any number of them, refuses it)
    return answer(await stub.enable({ account: who.id, hash, generation: reg.generation }), json);
  }
  if (p === "/api/sync/v1/delete" && m === "POST") {
    const b = (await req.json().catch(() => null)) as { confirm?: unknown } | null;
    if (b?.confirm !== "delete") return err(400, "invalid", { message: 'send {"confirm": "delete"}' });
    const rid = crypto.randomUUID();
    await env.SHARE_DB.prepare("UPDATE sync_accounts SET state = 'deleting', request_id = ?2, kind = 'self' WHERE account_hash = ?1 AND state = 'active'").bind(hash, rid).run();
    // (the registered generation goes to the purge, which retires it even if the account object has
    // no storage yet: an enable of it still on its way is then refused, CORR-A62-1)
    const g = await env.SHARE_DB.prepare("SELECT state, generation FROM sync_accounts WHERE account_hash = ?1").bind(hash).first<{ state: string; generation: number }>();
    return json(await stub.purge({ request_id: rid, kind: "self", hash, ...(g?.state === "deleting" ? { generation: g.generation } : {}) }), 202);
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
    return answer(await stub.missing({ account: who.id, blobs }), (missing) => json({ missing }));
  }
  const g = p.match(/^\/api\/sync\/v1\/blob\/([0-9a-f]{64})$/);
  if (g && m === "PUT") return putBlob(req, env, stub, who.id, g[1]);
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

/** Sync's part of CoCalc's signed purge (§9): the account object deletes everything it holds. */
async function adminSyncPurge(req: Request, env: Env): Promise<void> {
  const body = await readBounded(req, ADMIN_BODY);
  if (body === null || !(await signedWith(req, env.PURGE_KEY, body))) return;
  let v: { request_id?: unknown; account_id?: unknown };
  try {
    v = JSON.parse(body);
  } catch {
    return;
  }
  if (typeof v.account_id !== "string" || !v.account_id || v.account_id.length > 100 || typeof v.request_id !== "string" || !/^[0-9a-f-]{8,64}$/i.test(v.request_id)) return;
  const hash = await accountHash(v.account_id);
  const rec = await env.SHARE_DB!.prepare("SELECT state FROM sync_accounts WHERE account_hash = ?1").bind(hash).first<{ state: string }>();
  if (!rec) return; // (never synced: nothing to delete)
  await env.SHARE_DB!.prepare("UPDATE sync_accounts SET state = 'deleting', request_id = ?2, kind = 'admin' WHERE account_hash = ?1 AND state <> 'purged'").bind(hash, v.request_id).run();
  const g = await env.SHARE_DB!.prepare("SELECT state, generation FROM sync_accounts WHERE account_hash = ?1").bind(hash).first<{ state: string; generation: number }>();
  await env.SYNC_ACCOUNT!.get(env.SYNC_ACCOUNT!.idFromName("acct:" + hash)).purge({ request_id: v.request_id, kind: "admin", hash, ...(g?.state === "deleting" ? { generation: g.generation } : {}) });
}

/** GET /api/admin/sync-purge/<request_id> (signed): where sync's part of a purge is. */
async function adminSyncPurgeStatus(req: Request, env: Env, rid: string): Promise<Response> {
  if (!env.SHARE_DB || !(await signedWith(req, env.PURGE_KEY, ""))) return err(401, "bad signature");
  const r = await env.SHARE_DB.prepare("SELECT state, docs, bytes FROM sync_accounts WHERE request_id = ?1").bind(rid).first();
  return r ? json({ request_id: rid, ...r }) : err(404, "no such request");
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
export async function syncScheduled(env: Env): Promise<{ pages: number; checked: number; deleted: number; calls: number }> {
  const out = { pages: 0, checked: 0, deleted: 0, calls: 0 };
  if (!env.SYNC_ACCOUNT || !env.SHARE_DB || !env.SHARE_BUCKET) return out;
  const db = env.SHARE_DB;
  const test = !!env.SYNC_TEST_PIN_MS;
  const [page, pages] = test ? [50, 2] : [INVENTORY_PAGE, INVENTORY_PAGES];
  const old = Date.now() - (test ? 1000 : INVENTORY_AGE_MS);
  // (a bound on the calls a run makes, LIMIT-268-1: a page is begun only if its worst case still fits)
  const worst = 2 + 1 + page + 1;
  for (let n = 0; n < pages && out.calls + worst <= INVENTORY_CALLS; n++) {
    const at = await db.prepare("SELECT v FROM meta WHERE k = 'sync_inventory_cursor'").first<{ v: string }>();
    const l = await env.SHARE_BUCKET.list({ prefix: "s/", limit: page, ...(at?.v ? { cursor: at.v } : {}) });
    out.calls += 2;
    const byPrefix = new Map<string, string[]>();
    for (const o of l.objects) {
      if (new Date(o.uploaded).valueOf() > old) continue;
      const p = o.key.split("/")[1] ?? "";
      byPrefix.set(p, [...(byPrefix.get(p) ?? []), o.key]);
    }
    const known = new Set<string>();
    if (byPrefix.size) {
      // one lookup for the whole page, by the indexed prefix
      const accounts = (await db.prepare("SELECT account_hash, prefix, state FROM sync_accounts WHERE prefix IN (SELECT value FROM json_each(?1))").bind(JSON.stringify([...byPrefix.keys()])).all<{ account_hash: string; prefix: string; state: string }>()).results;
      out.calls++;
      // one call to each live account the page names, with its keys
      for (const a of accounts) {
        if (a.state === "purged") continue;
        for (const k of (await env.SYNC_ACCOUNT.get(env.SYNC_ACCOUNT.idFromName("acct:" + a.account_hash)).knownKeys({ keys: byPrefix.get(a.prefix) ?? [] })).known) known.add(k);
        out.calls++;
      }
      // one delete for the page
      const gone = [...byPrefix.values()].flat().filter((k) => !known.has(k));
      if (gone.length) {
        await env.SHARE_BUCKET.delete(gone);
        out.calls++;
        out.deleted += gone.length;
      }
    }
    // (the cursor moves only past a page done in full)
    await db.prepare("INSERT INTO meta (k, v) VALUES ('sync_inventory_cursor', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1").bind(l.truncated ? (l.cursor ?? "") : "").run();
    out.pages++;
    out.checked += l.objects.length;
    if (!l.truncated) break;
  }
  return out;
}
/** The inventory's pages: objects in each, at most this many a run, and at most this many calls a run (LIMIT-268-1). */
const INVENTORY_PAGE = 100, INVENTORY_PAGES = 5, INVENTORY_CALLS = 400;
/** How old an object must be before the inventory may delete it: far beyond any upload's reservation. */
const INVENTORY_AGE_MS = 2 * 86400_000;

/**
 * An upload (§5.4): reserve, stream to R2 with the SHA-256 for R2 to
 * check, and finalize.  A failure between the two gives the reservation
 * and the object back at once (the alarm and the inventory catch the rest).
 */
async function putBlob(req: Request, env: Env, stub: ReturnType<NonNullable<Env["SYNC_ACCOUNT"]>["get"]>, account: string, sha256: string): Promise<Response> {
  const len = req.headers.get("content-length");
  if (!len || !/^\d{1,12}$/.test(len)) return err(411, "Content-Length is required");
  const size = Number(len);
  const r = await stub.reserve({ account, sha256, size });
  if ("error" in r) return answer(r, json);
  if ("have" in r.ok) return json({ sha256, have: true });
  const { id, key, expires } = r.ok;
  // The reservation's end is enforced on the upload itself (CORR-5E2-2): the body streams to R2
  // through a stream that is aborted a margin before it, and R2 makes an object only from a put that
  // completes.  So once a reservation has ended, no write of its key can still appear: a put that
  // finished in time is finalized, or its key is deleted when the reservation ends; one that didn't
  // never exists.
  const deadline = expires - (env.SYNC_TEST_PIN_MS ? 1000 : PUT_MARGIN_MS);
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
  if ("error" in f && !env.SYNC_TEST_NO_WORKER_DELETE) await env.SHARE_BUCKET!.delete(key).catch(() => {});
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
