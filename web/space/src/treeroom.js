// A directory's room: the browsable filesystem.  A space can carry a whole tree (`tree`: a repository's files at one
// commit, their lengths and their imports; gen-repo.mjs writes one) instead of objects; each directory is then a room
// of its own: its subdirectories (sized by how many files they hold, and entered in turn) and its files (sized by
// length; a file's text is fetched from `tree.base` when it is opened, and a Python or Sage file is entered as its own
// room).  Its links: the imports between what is in it, a subdirectory standing for everything inside it.
//   treeRoom(tree, dir)  -> a sagebrush-space ("" is the top)
import { layered } from "./roomlayout.js";
import { LIMITS } from "./read.js";

const EXT = { py: "python", sage: "sage", pyx: "python", ts: "typescript", mts: "typescript", tsx: "typescript", js: "javascript", mjs: "javascript",
  rs: "rust", m: "matlab", magma: "magma", json: "json", md: "markdown", sh: "bash", toml: "toml", yml: "yaml", yaml: "yaml", html: "html", css: "css" };
export const langOfPath = (p) => EXT[/\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase()] ?? "";

export function treeRoom(tree, dir = "") {
  linkImports(tree);
  const files = tree.files, prefix = dir ? dir + "/" : "";
  // (which of this room's objects holds file k: the file itself, or the subdirectory it is under)
  const holder = new Array(files.length).fill(null);
  const nodes = [], byId = new Map();
  files.forEach(([path, lines, doc], k) => {
    if (!path.startsWith(prefix)) return;
    const rest = path.slice(prefix.length), slash = rest.indexOf("/");
    if (slash < 0) {
      // (doc: a workspace's notebook or board, which is a document rather than a file of text)
      const isDoc = doc === "notebook" || doc === "board";
      const nd = { id: "p:" + path, kind: "file", title: path, path, group: dir || "(top)", lang: isDoc ? doc : langOfPath(path), lines, text: "",
        src: tree.base + path.split("/").map(encodeURIComponent).join("/"), ...(isDoc ? { doc } : {}) };
      nodes.push(nd); byId.set(nd.id, nd); holder[k] = nd.id;
    } else {
      const sub = prefix + rest.slice(0, slash), id = "d:" + sub;
      let nd = byId.get(id);
      if (!nd) {
        nd = { id, kind: "dir", title: rest.slice(0, slash) + "/", path: sub, group: "directories", files: 0, lines: 0, enter: { kind: "dir", path: sub }, _list: new Set() };
        nodes.push(nd); byId.set(id, nd);
      }
      nd.files++; nd.lines += lines;
      const inner = rest.slice(slash + 1), j = inner.indexOf("/");
      nd._list.add(j < 0 ? inner : inner.slice(0, j) + "/");
      holder[k] = id;
    }
  });
  if (!nodes.length) throw new Error(`no files under ${dir || "the top"}`);
  for (const nd of nodes) {
    if (nd.kind !== "dir") continue;
    const list = [...nd._list].sort((a, b) => (b.endsWith("/") - a.endsWith("/")) || a.localeCompare(b));
    nd.text = list.slice(0, 40).join("\n") + (list.length > 40 ? `\n… and ${list.length - 40} more` : "");
    nd.summary = `${nd.files} file${nd.files === 1 ? "" : "s"}, ${nd.lines.toLocaleString("en-US")} lines`;
    delete nd._list;
  }
  const edges = [], seen = new Map();
  for (const [a, b] of tree.imports ?? []) {
    const from = holder[a], to = holder[b];
    if (!from || !to || from === to) continue;
    const k = from + ">" + to;
    if (seen.has(k)) { seen.get(k).n++; continue; }
    const e = { from, to, kind: "imports", n: 1 };
    seen.set(k, e); edges.push(e);
  }
  nodes.sort((x, y) => (x.kind === "dir" ? 0 : 1) - (y.kind === "dir" ? 0 : 1) || x.title.localeCompare(y.title));
  nodes.forEach((n, i) => (n.order = i));
  for (const nd of nodes) if (!edges.some((e) => e.from === nd.id || e.to === nd.id)) nd.shelf = true;
  // (a room within the viewer's limits, before it is laid out: a folder of more files than a space may have objects
  //  isn't shown)
  if (nodes.length > LIMITS.nodes) throw new Error(`the folder has more than ${LIMITS.nodes} entries`);
  if (edges.length > LIMITS.edges) throw new Error(`the folder has more than ${LIMITS.edges} links`);
  layered(nodes, edges);
  const name = dir ? dir.split("/").pop() + "/" : tree.name ?? "the repository";
  const nf = nodes.filter((n) => n.kind === "file").length, nd = nodes.length - nf;
  return {
    format: "sagebrush-space", version: 1, title: dir ? `${tree.name ?? ""}/${dir}` : name,
    summary: `${nd} director${nd === 1 ? "y" : "ies"} and ${nf} file${nf === 1 ? "" : "s"}${tree.commit ? ` · at commit ${String(tree.commit).slice(0, 10)}` : ""}`,
    room: { kind: "dir", path: dir, labels: [] }, directed: true, tree, nodes, edges,
  };
}

