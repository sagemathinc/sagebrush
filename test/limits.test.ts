import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeLimitsOption, utf8Bytes } from "../src/limits";

// The engine's limits (plan-ff-limits r3): lib/_limits.py's validator, the
// same under the engine as under CPython (test/limits_cases.out was written
// by CPython), and the CLI's gate (src/limits.ts): invalid limits, from
// --limits FILE or SAGEBRUSH_LIMITS=FILE, end the run with status 2 and the
// message before the program's first statement.  The launcher's own read,
// and its worker and in-process paths: web/test-cli-limits.mjs.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
const dir = mkdtempSync(join(tmpdir(), "sb-limits-"));
const file = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
const run = (args: string[], env: Record<string, string> = {}, input?: string) => {
  const e: Record<string, string | undefined> = { ...process.env, ...env };
  if (!("SAGEBRUSH_LIMITS" in env)) delete e.SAGEBRUSH_LIMITS;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: e, input, maxBuffer: 16 << 20 });
};

test("the limits validator answers as CPython's does, case by case (test/limits_cases.py)", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "limits_cases.py"], { encoding: "utf8" });
  assert.equal(got, readFileSync(TEST + "limits_cases.out", "utf8"));
});

test("invalid limits stop the run before its first statement, with status 2 and the reason", () => {
  const big = file("big.json", '{"ff.work": 100000' + " ".repeat(5000) + "}");
  const missing = join(dir, "missing.json");
  const cases: [string, string][] = [
    [missing, `sagebrush: limits: cannot read ${missing}: No such file or directory`],
    [dir, `sagebrush: limits: cannot read ${dir}: Is a directory`],
    [big, `sagebrush: limits: ${big} is larger than 4096 bytes`],
    [file("bad.json", "{"), "is not JSON: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"],
    [file("accent.json", '{"ff.w\u00e9rk": 1}'), "sagebrush: limits: ff.w\u00e9rk is not a limit of this engine"],
    [file("bom.json", "\ufeff{}"), "is not JSON: Unexpected UTF-8 BOM"],
    [file("array.json", "[1]"), "sagebrush: limits: the limits must be a JSON object, not an array"],
    [file("many.json", JSON.stringify(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])))), "sagebrush: limits: more than 16 entries"],
    [file("unknown.json", '{"ff.wrok": 1}'), "sagebrush: limits: ff.wrok is not a limit of this engine (its limits: ff.conway_work, ff.embed_max, ff.root_bits, ff.work, matlab.lu_work, nf.certify_index_max, nf.certify_norm_max, nf.relation_rounds, padic.kedlaya_work, pandas.decoded_bytes, poly.work)"],
    [file("bool.json", '{"ff.work": true}'), 'sagebrush: limits: ff.work must be an integer or "unlimited", not true'],
    [file("float.json", '{"ff.work": 1e7}'), 'sagebrush: limits: ff.work must be an integer or "unlimited", not 10000000.0'],
    [file("range.json", '{"ff.work": 5}'), "sagebrush: limits: ff.work = 5 is outside the range this engine allows, [100000, 100000000]"],
    [file("raise.json", '{"ff.embed_max": 2097152}'), "sagebrush: limits: ff.embed_max = 2097152 is outside the range this engine allows, [256, 1048576]"],
  ];
  // (bytes that are not UTF-8)
  writeFileSync(join(dir, "bytes.json"), Buffer.from([0x7b, 0xff, 0x7d]));
  cases.push([join(dir, "bytes.json"), "is not JSON: it is not UTF-8"]);
  for (const [path, want] of cases) {
    for (const [how, args, env] of [
      ["--limits", ["--limits", path, "-c", "print('MARKER')"], {}],
      ["SAGEBRUSH_LIMITS", ["-c", "print('MARKER')"], { SAGEBRUSH_LIMITS: path }],
      ["--magma", ["--limits", path, "--magma", "-c", 'print "MARKER";'], {}],
      ["--sage on stdin", ["--limits", path, "--sage"], {}],
    ] as [string, string[], Record<string, string>][]) {
      const r = run(args, env, how === "--sage on stdin" ? "print('MARKER')\n" : undefined);
      assert.equal(r.status, 2, `${how} ${path}: ${r.stderr}`);
      assert.ok(!r.stdout.includes("MARKER"), `${how} ${path}: the program ran`);
      assert.ok(r.stderr.includes(want), `${how} ${path}: ${r.stderr}`);
    }
  }
});

