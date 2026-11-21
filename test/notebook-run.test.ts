import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNotebook } from "../src/notebook-run";
import { hostOpenFlags } from "../src/runtime/modules";

// `sagebrush notebook run` (src/notebook-run.ts): a notebook's code cells run as the reactive notebook runs them,
// in the notebook's folder, here; --write keeps the outputs and the seed; --confine keeps the program inside its
// folders, through links too.  The rows marked Deno run the built bundle under the Delegate runner's own flags.
const CLI = __dirname + "/../src/cli.js";
const nb = (cells: { id?: string; src: string; type?: string }[], extra: Record<string, unknown> = {}) => JSON.stringify({
  cells: cells.map((c) => ({ cell_type: c.type ?? "code", ...(c.id ? { id: c.id } : {}), metadata: {}, source: c.src, ...(c.type && c.type !== "code" ? {} : { outputs: [], execution_count: null }) })),
  metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, ...((extra.metadata as object) ?? {}) },
  nbformat: 4, nbformat_minor: 5, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "metadata")),
});
// (real paths throughout, as the Delegate runner passes them: on macOS the temporary folder is under /var, a link)
const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "sb-nbrun-")));
const run = (dir: string, args: string[]) => spawnSync(process.execPath, [CLI, "notebook", "run", ...args], { cwd: dir, encoding: "utf8", timeout: 180_000 });
const json = (r: { stdout: string }) => JSON.parse(r.stdout);
const cell = (rep: any, id: string) => rep.cells.find((c: any) => c.id === id);

