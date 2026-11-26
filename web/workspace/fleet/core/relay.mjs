// The browser channel's relay admission (design agent-autonomous-browser-channel.md r4.1 §5) in the pure core: the two
// authenticated opens' exact form, the replacement authorization's closed body, and async verifiers for a page or a
// Worker (the fleet Worker's /relay/admit, agent-autonomous-browser-relay.md r2.1). These verifiers consume no nonce
// or request id: each returns the host's nonce or the app's request id, and the live relay consumes them once it has
// admitted the open. The one thing consumed here is the app open's relay token (channel addendum A1 §3), through
// ctx.consumeAppToken, before any other check of the open: one presentation per token, whatever the outcome.
// ../channel/relay.mjs is Node's face over the same forms (it consumes through its ctx), with the broker's signing
// side and the fake relay.

import { enc, isId, refuse, sha256b64, unb64 } from "./bytes.mjs";
import { canonText, parseCanonical } from "./canonical.mjs";
import { verifyRequest } from "./request.mjs";
import { openByDevice } from "./verify.mjs";

export const ROUTE = "/api/fleet/v1/relay/browser";
export const COMMIT_ROUTE = `${ROUTE}/commit`;
export const RECORD_HEADER_MAX = 87252; // (the 65,439-byte record, base64url: ceil(65439 * 4 / 3))
export const HEADERS_MAX = 98304;       // (the whole header block, at the first parser)
const QUERY = ["role", "fleet", "session", "agent", "browser_gen", "host_gen", "resume_n"];
const COMMIT_KEYS = ["agent", "app_request", "browser_gen", "fleet", "host_nonce", "resume_n", "session"];
const COMMIT_MAX = 1024;
const COUNT = /^(0|[1-9][0-9]{0,15})$/;
export const B22 = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const B64 = /^[A-Za-z0-9_-]*$/;
const EMPTY = new Uint8Array(0);

// ---- the app open's relay token (addendum A1): `rt1.` and 32 CSPRNG bytes, base64url; opaque, 60 s, one use
export const APP_TOKEN = /^rt1\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const APP_TOKEN_ROUTE = "/api/fleet/v1/relay/app-token";
export const APP_TOKEN_MS = 60_000;
const TOKEN_KEYS = ["agent", "browser_gen", "fleet", "host", "host_gen", "request", "resume_n", "session"];
const TOKEN_BODY_MAX = 1024;
/** The key the service keeps a token's row under: base64url SHA-256 of the token's UTF-8 bytes; never the token. */
export const appTokenKey = (token) => sha256b64(enc(token));

/**
 * The issuer's request body (A1 §2), closed: canonical bytes, exactly its eight fields, each in its O6 form. Returns
 * the binding the row keeps.
 */
export function parseAppTokenRequest(body) {
  if (!(body instanceof Uint8Array)) refuse("bad_form", "the token request's body");
  const b = parseCanonical(body, TOKEN_BODY_MAX);
  if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).sort().join() !== TOKEN_KEYS.join()) refuse("bad_form", "the token request's fields");
  if (!isId(b.fleet) || !isId(b.host) || !isId(b.agent) || !isId(b.session) || !B22.test(b.request)
    || !Number.isSafeInteger(b.browser_gen) || b.browser_gen < 1 || !Number.isSafeInteger(b.host_gen) || b.host_gen < 1
    || !Number.isSafeInteger(b.resume_n) || b.resume_n < 0) refuse("bad_form", "a token request field's form");
  return Object.freeze({ fleet: b.fleet, host: b.host, agent: b.agent, browser_gen: b.browser_gen, session: b.session, host_gen: b.host_gen, resume_n: b.resume_n, request: b.request });
}
/** The issuer's request body for a binding: canonical. */
export const appTokenRequest = (b) => enc(canonText({ fleet: b.fleet, host: b.host, agent: b.agent, browser_gen: b.browser_gen, session: b.session, host_gen: b.host_gen, resume_n: b.resume_n, request: b.request }));

/**
 * A1 §3 steps 3-5, on the row the consumption took (null: none): the token's expiry, the account session live now,
 * and the row's binding equal to the open's query and request id. Returns the row.
 */
