// ci: web-sync.4 order=21 runner=bun
// A document's dependencies (web/deps/document-deps.ts, work order 3a): a notebook's and a script's through fileDeps,
// a Markdown file's links, and LaTeX's \input/\include/\subfile (followed), \bibliography/\addbibresource,
// \includegraphics with \graphicspath, and the code in its sagetex/pythontex blocks; then documentDeps
// (deps-client.ts) through the real worker.
//   bun web/deps/test-document-deps.mjs
import { dependencies, docKindOf } from "./document-deps.ts";
import { documentDeps } from "./deps-client.ts";

let checks = 0;
const fails = [];
const ok = (cond, what) => {
  checks++;
  if (!cond) {
    fails.push(what);
    console.log("FAIL " + what);
  }
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} (wanted ${JSON.stringify(b)})`);

// A workspace { "/path": "text" }; a document in it; the deps as [path, via, certain, exists, from, why].
async function run(files, path, kind, extra = {}) {
  const meta = new Map(Object.keys(files).map((p) => [p, { size: files[p]?.length ?? 0 }]));
  const streamed = [];
  const r = await dependencies(path, files[path], kind, {
    files: meta,
    readFile: async (p) => {
      if (!(p in files) || files[p] === null) throw new Error("unreadable");
      return files[p];
    },
    builtinModules: new Set(["math", "sys", "os", "json"]),
    externalModules: new Set(["numpy", "pandas"]),
    onDep: (d) => streamed.push(d.path),
    ...extra,
  });
  return { ...r, rows: r.deps.map((d) => [d.path, d.via, d.certain, d.exists, d.from ?? null, d.why]), paths: r.deps.map((d) => d.path), streamed };
}
const nb = (cells, language = "python") =>
  JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: language === "sage" ? "sagemath" : "python3", language, display_name: language } },
    cells: cells.map((c) => (typeof c === "string" ? { cell_type: "code", source: c, metadata: {}, outputs: [], execution_count: null } : { cell_type: "markdown", source: c.md, metadata: {} })),
  });

// ---- kinds
eq(["a.ipynb", "b.PY", "c.sage", "d.m", "e.mag", "f.tex", "g.md", "h.txt", "i.board.json"].map(docKindOf), ["ipynb", "py", "sage", "m", "mag", "tex", "md", null, null], "docKindOf");

// ---- a notebook importing its helper, which opens a data file: the closure, with from and why
{
  const files = {
    "/proj/main.ipynb": nb([{ md: "# A tour\nSee [the data](data/table.csv)." }, "from _code import helpers\nimport numpy as np\n", "x = helpers.load()\n"]),
    "/proj/_code/__init__.py": "",
    "/proj/_code/helpers.py": "import json\ndef load():\n    return open('data/table.csv').read()\nT = open('/proj/data/other.csv')\n",
    "/proj/data/table.csv": "a,b\n",
    "/proj/data/other.csv": "c\n",
    "/proj/unrelated.py": "",
  };
  const r = await run(files, "/proj/main.ipynb", "ipynb");
  eq(r.rows, [
    ["/proj/data/table.csv", "link", true, true, null, "linked in the 1st cell"],
    ["/proj/_code/__init__.py", "import", true, true, null, "imported in the 2nd cell"],
    ["/proj/_code/helpers.py", "import", true, true, null, "imported in the 2nd cell"],
    ["/proj/data/other.csv", "open", true, true, "/proj/_code/helpers.py", "opened in _code/helpers.py"],
  ], "a notebook: its link, its helper package, and what the helper opens (by absolute path; the relative one is the link already)");
  ok(r.complete, "complete");
  eq(r.streamed, r.paths, "onDep streams the same deps, in the same order");
  ok(!r.paths.includes("/proj/unrelated.py") && !r.paths.includes("/proj/main.ipynb"), "nothing unrelated, never the document itself");
}

// ---- a Sage notebook: its cells are Sage (preparsed), so 2^3 doesn't break the parse
{
  const files = { "/s/nb.ipynb": nb(["x = 2^3\nimport helper\n"], "sage"), "/s/helper.py": "" };
  const r = await run(files, "/s/nb.ipynb", "ipynb");
  eq(r.paths, ["/s/helper.py"], "a Sage notebook's import");
}

// ---- a script: "# %%" cells are parts of one file
{
  const files = { "/w/main.py": "# %%\nimport util\n# %%\nd = open('in.txt').read()\n", "/w/util.py": "", "/w/in.txt": "" };
  const r = await run(files, "/w/main.py", "py");
  eq(r.rows.map((x) => [x[0], x[5]]), [["/w/util.py", "imported in main.py"], ["/w/in.txt", "opened in main.py"]], "a script's deps are named by the file");
}

// ---- a Markdown file's links
{
  const files = { "/d/README.md": "![plot](img/p.png) and [code](src/x.py) and [web](https://x.org/a.py)\n", "/d/img/p.png": "x", "/d/src/x.py": "" };
  const r = await run(files, "/d/README.md", "md");
  eq(r.paths, ["/d/img/p.png", "/d/src/x.py"], "Markdown: its local links, never a URL");
}

// ---- LaTeX
{
  const main = String.raw`\documentclass{article}
