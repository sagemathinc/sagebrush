// Shared collections: the API on sagebrush.space (design/sharing.md).
//
//   GET  /auth/login?return=/path      sign in with CoCalc (code + PKCE)
//   GET  /auth/callback                CoCalc sends the user back here
//   POST /auth/logout
//   POST /auth/dev                     dev only: a session for a test account
//   GET  /api/share/me                 who you are, your usage and limits
//   GET  /api/share/mine               your collections
//   POST /api/share/first-upload       {title, license, files, attempt} -> {collection, version}: a
//                                      new share, created with its first version (its own path: a
//                                      server from before it answers 404 and creates nothing)
//   POST /api/share/collections        {title} -> {id}: an older page's empty collection, kept for
//                                      now (it is left empty when its upload fails); with files: 400
//   POST /api/share/check              {blobs: [{sha256, size}]} -> {missing}
//   PUT  /api/share/blob/<sha256>      the bytes (R2 checks the hash)
//   POST /api/share/collections/<id>/versions   {title, license, files} -> {version}
//   GET  /api/share/c/<id>[?at=hash]   a collection's (latest) manifest
//   DELETE /api/share/collections/<id> delete a collection and its files
//   POST /api/share/delete-everything  {confirm: "delete"}: all of yours
//   POST /api/admin/purge              CoCalc: an account was deleted (signed)
//   GET  /api/admin/purge/<request_id> (signed)
//
// How storage stays consistent (D1 and R2 can't share a transaction):
//
// - Every upload is its own R2 object, a/<sha256(account_id)>/<random>, so
//   no object is ever shared between accounts or uploads: deleting one can
//   never remove bytes someone else (or a later upload) relies on.
//   Deduplication is per account (holdings), so nobody can learn whether
//   someone else has a file.
// - Bytes are reserved before they go to R2, by one conditional INSERT that
//   counts the account's files, manifests and other reservations: concurrent
//   uploads can't all pass one check.  Manifests count too.
// - A write that depends on a check made earlier ends in one D1 batch (a
//   transaction) with a guard row that fails, rolling the batch back, if the
//   check no longer holds (the account is being deleted, a file is no longer
//   held, the collection is gone).
// - An R2 object D1 stops referencing goes into the r2_deletes outbox in the
//   same batch, and leaves the outbox only once R2 has deleted it.  An object
//   written to R2 whose D1 write then failed is found from its expired
//   reservation.  So a failure anywhere leaves a state the scheduled job
//   finishes.
// - Deleting an account first marks it deleting (no sessions, no writes, in
//   the same batch that drops its sessions), then deletes its rows, then
//   everything under its R2 prefix; an account deleted in CoCalc keeps a
//   tombstone (by hash) so it never signs in again.
//
// Files are read from the user-content domain (web/share/files.ts) only
// through a collection: /c/<collection>/<sha256>, for files of its versions.

export interface D1Result<T> { results: T[]; meta?: { changes?: number } }
export interface D1Stmt {
  bind(...v: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
}
export interface D1 { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<unknown[]> }
export interface R2Obj { size: number; body: ReadableStream }
export interface R2 {
  put(key: string, body: ReadableStream | ArrayBuffer | string, opts?: Record<string, unknown>): Promise<{ size: number } | null>;
  get(key: string, opts?: Record<string, unknown>): Promise<R2Obj | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(opts: { prefix: string; limit?: number; cursor?: string }): Promise<{ objects: { key: string; uploaded: Date }[]; truncated: boolean; cursor?: string }>;
}
export interface ShareEnv {
  SHARE_DB?: D1;
  SHARE_BUCKET?: R2;
  /** e.g. https://cocalc.ai; with no origin, sign-in is off */
  COCALC_ORIGIN?: string;
  COCALC_CLIENT_SECRET?: string;
  /** signs the sign-in state cookie */
  SESSION_KEY?: string;
  /** shared with CoCalc: signs admin calls */
  PURGE_KEY?: string;
  /** where shared files are served, e.g. https://files.cocalcusercontent.com */
  FILES_ORIGIN?: string;
  /** dev deployments only: "1" enables /auth/dev and default limits */
  SHARE_DEV?: string;
  DEV_AUTH_TOKEN?: string;
  /**
   * The sync service's account objects, when sync is on here: one storage
   * budget covers both (design/sync-server.md §6.1), so sharing counts the
   * bytes sync has claimed, and asks sync to give back what it doesn't use.
   */
  SYNC_ACCOUNT?: { idFromName(name: string): unknown; get(id: unknown): SyncClaims };
}
/** What sharing asks of a sync account object (web/sync/account.ts). */
export interface SyncClaims {
  releaseClaim(a: { account: string }): Promise<{ released: number }>;
  usage(a: { account: string }): Promise<{ files: number; documents: number; claim: number; retention?: { state: string; readonly_since: number | null; purge_after: number | null } } | null>;
}
interface Ctx { waitUntil(p: Promise<unknown>): void }

export interface Limits { storage_bytes: number; max_file_bytes: number; private_links: boolean; tier?: string }

const DAY = 86400;
const SESSION_DAYS = 30;
/** sessions an account may have at once (the oldest go: a sign-in loop can't pile them up) */
const SESSIONS_MAX = 20;
/** records of finished deletions: how long (collections and self-deletions; account deletions), and at most how many collection records per account */
const DELETION_RECORD_DAYS = 30, ADMIN_RECORD_DAYS = 365, DELETION_RECORDS_MAX = 1000;
/**
 * Deleted shares' receipts kept per account (beside its live ones), newest first: a retry of a deleted
 * share's attempt gets 410 for DELETION_RECORD_DAYS, or until the account has deleted this many newer
 * shares; after either, it makes a new share with a new id (the deleted link stays dead).  So the table
 * holds at most MAX_COLLECTIONS + RETIRED_RECEIPTS_MAX rows per account, however fast shares are made
 * and deleted (daybreak3's S1).
 */
const RETIRED_RECEIPTS_MAX = 1000;
/** the deleted shares' receipts past their days, removed per scheduled run: pages of 500, until none is left or this many */
const RETIRED_RECEIPT_PAGES = 20;
const LIMITS_TTL = 600;
/** how long an upload may take before its reservation is reclaimed */
const RESERVE_SECONDS = 3600;
/** a Worker can't take a request body over 100 MB; larger files will go up in parts */
export const MAX_PUT = 95 * 1024 * 1024;
export const MAX_FILES = 10000;
export const MAX_COLLECTIONS = 1000;
export const MAX_VERSIONS = 1000;
const DEV_LIMITS: Limits = { tier: "dev", storage_bytes: 1 << 30, max_file_bytes: MAX_PUT, private_links: false };
const HEX64 = /^[0-9a-f]{64}$/;

const now = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder();

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const err = (status: number, error: string) => json({ error }, status);

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const b = typeof data === "string" ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", b));
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export function newId(): string {
  const a = "abcdefghijklmnopqrstuvwxyz234567";
  return [...random(12)].map((x) => a[x & 31]).join("");
}
/** An account's R2 prefix: by hash, so a tombstone (a hash) still finds it. */
const prefixOf = async (account: string) => `a/${(await sha256Hex("sagebrush-account\n" + account)).slice(0, 32)}/`;
const accountHash = (account: string) => sha256Hex("sagebrush-account\n" + account);
const newKey = async (account: string) => (await prefixOf(account)) + b64url(random(18));

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
/** equal strings, in time independent of where they differ */
export function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** JSON with sorted keys and no spaces: a manifest's hash is the hash of this */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** A file's path in a collection: relative, plain segments, no "..". */
export function validPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 512) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

function cookies(req: Request): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return m;
}
const SESSION = "__Host-sb_session";
const OAUTH = "__Host-sb_oauth";
const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

/**
 * A path on this site to go back to after signing in, never another site:
 * parsed against this origin (as a browser would resolve it: tabs and
 * newlines removed, \ as /), accepted only if it stays on it.
 */
export function returnPath(p: string | null, origin: string): string {
  if (!p || p.length > 1000 || /[\u0000- \u007f\\]/.test(p) || !p.startsWith("/") || p.startsWith("//")) return "/";
  try {
    const u = new URL(p, origin);
    // (and checked again as normalized: /%2e%2e//host is //host, another site, SEC-SHARE-1)
    const out = u.pathname + u.search + u.hash;
    return u.origin === origin && out.startsWith("/") && !out.startsWith("//") ? out : "/";
  } catch {
    return "/";
  }
}

