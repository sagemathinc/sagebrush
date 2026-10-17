// The board format's field reference: the "Fields" section of
// web/board-format.md (served at /board-format.md), between its "fields"
// markers, written from the doc comments of the format's interfaces
// (web/board/doc.ts, and images.ts's ImageInfo), so the published
// reference can't drift from the code.  Every field needs a doc comment
// saying what it means to a writer, which starts "required" exactly when
// the field is required.
//
//   node scripts/board-format-fields.mjs           write the section
//   node scripts/board-format-fields.mjs --check   exit 1 if it is not as written
//   node scripts/board-format-fields.mjs --stdout  print it
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { split, typeReader } from "./board-doc-types.mjs";

const cell = (s) => s.replace(/\|/g, "\\|");

// (BOARD_FORMAT_ROOT: another tree than this one, for its test)
const root = process.env.BOARD_FORMAT_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(root, "web", "board-format.md");
const BEGIN = "<!-- fields: written by scripts/board-format-fields.mjs from the doc comments of web/board/doc.ts; edit those, not this -->";
const END = "<!-- /fields -->";

// [file, interface, heading]: the sections, in order
const SECTIONS = [
  ["web/board/doc.ts", "BoardDoc", "The document"],
  ["web/board/doc.ts", "BoardPage", "A page (in `pages`)"],
  ["web/board/doc.ts", "DocNote", "A note (the default item)"],
  ["web/board/doc.ts", "DocGroup", "A group"],
  ["web/board/doc.ts", "DocEdge", "An edge"],
  ["web/board/doc.ts", "DocStep", "A tour step"],
  ["web/board/doc.ts", "DocSticker", "A sticker"],
  ["web/board/doc.ts", "DocInk", "Ink"],
  ["web/board/doc.ts", "DocAsk", "A question (`kind: \"ask\"`)"],
  ["web/board/doc.ts", "AskChoice", "An option (in a question's `options`)"],
  ["web/board/doc.ts", "AskHintCode", "A computed hint (in a question's `hints`)"],
  ["web/board/doc.ts", "AskNext", "Where a question leads (its `next`)"],
  ["web/board/doc.ts", "AskDecide", "What a reader's words may show (in a question's `decide`)"],
  ["web/board/doc.ts", "SlideRect", "A slide's card (`slide`)"],
  ["web/board/doc.ts", "PageBackground", "A background (`background`)"],
  ["web/board/images.ts", "ImageInfo", "A picture (in `images`)"],
];
// (a type that is a section: named as the section's item)
const NAMES = { DocNode: "item", DocNote: "note", DocGroup: "group", DocEdge: "edge", DocStep: "step", BoardPage: "page", SlideRect: "card", PageBackground: "background", ImageInfo: "picture", DocSticker: "sticker", DocInk: "ink", DocAsk: "question", AskChoice: "option", AskHintCode: "computed hint", AskNext: "next", AskDecide: "decision" };
// (a type Sagebrush writes, whose fields a writer never does: written as `object`)
const OPAQUE = new Set(["Preview"]);

const problems = [];

// The interfaces of a file as its source writes them (scripts/board-doc-types.mjs)
const parse = typeReader(root);

// A type as a reader writes it: keywords, literals (aliases of them inlined), [lists], {name: value}, and the sections' items.
function typeText(type, f) {
  const parts = split(type, "|");
  if (parts.length > 1) return parts.map((p) => typeText(p, f)).join(" | ");
  const t = type.trim();
  if (["string", "number", "boolean"].includes(t)) return t;
  if (/^"[^"]*"$/.test(t) || /^\d+$/.test(t)) return "`" + t + "`";
  let m = /^(.+)\[\]$/.exec(t);
  if (m) return `[${typeText(m[1], f)}]`;
  m = /^typeof (\w+)$/.exec(t);
  if (m && f.consts[m[1]]) return typeText(f.consts[m[1]], f);
  m = /^(\w+)\["(\w+)"\]$/.exec(t);
  if (m) { const field = f.interfaces[m[1]]?.fields.find((x) => x.name === m[2]); if (field) return typeText(field.type, f); }
  m = /^Record<string, (.+)>$/.exec(t);
  if (m) return `{name: ${typeText(m[1], f)}}`;
  if (NAMES[t]) return NAMES[t];
  if (OPAQUE.has(t)) return "object";
  if (f.aliases[t]) return typeText(f.aliases[t], f);
  problems.push(`a type the field reference can't write out: ${t}`);
  return t;
}

