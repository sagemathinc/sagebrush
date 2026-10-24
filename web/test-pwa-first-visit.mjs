// A first visit, offline afterwards (web/sw.js): the library's chunks the
// page fetched before the service worker controlled it are kept, once it
// does (the page tells it which: web/notebook/worker-kernel.js), so the
// next visit imports them offline.  Before, a visitor who imported json and
// went offline could not import it again once the browser's HTTP cache no
// longer had its chunk (cleared here).  The page's registration is held
// back until Python has imported, so those chunks are fetched past the
// service worker every time.  Also: what the service worker does with what
// it is told, which is only a name of one of this build's chunks; anything
// else is ignored, fetching nothing, and a chunk it can't fetch or whose
// bytes are not the build's is not kept, quietly.  With the runner (the
// site's) and without it (?runner=0).
//
//   bun web/build.ts && node web/test-pwa-first-visit.mjs      (CHROME=... for the browser)
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "./test-port.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };
const here = new URL(".", import.meta.url).pathname;
const chunks = readdirSync(join(here, "dist", "lib"));
const chunk = (prefix) => "lib/" + chunks.find((f) => f.startsWith(prefix));
setTimeout(() => { console.log("FAIL the test did not end within 400 s"); process.exit(1); }, 400_000).unref();

// web/dist (web/serve.py) behind a proxy that records each path asked for,
// and answers some with other bytes.  serve.py picks its own port and says it
// once it is listening (startServe, web/test-port.mjs: bounded, and the child
// killed if it fails), as in test-pwa-update.mjs since #103; anything that
// fails after it started stops it again.
function site() {
  return (async () => {
    let server = null, front = null;
    try {
      const serve = startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] })));
      const upstream = await serve.port;
      const asked = [], tamper = new Set();
      front = createServer((req, res) => {
        const path = new URL(req.url, "http://x").pathname;
        asked.push(path);
        const up = request({ host: "127.0.0.1", port: upstream, path: req.url, method: req.method, headers: req.headers }, (r) => {
          if (tamper.has(path) && r.statusCode === 200) {
            r.resume();
            const h = { ...r.headers };
            delete h["content-length"]; delete h["etag"]; delete h["last-modified"];
            res.writeHead(200, h);
            return res.end('{"build":"not this one","group":"x","kind":"src","files":{}}');
          }
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        });
        up.on("error", () => { res.destroy(); });
        req.pipe(up);
      });
      await new Promise((resolve, reject) => { front.once("error", reject); front.listen(0, "127.0.0.1", resolve); });
      const stop = () => new Promise((r) => { server.kill(); front.closeAllConnections?.(); front.close(() => r()); });
      return { url: `http://127.0.0.1:${front.address().port}/`, asked, tamper, stop };
    } catch (e) {
      server?.kill("SIGKILL");
      if (front) { front.closeAllConnections?.(); front.close(); }
      throw e;
    }
  })();
}

