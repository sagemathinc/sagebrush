// Differential test: run each program under CPython and pyjs, compare stdout
// and (for failures) the exception type.
//
//   node scripts/difftest.mjs [dir-or-files...] [--jobs N] [--show N] [--filter substr]

import { spawn } from "node:child_process";
import { readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const jobs = Number(opt("--jobs", Math.max(2, os.cpus().length - 2)));
const show = Number(opt("--show", 20));
const filter = opt("--filter", "");
const report = opt("--report", "");
const inputs = args.length ? args : ["upstream/micropython/basics", "test/py"];
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

let files = [];
for (const p of inputs) {
  if (!existsSync(p)) continue;
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p).sort()) if (f.endsWith(".py") && !existsSync(join(p, f + ".exp"))) files.push(join(p, f));
  } else files.push(p);
}
if (filter) files = files.filter((f) => f.includes(filter));

function run(cmd, argv, cwd) {
  return new Promise((res) => {
    const child = spawn(cmd, argv, { cwd, timeout: 20000, env: { ...process.env, PYTHONHASHSEED: "0" } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code, signal) => res({ out, err, code: signal ? -1 : code }));
  });
}

const excType = (err) => {
  const lines = err.trim().split("\n");
  const last = lines[lines.length - 1] ?? "";
  const m = /^([\w.]+)(:|$)/.exec(last);
  return m ? m[1] : last.slice(0, 60);
};

const results = [];
let next = 0;
async function worker() {
  while (next < files.length) {
    const f = files[next++];
    const dir = resolve(f, "..");
    const [py, js] = await Promise.all([run("python3", [resolve(f)], dir), run("node", [join(root, "dist/src/cli.js"), resolve(f)], dir)]);
    let status;
    if (py.code !== 0 && /SKIP/.test(py.out.split("\n").slice(-2).join(""))) status = "skip";
    else if (js.code === -1) status = "timeout";
    else if (js.out === py.out && (py.code === 0 ? js.code === 0 : excType(js.err) === excType(py.err))) status = "pass";
    else if (/internal error|SystemError/.test(js.err)) status = "crash";
    else if (/SyntaxError|unsupported (statement|expression)/.test(js.err) && !/SyntaxError/.test(py.err)) status = "compile";
    else status = "fail";
    results.push({ f, status, py, js });
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
results.sort((a, b) => a.f.localeCompare(b.f));
const counts = {};
for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
const bad = results.filter((r) => r.status !== "pass" && r.status !== "skip");
for (const r of bad.slice(0, show)) {
  const why = r.js.err.trim().split("\n").slice(-1)[0]?.slice(0, 150) || (r.js.out !== r.py.out ? "stdout differs" : `exit ${r.js.code} vs ${r.py.code}`);
  console.log(`${r.status.padEnd(8)} ${r.f.split("/").pop().padEnd(32)} ${why}`);
}
console.log(JSON.stringify(counts), `of ${results.length}`);
if (report) writeFileSync(report, JSON.stringify(results.map((r) => ({ f: r.f, status: r.status, err: r.js.err.slice(-500) })), null, 1));
