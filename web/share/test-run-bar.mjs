// ci: web-sync.2 order=62 chrome
// No run gate (William, Nov 21 2026: "only ask for read/write approval if there's an actual read/write attempt"): where
// Sagebrush's sandbox doesn't start, a notebook runs anyway, in the page's own interpreter, and only a write it may not
// make is asked about, at the write, in a modal. In headless Chromium whose runner page (/runner/) never answers (a
// sandbox that didn't start), against the share API in Miniflare (web/share/serve-dev.mjs) and web/dist:
//   1. a new notebook (its file changes off) runs: Run all prints 42 and two; there's no run bar; nothing is granted;
//   2. a write into a folder it may not change is refused, and the prompt asks: a modal dialog (:modal, the notebook not
//      moved, the dialog itself focused, not a button), one plain sentence naming the file and the folder and saying to
//      run the cell again; "Allow in /sub", "Allow once", "Don't allow";
//   3. Tab and Shift+Tab keep the focus in it, never on the page behind; Esc closes it unanswered, nothing allowed;
//   4. asked again, a script's click on Allow does nothing; the person's press, once armed, allows /sub, and the cell
//      run again writes /sub/out.txt;
//   4b-4i. Allow once (the same run saves, nothing kept); Stop while it waits; a rename's second folder refused (nothing
//      moves); the permissions changed while it waits, and another notebook shown: refused, nothing written; a folder
//      taken away stays away in that interpreter, whatever is allowed or granted again before the next Run; an ask held
//      in delivery while a Stop comes, or while a folder elsewhere is granted and taken away again, is answered no when
//      it arrives (no prompt);
//   5. a write at the top of the workspace: the prompt offers File > Permissions… and Don't allow, never Allow;
//   5b. a delete and a new folder are said as what they are ("delete", "create the folder"), never "save";
//   and as Safari (its user agent, whose sandbox doesn't run here: no runner page answers):
//   6. a notebook runs, no run bar, and its write is asked about in the same modal;
//   and with the sandboxed runner working (Chromium's):
//   7. the same wait relayed by the runner's frame: an Allow lets the same run save; Don't allow refuses it in that run;
//   7b. there too, a folder taken away stays away in that interpreter (the same one, its variable kept);
//   7c-7d. an ask held in delivery while the permissions narrow, or while a folder elsewhere is granted and taken away
//      again, is answered no when it arrives (no prompt).
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
// (the sessions whose runner page never answers: a sandbox that didn't start)
const silent = new Set();
bws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Fetch.requestPaused" && silent.has(m.sessionId)) raw("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/html" }], body: Buffer.from("<!doctype html><p>silent").toString("base64") }, m.sessionId).catch(() => {});
});
const raw = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); bws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
async function profilePage(safari, init = "", { runner = true } = {}) {
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
  if (!runner) {
    silent.add(sessionId);
    await send("Fetch.enable", { patterns: [{ urlPattern: "*/runner/*" }] });
  }
  if (init) await send("Page.addScriptToEvaluateOnNewDocument", { source: init });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
  const go = async (url) => { await send("Page.navigate", { url }); await sleep(300); await until("document.readyState === 'complete'"); };
  // (a person's press and release, at the element's middle: a trusted click)
  // (a button the page shows only once it is idle, Run all after a run's done: waited for, a few seconds)
  const press = async (sel) => {
    await until(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && !!e.offsetParent; })()`, 10000).catch(() => {});
    const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.hidden || !e.offsetParent) return null; e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!r) throw new Error("no " + sel + " to press");
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  };
  const page = { send, ev, until, go, press, silent: !runner };
  // (the sandbox silenced from now on, in this same page and its storage)
  page.silence = async () => { silent.add(sessionId); await send("Fetch.enable", { patterns: [{ urlPattern: "*/runner/*" }] }); page.silent = true; };
  return page;
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
const state = (p) => p.ev("({ runbar: !!document.querySelector('#runbar'), prompt: !document.querySelector('#filesbar').hidden, modal: document.querySelector('#filesbar').matches(':modal'), text: document.querySelector('#fbtext').textContent, buttons: [...document.querySelectorAll('#filesbar .fbbtns button')].filter((b) => !b.hidden).map((b) => b.textContent), focus: document.activeElement?.id || document.activeElement?.tagName, files: window.sagebrush.permissions?.()?.files, outs: [...document.querySelectorAll('.cell')].map((c) => (c.querySelector('.out')?.textContent ?? '').trim()) })");
const outsAre = (want) => `JSON.stringify([...document.querySelectorAll('.cell')].map((c) => (c.querySelector('.out')?.textContent ?? '').trim())) === ${JSON.stringify(JSON.stringify(want))}`;
// (Run all until the cells show `want`: a run asked before the page gives a silent sandbox up is answered as not run
// (runner-worker.js's NOT_RUN); the next one runs in the page's own interpreter)
const ranAll = async (p, want, ms = 90000) => { const t = Date.now(); while (Date.now() - t < ms) { await p.press("#runall"); if (await p.until(outsAre(want), 10000).then(() => true, () => false)) return true; } return false; };
const setCode = (p, code) => p.ev(`(async () => { const nb = window.sagebrush.notebook; await nb.applyEdits({ set: [{ id: nb.cells()[0].id, code: ${JSON.stringify(code)} }] }, { run: false }); return 1; })()`);
const W = "window.sagebrush.workspace";
const key = (p, k, shift = false) => Promise.all(["keyDown", "keyUp"].map((type) => p.send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: k === "Tab" ? 9 : 27, modifiers: shift ? 8 : 0 })));
const promptOpen = (p) => p.until("!document.querySelector('#filesbar').hidden && document.querySelector('#filesbar').matches(':modal')", 30000).then(() => true, () => false);
const WRITE = "try:\n    open('/sub/out.txt', 'w').write('hi')\n    print('wrote')\nexcept PermissionError as e:\n    print('refused', type(e).__name__, e)";

// (SEC H1: `A` allowed, then taken away (another tab's change); a run's write to `B` waits and is allowed; while that
// same run sleeps, `A` is granted again outside the prompt: the run writes `B` but not `A`; only the next Run, a new
// interpreter, may write `A`. `kept`: where a narrowing keeps the interpreter (the runner's, with its shared epoch), the
// same one throughout (its generation, and a value it kept from before the narrowing); the page's own worker is
// restarted by it instead)
const grantsEdit = (P, fn) => P.ev(`(() => { const f = document.createElement('iframe'); document.body.append(f); const ls = f.contentWindow.localStorage; const r = JSON.parse(ls.getItem('sagebrush-grants')); const d = r.docs[window.sagebrush.notebook.snapshot().id ?? localStorage.getItem('sagebrush-current')]; d.write = (${fn})(d.write); ls.setItem('sagebrush-grants', JSON.stringify(r)); f.remove(); return JSON.stringify(d.write); })()`);
const countPrompts = (P) => P.ev("(() => { window.__opened = 0; const d = document.querySelector('#filesbar'); if (!d.__counted) { const o = d.showModal.bind(d); d.showModal = () => { window.__opened++; o(); }; d.__counted = true; } return 1; })()");
const genOf = (P) => P.ev("window.sagebrush.kernels.get(window.sagebrush.notebook.snapshot().id ?? localStorage.getItem('sagebrush-current'))?.generation?.() ?? null");
// (SEC H2: a change asked about, the ask held in delivery, while a permission that doesn't touch this interpreter's
// trees is granted and then taken away again (another tab): when the ask arrives it predates a permission change, so
// it is answered no: no prompt ever opens, the run is refused, nothing written)
async function heldAcrossUndo(P, path, label) {
  await setCode(P, `try:\n    open('${path}', 'w').write('hi')\n    print('wrote')\nexcept PermissionError as e:\n    print('refused', type(e).__name__)`);
  await countPrompts(P);
  await P.ev("(window.sagebrush.kernel.holdMessages(new Promise((r) => (window.__release = r))), 1)");
  await P.press("#runall");
  await sleep(2500);
  const granted = await grantsEdit(P, "(w) => [...w, '/unrelated']");
  const undone = await grantsEdit(P, "(w) => w.filter((t) => t !== '/unrelated')");
  await sleep(300);
  await P.ev("(window.__release(), 1)");
  await P.until("/refused|wrote|restarted/.test(document.querySelector('.cell .out')?.textContent ?? '')", 20000).catch(() => {});
  await sleep(500);
  const st = { ...(await state(P)), opened: await P.ev("window.__opened") };
  const wrote = await P.ev(`${W}.stat(${JSON.stringify(path)}).then((e) => !!e, () => false)`);
  ok(granted.includes('"/unrelated"') && !undone.includes('"/unrelated"') && st.opened === 0 && !st.prompt && /refused PermissionError/.test(st.outs[0]) && !wrote, `${label}. an ask held in delivery while an unrelated folder is granted and taken away again: on arrival answered no, no prompt ever opened, the run refused, nothing written: ` + J({ opened: st.opened, prompt: st.prompt, out: st.outs[0], wrote }));
}
async function revokedStaysAway(P, A, B, label, kept) {
  const q = JSON.stringify;
  await setCode(P, "import builtins\nbuiltins._sb_mark = 'same'\nprint('set')");
  await P.press("#runall");
  await P.until("/set/.test(document.querySelector('.cell .out')?.textContent ?? '')", 20000).catch(() => {});
  const g0 = await genOf(P);
  const revoked = await grantsEdit(P, `(w) => w.filter((t) => t !== ${q(A)})`);
  await sleep(300);
  const g1 = await genOf(P);
  await setCode(P, `import time\ntry:\n    open('${B}/b.txt', 'w').write('b')\n    print('b-wrote')\nexcept PermissionError:\n    print('b-refused')\ntime.sleep(4)\ntry:\n    open('${A}/revived.txt', 'w').write('a')\n    print('a-wrote')\nexcept PermissionError:\n    print('a-refused')\nimport builtins\nprint(getattr(builtins, '_sb_mark', 'gone'))`);
  await P.press("#runall");
  const asked = await promptOpen(P);
  const askText = (await state(P)).text;
  const g2 = await genOf(P);
  await sleep(700);
  await P.press("#fballow");
  await P.until(`${W}.stat(${q(B + "/b.txt")}).then((e) => !!e, () => false)`, 30000).catch(() => {});
  const regranted = await grantsEdit(P, `(w) => [...w, ${q(A)}]`);
  await P.until("/a-wrote|a-refused/.test(document.querySelector('.cell .out')?.textContent ?? '')", 20000).catch(() => {});
  if ((await state(P)).prompt) await key(P, "Escape");
  await sleep(300);
  const out = (await state(P)).outs[0];
  const revived = await P.ev(`${W}.stat(${q(A + "/revived.txt")}).then((e) => !!e, () => false)`);
  ok(asked && askText.includes(B) && !revoked.includes(q(A)) && regranted.includes(q(A)) && /b-wrote/.test(out) && /a-refused/.test(out) && (!kept || (/same/.test(out) && g0 === g1 && g1 === g2)) && !revived, `${label}. ${A} taken away, ${B} allowed while the run waits, ${A} granted again elsewhere: the same interpreter writes ${B}, not ${A}: ` + J({ askText, revoked, regranted, out, revived, gens: [g0, g1, g2] }));
  await setCode(P, `try:\n    open('${A}/after.txt', 'w').write('a')\n    print('a-wrote')\nexcept PermissionError:\n    print('a-refused')`);
  await P.press("#runall");
  const after = await P.until(`${W}.stat(${q(A + "/after.txt")}).then((e) => !!e, () => false)`, 30000).then(() => true, () => false);
  ok(after, `...and the next Run, a new interpreter, may write ${A}`);
}

try {
  // ---- 1. the sandbox silent: a notebook runs anyway
  const S = await profilePage(false, "", { runner: false });
  await S.go(dev.site + "/");
  await appReady(S);
  // (the folder it will write to, before its notebook's interpreter starts: an interpreter gets the files at its start)
  await S.ev(`${W}.create("/sub/keep.txt", { content: new TextEncoder().encode("k") }).then(() => 1)`);
  await S.ev(`${W}.create("/sub2/keep.txt", { content: new TextEncoder().encode("k") }).then(() => 1)`);
  for (const f of ["/once/k.txt", "/stopped/k.txt", "/rn1/keep.txt", "/rn2/k.txt", "/chg/k.txt", "/sw/k.txt", "/rr/k.txt", "/rv/k.txt"]) await S.ev(`${W}.create(${JSON.stringify(f)}, { content: new TextEncoder().encode("k") }).then(() => 1)`);
  await twoCells(S);
  const ran = await ranAll(S, ["42", "two"]);
  const s1 = await state(S);
  ok(ran && !s1.runbar && s1.files === false && !s1.prompt, "1. no run gate: a notebook whose file changes are off runs where the sandbox doesn't start (42, two), no run bar, nothing granted: " + J(s1));

  // ---- 2. a write it may not make: the run waits on it, and the prompt asks, in a modal (the write-wait design)
  await setCode(S, WRITE);
  const top0 = await S.ev("Math.round(window.sagebrush.notebook.cells()[0].ta.getBoundingClientRect().top)");
  await S.press("#runall");
  const open2 = await promptOpen(S);
  await sleep(500);
  const s2 = await state(S);
  const top1 = await S.ev("Math.round(window.sagebrush.notebook.cells()[0].ta.getBoundingClientRect().top)");
  ok(open2 && s2.modal && s2.outs[0] === "" && !(await S.ev(`${W}.stat("/sub/out.txt").then((e) => !!e, () => false)`)), "2. the write waits, nothing written, nothing printed yet, and a modal asks: " + J({ modal: s2.modal, out: s2.outs[0] }));
  ok(s2.text === "This notebook is trying to save out.txt in /sub in this browser's Sagebrush workspace." && J(s2.buttons) === J(["Don't allow", "Allow once", "Allow in /sub"]), "...one plain sentence naming the file and the folder (no running again: the run goes on), and its three answers: " + J({ text: s2.text, buttons: s2.buttons }));
  ok(s2.focus === "filesbar" && top1 === top0, "...the dialog itself focused (an Enter answers nothing), the notebook not moved: " + J({ focus: s2.focus, top0, top1 }));

  // ---- 3. the focus stays in it; Esc: not allowed, and the same run is refused at once
  const seen = [];
  for (const shift of [true, true, true, false, false, false, false, false]) { await key(S, "Tab", shift); seen.push(await S.ev("(() => { const a = document.activeElement; return a === document.body || a === null ? 'body' : document.querySelector('#filesbar').contains(a) ? 'dialog:' + (a.id || a.tagName) : 'behind:' + (a.id || a.tagName); })()")); }
  ok(!seen.some((w) => w.startsWith("behind:")) && seen.some((w) => w === "dialog:fballow"), "3. Tab and Shift+Tab keep the focus in the dialog: " + J(seen));
  await key(S, "Escape");
  await S.until("/refused/.test(document.querySelector('.cell .out')?.textContent ?? '')", 15000).catch(() => {});
  const s3 = await state(S);
  ok(!s3.prompt && s3.outs[0].startsWith("refused PermissionError") && (await S.ev("window.sagebrush.permissions().grants.write.stored.length + window.sagebrush.permissions().grants.write.once.length")) === 0 && !(await S.ev(`${W}.stat("/sub/out.txt").then((e) => !!e, () => false)`)), "...Esc: nothing allowed, and that same run's write is refused (PermissionError), nothing written: " + J({ prompt: s3.prompt, out: s3.outs[0] }));

  // ---- 4. asked again: a script's click allows nothing; the person's press, once armed, allows /sub, and the SAME run
  //      saves it, with no second run
  await S.press("#runall");
  await promptOpen(S);
  await sleep(700);
  await S.ev("(document.querySelector('#fballow').click(), 1)");
  await sleep(300);
  const s4a = await state(S);
  ok(s4a.prompt && s4a.outs[0] === "" && !/\/sub/.test(await S.ev("JSON.stringify(window.sagebrush.permissions().grants.write)")), "4. a script's click on Allow allows nothing; the prompt still asks, the run still waits");
  await S.press("#fballow");
  const saved = await S.until(`${W}.stat("/sub/out.txt").then((e) => !!e, () => false)`, 30000).then(() => true, () => false);
  await S.until("/wrote/.test(document.querySelector('.cell .out')?.textContent ?? '')", 10000).catch(() => {});
  const trees = await S.ev("JSON.stringify(window.sagebrush.permissions().grants.write)");
  ok(saved && /wrote/.test((await state(S)).outs[0]) && !(await state(S)).prompt && /"stored":\["\/sub"\]/.test(trees), "...the person's press, once armed, allows /sub (kept), and the same run saves /sub/out.txt: " + J({ out: (await state(S)).outs[0], trees }));

  // ---- 4b. Allow once: the same run saves; nothing kept
  await setCode(S, "try:\n    open('/once/a.txt', 'w').write('hi')\n    print('wrote')\nexcept PermissionError as e:\n    print('refused', type(e).__name__, e)");
  await S.press("#runall");
  await promptOpen(S);
  await sleep(700);
  await S.press("#fbonce");
  const onceSaved = await S.until(`${W}.stat("/once/a.txt").then((e) => !!e, () => false)`, 30000).then(() => true, () => false);
  const g4b = await S.ev("JSON.stringify(window.sagebrush.permissions().grants.write)");
  ok(onceSaved && !/"stored":\[[^\]]*\/once/.test(g4b), "4b. Allow once: the same run saves /once/a.txt, and nothing is kept for /once: " + g4b);

  // ---- 4c. Stop while the prompt waits: the run ends, nothing written; the prompt closes
  await setCode(S, "try:\n    open('/stopped/a.txt', 'w').write('hi')\n    print('wrote')\nexcept PermissionError as e:\n    print('refused', type(e).__name__, e)");
  await S.press("#runall");
  await promptOpen(S);
  await S.ev("(window.sagebrush.kernel.interrupt?.(), 1)");
  await sleep(1500);
  const s4c = await state(S);
  ok(!s4c.prompt && !/wrote/.test(s4c.outs[0]) && !(await S.ev(`${W}.stat("/stopped/a.txt").then((e) => !!e, () => false)`)), "4c. Stop while the prompt waits: the run ends, nothing written, the prompt closed: " + J({ prompt: s4c.prompt, out: s4c.outs[0] }));

  // ---- 4d. a rename across two folders: its first folder allowed, its second refused: nothing moves
  await setCode(S, "import os\ntry:\n    os.rename('/rn1/keep.txt', '/rn2/keep.txt')\n    print('moved')\nexcept PermissionError as e:\n    print('refused', type(e).__name__)");
  await S.press("#runall");
  await promptOpen(S);
  await sleep(700);
  const first = (await state(S)).text;
  await S.press("#fballow");
  await sleep(500);
  await promptOpen(S);
  const second = (await state(S)).text;
  await sleep(700);
  await S.press("#fbdeny");
  await S.until("/refused|moved/.test(document.querySelector('.cell .out')?.textContent ?? '')", 15000).catch(() => {});
  const rn = { out: (await state(S)).outs[0], src: await S.ev(`${W}.stat("/rn1/keep.txt").then((e) => !!e, () => false)`), dst: await S.ev(`${W}.stat("/rn2/keep.txt").then((e) => !!e, () => false)`) };
  ok(/rn1/.test(first) && /rn2/.test(second) && /refused PermissionError/.test(rn.out) && rn.src && !rn.dst, "4d. a rename's first folder allowed, its second refused: asked for each, refused, nothing moved: " + J({ first, second, ...rn }));

  // ---- 4e. the permissions changed while the run waits (another tab's, a storage event): the prompt closes, unanswered,
  //      and the run is refused (its request is over; a later press answers nothing)
  await setCode(S, "try:\n    open('/chg/a.txt', 'w').write('hi')\n    print('wrote')\nexcept PermissionError as e:\n    print('refused', type(e).__name__)");
  await S.press("#runall");
  await promptOpen(S);
  await S.ev("(() => { const f = document.createElement('iframe'); document.body.append(f); const ls = f.contentWindow.localStorage; ls.setItem('sagebrush-grants', JSON.stringify(JSON.parse(ls.getItem('sagebrush-grants') ?? '{}'), null, 1)); f.remove(); return 1; })()");
  await S.until("/refused|wrote/.test(document.querySelector('.cell .out')?.textContent ?? '')", 15000).catch(() => {});
  const s4e = await state(S);
  ok(!s4e.prompt && /refused PermissionError/.test(s4e.outs[0]) && !(await S.ev(`${W}.stat("/chg/a.txt").then((e) => !!e, () => false)`)), "4e. the permissions changed while the run waits: the prompt closes, the run is refused, nothing written: " + J({ prompt: s4e.prompt, out: s4e.outs[0] }));

  // ---- 4f. another notebook shown while the run waits: answered no; back in the first, its cell says it was refused
  await setCode(S, "try:\n    open('/sw/a.txt', 'w').write('hi')\n    print('wrote')\nexcept PermissionError as e:\n    print('refused', type(e).__name__)");
  const firstId = await S.ev("window.sagebrush.notebook.snapshot().id ?? localStorage.getItem('sagebrush-current')");
  await S.press("#runall");
  await promptOpen(S);
  await newNotebook(S);
  const gone = await S.ev("document.querySelector('#filesbar').hidden && !window.sagebrush.filesPrompt()");
  await S.ev(`window.sagebrush.open(${JSON.stringify(firstId)}).then(() => 1)`);
  await S.until(`(window.sagebrush.notebook.snapshot().id ?? localStorage.getItem('sagebrush-current')) === ${JSON.stringify(firstId)}`, 20000).catch(() => {});
  // (its interpreter isn't left waiting: the wait was answered no, so the next run goes at once)
  await setCode(S, "print('alive')");
  await S.press("#runall");
  const alive = await S.until("/alive/.test(document.querySelector('.cell .out')?.textContent ?? '')", 20000).then(() => true, () => false);
  ok(gone && alive && !(await S.ev(`${W}.stat("/sw/a.txt").then((e) => !!e, () => false)`)), "4f. another notebook shown while the run waits: the prompt goes, nothing written, and back there its interpreter runs the next cell at once (the wait was answered no): " + J({ gone, alive }));

  // ---- 4g. a folder taken away stays away in that interpreter (SEC H1)
  await revokedStaysAway(S, "/sub", "/rr", "4g", false);

  // ---- 4h. held in delivery, and a Stop before it arrives: answered no, no prompt, nothing written (SEC H2)
  await setCode(S, "try:\n    open('/rv/b.txt', 'w').write('hi')\n    print('wrote')\nexcept BaseException as e:\n    print('refused', type(e).__name__)");
  await countPrompts(S);
  await S.ev("(window.sagebrush.kernel.holdMessages(new Promise((r) => (window.__release = r))), 1)");
  await S.press("#runall");
  await sleep(2500);
  await S.ev("(window.sagebrush.kernel.interrupt(), 1)");
  await S.ev("(window.__release(), 1)");
  await S.until("/refused|wrote|Stopped|Interrupt/.test(document.querySelector('.cell .out')?.textContent ?? '')", 20000).catch(() => {});
  await sleep(500);
  const s4h = { ...(await state(S)), opened: await S.ev("window.__opened") };
  ok(s4h.opened === 0 && !s4h.prompt && !/wrote/.test(s4h.outs[0]) && !(await S.ev(`${W}.stat("/rv/b.txt").then((e) => !!e, () => false)`)), "4h. an ask held in delivery, a Stop before it arrives: no prompt ever opened, nothing written: " + J({ opened: s4h.opened, prompt: s4h.prompt, out: s4h.outs[0] }));

  // ---- 4i. held in delivery across a grant elsewhere and its undoing (SEC H2)
  await heldAcrossUndo(S, "/rv/c.txt", "4i");

  // ---- 5. a write at the top of the workspace: File > Permissions… and Don't allow, never Allow
  await setCode(S, "try:\n    open('/top.txt', 'w').write('hi')\n    print('wrote')\nexcept PermissionError as e:\n    print('refused', type(e).__name__, e)");
  await S.press("#runall");
  await promptOpen(S);
  const s5 = await state(S);
  ok(s5.text === "This notebook is trying to save top.txt at the top of your Sagebrush workspace. To allow that, use File > Permissions…" && J(s5.buttons) === J(["Don't allow", "File > Permissions…"]), "5. a write at the top: File > Permissions… and Don't allow, never Allow: " + J({ text: s5.text, buttons: s5.buttons }));
  await key(S, "Escape");
  await sleep(300);

  // ---- 5b. not a save: a delete and a new folder are said as what they are, never "save"
  const said = async (code) => { await setCode(S, code); await S.press("#runall"); await promptOpen(S); const t = (await state(S)).text; await key(S, "Escape"); await sleep(300); return t; };
  const del = await said("import os\ntry:\n    os.remove('/sub2/keep.txt')\nexcept PermissionError:\n    print('refused')");
  const mk = await said("import os\ntry:\n    os.mkdir('/sub2/new')\nexcept PermissionError:\n    print('refused')");
  ok(del === "This notebook is trying to delete keep.txt in /sub2 in this browser's Sagebrush workspace." && mk === "This notebook is trying to create the folder new in /sub2 in this browser's Sagebrush workspace.", "5b. a delete and a new folder are said as what they are: " + J({ del, mk }));

  // ---- 6. as Safari: runs, no run bar, its write asked about in the same modal
  const F = await profilePage(true, "", { runner: false });
  await F.go(dev.site + "/");
  await appReady(F);
  await F.ev(`${W}.create("/sub/keep.txt", { content: new TextEncoder().encode("k") }).then(() => 1)`);
  await twoCells(F);
  const ran6 = await ranAll(F, ["42", "two"]);
  await setCode(F, WRITE);
  await F.press("#runall");
  const open6 = await promptOpen(F);
  const s6 = await state(F);
  ok(ran6 && open6 && !s6.runbar && s6.files === false && /is trying to save out\.txt in \/sub/.test(s6.text), "6. as Safari: the notebook runs, no run bar, and its write is asked about in the modal: " + J({ ran6, text: s6.text }));

  // ---- 7. the sandboxed runner (Chromium's, working): the same wait, relayed by its frame (web/runner/index.html):
  //      the write waits, an Allow lets the same run save; another write, Don't allow: refused in that run
  const R = await profilePage(false, "", { runner: true });
  await R.go(dev.site + "/");
  await appReady(R);
  for (const f of ["/rsub/k.txt", "/rno/k.txt", "/rr2/k.txt", "/rv2/k.txt", "/rkeep/k.txt"]) await R.ev(`${W}.create(${JSON.stringify(f)}, { content: new TextEncoder().encode("k") }).then(() => 1)`);
  await twoCells(R);
  await setCode(R, "try:\n    open('/rsub/out.txt', 'w').write('hi')\n    print('wrote')\nexcept PermissionError as e:\n    print('refused', type(e).__name__)");
  await R.press("#runall");
  const open7 = await promptOpen(R);
  await sleep(700);
  const w7 = await R.ev("({ runner: !!window.sagebrush.kernel?.worker?.frame, out: document.querySelector('.cell .out')?.textContent ?? '' })");
  await R.press("#fballow");
  const saved7 = await R.until(`${W}.stat("/rsub/out.txt").then((e) => !!e, () => false)`, 30000).then(() => true, () => false);
  await R.until("/wrote/.test(document.querySelector('.cell .out')?.textContent ?? '')", 10000).catch(() => {});
  const s7 = await state(R);
  ok(open7 && w7.runner && w7.out.trim() === "" && saved7 && /wrote/.test(s7.outs[0]), "7. in the sandboxed runner: the write waits (nothing printed), an Allow lets the same run save /rsub/out.txt: " + J({ runner: w7.runner, out: s7.outs[0] }));
  await setCode(R, "try:\n    open('/rno/out.txt', 'w').write('hi')\n    print('wrote')\nexcept PermissionError as e:\n    print('refused', type(e).__name__)");
  await R.press("#runall");
  await promptOpen(R);
  await sleep(700);
  await R.press("#fbdeny");
  await R.until("/refused|wrote/.test(document.querySelector('.cell .out')?.textContent ?? '')", 15000).catch(() => {});
  const s7b = await state(R);
  ok(/refused PermissionError/.test(s7b.outs[0]) && !(await R.ev(`${W}.stat("/rno/out.txt").then((e) => !!e, () => false)`)), "...Don't allow: refused in that same run, nothing written: " + J(s7b.outs[0]));
  // (SEC H1 in the runner, where a narrowing keeps the same interpreter: /rkeep allowed in it first, so taking /rsub away
  // leaves it scoped, not off, which would end it)
  await setCode(R, "open('/rkeep/a.txt', 'w').write('k')\nprint('kept')");
  await R.press("#runall");
  await promptOpen(R);
  await sleep(700);
  await R.press("#fballow");
  await R.until("/kept/.test(document.querySelector('.cell .out')?.textContent ?? '')", 20000).catch(() => {});
  await revokedStaysAway(R, "/rsub", "/rr2", "7b", true);
  // (SEC H2 in the runner, where a narrowing keeps the interpreter and moves the epoch: an ask held in delivery while the
  // permissions narrow arrives asked under an epoch that's over: answered no, no prompt, nothing written)
  await setCode(R, "try:\n    open('/rv2/a.txt', 'w').write('hi')\n    print('wrote')\nexcept PermissionError as e:\n    print('refused', type(e).__name__)");
  await countPrompts(R);
  await R.ev("(window.sagebrush.kernel.holdMessages(new Promise((r) => (window.__release = r))), 1)");
  await R.press("#runall");
  await sleep(2500);
  const narrowed7c = await grantsEdit(R, "(w) => w.filter((t) => t !== '/rr2')");
  await sleep(300);
  await R.ev("(window.__release(), 1)");
  await R.until("/refused|wrote|restarted/.test(document.querySelector('.cell .out')?.textContent ?? '')", 20000).catch(() => {});
  await sleep(500);
  const s7c = { ...(await state(R)), opened: await R.ev("window.__opened") };
  ok(!/\/rr2"/.test(narrowed7c) && s7c.opened === 0 && !s7c.prompt && /refused PermissionError/.test(s7c.outs[0]) && !(await R.ev(`${W}.stat("/rv2/a.txt").then((e) => !!e, () => false)`)), "7c. in the runner, an ask held in delivery while the permissions narrow: on arrival answered no, no prompt ever opened, the same run refused, nothing written: " + J({ opened: s7c.opened, prompt: s7c.prompt, out: s7c.outs[0] }));
  // (7d: the same in the runner)
  await heldAcrossUndo(R, "/rv2/d.txt", "7d");
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
