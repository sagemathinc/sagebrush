// ci: web-browser/notebook order=245
// Background loading (web/preload.ts) on the notebook page, in headless Chromium against web/dist as built, behind
// a proxy that records each /lib/ path asked and the bytes served for it. Each case is a first visit (a fresh
// profile) opening a notebook by ?open=:
// - a plain Python notebook (no library import): no /lib/ file is fetched;
// - a notebook importing numpy: exactly sci's two chunk files, each once, at idle, before any Run; nothing runs (no
//   warm-up message, no execution); its Run then fetches nothing more (no second download of either file);
// - a Sage notebook: exactly its mode's groups' files (one mode), each once;
// - Save-Data, a 3G connection, a hidden tab, the tests' off switch: nothing fetched;
// - a Run while sci.pre is still being fetched (the proxy serves it slowly): it is downloaded once.
//   bun web/build.ts && node web/test-preload-page.mjs      (CHROME=... for the browser)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "./test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const dist = join(here, "dist");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };
setTimeout(() => { console.log("FAIL the test did not end within 600 s"); process.exit(1); }, 600_000).unref();

// the build's table, as the page has it (web/build.ts PRELOAD, in index.html's script)
const html = readFileSync(join(dist, "index.html"), "utf8");
const at = html.indexOf("{groups:{");
let depth = 0, end = at;
for (; end < html.length; end++) { if (html[end] === "{") depth++; else if (html[end] === "}" && --depth === 0) break; }
const TABLE = new Function(`return (${html.slice(at, end + 1)})`)();
ok(at > 0 && TABLE.groups && TABLE.modes && TABLE.tops?.numpy === "sci", "the page carries the build's table, numpy in sci: " + Object.keys(TABLE.groups ?? {}).length + " groups");
const filesOf = (g) => { const e = TABLE.groups[g]; return [`/lib/${g}.src.${e[1]}.json`, ...(e[2] ? [`/lib/${g}.pre.${e[2]}.json`] : [])]; };
const SCI = filesOf("sci");
const SAGE = (TABLE.modes.sage ?? []).flatMap(filesOf);
ok(SCI.every((f) => statSync(join(dist, f)).isFile()) && SAGE.length > 0 && SAGE.every((f) => statSync(join(dist, f)).isFile()), `the table's files are the build's own (sci: 2, sage's groups: ${SAGE.length})`);

const NB = (mode, cells) => JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: mode === "sage" ? { name: "sagemath", language: "sage" } : { name: "python3", language: "python" } }, cells: cells.map((c) => ({ cell_type: "code", source: c, metadata: {}, outputs: [], execution_count: null })) });
const DOCS = {
  "plain.ipynb": NB("python", ["print(1)", "x = 2\nprint(x * 3)"]),
  "numpy.ipynb": NB("python", ["import numpy as np\nprint(np.arange(3))"]),
  "sage.ipynb": NB("sage", ["factor(12)"]),
};

// web/dist behind a recording proxy; /t/<name> serves the notebooks above; `slow`: a path served at 256 KB/s
async function site(slow = null) {
  const upstream = await freePort();
  const server = spawn("python3", [join(here, "serve.py"), String(upstream)], { stdio: "ignore" });
  const asked = [], bytes = new Map();
  const front = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path.startsWith("/t/")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(DOCS[path.slice(3)] ?? "{}"); }
    if (path.startsWith("/lib/")) asked.push(path);
    const up = request({ host: "127.0.0.1", port: upstream, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      if (!path.startsWith("/lib/")) return r.pipe(res);
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
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${upstream}/`); break; } catch { await sleep(100); } }
  const stop = () => new Promise((r) => { server.kill(); front.closeAllConnections?.(); front.close(() => r()); });
  return { url: `http://127.0.0.1:${front.address().port}/`, asked, bytes, stop };
}

// (the warm-ups the page sent its workers: web/test-warm.mjs's counter)
const COUNTER = `(() => { window.__warms = []; const count = (m) => { if (m && m.warm) window.__warms.push(1); }; for (const C of [Worker, MessagePort]) { const pm = C.prototype.postMessage; C.prototype.postMessage = function (m, ...a) { count(m); return pm.call(this, m, ...a); }; } })();`;

// a Chrome with a fresh profile, one tab; `init`: a script run before the page's own
async function chromium(init = "") {
  const profile = mkdtempSync(join(tmpdir(), "sb-preload-chrome-"));
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const port = await devtoolsPort(profile, undefined, { child: chrome });
  const cdp = `http://127.0.0.1:${port}`;
  let target;
  for (let i = 0; i < 300 && !target; i++) { try { target = (await (await fetch(cdp + "/json")).json()).find((t) => t.type === "page"); } catch { await sleep(100); } }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
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
  const close = async () => { ws.close(); chrome.kill("SIGKILL"); await sleep(300); rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };
  return { t, close };
}

const count = (asked, f) => asked.filter((p) => p === f).length;
const size = (f) => statSync(join(dist, f)).size;
// (a case: a fresh site and browser, the notebook opened, `body` given them)
async function kase(doc, body, { init = "", slow = null } = {}) {
  const s = await site(slow), { t, close } = await chromium(init);
  try {
    ok(await t.open(`${s.url}?open=${encodeURIComponent(s.url + "t/" + doc)}`), `(${doc}: the page is ready)`);
    await body(t, s);
  } finally { await close(); await s.stop(); }
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
} catch (e) {
  ok(false, "the test threw: " + (e?.stack ?? e));
}
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log("all passed");
process.exit(0);
