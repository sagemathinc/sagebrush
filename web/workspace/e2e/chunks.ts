// Large objects in chunks (design: e2e-encryption.md §3.2 and §3.3). The whole object is compressed once with its
// pinned codec, and the compressed stream is cut into chunks of exactly 1 MiB (the last one shorter; an empty object
// is one empty chunk, so it still has a tag). Each chunk is AES-256-GCM with a 16-byte tag.
//
//   a document, snapshot or index snapshot: under its random content key (CEK, an HKDF key: importCek), each sealing
//     draws a fresh 256-bit seal id and uses its own key K_object = HKDF(CEK, LABELS.objectKey ‖ fields(header) ‖
//     seal id), with the nonce 0^64 ‖ u32(chunk index). So a CEK can seal any number of times without a nonce budget
//     (no random nonce shared across sealings), and the seal id is bound in every chunk's AAD too
//   a blob: one key per chunk (keys.ts chunkKey, from the file key) and a zero nonce: deterministic, so two devices
//     uploading the same file make the same bytes. A zero nonce is safe only while each chunk key encrypts one byte
//     string, so sealBlob owns that: it takes the epoch's keys, the SHA-256, the plaintext and a pinned codec's NAME
//     (codecs.ts: a frozen registry; no caller-supplied implementation), checks the plaintext is the file that
//     SHA-256 names, compresses it with that codec, and derives the address, the file key and every AAD field from
//     (epoch, sha, codec); the epoch is one deriveEpochKeys made (keys.ts mintedEpoch: a copy with another account,
//     or mixing two epochs' handles, is refused). So one file key is used for one byte string: sha fixes the plaintext, and the registered
//     codec is a deterministic function of it (each codec's determinism is its admission test, codecs.ts).
//
// The AAD binds the label (the protocol and its version), the account, the object (kind, id and version, and the seal
// id; a blob's address), the codec, both total lengths, the chunk count, the chunk's index and its length. So chunks can't be
// reordered, dropped, cut short, added or moved to another object.
//
// Opening authenticates every chunk first; only then is the codec's inflate called, bounded by the declared length,
// a ratio and a ceiling, and its output must be exactly the declared length (§3.2: a hostile object can't exhaust
// memory). Every plaintext buffer opening makes (each decrypted chunk, and the assembled compressed bytes) is cleared
// before it returns or throws; sealing works on a copy of its input, cleared the same way. Refusals are bad_form
// (doesn't open, or not this shape) or limit (over a bound).
import { LABELS } from "./labels.ts";
import { ADDRESS, chunkKey, codecBytes, fileKey, mintedEpoch, wireAddress } from "./keys.ts";
import { pinnedCodec } from "./codecs.ts";
import type { EpochKeys } from "./keys.ts";
import { buf, bytes32, concat, field, name, refuse, u32, u64, utf8 } from "./bytes.ts";

export const CHUNK = 1 << 20;
export const TAG = 16;
const SEAL_ID = 32;
const ZERO_NONCE = new Uint8Array(12);
// (the nonce of chunk i under a per-sealing key: 0^64 ‖ u32(i))
const indexNonce = (i: number) => concat(new Uint8Array(8), u32(i));
const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const gcm = (iv: Uint8Array, additionalData: Uint8Array) => ({ name: "AES-GCM", iv, additionalData, tagLength: 128 });

// (the index's own: an op, a page of the paged snapshot, and the snapshot's root, each sealed under K_index[e])
export const KINDS = Object.freeze(["document", "snapshot", "index-snapshot", "index-op", "index-page"] as const);
export type ObjectHeader = Readonly<{
  account: string;
  kind: (typeof KINDS)[number];
  object: string;
  version: string;
  codec: string;
  plaintextLength: number;
  compressedLength: number;
}>;
export type BlobHeader = Readonly<{
  account: string;
  /** the wire address, "a1:" and 64 hex digits (keys.ts wireAddress) */
  address: string;
  codec: string;
  plaintextLength: number;
  compressedLength: number;
}>;

/** How opening may inflate: `inflate(compressed, maxOut)` must stop past maxOut bytes (and may throw there). */
export type Inflate = (compressed: Uint8Array, maxOut: number) => Uint8Array | Promise<Uint8Array>;
export type Limits = Readonly<{ maxPlaintext: number; maxCompressed: number; maxRatio: number }>;

/** The number of chunks of a compressed length: 1 MiB each, at least one. */
export function chunkCount(compressedLength: number): number {
  const n = Math.max(1, Math.ceil(compressedLength / CHUNK));
  if (n > 0xffffffff) refuse("limit", "more chunks than a u32 counts");
  return n;
}
const lengthOf = (total: number, count: number, i: number) => (i < count - 1 ? CHUNK : total - CHUNK * (count - 1));

// (the totals every chunk's AAD binds: both lengths and the codec, checked before anything is sealed or opened)
function totals(h: { codec: string; plaintextLength: number; compressedLength: number }): Uint8Array {
  return concat(field(codecBytes(h.codec)), u64(h.plaintextLength), u64(h.compressedLength));
}