const ph = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(",");
/** Statements of a batch that fail it (rolling it back) unless `cond` (SQL) holds. */
const guard = (db: D1, cond: string, ...binds: unknown[]) => [
  db.prepare(`INSERT INTO guard (x) SELECT CASE WHEN ${cond} THEN 1 ELSE NULL END`).bind(...binds),
  db.prepare("DELETE FROM guard"),
];
/**
 * Who a request is: the account, and the session it authenticated with.
 * Every write checks, inside its transaction, that this exact session still
 * exists for an account not being deleted (live()): purge drops the sessions
 * first, so a request already past its first check can't write afterwards.
 */
interface Who { id: string; session: string }
const LIVE = "EXISTS (SELECT 1 FROM sessions s JOIN accounts a ON a.account_id = s.account_id WHERE s.token_hash = ?2 AND s.account_id = ?1 AND s.expires > ?3 AND a.deleting IS NULL)";
const live = (db: D1, who: Who) => guard(db, LIVE, who.id, who.session, now());

// ---- sessions

async function account(req: Request, env: ShareEnv): Promise<Who | null> {
  const t = cookies(req).get(SESSION);
  if (!t || !env.SHARE_DB) return null;
  const session = await sha256Hex(t);
  const row = await env.SHARE_DB.prepare("SELECT s.account_id FROM sessions s JOIN accounts a ON a.account_id = s.account_id WHERE s.token_hash = ?1 AND s.expires > ?2 AND a.deleting IS NULL").bind(session, now()).first<{ account_id: string }>();
  return row ? { id: row.account_id, session } : null;
}

/**
 * The session a request carries, with its expiry (seconds), for the sync
 * service (web/sync/server.ts), which authenticates exactly as sharing does.
 */
export async function sessionOf(req: Request, env: ShareEnv): Promise<{ id: string; session: string; expires: number } | null> {
  const t = cookies(req).get(SESSION);
  if (!t || !env.SHARE_DB) return null;
  const session = await sha256Hex(t);
  const row = await env.SHARE_DB.prepare("SELECT s.account_id, s.expires FROM sessions s JOIN accounts a ON a.account_id = s.account_id WHERE s.token_hash = ?1 AND s.expires > ?2 AND a.deleting IS NULL").bind(session, now()).first<{ account_id: string; expires: number }>();
  return row ? { id: row.account_id, session, expires: row.expires } : null;
}

/** A session cookie, or null if the account is being deleted or was deleted in CoCalc. */
async function startSession(env: ShareEnv, who: { account_id: string; email?: string; name?: string }): Promise<string | null> {
  const db = env.SHARE_DB!;
  const token = b64url(random(32));
  const t = now();
  const h = await accountHash(who.account_id);
  try {
    await db.batch([
      ...guard(db, `NOT EXISTS (SELECT 1 FROM tombstones WHERE account_hash = ?1) AND NOT EXISTS (SELECT 1 FROM accounts WHERE account_id = ?2 AND deleting IS NOT NULL)`, h, who.account_id),
      db.prepare("INSERT INTO accounts (account_id, email, name, created, last_login) VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT(account_id) DO UPDATE SET email = ?2, name = ?3, last_login = ?4").bind(who.account_id, who.email ?? null, who.name ?? null, t),
      db.prepare("INSERT INTO sessions (token_hash, account_id, created, expires) VALUES (?1, ?2, ?3, ?4)").bind(await sha256Hex(token), who.account_id, t, t + SESSION_DAYS * DAY),
      // (at most SESSIONS_MAX per account: the oldest go, HARD-SHARE-3)
      db.prepare("DELETE FROM sessions WHERE account_id = ?1 AND rowid NOT IN (SELECT rowid FROM sessions WHERE account_id = ?1 ORDER BY created DESC, rowid DESC LIMIT ?2)").bind(who.account_id, SESSIONS_MAX),
    ]);
  } catch {
    return null;
  }
  return cookie(SESSION, token, SESSION_DAYS * DAY);
}

// ---- sign in with CoCalc (authorization code with PKCE)

async function login(req: Request, env: ShareEnv): Promise<Response> {
  if (!env.COCALC_ORIGIN || !env.SESSION_KEY) return err(404, "sign-in is not configured");
  const url = new URL(req.url);
  const state = b64url(random(16));
  const verifier = b64url(random(32));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
  const payload = b64url(enc.encode(JSON.stringify({ state, verifier, ret: returnPath(url.searchParams.get("return"), url.origin), exp: now() + 600 })));
  const signed = `${payload}.${await hmac(env.SESSION_KEY, "oauth\n" + payload)}`;
  const to = new URL("/auth/oauth/authorize", env.COCALC_ORIGIN);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: "sagebrush", redirect_uri: `${url.origin}/auth/callback`, state, code_challenge: challenge, code_challenge_method: "S256" })) to.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: to.toString(), "set-cookie": cookie(OAUTH, signed, 600), "cache-control": "no-store" } });
}

