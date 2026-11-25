// Fleet protocol (r2.3 §2, §1.7): the person's device chain, verified entry by entry. Pure: state in, state out.
//
// A chain state is what a verifier pins and persists: the fleet, the head (seq and hash), every device ever enrolled
// (its key, tier, and the seqs it was added and removed at), the recovery key, the service keys with the seq each
// came in at, and the policy. replay() verifies a whole chain from genesis against an optional pin; apply() adds one
// entry. Objects outside the chain ask deviceKey() and serviceKeyAt() which keys count (§2.3, §2.4, §1.7).
// apply() and replay() are async (signatures and hashes go through the installed backend); the key lookups aren't.

import { isId, refuse, sha256b64, unb64 } from "./bytes.mjs";
import { checkPublicKey, keyId, verifyStrict } from "./ed25519.mjs";
import { open } from "./envelope.mjs";
import { bodyValidator } from "./schemas.mjs";

const RANK = { browser: 1, native: 2 };
const AUTH_MS = 5 * 60_000;

const rawKey = (k) => checkPublicKey(unb64(k.key, 32));
/** The tier of a signer, from its own enrolled entry; the recovery key counts as native (§2.1). */
const tierOf = (state, signer) => (signer.kind === "recovery" ? "native" : state.devices.get(signer.id).tier);

function copy(s) {
  return { ...s, devices: new Map(s.devices), serviceKeys: [...s.serviceKeys], hashes: [...s.hashes] };
}

/**
 * Verify one entry's bytes against `state` (null before genesis). `ctx`: { aud, fleet, now?, checkAuthTime? }
 * (the service checks auth_time; hosts and apps can't know it). Returns { state, entry }.
 */
export async function apply(state, bytes, ctx) {
  // (a chain is one fleet in one audience: a context that isn't the state's own is refused before anything else, so
  // a valid signature for another fleet or audience can never extend this chain; astra4)
  if (state && state.aud !== ctx.aud) refuse("bad_audience", "not this chain's audience");
  if (state && state.fleet !== ctx.fleet) refuse("bad_form", "not this chain's fleet");
  const resolveKey = async (signer, type, body) => {
    if (type !== "sb.device-chain.v1") refuse("bad_form", "not a chain entry");
    if (!state) {
      if (body?.op !== "genesis" || signer.kind !== "device" || signer.id !== body.device?.id) refuse("bad_form", "a chain starts with genesis");
      bodyValidator("device-chain")(body);
      const raw = rawKey(body.device);
      if ((await keyId("ed25519", raw)) !== signer.key) refuse("bad_signature");
      return raw;
    }
    // (the predecessor rule: an entry's signer is checked against the chain just before it, §2.4)
    if (signer.kind === "recovery") {
      if (signer.id !== state.fleet || signer.key !== state.recovery.keyId) refuse("recovery_key_mismatch");
      return state.recovery.raw;
    }
    if (signer.kind !== "device") refuse("bad_signature");
    const d = state.devices.get(signer.id);
    if (!d || d.removed !== null || d.keyId !== signer.key) refuse("device_unknown");
    return d.raw;
  };
  const env = await open(bytes, { aud: ctx.aud, fleet: ctx.fleet, resolveKey });
  const { body, signer } = env;
  bodyValidator("device-chain")(body);
  if (ctx.checkAuthTime && !(ctx.now - body.auth_time_ms <= AUTH_MS && body.auth_time_ms <= ctx.now + AUTH_MS)) refuse("stale_auth");

  const seq = state ? state.seq + 1 : 0;
  if (state && body.op === "genesis") refuse("bad_form", "one genesis");
  if (body.seq !== seq || body.prev !== (state ? state.head : "")) refuse("chain_fork", "not the next entry");

  const next = state ? copy(state) : {
    fleet: ctx.fleet, aud: ctx.aud, seq: -1, head: "", devices: new Map(), recovery: null, serviceKeys: [],
    policy: Object.freeze({ require_native_for_widening: false }), hashes: [],
  };
  const enroll = async (dev) => {
    if (next.devices.has(dev.id)) refuse("bad_form", "a device id twice"); // (never reused, even after removal)
    const raw = rawKey(dev);
    next.devices.set(dev.id, Object.freeze({ id: dev.id, raw, keyId: await keyId("ed25519", raw), tier: dev.tier, name: dev.name, added: seq, removed: null }));
  };
  const setRecovery = async (rk) => {
    const raw = rawKey(rk);
    const id = await keyId("ed25519", raw);
    if (next.recovery && next.recovery.keyId === id) refuse("bad_form", "the same recovery key");
    next.recovery = Object.freeze({ raw, keyId: id });
  };
  const deviceSigner = () => { if (signer.kind !== "device") refuse("device_unknown"); };
  const needNative = () => { if (tierOf(state, signer) !== "native") refuse("device_tier"); };
  let regrants = undefined;

  switch (body.op) {
    case "genesis":
      await enroll(body.device);
      await setRecovery(body.recovery_key);
      break;
    case "add":
      deviceSigner();
      if (RANK[tierOf(state, signer)] < RANK[body.device.tier]) refuse("device_tier");
      await enroll(body.device);
      if (!(await verifyStrict(next.devices.get(body.device.id).raw, env.signed, env.sig2))) refuse("bad_signature", "the new device's countersignature");
      break;
    case "remove": {
      deviceSigner();
      const t = next.devices.get(body.remove);
      if (!t || t.removed !== null) refuse("device_unknown");
      if (body.remove === signer.id) refuse("bad_form", "a device can't remove itself");
      if (RANK[tierOf(state, signer)] < RANK[t.tier]) refuse("device_tier");
      next.devices.set(t.id, Object.freeze({ ...t, removed: seq }));
      regrants = body.regrants;
      break;
    }
    case "recover":
      if (signer.kind !== "recovery") refuse("recovery_key_mismatch");
      await enroll(body.device);
      await setRecovery(body.recovery_key); // (the rotation in the same entry: the old key is spent at once)
      break;
    case "rotate-recovery":
      deviceSigner();
      needNative();
      await setRecovery(body.recovery_key);
      break;
    case "service-key": {
      deviceSigner();
      const raw = rawKey(body.service_key);
      if (!isId(body.service_key.id) || next.serviceKeys.some((k) => k.id === body.service_key.id)) refuse("bad_form", "a service key id twice");
      next.serviceKeys.push(Object.freeze({ id: body.service_key.id, raw, keyId: await keyId("ed25519", raw), seq }));
      break;
    }
    case "policy":
      deviceSigner();
      if (!body.policy.require_native_for_widening) needNative(); // (on: any device; off: native only)
      next.policy = Object.freeze({ ...body.policy });
      break;
    default:
      refuse("bad_form", "an unknown op");
  }
  next.seq = seq;
  next.head = await sha256b64(env.signed);
  next.hashes.push(next.head);
  return { state: Object.freeze(next), entry: Object.freeze({ op: body.op, seq, signer, body, regrants }) };
}

