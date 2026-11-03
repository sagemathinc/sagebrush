// ci: web-runner order=595 chrome
// A Sage run whose library chunk never arrives ends, saying which chunk, instead of waiting for good; and the next
// Sage run in that page doesn't inherit the stall (web/stall-fetch.js, web/lib-lazy.ts prefetchMode, web/worker.ts:
// the grader's plain-worker investigation, #488 #552 #529 #551, where one chunk request that never settled held the
// run queued, and every later Sage run in the page with it).  Here the stall is made on purpose: the notebook page
// with its interpreter in a plain worker (?runner=0, on a loopback host), every request of the worker's for Sage's
// sources (lib/sage.src.*.json) held by CDP Fetch, never answered.  The run must end within the bound (20 s, once
// more on one retry: two requests held), saying "The Sage library didn't load (lib/sage.src.<hash>.json: no data
// for 20 s): run the cell again"; with the requests let through, the same cell then runs.  (Without the bound, as on
// master before it, the run waits for good: this test then fails at "the stalled run ends".)
// Serve web/dist first (python3 web/serve.py PORT), then
//   SB_URL=http://127.0.0.1:PORT/ node web/test-chunk-stall.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

const site = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-chunk-stall-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let failures = 0, count = 0;
const ok = (c, what) => { count++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) failures++; };
// (the whole test bounded: it says where it was rather than holding a CI slot)
let at = "starting Chrome";
setTimeout(() => { console.log(`FAIL the test did not end within 420 s; it was at: ${at}`); chrome.kill("SIGKILL"); process.exit(1); }, 420_000).unref();

const SRC = /\/lib\/sage\.src\.[0-9a-f]{16}\.json$/;
const held = []; // the held requests: {url, at}
let holding = true;

try {
  const port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  const post = (method, params = {}, sessionId) => ws.send(JSON.stringify({ id: ++n, method, params, ...(sessionId ? { sessionId } : {}) }));
  const send = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    // (each worker, before it runs: its requests past any service worker, and Sage's sources held while `holding`)
    if (m.method === "Target.attachedToTarget") {
      const sid = m.params.sessionId;
      post("Network.setBypassServiceWorker", { bypass: true }, sid);
      post("Fetch.enable", { patterns: [{ urlPattern: "*/lib/sage.src.*", requestStage: "Request" }] }, sid);
      post("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid);
      post("Runtime.runIfWaitingForDebugger", {}, sid);
    }
    if (m.method === "Fetch.requestPaused") {
      if (holding && SRC.test(new URL(m.params.request.url).pathname)) held.push({ url: m.params.request.url, at: Date.now() });
      else post("Fetch.continueRequest", { requestId: m.params.requestId }, m.sessionId);
    }
  };
  const ev = async (expression, ms = 30000) => {
    const r = await Promise.race([send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), sleep(ms).then(() => ({ timedOut: true }))]);
    if (r?.timedOut || r?.exceptionDetails) return undefined;
    return r?.result?.value;
  };
  const until = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr, Math.max(1000, ms - (Date.now() - t0)))) return true; await sleep(200); } return false; };
  // (a code cell: the last one, a new one if it has code; its code typed and run with Shift+Enter)
  const runCell = (code) => ev(`(() => { let c = [...document.querySelectorAll('.cell')].at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); return 1; })()`);
  const last = `[...document.querySelectorAll('.cell')].filter((c) => c.querySelector('textarea').value.trim()).at(-1)`;
  const settled = `(() => { const c = ${last}; return !!c && !c.classList.contains('running') && !c.classList.contains('queued') && /\\[(\\d+|!)\\]/.test(c.querySelector('.n').textContent); })()`;
  const outOf = `${last}.querySelector('.out').textContent`;

  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Network.setBypassServiceWorker", { bypass: true });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/lib/sage.src.*", requestStage: "Request" }] });
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  // (one page: its Sage sources held, a run, then let through, the same cell again)
  async function stalledThenLetThrough(where, url, said) {
    held.length = 0;
    holding = true;
    at = `${where}: the page`;
    await send("Page.navigate", { url });
    ok(await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000), `${where}: the page's interpreter is ready: ` + (await ev("document.querySelector('#status')?.textContent", 5000)));
    at = `${where}: Sage, its sources held`;
    await ev("(() => { window.confirm = () => true; const m = document.querySelector('#mode'); m.value = 'sage'; m.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()");
    const t0 = Date.now();
    await runCell("factor(2^32 + 1)");
    const ended = await until(settled, 70000);
    const ms = Date.now() - t0;
    const out = (await ev(outOf, 5000)) ?? "";
    ok(ended, `${where}: the stalled run ends (after ${(ms / 1000).toFixed(1)} s), not waiting for good`);
    ok(said.test(out.trim()), `${where}: …saying which chunk didn't load: ` + JSON.stringify(out.slice(0, 300)));
    ok(held.length === 2 && held[1].at - held[0].at >= 19000, `${where}: …after one more try: ${held.length} requests held${held.length === 2 ? ", " + ((held[1].at - held[0].at) / 1000).toFixed(1) + " s apart" : ""}`);
    ok(ms < 60000, `${where}: …within the bound and one more try (2 × 20 s, and the start): ${(ms / 1000).toFixed(1)} s`);
    at = `${where}: Sage again, its sources let through`;
    holding = false;
    const t1 = Date.now();
    await runCell("factor(2^32 + 1)");
    const again = await until(`(() => { const c = ${last}; return /\\[\\d+\\]/.test(c.querySelector('.n').textContent) && !c.classList.contains('running') && !c.classList.contains('queued') && c.querySelector('.out').textContent.trim() === '641 * 6700417'; })()`, 60000);
    ok(again, `${where}: the next Sage run doesn't inherit the stall: it fetches again and runs (${((Date.now() - t1) / 1000).toFixed(1)} s): ` + JSON.stringify(((await ev(outOf, 5000)) ?? "").slice(0, 200)));
  }
  // the interpreter in a plain worker (?runner=0): the worker's own fetch, bounded; it says the chunk stalled
  await stalledThenLetThrough("plain worker", new URL("?runner=0", site).href, /^The Sage library didn't load \(lib\/sage\.src\.[0-9a-f]{16}\.json: no data for 20 s\): run the cell again$/);
  // the sandboxed runner (where users are): the page fetches for it (runner-worker.js fetchFor), bounded, and the
  // worker's synchronous fetch then fails naming the chunk (the page's fetch answered nothing)
  await stalledThenLetThrough("runner", new URL("./", site).href, /lib\/sage\.src\.[0-9a-f]{16}\.json/);
  ws.close();
} catch (e) {
  failures++;
  console.log(`FAIL at ${at}: ${e?.stack ?? e}`);
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures ? `${failures} of ${count} failed` : `ok: a stalled chunk, ${count} checks`);
process.exit(failures ? 1 : 0);
