// Build the whitespace prototype into dist/: one bundled script (three.js and marked inside it, nothing fetched
// from elsewhere), the page, and the spaces in public/.  Plain node:  node build.mjs
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
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
console.log("dist/: index.html, space.js,", spaces.join(", "));
