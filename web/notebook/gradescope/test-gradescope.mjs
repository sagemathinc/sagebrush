// ci: web-sync.4 order=38 runner=bun
// "PDF for Gradescope", the pure parts (web/notebook/gradescope/outline.ts and layout.ts), on synthetic notebooks:
// exercises detected from their headings (emphasis, HTML and heading marks ignored), the outline in the notebook's
// metadata checked strictly and stored without touching anything else, each exercise's cells, pages packed with text
// split only at line boundaries, the fitting stages and their floor, how far an exercise overflows, and the
// fixed-length plan whose page count is the same for every copy and the template.
//   bun web/notebook/gradescope/test-gradescope.mjs
let checks = 0;
const fails = [];
const ok = (c, what) => { checks++; if (!c) { fails.push(what); console.log("FAIL", what); } };
const J = JSON.stringify;

const { headingText, headingOf, detect, readOutline, withOutline, sections, outlineFor } = await import("./outline.ts");
const { contentBox, paginate, fit, plan, pageList, STAGES, PAPER } = await import("./layout.ts");

const md = (id, code) => ({ id, type: "markdown", code });
const code = (id, src = "x = 1") => ({ id, code: src, outputs: [] });

// ---- detection
ok(headingText('<u><b><span style="color:green">Exercise 5.</span></b></u> Now run it') === "Exercise 5. Now run it", "HTML around the heading is ignored");
ok(headingText("\n\n### **Question 2:** what") === "Question 2: what", "heading marks and emphasis are ignored, and blank lines skipped");
ok(J(headingOf("<span style='color:green'><u>**Exercise 12.**</u></span> After you run")) === J({ kind: "Exercise", num: "12" }), "an exercise number inside spans and emphasis");
ok(J(headingOf("Problem 3) Show that")) === J({ kind: "Problem", num: "3" }) && J(headingOf("part 4b. Then")) === J({ kind: "Part", num: "4b" }), "Problem N), part Nb.");
ok(headingOf("In Exercise 5. we saw") === null && headingOf("Exercises are below") === null && headingOf("Exercise five.") === null, "only a heading at the start, with a number, counts");
const nb = [md("a", "# Lab 1\nInstructions"), code("b"), md("c", "**Exercise 1.** Plot it"), code("d"), md("e", "Some notes"), md("f", "Exercise 2: Describe"), code("g"), md("h", "Exercise 2. again")];
const found = detect(nb);
ok(J(found.map((e) => [e.id, e.title, e.cell, e.pages])) === J([["exercise-1", "Exercise 1", "c", 1], ["exercise-2", "Exercise 2", "f", 1], ["exercise-2-2", "Exercise 2", "h", 1]]), "exercises detected in order, one page each, ids unique: " + J(found.map((e) => e.id)));
ok(detect([code("x", "# Exercise 1. in a comment")]).length === 0, "a code cell never starts an exercise");

// ---- each exercise's cells (the instructions before the first one are left out)
const s = sections(nb, found);
ok(J(s.sections.map((x) => x.cells.map((c) => c.id))) === J([["c", "d", "e"], ["f", "g"], ["h"]]) && s.missing.length === 0, "an exercise runs to the cell before the next one; the instructions aren't in any");
const s2 = sections(nb, [{ id: "q2", title: "Q2", cell: "f", pages: 1 }, { id: "q1", title: "Q1", cell: "c", pages: 1 }, { id: "q9", title: "Q9", cell: "gone", pages: 1 }]);
ok(J(s2.sections.map((x) => [x.exercise.id, x.cells.map((c) => c.id)])) === J([["q2", ["f", "g", "h"]], ["q1", ["c", "d", "e"]]]) && J(s2.missing.map((e) => e.id)) === J(["q9"]), "ranges follow the notebook's order; the outline's order is kept; a missing first cell is reported, not dropped");

