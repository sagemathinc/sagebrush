// A document's checkpoints, the client's side (BH-0 server design r9, 83f3dd5a, §5.2, §5.3, §6.2, §7; the BH-0b-2
// implementation map r2, a5cccbe9, cleared by astra, daybreak2 and the grader).  Pure: no storage, no network; DocSync
// (0b-2b, 0b-2c) is what wires it.  Nothing imports it yet.
//
// - exactCut: the owner's registration rule (§5.2): a graph of exactly the server-accepted prefix through at_seq, its
//   one head the last envelope of batch at_seq.  Only chain-verified accepted batches are taken (the type says so),
//   never a local or unsent row.
// - makeCheckpoint / checkRecord: the blob, a patchflow snapshot record at cut_patch whose `hash` is checked against a
//   fresh hash of its own value (patchflow 0.16 trusts a record with no hash, or one of an unfamiliar format: map r2 C).
// - checkCheckpoint: an install's checks (§8) on the blob and the tail after it, bounded before any graph is built,
//   with the bytes it holds counted (map r2 G: peak <= 2B, retained <= B).
// - reconcile (§6.2), splitPrefix (§7): the outcome of a registration from the server's answer; a batch cut to fit the
//   rooms a `busy {checkpoint: "split"}` names.
import { PatchGraph, sameHashFormat, type DocCodec, type Patch } from "patchflow";

/** Patches in a tail at most, and its charged bytes at most (r9 §0, §3; the server's TAIL_PATCHES_CAP, TAIL_ITEM_CAP) */
export const TAIL_PATCHES_CAP = 1000;
export const TAIL_ITEM_CAP = (4 << 20) - (8 << 10);
/** (LIMITS.pullBytes, 4 MiB, less the answer's 8 KiB reserve; a test pins it to protocol.ts's LIMITS.pullBytes, so this
 * module's type-checked import closure stays its own) */
/** A checkpoint blob's bytes at most (r9 §6.4's CANDIDATE_RESERVE: the server reserves no more for one) */
export const CHECKPOINT_BLOB_MAX = 32 << 20;
/** The device's own rows an install takes into its combined graph at most (the journal's per-document debt bounds,
 * journal/rows.js SYNC_DEBT: 10,000 rows, 16 MiB; a test pins them to it) */
export const LOCAL_ROWS_MAX = 10000;
export const LOCAL_BYTES_MAX = 16 << 20;
/** Identical registration requests at most, before the outcome is UNKNOWN (r9 §6.2) */
export const REGISTER_ATTEMPTS = 3;

// ---- accepted history: only what a chain-verified pull page gave

declare const accepted: unique symbol;
/** A batch the server accepted, as a chain-verified pull page gave it: its seq and its patches in envelope order (the
 * last one is the batch's last envelope).  Made only by `acceptedBatch`, from a verified page: a local or unsent row
 * can't be one. */
export interface AcceptedBatch {
  readonly [accepted]: true;
  readonly seq: number;
  readonly patches: readonly Patch[];
  /** the batch's charged bytes (r9 §3), as the server counts them: for the install's bound */
  readonly charge: number;
}
/** An accepted batch, from an item of a page that `verifyChainPage` verified (the caller's duty: DocSync, 0b-2b) */
export function acceptedBatch(seq: number, patches: readonly Patch[], charge: number): AcceptedBatch {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("checkpoint: a batch's seq");
  if (patches.length === 0) throw new Error("checkpoint: a batch has patches");
  if (!Number.isSafeInteger(charge) || charge < 0) throw new Error("checkpoint: a batch's charge");
  return Object.freeze({ seq, patches: Object.freeze([...patches]), charge }) as AcceptedBatch;
}

// ---- the graphs this module builds: patchflow's own value caches off (astra's CK-M2)

/** patchflow 0.16 keeps, per graph, LRU caches of computed values (by default up to 2,000 and 100 values, 10 MB each)
 * besides its last few requested ones.  The graphs here are built for one decision, so their caches are sized to keep
 * nothing (an LRU of size 1 stores no document larger than one unit); what a graph still holds after a decision is
 * its current value, which `test-checkpoint.mjs` pins on astra's fixture (one value held, not 51) */
