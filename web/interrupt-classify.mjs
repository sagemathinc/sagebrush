// The interrupt matrix's trial classifier (plan-interrupt-harness r4 §1, §1.1, §6.1), shared by
// web/test-interrupt-matrix.mjs and its unit tests (test/interrupt-classify.test.ts).
// A trial: { t_send (harness ms, or undefined), marks: { ENTER, RET, KI: { t, rest } }, stray, probe }.
// Every time is on the harness's own monotonic clock; `rest` of ENTER and KI carry the driver's.
// The Stop bound (William, Oct 27 2026; plan-nocliffs S-delta Stop-250 r4 433ed0cf): a Stop is honoured
// when the public caller's KeyboardInterrupt (or the exit) comes within 250 ms of the request, on the
// harness's raw clock (never a rounded figure).  Later is "honoured late": a FAIL that a baseline entry never
// pins; only one of William's waiver records (web/interrupt-waivers.json) covers it, as WAIVED.  Not at all
// ("did not stop", "no KeyboardInterrupt") is "not honoured", which a baseline entry may pin, as before.
export const STOP_BOUND_MS = 250;
export const POLL_GAP_MS = 100; // §5: recognized this fast, the route polled
// Evidence that can't be judged (a missing, null, string, NaN, infinite or negative time; a malformed XK
// calibration) is INVALID with `malformed`: never a pass, never KNOWN under any baseline signature, never WAIVED
// (astra2 #225 R1).  Every time is validated BEFORE a difference is taken, so nothing is coerced.
export const validTime = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
export const malformed = (why) => ({ outcome: "INVALID", why: "invalid evidence: " + why, malformed: true });
// a request's raw latency against the bound: null when honoured in time, else the cell's FAIL ("late": a finite
// latency past the bound) or, for a latency that is no valid number, the cell's malformed INVALID
export function stopGate(latency, what = "the KeyboardInterrupt") {
  if (typeof latency !== "number" || !Number.isFinite(latency) || latency < 0) return malformed(`no valid latency for ${what} (${latency})`);
  if (latency <= STOP_BOUND_MS) return null;
  return { outcome: "FAIL", why: `honoured late: ${what} came ${latency.toFixed(1)} ms after the Stop, past the ${STOP_BOUND_MS} ms bound`, late: true, latency_raw_ms: latency };
}

