// ci: web-sync.2 order=62 chrome
// Where Sagebrush's sandbox can't run (WebKit: Safari, and iPhone and iPad browsers built on it), in headless Chromium made to
// look like Safari (its user agent, and no navigator.userAgentData, read before any of the page's own scripts), against
// the share API in Miniflare (web/share/serve-dev.mjs) and web/dist:
//   the notebook page (index.html's run bar):
//   1. a notebook whose code may not change files, Run all: one bar says why and asks, "Allow file changes and run",
//      and no cell gets a message (each left as it was, not run);
//   2. a script's click on the button grants nothing; nor does a trusted press before the bar arms;
//   3. a bar left open while another notebook is shown is closed, unanswered;
//   4. a trusted press once armed: the notebook's files permission (File > Permissions…'s), then its refused cells run;
//   5. taken back (File > Permissions…, Don't allow file changes): runs are refused again, the bar again;
//   6. a browser that can't keep the choice: it holds in this page, says so, and the cells run;
//   the share page:
//   7. Run all: nothing runs, no runner frame, and the page says once what can be done; nothing it offers grants;
//   and Chromium itself (control):
//   8. a notebook whose code may not change files runs in the sandbox; no bar;
//   9. the share page whose runner loads but never answers: within seconds the page says the sandbox didn't start,
//      the held run is answered as not run, and no cell is left running;
//   and as Safari again:
//   10. three refused cells, one deleted before the press: the other two run, in their order, and the press reads the
//      notebook's cells once (not once per refused cell);
//   11. a reactive notebook reverted to an earlier version (TimeTravel), its recompute refused: it ends, no error thrown,
//      the status not left at "computing…", and the bar asks;
//   6b. after 6's note (no button), the next notebook's bar has its button and note again;
//   12. a press that loses focus before its release grants nothing; nor does a repeating Enter; a plain Enter does.
//   bun web/build.ts && node web/share/test-run-bar.mjs
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDev } from "./serve-dev.mjs";
import { devtoolsPort } from "../test-port.mjs";

