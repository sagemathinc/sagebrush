// Bundles a js package's module (plan-modular-packages r4 addendum A1.3): run
// by scripts/optional-packages.mjs under bun, since Bun.build is the bundler
// web/build.ts already uses.
//   bun scripts/js-bundle.mjs optional/<name> OUT.js
// The entry is sagebrush.json's js.source; bare imports resolve only through
// js.aliases (each a pinned file of the package), and any other bare import is
// an error, so nothing comes from node_modules or the network.  One ES module,
// for the browser, minified but for its identifiers.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [dir, out] = process.argv.slice(2);
const m = JSON.parse(readFileSync(join(dir, "sagebrush.json"), "utf8"));
const aliases = m.js.aliases ?? {};
const unresolved = [];
const result = await Bun.build({
  entrypoints: [resolve(dir, m.js.source)],
  target: "browser",
  format: "esm",
  // (identifiers kept: the publisher's AST checks read hostCall and its names in the published bytes)
  minify: { whitespace: true, syntax: true, identifiers: false },
  plugins: [
    {
      name: "pinned-aliases",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (a) => {
          if (Object.hasOwn(aliases, a.path)) return { path: resolve(dir, aliases[a.path]) };
          unresolved.push(`${a.path} (from ${a.importer})`);
          return { path: a.path, external: true };
        });
      },
    },
  ],
});
if (unresolved.length) {
  console.error(`bare imports with no alias in sagebrush.json: ${unresolved.join(", ")}`);
  process.exit(1);
}
if (!result.success || result.outputs.length !== 1) {
  console.error(result.logs.map(String).join("\n") || `expected one output, got ${result.outputs.length}`);
  process.exit(1);
}
await Bun.write(out, await result.outputs[0].text());
