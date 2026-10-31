// E1 r2a campaign 3's parser and gate (test-only; daybreak2's ruling and grader's fixtures, frozen with the rules):
// what one traced run measured, and the campaign's outcome from five.  Pure functions over Chrome trace events and
// page timestamps, so that test-export-campaign-check.mjs proves them on exact fixtures, and the scale test's trace
// pass uses the same code on real runs.

/** The renderer main thread's events (complete events, ph "X"): the thread named CrRendererMain. */
export function mainThreadEvents(events) {
  const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
  if (!main) return [];
  return events.filter((e) => e.ph === "X" && e.pid === main.pid && e.tid === main.tid);
}

/** Main-thread MajorGC pauses (ms) that overlap [from, to] (trace µs), in order, whether or not inside a task: the
 * Long Task API doesn't see a collection outside a task, so this doesn't look at tasks at all. */
export function majorGcs(events, from, to) {
  return mainThreadEvents(events)
    .filter((e) => e.name === "MajorGC" && e.ts < to && e.ts + e.dur > from)
    .sort((a, b) => a.ts - b.ts)
    .map((e) => e.dur / 1000);
}

/** The longest gap (ms) between consecutive times of a series (ms); 0 for fewer than two. */
export function maxGap(times) {
  let g = 0;
  for (let i = 1; i < times.length; i++) g = Math.max(g, times[i] - times[i - 1]);
  return g;
}

/** The hard bounds (daybreak2's ruling): strictly over each is a failure. */
export const BOUNDS = { longTaskMs: 50, majorGcMs: 50, progressGapMs: 250 };

/**
 * One run's verdict.  `run`: { c8, mapped, ended, errored, longTasks: [{ ms, class }], majorGc: [ms],
 * progressGap: ms, heartbeatGap: ms }.  The heartbeat is reported, never a gate.
 * Returns { valid, fix: [reasons], longNonExport: [ms], heartbeatGap }.
 */
export function judgeRun(run) {
  const valid = run.c8 >= 100 && !!run.mapped && !!run.ended && !run.errored;
  const fix = [];
  for (const t of run.longTasks ?? []) if (t.ms > BOUNDS.longTaskMs && t.class === "export") fix.push(`an export task of ${t.ms} ms`);
  for (const g of run.majorGc ?? []) if (g > BOUNDS.majorGcMs) fix.push(`a main-thread MajorGC of ${g} ms`);
  if (run.progressGap > BOUNDS.progressGapMs) fix.push(`a progress gap of ${run.progressGap} ms`);
  const longNonExport = (run.longTasks ?? []).filter((t) => t.ms > BOUNDS.longTaskMs && t.class !== "export").map((t) => t.ms);
  return { valid, fix, longNonExport, heartbeatGap: run.heartbeatGap };
}

/**
 * The campaign's outcome from its five runs, in daybreak2's precedence:
 *   FIX if any run names export code over 50 ms, has a main-thread MajorGC over 50 ms, or a progress gap over 250 ms
 *   (a GC or progress failure counts in any run whose trace was taken, valid or not: the pause happened);
 *   then INVALID if any run is void (C8), errored, unmapped or not ended, or there aren't exactly five;
 *   PASS if no run has a long task over 50 ms;
 *   else INCONCLUSIVE: valid runs whose only failures are non-export long tasks, where fallback (b) may apply.
 */
export function outcome(runs) {
  const judged = runs.map(judgeRun);
  const fix = judged.flatMap((j, i) => j.fix.map((r) => `run ${i + 1}: ${r}`));
  if (fix.length) return { outcome: "FIX", reasons: fix, judged };
  const invalid = judged.map((j, i) => (j.valid ? null : `run ${i + 1}`)).filter(Boolean);
  if (runs.length !== 5 || invalid.length) return { outcome: "INVALID", reasons: runs.length !== 5 ? [`${runs.length} runs, not 5`] : invalid.map((r) => r + " is not valid"), judged };
  const long = judged.flatMap((j, i) => j.longNonExport.map((ms) => `run ${i + 1}: a non-export task of ${ms} ms`));
  if (long.length) return { outcome: "INCONCLUSIVE", reasons: long, judged };
  return { outcome: "PASS", reasons: [], judged };
}
