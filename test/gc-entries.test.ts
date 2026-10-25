import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// test/gc-entries.cjs, sbx.test.ts's GC log: every collection of a run is in
// the log, however the event loop delivers the entries (astra2's
// CORR-PR151-1: one zero timer at beforeExit lost all ten of a run's entries
// in 5 of 60 fresh processes).  Each process forces K collections, a
// synchronous program as a Python run is, and must log all K, marked
// complete, every time.
const PRELOAD = process.env.SAGEBRUSH_GC_PRELOAD ?? __dirname + "/../../test/gc-entries.cjs";
const run = promisify(execFile);

test("the GC log holds every forced collection of a synchronous run, in each of 60 fresh processes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-entries-"));
  const N = 60, K = 10;
  try {
    const counts: string[] = [];
    // (6 at a time, so that the processes are fresh and the test stays short)
    for (let i = 0; i < N; i += 6) {
      await Promise.all(
        Array.from({ length: Math.min(6, N - i) }, async (_, j) => {
          const log = join(dir, `gc-${i + j}.json`);
          await run(process.execPath, ["--expose-gc", "--require", PRELOAD, "-e", `for (let i = 0; i < ${K}; i++) { let x = new Array(100000).fill(i); global.gc(); }`], {
            env: { ...process.env, SAGEBRUSH_GC_LOG: log },
          });
          const j0 = JSON.parse(readFileSync(log, "utf8"));
          const entries = Array.isArray(j0) ? j0 : j0.entries;
          counts[i + j] = `${entries.length}${j0.complete === true ? "" : " incomplete"}`;
        })
      );
    }
    assert.deepEqual(counts, Array(N).fill(String(K)), counts.join(", "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
