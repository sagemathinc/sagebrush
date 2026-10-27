// The interrupt matrix's signal-state trials (plan-interrupt-harness r5 §7, §8.1): what one
// press, a second press inside or after the 2 s window, and SIGHUP do to the launcher, asserted
// from the markers, the text and the exit status (the trace checks wait for E1's emitter), and the
// capability probes that turn a pending trial into PENDING-READY once its fix exists (§6.3).
//   runSignals({ hosts, mode, record, overBudget, baseline }) -> rows
// Every session's whole process tree is killed at its end, and a survivor fails the row (§1.3).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killTree, procTable, sessionTree, survivors, track, untrack } from "./interrupt-procs.mjs";
import { STOP_BOUND_MS, malformed, stopGate, validTime } from "./interrupt-classify.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const LAUNCHER = process.env.SB_LAUNCHER ?? join(ROOT, "packages/sagebrush/bin/sagebrush.cjs"); // (SB_LAUNCHER: another build, for checking the harness)
const now = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const G_MS = 120_000; // the hang guard (test infrastructure, not a computation limit)
const ended130 = (r) => r.code === 130 || r.signal === "SIGINT";

// one session: the program src on host (cli: a file, SIGINT for a press; prompt: typed into the
// launcher's prompt in a pty, \x03 for a press).  schedule: [{ after: "ENTER 1", ms, act }], act
// one of press | sighup | close.  Returns markers (in order, on the harness clock), the exit, the
// text, the acts' send times, the survivors of the final kill and the trace lines (if E1 wrote any).
// remainingMs: the run's time left (the matrix's deadline, set by runSignals); the guard is clipped
// to it, and nothing starts past it
let runRemaining = () => Infinity;
export function runProc({ host, flags = [], src, schedule = [], guard_ms = G_MS, probe = null, remainingMs = runRemaining }) {
  const clipped = remainingMs() < guard_ms;
  guard_ms = Math.min(guard_ms, remainingMs());
  if (guard_ms <= 0) return Promise.resolve({ end: "budget", exit: null, marks: [], sends: [], gone_ms: null, text: "", alive_at_end: [], left: [], trace: [], wall_ms: 0 });
  const dir = mkdtempSync(join(tmpdir(), "sb-sig-"));
  const trace = join(dir, "trace.jsonl");
  const env = { ...process.env, SAGEBRUSH_SIGNAL_TRACE: trace };
  return new Promise((resolve) => {
    let p;
    if (host === "cli") {
      const f = join(dir, "prog.py");
      writeFileSync(f, src);
      p = spawn(process.execPath, [LAUNCHER, ...flags, f], { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
    } else {
      const cmd = [process.execPath, LAUNCHER, ...flags].map((a) => `'${a}'`).join(" ");
      p = spawn("script", ["-qfec", cmd, "/dev/null"], { detached: true, stdio: ["pipe", "pipe", "pipe"], env });
      setTimeout(() => p.stdin.write(`exec(${JSON.stringify(src)})\n`), 1500);
    }
    const t0 = now();
    const marks = [], sends = [];
    let text = "", buf = "", done = false, exit = null;
    // (the first KeyboardInterrupt line after a press, on the harness clock: the prompt's caller endpoint, which has
    // no marker of its own; magma H1 on #225)
    let ki_text_t = null;
    // (in the one lifecycle registry from its spawn: killed if the harness is stopped, astra CORR-168-1)
    const known = track(p.pid);
    const remember = () => { const t = procTable(); for (const q of sessionTree(p.pid, known)) if (t.has(q)) known.set(q, t.get(q).start); };
    remember();
    const watch = setInterval(remember, 250);
    const guard = setTimeout(() => finish(clipped ? "budget" : "guard"), guard_ms);
    // the launcher itself: argv[0] is node and argv[1] the launcher (not the `sh -c` that script runs it under)
    const launcher = () => [...known.keys()].find((q) => { const a = safeRead(`/proc/${q}/cmdline`).split("\0"); return /(^|\/)node$/.test(a[0]) && a[1] === LAUNCHER; }) ?? null;
    const act = (a) => {
      sends.push({ act: a, t: now() });
      try {
        if (a === "press") host === "cli" ? process.kill(p.pid, "SIGINT") : p.stdin.write("\x03");
        else if (a === "sighup") {
          const q = host === "cli" ? p.pid : launcher();
          if (q == null) throw new Error("the launcher process was not found under script");
          sends.at(-1).pid = q;
          process.kill(q, "SIGHUP");
        }
        else if (a === "close") { p.stdin.end(); process.kill(p.pid, "SIGKILL"); } // script dies: the pty closes
        else if (a === "probe") p.stdin.write(probe + "\n");
      } catch (e) { sends.at(-1).error = String(e); }
      // after SIGHUP or a closed pty (S6): how long the session's tree outlives it, polled, before any kill of ours
      if ((a === "sighup" || a === "close") && !sends.at(-1).error) {
        const ts = sends.at(-1).t;
        const poll = setInterval(() => {
          if (survivors([...known.keys()]).length === 0) { clearInterval(poll); gone_ms = Math.round(now() - ts); finish("gone"); }
          else if (now() - ts > 2500) { clearInterval(poll); finish("not gone"); }
        }, 50);
      }
    };
    let gone_ms = null;
    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      clearInterval(watch);
      const tree = [...new Set([...known.keys(), ...sessionTree(p.pid, known)])];
      const aliveAtEnd = survivors(tree); // (before the kill: what the session itself left running)
      const killed = killTree(p.pid, known);
      setTimeout(() => {
        const left = survivors([...tree, ...killed]);
        if (left.length === 0) untrack(p.pid);
        const tr = existsSync(trace) ? readFileSync(trace, "utf8").split("\n").filter(Boolean) : [];
        rmSync(dir, { recursive: true, force: true });
        resolve({ end: why, exit, marks, sends, ki_text_t, gone_ms, text: text.slice(-2000), alive_at_end: aliveAtEnd, left, trace: tr, wall_ms: now() - t0 });
      }, 300);
    };
    const onLine = (line) => {
      if (ki_text_t == null && sends.some((x) => x.act === "press") && /KeyboardInterrupt/.test(line)) ki_text_t = now();
      // a marker, its trial number if any, and the rest of the line ("PROBE yes": mk PROBE, rest "yes";
      // "RET 0.25": mk RET, rest "0.25", since a trial number ends at a space or the end, pilot 4)
      const pm = parseMarker(line);
      if (!pm) return;
      const { mk } = pm;
      const kind = mk.split(" ")[0];
      marks.push({ mk, t: now(), rest: pm.rest });
      for (const s of schedule) if (s.after === mk && !s.armed) { s.armed = true; setTimeout(() => !done && act(s.act), s.ms); }
      if (kind === "END" || (host === "prompt" && kind === "PROBE")) setTimeout(() => finish("end"), host === "cli" ? 2000 : 500);
    };
    const feed = (d) => {
      buf += d;
      text = (text + d).slice(-4000);
      let k;
      while ((k = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, k)); buf = buf.slice(k + 1); }
    };
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
    p.on("exit", (code, signal) => { exit = { code, signal, t: now() }; });
    p.on("close", () => setTimeout(() => finish("exit"), 200));
  });
}
export function parseMarker(line) {
  const m = line.replace(/\r/g, "").match(/^(ENTER|KI|RET|CONT|PROBE|END)\b(?: (\d+)(?= |$))? ?(.*)$/);
  return m ? { mk: m[1] + (m[2] ? " " + m[2] : ""), rest: m[3].trim() } : null;
}
const safeRead = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
const markT = (r, mk) => r.marks.find((x) => x.mk === mk)?.t;
// a press's raw latency to its caller endpoint (the KI mark, or the exit), against the Stop bound: null when
// honoured in time, else the cell's FAIL.  Both times are validated before the difference is taken: a press with
// no valid send time, or an endpoint that is no valid time, is malformed evidence (INVALID, never KNOWN: R1).
export const pressGate = (r, k, endT, what) => {
  const s = r.sends[k];
  if (!s || s.error || !validTime(s.t)) return malformed(`press ${k + 1} has no valid send time${s?.error ? " (" + s.error + ")" : ` (${JSON.stringify(s?.t)})`}`);
  if (!validTime(endT)) return malformed(`no valid time for ${what} (${JSON.stringify(endT)})`);
  return stopGate(endT - s.t, what);
};
const lat = (x) => ({ latency_ms: Math.round(x), latency_raw_ms: x });
// the request evidence, checked BEFORE any functional failure a baseline could pin (astra2 #225 r2 H1): every marker,
// the exit and the KeyboardInterrupt line's stamp have valid times; a press that was scheduled was sent at a valid time
const evidenceBad = (r) => {
  for (const x of r.marks ?? []) if (!validTime(x.t)) return malformed(`the ${x.mk} marker's time ${JSON.stringify(x.t)}`);
  if (r.exit && !validTime(r.exit.t)) return malformed(`the exit's time ${JSON.stringify(r.exit.t)}`);
  if (r.ki_text_t != null && !validTime(r.ki_text_t)) return malformed(`the KeyboardInterrupt line's time ${JSON.stringify(r.ki_text_t)}`);
  return null;
};
const pressBad = (r, k) => {
  const s = r.sends[k];
  return !s || s.error || !validTime(s.t) ? malformed(`press ${k + 1} not sent at a valid time (${JSON.stringify(s ?? null)})`) : null;
};