test("valid limits are the session's, read once and locked before the program runs", () => {
  const ok = file("ok.json", '{"ff.work": 123456, "ff.root_bits": 100}');
  const show = "import sys, _sage_ffsub as S; print(S.WORK, S.ROOT_BITS, S.EMBED_MAX, sys._sagebrush_limits['ff.work'])";
  for (const [args, env] of [
    [["--limits", ok, "-c", show], {}],
    [["-c", show], { SAGEBRUSH_LIMITS: ok }],
  ] as [string[], Record<string, string>][]) {
    const r = run(args, env);
    assert.equal(r.stdout, "123456 100 1048576 123456\n", r.stderr);
  }
  // none: the defaults, every key unlimited (plan-c0 r2), which the core
  // reads as infinity; with ff.work finite (above), the effective
  // ff.embed_max is at most 2^20 (the discrete-log accounting's range);
  // unlimited, the fields' bound is the Conway search's cutoff, 10^7
  assert.equal(run(["-c", show]).stdout, "inf inf 10000000 inf\n");
  // --limits FILE wins over SAGEBRUSH_LIMITS; one that can't be read is never replaced by it
  assert.equal(run(["--limits", ok, "-c", show], { SAGEBRUSH_LIMITS: file("other.json", '{"ff.work": 200000}') }).stdout, "123456 100 1048576 123456\n");
  const r = run(["--limits", join(dir, "nope.json"), "-c", show], { SAGEBRUSH_LIMITS: ok });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  // user code can't set them again: they were locked at startup
  const again = run(["-c", "import _limits\ntry:\n    _limits.propose(_limits.validate({'ff.work': 100000000}))\nexcept RuntimeError as e:\n    print(e)"]);
  assert.equal(again.stdout, "sagebrush limits are read once, at the first use: set them before it\n");
  // after -c (or a script), --limits is the program's argument
  assert.equal(run(["-c", "import sys; print(sys.argv[1:])", "--limits", "x"]).stdout, "['--limits', 'x']\n");
  const twice = run(["--limits", ok, "--limits", ok, "-c", "print(1)"]);
  assert.equal(twice.status, 2);
  assert.ok(twice.stderr.startsWith("sagebrush: --limits is given more than once\n"));
  const none = run(["--limits"]);
  assert.equal(none.status, 2);
  assert.ok(none.stderr.startsWith("sagebrush: --limits takes a file\n"));
});

test("--limits is taken only among the interpreter's own options", () => {
  const take = (a: string[]) => {
    const r = takeLimitsOption(a);
    return [r, a];
  };
  assert.deepEqual(take(["--limits", "f", "-c", "x"]), ["f", ["-c", "x"]]);
  assert.deepEqual(take(["--sage", "--limits", "f", "p.sage", "--limits", "g"]), ["f", ["--sage", "p.sage", "--limits", "g"]]);
  assert.deepEqual(take(["-c", "x", "--limits", "f"]), [null, ["-c", "x", "--limits", "f"]]);
  assert.deepEqual(take(["-m", "mod", "--limits", "f"]), [null, ["-m", "mod", "--limits", "f"]]);
  assert.deepEqual(take(["--", "--limits", "f"]), [null, ["--", "--limits", "f"]]);
  assert.deepEqual(take(["--figures", "--limits", "p.py"]), [null, ["--figures", "--limits", "p.py"]]);
  assert.deepEqual(take(["--limits", "f", "notebook", "--port", "1"]), ["f", ["notebook", "--port", "1"]]);
  assert.deepEqual(take(["--limits"]), [{ error: "--limits takes a file" }, ["--limits"]]);
});

test("the browser init's text is counted in UTF-8 bytes, without a copy", () => {
  assert.equal(utf8Bytes("abc"), 3);
  assert.equal(utf8Bytes("\u00e9"), 2);
  assert.equal(utf8Bytes("\u20ac"), 3);
  assert.equal(utf8Bytes("\ud83d\ude00"), 4);
  assert.equal(utf8Bytes("\ud83d"), 3); // (a lone surrogate, as Python's surrogatepass)
  assert.equal(utf8Bytes("\u00e9".repeat(2048)), 4096);
  assert.equal(utf8Bytes("\u00e9".repeat(2049)), 4097);
  assert.equal(utf8Bytes("x".repeat(1e6)), 4097); // (stops past the cap)
});

