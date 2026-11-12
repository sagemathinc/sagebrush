// bun web/build.ts  ->  web/dist/{index.html, llms.txt, sagebrush-worker.js, sagebrush-console.js,
//                                sagebrush-math.js, katex/, sagebrush-engine.wasm, sagebrush-raster.wasm}
// The pyjs compiler and runtime for browsers: Node APIs are replaced by
// web/shims, the Python library is fetched in chunks (lib/), and the
// Unicode name table is left out.
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, statSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, cpSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { previewHost } from "./latex/preview-host.mjs";
import { bundledPackageDir } from "./build-package-dir.mjs";

/** A site page with the early-alpha notice's script (web/alpha-banner.js), just before </head>. */
// (the same tag that board/export.ts's assemble() takes out of every board it makes from a page)
const ALPHA_BANNER_TAG = '<script src="/alpha-banner.js" defer></script>\n';
function withAlphaBanner(html: string): string {
  if (!html.includes("</head>")) throw new Error("build: a page without </head> for the early-alpha notice");
  return html.replace("</head>", ALPHA_BANNER_TAG + "</head>");
}
const here = import.meta.dir;
// The LaTeX editor (web/latex/): ON BY DEFAULT on the site (William, Nov 2 12:52 PM PST, PROD included). Built unless
// SAGEBRUSH_LATEX_PREVIEW=0 (a build without it: __SB_LATEX__ false in every bundle, its hooks fold away, no LaTeX file
// written); "test" is the same build with its page also on loopback hosts, for the browser tests. It runs only on the
// hosts that serve its files (sagebrush.space and dev.sagebrush.space; with SAGEBRUSH_PREVIEW_HOST, one preview host under
// .sagebrush.cloud, web/latex/preview-host.mjs): the CLI's page (127.0.0.1) and the desktop app's don't offer it.
const LATEX_MODE = process.env.SAGEBRUSH_LATEX_PREVIEW || "1";
if (!["0", "1", "test"].includes(LATEX_MODE)) throw new Error(`SAGEBRUSH_LATEX_PREVIEW must be unset, 0, 1 or test, not ${JSON.stringify(LATEX_MODE)}`);
const LATEX = LATEX_MODE !== "0";
const LATEX_PREVIEW_HOST = previewHost(LATEX_MODE, process.env.SAGEBRUSH_PREVIEW_HOST);
const LATEX_SITE_HOSTS = ["sagebrush.space", "dev.sagebrush.space"];
const LATEX_DEFINE = LATEX
  ? { __SB_LATEX__: "true", __SB_LATEX_TEST__: String(LATEX_MODE === "test"), __SB_LATEX_HOSTS__: JSON.stringify(LATEX_MODE === "test" ? [...LATEX_SITE_HOSTS, "127.0.0.1", "localhost"] : [...LATEX_SITE_HOSTS, ...(LATEX_PREVIEW_HOST ? [LATEX_PREVIEW_HOST] : [])]) }
  : { __SB_LATEX__: "false" };
