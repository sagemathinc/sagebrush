// The fleet Worker's grant read as a pure handler (the grant intake's service side; the grant-read note r0.4):
//
//   GET /api/fleet/v1/host/grant[?gen=<n>]    a host's signed read; 200: { gen, grant, pairs }
//
// A host learns its grant, and the { transfer, receipt } pairs of the agents moved to it, from this ONE read: without
// `gen` its newest accepted grant, with `gen` exactly that generation (any accepted one, below the host's current one
// included: a pair lives only in its own generation's applying request, so a host that missed generations reads each).
// `grant` is the grant's stored text and `pairs` the applying request's stored result, byte for byte, in request order.
// Nothing in the answer is trusted for what it says: the host verifies the grant and every pair with its own core
// (verifyGrant, verifyTransferReceipt, checkTransferForHost), so a dishonest service can withhold but never widen. A
// WITHHELD pair (an answer with one pair fewer, or []) is valid on its face; what makes it safe is the host's rule that
// a newly moved agent never resumes without its durable pair (the host intake's admission, not this module).
//
// It takes the request as data ({ method, target, scheme, source, header, body }) and a ctx of the Worker's state, and
// returns { status, headers, body }. It holds no state and logs nothing. The Worker reads the body with a cap of 0 + 1
// bytes (any body is refused) and never redirects this route.
//
// ---- The ctx (every read is current: none may be cached across requests)
//
//   aud, now                       the audience; the Worker's own clock, ms. Read once
//   host(host)                     -> { fleet, sign_key (32 raw bytes), revoked } for the CURRENT pairing, or null
//   currentGen(fleet, host)        -> the host's current generation (a positive safe integer)
//   bucket(key, limit, window_ms)  -> true if one more is allowed in the window (ATOMIC, across instances)
//   nonces.spend(d)                -> the chain read's store and contract (chain-service.mjs), SHARED: one nonce domain
//                                     per (fleet, host), so a nonce spent on either host read is a replay on the other
//   grant.read(fleet, host, gen)   -> { gen, bytes, result, n } | null, from ONE statement (below); gen null: newest
//
// ---- grant.read: ONE statement, so the grant and its pairs come from one snapshot (the writer stores both in one
// batch). `bytes` is the accepted grant's stored text; `result` the stored result of the request that applied it (null
// for a grant applied with no transfers); `n` how many stored results name this grant's hash. The writer makes n <= 1
// (a re-apply WITH transfers can only be the exact retry, which stores nothing new): n > 1 is a store fault, a 500.
//
// ---- The generation in the header: as on the chain read, any positive generation up to the host's current one, so a
// host can fetch a grant it hasn't accepted yet while signing with its own. The generation READ is the target's.

import { FleetError, enc, refuse } from "./bytes.mjs";
import { canonText, parseCanonical, SIGNED_MAX } from "./canonical.mjs";
import { AUDIENCES } from "./envelope.mjs";
import { SKEW_MS, parseSig, verifyRequest } from "./request.mjs";

export const GRANT_ROUTE = "/api/fleet/v1/host/grant";
/** The pairs one applying request can store: the writer's TRANSFERS_MAX (web/cloud/fleet/writers.ts). */
export const GRANT_PAIRS_MAX = 64;
/** A stored result's bytes: the writer's RESULT_MAX and the result column's CHECK bound. */
export const GRANT_RESULT_MAX = 1_048_576;
/**
 * The answer's UTF-8 bytes, exactly (the note's §4): the envelope `{"gen":` `,"grant":` `,"pairs":` `}` (26 bytes) and
 * at most 16 digits of gen; the grant embedded as a JSON string, each of its at most SIGNED_MAX bytes at most 2 once
 * escaped (a canonical text has no raw control character), plus its 2 quotes; and the pairs' canonical text, at most
 * GRANT_RESULT_MAX. ONE constant, for this module's encoder and for the host's reader.
 */
export const GRANT_READ_BYTES = 26 + 16 + (2 * SIGNED_MAX + 2) + GRANT_RESULT_MAX;
export const GRANT_READ_MS = 10_000;
export const GRANT_RATE_HOST = Object.freeze({ limit: 60, windowMs: 60_000 });
export const GRANT_RATE_SOURCE = Object.freeze({ limit: 600, windowMs: 60_000 });

