// The runner's files mode (web/notebook/runner-worker.js), as a downloaded
// board uses it: a page that is not cross-origin isolated (no
// SharedArrayBuffer, as in a file:// page) gives the runner the engine's
// files itself, and Python and the engine run in the sandboxed frame with no
// network.  Served here by a plain server with no headers at all, as a file
// has none.  Run after bun web/build.ts:   node web/test-runner-files.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "dist");
const PAGE = `<!doctype html><meta charset="utf-8"><body><script type="module">
import { WorkerKernel, RunnerWorker } from "/sagebrush-notebook.js";
const bytes = async (n) => (await fetch("/" + n)).arrayBuffer();
const files = { "sagebrush-worker.js": await bytes("sagebrush-worker.js"), "sagebrush-engine.wasm": await bytes("sagebrush-engine.wasm"), "sagebrush-precompiled.json": await bytes("sagebrush-precompiled.json") };
const kernel = new WorkerKernel({ createWorker: () => new RunnerWorker(null, { files }) });
kernel.start();
const run = (code, mode) => new Promise((done) => {
  let out = "";
  kernel.execute(code, { mode }, { start() {}, out(t) { out += t; }, display(b) { out += b["text/plain"] ?? ""; }, interact() {}, clear() {}, done() { done(out); }, stopped(m) { done("stopped: " + m); }, skipped() { done("skipped"); } });
});
window.t = { run, kernel, sab: typeof SharedArrayBuffer, isolated: self.crossOriginIsolated };
</script>`;
const MIME = { ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".html": "text/html" };
const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/files-test.html") return res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  const file = normalize(join(DIST, path));
  if (!file.startsWith(DIST) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-files-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
const workers = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Target.attachedToTarget") {
    if (m.params.targetInfo.type === "worker") workers.push(m.params.sessionId);
    for (const [method, params] of [["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }]]) ws.send(JSON.stringify({ id: ++n, method, params, sessionId: m.params.sessionId }));
  }
};
const send = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const ev = async (expression, sessionId) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; };
let failures = 0, count = 0;
const ok = (c, what) => { count++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) failures++; };

try {
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.navigate", { url: `${base}/files-test.html` });
  for (let i = 0; i < 200 && !(await ev("!!window.t").catch(() => false)); i++) await sleep(100);
  ok((await ev("t.sab")) === "undefined" && (await ev("t.isolated")) === false, "the page is not cross-origin isolated: no SharedArrayBuffer (as a file:// page)");
  ok(await ev("!!document.querySelector('iframe[sandbox=\"allow-scripts\"][srcdoc]')"), "the interpreter runs in a sandboxed srcdoc frame");
  const sum = (await ev("t.run('print(sum(range(10)))', 'python')")).trim();
  ok(sum === "45", "Python runs: " + sum);
  const f = (await ev("t.run('print(factor(2^64 + 1))', 'sage')")).trim();
  ok(f === "274177 * 67280421310721", "Sage mode and the engine run from the files given: " + f);
  // from inside the worker, where escaped code would run
  const wk = workers.at(-1);
  const probe = wk && (await ev(`(async () => {
    const reach = async (u) => { try { await fetch(u, { mode: "cors" }); return true; } catch { return false; } };
    let idb = false; try { indexedDB.open("x"); idb = true; } catch {}
    return { origin: self.origin, elsewhere: await reach("https://example.com/"), site: await reach(${JSON.stringify(base + "/sagebrush-worker.js")}), idb };
  })()`, wk));
  ok(!!probe && probe.origin === "null" && !probe.elsewhere && !probe.site && !probe.idb, "the worker: an opaque origin, no network (not even the page's server), no IndexedDB: " + JSON.stringify(probe));
  // nor through the page: asked to fetch for it (as the URL runner's broker
  // does), the page fetches nothing, not even one of the engine's own names (SEC-CAC-1)
  const got = wk && (await ev(`new Promise((done) => {
    const got = [];
    self.addEventListener("message", (e) => { if (e.data && e.data.runnerFetched === 987654) got.push(e.data.bytes ? e.data.bytes.byteLength : null); });
    self.postMessage({ runnerFetch: 987654, url: ${JSON.stringify(base + "/sagebrush-engine.wasm?leak=1")} });
    self.postMessage({ runnerFetch: 987654, url: ${JSON.stringify(base + "/sagebrush-worker.js?leak=2")} });
    setTimeout(() => done(got), 1500);
  })`, wk));
  const leaked = requests.filter((u) => u.includes("leak"));
  ok(Array.isArray(got) && got.every((b) => b === null) && !leaked.length, "asked to fetch for the worker, the page fetches nothing: " + JSON.stringify({ got, leaked }));
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  chrome.kill();
  server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `${failures} failed` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
