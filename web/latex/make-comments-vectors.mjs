// The comments core's conformance vectors (web/latex/comments-vectors.json): inputs and the outputs
// comments-core.mjs gives for them, which the Python port (engine/py/python/sagebrush/latex_comments.py) must give
// too. Both suites check them: test-comments-core.mjs that the JS core still gives these outputs, and
// engine/py/test_latex_comments.py that the port does. Rewrite them after a deliberate change to the core:
//   node web/latex/make-comments-vectors.mjs > web/latex/comments-vectors.json
import * as C from "./comments-core.mjs";

const T0 = "2026-10-29T20:00:00.000Z", T1 = "2026-10-29T20:05:00.000Z";
const TEX = "\\documentclass{article}\n\\begin{document}\nLet $n$ be even. Then $n^2$ is even.\n\nThe sum of two odd numbers is even.\nAnd the sum of two even numbers is even.\n\\end{document}\n";
// (characters outside the BMP before the anchors: offsets in UTF-16 units)
const ASTRAL = "\u{1D4AA}\u{1F600} \u00e9t\u00e9: " + TEX.replace("odd numbers", "odd numbers \u{1F914}");
const at = (t, s) => [t.indexOf(s), t.indexOf(s) + s.length];
const anchors = (t) => ["Then $n^2$ is even.", "odd numbers", "even", "sum of two"].map((q) => { const [s, e] = at(t, q); return C.makeAnchor(t, s, e); });

// documents made with fixed times (ids are random: the documents are data in the vectors, not remade)
const H = { author: "person:wstein", time: T0 }, A = { author: "agent:claude", time: T1 };
let d = C.emptyDoc({ fid: "f1", path: "/p.tex" });
for (const a of anchors(TEX)) d = C.addThread(d, { anchor: a, text: "why \u00e9 \u{1F600}?", ...H }).doc;
const ids = d.threads.map((t) => t.id);
const dr = C.reply(d, ids[0], { text: "Done: rewritten.", ...A }).doc;
const ds = C.setResolved(dr, ids[0], true, A).doc;
const dd = C.deleteThread(d, ids[1], { author: "person:wstein", time: T1 }).doc;

// outside edits: moved, changed, removed, duplicated, ambiguous
const edits = {
  same: TEX,
  moved: "Intro line.\n\n" + TEX,
  changed: TEX.replace("The sum of two odd numbers is even.", "Adding two odd numbers gives an even number."),
  removed: TEX.replace("The sum of two odd numbers is even.", ""),
  duplicated: TEX.replace("\n\\end{document}", "\nThen $n^2$ is even.\n\\end{document}"),
  astral: ASTRAL,
};
const out = { about: "comments-core conformance vectors; made by web/latex/make-comments-vectors.mjs", sha256: [], makeAnchor: [], resolve: [], merge: [], list: [], show: [], locateSpan: [], parse: [], serialize: [] };
const err = (f) => { try { return { ok: f() }; } catch (e) { return { error: { code: e.code ?? "exception", detail: e.detail ?? null } }; } };

for (const s of ["", "abc", "\u00e9t\u00e9", "\u{1F600} and \u{1D4AA}", TEX, ASTRAL]) out.sha256.push({ in: s, out: C.sha256(s) });
for (const [t, q, shown] of [[TEX, "Then $n^2$ is even.", undefined], [TEX, "$n^2$", "n2"], [ASTRAL, "odd numbers \u{1F914}", undefined], [ASTRAL, "\u{1F600}", undefined], ["x".repeat(50) + "BEGIN" + "y".repeat(900) + "END" + "z".repeat(50), null, undefined]]) {
  const [s, e] = q === null ? [50, 50 + 908] : at(t, q);
  out.makeAnchor.push({ text: t, start: s, end: e, shown: shown ?? null, out: C.makeAnchor(t, s, e, shown) });
}
for (const [name, text] of Object.entries(edits)) {
  for (const budget of [undefined, 3 * text.length + 200, 2 * text.length - 1]) {
    const R = C.resolver(text, budget);
    const as = [...anchors(TEX), ...anchors(ASTRAL), C.makeAnchor("q".repeat(50) + "BEGIN" + "y".repeat(900) + "END", 50, 958)];
    out.resolve.push({ text, budget: budget ?? null, anchors: as, out: as.map((a) => R.resolve(a)), work: R.work() });
  }
}
// large texts, by a recipe both sides build the same way (head + template with {i} for i < count + tail), so the
// resolver's long-range search in place and its long span hashed in pieces are covered without storing the text
const build = (r) => r.head + Array.from({ length: r.count }, (_, i) => r.template.replaceAll("{i}", String(i))).join("") + r.tail;
for (const recipe of [{ head: "\\begin{document}\n", template: "Paragraph {i}: words, a phrase numbered {i}, \u{1F600} more.\n\n", count: 7000, tail: "\\end{document}\n" }]) {
  const text = build(recipe), q = (k) => { const s = text.indexOf(`a phrase numbered ${k},`); return C.makeAnchor(text, s, s + `a phrase numbered ${k},`.length); };
  const longS = text.indexOf("Paragraph 100:"), longE = text.indexOf("Paragraph 3100:");
  const as = [q(0), q(3333), q(6999), C.makeAnchor(text, longS, longE)].map((a) => ({ ...a, textSha: "stale" }));
  const moved = "Inserted.\n" + text;
  for (const budget of [undefined, 4 * moved.length]) {
    const R = C.resolver(moved, budget);
    out.resolve.push({ recipe: { ...recipe, head: "Inserted.\n" + recipe.head }, budget: budget ?? null, anchors: as, out: as.map((a) => R.resolve(a)), work: R.work() });
  }
}
out.merge.push({ a: ds, b: dd, out: C.merge(ds, dd) }, { a: dd, b: ds, out: C.merge(dd, ds) }, { a: dr, b: d, out: C.merge(dr, d) });
for (const [name, text] of Object.entries(edits)) {
  out.list.push({ doc: ds, text, all: false, out: C.list(ds, text) });
  out.list.push({ doc: ds, text, all: true, out: C.list(ds, text, { all: true }) });
  out.show.push({ doc: ds, text, id: ids[0], out: C.show(ds, text, ids[0]) });
}
out.show.push({ doc: dd, text: TEX, id: ids[1], out: err(() => C.show(dd, TEX, ids[1])) });
for (const [t, q] of [[TEX, { quote: "is even." }], [TEX, { quote: "is even.", occurrence: 2 }], [TEX, { quote: "nowhere" }], [TEX, { range: { start: { line: 3, col: 5 }, end: { line: 3, col: 8 } } }], [ASTRAL, { quote: "\u{1F914}" }]]) out.locateSpan.push({ text: t, args: q, out: err(() => C.locateSpan(t, q)) });
for (const s of [null, "{", JSON.stringify({ ...C.emptyDoc({}), version: 2 }), JSON.stringify({ format: "x" }), C.serialize(ds), "[]"]) out.parse.push({ in: s, out: err(() => C.parse(s, { fid: "f9", path: "/q.tex" })) });
for (const doc of [C.emptyDoc({}), d, ds, dd]) out.serialize.push({ doc, out: C.serialize(doc) });
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
