// Campaign 3's outcome from its runs' logs (the scale test's trace pass prints one "(campaign: run record …)" line per
// run), by the frozen gate (export-campaign-check.mjs).  A run whose log has no record (it errored or was cut off)
// counts as errored.
//   node web/workspace/export-campaign-outcome.mjs out/run1.log … out/run5.log
import { readFileSync } from "node:fs";
import { outcome } from "./export-campaign-check.mjs";

const runs = process.argv.slice(2).map((f) => {
  const m = /^\(campaign: run record (\{.*\})\)$/m.exec(readFileSync(f, "utf8"));
  if (!m) return { c8: 0, mapped: false, ended: false, errored: true, longTasks: [], majorGc: [], progressGap: 0, heartbeatGap: 0, note: f + ": no run record" };
  const r = JSON.parse(m[1]);
  return { ...r, errored: r.errored || /^FAIL threw/m.test(readFileSync(f, "utf8")) };
});
const o = outcome(runs);
console.log(JSON.stringify({ outcome: o.outcome, reasons: o.reasons, runs: runs.map((r, i) => ({ run: i + 1, c8: r.c8, mapped: r.mapped, ended: r.ended, errored: r.errored, longTasks: r.longTasks, majorGcOver20: (r.majorGc ?? []).filter((g) => g > 20).map((g) => Math.round(g)), progressGap: r.progressGap, heartbeatGap: r.heartbeatGap, note: r.note })) }, null, 1));