// ---- the trials (§8.1).  Each returns { outcome, why, ... } for one cell.
const REGEX = (n) => `import re\n_s = "a" * ${n} + "b"\n`;
export const TRIALS = {
  // S1: one press, no handler: the traceback, then the process ends as SIGINT's default action (130)
  S1: {
    hosts: ["cli", "prompt"],
    src: () => `k = 0\nprint("ENTER 1", flush=True)\nwhile True:\n    k += 1\n`,
    schedule: (host) => [{ after: "ENTER 1", ms: 1000, act: "press" }, ...(host === "prompt" ? [{ after: "ENTER 1", ms: 3000, act: "probe" }] : [])],
    judge(r, host) {
      const ev = evidenceBad(r) ?? pressBad(r, 0);
      if (ev) return ev;
      if (host === "prompt") {
        // the prompt survives: KeyboardInterrupt shown, then the next input runs (the probe)
        if (!/KeyboardInterrupt/.test(r.text)) return { outcome: "FAIL", why: "no KeyboardInterrupt" };
        // (the caller endpoint is the first KeyboardInterrupt line after press 1, stamped by runProc: gated like the CLI's exit)
        if (!markT(r, "PROBE")) return { outcome: "FAIL", why: "the prompt did not take the next input" };
        return pressGate(r, 0, r.ki_text_t ?? NaN, "the KeyboardInterrupt") ?? { outcome: "PASS", ...lat(r.ki_text_t - r.sends[0].t) };
      }
      if (!/KeyboardInterrupt/.test(r.text)) return { outcome: "FAIL", why: "no KeyboardInterrupt traceback" };
      if (!r.exit || !ended130(r.exit)) return { outcome: "FAIL", why: `exit ${JSON.stringify(r.exit)}, not 130` };
      // (the caller endpoint is the exit: request -> 130 within the Stop bound)
      return pressGate(r, 0, r.exit.t, "the exit") ?? { outcome: "PASS", ...lat(r.exit.t - r.sends[0].t) };
    },
    probe: 'print("PROBE", 41, flush=True)',
  },
  // S2: a program that catches KI and keeps running; a second press 3 s later is a second KI, never an escalation
  S2: {
    hosts: ["cli"],
    src: () => `import time\nprint("ENTER 1", flush=True)\ntry:\n    while True:\n        pass\nexcept KeyboardInterrupt:\n    print("KI 1", flush=True)\nprint("CONT", flush=True)\ntry:\n    t = time.monotonic()\n    while time.monotonic() - t < 8:\n        pass\n    print("RET 2", flush=True)\nexcept KeyboardInterrupt:\n    print("KI 2", flush=True)\nprint("END", flush=True)\n`,
    schedule: () => [{ after: "ENTER 1", ms: 1000, act: "press" }, { after: "CONT", ms: 3000, act: "press" }],
    judge(r) {
      const ev = evidenceBad(r) ?? pressBad(r, 0);
      if (ev) return ev;
      if (!markT(r, "KI 1")) return { outcome: "FAIL", why: "no first KeyboardInterrupt" };
      // (press 2 is scheduled after CONT: once CONT is out it must have been sent, before its absence can be judged)
      if (markT(r, "CONT")) { const p2 = pressBad(r, 1); if (p2) return p2; }
      if (!markT(r, "KI 2")) return { outcome: "FAIL", why: markT(r, "RET 2") ? "the second press was not recognized" : "no second KeyboardInterrupt" };
      if (!markT(r, "END") || !r.exit || r.exit.code !== 0) return { outcome: "FAIL", why: `the second press ended the program (exit ${JSON.stringify(r.exit)})` };
      // (each press is gated at its own KI; the why names the press)
      for (const k of [0, 1]) {
        const g = pressGate(r, k, markT(r, `KI ${k + 1}`), `press ${k + 1}'s KeyboardInterrupt`);
        if (g) return g;
      }
      const l1 = markT(r, "KI 1") - r.sends[0].t, l2 = markT(r, "KI 2") - r.sends[1].t;
      return { outcome: "PASS", ...lat(l1), latency2_ms: Math.round(l2), latency2_raw_ms: l2 };
    },
  },
  // S3: a second press 0.5 s after the first, while the first is pending (a regex that doesn't poll): escalation, 130.
  // Two independent verdicts on every judged path, CLI and prompt: escalation, as before, and first_stop, press 1
  // against the Stop bound (astra2/magma/daybreak2 #225 R3).  The missed first deadline is proven from the ACTUAL
  // sends, never the schedule: both presses sent at valid times more than 250 ms apart, with no endpoint for press 1
  // (the CLI's exit, the prompt's KeyboardInterrupt line) before press 2 went.  Missing, malformed or coalesced
  // sends are malformed evidence (INVALID, both verdicts INVALID), never the pinned "first Stop not honoured".  Press 1
  // ending the program itself is honoured (PASS) or honoured late, with escalation not exercised.  The why leads with
  // escalation's failure if any, else with "first Stop not honoured", which a baseline entry may pin.
  S3: {
    hosts: ["cli", "prompt"],
    needsRegex: true,
    src: (n) => REGEX(n) + `print("ENTER 1", flush=True)\nre.match(r"(a+)+$", _s)\nprint("RET 1", flush=True)\n`,
    schedule: () => [{ after: "ENTER 1", ms: 500, act: "press" }, { after: "ENTER 1", ms: 1000, act: "press" }],
    judge(r, host) {
      const both = (v) => ({ escalation: v, first_stop: v });
      const bad = (w) => ({ ...malformed(w), ...both("INVALID") });
      const [s0, s1] = r.sends;
      const ret = markT(r, "RET 1");
      if (ret != null && !validTime(ret)) return bad(`RET 1's time ${JSON.stringify(ret)}`);
      if (ret != null && s0 && validTime(s0.t) && ret < s0.t) return { outcome: "INVALID", why: "the regex returned before the presses", ...both("INVALID") };
      if (!s0 || s0.error || !validTime(s0.t)) return bad(`press 1 not sent at a valid time (${JSON.stringify(s0 ?? null)})`);
      if (r.exit && !validTime(r.exit.t)) return bad(`the exit's time ${JSON.stringify(r.exit.t)}`);
      if (r.ki_text_t != null && !validTime(r.ki_text_t)) return bad(`the KeyboardInterrupt line's time ${JSON.stringify(r.ki_text_t)}`);
      const ev = evidenceBad(r);
      if (ev) return { ...ev, ...both("INVALID") };
      // (press 2 is validated BEFORE press 1's early endpoint is believed, daybreak2 D2-R3-MISSING-PRESS2: a missing record,
      // an unreadable time or a failed send is malformed.  The one exception, stated as an amendment for the reviewers:
      // on the CLI, press 1 ending the process makes press 2's kill fail with ESRCH, attempted after the exit; that is
      // the honoured path, and without it a fixed S3 could never pass)
      if (!s1) return bad("press 2 was due but never recorded");
      if (!validTime(s1.t)) return bad(`press 2's send time ${JSON.stringify(s1.t)}`);
      const gone = host !== "prompt" && s1.error && /ESRCH/.test(String(s1.error)) && r.exit && ended130(r.exit) && r.exit.t <= s1.t;
      if (s1.error && !gone) return bad(`press 2 failed while the program ran (${s1.error})`);
      const s1ok = !s1.error;
      // press 1's own endpoint, if it came before press 2 was sent: the prompt's KeyboardInterrupt line, the CLI's 130
      const end1 = host === "prompt" ? r.ki_text_t : r.exit && ended130(r.exit) ? r.exit.t : null;
      if (end1 != null && (gone || end1 < s1.t)) {
        const g = stopGate(end1 - s0.t, host === "prompt" ? "the KeyboardInterrupt after press 1" : "the exit after press 1");
        const nx = { escalation: "not exercised (press 1 ended it)", escalated: false };
        return g ? { ...g, ...nx, first_stop: g.late ? "honoured late" : "INVALID" } : { outcome: "PASS", ...nx, first_stop: "honoured", ...lat(end1 - s0.t) };
      }
      if (!s1ok) return bad(`press 2 failed (${s1.error})`);
      const spacing = s1.t - s0.t;
      if (!(spacing > STOP_BOUND_MS)) return bad(`the presses were ${spacing.toFixed(1)} ms apart, not more than ${STOP_BOUND_MS}: an escalation proves no missed first deadline`);
      const missed = { first_stop: "not honoured", press_spacing_ms: +spacing.toFixed(1) };
      if (ret != null) return { outcome: "FAIL", why: "no escalation: the presses were not recognized, the regex ran to completion", escalation: "FAIL", ...missed };
      if (!r.exit || !ended130(r.exit)) return { outcome: "FAIL", why: `no escalation: exit ${JSON.stringify(r.exit)}`, escalation: "FAIL", ...missed };
      if (r.alive_at_end.length) return { outcome: "FAIL", why: "the escalation left processes running: " + r.alive_at_end.join(","), escalation: "FAIL", ...missed };
      // (the escalation is gated too, astra2 H2: press 2's endpoint must follow it, within the bound; a late escalation is
      // honoured late, never the pinned first-Stop signature; first_stop stays independent)
      if (!(r.exit.t >= s1.t)) return bad(`the exit (${r.exit.t}) came before press 2 (${s1.t}) with no KeyboardInterrupt for press 1`);
      const e = r.exit.t - s1.t;
      const eg = stopGate(e, "the escalation's exit after press 2");
      if (eg) return { ...eg, escalation: eg.late ? "honoured late" : "INVALID", escalated: true, ...missed };
      return { outcome: "FAIL", why: `first Stop not honoured: no KeyboardInterrupt or exit within ${STOP_BOUND_MS} ms of press 1 (the presses were ${spacing.toFixed(1)} ms apart; the second press escalated)`, escalation: "PASS", escalated: true, latency_ms: Math.round(e), latency_raw_ms: e, ...missed };
    },
  },
  // S4: the first press stays pending past the 2 s window; a second press at 3 s re-arms, never escalates;
  // the KI comes when the regex returns
  S4: {
    hosts: ["cli"],
    needsRegex: true,
    src: (n) => REGEX(n) + `print("ENTER 1", flush=True)\ntry:\n    re.match(r"(a+)+$", _s)\n    print("RET 1", flush=True)\nexcept KeyboardInterrupt:\n    print("KI 1", flush=True)\nprint("END", flush=True)\n`,
    schedule: () => [{ after: "ENTER 1", ms: 500, act: "press" }, { after: "ENTER 1", ms: 3500, act: "press" }],
    judge(r) {
      const ev = evidenceBad(r);
      if (ev) return ev;
      const ret = markT(r, "RET 1");
      // (a return before any press is the genuine INVALID; otherwise press 1 must have been sent validly)
      if (ret != null && !r.sends.length) return { outcome: "INVALID", why: "the regex returned before the presses" };
      const p1 = pressBad(r, 0);
      if (p1) return p1;
      if (ret != null && ret < r.sends[0].t) return { outcome: "INVALID", why: "the regex returned before the presses" };
      // (press 2, at 3.5 s after ENTER: absent only if the program ended before it was due; if sent, at a valid time;
      // ESRCH only once the process had exited)
      const s1 = r.sends[1], enter = markT(r, "ENTER 1"), endT = r.exit?.t ?? ret;
      if (!s1 && !(enter != null && endT != null && endT < enter + 3500)) return malformed("press 2 was due but never recorded");
      if (s1 && !validTime(s1.t)) return malformed(`press 2's send time ${JSON.stringify(s1.t)}`);
      if (s1?.error && !(/ESRCH/.test(String(s1.error)) && r.exit && r.exit.t <= s1.t)) return malformed(`press 2 failed while the program ran (${s1.error})`);
      if (ret != null) return { outcome: "FAIL", why: "the regex returned without a KeyboardInterrupt" };
      if (!r.exit || ended130(r.exit)) return { outcome: "FAIL", why: `the second press, after the window, ended the process (exit ${JSON.stringify(r.exit)})` };
      if (!markT(r, "KI 1")) return { outcome: "FAIL", why: "no KeyboardInterrupt when the regex returned" };
      // (a KI that waited for the regex to return is honoured late: a FAIL, never KNOWN)
      return pressGate(r, 0, markT(r, "KI 1"), "press 1's KeyboardInterrupt") ?? { outcome: "PASS", ...lat(markT(r, "KI 1") - r.sends[0].t) };
    },
  },
  // S6: SIGHUP to a busy prompt's launcher (cell a), or the pty closed (cell b): the whole tree gone within 2 s
  S6: {
    hosts: ["prompt"],
    cells: ["sighup", "close"],
    src: () => `k = 0\nprint("ENTER 1", flush=True)\nwhile True:\n    k += 1\n`,
    schedule: (cell) => [{ after: "ENTER 1", ms: 1000, act: cell }],
  },
};