async function callback(req: Request, env: ShareEnv): Promise<Response> {
  if (!env.COCALC_ORIGIN || !env.SESSION_KEY || !env.COCALC_CLIENT_SECRET || !env.SHARE_DB) return err(404, "sign-in is not configured");
  const url = new URL(req.url);
  const raw = cookies(req).get(OAUTH) ?? "";
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !same(sig, await hmac(env.SESSION_KEY, "oauth\n" + payload))) return err(400, "sign-in expired; try again");
  const st = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
  const clear = cookie(OAUTH, "", 0);
  if (st.exp < now() || !same(st.state, url.searchParams.get("state") ?? "")) return err(400, "sign-in expired; try again");
  // (checked again: the cookie was written by this code, but never trust a path twice removed)
  const ret = returnPath(st.ret, url.origin);
  if (url.searchParams.get("error")) return new Response(null, { status: 302, headers: { location: ret, "set-cookie": clear } });
  const code = url.searchParams.get("code");
  if (!code) return err(400, "no code");
  const r = await fetch(new URL("/api/v2/auth/oauth/token", env.COCALC_ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + btoa("sagebrush:" + env.COCALC_CLIENT_SECRET) },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${url.origin}/auth/callback`, code_verifier: st.verifier }),
  });
  if (!r.ok) return err(502, "CoCalc refused the sign-in");
  const who = (await r.json()) as { account_id?: string; email?: string; email_verified?: boolean; name?: string };
  if (typeof who.account_id !== "string" || !who.account_id || who.account_id.length > 100 || who.email_verified !== true) return err(403, "a verified email is required");
  const session = await startSession(env, who as { account_id: string });
  if (!session) return err(403, "this account can't sign in to share files");
  const h = new Headers({ location: ret, "cache-control": "no-store" });
  h.append("set-cookie", clear);
  h.append("set-cookie", session);
  return new Response(null, { status: 302, headers: h });
}

// ---- limits, from CoCalc's membership tiers

async function limits(env: ShareEnv, who: Who): Promise<Limits | null> {
  const db = env.SHARE_DB!;
  const id = who.id;
  const c = await db.prepare("SELECT limits, fetched FROM limits_cache WHERE account_id = ?1").bind(id).first<{ limits: string; fetched: number }>();
  if (c && c.fetched > now() - LIMITS_TTL) return JSON.parse(c.limits);
  if (!env.COCALC_ORIGIN || !env.COCALC_CLIENT_SECRET) return env.SHARE_DEV === "1" ? DEV_LIMITS : null;
  try {
    const u = new URL("/api/v2/sagebrush/limits", env.COCALC_ORIGIN);
    u.searchParams.set("account_id", id);
    const r = await fetch(u, { headers: { authorization: "Basic " + btoa("sagebrush:" + env.COCALC_CLIENT_SECRET) }, signal: AbortSignal.timeout(5000) });
    if (r.status === 404) return null; // no such account: no uploads
    if (!r.ok) throw new Error(String(r.status));
    const v = (await r.json()) as Limits;
    if (!Number.isSafeInteger(v.storage_bytes) || !Number.isSafeInteger(v.max_file_bytes)) throw new Error("bad limits");
    const l: Limits = { tier: String(v.tier ?? ""), storage_bytes: v.storage_bytes, max_file_bytes: v.max_file_bytes, private_links: v.private_links === true };
    // (cached only while the session is live: never a row for a deleted account)
    await db.batch([...live(db, who), db.prepare("INSERT INTO limits_cache (account_id, limits, fetched) VALUES (?1, ?2, ?3) ON CONFLICT(account_id) DO UPDATE SET limits = ?2, fetched = ?3").bind(id, JSON.stringify(l), now())]).catch(() => {});
    return l;
  } catch {
    // CoCalc is unreachable: keep what we had, never read it as zero
    return c ? JSON.parse(c.limits) : null;
  }
}

// (SQL: what sharing holds for account ?1, reservations still running at ?2 included; the sync
// service's claim on the same budget, CLAIM, is added where sync is on)
export const SHARING_USED = `(SELECT COALESCE(SUM(size), 0) FROM holdings WHERE account_id = ?1)
  + (SELECT COALESCE(SUM(manifest_bytes), 0) FROM versions WHERE owner = ?1)
  + (SELECT COALESCE(SUM(bytes), 0) FROM reservations WHERE account_id = ?1 AND expires > ?2)`;
/** sharing's clock, in seconds (reservations' expiry) */
export const nowSeconds = () => now();
// (the bytes sync has claimed of account ?8's budget (its hash): every byte of it may be in use, so
// sharing counts all of it; once documents have taken sync into its ceiling, sharing is already over
// and refuses, §6.1)
const CLAIM = ` + (SELECT COALESCE(SUM(claim_bytes), 0) FROM sync_accounts WHERE account_hash = ?8 AND state <> 'purged')`;
// (without sync, ?8 is still named, adding nothing, so every caller binds the same parameters)
const used = (env: ShareEnv) => SHARING_USED + (env.SYNC_ACCOUNT ? CLAIM : " + 0 * COALESCE(length(?8), 0)");

/** What the account's budget has in use: sharing's bytes, and sync's claim where sync is on. */
async function usage(env: ShareEnv, id: string): Promise<number> {
  const r = await env.SHARE_DB!.prepare(`SELECT ${used(env)} AS n`).bind(id, now(), null, null, null, null, null, await accountHash(id)).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * The account's usage, and what each part holds (§6.1): sharing's files, its
 * versions' manifests, and sync's files and documents.  `usage` is their sum,
 * against the one storage_bytes.  For display only: what is enforced is the
 * claim (above).  If the account object can't be reached, sync's claim stands
 * in for its parts.
 */
async function breakdown(env: ShareEnv, id: string): Promise<{ usage: number; usage_breakdown: { sharing_files: number; sharing_versions: number; sync_files: number; sync_documents: number; sync_claim?: number }; sync_retention?: { state: string; readonly_since: number | null; purge_after: number | null } }> {
  const db = env.SHARE_DB!;
  const t = now();
  const s = await db.prepare("SELECT (SELECT COALESCE(SUM(size), 0) FROM holdings WHERE account_id = ?1) + (SELECT COALESCE(SUM(bytes), 0) FROM reservations WHERE account_id = ?1 AND expires > ?2) AS files, (SELECT COALESCE(SUM(manifest_bytes), 0) FROM versions WHERE owner = ?1) AS versions").bind(id, t).first<{ files: number; versions: number }>();
  const parts = { sharing_files: s?.files ?? 0, sharing_versions: s?.versions ?? 0, sync_files: 0, sync_documents: 0 } as { sharing_files: number; sharing_versions: number; sync_files: number; sync_documents: number; sync_claim?: number };
  let retention: { state: string; readonly_since: number | null; purge_after: number | null } | undefined;
  if (env.SYNC_ACCOUNT) {
    const h = await accountHash(id);
    const row = await db.prepare("SELECT claim_bytes FROM sync_accounts WHERE account_hash = ?1 AND state <> 'purged'").bind(h).first<{ claim_bytes: number }>();
    if (row) {
      try {
        const u = await env.SYNC_ACCOUNT.get(env.SYNC_ACCOUNT.idFromName("acct:" + h)).usage({ account: id });
        if (u) {
          parts.sync_files = u.files;
          parts.sync_documents = u.documents;
          // (after a membership ends: read-only, and when the synced data will be deleted, §6.2)
          retention = u.retention;
        }
      } catch {
        parts.sync_claim = row.claim_bytes;
      }
    }
  }
  return { usage: parts.sharing_files + parts.sharing_versions + parts.sync_files + parts.sync_documents + (parts.sync_claim ?? 0), usage_breakdown: parts, ...(retention ? { sync_retention: retention } : {}) };
}

/**
 * At the edge (§6.1): sharing was refused for space, so sync is asked once to
 * give back the part of its claim it doesn't use.  True if it gave back any,
 * and the caller may try once more; false if there was none, sync isn't on
 * here, or its account object couldn't be reached (the refusal then stands:
 * never fail open).
 */
async function releaseSync(env: ShareEnv, id: string): Promise<boolean> {
  if (!env.SYNC_ACCOUNT) return false;
  try {
    const h = await accountHash(id);
    if (!(await env.SHARE_DB!.prepare("SELECT 1 AS x FROM sync_accounts WHERE account_hash = ?1 AND state <> 'purged' AND claim_bytes > 0").bind(h).first())) return false;
    return (await env.SYNC_ACCOUNT.get(env.SYNC_ACCOUNT.idFromName("acct:" + h)).releaseClaim({ account: id })).released > 0;
  } catch {
    return false;
  }
}

/** Reserve bytes for an R2 object about to be written: one conditional INSERT. */
async function reserve(env: ShareEnv, who: Who, bytes: number, limit: number, key: string, again = true): Promise<{ id: string; expires: number } | null> {
  const db = env.SHARE_DB!;
  const rid = crypto.randomUUID();
  const t = now();
  const h = await accountHash(who.id);
  try {
    const r = (await db.batch([...live(db, who), db.prepare(`INSERT INTO reservations (id, account_id, bytes, key, expires) SELECT ?3, ?1, ?4, ?5, ?6 WHERE ${used(env)} + ?4 <= ?7`).bind(who.id, t, rid, bytes, key, t + RESERVE_SECONDS, limit, h)])) as D1Result<unknown>[];
    if (r[2]?.meta?.changes === 1) return { id: rid, expires: t + RESERVE_SECONDS };
  } catch {
    return null;
  }
  // (refused for space: sync gives back what it doesn't use, and this is tried once more, §6.1)
  return again && (await releaseSync(env, who.id)) ? reserve(env, who, bytes, limit, key, false) : null;
}
/** Batch statements that use up the reservation, failing the batch if it expired or was reclaimed. */
const consume = (db: D1, rid: string) => [
  ...guard(db, "EXISTS (SELECT 1 FROM reservations WHERE id = ?1 AND expires > ?2)", rid, now()),
  db.prepare("DELETE FROM reservations WHERE id = ?1").bind(rid),
];

/** An R2 write whose D1 write failed: undo it now if possible (else the scheduled job does). */
async function abandon(env: ShareEnv, key: string, rid: string) {
  try {
    await env.SHARE_BUCKET!.delete(key);
    await env.SHARE_DB!.prepare("DELETE FROM reservations WHERE id = ?1").bind(rid).run();
  } catch {}
}

// ---- uploading

async function check(req: Request, env: ShareEnv, who: Who): Promise<Response> {
  const id = who.id;
  const body = (await req.json().catch(() => null)) as { blobs?: { sha256: string; size: number }[] } | null;
  const blobs = body?.blobs;
  if (!Array.isArray(blobs) || blobs.length > MAX_FILES || !blobs.every((b) => b && HEX64.test(b.sha256) && Number.isSafeInteger(b.size) && b.size >= 0)) return err(400, "bad request");
  const lim = await limits(env, who);
  if (!lim) return err(403, "uploads need a CoCalc account in good standing");
  const max = Math.min(lim.max_file_bytes, MAX_PUT);
  const big = blobs.find((b) => b.size > max);
  if (big) return json({ error: "file too large", sha256: big.sha256, max_file_bytes: max }, 413);
  const held = new Set<string>();
  for (let i = 0; i < blobs.length; i += 90) {
    const part = blobs.slice(i, i + 90).map((b) => b.sha256);
    const r = await env.SHARE_DB!.prepare(`SELECT sha256 FROM holdings WHERE account_id = ?1 AND sha256 IN (${ph(part.length, 2)})`).bind(id, ...part).all<{ sha256: string }>();
    for (const x of r.results) held.add(x.sha256);
  }
  const missing = [...new Map(blobs.filter((b) => !held.has(b.sha256)).map((b) => [b.sha256, b])).values()];
  // (advisory: each PUT reserves its bytes atomically; at the edge, sync gives back what it doesn't
  // use first, §6.1)
  const adding = missing.reduce((s, b) => s + b.size, 0);
  let inUse = await usage(env, id);
  if (inUse + adding > lim.storage_bytes && (await releaseSync(env, id))) inUse = await usage(env, id);
  if (inUse + adding > lim.storage_bytes) return json({ error: "over your storage limit", used: inUse, adding, storage_bytes: lim.storage_bytes }, 413);
  return json({ missing: missing.map((b) => b.sha256) });
}

async function putBlob(req: Request, env: ShareEnv, who: Who, sha: string): Promise<Response> {
  const id = who.id;
  const cl = req.headers.get("content-length");
  if (!cl || !/^\d{1,12}$/.test(cl)) return err(411, "content-length required");
  const size = Number(cl);
  const lim = await limits(env, who);
  if (!lim) return err(403, "uploads need a CoCalc account in good standing");
  if (size > Math.min(lim.max_file_bytes, MAX_PUT)) return err(413, "file too large");
  const db = env.SHARE_DB!;
  if (await db.prepare("SELECT 1 AS x FROM holdings WHERE account_id = ?1 AND sha256 = ?2").bind(id, sha).first()) return json({ ok: true });
  const key = await newKey(id);
  const res = await reserve(env, who, size, lim.storage_bytes, key);
  if (!res) return err(413, "over your storage limit");
  const rid = res.id;
  let obj: { size: number } | null = null;
  try {
    // R2 refuses the upload unless the bytes hash to sha
    obj = await env.SHARE_BUCKET!.put(key, req.body ?? new ArrayBuffer(0), { sha256: sha, httpMetadata: { contentType: "application/octet-stream" } });
  } catch {}
  if (!obj || obj.size !== size) {
    await abandon(env, key, rid);
    return err(400, obj ? "the file's size is not its content-length" : "the file's SHA-256 does not match");
  }
  // (an upload outlives its reservation: the scheduled job may reclaim it, so this one is abandoned)
  if (now() >= res.expires) {
    await abandon(env, key, rid);
    return err(408, "the upload took too long; try again");
  }
  const t = now();
  try {
    await db.batch([
      ...live(db, who),
      ...consume(db, rid),
      // (the same file uploaded twice at once: this copy is not needed)
      db.prepare("INSERT INTO r2_deletes (key, created) SELECT ?3, ?4 WHERE EXISTS (SELECT 1 FROM holdings WHERE account_id = ?1 AND sha256 = ?2)").bind(id, sha, key, t),
      db.prepare("INSERT INTO holdings (account_id, sha256, size, key, created) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING").bind(id, sha, size, key, t),
    ]);
  } catch {
    await abandon(env, key, rid);
    return err(403, "uploads need a CoCalc account in good standing");
  }
  return json({ ok: true });
}

async function createCollection(env: ShareEnv, who: Who, body: { title?: unknown } | null): Promise<Response> {
  const id = who.id;
  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 200) : "";
  if (!title) return err(400, "a title is required");
  if (!(await limits(env, who))) return err(403, "uploads need a CoCalc account in good standing");
  const cid = newId();
  const t = now();
  const db = env.SHARE_DB!;
  let r: D1Result<unknown>[];
  try {
    r = (await db.batch([...live(db, who), db.prepare("INSERT INTO collections (id, owner, title, created, updated) SELECT ?2, ?1, ?3, ?4, ?4 WHERE (SELECT COUNT(*) FROM collections WHERE owner = ?1) < ?5").bind(id, cid, title, t, MAX_COLLECTIONS)])) as D1Result<unknown>[];
  } catch {
    return err(401, "sign in first");
  }
  if (r[2]?.meta?.changes !== 1) return err(403, `at most ${MAX_COLLECTIONS} collections`);
  return json({ id: cid }, 201);
}

const LICENSE = /^[A-Za-z0-9.+\- ()]{1,64}$/;

const ATTEMPT = /^[0-9a-f]{32}$/;
const shareUrls = (cid: string, version: string) => ({ url: `/s/${cid}`, frozen: `/s/${cid}@${version.slice(0, 16)}` });

/** A new version of one of the account's collections. */
async function commit(req: Request, env: ShareEnv, who: Who, cid: string): Promise<Response> {
  const body = (await req.json().catch(() => null)) as CommitBody | null;
  return commitVersion(env, who, body, cid, null);
}

/**
 * A new share: its collection and its first version, in one transaction, with
 * the attempt's receipt (plan-upload-leak r3 §3b).  `attempt` is the page's
 * random 128 bits, kept with the notebook until the share is made: a retry of
 * it (its response lost, the page reloaded) is answered from the receipt.
 */
async function firstUpload(env: ShareEnv, who: Who, body: CommitBody & { attempt?: unknown }): Promise<Response> {
  if (typeof body.title !== "string" || !body.title.trim()) return err(400, "a title is required");
  if (typeof body.attempt !== "string" || !ATTEMPT.test(body.attempt)) return err(400, "attempt: 32 hex digits");
  return commitVersion(env, who, body, null, body.attempt);
}

/**
 * What a retry of an attempt gets, if the attempt made a share already: its
 * own version (not the share's latest) when it asks for the same contents; a
 * 409 naming that share when it asks for other contents (never a success:
 * the share holds what the first request sent); a 410 once the share was
 * deleted.  Null when the attempt made nothing yet.
 */
async function replay(env: ShareEnv, owner: string, attemptHash: string, digest: string): Promise<Response | null> {
  const db = env.SHARE_DB!;
  const r = await db.prepare("SELECT request_digest, collection, version, state FROM upload_receipts WHERE owner = ?1 AND attempt_hash = ?2").bind(owner, attemptHash).first<{ request_digest: string; collection: string; version: string; state: string }>();
  if (!r) return null;
  const live = r.state === "committed" && (await db.prepare("SELECT 1 AS x FROM collections WHERE id = ?1 AND owner = ?2").bind(r.collection, owner).first());
  if (!live) return json({ error: "attempt_retired" }, 410);
  if (r.request_digest !== digest) return json({ error: "attempt_used", collection: r.collection, version: r.version, ...shareUrls(r.collection, r.version) }, 409);
  return json({ version: r.version, collection: r.collection, ...shareUrls(r.collection, r.version) }, 200);
}

type CommitBody = { title?: unknown; license?: unknown; files?: unknown };

/** A version: of collection `cidIn`, or (cidIn null) of a new one, made by `attempt`. */
async function commitVersion(env: ShareEnv, who: Who, body: CommitBody | null, cidIn: string | null, attempt: string | null): Promise<Response> {
  const id = who.id;
  const db = env.SHARE_DB!;
  let col: { owner: string; latest: string | null; title: string } | null = null;
  if (cidIn !== null) {
    col = await db.prepare("SELECT owner, latest, title FROM collections WHERE id = ?1").bind(cidIn).first<{ owner: string; latest: string | null; title: string }>();
    if (!col || col.owner !== id) return err(404, "no such collection");
  }
  const files = body?.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) return err(400, "files: 1 to 10000 entries");
  const seen = new Set<string>();
  for (const f of files) {
    if (!f || !validPath(f.path) || !HEX64.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0) return err(400, `bad file entry ${JSON.stringify(f).slice(0, 200)}`);
    if (seen.has(f.path)) return err(400, `duplicate path ${f.path}`);
    seen.add(f.path);
  }
  const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : col!.title;
  if (body?.license !== undefined && !(typeof body.license === "string" && LICENSE.test(body.license))) return err(400, "license: an SPDX identifier");
  const listed = files.map((f: { path: string; sha256: string; size: number }) => ({ path: f.path, sha256: f.sha256, size: f.size })).sort((a, b) => (a.path < b.path ? -1 : 1));
  // (a first upload's receipt: its attempt, and what it asked for, exactly the manifest's own fields)
  let attemptHash: string | null = null, digest: string | null = null;
  if (attempt !== null) {
    attemptHash = await sha256Hex("sagebrush-attempt\n" + attempt);
    digest = await sha256Hex(canonical({ title, license: body?.license ?? null, files: listed }));
    const again = await replay(env, id, attemptHash, digest);
    if (again) return again;
  }
  // (after the receipt: a retry's answer needs no limits, and what follows may wait on CoCalc's)
  const lim = await limits(env, who);
  if (!lim) return err(403, "uploads need a CoCalc account in good standing");
  // every file must be one this account has uploaded, at its stated size
  // (a held file's size can't change: it is the size of bytes with that hash)
  const shas = [...new Set(files.map((f: { sha256: string }) => f.sha256))];
  const sizes = new Map<string, number>();
  for (let i = 0; i < shas.length; i += 90) {
    const part = shas.slice(i, i + 90);
    const r = await db.prepare(`SELECT sha256, size FROM holdings WHERE account_id = ?1 AND sha256 IN (${ph(part.length, 2)})`).bind(id, ...part).all<{ sha256: string; size: number }>();
    for (const x of r.results) sizes.set(x.sha256, x.size);
  }
  for (const f of files) if (sizes.get(f.sha256) !== f.size) return err(409, `not uploaded: ${f.path}`);
  const t = now();
  const cid = cidIn ?? newId();
  const manifest = {
    format: "sagebrush-collection",
    version: 1,
    collection: cid,
    created: new Date(t * 1000).toISOString(),
    title,
    license: body?.license,
    parent: col?.latest ?? undefined,
    files: listed,
  };
  const text = canonical(manifest);
  const bytes = enc.encode(text).length;
  const hash = await sha256Hex(text);
  const key = await newKey(id);
  // (a manifest is stored and counted as the account's bytes too)
  const res = await reserve(env, who, bytes, lim.storage_bytes, key);
  if (!res) return err(413, "over your storage limit");
  const rid = res.id;
  try {
    await env.SHARE_BUCKET!.put(key, text, { sha256: hash, httpMetadata: { contentType: "application/json" } });
  } catch {
    await abandon(env, key, rid);
    return err(503, "storage failed; try again");
  }
  const size = [...sizes.values()].reduce((s, n) => s + n, 0);
  const stmts: D1Stmt[] = [
    // (the same version committed twice: this copy of its manifest is not needed)
    db.prepare("INSERT INTO r2_deletes (key, created) SELECT ?2, ?3 WHERE EXISTS (SELECT 1 FROM versions WHERE hash = ?1)").bind(hash, key, t),
    // (a new share: its collection, and its attempt's receipt, exist only if this version does; the
    // receipt's plain INSERT fails the batch for an attempt already used, or retired by a deletion)
    ...(attemptHash !== null
      ? [
          db.prepare("INSERT INTO collections (id, owner, title, created, updated, latest) VALUES (?1, ?2, ?3, ?4, ?4, NULL)").bind(cid, id, title, t),
          db.prepare("INSERT INTO upload_receipts (owner, attempt_hash, request_digest, collection, version, state, created) VALUES (?1, ?2, ?3, ?4, ?5, 'committed', ?6)").bind(id, attemptHash, digest, cid, hash, t),
          ...guard(db, "(SELECT COUNT(*) FROM collections WHERE owner = ?1) <= ?2", id, MAX_COLLECTIONS),
        ]
      : []),
    db.prepare("INSERT INTO versions (hash, collection, owner, created, size, manifest_key, manifest_bytes, title) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(hash) DO NOTHING").bind(hash, cid, id, t, size, key, bytes, title),
  ];
  for (let i = 0; i < shas.length; i += 500) {
    const part = shas.slice(i, i + 500);
    stmts.push(db.prepare("INSERT INTO version_blobs (version, sha256) SELECT ?1, value FROM json_each(?2) WHERE true ON CONFLICT DO NOTHING").bind(hash, JSON.stringify(part)));
  }
  stmts.push(
    db.prepare("UPDATE collections SET latest = ?1, updated = ?2, title = ?3 WHERE id = ?4").bind(hash, t, title, cid),
    ...consume(db, rid),
    // the checks made above, again, inside the transaction: the session is
    // live, the collection is still its own and under the version limit, and
    // every file is still held
    ...live(db, who),
    ...guard(db, `EXISTS (SELECT 1 FROM collections WHERE id = ?2 AND owner = ?1)
      AND (SELECT COUNT(*) FROM versions WHERE collection = ?2) <= ?4
      AND NOT EXISTS (SELECT 1 FROM version_blobs vb WHERE vb.version = ?3 AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.account_id = ?1 AND h.sha256 = vb.sha256))`, id, cid, hash, MAX_VERSIONS),
  );
  try {
    await db.batch(stmts);
  } catch {
    await abandon(env, key, rid);
    if (attemptHash !== null) {
      // (the same attempt's twin, committed meanwhile, answers as a retry would; else the limit, or a change)
      const again = await replay(env, id, attemptHash, digest!);
      if (again) return again;
      const n = await db.prepare("SELECT COUNT(*) AS n FROM collections WHERE owner = ?1").bind(id).first<{ n: number }>();
      if ((n?.n ?? 0) >= MAX_COLLECTIONS) return err(403, `at most ${MAX_COLLECTIONS} collections`);
    }
    return err(409, "the collection or its files changed; upload again");
  }
  return json({ version: hash, collection: cid, ...shareUrls(cid, hash) }, 201);
}

// ---- reading

/**
 * A share's title for its page's link preview (share-ux-plan r2 §6): what
 * the page itself shows as its title.  D1 only (two reads), never the R2
 * manifest; the version resolved as getCollection does, the latest or a
 * unique prefix.  Null for anything but a live, unambiguous version with a
 * stored title (an unknown, deleted or purged share, a pre-migration old
 * version), for a deployment without D1, and on any error: the caller then
 * serves the generic page.  Nothing is cached, so a deletion or a purge is
 * seen by the next request everywhere.
 */
export async function sharePreview(env: ShareEnv, cid: string, at: string | null): Promise<{ title: string; version: string } | null> {
  try {
    const db = env.SHARE_DB;
    if (!db || !/^[a-z2-7]{12}$/.test(cid) || (at !== null && !/^[0-9a-f]{8,64}$/.test(at))) return null;
    const col = await db.prepare("SELECT latest FROM collections WHERE id = ?1").bind(cid).first<{ latest: string | null }>();
    if (!col?.latest) return null;
    const v = await db.prepare("SELECT hash, title FROM versions WHERE collection = ?1 AND substr(hash, 1, length(?2)) = ?2 LIMIT 2").bind(cid, at ?? col.latest).all<{ hash: string; title: string | null }>();
    if (v.results.length !== 1) return null;
    const title = `${v.results[0].title ?? ""}`.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
    return title ? { title, version: v.results[0].hash } : null;
  } catch {
    return null;
  }
}

async function getCollection(env: ShareEnv, cid: string, at: string | null): Promise<Response> {
  const db = env.SHARE_DB!;
  const col = await db.prepare("SELECT title, latest FROM collections WHERE id = ?1").bind(cid).first<{ title: string; latest: string | null }>();
  if (!col || !col.latest) return err(404, "no such collection, or it was deleted by its owner");
  if (at && !/^[0-9a-f]{8,64}$/.test(at)) return err(400, "bad version");
  const v = await db.prepare("SELECT hash, manifest_key FROM versions WHERE collection = ?1 AND substr(hash, 1, length(?2)) = ?2 LIMIT 2").bind(cid, at ?? col.latest).all<{ hash: string; manifest_key: string }>();
  if (v.results.length !== 1) return err(404, "no such version");
  const o = await env.SHARE_BUCKET!.get(v.results[0].manifest_key);
  if (!o) return err(404, "no such version");
  return json({ id: cid, version: v.results[0].hash, latest: col.latest, files_origin: env.FILES_ORIGIN ?? null, manifest: JSON.parse(await new Response(o.body).text()) });
}

async function mine(env: ShareEnv, id: string): Promise<Response> {
  const r = await env.SHARE_DB!.prepare("SELECT id, title, created, updated, latest FROM collections WHERE owner = ?1 ORDER BY updated DESC").bind(id).all();
  return json({ collections: r.results });
}

// ---- deleting

/**
 * Delete one collection: its rows, and (into the outbox) its manifests and
 * the files no other version of the owner's uses, in one transaction.  Its
 * files stop being served at once; R2 follows (drain).
 */
async function deleteCollection(env: ShareEnv, account: string, cid: string): Promise<{ bytes: number }> {
  const db = env.SHARE_DB!;
  const t = now();
  // (held files this collection uses that no other collection of the owner's does)
  const unused = `SELECT h.sha256 FROM holdings h WHERE h.account_id = ?1 AND h.sha256 IN (SELECT vb.sha256 FROM version_blobs vb JOIN versions v ON v.hash = vb.version WHERE v.collection = ?2)
    AND NOT EXISTS (SELECT 1 FROM version_blobs vb JOIN versions v ON v.hash = vb.version WHERE vb.sha256 = h.sha256 AND v.owner = ?1 AND v.collection <> ?2)`;
  const b = await db.prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM holdings WHERE account_id = ?1 AND sha256 IN (${unused})`).bind(account, cid).first<{ n: number }>();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO r2_deletes (key, created) SELECT manifest_key, ?2 FROM versions WHERE collection = ?1").bind(cid, t),
    db.prepare(`INSERT OR IGNORE INTO r2_deletes (key, created) SELECT key, ?3 FROM holdings WHERE account_id = ?1 AND sha256 IN (${unused})`).bind(account, cid, t),
    db.prepare(`DELETE FROM holdings WHERE account_id = ?1 AND sha256 IN (${unused})`).bind(account, cid),
    db.prepare("DELETE FROM version_blobs WHERE version IN (SELECT hash FROM versions WHERE collection = ?1)").bind(cid),
    db.prepare("DELETE FROM versions WHERE collection = ?1").bind(cid),
    db.prepare("DELETE FROM collections WHERE id = ?1").bind(cid),
    // (its first upload's attempt can never make a share again: a retry of it gets 410)
    db.prepare("UPDATE upload_receipts SET state = 'retired', retired = ?3 WHERE owner = ?1 AND collection = ?2 AND state = 'committed'").bind(account, cid, t),
    // (and at most RETIRED_RECEIPTS_MAX of them per account, the newest)
    db.prepare("DELETE FROM upload_receipts WHERE owner = ?1 AND state = 'retired' AND rowid NOT IN (SELECT rowid FROM upload_receipts WHERE owner = ?1 AND state = 'retired' ORDER BY retired DESC, rowid DESC LIMIT ?2)").bind(account, RETIRED_RECEIPTS_MAX),
  ]);
  return { bytes: b?.n ?? 0 };
}

