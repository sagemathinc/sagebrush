// The interrupt matrix's trial classifier (plan-interrupt-harness r4 §1, §1.1, §6.1), shared by
// web/test-interrupt-matrix.mjs and its unit tests (test/interrupt-classify.test.ts).
// A trial: { t_send (harness ms, or undefined), marks: { ENTER, RET, KI: { t, rest } }, stray, probe }.
// Every time is on the harness's own monotonic clock; `rest` of ENTER and KI carry the driver's.
export const SLOW_MS = 10_000;

export function classify(t) {
  if (t.t_send == null) return { outcome: "INVALID", why: t.marks.RET ? "returned before the Stop" : "no Stop sent" };
  // (a KI from before the send is stale, another trial's or the setup's: never a tiny latency)
  if (t.marks.KI && t.marks.KI.t < t.t_send) return { outcome: "INVALID", why: "stale KI before the Stop" };
  if (t.marks.RET) {
    // a return after the Stop, the target running at the send: the route did not stop
    return t.marks.RET.t >= t.t_send
      ? { outcome: "FAIL", why: `did not stop (returned ${Math.round(t.marks.RET.t - t.t_send)} ms after the Stop)` }
      : { outcome: "INVALID", why: "returned before the Stop" };
  }
  if (t.stray && !String(t.stray).startsWith("late")) return { outcome: "INVALID", why: "stray " + t.stray };
  if (!t.marks.KI) return { outcome: "FAIL", why: t.stray ? "KeyboardInterrupt only after the trial (" + t.stray + ")" : "no KeyboardInterrupt" };
  const latency = t.marks.KI.t - t.t_send;
  if (!(latency >= 0)) return { outcome: "FAIL", why: "harness bug: negative latency" };
  const enter = Number(t.marks.ENTER?.rest), ki = Number(t.marks.KI.rest);
  const r = { latency_ms: Math.round(latency), driver_elapsed_to_ki_s: Number.isFinite(enter) && Number.isFinite(ki) ? +(ki - enter).toFixed(3) : null };
  if (!String(t.probe ?? "").startsWith("ok")) return { outcome: "FAIL", why: "probe " + t.probe, ...r };
  return { outcome: latency > SLOW_MS ? "SLOW" : "PASS", ...r };
}

// a (case, host) row from its required cells (r4 §6.1): FAIL, INCOMPLETE, or the worst of
// SLOW / EXCEPTION / PASS.  cells: [{ outcome }], with every required cell present.
export function rowOutcome(cells, leakOk = true) {
  if (!leakOk || cells.some((c) => c.outcome === "FAIL")) return "FAIL";
  if (cells.length === 0 || cells.some((c) => c.outcome === "INVALID" || c.outcome === "UNCALIBRATED")) return "INCOMPLETE";
  for (const o of ["SLOW", "EXCEPTION"]) if (cells.some((c) => c.outcome === o)) return o;
  return "PASS";
}