// the bounded regex (§8.1): its time doubles with each step of n (pilot 4b, VM3: n = 26 took about 5.1 s,
// n = 27 about 10.4 s), so a 6-8 s band can fall between two sizes.  Taken: a size in [6, 8] s if
// one is seen, else the smallest seen size in [floor, ceiling] = [5.5, 12] s (labelled widened).  That
// window is a ratio of about 2.18, more than one doubling, so one doubling sequence always has a size
// in it unless a step is off 2x by more than about 9%; [6, 12] s was a ratio of exactly 2, and train-17
// missed it by 50 ms and 21 ms (n = 27 5950 ms, n = 28 12021 ms).  The floor keeps S4's margin: its
// second press is at 3.5 s, so a 5.5 s call outlasts it by 2 s, and still by 350 ms if the trial runs
// 30% shorter than its calibration (S3's presses are at 0.5 s and 1 s).  A size is never run twice.
export const REGEX_BAND = { floor: 5500, min: 6000, max: 8000, ceiling: 12000 };
export function pickRegex(attempts) {
  const timed = attempts.filter((x) => x.T_ms != null);
  const inBand = timed.find((x) => x.T_ms >= REGEX_BAND.min && x.T_ms <= REGEX_BAND.max);
  const widened = timed.filter((x) => x.T_ms >= REGEX_BAND.floor && x.T_ms <= REGEX_BAND.ceiling).sort((x, y) => x.n - y.n)[0];
  const c = inBand ?? widened;
  return c ? { n: c.n, T: c.T_ms, attempts, ...(inBand ? {} : { label: "widened (doubling step)" }) } : null;
}
async function calibrateRegex(host, flags) {
  const attempts = [];
  const pick = () => pickRegex(attempts);
  let n = 24;
  for (let a = 0; a < 8; a++) {
    const r = await runProc({ host: "cli", flags, src: REGEX(n) + `import time\n_t = time.monotonic()\nre.match(r"(a+)+$", _s)\nprint("RET", time.monotonic() - _t, flush=True)\nprint("END", flush=True)\n`, guard_ms: 60_000 });
    const T = Number(r.marks.find((x) => x.mk === "RET")?.rest) * 1000;
    attempts.push({ n, T_ms: Number.isFinite(T) ? Math.round(T) : null, end: r.end });
    if (!Number.isFinite(T) && r.end !== "guard") return { n: null, attempts };
    if (Number.isFinite(T) && T >= REGEX_BAND.min && T <= REGEX_BAND.max) return pick();
    // each step of n doubles the work (one more way to split the a's)
    const next = !Number.isFinite(T) ? n - 2 : n + (Math.max(-4, Math.min(4, Math.round(Math.log2(7000 / T)))) || (T < REGEX_BAND.min ? 1 : -1));
    if (next < 16 || next > 40 || attempts.some((x) => x.n === next)) break;
    n = next;
  }
  return pick() ?? { n: null, attempts };
}

