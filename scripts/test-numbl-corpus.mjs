// ci: web-runner-sync order=20
// The Numbl corpus ratchet (upstream/numbl/README.md) on CI's full tier: master pushes, the nightly schedule and a
// dispatch (web-runner-sync is a full-tier-only job, and builds the CLI this runs), never a pull request's fast tier.
// Every vendored numbl script through the CLI's MATLAB mode: red on a regression or a script lost, NEW PASS reported.
// test/numbl-ratchet.test.ts keeps this header where it is, and checks this file's exit status (N3): non-zero for a red
// ratchet, a missing CLI and a ratchet killed by a signal. (NUMBL_CORPUS_CLI and NUMBL_CORPUS_RATCHET are for that
// test only: a fake CLI path and a fake ratchet; CI sets neither.)
//   node scripts/web-tests.mjs run web-runner-sync    (or: node scripts/test-numbl-corpus.mjs, after the CLI build)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = process.env.NUMBL_CORPUS_CLI ?? join(root, "build", "cli", "pyjs.cjs");
const ratchet = process.env.NUMBL_CORPUS_RATCHET ?? join(root, "scripts", "numbl-ratchet.py");
if (!existsSync(cli)) {
  console.error(`numbl corpus: no ${cli} (node scripts/build-cli.mjs first)`);
  process.exit(1);
}
const jobs = process.env.SAGEBRUSH_CPUS ?? String(Math.min(8, availableParallelism()));
const r = spawnSync("python3", [ratchet, "--cli", cli, "--node", process.execPath, "--jobs", jobs], {
  stdio: "inherit",
});
if (r.error) console.error(`numbl corpus: python3: ${r.error.message}`);
if (r.signal) console.error(`numbl corpus: the ratchet was killed by ${r.signal}`);
// (a signal leaves no status: that is a failure too)
process.exitCode = r.error ? 127 : (r.status ?? 1);
