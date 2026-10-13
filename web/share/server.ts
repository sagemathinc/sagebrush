// Shared collections: the API on sagebrush.space (design/sharing.md).
//
//   GET  /auth/login?return=/path      sign in with CoCalc (code + PKCE)
//   GET  /auth/callback                CoCalc sends the user back here
//   POST /auth/logout
//   POST /auth/dev                     dev only: a session for a test account
//   GET  /api/share/me                 who you are, your usage and limits
//   GET  /api/share/mine               your collections
//   POST /api/share/collections        {title} -> {id}
//   POST /api/share/check              {blobs: [{sha256, size}]} -> {missing}
//   PUT  /api/share/blob/<sha256>      the bytes (R2 checks the hash)
//   POST /api/share/collections/<id>/versions   {title, license, files} -> {version}
//   GET  /api/share/c/<id>             a collection's latest manifest
//   GET  /api/share/m/<hash>           a version's manifest
//   DELETE /api/share/collections/<id> delete a collection and its files
//   POST /api/share/delete-everything  {confirm: "delete"}: all of yours
//   POST /api/admin/purge              CoCalc: an account was deleted (signed)
//   GET  /api/admin/purge/<request_id> (signed)
//
// Files are blobs in R2 under b/<sha256>, manifests under m/<hash>; the
// files Worker (web/share/files.ts) serves both from the user-content
// domain, never from sagebrush.space.  Accounts are keyed by CoCalc
// account_id only.  Deduplication is per account: an account can only
// reference a blob it has uploaded itself, so nobody can learn whether
// someone else holds a file, and a deletion is never blocked by an account
// that merely knew a hash.

