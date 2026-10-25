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
bws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const raw = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); bws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
async function newPage(contextId) {
  const { targetId } = await raw("Target.createTarget", { url: "about:blank", ...(contextId ? { browserContextId: contextId } : {}) });
  const { sessionId } = await raw("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params = {}) => raw(method, params, sessionId);
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
  const key = async (k, modifiers = 0) => {
    const code = k === " " ? "Space" : k;
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, modifiers, windowsVirtualKeyCode: k === " " ? 32 : k === "Escape" ? 27 : 0 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, modifiers, windowsVirtualKeyCode: k === " " ? 32 : k === "Escape" ? 27 : 0 });
  };
  return { send, ev, until, key, targetId };
}
let failures = 0, count = 0;
const ok = (c, msg) => { count++; console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };

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
const checkedNames = async () => (await rows()).filter((r) => r.checked).map((r) => r.name);
const status = () => ev("document.querySelector('#sharestatus').textContent");
async function openDialog({ wait = true } = {}) {
  await ev("document.querySelector('#sharedlg').open && document.querySelector('#sharedlg').close()");
  const g = await ev("window.sagebrush.share.generation");
  await ev("document.querySelector('#sharemenu').click()");
  // (this open's own list: a new generation, its rows drawn)
  await until(`window.sagebrush.share.generation > ${g} && !!window.sagebrush.share.selection && document.querySelectorAll('#sharelist .sharerow').length > 0`);
  if (wait) await until("/^(Checked|Found no|Stopped)/.test(document.querySelector('#sharestatus').textContent)", 60000);
}
const closeDialog = () => ev("document.querySelector('#sharedlg').close()");
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
  return { id: c.id, files: v.manifest.files.map((f) => f.path).sort() };
};

try {
  await p.send("Page.navigate", { url: dev.site + "/" });
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
  await ev("document.querySelector('#filemenu [data-f=new]').click()");
  await until("document.querySelectorAll('.cell').length === 1 && !document.querySelector('.cell textarea').value");
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

  // ---- a pathological source: the dialog stays responsive, the fail-safe stops the analysis (§3)
  {
    await runFirst("open('deep.py', 'w').write('x = ' + '(' * 400000 + '1' + ')' * 400000 + '\\n')\nprint('deep')");
    await setFirst(CODE + "\nimport deep");
    await ev("(() => { const t = window.sagebrush.shareTest; t.failsafe = { silenceMs: 2000, sourceBytes: 1e9 }; t.terminated = 0; const real = () => new Worker('/sagebrush-share-deps.js'); t.createWorker = () => { const w = real(); const o = { onmessage: null, postMessage: (m) => w.postMessage(m), terminate: () => { t.terminated++; w.terminate(); } }; w.onmessage = (e) => o.onmessage?.(e); return o; }; })()");
    await openDialog({ wait: false });
    await sleep(500);
    const ms = await ev("(() => { const t0 = performance.now(); document.querySelector('#shareall').click(); document.querySelector('#sharenone').click(); return performance.now() - t0; })()");
    ok(ms < 100, `the dialog answers while the analysis parses (${ms.toFixed(1)} ms)`);
    await until("/^Stopped finding files/.test(document.querySelector('#sharestatus').textContent)", 30000);
    ok((await ev("window.sagebrush.shareTest.terminated")) === 1, "the fail-safe terminated the worker");
    ok(await ev("[...document.querySelectorAll('#sharelist .sharerow .why')].some((w) => w.textContent === 'not analyzed')"), "unchecked rows say 'not analyzed'");
    ok(!(await ev("document.querySelector('#shareupload').disabled")), "...and Upload still works");
    await ev("(() => { const t = window.sagebrush.shareTest; delete t.failsafe; delete t.createWorker; })()");
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
    })()`);
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
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  chrome.kill();
  await dev.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `${failures} failed (of ${count})` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
