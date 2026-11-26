// Fleet protocol (r2.3 §3, §4): the reference verifiers for objects outside the device chain. Each takes the
// envelope's bytes and the verifier's own state (its pinned chain, the host's certificate, its current grant, the
// time, the ids it has already used), and returns the verified body or throws a FleetError whose code is in
// schema/fleet/reasons.json. They are pure: recording a use (an op_id, an approval) is the caller's, in the same
// durable step as the effect (§4, §5.3). They are async: signatures and hashes go through the installed backend.

import { b64, bytesEqual, concat, enc, refuse, sha256, sha256b64, unb64 } from "./bytes.mjs";
import { canonText } from "./canonical.mjs";
import { checkPublicKey, keyId } from "./ed25519.mjs";
import { open } from "./envelope.mjs";
import { deviceKey, leaseKeyAt, requireTier, serviceKeyAt } from "./chain.mjs";
import { bodyValidator } from "./schemas.mjs";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const TEN_MIN = 10 * 60_000;
const SEVEN_DAYS = 7 * 24 * 3600_000;
const AUTH_MS = 5 * 60_000;

// ---- fingerprints (§2.2, §3.1): computed by every verifier, never taken from the object

/** The full host fingerprint: SHA-256("sagebrush.fp.v1\nhost\n" + host + "\n" + Ed25519 key + X25519 key). */
export const hostFingerprint = (host, signRaw, encRaw) => sha256(concat("sagebrush.fp.v1\nhost\n", host, "\n", signRaw, encRaw));
/** The full device fingerprint: SHA-256("sagebrush.fp.v1\ndevice\n" + fleet + "\n" + device + "\n" + key). */
export const deviceFingerprint = (fleet, device, raw) => sha256(concat("sagebrush.fp.v1\ndevice\n", fleet, "\n", device, "\n", raw));
/** What a person compares: the first 100 bits, 20 base32 characters in groups of 4. */
export function showFingerprint(full) {
  let bits = 0, acc = 0n, out = "";
  for (const x of full.subarray(0, 13)) { acc = (acc << 8n) | BigInt(x); bits += 8; }
  acc >>= BigInt(bits - 100);
  for (let i = 19; i >= 0; i--) out += B32[Number((acc >> BigInt(5 * i)) & 31n)];
  return out.match(/.{4}/g).join("-");
}

// ---- shared steps

/** Open a device-signed object: the signer counts at the body's chain_seq and at the pinned head (§2.3). */
export async function openByDevice(bytes, ctx, type, schema, { allowRemoved = false } = {}) {
  let device = null;
  const env = await open(bytes, {
    aud: ctx.aud, fleet: ctx.fleet,
    resolveKey: (signer, t, body) => {
      if (t !== type) refuse("bad_form", "another type");
      bodyValidator(schema)(body);
      try { device = deviceKey(ctx.chain, signer, body.chain_seq); }
      catch (e) {
        // (a revocation from a since-removed device still holds: obeying one only narrows, §2.3)
        if (!(allowRemoved && e.code === "device_removed")) throw e;
        device = ctx.chain.devices.get(signer.id);
      }
      return device.raw;
    },
  });
  return { ...env, device };
}

function inForce(body, now) {
  if (body.not_before_ms !== undefined && now < body.not_before_ms) refuse("grant_expired", "not yet in force");
  if (body.not_after_ms !== undefined && body.not_after_ms !== null && now >= body.not_after_ms) refuse("grant_expired");
}

function freshAuth(ctx, body) {
  if (ctx.checkAuthTime && !(ctx.now - body.auth_time_ms <= AUTH_MS && body.auth_time_ms <= ctx.now + AUTH_MS)) refuse("stale_auth");
}

// ---- host certificates (§3.1)

