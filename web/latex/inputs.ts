// The files a .tex reads with \input and \include (William's L4, Nov 2: they were silently ignored, which broke his
// shared macros file). Found as TeX finds them (images.ts texCandidates: the .tex's folder, ../, a leading "/" for
// the workspace's top; .tex added first), read by the host (the page from the workspace, the CLI from the folder it
// runs in, each with its own read rules), bounded here, and given to the engine as a snapshot: the engine never reads
// a file itself (engine/pipeline.mjs inputs, engine/demo-machine.mjs doInput). Pure: test-latex-units.mjs checks it.
import { texCandidates, bibCandidates, notFoundWhy } from "./images";
import { openBytes, EDIT_MAX } from "./save";

/** At most this many included files, of at most EDIT_MAX bytes each and INPUT_BOUNDS.total in all. */
export const INPUT_BOUNDS = { files: 64, perFile: EDIT_MAX, total: 16 * 2 ** 20 };

/** What the host knows of a candidate path: its text, why it isn't read (refused, too large, not text), or absent. */
export type Known = { text: string } | { why: string } | { absent: true };

/** The engine's inputs, for the .tex at `docPath`, from what the host has read (`known`, by workspace path):
 * `files` (key -> text: the read ones), `resolve(name)` (the key, or why there is none) and `wanted(names)` (the
 * candidate paths the host should look at next: unknown ones for each name, in order, up to the first that might
 * be it). The .tex itself is the engine's main.tex; `jobname` is its name, as TeX's \jobname, and `jobname`.bbl is looked
 * for by that exact name. `relativeToFile`: the folders named from the file's (the CLI). */
export function engineInputs(docPath: string, known: Map<string, Known>, relativeToFile = false, main?: string, makeBbl?: (texts: string[], read: (name: string) => string | undefined) => string | null) {
  const files = new Map<string, string>();
  for (const [p, k] of known) if ("text" in k && p !== docPath) files.set(p, k.text);
  // (TeX's \jobname: the .tex's name without its folder and ".tex"; \bibliography reads \jobname.bbl by that exact name,
  //  beside the .tex, as pdflatex does: never a .bbl.tex, as an \input's name would be tried first)
  const slash = docPath.lastIndexOf("/"), base = docPath.slice(slash + 1);
  const jobname = /\.tex$/i.test(base) ? base.slice(0, -4) : base;
  const bbl = jobname + ".bbl";
  const bblPath = docPath.slice(0, slash + 1) + bbl;
  // (a \bibliography's .bib, by its name as BibTeX finds it: ".bib" added unless written, never a .tex)
  const candidates = (name: string) => name === bbl ? { ok: true as const, paths: [bblPath], searched: [docPath.slice(0, Math.max(slash, 1))] } : /\.bib$/i.test(name) ? bibCandidates(name, docPath) : texCandidates(name, docPath);
  let made = false;
  const resolve = (name: string): { key?: string; why?: string } => {
    if (name === bbl && made) return { key: bblPath };
    const c = candidates(name);
    if (!c.ok) return { why: c.why };
    for (const p of c.paths) {
      if (p === docPath) return { key: "main.tex" };
      const k = known.get(p);
      if (k === undefined) return { why: "not read yet" };
      if ("text" in k) return { key: p };
      if ("why" in k) return { why: k.why };
    }
    return { why: notFoundWhy(docPath, c.searched, [], relativeToFile, name) };
  };
  const wanted = (names: string[]): string[] => {
    const out: string[] = [];
    for (const name of names) {
      const c = candidates(name);
      if (!c.ok) continue;
      for (const p of c.paths) {
        if (p === docPath) break;
        const k = known.get(p);
        if (k === undefined) { if (!out.includes(p)) out.push(p); break; }
        if (!("absent" in k)) break;
      }
    }
    return out;
  };
  // (no .bbl beside the .tex, and the .bib files its \bibliography names read: the .bbl BibTeX would make, in plain's
  //  style (`makeBbl`: bib.ts's bblFor, a chunk the worker fetches), given to the engine as that .bbl. `main`: the .tex's
  //  text, for its \bibliography and its \cite's (with the included files'); without it or `makeBbl`, or with a .bbl
  //  there or not yet known, nothing is made)
  const k0 = known.get(bblPath);
  if (main !== undefined && makeBbl && k0 !== undefined && "absent" in k0) {
    const texts = [main, ...[...files].filter(([p]) => !/\.bib$/i.test(p)).map(([, t]) => t)];
    const bbl0 = makeBbl(texts, (nm) => { const r = resolve(nm); return r.key ? files.get(r.key) : undefined; });
    if (bbl0 !== null) { files.set(bblPath, bbl0); made = true; }
  }
  return { files, resolve, wanted, jobname };
}

/** An included file's bytes as the engine's text, or why not, against what is already kept (`kept` bytes, `count`
 * files). */
export function admitInput(bytes: Uint8Array, kept: number, count: number, b = INPUT_BOUNDS): Known {
  if (count >= b.files) return { why: "too many included files (" + b.files + ")" };
  if (bytes.length > b.perFile || kept + bytes.length > b.total) return { why: "too large" };
  const o = openBytes(bytes);
  if (o.kind === "binary") return { why: o.why };
  return { text: o.text };
}
