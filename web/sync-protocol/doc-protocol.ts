// The sync protocol for documents' content, slice 2 (the frozen plan
// /scratch/sagebrush-reviews/plan-sync-slice2-r9.md, §0a's contract): the
// messages slice 2 adds, their checks, and every byte encoding both sides
// must agree on, so the client (web/workspace), the open reference server and
// the cloud server compute the same bytes and hashes.  Pure: no I/O, no
// clock, no WebCrypto (the chain is computed inside a server transaction, so
// its SHA-256 is synchronous).  doc-vectors.json holds the shared vectors,
// made by an independent implementation (gen-doc-vectors.py).
//   bun web/sync-protocol/test-doc-protocol.mjs

export const DOC_PROTOCOL_VERSION = 1;

/** The plan's limits that the messages and encodings themselves carry (§10). */
export const DOC_LIMITS = {
  /** clients one doc_fence names (the slots, §3.2) */
  fenceClients: 8,
  /** an output's blob in LTI's grading descriptor (§6.7.2); a larger one keeps a preview.  (Sync itself never
   * carries outputs: William, Oct 26; erratum-sync-no-outputs r2.) */
  outputBytes: 4 << 20,
  previewBytes: 256 << 10,
  /** cells a census lists, and its bytes (§6.7.2) */
  censusCells: 2000,
  censusBytes: 256 << 10,
  /** a sealed value (§6.7.3) */
  valueBytes: 16 << 20,
  /** a snapshot's blob (§5.2) */
  snapshotBytes: 32 << 20,
  /** the fixed width of progress claims (§7.1) */
  claimsBytes: 32,
  /** nesting in a JCS value (LIMIT-PR62-1): deeper is refused before any recursion */
  jcsDepth: 64,
  /** records a value is built from, the execution journal's included (LIMIT-PR62-1) */
  sourceRecords: 1_000_000,
  /** a cell's id, in UTF-16 units (as outputs' `cell`, §5.3) */
  cellId: 128,
  /** a batch: its body, its stored envelopes (sync-server §8: 1 MiB, 2,000 envelopes ≈ 0.4 MiB) */
  batchBody: 1 << 20,
  batchEnvs: 1 << 20,
  /** a page a reader verifies at once (§5.5's pull page), and an epoch's whole history (§5.7) */
  pageBatches: 500,
  pageBytes: 4 << 20,
  epochBatches: 50_000,
  historyBytes: 32 << 20,
} as const;

export type DocCode = "invalid" | "limit" | "invalid_value";
export class DocError extends Error {
  constructor(public code: DocCode, message: string, public detail?: Record<string, unknown>) { super(message); }
}
const invalid = (m: string) => new DocError("invalid", m);
const tooBig = (limit: string, max: number, m: string) => new DocError("limit", m, { limit, max });
const badValue = (m: string) => new DocError("invalid_value", m);

// ---- bytes

const te = new TextEncoder();
export const utf8 = (s: string) => te.encode(s);
export const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export function fromHex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw invalid("hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}
/** LTI r4 §1.1's enc: a 4-byte big-endian length, then the UTF-8 bytes (or the bytes themselves). */
export function enc(s: string | Uint8Array): Uint8Array {
  const b = typeof s === "string" ? utf8(s) : s;
  const out = new Uint8Array(4 + b.length);
  new DataView(out.buffer).setUint32(0, b.length);
  out.set(b, 4);
  return out;
}
/** A non-negative safe integer as 8 bytes, big-endian. */
export function u64(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw invalid("u64: a non-negative safe integer");
  const out = new Uint8Array(8), v = new DataView(out.buffer);
  v.setUint32(0, Math.floor(n / 2 ** 32));
  v.setUint32(4, n >>> 0);
  return out;
}

// ---- SHA-256, synchronous (FIPS 180-4); the vectors check it against an independent one

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const n = data.length, blocks = Math.ceil((n + 9) / 64), m = new Uint8Array(blocks * 64);
  m.set(data);
  m[n] = 0x80;
  const mv = new DataView(m.buffer);
  mv.setUint32(m.length - 8, Math.floor((n * 8) / 2 ** 32));
  mv.setUint32(m.length - 4, (n * 8) >>> 0);
  const w = new Uint32Array(64);
  const rot = (x: number, r: number) => (x >>> r) | (x << (32 - r));
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < 16; i++) w[i] = mv.getUint32(b * 64 + 4 * i);
    for (let i = 16; i < 64; i++) {
      const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += bb;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(4 * i, h[i]);
  return out;
}
export const sha256Hex = (data: Uint8Array | string) => hex(sha256(typeof data === "string" ? utf8(data) : data));

// ---- the chain (§5.1): every prefix of an epoch's history, sealed

/** h_b: over exactly the envelopes and body a batch row stores (a mixed resend's new subset only). */
export const batchHash = (envs: string, body: Uint8Array) => sha256(concat([utf8("sb-sync-batch-v1"), enc(envs), body]));
/** The epoch's first chain(prev). */
export const chainSeed = (ownerHash: string, doc: string, epoch: number) =>
  sha256(concat([utf8("sb-sync-chain-v1"), enc(ownerHash), enc(doc), u64(epoch)]));
export interface ChainLink { seq: number; recv: number; epoch: number; author: string; writer: string; hb: Uint8Array }
export const chainNext = (prev: Uint8Array, l: ChainLink) =>
  sha256(concat([utf8("sb-sync-chain-v1"), prev, u64(l.seq), u64(l.recv), u64(l.epoch), enc(l.author), enc(l.writer), l.hb]));

/** A batch as a reader gets it, with what the chain covers. */
export interface ChainedBatch { seq: number; recv: number; epoch: number; author: string; writer: string; envs: string; body: Uint8Array; chain: string }
/** Where a reader is in a prefix: the last batch checked (seq 0 and the seed at the start). */
export interface ChainState { seq: number; recv: number; chain: Uint8Array }
export const chainStart = (ownerHash: string, doc: string, epoch: number): ChainState => ({ seq: 0, recv: 0, chain: chainSeed(ownerHash, doc, epoch) });
/**
 * Where a reader starts an epoch whose first batch has the stored seq
 * `firstSeq` (r9 §5.1).  The server's seq keeps counting across a clear, so a
 * cleared document's epoch begins at its root's seq, not at 1: verify it from
 * chainStartAt(owner, doc, epoch, root.seq), and never renumber the root.
 * chainStart(...) is chainStartAt(..., 1), which is every course document
 * (one epoch).
 */
