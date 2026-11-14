// WorkOS AuthKit as a sign-in provider: the authorize URL, the server-side code exchange, the access token's
// verification, and a session's revocation.  The account is never WorkOS's: a verified token only names who signed
// in, by (issuer, subject), and the caller maps that to an account of its own.
//
// The token check is jose's (a maintained verifier), with everything pinned by the caller's configuration, never
// learned from the token: the exact issuer, RS256 only, this client's id, finite exp and iat (nbf honoured), and a
// non-empty WorkOS user id and session id.  Keys come from this client's JWKS, cached per (environment, client,
// issuer), fetched with a deadline and a size cap, one fetch at a time per key (concurrent callers share it).  A key id
// the cache doesn't know refreshes it at most once a minute, counting failed attempts; after a failed fetch, a cache
// past its age isn't fetched again for a few seconds.
// "Unavailable" (WorkOS couldn't be asked) is never reported as "invalid", nor the reverse.

import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";

export interface WorkosConfig {
  /** the environment's name ("id-dev", "prod"): part of the key cache's key, so no two environments share keys */
  env: string;
  clientId: string;
  /** the exact issuer this environment's tokens carry, established independently and set in configuration */
  issuer: string;
  apiKey: string;
  /** checked when set */
  audience?: string;
  /** tests only: another API origin */
  api?: string;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type Verified =
  | { ok: true; subject: string; sid: string; claims: JWTPayload }
  | { ok: false; kind: "invalid" | "unavailable"; why: string };

const API = "https://api.workos.com";
const DEADLINE_MS = 3000;
const JWKS_MAX_BYTES = 64 * 1024;
const BODY_MAX_BYTES = 64 * 1024;
const JWKS_TTL_MS = 10 * 60_000;
const KID_REFRESH_MS = 60_000;
/** after a failed fetch, no new one for this long (a cache past its age then answers "unavailable") */
const FAIL_COOLDOWN_MS = 5000;
const TOKEN_MAX = 8192;
/** a token's iat may be at most this far ahead of our clock (seconds) */
const SKEW_S = 60;
const SUBJECT = /^user_[A-Za-z0-9]{1,123}$/;
const SID = /^session_[A-Za-z0-9]{1,120}$/;

const api = (c: WorkosConfig) => c.api ?? API;
const defaultFetch: Fetch = (i, init) => fetch(i, init);

/** A response body as JSON, refused past `max` bytes (read as a stream, so an oversized body is never held whole). */
async function boundedJson(r: Response, max: number): Promise<unknown> {
  if (Number(r.headers.get("content-length") ?? "0") > max) throw new Error("too large");
  if (!r.body) throw new Error("no body");
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new Error("too large");
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all));
}

/** A key set: its keys and when they were fetched (none yet: null), and the last fetch attempt, and whether it failed. */
interface CacheEntry { keys: JSONWebKeySet | null; at: number; tried: number; failed: boolean }
const caches = new Map<string, CacheEntry>();
/** the fetch under way per key: every caller that needs one while it runs waits for the same one */
const inflight = new Map<string, Promise<JSONWebKeySet>>();
const cacheKey = (c: WorkosConfig) => `${c.env}\n${c.clientId}\n${c.issuer}`;
/** Tests only: forget every cached key set and attempt. */
export function clearKeyCache(): void {
  caches.clear();
  inflight.clear();
}

async function fetchKeys(c: WorkosConfig, f: Fetch): Promise<JSONWebKeySet> {
  const r = await f(`${api(c)}/sso/jwks/${encodeURIComponent(c.clientId)}`, { signal: AbortSignal.timeout(DEADLINE_MS) });
  if (!r.ok) throw new Error(`jwks ${r.status}`);
  const j = (await boundedJson(r, JWKS_MAX_BYTES)) as { keys?: unknown } | null;
  if (!j || !Array.isArray(j.keys)) throw new Error("jwks shape");
  return { keys: j.keys as JSONWebKeySet["keys"] };
}

