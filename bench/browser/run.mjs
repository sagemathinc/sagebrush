// Run cases.py in headless Chromium under sagebrush (the notebook page from
// web/dist) and under Pyodide (from the jsDelivr CDN); print a table.
//   node bench/browser/run.mjs [sagebrush-url] [pyodide-url]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const here = new URL(".", import.meta.url).pathname;
const code = readFileSync(here + "cases.py", "utf8");
const sbUrl = process.argv[2] ?? "http://127.0.0.1:8765/";
const pyUrl = process.argv[3] ?? "http://127.0.0.1:8766/pyodide.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browser() {
  // a fresh profile each time, and the cache cleared and disabled: a cold start
  const profile = mkdtempSync(join(tmpdir(), "sb-bench-"));
  const chrome = spawn("chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9335", "--window-size=1200,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let targets;
  for (let i = 0; i < 100; i++) { try { targets = await (await fetch("http://127.0.0.1:9335/json")).json(); break; } catch { await sleep(100); } }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.clearBrowserCache");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  return { send, evaluate, close: () => { ws.close(); chrome.kill(); } };
}

async function runSagebrush() {
  const b = await browser();
  const t0 = Date.now();
  await b.send("Page.navigate", { url: sbUrl });
  // startup: until `import numpy` has run in a cell
  for (;;) {
    await sleep(20);
    const ok = await b.evaluate("document.querySelector('#status')?.textContent.startsWith('ready')");
    if (ok) break;
  }
  // (a fresh profile opens the Welcome notebook: start a new one, as a user would)
  await b.evaluate("document.querySelector('[data-f=new]').click()");
  for (;;) {
    await sleep(10);
    if (await b.evaluate("document.querySelector('#nbname')?.value === 'Untitled' && document.querySelectorAll('.cell').length === 1")) break;
  }
  await b.evaluate(`(() => { const c = document.querySelector('.cell textarea'); c.value = 'import numpy'; document.querySelector('.cell [data-a=run]').click(); })()`);
  for (;;) {
    await sleep(10);
    if (await b.evaluate("document.querySelector('.cell .n').textContent === '[1]'")) break;
  }
  // from the navigation's start (the page's clock), as on the Pyodide side
  const ready = Math.round(await b.evaluate("performance.now()"));
  await b.evaluate(`(() => { const c = document.querySelector('.cell textarea'); c.value = ${JSON.stringify(code)}; document.querySelector('.cell [data-a=run]').click(); })()`);
  let out = "";
  for (let i = 0; i < 1200; i++) {
    await sleep(250);
    out = await b.evaluate("document.querySelector('.cell .out').textContent");
    if (out.includes("RESULT") || out.includes("Error")) break;
  }
  b.close();
  if (!out.includes("RESULT")) throw new Error("sagebrush: " + out.slice(-800));
  return { ready, r: JSON.parse(out.split("RESULT ")[1]) };
}

async function runPyodide() {
  const b = await browser();
  const t0 = Date.now();
  await b.send("Page.navigate", { url: pyUrl });
  for (;;) { await sleep(50); if (await b.evaluate("typeof window.bench === 'function' && typeof loadPyodide === 'function'")) break; }
  const res = JSON.parse(await b.evaluate(`bench(${JSON.stringify(code)})`));
  b.close();
  if (!res.out.includes("RESULT")) throw new Error("pyodide: " + res.out.slice(-800));
  return { ready: Math.round(res.readyNav), readyInner: res.ready, version: res.version, npver: res.npver, r: JSON.parse(res.out.split("RESULT ")[1]) };
}

const sb = await runSagebrush();
const py = await runPyodide();
const rows = Object.keys(sb.r.best);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b) || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]))) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-5 * Math.max(Math.abs(a), Math.abs(b)));
let md = `| benchmark (ms: best, median) | sagebrush | Pyodide ${py.version} (NumPy ${py.npver}) | ratio of best | answers |\n|---|---:|---:|---:|---|\n`;
md += `| startup: navigation to \`import numpy\` done (fresh profile, cache disabled) | ${sb.ready} | ${py.ready} | ${(py.ready / sb.ready).toFixed(1)}× | |\n`;
let differ = 0;
for (const k of rows) {
  const s = sb.r.best[k], p = py.r.best[k];
  const ratio = s <= p ? `${(p / s).toFixed(1)}× faster` : `${(s / p).toFixed(1)}× slower`;
  const ok = same(sb.r.check[k], py.r.check[k]);
  if (!ok) differ++;
  md += `| ${k} | ${s}, ${sb.r.median[k]} | ${p}, ${py.r.median[k]} | ${ratio} | ${ok ? "agree" : "DIFFER"} |\n`;
}
md += `\nTimes from performance.now / time.perf_counter (about 0.1 ms resolution in the browser: sub-millisecond rows are imprecise). Answers are compared by a digest (shape and the sum of absolute values to 6 digits) computed outside the timers; ${differ} differ.\n`;
console.log(md);
writeFileSync(here + "last-results.md", md);
