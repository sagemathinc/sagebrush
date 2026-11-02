// The cost gate of history's change tokens (Stage A layer 1; design stage-a-l1 r2.1 §6 [D2] as amended by daybreak3's
// rulings (stage-a-l1-d2-statistic-daybreak3.md; the D2 settlement after the O1 power check l1-d2-o1-power-r1) and the
// grader's): the added per-save cost with history INACTIVE (what PROD ships), per workload, in Chromium and in Firefox.
// Builds, each served as its own bundle to the same page: BASE (origin/master's web/, or HCOST_BASE_DIR's tree, the
// packet's same-day master, its sha in HCOST_BASE_SHA), AA (the SAME base tree built again under another name: the
// noise control), HEAD (this tree), DELAY (this tree, noteToken with a 2 ms synchronous wait at its top: a timer would
// let the transaction commit).  Configurations: base, aa, head, delay (hactive unset); set (HEAD with hactive SET in
// the workspace's hmeta: informational for L1, its paired p50 delta <= 3 ms reported); tail (HEAD, with the harness
// adding 100 ms to every 10th save, inside the timed interval: the GC-tail gate's power control).
// Rounds: 5 per workload; round r runs every configuration once, in CONFIGS rotated by r.  Every run opens its own
// fresh databases and deletes them after.
// Per run: p50/p90/p95/p99/max; q = the share of its saves over 3 x the run's own p50 (stalled); its bursts (10 or more
// consecutive stalled saves, in completion order: the marker of one incremental major-GC cycle, reported, not gated);
// its wall time; performance.now()'s resolution (measured in the page before the run).
// The gate, per browser and workload (D(x) = the median of x's five within-round paired deltas against base):
//   A, central latency: B50 = the median of base's five p50s, T50 = min(1 ms, max(0.5 ms, 0.05 B50)).
//   B, the GC-tail burden: U = 0.01 (one percentage point of saves).
//   VALID only if  D_p50(aa) <= T50,  D_q(aa) <= U,  D_p50(delay) > T50  and  D_q(tail) > U  (else VOID, never PASS);
//   PASS if  D_p50(head) <= T50,  D_q(head) <= U  and head's p99 <= 250 ms in every run (the r6.4 backstop, the save's
//   end-to-end latency containing its transaction's wait; set's p99 reported).  p95 is reported only.
// STOPs (for daybreak3 + the grader, never a verdict), decided before the medians:  performance.now()'s resolution over
// 100 us in any run (compared in whole microseconds);  the instability/spread STOP: any of base, aa, head, delay and set
// whose five p50s have max > 2 x min AND max - min > 5 ms.  NOT tail (daybreak3's T1 ruling): its real sleeps alter the
// concurrent workload's contention by design, so its p50 is evidence, not an estimator; tail is judged only by
// D_q(tail) > U (and the resolution STOP), and its p50/p90/p95/p99/max, q, bursts and wall time are reported.  The
// rules' boundary and scope controls run before anything else; a wrong one is BAD.
// The two mutants' anchors (DELAY's patch in tokens.ts, TAIL's hook in the page) are preflighted before the run, and
// their expected outcomes declared: DELAY D_p50 > T50 and TAIL D_q > U in every workload and browser.
// Firefox runs in Playwright's own disposable profile with privacy.reduceTimerPrecision and resistFingerprinting off
// (its default rounds performance.now() to 1 ms), the same for every configuration; incremental GC stays on.
// Workloads (Chromium; Firefox x HCOST_FF_SCALE, 6 under the settlement: 3000 / 3000 / 4 x 1200):
//   files       500 serial writes of a 4 KiB data file (10 files round-robin)
//   notebooks   500 serial saves of a 50-cell notebook
//   concurrent  4 workspaces open on one database (4 tabs' worth, in one page), each 200 saves, files and notebooks mixed
//   CHROME=chromium PLAYWRIGHT=<dir with playwright 1.64.1> bun web/history/bench-history-cost.mjs [--out report.json]
// BROWSERS=chromium,firefox (the default, both) picks the legs.  Exit: 0 PASS, 1 FAIL, 2 BAD, 3 STOP, 76 VOID.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname, root = join(here, "../..");
const site = mkdtempSync(join(tmpdir(), "sb-hcost-site-")), base = mkdtempSync(join(tmpdir(), "sb-hcost-base-")), delay = mkdtempSync(join(tmpdir(), "sb-hcost-delay-"));
const die = (m) => { console.error("BAD: " + m); process.exit(2); };
// (BASE: origin/master's web/ and src/, as a pinned build is made in test-workspace-journal.mjs)
let master;
if (process.env.HCOST_BASE_DIR) {
  master = process.env.HCOST_BASE_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(master)) die("HCOST_BASE_SHA (the base tree's commit) is needed with HCOST_BASE_DIR");
  for (const d of ["web", "src"]) cpSync(join(process.env.HCOST_BASE_DIR, d), join(base, d), { recursive: true, filter: (p) => !/node_modules/.test(p) });
} else {
  master = spawnSync("git", ["rev-parse", "origin/master"], { cwd: root, encoding: "utf8" }).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(master)) die("origin/master isn't known here");
  if (spawnSync("sh", ["-c", `git archive ${master} web src | tar -x -C '${base}'`], { cwd: root }).status !== 0) die("master couldn't be unpacked");
}
const LEGS = (process.env.BROWSERS ?? "chromium,firefox").split(",");
if (!LEGS.length || LEGS.some((b) => !["chromium", "firefox"].includes(b))) die("BROWSERS: chromium and/or firefox");
symlinkSync(join(root, "node_modules"), join(base, "node_modules"));
// (DELAY: this tree's web/ with the injected wait)
cpSync(join(root, "web"), join(delay, "web"), { recursive: true, filter: (p) => !/node_modules/.test(p) });
cpSync(join(root, "src"), join(delay, "src"), { recursive: true });
symlinkSync(join(root, "node_modules"), join(delay, "node_modules"));
{
  const p = join(delay, "web/history/tokens.ts"), s = readFileSync(p, "utf8"), a = "export async function noteToken(tx: IDBTransaction, t: TokenInput): Promise<void> {\n";
  if (s.split(a).length !== 2) die("the delay patch doesn't apply");
  writeFileSync(p, s.replace(a, a + "  { const t0 = performance.now(); while (performance.now() - t0 < 2) {} }\n"));
}
const build = async (entry, naming) => {
  const b = await Bun.build({ entrypoints: [entry], outdir: site, naming, target: "browser", format: "esm" });
  if (!b.success) die(b.logs.join("\n"));
};
for (const [name, dir] of [["base", base], ["aa", base], ["head", root], ["delay", delay]]) await build(join(dir, "web/workspace/index.ts"), `ws-${name}.js`);
writeFileSync(join(site, "bench.js"), `
const N = { files: 500, notebooks: 500, concurrent: 200 };
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };
// (hactive SET: one raw write into the workspace database's hmeta, as no production setter exists)
const activate = (name) => new Promise((ok, no) => {
  const r = indexedDB.open(name);
  r.onerror = () => no(r.error);
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains("hmeta")) { db.close(); return no(new Error("no hmeta in " + name)); }
    const tx = db.transaction("hmeta", "readwrite");
    tx.objectStore("hmeta").put(true, "hactive");
    tx.oncomplete = () => { db.close(); ok(); };
    tx.onabort = () => { db.close(); no(tx.error); };
  };
});
const nb = (k) => ({ cells: Array.from({ length: 50 }, (_, i) => ({ id: "c" + i, cell_type: "code", source: "x = " + i + "  # " + k })), mode: "python" });
let runs = 0;
// (performance.now()'s resolution: the median of 200 positive steps)
export function resolution() {
  const steps = [];
  let last = performance.now();
  while (steps.length < 200) { const t = performance.now(); if (t > last) { steps.push(t - last); last = t; } }
  return pct(steps, 0.5);
}
export async function bench(config, workload, scale = 1) {
  const res = resolution();
  const W = await import("./ws-" + (config === "set" || config === "tail" ? "head" : config) + ".js");
  const name = "hcost-" + config + "-" + workload + "-" + (++runs), mainName = name + "-m";
  const w = await W.Workspace.open({ name, mainName });
  if (config === "set") await activate(name);
  const bytes = new Uint8Array(4096).fill(7), out = [];
  let started = 0;
  const one = async (w, i, kind) => {
    const t0 = performance.now();
    // TAIL-ANCHOR: the tail mutant's hook (every 10th save started, 100 ms inside the timed interval)
    if (config === "tail" && ++started % 10 === 0) await new Promise((ok) => setTimeout(ok, 100));
    if (kind === "file") await w.write("/f" + (i % 10) + ".bin", bytes);
    else await w.write("/n" + (i % 10) + ".ipynb", nb(i));
    out.push(performance.now() - t0);
  };
  const wall0 = performance.now();
  for (let i = 0; i < 10; i++) { await w.create("/f" + i + ".bin", { content: bytes }); await w.create("/n" + i + ".ipynb"); }
  let ws = [w];
  if (workload === "concurrent") {
    ws = [w, ...(await Promise.all([1, 2, 3].map(() => W.Workspace.open({ name, mainName }))))];
    await Promise.all(ws.map(async (x, k) => { for (let i = 0; i < N.concurrent * scale; i++) await one(x, i * 4 + k, i % 2 ? "file" : "nb"); }));
  } else for (let i = 0; i < N[workload] * scale; i++) await one(w, i, workload === "files" ? "file" : "nb");
  const wall = performance.now() - wall0, p50 = pct(out, 0.5), stalled = out.map((x) => x > 3 * p50), bursts = [];
  for (let i = 0, k = 0; i <= stalled.length; i++) { if (i < stalled.length && stalled[i]) k++; else { if (k >= 10) bursts.push(k); k = 0; } }
  const r = { n: out.length, wall, p50, p90: pct(out, 0.9), p95: pct(out, 0.95), p99: pct(out, 0.99), max: Math.max(...out), stalled: stalled.filter(Boolean).length, q: stalled.filter(Boolean).length / out.length, bursts, res };
  for (const x of ws) x.close();
  for (const d of [name, mainName]) await new Promise((ok) => { const q = indexedDB.deleteDatabase(d); q.onsuccess = q.onerror = q.onblocked = () => ok(); });
  return r;
}
`);
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>history cost</title><script type="module">import { bench, resolution } from "./bench.js"; window.bench = bench; window.resolution = resolution; window.ready = true;</script>`);
const FILES = ["/bench.js", "/ws-base.js", "/ws-aa.js", "/ws-head.js", "/ws-delay.js"];
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (p !== "/" && !FILES.includes(p)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, p === "/" ? "index.html" : p.slice(1))), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });
const url = `http://127.0.0.1:${server.port}/`, sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// (a browser as one function: evaluate(expr) in a page at `url`)
async function chromium() {
  const profile = mkdtempSync(join(tmpdir(), "sb-hcost-")), chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
  const port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1000)); return r.result.value; };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url });
  for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
  const version = (await send("Browser.getVersion")).product;
  return { ev, version, close: () => { ws.close(); try { process.kill(-chrome.pid, "SIGKILL"); } catch {} rmSync(profile, { recursive: true, force: true }); } };
}
async function firefox() {
  if (!process.env.PLAYWRIGHT) die("PLAYWRIGHT (the directory of playwright 1.64.1) is needed for Firefox");
  const pw = createRequire(join(process.env.PLAYWRIGHT, "package.json"))("playwright");
  const browser = await pw.firefox.launch({ firefoxUserPrefs: { "privacy.reduceTimerPrecision": false, "privacy.resistFingerprinting": false } }), page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction("window.ready === true");
  return { ev: (expression) => page.evaluate(expression), close: () => browser.close(), version: browser.version() };
}

