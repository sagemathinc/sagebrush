// The browsable repository: a space carrying Sagebrush's whole tree at one commit (each text file's path and length,
// and the imports between files), entered directory by directory (src/treeroom.js); a file's text is fetched from
// GitHub at that commit when it is opened.  Only paths, lengths and links are written here, never file contents.
//   node gen-repo.mjs [COMMIT]      (default: origin/master)  -> public/sagebrush.space.json
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 1 << 30 });
const commit = git("rev-parse", process.argv[2] ?? "origin/master").trim();
const TEXT = /\.(py|sage|pyx|ts|mts|tsx|js|mjs|rs|m|magma|md|toml|ya?ml|sh|html|css|json)$/i;
// (-z: paths as they are, never quoted)
const entries = git("ls-tree", "-r", "-l", "-z", commit).split("\0").filter(Boolean).map((l) => {
  const [meta, path] = l.split("\t"), [, type, sha, size] = meta.split(/\s+/);
  return { type, sha, size: Number(size), path };
}).filter((e) => e.type === "blob" && TEXT.test(e.path) && e.size < 3_000_000 && !/\.min\.js$/.test(e.path));
entries.sort((a, b) => a.path.localeCompare(b.path));

// (each blob's text, all at once: git cat-file --batch)
const out = execFileSync("git", ["-C", repo, "cat-file", "--batch"], { input: entries.map((e) => e.sha).join("\n") + "\n", maxBuffer: 2 ** 31 });
const texts = [];
for (let at = 0, k = 0; k < entries.length; k++) {
  const nl = out.indexOf(10, at), size = Number(out.subarray(at, nl).toString().split(" ")[2]);
  texts.push(out.subarray(nl + 1, nl + 1 + size).toString("utf8"));
  at = nl + 1 + size + 1;
}
const index = new Map(entries.map((e, k) => [e.path, k]));
// Python modules by every dotted suffix of their path (lib/sagebrush/nf.py is nf, sagebrush.nf, lib.sagebrush.nf)
const dotted = new Map();
entries.forEach((e, k) => {
  if (!/\.py$/.test(e.path)) return;
  const parts = e.path.replace(/\.py$/, "").replace(/\/__init__$/, "").split("/");
  for (let i = 0; i < parts.length; i++) {
    const key = parts.slice(i).join(".");
    if (!dotted.has(key)) dotted.set(key, []);
    dotted.get(key).push(k);
  }
});
const pyModule = (from, mod) => {
  let ks = dotted.get(mod);
  if (!ks) return null;
  // (a one-word module (json, types) is one of the repository's only beside the importer: else it's the library's)
  if (!mod.includes(".")) ks = ks.filter((k) => posix.dirname(entries[k].path) === posix.dirname(from));
  if (ks.length <= 1) return ks[0] ?? null;
  // (several: the one sharing the most of the importer's directory, if any does)
  const top = (p) => p.split("/");
  const score = (k) => { const a = top(entries[k].path), b = top(from); let s = 0; while (s < a.length && a[s] === b[s]) s++; return s; };
  const best = ks.reduce((b, k) => (score(k) > score(b) ? k : b));
  return score(best) > 0 ? best : null;
};
// (from X import a, b; from X import (a,\n b); import a.b, c)
const PYIMP = /^[ \t]*(?:from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(?:\(([^)]*)\)|([\w., \t*]+))|import[ \t]+([\w., \t]+))/gm;
const JSIMP = /(?:import|export)\s[^;"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
const imports = new Set();
entries.forEach((e, k) => {
  const t = texts[k];
  const add = (j) => { if (j !== null && j !== undefined && j !== k) imports.add(k + "," + j); };
  if (/\.(py|sage|pyx)$/.test(e.path)) {
    for (const m of t.matchAll(PYIMP)) {
      if (m[4]) { for (const name of m[4].split(",")) add(pyModule(e.path, name.trim().split(/\s+/)[0])); continue; }
      const spec = m[1], names = (m[2] ?? m[3]).replace(/#.*$/gm, "").split(",").map((s) => s.trim().split(/\s+/)[0]).filter((s) => s && s !== "*");
      let base = spec;
      if (spec.startsWith(".")) {
        // (relative: from the importer's package)
        const dots = spec.match(/^\.*/)[0].length;
        let dir = posix.dirname(e.path);
        for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
        const rest = spec.slice(dots);
        const path = rest ? posix.join(dir, ...rest.split(".")) : dir;
        const asFile = (p) => index.get(p + ".py") ?? index.get(p + "/__init__.py") ?? null;
        const hits = names.map((n) => asFile(posix.join(path, n))).filter((j) => j !== null);
        if (hits.length) hits.forEach(add); else add(asFile(path));
        continue;
      }
      const subs = names.map((n) => pyModule(e.path, base + "." + n)).filter((j) => j !== null);
      if (subs.length) subs.forEach(add); else add(pyModule(e.path, base));
    }
  } else if (/\.(ts|mts|tsx|js|mjs)$/.test(e.path)) {
    for (const m of t.matchAll(JSIMP)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec.startsWith(".")) continue;
      const b = posix.join(posix.dirname(e.path), spec);
      for (const c of [b, b + ".ts", b + ".mts", b + ".tsx", b + ".js", b + ".mjs", b.replace(/\.js$/, ".ts"), b.replace(/\.mjs$/, ".mts"), b + "/index.ts", b + "/index.js"]) {
        if (index.has(c)) { add(index.get(c)); break; }
      }
    }
  }
});
const lines = (t) => (t.length ? t.split("\n").length - (t.endsWith("\n") ? 1 : 0) : 0);
const tree = {
  name: "sagebrush", commit,
  base: `https://raw.githubusercontent.com/sagemathinc/sagebrush/${commit}/`,
  files: entries.map((e, k) => [e.path, lines(texts[k])]),
  imports: [...imports].map((s) => s.split(",").map(Number)),
};
const space = {
  format: "sagebrush-space", version: 1,
  title: `Sagebrush's repository (master at ${commit.slice(0, 10)})`,
  summary: "The whole repository, directory by directory: enter a directory, then a Python or Sage file to see its functions and classes and what calls what.",
  nodes: [], tree,
};
const file = join(here, "public", "sagebrush.space.json");
writeFileSync(file, JSON.stringify(space) + "\n");
console.log(file + ":", entries.length, "files,", tree.imports.length, "imports, commit", commit.slice(0, 10));