export const SCRATCH_GRAPH = { exactCacheMaxEntries: 1, exactCacheMaxSize: 1, valueCacheMaxEntries: 1, valueCacheMaxSize: 1 } as const;
export const scratchGraph = (codec: DocCodec) => new PatchGraph({ codec, ...SCRATCH_GRAPH });

// ---- the exact cut (r9 §5.2)

export type CutWhy = "missing" | "last" | "divergent" | "heads" | "incomplete";
/**
 * The graph of exactly the accepted prefix through `at_seq`, if `cut_patch` is a clean, exact cut of it: the last
 * envelope of batch at_seq, and the graph's ONE head.  `base` is the previous checkpoint's record, when the prefix
 * starts after it (its batches are then base.at_seq + 1 on).  Batches after at_seq are not looked at.
 * - "missing": a batch of the prefix isn't given (they must be every seq from the start, in order);
 * - "last": cut_patch isn't the last envelope of batch at_seq;
 * - "divergent": more than one head (it waits for patchflow's own merge commit; nothing is invented);
 * - "heads": one head, but not cut_patch;
 * - "incomplete": the graph can't give an exact value (needsMoreHistory or valueUnavailable).
 */
export function exactCut(
  codec: DocCodec,
  batches: readonly AcceptedBatch[],
  at_seq: number,
  cut_patch: string,
  base?: { at_seq: number; record: Patch },
): { ok: true; graph: PatchGraph } | { ok: false; why: CutWhy } {
  const first = base ? base.at_seq + 1 : 1;
  const prefix = batches.filter((b) => b.seq >= first && b.seq <= at_seq);
  if (prefix.length !== at_seq - first + 1 || prefix.some((b, i) => b.seq !== first + i)) return { ok: false, why: "missing" };
  const last = prefix[prefix.length - 1];
  if (!last || last.patches[last.patches.length - 1].time !== cut_patch) return { ok: false, why: "last" };
  const graph = scratchGraph(codec);
  if (base) graph.add([base.record]);
  for (const b of prefix) graph.add([...b.patches]);
  const heads = graph.getHeads();
  if (heads.length > 1) return { ok: false, why: "divergent" };
  if (heads.length !== 1 || heads[0] !== cut_patch) return { ok: false, why: "heads" };
  if (graph.needsMoreHistory() || graph.valueUnavailable()) return { ok: false, why: "incomplete" };
  return { ok: true, graph };
}

// ---- the record and its hash

/** patchflow's PatchId (protocol.ts PATCH_ID): 11 base-36 characters of time, "_", the client's id */
const PATCH_ID = /^[0-9a-z]{11}_[0-9A-Za-z_-]{1,64}$/;
/** A checkpoint record: patchflow's snapshot of the value at cut_patch, its causal fields (time, parents) kept */
export type CheckpointRecord = Patch & { isSnapshot: true; snapshot: string; hash: string };
/** Whether `record` is a snapshot whose hash is exactly a fresh hash of its own value (map r2 C): a string of the
 * codec's format AND equal to it.  A missing hash, another format, another value or text that doesn't decode: false. */
export function checkRecord(codec: DocCodec, record: unknown): record is CheckpointRecord {
  const r = record as Partial<CheckpointRecord> | null;
  if (!r || typeof r !== "object" || r.isSnapshot !== true || typeof r.snapshot !== "string" || !PATCH_ID.test(String(r.time))) return false;
  // (its causal fields, exactly: parents a list of distinct patch ids, none the record itself; no change carried (the
  // value replaces it), so patchflow's own add() takes it as a snapshot and nothing else)
  const parents = (r as { parents?: unknown }).parents;
  if (!Array.isArray(parents) || parents.length > 8 || !parents.every((x) => PATCH_ID.test(String(x)) && typeof x === "string") || new Set(parents).size !== parents.length || parents.includes(r.time)) return false;
  if ("patch" in r || "mergePatch" in r || "mergeParent" in r) return false;
  if (typeof r.hash !== "string") return false;
  let actual: string;
  try {
    actual = scratchGraph(codec).hashOf(codec.fromString(r.snapshot));
  } catch {
    return false;
  }
  return sameHashFormat(r.hash, actual) && r.hash === actual;
}
/** The blob of a checkpoint at cut_patch, from the graph exactCut gave: the record's JSON, UTF-8, with its sha256 and
 * bytes.  The record is checked again before it is returned. */
