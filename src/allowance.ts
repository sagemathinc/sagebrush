// Opt-in limits (scope item G): the allowance/1 schema and its strict
// validator.  Design: /scratch/sagebrush-reviews/design-optin-limits-g-r3.md
// §1 (approved Oct 24 2026); implementation order:
// plan-optin-limits-g-impl-r3.md, PR G-0.
//
// An allowance bounds what a trusted context (grading, an instructor's
// published bundle, a server's configuration) already allows; it never grants
// compute.  This module only parses and checks one: nothing here arms a timer,
// a ledger or a counter, and nothing calls it yet (G-1 is the first caller).
// Without an allowance nothing changes (design §0).
import { strictJson, PkgsetError } from "./pkgset";

export const ALLOWANCE_SCHEMA = "sagebrush.allowance/1";

/** Ranges of allowance/1 (design §1), inclusive. */
export const ALLOWANCE_LIMITS = Object.freeze({
  wallMin: 0.1,
  wallMax: 86_400,
  countMax: Number.MAX_SAFE_INTEGER, // 2^53 - 1, for work and steps
  graceMin: 0.5,
  graceMax: 60,
  families: 32,
  textBytes: 16 * 1024,
  jsonDepth: 4,
});

export type AllowanceScope = "notebook" | "question" | "cell" | "test";
export type AllowanceSource = "grading" | "instructor" | "server";
export interface Allowance {
  readonly schema: typeof ALLOWANCE_SCHEMA;
  readonly scope: AllowanceScope;
  readonly wall_s?: number;
  readonly work?: Readonly<Record<string, number>>;
  readonly steps?: number;
  readonly grace_s?: number;
  readonly source: AllowanceSource;
}

export class AllowanceError extends Error {
  constructor(message: string) {
    super(message.length > 1024 ? message.slice(0, 1023) + "…" : message);
    this.name = "AllowanceError";
  }
}
const fail = (m: string): never => {
  throw new AllowanceError(`invalid allowance: ${m}`);
};

const SCOPES: ReadonlySet<string> = new Set(["notebook", "question", "cell", "test"]);
const SOURCES: ReadonlySet<string> = new Set(["grading", "instructor", "server"]);
const KEYS: ReadonlySet<string> = new Set(["schema", "scope", "wall_s", "work", "steps", "grace_s", "source"]);
// H's work families are short lowercase names ("factor", "gb"); which ones
// exist is the engine's registry, passed in by the caller that has it.
const FAMILY = /^[a-z][a-z0-9_]{0,31}$/;

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v)) fail(`${what} must be an integer`);
  if ((v as number) < 1 || (v as number) > ALLOWANCE_LIMITS.countMax) fail(`${what} must be from 1 to ${ALLOWANCE_LIMITS.countMax}`);
  return v as number;
};
const seconds = (v: unknown, what: string, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${what} must be a number`);
  if ((v as number) < min || (v as number) > max) fail(`${what} must be from ${min} to ${max}`);
  return v as number;
};

export interface AllowanceOptions {
  /** The work families the engine knows; when given, any other family is refused. */
  families?: ReadonlySet<string>;
}

/**
 * Checks a parsed value against allowance/1 and returns a frozen,
 * prototype-free copy.  Unknown fields, a missing dimension, non-integer
 * counters and out-of-range values are refused with the reason.
 */
export function checkAllowance(v: unknown, opts: AllowanceOptions = {}): Allowance {
  if (!isPlain(v)) fail("not an object");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KEYS.has(k)) fail(`unknown field ${JSON.stringify(k.slice(0, 64))}`);
  if (o.schema !== ALLOWANCE_SCHEMA) fail(`schema must be ${JSON.stringify(ALLOWANCE_SCHEMA)}`);
  if (typeof o.scope !== "string" || !SCOPES.has(o.scope)) fail("scope must be notebook, question, cell or test");
  if (typeof o.source !== "string" || !SOURCES.has(o.source)) fail("source must be grading, instructor or server");
  const out: any = Object.create(null);
  out.schema = ALLOWANCE_SCHEMA;
  out.scope = o.scope;
  out.source = o.source;
  if (Object.hasOwn(o, "wall_s")) out.wall_s = seconds(o.wall_s, "wall_s", ALLOWANCE_LIMITS.wallMin, ALLOWANCE_LIMITS.wallMax);
  if (Object.hasOwn(o, "steps")) out.steps = count(o.steps, "steps");
  if (Object.hasOwn(o, "work")) {
    if (!isPlain(o.work)) fail("work must be an object of family: integer");
    const fams = Object.keys(o.work as object);
    if (fams.length === 0) fail("work must name at least one family");
    if (fams.length > ALLOWANCE_LIMITS.families) fail(`work names more than ${ALLOWANCE_LIMITS.families} families`);
    const w: any = Object.create(null);
    for (const f of fams) {
      if (!FAMILY.test(f)) fail(`work family ${JSON.stringify(f.slice(0, 64))} is not a family name`);
      if (opts.families && !opts.families.has(f)) fail(`unknown work family ${JSON.stringify(f)}`);
      w[f] = count((o.work as any)[f], `work.${f}`);
    }
    out.work = Object.freeze(w);
  }
  if (!("wall_s" in out) && !("steps" in out) && !("work" in out)) fail("at least one of wall_s, work and steps is required");
  if (Object.hasOwn(o, "grace_s")) out.grace_s = seconds(o.grace_s, "grace_s", ALLOWANCE_LIMITS.graceMin, ALLOWANCE_LIMITS.graceMax);
  return Object.freeze(out);
}

/** Parses allowance/1 from JSON text: strict JSON (no duplicate or prototype keys), then checkAllowance. */
export function parseAllowance(text: string, opts: AllowanceOptions = {}): Allowance {
  if (text.length > ALLOWANCE_LIMITS.textBytes) fail(`longer than ${ALLOWANCE_LIMITS.textBytes} characters`);
  let v: unknown;
  try {
    v = strictJson(text, ALLOWANCE_LIMITS.jsonDepth);
  } catch (e) {
    if (e instanceof PkgsetError) fail(e.message);
    throw e;
  }
  return checkAllowance(v, opts);
}

/**
 * The grace period in seconds (design §4.2): an instructor's grace_s if set;
 * otherwise 2 s for steps- or work-only scopes, and min(2, max(0.5, 0.1 w))
 * for a scope with wall_s = w.
 */
export function graceSeconds(a: Allowance): number {
  if (a.grace_s !== undefined) return a.grace_s;
  if (a.wall_s === undefined) return 2;
  return Math.min(2, Math.max(0.5, 0.1 * a.wall_s));
}

// scope_id (design §3.2), host-assigned: nb, q:<qid>, t:<qid>/<index>,
// c:<template cell id>, u:<submitted ordinal>.  qid is grading.json's id
// grammar; a cell id is nbformat 4.5's.
const QID = "[a-z0-9][a-z0-9_-]{0,31}";
const ORD = "(?:0|[1-9][0-9]{0,8})";
const SCOPE_ID = new RegExp(`^(?:nb|q:${QID}|t:${QID}/${ORD}|c:[A-Za-z0-9_-]{1,64}|u:${ORD})$`);
export function isScopeId(s: unknown): s is string {
  return typeof s === "string" && SCOPE_ID.test(s);
}