test("cells run in the order of what they read, a file beside the notebook imports, and the exit says all ok", () => {
  const d = folder();
  writeFileSync(join(d, "helper.py"), "def twice(x):\n    return 2 * x\n");
  writeFileSync(join(d, "a.ipynb"), nb([{ id: "a", src: "from helper import twice\nprint(twice(x))" }, { id: "m", type: "markdown", src: "# hi" }, { id: "b", src: "x = 21" }]));
  const r = run(d, ["a.ipynb", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const rep = json(r);
  assert.equal(rep.ok, true);
  assert.equal(rep.cells.length, 2, "code cells only");
  assert.equal(cell(rep, "a").stdout, "42\n");
  rmSync(d, { recursive: true, force: true });
});

test("a failure cancels only what reads it; an error, a failure and a not-run each say why; exit 1", () => {
  const d = folder();
  writeFileSync(join(d, "f.ipynb"), nb([{ id: "z", src: "z = 1 / 0" }, { id: "r", src: "print(z)" }, { id: "i", src: "print('independent')" }, { id: "s", src: "def (" }]));
  const r = run(d, ["f.ipynb", "--json"]);
  assert.equal(r.status, 1);
  const rep = json(r);
  assert.equal(cell(rep, "z").status, "failed");
  assert.match(cell(rep, "z").error, /ZeroDivisionError/);
  assert.equal(cell(rep, "r").status, "not run");
  assert.match(cell(rep, "r").error, /cell 1, which it depends on, raised an error/);
  assert.equal(cell(rep, "i").status, "ok");
  assert.equal(cell(rep, "s").status, "error");
  rmSync(d, { recursive: true, force: true });
});

test("the seed: a notebook without one gets one, --write keeps it, and the same seed draws the same numbers", () => {
  const d = folder();
  const file = join(d, "s.ipynb");
  writeFileSync(file, nb([{ id: "c", src: "import random\nprint(random.random())" }]));
  const first = json(run(d, ["s.ipynb", "--json", "--write"]));
  assert.equal(first.seed, "new");
  assert.equal(first.wrote, "s.ipynb");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.match(saved.metadata.sagebrush.seed, /^[0-9a-f]{64}$/);
  const second = json(run(d, ["s.ipynb", "--json"]));
  assert.equal(second.seed, "kept");
  assert.equal(cell(second, "c").stdout, cell(first, "c").stdout, "the same seed, the same random number");
  rmSync(d, { recursive: true, force: true });
});

test("--write: each cell's outputs, run time and the order cells finished in; a cell not run keeps nothing; the rest as read", () => {
  const d = folder();
  const file = join(d, "w.ipynb");
  writeFileSync(file, nb([{ id: "p", src: "print(y)" }, { id: "q", src: "y = 5" }, { id: "bad", src: "w = 1/0" }, { id: "after", src: "print(w)" }], { metadata: { custom: { keep: 1 } } }));
  run(d, ["w.ipynb", "--write"]);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const by = (id: string) => saved.cells.find((c: any) => c.id === id);
  assert.deepEqual(by("p").outputs, [{ output_type: "stream", name: "stdout", text: "5\n" }]);
  assert.ok(by("q").execution_count < by("p").execution_count, "q finished before p, which reads it");
  assert.equal(typeof by("p").metadata.sagebrush.ms, "number");
  assert.equal(by("bad").outputs[0].name, "stderr");
  assert.deepEqual(by("after").outputs, []);
  assert.equal(by("after").execution_count, null);
  assert.deepEqual(saved.metadata.custom, { keep: 1 });
  rmSync(d, { recursive: true, force: true });
});

test("--write leaves a notebook changed while its cells ran alone, and says so", () => {
  const d = folder();
  const file = join(d, "c.ipynb");
  writeFileSync(file, nb([{ id: "t", src: "open('c.ipynb', 'a').write(' ')" }]));
  const before = readFileSync(file, "utf8");
  const r = run(d, ["c.ipynb", "--write"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /changed while its cells ran: not written/);
  assert.equal(readFileSync(file, "utf8"), before + " ");
  rmSync(d, { recursive: true, force: true });
});

test("a cell over its time is stopped, and what reads it isn't run", () => {
  const d = folder();
  writeFileSync(join(d, "t.ipynb"), nb([{ id: "slow", src: "import time\nwhile True:\n    time.sleep(0.05)\nv = 1" }, { id: "reads", src: "print(v)" }, { id: "free", src: "print('free')" }]));
  const rep = json(run(d, ["t.ipynb", "--json", "--timeout", "2"]));
  assert.equal(cell(rep, "slow").status, "timeout");
  assert.equal(cell(rep, "reads").status, "not run");
  assert.equal(cell(rep, "free").status, "ok");
  rmSync(d, { recursive: true, force: true });
});

test("what isn't a notebook it runs is refused, saying why", () => {
  const d = folder();
  writeFileSync(join(d, "x.py"), "print(1)");
  assert.equal(run(d, ["x.py"]).status, 2);
  writeFileSync(join(d, "dup.ipynb"), nb([{ id: "same", src: "1" }, { id: "same", src: "2" }]));
  const dup = run(d, ["dup.ipynb"]);
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /two cells have the id "same"/);
  writeFileSync(join(d, "old.ipynb"), JSON.stringify({ nbformat: 3, cells: [] }));
  assert.match(run(d, ["old.ipynb"]).stderr, /nbformat 3/);
  assert.equal(run(d, ["dup.ipynb", "--timeout", "0"]).status, 2);
  assert.equal(run(d, ["dup.ipynb", "--bogus"]).status, 2);
  rmSync(d, { recursive: true, force: true });
});

test("readNotebook: a cell with no valid id gets cell-<place>; the mode from the kernelspec", () => {
  const r = readNotebook(JSON.stringify({ nbformat: 4, metadata: { kernelspec: { name: "sagemath" } }, cells: [{ cell_type: "markdown", source: "x" }, { cell_type: "code", source: ["a = ", "1"] }, { cell_type: "code", id: "bad id!", source: "b" }] }));
  assert.ok(!(r instanceof Error));
  if (r instanceof Error) return;
  assert.equal(r.mode, "sage");
  assert.deepEqual(r.cells.map((c) => [c.key, c.code]), [["cell-2", "a = 1"], ["cell-3", "b"]]);
  assert.equal(r.newSeed, true);
});

// ---- confinement: a sentinel outside, and links planted inside: to it, to a folder outside, dangling, to a folder
// inside, a hard link to it, a FIFO; a sibling folder whose name starts with the root's; a link planted mid-run
function planted() {
  const root = folder();
  const work = join(root, "work"), outside = join(root, "outside"), secret = join(root, "home", ".ssh"), work2 = join(root, "work2"), runTmp = join(root, "run-1");
  mkdirSync(work); mkdirSync(outside); mkdirSync(secret, { recursive: true }); mkdirSync(work2); mkdirSync(runTmp, { mode: 0o700 });
  const sentinel = join(secret, "id_dummy");
  writeFileSync(sentinel, "DUMMY-SENTINEL\n");
  writeFileSync(join(work2, "x"), "WORK2-SENTINEL\n");
  symlinkSync(sentinel, join(work, "planted"));
  symlinkSync(outside, join(work, "dirlink"));
  symlinkSync(join(root, "nowhere"), join(work, "dangling"));
  mkdirSync(join(work, "sub"));
  symlinkSync(join(work, "sub"), join(work, "innerlink"));
  writeFileSync(join(work, "sub", "ok.txt"), "ok");
  try { linkSync(sentinel, join(work, "hard")); } catch {}
  spawnSync("mkfifo", [join(work, "fifo")]);
  writeFileSync(join(work, "helper.py"), "def twice(x):\n    return 2 * x\n");
  const probe = (label: string, expr: string) => `try:\n    _r = ${expr}\n    print(${JSON.stringify(label)}, 'ALLOWED')\nexcept BaseException as _e:\n    print(${JSON.stringify(label)}, 'DENIED', type(_e).__name__)`;
  writeFileSync(join(work, "p.ipynb"), nb([
    { id: "imp", src: "from helper import twice\nprint('import', twice(21))" },
    { id: "s1", src: probe("sentinel-read", `open(${JSON.stringify(sentinel)}).read()`) },
    { id: "s2", src: probe("planted-read", "open('planted').read()") },
    { id: "s3", src: probe("planted-write", "open('planted', 'a').write('x')") },
    { id: "s4", src: probe("dirlink-list", "__import__('os').listdir('dirlink')") },
    { id: "s5", src: probe("dirlink-write", "open('dirlink/new.txt', 'w').write('x')") },
    { id: "s6", src: probe("dotdot-write", "open('sub/../dirlink/new2.txt', 'w').write('x')") },
    { id: "s7", src: probe("parent-write", "open('../escaped.txt', 'w').write('x')") },
    { id: "s8", src: probe("dangling-write", "open('dangling', 'w').write('x')") },
    { id: "s9", src: probe("innerlink-read", "open('innerlink/ok.txt').read()") },
    { id: "s10", src: probe("hardlink-read", "open('hard').read()") },
    { id: "s11", src: probe("fifo-open", "open('fifo').read()") },
    { id: "s12", src: probe("prefix-read", `open(${JSON.stringify(join(work2, "x"))}).read()`) },
    { id: "s13", src: probe("rename-out", "__import__('os').rename('sub/ok.txt', 'dirlink/moved.txt')") },
    { id: "s14", src: probe("rename-in", "__import__('os').rename('planted', 'took.txt')") },
    { id: "s15", src: probe("copy-from", "__import__('shutil').copyfile('planted', 'copy.txt')") },
    { id: "s16", src: probe("copy-to", "__import__('shutil').copyfile('helper.py', 'dirlink/copy.txt')") },
    { id: "s17", src: probe("makedirs-via-link", "__import__('os').makedirs('dirlink/a/b')") },
    { id: "s18", src: probe("remove-via-link", "__import__('os').remove('dirlink/keep.txt')") },
    { id: "s19", src: probe("chdir-link", "__import__('os').chdir('dirlink')") },
    { id: "s20", src: probe("listdir-root", "__import__('os').listdir('/')") },
    { id: "mid", src: "import os, time\nopen('ready', 'w').write('1')\nfor _ in range(400):\n    if os.path.exists('go'):\n        break\n    time.sleep(0.05)\n" + probe("midrun-read", "open('late').read()") },
    { id: "fds", src: "import os\n_open = []\nfor _i in range(3, 256):\n    try:\n        os.fstat(_i); _open.append(_i)\n    except OSError:\n        pass\nprint('foreign-fds', _open)" },
    { id: "tmp", src: probe("tmp-write", `open(${JSON.stringify(join(runTmp, "t.txt"))}, 'w').write('t')`) },
    { id: "in", src: probe("inside-write", "open('inside.txt', 'w').write('ok')") },
  ]));
  writeFileSync(join(outside, "keep.txt"), "keep");
  return { root, work, outside, sentinel, runTmp };
}
// (the mid-run link: planted once the run says it's ready, then the run told to go on)
function plantLate(p: { work: string; sentinel: string }) {
  const t: any = setInterval(() => {
    if (!existsSync(join(p.work, "ready"))) return;
    clearInterval(t);
    symlinkSync(p.sentinel, join(p.work, "late"));
    writeFileSync(join(p.work, "go"), "1");
  }, 20);
  t.unref?.();
  return t;
}
const lines = (rep: any) => rep.cells.flatMap((c: any) => c.stdout.split("\n")).map((l: string) => l.trim()).filter(Boolean);
const WANT = ["import 42", "sentinel-read DENIED PermissionError", "planted-read DENIED PermissionError", "planted-write DENIED PermissionError", "dirlink-list DENIED PermissionError", "dirlink-write DENIED PermissionError", "dotdot-write DENIED PermissionError", "parent-write DENIED PermissionError",
  "dangling-write DENIED PermissionError", "innerlink-read DENIED PermissionError", "hardlink-read DENIED PermissionError", "fifo-open DENIED PermissionError", "prefix-read DENIED PermissionError", "rename-out DENIED PermissionError", "rename-in DENIED PermissionError",
  "copy-from DENIED PermissionError", "copy-to DENIED PermissionError", "makedirs-via-link DENIED PermissionError", "remove-via-link DENIED PermissionError", "chdir-link DENIED PermissionError", "listdir-root DENIED PermissionError", "midrun-read DENIED PermissionError", "foreign-fds []", "tmp-write ALLOWED", "inside-write ALLOWED"];
function untouched(p: ReturnType<typeof planted>) {
  assert.equal(readFileSync(p.sentinel, "utf8"), "DUMMY-SENTINEL\n");
  assert.equal(readFileSync(join(p.outside, "keep.txt"), "utf8"), "keep");
  for (const f of ["new.txt", "new2.txt", "moved.txt", "copy.txt", "a"]) assert.ok(!existsSync(join(p.outside, f)), f);
  assert.ok(!existsSync(join(p.root, "escaped.txt")));
  assert.ok(existsSync(join(p.work, "sub", "ok.txt")), "not moved out");
  assert.equal(readFileSync(join(p.work, "inside.txt"), "utf8"), "ok");
}

// (run asynchronously, so the mid-run link can be planted while the cells run)
const runAsync = (cmd: string, args: string[], o: any) => new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
  const { spawn } = require("node:child_process");
  const c = spawn(cmd, args, o);
  let stdout = "", stderr = "";
  c.stdout.on("data", (b: Buffer) => (stdout += b));
  c.stderr.on("data", (b: Buffer) => (stderr += b));
  c.on("close", (status: number | null) => res({ status, stdout, stderr }));
});