// (the board page: the hosts where a .tex file in its file panel opens the LaTeX editor (U1); none in a build without it)
const BOARD_TEX_HOSTS = LATEX ? (LATEX_DEFINE as Record<string, string>).__SB_LATEX_HOSTS__ : "[]";
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
const ndSha256 = new Bun.CryptoHasher("sha256").update(readFileSync(join(here, "..", "wasm", "sagebrush-nd.wasm"))).digest("hex");
// and the multiprecision core's (src/runtime/mpcore.ts), fetched the first time mpmath calls into it
const mpSha256 = new Bun.CryptoHasher("sha256").update(readFileSync(join(here, "..", "wasm", "sagebrush-mp.wasm"))).digest("hex");
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
  // (Rill's start, after the existing modes: design/rill.md §6.1)
  rill: ["--rill", "-c", "1"],
  // (Sprig's start, last: design/sprig-mvp.md §6.1)
  sprig: ["--sprig", "-c", "1"],
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
// (background loading's table, web/preload.ts: each library group's chunk files and bytes, each mode's groups, and the
// group of each top-level module's entry file (`a/__init__.py` or `a.py`), from this manifest, so the page fetches
// exactly the files the worker would)
const PRELOAD = (() => {
  // (a group: [its bytes, its src chunk's name hash, its pre chunk's], the files being lib/<group>.<kind>.<hash>.json)
  const groups: Record<string, [number, string, string?]> = {};
  const hash = (g: string, k: string, f: string) => {
    const h = f.slice(`lib/${g}.${k}.`.length, -".json".length);
    if (!f.startsWith(`lib/${g}.${k}.`) || !f.endsWith(".json") || !/^[0-9a-f]{16}$/.test(h)) throw new Error(`background loading's table: ${f} isn't lib/${g}.${k}.<hash>.json`);
    return h;
  };
  for (const [g, c] of Object.entries(libManifest.chunks)) groups[g] = [c.src.size + (c.pre?.size ?? 0), hash(g, "src", c.src.file), ...(c.pre ? [hash(g, "pre", c.pre.file)] : [])] as [number, string, string?];
  const tops: Record<string, string> = {};
  for (const [p, g] of Object.entries(libManifest.files)) {
    const m = /^([A-Za-z_]\w*)(?:\/__init__\.py|\.py)$/.exec(p);
    // (a private module (`_name`) is the library's own, never a notebook's import)
    if (m && !m[1].startsWith("_") && !(m[1] in tops)) tops[m[1]] = g;
  }
  // (only the groups a mode or a module names: no other is ever prefetched)
  const used = new Set([...Object.values(libManifest.modes).flat(), ...Object.values(tops)]);
  for (const g of Object.keys(groups)) if (!used.has(g)) delete groups[g];
  return { groups, modes: libManifest.modes, tops };
})();
console.log(`background loading's table: ${Object.keys(PRELOAD.groups).length} groups, ${Object.keys(PRELOAD.tops).length} modules, ${JSON.stringify(PRELOAD).length} B`);
console.log(`library: ${LIB_CHUNKS.length} chunks; ` + Object.entries(libManifest.chunks).map(([g, c]) => `${g} ${(c.src.size / 1e3).toFixed(0)}+${((c.pre?.size ?? 0) / 1e3).toFixed(0)} kB`).join(", "));
// What the runner's broker may fetch for its interpreter, exactly (G-10, web/runner-fetch.mts): every bundle is
// built with it as __SB_RUNNER_FETCH__ (the one that uses it is web/notebook/runner-worker.js), and a bundle
// containing runner-worker.js without it fails the build; the list is also dist/runner-fetch.json
{
  const { runnerFetchList, checkRunnerDefine } = await import("./runner-fetch.mts");
  const list = runnerFetchList(engineSha256, rasterSha256, ndSha256, mpSha256, libChunkFiles.keys(), tz.ref);
  writeFileSync(join(here, "dist", "runner-fetch.json"), JSON.stringify(list) + "\n");
  // (no bundle built here may take an input from the MS-RSL directory: scripts/check-no-server-imports.mjs)
  const { assertNoCloudInputs } = await import("../scripts/check-no-server-imports.mjs");
  const bunBuild = Bun.build.bind(Bun);
  const build0 = async (o: any) => {
    const r = await bunBuild({ ...o, metafile: true });
    if (r.success) assertNoCloudInputs(Object.keys(r.metafile?.inputs ?? {}), String(o.entrypoints?.[0] ?? "a bundle"));
    return r;
  };
  // (the isolated output renderer, OUT-ISO phase 1: its packaged form is every bundle's __SB_OUTPUT_SHELL__, and its
  // hosted form one directory per environment's own site, web/dist-output-shell/<env>, never this site's dist; the
  // environments' shell URLs are empty until that site exists: web/output-shell/sites.mts)
  const { buildOutputShell, hostedShellFiles } = await import("./output-shell/build.mts");
  const { SITES, checkSites } = await import("./output-shell/sites.mts");
  const siteProblems = checkSites();
  if (siteProblems.length) throw new Error("web/output-shell/sites.mts: " + siteProblems.join("; "));
  const outputShell = await buildOutputShell(build0, join(here, "output-shell", "shell.js"));
  rmSync(join(here, "dist-output-shell"), { recursive: true, force: true });
  for (const [env, s] of Object.entries(SITES)) {
    mkdirSync(join(here, "dist-output-shell", env), { recursive: true });
    for (const [f, text] of Object.entries(hostedShellFiles(outputShell, s.ancestors))) writeFileSync(join(here, "dist-output-shell", env, f), text);
  }
  console.log(`output shell: ${outputShell.srcdoc.length} B packaged, ${Object.keys(SITES).length} hosted configs (shell URLs: ${Object.values(SITES).filter((s) => s.shell).length} set)`);
  // (and the editors' old example lists, web/examples/legacy.ts: in a bundle, its lists as literals, never its file
  // reading code)
  const { legacySource } = await import("./examples/legacy.ts");
  const legacy = legacySource();
  const examplesLegacyPlugin = { name: "examples-legacy", setup(b: any) { b.onLoad({ filter: /[\\/]web[\\/]examples[\\/]legacy\.ts$/ }, () => ({ contents: legacy, loader: "js" })); } };
  (Bun as any).build = async (o: any) => {
    const r = await build0({ ...o, plugins: [...(o.plugins ?? []), examplesLegacyPlugin], define: { ...(o.define ?? {}), __SB_RUNNER_FETCH__: JSON.stringify(list), __SB_OUTPUT_SHELL__: JSON.stringify(outputShell.srcdoc) } });
    if (r.success) checkRunnerDefine(String(o.entrypoints?.[0] ?? "a bundle"), Object.keys(r.metafile?.inputs ?? {}), await Promise.all(r.outputs.map((x: any) => x.text())));
    return r;
  };
}
// (each group's offline item, so an import that fails offline can name what to download: web/offline-inventory.mts,
// plan-b8-offline §2; a group no rule places fails the build here)
{
  const { itemOfGroup, checkStartCoverage } = await import("./offline-inventory.mts");
  (libManifest as any).items = Object.fromEntries(Object.keys(libManifest.chunks).sort().map((g) => [g, itemOfGroup(g)]));
  // (a mode's start fetches only groups its offline item holds or needs, so a mode downloaded for offline starts offline)
  checkStartCoverage(libManifest.modes);
}
// (the manifest, in the worker: web/lib-lazy.ts)
const libManifestHash = new Bun.CryptoHasher("sha256").update(JSON.stringify(libManifest)).digest("hex");
const result = await Bun.build(<any>{
  metafile: true,
  // (__dirname: Bun inlines a browser bundle's __dirname as the source's absolute directory, which made the
  // engine worker, and so its hash, the engine id and sw.js, depend on where the checkout is.  The worker's
  // only use is a Node-only fallback that looks for wasm/ beside the source (src/runtime/engine.ts, raster.ts),
  // unreachable in a browser; undefined sends it to process.cwd(), as when __dirname doesn't exist)
  define: { __SB_ENGINE_HASH__: JSON.stringify(engineSha256), __SB_RASTER_HASH__: JSON.stringify(rasterSha256), __SB_ND_HASH__: JSON.stringify(ndSha256), __SB_MP_HASH__: JSON.stringify(mpSha256), __SB_LIB__: JSON.stringify(libManifest), __dirname: "undefined" },
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
// (in a LaTeX build, the same module plus KaTeX's renderToString, for the LaTeX editor's worker: web/latex/math-dev.ts)
const mathResult = await Bun.build(<any>{ metafile: true, entrypoints: [LATEX ? join(here, "latex", "math-dev.ts") : join(here, "math.ts")], outdir: join(here, "dist"), naming: "sagebrush-math.js", target: "browser", format: "esm", minify: true });
// A Jupytext MyST notebook's directives and roles (web/myst), loaded by the notebook only for one: never precached
// (LAZY, not SHELL), and an engine file for the component (plan-myst-notebooks r3 §8.1, §8.6)
const mystResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "myst", "index.ts")], outdir: join(here, "dist"), naming: "sagebrush-myst.js", target: "browser", format: "esm", minify: true });
// The canvas view of a graph's picture (web/graph/view.ts), loaded by the
// notebook when Graph.plot's output first needs it
const graphResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "graph", "view.ts")], outdir: join(here, "dist"), naming: "sagebrush-graphview.js", target: "browser", format: "esm", minify: true });
// The notebook as a component (web/notebook), for other pages: web/embed.
const notebookResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "notebook", "index.js")], outdir: join(here, "dist"), naming: "sagebrush-notebook.js", target: "browser", format: "esm", minify: true });
// TimeTravel's history (web/notebook/history.js, with patchflow), loaded after the notebook
const historyResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "notebook", "history.js")], outdir: join(here, "dist"), naming: "sagebrush-history.js", target: "browser", format: "esm", minify: true });
// the app self-test's COI diagnosis and the Terminal's checks (web/notebook/selftest-entry.js), imported by
// selftest() only when the app's self-test runs; the app copies it (app/build-frontend.mjs), the CLI doesn't serve it
const selftestResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "notebook", "selftest-entry.js")], outdir: join(here, "dist"), naming: "sagebrush-selftest.js", target: "browser", format: "esm", minify: true });
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
const shareResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "share-client", "view.ts")], outdir: join(here, "dist"), naming: "sagebrush-share.js", target: "browser", format: "esm", minify: true, define: { __SB_PRELOAD__: JSON.stringify(PRELOAD), __SB_LATEX_HOSTS__: "[]", ...LATEX_DEFINE } });
// the reader's own copy from a shared collection (web/share-client/copy.ts, book links B1): the workspace, on demand
const shareCopyResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "share-client", "copy.ts")], outdir: join(here, "dist"), naming: "sagebrush-share-copy.js", target: "browser", format: "esm", minify: true });
// the Share dialog's analysis worker (web/deps/deps-worker.ts, share-ux-plan r2 §3): its own
// chunk with the parser, loaded only when Share opens
const shareDepsResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "deps", "deps-worker.ts")], outdir: join(here, "dist"), naming: "sagebrush-share-deps.js", target: "browser", format: "iife", minify: true });
// (Share folder…, book links B2: its dialog, loaded when chosen from a folder's ⋯)
const shareFolderResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "share-client", "folder-dialog.ts")], outdir: join(here, "dist"), naming: "sagebrush-share-folder.js", target: "browser", format: "esm", minify: true });
// Connecting an agent on this computer to the notebook page (web/workspace/agent-entry.ts): fetched only when Agent is
// pressed, a ?pair= link opened, or an agent remembered.  The site's only: the desktop app and the CLI's page don't offer it
const agentResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "workspace", "agent-entry.ts")], outdir: join(here, "dist"), naming: "sagebrush-agent.js", target: "browser", format: "esm", minify: true });
// (an agent's runs of code, chat plan PR 4a: a chunk of its own, fetched at an agent's first run; the site's only, with
// its own ceiling (web/workspace/test-agent-run-size.mjs, daybreak2's ruling))
const agentRunResult = await Bun.build(<any>{ entrypoints: [join(here, "workspace", "run-verbs.ts")], outdir: join(here, "dist"), naming: "sagebrush-agent-run.js", target: "browser", format: "esm", minify: true });
if (!agentRunResult.success) { for (const l of agentRunResult.logs) console.error(l); process.exit(1); }
// The person's review of an agent's branch (web/workspace/review): a chunk of its own, fetched when a page that offers
// branches opens a review, never at its start; the site's only, with its own cap (web/workspace/review/test-review-size.mjs)
const reviewResult = await Bun.build(<any>{ entrypoints: [join(here, "workspace", "review", "review-page.ts")], outdir: join(here, "dist"), naming: "sagebrush-review.js", target: "browser", format: "esm", minify: true });
if (!reviewResult.success) { for (const l of reviewResult.logs) console.error(l); process.exit(1); }
// The GPU kernel's preview (web/notebook/remote-ui.js): loaded only by a page opened with ?remote=1.  Wherever
// the page goes, it goes too (the site; the CLI's embedded page, scripts/build-cli.mjs and src/notebook.ts; the
// app, app/build-frontend.mjs), but the service worker doesn't precache it.
const remoteResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "notebook", "remote-ui.js")], outdir: join(here, "dist"), naming: "sagebrush-remote.js", target: "browser", format: "esm", minify: true });
// A terminal on one of your computers (web/notebook/remote-terminal-view.ts, terminals T-3: xterm and the relay's terminal
// page leg): loaded only when ⋯ ▸ Terminal on your computer… is chosen (offered on the site when the account can use
// it); on the site and in the app only (the CLI's page can't reach a relay: web/test-cli-assets.mjs SITE_ONLY), and not
// precached
const remoteTermResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "notebook", "remote-terminal-view.ts")], outdir: join(here, "dist"), naming: "sagebrush-remote-terminal.js", target: "browser", format: "esm", minify: true });
// The Storage panel's "Export all current files (.zip)" (web/workspace/export, export plan E1 r2c): a chunk of its
// own and its worker, fetched only when the button is clicked, so the page's start doesn't carry them
const exportResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "workspace", "export", "entry.ts")], outdir: join(here, "dist"), naming: "sagebrush-export.js", target: "browser", format: "esm", minify: true });
const exportWorkerResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "workspace", "export", "worker.ts")], outdir: join(here, "dist"), naming: "sagebrush-export-worker.js", target: "browser", format: "esm", minify: true });
// "Push to GitHub" (Stage A MVP r1, DEV only, web/gitpush): its panel's chunk and its git worker (isomorphic-git),
// fetched only when the Storage panel's button is clicked in a browser with the flag
const gitpushResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "gitpush", "panel.ts")], outdir: join(here, "dist"), naming: "sagebrush-gitpush-panel.js", target: "browser", format: "esm", minify: true });
// (packages put in place by small modules of its own, web/gitpush/shims: see each)
const gitShims = { name: "gitpush-shims", setup(b: any) {
  const shim = (f: string) => () => ({ path: join(here, "gitpush", "shims", f) });
  b.onResolve({ filter: /^sha\.js\/sha1(\.js)?$/ }, shim("sha1.ts"));
  b.onResolve({ filter: /^crc-32$/ }, shim("crc32.ts"));
  b.onResolve({ filter: /^(diff3|clean-git-ref|isomorphic-textencoder)$/ }, shim("unused.ts"));
} };
const gitpushWorkerResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "gitpush", "git-worker.ts")], outdir: join(here, "dist"), naming: "sagebrush-gitpush-worker.js", target: "browser", format: "esm", minify: true, plugins: [gitShims] });
// File > Examples… (U7, web/examples/panel.ts): the gallery's panel and its copy path, fetched only when chosen
const examplesPanelResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "examples", "panel.ts")], outdir: join(here, "dist"), naming: "sagebrush-examples-panel.js", target: "browser", format: "esm", minify: true });
// the code page (1a, web/code/page.ts): a .py, .sage, .m, .mag, .js, .json or .txt file at /?code=<fid>, fetched only there
const codePageResult = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "code", "page.ts")], outdir: join(here, "dist"), naming: "sagebrush-code.js", target: "browser", format: "esm", minify: true });
const builds: [string, any][] = [["the worker", result], ["the console", consoleResult], ["math", mathResult], ["MyST", mystResult], ["the graph view", graphResult], ["the notebook component", notebookResult], ["TimeTravel", historyResult], ["the analyzer", analyzeResult], ["the shared collection page", shareResult], ["the reader's own copy", shareCopyResult], ["the Share dialog's analysis", shareDepsResult], ["Share folder's dialog", shareFolderResult], ["the agent connection", agentResult], ["the GPU kernel's preview", remoteResult], ["the terminal on your computer", remoteTermResult], ["the app self-test's COI diagnosis", selftestResult], ["the export", exportResult], ["the export's worker", exportWorkerResult], ["Push to GitHub", gitpushResult], ["Push to GitHub's worker", gitpushWorkerResult], ["the Examples… panel", examplesPanelResult], ["the code page", codePageResult]];
for (const r of [result, consoleResult, mathResult, mystResult, graphResult, notebookResult, historyResult, analyzeResult, shareResult, shareCopyResult, shareDepsResult, shareFolderResult, agentResult, remoteResult, remoteTermResult, selftestResult, exportResult, exportWorkerResult, gitpushResult, gitpushWorkerResult, examplesPanelResult, codePageResult]) {
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
  // (without the LaTeX editor, its entry's import line is taken out first: its one use is in a branch the build drops)
  const LATEX_IMPORT = 'import { latexBoot, latexOn, texNew } from "./latex/boot.ts";\n';
  if (m[1].split(LATEX_IMPORT).length !== 2) throw new Error("index.html must import the LaTeX editor's entry exactly once");
  writeFileSync(tmp, (LATEX ? m[1] : m[1].replace(LATEX_IMPORT, "")) + "\nexport {};\n"); // an ES module: Bun would wrap a script in an uncalled CommonJS shim
  // (SAGEBRUSH_MEASURE_IDS=keep: the size gate's identifier-stable measuring variant, never shipped: identifiers kept,
  //  so the DEV page's script is PROD's with the DEV-only code inserted; scripts/line3-measure.mjs)
  const app = await Bun.build(<any>{ metafile: true, entrypoints: [tmp], target: "browser", format: "iife", minify: process.env.SAGEBRUSH_MEASURE_IDS === "keep" ? { whitespace: true, syntax: true, identifiers: false } : true, define: { ...LATEX_DEFINE, __SB_PRELOAD__: JSON.stringify(PRELOAD) } });
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
// The LaTeX editor's page and its engine worker (only in a LaTeX build): loaded only when a .tex file is opened.
// Every LaTeX-owned output is named sagebrush-latex* (the deploy's PROD check relies on that name).
for (const f of readdirSync(join(here, "dist"))) if (f.startsWith("sagebrush-latex")) rmSync(join(here, "dist", f));
if (LATEX) {
  // (the comments, comments.ts: a chunk of their own, fetched only when someone comments or a document has comments;
  // a document's live comments, comments-doc.ts with their core, another, so the frozen text's chunk stays small;
  // the agent tools' work, tools.ts, a third, fetched on an agent's first latex_check or latex_render; the presenter,
  // present.ts, a fourth, fetched when Present is pressed; and beamer's code, engine/beamer.mjs, the worker's, fetched
  // when a document first needs it: the class beamer, or an overlay command; PythonTeX's results pass,
  // engine/pythontex.mjs, the worker's too, fetched when a document has a PythonTeX result to read back)
  for (const [entry, name] of [["page.ts", "sagebrush-latex.js"], ["examples.ts", "sagebrush-latex-examples.js"], ["doc.ts", "sagebrush-latex-doc.js"], ["share.ts", "sagebrush-latex-share.js"], ["worker.ts", "sagebrush-latex-worker.js"], ["comments.ts", "sagebrush-latex-comments.js"], ["comments-doc.ts", "sagebrush-latex-comments-doc.js"], ["agent.ts", "sagebrush-latex-agent.js"], ["tools.ts", "sagebrush-latex-tools.js"], ["run-core.mjs", "sagebrush-latex-run.js"], ["present.ts", "sagebrush-latex-present.js"], ["interact.ts", "sagebrush-latex-interact.js"], ["engine/beamer.mjs", "sagebrush-latex-beamer.js"], ["engine/pythontex.mjs", "sagebrush-latex-pythontex.js"], ["view.ts", "sagebrush-latex-view.js"]]) {
    const r = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "latex", entry)], outdir: join(here, "dist"), naming: name, target: "browser", format: "esm", minify: true, define: LATEX_DEFINE });
    builds.push([`the LaTeX editor (${name})`, r]);
    if (!r.success) { for (const l of r.logs) console.error(l); process.exit(1); }
  }
  // (for the asset budget gate, scripts/site-asset-budget.mjs: every bundle's inputs, by output, outside dist)
  mkdirSync(join(here, "..", "build"), { recursive: true });
  writeFileSync(join(here, "..", "build", "latex-metafile.json"), JSON.stringify(Object.fromEntries(builds.map(([what, r]) => [what, Object.keys(r.metafile?.inputs ?? {})])), null, 0) + "\n");
}
// MyST's renderer (web/myst) is in its own asset and in no other bundle: not the page's script, not the notebook
// component, nothing else built here (plan-myst-notebooks r3 §8.1: its laziness is this, and the network test's)
{
  const isMyst = (p: string) => /(^|\/)web\/myst\//.test(p.replace(/\\/g, "/"));
  // (a bun whose Bun.build gives no metafile, as 1.2.21's doesn't, can't be checked here, nor list the bundles' npm
  // packages below: CI's pin, DEVELOPMENT.md's bun, gives one)
  if (mystResult.metafile === undefined) throw new Error(`bun ${Bun.version}'s Bun.build gives no metafile, which this build reads; use bun 1.4.4 (CI's pin): bun upgrade, or curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4`);
  if (!Object.keys(mystResult.metafile?.inputs ?? {}).some(isMyst)) throw new Error("sagebrush-myst.js doesn't contain web/myst");
  for (const [what, r] of builds) if (r !== mystResult && Object.keys(r.metafile?.inputs ?? {}).some(isMyst)) throw new Error(`${what} contains web/myst: MyST's renderer belongs only in sagebrush-myst.js`);
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
// engine/nd's numerics module (np.linalg.cholesky, CHOL-1), fetched by the worker
// on first use; likewise not in the shell
copyFileSync(join(here, "..", "wasm", "sagebrush-nd.wasm"), join(here, "dist", "sagebrush-nd.wasm"));
// the multiprecision core (mpmath's backend), fetched by the worker on first use; likewise not in the shell
copyFileSync(join(here, "..", "wasm", "sagebrush-mp.wasm"), join(here, "dist", "sagebrush-mp.wasm"));
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
// The real systems' names each index lacks, for the search's Not yet results (web/upstream-names.mts): every
// catalog/<mode>/upstream.txt, less its index's names, split by what Sagebrush's runtime has
// (scripts/upstream-probe.py, run by the CLI bundle); a file for each mode the page has, and every list checked
const UPSTREAM_FILES: string[] = [];
{
  const { UPSTREAM_MODES, UPSTREAM_LISTS, parseUpstream, upstreamAsset, upstreamBytes, checkUpstreamTotal } = await import("./upstream-names.mts");
  const t0 = performance.now(), sizes: Record<string, number> = {};
  for (const m of UPSTREAM_LISTS) {
    const list = join(here, "..", "catalog", m, "upstream.txt");
    const r = Bun.spawnSync(["node", join(here, "..", "build", "cli", "pyjs.cjs"), ...(m === "sage" ? ["--sage"] : []), join(here, "..", "scripts", "upstream-probe.py"), m, list]);
    if (r.exitCode !== 0) {
      console.error(`upstream-probe ${m}: ` + r.stderr.toString());
      process.exit(1);
    }
    const index = (UPSTREAM_MODES as readonly string[]).includes(m) ? JSON.parse(readFileSync(join(here, "dist", m === "sage" ? "docs-index.json" : `docs-index-${m}.json`), "utf8")) : [];
    const bytes = upstreamBytes(upstreamAsset(parseUpstream(readFileSync(list, "utf8"), m), new Set(r.stdout.toString().split("\n").filter(Boolean)), index), m);
    sizes[m] = bytes.length;
    if ((UPSTREAM_MODES as readonly string[]).includes(m)) {
      writeFileSync(join(here, "dist", `docs-upstream-${m}.json`), bytes);
      UPSTREAM_FILES.push(`docs-upstream-${m}.json`);
    }
  }
  checkUpstreamTotal(sizes);
  console.log(`upstream names: ${Object.entries(sizes).map(([m, n]) => `${m} ${(n / 1e3).toFixed(0)} kB`).join(", ")} (probed in ${((performance.now() - t0) / 1e3).toFixed(1)} s)`);
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
const ENGINE_FILES = ["sagebrush-worker.js", "sagebrush-engine.wasm", "sagebrush-raster.wasm", "sagebrush-nd.wasm", "sagebrush-mp.wasm", "sagebrush-notebook.js", "sagebrush-analyze.js", "sagebrush-viewer3d.js", "sagebrush-graphview.js", "sagebrush-myst.js", "runner/index.html", ...LIB_CHUNKS];
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
// A board page takes only the 4 KiB MyST rule (web/notebook/myst-head.ts), never the MyST reader
// (web/notebook/myst.js) or renderer (web/myst): plan-myst-notebooks-p2 r2 §11.3 (its uploads and "Open as a board"
// need only the rule; a MyST .md opened as a notebook goes to the notebook page)
function boardMystClosure(what: string, r: any) {
  const inputs = Object.keys(r.metafile?.inputs ?? {}).map((p) => p.replace(/\\/g, "/"));
  if (!inputs.some((p) => /(^|\/)web\/notebook\/myst-head\.(js|ts)$/.test(p))) throw new Error(`${what} doesn't contain web/notebook/myst-head.ts`);
  const heavy = inputs.filter((p) => /(^|\/)web\/notebook\/myst\.js$|(^|\/)web\/myst\//.test(p));
  if (heavy.length) throw new Error(`${what} contains ${heavy.join(", ")}: a board page takes only web/notebook/myst-head.ts`);
}
// Boards (design/board.md), at /board/, with their example documents
{
  const r = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "board", "page.ts")], outdir: join(here, "dist", "board"), naming: "board.js", target: "browser", format: "esm", minify: true,
    // (the engine it was built with, by its files' SHA-256s: an exported board pins it, design/engines.md)
    define: { __SB_LATEX__: "false", __SB_LATEX_HOSTS__: BOARD_TEX_HOSTS, __SB_ENGINE__: JSON.stringify(ENGINE), __SB_NO_SYNC__: "false" } });
  if (!r.success) {
    for (const l of r.logs) console.error(l);
    process.exit(1);
  }
  builds.push(["the board", r]);
  boardMystClosure("the board", r);
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
  // (the corpus's boards, examples/board/<slug>/, under their own file names, and the menu: web/examples/legacy.ts)
  const { boardFiles, boardMenu } = await import("./examples/legacy.ts");
  for (const [f, path] of boardFiles()) copyFileSync(path, join(here, "dist", "board", "examples", f));
  writeFileSync(join(here, "dist", "board", "examples", "index.json"), JSON.stringify(boardMenu(), null, 1) + "\n");
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
  const ns = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "board", "page.ts")], outdir: nosyncDir, naming: "board.js", target: "browser", format: "esm", minify: true, plugins: [noSync], define: { __SB_LATEX__: "false", __SB_LATEX_HOSTS__: BOARD_TEX_HOSTS, __SB_ENGINE__: JSON.stringify(ENGINE), __SB_NO_SYNC__: "true" } });
  if (!ns.success) { for (const l of ns.logs) console.error(l); process.exit(1); }
  boardMystClosure("the board without sync (the frame, exports)", ns);
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
    // (its own exit code, so scripts/build-all.sh can write the notices and build again; CI fails on any)
    process.exit(3);
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
const SHELL = ["./", "sagebrush-worker.js", "sagebrush-console.js", "sagebrush-math.js", "sagebrush-viewer3d.js", "sagebrush-graphview.js", "sagebrush-history.js", "sagebrush-analyze.js", "manifest.webmanifest", "offline-inventory.json", ...ICONS, ...KATEX];
const LAZY = ["docs-index.json", "docs-index-python.json", "docs-index-matlab.json", "docs-index-magma.json", ...UPSTREAM_FILES, "sagebrush-myst.js", `sagebrush-engine.wasm?h=${engineHash}`, ...LIB_CHUNKS];
// What "Storage -> Offline" lists and "download all" fetches (plan-b8-offline §2-§3): LAZY as items, with each one's
// file count, stored bytes (exact) and transfer bytes (brotli at quality 5 here, the build's estimate of the wire); the
// build refuses a catalog over its caps (web/offline-inventory.mts), and the inventory over its own size caps.
{
  const { offlineInventory, inventoryBytes } = await import("./offline-inventory.mts");
  const { brotliCompressSync, gzipSync, constants: zc } = await import("node:zlib");
  const fileOf = (p: string) => p.split("?")[0];
  const stored = new Map(LAZY.map((p) => [p, statSync(join(here, "dist", fileOf(p))).size]));
  const transfer = new Map(LAZY.map((p) => [p, brotliCompressSync(readFileSync(join(here, "dist", fileOf(p))), { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } }).length]));
  const inv = offlineInventory(LAZY, stored, transfer);
  writeFileSync(join(here, "dist", "offline-inventory.json"), inventoryBytes(inv, (b) => gzipSync(b, { level: 9 })));
  console.log(`offline: ${inv.items.length} items, ${inv.totals.files} files, ${(inv.totals.stored / 1e6).toFixed(1)} MB stored, ~${(inv.totals.transfer / 1e6).toFixed(1)} MB to download, max entry ${(inv.totals.maxEntry / 1e6).toFixed(1)} MB`);
}
const shellHash = new Bun.CryptoHasher("sha256");
for (const f of ["index.html", "docs-index.json", "docs-index-python.json", "docs-index-matlab.json", "docs-index-magma.json", ...UPSTREAM_FILES, "sagebrush-worker.js", "sagebrush-console.js", "sagebrush-math.js", "sagebrush-viewer3d.js", "sagebrush-graphview.js", "sagebrush-history.js", "sagebrush-analyze.js", "manifest.webmanifest", "offline-inventory.json"]) shellHash.update(readFileSync(join(here, "dist", f)));
shellHash.update(engineHash + libManifestHash);
// (each of them by its SHA-256, and the response it is served as: the service
// worker serves a kept copy only if it still has those bytes, and then as a
// response it makes, with this status and these headers, never the kept
// response's own; design/security.md, SEC-8D6-1, SEC-522-1)
const { pagePolicy, frameOptions } = await import("./csp-policy.mts");
const DIGESTS = Object.fromEntries([...SHELL, ...LAZY].map((p) => {
  const file = p === "./" ? "index.html" : p.split("?")[0];
  const bytes = readFileSync(join(here, "dist", file));
  const mime = MIME[file.split(".").pop()!];
  if (!mime) throw new Error(`sw.js: no type for ${file}`);
  // (as web/_headers and web/csp.ts give it: every file cross-origin isolated, a page its policy)
  const headers: Record<string, string> = { "Content-Type": mime, "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
  if (file.endsWith(".html")) Object.assign(headers, { "Content-Security-Policy": pagePolicy(scriptHashes(bytes.toString("utf8"))), "X-Frame-Options": frameOptions(pagePolicy())! });
  return [p.split("?")[0], { sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), size: bytes.length, headers }];
}));
{
  // (the shipped service worker is web/sw.js minus its test-only hook block, byte for byte, asserted in
  // web/sw-hook.mts; a test build, SAGEBRUSH_OFFLINE_TEST=1, also writes the file with the block as dist/sw.test.js)
  const { stripHook } = await import("./sw-hook.mts");
  // (the stall bound the page's and the worker's chunk fetches use, web/stall-fetch.js: one constant, given to sw.js)
  const { STALL_LIMIT_MS } = await import("./stall-fetch.js");
  const full = readFileSync(join(here, "sw.js"), "utf8").replace("__STALL_LIMIT_MS__", String(STALL_LIMIT_MS)).replace("__VERSION__", shellHash.digest("hex").slice(0, 16)).replace("__SHELL__", JSON.stringify(SHELL)).replace("__LAZY__", JSON.stringify(LAZY)).replace("__DIGESTS__", JSON.stringify(DIGESTS));
  writeFileSync(join(here, "dist", "sw.js"), stripHook(full));
  rmSync(join(here, "dist-test"), { recursive: true, force: true });
  if (process.env.SAGEBRUSH_OFFLINE_TEST === "1") (mkdirSync(join(here, "dist-test")), writeFileSync(join(here, "dist-test", "sw.test.js"), full));
}
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
// the questions preview (web/questions): auto-graded questions on the same component and kernel. Flagged, off by
// default: built only for a hosted preview (scripts/preview.sh sets SAGEBRUSH_PREVIEW_HOST) or with SAGEBRUSH_QUESTIONS=1
// (dist isn't cleared between builds: the directory is removed either way, so a flagged build's page never outlives it)
rmSync(join(here, "dist", "questions"), { recursive: true, force: true });
if (process.env.SAGEBRUSH_PREVIEW_HOST || process.env.SAGEBRUSH_QUESTIONS === "1") {
  mkdirSync(join(here, "dist", "questions"), { recursive: true });
  copyFileSync(join(here, "questions", "index.html"), join(here, "dist", "questions", "index.html"));
}
// the terminal's module (plan-bash-shell r8c step 6, web/shell/terminal.ts): loaded by the notebook page only when
// its ⋯ ▸ Terminal is first opened, so the page carries none of the shell's host, loader or panel
{
  const r = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "shell", "terminal.ts")], outdir: join(here, "dist", "shell"), naming: "terminal.js", target: "browser", format: "esm", minify: true });
  builds.push(["the terminal (shell/terminal.js)", r]);
  if (!r.success) { for (const l of r.logs) console.error(l); process.exit(1); }
  if (hasSite) copyFileSync(join(here, "dist", "shell", "terminal.js"), join(siteDir, "public", "shell", "terminal.js"));
}
// the Terminal commands' bridge (python, sage, matlab, magma; web/shell/term-bridge.ts): a chunk of its own beside
// terminal.js, imported by it on the first command; online only (web/shell/test-term-bridge-size.mjs bounds it)
{
  const r = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "shell", "term-bridge.ts")], outdir: join(here, "dist", "shell"), naming: "term-bridge.js", target: "browser", format: "esm", minify: true });
  builds.push(["the Terminal commands' bridge (shell/term-bridge.js)", r]);
  if (!r.success) { for (const l of r.logs) console.error(l); process.exit(1); }
  if (hasSite) copyFileSync(join(here, "dist", "shell", "term-bridge.js"), join(siteDir, "public", "shell", "term-bridge.js"));
}
// the terminal's package set (plan-bash-shell r8c step 6, web/shell/panel.ts): no site serves pkgset/ or pkg/ yet,
// so every build carries the bash package set itself (scripts/optional-packages.mjs, the same build the optional tier
// publishes), names it in shell/preview-set.json, and copies both into the site.  (Was flagged, for hosted previews
// and SAGEBRUSH_TERMINAL=1 only, until the terminal's preview/DEV host gate was removed; the variable is now a no-op.)
for (const d of ["pkg", "pkgset", "pkgmeta"]) rmSync(join(here, "dist", d), { recursive: true, force: true });
rmSync(join(here, "dist", "shell", "preview-set.json"), { force: true });
{
  const { execFileSync } = await import("node:child_process");
  const S = execFileSync("node", [join(here, "..", "scripts", "optional-packages.mjs"), "build", "--out", join(here, "dist"), "bash"], { encoding: "utf8" }).trim().split("\n").pop()!;
  if (!/^[0-9a-f]{64}$/.test(S)) throw new Error(`the terminal preview's package set: not an id: ${JSON.stringify(S)}`);
  mkdirSync(join(here, "dist", "shell"), { recursive: true });
  writeFileSync(join(here, "dist", "shell", "preview-set.json"), JSON.stringify({ S }) + "\n");
  // the notebooks' package set (QRPM 1b): pandas, source only, so its id changes only when the package does,
  // never with the core's build; named in pkgset/latest.json, which a notebook without a pin resolves once and
  // pins (index.html notebookPkgset, plan-modular-packages-r4 §4.4).  Nothing is fetched until a cell imports
  // it (web/pkgset-browser.ts).  For notebooks only: no grading context admits pandas yet (src/pkgset.ts
  // gradingExcluded).
  const N = execFileSync("node", [join(here, "..", "scripts", "optional-packages.mjs"), "build", "--out", join(here, "dist"), "pandas"], { encoding: "utf8" }).trim().split("\n").pop()!;
  if (!/^[0-9a-f]{64}$/.test(N)) throw new Error(`the notebooks' package set: not an id: ${JSON.stringify(N)}`);
  writeFileSync(join(here, "dist", "pkgset", "latest.json"), JSON.stringify({ id: N }) + "\n");
  if (hasSite) {
    for (const d of ["pkg", "pkgset", "pkgmeta"]) {
      rmSync(join(siteDir, "public", d), { recursive: true, force: true });
      cpSync(join(here, "dist", d), join(siteDir, "public", d), { recursive: true });
    }
    mkdirSync(join(siteDir, "public", "shell"), { recursive: true });
    copyFileSync(join(here, "dist", "shell", "preview-set.json"), join(siteDir, "public", "shell", "preview-set.json"));
  }
}
// the Agents page (web/agents): a full-page chat with artifacts, with the scripted demo or with Claude on the person's own
// computer (sagebrush-agent, over the loopback address).  Built in every build and served by the site at /agents, on
// the site's own origin, so it opens the same browser workspace as the notebook and board pages (William, Nov 8: "How
// to connect your agent", the localhost option).  SAGEBRUSH_AGENTS=1, which CI and the agents tests set, still works
// and changes nothing.
rmSync(join(here, "dist", "agents"), { recursive: true, force: true });
if (hasSite) rmSync(join(siteDir, "public", "agents"), { recursive: true, force: true });
{
  const r = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "agents", "page.ts")], outdir: join(here, "dist", "agents"), naming: "agents.js", target: "browser", format: "esm", minify: true, define: LATEX_DEFINE });
  if (!r.success) {
    for (const l of r.logs) console.error(l);
    process.exit(1);
  }
  // (and "How to connect your agent to Sagebrush", a static page without scripts: /agents/connect/, a directory's
  // index so that every host serves it without a .html: the site's assets and the preview Worker alike)
  mkdirSync(join(here, "dist", "agents", "connect"), { recursive: true });
  for (const f of ["index.html", "connect/index.html"]) copyFileSync(join(here, "agents", f), join(here, "dist", "agents", f));
  // (the reviewed sagebrush-agent tarball the help box points to: not committed; placed in web/agents by the publisher)
  for (const f of readdirSync(join(here, "agents"))) if (/^sagebrush-agent-\d+\.\d+\.\d+\.tgz$/.test(f)) copyFileSync(join(here, "agents", f), join(here, "dist", "agents", f));
  // (the site's copy: the pages and the script; the help box points at the reviewed tarball's own immutable URL, so
  // no tarball is served from the site)
  if (hasSite) {
    mkdirSync(join(siteDir, "public", "agents"), { recursive: true });
    mkdirSync(join(siteDir, "public", "agents", "connect"), { recursive: true });
    for (const f of ["index.html", "agents.js", "connect/index.html"]) copyFileSync(join(here, "dist", "agents", f), join(siteDir, "public", "agents", f));
  }
}
// the numerics core's browser-threads demo (web/threads, numerics-core r4.2 milestone M0): a dense product on 1 and N
// threads of the tab, through engine/nd's WebAssembly module (wasm/sagebrush-nd.wasm). Flagged like the questions
// preview: built only for a hosted preview (scripts/preview.sh sets SAGEBRUSH_PREVIEW_HOST) or with SAGEBRUSH_THREADS=1
rmSync(join(here, "dist", "threads"), { recursive: true, force: true });
if (process.env.SAGEBRUSH_PREVIEW_HOST || process.env.SAGEBRUSH_THREADS === "1") {
  for (const [entry, naming] of [["page.ts", "threads.js"], ["worker.ts", "threads-worker.js"]]) {
    const r = await Bun.build(<any>{ metafile: true, entrypoints: [join(here, "threads", entry)], outdir: join(here, "dist", "threads"), naming, target: "browser", format: "esm", minify: true });
    builds.push([`the threads demo (threads/${naming})`, r]);
    if (!r.success) {
      for (const l of r.logs) console.error(l);
      process.exit(1);
    }
  }
  copyFileSync(join(here, "threads", "index.html"), join(here, "dist", "threads", "index.html"));
  copyFileSync(join(here, "..", "wasm", "sagebrush-nd.wasm"), join(here, "dist", "threads", "sagebrush-nd.wasm"));
}
if (hasSite) mkdirSync(join(siteDir, "public", "embed"), { recursive: true });
if (hasSite) mkdirSync(join(siteDir, "public", "runner"), { recursive: true });
// the shared collection page, served for /s/<id> by the site's Worker
mkdirSync(join(here, "dist", "s"), { recursive: true });
copyFileSync(join(here, "share-client", "view.html"), join(here, "dist", "s", "index.html"));
// (its link preview's image, board's design: committed as rendered, never generated here; og.svg is its source)
copyFileSync(join(here, "share-client", "og.png"), join(here, "dist", "s", "og.png"));
if (hasSite) mkdirSync(join(siteDir, "public", "s"), { recursive: true });
// /version.json: what this build is, for an agent (or a person) asking a site which code it runs: the core commit it was
// built from (HEAD of the core tree the build ran in: a deploy's, at its core.lock), when, its engine's and library's ids,
// and whether the LaTeX editor is in it. Never cached (web/_headers), and outside the service worker's shell, so always this deploy's.
{
  const git = (...a: string[]) => { try { return execFileSync("git", a, { cwd: join(here, ".."), encoding: "utf8" }).trim(); } catch { return null; } };
  const sha = git("rev-parse", "HEAD");
  writeFileSync(join(here, "dist", "version.json"), JSON.stringify({
    core: sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null,
    built: new Date().toISOString(),
    engine: engineHash,
    build: buildId,
    latex: LATEX,
  }, null, 1) + "\n");
}
// The site's files from web/dist (the cloud overlay deploys web/site/public). Every top-level bundle is one of them,
// or named as not for the site: a lazy chunk left off this list is a 404 on sagebrush.space (the zip export and
// the GitHub push were, until Nov 2).
const SITE_FILES = ["version.json", "index.html", "alpha-banner.js", "THIRD-PARTY-NOTICES.txt", "llms.txt", "board-format.md", "board-host-protocol.md", "board-format.schema.json", "capabilities.md", "docs-index.json", "docs-index-python.json", "docs-index-matlab.json", "docs-index-magma.json", ...UPSTREAM_FILES, "sagebrush-worker.js", "sagebrush-console.js", "sagebrush-math.js", "sagebrush-myst.js", "sagebrush-viewer3d.js", "sagebrush-graphview.js", "sagebrush-notebook.js", "sagebrush-history.js", "sagebrush-analyze.js", "sagebrush-share.js", "sagebrush-share-copy.js", "s/index.html", "sagebrush-share-deps.js", "sagebrush-share-folder.js", "sagebrush-agent.js", "sagebrush-agent-run.js", "sagebrush-review.js", "sagebrush-remote.js", "sagebrush-remote-terminal.js", "s/og.png", "runner/index.html", "embed/index.html", "sagebrush-engine.wasm", "sw.js", "manifest.webmanifest", "offline-inventory.json", "sagebrush-raster.wasm", "sagebrush-nd.wasm", "sagebrush-mp.wasm", "sagebrush-export.js", "sagebrush-export-worker.js", "sagebrush-gitpush-panel.js", "sagebrush-gitpush-worker.js", "sagebrush-examples-panel.js", "sagebrush-code.js"];
/** web/dist's top-level bundles the site doesn't serve: the desktop app's self-test (app/build-frontend.mjs). */
const NOT_ON_SITE = ["sagebrush-selftest.js"]; // (and the LaTeX editor's, sagebrush-latex*, copied below in a LaTeX build)
{
  const left = readdirSync(join(here, "dist")).filter((f) => /^sagebrush-.*\.(js|wasm)$/.test(f) && !f.startsWith("sagebrush-latex") && !SITE_FILES.includes(f) && !NOT_ON_SITE.includes(f));
  if (left.length) throw new Error(`web/build.ts: ${left.join(", ")} in web/dist but not in SITE_FILES (served on the site) or NOT_ON_SITE`);
}
for (const f of SITE_FILES)
  if (hasSite) copyFileSync(join(here, "dist", f), join(siteDir, "public", f));
