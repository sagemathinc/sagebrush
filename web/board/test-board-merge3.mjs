// boardMerge3 (web/board/merge.ts; plan-board-open-edit r7 §3), on records as
// history.ts makes them: fixed cases (astra's probes among them) and seeded
// random boards and edits: symmetry, determinism, merge3(x, x, y) == y, and no
// edit lost (each change present in the result, or reported with its
// alternative); the work ledger at its exact bound and one unit less.
//   bun web/board/test-board-merge3.mjs
import { boardMerge3, keyOf, canon, ABSENT } from "./merge.ts";
import { toRecords } from "./history.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const BIG = 1e12;
const m3 = (base, a, b, work = BIG) => boardMerge3(base, a, b, { work });
const recs = (d) => toRecords({ format: "sagebrush-board", version: 1, ...d });
const byKey = (rs) => new Map(rs.map((r) => [keyOf(r), r]));
const item = (rs, id, page = "") => byKey(rs).get(keyOf({ type: "item", page, id }));
const edit = (rs, id, f, page = "") => rs.map((r) => (r.type === "item" && r.id === id && r.page === page ? f({ ...r }) : r));
const drop = (rs, pred) => rs.filter((r) => !pred(r));

const board = recs({
  title: "t",
  nodes: [
    { id: "a", kind: "group", title: "A", children: [{ id: "a1", text: "one" }] },
    { id: "b", kind: "group", title: "B", children: [] },
    { id: "n", text: "hello world", x: 0, y: 0, custom: "keep" },
  ],
  edges: [{ from: "a1", to: "n" }],
});

