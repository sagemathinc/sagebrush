// The board format as a JSON Schema (draft 2020-12): web/board-format.schema.json,
// served at /board-format.schema.json, so a program writing boards can check
// them before anyone opens them; and the same as a module,
// web/board/format-schema.ts, for `sagebrush board check` (src/board-check.ts).  Written
// from web/board/doc.ts's interfaces, as the field reference is
// (scripts/board-format-fields.mjs), with the rules the board's loader
// (doc.ts cleanDoc) applies to values that the types don't say: colors,
// pictures' names and sources, the seed, sizes.  Each such rule is read
// from doc.ts (a regular expression), or must still be there as written (a
// bound), so a change there is a change here, or this script fails.
// test/board-format-schema.test.ts checks the schema against cleanDoc.
//
//   node scripts/board-format-schema.mjs           write the schema
//   node scripts/board-format-schema.mjs --check   exit 1 if it is not as written
//   node scripts/board-format-schema.mjs --stdout  print it
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { split, typeReader } from "./board-doc-types.mjs";

// (BOARD_FORMAT_ROOT: another tree than this one, for its test)
const root = process.env.BOARD_FORMAT_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "web", "board-format.schema.json");
const MODULE = join(root, "web", "board", "format-schema.ts");
const DOC = "web/board/doc.ts";
const parse = typeReader(root);
const problems = [];

// [file, interface]: the schema's definitions; BoardDoc is the document
const DEFS = [
  [DOC, "BoardDoc"], [DOC, "BoardPage"], [DOC, "DocNote"], [DOC, "DocGroup"], [DOC, "DocInk"], [DOC, "DocSticker"], [DOC, "DocAsk"], [DOC, "AskChoice"], [DOC, "AskHintCode"], [DOC, "AskNext"], [DOC, "AskDecide"],
  [DOC, "DocEdge"], [DOC, "DocStep"], [DOC, "SlideRect"], [DOC, "PageBackground"], ["web/board/images.ts", "ImageInfo"],
];
const DEFINED = new Set(DEFS.map(([, n]) => n));
// (a type Sagebrush writes, whose fields a writer never does: any object)
const OPAQUE = new Set(["Preview"]);

