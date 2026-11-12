// ci: web-browser/latex order=61 chrome
// A talk on a shared collection's page with the REAL LaTeX view (web/latex/share.ts, /sagebrush-latex-share.js), end
// to end in headless Chromium on web/dist built with the LaTeX editor on loopback (SAGEBRUSH_LATEX_PREVIEW=test),
// served by web/serve.py; the share API's answer, the collection's files and the page at /s/<id> are given by the test
// (CDP Fetch), as in test-share-talk.mjs, whose rows hold the page to the interface with a stub view. Here, once, the
// whole path: the talk drawn, the notebook's interpreter not running; Run runs its Sage code in the runner, reading a
// file beside the talk, and the slides show the value; back to the notebook, the view is disposed and the notebook runs;
// no page exceptions.
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && node web/share/test-share-talk-real.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = spawn("python3", [join(web, "serve.py"), "0"], { stdio: ["ignore", "pipe", "ignore"] });
const port = await new Promise((r) => server.stdout.once("data", (d) => r(Number(String(d).match(/\d+/)[0]))));
const site = `http://127.0.0.1:${port}`;
const profile = mkdtempSync(join(tmpdir(), "sb-talk-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
// (requests the test intercepts (Fetch.requestPaused), each answered by `route`)
let route = null;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Fetch.requestPaused") void (route ? route(m.params) : send("Fetch.continueRequest", { requestId: m.params.requestId }));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const J = JSON.stringify;
const b64 = (s) => Buffer.from(s).toString("base64");
const nbJson = (code) => J({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } }, cells: [{ cell_type: "code", id: "c1", metadata: {}, execution_count: null, outputs: [], source: code }] });

const TEX = `\\documentclass{beamer}
\\usepackage{sagetex}
\\begin{document}
\\begin{frame}[fragile]{One}
\\begin{sagesilent}
from helper import v
\\end{sagesilent}
A: \\sage{v()}
\\end{frame}
\\begin{frame}{Two}
B: \\sage{2+3}
\\end{frame}
\\end{document}
`;
const RESULTS = J({ format: "sagebrush-latex-results", version: 1, wrapper: "WRAP", items: [] });
const FILES = { "nb.ipynb": nbJson("print('notebook ran')"), "talks/st.tex": TEX, "talks/helper.py": "def v():\n    return 41 + 1\n", "other/secret.py": "K = 1\n" };
// (the collection, as the share API gives it, its files served from the site's origin at /c/<id>/<sha256>)
const ID = "talkscollect", V = "0123456789abcdef".repeat(4);
const sha = Object.fromEntries(Object.entries(FILES).map(([p, t]) => [p, createHash("sha256").update(t).digest("hex")]));
const bySha = Object.fromEntries(Object.entries(FILES).map(([p, t]) => [sha[p], t]));
const files = Object.entries(FILES).map(([path, t]) => ({ path, sha256: sha[path], size: Buffer.byteLength(t) }));
const collection = { id: ID, version: V, latest: V, files_origin: site, manifest: { title: "Talks", license: "MIT", created: "2026-11-12T00:00:00Z", files } };
const link = `${site}/s/${ID}`;
const PAGE = readFileSync(join(web, "dist", "s", "index.html"));
const fulfill = (p, status, type, body) => send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: status, body: b64(body), responseHeaders: [
  { name: "content-type", value: type }, { name: "cache-control", value: "no-store" }, { name: "cross-origin-opener-policy", value: "same-origin" },
  { name: "cross-origin-embedder-policy", value: "require-corp" }, { name: "cross-origin-resource-policy", value: "cross-origin" }] });
const share = (p) => {
  const u = new URL(p.request.url);
  if (u.pathname === `/s/${ID}`) return fulfill(p, 200, "text/html", PAGE);
  if (u.pathname === `/api/share/c/${ID}`) return fulfill(p, 200, "application/json", J(collection));
  const m = u.pathname.match(/^\/c\/[a-z2-7]{12}\/([0-9a-f]{64})$/);
  if (m && m[1] in bySha) return fulfill(p, 200, "application/octet-stream", bySha[m[1]]);
  return null;
};
// (the default route: the stub for the chunk, the share's API, files and page; anything else from web/serve.py)
const normal = (p) => share(p) ?? send("Fetch.continueRequest", { requestId: p.requestId });
const status = () => ev("document.querySelector('#status').textContent");
const shown = (id) => ev(`!document.querySelector('#${id}').hidden`);
const click = (path) => ev(`[...document.querySelectorAll('#files button.link')].find((b) => b.textContent === ${J(path)}).click()`);
const errs = [];
try {
  await send("Page.enable"); await send("Runtime.enable");
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.method === "Runtime.exceptionThrown") errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300)); });
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Fetch.enable", { patterns: ["*/s/*", "*/api/share/*", "*/c/*"].map((urlPattern) => ({ urlPattern, requestStage: "Request" })) });
  route = normal;
  await send("Page.navigate", { url: link + "?f=talks/st.tex" });
  await until("!document.querySelector('#talkbar').hidden && document.querySelector('#talk').textContent.length > 20", 60000);
  ok(/A:/.test(await ev("document.querySelector('#talk').textContent")), "REAL view: the talk is drawn in the page: " + (await ev("document.querySelector('#talk').textContent.slice(0, 120)")));
  ok(/author's results/.test(await status()), "…the page's status: " + (await status()));
  ok(await ev("!window.shared.kernel.worker"), "…the notebook's interpreter is not running");
  // (Run before the slides are drawn says so: pressed again until it runs)
  for (let i = 0; i < 60; i++) { await ev("document.querySelector('#talkrun').click()"); await sleep(1000); if (!/still being drawn/.test(await status())) break; }
  await until("/42/.test(document.querySelector('#talk').textContent)", 180000).catch(() => {});
  ok(/42/.test(await ev("document.querySelector('#talk').textContent")), "Run: the real view runs the code, reading the helper beside the talk (A: 42): " + (await status()));
  ok((await ev("document.querySelector('#talkrun').textContent")) === "▶ Run", "…and the button is back to Run when it finishes");
  await click("nb.ipynb");
  await until("!document.querySelector('#nb').hidden && !!window.shared.kernel.worker", 30000);
  ok((await ev("document.querySelector('#talk').childElementCount")) === 0 && (await ev("window.shared.talk")) === null, "back to the notebook: the real view disposed, its box emptied");
  await ev("document.querySelector('#runall').click()");
  await until("/notebook ran/.test(document.querySelector('#nb .cell .out')?.textContent ?? '')", 120000);
  ok(true, "…and the notebook runs");
  ok(errs.length === 0, "no page exceptions: " + J(errs));
} catch (e) {
  ok(false, "the probe failed: " + (e?.stack ?? e));
} finally {
  const exited = new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once("exit", r)));
  chrome.kill(); server.kill(); await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);
