// The WebCrypto backend (crypto.mjs's interface) for browsers, Workers and the app's web view; it also runs on Node's
// globalThis.crypto, which is how CI checks it against the fixtures. Ed25519 verify here is the platform's own, so the
// strict rules in ed25519.mjs run before it, as for every backend.

import { concat, unb64 } from "./bytes.mjs";

const ED = { name: "Ed25519" };
// (an Ed25519 private key from its 32-byte seed: the RFC 8410 PKCS#8 prefix, then the seed)
const PKCS8 = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);
const X = { name: "X25519" };
// (the same for an X25519 private key: OID 1.3.101.110)
const PKCS8_X = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20);
const GCM = (iv, additionalData) => ({ name: "AES-GCM", iv, additionalData, tagLength: 128 });

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
  return Object.freeze({
    sha256: async (bytes) => new Uint8Array(await subtle.digest("SHA-256", bytes)),
    async ed25519Verify(raw, msg, sig) {
      try {
        const key = await subtle.importKey("raw", raw, ED, false, ["verify"]);
        return (await subtle.verify(ED, key, sig, msg)) === true;
      } catch { return false; }
    },
    async ed25519FromSeed(seed) {
      const der = concat(PKCS8, seed);
      try {
        // (the public half, read from a throwaway extractable copy; the key that signs isn't extractable)
        const raw = unb64((await subtle.exportKey("jwk", await subtle.importKey("pkcs8", der, ED, true, ["sign"]))).x, 32);
        const key = await subtle.importKey("pkcs8", der, ED, false, ["sign"]);
        return { raw, sign: async (msg) => new Uint8Array(await subtle.sign(ED, key, msg)) };
      } finally {
        der.fill(0); // (this copy of the seed, whether or not the imports worked; the caller's seed is the caller's)
      }
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
      try {
        // (the public half from a throwaway extractable copy, as for Ed25519; the key that derives isn't extractable)
        const raw = unb64((await subtle.exportKey("jwk", await subtle.importKey("pkcs8", der, X, true, ["deriveBits"]))).x, 32);
        return xPair(raw, await subtle.importKey("pkcs8", der, X, false, ["deriveBits"]));
      } finally {
        der.fill(0);
      }
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
