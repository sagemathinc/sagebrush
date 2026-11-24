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

const METHODS = ["sha256", "ed25519Verify", "ed25519FromSeed", "hkdf", "random"];

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
