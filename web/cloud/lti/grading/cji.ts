// The Course → Gradebook wire, v1: /scratch/sync-docs/wire-course-gradebook-v1.md (sha256
// 4cf9176a…), derived from sync r9 §6.7.5, A1–A4, 2h-i r6 and grading G1 r5 §3.1–3.2.
//
// One module for both sides: Course imports it to build what it sends, the Gradebook to
// validate what it receives. Plain JSON-safe objects; unknown fields are refused at every
// level (v1 is closed).

export type Hex64 = string;

export interface Envelope {
  course_epoch: number; // u32, captured at admission (A4)
}

export type Outcome = "verified" | "failed_resource" | "failed_integrity";
export type FailureReason = "too_large" | "budget" | "invalid_value";
export type CollectionReason = "deadline" | "extension" | "late_accepted";

export interface Seal {
  epoch: number;
  at_seq: number;
  chain: Hex64;
  frozen_head: number;
  late: boolean; // === frozen_head > at_seq
  outcome: Outcome;
  reason?: FailureReason; // exactly when outcome !== "verified"
}

export interface Blob {
  sha256: Hex64;
  bytes: number;
}

export interface CJI {
  cid: string;
  course_key: string;
  placement_key: string;
  member: string;
  owner: string;
  doc: string;
  n: number;
  reason: CollectionReason;
  d: number;
  rev: { drev: number; xrev: number };
  binding: { aid: string; assignment_rev: number; bundle_sha: Hex64 };
  seal: Seal;
  value?: Blob; // the three exactly when verified
  census?: Blob;
  outputs_digest?: Hex64;
}

export interface Triple {
  value_sha256: Hex64;
  census_sha256: Hex64;
  outputs_digest: Hex64;
  by: string;
  at: number;
}

export type Rebuilt =
  | { cid: string; state: "built"; built: Triple }
  | { cid: string; state: "conflict"; first: Triple; second: Triple };

export type FullLimit = "gradebook_bytes" | "members" | "collections_per_member";

export type Answer =
  | { ack: true }
  | { full: { limit: FullLimit } }
  | { invalid: { reason: string } }
  | { purged: true }
  | { retry: { after_ms: number } };

export const OUTCOMES: readonly Outcome[] = ["verified", "failed_resource", "failed_integrity"];
export const FAILURE_REASONS: readonly FailureReason[] = ["too_large", "budget", "invalid_value"];
export const COLLECTION_REASONS: readonly CollectionReason[] = ["deadline", "extension", "late_accepted"];
const FAILURES: Record<Outcome, readonly FailureReason[]> = {
  verified: [],
  failed_resource: ["too_large", "budget"],
  failed_integrity: ["invalid_value"],
};

export type WireCode = "width" | "enum" | "inconsistent" | "unknown_field";

export class WireError extends Error {
  readonly code: WireCode;
  constructor(code: WireCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Field checks

type Obj = Record<string, unknown>;

function obj(v: unknown, where: string, required: readonly string[], optional: readonly string[] = []): Obj {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new WireError("width", `${where}: not an object`);
  const o = v as Obj;
  for (const k of Object.keys(o))
    if (!required.includes(k) && !optional.includes(k)) throw new WireError("unknown_field", `${where}.${k}`);
  for (const k of required) if (!(k in o)) throw new WireError("width", `${where}.${k}: missing`);
  return o;
}

export function key(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 64 || !/^[\x21-\x7e]+$/.test(v))
    throw new WireError("width", `${where}: not 1–64 printable ASCII characters`);
  return v;
}

export function u32(v: unknown, where: string): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > 0xffffffff) throw new WireError("width", `${where}: not a u32`);
  return v as number;
}

export function int(v: unknown, where: string): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new WireError("width", `${where}: not a safe non-negative integer`);
  return v as number;
}

export function hex64(v: unknown, where: string): Hex64 {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw new WireError("width", `${where}: not 64 lowercase hex characters`);
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], where: string): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new WireError("enum", `${where}: not one of ${allowed.join(", ")}`);
  return v as T;
}

function blob(v: unknown, where: string): Blob {
  const o = obj(v, where, ["sha256", "bytes"]);
  return { sha256: hex64(o.sha256, `${where}.sha256`), bytes: int(o.bytes, `${where}.bytes`) };
}

export function validateEnvelope(v: unknown): Envelope {
  const o = obj(v, "envelope", ["course_epoch"]);
  return { course_epoch: u32(o.course_epoch, "envelope.course_epoch") };
}

