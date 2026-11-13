// ci: web-sync.2 order=57 chrome
// A talk's Share… (the LaTeX editor's File menu), end to end in headless Chromium against the share API in Miniflare
// (web/share/serve-dev.mjs) and web/dist: the page's talk host (index.html openTalkShare, through its test seam
// window.sagebrush.shareTalk, with a stand-in for the editor's { fid, path, data(), save() }) opens the Share folder
// dialog for the talk's folder.
//   1. a talk at the top of the files: board's line, nothing listed, nothing offered;
//   2. the talk's save failing, or its saved bytes not the text on screen: board's line, nothing listed or uploaded;
//   3. the talk's folder listed, ticked, with the scope line; Upload: one collection, the talk, its results and its
//      folder's files at their paths in the folder (not the parent's); a link per talk, the talk shared from first; the
//      folder holds its share;
//   4. the save failing at Upload: board's line, nothing uploaded, the share as it was;
//   5. the talks unticked (no notebook): nothing to upload.
//   bun web/build.ts && node web/share/test-share-talk-publish.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDev } from "./serve-dev.mjs";
import { devtoolsPort } from "../test-port.mjs";

const A = "44444444-4444-4444-8444-444444444444";
// (ports 0: startDev's servers take the system's choice and hold it, web/share/serve-dev.mjs)
const dev = await startDev({ sitePort: 0, filesPort: 0, limits: { [A]: { tier: "dev", storage_bytes: 1e8, max_file_bytes: 1e7, private_links: false } } });
const profile = mkdtempSync(join(tmpdir(), "sb-talkpub-"));
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

const TEX = "\\documentclass{beamer}\\begin{document}\\begin{frame}A\\end{frame}\\end{document}\n";
const TALK_TOP = "To share this talk, first move it, and the files it uses, into a folder: a talk is shared with its folder.";
const TALK_SAVE_FAILED = "Couldn't save the talk, so nothing was shared. Try again in a moment.";
const TALK_SCOPE = "A talk is shared with its folder: its code can read the folder's files. Untick any you don't want to publish.";
const statusText = () => ev("document.querySelector('#sbfolderdlg [role=status]')?.textContent ?? ''");
const hasUpload = () => ev("[...document.querySelectorAll('#sbfolderdlg button')].some((b) => b.textContent === 'Upload')");
// (the editor's side, stood in for: its fid and path, the text on screen, and its save, which window.__talk steers)
const shareTalk = async (path, fid) => {
  await closeDlg();
  await ev(`(() => { window.__talk = { saveFails: false, shown: ${J(TEX)} }; void window.sagebrush.shareTalk({ fid: ${J(fid)}, path: ${J(path)},
    data: () => new TextEncoder().encode(window.__talk.shown),
    save: async () => { if (window.__talk.saveFails) throw new Error("the editor couldn't save"); } }); return 1; })()`);
  await until("document.querySelector('#sbfolderdlg')?.open");
  await ready();
};

