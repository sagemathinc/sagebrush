// Grading G2 r4 (b51b4a30) step 2: the Gradebook's manual-grading tables, beside G1's in the
// same Durable Object (§0.1, §2): the `settings` row with `rev_seq` and the exact charge
// counters (§2.0), the rubric (§2.2), grade rows and their comments (§2.3–2.4), the counted
// collection (§2.5) and the basis check (§2.6), and G2's limits (§6). Release (§4) has its
// table here and its writes in step 6; anonymity (§3) uses `settings` and `members.handle` and
// lands in step 5; the teardown steps (§5) in step 7.
//
// Every operation runs inside one Gradebook storage transaction (the caller's): the epoch fence,
// the compare-and-set, the limits and both counters are decided and written together, so a
// refusal writes nothing and a crash leaves neither the rows nor the counters (§2.0).

import { hex64, key, u32, WireError } from "./cji.ts";
import {
  checkBasis,
  type Comment,
  commentCharge,
  decodeSlots,
  encodeSlots,
  MarksError,
  MAX_POINTS_C,
  MAX_SLOTS,
  maxCommentCharge,
  validateComment,
  validateRubricItem,
} from "./marks.ts";

// ---------------------------------------------------------------------------
// Charges (§2.2–§4.2), proven by the grades-size fixture. A comment's is commentCharge().

export const G2_CHARGE = {
  settings: 1024,
  rubric_item: 8192,
  rubric_question: 256,
  grade: 1024,
  member_choice: 256,
  release: 256,
  spec: 8192, // addendum A1 r5 §A1.1
  spec_outcome: 256, // A1.2c
} as const;

// ---------------------------------------------------------------------------
// Limits (§6): {default, min (the floor), max (the ceiling)}, the same record as G1's.

const MiB = 1024 * 1024;
export const G2_LIMITS = {
  "grading.grades_bytes": { default: 512 * MiB, min: 4 * MiB, max: 4096 * MiB },
  "grading.comment_bytes": { default: 64 * MiB, min: 1 * MiB, max: 768 * MiB },
  "grading.grades_per_member": { default: 60, min: 1, max: 160 },
  "grading.comment_chars": { default: 4000, min: 200, max: 16000 },
  "grading.rubric_items_per_question": { default: 32, min: 1, max: 64 },
  "grading.rubric_items_per_placement": { default: 960, min: 1, max: 6400 },
  "grading.writes_per_minute_session": { default: 120, min: 10, max: 600 },
  "grading.writes_per_minute_placement": { default: 1200, min: 60, max: 6000 },
  "grading.student_reads_per_minute": { default: 6, min: 1, max: 60 },
  "grading.summary_page_members": { default: 250, min: 25, max: 500 },
  "grading.specs_per_placement": { default: 16, min: 1, max: 64 }, // A1.4
} as const;

// §6's cross-field rules, checked at the admin write of the limits record (each value already
// in its [floor, ceiling]). Returns the violated rules; empty when the record is acceptable.
export function gradingLimitErrors(eff: Record<string, number>): string[] {
  const g = (k: keyof typeof G2_LIMITS) => eff[k] ?? G2_LIMITS[k].default;
  const errors: string[] = [];
  if (g("grading.comment_bytes") > g("grading.grades_bytes")) errors.push("comment_bytes ≤ grades_bytes");
  if (maxCommentCharge(g("grading.comment_chars")) > g("grading.comment_bytes"))
    errors.push("one maximal comment fits: maxCommentCharge(comment_chars) ≤ comment_bytes");
  if (g("grading.rubric_items_per_question") > MAX_SLOTS) errors.push("rubric_items_per_question ≤ 64");
  if (g("grading.writes_per_minute_session") > g("grading.writes_per_minute_placement"))
    errors.push("writes_per_minute_session ≤ writes_per_minute_placement");
  return errors;
}

// ---------------------------------------------------------------------------
// Schema. Every table has an index on (course_epoch, key) for §5's teardown pages.

