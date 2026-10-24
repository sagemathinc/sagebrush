// scripts/heap-budget.mjs's arithmetic and verdicts, without measuring
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { budgetProblems, collectMax, median, verdict } from "./heap-budget.mjs";

const MIB = 2 ** 20;
const budget = { toolchain: { node: "24.21.0" }, heap_mib: 96, runs: 3, ceiling: 70 * MIB, collect_floor: 20000 };

test("collectMax rounds the used heap up to a MiB, as lib/_magma.py", () => {
  assert.equal(collectMax(65 * MIB, 96), 31 * 1024);
  assert.equal(collectMax(65 * MIB + 1, 96), 30 * 1024);
  assert.equal(collectMax(68_406_736, 96), 30720);
  assert.equal(collectMax(68_095_424, 96), 31744);
  assert.equal(collectMax(96 * MIB, 96), 0);
  // (never above limit // 2048, nor 10^6)
  assert.equal(collectMax(0, 96), 96 * 512);
  assert.equal(collectMax(0, 4096), 10 ** 6);
});

test("median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2);
});

test("the committed heap-budget.json is usable", () => {
  const b = JSON.parse(readFileSync(new URL("../heap-budget.json", import.meta.url), "utf8"));
  assert.deepEqual(budgetProblems(b), []);
});

test("a ceiling that would leave the tests less than collect_floor is refused", () => {
  assert.deepEqual(budgetProblems(budget), []);
  assert.deepEqual(budgetProblems({ ...budget, ceiling: 76 * MIB }), []);
  assert.match(budgetProblems({ ...budget, ceiling: 76 * MIB + 1 }).join(), /_COLLECT_MAX would be 19456 < collect_floor 20000/);
  assert.match(budgetProblems({ ...budget, ceiling: 96 * MIB }).join(), /not below the 96 MiB heap/);
  assert.match(budgetProblems({ ...budget, runs: 0 }).join(), /runs must be a positive integer/);
  assert.match(budgetProblems({ ...budget, toolchain: {} }).join(), /toolchain.node/);
});

test("verdict: within, at and over the ceiling", () => {
  const s = (used) => ({ used, max: collectMax(used, 96) });
  let v = verdict(budget, [s(68 * MIB), s(69 * MIB), s(68 * MIB + 5)]);
  assert.deepEqual(v.failures, []);
  assert.equal(v.median, 68 * MIB + 5);
  assert.equal(v.max, 69 * MIB);
  assert.equal(v.headroom, MIB);
  // (exactly 68 MiB is 68 MiB; 5 bytes more rounds up to 69)
  assert.deepEqual(v.collect_max, [27 * 1024, 28 * 1024]);
  assert.equal(v.collect_floor_at_ceiling, 26 * 1024);
  assert.deepEqual(verdict(budget, [s(70 * MIB)]).failures, []);
  v = verdict(budget, [s(68 * MIB), s(70 * MIB + 1)]);
  assert.deepEqual(v.failures, [`the load heap ${70 * MIB + 1} > ceiling ${70 * MIB} (+1)`]);
});

test("verdict: a _COLLECT_MAX that disagrees with the formula fails", () => {
  const v = verdict(budget, [{ used: 68 * MIB, max: 12345 }]);
  assert.match(v.failures.join(), /reported _COLLECT_MAX 12345 for used 71303168; expected 28672/);
});
