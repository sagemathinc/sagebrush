import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathJoin } from "../src/compile";
import { libOnDisk } from "../src/notebook-run";

// Windows: the runtime's virtual paths ("/$pyjs/lib/...", the embedded library and the packages' mounts) are POSIX
// paths everywhere, and only a real file's path is joined by the system's path.join, path.win32's there.  Joined by
// path.win32.join, "/$pyjs/lib" + "fractions.py" became "\$pyjs\lib\fractions.py", which no lookup finds: every
// import from the embedded library failed, a folder of the user's with a library package's name was taken for a
// namespace package instead, and --sage's startup import raised as an unhandled rejection.

// (path.join as Windows' acts on the runtime's paths, on any host: a virtual path it joins with backslashes, as
// path.win32.join does; a real one with this host's own join, as Windows' join does Windows paths (on Windows they are
// the same function).  path.posix is kept as the host has it, copied first: on a POSIX host it is path itself, whose
// join is replaced.  The library embedded as the single-file build embeds it, globalThis.__PYJS_LIB__, its files read
// from lib/; SB_DROP leaves one out)
const PRELOAD = `
const fs = require("fs"), path = require("path");
const lib = {};
const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + "/" + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else if (e.name.endsWith(".py")) lib[r] = fs.readFileSync(path.join(d, e.name), "utf8"); } };
walk(process.env.SB_LIB, "");
if (process.env.SB_DROP) delete lib[process.env.SB_DROP];
globalThis.__PYJS_LIB__ = lib;
const hostJoin = path.join;
path.posix = Object.freeze({ ...path.posix });
path.join = (...parts) => (typeof parts[0] === "string" && parts[0].startsWith("/$pyjs") ? path.win32.join(...parts) : hostJoin(...parts));
`;
const CLI = path.join(__dirname, "../src/cli.js");
const LIB = path.join(__dirname, "../../lib");

// A folder for the program: nsdemo/ a namespace package of the user's, json/ a folder with a library package's name
function folder() {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-winpaths-")));
  writeFileSync(path.join(d, "preload.cjs"), PRELOAD);
  mkdirSync(path.join(d, "nsdemo"));
  writeFileSync(path.join(d, "nsdemo", "m.py"), "X = 7\n");
  mkdirSync(path.join(d, "json"));
  writeFileSync(path.join(d, "json", "other.py"), "Y = 1\n");
  return d;
}
const run = (d: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["-r", path.join(d, "preload.cjs"), CLI, ...args], { cwd: d, encoding: "utf8", timeout: 180_000, env: { ...process.env, SB_LIB: LIB, ...env } });

test("pathJoin: a virtual path is joined as POSIX, a real one by the system's join (Windows' here, forced)", () => {
  // (the module object compile.ts calls through: an import's namespace object can't be written to)
  const p = require("node:path");
  const saved = { join: p.join, posix: p.posix, sep: p.sep };
  try {
    // (path.posix as the host has it, copied first: on a POSIX host it is path itself, whose join is replaced)
    p.posix = Object.freeze({ ...p.posix });
    p.join = p.win32.join;
    p.sep = p.win32.sep;
    // (an embedded module, a package's __init__, an optional set's mount)
    assert.equal(pathJoin("/$pyjs/lib", "fractions.py"), "/$pyjs/lib/fractions.py");
    assert.equal(pathJoin("/$pyjs/lib", "json", "__init__.py"), "/$pyjs/lib/json/__init__.py");
    assert.equal(pathJoin("/$pyjs/optional", "S1", "pkg", "mod/sub.py"), "/$pyjs/optional/S1/pkg/mod/sub.py");
    // (a folder of the user's: a namespace package's portion, the system's path)
    assert.equal(pathJoin("C:\\Users\\u\\proj", "nsdemo"), "C:\\Users\\u\\proj\\nsdemo");
    // (a name that only starts like the virtual root is a real path)
    assert.equal(pathJoin("/$pyjsx", "a.py"), "\\$pyjsx\\a.py");
  } finally {
    p.join = saved.join;
    p.posix = saved.posix;
    p.sep = saved.sep;
  }
});

test("Windows' join: an embedded module, a library package (not a user's folder of its name), a namespace portion", () => {
  const d = folder();
  try {
    let r = run(d, ["-c", "import fractions; print(fractions.Fraction(1, 3))"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "1/3");
    // (json/ here has no __init__.py: the library's json package comes first, as a namespace portion only counts
    // when no module or package of the name is found anywhere on sys.path)
    r = run(d, ["-c", "import json; print(json.__file__, json.dumps([1]))"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "/$pyjs/lib/json/__init__.py [1]");
    r = run(d, ["-c", "import nsdemo.m; print(nsdemo.m.X, nsdemo.__file__, len(nsdemo.__path__))"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "7 None 1");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("--sage under Windows' join: the startup import works; when it raises, a traceback and exit status 1", () => {
  const d = folder();
  try {
    let r = run(d, ["--sage", "-c", "print(2 + 3)"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "5");
    // (sage_all left out of the library: the startup's ModuleNotFoundError is reported as a program's exception is,
    // never an unhandled rejection, and the program doesn't run)
    r = run(d, ["--sage", "-c", "print('ran')"], { SB_DROP: "sage_all.py" });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^Traceback \(most recent call last\):\n/);
    assert.match(r.stderr, /ModuleNotFoundError: No module named 'sage_all'\n$/);
    assert.doesNotMatch(r.stderr, /Unhandled|\[object Object\]|Node\.js v/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// `notebook run --confine` from a build that reads the library from disk: its folder is one of the run's roots.  It
// was told from the embedded library's virtual folder by a leading "/", which a Windows folder ("C:\...") hasn't.
test("libOnDisk: a library folder of any form is on disk; the embedded library's virtual folder is not", () => {
  const same = (p: string) => p;
  assert.equal(libOnDisk("C:\\Users\\u\\sagebrush\\lib", same), "C:\\Users\\u\\sagebrush\\lib");
  assert.equal(libOnDisk("/home/u/sagebrush/lib", same), "/home/u/sagebrush/lib");
  assert.equal(libOnDisk("/$pyjs/lib", same), null);
  // (this build's own: lib/ on disk, its real path)
  assert.equal(libOnDisk(), realpathSync(LIB));
});

test("notebook run --confine from a source build: the notebook imports from the library on disk", () => {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), "sb-winpaths-nb-")));
  try {
    const cell = { cell_type: "code", metadata: {}, outputs: [], execution_count: null, source: "import fractions\nprint(fractions.Fraction(1, 3))" };
    writeFileSync(path.join(d, "f.ipynb"), JSON.stringify({ cells: [cell], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
    const r = spawnSync(process.execPath, [CLI, "notebook", "run", "f.ipynb", "--json", "--confine", d], { cwd: d, encoding: "utf8", timeout: 180_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.stringify(JSON.parse(r.stdout));
    assert.match(out, /1\/3/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
