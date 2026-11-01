// The app (PWA) works offline: load sagebrush.space's files (web/dist, by
// web/serve.py), let the service worker keep them, stop the server, reload,
// and run Python.  Also checks the manifest and installability.
//
//   bun web/build.ts && node web/test-pwa.mjs      (CHROME=... for the browser)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "./test-port.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };
const port = await freePort();
const here = new URL(".", import.meta.url).pathname;
let server = spawn("python3", [join(here, "serve.py"), String(port)], { stdio: "ignore" });
await sleep(800);
const profile = mkdtempSync(join(tmpdir(), "sb-pwa-"));
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!cdpPort) cdpPort = await devtoolsPort(profile);
const cleanup = () => { chrome.kill(); server.kill(); };
process.on("uncaughtException", (e) => { console.log("FAIL " + (e?.stack ?? e)); cleanup(); process.exit(1); });
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
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
// what installing kept: the shell, not the engine, the documentation
// indexes or the Python library's chunks (LAZY: kept once used online)
const kept = (match) => ev(`(async () => { for (const name of await caches.keys()) { if (!name.startsWith("sagebrush-")) continue; const c = await caches.open(name); if ((await c.keys()).some((r) => r.url.includes(${JSON.stringify(match)}))) return true; } return false; })()`);
ok(!(await kept("sagebrush-engine.wasm")) && !(await kept("docs-index")) && !(await kept("/lib/")), "installing keeps neither the engine, the documentation indexes nor the library's chunks");
// a page the service worker controls (its worker too): the engine and Python's
// documentation index, used online, are kept
await send("Page.reload", { ignoreCache: false });
await sleep(1000);
await ready();
out = await runCode("from sage_all import factor\nprint(factor(2**64 + 1))");
ok(out.includes("274177 * 67280421310721") && (await until(`(async () => { for (const name of await caches.keys()) { const c = await caches.open(name); if ((await c.keys()).some((r) => r.url.includes("sagebrush-engine.wasm"))) return true; } return false; })()`)), "the engine, used online, is kept: " + JSON.stringify(out));
ok((await kept("/lib/sage.src.")) && (await kept("/lib/sage.pre.")) && (await kept("/lib/core.pre.")), "Sage's part of the library (sources and compiled), fetched as Sage mode started, is kept");
// a module of a part no mode's start fetches, imported (fetched synchronously
// by the worker, web/lib-lazy.ts): kept too
out = await runCode("import heapq\nprint(heapq.nsmallest(2, [3, 1, 2]))");
ok(out.includes("[1, 2]") && (await until(`(async () => { for (const name of await caches.keys()) { const c = await caches.open(name); if ((await c.keys()).some((r) => r.url.includes("/lib/mod-heapq.src."))) return true; } return false; })()`)), "a library module imported online, its chunk fetched when imported, is kept: " + JSON.stringify(out));
ok(!(await kept("/lib/matlab.")), "(MATLAB's part, never used, is not)");
ok(await ev(`fetch("docs-index-python.json").then((r) => r.ok)`) && (await until(`(async () => { for (const name of await caches.keys()) { const c = await caches.open(name); if ((await c.keys()).some((r) => r.url.includes("docs-index-python.json"))) return true; } return false; })()`)), "Python's documentation index, used online, is kept");
// The cache is the origin's storage: code that got into the origin (an escape
// from Python into the worker, say) could rewrite a kept file.  A rewritten
// copy is never used (SEC-8D6-1): a chunk of the library's compiled code, the engine.
const poison = (match, body) => ev(`(async () => {
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    const req = (await cache.keys()).find((r) => r.url.includes(${JSON.stringify(match)}));
    if (!req) continue;
    await cache.put(req, new Response(await (${body})(await (await cache.match(req)).clone()), { headers: { "Content-Type": "application/octet-stream" } }));
    return true;
  }
  return false;
})()`);
ok(await poison("/lib/core.pre.", `async (res) => { const p = await res.json(); p.modules["py|fractions"].code = "(function module$$($g, R) { $g.POISONED = 'cache-poison-ran'; })"; return JSON.stringify(p); }`), "(the kept copy of the library's compiled core rewritten)");
ok(await poison("sagebrush-engine.wasm?h=", `async (res) => new Uint8Array(await res.arrayBuffer()).map((b, i) => (i > 1000 && i < 2000 ? 0 : b))`), "(the engine's kept copy rewritten)");
await send("Page.reload", { ignoreCache: false });
await sleep(1000);
await ready();
out = await runCode("import fractions\nprint(getattr(fractions, 'POISONED', 'clean'))\nfrom sage_all import factor\nprint(factor(2**64 + 1))");
ok(out.includes("clean") && out.includes("274177 * 67280421310721"), "a rewritten kept copy is not used: the library's own code and the engine run: " + JSON.stringify(out));
ok(await ev(`(async () => { for (const name of await caches.keys()) { const c = await caches.open(name); const req = (await c.keys()).find((r) => r.url.includes("/lib/core.pre.")); if (req) return !(await (await c.match(req)).text()).includes("cache-poison-ran"); } return false; })()`), "...and the kept copy is the site's again");
// (and framed only by this site: frame-ancestors 'self' and X-Frame-Options SAMEORIGIN, security audit G-1)
ok(await ev(`fetch("/", { cache: "no-store" }).then((r) => r.status === 200 && /(^|; )frame-ancestors 'self'(;|$)/.test(r.headers.get("content-security-policy") ?? "") && r.headers.get("x-frame-options") === "SAMEORIGIN", () => false)`), "online, the page says only this site may frame it (frame-ancestors 'self', X-Frame-Options SAMEORIGIN)");
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
out = await runCode("import heapq\nprint(heapq.nsmallest(2, [3, 1, 2]))");
ok(out.includes("[1, 2]"), "offline, a library module imported online (its chunk fetched lazily then) imports: " + JSON.stringify(out));
out = await runCode("import _matlab_sparse");
ok(/could not load the Python library's matlab modules/.test(out), "offline, a module of a part never fetched is an error saying so: " + JSON.stringify(out.slice(0, 300)));
ok(await ev(`fetch("docs-index-python.json").then((r) => r.ok, () => false)`), "offline, the documentation index used online is served");
ok(await ev(`fetch("docs-index-magma.json").then(() => "served", () => "refused")`) === "refused", "offline, a documentation index never used is not there (a fetch error, as for any file offline)");
// offline, a rewritten worker is not served (it would run without the server to correct it)
ok(await poison("sagebrush-worker.js", `async () => 'postMessage({ ready: true, version: "POISONED", interrupt: null, seeded: false, startup: [] })'`), "(the worker's kept copy rewritten)");
await send("Page.reload", { ignoreCache: false });
await sleep(3000);
const status = await ev("document.querySelector('#status')?.textContent");
ok(!/POISONED/.test(status), "offline, a rewritten worker never runs (the browser's own HTTP cache, which no script can write, may still start the real one): " + JSON.stringify(status));
// The right bytes as another response (SEC-522-1): the page without its
// security headers, as a redirect, with a Refresh.  Each is put in the cache
// from this tab, and the page opened, offline, in a new tab (the browser's
// HTTP cache cleared, so only the service worker can answer).
const genuinePage = readFileSync(join(here, "dist", "index.html")).toString("base64");
const putPage = (init) => ev(`(async () => {
  const b = Uint8Array.from(atob(${JSON.stringify(genuinePage)}), (c) => c.charCodeAt(0));
  // (the service worker's cache, under the page's key: it drops a bad entry, so it may be gone)
  const name = (await caches.keys()).find((k) => k.startsWith("sagebrush-"));
  if (!name) return false;
  const c = await caches.open(name);
  const req = (await c.keys()).find((r) => new URL(r.url).pathname === "/") ?? new Request(new URL("/", location.href));
  await c.put(req, new Response(b, ${JSON.stringify(init)}));
  return (await c.match(req)).type === "default";
})()`);
// (the service worker looked at the rewritten entry, refused it and dropped it)
const pageDropped = () => ev(`(async () => { const name = (await caches.keys()).find((k) => k.startsWith("sagebrush-")); const c = await caches.open(name); return !(await c.keys()).some((r) => new URL(r.url).pathname === "/"); })()`);
async function openTab(path) {
  // (opened blank, its HTTP cache off, then sent to the page: so nothing but
  // the service worker can answer; sagebrush-daybreak's suggestion)
  const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: "PUT" })).json();
  const tws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (tws.onopen = r));
  let k = 0; const w = new Map();
  tws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { w.get(m.id)(m.result ?? m.error); w.delete(m.id); } };
  const tsend = (method, params = {}) => new Promise((r) => { const id = ++k; w.set(id, r); tws.send(JSON.stringify({ id, method, params })); });
  await tsend("Network.enable");
  await tsend("Network.setCacheDisabled", { cacheDisabled: true });
  await tsend("Network.clearBrowserCache");
  await tsend("Page.navigate", { url: url + path.replace(/^\//, "") });
  await sleep(2500);
  const r = (await tsend("Runtime.evaluate", { expression: "({ path: location.pathname, href: location.href, loaded: !!document.querySelector('#status'), isolated: self.crossOriginIsolated })", returnByValue: true })).result?.value ?? {};
  // (where it went, even to an error page: a followed redirect shows here)
  r.went = ((await tsend("Page.getNavigationHistory")).entries ?? []).map((e) => e.url).join(" ");
  await tsend("Page.close").catch(() => {});
  tws.close();
  return r;
}
await send("Network.enable");
// (security audit G-3b: offline, every file the service worker serves from its kept copies says nosniff, as the
// network's response does (web/_headers' /*): each of the build's DIGESTS paths fetched from this page; those served
// must all carry it, the page among them, and at least as many as the shell the service worker keeps at install)
{
  const sw = readFileSync(join(here, "dist", "sw.js"), "utf8"), m = /const DIGESTS = (\{.*?\});\n/s.exec(sw), sh = /const SHELL = (\[.*?\]);\n/s.exec(sw);
  const paths = m ? Object.keys(JSON.parse(m[1])) : [], shell = sh ? JSON.parse(sh[1]).length : Infinity;
  const got = await ev(`Promise.all(${JSON.stringify(paths)}.map((p) => fetch(p).then((r) => [p, r.status, r.headers.get("x-content-type-options")], () => [p, 0, null])))`);
  const served = got.filter(([, st]) => st === 200), lacking = served.filter(([, , n]) => n !== "nosniff").map(([p]) => p);
  ok(paths.length > 0 && served.some(([p]) => p === "./") && served.length >= shell && lacking.length === 0, `offline, every kept file the service worker serves says nosniff (G-3b): ${served.length} of ${paths.length} served (the shell: ${shell}), ${lacking.length} without it` + (lacking.length ? ": " + JSON.stringify(lacking.slice(0, 5)) : ""));
}
// (the same answer to a fetch from this page: the service worker's offline
// fallback, deterministic: refused, or the build's own response)
// (first: offline, the service worker answers for the page, as built)
ok(await ev(`fetch("/").then((r) => r.status === 200 && /(^|; )frame-ancestors 'self'(;|$)/.test(r.headers.get("content-security-policy") ?? "") && r.headers.get("x-frame-options") === "SAMEORIGIN", () => false)`), "offline, the service worker's kept page says only this site may frame it (frame-ancestors 'self', X-Frame-Options SAMEORIGIN)");
ok(await ev(`fetch("/").then((r) => r.status === 200 && r.headers.get("cross-origin-opener-policy") === "same-origin" && !!r.headers.get("content-security-policy"), () => false)`), "offline, the service worker serves the kept page with the build's status and headers");
const fetchPage = () => ev(`fetch("/", { cache: "no-store", redirect: "manual" }).then((r) => ({ status: r.status, type: r.type, coop: r.headers.get("cross-origin-opener-policy"), csp: !!r.headers.get("content-security-policy"), refresh: r.headers.get("refresh") }), (e) => ({ refused: String(e) }))`);
const asBuilt = (r) => !!r.refused || (r.status === 200 && r.coop === "same-origin" && r.csp && !r.refresh);
for (const [what, init] of [["without its security headers", { headers: { "Content-Type": "text/html" } }], ["as a redirect", { status: 302, headers: { Location: "/redirect-proof" } }], ["with a Refresh", { headers: { "Content-Type": "text/html", Refresh: "0; url=/refresh-proof" } }]]) {
  ok(await putPage(init), `(the page's kept copy: its bytes, ${what})`);
  await send("Network.clearBrowserCache");
  const r = await fetchPage();
  ok(asBuilt(r), `offline, the page's kept copy ${what} is refused or served as built: ` + JSON.stringify(r));
}
ok(await putPage({ headers: { "Content-Type": "text/html" } }), "(the page's kept copy: its bytes, without its security headers)");
let seen = await openTab("/");
ok(!(seen.loaded && !seen.isolated) && (await pageDropped()), "offline, the page is never served without its headers (cross-origin isolation, policy), and the entry is dropped: " + JSON.stringify(seen));
ok(await putPage({ status: 302, headers: { Location: "/redirect-proof" } }), "(the page's kept copy: its bytes, as a redirect)");
seen = await openTab("/");
ok(!/redirect-proof/.test(seen.went ?? "") && !/redirect-proof/.test(seen.href ?? "") && (await pageDropped()), "offline, a kept redirect is not followed, and the entry is dropped: " + JSON.stringify(seen));
ok(await putPage({ headers: { "Content-Type": "text/html", Refresh: "0; url=/refresh-proof" } }), "(the page's kept copy: its bytes, with a Refresh)");
seen = await openTab("/");
ok(!/refresh-proof/.test(seen.went ?? "") && !/refresh-proof/.test(seen.href ?? "") && (await pageDropped()), "offline, a kept Refresh is not followed, and the entry is dropped: " + JSON.stringify(seen));
ws.close(); cleanup();
console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
