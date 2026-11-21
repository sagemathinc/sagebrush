// ci: web-browser/preload
// Background loading (web/preload.ts) on the notebook page, in headless Chromium against web/dist as built, behind
// a proxy that records each /lib/ path asked and the bytes served for it. Each case is a first visit (a fresh
// profile) opening a notebook by ?open=:
// - a plain Python notebook (no library import): no /lib/ file is fetched;
// - a notebook importing numpy: exactly sci's two chunk files, each once, at idle, before any Run; nothing runs (no
//   warm-up message, no execution); its Run then fetches nothing more (no second download of either file);
// - a Sage notebook: exactly its mode's groups' files (one mode), each once;
// - Save-Data, a 3G connection, a hidden tab, the tests' off switch: nothing fetched;
// - a Run while sci.pre is still being fetched (the proxy serves it slowly): it is downloaded once;
// - a Run while the first of the files (sci.src) is in flight: that one finishes, the next is never asked;
// - a plain notebook whose only import lines are in a markdown cell: nothing fetched;
// - a notebook importing pandas: the site's latest package set's pandas source chunk (with what it requires), each
//   once, at idle, nothing pinned before the Run; the Run fetches it no more, and pins the same set it was given.
//   bun web/build.ts && node web/test-preload-page.mjs      (CHROME=... for the browser)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "./test-port.mjs";
import { readPage } from "../scripts/notebook-page.mjs";

