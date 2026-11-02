// The cost gate of history's change tokens (Stage A layer 1; design stage-a-l1 r2.1 §6 [D2], daybreak3): the added
// per-save cost with history INACTIVE (what PROD ships) must stay within p95 delta <= 1 ms AND <= 5 % of master's, per
// workload, in Chromium and in Firefox; and a build with a 2 ms delay injected in noteToken must FAIL that gate (the
// sensitivity control: the gate sees what it bounds).
// Builds, each served as its own bundle to the same page: BASE (origin/master's web/), HEAD (this tree), DELAY (this
// tree, noteToken with a 2 ms synchronous wait at its top: a timer would let the transaction commit).  Workloads, per
// build, run 3 times, the WORST p95 kept:
//   files       500 serial writes of a 4 KiB data file (10 files round-robin)
//   notebooks   500 serial saves of a 50-cell notebook
//   concurrent  4 workspaces open on one database (4 tabs' worth, in one page), each 200 saves, files and notebooks mixed
// Measured: each save's end-to-end latency (the call to its resolve).
//   CHROME=chromium PLAYWRIGHT=<dir with playwright 1.64.1> bun web/history/bench-history-cost.mjs [--out report.json]
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname, root = join(here, "../..");
const site = mkdtempSync(join(tmpdir(), "sb-hcost-site-")), base = mkdtempSync(join(tmpdir(), "sb-hcost-base-")), delay = mkdtempSync(join(tmpdir(), "sb-hcost-delay-"));
const die = (m) => { console.error("FAIL: " + m); process.exit(1); };
// (BASE: origin/master's web/ and src/, as a pinned build is made in test-workspace-journal.mjs)
const master = spawnSync("git", ["rev-parse", "origin/master"], { cwd: root, encoding: "utf8" }).stdout.trim();
if (!/^[0-9a-f]{40}$/.test(master)) die("origin/master isn't known here");
if (spawnSync("sh", ["-c", `git archive ${master} web src | tar -x -C '${base}'`], { cwd: root }).status !== 0) die("master couldn't be unpacked");
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
for (const [name, dir] of [["base", base], ["head", root], ["delay", delay]]) await build(join(dir, "web/workspace/index.ts"), `ws-${name}.js`);
writeFileSync(join(site, "bench.js"), `
const N = { files: 500, notebooks: 500, concurrent: 200 };
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };
const nb = (k) => ({ cells: Array.from({ length: 50 }, (_, i) => ({ id: "c" + i, cell_type: "code", source: "x = " + i + "  # " + k })), mode: "python" });
let runs = 0;
export async function bench(build, workload) {
  const W = await import("./ws-" + build + ".js");
  const name = "hcost-" + build + "-" + workload + "-" + (++runs), mainName = name + "-m";
  const w = await W.Workspace.open({ name, mainName });
  const bytes = new Uint8Array(4096).fill(7), out = [];
  const one = async (w, i, kind) => {
    const t0 = performance.now();
    if (kind === "file") await w.write("/f" + (i % 10) + ".bin", bytes);
    else await w.write("/n" + (i % 10) + ".ipynb", nb(i));
    out.push(performance.now() - t0);
  };
  for (let i = 0; i < 10; i++) { await w.create("/f" + i + ".bin", { content: bytes }); await w.create("/n" + i + ".ipynb"); }
  if (workload === "concurrent") {
    const ws = [w, ...(await Promise.all([1, 2, 3].map(() => W.Workspace.open({ name, mainName }))))];
    await Promise.all(ws.map(async (x, k) => { for (let i = 0; i < N.concurrent; i++) await one(x, i * 4 + k, i % 2 ? "file" : "nb"); }));
  } else for (let i = 0; i < N[workload]; i++) await one(w, i, workload === "files" ? "file" : "nb");
  return { n: out.length, p95: p95(out) };
}
`);
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>history cost</title><script type="module">import { bench } from "./bench.js"; window.bench = bench; window.ready = true;</script>`);
const FILES = ["/bench.js", "/ws-base.js", "/ws-head.js", "/ws-delay.js"];
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
  return { ev, close: () => { ws.close(); try { process.kill(-chrome.pid, "SIGKILL"); } catch {} rmSync(profile, { recursive: true, force: true }); } };
}
async function firefox() {
  if (!process.env.PLAYWRIGHT) die("PLAYWRIGHT (the directory of playwright 1.64.1) is needed for Firefox");
  const pw = createRequire(join(process.env.PLAYWRIGHT, "package.json"))("playwright");
  const browser = await pw.firefox.launch(), page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction("window.ready === true");
  return { ev: (expression) => page.evaluate(expression), close: () => browser.close(), version: browser.version() };
}

const report = { master, browsers: {} };
let failed = false;
try {
  for (const [bname, open] of [["chromium", chromium], ["firefox", firefox]]) {
    const b = await open(), rows = {};
    for (const workload of ["files", "notebooks", "concurrent"]) {
      const worst = {};
      for (const build of ["base", "head", "delay"]) {
        let w = 0;
        for (let r = 0; r < 3; r++) w = Math.max(w, (await b.ev(`window.bench(${JSON.stringify(build)}, ${JSON.stringify(workload)})`)).p95);
        worst[build] = w;
      }
      const gate = (x) => x - worst.base <= 1 && x <= worst.base * 1.05;
      rows[workload] = { ...worst, headPass: gate(worst.head), delayCaught: !gate(worst.delay) };
      if (!rows[workload].headPass || !rows[workload].delayCaught) failed = true;
      console.log(`${bname} ${workload}: p95 base ${worst.base.toFixed(2)} ms, head ${worst.head.toFixed(2)} ms (${rows[workload].headPass ? "within" : "PAST"} the gate), delay ${worst.delay.toFixed(2)} ms (${rows[workload].delayCaught ? "caught" : "NOT CAUGHT"})`);
    }
    report.browsers[bname] = rows;
    await b.close();
  }
} finally {
  server.stop(true);
  for (const d of [site, base, delay]) rmSync(d, { recursive: true, force: true });
}
const oi = process.argv.indexOf("--out");
if (oi > 0) writeFileSync(process.argv[oi + 1], JSON.stringify(report, null, 1));
console.log(failed ? "FAIL: the cost gate (or its sensitivity control) didn't hold" : "ok: history's cost gate, inactive: within 1 ms and 5 % at p95 in every workload and both browsers; the 2 ms delay caught");
process.exit(failed ? 1 : 0);
