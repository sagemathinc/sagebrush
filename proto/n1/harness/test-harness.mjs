// node --test proto/n1/harness/test-harness.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mainSchedule, controlSchedule, validate, counts, MAIN_LABELS } from "./schedule.mjs";
import { decide, decideWithEscalation, effects, controlRecovered, aaValid } from "./decide.mjs";

test("main schedules meet every balance rule, for many seeds and both OSes", () => {
  for (const os of ["linux", "macos", "windows"]) {
    for (let seed = 0; seed < 300; seed++) {
      const s = mainSchedule(seed, os);
      assert.deepEqual(validate(s), []);
      for (const l of MAIN_LABELS) {
        assert.ok(s.counts.rounds[l].every((x) => x === 1 || x === 2));
        assert.ok(s.counts.escalation[l].every((x) => x === 3 || x === 4));
        assert.ok(s.counts.all21[l].every((x) => x === 5 || x === 6));
      }
    }
  }
});

test("the same seed gives the same schedule; another seed or OS gives another", () => {
  assert.deepEqual(mainSchedule("n1-2026-11-07", "linux"), mainSchedule("n1-2026-11-07", "linux"));
  assert.notDeepEqual(mainSchedule("a", "linux").rounds, mainSchedule("b", "linux").rounds);
  assert.notDeepEqual(mainSchedule("a", "linux").rounds, mainSchedule("a", "macos").rounds);
});

test("the gate refuses schedules that break a rule", () => {
  const s = mainSchedule(1, "linux");
  // the same order 7 times: counts of 7 and 0
  assert.ok(validate({ ...s, rounds: Array(7).fill(["1a", "1b", "2", "3"]) }).length > 0);
  // a repeated label in a round
  assert.ok(validate({ ...s, rounds: [["1a", "1a", "2", "3"], ...s.rounds.slice(1)] }).length > 0);
  // 6 rounds
  assert.ok(validate({ ...s, rounds: s.rounds.slice(1) }).length > 0);
  // an escalation that is balanced alone but not combined: reuse the first 7's leftover pattern
  const badEsc = [...s.escalation];
  badEsc[0] = badEsc[0].slice().reverse();
  const r = validate({ ...s, escalation: badEsc });
  const c14 = counts(badEsc, MAIN_LABELS), c21 = counts([...s.rounds, ...badEsc], MAIN_LABELS);
  const ok14 = MAIN_LABELS.every((l) => c14[l].every((x) => x === 3 || x === 4));
  const ok21 = MAIN_LABELS.every((l) => c21[l].every((x) => x === 5 || x === 6));
  assert.equal(r.length === 0, ok14 && ok21);
});

test("control schedules: 7 rounds, first-position counts 4 and 3", () => {
  for (let seed = 0; seed < 100; seed++) {
    const s = controlSchedule(seed, "linux", "handshake");
    assert.deepEqual(validate(s), []);
    const a = s.counts["1"][0], b = s.counts["1+p"][0];
    assert.deepEqual([a, b].sort(), [3, 4]);
  }
  const s = controlSchedule(1, "linux", "x");
  assert.ok(validate({ ...s, rounds: Array(7).fill(["1", "1+p"]) }).length > 0);
});

const ms = (xc, xb) => ({ xc, xb });
const STARTUP = { rho: 0.15, a: 50 };

test("e_r uses max(a, rho * x_b)", () => {
  // x_b = 100 ms: rho*x_b = 15 < a = 50 -> t = 50
  assert.deepEqual(effects([ms(125, 100)], STARTUP), [0.5]);
  // x_b = 1000 ms: rho*x_b = 150 > 50 -> t = 150
  assert.deepEqual(effects([ms(1300, 1000)], STARTUP), [2]);
  assert.throws(() => effects([ms(1, 1)], { rho: 0, a: 0 }));
  assert.throws(() => effects([ms(NaN, 1)], STARTUP));
});

test("the rule's order: fewer than 5 rounds is undecided before anything else", () => {
  const four = Array(4).fill(ms(100, 100));
  assert.equal(decide(four, STARTUP).status, "undecided");
  assert.equal(decide(Array(5).fill(ms(100, 100)), STARTUP).status, "equivalent");
});

test("equivalent, different (both directions) and undecided", () => {
  assert.equal(decide(Array(7).fill(ms(1100, 1000)), STARTUP).status, "equivalent"); // e = 100/150
  const worse = decide(Array(7).fill(ms(1400, 1000)), STARTUP); // e = 400/150
  assert.equal(worse.status, "different");
  assert.equal(worse.better, "baseline");
  const better = decide(Array(7).fill(ms(600, 1000)), STARTUP);
  assert.equal(better.better, "candidate");
  // one round on the other side: not all one sign -> undecided
  const mixed = [...Array(6).fill(ms(1400, 1000)), ms(990, 1000)];
  assert.equal(decide(mixed, STARTUP).status, "undecided");
  // all one sign but median inside the band -> undecided
  const small = [...Array(4).fill(ms(1050, 1000)), ...Array(3).fill(ms(1400, 1000))];
  assert.equal(decide(small, STARTUP).status, "undecided");
});

test("escalation: decided stays decided; undecided is decided over all 21", () => {
  const decided = Array(7).fill(ms(1400, 1000));
  const r = decideWithEscalation(decided, Array(14).fill(ms(1000, 1000)), STARTUP);
  assert.equal(r.status, "different");
  assert.equal(r.escalated, false);
  const und = [...Array(6).fill(ms(1400, 1000)), ms(990, 1000)];
  assert.equal(decideWithEscalation(und, undefined, STARTUP).needsEscalation, true);
  const after = decideWithEscalation(und, Array(14).fill(ms(1100, 1000)), STARTUP);
  assert.equal(after.escalated, true);
  assert.equal(after.n, 21);
});

test("A/A and control recovery", () => {
  assert.equal(aaValid(Array(7).fill(ms(1010, 1000)), STARTUP), true);
  assert.equal(aaValid(Array(7).fill(ms(1400, 1000)), STARTUP), false);
  assert.equal(controlRecovered([100, 110, 90, 105, 95, 100, 102], 100), true);
  assert.equal(controlRecovered([40, 45, 42, 48, 41, 44, 43], 100), false);
  assert.equal(controlRecovered([4096, 4096], 4096, { exact: true }), true);
  assert.equal(controlRecovered([4096, 4097], 4096, { exact: true }), false);
});
