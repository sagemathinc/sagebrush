import test from "node:test";
import assert from "node:assert/strict";
import { checkParams, checkAnswer, waitForAnswer, writeAnswer, LIVE_MAX_BYTES, LIVE_MAX_POINTS } from "../src/live-data";

// src/live-data.ts, the bridge's closed grammar and its wait (design-data-access r3.1 §1; grader's four edges
// and B6): the parameters' bounds, the answer's, the deadline (an injected clock), a Stop winning over an answer,
// and a late answer reaching no later call.

const buffer = () => new SharedArrayBuffer(8 + LIVE_MAX_BYTES);
const intr = () => new Int32Array(new SharedArrayBuffer(8));

test("the parameters: a closed form, checked to the character", () => {
  assert.deepEqual(checkParams("fred.series_observations", { series_id: "A".repeat(64) }), { params: { series_id: "A".repeat(64) } });
  for (const [op, p] of [
    ["fred.series_observations", { series_id: "A".repeat(65) }],
    ["fred.series_observations", { series_id: "" }],
    ["fred.series_observations", { series_id: "GDP-1" }],
    ["fred.series_observations", { series_id: "GDP", api_key: "x" }],
    ["fred.series_observations", { series_id: "GDP", realtime_start: "2020-01-01" }],
    ["fred.series_observations", { series_id: "GDP", observation_start: "2020-02-30" }],
    ["fred.series_observations", { series_id: "GDP", observation_end: "2020-1-1" }],
    ["fred.series_observations", { series_id: 7 }],
    ["fred.series_observations", Object.assign(Object.create({ series_id: "GDP" }), {})],
    ["fred.series_observations", ["GDP"]],
    ["fred.series", { series_id: "GDP" }],
  ] as [string, unknown][])
    assert.ok("refused" in checkParams(op, p), JSON.stringify(p));
  assert.deepEqual(checkParams("fred.series_observations", { series_id: "GDP", observation_start: "2024-02-29", observation_end: "2024-03-01" }), { params: { series_id: "GDP", observation_start: "2024-02-29", observation_end: "2024-03-01" } });
});

test("the answer: over its bounds, an unknown code or an extra field is unavailable, never part of it", () => {
  const n = LIVE_MAX_POINTS;
  assert.ok("ok" in checkAnswer({ ok: { dates: Array(n).fill("2020-01-01"), values: Array(n).fill(1) } }));
  for (const a of [
    { ok: { dates: Array(n + 1).fill("2020-01-01"), values: Array(n + 1).fill(1) } },
    { ok: { dates: ["2020-01-01"], values: [1], note: "x" } },
    { ok: { dates: ["2020-01-01"], values: [Infinity] } },
    { ok: { dates: ["2020-01-01"], values: ["1"] } },
    { ok: { dates: ["2020-13-01"], values: [1] } },
    { ok: { dates: ["2020-01-01"], values: [] } },
    { error: "teapot" },
    { error: "no_key", detail: "x" },
    null,
    "text",
  ])
    assert.deepEqual(checkAnswer(a), { error: "unavailable" }, JSON.stringify(a)?.slice(0, 80));
  assert.deepEqual(checkAnswer({ error: "no_key" }), { error: "no_key" });
  assert.deepEqual(checkAnswer({ ok: { dates: ["2020-01-01"], values: [null] } }), { ok: { dates: ["2020-01-01"], values: [null] } });
});

test("the wait: an answer, its deadline by an injected clock, a Stop winning, a late answer reaching no later call", () => {
  const b = buffer(), i = intr();
  assert.ok(writeAnswer(b, { error: "no_key" }));
  assert.ok(!writeAnswer(b, { error: "rate_limited" }), "written once");
  assert.deepEqual(waitForAnswer(b, i, 1000), { error: "no_key" });
  // (the deadline: 35 s by the clock it is given, here one that moves 10 s a look)
  let t = 0;
  const clock = () => (t += 10_000);
  const late = buffer();
  assert.deepEqual(waitForAnswer(late, i, 35_000, clock, 1), { error: "timeout" });
  // a late answer, to the timed-out call's buffer, reaches the next call nothing: it waits on its own
  writeAnswer(late, { ok: { dates: ["2020-01-01"], values: [1] } });
  t = 0;
  assert.deepEqual(waitForAnswer(buffer(), i, 35_000, clock, 1), { error: "timeout" });
  // a Stop wins, also over an answer already there
  const stopped = buffer();
  writeAnswer(stopped, { ok: { dates: ["2020-01-01"], values: [1] } });
  Atomics.or(i, 0, 1);
  assert.deepEqual(waitForAnswer(stopped, i, 1000), { error: "interrupted" });
  // a length that isn't in the buffer, or bytes that aren't the closed form: unavailable
  const odd = buffer(), ctl = new Int32Array(odd, 0, 2);
  Atomics.store(ctl, 1, LIVE_MAX_BYTES + 1);
  Atomics.store(ctl, 0, 1);
  assert.deepEqual(waitForAnswer(odd, intr(), 1000), { error: "unavailable" });
  const junk = buffer(), jc = new Int32Array(junk, 0, 2);
  new Uint8Array(junk, 8, 3).set([0x7b, 0xff, 0x7d]);
  Atomics.store(jc, 1, 3);
  Atomics.store(jc, 0, 1);
  assert.deepEqual(waitForAnswer(junk, intr(), 1000), { error: "unavailable" });
});

test("grader's r691 pins: the Gregorian leap rule; an answer too big for its buffer written as unavailable", () => {
  // (C4: a century is a leap year only every 400 years)
  for (const [d, ok] of [["1900-02-29", false], ["2000-02-29", true], ["2100-02-29", false], ["2024-02-29", true], ["2023-02-29", false]] as [string, boolean][])
    assert.equal("params" in checkParams("fred.series_observations", { series_id: "GDP", observation_start: d }), ok, d);
  // (C12: past the buffer, the answer written is unavailable, never a partial one nor an error thrown)
  const small = new SharedArrayBuffer(8 + 30);
  const big = { ok: { dates: Array(5).fill("2020-01-01"), values: Array(5).fill(1) } } as const;
  assert.ok(JSON.stringify(big).length > 30);
  assert.ok(writeAnswer(small, big as any));
  assert.deepEqual(waitForAnswer(small, intr(), 1000), { error: "unavailable" });
});
