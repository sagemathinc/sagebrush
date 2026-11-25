// The browser floor (design: e2e-encryption.md §3): end-to-end encryption needs WebCrypto's X25519 and Ed25519 with
// private keys that aren't extractable (an export is attempted, and must be refused), and HKDF, HMAC and AES-GCM. The
// real gate is this runtime test, not a version list: each primitive is used against its standard's known answer
// (RFC 7748, RFC 8032, RFC 5869, RFC 4231, the GCM specification), and AES-GCM must refuse a changed AAD. A browser that fails any probe can't
// sync securely, and is told so; nothing falls back to a weaker scheme or a JavaScript implementation.
export const FLOOR_MESSAGE = "This browser can't sync securely; update it or use the desktop app.";

export type Floor = Readonly<{ ok: true }> | Readonly<{ ok: false; missing: readonly string[]; message: string }>;

const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// (RFC 7748 §6.1: Alice's private key, Bob's public key, their shared secret; PKCS#8 for an X25519 private key)
const X_PKCS8 = "302e020100300506032b656e04220420";
const X_ALICE = "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a";
const X_BOB = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
const X_SHARED = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";
// (RFC 4231 test case 2: HMAC-SHA256)
const HMAC_KEY = "4a656665", HMAC_DATA = "7768617420646f2079612077616e7420666f72206e6f7468696e673f";
const HMAC_OUT = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
// (the GCM specification's test case 16: AES-256, a 12-byte IV, AAD)
const GCM_KEY = "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308", GCM_IV = "cafebabefacedbaddecaf888";
const GCM_AAD = "feedfacedeadbeeffeedfacedeadbeefabaddad2";
const GCM_PT = "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39";
const GCM_CT = "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662" + "76fc6ece0f4e1768cddf8853bb2d551b";
// (RFC 8032 §7.1 test 1: the empty message's signature under its public key)
const ED_PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const ED_SIG = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
// (RFC 5869 A.1: HKDF-SHA256)
const HKDF_IKM = "0b".repeat(22), HKDF_SALT = "000102030405060708090a0b0c", HKDF_INFO = "f0f1f2f3f4f5f6f7f8f9";
const HKDF_OKM = "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865";

// (a private key that isn't extractable must refuse to be exported: tried, not only read from the flag)
async function refusesExport(s: SubtleCrypto, key: CryptoKey): Promise<boolean> {
  if (key.extractable) return false;
  try { await s.exportKey("pkcs8", key); return false; } catch { return true; }
}

async function probes(c: Crypto): Promise<Record<string, () => Promise<boolean>>> {
  const s = c.subtle;
  return {
    async x25519() {
      const gen = () => s.generateKey({ name: "X25519" }, false, ["deriveBits"]) as Promise<CryptoKeyPair>;
      const a = await gen(), b = await gen();
      if (!(await refusesExport(s, a.privateKey))) return false;
      const raw = new Uint8Array(await s.exportKey("raw", b.publicKey));
      const bPub = await s.importKey("raw", raw, { name: "X25519" }, true, []);
      const ab = new Uint8Array(await s.deriveBits({ name: "X25519", public: bPub }, a.privateKey, 256));
      const ba = new Uint8Array(await s.deriveBits({ name: "X25519", public: a.publicKey }, b.privateKey, 256));
      // (RFC 7748's known answer, with a private key imported as one that isn't extractable)
      const alice = await s.importKey("pkcs8", unhex(X_PKCS8 + X_ALICE), { name: "X25519" }, false, ["deriveBits"]);
      const bob = await s.importKey("raw", unhex(X_BOB), { name: "X25519" }, true, []);
      const known = new Uint8Array(await s.deriveBits({ name: "X25519", public: bob }, alice, 256));
      return raw.length === 32 && ab.length === 32 && same(ab, ba) && same(known, unhex(X_SHARED)) && (await refusesExport(s, alice));
    },
    async ed25519() {
      const k = (await s.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
      if (!(await refusesExport(s, k.privateKey))) return false;
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
      const k = await s.importKey("raw", unhex(HMAC_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return same(new Uint8Array(await s.sign("HMAC", k, unhex(HMAC_DATA))), unhex(HMAC_OUT));
    },
    async aesGcm() {
      const k = await s.importKey("raw", unhex(GCM_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
      const p = { name: "AES-GCM", iv: unhex(GCM_IV), additionalData: unhex(GCM_AAD), tagLength: 128 };
      const ct = new Uint8Array(await s.encrypt(p, k, unhex(GCM_PT)));
      let refused = false;
      try { await s.decrypt({ ...p, additionalData: unhex(GCM_AAD + "00") }, k, ct); } catch { refused = true; }
      return same(ct, unhex(GCM_CT)) && same(new Uint8Array(await s.decrypt(p, k, ct)), unhex(GCM_PT)) && refused;
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
