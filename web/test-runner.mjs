// The runner (design/runner.md) in headless Chromium: the notebook page runs
// Python in an opaque-origin sandboxed frame (?runner=0: in a plain worker,
// where NO_RUNNER=1 checks that these tests fail).  Checks that code
// runs, that Stop keeps the variables, and, from inside the frame and its
// worker (as an escape would be), that there is no storage, no page and no
// network beyond Sagebrush's own files.  Serve web/dist first:
//   python3 web/serve.py 8765 &  node web/test-runner.mjs   (SB_URL=... for another)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const profile = mkdtempSync(join(tmpdir(), "sb-runner-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!cdpPort) cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
const contexts = [];
const workers = []; // sessionIds of attached workers
const frames = []; // and of frames in their own process
const violations = [];
let paused = null; // a request held by Fetch interception, and what to do with it
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Fetch.requestPaused") paused?.(m.params);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.executionContextCreated") contexts.push({ ...m.params.context, sessionId: m.sessionId });
  if (m.method === "Target.attachedToTarget") {
    // (each frame in another process, and each worker, is a target of its own)
    const sid = m.params.sessionId;
    if (m.params.targetInfo.type === "worker") workers.push(sid);
    if (m.params.targetInfo.type === "iframe") frames.push(sid);
    for (const [method, params] of [["Runtime.enable", {}], ["Log.enable", {}], ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }], ["Runtime.runIfWaitingForDebugger", {}]]) ws.send(JSON.stringify({ id: ++n, method, params, sessionId: sid }));
  }
  if (m.method === "Log.entryAdded" && /Content Security Policy/.test(m.params.entry.text)) violations.push(m.params.entry.text);
  if (process.env.RUNNER_DEBUG && (m.method === "Log.entryAdded" || m.method === "Runtime.exceptionThrown" || m.method === "Runtime.consoleAPICalled")) console.log("  [" + (m.sessionId ?? "page").slice(0, 6) + "]", JSON.stringify(m.params).slice(0, 600));
};
const send = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const evIn = async (expression, { contextId, sessionId } = {}) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, sessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
};
const ev = (x) => evIn(x);
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
async function run(code) {
  await ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true})); })()`);
  await sleep(150);
  await until("(() => { const c = [...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1); return !c.classList.contains('running') && !c.classList.contains('queued') && /\\[\\d+\\]/.test(c.querySelector('.n').textContent); })()", 60000);
  return ev("[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1).querySelector('.out').textContent");
}
// what a script in a context can reach
const PROBE = `(async () => {
  const out = {};
  out.origin = self.origin;
  try { localStorage.length; out.localStorage = true; } catch { out.localStorage = false; }
  try { await new Promise((res, rej) => { const r = indexedDB.open("probe"); r.onsuccess = res; r.onerror = () => rej(r.error); }); out.indexedDB = true; } catch { out.indexedDB = false; }
  try { out.parentDocument = !!(self.parent && self.parent !== self && self.parent.document); } catch { out.parentDocument = false; }
  try { out.cookie = typeof document !== "undefined" ? document.cookie : null; } catch { out.cookie = "denied"; }
  out.isolated = self.crossOriginIsolated;
  out.secure = self.isSecureContext;
  out.subtle = !!(self.crypto && self.crypto.subtle);
  out.precompiled = Object.keys(self.__SAGEBRUSH_PRECOMPILED__?.modules ?? {}).length;
  const reach = async (u, credentials = "include") => { try { await fetch(u, { mode: "cors", credentials }); return true; } catch { return false; } };
  out.elsewhere = await reach("https://example.com/");
  out.sitePage = await reach(${JSON.stringify(new URL("/", base).href)} + "?probe");
  out.ownFiles = await reach(${JSON.stringify(new URL("sagebrush-worker.js", base).href)}, "omit");
  out.websocket = await new Promise((res) => { try { const w = new WebSocket("wss://example.com/"); w.onopen = () => res(true); w.onerror = () => res(false); } catch { res(false); } });
  // (a beacon is queued, then checked: the CSP reports say whether it went)
  if (typeof navigator.sendBeacon === "function") navigator.sendBeacon("https://example.com/beacon", "x");
  return out;
})()`;

try {
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await send("Page.navigate", { url: new URL(process.env.NO_RUNNER ? "?runner=0" : "./", base).href });
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
  console.log("     " + (await ev("document.querySelector('#status').textContent")));
  const frame = await ev("(() => { const f = document.querySelector('iframe[sandbox]'); return f && { sandbox: f.getAttribute('sandbox'), src: f.src }; })()");
  ok(frame?.sandbox === "allow-scripts", "the interpreter runs in <iframe sandbox=\"allow-scripts\">: " + JSON.stringify(frame));
  ok((await run("sum(range(10))")).trim() === "45", "code runs in the runner");
  ok((await run("from fractions import Fraction\nprint(Fraction(1, 3) + Fraction(1, 6))")).includes("1/2"), "printing works");
  ok((await run("import numpy as np\nprint(np.arange(6).reshape(2, 3).sum(axis=0))")).includes("[3 5 7]"), "numpy works");
  // (a module of a part of the library no start loads: its chunk, like the
  // engine and Sage's part below, fetched by the page and handed through the
  // frame; web/lib-lazy.ts)
  ok((await run("import heapq\nprint(heapq.nsmallest(2, [3, 1, 2]))")).includes("[1, 2]"), "a library module imported later: its chunk through the frame");
  // (a package's submodule under a library package: scipy is lib/'s, scipy.io
  // @sagebrush/scipy-io's, found by its full name; its chunk through the frame)
  const mat = (await run("import scipy.io as sio, numpy as np\nsio.savemat('t.mat', {'A': np.arange(4.)})\nprint(sio.loadmat('t.mat')['A'].tolist(), sio.__name__)")).trim();
  ok(mat === "[[0.0, 1.0, 2.0, 3.0]] scipy.io", "a package's submodule imports (scipy.io, @sagebrush/scipy-io), savemat and loadmat: " + mat);
  // (changing the language of a notebook with code asks first: yes)
  await ev("(() => { window.confirm = () => true; const m = document.querySelector('#mode'); m.value = 'sage'; m.dispatchEvent(new Event('change', {bubbles: true})); })()");
  await sleep(500);
  const f = (await run("factor(2^64 + 1)")).trim();
  ok(f === "274177 * 67280421310721", "Sage mode and the engine work, with no network in the runner: " + f);
  // (a package's module, packages/cremona-small: its chunk through the frame,
  // checked against the registry, src/compile.ts)
  const ec = (await run("EllipticCurve('11a1').ainvs()")).trim();
  ok(ec === "(0, -1, 1, -10, -20)", "a package's module imports (Cremona's table, @sagebrush/cremona-small): " + ec);

  // Stop: a KeyboardInterrupt that keeps the variables (if the frame is cross-origin isolated)
  await run("kept = 42");
  await ev(`(() => { document.querySelector('#add').click(); const c = [...document.querySelectorAll('.cell')].at(-1); const ta = c.querySelector('textarea'); ta.value = 'while True:\\n    pass'; ta.dispatchEvent(new Event('input', {bubbles: true})); ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true})); })()`);
  await sleep(1500);
  await ev("document.querySelector('#stop').click()");
  await until("!document.querySelector('.cell.running')", 10000);
  const stopped = await ev("[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1).querySelector('.out').textContent");
  const kept = (await run("globals()['kept']")).trim();
  ok(/KeyboardInterrupt/.test(stopped) && kept === "42", `Stop interrupts and keeps the variables: ${JSON.stringify(stopped.trim().split("\n").at(-1))}, kept = ${kept}`);

  // from inside: the frame's own context, and the worker
  const frameCtx = contexts.find((c) => c.auxData?.isDefault && (c.origin === "null" || /\/runner\//.test(c.name ?? "") || (c.sessionId && frames.includes(c.sessionId))));
  ok(!!frameCtx, "found the frame's context");
  const inFrame = await evIn(PROBE, { contextId: frameCtx.id, sessionId: frameCtx.sessionId });
  ok(inFrame.origin === "null" && !inFrame.localStorage && !inFrame.indexedDB && !inFrame.parentDocument && inFrame.cookie !== "x", "the frame: an opaque origin, no storage, no page: " + JSON.stringify(inFrame));
  ok(!inFrame.elsewhere && !inFrame.sitePage && !inFrame.websocket && !inFrame.ownFiles, "the frame: no network at all, not even Sagebrush's own files");
  await until("true");
  const wk = workers.at(-1);
  ok(!!wk, "found the worker");
  const inWorker = await evIn(PROBE, { sessionId: wk });
  ok(inWorker.origin === "null" && !inWorker.indexedDB && !inWorker.elsewhere && !inWorker.sitePage && !inWorker.websocket && !inWorker.ownFiles, "the worker (where escaped code would run): the same, no network at all: " + JSON.stringify(inWorker));
  await sleep(500);
  ok(inWorker.precompiled > 50, "Sage's compiled modules reached the worker (checked by their SHA-256 without crypto.subtle: the runner's worker is not a secure context): " + inWorker.precompiled);
  ok(violations.length > 0 && violations.some((v) => /example\.com\/beacon/.test(v)), `the attempts were blocked by the runner's policy, the beacon too (${violations.length} CSP reports)`);

  // A runner that answers but whose worker never starts (as in WebKit, where
  // the page doesn't use it now): the notebook page falls back to a plain
  // worker, and code runs, rather than waiting forever
  if (!process.env.NO_RUNNER) {
    const stuck = `<!doctype html><script>addEventListener("message", (e) => { if (e.data && e.data.sagebrushRunner === 1) e.ports[0].postMessage({ runnerReady: true }); });</script>`;
    paused = (p) => {
      if (!/\/runner\/(index\.html)?(\?.*)?$/.test(p.request.url)) return send("Fetch.continueRequest", { requestId: p.requestId });
      const headers = [["content-type", "text/html; charset=utf-8"], ["cross-origin-embedder-policy", "require-corp"], ["cross-origin-resource-policy", "cross-origin"]].map(([name, value]) => ({ name, value }));
      return send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(stuck).toString("base64") });
    };
    await send("Fetch.enable", { patterns: [{ urlPattern: "*runner*", requestStage: "Request" }] });
    await send("Page.navigate", { url: new URL("./", base).href });
    await sleep(500);
    await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000).catch(() => {});
    const t = Date.now();
    const out = (await run("6 * 7").catch((e) => e.message)).trim();
    ok(out === "42", `a runner whose worker doesn't start: the code runs in a plain worker instead (${out}, after ${((Date.now() - t) / 1000).toFixed(1)} s)`);
    await send("Fetch.disable");
    paused = null;
  }
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
  console.log("  status:", await ev("document.querySelector('#status')?.textContent").catch((x) => x.message));
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