// S6's judge: the signal was sent, and the launcher and its whole tree were gone within 2 s, with
// nothing left for the harness's own kill
export function judgeS6(r) {
  if (r.end === "budget") return { outcome: "INVALID", why: "run budget spent" };
  if (!r.sends.length) return { outcome: "INVALID", why: "no ENTER: the signal was never sent" };
  if (r.sends[0].error) return { outcome: "INVALID", why: "the signal could not be sent: " + r.sends[0].error };
  if (r.left.length) return { outcome: "FAIL", why: "processes survived: " + r.left.join(",") };
  if (r.gone_ms == null) return { outcome: "FAIL", why: "the busy prompt outlived 2 s after the signal" };
  return r.gone_ms <= 2000 ? { outcome: "PASS", gone_ms: r.gone_ms } : { outcome: "FAIL", why: `gone after ${r.gone_ms} ms`, gone_ms: r.gone_ms };
}
const runS6 = (host, flags, cell) => runProc({ host, flags, src: TRIALS.S6.src(), schedule: TRIALS.S6.schedule(cell), guard_ms: 15_000 });

// a signal row from its cells and its baseline entry (if any): FAIL / INCOMPLETE / PASS, then KNOWN when
// every failing cell matches the entry's signature, FIXED when an entry's row passes.  A press honoured late
// is never KNOWN, whatever its why says (S-delta Stop-250: only a waiver covers it, and none covers signals), nor is
// a row with malformed evidence in any cell (R1)
export function signalOutcome(cells, b) {
  const outcome = cells.some((c) => c.outcome === "FAIL") ? "FAIL" : cells.some((c) => c.outcome !== "PASS") ? "INCOMPLETE" : "PASS";
  const fails = cells.filter((c) => c.outcome === "FAIL");
  const fin = !b ? outcome : outcome === "PASS" ? "FIXED" : outcome === "FAIL" && !cells.some((c) => c.malformed) && fails.every((c) => !c.late && new RegExp(b.signature).test(c.why)) ? "KNOWN" : outcome;
  return { outcome, fin };
}

