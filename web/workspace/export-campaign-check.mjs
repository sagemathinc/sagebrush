// E1 r2a campaign 3's parser and gate (test-only; daybreak2's ruling and grader's fixtures, frozen with the rules):
// what one traced run measured, and the campaign's outcome from five.  Pure functions over Chrome trace events and
// page timestamps, so that test-export-campaign-check.mjs proves them on exact fixtures, and the scale test's trace
// pass uses the same code on real runs.  (r2, daybreak2's R1-R3: each metric's availability is explicit, and absent
// evidence is INVALID, never zero; the progress observer counts only the progress line's own rewrites.)

/** The renderer main thread's events (complete events, ph "X"): the thread named CrRendererMain; null if the trace
 * has no such thread (the measure is then unavailable). */
export function mainThreadEvents(events) {
  const main = events.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
  if (!main) return null;
  return events.filter((e) => e.ph === "X" && e.pid === main.pid && e.tid === main.tid);
}

/** Main-thread MajorGC pauses (ms) that overlap [from, to] (trace µs), in order, whether or not inside a task: the
 * Long Task API doesn't see a collection outside a task, so this doesn't look at tasks at all.  null if the trace has
 * no main thread. */
export function majorGcs(events, from, to) {
  const main = mainThreadEvents(events);
  if (!main) return null;
  return main
    .filter((e) => e.name === "MajorGC" && e.ts < to && e.ts + e.dur > from)
    .sort((a, b) => a.ts - b.ts)
    .map((e) => e.dur / 1000);
}

/** The longest gap (ms) between consecutive times of a series (ms); null for fewer than two (no gap observed). */
export function maxGap(times) {
  if (times.length < 2) return null;
  let g = 0;
  for (let i = 1; i < times.length; i++) g = Math.max(g, times[i] - times[i - 1]);
  return g;
}

/** The hard bounds (daybreak2's ruling): strictly over each is a failure.  The progress measure counts as activated
 * with more than MIN_PROGRESS_WRITES rewrites observed (the resp pass's established requirement). */
export const BOUNDS = { longTaskMs: 50, majorGcMs: 50, progressGapMs: 250 };
export const MIN_PROGRESS_WRITES = 10;

/**
 * The page-side progress observer (r2, daybreak2's R3): the time of every rewrite of the progress line itself.  A
 * mutation counts only if its target is the progress line (a <p> in .sbfprev saying "files and folders · … written"),
 * or a text node in it; a mutation anywhere else, inside the panel or out, is not a rewrite of the line.  One
 * timestamp per observer callback that has such a record.  Source text, evaluated in the page; it pushes to `sink`.
 */
export const PROGRESS_OBSERVER = (sink) => `new MutationObserver((recs) => {
  const now = performance.now();
  for (const r of recs) {
    const t = r.target.nodeType === 3 ? r.target.parentNode : r.target;
    if (t && t.nodeType === 1 && t.tagName === "P" && t.closest(".sbfprev") && / files and folders .* written$/.test(t.textContent)) { ${sink}.push(now); break; }
  }
}).observe(document.body, { subtree: true, childList: true, characterData: true })`;

/**
 * One run's verdict.  `run`: { c8, mapped, ended, errored, longTasks: [{ ms, class }], majorGc: [ms] | null,
 * progressWrites, progressGap: ms | null, heartbeatGap }.  The heartbeat is reported, never a gate.
 * Returns { valid, fix: [reasons], invalid: [reasons], longNonExport: [ms], heartbeatGap }.
 * - majorGc counts only from a mapped window: unmapped, or null, it is unavailable (INVALID, never a FIX or a pass);
 *   available, a pause over 50 ms is FIX whatever else is wrong with the run (C8 void, an error).
 * - progress: a gap observed from at least two rewrites over 250 ms is FIX whatever else is wrong; the measure is
 *   activated only with more than MIN_PROGRESS_WRITES rewrites, else the run is INVALID.
 */
export function judgeRun(run) {
  const gcAvailable = !!run.mapped && Array.isArray(run.majorGc);
  const progressObserved = run.progressGap !== null && run.progressGap !== undefined && (run.progressWrites ?? 0) >= 2;
  const progressActivated = progressObserved && run.progressWrites > MIN_PROGRESS_WRITES;
  const invalid = [];
  if (!(run.c8 >= 100)) invalid.push("C8 void");
  if (!run.mapped) invalid.push("the clock unmapped");
  if (!run.ended) invalid.push("the export didn't end");
  if (run.errored) invalid.push("an error");
  if (!gcAvailable) invalid.push("the GC measure unavailable");
  if (!progressActivated) invalid.push(`the progress measure not activated (${run.progressWrites ?? 0} rewrites observed)`);
  const valid = invalid.length === 0;
  const fix = [];
  // (an export-classified task counts only in a valid run: its class needs the mapping and a valid observer)
  for (const t of run.longTasks ?? []) if (valid && t.ms > BOUNDS.longTaskMs && t.class === "export") fix.push(`an export task of ${t.ms} ms`);
  if (gcAvailable) for (const g of run.majorGc) if (g > BOUNDS.majorGcMs) fix.push(`a main-thread MajorGC of ${g} ms`);
  if (progressObserved && run.progressGap > BOUNDS.progressGapMs) fix.push(`a progress gap of ${run.progressGap} ms`);
  const longNonExport = (run.longTasks ?? []).filter((t) => t.ms > BOUNDS.longTaskMs && t.class !== "export").map((t) => t.ms);
  return { valid, fix, invalid, longNonExport, heartbeatGap: run.heartbeatGap };
}

/**
 * The campaign's outcome from its five runs, in daybreak2's precedence:
 *   FIX if any valid run names export code over 50 ms, or any run has an available main-thread MajorGC over 50 ms or
 *   an observed progress gap over 250 ms;
 *   then INVALID if any run is not valid (C8, an error, unmapped, not ended, a measure unavailable or not activated),
 *   or there aren't exactly five;
 *   PASS if no run has a long task over 50 ms;
 *   else INCONCLUSIVE: valid runs whose only failures are non-export long tasks, where fallback (b) may apply.
 */
export function outcome(runs) {
  const judged = runs.map(judgeRun);
  const fix = judged.flatMap((j, i) => j.fix.map((r) => `run ${i + 1}: ${r}`));
  if (fix.length) return { outcome: "FIX", reasons: fix, judged };
  const invalid = judged.flatMap((j, i) => j.invalid.map((r) => `run ${i + 1}: ${r}`));
  if (runs.length !== 5 || invalid.length) return { outcome: "INVALID", reasons: runs.length !== 5 ? [`${runs.length} runs, not 5`, ...invalid] : invalid, judged };
  const long = judged.flatMap((j, i) => j.longNonExport.map((ms) => `run ${i + 1}: a non-export task of ${ms} ms`));
  if (long.length) return { outcome: "INCONCLUSIVE", reasons: long, judged };
  return { outcome: "PASS", reasons: [], judged };
}
