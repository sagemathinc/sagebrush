// The oracle of db-merge3.ts (test-db-merge3.mjs): db-merge3-vectors.json, made by this script.  P1 of the
// merge-alignment plan (sync-docs, Oct 30 2026): parity vectors for notebooks' three-way merge, produced by
// running cocalc-ai's OWN merge (sync/editor/db/merge3.js mergeDbStrings, its built dist) on seeded random notebook
// edits.  The vectors are data: {base, a, b, merged} as record lists, with the producer's versions.  Also: the same text
// cases through patchflow's mergeStrings3 from cocalc-ai's patchflow and from Sagebrush's, to see whether the two
// versions agree (an exact port would otherwise still differ on text).
//   node web/notebook/gen-db-merge3-vectors.mjs <cocalc-ai src/packages/sync dir, built> <sagebrush patchflow dir> <out.json> [count]
// (made with cocalc-ai at 0b8b754708fdc8c393f4580eaeced4d0f9ebb4e5, its patchflow 0.13.0, and Sagebrush's patchflow 0.16.0;
// not run in CI: it needs a cocalc-ai checkout)
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const [syncDir, sbPatchflow, out, countArg] = process.argv.slice(2);
if (!syncDir || !sbPatchflow || !out) { console.error("usage: node gen-db-merge3-vectors.mjs <cocalc sync dir> <sagebrush patchflow dir> <out.json> [count]"); process.exit(2); }
const COUNT = Number(countArg ?? 400);
const req = createRequire(join(syncDir, "package.json"));
const { mergeDbStrings } = req("./dist/editor/db/merge3.js");
const cocalcPF = req("patchflow");
// (patchflow's exports don't include its package.json: its version read from the directory its main resolves into)
const pkgOf = (main) => { let d = dirname(main); for (let i = 0; i < 6; i++, d = dirname(d)) { try { const j = JSON.parse(readFileSync(join(d, "package.json"), "utf8")); if (j.name === "patchflow") return j; } catch {} } return { version: "unknown" }; };
const cocalcPFVersion = pkgOf(req.resolve("patchflow")).version;
const sbReq = createRequire(join(sbPatchflow, "package.json"));
const sbPF = sbReq(sbPatchflow);
const sbPFVersion = JSON.parse(readFileSync(join(sbPatchflow, "package.json"), "utf8")).version;
const cocalcCommit = execFileSync("git", ["-C", syncDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const OPTS = { primaryKeys: ["type", "id"], stringCols: ["input"] };

// (a seeded generator: mulberry32)
let seed = 0x5a6e1;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const WORDS = ["x", "y", "= 1", "print(x)", "def f():", "    return 2", "# note", "import math", "z = x + y", "for i in range(3):", "    pass", "", "a, b = 1, 2"];
const line = () => pick(WORDS);
const text = (n) => Array.from({ length: n }, line).join("\n");
const cellIds = ["c1", "c2", "c3", "c4", "c5", "c6"];

function baseDoc() {
  const n = 1 + Math.floor(rnd() * 4);
  const recs = [{ type: "settings", id: "", kernel: pick(["python3", "sagemath", "magma"]) }];
  for (let i = 0; i < n; i++) recs.push({ type: "cell", id: cellIds[i], pos: i, input: text(1 + Math.floor(rnd() * 4)), cell_type: "code" });
  return recs;
}
// (one side's edits of the base: typed text, a reorder, a type change, a delete, an added cell, the kernel)
function editText(s) {
  const ls = s.split("\n");
  const k = Math.floor(rnd() * 4);
  const i = Math.floor(rnd() * ls.length);
  if (k === 0) ls.splice(i, 0, line());
  else if (k === 1 && ls.length > 1) ls.splice(i, 1);
  else if (k === 2) ls[i] = ls[i] + pick([" + 1", "!", "_v", " # edited"]);
  else ls[i] = line();
  return ls.join("\n");
}
function side(base) {
  let recs = base.map((r) => ({ ...r }));
  const ops = 1 + Math.floor(rnd() * 3);
  for (let o = 0; o < ops; o++) {
    const cells = recs.filter((r) => r.type === "cell");
    const k = rnd();
    if (k < 0.55 && cells.length) { const c = pick(cells); c.input = editText(c.input); }
    else if (k < 0.65 && cells.length) { pick(cells).pos = Math.floor(rnd() * 6) + rnd(); }
    else if (k < 0.72 && cells.length) { const c = pick(cells); c.cell_type = c.cell_type === "code" ? "markdown" : "code"; }
    else if (k < 0.82 && cells.length) { const c = pick(cells); recs = recs.filter((r) => r !== c); }
    else if (k < 0.94) { const id = pick(cellIds); if (!recs.some((r) => r.type === "cell" && r.id === id)) recs.push({ type: "cell", id, pos: 10 + rnd(), input: text(1 + Math.floor(rnd() * 2)), cell_type: "code" }); }
    else { const s = recs.find((r) => r.type === "settings"); s.kernel = pick(["python3", "sagemath", "magma", "matlab"]); }
  }
  return recs;
}
const str = (recs) => recs.map((r) => JSON.stringify(r)).join("\n");
const parse = (s) => s.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));

