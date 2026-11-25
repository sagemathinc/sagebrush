// One index op, sealed and signed (design: e2e-encryption.md §4 and §4.1; the server's side is sealed-op.mjs and
// web/sync/account.ts's sealedOps). Not used by the page yet.
//
//   env = 0x01 ‖ u64(epoch) ‖ seal id (32) ‖ the one chunk sealObject made (ciphertext and its 16-byte tag)
//   the chunk seals, under K_index[epoch], kind "index-op", object = the sync device, version = its dseq, codec store.1:
//     canon({ op, prev, adds, releases })
//
// `op` is the plaintext op (the library doesn't look inside it); `prev` is the SHA-256 of the same device's previous
// envelope (null for a device's first op), so a device's own ops form a chain no server can reorder or drop from the
// middle of without its next op failing to open as expected; `adds` and `releases` are the blob references the op
// declares in the clear, committed again inside the ciphertext so that the visible lists can't differ from the sealed
// ones. Every byte of env is then covered by the signature (sealedOpMessage binds its SHA-256 with the account, both
// generations, the key chain's head, the device, the dseq, the visible references and the signer).
//
// The layout is fixed and binary rather than canonical JSON: every field has one length and one spelling, so env has
// exactly one encoding, and the whole 64 KiB the server allows goes to the op rather than to base64. Opening refuses
// (bad_form) anything that isn't exactly this: another version byte, another epoch than the keys', a cut-short env,
// a chunk that doesn't open under this account, device and dseq, non-canonical plaintext, or a plaintext whose prev,
// adds or releases aren't the expected ones.
import { fleetCore } from "../fleet/install.ts";
import { sealedOpMessage } from "./sealed-op.mjs";
import { mintedEpoch } from "./keys.ts";
import type { EpochKeys } from "./keys.ts";
import { pinnedCodec } from "./codecs.ts";
import { KINDS, TAG, openObject, sealObject } from "./chunks.ts";
import type { ObjectHeader } from "./chunks.ts";
import { concat, refuse, u64 } from "./bytes.ts";

/** The envelope's version byte, and its largest size (the server's LIMITS.sealedOpBytes: test-e2e-index-op checks). */
export const OP_ENV_VERSION = 1;
export const OP_ENV_MAX = 64 << 10;
const SEAL_ID = 32;
const HEAD = 1 + 8 + SEAL_ID;
/** The largest canonical plaintext an envelope carries. */
export const OP_PLAINTEXT_MAX = OP_ENV_MAX - HEAD - TAG;
/** At most this many references each way (the server's LIMITS.sealedOpRefs). */
export const OP_REFS_MAX = 64;
const KIND: (typeof KINDS)[number] = "index-op";
const CODEC = "store.1";
const REF = /^(?:a1:)?[0-9a-f]{64}$/;

/** Where an op sits in its device's sequence: the sync device's id and its dseq (from 1). */
export type OpPlace = Readonly<{ device: string; dseq: number }>;
/** What an envelope seals beside the op itself. */
export type OpCommit = Readonly<{ prev: Uint8Array | null; adds: readonly string[]; releases: readonly string[] }>;
/** What a device signs for an op: sealedOpMessage's fields, all but env. */
export type OpContext = Readonly<{
  account: string; syncGeneration: number; chainGeneration: string; head: string; device: string; dseq: number;
  adds: readonly string[]; releases: readonly string[]; signer: string;
}>;

const core = () => fleetCore();

function place(p: OpPlace): [string, string] {
  if (!Number.isSafeInteger(p?.dseq) || p.dseq < 1) refuse("bad_form", "a dseq is an integer from 1 to 2^53 - 1");
  return [p.device, String(p.dseq)];
}

// (a reference list as the server takes it: at most 64 addresses, each once. A copy, so the caller's array can't
//  change between the check and its use)
function refs(x: unknown, what: string): string[] {
  if (!Array.isArray(x) || !x.every((r) => typeof r === "string" && REF.test(r))) refuse("bad_form", `${what} is a list of blob addresses`);
  const list = [...(x as string[])];
  if (list.length > OP_REFS_MAX) refuse("limit", `at most ${OP_REFS_MAX} ${what}`);
  if (new Set(list).size !== list.length) refuse("bad_form", `${what} names an address twice`);
  return list;
}

function prevOf(prev: unknown): string | null {
  if (prev === null) return null;
  if (!(prev instanceof Uint8Array) || prev.length !== 32) refuse("bad_form", "prev is the previous envelope's 32-byte SHA-256, or null");
  return core().b64(prev as Uint8Array);
}

const header = (account: string, object: string, version: string, length: number): ObjectHeader =>
  Object.freeze({ account, kind: KIND, object, version, codec: CODEC, plaintextLength: length, compressedLength: length });

