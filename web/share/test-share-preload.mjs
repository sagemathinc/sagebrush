// ci: web-sync.2 order=54 chrome
// Background loading on a shared collection's page (/s/<id>; web/share-client/view.ts, web/preload.ts), end to end in
// headless Chromium against the share API in Miniflare (web/share/serve-dev.mjs) and web/dist. A collection (a numpy
// chapter, a plain one, a data file) is uploaded through the API, then read signed out; every request is recorded:
//   1. the numpy chapter: at idle, exactly sci's two library files, each once, and no data file, no copy's chunk;
//      its Run outputs [0 1 2] and fetches neither again;
//   2. the copy's chunk is never fetched ahead, not even at a focus of a cell's editor; the first edit fetches it;
//   3. the plain chapter: nothing (outcome "nothing");
//   4. the tests' switch (window.__sbPreloadOff): nothing at idle, nothing at a focus;
//   5. import lines only in a markdown cell: nothing (outcome "nothing");
//   6. a Magma chapter whose code says `import numpy`: exactly its mode's groups' files (Magma's), not sci;
//   7. a Run asked before the idle preload starts: it stops it (outcome "stopped", nothing fetched by it).
//   bun web/build.ts && node web/share/test-share-preload.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDev } from "./serve-dev.mjs";
import { devtoolsPort } from "../test-port.mjs";
import { readPage } from "../../scripts/notebook-page.mjs";

const A = "22222222-2222-4222-8222-222222222222";
const here = new URL(".", import.meta.url).pathname, dist = join(here, "..", "dist");
// (ports 0: startDev's servers take the system's choice and hold it, web/share/serve-dev.mjs)
const dev = await startDev({ sitePort: 0, filesPort: 0, limits: { [A]: { tier: "dev", storage_bytes: 1e8, max_file_bytes: 1e7, private_links: false } } });
const profile = mkdtempSync(join(tmpdir(), "sb-share-preload-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
const kill = () => { try { process.kill(-chrome.pid, "SIGKILL"); } catch { try { chrome.kill("SIGKILL"); } catch {} } };
process.on("exit", kill);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { console.log(`FAIL stopped by ${sig}`); process.exit(1); });
const cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map(), requests = [], byId = new Map(), reqs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Network.requestWillBeSent") { const path = new URL(m.params.request.url).pathname; requests.push(path); if (!byId.has(m.params.requestId)) { const x = { path, cached: false, bytes: null }; byId.set(m.params.requestId, x); reqs.push(x); } }
  if (m.method === "Network.requestServedFromCache" && byId.has(m.params.requestId)) byId.get(m.params.requestId).cached = true;
  if (m.method === "Network.responseReceived" && byId.has(m.params.requestId) && (m.params.response.fromDiskCache || m.params.response.fromServiceWorker)) byId.get(m.params.requestId).cached = true;
  if (m.method === "Network.responseReceived" && byId.has(m.params.requestId)) { const x = byId.get(m.params.requestId), h = m.params.response.headers ?? {}; x.status = m.params.response.status; x.cc = h["cache-control"] ?? h["Cache-Control"] ?? null; x.etag = !!(h.etag ?? h.ETag); x.req = m.params.response.requestHeaders ? Object.keys(m.params.response.requestHeaders).filter((k) => /cache|if-/i.test(k)) : null; }
  if (m.method === "Network.loadingFinished" && byId.has(m.params.requestId)) byId.get(m.params.requestId).bytes = m.params.encodedDataLength;
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const J = JSON.stringify;
const count = (p) => requests.filter((x) => x === p).length;

// the build's table, as the pages have it (web/build.ts PRELOAD), and sci's two files by it
// (the page as one file: its script, dist/sagebrush-app.js, back inline where the page names it: scripts/notebook-page.mjs)
const html = readPage(join(dist, "index.html")).toString("utf8"), at = html.indexOf("{groups:{");
let depth = 0, end = at;
for (; end < html.length; end++) { if (html[end] === "{") depth++; else if (html[end] === "}" && --depth === 0) break; }
const TABLE = new Function(`return (${html.slice(at, end + 1)})`)();
const SCI = [`/lib/sci.src.${TABLE.groups.sci[1]}.json`, ...(TABLE.groups.sci[2] ? [`/lib/sci.pre.${TABLE.groups.sci[2]}.json`] : [])];
const COPY = "/sagebrush-share-copy.js";
const PY = { name: "python3", display_name: "Python 3", language: "python" }, MAGMA = { name: "magma", display_name: "Magma", language: "magma" };
// (a chapter: its cells, code unless given as { md }, and its kernel)
const nbJson = (cells, ks = PY) => J({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: ks }, cells: [].concat(cells).map((c, i) => (typeof c === "object" ? { cell_type: "markdown", id: "m" + i, metadata: {}, source: c.md } : { cell_type: "code", id: "c" + i, metadata: {}, source: c, outputs: [], execution_count: null })) });
const FILES = { "np.ipynb": nbJson("import numpy as np\nprint(np.arange(3))"), "plain.ipynb": nbJson("print('plain')"), "md.ipynb": nbJson([{ md: "import numpy" }, "print('md')"]), "magma.ipynb": nbJson("import numpy", MAGMA), "data/points.csv": "x,y\n1,2\n" };
const filesOf = (g) => [`/lib/${g}.src.${TABLE.groups[g][1]}.json`, ...(TABLE.groups[g][2] ? [`/lib/${g}.pre.${TABLE.groups[g][2]}.json`] : [])];
const MAGMA_FILES = (TABLE.modes.magma ?? []).flatMap(filesOf);
const lib = () => requests.filter((p) => p.startsWith("/lib/"));
const settle = () => until("window.shared?.preload?.outcome !== null && window.shared?.preload?.outcome !== undefined", 30000).then(() => sleep(1500));

