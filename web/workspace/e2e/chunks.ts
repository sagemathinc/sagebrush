// Large objects in chunks (design: e2e-encryption.md §3.2 and §3.3). The whole object is compressed once with its
// pinned codec, and the compressed stream is cut into chunks of exactly 1 MiB (the last one shorter; an empty object
// is one empty chunk, so it still has a tag). Each chunk is AES-256-GCM with a 16-byte tag.
//
//   a document, snapshot or index snapshot: its random content key (CEK); the nonce is a random 64-bit prefix for the
//     object, then u32(chunk index)
//   a blob: one key per chunk (keys.ts chunkKey, from the file key) and a zero nonce: deterministic, so two devices
//     uploading the same file make the same bytes
//
// The AAD binds the label (the protocol and its version), the account, the object (kind, id and version; a blob's
// address), the codec, both total lengths, the chunk count, the chunk's index and its length. So chunks can't be
// reordered, dropped, cut short, added or moved to another object.
//
// Opening authenticates every chunk first; only then is the codec's inflate called, bounded by the declared length,
// a ratio and a ceiling, and its output must be exactly the declared length (§3.2: a hostile object can't exhaust
// memory). Refusals are bad_form (doesn't open, or not this shape) or limit (over a bound).
import { LABELS } from "./labels.ts";
import { ADDRESS, chunkKey, codecBytes } from "./keys.ts";
import { buf, concat, field, name, refuse, u32, u64, utf8 } from "./bytes.ts";

export const CHUNK = 1 << 20;
export const TAG = 16;
const PREFIX = 8;
const ZERO_NONCE = new Uint8Array(12);
const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const gcm = (iv: Uint8Array, additionalData: Uint8Array) => ({ name: "AES-GCM", iv, additionalData, tagLength: 128 });

export const KINDS = Object.freeze(["document", "snapshot", "index-snapshot"] as const);
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

function objectHead(h: ObjectHeader): Uint8Array {
  if (!KINDS.includes(h?.kind)) refuse("bad_form", "an object is a document, a snapshot or an index snapshot");
  return concat(utf8(LABELS.objectChunkAad), name(h.account, "the account"), field(utf8(h.kind)), name(h.object, "the object"), name(h.version, "the version"), totals(h));
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
  chunks.forEach((c, i) => {
    if (!(c instanceof Uint8Array) || c.length !== lengthOf(h.compressedLength, count, i) + TAG) refuse("bad_form", "a chunk isn't its declared length");
  });
  return count;
}

function bounded(h: { plaintextLength: number; compressedLength: number }, limits: Limits) {
  const { maxPlaintext, maxCompressed, maxRatio } = limits ?? ({} as Limits);
  if (![maxPlaintext, maxCompressed, maxRatio].every((x) => Number.isSafeInteger(x) && x > 0)) refuse("bad_form", "opening needs its limits");
  if (h.plaintextLength > maxPlaintext || h.compressedLength > maxCompressed) refuse("limit", "the object is larger than this device opens");
  if (h.plaintextLength > Math.max(h.compressedLength, 1) * maxRatio) refuse("limit", "the object inflates more than the ratio allows");
}

async function inflated(compressed: Uint8Array, h: { plaintextLength: number }, inflate: Inflate): Promise<Uint8Array> {
  if (typeof inflate !== "function") refuse("bad_form", "opening needs the codec's inflate");
  const out = await inflate(compressed, h.plaintextLength);
  if (!(out instanceof Uint8Array) || out.length !== h.plaintextLength) refuse("bad_form", "the inflated bytes aren't the declared length");
  return out;
}

/** Seal a document, snapshot or index snapshot under its CEK: a fresh nonce prefix and the chunks. */
export async function sealObject(cek: CryptoKey, h: ObjectHeader, compressed: Uint8Array): Promise<{ prefix: Uint8Array; chunks: Uint8Array[] }> {
  const head = objectHead(h);
  sealable(h, compressed);
  const count = chunkCount(h.compressedLength), prefix = globalThis.crypto.getRandomValues(new Uint8Array(PREFIX));
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const pt = compressed.subarray(i * CHUNK, i * CHUNK + lengthOf(h.compressedLength, count, i));
    chunks.push(new Uint8Array(await subtle().encrypt(gcm(concat(prefix, u32(i)), chunkAad(head, count, i, pt.length)), cek, buf(pt))));
  }
  return { prefix, chunks };
}

/** Open what sealObject made: every chunk authenticated, then inflated within the limits. */
export async function openObject(cek: CryptoKey, h: ObjectHeader, sealed: { prefix: Uint8Array; chunks: readonly Uint8Array[] }, inflate: Inflate, limits: Limits): Promise<Uint8Array> {
  const head = objectHead(h);
  bounded(h, limits);
  const { prefix, chunks } = sealed ?? ({} as typeof sealed);
  if (!(prefix instanceof Uint8Array) || prefix.length !== PREFIX) refuse("bad_form", "a nonce prefix is 8 bytes");
  const count = openable(h, chunks);
  const compressed = new Uint8Array(h.compressedLength);
  for (let i = 0; i < count; i++) {
    const length = chunks[i].length - TAG;
    let pt: ArrayBuffer;
    try {
      pt = await subtle().decrypt(gcm(concat(prefix, u32(i)), chunkAad(head, count, i, length)), cek, buf(chunks[i]));
    } catch {
      refuse("bad_form", "a chunk doesn't open under this key and header");
    }
    compressed.set(new Uint8Array(pt), i * CHUNK);
  }
  return inflated(compressed, h, inflate);
}

/** Seal a blob under its file key: the same file key, header and bytes always give the same chunks. */
export async function sealBlob(kFile: Uint8Array, h: BlobHeader, compressed: Uint8Array): Promise<Uint8Array[]> {
  const head = blobHead(h);
  sealable(h, compressed);
  const count = chunkCount(h.compressedLength);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const pt = compressed.subarray(i * CHUNK, i * CHUNK + lengthOf(h.compressedLength, count, i));
    chunks.push(new Uint8Array(await subtle().encrypt(gcm(ZERO_NONCE, chunkAad(head, count, i, pt.length)), await chunkKey(kFile, i), buf(pt))));
  }
  return chunks;
}

/** Open what sealBlob made: every chunk authenticated, then inflated within the limits. */
export async function openBlob(kFile: Uint8Array, h: BlobHeader, chunks: readonly Uint8Array[], inflate: Inflate, limits: Limits): Promise<Uint8Array> {
  const head = blobHead(h);
  bounded(h, limits);
  const count = openable(h, chunks);
  const compressed = new Uint8Array(h.compressedLength);
  for (let i = 0; i < count; i++) {
    const length = chunks[i].length - TAG;
    let pt: ArrayBuffer;
    try {
      pt = await subtle().decrypt(gcm(ZERO_NONCE, chunkAad(head, count, i, length)), await chunkKey(kFile, i), buf(chunks[i]));
    } catch {
      refuse("bad_form", "a chunk doesn't open under this key and header");
    }
    compressed.set(new Uint8Array(pt), i * CHUNK);
  }
  return inflated(compressed, h, inflate);
}
