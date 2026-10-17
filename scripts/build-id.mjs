// The build id: a hash of the compiler and runtime (src/**/*.ts), the
// Python library (lib/**/*.py) and the packages' registry (which pins each
// package's files: packages/registry.json, scripts/packages.mjs).  scripts/build-cli.mjs stamps it into the
// bundle (build/cli/lib.gen.js); web/build.ts checks that bundle is the
// current sources' before building the page (a stale bundle would pair the
// current worker with older precompiled library code).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** The library's files, by path relative to lib/ (no __pycache__). */
export function libFiles(root) {
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
  return lib;
}

export function buildId(root, lib = libFiles(root)) {
  const hash = createHash("sha256");
  const walkSrc = (dir) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walkSrc(p);
      else if (f.endsWith(".ts")) hash.update(relative(root, p) + "\0" + readFileSync(p, "utf8") + "\0");
    }
  };
  walkSrc(join(root, "src"));
  for (const k of Object.keys(lib).sort()) hash.update(k + "\0" + lib[k] + "\0");
  const registry = join(root, "packages", "registry.json");
  if (existsSync(registry)) hash.update("packages/registry.json\0" + readFileSync(registry, "utf8") + "\0");
  return hash.digest("hex").slice(0, 16);
}
