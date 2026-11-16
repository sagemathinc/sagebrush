// ci: web-sync.2 order=58 chrome
// A share deleted by its owner, then shared again (the share's own record answers 404): end to end in headless
// Chromium against the share API in Miniflare (web/share/serve-dev.mjs) and web/dist.
//   1. a notebook published, its share deleted: Publish again says so (board's line), makes no new share, and lets the
//      dead link go (the button reads Publish link again); the next press makes a new link;
//   2. the same for a folder: Upload says so, the folder's record goes, the next Upload makes new links;
//   3. a 404 that isn't a deletion: the share is another account's (signed in as another): the link is kept; and the
//      share's record not read (a 503, or no answer): never taken for a deletion either;
//   4. races (the share's record read held): another tab binds the notebook (on the page, or in its store alone), or
//      the folder, to a newer share before the answer comes: the newer one is kept.
//   bun web/build.ts && node web/share/test-share-gone.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDev } from "./serve-dev.mjs";
import { devtoolsPort } from "../test-port.mjs";

const A = "55555555-5555-4555-8555-555555555555", B = "66666666-6666-4666-8666-666666666666";
// (ports 0: startDev's servers take the system's choice and hold it, web/share/serve-dev.mjs)
const dev = await startDev({ sitePort: 0, filesPort: 0, limits: { [A]: { tier: "dev", storage_bytes: 1e8, max_file_bytes: 1e7, private_links: false }, [B]: { tier: "dev", storage_bytes: 1e8, max_file_bytes: 1e7, private_links: false } } });
const profile = mkdtempSync(join(tmpdir(), "sb-gone-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
let route = null;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } if (m.method === "Fetch.requestPaused") void (route ? route(m.params) : send("Fetch.continueRequest", { requestId: m.params.requestId })); };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const J = JSON.stringify;
const W = "window.sagebrush.workspace";
// (the folder's share record: the page's own workspace, as its test seam gives it; an agent's view has no such verb)
const shareOf = (fid) => ev(`window.sagebrush.shareTest.workspace().then((w) => w.folderShare(${J(fid)}))`);
const HEX32 = "0123456789abcdef0123456789abcdef"; // (a made-up key)
const nb = (name, code) => `{ name: ${J(name)}, mode: "python", cells: [{ id: "c1", type: "code", code: ${J(code)} }] }`;
const bytes = (s) => `new TextEncoder().encode(${J(s)})`;
const make = (p, content) => ev(`${W}.create(${J(p)}, { content: ${content} }).then((e) => e.path)`);
// (a row's ⋯ in the Files sidebar, then a menu item by its label: the items offered)
const menuOf = async (path) => {
  await ev(`(() => { const b = document.querySelector('#wsfilesbtn'); if (b.getAttribute('aria-pressed') !== 'true') b.click(); return 1; })()`);
  const row = `document.querySelector('.frow[data-path=' + JSON.stringify(${J(path)}) + ']')`;
  await until(`!!${row}`);
  await ev(`(() => { document.querySelectorAll('.sbfmenu').forEach((m) => m.remove()); ${row}.querySelector('.more').click(); return 1; })()`);
  await until("!!document.querySelector('.sbfmenu')");
  return ev("[...document.querySelectorAll('.sbfmenu button')].map((b) => b.textContent)");
};
const shareFolder = async (path) => {
  const items = await menuOf(path);
  await ev("[...document.querySelectorAll('.sbfmenu button')].find((b) => b.textContent === 'Share folder…').click()");
  await until("document.querySelector('#sbfolderdlg')?.open");
  return items;
};
const ready = () => until("(() => { const d = document.querySelector('#sbfolderdlg'); return !!d && !/^Checking|^Listing/.test(d.querySelector('[role=status]').textContent); })()", 60000);
const rows = () => ev("[...document.querySelectorAll('#sbfolderdlg .row input')].map((i) => [i.dataset.rel, i.checked])");
const upload = async () => {
  await ev("(() => { document.querySelector('#sbfolderdlg .links').textContent = ''; [...document.querySelectorAll('#sbfolderdlg button')].find((b) => b.textContent === 'Upload').click(); return 1; })()");
  await until("!!document.querySelector('#sbfolderdlg .links a, #sbfolderdlg .links p')", 60000);
  return ev("({ url: document.querySelector('#sbfolderdlg .links a')?.href ?? null, chapters: [...document.querySelectorAll('#sbfolderdlg .links .chapter a')].map((a) => [a.textContent, a.href]), notes: [...document.querySelectorAll('#sbfolderdlg .links p')].map((p) => p.textContent), progress: document.querySelector('#sbfolderdlg .note:not([role])') && [...document.querySelectorAll('#sbfolderdlg span.note')].map((s) => s.textContent).join('') })");
};
const closeDlg = () => ev("(() => { document.querySelector('#sbfolderdlg')?.close(); return 1; })()");
const mine = () => ev("fetch('/api/share/mine').then((r) => r.json()).then((j) => (j.collections ?? []).map((c) => c.id))");
const manifest = (id) => ev(`fetch('/api/share/c/${id}').then((r) => r.json()).then((j) => j.manifest.files.map((f) => f.path))`);
const idOf = (url) => new URL(url).pathname.split("/").pop();

