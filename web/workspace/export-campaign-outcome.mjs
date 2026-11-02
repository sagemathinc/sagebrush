// Campaign 3's outcome from its runs' logs (the scale test's trace pass prints one "(campaign: run record …)" line per
// run), by the frozen gate (export-campaign-check.mjs).  r2 (daybreak2's R4, grader's G-2): a log that is missing, has
// no record, says the run wasn't run, or says the runner killed it (a cap or the deadline) counts as an errored run, so
// the outcome is INVALID (or FIX, from what an available measure saw), never a parser error.
//   node web/workspace/export-campaign-outcome.mjs out/run1.log … out/run5.log
import { existsSync, readFileSync } from "node:fs";
import { outcome } from "./export-campaign-check.mjs";

const errored = (note) => ({ c8: 0, mapped: false, ended: false, errored: true, longTasks: [], majorGc: null, progressWrites: 0, progressGap: null, heartbeatGap: null, note });
const runs = process.argv.slice(2).map((f) => {
  if (!existsSync(f)) return errored(f + ": missing");
  const text = readFileSync(f, "utf8");
  const notRun = /^\(campaign: run \d+ not run: (.*)\)$/m.exec(text);
  if (notRun) return errored(f + ": not run: " + notRun[1]);
  const m = /^\(campaign: run record (\{.*\})\)$/m.exec(text);
  const killed = /^\(campaign: run \d+ KILLED at (.*)\)$/m.exec(text);
  if (!m) return errored(f + (killed ? ": killed at " + killed[1] : ": no run record"));
  let r;
  try { r = JSON.parse(m[1]); } catch { return errored(f + ": an unreadable run record"); }
  return { ...r, errored: !!r.errored || !!killed || /^FAIL threw/m.test(text), note: killed ? "killed at " + killed[1] : undefined };
});
const o = outcome(runs);
console.log(JSON.stringify({ outcome: o.outcome, reasons: o.reasons, runs: runs.map((r, i) => ({ run: i + 1, c8: r.c8, mapped: r.mapped, ended: r.ended, errored: r.errored, longTasks: r.longTasks, majorGcOver20: (r.majorGc ?? []).filter((g) => g > 20).map((g) => Math.round(g)), progressWrites: r.progressWrites, progressGap: r.progressGap, heartbeatGap: r.heartbeatGap, note: r.note })) }, null, 1));
