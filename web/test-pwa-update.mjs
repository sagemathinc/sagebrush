// A deploy while a notebook is open (HARD-813-1): a page opened before it
// keeps running its worker, whose library chunks (web/lib-chunks.mts) are
// named by that build, and the deploy replaced lib/ and the service worker
// (which then deletes the old caches).  A chunk that page first imports
// after the deploy must still come: from the site's Worker, which serves
// chunks from R2's lib/<name> (web/engines.ts handleLibChunk; put there by
// scripts/publish-engine.mjs) when the site's files no longer have them.
//
// web/dist is served by web/serve.py behind a front that, once "deployed",
// no longer serves lib/ itself and serves a new sw.js (another VERSION, so
// another cache, and the old chunks not in it), and sends a missing chunk to
// handleLibChunk in Miniflare with a simulated R2 bucket.  The bucket has
// every chunk but MATLAB's, to check that a chunk found nowhere is an error
// that says so.
//
//   bun web/build.ts && node web/test-pwa-update.mjs      (CHROME=... for the browser)
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "./test-port.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };

// the site's Worker's chunk route, in Miniflare, with the chunks in R2
const require = createRequire(join(here, "test-workers/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const entryFile = join(mkdtempSync(join(tmpdir(), "sb-update-")), "entry.ts");
writeFileSync(entryFile, `import { handleLibChunk } from ${JSON.stringify(join(here, "engines.ts"))};
export default { async fetch(req, env, ctx) { return (await handleLibChunk(req, env, ctx)) ?? new Response("not mine", { status: 418 }); } };`);
const script = execFileSync("bun", ["build", entryFile, "--format", "esm", "--target", "browser"], { encoding: "utf8" });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "site", modules: true, script, compatibilityDate: "2026-10-01", r2Buckets: ["ENGINES"] }] }));
const bucket = await mf.getR2Bucket("ENGINES");
// (with the pinned zone data's files, in lib/tzdata/)
const chunks = readdirSync(join(here, "dist", "lib"), { recursive: true }).filter((f) => statSync(join(here, "dist", "lib", f)).isFile());
for (const f of chunks) if (!f.startsWith("matlab")) await bucket.put("lib/" + f, readFileSync(join(here, "dist", "lib", f)));