export function chainStartAt(ownerHash: string, doc: string, epoch: number, firstSeq: number): ChainState {
  if (!Number.isSafeInteger(firstSeq) || firstSeq < 1) throw invalid("chainStartAt: the epoch's first seq is a positive safe integer");
  return { seq: firstSeq - 1, recv: 0, chain: chainSeed(ownerHash, doc, epoch) };
}
type Verdict = { ok: true; state: ChainState } | { ok: false; at: number; why: string };
/**
 * One page of a prefix (§6.5), from the state after the batches before it:
 * at most DOC_LIMITS.pageBatches batches and pageBytes of envelopes and
 * bodies, each batch within its own limits, all checked before any hashing
 * (LIMIT-PR62-3).  Then: consecutive seqs, the epoch, recv non-decreasing
 * (and below `deadline`), and each chain recomputed from its inputs.
 */
export function verifyChainPage(a: { epoch: number; deadline?: number }, from: ChainState, page: ChainedBatch[]): Verdict {
  if (page.length > DOC_LIMITS.pageBatches) throw tooBig("page_batches", DOC_LIMITS.pageBatches, "verify at most 500 batches a page");
  let bytes = 0;
  for (const b of page) {
    if (b.body.length > DOC_LIMITS.batchBody) throw tooBig("batch_bytes", DOC_LIMITS.batchBody, "a batch's body is at most 1 MiB");
    if (b.envs.length > DOC_LIMITS.batchEnvs) throw tooBig("batch_envs", DOC_LIMITS.batchEnvs, "a batch's envelopes are at most 1 MiB");
    bytes += b.body.length + b.envs.length;
  }
  if (bytes > DOC_LIMITS.pageBytes) throw tooBig("page_bytes", DOC_LIMITS.pageBytes, "verify at most 4 MiB a page");
  let { seq, recv, chain } = from;
  for (const b of page) {
    if (b.seq !== seq + 1) return { ok: false, at: seq + 1, why: "a gap or a reordering" };
    if (b.epoch !== a.epoch) return { ok: false, at: b.seq, why: "another epoch" };
    if (!Number.isSafeInteger(b.recv) || b.recv < recv) return { ok: false, at: b.seq, why: "recv went back" };
    if (a.deadline !== undefined && b.recv >= a.deadline) return { ok: false, at: b.seq, why: "received at or after the deadline" };
    chain = chainNext(chain, { ...b, hb: batchHash(b.envs, b.body) });
    if (hex(chain) !== b.chain) return { ok: false, at: b.seq, why: "the chain differs" };
    seq = b.seq;
    recv = b.recv;
  }
  return { ok: true, state: { seq, recv, chain } };
}
/**
 * A whole prefix, 1..upto (§6.5), within an epoch's ceilings (at most
 * 50,000 batches and 32 MiB, checked before any hashing), page by page; the
 * last chain must equal `expect`.  An empty prefix is the seed.
 */
export function verifyChain(
  a: { ownerHash: string; doc: string; epoch: number; upto: number; expect: string; deadline?: number },
  batches: ChainedBatch[],
): { ok: true } | { ok: false; at: number; why: string } {
  if (a.upto > DOC_LIMITS.epochBatches || batches.length > DOC_LIMITS.epochBatches) throw tooBig("epoch_batches", DOC_LIMITS.epochBatches, "at most 50,000 batches in an epoch");
  let total = 0;
  for (const b of batches) total += b.body.length + b.envs.length;
  if (total > DOC_LIMITS.historyBytes) throw tooBig("history_bytes", DOC_LIMITS.historyBytes, "at most 32 MiB of history");
  if (batches.length !== a.upto) return { ok: false, at: batches.length, why: "not exactly batches 1..upto" };
  let state = chainStart(a.ownerHash, a.doc, a.epoch);
  for (let i = 0; i < batches.length; ) {
    // (pages within both page limits)
    let j = i, bytes = 0;
    while (j < batches.length && j - i < DOC_LIMITS.pageBatches && bytes + batches[j].body.length + batches[j].envs.length <= DOC_LIMITS.pageBytes) bytes += batches[j].body.length + batches[j++].envs.length;
    if (j === i) j = i + 1;
    const v = verifyChainPage(a, state, batches.slice(i, j));
    if (!v.ok) return v;
    state = v.state;
    i = j;
  }
  return hex(state.chain) === a.expect ? { ok: true } : { ok: false, at: a.upto, why: "the final chain differs from the collection's" };
}

// ---- RFC 8785 (JCS): one serialization, everywhere (§6.7.1)

/** UTF-8 bytes of a string, without encoding it. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) (n += 4), i++;
    else n += 3;
  }
  return n;
}
/**
 * The UTF-8 length of a string's JCS form (quotes and escapes included),
 * computed without making it; a lone surrogate is refused.  So a string
 * is charged before its escaped copy exists (LIMIT-PR62-1).
 */
