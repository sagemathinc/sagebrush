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

test("estimate(factor, n) from the real engine: valid, milestones q = p_typical = p_high, nothing summed, under 10 ms", () => {
  const code = [
    "import time, random",
    "import sagebrush",
    "from sagebrush import records",
    "sagebrush.estimate(factor, 2^64 + 1)  # (the first call calibrates)",
    "random.seed(7); expected = [random.random() for _ in range(3)]; random.seed(7)",
    "t = time.perf_counter()",
    "e = sagebrush.estimate(factor, 2^300 + 1)",
    "dt = time.perf_counter() - t",
    "records.validate(dict(e))",
    "print('ms below 10:', dt < 0.010)",
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
  assert.equal(
    r.stdout,
    [
      "ms below 10: True",
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

test("%estimate: the outermost call with names or literals; anything else declined, never run", () => {
  const code = [
    "import _pyjs_magic as M",
    "from sagebrush.nf import factor_integer",
    "n = 2**200 + 1",
    "e = M.run_line_magic('estimate', 'factor_integer(n)')",
    "print(e['op'], e['args_summary'])",
    "for line in ('factor_integer(n + 1)', 'factor_integer(int(n))', 'n'):",
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
      "",
    ].join("\n"),
  );
});

test("Magma's Estimate(f, args): the same record as sagebrush.estimate", () => {
  const code = [
    "import _magma",
    "import sagebrush",
    "e = _magma.Estimate(_magma.Factorization, [2**200 + 1])",
    "s = sagebrush.estimate(_magma.Factorization, 2**200 + 1)",
    "print(e['op'], e['args_summary'], [x['name'] for x in e['stages']] == [x['name'] for x in s['stages']])",
  ].join("\n");
  const r = spawnSync(process.execPath, [CLI, "-c", code], { encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "Factorization an integer of 201 bits True\n");
});
