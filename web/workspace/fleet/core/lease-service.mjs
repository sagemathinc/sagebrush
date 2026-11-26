// The fleet Worker's execution-lease endpoint as a pure handler (r2.5 §3.8; the lease-wire note r3 §2.3):
//
//   POST /api/fleet/v1/host/lease    body: a host's sb.lease-request.v1 envelope; 200: an sb.execution-lease.v1 envelope
//
// It takes the request as data ({ method, target, scheme, source, body }) and a ctx of the Worker's state, and returns
// { status, headers, body }. It holds no state and logs nothing. The Worker mounts it, reads the body with a deadline
// (LEASE_READ_MS) and at most LEASE_BODY_MAX + 1 bytes, never redirects this route, and supplies the ctx from D1.
//
// ---- The ctx (every read is current: none may be cached across requests)
//
//   aud, now                       the audience; the Worker's own clock, ms (never the request's at_ms). It is read exactly
//                                  twice: once for the window check (and its refusal), and once immediately before
//                                  leases.issue, whose `now` is that second sample
//   host(host)                     -> { fleet, sign_key (32 raw bytes), fingerprint, revoked } for the CURRENT pairing, or null
//   chain(fleet)                   -> the fleet's device-chain state (as the core's verifiers take it), or null
//   leaseKey                       -> { id, raw (32 bytes), sign(bytes) -> 64 bytes }: the audience's lease key (§1.7a)
//   bucket(key, limit, window_ms)  -> true if one more is allowed in the window (ATOMIC, across instances)
//   leases.issue(d)                -> the ONE serialized decision (ATOMIC, below)
//
// ---- leases.issue(d): one linearization point per agent (the lease-wire note's SEC H2, H3)
//
// d = { fleet, agent, host, host_key, gen, nonce, request, lease_id, ttl_ms, now }. In ONE atomic write (a single D1
// batch: D1 serializes write batches, and every condition is evaluated inside it, by conditional statements, never
// from values read earlier), the store:
//   1. inserts (host, nonce) if absent: a conflict answers { refused: "replay" } and writes nothing else. It is the
//      only write a refused decision makes, so an authenticated request's nonce is spent whatever the outcome.
//      Rows are kept at least NONCE_KEEP_MS;
//   2. re-reads, as conditions: `host` is paired, unrevoked, and its current certificate's fingerprint is `host_key`
//      (else unknown_host / host_revoked / not_granted); the agent isn't revoked (agent_revoked); the agent is bound to
//      `host` now (not_granted: never bound there, or transferred away); the service's entry_gen(agent, host) is `gen`
//      (stale_generation); for an agent moved to `host` whose first lease there is still pending, firstLeaseGateOpen
//      over the old host's record (not_granted while it is closed);
//   3. only when all hold, upserts the grant clock for (agent, host): expires_at = nextExpiry(previous, now, ttl_ms),
//      with lease_id, gen and request for audit, and answers { ok: true }.
// The gate's two inputs: `acked` is true only for a VERIFIED fence ack for THIS move of the agent to THIS host (its
// transfer hash), recorded in the same per-agent serialization as the transfer; an ack for an earlier move never counts.
// The grant clock's rows are never deleted while they can still gate a move (no revocation removes one): a row may go
// only after its move is acked or its expiry plus the margin has passed, so a missing record means the old host holds
// no lease that could still run.
// A transfer's apply, a grant that changes the agent's entry, and a host or agent revocation decide on the same
// per-agent rows, each in one batch of its own, so no lease can be decided against a binding a transfer already moved.
// The promise resolves only once the batch is durable; a failure rejects, and the handler then returns 503 with
// nothing signed. The handler signs only after it resolves { ok: true }.

import { b64, enc, newId, refuse, FleetError } from "./bytes.mjs";
import { canonText, parseCanonical, SIGNED_MAX } from "./canonical.mjs";
import { leaseKeyAt } from "./chain.mjs";
import { keyId } from "./ed25519.mjs";
import { parseEnvelope, signedBytes } from "./envelope.mjs";
import { bodyValidator } from "./schemas.mjs";
import { verifyLeaseRequest } from "./verify.mjs";

export const LEASE_ROUTE = "/api/fleet/v1/host/lease";
export const LEASE_BODY_MAX = 4096;
export const LEASE_READ_MS = 10_000;
export const LEASE_TTL_MS = 600_000;
export const LEASE_SKEW_MS = 300_000;
export const LEASE_GATE_MARGIN_MS = 300_000;
export const NONCE_KEEP_MS = LEASE_SKEW_MS * 2 + LEASE_TTL_MS;
// (one renewal per agent every 2 minutes, and a burst at start and on a grant change, for at most 64 agents a host)
export const LEASE_RATE_HOST = Object.freeze({ limit: 240, windowMs: 60_000 });
export const LEASE_RATE_SOURCE = Object.freeze({ limit: 600, windowMs: 60_000 });
const ISSUE_REFUSALS = Object.freeze(["replay", "unknown_host", "host_revoked", "agent_revoked", "not_granted", "stale_generation"]);
const STATUS = Object.freeze({
  bad_form: 400, bad_audience: 401, bad_signature: 401, clock_skew: 401, unknown_host: 401, host_revoked: 403, agent_revoked: 403,
  not_granted: 403, stale_generation: 409, replay: 409, limit: 413, rate: 429,
});
const bare = (status) => ({ status, headers: { "cache-control": "no-store" }, body: new Uint8Array(0) });
// (one sample of the service's clock: a finite safe integer, or the request fails closed)
const sample = (ctx) => { const t = ctx.now; if (!Number.isSafeInteger(t) || t < 0) throw new Error("the service clock"); return t; };
const refusal = (code, extra = {}) => ({ status: STATUS[code], headers: { "content-type": "application/json", "cache-control": "no-store" }, body: enc(canonText({ error: code, ...extra })) });

