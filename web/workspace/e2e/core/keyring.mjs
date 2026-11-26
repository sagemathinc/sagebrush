// Epoch secrets (§2, §11.2). Each epoch n has a random 32-byte secret S[n]. Its chain entry carries:
// - a commitment to S[n], so a device that receives S[n] (from a wrapper, or out of a keyring) can check it is the
//   secret the signed chain names, whoever delivered it;
// - from epoch 1 on, the hash of its keyring.
//
// Keyrings are chained: epoch n's keyring carries one secret, S[n-1], so every keyring is 60 bytes whatever n is, and
// nothing grows with the number of epochs (no epoch cap). A device reaches an older epoch by walking back, one keyring
// at a time (walkBack). Each keyring is AES-256-GCM under K_ring[n] = HKDF(S[n], "sagebrush.keyring.v1"), used for this
// one keyring, with a fresh 96-bit nonce, and its AAD binds the account, the generation, n, the suite, the predecessor
// chain entry's hash and the hash of keyring n-1's whole ciphertext (prev_ring; "" for epoch 1). So a walk that starts
// from a signed hash takes every next expected hash from an authenticated keyring, and crosses a reset (a new
// generation's first keyring names the old generation's last one).
//
// The server keeps every keyring, as a row { epoch, generation, suite, prev, prev_ring, bytes }.

import { b64, random, sha256b64 } from "../../fleet/core/bytes.mjs";
import { crypto } from "../../fleet/core/crypto.mjs";
import { LABELS, SALT, aadOf, exactKeys, fail, info, knownSuite, subtle } from "./base.mjs";

const FORMAT = 2;
const RING_BYTES = 12 + 32 + 16;
const HASH = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** A new epoch secret: 32 bytes from the CSPRNG. */
export const newEpochSecret = () => random(32);

/** The commitment to S[n] that its chain entry carries (base64url, 32 bytes). Reveals nothing about S[n]. */
export async function epochCommit(S, account, n) {
  if (!(S instanceof Uint8Array) || S.length !== 32) fail("bad_form", "an epoch secret is 32 bytes");
  const c = await crypto().hkdf(S, SALT, info(LABELS.epochCommit, account, n), 32);
  try {
    return b64(c);
  } finally {
    c.fill(0);
  }
}

/** A keyring row's metadata, exactly: what its AAD binds besides the account. */
export function checkRingMeta(m) {
  if (!exactKeys(m, ["epoch", "generation", "suite", "prev", "prev_ring"]) || !Number.isSafeInteger(m.epoch) || m.epoch < 1 || typeof m.generation !== "string" || m.generation === ""
    || !knownSuite(m.suite) || typeof m.prev !== "string" || !(m.prev_ring === "" ? m.epoch === 1 : HASH.test(m.prev_ring)))
    fail("bad_keyring", "a bad keyring row");
  return m;
}

const ringAad = (account, m) =>
  aadOf(LABELS.keyring, { v: FORMAT, account, generation: m.generation, epoch: m.epoch, suite: m.suite, prev: m.prev, prev_ring: m.prev_ring });

async function ringKey(S, account, n, usage) {
  const raw = await crypto().hkdf(S, SALT, info(LABELS.keyring, account, n), 32);
  try {
    return await subtle().importKey("raw", raw, { name: "AES-GCM" }, false, [usage]);
  } finally {
    raw.fill(0);
  }
}

/**
 * Seal epoch n's keyring: S is S[n], `secret` is S[n-1], `meta` is { epoch: n, generation, suite, prev, prev_ring }.
 * Returns { bytes, hash, meta } (the hash goes in the signed chain entry; the row is meta and bytes).
 */
export async function sealKeyring({ S, account, meta, secret }) {
  checkRingMeta(meta);
  if (!(secret instanceof Uint8Array) || secret.length !== 32) fail("bad_form", "an epoch secret is 32 bytes");
  const nonce = random(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: ringAad(account, meta) }, await ringKey(S, account, meta.epoch, "encrypt"), secret));
  const bytes = new Uint8Array(12 + ct.length);
  bytes.set(nonce);
  bytes.set(ct, 12);
  return Object.freeze({ bytes, hash: await sha256b64(bytes), meta: Object.freeze({ ...meta }) });
}

/**
 * Open one keyring row with S[n]. The row's ciphertext must hash to `expect` before anything is decrypted, and its
 * metadata is authenticated by the AAD. Returns { secret: S[n-1], prevRing } (prevRing: the next expected hash).
 */
export async function openKeyring({ S, account, row, expect }) {
  if (!row || typeof row !== "object") fail("bad_keyring", "no keyring row");
  const { bytes, ...meta } = row;
  checkRingMeta(meta);
  if (!(bytes instanceof Uint8Array) || bytes.length !== RING_BYTES || (await sha256b64(bytes)) !== expect) fail("bad_keyring", "not this epoch's keyring");
  let secret;
  try {
    secret = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: ringAad(account, meta) }, await ringKey(S, account, meta.epoch, "decrypt"), bytes.subarray(12)));
  } catch {
    fail("bad_keyring", "not this epoch's keyring");
  }
  if (secret.length !== 32) { secret.fill(0); fail("bad_keyring", "not this epoch's keyring"); }
  return { secret, prevRing: meta.prev_ring };
}

/**
 * Walk back from epoch `n` (secret S, keyring hash `expect`, taken from its signed chain entry) to epoch `to`.
 * - `row(k)`: keyring row k ({ epoch, generation, suite, prev, prev_ring, bytes }), from the server or a cache;
 * - `commit(k)`: epoch k's signed commitment while its entry is in the chain, else undefined;
 * - `keep(k, secret)`: stores each verified secret (a copy; the walk zeroes its own);
 * - `budget`: the most steps this call takes; `signal`: an AbortSignal.
 * Returns S[to] (the caller zeroes it). Every step checks the row's hash before decrypting, and takes the next
 * expected hash only from the keyring it just authenticated.
 */
export async function walkBack({ S, n, expect, to, account, row, commit = () => undefined, keep = async () => {}, budget = 4096, signal }) {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(to) || to < 0 || to > n) fail("bad_form", "a bad walk");
  if (n - to > budget) fail("limit", "the walk is past its budget");
  let cur = Uint8Array.from(S);
  let want = expect;
  try {
    for (let k = n; k > to; k--) {
      if (signal?.aborted) fail("aborted", "the walk was cancelled");
      const r = await row(k);
      if (!r || r.epoch !== k) fail("bad_keyring", "not this epoch's keyring");
      const { secret, prevRing } = await openKeyring({ S: cur, account, row: r, expect: want });
      cur.fill(0);
      cur = secret;
      const c = commit(k - 1);
      if (c !== undefined && (await epochCommit(cur, account, k - 1)) !== c) fail("bad_keyring", "a secret that isn't its epoch's");
      await keep(k - 1, Uint8Array.from(cur));
      want = prevRing;
    }
    const out = cur;
    cur = null;
    return out;
  } finally {
    cur?.fill(0);
  }
}
