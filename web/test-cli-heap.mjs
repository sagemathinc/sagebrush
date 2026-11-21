// ci: checks.1 order=11
// The CLI's program (a file, -c, -m: the launcher, build/cli/pyjs, runs it in a worker thread) gets all of the
// computer's memory for its heap, the person's own computer with no cap of ours; the interpreter's heap limit
// (sys._sagebrush_heap_limit) says so; a container's limit where there is one, never past it. Where the person set
// --max-old-space-size or --max-heap-size, that is the heap instead.
//   node web/test-cli-heap.mjs [launcher]   (default build/cli/pyjs, as node scripts/build-cli.mjs writes it)
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const launcher = process.argv[2] ?? join(here, "..", "build", "cli", "pyjs");
let failed = 0;
const ok = (c, what) => { console.log((c ? "ok   " : "FAIL ") + what); if (!c) failed++; };
const limit = (env = {}, flags = []) => Number(execFileSync(process.execPath, [...flags, launcher, "-c", "import sys\nprint(sys._sagebrush_heap_limit)"], { encoding: "utf8", env: { ...process.env, ...env } }).trim());
const G = 2 ** 30, M = 2 ** 20, gib = (n) => (n / G).toFixed(2) + " GiB";
// (the interpreter's figure: V8's heap_size_limit, the old generation set plus a young one, less 256 MiB; a third of
// it at most 1 GiB (src/runtime/heap.ts))
// This computer as it is: its memory, or a container's limit where there is one
const cap = Number(process.constrainedMemory?.() || 0), mine = cap > 0 ? Math.min(totalmem(), cap) : totalmem();
const all = limit();
ok(all >= 0.9 * mine - 256 * M && all <= mine, `a program's heap limit is the computer's memory: ${gib(all)} of ${gib(mine)}`);
const set = limit({ NODE_OPTIONS: "--max-old-space-size=2048" });
ok(set === 2048 * M, `with --max-old-space-size=2048 the person set: ${set}`);
// Computers made up, the same on every machine: a preload says what os.totalmem and process.constrainedMemory give
const dir = mkdtempSync(join(tmpdir(), "cli-heap-"));
const as = (total, limitBytes) => {
  const f = join(dir, `as-${total}-${limitBytes}.cjs`);
  writeFileSync(f, `require("node:os").totalmem = () => ${total}; process.constrainedMemory = () => ${limitBytes};\n`);
  return { NODE_OPTIONS: `--require ${JSON.stringify(f)}` };
};
try {
  const two = limit(as(16 * G, 2 * G));
  ok(two >= 1.5 * G && two <= 2 * G, `a 2 GiB container on a 16 GiB computer: the container's memory, ${gib(two)}`);
  const small = limit(as(16 * G, 512 * M));
  ok(small >= 128 * M && small <= 512 * M, `a 512 MiB container: never past its limit, ${gib(small)}`);
  const hs = limit(as(16 * G, 0), ["--max-heap-size=2048"]);
  ok(hs >= 1.5 * G && hs <= 2 * G, `with --max-heap-size=2048 the person set, on a 16 GiB computer: ${gib(hs)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