function escapedLength(s: string): number {
  let n = 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x0c || c === 0x0a || c === 0x0d || c === 0x09) n += 2;
    else if (c < 0x20) n += 6;
    else if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw badValue("a lone surrogate");
      n += 4;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) throw badValue("a lone surrogate");
    else n += 3;
  }
  return n;
}
/** A string's JCS form, after its exact encoded length is charged to the budget (ECMAScript's JSON string form is JCS's, RFC 8785 §3.2.2.2). */
function jcsString(s: string, b?: Budget): string {
  const n = escapedLength(s);
  if (b) {
    if (b.bytes + n > b.max) throw tooBig("value_bytes", b.max, `over ${b.max} bytes encoded`);
    b.bytes += n;
  }
  return JSON.stringify(s);
}
type Budget = { bytes: number; max: number };
/** One piece of output, counted against the budget before it is kept. */
function emit(out: string[], piece: string, b: Budget) {
  b.bytes += utf8Length(piece);
  if (b.bytes > b.max) throw tooBig("value_bytes", b.max, `over ${b.max} bytes encoded`);
  out.push(piece);
}
function jcsInto(v: unknown, out: string[], b: Budget, depth: number) {
  if (v === null || typeof v === "boolean") return emit(out, JSON.stringify(v), b);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw badValue("a non-finite number");
    return emit(out, JSON.stringify(v), b);
  }
  if (typeof v === "string") {
    // (charged by its exact encoded length, computed without copying it, before it is escaped)
    out.push(jcsString(v, b));
    return;
  }
  if (depth >= DOC_LIMITS.jcsDepth) throw badValue(`nested deeper than ${DOC_LIMITS.jcsDepth}`);
  if (Array.isArray(v)) {
    if (v.length > b.max - b.bytes) throw tooBig("value_bytes", b.max, `over ${b.max} bytes encoded`);
    emit(out, "[", b);
    for (let i = 0; i < v.length; i++) {
      if (i) emit(out, ",", b);
      jcsInto(v[i], out, b, depth + 1);
    }
    return emit(out, "]", b);
  }
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length > b.max - b.bytes) throw tooBig("value_bytes", b.max, `over ${b.max} bytes encoded`);
    emit(out, "{", b);
    // (the default sort compares UTF-16 code units, as RFC 8785 §3.2.3 asks; an undefined property is absent)
    let first = true;
    for (const k of keys.sort()) {
      if (o[k] === undefined) continue;
      if (!first) emit(out, ",", b);
      first = false;
      out.push(jcsString(k, b));
      emit(out, ":", b);
      jcsInto(o[k], out, b, depth + 1);
    }
    return emit(out, "}", b);
  }
  throw badValue("not plain JSON data");
}
/**
 * JCS: plain JSON data only; properties sorted by UTF-16 code units; numbers
 * in ES6 form; nothing non-finite.  Bounded: at most `maxBytes` of UTF-8
 * output and DOC_LIMITS.jcsDepth of nesting, each refused (typed) as soon as
 * it is passed, before the rest is walked (LIMIT-PR62-1).
 */
export function jcs(v: unknown, maxBytes: number = DOC_LIMITS.valueBytes): string {
  const out: string[] = [];
  jcsInto(v, out, { bytes: 0, max: maxBytes }, 0);
  return out.join("");
}

// ---- the sealed value (§6.7.1)

