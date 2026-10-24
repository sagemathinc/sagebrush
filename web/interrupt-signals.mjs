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
import { killTree, procTable, sessionTree, survivors } from "./interrupt-procs.mjs";

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
export function runProc({ host, flags = [], src, schedule = [], guard_ms = G_MS, probe = null }) {
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
    const known = new Map();
    const remember = () => { const t = procTable(); for (const q of sessionTree(p.pid, known)) if (t.has(q)) known.set(q, t.get(q).start); };
    remember();
    const watch = setInterval(remember, 250);
    const guard = setTimeout(() => finish("guard"), guard_ms);
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
        const tr = existsSync(trace) ? readFileSync(trace, "utf8").split("\n").filter(Boolean) : [];
        rmSync(dir, { recursive: true, force: true });
        resolve({ end: why, exit, marks, sends, gone_ms, text: text.slice(-2000), alive_at_end: aliveAtEnd, left, trace: tr, wall_ms: now() - t0 });
      }, 300);
    };
    const onLine = (line) => {
      // a marker, its trial number if any, and the rest of the line (e.g. "PROBE yes": mk PROBE, rest "yes")
      const m = line.replace(/\r/g, "").match(/^(ENTER|KI|RET|CONT|PROBE|END)\b(?: (\d+)\b)? ?(.*)$/);
      if (!m) return;
      const mk = m[1] + (m[2] ? " " + m[2] : "");
      marks.push({ mk, t: now(), rest: m[3].trim() });
      for (const s of schedule) if (s.after === mk && !s.armed) { s.armed = true; setTimeout(() => !done && act(s.act), s.ms); }
      if (m[1] === "END" || (host === "prompt" && m[1] === "PROBE")) setTimeout(() => finish("end"), host === "cli" ? 2000 : 500);
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
const safeRead = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
const markT = (r, mk) => r.marks.find((x) => x.mk === mk)?.t;

// ---- the trials (§8.1).  Each returns { outcome, why, ... } for one cell.
const REGEX = (n) => `import re\n_s = "a" * ${n} + "b"\n`;
export const TRIALS = {
  // S1: one press, no handler: the traceback, then the process ends as SIGINT's default action (130)
  S1: {
    hosts: ["cli", "prompt"],
    src: () => `k = 0\nprint("ENTER 1", flush=True)\nwhile True:\n    k += 1\n`,
    schedule: (host) => [{ after: "ENTER 1", ms: 1000, act: "press" }, ...(host === "prompt" ? [{ after: "ENTER 1", ms: 3000, act: "probe" }] : [])],
    judge(r, host) {
      if (host === "prompt") {
        // the prompt survives: KeyboardInterrupt shown, then the next input runs (the probe)
        if (!/KeyboardInterrupt/.test(r.text)) return { outcome: "FAIL", why: "no KeyboardInterrupt" };
        return markT(r, "PROBE") ? { outcome: "PASS" } : { outcome: "FAIL", why: "the prompt did not take the next input" };
      }
      if (!/KeyboardInterrupt/.test(r.text)) return { outcome: "FAIL", why: "no KeyboardInterrupt traceback" };
      if (!r.exit || !ended130(r.exit)) return { outcome: "FAIL", why: `exit ${JSON.stringify(r.exit)}, not 130` };
      return { outcome: "PASS", latency_ms: Math.round(r.exit.t - r.sends[0].t) };
    },
    probe: 'print("PROBE", 41, flush=True)',
  },
  // S2: a program that catches KI and keeps running; a second press 3 s later is a second KI, never an escalation
  S2: {
    hosts: ["cli"],
    src: () => `import time\nprint("ENTER 1", flush=True)\ntry:\n    while True:\n        pass\nexcept KeyboardInterrupt:\n    print("KI 1", flush=True)\nprint("CONT", flush=True)\ntry:\n    t = time.monotonic()\n    while time.monotonic() - t < 8:\n        pass\n    print("RET 2", flush=True)\nexcept KeyboardInterrupt:\n    print("KI 2", flush=True)\nprint("END", flush=True)\n`,
    schedule: () => [{ after: "ENTER 1", ms: 1000, act: "press" }, { after: "CONT", ms: 3000, act: "press" }],
    judge(r) {
      if (!markT(r, "KI 1")) return { outcome: "FAIL", why: "no first KeyboardInterrupt" };
      if (!markT(r, "KI 2")) return { outcome: "FAIL", why: markT(r, "RET 2") ? "the second press was not recognized" : "no second KeyboardInterrupt" };
      if (!markT(r, "END") || !r.exit || r.exit.code !== 0) return { outcome: "FAIL", why: `the second press ended the program (exit ${JSON.stringify(r.exit)})` };
      return { outcome: "PASS", latency_ms: Math.round(markT(r, "KI 1") - r.sends[0].t), latency2_ms: Math.round(markT(r, "KI 2") - r.sends[1].t) };
    },
  },
  // S3: a second press 0.5 s after the first, while the first is pending (a regex that doesn't poll): escalation, 130
  S3: {
    hosts: ["cli", "prompt"],
    needsRegex: true,
    src: (n) => REGEX(n) + `print("ENTER 1", flush=True)\nre.match(r"(a+)+$", _s)\nprint("RET 1", flush=True)\n`,
    schedule: () => [{ after: "ENTER 1", ms: 500, act: "press" }, { after: "ENTER 1", ms: 1000, act: "press" }],
    judge(r) {
      const ret = markT(r, "RET 1");
      if (ret) return ret < (r.sends[0]?.t ?? Infinity) ? { outcome: "INVALID", why: "the regex returned before the presses" } : { outcome: "FAIL", why: "no escalation: the presses were not recognized, the regex ran to completion" };
      if (!r.exit || !ended130(r.exit)) return { outcome: "FAIL", why: `no escalation: exit ${JSON.stringify(r.exit)}` };
      if (r.alive_at_end.length) return { outcome: "FAIL", why: "the escalation left processes running: " + r.alive_at_end.join(",") };
      return { outcome: "PASS", escalated: true, latency_ms: Math.round(r.exit.t - r.sends[1].t) };
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
      if (markT(r, "RET 1")) return { outcome: markT(r, "RET 1") < r.sends[0]?.t ? "INVALID" : "FAIL", why: "the regex returned without a KeyboardInterrupt" };
      if (!r.exit || ended130(r.exit)) return { outcome: "FAIL", why: `the second press, after the window, ended the process (exit ${JSON.stringify(r.exit)})` };
      if (!markT(r, "KI 1")) return { outcome: "FAIL", why: "no KeyboardInterrupt when the regex returned" };
      return { outcome: "PASS", latency_ms: Math.round(markT(r, "KI 1") - r.sends[0].t) };
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

// the bounded regex (§8.1): the size whose uninterrupted run takes 6-8 s, found by doubling steps
async function calibrateRegex(host, flags) {
  const attempts = [];
  let n = 24;
  for (let a = 0; a < 8; a++) {
    const r = await runProc({ host: "cli", flags, src: REGEX(n) + `import time\n_t = time.monotonic()\nre.match(r"(a+)+$", _s)\nprint("RET", time.monotonic() - _t, flush=True)\nprint("END", flush=True)\n`, guard_ms: 60_000 });
    const T = Number(r.marks.find((x) => x.mk === "RET")?.rest) * 1000;
    attempts.push({ n, T_ms: Number.isFinite(T) ? Math.round(T) : null, end: r.end });
    if (!Number.isFinite(T)) { if (r.end === "guard") { n -= 2; continue; } return { n: null, attempts }; }
    if (T >= 6000 && T <= 8000) return { n, T, attempts };
    // each step of n doubles the work (one more way to split the a's)
    n += Math.max(-4, Math.min(4, Math.round(Math.log2(7000 / T)))) || (T < 6000 ? 1 : -1);
    if (n < 16 || n > 40) break;
  }
  return { n: null, attempts };
}

// S6 measures how long the launcher outlives the signal, before any kill of ours
const runS6 = (host, flags, cell) => runProc({ host, flags, src: TRIALS.S6.src(), schedule: TRIALS.S6.schedule(cell), guard_ms: 15_000 });

export async function runSignals({ hosts = ["cli"], mode = "ci", record = () => {}, overBudget = () => false, baseline = { pending: [] }, flags = [], only = null } = {}) {
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
        const j = await t.judge(r, host);
        const leftFail = r.left.length ? { outcome: "FAIL", why: "processes survived the kill: " + r.left.join(",") } : null;
        cells.push({ i: k, ...(leftFail ?? j), exit: r.exit && { code: r.exit.code, signal: r.exit.signal }, trace_lines: r.trace.length, ...(j.outcome !== "PASS" ? { tail: r.text.slice(-600) } : {}) });
      }
      const outcome = cells.some((c) => c.outcome === "FAIL") ? "FAIL" : cells.some((c) => c.outcome !== "PASS") ? "INCOMPLETE" : "PASS";
      const b = (baseline.entries ?? []).find((e) => e.case === id && e.host === host);
      const fin = !b ? outcome : outcome === "PASS" ? "FIXED" : outcome === "FAIL" && cells.filter((c) => c.outcome === "FAIL").every((c) => new RegExp(b.signature).test(c.why)) ? "KNOWN" : outcome;
      rows.push({ trial: id, host, run: mode, outcome: fin, ...(fin !== outcome ? { own_outcome: outcome } : {}), cells, ...(t.needsRegex ? { regex_n: regex.n, regex_T_ms: Math.round(regex.T) } : {}) });
      record(rows.at(-1));
    }
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