test("--confine: links planted to the outside, before and during the run, are refused when used; the folder's own files work; nothing outside changes", async () => {
  const p = planted();
  const t = plantLate(p);
  const r = await runAsync(process.execPath, [CLI, "notebook", "run", "p.ipynb", "--json", "--confine", p.work, "--confine", p.runTmp], { cwd: p.work });
  clearInterval(t);
  assert.deepEqual(lines(json(r)), WANT);
  untouched(p);
  rmSync(p.root, { recursive: true, force: true });
});

test("--confine: a descriptor the program inherited is refused at every entry point (_fs, open(), os), read and write; stdio works", () => {
  const { openSync, closeSync } = require("node:fs");
  const root = folder(), work = join(root, "work");
  mkdirSync(work);
  const rd = join(root, "read-sentinel"), wr = join(root, "write-sentinel");
  writeFileSync(rd, "DUMMY-FD-SENTINEL");
  writeFileSync(wr, "UNCHANGED");
  const probe = (label: string, expr: string) => `try:\n    _r = ${expr}\n    print(${JSON.stringify(label)}, 'ALLOWED', repr(_r)[:40])\nexcept BaseException as _e:\n    print(${JSON.stringify(label)}, 'DENIED')`;
  writeFileSync(join(work, "f.ipynb"), nb([
    { id: "a", src: probe("fs-read-3", "__import__('_fs').read(3)") },
    { id: "b", src: probe("open-read-3", "open(3).read()") },
    { id: "c", src: probe("os-read-3", "__import__('os').read(3, 100)") },
    { id: "d", src: probe("fs-write-4", "__import__('_fs').write(4, b'X', False)") },
    { id: "e", src: probe("open-write-4", "open(4, 'w').write('X')") },
    { id: "f", src: probe("os-write-4", "__import__('os').write(4, b'X')") },
    { id: "g", src: "import os\nfd = os.open('own.txt', os.O_WRONLY | os.O_CREAT)\nos.write(fd, b'mine')\nos.close(fd)\nprint('own-fd', open('own.txt').read())\nprint('stdout-ok')" },
  ]));
  const r3 = openSync(rd, "r"), w4 = openSync(wr, "r+");
  try {
    const fds: any[] = ["ignore", "pipe", "pipe"];
    // (the inherited descriptors at 3 and 4: the outside files, as a careless parent would pass them)
    const r = spawnSync(process.execPath, [CLI, "notebook", "run", "f.ipynb", "--json", "--confine", work], { cwd: work, encoding: "utf8", timeout: 120_000, stdio: [...fds, r3, w4] });
    const got = lines(json(r));
    // (on a failure, the whole report and the stderr: a cell that raised shows its error there, not in its output lines)
    for (const l of ["fs-read-3 DENIED", "open-read-3 DENIED", "os-read-3 DENIED", "fs-write-4 DENIED", "open-write-4 DENIED", "os-write-4 DENIED", "own-fd mine", "stdout-ok"]) assert.ok(got.includes(l), `${l} in ${JSON.stringify(got)}; report ${r.stdout.slice(0, 4000)}; stderr ${r.stderr.slice(-2000)}`);
  } finally { closeSync(r3); closeSync(w4); }
  assert.equal(readFileSync(wr, "utf8"), "UNCHANGED");
  rmSync(root, { recursive: true, force: true });
});

