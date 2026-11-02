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
//   VALID only if  D_p50(aa) <= T50,  D_q(aa) <= U,  D_p50(delay) > T50,  D_q(tail) > U  AND  D_q'(tail) > U, where
//   q'(tail) counts the tail run's saves over 3 x the SAME ROUND's base p50 and D_q'(tail) = the median of the five
//   q'(tail) - q(base) (the grader's G-T1..G-T3: own-p50 and base-anchored power both; equality at U fails; else VOID);
//   PASS if  D_p50(head) <= T50,  D_q(head) <= U  and head's p99 <= 250 ms in every run (the r6.4 backstop, the save's
//   end-to-end latency containing its transaction's wait; set's p99 reported).  p95 is reported only.
// STOPs (for daybreak3 + the grader, never a verdict), decided before the medians:  performance.now()'s resolution over
// 100 us in any run (compared in whole microseconds);  the instability/spread STOP: any of base, aa, head, delay and set
// whose five p50s have max > 2 x min AND max - min > 5 ms.  NOT tail (daybreak3's T1 ruling): its real sleeps alter the
// concurrent workload's contention by design, so its p50 is evidence, not an estimator; tail is judged only by
// its two power rows (D_q(tail) > U and D_q'(tail) > U) and the structural checks (exactly its declared save count, a
// finite wall time, the resolution STOP, the anchor preflight); its p50/p90/p95/p99/max, q, q', bursts and wall time
// are reported, and every run's raw per-save latencies (all six configurations) are kept in the report's JSON.  The
// rules' boundary and scope controls run before anything else; a wrong one is BAD.
// The two mutants' anchors (DELAY's patch in tokens.ts, TAIL's hook in the page) are preflighted before the run, and
// their expected outcomes declared: DELAY D_p50 > T50, TAIL D_q > U and D_q' > U, in every workload and browser.
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
// (T-1, the grader and daybreak3: once the run has begun, a BAD or a crash still writes the report so far (every
// completed run with its raw latencies, the workload in progress, the reason) to --out, marked partial, before exit)
const OUT = (() => { const i = process.argv.indexOf("--out"); return i > 0 ? process.argv[i + 1] : null; })();
let partial = null;
const writePartial = (reason) => { if (OUT && partial) try { writeFileSync(OUT, JSON.stringify({ ...partial, partial: true, reason })); } catch {} };
// (r4: every exit path first kills the browser process groups this bench created (a detached Chromium would outlive it))
let reapAll = () => {};
const die = (m) => { console.error("BAD: " + m); writePartial("BAD: " + m); reapAll(); process.exit(2); };
// (a bound's SIGTERM or an interrupt: the report so far too, then the conventional status)
for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]]) process.on(sig, () => { console.error(`BAD: ${sig}`); writePartial(`BAD: ${sig} (a bound or an interrupt)`); reapAll(); process.exit(code); });
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
for (const [name, dir] of [["base", base], ["aa", base], ["warm", base], ["head", root], ["delay", delay]]) await build(join(dir, "web/workspace/index.ts"), `ws-${name}.js`);
// (A2: the built bundles' sha256; ws-warm, ws-base and ws-aa come from the same base tree and must be byte-identical; with
// HCOST_FROZEN_HASHES (a packet's FROZEN-HASHES: "<sha256>  ws-<name>.js" lines) every listed bundle must match, else BAD.
// The hash is of the bundle NORMALIZED: Bun writes each module's path as a "// <path>" comment, relative to the cwd and
// through this run's random temp directory, so each such line is cut to its path from the last web/, src/ or
// node_modules/ segment; nothing else changes.  The raw sha256 is recorded too)
const { createHash } = await import("node:crypto");
export const normalizeBundle = (text) => text.split("\n").map((l) => l.replace(/^\/\/ (\S*\/)?((?:web|src|node_modules)\/\S*)$/, "// $2")).join("\n");
const sha = (x) => createHash("sha256").update(x).digest("hex");
if (normalizeBundle("// ../../t/sb-hcost-base-AbC123/web/x.ts\ncode // web/y\n// node_modules/.pnpm/p/node_modules/q/i.js") !== "// web/x.ts\ncode // web/y\n// node_modules/q/i.js") die("normalizeBundle's unit row");
const BUNDLE_RAW = Object.fromEntries(["base", "aa", "warm", "head", "delay"].map((n) => [n, sha(readFileSync(join(site, `ws-${n}.js`)))]));
const BUNDLE_SHA = Object.fromEntries(["base", "aa", "warm", "head", "delay"].map((n) => [n, sha(normalizeBundle(readFileSync(join(site, `ws-${n}.js`), "utf8")))]));
if (!(BUNDLE_SHA.warm === BUNDLE_SHA.base && BUNDLE_SHA.aa === BUNDLE_SHA.base)) die(`ws-warm, ws-base and ws-aa aren't byte-identical (${BUNDLE_SHA.warm} ${BUNDLE_SHA.base} ${BUNDLE_SHA.aa})`);
if (process.env.HCOST_FROZEN_HASHES) {
  const want = Object.fromEntries(readFileSync(process.env.HCOST_FROZEN_HASHES, "utf8").trim().split("\n").map((l) => l.trim().split(/\s+/)).map(([h, f]) => [f, h]));
  for (const [f, h] of Object.entries(want)) { const n = f.replace(/^ws-|\.js$/g, ""); if (BUNDLE_SHA[n] !== h) die(`FROZEN-HASHES: ${f} is ${BUNDLE_SHA[n]}, frozen ${h}`); }
  if (!want["ws-warm.js"]) die("FROZEN-HASHES doesn't pin ws-warm.js");
}
if (process.argv.includes("--hashes-only")) { for (const [n, h] of Object.entries(BUNDLE_SHA)) console.log(`${h}  ws-${n}.js`); process.exit(0); }
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
// (r4, A2: the declared, discarded, identical warm-up of every fresh process: WARM_SAVES file saves through ws-warm.js,
// the base tree built under its own name, so every process loads the same extra code whatever its configuration)
const SHARED_DBS = ["sagebrush-board-history", "sagebrush-history"];
export async function warm() {
  const W = await import("./ws-warm.js"), name = "hcost-warm-" + Math.random().toString(36).slice(2), mainName = name + "-m", t0 = performance.now();
  const w = await W.Workspace.open({ name, mainName }), bytes = new Uint8Array(4096).fill(7), lat = [];
  await w.create("/w.bin", { content: bytes });
  for (let i = 0; i < 100; i++) { const a = performance.now(); await w.write("/w.bin", bytes); lat.push(performance.now() - a); }
  w.close();
  for (const d of [name, mainName]) await new Promise((ok) => { const q = indexedDB.deleteDatabase(d); q.onsuccess = q.onerror = q.onblocked = () => ok(); });
  // (its own databases verified gone before any measured run; what remains may only be the product's shared databases,
  // which every workspace open creates (every measured run does too), declared in SHARED_DBS; the full list is kept)
  const all = (await indexedDB.databases()).map((d) => d.name).sort();
  const left = all.filter((n) => n === name || n === mainName || !SHARED_DBS.includes(n));
  return { saves: lat.length, lat, left, all, ms: performance.now() - t0 };
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
  const r = { n: out.length, wall, p50, p90: pct(out, 0.9), p95: pct(out, 0.95), p99: pct(out, 0.99), max: Math.max(...out), stalled: stalled.filter(Boolean).length, q: stalled.filter(Boolean).length / out.length, bursts, res, lat: out };
  for (const x of ws) x.close();
  for (const d of [name, mainName]) await new Promise((ok) => { const q = indexedDB.deleteDatabase(d); q.onsuccess = q.onerror = q.onblocked = () => ok(); });
  return r;
}
`);
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>history cost</title><script type="module">import { bench, resolution, warm } from "./bench.js"; window.bench = bench; window.resolution = resolution; window.warm = warm; window.ready = true;</script>`);
const FILES = ["/bench.js", "/ws-base.js", "/ws-aa.js", "/ws-warm.js", "/ws-head.js", "/ws-delay.js"];
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (p !== "/" && !FILES.includes(p)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, p === "/" ? "index.html" : p.slice(1))), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });
const url = `http://127.0.0.1:${server.port}/`, sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// (a browser as one function: evaluate(expr) in a page at `url`.  r4: Chromium gets --password-store=basic: with a fresh
// profile per run, Chrome 155 on the VMs otherwise waits for the system keyring over D-Bus (no session bus there) until
// D-Bus's 25 s timeout before the first navigation commits (probes on VM1, 2026-11-02: 25.2 s -> 0.2 s); it selects the
// password store's backend only)
async function chromium() {
  const profile = mkdtempSync(join(tmpdir(), "sb-hcost-")), chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
  GROUPS.add(chrome.pid);
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
  // (A1: close kills the process group and reaps it: resolved only once the browser process has exited)
  const exited = new Promise((r) => chrome.once("exit", r));
  return { ev, version, close: async () => { ws.close(); try { process.kill(-chrome.pid, "SIGKILL"); } catch {} await Promise.race([exited, sleep(15000)]); rmSync(profile, { recursive: true, force: true }); } };
}
async function firefox() {
  if (!process.env.PLAYWRIGHT) die("PLAYWRIGHT (the directory of playwright 1.64.1) is needed for Firefox");
  const pw = createRequire(join(process.env.PLAYWRIGHT, "package.json"))("playwright");
  const browser = await pw.firefox.launch({ firefoxUserPrefs: { "privacy.reduceTimerPrecision": false, "privacy.resistFingerprinting": false } }), page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction("window.ready === true");
  return { ev: (expression) => page.evaluate(expression), close: () => Promise.race([browser.close(), sleep(15000)]), version: browser.version() };
}
// (A1: the census between runs: this user's processes of either browser (Chromium's sb-hcost- profiles, the staged
// Firefox's path); a fresh process is launched only at a census of 0, else a sticky STOP)
const censusMarks = () => [join(tmpdir(), "sb-hcost-"), ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? [join(process.env.PLAYWRIGHT_BROWSERS_PATH, "firefox-")] : [])];
// (the grader's and daybreak3's A1: the census counts (1) every descendant of this process, the whole tree, whatever
// its name; (2) every process in a process group this bench created (a Chromium's, which survives reparenting); (3) every
// process naming a browser profile or the staged Firefox.  The ps command itself is never counted.  Pure, with rows)
const GROUPS = new Set();
reapAll = () => { for (const g of GROUPS) { try { process.kill(-g, "SIGKILL"); } catch {} } };
const censusOf = (psText, root, groups, marks) => {
  const procs = psText.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], pgid: +m[3], args: m[4] }));
  const kids = new Map(); for (const p of procs) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)).push(p);
  const tree = new Set(), stack = [root];
  while (stack.length) for (const k of kids.get(stack.pop()) ?? []) if (!tree.has(k.pid)) { tree.add(k.pid); stack.push(k.pid); }
  return procs.filter((p) => p.pid !== root && !p.args.startsWith("ps ") && (tree.has(p.pid) || groups.has(p.pgid) || marks.some((m) => p.args.includes(m)))).length;
};
{
  const ps = (rows) => rows.map((r) => r.join(" ")).join("\n"), M = ["/tmp/sb-hcost-"];
  for (const [rows, want, what] of [
    [[[100, 1, 100, "bun bench"], [200, 100, 100, "ps -e -o"]], 0, "only this process and the census's own ps: 0"],
    [[[100, 1, 100, "bun bench"], [201, 100, 201, "some-child"]], 1, "a child left alive, whatever its name: 1"],
    [[[100, 1, 100, "bun bench"], [201, 100, 201, "x"], [202, 201, 201, "grandchild"]], 2, "a child and a grandchild: 2"],
    [[[100, 1, 100, "bun bench"], [301, 1, 777, "chrome --type=renderer"]], 1, "reparented to init but in a created group: 1"],
    [[[100, 1, 100, "bun bench"], [302, 1, 302, "chrome --user-data-dir=/tmp/sb-hcost-ab"]], 1, "a stray naming a profile: 1"],
    [[[100, 1, 100, "bun bench"], [400, 1, 400, "sshd: user"], [401, 1, 401, "someone else"]], 0, "unrelated processes: 0"],
  ]) if (censusOf(ps(rows), 100, new Set([777]), M) !== want) die(`the census's unit row: ${what}`);
}
function census() {
  const ps = spawnSync("ps", ["-e", "-o", "pid=,ppid=,pgid=,args="], { encoding: "utf8" }).stdout ?? "";
  return censusOf(ps, process.pid, GROUPS, censusMarks());
}
async function censusZero() { for (let i = 0; i < 150; i++) { if (census() === 0) return true; await sleep(100); } return false; }

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
// (one run's structural check, every configuration tail included (daybreak3's L-2): null when well formed, else what's
// wrong; a fault is BAD.  Every raw latency a finite number >= 0 (JSON would turn NaN or Infinity into null), every
// reported statistic finite, the wall time positive, q in [0, 1], exactly the declared save count.  Its unit rows:)
const STATS = ["p50", "p90", "p95", "p99", "max", "q", "res", "wall"];
const runFault = (x, want) => {
  if (!x || typeof x !== "object") return "no run record";
  if (x.n !== want || !Array.isArray(x.lat) || x.lat.length !== want) return `${x?.n} saves measured (${Array.isArray(x.lat) ? x.lat.length : "no"} raw), ${want} declared`;
  if (!x.lat.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) return "a raw latency isn't a finite number >= 0";
  for (const k of STATS) if (typeof x[k] !== "number" || !Number.isFinite(x[k])) return `${k} isn't a finite number`;
  if (!(x.wall > 0)) return "the wall time isn't positive";
  if (!(x.q >= 0 && x.q <= 1)) return "q isn't in [0, 1]";
  return null;
};
{
  const good = { n: 3, lat: [1, 2.5, 0], p50: 1, p90: 2, p95: 2.5, p99: 2.5, max: 2.5, q: 0, res: 0.02, wall: 10 };
  if (runFault(good, 3) !== null) die("the structural check's unit row: a well-formed run is refused");
  for (const [over, what] of [
    [{ lat: [1, NaN, 0] }, "a NaN latency"], [{ lat: [1, Infinity, 0] }, "an Infinity latency"], [{ lat: [1, -Infinity, 0] }, "a -Infinity latency"],
    [{ lat: [1, null, 0] }, "a null latency"], [{ lat: [1, "2", 0] }, "a string latency"], [{ lat: [1, -0.001, 0] }, "a negative latency"],
    [{ lat: [1, 2] }, "fewer raw latencies than declared"], [{ n: 4 }, "a save count other than declared"], [{ lat: undefined }, "no raw latencies"],
    [{ p90: NaN }, "p90 NaN"], [{ max: Infinity }, "max Infinity"], [{ p50: null }, "p50 null"], [{ res: NaN }, "res NaN"],
    [{ wall: 0 }, "wall 0"], [{ wall: NaN }, "wall NaN"], [{ q: 1.01 }, "q over 1"], [{ q: -0.01 }, "q under 0"], [{ p99: undefined }, "p99 missing"],
  ]) if (runFault({ ...good, ...over }, 3) === null) die(`the structural check's unit row: ${what} isn't refused`);
}
// (the median; and q'(tail) with D_q' (the grader's G-T1 and T-2): per round, the tail run's saves over 3 x the SAME
// round's base p50, less that base run's q; D_q' = their median.  Its unit rows; the selftest's mutants use tail's own
// p50, another round's base, or drop the subtraction of base's q)
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const qAnchored = (tail, base) => {
  const qa = tail.map((x, r) => x.lat.filter((v) => v > 3 * base[r].p50).length / x.lat.length);
  const QA = qa.map((v, r) => v - base[r].q);
  return { qa, QA, DQA: med(QA) };
};
{
  const base = [{ p50: 10, q: 0.1 }, { p50: 20, q: 0.2 }, { p50: 30, q: 0.3 }];
  const tail = [[5, 5, 5, 5, 5, 5, 20, 20, 35, 100], [5, 5, 5, 5, 5, 5, 50, 50, 70, 100], [5, 5, 5, 5, 5, 5, 5, 80, 95, 100]].map((lat) => ({ lat, p50: 5, q: 0.4 }));
  const { qa, QA, DQA } = qAnchored(tail, base), near = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-12);
  if (!near(qa, [0.2, 0.2, 0.2])) die(`q'(tail)'s unit row: q' counts each round's tail saves over 3 x that round's base p50 (${qa})`);
  if (!near(QA, [0.1, 0, -0.1]) || Math.abs(DQA) > 1e-12) die(`q'(tail)'s unit row: less that round's base q, their median (${QA}; ${DQA})`);
  if (med([3, 1, 2]) !== 2 || med([4, 1, 3, 2]) !== 2.5) die("the median's unit row");
}
// (A2's static rules for the warm-up (daybreak3's mutants: a configuration-specific bundle, save-count drift, a leaked
// database, warm-up leakage into a measured run): warm() imports ws-warm.js exactly once and nothing else, never reads
// the configuration, makes exactly 100 saves, deletes AND verifies its databases, never touches the measured samples;
// bench() never calls it.  Applied to the built page before the run; the selftest mutates the source against it)
const warmFault = (src) => {
  const a = src.indexOf("export async function warm()"), b = src.indexOf("export async function bench(");
  if (a < 0 || b < a) return "no warm() before bench()";
  const e = src.indexOf("return r;", b), w = src.slice(a, b), m = src.slice(b, e);
  if (e < 0) return "no end of bench()";
  if (w.split('import("./ws-warm.js")').length !== 2 || w.split("import(").length !== 2) return "warm() doesn't import exactly ws-warm.js, once";
  if (/config/.test(w)) return "warm() reads the configuration";
  if (w.split("i < 100;").length !== 2 || w.split("i++").length !== 2) return "warm() isn't exactly 100 saves";
  if (!w.includes("indexedDB.deleteDatabase(d)") || !w.includes("await indexedDB.databases()")) return "warm() doesn't delete and verify its databases";
  if (/\bout\b/.test(w)) return "warm() touches the measured samples";
  if (/warm\(/.test(m)) return "bench() calls the warm-up";
  return null;
};
// (the two mutants' anchors, preflighted: DELAY's patch landed exactly once; TAIL's hook is in the page exactly once)
{
  const d = readFileSync(join(delay, "web/history/tokens.ts"), "utf8"), b = readFileSync(join(site, "bench.js"), "utf8");
  if (d.split("while (performance.now() - t0 < 2) {}").length !== 2) die("the DELAY mutant's anchor isn't in place exactly once");
  const wf = warmFault(b); if (wf !== null) die(`the warm-up's static rule: ${wf}`);
  if (b.split("TAIL-ANCHOR").length !== 2 || b.split('config === "tail" && ++started % 10 === 0').length !== 2) die("the TAIL mutant's anchor isn't in place exactly once");
}
// (the verdict of one browser and workload, from its STOPs and medians; and its unit rows: the power rows are strict
// (equality at U or T50 doesn't pass), the null and head rows inclusive; own-pass/anchored-fail is VOID)
const U = 0.01;
const verdictOf = (stop, m) => {
  if (stop.length) return "STOP";
  const valid = m.aaP50 <= m.T50 && m.aaQ <= U && m.delayP50 > m.T50 && m.tailQ > U && m.tailQa > U;
  if (!valid) return "VOID";
  return m.headP50 <= m.T50 && m.headQ <= U && m.headP99 <= 250 ? "PASS" : "FAIL";
};
{
  const ok = { T50: 0.5, aaP50: 0, aaQ: 0, delayP50: 2, tailQ: 0.1, tailQa: 0.1, headP50: 0, headQ: 0, headP99: 10 };
  for (const [over, want, what] of [
    [{}, "PASS", "every row passes: VALID and PASS"],
    [{ tailQa: 0.005 }, "VOID", "tail's own-p50 power passes, the base-anchored fails: VOID"],
    [{ tailQ: 0.005 }, "VOID", "tail's base-anchored power passes, the own-p50 fails: VOID"],
    [{ tailQ: 0.01 }, "VOID", "tail's own-p50 power exactly U: not past, VOID"],
    [{ tailQa: 0.01 }, "VOID", "tail's base-anchored power exactly U: not past, VOID"],
    [{ tailQ: 0.0101, tailQa: 0.0101 }, "PASS", "both tail powers just over U: VALID"],
    [{ delayP50: 0.5 }, "VOID", "delay exactly T50: not caught, VOID"],
    [{ aaP50: 0.5, aaQ: 0.01 }, "PASS", "A/A exactly T50 and exactly U: within, VALID"],
    [{ aaP50: 0.5001 }, "VOID", "A/A p50 just over T50: VOID"],
    [{ aaQ: 0.0101 }, "VOID", "A/A q just over U: VOID"],
    [{ headP50: 0.5, headQ: 0.01, headP99: 250 }, "PASS", "head exactly T50, U and 250 ms: PASS"],
    [{ headP50: 0.5001 }, "FAIL", "head p50 just over T50: FAIL"],
    [{ headQ: 0.0101 }, "FAIL", "head q just over U: FAIL"],
    [{ headP99: 250.01 }, "FAIL", "head p99 just over 250 ms: FAIL"],
    [{ headP50: 9, aaP50: 9 }, "VOID", "VOID outranks FAIL"],
  ]) if (verdictOf([], { ...ok, ...over }) !== want) die(`the verdict's unit row: ${what}`);
  if (verdictOf(["x"], ok) !== "STOP") die("the verdict's unit row: a STOP outranks every row");
}
// (r4 (the grader 9308b24b, daybreak3): the frozen order of each leg's workload, 5 rounds of the 6 configurations;
// over the whole 30-run sequence, round boundaries included: the run after tail is each of base, aa, head, delay and set
// exactly once; tail is never last; base opens only round 1; each configuration takes 5 different positions; no ordered
// neighbour pair occurs twice.  Its rule rows below; the selftest's mutants break each)
const ORDER = [
  ["base", "aa", "head", "delay", "set", "tail"],
  ["set", "head", "base", "tail", "delay", "aa"],
  ["aa", "delay", "tail", "base", "head", "set"],
  ["delay", "base", "set", "aa", "tail", "head"],
  ["head", "tail", "aa", "set", "base", "delay"],
];
const orderFault = (t) => {
  const seq = t.flat(), NT = ["base", "aa", "head", "delay", "set"];
  if (t.length !== 5 || t.some((r) => r.length !== 6 || new Set(r).size !== 6 || r.some((c) => !NT.includes(c) && c !== "tail"))) return "not 5 rounds of the 6 configurations";
  // (tail is never last: implied by the next rule, which needs a run after each of the five tails)
  const after = seq.flatMap((c, i) => (c === "tail" ? [seq[i + 1]] : []));
  if ([...after].sort().join() !== [...NT].sort().join()) return `the runs after tail are ${after.join(",")}`;
  if (t.every((r) => r[0] === "base")) return "base opens every round";
  for (let k = 0; k < 6; k++) if (new Set(t.map((r) => r[k])).size !== 5) return `position ${k + 1} repeats a configuration`;
  const pairs = seq.slice(1).map((c, i) => seq[i] + ">" + c);
  if (new Set(pairs).size !== pairs.length) return "an ordered neighbour pair repeats";
  return null;
};
{
  if (orderFault(ORDER) !== null) die(`the order table's rule row: ${orderFault(ORDER)}`);
  const rot = [0, 1, 2, 3, 4].map((r) => ORDER[0].map((_, k) => ORDER[0][(k + r) % 6]));
  if (orderFault(rot) === null) die("the order table's rule row: r3's cyclic rotation isn't refused");
  const lastTail = ORDER.map((r) => [...r]); lastTail[4] = ["head", "aa", "set", "base", "delay", "tail"];
  if (orderFault(lastTail) === null) die("the order table's rule row: tail last isn't refused");
  // (a table meeting every rule but the neighbour-pair one (found by search): tail>set occurs twice)
  const pairRepeat = [["tail", "set", "delay", "head", "aa", "base"], ...ORDER.slice(1)];
  if (orderFault(pairRepeat) !== "an ordered neighbour pair repeats") die(`the order table's rule row: a repeated neighbour pair isn't refused for that reason (${orderFault(pairRepeat)})`);
}
// (the per-predecessor q table, by actual chronology (R4): each workload's runs in the order run; a run's predecessor is
// the run before it in that workload (the first has none and is excluded); tail's own runs are excluded (the mutant);
// carry = |mean q after tail - mean q after any other|.  INFO: carry > U is a STOP; COUNTED: reported only)
const carryOf = (seq) => {
  const after = [], other = [];
  for (let i = 1; i < seq.length; i++) { if (seq[i].c === "tail") continue; (seq[i - 1].c === "tail" ? after : other).push(seq[i].q); }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const byPred = {};
  for (let i = 1; i < seq.length; i++) if (seq[i].c !== "tail") (byPred[seq[i - 1].c] ??= []).push(seq[i].q);
  return { afterTail: mean(after), other: mean(other), carry: Math.abs(mean(after) - mean(other)), nAfter: after.length, nOther: other.length, byPred: Object.fromEntries(Object.entries(byPred).map(([p, xs]) => [p, mean(xs)])) };
};
{
  const mk = (qs) => qs.map(([c, q]) => ({ c, q }));
  const a = carryOf(mk([["base", 0.5], ["tail", 0.9], ["aa", 0.02], ["head", 0.05], ["tail", 0.9], ["set", 0.04], ["delay", 0.06]]));
  if (a.nAfter !== 2 || a.nOther !== 2 || Math.abs(a.afterTail - 0.03) > 1e-12 || Math.abs(a.other - 0.055) > 1e-12 || Math.abs(a.carry - 0.025) > 1e-12) die(`the carryover's unit row: chronology, tail excluded, first run excluded (${JSON.stringify(a)})`);
}
// (William's product decision, Nov 2 (via @sagebrush; daybreak3 da757ee7/dd266a96, the grader 5d03cd68): Firefox's
// performance legs are REPORT-ONLY: run, computed and reported in full, never deciding D2.  D2 is Chromium's alone.
// Report-only covers the performance verdict only: a Firefox leg that can't run (launch, teardown, census, version,
// warm-up, malformed evidence) is still a run STOP or BAD.  overallOf decides from the gating rows; its unit rows)
const GATING = ["chromium"], REPORT_ONLY = ["firefox"];
const overallOf = (rows) => {
  const v = rows.filter((r) => GATING.includes(r.browser)).map((r) => r.verdict);
  if (v.length === 0) return "STOP";
  return v.includes("STOP") ? "STOP" : v.includes("VOID") ? "VOID" : v.includes("FAIL") ? "FAIL" : "PASS";
};
{
  const R = (b, v) => ({ browser: b, verdict: v });
  for (const [rows, want, what] of [
    [[R("chromium", "PASS"), R("chromium", "PASS"), R("chromium", "PASS"), R("firefox", "VOID"), R("firefox", "STOP"), R("firefox", "FAIL")], "PASS", "a planted Firefox VOID/STOP/FAIL leaves D2 to Chromium: PASS"],
    [[R("chromium", "PASS"), R("chromium", "VOID"), R("chromium", "PASS"), R("firefox", "PASS")], "VOID", "a planted Chromium VOID: VOID"],
    [[R("chromium", "FAIL"), R("firefox", "PASS")], "FAIL", "a Chromium FAIL: FAIL"],
    [[R("chromium", "PASS"), R("chromium", "STOP"), R("firefox", "PASS")], "STOP", "a Chromium STOP: STOP"],
    [[R("firefox", "PASS")], "STOP", "no gating row: STOP (D2 undecidable)"],
  ]) if (overallOf(rows) !== want) die(`overallOf's unit row: ${what}`);
}
// (a sticky STOP during the run: launch failure, a non-zero census, a version change; the report so far, then STOP)
let CURRENT = null;
const stopNow = async (why) => {
  console.log(`HCOST: STOP (${why})`); writePartial(`STOP: ${why}`);
  if (CURRENT) { try { await Promise.race([CURRENT.close(), sleep(15000)]); } catch {} }
  reapAll(); process.exit(3);
};
const MODE = process.env.HCOST_MODE ?? "";
if (!["INFO", "COUNTED"].includes(MODE)) die("HCOST_MODE: INFO or COUNTED, declared before the run");
const CONFIGS = ["base", "aa", "head", "delay", "set", "tail"], ROUNDS = 5, FF_SCALE = +(process.env.HCOST_FF_SCALE ?? 1);
if (!(Number.isInteger(FF_SCALE) && FF_SCALE >= 1 && FF_SCALE <= 20)) die("HCOST_FF_SCALE: an integer 1..20");
const report = { gating: GATING, reportOnly: REPORT_ONLY, mode: MODE, order: ORDER, bundles: BUNDLE_SHA, bundlesRaw: BUNDLE_RAW, master, statistic: "daybreak3's settlement: A, median paired p50 deltas vs T50 = min(1, max(0.5, 0.05 B50)); B, median paired q deltas vs U = 0.01; head p99 <= 250 ms", declared: "DELAY: D_p50 > T50; TAIL: D_q > U and D_q' > U; in every workload and browser; A/A within T50 and U", browsers: {} };
console.log(`declared: ${report.declared}; D2 gates on ${GATING.join(", ")} only, ${REPORT_ONLY.join(", ")} REPORT-ONLY (William, Nov 2); mode ${MODE} (INFO: per-predecessor carry <= U or STOP; COUNTED: reported); a fresh browser process per run with the identical warm-up; Firefox scale ${FF_SCALE}`);
const verdicts = [];
partial = report;
let crash = null;
try {
  for (const [bname, open] of [["chromium", chromium], ["firefox", firefox]]) {
    if (!LEGS.includes(bname)) continue;
    const rows = {}, leg = report.browsers[bname] = { version: null, scale: bname === "firefox" ? FF_SCALE : 1, launches: 0, warm: [], rows };
    // (one fresh process per run: census 0, launch, the warm-up, the run, close and reap)
    leg.timing = [];
    const fresh = async (fn) => {
      const t = [Date.now()];
      if (!(await censusZero())) await stopNow(`${bname}: ${census()} browser process(es) left before a launch`);
      t.push(Date.now());
      let b;
      try { b = await open(); } catch (e) { await stopNow(`${bname}: the launch failed: ${String(e?.message ?? e).slice(0, 300)}`); }
      CURRENT = b; t.push(Date.now());
      leg.launches++;
      if (leg.version === null) { leg.version = b.version; console.log(`${bname}: ${b.version}`); }
      else if (b.version !== leg.version) await stopNow(`${bname}: the version changed between launches (${leg.version} -> ${b.version})`);
      try {
        const wu = await b.ev("window.warm()");
        leg.warm.push(wu); t.push(Date.now());
        // (A2: exactly the declared 100 saves; no database left behind; the evidence kept apart, never in a measured row)
        if (wu.saves !== 100 || !Array.isArray(wu.lat) || wu.lat.length !== 100) await stopNow(`${bname}: the warm-up made ${wu.saves} saves, not 100`);
        if (!Array.isArray(wu.left) || wu.left.length !== 0) await stopNow(`${bname}: the warm-up left database(s) ${JSON.stringify(wu.left)}`);
        const x = await fn(b); t.push(Date.now());
        return x;
      } finally {
        await b.close(); CURRENT = null; t.push(Date.now());
        if (!(await censusZero())) await stopNow(`${bname}: ${census()} browser process(es) left after a close`);
        t.push(Date.now());
        // (the phases, ms: census-before, launch, warm-up, run, close, census-after)
        const ph = t.slice(1).map((v, i) => v - t[i]); leg.timing.push(ph);
        if (process.env.HCOST_TRACE) console.error(`trace ${bname} ${ph.join(" ")}`);
      }
    };
    for (const workload of ["files", "notebooks", "concurrent"]) {
      const runs = Object.fromEntries(CONFIGS.map((c) => [c, []])), order = [], chrono = [];
      report.inProgress = { browser: bname, workload, order, runs };
      for (let r = 0; r < ROUNDS; r++) {
        const turn = ORDER[r];
        order.push(turn);
        for (const c of turn) { const x = await fresh((b) => b.ev(`window.bench(${JSON.stringify(c)}, ${JSON.stringify(workload)}, ${bname === "firefox" ? FF_SCALE : 1})`)); runs[c].push(x); chrono.push({ c, q: x.q }); }
      }
      // (structural, every configuration tail included: exactly the declared save count, finite statistics and wall time)
      const scale = bname === "firefox" ? FF_SCALE : 1, want = (workload === "concurrent" ? 4 * 200 : 500) * scale;
      for (const c of CONFIGS) runs[c].forEach((x, r) => { const fault = runFault(x, want); if (fault !== null) die(`${bname} ${workload} ${c} round ${r + 1}: ${fault}`); });
      const of = (c, k) => runs[c].map((x) => x[k]);
      const B50 = med(of("base", "p50")), T50 = Math.min(1, Math.max(0.5, 0.05 * B50));
      const pairedOf = (k) => Object.fromEntries(["aa", "head", "delay", "set", "tail"].map((c) => [c, runs[c].map((x, r) => x[k] - runs.base[r][k])]));
      const P50 = pairedOf("p50"), Q = pairedOf("q");
      const { qa, QA, DQA } = qAnchored(runs.tail, runs.base);
      const D = Object.fromEntries(Object.entries(P50).map(([c, d]) => [c, med(d)])), DQ = Object.fromEntries(Object.entries(Q).map(([c, d]) => [c, med(d)]));
      const p99 = Object.fromEntries(CONFIGS.map((c) => [c, Math.max(...of(c, "p99"))]));
      const resMax = Math.max(...CONFIGS.flatMap((c) => of(c, "res")));
      const spread = spreadOf(Object.fromEntries(CONFIGS.map((c) => [c, of(c, "p50")])));
      const carry = carryOf(chrono), carryPast = carry.carry > U;
      const stop = [...(resStop(resMax) ? [`performance.now() resolution ${Math.round(resMax * 1000)} us > 100 us`] : []), ...(spread.length ? [`instability/spread (p50): ${spread.join(", ")}`] : []), ...(MODE === "INFO" && carryPast ? [`carryover: |q after tail - q after others| ${(100 * carry.carry).toFixed(2)} pp > U`] : [])];
      const m = { T50, aaP50: D.aa, aaQ: DQ.aa, delayP50: D.delay, tailQ: DQ.tail, tailQa: DQA, headP50: D.head, headQ: DQ.head, headP99: p99.head };
      const verdict = verdictOf(stop, m), backstop = p99.head <= 250;
      verdicts.push({ browser: bname, verdict });
      delete report.inProgress;
      rows[workload] = { verdict, stop, carry, chrono, B50, T50, U, D, DQ, DQA, P50, Q, QA, qa, p99, resMax, backstop, setWithin3: D.set <= 3, order, runs };
      const f = (x) => x.toFixed(2), pp = (x) => (100 * x).toFixed(2) + " pp";
      console.log(`${bname} ${workload}: ${REPORT_ONLY.includes(bname) ? `REPORT-ONLY (computed: ${verdict})` : verdict}${stop.length ? " (" + stop.join("; ") + ")" : ""}: B50 ${f(B50)} ms, T50 ${f(T50)} ms; paired p50 medians A/A ${f(D.aa)} (${D.aa <= T50 ? "within" : "PAST"}), head ${f(D.head)} (${D.head <= T50 ? "within" : "PAST"}), delay ${f(D.delay)} (${D.delay > T50 ? "caught" : "NOT CAUGHT"}), set ${f(D.set)} ms (${D.set <= 3 ? "within" : "past"} 3 ms, reported); paired q medians A/A ${pp(DQ.aa)} (${DQ.aa <= U ? "within" : "PAST"}), head ${pp(DQ.head)} (${DQ.head <= U ? "within" : "PAST"}), tail ${pp(DQ.tail)} (${DQ.tail > U ? "caught" : "NOT CAUGHT"}), tail base-anchored ${pp(DQA)} (${DQA > U ? "caught" : "NOT CAUGHT"}); p99 head ${f(p99.head)} (${backstop ? "within" : "PAST"} 250 ms) set ${f(p99.set)} ms; resolution ${Math.round(resMax * 1000)} us; carryover q after tail ${pp(carry.afterTail)} vs after others ${pp(carry.other)}: ${pp(carry.carry)} (${carryPast ? "PAST" : "within"} U${MODE === "INFO" ? "" : ", reported"})`);
      console.log(`  per-predecessor mean q: ${Object.entries(carry.byPred).map(([p, q]) => `${p} ${pp(q)}`).join("; ")}`);
      for (const c of CONFIGS) console.log(`  ${c.padEnd(5)} p50 ${of(c, "p50").map(f).join(" / ")}; p90 ${of(c, "p90").map(f).join(" / ")}; p95 ${of(c, "p95").map(f).join(" / ")}; p99 ${of(c, "p99").map(f).join(" / ")}; max ${of(c, "max").map(f).join(" / ")}; q ${of(c, "q").map(pp).join(" / ")}; bursts ${runs[c].map((x) => "[" + x.bursts.join(",") + "]").join(" ")}; wall s ${runs[c].map((x) => (x.wall / 1000).toFixed(1)).join(" / ")}`);
    }
    console.log(`${bname}: ${leg.launches} fresh processes, warm-ups ${leg.warm.length} (discarded)`);
  }
} catch (e) {
  crash = e;
} finally {
  server.stop(true);
  for (const d of [site, base, delay]) rmSync(d, { recursive: true, force: true });
}
if (crash) die(`crash: ${String(crash?.stack ?? crash).slice(0, 2000)}`);
if (OUT) writeFileSync(OUT, JSON.stringify(report));
const v = overallOf(verdicts);
const list = (bs) => verdicts.filter((r) => bs.includes(r.browser)).map((r) => r.verdict).join(" ");
console.log(`HCOST: ${v} (gating ${GATING.join("+")}: ${list(GATING) || "none"}; report-only ${REPORT_ONLY.join("+")}: ${list(REPORT_ONLY) || "none"})`);
process.exit({ PASS: 0, FAIL: 1, STOP: 3, VOID: 76 }[v]);