export async function checkAppTokenRow(row, f, id, ctx) {
  if (!row) refuse("unauthenticated", "the relay token");
  if (!(ctx.now < row.expires_ms)) refuse("unauthenticated", "the relay token");
  if ((await ctx.sessionLive(row.account, row.account_session)) !== true) refuse("unauthenticated", "the account session");
  for (const k of ["fleet", "agent", "browser_gen", "session", "host_gen", "resume_n"]) if (row[k] !== f[k]) refuse("bad_form", `the token's ${k} isn't the open's`);
  if (row.request !== id) refuse("bad_form", "the token's request id isn't the open's");
  return row;
}

/** The open's request target for these fields, in the one fixed order. */
export function openTarget(f) {
  return `${ROUTE}?${QUERY.map((k) => `${k}=${f[k]}`).join("&")}`;
}

/**
 * @typedef {{ role: "host" | "app", fleet: string, session: string, agent: string, browser_gen: number, host_gen: number, resume_n: number }} OpenTarget
 */

/**
 * The fields of an open's request target: exactly the route and its seven query fields, in order, each in its form.
 * @returns {OpenTarget}
 */
export function parseOpenTarget(target) {
  if (typeof target !== "string" || target.length > 512 || !target.startsWith(`${ROUTE}?`)) refuse("bad_form", "not the relay's route");
  const parts = target.slice(ROUTE.length + 1).split("&");
  if (parts.length !== QUERY.length) refuse("bad_form", "the relay route takes exactly its seven fields");
  const f = {};
  parts.forEach((p, i) => {
    const eq = p.indexOf("=");
    if (eq < 1 || p.slice(0, eq) !== QUERY[i]) refuse("bad_form", "a relay field out of place");
    f[QUERY[i]] = p.slice(eq + 1);
  });
  if (f.role !== "host" && f.role !== "app") refuse("bad_form", "the role is host or app");
  for (const k of ["fleet", "session", "agent"]) if (!isId(f[k])) refuse("bad_form", `${k} isn't an id`);
  for (const k of ["browser_gen", "host_gen", "resume_n"]) {
    if (!COUNT.test(f[k]) || !Number.isSafeInteger(Number(f[k]))) refuse("bad_form", `${k} isn't an exact count`);
    f[k] = Number(f[k]);
  }
  if (f.browser_gen < 1 || f.host_gen < 1) refuse("bad_form", "generations start at 1");
  // (typed for a checker reading this file: the fields were built one by one above, each checked in its form)
  return /** @type {OpenTarget} */ (f);
}

/** The headers' total size as the first parser counts it (names, values, ": " and CRLF), in UTF-8 bytes. */
export const headerBytes = (headers) => {
  const te = new TextEncoder();
  return Object.entries(headers).reduce((n, [k, v]) => n + te.encode(k).length + te.encode(String(v)).length + 4, 0);
};

/** The app open's three headers, in form: { token, rec, id }. The token's form first: without one, nothing else. */
export function appHeaders(headers) {
  const token = headers["sagebrush-relay-token"], rec = headers["sagebrush-browser-record"], id = headers["sagebrush-request"];
  if (typeof token !== "string" || !APP_TOKEN.test(token)) refuse("unauthenticated", "the relay token");
  if (typeof rec !== "string" || rec.length > RECORD_HEADER_MAX) refuse("limit", "the record header");
  if (!B64.test(rec)) refuse("bad_form", "the record header isn't base64url");
  if (typeof id !== "string" || !B22.test(id)) refuse("bad_form", "the request id");
  return { token, rec, id };
}

/** A host open's signature fields after verifyRequest: no agent, capability or idem, and signed at the open's host_gen. */
export function checkHostSig(sig, f) {
  if (sig.agent !== "-" || sig.cap !== "-" || sig.idem !== "-") refuse("bad_form", "a host operation carries no agent, capability or idem");
  if (Number(sig.gen) !== f.host_gen) refuse("stale_generation", "the signature's gen isn't the open's host_gen");
}

/**
 * The host's open (§5.2): an O6 §5.1-signed upgrade. ctx: core verifyRequest's ({ aud, now, hostKey, currentGen })
 * and agentHasBrowser(host, agent). Returns the open's identity, with the nonce for the caller to consume.
 */
