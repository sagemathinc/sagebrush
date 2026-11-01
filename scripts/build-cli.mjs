// Build pyjs as one JavaScript file with the Python library embedded, and
// from it self-contained executables.
//
//   node scripts/build-cli.mjs           build/cli/pyjs.cjs (run with node or bun)
//   node scripts/build-cli.mjs --sea     + build/cli/pyjs-node   (Node single executable)
//   node scripts/build-cli.mjs --bun     + build/cli/pyjs-bun    (bun build --compile)
//   node scripts/build-cli.mjs --deno    + build/cli/pyjs-deno   (deno compile; --target=<triple> cross-compiles)
//   node scripts/build-cli.mjs --sandbox + build/cli/pyjs-sandbox (deno compile with no permissions:
//                                          no files, env, network or subprocesses; programs on stdin)
//
// The bundle is made by Bun (fast TypeScript bundler); the Python files in
// lib/ become globalThis.__PYJS_LIB__ (see libDir() in src/compile.ts).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { buildId as computeBuildId, libFiles } from "./build-id.mjs";
import { mkdtempSync, copyFileSync, existsSync } from "node:fs";

// deno compile embeds node_modules when it finds a package.json above the
// entry point; compile a copy of the bundle from an empty directory.  With
// `launcher`, the entry is the launcher (packages/sagebrush/bin/sagebrush.cjs,
// which runs a program in a worker thread so that Ctrl-C reaches it), and the
// bundle, beside it as pyjs.cjs, is included.
function denoCompile(flags, exe, launcher = false) {
  const dir = mkdtempSync(join(tmpdir(), "sagebrush-deno-"));
  if (launcher) {
    copyFileSync(bundle, join(dir, "pyjs.cjs"));
    copyFileSync(join(root, "packages", "sagebrush", "bin", "sagebrush.cjs"), join(dir, "sagebrush.cjs"));
    flags = [...flags, "--include", join(dir, "pyjs.cjs")];
  } else copyFileSync(bundle, join(dir, "sagebrush.cjs"));
  run("deno", ["compile", "--no-check", "--no-config", ...flags, "-o", exe, join(dir, "sagebrush.cjs")], { cwd: dir });
  // Windows targets get ".exe" appended.
  return existsSync(exe) ? exe : exe + ".exe";
}

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "build", "cli");
mkdirSync(out, { recursive: true });
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });

// 1. The Python library, as a JS object.
const lib = libFiles(root);
const version = JSON.parse(readFileSync(join(root, "packages", "sagebrush", "package.json"), "utf8")).version;
// The licenses and third-party notices, for `sagebrush --licenses` (the
// standalone executables are one file, with no room for a NOTICE beside it)
const notices = ["LICENSE-MIT", "LICENSE-APACHE", "cdn/LICENSE-CPython.txt", "LICENSE-Artistic-2.0.txt", "packages/sagebrush/THIRD-PARTY-NOTICES.txt"].map((f) => [f.split("/").pop(), readFileSync(join(root, f), "utf8")]);
// The build id names this compiler and library for the per-user compile
// cache (src/compile.ts): a hash of src/ and lib/.
// (scripts/build-id.mjs: the compiler, runtime and library, hashed)
const buildId = computeBuildId(root, lib);
// (the library itself gzipped, base64: src/lib-embed.ts decodes it once, when src/compile.ts first reads
// __PYJS_LIB__ at startup; a quarter of the bundle otherwise)
const libGzBytes = gzipSync(Buffer.from(JSON.stringify(lib), "utf8"), { level: 9 });
// (deterministic: node's gzip header has no file name (FLG 0) and MTIME 0; asserted, as no option sets them)
if (libGzBytes[3] !== 0 || libGzBytes.readUInt32LE(4) !== 0) throw new Error("lib.gen.js: the library's gzip header has a name or a time");
const libGz = libGzBytes.toString("base64");
writeFileSync(join(out, "lib.gen.js"), `import { installEmbeddedLib } from "../../src/lib-embed";\nglobalThis.__SAGEBRUSH_BUILD_ID__ = ${JSON.stringify(buildId)};\nglobalThis.__SAGEBRUSH_VERSION__ = ${JSON.stringify(version)};\ninstallEmbeddedLib(globalThis, ${JSON.stringify(libGz)});\nglobalThis.__SAGEBRUSH_NOTICES__ = ${JSON.stringify(notices)};\n`);
// (the same without the library, for the browser's worker, which fetches it
// in chunks: web/lib-lazy.ts)
writeFileSync(join(out, "lib-meta.gen.js"), `globalThis.__SAGEBRUSH_BUILD_ID__ = ${JSON.stringify(buildId)};\nglobalThis.__SAGEBRUSH_VERSION__ = ${JSON.stringify(version)};\nglobalThis.__SAGEBRUSH_NOTICES__ = ${JSON.stringify(notices)};\n`);
// The packages (packages/<name>/, scripts/packages.mjs): the registry and
// their files, which src/compile.ts imports on a sys.path miss after
// checking each against the registry's SHA-256
const { readPackages } = await import("./packages.mjs");
const packages = readPackages(root);
if (JSON.stringify(packages.registry, null, 2) + "\n" !== readFileSync(join(root, "packages", "registry.json"), "utf8")) throw new Error("packages/registry.json is out of date: run node scripts/packages.mjs");
writeFileSync(join(out, "packages.gen.js"), `globalThis.__SAGEBRUSH_PACKAGES__ = ${JSON.stringify(packages)};\n`);
// The engines (wasm/sagebrush-engine.wasm), embedded: the bundle stays one file.
// (and the PNG module, wasm/sagebrush-raster.wasm, decoded when a PNG is
// first written or read: src/runtime/raster.ts)
writeFileSync(join(out, "engine.gen.js"), `globalThis.__SAGEBRUSH_ENGINE__ = ${JSON.stringify(readFileSync(join(root, "wasm", "sagebrush-engine.wasm")).toString("base64"))};\n` +
  `globalThis.__SAGEBRUSH_RASTER__ = ${JSON.stringify(readFileSync(join(root, "wasm", "sagebrush-raster.wasm")).toString("base64"))};\n`);
