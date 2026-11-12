// ci: web-browser/latex order=60 chrome
// ci: web-sync.2 order=56 chrome env=TALKS_OFF=1
// A talk on a shared collection's page (S2), the page's side, end to end in headless Chromium, on web/dist built with
// the LaTeX editor on loopback (SAGEBRUSH_LATEX_PREVIEW=test) and served by web/serve.py. The share API's answer, the
// collection's files and the page at /s/<id> are given by the test (CDP Fetch), so no share server is needed: the
// page is dist/s/index.html, as the site serves it there. The LaTeX view's chunk (/sagebrush-latex-share.js) is a
// STUB the test serves, recording each openShared call and what is called on its result, so these rows hold the page
// to the agreed interface whatever the real view does; they run unchanged against the real chunk once it lands. The
// "Talks" collection: a notebook, a talk with its author's results and a data file in its folder, a talk without
// results, a file in another folder.
//   1. a talk asked for by ?f= whose chunk arrives after the reader opened the notebook: never opened;
//   2. opening a talk: the notebook's interpreter is stopped first; openShared gets the talk's path and text, its
//      results (parsed), the runner's classes and /runner/, and every file of the collection as mounted for notebooks;
//      the talk's bar replaces the notebook's;
//   3. Run/Stop follow the view's onRunning; Present calls present();
//   4. back to the notebook: the talk is disposed, and the notebook runs (its interpreter starts again);
//   5. a talk whose openShared finishes after the reader went elsewhere is disposed at once and never shown;
//   6. a talk or results file that doesn't match its SHA-256 is refused: openShared isn't called; a chunk that
//      doesn't load says so; a talk without a results file gets results null;
//   7. "Copy to my workspace": the talk, its results and its folder's files (no others) in the reader's files, opened
//      in the LaTeX editor (/?tex=<id>); the next visit's button reads "Open my copy" and opens that same copy.
// With TALKS_OFF=1, on the site's build (no LaTeX on loopback): a talk is a file like any other, listed with its download
// link and no button; ?f= of it opens the first notebook, saying so; the LaTeX view's chunk is never fetched.
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && node web/share/test-share-talk.mjs
//   bun web/build.ts && TALKS_OFF=1 node web/share/test-share-talk.mjs
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
// (the top frame's navigations, as Chrome reports them)
const navs = [];
// (requests the test intercepts (Fetch.requestPaused): each answered by `route`, or held until released)
let route = null;
const held = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Fetch.requestPaused" && /sagebrush-latex-share\.js/.test(m.params.request.url)) chunkAsked++;
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Fetch.requestPaused") void (route ? route(m.params) : send("Fetch.continueRequest", { requestId: m.params.requestId }));
  if (m.method === "Page.frameNavigated" && !m.params.frame.parentId) navs.push(m.params.frame.url);
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const J = JSON.stringify;
const OFF = process.env.TALKS_OFF === "1";
// (every request for the LaTeX view's chunk, whatever answered it)
let chunkAsked = 0;
const b64 = (s) => Buffer.from(s).toString("base64");
const nbJson = (code) => J({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } }, cells: [{ cell_type: "code", id: "c1", metadata: {}, execution_count: null, outputs: [], source: code }] });
const TEX = "\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}\\sage{1+1}\\end{frame}\n\\end{document}\n";
const RESULTS = J({ v: 1, items: { a: "2" } });
const FILES = { "nb.ipynb": nbJson("print('notebook ran')"), "talks/st.tex": TEX, "talks/st.tex.results.json": RESULTS, "talks/data.csv": "x\n1\n", "solo.tex": "\\documentclass{article}\\begin{document}solo\\end{document}\n", "other/x.txt": "not the talk's\n" };
// (the stub view: every openShared call, what it was given, and what was called on its result, in window.__talks;
// window.__talkHold makes the next call wait for window.__talkRelease(); window.__alive counts the views not yet disposed)
const STUB = `
export async function openShared(root, o) {
  const rec = { path: o.path, text: o.text, results: o.results, mount: o.mount, runnerUrl: o.sandbox && o.sandbox.runnerUrl,
    classes: !!o.sandbox && typeof o.sandbox.WorkerKernel === "function" && typeof o.sandbox.RunnerWorker === "function",
    workerAtCall: !!(window.shared && window.shared.kernel.worker), aliveAtCall: window.__alive ?? 0, calls: [] };
  (window.__talks ??= []).push(rec);
  window.__alive = (window.__alive ?? 0) + 1;
  root.textContent = "STUB VIEW " + o.path;
  if (window.__talkHold) { window.__talkHold = false; await new Promise((r) => (window.__talkRelease = r)); }
  return {
    run() { rec.calls.push("run"); o.onRunning(true); },
    stop() { rec.calls.push("stop"); o.onRunning(false); },
    present() { rec.calls.push("present"); },
    dispose() { rec.calls.push("dispose"); rec.workerAtDispose = !!(window.shared && window.shared.kernel.worker); window.__alive--; },
  };
}`;
const stubChunk = async (p) => send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/javascript" }], body: b64(STUB) });
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
const normal = (p) => (/sagebrush-latex-share\.js/.test(p.request.url) ? stubChunk(p) : share(p) ?? send("Fetch.continueRequest", { requestId: p.requestId }));
const talks = () => ev("window.__talks ?? []");
const status = () => ev("document.querySelector('#status').textContent");
const shown = (id) => ev(`!document.querySelector('#${id}').hidden`);
const click = (path) => ev(`[...document.querySelectorAll('#files button.link')].find((b) => b.textContent === ${J(path)}).click()`);
const settled = () => ev("new Promise((r) => setTimeout(() => r(true), 300))");

