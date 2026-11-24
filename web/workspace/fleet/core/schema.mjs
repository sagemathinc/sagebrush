// Fleet protocol: one closed validator for the fleet schemas (schema/fleet/*.json), a strict subset of JSON Schema
// 2020-12. A schema is compiled once; any keyword this file doesn't implement refuses the schema at load time, so a
// schema can never silently rely on a feature a verifier skips. Values are plain JSON (as parseCanonical returns).
//
// Implemented: type (object, array, string, integer, number, boolean, null), properties, required, additionalProperties
// (false only), items, prefixItems, enum, const, pattern (unicode-mode RegExp), minLength/maxLength (code points, as
// JSON Schema counts), minimum/maximum, minItems/maxItems, uniqueItems, $ref ("#/$defs/<name>" only), $defs, oneOf,
// not, and $comment/$id/$schema/title/description as annotations.

import { canon, CANON_DEPTH } from "./canon.mjs";
import { refuse } from "./bytes.mjs";

const ANNOTATIONS = new Set(["$comment", "$id", "$schema", "title", "description"]);
const KNOWN = new Set([
  ...ANNOTATIONS, "type", "properties", "required", "additionalProperties", "items", "prefixItems", "enum", "const",
  "pattern", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "uniqueItems", "$ref", "$defs",
  "oneOf", "not",
]);
const TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);

// Equality for enum and const: both sides canonical and the same text. A value canon refuses (a float, NaN, a string
// past canon's bound) is never equal to anything, and compile() refuses such a value as an enum or const member.
const same = (a, b) => { const x = canon(a), y = canon(b); return x.ok && y.ok && x.text === y.text; };

// A total key for uniqueItems (JSON Schema equality): numbers by value (integers and floats alike; String(-0) is "0"),
// strings and booleans by JSON text, arrays by their items' keys, objects by their keys in canon's (UTF-16) order.
// It follows the value, not the schema, so it stops where canon does: past CANON_DEPTH nested containers.
function key(v, depth = 0) {
  if (v === null) return "null";
  if (typeof v === "number") return (Number.isSafeInteger(v) ? "i:" : "f:") + String(v);
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (depth >= CANON_DEPTH) refuse("bad_form", "nested too deeply");
  if (Array.isArray(v)) return "[" + v.map((x) => key(x, depth + 1)).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + key(v[k], depth + 1)).join(",") + "}";
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isSafeInteger(v) ? "integer" : "number";
  return typeof v;
}

/**
 * Compile a schema document. Returns validate(value) → true, or throws FleetError("bad_form") naming only the
 * schema path that failed (never the value).
 */
