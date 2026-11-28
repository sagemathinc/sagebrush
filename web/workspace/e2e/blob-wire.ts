// A file's bytes as an end-to-end sync client sends them (e2e PR 3b-2; design/e2e-encryption.md §3.3; plan notes
// e2e-pr3b2-sealed-blobs-plan): sealBlob's header and chunks in one pinned frame, at the file's keyed address.
//   "SBB1" ‖ u32 n ‖ n bytes of canonical JSON {"codec","compressedLength","plaintextLength"} ‖ the chunks
// Each chunk's length follows from compressedLength (a full CHUNK, the last the rest, each plus its TAG). The account
// and the address aren't in the frame: both are bound in every chunk's AAD (chunks.ts blobHead), and the opener gives
// them from its own context (its epoch's account, the entry's address), never from the bytes it was served.
// A file is sealed under one epoch, and its address is that epoch's: the caller keeps both with the op that names it.
import { CHUNK, TAG, chunkCount, openBlob, sealBlob, type BlobHeader, type Limits } from "./chunks.ts";
import { pinnedCodec } from "./codecs.ts";
import { concat, hex, refuse, u32, utf8 } from "./bytes.ts";
import { fileKey, mintedEpoch, wireAddress, type EpochKeys } from "./keys.ts";

/** The frame's first bytes. */
export const MAGIC = "SBB1";
/** The codec this build seals files with: store.1 (codecs.ts), so a frame's size follows from the file's. */
export const FILE_CODEC = "store.1";
// (a header's JSON is short: its three fields, with numbers at most 2^53)
const HEAD_MAX = 128;

const headOf = (codec: string, compressedLength: number, plaintextLength: number) => JSON.stringify({ codec, compressedLength, plaintextLength });
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));

/** The exact length of a file's frame, from the file's length: what a download is checked against before it is read. */
export function sealedSize(plaintextLength: number): number {
  if (!Number.isSafeInteger(plaintextLength) || plaintextLength < 0) refuse("bad_form", "a file's length is a non-negative integer");
  // (store.1: the compressed bytes are the plaintext)
  const compressed = plaintextLength;
  return MAGIC.length + 4 + utf8(headOf(FILE_CODEC, compressed, plaintextLength)).length + compressed + chunkCount(compressed) * TAG;
}

/** A file's address under `keys`' epoch, from its plaintext SHA-256 (32 bytes). */
export function addressOf(keys: EpochKeys, sha: Uint8Array): Promise<string> {
  return wireAddress(mintedEpoch(keys).addr, sha);
}

/** Seal a file (its plaintext and its SHA-256) under `keys`' epoch: its address, the frame, and the frame's SHA-256. */
export async function sealFile(keys: EpochKeys, sha: Uint8Array, plaintext: Uint8Array): Promise<{ address: string; body: Uint8Array; ctSha256: string }> {
  const { header, chunks } = await sealBlob(keys, sha, plaintext, FILE_CODEC);
  const head = utf8(headOf(header.codec, header.compressedLength, header.plaintextLength));
  const body = concat(utf8(MAGIC), u32(head.length), head, ...chunks);
  return { address: header.address, body, ctSha256: hex(await sha256(body)) };
}

/**
 * Open a frame served for the file whose plaintext SHA-256 is `sha`, at `address`, under `keys`' epoch: the frame's
 * form, its header (a pinned codec, lengths that are the frame's own), the address (the file's under this epoch),
 * every chunk authenticated, and the plaintext's SHA-256 the file's. Anything else is refused (bad_form, or limit past
 * `limits`), and nothing of it is returned.
 */
export async function openFile(keys: EpochKeys, sha: Uint8Array, address: string, body: Uint8Array, limits: Limits): Promise<Uint8Array> {
  const epoch = mintedEpoch(keys);
  if (!(body instanceof Uint8Array) || body.length < MAGIC.length + 4) refuse("bad_form", "not a sealed file's frame");
  if (new TextDecoder().decode(body.subarray(0, MAGIC.length)) !== MAGIC) refuse("bad_form", "not a sealed file's frame");
  const n = new DataView(body.buffer, body.byteOffset + MAGIC.length, 4).getUint32(0);
  if (n > HEAD_MAX || body.length < MAGIC.length + 4 + n) refuse("bad_form", "a sealed file's header isn't its frame's");
  // (the header's bytes as they are: a byte-order mark kept, so it fails the canonical check; invalid UTF-8 is bad_form)
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body.subarray(MAGIC.length + 4, MAGIC.length + 4 + n));
  } catch {
    return refuse("bad_form", "a sealed file's header isn't UTF-8");
  }
  let h: { codec?: unknown; compressedLength?: unknown; plaintextLength?: unknown };
  try {
    h = JSON.parse(text);
  } catch {
    return refuse("bad_form", "a sealed file's header isn't JSON");
  }
  if (!h || typeof h !== "object" || Array.isArray(h) || Object.keys(h).join(",") !== "codec,compressedLength,plaintextLength") refuse("bad_form", "a sealed file's header isn't its three fields");
  const { codec, compressedLength, plaintextLength } = h as { codec: string; compressedLength: number; plaintextLength: number };
  const pinned = pinnedCodec(codec);
  if (!Number.isSafeInteger(compressedLength) || compressedLength < 0 || !Number.isSafeInteger(plaintextLength) || plaintextLength < 0) refuse("bad_form", "a sealed file's lengths");
  // (store.1, the one codec files are sealed with: the compressed bytes are the plaintext; and no file past what this
  // device opens is read further)
  if (codec !== FILE_CODEC || compressedLength !== plaintextLength) refuse("bad_form", "a sealed file's codec and lengths aren't store.1's");
  if (plaintextLength > limits.maxPlaintext) refuse("limit", "the file is larger than this device opens");
  // (canonical: the header is exactly what sealFile writes for those fields)
  if (headOf(codec, compressedLength, plaintextLength) !== text) refuse("bad_form", "a sealed file's header isn't canonical");
  const count = chunkCount(compressedLength), start = MAGIC.length + 4 + n;
  if (body.length !== start + compressedLength + count * TAG) refuse("bad_form", "a sealed file's frame isn't its header's length");
  if (address !== (await wireAddress(epoch.addr, sha))) refuse("bad_form", "not this file's address under this epoch");
  const header: BlobHeader = Object.freeze({ account: epoch.account, address, codec, plaintextLength, compressedLength });
  const chunks: Uint8Array[] = [];
  for (let i = 0, at = start; i < count; i++) {
    const len = (i < count - 1 ? CHUNK : compressedLength - CHUNK * (count - 1)) + TAG;
    chunks.push(body.subarray(at, at + len));
    at += len;
  }
  const kFile = await fileKey(epoch.blobKey, sha, codec);
  let plain: Uint8Array;
  try {
    plain = await openBlob(kFile, header, chunks, pinned.inflate, limits);
  } finally {
    kFile.fill(0);
  }
  const got = await sha256(plain);
  if (got.length !== sha.length || got.some((x, i) => x !== sha[i])) {
    plain.fill(0);
    refuse("bad_form", "the opened bytes aren't the file the index names");
  }
  return plain;
}
