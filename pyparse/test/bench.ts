// Parse time per file: best of N runs (warm), plus the first (cold) run.
import { readFileSync } from "fs";
import { parse } from "../src/index";
for (const f of process.argv.slice(2)) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n").length;
  let t = performance.now();
  parse(src);
  const cold = performance.now() - t;
  let best = 1e9;
  for (let i = 0; i < 10; i++) {
    t = performance.now();
    parse(src);
    best = Math.min(best, performance.now() - t);
  }
  console.log(`${f.split("/").pop()}: ${lines} lines; first run ${cold.toFixed(1)} ms, warm ${best.toFixed(1)} ms (${(lines / best).toFixed(0)} lines/ms)`);
}
