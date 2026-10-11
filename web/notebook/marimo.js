// marimo's notebook format (a .py file: one function per cell, decorated with
// @app.cell; github.com/marimo-team/marimo, Apache-2.0), so that marimo
// notebooks open here and these open in marimo (design/reactive-notebook.md).
//
//   import marimo
//   app = marimo.App()
//
//   @app.cell
//   def _(mo):
//       mo.md(r"""# Title""")
//       return
//
// fromMarimo reads the files marimo writes (and test/marimo_format_oracle.py
// checks it against marimo's own parser): a cell's code is its function's
// body, dedented, without the final `return`; a cell that is only mo.md(...)
// is a Markdown cell; `with app.setup:` and @app.function / @app.class_definition
// cells are code cells.  toMarimo writes one, each cell's arguments and
// return values being the names it reads and defines (as marimo writes them).

/** Whether a .py file's text is a marimo notebook. */
export const isMarimo = (text) => /^\s*app\s*=\s*marimo\.App\(/m.test(text) && /^@app\.(cell|function|class_definition)\b|^with app\.setup\b/m.test(text);

const indentOf = (l) => /^[ \t]*/.exec(l)[0].length;
function dedent(lines) {
  const ind = Math.min(...lines.filter((l) => l.trim()).map(indentOf));
  return lines.map((l) => (l.trim() ? l.slice(Number.isFinite(ind) ? ind : 0) : ""));
}
const trimBlank = (lines) => {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};
// the index where a function's signature ends (the line ending its "):" or ") -> ...:")
function signatureEnd(lines, i) {
  let depth = 0;
  for (let j = i; j < lines.length; j++) {
    for (const ch of lines[j].replace(/#.*$/, "")) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
    }
    if (depth <= 0 && /:\s*(#.*)?$/.test(lines[j])) return j;
  }
  return i;
}
// a Markdown cell: only mo.md("""...""") (r, f prefixes), its text dedented
function markdownOf(code) {
  const m = /^mo\.md\(\s*([rRfF]{0,2})("""|''')([\s\S]*)\2\s*,?\s*\)$/.exec(code.trim()) ?? /^mo\.md\(\s*([rRfF]{0,2})(["'])((?:\\.|(?!\2)[^\\\n])*)\2\s*\)$/.exec(code.trim());
  if (!m || /f/i.test(m[1])) return null;
  let text = m[3];
  if (!/r/i.test(m[1])) text = text.replace(/\\(["'\\])/g, "$1");
  const lines = text.split("\n");
  // (marimo indents the lines after the first)
  const rest = dedent(lines.slice(1));
  return trimBlank([lines[0], ...rest]).join("\n");
}

/** A document ({name, mode, cells}) from a marimo notebook's text. */
export function fromMarimo(name, text, newId, { keepMo = false } = {}) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cells = [];
  // the body of a top-level block: the indented lines after line i
  const body = (i) => {
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || /^[ \t]/.test(lines[j]))) j++;
    return [lines.slice(i + 1, j), j];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^with app\.setup\b.*:\s*(#.*)?$/.test(l)) {
      const [b, j] = body(i);
      cells.push({ id: newId(), code: trimBlank(dedent(b)).join("\n") });
      i = j - 1;
    } else if (/^@app\.cell\b/.test(l)) {
      let k = i + 1;
      while (k < lines.length && /^@/.test(lines[k])) k++;
      const end = signatureEnd(lines, k);
      const [b, j] = body(end);
      let code = trimBlank(b);
      // the final return (marimo writes the cell's definitions there)
      const top = code.length ? indentOf(code.find((x) => x.trim())) : 0;
      for (let r = code.length - 1; r >= 0; r--) {
        // (the last statement at the body's level; a multi-line `return (...)` ends with its bracket)
        if (code[r].trim() && indentOf(code[r]) === top && !/^\s*[)\]}]/.test(code[r])) {
          if (/^\s*return\b/.test(code[r])) code = code.slice(0, r);
          break;
        }
      }
      const src = trimBlank(dedent(code)).join("\n");
      const md = markdownOf(src);
      cells.push(md !== null ? { id: newId(), type: "markdown", code: md } : { id: newId(), code: src });
      i = j - 1;
    } else if (/^@app\.(function|class_definition)\b/.test(l)) {
      // the definition itself, without the decorator
      let k = i + 1;
      const [b, j] = body(signatureEnd(lines, k));
      cells.push({ id: newId(), code: trimBlank([...lines.slice(k, signatureEnd(lines, k) + 1), ...b]).join("\n") });
      i = j - 1;
    }
  }
  // the notebook's own `import marimo as mo` cell, when Markdown cells were its only readers, is not needed here
  const usesMo = cells.some((c) => c.type !== "markdown" && /\bmo\./.test(c.code));
  const out = usesMo || keepMo ? cells : cells.filter((c) => !(c.type !== "markdown" && /^import marimo as mo$/.test(c.code.trim())));
  return { name: name.replace(/\.[^.]*$/, ""), mode: "python", cells: out.length ? out : [{ id: newId(), code: "" }] };
}

/**
 * A marimo notebook's text from a document.  `analysis(code)`: {defs, refs}
 * (Sets) of a code cell, for its arguments and return values; Markdown cells
 * become mo.md(...), with an `import marimo as mo` cell if none defines mo.
 */
export function toMarimo(doc, analysis = () => null) {
  const code = doc.cells.filter((c) => c.type !== "raw");
  const defined = new Set();
  const an = code.map((c) => (c.type === "markdown" ? { defs: new Set(), refs: new Set(["mo"]) } : analysis(c.code) ?? { defs: new Set(), refs: new Set() }));
  for (const a of an) for (const d of a.defs) defined.add(d);
  const needMo = code.some((c) => c.type === "markdown") && !defined.has("mo");
  if (needMo) defined.add("mo");
  const fn = (c, a) => {
    const args = [...a.refs].filter((n) => defined.has(n) && !a.defs.has(n)).sort();
    const rets = [...a.defs].filter((n) => !n.startsWith("_")).sort();
    const src = c.type === "markdown" ? `mo.md(r"""\n${c.code.replace(/"""/g, '\\"\\"\\"')}\n""")` : c.code;
    const bodyLines = src.trim() ? src.split("\n").map((l) => (l ? "    " + l : "")) : ["    pass"];
    const ret = rets.length ? `    return (${rets.join(", ")},)` : "    return";
    return `@app.cell\ndef _(${args.join(", ")}):\n${bodyLines.join("\n")}\n${ret}`;
  };
  const parts = ["import marimo", "", '__generated_with = "0.25.1"', "app = marimo.App()", ""];
  if (needMo) parts.push("", "@app.cell\ndef _():\n    import marimo as mo\n    return (mo,)", "");
  code.forEach((c, i) => parts.push("", fn(c, an[i]), ""));
  parts.push("", 'if __name__ == "__main__":', "    app.run()", "");
  return parts.join("\n");
}