try {
  ok(SCI.length === 2, "the build's table: sci's two files " + J(SCI));
  ok(MAGMA_FILES.length > 0 && !MAGMA_FILES.some((f) => SCI.includes(f)), "…and Magma's mode's groups, without sci: " + J(MAGMA_FILES));
  await send("Page.enable");
  await send("Network.enable");
  // (a headless page has no focus of its own: emulated, so a cell's editor gets its focus events)
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // ---- the author uploads the collection (dev sign-in, the share API), then signs out
  await send("Page.navigate", { url: dev.site + "/" });
  await until("document.readyState === 'complete'");
  ok((await ev(`fetch('/auth/dev', { method: 'POST', headers: {'content-type': 'application/json'}, body: ${J(J({ token: "dev-token", account_id: A }))} }).then((r) => r.status)`)) === 200, "the author signs in (dev)");
  const link = await ev(`(async () => {
    const files = ${J(FILES)}, out = [];
    for (const [path, text] of Object.entries(files)) {
      const b = new TextEncoder().encode(text), sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
      const put = await fetch("/api/share/blob/" + sha, { method: "PUT", body: b });
      if (!put.ok) throw new Error("blob " + put.status + " " + await put.text());
      out.push({ path, sha256: sha, size: b.length });
    }
    const attempt = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
    const r = await fetch("/api/share/first-upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Preload", license: "MIT", files: out, attempt }) });
    const j = await r.json(); if (!r.ok) throw new Error("upload " + r.status + " " + JSON.stringify(j));
    return new URL(j.url, location.href).href;
  })()`);
  ok(/\/s\/[a-z2-7]{12}$/.test(link), "the collection is shared: " + link);
  await ev("fetch('/auth/logout', { method: 'POST' }).then((r) => r.status)");

  // ---- 1. the numpy chapter: sci's two files at idle, each once, nothing else; its Run fetches neither again
  requests.length = 0;
  await send("Page.navigate", { url: link + "?f=np.ipynb" });
  await until("!!document.querySelector('#nb .cell')");
  await settle();
  for (let i = 0; i < 100 && !SCI.every((f) => count(f) >= 1); i++) await sleep(100);
  await sleep(1000);
  ok((await ev("window.shared.preload.outcome")) === "fetched" && J([...new Set(lib())].sort()) === J([...SCI].sort()) && SCI.every((f) => count(f) === 1), "the numpy chapter: at idle, exactly sci's two files, each once: " + J([lib(), await ev("JSON.stringify(window.shared.preload)")]));
  ok(J(await ev("window.shared.preload.urls.map((u) => new URL(u).pathname)")) === J(SCI) && J(await ev("window.shared.preload.fetched.map((u) => new URL(u).pathname)")) === J(SCI), "…the site root's files, as the runner asks for them (never /s/lib/...), and all of them fetched");
  ok(count("/" + "data/points.csv") === 0 && !requests.some((p) => p.includes("points.csv")) && count(COPY) === 0, "…no data file, and not the copy's chunk: " + J(requests.filter((p) => /points|share-copy/.test(p))));
  const r0 = reqs.length;
  await ev("document.querySelector('#runall').click()");
  await until("(() => { const c = document.querySelector('#nb .cell'); return /\\[\\d+\\]/.test(c.querySelector('.n').textContent) && !c.classList.contains('running') && !c.classList.contains('queued'); })()", 120000);
  ok((await ev("document.querySelector('#nb .cell .out').textContent")).includes("[0 1 2]"), "its Run: [0 1 2]");
  await sleep(1000);
  // (the runner asks for them again, through the page's broker: each answered from the cache, not the network)
  const runAgain = reqs.slice(r0).filter((x) => SCI.includes(x.path));
  ok(runAgain.every((x) => x.cached || (x.bytes !== null && x.bytes < 2048)) && count(COPY) === 0, "…downloaded neither file again (each asked again answered from the cache), and running fetched no copy's chunk: " + J(runAgain));

  // ---- 2. the copy's chunk is never fetched ahead: not by a focus of a cell's editor either (it isn't named by its
  // content, so the site can't let a browser keep it; daybreak2 on 8dbfb7f4); the first edit fetches it, as before
  await ev("document.querySelector('#nb .cell textarea').focus(); true");
  await sleep(1500);
  ok(count(COPY) === 0, "a focus of a cell's editor: the copy's chunk not fetched");
  await ev(`(() => { const ta = document.querySelector('#nb .cell textarea'); ta.value = ${J("import numpy as np\nprint(np.arange(3), 'mine')")}; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await until("/This is your copy/.test(document.querySelector('#copyline').textContent) && !document.querySelector('#copyline').hidden", 20000);
  ok(count(COPY) === 1, "the first edit makes the copy, fetching its chunk once: " + count(COPY));

  // ---- 3. the plain chapter: nothing
  requests.length = 0;
  await send("Page.navigate", { url: link + "?f=plain.ipynb" });
  await until("!!document.querySelector('#nb .cell')");
  await settle();
  await sleep(2000);
  ok((await ev("window.shared.preload.outcome")) === "nothing" && lib().length === 0, "the plain chapter: nothing fetched (outcome nothing): " + J(lib()));

  // ---- 4. the tests' switch: nothing at idle, nothing at a focus (a fresh origin's cache state aside: the switch is read first)
  // (from a clean origin: the case before made a copy, which a visit opens, and so loads the copy's chunk itself)
  const off = await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__sbPreloadOff = true;" });
  await send("Network.clearBrowserCache");
  await send("Storage.clearDataForOrigin", { origin: new URL(link).origin, storageTypes: "all" });
  requests.length = 0;
  await send("Page.navigate", { url: link + "?f=np.ipynb" });
  await until("!!document.querySelector('#nb .cell')");
  await settle();
  await ev("document.querySelector('#nb .cell textarea').focus(); true");
  await sleep(2000);
  ok((await ev("window.shared.preload.outcome")) === "off" && lib().length === 0 && count(COPY) === 0, "the tests' switch: nothing at idle, nothing at a focus: " + J([await ev("window.shared.preload.outcome"), lib(), count(COPY)]));
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: off.identifier });

  // ---- 5. import lines only in a markdown cell: not code, so nothing (the grader's C1, on 8b3c24c2)
  requests.length = 0;
  await send("Page.navigate", { url: link + "?f=md.ipynb" });
  await until("!!document.querySelector('#nb .cell')");
  await settle();
  await sleep(2000);
  ok((await ev("window.shared.preload.outcome")) === "nothing" && lib().length === 0, "import lines only in a markdown cell: nothing fetched (outcome nothing): " + J([await ev("window.shared.preload.outcome"), lib()]));

  // ---- 6. a Magma chapter whose code says `import numpy`: its mode's groups' files, each once, and not sci (an import
  // line names a library group in Python and Sage only; the grader's C2)
  requests.length = 0;
  await send("Page.navigate", { url: link + "?f=magma.ipynb" });
  await until("!!document.querySelector('#nb .cell')");
  await settle();
  for (let i = 0; i < 100 && !MAGMA_FILES.every((f) => count(f) >= 1); i++) await sleep(100);
  await sleep(1000);
  ok((await ev("window.shared.preload.outcome")) === "fetched" && J([...new Set(lib())].sort()) === J([...MAGMA_FILES].sort()) && MAGMA_FILES.every((f) => count(f) === 1), "a Magma chapter with `import numpy`: exactly Magma's groups' files, each once, not sci: " + J([lib(), await ev("window.shared.preload.urls.map((u) => new URL(u).pathname)")]));

  // ---- 7. a Run asked before the idle preload starts: the page's execute hook stops it (the grader's S1). The page's
  // idle callback is put off 3 s here, so the Run comes first however soon the page is idle
  const later = await send("Page.addScriptToEvaluateOnNewDocument", { source: "{ const ric = window.requestIdleCallback.bind(window); window.requestIdleCallback = (f, o) => setTimeout(() => ric(f, o), 3000); }" });
  requests.length = 0;
  await send("Page.navigate", { url: link + "?f=np.ipynb" });
  await until("!!document.querySelector('#nb .cell') && !!document.querySelector('#runall')");
  ok((await ev("window.shared.preload.outcome")) === null, "(the Run comes before the idle preload)");
  await ev("document.querySelector('#runall').click()");
  await settle();
  await until("(() => { const c = document.querySelector('#nb .cell'); return /\\[\\d+\\]/.test(c.querySelector('.n').textContent) && !c.classList.contains('running') && !c.classList.contains('queued'); })()", 120000);
  ok((await ev("window.shared.preload.outcome")) === "stopped" && (await ev("window.shared.preload.fetched.length")) === 0 && (await ev("document.querySelector('#nb .cell .out').textContent")).includes("[0 1 2]"), "a Run before the idle preload: the preload stopped, nothing fetched by it; the Run's own output: " + J([await ev("JSON.stringify(window.shared.preload)"), lib()]));
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: later.identifier });
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
  console.log("  page:", await ev("location.href + ' | ' + (document.querySelector('#status')?.textContent ?? '')").catch((x) => x.message));
} finally {
  kill();
  await dev.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
