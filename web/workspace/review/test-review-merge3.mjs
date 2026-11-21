// ci: web-runner order=197 runner=bun
// web/workspace/review/merge3.ts: a Delegate proposal merged into the person's version, three-way, every clash a
// conflict the person picks. Tables of cases for notebooks (by cell id) and text (diff3 by lines), and a seeded random
// check: with edits on disjoint cells (or disjoint lines) there is no conflict and every edit is in the result.
//   bun web/workspace/review/test-review-merge3.mjs
import { mergeNotebooks, resolveNotebook, mergeText, resolveText } from "./merge3.ts";

let checks = 0;
const fails = [];
const ok = (cond, what, got) => { checks++; if (!cond) fails.push(`${what}${got === undefined ? "" : `  ${JSON.stringify(got).slice(0, 400)}`}`); };
const J = JSON.stringify;
const nb = (...cells) => ({ mode: "python", cells: cells.map(([id, code, extra]) => ({ id, code, ...(extra ?? {}) })) });
const codes = (n) => n.cells.map((c) => `${c.id}:${c.code}`).join("|");

// ---- notebooks
{
  const base = nb(["a", "1"], ["b", "2"], ["c", "3"]);
  // one side changes
  let r = mergeNotebooks(base, base, nb(["a", "1"], ["b", "20"], ["c", "3"]));
  ok(r.conflicts.length === 0 && codes(r.merged) === "a:1|b:20|c:3", "theirs changed one cell: taken, no conflict", r);
  r = mergeNotebooks(base, nb(["a", "10"], ["b", "2"], ["c", "3"]), base);
  ok(r.conflicts.length === 0 && codes(r.merged) === "a:10|b:2|c:3", "mine changed one cell: kept", r);
  // different cells on each side
  r = mergeNotebooks(base, nb(["a", "10"], ["b", "2"], ["c", "3"]), nb(["a", "1"], ["b", "2"], ["c", "30"]));
  ok(r.conflicts.length === 0 && codes(r.merged) === "a:10|b:2|c:30", "each side changed its own cell: both kept", r);
  // the same change on both
  r = mergeNotebooks(base, nb(["a", "1"], ["b", "X"], ["c", "3"]), nb(["a", "1"], ["b", "X"], ["c", "3"]));
  ok(r.conflicts.length === 0 && codes(r.merged) === "a:1|b:X|c:3", "the same change on both: once, no conflict", r);
  // different changes to one cell
  r = mergeNotebooks(base, nb(["a", "1"], ["b", "M"], ["c", "3"]), nb(["a", "1"], ["b", "T"], ["c", "3"]));
  ok(r.conflicts.length === 1 && r.conflicts[0].id === "cell:b" && r.conflicts[0].mine.code === "M" && r.conflicts[0].theirs.code === "T", "both changed one cell differently: one conflict", r.conflicts);
  ok(codes(resolveNotebook(r, { "cell:b": "theirs" })) === "a:1|b:T|c:3" && codes(resolveNotebook(r, { "cell:b": "mine" })) === "a:1|b:M|c:3", "a cell conflict resolved either way");
  let threw = false;
  try { resolveNotebook(r, {}); } catch { threw = true; }
  ok(threw, "resolving with a conflict not picked is refused");
  // a type change counts as a change
  r = mergeNotebooks(base, nb(["a", "1"], ["b", "2", { type: "markdown" }], ["c", "3"]), nb(["a", "1"], ["b", "22"], ["c", "3"]));
  ok(r.conflicts.length === 1 && r.conflicts[0].cell === "b", "a type change on one side and a code change on the other: a conflict", r.conflicts);
  // outputs alone are not a change; outputs follow the side taken
  const ran = nb(["a", "1", { outputs: [{ text: "mine-out" }], n: "4" }], ["b", "2"], ["c", "3"]);
  r = mergeNotebooks(base, ran, nb(["a", "1"], ["b", "2", { outputs: [{ text: "their-out" }], n: "1" }], ["c", "30"]));
  ok(r.conflicts.length === 0 && J(r.merged.cells[0].outputs) === J([{ text: "mine-out" }]) && J(r.merged.cells[1].outputs) === J([{ text: "their-out" }]) && r.merged.cells[2].code === "30",
    "outputs alone are no change: each cell's outputs come from the side whose cell is taken", r.merged.cells);
  r = mergeNotebooks(base, nb(["a", "1", { outputs: [{ text: "m" }] }], ["b", "2"], ["c", "3"]), nb(["a", "1", { outputs: [{ text: "t" }] }], ["b", "2"], ["c", "3"]));
  ok(r.conflicts.length === 0 && J(r.merged.cells[0].outputs) === J([{ text: "m" }]), "unchanged on both and run on both: the person's outputs", r.merged.cells[0]);
  r = mergeNotebooks(base, nb(["a", "X", { outputs: [{ text: "m" }] }], ["b", "2"], ["c", "3"]), nb(["a", "X", { outputs: [{ text: "t" }] }], ["b", "2"], ["c", "3"]));
  ok(r.conflicts.length === 0 && J(r.merged.cells[0].outputs) === J([{ text: "m" }]), "changed alike on both: the person's outputs", r.merged.cells[0]);
  // removals
  r = mergeNotebooks(base, base, nb(["a", "1"], ["c", "3"]));
  ok(r.conflicts.length === 0 && codes(r.merged) === "a:1|c:3", "theirs removed an unchanged cell: removed", r);
  r = mergeNotebooks(base, nb(["a", "1"], ["c", "3"]), base);
  ok(r.conflicts.length === 0 && codes(r.merged) === "a:1|c:3", "mine removed a cell theirs didn't change: removed", r);
  r = mergeNotebooks(base, nb(["a", "1"], ["b", "2!"], ["c", "3"]), nb(["a", "1"], ["c", "3"]));
  ok(r.conflicts.length === 1 && r.conflicts[0].theirs === null && codes(resolveNotebook(r, { "cell:b": "theirs" })) === "a:1|c:3" && codes(resolveNotebook(r, { "cell:b": "mine" })) === "a:1|b:2!|c:3",
    "mine changed a cell theirs removed: a conflict, removed or kept as picked", r.conflicts);
  r = mergeNotebooks(base, nb(["a", "1"], ["c", "3"]), nb(["a", "1"], ["b", "2?"], ["c", "3"]));
  ok(r.conflicts.length === 1 && r.conflicts[0].mine === null && codes(r.merged) === "a:1|c:3" && codes(resolveNotebook(r, { "cell:b": "theirs" })) === "a:1|b:2?|c:3",
    "theirs changed a cell mine removed: a conflict; taken, it goes back at theirs' place", { merged: codes(r.merged), order: r.order });
  r = mergeNotebooks(base, nb(["a", "1"], ["c", "3"]), nb(["a", "1"], ["c", "3"]));
  ok(r.conflicts.length === 0 && codes(r.merged) === "a:1|c:3", "removed on both: removed", r);
  // additions
  r = mergeNotebooks(base, base, nb(["a", "1"], ["n", "new"], ["b", "2"], ["c", "3"]));
  ok(r.conflicts.length === 0 && codes(r.merged) === "a:1|n:new|b:2|c:3", "a cell theirs added: at its place, after the cell before it", r);
  r = mergeNotebooks(base, nb(["a", "1"], ["b", "2"], ["m", "mine"], ["c", "3"]), nb(["t", "first"], ["a", "1"], ["b", "2"], ["c", "3"], ["u", "last"]));
  ok(r.conflicts.length === 0 && codes(r.merged) === "t:first|a:1|b:2|m:mine|c:3|u:last", "additions on both sides: all kept, theirs' first cell first, its last last", codes(r.merged));
  r = mergeNotebooks(base, nb(["a", "1"], ["b", "2"], ["x", "M"], ["c", "3"]), nb(["a", "1"], ["b", "2"], ["x", "T"], ["c", "3"]));
  ok(r.conflicts.length === 1 && r.conflicts[0].cell === "x" && r.conflicts[0].mine.code === "M", "one id added on both, differently: a conflict", r.conflicts);
  // order: the person's
  r = mergeNotebooks(base, nb(["c", "3"], ["a", "1"], ["b", "2"]), nb(["b", "2"], ["a", "1"], ["c", "30"]));
  ok(r.conflicts.length === 0 && codes(r.merged) === "c:30|a:1|b:2", "the order is the person's; theirs' moves aren't applied", codes(r.merged));
  // fields
  r = mergeNotebooks({ ...base, mode: "python" }, { ...base, mode: "python" }, { ...base, mode: "sage" });
  ok(r.conflicts.length === 0 && r.merged.mode === "sage", "a field changed on one side: taken", r.merged.mode);
  r = mergeNotebooks({ ...base, mode: "python" }, { ...base, mode: "matlab" }, { ...base, mode: "sage" });
  ok(r.conflicts.length === 1 && r.conflicts[0].id === "field:mode" && resolveNotebook(r, { "field:mode": "theirs" }).mode === "sage", "a field changed differently on both: a conflict", r.conflicts);
  r = mergeNotebooks({ ...base, autorun: "always" }, { ...base, autorun: "always" }, { ...base });
  ok(r.conflicts.length === 0 && !("autorun" in r.merged), "a field theirs removed: removed", r.merged);
  // inputs untouched
  const m0 = nb(["a", "1"]), s0 = J(m0);
  mergeNotebooks(nb(["a", "0"]), m0, nb(["a", "2"]));
  ok(J(m0) === s0, "the inputs are not changed");
}

