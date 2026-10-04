// Build pyjs as one JavaScript file with the Python library embedded, and
// from it self-contained executables.
//
//   node scripts/build-cli.mjs           build/cli/pyjs.cjs (run with node or bun)
//   node scripts/build-cli.mjs --sea     + build/cli/pyjs-node   (Node single executable)
//   node scripts/build-cli.mjs --bun     + build/cli/pyjs-bun    (bun build --compile)
//   node scripts/build-cli.mjs --deno    + build/cli/pyjs-deno   (deno compile; --target=<triple> cross-compiles)
//   node scripts/build-cli.mjs --sandbox + build/cli/pyjs-sandbox (deno compile with no permissions:
//                                          no files, env, network or subprocesses; programs on stdin)
//
// The bundle is made by Bun (fast TypeScript bundler); the Python files in
// lib/ become globalThis.__PYJS_LIB__ (see libDir() in src/compile.ts).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, copyFileSync, existsSync } from "node:fs";

// deno compile embeds node_modules when it finds a package.json above the
// entry point; compile a copy of the bundle from an empty directory.
function denoCompile(flags, exe) {
  const dir = mkdtempSync(join(tmpdir(), "sagebrush-deno-"));
  copyFileSync(bundle, join(dir, "sagebrush.cjs"));
  run("deno", ["compile", "--no-check", "--no-config", ...flags, "-o", exe, join(dir, "sagebrush.cjs")], { cwd: dir });
  // Windows targets get ".exe" appended.
  return existsSync(exe) ? exe : exe + ".exe";
}

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
const version = JSON.parse(readFileSync(join(root, "packages", "sagebrush", "package.json"), "utf8")).version;
writeFileSync(join(out, "lib.gen.js"), `globalThis.__SAGEBRUSH_VERSION__ = ${JSON.stringify(version)};\nglobalThis.__PYJS_LIB__ = ${JSON.stringify(lib)};\n`);
writeFileSync(join(out, "entry.ts"), `import "./lib.gen.js";\nimport "../../src/cli";\n`);

// 2. One CommonJS file for Node 22+ and Bun.
run("bun", ["build", join(out, "entry.ts"), "--target=node", "--format=cjs", "--minify-syntax", "--minify-whitespace",
  "--external", "web-tree-sitter", "--external", "tree-sitter-python", "--outfile", join(out, "pyjs.cjs")]);
const bundle = join(out, "pyjs.cjs");
writeFileSync(bundle, "#!/usr/bin/env node\n" + readFileSync(bundle, "utf8").replace(/^#!.*\n/, ""));
// A launcher that turns on Node's compile cache before loading the bundle
// (about 20 ms off every start once the cache is warm).
writeFileSync(join(out, "pyjs"), `#!/usr/bin/env node\ntry { require("node:module").enableCompileCache?.(); } catch {}\nrequire("./pyjs.cjs");\n`, { mode: 0o755 });
// The npm package `sagebrush` (packages/sagebrush) ships this bundle.
mkdirSync(join(root, "packages", "sagebrush", "dist"), { recursive: true });
writeFileSync(join(root, "packages", "sagebrush", "dist", "sagebrush.cjs"), readFileSync(bundle, "utf8").replace(/^#!.*\n/, ""));
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

// 3c. Deno single-file executable (same V8 as Node; cross-compiles with
// --target, e.g. aarch64-apple-darwin, x86_64-pc-windows-msvc).
if (process.argv.includes("--deno")) {
  const target = process.argv.find((a) => a.startsWith("--target="));
  const exe = denoCompile(["-A", ...(target ? [target] : [])], join(out, "pyjs-deno" + (target ? "-" + target.slice(9) : "")));
  console.log(`deno executable: ${exe} (${(statSync(exe).size / 1e6).toFixed(1)} MB)`);
}

// 3d. The sandbox: a Deno executable granted nothing.  Permissions are fixed
// at compile time and --no-prompt makes every denial a PermissionError
// instead of a question on the terminal.  Programs come on stdin or as the
// interactive prompt; the embedded library still imports.  Add scoped grants
// with e.g. PYJS_SANDBOX_ALLOW="--allow-read=."
if (process.argv.includes("--sandbox")) {
  const target = process.argv.find((a) => a.startsWith("--target="));
  const extra = (process.env.PYJS_SANDBOX_ALLOW ?? "").split(/\s+/).filter(Boolean);
  const exe = denoCompile(["--no-prompt", ...extra, ...(target ? [target] : [])], join(out, "pyjs-sandbox" + (target ? "-" + target.slice(9) : "")));
  console.log(`sandbox executable: ${exe} (${(statSync(exe).size / 1e6).toFixed(1)} MB)${extra.length ? " grants: " + extra.join(" ") : ""}`);
}