// ---- fixed cases
{
  // astra's probe: crossed reparenting (A under B on one side, B under A on the other): no record lost
  const x = edit(board, "a", (r) => ({ ...r, parent: "b" })), y = edit(board, "b", (r) => ({ ...r, parent: "a" }));
  const r = m3(board, x, y);
  check(!r.refused, "crossed reparenting: merged, not refused");
  check(r.records && ["a", "b", "a1", "n"].every((id) => item(r.records, id)), "crossed reparenting: every item kept");
  check(r.reports?.some((p) => p.kind === "cycle"), "crossed reparenting: the cycle reported");
  check(canon(m3(board, y, x).records) === canon(r.records), "crossed reparenting: symmetric");
}
{
  // astra's probe: extension fields survive a merge on both sides
  const x = edit(board, "n", (r) => ({ ...r, x: 5 })), y = edit(board, "n", (r) => ({ ...r, text: "hello brave world" }));
  const r = m3(board, x, y);
  const n = item(r.records, "n");
  check(n.custom === "keep" && n.x === 5 && n.text === "hello brave world", "independent fields: both kept, the extension field too");
}
{
  // text changed on both sides, on different lines: merged by lines (lineMerge3), with no report
  const base3 = edit(board, "n", (r) => ({ ...r, text: "one\ntwo\nthree\n" }));
  const x = edit(base3, "n", (r) => ({ ...r, text: "ONE\ntwo\nthree\n" })), y = edit(base3, "n", (r) => ({ ...r, text: "one\ntwo\nTHREE\n" }));
  const r = m3(base3, x, y);
  check(item(r.records, "n").text === "ONE\ntwo\nTHREE\n" && !r.reports.some((q) => q.kind === "text-overlap"), "text on both sides, different lines: merged by lines");
}
{
  // text changed on both sides, on the same line: a text-overlap conflict, both whole texts kept, never a hybrid
  const x = edit(board, "n", (r) => ({ ...r, text: "hello brave world" })), y = edit(board, "n", (r) => ({ ...r, text: "hello world!" }));
  const r = m3(board, x, y), s = m3(board, y, x);
  const rep = r.reports.find((q) => q.kind === "text-overlap"), alt = r.alternatives.find((q) => q.field === "text");
  check(item(r.records, "n").text === "hello brave world" && rep?.kept === "hello brave world" && rep?.other === "hello world!" && alt?.value === "hello world!",
    `the same line on both sides: one whole text kept, the other its alternative (${JSON.stringify([item(r.records, "n").text, rep, alt])})`);
  check(canon(r) === canon(s), "...and symmetric");
  // (patchflow's mergeStrings3 would have made the hybrid "hello brave world!")
}
{
  // the ledger runs out inside the text merge itself: refused, never a cheaper result (no conflict, no partial text)
  // (a edits the first and the last line, so its diff spans every line: the line diff is most of the merge's work)
  const lines = (n, edit) => Array.from({ length: n }, (_, i) => `line ${i}${edit(i) ? " edited" : ""}\n`).join("");
  const base3 = edit(board, "n", (r) => ({ ...r, text: lines(120, () => false) }));
  const x = edit(base3, "n", (r) => ({ ...r, text: lines(120, (i) => i === 0 || i === 119) }));
  const y = edit(base3, "n", (r) => ({ ...r, text: lines(120, (i) => i === 60) }));
  check(item(m3(base3, x, y).records, "n").text === lines(120, (i) => i === 0 || i === 60 || i === 119), "disjoint edits across a long text: merged");
  const used = m3(base3, x, y).used;
  const short = [1, 2, 10, 100, Math.floor(used / 2)].map((k) => m3(base3, x, y, used - k));
  check(short.every((r) => r.refused === "work"), `every budget below ${used} units refused as work: ${JSON.stringify(short.map((r) => r.refused ?? "merged"))}`);
}
{
  // (astra, #197) a merged text that is the word "exhausted" is merged, not taken for exhaustion, in both orders
  const base3 = edit(board, "n", (r) => ({ ...r, text: "x\nexhausteD" }));
  const x = edit(base3, "n", (r) => ({ ...r, text: "exhausteD" })), y = edit(base3, "n", (r) => ({ ...r, text: "x\nexhausted" }));
  const r1 = m3(base3, x, y), r2 = m3(base3, y, x);
  check(!r1.refused && !r2.refused && item(r1.records, "n").text === "exhausted" && item(r2.records, "n").text === "exhausted", `a merged text "exhausted": merged, both orders (${JSON.stringify([r1.refused, r2.refused])})`);
}
{
  // (daybreak2, #197) a line diff past TEXT_DIFF_PRODUCT_LIMIT end to end: refused as work, never a conflict or a result
  const n = 2000;
  const base3 = edit(board, "n", (r) => ({ ...r, text: Array.from({ length: n }, (_, i) => `b${i}\n`).join("") }));
  const x = edit(base3, "n", (r) => ({ ...r, text: Array.from({ length: n + 1 }, (_, i) => `a${i}\n`).join("") }));
  const y = edit(base3, "n", (r) => ({ ...r, text: item(base3, "n").text.replace("b5\n", "B5\n") }));
  const r = m3(base3, x, y, 1e12);
  check(r.refused === "work" && !("records" in r), `a diff past the limit: refused as work (${JSON.stringify(r.refused ?? "merged")})`);
}
{
  // two different insertions at the same place: an overlap, both kept
  const base3 = edit(board, "n", (r) => ({ ...r, text: "a\nb\n" }));
  const x = edit(base3, "n", (r) => ({ ...r, text: "a\nX\nb\n" })), y = edit(base3, "n", (r) => ({ ...r, text: "a\nY\nb\n" }));
  const r = m3(base3, x, y);
  check(r.reports.some((q) => q.kind === "text-overlap" && q.field === "text") && [item(r.records, "n").text, r.alternatives.find((q) => q.field === "text")?.value].sort().join("|") === "a\nX\nb\n|a\nY\nb\n",
    "two insertions at the same gap: a text-overlap, both whole texts kept");
}
{
  // a scalar on both sides: a conflict, symmetric, the other value its alternative
  const x = edit(board, "n", (r) => ({ ...r, x: 2 })), y = edit(board, "n", (r) => ({ ...r, x: 1 }));
  const r1 = m3(board, x, y), r2 = m3(board, y, x);
  check(item(r1.records, "n").x === 1 && item(r2.records, "n").x === 1, "a scalar conflict: the first by canonical JSON kept, either way round");
  check(r1.reports.some((p) => p.kind === "conflict" && p.field === "x" && p.other === 2), "a scalar conflict: reported, with the other value");
  check(r1.alternatives.some((p) => p.field === "x" && p.value === 2), "a scalar conflict: the other value its alternative");
  check(canon(r1) === canon(r2), "a scalar conflict: reports and alternatives symmetric too");
}
{
  // absent is not null: removed on one side, set to null on the other
  const x = edit(board, "n", (r) => { delete r.custom; return r; }), y = edit(board, "n", (r) => ({ ...r, custom: null }));
  const r = m3(board, x, y);
  check(!("custom" in item(r.records, "n")), "absent < null: the removal kept");
  check(r.alternatives.some((p) => p.field === "custom" && p.value === null), "absent vs null: null the alternative");
  const z = edit(board, "n", (r) => ({ ...r, custom: null }));
  check(item(m3(board, z, board).records, "n").custom === null, "null set on one side: null, not removed");
}
{
  // deleted on one side, edited on the other: kept as edited, the deletion its alternative
  const x = drop(board, (r) => r.type === "item" && r.id === "n").filter((r) => !(r.type === "edge")), y = edit(board, "n", (r) => ({ ...r, text: "edited" }));
  const r = m3(board, x, y);
  check(item(r.records, "n")?.text === "edited", "deleted vs edited: kept as edited");
  check(r.reports.some((p) => p.kind === "kept-after-delete") && r.alternatives.some((p) => p.record === null), "deleted vs edited: reported, the deletion its alternative");
  // deleted on one side, unchanged on the other: deleted
  check(!item(m3(board, x, board).records, "n"), "deleted vs unchanged: deleted");
}
{
  // a group deleted on one side, a child of it edited on the other: the child to the top of its page
  const x = drop(board, (r) => r.type === "item" && (r.id === "a" || r.id === "a1")).filter((r) => r.type !== "edge");
  const y = edit(board, "a1", (r) => ({ ...r, text: "edited" }));
  const r = m3(board, x, y);
  const a1 = item(r.records, "a1");
  check(a1?.text === "edited" && a1.parent === "", "a child edited under a deleted group: kept, at the top");
  check(r.reports.some((p) => p.kind === "orphan"), "...and reported");
}
{
  // an edge whose end was deleted (the end unchanged on the other side): removed, reported, the end restorable
  const x = drop(board, (r) => r.type === "item" && r.id === "n").filter((r) => r.type !== "edge");
  const y = board.map((r) => (r.type === "edge" ? { ...r, label: "rel" } : r));
  const r = m3(board, x, y);
  check(!r.records.some((e) => e.type === "edge"), "an edge with a missing end: removed");
  check(r.reports.some((p) => p.kind === "edge-removed") && r.alternatives.some((p) => p.records?.some((x) => x.record.id === "n")), "...reported, its end restorable");
}
// astra2's CORR-PR121-3: a removed edge that was edited comes back, with every edit and the ends it needs
for (const gone of [["a"], ["a", "b"]]) {
  const base = recs({ nodes: [{ id: "a" }, { id: "b" }, { id: "c" }], edges: [{ from: "a", to: "b", label: "old" }] });
  const x = drop(base, (r) => (r.type === "item" && gone.includes(r.id)) || r.type === "edge");
  const y = base.map((r) => (r.type === "edge" ? { ...r, label: "new" } : r));
  for (const [s1, s2] of [[x, y], [y, x]]) {
    const r = m3(base, s1, s2);
    check(!r.refused && !r.records.some((e) => e.type === "edge"), `edited dangling edge (${gone}): removed from the merge`);
    const rep = r.reports.find((p) => p.kind === "edge-removed");
    check(rep && rep.missing.length === gone.length, `edited dangling edge (${gone}): reported with every missing end`);
    const alt = r.alternatives.find((p) => p.key === rep?.key && p.records);
    check(!!alt, `edited dangling edge (${gone}): an alternative restoring it`);
    // (applying the alternative: the edge as merged, its edit kept, and its ends; then the board conserves)
    const after = byKey(r.records);
    for (const x of alt?.records ?? []) after.set(x.key, x.record);
    const rs = [...after.values()];
    const e = rs.find((q) => q.type === "edge");
    check(e?.label === "new", `edited dangling edge (${gone}): restored with its edit`);
    check(gone.every((id) => item(rs, id)), `edited dangling edge (${gone}): its ends restored`);
    const again = m3(rs, rs, rs);
    check(!again.refused && again.records.some((q) => q.type === "edge" && q.label === "new"), `edited dangling edge (${gone}): the restored board is whole`);
  }
}
// astra2's CORR-PR121-1: a field named "__proto__" (or any inherited name) merged field by field stays a field
for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
  const base = toRecords(JSON.parse(`{"format":"sagebrush-board","version":1,"nodes":[{"id":"n","text":"old","x":0,${JSON.stringify(name)}:{"keep":true}}],"edges":[]}`));
  const a = base.map((r) => (r.type === "item" ? { ...r, x: 1 } : r)), b = base.map((r) => (r.type === "item" ? { ...r, text: "new" } : r));
  const r = m3(base, a, b);
  const n = item(r.records, "n");
  check(n && Object.hasOwn(n, name) && JSON.stringify(n[name]) === '{"keep":true}' && n.x === 1 && n.text === "new", `a field named ${name}: kept through a field-by-field merge`);
  check(r.reports.length === 0, `a field named ${name}: no report invented`);
}
{
  // two edges added between the same ends: both kept
  const base = recs({ nodes: [{ id: "p" }, { id: "q" }], edges: [] });
  const x = [...base, { type: "edge", page: "", from: "p", to: "q", label: "x", id: JSON.stringify(["p", "q", 1]), pos: 0 }];
  const y = [...base, { type: "edge", page: "", from: "p", to: "q", label: "y", id: JSON.stringify(["p", "q", 1]), pos: 0 }];
  const r = m3(base, x, y);
  check(r.records.filter((e) => e.type === "edge").length === 2, "two edges added between the same ends: both kept");
  check(canon(m3(base, y, x).records) === canon(r.records), "...symmetrically");
}
{
  // paged on one side, any change on the other: refused
  const paged = board.map((r) => (r.type === "doc" ? { ...r, paged: true } : r));
  const y = edit(board, "n", (r) => ({ ...r, x: 9 }));
  check(m3(board, paged, y).refused === "paged", "a paged change against another change: refused");
  check(!m3(board, paged, board).refused, "...but alone, merged");
}
{
  // the work ledger: exactly enough succeeds, one unit less refuses
  const x = edit(board, "n", (r) => ({ ...r, text: "hello brave world" })), y = edit(board, "n", (r) => ({ ...r, text: "hello world!" }));
  const used = m3(board, x, y).used;
  check(!m3(board, x, y, used).refused, `the ledger: ${used} units, exactly enough`);
  check(m3(board, x, y, used - 1).refused === "work", "the ledger: one unit less refused");
}

