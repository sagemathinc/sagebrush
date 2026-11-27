// The fleet core's one crypto interface. The core never names a library: whoever loads it installs one backend, once
// (lib/fleet/node-crypto.mjs in Node, core/webcrypto.mjs in a page, a Worker or the app's web view), and every hash,
// signature check, derivation and random id goes through it.
//
// A backend is an object with exactly these methods:
//   sha256(bytes)                   -> Promise<Uint8Array> (32 bytes)
//   ed25519Verify(raw, msg, sig)    -> Promise<boolean>: the library's own check, never a throw. The core calls it only
//                                      after its own strict rules pass (ed25519.mjs: canonical points, no small-order
//                                      key, S < L), because libraries differ on exactly those (Node 20 and 22 accept a
//                                      small-order forgery), so no backend is trusted with them.
//   ed25519FromSeed(seed)           -> Promise<{ raw, sign(msg) -> Promise<Uint8Array> }> (fixtures and recovery keys)
//   hkdf(ikm, salt, info, length)   -> Promise<Uint8Array>: HKDF-SHA256
//   random(n)                       -> Uint8Array of n bytes from the platform's CSPRNG (synchronous everywhere)
// and, for HPKE (hpke.mjs: sealed packages and capability mints, r2.3 §7 and §5.2):
//   hmacSha256(key, data)           -> Promise<Uint8Array> (32 bytes): HKDF's Extract and Expand, step by step
//   x25519Generate()                -> Promise<{ raw, dh(peerRaw) -> Promise<Uint8Array> }>: a fresh pair whose private
//                                      half never leaves the backend (non-extractable in WebCrypto)
//   x25519FromPrivate(sk)           -> Promise<{ raw, dh(peerRaw) }>: a pair from its 32-byte private key (a host's
//                                      stored key, and the RFC 9180 vectors). dh never throws on bytes: it gives the
//                                      32-byte shared secret, or null where the library refuses; the core refuses an
//                                      all-zero secret itself (RFC 9180 §7.1.4), whatever the library does
//   aes256gcmSeal(key, nonce, aad, plaintext) -> Promise<Uint8Array>: the ciphertext with its 16-byte tag
//   aes256gcmOpen(key, nonce, aad, ciphertext) -> Promise<Uint8Array | null>: null when the tag doesn't verify, never a
//                                      throw

const METHODS = [
  "sha256", "ed25519Verify", "ed25519FromSeed", "hkdf", "random",
  "hmacSha256", "x25519Generate", "x25519FromPrivate", "aes256gcmSeal", "aes256gcmOpen",
];

let given = null, installed = null;

/**
 * Install the backend. Once per process: installing the same object again is a no-op, and any other is refused, so
 * nothing loaded later can swap the checks under code that has already verified with them.
 */
export function useCrypto(backend) {
  if (given !== null) {
    if (backend === given) return;
    throw new Error("the fleet crypto backend is already installed");
  }
  for (const m of METHODS) if (typeof backend?.[m] !== "function") throw new Error(`a fleet crypto backend has ${m}()`);
  installed = Object.freeze(Object.fromEntries(METHODS.map((m) => [m, backend[m].bind(backend)])));
  given = backend;
}

/** The installed backend. */
export function crypto() {
  if (installed === null) throw new Error("no fleet crypto backend: install one with useCrypto()");
  return installed;
}
