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
import { OP_REFS_MAX, opEpoch, opHash, openIndexOp, sealIndexOp, signIndexOp, verifyIndexOp, type OpRelease } from "./e2e/index-op.ts";
import type { EpochKeys } from "./e2e/keys.ts";
import type { WireOp } from "./sync-outbox";
import { RELEASE_OP as RELEASE, refsOf } from "./sync-refs";
import { DOC_KEY_OP, bytesOf, isDocKeyForm, type DocKeyVerdict } from "./sync-dockeys";
import { unwrapDocCek } from "./e2e/doc-cek.ts";

/** The key chain as this device last verified it: what a sealed op commits to, and what pull checks one against. Every
 * position is the chain's ABSOLUTE seq (its base plus the head's index), and anything about a head this verified chain
 * doesn't hold is unknown (null), never ordered or guessed. */
export interface ChainView {
  /** the chain's head (unpadded base64url SHA-256) and its generation */
  readonly head: string;
  readonly generation: string;
  /** the account's current epoch at that head */
  readonly currentEpoch: number;
  /** a head's absolute position in this chain, or null if this chain doesn't hold it */
  position(head: string): number | null;
  /** a device's Ed25519 key if it was a current device at that head (added at or before it, not removed by it) */
  signerAt(head: string, id: string): Uint8Array | null;
  /** the epoch current at that head */
  epochAt(head: string): number | null;
  /** a device as this chain knows it (absolute positions), or null for a device it never had */
  device(id: string): { added: number; removed: number | null } | null;
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
  releases: OpRelease[];
  signer: string;
  sig: string;
};

/** (the references an op declares, and the release op's name: sync-refs.ts, which the page has without this module) */
export { refsOf, RELEASE };
/** A release op as this device makes it. */
export const releaseOp = (dseq: number, t: number, by: string, releases: readonly OpRelease[]): WireOp =>
  ({ dseq, t, by, op: RELEASE, path: "/", kind: "folder", releases: releases.map((r) => ({ address: r.address, add: r.add })) });