// ---- seeded random boards and edits
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const words = ["alpha", "beta", "gamma", "delta", "x😀y", "a\nb", ""];
const randomBoard = () => {
  const n = 2 + Math.floor(rnd() * 6), nodes = [];
  for (let i = 0; i < n; i++) nodes.push({ id: "n" + i, text: pick(words), x: Math.floor(rnd() * 5) });
  const edges = [];
  for (let i = 0; i < 2; i++) edges.push({ from: pick(nodes).id, to: pick(nodes).id });
  return recs({ title: pick(words), nodes, edges });
};
const mutate = (rs) => {
  let out = rs.map((r) => ({ ...r }));
  const k = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < k; i++) {
    const items = out.filter((r) => r.type === "item"), op = rnd();
    if (op < 0.4 && items.length) { const r = pick(items); r.text = (r.text ?? "") + pick(words); }
    else if (op < 0.6 && items.length) { const r = pick(items); r.x = Math.floor(rnd() * 9); }
    else if (op < 0.7 && items.length) { const r = pick(items); delete r.x; }
    else if (op < 0.8 && items.length > 1) { const r = pick(items); out = out.filter((q) => q !== r && !(q.type === "edge" && (q.from === r.id || q.to === r.id))); }
    else {
      // (a new item, with an id this side doesn't have yet: a board's keys are unique)
      const id = "new" + Math.floor(rnd() * 3);
      if (!out.some((q) => q.type === "item" && q.id === id)) out.push({ type: "item", page: "", id, text: pick(words), parent: "", pos: 50 });
    }
  }
  return out;
};
let rounds = 0;
for (let t = 0; t < 400; t++) {
  const base = randomBoard(), a = mutate(base), b = mutate(base);
  const r1 = m3(base, a, b), r2 = m3(base, b, a);
  rounds++;
  check(canon(r1) === canon(r2), `random ${t}: symmetric`);
  check(canon(m3(base, a, b)) === canon(r1), `random ${t}: deterministic`);
  check(canon(m3(base, a, a).records) === canon(m3(base, base, a).records), `random ${t}: merge3(x, x, y) == merge3(x, y, y)`);
  const same = m3(a, a, b);
  // (merge3(x, x, y): y, up to the graph's repair; reports name every place it differs)
  if (!same.refused && !same.reports.length) check(canon(same.records) === canon([...b].sort((p, q) => (keyOf(p) < keyOf(q) ? -1 : 1))), `random ${t}: merge3(x, x, y) == y`);
  if (r1.refused) continue;
  // no edit lost: every record a or b changed (and the other didn't delete unreported) is in the result, or reported
  const res = byKey(r1.records), B = byKey(base), reported = new Set([...r1.reports.map((p) => p.key), ...r1.reports.flatMap((p) => p.missing ?? [])]);
  for (const side of [a, b]) for (const r of side) {
    const k = keyOf(r), r0 = B.get(k);
    if (r0 && canon(r0) === canon(r)) continue;
    check(res.has(k) || reported.has(k), `random ${t}: ${k} changed on one side, present or reported`);
  }
}

