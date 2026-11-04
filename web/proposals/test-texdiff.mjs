// bun web/proposals/test-texdiff.mjs — the rendered LaTeX diff's tokens, diff and marks
import { tokenize, diffTokens, texDiff } from "./texdiff.ts";
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const T = (s) => tokenize(s).map((t) => `${t.kind}:${t.t}`);

ok(tokenize("a b").map((t) => t.kind).join() === "word,space,word", "words and spaces");
ok(T("x $a+b$ y").includes("math:$a+b$"), "inline math is one token");
ok(T("\\section{Rank} x").includes("block:\\section{Rank}"), "a section with its argument is one block");
ok(T("\\begin{equation}a\\begin{equation}b\\end{equation}\\end{equation}z")[0] === "block:\\begin{equation}a\\begin{equation}b\\end{equation}\\end{equation}", "a nested environment is one block");
ok(T("\\textbf{bold words} x")[0] === "cmd:\\textbf{bold words}", "a command with its argument is one token");
ok(T("a\n\nb").includes("par:\n\n"), "a blank line is a paragraph break");
ok(tokenize("").length === 0 && tokenize("{unbalanced").length === 1, "empty and unbalanced inputs end");
const roundTrip = "Text $x^2$ \\cite{a} \\[ y \\] more %c\n\\begin{itemize}\\item a\\end{itemize}";
ok(tokenize(roundTrip).map((t) => t.t).join("") === roundTrip, "tokens put back together are the text");

const runs = diffTokens(tokenize("the quick fox"), tokenize("the slow fox"));
ok(runs.map((r) => r.op + r.toks.map((t) => t.t).join("")).join("|") === "=the |-quick|+slow|= fox", "one word replaced");
ok(diffTokens(tokenize("same"), tokenize("same")).length === 1, "no change, one run");

const doc = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
const d1 = texDiff(doc("The rank is hard."), doc("The rank $r$ is hard."));
ok(d1.source.includes("\\DIFadd{$r$ }") || d1.source.includes("\\DIFadd{ $r$}"), "an added inline math marked: " + JSON.stringify(d1.source.split("\\begin{document}")[1]));
ok(d1.source.includes("\\newcommand{\\DIFadd}") && d1.added === 1 && d1.removed === 0, "macros in the preamble; 1 added, 0 removed");
const d2 = texDiff(doc("A group."), doc("A group:\n\\begin{equation}E\\end{equation}"));
ok(d2.source.includes("[new:]") && d2.source.includes("\\begin{equation}E\\end{equation}"), "an added equation shown after a marker");
const d3 = texDiff(doc("A\n\\begin{equation}E\\end{equation}"), doc("A"));
ok(d3.source.includes("[removed: \\textbackslash{}begin\\{equation\\}E") && !d3.source.includes("\\begin{equation}E"), "a removed equation is named, not rendered");
ok(texDiff(doc("x"), doc("x")).added === 0, "the same document: nothing marked");

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