async function visit(variant) {
  const s = await site();
  const profile = mkdtempSync(join(tmpdir(), "sb-pwa1-"));
  let cdpPort = 0;
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  cdpPort = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map(), errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
  const ready = () => until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
  async function runCode(code) {
    const k = await ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; if (cs.at(-1).querySelector('textarea').value.trim()) document.querySelector('#add').click(); return document.querySelectorAll('.cell').length - 1; })()`);
    const c = `document.querySelectorAll('.cell')[${k}]`;
    await ev(`(() => { const c = ${c}; const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); })()`);
    await until(`/\\[\\d+\\]/.test(${c}.querySelector('.n').textContent)`, 120000);
    return String(await ev(`${c}.querySelector('.out').textContent`));
  }
  const keptExpr = (path) => `(async () => { for (const name of await caches.keys()) { if (!name.startsWith("sagebrush-")) continue; const c = await caches.open(name); if ((await c.keys()).some((r) => new URL(r.url).pathname === ${JSON.stringify("/" + path)})) return true; } return false; })()`;
  const kept = (path) => ev(keptExpr(path));
  const tell = (data) => ev(`(() => { navigator.serviceWorker.controller.postMessage(${data}); return true; })()`);
  const name = `${variant || "runner"}:`;
  try {
    await send("Page.enable");
    await send("Runtime.enable");
    // (the page's registration held until released: its first chunks go past the service worker)
    const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      let release; const gate = new Promise((r) => (release = r)); window.__releaseSW = () => release();
      const reg = ServiceWorkerContainer.prototype.register;
      ServiceWorkerContainer.prototype.register = function (...a) { return gate.then(() => reg.apply(this, a)); };
    })()` });
    await send("Page.navigate", { url: s.url + variant });
    ok(await ready(), `${name} the notebook is ready`);
    ok((await ev("typeof window.__releaseSW")) === "function" && (await ev("navigator.serviceWorker.getRegistrations().then((r) => r.length)")) === 0, `${name} (its service worker's registration is held back)`);
    let out = await runCode("import fractions, json\nprint(fractions.Fraction(1, 3), json.dumps([1]))");
    ok(out.includes("1/3 [1]") && (await ev("navigator.serviceWorker.controller === null")), `${name} Python imports on a first visit, no service worker yet: ` + JSON.stringify(out));
    const core = [chunk("core.src."), chunk("core.pre.")];
    ok(core.every((c) => s.asked.includes("/" + c)), `${name} (its core chunks were fetched)`);
    await ev("window.__releaseSW()");
    ok(await until("navigator.serviceWorker.controller !== null", 60000), `${name} the service worker installs and controls the page`);
    ok(await until(`Promise.all([${core.map(keptExpr).join(", ")}]).then((a) => a.every(Boolean))`, 30000), `${name} the chunks fetched before it controlled the page are kept`);

    // what the service worker is told: only names of this build's chunks
    await sleep(500);
    const before = s.asked.length;
    const magmaSrc = chunk("magma.src."), magmaPre = chunk("magma.pre."), matlabSrc = chunk("matlab.src.");
    const fake = magmaSrc.replace(/\.[0-9a-f]{16}\.json$/, ".0000000000000000.json");
    const bad = [
      ["a name no chunk of this build has", `{ keep: [${JSON.stringify(fake)}] }`],
      ["paths that are not chunks", `{ keep: ["sw.js", "index.html", "../lib/x.json", "/etc/passwd"] }`],
      ["a chunk at another origin", `{ keep: [${JSON.stringify("https://example.com/" + magmaSrc)}] }`],
      ["a chunk with a query", `{ keep: [${JSON.stringify(magmaSrc + "?x=1")}] }`],
      ["more names than there are chunks", `{ keep: Array(${chunks.length + 1}).fill(${JSON.stringify(magmaSrc)}) }`],
      ["not a list", `{ keep: ${JSON.stringify(magmaSrc)} }`],
      ["a list with a non-string", `{ keep: [${JSON.stringify(magmaSrc)}, 42] }`],
      ["a good name beside a bad one", `{ keep: [${JSON.stringify(magmaSrc)}, "sw.js"] }`],
    ];
    for (const [, data] of bad) await tell(data);
    await sleep(2000);
    const asked = s.asked.slice(before);
    ok(asked.length === 0, `${name} told what is not a list of this build's chunks, it fetches nothing: ` + JSON.stringify(asked) + " (" + bad.map((b) => b[0]).join("; ") + ")");
    ok(!(await kept(magmaSrc)), `${name} ...and keeps nothing`);
    // (a good name alone: fetched and kept)
    await tell(`{ keep: [${JSON.stringify(matlabSrc)}] }`);
    ok(await until(keptExpr(matlabSrc), 15000), `${name} told a chunk of this build, it keeps it`);
    // (its bytes not the build's: not kept)
    s.tamper.add("/" + magmaSrc);
    await tell(`{ keep: [${JSON.stringify(magmaSrc)}] }`);
    for (let i = 0; i < 50 && !s.asked.includes("/" + magmaSrc); i++) await sleep(100);
    await sleep(1000);
    ok(s.asked.includes("/" + magmaSrc) && !(await kept(magmaSrc)), `${name} a chunk whose bytes are not the build's is fetched but not kept`);
    s.tamper.clear();

    // offline: the next visit imports them
    await s.stop();
    ok((await fetch(s.url).then(() => "up", () => "down")) === "down", `${name} the server is stopped`);
    // (a chunk it can't fetch now: not kept, nothing else changes)
    await tell(`{ keep: [${JSON.stringify(magmaPre)}] }`);
    await sleep(1000);
    ok(!(await kept(magmaPre)), `${name} offline, a chunk it can't fetch is not kept, quietly`);
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    // (the browser's HTTP cache cleared, which would otherwise answer for an
    // immutable chunk as long as it keeps it: only the service worker's copy)
    await send("Network.enable");
    await send("Network.clearBrowserCache");
    await send("Page.reload", { ignoreCache: false });
    await sleep(1500);
    ok(await ready(), `${name} offline, the notebook loads`);
    out = await runCode("import fractions, json\nprint(fractions.Fraction(2, 4), json.dumps({'a': 1}))");
    ok(out.includes('1/2 {"a": 1}'), `${name} offline, the modules imported on the first visit import again: ` + JSON.stringify(out));
    ok(!errors.length, `${name} no exceptions on the page: ` + JSON.stringify(errors));
  } finally {
    ws.close();
    chrome.kill("SIGKILL");
    await s.stop().catch(() => {});
    await sleep(300);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

await visit("");
await visit("?runner=0");
console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
