// The deterministic verifier for vm-content-runs.mjs's frozen reports (#18's VM evidence).  It judges a report from
// what it recorded, against an expectation chosen on the command line, never one read from the report itself
// (daybreak3's TEST-PRIVATE18-VERIFY-1..3, astra3's pre-check):
//   node web/cloud/lti/vm-content-verify.mjs mix:success r1.json mix:failing r2.json barrier:30min r3.json recovery:4020000 r4.json
// Exit 0 only if at least one report was given and every one passes; each failure is listed.
import { readFileSync } from "node:fs";

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const nonneg = (x) => finite(x) && x >= 0;
const count = (x) => Number.isSafeInteger(x) && x >= 0;
const ms = (t) => (typeof t === "string" ? Date.parse(t) : NaN);

// (a duration recorded on the monotonic clock may differ from its own wall timestamps' by at most this: the two
// clocks' recording skew; nothing in a run's own timing is allowed this much)
export const TIMESTAMP_TOLERANCE_S = 2;

/**
 * The measured workload loop (astra3's TEST-PRIVATE18-VERIFY-4): `body.started`/`body.finished` are the wall times
 * taken immediately around the loop, `body.duration_s` its monotonic elapsed time. The duration must be finite,
 * non-negative, within TIMESTAMP_TOLERANCE_S of the loop's own timestamps, inside the run's outer timestamps (setup
 * before, teardown after), and in [min_s, max_s]: setup never counts toward the workload.
 */
function loopOk(r, body, minS, maxS, f) {
  const a = ms(body.started), b = ms(body.finished), A = ms(r.started), B = ms(r.finished), d = body.duration_s;
  if (![a, b, A, B].every(Number.isFinite)) return f.push(`the loop's or the run's timestamps are missing or malformed (${JSON.stringify({ loop: [body.started, body.finished], run: [r.started, r.finished] })})`);
  if (!nonneg(d)) return f.push(`the loop's duration ${d} is not a finite non-negative number`);
  if (!(Math.abs(d - (b - a) / 1000) <= TIMESTAMP_TOLERANCE_S)) f.push(`the loop's duration ${d} s differs from its timestamps' ${(b - a) / 1000} s by more than ${TIMESTAMP_TOLERANCE_S} s`);
  if (!(A <= a && a <= b && b <= B)) f.push("the loop does not lie within the run's own timestamps");
  if (!(d >= minS)) f.push(`the loop ran ${d} s, not ≥ ${minS} s`);
  if (!(d <= maxS)) f.push(`the loop ran ${d} s, more than ${maxS} s for its configuration`);
}

/** The probe every run starts with: successful, at the rate the runs were sized for. */
function probeOk(r, f) {
  if (!(r.probe && r.probe.ok === true && r.probe.R === 29)) f.push(`probe not ok at R = 29 (${JSON.stringify(r.probe)})`);
}

const MIX_WANT = { success: "200", failing: "404:no_bundle", uncertain: "503:uncertain" };
// (the owners each kind's runner spreads its calls over: one for uncertain, so its binding bucket is R / 3)
const MIX_OWNERS = { success: 32, failing: 32, uncertain: 1 };
// (the loop's last operations may still be in flight at its end: each is bounded by its call and resolution deadlines)
const MIX_TAIL_S = 120;

/**
 * A sustained mix: the expected kind exactly, with that kind's exact owner count and R = 29 as configured; a configured
 * duration ≥ 600 s, and the measured loop at least that long (and at most MIX_TAIL_S longer); the invocation matching
 * both; integer counts with ops their exact sum; only the kind's one definitive outcome and 429:rate; saturated
 * (429:rate seen, the binding bucket ≥ 90 % used over the measured loop); the final unresolved count recorded and 0.
 */
