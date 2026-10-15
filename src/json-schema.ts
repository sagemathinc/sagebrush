// A JSON Schema (draft 2020-12) validator for the keywords the board
// format's schema uses (web/board-format.schema.json, written by
// scripts/board-format-schema.mjs), with messages for whoever wrote the
// document: where (`pages[2].nodes[5].colour`), what is wrong, and for an
// unknown field the known one it may have meant.  A keyword it doesn't know
// is an error, never skipped: a schema it can't fully check is refused.

export interface SchemaProblem {
  /** where, as a path: `nodes[3].color` ("" for the document) */
  path: string;
  /** what is wrong */
  message: string;
}

type Schema = Record<string, any> | boolean;

const KNOWN = new Set(["$schema", "$id", "$ref", "$defs", "title", "description", "type", "const", "enum", "pattern", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "minItems", "properties", "required", "additionalProperties", "propertyNames", "items", "anyOf", "not",
  "dependentRequired"]);

// (a path step: .name, or ["odd name"] for a name that isn't a plain word)
const step = (path: string, key: string | number) =>
  typeof key === "number" ? `${path}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`;
const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? s.slice(0, 57) + "..." : s;
};
const kindOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : typeof v === "string" ? "a string" : typeof v === "number" ? "a number" : typeof v === "boolean" ? "true or false" : typeof v);
// (a field written on an item that belongs to the whole document)
const HINTS: Record<string, string> = { mode: "`mode` is the board's, written once at the top: one language per board", seed: "`seed` is the board's, written at the top", refBase: "`refBase` is the board's, written at the top" };
const TYPE_WORDS: Record<string, string> = { string: "a string", number: "a number", integer: "a whole number", boolean: "true or false", object: "an object", array: "a list" };

/** Edit distance (for "did you mean"), a transposition of two letters
 * counting as one edit (`titel`, `title`); at most `limit` + 1.  Three rows
 * (PERF-619-1: not a whole matrix), stopped once a row is all past limit. */
function distance(a: string, b: string, limit = 2): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let older: number[] = [], prev = Array.from({ length: b.length + 1 }, (_, j) => j), row: number[] = [];
  for (let i = 1; i <= a.length; i++) {
    row[0] = i;
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, older[j - 2] + 1);
      row[j] = d;
      least = Math.min(least, d);
    }
    if (least > limit) return limit + 1;
    [older, prev, row] = [prev, row, older];
  }
  return Math.min(prev[b.length], limit + 1);
}
// (names longer than this get no suggestion: the work for each known name
// is then at most about NEAR_MAX^2, whatever the document's names, PERF-619-1)
const NEAR_MAX = 64;
// (a name an object has itself, not from its prototype: `constructor`,
// `toString` and `__proto__` are a document's names like any other, CORR-7A7-1)
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** The known name an unknown one most likely meant, or null. */
export function didYouMean(name: string, known: string[]): string | null {
  if (name.length > NEAR_MAX) return null;
  const lower = name.toLowerCase();
  let best: string | null = null, bestD = Infinity;
  for (const k of known) {
    if (Math.abs(k.length - name.length) > 2) continue;
    const d = k.toLowerCase() === lower ? 0 : distance(lower, k.toLowerCase());
    if (d < bestD) { best = k; bestD = d; }
  }
  return best !== null && bestD <= Math.max(1, Math.min(2, Math.floor(name.length / 3))) ? best : null;
}

