// The interrupt matrix (item B): start each expensive operation, interrupt it partway, and
// check that the interrupt is recognized (and how long it took), that the session survives
// (the same process, `keep` still defined), that the next call on the same route works,
// and that repeats leak neither threads nor memory.  Hosts:
//   cli     node packages/sagebrush/bin/sagebrush.cjs PROGRAM (the npm launcher), with SIGINT;
//   prompt  the same launcher's interactive prompt, in a pseudo-terminal (script -qfec), with Ctrl-C;
//   browser the notebook page's worker, with its Stop button (served at SB_URL, Chromium over CDP).
// Usage:
//   node web/test-interrupt-matrix.mjs [--pilot | --ci | --full] [--host cli,prompt,browser] [--rows P1,E2]
//        [--out FILE] [--budget-ms N]
// Each case is calibrated on each host (uninterrupted, capped, a bounded number of resizes).  Its
// row's required cells are then 5 repeats at 0.5 T (1 s after the target starts for a loop
// without an end), the short leak check; --full adds the early/middle/late phases and makes the
// leak series 20 repeats (plan-interrupt-harness r4 §3, §6.1, §8).  Rows are checked against
// web/interrupt-baseline.json; --ci exits 1 on FAIL, INCOMPLETE or FIXED.
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { againstBaseline, classify, classifyXK, leakCheck, xkRowOutcome } from "./interrupt-classify.mjs";
import { killTree, procTable, sessionTree, survivors } from "./interrupt-procs.mjs";
const BASELINE = JSON.parse(readFileSync(new URL("./interrupt-baseline.json", import.meta.url), "utf8"));

const ROOT = new URL("..", import.meta.url).pathname;
const LAUNCHER = process.env.SB_LAUNCHER ?? join(ROOT, "packages/sagebrush/bin/sagebrush.cjs"); // (SB_LAUNCHER: another build, for checking the harness)
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
// --pilot (default): 5 trials at the middle per row; --ci: the plan's CI set (r4 §8), baseline
// rows watched 20 s; --full (VM): early/middle/late cells and the 20-repeat leak series
const MODE = args.includes("--full") ? "full" : args.includes("--ci") ? "ci" : "pilot";
const G_MS = 120_000; // the hang guard after a Stop (test infrastructure, not a computation limit)
const BASELINE_WINDOW_MS = 20_000; // CI only: a baseline row's signature is pinned (r4 §8)
const CAL_CAP_MS = 60_000; // one uninterrupted calibration run at most
const BAND = MODE === "full" ? { min: 6_000, max: 30_000 } : { min: 3_000, max: 8_000 }; // VM / CI bands (r4 §3)
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
  { id: "E13g", mode: "sage", s0: 40, smin: 4, smax: 4000, grow: (s, r) => Math.max(1, Math.round(s * r)), xk: { kind: "window", wrap: "_sbraster.render" }, setup: "import tempfile, os\n_d = tempfile.mkdtemp()\nP = sum(polygon([(0, 0), (1, 0.1 * (j % 10)), (1, 1), (0.1 * (j % 7), 1)], alpha=0.02) for j in range(S))", target: "P.save(os.path.join(_d, 'big.png'), figsize=40, dpi=100)", probe: "line([(0, 0), (1, 1)]).save(os.path.join(_d, 'small.png'), figsize=1, dpi=100)\nassert os.path.getsize(os.path.join(_d, 'small.png')) > 0" },
].filter((c) => !ROWS || ROWS.split(",").includes(c.id));
const FLAGS = { python: [], sage: ["--sage"], magma: ["--magma"], matlab: ["--matlab"] };