test("--confine: the host's own path hooks (pinned zone data, the package folder, the precompile recording) are off: no raw read or write outside", () => {
  const root = folder(), work = join(root, "work"), zones = join(root, "zones");
  mkdirSync(work); mkdirSync(zones);
  writeFileSync(join(zones, "Secret"), "DUMMY-ZONE-SENTINEL");
  writeFileSync(join(work, "z.ipynb"), nb([
    { id: "a", src: "import _time\ntry:\n    print('pinned', _time._pinned('Secret'))\nexcept BaseException as e:\n    print('pinned DENIED')" },
    { id: "b", src: "import _time\ntry:\n    print('zones', _time._pinned_zones())\nexcept BaseException as e:\n    print('zones DENIED')" },
  ]));
  const out = join(root, "precompile.json");
  const r = spawnSync(process.execPath, [CLI, "notebook", "run", "z.ipynb", "--json", "--confine", work], { cwd: work, encoding: "utf8", timeout: 120_000, env: { ...process.env, SAGEBRUSH_TIME_PINNED_DIR: zones, SAGEBRUSH_PRECOMPILE_OUT: out } });
  const got = lines(json(r));
  assert.ok(got.includes("pinned DENIED") && got.includes("zones DENIED"), JSON.stringify(got));
  assert.ok(!got.some((l: string) => l.includes("SENTINEL")));
  assert.ok(!existsSync(out), "no precompile recording written by a confined run");
  rmSync(root, { recursive: true, force: true });
});

