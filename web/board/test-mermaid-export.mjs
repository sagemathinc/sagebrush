// A board as Mermaid (mermaid.ts toMermaid): a flowchart read as a board,
// written back, and read again is the same board, for every flowchart in
// examples/mermaid.md and a set covering the syntax; the example boards'
// pages keep their graph (groups, notes' text, edges); titles, texts,
// labels and ids carrying markup or Mermaid syntax are written as entity
// codes (no tag, no quote, no new node or link) and read back as they were;
// what a flowchart cannot say is listed.
//   bun web/board/test-mermaid-export.mjs
import { readFileSync } from "node:fs";
import { cleanDoc, pageCount, pageView } from "./doc.ts";
import { boardFromText, fromMermaid, mermaidBlocks, toMermaid, toMermaidMarkdown } from "./mermaid.ts";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const here = new URL(".", import.meta.url).pathname;

// flowcharts: the example's, and the syntax the importer reads
const corpus = [
  ...mermaidBlocks(readFileSync(here + "examples/mermaid.md", "utf8")).map((b) => b.text),
  "graph TD\n  A --> B\n  B --> C\n  C --> A",
  "flowchart LR\n  a([Stadium]) --- b((Circle))\n  b ==> c{Diamond}\n  c -.-> d{{Hexagon}}\n  d <--> e[(Cylinder)]\n  e --x f[[Subroutine]]\n  f -.- g>Flag]",
  "flowchart TB\n  p[/Lean right/] --> q[\\Lean left\\]\n  q --> r[/Trapezoid\\]\n  r --> s[\\Inverted/]",
  "flowchart LR\n  A -- yes --> B\n  A -->|no| C\n  B == thick ==> D\n  C -. dotted .-> D\n  D ~~~ A",
  "flowchart TB\n  subgraph one[First]\n    direction LR\n    a1 --> a2\n    subgraph inner[Inner]\n      i1\n    end\n  end\n  subgraph two\n    b1\n  end\n  a2 --> b1\n  one --> two",
  'flowchart LR\n  A["**bold** and _it_ and `code`"] --> B["`**md** string\nsecond line $x^2$`"]\n  B --> C["a <b>tag</b> &amp; #quot;quote#quot;"]',
  "flowchart LR\n  A:::warm --> B\n  classDef warm fill:#ffd9b3\n  style B fill:#cfe8ff\n  click A href \"https://example.org/x?y=1\"",
  "---\ntitle: A titled chart\n---\nflowchart TD\n  x --> y",
  "flowchart LR\n  a & b --> c & d",
  "flowchart BT\n  n1@{ shape: cyl, label: \"Database\" } --> n2@{ shape: diam, label: \"Ok?\" }",
];
for (const [k, src] of corpus.entries()) {
  const d = fromMermaid(src), { text } = toMermaid(d);
  let again;
  try { again = fromMermaid(text); } catch (e) { again = String(e); }
  check(JSON.stringify(again) === JSON.stringify(d), `flowchart ${k}: read, written, read again: the same board:\n${text}\n${JSON.stringify(d)}\n${JSON.stringify(again)}`);
}

// the example boards: each page's graph kept (ids, groups and their members, notes' text, edges)
const graph = (d, rename = (x) => x) => {
  const nodes = [], walk = (ns, parent) => { for (const n of ns) {
    if (n.kind === "ink" || n.kind === "sticker") continue;
    nodes.push([rename(n.id), parent, n.kind === "group" ? "group" : "note"]);
    if (n.kind === "group") walk(n.children, rename(n.id));
  } };
  walk(d.nodes ?? [], "");
  const shown = new Set(nodes.map((n) => n[0]));
  const edges = (d.edges ?? []).map((e) => [rename(e.from), rename(e.to), e.label ?? "", e.arrow ?? "", e.line ?? "", !!e.hidden]).filter((e) => shown.has(e[0]) && shown.has(e[1]));
  return JSON.stringify([nodes.sort(), edges.sort()]);
};
for (const f of ["sagebrush", "live", "primes", "polynomials", "museum-tour"]) {
  const d = cleanDoc(JSON.parse(readFileSync(here + "examples/" + f + ".json", "utf8")));
  for (let i = 0; i < pageCount(d); i++) {
    const v = pageView(d, i), { text } = toMermaid(d, i);
    // (ids that are not plain words were renamed: map them back by the order written)
    const back = fromMermaid(text);
    const order = [], seen = (ns) => { for (const n of ns) { if (n.kind === "ink" || n.kind === "sticker") continue; order.push(n.id); if (n.kind === "group") seen(n.children); } };
    seen(v.nodes ?? []);
    const orderBack = [];
    const seenBack = (ns) => { for (const n of ns) { orderBack.push(n.id); if (n.kind === "group") seenBack(n.children); } };
    seenBack(back.nodes ?? []);
    const toOrig = new Map(orderBack.map((id, j) => [id, order[j]]));
    check(graph(back, (x) => toOrig.get(x) ?? x) === graph(v), `${f} page ${i}: its graph kept: ` + text.slice(0, 300));
  }
}

