// ci: checks.6 order=31
// scripts/ci-local.py's ownership of the four WebAssembly modules: its preflight refuses a rebuild over any module that
// isn't its pin, and at the end it restores the pins only when every changed module is still exactly its own build;
// otherwise it restores nothing and reports.  The controls are Python (ci-local.py's own functions): this runs them.
//   node scripts/test-ci-local-restore.mjs
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync("python3", ["-I", join(root, "scripts", "ci-local-restore-controls.py"), root], { encoding: "utf8" });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
const rows = r.stdout.split("\n").filter((l) => /^(ok|FAIL)/.test(l));
if (r.status !== 0 || rows.length !== 10) {
  console.log(`FAIL ci-local restore controls: exit ${r.status}, ${rows.length} of 10 rows`);
  process.exit(1);
}
console.log("all passed");