/** Verify a host certificate. Returns { body, signRaw, encRaw, hash } (hash: SHA-256 of its signed bytes). */
export async function verifyHostCert(bytes, ctx) {
  const env = await openByDevice(bytes, ctx, "sb.host-cert.v1", "host-cert");
  const b = env.body;
  const signRaw = checkPublicKey(unb64(b.sign_key, 32));
  const encRaw = unb64(b.enc_key, 32);
  if (encRaw.every((x) => x === 0)) refuse("bad_form", "an X25519 key of zero");
  if (b64(await hostFingerprint(b.host, signRaw, encRaw)) !== b.fingerprint) refuse("bad_form", "the fingerprint isn't this host's");
  return { body: b, signRaw, encRaw, hash: await sha256b64(env.signed), device: env.device };
}

// ---- host grants (§3.2)

const AGENTS = "/.agents";
const underAgents = (p) => p === AGENTS || p.startsWith(AGENTS + "/");

// The endpoint's path rules (core web/workspace/paths.ts normPath): absolute, "/"-separated, no empty, "." or ".."
// names, no control characters, at most 1024 characters, 32 folders deep and 255 per name. A grant's scope must
// already be in that canonical form (normPath would return it unchanged): anything else is refused here, before the
// reserved-tree, uniqueness and widening checks, so "/x/../.agents" or "//.agents" never reach them as strings.
const MAX_PATH = 1024, MAX_DEPTH = 32, MAX_NAME = 255;
const CONTROL = /[\u0000-\u001f\u007f]/;
export function canonicalPath(p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.length > MAX_PATH) return false;
  if (p === "/") return true;
  const names = p.slice(1).split("/"); // (a trailing "/" leaves an empty last name, so it is refused below)
  if (names.length > MAX_DEPTH) return false;
  return names.every((n) => n !== "" && n !== "." && n !== ".." && n.length <= MAX_NAME && !CONTROL.test(n));
}

/** Whether `next` only narrows `prev` (both grant bodies): anything else widens (§2.1's native rule). */
export function narrowsOnly(prev, next) {
  if (!prev) return false;
  const sub = (a, b) => a.every((x) => b.includes(x));
  const pa = new Map(prev.agents.map((a) => [a.agent, a]));
  for (const a of next.agents) {
    const p = pa.get(a.agent);
    if (!p || a.client !== p.client || (a.root && !p.root) || !sub(a.tags, p.tags) || !sub(a.broker, p.broker)) return false;
    if (a.spend_cap_cents > p.spend_cap_cents || canonText(a.config) !== canonText(p.config)) return false;
    for (const s of a.workspace) if (!p.workspace.some((q) => q.path === s.path && (q.access === "write" || s.access === "read"))) return false;
  }
  if (!sub(next.tags.map((t) => t.tag), prev.tags.map((t) => t.tag))) return false;
  const ps = new Map(prev.subscriptions.map((s) => [s.sub, s]));
  for (const s of next.subscriptions) {
    const p = ps.get(s.sub);
    if (!p || s.provider !== p.provider || (s.home && !p.home) || !sub(s.use, p.use)) return false;
  }
  const end = (g) => (g.not_after_ms === null ? Infinity : g.not_after_ms);
  if (end(next) > end(prev) || next.not_before_ms < prev.not_before_ms) return false;
  if (next.offline.horizon_s > prev.offline.horizon_s || next.offline.revocation_check_s > prev.offline.revocation_check_s) return false;
  return true;
}

/**
 * Verify a grant for this host. ctx: { aud, fleet, chain, cert (from verifyHostCert), current: { gen, bytes, body } | null,
 * now, checkAuthTime? }. Returns { body, reapply, widens, hash }.
 */
