// ci: web-sync.2 order=53 chrome
// Share folder… (book links B2, design r2), end to end in headless Chromium against the share API in Miniflare
// (web/share/serve-dev.mjs) and web/dist: a "Book" folder in the notebook page's files (three chapters, one in a
// sub-folder, a data file, a helper module, and a module with a key in it) shared from its ⋯ menu.
//   1. signed out, the dialog offers sign-in; only a folder's ⋯ has Share folder…;
//   2. the files are listed, ticked, except the one with a key: unticked, with why and where;
//   3. Upload: one collection, the ticked files at their paths in the folder (not the unticked one), a link per
//      chapter (?f=<path>), and the folder holds its share;
//   4. a chapter's link opens that chapter, and ch1 runs, reading its data;
//   5. a chapter renamed and the folder renamed: sharing again makes a new version at the same link (no new
//      collection), and the renamed chapter's old link is said;
//   6. a lost answer: the first upload of another folder makes its share but the answer never comes; the folder
//      keeps its attempt, and Upload again gets that same share back (no second collection).
//   bun web/build.ts && node web/share/test-share-folder.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDev } from "./serve-dev.mjs";
import { devtoolsPort } from "../test-port.mjs";

const A = "33333333-3333-4333-8333-333333333333";
// (ports 0: startDev's servers take the system's choice and hold it, web/share/serve-dev.mjs)
const dev = await startDev({ sitePort: 0, filesPort: 0, limits: { [A]: { tier: "dev", storage_bytes: 1e8, max_file_bytes: 1e7, private_links: false } } });
const profile = mkdtempSync(join(tmpdir(), "sb-folder-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
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

try {
  await send("Page.navigate", { url: dev.site + "/" });
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 90000);
  await until(`!!${W}`, 60000);
  await ev(`(async () => { for (const d of ["/Book", "/Book/data", "/Book/sub", "/Solo"]) await ${W}.mkdir(d); return 1; })()`);
  await make("/Book/ch1.ipynb", nb("ch1", "print(open('data/points.csv').read().strip().replace('\\n', ';'))"));
  await make("/Book/ch2.ipynb", nb("ch2", "print('chapter two')"));
  await make("/Book/sub/ch3.ipynb", nb("ch3", "print('chapter three')"));
  await make("/Book/data/points.csv", bytes("x,y\n1,2\n3,4\n"));
  await make("/Book/helper.py", bytes("X = 1\n"));
  await make("/Book/.env", bytes("FRED_API_KEY=see-your-account\n"));
  await make("/Book/qrpm_funcs.py", bytes(`import os\n\napi_key = '${HEX32}'\n`));
  await make("/Book/keys.ipynb", `{ name: "keys", mode: "python", cells: [{ id: "c1", type: "code", code: "print(1)" }, { id: "c2", type: "code", code: ${J("import os\ntoken = 'Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MGFi'")} }] }`);
  await make("/Solo/only.ipynb", nb("only", "print(1)"));
  await make("/notes.txt", bytes("a note\n"));
  const fid = await ev(`${W}.stat("/Book").then((e) => e.fid)`);
  ok(typeof fid === "string" && fid.length > 0, `(the folder has its id: ${fid})`);

  // ---- 1. signed out; the menu
  const fileItems = await menuOf("/notes.txt");
  ok(!fileItems.includes("Share folder…"), "a file's ⋯ has no Share folder…");
  const items = await shareFolder("/Book");
  ok(items.includes("Share folder…"), "a folder's ⋯ has Share folder…");
  await ready();
  ok(/Sign in with CoCalc/.test(await ev("document.querySelector('#sbfolderdlg [role=status]').textContent")) && (await ev("document.querySelector('#sbfolderdlg a.btn')?.getAttribute('href') ?? ''")).startsWith("/auth/login?return="), "signed out: the dialog offers sign-in");
  await closeDlg();
  ok((await ev(`fetch('/auth/dev', { method: 'POST', headers: {'content-type': 'application/json'}, body: ${J(J({ token: "dev-token", account_id: A }))} }).then((r) => r.status)`)) === 200, "(the author signs in: dev)");

  // ---- 2. the list
  await shareFolder("/Book");
  await ready();
  const listed = await rows();
  ok(J(listed) === J([[".env", false], ["ch1.ipynb", true], ["ch2.ipynb", true], ["data/points.csv", true], ["helper.py", true], ["keys.ipynb", false], ["qrpm_funcs.py", false], ["sub/ch3.ipynb", true]]), `every notebook and data file under the folder, ticked, but the .env, and the module and the notebook with a key (${J(listed)})`);
  const warns = await ev("[...document.querySelectorAll('#sbfolderdlg .warn')].map((w) => w.textContent)");
  ok(J(warns) === J(["looks like it contains an environment file (.env): .env", "looks like it contains a token: keys.ipynb, cell 2, line 2", "looks like it contains an API key: qrpm_funcs.py:3"]), `…which says why and where (${J(warns)})`);
  ok(/unticked/.test(await ev("document.querySelector('#sbfolderdlg [role=status]').textContent")), "…and the dialog says such files are unticked");
  ok((await ev("document.querySelector('#sbfolderdlg input[type=text]').value")) === "Book", "the title is the folder's name");

  // ---- 3. upload
  const before = (await mine()).length;
  const r1 = await upload();
  ok(/\/s\/[a-z2-7]{12}$/.test(r1.url ?? ""), `uploaded: ${r1.url} (${J(r1.notes)})`);
  const id = idOf(r1.url);
  ok((await mine()).length === before + 1, "one collection made");
  ok(J(await manifest(id)) === J(["ch1.ipynb", "ch2.ipynb", "data/points.csv", "helper.py", "sub/ch3.ipynb"]), `the ticked files at their paths in the folder, not the one with a key (${J(await manifest(id))})`);
  ok(J(r1.chapters) === J([["ch1.ipynb", `${r1.url}?f=ch1.ipynb`], ["ch2.ipynb", `${r1.url}?f=ch2.ipynb`], ["sub/ch3.ipynb", `${r1.url}?f=sub/ch3.ipynb`]]), `a link per chapter (${J(r1.chapters)})`);
  ok(r1.notes.some((t) => /Not uploaded \(unticked\): \.env, keys\.ipynb, qrpm_funcs\.py/.test(t)), "…and the unticked file is said");
  ok(await ev("[...document.querySelectorAll('#sbfolderdlg button')].some((b) => b.textContent === 'Copy all links')"), "Copy all links is offered");
  ok(J(await shareOf(fid)) === J({ share_id: id, share_attempt: null }), "the folder holds its share");
  // (the record changes only from what it is: compare-and-set; an agent's view of the workspace has no such verb)
  const cas = await ev(`window.sagebrush.shareTest.workspace().then(async (w) => [
    await w.setFolderShare(${J(fid)}, { share_id: "other", share_attempt: null }, { share_id: "evil", share_attempt: null }),
    await w.setFolderShare(${J(fid)}, undefined, { share_id: "evil", share_attempt: null }),
    await w.setFolderShare(${J(fid)}, { share_id: ${J(id)}, share_attempt: null }, { share_id: "x", share_attempt: "y" }).then(() => "written", (e) => "refused"),
    typeof window.sagebrush.workspace.setFolderShare, typeof window.sagebrush.workspace.folderShare])`);
  ok(J(cas) === J([false, false, "refused", "undefined", "undefined"]) && J(await shareOf(fid)) === J({ share_id: id, share_attempt: null }), `the folder's share changes only from what it holds, only to a share or an attempt, and not through an agent's view (${J(cas)})`);
  await closeDlg();

  // ---- 5. renames, then a new version at the same link (before 4, which leaves the page)
  await ev(`${W}.rename("/Book/ch2.ipynb", "/Book/ch2b.ipynb").then(() => 1)`);
  await ev(`${W}.rename("/Book", "/Book2").then(() => 1)`);
  ok((await ev(`${W}.stat("/Book2").then((e) => e.fid)`)) === fid, "(the renamed folder keeps its id)");
  await shareFolder("/Book2");
  await ready();
  const r2 = await upload();
  ok(r2.url === r1.url && (await mine()).length === before + 1, `sharing the renamed folder again: the same link, no new collection (${r2.url})`);
  ok(/new version/.test(r2.progress ?? ""), `…said to be a new version (${r2.progress})`);
  ok(J(await manifest(id)) === J(["ch1.ipynb", "ch2b.ipynb", "data/points.csv", "helper.py", "sub/ch3.ipynb"]), `…with the renamed chapter (${J(await manifest(id))})`);
  ok(r2.notes.some((t) => /no longer open them.*ch2\.ipynb/.test(t)), `…and the old chapter's link said (${J(r2.notes)})`);
  await closeDlg();

  // ---- 6. a lost answer
  const soloFid = await ev(`${W}.stat("/Solo").then((e) => e.fid)`);
  const had = await mine();
  await ev(`(() => { const real = window.fetch; window.fetch = async (u, o) => { const r = await real(u, o); if (String(u).includes('/api/share/first-upload')) { window.fetch = real; throw new TypeError('the answer was lost (test)'); } return r; }; return 1; })()`);
  await shareFolder("/Solo");
  await ready();
  const lost = await upload();
  const made = (await mine()).filter((x) => !had.includes(x));
  ok(lost.url === null && lost.notes.some((t) => /Not shared: the answer was lost/.test(t)) && made.length === 1, `the answer lost: said not shared, while the server made its share (${J(lost.notes)}, ${J(made)})`);
  const held = await shareOf(soloFid);
  ok(held?.share_id === null && /^[0-9a-f]{32}$/.test(held?.share_attempt ?? ""), `…the folder keeps its attempt (${J(held)})`);
  const again = await upload();
  ok(again.url && idOf(again.url) === made[0] && (await mine()).length === had.length + 1, `Upload again gets that same share back, no second one (${again.url})`);
  ok(J(await shareOf(soloFid)) === J({ share_id: made[0], share_attempt: null }), "…and the folder holds it");
  await closeDlg();

  // ---- 4. a chapter's link (signed out: a reader)
  await ev("fetch('/auth/logout', { method: 'POST' }).then((r) => r.status)");
  await send("Page.navigate", { url: `${r1.url}?f=sub/ch3.ipynb` });
  await until("!!document.querySelector('#nb .cell')", 60000);
  ok(/ch3\.ipynb$/.test(await ev("document.querySelector('#nbname').textContent")), `?f=sub/ch3.ipynb opens chapter 3 (${await ev("document.querySelector('#nbname').textContent")})`);
  await send("Page.navigate", { url: `${r1.url}?f=ch1.ipynb` });
  await until("!!document.querySelector('#nb .cell')", 60000);
  await ev("document.querySelector('#runall').click()");
  await until("(() => { const c = document.querySelector('#nb .cell'); return /\\[\\d+\\]/.test(c.querySelector('.n').textContent) && !c.classList.contains('running') && !c.classList.contains('queued'); })()", 90000);
  const out = await ev("document.querySelector('#nb .cell .out').textContent");
  ok(/x,y;1,2;3,4/.test(out), `ch1's link runs it, reading its data (${out.trim()})`);
} catch (e) {
  ok(false, "the test ran: " + String(e?.stack ?? e).slice(0, 500));
} finally {
  chrome.kill();
  await dev.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