/**
 * Delete everything of an account's.  First, atomically, mark it deleting
 * (no sessions, no writes from now on) and drop its sessions; for an account
 * deleted in CoCalc, also a tombstone, so it never signs in again.  Then its
 * rows, and its whole R2 prefix into the outbox, which drain() empties (and
 * then finishes the purge).
 */
async function purgeAccount(env: ShareEnv, account: string, rid: string, admin: boolean): Promise<void> {
  const db = env.SHARE_DB!;
  const t = now();
  const h = await accountHash(account);
  await db.batch([
    db.prepare("INSERT INTO accounts (account_id, created, deleting) VALUES (?1, ?2, ?2) ON CONFLICT(account_id) DO UPDATE SET deleting = ?2, email = NULL, name = NULL").bind(account, t),
    db.prepare("DELETE FROM sessions WHERE account_id = ?1").bind(account),
    ...(admin ? [db.prepare("INSERT OR IGNORE INTO tombstones (account_hash, created) VALUES (?1, ?2)").bind(h, t)] : []),
  ]);
  const counts = await db.prepare(`SELECT (SELECT COUNT(*) FROM collections WHERE owner = ?1) AS c, (SELECT COALESCE(SUM(size), 0) FROM holdings WHERE account_id = ?1) + (SELECT COALESCE(SUM(manifest_bytes), 0) FROM versions WHERE owner = ?1) AS b`).bind(account).first<{ c: number; b: number }>();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO r2_deletes (key, prefix, account_id, purge, created) VALUES (?1, 1, ?2, ?3, ?4)").bind(await prefixOf(account), account, rid, t),
    db.prepare("DELETE FROM version_blobs WHERE version IN (SELECT hash FROM versions WHERE owner = ?1)").bind(account),
    db.prepare("DELETE FROM versions WHERE owner = ?1").bind(account),
    db.prepare("DELETE FROM collections WHERE owner = ?1").bind(account),
    // (an account deleted in CoCalc never comes back: its receipts go; one deleting its own shares
    // may sign in again, and a retry of an old attempt then gets 410, not a new share)
    admin
      ? db.prepare("DELETE FROM upload_receipts WHERE owner = ?1").bind(account)
      : db.prepare("UPDATE upload_receipts SET state = 'retired', retired = ?2 WHERE owner = ?1 AND state = 'committed'").bind(account, t),
    ...(admin ? [] : [db.prepare("DELETE FROM upload_receipts WHERE owner = ?1 AND state = 'retired' AND rowid NOT IN (SELECT rowid FROM upload_receipts WHERE owner = ?1 AND state = 'retired' ORDER BY retired DESC, rowid DESC LIMIT ?2)").bind(account, RETIRED_RECEIPTS_MAX)]),
    db.prepare("DELETE FROM holdings WHERE account_id = ?1").bind(account),
    db.prepare("DELETE FROM limits_cache WHERE account_id = ?1").bind(account),
    db.prepare("UPDATE purges SET status = 'files', collections = ?2, bytes = ?3, lease = NULL WHERE request_id = ?1").bind(rid, counts?.c ?? 0, counts?.b ?? 0),
  ]);
}

