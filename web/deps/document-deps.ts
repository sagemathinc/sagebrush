// The files a document depends on (work order 3a, Nov 5): for the "Uses N helper files" line (1b), Download
// and Share (2). A document is a notebook, a Python/Sage/MATLAB/Magma script, a LaTeX file or a Markdown file, and
// what it uses is its local files: modules it imports, files it opens, \input/\include/\subfile, its bibliography,
// its pictures. One detector: everything code does goes through fileDeps (file-deps.ts), the Share dialog's
// analysis, unchanged; this module adds what isn't code (LaTeX's references, a Markdown file's links) and turns
// LaTeX's code blocks (sagetex, pythontex, matlabtex: web/latex/cells.ts) into cells fileDeps reads.
//
// Pure (no DOM, no workspace, nothing run): it runs in deps-worker.ts, and the page calls documentDeps
// (deps-client.ts). The rule is fileDeps': `certain` only where the file is exactly known; anything else is
// listed (with why) or reported as unfollowed, never pre-ticked.
//
// LaTeX is read as TeX reads it: names relative to the main file's folder (TeX's working directory, for an \input
// in an \input file too), \input{x} trying x.tex then x, \include{x} reading x.tex, \includegraphics through
// \graphicspath (web/latex/images.ts: texCandidates, imageCandidates, graphicsPathOf, as the LaTeX editor
// resolves them), \bibliography{a,b} naming a.bib and b.bib; in TeX's order (an \input file is read where it is
// named, and a \graphicspath counts from where it is set, in any file). Comments (a % after an even run of
// backslashes) and verbatim environments are skipped, and so are the code blocks' own texts (their code is fileDeps').
import { fileDeps, type CellKind } from "./file-deps";
import { fromFile } from "../notebook/ipynb.js";
import { LANG, scanItems } from "../latex/cells";
import { graphicsPathOf, imageCandidates, texCandidates } from "../latex/images";

export type DocKind = "ipynb" | "py" | "sage" | "m" | "mag" | "tex" | "md";
export type Via = "import" | "open" | "named" | "link" | "input" | "include" | "bibliography" | "graphic";
export interface Dep {
  /** an absolute workspace path, "/dir/_code/helpers.py" */
  path: string;
  via: Via;
  exists: boolean;
  /** exactly known (pre-tick it, count it); false: listed, not pre-ticked */
  certain: boolean;
  /** the file that brought it in, when not the document itself (a helper's import, an \input file's picture) */
  from?: string;
  /** in words: "imported in the 2nd cell", "\input in main.tex", "opened in helpers.py" */
  why: string;
}
export interface DocUnfollowed {
  /** where: "the 3rd cell", "main.tex", "helpers.py" */
  at: string;
  line: number;
  why: string;
}
export interface DocDepsContext {
  /** workspace file metadata, by absolute workspace path */
  files: ReadonlyMap<string, { size?: number }>;
  /** a file's text, read lazily (an imported module, an \input file) */
  readFile: (path: string) => Promise<string>;
  /** sys.path, in order (fileDeps'); default: the document's folder, then the library */
  importPath?: { dir: string; workspace: boolean }[];
  builtinModules?: ReadonlySet<string>;
  externalModules?: ReadonlySet<string>;
  packageModules?: ReadonlySet<string>;
  signal?: AbortSignal;
  /** each dep as it is found: the same Dep the result's array has */
  onDep?: (d: Dep) => void;
  onProgress?: (p: { parsed: number; queued: number }) => void;
}

/** A document's kind from its name, or null: not a document this reads. */
export function docKindOf(name: string): DocKind | null {
  const m = /\.(ipynb|py|sage|m|mag|tex|md)$/i.exec(name);
  return m ? (m[1].toLowerCase() as DocKind) : null;
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const nth = (n: number) => {
  const k = n + 1, s = k % 100 >= 11 && k % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][k % 10] ?? "th");
  return `the ${k}${s} cell`;
};
const NONE: ReadonlySet<string> = new Set();
// (LaTeX's references: a command, an optional [...] and its {argument}; or \input followed by a bare name; and
// \graphicspath, which sets where later \includegraphics look)
const TEX_REF = /\\(input|include|subfile|bibliography|addbibresource|includegraphics)\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}|\\input\s+([^\s{}\\%]+)|\\graphicspath\s*\{(?:\s*\{[^{}]*\})*\s*\}/g;
const VERBATIM = /\\begin\s*\{(verbatim\*?|lstlisting|minted|comment|Verbatim)\}[\s\S]*?\\end\s*\{\1\}/g;

