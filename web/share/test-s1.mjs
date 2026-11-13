// ci: web-sync.2 order=60 chrome
// Public sharing, end to end (its acceptance test): an author, A, signed in, makes a notebook, publishes it, and a
// stranger, B, signed out, opens the link, runs it and copies it, in headless Chromium against the share API in
// Miniflare (web/share/serve-dev.mjs) and web/dist.  A, B and a third reader, C, are each a fresh browser context (a
// profile of its own: no storage, cookies or service worker shared).  The 8 steps:
//   1. A makes the notebook: a Python cell solving a 2x2 system with numpy, and a markdown cell;
//   2. A publishes (Share, Publish link): the link, /s/<id>, is shown and on A's clipboard within 5 s;
//   3. B opens the link: the title, the byline A typed and both cells are visible, nothing has run, and the first
//      paint is under 2 s;
//   4. B presses Run all: the output is A's, [0.8 1.4], under 15 s, run in the runner frame (an opaque origin, which
//      can't reach the page's storage);
//   5. B presses Copy to my workspace: the app opens B's copy at /<title>/<file>, B's file browser lists it, an edit
//      survives a reload; the share page, for C, is unchanged; A's notebook is untouched;
//   6. B opens the link again: Open my copy, the same copy, no second one;
//   7. A edits and presses Publish new version: the link shows the new version, /s/<id>@<first version> the old one, and A's
//      link is the same;
//   8. A deletes the share (Your shares): /s/<id> says it's gone, its files are 404, and B's copy is still B's.
// A check the page can't pass yet is listed in WAITING with the change it waits for: it runs and is reported, but
// doesn't fail the run; one that passes fails the run instead, so the change that makes it pass turns it on here.
//   bun web/build.ts && node web/share/test-s1.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDev } from "./serve-dev.mjs";
import { devtoolsPort } from "../test-port.mjs";

// (the checks waiting on a change not on master yet: the share page as a product page, its next step)
const WAITING = {};
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const TITLE = "S1 demo";
const PY = "import numpy as np; print(np.linalg.solve([[2,1],[1,3]],[3,5]))";
const MD = "## Two equations\n\nSolved with numpy.";
const MD2 = "## Two equations, second version\n\nSolved with numpy.";
const WANT = "[0.8 1.4]";
// (the byline A types: free text, any names or none, never taken from the account)
const BYLINE = "Ada Lovelace and Alan Turing";