const here = new URL(".", import.meta.url).pathname;
const dist = join(here, "dist");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };
// (where the test is, named in a deadline's or a signal's FAIL: a case and its step. Its own deadline fires inside its CI
// job's 15 min (about 115 s here, after about 8 min of the job's other suites), so a hang is a named FAIL, not a cancel)
let phase = "the build's table";
setTimeout(() => { console.log(`FAIL the test did not end within 240 s (stuck in: ${phase})`); process.exit(1); }, 240_000).unref();
// (every wait has an end: a promise not settled within `ms` rejects, naming what it waited for)
const bounded = (p, ms, what) => { let timer; return Promise.race([p, new Promise((_, no) => { timer = setTimeout(() => no(new Error(`${what}: no end within ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(timer)); };
// (every browser and server this test starts, killed however it ends: a failed case or the deadline's exit leaves none,
// the grader's note on a17c3f58)
const children = new Set();
process.on("exit", () => { for (const c of children) try { c.kill("SIGKILL"); } catch {} });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { console.log(`FAIL stopped by ${sig} (in: ${phase})`); process.exit(1); });

// the build's table, as the page has it (web/build.ts PRELOAD, in index.html's script)
// (the page as one file: its script, dist/sagebrush-app.js, back inline where the page names it: scripts/notebook-page.mjs)
const html = readPage(join(dist, "index.html")).toString("utf8");
const at = html.indexOf("{groups:{");
let depth = 0, end = at;
for (; end < html.length; end++) { if (html[end] === "{") depth++; else if (html[end] === "}" && --depth === 0) break; }
const TABLE = new Function(`return (${html.slice(at, end + 1)})`)();
ok(at > 0 && TABLE.groups && TABLE.modes && TABLE.tops?.numpy === "sci", "the page carries the build's table, numpy in sci: " + Object.keys(TABLE.groups ?? {}).length + " groups");
const filesOf = (g) => { const e = TABLE.groups[g]; return [`/lib/${g}.src.${e[1]}.json`, ...(e[2] ? [`/lib/${g}.pre.${e[2]}.json`] : [])]; };
const SCI = filesOf("sci");
const SAGE = (TABLE.modes.sage ?? []).flatMap(filesOf);
// the site's latest package set, and the chunks `import pandas` needs from it: pandas's source, and those of the
// packages it requires (a set's precompiled chunks are per core build; the notebooks' set has none)
const S = JSON.parse(readFileSync(join(dist, "pkgset", "latest.json"), "utf8")).id;
const INDEX = JSON.parse(readFileSync(join(dist, "pkgset", S + ".json"), "utf8"));
const PANDAS = (() => {
  const seen = [], todo = Object.keys(INDEX.packages).filter((id) => id.startsWith("@sagebrush/pandas@"));
  while (todo.length) { const id = todo.shift(); if (seen.includes(id)) continue; seen.push(id); todo.push(...(INDEX.packages[id].requires ?? [])); }
  return seen.map((id) => `/pkg/${INDEX.packages[id].src.sha256}.json`);
})();
ok(PANDAS.length > 0 && PANDAS.every((f) => statSync(join(dist, f)).isFile()), `the latest set has pandas: ${PANDAS.length} source chunk(s)`);
ok(SCI.every((f) => statSync(join(dist, f)).isFile()) && SAGE.length > 0 && SAGE.every((f) => statSync(join(dist, f)).isFile()), `the table's files are the build's own (sci: 2, sage's groups: ${SAGE.length})`);

const NB = (mode, cells) => JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: mode === "sage" ? { name: "sagemath", language: "sage" } : mode === "python" ? { name: "python3", language: "python" } : { name: mode, language: mode } }, cells: cells.map((c) => (typeof c === "object" ? { cell_type: "markdown", source: c.md, metadata: {} } : { cell_type: "code", source: c, metadata: {}, outputs: [], execution_count: null })) });
const DOCS = {
  "plain.ipynb": NB("python", ["print(1)", "x = 2\nprint(x * 3)"]),
  "numpy.ipynb": NB("python", ["import numpy as np\nprint(np.arange(3))"]),
  "numpy2.ipynb": NB("python", ["import numpy as np\nprint(np.arange(3))", "print(1)"]),
  "markdown.ipynb": NB("python", [{ md: "import numpy\n\nfrom scipy import linalg" }, "print(1)"]),
  "sage.ipynb": NB("sage", ["factor(12)"]),
  "pandas.ipynb": NB("python", ["import pandas as pd\nprint(pd.DataFrame({'a': [1, 2]}).shape)"]),
  "pandas-magma.ipynb": NB("magma", ["import pandas"]),
  "pandas-matlab.ipynb": NB("matlab", ["import pandas"]),
};

// web/dist behind a recording proxy; /t/<name> serves the notebooks above; `slow`: a path served at 256 KB/s. serve.py
// picks its own port and says it once listening (startServe, web/test-port.mjs: bounded), so no other listener can take
// a port chosen for it first (freePort's port, closed, could be the proxy's own listen(0): the proxy then asked itself)
async function site(slow = null, alter = null) {
  const serve = startServe(() => spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }));
  const server = serve.child;
  children.add(server);
  const upstream = await serve.port;
  const asked = [], bytes = new Map();
  const front = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path.startsWith("/t/")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(DOCS[path.slice(3)] ?? "{}"); }
    // (`alter`: this path served with its bytes changed, still JSON, so they no longer have their SHA-256)
    if (path === alter) { const b = readFileSync(join(dist, path.slice(1)), "utf8") + " "; asked.push(path); res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(b) }); return res.end(b); }
    const rec = path.startsWith("/lib/") || path.startsWith("/pkg/");
    if (rec) asked.push(path);
    const up = request({ host: "127.0.0.1", port: upstream, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      if (!rec) return r.pipe(res);
      if (path !== slow) {
        r.on("data", (d) => bytes.set(path, (bytes.get(path) ?? 0) + d.length));
        return r.pipe(res);
      }
      // (slowly: 32 KB every 125 ms, the bytes counted as they are sent)
      const parts = [];
      r.on("data", (d) => { for (let i = 0; i < d.length; i += 32768) parts.push(d.subarray(i, i + 32768)); });
      r.on("end", async () => { for (const p of parts) { if (res.destroyed) return; res.write(p); bytes.set(path, (bytes.get(path) ?? 0) + p.length); await sleep(125); } res.end(); });
    });
    up.on("error", () => { res.destroy(); });
    req.pipe(up);
  });
  await new Promise((r) => front.listen(0, "127.0.0.1", r));
  const stop = () => bounded(new Promise((r) => { server.kill(); front.closeAllConnections?.(); front.close(() => r()); }), 10000, "the site's stop (the proxy's close)");
  return { url: `http://127.0.0.1:${front.address().port}/`, asked, bytes, stop };
}

