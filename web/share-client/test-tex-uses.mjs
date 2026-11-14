// ci: checks.3 order=63 runner=bun
// What a LaTeX document uses, for its Share… (web/share-client/tex-uses.ts): the files its commands name, with the
// extensions a name without one may have; the files its code names, and what the named modules name in turn; and the
// boundary: a name that leaves the document's folder (absolute, "..", "\", "~") is never followed, only reported, and
// nothing outside the files given is ever offered.
//   bun web/share-client/test-tex-uses.mjs
import { texRefs, texUses, safeRel } from "./tex-uses.ts";

let n = 0;
const fails = [];
const check = (ok, what) => { n++; if (!ok) fails.push(what); };
const J = JSON.stringify;
const same = (a, b) => J([...a].sort()) === J([...b].sort());

// (the boundary)
for (const bad of ["/etc/passwd", "../secret.tex", "a/../../b.tex", "~/x.tex", "a\\b.tex", "", "./", "a//b"]) check(safeRel(bad) === null, "safeRel refuses " + J(bad));
for (const [ok, want] of [["fig.png", "fig.png"], ["./img/a.pdf", "img/a.pdf"], ["chapters/one", "chapters/one"]]) check(safeRel(ok) === want, `safeRel(${J(ok)}) = ${J(want)}`);

// (the commands)
const TEX = String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
\input{intro}
\include{chapters/two.tex}
\includegraphics[width=3cm]{img/plot}
\includegraphics{../outside.png}
\bibliography{refs,more}
% \input{commented}
\verb|\%| \input{after-percent}
\inputminted{python}{code/demo.py}
\begin{sagesilent}
from helper import v
data = load("data/points.csv")
\end{sagesilent}
\end{document}`;
const r = texRefs(TEX);
check(J(r.outside) === J(["../outside.png"]), "texRefs: a name leaving the folder is reported, not followed: " + J(r.outside));
const flat = r.paths.map((p) => p[0]);
check(same(flat, ["intro", "chapters/two.tex", "img/plot", "refs", "more", "after-percent", "code/demo.py"]), "texRefs: each command's file, the comment's not: " + J(flat));
check(J(r.paths.find((p) => p[0] === "img/plot")) === J(["img/plot", "img/plot.pdf", "img/plot.png", "img/plot.jpg", "img/plot.jpeg", "img/plot.svg", "img/plot.eps"]), "texRefs: a picture without an extension may be any of them");
check(J(r.paths.find((p) => p[0] === "refs")) === J(["refs", "refs.bib"]), "texRefs: a bibliography is a .bib");

// (the files: what the commands and the code name, transitively through a module, and nothing else)
const FILES = {
  "intro.tex": "Hello", "chapters/two.tex": "Two", "img/plot.png": "", "refs.bib": "", "code/demo.py": "",
  "helper.py": "import util\n", "util.py": "x = 1\n", "data/points.csv": "1,2\n",
  "unused.tex": "", "notes.txt": "", "after-percent.tex": "",
};
const read = async (rel) => (rel in FILES ? FILES[rel] : null);
const got = await texUses(TEX, Object.keys(FILES), read);
check(same(got.uses, ["intro.tex", "chapters/two.tex", "img/plot.png", "refs.bib", "code/demo.py", "helper.py", "util.py", "data/points.csv", "after-percent.tex"]), "texUses: the commands' files, the code's module and its own import, the quoted data file: " + J([...got.uses]));
check(!got.uses.has("unused.tex") && !got.uses.has("notes.txt"), "texUses: a file nothing names isn't used");
check(got.outside.includes("../outside.png"), "texUses: the outside name reported");
// (a quoted path that leaves the folder, in a module: reported, never listed)
const got2 = await texUses(String.raw`\begin{sagesilent}
open("/etc/hosts.txt")
open("../up.csv")
\end{sagesilent}`, ["a.csv"], read);
check(got2.uses.size === 0 && got2.outside.includes("/etc/hosts.txt") && got2.outside.includes("../up.csv"), "texUses: code naming files outside: reported, nothing used: " + J({ uses: [...got2.uses], outside: got2.outside }));
// (only the files given: a name with no such file is nothing)
const got3 = await texUses(String.raw`\input{missing}`, ["other.tex"], read);
check(got3.uses.size === 0, "texUses: a name with no file there gives nothing");

if (fails.length) { for (const f of fails) console.log("FAIL " + f); process.exit(1); }
console.log(`${n}/${n} passed`);
