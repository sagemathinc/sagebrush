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
//   rill    Rill's (R's) start, checked after the others, so a file another start
//           uses stays in theirs (design/rill.md §6.1)
//   sprig   Sprig's start, checked last (design/sprig-mvp.md §6.1)
// that it is in; files no start uses are grouped by family (sage-more,
// matlab-more, magma-more; MATLAB's sparse LU, _matlab_lu and _matlab_colamd,
// is matlab-lu) or are a group of their own (mod-<name>: a
// top-level module or package, its name in lowercase letters, digits and
// "-"; scipy.special, scipy.stats and scipy.optimize are mod-scipy-special,
// mod-scipy-stats and mod-scipy-optimize, apart from scipy's other submodules;
// fredapi, yfinance and _sbdata_live together are mod-live-data).  Each package (packages/<name>/, scripts/packages.mjs) is a group too,
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
  /** group -> its offline item (web/offline-inventory.mts), set by web/build.ts */
  items?: Record<string, string>;
  /** the pinned zone data's index (web/tzdata-chunks.mts), for a browser's time */
  tzdata?: ChunkRef & { version: string };
};
export type Packages = { registry: { packages: Record<string, { dir: string }> }; files: Record<string, string> };

export const START_ORDER = ["core", "sci", "sage", "matlab", "magma", "rill", "sprig"] as const;

// (the mod- groups groupOf gives several top-level names on purpose, which the clash check below lets through)
const SHARED_MOD_GROUPS = new Set(["mod-live-data", "mod-pathlib", "mod-xml", "mod-time"]);
// (each mode's own families: a mode's group holds only these.  Any other file its start imports gets a group of its
// own (or its family's: the time module's _pytime and _tzrules, mod-time), so importing it never fetches a mode's
// start: `import time` fetched MATLAB's, weakref Magma's and os.path the scientific group (and Rill's
// `import operator` before them).  libChunks refuses a build where a mode's group holds anything else.)
export const MODE_FAMILIES: Record<string, (top: string) => boolean> = {
  sci: (t) => ["numpy", "matplotlib", "k3d", "ipywidgets", "scipy", "IPython", "mpl_toolkits", "pylab"].includes(t),
  sage: (t) => /^_?sage/.test(t),
  matlab: (t) => /^_matlab/.test(t),
  magma: (t) => /^_magma/.test(t),
  rill: (t) => t === "_rill",
  sprig: (t) => t === "_sprig",
};
const SHARED_FAMILY: Record<string, string> = { _pytime: "mod-time", _tzrules: "mod-time" };

/** why `path` may not be in `group` (a mode's group holds only that mode's own families), or null */
export function familyViolation(path: string, group: string): string | null {
  if (!Object.hasOwn(MODE_FAMILIES, group) || MODE_FAMILIES[group](path.split("/")[0].replace(/\.py$/, ""))) return null;
  return `library chunks: ${path} is in the ${group} group, but isn't one of ${group}'s own files (MODE_FAMILIES): a mode's start would fetch the whole ${group} group for it`;
}
// (pathlib and what it imports, CPython 3.14's Lib modules (P3a), imported together: one group, fetched on import, so
// the service worker and the manifest name one group, not eight; the CLI embeds the same files lazily,
// scripts/lazy-lib.mjs. None may be in a mode's start: libChunks refuses the build if one is.)
const PATHLIB_FAMILY = new Set(["pathlib", "glob", "fnmatch", "stat", "ntpath", "genericpath", "errno", "_os_lazy"]);
// (the xml package and the parser under it, pyexpat (P3c): one group, mod-xml, as daybreak2's SIZE design clear has
// it; xml.etree needs the parser always, so two groups would only add a fetch. Lazily embedded in the CLI too)
const XML_FAMILY = new Set(["xml", "pyexpat"]);

