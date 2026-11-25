// The assignment spec, `grading.json` in the assignment bundle (grading G1 r5 §2.1–2.2).
//
// A spec names the questions of an assignment, their kinds and points, and the template
// cells each owns. It is validated once at publish, against the bundle's own template, and
// again wherever cards are built, so a card never trusts an unchecked spec.
//
// Strict JSON: duplicate keys, unknown fields, non-integer points and ill-formed Unicode are
// refused with an exact reason, and nothing is published.

export type Kind = "auto" | "manual" | "both";

export interface Question {
  id: string;
  title: string;
  kind: Kind;
  points_c: number; // points in integer hundredths
  anchor: string; // the prompt cell (a template cell id)
  answers: string[]; // template cell ids the student answers in
}

// A validated spec: its questions in card order (template order of anchors, §2.2).
export interface ValidSpec {
  questions: Question[];
  total_c: number;
}

export interface TemplateCell {
  id: string;
  pos: number;
}

export interface SpecLimits {
  spec_bytes: number; // grading.spec_bytes (G1 r5 §6.2)
  questions_per_assignment: number; // grading.questions_per_assignment
}

export const SPEC_LIMITS_DEFAULT: SpecLimits = { spec_bytes: 256 * 1024, questions_per_assignment: 30 };

export type SpecResult = { ok: true; spec: ValidSpec } | { ok: false; reason: string };

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_POINTS_C = 1_000_000;
const MAX_ANSWERS = 64;
const MAX_TITLE = 200;
const MAX_DEPTH = 16;
const KINDS: ReadonlySet<string> = new Set(["auto", "manual", "both"]);

class SpecError extends Error {}

// ---------------------------------------------------------------------------
// Strict JSON

type JsonValue = null | boolean | JsonNumber | string | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}
// (a number keeps its source text, so points can be required to be integer literals)
class JsonNumber {
  constructor(
    readonly value: number,
    readonly text: string,
  ) {}
}

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

export function parseStrictJson(text: string): JsonValue {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const fail = (what: string): never => {
    throw new SpecError(`invalid JSON at offset ${i}: ${what}`);
  };
  const str = (): string => {
    if (text[i] !== '"') fail("expected a string");
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const ch = text[i++];
      if (ch === '"') break;
      if (ch === "\\") {
        const e = text[i++];
        if (e === "u") {
          const h = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail("bad \\u escape");
          out += String.fromCharCode(parseInt(h, 16));
          i += 4;
        } else {
          const m: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          if (!(e in m)) fail("bad escape");
          out += m[e];
        }
      } else if (ch.charCodeAt(0) < 0x20) fail("control character in string");
      else out += ch;
    }
    if (!wellFormed(out)) fail("ill-formed Unicode in a string");
    return out;
  };
  const value = (depth: number): JsonValue => {
    if (depth > MAX_DEPTH) fail("nested too deeply");
    ws();
    const ch = text[i];
    if (ch === "{") {
      i++;
      const obj: JsonObject = Object.create(null);
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const k = str();
        if (Object.prototype.hasOwnProperty.call(obj, k)) fail(`duplicate key "${k}"`);
        ws();
        if (text[i++] !== ":") fail("expected ':'");
        obj[k] = value(depth + 1);
        ws();
        const c = text[i++];
        if (c === "}") return obj;
        if (c !== ",") fail("expected ',' or '}'");
      }
    }
    if (ch === "[") {
      i++;
      const arr: JsonValue[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        const c = text[i++];
        if (c === "]") return arr;
        if (c !== ",") fail("expected ',' or ']'");
      }
    }
    if (ch === '"') return str();
    for (const [lit, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return v;
      }
    }
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 64));
    if (!m) fail("unexpected character");
    i += m![0].length;
    return new JsonNumber(Number(m![0]), m![0]);
  };
  const v = value(0);
  ws();
  if (i !== text.length) fail("trailing characters");
  return v;
}

// ---------------------------------------------------------------------------
// Points

// A decimal with at most two places, as integer hundredths, exactly (no floating point).
export function toHundredths(x: number | string): number {
  const s = typeof x === "number" ? (Number.isFinite(x) ? String(x) : "") : x.trim();
  const m = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,2}))?$/.exec(s);
  if (!m) throw new SpecError(`max_points ${JSON.stringify(x)} isn't a non-negative number with at most two decimals`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

// ---------------------------------------------------------------------------
// Validation (§2.2)

function isObject(v: JsonValue): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof JsonNumber);
}

function exactKeys(o: JsonObject, keys: readonly string[], where: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new SpecError(`${where}: unknown field "${k}"`);
  for (const k of keys) if (!(k in o)) throw new SpecError(`${where}: missing field "${k}"`);
}

