// JSON Canvas (canvas.ts): a canvas read as a board, and boards written as
// canvases.  A canvas's cards become notes where they were (laid out, each
// at its x and y), in the groups holding them, groups in groups; a heading
// is a note's title and a python or sage block its code; link and file cards
// keep where they point; edges their labels and arrows; colors the board's
// tints; what a board has nothing like is counted.  Every example written as
// a canvas is valid JSON Canvas and reads back as the same board (its notes,
// groups, edges), and a board with pages is a group a page, one below the
// other.  With bun:
//   bun web/board/test-canvas.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canvasLeftOut, fromCanvas, isCanvas, toCanvas } from "./canvas.ts";
import { layout, pageCount, pageView } from "./doc.ts";
import { boardFromText } from "./mermaid.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

// a canvas with one of everything
const C = {
  nodes: [
    { id: "outer", type: "group", x: 0, y: 0, width: 900, height: 700, label: "Outer", color: "4" },
    { id: "inner", type: "group", x: 40, y: 80, width: 400, height: 400, label: "Inner" },
    { id: "bg", type: "group", x: 1000, y: 0, width: 300, height: 300, background: "pic.png" },
    { id: "t1", type: "text", x: 60, y: 140, width: 250, height: 120, text: "## A title\n\nSome *text*.", color: "#ff0000" },
    { id: "t2", type: "text", x: 500, y: 100, width: 300, height: 200, text: "Run this:\n\n```python\nx = 1\n```" },
    { id: "l1", type: "link", x: 500, y: 400, width: 300, height: 100, url: "https://jsoncanvas.org/" },
    { id: "f1", type: "file", x: 1040, y: 60, width: 200, height: 150, file: "Notes/Ideas.md", subpath: "#Plans" },
    { id: "far", type: "text", x: 1500, y: 900, width: 200, height: 60, text: "On its own" },
    { id: "odd", type: "widget", x: 0, y: 900, width: 50, height: 50 },
  ],
  edges: [
    { id: "a", fromNode: "t1", toNode: "t2", label: "then" },
    { id: "b", fromNode: "t2", toNode: "l1", toEnd: "none" },
    { id: "c", fromNode: "l1", toNode: "f1", fromEnd: "arrow" },
    { id: "d", fromNode: "far", toNode: "t1", fromEnd: "arrow", toEnd: "none", label: "back" },
    { id: "e", fromNode: "t1", toNode: "nowhere" },
  ],
};
const text = JSON.stringify(C, null, "\t");
check(isCanvas(text) && !isCanvas(JSON.stringify({ format: "sagebrush-board", nodes: [{ id: "a" }] })) && !isCanvas("{}") && !isCanvas("graph TD; A-->B"), "a canvas is told from a board and from other text");
const { doc, left } = fromCanvas(text);
const walk = (ns, parent, out = new Map()) => { for (const n of ns) { out.set(n.id, { ...n, parent }); if (n.kind === "group") walk(n.children, n.id, out); } return out; };
const by = walk(doc.nodes, null);
check(by.get("inner")?.parent === "outer" && by.get("t1")?.parent === "inner" && by.get("t2")?.parent === "outer" && by.get("l1")?.parent === "outer" && by.get("f1")?.parent === "bg" && by.get("far")?.parent === null, "groups hold what is inside them, groups in groups: " + JSON.stringify([...by].map(([k, v]) => [k, v.parent])));
// laid out, each card is where the canvas had it
const { items } = layout(doc);
const at = new Map(items.map((it) => [it.id, it]));
for (const n of C.nodes.filter((n) => ["text", "link", "file"].includes(n.type))) {
  const it = at.get(n.id);
  check(it && Math.abs(it.x - n.x) <= 1 && Math.abs(it.y - n.y) <= 1 && Math.abs(it.w - n.width) <= 1, `${n.id} laid out at (${it?.x}, ${it?.y}) ${it?.w} wide, not (${n.x}, ${n.y}) ${n.width} wide`);
}
check(by.get("t1").title === "A title" && by.get("t1").text === "Some *text*." && by.get("t2").text === "Run this:" && by.get("t2").code === "x = 1", "a heading is a note's title, a python block its code");
check(by.get("l1").ref === "https://jsoncanvas.org/" && by.get("f1").title === "Ideas.md" && by.get("f1").ref === "Notes/Ideas.md#Plans", "a link card keeps its link, a file card names its file and links to it");
check(by.get("outer").title === "Outer" && !by.get("bg").title, "a group's label is its title");
const edge = (f, t) => doc.edges.find((e) => e.from === f && e.to === t);
check(edge("t1", "t2")?.label === "then" && !edge("t1", "t2").arrow, "an edge keeps its label; an arrow at its end is the board's");
check(edge("t2", "l1")?.arrow === "none" && edge("l1", "f1")?.arrow === "both" && edge("t1", "far")?.label === "back" && !edge("t1", "far").arrow, "no arrow, both arrows, and an arrow only at its start (the edge the other way)");
check(by.get("t1").color === "#ffbfbf" && by.get("outer").color === "#dbeed3", "a preset is the board's tint, another color a tint of itself: " + by.get("t1").color + " " + by.get("outer").color);
check(left.background === 1 && left.card === 1 && left.edge === 1 && doc.edges.length === 4, "what a board has nothing like is counted: " + JSON.stringify(left));
check(canvasLeftOut(left) === "1 group's background picture, 1 card of a kind a board doesn't have and 1 connection to something left out", "...in words: " + canvasLeftOut(left));
check(fromCanvas(JSON.stringify({ nodes: [{ id: "s", type: "text", x: 0, y: 0, width: 100, height: 50, text: "```sage\nfactor(12)\n```" }] })).doc.mode === "sage", "a sage block makes the board Sage");
// read through Open (boardFromText): converted, and said so
let said = "";
const opened = boardFromText(text, "Ideas.canvas", (m) => { said = m; });
check(opened.title === "Ideas" && /JSON Canvas/.test(said) && /background picture/.test(said), "Open reads a .canvas, and says what it left out: " + said);