export interface D1Result<T> { results: T[] }
export interface D1Stmt {
  bind(...v: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}
export interface D1 { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<unknown[]> }
export interface R2Obj { size: number; httpEtag: string; body: ReadableStream; range?: { offset?: number; length?: number } }
export interface R2 {
  put(key: string, body: ReadableStream | ArrayBuffer | string, opts?: Record<string, unknown>): Promise<unknown>;
  get(key: string, opts?: Record<string, unknown>): Promise<R2Obj | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
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
}
interface Ctx { waitUntil(p: Promise<unknown>): void }

export interface Limits { storage_bytes: number; max_file_bytes: number; private_links: boolean; tier?: string }

const DAY = 86400;
const SESSION_DAYS = 30;
const LIMITS_TTL = 600;
/** a Worker can't take a request body over 100 MB; larger files will go up in parts */
export const MAX_PUT = 95 * 1024 * 1024;
export const MAX_FILES = 10000;
const DEV_LIMITS: Limits = { tier: "dev", storage_bytes: 1 << 30, max_file_bytes: MAX_PUT, private_links: false };
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[a-z2-7]{12}$/;

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

/** A path on this site to go back to after signing in (never another site). */
function returnPath(p: string | null): string {
  return p && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\") && p.length < 1000 ? p : "/";
}

// ---- sessions

async function account(req: Request, env: ShareEnv): Promise<string | null> {
  const t = cookies(req).get(SESSION);
  if (!t || !env.SHARE_DB) return null;
  const row = await env.SHARE_DB.prepare("SELECT account_id FROM sessions WHERE token_hash = ?1 AND expires > ?2").bind(await sha256Hex(t), now()).first<{ account_id: string }>();
  return row?.account_id ?? null;
}

async function startSession(env: ShareEnv, who: { account_id: string; email?: string; name?: string }): Promise<string> {
  const token = b64url(random(32));
  const t = now();
  await env.SHARE_DB!.batch([
    env.SHARE_DB!.prepare("INSERT INTO accounts (account_id, email, name, created, last_login) VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT(account_id) DO UPDATE SET email = ?2, name = ?3, last_login = ?4").bind(who.account_id, who.email ?? null, who.name ?? null, t),
    env.SHARE_DB!.prepare("INSERT INTO sessions (token_hash, account_id, created, expires) VALUES (?1, ?2, ?3, ?4)").bind(await sha256Hex(token), who.account_id, t, t + SESSION_DAYS * DAY),
  ]);
  return cookie(SESSION, token, SESSION_DAYS * DAY);
}

// ---- sign in with CoCalc (authorization code with PKCE)

async function login(req: Request, env: ShareEnv): Promise<Response> {
  if (!env.COCALC_ORIGIN || !env.SESSION_KEY) return err(404, "sign-in is not configured");
  const url = new URL(req.url);
  const state = b64url(random(16));
  const verifier = b64url(random(32));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
  const payload = b64url(enc.encode(JSON.stringify({ state, verifier, ret: returnPath(url.searchParams.get("return")), exp: now() + 600 })));
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
  if (url.searchParams.get("error")) return new Response(null, { status: 302, headers: { location: st.ret, "set-cookie": clear } });
  const code = url.searchParams.get("code");
  if (!code) return err(400, "no code");
  const r = await fetch(new URL("/api/v2/auth/oauth/token", env.COCALC_ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + btoa("sagebrush:" + env.COCALC_CLIENT_SECRET) },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${url.origin}/auth/callback`, code_verifier: st.verifier }),
  });
  if (!r.ok) return err(502, "CoCalc refused the sign-in");
  const who = (await r.json()) as { account_id?: string; email?: string; email_verified?: boolean; name?: string };
  if (typeof who.account_id !== "string" || !who.account_id || who.email_verified !== true) return err(403, "a verified email is required");
  const h = new Headers({ location: st.ret, "cache-control": "no-store" });
  h.append("set-cookie", clear);
  h.append("set-cookie", await startSession(env, who as { account_id: string }));
  return new Response(null, { status: 302, headers: h });
}

// ---- limits, from CoCalc's membership tiers

async function limits(env: ShareEnv, id: string): Promise<Limits | null> {
  const db = env.SHARE_DB!;
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
    await db.prepare("INSERT INTO limits_cache (account_id, limits, fetched) VALUES (?1, ?2, ?3) ON CONFLICT(account_id) DO UPDATE SET limits = ?2, fetched = ?3").bind(id, JSON.stringify(l), now()).run();
    return l;
  } catch {
    // CoCalc is unreachable: keep what we had, never read it as zero
    return c ? JSON.parse(c.limits) : null;
  }
}

async function usage(db: D1, id: string): Promise<number> {
  const r = await db.prepare("SELECT COALESCE(SUM(b.size), 0) AS n FROM holdings h JOIN blobs b ON b.sha256 = h.sha256 WHERE h.account_id = ?1").bind(id).first<{ n: number }>();
  return r?.n ?? 0;
}

// ---- uploading

async function check(req: Request, env: ShareEnv, id: string): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { blobs?: { sha256: string; size: number }[] } | null;
  const blobs = body?.blobs;
  if (!Array.isArray(blobs) || blobs.length > MAX_FILES || !blobs.every((b) => b && HEX64.test(b.sha256) && Number.isSafeInteger(b.size) && b.size >= 0)) return err(400, "bad request");
  const lim = await limits(env, id);
  if (!lim) return err(403, "uploads need a CoCalc account in good standing");
  const max = Math.min(lim.max_file_bytes, MAX_PUT);
  const big = blobs.find((b) => b.size > max);
  if (big) return json({ error: "file too large", sha256: big.sha256, max_file_bytes: max }, 413);
  const held = new Set<string>();
  for (let i = 0; i < blobs.length; i += 90) {
    const part = blobs.slice(i, i + 90).map((b) => b.sha256);
    const r = await env.SHARE_DB!.prepare(`SELECT sha256 FROM holdings WHERE account_id = ?1 AND sha256 IN (${part.map((_, j) => `?${j + 2}`).join(",")})`).bind(id, ...part).all<{ sha256: string }>();
    for (const x of r.results) held.add(x.sha256);
  }
  const missing = [...new Map(blobs.filter((b) => !held.has(b.sha256)).map((b) => [b.sha256, b])).values()];
  const used = await usage(env.SHARE_DB!, id);
  const adding = missing.reduce((s, b) => s + b.size, 0);
  if (used + adding > lim.storage_bytes) return json({ error: "over your storage limit", used, adding, storage_bytes: lim.storage_bytes }, 413);
  return json({ missing: missing.map((b) => b.sha256) });
}

async function putBlob(req: Request, env: ShareEnv, id: string, sha: string): Promise<Response> {
  const size = Number(req.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size < 0) return err(411, "content-length required");
  const lim = await limits(env, id);
  if (!lim) return err(403, "uploads need a CoCalc account in good standing");
  if (size > Math.min(lim.max_file_bytes, MAX_PUT)) return err(413, "file too large");
  const db = env.SHARE_DB!;
  const held = await db.prepare("SELECT 1 AS x FROM holdings WHERE account_id = ?1 AND sha256 = ?2").bind(id, sha).first();
  if (!held && (await usage(db, id)) + size > lim.storage_bytes) return err(413, "over your storage limit");
  try {
    // R2 refuses the upload unless the bytes hash to sha
    await env.SHARE_BUCKET!.put(`b/${sha}`, req.body ?? new ArrayBuffer(0), { sha256: sha, httpMetadata: { contentType: "application/octet-stream" } });
  } catch {
    return err(400, "the file's SHA-256 does not match");
  }
  const t = now();
  await db.batch([
    db.prepare("INSERT INTO blobs (sha256, size, created) VALUES (?1, ?2, ?3) ON CONFLICT(sha256) DO NOTHING").bind(sha, size, t),
    db.prepare("INSERT INTO holdings (account_id, sha256, created) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING").bind(id, sha, t),
  ]);
  return json({ ok: true });
}

async function createCollection(req: Request, env: ShareEnv, id: string): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 200) : "";
  if (!title) return err(400, "a title is required");
  if (!(await limits(env, id))) return err(403, "uploads need a CoCalc account in good standing");
  const cid = newId();
  const t = now();
  await env.SHARE_DB!.prepare("INSERT INTO collections (id, owner, title, created, updated) VALUES (?1, ?2, ?3, ?4, ?4)").bind(cid, id, title, t).run();
  return json({ id: cid }, 201);
}

const LICENSE = /^[A-Za-z0-9.+\- ()]{1,64}$/;

async function commit(req: Request, env: ShareEnv, id: string, cid: string): Promise<Response> {
  const db = env.SHARE_DB!;
  const col = await db.prepare("SELECT owner, latest FROM collections WHERE id = ?1").bind(cid).first<{ owner: string; latest: string | null }>();
  if (!col || col.owner !== id) return err(404, "no such collection");
  const body = (await req.json().catch(() => null)) as { title?: unknown; license?: unknown; files?: unknown } | null;
  const files = body?.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) return err(400, "files: 1 to 10000 entries");
  const seen = new Set<string>();
  for (const f of files) {
    if (!f || !validPath(f.path) || !HEX64.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0) return err(400, `bad file entry ${JSON.stringify(f).slice(0, 200)}`);
    if (seen.has(f.path)) return err(400, `duplicate path ${f.path}`);
    seen.add(f.path);
  }
  const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : undefined;
  if (body?.license !== undefined && !(typeof body.license === "string" && LICENSE.test(body.license))) return err(400, "license: an SPDX identifier");
  // every file must be one this account has uploaded, at its stated size
  const shas = [...new Set(files.map((f: { sha256: string }) => f.sha256))];
  const sizes = new Map<string, number>();
  for (let i = 0; i < shas.length; i += 90) {
    const part = shas.slice(i, i + 90);
    const r = await db.prepare(`SELECT b.sha256, b.size FROM holdings h JOIN blobs b ON b.sha256 = h.sha256 WHERE h.account_id = ?1 AND h.sha256 IN (${part.map((_, j) => `?${j + 2}`).join(",")})`).bind(id, ...part).all<{ sha256: string; size: number }>();
    for (const x of r.results) sizes.set(x.sha256, x.size);
  }
  for (const f of files) if (sizes.get(f.sha256) !== f.size) return err(409, `not uploaded: ${f.path}`);
  const t = now();
  const manifest = {
    format: "sagebrush-collection",
    version: 1,
    collection: cid,
    created: new Date(t * 1000).toISOString(),
    title: title ?? (await db.prepare("SELECT title FROM collections WHERE id = ?1").bind(cid).first<{ title: string }>())!.title,
    license: body?.license,
    parent: col.latest ?? undefined,
    files: files.map((f: { path: string; sha256: string; size: number }) => ({ path: f.path, sha256: f.sha256, size: f.size })).sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  const text = canonical(manifest);
  const hash = await sha256Hex(text);
  await env.SHARE_BUCKET!.put(`m/${hash}`, text, { sha256: hash, httpMetadata: { contentType: "application/json" } });
  const size = [...sizes.values()].reduce((s, n) => s + n, 0);
  await db.batch([
    db.prepare("INSERT INTO versions (hash, collection, owner, created, size) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(hash) DO NOTHING").bind(hash, cid, id, t, size),
    ...shas.map((s) => db.prepare("INSERT INTO version_blobs (version, sha256) VALUES (?1, ?2) ON CONFLICT DO NOTHING").bind(hash, s)),
    db.prepare("UPDATE collections SET latest = ?1, updated = ?2, title = ?3 WHERE id = ?4").bind(hash, t, manifest.title, cid),
  ]);
  return json({ version: hash, collection: cid, url: `/s/${cid}`, frozen: `/s/${cid}@${hash.slice(0, 16)}` }, 201);
}

// ---- reading

async function manifestText(env: ShareEnv, hash: string): Promise<string | null> {
  const o = await env.SHARE_BUCKET!.get(`m/${hash}`);
  return o ? await new Response(o.body).text() : null;
}

async function getCollection(env: ShareEnv, cid: string, at: string | null): Promise<Response> {
  const db = env.SHARE_DB!;
  const col = await db.prepare("SELECT title, latest FROM collections WHERE id = ?1").bind(cid).first<{ title: string; latest: string | null }>();
  if (!col || !col.latest) return err(404, "no such collection, or it was deleted by its owner");
  let hash = col.latest;
  if (at) {
    if (!/^[0-9a-f]{8,64}$/.test(at)) return err(400, "bad version");
    const v = await db.prepare("SELECT hash FROM versions WHERE collection = ?1 AND hash LIKE ?2 LIMIT 2").bind(cid, at + "%").all<{ hash: string }>();
    if (v.results.length !== 1) return err(404, "no such version");
    hash = v.results[0].hash;
  }
  const text = await manifestText(env, hash);
  if (!text) return err(404, "no such version");
  return json({ id: cid, version: hash, latest: col.latest, files_origin: env.FILES_ORIGIN ?? null, manifest: JSON.parse(text) });
}

async function mine(env: ShareEnv, id: string): Promise<Response> {
  const r = await env.SHARE_DB!.prepare("SELECT id, title, created, updated, latest FROM collections WHERE owner = ?1 ORDER BY updated DESC").bind(id).all();
  return json({ collections: r.results });
}

// ---- deleting

/**
 * Delete a collection (or all of an account's collections) with every
 * version and manifest, then every blob the account no longer uses, and
 * every blob that no account holds any more.  Returns what it removed.
 */
export async function purge(env: ShareEnv, account: string, collection: string | null): Promise<{ collections: number; bytes: number }> {
  const db = env.SHARE_DB!;
  const bucket = env.SHARE_BUCKET!;
  const cols = collection === null
    ? (await db.prepare("SELECT id FROM collections WHERE owner = ?1").bind(account).all<{ id: string }>()).results.map((c) => c.id)
    : [collection];
  // (deleting one collection must not touch files uploaded for another one
  // that isn't committed yet, so only its own files are candidates)
  const candidates = new Set<string>();
  for (const cid of cols) {
    const vs = (await db.prepare("SELECT hash FROM versions WHERE collection = ?1").bind(cid).all<{ hash: string }>()).results.map((v) => v.hash);
    if (collection !== null) for (const r of (await db.prepare("SELECT DISTINCT vb.sha256 FROM version_blobs vb JOIN versions v ON v.hash = vb.version WHERE v.collection = ?1").bind(cid).all<{ sha256: string }>()).results) candidates.add(r.sha256);
    for (let i = 0; i < vs.length; i += 500) await bucket.delete(vs.slice(i, i + 500).map((h) => `m/${h}`));
    await db.batch([
      db.prepare("DELETE FROM version_blobs WHERE version IN (SELECT hash FROM versions WHERE collection = ?1)").bind(cid),
      db.prepare("DELETE FROM versions WHERE collection = ?1").bind(cid),
      db.prepare("DELETE FROM collections WHERE id = ?1").bind(cid),
    ]);
  }
  // what the account holds but no longer uses (everything, for a whole account)
  let shas: string[];
  if (collection === null) shas = (await db.prepare("SELECT sha256 FROM holdings WHERE account_id = ?1").bind(account).all<{ sha256: string }>()).results.map((r) => r.sha256);
  else {
    shas = [];
    for (const s of candidates) {
      const used = await db.prepare("SELECT 1 AS x FROM version_blobs vb JOIN versions v ON v.hash = vb.version WHERE vb.sha256 = ?1 AND v.owner = ?2 LIMIT 1").bind(s, account).first();
      if (!used) shas.push(s);
    }
  }
  let bytes = 0;
  for (let i = 0; i < shas.length; i += 90) {
    const part = shas.slice(i, i + 90);
    const ph = part.map((_, j) => `?${j + 2}`).join(",");
    await db.prepare(`DELETE FROM holdings WHERE account_id = ?1 AND sha256 IN (${ph})`).bind(account, ...part).run();
    const gone = (await db.prepare(`SELECT sha256, size FROM blobs WHERE sha256 IN (${part.map((_, j) => `?${j + 1}`).join(",")}) AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.sha256 = blobs.sha256)`).bind(...part).all<{ sha256: string; size: number }>()).results;
    if (gone.length) {
      await bucket.delete(gone.map((g) => `b/${g.sha256}`));
      await db.prepare(`DELETE FROM blobs WHERE sha256 IN (${gone.map((_, j) => `?${j + 1}`).join(",")})`).bind(...gone.map((g) => g.sha256)).run();
      bytes += gone.reduce((s, g) => s + g.size, 0);
    }
  }
  if (collection === null) {
    await db.batch([
      db.prepare("DELETE FROM sessions WHERE account_id = ?1").bind(account),
      db.prepare("DELETE FROM limits_cache WHERE account_id = ?1").bind(account),
      db.prepare("DELETE FROM accounts WHERE account_id = ?1").bind(account),
    ]);
  }
  return { collections: cols.length, bytes };
}

async function runPurge(env: ShareEnv, request_id: string): Promise<void> {
  const db = env.SHARE_DB!;
  const p = await db.prepare("SELECT account_id, collection, status FROM purges WHERE request_id = ?1").bind(request_id).first<{ account_id: string; collection: string | null; status: string }>();
  if (!p || p.status === "done") return;
  const r = await purge(env, p.account_id, p.collection);
  await db.prepare("UPDATE purges SET status = 'done', collections = ?2, bytes = ?3, finished = ?4 WHERE request_id = ?1").bind(request_id, r.collections, r.bytes, now()).run();
}

/** Admin calls are signed: HMAC-SHA256(key, timestamp \n METHOD \n path \n body). */
async function signed(req: Request, env: ShareEnv, body: string): Promise<boolean> {
  if (!env.PURGE_KEY) return false;
  const ts = req.headers.get("x-sagebrush-timestamp") ?? "";
  const sig = req.headers.get("x-sagebrush-signature") ?? "";
  if (!/^\d{1,12}$/.test(ts) || Math.abs(now() - Number(ts)) > 300) return false;
  const want = "sha256=" + (await hmac(env.PURGE_KEY, `${ts}\n${req.method}\n${new URL(req.url).pathname}\n${body}`));
  return same(sig, want);
}

async function adminPurge(req: Request, env: ShareEnv, ctx: Ctx): Promise<Response> {
  const body = await req.text();
  if (!(await signed(req, env, body))) return err(401, "bad signature");
  let v: { account_id?: unknown; request_id?: unknown };
  try { v = JSON.parse(body); } catch { return err(400, "bad request"); }
  if (typeof v.account_id !== "string" || !v.account_id || v.account_id.length > 100 || typeof v.request_id !== "string" || !/^[0-9a-f-]{8,64}$/i.test(v.request_id)) return err(400, "bad request");
  const db = env.SHARE_DB!;
  await db.prepare("INSERT INTO purges (request_id, account_id, collection, status, created) VALUES (?1, ?2, NULL, 'pending', ?3) ON CONFLICT(request_id) DO NOTHING").bind(v.request_id, v.account_id, now()).run();
  ctx.waitUntil(runPurge(env, v.request_id));
  return json({ request_id: v.request_id, status: "accepted" }, 202);
}

async function adminPurgeStatus(req: Request, env: ShareEnv, rid: string): Promise<Response> {
  if (!(await signed(req, env, ""))) return err(401, "bad signature");
  const p = await env.SHARE_DB!.prepare("SELECT status, collections, bytes FROM purges WHERE request_id = ?1").bind(rid).first();
  return p ? json({ request_id: rid, ...p }) : err(404, "no such request");
}

/** The scheduled job: finish purges cut short, drop uploads never used in a day. */
export async function scheduled(env: ShareEnv): Promise<void> {
  if (!env.SHARE_DB || !env.SHARE_BUCKET) return;
  const db = env.SHARE_DB;
  for (const p of (await db.prepare("SELECT request_id FROM purges WHERE status = 'pending' LIMIT 20").all<{ request_id: string }>()).results) await runPurge(env, p.request_id);
  const old = (await db.prepare("SELECT h.account_id, h.sha256 FROM holdings h WHERE h.created < ?1 AND NOT EXISTS (SELECT 1 FROM version_blobs vb JOIN versions v ON v.hash = vb.version WHERE vb.sha256 = h.sha256 AND v.owner = h.account_id) LIMIT 500").bind(now() - DAY).all<{ account_id: string; sha256: string }>()).results;
  for (const h of old) {
    await db.prepare("DELETE FROM holdings WHERE account_id = ?1 AND sha256 = ?2").bind(h.account_id, h.sha256).run();
    if (!(await db.prepare("SELECT 1 AS x FROM holdings WHERE sha256 = ?1").bind(h.sha256).first())) {
      await env.SHARE_BUCKET.delete(`b/${h.sha256}`);
      await db.prepare("DELETE FROM blobs WHERE sha256 = ?1").bind(h.sha256).run();
    }
  }
  await db.prepare("DELETE FROM sessions WHERE expires < ?1").bind(now()).run();
}

// ---- routing

/** A state-changing request must come from this site's own pages, as JSON. */
function sameSite(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin === new URL(req.url).origin;
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
  g = p.match(/^\/api\/share\/m\/([0-9a-f]{64})$/);
  if (g && m === "GET") {
    const t = await manifestText(env, g[1]);
    return t ? new Response(t, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } }) : err(404, "no such version");
  }
  if (m !== "GET" && !sameSite(req)) return err(403, "cross-site request");
  if (p === "/auth/dev" && m === "POST") {
    if (env.SHARE_DEV !== "1" || !env.DEV_AUTH_TOKEN) return err(404, "not found");
    const b = (await req.json().catch(() => null)) as { token?: string; account_id?: string } | null;
    if (!b || typeof b.token !== "string" || !same(b.token, env.DEV_AUTH_TOKEN) || typeof b.account_id !== "string" || !/^[0-9a-f-]{36}$/.test(b.account_id)) return err(403, "no");
    return json({ ok: true }, 200, { "set-cookie": await startSession(env, { account_id: b.account_id, email: "dev@example.com", name: "Dev" }) });
  }
  const id = await account(req, env);
  if (p === "/auth/logout" && m === "POST") {
    const t = cookies(req).get(SESSION);
    if (t) await env.SHARE_DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256Hex(t)).run();
    return json({ ok: true }, 200, { "set-cookie": cookie(SESSION, "", 0) });
  }
  if (!id) return err(401, "sign in first");
  if (p === "/api/share/me" && m === "GET") {
    const a = await env.SHARE_DB.prepare("SELECT email, name FROM accounts WHERE account_id = ?1").bind(id).first();
    return json({ account_id: id, ...a, usage: await usage(env.SHARE_DB, id), limits: await limits(env, id) });
  }
  if (p === "/api/share/mine" && m === "GET") return mine(env, id);
  if (m !== "GET" && m !== "PUT" && m !== "DELETE" && !/^application\/json\b/.test(req.headers.get("content-type") ?? "")) return err(415, "JSON only");
  if (p === "/api/share/collections" && m === "POST") return createCollection(req, env, id);
  if (p === "/api/share/check" && m === "POST") return check(req, env, id);
  g = p.match(/^\/api\/share\/blob\/([0-9a-f]{64})$/);
  if (g && m === "PUT") return putBlob(req, env, id, g[1]);
  g = p.match(/^\/api\/share\/collections\/([a-z2-7]{12})\/versions$/);
  if (g && m === "POST") return commit(req, env, id, g[1]);
  g = p.match(/^\/api\/share\/collections\/([a-z2-7]{12})$/);
  if (g && m === "DELETE") {
    const c = await env.SHARE_DB.prepare("SELECT owner FROM collections WHERE id = ?1").bind(g[1]).first<{ owner: string }>();
    if (!c || c.owner !== id) return err(404, "no such collection");
    const rid = crypto.randomUUID();
    await env.SHARE_DB.prepare("INSERT INTO purges (request_id, account_id, collection, status, created) VALUES (?1, ?2, ?3, 'pending', ?4)").bind(rid, id, g[1], now()).run();
    await runPurge(env, rid);
    return json({ ok: true });
  }
  if (p === "/api/share/delete-everything" && m === "POST") {
    const b = (await req.json().catch(() => null)) as { confirm?: string } | null;
    if (b?.confirm !== "delete") return err(400, 'send {"confirm": "delete"}');
    const rid = crypto.randomUUID();
    await env.SHARE_DB.prepare("INSERT INTO purges (request_id, account_id, collection, status, created) VALUES (?1, ?2, NULL, 'pending', ?3)").bind(rid, id, now()).run();
    await runPurge(env, rid);
    return json({ ok: true, request_id: rid }, 200, { "set-cookie": cookie(SESSION, "", 0) });
  }
  return err(404, "not found");
}

export { ID as COLLECTION_ID };
