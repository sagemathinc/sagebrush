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

test("os.path's file system functions of a file descriptor: refused, not read as a path", () => {
  const out = run(process.execPath, [__dirname + "/../src/cli.js", "-c", "import os.path\nfor f in ('exists', 'isfile', 'isdir'):\n    try: getattr(os.path, f)(1)\n    except NotImplementedError as e: print(f, e)"], {});
  assert.deepEqual(out.filter(Boolean), ["exists", "isfile", "isdir"].map((f) => `${f} os.path functions of a file descriptor are not supported in Sagebrush`));
});
