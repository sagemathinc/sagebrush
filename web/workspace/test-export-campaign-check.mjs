// The campaign 3 parser and gate (export-campaign-check.mjs) on exact fixtures (grader's and daybreak2's list), and,
// given TRACE=<a saved run record from the scale test's trace pass>, on that real trace as saved and with one
// main-thread MajorGC of 60 ms inserted into its export window: the unmodified trace judged as it was, the mutated one
// failing the GC bound and nothing else.
//   node web/workspace/test-export-campaign-check.mjs [TRACE=file]
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { BOUNDS, judgeRun, majorGcs, maxGap, outcome, pageMainThread, progressSeries } from "./export-campaign-check.mjs";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };

// ---- a minimal trace: the renderer main thread (pid 1, tid 10) and a worker thread (pid 1, tid 20)
// (r6: the page's main thread carries its sb-sync-1 mark, and a MinorGC in the window, as every real run does)
const base = () => [
  { name: "thread_name", ph: "M", pid: 1, tid: 10, args: { name: "CrRendererMain" } },
  { name: "thread_name", ph: "M", pid: 1, tid: 20, args: { name: "DedicatedWorker thread" } },
  { name: "sb-sync-1", ph: "R", cat: "blink.user_timing", pid: 1, tid: 10, ts: 900 * 1000 },
  { name: "sb-sync-2", ph: "R", cat: "blink.user_timing", pid: 1, tid: 10, ts: 9500 * 1000 },
  { name: "MinorGC", ph: "X", pid: 1, tid: 10, ts: 1500 * 1000, dur: 2 * 1000 },
];
const X = (name, tid, tsMs, durMs) => ({ name, ph: "X", pid: 1, tid, ts: tsMs * 1000, dur: durMs * 1000 });
const W = [1000 * 1000, 9000 * 1000]; // the export window, µs
const gcOf = (events) => majorGcs(events, W[0], W[1]);
const runWith = (over) => ({ c8: 120, mapped: true, ended: true, errored: false, longTasks: [], majorGc: [], progressWrites: 50, progressGap: 100, heartbeatGap: 20, ...over });
const gcFails = (events) => judgeRun(runWith({ majorGc: gcOf(events) })).fix.length > 0;

