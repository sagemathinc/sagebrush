// The browser floor (design: e2e-encryption.md §3): end-to-end encryption needs WebCrypto's X25519 and Ed25519 with
// private keys that aren't extractable, and HKDF, HMAC and AES-GCM. The real gate is this runtime test, not a version
// list: each primitive is used once, against a known answer where there is one. A browser that fails any probe can't
// sync securely, and is told so; nothing falls back to a weaker scheme or a JavaScript implementation.
export const FLOOR_MESSAGE = "This browser can't sync securely; update it or use the desktop app.";

export type Floor = Readonly<{ ok: true }> | Readonly<{ ok: false; missing: readonly string[]; message: string }>;

const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// (RFC 8032 §7.1 test 1: the empty message's signature under its public key)
const ED_PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const ED_SIG = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
// (RFC 5869 A.1: HKDF-SHA256)
const HKDF_IKM = "0b".repeat(22), HKDF_SALT = "000102030405060708090a0b0c", HKDF_INFO = "f0f1f2f3f4f5f6f7f8f9";
const HKDF_OKM = "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865";

async function probes(c: Crypto): Promise<Record<string, () => Promise<boolean>>> {
  const s = c.subtle;
  return {
    async x25519() {
      const gen = () => s.generateKey({ name: "X25519" }, false, ["deriveBits"]) as Promise<CryptoKeyPair>;
      const a = await gen(), b = await gen();
      if (a.privateKey.extractable) return false;
      const raw = new Uint8Array(await s.exportKey("raw", b.publicKey));
      const bPub = await s.importKey("raw", raw, { name: "X25519" }, true, []);
      const ab = new Uint8Array(await s.deriveBits({ name: "X25519", public: bPub }, a.privateKey, 256));
      const ba = new Uint8Array(await s.deriveBits({ name: "X25519", public: a.publicKey }, b.privateKey, 256));
      let exported = true;
      try { await s.exportKey("pkcs8", a.privateKey); } catch { exported = false; }
      return raw.length === 32 && ab.length === 32 && same(ab, ba) && !exported;
    },
    async ed25519() {
      const k = (await s.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
      if (k.privateKey.extractable) return false;
      const m = new Uint8Array([1, 2, 3]);
      const sig = new Uint8Array(await s.sign({ name: "Ed25519" }, k.privateKey, m));
      const pub = await s.importKey("raw", unhex(ED_PUBLIC), { name: "Ed25519" }, true, ["verify"]);
      return sig.length === 64 && (await s.verify({ name: "Ed25519" }, k.publicKey, sig, m))
        && (await s.verify({ name: "Ed25519" }, pub, unhex(ED_SIG), new Uint8Array(0)));
    },
    async hkdf() {
      const k = await s.importKey("raw", unhex(HKDF_IKM), "HKDF", false, ["deriveBits"]);
      const okm = new Uint8Array(await s.deriveBits({ name: "HKDF", hash: "SHA-256", salt: unhex(HKDF_SALT), info: unhex(HKDF_INFO) }, k, 42 * 8));
      return same(okm, unhex(HKDF_OKM));
    },
    async hmac() {
      const k = await s.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return (await s.sign("HMAC", k, new Uint8Array(1))).byteLength === 32;
    },
    async aesGcm() {
      const k = await s.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["encrypt", "decrypt"]);
      const p = { name: "AES-GCM", iv: new Uint8Array(12), additionalData: new Uint8Array([7]), tagLength: 128 };
      const ct = new Uint8Array(await s.encrypt(p, k, new Uint8Array(5)));
      let refused = false;
      try { await s.decrypt({ ...p, additionalData: new Uint8Array([8]) }, k, ct); } catch { refused = true; }
      return ct.length === 21 && same(new Uint8Array(await s.decrypt(p, k, ct)), new Uint8Array(5)) && refused;
    },
  };
}

/** Whether this browser can sync securely: every probe passes, or the ones that didn't and what to tell the person. */
export async function checkFloor(c: Crypto | undefined = globalThis.crypto): Promise<Floor> {
  if (!c?.subtle || typeof c.getRandomValues !== "function") return Object.freeze({ ok: false, missing: Object.freeze(["webcrypto"]), message: FLOOR_MESSAGE });
  const missing: string[] = [];
  for (const [name, probe] of Object.entries(await probes(c))) {
    let ok = false;
    try { ok = await probe(); } catch { ok = false; }
    if (!ok) missing.push(name);
  }
  return missing.length === 0 ? Object.freeze({ ok: true }) : Object.freeze({ ok: false, missing: Object.freeze(missing), message: FLOOR_MESSAGE });
}
