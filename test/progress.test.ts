import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import * as P from "../src/runtime/progress";

// Live progress (design-estimates-progress r4 §6, §8 "Progress records";
// estimates plan r3, PR 1): the slot layout, claiming and releasing slots,
// nesting, the 33rd call, the seqlock against a full-rate writer, the
// engine's frames copied in its interrupted() import, and the builtin module
// _progress through the CLI.  engine/interrupt/src/progress.rs has the same
// layout and its own tests.
const CLI = __dirname + "/../src/cli.js";

const base = (): P.Slot => ({ ...P.emptySlot(), inUse: true, callId: 7, parentId: 3, generation: 2, op: 1, stage: 4, unit: 3, startedMs: 1_700_000_000_123, stageCount: 0, total: 0 });
const rt = (s: P.Slot) => P.decode(P.encode(s));

test("the layout round-trips every field at 0, at its maximum, at each saturation point and sentinel", () => {
  for (const [done, total] of [[0, 0], [P.SAT53, P.SAT53], [5, null]] as [number, number | null][]) {
    const d = rt({ ...base(), done, total, stageIndex: P.SAT16, stageCount: P.SAT16 });
    assert.deepEqual([d.done, d.total, d.stageIndex, d.stageCount], [done, total, P.SAT16, P.SAT16]);
    assert.ok(!d.doneSaturated && !d.totalSaturated && !d.stageIndexSaturated && !d.stageCountSaturated);
  }
  // saturation never wraps, and a saturated value never looks exact
  const d = rt({ ...base(), done: 2 ** 60, total: 2 ** 63, work: 2 ** 64, stageIndex: 70000, stageCount: P.SAT16 + 1, memoryNowKiB: 2 ** 40 });
  assert.deepEqual([d.done, d.total, d.work, d.stageIndex, d.stageCount, d.memoryNowKiB], [P.SAT53, P.SAT53, P.SAT53, P.SAT16, P.SAT16, 0xffffffff]);
  assert.ok(d.doneSaturated && d.totalSaturated && d.workSaturated && d.stageIndexSaturated && d.stageCountSaturated && d.memorySaturated);
  // sentinels
  const w = P.encode({ ...base(), total: null, stageCount: null });
  assert.deepEqual([w[12], w[13], w[9] >>> 16], [0xffffffff, 0xffffffff, 0xffff]);
  assert.equal(rt(base()).fraction, null);
  for (const [x, y] of [[0, 0], [1, 1], [7, 1], [-1, 0], [0.5, 0.5]]) assert.ok(Math.abs(rt({ ...base(), fraction: x }).fraction! - y) < 1e-9);
  // the reserved words and flag bits 12-31 stay zero
  const all = P.encode({ ...base(), total: null, stageCount: null, fraction: 0.5, beyondForecast: true, earlyPartUntracked: true, done: 2 ** 60, work: 2 ** 60, memoryPeakKiB: 2 ** 40, stageIndex: 2 ** 20 });
  assert.deepEqual([all[22], all[23], all[1] & ~P.F.ALL], [0, 0, 0]);
  assert.deepEqual(P.encode(P.decode(all)), all);
});

test("every flag bit 0-11 alone and together, and a round trip of each", () => {
  const z = (o: Partial<P.Slot>): P.Slot => ({ ...P.emptySlot(), stageCount: 0, total: 0, ...o });
  const alone: [number, P.Slot][] = [
    [P.F.IN_USE, z({ inUse: true })],
    [P.F.TOTAL_UNKNOWN, z({ total: null })],
    [P.F.STAGE_COUNT_UNKNOWN, z({ stageCount: null })],
    [P.F.FRACTION, z({ fraction: 0.25 })],
    [P.F.BEYOND_FORECAST, z({ beyondForecast: true })],
    [P.F.DONE_SATURATED, z({ done: 2 ** 60 })],
    [P.F.WORK_SATURATED, z({ work: P.SAT53 + 1 })],
    [P.F.MEMORY_SATURATED, z({ memoryPeakKiB: 2 ** 33 })],
    [P.F.TOTAL_SATURATED, z({ total: P.SAT53 + 1 })],
    [P.F.EARLY_PART_UNTRACKED, z({ earlyPartUntracked: true })],
    [P.F.STAGE_INDEX_SATURATED, z({ stageIndex: P.SAT16 + 1 })],
    [P.F.STAGE_COUNT_SATURATED, z({ stageCount: P.SAT16 + 1 })],
  ];
  let union = 0;
  for (const [bit, s] of alone) {
    const w = P.encode(s);
    assert.equal(w[1], bit, `flag ${bit} alone`);
    assert.deepEqual(P.encode(P.decode(w)), w);
    union |= bit;
  }
  assert.equal(union, P.F.ALL);
  // an exact 2^53 - 1 against a saturated total; an exact 0xFFFE against a saturated index
  assert.ok(!rt(z({ total: P.SAT53 })).totalSaturated && rt(z({ total: P.SAT53 + 2 })).totalSaturated);
  assert.ok(!rt(z({ stageIndex: P.SAT16 })).stageIndexSaturated && rt(z({ stageIndex: P.SAT16 + 1 })).stageIndexSaturated);
});

