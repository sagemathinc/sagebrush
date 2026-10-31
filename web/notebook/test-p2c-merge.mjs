// The notebooks' merges outside the patch graph (plan-exact-only r1, P2c's), as units: the store's (history.js exactRecords3, through
// journal.js notebookKind.apply) and the editor's (history.js mergeText, mergeTextAt with the selection mapped).
//   bun web/notebook/test-p2c-merge.mjs
// - T1: cocalc-ai's jupyter-core-merge cases (and more) give what cocalc-ai's own mergeDbStrings gives
//   (p2c-merge-vectors.json, made by gen-p2c-merge-vectors.mjs from cocalc-ai 0b8b7547); through apply, the side
//   `wins` names is the later side `b`, never a clash.
// - T2: mergeText gives what cocalc-ai's mergeText gives, on every vector.
// - The editor's selection mapped through the merge: text merged in before it, after it, across it, deleted before it,
//   non-ASCII before it, and text inserted exactly at it (the affinity).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as H from "./history.js";
import * as N from "./journal.js";

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, "p2c-merge-vectors.json"), "utf8"));
const J = JSON.stringify;
let pass = 0, fail = 0;
const check = (ok, what) => { if (ok) pass++; else { fail++; console.log("FAIL " + what); } };

// ---- T1: the records, against cocalc-ai's own mergeDbStrings
check(V.producer?.cocalc_ai === "0b8b754708fdc8c393f4580eaeced4d0f9ebb4e5" && V.records.length >= 12 && V.text.length >= 50, "the vectors are cocalc-ai 0b8b7547's: " + J(V.producer));
for (const v of V.records) {
  const got = H.exactRecords3(v.base, v.a, v.b);
  check(J(got) === J(v.merged), `T1 ${v.name}: ${J(got)} (cocalc-ai: ${J(v.merged)})`);
}

// ---- T1 through the store's apply: notebook documents, `wins` as the later side, no clash
const kind = N.notebookKind(H);
const nb = (cells, mode = "python") => ({ mode, cells: cells.map(([id, code]) => ({ id, code })) });
const codes = (d) => J(d.cells.map((c) => [c.id, c.code]));
{
  const base = nb([["a", "x = 1\ny = 2\n"], ["b", "keep"]]);
  const r = kind.apply(base, nb([["a", "x = 10\ny = 2\n"], ["b", "keep"]]), nb([["a", "x = 1\ny = 20\n"], ["b", "keep"]]), "remote");
  check(r.clashes.length === 0 && codes(r.value) === J([["a", "x = 10\ny = 20\n"], ["b", "keep"]]), "T1 apply: one cell's lines edited on both sides: both kept, no clash: " + J(r));
  const s = kind.apply(nb([["a", "x = 1\n"]]), nb([["a", "x = 1\nprint('here')\n"]]), nb([["a", "x = 1\nprint('there')\n"]]), "shown");
  check(s.clashes.length === 0 && /here/.test(s.value.cells[0].code) && /there/.test(s.value.cells[0].code), "T1 apply: the same spot typed on both sides: both kept: " + J(s));
  const d = kind.apply(base, nb([["b", "keep"]]), nb([["a", "x = 1\ny = 2\nz = 3\n"], ["b", "keep"]]), "shown");
  check(codes(d.value) === J([["a", "x = 1\ny = 2\nz = 3\n"], ["b", "keep"]]) && d.clashes.length === 0, "T1 apply: deleted here, its input edited there: kept whole: " + J(d));
  // (a deleted cell whose only change elsewhere is not its input (here its type): stays deleted)
  const g = kind.apply(base, nb([["b", "keep"]]), { mode: "python", cells: [{ id: "a", code: "x = 1\ny = 2\n", type: "markdown" }, { id: "b", code: "keep" }] }, "remote");
  check(codes(g.value) === J([["b", "keep"]]), "T1 apply: deleted here, only its type changed there: stays deleted (the ghost cell): " + J(g));
  // (the kernel changed on both sides: the side `wins` names, both ways)
  const m1 = kind.apply(base, nb([["a", "x = 1\ny = 2\n"], ["b", "keep"]], "sage"), nb([["a", "x = 1\ny = 2\n"], ["b", "keep"]], "magma"), "remote");
  const m2 = kind.apply(base, nb([["a", "x = 1\ny = 2\n"], ["b", "keep"]], "sage"), nb([["a", "x = 1\ny = 2\n"], ["b", "keep"]], "magma"), "shown");
  check(m1.value.mode === "magma" && m2.value.mode === "sage" && !m1.clashes.length && !m2.clashes.length, "T1 apply: a field changed on both sides: the later side, by `wins`, both ways: " + J([m1.value.mode, m2.value.mode]));
  // (no lastSynced: both sides' cells merged from an empty notebook)
  const e = kind.apply(null, nb([["a", "1"]]), nb([["a", "1"], ["b", "2"]]), "remote");
  check(codes(e.value) === J([["a", "1"], ["b", "2"]]), "T1 apply: from an empty notebook: " + J(e));
}
// ---- no clash, ever: the same line edited on both sides is merged, the later side's edit after the other's
{
  const r = kind.apply(nb([["a", "x = 1\n"]]), nb([["a", "x = 2\n"]]), nb([["a", "x = 3\n"]]), "remote");
  check(r.clashes.length === 0 && r.value.cells[0].code.includes("2") && r.value.cells[0].code.includes("3"), "apply: the same line edited on both sides: both kept, no clash: " + J(r));
}

