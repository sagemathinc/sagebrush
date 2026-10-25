// A board's file, edited without losing anything (web/board/lossless.ts; plan-board-open-edit r7 §3.1, §3.4):
// the repository's example boards and astra's probes come back as they were through the records an edit merges
// (tools, extension fields, an edge's own id, pages without edges); stable page ids, unique even against an id
// that collides; the bytes written are exactly the board; and a board that can't come back is said so.
//   bun web/board/test-lossless.mjs
import { readFileSync, readdirSync } from "node:fs";
import { mergeStrings3 } from "patchflow";
import { editRecords, fromEditRecords, roundTrips, givePageIds, serialize, bytesAre, firstDifference } from "./lossless.ts";
import { boardMerge3, keyOf } from "./merge.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const B = (d) => ({ format: "sagebrush-board", version: 1, ...d });

// ---- astra2's CORR-PR121-2: extension keys with inherited names, at the top, in a node, an edge and a page
for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
  const k = JSON.stringify(name);
  for (const [where, json] of [
    ["the board", `{"format":"sagebrush-board","version":1,${k}:{"keep":true},"nodes":[{"id":"a"}],"edges":[]}`],
    ["a node", `{"format":"sagebrush-board","version":1,"nodes":[{"id":"a",${k}:{"keep":true}}],"edges":[]}`],
    ["an edge", `{"format":"sagebrush-board","version":1,"nodes":[{"id":"a"},{"id":"b"}],"edges":[{"from":"a","to":"b",${k}:{"keep":true}}]}`],
    ["a page", `{"format":"sagebrush-board","version":1,"pages":[{"id":"p",${k}:{"keep":true},"nodes":[{"id":"a"}]}]}`],
  ]) {
    const d = JSON.parse(json);
    const r = roundTrips(d);
    check(r.ok, `${name} in ${where}: comes back${r.ok ? "" : " (differs at " + r.at + ")"}`);
    const bytes = serialize(fromEditRecords(editRecords(d)));
    check(bytesAre(bytes, d).ok, `${name} in ${where}: the bytes written keep it`);
  }
}
// (CORR-PR121-1, end to end: raw JSON, edit records, a field-by-field merge, the board, its bytes)
for (const name of ["__proto__", "constructor", "toString"]) {
  const d = JSON.parse(`{"format":"sagebrush-board","version":1,"nodes":[{"id":"n","text":"old","x":0,${JSON.stringify(name)}:{"keep":true}}],"edges":[]}`);
  const base = editRecords(d);
  const a = base.map((r) => (r.type === "item" ? { ...r, x: 1 } : r)), b = base.map((r) => (r.type === "item" ? { ...r, text: "new" } : r));
  const r = boardMerge3(base, a, b, { mergeStrings3, work: 1e9 });
  const back = JSON.parse(serialize(fromEditRecords(r.records)));
  const n = back.nodes[0];
  check(Object.hasOwn(n, name) && JSON.stringify(n[name]) === '{"keep":true}' && n.x === 1 && n.text === "new" && r.reports.length === 0, `${name} in a node: kept through a merge and the bytes written`);
}
// (admission runs the real write: a value the file can't hold, here a number past double range, is refused)
{
  const d = JSON.parse('{"format":"sagebrush-board","version":1,"nodes":[{"id":"a","x":1e400}],"edges":[]}');
  const r = roundTrips(d);
  check(!r.ok, `a value the written file can't hold: not editable${r.ok ? "" : " (at " + r.at + ")"}`);
}

// ---- the example boards
const dir = new URL("./examples/", import.meta.url).pathname;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".board.json")).sort()) {
  const d = JSON.parse(readFileSync(dir + f, "utf8"));
  const r = roundTrips(d);
  check(r.ok, `${f}: comes back as it was${r.ok ? "" : " (differs at " + r.at + ")"}`);
  const bytes = serialize(fromEditRecords(editRecords(d)));
  check(bytesAre(bytes, d).ok, `${f}: the bytes written are the board`);
}