/** Whether an opened op is exactly a release op's form: those fields, no others (no content, nothing it could change). */
export function isReleaseForm(op: Record<string, unknown>): boolean {
  return Object.keys(op).sort().join(",") === "by,dseq,kind,op,path,releases,t" && op.op === RELEASE && op.path === "/" && op.kind === "folder" && Array.isArray(op.releases) && (op.releases as unknown[]).length > 0;
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

// ---- pull (e2e PR 5c, its pull half): every sealed op verified, in the log's order, before it is applied

/**
 * What pull has verified so far, kept with the cursor (in the same transaction): the floor, the largest chain position
 * of any op verified in this log (heads only move forward in an honest log, since the server accepts an op only at the
 * chain's current head), with the chain generation it was taken under; and each sync device's newest verified envelope
 * (its dseq and hash), the per-device envelope chain's last link.
 */
export type PullState = Readonly<{ seq: number; floor: number; chainGen: string | null; devices: Readonly<Record<string, { dseq: number; hash: string }>> }>;
/** (`seq`: the last op verified, so one read again from an earlier cursor, as an echo's match, isn't verified twice) */
export const PULL_START: PullState = Object.freeze({ seq: 0, floor: -1, chainGen: null, devices: Object.freeze({}) });

/** A sealed op that doesn't verify: pull stops there (deterministically, for every device reading the same log against
 * the same verified chain), nothing from it on applied. */
export class SealedHalt extends Error {
  constructor(readonly seq: number, readonly why: string) { super(`sync: the server's sealed op ${seq} doesn't verify: ${why}`); }
}

const REF = /^(?:a1:)?[0-9a-f]{64}$/;
const ENV_B64_MAX = Math.ceil((64 << 10) / 3) * 4;
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameReleases = (a: readonly OpRelease[], b: readonly OpRelease[]) => a.length === b.length && a.every((x, i) => x.address === b[i].address && x.add === b[i].add);

/**
 * Verify one served sealed op (a log row with its signed values) and open it, after `st`:
 * 1. its head is in this device's verified chain (read again once if not), under that chain's generation;
 * 2. that head is at or after the floor (no op authorized at a head the log has already passed);
 * 3. its signer was a current device at that head, and signed exactly this op (sealedOpMessage);
 * 4. its envelope's epoch is the one current at that head;
 * 5. its dseq is past its device's last verified one;
 * 6. it opens under that epoch's index key at its place, naming its device's previous verified envelope (none for the
 *    device's first in this sync generation) and exactly its visible references, which are the op's own (refsOf).
 * A document key declaration (sync-dockeys.ts) is exactly its form, and its keyEpoch no newer than its head's epoch;
 * one of its head's epoch is unwrapped here, under that epoch's K_wrap, and is eligible if its wrap opens (an older
 * one is never unwrapped, and never eligible). The verdict goes with the op, never into it, and is never stored.
 * Returns the op and the state after it; any failure is a SealedHalt.
 */
export async function verifyRow(keys: OpKeys, syncGeneration: number, row: Record<string, unknown>, st: PullState): Promise<{ op: WireOp; state: PullState; docKey?: DocKeyVerdict }> {
  const seq = Number.isSafeInteger(row.seq) ? (row.seq as number) : -1;
  const halt = (why: string): never => { throw new SealedHalt(seq, why); };
  const str = (k: string) => (typeof row[k] === "string" ? (row[k] as string) : halt(`no ${k}`));
  const env64 = str("env"), head = str("head"), chainGen = str("chain_gen"), device = str("device"), signer = str("signer"), sig = str("sig");
  const dseq = row.dseq;
  if (!Number.isSafeInteger(dseq) || (dseq as number) < 1) halt("a dseq that isn't one");
  // (the reference lists as the server takes them: blob references, at most REFS_MAX, none twice; anything else halts here,
  // never later as another error out of the signature's bytes)
  const list = (k: string) => {
    const x = row[k] ?? [];
    if (!Array.isArray(x) || !x.every((r) => typeof r === "string" && REF.test(r))) halt(`${k} that aren't blob references`);
    if ((x as string[]).length > OP_REFS_MAX) halt(`more ${k} than an op may have`);
    if (new Set(x as string[]).size !== (x as string[]).length) halt(`${k} naming a reference twice`);
    // (a copy, taken before any await: the served row can't change what is checked and signed)
    return [...(x as string[])];
  };
  // (releases: { address, add } each, an add seq from 1, at most REFS_MAX, no add twice; copies of exactly those fields)
  const releaseList = () => {
    const x = row.releases ?? [];
    if (!Array.isArray(x)) halt("releases that aren't a list");
    if ((x as unknown[]).length > OP_REFS_MAX) halt("more releases than an op may have");
    const out: OpRelease[] = [], seen = new Set<string>();
    for (const r of x as unknown[]) {
      const ok = !!r && typeof r === "object" && !Array.isArray(r) && Object.keys(r).sort().join(",") === "add,address";
      const { address, add } = (ok ? r : {}) as { address?: unknown; add?: unknown };
      if (!ok || typeof address !== "string" || !REF.test(address) || !Number.isSafeInteger(add) || (add as number) < 1) halt("releases that aren't { address, add }");
      const k = `${address}:${add}`;
      if (seen.has(k)) halt("releases naming one add twice");
      seen.add(k);
      out.push({ address: address as string, add: add as number });
    }
    return out;
  };
  const adds = list("adds"), releases = releaseList();
  let env: Uint8Array;
  try {
    if (env64.length > ENV_B64_MAX) throw new Error("too long");
    env = Uint8Array.from(atob(env64), (c) => c.charCodeAt(0));
  } catch {
    return halt("an envelope that isn't one");
  }
  // (1) the head, in this device's verified chain: read again once when it isn't there yet (a chain newer than ours)
  let chain = await keys.chain();
  let p = chain.position(head);
  if (p === null) {
    chain = await keys.chain(true);
    p = chain.position(head);
  }
  if (p === null) halt("authorized at a head this device's verified chain doesn't hold");
  if (chainGen !== chain.generation) halt("sealed under another chain generation");
  // (2) the floor
  if (p! < st.floor) halt("authorized at a head before one the log has already passed");
  // (3) the signer, current at that head, and the signature over exactly this op
  const key = chain.signerAt(head, signer);
  if (!key) halt(chain.device(signer) ? "its signer wasn't a current device at that head" : "its signer was never a device of this chain");
  const ctx = { account: keys.account, syncGeneration, chainGeneration: chainGen, head, device, dseq: dseq as number, adds, releases, signer };
  // (verifyIndexOp refuses, as an error, what has no signed form: one that escaped here would end the connection, not
  // halt it, so every refusal of the row's form is this op's halt)
  let signedOk = false;
  try {
    signedOk = await verifyIndexOp(key!, ctx, env, sig);
  } catch {
    halt("values with no signed form");
  }
  if (!signedOk) halt("a signature that doesn't verify");
  // (4) the epoch
  let n: number;
  try {
    n = opEpoch(env);
  } catch {
    return halt("an envelope that isn't one");
  }
  if (n !== chain.epochAt(head)) halt("sealed under another epoch than its head's");
  // (5) the device's order
  const before = st.devices[device];
  if (before && (dseq as number) <= before.dseq) halt("a dseq not past its device's last");
  // (6) opened, chained, and its references its own
  let epoch = await keys.epochKeys(n);
  if (!epoch) {
    await keys.chain(true);
    epoch = await keys.epochKeys(n);
  }
  if (!epoch) halt("an epoch whose keys this device doesn't hold");
  let op: WireOp;
  try {
    op = (await openIndexOp(epoch!, { device, dseq: dseq as number }, env, { prev: before ? fromB64url(before.hash) : null, adds, releases })) as WireOp;
  } catch {
    return halt("it doesn't open at its place, after its device's previous envelope, with its references");
  }
  if (!op || typeof op !== "object" || Array.isArray(op) || op.dseq !== dseq) halt("an op that isn't its own");
  // (the opened op is untrusted too: its references read and compared under the halt, so nothing it holds escapes as
  // another error)
  let refsMatch = false;
  try {
    const own = refsOf(op);
    refsMatch = sameList(own.adds, adds) && sameReleases(own.releases, releases);
  } catch {
    halt("an op whose references can't be read");
  }
  if (!refsMatch) halt("visible references that aren't its op's");
  // (a release op is exactly its form: no content, nothing else it could change; e2e PR 5d)
  if (op.op === RELEASE && !isReleaseForm(op as unknown as Record<string, unknown>)) halt("a release op that isn't only a release");
  // (a document key declaration: exactly its form (an `eligible` it claims is one more field, and halts), under no
  // epoch its head doesn't have; eligible only under its head's epoch and only if its wrap opens there)
  let docKey: DocKeyVerdict | undefined;
  if (op.op === DOC_KEY_OP) {
    const d = op as unknown as Record<string, unknown>;
    if (!isDocKeyForm(d)) halt("a doc-key op that isn't only a declaration");
    const ke = d.keyEpoch as number;
    if (ke > n) halt("a declaration under an epoch its head doesn't have");
    let eligible = false;
    if (ke === n) {
      try {
        await unwrapDocCek(epoch!, { account: keys.account, document: d.document as string, cekId: d.cekId as string, keyEpoch: ke }, bytesOf(d.wrappedCek as string));
        eligible = true;
      } catch {
        eligible = false;
      }
    }
    docKey = Object.freeze({ eligible, head });
  }
  const hash = b64url(await opHash(env));
  return { op, state: Object.freeze({ seq, floor: p!, chainGen: chain.generation, devices: Object.freeze({ ...st.devices, [device]: { dseq: dseq as number, hash } }) }), ...(docKey ? { docKey } : {}) };
}