try {
  await send("Page.enable");
  // (no cache: a cached file would never reach the tamper rows)
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Fetch.enable", { patterns: ["*/s/*", "*/api/share/*", "*/c/*", "*sagebrush-latex-share.js*"].map((urlPattern) => ({ urlPattern, requestStage: "Request" })) });
  route = normal;

  if (OFF) {
    // ---- talks off (the site's build, on loopback): files like any other
    await send("Page.navigate", { url: link + "?f=talks/st.tex" });
    await until("!!document.querySelector('#nb .cell')");
    ok((await ev("document.querySelector('#nbname').textContent")) === "nb.ipynb" && /no notebook "talks\/st\.tex".*opened nb\.ipynb instead/.test(await status()), "?f= of a talk where talks are off: said, and the notebook opened");
    ok(J(await ev("[...document.querySelectorAll('#files button.link')].map((b) => b.textContent)")) === J(["nb.ipynb"]), "…the talks are listed without a button");
    ok((await ev("[...document.querySelectorAll('#files a.dl')].filter((a) => /\\.tex$/.test(a.getAttribute('download'))).length")) === 2, "…each with its download link");
    await settled();
    ok(chunkAsked === 0 && !(await shown("talkbar")), "…and the LaTeX view's chunk was never fetched, nor its bar shown");
  } else {
    // ---- 1. the chunk of a talk asked for by ?f= arrives after the reader opened the notebook: nothing is opened
    route = (p) => (/sagebrush-latex-share\.js/.test(p.request.url) ? held.push(p) : normal(p));
    await send("Page.navigate", { url: link + "?f=talks/st.tex" });
    await until("document.querySelector('#title').textContent === 'Talks'");
    await until("document.querySelectorAll('#files button.link').length > 0");
    for (let i = 0; i < 300 && !held.length; i++) await sleep(100);
    ok(held.length === 1, "?f=talks/st.tex fetches the LaTeX view's chunk (held)");
    ok(!(await shown("nbbar")) && !(await shown("talkbar")), "…while it loads, neither bar is shown");
    await click("nb.ipynb");
    await until("!!document.querySelector('#nb .cell')");
    route = normal;
    for (const p of held.splice(0)) await stubChunk(p);
    await settled();
    ok((await talks()).length === 0, "the reader opened the notebook first: the late chunk opens no talk");
    ok((await shown("nbbar")) && (await shown("nb")) && !(await shown("talkbar")) && !(await shown("talk")), "…and the notebook stays shown, its bar only");
    ok(await ev("!!window.shared.kernel.worker"), "…with its interpreter started");

    // ---- 2. opening a talk
    await click("talks/st.tex");
    await until("(window.__talks ?? []).length === 1 && !document.querySelector('#talkbar').hidden");
    let t = (await talks())[0];
    ok(t.path === "talks/st.tex" && t.text === TEX, "openShared gets the talk's path and its text");
    ok(J(t.results) === RESULTS, "…its author's results, parsed (talks/st.tex.results.json)");
    ok(t.classes && t.runnerUrl === "/runner/", "…the runner's kernel classes, and /runner/");
    const expectMount = files.map((f) => [f.path, { url: `${site}/c/${ID}/${f.sha256}`, sha256: f.sha256, size: f.size }]);
    ok(J(t.mount) === J(expectMount), "…every file of the collection, as the notebook mounts them (the view keeps to the talk's folder)");
    ok(t.workerAtCall === false, "the notebook's interpreter was stopped before the talk's view was opened (one interpreter in the page)");
    ok(!(await shown("nbbar")) && !(await shown("nb")) && (await shown("talkbar")) && (await shown("talk")), "the talk's bar and view replace the notebook's");
    ok((await ev("document.querySelector('#talkname').textContent")) === "talks/st.tex" && /STUB VIEW talks\/st\.tex/.test(await ev("document.querySelector('#talk').textContent")), "…named, the view drawn in the page");
    ok((await status()) === "These are the author's results. Press Run to run this talk's code in your browser.", "…and nothing has run: the status says so");
    ok((await ev("document.querySelector('#talkmine').textContent")) === "Copy to my workspace", "…the copy button offers \"Copy to my workspace\"");

    // ---- 3. Run / Stop / Present
    ok((await ev("document.querySelector('#talkrun').textContent")) === "▶ Run", "Run reads \"▶ Run\"");
    await ev("document.querySelector('#talkrun').click()");
    ok((await ev("document.querySelector('#talkrun').textContent")) === "■ Stop", "pressed: the view's run() is called and, running, the button reads \"■ Stop\"");
    await ev("document.querySelector('#talkrun').click()");
    ok((await ev("document.querySelector('#talkrun').textContent")) === "▶ Run", "pressed again: stop(), and \"▶ Run\" again");
    ok((await ev("document.querySelector('#talkpresent').title")) === "Present the slides full screen (arrow keys move; Shift+Enter runs the code and S stops it; Escape leaves)", "Present's tooltip names the presenter's keys, as the editor's does");
  await ev("document.querySelector('#talkpresent').click()");
    t = (await talks())[0];
    ok(J(t.calls) === J(["run", "stop", "present"]), "the view was called run, stop, present, in that order: " + J(t.calls));

    // ---- 4. back to the notebook
    await click("nb.ipynb");
    await until("!!document.querySelector('#nb .cell') && !document.querySelector('#nb').hidden");
    t = (await talks())[0];
    ok(J(t.calls.slice(-1)) === J(["dispose"]), "leaving the talk disposes its view");
    ok(!(await shown("talkbar")) && !(await shown("talk")) && (await ev("document.querySelector('#talk').childElementCount")) === 0, "…its bar and view are gone");
    ok((await shown("nbbar")) && (await ev("!!window.shared.kernel.worker")), "the notebook is back, its interpreter started again");
    await ev("document.querySelector('#runall').click()");
    await until("/notebook ran/.test(document.querySelector('#nb .cell .out')?.textContent ?? '')", 90000);
    ok(true, "…and it runs");

    // ---- 5. a start still under way is never overlapped by the next view's (astra S2-HOST-OPEN-2, S2-HOST-ATTACH-1)
    // (a talk's openShared pending, then the notebook: its interpreter starts only once that view is disposed)
    await ev("window.__talkHold = true");
    await click("talks/st.tex");
    await until("(window.__talks ?? []).length === 2 && !!window.__talkRelease");
    await click("nb.ipynb");
    await sleep(800);
    ok((await ev("!window.shared.kernel.worker")) && !(await shown("nb")), "a talk's view still opening, then the notebook: the notebook's interpreter waits, not started beside it");
    await ev("window.__talkRelease()");
    await until("!!document.querySelector('#nb .cell') && !document.querySelector('#nb').hidden");
    t = (await talks())[1];
    ok(J(t.calls) === J(["dispose"]) && t.workerAtDispose === false, "…the view, opened late, is disposed at once, never run, before the notebook's interpreter starts");
    ok((await ev("window.shared.talk")) === null && !(await shown("talkbar")) && (await ev("document.querySelector('#talk').childElementCount")) === 0, "…and nothing of it is shown");
    ok((await shown("nb")) && (await shown("nbbar")) && (await ev("!!window.shared.kernel.worker")), "…then the notebook, its interpreter started");
    // (a talk's openShared pending, then another talk: the second view is opened only once the first is disposed)
    await ev("window.__talkHold = true");
    await click("talks/st.tex");
    await until("(window.__talks ?? []).length === 3 && !!window.__talkRelease");
    await click("solo.tex");
    await sleep(800);
    ok((await talks()).length === 3, "a talk's view still opening, then another talk: the second isn't opened beside it");
    await ev("window.__talkRelease()");
    await until("(window.__talks ?? []).length === 4 && !document.querySelector('#talkbar').hidden");
    t = await talks();
    ok(J(t[2].calls) === J(["dispose"]) && t[3].path === "solo.tex" && t[3].aliveAtCall === 0, "…the first is disposed, never run, and then the second opened, the only view alive");
    ok((await ev("document.querySelector('#talkname').textContent")) === "solo.tex", "…and shown");
    // (the notebook's attach under way, then a talk: the talk's view waits for it, and the stale notebook is let go)
    await click("nb.ipynb");
    await until("!document.querySelector('#nb').hidden && !!window.shared.kernel.worker");
    await ev("(() => { const nb = window.shared.nb, a = nb.attach.bind(nb); nb.attach = (st) => new Promise((r) => (window.__attachRelease = () => r(a(st)))); window.__unpatch = () => { nb.attach = a; }; return true; })()");
    const n0 = (await talks()).length;
    await click("nb.ipynb");
    await until("!!window.__attachRelease");
    await click("talks/st.tex");
    await sleep(800);
    ok((await talks()).length === n0, "the notebook's attach under way, then a talk: the talk's view isn't opened beside it");
    await ev("window.__attachRelease(); window.__unpatch()");
    await until(`(window.__talks ?? []).length === ${n0 + 1} && !document.querySelector('#talkbar').hidden`);
    await settled();
    t = (await talks()).at(-1);
    ok(t.workerAtCall === false, "…then the talk's view, the notebook's interpreter stopped first");
    ok(!(await shown("nb")) && !(await shown("nbbar")) && /author's results/.test(await status()), "…and the stale notebook isn't shown again: its bar stays hidden, the status is the talk's");
    await click("nb.ipynb");
    await until("!!document.querySelector('#nb .cell') && !document.querySelector('#nb').hidden");

    // ---- 6. refusals, and a talk without results
    const tamper = (path) => async (p) => {
      // (valid JSON, so only the SHA-256 check can refuse it)
      if (p.request.url.endsWith("/" + sha[path])) return fulfill(p, 200, "application/octet-stream", J({ v: 666 }));
      return normal(p);
    };
    for (const path of ["talks/st.tex.results.json", "talks/st.tex"]) {
      route = tamper(path);
      const before = (await talks()).length;
      await click("talks/st.tex");
      await until("/couldn't be opened/.test(document.querySelector('#status').textContent)");
      await settled();
      ok((await talks()).length === before, `${path} not matching its SHA-256: the talk is refused, openShared never called`);
      ok(/could not be loaded/.test(await status()) && !(await shown("talkbar")), "…said, and no talk shown: " + (await status()));
      route = normal;
      await click("nb.ipynb");
      await until("!document.querySelector('#nb').hidden");
    }
    const n1 = (await talks()).length;
    await click("solo.tex");
    await until(`(window.__talks ?? []).length === ${n1 + 1}`);
    t = (await talks()).at(-1);
    ok(t.path === "solo.tex" && t.results === null, "a talk without a results file: openShared gets results null");
    // (a chunk that doesn't load: a fresh page, the chunk answered 404)
    route = async (p) => (/sagebrush-latex-share\.js/.test(p.request.url) ? fulfill(p, 404, "text/plain", "no") : normal(p));
    await send("Page.navigate", { url: link + "?f=talks/st.tex" });
    await until("/couldn't be opened/.test(document.querySelector('#status').textContent)");
    ok(/the talk viewer didn't load/.test(await status()) && (await ev("(window.__talks ?? []).length")) === 0, "the view's chunk not loading: said, nothing opened");
    ok((await ev("document.querySelectorAll('#files button.link').length")) === 3, "…and the file list stays usable (the notebook's and the two talks' buttons)");
    route = normal;

    // ---- 7. Copy to my workspace
    await send("Page.navigate", { url: link + "?f=talks/st.tex" });
    await until("(window.__talks ?? []).length === 1 && !document.querySelector('#talkbar').hidden");
    navs.length = 0;
    await ev("document.querySelector('#talkmine').click()");
    let to = null;
    for (let i = 0; i < 300 && !to; i++) { to = navs.find((x) => /\/\?tex=/.test(x)) ?? null; if (!to) await sleep(100); }
    ok(!!to, "\"Copy to my workspace\" opens the copy in the LaTeX editor: " + to);
    const fid = to && new URL(to).searchParams.get("tex");
    await until("document.readyState === 'complete'");
    const mine = await ev(`import(new URL("/sagebrush-share-copy.js", location.href).href).then((m) => m.openWorkspace()).then(async (w) => {
      const out = {};
      for (const p of ["/Talks/talks/st.tex", "/Talks/talks/st.tex.results.json", "/Talks/talks/data.csv", "/Talks/other/x.txt", "/Talks/nb.ipynb", "/Talks/solo.tex"]) {
        const s = await w.stat(p); out[p] = s ? { fid: s.fid ?? null } : null;
      }
      const r = await w.read("/Talks/talks/st.tex"); out.text = typeof r.content === "string" ? r.content : new TextDecoder().decode(r.content);
      return out;
    })`);
    ok(mine["/Talks/talks/st.tex"] && mine.text === TEX, "the copy holds the talk, as published");
    ok(!!mine["/Talks/talks/st.tex.results.json"] && !!mine["/Talks/talks/data.csv"], "…its author's results and its folder's data file beside it");
    ok(!mine["/Talks/other/x.txt"] && !mine["/Talks/nb.ipynb"] && !mine["/Talks/solo.tex"], "…and nothing from outside its folder");
    ok(fid && mine["/Talks/talks/st.tex"]?.fid === fid, "…the editor was opened on that copy (its id)");
    await send("Page.navigate", { url: link + "?f=talks/st.tex" });
    await until("(window.__talks ?? []).length === 1 && !document.querySelector('#talkbar').hidden");
    ok((await ev("document.querySelector('#talkmine').textContent")) === "Open my copy", "the next visit: the button reads \"Open my copy\"");
    navs.length = 0;
    await ev("document.querySelector('#talkmine').click()");
    to = null;
    for (let i = 0; i < 300 && !to; i++) { to = navs.find((x) => /\/\?tex=/.test(x)) ?? null; if (!to) await sleep(100); }
    ok(to && new URL(to).searchParams.get("tex") === fid, "…and opens that same copy");
    await until("document.readyState === 'complete'");
    ok((await ev(`import(new URL("/sagebrush-share-copy.js", location.href).href).then((m) => m.openWorkspace()).then((w) => w.stat("/Talks/talks/st (2).tex"))`)) == null, "…never a second one");
  }
} catch (e) {
  ok(false, "the test failed: " + (e?.stack ?? e));
} finally {
  const exited = new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once("exit", r)));
  chrome.kill();
  server.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);