const out = [BEGIN, "## Fields", ""];
// (the kinds of item, as doc.ts's DocNode lists them)
const kinds = split(parse("web/board/doc.ts").aliases.DocNode ?? "", "|").map((m) => NAMES[m] ?? m);
const either = kinds.length > 1 ? kinds.slice(0, -1).join(", ") + " or " + kinds.at(-1) : kinds.join("");
out.push("Each kind of thing in a board, its fields, their types and what they mean. A type in words (note, edge, page, ...) is the section of that name, and `item` is any of " + either + "; `[x]` is a list of them, `{name: x}` an object of them by name; `object` is one Sagebrush writes, whose fields this page doesn't list.", "");
for (const [file, name, heading] of SECTIONS) {
  const f = parse(file), i = f.interfaces[name];
  if (!i) { problems.push(`no interface ${name} in ${file}`); continue; }
  problems.push(...i.unread);
  out.push(`### ${heading}`, "");
  if (i.doc) out.push(i.doc, "");
  else problems.push(`${name}: no doc comment`);
  out.push("| field | type | meaning |", "|---|---|---|");
  for (const { name: field, optional, type, doc } of i.fields) {
    if (!doc) { problems.push(`${name}.${field}: no doc comment`); continue; }
    if (!optional !== /^required\b/.test(doc)) problems.push(`${name}.${field}: ${optional ? "optional, but its comment starts \"required\"" : "required, but its comment doesn't start \"required\""}`);
    out.push(`| \`${field}\` | ${cell(typeText(type, f))} | ${cell(doc)} |`);
  }
  out.push("");
}
out.push(END);
const section = out.join("\n");
// (every kind of item a section, as doc.ts's DocNode lists them; and every
// type written as a section's name one: a new kind of item is never left
// out unseen, HARD-EC7-1)
const sectioned = new Set(SECTIONS.map(([, name]) => name));
const union = parse("web/board/doc.ts").aliases.DocNode;
if (!union) problems.push("no type DocNode in web/board/doc.ts");
else for (const m of split(union, "|")) if (!sectioned.has(m)) problems.push(`DocNode's ${m}: a kind of item with no section in the field reference (add it to SECTIONS)`);
for (const name of Object.keys(NAMES)) if (name !== "DocNode" && !sectioned.has(name)) problems.push(`${name}: written as "${NAMES[name]}", but no section has it`);

if (problems.length) {
  process.stderr.write(`board-format-fields: ${problems.length} problem(s):\n  ${problems.join("\n  ")}\n`);
  process.exit(1);
}
if (process.argv.includes("--stdout")) {
  process.stdout.write(section + "\n");
  process.exit(0);
}
const page = readFileSync(PAGE, "utf8"), a = page.indexOf(BEGIN), b = page.indexOf(END);
if (a < 0 || b < a) {
  process.stderr.write(`board-format-fields: ${PAGE} has no fields markers (${BEGIN} ... ${END})\n`);
  process.exit(1);
}
const next = page.slice(0, a) + section + page.slice(b + END.length);
if (process.argv.includes("--check")) {
  if (next !== page) {
    process.stderr.write("board-format-fields: web/board-format.md's Fields are not as web/board/doc.ts says: run node scripts/board-format-fields.mjs\n");
    process.exit(1);
  }
  console.log("web/board-format.md's Fields are as web/board/doc.ts says");
} else if (next !== page) {
  writeFileSync(PAGE, next);
  console.log("wrote web/board-format.md's Fields");
} else console.log("web/board-format.md's Fields were already as web/board/doc.ts says");
