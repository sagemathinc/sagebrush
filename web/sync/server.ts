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

import { sessionOf, type ShareEnv } from "../share/server.ts";
import { parseRange } from "../share/files.ts";
import { accountHash, fields, hmacHex, isNat, isSha, same, LIMITS, URL_MS, SyncError, type Result } from "./protocol.ts";
import { allowed, type SyncEnv } from "./env.ts";

export interface RateLimit { limit(o: { key: string }): Promise<{ success: boolean }> }
export type Env = SyncEnv & ShareEnv & { SYNC_PREAUTH?: RateLimit; SYNC_FILES_LIMIT?: RateLimit; SYNC_SITE_ORIGIN?: string };

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

const STATUS: Partial<Record<SyncError["code"], number>> = { forbidden: 403, deleting: 409, readonly: 409, invalid: 400, limit: 413, rate: 429, busy: 503, missing: 404, storage_full: 507 };

/** The sync API's response to req, or null if req is not for it. */
export async function handleSync(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  // signing out ends the session's sync sockets too, before sharing deletes the session (§2)
  if (p === "/auth/logout" && req.method === "POST") {
    if (env.SYNC_ACCOUNT && env.SHARE_DB && req.headers.get("origin") === url.origin) {
      const who = await sessionOf(req, env);
      if (who) await env.SYNC_ACCOUNT.get(env.SYNC_ACCOUNT.idFromName("acct:" + (await accountHash(who.id)))).revoke({ session: who.session, expires: who.expires * 1000 }).catch(() => {});
    }
    return null;
  }
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
    return answer(await stub.enable({ account: who.id, hash }), json);
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
  const { id, key } = r.ok;
  let stored: { size: number } | null = null;
  try {
    stored = await env.SHARE_BUCKET!.put(key, req.body!, { sha256 });
  } catch {
    stored = null;
  }
  // (R2 checks the SHA-256, and the runtime ends a request whose body isn't its Content-Length, so a
  // stored size that differs is not expected; it is still checked, a second line, LIMIT-7FB-4)
  if (!stored || stored.size !== size) {
    await stub.abandon({ id });
    return err(400, "invalid", { message: "the bytes don't match their SHA-256 or their length" });
  }
  return answer(await stub.finalize({ account, id, size: stored.size }), (v) => json(v, 201));
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