test("--confine: a notebook outside the folders named, or reached through a link, is refused before anything runs", () => {
  const p = planted();
  const r = run(p.work, ["p.ipynb", "--confine", p.outside]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not in a folder named with --confine, or is reached through a link/);
  assert.ok(!existsSync(join(p.work, "inside.txt")));
  symlinkSync(join(p.work, "p.ipynb"), join(p.work, "via-link.ipynb"));
  const l = run(p.work, ["via-link.ipynb", "--confine", p.work]);
  assert.equal(l.status, 2);
  assert.ok(!existsSync(join(p.work, "inside.txt")));
  rmSync(p.root, { recursive: true, force: true });
});

// ---- the Delegate runner's own launch (plan r3 §2.6): the built bundle under Deno, the environment replaced
const BUNDLE = ((b) => (existsSync(b) ? realpathSync(b) : b))(__dirname + "/../../build/cli/pyjs.cjs");
// (its absolute path: the runner's environment has no PATH)
const deno = ((w) => (w.status === 0 && w.stdout.trim().startsWith("/") ? w.stdout.trim() : null))(spawnSync("sh", ["-c", "command -v deno"], { encoding: "utf8" }));
// (the runner's environment: replaced whole, so --allow-env exposes exactly these; the pinned zone data copied into
// the run's own tmp, as the system's zone files are outside what the run may read)
const ZONEINFO = __dirname + "/../../tzdata/zoneinfo";
const denoArgs = (work: string, runTmp: string, args: string[], confine = true) => ["run", "--no-prompt", "--no-config", "--no-lock", "--no-remote", "--no-npm", "--cached-only", "--no-code-cache",
    `--allow-read=${work},${runTmp},${BUNDLE}`, `--allow-write=${work},${runTmp}`, "--allow-env",
    "--deny-net", "--deny-run", "--deny-ffi", "--deny-sys", BUNDLE, "notebook", "run", ...args, ...(confine ? ["--confine", work, "--confine", runTmp] : [])];
