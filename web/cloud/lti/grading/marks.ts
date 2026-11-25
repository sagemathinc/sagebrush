import { DOC_LIMITS, isCellId } from "../../../sync-protocol/doc-protocol.ts";

// Grading G2 r4 (b51b4a30) step 1: the pure pieces of manual grading, used by the Gradebook
// (G2 step 2) and the view (step 4). Points (§2.1), the rubric item codec and its slot sets
// (§2.2), the comment codec and its exact charge (§2.4), the basis check (§2.6), and the
// anonymity handle (§3.1). No storage, no I/O except WebCrypto for the handle.

// ---------------------------------------------------------------------------
// Points (§2.1): computed, never stored. All values are integer hundredths.

export const MAX_POINTS_C = 1_000_000;

export interface AppliedItem {
  points_c: number; // signed
  state: "active" | "retired";
}

// m_q = min(P, max(0, b + Σ active p_i + δ)), with b = 0 or P.
export function questionPoints(P: number, start: "zero" | "full", applied: readonly AppliedItem[], adjust_c: number): number {
  if (!Number.isSafeInteger(P) || P < 0 || P > MAX_POINTS_C) throw new RangeError("P: points_c of the question, 0..1,000,000");
  if (!Number.isSafeInteger(adjust_c) || Math.abs(adjust_c) > MAX_POINTS_C) throw new RangeError("adjust_c: |δ| ≤ 1,000,000");
  let sum = start === "full" ? P : 0;
  for (const it of applied) {
    if (!Number.isSafeInteger(it.points_c) || Math.abs(it.points_c) > MAX_POINTS_C) throw new RangeError("an item's points_c");
    if (it.state === "active") sum += it.points_c; // (a retired item counts 0)
  }
  sum += adjust_c;
  return Math.min(P, Math.max(0, sum));
}

// ---------------------------------------------------------------------------
// Slot sets: a grade's applied rubric slots 0..63, stored as 8 bytes (bit k of byte k >> 3).
// (8 bytes rather than a 64-bit INTEGER: Durable Object SQLite returns integers as JS numbers,
// which can't hold bit 63 exactly.)

export const MAX_SLOTS = 64;

export function encodeSlots(slots: readonly number[]): Uint8Array {
  const b = new Uint8Array(8);
  for (const s of slots) {
    if (!Number.isInteger(s) || s < 0 || s >= MAX_SLOTS) throw new RangeError(`slot ${s}: not 0..63`);
    b[s >> 3] |= 1 << (s & 7);
  }
  return b;
}

export function decodeSlots(b: ArrayBuffer | Uint8Array): number[] {
  // (the length is checked before anything is copied or viewed)
  if (b.byteLength !== 8) throw new RangeError("a slot set is 8 bytes");
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  const out: number[] = [];
  for (let s = 0; s < MAX_SLOTS; s++) if (u[s >> 3] & (1 << (s & 7))) out.push(s);
  return out;
}

// ---------------------------------------------------------------------------
// Codecs: hard widths; anything wider is refused, with the field named.

export class MarksError extends Error {}

const QID = /^[a-z0-9][a-z0-9_-]{0,31}$/; // G1 r5 §2.2's question id

function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

function text(v: unknown, what: string, min: number, max: number): string {
  if (typeof v !== "string" || v.length < min || v.length > max)
    throw new MarksError(`${what}: ${min}–${max} UTF-16 code units`);
  if (!wellFormed(v)) throw new MarksError(`${what}: ill-formed Unicode`);
  return v;
}

const utf8 = (s: string) => new TextEncoder().encode(s).length;

export interface RubricItem {
  question: string;
  slot: number;
  label: string;
  description: string;
  points_c: number;
  state: "active" | "retired";
  pos: number;
}

// The rubric item codec (§2.2): ≤ 3,829 B logical at the widths below.
export function validateRubricItem(v: unknown): RubricItem {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new MarksError("rubric item: not an object");
  const o = v as Record<string, unknown>;
  const keys = ["question", "slot", "label", "description", "points_c", "state", "pos"];
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new MarksError(`rubric item: unknown field "${k}"`);
  if (typeof o.question !== "string" || !QID.test(o.question)) throw new MarksError("rubric item: question id");
  if (!Number.isInteger(o.slot) || (o.slot as number) < 0 || (o.slot as number) >= MAX_SLOTS) throw new MarksError("rubric item: slot 0..63");
  if (!Number.isSafeInteger(o.points_c) || Math.abs(o.points_c as number) > MAX_POINTS_C)
    throw new MarksError("rubric item: points_c, |·| ≤ 1,000,000 hundredths");
  if (o.state !== "active" && o.state !== "retired") throw new MarksError("rubric item: state active or retired");
  if (!Number.isInteger(o.pos) || (o.pos as number) < 0 || (o.pos as number) > 0x7fffffff) throw new MarksError("rubric item: pos");
  return {
    question: o.question,
    slot: o.slot as number,
    label: text(o.label, "rubric item: label", 1, 200),
    description: text(o.description ?? "", "rubric item: description", 0, 1000),
    points_c: o.points_c as number,
    state: o.state,
    pos: o.pos as number,
  };
}

