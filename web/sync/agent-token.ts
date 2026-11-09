// Agents' grants and tokens (design/agent-endpoint.md §1, §2, §7; fs-sync step 1a): the token's form and its tag, a
// grant's scopes, and the bounds.  Pure: the Worker checks a token's form and tag here before any object is reached,
// and the account object checks the rest (server.ts, account.ts).
//
// A token is `sbg1.<account hash, 64 hex>.<grant id, 12 base32>.<secret, 32 bytes base64url>.<tag>`, the tag being
// HMAC-SHA256(GRANT_TAG_KEY, "sbg1." + hash + "." + id), its first 16 bytes in base64url (§2).  Only the server can
// make a tag, so a made-up token is refused by the Worker; the account object stores only SHA-256(secret).

import { normPath, within } from "../workspace/paths.ts";
import { enc, same, sha256Hex } from "../sync-protocol/protocol.ts";

export const AGENT = {
  /** a grant's scopes (§1) */
  scopes: 32,
  /** an agent's name, in characters (§2's pairing bound, the same for a grant made by hand) */
  agentChars: 64,
  /** live grants an account may have (§1) */
  liveGrants: 50,
  /** revoked or expired grants kept for the person's list, newest first (rows beyond these are deleted) */
  deadGrants: 50,
  /** a grant's life, in days: by default, and at most (§1) */
  defaultDays: 30,
  maxDays: 90,
  /** each grant's requests (§7) */
  perMinute: 60,
  perHour: 1000,
  /** all of an account's grants together, a minute (inside the account's own limits, §7) */
  accountPerMinute: 300,
  /** a request's JSON body, in bytes: 1a's verbs carry only paths (writes, with content, come in 1b) */
  bodyBytes: 64 << 10,
  /** the access log (§8): 90 days and 100,000 rows; a refusal is logged at most once a minute per grant (§2) */
  logDays: 90,
  logRows: 100_000,
  /** rows past the log's age deleted by one alarm step */
  logSweep: 1000,
  refusalLogMs: 60_000,
  /** a page of the person's view of the log */
  logPage: 100,
};

const B64 = /^[A-Za-z0-9_-]+$/;
const TOKEN = /^sbg1\.([0-9a-f]{64})\.([a-z2-7]{12})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/;
export const GRANT_ID = /^[a-z2-7]{12}$/;

export function b64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new grant id: 12 base32 characters (60 random bits). */
export function newGrantId(): string {
  const a = "abcdefghijklmnopqrstuvwxyz234567";
  return [...crypto.getRandomValues(new Uint8Array(12))].map((x) => a[x & 31]).join("");
}

/** A new secret: 32 random bytes, base64url (43 characters). */
export const newSecret = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

/** What the account object stores of a secret, and compares in constant time. */
export const secretHash = (secret: string) => sha256Hex("sagebrush-grant-secret\n" + secret);

/** The tag of a grant's token (§2): only a holder of GRANT_TAG_KEY can make one. */
export async function tagOf(key: string, hash: string, id: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode("sbg1." + hash + "." + id))).subarray(0, 16));
}

export async function makeToken(key: string, hash: string, id: string, secret: string): Promise<string> {
  return `sbg1.${hash}.${id}.${secret}.${await tagOf(key, hash, id)}`;
}

export type Token = { hash: string; id: string; secret: string };

/**
 * The token in an Authorization header, if its form is exact and its tag is the server's; else null.  Nothing else
 * is read first, and nothing is named by the hash until this passes (§2).
 */
export async function tokenOf(authorization: string | null, key: string): Promise<Token | null> {
  const m = /^Bearer (\S+)$/.exec(authorization ?? "");
  const t = m ? TOKEN.exec(m[1]) : null;
  if (!t || !B64.test(t[4])) return null;
  if (!same(await tagOf(key, t[1], t[2]), t[4])) return null;
  return { hash: t[1], id: t[2], secret: t[3] };
}

export type Access = "read" | "write";
export type Scope = { path: string; access: Access };

/**
 * A grant's scopes as the person gave them, checked and normalized (§1): 1 to 32, each `{path, access}` with nothing
 * else, its path as normPath makes it (one it refuses is refused), no path twice.  Throws a message on any problem.
 */
export function checkScopes(v: unknown): Scope[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > AGENT.scopes) throw new Error(`scopes: 1 to ${AGENT.scopes}`);
  const out: Scope[] = [];
  for (const s of v) {
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("a scope is {path, access}");
    const keys = Object.keys(s);
    if (keys.length !== 2 || !keys.includes("path") || !keys.includes("access")) throw new Error("a scope is {path, access}");
    const { path, access } = s as { path: unknown; access: unknown };
    if (access !== "read" && access !== "write") throw new Error('access is "read" or "write"');
    let p: string;
    try {
      p = normPath(path);
    } catch {
      throw new Error("a scope's path: " + JSON.stringify(String(path)).slice(0, 80));
    }
    if (out.some((o) => o.path === p)) throw new Error("a path twice: " + p);
    out.push({ path: p, access });
  }
  return out;
}

/** Whether `path` (normalized) is inside a scope with `need`: whole segments, so "/Algebra" never covers "/Algebra2". */
export function inScope(scopes: Scope[], path: string, need: Access): boolean {
  return scopes.some((s) => within(path, s.path) && (need === "read" || s.access === "write"));
}

/** An agent's name as the person sees it: 1 to 64 characters, no control characters. */
export function checkAgentName(v: unknown): string {
  if (typeof v !== "string") throw new Error("agent: a name");
  const n = v.trim();
  if (n.length < 1 || [...n].length > AGENT.agentChars || /[\u0000-\u001f\u007f-\u009f]/.test(n)) throw new Error(`agent: 1 to ${AGENT.agentChars} characters, no control characters`);
  return n;
}

/**
 * The verbs of the endpoint, `/api/agent/v1/<verb>` (§4): the workspace API's, by their names without "workspace.".
 * In step 1a only list and stat are checked as far as their scope, and all of them answer 404 `not_built`.
 */
export const VERBS = new Set(["list", "stat", "read", "write", "create", "mkdir", "rename", "duplicate", "remove", "restore", "history", "version"]);
/** The verbs that only read (§4's table): every other needs write access. */
export const READS = new Set(["list", "stat", "read", "history", "version"]);
/** Verbs 1a checks up to their scope: the path each names, by its param (web/workspace/schema.json). */
export const SCOPED: Record<string, string> = { list: "folder", stat: "path" };
