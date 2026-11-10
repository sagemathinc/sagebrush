import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// mpmath's backend overlay (design/mpmath-core.md, section 4.3; packages/pypi-mpmath/overlay.patch): six of the
// wheel's files get a 'sagebrush' branch beside their 'sage' one, taking the core's names from _sagebrush_mpcore;
// backend.py chooses once, by SAGEBRUSH_MPMATH_BACKEND ('sagebrush', the default, or 'python', the rollback; anything
// else is refused), and ctx_mp.py checks every hook. The core is src/runtime/mpcore.ts: a run selected 'sagebrush' must
// print exactly what a run selected 'python' prints, every hook the live module's the core's.
const ROOT = join(__dirname, "../..");
const CLI = join(__dirname, "../src/cli.js");
const PKG = join(ROOT, "packages/pypi-mpmath");
const PROBE = join(ROOT, "test/mpmath_overlay_probe.py");
// (the checked table, backend.py's SAGEBRUSH_HOOKS: "module.name" each)
const hooks = () => {
  const text = readFileSync(join(PKG, "py/mpmath/libmp/backend.py"), "utf8");
  const block = text.slice(text.indexOf("SAGEBRUSH_HOOKS = ("), text.indexOf("\n)\n", text.indexOf("SAGEBRUSH_HOOKS = (")));
  return [...block.matchAll(/\('(\w+)', '(\w+)'\)/g)].map((m) => `${m[1]}.${m[2]}`);
};
const FILES = ["ctx_mp.py", "libmp/backend.py", "libmp/libelefun.py", "libmp/libintmath.py", "libmp/libmpc.py", "libmp/libmpf.py"];