export type ValueKind = "notebook" | "board";
type Rec = Record<string, unknown>;
const keyPart = (r: Rec, k: string) => (r[k] === undefined || r[k] === null ? "" : String(r[k]));
const cmpTuple = (a: string[], b: string[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};
/** The projection: a notebook's settings and cells only (the execution journal dropped), a board's four kinds whole. */
export function projectRecords(kind: ValueKind, records: Rec[]): Rec[] {
  if (kind === "notebook") {
    const out: Rec[] = [];
    for (const r of records) {
      if (r.type === "settings") out.push({ type: "settings", kernel: r.kernel });
      else if (r.type === "cell") {
        const c: Rec = { type: "cell", id: r.id, pos: r.pos, input: r.input, cell_type: r.cell_type };
        if (r.attachments !== undefined) c.attachments = r.attachments;
        out.push(c);
      }
    }
    return out;
  }
  return records.filter((r) => r.type === "doc" || r.type === "page" || r.type === "item" || r.type === "edge");
}
const keyOf = (kind: ValueKind, r: Rec) =>
  kind === "notebook" ? [keyPart(r, "type"), keyPart(r, "id")] : [keyPart(r, "type"), keyPart(r, "page"), keyPart(r, "id")];
/** The canonical bytes of a document's value: the header line, then one JCS record a line, in key order. */
export function sealedValueBytes(kind: ValueKind, records: Rec[]): Uint8Array {
  if (records.length > DOC_LIMITS.sourceRecords) throw tooBig("source_records", DOC_LIMITS.sourceRecords, "too many records to build a value from");
  const rs = projectRecords(kind, records).sort((a, b) => cmpTuple(keyOf(kind, a), keyOf(kind, b)));
  for (let i = 1; i < rs.length; i++) if (cmpTuple(keyOf(kind, rs[i - 1]), keyOf(kind, rs[i])) === 0) throw badValue("two records with one key");
  // (one budget for the whole value: the first record past 16 MiB stops it)
  const out: string[] = [], b: Budget = { bytes: 0, max: DOC_LIMITS.valueBytes };
  emit(out, "sb-sync-value-v1\n", b);
  for (const r of rs) {
    jcsInto(r, out, b, 0);
    emit(out, "\n", b);
  }
  return utf8(out.join(""));
}

// ---- the census (§6.7.2)

export interface CensusCell { id: string; cell_type: string }
/** The cells of a value: a notebook's, in ascending id order; a board has none (no outputs map in slice 2). */
export function censusOf(kind: ValueKind, records: Rec[]): CensusCell[] {
  if (kind === "board") return [];
  if (records.length > DOC_LIMITS.sourceRecords) throw tooBig("source_records", DOC_LIMITS.sourceRecords, "too many records to build a census from");
  const cells: CensusCell[] = [];
  for (const r of records) {
    if (r.type !== "cell") continue;
    // (refused at the 2,001st cell, before any more is gathered)
    if (cells.length >= DOC_LIMITS.censusCells) throw badValue(`a census over ${DOC_LIMITS.censusCells} cells`);
    cells.push({ id: String(r.id), cell_type: String(r.cell_type) });
  }
  return cells.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
const CELL_TYPES = new Set(["code", "markdown", "raw"]);
/** A cell id's form, as outputs' `cell` (§5.3): 1 to 128 characters, no control characters. */
export const isCellId = (s: unknown): s is string => typeof s === "string" && s.length >= 1 && s.length <= DOC_LIMITS.cellId && /^[^\u0000-\u001f\u007f]+$/.test(s);
export function censusBytes(cells: CensusCell[]): Uint8Array {
  if (cells.length > DOC_LIMITS.censusCells) throw badValue(`a census over ${DOC_LIMITS.censusCells} cells`);
  // (every field bounded before anything is encoded: 2,000 cells of at most 128 characters fit 256 KiB)
  for (const c of cells) if (!isCellId(c.id) || !CELL_TYPES.has(c.cell_type)) throw badValue("census: a cell id of 1 to 128 characters, and a cell type of code, markdown or raw");
  for (let i = 1; i < cells.length; i++) if (!(cells[i - 1].id < cells[i].id)) throw invalid("census: ids in strictly ascending order");
  const out = utf8("sb-sync-census-v1\n" + cells.map((c) => jcs({ cell_type: c.cell_type, id: c.id }) + "\n").join(""));
  if (out.length > DOC_LIMITS.censusBytes) throw badValue("a census over 256 KiB");
  return out;
}
/** A census blob's cells, checked: the reader of a pinned census (finalize, §6.7.5). */
export function parseCensus(b: Uint8Array): CensusCell[] {
  if (b.length > DOC_LIMITS.censusBytes) throw badValue("a census over 256 KiB");
  const s = new TextDecoder("utf-8", { fatal: true }).decode(b);
  const lines = s.split("\n");
  if (lines[0] !== "sb-sync-census-v1" || lines[lines.length - 1] !== "") throw invalid("census: header and final newline");
  const cells = lines.slice(1, -1).map((l) => {
    let o: unknown;
    try {
      o = JSON.parse(l);
    } catch {
      throw invalid("census: a line isn't JSON");
    }
    const x = fields(o, ["cell_type", "id"], "census line");
    if (typeof x.id !== "string" || typeof x.cell_type !== "string") throw invalid("census: id and cell_type");
    return { id: x.id, cell_type: x.cell_type };
  });
  // (exactly the canonical bytes: anything else is a different census)
  if (hex(censusBytes(cells)) !== hex(b)) throw invalid("census: not in canonical form");
  return cells;
}

// ---- outputs: the descriptor and its digest, v2 (§6.7.2)

export const OUTPUT_STATES = ["captured", "written_after_deadline", "not_run", "not_code"] as const;
export type OutputState = (typeof OUTPUT_STATES)[number];
export interface BlobRef { sha256: string; size: number; rev: number }
export interface PreviewRef extends BlobRef { kind: "text" | "png" }
export interface OutputEntry { cell: string; state: OutputState; full?: BlobRef; preview?: PreviewRef }
const isSha = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const isNat = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
function blobBytes(b: BlobRef | undefined, kind?: string): Uint8Array {
  if (!b) return new Uint8Array([0]);
  if (!isSha(b.sha256) || !isNat(b.size) || !isNat(b.rev)) throw invalid("descriptor: a blob reference");
  return concat([new Uint8Array([1]), enc(b.sha256), u64(b.size), u64(b.rev), ...(kind === undefined ? [] : [enc(kind)])]);
}
/** outputs_digest, v2: every census cell in ascending id order, with its state, full blob and preview, each behind a presence byte. */
export function outputsDigest(entries: OutputEntry[]): string {
  if (entries.length > DOC_LIMITS.censusCells) throw invalid(`descriptor: over ${DOC_LIMITS.censusCells} cells`);
  const parts: Uint8Array[] = [utf8("sb-sync-outputs-v2")];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    // (the bounded fields first: the cell id's form, the blobs' sizes, LIMIT-PR62-2)
    if (!isCellId(e.cell)) throw invalid("descriptor: a cell id of 1 to 128 characters");
    if (e.full && !(isNat(e.full.size) && e.full.size <= DOC_LIMITS.outputBytes)) throw tooBig("output_bytes", DOC_LIMITS.outputBytes, "descriptor: an output over 4 MiB");
    if (e.preview && !(isNat(e.preview.size) && e.preview.size <= DOC_LIMITS.previewBytes)) throw tooBig("preview_bytes", DOC_LIMITS.previewBytes, "descriptor: a preview over 256 KiB");
    if (i > 0 && !(entries[i - 1].cell < e.cell)) throw invalid("descriptor: cells in strictly ascending order");
    if (!(OUTPUT_STATES as readonly string[]).includes(e.state)) throw invalid("descriptor: state");
    if (e.state !== "captured" && (e.full || e.preview)) throw invalid("descriptor: only a captured output has blobs");
    if (e.state === "captured" && !e.full && !e.preview) throw invalid("descriptor: a captured output has a blob or a preview");
    if (e.preview && e.preview.kind !== "text" && e.preview.kind !== "png") throw invalid("descriptor: preview kind");
    parts.push(enc(e.cell), enc(e.state), blobBytes(e.full), blobBytes(e.preview, e.preview?.kind));
  }
  return hex(sha256(concat(parts)));
}
/**
 * Finalization's descriptor (§6.7.2): every census cell, from the frozen
 * selection where it has an entry, otherwise not_run (a code cell) or
 * not_code; a selected cell outside the census is dropped, and its pins are
 * the caller's to release.
 */
export function finalDescriptor(census: CensusCell[], selection: Map<string, OutputEntry>): { entries: OutputEntry[]; dropped: string[] } {
  if (census.length > DOC_LIMITS.censusCells) throw badValue(`a census over ${DOC_LIMITS.censusCells} cells`);
  if (selection.size > DOC_LIMITS.censusCells) throw invalid(`a selection over ${DOC_LIMITS.censusCells} cells`);
  const inCensus = new Set(census.map((c) => c.id));
  const entries = census.map((c): OutputEntry => {
    if (c.cell_type !== "code") return { cell: c.id, state: "not_code" };
    const s = selection.get(c.id);
    return s ? { ...s, cell: c.id } : { cell: c.id, state: "not_run" };
  });
  return { entries, dropped: [...selection.keys()].filter((k) => !inCensus.has(k)).sort() };
}

// ---- progress claims: 32 bytes, fixed width (§7.1)

export interface Claims {
  cells_total: number;
  cells_run: number;
  cells_error: number;
  tests_passed: number;
  tests_total: number;
  outbox_waiting: number;
  device_t: number;
  recovery_copy: boolean;
}
const COUNTS = ["cells_total", "cells_run", "cells_error", "tests_passed", "tests_total"] as const;
/** v1: version u8 (1), flags u8 (bit 0: recovery_copy), five u16 counts, outbox_waiting u32, device_t u64 in ms, 8 zero bytes. */
export function encodeClaims(c: Claims): Uint8Array {
  const out = new Uint8Array(DOC_LIMITS.claimsBytes), v = new DataView(out.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, c.recovery_copy ? 1 : 0);
  COUNTS.forEach((k, i) => {
    const n = c[k];
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw invalid(`claims: ${k}`);
    v.setUint16(2 + 2 * i, n);
  });
  if (!Number.isInteger(c.outbox_waiting) || c.outbox_waiting < 0 || c.outbox_waiting > 0xffffffff) throw invalid("claims: outbox_waiting");
  v.setUint32(12, c.outbox_waiting);
  out.set(u64(c.device_t), 16);
  return out;
}
export function decodeClaims(b: Uint8Array): Claims {
  if (b.length !== DOC_LIMITS.claimsBytes) throw invalid("claims: 32 bytes");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint8(0) !== 1) throw invalid("claims: version");
  if (v.getUint8(1) & ~1) throw invalid("claims: flags");
  for (let i = 24; i < 32; i++) if (b[i] !== 0) throw invalid("claims: reserved bytes");
  const hi = v.getUint32(16), lo = v.getUint32(20);
  if (hi >= 2 ** 21) throw invalid("claims: device_t");
  return {
    cells_total: v.getUint16(2),
    cells_run: v.getUint16(4),
    cells_error: v.getUint16(6),
    tests_passed: v.getUint16(8),
    tests_total: v.getUint16(10),
    outbox_waiting: v.getUint32(12),
    device_t: hi * 2 ** 32 + lo,
    recovery_copy: (v.getUint8(1) & 1) === 1,
  };
}