// The census of limit-like refusal sites (plan-c0 r2 section 4;
// test/limit_sites.py): a lexical change detector, not a proof that every
// hidden cap is caught.  A new or changed site matching the census
// vocabulary needs a reviewed class and owner in test/limit-sites.json; the
// baseline (the sites at the seed, unclassified, certifying nothing) is
// pinned, so nothing joins it later.
const LIMIT_SITES_BASELINE_SHA256 = "b0d463cb97ced28f8d3331c4a1dc3401cfd419d011ab37152227a11e498029e4";
test("every census-vocabulary refusal site is registered with a class and owner; the baseline is the seed's (test/limit_sites.py)", () => {
  const r = spawnSync("python3", [TEST + "limit_sites.py", "--check"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const got = JSON.parse(r.stdout);
  assert.equal(got.baseline_sha256, LIMIT_SITES_BASELINE_SHA256, "test/limit-sites-baseline.txt changed: only a deliberate, reviewed --seed may change it");
  assert.deepEqual(
    got.problems,
    { unregistered: [], stale: [], invalid: [], sweep: [] },
    "register each new or changed site with its class (1, 2, 3, ..., coverage, none) and owner: python3 test/limit_sites.py --register CLASS OWNER [--key K ...]; drop stale entries: --prune; a baseline site the sweep's manifest doesn't excuse, or a sweep problem: test/limit_sweep.py",
  );
  assert.equal(r.status, 0, r.stderr);
  // (the class-2 sites whose guards say so in the memory guards' message,
  // item D: a count that only goes up, as doctest coverage's)
  assert.ok(got.explained >= 17, `${got.explained} explained memory-guard sites, fewer than D1's 17`);
  // (the sweep's progress: the tree's count, which batches.json records and the sweep's check compares)
  const state = JSON.parse(readFileSync(TEST + "limit-sweep/batches.json", "utf8"));
  assert.equal(got.active_baseline, state.active_baseline, "the active-baseline count isn't batches.json's: python3 test/limit_sweep.py recount");
});

// The baseline sweep (plan-limit-sites-sweep-r3): its manifest is the one
// rebuilt from the commit it names (that commit's files, registry and
// baseline, whatever the working tree holds), and its tooling's fixture
// cases (the manifest, astra2's membership counterexamples, the follow-ups'
// liveness, apply's refusals, the three-way merge) pass.
test("the sweep's manifest is the one rebuilt from its revision (test/limit_sweep.py verify)", () => {
  const r = spawnSync("python3", [TEST + "limit_sweep.py", "verify"], { encoding: "utf8", maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("the sweep's tooling: its fixture cases (test/limit_sweep_cases.py)", () => {
  const r = spawnSync("python3", [TEST + "limit_sweep_cases.py"], { encoding: "utf8", maxBuffer: 16 << 20 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ok: the sweep's tooling, \d+ checks\n$/);
});

// Every limit unlimited by default, finite ones opt-in (plan-c0 r2):
// mixed settings resolve key by key (an unlimited value is infinity in the
// core); with ff.work finite the effective ff.embed_max is at most 2^20, the
// discrete-log accounting's range; computations refused at the old defaults
// now complete, and refuse as before when a policy sets those values
// (test/limits-finite.json).
test("unlimited by default, finite values opt in, mixed settings key by key (plan-c0 r2)", () => {
  const show = "import sys, _sage_ffsub as S; print(S.WORK, S.EMBED_MAX, S.ROOT_BITS, sys._sagebrush_limits)";
  const cases: [string, string][] = [
    ['{"ff.work": 100000}', "100000 1048576 inf Limits({'ff.conway_work': unlimited, 'ff.embed_max': unlimited, 'ff.root_bits': unlimited, 'ff.work': 100000, 'matlab.lu_work': unlimited, 'nf.certify_index_max': unlimited, 'nf.certify_norm_max': unlimited, 'nf.relation_rounds': unlimited, 'padic.kedlaya_work': unlimited, 'pandas.decoded_bytes': unlimited, 'poly.work': unlimited})"],
    ['{"ff.root_bits": 64}', "inf 10000000 64 Limits({'ff.conway_work': unlimited, 'ff.embed_max': unlimited, 'ff.root_bits': 64, 'ff.work': unlimited, 'matlab.lu_work': unlimited, 'nf.certify_index_max': unlimited, 'nf.certify_norm_max': unlimited, 'nf.relation_rounds': unlimited, 'padic.kedlaya_work': unlimited, 'pandas.decoded_bytes': unlimited, 'poly.work': unlimited})"],
    ['{"ff.embed_max": 4096}', "inf 4096 inf Limits({'ff.conway_work': unlimited, 'ff.embed_max': 4096, 'ff.root_bits': unlimited, 'ff.work': unlimited, 'matlab.lu_work': unlimited, 'nf.certify_index_max': unlimited, 'nf.certify_norm_max': unlimited, 'nf.relation_rounds': unlimited, 'padic.kedlaya_work': unlimited, 'pandas.decoded_bytes': unlimited, 'poly.work': unlimited})"],
    ['{"ff.work": "unlimited", "ff.embed_max": "unlimited"}', "inf 10000000 inf Limits({'ff.conway_work': unlimited, 'ff.embed_max': unlimited, 'ff.root_bits': unlimited, 'ff.work': unlimited, 'matlab.lu_work': unlimited, 'nf.certify_index_max': unlimited, 'nf.certify_norm_max': unlimited, 'nf.relation_rounds': unlimited, 'padic.kedlaya_work': unlimited, 'pandas.decoded_bytes': unlimited, 'poly.work': unlimited})"],
  ];
  for (const [text, want] of cases) {
    const r = run(["--limits", file("mixed.json", text), "-c", show]);
    assert.equal(r.stdout, want + "\n", `${text}: ${r.stderr}`);
  }
  const prog = [
    "K = GF(2^22); F = GF(2^11)",
    "try:",
    "    print('embed', K(F.gen()) ^ (2^11) == K(F.gen()))",
    "except NotImplementedError as e:",
    "    print('embed refused:', str(e)[:60])",
    "y = GF(7^3).gen(); k = 2^1100 + 1",
    "try:",
    "    print('root', y.nth_root(k) ^ k == y)",
    "except NotImplementedError as e:",
    "    print('root refused:', e)",
    "",
  ].join("\n");
  const p = file("refused-before.sage", prog);
  assert.equal(run([p]).stdout, "embed True\nroot True\n");
  assert.equal(run(["--limits", TEST + "limits-finite.json", p]).stdout,
    "embed refused: coercion of elements of Finite Field in z11 of size 2^11 and\nroot refused: nth_root of an exponent of more than 1024 bits is not supported yet\n");
  // the cross-key rule: ff.work finite, ff.embed_max left unlimited, a field
  // past 2^20 is refused with the text of before
  const cross = run(["--limits", file("cross.json", '{"ff.work": 10000000}'), p]);
  assert.ok(cross.stdout.startsWith("embed refused: coercion of elements of Finite Field in z11"), cross.stdout + cross.stderr);
});

// The descent's discrete-log table after plan-c0 (r2 section 2): the worst
// reachable case, GF(7^8) down to GF(7^4) (r = 1201), holds at most 35
// entries; and over every Conway field of composite degree with at most 10^7
// elements the largest table is 35, recomputed with the engine's factoring.
test("the class-group and polynomial keys reach the engine only when finite, and explicit arguments win (C0's per-area follow-up)", () => {
  // the request fields sagebrush/_engine.py adds: none by default
  const probe = "import sagebrush._engine as E\nprint(E._with_limits('bnf', {}), E._with_limits('quadratic_class_group', {}), E._with_limits('factor', {}), E._with_limits('bnf_certify', {'norm_max': 5}), E._with_limits('nf_data', {}))\n";
  let r = run(["-c", probe]);
  assert.equal(r.stdout, "{} {} {} {'norm_max': 5} {}\n", r.stderr);
  // finite values are sent; an explicit bnf_certify argument wins
  const lim = file("nfpoly.json", '{"poly.work": 1048576, "nf.relation_rounds": 7, "nf.certify_norm_max": 1000000, "nf.certify_index_max": 1000}');
  r = run(["--limits", lim, "-c", probe]);
  assert.equal(r.stdout, "{'rounds': 7} {'rounds': 7} {'work': 1048576} {'norm_max': 5, 'index_max': 1000} {}\n", r.stderr);
  // end to end: the certificate's opt-in norm limit refuses as the former
  // default did, and without it the certificate runs (its time: VM1, 13.6 s)
  const cert = file("cert.json", '{"nf.certify_norm_max": 1000000}');
  r = run(["--limits", cert, "--sage", "-c", "x = polygen(QQ, 'x')\ntry:\n    NumberField(x^2 + 3*10^12 + 1, 'a').class_number(proof=True)\nexcept NotImplementedError as e:\n    print(e)\n"]);
  assert.match(r.stdout, /beyond the limits of the unconditional certificate: the Minkowski bound for the norms of ideal class representatives is 2205315, above the limit 1000000/, r.stderr);
  // a finite poly.work refuses a factorization that needs more: the
  // trinomial x^400 + x^3 + 2 (irreducible; a binomial would take the
  // cyclotomic path, which this limit doesn't meter) has its modular
  // factorization ask for 425060 limb operations when 26173 of the 2^20 are
  // left (VM1; unlimited, 3.0 s in all); a small product of three factors fits
  const pw = file("pw.json", '{"poly.work": 1048576}');
  const f = (g: string) => `x = polygen(ZZ, 'x')\ntry:\n    print(len(list(factor(${g}))))\nexcept Exception as e:\n    print(type(e).__name__, 'work' in str(e))\n`;
  assert.equal(run(["--limits", pw, "--sage", "-c", f("(x^4 + x + 1) * (x^3 - 2) * (x^2 + 3)")]).stdout, "3\n");
  assert.equal(run(["--sage", "-c", f("x^400 + x^3 + 2")]).stdout, "1\n");
  assert.equal(run(["--limits", pw, "--sage", "-c", f("x^400 + x^3 + 2")]).stdout, "ValueError True\n");
});

test("a descent's discrete-log table stays at most 35 entries with every limit unlimited (plan-c0 r2)", () => {
  const code = [
    "import math, _sage_ff as F, _sage_ffsub as S",
    "sizes = []",
    "real = F._bsgs",
    "def spy(g, h, n, mul, one, power):",
    "    sizes.append(math.isqrt(n) + 1)",
    "    return real(g, h, n, mul, one, power)",
    "F._bsgs = spy",
    "K, L = F.GF(7 ** 8), F.GF(7 ** 4)",
    "x = K.gen() ** ((7 ** 8 - 1) // (7 ** 4 - 1) * 5)",
    "y = S.down(x, L, [S.WORK], ValueError)",
    "print(y is not None, max(sizes))",
    "best = 0",
    "for p in range(2, 3163):",
    "    if any(p % d == 0 for d in range(2, int(p ** 0.5) + 1)):",
    "        continue",
    "    n = 4",
    "    while p ** n <= 10 ** 7:",
    "        if any(n % d == 0 for d in range(2, n)):",
    "            best = max(best, math.isqrt(max(r for r, e in F._factor_int(p ** n - 1))) + 1)",
    "        n += 1",
    "print(best)",
  ].join("\n");
  const r = run(["-c", code]);
  assert.equal(r.stdout, "True 35\n35\n", r.stderr);
});

// Given no limits, a runtime locks the defaults without importing _limits
// at startup (plan-coldstart-limits r2: with a fresh compile cache that
// import compiled it on every first run): the module locks at its first
// import, propose then refuses as before, and sys._sagebrush_limits is
// there from the start.  Configured limits still import and lock at once.
const LOCKED_TRY = "try:\n    L.propose(L.validate('{\"ff.work\": 100000}'))\n    print('open')\nexcept RuntimeError as e:\n    print('refused', str(e) == L.LOCKED)\n";

test("no limits: _limits is not imported at startup, and locks at its first import or read", () => {
  for (const env of [{}, { SAGEBRUSH_NO_WORKER: "1" }] as Record<string, string>[]) {
    const first = run(["-c", "import sys\nprint('_limits' in sys.modules, hasattr(sys, '_sagebrush_limits'), hasattr(sys, '__getattr__'))\nimport _limits as L\nprint(L.finalized(), sys._sagebrush_limits is L.DEFAULTS is L.finalize())\n" + LOCKED_TRY], env);
    assert.equal(first.stdout, "False True False\nTrue True\nrefused True\n", first.stderr);
    const read = run(["-c", "import sys\nv = sys._sagebrush_limits\nimport _limits as L\nprint(v is L.DEFAULTS, L.finalized(), sys._sagebrush_limits is v)\n" + LOCKED_TRY], env);
    assert.equal(read.stdout, "True True True\nrefused True\n", read.stderr);
    // assigned or deleted before _limits is imported, it stays so, as after a finalize at startup
    const set = run(["-c", "import sys\nsys._sagebrush_limits = 5\nimport _limits as L\nprint(sys._sagebrush_limits, L.finalized())\ndel sys._sagebrush_limits\nprint(hasattr(sys, '_sagebrush_limits'))\n" + LOCKED_TRY], env);
    assert.equal(set.stdout, "5 True\nFalse\nrefused True\n", set.stderr);
    const gone = run(["-c", "import sys\ndel sys._sagebrush_limits\nimport _limits as L\nprint(hasattr(sys, '_sagebrush_limits'), L.finalized(), L.finalize() is L.DEFAULTS)\n"], env);
    assert.equal(gone.stdout, "False True True\n", gone.stderr);
    const seen = run(["-c", "import sys\nprint('_sagebrush_limits' in dir(sys), '_limits' in sys.modules)\nv = vars(sys)['_sagebrush_limits']\nimport _limits as L\nprint(v is L.DEFAULTS, sys._sagebrush_limits is v)\n"], env);
    assert.equal(seen.stdout, "True False\nTrue True\n", seen.stderr);
    const other = run(["-c", "import sys\nprint(getattr(sys, 'nope', 7))\nsys.nope"], env);
    assert.equal(other.stdout, "7\n");
    assert.ok(other.stderr.includes("AttributeError: module 'sys' has no attribute 'nope'"), other.stderr);
  }
  const lim = file("lazy.json", '{"ff.work": 400000}');
  const empty = file("empty.json", "{}");
  const show = "import sys\nprint('_limits' in sys.modules, sys._sagebrush_limits['ff.work'])\nimport _limits as L\n" + LOCKED_TRY;
  for (const [args, env, work] of [
    [["--limits", lim, "-c", show], {}, "400000"],
    [["-c", show], { SAGEBRUSH_LIMITS: lim }, "400000"],
    [["-c", show], { SAGEBRUSH_LIMITS: lim, SAGEBRUSH_NO_WORKER: "1" }, "400000"],
    [["--limits", empty, "-c", show], {}, "inf"],
  ] as [string[], Record<string, string>, string][]) {
    const r = run(args, env);
    assert.equal(r.stdout, `True ${work}\nrefused True\n`, `${args} ${JSON.stringify(env)}: ${r.stderr}`);
  }
});

test("startLimits(null) finalizes an already imported _limits, keeping its pending or final snapshot", () => {
  const go = (steps: string) => {
    const prog = `
const { initParser, R, libDir } = require(${JSON.stringify(__dirname + "/../src/compile")});
const { startLimits } = require(${JSON.stringify(__dirname + "/../src/limits")});
const { getattr } = require(${JSON.stringify(__dirname + "/../src/runtime/object")});
(async () => {
  await initParser();
  const sys = R.importModule("sys");
  sys.path.push(libDir());
  const L = () => R.importModule("_limits");
  const call = (f, ...a) => R.callObj(getattr(L(), f), a);
  const work = () => R.callObj(getattr(sys._sagebrush_limits, "__getitem__"), ["ff.work"]);
  const locked = () => { try { call("propose", call("validate", '{"ff.work": 100000}')); return "open"; } catch (e) { return String(R.str(R.toPyExc(e))) === getattr(L(), "LOCKED") ? "locked" : String(e); } };
  const out = [];
  ${steps}
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(1); });
`;
    return JSON.parse(execFileSync(process.execPath, ["-e", prog], { encoding: "utf8" }));
  };
  // nothing imported: lazy; the first import is locked, the defaults
  assert.deepEqual(go(`startLimits(R, null, true); out.push(R.sysModules.$m.has("_limits"), call("finalized"), sys._sagebrush_limits === getattr(L(), "DEFAULTS"), locked());`), [false, true, true, "locked"]);
  // an unlocked start, then the host imports the validator: the lock finalizes it
  assert.deepEqual(go(`startLimits(R, null, false); out.push(call("finalized")); startLimits(R, null, true); out.push(call("finalized"), sys._sagebrush_limits === getattr(L(), "DEFAULTS"), locked());`), [false, true, true, "locked"]);
  // a pending proposal is the snapshot locked
  assert.deepEqual(go(`startLimits(R, null, false); call("propose", call("validate", '{"ff.work": 300000}')); startLimits(R, null, true); out.push(work(), locked());`), [300000, "locked"]);
  // configured and locked, then startLimits(null): the same snapshot stays
  assert.deepEqual(go(`startLimits(R, { text: '{"ff.work": 200000}', name: null }); const s = sys._sagebrush_limits; startLimits(R, null, true); out.push(sys._sagebrush_limits === s, work(), locked());`), [true, 200000, "locked"]);
});

test("a notebook session (the kernel's and the browser worker's) is lazy without limits and locks either way", () => {
  const cell = "import sys\\nprint('_limits' in sys.modules, sys._sagebrush_limits['ff.work'])\\nimport _limits as L\\n" + JSON.stringify(LOCKED_TRY).slice(1, -1);
  const go = (limits: string) =>
    execFileSync(process.execPath, ["-e", `
const { notebookSession } = require(${JSON.stringify(__dirname + "/../src/notebook-session")});
const out = [];
const s = notebookSession((m) => { if (m.stream) out.push(m.text); }, { captureStreams: true, limits: ${limits} });
s.ready.then(() => s.handle({ id: 1, code: "${cell}" })).then(() => process.stdout.write(out.join("")), (e) => { console.error(e); process.exit(1); });
`], { encoding: "utf8" });
  assert.equal(go("null"), "False inf\nrefused True\n");
  assert.equal(go(`{ text: '{"ff.work": 400000}', name: null }`), "True 400000\nrefused True\n");
});

// sagebrush.limit(name), the public read of one limit (plan-pandas r7
// section E (a)): optional packages may use it (core-api-surface.json),
// where _limits is private.  Unlimited (infinity) by default; a value set by
// --limits or SAGEBRUSH_LIMITS read back; the first read locks the limits,
// as the first use of a limited layer does; an unknown name is the
// validator's ValueError, and a name that isn't a str a TypeError.
test("sagebrush.limit(name): unlimited by default, the run's value, locking at the first read", () => {
  const show = "import sagebrush; print(sagebrush.limit('pandas.decoded_bytes'), sagebrush.limit('ff.work'))";
  assert.equal(run(["-c", show]).stdout, "inf inf\n");
  const set = file("pandas.json", '{"pandas.decoded_bytes": 33554432}');
  assert.equal(run(["--limits", set, "-c", show]).stdout, "33554432 inf\n");
  assert.equal(run(["-c", show], { SAGEBRUSH_LIMITS: set }).stdout, "33554432 inf\n");
  // (the first read locks: a later proposal is refused)
  const lock = "import sagebrush, _limits as L\nsagebrush.limit('ff.work')\ntry:\n    L.propose(L.validate({}))\nexcept RuntimeError as e:\n    print('RuntimeError', e)";
  assert.equal(run(["-c", lock]).stdout, "RuntimeError sagebrush limits are read once, at the first use: set them before it\n");
  const errors = [
    ["'pandas.decoded'", "ValueError limits: pandas.decoded is not a limit of this engine (its limits: ff.conway_work, ff.embed_max, ff.root_bits, ff.work, matlab.lu_work, nf.certify_index_max, nf.certify_norm_max, nf.relation_rounds, padic.kedlaya_work, pandas.decoded_bytes, poly.work)"],
    ["1", "TypeError limit() argument must be a str, not int"],
    ["None", "TypeError limit() argument must be a str, not NoneType"],
  ];
  for (const [arg, want] of errors) {
    const r = run(["-c", `import sagebrush\ntry:\n    sagebrush.limit(${arg})\nexcept Exception as e:\n    print(type(e).__name__, e)`]);
    assert.equal(r.stdout, want + "\n", r.stderr);
  }
  // (an out-of-range value stops the run first, as every key's does)
  const r = run(["--limits", file("small.json", '{"pandas.decoded_bytes": 1000}'), "-c", "print('MARKER')"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /sagebrush: limits: pandas\.decoded_bytes = 1000 is outside the range this engine allows, \[1048576, 1099511627776\]/);
  assert.doesNotMatch(r.stdout, /MARKER/);
});
