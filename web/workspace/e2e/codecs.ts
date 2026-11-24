// The blob codecs this build seals with (design: e2e-encryption.md §3.3: the codec is pinned and is part of the blob's
// format). A name here is a promise that its deflate gives the same bytes for the same input in every engine and every
// release that carries the name: blob chunks use a zero nonce under a key derived from (epoch, sha, codec), so a codec
// that gave other bytes for one file would reuse a key and nonce. So sealBlob takes a codec's name, looks it up here
// and nowhere else, and the registry is frozen: a caller can't hand it an implementation.
//
// "store.1" stores the bytes as they are (deterministic by construction). A compressing codec joins this table with
// its own vendored implementation, and test-e2e-crypto.mjs admits no name without its determinism row (which must also
// show sealBlob's header keeping the plaintext and compressed lengths apart: store.1's are equal).
import { refuse } from "./bytes.ts";

export type PinnedCodec = Readonly<{
  name: string;
  /** the compressed bytes: a new buffer, never the input */
  deflate(plaintext: Uint8Array): Uint8Array;
  /** the plaintext back: a new buffer, at most maxOut bytes (limit past that) */
  inflate(compressed: Uint8Array, maxOut: number): Uint8Array;
}>;

const store: PinnedCodec = Object.freeze({
  name: "store.1",
  deflate: (plaintext: Uint8Array) => plaintext.slice(),
  inflate(compressed: Uint8Array, maxOut: number) {
    if (compressed.length > maxOut) refuse("limit", "the stored bytes are longer than allowed");
    return compressed.slice();
  },
});

export const CODECS: Readonly<Record<string, PinnedCodec>> = Object.freeze({ [store.name]: store });

/** The pinned codec of that name; any other name is refused (bad_form). */
export function pinnedCodec(name: unknown): PinnedCodec {
  if (typeof name !== "string" || !Object.hasOwn(CODECS, name)) refuse("bad_form", "not a codec this build pins");
  return CODECS[name as string];
}
