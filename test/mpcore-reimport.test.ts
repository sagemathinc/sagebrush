import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

// mpmath 1.4.1's special values that the core follows while the python backend is still mpmath 1.3.0
// (bench/mpmath/exempt-141.json, shared with fuzz.py's diff; removed by the pypi-mpmath 1.4.1 bump): a
// conformance row may differ only when its case matches a rule and the core prints that rule's 1.4.1 value.
const EXEMPT: { id: string; conformance?: string; conformance_core?: string }[] = JSON.parse(readFileSync(join(BENCH, "exempt-141.json"), "utf8")).rules;
const exempt = (python: string, core: string): string | null => {
  const [kp, vp] = python.split("\t"), [kc, vc] = core.split("\t");
  if (kp !== kc || vp === undefined || vc === undefined) return null;
  const key = kp.slice(kp.indexOf(" ") + 1);
  const r = EXEMPT.find((e) => e.conformance !== undefined && new RegExp(e.conformance).test(key) && vc === e.conformance_core);
  return r ? r.id : null;
};

test("the conformance list after mpmath was used and imported again: the core prints what the python backend prints", () => {
  const want = script("python", ["conformance.py", "gen"]), got = script("sagebrush", ["conformance.py", "gen", "--reimport"]);
  assert.ok(want.length > 20000);
  const i = want.findIndex((l, j) => l !== got[j] && exempt(l, got[j] ?? "") === null);
  assert.ok(i < 0 && want.length === got.length, i < 0 ? `${want.length} vs ${got.length} lines` : `line ${i + 1}: python ${want[i]?.slice(0, 200)}, core ${got[i]?.slice(0, 200)}`);
});

test("the 1.4.1 special values the references don't have yet (bench/mpmath/exempt-141.json): the core's exact values, one row per rule", () => {
  // (each the value mpmath 1.4.1 gives, where 1.3.0 gives nan; a regression to nan fails here, which the
  // comparisons above can't see while their references are 1.3.0)
  const out = run("sagebrush", `from mpmath import mp, mpf, mpc
inf, nan = mp.inf, mp.nan
print("pow-one-zero", (mpf(1) ** inf)._mpf_, (mpf(1) ** nan)._mpf_, (inf ** mpf(0))._mpf_, (nan ** mpf(0))._mpf_)
print("csqrt-inf-imag", mp.sqrt(mpc(-3, inf))._mpc_, mp.sqrt(mpc(2, -inf))._mpc_)
print("cdiv-finite-by-inf", (mpc(1, 2) / mpc(inf, 0))._mpc_, (mpc(-5, 0.5) / mpc(3, -inf))._mpc_)
`);
  assert.equal(out.status, 0, out.err);
  assert.equal(
    out.out,
    "pow-one-zero (0, 1, 0, 1) (0, 1, 0, 1) (0, 1, 0, 1) (0, 1, 0, 1)\n" +
      "csqrt-inf-imag ((0, 0, -456, -2), (0, 0, -456, -2)) ((0, 0, -456, -2), (1, 0, -789, -3))\n" +
      "cdiv-finite-by-inf ((0, 0, 0, 0), (0, 0, 0, 0)) ((0, 0, 0, 0), (0, 0, 0, 0))\n",
  );
  // (exactly these three rules are exempt)
  assert.deepEqual(EXEMPT.map((e) => e.id), ["pow-one-zero", "csqrt-inf-imag", "cdiv-finite-by-inf"]);
});

