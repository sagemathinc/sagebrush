import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// pathlib, and what it imports (glob, fnmatch, stat, ntpath, genericpath, errno; os's lazy part, lib/_os_lazy.py),
// CPython 3.14's own Lib modules (P3a: the Codex friction plan's step 2, 251 explainer topics; @sagebrush's ruling,
// Nov 7): test/pathlib_cases.py prints, on the CLI's real file system, what CPython 3.14 prints for it, line for line,
// each run in a fresh folder. (The browser worker's file system: web/test-pathlib-worker.mjs, the same cases; the
// CLI's lazy embedding of these modules: web/test-cli-lazy-lib.mjs.)
const CLI = join(__dirname, "..", "src", "cli.js");
const CASES = join(__dirname, "..", "..", "test", "pathlib_cases.py");
const inFresh = (cmd: string, args: string[]) => {
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "pathlib-"));
  try {
    return execFileSync(cmd, args, { cwd: d, encoding: "utf8", maxBuffer: 1 << 24 });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};

test("pathlib_cases.py: pure and concrete paths, glob, fnmatch, stat, errno, os.scandir and os.walk, as CPython 3.14 prints them", () => {
  const want = inFresh("python3", [CASES]).split("\n");
  const got = inFresh(process.execPath, [CLI, CASES]).split("\n");
  assert.ok(want.length > 30, "the cases ran under CPython");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `pathlib_cases.py line ${i + 1}`);
});

// (os.stat_result: the ten fields as the tuple, the nanosecond times beyond it, as CPython's; stat and lstat take a
// path-like and follow_symlinks; os's path functions take str, bytes or a path-like; OSError's strerror is CPython's)
test("os: stat_result's fields, stat/lstat of a path-like, bytes paths, and CPython's error messages", () => {
  const prog = [
    "import os, pathlib",
    "open('f.txt', 'w').write('abc')",
    "st = os.stat(pathlib.Path('f.txt'))",
    "print(len(st), st.n_fields, st.n_sequence_fields, st.st_size, type(st.st_mtime_ns).__name__, st.st_mtime_ns // 10**9 == int(st.st_mtime))",
    "print(os.stat('f.txt', follow_symlinks=False).st_size, os.lstat(b'f.txt').st_size, sorted(os.listdir(b'.')), os.stat in os.supports_follow_symlinks)",
    "os.mkdir(pathlib.Path('d')); os.rename(b'd', pathlib.Path('e')); print(sorted(os.listdir()))",
    "for f, a in [(os.mkdir, 'e'), (os.rmdir, 'nope'), (os.unlink, 'e'), (os.listdir, 'f.txt')]:",
    "    try: f(a)",
    "    except OSError as e: print(type(e).__name__, e.errno, e.strerror, e.filename)",
    "print(os.O_RDONLY, os.O_WRONLY | os.O_CREAT | os.O_EXCL, isinstance(os.scandir('.'), object), os.fsencode('é'))",
  ].join("\n");
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "pathlib-os-"));
  try {
    writeFileSync(join(d, "p.py"), prog);
    const want = execFileSync("python3", ["p.py"], { cwd: d, encoding: "utf8" });
    rmSync(join(d, "f.txt"), { force: true });
    rmSync(join(d, "e"), { recursive: true, force: true });
    const got = execFileSync(process.execPath, [CLI, "p.py"], { cwd: d, encoding: "utf8" });
    assert.equal(got, want);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// (grader's r820 pins, each against CPython 3.14 on the same program, each run in a fresh folder holding f.txt and a
// symlink to it made from node: stat's follow_symlinks=False is lstat; the tuple's times are whole seconds; makedirs'
// exist_ok both ways; a DirEntry's stat is cached when first asked, as CPython's; scandir of a bytes path gives bytes
// names; io.text_encoding(None) and io.open as CPython's)
test("os: follow_symlinks, the tuple's integer times, makedirs' exist_ok, DirEntry's cached stat, bytes scandir, io", () => {
  const prog = [
    "import os, io, stat",
    "print(stat.S_ISLNK(os.stat('ln', follow_symlinks=False).st_mode), stat.S_ISLNK(os.stat('ln').st_mode), os.stat('ln').st_size)",
    "st = os.stat('f.txt')",
    "print(type(st[8]).__name__, st[8] == int(st.st_mtime), type(st[7]).__name__, type(st.st_mtime).__name__)",
    "os.makedirs('m/n', exist_ok=True); os.makedirs('m/n', exist_ok=True)",
    "try: os.makedirs('m/n')",
    "except FileExistsError as e: print('FileExistsError', e.errno, e.filename)",
    "e = [x for x in os.scandir('.') if x.name == 'f.txt'][0]",
    "print(e.stat().st_size)",
    "open('f.txt', 'a').write('more')",
    "print(e.stat().st_size, os.stat('f.txt').st_size)",
    "print(sorted((type(x.name).__name__, x.name) for x in os.scandir(b'.')))",
    "print(io.text_encoding(None), io.text_encoding('utf-8'), io.open is open)",
  ].join("\n");
  const run = (cmd: string, args: string[]) => {
    const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "pathlib-os2-"));
    try {
      writeFileSync(join(d, "p.py"), prog);
      writeFileSync(join(d, "f.txt"), "abc");
      symlinkSync("f.txt", join(d, "ln"));
      return execFileSync(cmd, args, { cwd: d, encoding: "utf8" });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  const want = run("python3", ["p.py"]);
  assert.equal(want.split("\n").length, 8, `CPython ran every line:\n${want}`);
  assert.equal(run(process.execPath, [CLI, "p.py"]), want);
});