export function verifyMix(r, kind) {
  const f = [];
  const m = r.mix;
  if (r.mode !== "mix" || !m) return ["not a mix report"];
  if (!Object.hasOwn(MIX_WANT, kind)) return [`unknown expected kind ${kind}`];
  if (m.kind !== kind) f.push(`kind ${m.kind}, expected ${kind}`);
  probeOk(r, f);
  if (m.R !== 29) f.push(`the mix's R ${JSON.stringify(m.R)}, not 29`);
  const owners = MIX_OWNERS[kind];
  if (m.owners !== owners) f.push(`owners ${JSON.stringify(m.owners)}, expected exactly ${owners} for ${kind}`);
  const configured = finite(m.seconds) && m.seconds >= 600;
  if (!configured) f.push(`configured seconds ${JSON.stringify(m.seconds)}, not ≥ 600`);
  if (m.invocation !== `vm-content-runs.mjs mix ${m.seconds} ${kind}`) f.push(`invocation ${JSON.stringify(m.invocation)} doesn't match ${m.seconds} s of ${kind}`);
  loopOk(r, m, configured ? m.seconds : 600, (configured ? m.seconds : 600) + MIX_TAIL_S, f);
  const codes = m.codes ?? {};
  const want = MIX_WANT[kind];
  let sum = 0;
  for (const [code, n] of Object.entries(codes)) {
    if (!count(n)) f.push(`count ${code} = ${n} is not a non-negative integer`);
    sum += n;
    if (code !== want && code !== "429:rate") f.push(`outcome ${code} × ${n}`);
  }
  if (!(count(m.ops) && m.ops === sum)) f.push(`ops ${m.ops} ≠ the sum of the codes ${sum}`);
  if (!(codes[want] > 0)) f.push(`no ${want} outcome`);
  if (!(codes["429:rate"] > 0)) f.push("never saturated: no 429:rate");
  const bucket = owners === 1 ? 29 / 3 : 29;
  const calls = (2 * (codes[want] ?? 0)) / Math.max(nonneg(m.duration_s) ? m.duration_s : 0, 1);
  if (!(calls >= 0.9 * bucket)) f.push(`${calls.toFixed(2)} calls/s over the loop, below 90 % of the binding bucket ${bucket.toFixed(2)}`);
  if (m.pending !== 0) f.push(`final unresolved count ${m.pending} (must be recorded, and 0)`);
  return f;
}

// (each profile: its gate-minutes, the gate clock's speed, the one invocation that runs it, and how far past its end
// the loop's last iteration (≤ 10 s of sleep, then one issue) may run; compressed: CI's run on a ×30 gate clock,
// 30 gate-minutes in 60 s of real time)
const PROFILES = {
  "30min": { minutes: 30, scale: 1, invocation: "vm-content-runs.mjs barrier 30", tail_s: 120 },
  "6h": { minutes: 360, scale: 1, invocation: "vm-content-runs.mjs barrier 360", tail_s: 120 },
  compressed30: { minutes: 30, scale: 30, invocation: "test-content.mjs barrier compressed30", tail_s: 10 },
};

/**
 * The barrier (D4 r3), for a profile chosen outside the report: the body's minutes and invocation exactly the
 * profile's; the measured loop (its duration within TIMESTAMP_TOLERANCE_S of its own timestamps) at least the
 * profile's real time and at most its tail beyond (daybreak3's TEST-PRIVATE18-VERIFY-2-R2); every attempt
 * inspected; done or postponed only; attempt exactly 1 or 2; each second attempt paired with its postponed first by
 * the same due time; for a done attempt: finite non-negative timings, due → sent ≤ 135.1 s and due → end ≤ 197.2 s
 * plus its own alarms' firing delays, decision → end ≤ 125.2 s, protected ≤ 64.2 s, exactly one timed transaction
 * for a first attempt and two for a second, each ≤ 1 s; at least one checkpoint per 10 min less one.
 */