{
  // a main-thread MajorGC of 60 ms inside a task (a RunTask around it)
  const e = [...base(), X("RunTask", 10, 2000, 80), X("MajorGC", 10, 2010, 60)];
  check(gcOf(e).length === 1 && gcOf(e)[0] === 60 && gcFails(e), "a main-thread MajorGC of 60 ms: measured 60, FAILs the bound");
}
{
  const e = [...base(), X("RunTask", 10, 2000, 80), X("MajorGC", 10, 2010, 50)];
  check(gcOf(e)[0] === 50 && !gcFails(e), `a main-thread MajorGC of 50 ms: measured 50, passes (the bound is > ${BOUNDS.majorGcMs})`);
}
{
  const e = [...base(), X("RunTask", 20, 2000, 80), X("MajorGC", 20, 2010, 60)];
  check(gcOf(e).length === 0 && !gcFails(e), "a MajorGC of 60 ms on a worker thread: not counted, passes (main thread only)");
}
{
  // no task around it: the case the Long Task API misses
  const e = [...base(), X("RunTask", 10, 1500, 30), X("MajorGC", 10, 3000, 60)];
  check(gcOf(e)[0] === 60 && gcFails(e), "a main-thread MajorGC of 60 ms outside any task: measured 60, FAILs the bound");
}
{
  const e = [...base(), X("MajorGC", 10, 500, 60), X("MajorGC", 10, 9500, 60)];
  check(gcOf(e).length === 0, "MajorGCs before the click and after the export's end: outside the window, not counted");
}
// ---- r6 (campaign 3's finding; @sagebrush's ruling): the page's main thread, and the GC measure's availability
{
  // (two renderer processes, an idle one named first, as in campaign 3's runs 2 and 3)
  const idleFirst = [{ name: "thread_name", ph: "M", pid: 2, tid: 30, args: { name: "CrRendererMain" } }, ...base(), X("MajorGC", 10, 3000, 60), { name: "MajorGC", ph: "X", pid: 2, tid: 30, ts: 3000 * 1000, dur: 5 * 1000 }];
  const t = pageMainThread(idleFirst);
  check(t && t.pid === 1 && t.tid === 10 && JSON.stringify(gcOf(idleFirst)) === "[60]" && gcFails(idleFirst), "two renderer processes, an idle one named first: the page's thread (by its sb-sync-1 mark) is read, its 60 ms MajorGC measured, FAIL");
  const ambiguous = [...base(), { name: "sb-sync-2", ph: "R", cat: "blink.user_timing", pid: 2, tid: 30, ts: 9600 * 1000 }, X("MajorGC", 10, 3000, 60)];
  check(pageMainThread(ambiguous) === null && gcOf(ambiguous) === null && !judgeRun(runWith({ majorGc: gcOf(ambiguous) })).valid, "the marks on two different threads: the selection ambiguous, the GC measure unavailable, INVALID, never a pass");
  const noMark2 = base().filter((e) => e.name !== "sb-sync-2").concat([X("MajorGC", 10, 3000, 60)]);
  check(gcOf(noMark2) === null, "sb-sync-2 missing: the selection unknown, unavailable");
  const noMark = base().filter((e) => e.name !== "sb-sync-1").concat([X("MajorGC", 10, 3000, 60)]);
  check(gcOf(noMark) === null && !judgeRun(runWith({ majorGc: gcOf(noMark) })).valid, "no sb-sync-1 mark: the page's thread unknown, the GC measure unavailable (null), INVALID, never a pass");
  const noGc = base().filter((e) => e.name !== "MinorGC").concat([X("RunTask", 10, 2000, 10)]);
  const j = judgeRun(runWith({ majorGc: gcOf(noGc) }));
  check(gcOf(noGc) === null && !j.valid && j.fix.length === 0, "the page's thread present but without the expected GC classes (no MinorGC) in the window: unavailable, INVALID, never a pass");
  const minorOutside = base().filter((e) => e.name !== "MinorGC").concat([X("MinorGC", 10, 500, 2)]);
  check(gcOf(minorOutside) === null, "a MinorGC only outside the export window: still unavailable");
}
// ---- r6: campaign 3's five real traces (REAL_TRACES=<dir with run1-…json.gz>), on the page's thread
{
  const dir = process.env.REAL_TRACES;
  if (dir) {
    const { readdirSync } = await import("node:fs");
    const want = { 1: [145.4, 30], 2: [23, 37.3], 3: [146.8, 30.6], 4: [25.4, 33.2, 26.7], 5: [144, 29.1] };
    for (const k of [1, 2, 3, 4, 5]) {
      const f = readdirSync(dir).find((n) => n.startsWith(`run${k}-trace-`));
      const { window: [a, b], events } = JSON.parse(gunzipSync(readFileSync(`${dir}/${f}`)).toString("utf8"));
      const got = majorGcs(events, a, b)?.map((g) => +g.toFixed(1));
      check(JSON.stringify(got) === JSON.stringify(want[k]), `campaign 3's run ${k}, re-read on the page's thread: MajorGC ${JSON.stringify(got)} (expected ${JSON.stringify(want[k])}); available`);
    }
  }
}
// ---- the progress gap (a gate) and the heartbeat (reported only)
{
  const t251 = [0, 200, 451, 600], t250 = [0, 200, 450, 600];
  check(maxGap(t251) === 251 && judgeRun(runWith({ progressGap: maxGap(t251) })).fix.length === 1, "a progress series with a 251 ms gap: measured 251, FAILs");
  check(maxGap(t250) === 250 && judgeRun(runWith({ progressGap: maxGap(t250) })).fix.length === 0, "a progress series with a 250 ms gap: measured 250, passes");
  const hb = [0, 20, 40, 571, 591];
  const j = judgeRun(runWith({ heartbeatGap: maxGap(hb) }));
  check(maxGap(hb) === 531 && j.heartbeatGap === 531 && j.fix.length === 0, "a heartbeat series with a 531 ms gap: reported as 531, and no failure from the heartbeat alone");
}
// ---- r2 (daybreak2's R1, R2): each measure's availability; absent evidence is INVALID, never zero or a pass
{
  check(maxGap([]) === null && maxGap([5]) === null, "a series of zero or one time has no gap (null, not 0)");
  const inv = (over) => { const j = judgeRun(runWith(over)); return !j.valid && j.fix.length === 0; };
  check(inv({ progressWrites: 0, progressGap: null }), "no progress rewrite observed: the run is INVALID, not a pass");
  check(inv({ progressWrites: 1, progressGap: null }), "one progress rewrite observed: INVALID");
  check(inv({ progressWrites: 5, progressGap: 100 }), "five rewrites (the measure not activated: more than 10 needed): INVALID");
  // (r3, grader's V-1: the boundary itself)
  check(inv({ progressWrites: 10, progressGap: 100 }), "exactly 10 rewrites: not activated, INVALID");
  { const j = judgeRun(runWith({ progressWrites: 11, progressGap: 100 })); check(j.valid && j.fix.length === 0, "11 rewrites: activated, valid, no failure"); }
  // (r3, V-2: the handoff ends the series; a stall in the finishing tail is a gap)
  { const rw = Array.from({ length: 21 }, (_, i) => i * 100); const s = progressSeries(rw, 2300); const j = judgeRun(runWith({ progressWrites: rw.length, progressGap: maxGap(s) }));
    check(s.length === 22 && maxGap(s) === 300 && j.fix.length === 1 && /progress gap of 300/.test(j.fix[0]), "rewrites every 100 ms to 2000 ms, the handoff at 2300 ms: the 300 ms finishing-tail stall measured, FIX"); }
  { const rw = Array.from({ length: 21 }, (_, i) => i * 100); const s = progressSeries(rw, 2150); check(maxGap(s) === 150 && judgeRun(runWith({ progressWrites: rw.length, progressGap: maxGap(s) })).fix.length === 0, "the handoff 150 ms after the last rewrite: no failure"); }
  check(progressSeries([0, 100], null).length === 2 && progressSeries([], 500).length === 0, "no handoff: the series as observed; no rewrites: nothing appended (no series)");
  check(judgeRun(runWith({ progressWrites: 5, progressGap: 300 })).fix.length === 1, "five rewrites with a 300 ms gap: FIX (an observed gap over the bound counts, activated or not)");
  check(inv({ mapped: false, majorGc: [70] }), "unmapped with a GC value supplied: not counted (no window), the run INVALID, no FIX");
  check(inv({ mapped: false, majorGc: null }), "unmapped, the GC measure unavailable: INVALID");
  check(inv({ majorGc: null }), "mapped but no main thread in the trace (GC unavailable): INVALID");
  check(judgeRun(runWith({ c8: 40, majorGc: [70] })).fix.length === 1, "C8 void but mapped, a 70 ms MajorGC: FIX");
  check(judgeRun(runWith({ errored: true, majorGc: [70] })).fix.length === 1, "an error after a mapped window with a 70 ms MajorGC: FIX");
  check(outcome([runWith({}), runWith({}), runWith({ progressWrites: 0, progressGap: null }), runWith({}), runWith({})]).outcome === "INVALID", "five runs, one with no progress observed: INVALID");
}
// ---- the outcome's precedence
{
  const ok = () => runWith({});
  check(outcome([ok(), ok(), ok(), ok(), ok()]).outcome === "PASS", "five valid runs within every bound: PASS");
  check(outcome([ok(), ok(), runWith({ majorGc: [51] }), ok(), ok()]).outcome === "FIX", "one MajorGC of 51 ms: FIX");
  check(outcome([ok(), ok(), runWith({ c8: 40, majorGc: [70] }), ok(), ok()]).outcome === "FIX", "a void run with a MajorGC of 70 ms: FIX (over INVALID)");
  check(outcome([ok(), runWith({ longTasks: [{ ms: 60, class: "export" }] }), ok(), ok(), ok()]).outcome === "FIX", "an export-classified task of 60 ms: FIX");
  check(outcome([ok(), runWith({ c8: 40 }), ok(), ok(), ok()]).outcome === "INVALID", "a void run, nothing else: INVALID");
  check(outcome([ok(), runWith({ c8: 40, longTasks: [{ ms: 60, class: "export" }] }), ok(), ok(), ok()]).outcome === "INVALID", "a void run whose 60 ms task is classified export: INVALID (an export finding needs a valid run)");
  check(outcome([ok(), ok(), ok(), ok()]).outcome === "INVALID", "four runs: INVALID");
  check(outcome([ok(), runWith({ longTasks: [{ ms: 60, class: "gc" }] }), ok(), ok(), ok()]).outcome === "INCONCLUSIVE", "a non-export task of 60 ms only: INCONCLUSIVE (fallback (b) may apply)");
  check(outcome([ok(), runWith({ longTasks: [{ ms: 60, class: "page" }], progressGap: 300 }), ok(), ok(), ok()]).outcome === "FIX", "a non-export task with a 300 ms progress gap: FIX (the fallback never waives a progress failure)");
}
// ---- a real saved trace (the liveness trace): read on the page's thread, then with a 60 ms main-thread MajorGC
// inserted into its export window on that thread
const file = process.argv.find((a) => a.startsWith("TRACE="))?.slice(6) ?? process.env.TRACE;
if (file) {
  const rec = JSON.parse(readFileSync(file, "utf8"));
  const { events, window: [from, to], run } = rec;
  const asSaved = majorGcs(events, from, to);
  // (r6: this trace's record came from r5's parser, which read the first CrRendererMain; on the page's own thread (its
  // sb-sync marks) the trace has a 137.6 ms MajorGC that r5 missed, exactly campaign 3's runs 2 and 3)
  const main = pageMainThread(events), firstNamed = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
  check(main && (main.pid !== firstNamed.pid || main.tid !== firstNamed.tid) && JSON.stringify(run.majorGc) === "[]" && JSON.stringify(asSaved?.map((g) => +g.toFixed(1))) === "[137.6,10.6]",
    `the liveness trace on the page's thread (${main?.pid}/${main?.tid}, not the first CrRendererMain ${firstNamed.pid}/${firstNamed.tid}): MajorGC ${JSON.stringify(asSaved?.map((g) => +g.toFixed(1)))}, where r5 recorded ${JSON.stringify(run.majorGc)}`);
  const j0 = judgeRun({ ...run, majorGc: asSaved });
  const mid = Math.round((from + to) / 2);
  const mutated = [...events, { name: "MajorGC", ph: "X", pid: main.pid, tid: main.tid, ts: mid, dur: 60000, cat: "disabled-by-default-v8.gc" }];
  const after = majorGcs(mutated, from, to);
  const j1 = judgeRun({ ...run, majorGc: after });
  check(after.includes(60) && j1.fix.length === j0.fix.length + 1 && j1.fix.some((r) => /MajorGC of 60 ms/.test(r)) && j1.valid === j0.valid,
    "the same trace with a 60 ms MajorGC inserted mid-window on the page's thread: one more GC failure, and nothing else changes: " + j1.fix.join("; "));
}
console.log(`${checks - fails.length}/${checks} passed`);
for (const f of fails) console.log("FAIL " + f);
process.exit(fails.length ? 1 : 0);