// ---- the outline in the metadata: strict
const good = { v: 1, paper: "letter", exercises: [{ id: "exercise-1", title: "Exercise 1", cell: "c", pages: 2 }, { id: "exercise-2", title: "Exercise 2", cell: "f", pages: 1 }] };
ok(J(readOutline({ sagebrush: { gradescope: good } })) === J(good) && readOutline({}) === null && readOutline(undefined) === null, "a good outline is read; none is null");
const badOnes = [
  [{ ...good, extra: 1 }, "an unknown field"],
  [{ ...good, v: 2 }, "an unknown version"],
  [{ ...good, paper: "legal" }, "an unknown paper"],
  [{ ...good, exercises: [] }, "no exercises"],
  [{ ...good, exercises: [{ ...good.exercises[0], pages: 0 }] }, "a budget of 0"],
  [{ ...good, exercises: [{ ...good.exercises[0], pages: 21 }] }, "a budget over 20"],
  [{ ...good, exercises: [{ ...good.exercises[0], pages: 1.5 }] }, "a fractional budget"],
  [{ ...good, exercises: [good.exercises[0], { ...good.exercises[1], id: "exercise-1" }] }, "a repeated id"],
  [{ ...good, exercises: [good.exercises[0], { ...good.exercises[1], cell: "c" }] }, "a repeated first cell"],
  [{ ...good, exercises: [{ ...good.exercises[0], note: "x" }] }, "an unknown exercise field"],
  [{ ...good, exercises: [{ ...good.exercises[0], id: "Ex 1" }] }, "an id that isn't lower-case letters, digits and dashes"],
];
for (const [o, why] of badOnes) ok("error" in (readOutline({ sagebrush: { gradescope: o } }) ?? {}), `refused: ${why}`);
const meta = { kernelspec: { name: "python3" }, sagebrush: { reproducible: true } };
const stored = withOutline(meta, good);
ok(J(stored.kernelspec) === J(meta.kernelspec) && stored.sagebrush.reproducible === true && J(stored.sagebrush.gradescope) === J(good) && meta.sagebrush.gradescope === undefined, "storing keeps the rest of the metadata and doesn't change the original");
ok(withOutline(stored, null).sagebrush.gradescope === undefined && withOutline(stored, null).sagebrush.reproducible === true, "removing it leaves the rest");
ok(outlineFor({ cells: nb, metadata: { sagebrush: { gradescope: good } } }).source === "saved", "a saved outline is used");
const det = outlineFor({ cells: nb, metadata: { sagebrush: { gradescope: { v: 9 } } } });
ok(det.source === "detected" && det.outline.paper === "letter" && det.outline.exercises.length === 3 && /unknown version/.test(det.error), "a broken saved outline: detected instead, and the reason kept to show");
ok(outlineFor({ cells: [md("a", "Intro"), code("b")] }).source === "none", "no exercises anywhere: none");

// ---- pages
const box = contentBox("letter"), boxA4 = contentBox("a4");
ok(box.w === 725 && box.h === 935 && boxA4.w > 700 && boxA4.h > box.h, `Letter's content box ${box.w}×${box.h}; A4 taller (${Math.round(boxA4.w)}×${Math.round(boxA4.h)})`);
ok(PAPER.letter.css === "letter" && PAPER.a4.css === "A4", "the CSS page sizes");
const H = 1000;
let p = paginate([{ h: 300 }, { h: 300 }, { h: 300 }], H);
ok(p.length === 1 && p[0].used === 900, "blocks that fit share a page");
p = paginate([{ h: 600 }, { h: 600 }], H);
ok(p.length === 2 && J(p.map((x) => x.pieces)) === J([[{ b: 0 }], [{ b: 1 }]]), "a picture that doesn't fit moves whole to the next page");
const lines = (n, lh = 20, top = 0) => ({ h: top + n * lh, lines: { hs: Array(n).fill(lh), top } });
p = paginate([{ h: 600 }, lines(45)], H);
ok(p.length === 2 && J(p[0].pieces[1]) === J({ b: 1, from: 0, to: 20 }) && J(p[1].pieces[0]) === J({ b: 1, from: 20, to: 45 }), "a text block splits at a line boundary: " + J(p.map((x) => x.pieces)));
p = paginate([lines(205)], H);
ok(p.length === 5 && p.every((x) => x.used <= H) && p.reduce((a, x) => a + x.pieces.reduce((s, q) => s + (q.to - q.from), 0), 0) === 205, "a long output runs over several pages, every line kept");
p = paginate([{ h: 2500 }], H);
ok(p.length === 1 && p[0].pieces[0].scale === 0.4, "a picture taller than a page is shrunk to fit it, never cut");
ok(paginate([], H).length === 1, "an empty exercise still has its page");
p = paginate([{ h: 900 }, { h: 160, lines: { hs: [20, 100, 20, 20], top: 0 } }], H);
ok(J(p.map((x) => x.pieces)) === J([[{ b: 0 }, { b: 1, from: 0, to: 1 }], [{ b: 1, from: 1, to: 4 }]]), "a wrapped line (taller) is measured as itself: the split falls before it");
p = paginate([{ h: 1550, lines: { hs: [20, 1500, 20], top: 10 } }], H);
ok(p.length === 3 && J(p[1].pieces) === J([{ b: 0, from: 1, to: 2 }]), "one line taller than a page goes alone, and the packing goes on");

