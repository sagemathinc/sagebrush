// The account's key chain (§2, §2.1, §2.2, §11.1, §11.2): an append-only, signed log of its devices, its recovery key
// and its epochs, verified entry by entry. Pure: state in, state out. The server stores it and can't forge it; each
// device pins the head it last verified and refuses a chain that rolls back or forks from it.
//
// Entries ("sb.e2e-chain.v1"), each naming its predecessor's hash (the first valid entry at a position is the chain):
//   genesis           the first device, the recovery key (countersigned by its Ed25519 half) and epoch 0
//   add               a current device enrolls a new one, which countersigns; the new X25519 key's proof of
//                     possession has the signing device as challenger (§11.1)
//   remove            a current device removes another one, and the same entry starts the next epoch, so there is
//                     never a chain state where a removed device still holds the current epoch (§2.2)
//   epoch             a current device starts the next epoch (a suite change, or explicitly)
//   recover           the recovery key enrolls a new device (which countersigns), replaces itself (the new recovery
//                     key countersigns) and starts the next epoch, in one entry: the code just typed opens nothing
//                     written afterwards (§2)
//   replace-recovery  a current device replaces the recovery key; its new Ed25519 half countersigns, its new X25519
//                     half proves possession with that device as challenger (§11.1)
//   min-suite         a current device raises the account's minimum writer suite (it only rises, §11.1)
//   reset             the recovery key compacts the chain: a new generation, the recovering device alone (no old device
//                     is kept), a new recovery key and the next epoch. It is the logical successor of the head it
//                     replaces (seq + 1, prev = that head), so positions never restart; the store may then drop every
//                     earlier entry, and a chain that starts at a reset is loaded only under an anchor (loadAnchored)
//
// Every epoch entry names the epoch's suite, a commitment to its secret, and (from epoch 1) its keyring's hash; the
// keyring carries the previous epoch's secret (keyring.mjs: chained keyrings). The generation is the genesis entry's
// hash, or a reset's fresh id; keyrings, wrappers and pins bind it. Device ids and keys are never reused within a
// generation; across one, nothing signed or wrapped before the reset counts (its positions and generation are gone).
//
// Proofs of possession: an add's and a recovery replacement's new X25519 key is proven to the signing device (§11.1).
// Genesis and recover carry none: there the device signing the entry made every new key itself, so a challenge it
// answers to itself would prove nothing more than the entry's own signatures.
//
// Each change is one entry: a removal and its new epoch, or a recovery's device, code and epoch, are signed together.
// What travels with an entry (its keyring, the wrappers of its epoch secret) is checked by checkTransition (wrap.mjs);
// making the entry and its package visible together, durably, is the store's job (the server, and each device's
// store), and nothing publishes an entry without them.
//
// Not here, by design: the inbox key and its rotation (shares, after launch), rotating a device's own keys (§11.1's
// cross-certification), grant revocation (the agent channel), and dropping old epochs' keyrings (§11.2's signed
// coverage): each comes with its own entry type.

import { isId, sha256b64, unb64 } from "../../fleet/core/bytes.mjs";
import { canonText } from "../../fleet/core/canonical.mjs";
import { checkPublicKey, keyId, verifyStrict } from "../../fleet/core/ed25519.mjs";
import { exactKeys, fail, knownSuite } from "./base.mjs";
import { parse, seal } from "./envelope.mjs";
import { checkKemPublic } from "./x25519.mjs";

export const TYPE = "sb.e2e-chain.v1";
/** The kinds of device (§6: browsers, the desktop app, the CLI, Autonomous VMs, connected computers). */
export const DEVICE_KINDS = Object.freeze(["browser", "app", "cli", "vm", "computer"]);
const FIELDS = Object.freeze({
  genesis: ["device", "recovery", "epoch"],
  add: ["device", "pop"],
  remove: ["remove", "epoch"],
  epoch: ["epoch"],
  recover: ["device", "recovery", "epoch"],
  "replace-recovery": ["recovery", "pop"],
  "min-suite": ["min_suite"],
  reset: ["generation", "device", "recovery", "epoch", "min_suite"],
});
/** The countersignatures each op must carry, exactly. */
const CO = Object.freeze({ genesis: ["recovery"], add: ["device"], recover: ["device", "recovery"], "replace-recovery": ["recovery"], reset: ["device", "recovery"] });
/** The ops the recovery key signs, and only it. */
const BY_RECOVERY = new Set(["recover", "reset"]);
const NAME = /^[^\p{Cc}\p{Cf}]{1,64}$/u;

