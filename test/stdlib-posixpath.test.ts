import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// os.path (lib/posixpath.py: CPython 3.14's posixpath, a subset) compared
// with CPython: str, bytes and os.PathLike arguments, os.fspath's errors for
// anything else, str and bytes refused together, and the file system's
// answers over a file, a directory, symbolic links to each, a dangling one
// and a FIFO (test/posixpath_cases.py). A file name that is not UTF-8 is
// refused here, where CPython reads it as bytes.
const TEST = __dirname + "/../../test/";
const run = (cmd: string, args: string[], env: Record<string, string>) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env }, maxBuffer: 16 << 20, timeout: 120000 }).split("\n");

test("posixpath_cases.py: CPython's output; a file name that is not UTF-8 refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-posixpath-"));
  try {
    writeFileSync(join(dir, "file"), "x");
    mkdirSync(join(dir, "dir"));
    symlinkSync("file", join(dir, "link-file"));
    symlinkSync("dir", join(dir, "link-dir"));
    symlinkSync("nowhere", join(dir, "dangling"));
    execFileSync("mkfifo", [join(dir, "fifo")]);
    const env = { PP_DIR: dir };
    const want = run("python3", [TEST + "posixpath_cases.py"], env);
    const got = run(process.execPath, [__dirname + "/../src/cli.js", TEST + "posixpath_cases.py"], env);
    const notUtf8 = /^\w+\(surrogate\) /;
    assert.deepEqual(got.filter((l) => !notUtf8.test(l)), want.filter((l) => !notUtf8.test(l)));
    const refused = got.filter((l) => notUtf8.test(l));
    assert.equal(refused.length, 5);
    for (const l of refused) assert.match(l, / !! NotImplementedError os\.path functions of a file name that is not UTF-8 are not supported in Sagebrush /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("os.path's file system functions of a file descriptor (an int, an int subclass, __index__, a bool): refused, not read as a path; realpath(strict=True) refused", () => {
  const code = [
    "import os.path",
    "class IntPath(int):",
    "    def __fspath__(self): return '/dev/null'",
    "class IndexPath:",
    "    def __index__(self): return 3",
    "    def __fspath__(self): return '/dev/null'",
    "for f in ('exists', 'isfile', 'isdir'):",
    "    for v in (1, IntPath(3), IndexPath(), True):",
    "        try: print(f, getattr(os.path, f)(v))",
    "        except NotImplementedError as e: print(f, e)",
    "for f in ('lexists', 'islink'):",
    "    print(f, getattr(os.path, f)(IntPath(3)), getattr(os.path, f)(IndexPath()))",
    "try: os.path.realpath('/nowhere/a', strict=True)",
    "except NotImplementedError as e: print('realpath', e)",
  ].join("\n");
  const out = run(process.execPath, [__dirname + "/../src/cli.js", "-c", code], {});
  const refused = "os.path functions of a file descriptor are not supported in Sagebrush";
  assert.deepEqual(out.filter(Boolean), [
    ...["exists", "isfile", "isdir"].flatMap((f) => [1, 2, 3, 4].map(() => `${f} ${refused}`)),
    // (lstat takes no descriptor: their __fspath__, /dev/null)
    "lexists True True",
    "islink False False",
    "realpath os.path.realpath(strict=...) is not supported in Sagebrush",
  ]);
});
