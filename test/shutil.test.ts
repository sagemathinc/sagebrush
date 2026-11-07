import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// shutil, CPython 3.14's own Lib/shutil.py, lazily embedded, and the os calls it needs (P3b-2: file descriptors,
// chmod, utime, access, the terminal's size, posix; the design note astra and daybreak2 cleared): test/shutil_cases.py
// prints, on the CLI's real file system, what CPython prints for it, line for line, each run in a fresh folder with
// nothing in the environment but PATH and HOME. The reference is the newest 3.14 patch release (CI's "3.14").
// (The browser worker's file system: web/test-shutil-worker.mjs, the same cases, and its refusals.)
const CLI = join(__dirname, "..", "src", "cli.js");
const CASES = join(__dirname, "..", "..", "test", "shutil_cases.py");
const inFresh = (cmd: string, args: string[]) => {
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "shutil-"));
  try {
    return execFileSync(cmd, args, { cwd: d, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: d } });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};

test("shutil_cases.py: os's descriptors, chmod, utime and access, Path.touch, shutil's copies, moves, rmtree and which, as CPython 3.14 prints them", () => {
  const want = inFresh("python3", [CASES]).split("\n");
  const got = inFresh(process.execPath, [CLI, CASES]).split("\n");
  assert.ok(want.length > 50, "the cases ran under CPython");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `shutil_cases.py line ${i + 1}`);
});

// (what differs from CPython by design, Sagebrush's own: no call takes a descriptor in place of a path, or dir_fd,
// so supports_fd and supports_dir_fd are empty; dir_fd is NotImplementedError, as on a platform without it)
test("os: supports_fd and supports_dir_fd empty, dir_fd refused, posix exactly os's reviewed functions", () => {
  const out = execFileSync(process.execPath, [CLI, "-c", [
    "import os, posix",
    "print(len(os.supports_fd), len(os.supports_dir_fd), sorted(f.__name__ for f in os.supports_follow_symlinks))",
    "for f in [lambda: os.open('x', os.O_RDONLY, dir_fd=3), lambda: os.chmod('x', 0o600, dir_fd=3), lambda: os.utime('x', dir_fd=3), lambda: os.access('x', os.F_OK, dir_fd=3)]:",
    "    try: f()",
    "    except NotImplementedError as e: print('NotImplementedError', e)",
    "print(all(getattr(posix, n) is getattr(os, n) for n in dir(posix) if not n.startswith('__') and n != 'error'), hasattr(posix, 'environ'), hasattr(posix, 'path'))",
  ].join("\n")], { encoding: "utf8" });
  assert.equal(out, [
    "0 0 ['access', 'stat', 'utime']",
    ...Array(4).fill("NotImplementedError dir_fd unavailable on this platform"),
    "True False False",
    "",
  ].join("\n"));
});
