// The endpoint policy and every outbound fetch (plan-lti-r5 §2.2, §7.1, §17.1).

import { byteLength, canonicalJson, LtiError, sha256Hex } from "./util.ts";

export interface Policy {
  /** an identifier, compared exactly, never fetched */
  issuer: string;
  auth_endpoint: string;
  jwks_uri: string;
  token_endpoint: string;
  token_aud?: string;
  /** origins (https://host) for AGS, NRPS and their pagination */
  service_origins: string[];
  /** origins allowed in frame-ancestors */
  framing_origins: string[];
  /** the platform-storage postMessage target origin */
  storage_origin?: string;
  token_deployment_claim: "none" | "assertion";
  services: { ags: boolean; nrps: boolean };
}

export type Category = "auth_endpoint" | "jwks_uri" | "token_endpoint" | "service" | "bootstrap";

/** The environments.  `vm-test` alone may name `.vmtest` hosts (§2.2, §12). */
export type EnvName = "prod" | "dev" | "vm-test";

const FORBIDDEN_SUFFIXES = [".local", ".internal", ".localhost", ".vmtest", ".test", ".invalid", ".example", ".arpa"];

/** True iff `host` is a name §2.2 never fetches in this environment. */
export function forbiddenHost(host: string, env: EnvName): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".")) return true;
  // IP literals, v4 and v6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[") || /^[0-9a-f:]+$/.test(h) && h.includes(":")) return true;
  if (/^0x|^\d+$/.test(h)) return true;
  if (!h.includes(".")) return true;
  if (env === "vm-test" && h.endsWith(".vmtest")) return false;
  return FORBIDDEN_SUFFIXES.some((s) => h.endsWith(s));
}

/**
 * Parse and check a URL against §2.2's rules, apart from the category's hosts:
 * https only, port 443 or none, no userinfo, no fragment, no forbidden name.
 */
export function checkedUrl(raw: string, env: EnvName, maxLength = 400): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new LtiError(400, "bad_url");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.hash || (u.port !== "" && u.port !== "443")) throw new LtiError(400, "bad_url");
  if (forbiddenHost(u.hostname, env)) throw new LtiError(400, "forbidden_host");
  // (400 B for a URL kept in a policy; the bootstrap URLs may carry a registration token in their query: 4 KiB).
  // Encoded UTF-8 bytes, not UTF-16 units (LIMIT-STAGEA3-1), both as given and as serialized: what is sent is the
  // percent-encoded href, up to 3 times the raw bytes of a non-ASCII URL.  Every redirect target comes through here.
  if (byteLength(raw) > maxLength || byteLength(u.href) > maxLength) throw new LtiError(400, "bad_url");
  return u;
}

export function hostOf(urlOrOrigin: string): string {
  return new URL(urlOrOrigin).hostname.toLowerCase();
}

/** The exact hosts a category allows under a policy (bootstrap hosts come from the code, §7.1). */
export function categoryHosts(p: Policy | null, category: Category, bootstrapHosts: string[] = []): Set<string> {
  if (category === "bootstrap") return new Set(bootstrapHosts.map((h) => h.toLowerCase()));
  if (!p) return new Set();
  switch (category) {
    case "auth_endpoint":
      return new Set([hostOf(p.auth_endpoint)]);
    case "jwks_uri":
      return new Set([hostOf(p.jwks_uri)]);
    case "token_endpoint":
      return new Set([hostOf(p.token_endpoint)]);
    case "service":
      return new Set(p.service_origins.map(hostOf));
  }
}

export interface FetchLimits {
  /** decoded body cap, bytes */
  maxBytes: number;
  timeoutMs: number;
  /** at most this many redirects, each re-checked (§2.2: 2) */
  maxRedirects?: number;
  /** the longest URL accepted (400 B for policy URLs; 4 KiB for dynamic registration's bootstrap URLs) */
  maxUrlLength?: number;
}

export interface TrustedFetchResult {
  status: number;
  url: string;
  body: string;
  headers: Headers;
}

/**
 * The one outbound fetch (§2.2).  The URL and every redirect target must pass
 * the category's check; the credential is attached only to a checked URL; the
 * body is read through a counting reader that stops at the cap; a timeout
 * bounds the whole call.  Reservations are the caller's (`Reg`).
 */
