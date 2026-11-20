// A directory's room: the browsable filesystem.  A space can carry a whole tree (`tree`: a repository's files at one
// commit, their lengths and their imports; gen-repo.mjs writes one) instead of objects; each directory is then a room
// of its own: its subdirectories (sized by how many files they hold, and entered in turn) and its files (sized by
// length; a file's text is fetched from `tree.base` when it is opened, and a Python or Sage file is entered as its own
// room).  Its links: the imports between what is in it, a subdirectory standing for everything inside it.
//   treeRoom(tree, dir)  -> a sagebrush-space ("" is the top)
import { layered } from "./roomlayout.js";

const EXT = { py: "python", sage: "sage", pyx: "python", ts: "typescript", mts: "typescript", tsx: "typescript", js: "javascript", mjs: "javascript",
  rs: "rust", m: "matlab", magma: "magma", json: "json", md: "markdown", sh: "bash", toml: "toml", yml: "yaml", yaml: "yaml", html: "html", css: "css" };
export const langOfPath = (p) => EXT[/\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase()] ?? "";

export function treeRoom(tree, dir = "") {
  const files = tree.files, prefix = dir ? dir + "/" : "";
  // (which of this room's objects holds file k: the file itself, or the subdirectory it is under)
  const holder = new Array(files.length).fill(null);
  const nodes = [], byId = new Map();
  files.forEach(([path, lines], k) => {
    if (!path.startsWith(prefix)) return;
    const rest = path.slice(prefix.length), slash = rest.indexOf("/");
    if (slash < 0) {
      const nd = { id: "p:" + path, kind: "file", title: path, path, group: dir || "(top)", lang: langOfPath(path), lines, text: "", src: tree.base + path.split("/").map(encodeURIComponent).join("/") };
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
  layered(nodes, edges);
  const name = dir ? dir.split("/").pop() + "/" : tree.name ?? "the repository";
  const nf = nodes.filter((n) => n.kind === "file").length, nd = nodes.length - nf;
  return {
    format: "sagebrush-space", version: 1, title: dir ? `${tree.name ?? ""}/${dir}` : name,
    summary: `${nd} director${nd === 1 ? "y" : "ies"} and ${nf} file${nf === 1 ? "" : "s"}${tree.commit ? ` · at commit ${String(tree.commit).slice(0, 10)}` : ""}`,
    room: { kind: "dir", path: dir, labels: [] }, directed: true, tree, nodes, edges,
  };
}
