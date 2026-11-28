// The example "How the 3D view works" (/space/self.space.json), written by web/build.ts from this checkout: the 3D
// view's own code as a space, to learn how it works. Each source file, and each part of the two long ones (main.ts and
// xr.ts, split where their sections begin), with what it is for (self-text.json: its summary), the first lines of its
// text and its length; links for imports and for who calls whom across the parts; an overview; and guided tours.
// Only previews are in the file (as Modular forms has), so nothing is fetched when it is shown; a preview line that the
// push text check would catch is left out, and says so.
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { textProblems } from "./text-check.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PREVIEW = 60; // (lines of each file or part shown on its face)

// (the files, by their paths under web/; the two long ones are split into parts at their section headers)
const FILES = ["space/src/code.ts", "space/src/coderoom.ts", "space/src/ground.ts", "space/src/jsroom.ts", "space/src/keep.ts",
  "space/src/layout.ts", "space/src/nbroom.ts", "space/src/pyroom.ts", "space/src/read.ts", "space/src/roomlayout.ts", "space/src/run.ts",
  "space/src/sizes.ts", "space/src/tex.ts", "space/src/treeroom.ts", "workspace/space3d.ts", "xr-input.js", "space/index.html", "space/format.md"];
const SPLIT: Record<string, { header: RegExp; parts: [string, string][] }> = {
  "space/src/main.ts": { header: /^\/\/ -{20,} /, parts: [["scene", "the scene"], ["ground", "the ground"], ["objects", "objects"],
    ["flying", "flying, Back and Forward"], ["picking", "picking"], ["selection", "selection"], ["tours", "guided tours"], ["rooms", "rooms"],
    ["running", "running code"], ["walking", "walking"], ["search", "search"], ["start", "which space"], ["headset", "a headset"]] },
  "space/src/xr.ts": { header: /^ {2}\/\/ -{20,} /, parts: [["setup", "setup and the rig"], ["menumesh", "the wrist menu's mesh"],
    ["controllers", "the controllers"], ["moving", "moving, Back and Forward"], ["panel", "the reading panel"], ["menu", "the wrist menu"],
    ["pointing", "pointing and selecting"], ["frame", "each frame"], ["enter", "entering and leaving"]] },
};

const linesOf = (t: string) => (t.length ? t.split("\n").length - (t.endsWith("\n") ? 1 : 0) : 0);
// (a preview: the first lines, any the push text check would catch replaced by a note that one is left out)
function preview(text: string) {
  return text.split("\n").slice(0, PREVIEW).map((l) => (textProblems(l).length ? "  … (a line not shown here)" : l)).join("\n");
}
const langOf = (p: string) => (/\.(ts|js|mjs)$/.test(p) ? "js" : p.endsWith(".md") ? "markdown" : p.endsWith(".html") ? "html" : "text");

export function selfSpace(web: string) {
  const text = JSON.parse(readFileSync(join(here, "self-text.json"), "utf8"));
  const nodes: any[] = [], edges: any[] = [], has = new Set<string>(), seen = new Set<string>();
  const link = (a: string, b: string) => { const k = a + ">" + b; if (a !== b && has.has(a) && has.has(b) && !seen.has(k)) { seen.add(k); edges.push({ from: a, to: b }); } };
  const add = (id: string, title: string, body: string, group: string, lang: string) => {
    const summary = text.summaries[id];
    if (!summary) throw new Error(`web/space/examples/self.ts: no summary for ${id}`);
    nodes.push({ id, kind: "file", title, summary, lang, group, lines: linesOf(body), text: preview(body) });
    has.add(id);
  };
  // (the long files' parts)
  for (const [path, { header, parts }] of Object.entries(SPLIT)) {
    const lines = readFileSync(join(web, path), "utf8").split("\n"), starts = lines.flatMap((l, i) => (header.test(l) ? [i] : []));
    const cut = path.endsWith("xr.ts") ? [0, ...starts] : [0, ...starts.slice(1)];
    if (cut.length !== parts.length) throw new Error(`web/space/examples/self.ts: ${path} has ${cut.length} parts, not ${parts.length}`);
    parts.forEach(([key, name], k) => add(`${path}#${key}`, `${posix.basename(path)}: ${name}`, lines.slice(cut[k], cut[k + 1]).join("\n"), path, "js"));
  }
  for (const path of FILES) add(path, path, readFileSync(join(web, path), "utf8"), posix.dirname(path), langOf(path));
  // (imports between the files: each part of a split file imports what its file imports)
  const owner = (p: string) => (SPLIT[p] ? `${p}#${SPLIT[p].parts[0][0]}` : p);
  for (const from of [...Object.keys(SPLIT), ...FILES.filter((f) => /\.(ts|js)$/.test(f))]) {
    for (const m of readFileSync(join(web, from), "utf8").matchAll(/^import [^;]*?from ["'](\.{1,2}\/[^"']+)["']/gm)) {
      const to = posix.normalize(posix.join(posix.dirname(from), m[1]));
      link(owner(from), owner(to));
    }
  }
  for (const [a, b] of text.links) link(a, b);
  nodes.unshift({ id: "overview", kind: "note", title: "How the 3D view works", group: "overview", summary: "Start here: the parts of the 3D view and how they fit, with guided tours in the panel.", text: text.overview });
  has.add("overview");
  for (const t of ["space/src/main.ts#scene", "space/src/xr.ts#setup", "workspace/space3d.ts", "space/src/run.ts"]) link("overview", t);
  for (const t of text.tours) for (const s of t.steps) if (!has.has(s.node)) throw new Error(`web/space/examples/self.ts: tour ${t.id} names no object ${s.node}`);
  return { format: "sagebrush-space", version: 1, title: "How the 3D view works: its own code", nodes, edges, tours: text.tours };
}