export async function verifyGrant(bytes, ctx) {
  const env = await openByDevice(bytes, ctx, "sb.host-grant.v1", "host-grant");
  const g = env.body;
  freshAuth(ctx, g);
  if (g.host !== ctx.cert.body.host || g.cert !== ctx.cert.hash) refuse("not_granted", "another host or certificate");
  // the generation: higher, or the same bytes again (§3.2)
  const cur = ctx.current;
  let reapply = false;
  if (cur) {
    if (g.gen < cur.gen) refuse("stale_generation");
    if (g.gen === cur.gen) {
      if (!bytesEqual(bytes, cur.bytes)) refuse("stale_generation", "the same generation, other bytes");
      reapply = true;
    }
  }
  // cross-field rules the schema can't state
  if ((g.not_after_ms === null) !== (g.no_expiry_ack === true)) refuse("bad_form", "no_expiry_ack exactly when not_after_ms is null");
  if (g.not_after_ms !== null && g.not_after_ms <= g.not_before_ms) refuse("bad_form", "an empty lifetime");
  inForce(g, ctx.now);
  const tags = new Set();
  for (const t of g.tags) { if (tags.has(t.tag)) refuse("bad_form", "a tag twice"); tags.add(t.tag); }
  const agents = new Set();
  for (const a of g.agents) {
    if (agents.has(a.agent)) refuse("bad_form", "an agent twice");
    agents.add(a.agent);
    for (const t of a.tags) if (!tags.has(t)) refuse("bad_form", "an agent's tag isn't in the grant");
    const paths = new Set();
    for (const s of a.workspace) {
      if (!canonicalPath(s.path)) refuse("bad_form", "a workspace path that isn't canonical");
      if (underAgents(s.path)) refuse("not_granted", "/.agents is never a workspace scope");
      if (paths.has(s.path)) refuse("bad_form", "a path twice");
      paths.add(s.path);
    }
  }
  const subs = new Set();
  for (const s of g.subscriptions) {
    if (subs.has(s.sub)) refuse("bad_form", "a subscription twice");
    subs.add(s.sub);
    for (const a of s.use) if (!agents.has(a)) refuse("bad_form", "a subscription used by an agent not in the grant");
    if (s.home && s.provider !== "codex") refuse("bad_form", "only a codex subscription has a home");
  }
  const widens = !narrowsOnly(cur?.body ?? null, g);
  if (!reapply) requireTier(ctx.chain, env.device, widens);
  return { body: g, reapply, widens, hash: await sha256b64(env.signed) };
}

// ---- the host's acknowledgement (§3.3)

/** Verify a host's ack against its certificate. */
export async function verifyGrantAck(bytes, ctx) {
  const env = await open(bytes, {
    aud: ctx.aud, fleet: ctx.fleet,
    resolveKey: (signer, t, body) => {
      if (t !== "sb.grant-ack.v1") refuse("bad_form", "another type");
      bodyValidator("grant-ack")(body);
      if (signer.kind !== "host" || signer.id !== ctx.cert.body.host || body.host !== signer.id) refuse("bad_signature");
      return ctx.cert.signRaw;
    },
  });
  if (env.body.gen > ctx.currentGen) refuse("stale_generation", "an ack ahead of the grant");
  return env.body;
}

// ---- person-signed host operations (§3.4)

const WIDENING_OPS = new Set(["resume", "delete"]);

/** ctx: { aud, fleet, chain, host, currentGen, now, seenOp(op_id) → bool, checkAuthTime? }. */
export async function verifyHostOp(bytes, ctx) {
  const env = await openByDevice(bytes, ctx, "sb.host-op.v1", "host-op");
  const o = env.body;
  if (o.host !== ctx.host) refuse("not_granted", "another host");
  if (o.gen !== ctx.currentGen) refuse("stale_generation");
  if (o.not_after_ms - o.at_ms > TEN_MIN || o.not_after_ms <= o.at_ms) refuse("bad_form", "an op lives at most 10 minutes");
  if (ctx.now < o.at_ms - 5 * 60_000 || ctx.now >= o.not_after_ms) refuse("grant_expired");
  // (resume and delete need a sign-in under 5 minutes old, §3.2: the body has no auth_time, so the service checks the
  // submitting session's own sign-in time, ctx.sessionAuthTimeMs; hosts can't know it and don't check)
  if (WIDENING_OPS.has(o.op) && ctx.checkAuthTime) freshAuth(ctx, { auth_time_ms: ctx.sessionAuthTimeMs });
  if (ctx.seenOp(o.op_id)) refuse("replay", "this op_id has run");
  requireTier(ctx.chain, env.device, WIDENING_OPS.has(o.op));
  return o;
}