function checkDevice(d) {
  if (!exactKeys(d, ["id", "name", "kind", "sign", "kem"]) || !isId(d.id) || typeof d.name !== "string" || !NAME.test(d.name) || !DEVICE_KINDS.includes(d.kind))
    fail("bad_form", "a bad device");
  return { sign: checkPublicKey(unb64(d.sign, 32)), kem: checkKemPublic(unb64(d.kem, 32)) };
}
function checkRecovery(r) {
  if (!exactKeys(r, ["sign", "kem"])) fail("bad_form", "a bad recovery key");
  return { sign: checkPublicKey(unb64(r.sign, 32)), kem: checkKemPublic(unb64(r.kem, 32)) };
}
function checkPop(p) {
  if (!exactKeys(p, ["enc", "mac"])) fail("bad_form", "a bad proof of possession");
  unb64(p.enc, 32);
  unb64(p.mac, 32);
}

/** `n` is the epoch this entry must start (null: any from 1 on, when a checkpoint is loaded without its predecessor). */
function checkEpoch(ep, n, minSuite, prev, seq) {
  if (!exactKeys(ep, ["n", "suite", "commit", "keyring"])) fail("bad_form", "a bad epoch");
  if (n === null ? !(Number.isSafeInteger(ep.n) && ep.n >= 1) : ep.n !== n) fail("bad_epoch", "not the next epoch");
  if (!knownSuite(ep.suite)) fail("bad_suite", "an unknown suite");
  if (ep.suite < minSuite) fail("bad_suite", "below the account's minimum suite");
  unb64(ep.commit, 32);
  if (ep.n === 0) {
    if (ep.keyring !== null) fail("bad_form", "epoch 0 has no keyring");
  } else {
    if (!exactKeys(ep.keyring, ["hash"])) fail("bad_form", "a bad keyring");
    unb64(ep.keyring.hash, 32);
  }
  return Object.freeze({ n: ep.n, suite: ep.suite, commit: ep.commit, keyring: ep.keyring && Object.freeze({ hash: ep.keyring.hash }), seq, prev });
}

function copy(s) {
  return { ...s, devices: new Map(s.devices), epochs: [...s.epochs], used: new Set(s.used), hashes: [...s.hashes] };
}

/** The keyring row an entry starting a new epoch must come with: its metadata (keyring.mjs checkRingMeta). The
 * previous keyring is the current epoch's (its hash is in the current epoch's entry, which a reset keeps). */
export function ringMeta(state, body) {
  return { epoch: body.epoch.n, generation: body.op === "reset" ? body.generation : state.generation, suite: body.epoch.suite, prev: body.prev, prev_ring: state.epoch.keyring?.hash ?? "" };
}

/**
 * Verify one entry's bytes against `state` (null before genesis). `ctx`: { aud, account }. Returns { state, entry }.
 * Refusals: bad_form, bad_audience, bad_signature, chain_fork (not the next entry), device_unknown (a signer that
 * isn't a current device), bad_epoch, bad_suite, bad_keyring, key_reused.
 */
