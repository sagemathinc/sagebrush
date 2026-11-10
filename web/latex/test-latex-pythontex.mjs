// ci: checks.3 order=109 runner=bun
// (checks.3 with the other latex suites; no browser and no build output needed, a few seconds)
// PythonTeX, step (a) (plan r3.1, CLEAR by daybreak3 and astra): \py, pycode, pyblock and \printpythontex. Their saved
// results are TeX source, read back where each item stands by the results pass (engine/pipeline.mjs); the items are
// fixed by the source alone (the source pass, S), and a result can never add, rename or take an item's value.
//   bun web/latex/test-latex-pythontex.mjs
import { Engine, installPythontex, withPythontex } from "./engine/pipeline.mjs";
import { itemKey, MAX_RESULT, utf8len } from "./engine/sagetex.mjs";
import * as pythontexCode from "./engine/pythontex.mjs";
import { setKatex } from "./engine/render.mjs";
// (KaTeX stubbed: each formula drawn as its source)
setKatex((src) => "<span class=\"katex\">" + src.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]) + "</span>");
const { NOT_HERE, NOT_EARLIER, NOT_FROM_DOC } = pythontexCode;
import { readFileSync } from "node:fs";

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 900)); };
const doc = (body, pre = "") => "\\documentclass{article}\n\\usepackage{pythontex}\n" + pre + "\\begin{document}\n" + body + "\n\\end{document}\n";
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = (r) => unesc(r.chunks.join(" ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const keys = (r) => r.sageItems.map(itemKey);
// the source's items (S) and a saved result for each, by index: a string (ok, its text), or a state object
const S = (src) => new Engine().update(src).sageItems;
function saved(src, vals) {
  return S(src).map((it, k) => { const v = vals[k]; return v === undefined ? null : typeof v === "string" ? { key: itemKey(it), s: "ok", latex: v } : { key: itemKey(it), ...v }; }).filter(Boolean);
}
// (r.passes: how many results passes ran, engine/pythontex.mjs)
const show = (src, vals, eng = new Engine({ sage: { saved: saved(src, vals) } })) => Object.assign(eng.update(src, { cold: true }), { passes: eng.rp?.passes ?? 0 });

// ---- the lazy chunk (engine/pythontex.mjs; daybreak2's SIZE ruling): before it is installed, a document with a result
// to read back is marked needPy (the worker fetches the chunk and renders again); one without a result never is
{
  const src = doc("A: \\py{1}.");
  const none = new Engine().update(src), withR = show(src, ["ONE"]);
  check("chunk-needed-only-for-results", !none.needPy && withR.needPy === true && !text(withR).includes("ONE"), [none.needPy, withR.needPy]);
  const stale = new Engine({ sage: { saved: saved(src.replace("\\py{1}", "\\py{2}"), ["OLD"]) } }).update(src, { cold: true });
  const err = show(src, [{ s: "error", msg: "boom" }]);
  check("chunk-needed-for-stale-not-error", stale.needPy === true && !err.needPy, [stale.needPy, err.needPy]);
}
// (the chunk's fetch failed: the notice at the top, the only mark, as beamer's; board's text, Nov 10)
{
  const src = doc("A: \\py{1}.");
  let again = 0;
  const r = await withPythontex(show(src, ["ONE"]), () => Promise.reject(new Error("offline")), () => { again++; });
  check("chunk-fetch-failed-notice", r.chunks[0] === '<div class="bounderr">PythonTeX\'s results could not be loaded (offline); reload the page to try again. The preview shows the document without them.</div>'
    && r.problems.some((p) => p.kind === "pythontex") && again === 0, r.chunks[0]);
}
installPythontex(pythontexCode);

// ---- the oracle: real PythonTeX 0.18 on TeX Live 2025 (pdflatex, pythontex, pdflatex), its PDF's text (pdftotext):
// "A: 1024. B: 42. C: 7. y = x + 1 print(y) D: 8 E: ¡b¿." (¡b¿: OT1's glyphs for < and >; the preview shows <b>)
{
  const src = doc("A: \\py{2**10}.\n\\begin{pycode}\nx = 7\nprint(r\"B: \\textbf{\" + str(x*6) + \"}.\")\n\\end{pycode}\nC: \\py{x}.\n\\begin{pyblock}\ny = x + 1\nprint(y)\n\\end{pyblock}\nD: \\printpythontex\nE: \\py{'<b>'}.");
  const r = show(src, ["1024", "B: \\textbf{42}.\n", "7", "8\n", "<b>"]);
  check("oracle-modes", JSON.stringify(r.sageItems.map((x) => x.mode)) === JSON.stringify(["py", "pycode", "py", "pyblock", "py"]), r.sageItems);
  check("oracle-text", text(r) === "A: 1024. B: 42. C: 7. y = x + 1 print(y) D: 8 E: <b>.", text(r));
  // (what pycode printed is TeX: \textbf is bold; \py's value is text, its "<b>" never HTML)
  const h = r.chunks.join("");
  check("oracle-tex-and-escaped", /<span class="b">42<\/span>/.test(h) && h.includes("&lt;b&gt;") && !/<b>/.test(h), h.slice(0, 600));
  // (before a Run: the items found, each "not run"; pyblock's code shown, pycode's not)
  const n = new Engine().update(src);
  check("oracle-before-run", /Python item 1: not run/.test(text(n)) && text(n).includes("y = x + 1") && !text(n).includes("x = 7") && !/1024/.test(text(n)), text(n));
}

// ---- real TeX semantics (daybreak3): a result is read unbraced and ungrouped: a \def in it holds after it
{
  const r = show(doc("\\py{1} then \\q."), ["\\def\\q{QQ}\\textbf{x}"]);
  check("result-def-holds", text(r) === "x then QQ.", text(r));
}

// ---- result-born items: from a result's text, or from what a result defined, never the document's code (R3-2)
{
  const born = (body, vals) => { const src = doc(body); const r = show(src, vals); return { r, t: text(r), S: keys(new Engine().update(src)) }; };
  const nfd = (t, n = 1) => t.split(NOT_FROM_DOC).length - 1 === n;
  const direct = born("\\py{1} after.", ["\\py{2} \\begin{pyblock}\nq = 1\n\\end{pyblock} \\sage{3} inner"]);
  check("born-direct", nfd(direct.t, 3) && direct.t.includes("inner after.") && keys(direct.r).join() === direct.S.join(), direct.t);
  const alias = born("\\py{1} then \\p{4} end.", ["\\let\\p\\py \\p{5}"]);
  check("born-alias", nfd(alias.t, 2) && keys(alias.r).join() === alias.S.join(), alias.t);
  const deferred = born("\\py{1} then \\m{} end.", ["\\def\\m{\\py{3}}"]);
  check("born-deferred-macro", nfd(deferred.t) && /then Python item 2: Not run/.test(deferred.t) && keys(deferred.r).length === 1, deferred.t);
  // (a result-born \expandafter expanding a source macro that holds \py: the source macro's \py is not the source's)
  const xa = born("\\def\\s{\\py{9}}\\py{1} end.", ["\\expandafter\\relax\\s"]);
  check("born-expandafter-source-macro", nfd(xa.t) && keys(xa.r).length === 1, xa.t);
  // (\printpythontex from a result, or from a macro a result defined: not run; a block printing \printpythontex
  //  doesn't push itself again)
  const pp = born("\\begin{pyblock}\nx\n\\end{pyblock}\n\\printpythontex{} and \\pp{} end.", ["OUT\\printpythontex\\def\\pp{\\printpythontex}"]);
  check("born-printpythontex", (pp.t.match(/OUT/g) || []).length === 1 && nfd(pp.t, 2), pp.t);
  // (a generated \input of a file holding \py: its item is result-born)
  const files = new Map([["sub.tex", "\\py{7} from sub"]]);
  const inputs = { files, resolve: (n) => (files.has(n + ".tex") ? { key: n + ".tex" } : { why: "not found" }) };
  const src = doc("\\py{1} end.");
  const e = new Engine({ sage: { saved: saved(src, ["\\input{sub}"]) } });
  const gi = e.update(src, { cold: true, inputs });
  check("born-generated-input", nfd(text(gi)) && text(gi).includes("from sub") && gi.sageItems.length === 1, text(gi));
  // (\ifx sees a meaning a result set as the meaning it is: the taint is not part of it, daybreak3's pin)
  const ifx = born("\\py{1}\\ifx\\p\\relax YES\\else NO\\fi", ["\\let\\p\\relax "]);
  check("born-ifx-unchanged", ifx.t.includes("YES") && !ifx.t.includes("NO"), ifx.t);
}

// ---- the source's items (S) are the same, whatever the results: absent, valid, stale or changed
{
  const src = doc("\\py{1} a \\begin{pycode}\nprint(2)\n\\end{pycode} b \\py{3}");
  const base = keys(new Engine().update(src));
  const valid = show(src, ["\\py{8}\\py{9}", "\\begin{pycode}\nprint(0)\n\\end{pycode}", "x"]);
  const stale = new Engine({ sage: { saved: saved(src.replace("\\py{3}", "\\py{4}"), ["1", "2\n", "3"]) } }).update(src, { cold: true });
  const changed = show(src, ["\\def\\py#1{}", "\\catcode`\\%=12 ", "zz"]);
  check("s-fixed", [valid, stale, changed].every((r) => keys(r).join("|") === base.join("|")) && base.length === 3, [base, keys(valid), keys(stale), keys(changed)]);
}

// ---- astra's same-H collision (r3.1): a conditional first \py, an identical unconditional second, both at one H; a
// result changes the condition. Each saved value distinct: none is taken by the other; the whole H is refused
{
  const m = "\\def\\swa{a}\\def\\m{\\ifx\\sw\\swa \\py{next(it)}\\fi \\py{next(it)}}";
  const supp = doc(m + "\\def\\sw{a}\n\\py{0}\n\n\\m", "");
  const rs = show(supp, ["\\def\\sw{b}", "FIRST", "SECOND"]);
  check("same-h-suppress", !/FIRST|SECOND/.test(text(rs)) && text(rs).split(NOT_HERE).length - 1 === 1, text(rs));
  const rev = doc(m + "\\def\\sw{b}\n\\py{0}\n\n\\m", "");
  const rr = show(rev, ["\\def\\sw{a}", "SECOND"]);
  check("same-h-reveal", !/SECOND/.test(text(rr)) && text(rr).split(NOT_HERE).length - 1 === 2, text(rr));
  // (the same code in both branches of a flipped conditional: where it was read differs, so refused)
  const fl = doc("\\def\\swa{a}\\def\\sw{a}\\def\\m{\\ifx\\sw\\swa \\py{z}\\else \\py{z}\\fi}\n\\py{0}\n\n\\m");
  const rf = show(fl, ["\\def\\sw{b}", "THEN"]);
  check("same-h-branch-flip", !/THEN/.test(text(rf)) && text(rf).includes(NOT_HERE), text(rf));
  // (a loop whose count a result changed: no item takes a value it wasn't run for)
  const lp = doc("\\def\\lst{ab}\\def\\rep#1{\\ifx#1e\\else\\py{1}\\expandafter\\rep\\fi}\n\\py{0}\n\n\\expandafter\\rep\\lst e");
  const rl = show(lp, ["\\def\\lst{abc}", "L1", "L2"]);
  check("same-h-loop", !/L1|L2/.test(text(rl)), text(rl));
  // (two identical items with a result-made copy before them: the copy is not run, each keeps its own value)
  const two = doc("\\py{0} \\py{same} \\py{same}");
  const rt = show(two, ["\\py{same}", "ONE", "TWO"]);
  check("identical-with-copy", /Not run: this code comes from a result[^]*ONE[^]*TWO/.test(text(rt)), text(rt));
  // (a source item hidden by a result (a trailing macro eats it): S unchanged, no other item takes its value)
  const hid = doc("\\def\\eat#1{}\\py{0}\\py{a} \\py{b}");
  const rh = show(hid, ["\\eat", "AV", "BV"]);
  check("suppressed-source-item", !/AV/.test(text(rh)) && keys(rh).length === 3, text(rh));
}

// ---- a refusal re-runs the pass, and past 3 a fallback; only the last pass is shown (daybreak3, astra). \m#1 is B, then
// A if #1 is a; H0's result sets every switch to b; B's result at each \m sets the next one's switch back to a. So
// each pass refuses one more \m: B's result read back at a refused \m, taken back, changes the next
{
  const m = "\\def\\swa{a}\\def\\sa{a}\\def\\sb{a}\\def\\sc{a}\\def\\sd{a}\\def\\m#1{\\py{B}\\ifx#1\\swa \\py{A}\\fi}\n";
  const h0 = "\\def\\sa{b}\\def\\sb{b}\\def\\sc{b}\\def\\sd{b}";
  const one = doc(m + "\\py{0}\n\n\\m\\sa\n\n\\m\\sb\n\n");
  const r1 = show(one, [h0, "\\def\\sb{a}BB1", "a1", "BB2", "a2"]);
  check("rerun-later-h", r1.passes === 3 && !/BB|a1|a2/.test(text(r1)) && text(r1).split(NOT_HERE).length - 1 === 2, [r1.passes, text(r1)]);
  const four = doc(m + "\\py{0}\n\n\\m\\sa\n\n\\m\\sb\n\n\\m\\sc\n\n\\m\\sd\n\n");
  const r4 = show(four, [h0, "\\def\\sb{a}BB1", "a1", "\\def\\sc{a}BB2", "a2", "\\def\\sd{a}BB3", "a3", "BB4", "a4"]);
  const t4 = text(r4);
  check("rerun-cap-fallback", r4.passes === 4 && !/BB|a\d/.test(t4) && t4.split(NOT_EARLIER).length - 1 === 1 && t4.split(NOT_HERE).length - 1 === 3, [r4.passes, t4]);
}

// ---- stale results (Q3): read back faded, their TeX effects kept; the stale events can't be forged by a result
{
  const src = doc("\\py{1} then \\q{} and \\py{2}.");
  const old = src.replace("\\py{1}", "\\py{11}");
  const r = new Engine({ sage: { saved: saved(old, ["\\def\\q{QQ}OLD", "TWO"]) } }).update(src, { cold: true });
  const h = r.chunks.join("");
  check("stale-faded-defs-kept", /class="sagestale"[^>]*>OLD/.test(h) && text(r).includes("then QQ") && !/class="sagestale"[^>]*>[^<]*QQ/.test(h), h.slice(0, 600));
  // (a result naming the old marker macros, or a TeX error in it, doesn't end or leak the fade)
  const f = new Engine({ sage: { saved: saved(old, ["\\sb@staleend X\\textbf{Y", "TWO"]) } }).update(src, { cold: true });
  // (the fade covers the whole result, X and the bold Y it opened, and ends with it: " then" is not faded)
  const fh = f.chunks.join("");
  check("stale-unforgeable", /<span class="sagestale"[^>]*>(<span[^>]*>[^<]*<\/span>)?@staleend X<\/span><span class="b sagestale"[^>]*>Y<\/span><span class="b"> then/.test(fh), fh.slice(0, 600));
}

// ---- bounds: a result over MAX_RESULT is never read back (its error shown); the CLI's and the page's texts in KiB
{
  const src = doc("\\py{1}. \\begin{pycode}\nprint(1)\n\\end{pycode}");
  const big = "x".repeat(MAX_RESULT + 1);
  const r = show(src, [big, big]);
  check("over-max-result", !text(r).includes("xxxx") && text(r).includes("the result is over 16 KiB") && text(r).includes("the printed output is over 16 KiB"), text(r).slice(0, 300));
  const rc = readFileSync(new URL("./run-core.mjs", import.meta.url), "utf8"), cli = readFileSync(new URL("../../src/latex-cli.ts", import.meta.url), "utf8");
  // (the chunk's own copies of the cap and the UTF-8 size: sagetex.mjs's)
  const odd = ["a\u00e9\u4e2d\ud83d\ude00", "\ud800x", ""];
  check("chunk-cap-and-size-as-sagetex", pythontexCode.MAX_RESULT === MAX_RESULT && odd.every((s) => new TextEncoder().encode(s).length === utf8len(s)), odd.map(utf8len));
  check("caps-in-kib", [rc, cli].every((s) => s.includes("is over ${MAX_RESULT / 1024} KiB") && /SVG is over \$\{(RUN_LIMITS\.svg|SVG_MAX) \/ 2 \*\* 20\} MiB/.test(s)) && MAX_RESULT / 1024 === 16, null);
}

// ---- the results pass: one per results change; the same text and results don't expand again (ENGINE r1)
{
  const src = doc("\\py{1} x");
  const e = new Engine({ sage: { saved: saved(src, ["ONE"]) } });
  e.update(src); const a = e.rp; e.update(src); const b = e.rp;
  e.opts = { sage: { saved: saved(src, ["TWO"]) } }; const c = e.update(src);
  check("one-pass-per-results", a && a.res === b.res && e.rp.res !== a.res && text(c).includes("TWO"), [!!a, a?.res === b?.res]);
  // (the same results read back, a Sage item's saved value changed: not expanded again, but drawn with its new value
  //  (astra's PTX-CACHE-1); and a Sage item now failed shows its error)
  const mixed = doc("\\py{1} and $\\sage{2}$.");
  const m = new Engine({ sage: { saved: saved(mixed, ["PY", "OLD"]) } });
  const m1 = m.update(mixed), r1 = m.rp;
  m.opts = { sage: { saved: saved(mixed, ["PY", "NEW"]) } }; const m2 = m.update(mixed), r2 = m.rp;
  m.opts = { sage: { saved: saved(mixed, ["PY", { s: "error", msg: "boom" }]) } }; const m3 = m.update(mixed);
  check("cache-mixed-results", r1.res === r2.res && text(m1).includes("OLD") && text(m2).includes("NEW") && !text(m2).includes("OLD") && /boom/.test(text(m3)) && text(m3).includes("PY"), [text(m1), text(m2), text(m3)]);
  // (an edit above: the ids carried by the incremental source pass are those of a cold one)
  const ed = "\\def\\m{\\py{a}\\py{b}}" + "\n\nfiller\n".repeat(50);
  const s1 = doc(ed + "\\m\n\n\\m"), s2 = doc("New text.\n\n" + ed + "\\m\n\n\\m");
  const vals = ["A1", "B1", "A2", "B2"];
  const inc = new Engine({ sage: { saved: saved(s2, vals) } }); inc.update(s1); const ri = inc.update(s2);
  const cold = new Engine({ sage: { saved: saved(s2, vals) } }).update(s2, { cold: true });
  check("incremental-ids", ri.stats.mode !== "cold" && text(ri) === text(cold) && /A1 ?B1[^]*A2 ?B2/.test(text(ri)), [ri.stats.mode, text(ri).slice(-80), text(cold).slice(-80)]);
}

// ---- no preview execution: the engine never loads Run's code or a session
{
  const dir = new URL("./engine/", import.meta.url);
  const srcs = ["pipeline.mjs", "demo-machine.mjs", "render.mjs", "sagetex.mjs"].map((f) => readFileSync(new URL(f, dir), "utf8"));
  const imports = srcs.flatMap((s) => [...s.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]));
  check("no-preview-execution", imports.length > 0 && imports.every((f) => /^\.\/(incremental-demo|render|demo-machine|sagetex|symbols|shim)\.mjs$|^\.\.\/core\//.test(f)) && srcs.every((s) => !/\bsessionOf\(|\.execute\(/.test(s)), imports);
}

const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}: ${failed.join(", ")}` : `ok: PythonTeX step (a), ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
