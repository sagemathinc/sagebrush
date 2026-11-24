// TEST DOUBLE, not HPKE. PR 2's tests need the four calls PR 1's hpke object makes (seal, open, sendExport,
// receiveExport) before PR 1 lands, and the fleet core has no HPKE Export yet. This double has the same shapes and the
// same failure behaviour (open throws on any mismatch), built from X25519 + HKDF-SHA256 + AES-256-GCM, so the key
// chain's own logic (contexts, signatures, replay, proofs of possession) is what these tests exercise. Interop with
// RFC 9180 is PR 1's test, against the CFRG vectors. Nothing outside tests imports this file.

const s = () => globalThis.crypto.subtle;
const X = { name: "X25519" };
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, b) => n + b.length, 0)); let i = 0; for (const b of p) { o.set(b, i); i += b.length; } return o; };
const te = (t) => new TextEncoder().encode(t);

async function dh(privateKey, publicRaw) {
  const pub = await s().importKey("raw", publicRaw, X, true, []);
  return new Uint8Array(await s().deriveBits({ name: "X25519", public: pub }, privateKey, 256));
}
async function kdf(secret, salt, info, n) {
  const k = await s().importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await s().deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, n * 8));
}
async function ephemeral(pkR) {
  const e = await s().generateKey(X, true, ["deriveBits"]);
  const enc = new Uint8Array(await s().exportKey("raw", e.publicKey));
  return { enc, ss: await dh(e.privateKey, pkR) };
}
const aes = async (raw, usage) => s().importKey("raw", raw, { name: "AES-GCM" }, false, [usage]);
const ZERO = new Uint8Array(12);

export const hpkeDouble = Object.freeze({
  async seal(pkR, info, aad, pt) {
    const { enc, ss } = await ephemeral(pkR);
    const key = await kdf(ss, cat(enc, pkR), cat(te("double.seal\n"), info), 32);
    return { enc, ct: new Uint8Array(await s().encrypt({ name: "AES-GCM", iv: ZERO, additionalData: aad }, await aes(key, "encrypt"), pt)) };
  },
  async open(recipient, enc, info, aad, ct) {
    const ss = await dh(recipient.privateKey, enc);
    const key = await kdf(ss, cat(enc, recipient.publicRaw), cat(te("double.seal\n"), info), 32);
    return new Uint8Array(await s().decrypt({ name: "AES-GCM", iv: ZERO, additionalData: aad }, await aes(key, "decrypt"), ct));
  },
  async sendExport(pkR, info, context, n) {
    const { enc, ss } = await ephemeral(pkR);
    return { enc, secret: await kdf(ss, cat(enc, pkR), cat(te("double.export\n"), info, te("\n"), context), n) };
  },
  async receiveExport(recipient, enc, info, context, n) {
    const ss = await dh(recipient.privateKey, enc);
    return kdf(ss, cat(enc, recipient.publicRaw), cat(te("double.export\n"), info, te("\n"), context), n);
  },
});