const denoEnv = (work: string, runTmp: string) => {
  if (!existsSync(join(runTmp, "zoneinfo"))) spawnSync("cp", ["-r", ZONEINFO, join(runTmp, "zoneinfo")]);
  return { HOME: work, TMPDIR: runTmp, DENO_DIR: join(runTmp, "deno"), NO_COLOR: "1", TZ: "UTC", TZDIR: join(runTmp, "zoneinfo"), PYTHONTZPATH: join(runTmp, "zoneinfo") };
};
const underDeno = (work: string, runTmp: string, args: string[], confine = true) =>
  spawnSync(deno!, denoArgs(work, runTmp, args, confine), { cwd: work, encoding: "utf8", timeout: 180_000, env: denoEnv(work, runTmp) });
const underDenoAsync = (work: string, runTmp: string, args: string[]) => runAsync(deno!, denoArgs(work, runTmp, args), { cwd: work, env: denoEnv(work, runTmp) });
const skipDeno = !deno || !existsSync(BUNDLE) ? "needs deno on PATH and the built bundle (node scripts/build-cli.mjs)" : false;
// (a job that exists to produce this evidence sets SAGEBRUSH_REQUIRE_DENO=1: then a missing deno or bundle is a failure, never a skip)
if (skipDeno && process.env.SAGEBRUSH_REQUIRE_DENO === "1") test("Deno rows required here (SAGEBRUSH_REQUIRE_DENO=1)", () => { assert.fail(String(skipDeno)); });

test("Deno: the runner's flags with --confine: every escape refused, before and during the run; the notebook's own work done", { skip: skipDeno }, async () => {
  const p = planted();
  const t = plantLate(p);
  const r = await underDenoAsync(p.work, p.runTmp, ["p.ipynb", "--json", "--write"]);
  clearInterval(t);
  assert.equal(r.status, 0, r.stderr.slice(0, 2000));
  assert.deepEqual(lines(json(r)), WANT);
  untouched(p);
  rmSync(p.root, { recursive: true, force: true });
});

test("Deno alone checks the path as written: without --confine a planted link escapes (why --confine is the third layer)", { skip: skipDeno }, () => {
  const p = planted();
  writeFileSync(join(p.work, "go"), "1");
  // (the FIFO's open blocks without --confine: a short timeout for each cell)
  const rep = json(underDeno(p.work, p.runTmp, ["p.ipynb", "--json", "--timeout", "3"], false));
  const got = lines(rep);
  assert.ok(got.includes("sentinel-read DENIED PermissionError"), "a path outside, as written: denied");
  assert.ok(got.includes("planted-read ALLOWED"), "through a planted link: Deno lets it through");
  rmSync(p.root, { recursive: true, force: true });
});

