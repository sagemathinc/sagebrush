// Notebook documents (web/notebook/types.ts NotebookDoc) to and from .ipynb
// (nbformat 4.5, with cell ids) and .py/.sage/.m files with "# %%" cells
// (MATLAB's own "%%" sections in a MATLAB .m file).

import { isMarimo, fromMarimo } from "./marimo.js";
import { looksLikeMagma } from "../../src/m-file.ts";
export const joinText = (t) => (Array.isArray(t) ? t.join("") : t ?? "");
const lines = (t) => t.split(/(?<=\n)/);

/** A new cell id: nbformat's [a-zA-Z0-9-_]{1,64}. */
export const cellId = () => (crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 12);
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id);

const KERNELSPEC = {
  python: { name: "python3", display_name: "Python 3", language: "python" },
  sage: { name: "sagemath", display_name: "SageMath", language: "sage" },
  magma: { name: "magma", display_name: "Magma", language: "magma" },
  matlab: { name: "matlab", display_name: "MATLAB", language: "matlab" },
};
/** The mode a notebook's metadata says (its kernel). */
function modeOf(metadata) {
  const k = metadata?.kernelspec ?? {};
  const lang = `${k.name ?? ""} ${k.language ?? ""} ${metadata?.language_info?.name ?? ""}`;
  // (MATLAB: the MathWorks kernel's notebooks too, jupyter_matlab_kernel, and Octave's)
  return /magma/i.test(lang) ? "magma" : /matlab|octave/i.test(lang) ? "matlab" : /sage/i.test(lang) ? "sage" : "python";
}

/** The .ipynb text of a document.  What Sagebrush does not use (notebook and
 * cell metadata: widgets, tags, ...; raw cells) is written back as it was
 * read; the kernelspec is the original one unless the mode changed. */
export function toIpynb(doc) {
  return JSON.stringify(ipynbObject(doc), null, 1);
}

/** The .ipynb's JSON value, which toIpynb writes with one space of indent.  `toLines` makes a text (a string, or
 * an array of strings joined) into its list of lines: the export (web/workspace/export/stream.ts) passes one that
 * splits lazily, as it writes, so that a large output never splits in one piece of work. */
export function ipynbObject(doc, toLines = (t) => lines(joinText(t))) {
  const md = doc.metadata ?? {};
  const same = md.kernelspec && modeOf(md) === doc.mode;
  const metadata = {
    ...md,
    kernelspec: same ? md.kernelspec : KERNELSPEC[doc.mode] ?? KERNELSPEC.python,
    language_info: same && md.language_info ? md.language_info : { name: (KERNELSPEC[doc.mode] ?? KERNELSPEC.python).language },
  };
  const cell = (c) => {
    const base = { id: c.id, metadata: c.metadata ?? {}, source: toLines(c.code) };
    if (c.type === "markdown") return { cell_type: "markdown", ...base, ...(c.attachments ? { attachments: c.attachments } : {}) };
    if (c.type === "raw") return { cell_type: "raw", ...base };
    // (its last run time, in Sagebrush's namespace of the cell's metadata)
    if (c.ms != null) base.metadata = { ...base.metadata, sagebrush: { ...(base.metadata.sagebrush ?? {}), ms: c.ms } };
    return { cell_type: "code", ...base, execution_count: c.n == null ? null : +c.n, outputs: (c.outputs ?? []).map((o) => (o.output_type === "stream" ? { ...o, text: toLines(o.text) } : o)) };
  };
  return { cells: doc.cells.map(cell), metadata, nbformat: 4, nbformat_minor: Math.max(5, +doc.nbformat_minor || 0) };
}

