// ci: checks.3 order=96
// The page "How Sagebrush's LaTeX differs from LaTeX" (articles/latex/02-how-it-differs.md) against the preview, through
// the CLI's own bundle (`sagebrush latex check|render`): every name its "Supported" table lists has a snippet here, and
// all of them together are checked with no command, environment, math or picture problem; every name its "Not
// supported" table lists has a snippet here that check reports (or, for BibTeX, that render shows its line). So the
// page can't claim a name that isn't tested, and a name that changes side fails here (William, Nov 9: the page says
// exactly what to expect, for people and agents).
//   node scripts/build-cli.mjs && node web/latex/test-latex-differences.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const CLI = new URL("../../build/cli/pyjs.cjs", import.meta.url).pathname;
if (!existsSync(CLI)) { console.log("FAIL: no build/cli/pyjs.cjs: run node scripts/build-cli.mjs first"); process.exit(1); }
const PAGE = readFileSync(new URL("../../articles/latex/02-how-it-differs.md", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "sb-latex-diff-"));
let fails = 0, checks = 0;
const ok = (c, what, detail) => { checks++; if (!c) { fails++; console.log("FAIL", what, JSON.stringify(detail ?? null).slice(0, 900)); } else console.log("ok  ", what); };
const latex = (...a) => { const r = spawnSync(process.execPath, [CLI, "latex", ...a], { cwd: dir, encoding: "utf8" }); let json = null; try { json = JSON.parse(r.stdout); } catch {} return { ...r, json }; };

// (a section's table rows: the backticked names in the first column, or in every column for "Supported")
const section = (title) => { const i = PAGE.indexOf("\n## " + title + "\n"); const j = PAGE.indexOf("\n## ", i + 4); return i < 0 ? "" : PAGE.slice(i, j < 0 ? undefined : j); };
const ticks = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const rows = (text) => text.split("\n").filter((l) => l.startsWith("| ") && !/^\|[-| ]+\|$/.test(l));

