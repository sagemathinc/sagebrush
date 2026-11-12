// ci: checks.3 order=112 runner=bun
// A Sage table() in a SageTeX document (sagetex.mjs sageTable): \sage{table(...)} outside math is a tabular, which
// KaTeX can't set, so it is drawn as the document's own tabular is, each cell's $…$ by KaTeX and its plain text as text,
// never through the TeX expander. Only that simple form; anything else is set as math, as before. And a labels slider
// (interact.ts) draws its labels, kept on the control for the values put back later.
//   bun web/latex/test-latex-sage-table.mjs
import { Engine } from "./engine/pipeline.mjs";
import { itemKey, sageTable } from "./engine/sagetex.mjs";
import { setKatex } from "./engine/render.mjs";
import { interactsHtml, apply } from "./interact.ts";
setKatex((src) => "<span class=\"katex\">" + src.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]) + "</span>");

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 900)); };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
const math = (s) => "[" + s + "]";
const unesc = (s) => s.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// what Sage's latex(table(rows, header_row=...)) is, from a run of the CLI's Sage
const SAGE = "\\begin{tabular}{lll}\n$p$ & $\\#E(\\mathbb{F}_p)$ & $a_p$ \\\\ \\hline\n$2$ & $5$ & $-2$ \\\\\n$3$ & $7$ & $-3$ \\\\\n\\end{tabular}";
{
  const h = sageTable(SAGE, esc, math);
  const rows = h?.match(/<tr[^>]*>/g) ?? [];
  check("Sage's table: a tabular of three rows, three cells each", h?.startsWith('<table class="tabular sagetable"><tbody>') && rows.length === 3 && (h.match(/<td /g) ?? []).length === 9, h);
  check("Sage's table: each cell's $…$ as math, in order", h?.includes('<td class="al-l">[p]</td><td class="al-l">[\\#E(\\mathbb{F}_p)]</td><td class="al-l">[a_p]</td>') && h.includes('<td class="al-l">[-3]</td>'), h);
  check("Sage's table: the rule under the header is the next row's top rule", rows[0] === "<tr>" && rows[1] === '<tr class="ht">' && rows[2] === "<tr>", rows);
}
{
  const framed = "\\begin{tabular}{|l|r|}\n\\hline\nmean of $x^{2k}$ & $\\frac{1}{4}$ \\\\ \\hline\n$4$ & $\\frac{1}{8}$ \\\\ \\hline\n\\end{tabular}";
  const h = sageTable(framed, esc, math);
  check("a framed table: its left rule, each column's right rule, a rule above each row and below the last", h?.startsWith('<table class="tabular sagetable bl">') && (h.match(/border-right/g) ?? []).length === 4
    && (h.match(/<tr class="ht"/g) ?? []).length === 2 && h.includes('border-bottom:1px solid currentColor') && h.includes('class="al-r"'), h);
  check("a cell of text and math: the text as text, the $…$ as math", h?.includes(">mean of [x^{2k}]</td>"), h);
  check("text is escaped (a & would be a cell break, as in TeX)", sageTable("\\begin{tabular}{l}\n<b>x</b> \\\\\n\\end{tabular}", esc, math)?.includes(">&lt;b&gt;x&lt;/b&gt;</td>"));
}
// the rules: each after its own column only, and the left one only before the first (a shift by one shows here)
{
  const cells = (h) => [...h.matchAll(/<td class="al-(.)"( style="border-right[^"]*")?>/g)].map((m) => m[1] + (m[2] ? "|" : ""));
  const a = sageTable("\\begin{tabular}{l|ll}\na & b & c \\\\\n\\end{tabular}", esc, math), b = sageTable("\\begin{tabular}{|l|l}\na & b \\\\\n\\end{tabular}", esc, math);
  check("rules: l|ll rules only after its first column, none at the left", !a.includes(" bl") && JSON.stringify(cells(a)) === JSON.stringify(["l|", "l", "l"]), cells(a));
  check("rules: |l|l a rule at the left and after the first column only", b.includes("sagetable bl") && JSON.stringify(cells(b)) === JSON.stringify(["l|", "l"]), cells(b));
}
// at most 500 rows: 500 drawn, 501 set as math
{
  const rows = (n) => "\\begin{tabular}{l}\n" + "$1$ \\\\\n".repeat(n) + "\\end{tabular}";
  check("500 rows: a table", (sageTable(rows(500), esc, math)?.match(/<tr/g) ?? []).length === 500);
  check("501 rows: set as math", sageTable(rows(501), esc, math) === null);
}
// anything but that simple form: null, so it is set as math, as before
for (const [what, l] of [
  ["not a table", "x^{2} + 1"],
  ["a macro in a text cell", "\\begin{tabular}{ll}\n\\textbf{a} & b \\\\\n\\end{tabular}"],
  ["braces in a text cell", "\\begin{tabular}{l}\n{a} \\\\\n\\end{tabular}"],
  ["an unclosed $", "\\begin{tabular}{l}\n$a \\\\\n\\end{tabular}"],
  ["more cells than columns", "\\begin{tabular}{l}\na & b \\\\\n\\end{tabular}"],
  ["a column spec beyond l, c, r and |", "\\begin{tabular}{p{2cm}}\na \\\\\n\\end{tabular}"],
  ["something after the table", SAGE + " x"],
  ["a spec of rules only, no column", "\\begin{tabular}{|}x\\end{tabular}"],
  ["a spec of rules only, with rows", "\\begin{tabular}{||}\na \\\\\n\\end{tabular}"],
]) check("refused, set as math: " + what, sageTable(l, esc, math) === null, sageTable(l, esc, math));

// in a document: \sage of a table outside math is the table; inside math, math as before (KaTeX's own error)
{
  const src = "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\nA table: \\sage{T}\n\nIn math: $\\sage{T}$\n\\end{document}\n";
  const items = new Engine().update(src).sageItems;
  const saved = items.map((it) => ({ key: itemKey(it), s: "ok", latex: SAGE }));
  const html = new Engine({ sage: { saved } }).update(src, { cold: true }).chunks.join("\n");
  check("in a document: outside math, the table", (html.match(/<table class="tabular sagetable">/g) ?? []).length === 1, html.slice(0, 600));
  check("in a document: inside math, set as math as before", html.includes("\\begin{tabular}{lll}"), html.slice(0, 900));
  // (a spec of rules only: set as math, the document drawn, nothing thrown)
  const bars = items.map((it) => ({ key: itemKey(it), s: "ok", latex: "\\begin{tabular}{|}x\\end{tabular}" }));
  let h2 = null; try { h2 = new Engine({ sage: { saved: bars } }).update(src, { cold: true }).chunks.join("\n"); } catch (e) { h2 = "threw: " + e; }
  check("in a document: a spec of rules only is set as math, nothing thrown", !h2.startsWith("threw") && !h2.includes("sagetable") && h2.includes("\\begin{tabular}{|}"), h2.slice(0, 600));
}

// a labels slider: its label shown, its labels kept on the control for a value put back later (apply, in a page)
{
  const h = interactsHtml([{ id: 1, controls: [{ kind: "slider", name: "bound", label: "bound", min: 0, max: 3, step: 1, value: 1, labels: [1000, 2000, 5000, 10000] }], out: "", shows: [] }]);
  check("a labels slider: its label shown, not its index", /<span class="si-v">2000<\/span>/.test(h), h);
  check("a labels slider: its labels kept on the control", h.includes('data-labels="[&quot;1000&quot;,&quot;2000&quot;,&quot;5000&quot;,&quot;10000&quot;]"'), h);
  // (a value put back, as after a Run, in Present's copy or as it moves: apply() shows the label for its index)
  const shown = { textContent: "" }, input = { value: "" };
  const control = { dataset: { name: "bound", kind: "slider", labels: JSON.stringify(["a", "b", "c"]) }, querySelectorAll: (q) => (q === "input" ? [input] : []), querySelector: (q) => (q === ".si-v" ? shown : null) };
  apply({ querySelectorAll: () => [control] }, { bound: 2 });
  check("a labels slider: a value put back shows its label, not its index", shown.textContent === "c" && input.value === "2", { shown, input });
  const many = interactsHtml([{ id: 3, controls: [{ kind: "slider", name: "n", min: 0, max: 1000, step: 1, value: 0, labels: Array.from({ length: 1001 }, (_, i) => i) }], out: "", shows: [] }]);
  const kept = JSON.parse(unesc(/data-labels="([^"]*)"/.exec(many)?.[1] ?? "[]"));
  check("a labels slider: at most 1,000 labels kept", kept.length === 1000 && kept[999] === "999", kept.length);
  const plain = interactsHtml([{ id: 2, controls: [{ kind: "slider", name: "k", min: 1, max: 5, step: 1, value: 2 }], out: "", shows: [] }]);
  check("a number slider: no labels kept", !plain.includes("data-labels") && /<span class="si-v">2<\/span>/.test(plain), plain);
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}` : `ok: a Sage table in LaTeX, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
