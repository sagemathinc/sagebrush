// Differential fuzzing of the reactive notebook (src/notebook-reactive.ts,
// src/rename.ts) against plain Python.
//
//   node dist/test/fuzz-reactive.js [--seed N] [--cases N] [--steps N] [--out file]
//
// Each case is a random notebook, run by the reactive scheduler (with
// page-order scoping) in CPython (test/fuzz_kernel.py), then changed by
// random edits, inserts, deletes and moves, each followed by the reactive
// runs the notebook would do.  After every step, every cell the scheduler
// shows as computed must show what a fresh top-to-bottom run of the notebook
// prints (the reference), leaving out cells shown with an error (a refused
// rename: the documented fallback, counted).  A failure is shrunk (fewer
// steps, cells, statements) and printed with the code that ran.
//
// The generator keeps to what the rules promise to match top-to-bottom
// Python (articles/notebook/01-how-cells-run.md): no mutation of shared
// objects, no randomness or files, no definitions that depend on a run-time
// condition, and functions called from other cells read only their
// parameters and K (a function reads the definitions its own cell sees, not
// those in force when it is called later: by design, not compared).
import { writeFileSync } from "node:fs";
import { Kernel, makeCase, runCase, shrink, show, type Failure, type Stats } from "./fuzz-lib";

// ------------------------------------------------------------ main

async function main() {
  const arg = (name: string, d: number) => { const i = process.argv.indexOf(name); return i >= 0 ? +process.argv[i + 1] : d; };
  const out = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : null; })();
  const seed0 = arg("--seed", 1), cases = arg("--cases", 200), steps = arg("--steps", 6), maxFail = arg("--max-failures", 5);
  const k = new Kernel();
  const stats: Stats = { compared: 0, refused: 0, unclean: 0, steps: 0 };
  const found: string[] = [];
  const t0 = Date.now();
  for (let s = seed0; s < seed0 + cases && found.length < maxFail; s++) {
    const c = makeCase(s, steps);
    let f: Failure | null;
    try {
      f = await runCase(k, c, stats);
    } catch (e: any) {
      f = { step: -1, cell: "", why: "the harness threw", detail: String(e?.stack ?? e) };
    }
    if (!f) continue;
    const [small, sf] = await shrink(k, c, f);
    const report = `FAIL (seed ${s}): ${sf.why}, cell ${sf.cell} after step ${sf.step}\n${show(small)}\n${sf.detail}\n`;
    found.push(report);
    console.log(report);
  }
  k.close();
  const summary = `${cases} cases from seed ${seed0}, ${stats.steps} checks, ${stats.compared} cell outputs compared, ${stats.refused} cells shown with an error (refused), ${stats.unclean} checks where plain Python raised; ${found.length} failures; ${((Date.now() - t0) / 1000).toFixed(1)} s`;
  console.log(summary);
  if (out) writeFileSync(out, found.join("\n") + summary + "\n");
  process.exit(found.length ? 1 : 0);
}

main();