// ---- the messages slice 2 adds (§0a; each field listed, nothing else accepted)

function fields(v: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) throw invalid(`${what}: an object`);
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw invalid(`${what}: unknown field ${JSON.stringify(k.slice(0, 40))}`);
  return v as Record<string, unknown>;
}
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** A patchflow client's id, as a patch id carries it (protocol.ts's PATCH_ID, after the "_"). */
export const isClient = (s: unknown): s is string => typeof s === "string" && /^[0-9A-Za-z_-]{1,64}$/.test(s);
const isDocId = (s: unknown): s is string =>
  typeof s === "string" && (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) || /^[0-9a-f]{12}$/.test(s));
const U32 = 0xffffffff;

// ---- merge modes (plan-merge-align r3.2 §2-§5, CLEAR Oct 30)

/** How a document's concurrent edits are merged: "legacy" (patchflow's apply-all: every document until now) or
 * "exact-v1" (patchflow's merge3, with web/notebook/db-merge3.ts).  A document's mode is fixed when the server creates
 * it, kept by every later epoch (a clear keeps it), and never changes. */
export const MERGE_MODES = Object.freeze(["legacy", "exact-v1"] as const);
export type MergeMode = (typeof MERGE_MODES)[number];
export const isMergeMode = (v: unknown): v is MergeMode => v === "legacy" || v === "exact-v1";
/** hello's `merge`: the modes the client runs.  Absent, ["legacy"]: every client before merge modes.  Each entry a
 * short name; a name this build doesn't know (a newer client's) is passed over, so a client that runs none this build
 * knows is refused every document (merge_mode). */
export function helloMerge(v: unknown): ReadonlySet<MergeMode> {
  if (v === undefined) return new Set<MergeMode>(["legacy"]);
  if (!Array.isArray(v) || v.length === 0 || v.length > 8 || !v.every((x) => typeof x === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(x)))
    throw invalid("hello: merge, the merge modes the client runs (1 to 8 short names)");
  return new Set(v.filter(isMergeMode));
}
/** A creating operation's `merge` (the reference server's doc_claim; cloud's first batch): the mode it asks for.  Only
 * the operation that creates the document reads it; on a document that exists it changes nothing (never a downgrade
 * or an upgrade: the answer says the document's own mode). */
export function checkMergeRequest(v: unknown, what: string): MergeMode {
  if (!isMergeMode(v)) throw invalid(`${what}: merge, "legacy" or "exact-v1"`);
  return v;
}
/** The mode a document is created in: "exact-v1" only when the deployment's switch is on AND the creating socket runs
 * it AND the creating operation asked for it; else "legacy" (an operation that asks for nothing, or for "legacy", a
 * socket that doesn't run exact-v1, the switch off). */
export function creationMode(a: { exactOn: boolean; runs: ReadonlySet<MergeMode>; asked?: MergeMode }): MergeMode {
  return a.exactOn && a.asked === "exact-v1" && a.runs.has("exact-v1") ? "exact-v1" : "legacy";
}
/** Whether a socket that runs `runs` may touch a document in `mode`: checked on every document operation (claim, fence,
 * batch, pull, clear, and the `changed` told to it), not once per claim; else the server refuses merge_mode, detail
 * {merge: mode}, and nothing changes. */
export const mergeAdmits = (mode: MergeMode, runs: ReadonlySet<MergeMode>): boolean => runs.has(mode);

/** A claim and a fence name the document's epoch they are for (plan-sync-slice2-2b-r4 §2.4): one for another epoch
 * than the document's is refused (stale_epoch) and changes nothing, so a delayed one can't land in a later epoch.  A
 * claim may carry `merge`, the mode asked for if it creates the document (checkMergeRequest). */
