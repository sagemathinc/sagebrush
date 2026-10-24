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
// leakOk: false fails the row; null (not measured) leaves it INCOMPLETE.
export function rowOutcome(cells, leakOk = true) {
  if (leakOk === false || cells.some((c) => c.outcome === "FAIL")) return "FAIL";
  if (leakOk == null || cells.length === 0 || cells.some((c) => c.outcome === "INVALID" || c.outcome === "UNCALIBRATED")) return "INCOMPLETE";
  for (const o of ["SLOW", "EXCEPTION"]) if (cells.some((c) => c.outcome === o)) return o;
  return "PASS";
}

// the leak criterion (r4 §6.1): from repeat 3 to the last, each metric grows at most
// max(64 MiB, 10%) and the thread count does not change.  samples: [{ i, rss_kb, threads }], one
// per repeat.  20 repeats is the full check; fewer is the short one (CI), labelled as such.
// Returns null when it can't be measured (fewer than 3 repeats, or no metric).
export function leakCheck(samples, full = 20) {
  const from = samples.find((x) => x.i === 3), last = samples.at(-1);
  if (!from || !last || last.i <= 3 || !Number.isFinite(from.rss_kb) || !Number.isFinite(last.rss_kb)) return null;
  const growth_kb = last.rss_kb - from.rss_kb;
  const allowed_kb = Math.max(64 * 1024, 0.1 * from.rss_kb);
  const threads = samples.filter((x) => x.i >= 3).map((x) => x.threads);
  const threadsSame = threads.every((t) => t === threads[0]);
  return { ok: growth_kb <= allowed_kb && threadsSame, check: last.i >= full ? "full" : "short", from: 3, to: last.i, growth_kb, allowed_kb: Math.round(allowed_kb), threads_same: threadsSame };
}

// a row against the baseline (r4 §6.3): KNOWN if its failure matches the pinned signature, FIXED
// if a baseline row now passes (its entry must go in the same change), else the row's own outcome.
// baseline: the parsed web/interrupt-baseline.json; why: the failing cells' reasons.
export function againstBaseline(row, baseline) {
  const b = (baseline?.entries ?? []).find((e) => e.case === row.case && e.host === row.host);
  if (!b || row.leak?.ok === false) return row.outcome;
  if (row.outcome === "PASS" || row.outcome === "SLOW" || row.outcome === "EXCEPTION") return "FIXED";
  const re = new RegExp(b.signature);
  const whys = (row.trials ?? []).filter((t) => t.outcome === "FAIL").map((t) => t.why ?? "");
  return row.outcome === "FAIL" && whys.length > 0 && whys.every((w) => re.test(w)) ? "KNOWN" : row.outcome;
}
