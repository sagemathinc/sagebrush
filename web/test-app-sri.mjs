// ci: web-sync.2 order=35 chrome
// The page's script is its own file, sagebrush-app.js?h=<hash>, with its
// integrity (sha384, web/build.ts).  If a deploy lands between a page's HTML
// and its script, the old URL brings the new bytes, which the browser would
// otherwise run against the old page (and keep, as immutable).  Here the
// build's page is served with other bytes at its script's URL (one byte
// changed, the same length): the browser refuses them and the app never
// starts, no notebook, no worker.  Then the same through a service worker
// that controls the page but has kept nothing (its caches emptied): it passes
// the network's answer through, and the browser still refuses it.  And the
// control each time: the right bytes, and the notebook is ready, so a row
// that refused everything could not pass.
//
//   bun web/build.ts && node web/test-app-sri.mjs      (CHROME=... for the browser)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "./test-port.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };
const here = new URL(".", import.meta.url).pathname;
setTimeout(() => { console.log("FAIL the test did not end within 300 s"); process.exit(1); }, 300_000).unref();

// web/dist (web/serve.py) behind a proxy that records each path asked for and,
// while `tamper` is set, answers the page's script with one byte changed.  The
// script is never kept by the browser's HTTP cache here (no-store), so each
// load asks for it.
async function site() {
  let server = null, front = null;
  try {
    const serve = startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] })));
    const upstream = await serve.port;
    const s = { asked: [], tamper: false };
    front = createServer((req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      s.asked.push(path);
      const up = request({ host: "127.0.0.1", port: upstream, path: req.url, method: req.method, headers: { ...req.headers, "if-none-match": "", "if-modified-since": "" } }, (r) => {
        if (path !== "/sagebrush-app.js" || r.statusCode !== 200) { res.writeHead(r.statusCode, r.headers); return r.pipe(res); }
        const parts = [];
        r.on("data", (d) => parts.push(d));
        r.on("end", () => {
          const body = Buffer.concat(parts);
          // (its last space a tab: the script still parses, so only its integrity can refuse it)
          if (s.tamper) body[body.lastIndexOf(0x20)] = 0x09;
          const h = { ...r.headers, "cache-control": "no-store", "content-length": String(body.length) };
          delete h.etag; delete h["last-modified"];
          res.writeHead(200, h);
          res.end(body);
        });
      });
      up.on("error", () => { res.destroy(); });
      req.pipe(up);
    });
    await new Promise((resolve, reject) => { front.once("error", reject); front.listen(0, "127.0.0.1", resolve); });
    s.stop = () => new Promise((r) => { server.kill(); front.closeAllConnections?.(); front.close(() => r()); });
    s.url = `http://127.0.0.1:${front.address().port}/`;
    return s;
  } catch (e) {
    server?.kill("SIGKILL");
    if (front) { front.closeAllConnections?.(); front.close(); }
    throw e;
  }
}

async function visit(withSW) {
  const s = await site();
  const profile = mkdtempSync(join(tmpdir(), "sb-sri-"));
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const cdpPort = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map(), logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Log.entryAdded") logs.push(m.params.entry.text);
    if (m.method === "Runtime.consoleAPICalled") logs.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
  const ready = () => until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
  const name = withSW ? "service worker, its caches emptied:" : "no service worker:";
  const load = async () => { logs.length = 0; s.asked.length = 0; await send("Network.clearBrowserCache"); await send("Page.reload", { ignoreCache: false }); await sleep(1000); };
  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Network.enable");
    // (the script tag's error event, seen from before the page's own code; and, without the service worker, its
    // registration never made)
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      addEventListener("error", (e) => { if (e.target instanceof HTMLScriptElement && /sagebrush-app\\.js/.test(e.target.src)) window.__appError = true; }, true);
      ${withSW ? "" : "ServiceWorkerContainer.prototype.register = () => new Promise(() => {});"}
    })()` });
    await send("Page.navigate", { url: s.url });
    await sleep(1000);
    // the control: the build's own bytes
    ok(await ready(), `${name} the right bytes: the notebook is ready`);
    if (withSW) {
      ok(await until("navigator.serviceWorker.controller !== null", 60000), `${name} (the service worker controls the page)`);
      // (it has kept nothing: whatever it is asked for comes from the network)
      ok(await ev("caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).then(() => caches.keys()).then((ks) => ks.length === 0)"), `${name} (its caches emptied)`);
    } else {
      ok((await ev("navigator.serviceWorker.controller === null")), `${name} (no service worker controls the page)`);
    }

    // the straddle: the page's HTML, other bytes at its script's URL
    s.tamper = true;
    await load();
    await sleep(3000);
    ok(s.asked.includes("/sagebrush-app.js"), `${name} (the script was asked for, and answered with other bytes)`);
    if (withSW) ok(await ev("navigator.serviceWorker.controller !== null"), `${name} (the service worker still controls the page)`);
    ok((await ev("window.__appError === true")) && logs.some((t) => /integrity/i.test(t)), `${name} other bytes: the browser refuses the script, naming its integrity: ` + JSON.stringify(logs.filter((t) => /integrity/i.test(t)).map((t) => t.slice(0, 160))));
    const started = await ev(`({ app: typeof window.sagebrush !== "undefined", cells: document.querySelectorAll(".cell").length, ready: !!document.querySelector("#status")?.textContent.startsWith("ready") })`);
    const fetched = s.asked.filter((p) => p !== "/sagebrush-app.js" && (/^\/sagebrush-[\w-]+\.js$/.test(p) || p.startsWith("/lib/")));
    ok(started && !started.app && started.cells === 0 && !started.ready && fetched.length === 0, `${name} ...and nothing of the app starts: no window.sagebrush, no cell, no worker or chunk fetched: ` + JSON.stringify({ ...started, fetched }));
    if (withSW) ok(await ev("caches.keys().then(async (ks) => { for (const k of ks) for (const r of await (await caches.open(k)).keys()) if (new URL(r.url).pathname === '/sagebrush-app.js') return false; return true; })"), `${name} ...and the service worker hasn't kept those bytes`);

    // and the build's bytes again: it starts
    s.tamper = false;
    await load();
    ok(await ready(), `${name} the right bytes again: the notebook is ready`);
    ok(!logs.some((t) => /integrity/i.test(t)), `${name} ...with no integrity error`);
  } finally {
    ws.close();
    chrome.kill("SIGKILL");
    await s.stop().catch(() => {});
    await sleep(300);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

await visit(false);
await visit(true);
console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
