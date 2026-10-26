// The interrupt matrix's trial classifier (plan-interrupt-harness r4 §1, §1.1, §6.1), shared by
// web/test-interrupt-matrix.mjs and its unit tests (test/interrupt-classify.test.ts).
// A trial: { t_send (harness ms, or undefined), marks: { ENTER, RET, KI: { t, rest } }, stray, probe }.
// Every time is on the harness's own monotonic clock; `rest` of ENTER and KI carry the driver's.
export const SLOW_MS = 10_000;
export const POLL_GAP_MS = 100; // §5: recognized this fast, the route polled

// an XK case's cell (r5 §6.2).  xk: { kind: "window", R_ms } (the non-polling call is wrapped:
// XSTART i before it, XEND i after it) or { kind: "bound", T_ms, f } (the Stop at f of T).
export function classifyXK(t, xk) {
  const base = classify(t);
  if (!xk) return base;
  if (xk.kind === "window") {
    const x = t.marks.XSTART, e = t.marks.XEND;
    const inside = t.t_send != null && x && x.t < t.t_send && !(e && e.t < t.t_send);
    if (!inside) return { ...base, xk_inside: false };
    const bound = xk.R_ms + Math.max(1000, 0.25 * xk.R_ms);
    if (base.outcome !== "PASS" && base.outcome !== "SLOW") return { ...base, xk_inside: true };
    if (base.latency_ms > bound) return { ...base, outcome: "FAIL", why: `KI past the XK bound (${base.latency_ms} > ${Math.round(bound)} ms)`, xk_inside: true };
    // (recognized within the poll gap inside the window: the call polls now)
    return { ...base, outcome: base.latency_ms <= POLL_GAP_MS ? "PASS" : "EXCEPTION", exception: "XK", xk_inside: true, xk_bound_ms: Math.round(bound) };
  }
  if (xk.kind === "bound") {
    if (base.outcome !== "PASS" && base.outcome !== "SLOW") return base;
    const bound = (1 - xk.f) * xk.T_ms + Math.max(1000, 0.25 * xk.T_ms);
    if (base.latency_ms > bound) return { ...base, outcome: "FAIL", why: `KI past the XK bound (${base.latency_ms} > ${Math.round(bound)} ms)` };
    return { ...base, outcome: base.latency_ms <= POLL_GAP_MS ? "PASS" : "EXCEPTION", exception: "XK", xk_bound_ms: Math.round(bound) };
  }
  return { ...base, outcome: "FAIL", why: "harness bug: unknown XK kind " + xk.kind };
}

// an XK row (r5 §6.2): FAIL / INCOMPLETE as rowOutcome; then EXCEPTION only if the exception was
// exercised (a cell inside the window; for bound, a cell past the poll gap); every cell PASS is a
// stale exception (FIXED: remove the case's xk field with the owner's fix); a window row with no
// cell inside is INCOMPLETE ("XK not exercised").
// a session cell (the matrix's cls): a trial left without RET or KI in a session cut at the run's
// deadline had a shortened guard, so it is INVALID-budget, not a failure to stop; but a Stop that
// could not be sent keeps classify's send_error (and so no baseline allowance), whatever the budget
export function classifyCell(t, xk, phase = null) {
  if (t.budget_cut && !t.send_error && !t.marks.RET && !t.marks.KI) return { outcome: "INVALID", why: "run budget spent: the session was cut at the deadline" };
  const base = classifyXK(t, xk);
  // (a phase case, rank-13 r6 section 3: a Stop counts only once the target's PHASE marker is out;
  // a pass before it tested something else, so it is INVALID; a failure stays one)
  if (phase && t.t_send != null && !t.send_error && !(t.marks.PHASE && t.marks.PHASE.t <= t.t_send) && base.outcome !== "FAIL")
    return { ...base, outcome: "INVALID", why: `the Stop came before the ${phase} phase` };
  return base;
}

