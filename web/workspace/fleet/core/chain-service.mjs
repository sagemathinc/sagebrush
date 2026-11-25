// The fleet Worker's chain read as a pure handler (r2.5 §2.4, §5.1, §5.3; the chain-read note r1.2):
//
//   GET /api/fleet/v1/host/chain[?after=<seq>]    a host's signed read; 200: { entries, head }
//
// A host pinned below an object's chain_seq fetches the device chain first (§2.4). This route serves the stored
// entries after `seq` (from genesis without `after`), byte for byte, in order, at most CHAIN_PAGE_ENTRIES of them and at
// most CHAIN_PAGE_BYTES of response. Nothing in the response is trusted for what it says: the host verifies every entry
// from its own pin, so a dishonest service can withhold entries (§2.6) but never forge one. `head` only tells the host
// whether to fetch another page. The fleet is the host's own, from its pairing; nothing in the request names one.
//
// It takes the request as data ({ method, target, scheme, source, header, body }) and a ctx of the Worker's state, and
// returns { status, headers, body }. It holds no state and logs nothing. The Worker reads the body with a cap of 0 + 1
// bytes (any body is refused) and never redirects this route.
//
// ---- The ctx (every read is current: none may be cached across requests)
//
//   aud, now                       the audience; the Worker's own clock, ms. Read once, for the window check, the
//                                  nonce's time and the refusal's fields
//   host(host)                     -> { fleet, sign_key (32 raw bytes), revoked } for the CURRENT pairing, or null
//   currentGen(fleet, host)        -> the host's current generation (a positive safe integer)
//   bucket(key, limit, window_ms)  -> true if one more is allowed in the window (ATOMIC, across instances)
//   nonces.spend(d)                -> true if new, false if already spent (ATOMIC, below)
//   chain.page(fleet, after, max)  -> { head, entries: [{ seq, bytes }] } (ONE snapshot, below)
//
// ---- nonces.spend(d), d = { fleet, host, nonce, now }: in ONE atomic write (a single D1 batch), the store deletes
// this host's nonces with created_ms < now - CHAIN_NONCE_KEEP_MS, then inserts (fleet, host, nonce, now) if absent.
// It answers true only if the insert wrote a row. The window is ±5 minutes, so a nonce pruned after 10 minutes belongs
// to a request the window already refuses: the prune never lets a replay in.
//
// ---- chain.page(fleet, after, max): ONE statement, so `head` and the entries come from one snapshot. head is the
// fleet's highest stored seq (-1 before genesis), and the entries are the first `max` of seq > after, in order, as
// stored. An empty page still carries the true head.
//
// ---- The generation (the note's §1.1, SEC's ruling): a host that hasn't accepted generation g + 1 may need the chain
// to verify it, so on THIS route only, gen may be any positive generation up to the current one; a future one is
// stale_generation. gen=0 is the header's bad_form (core parseSig, form first). core verifyRequest is unchanged: this
// route only answers its currentGen question with the request's own gen once it is in range.

import { FleetError, enc, refuse } from "./bytes.mjs";
import { canonText, parseCanonical, SIGNED_MAX } from "./canonical.mjs";
import { AUDIENCES } from "./envelope.mjs";
import { SKEW_MS, parseSig, verifyRequest } from "./request.mjs";

export const CHAIN_ROUTE = "/api/fleet/v1/host/chain";
/** §1.8: the device-chain entries one page holds. */
export const CHAIN_PAGE_ENTRIES = 256;
/** The response's UTF-8 bytes, as sent: the service stops a page before it, and the host's reader refuses more. */
export const CHAIN_PAGE_BYTES = 1_048_576;
export const CHAIN_READ_MS = 10_000;
/** §5.3: nonces are kept 10 minutes. */
export const CHAIN_NONCE_KEEP_MS = 600_000;
export const CHAIN_RATE_HOST = Object.freeze({ limit: 60, windowMs: 60_000 });
export const CHAIN_RATE_SOURCE = Object.freeze({ limit: 600, windowMs: 60_000 });