// an XK case's cell (r5 §6.2).  xk: { kind: "window", R_ms } (the non-polling call is wrapped:
// XSTART i before it, XEND i after it) or { kind: "bound", T_ms, f } (the Stop at f of T).
export function classifyXK(t, xk) {
  const base = classify(t);
  if (!xk || base.malformed) return base;
  // (an XK calibration that isn't a valid window R or bound T, f can't bound anything: malformed, R1)
  if (xk.kind === "window" && !(validTime(xk.R_ms) && xk.R_ms > 0)) return malformed(`XK window R_ms ${xk.R_ms}`);
  if (xk.kind === "bound" && !(validTime(xk.T_ms) && xk.T_ms > 0 && typeof xk.f === "number" && xk.f >= 0 && xk.f <= 1)) return malformed(`XK bound T_ms ${xk.T_ms}, f ${xk.f}`);
  if (xk.kind === "window") {
    const x = t.marks.XSTART, e = t.marks.XEND;
    const inside = validTime(t.t_send) && x && validTime(x.t) && x.t < t.t_send && !(e && e.t < t.t_send);
    if (!inside) return { ...base, xk_inside: false };
    const bound = xk.R_ms + Math.max(1000, 0.25 * xk.R_ms);
    // (past the window's own bound the call didn't end the wait: never waivable, whatever the latency)
    if (base.late && base.latency_raw_ms > bound) return { ...base, why: `KI past the XK bound (${base.latency_ms} > ${Math.round(bound)} ms)`, past_xk_bound: true, xk_inside: true, xk_bound_ms: Math.round(bound) };
    if (base.outcome !== "PASS") return { ...base, xk_inside: true, xk_bound_ms: Math.round(bound) };
    // (recognized within the poll gap inside the window: the call polls now; past it, within the Stop bound: EXCEPTION)
    return { ...base, outcome: base.latency_raw_ms <= POLL_GAP_MS ? "PASS" : "EXCEPTION", exception: "XK", xk_inside: true, xk_bound_ms: Math.round(bound) };
  }
  if (xk.kind === "bound") {
    const bound = (1 - xk.f) * xk.T_ms + Math.max(1000, 0.25 * xk.T_ms);
    if (base.late && base.latency_raw_ms > bound) return { ...base, why: `KI past the XK bound (${base.latency_ms} > ${Math.round(bound)} ms)`, past_xk_bound: true, xk_bound_ms: Math.round(bound) };
    if (base.outcome !== "PASS") return base;
    return { ...base, outcome: base.latency_raw_ms <= POLL_GAP_MS ? "PASS" : "EXCEPTION", exception: "XK", xk_bound_ms: Math.round(bound) };
  }
  return malformed("an unknown XK kind " + JSON.stringify(xk.kind));
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

// a leak CONTROL row (a case with expect_leak: a deliberate retention per repeat): it PASSes only
// when the heap+external leak check measured a finite growth ABOVE its allowance, with the thread
// count unchanged, no worker outliving its kill, and every cell healthy.  Any other leak.ok = false
// (a thread change alone, the RSS fallback when the host has no heap figure, a malformed result) is
// not the control catching its leak and FAILs, as does a missing series (INCOMPLETE).  (#217,
// astra2 K2: a thread-only failure must not pass the control)
// a row's outcome from its cells and its leak check: an invalid leak result (a sample read from a target already
// exiting before the last repeat, or a sample that couldn't be read) makes the row INVALID, normal or control row
// alike, with the leak's reason; otherwise the control or the normal rule
export function leakRowOutcome(cells, leak, c) {
  if (leak?.invalid) return { outcome: "INVALID", why: leak.why };
  return c.expect_leak ? leakControlOutcome(cells, leak, c.xk) : xkRowOutcome(cells, leak && leak.ok, c.xk);
}

export function leakControlOutcome(cells, leak, xk) {
  if (leak == null) return { outcome: "INCOMPLETE", why: "leak control: the leak series was not measured" };
  if (leak.survived_kill) return { outcome: "FAIL", why: "leak control: a worker survived its kill" };
  if (leak.measure !== "heap+external after gc") return { outcome: "FAIL", why: `leak control: measured by ${leak.measure ?? "nothing"}, not heap+external after gc` };
  if (!Number.isFinite(leak.growth_kb) || !Number.isFinite(leak.allowed_kb)) return { outcome: "FAIL", why: "leak control: a malformed leak result (no finite growth or allowance)" };
  if (leak.threads_same !== true) return { outcome: "FAIL", why: "leak control: the thread count changed (not the control's leak)" };
  if (!(leak.growth_kb > leak.allowed_kb) || leak.ok !== false) return { outcome: "FAIL", why: `leak control: the deliberate leak was NOT caught (growth ${leak.growth_kb} KB, allowed ${leak.allowed_kb} KB)` };
  const r = xkRowOutcome(cells, true, xk);
  return { ...r, why: r.why ?? `leak control: caught (growth ${leak.growth_kb} KB > allowed ${leak.allowed_kb} KB)` };
}

export function classify(t) {
  // a Stop that could not be dispatched (the process gone, EPERM...): the cell is uncovered, never a
  // result, and the error is kept (astra CORR-168-R2-1)
  if (t.send_error) return { outcome: "INVALID", why: "the Stop could not be sent: " + (t.send_error.error ?? t.send_error), send_error: t.send_error };
  // (every marker present, detection diagnostics included, has a valid time before any difference is taken: R1)
  for (const [k, v] of Object.entries(t.marks ?? {})) if (v != null && !validTime(v.t)) return malformed(`the ${k} marker's time ${JSON.stringify(v.t)}`);
  // (the target started and wasn't done, yet no send time was recorded: the harness lost the request)
  if (t.t_send == null) return t.marks.RET ? { outcome: "INVALID", why: "returned before the Stop" } : t.marks.ENTER ? malformed("the target started (ENTER) but no Stop send time was recorded") : { outcome: "INVALID", why: "no Stop sent" };
  if (!validTime(t.t_send)) return malformed(`the Stop's send time ${JSON.stringify(t.t_send)}`);
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
  // (latency_ms is for display; the gate reads latency_raw_ms)
  const r = { latency_ms: Math.round(latency), latency_raw_ms: latency, driver_elapsed_to_ki_s: Number.isFinite(enter) && Number.isFinite(ki) ? +(ki - enter).toFixed(3) : null };
  if (!String(t.probe ?? "").startsWith("ok")) return { outcome: "FAIL", why: "probe " + t.probe, ...r };
  return { ...r, ...(stopGate(latency) ?? { outcome: "PASS" }) };
}

// a (case, host) row from its required cells (r4 §6.1): FAIL, INCOMPLETE, EXCEPTION or PASS.
// cells: [{ outcome }], with every required cell present.  leakOk: false fails the row; null (not
// measured) leaves it INCOMPLETE.  A cell outcome it doesn't know (the retired SLOW, a typo) FAILs.
const CELL_OUTCOMES = new Set(["PASS", "EXCEPTION", "FAIL", "INVALID", "UNCALIBRATED"]);
export function rowOutcome(cells, leakOk = true) {
  if (leakOk === false || cells.some((c) => c.outcome === "FAIL" || !CELL_OUTCOMES.has(c.outcome))) return "FAIL";
  if (leakOk == null || cells.length === 0 || cells.some((c) => c.outcome === "INVALID" || c.outcome === "UNCALIBRATED")) return "INCOMPLETE";
  return cells.some((c) => c.outcome === "EXCEPTION") ? "EXCEPTION" : "PASS";
}

// the heap+external sample (the DONE marker's figure), Python run in the session after each trial: the
// live JS heap after a full collection plus its external memory, SETTLED.  One collection followed by
// an immediate read can still count a previous trial's ArrayBuffer backing stores, which V8 frees after
// the collection (their sweeping), so single readings swung by ~25 MB between two levels, and a series
// whose repeat 3 fell at the lower one read as a 25-28 MB "leak" (M1o: 166.5, 145.5, 145.8, 146.0, 171.7
// MB on master d1af1141; 166.7, 171.1, 143.4, 146.1, 171.8 on #196).  Garbage only ever adds to a
// post-collection figure, so the sample is the least of up to 5 collected readings, 50 ms apart,
// stopping once two agree within 1 MiB: live memory, a real leak included, can't read lower than it is.
// (an indented block: _hu, _he and time come from the program around it; it sets _m)
export const HEAP_EXTERNAL_SAMPLE = `    _m = ""
    try:
        _v = []
        for _k in range(5):
            _a = _hu() if _hu else None
            _b = _he() if (_he and _a is not None) else None
            if _a is None or _b is None:
                break
            _v.append(_a + _b)
            if len(_v) >= 2 and abs(_v[-1] - _v[-2]) < 1048576:
                break
            time.sleep(0.05)
        _m = "%d" % min(_v) if _v else ""
    except Exception:
        _m = ""
`;

// the leak criterion (r4 §6.1): from repeat 3 to the last, each metric grows at most
// max(64 MiB, 10%) and the thread count does not change.  samples: [{ i, rss_kb, threads }], one
// per repeat.  20 repeats is the full check; fewer is the short one (CI), labelled as such.
// Returns null when it can't be measured (fewer than 3 repeats, or no metric).
// measure: "rss" (the process's resident set, /proc), or "heap+external" (a JS-only case: the live
// JS heap plus its external memory after a full collection, mem_kb, which RSS can't tell from the
// garbage of the trials before it; P2a, leak follow-up): growth from repeat 3 against max(16 MiB,
// 10%) of it.  A host without that figure (the browser) is measured by RSS, and says so.
export function leakCheck(samples, full = 20, measure = "rss") {
  // (a final sample read while the target was exiting is dropped, and the result says so; an exiting sample before
  // the last is invalid evidence: the target was going while trials still ran; and so is a sample error)
  const bad = samples.find((x) => x.sample_error);
  if (bad) return { ok: false, invalid: true, why: `the leak sample at repeat ${bad.i} couldn't be read: ${bad.sample_error}`, from: 3, to: samples.at(-1)?.i ?? 0, threads_same: false };
  const exitingAt = samples.findIndex((x) => x.exiting);
  if (exitingAt >= 0 && exitingAt < samples.length - 1) {
    return { ok: false, invalid: true, why: `the target was exiting at repeat ${samples[exitingAt].i}, before the last`, from: 3, to: samples.at(-1)?.i ?? 0, threads_same: false };
  }
  const lastExiting = exitingAt >= 0;
  const dropped = lastExiting ? samples.at(-1) : null;
  if (lastExiting) samples = samples.slice(0, -1);
  const r = leakCheckLive(samples, full, measure);
  return r && lastExiting ? { ...r, last_exiting: true, ...(dropped.why ? { last_exiting_why: dropped.why } : {}) } : r;
}

// A final sample read while the target was shutting down in user space, before the kernel's exit starts: its threads
// already going, with no Z, X or PF_EXITING yet (#251's fake; PR 279's ci 40765663082: threads 7, 7, 7, 7, 3).  The
// final sample is dropped as exiting only if the target itself, bound by its identity, is seen to exit on its own
// within WAIT_SELF_EXIT_MS of that DONE, before any harness kill (the leak final-drop design r2; @sagebrush's D1
// ruling: no END-boundary heuristic, END alone proves nothing).
export const WAIT_SELF_EXIT_MS = 1000;
const posInt = (x) => Number.isSafeInteger(x) && x > 0;
// The final sample is a candidate when every sample is readable and none is exiting (else the rules above apply
// unchanged), the earlier tail (repeats 3 to n-1) is non-empty, and the final thread count is below every count in
// it; all of them positive integers.  null otherwise.
export function finalDropCandidate(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  if (samples.some((x) => !x || typeof x !== "object" || x.sample_error || x.exiting)) return null;
  const last = samples.at(-1);
  const tail = samples.slice(0, -1).filter((x) => x.i >= 3);
  if (!tail.length || !tail.every((x) => posInt(x.threads)) || !posInt(last.threads)) return null;
  const min = Math.min(...tail.map((x) => x.threads));
  if (!(last.threads < min)) return null;
  return { i: last.i, from: min, to: last.threads, t_done: last.t_done, target: last.target ?? null };
}
// The mark: obs = { why: the session's end cause, t_finish: the first finish (before any kill), t_exit: the target's
// own exit as observed before the kill, or null }.  Every candidate gets its final_drop record, marked or not; the
// final sample is marked exiting only for an end of "end" or "exit", an observed own exit, and a valid DONE time with
// 0 <= t_exit - t_done <= WAIT_SELF_EXIT_MS (inclusive; a NaN, an infinity or a negative interval is malformed timing).
export function markFinalShutdown(samples, obs) {
  const c = finalDropCandidate(samples);
  if (!c) return { samples, final_drop: null };
  const why = obs?.why ?? null;
  const dt = validTime(c.t_done) && validTime(obs?.t_exit) ? obs.t_exit - c.t_done : null;
  const fin = validTime(c.t_done) && validTime(obs?.t_finish) ? obs.t_finish - c.t_done : null;
  const marked = (why === "end" || why === "exit") && dt !== null && dt >= 0 && dt <= WAIT_SELF_EXIT_MS;
  const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
  const final_drop = { i: c.i, from: c.from, to: c.to, end_cause: why, end_after_done_ms: r1(dt), finish_after_done_ms: r1(fin), marked };
  if (!marked) return { samples, final_drop };
  const said = `threads falling (${c.from} -> ${c.to}), the target exited on its own ${r1(dt)} ms after its final DONE (end: ${why})`;
  return { samples: [...samples.slice(0, -1), { ...samples.at(-1), exiting: true, why: said }], final_drop };
}
// A session's end, once (grader's N1): a second call while the own-exit wait runs is a no-op that returns false, and
// the kill runs exactly once, after the wait.  deps: now(), candidate() (finalDropCandidate of the samples so far),
// ownExit(candidate, deadline) -> a promise of the own exit's time or null, kill(), settle(why, t_finish, t_exit).
// The wait runs only for a candidate and an end of "end" or "exit", at most until the final DONE + WAIT_SELF_EXIT_MS;
// every other end kills at once, as before.
export function sessionEnd(deps) {
  let done = false;
  return (why) => {
    if (done) return false;
    done = true;
    const t_finish = deps.now();
    const cand = why === "end" || why === "exit" ? deps.candidate() : null;
    if (!cand) {
      // (no candidate: the kill at once, synchronously, exactly as before this change)
      deps.kill();
      deps.settle(why, t_finish, null);
      return true;
    }
    const deadline = validTime(cand.t_done) ? cand.t_done + WAIT_SELF_EXIT_MS : t_finish;
    // (ownExit is asked for every candidate: an own exit already observed counts even when the deadline has passed,
    // and it polls only while the deadline is ahead)
    Promise.resolve().then(() => deps.ownExit(cand, deadline)).catch(() => null).then((t_exit) => {
      deps.kill();
      deps.settle(why, t_finish, validTime(t_exit) ? t_exit : null);
    });
    return true;
  };
}

function leakCheckLive(samples, full, measure) {
  const from = samples.find((x) => x.i === 3), last = samples.at(-1);
  if (!from || !last || last.i <= 3) return null;
  const tail = samples.filter((x) => x.i >= 3);
  const threads = tail.map((x) => x.threads);
  const threadsSame = threads.every((t) => t === threads[0]);
  const base = { check: last.i >= full ? "full" : "short", from: 3, to: last.i, threads_same: threadsSame };
  if (measure === "heap+external" && tail.every((x) => Number.isFinite(x.mem_kb))) {
    const growth_kb = last.mem_kb - from.mem_kb;
    const allowed_kb = Math.max(16 * 1024, 0.1 * from.mem_kb);
    return { ok: growth_kb <= allowed_kb && threadsSame, measure: "heap+external after gc", ...base, growth_kb: Math.round(growth_kb), allowed_kb: Math.round(allowed_kb), series_kb: tail.map((x) => Math.round(x.mem_kb)) };
  }
  if (!Number.isFinite(from.rss_kb) || !Number.isFinite(last.rss_kb)) return null;
  const growth_kb = last.rss_kb - from.rss_kb;
  const allowed_kb = Math.max(64 * 1024, 0.1 * from.rss_kb);
  return { ok: growth_kb <= allowed_kb && threadsSame, measure: measure === "rss" ? "rss" : "rss (no heap+external figure on this host)", ...base, growth_kb, allowed_kb: Math.round(allowed_kb) };
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
  if (row.outcome === "PASS" || row.outcome === "EXCEPTION") return "FIXED";
  // (a Stop honoured late is never KNOWN: only a waiver covers it, withWaiver; nor is a row with invalid evidence)
  if ((row.trials ?? []).some((t) => (t.outcome === "FAIL" && t.late) || t.malformed)) return row.outcome;
  const res = bs.map((b) => new RegExp(b.signature));
  const whys = (row.trials ?? []).filter((t) => t.outcome === "FAIL").map((t) => t.why ?? "");
  return row.outcome === "FAIL" && whys.length > 0 && whys.every((w) => res.some((re) => re.test(w))) ? "KNOWN" : row.outcome;
}

// William's waiver records (web/interrupt-waivers.json): a record covers a FAIL row only when every failing
// cell was honoured late (not past an XK window's own bound; nothing else failed, no leak), and its scope
// is exactly the row's case, host and the case's declared call.  The row is then WAIVED (own_outcome FAIL,
// never counted as a pass); a matching record that has ended leaves it FAIL, saying so.
// the rows that fail a --ci run (the matrix's exit): WAIVED and KNOWN are not among them, INVALID and INCOMPLETE are
export const CI_FAILING = ["FAIL", "FIXED", "INCOMPLETE", "INVALID", "PENDING-READY"];
export const ciFailing = (rows) => rows.filter((r) => CI_FAILING.includes(r.outcome));
export const WAIVER_FIELDS = ["id", "granted", "by", "words", "scope", "owner", "follow_up", "ends_when", "ended"];
export function waiverErrors(records) {
  const errs = [];
  if (!Array.isArray(records)) return ["the registry is not an array"];
  for (const [k, w] of records.entries()) {
    for (const f of WAIVER_FIELDS) if (!w || !(f in w)) errs.push(`record ${k}: no ${f}`);
    if (w && (typeof w.words !== "string" || !w.words.trim())) errs.push(`record ${k}: empty words`);
    if (w && w.by !== "William") errs.push(`record ${k}: not William's (by ${w.by})`);
    if (w && typeof w.ended !== "boolean") errs.push(`record ${k}: ended is not a boolean`);
    if (w && !["case", "host", "call"].every((f) => typeof w.scope?.[f] === "string" && w.scope[f])) errs.push(`record ${k}: scope needs case, host and call`);
  }
  return errs;
}
// (astra2 #225 R2: every required cell present and eligible, PASS, EXCEPTION or the scoped late FAIL, with nothing
// INVALID, UNCALIBRATED or unknown; the leak measured and ok; and each late Stop inside the declared call's window,
// with a valid bound: a declared call binds the case, it doesn't waive another phase of it)
const lateInWindow = (t) => t.outcome === "FAIL" && t.late === true && !t.past_xk_bound && !t.malformed && t.xk_inside === true && Number.isFinite(t.xk_bound_ms) && t.xk_bound_ms > 0 && validTime(t.latency_raw_ms);
// (expected: the row's required cell count, from the caller; a shortened cells array is never inferred complete, S4)
export function withWaiver(row, outcome, waivers, call, expected) {
  if (outcome !== "FAIL" || call == null) return { outcome };
  if (!Number.isInteger(expected) || (row.trials ?? []).length !== expected) return { outcome };
  const w = (waivers ?? []).find((x) => x.scope?.case === row.case && x.scope?.host === row.host && x.scope?.call === call);
  const cells = row.trials ?? [];
  const fails = cells.filter((t) => t.outcome === "FAIL");
  const eligible = cells.length > 0 && cells.every((t) => t.outcome === "PASS" || t.outcome === "EXCEPTION" || lateInWindow(t));
  if (!w || !fails.length || row.leak?.ok !== true || !eligible) return { outcome };
  if (w.ended !== false) return { outcome: "FAIL", why: `waiver ${w.id} ended: remove the record in the fixing change` };
  const late = Math.max(...fails.map((t) => t.latency_raw_ms));
  return { outcome: "WAIVED", waiver: w.id, why: `${fails.length} cell(s) honoured late, at most ${late.toFixed(1)} ms; waived by ${w.id} (William, ${w.granted})` };
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