export function verifyBarrier(r, profile) {
  const f = [];
  const b = r.barrier;
  if (r.mode !== "barrier" || !b || !Array.isArray(b.history)) return ["not a barrier report with a history"];
  const P = Object.hasOwn(PROFILES, profile) ? PROFILES[profile] : null;
  if (!P) return [`unknown profile ${profile}`];
  const minutes = P.minutes;
  probeOk(r, f);
  if (b.minutes !== minutes) f.push(`the body's minutes ${JSON.stringify(b.minutes)}, not the profile's ${minutes}`);
  if (b.invocation !== P.invocation) f.push(`invocation ${JSON.stringify(b.invocation)}, not ${JSON.stringify(P.invocation)}`);
  const real = (minutes * 60) / P.scale;
  loopOk(r, b, real, real + P.tail_s, f);
  const h = b.history;
  let done = 0;
  for (let i = 0; i < h.length; i++) {
    const a = h[i];
    if (a.attempt !== 1 && a.attempt !== 2) f.push(`attempt ${i}: attempt number ${a.attempt}`);
    if (!nonneg(a.due_at)) f.push(`attempt ${i}: no due time`);
    if (!nonneg(a.fire_delay_ms)) f.push(`attempt ${i}: firing delay ${a.fire_delay_ms}`);
    if (a.outcome === "postponed") {
      if (a.attempt !== 1) f.push(`attempt ${i}: a postponed attempt ${a.attempt}`);
      continue;
    }
    if (a.outcome !== "done") {
      f.push(`attempt ${i}: outcome ${a.outcome} (${JSON.stringify(a)})`);
      continue;
    }
    done++;
    const prev = a.attempt === 2 ? h[i - 1] : null;
    if (a.attempt === 2 && !(prev && prev.outcome === "postponed" && prev.attempt === 1 && prev.due_at === a.due_at)) f.push(`attempt ${i}: a second attempt not paired with its postponed first (same due time)`);
    const fd = (prev?.fire_delay_ms ?? 0) + a.fire_delay_ms;
    for (const k of ["due_to_sent_ms", "due_to_end_ms", "decision_to_end_ms", "protected_ms"]) if (!nonneg(a[k])) f.push(`attempt ${i}: ${k} ${a[k]}`);
    if (!(a.due_to_sent_ms <= 135_100 + fd)) f.push(`attempt ${i}: due → sent ${a.due_to_sent_ms} ms > 135.1 s + ${fd}`);
    if (!(a.due_to_end_ms <= 197_200 + fd)) f.push(`attempt ${i}: due → end ${a.due_to_end_ms} ms > 197.2 s + ${fd}`);
    if (!(a.decision_to_end_ms <= 125_200)) f.push(`attempt ${i}: decision → end ${a.decision_to_end_ms} ms > 125.2 s`);
    if (!(a.protected_ms <= 64_200)) f.push(`attempt ${i}: protected ${a.protected_ms} ms > 64.2 s`);
    const tx = a.txn_ms;
    const want = a.attempt === 2 ? 2 : 1;
    if (!(Array.isArray(tx) && tx.length === want && tx.every((t) => nonneg(t) && t <= 1000))) f.push(`attempt ${i}: transactions ${JSON.stringify(tx)}, want ${want} each ≤ 1,000 ms`);
    if (a.sent !== true) f.push(`attempt ${i}: done but not sent`);
  }
  if (!(done >= Math.floor(minutes / 10) - 1 && done >= 1)) f.push(`only ${done} checkpoints in ${minutes} min`);
  return f;
}

/**
 * Recovery at the size chosen outside the report: exactly that many keys, half restored and half orphans; integer
 * counters; a non-empty wake history of exactly `wakes` records, each ok and within the recovery table (rows read
 * per D3); ≤ the proportional wake bound; every restored row seen; every orphan deleted; the sample empty.
 */
