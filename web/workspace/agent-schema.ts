// The check of an agent's call against web/workspace/schema.json (design/workspace-agent-protocol.md §3): the
// page takes a verb only if its name is in the schema and its params pass the verb's JSON Schema.
//
// This is a checker of exactly the JSON Schema keywords schema.json uses (verbs.ts writes it): type (object,
// string, boolean, integer), properties, required, additionalProperties (false only), minLength, maxLength,
// pattern, enum, minimum, oneOf, plus description and $schema, which say nothing.  A schema with any other
// keyword is refused as a whole (it fails closed: a keyword it doesn't know is a rule it can't keep).
//
// And, for every value anywhere in the params: no NUL, no lone surrogate (a string that isn't well-formed
// UTF-16), no number that isn't finite (JSON can't say NaN, but a decoder might hand one over).

import { schema } from "./verbs";

// (the same description schema.json is written from: verbs.ts; test-workspace.mjs fails when the file is stale)
const SCHEMA = schema();

type Schema = Record<string, unknown>;
const KNOWN = new Set(["$schema", "description", "type", "properties", "required", "additionalProperties", "minLength", "maxLength", "pattern", "enum", "minimum", "oneOf"]);

/** The verbs an agent may call: "workspace.<verb>". */
export const AGENT_VERBS: ReadonlySet<string> = new Set(Object.keys((SCHEMA as any).verbs));
/** The protocol's limits, as schema.json says them. */
export const AGENT_LIMITS = (SCHEMA as any).limits as {
  maxContentBytes: number; maxFrameBytes: number; maxPath: number; maxDepth: number; maxName: number; maxList: number; maxHistory: number; inFlight: number; perSecond: number; burst: number;
};

/** Why `v` isn't a value the page takes anywhere (NUL, a lone surrogate, a non-finite number), or null. */
export function badValue(v: unknown, at = "params", depth = 0): string | null {
  if (depth > 64) return `${at}: nested too deep`;
  if (typeof v === "string") {
    if (v.includes("\u0000")) return `${at}: holds a NUL`;
    if (!isWellFormed(v)) return `${at}: holds a lone surrogate`;
    return null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? null : `${at}: not a finite number`;
  if (v === null || typeof v === "boolean") return null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const w = badValue(v[i], `${at}[${i}]`, depth + 1); if (w) return w; }
    return null;
  }
  if (typeof v === "object") {
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return `${at}: not a plain object`;
    for (const [k, w] of Object.entries(v as object)) {
      const kb = badValue(k, `${at} key`, depth + 1);
      if (kb) return kb;
      const r = badValue(w, `${at}.${k}`, depth + 1);
      if (r) return r;
    }
    return null;
  }
  return `${at}: not a JSON value`;
}

function isWellFormed(s: string): boolean {
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

const typeOk = (t: unknown, v: unknown) =>
  t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v)
  : t === "string" ? typeof v === "string"
  : t === "boolean" ? typeof v === "boolean"
  : t === "integer" ? typeof v === "number" && Number.isInteger(v)
  : false;

const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const primitive = (x: unknown) => x === null || typeof x === "string" || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x));

/** Why the one node `o` (not its children) says something this checker can't keep, or null: a keyword it doesn't
 * know, or a known keyword whose value has the wrong type or range (maxLength "1" or pattern 12 would otherwise
 * be a rule silently not kept). */
function nodeProblem(o: Schema, at: string): string | null {
  for (const k of Object.keys(o)) if (!KNOWN.has(k)) return `${at}: keyword not understood: ${k}`;
  if (o.$schema !== undefined && typeof o.$schema !== "string") return `${at}.$schema: not a string`;
  if (o.description !== undefined && typeof o.description !== "string") return `${at}.description: not a string`;
  if (o.additionalProperties !== undefined && o.additionalProperties !== false) return `${at}: additionalProperties other than false`;
  if (o.type !== undefined && !(typeof o.type === "string" && ["object", "string", "boolean", "integer"].includes(o.type))) return `${at}: type ${JSON.stringify(o.type)} not understood`;
  if (o.properties !== undefined && (!o.properties || typeof o.properties !== "object" || Array.isArray(o.properties))) return `${at}.properties: not an object`;
  if (o.oneOf !== undefined && (!Array.isArray(o.oneOf) || o.oneOf.length === 0)) return `${at}.oneOf: not a list`;
  if (o.required !== undefined && !(Array.isArray(o.required) && o.required.every((x) => typeof x === "string") && new Set(o.required).size === o.required.length)) return `${at}.required: not a list of distinct names`;
  if (o.enum !== undefined && !(Array.isArray(o.enum) && o.enum.length > 0 && o.enum.every(primitive))) return `${at}.enum: not a list of plain values`;
  if (o.minLength !== undefined && !count(o.minLength)) return `${at}.minLength: not a whole number ≥ 0`;
  if (o.maxLength !== undefined && !count(o.maxLength)) return `${at}.maxLength: not a whole number ≥ 0`;
  if (o.minLength !== undefined && o.maxLength !== undefined && (o.minLength as number) > (o.maxLength as number)) return `${at}: minLength over maxLength`;
  if (o.minimum !== undefined && !(typeof o.minimum === "number" && Number.isFinite(o.minimum))) return `${at}.minimum: not a finite number`;
  if (o.pattern !== undefined) {
    if (typeof o.pattern !== "string") return `${at}.pattern: not a string`;
    try { new RegExp(o.pattern, "u"); } catch { return `${at}.pattern: not a pattern`; }
  }
  return null;
}

