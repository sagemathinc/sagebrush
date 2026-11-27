// The signed envelope for E2E key objects (§4.1): canonical JSON with the fleet's rules, signed over a
// domain-separated prefix.
//
//   { v: 1, type, signer: { kind, id, alg: "ed25519", key }, body, sig, co? }
//   signed bytes = "sagebrush.e2e.<kind>.v1\n" + canon(signer) + "\n" + canon(body)
//
// `co` holds countersignatures over the same signed bytes, by role ("device": a device being enrolled; "recovery": a
// new recovery key). Which roles an entry must carry is the chain's rule, not this module's.

import { b64, enc, isId, unb64 } from "../../fleet/core/bytes.mjs";
import { canonText, parseCanonical, SIGNED_MAX } from "../../fleet/core/canonical.mjs";
import { AUDIENCES, exactKeys, fail } from "./base.mjs";

/** Each type, its signing prefix, and the signer kinds it accepts. */
export const TYPES = Object.freeze({
  "sb.e2e-chain.v1": Object.freeze({ prefix: "sagebrush.e2e.chain.v1", kinds: Object.freeze(["device", "recovery"]) }),
  "sb.e2e-wrap.v1": Object.freeze({ prefix: "sagebrush.e2e.wrap.v1", kinds: Object.freeze(["device"]) }),
});
const ROLES = new Set(["device", "recovery"]);

export function checkSigner(type, signer) {
  if (!Object.hasOwn(TYPES, type)) fail("bad_form", "an unknown type");
  if (!exactKeys(signer, ["kind", "id", "alg", "key"]) || signer.alg !== "ed25519" || !isId(signer.id)) fail("bad_form", "a bad signer");
  if (!TYPES[type].kinds.includes(signer.kind)) fail("bad_signature", "this type isn't signed by that kind of signer");
  unb64(signer.key, 16);
}

/** The bytes a signer (and every countersigner) signs. */
export function signedBytes(type, signer, body) {
  return enc(`${TYPES[type].prefix}\n${canonText(signer)}\n${canonText(body)}`);
}

/** Seal: `key` and each of `co`'s values are { sign(bytes) -> 64 bytes } (fleet core's asKey/keyFromSeed shape). */
export async function seal(type, signer, body, key, co = {}) {
  checkSigner(type, signer);
  const bytes = signedBytes(type, signer, body);
  const env = { v: 1, type, signer, body, sig: b64(await key.sign(bytes)) };
  const roles = Object.keys(co).sort();
  if (roles.length) {
    env.co = {};
    for (const r of roles) {
      if (!ROLES.has(r)) fail("bad_form", "an unknown countersigner role");
      env.co[r] = b64(await co[r].sign(bytes));
    }
  }
  return enc(canonText(env));
}

/**
 * An envelope's form, before any signature check: canonical bytes, exact keys, a known type and signer kind, a body
 * of this audience and account, 64-byte signatures. Returns { type, signer, body, signed, sig, co: Map role -> sig }.
 */
export function parse(bytes, ctx) {
  const env = parseCanonical(bytes, SIGNED_MAX);
  const keys = env && Object.hasOwn(env, "co") ? ["v", "type", "signer", "body", "sig", "co"] : ["v", "type", "signer", "body", "sig"];
  if (!exactKeys(env, keys) || env.v !== 1 || typeof env.type !== "string") fail("bad_form", "not an envelope");
  checkSigner(env.type, env.signer);
  const body = env.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("bad_form", "a body is an object");
  if (body.aud !== ctx.aud || !AUDIENCES.includes(body.aud)) fail("bad_audience", "another audience");
  if (body.account !== ctx.account || !isId(body.account)) fail("bad_form", "another account");
  const co = new Map();
  if (keys.length === 6) {
    if (!env.co || typeof env.co !== "object" || Array.isArray(env.co) || Object.keys(env.co).length === 0) fail("bad_form", "bad countersignatures");
    for (const [r, s] of Object.entries(env.co)) {
      if (!ROLES.has(r)) fail("bad_form", "an unknown countersigner role");
      co.set(r, unb64(s, 64));
    }
  }
  return { type: env.type, signer: env.signer, body, signed: signedBytes(env.type, env.signer, body), sig: unb64(env.sig, 64), co };
}
