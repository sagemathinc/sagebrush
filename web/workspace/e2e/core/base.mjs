// E2E keys (design/e2e-encryption.md §2, §2.1, §3.4, §11.1, §11.2): what every module here shares. Pure: no Node
// built-ins and no DOM, so a page, a Worker, the app's web view and Bun's tests load these files as they are. Hashing,
// Ed25519 and HKDF go through the fleet core's installed backend (fleetCore() in a page); X25519, AES-GCM and HMAC go
// through WebCrypto directly, as the design requires (no new crypto dependency).
//
// Errors carry a code and a fixed message: never a key, a secret, a code or any received value.

import { canonText } from "../../fleet/core/canonical.mjs";
import { concat, enc } from "../../fleet/core/bytes.mjs";

export class E2EError extends Error {
  constructor(code, message = code) { super(message); this.name = "E2EError"; this.code = code; }
}
export const fail = (code, message) => { throw new E2EError(code, message); };

/** WebCrypto's subtle, or a refusal: there is no fallback (§8, the browser floor). */
export function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) fail("unsupported", "no WebCrypto here");
  return s;
}

/** The labels this PR owns (§11.1: every derivation names its version). PR 1 owns the per-epoch content labels. */
export const LABELS = Object.freeze({
  keyring: "sagebrush.keyring.v1",
  kemPop: "sagebrush.kem-pop.v1",
  recoverySign: "sagebrush.e2e.recovery.sign.v1",
  recoveryKem: "sagebrush.e2e.recovery.kem.v1",
  epochCommit: "sagebrush.e2e.epoch-commit.v1",
});
/** The one HKDF salt for this PR's derivations; the label, the account and the epoch go in `info`. */
export const SALT = enc("sagebrush.e2e.v1");
/** `info` for a derivation: its label, then the account, then the epoch number, newline-separated. */
export const info = (label, account, n) => enc(`${label}\n${account}\n${n}`);

/**
 * The suites (§11.1): an epoch's chain entry names one, and everything written in that epoch uses it. A client
 * refuses a suite it doesn't know. Suite 1 is the design's: X25519 HPKE, AES-256-GCM, HKDF-SHA256, Ed25519.
 */
export const SUITES = Object.freeze({ 1: Object.freeze({ kem: "dhkem-x25519-hkdf-sha256", aead: "aes-256-gcm", kdf: "hkdf-sha256", sig: "ed25519" }) });
export const knownSuite = (n) => Number.isSafeInteger(n) && Object.hasOwn(SUITES, n);

export const AUDIENCES = Object.freeze(["https://sagebrush.space", "https://dev.sagebrush.space"]);

/** Exactly these keys, and an object. */
export const exactKeys = (o, keys) =>
  !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/** Associated data for an AEAD: a domain prefix, then a canonical object. */
export const aadOf = (domain, value) => concat(`${domain}\n`, canonText(value));

/** Constant-time equality of two byte arrays of the same length. */
export function sameBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
