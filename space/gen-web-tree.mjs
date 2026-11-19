// The demo space of Sagebrush's own web/ tree: a node per source file (its first lines, for search and the sharp
// overlay), an edge per relative import, grouped by directory.  Writes public/web-tree.space.json.
//   node gen-web-tree.mjs [WEB_DIR]
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(process.argv[2] ?? join(here, "..", "web"));
const SKIP = /(^|\/)(dist|node_modules|public|fixtures|vendor)(\/|$)|\.min\.js$|(^|\/)test-|\.test\./;
const EXT = /\.(ts|mts|js|mjs)$/;
const files = [];
(function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const rel = relative(web, p);
    if (SKIP.test(rel)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (EXT.test(name) && st.size < 2_000_000) files.push(rel);
  }
})(web);
files.sort();
const ids = new Map(files.map((f, i) => [f, "f" + i]));
const IMPORT = /(?:import|export)\s[^;"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
function resolveImport(from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = join(dirname(from), spec);
  for (const c of [base, base + ".ts", base + ".mts", base + ".js", base + ".mjs", base.replace(/\.js$/, ".ts"), join(base, "index.ts"), join(base, "index.js")]) {
    if (ids.has(c)) return c;
  }
  return null;
}
const nodes = [], edges = [], seen = new Set();
for (const f of files) {
  const src = readFileSync(join(web, f), "utf8");
  const lines = src.split("\n");
  nodes.push({
    id: ids.get(f), kind: "file", title: f, group: dirname(f) === "." ? "web" : "web/" + dirname(f),
    lang: f.endsWith("ts") ? "typescript" : "javascript", lines: lines.length,
    text: lines.slice(0, 60).join("\n"),
  });
  for (const m of src.matchAll(IMPORT)) {
    const to = resolveImport(f, m[1] ?? m[2] ?? m[3]);
    if (to && to !== f) {
      const key = ids.get(f) + ">" + ids.get(to);
      if (!seen.has(key)) (seen.add(key), edges.push({ from: ids.get(f), to: ids.get(to) }));
    }
  }
}
const space = {
  format: "sagebrush-space", version: 1,
  title: "Sagebrush's web/ tree: " + nodes.length + " files and their imports",
  nodes, edges,
};
const out = join(here, "public", "web-tree.space.json");
writeFileSync(out, JSON.stringify(space) + "\n");
console.log(out, nodes.length, "files,", edges.length, "imports");
