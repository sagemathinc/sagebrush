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
  /** cells an outputs message sets (§5.3) */
  outputsSet: 500,
  /** an output's blob; a larger one keeps a preview (G3) */
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
function jcsString(s: string): string {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw badValue("a lone surrogate");
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) throw badValue("a lone surrogate");
  }
  // (ECMAScript's JSON string form is JCS's, RFC 8785 §3.2.2.2)
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
    // (a string longer than what's left can't fit: refused before it is escaped)
    if (v.length > b.max - b.bytes) throw tooBig("value_bytes", b.max, `over ${b.max} bytes encoded`);
    return emit(out, jcsString(v), b);
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
      if (k.length > b.max - b.bytes) throw tooBig("value_bytes", b.max, `over ${b.max} bytes encoded`);
      emit(out, jcsString(k) + ":", b);
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

export interface DocClaim { t: "doc_claim"; req: number; doc: string; client: string; owner?: string }
export interface DocFence { t: "doc_fence"; req: number; doc: string; clients: { client: string; target: number }[]; owner?: string }
export interface OutputSet { cell: string; full?: { sha256: string; size: number }; preview?: { sha256: string; size: number; kind: "text" | "png" } }
export interface Outputs { t: "outputs"; req: number; doc: string; oreq: { client: string; n: number }; set: OutputSet[]; owner?: string }
export interface Snapshot { t: "snapshot"; req: number; doc: string; at_seq: number; sha256: string; bytes: number; owner?: string }
export interface Progress { t: "progress"; claims: Uint8Array }

/** `owner` names the document's owner on the account socket; a document socket's is its attachment's (sync-server §5.1). */
function withOwner<T extends object>(m: T, o: Record<string, unknown>, what: string): T & { owner?: string } {
  if (!has(o, "owner")) return m;
  if (!isSha(o.owner)) throw invalid(`${what}: owner is an account hash`);
  return { ...m, owner: o.owner as string };
}
export function checkDocClaim(v: unknown): DocClaim {
  const o = fields(v, ["t", "req", "doc", "client", "owner"], "doc_claim");
  if (o.t !== "doc_claim" || !isNat(o.req) || !isDocId(o.doc) || !isClient(o.client)) throw invalid("doc_claim: t, req, doc and client");
  return withOwner({ t: "doc_claim" as const, req: o.req, doc: o.doc, client: o.client }, o, "doc_claim");
}
export function checkDocFence(v: unknown): DocFence {
  const o = fields(v, ["t", "req", "doc", "clients", "owner"], "doc_fence");
  if (o.t !== "doc_fence" || !isNat(o.req) || !isDocId(o.doc)) throw invalid("doc_fence: t, req and doc");
  if (!Array.isArray(o.clients) || o.clients.length === 0) throw invalid("doc_fence: clients");
  if (o.clients.length > DOC_LIMITS.fenceClients) throw tooBig("fence_clients", DOC_LIMITS.fenceClients, "doc_fence: too many clients");
  const clients = o.clients.map((c) => {
    const x = fields(c, ["client", "target"], "doc_fence client");
    if (!isClient(x.client) || !isNat(x.target) || x.target < 1 || x.target > U32) throw invalid("doc_fence: a client and a target, 1 to 2^32 - 1");
    return { client: x.client, target: x.target };
  });
  if (new Set(clients.map((c) => c.client)).size !== clients.length) throw invalid("doc_fence: a client named twice");
  return withOwner({ t: "doc_fence" as const, req: o.req, doc: o.doc, clients }, o, "doc_fence");
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
export function checkSnapshot(v: unknown): Snapshot {
  const o = fields(v, ["t", "req", "doc", "at_seq", "sha256", "bytes", "owner"], "snapshot");
  if (o.t !== "snapshot" || !isNat(o.req) || !isDocId(o.doc) || !isNat(o.at_seq) || o.at_seq < 1 || !isSha(o.sha256) || !isNat(o.bytes))
    throw invalid("snapshot: t, req, doc, at_seq, sha256 and bytes");
  if (o.bytes > DOC_LIMITS.snapshotBytes) throw tooBig("snapshot_bytes", DOC_LIMITS.snapshotBytes, "snapshot: at most 32 MiB");
  return withOwner({ t: "snapshot" as const, req: o.req, doc: o.doc, at_seq: o.at_seq, sha256: o.sha256, bytes: o.bytes }, o, "snapshot");
}
const CELL = /^[^\u0000-\u001f\u007f]{1,128}$/;
export function checkOutputs(v: unknown): Outputs {
  const o = fields(v, ["t", "req", "doc", "oreq", "set", "owner"], "outputs");
  if (o.t !== "outputs" || !isNat(o.req) || !isDocId(o.doc)) throw invalid("outputs: t, req and doc");
  const r = fields(o.oreq, ["client", "n"], "outputs oreq");
  if (!isClient(r.client) || !isNat(r.n) || r.n < 1) throw invalid("outputs: oreq is a client and a positive n");
  if (!Array.isArray(o.set) || o.set.length === 0) throw invalid("outputs: set");
  if (o.set.length > DOC_LIMITS.outputsSet) throw tooBig("outputs_set", DOC_LIMITS.outputsSet, "outputs: too many cells");
  const set = o.set.map((s): OutputSet => {
    const x = fields(s, ["cell", "full", "preview"], "outputs cell");
    if (typeof x.cell !== "string" || !CELL.test(x.cell)) throw invalid("outputs: cell");
    const out: OutputSet = { cell: x.cell };
    if (has(x, "full")) {
      const f = fields(x.full, ["sha256", "size"], "outputs full");
      if (!isSha(f.sha256) || !isNat(f.size)) throw invalid("outputs: full");
      if (f.size > DOC_LIMITS.outputBytes) throw tooBig("output_bytes", DOC_LIMITS.outputBytes, "outputs: over 4 MiB; send a preview instead");
      out.full = { sha256: f.sha256, size: f.size };
    }
    if (has(x, "preview")) {
      const p = fields(x.preview, ["sha256", "size", "kind"], "outputs preview");
      if (!isSha(p.sha256) || !isNat(p.size) || (p.kind !== "text" && p.kind !== "png")) throw invalid("outputs: preview");
      if (p.size > DOC_LIMITS.previewBytes) throw tooBig("preview_bytes", DOC_LIMITS.previewBytes, "outputs: a preview is at most 256 KiB");
      out.preview = { sha256: p.sha256, size: p.size, kind: p.kind };
    }
    if (!out.full && !out.preview) throw invalid("outputs: a cell sets a full output or a preview");
    return out;
  });
  if (new Set(set.map((s) => s.cell)).size !== set.length) throw invalid("outputs: a cell set twice");
  return withOwner({ t: "outputs" as const, req: o.req, doc: o.doc, oreq: { client: r.client, n: r.n }, set }, o, "outputs");
}
export function checkProgress(v: unknown): Progress {
  const o = fields(v, ["t", "claims"], "progress");
  if (o.t !== "progress" || typeof o.claims !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(o.claims)) throw invalid("progress: claims are 32 bytes, base64");
  const bin = atob(o.claims), b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  decodeClaims(b);
  return { t: "progress", claims: b };
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
