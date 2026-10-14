// Three documents merged by records (cached.ts merge3): what one side
// changed is taken; what both changed, ours, and listed; records added or
// removed on one side are; an item whose page or group the other side
// removed goes to the first page or the top level; pictures merge by name.
//   bun web/board/test-merge.mjs
import { merge3 } from "./cached.ts";
import { canonical } from "./doc.ts";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const copy = (x) => JSON.parse(JSON.stringify(x));
const node = (d, id) => {
  const all = (ns) => ns.flatMap((n) => [n, ...(n.children ? all(n.children) : [])]);
  return all(d.pages ? d.pages.flatMap((p) => p.nodes ?? []) : d.nodes ?? []).find((n) => n.id === id);
};

const BASE = {
  title: "Base",
  images: { a: { w: 10, h: 10 } },
  nodes: [
    { id: "a", title: "A", text: "alpha", x: 0, y: 0 },
    { id: "b", title: "B", x: 300, y: 0 },
    { id: "c", title: "C", x: 600, y: 0 },
    { id: "g", kind: "group", title: "G", children: [{ id: "m", title: "M" }], x: 0, y: 400 },
  ],
  edges: [{ from: "a", to: "b" }],
};

// nothing changed: the same document
{
  const { doc, conflicts } = merge3(BASE, copy(BASE), copy(BASE));
  check(canonical(doc) === canonical(BASE) && !conflicts.length, "nothing changed: the same document");
}
// different items: both changes
{
  const o = copy(BASE), t = copy(BASE);
  o.nodes[0].title = "A ours";
  t.nodes[1].title = "B theirs";
  const { doc, conflicts } = merge3(BASE, o, t);
  check(node(doc, "a").title === "A ours" && node(doc, "b").title === "B theirs" && !conflicts.length, "changes to different items: both kept");
}
// the same item, different fields: both
{
  const o = copy(BASE), t = copy(BASE);
  o.nodes[0].x = 50;
  t.nodes[0].title = "A theirs";
  const { doc, conflicts } = merge3(BASE, o, t);
  check(node(doc, "a").x === 50 && node(doc, "a").title === "A theirs" && !conflicts.length, "the same item, different fields: both kept");
}
// the same field: ours, listed
{
  const o = copy(BASE), t = copy(BASE);
  o.nodes[0].text = "ours";
  t.nodes[0].text = "theirs";
  const { doc, conflicts } = merge3(BASE, o, t);
  check(node(doc, "a").text === "ours" && conflicts.length === 1 && conflicts[0].id === "a" && conflicts[0].field === "text", "the same field changed on both sides: ours, listed: " + JSON.stringify(conflicts));
}
// the same change on both sides: no conflict
{
  const o = copy(BASE), t = copy(BASE);
  o.nodes[2].title = t.nodes[2].title = "C both";
  const { doc, conflicts } = merge3(BASE, o, t);
  check(node(doc, "c").title === "C both" && !conflicts.length, "the same change on both sides: no conflict");
}
// added on one side, removed on the other
{
  const o = copy(BASE), t = copy(BASE);
  o.nodes.push({ id: "n", title: "New ours", x: 900, y: 0 });
  t.nodes = t.nodes.filter((n) => n.id !== "c");
  const { doc, conflicts } = merge3(BASE, o, t);
  check(node(doc, "n")?.title === "New ours" && !node(doc, "c") && !conflicts.length, "an item added here and another removed there: both");
}
// removed here, changed there: kept, changed, listed
{
  const o = copy(BASE), t = copy(BASE);
  o.nodes = o.nodes.filter((n) => n.id !== "b");
  o.edges = [];
  t.nodes[1].title = "B changed";
  const { doc, conflicts } = merge3(BASE, o, t);
  check(node(doc, "b")?.title === "B changed" && conflicts.some((c) => c.id === "b"), "removed here, changed there: kept as changed, listed");
}
// a group removed there, a member added to it here: at the top level
{
  const o = copy(BASE), t = copy(BASE);
  o.nodes[3].children.push({ id: "m2", title: "M2" });
  t.nodes = t.nodes.filter((n) => n.id !== "g");
  const { doc } = merge3(BASE, o, t);
  check(!node(doc, "g") && doc.nodes.some((n) => n.id === "m2"), "a group removed there, a member added to it here: the member at the top level: " + JSON.stringify(doc.nodes.map((n) => n.id)));
}
// pictures: by name
{
  const o = copy(BASE), t = copy(BASE);
  o.images.o = { w: 1, h: 2 };
  t.images.t = { w: 3, h: 4 };
  const { doc, conflicts } = merge3(BASE, o, t);
  check(doc.images?.a && doc.images?.o && doc.images?.t && !conflicts.length, "pictures added on both sides: all kept: " + JSON.stringify(doc.images));
}
// edges: added on both sides
{
  const o = copy(BASE), t = copy(BASE);
  o.edges.push({ from: "b", to: "c" });
  t.edges.push({ from: "a", to: "c" });
  const { doc } = merge3(BASE, o, t);
  check(doc.edges.length === 3, "edges added on both sides: all: " + JSON.stringify(doc.edges));
}
// pages: an item added here to a page removed there goes to the first page
{
  const P = { title: "Paged", pages: [{ id: "p1", title: "One", nodes: [{ id: "x", title: "X" }] }, { id: "p2", title: "Two", nodes: [{ id: "y", title: "Y" }] }] };
  const o = copy(P), t = copy(P);
  o.pages[1].nodes.push({ id: "z", title: "Z" });
  t.pages = t.pages.slice(0, 1);
  const { doc } = merge3(P, o, t);
  check(doc.pages.length === 1 && doc.pages[0].nodes.some((n) => n.id === "z"), "an item added to a page removed there: on the first page: " + JSON.stringify(doc.pages.map((p) => p.nodes.map((n) => n.id))));
}
// the result is a clean document
{
  const o = copy(BASE), t = copy(BASE);
  o.nodes[0].title = "x";
  t.title = "Theirs";
  const { doc } = merge3(BASE, o, t);
  check(doc.title === "Theirs" && canonical(doc).startsWith('{\n  "format": "sagebrush-board"'), "the result is a document in canonical form");
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
