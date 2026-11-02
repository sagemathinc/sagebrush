// Jupytext's MyST Markdown notebooks (a `.md` file, `format_name: myst` in its
// front matter, as jupyter-book's chapters are): read into a notebook document,
// for "Open as a notebook" (a converted copy beside the file; the .md is only
// read, never written: plan-myst-notebooks r3 §2.2, §8.4, §8.5).
//
// Which files are MyST (isMystHead, the 4 KiB rule) and the front matter's closed
// grammar are in web/notebook/myst-head.ts, re-exported here.
//
// Cells (jupytext's MyST format): ```{code-cell} <lang> fences are code cells
// (option lines ":key: value" or a "---" block at their start: the cell's
// metadata), ```{raw-cell} raw cells, a "+++" line (with optional JSON: the
// next Markdown cell's metadata) starts a Markdown cell, and the text between
// is Markdown.  A fence inside another (a directive's body) is not a boundary.
// What lies between cells (marker lines, blank lines) is kept in
// metadata.sagebrush.myst.seps, so the cells and seps give the body back byte
// for byte (mystBody): nothing read is lost.

import { HEAD_BYTES, TEXT, isMystHead, lf, frontMatter, closedYaml } from "./myst-head.js";
export { HEAD_BYTES, TEXT, isMystHead };
// a plain object copy (for metadata: JSON, no null prototype)
const plain = (o) => JSON.parse(JSON.stringify(o ?? {}));

const OPEN = /^ {0,3}(`{3,}|~{3,}|:{3,})(.*)$/;

/** A Jupytext MyST notebook's document (as fromFile's), from its text. */
export function fromMyst(name, text, cellId) {
  if (!isMystHead(text)) throw new Error(`${name} is not a Jupytext MyST notebook`);
  const t = lf(String(text));
  const fm = frontMatter(t);
  const body = t.slice(fm.end);
  const lines = body.split("\n");
  // (line i starts at offset at[i])
  const at = [0];
  for (const l of lines) at.push(at[at.length - 1] + l.length + 1);
  const cells = [], seps = [];
  let cur = null, sepFrom = 0;
  // a cell's content [from, to) in body offsets; its text is that, leading/trailing newlines moved into the seps
  const push = (c, from, to) => {
    let a = from, b = Math.min(to, body.length);
    while (a < b && body[a] === "\n") a++;
    while (b > a && body[b - 1] === "\n") b--;
    seps.push(body.slice(sepFrom, a));
    c.code = body.slice(a, b);
    c.id = cellId();
    cells.push(c);
    sepFrom = b;
  };
  let mdFrom = 0, mdMeta = null;
  // (a Markdown cell only if it has text, or "+++" gave it metadata: blank lines between cells are seps)
  const closeMd = (to) => {
    const c = { type: "markdown", code: "" };
    if (mdMeta) c.metadata = mdMeta;
    if (body.slice(mdFrom, to).trim() || mdMeta) push(c, mdFrom, to);
    mdMeta = null;
  };
  const fences = []; // the Markdown's open fences: [char, count]
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fences.length) {
      const [ch, n] = fences[fences.length - 1];
      const close = new RegExp(`^ {0,3}\\${ch}{${n},}[ \\t]*$`);
      if (close.test(line)) { fences.pop(); continue; }
      // (inside a directive (a colon fence) another may open; inside a code fence nothing does)
      if (ch === ":") { const o = OPEN.exec(line); if (o && (o[1][0] !== ":" || o[2].startsWith("{"))) fences.push([o[1][0], o[1].length]); }
      continue;
    }
    const cc = /^(`{3,})\{(code-cell|raw-cell)\}(.*)$/.exec(line);
    if (cc) {
      closeMd(at[i]);
      // its options: ":key: value" lines, or a "---" block, right after the fence line
      let j = i + 1;
      const meta = {};
      if (lines[j] === "---") {
        let k = j + 1;
        while (k < lines.length && lines[k] !== "---") k++;
        if (k < lines.length) { Object.assign(meta, plain(closedYaml(lines.slice(j + 1, k).join("\n")))); j = k + 1; }
      } else {
        while (j < lines.length && /^:[A-Za-z0-9_.-]+:/.test(lines[j])) {
          const m = /^:([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(lines[j]);
          meta[m[1]] = optionValue(m[2]);
          j++;
        }
      }
      const fence = cc[1], closeRe = new RegExp(`^${fence}\`*[ \\t]*$`);
      let k = j;
      while (k < lines.length && !closeRe.test(lines[k])) k++;
      const c = cc[2] === "raw-cell" ? { type: "raw", code: "" } : { code: "" };
      if (Object.keys(meta).length) c.metadata = meta;
      // (the fence and option lines go into this cell's sep)
      push(c, at[j], k < lines.length ? at[k] : body.length);
      // (the closing fence line: into the next sep)
      i = k;
      mdFrom = k < lines.length ? at[k + 1] ?? body.length : body.length;
      if (mdFrom > body.length) mdFrom = body.length;
      continue;
    }
    const plus = /^\+\+\+[ \t]*(.*)$/.exec(line);
    if (plus) {
      closeMd(at[i]);
      mdFrom = Math.min(at[i + 1] ?? body.length, body.length);
      const j = plus[1].trim();
      if (j) { try { const v = JSON.parse(j); if (v && typeof v === "object" && !Array.isArray(v)) mdMeta = v; } catch {} }
      continue;
    }
    // (a colon fence is a directive only with its {name})
    const o = OPEN.exec(line);
    if (o && (o[1][0] !== ":" || o[2].startsWith("{"))) fences.push([o[1][0], o[1].length]);
  }
  closeMd(body.length);
  const tail = body.slice(sepFrom);
  const kernelspec = fm.data?.kernelspec ? plain(fm.data.kernelspec) : null;
  const lang = `${kernelspec?.language ?? ""} ${kernelspec?.name ?? ""}`;
  const mode = /sage/i.test(lang) ? "sage" : /magma/i.test(lang) ? "magma" : /matlab|octave/i.test(lang) ? "matlab" : "python";
  // (its chapter number, from a name like "09-Improving_DL.md"; 0, a book's unnumbered intro, is none)
  const chapter = +(/^(\d{1,3})[-_ ]/.exec(name)?.[1] ?? 0);
  const metadata = {
    jupytext: plain(fm.data.jupytext),
    ...(kernelspec ? { kernelspec } : {}),
    sagebrush: { myst: { frontMatter: fm.yaml, seps, tail, ...(chapter > 0 ? { chapter } : {}) } },
  };
  return { name: name.replace(/\.[^.]*$/, ""), mode, cells: cells.length ? cells : [{ type: "markdown", code: "", id: cellId() }], metadata };
}

// a ":key: value" option's value: [a, b] a list of strings, else the text
function optionValue(v) {
  const m = /^\[(.*)\]$/.exec(v.trim());
  if (!m) return v;
  return m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/** The body (the text after the front matter) the cells came from, with the seps
 * fromMyst kept: equal to the LF-normalized body as read, byte for byte, while
 * the cells are as read (R-1's no-loss invariant). */
export function mystBody(doc) {
  const m = doc?.metadata?.sagebrush?.myst;
  if (!m || !Array.isArray(m.seps) || m.seps.length !== doc.cells.length) return null;
  return doc.cells.map((c, i) => m.seps[i] + c.code).join("") + m.tail;
}
