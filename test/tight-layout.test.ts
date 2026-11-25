import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// matplotlib's tight_layout and subplots_adjust, compared with what matplotlib 3.11 does with the same figures
// (test/tight_layout_cases.py; matplotlib's side recorded by test/tight_layout_oracle_gen.py into
// test/tight-layout-oracle.json): every Axes' position after the layout within 1e-9 of the figure, its ticks the same, and the same warnings. And the text sizes the layout is computed from: each
// sample text as wide and as tall as matplotlib's Agg renderer measures it, exactly.
const ROOT = join(__dirname, "..", "..");
const CLI = join(__dirname, "..", "src", "cli.js");
const oracle = JSON.parse(readFileSync(join(ROOT, "test", "tight-layout-oracle.json"), "utf8"));

const run = (program: string) => execFileSync(process.execPath, [CLI, "-c", program], { encoding: "utf8", maxBuffer: 64 << 20 });

test("tight_layout and subplots_adjust place the subplots where matplotlib does, with its ticks and warnings", () => {
  const C = readFileSync(join(ROOT, "test", "tight_layout_cases.py"), "utf8");
  const program = `
import json, warnings
ns = {}
exec(${JSON.stringify(C)}, ns)
for cid, code in ns["CASES"]:
    g = {}
    try:
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            exec(ns["PRELUDE"] + code, g)
        print("@@" + json.dumps([cid, {"out": g["out"], "warnings": [str(x.message) for x in w]}]))
    except Exception as e:
        print("@@" + json.dumps([cid, {"error": "%s: %s" % (type(e).__name__, e)}]))
`;
  const got: Record<string, any> = {};
  for (const line of run(program).split("\n")) {
    if (line.startsWith("@@")) {
      const [cid, out] = JSON.parse(line.slice(2));
      got[cid] = out;
    }
  }
  assert.deepEqual(Object.keys(got).sort(), Object.keys(oracle.rows).sort());
  const bad: string[] = [];
  for (const [cid, want] of Object.entries(oracle.rows) as [string, any][]) {
    const ours = got[cid];
    if (ours.error) { bad.push(`${cid}: ${ours.error}`); continue; }
    assert.deepEqual(ours.warnings, want.warnings, `${cid}: warnings`);
    if (ours.out.length !== want.out.length) { bad.push(`${cid}: ${ours.out.length} Axes, matplotlib ${want.out.length}`); continue; }
    const tol = 1e-9;
    want.out.forEach((w: any, i: number) => {
      const o = ours.out[i];
      w.pos.forEach((v: number, k: number) => {
        if (!(Math.abs(v - o.pos[k]) <= tol)) bad.push(`${cid} Axes ${i} pos[${k}]: matplotlib ${v}, ours ${o.pos[k]}`);
      });
      for (const a of ["xticks", "yticks"]) {
        if (w[a] === null && o[a] === null) continue;
        const same = w[a] !== null && o[a] !== null && w[a].length === o[a].length && w[a].every((v: number, k: number) => Math.abs(v - o[a][k]) <= 1e-9 * Math.max(1, Math.abs(v)));
        if (!same) bad.push(`${cid} Axes ${i} ${a}: matplotlib ${JSON.stringify(w[a])}, ours ${JSON.stringify(o[a])}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});

test("text is as wide and as tall as matplotlib's Agg renderer measures it (the sizes tight_layout lays out with)", () => {
  const program = `
import json
from matplotlib._tight_layout import text_metrics
texts = json.loads(${JSON.stringify(JSON.stringify(oracle.texts))})
print("@@" + json.dumps([list(text_metrics(s, size, 100)) for s, size, w, a, d in texts]))
`;
  const line = run(program).split("\n").find((l) => l.startsWith("@@"))!;
  const ours: number[][] = JSON.parse(line.slice(2));
  const bad = (oracle.texts as [string, number, number, number, number][])
    .map(([s, size, w, a, d], i) => [s, size, [w, a, d], ours[i]] as const)
    .filter(([, , want, got]) => want.some((v, k) => v !== got[k]))
    .map(([s, size, want, got]) => `${JSON.stringify(s)} at ${size} pt: matplotlib ${want}, ours ${got}`);
  assert.deepEqual(bad, []);
});

test("subplots_adjust refuses left at or past right and bottom at or past top, and tight_layout a keyword it hasn't, as matplotlib does", () => {
  const out = run(`
import matplotlib.pyplot as plt
fig = plt.figure()
for kw in ({"left": 0.6, "right": 0.5}, {"bottom": 0.9, "top": 0.9}):
    try:
        fig.subplots_adjust(**kw)
        print("no error")
    except ValueError as e:
        print("ValueError:", e)
for f in (lambda: fig.tight_layout(padding=1), lambda: plt.tight_layout(padding=1)):
    try:
        f()
        print("no error")
    except TypeError as e:
        print("TypeError:", e)
`);
  assert.equal(out, "ValueError: left cannot be >= right\nValueError: bottom cannot be >= top\n" +
    "TypeError: Figure.tight_layout() got an unexpected keyword argument 'padding'\nTypeError: tight_layout() got an unexpected keyword argument 'padding'\n");
});
