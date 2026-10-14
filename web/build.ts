// bun web/build.ts  ->  web/dist/{index.html, llms.txt, sagebrush-worker.js, sagebrush-console.js,
//                                sagebrush-math.js, katex/, sagebrush-engine.wasm}
// The pyjs compiler and runtime for browsers: Node APIs are replaced by
// web/shims, the Python library is embedded, the Unicode name table is not.
import { mkdirSync, copyFileSync, statSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";

const here = import.meta.dir;
const shims: Record<string, string> = {
  fs: "fs.ts", vm: "vm.ts", path: "path.ts", os: "os.ts", crypto: "crypto.ts",
};
// the engine's content hash, in the URL the worker fetches it from: a new
// engine is never served from a cache
const engineSha256 = new Bun.CryptoHasher("sha256").update(readFileSync(join(here, "..", "wasm", "sagebrush-engine.wasm"))).digest("hex");
const engineHash = engineSha256.slice(0, 16);
// The bundled compiler and library (build/cli, scripts/build-cli.mjs) must be
// the current sources': the worker embeds that library, and the library
// compiled ahead below is compiled by that bundle.
const { buildId: currentBuildId } = await import("../scripts/build-id.mjs");
const buildId = /__SAGEBRUSH_BUILD_ID__ = "([0-9a-f]+)"/.exec(readFileSync(join(here, "..", "build", "cli", "lib.gen.js"), "utf8"))?.[1];
if (buildId !== currentBuildId(join(here, ".."))) throw new Error("build/cli is not the current sources' build: run node scripts/build-cli.mjs first");
// Library modules compiled ahead (src/compile.ts, precompiled): Sage mode's
// start, and the modules scientific notebooks import first, compiled by the
// CLI built from the same sources, so the worker does not compile 2 MB of
// Python at every page load.  Made before the worker, which carries the
// file's SHA-256 and uses it only if the bytes it fetched have it
// (design/security.md, SEC-8D6-1: a cached copy is origin storage).
mkdirSync(join(here, "dist"), { recursive: true });
const prePath = join(here, "dist", "sagebrush-precompiled.json");
rmSync(prePath, { force: true });
for (const args of [["--sage", "-c", "pass"], ["-c", "import numpy, matplotlib.pyplot, scipy.io, k3d, ipywidgets"]]) {
  const r = Bun.spawnSync(["node", join(here, "..", "build", "cli", "pyjs.cjs"), ...args], { env: { ...process.env, SAGEBRUSH_PRECOMPILE_OUT: prePath, SAGEBRUSH_NO_COMPILE_CACHE: "1" } });
  if (r.exitCode !== 0) throw new Error(`precompiling the library: ${r.stderr.toString().slice(0, 500)}`);
}
if (JSON.parse(readFileSync(prePath, "utf8")).build !== buildId) throw new Error("precompiling the library: build/cli/pyjs.cjs is not this build (run node scripts/build-cli.mjs)");
const precompiledHash = new Bun.CryptoHasher("sha256").update(readFileSync(prePath)).digest("hex");
const result = await Bun.build(<any>{
  metafile: true,
  define: { __SB_ENGINE_HASH__: JSON.stringify(engineSha256), __SB_PRECOMPILED_HASH__: JSON.stringify(precompiledHash) },
  entrypoints: [join(here, "worker.ts")],
  outdir: join(here, "dist"),
  naming: "sagebrush-worker.js",
  target: "browser",
  format: "esm",
  minify: true,
  plugins: [
    {
      name: "node-shims",
      setup(build) {
        build.onResolve({ filter: /^(node:)?(fs|vm|path|os|crypto)$/ }, (args) => ({ path: join(here, "shims", shims[args.path.replace(/^node:/, "")]) }));
        build.onResolve({ filter: /unames\.gen$/ }, () => ({ path: join(here, "shims", "unames.ts") }));
      },
    },
  ],
});
// The console (xterm.js), loaded only when it is opened.
const consoleResult = await Bun.build(<any>{
  metafile: true,
  entrypoints: [join(here, "console.ts")],
  outdir: join(here, "dist"),
  naming: "sagebrush-console.js",
  target: "browser",
  format: "esm",
  minify: true,
});
// Math in Markdown cells (KaTeX), loaded on first use.  (Markdown itself,
// small and usually in the first cell, is part of the page script.)
const mathResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "math.ts")], outdir: join(here, "dist"), naming: "sagebrush-math.js", target: "browser", format: "esm", minify: true });
// The notebook as a component (web/notebook), for other pages: web/embed.
const notebookResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "notebook", "index.js")], outdir: join(here, "dist"), naming: "sagebrush-notebook.js", target: "browser", format: "esm", minify: true });
// TimeTravel's history (web/notebook/history.js, with patchflow), loaded after the notebook
const historyResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "notebook", "history.js")], outdir: join(here, "dist"), naming: "sagebrush-history.js", target: "browser", format: "esm", minify: true });
// The reactive notebook's analyzer (web/analyze-worker.ts): pyparse and
// src/dataflow.ts in a worker of their own
const analyzeResult = await Bun.build(<any>{
  metafile: true,
  entrypoints: [join(here, "analyze-worker.ts")],
  outdir: join(here, "dist"),
  naming: "sagebrush-analyze.js",
  target: "browser",
  // (a classic worker: a module worker can't start from a blob: in a file,
  // which is how an exported board's engine runs; it has no imports anyway)
  format: "iife",
  minify: true,
  plugins: [{ name: "unames", setup(build) { build.onResolve({ filter: /unames\.gen$/ }, () => ({ path: join(here, "shims", "unames.ts") })); } }],
});
// A shared collection's page, /s/<id> (web/share/view.ts; design/sharing.md)
const shareResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "share", "view.ts")], outdir: join(here, "dist"), naming: "sagebrush-share.js", target: "browser", format: "esm", minify: true });
const builds: [string, any][] = [["the worker", result], ["the console", consoleResult], ["math", mathResult], ["the notebook component", notebookResult], ["TimeTravel", historyResult], ["the analyzer", analyzeResult], ["the shared collection page", shareResult]];
for (const r of [result, consoleResult, mathResult, notebookResult, historyResult, analyzeResult, shareResult]) {
  if (!r.success) {
    for (const m of r.logs) console.error(m);
    process.exit(1);
  }
}
// index.html with its page script bundled (with web/notebook, the notebook
// component, and web/markdown.ts) and minified, wrapped in a function so its
// names stay out of the global scope.
{
  const html = readFileSync(join(here, "index.html"), "utf8");
  const m = /<script id="app">([\s\S]*?)<\/script>/.exec(html)!;
  const tmp = join(here, "app.tmp.js"); // beside index.html: its imports are relative to web/
  writeFileSync(tmp, m[1] + "\nexport {};\n"); // an ES module: Bun would wrap a script in an uncalled CommonJS shim
  const app = await Bun.build(<any>{ metafile: true, entrypoints: [tmp], target: "browser", format: "iife", minify: true });
  builds.push(["the notebook page", app]);
  if (!app.success) {
    for (const l of app.logs) console.error(l);
    process.exit(1);
  }
  rmSync(tmp);
  const js = (await app.outputs[0].text()).trim();
  // (inlined in <script>: an end tag inside would end it early, and a <script
  // after a <!-- would make the parser skip its real end tag)
  if (/<\/?script/i.test(js)) throw new Error("the notebook page's script contains <script or </script, which breaks it inlined in index.html");
  writeFileSync(join(here, "dist", "index.html"), html.slice(0, m.index) + "<script>" + js + "</script>" + html.slice(m.index + m[0].length));
}
copyFileSync(join(here, "llms.txt"), join(here, "dist", "llms.txt"));
copyFileSync(join(here, "_headers"), join(here, "dist", "_headers"));
// the engines (modular symbols, a_p ...), fetched by the worker on first use
copyFileSync(join(here, "..", "wasm", "sagebrush-engine.wasm"), join(here, "dist", "sagebrush-engine.wasm"));
// The documentation index for the page's search box (lib/_pyjs_docsearch.py,
// run by the CLI bundle: build it first with npm run build:cli)
{
  const r = Bun.spawnSync(["node", join(here, "..", "build", "cli", "pyjs.cjs"), "-m", "_pyjs_docsearch", "--index"]);
  if (r.exitCode !== 0) {
    console.error("docs index: " + r.stderr.toString());
    process.exit(1);
  }
  writeFileSync(join(here, "dist", "docs-index.json"), r.stdout);
}
// KaTeX's stylesheet and (woff2) fonts, for math in Markdown cells
const katexDir = join(here, "..", "node_modules", "katex", "dist");
const KATEX = ["katex/katex.min.css", ...readdirSync(join(katexDir, "fonts")).filter((f) => f.endsWith(".woff2")).map((f) => "katex/fonts/" + f)];
mkdirSync(join(here, "dist", "katex", "fonts"), { recursive: true });
for (const f of KATEX) copyFileSync(join(katexDir, f.slice("katex/".length)), join(here, "dist", f));
// The atlas (web/atlas): its page script and engine worker, and llms.txt.
// Its pages are rendered by the site's Worker; its data (web/dist/atlas/data)
// comes from scripts/build-atlas.mjs and is not in git.
// atlas.js loads KaTeX and the templates (a split chunk) only to show a
// space computed in the browser.
for (const f of existsSync(join(here, "dist", "atlas")) ? readdirSync(join(here, "dist", "atlas")) : []) if (/^atlas-.*\.js$/.test(f)) rmSync(join(here, "dist", "atlas", f));
for (const [entry, name] of [["client.ts", "atlas.js"], ["engine-worker.ts", "atlas-engine.js"]]) {
  const r = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "atlas", entry)], outdir: join(here, "dist", "atlas"), naming: { entry: name, chunk: "atlas-[hash].js" }, splitting: true, target: "browser", format: "esm", minify: true });
  if (!r.success) {
    for (const l of r.logs) console.error(l);
    process.exit(1);
  }
  builds.push(["the atlas", r]);
}
copyFileSync(join(here, "atlas", "llms.txt"), join(here, "dist", "atlas", "llms.txt"));
if (!existsSync(join(here, "dist", "atlas", "data", "stats.json"))) console.warn("web/dist/atlas/data is missing: run scripts/build-atlas.mjs (see web/atlas/README.md)");
copyFileSync(join(here, "viewer3d.js"), join(here, "dist", "sagebrush-viewer3d.js"));
// the runner: the interpreter in an opaque-origin frame (web/runner; design/runner.md)
mkdirSync(join(here, "dist", "runner"), { recursive: true });
copyFileSync(join(here, "runner", "index.html"), join(here, "dist", "runner", "index.html"));
const { scriptHashes } = await import("./csp.ts");
const MIME: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript", json: "application/json", wasm: "application/wasm", css: "text/css", woff2: "font/woff2", png: "image/png", svg: "image/svg+xml", webmanifest: "application/manifest+json" };
// The engine, by its content (design/engines.md): what runs code, published
// at sagebrush.space/engine/<id>/ and kept forever (scripts/publish-engine.mjs),
// so that a board or notebook saved with one can keep running with it (an
// exported HTML file pins its id).  <id> is a hash of its api and each
// file's hash, size and response headers (web/engine-id.mts); the headers are
// in the manifest, which the site's Worker serves them with.  `api` is the version of the interface between a page
// and these files (WorkerKernel, RunnerWorker, the worker's messages): a page
// uses another engine only if its api is the same.
const ENGINE_API = 2;
let ENGINE: { id: string; api: number; files: Record<string, string> } = { id: "", api: ENGINE_API, files: {} };
const ENGINE_FILES = ["sagebrush-worker.js", "sagebrush-engine.wasm", "sagebrush-precompiled.json", "sagebrush-notebook.js", "sagebrush-analyze.js", "sagebrush-viewer3d.js", "runner/index.html"];
{
  const { runnerPolicy } = await import("./csp-policy.mts");
  const { engineIdText } = await import("./engine-id.mts");
  const sha = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
  const files: Record<string, { sha256: string; size: number; headers: Record<string, string> }> = {};
  for (const f of ENGINE_FILES) {
    const bytes = readFileSync(join(here, "dist", f));
    const headers: Record<string, string> = { "Content-Type": MIME[f.split(".").pop()!] };
    if (f.endsWith(".html")) Object.assign(headers, { "Content-Security-Policy": runnerPolicy(scriptHashes(bytes.toString("utf8"))), "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Opener-Policy": "same-origin" });
    files[f] = { sha256: sha(bytes), size: bytes.length, headers };
  }
  const id = sha(engineIdText(ENGINE_API, files)).slice(0, 20);
  rmSync(join(here, "dist", "engine"), { recursive: true, force: true });
  for (const f of ENGINE_FILES) {
    mkdirSync(dirname(join(here, "dist", "engine", id, f)), { recursive: true });
    copyFileSync(join(here, "dist", f), join(here, "dist", "engine", id, f));
  }
  writeFileSync(join(here, "dist", "engine", id, "manifest.json"), JSON.stringify({ format: "sagebrush-engine", id, api: ENGINE_API, files }, null, 1) + "\n");
  writeFileSync(join(here, "dist", "engine", "latest.json"), JSON.stringify({ id, api: ENGINE_API }) + "\n");
  mkdirSync(join(here, "site", "public", "engine"), { recursive: true });
  copyFileSync(join(here, "dist", "engine", "latest.json"), join(here, "site", "public", "engine", "latest.json"));
  ENGINE = { id, api: ENGINE_API, files: Object.fromEntries(Object.entries(files).map(([f, d]) => [f, d.sha256])) };
  console.log(`engine ${id} (api ${ENGINE_API}): web/dist/engine/${id}/`);
}
// Boards (design/board.md), at /board/, with their example documents
{
  const r = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "board", "page.ts")], outdir: join(here, "dist", "board"), naming: "board.js", target: "browser", format: "esm", minify: true,
    // (the engine it was built with, by its files' SHA-256s: an exported board pins it, design/engines.md)
    define: { __SB_ENGINE__: JSON.stringify(ENGINE) } });
  if (!r.success) {
    for (const l of r.logs) console.error(l);
    process.exit(1);
  }
  builds.push(["the board", r]);
  copyFileSync(join(here, "board", "index.html"), join(here, "dist", "board", "index.html"));
  mkdirSync(join(here, "dist", "board", "examples"), { recursive: true });
  for (const f of readdirSync(join(here, "board", "examples"))) if (/\.(json|md|mmd)$/.test(f)) copyFileSync(join(here, "board", "examples", f), join(here, "dist", "board", "examples", f));
  // (and the generated ones: scripts/board-examples.mjs)
  const gen = Bun.spawnSync(["node", join(here, "..", "scripts", "board-examples.mjs"), join(here, "dist", "board", "examples")]);
  if (gen.exitCode !== 0) { console.error(gen.stderr.toString()); process.exit(1); }
}
// The frame other sites show a board in (/frame/board/, design/frame.md):
// the exported board's page with every part inline but the document, which
// its parent posts (export.ts frameHtml)
{
  const { frameHtml, katexFontsInline } = await import("./board/export.ts");
  const css = katexFontsInline(readFileSync(join(here, "dist", "katex", "katex.min.css"), "utf8"), (f) => "data:font/woff2;base64," + readFileSync(join(here, "dist", "katex", f)).toString("base64"));
  mkdirSync(join(here, "dist", "frame", "board"), { recursive: true });
  writeFileSync(join(here, "dist", "frame", "board", "index.html"), frameHtml(readFileSync(join(here, "board", "index.html"), "utf8"), readFileSync(join(here, "dist", "board", "board.js"), "utf8"), readFileSync(join(here, "dist", "sagebrush-math.js"), "utf8"), css));
}
// The npm packages the bundles above contain (their metafiles' inputs) and
// KaTeX (its stylesheet and fonts, copied): web/js-dependencies.json, from
// which scripts/third-party-notices.mjs writes their notices; the page and
// the site carry packages/sagebrush/THIRD-PARTY-NOTICES.txt (it covers what
// the page runs: the runtime, its Python library, the engines, these).
{
  const root = join(here, "..");
  const pkgs = new Map<string, { dir: string; in: Set<string> }>();
  const vendored = new Map<string, string>(); // store dir -> the version actually bundled
  const add = (dir: string, what: string) => {
    if (!existsSync(join(root, dir, "package.json"))) {
      // code a package's own build vendored (patchflow's dist holds
      // @cocalc/diff-match-patch): the package from its .pnpm store entry
      const m = /\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(dir);
      // (the store's spelling of a scope separator: "+" or, before, "_")
      let store = m && [m[1], m[1].replace("_", "+"), m[1].replace("+", "_")].map((e) => `node_modules/.pnpm/${e}/node_modules/${m[2]}`).find((d) => existsSync(join(root, d, "package.json")));
      if (!store && m) {
        // another version of it in the store, the same major version: its
        // license (recorded as such below)
        const [, name, ver] = /^(.*)@([^@]+)$/.exec(m[1])!;
        const major = ver.split(".")[0];
        const alt = readdirSync(join(root, "node_modules", ".pnpm")).find((e) => [name, name.replace("_", "+")].some((n) => e.startsWith(n + "@" + major + ".")));
        if (alt) {
          store = `node_modules/.pnpm/${alt}/node_modules/${m[2]}`;
          vendored.set(store, ver);
        }
      }
      if (!store) throw new Error("no package.json for bundled code in " + dir);
      dir = store;
    }
    const j = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    const key = j.name + "@" + j.version;
    (pkgs.get(key) ?? pkgs.set(key, { dir, in: new Set() }).get(key)!).in.add(what);
  };
  for (const [what, r] of builds) {
    for (const input of Object.keys(r.metafile?.inputs ?? {})) {
      const abs = input.startsWith("/") ? input : join(process.cwd(), input);
      const i = abs.lastIndexOf("/node_modules/");
      if (i < 0) continue;
      const rest = abs.slice(i + "/node_modules/".length).split("/");
      const name = rest[0].startsWith("@") ? rest[0] + "/" + rest[1] : rest[0];
      add(abs.slice(root.length + 1, i + "/node_modules/".length) + name, what);
    }
  }
  add("node_modules/katex", "KaTeX's stylesheet and fonts (copied)");
  const list = [...pkgs].sort((a, b) => a[0].localeCompare(b[0])).map(([, p]) => {
    const j = JSON.parse(readFileSync(join(root, p.dir, "package.json"), "utf8"));
    const v = vendored.get(p.dir);
    return { name: j.name, version: v ?? j.version, license: j.license ?? null, path: p.dir, ...(v ? { license_from_version: j.version } : {}), in: [...p.in].sort() };
  });
  const text = JSON.stringify({ note: "generated by web/build.ts: the npm packages in the web bundles", packages: list }, null, 1) + "\n";
  writeFileSync(join(here, "js-dependencies.json"), text);
  const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
  const notices = readFileSync(join(here, "..", "packages", "sagebrush", "THIRD-PARTY-NOTICES.txt"), "utf8");
  if (!notices.includes(`web/js-dependencies.json ${hash}`)) {
    console.error("web/js-dependencies.json changed: run node scripts/third-party-notices.mjs, then this build again");
    process.exit(1);
  }
  writeFileSync(join(here, "dist", "THIRD-PARTY-NOTICES.txt"), notices);
}
// The Cloudflare site (web/site) serves the same files.
rmSync(join(here, "site", "public", "atlas"), { recursive: true, force: true });
cpSync(join(here, "dist", "atlas"), join(here, "site", "public", "atlas"), { recursive: true });
// the site Worker's build id: its edge cache of atlas pages is keyed on it
writeFileSync(join(here, "site", "src", "build-id.ts"), `// written by web/build.ts\nexport const BUILD = ${JSON.stringify(Date.now().toString(36))};\n`);
// boards (/board/)
rmSync(join(here, "site", "public", "board"), { recursive: true, force: true });
cpSync(join(here, "dist", "board"), join(here, "site", "public", "board"), { recursive: true });
rmSync(join(here, "site", "public", "frame"), { recursive: true, force: true });
cpSync(join(here, "dist", "frame"), join(here, "site", "public", "frame"), { recursive: true });
mkdirSync(join(here, "site", "public", "katex", "fonts"), { recursive: true });
// the 3D viewer, loaded by the page when a Graphics3d is shown
// The app (PWA): manifest, icons, and the service worker with the files it
// keeps for offline use, versioned by their content
const ICONS = readdirSync(join(here, "icons")).map((f) => "icons/" + f);
mkdirSync(join(here, "dist", "icons"), { recursive: true });
for (const f of ICONS) copyFileSync(join(here, f), join(here, "dist", f));
copyFileSync(join(here, "manifest.webmanifest"), join(here, "dist", "manifest.webmanifest"));
const SHELL = ["./", "sagebrush-worker.js", "docs-index.json", `sagebrush-engine.wasm?h=${engineHash}`, `sagebrush-precompiled.json?h=${precompiledHash.slice(0, 16)}`, "sagebrush-console.js", "sagebrush-math.js", "sagebrush-viewer3d.js", "sagebrush-history.js", "sagebrush-analyze.js", "manifest.webmanifest", ...ICONS, ...KATEX];
const shellHash = new Bun.CryptoHasher("sha256");
for (const f of ["index.html", "docs-index.json", "sagebrush-worker.js", "sagebrush-console.js", "sagebrush-math.js", "sagebrush-viewer3d.js", "sagebrush-history.js", "sagebrush-analyze.js", "manifest.webmanifest"]) shellHash.update(readFileSync(join(here, "dist", f)));
shellHash.update(engineHash + precompiledHash);
// (each of them by its SHA-256, and the response it is served as: the service
// worker serves a kept copy only if it still has those bytes, and then as a
// response it makes, with this status and these headers, never the kept
// response's own; design/security.md, SEC-8D6-1, SEC-522-1)
const { pagePolicy } = await import("./csp-policy.mts");
const DIGESTS = Object.fromEntries(SHELL.map((p) => {
  const file = p === "./" ? "index.html" : p.split("?")[0];
  const bytes = readFileSync(join(here, "dist", file));
  const mime = MIME[file.split(".").pop()!];
  if (!mime) throw new Error(`sw.js: no type for ${file}`);
  // (as web/_headers and web/csp.ts give it: every file cross-origin isolated, a page its policy)
  const headers: Record<string, string> = { "Content-Type": mime, "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
  if (file.endsWith(".html")) headers["Content-Security-Policy"] = pagePolicy(scriptHashes(bytes.toString("utf8")));
  return [p.split("?")[0], { sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), headers }];
}));
writeFileSync(join(here, "dist", "sw.js"), readFileSync(join(here, "sw.js"), "utf8").replace("__VERSION__", shellHash.digest("hex").slice(0, 16)).replace("__SHELL__", JSON.stringify(SHELL)).replace("__DIGESTS__", JSON.stringify(DIGESTS)));
mkdirSync(join(here, "site", "public", "icons"), { recursive: true });
// the notebook component's demo page (web/embed)
mkdirSync(join(here, "dist", "embed"), { recursive: true });
copyFileSync(join(here, "embed", "index.html"), join(here, "dist", "embed", "index.html"));
mkdirSync(join(here, "site", "public", "embed"), { recursive: true });
mkdirSync(join(here, "site", "public", "runner"), { recursive: true });
// the shared collection page, served for /s/<id> by the site's Worker
mkdirSync(join(here, "dist", "s"), { recursive: true });
copyFileSync(join(here, "share", "view.html"), join(here, "dist", "s", "index.html"));
mkdirSync(join(here, "site", "public", "s"), { recursive: true });
for (const f of ["index.html", "THIRD-PARTY-NOTICES.txt", "llms.txt", "docs-index.json", "sagebrush-worker.js", "sagebrush-console.js", "sagebrush-math.js", "sagebrush-viewer3d.js", "sagebrush-notebook.js", "sagebrush-history.js", "sagebrush-analyze.js", "sagebrush-share.js", "s/index.html", "runner/index.html", "embed/index.html", "sagebrush-engine.wasm", "sagebrush-precompiled.json", "sw.js", "manifest.webmanifest", ...ICONS, ...KATEX])
  copyFileSync(join(here, "dist", f), join(here, "site", "public", f));
// the articles (articles/ in the repository) as static pages, sitemap.xml
await import("./build-articles.ts");
// every page's Content-Security-Policy, in _headers (web/csp.ts)
(await import("./csp.ts")).writeHeaders();
const size = statSync(join(here, "dist", "sagebrush-worker.js")).size;
console.log(`web/dist/sagebrush-worker.js ${(size / 1e6).toFixed(2)} MB, sagebrush-console.js ${(statSync(join(here, "dist", "sagebrush-console.js")).size / 1e3).toFixed(0)} kB`);
