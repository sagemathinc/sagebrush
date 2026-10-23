// Core must not import the Cloudflare application's server code, which moves
// to sagemathinc/sagebrush-cloud (plan-cloud-split-r1 §2): no file outside
// web/{site,files,share,sync,lti}/ may import a module inside them.  The open
// sync protocol is web/sync-protocol/, and the share client web/share-client/.
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
    if (SERVER.test(path)) continue;
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

if (import.meta.main) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const SOURCE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|html)$/;
  const paths = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\n")
    .filter((f) => f && SOURCE.test(f) && !SERVER.test(f) && !f.includes("node_modules/") && !f.startsWith("upstream/"));
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
  const bad = serverImports(files);
  if (bad.length) {
    console.error("core imports server code (plan-cloud-split-r1 §2):\n  " + bad.join("\n  "));
    process.exit(1);
  }
  console.log(`no server imports in ${files.length} core source files`);
}
