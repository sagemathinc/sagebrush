// A board's file, foo.board.json (doc.ts canonical()): format and version
// first, the document's keys in a fixed order whatever order they came in,
// two spaces of indent, arrays of numbers or strings on one line, a final
// newline; and the same text again when it is read and written, for every
// example (and Mermaid's, converted).  With bun:
//   bun web/board/test-format.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, cleanDoc, layout, formatError, isBoard } from "./doc.ts";
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
// a page's slide and background: kept when sound (before the content in the file), else dropped
const bg = cleanDoc({ title: "Deck", slide: { x: -525, y: -492, w: 1050, h: 591 }, background: { color: "#fff2bf", image: "a-picture" }, nodes: [], pages: [{ title: "One", slide: { x: 0, y: 0, w: -5, h: 10 }, background: { color: "red;background:url(x)", image: "../x" }, nodes: [] }, { title: "Two", slide: { x: "1", y: 0, w: 5, h: 5 }, background: { color: "#123456" }, nodes: [] }] });
check(JSON.stringify(bg.slide) === '{"x":-525,"y":-492,"w":1050,"h":591}' && JSON.stringify(bg.background) === '{"color":"#fff2bf","image":"a-picture"}', "a slide's card and a background are kept: " + JSON.stringify([bg.slide, bg.background]));
check(!bg.pages[0].slide && !bg.pages[0].background && !bg.pages[1].slide && JSON.stringify(bg.pages[1].background) === '{"color":"#123456"}', "...not a card without a size or with a place not a number, a color that isn't one, a picture's name that isn't one: " + JSON.stringify(bg.pages));
const bt = canonical({ title: "Deck", nodes: [{ id: "a" }], slide: { x: 0, y: 0, w: 160, h: 90 }, background: { color: "#ffffff" } });
check(Object.keys(JSON.parse(bt)).join() === "format,version,title,slide,background,nodes" && canonical(JSON.parse(bt)) === bt, "in the file, the slide and background come before the content: " + Object.keys(JSON.parse(bt)).join());

// a sticker: one emoji or an icon's name (kept in that form), else dropped; a picture is a note's
const st = cleanDoc({ nodes: [
  { id: "e", kind: "sticker", emoji: "⭐", w: 80, x: 1, y: 2, junk: 1 },
  { id: "i", kind: "sticker", icon: "star", color: "#f00", w: 3 },
  { id: "p", kind: "sticker", image: "a-picture" },
  { id: "z", kind: "sticker", emoji: " 👍🏿 ", icon: "Star", color: "red;x:y" },
  { id: "none", kind: "sticker" },
  { id: "bad", kind: "sticker", icon: "<img src=x onerror=1>", emoji: "x".repeat(40) },
] });
check(st.nodes.map((n) => n.id).join() === "e,i,z" && JSON.stringify(st.nodes[2]) === '{"id":"z","kind":"sticker","emoji":"👍🏿"}' && JSON.stringify(st.nodes[0]) === '{"id":"e","kind":"sticker","emoji":"⭐","x":1,"y":2,"w":80}' && st.nodes[1].w === undefined && st.nodes[1].color === "#f00", "a sticker is kept in its form (a width too small dropped); one with nothing, or only a bad name, is not: " + JSON.stringify(st.nodes));

// what the board does not keep is not in its file
check(!canonical({ nodes: [{ id: "a", title: "A", junk: 1 }], junk: 2 }).includes("junk"), "what a board does not keep is left out of its file");

// a group's size, as a person made it (William's B3): kept when a positive
// number of units, in its file after its place; its box the larger of it and
// what its items need
const sizedG = (w, h) => cleanDoc({ nodes: [{ id: "g", kind: "group", children: [{ id: "n", title: "N" }], x: 0, y: 0, w, h }] }).nodes[0];
check(sizedG(480, 320).w === 480 && sizedG(480, 320).h === 320, "a group's size is kept: " + JSON.stringify(sizedG(480, 320)));
check([[-5, 0], ["480", null], [Infinity, NaN], [1e9, 1e9]].every(([w, h]) => !("w" in sizedG(w, h)) && !("h" in sizedG(w, h))), "...not when it is not a positive number of units (at most 100000)");
check(/"x": 0,\n\s*"y": 0,\n\s*"w": 480,\n\s*"h": 320/.test(canonical({ nodes: [{ id: "g", kind: "group", children: [], x: 0, y: 0, w: 480, h: 320 }] })), "...in its file after its place");
const gBox = (w, h) => layout({ nodes: [{ id: "g", kind: "group", title: "G", children: [{ id: "n", title: "A note", text: "Some text" }], w, h }] }).items.find((i) => i.id === "g");
const natural = gBox(undefined, undefined);
check(gBox(900, 700).w === 900 && gBox(900, 700).h === 700, "a group made larger than its items need is that large: " + JSON.stringify(gBox(900, 700)));
check(gBox(10, 10).w === natural.w && gBox(10, 10).h === natural.h, "...made smaller, as large as its items need: " + JSON.stringify([gBox(10, 10), natural]));
const emptyG = layout({ nodes: [{ id: "e", kind: "group", children: [], w: 480, h: 320 }] }).items[0];
check(emptyG.empty === true && emptyG.w === 480 && emptyG.h === 320, "an empty group is as large as it was made, and says it is empty: " + JSON.stringify(emptyG));
// every JSON example in board-format.md is a board as the format says: a
// board, no error, nothing left out when it is read (the layout guide's
// dashboard among them)
{
  const md = readFileSync(join(here, "..", "board-format.md"), "utf8"), blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  check(blocks.length >= 2, "board-format.md's JSON examples: " + blocks.length);
  for (const b of blocks) {
    const d = JSON.parse(b), title = d.title;
    check(isBoard(d) && !formatError(d) && same(JSON.parse(canonical(cleanDoc(d))), JSON.parse(canonical(d))), "board-format.md's example is a board, read as written: " + title);
  }
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