export interface DocClaim { t: "doc_claim"; req: number; doc: string; epoch: number; client: string; owner?: string; merge?: MergeMode }
export interface DocFence { t: "doc_fence"; req: number; doc: string; epoch: number; clients: { client: string; target: number }[]; owner?: string }
export interface Snapshot { t: "snapshot"; req: number; doc: string; at_seq: number; sha256: string; bytes: number; owner?: string }
export interface Progress { t: "progress"; claims: Uint8Array }

/**
 * Which socket a message came on (CORR-PR62-2).  On the account socket a
 * document message names its `doc` (and, optionally, its `owner`).  On a
 * document socket the document is the attachment's: the message carries
 * neither field (either one is refused as unknown, so it can't name
 * another document), and the checked message is normalized with the
 * attachment's `doc` and `owner`.  Default: the account socket.
 */
export type Via = { socket: "account" } | { socket: "document"; doc: string; owner: string };
const ACCOUNT: Via = { socket: "account" };
/** The fields allowed, and the document and owner, for the socket a message came on. */
function docFields(v: unknown, own: readonly string[], via: Via, what: string): { o: Record<string, unknown>; doc: string; owner?: string } {
  if (via.socket === "document") {
    if (!isDocId(via.doc) || !isSha(via.owner)) throw invalid(`${what}: the attachment's doc and owner`);
    return { o: fields(v, own, what), doc: via.doc, owner: via.owner };
  }
  const o = fields(v, [...own, "doc", "owner"], what);
  if (!isDocId(o.doc)) throw invalid(`${what}: doc`);
  if (has(o, "owner") && !isSha(o.owner)) throw invalid(`${what}: owner is an account hash`);
  return { o, doc: o.doc, ...(has(o, "owner") ? { owner: o.owner as string } : {}) };
}
const withDoc = <T extends object>(m: T, d: { doc: string; owner?: string }) => ({ ...m, doc: d.doc, ...(d.owner !== undefined ? { owner: d.owner } : {}) });
export function checkDocClaim(v: unknown, via: Via = ACCOUNT): DocClaim {
  const d = docFields(v, ["t", "req", "epoch", "client", "merge"], via, "doc_claim"), o = d.o;
  if (o.t !== "doc_claim" || !isNat(o.req) || !isClient(o.client)) throw invalid("doc_claim: t, req and client");
  if (!isNat(o.epoch) || o.epoch < 1) throw invalid("doc_claim: epoch, the document's (from 1)");
  const merge = has(o, "merge") ? { merge: checkMergeRequest(o.merge, "doc_claim") } : {};
  return withDoc({ t: "doc_claim" as const, req: o.req, epoch: o.epoch, client: o.client, ...merge }, d);
}
export function checkDocFence(v: unknown, via: Via = ACCOUNT): DocFence {
  const d = docFields(v, ["t", "req", "epoch", "clients"], via, "doc_fence"), o = d.o;
  if (o.t !== "doc_fence" || !isNat(o.req)) throw invalid("doc_fence: t and req");
  if (!isNat(o.epoch) || o.epoch < 1) throw invalid("doc_fence: epoch, the document's (from 1)");
  if (!Array.isArray(o.clients) || o.clients.length === 0) throw invalid("doc_fence: clients");
  if (o.clients.length > DOC_LIMITS.fenceClients) throw tooBig("fence_clients", DOC_LIMITS.fenceClients, "doc_fence: too many clients");
  const clients = o.clients.map((c) => {
    const x = fields(c, ["client", "target"], "doc_fence client");
    if (!isClient(x.client) || !isNat(x.target) || x.target < 1 || x.target > U32) throw invalid("doc_fence: a client and a target, 1 to 2^32 - 1");
    return { client: x.client, target: x.target };
  });
  if (new Set(clients.map((c) => c.client)).size !== clients.length) throw invalid("doc_fence: a client named twice");
  return withDoc({ t: "doc_fence" as const, req: o.req, epoch: o.epoch, clients }, d);
}
/** A batch's `fgen` (§5.8): the fence generation each client in the batch was sent under, every one of them and no other. */
export function checkFgen(v: unknown, clientsInBatch: ReadonlySet<string>): Map<string, number> {
  const o = fields(v, [...clientsInBatch], "batch fgen");
  const out = new Map<string, number>();
  for (const c of clientsInBatch) {
    if (!has(o, c) || !isNat(o[c]) || (o[c] as number) > U32) throw invalid("batch fgen: one generation for each client in the batch");
    out.set(c, o[c] as number);
  }
  return out;
}
/** pull's `upto` (§5.5): with it, batches up to `upto` only, and never a snapshot. */
export function checkUpto(o: Record<string, unknown>, after: number): number | undefined {
  if (!has(o, "upto")) return undefined;
  if (!isNat(o.upto) || (o.upto as number) < after) throw invalid("pull: upto is at least `after`");
  return o.upto as number;
}
/** §5.2: `snapshot{owner?, doc, at_seq, sha256, bytes}` on the account socket, `snapshot{at_seq, sha256, bytes}` on a document socket. */
export function checkSnapshot(v: unknown, via: Via = ACCOUNT): Snapshot {
  const d = docFields(v, ["t", "req", "at_seq", "sha256", "bytes"], via, "snapshot"), o = d.o;
  if (o.t !== "snapshot" || !isNat(o.req) || !isNat(o.at_seq) || o.at_seq < 1 || !isSha(o.sha256) || !isNat(o.bytes))
    throw invalid("snapshot: t, req, at_seq, sha256 and bytes");
  if (o.bytes > DOC_LIMITS.snapshotBytes) throw tooBig("snapshot_bytes", DOC_LIMITS.snapshotBytes, "snapshot: at most 32 MiB");
  return withDoc({ t: "snapshot" as const, req: o.req, at_seq: o.at_seq, sha256: o.sha256, bytes: o.bytes }, d);
}
export function checkProgress(v: unknown): Progress {
  const o = fields(v, ["t", "claims"], "progress");
  if (o.t !== "progress" || typeof o.claims !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(o.claims)) throw invalid("progress: claims are 32 bytes, base64");
  const bin = atob(o.claims), b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  decodeClaims(b);
  return { t: "progress", claims: b };
}

