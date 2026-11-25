// The browser channel's relay admission (design agent-autonomous-browser-channel.md r4.1 §5) in the pure core: the two
// authenticated opens' exact form, the replacement authorization's closed body, and async verifiers for a page or a
// Worker (the fleet Worker's /relay/admit, agent-autonomous-browser-relay.md r2.1). These verifiers consume nothing:
// each returns the host's nonce or the app's request id, and the live relay consumes them once it has admitted the
// open. ../channel/relay.mjs is Node's synchronous face over the same forms (it consumes through its ctx), with the
// broker's signing side and the fake relay.

import { enc, isId, refuse, unb64 } from "./bytes.mjs";
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

/** The open's request target for these fields, in the one fixed order. */
export function openTarget(f) {
  return `${ROUTE}?${QUERY.map((k) => `${k}=${f[k]}`).join("&")}`;
}

/** The fields of an open's request target: exactly the route and its seven query fields, in order, each in its form. */
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
  return f;
}

/** The headers' total size as the first parser counts it (names, values, ": " and CRLF), in UTF-8 bytes. */
export const headerBytes = (headers) => {
  const te = new TextEncoder();
  return Object.entries(headers).reduce((n, [k, v]) => n + te.encode(k).length + te.encode(String(v)).length + 4, 0);
};

/** The app open's two headers, in form: { rec, id }. */
export function appHeaders(headers) {
  const rec = headers["sagebrush-browser-record"], id = headers["sagebrush-request"];
  if (typeof rec !== "string" || rec.length > RECORD_HEADER_MAX) refuse("limit", "the record header");
  if (!B64.test(rec)) refuse("bad_form", "the record header isn't base64url");
  if (typeof id !== "string" || !B22.test(id)) refuse("bad_form", "the request id");
  return { rec, id };
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
 * The app's open (§5.3). ctx: { aud, now, accountFleets() -> ids (the session's own account), chainOf(fleet) -> the
 * fleet's chain state, currentGen(host) }. Returns the open's identity, with the request id for the caller to consume.
 */
export async function verifyAppOpen({ target, headers }, ctx) {
  if (headerBytes(headers) > HEADERS_MAX) refuse("limit", "the request's headers");
  const { rec, id } = appHeaders(headers);
  const f = parseOpenTarget(target);
  if (f.role !== "app") refuse("bad_form", "not an app open");
  if (!ctx.accountFleets().includes(f.fleet)) refuse("not_granted", "another account's fleet");
  const env = await openByDevice(unb64(rec), { aud: ctx.aud, fleet: f.fleet, chain: ctx.chainOf(f.fleet) }, "sb.browser-session.v1", "browser-session");
  return appRecord(env, f, id, ctx);
}

/** The app open's checks after its record is opened (one source for both faces). */
export function appRecord(env, f, id, ctx) {
  const r = env.body;
  for (const k of ["fleet", "session", "agent", "browser_gen", "host_gen"]) if (r[k] !== f[k]) refuse("bad_form", `the record's ${k} isn't the open's`);
  if (ctx.now < r.not_before_ms || ctx.now >= r.not_after_ms) refuse("grant_expired", "outside the record's window");
  if (ctx.currentGen(r.host) !== f.host_gen) refuse("stale_generation");
  return { ...f, host: r.host, request: id, not_after_ms: r.not_after_ms, signer: env.signer.id, chain_seq: r.chain_seq };
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