// G1 §3.2 step 1: widths, enums, and the consistency of outcome, hashes, reason and late.
export function validateCJI(v: unknown): CJI {
  const o = obj(
    v,
    "cji",
    ["cid", "course_key", "placement_key", "member", "owner", "doc", "n", "reason", "d", "rev", "binding", "seal"],
    ["value", "census", "outputs_digest"],
  );
  const rev = obj(o.rev, "cji.rev", ["drev", "xrev"]);
  const b = obj(o.binding, "cji.binding", ["aid", "assignment_rev", "bundle_sha"]);
  const s = obj(o.seal, "cji.seal", ["epoch", "at_seq", "chain", "frozen_head", "late", "outcome"], ["reason"]);
  const outcome = oneOf(s.outcome, OUTCOMES, "cji.seal.outcome");
  const seal: Seal = {
    epoch: u32(s.epoch, "cji.seal.epoch"),
    at_seq: int(s.at_seq, "cji.seal.at_seq"),
    chain: hex64(s.chain, "cji.seal.chain"),
    frozen_head: int(s.frozen_head, "cji.seal.frozen_head"),
    late: typeof s.late === "boolean" ? s.late : (() => { throw new WireError("width", "cji.seal.late: not a boolean"); })(),
    outcome,
  };
  if (seal.late !== seal.frozen_head > seal.at_seq) throw new WireError("inconsistent", "cji.seal.late !== (frozen_head > at_seq)");
  const verified = outcome === "verified";
  if (verified) {
    if ("reason" in s) throw new WireError("inconsistent", "cji.seal.reason: only for a failure");
  } else {
    if (!("reason" in s)) throw new WireError("inconsistent", "cji.seal.reason: required for a failure");
    seal.reason = oneOf(s.reason, FAILURES[outcome], "cji.seal.reason");
  }
  const has = ["value", "census", "outputs_digest"].map((k) => k in o);
  if (verified ? has.includes(false) : has.includes(true))
    throw new WireError("inconsistent", "value, census and outputs_digest must be present exactly for verified");
  const cji: CJI = {
    cid: key(o.cid, "cji.cid"),
    course_key: key(o.course_key, "cji.course_key"),
    placement_key: key(o.placement_key, "cji.placement_key"),
    member: key(o.member, "cji.member"),
    owner: key(o.owner, "cji.owner"),
    doc: key(o.doc, "cji.doc"),
    n: u32(o.n, "cji.n"),
    reason: oneOf(o.reason, COLLECTION_REASONS, "cji.reason"),
    d: int(o.d, "cji.d"),
    rev: { drev: u32(rev.drev, "cji.rev.drev"), xrev: u32(rev.xrev, "cji.rev.xrev") },
    binding: {
      aid: key(b.aid, "cji.binding.aid"),
      assignment_rev: u32(b.assignment_rev, "cji.binding.assignment_rev"),
      bundle_sha: hex64(b.bundle_sha, "cji.binding.bundle_sha"),
    },
    seal,
  };
  if (verified) {
    cji.value = blob(o.value, "cji.value");
    cji.census = blob(o.census, "cji.census");
    cji.outputs_digest = hex64(o.outputs_digest, "cji.outputs_digest");
  }
  return cji;
}

function triple(v: unknown, where: string): Triple {
  const o = obj(v, where, ["value_sha256", "census_sha256", "outputs_digest", "by", "at"]);
  return {
    value_sha256: hex64(o.value_sha256, `${where}.value_sha256`),
    census_sha256: hex64(o.census_sha256, `${where}.census_sha256`),
    outputs_digest: hex64(o.outputs_digest, `${where}.outputs_digest`),
    by: key(o.by, `${where}.by`),
    at: int(o.at, `${where}.at`),
  };
}

export function validateRebuilt(v: unknown): Rebuilt {
  const head = obj(v, "msg", ["cid", "state"], ["built", "first", "second"]);
  const state = oneOf(head.state, ["built", "conflict"] as const, "msg.state");
  if (state === "built") {
    const o = obj(v, "msg", ["cid", "state", "built"]);
    return { cid: key(o.cid, "msg.cid"), state, built: triple(o.built, "msg.built") };
  }
  const o = obj(v, "msg", ["cid", "state", "first", "second"]);
  return { cid: key(o.cid, "msg.cid"), state, first: triple(o.first, "msg.first"), second: triple(o.second, "msg.second") };
}

// The canonical encoding of a validated CJI (JCS-style: keys sorted by UTF-16 code units).
// The Gradebook keeps its SHA-256, so a duplicate delivery is compared on every field.
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Obj;
  return (
    "{" +
    Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((k) => JSON.stringify(k) + ":" + canonical(o[k]))
      .join(",") +
    "}"
  );
}
