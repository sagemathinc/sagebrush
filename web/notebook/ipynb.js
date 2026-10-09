// Notebook documents (web/notebook/types.ts NotebookDoc) to and from .ipynb
// (nbformat 4.5, with cell ids) and .py/.sage/.m files with "# %%" cells.

export const joinText = (t) => (Array.isArray(t) ? t.join("") : t ?? "");
const lines = (t) => t.split(/(?<=\n)/);

/** A new cell id: nbformat's [a-zA-Z0-9-_]{1,64}. */
export const cellId = () => (crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 12);
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id);

export function toIpynb(doc) {
  const sage = doc.mode === "sage", magma = doc.mode === "magma";
  return JSON.stringify({
    cells: doc.cells.map((c) => (c.type === "markdown"
      ? { cell_type: "markdown", id: c.id, metadata: {}, source: lines(c.code), ...(c.attachments ? { attachments: c.attachments } : {}) }
      : { cell_type: "code", id: c.id, execution_count: c.n == null ? null : +c.n, metadata: {}, source: lines(c.code), outputs: (c.outputs ?? []).map((o) => (o.output_type === "stream" ? { ...o, text: lines(o.text) } : o)) })),
    metadata: { kernelspec: magma ? { name: "magma", display_name: "Magma", language: "magma" } : sage ? { name: "sagemath", display_name: "SageMath", language: "sage" } : { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: magma ? "magma" : sage ? "sage" : "python" } },
    nbformat: 4, nbformat_minor: 5,
  }, null, 1);
}

/** A document from a file's name and text; `mode` for files that do not say (.py). */
export function fromFile(name, text, mode = "python") {
  const base = name.replace(/\.[^.]*$/, "");
  if (/\.ipynb$/i.test(name)) {
    const j = JSON.parse(text);
    const k = j.metadata?.kernelspec ?? {};
    const lang = `${k.name ?? ""} ${k.language ?? ""} ${j.metadata?.language_info?.name ?? ""}`;
    const cells = (j.cells ?? j.worksheets?.[0]?.cells ?? []).map((c) => {
      const src = joinText(c.source ?? c.input), id = validId(c.id) ? c.id : cellId();
      if (c.cell_type === "code") return { id, code: src, outputs: c.outputs ?? [], n: c.execution_count ?? null };
      if (c.cell_type === "markdown") return { id, type: "markdown", code: src, attachments: c.attachments ?? null };
      // raw cells become comments
      return { id, code: src.split("\n").map((l) => (l ? "# " + l : "#")).join("\n") };
    });
    return { name: base, mode: /magma/i.test(lang) ? "magma" : /sage/i.test(lang) ? "sage" : "python", cells };
  }
  // "# %%" starts a cell, "# %% [markdown]" a Markdown cell whose lines are comments (jupytext);
  // in Magma (.m), "// %%" and "//" comments
  const cells = [];
  let cur = { code: "" };
  for (const line of text.split("\n")) {
    const m = /^(?:#|\/\/) ?%%(.*)$/.exec(line);
    if (m) {
      if (cur.code.trim() || cells.length) cells.push(cur);
      cur = /\[markdown\]|\[md\]/.test(m[1]) ? { type: "markdown", code: "" } : { code: "" };
    } else cur.code += (cur.type === "markdown" ? line.replace(/^(?:#|\/\/) ?/, "") : line) + "\n";
  }
  cells.push(cur);
  for (const c of cells) { c.code = c.code.replace(/\n+$/, "").replace(/^\n+/, ""); c.id = cellId(); }
  return { name: base, mode: /\.sage$/i.test(name) ? "sage" : /\.(m|mag)$/i.test(name) ? "magma" : mode, cells: cells.filter((c, i) => c.code || i === 0) };
}

/** The cells as a script: "# %%" cells, Markdown as comments (jupytext's percent format). */
export function toScript(doc) {
  const cm = doc.mode === "magma" ? "//" : "#";
  return doc.cells.map((c) => (c.type === "markdown" ? cm + " %% [markdown]\n" + c.code.split("\n").map((l) => (l ? cm + " " + l : cm)).join("\n") : cm + " %%\n" + c.code)).join("\n\n") + "\n";
}