export async function apply(state, bytes, ctx) {
  if (state && (state.aud !== ctx.aud || state.account !== ctx.account)) fail("bad_form", "not this chain");
  const p = parse(bytes, ctx);
  if (p.type !== TYPE) fail("bad_form", "not a chain entry");
  const { body, signer } = p;
  const op = body.op;
  if (typeof op !== "string" || !Object.hasOwn(FIELDS, op) || !exactKeys(body, ["aud", "account", "seq", "prev", "op", ...FIELDS[op]])) fail("bad_form", "a bad entry");
  const seq = state ? state.seq + 1 : 0;
  if (!state && op !== "genesis") fail("bad_form", "a chain starts with genesis");
  if (state && op === "genesis") fail("bad_form", "one genesis");
  if (body.seq !== seq || body.prev !== (state ? state.head : "")) fail("chain_fork", "not the next entry");

  // (the signer, checked against the chain just before this entry)
  let raw;
  if (op === "genesis") {
    if (signer.kind !== "device" || signer.id !== body.device?.id) fail("bad_form", "genesis is signed by its device");
    raw = checkDevice(body.device).sign;
  } else if (signer.kind === "recovery") {
    if (!BY_RECOVERY.has(op)) fail("bad_signature", "the recovery key signs only a recovery or a reset");
    if (signer.id !== state.account || signer.key !== state.recovery.signKey) fail("bad_signature", "not the current recovery key");
    raw = state.recovery.sign;
  } else {
    if (BY_RECOVERY.has(op)) fail("bad_signature", "only the recovery key signs a recovery or a reset");
    const d = state.devices.get(signer.id);
    if (!d || d.removed !== null || d.signKey !== signer.key) fail("device_unknown", "not a current device");
    raw = d.sign;
  }
  if (signer.key !== (await keyId("ed25519", raw))) fail("bad_signature", "the signer's key id");
  if (!(await verifyStrict(raw, p.signed, p.sig))) fail("bad_signature", "the signature");

  // (the countersignatures: exactly the roles this op needs, each by the key the entry introduces)
  const roles = CO[op] ?? [];
  if (p.co.size !== roles.length || roles.some((r) => !p.co.has(r))) fail("bad_form", "the wrong countersignatures");
  for (const r of roles) {
    const k = r === "device" ? checkDevice(body.device).sign : checkRecovery(body.recovery).sign;
    if (!(await verifyStrict(k, p.signed, p.co.get(r)))) fail("bad_signature", "a countersignature");
  }

  const empty = () => ({
    aud: ctx.aud, account: ctx.account, seq: -1, head: "", devices: new Map(), recovery: null, epoch: null, epochs: [],
    minSuite: 1, used: new Set(), hashes: [], base: seq, generation: "",
  });
  // (a reset starts a new state: no old device, a fresh key-reuse set, the new generation, positions going on)
  const next = state && op !== "reset" ? copy(state) : empty();
  const fresh = async (alg, k) => {
    const id = `${alg}:${await keyId(alg, k)}`;
    if (next.used.has(id)) fail("key_reused", "a key this account has used before");
    next.used.add(id);
  };
  const enroll = async (d) => {
    const k = checkDevice(d);
    if (next.devices.has(d.id)) fail("key_reused", "a device id this account has used before");
    await fresh("ed25519", k.sign);
    await fresh("x25519", k.kem);
    next.devices.set(d.id, Object.freeze({ id: d.id, name: d.name, kind: d.kind, sign: k.sign, signKey: await keyId("ed25519", k.sign),
      kem: k.kem, kemKey: await keyId("x25519", k.kem), added: seq, removed: null }));
  };
  const setRecovery = async (r) => {
    const k = checkRecovery(r);
    await fresh("ed25519", k.sign);
    await fresh("x25519", k.kem);
    next.recovery = Object.freeze({ sign: k.sign, signKey: await keyId("ed25519", k.sign), kem: k.kem, kemKey: await keyId("x25519", k.kem), seq });
  };
  const startEpoch = (ep) => {
    next.epoch = checkEpoch(ep, state ? state.epoch.n + 1 : 0, state ? state.minSuite : 1, body.prev, seq);
    next.epochs.push(next.epoch);
  };

  switch (op) {
    case "genesis":
      await enroll(body.device);
      await setRecovery(body.recovery);
      startEpoch(body.epoch);
      break;
    case "add":
      checkPop(body.pop);
      await enroll(body.device);
      break;
    case "remove": {
      const t = next.devices.get(body.remove);
      if (typeof body.remove !== "string" || !t || t.removed !== null) fail("device_unknown", "not a current device");
      if (body.remove === signer.id) fail("bad_form", "a device can't remove itself");
      next.devices.set(t.id, Object.freeze({ ...t, removed: seq }));
      startEpoch(body.epoch);
      break;
    }
    case "epoch":
      startEpoch(body.epoch);
      break;
    case "recover":
      await enroll(body.device);
      await setRecovery(body.recovery);
      startEpoch(body.epoch);
      break;
    case "replace-recovery":
      checkPop(body.pop);
      await setRecovery(body.recovery);
      break;
    case "min-suite":
      if (!knownSuite(body.min_suite) || body.min_suite <= next.minSuite || body.min_suite > next.epoch.suite) fail("bad_suite", "the minimum suite only rises, to a suite in use");
      next.minSuite = body.min_suite;
      break;
    case "reset":
      if (!isId(body.generation) || body.generation === state.generation) fail("bad_form", "a reset names a fresh generation");
      if (body.min_suite !== state.minSuite) fail("bad_suite", "a reset carries the minimum suite exactly");
      next.minSuite = state.minSuite;
      next.generation = body.generation;
      await enroll(body.device);
      await setRecovery(body.recovery);
      startEpoch(body.epoch);
      break;
  }
  next.seq = seq;
  next.head = await sha256b64(p.signed);
  next.hashes.push(next.head);
  if (op === "genesis") next.generation = next.head;
  return { state: Object.freeze(next), entry: Object.freeze({ op, seq, signer, body }) };
}