function question(v: JsonValue, n: number): Question {
  const where = `questions[${n}]`;
  if (!isObject(v)) throw new SpecError(`${where}: not an object`);
  exactKeys(v, ["id", "title", "kind", "points_c", "anchor", "answers"], where);
  const { id, title, kind, points_c, anchor, answers } = v;
  if (typeof id !== "string" || !ID.test(id)) throw new SpecError(`${where}: id must match ${ID}`);
  if (typeof title !== "string" || title.length < 1 || title.length > MAX_TITLE)
    throw new SpecError(`${where}: title must be 1–${MAX_TITLE} UTF-16 code units`);
  if (typeof kind !== "string" || !KINDS.has(kind)) throw new SpecError(`${where}: kind must be auto, manual or both`);
  if (!(points_c instanceof JsonNumber) || !/^(0|[1-9][0-9]*)$/.test(points_c.text) || points_c.value > MAX_POINTS_C)
    throw new SpecError(`${where}: points_c must be an integer from 0 to ${MAX_POINTS_C} (hundredths of a point)`);
  if (typeof anchor !== "string" || anchor.length === 0) throw new SpecError(`${where}: anchor must be a cell id`);
  if (!Array.isArray(answers) || answers.length > MAX_ANSWERS)
    throw new SpecError(`${where}: answers must be a list of at most ${MAX_ANSWERS} cell ids`);
  for (const a of answers) if (typeof a !== "string" || a.length === 0) throw new SpecError(`${where}: answers must be cell ids`);
  return { id, title, kind: kind as Kind, points_c: points_c.value, anchor, answers: answers as string[] };
}

// The UTF-16 order of JavaScript's `<`, used for every tie (G1 r5 §2.2–2.3).
export function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function validateSpec(
  bytes: Uint8Array,
  template: readonly TemplateCell[],
  maxPoints: number | string,
  limits: SpecLimits = SPEC_LIMITS_DEFAULT,
): SpecResult {
  try {
    if (bytes.length > limits.spec_bytes)
      throw new SpecError(`grading.json is ${bytes.length} bytes, over grading.spec_bytes = ${limits.spec_bytes}`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      throw new SpecError("grading.json isn't valid UTF-8");
    }
    const root = parseStrictJson(text);
    if (!isObject(root)) throw new SpecError("grading.json must be an object");
    exactKeys(root, ["format", "v", "questions"], "grading.json");
    if (root.format !== "sagebrush-grading-spec") throw new SpecError('format must be "sagebrush-grading-spec"');
    if (!(root.v instanceof JsonNumber) || root.v.text !== "1") throw new SpecError("v must be 1");
    if (!Array.isArray(root.questions)) throw new SpecError("questions must be a list");
    if (root.questions.length > limits.questions_per_assignment)
      throw new SpecError(
        `${root.questions.length} questions, over grading.questions_per_assignment = ${limits.questions_per_assignment}`,
      );
    const qs = root.questions.map(question);

    const pos = new Map<string, number>();
    for (const c of template) pos.set(c.id, c.pos);
    const ids = new Set<string>();
    const owner = new Map<string, string>(); // cell id -> the question that names it
    for (const q of qs) {
      if (ids.has(q.id)) throw new SpecError(`question id "${q.id}" is used twice`);
      ids.add(q.id);
      for (const [cell, role] of [[q.anchor, "anchor"], ...q.answers.map((a) => [a, "answer"])] as const) {
        if (!pos.has(cell)) throw new SpecError(`question "${q.id}": ${role} "${cell}" isn't a cell of the template`);
        const prev = owner.get(cell);
        if (prev !== undefined)
          throw new SpecError(
            prev === q.id
              ? `question "${q.id}": cell "${cell}" is named twice`
              : `cell "${cell}" is in both question "${prev}" and question "${q.id}"`,
          );
        owner.set(cell, q.id);
      }
    }
    const total = qs.reduce((s, q) => s + q.points_c, 0);
    const want = toHundredths(maxPoints);
    if (total !== want)
      throw new SpecError(`the points sum to ${total} hundredths, but the assignment's max_points is ${want} hundredths`);

    // card order: template order of anchors, ties by id (§2.2)
    qs.sort((a, b) => pos.get(a.anchor)! - pos.get(b.anchor)! || cmpId(a.anchor, b.anchor));
    return { ok: true, spec: { questions: qs, total_c: total } };
  } catch (e) {
    if (e instanceof SpecError) return { ok: false, reason: e.message };
    throw e;
  }
}
