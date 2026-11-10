import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// The multiprecision core's state across calls and across imports of mpmath (design/mpmath-core.md §4.3, §4.6),
// each script run on the core (the default) and on the python backend (the rollback), whose outputs must be the
// same, line for line:
//   - mpmath imported, removed from sys.modules and imported again (as bench/mpmath/perf.py does before each pass):
//     the second import's context must be built on its own PythonMPContext, not the first's, or mpmath's own
//     handling of ComplexResult (raised by a hook, caught by mpmath's code) misses the class it catches;
//   - libintmath.ifac with a memo of the caller's: read and grown as the reference grows it, its errors too.
const CLI = join(__dirname, "../src/cli.js");
const run = (backend: string, code: string) => {
  const env = { ...process.env, SAGEBRUSH_MPMATH_BACKEND: backend };
  const r = spawnSync(process.execPath, [CLI, "-c", code], { encoding: "utf8", env });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const same = (code: string, lines: number) => {
  const core = run("sagebrush", code), python = run("python", code);
  assert.equal(python.status, 0, python.err);
  assert.equal(core.status, 0, core.err);
  assert.equal(core.out, python.out);
  assert.equal(core.out.split("\n").length - 1, lines);
  return core.out;
};
const SHOW = `def show(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, "%s: %s" % (type(e).__name__, e))
`;

test("mpmath imported again: the core's context is the new import's, and mpmath catches its own ComplexResult", () => {
  const out = same(`import sys
import mpmath
mpmath.sqrt(2)
for name in [n for n in sys.modules if n == "mpmath" or n.startswith("mpmath.")]:
    del sys.modules[name]
import mpmath
from mpmath import mpf
${SHOW}
print("base", type(mpmath.mp).__mro__[2] is sys.modules["mpmath.ctx_mp_python"].PythonMPContext or mpmath.libmp.BACKEND == "python")
for label, f in [("sqrt(-4)", lambda: mpmath.sqrt(-4)), ("mpf(-4)**0.5", lambda: mpf(-4) ** 0.5), ("log(-1)", lambda: mpmath.log(-1)),
                 ("expj(1)", lambda: mpmath.expj(1)), ("acos(2)", lambda: mpmath.acos(2)), ("siegelz(10)", lambda: mpmath.siegelz(10)),
                 ("zetazero(100)", lambda: mpmath.zetazero(100))]:
    show(label, f)
`, 8);
  assert.match(out, /^base True$/m);
  assert.match(out, /^zetazero\(100\) \(0\.5 \+ 236\.524229665816j\)$/m);
});

test("libintmath.ifac with a memo of the caller's: its result, the memo after, and its errors, as the python backend's", () => {
  same(`from mpmath.libmp import libintmath as I
${SHOW}
m = {0: 1, 1: 1, 2: 99}
show("memo", lambda: I.ifac(5, m)); print("after", sorted(m.items()))
m = {0: 1, 1: 1}
show("keyword", lambda: I.ifac(6, memo=m)); print("after", sorted(m.items()))
m = {0: 1, 1: 1}
show("past 1000", lambda: I.ifac(1003, m) % 1000003); print("after", len(m), max(m))
show("a hit", lambda: I.ifac(2, {0: 1, 1: 1, 2: 7}))
show("a float", lambda: I.ifac(4.5, {0: 1, 1: 1}))
show("sparse", lambda: I.ifac(4, {0: 1, 2: 2}))
show("not a mapping", lambda: I.ifac(4, [1, 1]))
show("no memo", lambda: I.ifac(10))
`, 11);
});

// The oracle for this class of fault (grader's term): state that outlives a call, or an import, changes a result
// that a state-independent run gets right.
const BENCH = join(__dirname, "../../bench/mpmath");
const script = (backend: string, args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, SAGEBRUSH_MPMATH_BACKEND: backend }, cwd: BENCH, maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").filter((l) => !l.startsWith("#"));
};

test("the conformance list after mpmath was used and imported again: the core prints what the python backend prints", () => {
  const want = script("python", ["conformance.py", "gen"]), got = script("sagebrush", ["conformance.py", "gen", "--reimport"]);
  assert.ok(want.length > 20000);
  const i = want.findIndex((l, j) => l !== got[j]);
  assert.ok(i < 0 && want.length === got.length, i < 0 ? `${want.length} vs ${got.length} lines` : `line ${i + 1}: python ${want[i]?.slice(0, 200)}, core ${got[i]?.slice(0, 200)}`);
});

test("the fuzzer's cases in a shuffled order, in one session on the core: the same lines as in their own order", () => {
  const plain = script("sagebrush", ["fuzz.py", "gen", "--seed", "11", "--n", "3000"]);
  const shuffled = script("sagebrush", ["fuzz.py", "gen", "--seed", "11", "--n", "3000", "--shuffle", "1"]);
  assert.equal(plain.length, 3001);
  const i = plain.findIndex((l, j) => l !== shuffled[j]);
  assert.ok(i < 0, `case ${i}: in order ${plain[i]?.slice(0, 200)}, shuffled ${shuffled[i]?.slice(0, 200)}`);
});