export const G2_SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  k INTEGER PRIMARY KEY CHECK (k = 0),
  secret BLOB NOT NULL, anon_state INTEGER NOT NULL, anon_rev INTEGER NOT NULL,
  category INTEGER, release_mode INTEGER,
  rev_seq INTEGER NOT NULL, grades_charged INTEGER NOT NULL, comment_charged INTEGER NOT NULL,
  toggle_hw INTEGER NOT NULL, toggle_ledger BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS rubric_questions (
  question TEXT PRIMARY KEY, start INTEGER NOT NULL, rev INTEGER NOT NULL, course_epoch INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS rubric_questions_epoch ON rubric_questions (course_epoch, question);
CREATE TABLE IF NOT EXISTS rubric_items (
  question TEXT NOT NULL, slot INTEGER NOT NULL, label TEXT NOT NULL, description TEXT NOT NULL,
  points_c INTEGER NOT NULL, state INTEGER NOT NULL, pos INTEGER NOT NULL, by TEXT NOT NULL,
  at_ms INTEGER NOT NULL, rev INTEGER NOT NULL, course_epoch INTEGER NOT NULL,
  PRIMARY KEY (question, slot)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS rubric_items_epoch ON rubric_items (course_epoch, question, slot);
CREATE TABLE IF NOT EXISTS grades (
  member TEXT NOT NULL, question TEXT NOT NULL, cid TEXT NOT NULL, state INTEGER NOT NULL,
  items BLOB NOT NULL, adjust_c INTEGER NOT NULL, basis_value BLOB, basis_census BLOB, slot INTEGER,
  has_comment INTEGER NOT NULL, grader TEXT NOT NULL, at_ms INTEGER NOT NULL, rev INTEGER NOT NULL,
  course_epoch INTEGER NOT NULL,
  PRIMARY KEY (member, question, cid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS grades_question ON grades (question, member);
CREATE INDEX IF NOT EXISTS grades_epoch ON grades (course_epoch, member, question, cid);
CREATE TABLE IF NOT EXISTS comments (
  member TEXT NOT NULL, question TEXT NOT NULL, cid TEXT NOT NULL,
  text TEXT NOT NULL, reason TEXT NOT NULL, anchors TEXT NOT NULL, course_epoch INTEGER NOT NULL,
  PRIMARY KEY (member, question, cid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS comments_epoch ON comments (course_epoch, member, question, cid);
CREATE TABLE IF NOT EXISTS member_choice (
  member TEXT PRIMARY KEY, cid TEXT, by TEXT NOT NULL, at_ms INTEGER NOT NULL, rev INTEGER NOT NULL,
  course_epoch INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS member_choice_epoch ON member_choice (course_epoch, member);
CREATE TABLE IF NOT EXISTS release (
  scope TEXT PRIMARY KEY, state INTEGER NOT NULL, by TEXT NOT NULL, at_ms INTEGER NOT NULL,
  rev INTEGER NOT NULL, course_epoch INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS release_epoch ON release (course_epoch, scope);
-- addendum A1 r5: a bundle's spec questions (Course-written, immutable), and the recorded
-- outcome of a failed hydration (A1.2c)
CREATE TABLE IF NOT EXISTS specs (
  bundle_sha BLOB PRIMARY KEY, questions TEXT NOT NULL, state INTEGER NOT NULL, course_epoch INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS specs_epoch ON specs (course_epoch, bundle_sha);
CREATE TABLE IF NOT EXISTS spec_outcomes (
  bundle_sha BLOB PRIMARY KEY, outcome INTEGER NOT NULL, reason TEXT NOT NULL, limits_version INTEGER NOT NULL,
  attempts INTEGER NOT NULL, next_try INTEGER NOT NULL, at_ms INTEGER NOT NULL, course_epoch INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS spec_outcomes_epoch ON spec_outcomes (course_epoch, bundle_sha);
`;

// The settings row, created with the Gradebook (and, after a purge, by the first G2 operation)
// with a fresh 32-byte anonymity secret and its own 1,024 B already in grades_charged (§3.1).
export const SETTINGS_INSERT = `INSERT OR IGNORE INTO settings
  (k, secret, anon_state, anon_rev, rev_seq, grades_charged, comment_charged, toggle_hw, toggle_ledger)
  VALUES (0, ?, 0, 0, 0, ${G2_CHARGE.settings}, 0, 0, x'')`;

export const newSecret = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

// ---------------------------------------------------------------------------
// The envelope Course forwards (§1.1). The Gradebook takes the actor, the role, staff, the
// session handle and the epoch only from here, never from the request body.

export interface GradingEnvelope {
  course_epoch: number;
  actor: string; // the internal key
  role: "instructor" | "learner";
  staff: "instructor" | "ta" | null; // null exactly for a learner
  session: string; // the session's random 128-bit handle, 32 lowercase hex
}

function exact(v: unknown, where: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new WireError("width", `${where}: not an object`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!keys.includes(k) && !optional.includes(k)) throw new WireError("unknown_field", `${where}.${k}`);
  for (const k of keys) if (!(k in o)) throw new WireError("width", `${where}.${k}: missing`);
  return o;
}

export function validateGradingEnvelope(v: unknown): GradingEnvelope {
  const o = exact(v, "envelope", ["course_epoch", "actor", "role", "staff", "session"]);
  const role = o.role;
  if (role !== "instructor" && role !== "learner") throw new WireError("enum", "envelope.role");
  const staff = o.staff;
  if (role === "instructor" ? staff !== "instructor" && staff !== "ta" : staff !== null)
    throw new WireError("inconsistent", "envelope.staff: instructor or ta exactly for the instructor role");
  if (typeof o.session !== "string" || !/^[0-9a-f]{32}$/.test(o.session)) throw new WireError("width", "envelope.session: 32 lowercase hex");
  return {
    course_epoch: u32(o.course_epoch, "envelope.course_epoch"),
    actor: key(o.actor, "envelope.actor"),
    role,
    staff: staff as GradingEnvelope["staff"],
    session: o.session,
  };
}

// ---------------------------------------------------------------------------
// Answers

export type GradingFull =
  | "grades_bytes"
  | "comment_bytes"
  | "grades_per_member"
  | "rubric_items_per_question"
  | "rubric_items_per_placement"
  | "specs_per_placement";

export type GradingAnswer<T = unknown> =
  | { ok: { rev: number } }
  | { spec_needed: { bundle_sha: string } }
  | { spec_integrity: { bundle_sha: string } }
  | { spec_unavailable: { bundle_sha: string; reason: string } }
  | { conflict: { current: T } }
  | { full: { limit: GradingFull } }
  | { invalid: { reason: string } }
  | { stale_rubric: true }
  | { forbidden: true }
  | { purged: true }
  | { retry: { after_ms: number } };

export class Refusal extends Error {
  constructor(readonly answer: GradingAnswer) {
    super("refused");
  }
}
const refuse = (a: GradingAnswer): never => {
  throw new Refusal(a);
};
const bad = (reason: string): never => refuse({ invalid: { reason } });

// ---------------------------------------------------------------------------
// Request codecs (before any transaction)

const QID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const question = (v: unknown, where: string): string => {
  if (typeof v !== "string" || !QID.test(v)) bad(`${where}: a question id`);
  return v as string;
};
export function parseQuestionId(v: unknown): string {
  return question(v, "question");
}
const baseRev = (v: unknown): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) bad("base_rev: a non-negative integer");
  return v as number;
};
const wire = <T>(f: () => T, what: string): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof WireError || e instanceof MarksError || e instanceof RangeError) return bad(`${what}: ${e.message}`);
    throw e;
  }
};

export interface GradeKey {
  member: string;
  question: string;
  cid: string;
}

export interface GradeRequest extends GradeKey {
  base_rev: number;
  items: number[];
  adjust_c: number;
  basis: { value_sha256: string; census_sha256: string };
  // absent: keep the grade's comment; null: remove it; an object: set it
  comment?: Comment | null;
}

function gradeKey(o: Record<string, unknown>): GradeKey {
  return {
    member: wire(() => key(o.member, "member"), "member"),
    question: question(o.question, "question"),
    cid: wire(() => key(o.cid, "cid"), "cid"),
  };
}

export function parseGradeRequest(v: unknown, commentChars: number): GradeRequest {
  const o = wire(() => exact(v, "grade", ["member", "question", "cid", "base_rev", "items", "adjust_c", "basis"], ["comment"]), "grade");
  const items = o.items;
  if (!Array.isArray(items) || items.length > MAX_SLOTS) bad("items: at most 64 slots");
  const slots = new Set<number>();
  for (const s of items as unknown[]) {
    if (!Number.isInteger(s) || (s as number) < 0 || (s as number) >= MAX_SLOTS) bad("items: slots 0..63");
    if (slots.has(s as number)) bad("items: a slot twice");
    slots.add(s as number);
  }
  if (!Number.isSafeInteger(o.adjust_c) || Math.abs(o.adjust_c as number) > MAX_POINTS_C) bad("adjust_c: |δ| ≤ 1,000,000");
  const b = wire(() => exact(o.basis, "basis", ["value_sha256", "census_sha256"]), "basis");
  const out: GradeRequest = {
    ...gradeKey(o),
    base_rev: baseRev(o.base_rev),
    items: [...slots].sort((x, y) => x - y),
    adjust_c: o.adjust_c as number,
    basis: { value_sha256: wire(() => hex64(b.value_sha256, "basis.value_sha256"), "basis"), census_sha256: wire(() => hex64(b.census_sha256, "basis.census_sha256"), "basis") },
  };
  if ("comment" in o) out.comment = o.comment === null ? null : wire(() => validateComment(o.comment, commentChars), "comment");
  return out;
}

export function parseUngradeRequest(v: unknown): GradeKey & { base_rev: number } {
  const o = wire(() => exact(v, "ungrade", ["member", "question", "cid", "base_rev"]), "ungrade");
  return { ...gradeKey(o), base_rev: baseRev(o.base_rev) };
}

export function parseChoiceRequest(v: unknown): { member: string; cid: string | null; base_rev: number } {
  const o = wire(() => exact(v, "choice", ["member", "cid", "base_rev"]), "choice");
  return {
    member: wire(() => key(o.member, "member"), "member"),
    cid: o.cid === null ? null : wire(() => key(o.cid, "cid"), "cid"),
    base_rev: baseRev(o.base_rev),
  };
}

export type RubricOp =
  | { add: { label: string; description: string; points_c: number } }
  | { edit: { slot: number; label?: string; description?: string; points_c?: number } }
  | { retire: { slot: number } }
  | { restore: { slot: number } }
  | { reorder: { slots: number[] } }
  | { start: "zero" | "full" };

const slotOf = (v: unknown): number => {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= MAX_SLOTS) bad("slot: 0..63");
  return v as number;
};

// Field checks through step 1's item codec, so the widths can't drift from it. A field that is
// present is checked exactly as supplied (an explicit null is refused, never replaced: astra2's
// CORR-CLOUD14-2); only an absent one takes a placeholder, and the caller then ignores it.
function itemFields(q: string, f: Record<string, unknown>, placeholders: { label?: string; description?: string; points_c?: number }) {
  const pick = (k: "label" | "description" | "points_c") => {
    if (k in f) {
      if (f[k] === null || f[k] === undefined) bad(`rubric item: ${k} can't be null`);
      return f[k];
    }
    if (!(k in placeholders)) bad(`rubric item: ${k} is required`);
    return placeholders[k];
  };
  const it = wire(
    () => validateRubricItem({ question: q, slot: 0, label: pick("label"), description: pick("description"), points_c: pick("points_c"), state: "active", pos: 0 }),
    "rubric item",
  );
  return { label: it.label, description: it.description, points_c: it.points_c };
}

export function parseRubricRequest(v: unknown): { question: string; base_rev: number; op: RubricOp } {
  const o = wire(() => exact(v, "rubric", ["question", "base_rev", "op"]), "rubric");
  const q = question(o.question, "question");
  const raw = o.op;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1) bad("op: exactly one of add, edit, retire, restore, reorder, start");
  const [kind, body] = Object.entries(raw as Record<string, unknown>)[0];
  let op: RubricOp;
  if (kind === "add") {
    const f = wire(() => exact(body, "add", ["label", "points_c"], ["description"]), "add");
    op = { add: itemFields(q, f, { description: "" }) };
  } else if (kind === "edit") {
    const f = wire(() => exact(body, "edit", ["slot"], ["label", "description", "points_c"]), "edit");
    const e: { slot: number; label?: string; description?: string; points_c?: number } = { slot: slotOf(f.slot) };
    if (!("label" in f) && !("description" in f) && !("points_c" in f)) bad("edit: nothing to change");
    // (each given field through the codec as supplied; placeholders only for the absent ones,
    // which the write leaves unchanged)
    const checked = itemFields(q, f, { label: "x", description: "", points_c: 0 });
    if ("label" in f) e.label = checked.label;
    if ("description" in f) e.description = checked.description;
    if ("points_c" in f) e.points_c = checked.points_c;
    op = { edit: e };
  } else if (kind === "retire" || kind === "restore") {
    const f = wire(() => exact(body, kind, ["slot"]), kind);
    op = kind === "retire" ? { retire: { slot: slotOf(f.slot) } } : { restore: { slot: slotOf(f.slot) } };
  } else if (kind === "reorder") {
    const f = wire(() => exact(body, "reorder", ["slots"]), "reorder");
    if (!Array.isArray(f.slots) || f.slots.length > MAX_SLOTS) bad("reorder: at most 64 slots");
    const slots = (f.slots as unknown[]).map(slotOf);
    if (new Set(slots).size !== slots.length) bad("reorder: a slot twice");
    op = { reorder: { slots } };
  } else if (kind === "start") {
    if (body !== "zero" && body !== "full") bad("start: zero or full");
    op = { start: body as "zero" | "full" };
  } else return bad(`op: unknown "${kind}"`);
  return { question: q, base_rev: baseRev(o.base_rev), op };
}

// ---------------------------------------------------------------------------
// Row shapes, as answered

const START = ["zero", "full"] as const;
const ITEM_STATE = ["active", "retired"] as const;
const GRADE_STATE = ["graded", "ungraded"] as const;
const SLOT = ["verified", "built", "alternate"] as const;

export interface RubricView {
  question: string;
  start: "zero" | "full";
  rev: number;
  items: { slot: number; label: string; description: string; points_c: number; state: "active" | "retired"; pos: number; by: string; at_ms: number; rev: number }[];
}

export interface GradeView extends GradeKey {
  state: "graded" | "ungraded";
  items: number[];
  adjust_c: number;
  basis: { value_sha256: string; census_sha256: string } | null;
  slot: "verified" | "built" | "alternate" | null;
  comment: Comment | null;
  grader: string;
  at_ms: number;
  rev: number;
}

export interface ChoiceView {
  member: string;
  cid: string | null;
  by: string;
  at_ms: number;
  rev: number;
}

const hex = (b: ArrayBuffer | null): string | null => (b == null ? null : [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""));
const unhex = (h: string): Uint8Array => {
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return b;
};

// ---------------------------------------------------------------------------
// The operations. `G2` is constructed by the Gradebook per transaction, over its instrumented
// exec(); every method is called inside that transaction and throws Refusal to answer early.

type Exec = (query: string, ...args: unknown[]) => SqlStorageCursor<Record<string, SqlStorageValue>>;

// ---------------------------------------------------------------------------
// Specs (addendum A1 r5): the questions of a bundle's grading.json, put by Course from its
// trusted bundle read; and the outcome of a failed hydration with its retry rule (A1.2c).

export const SPEC_STATE = { ok: 0, integrity_failed: 1 } as const;
export const OUTCOMES = ["unreadable", "invalid_spec", "full", "retry"] as const;
export type SpecOutcome = (typeof OUTCOMES)[number];
const NEVER = Number.MAX_SAFE_INTEGER;

// [id, points_c] pairs: 1 to 100 (G1's ceiling of questions_per_assignment), ids distinct.
export function parseSpecQuestions(v: unknown): [string, number][] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 100) bad("questions: 1 to 100 [id, points_c] pairs");
  const seen = new Set<string>();
  const out: [string, number][] = [];
  for (const p of v as unknown[]) {
    if (!Array.isArray(p) || p.length !== 2) bad("questions: each a [id, points_c] pair");
    const [id, pts] = p as [unknown, unknown];
    const q = question(id, "questions: id");
    if (!Number.isSafeInteger(pts) || (pts as number) < 0 || (pts as number) > MAX_POINTS_C) bad("questions: points_c 0..1,000,000");
    if (seen.has(q)) bad("questions: an id twice");
    seen.add(q);
    out.push([q, pts as number]);
  }
  return out;
}

// When a recorded outcome may be tried again (A1.2c), and the next try after one more attempt.
export function outcomeDue(o: { outcome: number; reason: string; limits_version: number; next_try: number }, now: number, limitsVersion: number, room: number): boolean {
  const kind = OUTCOMES[o.outcome];
  if (kind === "invalid_spec") return false;
  if (kind === "full") return o.reason === "grades_bytes" ? room >= G2_CHARGE.spec - G2_CHARGE.spec_outcome : limitsVersion > o.limits_version;
  return now >= o.next_try;
}
export function nextTry(kind: SpecOutcome, attempts: number, now: number): number {
  if (kind === "unreadable") return now + Math.min(3_600_000, 60_000 * 2 ** Math.min(attempts - 1, 20));
  if (kind === "retry") return now + Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 20));
  return NEVER; // invalid_spec never; full by its own condition
}

interface SettingsRow {
  rev_seq: number;
  grades_charged: number;
  comment_charged: number;
}

export class G2 {
  constructor(
    private readonly exec: Exec,
    private readonly env: GradingEnvelope,
    private readonly lim: Record<string, number>,
    private readonly limitsVersion: number,
    private readonly now: number,
  ) {}

  // §1.1's fence, inside the operation's own transaction.
  fence(epochFloor: number): void {
    if (this.env.course_epoch < epochFloor) refuse({ purged: true });
  }

  staffOnly(): void {
    if (this.env.role !== "instructor") refuse({ forbidden: true });
  }

  private settings(): SettingsRow {
    this.exec(SETTINGS_INSERT, newSecret());
    return this.exec("SELECT rev_seq, grades_charged, comment_charged FROM settings WHERE k = 0").one() as unknown as SettingsRow;
  }

  // §2.0: every mutation takes rev = ++rev_seq once, and applies its charge delta with it.
  private commit(s: SettingsRow, delta: number, deltaComment: number): number {
    if (delta > 0 && s.grades_charged + delta > this.lim["grading.grades_bytes"]) refuse({ full: { limit: "grades_bytes" } });
    if (deltaComment > 0 && s.comment_charged + deltaComment > this.lim["grading.comment_bytes"]) refuse({ full: { limit: "comment_bytes" } });
    const r = this.exec(
      `UPDATE settings SET rev_seq = rev_seq + 1, grades_charged = grades_charged + ?, comment_charged = comment_charged + ?
         WHERE k = 0 RETURNING rev_seq`,
      delta,
      deltaComment,
    ).one() as { rev_seq: number };
    return r.rev_seq;
  }

  // A row from an older epoch is still being torn down (§5): retry later rather than compare.
  private sameEpoch(rowEpoch: number): boolean {
    if (rowEpoch < this.env.course_epoch) refuse({ retry: { after_ms: 1000 } });
    return rowEpoch === this.env.course_epoch;
  }

  // ----- the rubric (§2.2) ------------------------------------------------

  rubric(q: string): RubricView {
    const r = this.exec("SELECT start, rev FROM rubric_questions WHERE question = ?", q).toArray()[0] as { start: number; rev: number } | undefined;
    const items = this.exec(
      "SELECT slot, label, description, points_c, state, pos, by, at_ms, rev FROM rubric_items WHERE question = ? ORDER BY pos, slot",
      q,
    ).toArray() as { slot: number; label: string; description: string; points_c: number; state: number; pos: number; by: string; at_ms: number; rev: number }[];
    return {
      question: q,
      start: START[r?.start ?? 0],
      rev: r?.rev ?? 0,
      items: items.map((i) => ({ ...i, state: ITEM_STATE[i.state] })),
    };
  }

  rubricWrite(req: { question: string; base_rev: number; op: RubricOp }): GradingAnswer {
    this.staffOnly();
    const q = req.question;
    const row = this.exec("SELECT rev, course_epoch FROM rubric_questions WHERE question = ?", q).toArray()[0] as { rev: number; course_epoch: number } | undefined;
    if (row ? !this.sameEpoch(row.course_epoch) || row.rev !== req.base_rev : req.base_rev !== 0)
      return { conflict: { current: this.rubric(q) } };
    const items = this.exec("SELECT slot, state, pos FROM rubric_items WHERE question = ?", q).toArray() as { slot: number; state: number; pos: number }[];
    const has = (slot: number) => items.find((i) => i.slot === slot);
    const s = this.settings();
    let delta = row ? 0 : G2_CHARGE.rubric_question;
    if (!row && this.count("rubric_questions") + 1 > this.lim["grading.rubric_items_per_placement"]) refuse({ full: { limit: "rubric_items_per_placement" } });
    const op = req.op;
    if ("add" in op) {
      // (slots are never reused: items are never deleted before the purge, so the next slot is the count)
      const slot = items.length;
      if (slot >= MAX_SLOTS || items.length + 1 > this.lim["grading.rubric_items_per_question"]) refuse({ full: { limit: "rubric_items_per_question" } });
      if (this.count("rubric_items") + 1 > this.lim["grading.rubric_items_per_placement"]) refuse({ full: { limit: "rubric_items_per_placement" } });
      delta += G2_CHARGE.rubric_item;
      const rev = this.commit(s, delta, 0);
      const pos = items.reduce((m, i) => Math.max(m, i.pos + 1), 0);
      this.exec(
        `INSERT INTO rubric_items (question, slot, label, description, points_c, state, pos, by, at_ms, rev, course_epoch)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        q, slot, op.add.label, op.add.description, op.add.points_c, pos, this.env.actor, this.now, rev, this.env.course_epoch,
      );
      return this.rubricRev(q, rev, row === undefined, null);
    }
    if ("start" in op) {
      const rev = this.commit(s, delta, 0);
      return this.rubricRev(q, rev, row === undefined, op.start);
    }
    if ("reorder" in op) {
      const slots = op.reorder.slots;
      if (slots.length !== items.length || !slots.every((x) => has(x))) bad("reorder: exactly the question's slots");
      const rev = this.commit(s, delta, 0);
      slots.forEach((slot, pos) =>
        this.exec("UPDATE rubric_items SET pos = ?, by = ?, at_ms = ?, rev = ? WHERE question = ? AND slot = ?", pos, this.env.actor, this.now, rev, q, slot),
      );
      return this.rubricRev(q, rev, row === undefined, null);
    }
    const slot = "edit" in op ? op.edit.slot : "retire" in op ? op.retire.slot : op.restore.slot;
    if (!has(slot)) bad(`slot ${slot}: no such item`);
    const rev = this.commit(s, delta, 0);
    if ("edit" in op) {
      const e = op.edit;
      this.exec(
        `UPDATE rubric_items SET label = coalesce(?, label), description = coalesce(?, description), points_c = coalesce(?, points_c),
           by = ?, at_ms = ?, rev = ? WHERE question = ? AND slot = ?`,
        e.label ?? null, e.description ?? null, e.points_c ?? null, this.env.actor, this.now, rev, q, slot,
      );
    } else {
      this.exec(
        "UPDATE rubric_items SET state = ?, by = ?, at_ms = ?, rev = ? WHERE question = ? AND slot = ?",
        "retire" in op ? 1 : 0, this.env.actor, this.now, rev, q, slot,
      );
    }
    return this.rubricRev(q, rev, row === undefined, null);
  }

  // The question row takes the write's rev (start: null keeps it). The first write for a
  // question creates the row (the CAS from base_rev 0), which then stays until the purge.
  private rubricRev(q: string, rev: number, create: boolean, start: "zero" | "full" | null): GradingAnswer {
    if (create)
      this.exec("INSERT INTO rubric_questions (question, start, rev, course_epoch) VALUES (?, ?, ?, ?)", q, START.indexOf(start ?? "zero"), rev, this.env.course_epoch);
    else this.exec("UPDATE rubric_questions SET rev = ?, start = coalesce(?, start) WHERE question = ?", rev, start === null ? null : START.indexOf(start), q);
    return { ok: { rev } };
  }

  private count(table: "rubric_items" | "rubric_questions"): number {
    return (this.exec(`SELECT count(*) AS n FROM ${table}`).one() as { n: number }).n;
  }

  // ----- grades and comments (§2.3–2.4) -----------------------------------

  gradeView(k: GradeKey): GradeView | null {
    const g = this.exec("SELECT * FROM grades WHERE member = ? AND question = ? AND cid = ?", k.member, k.question, k.cid).toArray()[0] as
      | Record<string, unknown>
      | undefined;
    if (!g) return null;
    const c = g.has_comment
      ? (this.exec("SELECT text, reason, anchors FROM comments WHERE member = ? AND question = ? AND cid = ?", k.member, k.question, k.cid).one() as {
          text: string;
          reason: string;
          anchors: string;
        })
      : null;
    return {
      member: k.member,
      question: k.question,
      cid: k.cid,
      state: GRADE_STATE[g.state as number],
      items: decodeSlots(g.items as ArrayBuffer),
      adjust_c: g.adjust_c as number,
      basis: g.basis_value == null ? null : { value_sha256: hex(g.basis_value as ArrayBuffer)!, census_sha256: hex(g.basis_census as ArrayBuffer)! },
      slot: g.slot == null ? null : SLOT[g.slot as number],
      comment: c ? { text: c.text, reason: c.reason, anchors: JSON.parse(c.anchors) } : null,
      grader: g.grader as string,
      at_ms: g.at_ms as number,
      rev: g.rev as number,
    };
  }

  private commentRow(k: GradeKey): Comment | null {
    const c = this.exec("SELECT text, reason, anchors FROM comments WHERE member = ? AND question = ? AND cid = ?", k.member, k.question, k.cid).toArray()[0] as
      | { text: string; reason: string; anchors: string }
      | undefined;
    return c ? { text: c.text, reason: c.reason, anchors: JSON.parse(c.anchors) } : null;
  }

  // The CAS of §2.0 on a grade row: the row's (epoch, rev) must be (envelope epoch, base_rev),
  // or there must be no row and base_rev 0.
  private casGrade(k: GradeKey, base_rev: number): { exists: boolean } {
    const r = this.exec("SELECT rev, course_epoch FROM grades WHERE member = ? AND question = ? AND cid = ?", k.member, k.question, k.cid).toArray()[0] as
      | { rev: number; course_epoch: number }
      | undefined;
    if (!r) {
      if (base_rev !== 0) refuse({ conflict: { current: null } });
      return { exists: false };
    }
    if (!this.sameEpoch(r.course_epoch) || r.rev !== base_rev) refuse({ conflict: { current: this.gradeView(k) } });
    return { exists: true };
  }

  grade(req: GradeRequest): GradingAnswer {
    this.staffOnly();
    const k: GradeKey = { member: req.member, question: req.question, cid: req.cid };
    // 1. validate: the collection is the member's, the question is in its own spec
    const c = this.exec(
      "SELECT member, outcome, value_sha256, census_sha256, bundle_sha FROM collections WHERE cid = ?",
      req.cid,
    ).toArray()[0] as { member: string; outcome: number; value_sha256: ArrayBuffer | null; census_sha256: ArrayBuffer | null; bundle_sha: ArrayBuffer } | undefined;
    if (!c || c.member !== req.member) bad("cid: not a collection of this member");
    const spec = this.specFor(c!.bundle_sha);
    if (!spec.some(([q]) => q === req.question)) bad("question: not a question of this collection's spec");
    //    every applied slot is an active item of the question's rubric
    if (req.items.length) {
      const active = this.exec(
        `SELECT count(*) AS n FROM rubric_items WHERE question = ? AND state = 0 AND slot IN (SELECT value FROM json_each(?))`,
        req.question,
        JSON.stringify(req.items),
      ).one() as { n: number };
      if (active.n !== req.items.length) refuse({ stale_rubric: true });
    }
    //    the basis (§2.6)
    const rb = this.exec("SELECT state, v1, c1, v2, c2 FROM rebuilds WHERE cid = ?", req.cid).toArray()[0] as
      | { state: number; v1: ArrayBuffer | null; c1: ArrayBuffer | null; v2: ArrayBuffer | null; c2: ArrayBuffer | null }
      | undefined;
    const OUT = ["verified", "failed_resource", "failed_integrity"] as const;
    const RB = ["open", "built", "conflict"] as const;
    const pair = (v: ArrayBuffer | null, x: ArrayBuffer | null) => (v == null || x == null ? null : { value_sha256: hex(v)!, census_sha256: hex(x)! });
    const slot = checkBasis(
      { outcome: OUT[c!.outcome], value_sha256: hex(c!.value_sha256), census_sha256: hex(c!.census_sha256) },
      rb ? { state: RB[rb.state], first: pair(rb.v1, rb.c1), second: pair(rb.v2, rb.c2) } : null,
      req.basis,
    );
    if (slot === null) bad("basis: not a value this collection was verified or rebuilt as");
    // 2. compare and set
    const { exists } = this.casGrade(k, req.base_rev);
    // 3. limits: the row count, then the exact deltas against both budgets
    if (!exists) {
      const n = this.exec("SELECT count(*) AS n FROM grades WHERE member = ?", req.member).one() as { n: number };
      if (n.n + 1 > this.lim["grading.grades_per_member"]) refuse({ full: { limit: "grades_per_member" } });
    }
    const old = exists ? this.commentRow(k) : null;
    const next = req.comment === undefined ? old : req.comment;
    const oldCharge = old ? commentCharge(old, k) : 0;
    const newCharge = next ? commentCharge(next, k) : 0;
    const dc = newCharge - oldCharge;
    const rev = this.commit(this.settings(), (exists ? 0 : G2_CHARGE.grade) + dc, dc);
    // 4. write the row, the comment, both counters (above) and the rev
    const vals = [
      0, encodeSlots(req.items), req.adjust_c, unhex(req.basis.value_sha256), unhex(req.basis.census_sha256), SLOT.indexOf(slot!),
      next ? 1 : 0, this.env.actor, this.now, rev,
    ];
    if (exists)
      this.exec(
        `UPDATE grades SET state = ?, items = ?, adjust_c = ?, basis_value = ?, basis_census = ?, slot = ?, has_comment = ?,
           grader = ?, at_ms = ?, rev = ? WHERE member = ? AND question = ? AND cid = ?`,
        ...vals, k.member, k.question, k.cid,
      );
    else
      this.exec(
        `INSERT INTO grades (state, items, adjust_c, basis_value, basis_census, slot, has_comment, grader, at_ms, rev,
           member, question, cid, course_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...vals, k.member, k.question, k.cid, this.env.course_epoch,
      );
    this.putComment(k, old, next);
    return { ok: { rev } };
  }

  private putComment(k: GradeKey, old: Comment | null, next: Comment | null): void {
    if (next)
      this.exec(
        `INSERT INTO comments (member, question, cid, text, reason, anchors, course_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (member, question, cid) DO UPDATE SET text = excluded.text, reason = excluded.reason, anchors = excluded.anchors`,
        k.member, k.question, k.cid, next.text, next.reason, JSON.stringify(next.anchors), this.env.course_epoch,
      );
    else if (old) this.exec("DELETE FROM comments WHERE member = ? AND question = ? AND cid = ?", k.member, k.question, k.cid);
  }

  // Ungrading (§2.3): the same CAS; the row stays as a tombstone with its charge and its place
  // in grades_per_member; the comment goes, releasing its charge.
  ungrade(req: GradeKey & { base_rev: number }): GradingAnswer {
    this.staffOnly();
    const k: GradeKey = { member: req.member, question: req.question, cid: req.cid };
    if (req.base_rev === 0) refuse({ conflict: { current: this.gradeView(k) } });
    this.casGrade(k, req.base_rev);
    const old = this.commentRow(k);
    const dc = old ? -commentCharge(old, k) : 0;
    const rev = this.commit(this.settings(), dc, dc);
    this.exec(
      `UPDATE grades SET state = 1, items = ?, adjust_c = 0, basis_value = NULL, basis_census = NULL, slot = NULL, has_comment = 0,
         grader = ?, at_ms = ?, rev = ? WHERE member = ? AND question = ? AND cid = ?`,
      encodeSlots([]), this.env.actor, this.now, rev, k.member, k.question, k.cid,
    );
    this.putComment(k, old, null);
    return { ok: { rev } };
  }

  // A page of a question's column (§6: ≤ 1,000 rows) after the key (member, cid), without
  // comment texts.
  gradesByQuestion(q: string, after: { member: string; cid: string } | null, limit: number): Omit<GradeView, "comment">[] {
    const rows = this.exec(
      "SELECT member, cid FROM grades WHERE question = ? AND (member, cid) > (?, ?) ORDER BY member, cid LIMIT ?",
      q,
      after?.member ?? "",
      after?.cid ?? "",
      Math.max(1, Math.min(1000, limit)),
    ).toArray() as { member: string; cid: string }[];
    return rows.map((r) => {
      const { comment: _, ...v } = this.gradeView({ member: r.member, question: q, cid: r.cid })!;
      return v;
    });
  }

  // ----- specs (addendum A1 r5) --------------------------------------------

  // The spec of a collection's bundle, for the write's own transaction (A1.3): the stored
  // questions; or, failing that, the recorded outcome or spec_needed, as an early answer.
  specFor(bundle: ArrayBuffer): [string, number][] {
    const b = hex(bundle)!;
    const s = this.exec("SELECT questions, state FROM specs WHERE bundle_sha = ?", bundle).toArray()[0] as { questions: string; state: number } | undefined;
    if (s) {
      if (s.state !== SPEC_STATE.ok) refuse({ spec_integrity: { bundle_sha: b } });
      return JSON.parse(s.questions);
    }
    const o = this.exec("SELECT outcome, reason, limits_version, next_try FROM spec_outcomes WHERE bundle_sha = ?", bundle).toArray()[0] as
      | { outcome: number; reason: string; limits_version: number; next_try: number }
      | undefined;
    if (o && !outcomeDue(o, this.now, this.limitsVersion, this.room())) {
      const kind = OUTCOMES[o.outcome];
      refuse({ spec_unavailable: { bundle_sha: b, reason: kind === "full" ? o.reason : kind === "invalid_spec" ? kind : "retry_later" } });
    }
    return refuse({ spec_needed: { bundle_sha: b } });
  }

  private room(): number {
    const s = this.settings();
    return this.lim["grading.grades_bytes"] - s.grades_charged;
  }

  private hasCollectionWith(bundle: Uint8Array): boolean {
    // (a scan of collections by bundle_sha: ≤ members × collections_per_member rows, once per put)
    return this.exec("SELECT 1 FROM collections WHERE bundle_sha = ? LIMIT 1", bundle).toArray().length > 0;
  }

  // spec_put (A1.2): Course only. Identical repeats are ok; a different spec is a mismatch, and
  // marks the stored row integrity_failed in this transaction (A1.1, r3).
  specPut(bundle_sha: string, questions: [string, number][]): GradingAnswer {
    const bundle = unhex(bundle_sha);
    if (!this.hasCollectionWith(bundle)) bad("no_collection");
    const text = JSON.stringify(questions);
    const s = this.exec("SELECT questions FROM specs WHERE bundle_sha = ?", bundle).toArray()[0] as { questions: string } | undefined;
    if (s) {
      if (s.questions === text) return { ok: { rev: 0 } };
      console.error(`gradebook: a second, different spec for bundle ${bundle_sha}; the first is kept, marked integrity_failed`);
      this.exec("UPDATE specs SET state = ? WHERE bundle_sha = ?", SPEC_STATE.integrity_failed, bundle);
      return { invalid: { reason: "spec_mismatch" } };
    }
    const n = this.exec("SELECT count(*) AS n FROM specs").one() as { n: number };
    if (n.n + 1 > this.lim["grading.specs_per_placement"]) refuse({ full: { limit: "specs_per_placement" as GradingFull } });
    const had = this.exec("SELECT 1 FROM spec_outcomes WHERE bundle_sha = ?", bundle).toArray().length > 0;
    // (the exact net: the 8,192 B row, less the 256 B outcome row this transaction deletes: A1 r5)
    const net = G2_CHARGE.spec - (had ? G2_CHARGE.spec_outcome : 0);
    const st = this.settings();
    if (st.grades_charged + net > this.lim["grading.grades_bytes"]) refuse({ full: { limit: "grades_bytes" } });
    this.exec("INSERT INTO specs (bundle_sha, questions, state, course_epoch) VALUES (?, ?, ?, ?)", bundle, text, SPEC_STATE.ok, this.env.course_epoch);
    if (had) this.exec("DELETE FROM spec_outcomes WHERE bundle_sha = ?", bundle);
    this.exec("UPDATE settings SET grades_charged = grades_charged + ? WHERE k = 0", net);
    return { ok: { rev: 0 } };
  }

  // spec_outcome (A1.2c): Course only. One row per bundle; a repeat counts an attempt.
  specOutcome(bundle_sha: string, kind: SpecOutcome, reason: string): GradingAnswer {
    const bundle = unhex(bundle_sha);
    if (!this.hasCollectionWith(bundle)) bad("no_collection");
    if (this.exec("SELECT 1 FROM specs WHERE bundle_sha = ?", bundle).toArray().length) return { ok: { rev: 0 } }; // (a put won meanwhile)
    const o = this.exec("SELECT attempts, outcome FROM spec_outcomes WHERE bundle_sha = ?", bundle).toArray()[0] as { attempts: number; outcome: number } | undefined;
    // (invalid_spec is terminal for the epoch: a later report from an older, still-running
    // hydration never replaces it, so the bundle is never re-read: astra2's CORR-CLOUD14-1)
    if (o && OUTCOMES[o.outcome] === "invalid_spec") return { ok: { rev: 0 } };
    const attempts = (o?.attempts ?? 0) + 1;
    const vals = [OUTCOMES.indexOf(kind), reason, this.limitsVersion, attempts, nextTry(kind, attempts, this.now), this.now];
    if (o) {
      this.exec("UPDATE spec_outcomes SET outcome = ?, reason = ?, limits_version = ?, attempts = ?, next_try = ?, at_ms = ? WHERE bundle_sha = ?", ...vals, bundle);
      return { ok: { rev: 0 } };
    }
    const n = this.exec("SELECT count(*) AS n FROM spec_outcomes").one() as { n: number };
    if (n.n + 1 > this.lim["grading.specs_per_placement"]) refuse({ full: { limit: "specs_per_placement" as GradingFull } });
    const st = this.settings();
    if (st.grades_charged + G2_CHARGE.spec_outcome > this.lim["grading.grades_bytes"]) refuse({ full: { limit: "grades_bytes" } });
    this.exec(
      "INSERT INTO spec_outcomes (outcome, reason, limits_version, attempts, next_try, at_ms, bundle_sha, course_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ...vals, bundle, this.env.course_epoch,
    );
    this.exec("UPDATE settings SET grades_charged = grades_charged + ? WHERE k = 0", G2_CHARGE.spec_outcome);
    return { ok: { rev: 0 } };
  }

  // ----- the counted collection (§2.5) ------------------------------------

  choiceView(member: string): ChoiceView | null {
    const r = this.exec("SELECT member, cid, by, at_ms, rev FROM member_choice WHERE member = ?", member).toArray()[0] as ChoiceView | undefined;
    return r ?? null;
  }

  choose(req: { member: string; cid: string | null; base_rev: number }): GradingAnswer {
    this.staffOnly();
    // (a choice exists only for a member of this Gradebook, so its rows are ≤ members: §6)
    if (!this.exec("SELECT 1 FROM members WHERE member = ?", req.member).toArray().length) bad("member: not a member of this placement");
    if (req.cid !== null) {
      const c = this.exec("SELECT member FROM collections WHERE cid = ?", req.cid).toArray()[0] as { member: string } | undefined;
      if (!c || c.member !== req.member) bad("cid: not a collection of this member");
    }
    const r = this.exec("SELECT rev, course_epoch FROM member_choice WHERE member = ?", req.member).toArray()[0] as { rev: number; course_epoch: number } | undefined;
    if (r ? !this.sameEpoch(r.course_epoch) || r.rev !== req.base_rev : req.base_rev !== 0)
      return { conflict: { current: this.choiceView(req.member) } };
    const rev = this.commit(this.settings(), r ? 0 : G2_CHARGE.member_choice, 0);
    this.exec(
      `INSERT INTO member_choice (member, cid, by, at_ms, rev, course_epoch) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (member) DO UPDATE SET cid = excluded.cid, by = excluded.by, at_ms = excluded.at_ms, rev = excluded.rev`,
      req.member, req.cid, this.env.actor, this.now, rev, this.env.course_epoch,
    );
    return { ok: { rev } };
  }
}

// The counters as the stored rows imply them (§2.0's invariant), for the fixtures.
export function recountG2(exec: Exec): { grades_charged: number; comment_charged: number } {
  const n = (t: string) => (exec(`SELECT count(*) AS n FROM ${t}`).one() as { n: number }).n;
  let comments = 0;
  for (const c of exec("SELECT member, question, cid, text, reason, anchors FROM comments").toArray() as unknown as (GradeKey & { text: string; reason: string; anchors: string })[])
    comments += commentCharge({ text: c.text, reason: c.reason, anchors: JSON.parse(c.anchors) }, c);
  const settings = n("settings") * G2_CHARGE.settings;
  return {
    grades_charged:
      settings +
      n("rubric_items") * G2_CHARGE.rubric_item +
      n("rubric_questions") * G2_CHARGE.rubric_question +
      n("grades") * G2_CHARGE.grade +
      n("member_choice") * G2_CHARGE.member_choice +
      n("release") * G2_CHARGE.release +
      n("specs") * G2_CHARGE.spec +
      n("spec_outcomes") * G2_CHARGE.spec_outcome +
      comments,
    comment_charged: comments,
  };
}
