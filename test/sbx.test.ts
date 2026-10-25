import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// sbx (lib/_sbx.py), board interchange between languages (D4): on plain
// Python values exactly what CPython does with the same module
// (test/sbx_cases.py); between the four modes, each mode's own values
// encoded, decoded in every mode and encoded again (test/sbx_modes_cases.py).
const TEST = __dirname + "/../../test/";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("sbx on plain Python values: CPython's output, every value read back as it was, every bad one refused saying why", () => {
  const want = execFileSync("python3", [TEST + "sbx_cases.py"], { encoding: "utf8" });
  assert.ok(want.endsWith("done\n") && !want.includes("FAIL"), want);
  assert.equal(cli([TEST + "sbx_cases.py"]), want);
});

// (the nested decode's CPU ratio, recorded on every run, passing or not, for
// the bound's later review (shard-7 proposal r1): the ratio, user and system
// CPU apart, wall time, and the V8 GC entries inside each decode's window,
// from test/gc-entries.cjs preloaded into the CLI's process)
function sbxDiagnostics(out: string, gcLog: string): string[] {
  const line = out.split("\n").find((l) => l.startsWith("SBXDIAG "));
  if (!line) return ["sbx diagnostics: no SBXDIAG line"];
  const d = JSON.parse(line.slice(8));
  let gc: [number, number, number][] = [];
  try {
    gc = JSON.parse(readFileSync(gcLog, "utf8"));
  } catch {
    return [`sbx ratio ${d.ratio.toFixed(1)} (${d.took_s.toFixed(2)} s over ${d.base_s.toFixed(3)} s); no GC log`];
  }
  const lines = [`sbx ratio ${d.ratio.toFixed(1)} (${d.took_s.toFixed(2)} s over ${d.base_s.toFixed(3)} s); ${gc.length} GC entries in the run`];
  for (const w of d.windows) {
    let n = 0, ms = 0;
    for (const [start, dur] of gc) {
      const overlap = Math.min(start + dur, w.end_ms) - Math.max(start, w.start_ms);
      if (overlap > 0) n++, (ms += overlap);
    }
    lines.push(`  ${w.label}: wall ${(w.end_ms - w.start_ms).toFixed(0)} ms, user ${w.user_s.toFixed(2)} s, system ${w.system_s.toFixed(2)} s, GC ${n} entries ${ms.toFixed(0)} ms`);
  }
  return lines;
}

test("sbx between Python, Sage, Magma and MATLAB: each mode's values in every mode, and what a mode can't hold refused", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sbx-gc-"));
  const gcLog = join(dir, "gc.json");
  try {
    const out = execFileSync(process.execPath, ["--require", TEST + "gc-entries.cjs", __dirname + "/../src/cli.js", TEST + "sbx_modes_cases.py"], {
      encoding: "utf8",
      env: { ...process.env, SAGEBRUSH_GC_LOG: gcLog },
    });
    const diag = sbxDiagnostics(out, gcLog);
    for (const l of diag) t.diagnostic(l);
    assert.ok(out.trimEnd().endsWith("all passed"), out.split("\n").filter((l) => !l.startsWith("ok")).join("\n") + "\n" + diag.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