// The notebook page for `sagebrush notebook` (src/notebook.ts), from web/dist
// (`bun web/build.ts`, which needs lib.gen.js: so on a fresh checkout run this
// script, the web build, then this script again).  Python runs natively
// there, so the page's worker and the wasm engines are not needed.
const web = {};
const webDir = join(root, "web", "dist");
for (const f of ["index.html", "sagebrush-console.js", "sagebrush-math.js", "sagebrush-viewer3d.js", "sagebrush-graphview.js", "sagebrush-history.js", "sagebrush-analyze.js", "sagebrush-remote.js", "sagebrush-export.js", "sagebrush-export-worker.js", "docs-index.json", "THIRD-PARTY-NOTICES.txt"]) {
  if (existsSync(join(webDir, f))) web[f] = readFileSync(join(webDir, f)).toString("base64");
}
// (the site's early-alpha notice is for sagebrush.space, not the page `sagebrush notebook` serves on this
// machine: its script tag and comment are taken out, web/alpha-banner.js)
if (web["index.html"]) {
  const page = Buffer.from(web["index.html"], "base64").toString("utf8");
  const without = page.replace(/<!-- the early-alpha notice[^\n]*-->\n<script src="\/alpha-banner\.js" defer><\/script>\n/, "");
  if (page.includes("alpha-banner") && without.includes("alpha-banner")) throw new Error("build-cli: the early-alpha notice's tag in web/dist/index.html changed; update its removal here");
  web["index.html"] = Buffer.from(without, "utf8").toString("base64");
}
// (`sagebrush board open`'s page, src/board-open.ts: the frame other sites show a board in, gzipped (1.4 MB, of
// which it serves only one copy; its scripts are text: 43%), and the policy the site serves it with, in _headers)
if (existsSync(join(webDir, "frame/board/index.html"))) web["frame/board/index.html.gz"] = gzipSync(readFileSync(join(webDir, "frame/board/index.html")), { level: 9 }).toString("base64");
if (existsSync(join(webDir, "_headers"))) web["_headers"] = readFileSync(join(webDir, "_headers")).toString("base64");
const katexDir = join(webDir, "katex");
const walkKatex = (dir) => {
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walkKatex(p);
    else web[relative(webDir, p)] = readFileSync(p).toString("base64");
  }
};
walkKatex(katexDir);
if (!web["index.html"]) console.log("note: no web/dist/index.html: `sagebrush notebook` will not be available in this bundle");
writeFileSync(join(out, "web.gen.js"), web["index.html"] ? `globalThis.__SAGEBRUSH_WEB__ = ${JSON.stringify(web)};\n` : "");
// The function catalog (catalog/SCHEMA.md), for search away from a source
// tree: {mode: {groups: {group: entries}, missing: [names]}} as JSON text, in
// the CLI only (the browser worker imports lib.gen.js, not this).
const catalog = {};
const catalogDir = join(root, "catalog");
for (const mode of existsSync(catalogDir) ? readdirSync(catalogDir).sort() : []) {
  const d = join(catalogDir, mode);
  if (!statSync(d).isDirectory()) continue;
  const groups = {};
  for (const f of readdirSync(d).sort()) if (f.endsWith(".json")) groups[f.slice(0, -".json".length)] = JSON.parse(readFileSync(join(d, f), "utf8"));
  const miss = existsSync(join(d, "missing.txt")) ? readFileSync(join(d, "missing.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
  catalog[mode] = { groups, missing: miss };
}
// (and the commit it is built from, for the catalog's links to the source,
// lib/_catalog.py source_url: only from a clean tree, whose lines are that
// commit's; none otherwise)
let commit = null;
try {
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--untracked-files=no") === "") commit = git("rev-parse", "HEAD");
} catch {
  // (no git: no links)
}
writeFileSync(join(out, "catalog.gen.js"), `globalThis.__SAGEBRUSH_CATALOG__ = ${JSON.stringify(JSON.stringify(catalog))};\nglobalThis.__SAGEBRUSH_COMMIT__ = ${JSON.stringify(commit)};\n`);
writeFileSync(join(out, "entry.ts"), `import "./lib.gen.js";\nimport "./packages.gen.js";\nimport "./engine.gen.js";\nimport "./web.gen.js";\nimport "./catalog.gen.js";\nimport "../../src/cli";\n`);

// 2. One CommonJS file for Node 22+ and Bun.
run("bun", ["build", join(out, "entry.ts"), "--target=node", "--format=cjs", "--minify-syntax", "--minify-whitespace",
  "--outfile", join(out, "pyjs.cjs")]);
const bundle = join(out, "pyjs.cjs");
writeFileSync(bundle, "#!/usr/bin/env node\n" + readFileSync(bundle, "utf8").replace(/^#!.*\n/, ""));
// The launcher (packages/sagebrush/bin/sagebrush.cjs, the npm package's
// command): Node's compile cache on, and a program run in a worker thread so
// that Ctrl-C raises KeyboardInterrupt in it.
writeFileSync(join(out, "pyjs"), readFileSync(join(root, "packages", "sagebrush", "bin", "sagebrush.cjs"), "utf8"), { mode: 0o755 });
// The npm package `sagebrush` (packages/sagebrush) ships this bundle.
mkdirSync(join(root, "packages", "sagebrush", "dist"), { recursive: true });
writeFileSync(join(root, "packages", "sagebrush", "dist", "sagebrush.cjs"), readFileSync(bundle, "utf8").replace(/^#!.*\n/, ""));
console.log(`bundle: ${bundle} (${(statSync(bundle).size / 1e6).toFixed(2)} MB, ${Object.keys(lib).length} library files)`);

// 3a. Node single executable application (node --build-sea, Node >= 25.5).
if (process.argv.includes("--sea")) {
  const cfg = join(out, "sea-config.json");
  writeFileSync(cfg, JSON.stringify({ main: bundle, output: join(out, "pyjs-node"), disableExperimentalSEAWarning: true, useCodeCache: true }));
  run(process.execPath, ["--build-sea", cfg]);
  console.log(`node SEA: ${join(out, "pyjs-node")} (${(statSync(join(out, "pyjs-node")).size / 1e6).toFixed(1)} MB)`);
}

// 3b. Bun single-file executable.
if (process.argv.includes("--bun")) {
  run("bun", ["build", join(out, "entry.ts"), "--compile", "--minify", "--bytecode", "--outfile", join(out, "pyjs-bun")]);
  console.log(`bun executable: ${join(out, "pyjs-bun")} (${(statSync(join(out, "pyjs-bun")).size / 1e6).toFixed(1)} MB)`);
}

// 3c. Deno single-file executable (same V8 as Node; cross-compiles with
// --target, e.g. aarch64-apple-darwin, x86_64-pc-windows-msvc).
if (process.argv.includes("--deno")) {
  const target = process.argv.find((a) => a.startsWith("--target="));
  const exe = denoCompile(["-A", ...(target ? [target] : [])], join(out, "pyjs-deno" + (target ? "-" + target.slice(9) : "")), true);
  console.log(`deno executable: ${exe} (${(statSync(exe).size / 1e6).toFixed(1)} MB)`);
}

// 3d. The sandbox: a Deno executable granted nothing (its entry is the
// bundle itself, not the launcher: a program in it runs on the main thread).  Permissions are fixed
// at compile time and --no-prompt makes every denial a PermissionError
// instead of a question on the terminal.  Programs come on stdin or as the
// interactive prompt; the embedded library still imports.  Add scoped grants
// with e.g. PYJS_SANDBOX_ALLOW="--allow-read=."
if (process.argv.includes("--sandbox")) {
  const target = process.argv.find((a) => a.startsWith("--target="));
  const extra = (process.env.PYJS_SANDBOX_ALLOW ?? "").split(/\s+/).filter(Boolean);
  const exe = denoCompile(["--no-prompt", ...extra, ...(target ? [target] : [])], join(out, "pyjs-sandbox" + (target ? "-" + target.slice(9) : "")));
  console.log(`sandbox executable: ${exe} (${(statSync(exe).size / 1e6).toFixed(1)} MB)${extra.length ? " grants: " + extra.join(" ") : ""}`);
}