export function groupOf(path: string, sets: Record<string, Set<string>>): string {
  if (sets.py?.has(path) || (sets.sci?.has(path) && sets.sage?.has(path))) return "core";
  const top = path.split("/")[0].replace(/\.py$/, "");
  for (const g of ["sci", "sage", "matlab", "magma", "rill", "sprig"]) if (sets[g]?.has(path) && MODE_FAMILIES[g](top)) return g;
  // (a start's file that isn't that mode's own: a group of its own, never the mode's, nor another family's extras)
  if (["sci", "sage", "matlab", "magma", "rill", "sprig"].some((g) => sets[g]?.has(path))) return SHARED_FAMILY[top] ?? modGroup(top);
  // (Rill's files no start uses, by family, before the generic mod- fallback so none is ever mod-rill: the final
  // routing from A1's first file, so no later phase renames or removes a group, design/rill.md §6.1)
  if (top === "_rill") {
    if (/^_rill\/ggplot2\//.test(path)) return "rill-ggplot2";
    if (/^_rill\/(dplyr\/|tibble\.py$)/.test(path)) return "rill-dplyr";
    if (/^_rill\/data\//.test(path)) return "rill-data";
    return "rill-more";
  }
  // (Sprig's files no start uses, the same way: plotting is its own group, anything else sprig-more, never mod-sprig;
  // final from S1's first file, design/sprig-mvp.md §6.1)
  if (top === "_sprig") return path === "_sprig/plot.py" ? "sprig-plot" : "sprig-more";
  if (PATHLIB_FAMILY.has(top)) return "mod-pathlib";
  if (XML_FAMILY.has(top)) return "mod-xml";
  // (elliptic curves over GF(p), imported only by EllipticCurve() over a
  // finite field: its own group, so sage-more's users don't fetch it)
  if (top === "_sage_ec_ff") return "mod-sage-ec-ff";
  if (/^_?sage/.test(top)) return "sage-more";
  // (live data's small modules, imported together: fredapi and its bridge, and yfinance's refusal; one group,
  // design-data-access r3.1)
  if (top === "fredapi" || top === "yfinance" || top === "_sbdata_live") return "mod-live-data";
  // (MATLAB mode's sparse LU, imported only by a measured sparse solve: its
  // own group, so the other MATLAB extras' users don't fetch it)
  if (/^_matlab_(lu|colamd)$/.test(top)) return "matlab-lu";
  if (/^_matlab/.test(top)) return "matlab-more";
  if (/^_magma/.test(top)) return "magma-more";
  // (scipy.special, scipy.stats and scipy.optimize: each a group of its own,
  // mod-scipy-special, mod-scipy-stats and mod-scipy-optimize, so that
  // importing scipy's other submodules (mod-scipy) doesn't fetch them, nor they
  // those)
  const sub = /^scipy\/(special|stats|optimize)(?:\.py$|\/)/.exec(path);
  if (sub) return "mod-scipy-" + sub[1];
  return modGroup(top);
}
// (lowercase letters, digits and "-": an engine file's name has nothing
// else, web/engines.ts; mod-future for __future__, mod-ipython for IPython)
const modGroup = (top: string) => "mod-" + top.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

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
    // (a lazily embedded module is in no start: P3a's guard, the browser's half; web/test-cli-lazy-lib.mjs the CLI's)
    if ((PATHLIB_FAMILY.has(path.split("/")[0].replace(/\.py$/, "")) && g !== "mod-pathlib") || (XML_FAMILY.has(path.split("/")[0].replace(/\.py$/, "")) && g !== "mod-xml")) throw new Error(`library chunks: ${path} is lazily embedded but a mode's start imports it (${g})`);
    // (two top-level names that would share a group's name: never silently
    // merged, but for a private module and its public twin, _string and
    // string, which are imported together)
    const top = path.split("/")[0].replace(/\.py$/, "").replace(/^_(?!_)/, "");
    if (g.startsWith("mod-") && !SHARED_MOD_GROUPS.has(g) && (tops.get(g) ?? top) !== top) throw new Error(`library chunks: ${tops.get(g)} and ${top} would both be ${g}`);
    tops.set(g, top);
    const bad = familyViolation(path, g);
    if (bad) throw new Error(bad);
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
  // (a mode's start: the library's groups in START_ORDER, then its files' own groups, then the packages' it imported)
  const rank = (g: string) => (g.startsWith("pkg-") ? START_ORDER.length + 1 : START_ORDER.includes(g as any) ? START_ORDER.indexOf(g as any) : START_ORDER.length);
  const modes: Record<string, string[]> = {};
  for (const m of ["sage", "matlab", "magma", "rill", "sprig"]) {
    if (!sets[m]) continue;
    const gs = new Set([...sets[m]].map(groupOfPath).filter((g): g is string => g !== undefined));
    modes[m] = [...gs].sort((a, b) => rank(a) - rank(b));
  }
  return { manifest: { build, files, chunks: refs, modes, packages: { registry: packages.registry, files: pkgFiles } }, chunks };
}