// ---- revocations (§3.5): obeyed even when their signer has since been removed

export async function verifyRevocation(bytes, ctx) {
  return (await openByDevice(bytes, ctx, "sb.revocation.v1", "revocation", { allowRemoved: true })).body;
}

// ---- typed approvals (§4)

/**
 * ctx: { aud, fleet, chain, now, expect: { kind, subject, requester }, current: { gen, life } | null (pairing),
 * used(approval) → bool }. `expect.subject` is the operation actually about to run; its hash must match.
 */
export async function verifyApproval(bytes, ctx) {
  const env = await openByDevice(bytes, ctx, "sb.approval.v1", "approval");
  const a = env.body;
  // (pairing a host changes the fleet's shape: a sign-in under 5 minutes old, checked by the service, R1. Other
  // approvals need only a live session; their auth_time is recorded, §3.2)
  if (a.kind === "host-pair") freshAuth(ctx, a);
  if (a.subject_hash !== (await sha256b64(enc(canonText(a.subject))))) refuse("approval_mismatch", "the subject's hash");
  const want = ctx.expect;
  if (a.kind !== want.kind || canonText(a.requester) !== canonText(want.requester) || a.subject_hash !== (await sha256b64(enc(canonText(want.subject)))))
    refuse("approval_mismatch");
  if (a.not_after_ms - a.at_ms > TEN_MIN || a.not_after_ms <= a.at_ms) refuse("bad_form", "an approval lives at most 10 minutes");
  if (ctx.now < a.at_ms - 5 * 60_000 || ctx.now >= a.not_after_ms) refuse("approval_stale", "expired");
  if (a.requester.host !== undefined && (!ctx.current || a.gen !== ctx.current.gen || a.life !== ctx.current.life)) refuse("approval_stale");
  if (ctx.used(a.approval)) refuse("approval_used");
  requireTier(ctx.chain, env.device, true); // (every approval counts as widening under the native policy, §2.1)
  return a;
}

// ---- moving an agent to another host (r2.4 §3.7): the person's transfer, the service's receipt, the new host's checks

/**
 * §3.7.3 check 2, on the new host: the person-signed transfer. ctx: { aud, fleet, chain }. Its form, fleet and aud, its
 * signature, the signer enrolled at its chain_seq and not removed at the pinned head, and the native-tier rule (a
 * transfer widens to_host, ruling P2). Not its window or its freshness: the resume may come hours after not_after_ms,
 * and the service checked both when it applied the transfer. Returns { body, hash } (hash: SHA-256 of its signed bytes).
 */
export async function verifyAgentTransfer(bytes, ctx) {
  const env = await openByDevice(bytes, ctx, "sb.agent-transfer.v1", "agent-transfer");
  requireTier(ctx.chain, env.device, true);
  return { body: env.body, hash: await sha256b64(env.signed) };
}

const REPEATED = ["fleet", "aud", "agent", "from_host", "to_host", "to_host_key", "gen", "nonce"];

/**
 * §3.7.3 checks 1-3: { transfer, receipt } (each the envelope's bytes) as the service handed them out. ctx: { aud,
 * fleet, chain }. 1, the receipt under the service key in force at its chain_seq (§1.7's half-open rule, as for audit
 * acks); 2, the transfer (verifyAgentTransfer); 3, the receipt names exactly that transfer, by the SHA-256 of its
 * signed bytes, and repeats every field of it unchanged. Returns { transfer, receipt, transferHash }.
 */