/** Run a purge, if no one else is running it (a lease, so a crashed run is taken over). */
async function runPurge(env: ShareEnv, rid: string): Promise<void> {
  const db = env.SHARE_DB!;
  const t = now();
  const claim = await db.prepare("UPDATE purges SET status = 'running', lease = ?2 WHERE request_id = ?1 AND kind <> 'collection' AND (status = 'pending' OR (status = 'running' AND lease < ?3))").bind(rid, t + 300, t).run();
  if (claim.meta?.changes !== 1) return;
  const p = await db.prepare("SELECT kind, account_id FROM purges WHERE request_id = ?1").bind(rid).first<{ kind: string; account_id: string }>();
  if (p?.account_id) await purgeAccount(env, p.account_id, rid, p.kind === "admin");
  await drain(env);
}

/**
 * Empty the outbox: delete each R2 object (or everything under a prefix,
 * a page at a time), and only then its row.  A prefix is done when it is
 * empty and its account has no upload still running; then its purge is.
 */
export async function drain(env: ShareEnv, budget = 50): Promise<void> {
  const db = env.SHARE_DB!;
  const bucket = env.SHARE_BUCKET!;
  const rows = (await db.prepare("SELECT key, prefix, account_id, purge FROM r2_deletes ORDER BY created LIMIT ?1").bind(budget).all<{ key: string; prefix: number; account_id: string | null; purge: string | null }>()).results;
  for (const r of rows) {
    try {
      if (!r.prefix) {
        await bucket.delete(r.key);
        await db.prepare("DELETE FROM r2_deletes WHERE key = ?1").bind(r.key).run();
        continue;
      }
      for (let page = 0; page < 10; page++) {
        const l = await bucket.list({ prefix: r.key, limit: 1000 });
        if (l.objects.length) await bucket.delete(l.objects.map((o) => o.key));
        if (!l.truncated && !l.objects.length) break;
      }
      const left = await bucket.list({ prefix: r.key, limit: 1 });
      const uploading = r.account_id ? await db.prepare("SELECT 1 AS x FROM reservations WHERE account_id = ?1 AND expires > ?2 LIMIT 1").bind(r.account_id, now()).first() : null;
      if (left.objects.length || uploading) continue; // (again next time)
      // done: every purge of this account (they coalesce) is.  An account deleted
      // in CoCalc (it has a tombstone, whichever purge got here first) is gone;
      // one that only deleted its shared data can share again.  (Which one is
      // decided in the batch itself: a tombstone written meanwhile counts,
      // PRIV-SHARE-2.)
      const h = await accountHash(r.account_id!);
      await db.batch([
        db.prepare("DELETE FROM r2_deletes WHERE key = ?1").bind(r.key),
        db.prepare("DELETE FROM reservations WHERE account_id = ?1").bind(r.account_id),
        db.prepare("DELETE FROM accounts WHERE account_id = ?1 AND EXISTS (SELECT 1 FROM tombstones WHERE account_hash = ?2)").bind(r.account_id, h),
        db.prepare("UPDATE accounts SET deleting = NULL WHERE account_id = ?1 AND NOT EXISTS (SELECT 1 FROM tombstones WHERE account_hash = ?2)").bind(r.account_id, h),
        db.prepare("DELETE FROM limits_cache WHERE account_id = ?1").bind(r.account_id),
        db.prepare("UPDATE purges SET status = 'done', finished = ?2, account_id = NULL, lease = NULL WHERE account_hash = ?1 AND status <> 'done' AND kind <> 'collection'").bind(h, now()),
      ]);
    } catch {
      // (R2 or D1 failed: the row stays, and the next drain tries again)
    }
  }
}