const COUNT = /^[1-9][0-9]{0,15}$/;
const STATUS = Object.freeze({
  bad_form: 400, bad_audience: 401, bad_signature: 401, clock_skew: 401, unknown_host: 401, host_revoked: 403,
  no_grant: 404, stale_generation: 409, replay: 409, limit: 413, rate: 429,
});
const HEADERS = Object.freeze({ "content-type": "application/json", "cache-control": "no-store" });
const bare = (status) => ({ status, headers: { "cache-control": "no-store" }, body: new Uint8Array(0) });
const rateRefusal = (rate) => refusal("rate", { retry_after_s: Math.ceil(rate.windowMs / 1000) });
const refusal = (code, extra = {}) => ({ status: STATUS[code], headers: { ...HEADERS }, body: enc(canonText({ error: code, ...extra })) });
const sample = (ctx) => { const t = ctx.now; if (!Number.isSafeInteger(t) || t < 0) throw new Error("the service clock"); return t; };
const isGen = (g) => Number.isSafeInteger(g) && g >= 1;

/** The request target for generation `gen` (null: the newest). */
export function grantTarget(gen = null) {
  if (gen === null) return GRANT_ROUTE;
  if (!isGen(gen)) throw new RangeError("gen: a positive generation");
  return `${GRANT_ROUTE}?gen=${gen}`;
}

/** The generation a target names: null for the newest, else its gen. Anything but the exact grammar is bad_form. */
export function parseGrantTarget(target) {
  if (target === GRANT_ROUTE) return null;
  const q = typeof target === "string" && target.startsWith(`${GRANT_ROUTE}?gen=`) ? target.slice(GRANT_ROUTE.length + 5) : null;
  if (q === null || !COUNT.test(q) || !isGen(Number(q))) refuse("bad_form", "the grant read's target");
  return Number(q);
}

/** The stored pairs as values: [] for none; each exactly { receipt, transfer }, non-empty, at most SIGNED_MAX bytes. */
function storedPairs(result) {
  if (result === null || result === undefined) return [];
  if (typeof result !== "string" || enc(result).length > GRANT_RESULT_MAX) throw new Error("a stored result's form");
  let v;
  try { v = JSON.parse(result); } catch { throw new Error("a stored result that isn't JSON"); }
  if (!Array.isArray(v) || v.length > GRANT_PAIRS_MAX) throw new Error("a stored result's pairs");
  for (const p of v) {
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).sort().join() !== "receipt,transfer") throw new Error("a stored pair's fields");
    for (const s of [p.receipt, p.transfer]) if (typeof s !== "string" || s.length === 0 || enc(s).length > SIGNED_MAX) throw new Error("a stored pair's text");
  }
  return v.map((p) => ({ receipt: p.receipt, transfer: p.transfer }));
}

/**
 * The answer's bytes for one stored row (grant.read's { gen, bytes, result }), `gen` the requested generation (null:
 * the newest, any). The ONE encoder of a grant read. Throws (a store fault, never served) on a row out of form: a
 * generation other than the requested one, a grant over SIGNED_MAX, a result out of form or over GRANT_RESULT_MAX
 * once canonical, or an answer over GRANT_READ_BYTES.
 */
export function grantReadBody(row, gen = null) {
  if (!row || typeof row !== "object" || !isGen(row.gen)) throw new Error("the row's generation");
  if (gen !== null && row.gen !== gen) throw new Error("a generation other than the one read");
  if (typeof row.bytes !== "string" || row.bytes.length === 0 || enc(row.bytes).length > SIGNED_MAX) throw new Error("the stored grant's form");
  // (the pairs' canonical text is never longer than the stored JSON text it was parsed from: canonical JSON has no
  // whitespace and the shortest escapes. So storedPairs' bound on the stored text bounds the encoded pairs too)
  const pairs = storedPairs(row.result);
  const out = enc(canonText({ gen: row.gen, grant: row.bytes, pairs }, GRANT_READ_BYTES * 2));
  if (out.length > GRANT_READ_BYTES) throw new Error("the answer's bytes");
  return out;
}

/**
 * The host's reader of one answer, for a request with `gen` (null: the newest): at most GRANT_READ_BYTES, canonical,
 * exactly { gen, grant, pairs }, gen the requested one when one was named, at most GRANT_PAIRS_MAX pairs each exactly
 * { receipt, transfer } of non-empty strings of at most SIGNED_MAX bytes. Returns { gen, grant, pairs } with each text
 * as its bytes. Everything is still UNVERIFIED: the host verifies the grant and each pair with its own core, and an
 * omitted pair is invisible here (withholding; the intake's admission is what refuses to resume without it).
 */
