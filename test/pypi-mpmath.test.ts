import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// mpmath 1.3.0 (packages/pypi-mpmath) on prime counting and the zeta function: li, Li, riemannr, zetazero and zeta
// on the critical line, at 15 and 30 digits. test/mpmath_zeta_cases.py; its .out is CPython 3.14.10's, with the
// committed package on its path. (Upstream's own suite runs in pypi-tests/mpmath.)
const ROOT = join(__dirname, "../..");
const CASES = join(ROOT, "test/mpmath_zeta_cases.py");
const OUT = join(ROOT, "test/mpmath_zeta_cases.out");

test("mpmath 1.3.0: li, Li, riemannr, zetazero and zeta on the critical line, as CPython 3.14.10", () => {
  const want = readFileSync(OUT, "utf8").split("\n");
  const got = execFileSync(process.execPath, [join(__dirname, "../src/cli.js"), CASES], { encoding: "utf8" }).split("\n");
  assert.ok(want.length > 40, "the recording has every case");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `mpmath_zeta_cases.py line ${i + 1}`);
});

// (the recording's provenance: CI's CPython, when it is 3.14.10, prints the committed .out)
test("mpmath_zeta_cases.out is what CPython 3.14.10 prints", (t) => {
  const v = execFileSync("python3", ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8" }).trim();
  if (v !== "3.14.10") return t.skip(`python3 is ${v}, not the recording's 3.14.10`);
  const live = execFileSync("python3", [CASES], {
    encoding: "utf8",
    // (CPython runs the overlaid package on its python backend: the default, the core, is only Sagebrush's)
    env: { ...process.env, PYTHONPATH: join(ROOT, "packages/pypi-mpmath/py"), SAGEBRUSH_MPMATH_BACKEND: "python" },
  });
  assert.equal(live, readFileSync(OUT, "utf8"));
});

// pypi-tests/mpmath is the pinned listing of upstream's suite, but its per-PR gate is bench/mpmath/compare.py (CI's
// numeric group; SOURCE.json's "gate"; @sagebrush's ruling, Nov 9). So that the two can't drift apart: CI must
// still run compare.py over the same mpmath release, compare.py must still run every test_*.py of mpmath's own
// tests, and those must be the files pypi-tests/mpmath pins, byte for byte.
test("bench/mpmath runs the very suite pypi-tests/mpmath pins, over the shipped release", async () => {
  const { createHash } = await import("node:crypto");
  const { readdirSync } = await import("node:fs");
  const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const src = JSON.parse(readFileSync(join(ROOT, "pypi-tests/mpmath/SOURCE.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "packages/pypi-mpmath/sagebrush.json"), "utf8"));
  assert.deepEqual(src.gate?.runner, "bench/mpmath/compare.py", "SOURCE.json names compare.py as the gate");
  assert.equal(src.version, pkg.version, "the pinned suite is the shipped release's");
  // (CI: the numeric group installs that release for CPython and runs compare.py over it, whole)
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.ok(new RegExp(`pip install [^\\n]*\\bmpmath==${src.version.replace(/\./g, "\\.")}\\b`).test(ci), `CI installs mpmath==${src.version}`);
  const numeric = /numeric\)\n([\s\S]*?);;/.exec(ci);
  assert.ok(numeric, "CI has the numeric mode group");
  assert.match(numeric![1], /^\s*python3 bench\/mpmath\/compare\.py -j "\$SAGEBRUSH_CPUS"\s*$/m, "the numeric group runs compare.py, every module");
  // (compare.py: the installed mpmath's tests, every test_*.py, discovered, not listed)
  const cmp = readFileSync(join(ROOT, "bench/mpmath/compare.py"), "utf8");
  assert.ok(cmp.includes('shutil.copytree(os.path.dirname(mpmath.__file__), os.path.join(work, "mpmath")'), "compare.py runs the installed mpmath");
  assert.ok(cmp.includes('mods = sorted(f[:-3] for f in os.listdir(os.path.join(work, "mpmath", "tests")) if f.startswith("test_") and f.endswith(".py"))'), "compare.py runs every test_*.py");
  // (the shipped wheel's tests, the files CI's pip installs: exactly the pinned ones)
  const shipped = join(ROOT, "packages/pypi-mpmath/py/mpmath/tests");
  const tests = readdirSync(shipped).filter((f) => f.startsWith("test_") && f.endsWith(".py")).sort();
  assert.deepEqual(Object.keys(src.files).sort(), tests, "pypi-tests/mpmath pins every test_*.py the release ships");
  for (const f of tests) assert.equal(src.files[f], sha(join(shipped, f)), `${f} is the shipped file`);
  assert.equal(pkg.files[`py/mpmath/tests/${tests[0]}`], src.files[tests[0]], "and the package's own record agrees");
});

// The Core API records a registry package's modules only as its sagebrush.json declares them (python.modules),
// not every submodule the introspection reaches; what was already recorded stays (scripts/core-api-surface.mjs,
// undeclared(); @sagebrush's ruling, Nov 9). So mpmath is recorded as `mpmath` alone, and the packages recorded
// before keep their entries byte for byte (their hash below is master 2614c7ad's).
test("Core API: a registry package's undeclared submodules aren't recorded; earlier packages' records are unchanged", async () => {
  const { createHash } = await import("node:crypto");
  const api = JSON.parse(readFileSync(join(ROOT, "core-api-surface.json"), "utf8"));
  const reg = JSON.parse(readFileSync(join(ROOT, "packages/registry.json"), "utf8"));
  assert.ok(api.modules.mpmath, "mpmath, which pypi-mpmath declares, is recorded");
  assert.deepEqual(Object.keys(api.modules).filter((k) => k.startsWith("mpmath.")), [], "none of its undeclared submodules (mpmath.ctx_mp, mpmath.libmp, ...)");
  const roots = Object.keys(reg.modules).filter((m) => m !== "mpmath");
  const keys = Object.keys(api.modules).filter((k) => roots.some((r) => k === r || k.startsWith(r + "."))).sort();
  assert.deepEqual(keys, ["scipy.io", "scipy.io.matlab", "sortedcontainers", "sortedcontainers.sorteddict", "sortedcontainers.sortedlist", "sortedcontainers.sortedset", "tabulate"]);
  const h = createHash("sha256").update(JSON.stringify(keys.map((k) => [k, api.modules[k]]))).digest("hex");
  assert.equal(h, "d118195a220f49456f113c227cb57fd03915397cd8ddbe10d0a73beb95b91435", "their recorded entries, byte for byte");
});