const vectors = [];
// (cases like cocalc-ai's jupyter-core-merge pins, as plain record lists)
const pinned = [
  { name: "delete vs edit of one cell: kept whole", base: [{ type: "cell", id: "a", pos: 0, input: "x = 1" }], a: [], b: [{ type: "cell", id: "a", pos: 0, input: "x = 2" }] },
  { name: "delete vs a non-text edit: stays deleted", base: [{ type: "cell", id: "a", pos: 0, input: "x = 1", exec_count: 1 }], a: [], b: [{ type: "cell", id: "a", pos: 0, input: "x = 1", exec_count: 2 }] },
  { name: "same line typed on both sides", base: [{ type: "cell", id: "a", pos: 0, input: "x = 1" }], a: [{ type: "cell", id: "a", pos: 0, input: "x = 10" }], b: [{ type: "cell", id: "a", pos: 0, input: "x = 1 + y" }] },
  { name: "different lines typed on both sides", base: [{ type: "cell", id: "a", pos: 0, input: "x = 1\ny = 2" }], a: [{ type: "cell", id: "a", pos: 0, input: "x = 10\ny = 2" }], b: [{ type: "cell", id: "a", pos: 0, input: "x = 1\ny = 20" }] },
  { name: "pos changed on both sides: the later (b)", base: [{ type: "cell", id: "a", pos: 0, input: "" }], a: [{ type: "cell", id: "a", pos: 1, input: "" }], b: [{ type: "cell", id: "a", pos: 2, input: "" }] },
  { name: "added on both sides with the same id", base: [], a: [{ type: "cell", id: "n", pos: 0, input: "shared\nmine" }], b: [{ type: "cell", id: "n", pos: 0, input: "shared\ntheirs" }] },
];
for (const p of pinned) vectors.push({ ...p, merged: parse(mergeDbStrings({ ...OPTS, base: str(p.base), a: str(p.a), b: str(p.b) })) });
for (let i = 0; i < COUNT; i++) {
  const base = baseDoc(), a = side(base), b = side(base);
  vectors.push({ name: `random ${i}`, base, a, b, merged: parse(mergeDbStrings({ ...OPTS, base: str(base), a: str(a), b: str(b) })) });
}
// (text: the same input fields through both patchflows' mergeStrings3)
let textCases = 0, textSame = 0;
const textDiffs = [];
for (const v of vectors) {
  const B = new Map(v.base.map((r) => [r.type + "/" + r.id, r])), A = new Map(v.a.map((r) => [r.type + "/" + r.id, r])), C = new Map(v.b.map((r) => [r.type + "/" + r.id, r]));
  for (const [k, r0] of B) {
    const ra = A.get(k), rb = C.get(k);
    if (!ra || !rb || typeof r0.input !== "string" || ra.input === rb.input || ra.input === r0.input || rb.input === r0.input) continue;
    textCases++;
    const x = cocalcPF.mergeStrings3({ base: r0.input, a: ra.input, b: rb.input });
    const y = sbPF.mergeStrings3({ base: r0.input, a: ra.input, b: rb.input });
    if (x === y) textSame++;
    else if (textDiffs.length < 10) textDiffs.push({ base: r0.input, a: ra.input, b: rb.input, cocalc: x, sagebrush: y });
  }
}
const doc = {
  producer: { what: "cocalc-ai sync/editor/db/merge3.js mergeDbStrings", cocalcCommit, patchflow: cocalcPFVersion, options: OPTS, seed: 0x5a6e1, count: COUNT },
  patchflowParity: { cocalc: cocalcPFVersion, sagebrush: sbPFVersion, textCases, same: textSame, diffs: textDiffs },
  vectors,
};
// (one vector a line, so a change to the oracle reads as the vectors that changed)
writeFileSync(out, `{"producer": ${JSON.stringify(doc.producer)},\n "patchflowParity": ${JSON.stringify(doc.patchflowParity)},\n "vectors": [\n` + vectors.map((v) => "  " + JSON.stringify(v)).join(",\n") + "\n ]}\n");
console.log(JSON.stringify({ vectors: vectors.length, patchflow: doc.patchflowParity.cocalc + " vs " + doc.patchflowParity.sagebrush, textCases, textSame, textDiffering: textCases - textSame }));