// ---- text
{
  const base = "one\ntwo\nthree\nfour\nfive\n";
  let r = mergeText(base, base, base.replace("two", "TWO"));
  ok(r.conflicts === 0 && resolveText(r, {}) === base.replace("two", "TWO"), "text: theirs alone", r);
  r = mergeText(base, base.replace("one", "ONE"), base.replace("five", "FIVE"));
  ok(r.conflicts === 0 && resolveText(r, {}) === "ONE\ntwo\nthree\nfour\nFIVE\n", "text: changes far apart on each side: both", resolveText(r, {}));
  r = mergeText(base, base.replace("three", "3m"), base.replace("three", "3t"));
  ok(r.conflicts === 1 && resolveText(r, { "text:0": "theirs" }) === base.replace("three", "3t") && resolveText(r, { "text:0": "mine" }) === base.replace("three", "3m"), "text: one line changed differently: a conflict, either way", r.parts);
  r = mergeText(base, base.replace("three", "SAME"), base.replace("three", "SAME"));
  ok(r.conflicts === 0 && resolveText(r, {}) === base.replace("three", "SAME"), "text: the same change on both: once");
  r = mergeText(base, base.replace("two\n", "two\nm-insert\n"), base.replace("four\n", "four\nt-insert\n"));
  ok(r.conflicts === 0 && resolveText(r, {}) === "one\ntwo\nm-insert\nthree\nfour\nt-insert\nfive\n", "text: inserts at different places: both", resolveText(r, {}));
  r = mergeText(base, base.replace("two\n", "two\nm\n"), base.replace("two\n", "two\nt\n"));
  ok(r.conflicts === 1, "text: inserts at one place, different: a conflict", r.parts);
  r = mergeText(base, base.replace("two\n", ""), base.replace("two\n", "TWO\n"));
  ok(r.conflicts === 1 && resolveText(r, { "text:0": "mine" }) === base.replace("two\n", ""), "text: removed on one side, changed on the other: a conflict", r.parts);
  r = mergeText("", "a\n", "b\n");
  ok(r.conflicts === 1, "text: both wrote an empty file differently: a conflict", r.parts);
  r = mergeText("x", "x", "y");
  ok(r.conflicts === 0 && resolveText(r, {}) === "y", "text: no final newline, one side", r);
}