\usepackage{sagetex}
\graphicspath{{figs/}}
\input macros
\begin{document}
\input{chapters/intro}
% \input{secret}
\begin{verbatim}
\input{shown}
\end{verbatim}
\include{appendix}
\input{\dir/x}
\begin{sageblock}
import helper
T = open("data.csv").read()
\end{sageblock}
\begin{pycode}
open("table.csv")
\end{pycode}
\bibliography{refs,missing}
\addbibresource{more.bib}
\includegraphics[width=3cm]{logo}
\includegraphics{nowhere}
\end{document}
`;
  const files = {
    "/t/main.tex": main,
    "/t/macros.tex": "\\newcommand{\\R}{\\mathbb{R}}\n",
    "/t/chapters/intro.tex": "\\section{Intro}\n\\includegraphics{fig}\n\\input{chapters/deeper}\n",
    "/t/chapters/deeper.tex": "deep\n",
    "/t/appendix.tex": "\\chapter{A}\n",
    "/t/figs/fig.png": "x",
    "/t/logo.pdf": "x",
    "/t/refs.bib": "@book{}",
    "/t/more.bib": "@book{}",
    "/t/helper.py": "",
    "/t/data.csv": "",
    "/t/table.csv": "",
    "/t/secret.tex": "",
    "/t/shown.tex": "",
  };
  const r = await run(files, "/t/main.tex", "tex");
  eq(r.rows, [
    ["/t/macros.tex", "input", true, true, null, "\\input in main.tex"],
    ["/t/chapters/intro.tex", "input", true, true, null, "\\input in main.tex"],
    ["/t/figs/fig.png", "graphic", true, true, "/t/chapters/intro.tex", "\\includegraphics in chapters/intro.tex"],
    ["/t/chapters/deeper.tex", "input", true, true, "/t/chapters/intro.tex", "\\input in chapters/intro.tex"],
    ["/t/appendix.tex", "include", true, true, null, "\\include in main.tex"],
    ["/t/refs.bib", "bibliography", true, true, null, "\\bibliography in main.tex"],
    ["/t/missing.bib", "bibliography", false, false, null, "\\bibliography in main.tex (not found)"],
    ["/t/more.bib", "bibliography", true, true, null, "\\addbibresource in main.tex"],
    ["/t/logo.pdf", "graphic", true, true, null, "\\includegraphics in main.tex"],
    ["/t/nowhere", "graphic", false, false, null, "\\includegraphics in main.tex (not found)"],
    ["/t/helper.py", "import", true, true, null, "imported in main.tex"],
    ["/t/data.csv", "open", true, true, null, "opened in main.tex"],
    ["/t/table.csv", "open", true, true, null, "opened in main.tex"],
  ], "LaTeX, in TeX's order (an \\input file's references where it is read): \\input (braced, bare, nested, relative to the main file), \\include, the bibliography, pictures through \\graphicspath and .pdf, the code blocks' imports and opens");
  ok(!r.paths.includes("/t/secret.tex") && !r.paths.includes("/t/shown.tex"), "a commented \\input and one in verbatim are not followed");
  ok(r.unfollowed.some((u) => u.at === "main.tex" && /macro/.test(u.why) && u.line === 12), "a name made by a macro is unfollowed, with its line: " + JSON.stringify(r.unfollowed));
  ok(r.complete, "complete");
}

// ---- TeX's comments by the run of backslashes before the %: an even run (none, \\) starts one, an odd run (\%) is a
// percent sign (ENGINE, #731 a2af0f87)
{
  const main = String.raw`line\\% \input{even2}
