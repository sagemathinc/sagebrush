import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

// The library imports its own sagebrush package by a private name, _sagebrush_lib, which the runtime binds to the
// library's files before any search (src/compile.ts libraryPackage): a user's sagebrush.py or sagebrush/ folder, in
// the program's folder or elsewhere on sys.path, never stands in for it, at Sage mode's start or at any call later;
// and the user's own `import sagebrush` gets their file.  Without one, sagebrush and _sagebrush_lib are one module.
const CLI = path.join(__dirname, "../src/cli.js");
const ROOT = path.join(__dirname, "../..");

function folder(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "sb-shadow-")));
}
function run(dir: string, args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 300_000 });
  const i = r.stdout.lastIndexOf("@@");
  assert.ok(i >= 0, `no result line: status ${r.status}\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.slice(i + 2));
}
// (a Sage program that reaches the library's sagebrush at the start, at module level (sage_permgroup) and at call
// time (_sage_ff's engine polynomials, _sage_ec's engine calls), then the user's own import)
const PROGRAM = `import json, sys
import _sage_ff
k = GF(7)
res = [str(_sage_ff._engine_poly("mul", 7, [k(1)] * 3, [k(2)] * 3)),
       int(EllipticCurve([0, 0, 1, -1, 0]).conductor()), int(SymmetricGroup(4).order()), str(factor(2^64 + 1))]
import sagebrush
res.append(getattr(sagebrush, "MINE", "library's"))
res.append(sys.modules["_sagebrush_lib"].__name__)
print("@@" + json.dumps(res))
`;
const EXPECT = ["2,4,6,4,2", 37, 24, "274177 * 67280421310721"];

for (const [label, plant] of [
  ["a sagebrush.py in the program's folder", (d: string) => writeFileSync(path.join(d, "sagebrush.py"), "MINE = 'mine'\n")],
  ["a sagebrush/ package in the program's folder", (d: string) => { mkdirSync(path.join(d, "sagebrush")); writeFileSync(path.join(d, "sagebrush", "__init__.py"), "MINE = 'mine'\n"); }],
] as const) {
  test(`${label}: Sage mode and the library work, at its start and later; the user's import gets theirs`, () => {
    const d = folder();
    try {
      plant(d);
      writeFileSync(path.join(d, "p.sage"), PROGRAM);
      assert.deepEqual(run(d, ["p.sage"]), [...EXPECT, "mine", "sagebrush"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
}

test("a user's sagebrush in another folder put first on sys.path, then the Sage layer imported (Python mode): the same", () => {
  const d = folder();
  try {
    mkdirSync(path.join(d, "elsewhere"));
    writeFileSync(path.join(d, "elsewhere", "sagebrush.py"), "MINE = 'mine'\n");
    // (Python syntax: ** for a power; the Sage layer imported after sys.path names the user's folder first)
    const py = `import sys\nsys.path.insert(0, ${JSON.stringify(path.join(d, "elsewhere"))})\nfrom sage_all import *\n` + PROGRAM.replace("2^64", "2**64");
    writeFileSync(path.join(d, "p.py"), py);
    assert.deepEqual(run(d, ["p.py"]), [...EXPECT, "mine", "sagebrush"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("without one: sagebrush and _sagebrush_lib are one module object each, named sagebrush, pickling by that name", () => {
  const d = folder();
  try {
    const r = run(d, ["-c", `import json, sys, pickle
import sagebrush, sagebrush._engine, _sagebrush_lib, _sagebrush_lib._engine
from _sagebrush_lib.progress import Call
names = sorted(k for k in sys.modules if k == "sagebrush" or k.startswith("sagebrush."))
same = all(sys.modules["_sagebrush_lib" + k[len("sagebrush"):]] is sys.modules[k] for k in names if "_sagebrush_lib" + k[len("sagebrush"):] in sys.modules)
print("@@" + json.dumps([sagebrush is _sagebrush_lib, sagebrush._engine is _sagebrush_lib._engine, _sagebrush_lib.__name__,
  _sagebrush_lib._engine.__name__, same, Call.__module__, pickle.loads(pickle.dumps(Call)) is Call]))`]);
    assert.deepEqual(r, [true, true, "sagebrush", "sagebrush._engine", true, "sagebrush.progress", true]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("the library imports its own package only by the private name (scripts/library_imports.py)", () => {
  const r = spawnSync("python3", [path.join(ROOT, "scripts", "library_imports.py")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