test("Deno: no network, no subprocess, no foreign code, and none of the parent's environment", { skip: skipDeno }, () => {
  const root = folder(), work = join(root, "work"), runTmp = join(root, "run-1");
  mkdirSync(work); mkdirSync(runTmp, { mode: 0o700 });
  const probe = (label: string, expr: string) => `try:\n    _r = ${expr}\n    print(${JSON.stringify(label)}, 'ALLOWED', repr(_r)[:40])\nexcept BaseException as _e:\n    print(${JSON.stringify(label)}, 'DENIED')`;
  writeFileSync(join(work, "n.ipynb"), nb([
    { id: "u", src: probe("urllib", "__import__('urllib.request').request.urlopen('http://example.com', timeout=3).read(10)") },
    { id: "k", src: probe("socket", "__import__('socket')") },
    { id: "p", src: probe("subprocess", "__import__('subprocess')") },
    { id: "y", src: probe("system", "__import__('os').system('id')") },
    { id: "c", src: probe("ctypes", "__import__('ctypes').CDLL(None)") },
    { id: "j", src: probe("js", "__import__('js')") },
    { id: "e", src: "import os\nprint('env', sorted(os.environ))\nprint('path', os.environ.get('PATH'), os.environ.get('DENO_NODE_SHIM_ACTIVE'))" },
    { id: "t", src: "import time, datetime, zoneinfo, tempfile\nf = tempfile.NamedTemporaryFile(delete=False); f.close()\nprint('libs', time.time() > 0, str(zoneinfo.ZoneInfo('Europe/Paris')), f.name.startswith(os.environ['TMPDIR']))" },
  ]));
  const got = lines(json(underDeno(work, runTmp, ["n.ipynb", "--json"])));
  for (const l of ["urllib DENIED", "socket DENIED", "subprocess DENIED", "system DENIED", "ctypes DENIED", "js DENIED",
    // (Deno's own two: its Node shim's flag, and a PATH it makes up, never the parent's)
    "env ['DENO_DIR', 'DENO_NODE_SHIM_ACTIVE', 'HOME', 'NO_COLOR', 'PATH', 'PYTHONTZPATH', 'TMPDIR', 'TZ', 'TZDIR']", "libs True Europe/Paris True"]) assert.ok(got.includes(l), `${l} in ${JSON.stringify(got)}`);
  const path = got.find((l: string) => l.startsWith("path "))!;
  assert.equal(path, `path ${join(runTmp, "deno", "node_compat_bin")} 1`, "PATH is Deno's own shim folder in the run's tmp, never the parent's");
  rmSync(root, { recursive: true, force: true });
});