/**
 * Load a chain that starts at a reset (its earlier entries compacted away), under a trusted anchor. The reset can't be
 * re-verified from nothing (its signer, the old recovery key, lived in the dropped prefix), so the anchor stands for that
 * verification: { account, aud, generation, seq, hash } from the enrollment transcript, or the store's own record of the
 * reset it verified; or { code } (the recovery keys a typed code derives): then the chain's current recovery key must be
 * the code's, which countersigned the entry that introduced it. The reset's own countersignatures (its new device and new
 * recovery key, both named in its body) are checked either way. Returns the state at the reset.
 */
export async function loadAnchored(bytes, ctx, anchor) {
  const p = parse(bytes, ctx);
  const { body } = p;
  if (p.type !== TYPE || body.op !== "reset" || !exactKeys(body, ["aud", "account", "seq", "prev", "op", ...FIELDS.reset]) || p.signer.kind !== "recovery" || p.signer.id !== ctx.account)
    fail("bad_form", "not a reset");
  if (!Number.isSafeInteger(body.seq) || body.seq < 1 || !isId(body.generation) || typeof body.prev !== "string") fail("bad_form", "not a reset");
  const head = await sha256b64(p.signed);
  if (anchor && !("code" in anchor)) {
    if (!exactKeys(anchor, ["account", "aud", "generation", "seq", "hash"]) || anchor.account !== ctx.account || anchor.aud !== ctx.aud || anchor.generation !== body.generation || anchor.seq !== body.seq || anchor.hash !== head)
      fail("chain_unanchored", "not the anchored reset");
  } else if (!anchor?.code) fail("chain_unanchored", "a compacted chain without an anchor");
  for (const r of ["device", "recovery"]) {
    const k = r === "device" ? checkDevice(body.device).sign : checkRecovery(body.recovery).sign;
    if (!p.co.has(r) || p.co.size !== 2 || !(await verifyStrict(k, p.signed, p.co.get(r)))) fail("bad_signature", "a countersignature");
  }
  if (!knownSuite(body.min_suite)) fail("bad_suite", "an unknown suite");
  const seq = body.seq;
  const next = { aud: ctx.aud, account: ctx.account, seq, head, devices: new Map(), recovery: null, epoch: null, epochs: [], minSuite: body.min_suite, used: new Set(), hashes: [head], base: seq, generation: body.generation };
  const k = checkDevice(body.device), r = checkRecovery(body.recovery);
  for (const [alg, key] of [["ed25519", k.sign], ["x25519", k.kem], ["ed25519", r.sign], ["x25519", r.kem]]) next.used.add(`${alg}:${await keyId(alg, key)}`);
  next.devices.set(body.device.id, Object.freeze({ id: body.device.id, name: body.device.name, kind: body.device.kind, sign: k.sign, signKey: await keyId("ed25519", k.sign), kem: k.kem, kemKey: await keyId("x25519", k.kem), added: seq, removed: null }));
  next.recovery = Object.freeze({ sign: r.sign, signKey: await keyId("ed25519", r.sign), kem: r.kem, kemKey: await keyId("x25519", r.kem), seq });
  next.epoch = checkEpoch(body.epoch, null, body.min_suite, body.prev, seq);
  next.epochs.push(next.epoch);
  return Object.freeze(next);
}

/**
 * A claimed reset's cheap preflight, before any replay or package work: its form, and its outer signature by the
 * account's current recovery key (`recovery`: { sign: 32-byte public key, signKey: its id }, as the store records it at
 * the head). One Ed25519 check; anything else refuses here.
 */