export function verifyRecovery(r, keys) {
  const f = [];
  const v = r.recovery;
  if (r.mode !== "recovery" || !v) return ["not a recovery report"];
  if (!(Number.isSafeInteger(keys) && keys > 0 && keys % 2 === 0)) return [`bad expected key count ${keys}`];
  probeOk(r, f);
  if (v.keys !== keys) f.push(`keys ${v.keys}, expected ${keys}`);
  const N = keys / 2;
  for (const k of ["wakes", "seen", "deleted", "orphan_sample", "orphan_sample_left"]) if (!count(v[k])) f.push(`${k} ${v[k]} is not a non-negative integer`);
  const w = v.per_wake;
  if (!(Array.isArray(w) && w.length >= 1 && w.length === v.wakes)) f.push(`the wake history has ${w?.length} records for ${v.wakes} wakes`);
  if (!(v.wakes <= Math.ceil((103 * keys) / 4_020_000))) f.push(`${v.wakes} wakes > the proportional bound`);
  if (v.seen !== N) f.push(`seen ${v.seen} of ${N}`);
  if (v.deleted !== N) f.push(`deleted ${v.deleted} of ${N}`);
  if (!(v.orphan_sample >= 1 && v.orphan_sample_left === 0)) f.push(`orphan sample ${v.orphan_sample_left} left of ${v.orphan_sample}`);
  // (the recovery table, D3 r2: the chain prune's +1 read and +1 written per write in steady state)
  const T = { d1_calls: 101, statements: 214, rows_read: 287_296, rows_written: 43_196, r2_calls: 90, keys_listed: 40_000, max_page_read: 7_006 };
  for (const [i, x] of (w ?? []).entries()) {
    if (x.outcome !== "ok") f.push(`wake ${i}: outcome ${x.outcome}`);
    for (const [k, max] of Object.entries(T)) if (!(count(x[k]) && x[k] <= max)) f.push(`wake ${i}: ${k} ${x[k]} > ${max}`);
  }
  if ((w ?? []).reduce((a, x) => a + (x.keys_listed ?? 0), 0) < keys) f.push("the wakes listed fewer keys than the population");
  // (the run-3 rulings: the run's own fail-closed record, its two raw cut checks at the checkpoint, the raw runbook
  // results, and the final state)
  if (r.failed) f.push(`the run recorded a failure: ${JSON.stringify(r.failed).slice(0, 300)}`);
  const cc = r.cut_checks;
  const k = r.runbook?.checkpoint?.k;
  if (!(Array.isArray(cc) && cc.length === 2 && cc[0]?.label === "post-pause" && cc[1]?.label === "pre-marker")) f.push("the two cut checks (post-pause, pre-marker) are not both recorded");
  for (const c of cc ?? []) {
    if (!(c.ok === true && Number.isSafeInteger(k) && c.k === k && c.d1_head === k && c.d1_rows_above_k === 0 && c.next_seq === k + 1 && c.mode === "paused" && c.held === N)) f.push(`cut check ${c.label}: not at the checkpoint (${JSON.stringify({ ok: c.ok, k: c.k, head: c.d1_head, above: c.d1_rows_above_k, next_seq: c.next_seq, mode: c.mode, held: c.held })})`);
  }
  if (cc?.[0] && cc[0].objects !== N) f.push(`post-pause objects ${cc[0].objects}, not ${N}`);
  if (cc?.[1] && cc[1].objects !== keys) f.push(`pre-marker objects ${cc[1].objects}, not ${keys}`);
  const rb = r.runbook ?? {};
  if (!(rb.checkpoint?.outcome === "done" && rb.pause?.mode === "paused" && rb.quiet?.quiet === true && rb.marker?.ok === true && rb.recover?.ok === true && rb.recover.recovery_id === v.valid_cycle && rb.resume?.ok === true)) f.push(`the runbook's raw results don't all pass (${JSON.stringify({ checkpoint: rb.checkpoint?.outcome, pause: rb.pause?.mode, quiet: rb.quiet?.quiet, marker: rb.marker?.ok, recover: rb.recover, valid_cycle: v.valid_cycle, resume: rb.resume?.ok })})`);
  const fs = r.final_state;
  if (!(fs && fs.mode === "normal" && fs.calls === 0 && fs.tickets === 0 && fs.intents === 0 && fs.held === N && fs.objects === N && fs.seen === N)) f.push(`final state ${JSON.stringify(fs)}`);
  return f;
}