// ---- Supported: a snippet for every name (syntax and file names, not names, are in NOT_NAMES)
const NOT_NAMES = new Set(["$…$", "\\[…\\]", "[n]", "<2->", ".sty", ".tex", "../", "@interact"]);
const PRE = String.raw`\newtheorem{theorem}{Theorem}\newcounter{c}\newcommand{\mine}[1]{#1}\renewcommand{\mine}[1]{#1}\def\other{o}\newenvironment{env}{[}{]}\definecolor{dark}{rgb}{0,0,0}`;
const S = {
  "\\newcommand": "\\mine{a}", "\\renewcommand": "\\mine{b}", "\\def": "\\other", "\\newenvironment": "\\begin{env}x\\end{env}",
  "\\input": "\\input{part}", "\\include": "\\include{part}",
  "\\part": "\\part{P}", "\\subparagraph": "\\subparagraph{S}", "\\maketitle": "\\title{T}\\author{A}\\maketitle", "\\tableofcontents": "\\tableofcontents",
  abstract: "\\begin{abstract}x\\end{abstract}", "\\appendix": "\\appendix",
  "\\textbf": "\\textbf{x}", "\\textit": "\\textit{x}", "\\emph": "\\emph{x}", "\\texttt": "\\texttt{x}", "\\textsc": "\\textsc{x}", "\\underline": "\\underline{x}",
  "\\footnote": "\\footnote{x}\\footnote[7]{y}", "\\marginpar": "\\marginpar{x}", "\\verb": "\\verb|x|", verbatim: "\\begin{verbatim}\nx\n\\end{verbatim}",
  itemize: "\\begin{itemize}\\item x\\end{itemize}", enumerate: "\\begin{enumerate}\\item x\\end{enumerate}", description: "\\begin{description}\\item[a] x\\end{description}",
  equation: "\\begin{equation}x\\end{equation}", align: "\\begin{align}x&=1\\tag{A}\\\\\\intertext{and}y&=\\text{t}\\boxed{z}\\cancel{w}\\end{align}", gather: "\\begin{gather}x\\end{gather}",
  multline: "\\begin{multline}x\\\\y\\end{multline}", split: "\\[\\begin{split}x\\end{split}\\]", aligned: "\\[\\begin{aligned}x\\end{aligned}\\]", cases: "\\[\\begin{cases}x\\end{cases}\\]",
  alignat: "\\begin{alignat}{1}x\\end{alignat}", flalign: "\\begin{flalign}x\\end{flalign}",
  "\\tag": "", "\\intertext": "", "\\text": "", "\\boxed": "", "\\cancel": "",
  "\\DeclareMathOperator": "\\DeclareMathOperator{\\rk}{rk}$\\rk A$",
  "\\newtheorem": "\\begin{theorem}x\\end{theorem}", "\\theoremstyle": "\\theoremstyle{plain}", proof: "\\begin{proof}x\\end{proof}",
  "\\label": "\\section{L}\\label{l}", "\\ref": "\\ref{l}", "\\eqref": "\\eqref{l}", "\\pageref": "\\pageref{l}", "\\nameref": "\\nameref{l}", "\\autoref": "\\autoref{l}", "\\cref": "\\cref{l}", "\\Cref": "\\Cref{l}",
  figure: "\\begin{figure}x\\caption{c}\\end{figure}", table: "\\begin{table}x\\end{table}", "\\caption": "", "\\includegraphics": "\\includegraphics{img.png}",
  tabular: "\\begin{tabular}{ll}\\toprule a&b\\\\\\midrule\\multicolumn{2}{c}{x}\\\\\\cmidrule{1-2}\\hline\\cline{1-2}c&d\\\\\\bottomrule\\end{tabular}",
  tabularx: "\\begin{tabularx}{3cm}{X}x\\end{tabularx}", longtable: "\\begin{longtable}{l}x\\end{longtable}", array: "$\\begin{array}{l}x\\end{array}$",
  "\\multicolumn": "", "\\hline": "", "\\cline": "", "\\toprule": "", "\\midrule": "", "\\bottomrule": "", "\\cmidrule": "",
  "\\url": "\\url{https://example.org}", "\\href": "\\href{https://example.org}{x}", "\\hyperref": "\\hyperref[l]{x}", "\\textcolor": "\\textcolor{red}{x}", "\\color": "{\\color{red}x}",
  "\\colorbox": "\\colorbox{yellow}{x}", "\\definecolor": "\\textcolor{dark}{x}",
  lstlisting: "\\begin{lstlisting}\nx\n\\end{lstlisting}", minted: "\\begin{minted}{python}\nx\n\\end{minted}", Verbatim: "\\begin{Verbatim}\nx\n\\end{Verbatim}",
  "\\lstinline": "\\lstinline|x|",
  "\\cite": "\\cite{k}", "\\citet": "\\citet{k}", "\\citep": "\\citep{k}", thebibliography: "\\begin{thebibliography}{9}\\bibitem{k} K.\\end{thebibliography}", "\\bibitem": "",
  "\\sage": "\\sage{1+1}", "\\sageplot": "\\sageplot{plot(x)}", sageblock: "\\begin{sageblock}\n1\n\\end{sageblock}", sagesilent: "\\begin{sagesilent}\n1\n\\end{sagesilent}",
  "\\py": "\\py{1+1}", pycode: "\\begin{pycode}\nprint(1)\n\\end{pycode}", pyblock: "\\begin{pyblock}\nprint(2)\n\\end{pyblock}", "\\printpythontex": "\\printpythontex",
};
// (the classes, each a document of its own; beamer's names, in a beamer document)
const CLASSES = ["article", "report", "book", "amsart", "memoir", "beamer"];
const BEAMER = { frames: "", block: "\\begin{block}{B}x\\end{block}", columns: "\\begin{columns}\\begin{column}{.5\\textwidth}x\\end{column}\\end{columns}",
  "\\pause": "a\\pause b", "\\only": "\\only<2>{x}", "\\uncover": "\\uncover<2->{x}", "\\alt": "\\alt<2>{x}{y}" };