export async function runSignals({ hosts = ["cli"], mode = "ci", record = () => {}, overBudget = () => false, remainingMs = () => Infinity, baseline = { pending: [] }, flags = [], only = null } = {}) {
  runRemaining = remainingMs;
  const rows = [];
  const repeats = mode === "full" ? 5 : 1;
  const ciHosts = { S1: ["cli"], S2: ["cli"], S3: ["cli"], S4: ["cli"] }; // the CI cells (§8.1)
  let regex = null;
  for (const id of ["S1", "S2", "S3", "S4"].filter((x) => !only || only.includes(x))) {
    const t = TRIALS[id];
    for (const host of t.hosts.filter((h) => hosts.includes(h) && (mode === "full" || ciHosts[id].includes(h)))) {
      if (overBudget()) { rows.push({ trial: id, host, outcome: "INVALID", why: "run budget spent" }); record(rows.at(-1)); continue; }
      if (t.needsRegex && !regex) regex = await calibrateRegex(host, flags);
      if (t.needsRegex && regex.n == null) { rows.push({ trial: id, host, outcome: "INVALID", why: "regex uncalibrated", calibration: regex }); record(rows.at(-1)); continue; }
      const cells = [];
      for (let k = 1; k <= repeats; k++) {
        // (30 s: a correct session ends within about 10 s; a known prompt failure needs no more to show its signature)
        const r = await runProc({ host, flags, src: t.src(regex?.n), schedule: t.schedule(host), probe: t.probe, guard_ms: 30_000 });
        if (r.end === "budget" && overBudget()) { cells.push({ i: k, outcome: "INVALID", why: "run budget spent" }); break; }
        const j = await t.judge(r, host);
        const leftFail = r.left.length ? { outcome: "FAIL", why: "processes survived the kill: " + r.left.join(",") } : null;
        cells.push({ i: k, ...(leftFail ?? j), exit: r.exit && { code: r.exit.code, signal: r.exit.signal }, trace_lines: r.trace.length, ...(j.outcome !== "PASS" ? { tail: r.text.slice(-600) } : {}) });
      }
      const { outcome, fin } = signalOutcome(cells, (baseline.entries ?? []).find((e) => e.case === id && e.host === host));
      rows.push({ trial: id, host, run: mode, outcome: fin, ...(fin !== outcome ? { own_outcome: outcome } : {}), cells, ...(t.needsRegex ? { regex_n: regex.n, regex_T_ms: Math.round(regex.T), ...(regex.label ? { regex_label: regex.label } : {}) } : {}) });
      record(rows.at(-1));
    }
  }
  // S6 (required since #123, master 90f7e0df; PENDING-READY on GitHub's runner, dispatch 40236353993):
  // SIGHUP to a busy prompt's launcher, and its pty closed, each end the whole tree within 2 s
  if (hosts.includes("prompt") && (!only || only.includes("S6"))) {
    const cells = [];
    for (const cell of TRIALS.S6.cells) {
      for (let k = 1; k <= repeats; k++) {
        if (overBudget()) { cells.push({ cell, i: k, outcome: "INVALID", why: "run budget spent" }); break; }
        const r = await runS6("prompt", flags, cell);
        cells.push({ cell, i: k, ...judgeS6(r) });
      }
    }
    const outcome = cells.some((c) => c.outcome === "FAIL") ? "FAIL" : cells.some((c) => c.outcome !== "PASS") ? "INCOMPLETE" : "PASS";
    rows.push({ trial: "S6", host: "prompt", run: mode, outcome, cells });
    record(rows.at(-1));
  }
  if (!only || only.includes("pending")) rows.push(...(await pendingReady({ hosts, flags, baseline, record, rowsSoFar: rows })));
  return rows;
}

