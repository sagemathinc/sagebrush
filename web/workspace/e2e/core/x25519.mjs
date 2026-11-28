// X25519 key pairs for receiving epoch secrets (§2): device keys here; the recovery key's KEM half is seeded.mjs's. The private half is a
// non-extractable WebCrypto key; only the 32-byte public half is ever read. A public key this protocol accepts is
// canonical (below p, top bit clear) and not one of the low-order points that would make every shared secret zero.
// A key pair is { publicRaw, privateKey }, the shape PR 1's hpke.open takes as its recipient.

import { fail, subtle } from "./base.mjs";

const X = { name: "X25519" };

const hex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
// (the low-order u-coordinates below p: 0, 1, the two points of order 8, and p - 1)
const LOW = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map(hex);

/** Whether 32 bytes, little-endian, are below p = 2^255 - 19 (and so have the top bit clear). */
function belowP(raw) {
  if (raw[31] > 0x7f) return false;
  if (raw[31] < 0x7f) return true;
  for (let i = 30; i >= 1; i--) if (raw[i] !== 0xff) return true;
  return raw[0] < 0xed;
}

/** A public key this protocol accepts, or a refusal. */
export function checkKemPublic(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32 || !belowP(raw)) fail("bad_key", "an unacceptable X25519 key");
  for (const l of LOW) if (l.every((b, i) => b === raw[i])) fail("bad_key", "an unacceptable X25519 key");
  return raw;
}

/** A new key pair made on this device, with a non-extractable private key. */
export async function newKem() {
  const kp = /** @type {CryptoKeyPair} */ (await subtle().generateKey(X, false, ["deriveBits"]));
  const publicRaw = new Uint8Array(await subtle().exportKey("raw", kp.publicKey));
  return Object.freeze({ publicRaw: checkKemPublic(publicRaw), privateKey: kp.privateKey });
}