// ---- the lossless record encoding, LRE (plan-sync-slice2-client-r4 §1b)
//
// patchflow's record codec treats null as delete, so a record of a synced
// history is encoded before the codec sees it and decoded after: the codec
// never holds a null.  Non-string fields, recursively through objects and
// arrays: null is the object {"\u0000": "n"}, and an object key starting
// with \u0000 is escaped by doubling that prefix.  String columns (the
// schema's stringCols, which the codec diffs as text): null makes the field
// absent and sets the sidecar key "\u0000n:<field>" to true.  Decoding checks
// the record as it stands after patches were applied (lreCheckRecord), so a
// patch's own null, a delete, stays legal; and it reads the mixed forms a
// concurrent merge makes as the merge means them: a null marker beside other
// keys is dropped (the object), a sidecar beside a present string is dropped
// (the string).  Every refusal is invalid_value, with the field it found.

/** The record schema a document kind's codec uses: its primary keys, and its string (text-diffed) columns. */
export interface RecordSchema { primaryKeys: readonly string[]; stringCols: readonly string[] }
export const NOTEBOOK_SCHEMA: RecordSchema = { primaryKeys: ["type", "id"], stringCols: ["input"] };
export const BOARD_SCHEMA: RecordSchema = { primaryKeys: ["type", "page", "id"], stringCols: ["title", "text", "code", "detail", "label", "intro"] };
const NUL = "\u0000", SIDECAR = "\u0000n:";
const lreRefused = (field: string, m: string) => new DocError("invalid_value", `LRE: ${m}`, { field });
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const lreKey = (k: string) => (k.startsWith(NUL) ? NUL + k : k);
/** A key set as an own, enumerable data property: "__proto__" included, which `o[k] = v` would take as the
 * prototype setter, losing the key (astra's CORR-175-1).  Every object LRE makes is built this way. */
function putOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}
/** An array's items, by index: a hole (a sparse array, which no JSON value is) refused, never skipped as map
 * would skip it (daybreak3's LIMIT-2C1-2). */
function lreItems(v: unknown[], field: string, each: (x: unknown) => unknown): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < v.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(v, i)) throw lreRefused(field, `a sparse array (a hole at ${i})`);
    out.push(each(v[i]));
  }
  return out;
}
function lreValue(v: unknown, field: string, depth: number): unknown {
  if (depth > DOC_LIMITS.jcsDepth) throw tooBig("lre_depth", DOC_LIMITS.jcsDepth, "LRE: nested too deep");
  if (v === null) return { [NUL]: "n" };
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw lreRefused(field, "a number that isn't finite");
    return v;
  }
  if (Array.isArray(v)) return lreItems(v, field, (x) => lreValue(x, field, depth + 1));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) putOwn(out, lreKey(k), lreValue(x, field, depth + 1));
    return out;
  }
  throw lreRefused(field, "a value that isn't JSON");
}
/**
 * A record as a synced history stores it.  Refused (invalid_value, with the
 * field): a primary key present as anything but a string (absent is legal: a
 * notebook's one `settings` record has no id), a string column holding anything
 * but a string or null (patchflow never patches it: board's MUST-2), a value
 * that isn't JSON.  An undefined field is absent.
 */
export function lreEncode(schema: RecordSchema, rec: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(rec)) throw lreRefused("", "a record is an object");
  for (const k of schema.primaryKeys) if (rec[k] !== undefined && typeof rec[k] !== "string") throw lreRefused(k, "a primary key is absent or a string");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v === undefined) continue;
    if (schema.stringCols.includes(k)) {
      if (v === null) putOwn(out, SIDECAR + k, true);
      else if (typeof v === "string") putOwn(out, k, v);
      else throw lreRefused(k, "a string column holds a string or null");
    } else putOwn(out, lreKey(k), lreValue(v, k, 1));
  }
  return out;
}
function lreDecodeValue(v: unknown, field: string, depth: number): unknown {
  if (depth > DOC_LIMITS.jcsDepth) throw tooBig("lre_depth", DOC_LIMITS.jcsDepth, "LRE: nested too deep");
  if (v === null) throw lreRefused(field, "a raw null in an encoded record");
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw lreRefused(field, "a number that isn't finite");
    return v;
  }
  if (Array.isArray(v)) return lreItems(v, field, (x) => lreDecodeValue(x, field, depth + 1));
  if (!isPlainObject(v)) throw lreRefused(field, "a value that isn't JSON");
  const keys = Object.keys(v);
  if (Object.prototype.hasOwnProperty.call(v, NUL)) {
    if (v[NUL] !== "n") throw lreRefused(field, "a null marker whose value isn't \"n\"");
    // (alone, a null; beside other keys, a concurrent merge's object: the marker dropped)
    if (keys.length === 1) return null;
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k === NUL) continue;
    if (k.startsWith(NUL)) {
      if (!k.startsWith(NUL + NUL)) throw lreRefused(field, "a key starting with \\u0000 that isn't escaped");
      putOwn(out, k.slice(1), lreDecodeValue(v[k], field, depth + 1));
    } else putOwn(out, k, lreDecodeValue(v[k], field, depth + 1));
  }
  return out;
}
/**
 * A stored record decoded, checked as a whole first (lreCheckRecord's rules):
 * primary keys absent or strings; a string column present only as a string,
 * and null only when it is absent beside its sidecar (true); no raw null
 * anywhere; null markers whose value is "n"; every other key starting with
 * \u0000 doubled or a sidecar of a string column.
 */
