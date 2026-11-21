import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNotebook } from "../src/notebook-run";

// `sagebrush notebook run` (src/notebook-run.ts): a notebook's code cells run as the reactive notebook runs them,
// in the notebook's folder, here; --write keeps the outputs and the seed; --confine keeps the program inside its
// folders, through links too.  The rows marked Deno run the built bundle under the Delegate runner's own flags.
const CLI = __dirname + "/../src/cli.js";
const nb = (cells: { id?: string; src: string; type?: string }[], extra: Record<string, unknown> = {}) => JSON.stringify({
  cells: cells.map((c) => ({ cell_type: c.type ?? "code", ...(c.id ? { id: c.id } : {}), metadata: {}, source: c.src, ...(c.type && c.type !== "code" ? {} : { outputs: [], execution_count: null }) })),
  metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, ...((extra.metadata as object) ?? {}) },
  nbformat: 4, nbformat_minor: 5, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "metadata")),
});
const folder = () => mkdtempSync(join(tmpdir(), "sb-nbrun-"));
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
const BUNDLE = __dirname + "/../../build/cli/pyjs.cjs";
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