test("the exemption list's reach (bench/mpmath/exempt-141.json): each pattern matches exactly its cases, and only the exact 1.4.1 value passes", () => {
  // (the conformance rule: of every key in the conformance list, exactly pow-one-zero's five forms)
  const keys = [...new Set(script("python", ["conformance.py", "gen"]).filter((l) => l.includes("\t")).map((l) => l.split("\t")[0].slice(l.indexOf(" ") + 1)))];
  assert.ok(keys.length > 500);
  const conf = EXEMPT.filter((e) => e.conformance !== undefined);
  assert.deepEqual(conf.map((e) => e.id), ["pow-one-zero"]);
  assert.deepEqual(keys.filter((k) => new RegExp(conf[0].conformance!).test(k)).sort(), ["inf.__pow__(zero)", "inf.__rpow__(one)", "nan.__pow__(zero)", "nan.__rpow__(one)", "one.__pow__(inf)"]);
  // (a listed case passes only at its 1.4.1 value: a wrong finite value, or 1.3.0's nan, stays a mismatch)
  for (const key of ["one.__pow__(inf)", "inf.__rpow__(one)", "inf.__pow__(zero)", "nan.__rpow__(one)", "nan.__pow__(zero)"]) {
    const python = `53n ${key}\tmpf(0,0,-7b,-1)`;
    assert.equal(exempt(python, `53n ${key}\tmpf(0,1,0,1)`), "pow-one-zero", key);
    assert.equal(exempt(python, `53n ${key}\tmpf(0,3,0,2)`), null, `${key}: a wrong finite value`);
    assert.equal(exempt(python, `53n ${key}\tmpf(0,0,-7b,-1)`), null, `${key}: nan`);
  }
  assert.equal(exempt("53n one.__pow__(two)\tmpf(0,1,0,1)", "53n one.__pow__(two)\tmpf(0,3,0,2)"), null);
  // (the fuzz rules: fuzz.py's own rows, positive and negative, for each pattern and its value check)
  assert.ok(script("python", ["fuzz.py", "selftest"]).includes("selftest: 13 rows, 0 wrong"));
});

test("the fuzzer's cases in a shuffled order, in one session on the core: the same lines as in their own order", () => {
  const plain = script("sagebrush", ["fuzz.py", "gen", "--seed", "11", "--n", "3000"]);
  const shuffled = script("sagebrush", ["fuzz.py", "gen", "--seed", "11", "--n", "3000", "--shuffle", "1"]);
  assert.equal(plain.length, 3001);
  const i = plain.findIndex((l, j) => l !== shuffled[j]);
  assert.ok(i < 0, `case ${i}: in order ${plain[i]?.slice(0, 200)}, shuffled ${shuffled[i]?.slice(0, 200)}`);
});

test("mpf_div at precision 0 keeps the quotient's own bits, as mpmath 1.4.1 gives them (the core alone: 1.3.0's rounds to one bit)", () => {
  // the values are mpmath 1.4.1's python backend's (CPython); from_str and from_rational at precision 0 divide
  // through mpf_div.  (The python backend here is still 1.3.0, so the core is checked against the values.)
  const r = run("sagebrush", `from mpmath.libmp import mpf_div, from_int, from_man_exp, from_str, from_rational
pairs = [(from_int(199999999), from_int(10**8)), (from_int(1), from_int(3)), (from_int(3), from_man_exp(7, -5))]
for s, t in pairs:
    print("div", [tuple(int(x) for x in mpf_div(s, t, 0, r)) for r in "nfcdu"])
print("from_str", tuple(int(x) for x in from_str('1.5', 0)), tuple(int(x) for x in from_str('1.99999999', 0)))
print("from_rational", tuple(int(x) for x in from_rational(1, 3, 0)), tuple(int(x) for x in from_rational(-22, 7, 0)))
`);
  assert.equal(r.status, 0, r.err);
  const five = (t: string) => `[${Array(5).fill(t).join(", ")}]`;
  assert.equal(
    r.out,
    `div ${five("(0, 17179869099, -33, 34)")}\n` +
      `div ${five("(0, 171, -9, 8)")}\n` +
      `div ${five("(0, 439, -5, 9)")}\n` +
      "from_str (0, 3, -1, 2) (0, 17179869099, -33, 34)\n" +
      "from_rational (0, 171, -9, 8) (1, 805, -8, 10)\n",
  );
});
