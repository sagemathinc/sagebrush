// bun web/build.ts  ->  web/dist/{index.html, sagebrush-worker.js}
// The pyjs compiler and runtime for browsers: Node APIs are replaced by
// web/shims, the Python library is embedded, the Unicode name table is not.
import { mkdirSync, copyFileSync, statSync } from "node:fs";
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
if (!result.success) {
  for (const m of result.logs) console.error(m);
  process.exit(1);
}
copyFileSync(join(here, "index.html"), join(here, "dist", "index.html"));
// The Cloudflare site (web/site) serves the same two files.
mkdirSync(join(here, "site", "public"), { recursive: true });
for (const f of ["index.html", "sagebrush-worker.js"]) copyFileSync(join(here, "dist", f), join(here, "site", "public", f));
const size = statSync(join(here, "dist", "sagebrush-worker.js")).size;
console.log(`web/dist/sagebrush-worker.js ${(size / 1e6).toFixed(2)} MB`);
