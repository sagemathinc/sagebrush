// HPKE (RFC 9180) in base mode with one suite, the one r2.3 §7 fixes: DHKEM(X25519, HKDF-SHA256) (0x0020),
// HKDF-SHA256 (0x0001) and AES-256-GCM (0x0002). Pure: the X25519, HMAC and AES-GCM steps go through the installed
// backend (crypto.mjs); the labels, the key schedule and every check are here, so both backends run the same scheme.
// Checked against the CFRG known-answer vector for exactly this suite (test/fixtures/hpke-x25519-sha256-aes256gcm.json).

import { concat, enc, refuse } from "./bytes.mjs";
import { crypto } from "./crypto.mjs";

const KEM = Uint8Array.of(0x4b, 0x45, 0x4d, 0x00, 0x20); // "KEM" || I2OSP(0x0020, 2)
const SUITE = Uint8Array.of(0x48, 0x50, 0x4b, 0x45, 0x00, 0x20, 0x00, 0x01, 0x00, 0x02); // "HPKE" || kem || kdf || aead
const V1 = enc("HPKE-v1");
const NH = 32, NK = 32, NN = 12, NT = 16;
export const HPKE = Object.freeze({ kem: 0x0020, kdf: 0x0001, aead: 0x0002, nenc: 32, ntag: NT });

const i2osp2 = (n) => Uint8Array.of(n >>> 8, n & 255);

async function extract(salt, ikm) {
  return checked(await crypto().hmacSha256(salt.length ? salt : new Uint8Array(NH), ikm), NH, "hmacSha256");
}

async function expand(prk, info, length) {
  const out = new Uint8Array(length);
  /** @type {Uint8Array} */
  let t = new Uint8Array(0);
  for (let i = 1, at = 0; at < length; i++) {
    t = checked(await crypto().hmacSha256(prk, concat(t, info, Uint8Array.of(i))), NH, "hmacSha256");
    out.set(t.subarray(0, Math.min(NH, length - at)), at);
    at += NH;
  }
  return out;
}

const labeledExtract = (suite, salt, label, ikm) => extract(salt, concat(V1, suite, enc(label), ikm));
const labeledExpand = (suite, prk, label, info, length) => expand(prk, concat(i2osp2(length), V1, suite, enc(label), info), length);

function checked(b, n, what) {
  if (!(b instanceof Uint8Array) || b.length !== n) throw new Error(`the crypto backend's ${what}() gave the wrong bytes`);
  return b;
}

// ---- DHKEM(X25519, HKDF-SHA256), RFC 9180 §4.1

async function dh(pair, peer) {
  const z = await pair.dh(peer);
  // (an all-zero shared secret means a small-order peer key: refused here whatever the backend did, §7.1.4)
  if (!(z instanceof Uint8Array) || z.length !== 32 || z.every((x) => x === 0)) refuse("bad_form", "an X25519 key that gives no shared secret");
  return z;
}

async function sharedSecret(z, encapsulated, pkR) {
  const prk = await labeledExtract(KEM, new Uint8Array(0), "eae_prk", z);
  return labeledExpand(KEM, prk, "shared_secret", concat(encapsulated, pkR), 32);
}

/** RFC 9180 §7.1.3 DeriveKeyPair for X25519: the private key from input keying material (the vectors use it). */
export async function deriveKeyPair(ikm) {
  const prk = await labeledExtract(KEM, new Uint8Array(0), "dkp_prk", ikm);
  const sk = await labeledExpand(KEM, prk, "sk", new Uint8Array(0), 32);
  try { return await crypto().x25519FromPrivate(sk); } finally { sk.fill(0); }
}

// ---- the key schedule, base mode (§5.1)