test("calls claim slots, nest, and release; the 33rd runs untracked under its own call_id", () => {
  P.setEngineTables({ ops: ["", "factor", "groebner", "python"], stages: [], units: [] });
  assert.deepEqual(P.snapshot(), []);
  const outer = P.begin(1);
  outer.s.done = 5;
  outer.s.total = 10;
  outer.flush();
  const inner = P.begin(3);
  let s = P.snapshot();
  assert.equal(s.length, 2);
  assert.deepEqual(s.map((r) => [r.call_id, r.parent_id, r.op]).sort(), [[outer.id, 0, "factor"], [inner.id, outer.id, "python"]].sort());
  assert.deepEqual(s.find((r) => r.call_id === outer.id).count, { done: 5, total: 10, unit: "", label: "counted" });
  inner.end();
  // 32 live calls, then a 33rd top-level and a 33rd nested call
  const live = Array.from({ length: 31 }, () => P.begin(1));
  assert.equal(P.snapshot().length, 32);
  const top = P.begin(2, 0);
  const nested = P.begin(2);
  s = P.snapshot();
  const un = s.filter((r) => r.status === "untracked");
  assert.deepEqual(un.map((r) => [r.call_id, r.parent_id, r.reason]), [[top.id, 0, P.UNTRACKED_REASON], [nested.id, top.id, P.UNTRACKED_REASON]]);
  assert.ok(un.every((r) => r.count === undefined), "an untracked call never shows another call's counts");
  // a slot freed: the still-running untracked call claims it at its next write
  live.splice(3, 1)[0].end();
  nested.s.done = 1;
  nested.flush();
  const got = P.snapshot().find((r) => r.call_id === nested.id);
  assert.equal(got.status, "running");
  assert.equal(got.early_part_untracked, true);
  // and a new call is admitted once another is released
  live.pop()!.end();
  const fresh = P.begin(1);
  assert.equal(P.snapshot().find((r) => r.call_id === fresh.id)?.status, "running");
  for (const c of [fresh, nested, top, ...live, outer]) c.end();
  assert.deepEqual(P.snapshot(), []);
  assert.equal(P.PROGRESS[P.SLOTS * P.WORDS], 0, "the bitmap is clear");
});

test("released on success, on an error and on an interrupt, in finally", () => {
  for (const fail of [null, new Error("an error"), Object.assign(new Error("interrupted"), { name: "KeyboardInterrupt" })]) {
    const c = P.begin(1);
    try {
      try {
        if (fail) throw fail;
      } finally {
        c.end();
      }
    } catch {
      // expected
    }
    assert.deepEqual(P.snapshot(), []);
  }
});

test("the engine's frames: copied in its import, nested under the caller, ended with the call or its trap", () => {
  const area = new Uint32Array(P.FRAME_WORDS);
  const frame = (d: number, serial: number, done: number) => {
    const w = P.encode({ ...P.emptySlot(), op: 1, stage: 4, done, total: 100, unit: 3, stageCount: 2 });
    w[2] = serial;
    area.set(w, 4 + d * P.WORDS);
  };
  P.setCopyInterval(0);
  try {
    const py = P.begin(3); // a Python routine calls the engine
    area[0] = 1;
    area[2] = 2;
    area[1] = 1;
    frame(0, 11, 0);
    frame(1, 12, 40);
    P.syncFrames(area);
    let s = P.snapshot();
    const e0 = s.find((r) => r.parent_id === py.id && r.op === "factor");
    const e1 = s.find((r) => r.parent_id === e0?.call_id);
    assert.ok(e0 && e1, JSON.stringify(s));
    assert.equal(e1.count.done, 40);
    // the inner frame ends and a new one begins at the same depth
    frame(1, 13, 7);
    area[1]++;
    P.syncFrames(area);
    s = P.snapshot();
    assert.equal(s.length, 3);
    const e2 = s.find((r) => r.parent_id === e0.call_id);
    assert.notEqual(e2.call_id, e1.call_id);
    assert.equal(e2.count.done, 7);
    // a trap: the frames' calls end, and a new generation starts; the caller's stays
    const gen = P.currentGeneration();
    P.endFrames(true);
    assert.equal(P.currentGeneration(), gen + 1);
    assert.deepEqual(P.snapshot().map((r) => r.call_id), [py.id]);
    // an engine without the export (or with another layout version) is ignored
    area[0] = 2;
    P.syncFrames(area);
    P.syncFrames(null);
    assert.deepEqual(P.snapshot().map((r) => r.call_id), [py.id]);
    py.end();
  } finally {
    P.setCopyInterval(250);
  }
});

