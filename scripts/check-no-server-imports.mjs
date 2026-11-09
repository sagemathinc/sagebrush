// Two import rules, both checked here, in the job every CI run has.
//
// Server code (plan-cloud-split-r1 §2): no file outside web/{site,files,share,sync,lti}/
// may import a module inside them.  The open sync protocol is web/sync-protocol/,
// and the share client web/share-client/.
//
// License direction (William, Nov 8 2026: one repository, some parts MS-RSL):
// web/cloud/ is under the Microsoft Reference Source License (web/cloud/LICENSE.md),
// everything else is MIT OR Apache-2.0.  MS-RSL code may import MIT code, never the
// reverse; the supported forms the fence checks are listed above `CLOUD` below.
//
// Imports are found by Bun's own parser (Bun.Transpiler.scanImports), so
// comments and strings are handled as the bundler handles them: a commented
// `import(/* c */ "x")` is an import, and `"import('x')"` in a string or a
// comment is not.  HTML: each inline <script>'s code is scanned the same way,
// and each <script src> is a dependency.
//
//   bun scripts/check-no-server-imports.mjs     (exit 1 on any such import)
//   (scripts/test-check-no-server-imports.mjs tests it)
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER = /^web\/(site|files|share|sync|lti)(\/|$)/;
const LOADERS = { ts: "ts", mts: "ts", cts: "ts", tsx: "tsx", js: "js", mjs: "js", cjs: "js", jsx: "jsx" };

/** The relative specifiers `text` (a file at repository path `path`) depends on. */
export function specifiers(path, text) {
  const ext = path.split(".").pop();
  if (ext === "html") {
    const out = [];
    const html = text.replace(/<!--[\s\S]*?-->/g, "");
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1]);
      if (src) out.push(src[1]);
      if (m[2].trim()) out.push(...specifiers(path.replace(/\.html$/, ".mjs"), m[2]));
    }
    return out;
  }
  const loader = LOADERS[ext];
  if (!loader) return [];
  // (a #! line is not JavaScript; and type-only imports, which a bundler erases, still count:
  // `import type` and `export type … from` are scanned as the imports they name.  The rewrite can
  // only add imports: inside a string or comment it changes nothing the parser reports.)
  const code = text.replace(/^#![^\n]*/, "").replace(/\bimport\s+type(?=\s*[{*]|\s+[A-Za-z_$][\w$]*\s*(?:,|from\b))/g, "import").replace(/\bexport\s+type(?=\s*[{*])/g, "export");
  return new Bun.Transpiler({ loader }).scanImports(code).map((i) => i.path);
}

/** Every import, in the given files, that resolves into a server directory. */
export function serverImports(files) {
  const bad = [];
  for (const { path, text } of files) {
    // (web/cloud/ is server code too: it may import the server directories)
    if (SERVER.test(path) || CLOUD.test(path)) continue;
    let specs;
    try {
      specs = specifiers(path, text);
    } catch (e) {
      // (a file Bun can't parse is reported, not skipped: an unread file could hide an import)
      bad.push(`${path}: unparsable (${String(e?.message ?? e).split("\n")[0]})`);
      continue;
    }
    for (const spec of specs) {
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
      const target = posix.normalize(spec.startsWith("/") ? posix.join("web", spec) : posix.join(posix.dirname(path), spec));
      if (SERVER.test(target)) bad.push(`${path}: ${spec} -> ${target}`);
    }
  }
  return bad;
}

/** The repository path a relative specifier in `path` names (a leading "/" is web/'s root). */
function resolve(path, spec) {
  return posix.normalize(spec.startsWith("/") ? posix.join("web", spec) : posix.join(posix.dirname(path), spec));
}

// The license fence's supported forms (William, Nov 8 2026; astra C1/C2, daybreak3 E1/E2).  Outside web/cloud/:
// - no import of a module in it (static, dynamic, require, type-only, re-export, HTML script), resolved;
// - no `cloud` path segment in code: a string, template or regex in a .js/.ts file with its comments removed, any
//   text of an .html file outside its comments (inline scripts and attributes), or the text of a package.json,
//   tsconfig/jsconfig or pnpm-workspace.yaml.  A segment is `cloud` beside a quote, backquote or slash, so
//   "../cloud/x", "web/cloud", `${d}/cloud/` and a bare "cloud" all count, while cloudflare, cloudy and an
//   identifier named cloud don't.  This is fail-closed for computed loads: a path into web/cloud/ can't be
//   spelled without the segment, however it is joined.  The few texts that use the word as data, not a path,
//   are listed exactly in CLOUD_WORD_AS_DATA; the checker's own two files are exempt from this rule only;
// - no dependency on a package declared under web/cloud/ (its package.json "name"), by any version form
//   (workspace:*, ^1, a path), and no bare import of that name or a subpath of it;
// - no workspace (pnpm-workspace.yaml packages, a package.json "workspaces") whose globs match a package
//   directory in it;
// - and, in the builds that ship (web/build.ts, scripts/build-cli.mjs, scripts/js-bundle.mjs), no bundler input
//   from it: `cloudInputs` over each build's metafile, failing the build.
export const CLOUD = /^web\/cloud(\/|$)/;
/** The directory's name, for messages elsewhere (which may not spell it: the segment rule). */
export const CLOUD_ROOT = "web/cloud/";
/** The checker's own two files name web/cloud/ as data: exempt from the segment rule only, never from the import,
 * package and workspace rules. */
