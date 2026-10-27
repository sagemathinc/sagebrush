// Writes the `board` section of web/notebook/merge3-vectors.json: boardMerge3 on a text field changed on
// both sides (the text-overlap policy shared with the notebooks' merge), each outcome checked against the
// expectation written here before it is written, and failing otherwise.
//   bun web/board/gen-merge3-board-vectors.mjs          (rewrites the board section)
//   bun web/board/gen-merge3-board-vectors.mjs --check  (fails if the file's section differs)
import { readFileSync, writeFileSync } from "node:fs";
import { boardMerge3 } from "./merge.ts";

const FILE = new URL("../notebook/merge3-vectors.json", import.meta.url);
const doc = { type: "doc", page: "", id: "", title: "t" };
const note = (text) => [doc, { type: "item", page: "", id: "n", parent: "", pos: 1, text }];
const cases = [
  { name: "different lines: merged by lines", base: "one\ntwo\nthree\n", a: "ONE\ntwo\nthree\n", b: "one\ntwo\nTHREE\n", want: { text: "ONE\ntwo\nTHREE\n", overlap: false } },
  { name: "the same line: a text-overlap, one whole text kept by the tie-break, the other its alternative", base: "hello world", a: "hello brave world", b: "hello world!", want: { text: "hello brave world", overlap: true, alternative: "hello world!" } },
  { name: "the same line, sides swapped: the same result (symmetric)", base: "hello world", a: "hello world!", b: "hello brave world", want: { text: "hello brave world", overlap: true, alternative: "hello world!" } },
  { name: "two different insertions at the same gap: a text-overlap", base: "a\nb\n", a: "a\nX\nb\n", b: "a\nY\nb\n", want: { text: "a\nX\nb\n", overlap: true, alternative: "a\nY\nb\n" } },
  { name: "an insertion touching the other side's replaced line: a text-overlap (conservative)", base: "a\nb\nc\n", a: "a\nB\nc\n", b: "a\nb\nNEW\nc\n", want: { overlap: true } },
  { name: "the same edit on both sides: taken once, no report", base: "x\ny\n", a: "x\nY\n", b: "x\nY\n", want: { text: "x\nY\n", overlap: false } },
  { name: "x = 0 against x = 1 and x = 2: never the hybrid x = 1 2", base: "x = 0", a: "x = 1", b: "x = 2", want: { text: "x = 1", overlap: true, alternative: "x = 2" } },
];

const out = [];
const problems = [];
for (const c of cases) {
  const r = boardMerge3(note(c.base), note(c.a), note(c.b), { work: 1e9 });
  if ("refused" in r) { problems.push(`${c.name}: refused ${r.refused}`); continue; }
  const text = r.records.find((x) => x.type === "item")?.text;
  const rep = r.reports.find((x) => x.kind === "text-overlap");
  const alt = r.alternatives.find((x) => x.field === "text");
  const got = { text, overlap: !!rep, alternative: alt?.value };
  for (const [k, v] of Object.entries(c.want)) if (got[k] !== v) problems.push(`${c.name}: ${k} is ${JSON.stringify(got[k])}, expected ${JSON.stringify(v)}`);
  // (the ledger: exactly the work used succeeds, one unit less is refused, never a partial result)
  const short = boardMerge3(note(c.base), note(c.a), note(c.b), { work: r.used - 1 });
  if (!("refused" in short) || short.refused !== "work") problems.push(`${c.name}: one unit below ${r.used} wasn't refused`);
  out.push({ name: c.name, base: c.base, a: c.a, b: c.b, text, overlap: !!rep, ...(rep ? { kept: rep.kept, other: rep.other } : {}), minUnits: r.used });
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
const v = JSON.parse(readFileSync(FILE, "utf8"));
if (process.argv.includes("--check")) {
  const same = JSON.stringify(v.board) === JSON.stringify(out);
  console.log(same ? `board vectors: ${out.length} current` : "board vectors differ: run without --check");
  process.exit(same ? 0 : 1);
}
v.board = out;
writeFileSync(FILE, JSON.stringify(v, null, 2) + "\n");
console.log(`board vectors: ${out.length} written`);