try {
  await send("Page.navigate", { url: dev.site + "/" });
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 90000);
  await until(`!!${W}`, 60000);
  await ev(`(async () => { for (const d of ["/Talks", "/Talks/talks"]) await ${W}.mkdir(d); return 1; })()`);
  await make("/Talks/talks/st.tex", bytes(TEX));
  await make("/Talks/talks/st.tex.results.json", bytes(J({ format: "sagebrush-latex-results", version: 1, wrapper: "W", items: [] })));
  await make("/Talks/talks/helper.py", bytes("def v():\n    return 42\n"));
  // (another talk in the same folder, before it by name: the talk shared from is still the first link)
  await make("/Talks/talks/a.tex", bytes(TEX));
  await make("/Talks/outside.txt", bytes("not the talk's\n"));
  await make("/top.tex", bytes(TEX));
  const texFid = await ev(`${W}.stat("/Talks/talks/st.tex").then((e) => e.fid)`), topFid = await ev(`${W}.stat("/top.tex").then((e) => e.fid)`);
  const folderFid = await ev(`${W}.stat("/Talks/talks").then((e) => e.fid)`);
  ok(!!texFid && !!topFid && !!folderFid, "(the talk, a top-level talk and the talk's folder have their ids)");
  ok((await ev(`fetch('/auth/dev', { method: 'POST', headers: {'content-type': 'application/json'}, body: ${J(J({ token: "dev-token", account_id: A }))} }).then((r) => r.status)`)) === 200, "(the author signs in: dev)");

  // ---- 1. a talk at the top of the files
  await shareTalk("/top.tex", topFid);
  ok((await statusText()) === TALK_TOP, "a talk at the top of the files: board's line");
  ok((await rows()).length === 0 && !(await hasUpload()), "…nothing listed, nothing offered");
  ok((await ev("document.querySelector('#sbfolderdlg b').textContent")) === "Share “top.tex”", "…titled for the talk, not for a folder (board's)");

  // ---- 2. the talk's save failing, or not holding the text on screen
  const before0 = (await mine()).length;
  await closeDlg();
  await ev(`(() => { window.__talk = { saveFails: true, shown: ${J(TEX)} }; void window.sagebrush.shareTalk({ fid: ${J(texFid)}, path: "/Talks/talks/st.tex",
    data: () => new TextEncoder().encode(window.__talk.shown), save: async () => { if (window.__talk.saveFails) throw new Error("x"); } }); return 1; })()`);
  await until("document.querySelector('#sbfolderdlg')?.open");
  await ready();
  ok((await statusText()) === TALK_SAVE_FAILED && (await rows()).length === 0 && !(await hasUpload()), "the talk's save failing: board's line, nothing listed or offered");
  await closeDlg();
  await ev(`(() => { void window.sagebrush.shareTalk({ fid: ${J(texFid)}, path: "/Talks/talks/st.tex",
    data: () => new TextEncoder().encode("an edit the save didn't keep"), save: async () => {} }); return 1; })()`);
  await until("document.querySelector('#sbfolderdlg')?.open");
  await ready();
  ok((await statusText()) === TALK_SAVE_FAILED && (await rows()).length === 0, "the saved talk not the text on screen: the same line, nothing listed");
  await closeDlg();
  await ev(`(() => { void window.sagebrush.shareTalk({ fid: "not-this-talk", path: "/Talks/talks/st.tex",
    data: () => new TextEncoder().encode(${J(TEX)}), save: async () => {} }); return 1; })()`);
  await until("document.querySelector('#sbfolderdlg')?.open");
  await ready();
  ok((await statusText()) === TALK_SAVE_FAILED && (await rows()).length === 0, "the file at that path not this talk (another fid): the same line, nothing listed");
  await closeDlg();
  await ev(`(() => { void window.sagebrush.shareTalk({ fid: ${J(texFid)}, path: "/Talks/talks/st.tex", data: () => new TextEncoder().encode(${J(TEX)}) }); return 1; })()`);
  await until("document.querySelector('#sbfolderdlg')?.open");
  await ready();
  ok((await statusText()) === TALK_SAVE_FAILED && (await rows()).length === 0, "an editor without save(): the same line, nothing listed (never taken as saved)");
  ok((await mine()).length === before0 && (await shareOf(folderFid)) === undefined, "…and nothing was uploaded, the folder holds no share");

  // ---- 3. the talk's folder
  await shareTalk("/Talks/talks/st.tex", texFid);
  ok(J(await rows()) === J([["a.tex", true], ["helper.py", true], ["st.tex", true], ["st.tex.results.json", true]]), `the talk's folder listed, ticked: the talk, its results, its folder's file, nothing from outside it (${J(await rows())})`);
  const notes = await ev("[...document.querySelectorAll('#sbfolderdlg p.note')].map((p) => p.textContent)");
  ok(notes.includes(TALK_SCOPE), "…with the scope line");
  ok(notes.some((t) => t.startsWith("Publishes a copy of the folder's contents, with a link to each notebook and LaTeX document")), "…and the note says the folder's contents, a link per notebook and LaTeX document");
  ok((await statusText()) === "", "…a folder of talks only has something to share (no \"no notebook\" line)");
  const r1 = await upload();
  ok(/\/s\/[a-z2-7]{12}$/.test(r1.url ?? ""), `uploaded: ${r1.url} (${J(r1.notes)})`);
  const id = idOf(r1.url);
  ok((await mine()).length === before0 + 1, "one collection made");
  ok(J(await manifest(id)) === J(["a.tex", "helper.py", "st.tex", "st.tex.results.json"]), `the files at their paths in the talk's folder (${J(await manifest(id))})`);
  ok(J(r1.chapters) === J([["st.tex", `${r1.url}?f=st.tex`], ["a.tex", `${r1.url}?f=a.tex`]]), `a link per talk, the talk shared from first (${J(r1.chapters)})`);
  ok(J(await shareOf(folderFid)) === J({ share_id: id, share_attempt: null }), "the talk's folder holds its share");
  const v1 = await ev(`fetch('/api/share/c/${id}').then((r) => r.json()).then((j) => j.version)`);

  // ---- 4. the save failing at Upload
  await shareTalk("/Talks/talks/st.tex", texFid);
  await ev("(() => { window.__talk.saveFails = true; document.querySelector('#sbfolderdlg .links').textContent = ''; [...document.querySelectorAll('#sbfolderdlg button')].find((b) => b.textContent === 'Upload').click(); return 1; })()");
  await until(`[...document.querySelectorAll('#sbfolderdlg span.note')].some((s) => s.textContent === ${J(TALK_SAVE_FAILED)})`, 30000);
  await sleep(1000);
  ok((await ev("document.querySelectorAll('#sbfolderdlg .links a').length")) === 0, "the save failing at Upload: board's line, no link");
  ok((await mine()).length === before0 + 1 && (await ev(`fetch('/api/share/c/${id}').then((r) => r.json()).then((j) => j.version)`)) === v1 && J(await shareOf(folderFid)) === J({ share_id: id, share_attempt: null }), "…nothing uploaded: no collection, no new version, the folder's share as it was");

  // ---- 5. the talks unticked
  await ev("(() => { for (const r of ['st.tex', 'a.tex']) { const b = document.querySelector(`#sbfolderdlg input[data-rel=\"${r}\"]`); b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()");
  ok(await ev("[...document.querySelectorAll('#sbfolderdlg button')].find((b) => b.textContent === 'Upload').disabled"), "the talks unticked, no notebook: nothing to upload");
} catch (e) {
  ok(false, "the test failed: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  await dev.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);
