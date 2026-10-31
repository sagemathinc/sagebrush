// The shared pass's conformance vectors, two sections of web/latex/comments-vectors.json (plan shared-pass r2, addendum):
//   semantic: texts and anchors with the statuses, offsets and candidates the resolver gave BEFORE the shared pass (the
//     core at 8ce42493, its budget unbound), and no work. Made ONCE from that core and never remade from a later one:
//     both paths of today's resolver (each anchor's own searches, and the pass, forced) must give exactly these.
//   budget: the shared pass's finite-budget contract: texts, anchors and budgets with the results, the work and the path
//     each case took (forced, and by the dispatch rule at its boundary). Remade when that contract changes on purpose.
//   node web/latex/make-pass-vectors.mjs semantic <old comments-core.mjs> [vectors.json]
//   node web/latex/make-pass-vectors.mjs budget [vectors.json]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const [what, a1, a2] = process.argv.slice(2);
const file = (what === "semantic" ? a2 : a1) ?? join(here, "comments-vectors.json");
const core = await import(what === "semantic" ? pathToFileURL(a1).href : "./comments-core.mjs");
let seed = what === "semantic" ? 31 : 37;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const alph = ["a", "b", "ab", "word ", "\n", " ", "x", "\u{1D4AA}", "é", "% c", "\\item ", "aaaa"];
// (texts and anchors: random ones, edited; and the fixtures the pass is hardest on)
const cases = [];
for (let trial = 0; trial < 40; trial++) {
  let t = ""; const L = 50 + Math.floor(rnd() * 2500); while (t.length < L) t += alph[Math.floor(rnd() * alph.length)];
  const as = []; for (let k = 0; k < 1 + Math.floor(rnd() * 25); k++) { const s = Math.floor(rnd() * (t.length - 1)); try { as.push(core.makeAnchor(t, s, Math.min(t.length, s + 1 + Math.floor(rnd() * (rnd() < 0.1 ? 900 : 40))))); } catch {} }
  const p = Math.floor(rnd() * t.length), q = Math.min(t.length, p + Math.floor(rnd() * 40));
  cases.push({ text: rnd() < 0.5 ? t.slice(0, p) + "INS" + t.slice(p) : t.slice(0, p) + t.slice(q) + t.slice(p, q), anchors: as });
}
const head = "abcdefghijklmnopqrstuvwxyz012345";
cases.push({ text: head.repeat(300), anchors: Array.from({ length: 40 }, (_, k) => { const q = head + "tail" + k; return { start: 0, end: q.length, textSha: "stale", quote: q, prefix: "", suffix: "" }; }) });
const S = "SUFX", P = "UNIQUEPREFIX", orig = (S + " ").repeat(65) + P + "old words" + S;
cases.push({ text: orig.replace("old words", "new text here"), anchors: [core.makeAnchor(orig, orig.indexOf("old words"), orig.indexOf("old words") + 9)] });
const rep = "word ".repeat(2000);
cases.push({ text: "x" + rep, anchors: Array.from({ length: 20 }, (_, k) => core.makeAnchor(rep, k * 100, k * 100 + 10)) });
const V = JSON.parse(readFileSync(file, "utf8"));
if (what === "semantic") {
  if (V.semantic) { console.error("the semantic section exists: it is made once, from the core before the shared pass"); process.exit(2); }
  const BIG = 2 ** 40;
  V.semantic = cases.map((c) => { const R = core.resolver(c.text, BIG); return { ...c, out: c.anchors.map((a) => R.resolve(a)) }; });
} else if (what === "budget") {
  const drain = (g) => { for (;;) { const r = g.next(); if (r.done) return r.value; } };
  V.budget = [];
  for (const c of cases.slice(0, 20)) for (const budget of [2 * c.text.length + 400 + Math.floor(rnd() * 20000), 2 * c.text.length + Math.floor(rnd() * 300)]) {
    const R = core.resolver(c.text, budget, { pass: true }); drain(R.prepare(c.anchors));
    V.budget.push({ ...c, budget, force: true, out: c.anchors.map((a) => R.resolve(a)), work: R.work(), stats: R.passStats() });
  }
  // (the dispatch rule at its boundary, not forced: n x L against 2 x budget, below, at and above)
  const t = "abcdefghij ".repeat(400), as = Array.from({ length: 10 }, (_, k) => core.makeAnchor(t, k * 50 + 3, k * 50 + 20)), u = "x" + t, nL = as.length * u.length;
  for (const budget of [nL / 2 - 1, nL / 2, nL / 2 + 1]) {
    const R = core.resolver(u, budget); drain(R.prepare(as));
    V.budget.push({ text: u, anchors: as, budget, force: false, out: as.map((a) => R.resolve(a)), work: R.work(), stats: R.passStats() });
  }
} else { console.error("usage: semantic <old core> | budget"); process.exit(2); }
writeFileSync(file, JSON.stringify(V, null, 1) + "\n");
console.log(what, what === "semantic" ? V.semantic.length : V.budget.length, "cases");
