// Delivering an epoch secret (§2, §3.4): S[n] HPKE-wrapped to one device's X25519 key or to the recovery key's, inside
// a signed context. RFC 9180's base mode authenticates no sender and stops no replay, so:
// - HPKE's `info` is the canonical encoding of the wrapper's whole context, wrapper id included: protocol and
//   version, purpose, account, the sender (its device id and signing-key id, which must be the envelope's signer), the
//   chain position the sender saw, recipient (kind, id and KEM key id), epoch. So enc and ct can't be moved into an
//   envelope another device signs: its context names another sender, and HPKE won't open under a rewritten one;
// - the outer envelope ("sb.e2e-wrap.v1") is signed by the sender, a current device, over that context plus `enc`
//   and the ciphertext;
// - the recipient checks the signature against its pinned chain, that every field names itself and the epoch it
//   expects, that the secret matches the epoch's signed commitment, and that the wrapper id is new to it. It records
//   the id durably before acting; installing an epoch secret is idempotent, so a crash between the two is harmless.
//
// checkTransition is what travels with a chain entry: the entry, its keyring and the wrappers of its epoch secret,
// checked as one package before any of it is published. openRecovery is the one boundary a recovery code goes
// through: every way it can fail is the same `recovery_failed`.
//
// `hpke` is PR 1's object (seal, open); recipients are { publicRaw, privateKey }.

import { b64, concat, enc, isId, newId, sha256b64, unb64 } from "../../fleet/core/bytes.mjs";
import { canonText } from "../../fleet/core/canonical.mjs";
import { keyId, verifyStrict } from "../../fleet/core/ed25519.mjs";
import { E2EError, exactKeys, fail } from "./base.mjs";
import { apply, currentDevice, epochAt } from "./chain.mjs";
import { parse, seal } from "./envelope.mjs";
import { epochCommit } from "./keyring.mjs";
import { recoveryKeys, seedOfCode } from "./recovery.mjs";

export const TYPE = "sb.e2e-wrap.v1";
const AAD = enc("sagebrush.e2e.wrap.v1");
const FIELDS = ["aud", "account", "id", "purpose", "epoch", "chain_seq", "sender", "recipient", "enc", "ct"];

/** HPKE's info: the canonical context, everything but enc and ct. */
export const contextOf = (body) => {
  const { enc: _e, ct: _c, ...rest } = body;
  return concat("sagebrush.e2e.wrap.v1\n", canonText(rest));
};

/** The recipient's KEM key in the chain at the head: { kind, id, kem raw, kemKey }. */
function recipientKey(state, recipient) {
  if (recipient.kind === "recovery") {
    if (recipient.id !== state.account) fail("bad_form", "not this account's recovery key");
    return state.recovery;
  }
  if (recipient.kind !== "device") fail("bad_form", "a bad recipient");
  const d = currentDevice(state, recipient.id);
  if (!d) fail("device_unknown", "not a current device");
  return d;
}

/**
 * Wrap epoch n's secret S for one recipient ({ kind: "device" | "recovery", id }). The sender is a current device
 * ({ id, sign }, `sign` in the fleet core's key shape). Returns the envelope's bytes.
 */
export async function wrapEpoch({ hpke, state, ctx, sender, recipient, n, S }) {
  const e = state.epochs.find((x) => x.n === n);
  if (!e || epochAt(state, state.seq).n !== n) fail("bad_epoch", "only the current epoch is wrapped");
  if ((await epochCommit(S, state.account, n)) !== e.commit) fail("bad_epoch", "not this epoch's secret");
  const r = recipientKey(state, recipient);
  const body = {
    aud: ctx.aud, account: ctx.account, id: newId(), purpose: recipient.kind === "recovery" ? "recovery" : "epoch", epoch: n,
    chain_seq: state.seq, sender: { id: sender.id, key: sender.sign.key }, recipient: { kind: recipient.kind, id: recipient.id, kem: r.kemKey },
  };
  const sealed = await hpke.seal(r.kem, contextOf(body), AAD, S);
  body.enc = b64(sealed.enc);
  body.ct = b64(sealed.ct);
  return seal(TYPE, { kind: "device", id: sender.id, alg: "ed25519", key: sender.sign.key }, body, sender.sign);
}

/**
 * A wrapper's form, sender and signature against the chain `state`, without opening it: the sender is a device current
 * at the head and already enrolled at the position it names, its signature holds, the context names it, the recipient
 * is a current key, and the epoch is the one current at that position. Returns the body.
 */
export async function verifyWrapper(state, ctx, bytes) {
  const p = parse(bytes, ctx);
  if (p.type !== TYPE) fail("bad_form", "not a wrapper");
  const b = p.body;
  if (!exactKeys(b, FIELDS) || !exactKeys(b.recipient, ["kind", "id", "kem"]) || !exactKeys(b.sender, ["id", "key"]) || !isId(b.id))
    fail("bad_form", "a bad wrapper");
  const d = currentDevice(state, p.signer.id);
  if (!d || d.signKey !== p.signer.key || !Number.isSafeInteger(b.chain_seq) || b.chain_seq < d.added || b.chain_seq > state.seq)
    fail("device_unknown", "not a current device");
  if (p.signer.key !== (await keyId("ed25519", d.sign)) || !(await verifyStrict(d.sign, p.signed, p.sig))) fail("bad_signature", "the signature");
  // (the sender named inside the HPKE context is the envelope's signer)
  if (b.sender.id !== p.signer.id || b.sender.key !== p.signer.key) fail("bad_form", "the context names another sender");
  if (b.purpose !== (b.recipient.kind === "recovery" ? "recovery" : "epoch")) fail("bad_form", "a bad purpose");
  if (b.recipient.kem !== recipientKey(state, b.recipient).kemKey) fail("bad_form", "not the recipient's current key");
  const e = epochAt(state, b.chain_seq);
  if (!e || e.n !== b.epoch) fail("bad_epoch", "not the epoch current at that position");
  unb64(b.enc, 32);
  unb64(b.ct);
  return b;
}

