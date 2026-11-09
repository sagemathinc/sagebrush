// Two import rules, both checked here, in the job every CI run has.
//
// Server code (plan-cloud-split-r1 §2): no file outside web/{site,files,share,sync,lti}/
// may import a module inside them.  The open sync protocol is web/sync-protocol/,
// and the share client web/share-client/.
//
// License direction (William, Nov 8 2026: one repository, some parts MS-RSL):
// web/cloud/ is under the Microsoft Reference Source License (web/cloud/LICENSE.md),
// everything else is MIT OR Apache-2.0.  MS-RSL code may import MIT code, never the
// reverse: no file outside web/cloud/ may import a module inside it, no source file
// outside it may name a path inside it in its code (comments are not code), and no
// package.json outside it may depend on it.
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
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER = /^web\/(site|files|share|sync|lti)(\/|$)/;
export const CLOUD = /^web\/cloud(\/|$)/;
/** The two files that name web/cloud/ as data, to check it: exempt from the path-in-code rule only, never from
 * the import and package rules. */
export const NAMES_CLOUD_AS_DATA = new Set(["scripts/check-no-server-imports.mjs", "scripts/test-check-no-server-imports.mjs"]);
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

/** Every edge, in the given files, from MIT code into web/cloud/ (MS-RSL): an import, a path in the
 * code (outside comments: `scanImports` misses a computed `import(dir + "/x.mjs")`, but not the literal
 * naming web/cloud/), or a package.json dependency. */
export function cloudImports(files) {
  const bad = [];
  for (const { path, text } of files) {
    if (CLOUD.test(path)) continue;
    if (posix.basename(path) === "package.json") {
      let pkg;
      try {
        pkg = JSON.parse(text);
      } catch (e) {
        bad.push(`${path}: unparsable (${String(e?.message ?? e).split("\n")[0]})`);
        continue;
      }
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "workspaces"]) {
        const deps = pkg[field];
        const values = Array.isArray(deps) ? deps : Object.values(deps ?? {});
        for (const v of values) {
          // (a workspace entry is a path even without "./"; a dependency is one only with a file:/link: or relative form)
          const spec = String(v).replace(/^(file|link|portal|workspace):/, "");
          const isPath = field === "workspaces" || spec !== String(v) || spec.startsWith(".") || spec.startsWith("/");
          if (isPath && CLOUD.test(posix.normalize(posix.join(posix.dirname(path), spec)))) bad.push(`${path}: ${field} ${v}`);
        }
      }
      continue;
    }
    let specs;
    try {
      specs = specifiers(path, text);
    } catch (e) {
      bad.push(`${path}: unparsable (${String(e?.message ?? e).split("\n")[0]})`);
      continue;
    }
    for (const spec of specs) {
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
      const target = resolve(path, spec);
      if (CLOUD.test(target)) bad.push(`${path}: ${spec} -> ${target}`);
    }
    const loader = LOADERS[path.split(".").pop()];
    if (!loader || NAMES_CLOUD_AS_DATA.has(path)) continue;
    // (the code without its comments, as the bundler sees it; a path into web/cloud/ there is an edge)
    let code;
    try {
      code = new Bun.Transpiler({ loader, deadCodeElimination: false, trimUnusedImports: false }).transformSync(text.replace(/^#![^\n]*/, ""));
    } catch {
      continue; // (already reported by specifiers, which parses the same text)
    }
    if (/web\/cloud(\/|["'`])/.test(code)) bad.push(`${path}: names web/cloud/ in its code`);
  }
  return bad;
}

if (import.meta.main) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const SOURCE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|html)$/;
  const paths = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\n")
    .filter((f) => f && (SOURCE.test(f) || posix.basename(f) === "package.json") && !CLOUD.test(f) && !f.includes("node_modules/") && !f.startsWith("upstream/"));
  const files = [];
  for (const path of paths) {
    let text;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    // (generated bundles and data, too large to be sources, are skipped by size)
    if (text.length > 4 << 20) continue;
    files.push({ path, text });
  }
  const bad = serverImports(files.filter((f) => !SERVER.test(f.path) && posix.basename(f.path) !== "package.json"));
  const cloud = cloudImports(files);
  if (bad.length) console.error("core imports server code (plan-cloud-split-r1 §2):\n  " + bad.join("\n  "));
  if (cloud.length) console.error("MIT code depends on web/cloud/, which is MS-RSL (web/cloud/README.md):\n  " + cloud.join("\n  "));
  if (bad.length || cloud.length) process.exit(1);
  console.log(`no server imports in core source files, and no MIT file of ${files.length} depends on web/cloud/`);
}