// ---- astra's probes and the fields the history's records leave out
{
  const d = B({ title: "t", custom: "keep", tools: ["note"], nodes: [{ id: "a", text: "x", custom: "keep" }], edges: [] });
  check(roundTrips(d).ok, "tools and extension fields come back");
  check(bytesAre(serialize(fromEditRecords(editRecords(d))), d).ok, "...in the bytes written too");
}
check(roundTrips(B({ nodes: [{ id: "a" }], edges: [{ from: "a", to: "a", id: "own", label: "l" }] })).ok, "an edge's own id comes back");
check(roundTrips(B({ nodes: [{ id: "a" }] })).ok, "a board without edges gets none added");
check(roundTrips(B({ pages: [{ title: "one", nodes: [{ id: "x" }] }, { id: "two" }] })).ok, "pages without nodes or edges, or an id, come back");
check(roundTrips(B({ nodes: [{ id: "g", kind: "group", children: [{ id: "c", text: "in" }] }] })).ok, "a group and its children come back");

// ---- what can't come back is said so
{
  const r = roundTrips(B({ nodes: [{ id: "a" }], edges: [{ from: "a", to: "a", id: "x", $eid: "y" }] }));
  check(!r.ok, "an edge with both `id` and `$eid` can't come back, and is said so");
  check(!roundTrips({ format: "something-else", version: 1 }).ok, "another format: not editable");
  check(!roundTrips(B({ version: 2 })).ok, "a later version: not editable");
}

// ---- stable page ids
{
  const d = B({ pages: [{ title: "one" }, { id: "two" }, { title: "three" }] });
  const g1 = await givePageIds(d, "rev"), g2 = await givePageIds(d, "rev");
  check(g1.given.length === 2 && g1.given.every((x) => /^p-[0-9a-f]{8}$/.test(x.id)), "pages without an id get p- and 8 hex digits");
  check(JSON.stringify(g1) === JSON.stringify(g2), "...the same ids every time for the same file");
  check(roundTrips(g1.doc).ok && roundTrips(d, g1.given).ok, "...an allowed transformation, and only where a page had none");
  check(g1.doc.pages[1].id === "two", "...a page's own id kept");
  // (an id already in the board, say an item's: never given to a page)
  const clash = B({ pages: [{ title: "one", nodes: [{ id: g1.given[0].id }] }, { id: "two" }, { title: "three" }] });
  const g3 = await givePageIds(clash, "rev");
  check(g3.given[0].id !== g1.given[0].id && new Set(g3.given.map((x) => x.id)).size === 2, "an id taken in the board is never given");
  check(!roundTrips(d, [{ pos: 1, id: "other" }]).ok, "an id given where a page had one is not an allowed transformation");
}

// ---- a merge's result, through the file
{
  const base = B({ nodes: [{ id: "n", text: "hello world", custom: 1 }], tools: ["note"], edges: [{ from: "n", to: "n", id: "loop" }] });
  const a = { ...base, nodes: [{ id: "n", text: "hello brave world", custom: 1 }] };
  const b = { ...base, nodes: [{ id: "n", text: "hello world!", custom: 1 }] };
  const r = boardMerge3(editRecords(base), editRecords(a), editRecords(b), { mergeStrings3, work: 1e12 });
  const merged = fromEditRecords(r.records);
  check(merged.nodes[0].text === "hello brave world!" && merged.tools[0] === "note" && merged.edges[0].id === "loop", "a merge keeps the carried fields");
  check(bytesAre(serialize(merged), merged).ok, "...and its bytes are the merged board");
  check(firstDifference(merged, { ...merged, extra: 1 }, "") === "/extra", "a difference is found where it is");
}

console.log(`${checks - fails.length}/${checks} checks passed`);
if (fails.length) { console.log(fails.join("\n")); process.exit(1); }
