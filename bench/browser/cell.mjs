// Run one Python cell in the sagebrush notebook (web/dist served at
// http://127.0.0.1:8765/) in headless Chromium and print its output, or,
// with --js, run a JavaScript function body in a Web Worker of a blank page.
//   node bench/browser/cell.mjs file.py
//   node bench/browser/cell.mjs --js file.js     (the body returns a value)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
const js = process.argv[2] === "--js";
const code = readFileSync(process.argv[js ? 3 : 2], "utf8");
const url = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn("chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9336", "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 100; i++) { try { targets = await (await fetch("http://127.0.0.1:9336/json")).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
try {
  if (js) {
    const src = `onmessage = async () => { try { postMessage(String(await (async () => { ${code} })())); } catch (e) { postMessage("error: " + e); } };`;
    console.log(await evaluate(`new Promise((res) => { const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(src)}]))); w.onmessage = (e) => res(e.data); w.postMessage(0); })`));
  } else {
    await send("Page.navigate", { url });
    while (!(await evaluate("document.querySelector('#status')?.textContent.startsWith('ready')"))) await sleep(20);
    await evaluate(`(() => { const c = document.querySelector('.cell textarea'); c.value = ${JSON.stringify(code)}; document.querySelector('.cell [data-a=run]').click(); })()`);
    while (!(await evaluate("document.querySelector('.cell .n').textContent === '[1]'"))) await sleep(50);
    console.log(await evaluate("document.querySelector('.cell .out').textContent"));
  }
} finally {
  ws.close();
  chrome.kill();
}
