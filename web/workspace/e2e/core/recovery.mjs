// The recovery code (§2): 32 random bytes from the platform's CSPRNG, shown once as 52 base32 characters in groups of
// four, and never stored by the service or a device. Two domain-separated derivations give the recovery Ed25519 key
// (which alone signs a recovery, §2.1) and the recovery X25519 key (which every epoch is wrapped to). Only their public
// halves go in the key chain.
//
// A wrong, truncated or mistyped code fails the same way as any other wrong code: `recovery_failed`, with no hint of
// which check failed (§2, SEC checklist). openRecovery (wrap.mjs) is the one boundary a recovery goes through.

import { enc, random } from "../../fleet/core/bytes.mjs";
import { crypto } from "../../fleet/core/crypto.mjs";
import { LABELS, fail } from "./base.mjs";
import { ed25519FromSeed, kemFromSeed } from "./seeded.mjs";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export const CODE_LENGTH = 52; // (256 bits in 5-bit characters: 51 full characters, then 1 bit and 4 zero bits)

/** A new recovery seed: 32 bytes from the CSPRNG. The caller shows it once (showCode) and then zeroes it. */
export const newRecoverySeed = () => random(32);

/** The code for a seed, as 52 lowercase base32 characters. */
export function codeOfSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) fail("bad_form", "a seed is 32 bytes");
  let bits = 0, acc = 0, out = "";
  for (const x of seed) {
    acc = (acc << 8) | x; bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  return out + B32[(acc << (5 - bits)) & 31];
}

/** The code as a person reads it: groups of four, separated by hyphens. */
export const showCode = (code) => code.match(/.{1,4}/g).join("-");

/** The seed a typed code stands for: spaces and hyphens dropped, case ignored; anything else fails uniformly. */
export function seedOfCode(typed) {
  const c = String(typed).replace(/[\s-]/g, "").toLowerCase();
  if (c.length !== CODE_LENGTH) fail("recovery_failed", "that recovery code doesn't open this account");
  const out = new Uint8Array(32);
  let bits = 0, acc = 0, n = 0;
  for (const ch of c) {
    const v = B32.indexOf(ch);
    if (v < 0) fail("recovery_failed", "that recovery code doesn't open this account");
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { if (n < 32) out[n++] = (acc >>> (bits - 8)) & 255; bits -= 8; acc &= (1 << bits) - 1; }
  }
  // (the last character's 4 unused bits must be zero: one spelling per code)
  if (acc !== 0) fail("recovery_failed", "that recovery code doesn't open this account");
  return out;
}

/**
 * The recovery key pair for a seed and an account: { sign: { raw, key, sign() }, kem: { publicRaw, privateKey } }.
 * The derived bytes are zeroed before this returns; the keys keep their own (non-extractable) copies.
 */
export async function recoveryKeys(seed, account) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) fail("bad_form", "a seed is 32 bytes");
  const derive = (label) => crypto().hkdf(seed, enc(account), enc(label), 32);
  const s = await derive(LABELS.recoverySign);
  const k = await derive(LABELS.recoveryKem);
  try {
    return Object.freeze({ sign: await ed25519FromSeed(s), kem: await kemFromSeed(k) });
  } finally {
    s.fill(0);
    k.fill(0);
  }
}
