// ci: checks.3 order=111 runner=bun
// (checks.3, after the job's final build-cli: the session part runs the driver in build/cli/pyjs.cjs --sage)
// Magma in LaTeX, a Sagebrush-only extension (William, Nov 10; the H6b design and plan r2): \magma{expr}, magmablock and
// magmasilent are code items in document order, run with Run in a Magma session of their own (magma's hook,
// __pyjs_compile_magma__), shown as the text Magma printed, never read as TeX. A document's own \magma, magmablock or
// magmasilent wins, and check says so, with the "Sagebrush only" notes for each name used.
//   node scripts/build-cli.mjs && bun web/latex/test-latex-magma.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine/pipeline.mjs";
import { itemKey, ONE_LINE, BLOCKED, whyRejected } from "./engine/sagetex.mjs";
import { setKatex } from "./engine/render.mjs";
import { checkResult } from "./check.ts";
import { driver, runnable, parseOutput, statesOf } from "./run-core.mjs";
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

// ---- the items: in document order, each its own mode and key, apart from SageTeX's and PythonTeX's
{
  const src = doc("A \\magma{2+3}.\n\\begin{magmablock}\nx := 7;\nx;\n\\end{magmablock}\n\\begin{magmasilent}\ny := 1;\n\\end{magmasilent}\nB $\\sage{2+3}$.");
  const its = S(src);
  check("items: \\magma, magmablock, magmasilent in document order, then \\sage", JSON.stringify(its.map((x) => x.mode)) === JSON.stringify(["magma", "magmablock", "magmasilent", "sage"]) && its[0].code === "2+3" && its[1].code === "x := 7;\nx;" && its[2].code === "y := 1;", its);
  check("items: a Magma and a Sage item with the same code have different keys", itemKey(its[0]) !== itemKey(its[3]), [itemKey(its[0]), itemKey(its[3])]);
  check("items: magmablock keeps its code to show", its[1].shown === "x := 7;\nx;" && its[2].shown === undefined, its);
}
// ---- \magma's argument: the \py form of refusals; an unterminated block's text names its own environment
{
  const cs = S(doc("A \\magma{\\foo + 1}."))[0], par = S(doc("A \\magma{1 +\n\n2}."))[0], un = S(doc("\\begin{magmablock}\nx := 1;"))[0];
  check("refusal: a TeX command inside \\magma{}", whyRejected(cs) === "this preview supports only plain Magma expressions inside \\magma{}: \\foo is a TeX command: not run", whyRejected(cs));
  check("refusal: a blank line inside \\magma{} (the % is TeX's, so \\py's words)", whyRejected(par) === "the argument runs past a blank line (a % starts a comment in TeX): not run", whyRejected(par));
  check("refusal: an unterminated magmablock says no \\end{magmablock}", whyRejected(un) === "no \\end{magmablock}: not run", whyRejected(un));
}
// ---- what is shown: the text Magma printed, as text (never TeX)
{
  const src = doc("A \\magma{2+3}. M $n = \\magma{n}$.\n\\begin{magmablock}\nM := Matrix(2, [1,2,3,4]);\nM;\n\\end{magmablock}\n\\begin{magmasilent}\nn := 7;\n\\end{magmasilent}\nTwo: \\magma{M}. Odd: \\magma{\"$x_1 & {y}\"}.");
  const r = show(src, ["5\n", "7\n", "[1 2]\n[3 4]\n", "", "[1 2]\n[3 4]\n", "$x_1 & {y}\n"]), h = html(r);
  check("show: \\magma{} inline, as Magma printed it, in monospace", h.includes('<code class="magmaout">5</code>'), h.slice(0, 600));
  check("show: magmablock's code, then what Magma printed, as text", h.includes('<pre class="verbatim code sageblock">M := Matrix(2, [1,2,3,4]);\nM;</pre><pre class="verbatim code magmaout">[1 2]\n[3 4]</pre>'), h);
  check("show: magmasilent shows nothing", !/y := 1|n := 7/.test(unesc(h.replace(/<[^>]+>/g, ""))), h);
  check("show: \\magma{} of a value printing on several lines is an error saying to use magmablock", unesc(h).includes("Magma item 5: error: " + ONE_LINE), h);
  check("show: Magma's text with TeX's specials stays text (no math, no command)", h.includes('<code class="magmaout">$x_1 &amp; {y}</code>'), h);
  check("show: \\magma{} in math is its text in monospace, TeX's specials escaped", h.includes("\\text{\\texttt{7}}"), h);
}
// ---- errors and blocked items: the chip names Magma
{
  const src = doc("\\begin{magmablock}\ny := 1/0;\n\\end{magmablock}\nThen \\magma{1}.");
  const h = unesc(html(show(src, [{ s: "error", msg: "\n>> y := 1/0;\nUser error: Illegal zero denominator\n" }, { s: "blocked", msg: BLOCKED }])));
  check("errors: a failed magmablock's box says Magma item n and what Magma printed", h.includes("Magma item 1: \n>> y := 1/0;\nUser error: Illegal zero denominator"), h.slice(0, 800));
  check("errors: the item after it says the stop rule's words", h.includes("Magma item 2: " + BLOCKED), h.slice(0, 800));
}
// ---- the document's own definition wins; check's notes
{
  const own = doc("A \\magma{x}.", "\\newcommand{\\magma}[1]{\\texttt{#1}}\n");
  check("own: a document's \\newcommand{\\magma} replaces ours (no item, no 'already defined')", S(own).length === 0 && !checked(own).problems.some((p) => /already defined/.test(p.message)), checked(own).problems);
  const env = doc("\\begin{magmablock}\nx\n\\end{magmablock}", "\\newenvironment{magmablock}{\\begin{quote}}{\\end{quote}}\n");
  check("own: a document's \\newenvironment{magmablock} replaces ours (no item)", S(env).length === 0, S(env));
  const notes = (pre) => checked(doc("A \\magma{1}.\n\\begin{magmablock}\n2;\n\\end{magmablock}\n\\begin{magmasilent}\n3;\n\\end{magmasilent}", pre)).problems.filter((p) => /own|Sagebrush/.test(p.message)).map((p) => p.message);
  const def = { magma: "\\newcommand{\\magma}[1]{#1}\n", magmablock: "\\newenvironment{magmablock}{}{}\n", magmasilent: "\\newenvironment{magmasilent}{}{}\n" };
  const own1 = (names) => notes(names.map((n) => def[n]).join(""));
  const cases = [
    [["magma"], "This document defines its own \\magma, so Sagebrush's \\magma{} is off here. magmablock and magmasilent still run Magma."],
    [["magmablock"], "This document defines its own magmablock environment, so Sagebrush's magmablock is off here. \\magma{} and magmasilent still run Magma."],
    [["magmasilent"], "This document defines its own magmasilent environment, so Sagebrush's magmasilent is off here. \\magma{} and magmablock still run Magma."],
    [["magma", "magmablock"], "This document defines its own magmablock environment, so Sagebrush's magmablock is off here. magmasilent still runs Magma."],
    [["magma", "magmasilent"], "This document defines its own magmasilent environment, so Sagebrush's magmasilent is off here. magmablock still runs Magma."],
    [["magmablock", "magmasilent"], "This document defines its own magmasilent environment, so Sagebrush's magmasilent is off here. \\magma{} still runs Magma."],
    [["magma", "magmablock", "magmasilent"], "This document defines its own magmasilent environment, so Sagebrush's magmasilent is off here."],
  ];
  for (const [names, last] of cases) {
    const m = own1(names);
    check(`check: ${names.join(" and ")} taken over: the last own note says which still run Magma (board's words)`, m.includes(last), m);
  }
  const used = notes("");
  check("check: each Magma name used says Sagebrush only, once, in board's words", JSON.stringify(used) === JSON.stringify([
    "Sagebrush only: real LaTeX reports \\magma as an undefined control sequence (no package defines it).",
    "Sagebrush only: real LaTeX reports environment magmablock as undefined (no package defines it).",
    "Sagebrush only: real LaTeX reports environment magmasilent as undefined (no package defines it).",
  ]), used);
  const c = checked(doc("A \\magma{1}. B \\sage{2}."));
  check("check: with a Magma item, items are counted as code items", c.problems.some((p) => /2 code items are not run yet/.test(p.message)), c.problems);
}