export function parseGrantRead(bytes, gen = null) {
  if (!(bytes instanceof Uint8Array)) refuse("bad_form", "a grant read's bytes");
  if (bytes.length > GRANT_READ_BYTES) refuse("limit", "a grant read over its bytes");
  const v = parseCanonical(bytes, GRANT_READ_BYTES);
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== "gen,grant,pairs") refuse("bad_form", "a grant read's fields");
  if (!isGen(v.gen) || (gen !== null && v.gen !== gen)) refuse("bad_form", "a grant read's generation");
  if (typeof v.grant !== "string" || v.grant.length === 0 || enc(v.grant).length > SIGNED_MAX) refuse("bad_form", "a grant read's grant");
  if (!Array.isArray(v.pairs) || v.pairs.length > GRANT_PAIRS_MAX) refuse("bad_form", "a grant read's pairs");
  const pairs = v.pairs.map((p) => {
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).sort().join() !== "receipt,transfer") refuse("bad_form", "a pair's fields");
    for (const s of [p.receipt, p.transfer]) if (typeof s !== "string" || s.length === 0 || enc(s).length > SIGNED_MAX) refuse("bad_form", "a pair's text");
    return { transfer: enc(p.transfer), receipt: enc(p.receipt) };
  });
  return { gen: v.gen, grant: enc(v.grant), pairs };
}

/** GET /api/fleet/v1/host/grant. */
export async function handleGrantRead({ method, target, scheme, source, header, body }, ctx) {
  if (typeof target !== "string" || (target !== GRANT_ROUTE && !target.startsWith(`${GRANT_ROUTE}?`))) return bare(404);
  if (method !== "GET") return bare(405);
  if (scheme !== "https") return bare(403);
  if (!(body instanceof Uint8Array)) return bare(400);
  let h, f, gen, now;
  try {
    if (body.length !== 0) refuse("bad_form", "a grant read has no body");
    // (before authentication: a per-source bucket; nothing else is written for an unauthenticated request)
    if (!(await ctx.bucket(`grant-src:${source}`, GRANT_RATE_SOURCE.limit, GRANT_RATE_SOURCE.windowMs))) return rateRefusal(GRANT_RATE_SOURCE);
    // 1. the form: the target, then the header (gen=0 is the header's bad_form), then a host read's fields
    gen = parseGrantTarget(target);
    if (typeof header !== "string") refuse("bad_form", "no Sagebrush-Sig header");
    const p = parseSig(header);
    if (p.agent !== "-" || p.cap !== "-" || p.idem !== "-" || p.op !== "-") refuse("bad_form", "a host read carries no agent, capability or idempotency key");
    // 2-3. aud and the window, on the one clock sample, before any read of the host's authority
    now = sample(ctx);
    if (!AUDIENCES.includes(ctx.aud)) refuse("bad_audience");
    if (Math.abs(Number(p.ts) - now) > SKEW_MS) return refusal("clock_skew", { service_time_ms: now, skew_ms: Number(p.ts) - now });
    // 4-5. the host and its generation, the signature: core verifyRequest, unchanged
    h = await ctx.host(p.host);
    const current = h && !h.revoked ? await ctx.currentGen(h.fleet, p.host) : null;
    try {
      f = await verifyRequest({ header, method, target, body: new Uint8Array(0) }, {
        aud: ctx.aud, now,
        hostKey: () => {
          if (!h) refuse("unknown_host");
          if (h.revoked) refuse("host_revoked");
          return h.sign_key;
        },
        // (the header's range, as on the chain read: any positive generation up to the current one)
        currentGen: () => {
          const g = Number(p.gen);
          if (!Number.isSafeInteger(current) || current < 1 || !(g <= current)) refuse("stale_generation");
          return g;
        },
      });
    } catch (e) {
      if (e instanceof FleetError && e.code === "clock_skew") return refusal("clock_skew", { service_time_ms: now, skew_ms: Number(p.ts) - now });
      throw e;
    }
    if (!(await ctx.bucket(`grant-host:${f.host}`, GRANT_RATE_HOST.limit, GRANT_RATE_HOST.windowMs))) return rateRefusal(GRANT_RATE_HOST);
  } catch (e) {
    const code = e instanceof FleetError ? e.code : null;
    if (code === null || !Object.hasOwn(STATUS, code)) return bare(500);
    return refusal(code);
  }
  // 6. the nonce, spent once the whole request is accepted (in the chain read's store: one domain per fleet and host)
  let row;
  try {
    if (!(await ctx.nonces.spend({ fleet: h.fleet, host: f.host, nonce: f.nonce, now }))) return refusal("replay");
    row = await ctx.grant.read(h.fleet, f.host, gen);
  } catch { return bare(503); }
  if (row === null || row === undefined) return refusal("no_grant");
  // (more than one stored result for one accepted grant: a store fault, nothing served)
  if (!Number.isSafeInteger(row.n) || row.n < 0 || row.n > 1) return bare(500);
  try {
    return { status: 200, headers: { ...HEADERS }, body: grantReadBody(row, gen) };
  } catch {
    return bare(500);
  }
}
