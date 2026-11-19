// Build the whitespace prototype into dist/: one bundled script (three.js and marked inside it, nothing fetched
// from elsewhere), the page, and the spaces in public/.  Plain node:  node build.mjs
// Into a built site instead, at /space/ (where the agents chat shows a .space.json in it):
//   node build.mjs --site ../web/dist      (then `bun web/csp.ts`, so the site's _headers cover the page)
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
});
cpSync(join(here, "index.html"), join(dist, "index.html"));
const spaces = [];
for (const f of readdirSync(join(here, "public"))) {
  cpSync(join(here, "public", f), join(dist, f));
  if (f.endsWith(".space.json")) spaces.push(f);
}
writeFileSync(join(dist, "spaces.json"), JSON.stringify(spaces.sort()) + "\n");
console.log(`${site ? dist : "dist/"}: index.html, space.js,`, spaces.join(", "));