50\% \input{odd1}
x\\\% \input{odd3}
y\\\\% \input{even4}
%\input{even0}
`;
  const files = { "/c/main.tex": main, "/c/even2.tex": "", "/c/odd1.tex": "", "/c/odd3.tex": "", "/c/even4.tex": "", "/c/even0.tex": "" };
  const r = await run(files, "/c/main.tex", "tex");
  eq(r.paths, ["/c/odd1.tex", "/c/odd3.tex"], "after %, \\\\% and \\\\\\\\% (even) a comment; after \\% and \\\\\\% (odd) a percent sign");
}

// ---- \graphicspath set in a followed \input file: for its pictures, and (TeX keeps it) for the main file's after it;
// a code block in a followed file: its deps come from that file (ENGINE, #731 a2af0f87)
{
  const main = String.raw`\documentclass{article}
\begin{document}
\includegraphics{a}
\input{part}
\includegraphics{b}
\end{document}
`;
  const part = String.raw`\graphicspath{{figs/}}
\includegraphics{x}
\begin{pycode}
import helper
\end{pycode}
`;
  const files = { "/t/main.tex": main, "/t/part.tex": part, "/t/figs/a.png": "x", "/t/figs/x.png": "x", "/t/figs/b.png": "x", "/t/helper.py": "" };
  const r = await run(files, "/t/main.tex", "tex");
  eq(r.rows, [
    ["/t/a", "graphic", false, false, null, "\\includegraphics in main.tex (not found)"],
    ["/t/part.tex", "input", true, true, null, "\\input in main.tex"],
    ["/t/figs/x.png", "graphic", true, true, "/t/part.tex", "\\includegraphics in part.tex"],
    ["/t/figs/b.png", "graphic", true, true, null, "\\includegraphics in main.tex"],
    ["/t/helper.py", "import", true, true, "/t/part.tex", "imported in part.tex"],
  ], "\\graphicspath from where it is set on (not before), across files; a followed file's code block has from");
  ok(r.complete, "complete");
}

// ---- an \input file that can't be read: listed, and complete false
{
  const files = { "/u/main.tex": "\\input{a}\n", "/u/a.tex": null };
  const r = await run(files, "/u/main.tex", "tex");
  eq(r.paths, ["/u/a.tex"], "the unreadable file is still listed");
  ok(!r.complete && r.unfollowed.some((u) => /couldn't be read/.test(u.why)), "complete false, and why");
}

// ---- not a notebook
{
  const r = await run({ "/x/bad.ipynb": "{not json" }, "/x/bad.ipynb", "ipynb");
  ok(!r.complete && r.deps.length === 0 && /notebook/.test(r.unfollowed[0]?.why ?? ""), "a broken .ipynb: nothing, complete false");
}

// ---- documentDeps, through the real worker: the same deps, streamed and resolved
{
  const files = {
    "/p/main.ipynb": nb(["import helper\n"]),
    "/p/helper.py": "x = open('d.csv')\n",
    "/p/d.csv": "",
  };
  const streamed = [];
  const run2 = documentDeps({
    path: "/p/main.ipynb",
    text: files["/p/main.ipynb"],
    kind: "ipynb",
    files: Object.keys(files).map((p) => [p, { size: files[p].length }]),
    readBytes: async (p) => new TextEncoder().encode(files[p]),
    createWorker: () => new Worker(new URL("./deps-worker.ts", import.meta.url).href),
    onDep: (d) => streamed.push(d.path),
  });
  const r = await run2.done;
  eq(r.deps.map((d) => [d.path, d.via, d.certain, d.from ?? null]), [["/p/helper.py", "import", true, null], ["/p/d.csv", "open", true, "/p/helper.py"]], "documentDeps: the closure through the worker");
  eq(streamed, ["/p/helper.py", "/p/d.csv"], "documentDeps streams onDep");
  ok(r.complete && !r.stopped, "documentDeps: complete");
}
// (a worker that can't start: resolved, complete false, never hanging)
{
  const r = await documentDeps({ path: "/a/b.md", text: "", kind: "md", files: [], readBytes: async () => new Uint8Array(), createWorker: () => { throw new Error("no"); } }).done;
  ok(!r.complete && r.stopped === "failed", "documentDeps: a worker that can't start resolves as failed");
}

console.log(`${checks - fails.length}/${checks} passed`);
if (fails.length) process.exit(1);