export async function makeCheckpoint(codec: DocCodec, graph: PatchGraph, cut_patch: string): Promise<{ record: CheckpointRecord; blob: Uint8Array; sha256: string; bytes: number }> {
  const p = graph.getPatch(cut_patch);
  if (!p) throw new Error("checkpoint: cut_patch isn't in the graph");
  const value = graph.value({ time: cut_patch });
  // (the patch's own fields but its change: the causal fields kept (astra), the value in its place)
  const { patch: _patch, mergePatch: _mergePatch, isSnapshot: _s, snapshot: _t, hash: _h, ...fields } = p;
  const record: CheckpointRecord = { ...fields, parents: [...(p.parents ?? [])], isSnapshot: true, snapshot: codec.toString(value), hash: graph.hashOf(value) };
  if (!checkRecord(codec, record)) throw new Error("checkpoint: the record's hash isn't its value's");
  const blob = new TextEncoder().encode(JSON.stringify(record));
  if (blob.length > CHECKPOINT_BLOB_MAX) throw new Error("checkpoint: over the blob's maximum");
  return { record, blob, sha256: await sha256Hex(blob), bytes: blob.length };
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

// ---- an install's checks (r9 §5.2, §8; map r2 A, B, C, G)

/** A checkpoint descriptor, as `pull {start: "snapshot"}` gives it (r9 §5.1) */
export interface Descriptor { epoch: number; at_seq: number; recv_at: number; chain_at: string; cut_patch: string; sha256: string; bytes: number }
/** The bytes an install holds, counted by owner (map r2 G): each copy it has is set, by name, to the bytes it holds
 * now (a copy that grows is set again, not added to), and dropped when it is let go */
export class Ledger {
  private held = new Map<string, number>();
  peak = 0;
  set(name: string, bytes: number) { this.held.set(name, bytes); this.peak = Math.max(this.peak, this.total()); }
  drop(name: string) { this.held.delete(name); }
  total() { let n = 0; for (const v of this.held.values()) n += v; return n; }
}
export type InstallWhy = "bounds" | "local" | "digest" | "record" | "cut" | "tail" | "needs_more_history";
/** A patch's canonical decoded charge: its JSON's UTF-8 bytes (what the graph holds of it, logically) */
const patchBytes = (p: Patch) => utf8Length(JSON.stringify(p));
/**
 * Whether a checkpoint blob and the verified tail after it make a usable base (§8).  A decision only: the graph it is
 * made on is released before it returns (the install, 0b-2c, writes the record and the tail and opens the document as
 * any open does).
 * - Bounded first, before anything is decoded or built: the blob's bytes the descriptor's and <= its maximum; the
 *   tail's PATCHES (summed over its batches, as the server's cap counts them) and charge within the cap; the device's
 *   own rows within the journal's debt bounds (a row that can't be measured: refused, `local`).
 * - Then: the blob's sha256; the record a snapshot whose causal shape is exact and whose hash is exactly its value's,
 *   at exactly cut_patch; the tail contiguous from at_seq + 1.
 * - Then the combined graph (the record, the tail, and `local`: this device's own rows, astra) must give an exact value
 *   (needsMoreHistory and valueUnavailable false).  Anything thrown is a refusal, never an exception.
 * The bytes held (map r2 G, as amended): B = the blob + the tail's charge + the local rows' bytes; the incoming copy is
 * B; the one working copy (the decoded record, then the graph's patches) grows by what is added, to at most B; and the
 * graph's computed values, its caches off (SCRATCH_GRAPH), are its current value, V bytes (its canonical text; V <= B:
 * a value is the snapshot plus what the patches carry).  So peak <= 2B + V <= 3B, which the module itself checks; on
 * return nothing is held.  `head` is the hash of the value the device would show (for the caller and the tests).
 */
export async function checkCheckpoint(
  codec: DocCodec,
  d: Descriptor,
  blob: Uint8Array,
  tail: readonly AcceptedBatch[],
  local: readonly Patch[] = [],
  ledger = new Ledger(),
): Promise<{ ok: true; record: CheckpointRecord; head: string; ledger: Ledger; B: number; V: number } | { ok: false; why: InstallWhy; ledger: Ledger; B: number }> {
  let B = 0, V = 0;
  const no = (why: InstallWhy) => { ledger.drop("work"); ledger.drop("values"); ledger.drop("incoming"); return { ok: false as const, why, ledger, B }; };
  try {
    const patches = tail.reduce((n, b) => n + b.patches.length, 0), charge = tail.reduce((n, b) => n + b.charge, 0);
    B = blob.length + charge;
    if (blob.length !== d.bytes || blob.length > CHECKPOINT_BLOB_MAX || patches > TAIL_PATCHES_CAP || charge > TAIL_ITEM_CAP || local.length > LOCAL_ROWS_MAX) return no("bounds");
    let localBytes: number[];
    try {
      localBytes = local.map(patchBytes);
    } catch {
      return no("local");
    }
    const localTotal = localBytes.reduce((n, x) => n + x, 0);
    if (localTotal > LOCAL_BYTES_MAX) return no("bounds");
    B += localTotal;
    ledger.set("incoming", B);
    let work = 0;
    const grow = (bytes: number) => { work += bytes; ledger.set("work", work); };
    if ((await sha256Hex(blob)) !== d.sha256) return no("digest");
    let record: unknown;
    try {
      record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(blob));
    } catch {
      return no("record");
    }
    grow(blob.length);
    if (!checkRecord(codec, record)) return no("record");
    if (record.time !== d.cut_patch) return no("cut");
    if (tail.some((b, i) => b.seq !== d.at_seq + 1 + i)) return no("tail");
    const graph = scratchGraph(codec);
    graph.add([record]);
    try {
      for (const b of tail) { graph.add([...b.patches]); grow(b.charge); }
      for (let i = 0; i < local.length; i++) { graph.add([local[i]]); grow(localBytes[i]); }
    } catch {
      return no("tail");
    }
    if (graph.needsMoreHistory() || graph.valueUnavailable()) return no("needs_more_history");
    const value = graph.value();
    V = utf8Length(codec.toString(value));
    ledger.set("values", V);
    const head = graph.hashOf(value);
    if (ledger.peak > 2 * B + V || work > B) return no("bounds");
    // (the decision made: the graph, its value and the working copy are let go, and the incoming copy is the caller's)
    ledger.drop("work");
    ledger.drop("values");
    ledger.drop("incoming");
    return { ok: true, record, head, ledger, B, V };
  } catch {
    // (anything else thrown (the codec, the hash): a refusal, nothing held)
    return no("record");
  }
}