const TIMER_KINDS = ["sleep", "deadline", "budget"];
// (floating-point reconciliation of recorded values, real ms; nothing measured is allowed this much)
const RECONCILE_MS = 0.01;

/**
 * The scaled-clock lateness accounting (#18: astra3's and daybreak3's timing rulings): a DIAGNOSTIC, never a pass
 * condition. The bounds stay raw. From one checkpoint result's own timer records (each deliberate timer the checkpoint
 * itself awaited) and its phase marks:
 * - every record valid: a known kind; finite non-negative values; monotonic order schedule ≤ fire ≤ resumption; the
 *   elapsed, overshoot and unit conversions reconciling with its own stamps; a timer that won must have fired, one
 *   whose work won must not have, and a sleep always wins;
 * - the records pairwise disjoint in monotonic time (each awaited after the last resumed): an interval is never
 *   counted twice;
 * - per phase (interval t0 → end, decision → end, protected start → end): only the records wholly inside it, their
 *   overshoot in gate units summed; adjusted = raw − that sum, which must not go below zero.
 * Nothing else is subtracted: D1 work, a timer whose work won, the gate's own synchronous work, unattributed pauses.
 */
export function timerAccounting(c) {
  const f = [];
  const T = c?.timers, M = c?.marks;
  if (!Array.isArray(T) || !M || typeof M !== "object") return { failures: ["no timer records or phase marks"], phases: {} };
  const NUM = ["requested_gate_ms", "scale", "requested_real_ms", "sched_mono", "resumed_mono", "elapsed_real_ms", "overshoot_real_ms", "overshoot_gate_ms", "sched_wall", "sched_gate", "resumed_gate"];
  T.forEach((t, i) => {
    if (!TIMER_KINDS.includes(t?.kind)) return f.push(`timer ${i}: kind ${t?.kind}`);
    for (const k of NUM) if (!nonneg(t[k])) f.push(`timer ${i}: ${k} ${t[k]} is not finite and non-negative`);
    if (!(t.scale > 0)) f.push(`timer ${i}: scale ${t.scale}`);
    if (t.won !== "timer" && t.won !== "work") f.push(`timer ${i}: won ${t.won}`);
    if (t.kind === "sleep" && t.won !== "timer") f.push(`timer ${i}: a sleep not won by its timer`);
    if (t.won === "timer" && t.fired_mono === null) f.push(`timer ${i}: won by its timer, which never fired`);
    if (t.won === "work" && t.fired_mono !== null) f.push(`timer ${i}: its work won, but its timer fired`);
    if (t.fired_mono !== null && !(nonneg(t.fired_mono) && t.sched_mono <= t.fired_mono && t.fired_mono <= t.resumed_mono)) f.push(`timer ${i}: fired ${t.fired_mono} outside [${t.sched_mono}, ${t.resumed_mono}]`);
    if (!(t.sched_mono <= t.resumed_mono)) f.push(`timer ${i}: resumed before it was scheduled`);
    if (!(Math.abs(t.elapsed_real_ms - (t.resumed_mono - t.sched_mono)) <= RECONCILE_MS)) f.push(`timer ${i}: elapsed ${t.elapsed_real_ms} ≠ resumed − scheduled`);
    const over = t.won === "timer" ? Math.max(0, t.elapsed_real_ms - t.requested_real_ms) : 0;
    if (!(Math.abs(over - t.overshoot_real_ms) <= RECONCILE_MS)) f.push(`timer ${i}: overshoot ${t.overshoot_real_ms} ≠ ${over}`);
    if (t.virtual) {
      // (on the virtual clock a sleep has no real duration, and no timer moves the gate clock: no gate overshoot; a call's
      // deadline is still a real timer, with its real duration)
      if ((t.kind === "sleep" && t.requested_real_ms !== 0) || t.overshoot_gate_ms !== 0) f.push(`timer ${i}: a virtual-clock sleep with real duration, or a virtual-clock gate overshoot`);
    } else {
      if (!(Math.abs(t.requested_gate_ms - t.requested_real_ms * t.scale) <= RECONCILE_MS * t.scale)) f.push(`timer ${i}: requested ${t.requested_gate_ms} gate-ms ≠ ${t.requested_real_ms} real ms × ${t.scale}`);
      if (!(Math.abs(t.overshoot_gate_ms - t.overshoot_real_ms * t.scale) <= RECONCILE_MS * t.scale)) f.push(`timer ${i}: gate overshoot ${t.overshoot_gate_ms} ≠ real overshoot × scale`);
    }
  });
  const sorted = [...T].sort((a, b) => a.sched_mono - b.sched_mono);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].sched_mono < sorted[i - 1].resumed_mono) f.push(`timers overlap at ${sorted[i].sched_mono} (counted once only if disjoint)`);
  const PHASES = { interval: ["t0", "end", "interval_ms"], decision: ["decision", "end", "decision_to_end_ms"], protected: ["start", "end", "protected_ms"] };
  const phases = {};
  for (const [name, [from, to, rawKey]] of Object.entries(PHASES)) {
    if (!M[from] || !M[to] || !nonneg(c[rawKey])) continue;
    if (!(nonneg(M[from].mono) && nonneg(M[to].mono) && M[from].mono <= M[to].mono)) {
      f.push(`phase ${name}: marks ${JSON.stringify([M[from], M[to]])}`);
      continue;
    }
    const inside = T.filter((t) => t.sched_mono >= M[from].mono && t.resumed_mono <= M[to].mono);
    const overshoot = inside.reduce((a, t) => a + t.overshoot_gate_ms, 0);
    const adjusted = c[rawKey] - overshoot;
    if (!(adjusted >= 0)) f.push(`phase ${name}: adjusted ${adjusted} < 0 (raw ${c[rawKey]}, overshoot ${overshoot})`);
    phases[name] = { raw_ms: c[rawKey], overshoot_ms: overshoot, adjusted_ms: adjusted, timers: inside.length };
  }
  return { failures: f, phases };
}

