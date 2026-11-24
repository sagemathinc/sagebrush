// Epoch secrets (§2, §11.2). Each epoch n has a random 32-byte secret S[n]. Its chain entry carries:
// - a commitment to S[n], so a device that receives S[n] (from a wrapper, or out of a keyring) can check it is the
//   secret the signed chain names, whoever delivered it;
// - from epoch 1 on, the hash of a keyring: the earlier epochs' secrets, encrypted under a key derived from S[n].
//
// The keyring's construction is §11.2's: K_ring[n] = HKDF(S[n], "sagebrush.keyring.v1"), used for this one keyring;
// AES-256-GCM with a fresh random 96-bit nonce; AAD binding the account, the epoch, the suite and format version, the
// predecessor chain entry's hash and the ordered list of included epochs; the signed entry commits the SHA-256 of the
// whole ciphertext (nonce, ciphertext and tag), and the decrypted list must equal the AAD's.

import { b64, enc, random, sha256b64, unb64 } from "../../fleet/core/bytes.mjs";
import { canonText, parseCanonical } from "../../fleet/core/canonical.mjs";
import { crypto } from "../../fleet/core/crypto.mjs";
import { LABELS, SALT, aadOf, exactKeys, fail, info, knownSuite, subtle } from "./base.mjs";

const FORMAT = 1;

/** A new epoch secret: 32 bytes from the CSPRNG. */
export const newEpochSecret = () => random(32);

/** The commitment to S[n] that its chain entry carries (base64url, 32 bytes). Reveals nothing about S[n]. */
export async function epochCommit(S, account, n) {
  if (!(S instanceof Uint8Array) || S.length !== 32) fail("bad_form", "an epoch secret is 32 bytes");
  return b64(await crypto().hkdf(S, SALT, info(LABELS.epochCommit, account, n), 32));
}

/** The keyring's AAD (§11.2). */
const ringAad = (account, n, suite, prev, epochs) =>
  aadOf(LABELS.keyring, { v: FORMAT, account, epoch: n, suite, prev, epochs });

async function ringKey(S, account, n, usage) {
  const raw = await crypto().hkdf(S, SALT, info(LABELS.keyring, account, n), 32);
  try {
    return await subtle().importKey("raw", raw, { name: "AES-GCM" }, false, [usage]);
  } finally {
    raw.fill(0);
  }
}

const checkList = (epochs, n) => {
  if (!Array.isArray(epochs) || epochs.some((e, i) => !Number.isSafeInteger(e) || e < 0 || e >= n || (i > 0 && e <= epochs[i - 1])))
    fail("bad_form", "a keyring's epochs are increasing and earlier than its own");
};

/**
 * Seal the keyring for new epoch n. `secrets` maps each earlier epoch it carries to its 32-byte secret; `prev` is the
 * predecessor chain entry's hash. Returns { bytes, hash, epochs } (hash and epochs go in the signed chain entry).
 */
export async function sealKeyring({ S, account, n, suite, prev, secrets }) {
  if (!knownSuite(suite)) fail("bad_suite", "an unknown suite");
  const epochs = [...secrets.keys()].sort((a, b) => a - b);
  checkList(epochs, n);
  const body = { epochs, secrets: epochs.map((e) => {
    const s = secrets.get(e);
    if (!(s instanceof Uint8Array) || s.length !== 32) fail("bad_form", "an epoch secret is 32 bytes");
    return b64(s);
  }) };
  const plain = enc(canonText(body));
  const nonce = random(12);
  try {
    const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: ringAad(account, n, suite, prev, epochs) },
      await ringKey(S, account, n, "encrypt"), plain));
    const bytes = new Uint8Array(12 + ct.length);
    bytes.set(nonce);
    bytes.set(ct, 12);
    return Object.freeze({ bytes, hash: await sha256b64(bytes), epochs: Object.freeze(epochs) });
  } finally {
    plain.fill(0);
  }
}

/**
 * Open epoch n's keyring: `hash` and `epochs` are what its signed chain entry says. The hash is checked before any
 * decryption; the decrypted list must equal the signed one. Returns a Map from epoch to its 32-byte secret.
 */
export async function openKeyring({ S, account, n, suite, prev, hash, epochs, bytes }) {
  checkList(epochs, n);
  if (!(bytes instanceof Uint8Array) || bytes.length < 12 + 16 || (await sha256b64(bytes)) !== hash) fail("bad_keyring", "not this epoch's keyring");
  let plain;
  try {
    plain = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: ringAad(account, n, suite, prev, epochs) },
      await ringKey(S, account, n, "decrypt"), bytes.subarray(12)));
  } catch {
    fail("bad_keyring", "not this epoch's keyring");
  }
  try {
    const body = parseCanonical(plain);
    if (!exactKeys(body, ["epochs", "secrets"]) || !Array.isArray(body.secrets) || canonText(body.epochs) !== canonText(epochs) || body.secrets.length !== epochs.length)
      fail("bad_keyring", "not this epoch's keyring");
    return new Map(epochs.map((e, i) => [e, unb64(body.secrets[i], 32)]));
  } finally {
    plain.fill(0);
  }
}
