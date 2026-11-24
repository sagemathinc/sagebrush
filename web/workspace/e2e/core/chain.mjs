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
//
// Every epoch entry names the epoch's suite, a commitment to its secret, and (from epoch 1) its keyring's hash and
// the ordered list of earlier epochs it carries (§11.2). Device ids and keys are never reused, even after removal.
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
// Not here, by design: the inbox key and its rotation (shares, after launch), and rotating a device's own keys
// (§11.1's cross-certification) and compaction's dropping of old epochs (§11.2): each comes with its own entry type.

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
});
/** The countersignatures each op must carry, exactly. */
const CO = Object.freeze({ genesis: ["recovery"], add: ["device"], recover: ["device", "recovery"], "replace-recovery": ["recovery"] });
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

/** The earlier epochs a new epoch's keyring must carry: every one before it (nothing is dropped without compaction). */
const heldBefore = (state) => state.epochs.map((e) => e.n);

function checkEpoch(ep, state, prev, seq) {
  if (!exactKeys(ep, ["n", "suite", "commit", "keyring"])) fail("bad_form", "a bad epoch");
  const n = state ? state.epoch.n + 1 : 0;
  if (ep.n !== n) fail("bad_epoch", "not the next epoch");
  if (!knownSuite(ep.suite)) fail("bad_suite", "an unknown suite");
  if (state && ep.suite < state.minSuite) fail("bad_suite", "below the account's minimum suite");
  unb64(ep.commit, 32);
  if (n === 0) {
    if (ep.keyring !== null) fail("bad_form", "epoch 0 has no keyring");
  } else {
    if (!exactKeys(ep.keyring, ["hash", "epochs"]) || !Array.isArray(ep.keyring.epochs)) fail("bad_form", "a bad keyring");
    unb64(ep.keyring.hash, 32);
    if (canonText(ep.keyring.epochs) !== canonText(heldBefore(state))) fail("bad_keyring", "a keyring must carry every earlier epoch");
  }
  return Object.freeze({ n, suite: ep.suite, commit: ep.commit, keyring: ep.keyring && Object.freeze({ hash: ep.keyring.hash, epochs: Object.freeze([...ep.keyring.epochs]) }), seq, prev });
}

function copy(s) {
  return { ...s, devices: new Map(s.devices), epochs: [...s.epochs], used: new Set(s.used), hashes: [...s.hashes] };
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
    if (op !== "recover") fail("bad_signature", "the recovery key signs only a recovery");
    if (signer.id !== state.account || signer.key !== state.recovery.signKey) fail("bad_signature", "not the current recovery key");
    raw = state.recovery.sign;
  } else {
    if (op === "recover") fail("bad_signature", "only the recovery key signs a recovery");
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

  const next = state ? copy(state) : {
    aud: ctx.aud, account: ctx.account, seq: -1, head: "", devices: new Map(), recovery: null, epoch: null, epochs: [],
    minSuite: 1, used: new Set(), hashes: [],
  };
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
    next.epoch = checkEpoch(ep, state, body.prev, seq);
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
  }
  next.seq = seq;
  next.head = await sha256b64(p.signed);
  next.hashes.push(next.head);
  return { state: Object.freeze(next), entry: Object.freeze({ op, seq, signer, body }) };
}

/**
 * Verify a whole chain from genesis. A `pin` ({ seq, hash }) must be on it: another hash at the pin's seq is a fork,
 * and a chain shorter than the pin is a rollback; both refuse with chain_fork.
 */
export async function replay(entries, ctx, pin = null) {
  let state = null;
  for (const bytes of entries) state = (await apply(state, bytes, ctx)).state;
  if (!state) fail("bad_form", "an empty chain");
  checkPin(state, pin);
  return state;
}

const PIN_HASH = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** Refuse a state that doesn't extend `pin` ({ seq, hash } exactly: a safe non-negative seq, a canonical hash). */
export function checkPin(state, pin) {
  if (pin === null || pin === undefined) return;
  if (!exactKeys(pin, ["seq", "hash"]) || !Number.isSafeInteger(pin.seq) || pin.seq < 0 || typeof pin.hash !== "string" || !PIN_HASH.test(pin.hash))
    fail("bad_form", "not a chain position");
  if (pin.seq > state.seq) fail("chain_fork", "a rollback");
  if (state.hashes[pin.seq] !== pin.hash) fail("chain_fork", "a fork");
}

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
