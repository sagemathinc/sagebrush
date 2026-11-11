// ci: checks.3 order=112 runner=bun
// MATLAB in LaTeX, a Sagebrush-only extension (William, Nov 10; the H6b design): \matlab{expr}, matlabblock and
// matlabsilent are code items in document order, shown as the text MATLAB printed, never read as TeX. A document's own
// \matlab, matlabblock or matlabsilent wins, and check says so, with the "Sagebrush only" notes for each name used.
// The same table as Magma's (sagetex.mjs extOf): this suite checks MATLAB's row and that the two languages' notes stay
// apart.
//   bun web/latex/test-latex-matlab.mjs
import { Engine } from "./engine/pipeline.mjs";
import { itemKey, oneLine, BLOCKED, whyRejected, isNonSage } from "./engine/sagetex.mjs";
import { setKatex } from "./engine/render.mjs";
import { checkResult } from "./check.ts";
setKatex((src) => "<span class=\"katex\">" + src.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]) + "</span>");

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 900)); };
const doc = (body, pre = "") => "\\documentclass{article}\n" + pre + "\\begin{document}\n" + body + "\n\\end{document}\n";
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const html = (r) => r.chunks.join("\n");
const S = (src) => new Engine().update(src).sageItems;
const saved = (src, vals) => S(src).map((it, k) => { const v = vals[k]; return v === undefined ? null : typeof v === "string" ? { key: itemKey(it), s: "ok", latex: v } : { key: itemKey(it), ...v }; }).filter(Boolean);
const show = (src, vals) => new Engine({ sage: { saved: saved(src, vals) } }).update(src, { cold: true });
const checked = (src, vals = []) => {
  const r = show(src, vals), st = saved(src, vals);
  return checkResult("m.tex", src, { outcome: String(r.stats.outcome), beamer: !!r.beamer, problems: r.problems, frames: r.frames, sage: r.sageItems.map((it, k) => ({ mode: String(it.mode), err: it.err ?? null, at: it.at ?? -1, ...(st[k] ? { s: st[k].s, msg: st[k].msg } : {}) })) }, []);
};

