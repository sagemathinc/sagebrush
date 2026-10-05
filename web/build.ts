// bun web/build.ts  ->  web/dist/{index.html, llms.txt, sagebrush-worker.js, sagebrush-console.js,
//                                sagebrush-math.js, katex/, sagebrush-engine.wasm}
// The pyjs compiler and runtime for browsers: Node APIs are replaced by
// web/shims, the Python library is embedded, the Unicode name table is not.
import { mkdirSync, copyFileSync, statSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const shims: Record<string, string> = {
  fs: "fs.ts", vm: "vm.ts", path: "path.ts", os: "os.ts", crypto: "crypto.ts",
};
const result = await Bun.build({
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
const consoleResult = await Bun.build({
  entrypoints: [join(here, "console.ts")],
  outdir: join(here, "dist"),
  naming: "sagebrush-console.js",
  target: "browser",
  format: "esm",
  minify: true,
});
// Math in Markdown cells (KaTeX), loaded on first use.  (Markdown itself,
// small and usually in the first cell, is part of the page script.)
const mathResult = await Bun.build({ entrypoints: [join(here, "math.ts")], outdir: join(here, "dist"), naming: "sagebrush-math.js", target: "browser", format: "esm", minify: true });
for (const r of [result, consoleResult, mathResult]) {
  if (!r.success) {
    for (const m of r.logs) console.error(m);
    process.exit(1);
  }
}
// index.html with its page script minified (wrapped in a function, so its
// names stay out of the global scope).
{
  const html = readFileSync(join(here, "index.html"), "utf8");
  const m = /<script id="app">([\s\S]*?)<\/script>/.exec(html)!;
  const tmp = join(here, "dist", "app.tmp.js");
  // web/markdown.ts is bundled in, as globalThis.__sbMarkdown
  writeFileSync(tmp, `import * as __md from "../markdown.ts";\nglobalThis.__sbMarkdown = __md;\n` + m[1] + "\nexport {};\n"); // an ES module: Bun would wrap a script in an uncalled CommonJS shim
  const app = await Bun.build({ entrypoints: [tmp], target: "browser", format: "iife", minify: true });
  if (!app.success) {
    for (const l of app.logs) console.error(l);
    process.exit(1);
  }
  rmSync(tmp);
  const js = (await app.outputs[0].text()).trim();
  writeFileSync(join(here, "dist", "index.html"), html.slice(0, m.index) + "<script>" + js + "</script>" + html.slice(m.index + m[0].length));
}
copyFileSync(join(here, "llms.txt"), join(here, "dist", "llms.txt"));
// the engines (modular symbols, a_p ...), fetched by the worker on first use
copyFileSync(join(here, "..", "wasm", "sagebrush-engine.wasm"), join(here, "dist", "sagebrush-engine.wasm"));
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
  const r = await Bun.build({ entrypoints: [join(here, "atlas", entry)], outdir: join(here, "dist", "atlas"), naming: { entry: name, chunk: "atlas-[hash].js" }, splitting: true, target: "browser", format: "esm", minify: true });
  if (!r.success) {
    for (const l of r.logs) console.error(l);
    process.exit(1);
  }
}
copyFileSync(join(here, "atlas", "llms.txt"), join(here, "dist", "atlas", "llms.txt"));
if (!existsSync(join(here, "dist", "atlas", "data", "stats.json"))) console.warn("web/dist/atlas/data is missing: run scripts/build-atlas.mjs (see web/atlas/README.md)");
// The Cloudflare site (web/site) serves the same files.
rmSync(join(here, "site", "public", "atlas"), { recursive: true, force: true });
cpSync(join(here, "dist", "atlas"), join(here, "site", "public", "atlas"), { recursive: true });
mkdirSync(join(here, "site", "public", "katex", "fonts"), { recursive: true });
for (const f of ["index.html", "llms.txt", "sagebrush-worker.js", "sagebrush-console.js", "sagebrush-math.js", "sagebrush-engine.wasm", ...KATEX])
  copyFileSync(join(here, "dist", f), join(here, "site", "public", f));
const size = statSync(join(here, "dist", "sagebrush-worker.js")).size;
console.log(`web/dist/sagebrush-worker.js ${(size / 1e6).toFixed(2)} MB, sagebrush-console.js ${(statSync(join(here, "dist", "sagebrush-console.js")).size / 1e3).toFixed(0)} kB`);
