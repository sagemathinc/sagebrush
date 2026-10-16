import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// exec and eval with separate globals and locals, as CPython's
// (test/exec_namespaces_cases.py; its .out is CPython 3.14's): the top
// level reads the locals, then the globals; functions, lambdas, generator
// expressions and class bodies see only the globals; global statements
// there are the globals'. And Sage's RR, RDF and CC elements, Python float
// and complex subclasses here but none in Sage, are refused as results of
// __float__ and __complex__, as np.float32 is.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("exec and eval with separate globals and locals scope names as CPython", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "exec_namespaces_cases.py"], { encoding: "utf8" });
  assert.equal(got, readFileSync(TEST + "exec_namespaces_cases.out", "utf8"));
});
// (test/exec_mapping_cases.py, its .out CPython 3.14's): locals that
// aren't an exact dict are read, written and deleted through their own
// __getitem__, __setitem__ and __delitem__; a KeyError means unbound there
test("exec and eval with a locals mapping use its methods as CPython", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "exec_mapping_cases.py"], { encoding: "utf8" });
  assert.equal(got, readFileSync(TEST + "exec_mapping_cases.out", "utf8"));
});
// (HARD-5F6-1) dir() over a mapping whose keys() never ends, or repeats one
// key forever: a MemoryError at a budget of the heap, never V8's abort
test("dir() over a locals mapping refuses an endless keys()", () => {
  const src = [
    "import itertools",
    "def t(keys):",
    "    M = type('M', (), {'__getitem__': lambda self, k: (_ for _ in ()).throw(KeyError(k)), 'keys': lambda self: keys})",
    "    try:",
    "        return eval('dir()', {}, M())",
    "    except MemoryError as e:",
    "        return 'MemoryError: ' + str(e)",
    "print(t(itertools.repeat('x')))",
    "print(t(map(str, itertools.count())))",
    "print(t(('b', 'a', 'b')))",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", CLI, "-c", src], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "MemoryError: M.keys() is too long to list\nMemoryError: M.keys() is too long to list\n['a', 'b', 'b']\n");
});
test("Sage's RR, RDF and CC elements are no float or complex as hook results", () => {
  const src = [
    "def t(f):",
    "    try:",
    "        return repr(f())",
    "    except Exception as e:",
    "        return type(e).__name__ + ': ' + str(e)",
    "class FR(float):",
    "    def __float__(self): return RR(9)",
    "class FD(float):",
    "    def __float__(self): return RDF(9)",
    "class FF(float):",
    "    def __float__(self): return float(9)",
    "class CC1:",
    "    def __complex__(self): return CC(1, 2)",
    "print(t(lambda: float(FR(2))))",
    "print(t(lambda: float(FD(2))))",
    "print(t(lambda: float(FF(2))))",
    "print(t(lambda: complex(CC1())))",
  ].join("\n");
  const r = spawnSync(process.execPath, [CLI, "--sage", "-c", src], { encoding: "utf8", timeout: 120000 });
  assert.equal(r.stdout, [
    "TypeError: FR.__float__ returned non-float (type sage.rings.real_mpfr.RealNumber)",
    "TypeError: FD.__float__ returned non-float (type sage.rings.real_double.RealDoubleElement)",
    "9.0",
    "TypeError: __complex__ returned non-complex (type sage.rings.complex_mpfr.ComplexNumber)",
    "",
  ].join("\n"), r.stderr);
});
