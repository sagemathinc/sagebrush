// ci: web-browser/notebook order=131
// engine/nd's numerics module in the notebook page (headless Chrome; the test
// server is cross-origin isolated, as the site is): sagebrush-nd.wasm is
// fetched only when np.linalg.cholesky first runs, by its content hash, and
// cholesky then runs on it (np.linalg._kernels() says so); a copy of the
// module that is not the one the page was built with is refused (its SHA-256,
// src/runtime/nd.ts), and that session runs the TypeScript code instead,
// saying why (CHOL-1 step 2; @sagebrush's ruling R1: one path per session).
//
//   bun web/build.ts && node web/test-nd.mjs      (CHROME=... for the browser)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "./test-port.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };
const port = await freePort();
let cdp = Number(process.env.CDP_PORT) || 0;
const here = new URL(".", import.meta.url).pathname;
const server = spawn("python3", [join(here, "serve.py"), String(port)], { stdio: "ignore" });
await sleep(800);
const profile = mkdtempSync(join(tmpdir(), "sb-nd-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdp}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!cdp) cdp = await devtoolsPort(profile);
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
const fetched = () => requests.some((u) => /\/sagebrush-nd\.wasm\?h=[0-9a-f]{16}$/.test(u));
// (60 x 60: cholesky uses engine/nd from n = 48; a 3 x 3 one, the TypeScript loop, which fetches nothing)
const A = "M = np.random.default_rng(7).standard_normal((60, 60)); A = M @ M.T + 60 * np.eye(60); S = np.array([[4.0, 2.0], [2.0, 5.0]])";

await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-nd.wasm*" }] });
await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
ok(await ready(), "the notebook is ready");
let out = await runCode(`import numpy as np\n${A}\nprint(np.linalg.solve(A, np.ones(60)).shape, np.linalg.cholesky(S).tolist(), np.linalg._kernels()['cholesky']['path'])`);
ok(out.includes("(60,) [[2.0, 0.0], [1.0, 2.0]] undecided") && !fetched(), "NumPy, and cholesky of a small matrix, run without fetching the numerics module: " + JSON.stringify(out));
out = await runCode("L = np.linalg.cholesky(A)\nk = np.linalg._kernels()['cholesky']\nprint(k['path'], k['kernel'], k['from_n'], np.abs(L @ L.T - A).max() / (60 * np.abs(A).sum(axis=1).max()) < 1e-15, np.all(np.triu(L, 1) == 0))");
ok(out.includes("engine/nd wasm-simd128-4x4 48 True True"), "cholesky runs on engine/nd: " + JSON.stringify(out));
ok(fetched() && requests.length === 1, "...the module fetched then, once, by its content hash");

// a module other than the one the page was built with: refused, and the session runs the TypeScript code
tamper = true;
requests = [];
await send("Page.reload", { ignoreCache: true });
await sleep(500);
ok(await ready(), "the notebook is ready again");
out = await runCode(`import numpy as np\n${A}\nL = np.linalg.cholesky(A)\nk = np.linalg._kernels()['cholesky']\nprint(np.abs(L @ L.T - A).max() / (60 * np.abs(A).sum(axis=1).max()) < 1e-15, k['path'], '|', k['why'])`);
ok(fetched(), "(the module's request was answered with other bytes)");
ok(out.includes("True typescript | the numerics module could not be loaded (the numerics module fetched is not the one this page was built with)"), "...which are refused, and cholesky runs the TypeScript code, saying why: " + JSON.stringify(out));
out = await runCode("L2 = np.linalg.cholesky(2 * A)\nprint('again', np.linalg._kernels()['cholesky']['path'])");
ok(out.includes("again typescript") && requests.length === 1, "...for the whole session, with no second fetch: " + JSON.stringify(out));

cleanup();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