export const NAMES_CLOUD_AS_DATA = new Set(["scripts/check-no-server-imports.mjs", "scripts/test-check-no-server-imports.mjs"]);
/** Exact texts that use the word `cloud` as data, not a path: removed before the segment rule, nothing else of
 * their file is excused. */
export const CLOUD_WORD_AS_DATA = [
  // (the cross-server test's SERVER mode name; plan-r1 §5b moves the mode's harness load into web/cloud/ in PR 3a)
  { path: "web/workspace/test-doc-sync.mjs", text: 'process.env.SERVER === "cloud"' },
  { path: "web/workspace/test-doc-sync.mjs", text: 'CLOUD ? "cloud" : "ref"' },
  { path: "web/workspace/test-doc-sync.mjs", text: 'CLOUD ? "cloud" : "reference"' },
];
const SEGMENT = /(^|["'`\/])cloud($|["'`\/])/m;
const CONFIG = /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig[^/]*\.json|pnpm-workspace\.yaml)$/;
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const NAME_LISTS = ["bundleDependencies", "bundledDependencies"];

/** A glob of a workspace list (`*` within a name, `**` across) as a regular expression over directories. */
function globRe(glob) {
  const g = posix.normalize(glob.replace(/^\.\//, "").replace(/\/+$/, ""));
  return new RegExp("^" + g.split("/").map((p) => (p === "**" ? "(?:.*)" : p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))).join("/").replace(/\/\(\?:\.\*\)/g, "(?:/.*)?") + "$");
}

/** The segment rule's view of a file: its code without comments, its HTML outside comments, or its config text;
 * null for a file the rule doesn't read. */
function segmentText(path, text) {
  const ext = path.split(".").pop();
  if (ext === "html") {
    // (every attribute value, quoted or not, as a quoted string; and each inline script's code)
    const html = text.replace(/<!--[\s\S]*?-->/g, "");
    const parts = [...html.matchAll(/\s[^\s"'<>\/=]+\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/g)].map((m) => JSON.stringify(m[1].replace(/^["']|["']$/g, "")));
    for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) if (m[1].trim()) parts.push(new Bun.Transpiler({ loader: "js", deadCodeElimination: false, trimUnusedImports: false }).transformSync(m[1]));
    return parts.join("\n");
  }
  if (CONFIG.test(path)) return text;
  const loader = LOADERS[ext];
  if (!loader) return null;
  return new Bun.Transpiler({ loader, deadCodeElimination: false, trimUnusedImports: false }).transformSync(text.replace(/^#![^\n]*/, ""));
}

/** Every edge, in the given files, from MIT code into web/cloud/ (MS-RSL).  `files` may include web/cloud/'s own
 * package.json files: their names are the packages no MIT file may depend on. */
export function cloudImports(files) {
  const bad = [];
  const cloudNames = new Set();
  const cloudDirs = [];
  for (const { path, text } of files) {
    if (!CLOUD.test(path) || posix.basename(path) !== "package.json") continue;
    cloudDirs.push(posix.dirname(path));
    try {
      const name = JSON.parse(text).name;
      if (typeof name === "string" && name) cloudNames.add(name);
    } catch (e) {
      bad.push(`${path}: unparsable (${String(e?.message ?? e).split("\n")[0]})`);
    }
  }
  const namesCloud = (spec) => [...cloudNames].some((n) => spec === n || spec.startsWith(n + "/"));
  const workspaceHits = (where, globs) => {
    for (const g of globs) for (const d of cloudDirs) if (globRe(String(g)).test(d)) bad.push(`${where}: workspace ${g} includes ${d}`);
  };
  for (const { path, text } of files) {
    if (CLOUD.test(path)) continue;
    const base = posix.basename(path);
    if (base === "pnpm-workspace.yaml") {
      // (its packages list: "- glob" lines under "packages:")
      const m = /^packages:\s*\n((?:\s+-[^\n]*\n?)+)/m.exec(text);
      if (m) workspaceHits(path, [...m[1].matchAll(/-\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/gm)].map((x) => posix.join(posix.dirname(path), x[1].trim())));
    } else if (base === "package.json") {
      let pkg;
      try {
        pkg = JSON.parse(text);
      } catch (e) {
        bad.push(`${path}: unparsable (${String(e?.message ?? e).split("\n")[0]})`);
        continue;
      }
      for (const field of DEP_FIELDS) {
        for (const name of Object.keys(pkg[field] ?? {})) {
          // (by name, whatever the version form; a path-valued dependency or alias is a segment in the file's text)
          if (namesCloud(name)) bad.push(`${path}: ${field} ${name} is a web/cloud/ package`);
        }
      }
      for (const field of NAME_LISTS) for (const name of pkg[field] ?? []) if (namesCloud(String(name))) bad.push(`${path}: ${field} ${name} is a web/cloud/ package`);
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
      workspaceHits(path, ws.map((g) => posix.join(posix.dirname(path), String(g))));
    } else {
      let specs = [];
      try {
        specs = specifiers(path, text);
      } catch (e) {
        // (reported, and its raw text still goes through the segment rule below)
        bad.push(`${path}: unparsable (${String(e?.message ?? e).split("\n")[0]})`);
      }
      for (const spec of specs) {
        if (spec.startsWith(".") || spec.startsWith("/")) {
          const target = resolve(path, spec);
          if (CLOUD.test(target)) bad.push(`${path}: ${spec} -> ${target}`);
        } else if (namesCloud(spec)) bad.push(`${path}: ${spec} is a web/cloud/ package`);
      }
    }
    if (NAMES_CLOUD_AS_DATA.has(path)) continue;
    let seg;
    try {
      seg = segmentText(path, text);
    } catch {
      seg = text; // (unparsable code: already reported above; its raw text still mustn't name the segment)
    }
    if (seg == null) continue;
    for (const { path: p, text: t } of CLOUD_WORD_AS_DATA) if (p === path) seg = seg.split(t).join("");
    if (SEGMENT.test(seg)) bad.push(`${path}: a "cloud" path segment in its code (${(seg.match(new RegExp(".{0,30}" + SEGMENT.source + ".{0,30}", "m")) ?? [""])[0].trim()})`);
  }
  return bad;
}

/** The inputs, of a bundler metafile, that are files in web/cloud/: `inputs` as the metafile keys them (relative to
 * `cwd`, or absolute), `root` the repository. */
export function cloudInputs(inputs, cwd = process.cwd(), root = join(dirname(fileURLToPath(import.meta.url)), "..")) {
  return inputs.filter((i) => {
    const rel = posix.normalize(relative(root, isAbsolute(i) ? i : join(cwd, i)).split(sep).join("/"));
    return CLOUD.test(rel);
  });
}

/** Throws if any of a build's metafile `inputs` is a file in web/cloud/ (cloudInputs): every build that ships calls this on
 * its metafile, so a hit stops the build.  `label` names the bundle in the error. */
export function assertNoCloudInputs(inputs, label, cwd = process.cwd(), root = join(dirname(fileURLToPath(import.meta.url)), "..")) {
  const fromCloud = cloudInputs(inputs, cwd, root);
  if (fromCloud.length) throw new Error(`${label} takes inputs from ${CLOUD_ROOT}, which is MS-RSL: ${fromCloud.join(", ")}`);
}

if (import.meta.main) {
  const at = process.argv.indexOf("--root");
  const root = at > 0 ? process.argv[at + 1] : join(dirname(fileURLToPath(import.meta.url)), "..");
  const SOURCE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|html)$/;
  const paths = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\n")
    .filter((f) => f && !f.includes("node_modules/") && !f.startsWith("upstream/"))
    .filter((f) => (CLOUD.test(f) ? posix.basename(f) === "package.json" : SOURCE.test(f) || CONFIG.test(f)));
  const files = [];
  const unread = [];
  for (const path of paths) {
    // (every selected file is read and checked, whatever its size: an unread file could hide an edge)
    try {
      files.push({ path, text: readFileSync(join(root, path), "utf8") });
    } catch (e) {
      unread.push(`${path}: unreadable (${e?.code ?? e})`);
    }
  }
  // (a tracked symbolic link outside web/cloud/ whose target is in it: an alias no text names)
  for (const line of execFileSync("git", ["ls-files", "-s"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }).split("\n")) {
    const m = /^120000 [0-9a-f]+ \d+\t(.+)$/.exec(line);
    if (!m || CLOUD.test(m[1])) continue;
    let target;
    try {
      target = readlinkSync(join(root, m[1]));
    } catch (e) {
      unread.push(`${m[1]}: unreadable link (${e?.code ?? e})`);
      continue;
    }
    const rel = posix.normalize(posix.join(posix.dirname(m[1]), target.split(sep).join("/")));
    if (CLOUD.test(rel) || (isAbsolute(target) && CLOUD.test(relative(root, target).split(sep).join("/")))) unread.push(`${m[1]}: a link into web/cloud/ (${target})`);
  }
  const bad = serverImports(files.filter((f) => SOURCE.test(f.path) && !SERVER.test(f.path) && !CLOUD.test(f.path)));
  const cloud = [...unread, ...cloudImports(files)];
  if (bad.length) console.error("core imports server code (plan-cloud-split-r1 §2):\n  " + bad.join("\n  "));
  if (cloud.length) console.error("MIT code depends on web/cloud/, which is MS-RSL (web/cloud/README.md):\n  " + cloud.join("\n  "));
  if (bad.length || cloud.length) process.exit(1);
  console.log(`no server imports in core source files, and no MIT file of ${files.filter((f) => !CLOUD.test(f.path)).length} depends on web/cloud/`);
}
