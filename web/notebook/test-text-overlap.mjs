// web/notebook/text-overlap.ts: whether two edits of a text overlap, and their line merge when they don't, against
// the shared vectors (merge3-vectors.json's textOverlap) and a few properties: symmetric in the two sides; the
// work charged is exact (one unit less is "exhausted", nothing guessed); one diff past TEXT_DIFF_PRODUCT_LIMIT is
// "exhausted" whatever the ledger; lineMerge3's answer is tagged, so a merged text equal to "exhausted" is a text
// (astra's HOLD on #197).
//   bun web/notebook/test-text-overlap.mjs
import { readFileSync } from "node:fs";
import { textOverlap, lineMerge3, TEXT_DIFF_PRODUCT_LIMIT } from "./text-overlap.ts";

const here = new URL(".", import.meta.url).pathname;
const V = JSON.parse(readFileSync(here + "merge3-vectors.json", "utf8"));
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const J = JSON.stringify;
const big = 1e12;
// (lineMerge3's tagged answer as the vectors write it: the text, or false for an overlap, or "exhausted")
// (an answer that isn't a tagged object is reported as such, never taken for a text)
const lm = (r) => (r === null || typeof r !== "object" ? "untagged " + J(r) : "text" in r ? r.text : r.overlap === true ? false : r.exhausted === true ? "exhausted" : "?");

for (const v of V.textOverlap) {
  try {
    const l = { left: v.minUnits };
    check(textOverlap(v.base, v.a, v.b, l) === v.overlap && l.left === 0, `${v.name}: overlap ${v.overlap}, charging exactly ${v.minUnits}`);
    if (v.minUnits > 0) check(textOverlap(v.base, v.a, v.b, { left: v.minUnits - 1 }) === "exhausted", `${v.name}: one unit less is "exhausted"`);
    const ls = { left: big };
    check(textOverlap(v.base, v.b, v.a, ls) === v.overlap && big - ls.left === v.minUnits, `${v.name}: symmetric (overlap and work)`);
    check(J(lineMerge3(v.base, v.a, v.b, { left: big })) === J(v.merged === false ? { overlap: true } : { text: v.merged }), `${v.name}: lineMerge3 ${J(v.merged)}`);
    check(lm(lineMerge3(v.base, v.b, v.a, { left: big })) === v.merged, `${v.name}: lineMerge3 symmetric`);
  } catch (e) {
    check(false, `${v.name}: threw ${e?.stack ?? e}`);
  }
}
// (the trivial cases need no diff, whatever the ledger)
check(lm(lineMerge3("a\n", "a\n", "b\n", { left: 0 })) === "b\n" && lm(lineMerge3("a\n", "b\n", "b\n", { left: 0 })) === "b\n", "lineMerge3: one side unchanged, or both the same, without any work");
// (one diff past TEXT_DIFF_PRODUCT_LIMIT: "exhausted" whatever the ledger, and nothing charged)
{
  const n = Math.ceil(Math.sqrt(TEXT_DIFF_PRODUCT_LIMIT)) + 1;
  const base = Array.from({ length: n }, (_, i) => `b${i}\n`).join(""), a = Array.from({ length: n }, (_, i) => `a${i}\n`).join("");
  const l = { left: big };
  check(TEXT_DIFF_PRODUCT_LIMIT === 4_000_000, "TEXT_DIFF_PRODUCT_LIMIT is patchflow's MAX_DIFF_PRODUCT, 4,000,000");
  check(textOverlap(base, a, base + "x\n", l) === "exhausted" && l.left === big, `one diff of ${n} × ${n} lines: "exhausted", nothing charged`);
  check(J(lineMerge3(base, a, base + "x\n", { left: big })) === J({ exhausted: true }), "…and lineMerge3 the same, tagged");
}
// (a random sweep: symmetric, and a merge that isn't false contains each side's changed lines)
{
  let seed = 7;
  const rnd = (k) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
  const lines = (n) => Array.from({ length: n }, () => "abcde"[rnd(5)] + "\n");
  let asym = 0, lost = 0;
  for (let t = 0; t < 2000; t++) {
    const b0 = lines(rnd(6)), edit = () => { const x = b0.slice(); for (let k = rnd(3); k >= 0; k--) { const i = rnd(x.length + 1), op = rnd(3); if (op === 0) x.splice(i, 0, "XYZ"[rnd(3)] + rnd(9) + "\n"); else if (op === 1 && i < x.length) x.splice(i, 1); else if (i < x.length) x[i] = "Q" + rnd(9) + "\n"; } return x; };
    const A = edit(), B = edit(), base = b0.join(""), a = A.join(""), b = B.join("");
    const o1 = textOverlap(base, a, b, { left: big }), o2 = textOverlap(base, b, a, { left: big });
    const m1 = lm(lineMerge3(base, a, b, { left: big })), m2 = lm(lineMerge3(base, b, a, { left: big }));
    if (o1 !== o2 || m1 !== m2) asym++;
    if (typeof m1 === "string") for (const s of [A, B]) for (const l of s) if (!b0.includes(l) && !m1.split(/(?<=\n)/).includes(l)) lost++;
  }
  check(asym === 0, `2,000 random edits: overlap and merge symmetric (${asym} not)`);
  check(lost === 0, `…and every line either side added is in the merge (${lost} missing)`);
}
// (the hard bound exactly (daybreak2 on #197): a diff of exactly TEXT_DIFF_PRODUCT_LIMIT units is made and charged
// exactly that; with one unit less in the ledger it is "exhausted"; one past the limit is "exhausted" uncharged)
{
  const n = 2000, base = Array.from({ length: n }, (_, i) => `b${i}\n`).join(""), a = Array.from({ length: n }, (_, i) => `a${i}\n`).join("");
  check(n * n === TEXT_DIFF_PRODUCT_LIMIT, "2,000 × 2,000 lines is exactly the limit");
  const l1 = { left: big };
  check(textOverlap(base, a, base, l1) === false && big - l1.left === TEXT_DIFF_PRODUCT_LIMIT, "a diff of exactly the limit: made, charged exactly 4,000,000");
  const l2 = { left: TEXT_DIFF_PRODUCT_LIMIT - 1 };
  check(textOverlap(base, a, base, l2) === "exhausted" && l2.left === TEXT_DIFF_PRODUCT_LIMIT - 1, "a ledger of 3,999,999: \"exhausted\", nothing charged");
  const l3 = { left: big }, a2 = a + "a2000\n";
  check(textOverlap(base, a2, base, l3) === "exhausted" && l3.left === big, "2,000 × 2,001 lines, past the limit: \"exhausted\", nothing charged");
}
// (astra's repro on #197: separate edits whose merged text is the word "exhausted", both orders; and a merged
// text equal to "overlap" or empty, likewise only a text)
{
  const r1 = lineMerge3("x\nexhausteD", "exhausteD", "x\nexhausted", { left: big }), r2 = lineMerge3("x\nexhausteD", "x\nexhausted", "exhausteD", { left: big });
  check(J(r1) === J({ text: "exhausted" }) && J(r2) === J({ text: "exhausted" }), "a merged text \"exhausted\" is a text, both orders: " + J([r1, r2]));
  const r3 = lineMerge3("a\nb", "b", "a\n", { left: big });
  check(lm(r3) === "", "two separate deletions merged to the empty text, a text: " + J(r3));
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `${checks}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