/** The requested gate durations of a checkpoint's two quiet gaps, from its own records (both must lie in [2000, 2100]). */
export function requestedGaps(c) {
  return (c?.timers ?? []).filter((t) => t.kind === "sleep" && t.label === "gap").map((t) => t.requested_gate_ms);
}

// D4 r3's raw bound on the protected part, with no slack (CORR-PRIVATE18-TIMING-1, -2: the strict 64,200 everywhere)
export const PROTECTED_MAX_MS = 64_200;

/**
 * The raw D4 r3 checks of one worst-case checkpoint (its call and its tombstone held past the deadline), shared by the
 * ×10 CI case and bound:x1: not done; sent, with exactly two sends in the protected part; protected ≤ 64,200 ms;
 * decision → end ≤ 125,200 ms; due → end ≤ 197,200 ms plus its firing delay; every figure finite and non-negative.
 */
export function rawD4Failures(c) {
  const f = [];
  if (!(c && c.outcome && c.outcome !== "done")) f.push(`outcome ${c?.outcome}`);
  if (!(c?.sent === true && c.sends_in_protected === 2)) f.push(`sent ${c?.sent}, ${c?.sends_in_protected} sends in the protected part (want 2)`);
  for (const k of ["protected_ms", "decision_to_end_ms", "due_to_end_ms", "fire_delay_ms"]) if (!nonneg(c?.[k])) f.push(`${k} ${c?.[k]}`);
  if (!(c?.protected_ms <= PROTECTED_MAX_MS)) f.push(`raw protected ${c?.protected_ms} ms > ${PROTECTED_MAX_MS}`);
  if (!(c?.decision_to_end_ms <= 125_200)) f.push(`decision → end ${c?.decision_to_end_ms} ms > 125.2 s`);
  if (!(c?.due_to_end_ms <= 197_200 + c?.fire_delay_ms)) f.push(`due → end ${c?.due_to_end_ms} ms > 197.2 s + ${c?.fire_delay_ms}`);
  return f;
}