export class SchemaValidator {
  private regexps = new Map<string, RegExp>();
  constructor(private root: Record<string, any>) {
    // (every keyword of every subschema known, or the schema is refused)
    const walk = (s: Schema, at: string) => {
      if (typeof s === "boolean") return;
      for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`json-schema: keyword ${k} at ${at || "the root"} is not supported`);
      for (const k of ["properties", "$defs"]) if (s[k]) for (const [n, v] of Object.entries(s[k])) walk(v as Schema, `${at}/${k}/${n}`);
      for (const k of ["additionalProperties", "propertyNames", "items", "not"]) if (s[k] !== undefined) walk(s[k], `${at}/${k}`);
      if (s.anyOf) s.anyOf.forEach((v: Schema, i: number) => walk(v, `${at}/anyOf/${i}`));
    };
    walk(root, "");
  }

  private resolve(s: Schema): Schema {
    while (typeof s === "object" && s.$ref) {
      const m = /^#\/\$defs\/(\w+)$/.exec(s.$ref);
      if (!m || !this.root.$defs?.[m[1]]) throw new Error(`json-schema: $ref ${s.$ref} is not supported`);
      s = this.root.$defs[m[1]];
    }
    return s;
  }
  private re(p: string): RegExp {
    let r = this.regexps.get(p);
    if (!r) this.regexps.set(p, (r = new RegExp(p, "u")));
    return r;
  }

  /** Whether v is valid (no problems). */
  valid(s: Schema, v: unknown): boolean {
    return this.check(s, v, "", []) === 0;
  }

  /** The problems of v against the schema (the root's, by default), at most `max`. */
  validate(v: unknown, max = 200): SchemaProblem[] {
    const out: SchemaProblem[] = [];
    this.check(this.root, v, "", out, max);
    return out;
  }

  // Adds v's problems to out (up to max) and returns how many it found.
  private check(s0: Schema, v: unknown, path: string, out: SchemaProblem[], max = Infinity): number {
    const s = this.resolve(s0);
    const n0 = out.length;
    const say = (message: string, at = path) => { if (out.length < max) out.push({ path: at, message }); };
    if (s === true) return 0;
    if (s === false) { say("not allowed here"); return out.length - n0 || 1; }
    if (s.type !== undefined) {
      const t = s.type as string;
      const ok = t === "integer" ? typeof v === "number" && Number.isInteger(v) : t === "number" ? typeof v === "number" : t === "array" ? Array.isArray(v)
        : t === "object" ? !!v && typeof v === "object" && !Array.isArray(v) : typeof v === t;
      if (!ok) { say(`should be ${TYPE_WORDS[t] ?? t}, not ${kindOf(v)}${typeof v !== "object" ? ` (${show(v)})` : ""}`); return out.length - n0 || 1; }
      // (JSON's numbers are finite; a number past a double's range, 1e999, reads as infinity, which the board drops, CORR-7A7-2)
      if ((t === "number" || t === "integer") && !Number.isFinite(v)) { say(`should be a finite number: ${String(v)} (a number past about 1.8e308, such as 1e999, is read as infinity)`); return out.length - n0 || 1; }
    }
    if ("const" in s && v !== s.const) say(`should be ${show(s.const)}, not ${show(v)}`);
    if (s.enum && !s.enum.includes(v)) say(`should be one of ${s.enum.map(show).join(", ")}, not ${show(v)}`);
    if (typeof v === "string" && s.pattern && !this.re(s.pattern).test(v)) say(`${show(v)} is not allowed: ${s.description ? String(s.description).replace(/^required:?\s*/, "") : `it is of the form ${s.pattern}`}`);
    if (typeof v === "number") {
      if (s.minimum !== undefined && v < s.minimum) say(`should be at least ${s.minimum}, not ${v}`);
      if (s.maximum !== undefined && v > s.maximum) say(`should be at most ${s.maximum}, not ${v}`);
      if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) say(`should be more than ${s.exclusiveMinimum}, not ${v}`);
      if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) say(`should be less than ${s.exclusiveMaximum}, not ${v}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) say(`should have at least ${s.minItems} entries, not ${v.length}`);
      if (s.items !== undefined) v.forEach((x, i) => this.check(s.items, x, step(path, i), out, max));
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>, props = s.properties ?? {};
      for (const r of s.required ?? []) if (!own(o, r)) say(`needs \`${r}\`${own(props, r) && props[r]?.description ? `: ${String(props[r].description).replace(/^required:?\s*/, "")}` : ""}`);
      for (const [k, x] of Object.entries(o)) {
        if (own(props, k)) this.check(props[k], x, step(path, k), out, max);
        else if (s.additionalProperties === false) {
          const near = didYouMean(k, Object.keys(props));
          // (a field of another kind of thing, where it belongs: the board's language is the document's)
          const where = HINTS[k] && !own(props, k) && own(this.root.properties ?? {}, k) ? ` (${HINTS[k]})` : "";
          say(`unknown field \`${k}\`${where || (near ? ` (did you mean \`${near}\`?)` : `; the fields here are ${Object.keys(props).map((p) => `\`${p}\``).join(", ")}`)}`, step(path, k));
        } else if (s.additionalProperties !== undefined) this.check(s.additionalProperties, x, step(path, k), out, max);
        if (s.propertyNames && !this.valid(s.propertyNames, k)) say(`the name ${show(k)} is not allowed${s.propertyNames.pattern ? ` (of the form ${s.propertyNames.pattern})` : ""}`, step(path, k));
      }
      for (const [k, needs] of Object.entries(s.dependentRequired ?? {}) as [string, string[]][])
        if (own(o, k)) for (const r of needs) if (!own(o, r)) say(`\`${k}\` needs \`${r}\` too`, step(path, k));
    }
    if (s.not !== undefined && this.valid(s.not, v)) say(s.not.description ?? "has what is not allowed here");
    if (s.anyOf) this.anyOf(s, v, path, out, max, say);
    return out.length - n0;
  }

  private anyOf(s: Record<string, any>, v: unknown, path: string, out: SchemaProblem[], max: number, say: (m: string, at?: string) => void) {
    const branches: Schema[] = s.anyOf;
    // (items: their `kind` says which branch; its problems, not "none of 4")
    const kinds = branches.map((b) => this.resolve(b)).map((b) => (typeof b === "object" && b.properties?.kind ? b : null));
    if (kinds.every((b) => b) && v && typeof v === "object" && !Array.isArray(v)) {
      const kind = (v as any).kind;
      const pick = kinds.findIndex((b) => (kind === undefined ? !(b!.required ?? []).includes("kind") : this.valid(b!.properties.kind, kind)));
      if (pick >= 0) { this.check(branches[pick], v, path, out, max); return; }
      const names = kinds.map((b) => b!.properties.kind.const ?? b!.properties.kind.enum?.[0]).filter((x) => x !== undefined);
      say(`unknown kind ${show(kind)}: one of ${names.map(show).join(", ")} (a note's kind may be left out)`, step(path, "kind"));
      return;
    }
    if (branches.some((b) => this.valid(b, v))) return;
    // (a branch of only a type, or only required fields, said in words)
    const words = branches.map((b0) => {
      const b = this.resolve(b0) as Record<string, any>;
      if (b.description) return b.description;
      if (b.type) return TYPE_WORDS[b.type] + (b.items?.type ? ` of ${String(TYPE_WORDS[b.items.type]).replace(/^an? /, "")}s` : "");
      if (b.required && Object.keys(b).length === 1) return `with \`${b.required.join("`, `")}\``;
      if (b.pattern) return `of the form ${b.pattern}`;
      return null;
    });
    const fields = branches.map((b0) => { const b = this.resolve(b0) as Record<string, any>; return b.required?.length === 1 && Object.keys(b).length === 1 ? b.required[0] : null; });
    if (fields.every((f) => f)) say(`needs \`${fields.slice(0, -1).join("`, `")}\` or \`${fields.at(-1)}\``);
    else if (words.every((w) => w)) say(`should be ${words.join(", or ")}`);
    else {
      // (else the problems of the branch that comes closest)
      let best: SchemaProblem[] | null = null;
      for (const b of branches) { const p: SchemaProblem[] = []; this.check(b, v, path, p); if (!best || p.length < best.length) best = p; }
      for (const p of best ?? []) say(p.message, p.path);
    }
  }
}
