import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Estimates (lib/sagebrush/_estimates.py, engine/classgroup/src/nf/cost.rs;
// estimates plan r3 PR 2a): the engine prints what CPython prints for the
// parts that need no engine (test/estimates_cases.out), and the real engine's
// factorization estimates are valid records with the ruled milestone form.
const ROOT = __dirname + "/../../";
const CLI = __dirname + "/../src/cli.js";
// (no calibration cache is read or written by the tests)
const ENV = { ...process.env, SAGEBRUSH_CALIBRATION_CACHE: "" };

test("the parts without an engine print as CPython's do (test/estimates_cases.py)", () => {
  const got = execFileSync(process.execPath, [CLI, ROOT + "test/estimates_cases.py"], { encoding: "utf8", env: ENV });
  assert.equal(got, readFileSync(ROOT + "test/estimates_cases.out", "utf8"));
});

// (the 10 ms of E4 §3, the best of 5 calls, scaled by SAGEBRUSH_TIME_SCALE on a
// slower machine, as the other wall-clock bounds. Report-only unless
// SAGEBRUSH_STRICT_TIMING=1: on a shared runner node --test runs a shard's files
// side by side, and a busy machine slowed all 5 calls past the bound (#330's run
// 40999434803). Its samples are always reported (OBS, on the test's output); the
// functional lines below are always exact)
const STRICT_TIMING = process.env.SAGEBRUSH_STRICT_TIMING === "1";
test("estimate(factor, n) from the real engine: valid, milestones q = p_typical = p_high, nothing summed, under 10 ms", () => {
  const code = [
    "import time, random",
    "import sagebrush",
    "from sagebrush import records",
    "sagebrush.estimate(factor, 2^64 + 1)  # (the first call calibrates)",
    "random.seed(7); expected = [random.random() for _ in range(3)]; random.seed(7)",
    "e = sagebrush.estimate(factor, 2^300 + 1)",
    "ts = []",
    "for _ in range(5):",
    "    t = time.perf_counter(); sagebrush.estimate(factor, 2^300 + 1); ts.append(time.perf_counter() - t)",
    "dt = min(ts)",
    "records.validate(dict(e))",
    "import sys; print('OBS estimate ms, 5 calls:', ' '.join('%.2f' % (x * 1000) for x in ts), file=sys.stderr)",
    ...(STRICT_TIMING ? ["print('within the time bound:', dt < 0.010 * " + (Number(process.env.SAGEBRUSH_TIME_SCALE) || 1) + ")"] : []),
    "print('random stream unchanged:', [random.random() for _ in range(3)] == expected)",
    "print('total:', e['total_time'])",
    "ms = [s for s in e['stages'] if s['success']]",
    "print('milestones:', len(ms) > 0, all(s['success']['p_typical'] == s['success']['p_high'] for s in ms))",
    "print('conditions:', all(s['condition'].startswith('if a factor of at most ') for s in ms))",
    "print('high_s null before 2b:', all(s['time']['high_s'] is None for s in e['stages']))",
    "byd = {}",
    "for s in ms:",
    "    byd.setdefault(s['condition'], []).append((s['success']['p_typical'], int(s['work']['units'])))",
    "print('95% work >= 50% work:', all(a[1] <= b[1] for v in byd.values() for a, b in zip(v, v[1:])))",
    "big = sagebrush.estimate(factor, 2^1100 + 1)",
    "print('above 1024 bits:', any('1024 bits' in a for a in big['assumptions']), big['total_time'])",
    "print(sagebrush.capabilities()['estimate'])",
  ].join("\n");
  const r = spawnSync(process.execPath, [CLI, "--sage", "-c", code], { encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr);
  // (the samples, reported: the best of them against the bound, which fails only under SAGEBRUSH_STRICT_TIMING=1)
  const obs = /^OBS estimate ms, 5 calls: (.*)$/m.exec(r.stderr);
  assert.ok(obs, "the timing samples are reported: " + r.stderr);
  const best = Math.min(...obs[1].split(" ").map(Number)), bound = 10 * (Number(process.env.SAGEBRUSH_TIME_SCALE) || 1);
  console.log(`OBS estimate(factor, 2^300 + 1): best of 5 ${best.toFixed(2)} ms (samples ${obs[1]}), bound ${bound} ms${best < bound ? "" : " EXCEEDED"}${STRICT_TIMING ? "" : " (report-only)"}`);
  assert.equal(
    r.stdout,
    [
      ...(STRICT_TIMING ? ["within the time bound: True"] : []),
      "random stream unchanged: True",
      "total: None",
      "milestones: True True",
      "conditions: True",
      "high_s null before 2b: True",
      "95% work >= 50% work: True",
      "above 1024 bits: True None",
      "True",
      "",
    ].join("\n"),
  );
});

// Astra's review of PR 2a, EST-BOUND: every count is exact or unknown, never
// clamped, at the first boundaries (where u64 saturated before, and where
// u128 ends), through the engine op and the record path.  The figures are
// CPython's, from the closed forms term by term (nf/cost.rs's tests check
// the same values).
test("estimates: exact counts or unknown at the first boundaries, through the engine op and the record path", () => {
  const code = [
    "import sagebrush",
    "from sagebrush import _estimates as E, records",
    "import sagebrush.nf",
    "for b in (8989697, 10000000, 6683713, 23753194114880, 23753194114881, 11375423353295, 11375423353296):",
    "    st = {s['phase']: s for s in E._call('factor_estimate', bits=b)['stages']}",
    "    print(b, st['prp']['units'], st['prp']['label'], st['roots']['units'], st['roots']['label'])",
    "r = E._factor_record_bits(23753194114881, 'factor_integer')",
    "records.validate(r)",
    "print([(s['work'] and s['work']['label'], s['time'] is None) for s in r['stages'][:4]])",
    "for n in (2**8989696 + 1, 2**(10**7) + 1):",
    "    r = sagebrush.estimate(sagebrush.nf.factor_integer, n)",
    "    records.validate(dict(r))",
    "    print(n.bit_length(), [s['work']['units'] for s in r['stages'] if s['name'].startswith('probable')])",
  ].join("\n");
  const r = spawnSync(process.execPath, [CLI, "-c", code], { encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      "8989697 18446793225993710240 bound 47513286619705088000 bound",
      "10000000 25390952929725000000 bound 66043789099680000000 bound",
      "6683713 7581294184231772928 bound 18447060781041159168 bound",
      "23753194114880 340282366919670981844554008132644298600 bound None unknown",
      "23753194114881 None unknown None unknown",
      "11375423353295 37374560726011974348278361498271622400 bound 340282366920657346910351792021376933888 bound",
      "11375423353296 37374560726015259901665276305702965632 bound None unknown",
      "[('bound', False), (None, True), (None, True), (None, True)]",
      "8989697 [18446793225993710240]",
      "10000001 [25391280472010000672]",
      "",
    ].join("\n"),
  );
});

// Astra's review of PR 2a, EST-PIPELINE: above 1024 bits a perfect power
// and a cofactor that trial division shrinks are factored by the real
// pipeline, and the estimate states those branches conditionally.
test("estimates: above 1024 bits, the branches the pipeline can take are conditional, not a failure", () => {
  const code = [
    "import sagebrush",
    "from sagebrush import records",
    "import sagebrush.nf",
    "q = 2**521 - 1",
    "n = 3**700 * 998244353 * 1000000007",
    "print(sagebrush.nf.factor_integer(q**4) == [(q, 4)], sagebrush.nf.factor_integer(n))",
    "for m in (q**4, n):",
    "    r = sagebrush.estimate(sagebrush.nf.factor_integer, m)",
    "    records.validate(dict(r))",
    "    last = r['stages'][-1]",
    "    print(m.bit_length(), last['name'], last['work'], last['memory']['label'], r['total_time'])",
    "    print(any('only if it is a perfect power' in a for a in r['assumptions']),",
    "          any('is not split' in a for a in r['assumptions']))",
  ].join("\n");
  const r = spawnSync(process.execPath, [CLI, "-c", code], { encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      "True [(3, 700), (998244353, 1), (1000000007, 1)]",
      "2084 Pollard-Brent rho and ECM on a cofactor of at most 1024 bits None bound None",
      "True False",
      "1170 Pollard-Brent rho and ECM on a cofactor of at most 1024 bits None bound None",
      "True False",
      "",
    ].join("\n"),
  );
});

test("%estimate: the outermost call with names or literals; anything else declined, never run", () => {
  const code = [
    "import _pyjs_magic as M",
    "from sagebrush.nf import factor_integer",
    "n = 2**200 + 1",
    "e = M.run_line_magic('estimate', 'factor_integer(n)')",
    "print(e['op'], e['args_summary'])",
    "for line in ('factor_integer(n + 1)', 'factor_integer(int(n))', 'n', 'factor_integer(n=n, n=1)'):",
    "    try:",
    "        M.run_line_magic('estimate', line)",
    "    except Exception as x:",
    "        print(type(x).__name__, str(x)[:40])",
  ].join("\n");
  const r = spawnSync(process.execPath, [CLI, "-c", code], { encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      "factor_integer an integer of 201 bits",
      "UsageError %estimate estimates only the outermost c",
      "UsageError %estimate estimates only the outermost c",
      "UsageError %estimate needs a call, f(args)",
      "UsageError %estimate: keyword argument repeated: n",
      "",
    ].join("\n"),
  );
});

test("Magma's Factorization (a wrapped intrinsic) has the integer estimator", () => {
  const code = [
    "import _magma",
    "import sagebrush",
    "e = sagebrush.estimate(_magma.Factorization, 2**200 + 1)",
    "f = sagebrush.estimate(sagebrush.nf.factor_integer, 2**200 + 1)",
    "print(e['op'], e['args_summary'], len(e['stages']) == len(f['stages']) + 1)",
  ].join("\n");
  const r = spawnSync(process.execPath, [CLI, "-c", code], { encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "Factorization an integer of 201 bits True\n");
});
