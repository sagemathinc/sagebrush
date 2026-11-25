// Fleet protocol (r2.2 §1.4): strict Ed25519. Libraries differ: Node 20 and 22 accept a signature (R = the identity,
// S = 0) under a small-order public key for any message, Node 24 and 26 refuse it, and WebCrypto implementations
// differ again. So the rules are checked here, before the installed backend (crypto.mjs) is asked, and never left to
// it:
//   - a public key, and R, must be canonical encodings (y < p, and no sign bit on a point whose x is 0);
//   - a public key must not be of small order (one of the eight torsion points, under either sign bit);
//   - S must be below the group order L.

import { b64, concat, enc, refuse, sha256 } from "./bytes.mjs";
import { crypto } from "./crypto.mjs";

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

const le = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const hex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));

// The y coordinates of the small-order points (torsion of order 1, 2, 4 and 8), compared with the sign bit cleared.
const SMALL_Y = new Set([
  1n, // order 1
  P - 1n, // order 2
  0n, // order 4
  le(hex("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05")), // order 8
  le(hex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a")), // order 8
]);

function yOf(point) {
  const b = Uint8Array.from(point);
  const sign = b[31] >> 7;
  b[31] &= 0x7f;
  return { y: le(b), sign };
}

/** Whether 32 bytes are a canonical point encoding: y < p, and a sign bit only where x can be non-zero. */
export function canonicalPoint(point) {
  if (point.length !== 32) return false;
  const { y, sign } = yOf(point);
  if (y >= P) return false;
  if (sign && (y === 1n || y === P - 1n)) return false; // (x = 0 at y = ±1: a set sign bit is a second spelling)
  return true;
}

export const smallOrder = (point) => SMALL_Y.has(yOf(point).y % P);

/** A public key this protocol accepts (§1.4): canonical and not of small order. Refuses with bad_signature. */
export function checkPublicKey(raw) {
  if (!canonicalPoint(raw) || smallOrder(raw)) refuse("bad_signature", "an unacceptable public key");
  return raw;
}

/** The bytes a key id hashes (§1.4): "sagebrush.key.v1\n" + alg + "\n" + key. */
export const keyIdInput = (alg, raw) => concat(`sagebrush.key.v1\n${alg}\n`, raw);
/** The key id of a public key (§1.4): base64url of the first 16 bytes of SHA-256(keyIdInput). */
export const keyId = async (alg, raw) => b64((await sha256(keyIdInput(alg, raw))).subarray(0, 16));

/**
 * The strict rules alone (§1.4), with no library: lengths, a canonical public key that isn't of small order, a
 * canonical R, and S < L. A signature that fails them is false whatever any library says.
 */
export function strictShape(raw, sig) {
  if (raw?.length !== 32 || sig?.length !== 64) return false;
  if (!canonicalPoint(raw) || smallOrder(raw)) return false;
  if (!canonicalPoint(sig.subarray(0, 32))) return false;
  return le(sig.subarray(32)) < L;
}

/** Strict verification of a 64-byte signature over `msg` by a 32-byte public key. True or false; never throws on bytes. */
export async function verifyStrict(raw, msg, sig) {
  if (!strictShape(raw, sig)) return false;
  try { return (await crypto().ed25519Verify(raw, msg, sig)) === true; } catch { return false; }
}

// ---- signing, for the app, the host, the page and the fixtures (a private key never leaves its holder)

/**
 * A signing key as the envelope uses it: { raw, key: its id, sign(msg) -> Promise<64 bytes> }. `sign` is the holder's
 * own (a keychain call, a non-extractable WebCrypto key); the public key must be one this protocol accepts.
 */
export async function asKey(raw, sign) {
  checkPublicKey(raw);
  const id = await keyId("ed25519", raw);
  return Object.freeze({
    raw, key: id,
    sign: async (msg) => {
      const sig = await sign(msg);
      if (!(sig instanceof Uint8Array) || sig.length !== 64) throw new Error("a signer gave other than 64 bytes");
      return sig;
    },
  });
}

/** A key from a 32-byte seed (fixtures and recovery, §2.5). */
export async function keyFromSeed(seed) {
  if (seed?.length !== 32) refuse("bad_form", "a seed is 32 bytes");
  const k = await crypto().ed25519FromSeed(seed);
  return asKey(k.raw, k.sign);
}

export { enc };
