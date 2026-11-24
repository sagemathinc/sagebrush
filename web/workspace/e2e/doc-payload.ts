// A document's payloads under end-to-end encryption (design: e2e-encryption.md §3.1 and §4): a patch's payload, and a
// presence message, each sealed as one object under the document's current key generation (its CEK). A header says
// where the payload belongs; it is a canonical, length-prefixed encoding whose SHA-256 is the object's `version`, so
// every field is bound by the per-sealing key and by every chunk's AAD (chunks.ts). The opener rebuilds the header from
// what it already knows (the server-visible envelope and its own key declaration) and refuses any payload sealed for
// another place. Clear history's root is an ordinary patch in the document's new epoch.
//
// A slice, as it goes in a batch's body: the 32-byte seal id, then the one chunk. The server counts the slice against
// the protocol's inline-patch limit (LIMITS.patchBytes), so a patch's payload is bounded by that, less the seal id and
// the tag; a presence message keeps its own bound, set where its wire form is (not the patch's by accident). Not used by the page yet: document sync is wired on top of the sealed key
// declaration.
import { LABELS } from "./labels.ts";
import { buf, concat, hex, name, refuse, u32, u64, utf8 } from "./bytes.ts";
import { CHUNK, TAG, openObject, sealObject, type ObjectHeader } from "./chunks.ts";
import { pinnedCodec } from "./codecs.ts";

/** The one codec of document payloads: stored as they are (a patch is small, and JSON's gain isn't worth a codec). */
export const PAYLOAD_CODEC = "store.1";
/** A seal id's length (chunks.ts): the slice's first bytes. */
export const SEAL_ID = 32;
// (the protocol's own bounds, sync-protocol's LIMITS.patchParents and LIMITS.patchBytes, written here so that the crypto
// core imports nothing of sync's; test-e2e-doc-payload.mjs checks that they agree)
/** The most parents a patch names: the header refuses more. */
export const PARENTS_MAX = 8;
/** A sealed patch is at most the protocol's inline-patch limit; its payload, that less the seal id and the tag. */
export const PATCH_SLICE_MAX = 256 << 10;
export const PATCH_PAYLOAD_MAX = PATCH_SLICE_MAX - SEAL_ID - TAG;
/** A presence message, for now: one chunk (its transport bound is set with its wire form). */
export const PRESENCE_PAYLOAD_MAX = CHUNK;

/** Where a patch belongs: what its header binds. */
export type PatchPlace = Readonly<{
  /** the E2E account id (the chain's, not the raw account hash) */
  account: string;
  document: string;
  /** Clear history's epoch of the document */
  documentEpoch: number;
  /** the document key generation that sealed it, as the sealed index declares it */
  cekId: string;
  /** the account key epoch that generation belongs to */
  keyEpoch: number;
  /** the patchflow client, and its sequence number */
  client: string;
  cseq: number;
  /** the envelope's id, and its parents, in their order */
  patchId: string;
  parents: readonly string[];
}>;

/** Where a presence message belongs: the document, its current key generation, and the device that sent it. */
export type PresencePlace = Readonly<{ account: string; document: string; cekId: string; keyEpoch: number; device: string }>;

function nat(n: unknown, what: string): number {
  if (!Number.isSafeInteger(n) || (n as number) < 0) refuse("bad_form", `${what} is a whole number`);
  return n as number;
}

/** A patch's header, canonical: its label, then each field length-prefixed or fixed-width, and the parents counted. */
export function patchHead(p: PatchPlace): Uint8Array {
  const parents = p?.parents;
  if (!Array.isArray(parents) || parents.length > PARENTS_MAX) refuse("bad_form", `a patch names at most ${PARENTS_MAX} parents`);
  return concat(
    utf8(LABELS.docPatch),
    name(p.account, "the account"),
    name(p.document, "the document"),
    u64(nat(p.documentEpoch, "the document's epoch")),
    name(p.cekId, "the key generation"),
    u64(nat(p.keyEpoch, "the key epoch")),
    name(p.client, "the client"),
    u64(nat(p.cseq, "the sequence number")),
    name(p.patchId, "the patch id"),
    u32(parents.length),
    // (by index, so a hole in the list is a missing name, refused like any other)
    ...Array.from({ length: parents.length }, (_, i) => name(parents[i], "a parent")),
  );
}