/** Seal one op under the epoch's K_index: the envelope's bytes. `keys` must be ones deriveEpochKeys made. */
export async function sealIndexOp(keys: EpochKeys, at: OpPlace, op: unknown, commit: OpCommit): Promise<Uint8Array> {
  // (the account and epoch come from what deriveEpochKeys recorded; keys is that frozen object, so keys.index is its own)
  const epoch = mintedEpoch(keys);
  const [object, version] = place(at);
  const body = { op, prev: prevOf(commit?.prev), adds: refs(commit?.adds, "adds"), releases: refs(commit?.releases, "releases") };
  // (canonText refuses what has no canonical form, bad_form, and plaintext past the envelope's room, limit)
  const pt = core().enc(core().canonText(body, OP_PLAINTEXT_MAX));
  try {
    const { sealId, chunks } = await sealObject(keys.index, header(epoch.account, object, version, pt.length), pinnedCodec(CODEC).deflate(pt));
    if (chunks.length !== 1) refuse("limit", "an op is one chunk");
    return concat(new Uint8Array([OP_ENV_VERSION]), u64(epoch.n), sealId, chunks[0]);
  } finally {
    pt.fill(0);
  }
}

/** The epoch an envelope was sealed in (to pick its keys), after its form is checked; bad_form for anything else. */
export function opEpoch(env: Uint8Array): number {
  if (!(env instanceof Uint8Array) || env.length < HEAD + TAG) refuse("bad_form", "an op envelope is at least its header and a tag");
  if (env.length > OP_ENV_MAX) refuse("limit", `an op envelope is at most ${OP_ENV_MAX} bytes`);
  if (env[0] !== OP_ENV_VERSION) refuse("bad_form", "not an op envelope of this version");
  const n = new DataView(env.buffer, env.byteOffset + 1, 8).getBigUint64(0);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) refuse("bad_form", "an epoch number is an integer from 0 to 2^53 - 1");
  return Number(n);
}

/** The SHA-256 of an envelope: the next op's `prev`. */
export const opHash = (env: Uint8Array): Promise<Uint8Array> => core().sha256(env);

/**
 * Open an envelope at its place and check what it commits to against what is expected: the previous envelope's hash,
 * and exactly the visible adds and releases (in order). The op, as sealed.
 */
export async function openIndexOp(keys: EpochKeys, at: OpPlace, env: Uint8Array, expect: OpCommit): Promise<unknown> {
  const epoch = mintedEpoch(keys);
  const [object, version] = place(at);
  const want = { prev: prevOf(expect?.prev), adds: refs(expect?.adds, "adds"), releases: refs(expect?.releases, "releases") };
  if (opEpoch(env) !== epoch.n) refuse("bad_form", "an envelope of another epoch than these keys'");
  const bytes = env.slice(); // (a copy before any await)
  const sealId = bytes.slice(1 + 8, HEAD), chunk = bytes.slice(HEAD);
  const length = chunk.length - TAG;
  const limits = { maxPlaintext: OP_PLAINTEXT_MAX, maxCompressed: OP_PLAINTEXT_MAX, maxRatio: 1 };
  const pt = await openObject(keys.index, header(epoch.account, object, version, length), { sealId, chunks: [chunk] }, pinnedCodec(CODEC).inflate, limits);
  try {
    let body: Record<string, unknown>;
    try {
      body = core().parseCanonical(pt, OP_PLAINTEXT_MAX);
    } catch {
      refuse("bad_form", "the sealed op isn't canonical JSON");
    }
    const keysOf = body! && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort().join(",") : "";
    if (keysOf !== "adds,op,prev,releases") refuse("bad_form", "the sealed op isn't { op, prev, adds, releases }");
    const same = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
    if (body!.prev !== want.prev) refuse("bad_form", "the sealed op follows another envelope than the expected one");
    if (!same(body!.adds, want.adds) || !same(body!.releases, want.releases)) refuse("bad_form", "the sealed op's references aren't the visible ones");
    return body!.op;
  } finally {
    pt.fill(0);
  }
}

// (the signed bytes for an op: sealedOpMessage, the server's own, with copies of the reference lists)
function message(ctx: OpContext, env: Uint8Array): Promise<Uint8Array> {
  if (!(env instanceof Uint8Array)) refuse("bad_form", "an op envelope is bytes");
  return sealedOpMessage({ ...ctx, adds: refs(ctx?.adds, "adds"), releases: refs(ctx?.releases, "releases"), env });
}

/** Sign an envelope in its context with a device key ({ sign(bytes) } as the fleet core's asKey makes): the sig, base64url. */
export async function signIndexOp(key: { sign(msg: Uint8Array): Promise<Uint8Array> }, ctx: OpContext, env: Uint8Array): Promise<string> {
  const sig = await key.sign(await message(ctx, env));
  return core().b64(sig);
}

/** Whether `sig` is the signature of the device whose 32-byte public key is `raw`, over the envelope in its context. */
export async function verifyIndexOp(raw: Uint8Array, ctx: OpContext, env: Uint8Array, sig: string): Promise<boolean> {
  let s: Uint8Array;
  try {
    s = core().unb64(sig, 64);
  } catch {
    return false;
  }
  return core().verifyStrict(raw, await message(ctx, env), s);
}