test("--until-stdin-ends: a run stops at once when its standard input ends (the program that started it gone); held open, a run that finishes exits as usual; without it, a closed input changes nothing", async () => {
  const dir = folder();
  writeFileSync(join(dir, "loop.ipynb"), nb([{ id: "a", src: "print('started', flush=True)\nwhile True:\n    pass" }]));
  const p = spawn(process.execPath, [CLI, "notebook", "run", "loop.ipynb", "--json", "--timeout", "120", "--until-stdin-ends"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => { err += d; });
  const exited = new Promise<number | null>((r) => p.on("exit", (c) => r(c)));
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(p.exitCode, null, "still running while its input is open");
  const t = Date.now();
  p.stdin!.end();
  assert.equal(await exited, 3);
  assert.ok(Date.now() - t < 5000, `stopped in ${Date.now() - t} ms`);
  assert.match(err, /standard input ended: stopped/);
  writeFileSync(join(dir, "quick.ipynb"), nb([{ id: "q", src: "print(1)" }]));
  const q = spawn(process.execPath, [CLI, "notebook", "run", "quick.ipynb", "--json", "--until-stdin-ends"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  q.stdout.on("data", (d) => { out += d; });
  const code = await Promise.race([new Promise((r) => q.on("exit", (c) => r(c))), new Promise((r) => setTimeout(() => r("hung"), 60000))]);
  q.stdin!.end();
  assert.equal(code, 0, "a finished run exits with its input still open");
  assert.equal(json({ stdout: out }).cells[0].stdout, "1\n");
  assert.equal(run(dir, ["quick.ipynb", "--json"]).status, 0, "without the flag, the closed input spawnSync gives changes nothing");
  rmSync(dir, { recursive: true, force: true });
});

test("os.open's flags (Linux's numbers, as the os module names them) reach the host as its own numbers: macOS's table, Linux's as they are; an unknown bit is EINVAL", () => {
  const mac = { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_NONBLOCK: 0x4, O_APPEND: 0x8, O_CREAT: 0x200, O_TRUNC: 0x400, O_EXCL: 0x800, O_NOFOLLOW: 0x100, O_DIRECTORY: 0x100000 };
  assert.equal(hostOpenFlags(1 | 64, mac), 0x1 | 0x200, "O_WRONLY | O_CREAT");
  assert.equal(hostOpenFlags(2 | 64 | 128 | 512 | 1024 | 2048 | 65536 | 131072 | 524288, mac), 0x2 | 0x200 | 0x800 | 0x400 | 0x8 | 0x4 | 0x100000 | 0x100);
  assert.equal(hostOpenFlags(0, mac), 0);
  const host = require("node:fs").constants;
  // (on every platform, each named flag reaches this host as its own constant)
  for (const [bit, name] of [[64, "O_CREAT"], [512, "O_TRUNC"], [1024, "O_APPEND"], [128, "O_EXCL"], [1, "O_WRONLY"], [2, "O_RDWR"]] as [number, string][]) assert.equal(hostOpenFlags(bit, host), host[name], name);
  if (process.platform === "linux") for (const f of [0, 1, 2, 65, 193, 577, 1089, 2048, 65536, 131072]) assert.equal(hostOpenFlags(f, host), f, String(f));
  for (const bad of [4, 8, 0x40000000]) assert.throws(() => hostOpenFlags(bad, mac), (e: any) => e.code === "EINVAL", String(bad));
});

test("Deno, the runner's flags with --until-stdin-ends, its input held open: a run that completes exits 0 (notebook written), one that fails exits 1, and an endless one stops (exit 3) when the input ends", { skip: skipDeno }, async () => {
  const { spawn } = require("node:child_process");
  const root = folder(), work = join(root, "work"), runTmp = join(root, "tmp");
  mkdirSync(work);
  mkdirSync(runTmp);
  writeFileSync(join(work, "ok.ipynb"), nb([{ id: "a", src: "print(42)" }]));
  writeFileSync(join(work, "bad.ipynb"), nb([{ id: "a", src: "raise ValueError('no')" }]));
  writeFileSync(join(work, "loop.ipynb"), nb([{ id: "a", src: "open('started.txt', 'w').write('x')\nwhile True:\n    pass" }]));
  // (started as the agent starts it: standard input a pipe it holds open; the exit, or "held" if none within `ms`)
  const kids: any[] = [];
  const start = (file: string) => {
    const c = spawn(deno!, [...denoArgs(work, runTmp, [file, "--json", "--write"]), "--until-stdin-ends"], { cwd: work, env: denoEnv(work, runTmp), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (b: Buffer) => (stdout += b));
    c.stderr.on("data", (b: Buffer) => (stderr += b));
    kids.push(c);
    const exit = new Promise<number | null>((r) => c.on("close", (code: number | null) => r(code)));
    const within = (ms: number) => Promise.race([exit, new Promise((r) => setTimeout(() => r("held"), ms))]);
    return { c, exit, within, out: () => stdout, err: () => stderr };
  };
  try {
    const ok = start("ok.ipynb");
    assert.equal(await ok.within(60_000), 0, `completed: exits with its input still open (${ok.err().slice(-500)})`);
    assert.equal(json({ stdout: ok.out() }).cells[0].stdout, "42\n");
    assert.match(readFileSync(join(work, "ok.ipynb"), "utf8"), /"42\\n"/, "the notebook written");
    ok.c.stdin.end();
    const bad = start("bad.ipynb");
    assert.equal(await bad.within(60_000), 1, `failed: exits 1 with its input still open (${bad.err().slice(-500)})`);
    bad.c.stdin.end();
    const loop = start("loop.ipynb");
    const t = Date.now();
    while (!existsSync(join(work, "started.txt")) && Date.now() - t < 60_000) await new Promise((r) => setTimeout(r, 50));
    assert.equal(await loop.within(1000), "held", "an endless run goes on while its input is open");
    loop.c.stdin.end();
    assert.equal(await loop.within(10_000), 3);
    assert.match(loop.err(), /standard input ended: stopped/);
  } finally {
    // (this row's own children only, if a failed assertion left one running)
    for (const c of kids) { c.stdin.destroy(); if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); }
    rmSync(root, { recursive: true, force: true });
  }
});