// ---- T2: mergeText against cocalc-ai's
for (const v of V.text) {
  const got = H.mergeText(v);
  check(got === v.merged, `T2 ${v.name}: ${J(got)} (cocalc-ai: ${J(v.merged)})`);
}
// (mergeStrings3 orders what the two sides typed canonically, not by side: swapping mergeText's sides changes no
// vector, so the sides' order can't matter for text (a swap control would be vacuous; the controls file says which
// broken copies fail here).  Pinned, so a patchflow that changes it is seen.  The side order does matter for other
// fields: T1's "the later side, both ways" above)
{
  const moved = V.text.filter((v) => v.base !== v.local && v.base !== v.remote && v.local !== v.remote && H.mergeText({ base: v.base, local: v.remote, remote: v.local }) !== v.merged);
  check(moved.length === 0, "T2: mergeText is symmetric in its sides on every vector: " + J(moved.map((v) => v.name)));
}
// ---- the editor's selection, mapped through the merge (astra3's A3): UTF-16 positions, both ends
const at = (base, local, remote, sel) => H.mergeTextAt({ base, local, remote, sel });
{
  // (merged in before the caret: the caret moves with the text it follows)
  const a = at("abc\ndef\n", "abc\ndefX\n", "QQ\nabc\ndef\n", [8, 8]);
  check(a.text === "QQ\nabc\ndefX\n" && J(a.sel) === "[11,11]", "caret: text merged in before it: it follows its text: " + J(a));
  // (merged in after the caret: unmoved)
  const b = at("abc\ndef\n", "abcX\ndef\n", "abc\ndef\nZZ\n", [4, 4]);
  check(b.text === "abcX\ndef\nZZ\n" && J(b.sel) === "[4,4]", "caret: text merged in after it: unmoved: " + J(b));
  // (deleted before the caret: it moves back by the deletion)
  const c = at("one\ntwo\nthree\n", "one\ntwo\nthree!\n", "two\nthree\n", [14, 14]);
  check(c.text === "two\nthree!\n" && J(c.sel) === "[10,10]", "caret: text deleted before it: moved back: " + J(c));
  // (non-ASCII merged in before it: an emoji is two UTF-16 units)
  const d = at("a\nb\n", "a\nbZ\n", "🙂\na\nb\n", [4, 4]);
  check(d.text === "🙂\na\nbZ\n" && J(d.sel) === "[7,7]", "caret: an emoji merged in before it: moved by its two UTF-16 units: " + J(d));
  // (a selection across merged-in text: both ends mapped, the text inside stays selected)
  const e = at("aa\nbb\ncc\n", "aa\nbb\ncc!\n", "ZZ\naa\nBB\ncc\n", [3, 9]);
  check(e.text === "ZZ\naa\nBB\ncc!\n" && J(e.sel) === "[6,12]" && e.text.slice(6, 12) === "BB\ncc!", "selection: text merged in before it and inside it: both ends mapped, the same text selected: " + J(e));
  // (the selection's direction is kept by the editor: notebook.js passes it on; here, ends in order whatever it was)
  const e2 = at("aa\nbb\n", "aa\nbb!\n", "Q\naa\nbb\n", [0, 2]);
  check(J(e2.sel) === "[2,4]", "selection: both ends move with text merged in before it: " + J(e2));
  // (text inserted exactly at the caret: the caret stays after the text it follows, the insertion after it)
  const f = at("x\n", "x\ny\n", "x\nR\n", [3, 3]);
  const iy = f.text.indexOf("y"), iR = f.text.indexOf("R");
  check(f.sel[0] === iy + 1 && f.sel[1] === iy + 1, "caret: an insertion exactly at it: the caret stays right after what it follows: " + J({ f, iy, iR }));
  // (a selection's ends keep text inserted exactly at them outside it)
  const g = at("ab\n", "AB\n", "Xab\n", [0, 2]);
  check(g.text.slice(g.sel[0], g.sel[1]) === "AB" || !g.text.includes("AB"), "selection: text inserted at its start stays outside it: " + J(g));
  // (no change for the local text: the selection as it was)
  const h = at("abc", "abcd", "abc", [2, 4]);
  check(h.text === "abcd" && J(h.sel) === "[2,4]", "no merged change: the selection as it was: " + J(h));
}

console.log(fail ? `${fail} of ${pass + fail} checks FAILED` : `ok: P2c's merges, ${pass} checks (${V.records.length} record and ${V.text.length} text vectors from cocalc-ai)`);
process.exit(fail ? 1 : 0);
