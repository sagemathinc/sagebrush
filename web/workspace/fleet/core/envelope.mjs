// Fleet protocol (r2.2 §1.3): the signed envelope every fleet object travels in.
//
//   { v: 1, type, signer: { kind, id, alg: "ed25519", key }, body, sig }
//   signed bytes = "sagebrush.sig.v1\n" + type + "\n" + canon(signer) + "\n" + canon(body)
//
// This module checks the envelope's form, the type's signer kind, the audience and fleet, and the signature against a
// key the caller resolves (from its pinned device chain, host certificates or service key). It doesn't check a body's
// own schema or any state (generations, enrollment at chain_seq, use-once): those are the callers' (verify.mjs and the
// lanes), with the same reasons.
//
// open, seal and sealAdd are async (the signature check and signing go through the installed backend); the form
// checks are parseEnvelope's, pure and synchronous, so lib/fleet/envelope.mjs's synchronous Node open shares them.

import { b64, enc, isId, refuse, unb64 } from "./bytes.mjs";
import { canonText, parseCanonical, SIGNED_MAX } from "./canonical.mjs";
import { verifyStrict } from "./ed25519.mjs";

export const AUDIENCES = Object.freeze(["https://sagebrush.space", "https://dev.sagebrush.space"]);

/** Each type and the one signer kind it accepts (§1.3's table). */
export const TYPES = Object.freeze({
  "sb.device-chain.v1": ["device", "recovery"],
  "sb.host-cert.v1": ["device"],
  "sb.host-grant.v1": ["device"],
  "sb.grant-ack.v1": ["host"],
  "sb.host-op.v1": ["device"],
  "sb.revocation.v1": ["device"],
  "sb.approval.v1": ["device"],
  "sb.sealed-package.v1": ["device"],
  "sb.browser-session.v1": ["device"],
  "sb.audit-event.v1": ["host"],
  "sb.audit-checkpoint.v1": ["host"],
  "sb.audit-continuity.v1": ["host"],
  "sb.audit-ack.v1": ["service"],
});

const KINDS = new Set(["device", "host", "recovery", "service"]);
const exactKeys = (o, keys) =>
  o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/** The bytes a signer signs. */
export function signedBytes(type, signer, body) {
  return enc(`sagebrush.sig.v1\n${type}\n${canonText(signer)}\n${canonText(body)}`);
}

/** Sign a body: the envelope's canonical bytes. `key` is { raw, key, sign } from keyFromSeed or asKey. */
export async function seal(type, signer, body, key) {
  checkSigner(type, signer);
  const sig = await key.sign(signedBytes(type, signer, body));
  return enc(canonText({ v: 1, type, signer, body, sig: b64(sig) }));
}

export function checkSigner(type, signer) {
  if (!Object.hasOwn(TYPES, type)) refuse("bad_form", "an unknown type");
  if (!exactKeys(signer, ["kind", "id", "alg", "key"])) refuse("bad_form", "a signer is {kind, id, alg, key}");
  if (!KINDS.has(signer.kind) || !isId(signer.id) || signer.alg !== "ed25519") refuse("bad_form", "a bad signer");
  unb64(signer.key, 16);
  if (!TYPES[type].includes(signer.kind)) refuse("bad_signature", "this type isn't signed by that kind of signer");
}

/**
 * An envelope's form, without its signature: canonical bytes, the exact keys (sig2 exactly on a device-chain "add"),
 * a known type and its signer kind, a body object of this audience and fleet, and a 64-byte sig. Returns
 * { env, signed, sig, add } or throws a FleetError.
 */
export function parseEnvelope(bytes, ctx) {
  const env = parseCanonical(bytes, SIGNED_MAX);
  // (sig2, the new device's proof of possession, exists exactly on a device-chain "add", §1.3)
  const add = env?.type === "sb.device-chain.v1" && env?.body?.op === "add";
  if (!exactKeys(env, add ? ["v", "type", "signer", "body", "sig", "sig2"] : ["v", "type", "signer", "body", "sig"]) || env.v !== 1) refuse("bad_form", "not an envelope");
  if (typeof env.type !== "string" || !Object.hasOwn(TYPES, env.type)) refuse("bad_form", "an unknown type");
  checkSigner(env.type, env.signer);
  const body = env.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) refuse("bad_form", "a body is an object");
  if (body.aud !== ctx.aud || !AUDIENCES.includes(body.aud)) refuse("bad_audience");
  if (body.fleet !== ctx.fleet || !isId(body.fleet)) refuse("bad_form", "another fleet");
  const sig = unb64(env.sig, 64);
  return { env, signed: signedBytes(env.type, env.signer, body), sig, add };
}

/** What open returns once the signature holds: { type, signer, body, signed } (and sig2 on an "add"). */
export function opened({ env, signed, add }) {
  const r = { type: env.type, signer: env.signer, body: env.body, signed };
  return add ? { ...r, sig2: unb64(env.sig2, 64) } : r;
}

/**
 * Verify an envelope's bytes. `ctx`: { aud, fleet, resolveKey(signer, type, body) → 32-byte raw public key, or a
 * promise of one }. resolveKey decides which keys count (enrollment, pinning, removal, rotation); it throws a
 * FleetError to refuse. Returns { type, signer, body, signed } or throws a FleetError.
 */
export async function open(bytes, ctx) {
  const p = parseEnvelope(bytes, ctx);
  const raw = await ctx.resolveKey(p.env.signer, p.env.type, p.env.body);
  if (!(await verifyStrict(raw, p.signed, p.sig))) refuse("bad_signature");
  return opened(p);
}

/** Seal a device-chain "add": the enrolled device signs, and the new device countersigns the same bytes (sig2). */
export async function sealAdd(signer, body, key, newKey) {
  checkSigner("sb.device-chain.v1", signer);
  const bytes = signedBytes("sb.device-chain.v1", signer, body);
  return enc(canonText({ v: 1, type: "sb.device-chain.v1", signer, body, sig: b64(await key.sign(bytes)), sig2: b64(await newKey.sign(bytes)) }));
}