export async function verifyHostOpen({ target, headers }, ctx) {
  if (headerBytes(headers) > HEADERS_MAX) refuse("limit", "the request's headers");
  const f = parseOpenTarget(target);
  if (f.role !== "host") refuse("bad_form", "not a host open");
  const sig = await verifyRequest({ header: headers["sagebrush-sig"], method: "GET", target, body: EMPTY }, ctx);
  checkHostSig(sig, f);
  if (!ctx.agentHasBrowser(sig.host, f.agent)) refuse("not_granted", "the agent has no browser in the current grant");
  return Object.freeze({ ...f, host: sig.host, nonce: sig.nonce });
}

/**
 * The app's open (§5.3 as A1 amends it). ctx: { aud, now, consumeAppToken(key) -> the row taken and deleted, atomically,
 * or null; sessionLive(account, account_session) -> true if live now; chainOf(fleet) -> the fleet's chain state;
 * currentGen(host); afterToken(row), optional: awaited after the token is taken and its row checked, and before the
 * record is read, so a caller's reads of its own state come after the one-use token is spent }. In A1 §3's order: the
 * form, the token consumed, its row's checks, then the record, independently. Returns the open's identity, with the
 * account, its session and the request id for the caller to consume.
 */
export async function verifyAppOpen({ target, headers }, ctx) {
  if (headerBytes(headers) > HEADERS_MAX) refuse("limit", "the request's headers");
  const { token, rec, id } = appHeaders(headers);
  const f = parseOpenTarget(target);
  if (f.role !== "app") refuse("bad_form", "not an app open");
  const row = await checkAppTokenRow(await ctx.consumeAppToken(await appTokenKey(token)), f, id, ctx);
  if (ctx.afterToken) await ctx.afterToken(row);
  const env = await openByDevice(unb64(rec), { aud: ctx.aud, fleet: f.fleet, chain: ctx.chainOf(f.fleet) }, "sb.browser-session.v1", "browser-session");
  return appRecord(env, f, id, ctx, row);
}

/** The app open's checks after its record is opened (one source for both faces); the record's host is the token's. */
export function appRecord(env, f, id, ctx, row) {
  const r = env.body;
  for (const k of ["fleet", "session", "agent", "browser_gen", "host_gen"]) if (r[k] !== f[k]) refuse("bad_form", `the record's ${k} isn't the open's`);
  if (ctx.now < r.not_before_ms || ctx.now >= r.not_after_ms) refuse("grant_expired", "outside the record's window");
  if (ctx.currentGen(r.host) !== f.host_gen) refuse("stale_generation");
  if (r.host !== row.host) refuse("bad_form", "the record's host isn't the token's");
  return { ...f, host: r.host, request: id, not_after_ms: r.not_after_ms, signer: env.signer.id, chain_seq: r.chain_seq, account: row.account, account_session: row.account_session };
}

// ---- the replacement authorization (§5.4): the broker, after its compare-and-set, names one candidate pair

/** The authorization's body: its seven fields, canonical. */
export const commitBody = (c) => enc(canonText({ fleet: c.fleet, session: c.session, agent: c.agent, browser_gen: c.browser_gen, resume_n: c.resume_n, host_nonce: c.host_nonce, app_request: c.app_request }));

/**
 * An authorization's body, closed: canonical bytes (so they are commitBody of what they parse to), exactly its seven
 * fields, each in its form.
 */
export function parseCommit(body) {
  if (!(body instanceof Uint8Array)) refuse("bad_form", "the authorization's body");
  const c = parseCanonical(body, COMMIT_MAX);
  if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).sort().join() !== COMMIT_KEYS.join()) refuse("bad_form", "the authorization's fields");
  if (!isId(c.fleet) || !isId(c.session) || !isId(c.agent) || !B22.test(c.host_nonce) || !B22.test(c.app_request)
    || !Number.isSafeInteger(c.browser_gen) || c.browser_gen < 1 || !Number.isSafeInteger(c.resume_n) || c.resume_n < 0) refuse("bad_form", "an authorization field's form");
  return c;
}

/**
 * Verify an authorization and return what it names, with its signer's host and gen and the nonce for the caller to
 * consume. ctx as core verifyRequest's.
 */
export async function verifyCommit({ header, body }, ctx) {
  const sig = await verifyRequest({ header, method: "POST", target: COMMIT_ROUTE, body }, ctx);
  const c = parseCommit(body);
  return Object.freeze({ ...c, host: sig.host, gen: Number(sig.gen), nonce: sig.nonce });
}