// ---- the items: in document order, each its own mode and key, apart from SageTeX's and Magma's
{
  const src = doc("A \\matlab{2+3}.\n\\begin{matlabblock}\nx = 7\ny = x^2;\n\\end{matlabblock}\n\\begin{matlabsilent}\nz = 1;\n\\end{matlabsilent}\nB \\magma{2+3} C $\\sage{2+3}$.");
  const its = S(src);
  check("items: \\matlab, matlabblock, matlabsilent in document order, then \\magma and \\sage", JSON.stringify(its.map((x) => x.mode)) === JSON.stringify(["matlab", "matlabblock", "matlabsilent", "magma", "sage"]) && its[0].code === "2+3" && its[1].code === "x = 7\ny = x^2;" && its[2].code === "z = 1;", its);
  check("items: a MATLAB, a Magma and a Sage item with the same code have different keys", new Set([itemKey(its[0]), itemKey(its[3]), itemKey(its[4])]).size === 3, its.map(itemKey));
  check("items: matlabblock keeps its code to show; matlabsilent doesn't", its[1].shown === "x = 7\ny = x^2;" && its[2].shown === undefined, its);
  check("items: MATLAB's are code items (counted with Python's and Magma's)", its.slice(0, 3).every(isNonSage), its.map(isNonSage));
}
// ---- \matlab's argument: the refusals, in MATLAB's words; an unterminated block's text names its own environment
{
  const cs = S(doc("A \\matlab{\\foo + 1}."))[0], par = S(doc("A \\matlab{1 +\n\n2}."))[0], un = S(doc("\\begin{matlabblock}\nx = 1;"))[0];
  check("refusal: a TeX command inside \\matlab{} (board's words, \\magma's form)", whyRejected(cs) === "this preview supports only plain MATLAB expressions inside \\matlab{}: \\foo is a TeX command: not run", whyRejected(cs));
  check("refusal: a blank line inside \\matlab{}", whyRejected(par) === "the argument runs past a blank line (a % starts a comment in TeX): not run", whyRejected(par));
  check("refusal: an unterminated matlabblock says no \\end{matlabblock}", whyRejected(un) === "no \\end{matlabblock}: not run", whyRejected(un));
}
// ---- what is shown: the text MATLAB printed, as text (never TeX)
{
  const src = doc("A \\matlab{2+3}. M $n = \\matlab{n}$.\n\\begin{matlabblock}\nM = magic(3)\n\\end{matlabblock}\n\\begin{matlabsilent}\nn = 7;\n\\end{matlabsilent}\nTwo: \\matlab{t}. Odd: \\matlab{s}.");
  const r = show(src, ["5\n", "7\n", "\nM =\n\n     8     1     6\n     3     5     7\n     4     9     2\n\n", "", "a\nb\n", "$x_1 & {y} % <b>\n"]), h = html(r);
  check("show: \\matlab{} inline, as MATLAB printed it, in monospace", h.includes('<code class="matlabout">5</code>'), h.slice(0, 600));
  check("show: matlabblock's code, then what MATLAB printed, as text", h.includes('<pre class="verbatim code sageblock">M = magic(3)</pre><pre class="verbatim code matlabout">\nM =\n\n     8     1     6\n     3     5     7\n     4     9     2\n</pre>'), h);
  check("show: matlabsilent shows nothing", !/n = 7/.test(unesc(h.replace(/<[^>]+>/g, ""))), h);
  check("show: \\matlab{} of a value printing on several lines is an error saying to use matlabblock (board's words)", unesc(h).includes("MATLAB item 5: error: " + oneLine("matlab")) && oneLine("matlab") === "\\matlab{} shows one line: this value prints on several. Use matlabblock.", h);
  check("show: MATLAB's text with TeX's and HTML's specials stays text", h.includes('<code class="matlabout">$x_1 &amp; {y} % &lt;b&gt;</code>'), h);
  check("show: \\matlab{} in math is its text in monospace, TeX's specials escaped", h.includes("\\text{\\texttt{7}}"), h);
}
// ---- errors and blocked items: the chip names MATLAB
{
  const src = doc("\\begin{matlabblock}\nerror('boom')\n\\end{matlabblock}\nThen \\matlab{1}.");
  const h = unesc(html(show(src, [{ s: "error", msg: "boom\n\nError in matlabblock 1 (line 1)\nerror('boom')\n" }, { s: "blocked", msg: BLOCKED }])));
  check("errors: a failed matlabblock's box says MATLAB item n and what MATLAB printed", h.includes("MATLAB item 1: boom\n\nError in matlabblock 1 (line 1)"), h.slice(0, 800));
  check("errors: the item after it says the stop rule's words", h.includes("MATLAB item 2: " + BLOCKED), h.slice(0, 800));
}
// ---- the document's own definition wins; check's notes, MATLAB's apart from Magma's
{
  const own = doc("A \\matlab{} B.", "\\newcommand{\\matlab}{MATLAB}\n");
  check("own: a document's \\newcommand{\\matlab} (the product's name, as many papers do) replaces ours: no item, no 'already defined'", S(own).length === 0 && !checked(own).problems.some((p) => /already defined/.test(p.message)), checked(own).problems);
  const env = doc("\\begin{matlabblock}\nx\n\\end{matlabblock}", "\\newenvironment{matlabblock}{\\begin{quote}}{\\end{quote}}\n");
  check("own: a document's \\newenvironment{matlabblock} replaces ours (no item)", S(env).length === 0, S(env));
  const notes = (pre, body = "A \\matlab{1}.\n\\begin{matlabblock}\n2\n\\end{matlabblock}\n\\begin{matlabsilent}\n3;\n\\end{matlabsilent}") => checked(doc(body, pre)).problems.filter((p) => /own|Sagebrush/.test(p.message)).map((p) => p.message);
  const def = { matlab: "\\newcommand{\\matlab}[1]{#1}\n", matlabblock: "\\newenvironment{matlabblock}{}{}\n", matlabsilent: "\\newenvironment{matlabsilent}{}{}\n" };
  const cases = [
    [["matlab"], "This document defines its own \\matlab, so Sagebrush's \\matlab{} is off here. matlabblock and matlabsilent still run MATLAB."],
    [["matlabblock"], "This document defines its own matlabblock environment, so Sagebrush's matlabblock is off here. \\matlab{} and matlabsilent still run MATLAB."],
    [["matlabsilent"], "This document defines its own matlabsilent environment, so Sagebrush's matlabsilent is off here. \\matlab{} and matlabblock still run MATLAB."],
    [["matlab", "matlabblock"], "This document defines its own matlabblock environment, so Sagebrush's matlabblock is off here. matlabsilent still runs MATLAB."],
    [["matlab", "matlabblock", "matlabsilent"], "This document defines its own matlabsilent environment, so Sagebrush's matlabsilent is off here."],
  ];
  for (const [names, last] of cases) {
    const m = notes(names.map((n) => def[n]).join(""));
    check(`check: ${names.join(" and ")} taken over: the last own note says which still run MATLAB (board's words)`, m.includes(last), m);
  }
  const used = notes("");
  check("check: each MATLAB name used says Sagebrush only, once, in board's words", JSON.stringify(used) === JSON.stringify([
    "Sagebrush only: real LaTeX reports \\matlab as an undefined control sequence (no package defines it).",
    "Sagebrush only: real LaTeX reports environment matlabblock as undefined (no package defines it).",
    "Sagebrush only: real LaTeX reports environment matlabsilent as undefined (no package defines it).",
  ]), used);
  const twice = notes("", "A \\matlab{1}. B \\matlab{2}.\n\\begin{matlabblock}\n3\n\\end{matlabblock}\n\\begin{matlabblock}\n4\n\\end{matlabblock}");
  check("check: a name used twice says Sagebrush only once", twice.length === 2, twice);
  // (both languages taken over in part: each language's own last note lists its own names still on, apart)
  const both = notes("\\newcommand{\\magma}[1]{#1}\n\\newcommand{\\matlab}[1]{#1}\n", "\\begin{magmablock}\n2;\n\\end{magmablock}\n\\begin{matlabblock}\n2\n\\end{matlabblock}");
  check("check: Magma and MATLAB both taken over in part: each says which of its own still run, apart",
    both.includes("This document defines its own \\magma, so Sagebrush's \\magma{} is off here. magmablock and magmasilent still run Magma.") && both.includes("This document defines its own \\matlab, so Sagebrush's \\matlab{} is off here. matlabblock and matlabsilent still run MATLAB."), both);
  const c = checked(doc("A \\matlab{1}. B \\sage{2}."));
  check("check: with a MATLAB item, items are counted as code items", c.problems.some((p) => /2 code items are not run yet/.test(p.message)), c.problems);
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}` : `ok: MATLAB in LaTeX, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
