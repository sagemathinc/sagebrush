// The oracle of P2c's merges (test-p2c-merge.mjs): p2c-merge-vectors.json, made by this script.  P2c of the
// merge-alignment plan (plan-p2c r0, sync-docs, Oct 30 2026): for an exact-v1 notebook, the store's merge
// (history.js exactRecords3, db-merge3.ts's mergeDbStrings) and the editor's (history.js mergeText) must give what
// cocalc-ai's own code gives.  So the vectors are produced by running cocalc-ai's OWN built code (sync/editor/db/
// merge3.js mergeDbStrings, sync/editor/generic/string-merge3.js mergeText) on:
//   - records: cocalc-ai's editor/db/test/jupyter-core-merge.test.ts cases as three-way merges, both orders, plus the
//     same spot typed on both sides and a field changed on both;
//   - text: mergeText's three early returns, ties at one spot (the asymmetric cases a swap of its sides changes),
//     non-ASCII text, and seeded random edits of one cell's input.
// Each vector is {name, ...inputs, merged}; the file records the producers' versions.
//   node web/notebook/gen-p2c-merge-vectors.mjs <cocalc-ai src/packages/sync dir, built> <out.json>
// (made with cocalc-ai at 0b8b754708fdc8c393f4580eaeced4d0f9ebb4e5 and its patchflow 0.13.0; not run in CI: it needs a
// cocalc-ai checkout)
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const [syncDir, out] = process.argv.slice(2);
if (!syncDir || !out) { console.error("usage: node gen-p2c-merge-vectors.mjs <cocalc sync dir> <out.json>"); process.exit(2); }
const req = createRequire(join(syncDir, "package.json"));
const { mergeDbStrings } = req("./dist/editor/db/merge3.js");
const { mergeText } = req("./dist/editor/generic/string-merge3.js");
// (patchflow's exports don't include its package.json: its version read from the directory its main resolves into)
const pkgOf = (main) => { let d = dirname(main); for (let i = 0; i < 6; i++, d = dirname(d)) { try { const j = JSON.parse(readFileSync(join(d, "package.json"), "utf8")); if (j.name === "patchflow") return j; } catch {} } return {}; };
const cocalcCommit = execFileSync("git", ["-C", syncDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const OPTS = { primaryKeys: ["type", "id"], stringCols: ["input"] };
const lines = (rs) => rs.map((r) => JSON.stringify(r)).join("\n");
const parse = (s) => s.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

// ---- records (jupyter-core-merge.test.ts's cases, as base, a, b)
const records = [];
const rec = (name, base, a, b) => records.push({ name, base, a, b, merged: parse(mergeDbStrings({ ...OPTS, base: lines(base), a: lines(a), b: lines(b) })) });
const cells = [{ type: "cell", id: "a", pos: 0, input: "print(1)" }, { type: "cell", id: "b", pos: 1, input: "b" }];
for (const [deleteFirst, order] of [[true, "delete first"], [false, "edit first"]]) {
  const del = [cells[1]];
  const edited = [{ ...cells[0], pos: 0.5, input: "print(12345)" }, cells[1]];
  const out1 = [{ ...cells[0], output: { 0: { text: "1" } } }, cells[1]];
  rec(`keeps a cell whose input was edited while it was deleted (${order})`, cells, ...(deleteFirst ? [del, edited] : [edited, del]));
  rec(`deletes a cell whose output was written while it was deleted (${order})`, cells, ...(deleteFirst ? [del, out1] : [out1, del]));
}
{
  const initial = [{ type: "cell", id: "a", pos: 0, input: "x = 1\ny = 2\n" }];
  const left = [{ type: "cell", id: "a", pos: 0, input: "x = 10\ny = 2\n", cell_type: "code" }];
  const right = [{ type: "cell", id: "a", pos: 3, input: "x = 1\ny = 20\n" }];
  rec("merges concurrent edits of one cell's input and other fields", initial, left, right);
  rec("merges concurrent edits of one cell's input and other fields (sides swapped)", initial, right, left);
}
{
  const a = [{ type: "cell", id: "a", pos: 0, input: "x = 1 A\ny = 2\nz = 3\n" }];
  const b = [{ type: "cell", id: "a", pos: 0, input: "x = 1\ny = 2\nz = 3 B\n" }];
  rec("merges a cell both sides brought back without duplicating shared lines", [], a, b);
  rec("merges a cell both sides brought back without duplicating shared lines (sides swapped)", [], b, a);
}
{
  const base = [{ type: "settings", kernel: "python3" }, { type: "cell", id: "c", pos: 0, input: "x = 1\n", cell_type: "code" }];
  const here = [base[0], { ...base[1], input: "x = 1\nprint('here')\n" }];
  const there = [base[0], { ...base[1], input: "x = 1\nprint('there')\n" }];
  rec("the same spot typed on both sides: both kept", base, here, there);
  rec("the same spot typed on both sides: both kept (sides swapped)", base, there, here);
  const kA = [{ ...base[0], kernel: "sagemath" }, base[1]], kB = [{ ...base[0], kernel: "magma" }, base[1]];
  rec("a field changed on both sides: the later side (b)", base, kA, kB);
  rec("a field changed on both sides: the later side (b) (sides swapped)", base, kB, kA);
}

// ---- text (mergeText({base, local, remote}))
const text = [];
const txt = (name, base, local, remote) => text.push({ name, base, local, remote, merged: mergeText({ base, local, remote }) });
txt("early return: local equals remote", "x", "y", "y");
txt("early return: remote unchanged", "x", "y", "x");
txt("early return: local unchanged", "x", "x", "z");
txt("the same spot typed on both sides (asymmetric: the order of the two insertions)", "x = 1\n", "x = 1\nL\n", "x = 1\nR\n");
txt("the same spot typed on both sides, mid-line (asymmetric)", "print()", "print(1)", "print(2)");
txt("separate lines", "a\nb\nc\n", "a\nB\nc\n", "a\nb\nC\n");
txt("an insertion before an edit", "one\ntwo\n", "zero\none\ntwo\n", "one\nTWO\n");
txt("a deletion against an edit of the same line", "a\nb\nc\n", "a\nc\n", "a\nbb\nc\n");
txt("non-ASCII: accents and an emoji on both sides", "café = 1\n", "café = 1 # é\n", "🙂café = 1\n");
txt("non-ASCII: astral characters typed at one spot (asymmetric)", "x", "x😀", "x🚀");
txt("both sides empty a text", "abc", "", "");
txt("one side empties it, the other edits it", "abc\ndef\n", "", "abc\nDEF\n");
// (seeded random: mulberry32)
let seed = 0x9c2;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const WORDS = ["x = 1", "y = x + 2", "print(y)", "def f():", "    return 3", "# note", "for i in range(3):", "    pass", "", "ä = 'ü'", "z = 🙂"];
const edit = (s) => {
  const ls = s.split("\n"), i = Math.floor(rnd() * ls.length), k = Math.floor(rnd() * 4);
  if (k === 0) ls.splice(i, 0, pick(WORDS));
  else if (k === 1 && ls.length > 1) ls.splice(i, 1);
  else if (k === 2) ls[i] = ls[i] + pick([" + 1", "!", "_v", " # é"]);
  else ls[i] = pick(WORDS);
  return ls.join("\n");
};
for (let n = 0; n < 40; n++) {
  const base = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => pick(WORDS)).join("\n");
  txt(`random ${n}`, base, edit(base), edit(base));
}

const doc = {
  v: 1,
  producer: { cocalc_ai: cocalcCommit, cocalc_patchflow: pkgOf(req.resolve("patchflow")).version, node: process.version, by: "web/notebook/gen-p2c-merge-vectors.mjs" },
  records,
  text,
};
writeFileSync(out, JSON.stringify(doc, null, 1) + "\n");
console.log(`wrote ${out}: ${records.length} record vectors, ${text.length} text vectors (cocalc-ai ${cocalcCommit.slice(0, 10)})`);
