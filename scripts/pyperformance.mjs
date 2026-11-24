// Run bench/pyperformance/bm_*.py under CPython and pyjs; print per-benchmark
// cold and warm times and ratios (pyjs / CPython).
//
//   node scripts/pyperformance.mjs [--python python3] [--only name,...]

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const python = opt("--python", "python3");
const only = opt("--only", "");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dir = join(root, "bench/pyperformance");
let files = readdirSync(dir).filter((f) => /^bm_.*\.py$/.test(f)).sort();
if (only) files = files.filter((f) => only.split(",").some((o) => f.includes(o)));

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, { cwd: dir, encoding: "utf8", timeout: 600000 });
  const rows = new Map();
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = /^(\S+) ([\d.]+) ([\d.]+)$/.exec(line.trim());
    if (m) rows.set(m[1], [Number(m[2]), Number(m[3])]);
  }
  const err = (r.stderr ?? "").trim().split("\n").filter((l) => !/^\s+at /.test(l)).pop() ?? "";
  return { rows, err: r.status === 0 ? "" : err };
}

const fmt = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
console.log("| benchmark | CPython warm ms | pyjs warm ms | warm ratio | cold ratio |");
console.log("| --- | ---: | ---: | ---: | ---: |");
const ratios = [];
for (const f of files) {
  const py = run(python, [f]);
  const js = run("node", [join(root, "dist/src/cli.js"), f]);
  for (const [name, [pc, pw]] of py.rows) {
    const j = js.rows.get(name);
    if (!j) {
      console.log(`| ${name} | ${fmt(pw)} | fails: ${js.err.slice(0, 60)} | | |`);
      continue;
    }
    ratios.push(j[1] / pw);
    console.log(`| ${name} | ${fmt(pw)} | ${fmt(j[1])} | ${(j[1] / pw).toFixed(2)} | ${(j[0] / pc).toFixed(2)} |`);
  }
}
const geo = Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length);
console.log(`\ngeometric mean warm ratio over ${ratios.length}: ${geo.toFixed(2)}`);
