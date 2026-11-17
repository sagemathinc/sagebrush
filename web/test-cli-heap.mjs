// ci: checks.1 order=11
// The CLI's program (a file, -c, -m: the launcher, build/cli/pyjs, runs it in a worker thread) gets all of the
// computer's memory for its heap, the person's own computer with no cap of ours; the interpreter's heap limit
// (sys._sagebrush_heap_limit) says so. Where the person set --max-old-space-size, that is the heap instead.
//   node web/test-cli-heap.mjs [launcher]   (default build/cli/pyjs, as node scripts/build-cli.mjs writes it)
import { execFileSync } from "node:child_process";
import { totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const launcher = process.argv[2] ?? join(here, "..", "build", "cli", "pyjs");
let failed = 0;
const ok = (c, what) => { console.log((c ? "ok   " : "FAIL ") + what); if (!c) failed++; };
const limit = (env = {}) => Number(execFileSync(process.execPath, [launcher, "-c", "import sys\nprint(sys._sagebrush_heap_limit)"], { encoding: "utf8", env: { ...process.env, ...env } }).trim());
const total = totalmem();
const all = limit();
ok(all >= 0.9 * total, `a program's heap limit is the computer's memory: ${(all / 2 ** 30).toFixed(1)} GiB of ${(total / 2 ** 30).toFixed(1)} GiB`);
const set = limit({ NODE_OPTIONS: "--max-old-space-size=2048" });
ok(set === 2048 * 2 ** 20, `with --max-old-space-size=2048 the person set: ${set}`);
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
