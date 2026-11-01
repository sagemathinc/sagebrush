// The Python library for the browser in chunks (web/build.ts): the worker
// carries only a manifest, and fetches a chunk the first time a module of it
// is imported (web/lib-lazy.ts), or when a mode that needs it starts.  A blank
// Python notebook then loads none of it; Sage mode fetches Sage's.
//
// A group is a set of library files, and has two chunks: its sources ("src",
// needed to import any of them) and their code compiled when the site was
// built ("pre", src/compile.ts's precompiled entries; used only if it is
// there).  The groups come from what each mode's start compiled (the
// recordings, SAGEBRUSH_PRECOMPILE_OUT): a file goes to the first of
//   core    what plain Python imports first, and what Sage and the
//           scientific modules share
//   sci     numpy, matplotlib, k3d, ipywidgets (MATLAB's start too; scipy.io
//           is a package's, @sagebrush/scipy-io)
//   sage    Sage mode's start (Magma's too)
//   matlab  MATLAB mode's start
//   magma   Magma mode's start
// that it is in; files no start uses are grouped by family (sage-more,
// matlab-more, magma-more; MATLAB's sparse LU, _matlab_lu and _matlab_colamd,
// is matlab-lu) or are a group of their own (mod-<name>: a
// top-level module or package, its name in lowercase letters, digits and
// "-"; each of scipy's submodules is mod-scipy-<sub>, so that one doesn't
// fetch the others).  Each package (packages/<name>/, scripts/packages.mjs) is a group too,
// pkg-<name>, its files by "<name>/<path>", with its compiled code too if a
// mode's start imports it (recorded as "pkg:<name>/<path>"), and in that
// mode's start then; the manifest carries the packages' registry
// (src/compile.ts checks each file against it).  A chunk's file name has its content's
// SHA-256, and the manifest the whole hash, which the worker checks before it
// uses one (design/security.md, SEC-8D6-1: a cached copy is origin storage).
import { createHash } from "node:crypto";

export type Recording = { build: string; modules: Record<string, { code: string; lineMap: unknown; path: string }> };
export type ChunkRef = { file: string; sha256: string; size: number };
export type LibManifest = {
  build: string;
  /** library path -> its group */
  files: Record<string, string>;
  /** group -> its chunks */
  chunks: Record<string, { src: ChunkRef; pre?: ChunkRef }>;
  /** mode -> the groups its start needs, fetched when the mode starts */
  modes: Record<string, string[]>;
  /** the packages' registry, and each package file ("<dir>/<path>") -> its group */
  packages: { registry: unknown; files: Record<string, string> };
  /** the pinned zone data's index (web/tzdata-chunks.mts), for a browser's time */
  tzdata?: ChunkRef & { version: string };
};
export type Packages = { registry: { packages: Record<string, { dir: string }> }; files: Record<string, string> };

export const START_ORDER = ["core", "sci", "sage", "matlab", "magma"] as const;

