// HPKE for the end-to-end encryption (design: e2e-encryption.md §3, option A): the fleet core's own RFC 9180 base mode,
// DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, reached through fleet/install.ts; no second implementation.
// A recipient's private key is a WebCrypto X25519 key that isn't extractable, given with its public half (DHKEM's KEM
// context is enc ‖ pkR, and a private key that isn't extractable can't give its public half back). The context each
// wrapper is bound to (§3.4) is the caller's `info`.
import { fleetCore } from "../fleet/install.ts";
import { buf, refuse } from "./bytes.ts";

export type Recipient = Readonly<{ publicRaw: Uint8Array; privateKey: CryptoKey }> | CryptoKeyPair;

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const X = { name: "X25519" };

// (the core's key pair shape: the public key's 32 bytes, and dh(peer) giving the shared secret, or null where
//  WebCrypto refuses; the core refuses an all-zero secret itself)
async function pair(r: Recipient): Promise<{ raw: Uint8Array; dh(peer: Uint8Array): Promise<Uint8Array | null> }> {
  const privateKey = r?.privateKey;
  if (!(privateKey instanceof CryptoKey) || privateKey.type !== "private" || privateKey.algorithm.name !== "X25519" || !privateKey.usages.includes("deriveBits")) {
    refuse("bad_form", "a recipient's private key is an X25519 key for deriveBits");
  }
  if (privateKey.extractable) refuse("bad_form", "a recipient's private key must not be extractable");
  const raw = "publicRaw" in r ? r.publicRaw : new Uint8Array(await subtle().exportKey("raw", r.publicKey));
  if (!(raw instanceof Uint8Array) || raw.length !== 32) refuse("bad_form", "an X25519 public key is 32 bytes");
  return {
    raw,
    async dh(peer) {
      try {
        const pub = await subtle().importKey("raw", buf(peer), X, true, []);
        return new Uint8Array(await subtle().deriveBits({ name: "X25519", public: pub }, privateKey, 256));
      } catch { return null; }
    },
  };
}

const core = () => fleetCore();

export const hpke = Object.freeze({
  /** Seal one message to a recipient's 32-byte X25519 public key: { enc, ct }. */
  seal: (recipientPublicRaw: Uint8Array, info: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Promise<{ enc: Uint8Array; ct: Uint8Array }> =>
    core().hpkeSeal(recipientPublicRaw, info, aad, plaintext),
  /** Open it; throws (bad_form) when it doesn't open under this key, info and aad. */
  open: async (recipient: Recipient, enc: Uint8Array, info: Uint8Array, aad: Uint8Array, ct: Uint8Array): Promise<Uint8Array> =>
    core().hpkeOpen(await pair(recipient), enc, info, aad, ct),
  /** SetupBaseS, then Export (RFC 9180 §5.3): { enc, secret }, the secret `length` bytes (1 to 8160). */
  sendExport: (recipientPublicRaw: Uint8Array, info: Uint8Array, exporterContext: Uint8Array, length: number): Promise<{ enc: Uint8Array; secret: Uint8Array }> =>
    core().hpkeSendExport(recipientPublicRaw, info, exporterContext, length),
  /** SetupBaseR, then Export: the sender's secret. */
  receiveExport: async (recipient: Recipient, enc: Uint8Array, info: Uint8Array, exporterContext: Uint8Array, length: number): Promise<Uint8Array> =>
    core().hpkeReceiveExport(await pair(recipient), enc, info, exporterContext, length),
});