async function keySchedule(shared, info) {
  const pskIdHash = await labeledExtract(SUITE, new Uint8Array(0), "psk_id_hash", new Uint8Array(0));
  const infoHash = await labeledExtract(SUITE, new Uint8Array(0), "info_hash", info);
  const context = concat(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = await labeledExtract(SUITE, shared, "secret", new Uint8Array(0));
  try {
    return {
      key: await labeledExpand(SUITE, secret, "key", context, NK),
      baseNonce: await labeledExpand(SUITE, secret, "base_nonce", context, NN),
    };
  } finally {
    secret.fill(0);
  }
}

function nonceAt(base, seq) {
  const n = Uint8Array.from(base);
  for (let i = 0, s = seq; i < 8 && s > 0; i++, s = Math.floor(s / 256)) n[NN - 1 - i] ^= s & 255;
  return n;
}

/**
 * A sender's context (RFC 9180 §5.1.1, base mode) to `pkR` (32 raw bytes). `ephemeral` is for the vectors only: a pair
 * from deriveKeyPair; otherwise a fresh one is generated. Returns { enc, seal(aad, pt) }: a sender never opens.
 */
export const setupSender = (pkR, info, ephemeral = null) => sender(pkR, info, ephemeral, 0);

/**
 * @typedef {Readonly<{ enc: Uint8Array, seal(aad: Uint8Array, pt: Uint8Array): Promise<Uint8Array> }>} SenderContext
 * @typedef {Readonly<{ open(aad: Uint8Array, ct: Uint8Array): Promise<Uint8Array> }>} RecipientContext
 */

/** @returns {Promise<SenderContext>} */
async function sender(pkR, info, ephemeral, start) {
  if (pkR?.length !== 32) refuse("bad_form", "an X25519 key is 32 bytes");
  const e = ephemeral ?? (await crypto().x25519Generate());
  const z = await dh(e, pkR);
  const ks = await keySchedule(await sharedSecret(z, e.raw, pkR), info);
  z.fill(0);
  return /** @type {SenderContext} */ (context(e.raw, ks, "sender", start));
}

/** A recipient's context: `own` is its pair (x25519FromPrivate); `encapsulated` is the sender's 32-byte enc. */
export const setupRecipient = (own, encapsulated, info) => recipient(own, encapsulated, info, 0);

/** @returns {Promise<RecipientContext>} */
async function recipient(own, encapsulated, info, start) {
  if (encapsulated?.length !== 32) refuse("bad_form", "enc is 32 bytes");
  const z = await dh(own, encapsulated);
  const ks = await keySchedule(await sharedSecret(z, encapsulated, own.raw), info);
  z.fill(0);
  return /** @type {RecipientContext} */ (context(encapsulated, ks, "recipient", start));
}

/** For the counter's boundary test only (not in the package's index): contexts whose sequence starts at `start`. */
export const atSequence = Object.freeze({
  sender: (start, pkR, info, ephemeral = null) => sender(pkR, info, ephemeral, start),
  recipient: (start, own, encapsulated, info) => recipient(own, encapsulated, info, start),
});

// A context has one role (RFC 9180 §5.2): a sender's seals, a recipient's opens; the other operation doesn't exist on it.
// One operation in flight per context (ruled): a seal or open that starts while another is pending is refused at once
// (in_progress), before it reads the sequence, so two calls can never share a nonce under one key. The check and the
// claim run before the first await, so nothing can interleave between them. The sequence advances only after a
// successful seal or open (RFC 9180 §5.2), so a refused ciphertext leaves the next one's nonce where it was, and it is
// an exact counter, refused (limit) once it reaches Number.MAX_SAFE_INTEGER rather than repeating a nonce. Sealed
// packages and capability mints use one context per message (seal() and open() below), so they never overlap.
const SEQ_MAX = Number.MAX_SAFE_INTEGER;

function context(encapsulated, ks, role, start) {
  let seq = start, busy = false;
  const claim = () => {
    if (busy) refuse("in_progress", "another operation of this context is pending");
    if (seq >= SEQ_MAX) refuse("limit", "this context's sequence is used up");
    busy = true;
  };
  if (role === "sender") {
    return Object.freeze({
      enc: encapsulated,
      async seal(aad, pt) {
        claim();
        try {
          const ct = checked(await crypto().aes256gcmSeal(ks.key, nonceAt(ks.baseNonce, seq), aad, pt), pt.length + NT, "aes256gcmSeal");
          seq++;
          return ct;
        } finally {
          busy = false;
        }
      },
    });
  }
  return Object.freeze({
    async open(aad, ct) {
      claim();
      try {
        if (ct.length < NT) refuse("bad_form", "a ciphertext shorter than its tag");
        const pt = await crypto().aes256gcmOpen(ks.key, nonceAt(ks.baseNonce, seq), aad, ct);
        if (pt === null) refuse("bad_form", "the ciphertext doesn't open under this key and header");
        checked(pt, ct.length - NT, "aes256gcmOpen");
        seq++;
        return pt;
      } finally {
        busy = false;
      }
    },
  });
}

/** One message, single-shot (§6.1): { enc, ct }. */
export async function seal(pkR, info, aad, pt, ephemeral = null) {
  const s = await setupSender(pkR, info, ephemeral);
  return { enc: s.enc, ct: await s.seal(aad, pt) };
}

/** Open one single-shot message. */
export async function open(own, encapsulated, info, aad, ct) {
  return (await setupRecipient(own, encapsulated, info)).open(aad, ct);
}