/**
 * The predeclared ×1 worst-case checkpoint (#18 timing rulings), raw: its call and its tombstone held past the deadline;
 * the raw D4 r3 checks (rawD4Failures: protected ≤ 64,200 ms, no slack, the stricter ruling superseding the
 * predeclared 64,700); both requested gaps in [2000, 2100] ms; raw interval ≤ 74,700 ms (the predeclared scenario
 * check); every timer at scale 1 and the accounting valid (its adjusted figures are
 * reported, never judged); then the chain recovered within 67 s, refused meanwhile only as resolving, the next write
 * committed and no call left.
 */
export function verifyBound(r) {
  const f = [];
  const b = r.bound;
  if (r.mode !== "bound" || !b || !b.checkpoint) return ["not a bound report"];
  probeOk(r, f);
  if (b.invocation !== "vm-content-runs.mjs bound") f.push(`invocation ${JSON.stringify(b.invocation)}`);
  const c = b.checkpoint;
  f.push(...rawD4Failures(c));
  if (!nonneg(c.interval_ms)) f.push(`interval_ms ${c.interval_ms}`);
  if (!(c.interval_ms <= 74_700)) f.push(`raw interval ${c.interval_ms} ms > 74,700`);
  const g = requestedGaps(c);
  if (!(g.length === 2 && g.every((x) => x >= 2000 && x <= 2100))) f.push(`requested gaps ${JSON.stringify(g)}, want two in [2000, 2100]`);
  if (!(Array.isArray(c.timers) && c.timers.length >= 4 && c.timers.every((t) => t.scale === 1 && t.virtual === false))) f.push("the timer records are missing or not all at scale 1");
  const acc = timerAccounting(c);
  if (acc.failures.length) f.push(`timer accounting: ${acc.failures.join("; ")}`);
  const ch = b.chain;
  if (!(ch && ch.issue === true && ch.write === true && ch.calls === 0 && nonneg(ch.ms) && ch.ms <= 67_000 && count(ch.resolving_refusals))) f.push(`the chain didn't recover within 67 s (${JSON.stringify(ch)})`);
  return f;
}

/** One report against its expectation: `mix:<kind>`, `barrier:<30min|6h>`, `recovery:<keys>` or `bound:x1`. */
export function verify(r, expect) {
  const [what, arg] = String(expect).split(":");
  if (what === "mix") return verifyMix(r, arg);
  if (what === "barrier") return verifyBarrier(r, arg);
  if (what === "recovery") return verifyRecovery(r, Number(arg));
  if (what === "bound" && arg === "x1") return verifyBound(r);
  return [`unknown expectation ${expect}`];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length % 2 !== 0) {
    console.log("usage: vm-content-verify.mjs <expectation> <report.json> [...] (at least one pair)");
    process.exit(2);
  }
  let bad = 0;
  for (let i = 0; i < args.length; i += 2) {
    const [expect, path] = [args[i], args[i + 1]];
    let f;
    try {
      f = verify(JSON.parse(readFileSync(path, "utf8")), expect);
    } catch (e) {
      f = [`unreadable: ${e.message}`];
    }
    console.log(f.length ? `FAIL ${expect} ${path}\n  ${f.join("\n  ")}` : `PASS ${expect} ${path}`);
    bad += f.length ? 1 : 0;
  }
  process.exit(bad ? 1 : 0);
}
