// The app (PWA) works offline: load sagebrush.space's files (web/dist, by
// web/serve.py), let the service worker keep them, stop the server, reload,
// and run Python.  Also checks the manifest and installability.
//
//   bun web/build.ts && node web/test-pwa.mjs      (CHROME=... for the browser)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };
const port = 9800 + Math.floor(Math.random() * 100);
const here = new URL(".", import.meta.url).pathname;
let server = spawn("python3", [join(here, "serve.py"), String(port)], { stdio: "ignore" });
await sleep(800);
const profile = mkdtempSync(join(tmpdir(), "sb-pwa-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=9342", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cleanup = () => { chrome.kill(); server.kill(); };
process.on("uncaughtException", (e) => { console.log("FAIL " + (e?.stack ?? e)); cleanup(); process.exit(1); });
let targets;
for (let i = 0; i < 100; i++) { try { targets = await (await fetch("http://127.0.0.1:9342/json")).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
const ready = () => until("document.querySelector('#status')?.textContent.startsWith('ready')");
async function runCode(code) {
  await ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); })()`);
  const last = "[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1)";
  await until(`(() => /\\[\\d+\\]/.test(${last}.querySelector('.n').textContent))()`);
  return ev(`${last}.querySelector('.out').textContent`);
}

const url = `http://127.0.0.1:${port}/`;
await send("Page.navigate", { url });
await ready();
const manifest = await send("Page.getAppManifest");
ok(!manifest.errors?.length && /"name": "Sagebrush"/.test(manifest.data ?? ""), "the manifest parses: " + JSON.stringify(manifest.errors ?? []));
const inst = await send("Page.getInstallabilityErrors");
ok((inst.installabilityErrors ?? []).length === 0, "installable: " + JSON.stringify(inst.installabilityErrors ?? inst));
ok(await until("navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready.then(() => true)"), "the service worker is active");
// wait until everything is cached
ok(await until("caches.keys().then(async (ks) => { const k = ks.find((k) => k.startsWith('sagebrush-')); if (!k) return false; const c = await caches.open(k); return (await c.keys()).length >= 10; })"), "the app's files are cached");
let out = await runCode("print(2**100)");
ok(out.includes("1267650600228229401496703205376"), "Python runs online: " + JSON.stringify(out));
// offline: no server at all
server.kill();
await sleep(500);
ok((await fetch(url).then(() => "up", () => "down")) === "down", "the server is stopped");
await send("Page.reload", { ignoreCache: false });
await sleep(1500);
ok(await ready(), "offline, the notebook loads: " + (await ev("document.querySelector('#status')?.textContent")));
ok(await ev("crossOriginIsolated"), "offline, the page is still cross-origin isolated (Stop keeps variables)");
out = await runCode("from sage_all import factor\nprint(factor(2**64 + 1))");
ok(out.includes("274177 * 67280421310721"), "offline, Python and the engines run: " + JSON.stringify(out));
ws.close(); cleanup();
console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