// (an object header's canonical fields: what both its key and every chunk's AAD bind)
function objectFields(h: ObjectHeader): Uint8Array {
  if (!KINDS.includes(h?.kind)) refuse("bad_form", "an object is a document, a snapshot, or an index snapshot, op or page");
  return concat(name(h.account, "the account"), field(utf8(h.kind)), name(h.object, "the object"), name(h.version, "the version"), totals(h));
}

/** A content key (CEK) from its 32 raw bytes: an HKDF key, not extractable, for deriveKey only (the caller clears the bytes). */
export function importCek(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", buf(bytes32(raw, "a content key")), "HKDF", false, ["deriveKey"]);
}

// (a CEK is what importCek makes, or a structured clone of it: a secret HKDF key, not extractable, whose one use is
//  deriveKey. Anything else, a key that also derives bits included, is refused before any randomness or crypto)
function cekShape(cek: unknown): CryptoKey {
  const k = cek as CryptoKey;
  if (!(cek instanceof CryptoKey) || k.type !== "secret" || k.algorithm?.name !== "HKDF" || k.extractable !== false || k.usages.length !== 1 || k.usages[0] !== "deriveKey") {
    refuse("bad_form", "a content key is a secret HKDF key, not extractable, for deriveKey only");
  }
  return k;
}

// (one sealing's own key: HKDF(CEK, label ‖ fields ‖ seal id), AES-256-GCM, not extractable)
function objectKey(cek: CryptoKey, fields: Uint8Array, sealId: Uint8Array): Promise<CryptoKey> {
  const info = concat(utf8(LABELS.objectKey), fields, sealId);
  return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info }, cek, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function blobHead(h: BlobHeader): Uint8Array {
  if (typeof h?.address !== "string" || !ADDRESS.test(h.address)) refuse("bad_form", "a blob's address is a1: and 64 hex digits");
  return concat(utf8(LABELS.blobChunkAad), name(h.account, "the account"), field(utf8(h.address)), totals(h));
}

const chunkAad = (head: Uint8Array, count: number, i: number, length: number) => concat(head, u32(count), u32(i), u32(length));

function sealable(h: { compressedLength: number }, compressed: Uint8Array) {
  if (!(compressed instanceof Uint8Array) || compressed.length !== h.compressedLength) refuse("bad_form", "the compressed bytes aren't the declared length");
}

// (the shape of what is to be opened, against the header: the count, and every chunk's exact length)
function openable(h: { compressedLength: number }, chunks: readonly Uint8Array[]): number {
  const count = chunkCount(h.compressedLength);
  if (!Array.isArray(chunks) || chunks.length !== count) refuse("bad_form", "not the declared number of chunks");
  // (every index, holes included: a sparse array's missing chunk is refused here, not met later as undefined)
  for (let i = 0; i < count; i++) {
    const c = chunks[i];
    if (!(c instanceof Uint8Array) || c.length !== lengthOf(h.compressedLength, count, i) + TAG) refuse("bad_form", "a chunk isn't its declared length");
  }
  return count;
}

function bounded(h: { plaintextLength: number; compressedLength: number }, limits: Limits) {
  const { maxPlaintext, maxCompressed, maxRatio } = limits ?? ({} as Limits);
  if (![maxPlaintext, maxCompressed, maxRatio].every((x) => Number.isSafeInteger(x) && x > 0)) refuse("bad_form", "opening needs its limits");
  if (h.plaintextLength > maxPlaintext || h.compressedLength > maxCompressed) refuse("limit", "the object is larger than this device opens");
  if (h.plaintextLength > Math.max(h.compressedLength, 1) * maxRatio) refuse("limit", "the object inflates more than the ratio allows");
}

