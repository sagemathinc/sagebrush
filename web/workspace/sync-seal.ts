// Index ops sealed at send time (design/e2e-encryption.md §4, §4.1; e2e PR 5c, its send half). Opt-in: the sync
// client uses this only when it is given a key provider (OpKeys), which no page gives yet; until PR 2's page side
// exists the provider is a fixture.
//
// An outbox record stays the plaintext op it was made as. The first time it is about to go up, it is sealed
// (e2e/index-op.ts, under the current epoch's K_index, at its sync device and dseq) and signed (the server's own
// signed bytes, sealed-op.mjs), and that sealed form is written beside it before the message leaves (sync-outbox.ts):
// every resend sends those exact bytes until the server decides the dseq, so an answer that was lost can't leave the
// device believing in bytes the log doesn't hold.
//
// The per-device envelope chain: each envelope seals the SHA-256 of this device's previous ACCEPTED envelope (null for
// its first in this sync generation). Within one message, an op's prev is the envelope just before it in that
// message. The server ends a message at its first refusal and answers the rest `undecided`, so a refused envelope
// never has a successor in the log; the undecided ones are sealed again after the accepted one.
import { opHash, sealIndexOp, signIndexOp } from "./e2e/index-op.ts";
import type { EpochKeys } from "./e2e/keys.ts";
import type { WireOp } from "./sync-outbox";

/** The key chain as this device last verified it: what a sealed op commits to. */
export interface ChainView {
  /** the chain's head (unpadded base64url SHA-256) and its generation */
  readonly head: string;
  readonly generation: string;
  /** the account's current epoch at that head */
  readonly currentEpoch: number;
}
/** What the sync client needs to seal and sign: the E2E account, this device's signer, the chain and epoch keys. */
export interface OpKeys {
  /** the E2E account id (the key chain's) */
  readonly account: string;
  /** this device's E2E signer: its id in the chain and a signature over bytes (64 bytes) */
  readonly device: { readonly id: string; sign(bytes: Uint8Array): Promise<Uint8Array> };
  /** the latest verified chain; `refresh` asks for a newer one first (after the server says the head moved) */
  chain(refresh?: boolean): Promise<ChainView>;
  /** an epoch's keys (deriveEpochKeys's), or null if this device doesn't hold them */
  epochKeys(n: number): Promise<EpochKeys | null>;
}

/** A record's sealed form, kept with it until the server decides its dseq: the exact bytes that go up. */
export type Sealed = {
  dseq: number;
  /** the envelope, base64 (the wire's form) */
  env: string;
  /** its SHA-256, unpadded base64url: what the ack names, and the next envelope's prev */
  envHash: string;
  head: string;
  chainGen: string;
  adds: string[];
  /** each the add it ends: the blob's address and the seq of the accepted op whose adds named it */
  releases: { address: string; add: number }[];
  signer: string;
  sig: string;
};

/**
 * The blob references an op declares in the clear (the server counts them): as today's plaintext log counts them, a
 * data file's op adds a reference to the blob it names. Nothing is released yet: retention and Trash become explicit
 * ops that release (e2e PR 5d); until then the server holds every blob a sealed op adds, as it does for plaintext ops.
 */
export function refsOf(op: WireOp): { adds: string[]; releases: { address: string; add: number }[] } {
  return { adds: op.kind === "file" && op.sha256 !== undefined ? [op.sha256] : [], releases: [] };
}

const b64 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const b64url = (b: Uint8Array): string => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** A device's previous accepted envelope's hash, as an envelope seals it (null: none yet in this generation). */
export type Prev = string | null;

/**
 * Seal and sign `ops` (consecutive records of this device, in dseq order) after `prev`: each op's prev is the one
 * before it. `syncGeneration` and `syncDevice` are the namespace's (welcome's generation, this device's sync id).
 */
export async function sealOps(keys: OpKeys, syncGeneration: number, syncDevice: string, ops: readonly WireOp[], prev: Prev): Promise<Sealed[]> {
  const chain = await keys.chain();
  const epoch = await keys.epochKeys(chain.currentEpoch);
  if (!epoch) throw new Error("sync: this device doesn't hold the current epoch's keys");
  const out: Sealed[] = [];
  let before = prev;
  for (const op of ops) {
    const { adds, releases } = refsOf(op);
    const env = await sealIndexOp(epoch, { device: syncDevice, dseq: op.dseq }, op, { prev: before === null ? null : fromB64url(before), adds, releases });
    const ctx = {
      account: keys.account, syncGeneration, chainGeneration: chain.generation, head: chain.head, device: syncDevice, dseq: op.dseq,
      adds, releases, signer: keys.device.id,
    };
    const sig = await signIndexOp({ sign: (b) => keys.device.sign(b) }, ctx, env);
    const envHash = b64url(await opHash(env));
    out.push({ dseq: op.dseq, env: b64(env), envHash, head: chain.head, chainGen: chain.generation, adds, releases, signer: keys.device.id, sig });
    before = envHash;
  }
  return out;
}

/** A sealed record as the `sops` message carries it. */
export const sopsItem = (s: Sealed) =>
  ({ dseq: s.dseq, head: s.head, chain_gen: s.chainGen, env: s.env, adds: s.adds, releases: s.releases, signer: s.signer, sig: s.sig });

/** An envelope's hash from its wire form (base64), as the ack and the echo name it. */
export async function envHashOf(envB64: string): Promise<string> {
  const bin = atob(envB64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