const NOTEBOOK_GONE = "This notebook's link was deleted. Publish link makes a new one, at a new address.";
const FOLDER_GONE = "This folder's links were deleted. Upload makes new ones, at new addresses.";
const signIn = (who) => ev(`fetch('/auth/dev', { method: 'POST', headers: {'content-type': 'application/json'}, body: ${J(J({ token: "dev-token", account_id: "WHO" }))}.replace("WHO", ${J(who)}) }).then((r) => r.status)`);
const del = (id) => ev(`fetch('/api/share/collections/${id}', { method: 'DELETE', credentials: 'same-origin' }).then((r) => r.status)`);
const shareId = () => ev("window.sagebrush.notebook.snapshot().share_id ?? null");
// (the notebook's Share dialog: opened, ready to publish; then its button pressed, and what it says once done)
const openShare = async () => {
  await ev("(() => { const d = document.querySelector('#sharedlg'); if (d.open) d.close(); document.querySelector('#sharemenu').click(); return 1; })()");
  await until("!document.querySelector('#shareform').hidden && !document.querySelector('#shareupload').disabled && !/^Finding|^Checking/.test(document.querySelector('#sharestatus').textContent)", 60000)
    .catch(async (e) => { throw new Error(e.message + " | " + J(await ev("({ form: document.querySelector('#shareform').hidden, signin: document.querySelector('#sharesignin').hidden, status: document.querySelector('#sharestatus').textContent, checking: document.querySelector('#sharechecking').textContent, disabled: document.querySelector('#shareupload').disabled })"))); });
};
const publish = async () => {
  await ev("(() => { document.querySelector('#shareresult').textContent = ''; document.querySelector('#shareupload').click(); return 1; })()");
  await until("!document.querySelector('#shareupload').classList.contains('busy') && document.querySelector('#shareresult').textContent !== ''", 60000);
  return ev("({ text: document.querySelector('#shareresult').textContent, link: document.querySelector('#shareresult a')?.href ?? null, label: document.querySelector('#shareupload').textContent })");
};
const folderUploadText = async () => {
  await ev("(() => { document.querySelector('#sbfolderdlg .links').textContent = ''; [...document.querySelectorAll('#sbfolderdlg button')].find((b) => b.textContent === 'Upload').click(); return 1; })()");
  await until("!!document.querySelector('#sbfolderdlg .links a, #sbfolderdlg .links p')", 60000);
  return ev("({ url: document.querySelector('#sbfolderdlg .links a')?.href ?? null, notes: [...document.querySelectorAll('#sbfolderdlg .links p')].map((p) => p.textContent) })");
};
// (the share's own record, GET /api/share/c/<id>, held until released: the answer the page waits for to call it gone)
const held = [];
// (`pass` reads go through first: the folder dialog reads its share's last files before uploading)
const holdRecords = async (pass = 0) => {
  route = async (p) => (/\/api\/share\/c\/[a-z2-7]{12}/.test(p.request.url) && p.request.method === "GET" && pass-- <= 0 ? held.push(p) : send("Fetch.continueRequest", { requestId: p.requestId }));
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/share/c/*", requestStage: "Request" }] });
};
const release = async () => { route = null; for (const p of held.splice(0)) await send("Fetch.continueRequest", { requestId: p.requestId }); await send("Fetch.disable"); };

try {
  await send("Page.navigate", { url: dev.site + "/" });
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 90000);
  await until(`!!${W}`, 60000);
  ok((await signIn(A)) === 200, "(A signs in: dev)");
  await ev("document.querySelector('#filemenu [data-f=new]').click()");
  await until("document.querySelectorAll('.cell').length === 1");

  // ---- 1. a notebook's share deleted, then Publish again
  await openShare();
  const p1 = await publish();
  ok(/\/s\/[a-z2-7]{12}$/.test(p1.link ?? ""), "(published: " + p1.link + ")");
  const id1 = idOf(p1.link);
  await until(`(window.sagebrush.notebook.snapshot().share_id ?? null) === ${J(id1)}`);
  ok((await del(id1)) === 200, "(A deletes it through the API)");
  const before = (await mine()).length;
  await openShare();
  await until("!!document.querySelector('#sharecard:not([hidden]) #sharecardlink')", 10000);
  ok((await ev("!!document.querySelector('#sharecard:not([hidden]) #sharecardlink')")) && /^Publish (new )?version/.test(await ev("document.querySelector('#shareupload').textContent")), "(the dialog still shows the dead link, and offers a new version)");
  const g = await publish();
  ok(g.text === NOTEBOOK_GONE, "Publish new version on a deleted share: board's line, the whole status (" + J(g.text) + ")");
  ok((await shareId()) === null && g.label === "Publish link", "…the dead link let go: the button reads Publish link");
  ok((await mine()).length === before, "…and no new share made on that press");
  const p2 = await publish();
  ok(/\/s\/[a-z2-7]{12}$/.test(p2.link ?? "") && idOf(p2.link) !== id1 && (await mine()).length === before + 1, "the next press makes a new link, at a new address: " + p2.link);
  const id2 = idOf(p2.link);
  await until(`(window.sagebrush.notebook.snapshot().share_id ?? null) === ${J(id2)}`);

  // ---- 4a. the race: another tab binds the notebook to a newer share before the record's answer comes
  ok((await del(id2)) === 200, "(deleted again)");
  await openShare();
  await holdRecords();
  await ev("(() => { document.querySelector('#shareresult').textContent = ''; document.querySelector('#shareupload').click(); return 1; })()");
  for (let i = 0; i < 600 && !held.length; i++) await sleep(100);
  ok(held.length >= 1, "(the share's record read, held)");
  await ev("(window.sagebrush.notebook.setMeta({ share_id: 'newerlinkabc' }), true)");
  await sleep(500);
  await release();
  await until("!document.querySelector('#shareupload').classList.contains('busy') && document.querySelector('#shareresult').textContent !== ''", 60000);
  ok((await shareId()) === "newerlinkabc", "a newer link, bound meanwhile (another tab): kept (" + J(await shareId()) + ")");
  await ev("(window.sagebrush.notebook.setMeta({ share_id: null }), true)");

  // ---- 4c. the race, in the store alone: another tab's newer link lands in the notebook's stored record (not yet on
  // this page) before the record's answer comes: the stored link is kept (grader's N2)
  await openShare();
  const pn = await publish();
  const idn = idOf(pn.link);
  await until(`(window.sagebrush.notebook.snapshot().share_id ?? null) === ${J(idn)}`);
  ok((await del(idn)) === 200, "(deleted)");
  const storeKind = await ev("(() => { const st = window.sagebrush.notebook.store; return st && st.db && st.id ? 'idb' : (st?.constructor?.name ?? 'none'); })()");
  ok(storeKind === "idb", "(the notebook's store is this browser's database: " + storeKind + ")");
  await openShare();
  await holdRecords();
  await ev("(() => { document.querySelector('#shareresult').textContent = ''; document.querySelector('#shareupload').click(); return 1; })()");
  for (let i = 0; i < 600 && !held.length; i++) await sleep(100);
  ok(held.length >= 1, "(the share's record read, held)");
  const storeSet = (v) => `(() => { const st = window.sagebrush.notebook.store; return new Promise((res, rej) => { const tx = st.db.transaction("notebooks", "readwrite"), os = tx.objectStore("notebooks"), g = os.get(st.id); g.onsuccess = () => { const d = g.result; ${v === undefined ? "" : `d.share_id = ${J(v)}; os.put(d);`} tx.result = d?.share_id ?? null; }; tx.oncomplete = () => res(tx.result); tx.onerror = () => rej(tx.error); }); })()`;
  await ev(storeSet("storenewerab"));
  ok((await shareId()) === idn, "(the page still holds the dead link; only the store has the newer one)");
  await release();
  await until("!document.querySelector('#shareupload').classList.contains('busy') && document.querySelector('#shareresult').textContent !== ''", 60000);
  await sleep(500);
  ok((await ev(storeSet(undefined))) === "storenewerab", "a newer link in the store alone (another tab's, not yet on this page): kept (" + J(await ev(storeSet(undefined))) + ")");
  await send("Page.reload");
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 90000);
  await ev("(window.sagebrush.notebook.setMeta({ share_id: null }), true)");
  await until("(window.sagebrush.notebook.snapshot().share_id ?? null) === null");

  // ---- 3a. the share's record not read (a 503, or no answer at all): never taken for a deletion
  for (const [how, answer] of [["a 503", (p) => send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 503, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from("{}").toString("base64") })],
                               ["no answer", (p) => send("Fetch.failRequest", { requestId: p.requestId, errorReason: "Failed" })]]) {
    await openShare();
    const pk = await publish();
    const idk = idOf(pk.link);
    await until(`(window.sagebrush.notebook.snapshot().share_id ?? null) === ${J(idk)}`);
    ok((await del(idk)) === 200, `(a share deleted, its record's read to get ${how})`);
    const nk = (await mine()).length;
    route = async (p) => (/\/api\/share\/c\/[a-z2-7]{12}/.test(p.request.url) && p.request.method === "GET" ? answer(p) : send("Fetch.continueRequest", { requestId: p.requestId }));
    await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/share/c/*", requestStage: "Request" }] });
    await openShare();
    const rk = await publish();
    route = null;
    await send("Fetch.disable");
    ok(rk.text !== NOTEBOOK_GONE && /^Publishing failed: /.test(rk.text), `the share's record read gets ${how}: Publish again fails as before, not as a deletion (` + J(rk.text) + ")");
    ok((await shareId()) === idk && (await mine()).length === nk, "…the notebook keeps its link, and no new share is made");
    await ev("(window.sagebrush.notebook.setMeta({ share_id: null }), true)");
  }

  // ---- 3. a 404 that isn't a deletion: the share is another account's
  await openShare();
  const p3 = await publish();
  const id3 = idOf(p3.link);
  await until(`(window.sagebrush.notebook.snapshot().share_id ?? null) === ${J(id3)}`);
  await ev("fetch('/auth/logout', { method: 'POST' }).then((r) => r.status)");
  ok((await signIn(B)) === 200, "(B signs in on the same page)");
  await openShare();
  const w3 = await publish();
  ok(w3.text !== NOTEBOOK_GONE && /^Publishing failed: /.test(w3.text), "another account's share: Publish again fails, not as a deletion (" + J(w3.text) + ")");
  ok((await shareId()) === id3, "…and the notebook keeps its link");
  await ev("fetch('/auth/logout', { method: 'POST' }).then((r) => r.status)");
  ok((await signIn(A)) === 200, "(A again)");
  await ev("(() => { document.querySelector('#sharedlg').close(); return 1; })()");

  // ---- 2. a folder's share deleted, then Upload
  await ev(`(async () => { await ${W}.mkdir("/F"); return 1; })()`);
  await make("/F/ch.ipynb", nb("ch", "print(1)"));
  const fid = await ev(`${W}.stat("/F").then((e) => e.fid)`);
  await shareFolder("/F");
  await ready();
  const f1 = await folderUploadText();
  const fs1 = idOf(f1.url);
  ok(J(await shareOf(fid)) === J({ share_id: fs1, share_attempt: null }), "(the folder shared: " + f1.url + ")");
  ok((await del(fs1)) === 200, "(its share deleted)");
  const fbefore = (await mine()).length;
  await closeDlg();
  await shareFolder("/F");
  await ready();
  const f2 = await folderUploadText();
  ok(f2.url === null && J(f2.notes) === J([FOLDER_GONE]), "Upload on a deleted folder share: board's line, the whole status (" + J(f2.notes) + ")");
  ok((await shareOf(fid)) === undefined && (await mine()).length === fbefore, "…the folder's record let go, no new share made");
  const f3 = await folderUploadText();
  ok(/\/s\/[a-z2-7]{12}$/.test(f3.url ?? "") && idOf(f3.url) !== fs1, "the next Upload makes new links: " + f3.url);
  const fs3 = idOf(f3.url);

  // ---- 4b. the folder's race: its record moved to a newer share before the answer comes
  ok((await del(fs3)) === 200, "(deleted again)");
  await closeDlg();
  await shareFolder("/F");
  await ready();
  await holdRecords(1);
  await ev("(() => { document.querySelector('#sbfolderdlg .links').textContent = ''; [...document.querySelectorAll('#sbfolderdlg button')].find((b) => b.textContent === 'Upload').click(); return 1; })()");
  for (let i = 0; i < 600 && !held.length; i++) await sleep(100);
  ok(held.length >= 1, "(the folder share's record read, held)");
  const moved = await ev(`window.sagebrush.shareTest.workspace().then((w) => w.setFolderShare(${J(fid)}, { share_id: ${J(fs3)}, share_attempt: null }, { share_id: "newerfolderx", share_attempt: null }))`);
  await release();
  await until("!!document.querySelector('#sbfolderdlg .links a, #sbfolderdlg .links p')", 60000);
  ok(moved === true && J(await shareOf(fid)) === J({ share_id: "newerfolderx", share_attempt: null }), "a newer folder share, bound meanwhile: kept (" + J(await shareOf(fid)) + ")");
} catch (e) {
  ok(false, "the test failed: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  await dev.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);
