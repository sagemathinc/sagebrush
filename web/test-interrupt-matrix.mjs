// The interrupt matrix (item B): start each expensive operation, interrupt it partway, and
// check that the interrupt is recognized (and how long it took), that the session survives
// (the same process, `keep` still defined), that the next call on the same route works,
// and that repeats leak neither threads nor memory.  Hosts:
//   cli     node packages/sagebrush/bin/sagebrush.cjs PROGRAM (the npm launcher), with SIGINT;
//   prompt  the same launcher's interactive prompt, in a pseudo-terminal (script -qfec), with Ctrl-C;
//   browser the notebook page's worker, with its Stop button (served at SB_URL, Chromium over CDP).
// Usage:
//   node web/test-interrupt-matrix.mjs --pilot [--host cli,prompt,browser] [--rows P1,E2] [--out FILE]
// The pilot calibrates each case on each host (uninterrupted, capped, a bounded number of resizes),
// then runs one trial set per case (Stop at 0.5 T, or 1 s after the target starts for a loop
// without an end), and writes what it measured as JSON.  This is the plan's pilot (plan-
// interrupt-harness r3 §8); the full matrix and the CI job follow it.
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { againstBaseline, classify, rowOutcome } from "./interrupt-classify.mjs";
const BASELINE = JSON.parse(readFileSync(new URL("./interrupt-baseline.json", import.meta.url), "utf8"));

const ROOT = new URL("..", import.meta.url).pathname;
const LAUNCHER = join(ROOT, "packages/sagebrush/bin/sagebrush.cjs");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const HOSTS = opt("--host", "cli,prompt,browser").split(",");
const ROWS = opt("--rows", "");
const OUT = opt("--out", join(tmpdir(), "interrupt-matrix-pilot.json"));
// (every row is appended to OUT.jsonl as it finishes, so a stopped run keeps what it measured)
const ROWS_OUT = OUT.replace(/\.json$/, "") + ".jsonl";
// the whole run's wall budget (test infrastructure): past it, the rows left are INVALID-budget
const RUN_BUDGET_MS = Number(opt("--budget-ms", String(30 * 60_000)));
const RUN_T0 = Number(process.hrtime.bigint()) / 1e6;
const overBudget = () => Number(process.hrtime.bigint()) / 1e6 - RUN_T0 > RUN_BUDGET_MS;
export const record = (row) => { appendFileSync(ROWS_OUT, JSON.stringify(row) + "\n"); console.log(JSON.stringify(row)); };
const G_MS = 120_000; // the hang guard after a Stop (test infrastructure, not a computation limit)
const CAL_CAP_MS = 60_000; // one uninterrupted calibration run at most
const BAND = { min: 3_000, max: 8_000 }; // the CI band (plan r3 §3)
const MAX_RESIZE = 4;
const dir = mkdtempSync(join(tmpdir(), "sb-intr-"));
const now = () => Number(process.hrtime.bigint()) / 1e6; // the one observer clock (ms)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the cases (the pilot's CI set; web/interrupt-matrix.json holds the full table later)
// setup and target are Python source with S for the size; grow(s, ratio) gives the next size.
const CASES = [
  { id: "P1", mode: "python", calibration: "nonterminating", setup: "k = 0", target: "while True:\n    k += 1", probe: "assert sum(range(10)) == 45" },
  { id: "P2a", mode: "python", s0: 3_000_000, smin: 100_000, smax: 10_000_000, grow: (s, r) => Math.round(s * r), setup: "", target: "_r = sorted(range(S), key=lambda v: -v)", probe: "assert sorted([3, 1, 2]) == [1, 2, 3]" },
  { id: "E2", mode: "sage", s0: 22, smin: 12, smax: 44, grow: (s, r) => s + Math.max(1, Math.round(Math.log(r) / 0.18)) * Math.sign(Math.log(r)), setup: "n = next_prime(10**S) * next_prime(3 * 10**S)", target: "_r = factor(n)", probe: "assert len(factor(2**64 + 1)) == 2" },
  { id: "E3a", mode: "sage", s0: 450, smin: 200, smax: 600, grow: (s, r) => Math.round(s * Math.cbrt(r)), setup: "M = random_matrix(GF(32003), S)", target: "_r = M.rank()", probe: "assert matrix(GF(32003), [[1, 2], [2, 4]]).rank() == 1" },
  { id: "E6a", mode: "sage", s0: 6, smin: 4, smax: 9, grow: (s, r) => s + (r > 1 ? 1 : -1), setup: "R = PolynomialRing(GF(32003), 'x', S)\nX = R.gens()\nI = R.ideal([sum(prod(X[(j + t) % S] for t in range(d)) for j in range(S)) for d in range(1, S)] + [prod(X) - 1])", target: "_r = I.groebner_basis()", probe: "R2 = PolynomialRing(GF(32003), 'y', 2)\nassert len(R2.ideal([R2.gen(0)**2 - 1, R2.gen(1) - 1]).groebner_basis()) == 2" },
].filter((c) => !ROWS || ROWS.split(",").includes(c.id));
const FLAGS = { python: [], sage: ["--sage"], magma: ["--magma"], matlab: ["--matlab"] };