// every example as a canvas: valid, and the same board read back
const examples = readdirSync(join(here, "examples")).filter((f) => /\.(json|md)$/.test(f) && f !== "index.json").map((f) => [f, boardFromText(readFileSync(join(here, "examples", f), "utf8"), f, () => {})]);
const shape = (d) => {
  const out = [];
  const w = (ns, parent) => { for (const n of ns) { out.push([n.id.replace(/^p\d+-/, ""), parent?.replace(/^p\d+-/, "") ?? "", n.kind ?? "note", n.title ?? "", n.code ?? ""]); if (n.kind === "group") w(n.children, n.id); } };
  for (let i = 0; i < pageCount(d); i++) w(pageView(d, i).nodes ?? [], null);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
};
for (const [f, d] of examples) {
  const laid = (i) => layout(pageView(d, i));
  const { canvas, left: l } = toCanvas(d, laid);
  const ids = new Set(canvas.nodes.map((n) => n.id));
  check(ids.size === canvas.nodes.length && canvas.nodes.every((n) => ["text", "link", "group"].includes(n.type) && [n.x, n.y, n.width, n.height].every(Number.isInteger)) && canvas.edges.every((e) => ids.has(e.fromNode) && ids.has(e.toNode)), `${f}: not valid JSON Canvas`);
  const steps = Array.from({ length: pageCount(d) }, (_, i) => pageView(d, i).steps?.length ?? 0).reduce((a, b) => a + b, 0);
  check((l.step ?? 0) === steps, `${f}: the tour's ${steps} steps are not counted as left out: ${JSON.stringify(l)}`);
  const back = fromCanvas(JSON.stringify(canvas)).doc;
  const paged = pageCount(d) > 1;
  // (a board with pages comes back with a group a page around its notes)
  const mine = shape(d), theirs = shape(back).filter((r) => !/^page-\d+$/.test(r[0])).map((r) => (paged && /^page-\d+$/.test(r[1]) ? [r[0], "", ...r.slice(2)] : r));
  check(JSON.stringify(mine) === JSON.stringify(theirs), `${f}: read back, not the same notes and groups:\n${JSON.stringify(mine).slice(0, 300)}\n${JSON.stringify(theirs).slice(0, 300)}`);
  const ek = (d2) => { const out = []; for (let i = 0; i < pageCount(d2); i++) for (const e of pageView(d2, i).edges ?? []) if (!e.hidden) out.push([e.from.replace(/^p\d+-/, ""), e.to.replace(/^p\d+-/, ""), e.label ?? "", e.arrow ?? ""].join()); return out.sort().join("|"); };
  check(ek(d) === ek(back), `${f}: read back, not the same edges`);
  if (paged) {
    const pages = canvas.nodes.filter((n) => /^page-\d+$/.test(n.id));
    check(pages.length === pageCount(d) && pages.every((p, i) => i === 0 || p.y >= pages[i - 1].y + pages[i - 1].height), `${f}: not a group a page, one below the other`);
  }
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
