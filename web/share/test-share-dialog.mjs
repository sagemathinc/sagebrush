// The Share dialog in headless Chromium (share-ux-plan r2 §1, §3-§5,
// web/share-client/dialog.ts), against the share API in Miniflare
// (web/share/serve-dev.mjs) and web/dist:
//   - what is pre-checked, and why (from the code, without running it);
//   - rows never move as checks apply, and the result line says what happened;
//   - the unchecked-files test: the manifest and a fresh browser's view of the
//     shared notebook agree with the checks, with two negative controls;
//   - the user's checks win: Select none, a shift range and an old dialog's
//     results, while the analysis is held; Upload before it finishes;
//   - Space and Shift+Space ranges from the keyboard;
//   - closing is refused while uploading, and everything is restored after;
//   - opening and selecting read no file's bytes; upload reads exactly the
//     checked files, once each;
//   - a bound disables Upload, with the reason;
//   - a pathological source keeps the dialog responsive, and the fail-safe
//     stops the analysis;
//   - a 100,000-entry workspace opens without reading any file.
//   bun web/build.ts && node web/share/test-share-dialog.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDev } from "./serve-dev.mjs";
import { devtoolsPort } from "../test-port.mjs";

// (where crashAndReopen's renderer-attribution trace is taken, SHARE_TRACE_SCOPE: "page" (the default), the page's
// own flattened session, whose trace is the one used; or "browser", the browser target, REPORT-ONLY: its trace is
// described and never used, so its crash cases fail before any crash. #243's tracing r5: on the browser target,
// TracingStartedInBrowser has no frames (tracing_handler.cc fills them only for a host with WebContents). Anything
// else stops the run here, before the dev server and Chrome are started)
const traceScope = process.env.SHARE_TRACE_SCOPE ?? "page";
if (traceScope !== "page" && traceScope !== "browser") { console.log(`FAIL SHARE_TRACE_SCOPE is ${JSON.stringify(traceScope)}, not "page" or "browser"`); process.exit(2); }
console.log(`trace scope: ${traceScope === "page" ? "page session (attributing)" : "browser target (report-only)"}`);
// (a negative control, SHARE_TRACE_CONTROL=late-complete: an unasked-for tracingComplete after the last case, through
// the page connection's own handler, so the run must fail by its trace-state check below; anything else stops here)
const traceControl = process.env.SHARE_TRACE_CONTROL ?? "";
if (traceControl !== "" && traceControl !== "late-complete") { console.log(`FAIL SHARE_TRACE_CONTROL is ${JSON.stringify(traceControl)}, not "late-complete" or unset`); process.exit(2); }
if (traceControl) console.log(`trace control: ${traceControl} (this run must fail its trace-state check)`);
const A = "11111111-1111-4111-8111-111111111111";
const dev = await startDev({ sitePort: 18792, filesPort: 18793, limits: { [A]: { tier: "dev", storage_bytes: 1e9, max_file_bytes: 2e6, private_links: false } } });
const profile = mkdtempSync(join(tmpdir(), "sb-share-dlg-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!cdpPort) cdpPort = await devtoolsPort(profile);
let version;
for (let i = 0; i < 300; i++) { try { version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); break; } catch { await sleep(100); } }
// one browser connection; pages attached by session
const bws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => (bws.onopen = r));
let n = 0;
const waiting = new Map();
const swVersions = new Map();
// (the one trace being collected, if any, and the session it must come from: crashAndReopen's renderer attribution)
let onTracingComplete = null;
// (set when a trace's stop or its stream's close isn't confirmed: then no later case crashes a page)
let tracingUncertain = null;
// (a JavaScript dialog a page opens (alert, confirm, beforeunload) would hold every later call to that page: said,
// and dismissed, so the case fails or goes on instead of the run hanging; #243's CI)
bws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  else if (m.method === "Page.javascriptDialogOpening") {
    console.log(`  (a page opened a JS ${m.params?.type} dialog: ${JSON.stringify(String(m.params?.message ?? "").slice(0, 200))}; dismissed)`);
    raw("Page.handleJavaScriptDialog", { accept: true }, m.sessionId).catch(() => {});
  }
  // (service worker versions, by id, each at its latest state: the ServiceWorker domain is enabled only once a reopened
  // page has failed, since DevTools' attention could start or keep a worker alive and so hide the stall)
  else if (m.method === "Tracing.tracingComplete") {
    // (with no trace being collected, an unasked-for trace exists: no later case crashes a page)
    if (onTracingComplete) onTracingComplete(m.params ?? {}, m.sessionId ?? null);
    else tracingUncertain ??= `a tracingComplete came with no trace being collected (${m.sessionId ? "a page session" : "the browser target"})`;
  }
  else if (m.method === "ServiceWorker.workerVersionUpdated") {
    for (const v of m.params?.versions ?? []) swVersions.set(v.versionId, { registrationId: v.registrationId, script: String(v.scriptURL).replace(/^https?:\/\/[^/]+/, "").split(/[?#]/)[0], runningStatus: v.runningStatus, status: v.status, controlled: (v.controlledClients ?? []).length });
  }
};
// (every call has a deadline, 60 s unless given: a call the browser never answers (a wedged page, a browser gone)
// fails its case, naming the method, instead of hanging the run until its CI job is cancelled; #243's CI)
const raw = (method, params = {}, sessionId, ms = 60_000) => new Promise((r, no) => {
  const id = ++n;
  const t = setTimeout(() => { if (waiting.delete(id)) no(new Error(`CDP ${method} didn't answer within ${ms / 1000} s`)); }, ms);
  waiting.set(id, (v) => { clearTimeout(t); r(v); });
  bws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
async function newPage(contextId, timing = {}) {
  // (each step's time, kept in the caller's object as it happens, so a reopen that is slow or stalls, even inside
  // this function, says which step: #243's CI)
  const t0 = Date.now();
  const { targetId } = await raw("Target.createTarget", { url: "about:blank", ...(contextId ? { browserContextId: contextId } : {}) });
  timing.createTarget = Date.now() - t0;
  const { sessionId } = await raw("Target.attachToTarget", { targetId, flatten: true });
  timing.attach = Date.now() - t0;
  const send = (method, params = {}, ms) => raw(method, params, sessionId, ms);
  // (dialogs reported for this page: see bws.onmessage)
  await send("Page.enable");
  timing.pageEnable = Date.now() - t0;
  const ev = async (expression, ms) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
  const key = async (k, modifiers = 0) => {
    const code = k === " " ? "Space" : k;
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, modifiers, windowsVirtualKeyCode: k === " " ? 32 : k === "Escape" ? 27 : 0 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, modifiers, windowsVirtualKeyCode: k === " " ? 32 : k === "Escape" ? 27 : 0 });
  };
  return { send, ev, until, key, targetId, sessionId, timing };
}
let failures = 0, count = 0;
const ok = (c, msg) => { count++; console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
// (a process list from SystemInfo.getProcessInfo, used only when it is whole: nonempty, every entry an object with a
// nonempty string type and a positive integer id, ids unique; anything else is unknown (null), so it can never show a
// pid absent. Checked here on its own inputs, before any browser work: #243's tracing-attribution review)
const validProcs = (x) => {
  const a = x?.processInfo;
  if (!Array.isArray(a) || a.length === 0) return null;
  const ids = new Set();
  for (const p of a) {
    if (!p || typeof p !== "object" || typeof p.type !== "string" || !p.type || !Number.isInteger(p.id) || p.id <= 0 || ids.has(p.id)) return null;
    ids.add(p.id);
  }
  return a.map((p) => [p.type, p.id, typeof p.cpuTime === "number" ? p.cpuTime : null]);
};
{
  const cases = [["no answer", undefined], ["an error object", { code: -32000, message: "x" }], ["an empty list", { processInfo: [] }], ["an entry without an id", { processInfo: [{ type: "renderer" }] }], ["a zero id", { processInfo: [{ type: "renderer", id: 0 }] }], ["a string id", { processInfo: [{ type: "renderer", id: "7" }] }], ["no type", { processInfo: [{ id: 7 }] }], ["a duplicate id", { processInfo: [{ type: "browser", id: 7 }, { type: "renderer", id: 7 }] }], ["a null entry", { processInfo: [null] }]];
  for (const [what, x] of cases) ok(validProcs(x) === null, `(self-check) a process list with ${what} is unknown, so it can't show a pid absent`);
  const good = validProcs({ processInfo: [{ type: "browser", id: 5, cpuTime: 1.5 }, { type: "renderer", id: 9 }] });
  ok(JSON.stringify(good) === JSON.stringify([["browser", 5, 1.5], ["renderer", 9, null]]) && !good.some((x) => x[1] === 7), "(self-check) a whole process list is read, and a pid missing from it is absent");
}

const p = await newPage();
const { ev, until } = p;
// (the first cell's code, run, and its output; or only set, not run)
const setFirst = (code) => ev(`(() => { const c = document.querySelector('.cell'); const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); })()`);
async function runFirst(code) {
  await setFirst(code);
  await ev(`document.querySelector('.cell textarea').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true}))`);
  await sleep(200);
  await until("(() => { const c = document.querySelector('.cell'); return !c.classList.contains('running') && !c.classList.contains('queued') && /\\[\\d+\\]/.test(c.querySelector('.n').textContent); })()", 120000);
  return ev("document.querySelector('.cell .out').textContent");
}
const rows = () => ev("[...document.querySelectorAll('#sharelist .sharerow')].sort((a, b) => a.dataset.i - b.dataset.i).map((r) => ({ i: +r.dataset.i, name: r.querySelector('.name').title, checked: r.querySelector('input').checked, why: r.querySelector('.why').textContent, top: r.style.top }))");
// (a row by name, wherever it is: the list draws only the rows in view, about 20 at a time)
async function findRow(name) {
  const h = await ev("document.querySelector('#sharelist').scrollHeight");
  for (let top = 0; top <= h; top += 40 * 10) {
    await ev(`document.querySelector('#sharelist').scrollTop = ${top}`);
    await sleep(60);
    const r = (await rows()).find((x) => x.name === name);
    if (r) return r;
  }
  return undefined;
}
const checkedNames = async () => (await rows()).filter((r) => r.checked).map((r) => r.name);
const status = () => ev("document.querySelector('#sharestatus').textContent");
async function openDialog({ wait = true } = {}) {
  await ev("document.querySelector('#sharedlg').open && document.querySelector('#sharedlg').close()");
  const g = await ev("window.sagebrush.share.generation");
  await ev("document.querySelector('#sharemenu').click()");
  // (this open's own list: a new generation, its rows drawn; on a timeout, which part of it didn't happen)
  // (on a timeout, the dialog's state: which part of the open didn't happen)
  const why = (e) => ev(`JSON.stringify({ g: ${g}, generation: window.sagebrush.share.generation, selection: !!window.sagebrush.share.selection, analyzing: window.sagebrush.share.analyzing, rows: document.querySelectorAll('#sharelist .sharerow').length, busy: window.sagebrush.share.busy, open: document.querySelector('#sharedlg').open, signin: !document.querySelector('#sharesignin').hidden, form: !document.querySelector('#shareform').hidden, status: document.querySelector('#sharestatus').textContent, progress: document.querySelector('#shareprogress')?.textContent, result: document.querySelector('#shareresult').textContent })`).catch((x) => String(x)).then((state) => { throw new Error(`${e.message} ${state}`); });
  await until(`window.sagebrush.share.generation > ${g} && !!window.sagebrush.share.selection && document.querySelectorAll('#sharelist .sharerow').length > 0`).catch(why);
  // (this open's own result: no analysis running, so an earlier open's "Checked…" isn't taken for it)
  // (an interpreter that didn't answer in time is an end too: the dialog says so and analyzes no code)
  if (wait) await until("!window.sagebrush.share.analyzing && /^(Checked|Found no|Stopped|The notebook's interpreter didn't answer)/.test(document.querySelector('#sharestatus').textContent)", 60000).catch(why);
}
const closeDialog = () => ev("document.querySelector('#sharedlg').close()");
// (the "checking" live region's every change, with whether the dialog was open then: what a screen reader would hear)
// (recorded as each text is set, synchronously: a MutationObserver would see the dialog as it is a task later)
// (and how many frames the dialog had rendered since showModal: a frame counter started by showModal itself, its
// first callback running before the first frame's drawing, so `rendered` is the callbacks seen minus one)
const RECORD_LIVE = "(() => { const el = document.querySelector('#sharechecking'), d = document.querySelector('#sharedlg'); const desc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent'); window.__live = []; let frames = 0, gen = 0; const sm = HTMLDialogElement.prototype.showModal; HTMLDialogElement.prototype.showModal = function () { const r = sm.call(this); if (this === d) { frames = 0; const g = ++gen; const tick = () => { if (g !== gen) return; frames++; if (d.open) requestAnimationFrame(tick); }; requestAnimationFrame(tick); } return r; }; Object.defineProperty(el, 'textContent', { configurable: true, get() { return desc.get.call(this); }, set(v) { window.__live.push({ text: String(v), open: d.open, rendered: Math.max(0, frames - 1) }); desc.set.call(this, v); } }); })()";
// (said in order: "Checking…" only once the dialog is shown, then the outcome, which is never removed; a check
// that answers before the next frame may go straight to the outcome, so "Checking…" is required only for slow ones)
const liveOrder = (seq, outcome, slow = true) => {
  const said = seq.filter((x) => x.text).map((x) => x.text);
  const order = slow ? said.length === 2 && said[0] === "Checking your sign-in…" : said.length === 1 || (said.length === 2 && said[0] === "Checking your sign-in…");
  // (and nothing said before the dialog has been drawn at least once: board's r4b HOLD 1)
  return seq.every((x) => !/Checking/.test(x.text) || x.open) && seq.every((x) => !x.text || x.rendered >= 1) && order && said.at(-1) === outcome && seq.at(-1)?.text === outcome;
};
// A held stand-in for the analysis worker: messages to the page wait until released.
const HOLD = `(() => {
  const t = window.sagebrush.shareTest;
  t.held = [];
  t.terminated = 0;
  t.createWorker = () => {
    const real = new Worker("/sagebrush-share-deps.js");
    const w = { onmessage: null, postMessage: (m) => real.postMessage(m), terminate: () => { t.terminated++; real.terminate(); } };
    const q = [];
    let open = false;
    real.onmessage = (e) => (open ? w.onmessage?.(e) : q.push(e));
    t.held.push(() => { open = true; for (const e of q.splice(0)) w.onmessage?.(e); });
    return w;
  };
})()`;
const release = (i = -1) => ev(`(() => { const h = window.sagebrush.shareTest.held; (i => i < 0 ? h.at(-1) : h[i])(${i})?.(); })()`);
const unhold = () => ev("(() => { const t = window.sagebrush.shareTest; delete t.createWorker; })()");
const lastManifest = async () => {
  const mine = await ev("(async () => (await fetch('/api/share/mine')).json())()");
  const c = mine.collections[0];
  const v = await ev(`(async () => (await fetch('/api/share/c/${c.id}')).json())()`);
  // (a collection with no version, as an older page's create-first left: no files, so the case fails, the run goes on)
  return { id: c.id, files: (v.manifest?.files ?? []).map((f) => f.path).sort() };
};

try {
  await p.send("Page.navigate", { url: dev.site + "/" });
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
  await ev("document.querySelector('#filemenu [data-f=new]').click()");
  await until("document.querySelectorAll('.cell').length === 1 && !document.querySelector('.cell textarea').value");
  // (#172 r2's review, PY-172-1: every module a fresh session already has in sys.modules is one the dialog
  // treats as resolved without sys.path: builtinModules holds them all)
  {
    // (only sys imported, so the list is the session's own; printed as Python's repr of a list of str)
    const fresh = JSON.parse((await runFirst("import sys\nprint(sorted(sys.modules))")).trim().split("\n").pop().replace(/'/g, '"'));
    const info = await ev("window.sagebrush.kernel.ask({ importInfo: true }, 'python', null)");
    const b = new Set(info.builtins);
    ok(fresh.length > 0 && fresh.every((n) => b.has(n)) && b.has("builtins") && b.has("__main__"), `a fresh session's sys.modules (${fresh.join(", ")}) all in builtinModules, builtins and __main__ included`);
  }
  // the workspace: a helper module that opens a data file, files the code opens, and unrelated ones
  await runFirst([
    "import os",
    "open('helper.py', 'w').write('import json\\nT = open(\"table.csv\").read()\\n')",
    "open('table.csv', 'w').write('k,v\\n1,2\\n')",
    "open('a.csv', 'w').write('x\\n1\\n')",
    "open('b.npy', 'w').write('unrelated')",
    "open('c.html', 'w').write('<p>unrelated</p>')",
    "open('big.bin', 'w').write('z' * 3000000)",
    "print('made')",
  ].join("\n"));
  const signed = await ev(`fetch('/auth/dev', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ token: 'dev-token', account_id: '${A}' }) }).then((r) => r.status)`);
  ok(signed === 200, "dev sign-in");
  // The notebook's code, set but never run (so nothing below is a runtime observation of it).
  const CODE = "import os\nprint(sorted(os.listdir('.')))\nimport helper\nx = open('a.csv').read()";
  await setFirst(CODE);
  console.log("  (the interpreter's importInfo: " + JSON.stringify(await ev("window.sagebrush.kernel.ask({ importInfo: true }, 'python', null).then((m) => m && { cwd: m.cwd, path: m.path, builtins: m.builtins?.length, lib: m.lib?.length })")) + ")");

  // ---- imports follow the interpreter's own sys.path: the browser's has no workspace entry
  {
    await openDialog();
    const by = Object.fromEntries((await rows()).map((r) => [r.name, r]));
    ok(by["a.csv"]?.checked && /opened in the 1st cell/.test(by["a.csv"].why), `a.csv pre-checked: ${by["a.csv"]?.why}`);
    ok(!by["helper.py"]?.checked && !by["table.csv"]?.checked, "with sys.path the library only (pyjs can't import helper.py here), helper.py and what it opens stay unchecked");
    await closeDialog();
  }
  await runFirst("import sys\nsys.path.insert(0, '/')\nprint('path')");
  await setFirst(CODE);

  // ---- what is pre-checked, and why; rows don't move
  {
    await p.ev(HOLD);
    await openDialog({ wait: false });
    const before = await rows();
    await until("window.sagebrush.shareTest.held.length > 0");
    await release();
    await until("/^(Checked|Found no|Stopped)/.test(document.querySelector('#sharestatus').textContent)", 60000);
    const after = await rows();
    ok(JSON.stringify(before.map((r) => [r.name, r.top])) === JSON.stringify(after.map((r) => [r.name, r.top])), "rows never move as the checks apply (names and positions compared)");
    const by = Object.fromEntries(after.map((r) => [r.name, r]));
    ok(after[0].name === "Untitled.ipynb" && after[0].checked, "the notebook first, checked");
    ok(by["a.csv"]?.checked && /opened in the 1st cell/.test(by["a.csv"].why), `a.csv pre-checked: ${by["a.csv"]?.why}`);
    ok(by["helper.py"]?.checked && /imported in the 1st cell/.test(by["helper.py"].why), `with / on sys.path, helper.py pre-checked: ${by["helper.py"]?.why}`);
    ok(by["table.csv"]?.checked && /opened in helper\.py/.test(by["table.csv"].why), `table.csv (opened by the imported module) pre-checked: ${by["table.csv"]?.why}`);
    ok(!by["b.npy"]?.checked && !by["c.html"]?.checked && !by["big.bin"]?.checked, "unrelated files unchecked");
    ok(/^Checked 3 files this notebook uses/.test(await status()), `the aria-live result line: ${await status()}`);
    ok(await ev("document.querySelector('#sharestatus').getAttribute('aria-live') === 'polite'"), "...announced politely");
    ok(/^4 of \d+ files, /.test(await ev("document.querySelector('#sharesummary').textContent")), `the summary line: ${await ev("document.querySelector('#sharesummary').textContent")}`);
    await unhold();
    await closeDialog();
  }

  // ---- the unchecked-files test (§5): manifest and a fresh browser's view agree with the checks
  async function viewerFiles(link) {
    const { browserContextId } = await raw("Target.createBrowserContext");
    const v = await newPage(browserContextId);
    await v.send("Page.navigate", { url: link });
    await v.until("document.querySelectorAll('#nb .cell').length >= 1");
    await v.ev("document.querySelector('#runall').click()");
    await v.until("(() => { const c = document.querySelector('#nb .cell'); return /\\[\\d+\\]/.test(c.querySelector('.n').textContent) && !c.classList.contains('running') && !c.classList.contains('queued'); })()", 120000);
    const out = await v.ev("document.querySelector('#nb .cell .out').textContent");
    await raw("Target.closeTarget", { targetId: v.targetId });
    await raw("Target.disposeBrowserContext", { browserContextId });
    return out.trim().split("\n")[0];
  }
  async function shareNow(title) {
    await ev(`document.querySelector('#sharetitlein').value = ${JSON.stringify(title)}; document.querySelector('#shareresult').textContent = ''; document.querySelector('#shareupload').click()`);
    await until("document.querySelector('#shareresult a') || /failed/.test(document.querySelector('#shareresult').textContent)", 60000);
    return ev("document.querySelector('#shareresult a')?.href ?? document.querySelector('#shareresult').textContent");
  }
  const clickRow = (name, shift = false) => ev(`(() => { const r = [...document.querySelectorAll('#sharelist .sharerow')].find((r) => r.querySelector('.name').title === ${JSON.stringify(name)}); r.querySelector('input').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: ${shift} })); })()`);
  {
    await openDialog();
    const link = await shareNow("Defaults");
    ok(/\/s\/[a-z2-7]{12}$/.test(link), "shared with the defaults: " + link);
    const m = await lastManifest();
    ok(JSON.stringify(m.files) === JSON.stringify(["Untitled.ipynb", "a.csv", "helper.py", "table.csv"]), `the manifest is exactly the checked files: ${JSON.stringify(m.files)}`);
    const seen = await viewerFiles(link);
    ok(seen === "['Untitled.ipynb', 'a.csv', 'helper.py', 'table.csv']", `a fresh browser's shared notebook sees exactly them: ${seen}`);
    await closeDialog();
    // control: b.npy checked by hand appears in both
    await openDialog();
    await clickRow("b.npy");
    const link2 = await shareNow("With b.npy");
    const m2 = await lastManifest();
    ok(m2.files.includes("b.npy"), "(control) b.npy checked by hand: in the manifest");
    ok((await viewerFiles(link2)).includes("'b.npy'"), "(control) ...and in the shared notebook's files");
    await closeDialog();
    // control: a.csv unchecked by hand is absent from both
    await openDialog();
    await clickRow("a.csv");
    const link3 = await shareNow("Without a.csv");
    const m3 = await lastManifest();
    ok(!m3.files.includes("a.csv"), "(control) a.csv unchecked by hand: not in the manifest");
    ok(!(await viewerFiles(link3)).includes("'a.csv'"), "(control) ...nor in the shared notebook's files");
    await closeDialog();
  }

  // ---- the user's checks win over a held analysis (CORR-SHAREUX-3, UI-7)
  {
    await ev(HOLD);
    await openDialog({ wait: false });
    await until("window.sagebrush.shareTest.held.length > 0");
    await ev("document.querySelector('#sharenone').click()");
    await release();
    await until("/^(Checked|Found no|Stopped)/.test(document.querySelector('#sharestatus').textContent)", 60000);
    ok(JSON.stringify(await checkedNames()) === '["Untitled.ipynb"]', "Select none while the analysis is held, then released: no box changes");
    await closeDialog();
    await openDialog({ wait: false });
    const r0 = await rows();
    const ia = r0.findIndex((r) => r.name === "a.csv"), it = r0.findIndex((r) => r.name === "table.csv");
    await clickRow("a.csv"); // a.csv checked by hand: the anchor
    await clickRow("a.csv"); // and unchecked again (touched)
    await clickRow("table.csv", true); // the range a.csv..table.csv takes table.csv's new state (checked)
    const mid = await rows();
    const range = mid.filter((r) => r.i >= Math.min(ia, it) && r.i <= Math.max(ia, it));
    ok(range.every((r) => r.checked), `a shift range checks every row in it: ${JSON.stringify(range.map((r) => r.name))}`);
    await clickRow("helper.py"); // in the range? if so it's unchecked now, and must stay so
    const want = JSON.stringify(await checkedNames());
    await release();
    await until("/^(Checked|Found no|Stopped)/.test(document.querySelector('#sharestatus').textContent)", 60000);
    ok(JSON.stringify(await checkedNames()) === want, `a shift range's members (and later clicks) are never changed by the released analysis: ${want}`);
    await closeDialog();
    // an old dialog's results: held, closed, reopened, then released
    await openDialog({ wait: false });
    const before = (await ev("window.sagebrush.shareTest.terminated")) ?? 0;
    await closeDialog();
    // (the close event, which stops the analysis, is a queued task: waited for, not read at once)
    await until(`window.sagebrush.shareTest.terminated === ${before + 1}`, 10000).catch(() => {});
    ok((await ev("window.sagebrush.shareTest.terminated")) === before + 1, "closing the dialog terminates its analysis");
    await unhold();
    await openDialog();
    const fresh = JSON.stringify(await checkedNames());
    await release(0); // the first held one (long closed)
    await sleep(500);
    ok(JSON.stringify(await checkedNames()) === fresh, "an old dialog's results never touch the reopened one");
    await closeDialog();
  }

  // ---- Space and Shift+Space from the keyboard (UI-8)
  {
    await openDialog();
    await ev("document.querySelector('#sharenone').click()");
    const focus = (name) => ev(`[...document.querySelectorAll('#sharelist .sharerow')].find((r) => r.querySelector('.name').title === ${JSON.stringify(name)}).querySelector('input').focus()`);
    await focus("a.csv");
    await p.key(" ");
    ok(JSON.stringify(await checkedNames()) === '["Untitled.ipynb","a.csv"]', "Space checks the focused box");
    await focus("c.html");
    await p.key(" ", 8); // Shift
    const r = await rows();
    const ia = r.findIndex((x) => x.name === "a.csv"), ic = r.findIndex((x) => x.name === "c.html");
    ok(r.filter((x) => x.i >= Math.min(ia, ic) && x.i <= Math.max(ia, ic)).every((x) => x.checked), "Shift+Space checks the range from the anchor, from the keyboard alone");
    await closeDialog();
  }

  // ---- Upload before the analysis finishes: exactly what was checked (UI-1)
  {
    await ev(HOLD);
    await openDialog({ wait: false });
    await clickRow("c.html");
    await shareNow("Early");
    ok(/^Finding the files stopped: what you checked was uploaded/.test(await status()), `the note says so: ${await status()}`);
    const m = await lastManifest();
    ok(JSON.stringify(m.files) === JSON.stringify(["Untitled.ipynb", "c.html"]), `the manifest is the snapshot taken at Upload: ${JSON.stringify(m.files)}`);
    await release();
    await sleep(300);
    ok(JSON.stringify(await checkedNames()) === '["Untitled.ipynb","c.html"]', "the late analysis changes nothing after Upload");
    await unhold();
    await closeDialog();
  }

  // ---- while uploading: closing refused; everything restored after (UI-4, §4)
  {
    await openDialog();
    await ev("(() => { const t = window.sagebrush.shareTest; t.gate = new Promise((r) => (t.open = r)); t.onRead = () => t.gate; })()");
    await ev("document.querySelector('#shareupload').click()");
    await until("document.querySelector('#shareupload').getAttribute('aria-busy') === 'true'");
    ok(await ev("document.querySelector('#shareupload').disabled && document.querySelector('#shareupload').classList.contains('busy') && /Uploading/.test(document.querySelector('#shareupload').textContent)"), "Upload: disabled, a spinner, 'Uploading…'");
    ok(await ev("document.querySelector('#shareall').disabled && document.querySelector('#sharetitlein').disabled && [...document.querySelectorAll('#sharelist input')].every((b) => b.disabled)"), "the boxes, Select all/none and the fields are disabled");
    await ev("document.querySelector('#sharelist input').focus()");
    await p.key("Escape");
    await sleep(200);
    ok(await ev("document.querySelector('#sharedlg').open"), "Esc doesn't close the dialog while uploading");
    ok(await ev("document.querySelector('#sharedlg form button').disabled"), "...and ✕ is disabled");
    await ev("(() => { const t = window.sagebrush.shareTest; t.onRead = null; t.open(); })()");
    await until("document.querySelector('#shareresult a')", 60000);
    ok(await ev("!document.querySelector('#shareupload').disabled && document.querySelector('#shareupload').getAttribute('aria-busy') === 'false' && !document.querySelector('#shareall').disabled"), "after the upload, everything is enabled again");
    ok(await ev("(() => { const b = document.querySelector('#sharelist .sharerow input'); return b.checked && b.disabled; })()"), "...and the notebook's row is still checked and disabled");
    // a failed upload restores them too
    await ev("(() => { const t = window.sagebrush.shareTest; t.onRead = () => Promise.reject(new Error('gone')); })()");
    await ev("document.querySelector('#shareresult').textContent = ''; document.querySelector('#shareupload').click()");
    await until("/failed/.test(document.querySelector('#shareresult').textContent)", 30000);
    ok(await ev("!document.querySelector('#shareupload').disabled && !document.querySelector('#shareall').disabled && document.querySelector('#sharelist .sharerow input').disabled"), "after a failed upload, the same");
    await ev("window.sagebrush.shareTest.onRead = null");
    await closeDialog();
  }

  // ---- a close's event that arrives after the next open (the browser queues it): stale, the new
  // open's selection kept (train 4's web-sync: the open after a failed upload lost its list)
  {
    await openDialog();
    const g = await ev("window.sagebrush.share.generation");
    // (closed and opened again in one task: the close event comes after the open has begun)
    await ev("(() => { const d = document.querySelector('#sharedlg'); d.close(); d.showModal(); void window.sagebrush.share.open(); })()");
    await until(`window.sagebrush.share.generation > ${g}`);
    await until("/^(Checked|Found no|Stopped)/.test(document.querySelector('#sharestatus').textContent)", 60000).catch(() => {});
    await sleep(300);
    ok(await ev("!!window.sagebrush.share.selection && document.querySelectorAll('#sharelist .sharerow').length > 0 && /^(Checked|Found no|Stopped)/.test(document.querySelector('#sharestatus').textContent)"), `a close's event after the next open: ignored, the open's list and status kept (${await status()})`);
    await closeDialog();
  }

  // ---- a sign-in check that fails keeps what was known: a passing 5xx, or no answer, is neither
  // "signed out" nor "no sharing" (the open still happens, and Share stays Share)
  {
    await ev("(() => { const f = window.fetch; window.__fetch = f; window.fetch = (u, o) => (String(u).endsWith('/api/share/me') ? Promise.resolve(new Response('busy', { status: 503 })) : f(u, o)); })()");
    await openDialog();
    ok(await ev("!document.querySelector('#shareform').hidden && document.querySelector('#sharesignin').hidden && document.querySelector('#shareunreachable').hidden"), "a 503 from the sign-in check: the form as before, not 'Sign in', and the list opens");
    await closeDialog();
    await ev("document.querySelector('#sharemenu').click()");
    // (until the outcome is said, not only decided: closed before the dialog is drawn, its outcome is written after
    // the next case started recording the live region, which then saw a write from this open: train-22's CI)
    await until("document.querySelector('#sharedlg').open && document.querySelector('#sharechecking').dataset.state !== 'checking' && !!document.querySelector('#sharechecking').textContent", 10000).catch(() => {});
    ok(await ev("document.querySelector('#sharedlg').open && !document.querySelector('#shareform').hidden"), "...and File → Share again: still the Share dialog, not Copy share link");
    await closeDialog();
    await ev("window.fetch = window.__fetch");
  }

  // ---- #207 board's notes: the dialog opens at once while the check runs, and a close meanwhile ends that open
  {
    const slow = (ms) => ev(`(() => { const f = window.__fetch ?? window.fetch; window.__fetch = f; window.fetch = (u, o) => (String(u).endsWith('/api/share/me') ? new Promise((r) => setTimeout(r, ${ms})).then(() => f(u, o)) : f(u, o)); })()`);
    await slow(1500);
    await ev(RECORD_LIVE);
    const t0 = Date.now();
    await ev("document.querySelector('#sharemenu').click()");
    await until("document.querySelector('#sharedlg').open", 1000).catch(() => {});
    const early = await ev("({ open: document.querySelector('#sharedlg').open, checking: document.querySelector('#sharechecking').dataset.state === 'checking', form: !document.querySelector('#shareform').hidden, signin: !document.querySelector('#sharesignin').hidden, link: !document.querySelector('#sharelink').disabled && !document.querySelector('#shareup').contains(document.querySelector('#sharelink')) })");
    ok(Date.now() - t0 < 1000 && early.open && early.checking && !early.form && !early.signin && early.link, "a slow sign-in check: the dialog is open at once, saying it's checking, its link usable: " + JSON.stringify(early));
    await until("!document.querySelector('#shareform').hidden", 10000).catch(() => {});
    const seq0 = await ev("window.__live");
    ok(liveOrder(seq0, "Signed in: choose what to upload."), "the live region, signed in: empty while the dialog opens, then 'Checking…' (the dialog open), then the outcome, kept: " + JSON.stringify(seq0));
    ok(await ev("!document.querySelector('#shareform').hidden && document.querySelector('#sharechecking').dataset.state !== 'checking'"), "...then the form, the 'checking' note gone");
    await until("/^(Checked|Found no|Stopped)/.test(document.querySelector('#sharestatus').textContent)", 60000).catch(() => {});
    await closeDialog();
    const g = await ev("window.sagebrush.share.generation");
    await ev("document.querySelector('#sharemenu').click()");
    await until("document.querySelector('#sharedlg').open", 1000).catch(() => {});
    await sleep(200);
    await closeDialog();
    await sleep(2500);
    ok(await ev(`!document.querySelector('#sharedlg').open && window.sagebrush.share.generation === ${g}`), "closed while checking: the check's end opens nothing, and no file list is made");
    // (board's note b: the link, used mid-check: it copies, closes the dialog, and that open stops there)
    await ev("document.querySelector('#status').textContent = ''");
    await ev("document.querySelector('#sharemenu').click()");
    await until("document.querySelector('#sharedlg').open && document.querySelector('#sharechecking').dataset.state === 'checking'", 1000).catch(() => {});
    await sleep(200);
    await ev("document.querySelector('#sharelink').click()");
    await sleep(2500);
    ok(await ev(`!document.querySelector('#sharedlg').open && /^link (copied|in the address bar)$/.test(document.querySelector('#status').textContent) && location.hash.length > 1 && window.sagebrush.share.generation === ${g}`), "Copy link while checking: the link is copied and the dialog closed, and the check's end opens nothing: " + (await ev("document.querySelector('#status').textContent")));
    // (the copied link left in the address bar is taken out: nothing later reads it)
    await ev("history.replaceState(null, '', location.pathname + location.search)");
    await ev("window.fetch = window.__fetch");
  }
  // ---- nothing known (a fresh page whose every check fails), then a 404: board's untested row, and note 2
  {
    const { browserContextId } = await raw("Target.createBrowserContext");
    const q = await newPage(browserContextId);
    // (the stub before the page's own scripts: Page enabled first, and the call's answer checked, as raw() hides CDP errors)
    await q.send("Page.enable");
    const added = await q.send("Page.addScriptToEvaluateOnNewDocument", { source: "(() => { const f = window.fetch; window.__me = 503; window.__served = []; window.fetch = (u, o) => (String(u).endsWith('/api/share/me') ? (window.__served.push(window.__me), Promise.resolve(new Response('x', { status: window.__me }))) : f(u, o)); })()" });
    ok(!!added?.identifier, "(the fresh page's /api/share/me stub is registered: " + JSON.stringify(added) + ")");
    await q.send("Page.navigate", { url: dev.site + "/" });
    await q.until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
    ok((await q.ev("window.__me ?? null")) === 503, "(...and in place in the page, before its first check)");
    // (on a failure, the dialog's state: which part of it is shown)
    const st = () => q.ev("JSON.stringify({ open: document.querySelector('#sharedlg').open, checking: document.querySelector('#sharechecking').dataset.state === 'checking', up: !document.querySelector('#shareup').hidden, unreachable: !document.querySelector('#shareunreachable').hidden, signin: !document.querySelector('#sharesignin').hidden, form: !document.querySelector('#shareform').hidden, menu: document.querySelector('#sharemenu').textContent, stubbed: window.__me, status: document.querySelector('#status')?.textContent })");
    await q.ev(RECORD_LIVE);
    const t0 = Date.now();
    await q.ev("document.querySelector('#sharemenu').click()");
    // (until the outcome is said, not only decided: an answer before the dialog's first frame sets the state at once
    // and says the outcome once the dialog has been drawn, up to two frames or 50 ms later)
    await q.until("document.querySelector('#sharedlg').open && document.querySelector('#sharechecking').dataset.state !== 'checking' && !!document.querySelector('#sharechecking').textContent", 12000).catch(() => {});
    const seq503 = await q.ev("window.__live");
    ok(liveOrder(seq503, "Couldn't reach the server to check your sign-in.", false), "the live region, no answer (at once): 'Checking…' (the dialog open), then 'Couldn't reach the server…', kept: " + JSON.stringify(seq503));
    // (the end state, apart from the stub: the stubbed 503's check ends within its 10 s bound)
    ok(Date.now() - t0 < 11000 && (await q.ev("document.querySelector('#sharedlg').open && document.querySelector('#sharechecking').dataset.state !== 'checking'")), `(the check ends: ${Date.now() - t0} ms) ` + (await st()));
    ok(await q.ev("document.querySelector('#sharedlg').open && !document.querySelector('#shareup').hidden && !document.querySelector('#shareunreachable').hidden && document.querySelector('#sharesignin').hidden && document.querySelector('#shareform').hidden"), "nothing known and the check fails again: the dialog says why, with neither 'Sign in' nor the form: " + (await st()));
    await q.ev("document.querySelector('#sharedlg').close()");
    // (frames that stop after the first one, as in a tab hidden just then: the outcome is still said, within the
    // page's 1 s fallback; at 91556f97 the first frame turned that fallback off and nothing was ever said)
    await q.ev("(() => { const r = window.requestAnimationFrame; window.__raf = r; let armed = false, stopped = false; window.requestAnimationFrame = (cb) => r((ts) => { if (stopped) return; if (!armed) { armed = true; setTimeout(() => (stopped = true), 0); } cb(ts); }); })()");
    await q.ev(RECORD_LIVE);
    const t1 = Date.now();
    await q.ev("document.querySelector('#sharemenu').click()");
    await q.until("document.querySelector('#sharedlg').open && !!document.querySelector('#sharechecking').textContent", 5000).catch(() => {});
    const seqStop = await q.ev("window.__live");
    const saidStop = seqStop.filter((x) => x.text).map((x) => x.text);
    ok(saidStop.at(-1) === "Couldn't reach the server to check your sign-in." && seqStop.every((x) => !x.text || x.open) && Date.now() - t1 < 3000, `the live region, frames stopped after the first: the outcome still said, within ${Date.now() - t1} ms: ` + JSON.stringify(seqStop));
    await q.ev("window.requestAnimationFrame = window.__raf");
    await q.ev("document.querySelector('#sharedlg').close()");
    // (set before this open's own check, which reads it when it asks)
    await q.ev("window.__me = 404");
    const asked = await q.ev("window.__served.length");
    await q.ev("document.querySelector('#sharemenu').click()");
    await q.until("document.querySelector('#sharedlg').open && document.querySelector('#sharechecking').dataset.state !== 'checking'", 12000).catch(() => {});
    ok((await q.ev(`window.__served.slice(${asked}).join()`)) === "404", "(this open's check was answered 404 by the stub: " + (await q.ev("window.__served.join()")) + ")");
    ok(await q.ev("document.querySelector('#sharedlg').open && document.querySelector('#shareup').hidden && !document.querySelector('#sharelink').hidden"), "then a 404 (this site has no sharing): no Upload section at all, the link still there: " + (await st()));
    await raw("Target.closeTarget", { targetId: q.targetId });
    await raw("Target.disposeBrowserContext", { browserContextId });
  }
  // ---- board's H1: Share clicked on a fresh page while its FIRST check is still pending (slow): the dialog
  // at once, saying it's checking, never a copied link; then that check's own answer (not asked twice)
  for (const [code, want] of [[401, "signin"], [404, "linkonly"]]) {
    const { browserContextId } = await raw("Target.createBrowserContext");
    const q = await newPage(browserContextId);
    await q.send("Page.enable");
    const added = await q.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const f = window.fetch; window.__me = ${code}; window.__served = []; window.__pending = 0;
      window.fetch = (u, o) => (String(u).endsWith('/api/share/me') ? (window.__pending++, new Promise((r) => setTimeout(r, 6000)).then(() => (window.__pending--, window.__served.push(window.__me), new Response('x', { status: window.__me })))) : f(u, o)); })()` });
    await q.send("Page.navigate", { url: dev.site + "/" });
    // (the page has opened its notebook, and its first check is still pending: the slow-server case)
    await q.until("!!document.querySelector('#sharemenu') && !!window.sagebrush && !document.body.classList.contains('opening')", 30000);
    const before = await q.ev("({ pending: window.__pending, served: window.__served.length, hash: location.hash, status: document.querySelector('#status').textContent })");
    await q.ev(RECORD_LIVE);
    const t0 = Date.now();
    await q.ev("document.querySelector('#sharemenu').click()");
    await q.until("document.querySelector('#sharedlg').open && /Checking/.test(document.querySelector('#sharechecking').textContent)", 1000).catch(() => {});
    const early = await q.ev("({ open: document.querySelector('#sharedlg').open, checking: document.querySelector('#sharechecking').textContent })");
    ok(!!added?.identifier && before.pending === 1 && before.served === 0 && early.open && /Checking/.test(early.checking) && Date.now() - t0 < 1500, `H1 (${code}) Share clicked while the first check is pending: the dialog is open at once, saying it's checking: ` + JSON.stringify({ before, early }));
    await q.until("document.querySelector('#sharedlg').open && document.querySelector('#sharechecking').dataset.state !== 'checking'", 12000).catch(() => {});
    const end = await q.ev("({ open: document.querySelector('#sharedlg').open, up: !document.querySelector('#shareup').hidden, signin: !document.querySelector('#sharesignin').hidden, form: !document.querySelector('#shareform').hidden, unreachable: !document.querySelector('#shareunreachable').hidden, served: window.__served.join(), hash: location.hash, status: document.querySelector('#status').textContent })");
    const right = want === "signin" ? end.up && end.signin && !end.form && !end.unreachable : !end.up && !end.signin && !end.form;
    ok(end.open && right && end.served === String(code), `H1 (${code}) ...then the first check's own answer, asked once (${want === "signin" ? "Sign in" : "the link only"}): ` + JSON.stringify(end));
    ok(end.hash === before.hash && !/link (copied|in the address bar)/.test(end.status), "H1 (" + code + ") ...and never a copied link: the address bar's hash unchanged, no 'link copied'");
    const seqH = await q.ev("window.__live");
    const outcome = code === 401 ? "Sign in with CoCalc to upload." : "Uploading isn't available on this site.";
    ok(liveOrder(seqH, outcome), `H1 (${code}) the live region: 'Checking…' only with the dialog open, then "${outcome}", kept: ` + JSON.stringify(seqH));
    await raw("Target.closeTarget", { targetId: q.targetId });
    await raw("Target.disposeBrowserContext", { browserContextId });
  }

  // ---- #172 r2's review: closing mid-upload (board's UI-B1, astra3's CORR-172-ASTRA-4)
  {
    await openDialog();
    await ev("(() => { const t = window.sagebrush.shareTest; t.gate = new Promise((r) => (t.open = r)); t.onRead = () => t.gate; })()");
    await ev("document.querySelector('#shareupload').click()");
    await until("document.querySelector('#shareupload').getAttribute('aria-busy') === 'true'");
    ok(await ev("document.querySelector('#sharelink').disabled"), "Copy link is disabled while uploading");
    await ev("document.querySelector('#sharelink').onclick()");
    await sleep(200);
    ok(await ev("document.querySelector('#sharedlg').open"), "...and its handler, called anyway, doesn't close the dialog");
    await ev("document.querySelector('#sharelist input').focus()");
    await p.key("Escape");
    await sleep(150);
    await p.key("Escape");
    await sleep(300);
    ok(await ev("document.querySelector('#sharedlg').open"), "two Esc presses while uploading: the dialog is open (shown again if the second closed it)");
    await ev("document.querySelector('#sharedlg').close()");
    await sleep(200);
    ok(await ev("document.querySelector('#sharedlg').open"), "a programmatic close while uploading: shown again");
    const g = await ev("window.sagebrush.share.generation");
    await ev("document.querySelector('#sharemenu').click()");
    await sleep(300);
    ok((await ev("window.sagebrush.share.generation")) === g && (await ev("window.sagebrush.share.busy")), "Share clicked mid-upload: no new open, the upload's own state kept");
    ok(await ev("[...document.querySelectorAll('#sharelist input')].every((b) => b.disabled)"), "...its rows still disabled");
    await ev("(() => { const t = window.sagebrush.shareTest; t.onRead = null; t.open(); })()");
    await until("document.querySelector('#shareresult a')", 60000);
    ok(await ev("document.querySelector('#sharedlg').open && /^(Shared at|A new version is at)/.test(document.querySelector('#shareresult').textContent)"), "...and the link is shown in the open dialog");
    ok(await ev("!document.querySelector('#sharelink').disabled"), "Copy link enabled again after");
    await closeDialog();
  }

  // ---- #172 r2's review: an early upload that fails never says it was uploaded (board's UI-B3); the
  // progress line counts what was parsed (UI-B5)
  {
    await ev(HOLD);
    await openDialog({ wait: false });
    ok(/^Finding the files this notebook uses: \d+ parsed, \d+ checked…$/.test(await status()), `while analyzing: parsed and checked (${await status()})`);
    await clickRow("c.html");
    await ev("window.sagebrush.shareTest.onRead = () => Promise.reject(new Error('gone'))");
    await ev("document.querySelector('#shareupload').click()");
    await until("/failed/.test(document.querySelector('#shareresult').textContent)", 30000);
    const st = await status();
    ok(!/was uploaded/.test(st) && /^Finding the files stopped: nothing was shared/.test(st), `an early upload whose read fails: never "was uploaded" (${st})`);
    await ev("window.sagebrush.shareTest.onRead = null");
    await release();
    await unhold();
    await closeDialog();
  }

  // ---- reads: opening and selecting read no data file; upload reads exactly the checked ones, once each
  {
    await ev("(() => { const t = window.sagebrush.shareTest; t.reads = []; t.onRead = (p) => { t.reads.push(p); }; })()");
    await openDialog();
    await ev("document.querySelector('#shareall').click(); document.querySelector('#sharenone').click()");
    await clickRow("a.csv");
    await clickRow("b.npy", true); // (a range short of big.bin, which is over the plan's largest file)
    const opened = await ev("window.sagebrush.shareTest.reads");
    ok(opened.every((x) => x.endsWith(".py")), `opening, the analysis and selecting read only the .py the code imports: ${JSON.stringify(opened)}`);
    await ev("window.sagebrush.shareTest.reads = []");
    const want = (await checkedNames()).filter((x) => x !== "Untitled.ipynb").map((x) => "/" + x).sort();
    await shareNow("Reads");
    const read = (await ev("window.sagebrush.shareTest.reads")).sort();
    ok(JSON.stringify(read) === JSON.stringify(want), `upload read exactly the checked files, once each: ${JSON.stringify(read)}`);
    await ev("window.sagebrush.shareTest.onRead = null");
    await closeDialog();
  }

  // ---- a bound disables Upload, with the reason (§1)
  {
    await openDialog();
    await clickRow("big.bin");
    ok(await ev("document.querySelector('#shareupload').disabled"), "a file larger than the plan's largest file: Upload disabled");
    ok(/big\.bin is larger than your plan's largest file/.test(await ev("document.querySelector('#sharesummary').textContent")), `...the summary says why: ${await ev("document.querySelector('#sharesummary').textContent")}`);
    await clickRow("big.bin");
    ok(!(await ev("document.querySelector('#shareupload').disabled")), "unchecked again: Upload enabled");
    await closeDialog();
  }

  // A stand-in for the analysis worker around the real one (deps-worker.ts, really parsing): it records,
  // on the page's clock, when `name` is posted to it and when the worker next says anything. The worker
  // parses a file synchronously, so between those two moments it is busy with that file and says nothing.
  // With hold, what the worker says after `name` is held back from the page (t.quieted).
  const WRAP = (name, hold, silenceMs) => `(() => {
    const t = window.sagebrush.shareTest;
    t.failsafe = { silenceMs: ${silenceMs}, sourceBytes: 1e9 };
    t.terminated = 0; t.quieted = false; delete t.postedAt; delete t.nextAt;
    t.createWorker = () => {
      const w = new Worker('/sagebrush-share-deps.js');
      const o = { onmessage: null, terminate: () => { t.terminated++; w.terminate(); },
        postMessage: (m) => { if (String(m?.file?.path ?? '').endsWith(${JSON.stringify(name)})) { t.postedAt = performance.now(); if (${hold}) t.quieted = true; } w.postMessage(m); } };
      w.onmessage = (e) => { if (t.postedAt !== undefined && t.nextAt === undefined) t.nextAt = performance.now(); if (!t.quieted) o.onmessage?.(e); };
      return o;
    };
  })()`;
  const unwrap = () => ev("(() => { const t = window.sagebrush.shareTest; delete t.failsafe; delete t.createWorker; })()");

  // ---- a long parse in the worker: the dialog answers while it runs (§3)
  {
    // (2,000,000 lines: pyparse takes seconds on any machine; the clicks must land while it runs, which
    // is checked, and their round trip is timed from here, so that a page waiting on the parse would show)
    await runFirst("open('long.py', 'w').write('x = 1\\n' * 2000000)\nprint('long')");
    await setFirst(CODE + "\nimport long");
    // (hold: what the worker says after long.py never reaches the page, so the analysis can't end by
    // itself, which would terminate the worker too; only the close below can, grader's #206 note)
    await ev(WRAP("long.py", true, 600000));
    await openDialog({ wait: false });
    await until("window.sagebrush.shareTest.postedAt !== undefined", 60000);
    // (the post reaches the worker in well under 200 ms; from then on it is parsing)
    await sleep(200);
    const t0 = Date.now();
    const r = await ev("(() => { const t = window.sagebrush.shareTest; const a = performance.now(); document.querySelector('#shareall').click(); document.querySelector('#sharenone').click(); const b = performance.now(); return { a, b, posted: t.postedAt, next: t.nextAt ?? null }; })()");
    const rt = Date.now() - t0;
    const during = r.posted + 150 < r.a && (r.next === null || r.next > r.b);
    ok(during, `the clicks land while the worker parses long.py (posted at ${r.posted.toFixed(0)} ms, clicks ${r.a.toFixed(0)}-${r.b.toFixed(0)}, the worker's next message ${r.next === null ? "not yet" : r.next.toFixed(0)})`);
    ok(rt < 500 && r.b - r.a < 100, `the dialog answers while the analysis parses (${rt} ms round trip, ${(r.b - r.a).toFixed(1)} ms in the page)`);
    // (control: the same round trip sees a page that is busy: a 1.5 s loop on the page's own thread)
    await ev("setTimeout(() => { const t = performance.now(); while (performance.now() - t < 1500) {} }, 0)");
    await sleep(30);
    const c0 = Date.now();
    await ev("document.querySelector('#shareall').click()");
    const crt = Date.now() - c0;
    ok(crt >= 1000, `(control) the same measurement sees a page blocked for 1.5 s: ${crt} ms round trip`);
    ok(await ev("window.sagebrush.shareTest.terminated === 0 && window.sagebrush.shareTest.quieted === true"), "before the close: the worker still running (not terminated), its answers held back");
    await closeDialog();
    // (closing stops the still-running parse: its worker terminated, once; the close event is a queued task)
    await until("window.sagebrush.shareTest.terminated === 1", 10000).catch(() => {});
    ok((await ev("window.sagebrush.shareTest.terminated")) === 1, "closing the dialog mid-parse terminates the worker, once");
    await unwrap();
    // (long.py removed again: the later checks count the workspace's files)
    await runFirst("import os\nos.remove('long.py')\nprint('removed')");
    await setFirst(CODE);
  }

  // ---- the fail-safe: a worker silent past it is stopped, and the dialog still works (§3)
  {
    // (the watchdog, not responsiveness: the worker really parses deep.py, but what it says after deep.py
    // is held back from the page, so the page sees a silent worker for the 2 s on any machine, train-9b's
    // web-sync: a fast runner's parse could finish first. A deeply nested source would fail at once, "too
    // many nested parentheses", and be a parse note, not a stop: #172 r2's review)
    await runFirst("open('deep.py', 'w').write('x = 1\\n' * 400000)\nprint('deep')");
    await setFirst(CODE + "\nimport deep");
    await ev(WRAP("deep.py", true, 2000));
    await openDialog({ wait: false });
    await until("/^Stopped finding files/.test(document.querySelector('#sharestatus').textContent)", 30000);
    ok(await ev("window.sagebrush.shareTest.quieted === true"), "the worker was silent to the page after deep.py (the hold-back engaged)");
    ok((await ev("window.sagebrush.shareTest.terminated")) === 1, "the fail-safe terminated the worker");
    ok(await ev("[...document.querySelectorAll('#sharelist .sharerow .why')].some((w) => w.textContent === 'not analyzed')"), "unchecked rows say 'not analyzed'");
    ok(!(await ev("document.querySelector('#shareupload').disabled")), "...and Upload still works");
    await unwrap();
    await closeDialog();
    await setFirst(CODE);
  }

  // ---- 100,000 files: the dialog opens without reading any (LIMIT-SHARE-UX-1)
  if (process.env.SHARE_DIALOG_BIG !== "0") {
    const t0 = Date.now();
    const N = Number(process.env.SHARE_DIALOG_N ?? 10000);
    // (through the workspace's own API, in parallel batches: Python writing them one by one takes minutes)
    await ev(`(async () => {
      const w = await window.sagebrush.shareTest.workspace();
      await w.mkdir("/many").catch(() => {});
      const one = new Uint8Array([120]);
      for (let i = 0; i < ${N}; i += 500) {
        const batch = [];
        for (let k = i; k < Math.min(${N}, i + 500); k++) batch.push(w.putFile("/many/f" + k + ".txt", one));
        await Promise.all(batch);
      }
    })()`, 900_000);
    console.log(`  (100,000 files written in ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    await ev("(() => { const t = window.sagebrush.shareTest; t.reads = []; t.onRead = (p) => { t.reads.push(p); }; })()");
    const t1 = Date.now();
    await openDialog();
    const shown = await ev("document.querySelectorAll('#sharelist .sharerow').length");
    const total = await ev("document.querySelector('#sharesummary').textContent");
    ok(shown < 200 && new RegExp(`of ${(N + 8).toLocaleString("en-US")} files`).test(total), `${N.toLocaleString("en-US")}+ entries: ${shown} row nodes, ${total} (opened in ${((Date.now() - t1) / 1000).toFixed(1)} s)`);
    ok((await ev("window.sagebrush.shareTest.reads")).every((x) => x.endsWith(".py")), "...and no data file read");
    const half = Math.floor(N / 2);
    await ev(`document.querySelector('#sharelist').scrollTop = 40 * ${half}`);
    await sleep(200);
    ok(await ev(`[...document.querySelectorAll('#sharelist .sharerow')].some((r) => +r.dataset.i >= ${half} && +r.dataset.i < ${half} + 100)`), "scrolled halfway: the rows there are drawn");
    await ev("window.sagebrush.shareTest.onRead = null");
    await closeDialog();
  }
  // ---- the workspace's cap, 100,000 entries, as an inventory (writing 100,000 real files takes ~25
  // minutes here; the real workspace's listing is the 10,000-file case above)
  {
    await ev(`window.sagebrush.shareTest.listFiles = async () => Array.from({ length: 100000 }, (_, i) => ({ path: "/cap/f" + String(i).padStart(6, "0") + ".bin", size: i % 7 === 0 ? 50 * 1024 * 1024 : 10, fid: "fid" + i }))`);
    await ev("(() => { const t = window.sagebrush.shareTest; t.reads = []; t.onRead = (p) => { t.reads.push(p); }; })()");
    const t1 = Date.now();
    await openDialog();
    const shown = await ev("document.querySelectorAll('#sharelist .sharerow').length");
    ok(shown < 200 && /of 100,001 files/.test(await ev("document.querySelector('#sharesummary').textContent")), `the 100,000-entry cap: ${shown} row nodes (opened in ${((Date.now() - t1) / 1000).toFixed(1)} s)`);
    await ev("document.querySelector('#shareall').click()");
    const sum = await ev("document.querySelector('#sharesummary').textContent");
    ok(/at most 10,000 files can be shared/.test(sum) && (await ev("document.querySelector('#shareupload').disabled")), `Select all at the cap: over the 10,000-file bound, Upload disabled: ${sum}`);
    await ev("document.querySelector('#sharenone').click()");
    ok((await ev("window.sagebrush.shareTest.reads")).length === 0, "...and opening, Select all/none at 100,000 entries read no file (14,286 of them 50 MB)");
    await ev("(() => { const t = window.sagebrush.shareTest; t.onRead = null; delete t.listFiles; })()");
    await closeDialog();
  }

  // ---- the caller's import facts (python's #170 review, carried to PR B): builtinModules is exactly
  // pyjs's native factories (the runtime's own too, never the library's); packageModules is the
  // registry's and the optional set's names.  (Last: it adds workspace files the counts above don't expect.)
  {
    const info = await ev("window.sagebrush.kernel.ask({ importInfo: true }, 'python', null)");
    const b = new Set(info.builtins), lib = new Set(info.lib);
    ok(b.has("math") && b.has("_fs"), `the natives, the runtime's own (_fs) too: ${b.size} names`);
    ok(![...b].some((n) => lib.has(n)), `no library module among the natives (${lib.size} library modules)`);
    ok(lib.has("textwrap") && !b.has("textwrap"), "textwrap is the library's (on sys.path), not native");
    ok(Array.isArray(info.packages) && info.packages.includes("sortedcontainers") && !info.packages.some((n) => b.has(n)), `the registry's packages, none native: ${JSON.stringify(info.packages)}`);
    await runFirst("open('textwrap.py', 'w').write('X = 1\\n')\nopen('math.py', 'w').write('X = 1\\n')\nprint('shadows')");
    await setFirst("import textwrap\nimport math\nimport sortedcontainers");
    await openDialog();
    // (the list draws only the rows in view, and the files written above sort first: scroll to find these)
    const find = async (name) => {
      const h = await ev("document.querySelector('#sharelist').scrollHeight");
      for (let top = 0; top <= h; top += 40 * 10) { // (about 20 rows are drawn at a time)
        await ev(`document.querySelector('#sharelist').scrollTop = ${top}`);
        await sleep(60);
        const r = (await rows()).find((x) => x.name === name);
        if (r) return r;
      }
      return undefined;
    };
    const by = { "textwrap.py": await find("textwrap.py"), "math.py": await find("math.py") };
    ok(by["textwrap.py"]?.checked && /imported in the 1st cell/.test(by["textwrap.py"].why), `a workspace textwrap.py ahead of the library on sys.path is what pyjs imports: pre-checked (${by["textwrap.py"]?.why})`);
    ok(by["math.py"] && !by["math.py"].checked, "a workspace math.py isn't (math is native): unchecked");
    ok(!/couldn't be followed/.test(await status()), `a registry package (sortedcontainers) isn't reported as found nowhere: ${await status()}`);
    await closeDialog();
    await setFirst("import nosuchmodule_x");
    await openDialog();
    ok(/1 name in the code couldn't be followed/.test(await status()), `...while a module found nowhere is: ${await status()}`);
    await closeDialog();
    await setFirst(CODE);
  }

  // ---- #172 r2's review: python's PY-172-1, a workspace file named like a module the runtime seeds isn't pre-checked
  {
    await runFirst("open('builtins.py', 'w').write('X = 1\\n')\nopen('__main__.py', 'w').write('X = 1\\n')\nprint('seeded')");
    await setFirst("import builtins\nimport __main__");
    await openDialog();
    const find = async (name) => {
      const h = await ev("document.querySelector('#sharelist').scrollHeight");
      for (let top = 0; top <= h; top += 40 * 10) {
        await ev(`document.querySelector('#sharelist').scrollTop = ${top}`);
        await sleep(60);
        const r = (await rows()).find((x) => x.name === name);
        if (r) return r;
      }
      return undefined;
    };
    const b = await find("builtins.py"), m = await find("__main__.py");
    ok(b && !b.checked && m && !m.checked, `import builtins / import __main__ with workspace builtins.py and __main__.py: neither pre-checked (${JSON.stringify([b?.checked, m?.checked])})`);
    await closeDialog();
  }

  // ---- #172 r2's review: one cell that can't be parsed doesn't stop the analysis (board's UI-B2, UI-B5)
  {
    await setFirst("x = (");
    await ev("window.sagebrush.notebook.addCell('y = open(\"a.csv\").read()')");
    await openDialog();
    const st = await status();
    const a = await findRow("a.csv");
    const k = await ev("window.sagebrush.notebook.snapshot().cells.length"); // (the added cell is the last)
    const nth = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th");
    ok(a?.checked && a.why.includes(`opened in the ${nth(k)} cell`), `the parseable cell's a.csv is pre-checked (${a?.why})`);
    ok(/^Checked \d+ files? this notebook uses/.test(st) && /The 1st cell couldn't be parsed, so the files it names aren't pre-checked\./.test(st), `done, with the parse note: ${st}`);
    ok(!(await rows()).some((r) => r.why === "not analyzed") && !/Stopped/.test(st), "...not 'Stopped', and no row says 'not analyzed'");
    ok(!/  /.test(st), "no double space in the status line");
    await closeDialog();
    await setFirst(CODE);
  }

  // ---- #172 r2's review: an interpreter that doesn't answer (astra3's CORR-172-ASTRA-1, board's UI-B4); a worker
  // that can't start (daybreak3's CORR-SHAREB-3)
  {
    await runFirst("import os\nos.makedirs('nb', exist_ok=True)\nopen('nb/a.csv', 'w').write('x\\n')\nprint('decoy')");
    await setFirst("y = open('a.csv').read()");
    await ev("window.sagebrush.shareTest.importInfo = async () => null");
    await ev("(() => { const t = window.sagebrush.shareTest; t.reads = []; t.onRead = (p) => { t.reads.push(p); }; })()");
    await ev("document.querySelector('#sharedlg').open && document.querySelector('#sharedlg').close()");
    await ev("document.querySelector('#sharemenu').click()");
    await until("/interpreter didn't answer/.test(document.querySelector('#sharestatus').textContent)", 30000);
    const by = { "a.csv": await findRow("a.csv"), "nb/a.csv": await findRow("nb/a.csv") };
    ok(by["a.csv"] && by["nb/a.csv"] && !by["a.csv"].checked && !by["nb/a.csv"].checked, `the interpreter didn't answer, so its cwd is unknown: neither a.csv nor nb/a.csv is guessed (${JSON.stringify([by["a.csv"]?.checked, by["nb/a.csv"]?.checked])})`);
    ok(/isn't running, or is busy running a cell/.test(await status()) && !/^Stopped/.test(await status()), `...said honestly: ${await status()}`);
    ok(!(await ev("document.querySelector('#shareupload').disabled")), "...and Upload works");
    await closeDialog();
    await ev("(() => { const t = window.sagebrush.shareTest; delete t.importInfo; t.onRead = null; t.createWorker = () => { throw new Error('blocked'); }; })()");
    await openDialog();
    ok(/^Stopped finding files/.test(await status()) && !(await ev("window.sagebrush.share.analyzing")), `a worker that can't be constructed: stopped, not stuck analyzing (${await status()})`);
    ok(!(await ev("document.querySelector('#shareupload').disabled")) && (await rows()).some((r) => r.why === "not analyzed"), "...Upload usable, unchecked rows 'not analyzed'");
    await ev("delete window.sagebrush.shareTest.createWorker");
    await closeDialog();
  }

  // ---- #172 r2's review: the notebook has the per-file bound too, checked again at Upload (astra3's CORR-172-ASTRA-3)
  {
    await setFirst(CODE);
    await openDialog();
    await setFirst("x = '" + "a".repeat(2100000) + "'");
    const before = (await ev("(async () => (await fetch('/api/share/mine')).json())()")).collections.length;
    await ev("document.querySelector('#shareupload').click()");
    await until("/larger than your plan's largest file/.test(document.querySelector('#shareresult').textContent)", 10000);
    const after = (await ev("(async () => (await fetch('/api/share/mine')).json())()")).collections.length;
    ok(after === before && !(await ev("window.sagebrush.share.busy")), `a notebook grown past the largest file since Share opened: Upload refuses it, nothing uploaded (${await ev("document.querySelector('#shareresult').textContent")})`);
    await closeDialog();
    await openDialog();
    ok(/Untitled\.ipynb is larger than your plan's largest file/.test(await ev("document.querySelector('#sharesummary').textContent")) && (await ev("document.querySelector('#shareupload').disabled")), `opened with it: the summary says so and Upload is disabled (${await ev("document.querySelector('#sharesummary').textContent")})`);
    await closeDialog();
    await setFirst(CODE);
  }

  // ---- #172 r2's review: one open, and its upload, belong to one notebook (astra3's CORR-172-ASTRA-2)
  {
    // the identity changes between open and Upload: refused, nothing uploaded
    await openDialog();
    const n0 = (await ev("(async () => (await fetch('/api/share/mine')).json())()")).collections.length;
    await ev("window.sagebrush.shareTest.notebookId = () => 'another notebook'");
    await ev("document.querySelector('#shareupload').click()");
    await sleep(300);
    const n1 = (await ev("(async () => (await fetch('/api/share/mine')).json())()")).collections.length;
    ok(n1 === n0 && /The notebook changed since Share was opened/.test(await ev("document.querySelector('#shareresult').textContent")), "the notebook changed since the dialog opened: Upload refused, nothing uploaded");
    await ev("delete window.sagebrush.shareTest.notebookId");
    await closeDialog();
    // a held analysis whose notebook changed: its results are dropped
    await ev(HOLD);
    await openDialog({ wait: false });
    await until("window.sagebrush.shareTest.held.length > 0");
    await ev("window.sagebrush.shareTest.notebookId = () => 'another notebook'");
    await release();
    await sleep(800);
    ok(!(await rows()).some((r) => r.name === "a.csv" && r.checked), "a held analysis released after the notebook changed: nothing pre-checked from it");
    await ev("delete window.sagebrush.shareTest.notebookId");
    await unhold();
    await closeDialog();
    // a real switch of notebooks while uploading: the switch waits; the collection is the first notebook's
    const first = await ev("localStorage.getItem('sagebrush-current')");
    await openDialog();
    await ev("(() => { const t = window.sagebrush.shareTest; t.gate = new Promise((r) => (t.open = r)); t.onRead = () => t.gate; })()");
    ok(!!(await findRow("a.csv")), "(a.csv found in the list)");
    if (!(await findRow("a.csv"))?.checked) await clickRow("a.csv");
    ok((await findRow("a.csv"))?.checked, "(a.csv checked, so the upload reads a file and waits at the gate)");
    await ev("document.querySelector('#shareupload').click()");
    await until("window.sagebrush.share.busy");
    await ev("document.querySelector('#filemenu [data-f=new]').click()");
    await sleep(800);
    ok((await ev("localStorage.getItem('sagebrush-current')")) === first && (await ev("window.sagebrush.share.busy")), "New notebook while uploading: the switch waits for the upload");
    await ev("(() => { const t = window.sagebrush.shareTest; t.onRead = null; t.open(); })()");
    await until(`localStorage.getItem('sagebrush-current') !== ${JSON.stringify(first)}`, 60000);
    const second = await ev("localStorage.getItem('sagebrush-current')");
    ok(!(await ev("window.sagebrush.notebook.snapshot().share_id")) && !(await ev("document.querySelector('#sharedlg').open")), "...then the new notebook opens, with no share_id, and the dialog closed");
    await ev(`window.sagebrush.open(${JSON.stringify(first)})`);
    await until(`localStorage.getItem('sagebrush-current') === ${JSON.stringify(first)}`, 30000);
    const sid = await ev("window.sagebrush.notebook.snapshot().share_id");
    const mine = (await ev("(async () => (await fetch('/api/share/mine')).json())()")).collections.map((c) => c.id);
    ok(!!sid && mine.includes(sid) && second !== first, `...and the collection's id is on the notebook it was uploaded from (${sid})`);
  }

  // ---- #172 r3's review: no notebook identity mid-switch, so Share waits for it (astra3's CORR-172-R3-ASTRA-1)
  {
    const from = await ev("localStorage.getItem('sagebrush-current')");
    await ev("document.querySelector('#sharedlg').open && document.querySelector('#sharedlg').close()");
    // the new notebook's load held (attach): Share clicked meanwhile waits, and opens only once it's attached
    await ev("(() => { const t = window.sagebrush.shareTest; t.attachGate = new Promise((r) => (t.attachOpen = r)); t.beforeAttach = () => t.attachGate; })()");
    const g0 = await ev("window.sagebrush.share.generation");
    await ev("document.querySelector('#filemenu [data-f=new]').click()");
    await sleep(400);
    await ev("document.querySelector('#sharemenu').click()");
    await sleep(600);
    ok(!(await ev("document.querySelector('#sharedlg').open")) && (await ev("window.sagebrush.share.generation")) === g0, "Share clicked while the new notebook loads: it waits (no dialog, no new open)");
    await ev("window.sagebrush.share.open()");
    ok((await ev("window.sagebrush.share.generation")) === g0 && /The notebook is changing/.test(await status()), `...and an open called mid-switch is refused (${await status()})`);
    await ev("(() => { const t = window.sagebrush.shareTest; delete t.beforeAttach; t.attachOpen(); })()");
    await until(`localStorage.getItem('sagebrush-current') !== ${JSON.stringify(from)}`, 30000);
    await until("document.querySelector('#sharedlg').open && !!window.sagebrush.share.selection && window.sagebrush.share.generation > " + g0, 30000);
    const to = await ev("localStorage.getItem('sagebrush-current')");
    ok((await ev("window.sagebrush.share.notebook")) === to && to !== from, `...then it opens, bound to the new notebook only (${to})`);
    ok(JSON.stringify(await checkedNames()) === '["Untitled.ipynb"]', `...with nothing of the old notebook's checked (${JSON.stringify(await checkedNames())})`);
    await closeDialog();
    // leaving held (mayLeave): likewise
    await ev("(() => { const t = window.sagebrush.shareTest; t.leaveGate = new Promise((r) => (t.leaveOpen = r)); t.beforeLeave = () => t.leaveGate; })()");
    const g1 = await ev("window.sagebrush.share.generation");
    await ev(`void window.sagebrush.open(${JSON.stringify(from)})`);
    await sleep(400);
    await ev("document.querySelector('#sharemenu').click()");
    await sleep(600);
    ok(!(await ev("document.querySelector('#sharedlg').open")) && (await ev("window.sagebrush.share.generation")) === g1, "Share clicked while the notebook is being left: it waits");
    await ev("(() => { const t = window.sagebrush.shareTest; delete t.beforeLeave; t.leaveOpen(); })()");
    await until(`localStorage.getItem('sagebrush-current') === ${JSON.stringify(from)}`, 30000);
    await until("document.querySelector('#sharedlg').open && !!window.sagebrush.share.selection && window.sagebrush.share.generation > " + g1, 30000);
    ok((await ev("window.sagebrush.share.notebook")) === from, "...then opens for the notebook switched to");
    await closeDialog();
  }

  // ---- a failed first upload leaves no share, and a retry of its attempt gets one share (plan-upload-leak r3)
  {
    const mine = () => ev("(async () => (await (await fetch('/api/share/mine')).json()).collections.length)()");
    const snap = (k) => ev(`window.sagebrush.notebook.snapshot().${k} ?? null`);
    // (a new notebook whose file is new to the server, so its upload PUTs it)
    const fresh = async (tag) => {
      await ev("document.querySelector('#filemenu [data-f=new]').click()");
      await until("document.querySelectorAll('.cell').length === 1 && !document.querySelector('.cell textarea').value && !window.sagebrush.notebook.snapshot().share_id");
      await setFirst(`T = 1  # ${tag} ${Date.now()}`);
      await sleep(700);
    };
    // (the page's own requests: the share's answer lost after the server made it, or a blob refused)
    const intercept = (mode) => ev(`(() => {
      const f = window.__realFetch ?? window.fetch; window.__realFetch = f; window.__made = null; window.__sent = [];
      window.fetch = async (u, o) => {
        const s = String(u), m = o?.method ?? "GET";
        if (/\\/api\\/share\\/(collections|first-upload|check|blob)/.test(s) && m !== "GET") window.__sent.push(m + " " + s.replace(location.origin, ""));
        if (${JSON.stringify(mode)} === "putfail" && s.includes("/api/share/blob/") && m === "PUT") return new Response('{"error":"busy"}', { status: 503 });
        if (${JSON.stringify(mode)} === "lose" && s.endsWith("/api/share/first-upload") && m === "POST") {
          const r = await f(u, o);
          window.__made = await r.clone().json();
          return new Response('{"error":"lost"}', { status: 503 });
        }
        return f(u, o);
      };
    })()`);
    const restore = () => ev("window.fetch = window.__realFetch ?? window.fetch");
    // (each case on its own, with its own time: one that throws, or doesn't end within 90 s, is a failure, and
    // the next still runs; its cleanup is bounded too, as a crashed page answers nothing)
    const within = (ms, pr) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error(`no end within ${ms / 1000} s`)), ms))]);
    const block = async (name, fn, ms = 90_000) => {
      try { await within(ms, fn()); } catch (e) { ok(false, `${name} threw: ${e.message}`); await within(5000, restore()).catch(() => {}); await within(5000, closeDialog()).catch(() => {}); }
    };

    // D1: a failed first upload, then a retry (SHARE_D1_RUNS times: 2 shows it's stable)
    for (let run = 1; run <= Math.max(1, Number(process.env.SHARE_D1_RUNS) || 1); run++) await block(`D1 (run ${run})`, async () => {
    await fresh("D1");
    const n0 = await mine();
    await openDialog();
    await intercept("putfail");
    const f1 = await shareNow("D1");
    const att1 = await snap("share_attempt");
    await restore();
    ok(/failed/.test(f1) && (await mine()) === n0 && /^[0-9a-f]{32}$/.test(att1 ?? "") && !(await snap("share_id")), "D1 a blob refused: the upload fails, no share is made, and the notebook keeps its attempt: " + f1);
    const l1 = await shareNow("D1");
    ok(/\/s\//.test(l1) && (await mine()) === n0 + 1 && (await snap("share_id")) && !(await snap("share_attempt")), "D1 ...the retry makes exactly one share; share_id set, the attempt cleared");
    await closeDialog();
    });

    // D3: the attempt can't be saved: nothing is read or sent
    await block("D3", async () => {
    await fresh("D3");
    const n3 = await mine();
    await openDialog();
    await intercept("none");
    await ev("window.sagebrush.shareTest.saved = () => Promise.reject(new Error('disk full'))");
    const f3 = await shareNow("D3");
    const sent3 = await ev("window.__sent");
    await ev("delete window.sagebrush.shareTest.saved");
    await restore();
    ok(/couldn't be saved/.test(f3) && sent3.length === 0 && (await mine()) === n3, `D3 a notebook whose attempt can't be saved isn't uploaded: no request to collections, check or blob (${JSON.stringify(sent3)}): ${f3}`);
    await closeDialog();
    });

    // D4: a lost answer, then other files: never a success, and the earlier share is named
    await block("D4", async () => {
    await fresh("D4");
    const n4 = await mine();
    await openDialog();
    // (a workspace file besides the notebook, checked here by hand: what the analysis pre-checks isn't the point)
    const extra = (await rows()).find((x) => x.name !== "Untitled.ipynb")?.name;
    if (extra && !(await rows()).find((x) => x.name === extra)?.checked) await clickRow(extra);
    const had = await checkedNames();
    await intercept("lose");
    await shareNow("D4");
    const made4 = await ev("window.__made");
    await restore();
    ok(made4?.collection && (await mine()) === n4 + 1 && !!extra && had.includes(extra), `(D4 the share was made, its answer lost; checked ${JSON.stringify(had)})`);
    await clickRow(extra);
    const f4 = await shareNow("D4");
    const files4 = await ev(`(async () => (await (await fetch('/api/share/c/${made4?.collection}')).json()).manifest.files.map((f) => f.path).sort().join())()`);
    ok(/different files/.test(f4) && f4.includes(`/s/${made4?.collection}`) && !(await ev("!!document.querySelector('#shareresult a') && /^(Shared at|A new version)/.test(document.querySelector('#shareresult').textContent)")) && (await snap("share_id")) === made4?.collection && !(await snap("share_attempt")) && (await mine()) === n4 + 1 && files4 === [...had].sort().join(),
      `D4 the same attempt with a file unchecked: "shared with different files" and its link, not the success view; share_id is that share's, which still holds the first files (${files4}): ${f4}`);
    const l4 = await shareNow("D4");
    const files4b = await ev(`(async () => (await (await fetch('/api/share/c/${made4?.collection}')).json()).manifest.files.map((f) => f.path).sort().join())()`);
    ok(/\/s\//.test(l4) && (await mine()) === n4 + 1 && !files4b.split(",").includes(extra), `D4 ...the next upload is a new version of that share, with the current selection (${files4b})`);
    await closeDialog();
    });

    // D5: a lost answer, the share deleted, then the retry
    await block("D5", async () => {
    await fresh("D5");
    const n5 = await mine();
    await openDialog();
    await intercept("lose");
    await shareNow("D5");
    const made5 = await ev("window.__made");
    await restore();
    const del5 = await ev(`(async () => (await fetch('/api/share/collections/${made5?.collection}', { method: 'DELETE' })).status)()`);
    const f5 = await shareNow("D5");
    const gone5 = await ev(`(async () => (await fetch('/api/share/c/${made5?.collection}')).status)()`);
    ok(del5 === 200 && /earlier share was deleted/.test(f5) && gone5 === 404 && (await mine()) === n5 && !(await snap("share_attempt")) && !(await snap("share_id")), `D5 a retry after its share was deleted: told so, no new share, the old link still 404: ${f5}`);
    const l5 = await shareNow("D5");
    ok(/\/s\//.test(l5) && !l5.includes(made5?.collection) && (await mine()) === n5 + 1, "D5 ...the next upload makes a new share, with a new id");
    await closeDialog();
    });

    // D6: copies and exports never carry the attempt
    await block("D6", async () => {
    await fresh("D6");
    await ev("window.sagebrush.notebook.setMeta({ share_attempt: '0123456789abcdef0123456789abcdef' })");
    const { ipynb, link } = await ev("window.sagebrush.shareTest.exports()");
    await ev("window.prompt = () => 'D6 copy'");
    await ev("document.querySelector('#filemenu [data-f=duplicate]').click()");
    await until("window.sagebrush.notebook.snapshot().name === 'D6 copy'", 30000).catch(() => {});
    const copied = await snap("share_attempt");
    ok((await snap("name")) === "D6 copy" && !copied && typeof ipynb === "string" && ipynb.includes("cells") && !ipynb.includes("0123456789abcdef") && typeof link === "string" && link.includes("#") && !link.includes("0123456789abcdef"), "D6 \"make a copy\" has no attempt, and the notebook's .ipynb export and its share link don't carry it");
    });


    // D7 (astra3's L1): a remote update merged during the awaited save, or while uploading, decides what is sent
    const B = "b".repeat(32), C = "c".repeat(32);
    // (a real second writer: another tab's store saving this notebook, a newer revision of its record in the
    // browser's store, optionally posted to the other tabs as that store does; the page meets it through its
    // own code: a save that conflicts (applyRemote from the conflict), or its subscription)
    const secondWriter = (patch, post = false) => `(async () => {
      const id = localStorage.getItem('sagebrush-current');
      const db = await new Promise((ok, no) => { const r = indexedDB.open('sagebrush'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
      const rec = await new Promise((ok, no) => { const tx = db.transaction('notebooks', 'readwrite'), st = tx.objectStore('notebooks'); let out; const g = st.get(id); g.onsuccess = () => { out = { ...g.result, ...${JSON.stringify(patch)}, rev: (g.result.rev ?? 0) + 1, updated: Date.now() }; st.put(out); }; tx.oncomplete = () => ok(out); tx.onerror = () => no(tx.error); });
      db.close();
      if (${post}) { const ch = new BroadcastChannel('sagebrush-notebooks'); ch.postMessage({ from: 'other-tab', id, doc: rec }); ch.close(); }
      return rec.rev;
    })()`;
    const recordSent = () => ev(`(() => { const f = window.__realFetch ?? window.fetch; window.__realFetch = f; window.__attempts = []; window.fetch = async (u, o) => { if (String(u).endsWith("/api/share/first-upload") && o?.method === "POST") window.__attempts.push(JSON.parse(o.body).attempt); return f(u, o); }; })()`);
    await block("D7a", async () => {
      await fresh("D7a");
      const n = await mine();
      await openDialog();
      await recordSent();
      await ev(`window.sagebrush.shareTest.saved = async () => { await ${secondWriter({ share_attempt: B })}; await window.sagebrush.notebook.saved(); }`);
      const l = await shareNow("D7a");
      await ev("delete window.sagebrush.shareTest.saved");
      await restore();
      const sent = await ev("window.__attempts");
      ok(/\/s\//.test(l) && sent.length === 1 && sent[0] === B && (await mine()) === n + 1 && !(await snap("share_attempt")), `D7a another writer's attempt merged by the awaited save: the kept attempt is the one sent (${JSON.stringify(sent)}), one share`);
      await closeDialog();
    });
    await block("D7d", async () => {
      // (the other writer's save AFTER the page's own: that save had nothing new to write, so it met no conflict)
      await fresh("D7d");
      const n = await mine();
      await openDialog();
      await recordSent();
      await ev(`window.sagebrush.shareTest.saved = async () => { await window.sagebrush.notebook.saved(); await ${secondWriter({ share_attempt: "e".repeat(32) })}; }`);
      const l = await shareNow("D7d");
      await ev("delete window.sagebrush.shareTest.saved");
      await restore();
      const sent = await ev("window.__attempts");
      ok(/\/s\//.test(l) && sent.length === 1 && sent[0] === "e".repeat(32) && (await mine()) === n + 1, `D7d another writer's attempt saved after the page's own save: the stored attempt is the one sent (${JSON.stringify(sent)}), one share`);
      await closeDialog();
    });
    await block("D7b", async () => {
      await fresh("D7b");
      const n = await mine();
      await openDialog();
      await recordSent();
      await ev(`window.sagebrush.shareTest.saved = async () => { await ${secondWriter({ share_id: "zzzzzzzzzzzz", share_attempt: null })}; await window.sagebrush.notebook.saved(); }`);
      const f7 = await shareNow("D7b");
      await ev("delete window.sagebrush.shareTest.saved");
      await restore();
      ok(/shared from elsewhere/.test(f7) && (await ev("window.__attempts.length")) === 0 && (await mine()) === n, `D7b a share made elsewhere, merged by the awaited save: nothing is sent, no share made: ${f7}`);
      await ev("window.sagebrush.notebook.setMeta({ share_id: null })");
      await closeDialog();
    });
    await block("D7c", async () => {
      await fresh("D7c");
      const n = await mine();
      await openDialog();
      await recordSent();
      await ev(`(() => { const f = window.fetch; let once = false; window.fetch = async (u, o) => { if (!once && String(u).endsWith("/api/share/check")) { once = true; await ${secondWriter({ share_attempt: C }, true)}; await new Promise((r) => setTimeout(r, 200)); } return f(u, o); }; })()`);
      const f7 = await shareNow("D7c");
      const none = await ev("window.__attempts.length");
      const l = await shareNow("D7c");
      await restore();
      const sent = await ev("window.__attempts");
      ok(/changed elsewhere while uploading/.test(f7) && none === 0 && /\/s\//.test(l) && sent.length === 1 && sent[0] === C && (await mine()) === n + 1, `D7c the attempt replaced while uploading: the share request isn't sent (${f7}); the retry sends the kept attempt (${JSON.stringify(sent)}), one share`);
      await closeDialog();
    });


    // (this device's records, through the page's own seams (#243's registry design r3 §8): read in a fresh
    // transaction, key -> {attempt, at, tag}; written, replacing all, by a strict one; a fault set or cleared)
    const ST = "window.sagebrush.shareTest";
    const reg = async (P = { ev }) => JSON.parse(await P.ev(`(async () => JSON.stringify((await ${ST}.sent()) ?? null))()`));
    const seed = (map, raw = "[]", P = { ev }) => P.ev(`(async () => { await ${ST}.seed(${map}, { raw: ${raw} }); return true; })()`);
    const fault = (f, P = { ev }) => P.ev(`${ST}.fault = ${f ? JSON.stringify(f) : "null"}`);
    // (the records' own operations, for the cases that order them: their tagged outcome, or "rejected: ...")
    const op = (expr) => ev(`(async () => { const r = ${ST}.registry(); try { return await (${expr}); } catch (e) { return "rejected: " + (e?.message ?? e); } })()`);
    const acct = () => ev(`${ST}.account()`);
    const curId = () => ev("localStorage.getItem('sagebrush-current')");

    // D10 (daybreak3's r3 note 3): another account's record for this notebook is never used
    await block("D10", async () => {
      await fresh("D10");
      const n = await mine();
      await openDialog();
      await recordSent();
      const theirs = "9".repeat(32);
      await seed(`{ ['someone-else|' + localStorage.getItem('sagebrush-current')]: { attempt: '${theirs}', at: Date.now() } }`);
      const l = await shareNow("D10");
      await restore();
      const sent = await ev("window.__attempts");
      const left = JSON.stringify(await reg());
      ok(/\/s\//.test(l) && sent.length === 1 && sent[0] !== theirs && (await mine()) === n + 1 && left.includes(theirs), `D10 another account's record for this notebook: not sent (sent ${sent.map((x) => x.slice(0, 6))}), left in place, one share`);
      await seed("{}");
      await closeDialog();
    });
    // D11 (daybreak3's r3 note 2): the registry stays bounded; records of browser notebooks no longer here go
    await block("D11", async () => {
      await fresh("D11");
      await openDialog();
      // (120 records of browser notebooks that don't exist here, 30 of workspace files, the oldest first)
      // (and one of a browser notebook here that is durably shared: it never sends a first upload again)
      const sharedId = await ev(`(async () => { const db = await new Promise((ok, no) => { const r = indexedDB.open('sagebrush'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); const all = await new Promise((ok, no) => { const q = db.transaction('notebooks').objectStore('notebooks').getAll(); q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); }); db.close(); return all.find((d) => d?.share_id && typeof d.id === 'string' && d.id !== localStorage.getItem('sagebrush-current'))?.id ?? null; })()`);
      await seed(`(() => { const all = {}; for (let i = 0; i < 120; i++) all['acct|gone' + i] = { attempt: 'a'.repeat(32), at: i + 1 }; for (let i = 0; i < 30; i++) all['acct|file:/f' + i + '.ipynb'] = { attempt: 'b'.repeat(32), at: 1000 + i }; all['acct|' + ${JSON.stringify(sharedId)}] = { attempt: 'd'.repeat(32), at: 2000 }; return all; })()`);
      const l1 = await shareNow("D11");
      const after1 = Object.keys((await reg()) ?? {});
      ok(!!sharedId && !after1.includes("acct|" + sharedId), `D11 a record of a browser notebook here that is durably shared (${sharedId}) is dropped as it never sends a first upload again`);
      ok(/\/s\//.test(l1) && after1.filter((k) => k.startsWith("acct|gone")).length === 0 && after1.filter((k) => k.startsWith("acct|file:")).length === 30, `D11 a record's write drops the records of browser notebooks no longer here (120 -> ${after1.filter((k) => k.startsWith("acct|gone")).length}) and keeps the workspace files' (${after1.filter((k) => k.startsWith("acct|file:")).length})`);
      await closeDialog();
      await seed("{}");
    });
    // R2 (daybreak3's CORR-UPLOAD-R4-2): 100 live records, none provably done (workspace files', which no prune
    // drops): a 101st first upload is refused before its request, and no record is evicted for it; at 100 with this
    // notebook's own record among them, its retry still goes and recovers its share
    await block("R2", async () => {
      await fresh("R2");
      const n = await mine();
      await openDialog();
      await seed(`(() => { const all = {}; for (let i = 0; i < 100; i++) all['acct|file:/g' + i + '.ipynb'] = { attempt: 'c'.repeat(32), at: i + 1 }; return all; })()`);
      await recordSent();
      const l1 = await shareNow("R2");
      const sent1 = await ev("window.__attempts");
      await restore();
      const k1 = Object.keys(await reg());
      ok(/failed/.test(l1) && /outcome it hasn't confirmed/.test(l1) && sent1.length === 0 && (await mine()) === n && k1.length === 100 && k1.includes("acct|file:/g0.ipynb"), `R2 100 live records: a 101st first upload is refused before its request (${sent1.length} sent), none evicted (${k1.length} kept, the oldest ${k1.includes("acct|file:/g0.ipynb") ? "there" : "GONE"}): ${l1}`);
      // (one slot freed: this notebook's upload is recorded, its answer lost; at 100 again, its retry goes)
      await seed(`(await (async () => { const all = await ${ST}.sent(); delete all['acct|file:/g0.ipynb']; return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { attempt: v.attempt, at: v.at }])); })())`);
      await intercept("lose");
      const l2 = await shareNow("R2");
      const made2 = await ev("window.__made");
      await restore();
      const k2 = Object.keys(await reg());
      await recordSent();
      const l3 = await shareNow("R2");
      const sent3 = await ev("window.__attempts");
      await restore();
      const id3 = await snap("share_id");
      ok(/failed/.test(l2) && !!made2?.collection && k2.length === 100 && /\/s\//.test(l3) && sent3.length === 1 && id3 === made2.collection && (await mine()) === n + 1, `R2 ...at 100 with this notebook's own record among them (${k2.length}): its retry goes (${sent3.length} sent) and gets the share its lost answer made (${id3} vs ${made2?.collection}): ${l3}`);
      await seed("{}");
      await closeDialog();
    });

    // ---- the records in IndexedDB (#243's registry design r3 §8, CLEAR by astra3 and daybreak3)
    // F1-F5b: each refused before the share request, the records exactly as seeded (nothing committed)
    for (const [name, f, why] of [
      ["F1", { open: true }, "the records' database can't be opened"],
      ["F1b", { locks: true }, "no Web Locks"],
      ["F2a", { plan: true }, "the change's plan throws, before any request"],
      ["F2b", { afterWrite: true }, "an abort after the write request succeeded, before the commit"],
      ["F2c", { requestFail: true }, "a request that fails after the write (an add of an existing key)"],
      ["F3", { get: true }, "the records can't be read"],
      ["F4", { quota: true }, "a quota-like abort after the write (simulated)"],
      ["F5a", { txCreate: true }, "a strict transaction can't be made"],
      ["F5b", { durability: true }, "the transaction doesn't report strict"],
    ]) await block(name, async () => {
      await fresh(name);
      const n = await mine();
      await openDialog();
      await seed(`{ 'acct|file:/keep.ipynb': { attempt: 'cccccccccccccccccccccccccccccccc', at: 1 } }`);
      const before = JSON.stringify(await reg());
      await fault(f);
      await recordSent();
      const l = await shareNow(name);
      const sent = await ev("window.__attempts");
      await restore();
      await fault(null);
      const after = JSON.stringify(await reg());
      ok(/failed/.test(l) && sent.length === 0 && (await mine()) === n && after === before, `${name} ${why}: refused before the request (${sent.length} sent), the records exactly as seeded (${after === before}): ${l}`);
      await seed("{}");
      await closeDialog();
    });
    // F5c: every change of the records is strict, each kind: put, drop and forget, with one entry each
    await block("F5c", async () => {
      await fresh("F5c");
      await openDialog();
      await seed("{}");
      const a = await acct();
      await ev(`${ST}.changeLog = []`);
      const K = "file:/f5c.ipynb", x = "1".repeat(32);
      const o1 = await op(`r.put(${JSON.stringify(a)}, '${K}', '${x}')`);
      const o2 = await op(`r.drop(${JSON.stringify(a)}, '${K}', '${x}')`);
      const o3 = await op(`r.put(${JSON.stringify(a)}, '${K}', '${x}')`);
      const o4 = await op(`r.forget('${K}')`);
      const log = await ev(`${ST}.changeLog.filter((e) => 'durability' in e)`);
      await ev(`delete ${ST}.changeLog`);
      const kinds = log.map((e) => e.kind).join(","), strict = log.every((e) => e.durability === "strict");
      ok([o1, o2, o3, o4].join(",") === "recorded,dropped,recorded,forgotten" && kinds === "put,drop,put,forget" && strict, `F5c every change of the records is strict, one entry a change (${kinds}; strict: ${strict}; outcomes ${[o1, o2, o3, o4].join(",")})`);
      // (and a whole upload's: its record and its settle)
      await ev(`${ST}.changeLog = []`);
      const l = await shareNow("F5c");
      await until(`(async () => Object.keys((await ${ST}.sent()) ?? { x: 1 }).length === 0)()`, 15000).catch(() => {});
      const log2 = await ev(`${ST}.changeLog.filter((e) => 'durability' in e)`);
      await ev(`delete ${ST}.changeLog`);
      ok(/\/s\//.test(l) && log2.map((e) => e.kind).join(",") === "put,drop" && log2.every((e) => e.durability === "strict"), `F5c ...an upload's record and settle: ${log2.map((e) => `${e.kind} ${e.durability}`).join(", ")}`);
      await closeDialog();
    });
    // F6: a read-back that fails comes after the strict commit: nothing sent now, the receipt kept (never deleted
    // to restore anything), and the retry sends that same attempt; the seam changes only what the read-back sees
    for (const seen of ["reject", "missing", "mismatch"]) await block(`F6 ${seen}`, async () => {
      await fresh(`F6 ${seen}`);
      const n = await mine();
      await openDialog();
      await seed("{}");
      const a = await acct(), id = await curId();
      await fault({ readback: seen });
      await recordSent();
      const l1 = await shareNow(`F6 ${seen}`);
      const sent1 = await ev("window.__attempts");
      await restore();
      await fault(null);
      const att = await snap("share_attempt");
      const kept = (await reg())?.[`${a}|${id}`];
      ok(/failed/.test(l1) && sent1.length === 0 && (await mine()) === n && /^[0-9a-f]{32}$/.test(att ?? "") && kept?.attempt === att && kept?.tag === "attempt", `F6 ${seen}: a read-back failing after the commit: refused (${sent1.length} sent), the committed receipt kept with this attempt (${kept?.attempt?.slice(0, 6)} vs ${att?.slice(0, 6)}): ${l1}`);
      await recordSent();
      const l2 = await shareNow(`F6 ${seen}`);
      const sent2 = await ev("window.__attempts");
      await restore();
      ok(/\/s\//.test(l2) && sent2.length === 1 && sent2[0] === att && (await mine()) === n + 1, `F6 ${seen} ...the retry sends that same attempt, once (${sent2.map((x) => x.slice(0, 6))}): ${l2}`);
      await closeDialog();
    });
    // F6b (astra3's code r1 A3-1): the lock is held all through the read-back. The read-back is held pending; another
    // holder's lock, asked for then, is queued and not granted; released, the read-back ends before that lock is had
    // (astra3's code r2 A3-1, daybreak3's addendum: whatever fails in F6b or F6c, the cleanup opens the gate (which also
    // expires by itself after 20 s, failing the read-back), drains the put and the other holder within bounds, clears
    // the fault, and says whether the lock is let go; a failure is that case's, by name, and no later case waits)
    const gateCleanup = async () => {
      // (bounded: each step at most 5 s, a page that answers nothing included)
      const step = (expr) => within(5000, ev(expr, 5000)).catch(() => null);
      await step(`${ST}.fault = null; ${ST}.readbackGo?.()`);
      await step("(async () => { const t = (p) => Promise.race([p, new Promise((go) => setTimeout(go, 4000))]); await t(window.__f6bP); await t(window.__f6bC); })()");
      const held = await step("(async () => ((await navigator.locks.query()).held ?? []).some((l) => l.name === 'sagebrush-share-sent'))()");
      // (and a later holder has it, within 5 s)
      const later = await step("(async () => await Promise.race([navigator.locks.request('sagebrush-share-sent', async () => true), new Promise((go) => setTimeout(() => go(false), 4000))]))()");
      await step(`delete ${ST}.changeLog; delete ${ST}.readbackGo; delete window.__f6bP; delete window.__f6bC; delete window.__f6b`);
      await within(5000, seed("{}")).catch(() => {});
      return { held, later };
    };
    const gateHeld = async (a) => {
      await seed("{}");
      await ev(`${ST}.changeLog = []`);
      await fault({ readbackHold: true });
      await ev(`(() => { window.__f6b = { got: false }; window.__f6bP = ${ST}.registry().put(${JSON.stringify(a)}, 'file:/f6b.ipynb', '${"2".repeat(32)}').catch(() => "rejected"); })()`);
      await until(`typeof ${ST}.readbackGo === "function"`, 15000);
    };
    await block("F6b", async () => {
      try {
        await gateHeld(await acct());
        await ev(`(() => { window.__f6bC = navigator.locks.request('sagebrush-share-sent', async () => { window.__f6b.got = true; ${ST}.changeLog.push({ kind: "other holder" }); }); })()`);
        await sleep(500);
        const gotWhileHeld = await ev("window.__f6b.got");
        const queued = await ev("(async () => ((await navigator.locks.query()).pending ?? []).some((l) => l.name === 'sagebrush-share-sent'))()");
        await ev(`${ST}.readbackGo()`);
        const out = await ev("(async () => { const o = await window.__f6bP; await window.__f6bC; return o; })()", 15000);
        const order = await ev(`${ST}.changeLog.map((e) => e.kind)`);
        ok(!gotWhileHeld && queued && out === "recorded" && order.indexOf("readback") >= 0 && order.indexOf("readback") < order.indexOf("other holder"),
          `F6b the lock is held all through the read-back: while it was held the other holder was queued (${queued}) and not granted (${!gotWhileHeld}); then ${order.join(" -> ")} (${out})`);
      } finally {
        const { held, later } = await gateCleanup();
        ok(held === false && later === true, `F6b ...cleanup: the records' lock let go after the case (held: ${held}; a later holder had it: ${later})`);
      }
    });
    // F6c (daybreak3's addendum): a failure forced while the read-back is held: the case says so by name, its cleanup
    // lets the lock go, and a later holder has it
    await block("F6c", async () => {
      let forced = null;
      try {
        await gateHeld(await acct());
        throw new Error("F6c: forced failure while the read-back is held");
      } catch (e) {
        forced = e.message;
      } finally {
        const { held, later } = await gateCleanup();
        ok(/forced failure/.test(forced ?? "") && held === false && later === true, `F6c a failure forced while the read-back was held (${forced}): the cleanup let the lock go (held: ${held}), and a later holder had it (${later})`);
      }
    });
    // F7 (astra3's code r1 A3-2, daybreak3's IDB-CODE-R1-1): a native abort of a read, after its request succeeded,
    // settles that read; nothing waits on it, so the lock goes (a second holder then has it). get's: the upload
    // refused, the records as seeded. The read-back's: refused, the committed receipt kept. Each of the prune's three
    // reads (the notebooks' keys, the records, one notebook): unknown, so that row is kept, and the upload goes
    for (const where of ["get", "readback", "prune-keys", "prune-rows", "prune-notebook"]) await block(`F7 ${where}`, async () => {
      await fresh(`F7 ${where}`);
      const n = await mine();
      await openDialog();
      const a = await acct(), id = await curId();
      // (prune-keys and prune-rows: a row of a browser notebook not here, which a known read would prune;
      // prune-notebook: a row of a notebook here that is durably shared, which a known read of it would prune)
      const sharedHere = where === "prune-notebook" ? await ev(`(async () => { const db = await new Promise((ok, no) => { const r = indexedDB.open('sagebrush'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); const all = await new Promise((ok, no) => { const q = db.transaction('notebooks').objectStore('notebooks').getAll(); q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); }); db.close(); return all.find((d) => d?.share_id && typeof d.id === 'string' && d.id !== localStorage.getItem('sagebrush-current'))?.id ?? null; })()`) : null;
      const pruneRow = where === "prune-notebook" ? `acct|${sharedHere}` : "acct|ghost-f7";
      await seed(where.startsWith("prune") ? `{ ${JSON.stringify(pruneRow)}: { attempt: 'cccccccccccccccccccccccccccccccc', at: 1 } }` : `{ 'acct|file:/keep.ipynb': { attempt: 'cccccccccccccccccccccccccccccccc', at: 1 } }`);
      const before = JSON.stringify(await reg());
      await fault({ readAbort: where });
      await recordSent();
      const l = await shareNow(`F7 ${where}`);
      const sent = await ev("window.__attempts");
      await restore();
      await fault(null);
      const after = await reg();
      // (the lock was let go: a change after it ends)
      const next = await op(`r.put(${JSON.stringify(a)}, 'file:/f7-next.ipynb', '${"6".repeat(32)}')`);
      if (where === "get") ok(/failed/.test(l) && sent.length === 0 && (await mine()) === n && JSON.stringify(after) === before && next === "recorded", `F7 get: a native abort of the records' read: refused (${sent.length} sent), the records as seeded, the lock let go (${next}): ${l}`);
      else if (where === "readback") {
        const att = await snap("share_attempt");
        ok(/failed/.test(l) && sent.length === 0 && (await mine()) === n && after?.[`${a}|${id}`]?.attempt === att && !!att && next === "recorded", `F7 readback: a native abort of the read-back: refused (${sent.length} sent), the committed receipt kept (${after?.[`${a}|${id}`]?.attempt?.slice(0, 6)}), the lock let go (${next}): ${l}`);
      } else ok((where !== "prune-notebook" || !!sharedHere) && /\/s\//.test(l) && sent.length === 1 && (await mine()) === n + 1 && !!after?.[pruneRow] && next === "recorded", `F7 ${where}: a native abort of the prune's read: that row kept as unknown (${!!after?.[pruneRow]}), the upload sent (${sent.length}), the lock let go (${next}): ${l}`);
      await seed("{}");
      await closeDialog();
    });
    // M1: a malformed row is unknown, never absent: its notebook's upload is refused and the row stays; it counts
    // towards the limit; it is never pruned
    await block("M1", async () => {
      await fresh("M1");
      const n = await mine();
      await openDialog();
      const a = await acct(), id = await curId();
      const bad = JSON.stringify({ key: `${a}|${id}`, account: a, notebook: id, attempt: "zz", at: 1 });
      await seed("{}", `[${bad}]`);
      await recordSent();
      const l = await shareNow("M1");
      const sent = await ev("window.__attempts");
      await restore();
      const row = (await reg())?.[`${a}|${id}`];
      ok(/failed/.test(l) && sent.length === 0 && (await mine()) === n && row?.tag === "unreadable" && row?.attempt === "zz", `M1 a malformed row of this notebook: refused (${sent.length} sent), the row left as it was (${row?.tag}): ${l}`);
      // (99 good rows and 1 malformed, of a browser notebook not here: nothing prunes it, so a new one is full)
      await seed(`(() => { const all = {}; for (let i = 0; i < 99; i++) all['acct|file:/m' + i + '.ipynb'] = { attempt: 'cccccccccccccccccccccccccccccccc', at: i + 1 }; return all; })()`, `[{ key: 'acct|ghost-m1', account: 'acct', notebook: 'ghost-m1', attempt: 'bad', at: 1 }]`);
      const o = await op(`r.put(${JSON.stringify(a)}, 'file:/m-new.ipynb', '${"3".repeat(32)}')`);
      const rows = await reg();
      ok(o === "full" && Object.keys(rows).length === 100 && rows["acct|ghost-m1"]?.tag === "unreadable", `M1 ...a malformed row counts towards the limit and is never pruned: ${o}, ${Object.keys(rows).length} rows, the malformed one ${rows["acct|ghost-m1"]?.tag ?? "GONE"}`);
      await seed("{}");
      await closeDialog();
    });
    // C1-C3: the records' changes ordered by the case (one page; R1 and R4 order them across tabs)
    await block("C", async () => {
      const a = JSON.stringify(await acct());
      const A0 = "4".repeat(32), A1 = "5".repeat(32);
      // C1: at 99, two new records at once from two pages of this browser: exactly one recorded, the other full
      const P2 = await newPage();
      await P2.send("Page.navigate", { url: dev.site + "/" });
      await P2.until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
      await seed(`(() => { const all = {}; for (let i = 0; i < 99; i++) all['acct|file:/c' + i + '.ipynb'] = { attempt: 'cccccccccccccccccccccccccccccccc', at: i + 1 }; return all; })()`);
      const putIn = (P, nbk, att) => P.ev(`(async () => { try { return await ${ST}.registry().put(${a}, '${nbk}', '${att}'); } catch (e) { return "rejected"; } })()`);
      const c1 = (await Promise.all([putIn({ ev }, "file:/c1a.ipynb", A0), putIn(P2, "file:/c1b.ipynb", A1)])).sort();
      await raw("Target.closeTarget", { targetId: P2.targetId });
      ok(c1.join(",") === "full,recorded" && Object.keys(await reg()).length === 100, `C1 at 99, two new records at once from two pages: ${c1.join(", ")}`);
      // C1b: at 100, one of them a browser notebook no longer here: a new one prunes it and is recorded
      await seed(`(() => { const all = {}; for (let i = 0; i < 99; i++) all['acct|file:/c' + i + '.ipynb'] = { attempt: 'cccccccccccccccccccccccccccccccc', at: i + 1 }; all['acct|ghost-c1b'] = { attempt: 'cccccccccccccccccccccccccccccccc', at: 0 }; return all; })()`);
      const c1b = await op(`r.put(${a}, 'file:/c1b-new.ipynb', '${A0}')`);
      const r1b = await reg();
      ok(c1b === "recorded" && Object.keys(r1b).length === 100 && !r1b["acct|ghost-c1b"], `C1b at 100 with one prunable: the capacity is counted after pruning: ${c1b}, ${Object.keys(r1b).length} rows`);
      // C2a: settle then put, the same key
      const K = "file:/c2.ipynb", key = `${JSON.parse(a)}|${K}`;
      await seed("{}");
      const c2a = [await op(`r.put(${a}, '${K}', '${A0}')`), await op(`r.drop(${a}, '${K}', '${A0}')`), await op(`r.put(${a}, '${K}', '${A1}')`)];
      ok(c2a.join(",") === "recorded,dropped,recorded" && (await reg())[key]?.attempt === A1, `C2a a settle, then a new attempt's record: ${c2a.join(", ")}`);
      // C2b: an older settle after a newer record: A read a0; a0 retired by C's settle; a1 recorded; A's drop(a0) keeps a1
      await seed("{}");
      const c2b = [await op(`r.put(${a}, '${K}', '${A0}')`)];
      const readA = await op(`r.get(${a}, '${K}')`);
      c2b.push(await op(`r.drop(${a}, '${K}', '${A0}')`), await op(`r.put(${a}, '${K}', '${A1}')`), await op(`r.drop(${a}, '${K}', ${JSON.stringify(readA?.attempt ?? "?")})`));
      ok(readA?.attempt === A0 && c2b.join(",") === "recorded,dropped,recorded,kept" && (await reg())[key]?.attempt === A1, `C2b an older settle (of ${readA?.attempt?.slice(0, 6)}) after a newer record: ${c2b.join(", ")}; the newer kept`);
      // C2c: a new attempt while the first is live: other, nothing changed
      await seed("{}");
      const c2c = [await op(`r.put(${a}, '${K}', '${A0}')`), await op(`r.put(${a}, '${K}', '${A1}')`)];
      ok(c2c.join(",") === "recorded,other" && (await reg())[key]?.attempt === A0, `C2c another attempt while one is live: ${c2c.join(", ")}`);
      // C3a: a prune, then a record of the same key: the record stands
      await seed(`{ ['acct|ghost-c3']: { attempt: '${A0}', at: 1 } }`);
      const c3a = [await op(`r.put(${a}, 'file:/c3x.ipynb', '${A1}')`)];
      const pruned = !(await reg())["acct|ghost-c3"];
      c3a.push(await op(`r.put('acct', 'ghost-c3', '${A1}')`));
      ok(pruned && c3a.join(",") === "recorded,recorded" && (await reg())["acct|ghost-c3"]?.attempt === A1, `C3a a prune (${pruned}), then a record of that key: ${c3a.join(", ")}; it stands`);
      // C3b: a record of a notebook here, then another's prune: kept
      const id = await curId();
      await seed("{}");
      const c3b = [await op(`r.put(${a}, ${JSON.stringify(id)}, '${A0}')`), await op(`r.put(${a}, 'file:/c3y.ipynb', '${A1}')`)];
      ok(c3b.join(",") === "recorded,recorded" && (await reg())[`${JSON.parse(a)}|${id}`]?.attempt === A0, `C3b a record of a notebook here, then another's prune: ${c3b.join(", ")}; kept`);
      // C3c: a refusal persists no prune
      await seed(`{ ['acct|ghost-c3c']: { attempt: '${A0}', at: 1 }, [${a} + '|${K}']: { attempt: '${A0}', at: 2 } }`);
      const c3c = await op(`r.put(${a}, '${K}', '${A1}')`);
      ok(c3c === "other" && !!(await reg())["acct|ghost-c3c"], `C3c a refusal (${c3c}) persists no prune: the prunable row is still there`);
      await seed("{}");
    });
    // D9 (astra3's r2 note 2): a store that can't be read stops the upload, at either re-read; it is never taken for no storage
    await block("D9a", async () => {
      await fresh("D9a");
      const n = await mine();
      await openDialog();
      await recordSent();
      await ev("(() => { const st = window.sagebrush.notebook.store; st.load = () => Promise.reject(new Error('disk')); })()");
      const f9 = await shareNow("D9a");
      await ev("delete window.sagebrush.notebook.store.load");
      await restore();
      ok(/couldn't be read/.test(f9) && (await ev("window.__attempts.length")) === 0 && (await mine()) === n, `D9a the store unreadable after the awaited save (which succeeded): nothing is sent, no share made: ${f9}`);
      await closeDialog();
    });
    await block("D9b", async () => {
      await fresh("D9b");
      const n = await mine();
      await openDialog();
      await recordSent();
      await ev(`(() => { const f = window.fetch; let once = false; window.fetch = async (u, o) => { if (!once && String(u).endsWith("/api/share/check")) { once = true; window.sagebrush.notebook.store.load = () => Promise.reject(new Error("disk")); } return f(u, o); }; })()`);
      const f9 = await shareNow("D9b");
      await ev("delete window.sagebrush.notebook.store.load");
      await restore();
      ok(/couldn't be read/.test(f9) && (await ev("window.__attempts.length")) === 0 && (await mine()) === n, `D9b the store unreadable just before the share request: it isn't sent, no share made: ${f9}`);
      await closeDialog();
    });

    // D2 (last: it crashes the page): the answer lost, the page crashed at once, then a reload (with another
    // writer's attempt merged by the awaited save, astra3's L1: the kept attempt is the one sent and kept)
    // (the crash chain says where it is, so a stall shows its step: #243's CI)
    const chainAt = (step) => console.log(`  (crash chain: ${step}, ${new Date().toISOString().slice(11, 19)}Z)`);
    // (a crash, then the site opened again in a new tab, as a person would after one: the crashed tab is closed,
    // so nothing of it lingers; a new tab whose first navigation doesn't commit within 20 s, or isn't ready within
    // 60 s (#243's CI: D8's Page.navigate unanswered while the browser answered), fails the case with Chrome's
    // targets said (type, path, attached: service workers included). No retry: a person reopening after a crash
    // would meet the same thing, so it must show)
    const crashAndReopen = async (P, what) => {
      // (read only, before the crash: whether a service worker controlled the old page, and in what state)
      const controller = await P.ev("JSON.stringify(navigator.serviceWorker?.controller ? [navigator.serviceWorker.controller.state, new URL(navigator.serviceWorker.controller.scriptURL).pathname] : null)", 3000).catch((x) => `unread: ${x.message}`);
      // (each step's time from the crash, and Chrome's processes (type, id, cpu seconds) at each step, read from the
      // browser itself: so a reopen that is slow says which step, and whether a renderer is missing or busy;
      // printed for every reopen, the processes when it fails or takes over 10 s. #243's CI: D2's reopen took
      // about 61 s on master afcb1b72, about 4 s before)
      // (after the crash, each process snapshot starts at its step and isn't awaited there, so the navigation's and
      // readiness's own deadlines run as before; all are drained once the outcome is known, before it is said.
      // The one before the crash is awaited, so it is truly before it; daybreak3)
      const marks = {}, procs = {}, pending = [], qt = {};
      let t0 = 0, Q = null, before = "unread", preNav = "unread";
      const mark = (step) => { marks[step] = Date.now() - t0; };
      const snap = (step) => raw("SystemInfo.getProcessInfo", {}, undefined, 5000).then((x) => (x?.processInfo ?? []).map((p) => [p.type, p.id, Math.round((p.cpuTime ?? 0) * 10) / 10]), (x) => `unread: ${x.message}`).then((v) => { procs[step] = v; }, (x) => { procs[step] = `unread: ${x?.message}`; });
      const snapAt = (step) => { pending.push(snap(step)); };
      const said = async (ok) => {
        await Promise.allSettled(pending);
        console.log(`  (${what}: reopen timing, ms from the crash: ${JSON.stringify(marks)}; the new page's own steps, ms from its start: ${JSON.stringify(qt)}; renderer before navigating: ${preNav})`);
        if (!ok || (marks.ready ?? marks.failed ?? 0) > 10_000) console.log(`  (${what}: Chrome's processes [type, id, cpu s] by step: ${JSON.stringify(procs)})`);
      };
      // (the crashed renderer must have exited before the site is opened again: a new same-site tab made while it is
      // still tearing down can have its first navigation hang, never sending a request (#243's CI, arms A-C: the
      // renderer outlived the 1 s wait below by about 0.7 s, and the one reopen that waited for it passed). Which
      // process is the page's renderer is read from Chrome itself, before the crash: a short trace of the
      // disabled-by-default devtools.timeline category, whose TracingStartedInBrowser (and FrameCommittedInBrowser,
      // ProcessReadyInBrowser) events give each frame's devtools token with its RenderProcessHost's OS pid
      // (content/browser/devtools/protocol/tracing_handler.cc, FillFrameData). The page's main frame is matched by its
      // exact id (Page.getFrameTree), never by url; exactly one positive pid must be named for it, and it must be a
      // renderer in a validated process list read before the crash; the frame is read again after the trace, and must
      // be the same. Anything else, or a trace not completed within its bounds, fails the case BEFORE the crash. After
      // the close, that exact pid must be observed absent from a validated process list (an unreadable one is unknown,
      // never absence) within 30 s of the crash, else the case fails before any new page. No other identification is
      // used. The trace itself is an observer change, said in the reports that use it)
      const listProcs = (ms) => raw("SystemInfo.getProcessInfo", {}, undefined, ms).then(validProcs, () => null);
      const frameIdOf = (X) => X.send("Page.getFrameTree", {}, 5000).then((x) => typeof x?.frameTree?.frame?.id === "string" && x.frameTree.frame.id ? x.frameTree.frame.id : null, () => null);
      const traceOnce = async (sid) => {
        // (one bounded trace: start; end; tracingComplete within 10 s, with dataLossOccurred exactly false; its stream
        // read to EOF within 20 s and 32 MiB of decoded bytes (counted per chunk, the last one too); the stream closed.
        // Every exit clears the timer and the listener and closes a stream it was given; a stop or close that isn't
        // confirmed sets tracingUncertain, which stops every later crash case. Every call is on sid (null: the browser
        // target), and a tracingComplete is taken only from that session; one from any other sets tracingUncertain)
        let timer = null, handle = null, started = false, stopped = false;
        try {
          const st = await raw("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: { includedCategories: ["disabled-by-default-devtools.timeline"] } }, sid ?? undefined, 5000).then((x) => JSON.stringify(x ?? null), (x) => `no answer: ${x.message}`);
          // (a start not confirmed exactly, a lost answer included, may have left a trace running: uncertain, so this
          // case and every later crash case stop, and the run's trace state isn't clean)
          if (st !== "{}") {
            const kind = st.startsWith("no answer: ") ? "no answer within its bound" : st.startsWith('{"code":') ? "a protocol error" : "an unexpected answer";
            tracingUncertain ??= `Tracing.start wasn't confirmed: ${kind}: ${st.slice(0, 200)}`;
            return { error: `Tracing.start wasn't confirmed: ${kind}: ${st.slice(0, 200)}` };
          }
          started = true;
          const complete = new Promise((ok) => {
            onTracingComplete = (params, from) => {
              if (from !== sid) { tracingUncertain ??= `a tracingComplete from ${from ? "a page session" : "the browser target"}, not the traced ${sid ? "page session" : "browser target"}`; return; }
              onTracingComplete = null; ok(params);
            };
            timer = setTimeout(() => { onTracingComplete = null; ok(null); }, 10_000);
          });
          const en = await raw("Tracing.end", {}, sid ?? undefined, 5000).then((x) => JSON.stringify(x ?? null), (x) => `no answer: ${x.message}`);
          const done = await complete;
          if (done && typeof done.stream === "string") handle = done.stream;
          if (en !== "{}") return { error: `Tracing.end answered ${en}` };
          if (!done) return { error: "no tracingComplete within 10 s" };
          stopped = true;
          if (done.dataLossOccurred !== false) return { error: `tracingComplete's dataLossOccurred is ${JSON.stringify(done.dataLossOccurred)}` };
          if (!handle) return { error: "tracingComplete without a stream" };
          const until = Date.now() + 20_000, cap = 32 * 1024 * 1024, parts = [];
          let bytes = 0, eof = false;
          while (!eof) {
            if (Date.now() >= until) return { error: "the trace wasn't read to its end within 20 s" };
            const r = await raw("IO.read", { handle, size: 1 << 20 }, sid ?? undefined, Math.max(1, until - Date.now())).catch(() => null);
            if (!r || typeof r.data !== "string") return { error: "IO.read failed" };
            const buf = r.base64Encoded ? Buffer.from(r.data, "base64") : Buffer.from(r.data, "utf8");
            bytes += buf.length;
            if (bytes > cap) return { error: `the trace is over ${cap} bytes` };
            parts.push(buf);
            eof = r.eof === true;
          }
          let parsed; try { parsed = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { return { error: "the trace isn't JSON" }; }
          const events = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.traceEvents) ? parsed.traceEvents : null;
          return events ? { events } : { error: "the trace has no event list" };
        } finally {
          if (timer) clearTimeout(timer);
          onTracingComplete = null;
          if (started && !stopped) tracingUncertain ??= "a trace's stop wasn't confirmed";
          if (handle) {
            const c = await raw("IO.close", { handle }, sid ?? undefined, 5000).then((x) => JSON.stringify(x ?? null), (x) => `no answer: ${x.message}`);
            if (c !== "{}") tracingUncertain ??= `a trace stream's IO.close answered ${c}`;
          }
        }
      };
      // (when a completed trace attributes nothing, what it held instead, said and never used: the event names by
      // count, the shapes (keys and value types, never values) of the frame events' data and of their frames, and how
      // many events' args mention the main frame's id at all, with those events' names. Bounded; it changes no
      // decision: #243's tracing r4, where Chrome 156 named no process for the main frame)
      const traceShape = (events, fid) => {
        try {
          const word = (x, re) => typeof x === "string" ? (re.test(x) ? x : "(other)") : `(${typeof x})`;
          const top = (m, k) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k).map(([x, c]) => `${x} x${c}`).join(", ");
          const keys = (o) => o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort().map((k) => `${word(k, /^[A-Za-z0-9_]{1,40}$/)}:${Array.isArray(o[k]) ? `array(${o[k].length})` : o[k] === null ? "null" : typeof o[k]}`).join(" ") : Array.isArray(o) ? `array(${o.length})` : o === undefined ? "none" : typeof o;
          const names = new Map(), cats = new Map(), mention = new Map(), shapes = [];
          for (const e of events) {
            const nm = word(e?.name, /^[A-Za-z0-9_.:-]{1,60}$/);
            names.set(nm, (names.get(nm) ?? 0) + 1);
            const ct = word(e?.cat, /^[A-Za-z0-9_.,:-]{1,80}$/);
            cats.set(ct, (cats.get(ct) ?? 0) + 1);
            if (e?.args !== undefined && JSON.stringify(e.args)?.includes(fid)) mention.set(nm, (mention.get(nm) ?? 0) + 1);
            if (shapes.length < 6 && (nm === "TracingStartedInBrowser" || nm === "FrameCommittedInBrowser" || nm === "ProcessReadyInBrowser")) {
              const d = e?.args?.data, fr = Array.isArray(d?.frames) ? d.frames[0] : undefined;
              shapes.push(`${nm}: data {${keys(d)}}${fr !== undefined ? `, frames[0] {${keys(fr)}}` : ""}`);
            }
          }
          const nMention = [...mention.values()].reduce((a, b) => a + b, 0);
          return `${events.length} events; names: ${top(names, 15)}; categories: ${top(cats, 6)}; frame events: ${shapes.join(" | ") || "none"}; events whose args mention the main frame id: ${nMention}${nMention ? ` (${top(mention, 6)})` : ""}`.slice(0, 1500);
        } catch (e) { return `unreadable (${String(e?.message ?? e).slice(0, 100)})`; }
      };
      if (tracingUncertain) throw new Error(`${what}: an earlier trace's cleanup wasn't confirmed (${tracingUncertain}), so no page is crashed`);
      const preCrash = await listProcs(5000);
      const fid = await frameIdOf(P);
      let attr = { error: "not attributed" }, traced = null;
      if (!preCrash) attr = { error: "the pre-crash process list was unreadable" };
      else if (!fid) attr = { error: "the page's main frame id couldn't be read" };
      else {
        const tr = await traceOnce(traceScope === "page" ? P.sessionId : null);
        if (tr.error) attr = tr;
        else if (traceScope === "browser") { traced = tr.events; attr = { error: "the browser target's trace is report-only (SHARE_TRACE_SCOPE=browser): it never attributes" }; }
        else {
          traced = tr.events;
          const pids = new Set(), seen = [];
          for (const e of tr.events) {
            const d = e?.args?.data;
            const frames = e?.name === "TracingStartedInBrowser" ? (Array.isArray(d?.frames) ? d.frames : []) : (e?.name === "FrameCommittedInBrowser" || e?.name === "ProcessReadyInBrowser") && d ? [d] : [];
            for (const fr of frames) if (fr?.frame === fid) { seen.push([e.name, fr.processId ?? null]); if (fr.processId !== undefined) pids.add(fr.processId); }
          }
          const [pid] = [...pids];
          if (pids.size !== 1) attr = { error: `${pids.size} process ids named for the main frame (events: ${JSON.stringify(seen).slice(0, 300)})` };
          else if (!Number.isInteger(pid) || pid <= 0) attr = { error: `the named process id isn't a positive integer (${JSON.stringify(pid)})` };
          else if (!preCrash.some((x) => x[0] === "renderer" && x[1] === pid)) attr = { error: `pid ${pid} isn't a renderer in the pre-crash process list` };
          else {
            const fid2 = await frameIdOf(P);
            attr = fid2 === fid ? { pid, events: seen.length } : { error: `the main frame changed during the trace (${fid} then ${fid2})` };
          }
        }
      }
      console.log(`  (${what}: the page's renderer, from Chrome's trace: ${attr.error ? `NOT ATTRIBUTED: ${attr.error}` : `pid ${attr.pid} (page session; main frame ${fid}, ${attr.events} frame events)`})`);
      if (attr.error && traced) console.log(`  (${what}: the trace's shape, report-only: ${traceShape(traced, fid)})`);
      if (!attr.error && tracingUncertain) attr = { error: tracingUncertain };
      if (attr.error) { await said(false); throw new Error(`${what}: the page's renderer couldn't be attributed (${attr.error}), so the page wasn't crashed`); }
      await snap("before the crash");
      chainAt(`${what}: the page crashes`);
      t0 = Date.now();
      void P.send("Page.crash").catch(() => {});
      mark("crash sent");
      await sleep(1000);
      mark("post-crash wait");
      await raw("Target.closeTarget", { targetId: P.targetId }, undefined, 10_000).catch(() => {});
      mark("closed");
      snapAt("closed");
      {
        const left = () => 30_000 - (Date.now() - t0);
        const pid = attr.pid;
        let gone = false;
        while (left() > 0) {
          const list = await listProcs(Math.max(1, Math.min(5000, left())));
          if (list && !list.some((x) => x[1] === pid)) { gone = true; break; }
          await sleep(Math.max(0, Math.min(100, left())));
        }
        mark(gone ? "crashed renderer exited" : "crashed renderer wait failed");
        console.log(`  (${what}: the crashed renderer, pid ${pid}: ${gone ? `observed absent ${marks["crashed renderer exited"]} ms after the crash` : "not observed absent within 30 s of the crash"})`);
        if (!gone) { await said(false); throw new Error(`${what}: the crashed renderer (pid ${pid}) wasn't observed to exit within 30 s, so the site wasn't opened again`); }
      }
      chainAt(`${what}: a new page`);
      try {
        Q = await newPage(undefined, qt);
        mark("new page");
        // (the new page as Chrome sees it before it is sent anywhere)
        before = await raw("Target.getTargetInfo", { targetId: Q.targetId }, undefined, 10_000).then((x) => x?.targetInfo, (x) => `unread: ${x.message}`);
        // (whether its about:blank renderer answers, within a strict 3 s. This probe can itself wake the renderer:
        // its start and end are marked, so a timeout here is decisive and a later pass is diagnostic only; daybreak3)
        mark("renderer probe started");
        preNav = await Q.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, 3000).then((x) => JSON.stringify(x?.result?.value ?? x), (x) => `no answer: ${x.message}`);
        mark("renderer probe ended");
        snapAt("new page");
        await Q.send("Page.navigate", { url: dev.site + "/" }, 20_000);
        mark("navigated");
        snapAt("navigated");
        await Q.until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
        mark("ready");
        await said(true);
        return Q;
      } catch (e) {
        mark("failed");
        snapAt("failed");
        await said(false);
        if (!Q) { console.log(`  (${what}: the new page couldn't be opened (${e.message}); the crashed page ${P.targetId})`); throw e; }
        // (which page is which: the crashed one, the new one, and every target by id and browser context; #243's
        // train-26 CI showed an unattached about:blank beside an attached "/", ids unsaid)
        const t = await raw("Target.getTargets", {}, undefined, 10_000).catch(() => null);
        const brief = (x) => x && typeof x === "object" ? [x.type, String(x.url).replace(dev.site, "").split(/[?#]/)[0], x.attached, x.targetId, x.browserContextId] : x;
        console.log(`  (${what}: the new page didn't load (${e.message}); the crashed page ${P.targetId}, the new ${Q.targetId}; Chrome's targets: ${JSON.stringify((t?.targetInfos ?? []).map(brief))})`);
        console.log(`  (${what}: the new page before its navigation: ${JSON.stringify(brief(before))}; the old page's service worker before the crash: ${controller})`);
        // (whether the new page's renderer answers at all, within a strict 3 s, so a hung renderer adds no hang)
        const alive = await Q.send("Runtime.evaluate", { expression: "location.origin + location.pathname + ' ' + document.readyState", returnByValue: true }, 3000).then((x) => JSON.stringify(x?.result?.value ?? x).replace(dev.site, ""), (x) => `no answer: ${x.message}`);
        console.log(`  (${what}: the new page's renderer: ${alive})`);
        // (the service workers' state at the stall: enabled only now, it reports every registration and version at
        // once, without having touched their lifecycle before)
        swVersions.clear();
        const sw = await Q.send("ServiceWorker.enable", {}, 3000).then(() => "enabled", (x) => `not enabled: ${x.message}`);
        await sleep(500);
        console.log(`  (${what}: service workers (${sw}): ${JSON.stringify([...swVersions.values()])})`);
        // (the local server's own record first, so node's probes below are not in it: what it holds open, and the
        // last requests it received with their answers; #243's CI)
        console.log(`  (${what}: the local server holds: ${JSON.stringify(dev.stats?.() ?? "no stats")})`);
        // (the local server, asked directly: whether it answers at all, so a stalled server tells itself apart from
        // the browser's connections; #243's CI)
        for (const path of ["/", "/api/share/me"]) {
          const t0 = Date.now();
          const r = await fetch(dev.site + path, { signal: AbortSignal.timeout(5000) }).then((x) => x.status, (x) => String(x?.name ?? x));
          console.log(`  (${what}: node's own GET ${path}: ${r} in ${Date.now() - t0} ms)`);
        }
        throw e;
      }
    };
    await block("D2", async () => {
    chainAt("D2 starts");
    await ev("document.querySelector('#filemenu [data-f=new]').click()");
    await until("document.querySelectorAll('.cell').length === 1 && !document.querySelector('.cell textarea').value && !window.sagebrush.notebook.snapshot().share_id");
    await setFirst(`T = 2  # D2 ${Date.now()}`);
    await sleep(700);
    const n2 = await ev("(async () => (await (await fetch('/api/share/mine')).json()).collections.length)()");
    await openDialog();
    await ev(`(() => { const f = window.fetch; window.__made = null; window.fetch = async (u, o) => {
      if (String(u).endsWith("/api/share/first-upload") && o?.method === "POST") { const r = await f(u, o); window.__made = { ...(await r.json()), sent: JSON.parse(o.body).attempt }; return new Promise(() => {}); }
      return f(u, o); }; })()`);
    {
      const D = "d".repeat(32);
      const sw = `(async () => { const id = localStorage.getItem('sagebrush-current'); const db = await new Promise((ok, no) => { const r = indexedDB.open('sagebrush'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); await new Promise((ok, no) => { const tx = db.transaction('notebooks', 'readwrite'), st = tx.objectStore('notebooks'); const g = st.get(id); g.onsuccess = () => st.put({ ...g.result, share_attempt: '${D}', rev: (g.result.rev ?? 0) + 1, updated: Date.now() }); tx.oncomplete = ok; tx.onerror = () => no(tx.error); }); db.close(); })()`;
      await ev(`window.sagebrush.shareTest.saved = async () => { await ${sw}; await window.sagebrush.notebook.saved(); }`);
    }
    await ev("document.querySelector('#sharetitlein').value = 'D2'; document.querySelector('#shareupload').click()");
    await until("!!window.__made", 60000);
    const made2 = await ev("window.__made");
    // (a crashed page never answers Page.crash: not awaited, or the run hangs, as run 3 did)
    const q = await crashAndReopen(p, "D2");
    const att2 = await q.ev("window.sagebrush.notebook.snapshot().share_attempt ?? null");
    await q.ev("document.querySelector('#sharemenu').click()");
    await q.until("document.querySelector('#sharedlg').open && !!window.sagebrush.share.selection && document.querySelectorAll('#sharelist .sharerow').length > 0", 60000);
    await q.until("/^(Checked|Found no|Stopped)/.test(document.querySelector('#sharestatus').textContent)", 60000).catch(() => {});
    await q.ev("document.querySelector('#sharetitlein').value = 'D2'; document.querySelector('#shareresult').textContent = ''; document.querySelector('#shareupload').click()");
    await q.until("document.querySelector('#shareresult a') || /failed/.test(document.querySelector('#shareresult').textContent)", 60000);
    const id2 = await q.ev("window.sagebrush.notebook.snapshot().share_id ?? null");
    const n2b = await q.ev("(async () => (await (await fetch('/api/share/mine')).json()).collections.length)()");
    ok(made2?.collection && made2.sent === "dddddddddddddddddddddddddddddddd" && att2 === "dddddddddddddddddddddddddddddddd" && id2 === made2.collection && n2b === n2 + 1, `D2 (sent ${made2?.sent?.slice(0, 6)}…, kept ${att2?.slice(0, 6)}…) the answer lost, the page crashed at once, a reload, the same upload: one share, the one the lost answer made (attempt kept: ${!!att2}, share ${id2} vs ${made2?.collection}, shares +${n2b - n2})`);
      chainAt("D8 starts");
      // D8 (astra3's r2 note 1), in the reloaded page: another device's attempt saved AFTER the final store read,
      // as the share request goes; the answer lost; a crash; a reload; the retry sends this device's recorded
      // attempt, so the share that request made is found, never a second one
      await q.ev("document.querySelector('#sharedlg').open && document.querySelector('#sharedlg').close()");
      await q.ev("document.querySelector('#filemenu [data-f=new]').click()");
      await q.until("document.querySelectorAll('.cell').length === 1 && !document.querySelector('.cell textarea').value && !window.sagebrush.notebook.snapshot().share_id");
      await q.ev(`(() => { const c = document.querySelector('.cell'); const ta = c.querySelector('textarea'); ta.value = 'T = 8  # D8 ${Date.now()}'; ta.dispatchEvent(new Event('input', {bubbles: true})); })()`);
      await sleep(700);
      const n8 = await q.ev("(async () => (await (await fetch('/api/share/mine')).json()).collections.length)()");
      const other = "f".repeat(32);
      await q.ev(`(() => { const f = window.fetch; window.__made = null; window.fetch = async (u, o) => {
        if (String(u).endsWith("/api/share/first-upload") && o?.method === "POST") {
          const id = localStorage.getItem('sagebrush-current');
          const db = await new Promise((ok, no) => { const r = indexedDB.open('sagebrush'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
          await new Promise((ok, no) => { const tx = db.transaction('notebooks', 'readwrite'), st = tx.objectStore('notebooks'); const g = st.get(id); g.onsuccess = () => st.put({ ...g.result, share_attempt: '${other}', rev: (g.result.rev ?? 0) + 1, updated: Date.now() }); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
          db.close();
          const r = await f(u, o); window.__made = { ...(await r.json()), sent: JSON.parse(o.body).attempt }; return new Promise(() => {});
        }
        return f(u, o); }; })()`);
      await q.ev("document.querySelector('#sharemenu').click()");
      await q.until("document.querySelector('#sharedlg').open && !!window.sagebrush.share.selection && document.querySelectorAll('#sharelist .sharerow').length > 0", 60000);
      await q.until("!window.sagebrush.share.analyzing && /^(Checked|Found no|Stopped|The notebook's interpreter didn't answer)/.test(document.querySelector('#sharestatus').textContent)", 60000).catch(() => {});
      await q.ev("document.querySelector('#sharetitlein').value = 'D8'; document.querySelector('#shareupload').click()");
      await q.until("!!window.__made", 60000);
      const made8 = await q.ev("window.__made");
      const q2 = await crashAndReopen(q, "D8");
      const stored8 = await q2.ev("window.sagebrush.notebook.snapshot().share_attempt ?? null");
      await q2.ev(`(() => { const f = window.fetch; window.__attempts = []; window.fetch = async (u, o) => { if (String(u).endsWith("/api/share/first-upload") && o?.method === "POST") window.__attempts.push(JSON.parse(o.body).attempt); return f(u, o); }; })()`);
      await q2.ev("document.querySelector('#sharemenu').click()");
      await q2.until("document.querySelector('#sharedlg').open && !!window.sagebrush.share.selection && document.querySelectorAll('#sharelist .sharerow').length > 0", 60000);
      await q2.until("!window.sagebrush.share.analyzing && /^(Checked|Found no|Stopped|The notebook's interpreter didn't answer)/.test(document.querySelector('#sharestatus').textContent)", 60000).catch(() => {});
      await q2.ev("document.querySelector('#sharetitlein').value = 'D8'; document.querySelector('#shareresult').textContent = ''; document.querySelector('#shareupload').click()");
      await q2.until("document.querySelector('#shareresult a') || /failed/.test(document.querySelector('#shareresult').textContent)", 60000);
      const id8 = await q2.ev("window.sagebrush.notebook.snapshot().share_id ?? null");
      const sent8 = await q2.ev("window.__attempts");
      const n8b = await q2.ev("(async () => (await (await fetch('/api/share/mine')).json()).collections.length)()");
      ok(made8?.collection && stored8 === other && sent8.length === 1 && sent8[0] === made8.sent && id8 === made8.collection && n8b === n8 + 1, `D8 another device's attempt saved as the share request went, the answer lost, a crash, a reload: the store held the other attempt (${stored8?.slice(0, 6)}…), yet the retry sent this device's recorded one (${sent8.map((x) => x.slice(0, 6)).join()} vs ${made8?.sent?.slice(0, 6)}), and found its share (${id8} vs ${made8?.collection}; shares +${n8b - n8})`);
      // (the crash chain goes on: a page's helpers)
      const nbIn = async (P, tag) => {
        await P.ev("document.querySelector('#sharedlg').open && document.querySelector('#sharedlg').close()");
        await P.ev("document.querySelector('#filemenu [data-f=new]').click()");
        await P.until("document.querySelectorAll('.cell').length === 1 && !document.querySelector('.cell textarea').value && !window.sagebrush.notebook.snapshot().share_id");
        await P.ev(`(() => { const ta = document.querySelector('.cell textarea'); ta.value = 'T = 1  # ${tag} ' + Date.now(); ta.dispatchEvent(new Event('input', {bubbles: true})); })()`);
        await sleep(700);
      };
      const openIn = async (P) => {
        await P.ev("document.querySelector('#sharemenu').click()");
        await P.until("document.querySelector('#sharedlg').open && !!window.sagebrush.share.selection && document.querySelectorAll('#sharelist .sharerow').length > 0", 60000);
        await P.until("!window.sagebrush.share.analyzing && /^(Checked|Found no|Stopped|The notebook's interpreter didn't answer)/.test(document.querySelector('#sharestatus').textContent)", 60000).catch(() => {});
      };
      const uploadIn = async (P, title) => {
        await P.ev(`document.querySelector('#sharetitlein').value = ${JSON.stringify(title)}; document.querySelector('#shareresult').textContent = ''; document.querySelector('#shareupload').click()`);
      };
      const sharesIn = (P) => P.ev("(async () => (await (await fetch('/api/share/mine')).json()).collections.length)()");
      const reopen = (P) => crashAndReopen(P, "reopen");
      const storeOther = (att) => `(async () => { const id = localStorage.getItem('sagebrush-current'); const db = await new Promise((ok, no) => { const r = indexedDB.open('sagebrush'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); await new Promise((ok, no) => { const tx = db.transaction('notebooks', 'readwrite'), st = tx.objectStore('notebooks'); const g = st.get(id); g.onsuccess = () => st.put({ ...g.result, share_attempt: '${att}', rev: (g.result.rev ?? 0) + 1, updated: Date.now() }); tx.oncomplete = ok; tx.onerror = () => no(tx.error); }); db.close(); })()`;
      const recordSentIn = (P) => P.ev(`(() => { const f = window.fetch; window.__attempts = []; window.fetch = async (u, o) => { if (String(u).endsWith("/api/share/first-upload") && o?.method === "POST") window.__attempts.push(JSON.parse(o.body).attempt); return f(u, o); }; })()`);

      chainAt("L1a starts");
      // L1a (astra3's and daybreak3's r3 note 1): the answer delivered (200), another device's attempt stored during
      // the request, then the share's save fails, a crash, a reload: the retry sends the recorded attempt: one share
      await nbIn(q2, "L1a");
      const nA = await sharesIn(q2);
      const otherA = "1".repeat(32);
      await q2.ev(`(() => { const f = window.fetch; window.__got = null; window.fetch = async (u, o) => {
        if (String(u).endsWith("/api/share/first-upload") && o?.method === "POST") {
          await ${storeOther(otherA)};
          const r = await f(u, o);
          window.__got = { ...(await r.clone().json()), sent: JSON.parse(o.body).attempt };
          // (from here on, nothing this page saves reaches the store)
          window.sagebrush.notebook.store.save = async () => "not saved: the test's store refuses";
          return r;
        }
        return f(u, o); }; })()`);
      await openIn(q2);
      await uploadIn(q2, "L1a");
      await q2.until("!!window.__got && (!!document.querySelector('#shareresult a') || /failed/.test(document.querySelector('#shareresult').textContent))", 60000);
      const gotA = await q2.ev("window.__got");
      // (this device's records, read in a fresh transaction)
      const recA = await q2.ev("(async () => JSON.stringify((await window.sagebrush.shareTest.sent?.()) ?? null))()");
      const q3 = await reopen(q2);
      const storedA = await q3.ev("window.sagebrush.notebook.snapshot()");
      await recordSentIn(q3);
      await openIn(q3);
      await uploadIn(q3, "L1a");
      await q3.until("document.querySelector('#shareresult a') || /failed/.test(document.querySelector('#shareresult').textContent)", 60000);
      const sentA = await q3.ev("window.__attempts");
      const idA = await q3.ev("window.sagebrush.notebook.snapshot().share_id ?? null");
      const nA2 = await sharesIn(q3);
      ok(gotA?.collection && recA.includes(gotA.sent) && !storedA.share_id && storedA.share_attempt === otherA && sentA.length === 1 && sentA[0] === gotA.sent && idA === gotA.collection && nA2 === nA + 1,
        `L1a a delivered 200 whose share couldn't be saved, another device's attempt stored meanwhile, a crash: the record was kept (${recA.includes(gotA?.sent ?? "?")}), the retry sent it (${sentA.map((x) => x.slice(0, 6))} vs ${gotA?.sent?.slice(0, 6)}) and found its share (${idA} vs ${gotA?.collection}); shares +${nA2 - nA}`);

      chainAt("L1b starts");
      // L1b: a 409 adoption, another device's attempt stored during that request, a crash before its save: the
      // retry recovers that share (without the other device's attempt, the notebook's own still names the first
      // share, so a page that dropped its record would pass too)
      await nbIn(q3, "L1b");
      const nB = await sharesIn(q3);
      const otherB = "2".repeat(32);
      // (the first request's answer is lost: the share is made, the page doesn't know)
      await q3.ev(`(() => { const f = window.fetch; window.__first = null; window.fetch = async (u, o) => {
        if (String(u).endsWith("/api/share/first-upload") && o?.method === "POST" && !window.__first) { const r = await f(u, o); window.__first = { ...(await r.json()), sent: JSON.parse(o.body).attempt }; return new Response('{"error":"lost"}', { status: 503 }); }
        if (String(u).endsWith("/api/share/first-upload") && o?.method === "POST") { await ${storeOther(otherB)}; const r = await f(u, o); if (r.status === 409) window.sagebrush.notebook.store.save = async () => "not saved: the test's store refuses"; window.__second = r.status; return r; }
        return f(u, o); }; })()`);
      await openIn(q3);
      await uploadIn(q3, "L1b");
      await q3.until("!!window.__first && /failed/.test(document.querySelector('#shareresult').textContent)", 60000);
      const firstB = await q3.ev("window.__first");
      // (the retry with another title: the receipt answers 409, naming the first share, adopted but not saved)
      await uploadIn(q3, "L1b, renamed");
      await q3.until("window.__second === 409 && /different files/.test(document.querySelector('#shareresult').textContent)", 60000).catch(() => {});
      const second = await q3.ev("window.__second ?? null");
      const q4 = await reopen(q3);
      const storedB = await q4.ev("window.sagebrush.notebook.snapshot()");
      await recordSentIn(q4);
      await openIn(q4);
      await uploadIn(q4, "L1b, renamed");
      await q4.until("document.querySelector('#shareresult a') || /failed/.test(document.querySelector('#shareresult').textContent)", 60000);
      const sentB = await q4.ev("window.__attempts");
      const idB = await q4.ev("window.sagebrush.notebook.snapshot().share_id ?? null");
      const nB2 = await sharesIn(q4);
      ok(firstB?.collection && second === 409 && storedB.share_attempt === otherB && !storedB.share_id && sentB.length === 1 && sentB[0] === firstB.sent && idB === firstB.collection && nB2 === nB + 1,
        `L1b a 409 adoption whose save didn't land, another device's attempt stored meanwhile (${storedB.share_attempt?.slice(0, 6)}), a crash: the retry sent the recorded attempt again (${sentB.map((x) => x.slice(0, 6))} vs ${firstB?.sent?.slice(0, 6)}) and the notebook's share is the first one (${idB} vs ${firstB?.collection}); shares +${nB2 - nB}`);

      // (this device's records, raw)
      const regIn = (P) => P.ev("(async () => JSON.stringify((await window.sagebrush.shareTest.sent()) ?? {}))()");
      chainAt("R3 starts");
      // R3 (daybreak3's CORR-UPLOAD-R4-3): a 200 whose share_id save the notebook's store refuses; the record's
      // settling held at its save, while the page switches notebooks and is held between them (no store
      // attached); released there: the record is kept, as only the origin's own store can prove the share saved.
      // R3b: the same with the store saving: settled from the origin's store, after the switch, the record goes.
      for (const refuse of [true, false]) {
        const tag = refuse ? "R3" : "R3b";
        await nbIn(q4, tag);
        await q4.ev(`(() => { const f = window.fetch, nb = window.sagebrush.notebook, st = nb.store, saved = nb.saved; window.__r3 = null; window.__fetch0 = f;
          window.fetch = async (u, o) => {
            if (String(u).endsWith("/api/share/first-upload") && o?.method === "POST") {
              const r = await f(u, o);
              window.__r3 = { ...(await r.clone().json()), sent: JSON.parse(o.body).attempt };
              if (${refuse}) st.save = async () => "not saved: the test's store refuses";
              // (the settling's save held until released)
              nb.saved = () => new Promise((go) => (window.__savedGo = go)).then(() => { nb.saved = saved; return saved(); });
              return r;
            }
            return f(u, o); }; })()`);
        await openIn(q4);
        await uploadIn(q4, tag);
        await q4.until("!!window.__r3 && !!document.querySelector('#shareresult a') && !!window.__savedGo", 60000);
        const r3 = await q4.ev("window.__r3");
        // (a switch, held with no notebook attached)
        await q4.ev("window.sagebrush.shareTest.beforeAttach = () => new Promise((go) => (window.__attachGo = go))");
        await q4.ev("document.querySelector('#sharedlg').open && document.querySelector('#sharedlg').close()");
        await q4.ev("document.querySelector('#filemenu [data-f=new]').click()");
        await q4.until("!!window.__attachGo && !window.sagebrush.notebook.store", 30000);
        await q4.ev("window.__savedGo()");
        await sleep(1500);
        const reg3 = await regIn(q4);
        await q4.ev("delete window.sagebrush.shareTest.beforeAttach; window.__attachGo()");
        await q4.until("!!window.sagebrush.notebook.store", 30000);
        await q4.ev("window.fetch = window.__fetch0 ?? window.fetch");
        ok(!!r3?.collection && (refuse ? reg3.includes(r3.sent) : !reg3.includes(r3.sent)),
          refuse
            ? `R3 the share's save refused, its settling released while the page had no notebook attached: the record is kept (${reg3.includes(r3?.sent ?? "?")}), with no proof from the notebook's own store`
            : `R3b the share saved, its settling released while the page had no notebook attached: the record goes (${!reg3.includes(r3?.sent ?? "?")}), proved by the notebook's own store`);
      }

      chainAt("R1 starts");
      // R1 (astra3's CORR-UPLOAD-IMPL-ASTRA-3, daybreak3's CORR-UPLOAD-R4-1): two tabs, two notebooks recording at
      // once: tab A held inside its record's change (its read of the notebooks' keys), tab B's record waits for it
      // (no request until A's is written); both sent, both answers lost: both records kept; A settled: B's kept
      const A = q4;
      await nbIn(A, "R1a");
      const B = await newPage();
      await B.send("Page.navigate", { url: dev.site + "/" });
      await B.until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
      await nbIn(B, "R1b");
      const lose = `(() => { const f = window.fetch; window.__f0 = f; window.__lost = null; window.__sentN = 0; window.__pass = false;
        window.fetch = async (u, o) => {
          if (String(u).endsWith("/api/share/first-upload") && o?.method === "POST") {
            window.__sentN++;
            const r = await f(u, o);
            if (window.__pass) return r;
            window.__lost = { ...(await r.json()), sent: JSON.parse(o.body).attempt };
            return new Response('{"error":"lost"}', { status: 503 });
          }
          return f(u, o); }; })()`;
      await A.ev(lose);
      await B.ev(lose);
      await openIn(A);
      await openIn(B);
      // (A's read of the notebooks' keys held: its transaction completes, so nobody else's waits for it (a
      // transaction kept open held B's own notebook saves too, run 13), and only its completion is given to the
      // page once released)
      await A.ev(`(() => { const keys = IDBObjectStore.prototype.getAllKeys, tr = IDBDatabase.prototype.transaction; window.__hold = true; window.__held = 0; window.__heldQ = [];
        IDBObjectStore.prototype.getAllKeys = function (...a) { if (this.name === 'notebooks') this.transaction.__keys = true; return keys.apply(this, a); };
        IDBDatabase.prototype.transaction = function (...a) { const tx = tr.apply(this, a); Object.defineProperty(tx, 'oncomplete', { configurable: true, set(h) { tx.addEventListener('complete', (e) => { if (tx.__keys && window.__hold) { window.__held++; window.__heldQ.push(() => h.call(tx, e)); } else h.call(tx, e); }); } }); return tx; }; })()`);
      await uploadIn(A, "R1a");
      await A.until("window.__held > 0", 60000);
      await uploadIn(B, "R1b");
      // (until B has reached its record while A is held: waiting for the lock, or, with no lock, past its record
      // and sending; a fixed wait let B arrive only after A was released, run 12's control)
      const bLockWait = "(async () => ((await navigator.locks?.query?.())?.pending ?? []).some((l) => l.name === 'sagebrush-share-sent'))()";
      await B.until(`(async () => window.__sentN > 0 || (await ${bLockWait}))()`, 60000).catch(() => {});
      const bWhileHeld = await B.ev("window.__sentN");
      const bWaited = await B.ev(bLockWait);
      await A.ev("window.__hold = false; for (const f of window.__heldQ.splice(0)) f()");
      await A.until("!!window.__lost && /failed/.test(document.querySelector('#shareresult').textContent)", 60000);
      await B.until("!!window.__lost && /failed/.test(document.querySelector('#shareresult').textContent)", 60000);
      const la = await A.ev("window.__lost"), lb = await B.ev("window.__lost");
      const both = await regIn(A);
      // (A's retry, answered: settled; B's record stays)
      await A.ev("window.__pass = true");
      await uploadIn(A, "R1a");
      await A.until("!!document.querySelector('#shareresult a') || /failed/.test(document.querySelector('#shareresult').textContent)", 60000);
      await A.until(`(async () => !JSON.stringify((await window.sagebrush.shareTest.sent()) ?? {}).includes(${JSON.stringify(la?.sent ?? "?")}))()`, 15000).catch(() => {});
      const afterA = await regIn(A);
      ok(bWaited && bWhileHeld === 0 && !!la?.sent && !!lb?.sent && la.sent !== lb.sent && both.includes(la.sent) && both.includes(lb.sent),
        `R1 two tabs, two notebooks, recorded at once: B reached its record while A was held, waiting for the lock (${bWaited}), and sent nothing then (${bWhileHeld}); both sent, both answers lost: both records kept (A ${both.includes(la?.sent ?? "?")}, B ${both.includes(lb?.sent ?? "?")})`);
      ok(!afterA.includes(la?.sent ?? "?") && afterA.includes(lb?.sent ?? "?"), `R1 ...A's retry answered and settled: A's record gone (${!afterA.includes(la?.sent ?? "?")}), B's kept (${afterA.includes(lb?.sent ?? "?")})`);
      await A.ev("window.fetch = window.__f0 ?? window.fetch");
      await raw("Target.closeTarget", { targetId: B.targetId });

      chainAt("R4 starts");
      // R4 (daybreak3's CORR-UPLOAD-R5-4): ONE notebook in two tabs of this browser, one account. A is held inside
      // its record's change, past its last store check; B, which looked for a record before A wrote one, stores
      // another attempt and reaches its record after A's: B must neither replace A's record nor send its attempt.
      // A's answer is then lost; A's retry sends A's attempt and recovers A's share: one share
      await nbIn(A, "R4");
      const idR4 = await A.ev("localStorage.getItem('sagebrush-current')");
      const B2 = await newPage();
      await B2.send("Page.navigate", { url: dev.site + "/" });
      await B2.until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
      const sameNb = (await B2.ev("localStorage.getItem('sagebrush-current')")) === idR4 && (await B2.ev("window.sagebrush.notebook.snapshot().cells.length > 0"));
      const nR4 = await sharesIn(A);
      const otherR4 = "e".repeat(32);
      await A.ev(lose);
      await B2.ev(lose);
      await openIn(A);
      await openIn(B2);
      // (B's save before its upload stores the other attempt, as another tab's edit would land: written, and said
      // on the notebooks' channel as a tab's save is, so A's page has it too; unsaid, A's retry stopped at
      // "changed elsewhere", run 15)
      const storeOtherSaid = (att) => `(async () => { const id = localStorage.getItem('sagebrush-current'); const db = await new Promise((ok, no) => { const r = indexedDB.open('sagebrush'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); let rec = null; await new Promise((ok, no) => { const tx = db.transaction('notebooks', 'readwrite'), st = tx.objectStore('notebooks'); const g = st.get(id); g.onsuccess = () => { rec = { ...g.result, share_attempt: '${att}', rev: (g.result.rev ?? 0) + 1, updated: Date.now() }; st.put(rec); }; tx.oncomplete = ok; tx.onerror = () => no(tx.error); }); db.close(); const ch = new BroadcastChannel('sagebrush-notebooks'); ch.postMessage({ from: 'other-tab', id, doc: rec }); ch.close(); })()`;
      await B2.ev(`window.sagebrush.shareTest.saved = async () => { await ${storeOtherSaid(otherR4)}; await window.sagebrush.notebook.saved(); }`);
      await A.ev("window.__hold = true; window.__held = 0; window.__heldQ = []");
      await uploadIn(A, "R4");
      await A.until("window.__held > 0", 60000);
      await uploadIn(B2, "R4");
      await B2.until(`(async () => window.__sentN > 0 || (await ${bLockWait}))()`, 60000).catch(() => {});
      const b2Waited = await B2.ev(bLockWait);
      await A.ev("window.__hold = false; for (const f of window.__heldQ.splice(0)) f()");
      await A.until("!!window.__lost && /failed/.test(document.querySelector('#shareresult').textContent)", 60000);
      await B2.until("/failed/.test(document.querySelector('#shareresult').textContent)", 60000).catch(() => {});
      const la4 = await A.ev("window.__lost");
      const b2Sent = await B2.ev("window.__sentN");
      const b2Said = await B2.ev("document.querySelector('#shareresult').textContent");
      const reg4 = await regIn(A);
      ok(sameNb && b2Waited && !!la4?.sent && la4.sent !== otherR4 && b2Sent === 0 && reg4.includes(la4.sent) && !reg4.includes(otherR4) && /another upload of this notebook/.test(b2Said),
        `R4 one notebook in two tabs: B, with another attempt, reached its record after A's (waited: ${b2Waited}, same notebook: ${sameNb}): it sent nothing (${b2Sent}) and A's record stands (A ${reg4.includes(la4?.sent ?? "?")}, B's ${reg4.includes(otherR4)}): ${b2Said}`);
      await B2.ev("delete window.sagebrush.shareTest.saved");
      await raw("Target.closeTarget", { targetId: B2.targetId });
      // (A's answer was lost: its retry sends A's attempt, as recorded, and gets A's share)
      await A.ev(`(() => { window.__pass = true; window.__r4 = []; const f = window.fetch; window.fetch = async (u, o) => { if (String(u).endsWith("/api/share/first-upload") && o?.method === "POST") window.__r4.push(JSON.parse(o.body).attempt); return f(u, o); }; })()`);
      await uploadIn(A, "R4");
      await A.until("!!document.querySelector('#shareresult a') || /failed/.test(document.querySelector('#shareresult').textContent)", 60000);
      const sent4 = await A.ev("window.__r4");
      const id4 = await A.ev("window.sagebrush.notebook.snapshot().share_id ?? null");
      const nR4b = await sharesIn(A);
      ok(sent4.length === 1 && sent4[0] === la4?.sent && id4 === la4?.collection && nR4b === nR4 + 1,
        `R4 ...A's retry sent A's attempt (${sent4.map((x) => x.slice(0, 6))} vs ${la4?.sent?.slice(0, 6)}) and recovered A's share (${id4} vs ${la4?.collection}); shares +${nR4b - nR4}`);
      await A.ev("window.fetch = window.__f0 ?? window.fetch");
    }, 900_000);
  }


  if (traceControl === "late-complete") bws.onmessage({ data: JSON.stringify({ method: "Tracing.tracingComplete", params: {} }) });
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  chrome.kill();
  await dev.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
// (a trace whose state isn't confirmed clean, latched at any time, after the last crash case too, fails this run:
// astra3's REOPEN-LANDING-A3-1)
if (tracingUncertain) { count++; failures++; console.log(`FAIL trace state: not confirmed clean: ${tracingUncertain}`); }
console.log(failures ? `${failures} failed (of ${count})` : `all ${count} passed`);
// (whether every trace this run took was confirmed stopped and closed, with nothing unasked-for: one exact line)
console.log(tracingUncertain ? `trace state: UNCERTAIN (scope ${traceScope}): ${tracingUncertain}` : `trace state: clean (scope ${traceScope})`);
process.exit(failures ? 1 : 0);