const dev = await startDev({ sitePort: 0, filesPort: 0, limits: { [ACCOUNT]: { tier: "dev", storage_bytes: 1e8, max_file_bytes: 1e7, private_links: false } } });
const profile = mkdtempSync(join(tmpdir(), "sb-s1-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdpPort = await devtoolsPort(profile);
let version;
for (let i = 0; i < 300; i++) { try { version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); break; } catch { await sleep(100); } }
const bws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => (bws.onopen = r));
let n = 0;
const waiting = new Map();
// (each session's top-frame navigations, and the execution contexts and attached targets every session reports)
const navs = new Map();
const contexts = [];
const children = new Map();
bws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); return; }
  if (m.method === "Page.frameNavigated" && !m.params.frame.parentId) navs.get(m.sessionId)?.push(m.params.frame.url);
  else if (m.method === "Runtime.executionContextCreated") contexts.push({ ...m.params.context, sessionId: m.sessionId });
  else if (m.method === "Page.javascriptDialogOpening") raw("Page.handleJavaScriptDialog", { accept: true }, m.sessionId).catch(() => {});
  else if (m.method === "Target.attachedToTarget") {
    // (a frame or worker of a page, in a process of its own: its contexts are reported on its own session)
    const s = m.params.sessionId;
    children.set(s, m.params.targetInfo);
    raw("Runtime.enable", {}, s).catch(() => {});
    raw("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, s).catch(() => {});
    raw("Runtime.runIfWaitingForDebugger", {}, s).catch(() => {});
  }
};
const raw = (method, params = {}, sessionId, ms = 60_000) => new Promise((r, no) => {
  const id = ++n;
  const t = setTimeout(() => { if (waiting.delete(id)) no(new Error(`CDP ${method} didn't answer within ${ms / 1000} s`)); }, ms);
  waiting.set(id, (v) => { clearTimeout(t); r(v); });
  bws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
// A fresh profile (a browser context of its own) and its one page.
async function profilePage(name) {
  const { browserContextId } = await raw("Target.createBrowserContext");
  const { targetId } = await raw("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await raw("Target.attachToTarget", { targetId, flatten: true });
  navs.set(sessionId, []);
  const send = (method, params = {}, ms) => raw(method, params, sessionId, ms);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  // (headless: a clipboard write needs the page focused, and the permission)
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await raw("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: dev.site, browserContextId });
  const ev = async (expression, ms) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms); if (r.exceptionDetails) throw new Error(`${name}: ` + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error(`${name}: timeout: ` + expr); };
  const go = async (url) => { await send("Page.navigate", { url }); await sleep(300); await until("document.readyState === 'complete'"); };
  return { name, send, ev, until, go, sessionId, browserContextId, navs: navs.get(sessionId) };
}
let failures = 0, count = 0;
const ok = (c, msg) => { count++; console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
// (a waiting check: reported; a pass fails the run, so that the change that makes it pass takes it off WAITING)
const wait = (key, c, msg) => {
  count++;
  if (c) { failures++; console.log(`FAIL ${msg}: it passes now, so take "${key}" off WAITING (it waited on ${WAITING[key]})`); }
  else console.log(`wait ${msg} (waiting on ${WAITING[key]})`);
};
const J = JSON.stringify;
const step = (s) => console.log(`---- ${s}`);

// the app (A) and the share page (B, C)
const appReady = (p) => p.until("!!window.sagebrush?.notebook && !!document.querySelector('#sharemenu') && !document.body.classList.contains('opening') && document.querySelectorAll('.cell').length > 0", 90000);
const shareReady = (p) => p.until("!!window.shared && !!document.querySelector('#nb .cell')", 60000);
// (the share page's notebook, as shown: each cell's kind, its text and its output)
const shownCells = (p) => p.ev("[...document.querySelectorAll('#nb .cell')].map((c) => ({ text: c.querySelector('textarea')?.value ?? '', out: (c.querySelector('.out')?.textContent ?? '').trim(), shown: (c.querySelector('.mdout')?.textContent ?? '').trim() }))");
const meta = (p) => p.ev("document.querySelector('#meta')?.textContent ?? ''");
// (the reader's own files, from the share page: the copy's chunk, as the page loads it)
const mine = (p, path) => p.ev(`import(new URL("/sagebrush-share-copy.js", location.href).href).then((m) => m.openWorkspace()).then((w) => w.read(${J(path)})).then((r) => (r.content.cells ?? []).map((c) => c.code ?? c.source), () => null)`);
// (Copy to my workspace / Open my copy pressed: the notebook page it opened, ?nb=<ref>)
async function pressMine(p) {
  p.navs.length = 0;
  await p.ev("document.querySelector('#mine').click()");
  for (let i = 0; i < 300; i++) { const u = p.navs.find((x) => /^[^?]*\/\?(.*&)?nb=/.test(x)); if (u) return new URL(u).searchParams.get("nb"); await sleep(100); }
  return null;
}
async function publish(p, { again }) {
  await p.ev("(() => { document.querySelector('#sharedlg').open && document.querySelector('#sharedlg').close(); document.querySelector('#sharemenu').click(); return 1; })()");
  await p.until("document.querySelector('#sharedlg').open && !document.querySelector('#shareform').hidden && document.querySelectorAll('#sharelist .sharerow').length > 0 && !window.sagebrush.share.analyzing", 60000);
  const label = await p.ev("document.querySelector('#shareupload').textContent");
  ok(label === (again ? "Publish new version" : "Publish link"), `${p.name}: the Share dialog's button reads ${J(label)}`);
  // (the byline: empty for a new share; Publish new version starts with the latest version's, as A typed it)
  if (again) await p.until(`document.querySelector('#shareauthor').value === ${J(BYLINE)}`, 10000).catch(() => {});
  const was = await p.ev("document.querySelector('#shareauthor').value");
  ok(was === (again ? BYLINE : ""), `${p.name}: the Author(s) field starts ${again ? "with the byline A typed for the first version" : "empty"}: ${J(was)}`);
  if (!again) await p.ev(`(() => { document.querySelector('#sharetitlein').value = ${J(TITLE)}; const a = document.querySelector('#shareauthor'); a.value = ${J(BYLINE)}; a.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await p.ev("navigator.clipboard.writeText('(nothing yet)')");
  const t0 = Date.now();
  await p.ev("(() => { document.querySelector('#shareupload').click(); return 1; })()");
  await p.until("!!document.querySelector('#shareresult a') && /Link copied/.test(document.querySelector('#shareresult').textContent) || /failed/i.test(document.querySelector('#shareresult').textContent)", 60000);
  const ms = Date.now() - t0;
  const r = await p.ev("({ href: document.querySelector('#shareresult a')?.href ?? null, text: document.querySelector('#shareresult').textContent })");
  r.clip = await p.ev("navigator.clipboard.readText()");
  await p.ev("(() => { document.querySelector('#sharedlg').close(); return 1; })()");
  return { ...r, ms };
}

let A, B, C;
try {
  A = await profilePage("A");
  B = await profilePage("B");
  C = await profilePage("C");

  // ---- 1. A, signed in, makes the notebook
  step("1. A makes the notebook");
  await A.go(dev.site + "/");
  const signed = await A.ev(`fetch('/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'dev-token', account_id: '${ACCOUNT}' }) }).then((r) => r.status)`);
  ok(signed === 200, "A signs in (the dev server's stand-in for CoCalc)");
  await A.go(dev.site + "/");
  await appReady(A);
  // (a new notebook, File ▸ New: one empty code cell, never shared)
  await A.ev("(() => { document.querySelector('#filemenu [data-f=new]').click(); return 1; })()");
  await A.until("document.querySelectorAll('.cell').length === 1 && !document.querySelector('.cell textarea').value && !window.sagebrush.notebook.snapshot().share_id", 30000);
  const made = await A.ev(`(async () => { const nb = window.sagebrush.notebook; const first = nb.cells()[0].id; const r = await nb.applyEdits({ set: [{ id: first, code: ${J(PY)} }], insert: [{ type: "markdown", code: ${J(MD)} }] }); return { out: String(r.outputs?.[first] ?? "").trim(), cells: nb.snapshot().cells.map((c) => [c.type ?? "code", c.code]) }; })()`, 120_000);
  ok(made.out === WANT && J(made.cells) === J([["code", PY], ["markdown", MD]]), "A's notebook: the Python cell prints " + J(made.out) + ", then the markdown cell: " + J(made.cells));
  await sleep(1000);

  // ---- 2. A publishes
  step("2. A publishes: Share, Publish link");
  const p1 = await publish(A, { again: false });
  const link = p1.href;
  const id = link?.match(/\/s\/([a-z2-7]{12})$/)?.[1];
  ok(!!id && link === `${dev.site}/s/${id}`, "the link is /s/<id>: " + link);
  ok(p1.clip === link && /^Published\./.test(p1.text) && /Link copied/.test(p1.text), "it's shown, and on A's clipboard: " + J({ text: p1.text, clip: p1.clip }));
  ok(p1.ms < 5000, `...within 5 s (${p1.ms} ms, Publish link to the link shown and copied)`);
  const aCells = await A.ev("JSON.stringify(window.sagebrush.notebook.snapshot().cells.map((c) => [c.type ?? 'code', c.code]))");

  // ---- 3. B opens the link, signed out, in a fresh profile
  step("3. B opens the link");
  await B.go(link);
  await shareReady(B);
  const me = await B.ev("fetch('/api/share/me').then((r) => r.status)");
  ok(me === 401, "B isn't signed in (/api/share/me: " + me + ")");
  const b0 = await shownCells(B);
  ok((await B.ev("document.querySelector('#title').textContent")) === TITLE, "the title: " + J(await B.ev("document.querySelector('#title').textContent")));
  ok(b0.length === 2 && b0[0].text === PY && b0[1].text === MD && /Two equations/.test(b0[1].shown), "both cells, the Python and the markdown (shown): " + J(b0.map((c) => [c.text.slice(0, 30), c.shown.slice(0, 30)])));
  ok((await B.ev("document.querySelector('#meta .by')?.textContent")) === `by ${BYLINE}`, "the byline A typed, in the header: " + J(await meta(B)));
  // (nothing asked of the interpreter at all: the kernel's request ids start at 1, and each run or question takes one)
  const asked = await B.ev("window.shared.kernel.nextId - 1");
  ok(asked === 0 && /Nothing has run yet/.test(await B.ev("document.querySelector('#status').textContent")) && (await B.ev("!document.querySelector('#nb .cell.running, #nb .cell.queued')")), `nothing has run (${asked} requests to the interpreter): ` + J(await B.ev("document.querySelector('#status').textContent")));
  const frames0 = await B.ev("({ frames: document.querySelectorAll('iframe[sandbox]').length, worker: !!window.shared.kernel.worker })");
  // (the notebook's interpreter starts when it opens, one per page, as the talks' rows pin: at most its one frame)
  ok(frames0.frames <= 1, "at most the one runner frame before Run: " + J(frames0));
  const fcp = await B.ev("performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint')?.startTime ?? null");
  ok(typeof fcp === "number" && fcp < 2000, `first paint under 2 s: ${fcp === null ? "none" : Math.round(fcp) + " ms"}`);

  // ---- 4. B presses Run all
  step("4. B presses Run all");
  await B.ev("(() => { window.__ran = 0; window.shared.kernel.on('execute', () => window.__ran++); return 1; })()");
  const t4 = Date.now();
  await B.ev("(() => { document.querySelector('#runall').click(); return 1; })()");
  await B.until(`window.__ran >= 1 && !document.querySelector('#nb .cell.running, #nb .cell.queued') && (document.querySelector('#nb .cell .out')?.textContent ?? '').trim() === ${J(WANT)}`, 60000).catch(() => {});
  const ran = Date.now() - t4;
  const b4 = await shownCells(B);
  ok((await B.ev("window.__ran")) >= 1 && b4[0].out === WANT && b4[0].out === made.out, `B's run's output is A's, ${J(b4[0].out)}`);
  ok(ran < 15000, `...under 15 s (${ran} ms)`);
  const fr = await B.ev("(() => { const f = document.querySelectorAll('iframe[sandbox]'); const w = window.shared.kernel.worker; return { n: f.length, sandbox: f[0]?.getAttribute('sandbox') ?? null, src: f[0]?.src ?? null, ours: !!w && w.frame === f[0], fallback: !!w?.inner }; })()");
  ok(fr.n === 1 && fr.sandbox === "allow-scripts" && fr.ours && !fr.fallback, "it ran in the runner frame, <iframe sandbox=\"allow-scripts\">, with no fallback to a plain worker: " + J(fr));
  // (from inside the frame: its own default context, found by the frame it belongs to)
  const { result: el } = await B.send("Runtime.evaluate", { expression: "document.querySelector('iframe[sandbox]')" });
  await B.send("DOM.enable");
  const fid = (await B.send("DOM.describeNode", { objectId: el.objectId }))?.node?.frameId;
  let ctx = null;
  for (let i = 0; i < 50 && !ctx; i++) { ctx = contexts.find((c) => c.auxData?.frameId === fid && c.auxData?.isDefault); if (!ctx) await sleep(100); }
  const PROBE = "(() => { const t = (f) => { try { return f(); } catch { return 'refused'; } }; return { origin: self.origin, localStorage: t(() => typeof localStorage.length), indexedDB: t(() => (indexedDB.open('sb-s1-probe'), 'opened')), cookie: t(() => typeof document.cookie), page: t(() => typeof parent.document) }; })()";
  const inFrame = ctx ? (await raw("Runtime.evaluate", { expression: PROBE, contextId: ctx.id, returnByValue: true }, ctx.sessionId))?.result?.value : null;
  ok(!!inFrame && inFrame.origin === "null" && inFrame.localStorage === "refused" && inFrame.indexedDB === "refused" && inFrame.cookie === "refused" && inFrame.page === "refused", "the runner frame is an opaque origin: no storage, no cookies, no page: " + J(inFrame ?? { frame: fid ?? null, contexts: contexts.length }));

  // ---- 5. B presses Copy to my workspace
  step("5. B presses Copy to my workspace");
  const file = await B.ev("window.shared.c.manifest.files.find((f) => /\\.ipynb$/.test(f.path)).path");
  const at = `/${TITLE}/${file}`;
  ok((await B.ev("document.querySelector('#mine').textContent")) === "Copy to my workspace", "the button reads Copy to my workspace");
  const ref = await pressMine(B);
  ok(!!ref, "it opens the app on B's copy: /?nb=" + ref);
  await B.until("!!window.sagebrush?.workspace && !!document.querySelector('.cell textarea')", 90000);
  const st = await B.ev(`window.sagebrush.workspace.stat(${J(at)}).then((e) => e && { ref: e.ref })`);
  ok(st?.ref === ref, `...which is ${at} in B's files (${J(st)})`);
  await B.until(`(document.querySelector('.cell textarea')?.value ?? '') === ${J(PY)}`, 30000).catch(() => {});
  ok((await B.ev("document.querySelector('.cell textarea').value")) === PY, "...showing the notebook's code");
  // (B's file browser: the copy's folder, opened, lists it)
  await B.until("!!document.querySelector('#wsfilesbtn') && !document.querySelector('#wsfilesbtn').hidden", 60000);
  if (await B.ev("document.querySelector('#wssidebar').hidden")) await B.ev("(() => { document.querySelector('#wsfilesbtn').click(); return 1; })()");
  const row = (p) => `#wssidebar .frow[data-path=${J(p)}]`;
  await B.until(`!!document.querySelector(${J(row("/" + TITLE))})`, 30000).catch(() => {});
  await B.ev(`(() => { document.querySelector(${J(row("/" + TITLE))})?.click(); return 1; })()`);
  const listed = await B.until(`!!document.querySelector(${J(row(at))})`, 30000).then(() => true, () => false);
  ok(listed, `B's file browser lists ${at}`);
  // (editable: an edit, saved, survives a reload)
  await B.ev(`(() => { const ta = document.querySelector('.cell textarea'); ta.value = ${J(PY + "  # B's edit")}; ta.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await B.until(`window.sagebrush.workspace.read(${J(at)}).then((r) => (r.content.cells?.[0]?.code ?? '').endsWith("# B's edit"))`, 30000).catch(() => {});
  await B.go(`${dev.site}/?nb=${encodeURIComponent(ref)}`);
  await B.until("!!window.sagebrush?.workspace && !!document.querySelector('.cell textarea')", 90000);
  await B.until(`(document.querySelector('.cell textarea')?.value ?? '').endsWith("# B's edit")`, 30000).catch(() => {});
  ok((await B.ev("document.querySelector('.cell textarea').value")).endsWith("# B's edit"), "B's edit survives a reload");
  // (the share page, for a third fresh profile, unchanged)
  await C.go(link);
  await shareReady(C);
  const c5 = await shownCells(C);
  ok(c5.length === 2 && c5[0].text === PY && c5[1].text === MD && (await C.ev("document.querySelector('#mine').textContent")) === "Copy to my workspace" && (await C.ev("document.querySelector('#copyline').hidden")), "the share page, for a third fresh profile, is unchanged: " + J(c5.map((c) => c.text.slice(0, 40))));
  ok((await A.ev("JSON.stringify(window.sagebrush.notebook.snapshot().cells.map((c) => [c.type ?? 'code', c.code]))")) === aCells, "A's own notebook is untouched");

  // ---- 6. B opens the link again
  step("6. B opens the link again");
  await B.go(link);
  await shareReady(B);
  await B.until("document.querySelector('#mine').textContent === 'Open my copy'", 30000).catch(() => {});
  ok((await B.ev("document.querySelector('#mine').textContent")) === "Open my copy", "the button reads Open my copy");
  const ref6 = await pressMine(B);
  ok(ref6 === ref, `...and opens the same copy (${ref6})`);
  await B.until("!!window.sagebrush?.workspace", 90000);
  const second = await B.ev(`window.sagebrush.workspace.stat(${J(`/${TITLE}/${file.replace(/\.ipynb$/, " (2).ipynb")}`)}).then((e) => !!e)`);
  ok(second === false, "...with no second copy made");

  // ---- 7. A edits and publishes again
  step("7. A edits and presses Publish new version");
  const v1 = await C.ev("window.shared.c.version");
  await A.ev(`(async () => { const nb = window.sagebrush.notebook; const md = nb.cells()[1].id; await nb.applyEdits({ set: [{ id: md, code: ${J(MD2)} }] }, { run: false }); return 1; })()`);
  await sleep(1000);
  const p2 = await publish(A, { again: true });
  ok(p2.href === link && /^Published version 2\./.test(p2.text), "A's link is unchanged: " + J({ href: p2.href, text: p2.text }));
  // (B, who has a copy, sees the new version as the book's version; C, with none, at once)
  await B.go(link);
  await shareReady(B);
  const v2 = await B.ev("window.shared.c.version");
  ok(v2 !== v1 && (await B.ev("window.shared.c.latest")) === v2 && (await meta(B)).includes(`Version ${v2.slice(0, 12)}`), `B's /s/<id> is the new version (${v1.slice(0, 12)} -> ${v2.slice(0, 12)})`);
  await B.ev("(() => { [...document.querySelectorAll('#copyline button')].find((b) => /book's version/.test(b.textContent))?.click(); return 1; })()");
  await B.until("/This is the book's version/.test(document.querySelector('#copyline').textContent)", 30000).catch(() => {});
  ok((await shownCells(B))[1]?.text === MD2, "...whose markdown is A's edit");
  await C.go(link);
  await shareReady(C);
  ok((await shownCells(C))[1]?.text === MD2, "...and so for a reader with no copy");
  await C.go(`${link}@${v1}`);
  await shareReady(C);
  const old = await shownCells(C);
  ok(old[1]?.text === MD && (await C.ev("window.shared.c.version")) === v1 && /A newer version exists/.test(await meta(C)), `/s/<id>@<first version> still shows the old one, and says a newer one exists`);

  // ---- 8. A deletes the share
  step("8. A deletes the share (Your shares)");
  const f0 = await C.ev("(() => { const c = window.shared.c; const f = c.manifest.files[0]; return new URL(`/c/${c.id}/${f.sha256}`, c.files_origin).href; })()");
  ok((await fetch(f0)).status === 200, "(before: its file is served, " + f0.replace(/^https?:\/\/[^/]+/, "") + ")");
  await A.ev("(() => { document.querySelector('#filemenu [data-f=\"mine\"]').click(); return 1; })()");
  await A.until(`!!document.querySelector('#sbminedlg .row[data-id="${id}"]')`, 30000);
  const press = (label) => A.ev(`(() => { const b = [...document.querySelector('#sbminedlg .row[data-id="${id}"]').querySelectorAll('button')].find((x) => x.textContent === ${J(label)}); b.click(); return 1; })()`);
  await press("Delete");
  await A.until(`/^Delete “/.test(document.querySelector('#sbminedlg .row[data-id="${id}"]')?.textContent ?? '')`, 10000);
  await press("Delete");
  await A.until(`!document.querySelector('#sbminedlg .row[data-id="${id}"]')`, 30000);
  ok(true, "A deletes it from Your shares");
  await B.go(link);
  await B.until("/doesn't exist|deleted/.test(document.querySelector('#status')?.textContent ?? '')", 30000).catch(() => {});
  ok((await B.ev("document.querySelector('#status').textContent")) === "This collection doesn't exist, or its owner deleted it.", "/s/<id> says it's gone: " + J(await B.ev("document.querySelector('#status').textContent")));
  const gone = await fetch(f0);
  const apiGone = (await fetch(`${dev.site}/api/share/c/${id}`)).status;
  ok(gone.status === 404 && apiGone === 404, `its files are 404 (${gone.status}), and so is the collection (${apiGone})`);
  const kept = await mine(B, at);
  ok(Array.isArray(kept) && kept[0]?.endsWith("# B's edit"), "B's copy remains B's, with B's edit");
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
  for (const p of [A, B, C].filter(Boolean)) console.log(`  ${p.name}:`, await p.ev("location.href + ' | ' + (document.querySelector('#status')?.textContent ?? '')").catch((x) => x.message));
} finally {
  chrome.kill();
  await dev.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `${failures} of ${count} failed` : `${count - Object.keys(WAITING).length} passed, ${Object.keys(WAITING).length} waiting`);
process.exit(failures ? 1 : 0);