const indent = (src, n) => src.split("\n").map((l) => " ".repeat(n) + l).join("\n");
// a driver: trials 1..n, each with markers (plan r3 §1); setup and probes outside the narrow try
function driver(c, s, n) {
  const sz = (src) => src.replace(/\bS\b/g, String(s ?? 0));
  const setup = c.setup ? sz(c.setup) : "pass";
  return `import time
keep = 41
def _p(*a):
    print(*a, flush=True)
for _i in range(1, ${n} + 1):
    try:
        _p("SETUP", _i)
${indent(setup, 8)}
    except KeyboardInterrupt:
        _p("STRAY", _i, "setup")
        continue
    try:
        _p("ENTER", _i, time.monotonic())
${indent(sz(c.target), 8)}
        _p("RET", _i)
    except KeyboardInterrupt:
        _p("KI", _i, time.monotonic())
    try:
        assert keep == 41
        assert 2 + 2 == 4
${indent(c.probe, 8)}
        _p("PROBE", _i, "ok")
    except KeyboardInterrupt:
        _p("STRAY", _i, "probe")
    except Exception as _e:
        _p("PROBE", _i, "fail", repr(_e)[:200])
    _p("DONE", _i)
    try:
        time.sleep(0.3)
    except KeyboardInterrupt:
        _p("STRAY", _i, "late", time.monotonic())
_p("END")
`;
}

function procStatus(pid) {
  try {
    const t = readFileSync(`/proc/${pid}/status`, "utf8");
    const g = (k) => Number((t.match(new RegExp(`^${k}:\\s+(\\d+)`, "m")) ?? [])[1]);
    return { rss_kb: g("VmRSS"), threads: g("Threads") };
  } catch {
    return null;
  }
}
// the launcher under `script` (the prompt host): the node process among script's children
function launcherChild(pid) {
  for (const q of readdirSync("/proc")) {
    if (!/^\d+$/.test(q)) continue;
    try {
      const f = readFileSync(`/proc/${q}/stat`, "utf8");
      const fields = f.slice(f.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[1]) === pid && /node/.test(f.slice(f.indexOf("(") + 1, f.lastIndexOf(")")))) return Number(q);
    } catch {}
  }
  return pid;
}
// processes still in a process group (the cleanup check)
function groupMembers(pgid) {
  const left = [];
  for (const p of readdirSync("/proc")) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const f = readFileSync(`/proc/${p}/stat`, "utf8");
      const fields = f.slice(f.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pgid) left.push(Number(p));
    } catch {}
  }
  return left;
}

// ---- running one session (cli or prompt): delays[i] (ms after ENTER i, or null for none)
// returns the per-trial evidence, read on the harness's own clock
function session(host, c, s, delays, budget_ms = CAL_CAP_MS + G_MS * delays.length) {
  const n = delays.length;
  const src = driver(c, s, n);
  return new Promise((resolve) => {
    let p;
    if (host === "cli") {
      const f = join(dir, `${c.id}-${Date.now()}.py`);
      writeFileSync(f, src);
      p = spawn(process.execPath, [LAUNCHER, ...FLAGS[c.mode], f], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      // the prompt: the whole driver typed as one input (exec of a string literal), in a pty
      const cmd = [process.execPath, LAUNCHER, ...FLAGS[c.mode]].map((a) => `'${a}'`).join(" ");
      p = spawn("script", ["-qfec", cmd, "/dev/null"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
      setTimeout(() => p.stdin.write(`exec(${JSON.stringify(src)})\n`), 1500);
    }
    const trials = Array.from({ length: n }, (_, k) => ({ i: k + 1, marks: {}, stray: null, probe: null }));
    const samples = [];
    let buf = "";
    let guard = null;
    const t0 = now();
    const overall = setTimeout(() => finish("budget"), budget_ms);
    let tail = "";
    const kill = () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} };
    const finish = (why) => {
      clearTimeout(overall);
      if (guard) clearTimeout(guard);
      kill();
      setTimeout(() => resolve({ trials, samples, end: why, wall_ms: now() - t0, left: groupMembers(p.pid), tail: tail.slice(-1500) }), 500);
    };
    const onLine = (line) => {
      const m = line.replace(/\r/g, "").match(/^(SETUP|ENTER|RET|KI|PROBE|STRAY|DONE|END)\b ?(\d+)? ?(.*)$/);
      if (!m) return;
      const [, mk, si, rest] = m;
      if (mk === "END") return finish("end");
      const t = trials[Number(si) - 1];
      if (!t) return;
      t.marks[mk] = { t: now(), rest };
      if (mk === "ENTER" && delays[t.i - 1] != null) {
        const id = t.i;
        setTimeout(() => {
          // (a send never outlives its trial: no RET/KI yet for this id)
          if (trials[id - 1].marks.RET || trials[id - 1].marks.KI) return;
          trials[id - 1].t_send = now();
          if (host === "cli") process.kill(p.pid, "SIGINT");
          else p.stdin.write("\x03");
          guard = setTimeout(() => finish("guard"), G_MS);
        }, delays[t.i - 1]);
      }
      if (mk === "KI" && guard) { clearTimeout(guard); guard = null; }
      if (mk === "PROBE") t.probe = rest;
      if (mk === "STRAY") t.stray = rest;
      if (mk === "DONE") samples.push({ i: t.i, ...(procStatus(host === "cli" ? p.pid : launcherChild(p.pid)) ?? {}) });
    };
    const feed = (d) => {
      buf += d;
      tail = (tail + d).slice(-3000);
      let k;
      while ((k = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, k));
        buf = buf.slice(k + 1);
      }
    };
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
    p.on("close", () => finish("exit"));
  });
}