// Decrypt every chunk into one buffer, then inflate it. Each decrypted chunk is cleared once copied, and the assembled
// buffer in every outcome (an inflate that hands back a view of it gets a copy first).
async function assemble(h: { plaintextLength: number; compressedLength: number }, chunks: readonly Uint8Array[], count: number,
  decrypt: (i: number, length: number) => Promise<ArrayBuffer>, inflate: Inflate): Promise<Uint8Array> {
  if (typeof inflate !== "function") refuse("bad_form", "opening needs the codec's inflate");
  const compressed = new Uint8Array(h.compressedLength);
  try {
    for (let i = 0; i < count; i++) {
      let pt: Uint8Array;
      try {
        pt = new Uint8Array(await decrypt(i, chunks[i].length - TAG));
      } catch {
        refuse("bad_form", "a chunk doesn't open under this key and header");
      }
      try { compressed.set(pt, i * CHUNK); } finally { pt.fill(0); }
    }
    const out = await inflate(compressed, h.plaintextLength);
    if (!(out instanceof Uint8Array) || out.length !== h.plaintextLength) refuse("bad_form", "the inflated bytes aren't the declared length");
    return out.buffer === compressed.buffer ? out.slice() : out;
  } finally {
    compressed.fill(0);
  }
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Seal a document, snapshot or index snapshot under its CEK (importCek): a fresh 32-byte seal id and the chunks. */
export async function sealObject(cek: CryptoKey, h: ObjectHeader, compressed: Uint8Array): Promise<{ sealId: Uint8Array; chunks: Uint8Array[] }> {
  cekShape(cek);
  const fields = objectFields(h);
  sealable(h, compressed);
  const bytes = compressed.slice(); // (a copy before any await: the caller's buffer may change meanwhile)
  try {
    const count = chunkCount(h.compressedLength), sealId = globalThis.crypto.getRandomValues(new Uint8Array(SEAL_ID));
    const key = await objectKey(cek, fields, sealId), head = concat(utf8(LABELS.objectChunkAad), fields, sealId);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const pt = bytes.subarray(i * CHUNK, i * CHUNK + lengthOf(h.compressedLength, count, i));
      chunks.push(new Uint8Array(await subtle().encrypt(gcm(indexNonce(i), chunkAad(head, count, i, pt.length)), key, buf(pt))));
    }
    return { sealId, chunks };
  } finally {
    bytes.fill(0);
  }
}

/** Open what sealObject made: every chunk authenticated, then inflated within the limits. */
export async function openObject(cek: CryptoKey, h: ObjectHeader, sealed: { sealId: Uint8Array; chunks: readonly Uint8Array[] }, inflate: Inflate, limits: Limits): Promise<Uint8Array> {
  cekShape(cek);
  const fields = objectFields(h);
  bounded(h, limits);
  const { sealId, chunks } = sealed ?? ({} as typeof sealed);
  if (!(sealId instanceof Uint8Array) || sealId.length !== SEAL_ID) refuse("bad_form", "a seal id is 32 bytes");
  const count = openable(h, chunks);
  const key = await objectKey(cek, fields, sealId), head = concat(utf8(LABELS.objectChunkAad), fields, sealId);
  return assemble(h, chunks, count, (i, length) => subtle().decrypt(gcm(indexNonce(i), chunkAad(head, count, i, length)), key, buf(chunks[i])), inflate);
}

/**
 * Seal a file as a blob of the epoch: its header (account, address, codec, lengths) and chunks. `sha` must be the
 * plaintext's SHA-256, and `codec` a name codecs.ts pins. The same epoch, file and codec always give the same blob.
 */
export async function sealBlob(keys: EpochKeys, sha: Uint8Array, plaintext: Uint8Array, codec: string): Promise<{ header: BlobHeader; chunks: Uint8Array[] }> {
  // (the account and key handles come from what deriveEpochKeys recorded, never from the object's own fields)
  const epoch = mintedEpoch(keys);
  const digest = bytes32(sha, "a blob's SHA-256").slice();
  if (!(plaintext instanceof Uint8Array)) refuse("bad_form", "a blob's plaintext is bytes");
  codecBytes(codec);
  const pinned = pinnedCodec(codec);
  // (copies before any await: neither buffer of the caller can change what is hashed, compressed or sealed)
  const pt = plaintext.slice();
  let compressed: Uint8Array | undefined, kFile: Uint8Array | undefined;
  try {
    if (!same(new Uint8Array(await subtle().digest("SHA-256", buf(pt))), digest)) refuse("bad_form", "the plaintext isn't the file its SHA-256 names");
    compressed = pinned.deflate(pt);
    const header: BlobHeader = Object.freeze({
      account: epoch.account, address: await wireAddress(epoch.addr, digest), codec,
      plaintextLength: pt.length, compressedLength: compressed.length,
    });
    const head = blobHead(header), count = chunkCount(header.compressedLength);
    kFile = await fileKey(epoch.blobKey, digest, codec);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const piece = compressed.subarray(i * CHUNK, i * CHUNK + lengthOf(header.compressedLength, count, i));
      chunks.push(new Uint8Array(await subtle().encrypt(gcm(ZERO_NONCE, chunkAad(head, count, i, piece.length)), await chunkKey(kFile, i), buf(piece))));
    }
    return { header, chunks };
  } finally {
    for (const x of [pt, compressed, kFile]) if (x instanceof Uint8Array) x.fill(0);
  }
}

/** Open what sealBlob made: every chunk authenticated, then inflated within the limits. */
export async function openBlob(kFile: Uint8Array, h: BlobHeader, chunks: readonly Uint8Array[], inflate: Inflate, limits: Limits): Promise<Uint8Array> {
  const head = blobHead(h);
  bounded(h, limits);
  const count = openable(h, chunks);
  return assemble(h, chunks, count, async (i, length) => subtle().decrypt(gcm(ZERO_NONCE, chunkAad(head, count, i, length)), await chunkKey(kFile, i), buf(chunks[i])), inflate);
}