// ---- reconciliation (r9 §6.2)

/** A registration's identity: what the server keeps, and all of what matches it */
export interface Identity { epoch: number; at_seq: number; sha256: string; bytes: number }
export type Outcome = "registered" | "not_registered" | "void" | "unknown";
/**
 * A registration's outcome, from the server's answer to it (or to its identical retry): only the FULL identity
 * matches.  An ack is the server's answer to exactly this identity (its exact-retry answer included).  A `conflict`'s
 * `kept` decides: present (all four fields) → registered; absent → not registered.  An `epoch` refusal voids it.  No
 * answer, or a transient refusal: unknown.  Any other refusal: not registered.
 */
export function reconcile(id: Identity, answer: { t?: unknown; code?: unknown; detail?: unknown } | null): Outcome {
  if (!answer) return "unknown";
  if (answer.t === "ack") return "registered";
  if (answer.t !== "error") return "unknown";
  const code = String(answer.code ?? "");
  if (code === "epoch") return "void";
  if (code === "busy" || code === "rate" || code === "unavailable") return "unknown";
  if (code === "conflict") {
    const kept = (answer.detail as { kept?: unknown } | undefined)?.kept;
    if (!Array.isArray(kept)) return "not_registered";
    return kept.some((k) => k && typeof k === "object" && k.at_seq === id.at_seq && k.sha256 === id.sha256 && k.bytes === id.bytes && (k.epoch === undefined || k.epoch === id.epoch)) ? "registered" : "not_registered";
  }
  return "not_registered";
}