const sup = ticks(section("Supported")).filter((t) => !NOT_NAMES.has(t));
const missing = sup.filter((t) => !(t in S) && !CLASSES.includes(t) && !(t in BEAMER));
ok(sup.length > 80 && missing.length === 0, "Supported: every name the page lists has a snippet here", { n: sup.length, missing });
writeFileSync(join(dir, "part.tex"), "Part.\n");
writeFileSync(join(dir, "img.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
writeFileSync(join(dir, "sup.tex"), "\\documentclass{article}\n" + PRE + "\n\\begin{document}\n" + Object.values(S).filter(Boolean).join("\n\n") + "\n\\end{document}\n");
const sr = latex("check", "--json", "sup.tex");
const bad = (sr.json?.problems ?? []).filter((p) => ["command", "environment", "math", "not-rendered", "image", "input", "expansion"].includes(p.kind));
ok(sr.json && bad.length === 0, "Supported: the page's names, all together, checked with no problem the page would call unsupported", bad.slice(0, 8));
for (const cls of CLASSES) {
  const body = cls === "beamer" ? "\\begin{frame}{F}" + Object.values(BEAMER).filter(Boolean).join("\n") + "\\end{frame}" : "\\section{S}x";
  writeFileSync(join(dir, cls + ".tex"), "\\documentclass{" + cls + "}\n\\begin{document}\n" + body + "\n\\end{document}\n");
  const r = latex("check", "--json", cls + ".tex");
  ok(r.json && r.json.problems.length === 0, "Supported: the " + cls + " class" + (cls === "beamer" ? ", with a frame's block, columns and overlays" : ""), r.json?.problems?.slice(0, 5));
}

// ---- Not supported: a snippet for every name, each reported (by its name), or, for BibTeX, its line shown
const U = {
  "\\multirow": "\\multirow{2}{*}{x}", "\\addlinespace": "\\begin{tabular}{l}a\\\\\\addlinespace b\\end{tabular}", "\\footnotetext": "\\footnotetext{x}",
  "\\rotatebox": "\\rotatebox{90}{x}", "\\mintinline": "\\mintinline{python}|x|", "\\resizebox": "\\resizebox{1cm}{!}{x}", "\\scalebox": "\\scalebox{2}{x}", "\\reflectbox": "\\reflectbox{x}",
  "\\SI": "\\SI{3}{m}", "\\si": "\\si{m}", "\\num": "\\num{3}", "\\qty": "\\qty{3}{m}", "\\unit": "\\unit{m}", "\\ang": "\\ang{30}",
  "\\autocite": "\\autocite{k}", "\\textcite": "\\textcite{k}", "\\parencite": "\\parencite{k}", "\\footcite": "\\footcite{k}", "\\citeauthor": "\\citeauthor{k}", "\\citeyear": "\\citeyear{k}",
  "\\selectlanguage": "\\selectlanguage{french}", "\\foreignlanguage": "\\foreignlanguage{french}{x}", otherlanguage: "\\begin{otherlanguage}{french}x\\end{otherlanguage}", "\\enquote": "\\enquote{x}",
  subfigure: "\\begin{subfigure}{3cm}x\\end{subfigure}", subequations: "\\begin{subequations}\\begin{equation}x\\end{equation}\\end{subequations}",
  algorithm: "\\begin{algorithm}x\\end{algorithm}", algorithmic: "\\begin{algorithmic}x\\end{algorithmic}", tcolorbox: "\\begin{tcolorbox}x\\end{tcolorbox}",
  mdframed: "\\begin{mdframed}x\\end{mdframed}", framed: "\\begin{framed}x\\end{framed}", landscape: "\\begin{landscape}x\\end{landscape}",
  tikzpicture: "\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}",
};
const UNOT = new Set(["\\bibliography", ".bib", "\\cite", "\\usepackage"]);
const uns = rows(section("Not supported, and what you see instead")).flatMap((l) => ticks(l.split(" | ")[0])).filter((t) => !UNOT.has(t));
const umiss = uns.filter((t) => !(t in U));
ok(uns.length > 30 && umiss.length === 0, "Not supported: every name the page lists has a snippet here", { n: uns.length, umiss });
for (const [name, snip] of Object.entries(U)) {
  const f = "u-" + name.replace(/\W/g, "") + ".tex";
  writeFileSync(join(dir, f), "\\documentclass{article}\n\\begin{document}\n" + snip + "\n\\end{document}\n");
  const r = latex("check", "--json", f), nm = name.replace(/^\\/, "");
  ok(r.json?.problems?.some((p) => p.name === nm && ["command", "environment", "not-rendered"].includes(p.kind)), "Not supported: " + name + " reported by check", r.json?.problems);
}
writeFileSync(join(dir, "refs.bib"), "@article{knuth84, author = {D. Knuth}, title = {Literate Programming}, year = {1984}}\n");
writeFileSync(join(dir, "bib.tex"), "\\documentclass{article}\n\\begin{document}\n\\cite{knuth84}\n\\bibliography{refs}\n\\end{document}\n");
latex("render", "bib.tex", "-o", "bib.html");
const html = existsSync(join(dir, "bib.html")) ? readFileSync(join(dir, "bib.html"), "utf8") : "";
ok(html.includes("[bibliography from refs.bib: BibTeX is not run]") && /\[\s*knuth84\s*\]/.test(html.replace(/<[^>]+>/g, "")), "Not supported: BibTeX's line shown, and \\cite as the key in brackets, as the page says", html.length);
ok(PAGE.includes('"[bibliography from refs.bib: BibTeX is not run]"'), "the page quotes the BibTeX line as the preview shows it");

// ---- PythonTeX's indented code (@sagebrush's ruling, #978): dedented and run here, where PythonTeX stops; the page says so
{
  const DEDENT = "Code in `pycode` or `pyblock` that is indented as a whole (every line by the same amount) is dedented first and runs; real PythonTeX stops there with an IndentationError.";
  writeFileSync(join(dir, "ind.tex"), "\\documentclass{article}\n\\begin{document}\n\\begin{pycode}\n    x = 6\n    print(x * 7)\n\\end{pycode}\n\\begin{pyblock}\n  print('B')\n\\end{pyblock}\n\\end{document}\n");
  const r = latex("run", "--json", "ind.tex");
  ok(r.status === 0 && r.json?.items?.length === 2 && r.json.items.every((x) => x.state === "ok"), "PythonTeX: code indented as a whole in pycode and pyblock is dedented and runs", r.json ?? r.stderr?.slice(-400));
  ok(section("PythonTeX").replace(/\s+/g, " ").includes(DEDENT), "the page says so, in these words", null);
}

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `FAIL: ${fails} of ${checks}` : `ok: the differences page against the preview, ${checks} checks`);
process.exit(fails ? 1 : 0);
