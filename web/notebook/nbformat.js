// Jupyter's nbformat cells as a Sagebrush notebook's (web/notebook/types.ts Cell): what ipynb.js's fromFile reads from an
// .ipynb file, and what the workspace (web/workspace/api.ts) makes of a notebook written as nbformat JSON (an agent's
// create or write: the agent sim's F1, Nov 9, both agents wrote {cell_type, source} and the page showed empty cells).
// No imports: every page that has the workspace carries it.

export const joinText = (t) => (Array.isArray(t) ? t.join("") : t ?? "");

/** A new cell id: nbformat's [a-zA-Z0-9-_]{1,64}. */
export const cellId = () => (crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 12);
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id);

/** The mode a notebook's metadata says (its kernel). */
export function modeOf(metadata) {
  const k = metadata?.kernelspec ?? {};
  const lang = `${k.name ?? ""} ${k.language ?? ""} ${metadata?.language_info?.name ?? ""}`;
  // (MATLAB: the MathWorks kernel's notebooks too, jupyter_matlab_kernel, and Octave's)
  return /magma/i.test(lang) ? "magma" : /matlab|octave/i.test(lang) ? "matlab" : /sage/i.test(lang) ? "sage" : "python";
}

/** One nbformat cell (4, or 3's input/prompt_number/heading) as Sagebrush's; an Error for a heading level not 1 to 6. */
export function cellOf(c) {
  const t = joinText(c.source ?? c.input), src = typeof t === "string" ? t : String(t), id = validId(c.id) ? c.id : cellId();
  let md = c.metadata, ms = null;
  // (a code cell's last run time: metadata.sagebrush.ms, taken out of the metadata)
  if (c.cell_type === "code" && typeof md?.sagebrush?.ms === "number" && md.sagebrush.ms >= 0) {
    ms = md.sagebrush.ms;
    const { ms: _ms, ...sb } = md.sagebrush;
    const { sagebrush: _sb, ...others } = md;
    md = Object.keys(sb).length ? { ...others, sagebrush: sb } : others;
  }
  const metadata = md && typeof md === "object" && Object.keys(md).length ? { metadata: md } : {};
  if (c.cell_type === "code") return { id, code: src, outputs: Array.isArray(c.outputs) ? c.outputs : [], n: c.execution_count ?? c.prompt_number ?? null, ...(ms != null ? { ms } : {}), ...metadata };
  if (c.cell_type === "markdown") return { id, type: "markdown", code: src, attachments: c.attachments ?? null, ...metadata };
  // nbformat 3's heading cells are Markdown headings: a level 1 to 6, as Markdown has (none given, 1); any other refused
  // before any text is made (astra's NBF928-1: a workspace write converts under its lock)
  if (c.cell_type === "heading") {
    const level = c.level ?? 1;
    if (!Number.isInteger(level) || level < 1 || level > 6) throw new Error(`a heading cell's level is 1 to 6, not ${String(JSON.stringify(level)).slice(0, 40)}`);
    return { id, type: "markdown", code: "#".repeat(level) + " " + src, ...metadata };
  }
  return { id, type: "raw", code: src, ...metadata };
}

// (an nbformat cell: its text in source (or 3's input), its kind in cell_type, and no Sagebrush code)
const isNbCell = (c) => !!c && typeof c === "object" && typeof c.code !== "string" && (typeof c.cell_type === "string" || "source" in c || "input" in c);

/** A notebook document written as nbformat (any cell in its shape, or an nbformat field) as Sagebrush's: those cells
 * converted (the others kept as given), nbformat's version fields dropped (a minor past 5 kept, as fromFile keeps
 * it), its metadata kept (a new notebook's mode is its kernel's: kernelMode).  Anything else, as it is. */
export function fromNbformat(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.cells) || !(doc.nbformat !== undefined || doc.cells.some(isNbCell))) return doc;
  const { nbformat: _f, nbformat_minor: minor, ...rest } = doc;
  return { ...rest, cells: doc.cells.map((c) => (isNbCell(c) ? cellOf(c) : c)), ...(doc.nbformat === 4 && minor > 5 ? { nbformat_minor: minor } : {}) };
}

/** The mode a document's metadata names by its kernel, or undefined when it names none. */
export const kernelMode = (doc) => {
  const md = doc?.metadata;
  return md && typeof md === "object" && (md.kernelspec || md.language_info) ? modeOf(md) : undefined;
};