// ---- the session: the driver with Magma items, in the CLI's runtime (magma's hook installed there)
const CLI = new URL("../../build/cli/pyjs.cjs", import.meta.url).pathname;
if (!existsSync(CLI)) { console.log("FAIL: no build/cli/pyjs.cjs: run node scripts/build-cli.mjs first"); process.exit(1); }
const sage = (code) => new Promise((res) => {
  const dir = mkdtempSync(join(tmpdir(), "sb-latex-magma-")), f = join(dir, "run.sage");
  writeFileSync(f, code);
  const p = spawn("node", [CLI, "--sage", f], { cwd: dir });
  let o = "", e = "";
  p.stdout.on("data", (x) => (o += x)); p.stderr.on("data", (x) => (e += x));
  p.on("close", (c) => { rmSync(dir, { recursive: true, force: true }); res({ code: c, out: o, err: e }); });
});
const runOf = async (body, tail = "") => {
  const its = S(doc(body)).map((it) => ({ ...it, key: itemKey(it) }));
  const r = await sage(driver(runnable(its)) + tail);
  return { st: statesOf(its, parseOutput(r.out), ""), out: r.out, err: r.err };
};
{
  const a = await runOf("\\magma{2+3}\n\\begin{magmablock}\nR<x> := PolynomialRing(Integers());\nFactorization(x^2 - 1);\n\\end{magmablock}\n\\begin{magmasilent}\nn := 7;\n\\end{magmasilent}\n\\magma{n^2}\n\\sage{2+3}");
  check("session: \\magma{} prints its value", a.st[0].s === "ok" && a.st[0].latex === "5\n", a.st[0]);
  check("session: magmablock's printed text is its result", a.st[1].s === "ok" && /<x - 1, 1>/.test(a.st[1].latex) && /<x \+ 1, 1>/.test(a.st[1].latex), a.st[1]);
  check("session: state carries from item to item (n := 7, then n^2)", a.st[2].s === "ok" && a.st[3].s === "ok" && a.st[3].latex === "49\n", a.st.slice(2, 4));
  check("session: Magma's session is apart from Sage's (\\sage{2+3} is Sage's 5, as LaTeX)", a.st[4].s === "ok" && a.st[4].latex === "5", a.st[4]);
  const q = await runOf("\\begin{magmasilent}\nn := 3;\n\\end{magmasilent}\n\\begin{magmablock}\nquit;\n\\end{magmablock}\n\\magma{n}");
  check("session: quit; ends only its item, not a failure; the next still runs, values kept", q.st[1].s === "ok" && q.st[2].s === "ok" && q.st[2].latex === "3\n", q.st);
  const e = await runOf("\\begin{magmablock}\ny := 1/0;\n\\end{magmablock}\n\\magma{2}", "\nprint('LATER', len([1 for _ in [0]]))");
  check("session: a Magma runtime error is a failure, its message what Magma printed; the next item is blocked", e.st[0].s === "error" && e.st[0].msg.includes(">> y := 1/0;") && /error/.test(e.st[0].msg) && !/Traceback/.test(e.st[0].msg) && e.st[1].s === "blocked" && e.st[1].msg === BLOCKED, e.st);
  const sy = await runOf("\\begin{magmablock}\nx := ;\n\\end{magmablock}\n\\magma{2}");
  check("session: bad syntax is a failure (Magma's file form), the next item blocked", sy.st[0].s === "error" && /User error: bad syntax/.test(sy.st[0].msg) && !/sagebrush: bad syntax/.test(sy.st[0].msg) && sy.st[1].s === "blocked", sy.st);
  const un = await runOf("\\begin{magmablock}\nzz;\nprint 5;\n\\end{magmablock}");
  check("session: an undeclared identifier is reported and the block goes on (Magma's rule), not a failure", un.st[0].s === "ok" && /has not been declared/.test(un.st[0].latex) && /5/.test(un.st[0].latex), un.st);
  const fs = await runOf("\\begin{magmablock}\nSystem(\"ls\");\nprint 1;\n\\end{magmablock}", "\nimport os\nprint('MADE', os.path.exists('x.txt'))");
  check("session: a file or process call is refused by name and the item goes on; nothing is made", fs.st[0].s === "ok" && /not implemented in Sagebrush/.test(fs.st[0].latex) && /MADE False/.test(fs.out), fs.st);
  const ls = await runOf("\\begin{magmablock}\nload \"x.m\";\n\\end{magmablock}\n\\magma{1}");
  check("session: load stops its item (a failure); the next is blocked", ls.st[0].s === "error" && ls.st[1].s === "blocked", ls.st);
  const sx = await runOf("\\begin{sagesilent}\nimport sys\n\\end{sagesilent}\n\\sage{1}");
  check("session: Sage items run as before beside Magma's handling", sx.st.every((x) => x.s === "ok"), sx.st);
  // (a Sage item's SystemExit (sys.exit, raise SystemExit) is that item's failure, with its traceback, as in the CLI's session: the
  //  next item blocked, and the session itself goes on (the code after the driver still runs))
  for (const how of ["sys.exit(3)", "sys.exit(0)", "raise SystemExit"]) {
    const se = await runOf("\\begin{sagesilent}\nimport sys\n" + how + "\n\\end{sagesilent}\n\\sage{1}", "\nprint('LATER', 7)");
    check(`session: ${how} in a Sage item is its failure (a traceback naming SystemExit), the next item blocked; the session goes on`, se.st[0].s === "error" && /Traceback/.test(se.st[0].msg) && /SystemExit/.test(se.st[0].msg) && se.st[1].s === "blocked" && /LATER 7/.test(se.out), { st: se.st, err: se.err.slice(-400) });
  }
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}` : `ok: Magma in LaTeX, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