// a big board with as many edges as items, and pages: repair indexes each page's items once (it rebuilt the
// index for every edge, and scanned every record for every page, which took minutes at this size)
{
  const n = 50_000, pagesN = 200, per = n / pagesN;
  const d = { format: "sagebrush-board", version: 1, title: "big", pages: Array.from({ length: pagesN }, (_, p) => ({ id: "p" + p, nodes: Array.from({ length: per }, (_, i) => ({ id: `n${p}-${i}`, text: "x" })), edges: Array.from({ length: per }, (_, i) => ({ from: `n${p}-${i}`, to: `n${p}-${(i + 1) % per}` })) })) };
  const base = toRecords(d);
  const a = base.map((r) => (r.type === "item" && r.id === "n0-1" ? { ...r, text: "a" } : r));
  const b = base.map((r) => (r.type === "item" && r.id === "n7-2" ? { ...r, text: "b" } : r));
  const t0 = performance.now();
  const r = m3(base, a, b);
  const ms = performance.now() - t0;
  check(!("refused" in r) && r.records.length === base.length, "big board: merged");
  check(ms < 10_000, `big board (${base.length} records): merged in ${Math.round(ms)} ms, under 10 s`);
}

console.log(`${checks - fails.length}/${checks} checks passed (${rounds} random merges)`);
if (fails.length) { console.log(fails.slice(0, 20).join("\n")); process.exit(1); }