/** The fetch for key `k`: the one under way if there is one, else a new one, recorded as an attempt either way it ends. */
function fetchOnce(k: string, c: WorkosConfig, f: Fetch, now: number): Promise<JSONWebKeySet> {
  const running = inflight.get(k);
  if (running) return running;
  const prev = caches.get(k);
  caches.set(k, { keys: prev?.keys ?? null, at: prev?.at ?? 0, tried: now, failed: false });
  const p = fetchKeys(c, f).then(
    (keys) => {
      caches.set(k, { keys, at: now, tried: now, failed: false });
      return keys;
    },
    (e) => {
      const cur = caches.get(k);
      caches.set(k, { keys: cur?.keys ?? null, at: cur?.at ?? 0, tried: now, failed: true });
      throw e;
    },
  ).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

/**
 * This client's key set.  The cached one while it's younger than its TTL; otherwise fetched, unless a fetch failed
 * within FAIL_COOLDOWN_MS (then "unavailable").  With `refresh` (a key id the cache lacks), fetched again only if no
 * attempt, successful or not, was made within KID_REFRESH_MS; `retry: false` then says not to look again.  Throws
 * "unavailable" when no usable key set can be had.
 */
async function keySet(c: WorkosConfig, f: Fetch, now: number, refresh: boolean): Promise<{ keys: JSONWebKeySet; retry: boolean }> {
  const k = cacheKey(c);
  const e = caches.get(k);
  const current = e?.keys && now - e.at <= JWKS_TTL_MS ? e.keys : null;
  if (current && !refresh) return { keys: current, retry: true };
  if (inflight.has(k)) return { keys: await inflight.get(k)!, retry: false };
  if (refresh && e && now - e.tried <= KID_REFRESH_MS) {
    // (an attempt was made within the minute: no new one; if it failed, we can't say the key doesn't exist)
    if (e.failed || !current) throw new Error("unavailable");
    return { keys: current, retry: false };
  }
  if (!refresh && e?.failed && now - e.tried <= FAIL_COOLDOWN_MS) throw new Error("unavailable");
  return { keys: await fetchOnce(k, c, f, now), retry: false };
}

function ownChecks(c: WorkosConfig, p: JWTPayload, nowS: number): string | null {
  if (typeof p.exp !== "number" || !Number.isFinite(p.exp)) return "exp";
  if (typeof p.iat !== "number" || !Number.isFinite(p.iat)) return "iat";
  if (p.iat > nowS + SKEW_S) return "future";
  if (p.nbf !== undefined && (typeof p.nbf !== "number" || !Number.isFinite(p.nbf))) return "nbf";
  // (this client's token only: another application's or environment's, or a Connect or agent token, is never a sign-in)
  if (p.client_id !== c.clientId) return "client";
  if (typeof p.sub !== "string" || !SUBJECT.test(p.sub)) return "subject";
  if (typeof p.sid !== "string" || !SID.test(p.sid)) return "session";
  return null;
}

/** The access token's subject and session if it is this environment's, for this client, signed, and current. */
export async function verifyAccessToken(c: WorkosConfig, token: unknown, opts: { now?: number; fetch?: Fetch } = {}): Promise<Verified> {
  const now = opts.now ?? Date.now();
  const f = opts.fetch ?? defaultFetch;
  if (typeof token !== "string" || token.length === 0 || token.length > TOKEN_MAX || token.split(".").length !== 3) return { ok: false, kind: "invalid", why: "shape" };
  const opt = { issuer: c.issuer, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "sid", "client_id"], currentDate: new Date(now), ...(c.audience ? { audience: c.audience } : {}) };
  for (let attempt = 0; attempt < 2; attempt++) {
    let ks: { keys: JSONWebKeySet; retry: boolean };
    try {
      ks = await keySet(c, f, now, attempt > 0);
    } catch {
      return { ok: false, kind: "unavailable", why: "jwks" };
    }
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet(ks.keys), opt);
      const why = ownChecks(c, payload, Math.floor(now / 1000));
      return why ? { ok: false, kind: "invalid", why } : { ok: true, subject: payload.sub as string, sid: payload.sid as string, claims: payload };
    } catch (e) {
      // (a key id we don't know: the keys may have rotated; look again once (at most one attempt a minute), then it's invalid)
      if (e instanceof errors.JWKSNoMatchingKey && attempt === 0 && ks.retry) continue;
      return { ok: false, kind: "invalid", why: e instanceof errors.JOSEError ? e.code : "malformed" };
    }
  }
  return { ok: false, kind: "invalid", why: "kid" };
}

/** Where to send the browser: AuthKit's hosted sign-in, with PKCE (S256). */
export function authorizeUrl(c: WorkosConfig, a: { redirectUri: string; state: string; challenge: string; signUp?: boolean }): string {
  const u = new URL(`${api(c)}/user_management/authorize`);
  const q: Record<string, string> = { client_id: c.clientId, redirect_uri: a.redirectUri, response_type: "code", provider: "authkit", state: a.state, code_challenge: a.challenge, code_challenge_method: "S256" };
  if (a.signUp) q.screen_hint = "sign-up";
  u.search = new URLSearchParams(q).toString();
  return u.toString();
}