/** A LaTeX text as its references see it: comments, verbatim environments and the code blocks' spans blanked
 * (to spaces, keeping each newline, so line numbers stay true). */
function texSkeleton(text: string, spans: { start: number; end: number }[]): string {
  const chars = text.split("");
  const blank = (a: number, b: number) => {
    for (let i = a; i < b && i < chars.length; i++) if (chars[i] !== "\n") chars[i] = " ";
  };
  for (const s of spans) blank(s.start, s.end);
  const t = chars.join("").replace(VERBATIM, (m) => m.replace(/[^\n]/g, " ")).split("");
  // (a % after an even run of backslashes, none or \\ (a line break), runs to the end of its line; after an odd
  // run it is \%, a percent sign)
  let run = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\") {
      run++;
      continue;
    }
    if (t[i] === "%" && run % 2 === 0) while (i < t.length && t[i] !== "\n") t[i++] = " ";
    run = 0;
  }
  return t.join("");
}

export async function dependencies(path: string, text: string, kind: DocKind, ctx: DocDepsContext): Promise<{ deps: Dep[]; unfollowed: DocUnfollowed[]; complete: boolean }> {
  const folder = dirOf(path);
  const deps: Dep[] = [];
  const unfollowed: DocUnfollowed[] = [];
  const seen = new Set<string>([path]);
  let complete = true;
  const add = (d: Dep) => {
    if (seen.has(d.path)) return;
    seen.add(d.path);
    deps.push(d);
    ctx.onDep?.(d);
  };
  const label = (p: string) => (p.startsWith(folder === "/" ? "/" : folder + "/") ? p.slice(folder === "/" ? 1 : folder.length + 1) : p.replace(/^\/+/, ""));

  // ---- the cells fileDeps reads, and what each is called in a reason
  const cells: { index: number; kind: CellKind; source: string }[] = [];
  const cellName = new Map<number, string>();
  // (a LaTeX code block's file, when it isn't the document: an \input file's pycode)
  const cellFrom = new Map<number, string>();
  if (kind === "tex") {
    if (!(await latex(path, text))) complete = false;
  } else if (kind === "md") {
    cells.push({ index: 0, kind: "markdown", source: text });
    cellName.set(0, baseOf(path));
  } else {
    let doc: { mode: string; cells: { type?: string; code: string }[] };
    try {
      doc = fromFile(baseOf(path), text);
    } catch {
      return { deps, unfollowed: [{ at: baseOf(path), line: 0, why: "couldn't be read as a notebook" }], complete: false };
    }
    const mode: CellKind = doc.mode === "sage" || doc.mode === "magma" || doc.mode === "matlab" ? doc.mode : "python";
    const script = kind !== "ipynb";
    doc.cells.forEach((c, i) => {
      if (c.type === "raw") return;
      cells.push({ index: i, kind: c.type === "markdown" ? "markdown" : mode, source: c.code });
      // (a script is one file: its "# %%" cells are parts of it, not a notebook's cells)
      cellName.set(i, script ? baseOf(path) : nth(i));
    });
  }

  // ---- what code does: fileDeps, unchanged
  if (cells.length) {
    const VIA: Record<string, Via> = { imported: "import", opened: "open", named: "named", linked: "link" };
    const r = await fileDeps({
      cells,
      files: ctx.files,
      cwd: folder,
      importPath: ctx.importPath ?? [{ dir: folder, workspace: true }],
      builtinModules: ctx.builtinModules ?? NONE,
      externalModules: ctx.externalModules ?? NONE,
      packageModules: ctx.packageModules ?? NONE,
      readFile: ctx.readFile,
      onDep: (p, reason) => {
        const via = VIA[reason.kind] ?? "named";
        const verb = via === "import" ? "imported" : via === "open" ? "opened" : via === "link" ? "linked" : "named";
        if ("cell" in reason) {
          const from = cellFrom.get(reason.cell);
          add({ path: p, via, exists: true, certain: true, ...(from ? { from } : {}), why: `${verb} in ${cellName.get(reason.cell) ?? nth(reason.cell)}` });
        }
        else add({ path: p, via, exists: true, certain: true, from: reason.by, why: `${verb} in ${label(reason.by)}` });
      },
      onUnfollowed: (u) => unfollowed.push({ at: "cell" in u.where ? (cellName.get(u.where.cell) ?? nth(u.where.cell)) : label(u.where.file), line: u.line, why: u.why }),
      onProgress: (p) => ctx.onProgress?.(p),
      signal: ctx.signal ?? new AbortController().signal,
    });
    if (!r.complete) complete = false;
  }
  return { deps, unfollowed, complete: complete && !ctx.signal?.aborted };

  // ---- LaTeX: the main file, each \input/\include/\subfile file read where it is named (TeX's order), once
  async function latex(main: string, mainText: string): Promise<boolean> {
    let ok = true;
    // (\graphicspath as TeX keeps it: set where it's met, in whichever file, for every later \includegraphics)
    let dirs: string[] = [];
    const read = new Set<string>([main]);
    const walk = async (file: string, t: string): Promise<void> => {
      if (ctx.signal?.aborted) return;
      const by = file === main ? undefined : file;
      const at = label(file);
      // (its code blocks: cells of their language, analysed by fileDeps as the document's code)
      const items = scanItems(t);
      for (const it of items) {
        const index = cells.length;
        cells.push({ index, kind: LANG[it.kind], source: it.code });
        cellName.set(index, at);
        if (by) cellFrom.set(index, by);
      }
      const skel = texSkeleton(t, items);
      for (const m of skel.matchAll(TEX_REF)) {
        if (ctx.signal?.aborted) return;
        if (m[0].startsWith("\\graphicspath")) {
          dirs = graphicsPathOf(m[0]);
          continue;
        }
        const cmd = m[1] ?? "input", arg = (m[2] ?? m[3] ?? "").trim();
        const line = skel.slice(0, m.index).split("\n").length;
        if (!arg) continue;
        if (/[\\#]/.test(arg)) {
          unfollowed.push({ at, line, why: `\\${cmd}{${arg}}: a name made by a macro, only known when TeX runs` });
          continue;
        }
        const names = cmd === "bibliography" ? arg.split(",").map((s) => s.trim()).filter(Boolean) : [arg];
        for (const name of names) {
          const c =
            cmd === "includegraphics"
              ? imageCandidates(name, main, dirs)
              : cmd === "bibliography"
                ? texCandidates(/\.bib$/i.test(name) ? name : name + ".bib", main)
                : cmd === "addbibresource"
                  ? texCandidates(name, main)
                  : texCandidates(cmd === "include" && !/\.tex$/i.test(name) ? name + ".tex" : name, main);
          if (!c.ok) {
            unfollowed.push({ at, line, why: `\\${cmd}{${name}}: ${c.why}` });
            continue;
          }
          // (LaTeX's own picture formats too, for a name without an extension: .pdf and .eps after the editor's)
          // (a bibliography file only as written: texCandidates' .tex first is \input's rule, not BibTeX's)
          const bib = cmd === "bibliography" || cmd === "addbibresource";
          const paths =
            cmd === "includegraphics" ? [...c.paths, ...c.paths.filter((p) => !/\.[A-Za-z0-9]{1,5}$/.test(baseOf(p))).flatMap((p) => [p + ".pdf", p + ".eps"])]
            : bib ? c.paths.filter((p) => !/\.tex$/i.test(p) || /\.tex$/i.test(name)) : c.paths;
          const found = paths.find((p) => ctx.files.has(p));
          const via: Via = cmd === "includegraphics" ? "graphic" : bib ? "bibliography" : cmd === "include" ? "include" : "input";
          const why = `\\${cmd === "addbibresource" ? "addbibresource" : cmd} in ${at}`;
          if (!found) {
            // (named but not in the workspace: listed, greyed, never ticked)
            add({ path: paths[0], via, exists: false, certain: false, ...(by ? { from: by } : {}), why: `${why} (not found)` });
            continue;
          }
          add({ path: found, via, exists: true, certain: true, ...(by ? { from: by } : {}), why });
          if ((via === "input" || via === "include") && !read.has(found)) {
            read.add(found);
            let sub: string;
            try {
              sub = await ctx.readFile(found);
            } catch {
              ok = false;
              unfollowed.push({ at: label(found), line: 0, why: "couldn't be read" });
              continue;
            }
            await walk(found, sub);
          }
        }
      }
    };
    await walk(main, mainText);
    return ok && !ctx.signal?.aborted;
  }
}