// ---------------------------------------------------------------------------
// Comments (§2.4)

export interface Comment {
  text: string; // Markdown
  reason: string; // the adjustment's reason
  anchors: string[]; // ≤ 8 cell ids: display hints only, checked by each reader's own allocation
}

// An anchor is any id the platform accepts as a cell id: sync's own isCellId (1 to
// DOC_LIMITS.cellId UTF-16 units, no control characters), imported so the two can't drift
// (CORR-MARKS-2). Board ids such as `answer:1`, `a@p1` or `x~2` are cell ids.
//
// Such ids may hold characters JSON escapes, so the charge counts the stored, escaped bytes,
// and the bound below is derived from the worst unit: a lone surrogate, escaped as \uXXXX
// (6 bytes). (A quote or backslash costs 2, other BMP characters at most 3.)
export const MAX_ANCHORS = 8;
export const ANCHORS_MAX_BYTES = 2 + MAX_ANCHORS * (2 + 6 * DOC_LIMITS.cellId) + (MAX_ANCHORS - 1);
export const REASON_MAX_BYTES = 3 * 200; // 200 UTF-16 units, at most 3 UTF-8 bytes each
export const KEYS_MAX_BYTES = 64 + 32 + 64; // the wire's ASCII widths of member, question and cid

export function validateComment(v: unknown, commentChars: number): Comment {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new MarksError("comment: not an object");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["text", "reason", "anchors"].includes(k)) throw new MarksError(`comment: unknown field "${k}"`);
  const anchors = o.anchors ?? [];
  if (!Array.isArray(anchors) || anchors.length > MAX_ANCHORS) throw new MarksError(`comment: anchors, at most ${MAX_ANCHORS} cell ids`);
  for (const a of anchors) if (!isCellId(a)) throw new MarksError(`comment: an anchor isn't a cell id (1–${DOC_LIMITS.cellId} characters, no control characters)`);
  return {
    text: text(o.text ?? "", "comment: text", 0, commentChars),
    reason: text(o.reason ?? "", "comment: reason", 0, 200),
    anchors: [...(anchors as string[])],
  };
}

// The exact charge of a comment row: 1,024 B + 2 × its stored UTF-8 bytes (the text, the
// reason, the anchors as JSON, and its key). At the maxima this is ≤ maxCommentCharge.
export function commentCharge(c: Comment, key: { member: string; question: string; cid: string }): number {
  const bytes =
    utf8(c.text) + utf8(c.reason) + utf8(JSON.stringify(c.anchors)) + utf8(key.member) + utf8(key.question) + utf8(key.cid);
  return 1024 + 2 * bytes;
}

// 1,024 + 2 × (3 × comment_chars + 600 + 6,169 + 160) with DOC_LIMITS.cellId = 128. (G2 r4 §6's
// "+ 1,360" assumed 64-character ASCII anchors; the admin write's cross-field rule uses this.)
export const maxCommentCharge = (commentChars: number) =>
  1024 + 2 * (3 * commentChars + REASON_MAX_BYTES + ANCHORS_MAX_BYTES + KEYS_MAX_BYTES);

// ---------------------------------------------------------------------------
// The basis (§2.6): what the grader's own view verified or replayed.

export type Slot = "verified" | "built" | "alternate";

export interface BasisRow {
  outcome: "verified" | "failed_resource" | "failed_integrity";
  value_sha256: string | null; // hex, verified only
  census_sha256: string | null;
}

export interface RebuildSlots {
  state: "open" | "built" | "conflict";
  first: { value_sha256: string; census_sha256: string } | null;
  second: { value_sha256: string; census_sha256: string } | null;
}

export function checkBasis(row: BasisRow, rebuild: RebuildSlots | null, basis: { value_sha256: string; census_sha256: string }): Slot | null {
  const eq = (x: { value_sha256: string | null; census_sha256: string | null } | null) =>
    x !== null && x.value_sha256 === basis.value_sha256 && x.census_sha256 === basis.census_sha256;
  if (row.outcome === "verified") return eq(row) ? "verified" : null;
  if (row.outcome === "failed_resource" && rebuild && rebuild.state !== "open") {
    if (eq(rebuild.first)) return "built";
    if (rebuild.state === "conflict" && eq(rebuild.second)) return "alternate";
  }
  return null; // (an open rebuild, failed_integrity, or no slot matching: not gradable)
}

// ---------------------------------------------------------------------------
// The anonymity handle (§3.1): HMAC-SHA256(s, member) truncated to 128 bits.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export async function memberHandle(secret: Uint8Array, member: string): Promise<Uint8Array> {
  if (secret.length !== 32) throw new RangeError("the anonymity secret is 32 bytes");
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(member)));
  return mac.slice(0, 16);
}

// "Student" plus the first 8 base32 characters of h (RFC 4648 alphabet).
export function handleLabel(h: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of h) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 8) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length === 8) break;
  }
  return `Student ${out}`;
}