const indent = (src, n) => src.split("\n").map((l) => " ".repeat(n) + l).join("\n");
// a driver: trials 1..n, each with markers (plan r3 §1); setup and probes outside the narrow try
function driver(c, s, n) {
  const sz = (src) => src.replace(/\bS\b/g, String(s ?? 0));
  const setup = c.setup ? sz(c.setup) : "pass";
  const [wm, wf] = c.xk?.kind === "window" ? c.xk.wrap.split(".") : [];
  const wrap = wm
    ? `import ${wm} as _xm
_xorig = _xm.${wf}
def _xwrap(*a, **k):
    _p("XSTART", _i, time.monotonic())
    r = _xorig(*a, **k)
    _p("XEND", _i)
    return r
_xm.${wf} = _xwrap
`
    : "";
  return `import time
keep = 41
_i = 0
def _p(*a):
    print(*a, flush=True)
${wrap}for _i in range(1, ${n} + 1):
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

// --print-driver CASE [S] [N]: the driver's source, for checking it by hand; runs nothing
if (args.includes("--print-driver")) {
  const [id, sz, n] = args.slice(args.indexOf("--print-driver") + 1);
  const c = CASES.find((x) => x.id === id);
  if (!c) { console.error("no case " + id); process.exit(2); }
  process.stdout.write(driver(c, sz ? Number(sz) : c.s0, n ? Number(n) : 1));
  process.exit(0);
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
// sessions still running: killed if the harness itself is stopped (timeout, Ctrl-C)
const live = new Map(); // root -> known
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { for (const [r, k] of live) killTree(r, k); process.exit(128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[sig]); });
process.on("exit", () => { for (const [r, k] of live) killTree(r, k); });

// ---- running one session (cli or prompt): delays[i] (ms after ENTER i, or null for none)
// returns the per-trial evidence, read on the harness's own clock
function session(host, c, s, delays, budget_ms = CAL_CAP_MS + G_MS * delays.length, guard_ms = G_MS) {
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
    const known = new Map();
    live.set(p.pid, known);
    const remember = () => { const t = procTable(); for (const q of sessionTree(p.pid, known)) if (t.has(q)) known.set(q, t.get(q).start); };
    const watch = setInterval(remember, 1000);
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(overall);
      if (guard) clearTimeout(guard);
      clearInterval(watch);
      const killed = killTree(p.pid, known);
      setTimeout(() => {
        const left = survivors(killed);
        if (left.length === 0) live.delete(p.pid);
        resolve({ trials, samples, end: why, wall_ms: now() - t0, left, tail: tail.slice(-1500) });
      }, 500);
    };
    const onLine = (line) => {
      const m = line.replace(/\r/g, "").match(/^(SETUP|ENTER|RET|KI|PROBE|STRAY|DONE|END|XSTART|XEND)\b ?(\d+)? ?(.*)$/);
      if (!m) return;
      const [, mk, si, rest] = m;
      if (mk === "END") return finish("end");
      const t = trials[Number(si) - 1];
      if (!t) return;
      // (the window's markers: the target's call is the first; a probe on the same route repeats them)
      if ((mk === "XSTART" || mk === "XEND") && t.marks[mk]) return;
      t.marks[mk] = { t: now(), rest };
      if (mk === "ENTER" && delays[t.i - 1] != null) {
        const id = t.i;
        setTimeout(() => {
          // (a send never outlives its trial: no RET/KI yet for this id)
          if (trials[id - 1].marks.RET || trials[id - 1].marks.KI) return;
          trials[id - 1].t_send = now();
          if (host === "cli") process.kill(p.pid, "SIGINT");
          else p.stdin.write("\x03");
          guard = setTimeout(() => finish("guard"), guard_ms);
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
    const R = t.marks.XSTART && t.marks.XEND ? t.marks.XEND.t - t.marks.XSTART.t : null;
    attempts.push({ s, T_ms: T && Math.round(T), ...(c.xk?.kind === "window" ? { R_ms: R && Math.round(R) } : {}), end: r.end, left: r.left, rss_kb: r.samples[0]?.rss_kb, ...(T == null ? { tail: r.tail } : {}) });
    if (T == null) {
      if (r.end === "budget" || r.end === "guard") s = c.grow(s, 0.25);
      else return { s, T: null, attempts, error: "no RET (" + r.end + ")" };
    } else if (c.xk?.kind === "window" && R == null) return { s, T: null, attempts, error: "the wrapped call " + c.xk.wrap + " never ran" };
    else if (T >= BAND.min && T <= BAND.max) return { s, T, R, attempts };
    else s = c.grow(s, ((BAND.min + BAND.max) / 2) / T);
    s = Math.max(c.smin, Math.min(c.smax, s));
    if (attempts.some((x) => x.s === s)) break;
  }
  return { s, T: null, attempts, error: "uncalibrated" };
}

async function runHost(host) {
  const rows = [];
  for (const c of CASES) {
    // the CI set (r5 §8): the CLI's five rows, the prompt's two; everything else is VM-only
    if (MODE === "ci" && !(host === "prompt" ? ["P1", "E2"] : ["P1", "P2a", "E2", "E3a", "E6a"]).includes(c.id)) continue;
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
    const nonterm = c.calibration === "nonterminating";
    const at = (f) => (nonterm ? { "0.15": 1000, "0.5": 1000, "0.85": 1000 }[f] : Math.round(cal.T * Number(f)));
    const inBaseline = (BASELINE.entries ?? []).some((e) => e.case === c.id && e.host === host);
    const guard_ms = MODE === "ci" && inBaseline ? BASELINE_WINDOW_MS : G_MS;
    const sessions = [];
    // an XK case's per-cell context (r5 §6.2): the window's R(s), or the bound's T and f
    const xkOf = (delay) => (!c.xk ? null : c.xk.kind === "window" ? { kind: "window", R_ms: cal.R } : { kind: "bound", T_ms: cal.T, f: delay / cal.T });
    const cls = (t, delay) => classifyXK(t, xkOf(delay));
    const run = async (label, delays) => {
      const r = await session(host, c, cal.s, delays, CAL_CAP_MS + guard_ms * delays.length, guard_ms);
      sessions.push({ label, end: r.end, wall_ms: Math.round(r.wall_ms), left: r.left, samples: r.samples, ...(r.trials.some((t) => classify(t).outcome !== "PASS") ? { tail: r.tail } : {}) });
      return r;
    };
    // the required cells: early/middle/late (1/3/10 s without an end) in --full, else the middle
    const offsets = MODE === "full" ? (nonterm ? [1000, 3000, 10000] : ["0.15", "0.5", "0.85"].map(at)) : [];
    const cells = [];
    if (offsets.length) {
      const r = await run("phases", offsets);
      for (const t of r.trials) cells.push({ cell: "phase", delay_ms: offsets[t.i - 1], ...cls(t, offsets[t.i - 1]) });
    }
    // the leak series, whose repeats are cells too: 20 in --full, 5 (the short check) otherwise
    const reps = MODE === "full" ? 20 : 5;
    const d = at("0.5");
    const lr = await run("repeats", Array(reps).fill(d));
    for (const t of lr.trials) cells.push({ cell: "repeat", i: t.i, delay_ms: d, ...cls(t, d) });
    // one retry for a cell whose target returned before the Stop, at 0.6 of its delay (r4 §3)
    for (const [k, x] of cells.entries()) {
      if (overBudget() || x.outcome !== "INVALID" || x.why !== "returned before the Stop") continue;
      const rd = Math.round(x.delay_ms * 0.6);
      const rr = await run("retry", [rd]);
      cells[k] = { cell: x.cell, ...(x.i != null ? { i: x.i } : {}), ...cls(rr.trials[0], rd), delay_ms: rd, retried_from_ms: x.delay_ms };
    }
    // a process that outlived its session's kill is a leaked worker: the row fails (r4 §1)
    const left = [...cal.attempts, ...sessions].flatMap((x) => x.left ?? []);
    const leak0 = leakCheck(lr.samples);
    const leak = left.length ? { ...(leak0 ?? {}), ok: false, survived_kill: left } : leak0;
    const { outcome: own, why: rowWhy } = xkRowOutcome(cells, leak && leak.ok, c.xk);
    const outcome = againstBaseline({ case: c.id, host, outcome: own, trials: cells, leak }, BASELINE);
    rows.push({ case: c.id, host, mode: c.mode, run: MODE, outcome, ...(outcome !== own ? { own_outcome: own } : {}), ...(rowWhy ? { why: rowWhy } : {}), ...(c.xk ? { xk: c.xk.kind } : {}), s: cal.s, T_ms: cal.T && Math.round(cal.T), ...(cal.R != null ? { R_ms: Math.round(cal.R) } : {}), calibration: cal, cells, leak, sessions });
    record(rows.at(-1));
  }
  return rows;
}

const out = { started: new Date().toISOString(), node: process.version, run: MODE, hosts: {}, cases: CASES.map((c) => c.id) };
// --signals S1,S2,...,pending (default: all; "none" skips them): the signal-state trials (r5 §8.1)
const SIGNALS = opt("--signals", "all");
const tRun = now();
for (const h of HOSTS) {
  if (h === "browser") {
    const { browserPilot } = await import("./test-interrupt-browser.mjs");
    // (a browser that can't start is an uncovered host, reported, not a crash that loses the run)
    out.hosts[h] = overBudget() ? { skipped: "run budget spent" } : await browserPilot({ record, overBudget, baseline: BASELINE }).catch((e) => ({ error: String(e?.stack ?? e).slice(0, 600), rows: [] }));
  } else out.hosts[h] = await runHost(h);
}
if (SIGNALS !== "none") {
  const { runSignals } = await import("./interrupt-signals.mjs");
  out.signals = await runSignals({ hosts: HOSTS.filter((h) => h !== "browser"), mode: MODE, record, overBudget, baseline: BASELINE, only: SIGNALS === "all" ? null : SIGNALS.split(",") });
}
out.wall_ms = Math.round(now() - tRun);
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log("wrote", OUT, "in", out.wall_ms, "ms");
// the pilot measures and always exits 0; --ci fails on a new failure, an unresolved or uncovered
// row (INCOMPLETE; INVALID: uncalibrated or out of budget), or a FIXED baseline row (remove its
// entry from web/interrupt-baseline.json in the same change)
const rowsOf = (h, v) => (Array.isArray(v) ? v : v?.rows?.length ? v.rows : [{ case: "*", host: h, outcome: "INVALID", why: v?.skipped ?? v?.error ?? "no rows" }]);
const bad = [...Object.entries(out.hosts).flatMap(([h, v]) => rowsOf(h, v)), ...(out.signals ?? [])].filter((r) => ["FAIL", "FIXED", "INCOMPLETE", "INVALID", "PENDING-READY"].includes(r.outcome));
for (const r of bad) console.log(r.outcome, r.case ?? r.trial, r.host ?? "", r.outcome === "FIXED" ? "(remove its baseline entry)" : r.outcome === "PENDING-READY" ? "(its capability is present: make it required)" : r.why ?? "");
process.exit(args.includes("--ci") && bad.length ? 1 : 0);
