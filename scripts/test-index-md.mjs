// ci: checks.3 order=147
// INDEX.md, the map of the repository that agents read first (sagebrush_source's "index", #1663): every path it
// names in backticks exists at this commit, so the map can't point at code that moved or went away.
//   node scripts/test-index-md.mjs
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = readFileSync(join(root, "INDEX.md"), "utf8");
// (a backticked repository path: starts with a top-level name, has a slash or a file extension; commands and
// options aren't paths)
const paths = [...text.matchAll(/`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.*-]*)*)`/g)].map((m) => m[1]).filter((p) => p.includes("/") || /\.[a-z]+$/.test(p));
const missing = [];
for (const p of paths) {
  if (p.includes("*")) {
    // (a glob like lib/_matlab_*.py: at least one file must match)
    const dir = join(root, dirname(p));
    const re = new RegExp("^" + p.split("/").pop().replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$");
    const { readdirSync } = await import("node:fs");
    if (!existsSync(dir) || !readdirSync(dir).some((n) => re.test(n))) missing.push(p);
  } else if (!existsSync(join(root, p.replace(/\/$/, "")))) missing.push(p);
}
if (paths.length < 40) {
  console.error(`INDEX.md: only ${paths.length} paths found; the check can't be right`);
  process.exit(1);
}
if (missing.length) {
  console.error(`INDEX.md names paths that don't exist: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`INDEX.md: all ${paths.length} paths exist`);