export async function verifyTransferReceipt(pair, ctx) {
  const receipt = await open(pair.receipt, {
    aud: ctx.aud, fleet: ctx.fleet,
    resolveKey: (signer, t, body) => {
      if (t !== "sb.agent-transfer-receipt.v1") refuse("bad_form", "another type");
      bodyValidator("agent-transfer-receipt")(body);
      return serviceKeyAt(ctx.chain, signer, body.chain_seq);
    },
  });
  const transfer = await verifyAgentTransfer(pair.transfer, ctx);
  const r = receipt.body, t = transfer.body;
  if (r.transfer !== transfer.hash) refuse("bad_form", "the receipt names another transfer");
  for (const k of REPEATED) if (r[k] !== t[k]) refuse("bad_form", `the receipt's ${k} isn't the transfer's`);
  return { transfer: t, receipt: r, transferHash: transfer.hash };
}

/**
 * §3.7.3 checks 4-6, the new host's own: `pair` is verifyTransferReceipt's result, `host` the host's records, read
 * synchronously (the supervisor's; the host writes them, this never does):
 *   id, fingerprint; grantHashAt(gen) -> sha | null (every grant it accepted); grantListsAgent(gen, agent);
 *   listedSince(agent), entryGen(agent) -> gen | null; acceptedTransfer(agent) -> { gen, nonce, transfer } | null
 *   (the newest it accepted); nonceSeen(nonce) -> transfer hash | null (host-wide).
 * Check 6 is idempotent for the pair this host already accepted, so a resume retried after its first refusal passes
 * again: { first: false }. A pair not yet accepted passes as { first: true }, and the caller records it durably
 * before acting; "new" is enforced there, once.
 */
export function checkTransferForHost(pair, host) {
  const t = pair.transfer;
  // 4: this host, by id and by the fingerprint the person compared at pairing
  if (t.to_host !== host.id || t.to_host_key !== host.fingerprint) refuse("not_granted", "a transfer to another host");
  // 5a: a grant this host accepted at gen, by hash (not "the current grant": later grants may have come since)
  const g = host.grantHashAt(t.gen);
  if (g === null || g !== t.grant) refuse("not_granted", "a grant this host didn't accept at that generation");
  if (!host.grantListsAgent(t.gen, t.agent)) refuse("not_granted", "that grant doesn't list the agent");
  // 5b: in every grant since gen, and its entry not older than gen (it may have moved up: the lease carries that)
  const since = host.listedSince(t.agent), cur = host.entryGen(t.agent);
  if (since === null || cur === null) refuse("not_granted", "the agent isn't in this host's current grant");
  if (since > t.gen || cur < t.gen) refuse("stale_generation", "the agent hasn't been listed since that generation");
  // 6: the accepted pair again, or a newer one with a nonce never seen here
  const accepted = host.acceptedTransfer(t.agent);
  if (accepted) {
    if (accepted.transfer === pair.transferHash && accepted.gen === t.gen && accepted.nonce === t.nonce) return { first: false };
    if (t.gen <= accepted.gen) refuse("stale_generation", "not above the transfer this host accepted");
  }
  const seen = host.nonceSeen(t.nonce);
  if (seen !== null && seen !== pair.transferHash) refuse("replay", "this nonce named another transfer here");
  return { first: true };
}

// ---- the old host's fence acknowledgement (r2.4 §3.7.4)

/**
 * §3.7.4, the service's check of a fence acknowledgement's envelope: its form, fleet and aud, and the signature by the
 * old host's certified key (the signer is that host, its key id the certificate's, and the body names the same host).
 * ctx: { aud, fleet, cert }, where cert is verifyHostCert's result for the host's pairing. Whether it answers a transfer
 * the service applied, at the old host's last generation, after the apply, and for the first time, is the service's
 * own serialized decision (it holds that state), not this check. Returns { body, hash } (hash: of its signed bytes).
 */