export function compile(doc) {
  const defs = doc.$defs ?? {};
  const compiled = new Map();

  function check(s, at) {
    if (s === true) return () => {};
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error(`schema ${at}: not a schema`);
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`schema ${at}: unsupported keyword ${k}`);
    if (Object.hasOwn(s, "additionalProperties") && s.additionalProperties !== false) throw new Error(`schema ${at}: additionalProperties must be false`);
    if (Object.hasOwn(s, "type") && !TYPES.has(s.type)) throw new Error(`schema ${at}: unsupported type ${s.type}`);
    if (Object.hasOwn(s, "$ref") && !/^#\/\$defs\/[A-Za-z0-9_-]+$/.test(s.$ref)) throw new Error(`schema ${at}: only #/$defs refs`);
    const steps = [];
    const fail = () => refuse("bad_form", `does not match ${at}`);
    if (s.$ref) {
      const name = s.$ref.slice(8);
      if (!Object.hasOwn(defs, name)) throw new Error(`schema ${at}: no $defs/${name}`);
      steps.push((v) => ref(name)(v));
    }
    if (s.type === "number") steps.push((v) => { if (typeof v !== "number" || !Number.isFinite(v)) fail(); }); // (any finite number, integers included)
    else if (s.type) steps.push((v) => { if (typeOf(v) !== s.type) fail(); });
    for (const e of [...(s.enum ?? []), ...(Object.hasOwn(s, "const") ? [s.const] : [])]) if (!canon(e).ok) throw new Error(`schema ${at}: enum/const values must be canonical`);
    if (s.enum) steps.push((v) => { if (!s.enum.some((e) => same(e, v))) fail(); });
    if (Object.hasOwn(s, "const")) steps.push((v) => { if (!same(s.const, v)) fail(); });
    if (s.pattern) { const re = new RegExp(s.pattern, "u"); steps.push((v) => { if (typeof v === "string" && !re.test(v)) fail(); }); }
    const cps = (v) => [...v].length;
    if (s.minLength !== undefined) steps.push((v) => { if (typeof v === "string" && cps(v) < s.minLength) fail(); });
    if (s.maxLength !== undefined) steps.push((v) => { if (typeof v === "string" && (v.length > 4 * s.maxLength || cps(v) > s.maxLength)) fail(); });
    if (s.minimum !== undefined) steps.push((v) => { if (typeof v === "number" && v < s.minimum) fail(); });
    if (s.maximum !== undefined) steps.push((v) => { if (typeof v === "number" && v > s.maximum) fail(); });
    if (s.minItems !== undefined) steps.push((v) => { if (Array.isArray(v) && v.length < s.minItems) fail(); });
    if (s.maxItems !== undefined) steps.push((v) => { if (Array.isArray(v) && v.length > s.maxItems) fail(); });
    if (s.uniqueItems) steps.push((v) => { if (Array.isArray(v) && new Set(v.map((x) => key(x))).size !== v.length) fail(); });
    if (s.prefixItems) {
      const ps = s.prefixItems.map((p, i) => check(p, `${at}/prefixItems/${i}`));
      steps.push((v) => { if (Array.isArray(v)) ps.forEach((p, i) => { if (i < v.length) p(v[i]); }); });
    }
    if (Object.hasOwn(s, "items")) {
      const start = s.prefixItems ? s.prefixItems.length : 0;
      if (s.items === false) steps.push((v) => { if (Array.isArray(v) && v.length > start) fail(); });
      else { const it = check(s.items, `${at}/items`); steps.push((v) => { if (Array.isArray(v)) for (let i = start; i < v.length; i++) it(v[i]); }); }
    }
    if (s.properties || s.required || s.additionalProperties === false) {
      const props = Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, p]) => [k, check(p, `${at}/properties/${k}`)]));
      const req = s.required ?? [];
      steps.push((v) => {
        if (typeOf(v) !== "object") return;
        for (const k of req) if (!Object.hasOwn(v, k)) fail();
        for (const k of Object.keys(v)) {
          if (Object.hasOwn(props, k)) props[k](v[k]);
          else if (s.additionalProperties === false) fail();
        }
      });
    }
    if (s.oneOf) {
      const alts = s.oneOf.map((a, i) => check(a, `${at}/oneOf/${i}`));
      steps.push((v) => {
        let n = 0;
        for (const a of alts) { try { a(v); n++; } catch (e) { if (e?.code !== "bad_form") throw e; } }
        if (n !== 1) fail();
      });
    }
    if (s.not) {
      const no = check(s.not, `${at}/not`);
      steps.push((v) => { let matched = true; try { no(v); } catch (e) { if (e?.code !== "bad_form") throw e; matched = false; } if (matched) fail(); });
    }
    return (v) => { for (const f of steps) f(v); };
  }

  function ref(name) {
    if (!compiled.has(name)) {
      compiled.set(name, (v) => real(v)); // (a placeholder, so recursive refs compile)
      const real = check(defs[name], `#/$defs/${name}`);
      compiled.set(name, real);
    }
    return compiled.get(name);
  }

  for (const name of Object.keys(defs)) ref(name);
  const root = check(Object.fromEntries(Object.entries(doc).filter(([k]) => k !== "$defs")), "#");
  return (value) => { root(value); return true; };
}