export async function trustedFetch(
  env: EnvName,
  hosts: Set<string>,
  url: string,
  init: { method?: "GET" | "POST"; body?: string; contentType?: string; bearer?: string; accept?: string },
  limits: FetchLimits,
  fetcher: (req: Request) => Promise<Response> = (r) => fetch(r),
): Promise<TrustedFetchResult> {
  const maxRedirects = limits.maxRedirects ?? 2;
  let current = url;
  const deadline = Date.now() + limits.timeoutMs;
  for (let hop = 0; ; hop++) {
    const u = checkedUrl(current, env, limits.maxUrlLength ?? 400);
    if (!hosts.has(u.hostname.toLowerCase())) throw new LtiError(400, "host_not_in_policy");
    const headers: Record<string, string> = { accept: init.accept ?? "application/json" };
    if (init.contentType) headers["content-type"] = init.contentType;
    // (the credential is attached only now, after every check)
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(1, deadline - Date.now()));
    let res: Response;
    try {
      res = await fetcher(new Request(u.toString(), { method: hop === 0 ? (init.method ?? "GET") : (init.method === "POST" ? "POST" : "GET"), headers, body: init.body, redirect: "manual", signal: ctl.signal }));
    } catch {
      clearTimeout(timer);
      throw new LtiError(502, "fetch_failed");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      clearTimeout(timer);
      await res.body?.cancel();
      if (hop >= maxRedirects) throw new LtiError(502, "too_many_redirects");
      current = new URL(res.headers.get("location")!, u).toString();
      // (a POST is never re-sent to a redirect target: a 307/308 would re-post the credential's body)
      if (init.method === "POST" && res.status !== 303) throw new LtiError(502, "redirected_post");
      if (init.method === "POST") init = { ...init, method: "GET", body: undefined, contentType: undefined };
      continue;
    }
    try {
      const body = await readCapped(res, limits.maxBytes);
      return { status: res.status, url: u.toString(), body, headers: res.headers };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  const cl = res.headers.get("content-length");
  if (cl !== null && Number(cl) > max) {
    await res.body?.cancel();
    throw new LtiError(502, "response_too_large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel();
      throw new LtiError(502, "response_too_large");
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.length;
  }
  return new TextDecoder().decode(all);
}

/** §17.1: SHA-256 over the canonical JSON of the whole policy. */
export async function policyDigest(p: Policy): Promise<string> {
  return sha256Hex(canonicalJson(normalized(p)));
}

function normalized(p: Policy): Policy {
  return {
    ...p,
    service_origins: [...new Set(p.service_origins)].sort(),
    framing_origins: [...new Set(p.framing_origins)].sort(),
  };
}

/** The presets (§7.1, §17.1).  A preset expands to exact hosts per category, from the hosts the admin typed. */
export type Preset = "canvas-cloud" | "canvas-self" | "moodle";
export const PRESETS: Preset[] = ["canvas-cloud", "canvas-self", "moodle"];

/**
 * The hosts a preset expects in each category, given the bootstrap hosts the
 * admin typed.  hosted Canvas: `sso.canvaslms.com` for auth, JWKS and token,
 * the institution host for services and framing.  Self-hosted Canvas and
 * Moodle: one host for everything.
 */
export function presetHosts(preset: Preset, bootstrapHosts: string[]): Record<"auth" | "jwks" | "token" | "service" | "framing", string[]> | null {
  const hs = bootstrapHosts.map((h) => h.toLowerCase());
  if (preset === "canvas-cloud") {
    const inst = hs.filter((h) => h !== "sso.canvaslms.com");
    if (inst.length !== 1 || !hs.includes("sso.canvaslms.com")) return null;
    return { auth: ["sso.canvaslms.com"], jwks: ["sso.canvaslms.com"], token: ["sso.canvaslms.com"], service: inst, framing: inst };
  }
  if (hs.length !== 1) return null;
  return { auth: hs, jwks: hs, token: hs, service: hs, framing: hs };
}

/** True iff the proposed policy has exactly the preset's hosts in every category (§17.1). */
export function matchesPreset(p: Policy, preset: Preset, bootstrapHosts: string[]): boolean {
  const want = presetHosts(preset, bootstrapHosts);
  if (!want) return false;
  const eq = (a: string[], b: string[]) => {
    const x = [...new Set(a)].sort(), y = [...new Set(b)].sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
  };
  return (
    eq([hostOf(p.auth_endpoint)], want.auth) &&
    eq([hostOf(p.jwks_uri)], want.jwks) &&
    eq([hostOf(p.token_endpoint)], want.token) &&
    eq(p.service_origins.map(hostOf), want.service) &&
    eq(p.framing_origins.map(hostOf), want.framing) &&
    (p.storage_origin === undefined || eq([hostOf(p.storage_origin)], want.auth))
  );
}

/** Validate a policy's shape and every URL in it (§2.2).  Throws on anything wrong. */
export function validatePolicy(v: unknown, env: EnvName): Policy {
  const o = v as Policy;
  if (!o || typeof o !== "object") throw new LtiError(400, "bad_policy");
  if (typeof o.issuer !== "string" || o.issuer.length < 1 || o.issuer.length > 255) throw new LtiError(400, "bad_policy");
  for (const k of ["auth_endpoint", "jwks_uri", "token_endpoint"] as const) {
    if (typeof o[k] !== "string") throw new LtiError(400, "bad_policy");
    checkedUrl(o[k], env);
  }
  if (o.token_aud !== undefined && (typeof o.token_aud !== "string" || o.token_aud.length > 400)) throw new LtiError(400, "bad_policy");
  for (const k of ["service_origins", "framing_origins"] as const) {
    if (!Array.isArray(o[k]) || o[k].length < 1 || o[k].length > 4) throw new LtiError(400, "bad_policy");
    for (const origin of o[k]) {
      const u = checkedUrl(origin, env);
      if (u.origin !== origin) throw new LtiError(400, "bad_policy");
    }
  }
  if (o.storage_origin !== undefined) {
    const u = checkedUrl(o.storage_origin, env);
    if (u.origin !== o.storage_origin) throw new LtiError(400, "bad_policy");
  }
  if (o.token_deployment_claim !== "none" && o.token_deployment_claim !== "assertion") throw new LtiError(400, "bad_policy");
  if (!o.services || typeof o.services.ags !== "boolean" || typeof o.services.nrps !== "boolean") throw new LtiError(400, "bad_policy");
  return {
    issuer: o.issuer,
    auth_endpoint: o.auth_endpoint,
    jwks_uri: o.jwks_uri,
    token_endpoint: o.token_endpoint,
    ...(o.token_aud !== undefined ? { token_aud: o.token_aud } : {}),
    service_origins: o.service_origins,
    framing_origins: o.framing_origins,
    ...(o.storage_origin !== undefined ? { storage_origin: o.storage_origin } : {}),
    token_deployment_claim: o.token_deployment_claim,
    services: { ags: o.services.ags, nrps: o.services.nrps },
  };
}