// ---- seeded random: disjoint edits never conflict, and every edit lands
{
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let bad = 0, runs = 0;
  for (let k = 0; k < 300; k++) {
    const n = 3 + rnd(12);
    const base = { mode: "python", cells: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, code: `x${i} = ${i}` })) };
    const mine = J(base), theirs = J(base);
    const m = JSON.parse(mine), t = JSON.parse(theirs);
    // (each cell to at most one side: edited, or removed)
    const want = new Map(base.cells.map((c) => [c.id, c.code]));
    for (const c of base.cells) {
      const r = rnd(5);
      if (r === 0) { const x = m.cells.find((y) => y.id === c.id); x.code += " # m"; want.set(c.id, x.code); }
      else if (r === 1) { const x = t.cells.find((y) => y.id === c.id); x.code += " # t"; want.set(c.id, x.code); }
      else if (r === 2) { t.cells = t.cells.filter((y) => y.id !== c.id); want.delete(c.id); }
      else if (r === 3) { m.cells = m.cells.filter((y) => y.id !== c.id); want.delete(c.id); }
    }
    if (rnd(2)) { const at = rnd(t.cells.length + 1); t.cells.splice(at, 0, { id: `t${k}`, code: "added" }); want.set(`t${k}`, "added"); }
    const r = mergeNotebooks(base, m, t);
    runs++;
    const got = new Map(r.merged.cells.map((c) => [c.id, c.code]));
    if (r.conflicts.length || got.size !== want.size || [...want].some(([id, code]) => got.get(id) !== code)) bad++;
  }
  ok(bad === 0, `random notebooks (${runs}): disjoint edits never conflict, and every edit and removal lands`, { bad });
  let badT = 0;
  for (let k = 0; k < 200; k++) {
    const n = 6 + rnd(20);
    const lines = Array.from({ length: n }, (_, i) => `line ${i}\n`);
    const m = [...lines], t = [...lines];
    // (edits on lines at least two apart on the two sides: never overlapping or touching)
    for (let i = 0; i < n; i += 4) { if (rnd(2)) m[i] = `m ${i}\n`; if (i + 2 < n && rnd(2)) t[i + 2] = `t ${i + 2}\n`; }
    const want = lines.map((l, i) => (m[i] !== l ? m[i] : t[i])).join("");
    const r = mergeText(lines.join(""), m.join(""), t.join(""));
    if (r.conflicts || resolveText(r, {}) !== want) badT++;
  }
  ok(badT === 0, "random texts (200): edits two lines apart never conflict, and both land", { badT });
}

console.log(fails.length ? `FAIL: ${fails.length} of ${checks}\n  ${fails.join("\n  ")}` : `ok: merge3, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