/**
 * Open a wrapper addressed to `me` ({ kind, id, recipient: { publicRaw, privateKey } }), against the pinned chain
 * `state`. `seen(id)` says whether this wrapper id was processed already. Returns { id, n, S }; the caller records `id`
 * durably, then installs S.
 */
export async function openWrapper({ hpke, state, ctx, bytes, me, seen }) {
  const b = await verifyWrapper(state, ctx, bytes);
  if (b.recipient.kind !== me.kind || b.recipient.id !== me.id) fail("bad_form", "not addressed to this key");
  if ((await keyId("x25519", me.recipient.publicRaw)) !== b.recipient.kem) fail("bad_form", "not this key");
  if (await seen(b.id)) fail("replayed", "a wrapper already processed");
  let S;
  try {
    S = await hpke.open(me.recipient, unb64(b.enc, 32), contextOf(b), AAD, unb64(b.ct));
  } catch {
    fail("bad_wrapper", "the wrapper doesn't open");
  }
  if (!(S instanceof Uint8Array) || S.length !== 32 || (await epochCommit(S, state.account, b.epoch)) !== epochAt(state, b.chain_seq).commit) {
    S?.fill?.(0);
    fail("bad_wrapper", "not this epoch's secret");
  }
  return { id: b.id, n: b.epoch, S };
}

/** The recipients an entry's package must wrap to: every current device and the recovery key when it starts an
 * epoch; the new device after an add; the new recovery key after a replacement; nobody otherwise. */
function recipientsFor(next, entry) {
  const all = () => [...[...next.devices.values()].filter((d) => d.removed === null).map((d) => `device:${d.id}`), `recovery:${next.account}`];
  switch (entry.op) {
    case "genesis": case "remove": case "epoch": case "recover": return all();
    case "add": return [`device:${entry.body.device.id}`];
    case "replace-recovery": return [`recovery:${next.account}`];
    default: return [];
  }
}

/**
 * Check a chain entry with everything that must travel with it, before any of it is published: the entry extends
 * `state`; a new epoch's keyring is present and is the one its entry commits to (and none comes otherwise); and the
 * wrappers are exactly one per required recipient, each valid at the new head, for the new head's position and
 * current epoch, with distinct ids. Returns the new state. (The secrets inside can only be checked by their
 * recipients, against the signed commitments: openWrapper and openKeyring do.) The store that accepts an entry keeps
 * it and its package together, in one transaction, or neither.
 */
export async function checkTransition({ state, ctx, entry, keyring = null, wrappers = [] }) {
  const { state: next, entry: e } = await apply(state, entry, ctx);
  const startsEpoch = ["genesis", "remove", "epoch", "recover"].includes(e.op);
  if (startsEpoch && next.epoch.n > 0) {
    if (!(keyring instanceof Uint8Array) || (await sha256b64(keyring)) !== next.epoch.keyring.hash) fail("bad_package", "the epoch's keyring is missing or isn't the committed one");
  } else if (keyring !== null) fail("bad_package", "a keyring with no new epoch");
  const want = recipientsFor(next, e);
  const got = new Set(), ids = new Set();
  for (const w of wrappers) {
    const b = await verifyWrapper(next, ctx, w);
    const who = `${b.recipient.kind}:${b.recipient.id}`;
    if (b.chain_seq !== next.seq || b.epoch !== next.epoch.n) fail("bad_package", "a wrapper for another position");
    if (got.has(who) || ids.has(b.id)) fail("bad_package", "a recipient or wrapper id twice");
    got.add(who);
    ids.add(b.id);
  }
  if (got.size !== want.length || want.some((r) => !got.has(r))) fail("bad_package", "not exactly the required recipients");
  return next;
}

const RECOVERY_FAILED = "that recovery code doesn't open this account";

/**
 * A recovery attempt: the typed code, against the chain `state` and the latest wrapper to the recovery key (which the
 * caller fetches by account, never by anything derived from the code). Every failure, whatever its cause (a malformed
 * code, a well-formed wrong or old one, a wrapper that doesn't open or doesn't verify), is the same `recovery_failed`.
 * Returns { sign, kem, id, n, S }: the recovery keys (to sign the `recover` entry), the wrapper id and the epoch secret.
 */
export async function openRecovery({ hpke, state, ctx, typed, wrapper, seen }) {
  let seed;
  try {
    seed = seedOfCode(typed);
    const keys = await recoveryKeys(seed, state.account);
    if (keys.sign.key !== state.recovery.signKey || (await keyId("x25519", keys.kem.publicRaw)) !== state.recovery.kemKey) fail("recovery_failed", RECOVERY_FAILED);
    const r = await openWrapper({ hpke, state, ctx, bytes: wrapper, me: { kind: "recovery", id: state.account, recipient: keys.kem }, seen });
    return { sign: keys.sign, kem: keys.kem, ...r };
  } catch {
    throw new E2EError("recovery_failed", RECOVERY_FAILED);
  } finally {
    seed?.fill(0);
  }
}
