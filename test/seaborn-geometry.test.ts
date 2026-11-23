import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What Sagebrush's seaborn draws, compared with what seaborn 0.13.2 draws for the same cases
// (test/seaborn_geometry_cases.py; seaborn's side recorded by test/seaborn_oracle_gen.py into
// test/seaborn-oracle.json): the points, bars, cells and lines, their colors, sizes and edges, the axes'
// limits, ticks and labels, and the legends' entries.  Numbers agree to 1e-9 relative; colors to the byte
// they are drawn as.  Legend titles are not compared: this matplotlib's legend has no title yet.
const ROOT = join(__dirname, "..", "..");
const CLI = join(__dirname, "..", "src", "cli.js");
const oracle: Record<string, any> = JSON.parse(readFileSync(join(ROOT, "test", "seaborn-oracle.json"), "utf8")).rows;

let pkgset = "";
let work = "";
test.before(() => {
  work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "sb-seaborn-geom-"));
  const id = execFileSync(process.execPath, [join(ROOT, "scripts", "optional-packages.mjs"), "build", "--out", work, "pandas"],
    { encoding: "utf8" }).trim().split("\n").pop()!;
  pkgset = join(work, "pkgset", id + ".json");
});
test.after(() => rmSync(work, { recursive: true, force: true }));

const run = (program: string, cwd?: string, extra: string[] = []) =>
  execFileSync(process.execPath, [CLI, "--pkgset", pkgset, ...extra, "-c", program],
    { encoding: "utf8", cwd: cwd ?? work, maxBuffer: 64 << 20 });

function compare(want: any, got: any, path: string, bad: string[]) {
  if (path.endsWith(".legend.title")) return;
  if (want === null && got === null) return;
  if (Array.isArray(want) && Array.isArray(got)) {
    if (want.length !== got.length) { bad.push(`${path}: ${want.length} items, ours ${got.length}`); return; }
    want.forEach((w, i) => compare(w, got[i], `${path}[${i}]`, bad));
    return;
  }
  if (want && typeof want === "object" && got && typeof got === "object") {
    for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
      if (!(k in got)) bad.push(`${path}.${k}: missing on ours`);
      else if (!(k in want)) bad.push(`${path}.${k}: extra on ours`);
      else compare(want[k], got[k], `${path}.${k}`, bad);
    }
    return;
  }
  if (typeof want === "number" && typeof got === "number") {
    if (Math.abs(want - got) <= 1e-9 * Math.max(1, Math.abs(want))) return;
    // (a color channel: equal as drawn, a byte)
    if (/\.(face|edge|color)\b|\.texts\[/.test(path) && Math.round(want * 255) === Math.round(got * 255)) return;
  } else if (want === got) return;
  bad.push(`${path}: seaborn ${JSON.stringify(want)}, ours ${JSON.stringify(got)}`);
}

test("seaborn's scatterplot, lineplot, histplot, kdeplot, stripplot, barplot and heatmap draw what seaborn draws", () => {
  const C = readFileSync(join(ROOT, "test", "seaborn_geometry_cases.py"), "utf8");
  // (each case in a namespace of its own, after the primitives' readers and the data)
  const program = `
import json
ns = {}
exec(${JSON.stringify(C)}, ns)
for cid, code in ns["CASES"]:
    g = {}
    try:
        exec(ns["OURS_PRELUDE"] + ns["DATA"] + code, g)
        print("@@" + json.dumps([cid, g["out"]]))
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
  assert.deepEqual(Object.keys(got).sort(), Object.keys(oracle).sort());
  const bad: string[] = [];
  for (const cid of Object.keys(oracle)) {
    const want = { ...oracle[cid] };
    // (a heatmap's colors are compared, not the values matplotlib keeps beside them)
    if (cid.startsWith("heat")) { delete want.values; delete want.clim; }
    compare(want, got[cid], cid, bad);
  }
  assert.deepEqual(bad, []);
});

test("seaborn.load_dataset reads seaborn's URL through the folder's data snapshot, with the dataset's level orders", () => {
  // (a made-up tips.csv, pinned at seaborn's URL in a snapshot of this folder; another dataset isn't pinned)
  const dir = mkdtempSync(join(work, "data-"));
  const body = Buffer.from("total_bill,tip,sex,smoker,day,time,size\n10.0,1.0,Female,No,Sun,Dinner,2\n" +
    "12.5,2.0,Male,Yes,Thur,Lunch,3\n20.0,3.5,Male,No,Sat,Dinner,2\n8.0,1.5,Female,Yes,Fri,Lunch,1\n");
  const sha = createHash("sha256").update(body).digest("hex");
  const url = "https://raw.githubusercontent.com/mwaskom/seaborn-data/master/tips.csv";
  const snap = join(dir, ".sagebrush-data");
  mkdirSync(join(snap, "blobs", "sha256", sha.slice(0, 2)), { recursive: true });
  writeFileSync(join(snap, "blobs", "sha256", sha.slice(0, 2), sha), body);
  const entry = { endpoint: "import", url, method: "GET", status: 200, fetched_at: "2026-11-23T00:00:00Z", sha256: sha,
    size: body.length, content_type: "text/csv", via: "import", source: "raw.githubusercontent.com", terms: "test",
    recorded_by: "test" };
  writeFileSync(join(snap, "snapshot.json"), JSON.stringify({ format: "sagebrush-data", version: 1, revision: 1,
    entries: { ["GET " + url]: entry } }));
  const out = run(`
import seaborn as sns
from urllib.error import URLError
tips = sns.load_dataset("tips")
print(tips.shape, list(tips.columns), tips["tip"].tolist())
ax = sns.barplot(data=tips, x="day", y="tip", errorbar=None)
print([t.get_text() for t in ax.get_xticklabels()])
try:
    sns.load_dataset("penguins")
except URLError as e:
    print("URLError", e.reason)
try:
    sns.load_dataset(tips)
except TypeError as e:
    print("TypeError", str(e)[:58])
`, dir, ["--data-root", dir]);
  assert.equal(out, [
    "(4, 7) ['total_bill', 'tip', 'sex', 'smoker', 'day', 'time', 'size'] [1.0, 2.0, 3.5, 1.5]",
    // (seaborn makes day an ordered categorical: Thur, Fri, Sat, Sun, whatever the rows' order)
    "['Thur', 'Fri', 'Sat', 'Sun']",
    "URLError seaborn's example dataset 'penguins' is downloaded from " +
      "https://raw.githubusercontent.com/mwaskom/seaborn-data/master/penguins.csv, which Sagebrush can't do here " +
      "(not-pinned: not in this folder's snapshot: https://raw.githubusercontent.com/mwaskom/seaborn-data/master/penguins.csv)",
    "TypeError This function accepts only strings (the name of an example",
    "",
  ].join("\n"));
});
