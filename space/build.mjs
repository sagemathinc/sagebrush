// Build the whitespace prototype into dist/: one bundled script (three.js and marked inside it, nothing fetched
// from elsewhere), the page, and the spaces in public/.  Plain node:  node build.mjs
// Into a built site instead, at /space/ (where the agents chat shows a .space.json in it):
//   node build.mjs --site ../web/dist      (then `bun web/csp.ts`, so the site's _headers cover the page)
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const at = process.argv.indexOf("--site");
const site = at > 0 ? resolve(process.argv[at + 1] ?? "") : null;
if (site && !existsSync(join(site, "agents", "index.html"))) throw new Error(`--site ${site}: not a built site (no agents/index.html): run bun web/build.ts first`);
const dist = site ? join(site, "space") : join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [join(here, "src", "main.js")],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  outfile: join(dist, "space.js"),
  logLevel: "warning",
  // (src/main.js takes the site's Markdown, ../web/markdown.ts, whose "marked" comes from here when the repository's
  //  own packages aren't installed)
  nodePaths: [join(here, "node_modules")],
});
cpSync(join(here, "index.html"), join(dist, "index.html"));
const spaces = [];
for (const f of readdirSync(join(here, "public"))) {
  // (the site's build refuses any file in web/dist with the service worker's test hook in it, web/sw-hook.mts: refused
  //  here first, with the file named, rather than on the next site build)
  if (site && readFileSync(join(here, "public", f), "utf8").includes("// <offline-test>")) throw new Error(`public/${f} carries "// <offline-test>", which the site's build refuses`);
  cpSync(join(here, "public", f), join(dist, f));
  if (f.endsWith(".space.json")) spaces.push(f);
}
writeFileSync(join(dist, "spaces.json"), JSON.stringify(spaces.sort()) + "\n");
console.log(`${site ? dist : "dist/"}: index.html, space.js,`, spaces.join(", "));
