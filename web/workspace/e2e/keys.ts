// The keys the end-to-end encryption derives (design: e2e-encryption.md §2 and §3.3), all with WebCrypto's HKDF-SHA256
// and HMAC-SHA256 (no salt: HKDF's zero salt, RFC 5869 §2.2). Every key that never leaves the device is a
// non-extractable CryptoKey; the one key handed over by design, a blob's file key (a share gives exactly that blob,
// §5), is raw bytes, and its holder clears them.
//
//   epoch keys:   K_x[e] = HKDF(S[e], LABELS.epochX ‖ field(account) ‖ u64(e))  for index, addr, blob and wrap
//   wire address: "a1:" + hex(HMAC-SHA256(K_addr[e], LABELS.blobAddress ‖ sha))
//   file key:     K_file = HKDF(K_blob[e], LABELS.blobFile ‖ sha ‖ codec)
//   chunk key:    K_chunk = HKDF(K_file, LABELS.blobChunk ‖ u32(chunk index))
// (labels.ts spells each label; field() is a u32 length and the bytes, bytes.ts)
import { LABELS } from "./labels.ts";
import { buf, bytes32, concat, hex, name, refuse, u32, u64, utf8 } from "./bytes.ts";

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const NO_SALT = new Uint8Array(0);
const hkdf = (info: Uint8Array) => ({ name: "HKDF", hash: "SHA-256", salt: NO_SALT, info });
const AES = { name: "AES-GCM", length: 256 } as const;

/** A blob codec's name, as the blob's format pins it (§3.3): lower-case letters, digits, '.', '-'; 1 to 32 bytes. */
export const CODEC = /^[a-z0-9][a-z0-9.-]{0,31}$/;
export function codecBytes(codec: unknown): Uint8Array {
  if (typeof codec !== "string" || !CODEC.test(codec)) refuse("bad_form", "a codec is a pinned name ([a-z0-9.-], 1 to 32 bytes)");
  return utf8(codec as string);
}

export type EpochKeys = Readonly<{
  n: number;
  account: string;
  /** HMAC-SHA256, sign only: blob wire addresses */
  addr: CryptoKey;
  /** HKDF, deriveBits only: blob file keys */
  blob: CryptoKey;
  /** AES-256-GCM: the index's sealed ops and the content keys stored with them */
  index: CryptoKey;
  /** AES-256-GCM: the content keys of documents and snapshots, and the inbox key pair */
  wrap: CryptoKey;
}>;

const epochInfo = (label: string, account: string, n: number) => concat(utf8(label), name(account, "the account"), u64(n));

/** One epoch's keys from its 32-byte secret S[e]. Nothing returned can give S back, and none is extractable. */
export async function deriveEpochKeys(S: Uint8Array, account: string, n: number): Promise<EpochKeys> {
  bytes32(S, "an epoch secret");
  if (!Number.isSafeInteger(n) || n < 0) refuse("bad_form", "an epoch number is an integer from 0 to 2^53 - 1");
  const base = await subtle().importKey("raw", buf(S), "HKDF", false, ["deriveKey", "deriveBits"]);
  const aes = (label: string) => subtle().deriveKey(hkdf(epochInfo(label, account, n)), base, AES, false, ["encrypt", "decrypt"]);
  const addr = await subtle().deriveKey(hkdf(epochInfo(LABELS.epochAddr, account, n)), base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
  // (WebCrypto derives no HKDF key directly: the bits, imported as one that isn't extractable, then cleared)
  const bits = new Uint8Array(await subtle().deriveBits(hkdf(epochInfo(LABELS.epochBlob, account, n)), base, 256));
  let blob: CryptoKey;
  try { blob = await subtle().importKey("raw", bits, "HKDF", false, ["deriveBits"]); } finally { bits.fill(0); }
  return Object.freeze({ n, account, addr, blob, index: await aes(LABELS.epochIndex), wrap: await aes(LABELS.epochWrap) });
}

/** A blob's address on the wire (§3.3), from its plaintext SHA-256: "a1:" and 64 hex digits. */
export async function wireAddress(addr: CryptoKey, sha: Uint8Array): Promise<string> {
  const mac = await subtle().sign("HMAC", addr, concat(utf8(LABELS.blobAddress), bytes32(sha, "a blob's SHA-256")));
  return "a1:" + hex(new Uint8Array(mac));
}
export const ADDRESS = /^a1:[0-9a-f]{64}$/;

/** A blob's file key: 32 raw bytes, which open that blob and nothing else (the caller clears them when done). */
export async function fileKey(blob: CryptoKey, sha: Uint8Array, codec: string): Promise<Uint8Array> {
  const info = concat(utf8(LABELS.blobFile), bytes32(sha, "a blob's SHA-256"), codecBytes(codec));
  return new Uint8Array(await subtle().deriveBits(hkdf(info), blob, 256));
}

/** The key of one chunk of a blob (AES-256-GCM, not extractable), used for that chunk's bytes only. */
export async function chunkKey(kFile: Uint8Array, index: number): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", buf(bytes32(kFile, "a file key")), "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(hkdf(concat(utf8(LABELS.blobChunk), u32(index))), base, AES, false, ["encrypt", "decrypt"]);
}
