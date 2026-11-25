// Keys from secret bytes (the recovery key, §2), with no private material ever exported (SEC): the private halves are
// imported non-extractable, and the public halves are derived through those keys alone.
// - X25519: the public key is X25519(k, 9), so it is deriveBits of the private key against the base point u = 9.
// - Ed25519: the private scalar a is the clamped first half of SHA-512(seed), and the public key is a·B. Ed25519's
//   clamping is X25519's, and B is the Edwards image of u = 9 (RFC 7748 §4.1), so X25519(a, 9) is a·B's Montgomery u,
//   and its Edwards y is (u - 1)/(u + 1). That leaves x's sign bit: of the two encodings, the public key is the one
//   that verifies a signature the imported key makes. Only public values (u, y) ever become numbers here; the seed,
//   the hash and the scalar stay in byte arrays that are zeroed.

import { asKey } from "../../fleet/core/ed25519.mjs";
import { fail, subtle } from "./base.mjs";
import { checkKemPublic } from "./x25519.mjs";

const X = { name: "X25519" };
const ED = { name: "Ed25519" };
const X_PKCS8 = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20);
const ED_PKCS8 = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);
const BASE_U = (() => { const b = new Uint8Array(32); b[0] = 9; return b; })();
const P = (1n << 255n) - 19n;
const PROBE = new TextEncoder().encode("sagebrush.e2e.public-key-probe.v1");

function der(prefix, secret) {
  const d = new Uint8Array(prefix.length + 32);
  d.set(prefix);
  d.set(secret, prefix.length);
  return d;
}
const check32 = (b) => { if (!(b instanceof Uint8Array) || b.length !== 32) fail("bad_form", "a seed is 32 bytes"); };

/** X25519(private, 9): the public u-coordinate, through the non-extractable private key. */
async function baseMult(privateKey) {
  const base = await subtle().importKey("raw", BASE_U, X, true, []);
  return new Uint8Array(await subtle().deriveBits({ name: "X25519", public: base }, privateKey, 256));
}

/** An X25519 key pair from 32 secret bytes: { publicRaw, privateKey }, the private key non-extractable. */
export async function kemFromSeed(seed) {
  check32(seed);
  const d = der(X_PKCS8, seed);
  try {
    const privateKey = await subtle().importKey("pkcs8", d, X, false, ["deriveBits"]);
    return Object.freeze({ publicRaw: checkKemPublic(await baseMult(privateKey)), privateKey });
  } finally {
    d.fill(0);
  }
}

const le = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const bytesLe = (n) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) { b[i] = Number(n & 255n); n >>= 8n; } return b; };
function pow(b, e) { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }

/** An Ed25519 signing key from a 32-byte seed, in the fleet core's key shape ({ raw, key, sign }); non-extractable. */
export async function ed25519FromSeed(seed) {
  check32(seed);
  const d = der(ED_PKCS8, seed);
  const h = new Uint8Array(await subtle().digest("SHA-512", seed));
  const xd = der(X_PKCS8, h.subarray(0, 32));
  let key, u;
  try {
    key = await subtle().importKey("pkcs8", d, ED, false, ["sign"]);
    u = await baseMult(await subtle().importKey("pkcs8", xd, X, false, ["deriveBits"]));
  } finally {
    d.fill(0);
    h.fill(0);
    xd.fill(0);
  }
  // (public values from here on: u is a·B's Montgomery coordinate, y its Edwards one)
  const un = le(u);
  const y = ((un - 1n + P) % P) * pow(un + 1n, P - 2n) % P;
  const sig = new Uint8Array(await subtle().sign(ED, key, PROBE));
  for (const signBit of [0, 1]) {
    const raw = bytesLe(y);
    raw[31] |= signBit << 7;
    try {
      const pub = await subtle().importKey("raw", raw, ED, true, ["verify"]);
      if (await subtle().verify(ED, pub, sig, PROBE)) return asKey(raw, async (msg) => new Uint8Array(await subtle().sign(ED, key, msg)));
    } catch { /* (not a valid encoding: the other one is) */ }
  }
  fail("bad_key", "no public key for this seed");
}