export async function preflightReset(bytes, ctx, recovery) {
  const p = parse(bytes, ctx);
  if (p.type !== TYPE || p.body.op !== "reset" || p.signer.kind !== "recovery" || p.signer.id !== ctx.account || !recovery || p.signer.key !== recovery.signKey)
    fail("bad_signature", "not signed by the current recovery key");
  if (!(await verifyStrict(recovery.sign, p.signed, p.sig))) fail("bad_signature", "not signed by the current recovery key");
  return true;
}

/** The canonical checkpoint a store keeps with a reset it committed, and its hash (checked again after a restart). */
export async function checkpointOf(state) {
  const text = canonText({ v: 1, account: state.account, aud: state.aud, generation: state.generation, seq: state.base, hash: state.hashes[0], epoch: state.epoch.n, recovery: state.recovery.signKey, devices: [...state.devices.keys()].sort() });
  return { text, hash: await sha256b64(new TextEncoder().encode(text)) };
}

/**
 * Verify a chain: from genesis, or from a reset under `anchor` (see loadAnchored). A `pin` ({ seq, hash, generation })
 * must be on it: another generation, another hash at the pin's position, or a chain shorter than the pin refuses.
 */
export async function replayFrom(entries, ctx, { anchor = null, pin = null } = {}) {
  if (!entries.length) fail("bad_form", "an empty chain");
  const first = parse(entries[0], ctx).body;
  let state = first.op === "reset" ? await loadAnchored(entries[0], ctx, anchor) : (await apply(null, entries[0], ctx)).state;
  for (const bytes of entries.slice(1)) state = (await apply(state, bytes, ctx)).state;
  if (anchor?.code && (anchor.code.sign.key !== state.recovery.signKey || (await keyId("x25519", anchor.code.kem.publicRaw)) !== state.recovery.kemKey))
    fail("chain_unanchored", "the recovery code isn't this chain's");
  checkPin(state, pin);
  return state;
}

/** Verify a whole chain from genesis (no anchor; a compacted chain needs replayFrom with one). */
export const replay = (entries, ctx, pin = null) => replayFrom(entries, ctx, { pin });

const PIN_HASH = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** Refuse a state that doesn't extend `pin` ({ seq, hash, generation } exactly). A pin of another generation means the
 * chain was reset since: chain_reset (the device enrolls again). */
export function checkPin(state, pin) {
  if (pin === null || pin === undefined) return;
  if (!exactKeys(pin, ["seq", "hash", "generation"]) || !Number.isSafeInteger(pin.seq) || pin.seq < 0 || typeof pin.hash !== "string" || !PIN_HASH.test(pin.hash) || typeof pin.generation !== "string")
    fail("bad_form", "not a chain position");
  if (pin.generation !== state.generation) fail("chain_reset", "the chain was reset since this pin");
  if (pin.seq > state.seq) fail("chain_fork", "a rollback");
  if (pin.seq < state.base || state.hashes[pin.seq - state.base] !== pin.hash) fail("chain_fork", "a fork");
}

/** The pin for a state's head. */
export const pinOf = (state) => ({ seq: state.seq, hash: state.head, generation: state.generation });

/** A device current at the head. */
export function currentDevice(state, id) {
  const d = state.devices.get(id);
  return d && d.removed === null ? d : null;
}

/** The epoch current at chain position `seq`. */
export function epochAt(state, seq) {
  let e = null;
  for (const x of state.epochs) if (x.seq <= seq) e = x;
  return e;
}

// ---- writing entries (the device side): a body for the state's next position, sealed

/** A body for the next entry after `state` (null: genesis). */
export function nextBody(state, ctx, op, fields) {
  return { aud: ctx.aud, account: ctx.account, seq: state ? state.seq + 1 : 0, prev: state ? state.head : "", op, ...fields };
}

/** The signer object for a device key or the recovery key. */
export const deviceSigner = (id, key) => ({ kind: "device", id, alg: "ed25519", key: key.key });
export const recoverySigner = (account, key) => ({ kind: "recovery", id: account, alg: "ed25519", key: key.key });

/** Seal an entry: `key` signs; `co` holds the countersigning keys by role. */
export const sealEntry = (signer, body, key, co = {}) => seal(TYPE, signer, body, key, co);
