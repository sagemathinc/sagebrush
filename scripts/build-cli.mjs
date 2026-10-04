// Build pyjs as one JavaScript file with the Python library embedded, and
// from it self-contained executables.
//
//   node scripts/build-cli.mjs           build/cli/pyjs.cjs (run with node or bun)
//   node scripts/build-cli.mjs --sea     + build/cli/pyjs-node   (Node single executable)
//   node scripts/build-cli.mjs --bun     + build/cli/pyjs-bun    (bun build --compile)
//
// The bundle is made by Bun (fast TypeScript bundler); the Python files in
// lib/ become globalThis.__PYJS_LIB__ (see libDir() in src/compile.ts).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "build", "cli");
mkdirSync(out, { recursive: true });
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });

// 1. The Python library, as a JS object.
const lib = {};
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== "__pycache__") walk(p);
    } else if (f.endsWith(".py")) lib[relative(join(root, "lib"), p)] = readFileSync(p, "utf8");
  }
};
walk(join(root, "lib"));
writeFileSync(join(out, "lib.gen.js"), `globalThis.__PYJS_LIB__ = ${JSON.stringify(lib)};\n`);
writeFileSync(join(out, "entry.ts"), `import "./lib.gen.js";\nimport "../../src/cli";\n`);

// 2. One CommonJS file for Node 22+ and Bun.
run("bun", ["build", join(out, "entry.ts"), "--target=node", "--format=cjs", "--minify-syntax", "--minify-whitespace",
  "--external", "web-tree-sitter", "--external", "tree-sitter-python", "--outfile", join(out, "pyjs.cjs")]);
const bundle = join(out, "pyjs.cjs");
writeFileSync(bundle, "#!/usr/bin/env node\n" + readFileSync(bundle, "utf8").replace(/^#!.*\n/, ""));
// A launcher that turns on Node's compile cache before loading the bundle
// (about 20 ms off every start once the cache is warm).
writeFileSync(join(out, "pyjs"), `#!/usr/bin/env node\ntry { require("node:module").enableCompileCache?.(); } catch {}\nrequire("./pyjs.cjs");\n`, { mode: 0o755 });
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
  run("bun", ["build", join(out, "entry.ts"), "--compile", "--minify", "--bytecode",
    "--external", "web-tree-sitter", "--external", "tree-sitter-python", "--outfile", join(out, "pyjs-bun")]);
  console.log(`bun executable: ${join(out, "pyjs-bun")} (${(statSync(join(out, "pyjs-bun")).size / 1e6).toFixed(1)} MB)`);
}