const run = (backend: string | null, args: string[]) => {
  const env = { ...process.env };
  delete env.SAGEBRUSH_MPMATH_BACKEND;
  if (backend !== null) env.SAGEBRUSH_MPMATH_BACKEND = backend;
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

test("the overlay only adds the 'sagebrush' branches: no upstream line removed, the six files, every hook in the checked table", () => {
  const patch = readFileSync(join(PKG, "overlay.patch"), "utf8");
  const files = [...patch.matchAll(/^\+\+\+ b\/py\/mpmath\/(.+)$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(files, FILES);
  assert.deepEqual(patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("--- a/")), [], "no line of the wheel is removed or changed");
  // (outside backend.py, each hunk adds one block, and it is a 'sagebrush' branch)
  for (const hunk of patch.split(/^@@ .*@@$/m).slice(1)) {
    const added = hunk.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    if (added.some((l) => l.includes("SAGEBRUSH_MPMATH_BACKEND"))) continue;
    assert.equal(added[0], "+elif BACKEND == 'sagebrush':", hunk.slice(0, 200));
  }
  // (every name taken from the core is one the check covers, under the same name, and the other way round)
  const taken: string[] = [];
  for (const sec of patch.split(/^--- a\/py\/mpmath\//m).slice(1)) {
    const mod = sec.split("\n")[0].replace(/^(libmp\/)?(\w+)\.py$/, "$2");
    // (ctx_mp's base context: the core's Context; checked apart from the table)
    if (mod === "ctx_mp") {
      assert.match(sec, /^\+    BaseMPContext = _sagebrush_mpcore\.Context$/m);
      assert.match(sec, /^\+    from \. import ctx_mp_python as _mpf_module$/m, "pickles name mpmath.ctx_mp_python's types");
      continue;
    }
    for (const m of sec.matchAll(/^\+\s+(\w+) = _sagebrush_mpcore\.(\w+)$/gm)) {
      assert.equal(m[1], m[2], `${mod}: ${m[1]} takes the core's ${m[2]}`);
      taken.push(`${mod}.${m[1]}`);
    }
  }
  const table = hooks();
  assert.deepEqual(taken.sort(), table.sort());
  assert.equal(table.length, 27);
  // (libelefun's mpf constants rebuilt from the core's fixed-point functions: each holds its function)
  for (const c of ["pi", "ln2", "e"]) assert.match(patch, new RegExp(`^\\+    mpf_${c} = def_mpf_constant\\(${c}_fixed\\)$`, "m"), c);
  // (no module is registered as another: nothing names sys.modules, gmpy or sage)
  assert.doesNotMatch(patch.split("\n").filter((l) => l.startsWith("+")).join("\n"), /sys\.modules\[['"](gmpy|sage)|import (gmpy|sage)/);
});

test("mpmath's backend is chosen once, by SAGEBRUSH_MPMATH_BACKEND: 'sagebrush' by default; 'python' is the rollback; another value is refused", () => {
  // (the live modules, not the setting: whether the core is loaded, whether libmpf's mpf_add is its, the base context's module)
  const code =
    "import sys, mpmath; from mpmath.libmp import libmpf; c = sys.modules.get('_sagebrush_mpcore'); " +
    "print(mpmath.libmp.BACKEND, c is not None, c is not None and libmpf.mpf_add is c.mpf_add, mpmath.ctx_mp.BaseMPContext.__module__)";
  assert.equal(run(null, ["-c", code]).out, "sagebrush True True _sagebrush_mpcore\n");
  assert.equal(run("sagebrush", ["-c", code]).out, "sagebrush True True _sagebrush_mpcore\n");
  assert.equal(run("python", ["-c", code]).out, "python False False mpmath.ctx_mp_python\n");
  const bogus = run("gmpy", ["-c", code]);
  assert.notEqual(bogus.status, 0);
  assert.match(bogus.err, /ImportError: SAGEBRUSH_MPMATH_BACKEND is 'gmpy': it must be 'python' or 'sagebrush'/);
});

test("mpmath selected 'sagebrush' gives the python backend's raw results, every hook the core's; pickles unchanged; no gmpy or sage", () => {
  const py = run("python", [PROBE]), sb = run("sagebrush", [PROBE]);
  assert.equal(py.status, 0, py.err);
  assert.equal(sb.status, 0, sb.err);
  const p = py.out.split("\n"), s = sb.out.split("\n");
  assert.equal(p[0], "backend python True int");
  assert.equal(s[0], "backend sagebrush True int");
  assert.deepEqual(s.slice(1, -2), p.slice(1, -2));
  assert.ok(s.includes("ImportError gmpy2") && s.includes("ImportError sage"));
  assert.equal(p[p.length - 2], "hooked None");
  const hooked = JSON.parse(s[s.length - 2].replace(/^hooked /, "").replace(/'/g, '"'));
  assert.deepEqual(hooked, hooks().sort(), "every hook the core's");
});

test("the python backend's results are CPython's, line for line (the probe under CPython with the same package)", (t) => {
  const v = spawnSync("python3", ["-c", "import sys; print(sys.version_info[:2] >= (3, 12))"], { encoding: "utf8" });
  if (v.stdout?.trim() !== "True") return t.skip("no python3 3.12 or later");
  const env = { ...process.env, PYTHONPATH: join(PKG, "py"), MPMATH_NOGMPY: "1", SAGEBRUSH_MPMATH_BACKEND: "python" };
  // (up to the pickles: the machine's CPython may have gmpy2 installed, and the backend line reads only the env)
  const upto = (out: string) => out.split("\n").filter((l) => /^(backend|arith|elem|const|mpc|fixed|int|norm|pickle) /.test(l));
  const want = upto(execFileSync("python3", [PROBE], { encoding: "utf8", env }));
  assert.equal(want.length, 9);
  assert.deepEqual(upto(run("python", [PROBE]).out), want);
});

test("a partial integration is an import error: a 'sagebrush' branch that doesn't take its hook is found by ctx_mp's check", () => {
  const partial = mkdtempSync(join(tmpdir(), "sb-mppartial-"));
  try {
    cpSync(join(PKG, "py/mpmath"), join(partial, "mpmath"), { recursive: true });
    const f = join(partial, "mpmath/libmp/libmpc.py"), line = "    mpc_exp = _sagebrush_mpcore.mpc_exp\n", text = readFileSync(f, "utf8");
    assert.ok(text.includes(line));
    writeFileSync(f, text.replace(line, ""));
    const r = run("sagebrush", ["-c", `import sys; sys.path[:0] = ${JSON.stringify([partial])}; import mpmath`]);
    assert.notEqual(r.status, 0);
    assert.match(r.err, /ImportError: mpmath's backend 'sagebrush': libmpc\.mpc_exp is not _sagebrush_mpcore's/);
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
});