// ---- splitting (r9 §7, §4.1)

/** UTF-8 bytes of a string, counted without encoding it (the server's tail.ts utf8Length) */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
/** A stored batch's fields its pull item carries besides its envelopes and body (the server's ItemFields) */
export interface ItemFields { seq: number; author: string; writer: string; device: string; recv: number; chain: string | null }
/** A batch's charged bytes (r9 §3): the UTF-8 length of the PullItem the server serves for it, computed without
 * building it, exactly as the server's tail.ts itemBytesOf (the doc-vectors' `checkpoint.charges` pin both) */
export function itemBytesOf(f: ItemFields, envsBytes: number, bodyLength: number): number {
  const shell = JSON.stringify({ seq: f.seq, author: f.author, writer: f.writer, device: f.device, recv: f.recv, chain: f.chain, patches: 0, body: "" });
  return utf8Length(shell) - 1 + envsBytes + Math.ceil(bodyLength / 3) * 4;
}
/** An envelope as the server stores it (protocol.ts checkEnv's key order), and the payload bytes it names */
export interface SplitRow { cseq: number; id: string; parents: string[]; size: number; blobs?: string[] }
/** The server-assigned fields at their widest (seq and recv 16 digits, a chain): a client's charge is never below the
 * server's */
const WIDEST = { seq: Number.MAX_SAFE_INTEGER, recv: Number.MAX_SAFE_INTEGER, chain: "f".repeat(64) };
/** A row's envelope as the server stores it, and its JSON's UTF-8 bytes */
const envBytes = (r: SplitRow) => utf8Length(JSON.stringify({ cseq: r.cseq, id: r.id, parents: r.parents, size: r.size, ...(r.blobs ? { blobs: r.blobs } : {}) }));
/** What the server would charge for the first `k` rows sent as one batch by this writer, at most: the envelopes' JSON is
 * "[" + each envelope, joined by "," + "]", so its bytes are counted row by row, never rebuilt */
export function prefixCharge(rows: readonly SplitRow[], k: number, who: { author: string; writer: string; device: string }): number {
  let envs = 2 + Math.max(0, k - 1), body = 0;
  for (let i = 0; i < k; i++) { envs += envBytes(rows[i]); body += rows[i].size; }
  return itemBytesOf({ ...WIDEST, ...who }, envs, body);
}
/**
 * The longest cseq-order prefix of `rows` that fits both rooms of a `busy {checkpoint: "split"}` (r9 §7): its patches
 * <= room_patches and its charge (at most) <= room_bytes.  None fits: `required` (a checkpoint empties the tail, and one
 * patch always fits an empty one, §4.1), or, if even one patch can't fit an empty tail, `stop` (kept, logged, never
 * retried).  One pass: each row's envelope is serialized once.
 */
export function splitPrefix(rows: readonly SplitRow[], room_patches: number, room_bytes: number, who: { author: string; writer: string; device: string }): { kind: "fit"; n: number } | { kind: "required" } | { kind: "stop" } {
  const shell = itemBytesOf({ ...WIDEST, ...who }, 0, 0);
  let n = 0, envs = 1, body = 0;
  for (let k = 1; k <= Math.min(rows.length, room_patches); k++) {
    envs += envBytes(rows[k - 1]) + 1;
    body += rows[k - 1].size;
    if (shell + envs + Math.ceil(body / 3) * 4 > room_bytes) break;
    n = k;
  }
  if (n > 0) return { kind: "fit", n };
  if (rows.length && prefixCharge(rows, 1, who) > TAIL_ITEM_CAP) return { kind: "stop" };
  return { kind: "required" };
}