// PENDING-READY (§6.3): a pending trial whose capability is present fails --ci until it is made required.
//  - "E1 trace": any S session above wrote SAGEBRUSH_SIGNAL_TRACE lines;
//  - an entry with capability.expr: evaluated in the launcher (mode capability.mode);
//  - S6: run as an observation (it needs no API).
export async function pendingReady({ hosts, flags, baseline, record, rowsSoFar }) {
  const out = [];
  const traced = rowsSoFar.some((r) => (r.cells ?? []).some((c) => c.trace_lines > 0));
  for (const e of baseline.pending ?? []) {
    let ready = null, evidence = null;
    if (/E1/.test(e.waits_for ?? "")) { ready = traced; evidence = traced ? "SAGEBRUSH_SIGNAL_TRACE was written" : "no trace lines"; }
    else if (e.capability?.expr) {
      const r = await runProc({ host: "cli", flags: e.capability.mode && e.capability.mode !== "python" ? ["--" + e.capability.mode] : [], src: `try:\n    _ok = bool(${e.capability.expr})\nexcept Exception:\n    _ok = False\nprint("PROBE", "yes" if _ok else "no", flush=True)\nprint("END", flush=True)\n`, guard_ms: 60_000 });
      const v = r.marks.find((x) => x.mk === "PROBE")?.rest;
      ready = v === "yes"; evidence = `${e.capability.expr} -> ${v ?? "no answer"}`;
    } else if (/^S6/.test(e.trial) && hosts.includes("prompt")) {
      const res = [];
      for (const cell of TRIALS.S6.cells) {
        const r = await runS6("prompt", flags, cell);
        res.push({ cell, sent: r.sends.length > 0 && !r.sends[0].error, ...(r.sends[0]?.error ? { error: r.sends[0].error } : {}), gone_ms: r.gone_ms, end: r.end, left: r.left.length });
      }
      ready = res.every((x) => x.sent && x.gone_ms != null && x.gone_ms <= 2000); evidence = res;
    } else { evidence = "no capability probe for this entry (the owner names one)"; }
    const row = { trial: e.trial, waits_for: e.waits_for, outcome: ready ? "PENDING-READY" : "PENDING", evidence };
    out.push(row);
    record(row);
  }
  return out;
}
