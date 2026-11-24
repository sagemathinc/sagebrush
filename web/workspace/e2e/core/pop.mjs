// Proof of possession for a new X25519 key (§11.1). KEM keys can't sign, so a chain entry naming one is signed by a
// current device, and the new key's holder proves it holds the private half, without circularity:
// - the pre-entry hash is the SHA-256 of the entry's body without its proof (protocol, account, predecessor hash, the
//   key's owner and role, the new public key);
// - the challenger (the device signing the entry) HPKE-encapsulates to the new key, with info = "sagebrush.kem-pop.v1"
//   and the pre-entry hash, and keeps the exported secret;
// - the holder decapsulates and returns MAC = HMAC-SHA256(export(ss, "pop"), pre-entry hash || enc);
// - the challenger checks the MAC; the final body carries { enc, mac }, and the entry's signatures cover them.
// Other devices verify the signatures; only the challenger could check the MAC itself.
//
// `hpke` is PR 1's object (sendExport, receiveExport); recipients are { publicRaw, privateKey }.

import { concat, enc, sha256, unb64 } from "../../fleet/core/bytes.mjs";
import { canonText } from "../../fleet/core/canonical.mjs";
import { LABELS, fail, sameBytes, subtle } from "./base.mjs";

const CONTEXT = enc("pop");

/** The pre-entry hash of a body (its `pop` field left out). */
export async function preEntryHash(body) {
  const { pop: _pop, ...rest } = body;
  return sha256(concat("sagebrush.e2e.pre-entry.v1\n", canonText(rest)));
}

const popInfo = (pre) => concat(`${LABELS.kemPop}\n`, pre);

async function mac(secret, pre, encap) {
  const key = await subtle().importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", key, concat(pre, encap)));
}

/** The challenger's half: { enc (to send the holder), secret (kept) }. */
export async function challenge(hpke, kemPublicRaw, pre) {
  const r = await hpke.sendExport(kemPublicRaw, popInfo(pre), CONTEXT, 32);
  return { enc: r.enc, secret: r.secret };
}

/** The holder's answer to a challenge. */
export async function respond(hpke, recipient, encap, pre) {
  const secret = await hpke.receiveExport(recipient, encap, popInfo(pre), CONTEXT, 32);
  try {
    return await mac(secret, pre, encap);
  } finally {
    secret.fill(0);
  }
}

/** The challenger's check of the holder's MAC: true or a refusal. It consumes `secret`: zeroed either way. */
export async function checkResponse(secret, encap, pre, answer) {
  let want;
  try {
    want = await mac(secret, pre, encap);
    if (!sameBytes(want, answer instanceof Uint8Array ? answer : unb64(answer, 32))) fail("bad_pop", "the new key's proof of possession failed");
    return true;
  } finally {
    secret.fill(0);
    want?.fill(0);
  }
}
