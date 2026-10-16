import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Figures from the command line (agent-UX R0-7): a run leaves no files
// behind unless asked (--figures DIR), and board run and board check say what
// each figure is: its size and what it shows.
const cli = join(__dirname, "..", "src", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "sb-figures-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: dir });
const PLOT = "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3], [1, 4, 9])\nplt.title('Squares')\nplt.show()\n";

test("a figure shown from the command line: in a directory of the run's own, removed at exit; --figures DIR keeps it, never over a file", () => {
  writeFileSync(join(dir, "plot.py"), PLOT);
  let r = run(["plot.py"]);
  assert.equal(r.status, 0, r.stderr);
  const m = /^Saved (\S+) \(Plot: "Squares"; [^\n]*\)\n\(figures are removed when sagebrush exits; sagebrush --figures DIR keeps them\)\n$/m.exec(r.stdout);
  assert.ok(m, r.stdout);
  assert.match(m![1], /[\\/]sagebrush-figures-[^\\/]+[\\/]figure-1\.svg$/);
  // (nothing left: not the file, not its directory)
  assert.ok(!existsSync(m![1]) && !existsSync(join(m![1], "..")), m![1]);
  // --figures DIR: kept, numbered past what is there
  const keep = join(dir, "kept");
  r = run(["--figures", keep, "plot.py"]);
  assert.match(r.stdout, new RegExp(`^Saved ${keep.replace(/[/\\\\.]/g, "\\$&")}/figure-1\\.svg \\(Plot: "Squares"`, "m"));
  assert.doesNotMatch(r.stdout, /removed when sagebrush exits/);
  r = run(["--figures", keep, "plot.py"]);
  assert.match(r.stdout, /figure-2\.svg/);
  assert.deepEqual(readdirSync(keep).sort(), ["figure-1.svg", "figure-2.svg"]);
  assert.match(readFileSync(join(keep, "figure-1.svg"), "utf8"), /^<svg /);
  assert.equal(run(["--figures"]).status, 2);
});

const BOARD = { format: "sagebrush-board", version: 1, nodes: [{ id: "sq", title: "Squares", code: PLOT }, { id: "t", code: "print(6 * 7)" }] };

test("board run: each figure's size and what it shows; --figures DIR saves them as ITEM-1.svg", () => {
  const f = join(dir, "plots.board.json");
  writeFileSync(f, JSON.stringify(BOARD));
  let r = run(["board", "run", f]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\n {7}figure 640×480: Plot: "Squares"; line through 3 points; [^\n]*\n/);
  const out = join(dir, "figs");
  r = run(["board", "run", "--figures", out, f]);
  assert.match(r.stdout, new RegExp(`figure 640×480: Plot: "Squares"; [^\\n]* \\(saved ${out.replace(/[/\\\\.]/g, "\\$&")}/sq-1\\.svg\\)\\n`));
  assert.deepEqual(readdirSync(out), ["sq-1.svg"]);
  const j = JSON.parse(run(["board", "run", "--json", f]).stdout);
  assert.deepEqual(j.items[0].outputs[0].figure, { w: 640, h: 480, title: j.items[0].outputs[0].figure.title });
  assert.match(j.items[0].outputs[0].figure.title, /^Plot: "Squares"; line through 3 points/);
  // (again: beside the first, not over it)
  run(["board", "run", "--figures", out, f]);
  assert.deepEqual(readdirSync(out).sort(), ["sq-1.svg", "sq-2.svg"]);
});

test("board check: the figures counted, and saved with --figures DIR", () => {
  const f = join(dir, "check.board.json");
  writeFileSync(f, JSON.stringify(BOARD));
  let r = run(["board", "check", f]);
  assert.equal(r.stdout, "check.board.json: no problems; 2 code items run (python): 2 ok, 1 figure\n");
  const out = join(dir, "check-figs");
  r = run(["board", "check", "--figures", out, f]);
  assert.equal(r.stdout, `check.board.json: no problems; 2 code items run (python): 2 ok, 1 figure saved in ${out}\n`);
  assert.ok(existsSync(join(out, "sq-1.svg")));
});

// (a child's stdout until `re` matches it, then the match)
function waitFor(p: any, re: RegExp, ms = 60000): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${re}: ${out}`)), ms);
    p.stdout.setEncoding("utf8").on("data", (d: string) => { out += d; const m = re.exec(out); if (m) { clearTimeout(t); resolve(m); } });
  });
}
const exited = (p: any) => new Promise<[number | null, string | null]>((resolve) => p.on("exit", (code: number | null, sig: string | null) => resolve([code, sig])));

test("figures of a process a signal ends: the prompt removes its own; a script's go with the next run, and the script still dies at once (HARD-191-1)", async () => {
  const { spawn } = require("node:child_process");
  const { dirname } = require("node:path");
  // the prompt: removed on SIGTERM, and it still ends by the signal
  // (-i: the prompt after the script, its input from a pipe kept open)
  writeFileSync(join(dir, "plot.py"), PLOT);
  const repl = spawn(process.execPath, [cli, "-i", "plot.py"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  // (the prompt itself: until it is up this is still the script, whose
  // signals keep their default action)
  const m = await waitFor(repl, /Saved (\S+\.svg)[\s\S]*>>> $/);
  assert.ok(existsSync(m[1]));
  const done = exited(repl);
  repl.kill("SIGTERM");
  assert.deepEqual(await done, [null, "SIGTERM"]);
  assert.ok(!existsSync(dirname(m[1])), m[1]);
  // a script busy computing: SIGTERM ends it at once (no handler to wait for it); its directory is left
  writeFileSync(join(dir, "busy.py"), PLOT + "print('busy', flush=True)\nwhile True:\n    pass\n");
  const busy = spawn(process.execPath, [cli, "busy.py"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const b = await waitFor(busy, /Saved (\S+\.svg)[\s\S]*busy\n/);
  const bdone = exited(busy), t0 = Date.now();
  busy.kill("SIGTERM");
  assert.deepEqual(await bdone, [null, "SIGTERM"]);
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(existsSync(dirname(b[1])));
  // the next sagebrush that shows a figure removes it, an hour later (its process is gone)
  let r = run(["plot.py"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(dirname(b[1])), b[1]);
  const old = new Date(Date.now() - 2 * 3600e3);
  utimesSync(dirname(b[1]), old, old);
  r = run(["plot.py"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(dirname(b[1])), b[1]);
});

test("the sweep removes only a directory it can tell is a sagebrush's: never another one of the same prefix (HARD-B98-1)", () => {
  // (a temporary directory of the test's own, TMPDIR, where node takes it;
  // else the system's, with names of this run's own)
  const env = { ...process.env, TMPDIR: mkdtempSync(join(dir, "tmp-")) };
  const tmp = spawnSync(process.execPath, ["-p", "require('os').tmpdir()"], { encoding: "utf8", env }).stdout.trim();
  const dead = 999999999; // (no such pid: above the kernel's pid_max)
  const tag = Math.random().toString(36).slice(2, 5).padEnd(3, "0");
  const old = new Date(Date.now() - 2 * 3600e3);
  const make = (name: string, files: Record<string, string>, opts: { mark?: string | null; mode?: number; recent?: boolean } = {}) => {
    const p = join(tmp, name);
    mkdirSync(p, { mode: 0o700 });
    chmodSync(p, opts.mode ?? 0o700);
    if (opts.mark !== null) writeFileSync(join(p, ".sagebrush-figures"), opts.mark ?? `sagebrush figures ${name.split("-")[2]}\n`);
    for (const [f, t] of Object.entries(files)) writeFileSync(join(p, f), t);
    if (!opts.recent) utimesSync(p, old, old);
    return p;
  };
  const stale = make(`sagebrush-figures-${dead}-Ab${tag}1`, { "figure-1.svg": "<svg/>", "figure-2.svg": "<svg/>" });
  const kept = [
    make(`sagebrush-figures-${dead}-daybreak-victim${tag}`, { "figure-1.svg": "<svg/>" }), // not mkdtemp's name
    make(`sagebrush-figures-${dead}-nM${tag}1`, {}, { mark: null }), // no mark
    make(`sagebrush-figures-${dead}-oT${tag}1`, {}, { mark: "sagebrush figures 12\n" }), // another pid's mark
    make(`sagebrush-figures-${dead}-tH${tag}1`, { "figure-1.svg": "<svg/>", "thesis.tex": "mine" }), // something else in it
    make(`sagebrush-figures-${dead}-sH${tag}1`, {}, { mode: 0o755 }), // not mkdtemp's mode
    make(`sagebrush-figures-${dead}-rE${tag}1`, {}, { recent: true }), // touched within the hour
    make(`sagebrush-figures-${process.pid}-aL${tag}1`, {}), // its process is there
  ];
  const target = make(`sagebrush-target-${tag}`, { "figure-1.svg": "<svg/>" }, { mark: null });
  symlinkSync(target, join(tmp, `sagebrush-figures-${dead}-lN${tag}1`)); // a link, not followed
  writeFileSync(join(dir, "plot.py"), PLOT);
  try {
    const r = spawnSync(process.execPath, [cli, "plot.py"], { encoding: "utf8", cwd: dir, env });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(stale), stale);
    for (const p of kept) assert.ok(existsSync(p), p);
    assert.deepEqual(readdirSync(kept[3]).sort(), [".sagebrush-figures", "figure-1.svg", "thesis.tex"]);
    assert.deepEqual(readdirSync(target), ["figure-1.svg"]);
  } finally {
    for (const p of [stale, ...kept, target, join(tmp, `sagebrush-figures-${dead}-lN${tag}1`)]) rmSync(p, { recursive: true, force: true });
  }
});

test("the sweep's work is bounded: a stale directory with more entries than a run leaves is left alone, at once (HARD-260-1)", () => {
  const env = { ...process.env, TMPDIR: mkdtempSync(join(dir, "tmp-")) };
  const tmp = spawnSync(process.execPath, ["-p", "require('os').tmpdir()"], { encoding: "utf8", env }).stdout.trim();
  const tag = Math.random().toString(36).slice(2, 5).padEnd(3, "0");
  const big = join(tmp, `sagebrush-figures-999999999-Bg${tag}1`);
  mkdirSync(big, { mode: 0o700 });
  chmodSync(big, 0o700);
  writeFileSync(join(big, ".sagebrush-figures"), "sagebrush figures 999999999\n");
  for (let i = 1; i <= 10000; i++) writeFileSync(join(big, `figure-${i}.svg`), "");
  const old = new Date(Date.now() - 2 * 3600e3);
  utimesSync(big, old, old);
  try {
    writeFileSync(join(dir, "plot.py"), PLOT);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [cli, "plot.py"], { encoding: "utf8", cwd: dir, env });
    assert.equal(r.status, 0, r.stderr);
    // (10,001 entries: past the 10,000 a sweep reads of one directory)
    assert.equal(readdirSync(big).length, 10001);
    assert.ok(Date.now() - t0 < 30000);
  } finally {
    rmSync(big, { recursive: true, force: true });
  }
});

test("a figure's path and description reach the terminal as one line (HARD-191-2)", () => {
  const odd = join(dir, "figs\nINJECTED:\x1b[31m");
  const r = run(["--figures", odd, "plot.py"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(r.stdout.replace(/\n/g, "")), JSON.stringify(r.stdout));
  assert.equal(r.stdout.split("\n").filter((l) => l.startsWith("INJECTED")).length, 0, r.stdout);
  assert.match(r.stdout, /^Saved .*figs\\x0aINJECTED:\\x1b\[31m\/figure-1\.svg /m);
});