const COUNT = /^(0|[1-9][0-9]{0,15})$/;
const STATUS = Object.freeze({
  bad_form: 400, bad_audience: 401, bad_signature: 401, clock_skew: 401, unknown_host: 401, host_revoked: 403,
  stale_generation: 409, replay: 409, limit: 413, rate: 429,
});
const HEADERS = Object.freeze({ "content-type": "application/json", "cache-control": "no-store" });
const bare = (status) => ({ status, headers: { "cache-control": "no-store" }, body: new Uint8Array(0) });
/** A rate refusal carries retry_after_s: the bucket's window, a bound on when one more is allowed again (§5.4). */
const rateRefusal = (rate) => refusal("rate", { retry_after_s: Math.ceil(rate.windowMs / 1000) });
const refusal = (code, extra = {}) => ({ status: STATUS[code], headers: { ...HEADERS }, body: enc(canonText({ error: code, ...extra })) });
const sample = (ctx) => { const t = ctx.now; if (!Number.isSafeInteger(t) || t < 0) throw new Error("the service clock"); return t; };

/** The request target for the entries after `after` (null: from genesis). */
export function chainTarget(after = null) {
  if (after === null) return CHAIN_ROUTE;
  if (!Number.isSafeInteger(after) || after < 0) throw new RangeError("after: a seq");
  return `${CHAIN_ROUTE}?after=${after}`;
}

/** The `after` a target names: -1 for genesis, else its seq. Anything but the exact grammar is bad_form. */
export function parseChainTarget(target) {
  if (target === CHAIN_ROUTE) return -1;
  const q = typeof target === "string" && target.startsWith(`${CHAIN_ROUTE}?after=`) ? target.slice(CHAIN_ROUTE.length + 7) : null;
  if (q === null || !COUNT.test(q) || !Number.isSafeInteger(Number(q))) refuse("bad_form", "the chain read's target");
  return Number(q);
}

/**
 * The host's reader of one page, for a request with `after` (-1 from genesis): at most CHAIN_PAGE_BYTES, canonical,
 * exactly { entries, head }, at most CHAIN_PAGE_ENTRIES non-empty strings of at most SIGNED_MAX bytes each, and a head
 * consistent with them. Returns
 * { entries (each entry's bytes), head, next (the `after` of the next page) }. The entries are still unverified:
 * the host replays them from its pin.
 */
export function parseChainPage(bytes, after) {
  if (!(bytes instanceof Uint8Array)) refuse("bad_form", "a chain page's bytes");
  if (bytes.length > CHAIN_PAGE_BYTES) refuse("limit", "a chain page over its bytes");
  const v = parseCanonical(bytes, CHAIN_PAGE_BYTES);
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== "entries,head") refuse("bad_form", "a chain page's fields");
  const { entries, head } = v;
  if (!Number.isSafeInteger(head) || head < -1) refuse("bad_form", "a chain page's head");
  if (!Array.isArray(entries) || entries.length > CHAIN_PAGE_ENTRIES || entries.some((e) => typeof e !== "string" || e.length === 0)) refuse("bad_form", "a chain page's entries");
  const out = entries.map((e) => enc(e));
  // (each entry is one signed object: at most SIGNED_MAX bytes, §1.8)
  if (out.some((e) => e.length > SIGNED_MAX)) refuse("limit", "a chain entry over its bytes");
  // (a page that stops short of a head it names, with nothing in it, would stall the host forever)
  if (head > after && entries.length === 0) refuse("bad_form", "an empty chain page below its head");
  // (no entries and a head at or below `after`: caught up, or a chain shorter than the pin, which the host judges)
  if (entries.length && after + entries.length > head) refuse("bad_form", "a chain page past its head");
  return { entries: out, head, next: after + entries.length };
}