/** A document from a file's name and text; `mode` for files that do not say (.py). */
export function fromFile(name, text, mode = "python") {
  const base = name.replace(/\.[^.]*$/, "");
  if (/\.ipynb$/i.test(name)) {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || !(Array.isArray(j.cells) || Array.isArray(j.worksheets))) throw new Error(`${name} is not a Jupyter notebook`);
    // nbformat 3: the cells of every worksheet, in order (not only the first)
    const cells = (j.cells ?? (j.worksheets ?? []).flatMap((w) => w?.cells ?? [])).map((c) => {
      const src = joinText(c.source ?? c.input), id = validId(c.id) ? c.id : cellId();
      let md = c.metadata, ms = null;
      // (a code cell's last run time: metadata.sagebrush.ms, taken out of the metadata)
      if (c.cell_type === "code" && typeof md?.sagebrush?.ms === "number" && md.sagebrush.ms >= 0) {
        ms = md.sagebrush.ms;
        const { ms: _ms, ...sb } = md.sagebrush;
        const { sagebrush: _sb, ...others } = md;
        md = Object.keys(sb).length ? { ...others, sagebrush: sb } : others;
      }
      const metadata = md && Object.keys(md).length ? { metadata: md } : {};
      if (c.cell_type === "code") return { id, code: src, outputs: c.outputs ?? [], n: c.execution_count ?? c.prompt_number ?? null, ...(ms != null ? { ms } : {}), ...metadata };
      if (c.cell_type === "markdown") return { id, type: "markdown", code: src, attachments: c.attachments ?? null, ...metadata };
      // nbformat 3's heading cells are Markdown headings
      if (c.cell_type === "heading") return { id, type: "markdown", code: "#".repeat(c.level ?? 1) + " " + src, ...metadata };
      return { id, type: "raw", code: src, ...metadata };
    });
    const extra = j.metadata && Object.keys(j.metadata).length ? { metadata: j.metadata } : {};
    return { name: base, mode: modeOf(j.metadata), cells, ...extra, ...(j.nbformat === 4 && j.nbformat_minor > 5 ? { nbformat_minor: j.nbformat_minor } : {}) };
  }
  // a marimo notebook (web/notebook/marimo.js)
  if (/\.py$/i.test(name) && isMarimo(text)) return fromMarimo(name, text, cellId);
  // "# %%" starts a cell, "# %% [markdown]" a Markdown cell whose lines are comments (jupytext);
  // in Magma (.mag, or .m with := or "// %%"), "// %%" and "//" comments; in MATLAB (.m),
  // MATLAB's own sections: "%%" (its title, if any, a comment heading the cell), "%" comments
  const lang = /\.sage$/i.test(name) ? "sage" : /\.mag$/i.test(name) ? "magma"
    : /\.m$/i.test(name) ? (/^\/\/ ?%%/m.test(text) || looksLikeMagma(text) ? "magma" : "matlab") : mode;
  const marker = lang === "matlab" ? /^%%(.*)$/ : /^(?:#|\/\/) ?%%(.*)$/;
  const comment = lang === "matlab" ? /^% ?/ : /^(?:#|\/\/) ?/;
  const cells = [];
  let cur = { code: "" };
  for (const line of text.split("\n")) {
    const m = marker.exec(line);
    if (m) {
      if (cur.code.trim() || cells.length) cells.push(cur);
      cur = /\[markdown\]|\[md\]/.test(m[1]) ? { type: "markdown", code: "" } : /\[raw\]/.test(m[1]) ? { type: "raw", code: "" } : { code: "" };
      if (lang === "matlab" && !cur.type && m[1].trim()) cur.code = "% " + m[1].trim() + "\n";
    } else cur.code += (cur.type ? line.replace(comment, "") : line) + "\n";
  }
  cells.push(cur);
  for (const c of cells) { c.code = c.code.replace(/\n+$/, "").replace(/^\n+/, ""); c.id = cellId(); }
  return { name: base, mode: lang, cells: cells.filter((c, i) => c.code || i === 0) };
}

/** The cells as a script: "# %%" cells, Markdown and raw cells as comments (jupytext's percent
 * format; in MATLAB, "%%" sections and "%" comments, as jupytext writes MATLAB). */
export function toScript(doc) {
  const cm = doc.mode === "magma" ? "//" : doc.mode === "matlab" ? "%" : "#";
  const mark = doc.mode === "matlab" ? "%%" : cm + " %%";
  const commented = (code) => code.split("\n").map((l) => (l ? cm + " " + l : cm)).join("\n");
  return doc.cells.map((c) => (c.type === "markdown" || c.type === "raw" ? `${mark} [${c.type}]\n` + commented(c.code) : mark + "\n" + c.code)).join("\n\n") + "\n";
}
