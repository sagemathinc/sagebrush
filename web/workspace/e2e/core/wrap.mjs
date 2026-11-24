// Delivering an epoch secret (§2, §3.4): S[n] HPKE-wrapped to one device's X25519 key or to the recovery key's, inside
// a signed context. RFC 9180's base mode authenticates no sender and stops no replay, so:
// - HPKE's `info` is the canonical encoding of the wrapper's whole context, wrapper id included: protocol and
//   version, purpose, account, sender, the chain position the sender saw, recipient (kind, id and KEM key id), epoch;
// - the outer envelope ("sb.e2e-wrap.v1") is signed by the sender, a current device, over that context plus `enc`
//   and the ciphertext;
// - the recipient checks the signature against its pinned chain, that every field names itself and the epoch it
//   expects, that the secret matches the epoch's signed commitment, and that the wrapper id is new to it. It records
//   the id durably before acting; installing an epoch secret is idempotent, so a crash between the two is harmless.
//
// `hpke` is PR 1's object (seal, open); recipients are { publicRaw, privateKey }.

import { b64, concat, enc, isId, newId, unb64 } from "../../fleet/core/bytes.mjs";
import { canonText } from "../../fleet/core/canonical.mjs";
import { keyId, verifyStrict } from "../../fleet/core/ed25519.mjs";
import { exactKeys, fail } from "./base.mjs";
import { currentDevice, epochAt } from "./chain.mjs";
import { parse, seal } from "./envelope.mjs";
import { epochCommit } from "./keyring.mjs";

export const TYPE = "sb.e2e-wrap.v1";
const AAD = enc("sagebrush.e2e.wrap.v1");
const FIELDS = ["aud", "account", "id", "purpose", "epoch", "chain_seq", "recipient", "enc", "ct"];

const contextOf = (body) => {
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
    chain_seq: state.seq, recipient: { kind: recipient.kind, id: recipient.id, kem: r.kemKey },
  };
  const sealed = await hpke.seal(r.kem, contextOf(body), AAD, S);
  body.enc = b64(sealed.enc);
  body.ct = b64(sealed.ct);
  return seal(TYPE, { kind: "device", id: sender.id, alg: "ed25519", key: sender.sign.key }, body, sender.sign);
}

/**
 * Open a wrapper addressed to `me` ({ kind, id, recipient: { publicRaw, privateKey } }), against the pinned chain
 * `state`. `seen(id)` says whether this wrapper id was processed already. Returns { id, n, S }; the caller records `id`
 * durably, then installs S.
 */
export async function openWrapper({ hpke, state, ctx, bytes, me, seen }) {
  const p = parse(bytes, ctx);
  if (p.type !== TYPE) fail("bad_form", "not a wrapper");
  const b = p.body;
  if (!exactKeys(b, FIELDS) || !exactKeys(b.recipient, ["kind", "id", "kem"]) || !isId(b.id))
    fail("bad_form", "a bad wrapper");
  // (the sender: a device current at the head, and already enrolled at the position it names)
  const d = currentDevice(state, p.signer.id);
  if (!d || d.signKey !== p.signer.key || !Number.isSafeInteger(b.chain_seq) || b.chain_seq < d.added || b.chain_seq > state.seq)
    fail("device_unknown", "not a current device");
  if (p.signer.key !== (await keyId("ed25519", d.sign)) || !(await verifyStrict(d.sign, p.signed, p.sig))) fail("bad_signature", "the signature");
  // (every field names this recipient, this account and the epoch current at the sender's position)
  if (b.recipient.kind !== me.kind || b.recipient.id !== me.id || b.purpose !== (me.kind === "recovery" ? "recovery" : "epoch")) fail("bad_form", "not addressed to this key");
  const r = recipientKey(state, b.recipient);
  if (b.recipient.kem !== r.kemKey || (await keyId("x25519", me.recipient.publicRaw)) !== r.kemKey) fail("bad_form", "not this key");
  const e = epochAt(state, b.chain_seq);
  if (!e || e.n !== b.epoch) fail("bad_epoch", "not the epoch current at that position");
  if (await seen(b.id)) fail("replayed", "a wrapper already processed");
  let S;
  try {
    S = await hpke.open(me.recipient, unb64(b.enc, 32), contextOf(b), AAD, unb64(b.ct));
  } catch {
    fail("bad_wrapper", "the wrapper doesn't open");
  }
  if (!(S instanceof Uint8Array) || S.length !== 32 || (await epochCommit(S, state.account, e.n)) !== e.commit) {
    S?.fill?.(0);
    fail("bad_wrapper", "not this epoch's secret");
  }
  return { id: b.id, n: e.n, S };
}