/** A presence message's header, canonical, in the same way. */
export function presenceHead(p: PresencePlace): Uint8Array {
  return concat(
    utf8(LABELS.docPresence),
    name(p?.account, "the account"),
    name(p.document, "the document"),
    name(p.cekId, "the key generation"),
    u64(nat(p.keyEpoch, "the key epoch")),
    name(p.device, "the device"),
  );
}

const sha256hex = async (b: Uint8Array): Promise<string> => hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", buf(b))));

// (the object header a payload is sealed under: its kind, the document, and the place's digest as the version)
async function header(kind: "patch" | "presence", account: string, document: string, head: Uint8Array, length: number): Promise<ObjectHeader> {
  return { account, kind, object: document, version: await sha256hex(head), codec: PAYLOAD_CODEC, plaintextLength: length, compressedLength: length };
}

async function seal(cek: CryptoKey, h: ObjectHeader, payload: Uint8Array, max: number): Promise<Uint8Array> {
  if (!(payload instanceof Uint8Array)) refuse("bad_form", "a payload is bytes");
  if (payload.length > max) refuse("limit", `this payload is at most ${max} bytes`);
  const { sealId, chunks } = await sealObject(cek, h, payload);
  return concat(sealId, chunks[0]);
}

async function open(cek: CryptoKey, kind: "patch" | "presence", account: string, document: string, head: Uint8Array, slice: Uint8Array, max: number): Promise<Uint8Array> {
  // (both bounds before any digest or decryption)
  if (!(slice instanceof Uint8Array) || slice.length < SEAL_ID + TAG) refuse("bad_form", "a sealed payload is a seal id and one chunk");
  if (slice.length > SEAL_ID + max + TAG) refuse("limit", `this sealed payload is at most ${SEAL_ID + max + TAG} bytes`);
  const length = slice.length - SEAL_ID - TAG;
  const h = await header(kind, account, document, head, length);
  const limits = { maxPlaintext: CHUNK, maxCompressed: CHUNK, maxRatio: 1 };
  return openObject(cek, h, { sealId: slice.subarray(0, SEAL_ID), chunks: [slice.subarray(SEAL_ID)] }, pinnedCodec(PAYLOAD_CODEC).inflate, limits);
}

/** Seal a patch's payload (the stored patch without its time and parents) for its place: the slice a batch carries. */
export async function sealPatch(cek: CryptoKey, place: PatchPlace, payload: Uint8Array): Promise<Uint8Array> {
  const head = patchHead(place);
  return seal(cek, await header("patch", place.account, place.document, head, payload?.length ?? 0), payload, PATCH_PAYLOAD_MAX);
}

/** Open a pulled slice for the place the envelope and the key declaration give it; refused if sealed for another. */
export async function openPatch(cek: CryptoKey, place: PatchPlace, slice: Uint8Array): Promise<Uint8Array> {
  return open(cek, "patch", place.account, place.document, patchHead(place), slice, PATCH_PAYLOAD_MAX);
}

/** Seal a presence message's state (its JSON's bytes) under the document's current key generation. */
export async function sealPresence(cek: CryptoKey, place: PresencePlace, state: Uint8Array): Promise<Uint8Array> {
  const head = presenceHead(place);
  return seal(cek, await header("presence", place.account, place.document, head, state?.length ?? 0), state, PRESENCE_PAYLOAD_MAX);
}

/** Open a relayed presence message from `place.device`; refused if sealed for another document, key or device. */
export async function openPresence(cek: CryptoKey, place: PresencePlace, slice: Uint8Array): Promise<Uint8Array> {
  return open(cek, "presence", place.account, place.document, presenceHead(place), slice, PRESENCE_PAYLOAD_MAX);
}