/** Admin calls are signed: HMAC-SHA256(key, timestamp \n METHOD \n path \n body). */
async function signed(req: Request, env: ShareEnv, body: string): Promise<boolean> {
  return signedWith(req, env.PURGE_KEY, body);
}
/** The same check with another key (the sync service's plan notices use LIMITS_KEY, design/sync-server.md §6). */
export async function signedWith(req: Request, key: string | undefined, body: string): Promise<boolean> {
  if (!key) return false;
  const ts = req.headers.get("x-sagebrush-timestamp") ?? "";
  const sig = req.headers.get("x-sagebrush-signature") ?? "";
  if (!/^\d{1,12}$/.test(ts) || Math.abs(now() - Number(ts)) > 300) return false;
  const want = "sha256=" + (await hmac(key, `${ts}\n${req.method}\n${new URL(req.url).pathname}\n${body}`));
  return same(sig, want);
}

/**
 * Bind a purge's request id to its account, for good: its record, made if
 * there is none (pending: the scheduled job runs a pending purge whatever
 * becomes of this request), and "conflict" if the id already names another
 * account or operation.  The sync service binds through this too, before it
 * touches any account object (design/sync-server.md §7.1, CORR-E9C-1).
 */
export async function bindPurge(env: ShareEnv, account: string, rid: string, kind: "admin" | "self"): Promise<"accepted" | "conflict"> {
  const db = env.SHARE_DB!;
  const h = await accountHash(account);
  await db.prepare("INSERT INTO purges (request_id, account_hash, account_id, kind, status, created) VALUES (?1, ?2, ?3, ?4, 'pending', ?5) ON CONFLICT(request_id) DO NOTHING").bind(rid, h, account, kind, now()).run();
  const p = await db.prepare("SELECT account_hash, kind, collection FROM purges WHERE request_id = ?1").bind(rid).first<{ account_hash: string; kind: string; collection: string | null }>();
  // (a request id names one operation: the same id for another account is refused)
  return !p || p.account_hash !== h || p.kind !== kind || p.collection !== null ? "conflict" : "accepted";
}

