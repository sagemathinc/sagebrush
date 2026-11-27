// The WebCrypto backend (crypto.mjs's interface) for browsers, Workers and the app's web view; it also runs on Node's
// globalThis.crypto, which is how CI checks it against the fixtures. Ed25519 verify here is the platform's own, so the
// strict rules in ed25519.mjs run before it, as for every backend.
//
// No private key is ever exported, in any format. The public half of a key made from secret bytes is derived through
// the non-extractable private key alone:
// - X25519: the public key is X25519(k, 9), deriveBits of the private key against the base point u = 9.
// - Ed25519: the private scalar a is the clamped first half of SHA-512(seed), and the public key is a·B. Ed25519's
//   clamping is X25519's, and B is the Edwards image of u = 9 (RFC 7748 §4.1), so X25519(a, 9) is a·B's Montgomery u,
//   and its Edwards y is (u - 1)/(u + 1) mod p. That leaves x's sign bit: of the two encodings, the public key is the
//   one that verifies a probe signature the imported key makes. Only public values (u, y) ever become numbers; the
//   seed, the hash and the scalar stay in byte arrays that are zeroed in a finally.

import { concat, enc } from "./bytes.mjs";

const ED = { name: "Ed25519" };
// (an Ed25519 private key from its 32-byte seed: the RFC 8410 PKCS#8 prefix, then the seed)
const PKCS8 = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);
const X = { name: "X25519" };
// (the same for an X25519 private key: OID 1.3.101.110)
const PKCS8_X = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20);
const GCM = (iv, additionalData) => ({ name: "AES-GCM", iv, additionalData, tagLength: 128 });
const BASE_U = (() => { const b = new Uint8Array(32); b[0] = 9; return b; })();
const P = (1n << 255n) - 19n;
const PROBES = [enc("sagebrush.fleet.public-key-probe.v1"), enc("sagebrush.fleet.public-key-probe.v2")];
const le = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const bytesLe = (n) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) { b[i] = Number(n & 255n); n >>= 8n; } return b; };
/** b^e mod p. @param {bigint} b @param {bigint} e @returns {bigint} */
function pow(b, e) { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
/** The Edwards y (mod p) of the point whose Montgomery u is `u` (32 bytes, little-endian): (u - 1)/(u + 1). */
const edwardsY = (u) => { const n = le(u) % P; return ((n - 1n + P) % P) * pow(n + 1n, P - 2n) % P; };

/** The backend over a WebCrypto object (globalThis.crypto by default). */
export function webCrypto(c = globalThis.crypto) {
  const subtle = c?.subtle;
  if (!subtle || typeof c.getRandomValues !== "function") throw new Error("no WebCrypto here");
  // (an X25519 pair: dh is null where WebCrypto refuses, an all-zero result included; the core checks that too)
  const xPair = (raw, priv) => ({
    raw,
    async dh(peer) {
      try {
        const pub = await subtle.importKey("raw", peer, X, true, []);
        return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pub }, priv, 256));
      } catch { return null; }
    },
  });
  /** X25519(private, 9): the public u-coordinate, through the non-extractable private key. */
  const baseMult = async (priv) => {
    const base = await subtle.importKey("raw", BASE_U, X, true, []);
    return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: base }, priv, 256));
  };
  return Object.freeze({
    sha256: async (bytes) => new Uint8Array(await subtle.digest("SHA-256", bytes)),
    async ed25519Verify(raw, msg, sig) {
      try {
        const key = await subtle.importKey("raw", raw, ED, false, ["verify"]);
        return (await subtle.verify(ED, key, sig, msg)) === true;
      } catch { return false; }
    },
    async ed25519FromSeed(seed) {
      // (copies of the seed and of its hash, each zeroed whether or not the imports worked; the caller's seed is the
      //  caller's)
      const der = concat(PKCS8, seed);
      let h = null, xder = null, key, u;
      try {
        key = await subtle.importKey("pkcs8", der, ED, false, ["sign"]);
        // (the scalar's copy is made only once the signing key imported, and goes straight to its own import)
        h = new Uint8Array(await subtle.digest("SHA-512", seed));
        xder = concat(PKCS8_X, h.subarray(0, 32));
        u = await baseMult(await subtle.importKey("pkcs8", xder, X, false, ["deriveBits"]));
      } finally {
        der.fill(0);
        h?.fill(0);
        xder?.fill(0);
      }
      const sign = async (msg) => new Uint8Array(await subtle.sign(ED, key, msg));
      // (public values from here on: y, then the one sign of x whose encoding verifies the key's own signature. Both
      //  could verify one signature by a ~2^-252 chance (their challenges summing to 0 mod L): the key is the one
      //  encoding that verifies ALONE, and a second probe decides in that case)
      const y = edwardsY(u);
      const encodings = [0, 1].map((signBit) => { const raw = bytesLe(y); raw[31] |= signBit << 7; return raw; });
      const verifies = async (raw, msg, sig) => {
        try { return (await subtle.verify(ED, await subtle.importKey("raw", raw, ED, true, ["verify"]), sig, msg)) === true; } catch { return false; }
      };
      for (const msg of PROBES) {
        const sig = await sign(msg);
        const ok = [];
        for (const raw of encodings) if (await verifies(raw, msg, sig)) ok.push(raw);
        if (ok.length === 1) return { raw: ok[0], sign };
        if (ok.length === 0) break;
      }
      throw new Error("no public key for this seed");
    },
    async hkdf(ikm, salt, info, length) {
      const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
      return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
    },
    random(n) {
      const b = new Uint8Array(n);
      c.getRandomValues(b);
      return b;
    },
    async hmacSha256(key, data) {
      const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return new Uint8Array(await subtle.sign("HMAC", k, data));
    },
    async x25519Generate() {
      const pair = /** @type {CryptoKeyPair} */ (await subtle.generateKey(X, false, ["deriveBits"]));
      return xPair(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)), pair.privateKey);
    },
    async x25519FromPrivate(sk) {
      const der = concat(PKCS8_X, sk);
      let priv;
      try {
        priv = await subtle.importKey("pkcs8", der, X, false, ["deriveBits"]);
      } finally {
        der.fill(0);
      }
      // (the public half: X25519(k, 9), through the non-extractable key)
      return xPair(await baseMult(priv), priv);
    },
    aes256gcmSeal: async (key, nonce, aad, pt) =>
      new Uint8Array(await subtle.encrypt(GCM(nonce, aad), await subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]), pt)),
    async aes256gcmOpen(key, nonce, aad, ct) {
      try {
        return new Uint8Array(await subtle.decrypt(GCM(nonce, aad), await subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]), ct));
      } catch { return null; }
    },
  });
}