const upstream = await freePort();
const server = spawn("python3", [join(here, "serve.py"), String(upstream)], { stdio: "ignore" });
let deployed = false;
const seen = { site: [], r2: [] };
// (what the diagnostics print if the page doesn't load: the front's failed requests, the page's console, its failed loads)
const NOTE_MAX = 40;
const notes = { front: [], console: [], network: [] };
const note = (list, line) => { list.push(String(line).slice(0, 300)); if (list.length > NOTE_MAX) list.shift(); };
const sw = readFileSync(join(here, "dist", "sw.js"), "utf8");
const front = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (deployed && path === "/sw.js") {
    // (the next build's service worker: another version, whose lists name its own chunks, not these)
    const next = sw.replace(/const VERSION = "([0-9a-f]+)"/, (_, v) => `const VERSION = "${v}next"`).replaceAll('"lib/', '"lib-of-the-next-build/');
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache" });
    return res.end(next);
  }
  if (path.startsWith("/lib/")) {
    if (deployed) {
      const r = await mf.dispatchFetch("https://sagebrush.test" + path, { method: req.method });
      seen.r2.push(path + " " + r.status);
      const body = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { ...Object.fromEntries(r.headers), "cross-origin-resource-policy": "cross-origin" });
      return res.end(body);
    }
    seen.site.push(path);
  }
  const up = request({ host: "127.0.0.1", port: upstream, path: req.url, method: req.method, headers: req.headers }, (r) => {
    if (r.statusCode >= 400) note(notes.front, `${req.method} ${path} ${r.statusCode}`);
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => { note(notes.front, `${req.method} ${path} 502 (upstream: ${e?.code ?? e})`); res.writeHead(502); res.end(); });
  req.pipe(up);
});
await new Promise((r) => front.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${front.address().port}/`;
await sleep(800);

const profile = mkdtempSync(join(tmpdir(), "sb-update-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cleanup = async () => { chrome.kill("SIGKILL"); server.kill(); front.close(); await mf.dispose(); await sleep(300); rmSync(profile, { recursive: true, force: true }); };
try {
  const cdpPort = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  const urls = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); return; }
    // (events, kept for the diagnostics)
    const p = m.params ?? {};
    if (m.method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "warning")) note(notes.console, `${p.type}: ${(p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ")}`);
    else if (m.method === "Runtime.exceptionThrown") note(notes.console, `exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
    else if (m.method === "Log.entryAdded" && p.entry?.level === "error") note(notes.console, `log: ${p.entry.text} ${p.entry.url ?? ""}`);
    else if (m.method === "Network.requestWillBeSent") { urls.set(p.requestId, p.request?.url); if (urls.size > 2000) urls.delete(urls.keys().next().value); }
    else if (m.method === "Network.loadingFailed") note(notes.network, `failed: ${urls.get(p.requestId) ?? p.requestId} ${p.errorText ?? ""} ${p.blockedReason ?? ""}`);
    else if (m.method === "Network.responseReceived" && p.response?.status >= 400) note(notes.network, `${p.response.status}: ${p.response.url}`);
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
  const runCode = async (code) => {
    await ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); })()`);
    const last = "[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1)";
    const ran = await until(`(() => /\\[\\d+\\]/.test(${last}.querySelector('.n').textContent))()`, 90000);
    if (!ran) await diagnose("a cell didn't finish in 90 s");
    // (always a string, so a check of it fails in words, never with a TypeError)
    return (await ev(`${last}.querySelector('.out').textContent`)) ?? "(no output: the cell didn't run)";
  };
  const versions = () => ev(`caches.keys().then((ks) => ks.filter((k) => k.startsWith("sagebrush-")))`);
  // (if the page doesn't load: what it and its service worker were doing, so a CI flake leaves its evidence)
  const diagnose = async (why) => {
    const state = await ev(`(async () => {
      const reg = await navigator.serviceWorker?.getRegistration?.().catch((e) => String(e));
      const sw = (w) => w ? w.state + " " + w.scriptURL : null;
      return JSON.stringify({
        href: location.href, readyState: document.readyState, isolated: globalThis.crossOriginIsolated,
        status: document.querySelector('#status')?.textContent ?? null,
        controller: sw(navigator.serviceWorker?.controller),
        registration: reg && typeof reg === "object" ? { installing: sw(reg.installing), waiting: sw(reg.waiting), active: sw(reg.active) } : reg ?? null,
        caches: await caches.keys().catch((e) => String(e)),
      });
    })()`).catch((e) => "unavailable: " + e);
    console.log(`  diagnostics (${why}):`);
    console.log("    page: " + String(state).slice(0, 2000));
    for (const [k, list] of Object.entries(notes)) for (const line of list) console.log(`    ${k}: ${line}`);
    if (!Object.values(notes).some((l) => l.length)) console.log("    (no failed requests, console errors or failed loads recorded)");
  };
  for (const domain of ["Runtime", "Log", "Network"]) await send(domain + ".enable");

  await send("Page.navigate", { url });
  const loaded = await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
  ok(loaded, "the notebook loads");
  const controlled = await until("!!navigator.serviceWorker.controller", 30000);
  ok(controlled, "the service worker controls the page");
  // (nothing after this can pass without both: say why once, and stop, rather than failing on a missing output)
  if (!loaded || !controlled) {
    await diagnose(!loaded ? "the notebook didn't load" : "no service worker controls the page");
    throw new Error("stopped: the page isn't ready, so the deploy steps can't run (see the diagnostics above)");
  }
  let out = await runCode("print(6 * 7)");
  ok(out.includes("42") && !seen.site.some((p) => /\/lib\/(sage|mod-heapq)\./.test(p)), "Python runs, with none of Sage's chunks nor heapq's fetched: " + JSON.stringify(out));
  const before = await versions();

  // the deploy, and the new service worker taking over (it deletes the old cache)
  deployed = true;
  await ev(`navigator.serviceWorker.getRegistration().then((r) => r.update()).then(() => 1, () => 0)`);
  ok(await until(`caches.keys().then((ks) => ks.some((k) => k.startsWith("sagebrush-") && k.endsWith("next")) && !ks.includes(${JSON.stringify(before[0])}))`, 30000), `the next build's service worker is active and the old cache gone: ${JSON.stringify(before)} -> ${JSON.stringify(await versions())}`);

  // the old page, its old worker, its first imports after the deploy
  out = await runCode("import heapq\nprint(heapq.nsmallest(2, [3, 1, 2]))");
  ok(out.includes("[1, 2]") && seen.r2.some((s) => /\/lib\/mod-heapq\.src\.[0-9a-f]+\.json 200$/.test(s)), "after the deploy, the old page imports heapq: its chunk from R2's lib/: " + JSON.stringify(out));
  out = await runCode("from sage_all import factor\nprint(factor(2**64 + 1))");
  ok(out.includes("274177 * 67280421310721") && seen.r2.some((s) => /\/lib\/sage\.src\..* 200$/.test(s)), "...and Sage's library, first used now: " + JSON.stringify(out));
  out = await runCode("import _matlab_sparse");
  ok(/ImportError: could not load the Python library's matlab modules/.test(out) && !/internal error/.test(out) && seen.r2.some((s) => /\/lib\/matlab\.src\..* 404$/.test(s)), "a chunk found nowhere (not in R2 either) is an ImportError that says which part: " + JSON.stringify(out.slice(-200)));
  ws.close();
} catch (e) {
  failures++;
  console.log("FAIL " + (e?.stack ?? e));
} finally {
  await cleanup();
}
console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