export function lreDecode(schema: RecordSchema, enc: unknown): Record<string, unknown> {
  if (!isPlainObject(enc)) throw lreRefused("", "a record is an object");
  const out: Record<string, unknown> = {};
  const sidecars: string[] = [];
  for (const [k, v] of Object.entries(enc)) {
    if (k.startsWith(SIDECAR)) {
      const f = k.slice(SIDECAR.length);
      if (!schema.stringCols.includes(f)) throw lreRefused(f, "a sidecar on a column that isn't a string column");
      if (v !== true) throw lreRefused(f, "a sidecar whose value isn't true");
      sidecars.push(f);
    } else if (k.startsWith(NUL)) {
      if (!k.startsWith(NUL + NUL)) throw lreRefused(k, "a key starting with \\u0000 that isn't escaped");
      putOwn(out, k.slice(1), lreDecodeValue(v, k.slice(1), 1));
    } else if (schema.stringCols.includes(k)) {
      if (typeof v !== "string") throw lreRefused(k, "a string column present as anything but a string");
      putOwn(out, k, v);
    } else putOwn(out, k, lreDecodeValue(v, k, 1));
  }
  // (a sidecar beside its present string: a concurrent merge's string, the sidecar dropped)
  for (const f of sidecars) if (!Object.prototype.hasOwnProperty.call(out, f)) putOwn(out, f, null);
  for (const k of schema.primaryKeys) if (Object.prototype.hasOwnProperty.call(out, k) && typeof out[k] !== "string") throw lreRefused(k, "a primary key is absent or a string");
  return out;
}
/** A record's size as a synced history stores and sends it: the UTF-8 bytes of its encoded JSON.  What a patch's
 * 256 KiB inline bound, a batch's 1 MiB and the client's charges (plan-sync-slice2-client-r4 F8) count is this,
 * never the record's own JSON: LRE's markers, sidecars and escaped keys take bytes (LIMIT-2C1-1). */
export function lreEncodedBytes(schema: RecordSchema, rec: Record<string, unknown>): number {
  return utf8(JSON.stringify(lreEncode(schema, rec))).length;
}
/** Whether a stored record is one LRE accepts (the applied state, never a patch's instructions): throws invalid_value if not. */
export function lreCheckRecord(schema: RecordSchema, enc: unknown): void {
  lreDecode(schema, enc);
}

// ---- the snapshot blob (§5.2)

export interface SnapshotBlob { format: "sb-sync-snapshot"; v: 1; kind: ValueKind; epoch: number; at_seq: number; time: string; value: string }
/** A snapshot blob's bytes: at most 32 MiB, refused before they are decoded or parsed (LIMIT-PR62-3). */
export function parseSnapshotBlob(bytes: Uint8Array): SnapshotBlob {
  if (bytes.length > DOC_LIMITS.snapshotBytes) throw tooBig("snapshot_bytes", DOC_LIMITS.snapshotBytes, "a snapshot is at most 32 MiB");
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid("snapshot blob: UTF-8 JSON");
  }
  return checkSnapshotBlob(v);
}
export function checkSnapshotBlob(v: unknown): SnapshotBlob {
  const o = fields(v, ["format", "v", "kind", "epoch", "at_seq", "time", "value"], "snapshot blob");
  if (typeof o.value === "string" && utf8Length(o.value) > DOC_LIMITS.snapshotBytes) throw tooBig("snapshot_bytes", DOC_LIMITS.snapshotBytes, "a snapshot is at most 32 MiB");
  if (o.format !== "sb-sync-snapshot" || o.v !== 1) throw invalid("snapshot blob: format and version");
  if (o.kind !== "notebook" && o.kind !== "board") throw invalid("snapshot blob: kind");
  if (!isNat(o.epoch) || !isNat(o.at_seq) || o.at_seq < 1) throw invalid("snapshot blob: epoch and at_seq");
  if (typeof o.time !== "string" || !/^[0-9a-z]{11}_[0-9A-Za-z_-]{1,64}$/.test(o.time)) throw invalid("snapshot blob: time is the head's patch id");
  if (typeof o.value !== "string") throw invalid("snapshot blob: value");
  return { format: "sb-sync-snapshot", v: 1, kind: o.kind, epoch: o.epoch, at_seq: o.at_seq, time: o.time, value: o.value };
}

// ---- answers' shapes (doc-vectors.json's `answers`: what the servers send, agreed by vector)

/** A shape: an object has exactly its keys ({"*": s} a map whose every value is s); [s] an array whose every element
 * is s; "number", "string", "boolean", "null", "string|null", "array" a value of that type; "=x" exactly the string x. */
export type Shape = string | Shape[] | { [k: string]: Shape };
const TYPES: Record<string, (v: unknown) => boolean> = {
  number: (v) => typeof v === "number" && Number.isFinite(v),
  string: (v) => typeof v === "string",
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
  "string|null": (v) => v === null || typeof v === "string",
  array: (v) => Array.isArray(v),
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// (a key of the object itself, never one its prototype has: a frame's extra "constructor", "toString" or "__proto__"
// key, or a shape naming one, is not matched by Object.prototype's (astra's item 4 review, A1))
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** Where `v` differs from `shape` (a path and why), or null when it matches. */
export function shapeMismatch(v: unknown, shape: Shape, at = "$"): string | null {
  if (typeof shape === "string") {
    if (shape.startsWith("=")) return v === shape.slice(1) ? null : `${at}: not ${JSON.stringify(shape.slice(1))}`;
    const t = own(TYPES, shape) ? TYPES[shape] : undefined;
    if (!t) return `${at}: the shape names no type (${shape})`;
    return t(v) ? null : `${at}: not ${shape}`;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(v)) return `${at}: not an array`;
    for (let i = 0; i < v.length; i++) {
      const m = shapeMismatch(v[i], shape[0], `${at}[${i}]`);
      if (m) return m;
    }
    return null;
  }
  if (!isObj(v)) return `${at}: not an object`;
  const keys = Object.keys(shape);
  if (keys.length === 1 && keys[0] === "*") {
    for (const [k, x] of Object.entries(v)) {
      const m = shapeMismatch(x, shape["*"], `${at}.${k}`);
      if (m) return m;
    }
    return null;
  }
  for (const k of Object.keys(v)) if (!own(shape, k)) return `${at}.${k}: not in the shape`;
  for (const k of keys) {
    if (!own(v, k)) return `${at}.${k}: missing`;
    const m = shapeMismatch(v[k], shape[k], `${at}.${k}`);
    if (m) return m;
  }
  return null;
}
