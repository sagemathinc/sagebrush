// Notebook documents (web/notebook/types.ts NotebookDoc) to and from .ipynb
// (nbformat 4.5, with cell ids) and .py/.sage/.m files with "# %%" cells.

export const joinText = (t) => (Array.isArray(t) ? t.join("") : t ?? "");
const lines = (t) => t.split(/(?<=\n)/);

/** A new cell id: nbformat's [a-zA-Z0-9-_]{1,64}. */
export const cellId = () => (crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 12);
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id);

const KERNELSPEC = {
  python: { name: "python3", display_name: "Python 3", language: "python" },
  sage: { name: "sagemath", display_name: "SageMath", language: "sage" },
  magma: { name: "magma", display_name: "Magma", language: "magma" },
};
/** The mode a notebook's metadata says (its kernel). */
function modeOf(metadata) {
  const k = metadata?.kernelspec ?? {};
  const lang = `${k.name ?? ""} ${k.language ?? ""} ${metadata?.language_info?.name ?? ""}`;
  return /magma/i.test(lang) ? "magma" : /sage/i.test(lang) ? "sage" : "python";
}

/** The .ipynb text of a document.  What Sagebrush does not use (notebook and
 * cell metadata: widgets, tags, ...; raw cells) is written back as it was
 * read; the kernelspec is the original one unless the mode changed. */
export function toIpynb(doc) {
  const md = doc.metadata ?? {};
  const same = md.kernelspec && modeOf(md) === doc.mode;
  const metadata = {
    ...md,
    kernelspec: same ? md.kernelspec : KERNELSPEC[doc.mode] ?? KERNELSPEC.python,
    language_info: same && md.language_info ? md.language_info : { name: (KERNELSPEC[doc.mode] ?? KERNELSPEC.python).language },
  };
  const cell = (c) => {
    const base = { id: c.id, metadata: c.metadata ?? {}, source: lines(c.code) };
    if (c.type === "markdown") return { cell_type: "markdown", ...base, ...(c.attachments ? { attachments: c.attachments } : {}) };
    if (c.type === "raw") return { cell_type: "raw", ...base };
    return { cell_type: "code", ...base, execution_count: c.n == null ? null : +c.n, outputs: (c.outputs ?? []).map((o) => (o.output_type === "stream" ? { ...o, text: lines(joinText(o.text)) } : o)) };
  };
  return JSON.stringify({ cells: doc.cells.map(cell), metadata, nbformat: 4, nbformat_minor: Math.max(5, +doc.nbformat_minor || 0) }, null, 1);
}

/** A document from a file's name and text; `mode` for files that do not say (.py). */
export function fromFile(name, text, mode = "python") {
  const base = name.replace(/\.[^.]*$/, "");
  if (/\.ipynb$/i.test(name)) {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || !(Array.isArray(j.cells) || Array.isArray(j.worksheets))) throw new Error(`${name} is not a Jupyter notebook`);
    const cells = (j.cells ?? j.worksheets?.[0]?.cells ?? []).map((c) => {
      const src = joinText(c.source ?? c.input), id = validId(c.id) ? c.id : cellId();
      const metadata = c.metadata && Object.keys(c.metadata).length ? { metadata: c.metadata } : {};
      if (c.cell_type === "code") return { id, code: src, outputs: c.outputs ?? [], n: c.execution_count ?? c.prompt_number ?? null, ...metadata };
      if (c.cell_type === "markdown") return { id, type: "markdown", code: src, attachments: c.attachments ?? null, ...metadata };
      // nbformat 3's heading cells are Markdown headings
      if (c.cell_type === "heading") return { id, type: "markdown", code: "#".repeat(c.level ?? 1) + " " + src, ...metadata };
      return { id, type: "raw", code: src, ...metadata };
    });
    const extra = j.metadata && Object.keys(j.metadata).length ? { metadata: j.metadata } : {};
    return { name: base, mode: modeOf(j.metadata), cells, ...extra, ...(j.nbformat === 4 && j.nbformat_minor > 5 ? { nbformat_minor: j.nbformat_minor } : {}) };
  }
  // "# %%" starts a cell, "# %% [markdown]" a Markdown cell whose lines are comments (jupytext);
  // in Magma (.m), "// %%" and "//" comments
  const cells = [];
  let cur = { code: "" };
  for (const line of text.split("\n")) {
    const m = /^(?:#|\/\/) ?%%(.*)$/.exec(line);
    if (m) {
      if (cur.code.trim() || cells.length) cells.push(cur);
      cur = /\[markdown\]|\[md\]/.test(m[1]) ? { type: "markdown", code: "" } : /\[raw\]/.test(m[1]) ? { type: "raw", code: "" } : { code: "" };
    } else cur.code += (cur.type ? line.replace(/^(?:#|\/\/) ?/, "") : line) + "\n";
  }
  cells.push(cur);
  for (const c of cells) { c.code = c.code.replace(/\n+$/, "").replace(/^\n+/, ""); c.id = cellId(); }
  return { name: base, mode: /\.sage$/i.test(name) ? "sage" : /\.(m|mag)$/i.test(name) ? "magma" : mode, cells: cells.filter((c, i) => c.code || i === 0) };
}

/** The cells as a script: "# %%" cells, Markdown and raw cells as comments (jupytext's percent format). */
export function toScript(doc) {
  const cm = doc.mode === "magma" ? "//" : "#";
  const commented = (code) => code.split("\n").map((l) => (l ? cm + " " + l : cm)).join("\n");
  return doc.cells.map((c) => (c.type === "markdown" || c.type === "raw" ? `${cm} %% [${c.type}]\n` + commented(c.code) : cm + " %%\n" + c.code)).join("\n\n") + "\n";
}