// Where a Python import leads in the tree: `from .x import a`, `import pkg.mod`, `from pkg import sub` (a submodule
// when there is one), as gen-repo.mjs resolves them: { path, sub } (sub: the one name taken is that submodule), or
// null for what isn't in the repository (the standard library, a package from elsewhere).  `names`: the names taken
// from the module (`from mod import a, b`), as the module calls them.
const dottedOf = new WeakMap();
export function resolveImport(tree, from, mod, names = []) {
  const files = tree.files;
  let idx = dottedOf.get(tree);
  if (!idx) {
    idx = { map: new Map(), paths: new Set(files.map((f) => f[0])) };
    for (const [p] of files) {
      if (!/\.py$/.test(p)) continue;
      const parts = p.replace(/\.py$/, "").replace(/\/__init__$/, "").split("/");
      for (let i = 0; i < parts.length; i++) {
        const key = parts.slice(i).join(".");
        if (!idx.map.has(key)) idx.map.set(key, []);
        idx.map.get(key).push(p);
      }
    }
    dottedOf.set(tree, idx);
  }
  const dir = (p) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
  const asFile = (p) => (idx.paths.has(p + ".py") ? p + ".py" : idx.paths.has(p + "/__init__.py") ? p + "/__init__.py" : null);
  const join = (...xs) => xs.filter(Boolean).join("/");
  if (mod.startsWith(".")) {
    const dots = mod.match(/^\.*/)[0].length;
    let d = dir(from);
    for (let i = 1; i < dots; i++) d = dir(d);
    const rest = mod.slice(dots).split(".").filter(Boolean);
    const base = join(d, ...rest);
    if (names.length === 1 && names[0] !== "*") { const sub = asFile(join(base, names[0])); if (sub) return { path: sub, sub: true }; }
    const p = asFile(base);
    return p ? { path: p, sub: false } : null;
  }
  const pick = (m) => {
    let ks = idx.map.get(m);
    if (!ks) return null;
    // (a one-word module is the repository's only beside the importer; several: the one nearest the importer)
    if (!m.includes(".")) ks = ks.filter((p) => dir(p.replace(/\/__init__\.py$/, "")) === dir(from));
    if (ks.length <= 1) return ks[0] ?? null;
    const score = (p) => { const a = p.split("/"), b = from.split("/"); let s = 0; while (s < a.length && a[s] === b[s]) s++; return s; };
    const best = ks.reduce((b, p) => (score(p) > score(b) ? p : b));
    return score(best) > 0 ? best : null;
  };
  if (names.length === 1 && names[0] !== "*") { const sub = pick(mod + "." + names[0]); if (sub) return { path: sub, sub: true }; }
  const p = pick(mod);
  return p ? { path: p, sub: false } : null;
}

// (a tree whose Python imports are given as written (`pyimports`: a path -> [module, ...names taken]): resolved to its
//  files once, into `imports`, as gen-repo.mjs resolves a repository's)
function linkImports(tree) {
  if (!tree.pyimports || tree._linked) return;
  tree._linked = true;
  const index = new Map(tree.files.map((f, k) => [f[0], k]));
  const seen = new Set((tree.imports ?? []).map((p) => p.join(",")));
  tree.imports = tree.imports ?? [];
  for (const [from, list] of Object.entries(tree.pyimports)) {
    const a = index.get(from);
    if (a === undefined || !Array.isArray(list)) continue;
    for (const [mod, ...names] of list) {
      const r = typeof mod === "string" ? resolveImport(tree, from, mod, names) : null;
      const b = r ? index.get(r.path) : undefined;
      if (b === undefined || b === a || seen.has(a + "," + b)) continue;
      seen.add(a + "," + b);
      tree.imports.push([a, b]);
    }
  }
}
