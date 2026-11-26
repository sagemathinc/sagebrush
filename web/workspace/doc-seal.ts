// A notebook's patches on the wire under end-to-end encryption (design: e2e-encryption.md §3.1 and §4). A slice in a
// batch's body is: the format byte 0x01, the document key generation that sealed it (its cekId as a length-prefixed
// field, its key epoch as a u64), then that sealing (e2e/doc-payload.ts: the seal id and one chunk). The server stores
// the slice and checks only its size, never its form. The generation is visible to it, which is metadata: it is bound
// again in the sealed header, so a slice whose prefix is edited fails to open.
//
// Opt-in: DocSync uses this only when it is given a key provider (DocKeys), which a page gives once its account has
// end-to-end keys (doc-keys.ts, over the sealed index's key declarations). The rule that a generation retired at a
// chain head can't seal anything authorized from that head on belongs to that declaration, not to this module.
import { sealPatch, openPatch, PATCH_SLICE_MAX, SEAL_ID, type PatchPlace } from "./e2e/doc-payload.ts";
import { TAG } from "./e2e/chunks.ts";
import { concat, field, name, refuse, u64, utf8 } from "./e2e/bytes.ts";
import { clientOf } from "../sync-protocol/protocol.ts";

/** The slice format this module writes, and the only one it reads. */
export const SLICE_FORMAT = 0x01;
/** A cekId's bounds: a name, as the crypto core's (1 to 256 UTF-8 bytes, no NUL, well-formed). */
export const CEK_ID_MAX = 256;

/** A document key generation: its id, the account key epoch it belongs to, and its content key (importCek). */
export type KeyGeneration = Readonly<{ cekId: string; keyEpoch: number; cek: CryptoKey }>;
/** Where DocSync gets a document's keys: the E2E account id, the current generation, and one generation exactly. */
export interface DocKeys {
  /** the E2E account id (the key chain's), bound in every patch's header */
  readonly account: string;
  /** the generation new patches of `doc` are sealed under */
  current(doc: string): Promise<KeyGeneration>;
  /** exactly the generation (doc, cekId, keyEpoch) declares, or null: never another, never the current by default */
  find(doc: string, cekId: string, keyEpoch: number): Promise<CryptoKey | null>;
}
/** Where a patch is in its document: what the envelope says, with the batch's Clear-history epoch. */
export type PatchWhere = Readonly<{ doc: string; epoch: number; client: string; cseq: number; id: string; parents: readonly string[] }>;

const prefixOf = (cekId: string, keyEpoch: number): Uint8Array => concat(new Uint8Array([SLICE_FORMAT]), name(cekId, "the key generation"), u64(keyEpoch));

/** The largest payload a slice of this generation carries: the whole slice is at most the protocol's patch limit. */
export function payloadMax(cekId: string, keyEpoch: number): number {
  const n = PATCH_SLICE_MAX - prefixOf(cekId, keyEpoch).length - SEAL_ID - TAG;
  if (!Number.isSafeInteger(n) || n < 0) refuse("limit", "no room for a payload");
  return n;
}

const place = (account: string, w: PatchWhere, cekId: string, keyEpoch: number): PatchPlace => ({
  account, document: w.doc, documentEpoch: w.epoch, cekId, keyEpoch, client: w.client, cseq: w.cseq, patchId: w.id, parents: w.parents,
});

/** Seal one patch's payload (the stored patch without its time and parents) under the document's current generation. */
export async function sealSlice(keys: DocKeys, w: PatchWhere, payload: Uint8Array): Promise<Uint8Array> {
  const g = await keys.current(w.doc);
  const prefix = prefixOf(g.cekId, g.keyEpoch);
  if (!(payload instanceof Uint8Array)) refuse("bad_form", "a payload is bytes");
  if (payload.length > payloadMax(g.cekId, g.keyEpoch)) refuse("limit", `a sealed patch is at most ${PATCH_SLICE_MAX} bytes`);
  return concat(prefix, await sealPatch(g.cek, place(keys.account, w, g.cekId, g.keyEpoch), payload));
}

const strict = new TextDecoder("utf-8", { fatal: true });

/** A slice's prefix, read exactly: the generation it names and where the sealing starts.  Refused (bad_form) unless the
 * format is 0x01, the cekId's length is 1 to 256 and its bytes are well-formed UTF-8 that a name admits, and the key
 * epoch is a whole number no larger than 2^53 - 1; read as a BigInt, so no value is rounded. */
export function readPrefix(slice: Uint8Array): { cekId: string; keyEpoch: number; at: number } {
  if (!(slice instanceof Uint8Array) || slice.length < 1 + 4) refuse("bad_form", "a sealed patch starts with its format and its key generation");
  if (slice[0] !== SLICE_FORMAT) refuse("bad_form", "not a sealed patch of a known format");
  const view = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
  const len = view.getUint32(1);
  if (len < 1 || len > CEK_ID_MAX) refuse("bad_form", "a key generation's id is 1 to 256 bytes");
  if (slice.length < 1 + 4 + len + 8) refuse("bad_form", "a sealed patch's prefix is cut short");
  const raw = slice.subarray(5, 5 + len);
  let cekId: string;
  try { cekId = strict.decode(raw); } catch { return refuse("bad_form", "a key generation's id isn't UTF-8"); }
  const again = utf8(cekId);
  if (again.length !== raw.length || again.some((b, i) => b !== raw[i])) refuse("bad_form", "a key generation's id isn't in its one encoding");
  name(cekId, "the key generation");
  const big = view.getBigUint64(5 + len);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) refuse("bad_form", "a key epoch is at most 2^53 - 1");
  return { cekId, keyEpoch: Number(big), at: 5 + len + 8 };
}

/** Open one pulled slice: its generation found exactly (an unknown one is refused, never tried), then the sealing
 * opened for the place the envelope gives it, with that same generation in its header. */
export async function openSlice(keys: DocKeys, w: PatchWhere, slice: Uint8Array): Promise<Uint8Array> {
  if (!(slice instanceof Uint8Array)) refuse("bad_form", "a sealed patch is bytes");
  if (slice.length > PATCH_SLICE_MAX) refuse("limit", `a sealed patch is at most ${PATCH_SLICE_MAX} bytes`);
  const { cekId, keyEpoch, at } = readPrefix(slice);
  const cek = await keys.find(w.doc, cekId, keyEpoch);
  if (!cek) refuse("bad_form", "a key generation this document doesn't declare");
  return openPatch(cek as CryptoKey, place(keys.account, w, cekId, keyEpoch), slice.subarray(at));
}

/** The place of a pulled patch: its client from its id, as the protocol reads it. */
export const whereOf = (doc: string, epoch: number, e: { id: string; cseq: number; parents: readonly string[] }): PatchWhere =>
  ({ doc, epoch, client: clientOf(e.id), cseq: e.cseq, id: e.id, parents: e.parents });