export type Exchanged =
  | { ok: true; accessToken: string; refreshToken: string | null; method: string | null }
  | { ok: false; kind: "invalid" | "unavailable"; status: number; definite: boolean };

/**
 * The code exchanged for tokens, server-side, with the API key.  `definite`: WorkOS answered, so no session can have
 * been made there; a failure that isn't definite (a timeout, a lost or unreadable answer) may have made one, and the
 * caller must keep accounting for it.
 */
export async function exchangeCode(c: WorkosConfig, code: string, verifier: string, f: Fetch = defaultFetch): Promise<Exchanged> {
  let r: Response;
  try {
    r = await f(`${api(c)}/user_management/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: c.clientId, client_secret: c.apiKey, grant_type: "authorization_code", code, code_verifier: verifier }),
      signal: AbortSignal.timeout(DEADLINE_MS * 2),
    });
  } catch {
    return { ok: false, kind: "unavailable", status: 0, definite: false };
  }
  if (r.status >= 500 || r.status === 429) return { ok: false, kind: "unavailable", status: r.status, definite: true };
  if (!r.ok) return { ok: false, kind: "invalid", status: r.status, definite: true };
  try {
    const j = (await boundedJson(r, BODY_MAX_BYTES)) as { access_token?: unknown; refresh_token?: unknown; authentication_method?: unknown };
    if (typeof j.access_token !== "string") return { ok: false, kind: "invalid", status: r.status, definite: false };
    return { ok: true, accessToken: j.access_token, refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : null, method: typeof j.authentication_method === "string" ? j.authentication_method.slice(0, 40) : null };
  } catch {
    return { ok: false, kind: "unavailable", status: r.status, definite: false };
  }
}

export type Refreshed =
  | { ok: true; accessToken: string; refreshToken: string }
  | { ok: false; kind: "refused" | "unavailable"; status: number };

/**
 * A session refreshed with its refresh token, server-side, with the API key.  WorkOS may rotate the refresh token:
 * the caller stores the one returned.  "refused": WorkOS answered that this token can't be refreshed (a 4xx other
 * than 429: revoked, signed out, the user disabled or deleted, a token already rotated away), so the session ends.
 * "unavailable": WorkOS couldn't be asked or didn't answer usefully (a timeout, 429, 5xx, an unreadable answer), so
 * nothing about the session is known and nothing changes.
 */
export async function refreshSession(c: WorkosConfig, refreshToken: string, f: Fetch = defaultFetch): Promise<Refreshed> {
  let r: Response;
  try {
    r = await f(`${api(c)}/user_management/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: c.clientId, client_secret: c.apiKey, grant_type: "refresh_token", refresh_token: refreshToken }),
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
  } catch {
    return { ok: false, kind: "unavailable", status: 0 };
  }
  if (r.status >= 500 || r.status === 429) return { ok: false, kind: "unavailable", status: r.status };
  if (!r.ok) return { ok: false, kind: "refused", status: r.status };
  try {
    const j = (await boundedJson(r, BODY_MAX_BYTES)) as { access_token?: unknown; refresh_token?: unknown };
    if (typeof j.access_token !== "string" || typeof j.refresh_token !== "string" || j.refresh_token.length === 0 || j.refresh_token.length > TOKEN_MAX) return { ok: false, kind: "unavailable", status: r.status };
    return { ok: true, accessToken: j.access_token, refreshToken: j.refresh_token };
  } catch {
    return { ok: false, kind: "unavailable", status: r.status };
  }
}

/**
 * The WorkOS session id an access token names, read without verifying it: only for revoking a session WorkOS just
 * made for us (the token came straight from our own code exchange) when we won't keep it.  Null unless well formed.
 */
export function sidOf(token: string): string | null {
  try {
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)))) as { sid?: unknown };
    return typeof p.sid === "string" && SID.test(p.sid) ? p.sid : null;
  } catch {
    return null;
  }
}

/**
 * Revoke a WorkOS session: "revoked" on WorkOS's success, or its 404 (no such session: nothing is left to end);
 * anything else is for the caller to retry.
 */
export async function revokeSession(c: WorkosConfig, sid: string, f: Fetch = defaultFetch): Promise<"revoked" | "failed"> {
  if (!SID.test(sid)) return "failed";
  try {
    const r = await f(`${api(c)}/user_management/sessions/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${c.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ session_id: sid }),
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    return r.ok || r.status === 404 ? "revoked" : "failed";
  } catch {
    return "failed";
  }
}