// (the LaTeX editor's files, in a LaTeX build only; a stale copy from an earlier one is removed either way)
if (hasSite) for (const f of readdirSync(join(siteDir, "public"))) if (f.startsWith("sagebrush-latex")) rmSync(join(siteDir, "public", f));
if (hasSite && LATEX) for (const f of ["sagebrush-latex.js", "sagebrush-latex-examples.js", "sagebrush-latex-doc.js", "sagebrush-latex-share.js", "sagebrush-latex-worker.js", "sagebrush-latex-comments.js", "sagebrush-latex-run.js", "sagebrush-latex-comments-doc.js", "sagebrush-latex-agent.js", "sagebrush-latex-tools.js", "sagebrush-latex-present.js", "sagebrush-latex-beamer.js", "sagebrush-latex-pythontex.js", "sagebrush-latex-interact.js", "sagebrush-latex-view.js"]) copyFileSync(join(here, "dist", f), join(siteDir, "public", f));
// (the library's chunks)
if (hasSite) rmSync(join(siteDir, "public", "lib"), { recursive: true, force: true });
if (hasSite) cpSync(join(here, "dist", "lib"), join(siteDir, "public", "lib"), { recursive: true });
// (the articles and the examples gallery, and the sitemap of both: web/build-sitemap.ts)
if (hasSite) await (await import("./build-sitemap.ts")).buildSitemap();
// (the service worker's test hook is in no deployable directory: web/sw-hook.mts)
{
  const { assertNoHookIn } = await import("./sw-hook.mts");
  await assertNoHookIn(join(here, "dist"));
  if (hasSite) await assertNoHookIn(join(siteDir, "public"));
}
// every page's Content-Security-Policy, in _headers (web/csp.ts)
(await import("./csp.ts")).writeHeaders();
const size = statSync(join(here, "dist", "sagebrush-worker.js")).size;
console.log(`web/dist/sagebrush-worker.js ${(size / 1e6).toFixed(2)} MB, sagebrush-console.js ${(statSync(join(here, "dist", "sagebrush-console.js")).size / 1e3).toFixed(0)} kB`);