// (the instability/spread STOP, on each configuration's five p50s, and its boundary controls: each conjunct at
// equality is NOT past, just above is)
const spreadStop = (xs) => { const hi = Math.max(...xs), lo = Math.min(...xs); return hi > 2 * lo && hi - lo > 5; };
for (const [xs, want, what] of [
  [[5, 10, 6, 7, 8], false, "max = 2 x min exactly (and max - min = 5): not past"],
  [[5, 10.01, 6, 7, 8], true, "max just above 2 x min, max - min just above 5: past"],
  [[6, 12, 7, 8, 9], false, "max = 2 x min exactly, max - min 6 > 5: not past (the ratio conjunct)"],
  [[6, 12.01, 7, 8, 9], true, "max just above 2 x min, max - min > 5: past"],
  [[4, 9, 5, 6, 7], false, "max > 2 x min, max - min = 5 exactly: not past (the spread conjunct)"],
  [[4, 9.01, 5, 6, 7], true, "max > 2 x min, max - min just above 5: past"],
  [[2, 6, 3, 3, 3], false, "max 3 x min but max - min 4 < 5: not past"],
  [[30, 59, 40, 40, 40], false, "max - min 29 > 5 but max < 2 x min: not past"],
  [[4, 4, 4, 4, 4], false, "no spread: not past"],
]) if (spreadStop(xs) !== want) die(`the spread STOP's boundary control: ${what} (${xs.join(", ")})`);
// (its scope, T1: base, aa, head, delay and set; never tail.  Scope controls: an arbitrarily spread tail with every other
// configuration calm STOPs nothing; the same spread in each in-scope configuration STOPs exactly that one)
const SPREAD_SCOPE = ["base", "aa", "head", "delay", "set"];
const spreadOf = (p50s) => SPREAD_SCOPE.filter((c) => spreadStop(p50s[c]));
{
  const calm = [10, 10.2, 9.9, 10.1, 10], wild = [5, 30, 8, 40, 6], all = ["base", "aa", "head", "delay", "set", "tail"];
  const with_ = (c) => Object.fromEntries(all.map((k) => [k, k === c ? wild : calm]));
  if (!spreadStop(wild)) die("the spread STOP's scope control: the wild series isn't past the rule");
  if (spreadOf(with_("tail")).length !== 0) die("the spread STOP's scope control: a spread tail STOPs");
  // (the ruled scope, written out here independently of SPREAD_SCOPE, so a narrowed or widened scope is caught)
  for (const c of ["base", "aa", "head", "delay", "set"]) if (spreadOf(with_(c)).join() !== c) die(`the spread STOP's scope control: a spread ${c} doesn't STOP (alone)`);
}
// (the resolution STOP, in whole microseconds, and its boundary controls: 100 us is not past, 101 us is)
const resStop = (ms) => Math.round(ms * 1000) > 100;
for (const [ms, want, what] of [
  [0.1, false, "exactly 100 us: not past"],
  [0.10000000009313226, false, "100 us read a hair over by float subtraction: not past"],
  [0.09999999997671694, false, "100 us read a hair under: not past"],
  [0.0200, false, "20 us: not past"],
  [0.101, true, "101 us: past"],
  [1, true, "1 ms (Firefox's default rounding): past"],
]) if (resStop(ms) !== want) die(`the resolution STOP's boundary control: ${what} (${ms})`);
// (the two mutants' anchors, preflighted: DELAY's patch landed exactly once; TAIL's hook is in the page exactly once)
{
  const d = readFileSync(join(delay, "web/history/tokens.ts"), "utf8"), b = readFileSync(join(site, "bench.js"), "utf8");
  if (d.split("while (performance.now() - t0 < 2) {}").length !== 2) die("the DELAY mutant's anchor isn't in place exactly once");
  if (b.split("TAIL-ANCHOR").length !== 2 || b.split('config === "tail" && ++started % 10 === 0').length !== 2) die("the TAIL mutant's anchor isn't in place exactly once");
}
const CONFIGS = ["base", "aa", "head", "delay", "set", "tail"], ROUNDS = 5, FF_SCALE = +(process.env.HCOST_FF_SCALE ?? 1), U = 0.01;
if (!(Number.isInteger(FF_SCALE) && FF_SCALE >= 1 && FF_SCALE <= 20)) die("HCOST_FF_SCALE: an integer 1..20");
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const report = { master, statistic: "daybreak3's settlement: A, median paired p50 deltas vs T50 = min(1, max(0.5, 0.05 B50)); B, median paired q deltas vs U = 0.01; head p99 <= 250 ms", declared: "DELAY: D_p50 > T50 and TAIL: D_q > U, in every workload and browser; A/A within both", browsers: {} };
console.log(`declared: ${report.declared}; Firefox scale ${FF_SCALE}`);
const verdicts = [];
try {
  for (const [bname, open] of [["chromium", chromium], ["firefox", firefox]]) {
    if (!LEGS.includes(bname)) continue;
    const b = await open(), rows = {};
    console.log(`${bname}: ${b.version}`);
    for (const workload of ["files", "notebooks", "concurrent"]) {
      const runs = Object.fromEntries(CONFIGS.map((c) => [c, []])), order = [];
      for (let r = 0; r < ROUNDS; r++) {
        const turn = CONFIGS.map((_, k) => CONFIGS[(k + r) % CONFIGS.length]);
        order.push(turn);
        for (const c of turn) runs[c].push(await b.ev(`window.bench(${JSON.stringify(c)}, ${JSON.stringify(workload)}, ${bname === "firefox" ? FF_SCALE : 1})`));
      }
      if (CONFIGS.some((c) => runs[c].some((x) => !(x.n > 0 && [x.p50, x.p95, x.p99, x.q, x.res].every(Number.isFinite))))) die(`${bname} ${workload}: a run measured nothing`);
      const of = (c, k) => runs[c].map((x) => x[k]);
      const B50 = med(of("base", "p50")), T50 = Math.min(1, Math.max(0.5, 0.05 * B50));
      const pairedOf = (k) => Object.fromEntries(["aa", "head", "delay", "set", "tail"].map((c) => [c, runs[c].map((x, r) => x[k] - runs.base[r][k])]));
      const P50 = pairedOf("p50"), Q = pairedOf("q");
      const D = Object.fromEntries(Object.entries(P50).map(([c, d]) => [c, med(d)])), DQ = Object.fromEntries(Object.entries(Q).map(([c, d]) => [c, med(d)]));
      const p99 = Object.fromEntries(CONFIGS.map((c) => [c, Math.max(...of(c, "p99"))]));
      const resMax = Math.max(...CONFIGS.flatMap((c) => of(c, "res")));
      const spread = spreadOf(Object.fromEntries(CONFIGS.map((c) => [c, of(c, "p50")])));
      const stop = [...(resStop(resMax) ? [`performance.now() resolution ${Math.round(resMax * 1000)} us > 100 us`] : []), ...(spread.length ? [`instability/spread (p50): ${spread.join(", ")}`] : [])];
      const valid = D.aa <= T50 && DQ.aa <= U && D.delay > T50 && DQ.tail > U, pass = D.head <= T50 && DQ.head <= U, backstop = p99.head <= 250;
      const verdict = stop.length ? "STOP" : !valid ? "VOID" : pass && backstop ? "PASS" : "FAIL";
      verdicts.push(verdict);
      rows[workload] = { verdict, stop, B50, T50, U, D, DQ, P50, Q, p99, resMax, valid, pass, backstop, setWithin3: D.set <= 3, order, runs };
      const f = (x) => x.toFixed(2), pp = (x) => (100 * x).toFixed(2) + " pp";
      console.log(`${bname} ${workload}: ${verdict}${stop.length ? " (" + stop.join("; ") + ")" : ""}: B50 ${f(B50)} ms, T50 ${f(T50)} ms; paired p50 medians A/A ${f(D.aa)} (${D.aa <= T50 ? "within" : "PAST"}), head ${f(D.head)} (${D.head <= T50 ? "within" : "PAST"}), delay ${f(D.delay)} (${D.delay > T50 ? "caught" : "NOT CAUGHT"}), set ${f(D.set)} ms (${D.set <= 3 ? "within" : "past"} 3 ms, reported); paired q medians A/A ${pp(DQ.aa)} (${DQ.aa <= U ? "within" : "PAST"}), head ${pp(DQ.head)} (${DQ.head <= U ? "within" : "PAST"}), tail ${pp(DQ.tail)} (${DQ.tail > U ? "caught" : "NOT CAUGHT"}); p99 head ${f(p99.head)} (${backstop ? "within" : "PAST"} 250 ms) set ${f(p99.set)} ms; resolution ${Math.round(resMax * 1000)} us`);
      for (const c of CONFIGS) console.log(`  ${c.padEnd(5)} p50 ${of(c, "p50").map(f).join(" / ")}; p90 ${of(c, "p90").map(f).join(" / ")}; p95 ${of(c, "p95").map(f).join(" / ")}; p99 ${of(c, "p99").map(f).join(" / ")}; max ${of(c, "max").map(f).join(" / ")}; q ${of(c, "q").map(pp).join(" / ")}; bursts ${runs[c].map((x) => "[" + x.bursts.join(",") + "]").join(" ")}; wall s ${runs[c].map((x) => (x.wall / 1000).toFixed(1)).join(" / ")}`);
    }
    report.browsers[bname] = { version: b.version, scale: bname === "firefox" ? FF_SCALE : 1, rows };
    await b.close();
  }
} finally {
  server.stop(true);
  for (const d of [site, base, delay]) rmSync(d, { recursive: true, force: true });
}
const oi = process.argv.indexOf("--out");
if (oi > 0) writeFileSync(process.argv[oi + 1], JSON.stringify(report, null, 1));
const v = verdicts.includes("STOP") ? "STOP" : verdicts.includes("VOID") ? "VOID" : verdicts.includes("FAIL") ? "FAIL" : "PASS";
console.log(`HCOST: ${v} (${LEGS.join(" + ")}; ${verdicts.join(" ")})`);
process.exit({ PASS: 0, FAIL: 1, STOP: 3, VOID: 76 }[v]);