// ---- fitting
const stagesOf = (hs) => STAGES.map((st, i) => hs.map((h) => ({ h: Math.round(h * (i >= 2 ? st.text : 1)) })));
let f = fit(stagesOf([400, 400]), H, 1);
ok(f.fits && f.stage === 0 && f.pages.length === 1, "fits as is: stage 0");
f = fit([[{ h: 700 }, { h: 700 }], [{ h: 450 }, { h: 450 }], [{ h: 450 }, { h: 450 }], [{ h: 450 }, { h: 450 }]], H, 1);
ok(f.fits && f.stage === 1, "capping pictures makes it fit: stage 1");
f = fit(stagesOf([560, 560]), H, 1);
ok(f.fits && f.stage === 3, "text at 80% makes it fit: stage 3 (" + f.stage + ")");
f = fit(stagesOf([900, 900, 900]), H, 1);
ok(!f.fits && f.stage === 3 && f.pages.length === 3 && f.over === 1.7, "too long even at 80% (three 720 px pictures, one a page): about 1.7 pages over (" + f.over + ")");
ok(fit(stagesOf([2000]), H, 1).fits === true, "one picture taller than the page fits, shrunk (a picture never overflows by itself)");

// ---- the plan
const ex = [{ title: "Exercise 1", budget: 2, fit: fit(stagesOf([400]), H, 2) }, { title: "Exercise 2", budget: 1, fit: fit(stagesOf([900]), H, 1) }];
const fixed = plan(ex, "fixed");
ok(fixed.pages === 4 && J(fixed.exercises.map((e) => [e.first, e.pages.length, e.padding])) === J([[2, 1, 1], [4, 1, 0]]), "fixed: 1 + the budgets' sum pages; Exercise 1 padded to its 2 pages");
const tmpl = plan([{ title: "Exercise 1", budget: 2, fit: fit(stagesOf([100]), H, 2) }, { title: "Exercise 2", budget: 1, fit: fit(stagesOf([50]), H, 1) }], "fixed");
ok(tmpl.pages === fixed.pages && J(tmpl.exercises.map((e) => e.first)) === J(fixed.exercises.map((e) => e.first)), "the template and a filled copy: the same pages, each exercise starting on the same page");
ok(pageList(fixed.exercises) === "Name: page 1\nExercise 1: pages 2–3\nExercise 2: page 4", "the page list for Gradescope's outline: " + J(pageList(fixed.exercises)));
const over = [{ title: "Exercise 1", budget: 1, fit: fit(stagesOf([900, 900, 900]), H, 1) }, { title: "Exercise 2", budget: 1, fit: fit(stagesOf([100]), H, 1) }];
const refused = plan(over, "fixed");
ok("error" in refused && refused.error === "Exercise 1 is about 1.7 pages longer than its 1 page", "fixed with an overflow: says which exercise and by how much (" + refused.error + ")");
const variable = plan(over, "variable");
ok(variable.pages === 5 && J(variable.exercises.map((e) => [e.first, e.pages.length, e.padding])) === J([[2, 3, 0], [5, 1, 0]]), "variable: each exercise takes the pages it needs");

console.log(`${checks - fails.length}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