/** GET /api/fleet/v1/host/chain. */
export async function handleChainRead({ method, target, scheme, source, header, body }, ctx) {
  if (typeof target !== "string" || (target !== CHAIN_ROUTE && !target.startsWith(`${CHAIN_ROUTE}?`))) return bare(404);
  if (method !== "GET") return bare(405);
  if (scheme !== "https") return bare(403);
  if (!(body instanceof Uint8Array)) return bare(400);
  let h, f, after, now;
  try {
    if (body.length !== 0) refuse("bad_form", "a chain read has no body");
    // (before authentication: a per-source bucket; nothing else is written for an unauthenticated request)
    if (!(await ctx.bucket(`chain-src:${source}`, CHAIN_RATE_SOURCE.limit, CHAIN_RATE_SOURCE.windowMs))) return rateRefusal(CHAIN_RATE_SOURCE);
    // 1. the form: the target, then the header (gen=0 is the header's bad_form), then a host read's fields
    after = parseChainTarget(target);
    if (typeof header !== "string") refuse("bad_form", "no Sagebrush-Sig header");
    const p = parseSig(header);
    if (p.agent !== "-" || p.cap !== "-" || p.idem !== "-" || p.op !== "-") refuse("bad_form", "a host read carries no agent, capability or idempotency key");
    // 2-3. aud and the window, on the one clock sample, before any read of the host's authority: a stale or misdirected
    // request is refused for what it is, whatever the store would say
    now = sample(ctx);
    if (!AUDIENCES.includes(ctx.aud)) refuse("bad_audience");
    if (Math.abs(Number(p.ts) - now) > SKEW_MS) return refusal("clock_skew", { service_time_ms: now, skew_ms: Number(p.ts) - now });
    // 4-5. the host and its generation, the signature: core verifyRequest, unchanged (its aud and window checks repeat
    // the above on the same sample)
    h = await ctx.host(p.host);
    const current = h && !h.revoked ? await ctx.currentGen(h.fleet, p.host) : null;
    try {
      // (the body was refused above unless empty: the signed digest is the empty body's)
      f = await verifyRequest({ header, method, target, body: new Uint8Array(0) }, {
        aud: ctx.aud, now,
        hostKey: () => {
          if (!h) refuse("unknown_host");
          if (h.revoked) refuse("host_revoked");
          return h.sign_key;
        },
        // (the route's range: any positive generation up to the current one; parseSig already refused 0)
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
    if (!(await ctx.bucket(`chain-host:${f.host}`, CHAIN_RATE_HOST.limit, CHAIN_RATE_HOST.windowMs))) return rateRefusal(CHAIN_RATE_HOST);
  } catch (e) {
    const code = e instanceof FleetError ? e.code : null;
    if (code === null || !Object.hasOwn(STATUS, code)) return bare(500);
    return refusal(code);
  }
  // 6. the nonce, spent once the whole request is accepted (§5.3: reads spend nonces too)
  let page;
  try {
    if (!(await ctx.nonces.spend({ fleet: h.fleet, host: f.host, nonce: f.nonce, now }))) return refusal("replay");
    page = await ctx.chain.page(h.fleet, after, CHAIN_PAGE_ENTRIES);
  } catch { return bare(503); }
  try {
    return { status: 200, headers: { ...HEADERS }, body: pageBody(page, after) };
  } catch {
    // (a gap, a page past its head or over its bytes: a store fault, and nothing is served)
    return bare(500);
  }
}

/** The response's bytes: the page's contiguous entries after `after`, stopped before CHAIN_PAGE_BYTES. */
function pageBody(page, after) {
  const head = page?.head;
  const rows = page?.entries;
  if (!Number.isSafeInteger(head) || head < -1 || !Array.isArray(rows) || rows.length > CHAIN_PAGE_ENTRIES) throw new Error("the page's form");
  // `{"entries":[` + entries joined by `,` + `],"head":` + head + `}`, counted in UTF-8 bytes of each entry's JSON text
  const fixed = enc(`{"entries":[],"head":${head}}`).length;
  const entries = [];
  let size = fixed;
  for (let i = 0; i < rows.length; i++) {
    const { seq, bytes } = rows[i] ?? {};
    if (seq !== after + 1 + i || typeof bytes !== "string" || bytes.length === 0) throw new Error("a gap in the chain's entries");
    // (a stored entry is one signed object, at most SIGNED_MAX UTF-8 bytes: a bigger one is a store fault, never served)
    if (enc(bytes).length > SIGNED_MAX) throw new Error("a stored entry over SIGNED_MAX");
    // (measured past the cap, so an entry too big for any page is this function's refusal below, not the encoder's)
    const add = enc(canonText(bytes, CHAIN_PAGE_BYTES * 2)).length + (entries.length ? 1 : 0);
    if (size + add > CHAIN_PAGE_BYTES) break;
    entries.push(bytes);
    size += add;
  }
  // (an entry exists past `after` but none fit, or entries past the head: never served)
  if (rows.length && !entries.length) throw new Error("an entry over the page's bytes");
  if ((entries.length && after + entries.length > head) || (head > after && rows.length === 0)) throw new Error("the page and its head disagree");
  const out = enc(canonText({ entries, head }, CHAIN_PAGE_BYTES * 2));
  if (out.length !== size || out.length > CHAIN_PAGE_BYTES) throw new Error("the page's bytes");
  return out;
}
