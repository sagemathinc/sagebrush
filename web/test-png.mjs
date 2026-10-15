// PNG files in the notebook page (headless Chrome): the PNG module
// (sagebrush-raster.wasm) is fetched only when Python first writes or reads
// a PNG, savefig and imread work in the worker, and a copy of the module
// that is not the one the page was built with is refused (its SHA-256,
// src/runtime/raster.ts), with an error and nothing run.
//
//   bun web/build.ts && node web/test-png.mjs      (CHROME=... for the browser)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };
const port = 9900 + Math.floor(Math.random() * 90);
const cdp = 9500 + Math.floor(Math.random() * 90);
const here = new URL(".", import.meta.url).pathname;
const server = spawn("python3", [join(here, "serve.py"), String(port)], { stdio: "ignore" });
await sleep(800);
const profile = mkdtempSync(join(tmpdir(), "sb-png-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdp}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cleanup = () => { chrome.kill(); server.kill(); };
process.on("uncaughtException", (e) => { console.log("FAIL " + (e?.stack ?? e)); cleanup(); process.exit(1); });
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const handlers = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method) for (const h of handlers) h(m);
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const until = async (expr, ms = 60000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
const ready = () => until("document.querySelector('#status')?.textContent.startsWith('ready')");
async function runCode(code) {
  await ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); })()`);
  const last = "[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1)";
  await until(`(() => /\\[\\d+\\]/.test(${last}.querySelector('.n').textContent))()`);
  return ev(`${last}.querySelector('.out').textContent`);
}
// the module's requests, seen (and, to test the check, answered) here
let requests = [], tamper = false;
handlers.push((m) => {
  if (m.method !== "Fetch.requestPaused") return;
  requests.push(m.params.request.url);
  if (!tamper) return void send("Fetch.continueRequest", { requestId: m.params.requestId });
  const body = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]).toString("base64"); // an empty, valid wasm module
  send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/wasm" }], body });
});
const fetched = () => requests.some((u) => /\/sagebrush-raster\.wasm\?h=[0-9a-f]{16}$/.test(u));

await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-raster.wasm*" }] });
await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
ok(await ready(), "the notebook is ready");
let out = await runCode("import matplotlib.pyplot as plt\nplt.plot([1, 3, 2])\nplt.title('a plot')\nplt.savefig('a.svg')\nprint('svg written')");
ok(out.includes("svg written") && !fetched(), "an SVG is written without fetching the PNG module: " + JSON.stringify(out));
out = await runCode("plt.plot([1, 3, 2])\nplt.savefig('a.png')\na = plt.imread('a.png')\nprint(a.shape, a.dtype, a[0, 0])");
ok(out.includes("(480, 640, 4) float32 [1. 1. 1. 1.]"), "savefig writes a PNG and imread reads it: " + JSON.stringify(out));
ok(fetched(), "...the PNG module fetched then, by its content hash");

// a module other than the one the page was built with: refused
tamper = true;
requests = [];
await send("Page.reload", { ignoreCache: true });
await sleep(500);
ok(await ready(), "the notebook is ready again");
out = await runCode("import io, matplotlib.pyplot as plt\nplt.plot([1, 2])\ntry:\n    plt.savefig(io.BytesIO())\nexcept Exception as e:\n    print(type(e).__name__, e)");
ok(fetched(), "(the module's request was answered with other bytes)");
ok(/RuntimeError Sagebrush's PNG module: the PNG module fetched is not the one this page was built with/.test(out), "...which are refused: " + JSON.stringify(out));

cleanup();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