export async function verifyFenceAck(bytes, ctx) {
  const env = await open(bytes, {
    aud: ctx.aud, fleet: ctx.fleet,
    resolveKey: async (signer, t, body) => {
      if (t !== "sb.agent-fence-ack.v1") refuse("bad_form", "another type");
      bodyValidator("agent-fence-ack")(body);
      if (signer.kind !== "host" || signer.id !== ctx.cert.body.host || body.host !== signer.id) refuse("bad_signature");
      if (signer.key !== (await keyId("ed25519", ctx.cert.signRaw))) refuse("bad_signature", "not the certified host key");
      return ctx.cert.signRaw;
    },
  });
  return { body: env.body, hash: await sha256b64(env.signed) };
}

// ---- execution-lease renewal (r2.5 §3.8)

/**
 * §3.8.1, the service's check of a lease request: its form, fleet and aud, and the signature by the host's certified
 * key. ctx: { aud, fleet, cert }, where cert is verifyHostCert's result for the host's CURRENT pairing. The window, the
 * nonce, the binding, the revocations and the first-lease gate are the service's transaction (one serialized step per
 * agent), not this check. Returns { body, hash } (hash: SHA-256 of its signed bytes, what the lease's request names).
 */
export async function verifyLeaseRequest(bytes, ctx) {
  const env = await open(bytes, {
    aud: ctx.aud, fleet: ctx.fleet,
    resolveKey: async (signer, t, body) => {
      if (t !== "sb.lease-request.v1") refuse("bad_form", "another type");
      bodyValidator("lease-request")(body);
      if (signer.kind !== "host" || signer.id !== ctx.cert.body.host || body.host !== signer.id) refuse("bad_signature");
      if (signer.key !== (await keyId("ed25519", ctx.cert.signRaw))) refuse("bad_signature", "not the certified host key");
      return ctx.cert.signRaw;
    },
  });
  return { body: env.body, hash: await sha256b64(env.signed) };
}

const ECHOED = ["request", "agent", "gen", "nonce", "boot_id"];

/**
 * §3.8.2, the host's check of an execution lease. ctx: { aud, fleet, chain, host, hostKey, outstanding }: host and
 * hostKey are this host's certified id and its certificate's fingerprint; outstanding is the ONE request in flight for
 * the agent, { request (its hash), agent, gen, nonce, boot_id }, or null. In order: the form, fleet and aud; the lease
 * key in force at chain_seq (§1.7a: kind "lease" only, never a service key); this host by id and key; the outstanding
 * request echoed exactly (ttl_ms's bound is the schema's). Not the clock: expired on arrival, the 30-second boundary
 * and the timers are the host state machine's, on CLOCK_BOOTTIME (lease note §3). Returns { body, hash }.
 */
export async function verifyExecutionLease(bytes, ctx) {
  const env = await open(bytes, {
    aud: ctx.aud, fleet: ctx.fleet,
    resolveKey: (signer, t, body) => {
      if (t !== "sb.execution-lease.v1") refuse("bad_form", "another type");
      bodyValidator("execution-lease")(body);
      return leaseKeyAt(ctx.chain, signer, body.chain_seq);
    },
  });
  const l = env.body, o = ctx.outstanding;
  if (l.host !== ctx.host || l.host_key !== ctx.hostKey) refuse("not_granted", "a lease for another host");
  if (!o) refuse("not_granted", "no request outstanding");
  for (const k of ECHOED) if (l[k] !== o[k]) refuse("not_granted", `the lease's ${k} isn't the outstanding request's`);
  return { body: l, hash: await sha256b64(env.signed) };
}

/** The hash a question's preimage must produce for its subject (§4: paths_hash, payload_hash, args_hash). */
export const preimageHash = async (preimage) => sha256b64(enc(canonText(preimage, 640 * 1024)));