/** The grant clock's next expiry (rule 1): the max, so a later, shorter lease never pulls it earlier. */
export function nextExpiry(previous, now, ttlMs) {
  const e = now + ttlMs;
  return previous === null || previous === undefined || e > previous ? e : previous;
}

/**
 * The first-lease gate for an agent moved to a new host (§3.7.4; the backup design's strict rule): open once a valid fence
 * acknowledgement is recorded, or once now > the old host's expires_at + 5 minutes. At equality it is still closed.
 * An old host with no record at all never held a lease, so nothing waits on it.
 */
export function firstLeaseGateOpen({ expiresAt, acked }, now) {
  if (acked) return true;
  if (expiresAt === null || expiresAt === undefined) return true;
  return now > expiresAt + LEASE_GATE_MARGIN_MS;
}

/** POST /api/fleet/v1/host/lease. */
export async function handleLease({ method, target, scheme, source, body }, ctx) {
  if (target !== LEASE_ROUTE) return bare(404);
  if (method !== "POST") return bare(405);
  if (scheme !== "https") return bare(403);
  if (!(body instanceof Uint8Array)) return bare(400);
  if (body.length > LEASE_BODY_MAX) return refusal("limit");
  let d, hash;
  try {
    // (before authentication: a per-source bucket; nothing else is written for an unauthenticated request)
    if (!(await ctx.bucket(`lease-src:${source}`, LEASE_RATE_SOURCE.limit, LEASE_RATE_SOURCE.windowMs))) return refusal("rate");
    // 1. the form, fleet and aud (the fleet is read first only to name the context the form check needs)
    const pre = parseCanonical(body, SIGNED_MAX);
    const p = parseEnvelope(body, { aud: ctx.aud, fleet: pre?.body?.fleet });
    if (p.env.type !== "sb.lease-request.v1") refuse("bad_form", "not a lease request");
    const b = p.env.body;
    bodyValidator("lease-request")(b);
    // 2. the window, on ONE sample of the service's clock: the comparison and the refusal's fields agree
    const checkNow = sample(ctx);
    if (Math.abs(b.at_ms - checkNow) > LEASE_SKEW_MS) return refusal("clock_skew", { service_time_ms: checkNow, skew_ms: b.at_ms - checkNow });
    // 3. the signature, by the host's CURRENT certificate (the batch re-checks it is still current)
    const h = await ctx.host(b.host);
    if (!h || h.fleet !== b.fleet) refuse("unknown_host");
    if (h.revoked) refuse("host_revoked");
    ({ hash } = await verifyLeaseRequest(body, { aud: ctx.aud, fleet: b.fleet, cert: { body: { host: b.host, fingerprint: h.fingerprint }, signRaw: h.sign_key } }));
    if (!(await ctx.bucket(`lease-host:${b.host}`, LEASE_RATE_HOST.limit, LEASE_RATE_HOST.windowMs))) return refusal("rate");
    // the lease key this fleet's chain has in force at its head: never sign what the host would refuse (§1.7a)
    const chain = await ctx.chain(b.fleet);
    if (!chain) refuse("not_granted", "no such fleet");
    const key = ctx.leaseKey;
    const signer = { kind: "lease", id: key.id, alg: "ed25519", key: await keyId("ed25519", key.raw) };
    // (leaseKeyAt matches the key id, which is the raw key's: so this is the very key the chain pins in force)
    try { leaseKeyAt(chain, signer, chain.seq); } catch { refuse("not_granted", "the fleet's chain doesn't pin this lease key"); }
    d = { fleet: b.fleet, agent: b.agent, host: b.host, host_key: h.fingerprint, gen: b.gen, nonce: b.nonce, boot_id: b.boot_id, request: hash,
      lease_id: newId(), ttl_ms: LEASE_TTL_MS, signer, chain_seq: chain.seq };
  } catch (e) {
    const code = e instanceof FleetError ? e.code : null;
    if (code === null || !Object.hasOwn(STATUS, code)) return bare(500);
    return refusal(code);
  }
  // the one serialized decision: nothing is signed unless it committed { ok: true }. Its time is sampled here, with no
  // await between the sample and the call, so the grant clock is the service's clock at the issuing transaction
  let r;
  try {
    const issueNow = sample(ctx);
    r = await ctx.leases.issue({ fleet: d.fleet, agent: d.agent, host: d.host, host_key: d.host_key, gen: d.gen, nonce: d.nonce, request: d.request,
      lease_id: d.lease_id, ttl_ms: d.ttl_ms, now: issueNow });
  } catch { return bare(503); }
  if (!r || r.ok !== true) return ISSUE_REFUSALS.includes(r?.refused) ? refusal(r.refused) : bare(500);
  const lease = { fleet: d.fleet, aud: ctx.aud, agent: d.agent, host: d.host, host_key: d.host_key, gen: d.gen, lease_id: d.lease_id, ttl_ms: d.ttl_ms,
    nonce: d.nonce, boot_id: d.boot_id, request: d.request, chain_seq: d.chain_seq };
  try {
    bodyValidator("execution-lease")(lease);
    const sig = await ctx.leaseKey.sign(signedBytes("sb.execution-lease.v1", d.signer, lease));
    return { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: enc(canonText({ v: 1, type: "sb.execution-lease.v1", signer: d.signer, body: lease, sig: b64(sig) })) };
  } catch {
    // (committed but not sent: safe; the record at most delays a later restore by its expiry plus the margin)
    return bare(503);
  }
}