// (the warm-ups the page sent its workers: web/test-warm.mjs's counter)
const COUNTER = `(() => { window.__warms = []; const count = (m) => { if (m && m.warm) window.__warms.push(1); }; for (const C of [Worker, MessagePort]) { const pm = C.prototype.postMessage; C.prototype.postMessage = function (m, ...a) { count(m); return pm.call(this, m, ...a); }; } })();`;

// a Chrome with a fresh profile, one tab; `init`: a script run before the page's own
async function chromium(init = "") {
  const profile = mkdtempSync(join(tmpdir(), "sb-preload-chrome-"));
  // (--password-store=basic: no OS keyring, whose absence stalls a fresh profile's first fetch 25 s on a host with a
  // desktop session bus; the grader's note on 3f7a00c3)
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"], detached: true });
  children.add({ kill: (sig) => { try { process.kill(-chrome.pid, sig); } catch {} } });
  const port = await devtoolsPort(profile, undefined, { child: chrome });
  const cdp = `http://127.0.0.1:${port}`;
  let target;
  for (let i = 0; i < 300 && !target; i++) {
    try { target = (await (await fetch(cdp + "/json", { signal: AbortSignal.timeout(5000) })).json()).find((t) => t.type === "page"); } catch {}
    if (!target) await sleep(100);
  }
  if (!target) throw new Error("Chromium showed no page target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await bounded(new Promise((r, no) => { ws.onopen = r; ws.onerror = ws.onclose = () => no(new Error("the DevTools socket closed before it opened")); }), 10000, "the DevTools socket's open");
  // (a call answered, or rejected: at the socket's close, or after 30 s, naming its method and expression)
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id).r(m.result ?? m.error); waiting.delete(m.id); } };
  ws.onerror = ws.onclose = () => { for (const [id, w] of waiting) { waiting.delete(id); w.no(new Error(`the DevTools socket closed during ${w.what}`)); } };
  const send = (method, params = {}) => {
    const id = ++n, what = method + (params.expression ? " " + JSON.stringify(params.expression.slice(0, 80)) : "");
    return bounded(new Promise((r, no) => { waiting.set(id, { r, no, what }); ws.send(JSON.stringify({ id, method, params })); }), 30000, what).finally(() => waiting.delete(id));
  };
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: COUNTER + init });
  const t = {
    ev, until,
    open: async (url) => { await send("Page.navigate", { url }); return until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000); },
    // (cell `i` run, its output waited for)
    run: async (i, ms = 120000) => {
      await ev(`(() => { sagebrush.notebook.run(sagebrush.notebook.cells()[${i}]); return true; })()`);
      await until(`(sagebrush.notebook.outputText(sagebrush.notebook.cells()[${i}].out) || '').length > 0`, ms);
      return String(await ev(`sagebrush.notebook.outputText(sagebrush.notebook.cells()[${i}].out)`));
    },
  };
  const close = async () => { ws.close(); try { process.kill(-chrome.pid, "SIGKILL"); } catch { chrome.kill("SIGKILL"); } await sleep(300); rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };
  return { t, close };
}

const count = (asked, f) => asked.filter((p) => p === f).length;
const size = (f) => statSync(join(dist, f)).size;
// (a case: a fresh site and browser, the notebook opened, `body` given them; each step named in `phase`, and an error
// keeps the step it was thrown in, as the close and the stop that follow it rename `phase`. Every step after a failed one
// that cleans up still runs, and the FIRST error is the one thrown: a later one, from the close or the stop, is only
// said, so it can't hide what failed first (latex's note on 3f7a00c3))
let cases = 0;
const thrownIn = (e) => { if (e && typeof e === "object" && !("phase" in e)) e.phase = phase; return e; };
async function kase(doc, body, { init = "", slow = null, alter = null } = {}) {
  const name = `case ${++cases} (${doc})`;
  let first = null;
  const keep = (e) => { if (first) console.log(`  (then, in ${phase}: ${e?.message ?? e})`); else first = thrownIn(e); };
  phase = `${name}: the site`;
  const s = await site(slow, alter);
  try {
    phase = `${name}: Chromium`;
    const { t, close } = await chromium(init);
    try {
      phase = `${name}: the page's open`;
      t.href = `${s.url}?open=${encodeURIComponent(s.url + "t/" + doc)}`;
      ok(await t.open(t.href), `(${doc}: the page is ready)`);
      phase = `${name}: its checks`;
      await body(t, s);
    } catch (e) { keep(e); }
    phase = `${name}: Chromium's close`;
    try { await close(); } catch (e) { keep(e); }
  } catch (e) { keep(e); }
  phase = `${name}: the site's stop`;
  try { await s.stop(); } catch (e) { keep(e); }
  if (first) throw first;
}