test("a reader racing a full-rate writer never sees a torn count (the seqlock retries)", async () => {
  const buf = new Int32Array(new SharedArrayBuffer(4 * (P.SLOTS * P.WORDS + 1)));
  const stop = new Int32Array(new SharedArrayBuffer(4));
  const src = `
    const { workerData } = require("node:worker_threads");
    const P = require(${JSON.stringify(require.resolve("../src/runtime/progress"))});
    const [buf, stop] = workerData;
    let v = 2 ** 32 - 16;
    while (!Atomics.load(stop, 0)) {
      v = (v + 2 ** 32 + 1) % 2 ** 53;
      P.store(5, P.encode({ ...P.emptySlot(), inUse: true, done: v, total: v, work: v, stageCount: 0 }), buf);
    }`;
  const w = new Worker(src, { eval: true, workerData: [buf, stop] });
  let seen = 0;
  const t = Date.now();
  while (Date.now() - t < 400) {
    const words = P.read(5, buf);
    if (!words) continue;
    const d = P.decode(words);
    if (!d.inUse) continue;
    assert.equal(d.total, d.done);
    assert.equal(d.work, d.done);
    seen++;
    if (seen % 1000 === 0) await new Promise((r) => setImmediate(r));
  }
  Atomics.store(stop, 0, 1);
  await w.terminate();
  assert.ok(seen > 0);
});

test("Python routines report through _progress; the engine's self-test call shows nested frames", () => {
  const code = [
    "import json, _progress",
    "a = _progress.begin('groebner (python)')",
    "_progress.update(a, json.dumps({'stage': 'pairs', 'done': 3, 'total': None, 'unit': 'pairs'}))",
    "_progress.flush(a)",
    "s = json.loads(_progress.snapshot())",
    "print([(r['op'], r['stage'], r['count']) for r in s])",
    "_progress.end(a)",
    "print(json.loads(_progress.snapshot()))",
    "import _sbengine",
    "print(json.loads(_sbengine.call(json.dumps({'fn': 'progress_selftest', 'depth': 3, 'steps': 2000}))))",
    "print(json.loads(_progress.snapshot()))",
  ].join("\n");
  const r = spawnSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    "[('groebner (python)', 'pairs', {'done': 3, 'unit': 'pairs', 'label': 'counted'})]\n[]\n{'ok': {'steps': 2000, 'calls': 3}}\n[]\n",
  );
});

test("capabilities(): progress only in this build; the later pieces refuse before running", () => {
  const code = [
    "import sagebrush",
    "from sagebrush import records",
    "c = sagebrush.capabilities()",
    "print(c['progress'], sorted(k for k, v in c.items() if v is False))",
    "print(sagebrush.stop_points('factor'))",
    "for name in ('estimate', 'run', 'request_stop', 'resume'):",
    "    try:",
    "        getattr(sagebrush, name)(1)",
    "    except TypeError as e:",
    "        print(e)",
    "for opt in records.LATER_OPTIONS:",
    "    try:",
    "        factor(2^64 + 1, **{opt: 1})",
    "    except TypeError as e:",
    "        print(e)",
    "print(len(sagebrush.progress_snapshot()))",
  ].join("\n");
  const r = spawnSync(process.execPath, [CLI, "--sage", "-c", code], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      "True ['cancel_with_partial', 'checkpoints', 'deadline', 'estimate', 'request_stop', 'resume', 'run', 'work']",
      "[]",
      "sagebrush.estimate is not available in this build",
      "sagebrush.run is not available in this build",
      "sagebrush.request_stop is not available in this build",
      "sagebrush.resume is not available in this build",
      "factor(): deadline= is not available in this build",
      "factor(): work= is not available in this build",
      "factor(): resume= is not available in this build",
      "factor(): checkpoint_every= is not available in this build",
      "factor(): checkpoint_path= is not available in this build",
      "0",
      "",
    ].join("\n"),
  );
});