/** Why `v` doesn't pass `s`, or null.  Throws if `s` says something this checker can't keep (nodeProblem). */
export function check(s: Schema, v: unknown, at = "params"): string | null {
  const bad = !s || typeof s !== "object" || Array.isArray(s) ? `${at}: not a schema` : nodeProblem(s, at);
  if (bad) throw new Error(`schema not understood: ${bad}`);
  if (s.oneOf !== undefined) {
    if (!Array.isArray(s.oneOf)) throw new Error("oneOf isn't a list");
    const n = s.oneOf.filter((alt) => check(alt as Schema, v, at) === null).length;
    if (n !== 1) return `${at}: matches ${n} of the ${s.oneOf.length} forms (it must match exactly one)`;
  }
  if (s.type !== undefined) {
    if (!typeOk(s.type, v)) return `${at}: not ${s.type === "integer" ? "an integer" : `a ${s.type}`}`;
  }
  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum)) throw new Error("enum isn't a list");
    if (!s.enum.includes(v)) return `${at}: not one of ${s.enum.join(", ")}`;
  }
  if (typeof v === "string") {
    // (lengths in UTF-16 code units, as JSON Schema's "characters" are counted by the JS checkers the schema was written for)
    if (typeof s.minLength === "number" && v.length < s.minLength) return `${at}: shorter than ${s.minLength}`;
    if (typeof s.maxLength === "number" && v.length > s.maxLength) return `${at}: longer than ${s.maxLength}`;
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(v)) return `${at}: doesn't match ${s.pattern}`;
  }
  if (typeof v === "number" && typeof s.minimum === "number" && v < s.minimum) return `${at}: less than ${s.minimum}`;
  if (v !== null && typeof v === "object" && !Array.isArray(v) && (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined)) {
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const r of (s.required ?? []) as string[]) if (!Object.prototype.hasOwnProperty.call(v, r)) return `${at}: ${r} is missing`;
    for (const [k, w] of Object.entries(v as object)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        const r = check(props[k], w, `${at}.${k}`);
        if (r) return r;
      } else if (s.additionalProperties === false) return `${at}: ${k} isn't a parameter`;
    }
  }
  return null;
}

/** Why the schema `s` (every node of it: each property's, each oneOf alternative's, whether a request reaches
 * it or not) uses something this checker doesn't keep, or null: checked once, as a whole. */
export function schemaProblem(s: unknown, at = "schema", depth = 0): string | null {
  if (depth > 32) return `${at}: nested too deep`;
  if (!s || typeof s !== "object" || Array.isArray(s)) return `${at}: not a schema`;
  const o = s as Schema;
  const bad = nodeProblem(o, at);
  if (bad) return bad;
  if (o.properties !== undefined) {
    for (const [k, v] of Object.entries(o.properties as object)) { const r = schemaProblem(v, `${at}.properties.${k}`, depth + 1); if (r) return r; }
  }
  if (o.oneOf !== undefined) {
    for (let i = 0; i < (o.oneOf as unknown[]).length; i++) { const r = schemaProblem((o.oneOf as unknown[])[i], `${at}.oneOf[${i}]`, depth + 1); if (r) return r; }
  }
  return null;
}
/** The whole schema's problem, found once: while there is one, every call is refused (it fails closed). */
export const SCHEMA_PROBLEM: string | null = (() => {
  for (const [v, d] of Object.entries((SCHEMA as any).verbs ?? {})) { const r = schemaProblem((d as any)?.params, v); if (r) return r; }
  return null;
})();

/** Why the call `method(params)` isn't one the page takes, or null: an unknown verb, params that break its
 * schema, or a value no verb takes. */
export function checkCall(method: unknown, params: unknown): string | null {
  if (SCHEMA_PROBLEM) return "the page can't check calls against its schema: " + SCHEMA_PROBLEM;
  if (typeof method !== "string" || !AGENT_VERBS.has(method)) return `not a verb: ${JSON.stringify(String(method)).slice(0, 80)}`;
  const bad = badValue(params);
  if (bad) return bad;
  return check((SCHEMA as any).verbs[method].params, params);
}
