import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// numpy.random's binomial and scipy.stats.bootstrap against NumPy 2.5 and SciPy 1.18 (test/stats-oracle.json,
// recorded by test/stats_oracle_gen.py from the cases in test/random_binomial_cases.py and
// test/scipy_bootstrap_cases.py).  The binomial draws, and the stream they leave, are NumPy's exactly.  The
// bootstrap's resamples are SciPy's exactly (the same draws: each case's distribution hash); its values agree
// to 1e-12 relative, the last bits being where SciPy's own arithmetic differs: ndtri and ndtr in the BCa
// interval, and NumPy's sums along a strided axis (the two cases of 2-d data, whose distributions are compared
// by value, not by hash).
const ROOT = join(__dirname, "..", "..");
const CLI = join(__dirname, "..", "src", "cli.js");
const oracle = JSON.parse(readFileSync(join(ROOT, "test", "stats-oracle.json"), "utf8"));

function runCases(file: string): Record<string, any> {
  const C = readFileSync(join(ROOT, "test", file), "utf8");
  const program = `
import json, math
ns = {}
exec(${JSON.stringify(C)}, ns)
def plain(v):
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, float) and math.isinf(v):
        return "inf" if v > 0 else "-inf"
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
    return v
for cid, code in ns["CASES"]:
    g = {}
    try:
        exec(ns.get("PRELUDE", "") + ns.get("DATA", "") + code, g)
        print("@@" + json.dumps([cid, plain(g["out"])]))
    except Exception as e:
        print("@@" + json.dumps([cid, {"error": type(e).__name__, "message": str(e)}]))
`;
  const got: Record<string, any> = {};
  for (const line of execFileSync(process.execPath, [CLI, "-c", program], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n")) {
    if (line.startsWith("@@")) {
      const [cid, out] = JSON.parse(line.slice(2));
      got[cid] = out;
    }
  }
  return got;
}

test("numpy.random binomial: NumPy's draws exactly, the RandomState's and the Generator's, and the stream after", () => {
  const want = oracle["random_binomial_cases.py"];
  const got = runCases("random_binomial_cases.py");
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort());
  for (const cid of Object.keys(want)) assert.deepEqual(got[cid], want[cid], cid);
});

test("scipy.stats.bootstrap: SciPy's resamples exactly, its intervals and standard errors to 1e-12", () => {
  const want = oracle["scipy_bootstrap_cases.py"];
  const got = runCases("scipy_bootstrap_cases.py");
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort());
  const byValue = new Set(["axis-2d", "axis-0-columns"]);
  const bad: string[] = [];
  const cmp = (w: any, g: any, path: string) => {
    if (Array.isArray(w) && Array.isArray(g) && w.length === g.length) { w.forEach((x, i) => cmp(x, g[i], `${path}[${i}]`)); return; }
    if (typeof w === "number" && typeof g === "number") {
      if (w === g || Math.abs(w - g) <= 1e-12 * Math.max(Math.abs(w), Math.abs(g))) return;
    } else if (typeof w === "string" && /^[0-9a-f]{16}$/.test(w) && byValue.has(path.split("[")[0])) return;
    else if (JSON.stringify(w) === JSON.stringify(g)) return;
    bad.push(`${path}: SciPy ${JSON.stringify(w)}, ours ${JSON.stringify(g)}`);
  };
  for (const cid of Object.keys(want)) cmp(want[cid], got[cid], cid);
  assert.deepEqual(bad, []);
});
