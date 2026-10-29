// bun web/build.ts  ->  web/dist/{index.html, llms.txt, sagebrush-worker.js, sagebrush-console.js,
//                                sagebrush-math.js, katex/, sagebrush-engine.wasm, sagebrush-raster.wasm}
// The pyjs compiler and runtime for browsers: Node APIs are replaced by
// web/shims, the Python library is fetched in chunks (lib/), and the
// Unicode name table is left out.
import { mkdirSync, copyFileSync, statSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, cpSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { bundledPackageDir } from "./build-package-dir.mjs";

/** A site page with the early-alpha notice's script (web/alpha-banner.js), just before </head>. */
// (the same tag that board/export.ts's assemble() takes out of every board it makes from a page)
const ALPHA_BANNER_TAG = '<script src="/alpha-banner.js" defer></script>\n';
function withAlphaBanner(html: string): string {
  if (!html.includes("</head>")) throw new Error("build: a page without </head> for the early-alpha notice");
  return html.replace("</head>", ALPHA_BANNER_TAG + "</head>");
}
const here = import.meta.dir;
// (web/site/ when it is here; see web/site-dir.mts)
const { siteDir, hasSite } = await import("./site-dir.mts");
const shims: Record<string, string> = {
  fs: "fs.ts", vm: "vm.ts", path: "path.ts", os: "os.ts", crypto: "crypto.ts",
};
// the engine's content hash, in the URL the worker fetches it from: a new
// engine is never served from a cache
const engineSha256 = new Bun.CryptoHasher("sha256").update(readFileSync(join(here, "..", "wasm", "sagebrush-engine.wasm"))).digest("hex");
const engineHash = engineSha256.slice(0, 16);
// and the PNG module's (src/runtime/raster.ts), fetched the same way, the
// first time a PNG is written or read
const rasterSha256 = new Bun.CryptoHasher("sha256").update(readFileSync(join(here, "..", "wasm", "sagebrush-raster.wasm"))).digest("hex");
// The bundled compiler and library (build/cli, scripts/build-cli.mjs) must be
// the current sources': the library's chunks below hold that library, and
// its modules compiled ahead by that bundle.
const { buildId: currentBuildId } = await import("../scripts/build-id.mjs");
const buildId = /__SAGEBRUSH_BUILD_ID__ = "([0-9a-f]+)"/.exec(readFileSync(join(here, "..", "build", "cli", "lib.gen.js"), "utf8"))?.[1];
if (buildId !== currentBuildId(join(here, ".."))) throw new Error("build/cli is not the current sources' build: run node scripts/build-cli.mjs first");
// The Python library, in chunks fetched when they are first needed
// (web/lib-chunks.mts, web/lib-lazy.ts), with the modules each mode's start
// compiles compiled ahead (src/compile.ts, precompiled) by the CLI built from
// the same sources, so the worker does not compile 2 MB of Python at every
// page load.  Made before the worker, which carries their manifest: each
// chunk's SHA-256, checked before it is used (design/security.md, SEC-8D6-1:
// a cached copy is origin storage).
mkdirSync(join(here, "dist"), { recursive: true });
// (each mode's start, recorded apart: the library's chunks are made from
// them, web/lib-chunks.mts)
const STARTS: Record<string, string[]> = {
  // (_limits: no start imports it when no limits are given, src/limits.ts,
  // but a python session given limits does at its start, and the sage
  // group's fetch would cost it ~0.3 s: kept in core, plan-coldstart-limits)
  py: ["-c", "import json, re, math, fractions, collections, random, itertools, functools, _limits"],
  sci: ["-c", "import numpy, matplotlib.pyplot, scipy.io, k3d, ipywidgets"],
  sage: ["--sage", "-c", "pass"],
  matlab: ["--matlab", "-c", "1;"],
  magma: ["--magma", "-c", "1;"],
};
const recDir = mkdtempSync(join(tmpdir(), "sagebrush-precompile-"));
const recordings: Record<string, any> = {};
await Promise.all(Object.entries(STARTS).map(async ([mode, args]) => {
  const out = join(recDir, mode + ".json");
  const p = Bun.spawn(["node", join(here, "..", "build", "cli", "pyjs.cjs"), ...args], { env: { ...process.env, SAGEBRUSH_PRECOMPILE_OUT: out, SAGEBRUSH_NO_COMPILE_CACHE: "1" }, stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(`precompiling the library (${mode}): ${(await new Response(p.stderr).text()).slice(0, 500)}`);
  recordings[mode] = JSON.parse(readFileSync(out, "utf8"));
  if (recordings[mode].build !== buildId) throw new Error("precompiling the library: build/cli/pyjs.cjs is not this build (run node scripts/build-cli.mjs)");
}));
rmSync(recDir, { recursive: true, force: true });
const { libChunks } = await import("./lib-chunks.mts");
const { libFiles } = await import("../scripts/build-id.mjs");
const { readPackages } = await import("../scripts/packages.mjs");
const { manifest: libManifest, chunks: libChunkFiles } = libChunks(libFiles(join(here, "..")), recordings, buildId, readPackages(join(here, "..")));
rmSync(join(here, "dist", "lib"), { recursive: true, force: true });
mkdirSync(join(here, "dist", "lib"), { recursive: true });
for (const [f, bytes] of libChunkFiles) writeFileSync(join(here, "dist", f), bytes);
// (the pinned zone data, for the browser's time: web/tzdata-chunks.mts)
const { tzdataChunks } = await import("./tzdata-chunks.mts");
const tz = tzdataChunks(join(here, ".."));
libManifest.tzdata = tz.ref;
mkdirSync(join(here, "dist", "lib", "tzdata"), { recursive: true });
for (const [f, bytes] of tz.files) writeFileSync(join(here, "dist", f), bytes);
console.log(`zone data: tzdata ${tz.ref.version}, ${tz.files.size - 1} zone files (${([...tz.files.values()].reduce((n, b) => n + b.length, 0) / 1e3).toFixed(0)} kB), index ${(tz.ref.size / 1e3).toFixed(0)} kB`);
const LIB_CHUNKS = [...libChunkFiles.keys(), ...tz.files.keys()];
console.log(`library: ${LIB_CHUNKS.length} chunks; ` + Object.entries(libManifest.chunks).map(([g, c]) => `${g} ${(c.src.size / 1e3).toFixed(0)}+${((c.pre?.size ?? 0) / 1e3).toFixed(0)} kB`).join(", "));
// (the manifest, in the worker: web/lib-lazy.ts)
const libManifestHash = new Bun.CryptoHasher("sha256").update(JSON.stringify(libManifest)).digest("hex");
const result = await Bun.build(<any>{
  metafile: true,
  // (__dirname: Bun inlines a browser bundle's __dirname as the source's absolute directory, which made the
  // engine worker, and so its hash, the engine id and sw.js, depend on where the checkout is.  The worker's
  // only use is a Node-only fallback that looks for wasm/ beside the source (src/runtime/engine.ts, raster.ts),
  // unreachable in a browser; undefined sends it to process.cwd(), as when __dirname doesn't exist)
  define: { __SB_ENGINE_HASH__: JSON.stringify(engineSha256), __SB_RASTER_HASH__: JSON.stringify(rasterSha256), __SB_LIB__: JSON.stringify(libManifest), __dirname: "undefined" },
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
// The canvas view of a graph's picture (web/graph/view.ts), loaded by the
// notebook when Graph.plot's output first needs it
const graphResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "graph", "view.ts")], outdir: join(here, "dist"), naming: "sagebrush-graphview.js", target: "browser", format: "esm", minify: true });
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
// A shared collection's page, /s/<id> (web/share-client/view.ts; design/sharing.md)
const shareResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "share-client", "view.ts")], outdir: join(here, "dist"), naming: "sagebrush-share.js", target: "browser", format: "esm", minify: true });
// the Share dialog's analysis worker (web/share-client/deps-worker.ts, share-ux-plan r2 §3): its own
// chunk with the parser, loaded only when Share opens
const shareDepsResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "share-client", "deps-worker.ts")], outdir: join(here, "dist"), naming: "sagebrush-share-deps.js", target: "browser", format: "iife", minify: true });
// The GPU kernel's preview (web/notebook/remote-ui.js): loaded only by a page opened with ?remote=1.  Wherever
// the page goes, it goes too (the site; the CLI's embedded page, scripts/build-cli.mjs and src/notebook.ts; the
// app, app/build-frontend.mjs), but the service worker doesn't precache it.
const remoteResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "notebook", "remote-ui.js")], outdir: join(here, "dist"), naming: "sagebrush-remote.js", target: "browser", format: "esm", minify: true });
const builds: [string, any][] = [["the worker", result], ["the console", consoleResult], ["math", mathResult], ["the graph view", graphResult], ["the notebook component", notebookResult], ["TimeTravel", historyResult], ["the analyzer", analyzeResult], ["the shared collection page", shareResult], ["the Share dialog's analysis", shareDepsResult], ["the GPU kernel's preview", remoteResult]];
for (const r of [result, consoleResult, mathResult, graphResult, notebookResult, historyResult, analyzeResult, shareResult, shareDepsResult, remoteResult]) {
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
// the early-alpha notice, for the site's own pages only (web/alpha-banner.js, SECURITY.md)
copyFileSync(join(here, "alpha-banner.js"), join(here, "dist", "alpha-banner.js"));
copyFileSync(join(here, "board-format.md"), join(here, "dist", "board-format.md"));
copyFileSync(join(here, "board-host-protocol.md"), join(here, "dist", "board-host-protocol.md"));
// (the format as a JSON Schema, written from web/board/doc.ts: scripts/board-format-schema.mjs)
copyFileSync(join(here, "board-format.schema.json"), join(here, "dist", "board-format.schema.json"));
copyFileSync(join(here, "_headers"), join(here, "dist", "_headers"));
// the engines (modular symbols, a_p ...), fetched by the worker on first use
copyFileSync(join(here, "..", "wasm", "sagebrush-engine.wasm"), join(here, "dist", "sagebrush-engine.wasm"));
// the PNG module (savefig's PNG, imread), fetched by the worker on first use;
// not in the service worker's shell, which every visitor downloads
copyFileSync(join(here, "..", "wasm", "sagebrush-raster.wasm"), join(here, "dist", "sagebrush-raster.wasm"));
// The documentation indexes for the page's search box, one per language that
// has one: Sage's library (lib/_pyjs_docsearch.py), Python's numpy, scipy and
// standard library (lib/_python_docsearch.py), MATLAB's built-ins
// (lib/_matlab_docsearch.py) and Magma's intrinsics (lib/_magma_docsearch.py),
// and the capability map made from them (lib/_capability_map.py, for
// llms.txt), run by the CLI bundle (build it first with npm run build:cli)
for (const [mod, file, args] of [["_pyjs_docsearch", "docs-index.json", ["--index"]], ["_python_docsearch", "docs-index-python.json", ["--index"]], ["_matlab_docsearch", "docs-index-matlab.json", ["--index"]],
  ["_magma_docsearch", "docs-index-magma.json", ["--index"]], ["_capability_map", "capabilities.md", []]] as [string, string, string[]][]) {
  const r = Bun.spawnSync(["node", join(here, "..", "build", "cli", "pyjs.cjs"), "-m", mod, ...args]);
  if (r.exitCode !== 0) {
    console.error(`${file}: ` + r.stderr.toString());
    process.exit(1);
  }
  writeFileSync(join(here, "dist", file), r.stdout);
}
// KaTeX's stylesheet and (woff2) fonts, for math in Markdown cells
// (sorted: readdir's order depends on the filesystem, and these go into sw.js in this order)
const katexDir = join(here, "..", "node_modules", "katex", "dist");
const KATEX = ["katex/katex.min.css", ...readdirSync(join(katexDir, "fonts")).filter((f) => f.endsWith(".woff2")).sort().map((f) => "katex/fonts/" + f)];
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
const MIME: Record<string, string> = { tzif: "application/octet-stream", html: "text/html; charset=utf-8", js: "text/javascript", json: "application/json", wasm: "application/wasm", css: "text/css", woff2: "font/woff2", png: "image/png", svg: "image/svg+xml", webmanifest: "application/manifest+json" };
// The engine, by its content (design/engines.md): what runs code, published
// at sagebrush.space/engine/<id>/ and kept forever (scripts/publish-engine.mjs),
// so that a board or notebook saved with one can keep running with it (an
// exported HTML file pins its id).  <id> is a hash of its api and each
// file's hash, size and response headers (web/engine-id.mts); the headers are
// in the manifest, which the site's Worker serves them with.  `api` is the version of the interface between a page
// and these files (WorkerKernel, RunnerWorker, the worker's messages): a page
// uses another engine only if its api is the same.
// (3: the Python library in chunks, lib/..., web/lib-chunks.mts)
const ENGINE_API = 3;
let ENGINE: { id: string; api: number; files: Record<string, string> } = { id: "", api: ENGINE_API, files: {} };
const ENGINE_FILES = ["sagebrush-worker.js", "sagebrush-engine.wasm", "sagebrush-raster.wasm", "sagebrush-notebook.js", "sagebrush-analyze.js", "sagebrush-viewer3d.js", "sagebrush-graphview.js", "runner/index.html", ...LIB_CHUNKS];
// (each one's name as the site's Worker serves engine files: web/engines.ts)
for (const f of ENGINE_FILES) if (!/^[a-z0-9][a-z0-9./-]*$/.test(f)) throw new Error(`engine file ${f}: not a name web/engines.ts serves`);
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
  if (hasSite) mkdirSync(join(siteDir, "public", "engine"), { recursive: true });
  if (hasSite) copyFileSync(join(here, "dist", "engine", "latest.json"), join(siteDir, "public", "engine", "latest.json"));
  ENGINE = { id, api: ENGINE_API, files: Object.fromEntries(Object.entries(files).map(([f, d]) => [f, d.sha256])) };
  console.log(`engine ${id} (api ${ENGINE_API}): web/dist/engine/${id}/`);
}
// Boards (design/board.md), at /board/, with their example documents
{
  const r = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "board", "page.ts")], outdir: join(here, "dist", "board"), naming: "board.js", target: "browser", format: "esm", minify: true,
    // (the engine it was built with, by its files' SHA-256s: an exported board pins it, design/engines.md)
    define: { __SB_ENGINE__: JSON.stringify(ENGINE), __SB_NO_SYNC__: "false" } });
  if (!r.success) {
    for (const l of r.logs) console.error(l);
    process.exit(1);
  }
  builds.push(["the board", r]);
  // (the command line's `board render` math, MathJax: in the CLI's bundle,
  // not a page's; built here only to list its packages, so that the
  // packages that carry the CLI name them, src/board-math.ts)
  const cliMath = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "..", "src", "board-math.ts")], outdir: join(here, "dist", ".cli-math"), target: "node", format: "cjs" });
  if (!cliMath.success) { for (const m of cliMath.logs) console.error(m); process.exit(1); }
  rmSync(join(here, "dist", ".cli-math"), { recursive: true, force: true });
  builds.push(["the command line's board render (math)", cliMath]);
  // (the site's board page gets the early-alpha notice; the template itself doesn't, so neither the frame
  // other sites embed (below) nor a downloaded board (export.ts) ever carries it)
  writeFileSync(join(here, "dist", "board", "index.html"), withAlphaBanner(readFileSync(join(here, "board", "index.html"), "utf8")));
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
  // (the page without sync, for the frame (inlined) and for exports: dist/board/board-nosync.js, which the site's
  // "Download as HTML" fetches beside board.js (export.ts), so an export click fetches less than board.js, never the
  // frame page)
  const nosyncDir = join(here, "dist", ".board-nosync");
  // (the owner, the panel's sync section and the rows' icons resolved to a stub: their every use is behind
  // __SB_NO_SYNC__, never reached, and the stub keeps the modules themselves, and the client behind them, out of
  // this copy)
  const noSync = { name: "no-sync", setup(b: any) { b.onResolve({ filter: /(^|\/)sync-(owner|panel|rows)(\.ts)?$/ }, () => ({ path: join(here, "board", "no-sync-stub.ts") })); } };
  const ns = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "board", "page.ts")], outdir: nosyncDir, naming: "board.js", target: "browser", format: "esm", minify: true, plugins: [noSync], define: { __SB_ENGINE__: JSON.stringify(ENGINE), __SB_NO_SYNC__: "true" } });
  if (!ns.success) { for (const l of ns.logs) console.error(l); process.exit(1); }
  // (its packages are the board build's: a subset, already listed in js-dependencies.json)
  const nosync = readFileSync(join(nosyncDir, "board.js"), "utf8");
  writeFileSync(join(here, "dist", "board", "board-nosync.js"), nosync);
  rmSync(nosyncDir, { recursive: true, force: true });
  writeFileSync(join(here, "dist", "frame", "board", "index.html"), frameHtml(readFileSync(join(here, "board", "index.html"), "utf8"), nosync, readFileSync(join(here, "dist", "sagebrush-math.js"), "utf8"), css));
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
      const dir = bundledPackageDir(input, process.cwd());
      if (dir !== null) add(dir, what);
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
// The Cloudflare site (web/site, when it is here: web/site-dir.mts) serves the same files.
// (every write into web/site below is guarded by hasSite)
if (hasSite) rmSync(join(siteDir, "public", "atlas"), { recursive: true, force: true });
if (hasSite) cpSync(join(here, "dist", "atlas"), join(siteDir, "public", "atlas"), { recursive: true });
// the site Worker's build id: its edge cache of atlas pages is keyed on it
if (hasSite) writeFileSync(join(siteDir, "src", "build-id.ts"), `// written by web/build.ts\nexport const BUILD = ${JSON.stringify(Date.now().toString(36))};\n`);
// boards (/board/)
if (hasSite) rmSync(join(siteDir, "public", "board"), { recursive: true, force: true });
if (hasSite) cpSync(join(here, "dist", "board"), join(siteDir, "public", "board"), { recursive: true });
if (hasSite) rmSync(join(siteDir, "public", "frame"), { recursive: true, force: true });
if (hasSite) cpSync(join(here, "dist", "frame"), join(siteDir, "public", "frame"), { recursive: true });
if (hasSite) mkdirSync(join(siteDir, "public", "katex", "fonts"), { recursive: true });
// the 3D viewer, loaded by the page when a Graphics3d is shown
// The app (PWA): manifest, icons, and the service worker with the files it
// keeps for offline use, versioned by their content
// (sorted, as KATEX: so that sw.js is the same from any checkout)
const ICONS = readdirSync(join(here, "icons")).sort().map((f) => "icons/" + f);
mkdirSync(join(here, "dist", "icons"), { recursive: true });
for (const f of ICONS) copyFileSync(join(here, f), join(here, "dist", f));
copyFileSync(join(here, "manifest.webmanifest"), join(here, "dist", "manifest.webmanifest"));
// SHELL is what the service worker precaches when it installs: what the
// notebook needs to start and run offline.  LAZY is kept once it is used
// online (fetched under the service worker, verified by its digest like the
// shell): the engine (only some code needs it), the documentation
// indexes (only the search box does), and the Python library's chunks (a
// mode's, when it is first used; offline, a module whose sources were
// never fetched can't be imported, and one whose compiled code wasn't is
// compiled from its source: src/compile.ts)
const SHELL = ["./", "sagebrush-worker.js", "sagebrush-console.js", "sagebrush-math.js", "sagebrush-viewer3d.js", "sagebrush-graphview.js", "sagebrush-history.js", "sagebrush-analyze.js", "manifest.webmanifest", ...ICONS, ...KATEX];
const LAZY = ["docs-index.json", "docs-index-python.json", "docs-index-matlab.json", "docs-index-magma.json", `sagebrush-engine.wasm?h=${engineHash}`, ...LIB_CHUNKS];
const shellHash = new Bun.CryptoHasher("sha256");
for (const f of ["index.html", "docs-index.json", "docs-index-python.json", "docs-index-matlab.json", "docs-index-magma.json", "sagebrush-worker.js", "sagebrush-console.js", "sagebrush-math.js", "sagebrush-viewer3d.js", "sagebrush-graphview.js", "sagebrush-history.js", "sagebrush-analyze.js", "manifest.webmanifest"]) shellHash.update(readFileSync(join(here, "dist", f)));
shellHash.update(engineHash + libManifestHash);
// (each of them by its SHA-256, and the response it is served as: the service
// worker serves a kept copy only if it still has those bytes, and then as a
// response it makes, with this status and these headers, never the kept
// response's own; design/security.md, SEC-8D6-1, SEC-522-1)
const { pagePolicy } = await import("./csp-policy.mts");
const DIGESTS = Object.fromEntries([...SHELL, ...LAZY].map((p) => {
  const file = p === "./" ? "index.html" : p.split("?")[0];
  const bytes = readFileSync(join(here, "dist", file));
  const mime = MIME[file.split(".").pop()!];
  if (!mime) throw new Error(`sw.js: no type for ${file}`);
  // (as web/_headers and web/csp.ts give it: every file cross-origin isolated, a page its policy)
  const headers: Record<string, string> = { "Content-Type": mime, "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
  if (file.endsWith(".html")) headers["Content-Security-Policy"] = pagePolicy(scriptHashes(bytes.toString("utf8")));
  return [p.split("?")[0], { sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), headers }];
}));
writeFileSync(join(here, "dist", "sw.js"), readFileSync(join(here, "sw.js"), "utf8").replace("__VERSION__", shellHash.digest("hex").slice(0, 16)).replace("__SHELL__", JSON.stringify(SHELL)).replace("__LAZY__", JSON.stringify(LAZY)).replace("__DIGESTS__", JSON.stringify(DIGESTS)));
if (hasSite) mkdirSync(join(siteDir, "public", "icons"), { recursive: true });
// the shell worker's bootstrap (web/shell/worker-boot.js; plan-bash-shell r3
// §6), served with its own policy (web/csp.ts); the shell's module comes from a
// package set, never from this build
mkdirSync(join(here, "dist", "shell"), { recursive: true });
copyFileSync(join(here, "shell", "worker-boot.js"), join(here, "dist", "shell", "worker-boot.js"));
if (hasSite) {
  mkdirSync(join(siteDir, "public", "shell"), { recursive: true });
  copyFileSync(join(here, "shell", "worker-boot.js"), join(siteDir, "public", "shell", "worker-boot.js"));
}
// the notebook component's demo page (web/embed)
mkdirSync(join(here, "dist", "embed"), { recursive: true });
copyFileSync(join(here, "embed", "index.html"), join(here, "dist", "embed", "index.html"));
if (hasSite) mkdirSync(join(siteDir, "public", "embed"), { recursive: true });
if (hasSite) mkdirSync(join(siteDir, "public", "runner"), { recursive: true });
// the shared collection page, served for /s/<id> by the site's Worker
mkdirSync(join(here, "dist", "s"), { recursive: true });
copyFileSync(join(here, "share-client", "view.html"), join(here, "dist", "s", "index.html"));
// (its link preview's image, board's design: committed as rendered, never generated here; og.svg is its source)
copyFileSync(join(here, "share-client", "og.png"), join(here, "dist", "s", "og.png"));
if (hasSite) mkdirSync(join(siteDir, "public", "s"), { recursive: true });
for (const f of ["index.html", "alpha-banner.js", "THIRD-PARTY-NOTICES.txt", "llms.txt", "board-format.md", "board-host-protocol.md", "board-format.schema.json", "capabilities.md", "docs-index.json", "docs-index-python.json", "docs-index-matlab.json", "docs-index-magma.json", "sagebrush-worker.js", "sagebrush-console.js", "sagebrush-math.js", "sagebrush-viewer3d.js", "sagebrush-graphview.js", "sagebrush-notebook.js", "sagebrush-history.js", "sagebrush-analyze.js", "sagebrush-share.js", "s/index.html", "sagebrush-share-deps.js", "sagebrush-remote.js", "s/og.png", "runner/index.html", "embed/index.html", "sagebrush-engine.wasm", "sw.js", "manifest.webmanifest", "sagebrush-raster.wasm"])
  if (hasSite) copyFileSync(join(here, "dist", f), join(siteDir, "public", f));
// (the library's chunks)
if (hasSite) rmSync(join(siteDir, "public", "lib"), { recursive: true, force: true });
if (hasSite) cpSync(join(here, "dist", "lib"), join(siteDir, "public", "lib"), { recursive: true });
// the articles (articles/ in the repository) as static pages, sitemap.xml
if (hasSite) await import("./build-articles.ts");
// every page's Content-Security-Policy, in _headers (web/csp.ts)
(await import("./csp.ts")).writeHeaders();
const size = statSync(join(here, "dist", "sagebrush-worker.js")).size;
console.log(`web/dist/sagebrush-worker.js ${(size / 1e6).toFixed(2)} MB, sagebrush-console.js ${(statSync(join(here, "dist", "sagebrush-console.js")).size / 1e3).toFixed(0)} kB`);