/** Start (or resume) deleting all of an account's shared data. */
async function startPurge(env: ShareEnv, ctx: Ctx, account: string, rid: string, kind: "admin" | "self"): Promise<"accepted" | "conflict"> {
  if ((await bindPurge(env, account, rid, kind)) === "conflict") return "conflict";
  ctx.waitUntil(runPurge(env, rid));
  return "accepted";
}

/**
 * An admin purge's Content-Length, checked before its body is read: 411 for none, an empty one,
 * anything but ASCII digits (no sign, space or other character), or 0, which is what a POST with no
 * body arrives with; 413 for any decimal over 4096, however many digits (a huge one parses to a
 * large number or to Infinity, both > 4096; leading zeros are allowed: "0010" is 10); else null.
 */
export function adminLength(len: string | null): 411 | 413 | null {
  if (!len || !/^[0-9]+$/.test(len) || Number(len) === 0) return 411;
  if (Number(len) > 4096) return 413;
  return null;
}

async function adminPurge(req: Request, env: ShareEnv, ctx: Ctx): Promise<Response> {
  const bad = adminLength(req.headers.get("content-length"));
  if (bad === 411) return err(411, "a body with its content-length is required");
  if (bad === 413) return err(413, "too large");
  const body = await req.text();
  if (body.length > 4096 || !(await signed(req, env, body))) return err(401, "bad signature");
  let v: { account_id?: unknown; request_id?: unknown };
  try { v = JSON.parse(body); } catch { return err(400, "bad request"); }
  if (typeof v.account_id !== "string" || !v.account_id || v.account_id.length > 100 || typeof v.request_id !== "string" || !/^[0-9a-f-]{8,64}$/i.test(v.request_id)) return err(400, "bad request");
  if ((await startPurge(env, ctx, v.account_id, v.request_id, "admin")) === "conflict") return err(409, "this request_id was used for another request");
  return json({ request_id: v.request_id, status: "accepted" }, 202);
}

async function adminPurgeStatus(req: Request, env: ShareEnv, rid: string): Promise<Response> {
  if (!(await signed(req, env, ""))) return err(401, "bad signature");
  const p = await env.SHARE_DB!.prepare("SELECT status, collections, bytes FROM purges WHERE request_id = ?1").bind(rid).first();
  return p ? json({ request_id: rid, ...p }) : err(404, "no such request");
}

/**
 * The scheduled job: purges whose run was cut short, the outbox, uploads
 * whose request died after writing to R2 (expired reservations), uploads
 * never used in a day, expired sessions.
 */
