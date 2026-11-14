// WorkOS AuthKit as a sign-in provider: the authorize URL, the server-side code exchange, the access token's
// verification, and a session's revocation.  The account is never WorkOS's: a verified token only names who signed
// in, by (issuer, subject), and the caller maps that to an account of its own.
//
// The token check is jose's (a maintained verifier), with everything pinned by the caller's configuration, never
// learned from the token: the exact issuer, RS256 only, this client's id, finite exp and iat (nbf honoured), and a
// non-empty WorkOS user id and session id.  Keys come from this client's JWKS, cached per (environment, client,
// issuer), fetched with a deadline and a size cap; a key id the cache doesn't know refreshes it at most once a minute.
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

interface CacheEntry { keys: JSONWebKeySet; at: number }
const caches = new Map<string, CacheEntry>();
const cacheKey = (c: WorkosConfig) => `${c.env}\n${c.clientId}\n${c.issuer}`;
/** Tests only: forget every cached key set. */
export function clearKeyCache(): void {
  caches.clear();
}

async function fetchKeys(c: WorkosConfig, f: Fetch): Promise<JSONWebKeySet> {
  const r = await f(`${api(c)}/sso/jwks/${encodeURIComponent(c.clientId)}`, { signal: AbortSignal.timeout(DEADLINE_MS) });
  if (!r.ok) throw new Error(`jwks ${r.status}`);
  const j = (await boundedJson(r, JWKS_MAX_BYTES)) as { keys?: unknown } | null;
  if (!j || !Array.isArray(j.keys)) throw new Error("jwks shape");
  return { keys: j.keys as JSONWebKeySet["keys"] };
}

/** This client's key set: cached, or fetched when there is none, it's older than its TTL, or `refresh` and the last
 * fetch is over a minute old.  Throws when it can't be fetched and nothing usable is cached. */
async function keySet(c: WorkosConfig, f: Fetch, now: number, refresh: boolean): Promise<{ keys: JSONWebKeySet; fresh: boolean }> {
  const k = cacheKey(c);
  const e = caches.get(k);
  if (e && now - e.at <= JWKS_TTL_MS && !(refresh && now - e.at > KID_REFRESH_MS)) return { keys: e.keys, fresh: false };
  const keys = await fetchKeys(c, f);
  caches.set(k, { keys, at: now });
  return { keys, fresh: true };
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
    let ks: { keys: JSONWebKeySet; fresh: boolean };
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
      // (a key id we don't know: the keys may have rotated; refetch once, at most once a minute, then it's invalid)
      if (e instanceof errors.JWKSNoMatchingKey && attempt === 0 && !ks.fresh) continue;
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

/** Revoke a WorkOS session: "revoked" only on WorkOS's success; anything else is for the caller to retry. */
export async function revokeSession(c: WorkosConfig, sid: string, f: Fetch = defaultFetch): Promise<"revoked" | "failed"> {
  if (!SID.test(sid)) return "failed";
  try {
    const r = await f(`${api(c)}/user_management/sessions/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${c.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ session_id: sid }),
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    return r.ok ? "revoked" : "failed";
  } catch {
    return "failed";
  }
}
