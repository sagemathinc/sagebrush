// The cost gate of history's change tokens (Stage A layer 1; design stage-a-l1 r2.1 §6 [D2] as amended by daybreak3's
// statistic ruling (stage-a-l1-d2-statistic-daybreak3.md) and the grader's G-1..G-5): the added per-save cost with
// history INACTIVE (what PROD ships), per workload, in Chromium and in Firefox.
// Builds, each served as its own bundle to the same page: BASE (origin/master's web/, or HCOST_BASE_DIR's tree, the
// packet's same-day master, its sha in HCOST_BASE_SHA), AA (the SAME base tree built again under another name: the
// noise control), HEAD (this tree), DELAY (this tree, noteToken with a 2 ms synchronous wait at its top: a timer would
// let the transaction commit).  Configurations: base, aa, head, delay (hactive unset) and set (HEAD with hactive SET in
// the workspace's hmeta: informational for L1, its paired delta <= 3 ms reported).
// Rounds: 5 per workload; round r runs every configuration once, in CONFIGS rotated by r (a Latin square: each
// configuration once at each position).  Every run opens its own fresh databases and deletes them after (P5).
// The statistic (daybreak3): per round, the paired p95 deltas head-base, aa-base, delay-base (and set-base); D(x) = the
// median of x's five.  B = the median of base's five p95s; T = min(1 ms, max(0.5 ms, 0.05 B)).  Per browser and
// workload:  VALID only if D(aa) <= T and D(delay) > T (otherwise the leg is VOID, never PASS);  PASS if D(head) <= T.
// Also: the r6.4 backstop, a transaction wait <= 250 ms at p99, judged conservatively on the end-to-end p99 of head and
// set (the save's latency contains its transaction's wait); every raw p95/p99 and the worst-of-5 reported.
// STOPs (for daybreak3 + the grader, never a verdict): performance.now()'s resolution over 0.1 ms in any run (measured
// in the page before each run); the instability/spread STOP (daybreak3, the grader): any configuration whose five round
// p95s have max > 2 x min AND max - min > 5 ms, decided before the medians; its boundary controls (equal, below, above
// for each conjunct) run before anything else, and a wrong one is BAD.
// Firefox runs in Playwright's own disposable profile with privacy.reduceTimerPrecision and resistFingerprinting off
// (its default rounds performance.now() to 1 ms), the same for every configuration.
// Workloads:
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
export async function bench(config, workload) {
  const res = resolution();
  const W = await import("./ws-" + (config === "set" ? "head" : config) + ".js");
  const name = "hcost-" + config + "-" + workload + "-" + (++runs), mainName = name + "-m";
  const w = await W.Workspace.open({ name, mainName });
  if (config === "set") await activate(name);
  const bytes = new Uint8Array(4096).fill(7), out = [];
  const one = async (w, i, kind) => {
    const t0 = performance.now();
    if (kind === "file") await w.write("/f" + (i % 10) + ".bin", bytes);
    else await w.write("/n" + (i % 10) + ".ipynb", nb(i));
    out.push(performance.now() - t0);
  };
  for (let i = 0; i < 10; i++) { await w.create("/f" + i + ".bin", { content: bytes }); await w.create("/n" + i + ".ipynb"); }
  let ws = [w];
  if (workload === "concurrent") {
    ws = [w, ...(await Promise.all([1, 2, 3].map(() => W.Workspace.open({ name, mainName }))))];
    await Promise.all(ws.map(async (x, k) => { for (let i = 0; i < N.concurrent; i++) await one(x, i * 4 + k, i % 2 ? "file" : "nb"); }));
  } else for (let i = 0; i < N[workload]; i++) await one(w, i, workload === "files" ? "file" : "nb");
  const r = { n: out.length, p95: pct(out, 0.95), p99: pct(out, 0.99), res };
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

// (the instability/spread STOP, and its boundary controls: each conjunct at equality is NOT past, just above is)
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
const CONFIGS = ["base", "aa", "head", "delay", "set"], ROUNDS = 5;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const report = { master, statistic: "daybreak3: median of within-round paired p95 deltas, T = min(1, max(0.5, 0.05 B))", browsers: {} };
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
        for (const c of turn) runs[c].push(await b.ev(`window.bench(${JSON.stringify(c)}, ${JSON.stringify(workload)})`));
      }
      if (CONFIGS.some((c) => runs[c].some((x) => !(x.n > 0 && Number.isFinite(x.p95) && Number.isFinite(x.p99) && Number.isFinite(x.res))))) die(`${bname} ${workload}: a run measured nothing`);
      const p95 = (c) => runs[c].map((x) => x.p95);
      const B = med(p95("base")), T = Math.min(1, Math.max(0.5, 0.05 * B));
      const paired = Object.fromEntries(["aa", "head", "delay", "set"].map((c) => [c, runs[c].map((x, r) => x.p95 - runs.base[r].p95)]));
      const D = Object.fromEntries(Object.entries(paired).map(([c, d]) => [c, med(d)]));
      const worst = Object.fromEntries(CONFIGS.map((c) => [c, Math.max(...p95(c))]));
      const p99 = Object.fromEntries(CONFIGS.map((c) => [c, Math.max(...runs[c].map((x) => x.p99))]));
      const resMax = Math.max(...CONFIGS.flatMap((c) => runs[c].map((x) => x.res)));
      const spread = CONFIGS.filter((c) => spreadStop(p95(c)));
      const stop = [...(resMax > 0.1 ? [`performance.now() resolution ${resMax.toFixed(4)} ms > 0.1 ms`] : []), ...(spread.length ? [`instability/spread: ${spread.join(", ")}`] : [])];
      const valid = D.aa <= T && D.delay > T, pass = D.head <= T, backstop = p99.head <= 250 && p99.set <= 250;
      const verdict = stop.length ? "STOP" : !valid ? "VOID" : pass && backstop ? "PASS" : "FAIL";
      verdicts.push(verdict);
      rows[workload] = { verdict, stop, B, T, D, paired, worst, p99, resMax, valid, pass, backstop, setWithin3: D.set <= 3, order, runs };
      const f = (x) => x.toFixed(2);
      console.log(`${bname} ${workload}: ${verdict}${stop.length ? " (" + stop.join("; ") + ")" : ""}: B ${f(B)} ms, T ${f(T)} ms; paired medians A/A ${f(D.aa)} (${D.aa <= T ? "within" : "PAST"}), head ${f(D.head)} (${pass ? "within" : "PAST"}), delay ${f(D.delay)} (${D.delay > T ? "caught" : "NOT CAUGHT"}), set ${f(D.set)} ms (${D.set <= 3 ? "within" : "past"} 3 ms, reported); p99 head ${f(p99.head)} set ${f(p99.set)} ms (${backstop ? "within" : "PAST"} 250 ms); resolution <= ${resMax.toFixed(4)} ms`);
      for (const c of CONFIGS) console.log(`  ${c.padEnd(5)} p95 ${p95(c).map(f).join(" / ")} (worst ${f(worst[c])})`);
    }
    report.browsers[bname] = { version: b.version, rows };
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
