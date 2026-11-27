// A document key generation's content key (CEK), wrapped for the sealed index's key declaration (design:
// e2e-encryption.md §3.1): a random 32-byte CEK per generation, stored only wrapped under its epoch's K_wrap[e].
//
//   wrapped = nonce (12) ‖ AES-256-GCM(K_wrap[e], nonce, CEK, aad)   (60 bytes)
//   aad     = LABELS.docCekWrap ‖ field(account) ‖ field(document) ‖ field(cekId) ‖ u64(keyEpoch)
//
// The AAD binds where the generation belongs, so a wrapped CEK copied to another document, generation id or epoch
// fails to unwrap. A nonce is random: an epoch wraps one CEK per document generation, far below AES-GCM's random-nonce
// bound. The raw CEK is cleared once it is wrapped or imported; what callers keep is importCek's handle.
import { LABELS } from "./labels.ts";
import { mintedEpoch, type EpochKeys } from "./keys.ts";
import { importCek } from "./chunks.ts";
import { buf, concat, name, refuse, u64, utf8 } from "./bytes.ts";

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const NONCE = 12;
/** A wrapped CEK's length: the nonce, the 32-byte CEK and the 16-byte tag. */
export const WRAPPED_CEK = NONCE + 32 + 16;

/** Where a generation belongs: what its wrapping binds. */
export type CekPlace = Readonly<{ account: string; document: string; cekId: string; keyEpoch: number }>;

const aad = (p: CekPlace): Uint8Array =>
  concat(utf8(LABELS.docCekWrap), name(p.account, "the account"), name(p.document, "the document"), name(p.cekId, "the key generation"), u64(p.keyEpoch));

// (the epoch's keys as deriveEpochKeys made them, for this account and epoch: a bundle of another epoch would wrap a
//  generation that no device reading its declaration could open)
function wrapKey(keys: EpochKeys, p: CekPlace): CryptoKey {
  const m = mintedEpoch(keys);
  if (m.account !== p.account || m.n !== p.keyEpoch) refuse("bad_form", "a generation is wrapped under its own account's and epoch's keys");
  return keys.wrap;
}

/** A new generation: a random CEK, its handle, and its wrapping for the declaration. The raw bytes are cleared. */
export async function mintDocCek(keys: EpochKeys, p: CekPlace): Promise<{ cek: CryptoKey; wrapped: Uint8Array }> {
  const k = wrapKey(keys, p), a = aad(p);
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
  try {
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE));
    const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: buf(a) }, k, raw));
    return { cek: await importCek(raw), wrapped: concat(nonce, ct) };
  } finally { raw.fill(0); }
}

/** A declared generation's CEK handle; refused (bad_form) if the wrapping isn't 60 bytes or doesn't open for `p`. */
export async function unwrapDocCek(keys: EpochKeys, p: CekPlace, wrapped: Uint8Array): Promise<CryptoKey> {
  const k = wrapKey(keys, p), a = aad(p);
  if (!(wrapped instanceof Uint8Array) || wrapped.length !== WRAPPED_CEK) refuse("bad_form", `a wrapped content key is ${WRAPPED_CEK} bytes`);
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: buf(wrapped.slice(0, NONCE)), additionalData: buf(a) }, k, buf(wrapped.slice(NONCE))));
  } catch { return refuse("bad_form", "a wrapped content key that doesn't open for this document's generation"); }
  try { return await importCek(raw); } finally { raw.fill(0); }
}