export async function scheduled(env: ShareEnv): Promise<void> {
  if (!env.SHARE_DB || !env.SHARE_BUCKET) return;
  const db = env.SHARE_DB;
  const t = now();
  // purges left waiting for a prefix another purge of the account finished (they coalesce: run again)
  await db.prepare("UPDATE purges SET status = 'pending', lease = NULL WHERE status = 'files' AND account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM r2_deletes d WHERE d.prefix = 1 AND d.account_id = purges.account_id)").run();
  // purges whose run was cut short
  for (const p of (await db.prepare("SELECT request_id FROM purges WHERE kind <> 'collection' AND (status = 'pending' OR (status = 'running' AND lease < ?1)) LIMIT 20").bind(t).all<{ request_id: string }>()).results) await runPurge(env, p.request_id);
  // reservations whose upload ended without its D1 write: the object, if any, is unreferenced
  for (const r of (await db.prepare("SELECT id, key FROM reservations WHERE expires < ?1 LIMIT 200").bind(t).all<{ id: string; key: string }>()).results) {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO r2_deletes (key, created) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM holdings WHERE key = ?1) AND NOT EXISTS (SELECT 1 FROM versions WHERE manifest_key = ?1)").bind(r.key, t),
      db.prepare("DELETE FROM reservations WHERE id = ?1").bind(r.id),
    ]);
  }
  // uploads no version uses, a day after: into the outbox, in the same statement's terms
  const idle = `SELECT rowid FROM holdings h WHERE h.created < ?1 AND NOT EXISTS (SELECT 1 FROM version_blobs vb JOIN versions v ON v.hash = vb.version WHERE vb.sha256 = h.sha256 AND v.owner = h.account_id) LIMIT 500`;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO r2_deletes (key, created) SELECT key, ?2 FROM holdings WHERE rowid IN (${idle})`).bind(t - DAY, t),
    db.prepare(`DELETE FROM holdings WHERE rowid IN (${idle})`).bind(t - DAY),
  ]);
  await drain(env, 500);
  await reconcile(env);
  await db.prepare("DELETE FROM sessions WHERE expires < ?1").bind(t).run();
  // records of finished deletions, after their time (HARD-SHARE-3, HARD-E55-2):
  // a collection's and a self-deletion's after DELETION_RECORD_DAYS; an
  // account deletion's (CoCalc may ask about it again by its request id)
  // after ADMIN_RECORD_DAYS.  Tombstones stay: they keep a deleted account out.
  await db.prepare("DELETE FROM purges WHERE status = 'done' AND ((kind IN ('collection', 'self') AND finished < ?1) OR (kind = 'admin' AND finished < ?2))").bind(t - DELETION_RECORD_DAYS * DAY, t - ADMIN_RECORD_DAYS * DAY).run();
  // the receipts of deleted shares' attempts, after DELETION_RECORD_DAYS: a later request carrying
  // such an attempt makes a new share, with a new id (the deleted one's link stays dead)
  for (let page = 0; page < RETIRED_RECEIPT_PAGES; page++) {
    const r = await db.prepare("DELETE FROM upload_receipts WHERE rowid IN (SELECT rowid FROM upload_receipts WHERE state = 'retired' AND retired < ?1 ORDER BY retired LIMIT 500)").bind(t - DELETION_RECORD_DAYS * DAY).run();
    if ((r.meta?.changes ?? 0) < 500) break;
  }
}

/**
 * The inventory check, a page of R2 at a time (resuming where the last run
 * stopped): an object no row references, two days after it was written, is
 * deleted.  This catches what nothing else can, such as an upload whose R2
 * write landed after its reservation was reclaimed and its key deleted.
 */
async function reconcile(env: ShareEnv): Promise<void> {
  const db = env.SHARE_DB!;
  const at = await db.prepare("SELECT v FROM meta WHERE k = 'reconcile_cursor'").first<{ v: string }>();
  const l = await env.SHARE_BUCKET!.list({ prefix: "a/", limit: 1000, ...(at?.v ? { cursor: at.v } : {}) });
  const old = Date.now() - 2 * DAY * 1000;
  for (const o of l.objects) {
    if (new Date(o.uploaded).valueOf() > old) continue;
    await db.prepare("INSERT OR IGNORE INTO r2_deletes (key, created) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM holdings WHERE key = ?1) AND NOT EXISTS (SELECT 1 FROM versions WHERE manifest_key = ?1) AND NOT EXISTS (SELECT 1 FROM reservations WHERE key = ?1)").bind(o.key, now()).run();
  }
  await db.prepare("INSERT INTO meta (k, v) VALUES ('reconcile_cursor', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1").bind(l.truncated ? (l.cursor ?? "") : "").run();
  await drain(env, 500);
}

// ---- routing

/** A state-changing request must come from this site's own pages. */
function sameSite(req: Request): boolean {
  return req.headers.get("origin") === new URL(req.url).origin;
}

/** The share API's response to req, or null if req is not for it. */
export async function handleShare(req: Request, env: ShareEnv, ctx: Ctx): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (!p.startsWith("/auth/") && !p.startsWith("/api/share/") && !p.startsWith("/api/admin/")) return null;
  if (!env.SHARE_DB || !env.SHARE_BUCKET) return err(404, "sharing is not enabled here");
  const m = req.method;
  if (p === "/auth/login" && m === "GET") return login(req, env);
  if (p === "/auth/callback" && m === "GET") return callback(req, env);
  if (p === "/api/admin/purge" && m === "POST") return adminPurge(req, env, ctx);
  let g = p.match(/^\/api\/admin\/purge\/([0-9a-f-]{8,64})$/i);
  if (g && m === "GET") return adminPurgeStatus(req, env, g[1]);
  g = p.match(/^\/api\/share\/c\/([a-z2-7]{12})$/);
  if (g && m === "GET") return getCollection(env, g[1], url.searchParams.get("at"));
  if (m !== "GET" && !sameSite(req)) return err(403, "cross-site request");
  if (p === "/auth/dev" && m === "POST") {
    if (env.SHARE_DEV !== "1" || !env.DEV_AUTH_TOKEN) return err(404, "not found");
    const b = (await req.json().catch(() => null)) as { token?: string; account_id?: string } | null;
    if (!b || typeof b.token !== "string" || !same(b.token, env.DEV_AUTH_TOKEN) || typeof b.account_id !== "string" || !/^[0-9a-f-]{36}$/.test(b.account_id)) return err(403, "no");
    const s = await startSession(env, { account_id: b.account_id, email: "dev@example.com", name: "Dev" });
    return s ? json({ ok: true }, 200, { "set-cookie": s }) : err(403, "this account can't sign in to share files");
  }
  const who = await account(req, env);
  const id = who?.id;
  if (p === "/auth/logout" && m === "POST") {
    const t = cookies(req).get(SESSION);
    if (t) await env.SHARE_DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256Hex(t)).run();
    return json({ ok: true }, 200, { "set-cookie": cookie(SESSION, "", 0) });
  }
  if (!who || !id) return err(401, "sign in first");
  if (p === "/api/share/me" && m === "GET") {
    const a = await env.SHARE_DB.prepare("SELECT email, name FROM accounts WHERE account_id = ?1").bind(id).first();
    return json({ account_id: id, ...a, ...(await breakdown(env, id)), limits: await limits(env, who) });
  }
  if (p === "/api/share/mine" && m === "GET") return mine(env, id);
  if (m !== "GET" && m !== "PUT" && m !== "DELETE" && !/^application\/json\b/.test(req.headers.get("content-type") ?? "")) return err(415, "JSON only");
  if (p === "/api/share/first-upload" && m === "POST") {
    const body = (await req.json().catch(() => null)) as (CommitBody & { attempt?: unknown }) | null;
    return body && typeof body === "object" ? firstUpload(env, who, body) : err(400, "a JSON object is required");
  }
  if (p === "/api/share/collections" && m === "POST") {
    const body = (await req.json().catch(() => null)) as (CommitBody & { attempt?: unknown }) | null;
    // (an older page's empty collection; a first upload's form is never taken for it)
    if (body && typeof body === "object" && (body.files !== undefined || body.attempt !== undefined)) return err(400, "a first upload goes to /api/share/first-upload");
    return createCollection(env, who, body);
  }
  if (p === "/api/share/check" && m === "POST") return check(req, env, who);
  g = p.match(/^\/api\/share\/blob\/([0-9a-f]{64})$/);
  if (g && m === "PUT") return putBlob(req, env, who, g[1]);
  g = p.match(/^\/api\/share\/collections\/([a-z2-7]{12})\/versions$/);
  if (g && m === "POST") return commit(req, env, who, g[1]);
  g = p.match(/^\/api\/share\/collections\/([a-z2-7]{12})$/);
  if (g && m === "DELETE") {
    const c = await env.SHARE_DB.prepare("SELECT owner FROM collections WHERE id = ?1").bind(g[1]).first<{ owner: string }>();
    if (!c || c.owner !== id) return err(404, "no such collection");
    const r = await deleteCollection(env, id, g[1]);
    // (a record of it, kept DELETION_RECORD_DAYS and at most DELETION_RECORDS_MAX per account, HARD-SHARE-3)
    const h = await accountHash(id);
    await env.SHARE_DB.batch([
      env.SHARE_DB.prepare("INSERT INTO purges (request_id, account_hash, collection, kind, status, collections, bytes, created, finished) VALUES (?1, ?2, ?3, 'collection', 'done', 1, ?4, ?5, ?5)").bind(crypto.randomUUID(), h, g[1], r.bytes, now()),
      env.SHARE_DB.prepare("DELETE FROM purges WHERE kind = 'collection' AND account_hash = ?1 AND rowid NOT IN (SELECT rowid FROM purges WHERE kind = 'collection' AND account_hash = ?1 ORDER BY created DESC, rowid DESC LIMIT ?2)").bind(h, DELETION_RECORDS_MAX),
    ]);
    ctx.waitUntil(drain(env));
    return json({ ok: true });
  }
  if (p === "/api/share/delete-everything" && m === "POST") {
    const b = (await req.json().catch(() => null)) as { confirm?: string } | null;
    if (b?.confirm !== "delete") return err(400, 'send {"confirm": "delete"}');
    const rid = crypto.randomUUID();
    await startPurge(env, ctx, id, rid, "self");
    return json({ ok: true, request_id: rid }, 200, { "set-cookie": cookie(SESSION, "", 0) });
  }
  return err(404, "not found");
}
