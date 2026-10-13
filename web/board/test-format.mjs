// A board's file, foo.board.json (doc.ts canonical()): format and version
// first, the document's keys in a fixed order whatever order they came in,
// two spaces of indent, arrays of numbers or strings on one line, a final
// newline; and the same text again when it is read and written, for every
// example (and Mermaid's, converted).  With bun:
//   bun web/board/test-format.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, cleanDoc } from "./doc.ts";
import { boardFromText } from "./mermaid.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// every example, and Mermaid's converted: read and written, the same text; nothing lost
const docs = readdirSync(join(here, "examples")).filter((f) => /\.(json|md)$/.test(f) && f !== "index.json")
  .map((f) => [f, boardFromText(readFileSync(join(here, "examples", f), "utf8"), f, () => {})]);
check(docs.length >= 6, "the examples: " + docs.length);
for (const [f, d] of docs) {
  const t = canonical(d);
  check(canonical(JSON.parse(t)) === t, `${f}: written, read and written again, not the same text`);
  check(same(JSON.parse(t), JSON.parse(JSON.stringify(cleanDoc(d)))) || same(Object.entries(JSON.parse(t)).sort(), Object.entries(JSON.parse(JSON.stringify(cleanDoc(d)))).sort()), `${f}: the file is not the document`);
  check(t.startsWith('{\n  "format": "sagebrush-board",\n  "version": 1,\n'), `${f}: does not start with its format and version: ${t.slice(0, 60)}`);
  check(t.endsWith("}\n") && !t.includes("\t") && t.split("\n").every((l) => /^( {2})*\S/.test(l) || l === ""), `${f}: not two spaces of indent and a final newline`);
}

// the keys' order is the file's, not the document's
const d = {
  images: { "a-picture": { h: 20, w: 30 } },
  steps: [{ say: "Both", focus: ["a", "b"] }],
  edges: [{ to: "b", from: "a", label: "to b" }],
  nodes: [{ text: "first", id: "a", title: "A", x: 1, y: 2 }, { kind: "group", id: "g", children: [{ id: "b", title: "B", code: "x = 1" }] }],
  tools: ["note", "code"],
  mode: "sage",
  title: "Order",
  version: 1,
  format: "sagebrush-board",
};
const t = canonical(d);
const keys = Object.keys(JSON.parse(t));
check(same(keys, ["format", "version", "title", "mode", "tools", "nodes", "edges", "steps", "images"]), "the document's keys are in the file's order: " + keys.join());
check(same(Object.keys(JSON.parse(t).nodes[0]), ["id", "title", "text", "x", "y"]) && same(Object.keys(JSON.parse(t).edges[0]), ["from", "to", "label"]), "a note's and an edge's keys are in a fixed order");
check(canonical(Object.fromEntries(Object.entries(d).reverse())) === t, "the same document with its keys in another order is the same text");
check(t.includes('"tools": ["note", "code"]') && t.includes('"focus": ["a", "b"]'), "arrays of strings are on one line:\n" + t);
check(t.includes('"images": {\n    "a-picture": {\n      "w": 30,\n      "h": 20\n    }\n  }\n}\n'), "pictures last, an object a key a line:\n" + t.slice(-120));
// pages: the same, page by page
const p = canonical({ title: "Paged", pages: [{ title: "One", nodes: [{ id: "a", title: "A" }] }, { title: "Two", nodes: [{ id: "b", title: "B" }], steps: [{ focus: "b" }] }] });
check(canonical(JSON.parse(p)) === p && Object.keys(JSON.parse(p)).join() === "format,version,title,pages", "a document with pages: " + Object.keys(JSON.parse(p)).join());
// what the board does not keep is not in its file
check(!canonical({ nodes: [{ id: "a", title: "A", junk: 1 }], junk: 2 }).includes("junk"), "what a board does not keep is left out of its file");

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