/**
 * Verify a whole chain from genesis. A `pin` ({ fleet, aud, seq, hash }), when given, must be on it: another hash at the pin's
 * seq is a fork, and a chain shorter than the pin is a rollback; both refuse with chain_fork (§2.4).
 */
export async function replay(entries, ctx, pin = null) {
  if (pin && ((pin.fleet !== undefined && pin.fleet !== ctx.fleet) || (pin.aud !== undefined && pin.aud !== ctx.aud))) refuse("chain_fork", "a pin of another chain");
  let state = null;
  for (const bytes of entries) state = (await apply(state, bytes, ctx)).state;
  if (!state) refuse("bad_form", "an empty chain");
  if (pin && (pin.seq > state.seq || state.hashes[pin.seq] !== pin.hash)) refuse("chain_fork");
  return state;
}

/**
 * The device behind a signature on an object outside the chain that names `chainSeq` (§2.3, §2.4): enrolled at
 * chainSeq, and still enrolled at the pinned head. A chainSeq past the head means "fetch the chain first".
 */
export function deviceKey(state, signer, chainSeq) {
  if (signer.kind !== "device") refuse("bad_signature");
  if (!Number.isSafeInteger(chainSeq) || chainSeq < 0 || chainSeq > state.seq) refuse("device_unknown", "fetch the chain first");
  const d = state.devices.get(signer.id);
  if (!d || d.keyId !== signer.key || d.added > chainSeq) refuse("device_unknown");
  if (d.removed !== null) refuse(d.removed <= chainSeq ? "device_unknown" : "device_removed");
  return d;
}

/** Refuse a browser-tier signature on a widening object while the fleet requires native ones (§2.1). */
export function requireTier(state, device, widening) {
  if (widening && state.policy.require_native_for_widening && device.tier !== "native") refuse("device_tier");
}

/**
 * The service key in force at an ack's chainSeq (§1.7, r2.3): the latest service-key entry at or before it, so a key
 * K counts over [seq(K), seq(K')). Historical acks stay verifiable; a replaced key never signs a newer ack.
 */
export function serviceKeyAt(state, signer, chainSeq) {
  if (signer.kind !== "service") refuse("bad_signature");
  if (!Number.isSafeInteger(chainSeq) || chainSeq < 0 || chainSeq > state.seq) refuse("device_unknown", "fetch the chain first");
  let k = null;
  for (const s of state.serviceKeys) if (s.seq <= chainSeq) k = s;
  if (!k || k.id !== signer.id || k.keyId !== signer.key) refuse("bad_signature");
  return k.raw;
}