// untrusted titles, texts, labels and ids
{
  const payloads = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"]; click A call alert(1); A["', "`**x**` #quot;q#quot; &amp; #35;", "a | b \\ c", "end", "</div><svg onload=alert(1)>"];
  for (const [k, p] of payloads.entries()) {
    const doc = cleanDoc({
      title: p, layout: "graph",
      nodes: [
        { id: "g", kind: "group", title: p, children: [{ id: "t", title: p }, { id: "x", text: p }] },
        { id: p, text: "odd id" },
        { id: "y", text: "plain" },
      ],
      edges: [{ from: "t", to: "y", label: p }, { from: p, to: "y" }],
    });
    const { text } = toMermaid(doc);
    check(!/<[a-z!\/?]/i.test(text), `payload ${k}: no tag in what is written: ` + text);
    check(!text.split("\n").some((l) => /^\s*click\b/.test(l)), `payload ${k}: no link made: ` + text);
    let d;
    try { d = fromMermaid(text); } catch (e) { fails.push(`payload ${k}: not read back: ${e}\n${text}`); continue; }
    const g = d.nodes.find((n) => n.id === "g"), t = g?.children.find((n) => n.id === "t"), x = g?.children.find((n) => n.id === "x");
    const mdEscaped = p.replace(/([\\*_[\]~])/g, "\\$1");
    check(d.title === p && g?.title === p && x?.text === p && t?.text === mdEscaped, `payload ${k}: the board's title, a group's, a note's text and title read back as they were: ` + JSON.stringify({ title: d.title, group: g?.title, text: x?.text, noteTitle: t?.text }));
    check(d.nodes.length === 3 && g?.children.length === 2 && d.edges.length === 2 && d.edges[0].label === p.replace(/\s+/g, " ").trim(), `payload ${k}: no node or edge more, the edge's label as it was: ` + JSON.stringify({ nodes: d.nodes.map((n) => n.id), edges: d.edges }));
  }
}

// what a flowchart cannot say, said; every page as Markdown, read back as pages
{
  const d = cleanDoc({ pages: [
    { title: "One", nodes: [{ id: "a", text: "A", x: 10, y: 20 }, { id: "s", kind: "ink", x: 0, y: 0, points: [0, 0, 0.5, 5, 5, 0.5] }, { id: "c", code: "1+1" }], steps: [{ focus: "a" }] },
    { title: "Two", layout: "graph", nodes: [{ id: "b", text: "B" }, { id: "st", kind: "sticker", emoji: "🙂" }] },
  ] });
  const one = toMermaid(d, 0).left.sort().join(), all = toMermaidMarkdown(d);
  check(one === "code,other pages,pen strokes,places,tours", "what a flowchart cannot say, listed: " + one);
  check(all.left.sort().join() === "code,pen strokes,places,stickers,tours", "...for every page: " + all.left.join());
  const back = boardFromText(all.text);
  check(back.pages?.length === 2 && back.pages[0].title === "One" && back.pages[1].nodes[0].text === "B", "every page as Markdown, read back as pages: " + JSON.stringify(back.pages?.map((p) => [p.title, p.nodes.map((n) => n.id)])));
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f.slice(0, 1500));
process.exit(fails.length ? 1 : 0);
