// Run cases.py in headless Chromium under sagebrush (the notebook page from
// web/dist) and under Pyodide (from the jsDelivr CDN); print a table.
//   node bench/browser/run.mjs [sagebrush-url] [pyodide-url]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const code = readFileSync(here + "cases.py", "utf8");
const sbUrl = process.argv[2] ?? "http://127.0.0.1:8765/";
const pyUrl = process.argv[3] ?? "http://127.0.0.1:8766/pyodide.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browser() {
  const chrome = spawn("chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9335", "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
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
  await b.evaluate(`(() => { const c = document.querySelector('.cell textarea'); c.value = 'import numpy'; document.querySelector('.cell [data-a=run]').click(); })()`);
  for (;;) {
    await sleep(10);
    if (await b.evaluate("document.querySelector('.cell .n').textContent === '[1]'")) break;
  }
  const ready = Date.now() - t0;
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
  return { ready: Date.now() - t0 - 0, readyInner: res.ready, version: res.version, npver: res.npver, r: JSON.parse(res.out.split("RESULT ")[1]) };
}

const sb = await runSagebrush();
const py = await runPyodide();
const rows = Object.keys(sb.r);
let md = `| benchmark (ms, best of runs) | sagebrush | Pyodide ${py.version} (NumPy ${py.npver}) | ratio |\n|---|---:|---:|---:|\n`;
md += `| startup to \`import numpy\` (cold cache) | ${sb.ready} | ${Math.round(py.readyInner)} | ${(py.readyInner / sb.ready).toFixed(1)}× faster |\n`;
for (const k of rows) {
  const s = sb.r[k], p = py.r[k];
  const ratio = s <= p ? `${(p / s).toFixed(1)}× faster` : `${(s / p).toFixed(1)}× slower`;
  md += `| ${k} | ${s} | ${p} | ${ratio} |\n`;
}
console.log(md);
writeFileSync(here + "last-results.md", md);