async function calibrate(host, c) {
  if (c.calibration === "nonterminating") return { s: null, T: null, attempts: [] };
  let s = c.s0;
  const attempts = [];
  for (let a = 0; a <= MAX_RESIZE; a++) {
    const r = await session(host, c, s, [null], CAL_CAP_MS);
    const t = r.trials[0];
    const T = t.marks.RET && t.marks.ENTER ? t.marks.RET.t - t.marks.ENTER.t : null;
    attempts.push({ s, T_ms: T && Math.round(T), end: r.end, rss_kb: r.samples[0]?.rss_kb, ...(T == null ? { tail: r.tail } : {}) });
    if (T == null) {
      if (r.end === "budget" || r.end === "guard") s = c.grow(s, 0.25);
      else return { s, T: null, attempts, error: "no RET (" + r.end + ")" };
    } else if (T >= BAND.min && T <= BAND.max) return { s, T, attempts };
    else s = c.grow(s, ((BAND.min + BAND.max) / 2) / T);
    s = Math.max(c.smin, Math.min(c.smax, s));
    if (attempts.some((x) => x.s === s)) break;
  }
  return { s, T: null, attempts, error: "uncalibrated" };
}

async function runHost(host) {
  const rows = [];
  for (const c of CASES) {
    if (overBudget()) {
      rows.push({ case: c.id, host, mode: c.mode, outcome: "INVALID", why: "run budget spent" });
      record(rows.at(-1));
      continue;
    }
    const cal = await calibrate(host, c);
    if (c.calibration !== "nonterminating" && cal.T == null) {
      rows.push({ case: c.id, host, mode: c.mode, outcome: "INVALID", why: cal.error, calibration: cal });
      record(rows.at(-1));
      continue;
    }
    // 5 trials in one session: Stop at 0.5 T (or 1 s after ENTER) — the short leak series too
    const d = c.calibration === "nonterminating" ? 1000 : Math.round(cal.T * 0.5);
    const r = await session(host, c, cal.s, [d, d, d, d, d]);
    const trials = r.trials.map((t) => ({ i: t.i, ...classify(t) }));
    const outcome = againstBaseline({ case: c.id, host, outcome: rowOutcome(trials), trials }, BASELINE);
    const rss = r.samples.map((x) => x.rss_kb), thr = r.samples.map((x) => x.threads);
    rows.push({ case: c.id, host, mode: c.mode, outcome, s: cal.s, T_ms: cal.T && Math.round(cal.T), calibration: cal, trials, rss_kb: rss, threads: thr, end: r.end, wall_ms: Math.round(r.wall_ms), left_in_group: r.left, ...(trials.some((t) => t.outcome !== "PASS") ? { tail: r.tail } : {}) });
    record(rows.at(-1));
  }
  return rows;
}

const out = { started: new Date().toISOString(), node: process.version, hosts: {}, cases: CASES.map((c) => c.id) };
const tRun = now();
for (const h of HOSTS) {
  if (h === "browser") {
    const { browserPilot } = await import("./test-interrupt-browser.mjs");
    out.hosts[h] = overBudget() ? { skipped: "run budget spent" } : await browserPilot({ record, overBudget });
  } else out.hosts[h] = await runHost(h);
}
out.wall_ms = Math.round(now() - tRun);
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log("wrote", OUT, "in", out.wall_ms, "ms");
// the pilot measures and always exits 0; --ci fails on a new failure, an unresolved row, or a
// FIXED baseline row (remove its entry from web/interrupt-baseline.json in the same change)
const bad = Object.values(out.hosts).flatMap((v) => (Array.isArray(v) ? v : [])).filter((r) => ["FAIL", "FIXED", "INCOMPLETE"].includes(r.outcome));
for (const r of bad) console.log(r.outcome, r.case, r.host, r.outcome === "FIXED" ? "(remove its baseline entry)" : "");
process.exit(args.includes("--ci") && bad.length ? 1 : 0);