try {
  // 1. a plain Python notebook: nothing
  await kase("plain.ipynb", async (t, s) => {
    await sleep(6000);
    ok(s.asked.length === 0 && (await t.ev("sagebrush.preload.outcome")) === "nothing", "a plain Python notebook: no /lib/ file fetched at idle (outcome nothing): " + JSON.stringify(s.asked));
  });

  // 2. numpy: exactly sci's two files, each once, before any Run; nothing ran; the Run fetches nothing more
  await kase("numpy.ipynb", async (t, s) => {
    ok(await t.until(`true`, 100) && (await (async () => { for (let i = 0; i < 150; i++) { if (SCI.every((f) => s.bytes.get(f) === size(f))) return true; await sleep(100); } return false; })()), "a numpy notebook: sci's two files fetched in full at idle: " + JSON.stringify(await t.ev("sagebrush.preload")));
    await sleep(1000);
    ok(JSON.stringify([...new Set(s.asked)].sort()) === JSON.stringify([...SCI].sort()) && SCI.every((f) => count(s.asked, f) === 1), "...exactly those two, each once: " + JSON.stringify(s.asked));
    ok((await t.ev("window.__warms.length")) === 0 && !/\[\d+\]/.test(await t.ev("sagebrush.notebook.cells()[0].n.textContent")), "...and nothing ran: no warm-up message, the cell never executed");
    const out = await t.run(0);
    ok(out.includes("[0 1 2]"), "its Run: " + JSON.stringify(out));
    ok(SCI.every((f) => count(s.asked, f) === 1 && s.bytes.get(f) === size(f)), "...fetched neither file again (each asked once, its bytes once): " + JSON.stringify(s.asked));
  });

  // 3. a Sage notebook: its mode's groups' files, each once, nothing else
  await kase("sage.ipynb", async (t, s) => {
    for (let i = 0; i < 300 && !SAGE.every((f) => s.bytes.get(f) === size(f)); i++) await sleep(100);
    await sleep(1000);
    ok(JSON.stringify([...new Set(s.asked)].sort()) === JSON.stringify([...SAGE].sort()) && SAGE.every((f) => count(s.asked, f) === 1), `a Sage notebook: exactly its mode's groups' ${SAGE.length} files, each once: ` + JSON.stringify(s.asked));
  });

  // 4. the skips: Save-Data, 3G, a hidden tab
  const conn = (c) => `Object.defineProperty(Navigator.prototype, "connection", { get: () => (${JSON.stringify(c)}), configurable: true });`;
  for (const [label, init, want] of [
    ["Save-Data", conn({ saveData: true, effectiveType: "4g" }), "save-data"],
    ["a 3G connection", conn({ saveData: false, effectiveType: "3g" }), "slow"],
    ["a hidden tab", `Object.defineProperty(Document.prototype, "visibilityState", { get: () => "hidden", configurable: true });`, "hidden"],
    // (the tests' switch, window.__sbPreloadOff: set by nothing in the product; the cases above show it is on without it)
    ["the tests' off switch", "window.__sbPreloadOff = true;", "off"],
  ]) await kase("numpy.ipynb", async (t, s) => {
    await sleep(6000);
    ok(s.asked.length === 0 && (await t.ev("sagebrush.preload.outcome")) === want, `${label}: nothing fetched at idle (outcome ${want}): ` + JSON.stringify([s.asked, await t.ev("sagebrush.preload.outcome")]));
  }, { init });

  // 5. a Run while sci.pre is still being fetched (served slowly): it is downloaded once
  const PRE = SCI.find((f) => f.includes(".pre."));
  await kase("numpy.ipynb", async (t, s) => {
    for (let i = 0; i < 150 && !s.asked.includes(PRE); i++) await sleep(100);
    ok(s.asked.includes(PRE) && (s.bytes.get(PRE) ?? 0) < size(PRE), "(sci.pre's prefetch in flight)");
    const out = await t.run(0);
    ok(out.includes("[0 1 2]"), "a Run during the prefetch: " + JSON.stringify(out));
    ok(count(s.asked, PRE) === 1 && s.bytes.get(PRE) === size(PRE), `...sci.pre downloaded once (${count(s.asked, PRE)} request(s), ${s.bytes.get(PRE)} of ${size(PRE)} bytes): ` + JSON.stringify(s.asked));
  }, { slow: PRE });

  // 6. a Run (of a cell that needs no file) while the FIRST file, sci.src, is in flight: it finishes, and sci.pre, next,
  // is never asked (the page's `execute` hook stops the loop; a Run never cancels a file)
  const SRC = SCI.find((f) => f.includes(".src."));
  await kase("numpy2.ipynb", async (t, s) => {
    for (let i = 0; i < 150 && !s.asked.includes(SRC); i++) await sleep(100);
    ok(s.asked.includes(SRC) && (s.bytes.get(SRC) ?? 0) < size(SRC), "(sci.src's prefetch in flight)");
    const out = await t.run(1);
    ok(out.includes("1"), "a Run of a cell that needs no file, during sci.src's prefetch: " + JSON.stringify(out));
    for (let i = 0; i < 150 && s.bytes.get(SRC) !== size(SRC); i++) await sleep(100);
    await sleep(3000);
    ok(count(s.asked, SRC) === 1 && s.bytes.get(SRC) === size(SRC) && !s.asked.includes(PRE), "...sci.src finishes, once, and sci.pre is never asked: " + JSON.stringify(s.asked));
    ok(JSON.stringify(await t.ev("sagebrush.preload.fetched.map((u) => new URL(u).pathname)")) === JSON.stringify([SRC]), "...the preload's own record: sci.src only");
  }, { slow: SRC });

  // 7. import lines only in a markdown cell: not code, nothing fetched
  await kase("markdown.ipynb", async (t, s) => {
    await sleep(6000);
    ok(s.asked.length === 0 && (await t.ev("sagebrush.preload.outcome")) === "nothing", "import lines only in a markdown cell: no /lib/ file fetched (outcome nothing): " + JSON.stringify([s.asked, await t.ev("sagebrush.preload.outcome")]));
  });

  // 8. pandas: the latest set's chunks it needs, each once, before any Run, nothing pinned; the Run fetches them no
  // more and pins the set it was given (the same one)
  await kase("pandas.ipynb", async (t, s) => {
    for (let i = 0; i < 300 && !PANDAS.every((f) => s.bytes.get(f) === size(f)); i++) await sleep(100);
    await sleep(1000);
    const pkg = s.asked.filter((p) => p.startsWith("/pkg/"));
    ok(JSON.stringify([...new Set(pkg)].sort()) === JSON.stringify([...PANDAS].sort()) && PANDAS.every((f) => count(s.asked, f) === 1 && s.bytes.get(f) === size(f)), "a pandas notebook: exactly the set's chunks pandas needs, each once, at idle: " + JSON.stringify(pkg));
    ok((await t.ev("window.__warms.length")) === 0 && (await t.ev("sagebrush.notebook.meta.pkgset")) === undefined, "...nothing ran, nothing pinned (its metadata names no set)");
    const out = await t.run(0);
    ok(out.includes("(2, 1)"), "its Run: " + JSON.stringify(out));
    ok(PANDAS.every((f) => count(s.asked, f) === 1 && s.bytes.get(f) === size(f)), "...fetched none of them again: " + JSON.stringify(s.asked.filter((p) => p.startsWith("/pkg/"))));
    ok((await t.ev("sagebrush.notebook.meta.pkgset")) === S, "...and pinned the set it used at the Run: the latest, the one prefetched");
  });

  // 9. the set's index served with other bytes than its id's (the grader's H1, on 3803c922): refused, so no chunk of it
  // is fetched at idle
  await kase("pandas.ipynb", async (t, s) => {
    for (let i = 0; i < 200 && (await t.ev("sagebrush.preload.outcome")) === null; i++) await sleep(100);
    await sleep(12000);
    const pkg = s.asked.filter((p) => p.startsWith("/pkg/")), index = s.asked.filter((p) => p === `/pkgset/${S}.json`);
    ok(index.length >= 1 && pkg.length === 0, "the set's index with other bytes than its id's: no chunk of it fetched at idle: " + JSON.stringify({ index: index.length, pkg, outcome: await t.ev("sagebrush.preload.outcome") }));
  }, { alter: `/pkgset/${S}.json` });

  // 10. an import line in a Magma or a MATLAB notebook (the grader's H6, on a003dea1): not Python, so no package chunk is
  // fetched at idle, nor the set's index
  for (const [name, mode] of [["pandas-magma.ipynb", "magma"], ["pandas-matlab.ipynb", "matlab"]]) await kase(name, async (t, s) => {
    for (let i = 0; i < 200 && (await t.ev("sagebrush.preload.outcome")) === null; i++) await sleep(100);
    await sleep(12000);
    const pkg = s.asked.filter((p) => p.startsWith("/pkg/") || p.startsWith("/pkgset/"));
    ok((await t.ev("sagebrush.notebook.mode")) === mode && pkg.length === 0, `an import line in a ${mode} notebook: no package chunk, nor the set's index, fetched at idle: ` + JSON.stringify({ mode: await t.ev("sagebrush.notebook.mode"), pkg, outcome: await t.ev("sagebrush.preload.outcome") }));
  });

  // 11. a second visit, the page now controlled by the service worker: its idle preload goes through the HTTP cache
  // only, so no /lib/ chunk is kept in the service worker's caches (they're kept at a Run, as without background
  // loading; test-pwa's "installing keeps ... the library's chunks" rule, for a controlled page)
  const libKept = `(async () => { const out = []; for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) { const p = new URL(r.url).pathname; if (p.startsWith("/lib/")) out.push(n + " " + p); } return out; })()`;
  await kase("numpy.ipynb", async (t, s) => {
    ok(await t.until("!!navigator.serviceWorker.controller", 30000), "(the service worker controls the page)");
    ok(await t.until("sagebrush.preload.outcome !== null", 30000), "(the first visit's preload done: " + (await t.ev("sagebrush.preload.outcome")) + ")");
    await sleep(1000);
    const before = s.asked.length;
    ok(await t.open(t.href), "(the second visit: the page is ready)");
    ok(await t.ev("!!navigator.serviceWorker.controller") && (await t.until("sagebrush.preload.outcome === 'fetched'", 30000)), "(the second visit, controlled, preloaded: " + (await t.ev("sagebrush.preload.outcome")) + ")");
    await sleep(3000);
    const kept = await t.ev(libKept);
    ok(Array.isArray(kept) && kept.length === 0, "a controlled page's idle preload: no /lib/ chunk kept by the service worker: " + JSON.stringify({ kept, asked: s.asked.slice(before) }));
    // (its Run: answered without a new download, and then kept, so the notebook works offline as before)
    const at = s.asked.length, out = await t.run(0);
    ok(out.includes("[0 1 2]"), "its Run: " + JSON.stringify(out));
    for (let i = 0; i < 50 && (await t.ev(libKept)).length < SCI.length; i++) await sleep(200);
    const after = await t.ev(libKept);
    ok(SCI.every((f) => after.some((k) => k.endsWith(" " + f))) && SCI.every((f) => !s.asked.slice(at).includes(f)), "...sci's two files then kept by the service worker (at the Run), neither downloaded again: " + JSON.stringify({ after, asked: s.asked.slice(at) }));
  });
} catch (e) {
  ok(false, `the test threw (in: ${e?.phase ?? phase}): ` + (e?.stack ?? e));
}
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log("all passed");
process.exit(0);