export function xkRowOutcome(cells, leakOk, xk) {
  const own = rowOutcome(cells, leakOk);
  if (!xk || own === "FAIL" || own === "INCOMPLETE") return { outcome: own };
  if (cells.some((c) => c.outcome === "EXCEPTION")) return { outcome: "EXCEPTION" };
  if (xk.kind === "window" && !cells.some((c) => c.xk_inside)) return { outcome: "INCOMPLETE", why: "XK not exercised (no Stop landed inside the window)" };
  return { outcome: "FIXED", why: "stale exception: every cell PASS; remove the case's xk field" };
}

export function classify(t) {
  // a Stop that could not be dispatched (the process gone, EPERM...): the cell is uncovered, never a
  // result, and the error is kept (astra CORR-168-R2-1)
  if (t.send_error) return { outcome: "INVALID", why: "the Stop could not be sent: " + (t.send_error.error ?? t.send_error), send_error: t.send_error };
  if (t.t_send == null) return { outcome: "INVALID", why: t.marks.RET ? "returned before the Stop" : "no Stop sent" };
  // (a KI from before the send is stale, another trial's or the setup's: never a tiny latency)
  if (t.marks.KI && t.marks.KI.t < t.t_send) return { outcome: "INVALID", why: "stale KI before the Stop" };
  if (t.marks.RET) {
    // a return after the Stop, the target running at the send: the route did not stop
    return t.marks.RET.t >= t.t_send
      ? { outcome: "FAIL", why: `did not stop (returned ${Math.round(t.marks.RET.t - t.t_send)} ms after the Stop${t.stray ? `; the KeyboardInterrupt came later, deferred to the ${String(t.stray).split(" ")[0]}` : ""})`, ...(t.stray ? { deferred_to: String(t.stray).split(" ")[0] } : {}) }
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
// (a (case, host) can have several entries, e.g. E3a on the prompt: F3 and the F4 cliff; a failure
// is KNOWN if every failing cell matches one of their signatures)
export function againstBaseline(row, baseline) {
  const bs = (baseline?.entries ?? []).filter((e) => e.case === row.case && e.host === row.host);
  // (a row with a failed Stop dispatch never matches a baseline: its cells say nothing about the route)
  if (!bs.length || row.leak?.ok === false || (row.trials ?? []).some((t) => t.send_error)) return row.outcome;
  if (row.outcome === "PASS" || row.outcome === "SLOW" || row.outcome === "EXCEPTION") return "FIXED";
  const res = bs.map((b) => new RegExp(b.signature));
  const whys = (row.trials ?? []).filter((t) => t.outcome === "FAIL").map((t) => t.why ?? "");
  return row.outcome === "FAIL" && whys.length > 0 && whys.every((w) => res.some((re) => re.test(w))) ? "KNOWN" : row.outcome;
}

// a performance cliff between two close calibration sizes (r5 §3; William, Oct 25), proven over
// 100x: two completed samples with T(hi) / T(lo) > 100, or a larger sample past the cap with
// cap / T(lo) > 100 (a timeout proves only cap / T(lo); daybreak2 LIMIT-INT168-1).  Sizes within
// 10% of each other.  Returns the cliff, or null (then the row is uncalibrated, not a finding).
export function cliffOf({ lo, tLo, hi, tHi, capMs }) {
  if (lo == null || hi == null || !(tLo > 0) || hi - lo > 0.1 * hi) return null;
  const ratio = tHi != null ? tHi / tLo : capMs / tLo;
  if (!(ratio > 100)) return null;
  return { from_s: lo, from_ms: tLo, to_s: hi, to_ms: tHi ?? `over the ${capMs} ms cap`, ratio_at_least: Math.floor(ratio) };
}

// the browser's leak criterion (r5 §6.1; astra CORR-168-2): the interpreter worker's identity never
// changes, and both labelled metrics, the workers' JS heap (Runtime.getHeapUsage) and the page's
// total including wasm and ArrayBuffer backing (measureUserAgentSpecificMemory), grow at most
// max(64 MiB, 10%) from repeat 3 to the last.  A required metric missing at either end leaves the
// row unmeasured (null: INCOMPLETE), never PASS.  samples: [{ i, worker_heap, page_total,
// same_worker }] over the repeat series.
export function browserLeak(samples, full = 20) {
  const first = samples.find((x) => x.i === 3), last = samples.at(-1);
  if (!first || !last || last.i <= 3) return null;
  if (samples.some((x) => x.same_worker === false)) return { ok: false, check: "worker identity", why: "the interpreter worker was replaced" };
  const metric = (k) => {
    const a = first[k], b = last[k];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const allowed = Math.max(64 * 1024 * 1024, 0.1 * a);
    return { from: a, to: b, growth: b - a, allowed: Math.round(allowed), ok: b - a <= allowed };
  };
  const worker_heap = metric("worker_heap"), page_total = metric("page_total");
  if (!worker_heap || !page_total) return null;
  return { ok: worker_heap.ok && page_total.ok, check: last.i >= full ? "full" : "short", from: 3, to: last.i, worker_heap, page_total };
}

// a browser trial or setup step that threw (astra CORR-168-6, decision 4): the run budget spent and
// an open dialog are the harness's (INVALID, named); the page not answering with no dialog open is the
// page's (FAIL); anything else is a transport or setup failure (INVALID, its message kept).
export function browserFailure(message, dialogOpen) {
  const m = String(message ?? "");
  if (/run budget spent/.test(m)) return { outcome: "INVALID", why: "run budget spent" };
  if (dialogOpen) return { outcome: "INVALID", why: `a ${dialogOpen.type} dialog is open ("${dialogOpen.message}"), so the page can't answer` };
  if (/no answer in \d+ ms/.test(m)) return { outcome: "FAIL", why: "the page stopped answering, with no dialog open: " + m.slice(0, 200) };
  return { outcome: "INVALID", why: "browser transport: " + m.slice(0, 200) };
}

// a calibration with no size inside the band (r5 §3): the attempt closest to the band within
// [min, 1.5 max], labelled widened, as the regex calibration's doubling step was (astra and
// daybreak2 accepted that one; this one is for them to rule on, PR #168).  On GitHub's runner E2's
// factoring time is 0.37 s at s = 20, 8.6 s at s = 21 and 8.2 s at s = 22 (dispatch 40236353993): no
// integer size lands in [3, 8] s, and a 23x step is not a proven cliff.  null: still uncalibrated.
export function widenedPick(attempts, band) {
  const ok = attempts.filter((a) => Number.isFinite(a.T_ms) && a.T_ms >= band.min && a.T_ms <= 1.5 * band.max);
  if (!ok.length) return null;
  const dist = (a) => (a.T_ms > band.max ? a.T_ms - band.max : 0);
  return ok.reduce((b, a) => (dist(a) < dist(b) ? a : b));
}

// the interpreter's worker among the page's (astra CORR-168-R4-1): in the cross-origin-isolated
// notebook, Python runs in a worker of the /runner/ iframe (RunnerWorker, a blob: URL), reached
// through that iframe's own session; without the runner, a top-level sagebrush-worker.js.  The page's
// top-level sagebrush-analyze.js is the analyzer, never the interpreter.  workers: [{ targetId, url,
// parent }] (parent: the session a worker was attached through, null for the page's own);
// iframes: { sessionId: url }.  Exactly one interpreter, or none (then the heap is unmeasured).
export function workerRoles(workers, iframes) {
  const role = (w) => {
    if (w.parent == null) return /(^|\/)sagebrush-worker\.js(\?|$)/.test(w.url) ? "interpreter" : /(^|\/)sagebrush-analyze\.js(\?|$)/.test(w.url) ? "analyzer" : "other";
    return /\/runner\/(index\.html)?(\?|#|$)/.test(iframes[w.parent] ?? "") ? "interpreter" : "other";
  };
  const out = workers.map((w) => ({ ...w, role: role(w) }));
  const interp = out.filter((w) => w.role === "interpreter");
  return { workers: out, interpreter: interp.length === 1 ? interp[0] : null, why: interp.length === 1 ? null : interp.length === 0 ? "no interpreter worker found" : `${interp.length} interpreter candidates` };
}