const A = "88888888-eeee-4888-8888-888888888888";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";
const dev = await startDev({ sitePort: 0, filesPort: 0, limits: { [A]: { tier: "dev", storage_bytes: 1e8, max_file_bytes: 1e7, private_links: false } } });
const profile = mkdtempSync(join(tmpdir(), "sb-runbar-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdpPort = await devtoolsPort(profile);
let version;
for (let i = 0; i < 300; i++) { try { version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); break; } catch { await sleep(100); } }
const bws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => (bws.onopen = r));
let n = 0;
const waiting = new Map();
bws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  else if (m.method === "Page.javascriptDialogOpening") raw("Page.handleJavaScriptDialog", { accept: true }, m.sessionId).catch(() => {});
};
const raw = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); bws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
async function profilePage(safari, init = "") {
  const { browserContextId } = await raw("Target.createBrowserContext");
  const { targetId } = await raw("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await raw("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params = {}) => raw(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  if (safari) {
    await send("Emulation.setUserAgentOverride", { userAgent: SAFARI });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: "delete Navigator.prototype.userAgentData;" });
  }
  if (init) await send("Page.addScriptToEvaluateOnNewDocument", { source: init });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
  const go = async (url) => { await send("Page.navigate", { url }); await sleep(300); await until("document.readyState === 'complete'"); };
  // (a person's press and release, at the element's middle: a trusted click)
  const press = async (sel) => {
    const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.hidden || !e.offsetParent) return null; e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!r) throw new Error("no " + sel + " to press");
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  };
  return { send, ev, until, go, press };
}
let failures = 0, count = 0;
const ok = (c, msg) => { count++; console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const J = JSON.stringify;
const sha = (b) => createHash("sha256").update(b).digest("hex");

const appReady = (p) => p.until("!!window.sagebrush?.notebook && document.querySelectorAll('.cell').length > 0 && !document.body.classList.contains('opening')", 90000);
// (a new notebook of two code cells: its file changes off, as every notebook starts)
// (File > New, and the new notebook opened: another notebook's id, the page done opening, its one empty cell; an edit
// made before then is lost when the opening shows the new notebook's cells)
async function newNotebook(p) {
  const was = await p.ev("window.sagebrush?.notebook?.snapshot().id ?? null");
  await p.ev("(() => { document.querySelector('#filemenu [data-f=new]').click(); return 1; })()");
  await p.until(`(window.sagebrush.notebook.snapshot().id ?? null) !== ${JSON.stringify(was)} && !document.body.classList.contains('opening') && document.querySelectorAll('.cell').length === 1 && !document.querySelector('.cell textarea').value`, 30000);
}
async function twoCells(p) {
  await newNotebook(p);
  await p.ev(`(async () => { const nb = window.sagebrush.notebook; const f = nb.cells()[0].id; await nb.applyEdits({ set: [{ id: f, code: "print(6 * 7)" }], insert: [{ code: "print('two')" }] }, { run: false }); return 1; })()`);
  await p.until("JSON.stringify(window.sagebrush.notebook.cells().map((c) => c.ta.value)) === JSON.stringify(['print(6 * 7)', \"print('two')\"])", 10000);
  await sleep(300);
  return p.ev("window.sagebrush.notebook.snapshot().id ?? localStorage.getItem('sagebrush-current')");
}
const state = (p) => p.ev("({ bar: !document.querySelector('#runbar').hidden, text: document.querySelector('#rbtext').textContent, files: window.sagebrush.permissions?.()?.files, outs: [...document.querySelectorAll('.cell')].map((c) => (c.querySelector('.out')?.textContent ?? '').trim()), ns: [...document.querySelectorAll('.cell .n')].map((x) => x.textContent), status: document.querySelector('#status')?.textContent ?? '' })");
const runAll = (p) => p.press("#runall");

try {
  // ---- the notebook page, as Safari
  const S = await profilePage(true);
  await S.go(dev.site + "/");
  await appReady(S);
  ok((await S.ev("navigator.userAgent")) === SAFARI && !(await S.ev("'userAgentData' in navigator")), "(Chromium as Safari: its user agent, and no userAgentData)");
  await twoCells(S);
  await runAll(S);
  await S.until("!document.querySelector('#runbar').hidden", 30000).catch(() => {});
  await sleep(700);
  const s1 = await state(S);
  ok(s1.bar && s1.text === "This browser can't use Sagebrush's sandbox yet. To run in this page, this notebook needs permission to change files in your browser workspace.", "1. Run all: one bar, saying why and asking: " + J(s1.text));
  ok((await S.ev("document.querySelector('#rballow').textContent")) === "Allow file changes and run" && (await S.ev("document.querySelector('#runbar .note').textContent")) === "Remembered for this notebook; change it in File > Permissions…", "...its button, \"Allow file changes and run\", and that it's remembered, and where to change it");
  ok(s1.outs.every((o) => o === "") && !s1.outs.some((o) => /can't run here/.test(o)) && s1.files === false, "...and no cell gets a message, each left as it was; nothing granted: " + J({ outs: s1.outs, files: s1.files }));
  ok((await S.ev("document.querySelectorAll('#runbar').length")) === 1 && (await S.ev("document.querySelectorAll('iframe[sandbox]').length")) === 0, "...one bar, and no runner frame tried");

  // 2. a script's click; a trusted press before the bar arms
  await S.ev("(() => { document.querySelector('#rballow').click(); return 1; })()");
  await sleep(300);
  ok((await state(S)).files === false && (await state(S)).bar, "2. a script's click on the button grants nothing; the bar stays");
  await S.ev("(() => { window.sagebrush.notebook.runAll(); return 1; })()");
  // (a fresh bar for this notebook? the open one stays, so close it the way a switch does, then press at once)
  await newNotebook(S);
  await S.until("document.querySelector('#runbar').hidden", 10000).catch(() => {});
  ok(await S.ev("document.querySelector('#runbar').hidden") && (await S.ev("window.sagebrush.permissions?.()?.files")) === false, "3. another notebook shown: the bar closes, unanswered");
  await S.ev(`(async () => { const nb = window.sagebrush.notebook; await nb.applyEdits({ set: [{ id: nb.cells()[0].id, code: "print(6 * 7)" }] }, { run: false }); return 1; })()`);
  await S.until("window.sagebrush.notebook.cells()[0].ta.value === 'print(6 * 7)'", 10000);
  await sleep(300);
  await runAll(S);
  await S.until("!document.querySelector('#runbar').hidden", 30000);
  await S.ev("(window.__rb4 = [{ at: 'bar', code: window.sagebrush.notebook.cells().map((c) => c.ta?.value), doc: window.sagebrush.notebook.snapshot().id }], 1)");
  await S.press("#rballow");
  await sleep(200);
  ok((await S.ev("window.sagebrush.permissions?.()?.files")) === false, "...and a trusted press before the bar arms grants nothing");

  // 4. a trusted press once armed: the permission, then the refused cells run
  await sleep(700);
  await S.ev("(window.__rb4.push({ at: 'press', code: window.sagebrush.notebook.cells().map((c) => c.ta?.value), doc: window.sagebrush.notebook.snapshot().id }), 1)");
  await S.press("#rballow");
  await S.until("(document.querySelector('.cell .out')?.textContent ?? '').trim() === '42'", 90000).catch(() => {});
  const s4 = await state(S);
  ok(s4.files === true && !s4.bar && s4.outs[0] === "42", "4. a trusted press once armed: the notebook may change files (File > Permissions…'s grant), the bar closes, and the refused cell runs: " + J({ files: s4.files, outs: s4.outs, ...(s4.outs[0] === "42" ? {} : await S.ev("({ status: document.querySelector('#status').textContent, n: [...document.querySelectorAll('.cell .n')].map((n) => n.textContent), worker: (window.sagebrush.kernel?.worker?.inner ?? window.sagebrush.kernel?.worker)?.constructor?.name ?? null, ready: !!window.sagebrush.kernel?.ready, reactive: !!window.sagebrush.notebook.reactiveOn, code: window.sagebrush.notebook.cells().map((c) => c.ta?.value ?? null), doc: window.sagebrush.notebook.snapshot().id ?? null, log: window.__rb4 ?? null })")) }));

  // 5. taken back: refused again, the bar again
  await S.press("#filebtn");
  await S.press("#permsmenu");
  await S.press("#filesperm");
  await S.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await S.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await S.until("window.sagebrush.permissions?.()?.files === false", 10000).catch(() => {});
  await S.ev(`(async () => { const nb = window.sagebrush.notebook; await nb.applyEdits({ set: [{ id: nb.cells()[0].id, code: "print('again')" }] }, { run: false }); return 1; })()`);
  await sleep(300);
  await runAll(S);
  await S.until("!document.querySelector('#runbar').hidden", 30000).catch(() => {});
  await sleep(500);
  const s5 = await state(S);
  ok(s5.files === false && s5.bar && s5.outs[0] !== "again", "5. taken back in File > Permissions…: runs are refused again, with the bar: " + J({ files: s5.files, bar: s5.bar, outs: s5.outs }));

  // ---- 6. a browser that can't keep the choice (its record refused): it holds in this page, says so, and runs
  const F = await profilePage(true, "(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'sagebrush-grants') throw new DOMException('full', 'QuotaExceededError'); return set.call(this, k, v); }; })();");
  await F.go(dev.site + "/");
  await appReady(F);
  await twoCells(F);
  await runAll(F);
  await F.until("!document.querySelector('#runbar').hidden", 30000);
  await sleep(700);
  await F.press("#rballow");
  await F.until("[...document.querySelectorAll('.cell .out')].map((o) => o.textContent.trim()).join('|') === '42|two'", 90000).catch(() => {});
  const s6 = await state(F);
  ok(s6.files === true && J(s6.outs) === J(["42", "two"]) && s6.bar && /couldn't keep the choice, so a reload forgets it/.test(s6.text) && (await F.ev("document.querySelector('#rballow').hidden")), "6. the choice can't be kept: it holds in this page, the bar says so (no button), and both refused cells run: " + J({ files: s6.files, outs: s6.outs, text: s6.text }));

  // ---- 6b. after the note with no button, another notebook's bar: its button and note shown again
  await twoCells(F);
  await runAll(F);
  await F.until("!document.querySelector('#runbar').hidden && /To run in this page/.test(document.querySelector('#rbtext').textContent)", 30000).catch(() => {});
  ok(await F.ev("!document.querySelector('#runbar').hidden && !document.querySelector('#rballow').hidden && !document.querySelector('#runbar .note').hidden"), "6b. after a note with no button, the next notebook's bar has its button and note again");

  // ---- 12. the press: one that loses focus before its release grants nothing; a repeating Enter grants nothing; Enter does
  const K = await profilePage(true);
  await K.go(dev.site + "/");
  await appReady(K);
  await twoCells(K);
  await runAll(K);
  await K.until("!document.querySelector('#runbar').hidden", 30000);
  await sleep(700);
  const at = await K.ev("(() => { const b = document.querySelector('#rballow').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()");
  await K.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await K.ev("(document.querySelector('.cell textarea').focus(), 1)");
  await K.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await sleep(300);
  ok((await K.ev("window.sagebrush.permissions?.()?.files")) === false && (await K.ev("!document.querySelector('#runbar').hidden")), "12. a press that lost focus before its release: nothing allowed, the bar stays");
  await K.ev("(document.querySelector('#rballow').focus(), 1)");
  const key = (type, autoRepeat) => K.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, autoRepeat, ...(type === "keyDown" ? { text: "\r" } : {}) });
  for (let i = 0; i < 3; i++) await key("keyDown", true);
  await key("keyUp", false);
  await sleep(300);
  ok((await K.ev("window.sagebrush.permissions?.()?.files")) === false && (await K.ev("!document.querySelector('#runbar').hidden")), "...a repeating Enter: nothing allowed, the bar stays");
  await key("keyDown", false);
  await key("keyUp", false);
  await K.until("window.sagebrush.permissions?.()?.files === true", 5000).catch(() => {});
  ok((await K.ev("window.sagebrush.permissions?.()?.files")) === true, "...and a plain Enter on the armed button allows it (the keyboard's way works)");

  // ---- 10. three refused cells, the middle one deleted before the press: the press reads the cells once, and runs the
  // two still there, in their order
  const T = await profilePage(true);
  await T.go(dev.site + "/");
  await appReady(T);
  await twoCells(T);
  await T.ev(`(async () => { const nb = window.sagebrush.notebook; await nb.applyEdits({ insert: [{ code: "print('three')" }] }, { run: false }); return 1; })()`);
  await sleep(300);
  await runAll(T);
  await T.until("!document.querySelector('#runbar').hidden", 30000);
  const ids10 = await T.ev("window.sagebrush.notebook.cells().map((c) => c.id)");
  await T.ev(`(async () => { await window.sagebrush.notebook.applyEdits({ remove: [${J(ids10[1])}] }, { run: false }); return 1; })()`);
  await T.ev("(() => { const nb = window.sagebrush.notebook, cells = nb.cells, runCells = nb.runCells; window.__cells = 0; window.__ran = null; nb.cells = (...a) => (window.__cells++, cells(...a)); nb.runCells = (ids, ...a) => (window.__ran ??= { ids: [...ids], calls: window.__cells }, runCells(ids, ...a)); return 1; })()");
  await sleep(700);
  await T.ev("window.__cells = 0");
  await T.press("#rballow");
  await T.until("!!window.__ran", 10000).catch(() => {});
  const s10 = await T.ev("window.__ran");
  ok(!!s10 && J(s10.ids) === J([ids10[0], ids10[2]]) && s10.calls === 1, "10. three refused cells, the middle one deleted: the two still there run, in their order, and the press read the cells once: " + J({ ran: s10, ids: ids10 }));

  // ---- 11. TimeTravel's revert in a reactive notebook, its recompute refused: no error, the bar
  const V = await profilePage(true);
  await V.go(dev.site + "/");
  await appReady(V);
  await twoCells(V);
  await V.ev("window.sagebrush.notebook.flush(); 1");
  await sleep(1200);
  await V.ev(`(async () => { const nb = window.sagebrush.notebook; await nb.applyEdits({ set: [{ id: nb.cells()[0].id, code: "print(7)" }] }, { run: false }); nb.flush(); return 1; })()`);
  await sleep(1200);
  await V.ev("(() => { window.__rejected = []; addEventListener('unhandledrejection', (e) => window.__rejected.push(String(e.reason))); addEventListener('error', (e) => window.__rejected.push(String(e.message))); return 1; })()");
  await V.ev("document.querySelector('#ttbtn').click(); 1");
  await V.until("!document.querySelector('#timetravel').hidden && window.sagebrush.history?.versions().length > 1", 10000);
  await V.ev("(() => { const s = document.querySelector('#ttslider'); s.value = 0; s.dispatchEvent(new Event('input')); return 1; })()");
  await V.ev("document.querySelector('#ttrevert').click(); 1");
  await V.until("!document.querySelector('#runbar').hidden", 15000).catch(() => {});
  await sleep(1500);
  const s11 = await V.ev("({ reactive: !!window.sagebrush.notebook.reactiveOn, rejected: window.__rejected, status: document.querySelector('#status').textContent, bar: !document.querySelector('#runbar').hidden })");
  ok(s11.reactive && s11.rejected.length === 0 && !/^computing/.test(s11.status) && s11.bar, "11. a reactive notebook reverted in TimeTravel, its recompute refused: no error, the status not stuck at computing, the bar asks: " + J(s11));

  // ---- 7. the share page, as Safari
  const signed = await fetch(dev.site + "/auth/dev", { method: "POST", headers: { origin: dev.site, "content-type": "application/json" }, body: J({ token: "dev-token", account_id: A }) });
  const cookie = signed.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const api = (p, m, b, t = "application/json") => fetch(dev.site + p, { method: m, headers: { origin: dev.site, cookie, "content-type": t }, body: b });
  const nb = Buffer.from(J({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } }, cells: [{ cell_type: "code", id: "c1", metadata: {}, execution_count: 1, outputs: [{ output_type: "stream", name: "stdout", text: "as shared\n" }], source: "print(6 * 7)" }] }));
  await api("/api/share/check", "POST", J({ blobs: [{ sha256: sha(nb), size: nb.length }] }));
  await api(`/api/share/blob/${sha(nb)}`, "PUT", nb, "application/octet-stream");
  const id = (await (await api("/api/share/first-upload", "POST", J({ title: "Run bar", license: "MIT", files: [{ path: "n.ipynb", sha256: sha(nb), size: nb.length }], attempt: randomBytes(16).toString("hex") }))).json()).collection;
  const W = await profilePage(true);
  await W.go(`${dev.site}/s/${id}`);
  await W.until("!!window.shared && !!document.querySelector('#nb .cell')", 60000);
  await W.press("#runall");
  await sleep(1500);
  const s7 = await W.ev("({ status: document.querySelector('#status').textContent, out: (document.querySelector('#nb .cell .out')?.textContent ?? '').trim(), frames: document.querySelectorAll('iframe[sandbox]').length, bar: !!document.querySelector('#runbar') })");
  ok(/can't run in this browser yet/.test(s7.status) && /Chrome, Edge or Firefox/.test(s7.status) && /Copy to my workspace/.test(s7.status), "7. the share page as Safari, Run all: it says once what can be done: " + J(s7.status));
  ok(s7.out === "as shared" && s7.frames === 0 && !s7.bar, "...nothing ran (the output as shared), no runner frame, and no grant offered here: " + J(s7));

  // ---- 8. Chromium itself (control): the sandbox runs it; no bar
  const C = await profilePage(false);
  await C.go(dev.site + "/");
  await appReady(C);
  await twoCells(C);
  await runAll(C);
  // (both cells' outputs: the second may still be running when the first has printed)
  await C.until("JSON.stringify([...document.querySelectorAll('.cell')].map((c) => (c.querySelector('.out')?.textContent ?? '').trim())) === JSON.stringify(['42', 'two'])", 90000).catch(() => {});
  const s8 = await state(C);
  ok(s8.outs[0] === "42" && s8.outs[1] === "two" && !s8.bar && s8.files === false && (await C.ev("document.querySelectorAll('iframe[sandbox]').length")) >= 1, "8. Chromium: the notebook runs in the sandbox, its file changes still off; no bar: " + J({ outs: s8.outs, bar: s8.bar }));

  // ---- 9. Chromium, the share page, its runner a page that never answers: said, never a run left spinning
  const R = await profilePage(false);
  await R.send("Fetch.enable", { patterns: [{ urlPattern: "*/runner/*" }] });
  bws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Fetch.requestPaused") raw("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/html" }], body: Buffer.from("<!doctype html><p>silent").toString("base64") }, m.sessionId).catch(() => {});
  });
  await R.go(`${dev.site}/s/${id}`);
  await R.until("!!window.shared && !!document.querySelector('#nb .cell')", 60000);
  const t9 = Date.now();
  await R.press("#runall");
  await R.until("/didn't start/.test(document.querySelector('#status').textContent)", 20000).catch(() => {});
  await sleep(500);
  const s9 = await R.ev("({ status: document.querySelector('#status').textContent, out: (document.querySelector('#nb .cell .out')?.textContent ?? '').trim(), running: document.querySelectorAll('#nb .cell.running, #nb .cell.queued').length })");
  ok(/sandbox didn't start in this browser/.test(s9.status) && /Reload the page/.test(s9.status) && Date.now() - t9 < 20000, `9. the share page, its runner silent: the page says the sandbox didn't start (${Date.now() - t9} ms): ` + J(s9.status));
  ok(s9.running === 0 && /didn't start/.test(s9.out) && /Reload the page/.test(s9.out), "...the held run is answered as not run, with the share page's words, and no cell is left running: " + J(s9));
  // (a Run after the give-up: said again, by the stand-in itself)
  await R.ev("(document.querySelector('#status').textContent = '', 1)");
  await R.press("#runall");
  await R.until("/sandbox didn't start in this browser/.test(document.querySelector('#status').textContent) && document.querySelectorAll('#nb .cell.running, #nb .cell.queued').length === 0", 3000).catch(() => {});
  ok(/sandbox didn't start in this browser/.test(await R.ev("document.querySelector('#status').textContent")) && (await R.ev("document.querySelectorAll('#nb .cell.running, #nb .cell.queued').length")) === 0, "...and a Run after it is said again at once, nothing left running: " + J(await R.ev("({ status: document.querySelector('#status').textContent, running: document.querySelectorAll('#nb .cell.running, #nb .cell.queued').length, out: (document.querySelector('#nb .cell .out')?.textContent ?? '').trim().slice(0, 120), inner: window.shared?.kernel?.worker?.inner?.constructor?.name ?? null })")));
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  chrome.kill();
  await dev.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `${failures} of ${count} failed` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