export function groupOf(path: string, sets: Record<string, Set<string>>): string {
  if (sets.py?.has(path) || (sets.sci?.has(path) && sets.sage?.has(path))) return "core";
  for (const g of ["sci", "sage", "matlab", "magma"]) if (sets[g]?.has(path)) return g;
  const top = path.split("/")[0].replace(/\.py$/, "");
  if (/^_?sage/.test(top)) return "sage-more";
  // (MATLAB mode's sparse LU, imported only by a measured sparse solve: its
  // own group, so the other MATLAB extras' users don't fetch it)
  if (/^_matlab_(lu|colamd)$/.test(top)) return "matlab-lu";
  if (/^_matlab/.test(top)) return "matlab-more";
  if (/^_magma/.test(top)) return "magma-more";
  // (scipy's submodules: a group each, mod-scipy-<sub>, so that importing
  // one fetches none of the others; scipy/__init__.py, which a mode's start
  // imports, stays in that start's group)
  const sub = /^scipy\/([a-z0-9_]+)(?:\.py$|\/)/.exec(path);
  if (sub && sub[1] !== "__init__") return "mod-scipy-" + sub[1].replace(/_+/g, "-");
  // (lowercase letters, digits and "-": an engine file's name has nothing
  // else, web/engines.ts; mod-future for __future__, mod-ipython for IPython)
  return "mod-" + top.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The chunks (name -> bytes) and the manifest, for `lib` (path -> source)
 * and each mode's recording (py, sci, sage, matlab, magma). */
export function libChunks(lib: Record<string, string>, recordings: Record<string, Recording>, build: string, packages: Packages = { registry: { packages: {} }, files: {} }): { manifest: LibManifest; chunks: Map<string, Buffer> } {
  for (const [m, r] of Object.entries(recordings)) if (r.build !== build) throw new Error(`the ${m} recording is not this build's`);
  const sets = Object.fromEntries(Object.entries(recordings).map(([m, r]) => [m, new Set(Object.values(r.modules).map((x) => x.path))]));
  const files: Record<string, string> = {};
  const src = new Map<string, Record<string, string>>();
  const pre = new Map<string, Recording["modules"]>();
  const tops = new Map<string, string>();
  for (const path of Object.keys(lib).sort()) {
    const g = groupOf(path, sets);
    // (two top-level names that would share a group's name: never silently
    // merged, but for a private module and its public twin, _string and
    // string, which are imported together)
    const top = path.split("/")[0].replace(/\.py$/, "").replace(/^_(?!_)/, "");
    if (g.startsWith("mod-") && (tops.get(g) ?? top) !== top) throw new Error(`library chunks: ${tops.get(g)} and ${top} would both be ${g}`);
    tops.set(g, top);
    files[path] = g;
    (src.get(g) ?? src.set(g, {}).get(g)!)[path] = lib[path];
  }
  // (a package's files: one group, its file by "<dir>/<path>")
  const pkgFiles: Record<string, string> = {};
  const pkgGroups = new Map<string, Record<string, string>>();
  for (const key of Object.keys(packages.files).sort()) {
    const g = "pkg-" + key.split("/")[0];
    if (src.has(g)) throw new Error(`library chunks: ${g} is a library group's name too`);
    pkgFiles[key] = g;
    (pkgGroups.get(g) ?? pkgGroups.set(g, {}).get(g)!)[key] = packages.files[key];
  }
  // (a recorded module's group: a library file's, or a package file's,
  // "pkg:<dir>/<path>" in the recording, src/compile.ts precompiledPath)
  const groupOfPath = (p: string): string | undefined => (p.startsWith("pkg:") ? (Object.hasOwn(pkgFiles, p.slice(4)) ? pkgFiles[p.slice(4)] : undefined) : Object.hasOwn(files, p) ? files[p] : undefined);
  for (const r of Object.values(recordings))
    for (const [key, m] of Object.entries(r.modules)) {
      // (compiled from the library's or a package's own file: anything else is not used)
      const g = groupOfPath(m.path);
      if (g === undefined) continue;
      (pre.get(g) ?? pre.set(g, {}).get(g)!)[key] = m;
    }
  const chunks = new Map<string, Buffer>();
  const put = (g: string, kind: string, value: unknown): ChunkRef => {
    const bytes = Buffer.from(JSON.stringify({ build, group: g, kind, ...(value as object) }));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file = `lib/${g}.${kind}.${sha256.slice(0, 16)}.json`;
    chunks.set(file, bytes);
    return { file, sha256, size: bytes.length };
  };
  const refs: LibManifest["chunks"] = {};
  for (const [g, f] of [...src].sort((a, b) => a[0].localeCompare(b[0]))) {
    const modules = pre.get(g);
    refs[g] = { src: put(g, "src", { files: f }), ...(modules ? { pre: put(g, "pre", { modules: Object.fromEntries(Object.entries(modules).sort((a, b) => a[0].localeCompare(b[0]))) }) } : {}) };
  }
  for (const [g, f] of [...pkgGroups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const modules = pre.get(g);
    refs[g] = { src: put(g, "src", { files: f }), ...(modules ? { pre: put(g, "pre", { modules: Object.fromEntries(Object.entries(modules).sort((a, b) => a[0].localeCompare(b[0]))) }) } : {}) };
  }
  // (a mode's start: the library's groups in START_ORDER, then the packages' it imported)
  const rank = (g: string) => (g.startsWith("pkg-") ? START_ORDER.length : START_ORDER.indexOf(g as any));
  const modes: Record<string, string[]> = {};
  for (const m of ["sage", "matlab", "magma"]) {
    if (!sets[m]) continue;
    const gs = new Set([...sets[m]].map(groupOfPath).filter((g): g is string => g !== undefined));
    modes[m] = [...gs].sort((a, b) => rank(a) - rank(b));
  }
  return { manifest: { build, files, chunks: refs, modes, packages: { registry: packages.registry, files: pkgFiles } }, chunks };
}