// A regular expression of a file's source (its text between the slashes
// and its flags), found by the text before it (and how it starts).
function regexIn(file, before, starts = "/") {
  const text = parse(file).text, at = text.indexOf(before + starts);
  if (at < 0) { problems.push(`${file}: no "${before}" (the schema reads a rule there)`); return null; }
  const m = /^\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+)\/([a-z]*)/.exec(text.slice(at + before.length));
  if (!m) { problems.push(`${file}: no regular expression after "${before}"`); return null; }
  return { source: m[1], flags: m[2] };
}
// A JSON Schema pattern (ECMA-262, no flags) matching what the regular
// expression matches: an `i` one with both cases of each letter.
function pattern(re) {
  if (!re) return undefined;
  if (re.flags.replace("i", "")) problems.push(`a rule's regular expression has flags the schema can't write: /${re.source}/${re.flags}`);
  if (!re.flags.includes("i")) return re.source;
  const swap = (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  const letter = (c) => /[a-zA-Z]/.test(c);
  let out = "", inClass = false, body = "";
  for (let i = 0; i < re.source.length; i++) {
    const c = re.source[i];
    if (c === "\\") { out += c + re.source[++i]; continue; }
    if (inClass) {
      // (a letter or a range of them, and its other case unless the class has it)
      if (c === "]") inClass = false;
      else if (letter(c) && re.source[i + 1] === "-" && letter(re.source[i + 2] ?? "")) {
        const other = swap(c) + "-" + swap(re.source[i + 2]);
        out += c + "-" + re.source[i + 2] + (body.includes(other) ? "" : other);
        i += 2;
        continue;
      } else if (letter(c)) { out += c + (body.includes(swap(c)) ? "" : swap(c)); continue; }
      out += c;
      continue;
    }
    if (c === "[") { inClass = true; body = re.source.slice(i + 1, re.source.indexOf("]", i)); out += c; continue; }
    out += letter(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c;
  }
  return out;
}
// (a rule written as a bound in the loader: it must be there as written)
function bound(file, text) {
  if (!parse(file).text.includes(text)) problems.push(`${file}: the loader's rule "${text}" is not there as written: update scripts/board-format-schema.mjs`);
}

// The loader's rules on values, by field
const COLOR = regexIn(DOC, "const COLOR = ");
// (safeColor takes the color trimmed)
const colorPattern = COLOR && `^\\s*(?:${pattern(COLOR).replace(/^\^/, "").replace(/\$$/, "")})\\s*$`;
const IMAGE_NAME = pattern(regexIn(DOC, "const IMAGE_NAME = "));
const ICON_NAME = pattern(regexIn(DOC, "export const ICON_NAME = "));
const SEED = pattern(regexIn(DOC, `seed: typeof d?.seed === "string" && `));
const IMAGE_SRC = pattern(regexIn(DOC, "const IMAGE_SRC = "));
const DATA_URL = pattern(regexIn("web/image-size.ts", "const m = ", "/^data:"));
bound(DOC, "size !== undefined && size > 0 && size <= 200");
bound(DOC, "opacity !== undefined && opacity > 0 && opacity < 1");
bound(DOC, "w !== undefined && w >= 8 && w <= 4000");
bound(DOC, "w !== undefined && h !== undefined && w > 0 && h > 0 ? { x, y, w, h }");
bound(DOC, "if (!IMAGE_NAME.test(k) || !w || !h || w <= 0 || h <= 0) continue;");
bound(DOC, "if (!emoji && !icon) return null;");
// (one emoji: no ASCII letter, no control character, something besides
// spaces; that it is one grapheme, `sagebrush board check` checks)
bound(DOC, "if (!t || t.length > 16 || /[A-Za-z]|\\p{Cc}/u.test(t)) return undefined;");
bound(DOC, "hideCode: code !== undefined && n.hideCode === true");
bound(DOC, "Number.isInteger(n.checkMs) && n.checkMs >= 1 && n.checkMs <= 10000");
bound(DOC, "Number.isInteger(n.attempts) && n.attempts >= 0");
bound(DOC, "Number.isInteger(n.wrongAttempts) && n.wrongAttempts >= 0");
bound(DOC, "preview: code !== undefined ? cleanPreview(n.preview) : undefined");
bound(DOC, "Math.max(1, columns ?? Math.ceil(Math.sqrt(nodes.length)))");
bound(DOC, "if (d?.version > VERSION)");
const positive = { exclusiveMinimum: 0 };
const FIELD_RULES = {
  "DocNote.color": { pattern: colorPattern }, "DocGroup.color": { pattern: colorPattern }, "DocInk.color": { pattern: colorPattern },
  "DocSticker.color": { pattern: colorPattern }, "DocAsk.color": { pattern: colorPattern }, "PageBackground.color": { pattern: colorPattern },
  "DocNote.image": { pattern: IMAGE_NAME }, "PageBackground.image": { pattern: IMAGE_NAME },
  "DocSticker.icon": { pattern: ICON_NAME }, "DocSticker.emoji": { pattern: "^[^A-Za-z\\p{Cc}]*[^A-Za-z\\p{Cc}\\s][^A-Za-z\\p{Cc}]*$" }, "BoardDoc.seed": { pattern: SEED },
  "ImageInfo.src": { anyOf: [{ pattern: IMAGE_SRC, description: "an https: address" }, { pattern: DATA_URL, description: "a data: URL of a PNG, JPEG, GIF or WebP picture (base64)" }] },
  "ImageInfo.w": positive, "ImageInfo.h": positive, "SlideRect.w": positive, "SlideRect.h": positive,
  "DocInk.size": { exclusiveMinimum: 0, maximum: 200 }, "DocInk.opacity": { exclusiveMinimum: 0, exclusiveMaximum: 1 },
  "DocInk.points": { minItems: 3 }, "DocAsk.checkMs": { type: "integer", minimum: 1, maximum: 10000 }, "DocAsk.attempts": { type: "integer", minimum: 0, maximum: Number.MAX_VALUE }, "DocAsk.wrongAttempts": { type: "integer", minimum: 0, maximum: Number.MAX_VALUE }, "DocSticker.w": { minimum: 8, maximum: 4000 },
  // (a grid's columns: a whole number, at least 1)
  "DocGroup.columns": { type: "integer", minimum: 1, maximum: Number.MAX_VALUE }, "BoardPage.columns": { type: "integer", minimum: 1, maximum: Number.MAX_VALUE }, "BoardDoc.columns": { type: "integer", minimum: 1, maximum: Number.MAX_VALUE },
};
const VERSION = Number(parse(DOC).consts.VERSION);
if (!Number.isInteger(VERSION)) problems.push(`${DOC}: no VERSION`);
FIELD_RULES["BoardDoc.version"] = { type: "integer", minimum: 1, maximum: VERSION };
// rules on an object as a whole (as the loader keeps or drops it)
const OBJECT_RULES = {
  DocSticker: { anyOf: [{ required: ["emoji"] }, { required: ["icon"] }], description: "A sticker: one emoji, or one of CoCalc's icons, shown without a frame. It needs `emoji` or `icon`." },
  DocNote: { dependentRequired: { hideCode: ["code"], preview: ["code"] } },
  // (a board: one page, its own nodes; or pages, and no nodes, edges or steps of its own)
  BoardDoc: {
    anyOf: [
      { required: ["nodes"], not: { required: ["pages"] }, description: "one page: its `nodes` (and `edges`, `steps`), and no `pages`" },
      { required: ["pages"], not: { anyOf: [{ required: ["nodes"] }, { required: ["edges"] }, { required: ["steps"] }] }, description: "several: `pages`, each with its own `nodes`, and no `nodes`, `edges` or `steps` of the document's own" },
    ],
  },
};

// A type of doc.ts as a JSON Schema
function schemaOf(type, f) {
  const parts = split(type, "|");
  if (parts.length > 1) {
    const each = parts.map((p) => schemaOf(p, f));
    if (each.every((s) => "const" in s)) return { enum: each.map((s) => s.const) };
    return { anyOf: each };
  }
  const t = type.trim();
  // (a number: finite, as the loader keeps only finite ones; 1e999 in JSON text reads as infinity, CORR-7A7-2)
  if (t === "number") return { type: t, minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE };
  if (["string", "boolean"].includes(t)) return { type: t };
  if (/^"[^"]*"$/.test(t)) return { const: JSON.parse(t) };
  if (/^\d+$/.test(t)) return { const: Number(t) };
  let m = /^(.+)\[\]$/.exec(t);
  if (m) return { type: "array", items: schemaOf(m[1], f) };
  m = /^typeof (\w+)$/.exec(t);
  if (m && f.consts[m[1]]) return schemaOf(f.consts[m[1]], f);
  m = /^(\w+)\["(\w+)"\]$/.exec(t);
  if (m) { const field = f.interfaces[m[1]]?.fields.find((x) => x.name === m[2]); if (field) return schemaOf(field.type, f); }
  m = /^Record<string, (.+)>$/.exec(t);
  if (m) return { type: "object", additionalProperties: schemaOf(m[1], f) };
  if (DEFINED.has(t)) return { $ref: `#/$defs/${t}` };
  if (OPAQUE.has(t)) return { type: "object" };
  if (f.aliases[t]) return schemaOf(f.aliases[t], f);
  problems.push(`a type the schema can't write out: ${t}`);
  return {};
}

const defs = {};
for (const [file, name] of DEFS) {
  const f = parse(file), i = f.interfaces[name];
  if (!i) { problems.push(`no interface ${name} in ${file}`); continue; }
  problems.push(...i.unread);
  const properties = {}, required = [];
  for (const { name: field, optional, type, doc } of i.fields) {
    const s = { ...schemaOf(type, f), ...(FIELD_RULES[`${name}.${field}`] ?? {}) };
    // (an exclusive bound is the field's own: it replaces the double's range on that side)
    if ("exclusiveMinimum" in s) delete s.minimum;
    if ("exclusiveMaximum" in s) delete s.maximum;
    if (doc) s.description = doc;
    properties[field] = s;
    if (!optional) required.push(field);
  }
  defs[name] = { type: "object", ...(i.doc ? { description: i.doc } : {}), properties, ...(required.length ? { required } : {}), additionalProperties: false, ...(OBJECT_RULES[name] ?? {}) };
}
// (every rule names a field there is)
for (const k of Object.keys(FIELD_RULES)) {
  const [n, field] = k.split(".");
  if (!defs[n]?.properties[field]) problems.push(`a rule for ${k}, which is no field`);
}
// pictures' names: the keys of `images`
if (defs.BoardDoc?.properties.images) defs.BoardDoc.properties.images.propertyNames = { pattern: IMAGE_NAME };
// an item: its kind says which (a note's is "note", or left out)
const nodeUnion = parse(DOC).aliases.DocNode;
if (!nodeUnion) problems.push(`no type DocNode in ${DOC}`);
defs.DocNode = { description: "An item: a note, a group, ink, a sticker or a question, as its `kind` says (a note's `kind` is `\"note\"`, or left out).", anyOf: split(nodeUnion ?? "", "|").map((n) => ({ $ref: `#/$defs/${n}` })) };

const { $ref, ...doc } = { $ref: null, ...defs.BoardDoc };
const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://sagebrush.space/board-format.schema.json",
  title: "Sagebrush board",
  ...doc,
  description: `${defs.BoardDoc?.description ?? ""} Written from web/board/doc.ts by scripts/board-format-schema.mjs; the format is described at https://sagebrush.space/board-format.md.`,
  $defs: Object.fromEntries(Object.entries(defs).filter(([n]) => n !== "BoardDoc")),
};
const text = JSON.stringify(schema, null, 1) + "\n";
const module = "// The board format's JSON Schema (web/board-format.schema.json), as a module\n// for the command line: written by scripts/board-format-schema.mjs; edit\n// web/board/doc.ts, not this.\nexport const BOARD_SCHEMA = " + JSON.stringify(schema, null, 1) + ";\n";

if (problems.length) {
  process.stderr.write(`board-format-schema: ${problems.length} problem(s):\n  ${problems.join("\n  ")}\n`);
  process.exit(1);
}
if (process.argv.includes("--stdout")) {
  process.stdout.write(text);
  process.exit(0);
}
const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } };
const stale = [[OUT, text], [MODULE, module]].filter(([f, t]) => read(f) !== t);
if (process.argv.includes("--check")) {
  if (stale.length) {
    process.stderr.write(`board-format-schema: ${stale.map(([f]) => f.slice(root.length + 1)).join(" and ")} ${stale.length > 1 ? "are" : "is"} not as web/board/doc.ts says: run node scripts/board-format-schema.mjs\n`);
    process.exit(1);
  }
  console.log("web/board-format.schema.json is as web/board/doc.ts says");
} else if (stale.length) {
  for (const [f, t] of stale) writeFileSync(f, t);
  console.log(`wrote ${stale.map(([f]) => f.slice(root.length + 1)).join(" and ")}`);
} else console.log("web/board-format.schema.json was already as web/board/doc.ts says");
