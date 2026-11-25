// Fleet protocol (r2.3 §3, §4): the reference verifiers for objects outside the device chain. Each takes the
// envelope's bytes and the verifier's own state (its pinned chain, the host's certificate, its current grant, the
// time, the ids it has already used), and returns the verified body or throws a FleetError whose code is in
// schema/fleet/reasons.json. They are pure: recording a use (an op_id, an approval) is the caller's, in the same
// durable step as the effect (§4, §5.3). They are async: signatures and hashes go through the installed backend.

import { b64, bytesEqual, concat, enc, refuse, sha256, sha256b64, unb64 } from "./bytes.mjs";
import { canonText } from "./canonical.mjs";
import { checkPublicKey } from "./ed25519.mjs";
import { open } from "./envelope.mjs";
import { deviceKey, requireTier } from "./chain.mjs";
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
async function openByDevice(bytes, ctx, type, schema, { allowRemoved = false } = {}) {
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
// reserved-tree, uniqueness and widening checks, so "/x/../.agents" or "//.agents" never reach them as strings (astra4b).
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
  // the generation: higher, or the same bytes again (§3.2, grader 4)
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

/** The hash a question's preimage must produce for its subject (§4: paths_hash, payload_hash, args_hash). */
export const preimageHash = async (preimage) => sha256b64(enc(canonText(preimage, 640 * 1024)));
