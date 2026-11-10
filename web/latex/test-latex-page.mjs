// ci: web-browser/latex order=20 chrome env=LATEX_BOX_CLASS=build
// The LaTeX editor's page end to end, in headless Chrome against a web/dist built with SAGEBRUSH_LATEX_PREVIEW=test
// (the page also on loopback hosts), served by web/serve.py (cross-origin isolated, as the site):
//   - the flag: off, no editor and no LaTeX file fetched; on, nothing fetched before a .tex is opened;
//   - a middle-click on a file row: a new tab of the editor only for a .tex it takes; otherwise nothing, as before;
//   - opening by fid, the banner; saving as you type (U8, autosave.ts): Saved ✓, Ctrl/Cmd+S at once, no leave prompt
//     but after a failed write, the draft recovered after the page went away with a write in flight;
//   - the byte rules: the fixtures saved and read back; mixed endings and NUL open read-only;
//   - the save target: a rename followed; the file in Trash, refused; another tab's save taken in, then mine over it
//     (kept as a version); leaving right after an edit, no prompt;
//   - a change to the open file made elsewhere (an agent, another tab, another device): followed when nothing is
//     pending; otherwise the bar, nothing written, Keep mine / Use theirs, and their races;
//   - images: one in the folder shown from a blob: URL; one outside refused with its reason; a held read under a
//     second render: each name read and kept once, within the count bound;
//   - a 1.5 MiB paragraph and list shown as pieces of at most 128 KiB, never two versions at once;
//   - non-ASCII HTML: no patch step over 512 KiB of UTF-8.
//   - the layout and controls: New offers a LaTeX file only with the editor on; the files beside the page, not over
//     it, Files hiding and showing them with the document open; long lines wrapped (not over 16 KiB); the font size and
//     zoom kept; a notebook from the files opened by URL; an unclosed $$ ended at a blank line.
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && CHROME=google-chrome node web/latex/test-latex-page.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";
import { boxClass } from "./boxclass.mjs";
import * as C from "./comments-core.mjs";

const here = new URL(".", import.meta.url).pathname;
// the box class, an explicit input (never detected): the run packet's frozen BOXCLASS beside the trees
// (trees/BOXCLASS, written by latex-freeze-pkt.sh) wins whenever it exists; LATEX_BOX_CLASS only where there is no
// packet file (boxclass.mjs). "timing" (VM3/VM4) gates the timing assertions; "build" records them; anything else
// stops here, before the server or Chrome starts
let boxFile = null;
try { boxFile = readFileSync(join(here, "..", "..", "..", "BOXCLASS"), "utf8"); } catch {}
const bc = boxClass(process.env.LATEX_BOX_CLASS, boxFile);
if (bc.error) { console.log("FAIL: " + bc.error); process.exit(1); }
const BOX = bc.box;
console.log("box class:", BOX, boxFile !== null ? "(the packet's BOXCLASS)" : "(LATEX_BOX_CLASS)", bc.note);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the server: web/serve.py on a port it picks, printed once it listens
const server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const sport = await new Promise((res, rej) => { let acc = ""; server.stdout.on("data", (b) => { acc += b; const m = /(\d{2,5})/.exec(acc); if (m) res(+m[1]); }); setTimeout(() => rej(new Error("no server port")), 15000); });
const base = `http://127.0.0.1:${sport}/`;
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-latex-page-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1400,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [], requests = [], dialogs = [], dialogText = [], sizes = new Map(), reqUrl = new Map();
// (a request held by the Fetch domain, while a case enables it: given to that case's handler)
let onPaused = null;
// (each request by its id, in order: its URL, whether it was answered from the cache, its bytes over the network)
const byId = [], idInfo = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Network.requestWillBeSent") { requests.push(m.params.request.url); reqUrl.set(m.params.requestId, m.params.request.url); if (!idInfo.has(m.params.requestId)) { const x = { url: m.params.request.url, cached: false, bytes: null, status: null }; idInfo.set(m.params.requestId, x); byId.push(x); } }
  if (m.method === "Network.requestServedFromCache" && idInfo.has(m.params.requestId)) idInfo.get(m.params.requestId).cached = true;
  if (m.method === "Network.responseReceived" && idInfo.has(m.params.requestId)) { const x = idInfo.get(m.params.requestId); x.status = m.params.response.status; if (m.params.response.fromDiskCache || m.params.response.fromPrefetchCache) x.cached = true; }
  if (m.method === "Network.loadingFinished" && idInfo.has(m.params.requestId)) idInfo.get(m.params.requestId).bytes = m.params.encodedDataLength;
  if (m.method === "Network.loadingFinished") sizes.set(reqUrl.get(m.params.requestId) ?? m.params.requestId, m.params.encodedDataLength);
  if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params.type); dialogText.push(m.params.message); send("Page.handleJavaScriptDialog", { accept: true }); }
  if (m.method === "Fetch.requestPaused" && onPaused) onPaused(m.params);
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
// (navigation by document identity: the outgoing document is marked first, and a navigation is done only once a
// document WITHOUT the mark is loaded, so a check can never pass on the page being left)
// Both THROW on failure (the mark not acknowledged by the page; no new document in time), so nothing that depends on
// the new document (a file made, read or stat'ed there) ever runs after a failed navigation: the test stops, failed.
const markWith = async (expr) => { const r = await ev(expr); if (r !== true) throw new Error("navigation mark not acknowledged: " + JSON.stringify(r)); };
const mark = () => markWith(`window.__sbOld = true; true`);
const fresh = async (expr = "true", ms = 30000) => {
  if (!(await until(`!window.__sbOld && document.readyState !== "loading" && (${expr})`, ms))) throw new Error("no new document with (" + expr + ") within " + ms + " ms");
  return true;
};
const go = async (url) => { await mark(); await send("Page.navigate", { url }); await fresh(); };
const fails = []; let checks = 0;
const check = (ok, what, detail) => { checks++; if (!ok) { fails.push(what); console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)); } };
const W = "window.sagebrush?.workspace";
const latexFetches = () => requests.filter((u) => /sagebrush-latex/.test(u));
const bytesOf = (p) => ev(`${W}.read(${JSON.stringify(p)}).then((r) => Array.from(r.content))`);
const mk = (p, arr) => ev(`${W}.create(${JSON.stringify(p)}, { content: new Uint8Array(${JSON.stringify(arr)}) }).then((e) => e.fid)`);
const enc = (s) => Array.from(new TextEncoder().encode(s));
const DOC = "\\documentclass{article}\n\\begin{document}\n\\section{Hello}\nSome text with $x^2$.\n\\end{document}\n";
const open = async (fid, q = "&latex=1") => { await go(base + "?tex=" + encodeURIComponent(fid) + q); return until(`!!document.querySelector(".tex-page")`, 20000); };
const page = (expr) => ev(`(() => { const P = document.querySelector(".tex-page"); return ${expr}; })()`);
const typeInto = (text) => ev(`(() => { const t = document.querySelector(".tex-src"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input")); return true; })()`);
const ctrlS = () => send("Input.dispatchKeyEvent", { type: "keyDown", key: "s", code: "KeyS", modifiers: 2, windowsVirtualKeyCode: 83 });
// (LATEX_SHOTS=dir: screenshots at a few moments, for a look; nothing is checked from them)
const shot = async (name) => { if (!process.env.LATEX_SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(process.env.LATEX_SHOTS, name + ".png"), Buffer.from(r.data, "base64")); };
const statusIs = (re, ms = 10000) => until(`${re}.test(document.querySelector(".tex-status")?.textContent ?? "")`, ms);
// (the save state, as autosave.ts shows it: "Saved ✓" once every edit is written)
const savedNow = (ms = 10000) => until(`document.querySelector(".tex-savestate")?.textContent === "Saved ✓"`, ms);
const saveStateIs = (re, ms = 10000) => until(`${re}.test(document.querySelector(".tex-savestate")?.textContent ?? "")`, ms);

try {
  for (const m of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(m);
  // ---- no flag (on by default; ?latex=1 below is ignored, kept from when it was the switch)
  await go(base);
  await until(`!!${W}`, 60000);
  await ev(`localStorage.removeItem("sagebrush-latex-preview"); true`);
  // ---- a new LaTeX document on a phone (William's phone test, Oct 29: the file panel's buttons were the only way, and
  // could be covered): at 390 x 844, the empty file list (this profile has no files yet) offers "New LaTeX document",
  // and the File menu's New group "LaTeX document" (before Folder); each in view, not covered (the element at its
  // centre is the button itself), and each makes a .tex and opens it in the editor
  {
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const reach = (sel, text) => ev(`(() => {
      const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.firstChild?.textContent === ${JSON.stringify(text)});
      if (!b) return { found: false, items: [...document.querySelectorAll(${JSON.stringify(sel)})].map((x) => x.textContent) };
      b.scrollIntoView({ block: "center" });
      const r = b.getBoundingClientRect(), at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { found: true, inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, top: at === b || b.contains(at), at: at ? at.tagName + "#" + at.id + "." + at.className + " " + (at.textContent ?? "").slice(0, 40) : null, w: innerWidth, h: innerHeight };
    })()`);
    const madeAs = async (p) => (await fresh(`!!document.querySelector(".tex-page .tex-src") && !!${W}`, 20000)) && ev(`${W}.stat(${JSON.stringify(p)}).then((e) => !!e?.fid && new URLSearchParams(location.search).get("tex") === e.fid)`);
    await ev(`localStorage.setItem("sagebrush-files-sidebar", "1"); true`);
    await go(base + "?latex=1"); await until(`!!${W}`, 60000);
    // (a first visit has /Welcome.ipynb: removed, to the Trash, for the empty list)
    await until(`!!document.querySelector('.sbfiles .frow[data-path="/Welcome.ipynb"]')`, 20000);
    await ev(`${W}.remove("/Welcome.ipynb").then(() => true)`);
    const listed = await until(`[...document.querySelectorAll(".sbfiles .fempty button")].some((b) => b.textContent === "New LaTeX document")`, 20000);
    check(listed && await ev(`[...document.querySelectorAll(".sbfiles .fempty button")].some((b) => b.textContent === "From an example…")`), "phone: the empty file list offers From an example… too (U0)");
    const er = listed ? await reach(".sbfiles .fempty button", "New LaTeX document") : await ev(`({ files: !!document.querySelector(".sbfiles"), hidden: document.getElementById("wssidebar")?.hidden, rows: [...document.querySelectorAll(".sbfiles .frow")].map((r) => r.dataset.path).slice(0, 8), empty: [...document.querySelectorAll(".sbfiles .fempty")].map((x) => x.textContent.slice(0, 60)) })`);
    check(listed && er.found && er.inView && er.top && er.w === 390, "phone: the empty file list offers New LaTeX document, in view and not covered", er);
    if (listed) { await mark(); await ev(`([...document.querySelectorAll(".sbfiles .fempty button")].find((b) => b.textContent === "New LaTeX document").click(), true)`); }
    check(listed && await madeAs("/Untitled.tex"), "phone: New LaTeX document (the empty file list): /Untitled.tex made and opened in the editor");
    // (the File menu with the files panel closed: on a phone the panel lies over the page, as it is meant to)
    await ev(`localStorage.removeItem("sagebrush-files-sidebar"); true`);
    await go(base + "?latex=1"); await until(`!!${W}`, 60000);
    const fb = await reach("#filebtn", "File ▾");
    await ev(`(document.getElementById("filebtn").click(), true)`);
    await until(`!!document.querySelector('.fmgroup[aria-label="New"]')`, 10000);
    await ev(`(document.querySelector('#filemenu button[data-group="new"]').click(), true)`);
    const items = await ev(`[...document.querySelectorAll('.fmgroup[aria-label="New"] button')].map((b) => b.dataset.item ?? b.firstChild?.textContent)`);
    const mr = await reach('.fmgroup[aria-label="New"] button', "LaTeX document");
    check(fb.found && fb.inView && fb.top && JSON.stringify(items) === JSON.stringify(["newNotebook", "newMatlab", "newBoard", "newLatex", "newFolder", "fromExample"]) && mr.found && mr.inView && mr.top,
      "phone: File > New offers LaTeX document, in the file panel's order (U0), File and the item in view and not covered", { fb, items, mr });
    await mark(); await ev(`([...document.querySelectorAll('.fmgroup[aria-label="New"] button')].find((b) => b.textContent === "LaTeX document").click(), true)`);
    check(await madeAs("/Untitled (2).tex"), "phone: File > New > LaTeX document: /Untitled (2).tex made and opened in the editor");
    // the editor's File > New > From an example… (U0: "From an example…" replaces "LaTeX example", William Nov 2), on
    // a site without the examples gallery (this test's server: web/examples/open.ts finds no catalog): the LaTeX
    // examples' own list fits the phone (10 large buttons, the dialog within the width, each button reachable), and the
    // figure example opens with its image (a folder of its own, plot.png beside it)
    await ev(`(document.querySelector(".tex-filebtn").click(), true)`);
    await until(`!!document.querySelector('.tex-filemenu .fmgroup[aria-label="New"]')`, 10000);
    await ev(`(document.querySelector('.tex-filemenu button[data-group="new"]').click(), true)`);
    const exItem = await reach('.tex-filemenu .fmgroup[aria-label="New"] button', "From an example…");
    // (the examples are a chunk of their own, sagebrush-latex-examples.js: not fetched before their list is asked for)
    const exAsks = () => requests.filter((u) => /sagebrush-latex-examples\.js/.test(u)).length, exBefore = exAsks();
    await ev(`(document.querySelector('.tex-filemenu [data-item="fromExample"]').click(), true)`);
    const listed2 = await until(`document.querySelectorAll("dialog.sb-tex-examples[open] button[data-example]").length === 10`, 20000);
    check(exBefore === 0 && exAsks() === 1, "phone: the examples' chunk fetched once, by their list, and not before", { exBefore, after: exAsks() });
    const dlg = listed2 && await ev(`(() => { const d = document.querySelector("dialog.sb-tex-examples"), r = d.getBoundingClientRect(), bs = [...d.querySelectorAll("button[data-example]")];
      const last = bs[bs.length - 1]; last.scrollIntoView({ block: "center" }); const lr = last.getBoundingClientRect(), at = document.elementFromPoint(lr.left + lr.width / 2, lr.top + lr.height / 2);
      return { menuHidden: document.querySelector(".tex-filemenu").hidden, left: r.left, right: r.right, w: innerWidth, n: bs.length, minH: Math.min(...bs.map((b) => b.getBoundingClientRect().height)), lastReach: at === last || last.contains(at) }; })()`);
    check(exItem.found && exItem.inView && exItem.top && listed2 && dlg.menuHidden && dlg.left >= 0 && dlg.right <= dlg.w && dlg.n === 10 && dlg.minH >= 44 && dlg.lastReach,
      "phone: the editor's File > New > From an example…: the File menu closed, the list of 10 fits the screen, every button at least 44 px and reachable", { exItem, dlg });
    // (in the editor, another .tex opens in place, its URL pushed: no new document)
    await ev(`(document.querySelector('dialog.sb-tex-examples button[data-example="figure"]').click(), true)`);
    const figOk = await until(`${W}.stat("/LaTeX examples/Figure with an image/figure.tex").then((e) => !!e?.fid && new URLSearchParams(location.search).get("tex") === e.fid && !!document.querySelector(".tex-page .tex-src"))`, 20000);
    const figImg = figOk && await until(`[...document.querySelectorAll(".tex-preview img.graphic")].some((i) => i.src.startsWith("blob:"))`, 20000);
    check(figOk && figImg && await ev(`${W}.stat("/LaTeX examples/Figure with an image/plot.png").then((e) => e?.kind === "file")`), "phone: the figure example: its folder made, figure.tex opened, plot.png beside it and shown in the preview");
    await ev(`localStorage.removeItem("sagebrush-files-sidebar"); true`);
    await send("Emulation.clearDeviceMetricsOverride");
  }
  // ---- the examples' chunk fails to load (grader #685 E1, E2, E4): the first request for it refused (the Fetch
  // domain), the editor's File > New > From an example… says so in an alert, and the list isn't shown; asked again, the
  // list loads, by a new URL (?try=2: the browser keeps a failed module import for its URL), so a failure is never cached
  {
    await go(base + "?latex=1"); await until(`!!${W}`, 60000);
    await open(await ev(`${W}.stat("/Untitled.tex").then((e) => e.fid)`));
    let refused = 0;
    onPaused = (p) => { if (!refused++) send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionFailed" }); else send("Fetch.continueRequest", { requestId: p.requestId }); };
    await send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-latex-examples.js*" }] });
    const exUrls = () => requests.filter((u) => /sagebrush-latex-examples\.js/.test(u));
    const askExamples = async () => {
      await ev(`(document.querySelector(".tex-filebtn").click(), true)`);
      await until(`!!document.querySelector('.tex-filemenu .fmgroup[aria-label="New"]')`, 10000);
      await ev(`(document.querySelector('.tex-filemenu button[data-group="new"]').click(), true)`);
      await ev(`(document.querySelector('.tex-filemenu [data-item="fromExample"]').click(), true)`);
    };
    const r0 = exUrls().length, d0 = dialogText.length;
    await askExamples();
    const said = await (async () => { for (let i = 0; i < 100 && dialogText.length === d0; i++) await sleep(100); return dialogText.slice(d0); })();
    const fail = { refused, said, listed: await ev(`!!document.querySelector("dialog.sb-tex-examples[open]")`), urls: exUrls().slice(r0) };
    check(refused === 1 && said.length === 1 && said[0] === "The examples couldn't be loaded. Check the network, then try again." && !fail.listed && fail.urls.length === 1 && !/\?try=/.test(fail.urls[0]),
      "the examples' chunk refused: an alert says so (check the network, try again), no list", fail);
    await askExamples();
    const again = { listed: await until(`document.querySelectorAll("dialog.sb-tex-examples[open] button[data-example]").length === 10`, 20000), urls: exUrls().slice(r0), alerts: dialogText.length - d0 };
    check(again.listed && again.urls.length === 2 && /sagebrush-latex-examples\.js\?try=2$/.test(again.urls[1]) && again.alerts === 1,
      "…asked again: the list of 10, loaded by a new URL (?try=2), no second alert", again);
    // (and once loaded, kept: asked a third time, the same 10 with no new request for the chunk; grader #685 E3,
    //  loadExamples() not memoized would ask by ?try=3)
    await ev(`(document.querySelector("dialog.sb-tex-examples[open]")?.close(), true)`);
    await askExamples();
    const kept = { listed: await until(`document.querySelectorAll("dialog.sb-tex-examples[open] button[data-example]").length === 10`, 20000) };
    await sleep(300);
    Object.assign(kept, { urls: exUrls().slice(r0), ids: await ev(`[...document.querySelectorAll("dialog.sb-tex-examples[open] button[data-example]")].map((b) => b.dataset.example).join()`) });
    check(kept.listed && kept.urls.length === 2 && !kept.urls.some((u) => /\?try=3/.test(u)) && kept.ids.split(",").length === 10,
      "…asked a third time, once loaded: the same 10, the chunk not fetched again", kept);
    await send("Fetch.disable"); onPaused = null;
    await ev(`(document.querySelector("dialog.sb-tex-examples[open]")?.close(), true)`);
    // a site with the examples gallery (its catalog stubbed: one LaTeX document, one notebook): the editor's File ▸
    // Examples… and New ▸ From an example… open the gallery's panel, on LaTeX first, as the notebook and board pages
    // open it on theirs (#759), not the LaTeX examples' own list
    await ev(`(() => { const f0 = window.__sbFetch0 ??= window.fetch; window.fetch = (u, o) => new URL(String(u?.url ?? u), location.href).pathname === "/examples/index.json" ? Promise.resolve(new Response(JSON.stringify({ examples: [{ id: "latex/stub", kind: "latex", title: "Stub LaTeX", summary: "" }, { id: "notebook/stub", kind: "notebook", title: "Stub notebook", summary: "" }] }), { headers: { "content-type": "application/json" } })) : f0(u, o); return 1; })()`);
    const galleryOn = `!!document.querySelector("dialog.sb-examples[open]") && !document.querySelector("dialog.sb-tex-examples[open]") && (() => { const t = [...document.querySelectorAll("dialog.sb-examples [role=option]")].map((b) => b.textContent); return t.some((x) => x.includes("Stub LaTeX")) && !t.some((x) => x.includes("Stub notebook")); })()`;
    const closeGallery = `(() => { [...document.querySelectorAll("dialog.sb-examples button")].find((b) => b.textContent === "Close")?.click(); return 1; })()`;
    await ev(`(document.querySelector(".tex-filebtn").click(), true)`);
    await ev(`(document.querySelector('.tex-filemenu [data-item="examples"]').click(), true)`);
    check(await until(galleryOn, 20000), "the editor's File ▸ Examples… on a site with the gallery: its panel, on LaTeX first");
    await ev(closeGallery);
    await askExamples();
    check(await until(galleryOn, 20000), "the editor's New ▸ From an example…: the same panel, not the LaTeX examples' own list");
    await ev(closeGallery);
    await ev(`(() => { if (window.__sbFetch0) window.fetch = window.__sbFetch0; return 1; })()`);
  }
  // ---- every example opened in the editor (made by the page module's makeExample, as the list does; the test's
  // workspace handle has create, not the page's createByPerson): each renders in the preview,
  // with nothing shown as unsupported (gray tags; the SageTeX and PythonTeX "not run" chips are expected), recorded
  {
    await go(base + "?latex=1"); await until(`!!${W}`, 60000);
    const ids = await ev(`import("/sagebrush-latex.js").then(async (x) => (await x.loadExamples()).map((e) => e.id))`);
    const rec = [];
    for (const id of ids) {
      const fidEx = await ev(`import("/sagebrush-latex.js").then(async (x) => (await x.makeExample({ stat: (p) => ${W}.stat(p), mkdir: (p) => ${W}.mkdir(p), createByPerson: (p, o) => ${W}.create(p, o) }, (await x.loadExamples()).find((e) => e.id === ${JSON.stringify(id)}))).fid)`);
      await open(fidEx);
      const shown = await until(`(() => { const P = document.querySelector(".tex-preview"); return !!P && P.textContent.length > 80; })()`, 30000);
      await sleep(400);
      const r = await ev(`(() => { const P = document.querySelector(".tex-preview");
        return { len: P.textContent.length, unk: [...P.querySelectorAll(".unk:not(.errchip)")].map((x) => x.textContent), chips: P.querySelectorAll(".sagechip").length, bound: !!P.querySelector(".bounderr"), imgs: [...P.querySelectorAll("img.graphic")].filter((i) => i.src.startsWith("blob:")).length }; })()`);
      rec.push({ id, shown, ...r });
    }
    console.log("examples in the page:", JSON.stringify(rec));
    const bad = rec.filter((r) => !r.shown || r.bound || r.unk.length || (r.id === "figure" && r.imgs !== 1));
    check(ids.length === 10 && bad.length === 0, "every example opens in the editor and renders, nothing unsupported shown (the figure's image shown)", bad);
  }
  // ---- William's B1 and B2: from a LaTeX file, New offers a LaTeX document, an example and the notebooks; another .tex
  // from the files beside the page opens in place (no reload: the notebook never shows), its URL pushed; Back returns
  {
    const fa = await mk("/sw/a.tex", enc("\\documentclass{article}\n\\begin{document}\nFile A here.\n\\end{document}\n"));
    const fb = await mk("/sw/b.tex", enc("\\documentclass{article}\n\\begin{document}\nFile B here.\n\\end{document}\n"));
    const fc = await mk("/sw/c.tex", enc("\\documentclass{article}\n\\begin{document}\nFile C here.\n\\end{document}\n"));
    await ev(`localStorage.setItem("sagebrush-files-sidebar", "1"); true`);
    await open(fa);
    await until(`document.querySelector(".tex-preview").textContent.includes("File A here.")`, 20000);
    const nm = await ev(`(async () => { document.querySelector(".tex-filebtn").click(); await new Promise((r) => setTimeout(r, 50)); document.querySelector('.tex-filemenu button[data-group="new"]').click();
      const items = [...document.querySelectorAll('.tex-filemenu .fmgroup[aria-label="New"] button')].map((b) => b.dataset.item);
      document.querySelector('.tex-filemenu [data-item="fromExample"]').click(); await new Promise((r) => setTimeout(r, 300));
      const n = document.querySelectorAll("dialog.sb-tex-examples[open] button[data-example]").length; document.querySelector("dialog.sb-tex-examples")?.close(); return { items, n, closed: document.querySelector(".tex-filemenu").hidden }; })()`);
    check(JSON.stringify(nm.items) === JSON.stringify(["newNotebook", "newMatlab", "newBoard", "newLatex", "newFolder", "fromExample"]) && nm.n === 10 && nm.closed, "B1 + U0: from a LaTeX file, File > New has every editor's items in the file panel's order, and From an example… opens the LaTeX examples", nm);
    const sel = (p) => JSON.stringify(`.frow[data-path="${p}"]`);
    await until(`!!document.querySelector(${sel("/sw/b.tex")}) || (document.querySelector('.frow[data-path="/sw"]')?.click(), false)`, 20000);
    const sw = await ev(`(async () => {
      window.__noReload = true; const seen = { notebook: false };
      const obs = new MutationObserver(() => { if (!document.querySelector(".tex-page")) seen.notebook = true; }); obs.observe(document.body, { childList: true, subtree: true });
      document.querySelector(${sel("/sw/b.tex")}).click();
      for (let i = 0; i < 100 && !document.querySelector(".tex-preview")?.textContent.includes("File B here."); i++) await new Promise((r) => setTimeout(r, 100));
      obs.disconnect();
      return { kept: window.__noReload === true, b: !!document.querySelector(".tex-preview")?.textContent.includes("File B here."), url: new URLSearchParams(location.search).get("tex"), pages: document.querySelectorAll(".tex-page").length, notebook: seen.notebook, title: document.querySelector(".tex-title")?.textContent };
    })()`);
    check(sw.kept && sw.b && sw.url === fb && sw.pages === 1 && !sw.notebook && sw.title === "b.tex", "B2: another .tex from the files opens in place: no reload, no notebook shown, its URL, one page", sw);
    await ev(`(history.back(), true)`);
    const bk = await until(`window.__noReload === true && document.querySelector(".tex-preview")?.textContent.includes("File A here.") && new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fa)}`, 20000);
    check(bk, "B2: Back returns to the first file, in place");
    // ---- (astra B5-A1) Back and Forward with text that couldn't be saved ask first, as opening another file does:
    // declined, the history goes back to the shown file's entry and its text stays; accepted, the other file opens (its
    // own unsaved draft recovered); with everything saved, nothing asked (U8: edits are saved as you type, so the
    // question comes only after a write failed: here every write fails while window.__failWrites is set)
    const S = (x) => `(${x})`;
    await ev(`(() => { window.__asked = 0; window.__answer = false; window.confirm = () => { window.__asked++; return window.__answer; }; window.__sbTexSaveWrite = () => { if (window.__failWrites) throw new Error("test: the write failed"); }; window.__failWrites = true; return true; })()`);
    const state = S(`{ asked: window.__asked, url: new URLSearchParams(location.search).get("tex"), at: history.state && history.state.sbTex, title: document.querySelector(".tex-title")?.textContent, src: document.querySelector(".tex-src")?.value, pages: document.querySelectorAll(".tex-page").length, kept: window.__noReload === true }`);
    await ev(`(history.forward(), true)`);
    const fw0 = await until(`document.querySelector(".tex-preview")?.textContent.includes("File B here.") && new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fb)}`, 20000);
    const fw0s = await ev(state);
    check(fw0 && fw0s.asked === 0 && fw0s.at === 1 && fw0s.kept, "B5-A1: Forward with nothing unsaved: the next file, nothing asked", fw0s);
    await ev(`(() => { const t = document.querySelector(".tex-src"); t.value += "% unsaved in B\\n"; t.dispatchEvent(new Event("input")); return true; })()`);
    await saveStateIs(/^Not saved: test: the write failed/);
    await ev(`(history.back(), true)`); await sleep(1500);
    const db = await ev(state);
    check(db.asked === 1 && db.url === fb && db.at === 1 && db.title === "b.tex" && db.src.includes("% unsaved in B") && db.pages === 1 && db.kept, "B5-A1: Back with unsaved text asks; declined, the file, its URL, its history entry and its text stay", db);
    await ev(`(window.__answer = true, history.back(), true)`);
    const ab = await until(`document.querySelector(".tex-preview")?.textContent.includes("File A here.") && new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fa)}`, 20000);
    const abs = await ev(state);
    check(ab && abs.asked === 2 && abs.at === 0 && abs.title === "a.tex" && abs.kept, "B5-A1: Back with unsaved text, accepted: the first file opens", abs);
    await ev(`(() => { window.__answer = false; const t = document.querySelector(".tex-src"); t.value += "% unsaved in A\\n"; t.dispatchEvent(new Event("input")); return true; })()`);
    await saveStateIs(/^Not saved: test: the write failed/);
    await ev(`(history.forward(), true)`); await sleep(1500);
    const df = await ev(state);
    check(df.asked === 3 && df.url === fa && df.at === 0 && df.title === "a.tex" && df.src.includes("% unsaved in A") && df.pages === 1 && df.kept, "B5-A1: Forward with unsaved text asks; declined, the file, its URL, its history entry and its text stay", df);
    await ev(`(window.__answer = true, history.forward(), true)`);
    const af = await until(`document.querySelector(".tex-preview")?.textContent.includes("File B here.") && new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fb)}`, 20000);
    const afs = await ev(state);
    check(af && afs.asked === 4 && afs.at === 1 && afs.src.includes("% unsaved in B") && afs.kept, "B5-A1: Forward with unsaved text, accepted: the next file opens, its own unsaved draft recovered (U8)", afs);
    // (writes work again: B's recovered draft saved, then Back to A: A's draft recovered and saved; nothing asked)
    await ev(`(window.__failWrites = false, true)`); await ctrlS(); await savedNow();
    await ev(`(history.back(), true)`);
    const cb = await until(`document.querySelector(".tex-preview")?.textContent.includes("File A here.") && new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fa)}`, 20000);
    const cbs = await ev(state);
    check(cb && cbs.asked === 4 && cbs.at === 0 && cbs.kept, "B5-A1: Back with nothing unsaved: nothing asked", cbs);
    // ---- (astra U8-SWITCH-2) a return to the file shown is a newer intent: A shown, an edit whose write is held,
    // Forward to B (its switch waits for A to settle), then Back to A before it has: once A's write lands, A stays
    // shown (its URL, editable, its edit written) and B never opens
    {
      await ev(`(() => { window.__failWrites = false; window.__hold = new Promise((r) => (window.__rel = r)); window.__sbTexSaveWrite = () => window.__hold; return true; })()`);
      await ev(`(() => { const t = document.querySelector(".tex-src"); t.value += "% held in A\\n"; t.dispatchEvent(new Event("input")); return true; })()`);
      await ev(`(history.forward(), true)`); await sleep(400);
      const mid = await ev(`({ ro: document.querySelector(".tex-src").readOnly, url: new URLSearchParams(location.search).get("tex") })`);
      await ev(`(history.back(), true)`); await sleep(400);
      await ev(`(window.__rel(), delete window.__sbTexSaveWrite, true)`); await sleep(1500);
      const sw2 = await ev(`({ url: new URLSearchParams(location.search).get("tex"), title: document.querySelector(".tex-title")?.textContent, a: !!document.querySelector(".tex-preview")?.textContent.includes("File A here."), ro: document.querySelector(".tex-src").readOnly, src: document.querySelector(".tex-src").value, asked: window.__asked, kept: window.__noReload === true })`);
      const aFile = await ev(`${W}.read("/sw/a.tex").then((r) => new TextDecoder().decode(r.content))`);
      check(mid.ro === true && mid.url === fb && sw2.url === fa && sw2.title === "a.tex" && sw2.a && sw2.ro === false && sw2.src.includes("% held in A") && aFile.includes("% held in A") && sw2.asked === 4 && sw2.kept,
        "U8-SWITCH-2: Forward to B waits for A to settle (A held read-only meanwhile); Back to A first: A stays shown, editable, its edit written; B never opens", { mid, sw2, aFile: aFile.slice(-40) });
    }
    // ---- (astra U8-DURABLE-CLOSE-1, the page) a single, frozen close: A's write fails, its edit durable in its draft;
    // Forward to B, accepted; while the close's last write is held the editor is read-only, so text typed then never
    // reaches it; the close ends with A's last edit in its draft, and B opens
    {
      await ev(`(() => { window.__asked = 0; window.__answer = true; window.__k = 0; window.__hold = new Promise((r) => (window.__rel = r));
        window.__sbTexSaveWrite = () => { if (window.__k++ === 0) throw new Error("test: the write failed"); return window.__hold.then(() => { throw new Error("test: the write failed"); }); }; return true; })()`);
      await ev(`(() => { const t = document.querySelector(".tex-src"); t.value += "% OLD in A\\n"; t.dispatchEvent(new Event("input")); return true; })()`);
      await saveStateIs(/^Not saved: test: the write failed/);
      await ev(`(window.__k = 0, history.forward(), true)`);
      const frozen = await until(`window.__k >= 2 && document.querySelector(".tex-src")?.readOnly === true && document.querySelector(".tex-title")?.textContent === "a.tex"`, 10000);
      await ev(`(document.querySelector(".tex-src").focus(), true)`); await send("Input.insertText", { text: "NEW" });
      const during = await ev(`document.querySelector(".tex-src").value`);
      await ev(`(window.__rel(), true)`);
      const opened = await until(`document.querySelector(".tex-preview")?.textContent.includes("File B here.") && new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fb)}`, 20000);
      const drafts = await ev(`Object.keys(localStorage).filter((k) => k.startsWith("sb-tex-draft:" + ${JSON.stringify(fa)} + ":")).map((k) => JSON.parse(localStorage.getItem(k)).text)`);
      await ev(`(delete window.__sbTexSaveWrite, window.__answer = false, true)`);
      // (A's left-over draft removed: the blocks after this open A again and must find only its file's text)
      await ev(`(Object.keys(localStorage).filter((k) => k.startsWith("sb-tex-draft:" + ${JSON.stringify(fa)} + ":")).forEach((k) => localStorage.removeItem(k)), true)`);
      check(frozen && !during.includes("NEW") && during.includes("% OLD in A") && opened && drafts.some((t) => t.includes("% OLD in A")) && !drafts.some((t) => t.includes("NEW")),
        "U8-DURABLE-CLOSE-1: a single, frozen close: held read-only through its last write, nothing typed then gets in; A's last edit durable in its draft; B opens", { frozen, during: during.slice(-30), opened, drafts: drafts.map((t) => t.slice(-30)) });
    }
    // (back as the blocks after these expect it: the B5-A1 write hook again, nothing failing, and A shown)
    await ev(`(window.__sbTexSaveWrite = () => { if (window.__failWrites) throw new Error("test: the write failed"); }, window.__failWrites = false, window.__answer = false, history.back(), true)`);
    await until(`document.querySelector(".tex-preview")?.textContent.includes("File A here.") && new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fa)}`, 20000);
    await sleep(500); await ev(`(window.__asked = 4, true)`);
    // (a watch on the preview: whether B was ever shown, from now on)
    const watchB = () => ev(`(() => { window.__sawB = false; window.__obsB?.disconnect(); window.__obsB = new MutationObserver(() => { if (document.querySelector(".tex-preview")?.textContent.includes("File B here.") || document.querySelector(".tex-title")?.textContent === "b.tex") window.__sawB = true; }); window.__obsB.observe(document.body, { childList: true, subtree: true, characterData: true }); return true; })()`);
    const endState = () => ev(`({ url: new URLSearchParams(location.search).get("tex"), title: document.querySelector(".tex-title")?.textContent, a: !!document.querySelector(".tex-preview")?.textContent.includes("File A here."), ro: document.querySelector(".tex-src")?.readOnly, src: document.querySelector(".tex-src")?.value ?? "", pages: document.querySelectorAll(".tex-page").length, sawB: window.__sawB, kept: window.__noReload === true, save: document.querySelector(".tex-savestate")?.textContent ?? "", bar: (() => { const b = document.querySelector(".tex-conflict"); return b && !b.hidden ? b.textContent.slice(0, 80) : ""; })() })`);
    const aText = () => ev(`${W}.read("/sw/a.tex").then((r) => new TextDecoder().decode(r.content))`);
    // (a record of every text the save state is given from now on, each as it was set, even one replaced at once)
    const recordSave = () => ev(`(() => { window.__said = []; window.__obsS?.disconnect(); window.__obsS = new MutationObserver((rs) => { for (const r of rs) if (r.target.classList?.contains("tex-savestate")) for (const n of r.addedNodes) window.__said.push(n.textContent); }); window.__obsS.observe(document.body, { childList: true, subtree: true }); return true; })()`);
    const saidSoFar = () => ev(`(window.__obsS?.disconnect(), window.__said ?? [])`);
    // ---- (astra U8-SWITCH-2, the final barrier) Forward to B decided (A's write failed, its draft durable; accepted),
    // B's mount waiting on A's final close (its last write held); Back to A meanwhile: once the close ends, A is open
    // again and editable under its own URL, its edit written; B never shown
    {
      await watchB();
      await ev(`(() => { window.__answer = true; window.__k = 0; window.__hold = new Promise((r) => (window.__rel = r));
        window.__sbTexSaveWrite = () => { const k = window.__k++; if (k === 0) throw new Error("test: the write failed"); if (k === 1) return window.__hold; }; return true; })()`);
      await ev(`(() => { const t = document.querySelector(".tex-src"); t.value += "% barrier in A\\n"; t.dispatchEvent(new Event("input")); return true; })()`);
      await saveStateIs(/^Not saved: test: the write failed/);
      await ev(`(window.__k = 0, history.forward(), true)`);
      const heldClose = await until(`window.__k >= 2`, 10000);
      await ev(`(history.back(), true)`); await sleep(400);
      await ev(`(window.__rel(), true)`);
      await until(`!!document.querySelector(".tex-src") && !document.querySelector(".tex-src").readOnly && document.querySelector(".tex-title")?.textContent === "a.tex" && new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fa)}`, 20000); await sleep(1000);
      const fb1 = await endState(), file1 = await aText();
      check(heldClose && fb1.url === fa && fb1.title === "a.tex" && fb1.a && fb1.ro === false && fb1.src.includes("% barrier in A") && file1.includes("% barrier in A") && fb1.pages === 1 && !fb1.sawB && fb1.kept,
        "U8-SWITCH-2 (the final barrier): Back to A while B's mount waits on A's last write: A open again, editable, its URL and its edit; B never shown", { heldClose, fb1: { ...fb1, src: fb1.src.slice(-30) }, file: file1.slice(-30) });
      await ev(`(window.__sbTexSaveWrite = () => { if (window.__failWrites) throw new Error("test: the write failed"); }, window.__answer = false, true)`);
    }
    // ---- (daybreak3 DB3-U8-SWITCH-3) A's write held, Forward to B (the URL B's, the switch settling), then A asked
    // for from the files (__sbTex): the history taken back to A's entry, A stays shown and editable, its edit
    // written; B never shown
    {
      await watchB();
      await ev(`(() => { window.__hold = new Promise((r) => (window.__rel = r)); window.__sbTexSaveWrite = () => window.__hold; return true; })()`);
      await ev(`(() => { const t = document.querySelector(".tex-src"); t.value += "% clicked back to A\\n"; t.dispatchEvent(new Event("input")); return true; })()`);
      await ev(`(history.forward(), true)`); await sleep(400);
      const urlB = await ev(`new URLSearchParams(location.search).get("tex")`);
      await ev(`(window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }), true)`); await sleep(600);
      await ev(`(window.__rel(), true)`); await sleep(1500);
      const s3 = await endState(), file3 = await aText();
      const entry = await ev(`({ at: history.state && history.state.sbTex })`);
      check(urlB === fb && s3.url === fa && entry.at === 0 && s3.title === "a.tex" && s3.a && s3.ro === false && s3.src.includes("% clicked back to A") && file3.includes("% clicked back to A") && s3.pages === 1 && !s3.sawB && s3.kept,
        "DB3-U8-SWITCH-3: A asked for from the files after Forward moved the URL to B: the history back on A's entry, A shown, editable, its edit written; B never shown", { urlB, s3: { ...s3, src: s3.src.slice(-30) }, entry, file: file3.slice(-30) });
      await ev(`(window.__sbTexSaveWrite = () => { if (window.__failWrites) throw new Error("test: the write failed"); }, window.__obsB?.disconnect(), window.__asked = 4, true)`);
    }
    // ---- (daybreak3 DB3-U8-SWITCH-4, astra) a fast close and a late history: Forward to B decided (A's write failed, its
    // draft durable; accepted), B's mount waiting on A's close (its last write held); then, in one go, A asked for from
    // the files (__sbTex) and the close released: no sleep between. A must open again only once the history is back
    // on A's entry, so the new A takes A's URL for its own: with the Navigation API (its traverseTo made late) and
    // without it (history.go). A shown, editable, its URL, entry and edit; B never shown
    for (const withNav of [true, false]) {
      await watchB();
      await ev(`(() => { window.__answer = true; window.__k = 0; window.__hold = new Promise((r) => (window.__rel = r));
        window.__sbTexSaveWrite = () => { const k = window.__k++; if (k === 0) throw new Error("test: the write failed"); if (k === 1) return window.__hold; }; return true; })()`);
      await ev(`(() => { const t = document.querySelector(".tex-src"); t.value += "% late history ${withNav ? "nav" : "go"}\\n"; t.dispatchEvent(new Event("input")); return true; })()`);
      await saveStateIs(/^Not saved: test: the write failed/);
      await recordSave();
      await ev(`(window.__k = 0, history.forward(), true)`);
      const held = await until(`window.__k >= 2`, 10000);
      // (#551's follow-up: the closing editor, its last write held, says so, not its earlier "Not saved", nor in its
      //  failed style; and the record of the save state's texts sees it, as the saved and read-only cases below rely on)
      const closingSaid = await ev(`document.querySelector(".tex-savestate")?.textContent ?? ""`);
      const closingFailed = await ev(`!!document.querySelector(".tex-savestate")?.classList.contains("failed")`);
      const recorded = (await saidSoFar()).includes("Saving before switching…");
      const nav = await ev(`(() => {
        if (${withNav}) { const n = window.navigation; if (!n?.traverseTo) return false; const orig = n.traverseTo.bind(n);
          n.traverseTo = (k, o) => { const late = new Promise((r) => setTimeout(r, 300)); return { committed: late, finished: late.then(() => orig(k, o).finished) }; }; window.__navRestore = () => { delete n.traverseTo; }; }
        else { const was = window.navigation; Object.defineProperty(window, "navigation", { configurable: true, get: () => undefined }); window.__navRestore = () => { Object.defineProperty(window, "navigation", { configurable: true, get: () => was }); }; }
        window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }); window.__rel(); return true; })()`);
      // (A opens again once its close has written its edit: under heavy storage load that write has taken over 20 s
      //  (the base3 recurrences, r16), the edit durable in its draft meanwhile and written in the end; so up to 60 s,
      //  its time reported, and past that whether the edit reached the file late or not at all)
      const t4 = Date.now();
      const reopened = await until(`!!document.querySelector(".tex-src") && !document.querySelector(".tex-src").readOnly && document.querySelector(".tex-title")?.textContent === "a.tex" && new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fa)}`, 60000);
      const reopenMs = Date.now() - t4;
      await sleep(1500);
      const s4 = await endState(), f4 = await aText(), at4 = await ev(`history.state && history.state.sbTex`);
      const lateWrite = reopened ? null : await until(`${W}.read("/sw/a.tex").then((r) => new TextDecoder().decode(r.content).includes(${JSON.stringify(`% late history ${withNav ? "nav" : "go"}`)}))`, 60000);
      await ev(`(window.__navRestore?.(), delete window.__navRestore, window.__sbTexSaveWrite = () => { if (window.__failWrites) throw new Error("test: the write failed"); }, window.__answer = false, window.__obsB?.disconnect(), window.__asked = 4, true)`);
      const mark = `% late history ${withNav ? "nav" : "go"}`;
      check(held && closingSaid === "Saving before switching…" && !closingFailed && recorded && nav !== false && reopened && s4.url === fa && at4 === 0 && s4.title === "a.tex" && s4.a && s4.ro === false && s4.src.includes(mark) && f4.includes(mark) && s4.pages === 1 && !s4.sawB && s4.kept,
        `DB3-U8-SWITCH-4 (${withNav ? "Navigation API, its traverse late" : "no Navigation API: history.go"}): A asked for and A's close released at once: while the close's write is held, "Saving before switching…", not in the failed style; A open again only on A's entry, editable, its URL and edit; B never shown`, { held, closingSaid, closingFailed, recorded, nav, reopened, reopenMs, lateWrite, s4: { ...s4, src: s4.src.slice(-30) }, at4, file: f4.slice(-30) });
    }
    // ---- (astra U8-SWITCH-5) the newest file asked for wins over a switch past its decision and a return still under
    // way: the file shown's close held (its write failed, then its last write held), a switch to X decided, then...
    {
      const names = { [fa]: "A", [fb]: "B", [fc]: "C" };
      // (a watch: whether X, the file never to be shown, ever was)
      const watchX = (x) => ev(`(() => { window.__sawX = false; window.__obsB?.disconnect(); window.__obsB = new MutationObserver(() => { if (document.querySelector(".tex-preview")?.textContent.includes("File ${names[x]} here.") || document.querySelector(".tex-title")?.textContent === ${JSON.stringify(names[x].toLowerCase() + ".tex")}) window.__sawX = true; }); window.__obsB.observe(document.body, { childList: true, subtree: true, characterData: true }); return true; })()`);
      const stateOf = (f) => ev(`({ url: new URLSearchParams(location.search).get("tex"), at: history.state && history.state.sbTex, title: document.querySelector(".tex-title")?.textContent, shows: !!document.querySelector(".tex-preview")?.textContent.includes("File ${names[f]} here."), ro: document.querySelector(".tex-src")?.readOnly, src: document.querySelector(".tex-src")?.value ?? "", pages: document.querySelectorAll(".tex-page").length, saw: window.__sawX, kept: window.__noReload === true })`);
      const textOf = (f) => ev(`${W}.read(${JSON.stringify("/sw/" + names[f].toLowerCase() + ".tex")}).then((r) => new TextDecoder().decode(r.content))`);
      // (the file shown: an edit whose write fails, then the close's last write held)
      const holdClose = async (mark) => {
        await ev(`(() => { window.__answer = true; window.__k = 0; window.__hold = new Promise((r) => (window.__rel = r));
          window.__sbTexSaveWrite = () => { const k = window.__k++; if (k === 0) throw new Error("test: the write failed"); if (k === 1) return window.__hold; }; return true; })()`);
        await ev(`(() => { const t = document.querySelector(".tex-src"); t.value += ${JSON.stringify(mark + "\n")}; t.dispatchEvent(new Event("input")); return true; })()`);
        await saveStateIs(/^Not saved: test: the write failed/);
        await ev(`(window.__k = 0, true)`);
      };
      const shownIs = (f) => until(`!!document.querySelector(".tex-src") && !document.querySelector(".tex-src").readOnly && document.querySelector(".tex-title")?.textContent === ${JSON.stringify(names[f].toLowerCase() + ".tex")} && new URLSearchParams(location.search).get("tex") === ${JSON.stringify(f)}`, 20000);
      const writesWork = () => ev(`(window.__sbTexSaveWrite = () => { if (window.__failWrites) throw new Error("test: the write failed"); }, window.__answer = false, window.__asked = 4, true)`);
      // (1) ...A asked for again (the history going back to A's entry, its traverse late, or by history.go) and A's
      // close released at once, then a newer file N asked for while that return is under way: N opens, on the entry
      // after A's, and A's stale reopening never runs; X never shown. A is at entry 0, X the one after it. (history.go
      // first: A was last opened with the Navigation API hidden, so it has no entry key, and only a reopening with the
      // API there gives the second run the key its traverse needs; that run checks its late traverse was the one used)
      for (const withNav of [false, true]) {
        const x = withNav ? fc : fb, n = withNav ? fb : fc, mark = `% newest wins ${withNav ? "nav" : "go"}`;
        await watchX(x); await holdClose(mark);
        await ev(`(history.forward(), true)`);
        const held = await until(`window.__k >= 2`, 10000);
        const went = await ev(`(async () => {
          const url = new URLSearchParams(location.search).get("tex");
          if (${withNav}) { const v = window.navigation; if (!v?.traverseTo) return false; const orig = v.traverseTo.bind(v);
            v.traverseTo = (k, o) => { window.__late = true; const late = new Promise((r) => setTimeout(r, 300)); return { committed: late, finished: late.then(() => orig(k, o).finished) }; }; window.__navRestore = () => { delete v.traverseTo; }; }
          else { const was = window.navigation; Object.defineProperty(window, "navigation", { configurable: true, get: () => undefined }); window.__navRestore = () => { Object.defineProperty(window, "navigation", { configurable: true, get: () => was }); }; }
          window.__late = false;
          window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }); window.__rel();
          if (${withNav}) await new Promise((r) => setTimeout(r, 50));
          // (the return still under way when the newer file is asked for: not back on A's entry yet)
          const pending = new URLSearchParams(location.search).get("tex") !== ${JSON.stringify(fa)};
          const accepted = window.__sbTex({ path: ${JSON.stringify("/sw/" + names[n].toLowerCase() + ".tex")}, fid: ${JSON.stringify(n)} });
          return { url, accepted, pending, late: window.__late }; })()`);
        await shownIs(n); await sleep(1500);
        const s = await stateOf(n), fA = await textOf(fa);
        await ev(`(window.__navRestore?.(), delete window.__navRestore, window.__obsB?.disconnect(), true)`); await writesWork();
        check(held && went && went.url === x && went.accepted === true && went.pending && went.late === withNav && s.url === n && s.at === 1 && s.title === names[n].toLowerCase() + ".tex" && s.shows && s.ro === false && s.pages === 1 && !s.saw && s.kept && fA.includes(mark),
          `U8-SWITCH-5 (${withNav ? "Navigation API, its traverse late; the newer file 50 ms after" : "no Navigation API: history.go; the newer file at once"}): A asked for while the switch to ${names[x]} waits on A's close, then ${names[n]}: ${names[n]} opens, editable, on the entry after A's; A not reopened; ${names[x]} never shown; A's edit written`, { held, went, s: { ...s, src: s.src.slice(-30) }, fileA: fA.slice(-30) });
        // (back on A, entry 0: N, its edit-free text, left)
        await ev(`(history.back(), true)`); await shownIs(fa); await sleep(500);
      }
      // (2) ...then a newer file asked for while X's mount waits, no return under way: it opens on the entry after
      // X's; X never shown. Then (3), from there, Back to X decided (its close held) and Back again to A at once: A
      // opens on its entry; X never shown; the left file's edit written
      {
        await watchX(fb); await holdClose("% newer while B waits");
        await ev(`(history.forward(), true)`);
        const held = await until(`window.__k >= 2`, 10000);
        const accepted = await ev(`(() => { const r = window.__sbTex({ path: "/sw/c.tex", fid: ${JSON.stringify(fc)} }); window.__rel(); return r; })()`);
        await shownIs(fc); await sleep(1500);
        const s = await stateOf(fc), fA = await textOf(fa);
        await ev(`(window.__obsB?.disconnect(), true)`); await writesWork();
        check(held && accepted === true && s.url === fc && s.at === 2 && s.shows && s.ro === false && s.pages === 1 && !s.saw && s.kept && fA.includes("% newer while B waits"),
          "U8-SWITCH-5 (a newer file while the switch's mount waits, no return under way): C opens, editable, on the entry after B's; B never shown; A's edit written", { held, accepted, s: { ...s, src: s.src.slice(-30) }, fileA: fA.slice(-30) });
        await watchX(fb); await holdClose("% left C for A");
        await ev(`(history.back(), true)`);
        const held3 = await until(`window.__k >= 2`, 10000);
        await ev(`(history.back(), true)`); await sleep(400);
        await ev(`(window.__rel(), true)`);
        await shownIs(fa); await sleep(1500);
        const s3 = await stateOf(fa), fC = await textOf(fc);
        await ev(`(window.__obsB?.disconnect(), true)`); await writesWork();
        check(held3 && s3.url === fa && s3.at === 0 && s3.shows && s3.ro === false && s3.pages === 1 && !s3.saw && s3.kept && fC.includes("% left C for A"),
          "U8-SWITCH-5 (Back past a decided switch to a third file): Back to B decided (C's close held), Back again to A: A opens, editable, on its entry; B never shown; C's edit written", { held3, s3: { ...s3, src: s3.src.slice(-30) }, fileC: fC.slice(-30) });
      }
      // (4) (astra U8-SWITCH-6) ...a newer Back while a return is already under way: C, A, B on the history after A's
      // entry 0 (C 1, A 2, B 3), A shown; the switch to B decided (A's close held), A asked for again (its traverse
      // late), A's close released at once, and 50 ms later Back two entries, to C, before that return lands: C opens,
      // editable, on its entry, and stays (the late return to A, when it lands, is taken back: its target fenced); A
      // never opened again; B never shown; A's edit written
      {
        const mark = "% back to C during the return";
        await ev(`(window.__sbTex({ path: "/sw/c.tex", fid: ${JSON.stringify(fc)} }), true)`); await shownIs(fc); await sleep(300);
        await ev(`(window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }), true)`); await shownIs(fa); await sleep(300);
        await watchX(fb); await holdClose(mark);
        const nav = await ev(`(() => { const v = window.navigation; if (!v?.traverseTo) return false; const orig = v.traverseTo.bind(v);
          v.traverseTo = (k, o) => { window.__late = (window.__late ?? 0) + 1; const late = new Promise((r) => setTimeout(r, 300)); return { committed: late, finished: late.then(() => orig(k, o).finished) }; };
          window.__navRestore = () => { delete v.traverseTo; }; window.__late = 0; return true; })()`);
        await ev(`(window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }), true)`);
        const held = await until(`window.__k >= 2`, 10000);
        const went = await ev(`(async () => {
          const url = new URLSearchParams(location.search).get("tex"), at = history.state && history.state.sbTex;
          window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }); window.__rel();
          await new Promise((r) => setTimeout(r, 50));
          // (the return still under way when Back is taken: not back on A's entry yet)
          const pending = new URLSearchParams(location.search).get("tex") !== ${JSON.stringify(fa)};
          history.go(-2);
          return { url, at, pending }; })()`);
        await shownIs(fc); await sleep(1800);
        const s = await stateOf(fc), fA = await textOf(fa), late = await ev(`window.__late`);
        await ev(`(window.__navRestore?.(), delete window.__navRestore, window.__obsB?.disconnect(), true)`); await writesWork();
        check(nav && held && went && went.url === fb && went.at === 3 && went.pending && late >= 1 && s.url === fc && s.at === 1 && s.title === "c.tex" && s.shows && s.ro === false && s.pages === 1 && !s.saw && s.kept && fA.includes(mark),
          "U8-SWITCH-6 (Navigation API, the return late): Back to C while the return to A is under way: C opens, editable, on its entry, and stays; A not reopened; B never shown; A's edit written", { nav, held, went, late, s: { ...s, src: s.src.slice(-30) }, fileA: fA.slice(-30) });
        // (back on A, entry 0)
        await ev(`(history.back(), true)`); await shownIs(fa); await sleep(500);
      }
      // (5) (astra U8-SWITCH-7) ...as (4), then the person's own Forward, back to A: before the late return lands (at
      // 100 ms) and after it (at 900 ms). Either way A opens, editable, on its entry, and stays: only the superseded
      // return's own traversal is taken back, never a Back or Forward to the same entry. A's edit written
      for (const fwdAt of [100, 900]) {
        const mark = `% forward to A at ${fwdAt}`;
        await ev(`(window.__sbTex({ path: "/sw/c.tex", fid: ${JSON.stringify(fc)} }), true)`); await shownIs(fc); await sleep(300);
        await ev(`(window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }), true)`); await shownIs(fa); await sleep(300);
        await watchX(fb); await holdClose(mark);
        const nav = await ev(`(() => { const v = window.navigation; if (!v?.traverseTo) return false; const orig = v.traverseTo.bind(v);
          v.traverseTo = (k, o) => { window.__late = (window.__late ?? 0) + 1; const late = new Promise((r) => setTimeout(r, 300)); return { committed: late, finished: late.then(() => orig(k, o).finished) }; };
          window.__navRestore = () => { delete v.traverseTo; }; window.__late = 0; return true; })()`);
        await ev(`(window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }), true)`);
        const held = await until(`window.__k >= 2`, 10000);
        const went = await ev(`(async () => {
          window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }); window.__rel();
          await new Promise((r) => setTimeout(r, 50));
          const pending = new URLSearchParams(location.search).get("tex") !== ${JSON.stringify(fa)};
          history.go(-2);
          await new Promise((r) => setTimeout(r, ${fwdAt - 50}));
          const onC = new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fc)};
          history.forward();
          return { pending, onC }; })()`);
        await shownIs(fa); await sleep(1800);
        const s = await stateOf(fa), fA = await textOf(fa), late = await ev(`window.__late`);
        await ev(`(window.__navRestore?.(), delete window.__navRestore, window.__obsB?.disconnect(), true)`); await writesWork();
        check(nav && held && went && went.pending && went.onC && late >= 1 && s.url === fa && s.at === 2 && s.title === "a.tex" && s.shows && s.ro === false && s.pages === 1 && !s.saw && s.kept && fA.includes(mark),
          `U8-SWITCH-7 (Navigation API, the return late; Back to C at 50 ms, then Forward to A at ${fwdAt} ms${fwdAt < 300 ? ", before the late return lands" : ", after it"}): A opens, editable, on its entry, and stays; B never shown; A's edit written`, { nav, held, went, late, s: { ...s, src: s.src.slice(-30) }, fileA: fA.slice(-30) });
        // (back on A, entry 0: two entries back)
        await ev(`(history.go(-2), true)`); await until(`new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fa)} && history.state && history.state.sbTex === 0`, 20000); await shownIs(fa); await sleep(500);
      }
      // (6) (daybreak3 DB3-U8-SWITCH-7) ...as (4), with an unrelated pop before the late return lands: A 0, C 1, C#f 2,
      // A 3, B 4; Back three entries to C at 50 ms, then Forward to C#f (C's own fragment entry) at 100 ms; the late
      // return, landing on A at 300 ms, is still taken back: C stays, on C#f, its entry
      {
        const mark = "% an unrelated pop first";
        await ev(`(window.__sbTex({ path: "/sw/c.tex", fid: ${JSON.stringify(fc)} }), true)`); await shownIs(fc); await sleep(300);
        await ev(`(location.hash = "#f", true)`); await until(`location.hash === "#f" && history.state && history.state.sbTex === 2`, 10000);
        await ev(`(window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }), true)`); await shownIs(fa); await sleep(300);
        await watchX(fb); await holdClose(mark);
        const nav = await ev(`(() => { const v = window.navigation; if (!v?.traverseTo) return false; const orig = v.traverseTo.bind(v);
          v.traverseTo = (k, o) => { window.__late = (window.__late ?? 0) + 1; const late = new Promise((r) => setTimeout(r, 300)); return { committed: late, finished: late.then(() => orig(k, o).finished) }; };
          window.__navRestore = () => { delete v.traverseTo; }; window.__late = 0; return true; })()`);
        await ev(`(window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }), true)`);
        const held = await until(`window.__k >= 2`, 10000);
        const went = await ev(`(async () => {
          const at = history.state && history.state.sbTex;
          window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }); window.__rel();
          await new Promise((r) => setTimeout(r, 50));
          history.go(-3);
          await new Promise((r) => setTimeout(r, 50));
          const onC = new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fc)} && location.hash === "";
          history.forward();
          return { at, onC }; })()`);
        await shownIs(fc); await sleep(1800);
        const s = await stateOf(fc), fA = await textOf(fa), late = await ev(`window.__late`), hash = await ev(`location.hash`);
        await ev(`(window.__navRestore?.(), delete window.__navRestore, window.__obsB?.disconnect(), true)`); await writesWork();
        check(nav && held && went && went.at === 4 && went.onC && late >= 2 && s.url === fc && hash === "#f" && s.at === 2 && s.title === "c.tex" && s.shows && s.ro === false && s.pages === 1 && !s.saw && s.kept && fA.includes(mark),
          "U8-SWITCH-7 (an unrelated pop first: Back to C, then Forward to C's own fragment entry, before the late return lands): the late return is still taken back; C stays, on C#f, its entry; A not reopened; B never shown; A's edit written", { nav, held, went, late, hash, s: { ...s, src: s.src.slice(-30) }, fileA: fA.slice(-30) });
        // (back on A, entry 0: two entries back)
        await ev(`(history.go(-2), true)`); await shownIs(fa); await until(`history.state && history.state.sbTex === 0 && location.hash === ""`, 20000); await sleep(500);
      }
      // (7) (grader L8, K6) a switch to B decided (A's close held), then Back to A, then A asked for again, the history
      // already on A's entry: A opens again, editable, on its entry, and stays; B never shown; A's edit written
      {
        const mark = "% back then A again";
        await watchX(fb); await holdClose(mark);
        await ev(`(window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }), true)`);
        const held = await until(`window.__k >= 2`, 10000);
        await ev(`(history.back(), true)`);
        const back = await until(`new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fa)}`, 10000);
        await ev(`(window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }), window.__rel(), true)`);
        await shownIs(fa); await sleep(1500);
        const s = await stateOf(fa), fA = await textOf(fa);
        await ev(`(window.__obsB?.disconnect(), true)`); await writesWork();
        check(held && back && s.url === fa && s.at === 0 && s.shows && s.ro === false && s.pages === 1 && !s.saw && s.kept && fA.includes(mark),
          "U8-RETURN (grader L8): a decided switch, Back to the file shown, then that file asked for again: it opens again, editable, on its entry; the other file never shown; its edit written", { held, back, s: { ...s, src: s.src.slice(-30) }, fileA: fA.slice(-30) });
      }
      // (8) (grader L7) the return's traversal refused (the Navigation API's finished rejected): the entry shown is pushed
      // again and what waits for the return runs: A asked for again while the switch to B waits on A's close opens A
      {
        const mark = "% the traverse refused";
        await watchX(fb); await holdClose(mark);
        await ev(`(window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }), true)`);
        const held = await until(`window.__k >= 2`, 10000);
        const nav = await ev(`(() => { const v = window.navigation; if (!v?.traverseTo) return false;
          v.traverseTo = () => { window.__refused = (window.__refused ?? 0) + 1; const f = Promise.reject(new Error("test: the traverse refused")); f.catch(() => {}); return { committed: f, finished: f }; };
          window.__navRestore = () => { delete v.traverseTo; }; window.__refused = 0; return true; })()`);
        await ev(`(window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }), window.__rel(), true)`);
        await shownIs(fa); await sleep(1500);
        const s = await stateOf(fa), fA = await textOf(fa), refused = await ev(`window.__refused`);
        await ev(`(window.__navRestore?.(), delete window.__navRestore, window.__obsB?.disconnect(), true)`); await writesWork();
        check(nav && held && refused >= 1 && s.url === fa && s.at === 1 && s.shows && s.ro === false && s.pages === 1 && !s.saw && s.kept && fA.includes(mark),
          "U8-RETURN (grader L7): the return's traversal refused: the file shown's entry pushed again and the file opened again there, editable; the other file never shown; its edit written", { nav, held, refused, s: { ...s, src: s.src.slice(-30) }, fileA: fA.slice(-30) });
        // (back on A, entry 0: two entries back, B's and A's pushed again)
        await ev(`(history.go(-2), true)`); await until(`history.state && history.state.sbTex === 0`, 20000); await shownIs(fa); await sleep(500);
      }
      // (9) (grader K6) no switch, no Navigation API: the file shown asked for again changes nothing: no entry pushed,
      // the same entry, the editor as it was
      {
        const r = await ev(`(async () => {
          const was = window.navigation; Object.defineProperty(window, "navigation", { configurable: true, get: () => undefined });
          const len = history.length, id = history.state && history.state.sbTexId, at = history.state && history.state.sbTex;
          window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} });
          await new Promise((res) => setTimeout(res, 400));
          const out = { len0: len, len: history.length, same: history.state && history.state.sbTexId === id, at0: at, at: history.state && history.state.sbTex, ro: document.querySelector(".tex-src")?.readOnly };
          Object.defineProperty(window, "navigation", { configurable: true, get: () => was });
          return out; })()`);
        check(r && r.len === r.len0 && r.same && r.at === r.at0 && r.ro === false,
          "U8-RETURN (grader K6): the file shown asked for again, no switch and no Navigation API: no entry pushed, the same entry, the editor editable", r);
      }
      // (10) (grader H2, H4, H7) two leaves at once: A's write held, a switch to B asked for, then to C (the newer
      // leave); the write fails: the older leave, superseded, lets go of nothing (the newer one's hold kept), and the
      // newer asks while the editor is still frozen (read-only); declined, the editor is editable again, on A's entry,
      // its text kept. Asked LEAVE when the edit is durable in its draft, LEAVE_LOST when the draft couldn't be kept
      for (const lost of [false, true]) {
        const mark = `% two leaves${lost ? ", the draft lost" : ""}`;
        await watchX(fb);
        await ev(`(() => { window.__asks = []; window.confirm = (m) => { window.__asks.push({ m, ro: document.querySelector(".tex-src")?.readOnly }); return false; };
          window.__failP = new Promise((_, rej) => (window.__failNow = () => rej(new Error("test: the write failed")))); window.__failP.catch(() => {});
          window.__sbTexSaveWrite = () => window.__failP;
          if (${lost}) { window.__lsSet = localStorage.setItem; localStorage.setItem = function (k, v) { if (String(k).startsWith("sb-tex-draft:")) throw new Error("test: storage full"); return window.__lsSet.call(localStorage, k, v); }; }
          const t = document.querySelector(".tex-src"); t.value += ${JSON.stringify(mark + "\n")}; t.dispatchEvent(new Event("input")); return true; })()`);
        await sleep(1200);
        await ev(`(window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }), true)`); await sleep(100);
        await ev(`(window.__sbTex({ path: "/sw/c.tex", fid: ${JSON.stringify(fc)} }), true)`); await sleep(100);
        const frozen = await ev(`document.querySelector(".tex-src")?.readOnly === true`);
        await ev(`(window.__failNow(), true)`);
        await until(`window.__asks.length >= 1`, 10000); await sleep(800);
        const r = await ev(`({ asks: window.__asks.map((a) => ({ lost: /couldn't keep a copy/.test(a.m), ro: a.ro })), ro: document.querySelector(".tex-src")?.readOnly, url: new URLSearchParams(location.search).get("tex"), at: history.state && history.state.sbTex, src: document.querySelector(".tex-src")?.value.slice(-60), saw: window.__sawX })`);
        await ev(`(() => { if (window.__lsSet) { localStorage.setItem = window.__lsSet; delete window.__lsSet; } window.__obsB?.disconnect(); return true; })()`);
        await writesWork();
        await ev(`(() => { window.confirm = () => { window.__asked++; return window.__answer; }; const t = document.querySelector(".tex-src"); t.dispatchEvent(new Event("input")); return true; })()`); await saveStateIs(/^Saved/);
        check(frozen && r.asks.length === 1 && r.asks[0].ro === true && r.asks[0].lost === lost && r.ro === false && r.url === fa && r.at === 0 && r.src.includes(mark) && !r.saw,
          `U8-HOLD (grader H2, H4${lost ? ", H7" : ""}): two leaves at once, the write failing${lost ? " and the draft not kept" : ""}: asked once, ${lost ? "LEAVE_LOST" : "LEAVE"}, the editor still frozen while asked; declined, editable again on the file's entry, its text kept`, { frozen, r });
      }
      // (11) (grader L6) no Navigation API, the history on an entry of another script's (unnumbered, as a pushState of
      // its own leaves it) while the switch to B waits on A's close: A asked for again is pushed as a new entry, and
      // what waits for that runs at once: A opens there, editable; B never shown; A's edit written
      {
        const mark = "% a foreign entry";
        await watchX(fb); await holdClose(mark);
        await ev(`(window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }), true)`);
        const held = await until(`window.__k >= 2`, 10000);
        const went = await ev(`(() => { const was = window.navigation; Object.defineProperty(window, "navigation", { configurable: true, get: () => undefined });
          window.__navRestore = () => { Object.defineProperty(window, "navigation", { configurable: true, get: () => was }); };
          history.pushState({ other: 1 }, "", location.href);
          window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }); window.__rel(); return true; })()`);
        await shownIs(fa); await sleep(1500);
        const s = await stateOf(fa), fA = await textOf(fa);
        await ev(`(window.__navRestore?.(), delete window.__navRestore, window.__obsB?.disconnect(), true)`); await writesWork();
        check(went && held && s.url === fa && s.at === 1 && s.shows && s.ro === false && s.pages === 1 && !s.saw && s.kept && fA.includes(mark),
          "U8-RETURN (grader L6): no Navigation API, the history on another script's entry: the file shown asked for again is pushed as a new entry and opens there, editable; the other file never shown; its edit written", { went, held, s: { ...s, src: s.src.slice(-30) }, fileA: fA.slice(-30) });
        // (back on A, entry 0: three entries back)
        await ev(`(history.go(-3), true)`); await until(`history.state && history.state.sbTex === 0`, 20000); await shownIs(fa); await sleep(500);
      }
      // (12) (grader H9) a recovery ending while a leave holds the editor: A opened with another writer's draft (its
      // edit, never written), the recovery's last step (the adopted draft's IndexedDB drop) held; meanwhile a switch
      // to B asked for, its write held: when the recovery ends, the editor stays frozen (the leave's hold, not the
      // recovery's read-only alone); released, B opens and A's file has the recovered edit
      {
        const mark = "% recovered while leaving";
        const own = await ev(`(async () => {
          window.__sbTexSaveWrite = () => { throw new Error("test: the write failed"); };
          const t = document.querySelector(".tex-src"); t.value += ${JSON.stringify(mark + "\n")}; t.dispatchEvent(new Event("input"));
          await new Promise((r) => setTimeout(r, 1500));
          const k = Object.keys(localStorage).find((k) => k.startsWith("sb-tex-draft:" + ${JSON.stringify(fa)} + ":"));
          if (!k) return null; const d = JSON.parse(localStorage.getItem(k)); d.writerId = "0123456789abcdef0123456789abcdef"; window.__foreign = d; return { key: k, text: d.text.slice(-30) }; })()`);
        await ev(`(window.__answer = true, window.__sbTex({ path: "/sw/c.tex", fid: ${JSON.stringify(fc)} }), true)`); await shownIs(fc); await sleep(300);
        const seeded = await ev(`(() => { Object.keys(localStorage).filter((k) => k.startsWith("sb-tex-draft:" + ${JSON.stringify(fa)} + ":")).forEach((k) => localStorage.removeItem(k));
          const d = window.__foreign; localStorage.setItem("sb-tex-draft:" + d.fid + ":" + d.writerId, JSON.stringify(d));
          window.__idbHold = new Promise((r) => (window.__idbRel = r)); const orig = IDBDatabase.prototype.transaction; window.__idbOrig = orig;
          IDBDatabase.prototype.transaction = function (names, mode, ...rest) { const t = orig.call(this, names, mode, ...rest); if (mode !== "readwrite" || this.name !== "sagebrush-tex-drafts") return t;
            let f = null; t.addEventListener("complete", (e) => { const h = window.__idbHold; (h ? h : Promise.resolve()).then(() => f && f.call(t, e)); });
            Object.defineProperty(t, "oncomplete", { configurable: true, get: () => f, set: (v) => { f = v; } }); return t; };
          window.__hold = new Promise((r) => (window.__rel = r)); window.__sbTexSaveWrite = () => window.__hold; window.__answer = false; return true; })()`);
        await watchX(fb);
        await ev(`(window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }), true)`);
        const adopted = await until(`!!document.querySelector(".tex-src") && document.querySelector(".tex-title")?.textContent === "a.tex" && document.querySelector(".tex-src").value.includes(${JSON.stringify(mark)}) && document.querySelector(".tex-src").readOnly === true`, 15000);
        await ev(`(window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }), true)`); await sleep(300);
        await ev(`(window.__idbRel(), true)`); await sleep(600);
        const frozen = await ev(`({ ro: document.querySelector(".tex-src")?.readOnly, title: document.querySelector(".tex-title")?.textContent })`);
        await ev(`(window.__rel(), true)`);
        await shownIs(fb); await sleep(1000);
        const fA = await textOf(fa), s = await stateOf(fb);
        await ev(`(IDBDatabase.prototype.transaction = window.__idbOrig, delete window.__idbOrig, delete window.__idbHold, window.__obsB?.disconnect(), true)`); await writesWork();
        check(own && seeded && adopted && frozen.ro === true && frozen.title === "a.tex" && s.url === fb && s.ro === false && fA.includes(mark),
          "U8-HOLD (grader H9): a recovery ending while a leave holds the editor: the editor stays frozen (the hold kept); released, the other file opens and the recovered edit is written", { own, seeded, adopted, frozen, s: { ...s, src: s.src.slice(-30) }, fileA: fA.slice(-30) });
        // (back on A, entry 0: three entries back, B to A)
        await ev(`(window.__answer = true, history.go(-3), true)`); await until(`history.state && history.state.sbTex === 0`, 20000); await shownIs(fa); await sleep(500); await ev(`(window.__answer = false, true)`);
      }
      // (13) (astra, grader H10) a switch asked for while the file's editor is being made: A opened afresh, its read
      // held; the read released and B asked for in the same task, so A's editor replaces its placeholder (the
      // editor shown changing under the leave without a newer request): the request isn't lost: B opens
      {
        await ev(`(window.__sbTex({ path: "/sw/c.tex", fid: ${JSON.stringify(fc)} }), true)`); await shownIs(fc); await sleep(300);
        const armed = await ev(`(() => { const ws = window.__sbTexWs; if (!ws) return false; const orig = ws.readUpTo; window.__readOrig = orig;
          ws.readUpTo = function (p, n) { if (p !== "/sw/a.tex" || !window.__deferA) return orig.call(this, p, n); window.__deferA = false;
            let res, rej; const out = new Promise((a, b) => { res = a; rej = b; });
            orig.call(this, p, n).then((v) => { window.__readRel = () => res(v); }, (e) => { window.__readRel = () => rej(e); });
            return out; };
          window.__deferA = true; delete window.__readRel; return true; })()`);
        await watchX(fb);
        await ev(`(window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }), true)`);
        const readHeld = await until(`typeof window.__readRel === "function"`, 15000);
        const asked = await ev(`(() => { window.__readRel(); return window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }); })()`);
        const opened = await until(`document.querySelector(".tex-title")?.textContent === "b.tex" && new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fb)}`, 15000);
        await sleep(800);
        const s = await stateOf(fb);
        await ev(`(window.__sbTexWs.readUpTo = window.__readOrig, delete window.__readOrig, window.__obsB?.disconnect(), true)`);
        check(armed && readHeld && asked === true && opened && s.url === fb && s.title === "b.tex" && s.ro === false && s.pages === 1,
          "U8-HOLD (astra, grader H10): a switch asked for as the file's editor replaces its placeholder: the request isn't lost, the other file opens", { armed, readHeld, asked, opened, s: { ...s, src: s.src.slice(-30) } });
        // (back on A, entry 0)
        await ev(`(history.go(-(history.state && history.state.sbTex || 0)), true)`); await until(`history.state && history.state.sbTex === 0`, 20000); await shownIs(fa); await sleep(500);
      }
      // (the file shown, its writes failing (so leaving it asks), and the questions answered in turn from `answers`,
      //  each recorded with the file the URL was on when asked)
      const askInTurn = (answers) => ev(`(() => { window.__asks = []; window.__answers = ${JSON.stringify(answers)};
        window.confirm = () => { window.__asks.push(new URLSearchParams(location.search).get("tex")); return window.__answers.shift() === true; };
        window.__sbTexSaveWrite = () => { throw new Error("test: the write failed"); }; return true; })()`);
      const editFails = async (mark) => {
        await ev(`(() => { const t = document.querySelector(".tex-src"); t.value += ${JSON.stringify(mark + "\n")}; t.dispatchEvent(new Event("input")); return true; })()`);
        return saveStateIs(/^Not saved: test: the write failed/);
      };
      // (writes working again and the edit saved; the questions as the rest of this test answers them)
      const saveAgain = async () => {
        await ev(`(() => { window.confirm = () => { window.__asked++; return window.__answer; }; window.__sbTexSaveWrite = () => { if (window.__failWrites) throw new Error("test: the write failed"); };
          window.__answer = false; window.__asked = 4; const t = document.querySelector(".tex-src"); t.dispatchEvent(new Event("input")); return true; })()`);
        // (false, or what the save state says instead)
        return (await saveStateIs(/^Saved/, 20000)) || await ev(`"save: " + (document.querySelector(".tex-savestate")?.textContent ?? "none") + "; ro: " + document.querySelector(".tex-src")?.readOnly`);
      };
      // (the Navigation API's traverseTo, its first call made late (300 ms), the others as they are; or, hidden, the
      //  same for history.go: a return whose traversal is slow, a newer one after it not)
      const lateFirst = (withNav) => ev(`(() => { window.__late = 0;
        if (${withNav}) { const v = window.navigation; if (!v?.traverseTo) return false; const orig = v.traverseTo.bind(v);
          v.traverseTo = (k, o) => { if (window.__late++) return orig(k, o); const late = new Promise((r) => setTimeout(r, 300)); return { committed: late, finished: late.then(() => orig(k, o).finished) }; };
          window.__navRestore = () => { delete v.traverseTo; }; return true; }
        const was = window.navigation; Object.defineProperty(window, "navigation", { configurable: true, get: () => undefined });
        history.go = (d) => { if (window.__late++) return History.prototype.go.call(history, d); setTimeout(() => History.prototype.go.call(history, d), 300); };
        window.__navRestore = () => { delete history.go; Object.defineProperty(window, "navigation", { configurable: true, get: () => was }); }; return true; })()`);
      // (14) (grader V6, V7) a newer Back during a return that a file waits for: A 0, C 1, C#f 2, A 3, A shown, its
      // write failing. Back to C#f declined (the return's traversal late); B asked for and accepted, so B waits for that
      // return; then Back again, to C, declined: B, given up by that Back, never opens, and C is asked about (not
      // opened outright). A stays, editable, on its entry; asked three times, the last about C
      for (const withNav of [true, false]) {
        const mark = `% a newer Back while B waits ${withNav ? "nav" : "go"}`;
        await ev(`(window.__sbTex({ path: "/sw/c.tex", fid: ${JSON.stringify(fc)} }), true)`); await shownIs(fc); await sleep(300);
        await ev(`(location.hash = "#f", true)`); await until(`location.hash === "#f" && history.state && history.state.sbTex === 2`, 10000);
        await ev(`(window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }), true)`); await shownIs(fa); await sleep(300);
        await watchX(fb); await askInTurn([false, true, false]);
        const failed = await editFails(mark);
        const late = await lateFirst(withNav);
        await ev(`(history.back(), true)`);
        const asked1 = await until(`window.__asks.length >= 1`, 10000);
        const went = await ev(`(async () => {
          const pending = new URLSearchParams(location.search).get("tex") !== ${JSON.stringify(fa)};
          const accepted = window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} });
          for (let i = 0; i < 50 && window.__asks.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
          const asked2 = window.__asks.length, stillPending = new URLSearchParams(location.search).get("tex") !== ${JSON.stringify(fa)};
          history.back();
          return { pending, accepted, asked2, stillPending }; })()`);
        await until(`window.__asks.length >= 3`, 10000); await sleep(1500);
        const s = await stateOf(fa), asks = await ev(`window.__asks`), lates = await ev(`window.__late`);
        await ev(`(window.__navRestore?.(), delete window.__navRestore, window.__obsB?.disconnect(), true)`);
        const saved = await saveAgain(), fA = await textOf(fa);
        check(failed && late && asked1 && went && went.pending && went.accepted === true && went.asked2 === 2 && went.stillPending && lates >= 2
          && asks.length === 3 && asks[2] === fc && s.url === fa && s.at === 3 && s.title === "a.tex" && s.shows && s.ro === false && s.src.includes(mark) && s.pages === 1 && !s.saw && s.kept && saved === true && fA.includes(mark),
          `U8-RETURN (grader V6, V7; ${withNav ? "Navigation API" : "no Navigation API: history.go"}, the first return late): B waiting for a return, then a newer Back to C, declined: B never opens, C is asked about, not opened; A stays, editable, on its entry`, { failed, late, asked1, went, lates, asks, s: { ...s, src: s.src.slice(-30) }, saved, fileA: fA.slice(-30) });
        // (back on A, entry 0: three entries back)
        await ev(`(history.go(-3), true)`); await until(`history.state && history.state.sbTex === 0 && location.hash === ""`, 20000); await shownIs(fa); await sleep(500);
      }
      // (15) (grader V10) no Navigation API, a return by position landing on another script's entry (unnumbered): A 0,
      // that entry (its URL A's), B 1 shown, B's write failing; Back two steps, to A, declined: history.go(+1) lands on
      // the unnumbered entry, which is that return's landing, not a newer Back: B stays, no reload, A never opened, and
      // B's entry is pushed again after it
      {
        const mark = "% back past a foreign entry";
        await watchX(fa);
        const went = await ev(`(() => { const was = window.navigation; Object.defineProperty(window, "navigation", { configurable: true, get: () => undefined });
          window.__navRestore = () => { Object.defineProperty(window, "navigation", { configurable: true, get: () => was }); };
          history.pushState({ other: 1 }, "", location.href);
          window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }); return true; })()`);
        await shownIs(fb); await sleep(300);
        const at0 = await ev(`history.state && history.state.sbTex`), len0 = await ev(`history.length`);
        await ev(`(window.__sawX = false, true)`); await askInTurn([false]);
        const failed = await editFails(mark);
        await ev(`(history.go(-2), true)`);
        await until(`window.__asks.length >= 1`, 10000); await sleep(1500);
        const s = await stateOf(fb), asks = await ev(`window.__asks`), len = await ev(`history.length`);
        await ev(`(window.__navRestore?.(), delete window.__navRestore, window.__obsB?.disconnect(), true)`);
        const saved = await saveAgain();
        check(went && at0 === 1 && failed && asks.length === 1 && s.url === fb && s.at === 2 && len === len0 && s.title === "b.tex" && s.shows && s.ro === false && s.src.includes(mark) && s.pages === 1 && !s.saw && s.kept && saved === true,
          "U8-RETURN (grader V10; no Navigation API): a return by position landing on another script's unnumbered entry is that return's landing: B stays, editable, no reload, A never opened; B's entry pushed again after it", { went, at0, len0, len, failed, asks, s: { ...s, src: s.src.slice(-30) }, saved });
        // (back on A, entry 0: two entries back)
        await ev(`(window.__answer = true, history.go(-2), true)`); await until(`history.state && history.state.sbTex === 0`, 20000); await shownIs(fa); await sleep(500); await ev(`(window.__answer = false, true)`);
      }
      // (16) (grader W8; astra R16-FENCE-1, -2) the fence's take-back during a decided switch: A 0, B 1, C 2, A 3, A
      // shown, its write failing; every traversal 300 ms late. Back to C declined; Back again, to B, accepted: that
      // return superseded, B's mount waiting on A's close (its last write held). The stale return lands on A 3 and
      // the fence takes the history back to B 1, where the person went. Then, by variant:
      // - C: C asked for during the take-back, A's close released: C opens on the entry after B's; B never shown;
      // - none: B opens on B 1, its URL (never under A's); the return over, C asked for then opens;
      // - A, A mid: A asked for again once the take-back has landed, or while it is under way: A opens on A 3;
      // - refused, missing: the take-back refused, or its entry gone: B's entry pushed again (B 4, B's URL), B opens there;
      // - refused then A: that, then A asked for again before B's mount goes on: A opens on A 3 (B 4 isn't A's entry);
      // - back after, back before: the person's own Back, to C 2, during the take-back, A's close released before it
      //   or after: C opens on C 2; B never shown; the take-back, landing after all, taken back to C 2;
      // - refused after back: as back after, the take-back then refused: nothing more: C stays on C 2, no entry pushed;
      // - C then back: C asked for during the take-back, then the person's Back: C 2's C opens, and what waited for the
      //   return (C asked for) is gone: a Back from there opens B on B 1, nothing else
      const W8 = {
        C: { shown: fc, at: 2, ask: "C" }, none: { shown: fb, at: 1, after: true }, A: { shown: fa, at: 3, ask: "A", landed: true },
        "A mid": { shown: fa, at: 3, ask: "A" }, refused: { shown: fb, at: 4, after: true, refuse: true }, missing: { shown: fb, at: 4, after: true, missing: true },
        "refused then A": { shown: fa, at: 3, ask: "A", refuse: true, fallback: true },
        "back after": { shown: fc, at: 2, back: "after" }, "back before": { shown: fc, at: 2, back: "before" }, "refused after back": { shown: fc, at: 2, back: "after", refuse: true },
        "C then back": { shown: fc, at: 2, ask: "C", back: "after", probe: true },
      };
      for (const [then, v] of Object.entries(W8)) {
        const mark = `% the fence during a decided switch, then ${then}`;
        await ev(`(window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }), true)`); await shownIs(fb); await sleep(300);
        await ev(`(window.__sbTex({ path: "/sw/c.tex", fid: ${JSON.stringify(fc)} }), true)`); await shownIs(fc); await sleep(300);
        await ev(`(window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }), true)`); await shownIs(fa); await sleep(300);
        await askInTurn([false, true]);
        const failed = await editFails(mark);
        await watchX(v.shown === fb ? fc : fb);
        // (once the leave is accepted, the close's last write held; every title and entry the page shows, logged)
        await ev(`(() => { window.__hold = new Promise((r) => (window.__rel = r)); window.__k = 0;
          window.__sbTexSaveWrite = () => { if (window.__asks.length >= 2) { window.__k++; return window.__hold; } throw new Error("test: the write failed"); };
          window.__log = []; let last = ""; window.__logT = setInterval(() => { const t = document.title + " @" + new URLSearchParams(location.search).get("tex") + "/" + (history.state && history.state.sbTex); if (t !== last) window.__log.push(last = t); }, 5); return true; })()`);
        // (every traversal late; the fence's own, the second, refused if asked; the entries hidden if asked, from the
        //  second Back on, so the take-back finds its entry gone)
        const late = await ev(`(() => { const v = window.navigation; if (!v?.traverseTo) return false; const orig = v.traverseTo.bind(v), entries = v.entries.bind(v); window.__late = 0; window.__noEntries = false;
          v.traverseTo = (k, o) => { window.__late++;
            if (${!!v.refuse} && window.__late === 2) { const f = new Promise((_, rej) => setTimeout(() => rej(new Error("test: the traverse refused")), 300)); f.catch(() => {}); return { committed: f, finished: f }; }
            const late = new Promise((r) => setTimeout(r, 300)); return { committed: late, finished: late.then(() => orig(k, o).finished) }; };
          v.entries = () => window.__noEntries ? [] : entries();
          window.__navRestore = () => { delete v.traverseTo; delete v.entries; }; return true; })()`);
        await ev(`(history.back(), true)`);
        const asked1 = await until(`window.__asks.length >= 1`, 10000);
        await ev(`(window.__noEntries = ${!!v.missing}, history.back(), true)`);
        const held = await until(`window.__k >= 1`, 10000);
        // (the stale return landed on A 3 and the take-back started: its traversal the second; the entry gone: none)
        const fenced = v.missing || v.fallback ? await until(`new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fb)} && history.state && history.state.sbTex === 4`, 5000) : await until(`window.__late >= 2`, 5000);
        const onB = v.landed ? await until(`new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fb)}`, 5000) : true;
        const mid = await ev(`(async () => { const out = { url: new URLSearchParams(location.search).get("tex"), at: history.state && history.state.sbTex };
          if (${JSON.stringify(v.ask ?? "")} === "C") out.accepted = window.__sbTex({ path: "/sw/c.tex", fid: ${JSON.stringify(fc)} });
          if (${JSON.stringify(v.ask ?? "")} === "A") out.accepted = window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} });
          if (${JSON.stringify(v.back ?? "")} === "before") { history.back(); await new Promise((r) => setTimeout(r, 150)); }
          window.__rel();
          if (${JSON.stringify(v.back ?? "")} === "after") { await new Promise((r) => setTimeout(r, 50)); history.back(); }
          out.len = history.length; return out; })()`);
        const opened = await shownIs(v.shown); await sleep(1500);
        const s = await stateOf(v.shown), asks = await ev(`window.__asks`), len = await ev(`history.length`), log = await ev(`(clearInterval(window.__logT), window.__log)`);
        await ev(`(window.__navRestore?.(), delete window.__navRestore, window.__obsB?.disconnect(), true)`);
        const probe = !v.probe ? null : await ev(`(history.back(), true)`).then(() => shownIs(fb)).then(async (ok) => { await sleep(800); return { ok, ...(await stateOf(fb)), len: await ev(`history.length`) }; });
        // (the return over: C asked for now opens, on the entry after)
        const after = !v.after ? null : await ev(`(window.__sbTex({ path: "/sw/c.tex", fid: ${JSON.stringify(fc)} }), true)`).then(() => shownIs(fc)).then(async (ok) => ({ ok, ...(await stateOf(fc)) }));
        const saved = !v.after ? await saveAgain() : await ev(`(() => { window.confirm = () => { window.__asked++; return window.__answer; }; window.__sbTexSaveWrite = () => { if (window.__failWrites) throw new Error("test: the write failed"); }; window.__answer = false; window.__asked = 4; return true; })()`);
        const fA = await textOf(fa);
        const name = { [fa]: "a.tex", [fb]: "b.tex", [fc]: "c.tex" };
        // (B, the decided switch's file, never under another file's URL (astra R16-FENCE-1); a superseded take-back's
        //  own landing can show the file shown under its entry until the fence takes it back, as in U8-SWITCH-6)
        const wrongUrl = log.filter((t) => t.startsWith("b.tex") && !t.includes("@" + fb + "/"));
        check(failed && late && asked1 && held && fenced && onB && (v.ask ? mid.accepted === true : true) && asks.length === 2 && opened
          && s.url === v.shown && s.at === v.at && s.title === name[v.shown] && s.ro === false && s.pages === 1 && s.kept && s.shows && wrongUrl.length === 0
          && (v.shown !== fb ? !s.saw && !log.some((t) => t.startsWith("b.tex")) : true) && (then === "refused after back" ? len === mid.len : true)
          && (v.probe ? probe.ok && probe.url === fb && probe.at === 1 && probe.title === "b.tex" && probe.len === len : true)
          && (v.after ? after.ok && after.url === fc && after.at === v.at + 1 && after.title === "c.tex" : true) && saved === true && fA.includes(mark),
          `U8-RETURN (grader W8, astra R16-FENCE; Navigation API, its traversals late): the fence's take-back during a decided switch, then ${then}: ${name[v.shown]} opens, editable, on entry ${v.at}, its URL; no file under another's URL${v.after ? "; the return over, a file asked for then opens" : ""}; A's edit written`,
          { then, s: { ...s, src: s.src.slice(-30) }, wrongUrl, after, probe, saved, fileA: fA.slice(-30), failed, late, asked1, held, fenced, onB, mid, len, opened, asks, log });
        // (back on A, entry 0)
        await ev(`(history.go(-(history.state && history.state.sbTex || 0)), true)`); await until(`history.state && history.state.sbTex === 0`, 20000); await shownIs(fa); await sleep(500);
      }
      // (17) (grader H8) the editor read-only for a recovery, and a leave's hold let go: A opened with another writer's
      // draft (its edit, never written), the recovery's last step (the adopted draft's IndexedDB drop) held; a switch to
      // B asked for, its write failing, declined: the leave lets go of its hold, but the editor stays read-only (the
      // recovery's), and the bar as it was; the recovery ended, the editor is editable and the edit written
      {
        const mark = "% recovered, a leave declined";
        const own = await ev(`(async () => {
          window.__sbTexSaveWrite = () => { throw new Error("test: the write failed"); };
          const t = document.querySelector(".tex-src"); t.value += ${JSON.stringify(mark + "\n")}; t.dispatchEvent(new Event("input"));
          await new Promise((r) => setTimeout(r, 1500));
          const k = Object.keys(localStorage).find((k) => k.startsWith("sb-tex-draft:" + ${JSON.stringify(fa)} + ":"));
          if (!k) return null; const d = JSON.parse(localStorage.getItem(k)); d.writerId = "0123456789abcdef0123456789abcdef"; window.__foreign = d; return { key: k, text: d.text.slice(-30) }; })()`);
        await ev(`(window.__answer = true, window.__sbTex({ path: "/sw/c.tex", fid: ${JSON.stringify(fc)} }), true)`); await shownIs(fc); await sleep(300);
        const seeded = await ev(`(() => { Object.keys(localStorage).filter((k) => k.startsWith("sb-tex-draft:" + ${JSON.stringify(fa)} + ":")).forEach((k) => localStorage.removeItem(k));
          const d = window.__foreign; localStorage.setItem("sb-tex-draft:" + d.fid + ":" + d.writerId, JSON.stringify(d));
          window.__idbHold = new Promise((r) => (window.__idbRel = r)); const orig = IDBDatabase.prototype.transaction; window.__idbOrig = orig;
          IDBDatabase.prototype.transaction = function (names, mode, ...rest) { const t = orig.call(this, names, mode, ...rest); if (mode !== "readwrite" || this.name !== "sagebrush-tex-drafts") return t;
            let f = null; t.addEventListener("complete", (e) => { const h = window.__idbHold; (h ? h : Promise.resolve()).then(() => f && f.call(t, e)); });
            Object.defineProperty(t, "oncomplete", { configurable: true, get: () => f, set: (v) => { f = v; } }); return t; };
          window.__sbTexSaveWrite = () => { throw new Error("test: the write failed"); }; window.__answer = false; return true; })()`);
        await watchX(fb);
        await ev(`(window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }), true)`);
        const adopted = await until(`!!document.querySelector(".tex-src") && document.querySelector(".tex-title")?.textContent === "a.tex" && document.querySelector(".tex-src").value.includes(${JSON.stringify(mark)}) && document.querySelector(".tex-src").readOnly === true`, 15000);
        const look = `({ ro: document.querySelector(".tex-src")?.readOnly, title: document.querySelector(".tex-title")?.textContent, url: new URLSearchParams(location.search).get("tex"), asked: window.__asked, bar: (() => { const b = document.querySelector(".tex-conflict"); return b && !b.hidden ? b.textContent.slice(0, 80) : ""; })() })`;
        const before = await ev(look);
        await ev(`(window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }), true)`);
        const asked = await until(`window.__asked > ${before.asked}`, 10000); await sleep(600);
        const after = await ev(look);
        await ev(`(window.__idbRel(), IDBDatabase.prototype.transaction = window.__idbOrig, delete window.__idbOrig, delete window.__idbHold, true)`);
        await writesWork();
        const editable = await until(`document.querySelector(".tex-src")?.readOnly === false`, 15000);
        await ev(`(() => { const t = document.querySelector(".tex-src"); t.dispatchEvent(new Event("input")); return true; })()`);
        const saved = await saveStateIs(/^Saved/), fA = await textOf(fa), saw = await ev(`window.__sawX`);
        await ev(`(window.__obsB?.disconnect(), true)`);
        check(own && seeded && adopted && before.ro === true && asked && after.asked === before.asked + 1 && after.ro === true && after.title === "a.tex" && after.url === fa && after.bar === before.bar && !saw && editable && saved === true && fA.includes(mark),
          "U8-HOLD (grader H8): a leave declined while the editor is read-only for a recovery: its hold let go, the editor stays read-only (the recovery's), the bar as it was; the recovery ended, editable and the edit written", { own, seeded, adopted, before, asked, after, saw, editable, saved, fileA: fA.slice(-30) });
        // (back on A, entry 0)
        await ev(`(history.go(-(history.state && history.state.sbTex || 0)), true)`); await until(`history.state && history.state.sbTex === 0`, 20000); await shownIs(fa); await sleep(500);
      }
      // (18) (grader G6) the person's own Back while the fence's take-back is under way, the file shown current; the
      // take-back then refused: the fence ends anyway, so the next file asked for opens. C 1, A 2, B 3 after A's entry 0,
      // A shown; the switch to B decided (A's close held), A asked for again (its return held), A's close released, and
      // Back two entries to C: C opens, current. The held return then lands, stale, on A 2: the take-back to C starts
      // (held); the person's Back, two entries, to A 0: C's own listener takes it (C current); and only then the take-back
      // refused. Each step released by the test, not a timer: A opens on its entry 0, its URL, the refused take-back
      // having ended the fence; B never shown
      {
        const mark = "% the fence refused after the person's Back";
        await ev(`(window.__sbTex({ path: "/sw/c.tex", fid: ${JSON.stringify(fc)} }), true)`); await shownIs(fc); await sleep(300);
        await ev(`(window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }), true)`); await shownIs(fa); await sleep(300);
        await watchX(fb); await holdClose(mark);
        const nav = await ev(`(() => { const v = window.navigation; if (!v?.traverseTo) return false; const orig = v.traverseTo.bind(v); window.__late = 0;
          v.traverseTo = (k, o) => { const n = ++window.__late;
            if (n === 2) { const f = new Promise((_, rej) => (window.__refuse = () => rej(new Error("test: the traverse refused")))); f.catch(() => {}); return { committed: f, finished: f }; }
            const late = new Promise((r) => (window.__land = r)); return { committed: late, finished: late.then(() => orig(k, o).finished) }; };
          window.__navRestore = () => { delete v.traverseTo; }; return true; })()`);
        await ev(`(window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }), true)`);
        const held = await until(`window.__k >= 2`, 10000);
        await ev(`(async () => { window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }); window.__rel(); await new Promise((r) => setTimeout(r, 50)); history.go(-2); return 1; })()`);
        const onC = await shownIs(fc);
        // (the held return released: it lands, stale, and the take-back starts: the second traversal)
        await ev(`(window.__land(), true)`);
        const fenced = await until(`window.__late >= 2`, 10000);
        const mid = await ev(`({ url: new URLSearchParams(location.search).get("tex"), at: history.state && history.state.sbTex, title: document.querySelector(".tex-title")?.textContent, ro: document.querySelector(".tex-src")?.readOnly })`);
        await ev(`(history.go(-2), true)`);
        // (the person's Back taken (A 0's entry), then the take-back refused)
        const back = await until(`new URLSearchParams(location.search).get("tex") === ${JSON.stringify(fa)} && history.state && history.state.sbTex === 0`, 10000);
        await sleep(500);
        await ev(`(window.__refuse(), true)`);
        const opened = await shownIs(fa); await sleep(1500);
        const s = await stateOf(fa), fA = await textOf(fa);
        await ev(`(window.__navRestore?.(), delete window.__navRestore, window.__obsB?.disconnect(), true)`); await writesWork();
        check(nav && held && onC && fenced && back && mid.title === "c.tex" && mid.url === fa && mid.at === 2 && opened && s.url === fa && s.at === 0 && s.title === "a.tex" && s.shows && s.ro === false && s.pages === 1 && !s.saw && s.kept && fA.includes(mark),
          "U8-RETURN (grader G6; Navigation API): the person's own Back while the fence's take-back is under way (the file shown current), the take-back then refused: the fence ends, and the file gone back to opens, editable, on its entry, its URL; B never shown", { nav, held, onC, fenced, back, mid, opened, s: { ...s, src: s.src.slice(-30) }, fileA: fA.slice(-30) });
        // (back on A, entry 0: there)
        await until(`history.state && history.state.sbTex === 0`, 20000); await shownIs(fa); await sleep(500);
      }
    }
    // (SB_STOP_U8: the run ends here, after the switch and return cases: for mutant runs of those)
    if (process.env.SB_STOP_U8) throw new Error("stopped after the U8 block (SB_STOP_U8)");
    // ---- (astra B5-R1-A1) the exact entry shown is the one gone back to, a fragment's entry between: A, A#section, B;
    // with unsaved B, Back one step and Back two steps, declined, stay on B (its entry, URL and text); accepted two
    // steps, A; with unsaved A, Forward two steps declined stays on A. With the Navigation API and, hidden, without it
    for (const withNav of [true, false]) {
      const r = await ev(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const until = async (f) => { for (let i = 0; i < 100 && !f(); i++) await wait(100); return f(); };
        const shows = (s) => !!document.querySelector(".tex-preview")?.textContent.includes(s);
        if (!${withNav}) Object.defineProperty(window, "navigation", { configurable: true, get: () => undefined });
        const at = () => ({ url: new URLSearchParams(location.search).get("tex"), hash: location.hash, at: history.state && history.state.sbTex, title: document.querySelector(".tex-title")?.textContent, src: document.querySelector(".tex-src")?.value ?? "", pages: document.querySelectorAll(".tex-page").length });
        const edit = (m) => { const t = document.querySelector(".tex-src"); t.value += m; t.dispatchEvent(new Event("input")); };
        const out = { nav: typeof window.navigation?.traverseTo === "function" };
        // (an edit, then its write failed: the one state that asks before leaving)
        const failed = () => until(() => /^Not saved/.test(document.querySelector(".tex-savestate")?.textContent ?? ""));
        location.hash = "section"; await wait(300);
        out.hash = at();
        window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }); await until(() => shows("File B here."));
        out.b = at();
        window.__failWrites = true; edit("% unsaved in B\\n"); await failed();
        let before = window.__asked; window.__answer = false;
        history.back(); await wait(1500);
        out.back1 = { asked: window.__asked - before, ...at() };
        before = window.__asked;
        history.go(-2); await wait(1500);
        out.back2 = { asked: window.__asked - before, ...at() };
        before = window.__asked; window.__answer = true;
        history.go(-2); await until(() => shows("File A here.")); await wait(300);
        out.back2yes = { asked: window.__asked - before, ...at() };
        await wait(300); edit("% unsaved in A\\n"); await failed();
        before = window.__asked; window.__answer = false;
        history.go(2); await wait(1500);
        out.fwd2 = { asked: window.__asked - before, ...at() };
        // (leave A saved, at its first entry, for what follows: writes work again)
        window.__answer = true; history.go(2); await until(() => shows("File B here.")); await wait(300);
        history.go(-2); await until(() => shows("File A here.")); await wait(300);
        window.__failWrites = false; edit(""); await until(() => document.querySelector(".tex-savestate")?.textContent === "Saved ✓");
        out.end = at();
        if (!${withNav}) delete window.navigation;
        return out; })()`).catch((e) => ({ threw: String(e?.message ?? e).slice(0, 300) })) ?? { threw: "no result: the page's context ended (a reload or a navigation away)" };
      // (a reload or a lost page ends the evaluation: a failure, with what it was, not a crash of the whole test)
      if (r.threw) await until(`!!document.querySelector(".tex-page")`, 20000);
      const ok = !r.threw && r.nav === withNav && r.hash.url === fa && r.hash.hash === "#section" && r.hash.at === 1 && r.b.url === fb && r.b.at === 2
        && r.back1.asked === 1 && r.back1.url === fb && r.back1.hash === "" && r.back1.at === 2 && r.back1.title === "b.tex" && r.back1.src.includes("% unsaved in B") && r.back1.pages === 1
        && r.back2.asked === 1 && r.back2.url === fb && r.back2.hash === "" && r.back2.at === 2 && r.back2.title === "b.tex" && r.back2.src.includes("% unsaved in B")
        && r.back2yes.asked === 1 && r.back2yes.url === fa && r.back2yes.hash === "" && r.back2yes.at === 0 && r.back2yes.title === "a.tex"
        && r.fwd2.asked === 1 && r.fwd2.url === fa && r.fwd2.hash === "" && r.fwd2.at === 0 && r.fwd2.title === "a.tex" && r.fwd2.src.includes("% unsaved in A")
        && r.end.url === fa && r.end.at === 0;
      check(ok, `B5-R1-A1 (${withNav ? "Navigation API" : "no Navigation API"}): a fragment's entry between; Back one and two steps and Forward two steps, declined, stay on the exact entry shown, its URL and text; accepted, the other file`, r);
    }
    // ---- (astra B5-A2) a mount replaced while it waits stops there: A's read held, B opened and shown, then A's read
    // released: B's title stays, one live engine worker (B's), and the unsaved-text question is B's
    const a2 = await ev(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const W0 = window.__W0 ??= window.Worker; const made = []; window.Worker = class extends W0 { constructor(...a) { super(...a); const w = { live: true }; made.push(w); const t = this.terminate.bind(this); this.terminate = () => { w.live = false; t(); }; } };
      let release; window.__sbTexMountRead = (p) => p === "/sw/b.tex" ? new Promise((r) => { release = r; }) : undefined;
      window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} });
      for (let i = 0; i < 50 && !release; i++) await wait(100);
      const held = !!release;
      window.__sbTexMountRead = undefined;
      window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} });
      for (let i = 0; i < 100 && !document.querySelector(".tex-preview")?.textContent.includes("File A here."); i++) await wait(100);
      const shownA = !!document.querySelector(".tex-preview")?.textContent.includes("File A here.");
      release?.(); await wait(2000);
      const out = { held, shownA, title: document.querySelector(".tex-title")?.textContent, doc: document.title, url: new URLSearchParams(location.search).get("tex"), pages: document.querySelectorAll(".tex-page").length, made: made.length, live: made.filter((w) => w.live).length };
      window.__failWrites = true;
      const t = document.querySelector(".tex-src"); t.value += "% unsaved in A\\n"; t.dispatchEvent(new Event("input"));
      for (let i = 0; i < 50 && !/^Not saved/.test(document.querySelector(".tex-savestate")?.textContent ?? ""); i++) await wait(100);
      const before = window.__asked; window.__answer = false;
      window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} }); await wait(300);
      out.asked = window.__asked - before; out.stays = !!document.querySelector(".tex-preview")?.textContent.includes("File A here.") && document.querySelector(".tex-src").value.includes("% unsaved in A");
      window.Worker = W0;
      window.__failWrites = false; t.dispatchEvent(new Event("input"));
      return out; })()`);
    check(a2.held && a2.shownA && a2.title === "a.tex" && a2.doc.startsWith("a.tex") && a2.url === fa && a2.pages === 1 && a2.made === 1 && a2.live === 1 && a2.asked === 1 && a2.stays, "B5-A2: a mount replaced while its read waits stops: the newer file's title, one live worker, its unsaved text guarded", a2);
    await savedNow();
    // ---- (astra U8-SWITCH-1) quick switches A -> B -> C while A's write is held: only the newest, C, is shown, now
    // and after A's write lands (B, which waited for A's close, never replaces it); A's edit written
    const sw1 = await ev(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      let release; window.__sbTexSaveWrite = () => new Promise((r) => { release = r; });
      const t = document.querySelector(".tex-src"); t.value += "% A before the switches\\n"; t.dispatchEvent(new Event("input"));
      window.__sbTex({ path: "/sw/b.tex", fid: ${JSON.stringify(fb)} });
      await wait(50);
      window.__sbTex({ path: "/sw/c.tex", fid: ${JSON.stringify(fc)} });
      for (let i = 0; i < 50 && !release; i++) await wait(100);
      const held = !!release;
      delete window.__sbTexSaveWrite; release?.();
      for (let i = 0; i < 100 && !document.querySelector(".tex-preview")?.textContent.includes("File C here."); i++) await wait(100);
      await wait(2500);
      return { held, title: document.querySelector(".tex-title")?.textContent, c: !!document.querySelector(".tex-preview")?.textContent.includes("File C here."), b: !!document.querySelector(".tex-preview")?.textContent.includes("File B here."), pages: document.querySelectorAll(".tex-page").length };
    })()`);
    const aBytes = new TextDecoder().decode(new Uint8Array(await bytesOf("/sw/a.tex")));
    check(sw1.held && sw1.title === "c.tex" && sw1.c && !sw1.b && sw1.pages === 1 && aBytes.includes("% A before the switches"), "U8-SWITCH-1: A -> B -> C quickly while A's write is held: C shown, then and after A's write lands; A's edit written", { ...sw1, a: aBytes.slice(-60) });
    // ---- (#841, grader L3 and L4) "Saving before switching…" only when there is something to write: a switch from a
    // saved document, and from one that can't be saved here (mixed line endings) with an edit kept as a draft, never
    // says it (the record of the save state's texts sees it when it is said: DB3-U8-SWITCH-4)
    {
      const shown = (name) => until(`!!document.querySelector(".tex-src") && document.querySelector(".tex-title")?.textContent === ${JSON.stringify(name)} && document.querySelector(".tex-preview")?.textContent.includes(${JSON.stringify("File " + name[0].toUpperCase() + " here.")})`, 20000);
      const saved = await savedNow();
      await recordSave();
      await ev(`(window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }), true)`);
      const toA = await shown("a.tex"); await sleep(500);
      const said3 = await saidSoFar();
      check(saved && toA && !said3.includes("Saving before switching…"), "#841 L3: a switch from a saved document never says \"Saving before switching…\"", { saved, toA, said: said3 });
      const fr = await mk("/sw/r.tex", enc("\\documentclass{article}\r\n\\begin{document}\nFile R here.\n\\end{document}\n"));
      await ev(`(window.__sbTex({ path: "/sw/r.tex", fid: ${JSON.stringify(fr)} }), true)`);
      const toR = await shown("r.tex") && await saveStateIs(/^Read-only$/);
      await ev(`(() => { const t = document.querySelector(".tex-src"); t.value += "% kept as a draft in R\\n"; t.dispatchEvent(new Event("input")); return true; })()`);
      await sleep(1500);
      const ro = await ev(`document.querySelector(".tex-savestate")?.textContent ?? ""`);
      await recordSave();
      await ev(`(window.__answer = true, window.__sbTex({ path: "/sw/a.tex", fid: ${JSON.stringify(fa)} }), true)`);
      const fromR = await shown("a.tex"); await sleep(500);
      const said4 = await saidSoFar();
      await ev(`(window.__answer = false, Object.keys(localStorage).filter((k) => k.startsWith("sb-tex-draft:" + ${JSON.stringify(fr)} + ":")).forEach((k) => localStorage.removeItem(k)), true)`);
      check(toR && ro === "Read-only" && fromR && !said4.includes("Saving before switching…"), "#841 L4: a switch from a document that can't be saved here, edited, never says \"Saving before switching…\"", { toR, ro, fromR, said: said4 });
    }
    await ev(`localStorage.removeItem("sagebrush-files-sidebar"); delete window.__sbTexSaveWrite; delete window.__failWrites; true`);
  }
  // ---- comments on a document, end to end (plan latex-comments r4.2 §5): a person comments in the preview and the
  // source; an agent (this test, with the format's core, through the workspace: as the MCP tools will) lists them,
  // rewrites one commented sentence, deletes the other paragraph, duplicates a third's paragraph, replies and resolves;
  // the person opens the document again and sees each change: the resolved thread "rewritten" with the agent's labelled
  // reply, the removed one listed, the duplicated one needing a place (both candidates, attached to neither) until one
  // is chosen; a page write racing an agent's loses nothing; anchors follow the person's edits and are saved
  {
    const J = JSON.stringify;
    const TEX = "\\documentclass{article}\n\\begin{document}\nThe first claim is obvious from the definitions, as we show below.\n\nThis whole paragraph will be deleted by the agent.\n\nA middle paragraph stays as it is.\n\nA unique phrase sits here.\n\n\\end{document}\n";
    const ftex = await mk("/cm/paper.tex", enc(TEX)), SIDE = "/cm/paper.tex.comments.json";
    const agentIo = {
      read: async () => (await ev(`${W}.stat(${J(SIDE)}).then(async (e) => { if (!e || e.trashed) return null; const r = await ${W}.read(${J(SIDE)}); return { content: new TextDecoder().decode(r.content), base: r.entry.rev ?? 0 }; })`)) ?? { content: null, base: null },
      write: async (content, b) => {
        const res = await ev(`(async () => { try { const x = new TextEncoder().encode(${J(content)}); ${b === null ? `await ${W}.create(${J(SIDE)}, { content: x })` : `await ${W}.write(${J(SIDE)}, x, { base: ${J(b)} })`}; return "ok"; } catch (e) { return e?.code ?? String(e); } })()`);
        if (res === "conflict" || res === "exists") throw Object.assign(new Error(res), { code: "conflict" });
        if (res !== "ok") throw new Error(res);
      },
    };
    const texNow = async () => new TextDecoder().decode(new Uint8Array(await bytesOf("/cm/paper.tex")));
    const sideDoc = async () => C.parse((await agentIo.read()).content, {});
    const n0 = requests.length, e0 = errors.length;
    // (bubbles in a wide preview, badges in a narrow one: this window's preview may be either)
    const BUB = J(".sb-cm-bubble, .sb-cm-badge");
    await open(ftex);
    await until(`document.querySelector(".tex-preview")?.textContent.includes("A unique phrase")`, 20000);
    await sleep(500);
    check(!requests.slice(n0).some((u) => /sagebrush-latex-comments-doc/.test(u)), "comments: a document without a comments file doesn't fetch their chunk");
    // (1) the person: a comment on a preview selection (the Comment button), one on a source selection (Ctrl+Alt+M)
    const selectInPreview = (word) => ev(`(() => { const P = document.querySelector(".tex-preview"); const tw = document.createTreeWalker(P, NodeFilter.SHOW_TEXT);
      for (let t = tw.nextNode(); t; t = tw.nextNode()) { const i = t.data.indexOf(${J(word)}); if (i >= 0) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + ${word.length}); const s = getSelection(); s.removeAllRanges(); s.addRange(r); P.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); return true; } } return false; })()`);
    const post = (text) => ev(`(async () => { for (let i = 0; i < 100 && !document.querySelector(".sb-cm-compose textarea"); i++) await new Promise((r) => setTimeout(r, 50));
      const ta = document.querySelector(".sb-cm-compose textarea"); if (!ta) return false; ta.value = ${J(text)}; document.querySelector(".sb-cm-compose .sb-cm-send").click(); return true; })()`);
    // (the first comment loads the chunk: the button opens the list first)
    await ev(`(document.querySelector(".tex-comments").click(), true)`);
    await until(`!!document.querySelector(".sb-cm-list")`, 15000);
    await ev(`(document.querySelector(".sb-cm-list button").click(), true)`);
    await selectInPreview("is obvious");
    const goShown = await until(`!!document.querySelector(".sb-cm-go")`, 5000);
    await ev(`(document.querySelector(".sb-cm-go").click(), true)`);
    const p1 = await post("Why is it obvious? Give the argument.");
    const c1 = await until(`!!document.querySelector(${BUB})`, 15000);
    await ev(`(() => { const t = document.querySelector(".tex-src"), i = t.value.indexOf("This whole paragraph"); t.focus(); t.setSelectionRange(i, i + "This whole paragraph will be deleted by the agent.".length); return true; })()`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "m", code: "KeyM", modifiers: 1 | 2, windowsVirtualKeyCode: 77 });
    const p2 = await post("Do we need this paragraph?");
    await until(`document.querySelectorAll(${BUB}).length === 2`, 15000);
    await ev(`(() => { const t = document.querySelector(".tex-src"), i = t.value.indexOf("unique phrase"); t.focus(); t.setSelectionRange(i, i + "unique phrase".length); return true; })()`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "m", code: "KeyM", modifiers: 1 | 2, windowsVirtualKeyCode: 77 });
    const p3 = await post("Is this phrase right?");
    await until(`document.querySelectorAll(${BUB}).length === 3`, 15000);
    await sleep(500);
    const srcMarks = await ev(`(() => { const h = CSS.highlights.get("sb-comments"); return h ? h.size : 0; })()`);
    await shot("cm-1-three-comments");
    const d1 = await sideDoc();
    check(goShown && p1 && c1 && p2 && p3 && d1.threads.length === 3 && d1.threads.every((t) => t.messages[0].author === "person:me") && srcMarks >= 6, "comments: the person comments on a preview selection and two source selections (Ctrl/Cmd+Alt+M): three threads in the comments file, bubbles, marks in the preview and the source", { goShown, p1, c1, p2, p3, threads: d1.threads.length, srcMarks });
    // (2) the agent: list, then ordinary writes to the .tex, then a reply and resolve on the first
    const L1 = C.list(await sideDoc(), await texNow());
    const byQuote = (L, q) => L.threads.find((t) => t.quote.includes(q));
    const t1 = byQuote(L1, "is obvious"), t2 = byQuote(L1, "This whole paragraph"), t3 = byQuote(L1, "unique phrase");
    check(L1.threads.length === 3 && t1?.status === "exact" && t2?.status === "exact" && t3?.status === "exact" && t1.first.author === "person:me" && t1.range.start.line === 3, "comments: the agent lists the three threads, exact, with their lines and authors", L1.threads.map((t) => [t.status, t.quote, t.range?.start]));
    const TEX2 = TEX.replace("is obvious", "follows from Lemma 2").replace("This whole paragraph will be deleted by the agent.\n\n", "").replace("A unique phrase sits here.", "A unique phrase sits here.\n\nA unique phrase sits here.");
    await ev(`${W}.write("/cm/paper.tex", new TextEncoder().encode(${J(TEX2)})).then(() => true)`);
    const L2 = C.list(await sideDoc(), TEX2);
    const s1 = L2.threads.find((t) => t.id === t1.id), s2 = L2.threads.find((t) => t.id === t2.id), s3 = L2.threads.find((t) => t.id === t3.id);
    check(s1?.status === "changed" && s2?.status === "orphaned" && s3?.status === "ambiguous" && s3.candidates?.length === 2, "comments: after the agent's edit, the core sees the first rewritten (changed), the second removed (orphaned), the third ambiguous with 2 candidates", [s1?.status, s2?.status, s3?.status, s3?.candidates?.length]);
    await C.update(agentIo, (d) => C.reply(d, t1.id, { text: "Rewritten: it follows from Lemma 2.", author: "agent:claude" }));
    await C.update(agentIo, (d) => C.setResolved(d, t1.id, true, { author: "agent:claude" }));
    // (3) the person opens the document again
    await open(ftex);
    await until(`document.querySelector(".tex-preview")?.textContent.includes("Lemma 2")`, 20000);
    const loaded = await until(`/Comments \\(\\d+\\)/.test(document.querySelector(".tex-comments")?.textContent ?? "")`, 15000);
    await ev(`(document.querySelector(".tex-comments").click(), true)`);
    await until(`!!document.querySelector(".sb-cm-list h3")`, 10000);
    const view = await ev(`(() => { const L = document.querySelector(".sb-cm-list"), sec = {}; let cur = null;
      for (const n of L.children) { if (n.tagName === "H3") { cur = n.textContent.replace(/ \\(\\d+\\)$/, ""); sec[cur] = []; } else if (cur && n.classList.contains("sb-cm-item")) sec[cur].push({ id: n.dataset.thread, text: n.textContent, agent: n.classList.contains("agent"), label: !!n.querySelector(".sb-cm-agent"), cands: n.querySelectorAll(".sb-cm-cand").length }); }
      return { sec, button: document.querySelector(".tex-comments").textContent, bubbles: document.querySelectorAll(${BUB}).length }; })()`);
    await shot("cm-2-list-after-agent");
    const R = view.sec["Resolved"]?.find((x) => x.id === t1.id), O = view.sec["Comments on text that was removed"]?.find((x) => x.id === t2.id), A = view.sec["Needs a place"]?.find((x) => x.id === t3.id);
    check(loaded && R && R.agent && R.label && R.text.includes("Rewritten: it follows from Lemma 2.") && R.text.includes("the commented text was rewritten") && O && A && A.cands === 2 && view.bubbles === 0 && view.button === "Comments (2)",
      "comments: the person sees the first resolved, rewritten, with the agent's labelled reply; the second under removed text; the third needing a place (2 candidates, no bubble for any)", view);
    // (the third settled from the list: its second place)
    await ev(`(() => { const it = [...document.querySelectorAll(".sb-cm-item")].find((x) => x.dataset.thread === ${J(t3.id)}); it.querySelectorAll(".sb-cm-cand")[1].click(); return true; })()`);
    const settled = await until(`!document.querySelector(".sb-cm-cand") && document.querySelectorAll(${BUB}).length === 1`, 15000);
    const L3 = C.list(await sideDoc(), TEX2), s3b = L3.threads.find((t) => t.id === t3.id);
    check(settled && s3b?.status === "exact" && s3b.range.start.line === 9, "comments: choosing a place attaches the thread there (exact, the second occurrence's line), with its bubble", { settled, s3b: s3b && [s3b.status, s3b.range?.start] });
    // (4) a reply and reopen from the page; then a page write racing an agent's: both survive
    await ev(`(() => { [...document.querySelectorAll(".sb-cm-item")].find((x) => x.dataset.thread === ${J(t1.id)}).click(); return true; })()`);
    await until(`!!document.querySelector(".sb-cm-thread textarea")`, 5000);
    await shot("cm-3-thread");
    await ev(`(async () => { const ta = document.querySelector(".sb-cm-thread textarea"); ta.value = "Thanks, looks right."; document.querySelector(".sb-cm-thread .sb-cm-send").click(); for (let i = 0; i < 100 && !document.querySelector(".sb-cm-thread")?.textContent.includes("Thanks, looks right."); i++) await new Promise((r) => setTimeout(r, 50));
      document.querySelector(".sb-cm-thread .sb-cm-resolve").click(); return true; })()`);
    await sleep(1500);
    const d4 = await sideDoc(), th1 = d4.threads.find((t) => t.id === t1.id);
    check(th1 && th1.messages.length === 3 && th1.messages[2].author === "person:me" && th1.resolved.value === false && th1.resolved.by === "person:me", "comments: the person replies and reopens the agent's resolved thread, in the comments file", th1 && { n: th1.messages.length, resolved: th1.resolved });
    const raced = C.addThread(d4, { anchor: C.makeAnchor(TEX2, TEX2.indexOf("Lemma 2"), TEX2.indexOf("Lemma 2") + 7, undefined), text: "Agent: which Lemma 2?", author: "agent:claude" });
    // (the agent's write lands between the page's read and its write: the test build's hook, once)
    await ev(`(() => { window.__raced = 0; window.__sbTexCommentsWrite = async () => { if (window.__raced) return; window.__raced = 1;
      const r = await ${W}.read(${J(SIDE)}); await ${W}.write(${J(SIDE)}, new TextEncoder().encode(${J(C.serialize(raced.doc))}), { base: r.entry.rev ?? 0 }); }; return true; })()`);
    await ev(`(() => { const t = document.querySelector(".tex-src"), i = t.value.indexOf("definitions"); t.focus(); t.setSelectionRange(i, i + "definitions".length); return true; })()`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "m", code: "KeyM", modifiers: 1 | 2, windowsVirtualKeyCode: 77 });
    await post("Which definitions?");
    await sleep(2000);
    const d5 = await sideDoc(), texts = d5.threads.filter((t) => !t.deleted.value).map((t) => t.messages[0].text.value);
    const racedOnce = await ev(`window.__raced`);
    check(racedOnce === 1 && texts.includes("Agent: which Lemma 2?") && texts.includes("Which definitions?") && d5.threads.length === 5, "comments: a page comment racing an agent's write: one conflict, merged, both kept", { racedOnce, texts });
    // (5) the person's edits: anchors follow them, and Save writes them back for the saved text
    const before = C.list(d5, TEX2, { all: true }).threads.find((t) => t.id === t3.id);
    await ev(`(() => { const t = document.querySelector(".tex-src"), i = t.value.indexOf("\\\\begin{document}") + 17; t.setRangeText("Inserted line.\\n\\n", i, i, "end"); t.dispatchEvent(new Event("input")); return true; })()`);
    await sleep(800);
    await ctrlS(); await savedNow();
    await sleep(1500);
    const TEX3 = await texNow(), after = C.list(await sideDoc(), TEX3, { all: true }).threads.find((t) => t.id === t3.id);
    const a3 = (await sideDoc()).threads.find((t) => t.id === t3.id).anchor.value;
    check(before.status === "exact" && after?.status === "exact" && after.range.start.line === before.range.start.line + 2 && a3.textSha === C.sha256(TEX3) && TEX3.slice(a3.start, a3.end) === "unique phrase", "comments: an edit above moves the anchors with it, and Save writes them for the saved text (exact again)", { before: before?.range?.start, after: after?.range?.start, status: after?.status });
    // (6) LC-T5: an invalid comments file is refused, end to end: shown as unreadable, a new comment not saved over it
    {
      const fbad = await mk("/cm/bad.tex", enc("\\documentclass{article}\n\\begin{document}\nSome words to comment on.\n\\end{document}\n"));
      await mk("/cm/bad.tex.comments.json", enc("{ this is not json"));
      await open(fbad);
      await until(`document.querySelector(".tex-preview")?.textContent.includes("Some words")`, 20000);
      await ev(`(document.querySelector(".tex-comments").click(), true)`);
      const shownErr = await until(`/can't be read/.test(document.querySelector(".sb-cm-list .sb-cm-err")?.textContent ?? "")`, 15000);
      await ev(`(() => { const t = document.querySelector(".tex-src"), i = t.value.indexOf("Some words"); t.focus(); t.setSelectionRange(i, i + 10); return true; })()`);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "m", code: "KeyM", modifiers: 3, windowsVirtualKeyCode: 77 });
      await post("over a broken file");
      const refused = await until(`/Not saved/.test(document.querySelector(".sb-cm-compose .sb-cm-err")?.textContent ?? "") && document.querySelector(".sb-cm-compose textarea")?.value === "over a broken file"`, 15000);
      const still = new TextDecoder().decode(new Uint8Array(await bytesOf("/cm/bad.tex.comments.json")));
      check(shownErr && refused && still === "{ this is not json", "comments: an invalid comments file is shown as unreadable, a comment over it refused with the draft kept, the file untouched", { shownErr, refused, still });
    }
    // (7) LC-T5 / LC-T2: retries exhausted end to end: another writer on every attempt; after 5 conflicts, "busy", the
    // draft kept in the composer, nothing of it in the file
    {
      await open(ftex);
      await until(`/Comments \\(\\d+\\)/.test(document.querySelector(".tex-comments")?.textContent ?? "")`, 20000);
      await ev(`(() => { window.__writes = 0; window.__sbTexCommentsWrite = async () => { window.__writes++; const r = await ${W}.read(${J(SIDE)}); await ${W}.write(${J(SIDE)}, r.content, { base: r.entry.rev ?? 0 }); }; return true; })()`);
      await ev(`(() => { const t = document.querySelector(".tex-src"), i = t.value.indexOf("A middle"); t.focus(); t.setSelectionRange(i, i + 8); return true; })()`);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "m", code: "KeyM", modifiers: 3, windowsVirtualKeyCode: 77 });
      await post("never lands");
      const busy = await until(`/kept changing/.test(document.querySelector(".sb-cm-compose .sb-cm-err")?.textContent ?? "") && document.querySelector(".sb-cm-compose textarea")?.value === "never lands"`, 20000);
      const writes = await ev(`window.__writes`);
      await ev(`(delete window.__sbTexCommentsWrite, true)`);
      const dx = await sideDoc();
      check(busy && writes === 5 && !dx.threads.some((t) => t.messages.some((m) => m.text.value === "never lands")), "comments: on a conflict every attempt, five attempts then busy, the draft kept, nothing written", { busy, writes });
    }
    // (8) PR 316's bounds on re-finding and drawing, measured and printed: slices at most 8 ms up to 256 KiB and 32 ms
    // up to 2 MiB (the source limit); drawing and the list bounded by what is near the view (300 and 2,000 threads);
    // above 2 MiB comments refused, the comments file untouched
    // (a .tex of exactly `units` UTF-16 units, numbered phrases in paragraphs; `n` threads on phrases, moved (an
    // outside edit: their hash stale) or exact)
    const sized = (units) => {
      // (paragraphs of 20 numbered phrases, about 2 KB each: a 2 MiB document has about a thousand of the preview's groups,
      // not tens of thousands, whose patching alone would take minutes on a loaded box)
      const para = (i) => `Paragraph ${i}: ` + Array.from({ length: 20 }, (_, j) => `ordinary words for a long document, with a phrase numbered ${i * 20 + j}. `).join("") + "\n\n";
      const head = "\\documentclass{article}\n\\begin{document}\n", tail = "\\end{document}\n";
      let body = ""; for (let i = 0; head.length + body.length + para(i).length + tail.length < units - 2; i++) body += para(i);
      const t = head + body + "%".repeat(units - head.length - body.length - tail.length - 1) + "\n" + tail;
      if (t.length !== units) throw new Error("sized: " + t.length);
      return t;
    };
    // (each thread made alone and gathered: adding 2,000 to one growing document would copy it 2,000 times)
    const threadsOn = (text, n, stride, moved) => { const d = C.emptyDoc({}), sha = moved ? "stale" : C.sha256(text);
      for (let i = 0; i < n; i++) { const q = `a phrase numbered ${i * stride}.`, s = text.indexOf(q); if (s < 0) throw new Error("no " + q); d.threads.push(C.addThread(C.emptyDoc({}), { anchor: { ...C.makeAnchor(text, s, s + q.length, undefined, sha), textSha: sha }, text: "t" + i, author: "agent:claude" }).doc.threads[0]); }
      return d; };
    const measure = async (name, text, doc) => {
      const f = await mk(`/cm/${name}.tex`, enc(text)); await mk(`/cm/${name}.tex.comments.json`, enc(C.serialize(doc)));
      await open(f);
      // (placed, and drawn once the preview is rendered: a draw that found the preview's groups)
      const tOpen = Date.now(), n = doc.threads.length, ok = await until(`performance.getEntriesByName("tex-comments-placed").some((m) => m.detail.threads === ${n}) && performance.getEntriesByName("tex-comments-drawn").some((m) => m.detail.threads === ${n} && m.detail.groups > 0)`, 300000);
      const renderS = Math.round((Date.now() - tOpen) / 1000);
      await sleep(300);
      const r = await ev(`(() => { const p = performance.getEntriesByName("tex-comments-placed").filter((m) => m.detail.threads === ${n}).at(-1)?.detail, d = performance.getEntriesByName("tex-comments-drawn").filter((m) => m.detail.threads === ${n}).map((m) => m.detail);
        const g = d.filter((x) => x.groups > 0);
        const worst = d.reduce((m, x) => (x.ms > (m?.ms ?? -1) ? x : m), null);
        return { placed: p, drawMaxMs: Math.max(...d.map((x) => x.ms)), drawMaxPhases: worst?.phases, drawn: g.at(-1)?.drawn, groups: g.at(-1)?.groups, draws: d.length }; })()`);
      // (steady state: draws from scrolling the preview, the page laid out already; the first draw after a fresh render
      // can be the one that makes the browser lay out the new preview, a layout the next frame would do anyway)
      const before = await ev(`performance.getEntriesByName("tex-comments-drawn").length`);
      for (const dy of [120, -120, 240, -240]) { await ev(`(document.querySelector(".tex-right").scrollBy(0, ${dy}), true)`); await sleep(250); }
      r.steady = await ev(`(() => { const d = performance.getEntriesByName("tex-comments-drawn").slice(${before}).map((m) => m.detail); return { draws: d.length, maxMs: d.length ? Math.max(...d.map((x) => x.ms)) : null, drawn: d.at(-1)?.drawn }; })()`);
      await ev(`(document.querySelector(".tex-comments").click(), true)`);
      await until(`performance.getEntriesByName("tex-comments-list").some((m) => m.detail.threads === ${n})`, 15000);
      r.list = await ev(`performance.getEntriesByName("tex-comments-list").filter((m) => m.detail.threads === ${n}).at(-1)?.detail`);
      r.ok = ok; r.renderS = renderS;
      console.log(`comments ${name} (${text.length} units, ${n} threads):`, JSON.stringify(r));
      return r;
    };
    {
      // the time bounds (PR 316): slices at most 8 ms up to 256 KiB and 32 ms up to 2 MiB; drawing within the same; checked
      // on a timing box, reported on a build box (its load and GC pauses aren't the code's: a sanity bound only)
      const timed = (r, ms, what) => {
        const t = { slice: r.placed?.maxSliceMs, phase: r.placed?.maxSlicePhase, maxStep: r.placed?.maxStep, draw: Math.max(r.drawMaxMs, r.steady?.maxMs ?? 0), list: r.list?.ms };
        if (BOX === "timing") check(t.slice <= ms && t.draw <= ms && t.list <= ms, `comments: ${what}: slices, drawing and the list each at most ${ms} ms (a timing box)`, t);
        else { console.log(`timing, reported, not gated (a build box): ${what}, bound ${ms} ms:`, JSON.stringify(t)); check(t.slice < 200 && t.draw < 200 && t.list < 200, `comments: ${what}: no slice, draw or list over 200 ms (a build box's sanity bound)`, t); }
      };
      // up to 256 KiB: 300 moved anchors (the work budget re-finds most: each moved or unresolved, none guessed)
      const t1 = sized(256 << 10), r1 = await measure("k256", t1, threadsOn(t1, 300, 8, true));
      const s1 = r1.placed?.statuses ?? {};
      check(r1.ok && (s1.moved ?? 0) > 0 && (s1.moved ?? 0) + (s1.unresolved ?? 0) === 300 && r1.placed.work <= C.LIMITS.workBudget && r1.drawn > 0 && r1.drawn < 200, "comments: 256 KiB, 300 moved anchors: placed in slices within the work budget (each moved or unresolved); drawn near the view", r1);
      timed(r1, 8, "256 KiB, 300 moved anchors");
      // exactly 2 MiB: works (300 moved anchors)
      const t2 = sized(C.LIMITS.sourceUnits), r2 = await measure("m2", t2, threadsOn(t2, 300, 50, true));
      const st = r2.placed?.statuses ?? {};
      check(r2.ok && r2.placed.work <= C.LIMITS.workBudget && (st.moved ?? 0) > 0 && (st.moved ?? 0) + (st.unresolved ?? 0) === 300 && r2.drawn > 0 && r2.drawn < 200, "comments: exactly 2 MiB, 300 moved anchors: placed within the work budget (each moved or unresolved), drawn near the view", r2);
      timed(r2, 32, "2 MiB, 300 moved anchors");
      // (the shared pass: the native search below its dispatch bound, 300 needles over 256 KiB; the pass above it, the
      // same over 2 MiB, its table's bytes reported)
      check(r1.placed?.pass?.path === "native" && r2.placed?.pass?.path === "pass" && r2.placed.pass.bytes > 0, "comments: the native search at 256 KiB with 300 anchors, the shared pass at 2 MiB (its bytes measured)", { k256: r1.placed?.pass, m2: r2.placed?.pass });
      // 1,800 moved anchors over exactly 2 MiB: the shared pass re-finds every one within the default work budget,
      // in slices and drawn near the view (quote-only anchors, as the 2,000 threads below; 1,800 of these quotes keep
      // the comments file under 2 MiB, about 1 KB a thread)
      const d5 = C.emptyDoc({});
      for (let i = 0; i < 1800; i++) { const q = `a phrase numbered ${i * 10}.`, s0 = t2.indexOf(q); if (s0 < 0) throw new Error("no " + q); d5.threads.push(C.addThread(C.emptyDoc({}), { anchor: { start: s0, end: s0 + q.length, quote: q, prefix: "", suffix: "" }, text: "x", author: "agent:a", time: "2026-10-31T00:00Z" }).doc.threads[0]); }
      const r5 = await measure("m2t1800", t2, d5), s5 = r5.placed?.statuses ?? {};
      check(r5.ok && r5.placed.pass?.path === "pass" && s5.moved === 1800 && r5.placed.work <= C.LIMITS.workBudget && r5.drawn > 0 && r5.drawn < 300 && r5.list.shown <= 100, "comments: exactly 2 MiB, 1,800 moved anchors: the shared pass re-finds all within the work budget; drawn near the view, the list's first 100", { placed: r5.placed, drawn: r5.drawn, list: r5.list });
      timed(r5, 32, "2 MiB, 1,800 moved anchors");
      // the admitted 2,000 live threads (astra's fixture: small threads, short times, a file under 2 MiB, though a new one
      // is refused past 1.75 MiB): on a document of 2,000 tokens, each thread re-found (moved) by its token, all placed;
      // drawing only near the view, the list's first 100 a section
      const toks = "\\documentclass{article}\n\\begin{document}\n" + Array.from({ length: 2000 }, (_, i) => `item w${i},\n\n`).join("") + "\n\\end{document}\n";
      const d3 = C.emptyDoc({});
      for (let i = 0; i < 2000; i++) { const q = `w${i},`, s0 = toks.indexOf("item " + q) + 5; d3.threads.push(C.addThread(C.emptyDoc({}), { anchor: { start: s0, end: s0 + q.length, quote: q, prefix: "", suffix: "" }, text: "x", author: "agent:a", time: "2026-10-30T00:00Z" }).doc.threads[0]); }
      const side3 = C.serialize(d3);
      const r3 = await measure("t2000", toks, d3);
      check(r3.ok && new TextEncoder().encode(side3).length <= C.LIMITS.sidecarBytes && r3.placed.statuses.moved === 2000 && r3.placed.pass?.path === "native" && r3.drawn > 0 && r3.drawn < 300 && r3.list.shown <= 100, "comments: 2,000 threads (all placed): drawn only near the view (bounded), the list's first 100", { ...r3, bytes: new TextEncoder().encode(side3).length });
      timed(r3, 8, "2,000 threads on a small document");
      // one unit over 2 MiB: refused with the size, nothing drawn or written, the comments file untouched
      const t4 = t2.replace("%", "%%"), d4 = threadsOn(t2, 3, 50, false), side4 = C.serialize(d4);
      const f4 = await mk("/cm/over.tex", enc(t4)); await mk("/cm/over.tex.comments.json", enc(side4));
      await open(f4);
      const label = await until(`document.querySelector(".tex-comments")?.textContent === "Comments: over 2 MiB"`, 30000);
      await ev(`(document.querySelector(".tex-comments").click(), true)`);
      const msg = await until(`document.querySelector(".sb-cm-list .sb-cm-refused")?.textContent === "Comments are available for documents up to 2 MiB (this one is 2.0 MiB)"`, 10000);
      const marks = await ev(`CSS.highlights.get("sb-comments")?.size ?? 0`), bub = await ev(`document.querySelectorAll(${BUB}).length`);
      const still = new TextDecoder().decode(new Uint8Array(await bytesOf("/cm/over.tex.comments.json")));
      check(t4.length === C.LIMITS.sourceUnits + 1 && label && msg && marks === 0 && bub === 0 && still === side4, "comments: one unit over 2 MiB: refused with the size on the Comments button and in its list, nothing shown, the comments file untouched", { label, msg, marks, bub, same: still === side4 });
    }
    // (9) LC316-A2: Save writes the anchors of the text it saved, from one snapshot: an edit while the .tex's write is
    // held moves nothing in what is written (the comment keeps its subject); and an agent's reattachment landing while
    // the anchors are written survives (the page skips a thread whose anchor changed since its snapshot)
    {
      const T = "\\documentclass{article}\n\\begin{document}\nAlpha words. Beta words here. Gamma words.\n\nA last line.\n\\end{document}\n";
      const fs9 = await mk("/cm/snap.tex", enc(T)), S9 = "/cm/snap.tex.comments.json";
      let d9 = C.emptyDoc({}); const ab = (q) => { const s = T.indexOf(q); return C.makeAnchor(T, s, s + q.length); };
      const r9a = C.addThread(d9, { anchor: ab("Beta words"), text: "on beta", ...{ author: "person:me" } }); d9 = r9a.doc;
      const r9b = C.addThread(d9, { anchor: ab("Gamma words"), text: "on gamma", author: "person:me" }); d9 = r9b.doc;
      await mk(S9, enc(C.serialize(d9)));
      await open(fs9);
      await until(`document.querySelectorAll(${BUB}).length === 2`, 20000);
      const side9 = async () => C.parse(new TextDecoder().decode(new Uint8Array(await bytesOf(S9))), {});
      const tex9 = async () => new TextDecoder().decode(new Uint8Array(await bytesOf("/cm/snap.tex")));
      // (a) an edit above the anchors, written; while that write is held, another edit before them (its own write held
      // too, so the first write's anchors are seen alone)
      await ev(`(() => { const t = document.querySelector(".tex-src"), i = t.value.indexOf("Alpha"); t.setRangeText("Zero. ", i, i, "end"); t.dispatchEvent(new Event("input"));
        const hold = () => { let r; const p = new Promise((x) => (r = x)); return { p, r }; }; window.__h1 = hold(); window.__h2 = hold(); const q = [window.__h1.p, window.__h2.p];
        window.__sbTexSaveWrite = () => q.shift(); return true; })()`);
      await ctrlS();
      await sleep(400);
      await ev(`(() => { const t = document.querySelector(".tex-src"), i = t.value.indexOf("Zero"); t.setRangeText("MORE TEXT ", i, i, "end"); t.dispatchEvent(new Event("input")); window.__h1.r(); return true; })()`);
      for (let i = 0; i < 60; i++) { const tx = await tex9(), an = (await side9()).threads.find((t) => t.id === r9a.id)?.anchor.value; if (tx.includes("Zero. Alpha") && an?.textSha === C.sha256(tx)) break; await sleep(100); }
      const saved9 = await tex9(), a9 = (await side9()).threads.find((t) => t.id === r9a.id).anchor.value;
      check(!saved9.includes("MORE TEXT") && saved9.includes("Zero. Alpha") && a9.textSha === C.sha256(saved9) && saved9.slice(a9.start, a9.end) === "Beta words" && a9.quote === "Beta words", "comments: an edit while the save's .tex write is held: the anchors written are the saved text's, each on its own words", { quote: a9.quote, at: saved9.slice(a9.start, a9.end) });
      await ev(`(window.__h2.r(), delete window.__sbTexSaveWrite, true)`); await savedNow();
      // (b) another edit written; the agent reattaches the gamma thread just before the page's anchor write
      const texAt = await ev(`document.querySelector(".tex-src").value`), gi = texAt.indexOf("A last line");
      const cur9 = await side9(), agentDoc = C.reattach(cur9, r9b.id, C.makeAnchor(texAt, gi, gi + 11), { author: "agent:claude" }).doc;
      await ev(`(() => { window.__raced9 = 0; window.__sbTexCommentsWrite = async () => { if (window.__raced9) return; window.__raced9 = 1;
        const r = await ${W}.read(${J(S9)}); await ${W}.write(${J(S9)}, new TextEncoder().encode(${J(C.serialize(agentDoc))}), { base: r.entry.rev ?? 0 }); };
        const t = document.querySelector(".tex-src"), i = t.value.indexOf("\\end{document}"); t.setRangeText("% (b)\\n", i, i, "end"); t.dispatchEvent(new Event("input")); return true; })()`);
      await ctrlS(); await savedNow(); await sleep(2000);
      await ev(`(delete window.__sbTexCommentsWrite, true)`);
      const saved9b = await tex9(), f9 = await side9(), g9 = f9.threads.find((t) => t.id === r9b.id).anchor.value, b9 = f9.threads.find((t) => t.id === r9a.id).anchor.value;
      check(await ev(`window.__raced9`) === 1 && g9.quote === "A last line" && g9.by === undefined && f9.threads.find((t) => t.id === r9b.id).anchor.by === "agent:claude" && b9.textSha === C.sha256(saved9b) && saved9b.slice(b9.start, b9.end) === "Beta words", "comments: an agent's reattachment landing during the page's anchor write survives the retry (the page skips that thread), the other anchor written for the saved text", { g: g9.quote, by: f9.threads.find((t) => t.id === r9b.id).anchor.by, b: saved9b.slice(b9.start, b9.end) });
    }
    check(errors.length === e0, "comments: no page errors", errors.slice(e0, e0 + 3));
    await ev(`(delete window.__sbTexCommentsWrite, true)`);
  }
  // ---- the embeddable editor (component.ts: mountEditor, for the questions site's LaTeX proof answers; exported by the
  // page module): in a host's box, with no files; rendered() and groups() with source ranges (UTF-16 offsets into the
  // text); a preview selection mapped to its source (sourceRangeOf) and back (previewRangesOf); a person's edit
  // reported (onChange, debounced), the host's setText not; read only and preview alone; stacked on a phone; destroy
  {
    await go(base + "?latex=1"); await until(`!!${W}`, 60000);
    const PROOF = "\\documentclass{article}\n\\begin{document}\n\\section*{Proof}\nLet $n$ be even, say $n = 2k$.\n\nThen $n^2 = 4k^2$ is even.\n\n\\end{document}\n";
    const c1 = await ev(`(async () => {
      const box = document.createElement("div"); box.id = "embed1"; box.style.cssText = "width:640px;height:420px"; document.body.prepend(box);
      window.__changes = [];
      const x = await import("/sagebrush-latex.js");
      window.__ed = x.mountEditor(box, { text: ${JSON.stringify(PROOF)}, onChange: (t) => window.__changes.push(t) });
      const done = await Promise.race([window.__ed.rendered().then(() => true), new Promise((r) => setTimeout(() => r(false), 20000))]);
      const g = window.__ed.groups(), t = window.__ed.getText(), r = box.getBoundingClientRect(), P = window.__ed.previewRoot();
      return { done, n: g.length, ok: g.every((x) => x.start >= 0 && x.start <= x.end && x.end <= t.length && box.contains(x.el)), starts: g.map((x) => x.start),
        h: Math.round(r.height), fixed: getComputedStyle(box.firstElementChild).position, text: P.textContent.includes("Then"), files: !!box.querySelector(".tex-head, .tex-save, .tex-back") };
    })()`);
    check(c1.done && c1.n >= 2 && c1.ok && c1.h === 420 && c1.fixed === "relative" && c1.text && !c1.files, "component: in a 640 x 420 box (not fixed, no file controls), rendered() resolves, groups() with source ranges in the text", c1);
    const c2 = await ev(`(() => {
      const t = window.__ed.getText(), P = window.__ed.previewRoot();
      const tw = document.createTreeWalker(P, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode()) && !n.data.includes("Then")) {}
      if (!n) return { err: "no Then in the preview" };
      const r = document.createRange(), i = n.data.indexOf("Then"); r.setStart(n, i); r.setEnd(n, i + 4);
      const src = window.__ed.sourceRangeOf(r), want = t.indexOf("Then");
      const back = window.__ed.previewRangesOf(want, want + 4);
      return { src, want, back: back.length, hasThen: back.some((g) => g.textContent.includes("Then")), none: window.__ed.previewRangesOf(t.length + 5, t.length + 9).length };
    })()`);
    check(c2.src && c2.src.start === c2.want && c2.src.end === c2.want + 4 && c2.back === 1 && c2.hasThen && c2.none === 0, "component: a selection of 'Then' in the preview maps to its source offsets, and those offsets back to its group", c2);
    const c3 = await ev(`(async () => {
      const ta = document.querySelector("#embed1 .tex-src"), t0 = ta.value;
      ta.value = t0.replace("is even.", "is even, as required."); ta.dispatchEvent(new Event("input"));
      await new Promise((r) => setTimeout(r, 450));
      const afterEdit = window.__changes.slice();
      await window.__ed.rendered();
      const shown = window.__ed.previewRoot().textContent.includes("as required");
      window.__ed.setText(window.__ed.getText().replace("Proof", "Proof (setText)"));
      await new Promise((r) => setTimeout(r, 450));
      await window.__ed.rendered();
      return { afterEdit: afterEdit.length, last: (afterEdit[afterEdit.length - 1] ?? "").includes("as required"), shown, setTextShown: window.__ed.previewRoot().textContent.includes("Proof (setText)"), afterSet: window.__changes.length };
    })()`);
    check(c3.afterEdit === 1 && c3.last && c3.shown && c3.setTextShown && c3.afterSet === 1, "component: a person's edit reported once (debounced) and rendered; the host's setText rendered, not reported", c3);
    const c4 = await ev(`(async () => {
      const box = document.createElement("div"); box.id = "embed2"; box.style.cssText = "width:500px;height:300px"; document.body.prepend(box);
      const x = await import("/sagebrush-latex.js");
      const ed = x.mountEditor(box, { text: ${JSON.stringify(PROOF)}, readOnly: true, layout: "preview" });
      await Promise.race([ed.rendered(), new Promise((r) => setTimeout(r, 20000))]);
      const left = box.querySelector(".tex-left"), right = box.querySelector(".tex-right");
      const out = { ro: box.querySelector(".tex-src").readOnly, leftShown: getComputedStyle(left).display !== "none", rightW: Math.round(right.getBoundingClientRect().width), text: ed.previewRoot().textContent.includes("Then") };
      ed.destroy(); out.destroyed = box.childElementCount === 0;
      return out;
    })()`);
    check(c4.ro && !c4.leftShown && c4.rightW >= 480 && c4.text && c4.destroyed, "component: readOnly with layout preview: the source read only and hidden, the preview the box's width; destroy empties the box", c4);
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    const c5 = await ev(`(() => { const box = document.getElementById("embed1"); box.style.width = "360px"; const l = box.querySelector(".tex-left").getBoundingClientRect(), r = box.querySelector(".tex-right").getBoundingClientRect();
      return { lTop: Math.round(l.top), rTop: Math.round(r.top), lW: Math.round(l.width), rW: Math.round(r.width), both: l.height > 40 && r.height > 40 }; })()`);
    check(c5.both && c5.rTop > c5.lTop && c5.lW >= 340 && c5.rW >= 340, "component: on a phone the source and the preview are stacked, both shown", c5);
    await send("Emulation.clearDeviceMetricsOverride");
    await ev(`(window.__ed.destroy(), true)`);
  }
  // ---- comments on the preview (comments.ts cut 1, for grading): a grader's read-only, preview-only editor in a wide
  // box: "Then" selected, c opens the composer (focused), Ctrl+Enter posts; saved once, a margin bubble with the text,
  // the word highlighted (CSS Highlight API); the student's view (mode view): the bubble shown, c does nothing; a
  // narrow box: a badge, tapped, opens a sheet; the Comment button by a selection opens the composer too
  {
    // (the comments' own chunk: not fetched by anything before this, then fetched by the first attachComments)
    const commentsFetched = () => requests.filter((u) => /sagebrush-latex-comments\.js/.test(u)).length;
    check(commentsFetched() === 0, "comments: their chunk not fetched by the editor, the examples or the component without comments", requests.filter((u) => /sagebrush-latex/.test(u)).slice(-5));
    await go(base + "?latex=1"); await until(`!!${W}`, 60000);
    const PROOF = "\\documentclass{article}\n\\begin{document}\n\\section*{Proof}\nLet $n$ be even, say $n = 2k$.\n\nThen $n^2 = 4k^2$ is even.\n\n\\end{document}\n";
    const mountC = (id, w, mode, threads) => ev(`(async () => {
      const box = document.createElement("div"); box.id = ${JSON.stringify(id)}; box.style.cssText = "width:${w}px;height:420px"; document.body.prepend(box);
      const x = await import("/sagebrush-latex.js");
      const ed = x.mountEditor(box, { text: ${JSON.stringify(PROOF)}, readOnly: true, layout: "preview" });
      await Promise.race([ed.rendered(), new Promise((r) => setTimeout(r, 20000))]);
      window.__saves = window.__saves || {}; window.__saves[${JSON.stringify(id)}] = [];
      const store = ${JSON.stringify(threads)};
      window["__cm_" + ${JSON.stringify(id)}] = await x.attachComments(ed, { load: () => store, save: (t) => window.__saves[${JSON.stringify(id)}].push(t), mode: ${JSON.stringify(mode)}, author: "instructor", single: true });
      window["__ed_" + ${JSON.stringify(id)}] = ed;
      return true;
    })()`);
    const selectThen = (id) => ev(`(() => { const P = document.querySelector("#${id} .tex-preview"); const tw = document.createTreeWalker(P, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode()) && !n.data.includes("Then")) {}
      if (!n) return false; const r = document.createRange(), i = n.data.indexOf("Then"); r.setStart(n, i); r.setEnd(n, i + 4); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`);
    await mountC("cmg", 900, "comment", []);
    check(commentsFetched() >= 1, "comments: their chunk fetched once comments are attached");
    const sel1 = await selectThen("cmg");
    const k1 = await ev(`(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true })); await new Promise((r) => setTimeout(r, 50));
      const a = document.activeElement; const focused = !!a && a.tagName === "TEXTAREA" && !!a.closest(".sb-cm-compose");
      if (focused) { a.value = "Say why n^2 is even here."; a.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); }
      await new Promise((r) => setTimeout(r, 100));
      const saves = window.__saves.cmg, last = saves[saves.length - 1] || [], b = document.querySelectorAll("#cmg .sb-cm-bubble");
      return { focused, saves: saves.length, n: last.length, quote: last[0]?.anchor.quote, author: last[0]?.messages[0]?.author, bubbles: b.length, text: b[0]?.textContent ?? "", hl: CSS.highlights?.get("sb-comments")?.size ?? -1, count: window.__cm_cmg.count() }; })()`);
    check(sel1 && k1.focused && k1.saves === 1 && k1.n === 1 && k1.quote === "Then" && k1.author === "instructor" && k1.bubbles === 1 && k1.text.includes("Say why") && k1.hl === 1 && k1.count === 1,
      "comments: a grader selects 'Then', presses c, types, Ctrl+Enter: saved once, a margin bubble with the text, the word highlighted", k1);
    await ev(`(document.getElementById("cmg").scrollIntoView(), true)`); await shot("comments-wide");
    const saved = await ev(`window.__saves.cmg[window.__saves.cmg.length - 1]`);
    await ev(`(window.__cm_cmg.destroy(), window.__ed_cmg.destroy(), document.getElementById("cmg").remove(), true)`);
    await mountC("cmv", 900, "view", saved);
    const v1 = await ev(`(async () => { await new Promise((r) => setTimeout(r, 100)); const b = document.querySelectorAll("#cmv .sb-cm-bubble");
      const P = document.querySelector("#cmv .tex-preview"); const tw = document.createTreeWalker(P, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode()) && !n.data.includes("Then")) {}
      const r = document.createRange(), i = n.data.indexOf("Then"); r.setStart(n, i); r.setEnd(n, i + 4); getSelection().removeAllRanges(); getSelection().addRange(r);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true })); await new Promise((r) => setTimeout(r, 50));
      return { bubbles: b.length, text: b[0]?.textContent ?? "", composer: !!document.querySelector(".sb-cm-compose"), hl: CSS.highlights?.get("sb-comments")?.size ?? -1, saves: window.__saves.cmv.length }; })()`);
    check(v1.bubbles === 1 && v1.text.includes("Say why") && !v1.composer && v1.hl === 1 && v1.saves === 0, "comments: the student's view shows the bubble and the highlight; c makes no composer, nothing saved", v1);
    await ev(`(window.__cm_cmv.destroy(), window.__ed_cmv.destroy(), document.getElementById("cmv").remove(), true)`);
    await mountC("cmn", 360, "view", saved);
    const n1 = await ev(`(async () => { await new Promise((r) => setTimeout(r, 100)); const g = document.querySelector("#cmn .sb-cm-badge");
      if (!g) return { badge: false, bubbles: document.querySelectorAll("#cmn .sb-cm-bubble").length };
      g.click(); await new Promise((r) => setTimeout(r, 50)); const sh = document.querySelector(".sb-cm-sheet");
      window.__shotNow = true;
      return { badge: true, bubbles: document.querySelectorAll("#cmn .sb-cm-bubble").length, sheet: !!sh, text: sh?.textContent ?? "", edit: !!sh && [...sh.querySelectorAll("button")].some((b) => b.textContent === "Edit") }; })()`);
    await ev(`(document.getElementById("cmn").scrollIntoView(), true)`); await shot("comments-narrow-sheet");
    check(n1.badge && n1.bubbles === 0 && n1.sheet && n1.text.includes("Say why") && !n1.edit, "comments: in a narrow box a badge, not a bubble; tapped, a sheet with the comment (view: no Edit)", n1);
    await ev(`(document.querySelector(".sb-cm-sheet")?.remove(), window.__cm_cmn.destroy(), window.__ed_cmn.destroy(), document.getElementById("cmn").remove(), true)`);
    await mountC("cmb", 900, "comment", []);
    await selectThen("cmb");
    const b1 = await ev(`(async () => { document.querySelector("#cmb .tex-preview").dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); await new Promise((r) => setTimeout(r, 50));
      const go = document.querySelector("#cmb .sb-cm-go"); if (!go) return { go: false };
      go.click(); await new Promise((r) => setTimeout(r, 50)); const a = document.activeElement;
      return { go: true, composer: !!a && !!a.closest(".sb-cm-compose") }; })()`);
    check(b1.go && b1.composer, "comments: a selection shows a Comment button; it opens the composer, focused", b1);
    await ev(`(window.__cm_cmb.destroy(), window.__ed_cmb.destroy(), document.getElementById("cmb").remove(), true)`);
  }
  const fid = await mk("/t/doc.tex", enc(DOC));
  requests.length = 0;
  await go(base + "?tex=" + fid);
  await sleep(1500);
  // (on by default, William Nov 2: no ?latex=1, nothing stored, and ?tex= opens the editor on an allowed host)
  check(await until(`!!document.querySelector(".tex-page") && !document.body.innerText.includes("The LaTeX editor isn't enabled here.")`, 20000), "on by default: ?tex= opens the editor with no flag");
  // ---- a middle-click on a file row (board i1c01 U1): a new tab of the editor only for a .tex file it takes; any
  // other file (or the flag off), nothing, as before the editor: no preview here, no tab (the other file a data file: a
  // code or text file has a page of its own, web/code/test-code-page.mjs)
  await mk("/mid.csv", enc("a,b\n1,2\n")); const midFid = await mk("/mid.tex", enc(DOC));
  const middle = async (q) => {
    await ev(`localStorage.setItem("sagebrush-files-sidebar", "1"); true`);
    await go(base + q); await until(`!!${W}`, 60000);
    const sel = (p) => JSON.stringify(`.frow[data-path="${p}"]`);
    const rows = await until(`!!document.querySelector(${sel("/mid.csv")}) && !!document.querySelector(${sel("/mid.tex")})`, 20000);
    const out = { rows };
    for (const p of ["/mid.csv", "/mid.tex"]) out[p] = rows && await ev(`(async () => {
      window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; };
      const before = location.href;
      document.querySelector(${sel(p)}).dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
      await new Promise((s) => setTimeout(s, 800));
      return { opened: window.__opened, preview: !!document.querySelector(".sbfprev"), here: location.href === before };
    })()`);
    await ev(`localStorage.removeItem("sagebrush-files-sidebar"); true`);
    return out;
  };
  const nothing = (r) => r && r.opened.length === 0 && !r.preview && r.here;
  const mOff = await middle("");
  check(mOff.rows && nothing(mOff["/mid.csv"]) && mOff["/mid.tex"] && mOff["/mid.tex"].opened.length === 1 && mOff["/mid.tex"].opened[0].includes("?tex=" + midFid), "on by default: with no flag, a middle-click on a .tex file opens the editor in a new tab (on any other file, nothing)", mOff);
  const mOn = await middle("?latex=1");
  check(mOn.rows && nothing(mOn["/mid.csv"]), "flag on: a middle-click on a non-.tex file does nothing (no preview here, no tab)", mOn);
  check(mOn.rows && mOn["/mid.tex"] && mOn["/mid.tex"].opened.length === 1 && mOn["/mid.tex"].opened[0].includes("?tex=" + midFid) && !mOn["/mid.tex"].preview && mOn["/mid.tex"].here, "flag on: a middle-click on a .tex file opens the editor in a new tab only", mOn);
  // ---- U1 (William, Nov 2 evening): with a BOARD open, a .tex file clicked in the file panel did nothing. It opens the
  // LaTeX editor (the notebook page's /?tex=<fid>): a click here, the board left the way any open leaves it; a
  // middle-click in a new tab; any other file still its preview, the board kept
  {
    // (a board of the workspace's own: the file panel is a workspace board's, not an example's)
    await go(base); await until(`!!${W}`, 60000);
    const bref = await ev(`${W}.create("/u1.board.json").then((e) => e.ref)`);
    await ev(`localStorage.setItem("sagebrush-files-sidebar", "1"); true`);
    await go(base + "board/?doc=local:" + bref);
    const sel = (p) => JSON.stringify(`.frow[data-path="${p}"]`);
    const rows = await until(`!!document.querySelector(${sel("/mid.tex")}) && !!document.querySelector(${sel("/mid.csv")})`, 30000);
    const mid = rows && await ev(`(async () => {
      window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; };
      document.querySelector(${sel("/mid.tex")}).dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
      await new Promise((s) => setTimeout(s, 500));
      return { opened: window.__opened, board: location.pathname };
    })()`);
    const txt = rows && await ev(`(async () => {
      document.querySelector(${sel("/mid.csv")}).click();
      await new Promise((s) => setTimeout(s, 800));
      const p = !!document.querySelector(".sbfprev");
      document.querySelector(".sbfprev")?.remove();
      return { preview: p, board: location.pathname };
    })()`);
    let left = false, editor = false;
    if (rows) {
      await mark();
      await ev(`(() => { document.querySelector(${sel("/mid.tex")}).click(); return 1; })()`);
      left = await fresh(`location.pathname === "/" && location.search === "?tex=${midFid}"`, 30000).then(() => true, () => false);
      editor = left && await until(`!!document.querySelector(".tex-page")`, 20000);
    }
    await ev(`localStorage.removeItem("sagebrush-files-sidebar"); true`);
    check(rows && mid && mid.opened.length === 1 && mid.opened[0].includes("?tex=" + midFid) && mid.board.startsWith("/board") && txt && txt.preview && txt.board.startsWith("/board") && left && editor,
      "U1: with a board open, a .tex file in the file panel opens the LaTeX editor (a click here, a middle-click in a new tab); another file still previews, the board kept", { rows, mid, txt, left, editor });
  }
  // on, by the URL: no LaTeX file fetched before a .tex is opened. Counted from a blank page (T568-EAGER-FETCH-RACE): the
  // case before leaves the editor open, and its worker's script could still be asked for after the list was cleared and
  // before the next navigation, counted against the new page; at about:blank the editor's document and worker are gone
  const fromBlank = async () => { await send("Page.navigate", { url: "about:blank" }); await until(`location.href === "about:blank"`, 10000); await sleep(200); requests.length = 0; };
  // (background loading, web/preload.ts, prefetches the editor's two files at idle where the workspace has a .tex: off
  // here, by the tests' switch, so this counts the page's own fetches; the case after the control has it on)
  const preloadOff = await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__sbPreloadOff = true;` });
  await fromBlank();
  await go(base + "?latex=1"); await until(`!!${W}`, 60000); await sleep(1000);
  check(latexFetches().length === 0, "flag on: nothing fetched before a .tex is opened (zero eager fetch)", latexFetches());
  // (its control: the same page with an eager fetch of a LaTeX file added fails that check)
  {
    await fromBlank();
    const eager = await send("Page.addScriptToEvaluateOnNewDocument", { source: `if (location.protocol.startsWith("http")) fetch("/sagebrush-latex-worker.js").catch(() => {});` });
    await go(base + "?latex=1"); await until(`!!${W}`, 60000); await sleep(1000);
    const seen = latexFetches();
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: eager.identifier });
    check(seen.length > 0, "…its control: a page that fetches a LaTeX file eagerly is caught by the same count", seen);
  }
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: preloadOff.identifier });
  // background loading on (@sagebrush's ruling and @sagebrush-latex's pins, Nov 5): before a .tex is opened, at idle,
  // exactly the editor's two files, each once, and none of its lazy chunks (each fetched on its own use only, with its
  // own budget line); nothing executed (no editor, no LaTeX worker constructed: Worker counted from before the page's
  // own script); and used: opening a .tex then downloads neither again (from the cache, or a revalidation's few bytes).
  // (No .tex in the workspace, no LaTeX prefetch: web/test-preload-page.mjs, a plain notebook's outcome "nothing".)
  {
    // (from an empty HTTP cache: the cases before opened the editor, so its files would otherwise be cached already,
    // and the prefetch itself a cache answer rather than the download it is on a first visit)
    await send("Network.clearBrowserCache");
    const counter = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { window.__latexWorkers = 0; const W0 = window.Worker; window.Worker = function (u, o) { if (String(u).includes("sagebrush-latex") || o?.name === "sagebrush-latex") window.__latexWorkers++; return new W0(u, o); }; window.Worker.prototype = W0.prototype; })();` });
    await fromBlank();
    await go(base + "?latex=1"); await until(`!!${W}`, 60000);
    await until(`window.sagebrush?.preload?.outcome !== null && window.sagebrush?.preload?.outcome !== undefined`, 20000);
    await sleep(1500);
    const seen = latexFetches().map((u) => new URL(u).pathname), outcome = await ev(`window.sagebrush.preload.outcome`);
    const editor = await ev(`!!document.querySelector(".tex-page")`), workers = await ev(`window.__latexWorkers`);
    const lazy = seen.filter((p) => /sagebrush-latex-(beamer|comments|comments-doc|agent|tools|present|doc)\.js$/.test(p));
    check(JSON.stringify([...seen].sort()) === JSON.stringify(["/sagebrush-latex-worker.js", "/sagebrush-latex.js"]) && lazy.length === 0 && outcome === "fetched" && !editor && workers === 0,
      "background loading: before a .tex is opened, only the editor's two files, each once, at idle (none of its lazy chunks); nothing executed (no editor, no LaTeX worker)", { seen, lazy, outcome, editor, workers });
    // (then a .tex is opened, in this tab: neither file downloaded again)
    const two = latexFetches().filter((u) => /\/sagebrush-latex(-worker)?\.js$/.test(u));
    const full = Object.fromEntries(two.map((u) => [new URL(u).pathname, sizes.get(u)]));
    const n0 = requests.length, i0 = byId.length;
    const pf = await mk("/preload-used.tex", enc("\\documentclass{article}\n\\begin{document}\nused\n\\end{document}\n"));
    const opened = await open(pf);
    await sleep(1500);
    const again = requests.slice(n0).filter((u) => /\/sagebrush-latex(-worker)?\.js$/.test(u));
    // (the editor's page, asked again: answered from the cache, or with only a revalidation's few bytes. Its worker's
    // script is asked by the worker, whose answer this page's session never sees (no response, no finish), so it isn't
    // judged here: a follow-up for @sagebrush-latex, by the worker's own target)
    const againIds = byId.slice(i0).filter((x) => /\/sagebrush-latex(-worker)?\.js$/.test(x.url)).map((x) => ({ path: new URL(x.url).pathname, cached: x.cached, bytes: x.bytes, status: x.status }));
    const page = againIds.filter((x) => x.path === "/sagebrush-latex.js");
    check(opened && Object.values(full).every((b) => b > 10_000) && page.length >= 1 && page.every((x) => x.cached || (x.bytes !== null && x.bytes < 2048) || x.status === 304),
      "background loading: …and used: opening a .tex then downloads the editor's page no more (from the cache, or a revalidation)", { opened, full, again: againIds });
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: counter.identifier });
  }
  // (a control of the navigation helper itself: the page navigates by itself 1.5 s after the mark. The old check (a
  // workspace present) passes at once on the outgoing document, which is the race; fresh() must not: it returns only on
  // the new document, whose timeOrigin is after the mark, and only after the delay)
  {
    const t0 = Date.now();
    await mark(); await ev(`setTimeout(() => location.assign(location.href), 1500); true`);
    const oldWouldPass = await ev(`!!${W}`);
    const okNav = await fresh(`!!${W}`, 30000);
    const nav = { oldWouldPass, okNav, waited: Date.now() - t0, newDoc: await ev(`performance.timeOrigin`) - t0 };
    check(oldWouldPass && okNav && nav.waited >= 1400 && nav.newDoc >= 1000, "a delayed navigation: the old check would pass on the outgoing document; fresh() waits for the new one", nav);
    // (negatives: each failed navigation is run the way the fixtures run one, the navigation awaited and THEN the step
    // that depends on it (a stand-in for mk/stat/read, counting its calls): an unacknowledged mark (false, or throwing),
    // a fresh() whose condition never holds, and a timeout (marked, no navigation) must each throw, the step never run)
    let depCalls = 0;
    const dependent = async () => { depCalls++; };
    const stops = async (nav) => { try { await nav(); await dependent(); return false; } catch { return true; } };
    const neg = {
      markFalse: await stops(() => markWith(`false`)),
      markThrows: await stops(() => markWith(`(() => { throw new Error("x"); })()`)),
      freshFalse: await stops(() => fresh(`false`, 1500)),
      freshTimeout: await stops(async () => { await mark(); await fresh(`true`, 1500); }),
    };
    await ev(`delete window.__sbOld; true`);
    neg.depCalls = depCalls;
    check(neg.markFalse && neg.markThrows && neg.freshFalse && neg.freshTimeout && depCalls === 0, "a failed mark, a false fresh() and a navigation timeout each throw; the dependent step never runs", neg);
  }

  // ---- opening, the banner, Save gated on edits (the first open's requests recorded: the cold first click)
  requests.length = 0; sizes.clear();
  check(await open(fid), "the editor opens by fid");
  check(await until(`document.querySelector(".tex-preview h2, .tex-preview h1")?.textContent.includes("Hello")`, 20000), "the preview renders the section");
  const cold = { requests: requests.length, bytes: [...sizes.values()].reduce((a, b) => a + b, 0), latex: [...sizes.entries()].filter(([u]) => /sagebrush-latex/.test(u)).reduce((a, [, b]) => a + b, 0) };
  console.log("cold first click (loopback, uncompressed; the gated number is the TIMING protocol's against DEV):", JSON.stringify(cold));
  check(await page(`P.querySelector(".tex-banner").textContent.startsWith("LaTeX editor: an early prototype. Your edits are saved as you type.")`), "the banner says edits are saved as you type");
  check(await page(`!P.querySelector(".tex-save") && !P.querySelector(".tex-dirty") && P.querySelector(".tex-savestate").textContent === "Saved ✓"`), "U8: no Save button, no Unsaved changes: Saved ✓");
  check(latexFetches().some((u) => /sagebrush-latex\.js/.test(u)) && latexFetches().some((u) => /sagebrush-latex-worker\.js/.test(u)), "the page and its worker fetched now", latexFetches());
  check(!latexFetches().some((u) => /sagebrush-latex-examples\.js/.test(u)), "…and not the examples' chunk: opening a .tex doesn't fetch it", latexFetches());
  const rev0 = await ev(`${W}.stat("/t/doc.tex").then((e) => e.rev ?? 0)`);
  await send("Runtime.evaluate", { expression: `document.querySelector(".tex-src").focus()` });
  await ctrlS();
  check(await savedNow(), "Ctrl+S on clean text: Saved ✓");
  check((await ev(`${W}.stat("/t/doc.tex").then((e) => e.rev ?? 0)`)) === rev0, "…and no write (the revision unchanged)");
  // (U8) typing is saved without a click: Edited, then Saved ✓ after the debounce, the bytes the text; and the browser's
  // leave prompt not asked for while a write is merely pending
  await typeInto(DOC.replace("Some text", "Edited text"));
  const noPrompt = await ev(`(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return !e.defaultPrevented; })()`);
  check(noPrompt, "U8: an edit pending: no leave prompt");
  // (plan r5 §6's marks, for the TIMING harness: an edit's input, request, reply, patch and paint carry its revision;
  // the highlighter's done mark carries its wall and busy ms)
  const marksOk = await until(`(() => { const m = (n) => performance.getEntriesByName(n); const inp = m("tex-input").at(-1); if (!inp) return false; const r = inp.detail.rev;
    return ["tex-request", "tex-parse-done", "tex-patch-done", "tex-paint"].every((n) => m(n).some((e) => e.detail.rev === r && e.startTime >= inp.startTime))
      && m("tex-highlight-done").some((e) => e.startTime >= inp.startTime && e.detail.wall >= e.detail.busy && e.detail.busy >= 0)
      && m("tex-mount").length === 1 && m("tex-read-done").length === 1; })()`, 10000);
  check(marksOk, "the §6 marks: an edit's input, request, parse, patch and paint by revision; the highlighter's wall and busy", await ev(`performance.getEntriesByType("mark").map((e) => [e.name, e.detail]).slice(-12)`));
  check(await savedNow(), "U8: typing is saved by itself: Saved ✓");
  check(JSON.stringify(await bytesOf("/t/doc.tex")) === JSON.stringify(enc(DOC.replace("Some text", "Edited text"))), "…the bytes written are the text");
  // (Ctrl+S writes at once, before the debounce)
  await typeInto(DOC.replace("Some text", "Edited again"));
  await ctrlS();
  check(await savedNow(600) && JSON.stringify(await bytesOf("/t/doc.tex")) === JSON.stringify(enc(DOC.replace("Some text", "Edited again"))), "Ctrl+S: written at once, Saved ✓");
  // (a failed write: the one state that keeps the leave prompt; the text stays; written again on the next edit)
  await ev(`(window.__sbTexSaveWrite = () => { throw new Error("storage full (test)"); }, true)`);
  await typeInto(DOC.replace("Some text", "Edited, failing"));
  check(await saveStateIs(/^Not saved: storage full \(test\)/), "U8: a failed write: a persistent Not saved with the reason", await page(`P.querySelector(".tex-savestate").textContent`));
  const prompt = await ev(`(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()`);
  check(prompt, "U8: …and only then the leave prompt");
  await ev(`(delete window.__sbTexSaveWrite, true)`);
  await typeInto(DOC.replace("Some text", "Edited text"));
  check(await savedNow() && JSON.stringify(await bytesOf("/t/doc.tex")) === JSON.stringify(enc(DOC.replace("Some text", "Edited text"))), "U8: …written on the next edit: Saved ✓");
  // (U8-CONFLICT-1) changed elsewhere while an edit is pending (its write held): the autosave's write refused, #599's
  // bar shown, nothing written over it; Keep mine writes mine over the revision shown, the other text kept as a version
  const conflictSetup = async (mine, theirs) => {
    await ev(`(() => { window.__hc = new Promise((r) => (window.__hcr = r)); window.__sbTexSaveWrite = () => window.__hc; return true; })()`);
    await typeInto(DOC.replace("Some text", mine)); await ctrlS(); await sleep(200);
    await ev(`${W}.write("/t/doc.tex", new TextEncoder().encode(${JSON.stringify(DOC.replace("Some text", theirs))})).then(() => 1)`);
    await ev(`(window.__hcr(), delete window.__sbTexSaveWrite, true)`);
    return until(`!document.querySelector(".tex-conflict").hidden && /changed (this file|elsewhere)/.test(document.querySelector(".tex-conflict").textContent) && document.querySelector(".tex-savestate").textContent === "Not saved yet: changed elsewhere"`, 10000);
  };
  check(await conflictSetup("Mine one", "Theirs one") && JSON.stringify(await bytesOf("/t/doc.tex")) === JSON.stringify(enc(DOC.replace("Some text", "Theirs one"))), "U8: changed elsewhere with an edit pending: the choice shown, nothing written over the other text");
  await ev(`(document.querySelector(".tex-mine").click(), true)`);
  const versionsHave = (t) => ev(`(async () => { const h = await ${W}.history("/t/doc.tex"); for (let i = 0; i < h.length; i++) { const b = await ${W}.version("/t/doc.tex", i).catch(() => null); if (b && new TextDecoder().decode(b).includes(${JSON.stringify(t)})) return true; } return false; })()`);
  check(await savedNow() && JSON.stringify(await bytesOf("/t/doc.tex")) === JSON.stringify(enc(DOC.replace("Some text", "Mine one"))) && await versionsHave("Theirs one") && await page(`P.querySelector(".tex-conflict").hidden`), "U8: Keep mine: mine written, theirs kept in the file's versions");
  // (U8-CONFLICT-2) Use theirs (#599): mine kept first as "doc (mine).tex" beside it, then theirs in the editor
  check(await conflictSetup("Mine two", "Theirs two"), "U8: a second conflict shown");
  await ev(`(document.querySelector(".tex-theirs").click(), true)`);
  check(await savedNow() && (await ev(`document.querySelector(".tex-src").value`)).includes("Theirs two") && JSON.stringify(await bytesOf("/t/doc (mine).tex")) === JSON.stringify(enc(DOC.replace("Some text", "Mine two"))) && JSON.stringify(await bytesOf("/t/doc.tex")) === JSON.stringify(enc(DOC.replace("Some text", "Theirs two"))), "U8: Use theirs: mine kept as doc (mine).tex, theirs in the editor, Saved ✓");
  // (U8-DURABLE-1) the page goes away with an edit whose write never lands: on opening again, the exact text recovered
  // and written
  await ev(`(window.__sbTexSaveWrite = () => new Promise(() => {}), true)`);
  await typeInto(DOC.replace("Some text", "Typed just before the tab went away"));
  await ctrlS(); await sleep(300);
  await go(base + "?tex=" + fid + "&latex=1");
  check(await until(`document.querySelector(".tex-src")?.value.includes("Typed just before the tab went away")`, 20000) && await savedNow(15000), "U8: reloaded with a write in flight: the draft recovered into the editor, then saved");
  check(JSON.stringify(await bytesOf("/t/doc.tex")) === JSON.stringify(enc(DOC.replace("Some text", "Typed just before the tab went away"))), "U8: …the file has the recovered text");
  await typeInto(DOC.replace("Some text", "Edited text")); await savedNow();

  // ---- the byte rules, through the page: the fixtures saved after an edit and read back
  const BOM = [0xef, 0xbb, 0xbf];
  const fixtures = [["crlf", enc("a\r\nb\r\n"), (t) => enc(t.replace(/\n/g, "\r\n"))], ["bom", BOM.concat(enc("a\nb\n")), (t) => enc(t)], ["bom-crlf", BOM.concat(enc("a\r\nb\r\n")), (t) => enc(t.replace(/\n/g, "\r\n"))]];
  for (const [name, b, expect] of fixtures) {
    const f = await mk(`/t/${name}.tex`, b);
    await open(f);
    // (the head is drawn before the file is read; the source and the save state after it)
    await until(`document.querySelector(".tex-savestate")?.textContent === "Saved ✓" && !!document.querySelector(".tex-src")`, 10000);
    const text = await ev(`document.querySelector(".tex-src").value`);
    await typeInto(text + "c\n"); await ctrlS();
    await savedNow();
    const got = await bytesOf(`/t/${name}.tex`), want = expect(text + "c\n");
    check(JSON.stringify(got) === JSON.stringify(want) && got.filter((x, i) => x === 0xef && got[i + 1] === 0xbb && got[i + 2] === 0xbf).length === (b[0] === 0xef ? 1 : 0), "fixture " + name + ": saved and read back exactly, one BOM at most", { got: got.slice(0, 12), want: want.slice(0, 12) });
  }
  const mixed = await mk("/t/mixed.tex", enc("a\r\nb\nc\n"));
  await open(mixed); await sleep(800);
  check(await page(`P.querySelector(".tex-savestate").textContent === "Read-only" && P.querySelector(".tex-banner").textContent.includes("mixes line endings")`), "mixed line endings: read-only, the banner says why");
  const mrev = await ev(`${W}.stat("/t/mixed.tex").then((e) => e.rev ?? 0)`);
  await typeInto("changed\n"); await ctrlS(); await sleep(500);
  check((await ev(`${W}.stat("/t/mixed.tex").then((e) => e.rev ?? 0)`)) === mrev && (await statusIs(/can't be saved here/, 3000)), "…Ctrl+S writes nothing, says why");
  await ev(`window.onbeforeunload = null; true`);
  const nul = await mk("/t/nul.tex", [0x61, 0, 0x62]);
  await open(nul); await sleep(800);
  check(await page(`P.textContent.includes("can't be opened in the LaTeX editor") && !P.querySelector(".tex-src")`), "a NUL file: no editor, says why");

  // ---- the save target
  const f2 = await mk("/t/r.tex", enc(DOC));
  await open(f2); await sleep(500);
  await ev(`${W}.rename("/t/r.tex", "/t/moved.tex").then(() => 1)`);
  await typeInto(DOC + "% x\n"); await ctrlS();
  check(await savedNow() && JSON.stringify(await bytesOf("/t/moved.tex")) === JSON.stringify(enc(DOC + "% x\n")), "a rename elsewhere: the save follows the file");
  await ev(`${W}.remove("/t/moved.tex").then(() => 1)`);
  await typeInto(DOC + "% y\n"); await ctrlS();
  check(await saveStateIs(/Not saved: this file isn't here any more/), "the file in Trash: Not saved, with the reason");
  // another tab's save while this one has no edits pending: this editor takes its text (U8); then mine written over it,
  // the other kept as a version
  const f3 = await mk("/t/lw.tex", enc(DOC));
  await open(f3); await sleep(500);
  await ev(`${W}.write("/t/lw.tex", new TextEncoder().encode("other tab\\n")).then(() => 1)`);
  check(await until(`document.querySelector(".tex-src").value === "other tab\\n"`, 10000), "U8: another tab saved, nothing pending here: the editor shows its text");
  await typeInto(DOC + "% mine\n"); await ctrlS(); await savedNow();
  const hist = await ev(`${W}.history("/t/lw.tex").then((h) => h.length)`);
  check(JSON.stringify(await bytesOf("/t/lw.tex")) === JSON.stringify(enc(DOC + "% mine\n")) && hist >= 2, "…then mine written over it, its bytes kept as a version", { hist });
  // leaving right after an edit: no prompt (U8: William, "a user should never see 'Leave this file without saving
  // your changes?'"); the edit written on the way out, or recovered from its draft
  await typeInto(DOC + "% just typed\n");
  dialogs.length = 0;
  await send("Page.navigate", { url: base + "?latex=1" }); await sleep(1500);
  check(!dialogs.includes("beforeunload"), "U8: leaving right after an edit: the browser doesn't ask", dialogs);

  // ---- a change to the open file made elsewhere (William, Nov 3: an agent's write didn't show until the file was
  // opened again, "a critical thing to get right"; plan r2 5d9a0c2a): with nothing unsaved, the text follows it in
  // place, the cursor and scroll kept, "Updated by …"; with edits pending, nothing replaced or written, the bar asks;
  // a write (the autosave's, U8) only over the revision its text came from (S3). Agents write as sagebrush-mcp's do
  // (forAgent). (Each edit and the change made elsewhere come well within the autosave's 800 ms.)
  {
    const AG = `window.__sbTexWs.forAgent("agent:Claude-Code")`;
    const put = (p, bytes) => ev(`${AG}.write(${JSON.stringify(p)}, new Uint8Array(${JSON.stringify(bytes)})).then((r) => r.rev)`);
    const agentWrite = (p, s) => put(p, enc(s));
    const textOf = async (p) => { try { return new TextDecoder().decode(new Uint8Array(await bytesOf(p))); } catch { return null; } };
    const srcIs = (s) => ev(`document.querySelector(".tex-src")?.value === ${JSON.stringify(s)}`);
    const srcBecomes = (s, ms = 5000) => until(`document.querySelector(".tex-src")?.value === ${JSON.stringify(s)}`, ms);
    const barUp = () => page(`P.querySelector(".tex-conflict")?.hidden === false`);
    const barShows = () => until(`document.querySelector(".tex-conflict")?.hidden === false`, 5000);
    const barText = () => page(`P.querySelector(".tex-conflict-t")?.textContent ?? null`);
    const status = () => page(`P.querySelector(".tex-status").textContent`);
    const saveState = () => page(`P.querySelector(".tex-savestate").textContent`);
    const revOf = (p) => ev(`${W}.stat(${JSON.stringify(p)}).then((e) => e.rev ?? 0)`);
    const exists = (p) => ev(`${W}.stat(${JSON.stringify(p)}).then((e) => !!e && !e.trashed)`);
    const click = (sel) => page(`(P.querySelector(${JSON.stringify(sel)})?.click(), true)`);
    // (a page hook held on its first call only (with a phase, that phase's first), released by the test; later calls pass)
    const hold = (name, phase = null) => ev(`(() => { const h = { hit: false }; h.p = new Promise((r) => (h.release = r)); (window.__holds ??= {})[${JSON.stringify(name)}] = h;
      window[${JSON.stringify(name)}] = (x) => { if (h.hit || (${JSON.stringify(phase)} !== null && x !== ${JSON.stringify(phase)})) return; h.hit = true; return h.p; }; return true; })()`);
    const held = (name) => until(`!!window.__holds?.[${JSON.stringify(name)}]?.hit`, 8000);
    const release = (name) => ev(`(() => { const h = window.__holds[${JSON.stringify(name)}]; delete window[${JSON.stringify(name)}]; h.release(); return true; })()`);
    // (every text the editor is given, its value setter watched: a text never to be shown is never set)
    const spy = () => ev(`(() => { const t = document.querySelector(".tex-src"), d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value"); window.__vals = [];
      Object.defineProperty(t, "value", { configurable: true, get() { return d.get.call(this); }, set(v) { window.__vals.push(v); d.set.call(this, v); } }); return true; })()`);
    const LONG = DOC.replace("\\end{document}", Array.from({ length: 220 }, (_, i) => `Line ${i} of filler text.`).join("\n") + "\n\\end{document}");
    // (the page's workspace first, and the agents' handle, set late in the editor's mount: waited for, so neither is used
    // before it is there, under load)
    const opened = async (name, bytes = enc(DOC)) => { await until(`!!${W}`, 20000); const f = await mk(name, bytes); await open(f); await until(`!!document.querySelector(".tex-src") && !!window.__sbTexWs`, 20000); await sleep(500); return f; };
    // (a dirty editor and the agent's change: the bar up)
    const conflicted = async (name) => { await opened(name); await typeInto(DOC + "% mine\n"); await agentWrite(name, DOC + "% theirs\n"); return barShows(); };

    // T1: a clean editor, the agent adds a section: here at once, the cursor and the scroll kept, said who; nothing unsaved
    await opened("/x/curves.tex", enc(LONG));
    await ev(`(() => { const t = document.querySelector(".tex-src"); t.focus(); t.setSelectionRange(40, 47); t.scrollTop = 900; return true; })()`);
    const top0 = await ev(`document.querySelector(".tex-src").scrollTop`);
    const LONG2 = LONG.replace("\\end{document}", "\\section{Curves}\nAdded by the agent.\n\\end{document}");
    await agentWrite("/x/curves.tex", LONG2);
    const t1 = { text: await srcBecomes(LONG2), status: await statusIs(/^Updated by Claude Code$/, 3000) };
    t1.preview = await until(`[...document.querySelectorAll(".tex-preview h2")].some((h) => h.textContent.includes("Curves"))`, 15000);
    Object.assign(t1, await ev(`(() => { const t = document.querySelector(".tex-src"); return { a: t.selectionStart, b: t.selectionEnd, top: t.scrollTop }; })()`), { top0 });
    t1.clean = await page(`P.querySelector(".tex-savestate").textContent === "Saved ✓" && P.querySelector(".tex-conflict")?.hidden !== false`);
    check(t1.text && t1.status && t1.preview && t1.a === 40 && t1.b === 47 && top0 > 0 && Math.abs(t1.top - top0) <= 2 && t1.clean, "T1 a clean editor, the agent writes: shown in place, the cursor and scroll kept, \"Updated by Claude Code\", nothing unsaved", t1);

    // T3: this editor's own write: no reload, no "Updated by", no bar, its revision the next; a keystroke while the
    // write's own change is looked at is pending, no bar
    const r3 = await revOf("/x/curves.tex");
    await typeInto(LONG2 + "% mine\n");
    await hold("__sbTexCheckRead", "after");
    await ctrlS();
    const t3 = { saved: await savedNow(5000), held: await held("__sbTexCheckRead") };
    await typeInto(LONG2 + "% mine\n% more\n");
    await release("__sbTexCheckRead"); await sleep(400);
    Object.assign(t3, { rev: (await revOf("/x/curves.tex")) - r3, bar: await barUp(), status: await status(), src: await srcIs(LONG2 + "% mine\n% more\n"), file: (await textOf("/x/curves.tex")) === LONG2 + "% mine\n", dirty: (await saveState()) !== "Saved ✓" });
    check(t3.saved && t3.held && t3.rev === 1 && !t3.bar && !/Updated/.test(t3.status) && t3.src && t3.file && t3.dirty, "T3 the editor's own write: no reload, no bar, its revision next; typing meanwhile pending", t3);
    // (…and that newer text written by the next write, by itself: Saved ✓, no bar)
    const t3b = { saved: await savedNow(5000), file: (await textOf("/x/curves.tex")) === LONG2 + "% mine\n% more\n", bar: !(await barUp()) };
    check(Object.values(t3b).every((v) => v === true), "T3 …the text typed meanwhile written next, by itself", t3b);

    // T2: edits pending, the agent writes: the bar says who; nothing replaced, nothing written; Ctrl+S refused (S3); Use
    // theirs keeps mine as "… (mine).tex" and shows theirs; Keep mine writes mine, theirs kept as a version
    const t2 = { bar: await conflicted("/x/b.tex"), text: await barText() };
    await ctrlS();
    Object.assign(t2, { refused: await saveStateIs(/^Not saved yet: changed elsewhere$/, 5000) });
    Object.assign(t2, { src: await srcIs(DOC + "% mine\n"), file: (await textOf("/x/b.tex")) === DOC + "% theirs\n", buttons: await page(`[P.querySelector(".tex-theirs")?.hidden === false, P.querySelector(".tex-mine")?.hidden === false]`) });
    check(t2.bar && t2.text === "Claude Code changed this file while you were editing." && t2.refused && t2.src && t2.file && t2.buttons.join() === "true,true", "T2 edits pending, the agent writes: the bar names it; mine kept here, theirs in the file; Ctrl+S writes nothing", t2);
    await click(".tex-theirs");
    const t2b = { said: await statusIs(/^Your text is in b \(mine\)\.tex$/, 8000), copy: (await textOf("/x/b (mine).tex")) === DOC + "% mine\n", src: await srcIs(DOC + "% theirs\n"), bar: await barUp(), saved: await savedNow(3000) };
    check(t2b.said && t2b.copy && t2b.src && !t2b.bar && t2b.saved, "T2 Use theirs: mine in \"b (mine).tex\", theirs here, Saved ✓", t2b);
    const t2c = { bar0: await conflicted("/x/k.tex") };
    await click(".tex-mine");
    Object.assign(t2c, { said: await statusIs(/^Saved: yours kept, theirs is in TimeTravel$/, 8000), file: (await textOf("/x/k.tex")) === DOC + "% mine\n", bar: await barUp(),
      theirs: await ev(`${W}.history("/x/k.tex").then(async (h) => { for (let i = 0; i < h.length; i++) if (new TextDecoder().decode(await ${W}.version("/x/k.tex", i)) === ${JSON.stringify(DOC + "% theirs\n")}) return true; return false; })`) });
    check(t2c.bar0 && t2c.said && t2c.file && !t2c.bar && t2c.theirs, "T2 Keep mine: mine in the file, theirs kept as a version", t2c);

    // R1: Keep mine is for the change the bar showed: one made after it (its check held, so the bar still shows the
    // first), then the click: nothing written, then the bar shows the newer; one made during Keep mine's write too
    const r1 = { bar0: await conflicted("/x/r1.tex") };
    await hold("__sbTexCheckRead", "after");
    await agentWrite("/x/r1.tex", DOC + "% theirs 2\n");
    r1.held = await held("__sbTexCheckRead");
    await click(".tex-mine");
    r1.again = await statusIs(/^Not saved: it was changed again; choose again$/, 5000);
    r1.file = (await textOf("/x/r1.tex")) === DOC + "% theirs 2\n";
    await release("__sbTexCheckRead"); await sleep(400);
    r1.bar = await barUp(); r1.src = await srcIs(DOC + "% mine\n");
    await hold("__sbTexKeepWrite");
    await click(".tex-mine");
    r1.held2 = await held("__sbTexKeepWrite");
    await agentWrite("/x/r1.tex", DOC + "% theirs 3\n");
    await release("__sbTexKeepWrite");
    r1.again2 = await statusIs(/^Not saved: it was changed again; choose again$/, 5000);
    await sleep(400);
    r1.file3 = (await textOf("/x/r1.tex")) === DOC + "% theirs 3\n"; r1.bar3 = await barUp(); r1.src3 = await srcIs(DOC + "% mine\n");
    // (for the third, shown now, Keep mine writes)
    await click(".tex-mine");
    r1.saved = await statusIs(/^Saved: yours kept/, 5000); r1.mine = (await textOf("/x/r1.tex")) === DOC + "% mine\n";
    check(Object.values(r1).every((v) => v === true), "R1 Keep mine writes only over the change the bar showed: a later one (before the click, during its write) refuses it, nothing written", r1);

    // R2: the copy is made, never written over: "(mine)" taken, it is "(mine 2)"; a copy that can't be made keeps
    // everything; E5: "(mine)" to "(mine 20)" all taken: nothing done, said
    await mk("/x/c (mine).tex", enc("an older copy\n"));
    const r2 = { bar0: await conflicted("/x/c.tex") };
    await click(".tex-theirs");
    Object.assign(r2, { said: await statusIs(/^Your text is in c \(mine 2\)\.tex$/, 8000), copy2: (await textOf("/x/c (mine 2).tex")) === DOC + "% mine\n", old: (await textOf("/x/c (mine).tex")) === "an older copy\n", src: await srcIs(DOC + "% theirs\n") });
    check(Object.values(r2).every((v) => v === true), "R2 \"(mine)\" taken: the copy is \"(mine 2)\", the older copy untouched", r2);
    const r2b = { bar0: await conflicted("/x/f.tex") };
    await ev(`window.__sbTexCopyCreate = () => { throw Object.assign(new Error("no room"), { code: "limit" }); }; true`);
    await click(".tex-theirs");
    r2b.said = await statusIs(/^Not done: your text couldn't be kept as a copy \(it is still here\)/, 5000);
    await ev(`delete window.__sbTexCopyCreate; true`);
    Object.assign(r2b, { bar: await barUp(), src: await srcIs(DOC + "% mine\n"), none: !(await exists("/x/f (mine).tex")), file: (await textOf("/x/f.tex")) === DOC + "% theirs\n" });
    check(Object.values(r2b).every((v) => v === true), "R2 a copy that can't be made: mine still here, the bar still up, nothing written", r2b);
    for (let k = 1; k <= 20; k++) await mk(`/x/f (mine${k > 1 ? " " + k : ""}).tex`, enc("taken\n"));
    await click(".tex-theirs");
    const e5 = { said: await statusIs(/^Not done: f \(mine\)\.tex to \(mine 20\) are all taken; your text is still here$/, 8000), bar: await barUp(), src: await srcIs(DOC + "% mine\n"), none: !(await exists("/x/f (mine 21).tex")) };
    check(Object.values(e5).every((v) => v === true), "E5 every copy name taken: nothing done, mine still here, said", e5);

    // R3: a clean editor, a keystroke while the change's read is held: the keystroke kept, the bar instead
    await opened("/x/r3.tex");
    await hold("__sbTexCheckRead", "after");
    await agentWrite("/x/r3.tex", DOC + "% theirs\n");
    const r3t = { held: await held("__sbTexCheckRead") };
    await typeInto(DOC + "% typed\n");
    await release("__sbTexCheckRead");
    Object.assign(r3t, { bar: await barShows(), src: await srcIs(DOC + "% typed\n"), file: (await textOf("/x/r3.tex")) === DOC + "% theirs\n" });
    check(Object.values(r3t).every((v) => v === true), "R3 a keystroke while the change is read: kept, the bar shown, nothing replaced", r3t);
    // (grader X6: a keystroke undone while the read is held, the text back to the saved one: still an edit made
    //  during the read, so the bar, never their text put over a person typing)
    await opened("/x/r3b.tex");
    await hold("__sbTexCheckRead", "after");
    await agentWrite("/x/r3b.tex", DOC + "% theirs\n");
    const r3b = { held: await held("__sbTexCheckRead") };
    await typeInto(DOC + "x"); await typeInto(DOC);
    await release("__sbTexCheckRead");
    Object.assign(r3b, { bar: await barShows(), src: await srcIs(DOC), file: (await textOf("/x/r3b.tex")) === DOC + "% theirs\n" });
    await sleep(300); r3b.notInstalled = await srcIs(DOC);
    check(Object.values(r3b).every((v) => v === true), "R3b a keystroke typed and undone while the change is read: the bar, nothing replaced", r3b);

    // R4: this editor's write and the agent's: (a) the agent's lands while the write waits: refused, the bar; (b) typing
    // while a write waits is written next; a write, then the agent's: followed, said
    await opened("/x/r4.tex");
    await typeInto(DOC + "% mine\n");
    await hold("__sbTexSaveWrite");
    await ctrlS();
    const r4 = { held: await held("__sbTexSaveWrite") };
    await agentWrite("/x/r4.tex", DOC + "% theirs\n");
    await release("__sbTexSaveWrite");
    Object.assign(r4, { refused: await saveStateIs(/^Not saved yet: changed elsewhere$/, 5000), bar: await barShows(), src: await srcIs(DOC + "% mine\n"), file: (await textOf("/x/r4.tex")) === DOC + "% theirs\n" });
    check(Object.values(r4).every((v) => v === true), "R4a the agent's write lands while this Save waits: the write refused, the bar, nothing written", r4);
    // (grader X5: no check while this write waits; the agent's change is looked at only once the write is done. While
    //  it is held, the state is still Saving… and no bar is up; then the write is refused, and the bar shows)
    await opened("/x/r4d.tex");
    await typeInto(DOC + "% mine\n");
    await hold("__sbTexSaveWrite");
    await ctrlS();
    const r4d = { held: await held("__sbTexSaveWrite") };
    await agentWrite("/x/r4d.tex", DOC + "% theirs\n");
    await sleep(600);
    Object.assign(r4d, { saving: (await saveState()) === "Saving…", noBar: !(await barUp()) });
    await release("__sbTexSaveWrite");
    Object.assign(r4d, { refused: await saveStateIs(/^Not saved yet: changed elsewhere$/, 5000), bar: await barShows(), src: await srcIs(DOC + "% mine\n"), file: (await textOf("/x/r4d.tex")) === DOC + "% theirs\n" });
    check(Object.values(r4d).every((v) => v === true), "R4d a change arriving while this write waits is looked at only after it: no bar, Saving… meanwhile", r4d);
    await opened("/x/r4b.tex");
    await typeInto(DOC + "% mine\n");
    await hold("__sbTexSaveWrite");
    await ctrlS();
    const r4b = { held: await held("__sbTexSaveWrite") };
    await typeInto(DOC + "% mine\n% more\n");
    await release("__sbTexSaveWrite");
    Object.assign(r4b, { saved: await savedNow(5000), file: (await textOf("/x/r4b.tex")) === DOC + "% mine\n% more\n", bar: !(await barUp()) });
    await agentWrite("/x/r4b.tex", DOC + "% theirs after\n");
    Object.assign(r4b, { followed: await srcBecomes(DOC + "% theirs after\n"), said: await statusIs(/^Updated by Claude Code$/, 3000) });
    // (c) a change being read when this write begins (its read older than the write): never shown over its text
    await opened("/x/r4c.tex");
    await typeInto(DOC + "% mine\n");
    await hold("__sbTexCheckRead", "after");
    await ev(`${W}.rename("/x/r4c.tex", "/x/r4c2.tex").then(() => 1)`);
    const r4c = { held: await held("__sbTexCheckRead") };
    await ctrlS();
    r4c.saved = await savedNow(5000);
    await release("__sbTexCheckRead"); await sleep(600);
    Object.assign(r4c, { src: await srcIs(DOC + "% mine\n"), file: (await textOf("/x/r4c2.tex")) === DOC + "% mine\n", quiet: !/Updated/.test(await status()), bar: !(await barUp()), clean: (await saveState()) === "Saved ✓" });
    check(Object.values(r4c).every((v) => v === true), "R4c a change read from before this write, finished after it: never shown over the saved text", r4c);
    check(Object.values(r4b).every((v) => v === true), "R4b typing while the write waits: written next, by itself; then the agent's write: followed", r4b);

    // R5: a keystroke while Use theirs's copy is made: the copy has the text up to then, the newer text stays here
    const r5 = { bar0: await conflicted("/x/r5.tex") };
    await hold("__sbTexCopyCreate");
    await click(".tex-theirs");
    r5.held = await held("__sbTexCopyCreate");
    await typeInto(DOC + "% mine\n% newer\n");
    await release("__sbTexCopyCreate");
    Object.assign(r5, { said: await statusIs(/^Your text up to then is in r5 \(mine\)\.tex; you've typed since, so your text stays here$/, 8000), copy: (await textOf("/x/r5 (mine).tex")) === DOC + "% mine\n", src: await srcIs(DOC + "% mine\n% newer\n"), bar: await barUp() });
    check(Object.values(r5).every((v) => v === true), "R5 typing while the copy is made: the copy has the text up to then, the newer stays here, the bar too", r5);
    // (and while theirs is read after the copy: the same)
    const r5b = { bar0: await conflicted("/x/r5b.tex") };
    await hold("__sbTexTheirsRead");
    await click(".tex-theirs");
    r5b.held = await held("__sbTexTheirsRead");
    await typeInto(DOC + "% mine\n% newer\n");
    await release("__sbTexTheirsRead");
    Object.assign(r5b, { said: await statusIs(/^Your text up to then is in r5b \(mine\)\.tex; you've typed since, so your text stays here$/, 8000), copy: (await textOf("/x/r5b (mine).tex")) === DOC + "% mine\n", src: await srcIs(DOC + "% mine\n% newer\n"), bar: await barUp() });
    check(Object.values(r5b).every((v) => v === true), "R5 typing while theirs is read after the copy: the newer text stays here, the bar too", r5b);

    // (daybreak3 LATEX-EXT-SEM-1: a change made while Use theirs reads theirs: looked at after it, so the newer one is
    // shown, never the older left in place; and one made while Keep mine writes: the bar for it after)
    const r5c = { bar0: await conflicted("/x/r5c.tex") };
    await hold("__sbTexTheirsRead");
    await click(".tex-theirs");
    r5c.held = await held("__sbTexTheirsRead");
    await agentWrite("/x/r5c.tex", DOC + "% theirs 2\n");
    await sleep(400);
    await release("__sbTexTheirsRead");
    Object.assign(r5c, { newer: await srcBecomes(DOC + "% theirs 2\n", 5000), bar: !(await barUp()), copy: (await textOf("/x/r5c (mine).tex")) === DOC + "% mine\n" });
    check(Object.values(r5c).every((v) => v === true), "R5c a change while Use theirs reads: the newer one shown after it, the copy kept", r5c);

    // R6: two changes, the first one's read held past the second's: the last one shown, never the first after it;
    // two writers in one change: "elsewhere"
    await opened("/x/r6.tex");
    await hold("__sbTexCheckRead", "after");
    await agentWrite("/x/r6.tex", DOC + "% first\n");
    const r6 = { held: await held("__sbTexCheckRead") };
    await agentWrite("/x/r6.tex", DOC + "% second\n");
    await sleep(600);
    await release("__sbTexCheckRead");
    await sleep(800);
    r6.last = await srcIs(DOC + "% second\n");
    await ev(`(async () => { await ${AG}.write("/x/r6.tex", new TextEncoder().encode(${JSON.stringify(DOC + "% a\n")})); await ${W}.write("/x/r6.tex", new TextEncoder().encode(${JSON.stringify(DOC + "% b\n")})); return true; })()`);
    Object.assign(r6, { both: await srcBecomes(DOC + "% b\n"), who: await statusIs(/^Updated elsewhere$/, 3000) });
    // (daybreak2: many writers while a check waits: the label kept is one string, "elsewhere", not one per writer)
    await hold("__sbTexCheckRead", "before");
    await agentWrite("/x/r6.tex", DOC + "% c\n");
    r6.held2 = await held("__sbTexCheckRead");
    await ev(`(async () => { for (let k = 0; k < 40; k++) await window.__sbTexWs.forAgent("agent:writer-" + k).write("/x/r6.tex", new TextEncoder().encode(${JSON.stringify(DOC)} + "% w" + k + "\\n")); return true; })()`);
    r6.bounded = (await ev(`window.__sbTexActor?.() ?? null`)) === "elsewhere";
    await release("__sbTexCheckRead");
    r6.many = await srcBecomes(DOC + "% w39\n", 8000) && (await statusIs(/^Updated elsewhere$/, 3000));
    check(Object.values(r6).every((v) => v === true), "R6 a held earlier read never installs over a later change; two writers at once: \"Updated elsewhere\"", r6);

    // T4: another tab, a person there: the same file open in a second page's editor, edited there (saved by itself): followed
    // here, "Updated by another tab"
    const t4f = await opened("/x/t4.tex");
    const tgt = await send("Target.createTarget", { url: base + "?tex=" + encodeURIComponent(t4f) + "&latex=1" });
    let tabs = []; for (let i = 0; i < 50 && !tabs.some((t) => t.id === tgt.targetId); i++) { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); await sleep(100); }
    const ws2 = new WebSocket(tabs.find((t) => t.id === tgt.targetId).webSocketDebuggerUrl);
    await new Promise((r) => (ws2.onopen = r));
    let n2 = 0; const wait2 = new Map();
    ws2.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && wait2.has(m.id)) { wait2.get(m.id)(m.result ?? m.error); wait2.delete(m.id); } };
    const ev2 = (expression) => new Promise((r) => { const id = ++n2; wait2.set(id, r); ws2.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); }).then((r) => r?.result?.value);
    let ready2 = false; for (let i = 0; i < 300 && !ready2; i++) { ready2 = !!(await ev2(`!!document.querySelector(".tex-src")`)); if (!ready2) await sleep(100); }
    await sleep(500);
    const saved2 = await ev2(`(async () => { const t = document.querySelector(".tex-src"); t.value = ${JSON.stringify(DOC + "% from the other tab\n")}; t.dispatchEvent(new Event("input"));
      for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 50)); if (document.querySelector(".tex-savestate").textContent === "Saved ✓") return true; } return false; })()`);
    const t4 = { ready2, saved2, followed: await srcBecomes(DOC + "% from the other tab\n", 8000), said: await statusIs(/^Updated by another tab$/, 3000) };
    await send("Target.closeTarget", { targetId: tgt.targetId }); ws2.close();
    check(Object.values(t4).every((v) => v === true), "T4 the same file saved from another tab's editor: followed here, \"Updated by another tab\"", t4);

    // T5: another device's change, as sync's view applies one (its op with origin "server"): followed when clean,
    // "Updated by another device"; the bar when not. (The bytes written here, the op told as the view tells it; the
    // write's own op held back.)
    const fromServer = (p, s) => ev(`(async () => { const ws = window.__sbTexWs; ws.tell = () => {};
      try { await ws.write(${JSON.stringify(p)}, new TextEncoder().encode(${JSON.stringify(s)})); } finally { delete ws.tell; }
      const e = await ws.stat(${JSON.stringify(p)}); ws.tell({ ops: [{ op: "write", path: e.path, kind: "file", fid: e.fid, t: Date.now(), device: "elsewhere", by: "person", origin: "server" }] }); return true; })()`);
    await opened("/x/t5.tex");
    const t5 = { hook: await ev(`!!window.__sbTexWs`) };
    if (t5.hook) {
      await fromServer("/x/t5.tex", DOC + "% synced\n");
      t5.followed = await srcBecomes(DOC + "% synced\n"); t5.said = await statusIs(/^Updated by another device$/, 3000);
      await typeInto(DOC + "% mine\n");
      await fromServer("/x/t5.tex", DOC + "% synced 2\n");
      t5.bar = await barShows(); t5.text = (await barText()) === "Another device changed this file while you were editing."; t5.src = await srcIs(DOC + "% mine\n");
    }
    check(Object.values(t5).every((v) => v === true) && Object.keys(t5).length === 6, "T5 another device's change (an op from the server): followed when clean, the bar when not", t5);

    // T5b: its bytes not here yet (a remote entry: readUpTo says "missing", sync-docs): this text kept, said; once
    // they are (sync-fetch installs them without an op), followed, "Updated by another device"
    await opened("/x/t5b.tex");
    await ev(`(() => { const ws = window.__sbTexWs, real = ws.readUpTo; window.__notHere = true; ws.readUpTo = function (p, ...a) { if (window.__notHere && p === "/x/t5b.tex") return Promise.reject(Object.assign(new Error("the contents of " + p + " are not in this browser"), { code: "missing" })); return real.call(this, p, ...a); }; return true; })()`);
    await fromServer("/x/t5b.tex", DOC + "% synced later\n");
    const t5b = { waiting: await statusIs(/^This file was changed on another device; its new text is on its way…$/, 5000), kept: await srcIs(DOC) };
    await sleep(2500);
    t5b.still = (await srcIs(DOC)) && !(await barUp());
    await ev(`window.__notHere = false; true`);
    Object.assign(t5b, { followed: await srcBecomes(DOC + "% synced later\n", 6000), said: await statusIs(/^Updated by another device$/, 3000) });
    await ev(`delete window.__sbTexWs.readUpTo; true`);
    check(Object.values(t5b).every((v) => v === true), "T5b another device's change whose bytes aren't here yet: this text kept, said; followed once they are", t5b);
    // T5c (grader X21): a read that succeeds while the entry is still remote (its bytes on their way): this text
    // kept, said, nothing shown from that read; followed once the entry is local
    await opened("/x/t5c.tex");
    await ev(`(() => { const ws = window.__sbTexWs, real = ws.readUpTo; window.__remote = true; ws.readUpTo = async function (p, ...a) { const r = await real.call(this, p, ...a); return window.__remote && p === "/x/t5c.tex" ? { ...r, entry: { ...r.entry, remote: true } } : r; }; return true; })()`);
    await fromServer("/x/t5c.tex", DOC + "% synced remote\n");
    const t5c = { waiting: await statusIs(/^This file was changed on another device; its new text is on its way…$/, 5000), kept: await srcIs(DOC) };
    await sleep(2500);
    t5c.still = (await srcIs(DOC)) && !(await barUp());
    await ev(`window.__remote = false; true`);
    Object.assign(t5c, { followed: await srcBecomes(DOC + "% synced remote\n", 6000), said: await statusIs(/^Updated by another device$/, 3000), save: (await saveState()) === "Saved ✓" });
    await ev(`delete window.__sbTexWs.readUpTo; true`);
    check(Object.values(t5c).every((v) => v === true), "T5c a remote entry read while its bytes are on their way: this text kept, said; followed (and saveable) once local", t5c);

    // E1: deleted elsewhere: the text kept, never emptied, said; renamed elsewhere: no reload; another file put at
    // its old path while a change is looked at: never shown here
    await opened("/x/e1.tex");
    await ev(`${W}.remove("/x/e1.tex").then(() => 1)`);
    const e1 = { said: await statusIs(/^This file was deleted elsewhere; your text is still here\.$/, 5000), src: await srcIs(DOC) };
    await opened("/x/e1b.tex"); await spy();
    await ev(`${W}.rename("/x/e1b.tex", "/x/e1c.tex").then(() => 1)`); await sleep(400);
    e1.renamed = (await srcIs(DOC)) && !/Updated/.test(await status());
    await hold("__sbTexCheckRead", "before");
    await agentWrite("/x/e1c.tex", DOC + "% theirs\n");
    e1.held = await held("__sbTexCheckRead");
    await ev(`${W}.rename("/x/e1c.tex", "/x/e1d.tex").then(() => 1)`);
    // (the other file at a revision of its own, not this one's: never mistaken for a revision already shown)
    await mk("/x/e1c.tex", enc("IMPOSTER\n"));
    await ev(`${W}.write("/x/e1c.tex", new TextEncoder().encode("IMPOSTER 2\\n")).then(() => ${W}.write("/x/e1c.tex", new TextEncoder().encode("IMPOSTER 3\\n")))`);
    await release("__sbTexCheckRead");
    e1.after = await srcBecomes(DOC + "% theirs\n");
    e1.never = !(await ev(`window.__vals.some((v) => v.includes("IMPOSTER"))`));
    check(Object.values(e1).every((v) => v === true), "E1 deleted elsewhere: the text kept, said; renamed: no reload; another file at the old path: never shown here", e1);

    // E2: a shorter text: the cursor past its end clamped, the scroll within it
    await opened("/x/e2.tex", enc(LONG));
    await ev(`(() => { const t = document.querySelector(".tex-src"); t.focus(); t.setSelectionRange(t.value.length - 5, t.value.length); t.scrollTop = t.scrollHeight; return true; })()`);
    await agentWrite("/x/e2.tex", DOC);
    const e2 = { followed: await srcBecomes(DOC) };
    Object.assign(e2, await ev(`(() => { const t = document.querySelector(".tex-src"); return { a: t.selectionStart, b: t.selectionEnd, n: t.value.length, top: t.scrollTop, max: Math.max(0, t.scrollHeight - t.clientHeight) }; })()`));
    check(e2.followed && e2.a <= e2.n && e2.b === e2.n && e2.top <= e2.max, "E2 a shorter text: the cursor and scroll clamped to it", e2);

    // E3: an editor that can't save (mixed line endings), unsaved edits, a change: only Use theirs; the copy has LF
    await opened("/x/e3.tex", enc("a\r\nb\nc\n"));
    const rv3a = await revOf("/x/e3.tex");
    await typeInto("a\nb\nc\nmine\n");
    await sleep(1200);
    const e3a = { ro: (await saveState()) === "Read-only", none: (await revOf("/x/e3.tex")) === rv3a,
      noPrompt: await ev(`(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return !e.defaultPrevented; })()`) };
    check(Object.values(e3a).every((v) => v === true), "E3a a read-only editor, edited: Read-only, nothing written past the debounce, no prompt", e3a);
    await agentWrite("/x/e3.tex", DOC);
    const e3 = { bar: await barShows(), buttons: (await page(`[P.querySelector(".tex-theirs")?.hidden === false, P.querySelector(".tex-mine")?.hidden === false]`)).join() === "true,false" };
    await click(".tex-theirs");
    Object.assign(e3, { said: await statusIs(/^Your text is in e3 \(mine\)\.tex$/, 8000), copy: JSON.stringify(await bytesOf("/x/e3 (mine).tex").catch(() => null)) === JSON.stringify(enc("a\nb\nc\nmine\n")), src: await srcIs(DOC), save: (await saveState()) === "Saved ✓" });
    check(Object.values(e3).every((v) => v === true), "E3 an unsaveable editor: the bar offers only Use theirs; the copy LF; theirs here, saveable", e3);
    // (U8 r6, beyond the plan (@sagebrush, Nov 5: its own pin, for SEC and ENGINE): the editor opened read-only is
    //  saved as you type once Use theirs made it saveable: an edit, no Ctrl/Cmd+S, the file has it, Saved ✓; before,
    //  while it was read-only, nothing was written and nothing prompted)
    const e3b = {};
    const rv3 = await revOf("/x/e3.tex");
    await typeInto(DOC + "% after Use theirs\n");
    Object.assign(e3b, { written: await until(`(async () => new TextDecoder().decode((await ${W}.read("/x/e3.tex")).content) === ${JSON.stringify(DOC + "% after Use theirs\n")})()`, 8000), saved: await savedNow(5000), once: (await revOf("/x/e3.tex")) - rv3 === 1,
      noPrompt: await ev(`(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return !e.defaultPrevented; })()`) });
    check(Object.values(e3b).every((v) => v === true), "E3b read-only, then Use theirs: saveable, and an edit is saved by itself (no Ctrl/Cmd+S), Saved ✓, no prompt", e3b);

    // E4: a clean editor; the file made binary elsewhere: this text kept, Read-only, said; made mixed-ending: shown,
    // Read-only; nothing written after either
    await opened("/x/e4.tex");
    await put("/x/e4.tex", [0x61, 0, 0x62]);
    const e4 = { said: await statusIs(/^Claude Code changed this file into one the editor can't show/, 5000), src: await srcIs(DOC), off: await page(`P.querySelector(".tex-savestate").textContent === "Read-only" && P.querySelector(".tex-banner").textContent.includes("NUL")`) };
    const rv4 = await revOf("/x/e4.tex");
    await put("/x/e4.tex", enc("x\r\ny\nz\n"));
    Object.assign(e4, { mixed: await srcBecomes("x\ny\nz\n"), off2: await page(`P.querySelector(".tex-savestate").textContent === "Read-only" && P.querySelector(".tex-banner").textContent.includes("mixes line endings")`) });
    await sleep(500);
    e4.writes = (await revOf("/x/e4.tex")) - rv4 === 1;
    check(Object.values(e4).every((v) => v === true), "E4 made binary elsewhere: the text kept, Read-only; made mixed-ending: shown, Read-only; nothing written after", e4);
    await ev(`window.onbeforeunload = null; true`);
  }

  // ---- images as TeX finds them (William's L2, Nov 2: cv.tex in "LaTeX examples/", images.png at the top, "not
  // found"): in the folder, in a parent (../), in a \graphicspath folder, each from a blob: URL; a file of that name
  // elsewhere named without ../: where it is and what to write; missing everywhere: the folders searched; above the top
  const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 227, 85, 242, 156, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
  await go(base + "?latex=1"); await until(`!!${W}`, 60000);
  await mk("/img/fig.png", png);
  await mk("/other.png", png);
  await mk("/img/figs/deep.png", png);
  const fi = await mk("/img/doc.tex", enc("\\documentclass{article}\n\\graphicspath{{figs/}}\n\\begin{document}\n\\includegraphics{fig}\n\\includegraphics{../other.png}\n\\includegraphics{deep}\n\\includegraphics{other.png}\n\\includegraphics{nowhere.png}\n\\includegraphics{../../../up.png}\n\\includegraphics{/other.png}\n\\includegraphics{/nope.png}\n\\end{document}\n"));
  await open(fi);
  check(await until(`[...document.querySelectorAll(".tex-preview img.graphic")].filter((i) => i.src.startsWith("blob:")).map((i) => i.alt).sort().join() === "../other.png,/other.png,deep,fig"`, 15000),
    "images in the folder, in a parent (../), in a \\graphicspath folder and from the workspace's top (/other.png): each shown from a blob: URL", await ev(`[...document.querySelectorAll(".tex-preview img.graphic")].map((i) => i.alt)`));
  const ph = await ev(`[...document.querySelectorAll(".tex-preview .imgph")].map((e) => e.textContent)`);
  check(ph.includes('[image: other.png: not found in "img/", "img/figs/"; it is in the top folder: write {../other.png}, or move the file into "img/"]'), "a file of that name in a parent, named without ../: the folders searched, where it is and what to write", ph);
  check(ph.includes('[image: nowhere.png: not found in "img/", "img/figs/"]') && ph.includes("[image: ../../../up.png: above the workspace's top folder]")
    && ph.includes("[image: /nope.png: not found in the top folder (a leading / is the workspace's top folder)]"), "…missing everywhere: the folders searched (a leading /: the workspace's top); above the top folder: refused, with its reason", ph);

  // ---- \input and \include (William's L4, Nov 2: silently ignored, which broke his shared macros file): a macros file
  // in another folder (../), its macros applied; \include's text shown; a missing file a gray tag naming where it was
  // looked for; the macros file changed elsewhere (another tab, an agent): the preview shows the new macro
  {
    await mk("/shared/macros.tex", enc("\\newcommand{\\greet}{Hello from the macros file}\n"));
    await mk("/paper/part.tex", enc("Included part text.\n"));
    const fp = await mk("/paper/main.tex", enc("\\documentclass{article}\n\\input{../shared/macros}\n\\begin{document}\n\\greet.\n\\include{part}\n\\input{missing}\n\\end{document}\n"));
    await open(fp);
    const shown = await until(`document.querySelector(".tex-preview")?.textContent.includes("Hello from the macros file") && document.querySelector(".tex-preview").textContent.includes("Included part text.")`, 15000);
    check(shown, "\\input{../shared/macros}: its macro applied; \\include{part}: its text shown", await ev(`(document.querySelector(".tex-preview") ?? document.body).textContent.slice(0, 300)`));
    check(await until(`document.querySelector(".tex-preview").textContent.includes('[input: missing: not found in "paper/"]')`, 15000), "a missing \\input: a gray tag naming where it was looked for", await ev(`[...document.querySelectorAll(".tex-preview .errchip")].map((e) => e.textContent)`));
    await ev(`${W}.write("/shared/macros.tex", new TextEncoder().encode("\\\\newcommand{\\\\greet}{Changed elsewhere}\\n")).then(() => 1)`);
    check(await until(`document.querySelector(".tex-preview").textContent.includes("Changed elsewhere.")`, 15000), "the macros file changed elsewhere: the preview shows the new macro", await ev(`document.querySelector(".tex-preview").textContent.slice(0, 200)`));
  }

  // ---- images under overlapping renders (astra3 i1c01 A3-1): the first image read held (the test build's hook),
  // then an edit makes a second current render, which asks for the same names again; released, each name is read
  // once and kept once, and the count bound (64) holds: 66 names, one of them twice, give 64 blobs and 2 refusals
  const N = 66;
  for (let i = 0; i < N; i++) await mk(`/many/f${i}.png`, png);
  const manyDoc = "\\documentclass{article}\n\\begin{document}\n\\includegraphics{f0}\n" + Array.from({ length: N }, (_, i) => `\\includegraphics{f${i}}\n`).join("") + "\\end{document}\n";
  const fm = await mk("/many/doc.tex", enc(manyDoc));
  const hook = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    window.__reads = []; window.__holds = []; window.__released = false; window.__blobs = 0;
    const make = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.__blobs++; return make(b); };
    window.__sbTexImageRead = (p) => { window.__reads.push(p); if (!window.__released) return new Promise((r) => window.__holds.push(r)); };
  })()` });
  await open(fm);
  const held = await until(`window.__holds.length === 1`, 20000);
  await typeInto(manyDoc.replace("\\end{document}", "% a second render\n\\end{document}"));
  await sleep(2000);
  const whileHeld = await ev(`({ reads: window.__reads.length, holds: window.__holds.length, blobs: window.__blobs })`);
  check(held && whileHeld.reads === 1 && whileHeld.holds === 1 && whileHeld.blobs === 0, "a held image read and a second current render: no second resolution starts (one read, no blob)", whileHeld);
  await ev(`(() => { window.__released = true; for (const r of window.__holds.splice(0)) r(); return true; })()`);
  const settled = await until(`document.querySelectorAll(".tex-preview img.graphic").length >= 64 && (document.querySelector(".tex-preview").textContent.match(/: too many images\\]/g) || []).length >= 2`, 30000);
  await sleep(1000);
  const after = await ev(`({ reads: window.__reads.length, unique: new Set(window.__reads).size, blobs: window.__blobs, imgs: new Set([...document.querySelectorAll(".tex-preview img.graphic")].map((i) => i.src)).size, refused: (document.querySelector(".tex-preview").textContent.match(/: too many images\\]/g) || []).length })`);
  check(settled && after.reads === 64 && after.unique === 64 && after.blobs === 64 && after.imgs === 64 && after.refused === 2, "released: each name read once, 64 blobs (the count bound), the 2 over it refused, no duplicate blob", after);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: hook.identifier });
  // ---- (astra B5-A2) an image read that completes after the page was disposed of keeps nothing: held, another file
  // opened in place, then released: no blob made
  {
    await mk("/late/p.png", png);
    const fl = await mk("/late/doc.tex", enc("\\documentclass{article}\n\\begin{document}\n\\includegraphics{p}\n\\end{document}\n"));
    const fo = await mk("/late/other.tex", enc("\\documentclass{article}\n\\begin{document}\nThe other one.\n\\end{document}\n"));
    const h2 = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      window.__holds = []; window.__blobs = 0;
      const make = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.__blobs++; return make(b); };
      window.__sbTexImageRead = () => new Promise((r) => window.__holds.push(r));
    })()` });
    await open(fl);
    const heldImg = await until(`window.__holds.length === 1`, 20000);
    await ev(`(window.__sbTex({ path: "/late/other.tex", fid: ${JSON.stringify(fo)} }), true)`);
    const other = await until(`document.querySelector(".tex-preview")?.textContent.includes("The other one.")`, 20000);
    await ev(`(() => { for (const r of window.__holds.splice(0)) r(); return true; })()`);
    await sleep(1500);
    const late = await ev(`({ blobs: window.__blobs, imgs: document.querySelectorAll("img.graphic").length })`);
    check(heldImg && other && late.blobs === 0 && late.imgs === 0, "B5-A2: an image read completing after its page was disposed of: no blob made", late);
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: h2.identifier });
  }

  // ---- non-ASCII HTML (daybreak2 i1c01): the patch budget's 512 KiB is UTF-8 bytes, split.ts's measure: a 1.95 MB
  // (UTF-8) paragraph of three-byte characters is patched with no step over 512 KiB, the byte stop seen ending steps.
  // (the paragraph's source in lines of 100 words, a newline being a space to TeX: the same one paragraph and the same
  //  preview (60 pieces, 1,951,554 UTF-8 bytes), without the page laying out a 1.95 MB one-line source in one main-thread
  //  task. That task (9 s on a build box, 52 s at 4x CPU throttling) ran past the 180 s wait below on CI runners twice
  //  (master 576f0bf6 job 126471282729, #617 job 126576160008: no reply, the 15 s watchdog firing at 209 s); in lines,
  //  2.3 s and 7.8 s)
  const cjk = "\\documentclass{article}\n\\begin{document}\n" + Array.from({ length: 1500 }, () => "中文字体 ".repeat(100).trimEnd()).join("\n") + "\n\\end{document}\n";
  const fc = await mk("/t/cjk.tex", enc(cjk));
  await open(fc);
  // (the case is the patch, so its bound is the patch's: the wait for it starts once the worker's reply is in, the
  // editor's tex-parse-done mark. Before that the page lays out the 1.95 MB source, in lines above so no longer one
  // long native task (one line was 9 s on a build box, 52-57 s at 4x CPU throttling), against the patch itself in
  // 0.2-0.5 s with no step over 9 ms. Whatever the case sees is returned, and the check fails with it, never a throw on
  // a missing field)
  const parsedIn = await (async () => { const t = Date.now(); return (await until(`performance.getEntriesByType("mark").some((m) => m.name === "tex-parse-done")`, 180000)) ? Date.now() - t : null; })();
  const cjkOk = parsedIn !== null && await until(`document.querySelectorAll(".tex-preview .pc").length > 10 && !!document.querySelector(".tex-preview").dataset.stops`, 60000);
  const cj = await ev(`(() => { const p = document.querySelector(".tex-preview"), d = p?.dataset ?? {}; const pcs = p ? [...p.querySelectorAll(".pc")] : []; const enc = new TextEncoder(); let stops = null; try { stops = JSON.parse(d.stops); } catch {}
    return { pcs: pcs.length, utf8: pcs.reduce((a, p) => a + enc.encode(p.innerHTML).length, 0), units: pcs.reduce((a, p) => a + p.innerHTML.length, 0), stepBytesMax: +(d.stepBytesMax ?? 0), stops, patchMaxMs: d.patchMaxMs ?? null,
      status: document.querySelector(".tex-status")?.textContent ?? "", marks: performance.getEntriesByType("mark").filter((m) => /^tex-/.test(m.name)).map((m) => m.name + "@" + Math.round(m.startTime)).slice(-8) }; })()`);
  console.log("non-ASCII patch (reply after, UTF-8 bytes, UTF-16 units, the most bytes in one step, the stops):", JSON.stringify({ parsedIn, ...cj, marks: undefined }));
  check(cjkOk && cj.utf8 > 3 * 512 * 1024 && cj.utf8 > 2 * cj.units && cj.stepBytesMax > 0 && cj.stepBytesMax <= 512 * 1024 && cj.stops?.bytes > 0, "non-ASCII: no patch step over 512 KiB of UTF-8, the byte stop ending steps", { parsedIn, ...cj });

  // ---- a large paragraph and list: pieces of at most 128 KiB, never two versions at once
  const para = "\\documentclass{article}\n\\begin{document}\n" + "word ".repeat(200000) + "\n\n\\begin{itemize}\n" + "\\item list item text\n".repeat(22000) + "\\end{itemize}\n\\end{document}\n";
  const fb = await mk("/t/big.tex", enc(para));
  await open(fb);
  const bigOk = await until(`document.querySelectorAll(".tex-preview .pc").length > 10`, 60000);
  check(bigOk, "a large document: shown in pieces", await ev(`({ pcs: document.querySelectorAll(".tex-preview .pc").length, status: document.querySelector(".tex-status")?.textContent, bound: document.querySelector(".tex-preview .bounderr")?.textContent, ph: document.querySelectorAll(".tex-preview .toolarge").length })`));
  check(await ev(`[...document.querySelectorAll(".tex-preview .pc")].every((p) => new TextEncoder().encode(p.innerHTML).length <= 128 * 1024 + 64)`), "…each piece at most 128 KiB");
  check(await ev(`[...document.querySelectorAll(".tex-preview .pc > .list.cont")].length > 0 && [...document.querySelectorAll(".tex-preview .pc > .p.cont")].length > 0`), "…lists and paragraphs continued in copies of their container");
  // (an observer: no moment where an old and a new version of a group are both visible)
  await ev(`(() => { window.__mixed = 0; new MutationObserver(() => { const vis = [...document.querySelectorAll(".tex-preview > .ch:not([hidden])")]; const words = vis.filter((c) => c.textContent.includes("CHANGED")).length; if (words && vis.some((c) => c.textContent.startsWith("word word") && !c.textContent.includes("CHANGED") && c.querySelector(".p"))) window.__mixed++; }).observe(document.querySelector(".tex-preview"), { childList: true, subtree: false, attributes: true, attributeFilter: ["hidden"] }); return true; })()`);
  await typeInto(para.replace("word word", "CHANGED word"));
  check(await until(`document.querySelector(".tex-preview").textContent.includes("CHANGED")`, 60000), "the edited large paragraph is re-patched");
  check((await ev(`window.__mixed`)) === 0, "…never an old and a new version of it at once");

  // ---- the patch loop: no Long Task over 50 ms from the edit's synchronous work (the textarea's setter and the input
  // handler) or from the scheduler tasks after it (the highlighter, the worker's reply, the re-patch and swap), until
  // the preview has the edit. It doesn't measure frame rendering (edit-to-paint): headless Chromium on the timing box
  // doesn't run it in an observed task. Timing assertions gate only on a timing box (BOX "timing", VM3/VM4:
  // @sagebrush's ruling, Oct 29); on a build box they are recorded.
  // The window (LR-1, astra's and daybreak3's ruling, Oct 31): the edited 1.5 MiB text is staged in the page first, in
  // its own task; then a fresh observer; then a small evaluate schedules ONE page task that assigns it and dispatches
  // input. (A page task, not the evaluate: CDP's evaluate runs as a V8 interrupt, which the Long Task API doesn't see.
  // The old window's result, from a trigger that didn't change the text, is retired as unattributed.) The edit must land, its marker in the
  // preview, or this fails: never a timing pass. The observer is checked first: an 80 ms busy loop in a page task,
  // with an observer of its own, is seen.
  const edited2 = para.replace("word word", "AGAIN word");
  const staged = await ev(`(() => { window.__staged = ${JSON.stringify(edited2)}; const v = document.querySelector(".tex-src").value; return { len: window.__staged.length, differs: window.__staged !== v, had: v.includes("CHANGED") }; })()`);
  check(edited2 !== para && staged.len === edited2.length && staged.differs && staged.had, "the re-patch's edit: staged, and a change of the text the editor has (CHANGED to AGAIN)", staged);
  const watchLt = `(() => { window.__lt = []; window.__ltOb?.disconnect(); window.__ltOb = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }); window.__ltOb.observe({ type: "longtask", buffered: false }); return true; })()`;
  await ev(watchLt);
  await ev(`(() => { setTimeout(() => { const t = performance.now(); while (performance.now() - t < 80); }, 0); return true; })()`);
  await sleep(300);
  const ltc = await ev(`window.__lt`);
  check(ltc.some((d) => d >= 75), "the Long Task observer sees an 80 ms busy loop in a page task (the window's sensitivity)", ltc);
  await sleep(300);
  await ev(watchLt);
  await ev(`(() => { setTimeout(() => { const t = document.querySelector(".tex-src"); t.value = window.__staged; t.dispatchEvent(new Event("input")); }, 0); return true; })()`);
  const landed = await until(`document.querySelector(".tex-preview").textContent.includes("AGAIN") && !document.querySelector(".tex-preview").textContent.includes("CHANGED")`, 60000);
  await sleep(500);
  const lts = await ev(`window.__lt`);
  check(landed, "the re-patch's edit landed: AGAIN in the preview, CHANGED gone");
  const own = await ev(`({ step: +document.querySelector(".tex-preview").dataset.patchMaxMs, swap: +document.querySelector(".tex-preview").dataset.swapMaxMs, reply: +document.querySelector(".tex-preview").dataset.replyMs })`);
  console.log("long tasks during the re-patch (ms):", JSON.stringify(lts), "patch loop's own longest step and swap (ms):", JSON.stringify(own));
  if (BOX === "timing") {
    check(own.step <= 50 && own.swap <= 50, "the patch loop's own steps and swap each under 50 ms (a timing box)", own);
    check(landed && lts.every((d) => d <= 50), "no Long Task over 50 ms while re-patching (a timing box)", { lts, own, landed });
  } else console.log("timing, reported, not gated (a build box): long tasks over 50 ms:", JSON.stringify(lts.filter((d) => d > 50)), "own step/swap over 50 ms:", own.step > 50 || own.swap > 50);

  // ---- a 1.5 MiB enumerate and a 1.5 MiB plain theorem: pieces whose styles and labels continue; a large table: a placeholder
  const thmDoc = "\\documentclass{article}\n\\newtheorem{theorem}{Theorem}\n\\begin{document}\n\\begin{theorem}\n" + "theorem words go on and on here. ".repeat(6000).split(". ").join(".\n\n") + "\n\\end{theorem}\n\n\\begin{enumerate}\n" + "\\item an item\n".repeat(6000) + "\\end{enumerate}\n\\end{document}\n";
  const ft = await mk("/t/thm.tex", enc(thmDoc));
  await open(ft);
  // (all 6000 labels: under load the read could come before the last patch was in; a lost label still fails below)
  await until(`document.querySelectorAll(".tex-preview .thm.cont").length > 0 && document.querySelectorAll(".tex-preview .list.cont").length > 0 && document.querySelectorAll(".tex-preview ol.list > li > .lbl").length >= 6000`, 60000);
  const cont = await ev(`(() => {
    const thms = [...document.querySelectorAll(".tex-preview .thm")], lists = [...document.querySelectorAll(".tex-preview ol.list")];
    const fs = (e) => getComputedStyle(e).fontStyle, pl = (e) => getComputedStyle(e).paddingLeft, cls = (e) => [...e.classList].filter((c) => c !== "cont").join(".");
    const labels = lists.flatMap((l) => [...l.querySelectorAll(":scope > li > .lbl")].map((x) => x.textContent));
    return { thms: thms.length, thmSame: thms.every((t) => fs(t) === fs(thms[0]) && cls(t) === cls(thms[0])), lists: lists.length, listSame: lists.every((l) => pl(l) === pl(lists[0]) && cls(l) === cls(lists[0])), labels: labels.length, seq: labels.every((t, i) => t === (i + 1) + "."), status: document.querySelector(".tex-status")?.textContent, bound: !!document.querySelector(".tex-preview .bounderr") };
  })()`);
  check(cont.thms > 1 && cont.thmSame && cont.lists > 1 && cont.listSame && cont.labels === 6000 && cont.seq, "split theorem and list: the same classes and computed styles in every piece, labels 1..6000 in order", cont);
  const tabDoc = "\\documentclass{article}\n\\begin{document}\n\\begin{tabular}{ll}\n" + "aaaaaaaaaaaaaaaaaaaaaaaa & b \\\\\n".repeat(6000) + "\\end{tabular}\n\\end{document}\n";
  const ftab = await mk("/t/tab.tex", enc(tabDoc));
  await open(ftab);
  check(await until(`document.querySelector(".tex-preview").textContent.includes("this table is too large to display in the prototype")`, 60000), "a table over 128 KiB: a placeholder with its reason, never split", await ev(`({ status: document.querySelector(".tex-status")?.textContent, tables: document.querySelectorAll(".tex-preview table").length })`));

  // ---- r5 §4's worst cases: one line of 1 MiB - 1 (the plain path) edited at its end; a chunk over 2 MiB (a placeholder)
  const oneLine = "\\documentclass{article}\\begin{document}" + "x".repeat(2 ** 20 - 1 - 60) + "\\end{document}";
  const fl = await mk("/t/oneline.tex", enc(oneLine));
  await open(fl); await sleep(1000);
  await ev(`(() => { window.__lt2 = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt2.push(Math.round(e.duration)); }).observe({ type: "longtask" }); return true; })()`);
  await typeInto(oneLine.replace("\\end{document}", "y\\end{document}")); await sleep(2500);
  const lt2 = await ev(`window.__lt2`);
  console.log("long tasks after an edit of a 1 MiB line (ms):", JSON.stringify(lt2));
  check(await ev(`document.querySelectorAll(".tex-hl .hl-line").length === 1 && !document.querySelector(".tex-hl .hl-line span")`), "a 1 MiB line: drawn plain, not highlighted");
  check(await ev(`document.querySelector(".tex-ed").classList.contains("nowrap") && document.querySelector(".tex-src").wrap === "off"`), "a 1 MiB line: the source not wrapped (a line over 16 KiB)");
  const big3 = "\\documentclass{article}\n\\begin{document}\n" + "word ".repeat(460000) + "\n\\end{document}\n";
  const f3m = await mk("/t/huge-chunk.tex", enc(big3));
  await open(f3m);
  check(await until(`document.querySelector(".tex-preview").textContent.includes("this block is too large to display in the prototype")`, 60000), "a chunk over 2 MiB: a placeholder with its size, nothing inserted", await ev(`({ status: document.querySelector(".tex-status")?.textContent, pcs: document.querySelectorAll(".tex-preview .pc").length })`));
  // ---- the editor's layout and controls (William's feedback on the first prototype, batch 1)
  // A0: the file browser's New offers a LaTeX file when the editor is on (and only then): made, with a short document,
  // and opened in the editor
  const newMenu = async (q) => {
    await ev(`localStorage.setItem("sagebrush-files-sidebar", "1"); true`);
    await go(base + q); await until(`!!${W}`, 60000);
    await until(`!!document.querySelector('.sbfiles .fh button[aria-label="New"]')`, 20000);
    return ev(`(async () => { document.querySelector('.sbfiles .fh button[aria-label="New"]').click(); await new Promise((r) => setTimeout(r, 0)); return [...document.querySelectorAll(".sbfmenu button")].map((b) => b.textContent); })()`);
  };
  const offItems = await newMenu("");
  check(JSON.stringify(offItems) === JSON.stringify(["Notebook", "MATLAB notebook", "Board", "LaTeX document", "Folder", "From an example…"]), "A0: on by default: with no flag, New offers a LaTeX file", offItems);
  const onItems = await newMenu("?latex=1");
  check(JSON.stringify(onItems) === JSON.stringify(["Notebook", "MATLAB notebook", "Board", "LaTeX document", "Folder", "From an example…"]), "A0: the editor on: New offers a LaTeX file", onItems);
  await mark();
  await ev(`([...document.querySelectorAll(".sbfmenu button")].find((b) => b.textContent === "LaTeX document").click(), true)`);
  const made = await fresh(`!!document.querySelector(".tex-page .tex-src") && !!${W}`, 20000);
  const newTex = made && await ev(`${W}.stat("/Untitled (3).tex").then((e) => ({ kind: e?.kind, fid: e?.fid ?? "", here: !!e?.fid && new URLSearchParams(location.search).get("tex") === e.fid }))`);
  check(made && newTex.kind === "file" && newTex.fid && newTex.here && JSON.stringify(await bytesOf("/Untitled (3).tex")) === JSON.stringify(enc("\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n")), "A0: New, LaTeX document: /Untitled (3).tex (the phone checks made the first two) made, with a short document, and opened in the editor", newTex);
  // (the board page's File ▸ New, the same order (U0), and its LaTeX document: made at the top of the files and opened
  // in the editor, the notebook page's /?tex=<fid>)
  const untitled = `${W}.list("/").then((l) => l.filter((e) => /^\\/Untitled( \\(\\d+\\))?\\.tex$/.test(e.path)).map((e) => e.fid))`;
  const texBefore = await ev(untitled);
  await mark(); await send("Page.navigate", { url: base + "board/?new=python" });
  await fresh(`!!window.sagebrush?.board?.snapshot && window.sagebrush.board.snapshot().doc !== null && !!document.querySelector('[data-sbb=filemenu] [data-group=new]')`, 60000);
  const boardNew = await ev(`[...document.querySelector('[data-sbb=filemenu] [data-group=new]').nextElementSibling.querySelectorAll('button')].map((b) => b.dataset.sbb)`);
  check(JSON.stringify(boardNew) === JSON.stringify(["newnotebook", "newmatlab", "newboard", "newlatex", "newfolder", "examples"]), "U0: the board's File ▸ New is Notebook, MATLAB notebook, Board, LaTeX document, Folder, From an example…", boardNew);
  // (a note being written where it is when New ▸ LaTeX document is clicked: what is typed kept first (grader's K15))
  await ev(`window.sagebrush.board.edit((d) => { d.nodes = [{ id: "k15", title: "Note", text: "", x: 0, y: 0, w: 300 }]; }).then(() => 1)`);
  await ev("window.sagebrush.board.editing(true), 1");
  await ev(`Promise.resolve(window.sagebrush.board.focus(["k15"])).then(() => new Promise((r) => setTimeout(r, 400))).then(() => 1)`);
  await ev("(() => { const r = window.board.clientRect('k15'); const x = r.left + 20, y = r.top + 12; document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y })); return 1; })()");
  const writing = await until("window.board.editing === 'k15' && document.activeElement === document.querySelector('.board-editing .be-title')", 5000);
  const atNote = writing || await ev("(() => { const r = window.board.clientRect('k15'); const e = document.elementFromPoint(r.left + 20, r.top + 12); return { r: [r.left, r.top, r.width, r.height], at: e?.className?.baseVal ?? e?.className ?? e?.tagName, editing: window.board.editing }; })()");
  if (writing) { await ev("(() => { const t = document.querySelector('.board-editing .be-title'); t.setSelectionRange(t.value.length, t.value.length); return 1; })()"); await send("Input.insertText", { text: " kept" }); }
  const boardHref = await ev("location.href");
  await mark(); await ev(`(document.querySelector('[data-sbb=newlatex]').click(), true)`);
  const boardTex = await fresh(`location.pathname === "/" && /[?&]tex=/.test(location.search) && !!document.querySelector(".tex-page .tex-src") && !!${W}`, 60000).catch(() => false);
  const texAfter = boardTex ? await ev(untitled) : [], opened = await ev(`new URLSearchParams(location.search).get("tex")`);
  check(boardTex && texAfter.length === texBefore.length + 1 && texAfter.includes(opened) && !texBefore.includes(opened), "U0: the board's New ▸ LaTeX document: a new Untitled .tex made at the top of the files and opened in the editor", { texBefore, texAfter, opened });
  // (the board opened again: the note's title as typed)
  await mark(); await send("Page.navigate", { url: boardHref });
  await fresh(`!!window.sagebrush?.board?.snapshot && window.sagebrush.board.snapshot().doc !== null`, 60000).catch(() => false);
  const k15 = await ev(`window.sagebrush.board.snapshot().doc?.nodes?.find((n) => n.id === "k15")?.title ?? null`);
  check(writing && k15 === "Note kept", "U0: the board's New ▸ LaTeX document while a note is being written: what was typed is kept, in the board when it is opened again", { writing, atNote, k15, boardHref });
  // (written once more, on the board opened again, for the failure below: last, as a failed keep stays failed)
  await ev("window.sagebrush.board.editing(true), 1");
  await ev(`Promise.resolve(window.sagebrush.board.focus(["k15"])).then(() => new Promise((r) => setTimeout(r, 400))).then(() => 1)`);
  await ev("(() => { const r = window.board.clientRect('k15'); const x = r.left + 20, y = r.top + 12; document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y })); return 1; })()");
  const writing2 = await until("window.board.editing === 'k15' && document.activeElement === document.querySelector('.board-editing .be-title')", 5000);
  const texBefore2 = await ev(untitled);
  // (and when what is being written can't be kept: the departure says so, the board stays, nothing made (grader's
  // K15, @sagebrush's ruling): a board document's JSON.stringify made to throw once, for the keep alone)
  const failed = writing2 && await ev(`(async () => {
    const said = [], orig = JSON.stringify, alert0 = window.alert, before = location.href;
    JSON.stringify = function (v, ...a) { if (window.__k15 && v && Array.isArray(v.nodes)) { window.__k15 = false; throw new Error("k15 test: not kept"); } return orig.call(JSON, v, ...a); };
    window.alert = (m) => { said.push(String(m)); };
    window.__k15 = true;
    try {
      document.querySelector('[data-sbb=newlatex]').click();
      for (let i = 0; i < 100 && !said.length; i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 300));
      return { said, stayed: location.href === before, writing: window.board.editing === "k15" };
    } finally { window.__k15 = false; JSON.stringify = orig; window.alert = alert0; }
  })()`);
  const texKept = writing2 ? await ev(untitled) : [];
  check(failed && failed.said.length === 1 && /couldn't be kept/.test(failed.said[0]) && failed.stayed && texKept.length === texBefore2.length, "U0: the board's New ▸ LaTeX document when what is being written can't be kept: the person told why, the board stays, no .tex made", { writing2, failed, texBefore2, texKept });
  // ---- U0's entry points, each pinned (grader's r764): New LaTeX document in a folder (a folder's ⋯ menu, browser.ts;
  // the notebook page's hook; the page module's newTex), File ▸ New ▸ LaTeX document saving the notebook first, the
  // board's file panel From an example…, and the editor's File ▸ Open… and its Ctrl+O
  {
    // (a folder's ⋯: New LaTeX document here, made in that folder and opened in the editor)
    await ev(`localStorage.setItem("sagebrush-files-sidebar", "1"); true`);
    await go(base + "?latex=1"); await until(`!!${W}`, 60000);
    await ev(`${W}.mkdir("/u0sub").then(() => true, () => true)`);
    const subRow = '.sbfiles .frow[data-path="/u0sub"]';
    await until(`!!document.querySelector(${JSON.stringify(subRow)})`, 20000);
    await ev(`(document.querySelector(${JSON.stringify(subRow)}).querySelector("button.more").click(), true)`);
    const here = await until(`[...document.querySelectorAll(".sbfmenu button")].some((b) => b.textContent === "New LaTeX document here")`, 5000);
    check(here, "U0: a folder's ⋯ menu offers New LaTeX document here", await ev(`[...document.querySelectorAll(".sbfmenu button")].map((b) => b.textContent)`));
    if (here) { await mark(); await ev(`([...document.querySelectorAll(".sbfmenu button")].find((b) => b.textContent === "New LaTeX document here").click(), true)`); }
    const inSub = here && (await fresh(`!!document.querySelector(".tex-page .tex-src") && !!${W}`, 20000).catch(() => false)) && await ev(`${W}.stat("/u0sub/Untitled.tex").then((e) => !!e?.fid && new URLSearchParams(location.search).get("tex") === e.fid)`);
    check(inSub, "U0: New LaTeX document here: /u0sub/Untitled.tex, made in that folder and opened", { at: await ev("location.search"), sub: await ev(`${W}.list("/u0sub").then((l) => l.map((e) => e.path))`) });
    // (File ▸ New ▸ LaTeX document from a notebook with an edit not yet saved: saved first, and nobody asked to leave)
    await go(base + "?latex=1"); await until(`!!${W} && !!document.querySelector(".cell textarea")`, 60000);
    const edit = "u0_saved_first = " + Date.now(), d0 = dialogs.length;
    await mark();
    await ev(`(() => { const ta = document.querySelector(".cell textarea"); ta.value = ${JSON.stringify(edit)}; ta.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector('#filemenu [data-f="newlatex"]').click(); return true; })()`);
    const left = await fresh(`!!document.querySelector(".tex-page .tex-src") && !!${W}`, 20000).catch(() => false);
    const asked = dialogs.slice(d0);
    // (the notebook opened again, as a person going back would: the edit is in its cell)
    if (left) { await go(base + "?latex=1"); await until(`!!${W} && !!document.querySelector(".cell textarea")`, 60000); }
    const kept = left && await until(`[...document.querySelectorAll(".cell textarea")].some((t) => t.value.includes(${JSON.stringify(edit)}))`, 10000);
    check(left && kept && !asked.includes("beforeunload"), "U0: File ▸ New ▸ LaTeX document saves the notebook first: its edit kept, nobody asked to leave", { left, kept, dialogs: asked, cells: await ev(`[...document.querySelectorAll(".cell textarea")].map((t) => t.value.slice(0, 60))`) });
    // (the board's file panel: its New offers From an example…, as the File menu has it)
    await mark(); await send("Page.navigate", { url: base + "board/?new=python" });
    await fresh(`!!window.sagebrush?.board?.snapshot && window.sagebrush.board.snapshot().doc !== null && !!document.querySelector('.sbfiles .fh button[aria-label="New"]')`, 60000);
    const boardPanelNew = await ev(`(async () => { document.querySelector('.sbfiles .fh button[aria-label="New"]').click(); await new Promise((r) => setTimeout(r, 0)); return [...document.querySelectorAll(".sbfmenu button")].map((b) => b.textContent); })()`);
    check(boardPanelNew.includes("From an example…"), "U0: the board's file panel New offers From an example…", boardPanelNew);
    await ev(`(document.querySelectorAll(".sbfmenu").forEach((m) => m.remove()), true)`);
    // (the editor's File ▸ Open…: the files dialog; and Ctrl+O, its shortcut, the same)
    const subFid = await ev(`${W}.stat("/u0sub/Untitled.tex").then((e) => e?.fid ?? null)`);
    // (one dialog each time: the notebook page under the editor answers no File-menu key of its own)
    const inEditor = !!subFid && await open(subFid);
    if (inEditor) await ev(`(document.querySelector(".tex-filebtn").click(), document.querySelector('.tex-filemenu [data-item="open"]').click(), true)`);
    check(inEditor && await until(`document.querySelectorAll(".sbfopen").length === 1`, 5000), "U0: the editor's File ▸ Open… shows the files dialog", { subFid, n: await ev(`document.querySelectorAll(".sbfopen").length`) });
    await ev(`(document.querySelectorAll(".sbfopen").forEach((d) => d.remove()), true)`);
    if (inEditor) await send("Input.dispatchKeyEvent", { type: "keyDown", key: "o", code: "KeyO", modifiers: 2, windowsVirtualKeyCode: 79 });
    const ctrlO = inEditor && await until(`document.querySelectorAll(".sbfopen").length > 0`, 5000) && (await sleep(300), await ev(`document.querySelectorAll(".sbfopen").length`));
    check(ctrlO === 1, "U0: in the editor, Ctrl+O (File ▸ Open…'s shortcut) shows the files dialog, once", { ctrlO });
    await ev(`(document.querySelectorAll(".sbfopen").forEach((d) => d.remove()), true)`);
    // (Ctrl+Alt+N, New ▸ Notebook's shortcut: one notebook made, and opened)
    const nbs = `${W}.list("/").then((l) => l.filter((e) => e.kind === "notebook").map((e) => e.path).sort())`;
    const nbBefore = inEditor ? await ev(nbs) : [];
    if (inEditor) { await mark(); await send("Input.dispatchKeyEvent", { type: "keyDown", key: "n", code: "KeyN", modifiers: 3, windowsVirtualKeyCode: 78 }); }
    const nbOpened = inEditor && await fresh(`!!${W} && !!document.querySelector(".cell textarea") && !document.querySelector(".tex-page")`, 20000).catch(() => false);
    if (nbOpened) await sleep(1000);
    const nbAfter = inEditor ? await ev(`(async () => { for (let i = 0; i < 50 && !window.sagebrush?.workspace; i++) await new Promise((r) => setTimeout(r, 100)); return ${nbs}; })()`).catch(() => []) : [];
    check(nbOpened && nbAfter.length === nbBefore.length + 1, "U0: in the editor, Ctrl+Alt+N (New ▸ Notebook's shortcut) makes one notebook and opens it", { nbOpened, at: await ev("location.search").catch(() => null), old: await ev("!!window.__sbOld").catch(() => null), made: nbAfter.filter((p) => !nbBefore.includes(p)), dialogs: dialogText.slice(-3) });
  }
  // A1, A7: the files shown beside the page, not over it; Files hides and shows them, the document staying open
  const UXDOC = "\\documentclass{article}\n\\begin{document}\n\\section{Hello}\nSome text " + "long words ".repeat(60) + "\n\\end{document}\n";
  const fu = await mk("/t/ux.tex", enc(UXDOC));
  await open(fu);
  await until(`!document.getElementById("wssidebar").hidden && !!document.querySelector(".tex-src")`, 20000);
  const lay = () => ev(`(() => { const s = document.getElementById("wssidebar"), P = document.querySelector(".tex-page"), fb = document.querySelector(".sb-files-toggle") ?? P.querySelector(".tex-back"), b = fb.getBoundingClientRect();
    return { shown: !s.hidden, sideRight: s.hidden ? 0 : Math.round(s.getBoundingClientRect().right), left: Math.round(P.getBoundingClientRect().left), top: fb.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)), pressed: fb.getAttribute("aria-pressed"), text: P.querySelector(".tex-src")?.value }; })()`);
  const l1 = await lay();
  check(l1.shown && l1.left >= l1.sideRight - 1 && l1.top && l1.pressed === "true", "A1: files shown: the page starts right of them, its Files button not covered and pressed", l1);
  await page(`((document.querySelector(".sb-files-toggle") ?? P.querySelector(".tex-back")).click(), true)`); await sleep(300);
  const l2 = await lay();
  check(!l2.shown && l2.left === 0 && l2.pressed === "false" && l2.text === UXDOC, "A7: Files: the files hidden, the page full width, the same document open", { ...l2, text: l2.text?.length });
  await page(`((document.querySelector(".sb-files-toggle") ?? P.querySelector(".tex-back")).click(), true)`); await sleep(300);
  const l3 = await lay();
  check(l3.shown && l3.left >= l3.sideRight - 1 && l3.pressed === "true" && l3.text === UXDOC, "A7: Files again: the files shown beside it, the document still open", { ...l3, text: l3.text?.length });
  // A5: a long line wraps, in the textarea and in the lines drawn behind it alike (no part of it cut off at the right)
  const wrap = await ev(`(() => { const s = document.querySelector(".tex-src"), hl = document.querySelector(".tex-hl"), lh = parseFloat(getComputedStyle(s).lineHeight), line = hl.querySelectorAll(".hl-line")[3];
    return { nowrap: document.querySelector(".tex-ed").classList.contains("nowrap"), wrapAttr: s.wrap, over: s.scrollWidth - s.clientWidth, rows: Math.round(line.getBoundingClientRect().height / lh), heights: [s.scrollHeight, hl.scrollHeight], widths: [s.clientWidth, hl.clientWidth] }; })()`);
  check(!wrap.nowrap && wrap.wrapAttr === "soft" && wrap.over <= 1 && wrap.rows >= 3 && Math.abs(wrap.heights[0] - wrap.heights[1]) <= 2 && Math.abs(wrap.widths[0] - wrap.widths[1]) <= 1, "A5: a long line wraps, nothing to scroll sideways; the lines behind wrap the same (same width, same height)", wrap);
  // A4: the source's font size and the preview's zoom, by their buttons, remembered across a reload
  const fs0 = await ev(`parseFloat(getComputedStyle(document.querySelector(".tex-src")).fontSize)`);
  check(await ev(`document.querySelector(".tex-preview").style.zoom === "" && document.querySelector(".tex-zoomv").textContent === "100%"`), "A4: at the default 100%, no inline zoom on the preview");
  await page(`(P.querySelector('[aria-label="Larger source text"]').click(), P.querySelector('[aria-label="Larger source text"]').click(), P.querySelector('[aria-label="Zoom the preview in"]').click(), true)`);
  const view = () => ev(`(() => { const s = document.querySelector(".tex-src"), hl = document.querySelector(".tex-hl"); return { src: parseFloat(getComputedStyle(s).fontSize), hl: parseFloat(getComputedStyle(hl).fontSize), zoom: document.querySelector(".tex-preview").style.zoom, shown: document.querySelector(".tex-zoomv").textContent, kept: [localStorage.getItem("sagebrush-latex-font"), localStorage.getItem("sagebrush-latex-zoom")] }; })()`);
  const v1 = await view();
  check(v1.src === fs0 + 2 && v1.hl === v1.src && v1.zoom === "1.1" && v1.shown === "110%" && v1.kept[0] === String(fs0 + 2) && v1.kept[1] === "110", "A4: larger source text (twice) and the preview zoomed in: applied to the source and the lines behind it, kept", { fs0, v1 });
  await open(fu); await until(`!!document.querySelector(".tex-src")`, 20000);
  const v2 = await view();
  check(v2.src === fs0 + 2 && v2.hl === v2.src && v2.zoom === "1.1" && v2.shown === "110%", "A4: after a reload, the same font size and zoom", v2);
  await ev(`localStorage.removeItem("sagebrush-latex-font"); localStorage.removeItem("sagebrush-latex-zoom"); true`);
  // A7: a notebook opened from the files beside the page opens by its URL (not loaded unseen under the editor), by
  // its row and by its menu's Open (both through the notebook page's openId); a folder named like a notebook still
  // opens as a folder
  const nbRef = await ev(`${W}.create("/uxnb.ipynb").then((e) => e.ref)`);
  await ev(`${W}.mkdir("/notes.ipynb").then(() => 1)`); await mk("/notes.ipynb/inside.txt", enc("x\n"));
  const rowOf = (p) => `document.querySelector('.frow[data-path="${p}"]')`;
  const rows = await until(`!!${rowOf("/uxnb.ipynb")} && !!${rowOf("/notes.ipynb")}`, 15000);
  if (rows) await ev(`(${rowOf("/notes.ipynb")}.click(), true)`);
  const folderOk = rows && await until(`!!${rowOf("/notes.ipynb/inside.txt")}`, 5000) && await ev(`!!document.querySelector(".tex-page") && !document.querySelector(".tex-page .tex-gone")`);
  check(folderOk, "A7: a folder named notes.ipynb, clicked beside the editor: opened as a folder, the editor still here", { rows, folderOk });
  requests.length = 0;
  await mark();
  if (rows) await ev(`(${rowOf("/uxnb.ipynb")}.querySelector(".more").click(), [...document.querySelectorAll(".sbfmenu button")].find((b) => b.textContent === "Open").click(), true)`);
  const leftByMenu = await fresh(`!document.querySelector(".tex-page") && !!${W}`, 30000);
  check(rows && leftByMenu && requests.some((u) => u.includes("?nb=" + nbRef)), "A7: a notebook's menu, Open, beside the editor: its page opened by URL", { leftByMenu, nbRef, reqs: requests.slice(0, 5) });
  await open(fu); await until(`!!${rowOf("/uxnb.ipynb")}`, 15000);
  requests.length = 0;
  await mark();
  await ev(`(${rowOf("/uxnb.ipynb")}.click(), true)`);
  // (the notebook's own page, a new document, with its workspace up: the next file is made there)
  const leftByRow = await fresh(`!document.querySelector(".tex-page") && !!${W}`, 30000);
  check(leftByRow && requests.some((u) => u.includes("?nb=" + nbRef)), "A7: a notebook clicked in the files beside the editor: its page opened by URL", { leftByRow, nbRef, reqs: requests.slice(0, 5) });
  await ev(`localStorage.removeItem("sagebrush-files-sidebar"); true`);
  // A2: an unclosed formula ends at a blank line: shown with a note, the rest of the document rendered as text
  const fa2 = await mk("/t/open-math.tex", enc("\\documentclass{article}\n\\begin{document}\n$$x^\n\nAfter words here.\n\n\\section{Later}\nThen $$y=1$$ shown.\n\\end{document}\n"));
  await open(fa2);
  const a2 = await until(`!!document.querySelector(".tex-preview .mathopen") && document.querySelector(".tex-preview").textContent.includes("After words here.")`, 20000);
  check(a2 && await ev(`[...document.querySelectorAll(".tex-preview .katex")].every((k) => !k.textContent.includes("After")) && document.querySelector(".tex-preview h2")?.textContent.includes("Later") && (() => { const d = [...document.querySelectorAll(".tex-preview .dmath")].pop(); return !!d && !!d.querySelector(".katex") && d.textContent.includes("y=1"); })()`), "A2: $$ not closed: a note, the text after the blank line not math, the section and a later display after it rendered", await ev(`(document.querySelector(".tex-preview") ?? document.body).textContent.slice(0, 300)`));

  // ---- source and preview in sync (A3): a double-click in the preview puts the cursor on that word in the source;
  // Follow (on by default) scrolls the preview to the cursor's place; Show flashes it; after an edit above, the
  // double-click still lands on the right word
  const SYNC = "\\documentclass{article}\n\\begin{document}\n" + Array.from({ length: 120 }, (_, k) => "Para " + k + " word" + k + "x text.").join("\n\n") + "\n\\end{document}\n";
  const fsync = await mk("/t/sync.tex", enc(SYNC));
  await ev(`localStorage.removeItem("sagebrush-latex-follow"); true`);
  await open(fsync);
  await until(`document.querySelector(".tex-preview").textContent.includes("word119x")`, 30000);
  const dbl = (word) => ev(`(() => {
    const P = document.querySelector(".tex-preview"), p = [...P.querySelectorAll(".p")].find((x) => x.textContent.includes(${JSON.stringify(word)}));
    if (!p) return "no paragraph";
    const tw = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode()) && !n.data.includes(${JSON.stringify(word)})) {}
    if (!n) return "no text node";
    const i = n.data.indexOf(${JSON.stringify(word)}), r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${word.length});
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    p.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const s = document.querySelector(".tex-src");
    return { a: s.selectionStart, b: s.selectionEnd, focused: document.activeElement === s, top: s.scrollTop };
  })()`);
  const inv = await dbl("word77x");
  check(inv && inv.a === SYNC.indexOf("word77x") && inv.b === inv.a + 7 && inv.focused && inv.top > 0, "A3: a double-click on a word in the preview selects it in the source, scrolled into view", { inv, want: SYNC.indexOf("word77x") });
  const fwd = (word) => ev(`(() => {
    const s = document.querySelector(".tex-src"), i = s.value.indexOf(${JSON.stringify(word)});
    s.focus(); s.setSelectionRange(i, i); s.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", bubbles: true }));
    const R = document.querySelector(".tex-right").getBoundingClientRect(), p = [...document.querySelectorAll(".tex-preview .p")].find((x) => x.textContent.includes(${JSON.stringify(word)}));
    const r = p.getBoundingClientRect();
    return { visible: r.bottom > R.top && r.top < R.bottom, scroll: document.querySelector(".tex-right").scrollTop };
  })()`);
  const sf1 = await fwd("word3x"), sf2 = await fwd("word110x");
  check(await ev(`document.querySelector('[aria-label="The preview follows the cursor"]').getAttribute("aria-pressed") === "true"`) && sf1.visible && sf2.visible && sf2.scroll > sf1.scroll, "A3: Follow (on by default): moving the cursor brings its place in the preview into view", { sf1, sf2 });
  const flash = await ev(`(() => { document.querySelector('[aria-label="Show the cursor\\'s place in the preview"]').click(); return !!document.querySelector(".tex-preview .ch.sync-flash"); })()`);
  check(flash, "A3: Show: the cursor's place in the preview flashed");
  await ev(`(document.querySelector('[aria-label="The preview follows the cursor"]').click(), true)`);
  // (the last follow's smooth scroll settled first: under load it can still be moving when Follow is turned off)
  for (let i = 0, last = -1; i < 50; i++) { const t = await ev(`document.querySelector(".tex-right").scrollTop`); if (t === last) break; last = t; await sleep(200); }
  const off0 = await ev(`document.querySelector(".tex-right").scrollTop`), off1 = await fwd("word2x");
  check(off1.scroll === off0, "A3: Follow off: moving the cursor leaves the preview where it is", { off0, off1 });
  check(await ev(`localStorage.getItem("sagebrush-latex-follow") === "0"`), "A3: Follow off is remembered");
  await ev(`localStorage.removeItem("sagebrush-latex-follow"); true`);
  const SYNC2 = SYNC.replace("Para 0 ", "New first paragraph here.\n\nPara 0 ");
  await typeInto(SYNC2);
  await until(`document.querySelector(".tex-preview").textContent.includes("New first paragraph")`, 30000);
  await sleep(300);
  const inv2 = await dbl("word77x");
  check(inv2 && inv2.a === SYNC2.indexOf("word77x"), "A3: after an edit above, a double-click still lands on the word (positions follow the edit)", { inv2, want: SYNC2.indexOf("word77x") });
  // the position index (ux2 r2 #5): finding the cursor's group probes the sorted index by binary search, not every
  // group (Show here: Follow is off in this page since the check above)
  const sv = await ev(`(() => {
    const s = document.querySelector(".tex-src"), i = s.value.indexOf("word60x"); s.focus(); s.setSelectionRange(i, i);
    document.querySelector('[aria-label="Show the cursor\\'s place in the preview"]').click();
    return { hit: !!document.querySelector(".tex-preview .ch.sync-flash")?.textContent.includes("word60x"), visits: Number(document.querySelector(".tex-preview").dataset.syncVisits), nG: document.querySelectorAll(".tex-preview .ch").length };
  })()`);
  check(sv.hit && sv.nG > 100 && sv.visits > 0 && sv.visits <= Math.ceil(Math.log2(sv.nG)) + 2, "A3: Show finds the cursor's group in at most log2(groups)+2 probes", sv);

  // a reply held (ux2 r2 #1, the test build's hook): while the preview is of an older text, no sync either way (a
  // double-click, Follow, Show), with a note for the asked ones; the reply installed, the Follow put off is done
  const holdHook = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    window.__holdReplies = false; window.__replyHolds = [];
    window.__sbTexReplyHold = () => { if (window.__holdReplies) return new Promise((r) => window.__replyHolds.push(r)); };
  })()` });
  const fs3 = await mk("/t/sync3.tex", enc(SYNC));
  await open(fs3);
  await until(`document.querySelector(".tex-preview").textContent.includes("word119x")`, 30000);
  const SYNC3 = SYNC.replace("Para 0 ", "Held first paragraph here.\n\nPara 0 ");
  await ev(`window.__holdReplies = true`);
  await typeInto(SYNC3);
  const heldR = await until(`window.__replyHolds.length === 1`, 20000);
  await ev(`(() => { const s = document.querySelector(".tex-src"); s.setSelectionRange(0, 0); return true; })()`);
  const stDbl = await dbl("word77x"), stSay = await ev(`document.querySelector(".tex-status")?.textContent ?? ""`);
  check(heldR && stDbl && stDbl.a === 0 && stDbl.b === 0 && /behind the source/.test(stSay), "A3: a reply held: a double-click in the stale preview leaves the source cursor, with a note", { stDbl, stSay });
  const st0 = await ev(`document.querySelector(".tex-right").scrollTop`), stF = await fwd("word110x");
  check(stF.scroll === st0 && !stF.visible, "A3: a reply held: Follow leaves the stale preview where it is", { st0, stF });
  const stShow = await ev(`(() => { document.querySelector('[aria-label="Show the cursor\\'s place in the preview"]').click(); return { flash: !!document.querySelector(".tex-preview .ch.sync-flash"), say: document.querySelector(".tex-status")?.textContent ?? "" }; })()`);
  check(!stShow.flash && /behind the source/.test(stShow.say), "A3: a reply held: Show doesn't flash a stale place, with a note", stShow);
  await ev(`(() => { window.__holdReplies = false; for (const r of window.__replyHolds.splice(0)) r(); return true; })()`);
  const caught = await until(`document.querySelector(".tex-preview").textContent.includes("Held first paragraph") && (() => { const R = document.querySelector(".tex-right").getBoundingClientRect(), p = [...document.querySelectorAll(".tex-preview .p")].find((x) => x.textContent.includes("word110x")); const r = p?.getBoundingClientRect(); return !!r && r.bottom > R.top && r.top < R.bottom; })()`, 20000);
  check(caught, "A3: the held reply installed: the Follow put off is done (the cursor's place in view)");
  const inv3 = await dbl("word77x");
  check(inv3 && inv3.a === SYNC3.indexOf("word77x"), "A3: the held reply installed: a double-click lands on the word in the new text", { inv3, want: SYNC3.indexOf("word77x") });
  // (DB2-UX2-R2-1) freshness is the revision, not the text: Follow and Show, installed, never read the source's value
  const noRead = await ev(`(() => {
    const s = document.querySelector(".tex-src"), i = s.value.indexOf("word20x"), j = s.value.indexOf("word90x");
    const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value"); let reads = 0;
    Object.defineProperty(s, "value", { configurable: true, get() { reads++; return d.get.call(this); }, set(v) { d.set.call(this, v); } });
    try {
      s.focus(); s.setSelectionRange(i, i); s.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true }));
      const R = document.querySelector(".tex-right").getBoundingClientRect(), r = [...document.querySelectorAll(".tex-preview .p")].find((x) => x.textContent.includes("word20x")).getBoundingClientRect();
      s.setSelectionRange(j, j);
      document.querySelector('[aria-label="Show the cursor\\'s place in the preview"]').click();
      return { reads, followed: r.bottom > R.top && r.top < R.bottom, shown: !!document.querySelector(".tex-preview .ch.sync-flash")?.textContent.includes("word90x") };
    } finally { delete s.value; }
  })()`);
  check(noRead.reads === 0 && noRead.followed && noRead.shown, "A3: Follow and Show check freshness by revision, without reading the source text", noRead);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: holdHook.identifier });

  // duplicate positions kept (ux2 r2 #5): a heading and the paragraph after it on one line begin at the same offset;
  // the cursor there shows the later group (the paragraph), as before the index
  const fdup = await mk("/t/dup.tex", enc("\\documentclass{article}\n\\begin{document}\nIntro.\n\n\\section{Dup} After dup words.\n\nLast para.\n\\end{document}\n"));
  await open(fdup);
  await until(`document.querySelector(".tex-preview").textContent.includes("Last para.")`, 20000);
  const dupShow = await ev(`(() => {
    const s = document.querySelector(".tex-src"); s.focus(); s.setSelectionRange(s.value.indexOf("After dup"), s.value.indexOf("After dup"));
    document.querySelector('[aria-label="Show the cursor\\'s place in the preview"]').click();
    const f = document.querySelector(".tex-preview .ch.sync-flash");
    return { text: f?.textContent ?? null, h2: !!f?.querySelector("h2") };
  })()`);
  check(dupShow.text?.includes("After dup words") && !dupShow.h2, "A3: two groups from one line: both kept in the index, the later one shown", dupShow);

  // half-typed: "\begin{" in the middle of a document (William, Oct 29): a note there, and the rest still renders
  const fh = await mk("/t/half-begin.tex", enc("\\documentclass{article}\n\\begin{document}\nBefore.\n\\begin{\n\nAfter words.\n\n\\section{Later}\nEnd text.\n\\end{document}\n"));
  await open(fh);
  const hb = await until(`!!document.querySelector(".tex-preview .errchip") && document.querySelector(".tex-preview").textContent.includes("End text.")`, 20000);
  check(hb && await ev(`document.querySelector(".tex-preview .errchip").textContent.includes("not finished") && document.querySelector(".tex-preview h2")?.textContent.includes("Later")`), "a half-typed \\begin{: a note, and the document after it still renders", await ev(`(document.querySelector(".tex-preview") ?? document.body).textContent.slice(0, 300)`));

  // ---- Print / Save as PDF (William, Nov 2): the button prints the rendered preview alone; the agent's route
  {
    const fp = await mk("/t/print.tex", enc("\\documentclass{article}\n\\begin{document}\n\\section{Printed}\nA formula $$\\int_0^1 x^2\\,dx = \\frac13$$ in it.\n\\end{document}\n"));
    await open(fp);
    await until(`document.querySelector(".tex-preview")?.textContent.includes("Printed") && !!document.querySelector(".tex-preview .katex")`, 20000);
    // (the File menu runs its item's action on the next microtask: the stub kept until it has)
    const b = await ev(`(async () => { const b = document.querySelector('.tex-filemenu [data-item="print"]'); if (!b) return null;
      window.__printed = []; const real = window.print; window.print = () => window.__printed.push(document.documentElement.classList.contains("tex-print"));
      b.click(); await new Promise((r) => setTimeout(r, 50)); window.print = real; return { label: b.textContent, printed: window.__printed, after: document.documentElement.classList.contains("tex-print") }; })()`);
    await sleep(50);
    const after = await ev(`document.documentElement.classList.contains("tex-print")`);
    check(b && b.label === "Print or save as PDF…" && JSON.stringify(b.printed) === "[true]" && !after, "File > Print or save as PDF… (the one File menu's, U0): the browser's print dialog, in the print layout, and the page is itself again after", { b, after });
    check(await ev(`typeof window.sagebrush?.latex?.print === "function" && typeof window.sagebrush.latex.printMode === "function"`), "…and the agent's route: window.sagebrush.latex.print() and printMode()");
    // (the File menu: Escape closes it, and so does a click outside it, in the editor (grader's K28, K29))
    const menuHidden = `document.querySelector(".tex-filemenu").hidden`;
    await ev(`(document.querySelector(".tex-filebtn").click(), 1)`);
    const openedEsc = !(await ev(menuHidden));
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    check(openedEsc && await until(menuHidden, 2000), "U0: the editor's File menu: Escape closes it", { openedEsc });
    await ev(`(document.querySelector(".tex-filebtn").click(), 1)`);
    const openedOut = !(await ev(menuHidden));
    await ev(`(document.querySelector(".tex-src").click(), 1)`);
    check(openedOut && await until(menuHidden, 2000), "U0: the editor's File menu: a click outside it, in the editor, closes it", { openedOut });
    // (its Recent: the documents opened before, not the one open here (grader's K21; only notebooks and boards are
    // recorded, fileopen.ts, so the open .tex is never among them))
    const recent = await ev(`(async () => { document.querySelector(".tex-filebtn").click(); await new Promise((r) => setTimeout(r, 50));
      document.querySelector('.tex-filemenu button[data-group="recent"]').click(); await new Promise((r) => setTimeout(r, 1500));
      const shown = [...document.querySelectorAll('.tex-filemenu [data-recent]')].map((b) => b.dataset.recent);
      return { shown }; })()`);
    check(recent.shown.length > 0 && !recent.shown.includes("/t/print.tex"), "U0: the editor's File ▸ Recent lists the documents opened before, not the open one", recent);
    // (in print, the File menu hidden even while open (grader's K31))
    const openPrint = !(await ev(menuHidden));
    await ev(`(window.sagebrush.latex.printMode(true), 1)`);
    await send("Emulation.setEmulatedMedia", { media: "print" });
    const menuPrinted = await ev(`getComputedStyle(document.querySelector(".tex-filemenu")).display`);
    await send("Emulation.setEmulatedMedia", { media: "" });
    check(openPrint && menuPrinted === "none", "…in print, the File menu hidden, even open", { openPrint, menuPrinted });
    await ev(`(window.sagebrush.latex.printMode(false), document.querySelector(".tex-filebtn").click(), 1)`);
    await ev(`(window.sagebrush.latex.printMode(true), 1)`);
    await send("Emulation.setEmulatedMedia", { media: "print" });
    const shown = await ev(`(() => { const d = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).display : "absent"; };
      return { head: d(".tex-head"), banner: d(".tex-banner"), left: d(".tex-left"), preview: d(".tex-preview"), sidebar: d("#wssidebar"), page: getComputedStyle(document.querySelector(".tex-page")).position, katex: d(".tex-preview .katex") }; })()`);
    check(shown.head === "none" && shown.banner === "none" && shown.left === "none" && shown.preview !== "none" && (shown.sidebar === "none" || shown.sidebar === "absent") && shown.page === "static" && shown.katex !== "none",
      "…in print, only the rendered preview: no header, banner, source or file browser; its math there", shown);
    const pdf = await send("Page.printToPDF", { printBackground: false });
    const bytes = Buffer.from(pdf?.data ?? "", "base64");
    check(bytes.subarray(0, 5).toString() === "%PDF-" && bytes.length > 2000, "…and a browser an agent drives prints it to a PDF (Page.printToPDF): " + bytes.length + " bytes");
    await send("Emulation.setEmulatedMedia", { media: "" });
    await ev(`(window.sagebrush.latex.printMode(false), 1)`);
    check(!(await ev(`document.documentElement.classList.contains("tex-print")`)) && (await ev(`getComputedStyle(document.querySelector(".tex-head")).display`)) !== "none", "…printMode(false): the page as it was");
  }
  // ---- \neq and the other \not relations (William, Nov 2: the slash below and left of the "="; the preview's .rlap rule,
  // for LaTeX's \rlap, also styled the .rlap KaTeX builds \not from): each slash across its relation, in an article and
  // a slide; and LaTeX's own \rlap and \llap on their line, starting (ending) where they are
  for (const [name, cls] of [["neq-article", "article"], ["neq-beamer", "beamer"]]) {
    const body = "For every $n \\neq 0$, $a \\not\\in B$, $x \\notin S$, $A \\not\\subset B$, $a \\not= b$.\n\nAAA\\rlap{XY}lap and ri\\llap{ZW}ght.\n";
    const src = cls === "beamer" ? "\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{Not}\n" + body + "\\end{frame}\n\\end{document}\n" : "\\documentclass{article}\n\\begin{document}\n" + body + "\\end{document}\n";
    const fn = await mk("/t/" + name + ".tex", enc(src));
    await open(fn);
    await until(`document.querySelectorAll(".tex-preview .katex").length >= 5 && !!document.querySelector(".tex-preview .tex-llap")`, 20000);
    const g = await ev(`(() => {
      const r = (e) => e.getBoundingClientRect(), cy = (b) => (b.top + b.bottom) / 2, cx = (b) => (b.left + b.right) / 2;
      // (KaTeX's \\not: the slash in an .rlap before its relation; \\notin: a "/" in an .llap after the \\in; the relation is
      // the nearest glyph on that side in the same .katex-base)
      const slashes = [...document.querySelectorAll(".tex-preview .katex :is(.rlap, .llap) > .katex-inner")].map((inner) => {
        const right = inner.parentElement.classList.contains("rlap"), vbox = inner.closest(".katex-vbox");
        const rels = [...vbox.closest(".katex-base").querySelectorAll(".mrel")].filter((m) => !m.firstElementChild && m.textContent.trim() && !vbox.contains(m));
        const rel = right ? rels.find((m) => vbox.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) : rels.findLast((m) => vbox.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_PRECEDING);
        if (!rel) return { rel: null };
        const s = r(inner.firstElementChild ?? inner), e = r(rel);
        // (the share of the slash's height inside the relation's: at least half, William's DEV report, Nov 3)
        const over = Math.max(0, Math.min(s.bottom, e.bottom) - Math.max(s.top, e.top)) / Math.max(1e-6, s.bottom - s.top);
        return { rel: rel.textContent, dy: +(cy(s) - cy(e)).toFixed(1), dx: +(cx(s) - cx(e)).toFixed(1), h: +(e.bottom - e.top).toFixed(1), w: +(e.right - e.left).toFixed(1), over: +over.toFixed(2) };
      });
      // (a lap's text against the paragraph text beside it: the same line box, by the bottom of their glyph boxes)
      const textBeside = (o, after) => { const n = after ? o.nextSibling : o.previousSibling, g = document.createRange(); g.setStart(n, after ? 0 : n.length - 2); g.setEnd(n, after ? 2 : n.length); return g.getBoundingClientRect(); };
      const lap = (c) => { const o = document.querySelector(".tex-preview ." + c), i = o?.firstElementChild; if (!o || !i) return null; const a = r(o), b = r(i), t = textBeside(o, c === "tex-rlap"), gl = document.createRange(); gl.selectNodeContents(i); const gb = gl.getBoundingClientRect();
        return { start: +(b.left - a.left).toFixed(1), end: +(b.right - a.left).toFixed(1), dBottom: +(gb.bottom - t.bottom).toFixed(1), w: +(b.right - b.left).toFixed(1) }; };
      return { slashes, rlap: lap("tex-rlap"), llap: lap("tex-llap") };
    })()`);
    check(g.slashes.length >= 5 && g.slashes.every((s) => s.rel && s.over >= 0.5 && Math.abs(s.dy) <= s.h * 0.25 && Math.abs(s.dx) <= s.w * 0.5),
      `${name}: every \\not slash across its relation (=, \\in, \\subset), not below it: at least half its height inside the relation's`, g.slashes);
    check(g.rlap && g.llap && Math.abs(g.rlap.start) <= 1 && g.rlap.w > 5 && Math.abs(g.rlap.dBottom) <= 2 && Math.abs(g.llap.end) <= 1 && g.llap.w > 5 && Math.abs(g.llap.dBottom) <= 2,
      `${name}: \\rlap starts where it is, \\llap ends where it is, both on their line`, { rlap: g.rlap, llap: g.llap });
  }
  // ---- an environment closed as it is opened (William's L2, P1a): the "}" of \begin{X} typed puts \end{X} on the next
  // line at its indentation, the caret left after the "}" (X's arguments can follow; Enter opens the body); one edit,
  // and one undo takes back only the close; not in a comment, a verbatim environment, before other text, as a second
  // close, nor for the host's setText
  {
    const D0 = "\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n", at0 = "\\documentclass{article}\n\\begin{document}\n".length;
    await open(await mk("/t/autoclose.tex", enc(D0)));
    await until(`!!document.querySelector(".tex-src")`, 20000);
    const st = () => ev(`(() => { const s = document.querySelector(".tex-src"); return { v: s.value, a: s.selectionStart, b: s.selectionEnd, edits: performance.getEntriesByName("tex-input").length }; })()`);
    const setAt = (text, off) => ev(`(() => { const s = document.querySelector(".tex-src"); s.value = ${JSON.stringify(text)}; s.dispatchEvent(new Event("input")); s.focus(); s.setSelectionRange(${off}, ${off}); return true; })()`);
    const typed = async (t) => { await send("Input.insertText", { text: t }); };
    const keyChar = async (c) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: c, text: c, unmodifiedText: c }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: c }); };
    const enter = async () => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); };
    // (typed: tabular, its arguments after, then Enter)
    await setAt(D0, at0); await typed("  \\begin{tabular");
    const s0 = await st(); await keyChar("}"); const s1 = await st();
    const c1 = at0 + "  \\begin{tabular}".length;
    check(s1.v === D0.slice(0, at0) + "  \\begin{tabular}\n  \\end{tabular}" + D0.slice(at0) && s1.a === c1 && s1.b === c1 && s1.edits === s0.edits + 1,
      "P1a: the } of \\begin{tabular} puts \\end{tabular} on the next line, at its indentation; the caret after the }; one edit", { edits: [s0.edits, s1.edits], s1 });
    await typed("{cc}"); await enter(); const s2 = await st();
    check(s2.v === D0.slice(0, at0) + "  \\begin{tabular}{cc}\n\n  \\end{tabular}" + D0.slice(at0) && s2.a === c1 + "{cc}\n".length,
      "P1a: its arguments typed after the } stay on the opening line; Enter opens the body between", s2);
    // (one undo: the close only; the person's \begin{itemize} kept)
    await setAt(D0, at0); await typed("\\begin{itemize"); await keyChar("}");
    const u0 = await st(); await ev(`document.execCommand("undo"), 1`); const u1 = await st();
    check(u0.v.includes("\\begin{itemize}\n\\end{itemize}") && u1.v === D0.slice(0, at0) + "\\begin{itemize}" + D0.slice(at0), "P1a: one undo takes back only the inserted \\end{itemize}", { u0: u0.v, u1: u1.v });
    // (starred, nested at a deeper indentation)
    const NEST = D0.slice(0, at0) + "\\begin{itemize}\n    \n\\end{itemize}" + D0.slice(at0), atN = NEST.indexOf("    \n") + 4;
    await setAt(NEST, atN); await typed("\\begin{align*"); await keyChar("}"); const sn = await st();
    check(sn.v.includes("\\begin{itemize}\n    \\begin{align*}\n    \\end{align*}\n\\end{itemize}") && sn.a === atN + "\\begin{align*}".length, "P1a: a starred name, nested: \\end{align*} at the inner indentation", sn.v);
    // (no close: a comment, a verbatim environment, text after the caret, an existing close, an escaped \\begin)
    const none = async (text, off, prefix, what) => {
      await setAt(text, off); await typed(prefix); const b = await st(); await keyChar("}"); const a = await st();
      check(a.v === b.v.slice(0, b.a) + "}" + b.v.slice(b.a) && a.edits === b.edits + 1, "P1a: no close " + what, { before: b.v, after: a.v });
    };
    await none(D0, at0, "% \\begin{itemize", "in a comment");
    const VERB = D0.slice(0, at0) + "\\begin{verbatim}\n\n\\end{verbatim}" + D0.slice(at0);
    await none(VERB, VERB.indexOf("\n\n\\end{verbatim}") + 1, "\\begin{itemize", "inside a verbatim environment");
    const MID = D0.slice(0, at0) + "x  y" + D0.slice(at0);
    await none(MID, at0 + 1, " \\begin{itemize", "before other text on the line");
    const HAS = D0.slice(0, at0) + "\n\\end{itemize}" + D0.slice(at0);
    await none(HAS, at0, "\\begin{itemize", "when its \\end{itemize} is already next");
    await none(D0, at0, "a\\\\begin{itemize", "after \\\\ (a line break, not \\begin)");
    // (daybreak3 DB3-P1A-1: a "}" typed over a selection, completing \begin{itemize}: replaced as typed, no close)
    {
      const SEL = D0.slice(0, at0) + "\\begin{itemizeQ" + D0.slice(at0), q = at0 + "\\begin{itemize".length;
      await setAt(SEL, q); await ev(`(() => { document.querySelector(".tex-src").setSelectionRange(${q}, ${q + 1}); return true; })()`);
      const b = await st(); await keyChar("}"); const a = await st();
      check(a.v === D0.slice(0, at0) + "\\begin{itemize}" + D0.slice(at0) && a.edits === b.edits + 1, "P1a: no close for a } typed over a selection", { before: b.v, after: a.v });
    }
    // (DB3-P1A-3: names as LaTeX takes them: digits and punctuation)
    for (const nm of ["foo2", "foo-bar", "foo:bar"]) {
      await setAt(D0, at0); await typed("\\begin{" + nm); await keyChar("}");
      check((await st()).v === D0.slice(0, at0) + "\\begin{" + nm + "}\n\\end{" + nm + "}" + D0.slice(at0), "P1a: \\begin{" + nm + "} closed too");
    }
    // (DB3-P1A-2: a commented or escaped \begin{verbatim} earlier is text: a later environment still closes)
    for (const [what, pre] of [["commented", "% \\begin{verbatim}\n"], ["escaped", "\\\\begin{verbatim}\n"], ["commented after \\\\ (a line break)", "a\\\\% \\begin{verbatim}\n"]]) {
      const T = D0.slice(0, at0) + pre + D0.slice(at0), o = at0 + pre.length;
      await setAt(T, o); await typed("\\begin{x"); await keyChar("}");
      check((await st()).v === T.slice(0, o) + "\\begin{x}\n\\end{x}" + T.slice(o), "P1a: after a " + what + " \\begin{verbatim}, \\begin{x} still closes");
    }
    // (the host's setText, a paste-like programmatic value: nothing added)
    const PROG = D0.slice(0, at0) + "\\begin{itemize}" + D0.slice(at0);
    await setAt(PROG, at0 + "\\begin{itemize}".length);
    check((await st()).v === PROG, "P1a: a programmatic change of the text (setText) closes nothing");
    // (grader #583 E8: a name with a space is no environment's: no close)
    await none(D0, at0, "\\begin{a b", "for \\begin{a b} (a space in the name)");
    // (E10: a % inside verbatim is text, so its \end{verbatim} still ends it: a later \begin{x} closes)
    {
      const T = D0.slice(0, at0) + "\\begin{verbatim}\n% \\end{verbatim}\n" + D0.slice(at0), o = at0 + "\\begin{verbatim}\n% \\end{verbatim}\n".length;
      await setAt(T, o); await typed("\\begin{x"); await keyChar("}");
      check((await st()).v === T.slice(0, o) + "\\begin{x}\n\\end{x}" + T.slice(o), "P1a: after \\begin{verbatim}, a % line and \\end{verbatim}, \\begin{x} still closes");
    }
    // (G5: a "}" pasted, not typed: no close)
    {
      const T = D0.slice(0, at0) + "\\begin{itemize" + D0.slice(at0), o = at0 + "\\begin{itemize".length;
      await setAt(T, o);
      await ev(`(() => { const s = document.querySelector(".tex-src"); s.setRangeText("}", ${o}, ${o}, "end"); s.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", data: "}", bubbles: true })); return true; })()`);
      await sleep(100);
      check((await st()).v === D0.slice(0, at0) + "\\begin{itemize}" + D0.slice(at0), "P1a: a pasted } closes nothing");
    }
    // (G6: the whole \begin{itemize} inserted at once, not its "}" typed: no close)
    await setAt(D0, at0); await typed("\\begin{itemize}"); await sleep(100);
    check((await st()).v === D0.slice(0, at0) + "\\begin{itemize}" + D0.slice(at0), "P1a: \\begin{itemize} inserted whole (not its } typed) closes nothing");
  }
  // ---- the name at the top (William's M0): it follows a rename elsewhere (the file panel's, the workspace's rename);
  // a click on it renames the file (a true rename), its results file beside it moved along; Escape keeps the name; a
  // name taken is said, nothing renamed
  {
    const T = `document.querySelector(".tex-head .tex-title")`;
    await open(await mk("/m0/paper.tex", enc("\\documentclass{article}\n\\begin{document}\nM0 text.\n\\end{document}\n")));
    await until(`${T}?.textContent === "paper.tex"`, 20000);
    await ev(`${W}.rename("/m0/paper.tex", "/m0/moved.tex").then(() => 1)`);
    const followed = await until(`${T}.textContent === "moved.tex" && document.title.startsWith("moved.tex")`, 5000);
    check(followed, "M0: the name at the top follows a rename elsewhere (the file panel's)", await ev(`[${T}.textContent, document.title]`));
    await mk("/m0/moved.tex.results.json", enc("{}"));
    await mk("/m0/taken.tex", enc("x"));
    // (the status cleared first: a rename is done, its results and comments files moved along, only once it says
    //  "Renamed…"; the name at the top follows the .tex as soon as it moves, before them (grader, #658's red))
    const retitle = async (typed, key = "Enter") => {
      await ev(`(document.querySelector(".tex-status").textContent = "", ${T}.click(), 1)`);
      const opened = await until(`!!document.querySelector(".tex-head .tex-titlein")`, 3000);
      if (!opened) return false;
      await ev(`(() => { const i = document.querySelector(".tex-head .tex-titlein"); i.value = ${JSON.stringify(typed)}; i.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true })); return true; })()`);
      return opened;
    };
    const stat = (p) => ev(`${W}.stat(${JSON.stringify(p)}).then((e) => !!e && !e.trashed)`);
    // (Escape: nothing renamed)
    const escOpened = await retitle("other", "Escape");
    await sleep(500);
    check(escOpened && (await stat("/m0/moved.tex")) && !(await stat("/m0/other.tex")) && (await ev(`${T}.textContent`)) === "moved.tex", "M0: a click on the name edits it; Escape keeps it");
    // (a name taken: said, nothing renamed)
    await retitle("taken");
    const saidTaken = await statusIs(/already a "taken\.tex" here/, 5000);
    check(saidTaken && (await stat("/m0/moved.tex")) && (await ev(`${T}.textContent`)) === "moved.tex", "M0: a name already taken: said, nothing renamed", await ev(`document.querySelector(".tex-status")?.textContent`));
    // (renamed: the .tex and its results file, the extension added when typed without it)
    await retitle("final");
    const renamed = await until(`${T}.textContent === "final.tex" && /^Renamed/.test(document.querySelector(".tex-status").textContent)`, 5000);
    const files = { tex: await stat("/m0/final.tex"), old: await stat("/m0/moved.tex"), results: await stat("/m0/final.tex.results.json"), oldResults: await stat("/m0/moved.tex.results.json") };
    check(renamed && files.tex && !files.old && files.results && !files.oldResults && (await ev(`document.title`)).startsWith("final.tex"), "M0: a name typed and Enter: the file renamed (.tex added), its results file moved along", files);
    // (astra LATEX-RENAME-1: the old name, freed by the rename, reused at once by another document that makes its own
    //  comments or results file there: never taken along; only the files found before the rename move)
    const reuse = (made) => ev(`(window.__reuse = 0, window.__sbTexRenamed = async (from) => { window.__reuse++; await ${W}.create(from, { content: new TextEncoder().encode("other") });
      for (const x of ${JSON.stringify(made)}) await ${W}.create(from + x, { content: new TextEncoder().encode("OTHER") }); }, 1)`);
    const read = (p) => ev(`${W}.stat(${JSON.stringify(p)}).then((e) => e && !e.trashed ? ${W}.read(${JSON.stringify(p)}).then((r) => new TextDecoder().decode(r.content)) : null)`);
    await reuse([".comments.json"]);
    await retitle("again");
    await until(`${T}.textContent === "again.tex" && /^Renamed/.test(document.querySelector(".tex-status").textContent)`, 5000);
    const r1 = { hook: await ev(`window.__reuse`), ourResults: await read("/m0/again.tex.results.json"), otherComments: await read("/m0/final.tex.comments.json"), takenComments: await read("/m0/again.tex.comments.json") };
    check(r1.hook === 1 && r1.ourResults === "{}" && r1.otherComments === "OTHER" && r1.takenComments === null, "M0: another document's comments file made at the freed name stays; only this file's results move", r1);
    await ev(`${W}.remove("/m0/again.tex.results.json").then(() => 1)`);
    await reuse([".results.json"]);
    await retitle("last");
    await until(`${T}.textContent === "last.tex" && /^Renamed/.test(document.querySelector(".tex-status").textContent)`, 5000);
    const r2 = { hook: await ev(`window.__reuse`), otherResults: await read("/m0/again.tex.results.json"), takenResults: await read("/m0/last.tex.results.json") };
    check(r2.hook === 1 && r2.otherResults === "OTHER" && r2.takenResults === null, "M0: another document's results file made at the freed name stays where it is", r2);
    await ev(`(window.__sbTexRenamed = undefined, 1)`);
    // (daybreak3 M0-SEM-1: renamed elsewhere while the field is open, then Escape: the name it has now is shown)
    await ev(`(${T}.click(), 1)`);
    const open1 = await until(`!!document.querySelector(".tex-head .tex-titlein")`, 3000);
    await ev(`${W}.rename("/m0/last.tex", "/m0/elsewhere.tex").then(() => 1)`);
    await sleep(300);
    if (open1) await ev(`(document.querySelector(".tex-head .tex-titlein").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
    const caught = await until(`${T}?.textContent === "elsewhere.tex" && document.title.startsWith("elsewhere.tex")`, 5000);
    check(open1 && caught, "M0: renamed elsewhere while the name is being edited, then Escape: the new name shown", await ev(`[${T}?.textContent, document.title]`));
    // (grader N5: the results file found before the rename, replaced by another one at its path while the .tex is
    //  renamed: the new one is not this file's, so it stays where it is, said)
    await mk("/m0/elsewhere.tex.results.json", enc("ours"));
    await ev(`(window.__sbTexRenamed = async (from) => { await ${W}.remove(from + ".results.json"); await ${W}.create(from + ".results.json", { content: new TextEncoder().encode("REPLACED") }); }, 1)`);
    await retitle("n5");
    const n5renamed = await until(`${T}.textContent === "n5.tex"`, 5000);
    const n5said = await statusIs(/^Renamed; 1 file beside it kept its old name$/, 5000);
    const n5 = { stayed: await read("/m0/elsewhere.tex.results.json"), taken: await read("/m0/n5.tex.results.json") };
    await ev(`(window.__sbTexRenamed = undefined, 1)`);
    check(n5renamed && n5said && n5.stayed === "REPLACED" && n5.taken === null, "M0: a results file replaced at the old path during the rename stays where it is, said", { n5renamed, n5said, n5, status: await ev(`document.querySelector(".tex-status")?.textContent`) });
  }
  // (daybreak3 M0-SEM-2, grader REQUIRED 1: a file that can't be saved here, opened as text (mixed line endings, save.ts):
  //  its name is plain text, no rename offered)
  {
    const T = `document.querySelector(".tex-head .tex-title")`;
    await open(await mk("/m0/mixed.tex", [97, 13, 10, 98, 10, 99, 10]));
    const asText = await until(`${T}?.textContent === "mixed.tex" && !!document.querySelector(".tex-src")`, 20000);
    const plain = await ev(`(() => { const t = ${T}; return { role: t.getAttribute("role"), tab: t.tabIndex, tip: t.title, cls: t.className }; })()`);
    await ev(`(${T}.click(), 1)`); await sleep(400);
    const noField = await ev(`!document.querySelector(".tex-head .tex-titlein")`);
    check(asText && plain.role === null && plain.tab === -1 && !/rename/i.test(plain.tip) && !/renamable/.test(plain.cls) && noField, "M0: a file that can't be saved here, opened as text: no rename offered (no button role, no tab stop, no click to rename)", { asText, plain, noField });
  }
  // ---- Run (#561, William: "I really hope sagetex exists tomorrow"): the SageTeX code run in Sage, in page order, in the
  // runner, on the person's click only; its results written beside the .tex and shown. In the toolbar, right after the
  // preview toggle (and after File ▾, where the page has it); never on open; a Run made stale by opening another file
  // in place writes nothing; without the runner (?runner=0 on loopback), it says why and runs nothing.
  {
    const RUN_DOC = "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n\\begin{sagesilent}\nvar('t')\nx = 2^10\n\\end{sagesilent}\nWe have $x = \\sage{x}$ and $\\int_0^1 t^2\\,dt = \\sage{integrate(t^2, t, 0, 1)}$.\n\\begin{sagesilent}\nx = 7\n\\end{sagesilent}\nNow $x = \\sage{x}$.\n\\end{document}\n";
    const resultsOf = (p) => ev(`${W}.stat(${JSON.stringify(p + ".results.json")}).then((e) => e && !e.trashed ? ${W}.read(${JSON.stringify(p + ".results.json")}).then((r) => new TextDecoder().decode(r.content)) : null)`);
    // (sim run 8, RD03: a new document with no SageTeX code, the code then typed into it: Run must appear once the
    // preview shows the items, without a save or a reopen. It didn't: the reply's own render ran before the editor
    // kept that reply's check, so Run's listener read the check of the text before the edit)
    {
      const fb = await mk("/t/run-typed.tex", enc("\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n"));
      await open(fb);
      await until(`document.querySelector(".tex-preview")?.textContent !== undefined && !!document.querySelector(".tex-head .tex-run")`, 20000);
      await sleep(1000);
      const hiddenBefore = await ev(`document.querySelector(".tex-head .tex-run").hidden`);
      await typeInto("\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\nTwo is $\\sage{1+1}$.\n\\end{document}\n");
      const shownItem = await until(`(document.querySelector(".tex-preview")?.textContent ?? "").includes("Two is")`, 20000);
      const visible = await until(`document.querySelector(".tex-head .tex-run")?.hidden === false`, 10000);
      check(hiddenBefore === true && shownItem && visible, "Run: a new document's SageTeX code typed in: Run appears once the preview shows it (no save, no reopen)", { hiddenBefore, shownItem, visible });
    }
    const fr = await mk("/t/run.tex", enc(RUN_DOC));
    const n0 = requests.length;
    await open(fr);
    await until(`!!document.querySelector(".tex-preview .sagechip") && !document.querySelector(".tex-head .tex-run")?.hidden`, 20000);
    const bar = await ev(`(() => { const h = [...document.querySelector(".tex-head").children]; const i = (c) => h.findIndex((e) => e.classList.contains(c));
      const run = i("tex-run"); return { run, toggle: i("tex-toggle"), file: i("tex-filebtn"), label: h[run]?.textContent ?? null, hidden: h[run]?.hidden ?? null }; })()`);
    check(bar.run >= 0 && bar.label === "Run" && bar.hidden === false && bar.run === bar.toggle + 1 && (bar.file < 0 || bar.file < bar.run),
      "Run: in the toolbar, right after the preview toggle (after File ▾ where there is one), shown for a document with SageTeX code", bar);
    // (never on open: no runner frame, no worker script for it, no results file, after the preview has rendered)
    await sleep(1500);
    const onOpen = { runner: requests.slice(n0).filter((u) => /\/runner\/|sagebrush-worker\.js/.test(u)), frames: await ev(`document.querySelectorAll("iframe[sandbox]").length`), results: await resultsOf("/t/run.tex"), chips: await ev(`document.querySelectorAll(".tex-preview .sagechip").length`) };
    check(onOpen.runner.length === 0 && onOpen.frames === 0 && onOpen.results === null && onOpen.chips >= 2, "Run: nothing runs on open (no runner, no worker, no results file; the items show as not run)", onOpen);
    // (Run's code is a chunk of its own, /sagebrush-latex-run.js (daybreak2, #551's group cap): not fetched by the editor's
    //  load or by any document opened so far, Run shown or not; the first Run fetches it once, later Runs not again)
    const runChunk = () => byId.filter((x) => /\/sagebrush-latex-run\.js(\?|$)/.test(x.url));
    const runBefore = runChunk().length;
    check(runBefore === 0, "Run's chunk: not fetched by the editor's load, nor by opening documents with SageTeX code", runChunk());
    // (its load fails (grader's #824 R1-R3): the first request for it refused (the Fetch domain): Run says so and runs
    //  nothing; pressed again, it loads by a URL of its own (?try=: the browser keeps a failed module import for its
    //  URL), so a failure is never kept)
    let runRefused = 0;
    onPaused = (p) => { if (!runRefused++) send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionFailed" }); else send("Fetch.continueRequest", { requestId: p.requestId }); };
    await send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-latex-run.js*" }] });
    await ev(`(document.querySelector(".tex-status").textContent = "", document.querySelector(".tex-head .tex-run").click(), 1)`);
    const refusedSaid = await statusIs(/^Not run: Run's code couldn't be loaded; press Run again$/, 15000);
    const refusedRun = { refused: runRefused, said: refusedSaid, label: await ev(`document.querySelector(".tex-head .tex-run").textContent`), results: await resultsOf("/t/run.tex"), fetched: runChunk().map((x) => [x.url.replace(/^.*\//, ""), x.status]) };
    check(refusedRun.refused === 1 && refusedRun.said && refusedRun.label === "Run" && refusedRun.results === null && runChunk().length === 1 && !runChunk()[0].status, "Run's chunk: its load refused: Run says so, and nothing runs (no results file)", refusedRun);
    // (the click: its labels as they change, then the results)
    const labels = await ev(`new Promise((res) => { const b = document.querySelector(".tex-head .tex-run"), seen = [b.textContent];
      const o = new MutationObserver(() => { if (seen[seen.length - 1] !== b.textContent) seen.push(b.textContent); if (b.textContent === "Run" && seen.length > 1) { o.disconnect(); res(seen); } });
      o.observe(b, { childList: true, characterData: true, subtree: true }); b.click(); setTimeout(() => { o.disconnect(); res(seen); }, 180000); })`);
    check(JSON.stringify(labels) === JSON.stringify(["Run", "Starting Sage…", "Running…", "Run"]), "Run: its labels, Run → Starting Sage… → Running… → Run", labels);
    const ran = await statusIs(/Ran 5 SageTeX items in [0-9.]+ s$/, 30000);
    const firstRun = runChunk();
    await send("Fetch.disable"); onPaused = null;
    const timing = await ev(`JSON.stringify(performance.getEntriesByType("resource").filter((e) => e.name.includes("sagebrush-latex-run.js")).map((e) => ({ ms: Math.round(e.duration), bytes: e.transferSize, body: e.decodedBodySize })))`);
    check(firstRun.length === 2 && /\?try=\d+$/.test(firstRun[1].url) && firstRun[1].status === 200 && firstRun[1].bytes > 0, "Run's chunk: pressed again after the refused load, it loads by a URL of its own (?try=), once", firstRun);
    console.log("timing, reported, not gated: Run's chunk on the first Run (loopback):", timing, "CDP encoded bytes:", firstRun[1]?.bytes);
    await until(`document.querySelector(".tex-preview").textContent.includes("1024") && document.querySelectorAll(".tex-preview .sagechip").length === 0`, 20000);
    const shownRun = await ev(`(() => { const t = document.querySelector(".tex-preview").textContent; return { has1024: t.includes("1024"), has7: /x\\s*=\\s*\\{?7/.test(t) || t.includes("= {7}") || t.includes("=7"), frac: !!document.querySelector(".tex-preview .katex .mfrac"), chips: document.querySelectorAll(".tex-preview .sagechip").length, status: document.querySelector(".tex-status")?.textContent }; })()`);
    check(ran && shownRun.has1024 && shownRun.has7 && shownRun.frac && shownRun.chips === 0, "Run: the preview shows x = 1024, 1/3, and x = 7 (redefined later, page order), no item left not run", shownRun);
    const rj = JSON.parse((await resultsOf("/t/run.tex")) ?? "null");
    check(rj && rj.format === "sagebrush-latex-results" && rj.version === 1 && rj.items.length === 5 && rj.items.every((x) => x.s === "ok") && rj.items[1].latex === "1024" && rj.items[2].latex === "\\frac{1}{3}" && rj.items[4].latex === "7",
      "Run: the results file beside the .tex (results v1, every item ok: 1024, \\frac{1}{3}, 7)", rj && { n: rj.items.length, items: rj.items.map((x) => [x.s, x.latex]) });
    // (a second Run on the same page: the chunk already fetched is used, not fetched again)
    await ev(`(document.querySelector(".tex-status").textContent = "", document.querySelector(".tex-head .tex-run").click(), 1)`);
    const ranAgain = await statusIs(/Ran 5 SageTeX items in [0-9.]+ s$/, 60000);
    check(ranAgain && runChunk().length === 2, "Run's chunk: a second Run on the page uses the one fetched, not fetched again", { ranAgain, fetched: runChunk().length });
    // (grader's #824 R5: Run pressed twice while its code loads: once loaded, one Run, not two: a second would make the
    //  first stale, and the first, ending, would show the button as "Run" (and take a press as a new Run, not Stop)
    //  while the second still runs. So: the button back to "Run" once, at the end; one results write; one "Ran")
    {
      const two = await ev(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms)), ws = window.__sbTexWs, realW = ws.write, writes = [];
        ws.write = function (p, ...a) { writes.push(String(p)); return realW.call(this, p, ...a); };
        let release; const held = new Promise((r) => { release = r; }); window.__sbTexRunLoaded = () => held;
        let started = 0; const prevHold = window.__sbTexRunHold; window.__sbTexRunHold = () => { started++; };
        const b = document.querySelector(".tex-head .tex-run"), st = document.querySelector(".tex-status"), said = [], labels = [];
        const ob = new MutationObserver(() => { if (labels[labels.length - 1] !== b.textContent) labels.push(b.textContent); });
        ob.observe(b, { childList: true, characterData: true, subtree: true });
        const o = new MutationObserver(() => { const t = st.textContent; if (/^Ran \\d+ SageTeX item/.test(t) && said[said.length - 1] !== t) said.push(t); });
        o.observe(st, { childList: true, characterData: true, subtree: true });
        st.textContent = ""; b.click(); await wait(100); b.click(); await wait(300);
        window.__sbTexRunLoaded = undefined; release();
        for (let i = 0; i < 600 && !said.length; i++) await wait(100);
        await wait(4000); o.disconnect(); ob.disconnect(); ws.write = realW; window.__sbTexRunHold = prevHold;
        return { started, labels, said: said.length, results: writes.filter((p) => p === "/t/run.tex.results.json").length, label: b.textContent };
      })()`);
      check(two.started === 1 && two.said === 1 && two.results === 1 && two.label === "Run" && two.labels.filter((l) => l === "Run").length === 1 && two.labels[two.labels.length - 1] === "Run", "Run's chunk: Run pressed twice while its code loads: one Run (the button back to Run once, at its end; one results write, one \"Ran\")", two);
    }
    // (daybreak3, #824: the page replaced while Run's code loads: once it has loaded, that Run never starts: not one
    //  workspace call for the old document or its folder, and its results file as it was)
    {
      const fo = await mk("/u/other.tex", enc("\\documentclass{article}\n\\begin{document}\nOther page.\n\\end{document}\n"));
      const before = await resultsOf("/t/run.tex");
      const lz = await ev(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms)), ws = window.__sbTexWs, calls = [];
        let release; window.__sbTexRunLoaded = () => new Promise((r) => { release = r; });
        document.querySelector(".tex-head .tex-run").click();
        for (let i = 0; i < 50 && !release; i++) await wait(100);
        const held = !!release;
        window.__sbTexRunLoaded = undefined;
        window.__sbTex({ path: "/u/other.tex", fid: ${JSON.stringify(fo)} });
        for (let i = 0; i < 100 && !document.querySelector(".tex-preview")?.textContent.includes("Other page."); i++) await wait(100);
        const shown = !!document.querySelector(".tex-preview")?.textContent.includes("Other page.");
        const orig = {};
        for (const m of ["list", "readUpTo", "read", "stat", "pathOfFile", "write", "createByPerson"]) { orig[m] = ws[m]; ws[m] = function (a, ...r) { calls.push([m, String(a)]); return orig[m].call(this, a, ...r); }; }
        release?.(); await wait(3000);
        for (const m of Object.keys(orig)) ws[m] = orig[m];
        const old = calls.filter(([m, a]) => a.startsWith("/t/") || a === "/t" || a === ${JSON.stringify(fr)});
        return { held, shown, old, n: calls.length, starting: document.querySelector(".tex-head .tex-run")?.textContent ?? null };
      })()`);
      check(lz.held && lz.shown && lz.old.length === 0 && (await resultsOf("/t/run.tex")) === before, "Run's chunk: the page replaced while it loads: that Run never starts (no call for the old document or its folder, its results as they were)", lz);
    }
    // (William, Nov 3: L0 "latex-beamer + sagetex ... didn't work", L1 "\title{$\sage{factor(2026)}$} doesn't work"):
    // a beamer deck of his shape, clicked Run: every item ok in the results file, the title page's result (an item in
    // \title, shown where \titlepage prints it), the plot and the curve's point in the preview and in Present
    {
      const BEAMER_RUN = String.raw`\documentclass{beamer}
\usepackage{sagetex}
\title{2026 = $\sage{factor(2026)}$}
\begin{document}
\frame{\titlepage}
\begin{frame}{Computed}
\begin{sagesilent}
f(x) = x^3 - 2*x
\end{sagesilent}
$f'(x) = \sage{diff(f(x), x)}$

\sageplot[width=0.5\textwidth]{plot(f(x), (x, -2, 2))}
\end{frame}
\begin{frame}{Curve}
\begin{sageblock}
E = EllipticCurve('389a')
g = E.gens()
\end{sageblock}
$P = \sage{g[0]}$
\end{frame}
\end{document}
`;
      const fbr = await mk("/t/run-beamer.tex", enc(BEAMER_RUN));
      await open(fbr);
      await until(`document.querySelectorAll(".tex-preview section.slide").length === 3 && !document.querySelector(".tex-head .tex-run")?.hidden`, 20000);
      await ev(`(document.querySelector(".tex-head .tex-run").click(), 1)`);
      const ranB = await statusIs(/Ran 6 SageTeX items in [0-9.]+ s$/, 120000);
      const S = `[...document.querySelectorAll(".tex-preview section.slide")]`;
      const shownB = await until(`(() => { const s = ${S}; return s.length === 3 && s[0].textContent.includes("1013") && !!s[1].querySelector("img.sageplot") && /\\(0\\s*:\\s*[-\\u2212]1\\s*:\\s*1\\)/.test(s[2].textContent) && !document.querySelector(".tex-preview .sagechip"); })()`, 20000);
      const bj = JSON.parse((await resultsOf("/t/run-beamer.tex")) ?? "null");
      check(ranB && shownB && bj?.items?.length === 6 && bj.items.every((x) => x.s === "ok"),
        "Run, beamer (William's L0/L1): every item ok, the \\title item on the title page, the plot and the point in the slides",
        { ranB, shownB, status: await ev(`document.querySelector(".tex-status")?.textContent ?? ""`), items: bj?.items?.map((x) => x.s), slides: await ev(`${S}.map((s) => s.textContent.replace(/\\s+/g, " ").slice(0, 80))`) });
      const P = `document.querySelector(".tex-present")`;
      const pkey = async (k, code, vk) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code }); };
      await ev(`(document.querySelector(".tex-present-btn").click(), 1)`);
      const p1 = await until(`!!${P} && ${P}.dataset.frame === "1" && ${P}.querySelector(".tp-stage").textContent.includes("1013") && ${P}.textContent.includes("1 / 3")`, 15000);
      await pkey("ArrowRight", "ArrowRight", 39);
      const p2 = await until(`${P}.dataset.frame === "2" && !!${P}.querySelector(".tp-stage img.sageplot")`, 5000);
      await pkey("ArrowRight", "ArrowRight", 39);
      const p3 = await until(`${P}.dataset.frame === "3" && /\\(0\\s*:\\s*[-\\u2212]1\\s*:\\s*1\\)/.test(${P}.querySelector(".tp-stage").textContent)`, 5000);
      await pkey("Escape", "Escape", 27);
      await until(`!${P}`, 5000);
      check(p1 && p2 && p3, "Run, beamer: Present shows the title page's result, the plot and the point", { p1, p2, p3 });
      // ---- printed as beamer makes its PDF (plan PR 2, gap G5): a page for each frame, the class's paper (128 x 96 mm for
      // 4:3), no slide split, each frame's title on it (the site's print rule hides every <header>; the slide's isn't)
      await ev(`(window.sagebrush.latex.printMode(true), 1)`);
      await send("Emulation.setEmulatedMedia", { media: "print" });
      const paper = await ev(`document.getElementById("sb-tex-slide-page")?.textContent ?? ""`);
      const titles = await ev(`[...document.querySelectorAll(".tex-preview .ch:not([hidden]) section.slide header.slide-title")].map((h) => getComputedStyle(h).display !== "none" && h.getBoundingClientRect().height > 0 ? h.textContent : null)`);
      const pdfB = await send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
      await send("Emulation.setEmulatedMedia", { media: "" });
      await ev(`(window.sagebrush.latex.printMode(false), 1)`);
      const pb = Buffer.from(pdfB?.data ?? "", "base64").toString("latin1");
      const boxes = [...pb.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => [+m[1], +m[2]]);
      const mm = (pt) => (pt * 25.4) / 72;
      const gone = await ev(`!document.getElementById("sb-tex-slide-page")`);
      check(pb.startsWith("%PDF-") && boxes.length === 3 && boxes.every(([w, h]) => Math.abs(mm(w) - 128) < 0.5 && Math.abs(mm(h) - 96) < 0.5) && paper === "@page { size: 128mm 96mm; margin: 0; }" && JSON.stringify(titles) === JSON.stringify(["Computed", "Curve"]) && gone,
        "Print, beamer: one 128 x 96 mm page for each of the 3 frames, the frames' titles shown; the page size gone after", { boxes: boxes.map(([w, h]) => [mm(w).toFixed(1), mm(h).toFixed(1)]), paper, titles, gone });
      // (grader's #888 Q2/Q3: the Print button's own path, printPreview(): the slide page set while the browser's print
      //  runs (window.print stubbed), and gone once it is over (afterprint))
      const viaButton = await ev(`(() => { const real = window.print; let during = null; window.print = () => { during = document.getElementById("sb-tex-slide-page")?.textContent ?? null; };
        try { window.sagebrush.latex.print(); } finally { window.print = real; }
        window.dispatchEvent(new Event("afterprint"));
        return { during, after: !!document.getElementById("sb-tex-slide-page"), cls: document.documentElement.classList.contains("tex-print") }; })()`);
      await sleep(100);
      check(viaButton.during === "@page { size: 128mm 96mm; margin: 0; }" && !viaButton.after && !viaButton.cls && !(await ev(`!!document.getElementById("sb-tex-slide-page")`)),
        "Print, beamer, by the Print button (printPreview): the slide page while it prints, gone after", viaButton);
      // ---- the code changed since the Run: its values kept, marked stale (@sagebrush's Q3 ruling, Nov 8: never "…");
      // Shift+Enter in the source runs (William, Nov 3), no newline; in Present it runs and the slide stays, updated
      // (frame 2 by its number, in the chunks shown: the page's own rule, slidesNow; a hidden chunk's copy never counts)
      const S2 = `document.querySelector('.tex-preview .ch:not([hidden]) section.slide[data-frame="2"]')`, srcNow = () => ev(`document.querySelector(".tex-src").value`);
      const deriv = (c) => `${S2}.textContent.includes(${JSON.stringify("3 \\, x^{2} - " + c)})`;
      const edit = async (from, to) => { const t = await srcNow(); await typeInto(t.replace(from, to)); return t.replace(from, to); };
      await edit("f(x) = x^3 - 2*x", "f(x) = x^3 - 3*x");
      const kept = await until(`!!${S2}.querySelector(".sagestale") && ${deriv(2)} && !!${S2}.querySelector("img.sageplot.sagestale") && !${S2}.querySelector(".sagechip") && getComputedStyle(${S2}.querySelector(".sagestale")).opacity === "0.5"`, 10000);
      const saidStale = await statusIs(/^(1 SageTeX item out of date: Shift\+Enter runs it again|\d+ SageTeX items out of date: Shift\+Enter runs them again)$/, 5000);
      check(kept && saidStale, "stale: after an edit, the slide keeps its last values and plot, marked stale (faded; no \"…\", no chip); the status says so",
        { kept, status: await ev(`document.querySelector(".tex-status")?.textContent ?? ""`), slide: await ev(`${S2}.innerHTML.slice(0, 300)`) });
      // (a second edit, as many items stale: each edit empties the status, and it is said again (daybreak3, #874))
      const said1 = await ev(`document.querySelector(".tex-status")?.textContent ?? ""`);
      await edit("f(x) = x^3 - 3*x", "f(x) = x^3 - 3*x ");
      const said2 = await until(`document.querySelector(".tex-src").value.includes("3*x \\n") && document.querySelector(".tex-status")?.textContent === ${JSON.stringify(said1)}`, 5000);
      check(said2, "stale: a second edit, as many items stale, still says so", { said1, now: await ev(`document.querySelector(".tex-status")?.textContent ?? ""`) });
      await edit("f(x) = x^3 - 3*x ", "f(x) = x^3 - 3*x");
      await statusIs(/out of date/, 5000);
      const before = await srcNow(), at = before.indexOf("3*x") + 3;
      await ev(`(() => { const t = document.querySelector(".tex-src"); t.focus(); t.setSelectionRange(${at}, ${at}); document.querySelector(".tex-status").textContent = ""; return true; })()`);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8, text: "\r" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
      const ranKey = await statusIs(/^Ran 6 SageTeX items in [0-9.]+ s$/, 120000);
      const fresh2 = await until(`${deriv(3)} && !${S2}.querySelector(".sagestale")`, 10000);
      check(ranKey && fresh2 && (await srcNow()) === before, "Shift+Enter in the source runs the code (no newline): the new values, nothing stale",
        { ranKey, fresh2, status: await ev(`document.querySelector(".tex-status")?.textContent ?? ""`), added: (await srcNow()).length - before.length });
      await edit("f(x) = x^3 - 3*x", "f(x) = x^3 - 4*x");
      await until(`!!${S2}.querySelector(".sagestale")`, 10000);
      // (an edit after a Run, as many values stale as the edit before it: said again (daybreak3, #874))
      const saidAgain = await statusIs(/^(1 SageTeX item out of date: Shift\+Enter runs it again|\d+ SageTeX items out of date: Shift\+Enter runs them again)$/, 5000);
      check(saidAgain, "stale: an edit after a Run says so again, as many values stale as before it", { status: await ev(`document.querySelector(".tex-status")?.textContent ?? ""`) });
      await ev(`(document.querySelector(".tex-status").textContent = "", document.querySelector(".tex-present-btn").click(), 1)`);
      await until(`!!${P}`, 15000);
      await pkey("Home", "Home", 36);
      await until(`${P}.dataset.frame === "1"`, 5000);
      await pkey("ArrowRight", "ArrowRight", 39);
      const on2 = await until(`${P}.dataset.frame === "2" && !!${P}.querySelector(".tp-stage .sagestale")`, 5000);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8, text: "\r" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
      const ranP = await statusIs(/^Ran 6 SageTeX items in [0-9.]+ s$/, 120000);
      const upd = await until(`${P}.dataset.frame === "2" && ${P}.querySelector(".tp-stage").textContent.includes(${JSON.stringify("3 \\, x^{2} - 4")}) && !${P}.querySelector(".tp-stage .sagestale")`, 10000);
      const stayed = await ev(`${P}?.dataset.frame`);
      await pkey("Escape", "Escape", 27);
      await until(`!${P}`, 5000);
      check(on2 && ranP && upd && stayed === "2", "Present: Shift+Enter runs the code; the slide stays (2), its values updated, nothing stale",
        { on2, ranP, upd, stayed, status: await ev(`document.querySelector(".tex-status")?.textContent ?? ""`) });
      // (a document with no SageTeX code: Shift+Enter is a newline, as before)
      await open(await mk("/t/no-sage.tex", enc("\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n")));
      await until(`document.querySelector(".tex-preview")?.textContent.includes("Hi") && document.querySelector(".tex-head .tex-run")?.hidden`, 20000);
      const plain = await srcNow(), pat = plain.indexOf("Hi") + 2;
      await ev(`(() => { const t = document.querySelector(".tex-src"); t.focus(); t.setSelectionRange(${pat}, ${pat}); return true; })()`);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8, text: "\r" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
      const nl = await until(`document.querySelector(".tex-src").value === ${JSON.stringify(plain.slice(0, pat) + "\n" + plain.slice(pat))}`, 5000);
      check(nl, "Shift+Enter in a document with no SageTeX code is a newline", { src: JSON.stringify(await srcNow()) });
      // (the preview behind the text (daybreak3, #874): the text changed and Shift+Enter pressed in one task, before the
      //  worker's render; the text decides, not the last render's button. The first item added: it runs, no newline;
      //  the last one removed: no Run, the newline given back where it was asked for)
      await until(`!!document.querySelector(".tex-head .tex-run")?.hidden`, 10000);
      const keyNow = (text, at) => ev(`(() => { const t = document.querySelector(".tex-src"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input")); t.focus(); t.setSelectionRange(${at}, ${at}); document.querySelector(".tex-status").textContent = ""; const e = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }); t.dispatchEvent(e); return { prevented: e.defaultPrevented }; })()`);
      const withSage = plain.replace("Hi\n", "Hi $\\sage{1+1}$\n"), atS = withSage.indexOf("Hi") + 2;
      const k1 = await keyNow(withSage, atS);
      const ranFirst = await statusIs(/^Ran 1 SageTeX item in [0-9.]+ s$/, 120000);
      check(k1.prevented && ranFirst && (await srcNow()) === withSage, "Shift+Enter right after the first SageTeX item is added (the preview behind): it runs, no newline", { k1, ranFirst, status: await ev(`document.querySelector(".tex-status")?.textContent ?? ""`), src: JSON.stringify((await srcNow()).slice(0, 120)) });
      await until(`!document.querySelector(".tex-head .tex-run")?.hidden`, 10000);
      const atP = plain.indexOf("Hi") + 2;
      const k2 = await keyNow(plain, atP);
      // (the caret moved before the render (grader's #874 K9): the newline still where Shift+Enter was pressed)
      await ev(`(document.querySelector(".tex-src").setSelectionRange(0, 0), 1)`);
      const back = await until(`document.querySelector(".tex-src").value === ${JSON.stringify(plain.slice(0, atP) + "\n" + plain.slice(atP))}`, 10000);
      await sleep(500);
      const st2 = await ev(`document.querySelector(".tex-status")?.textContent ?? ""`);
      check(k2.prevented && back && !/^(Ran|Starting|Running)/.test(st2), "Shift+Enter right after the last SageTeX item is removed (the preview behind): no Run, the newline where it was asked for", { k2, back, status: st2, src: JSON.stringify((await srcNow()).slice(0, 120)) });
      // (astra, #874: Shift+Enter on text with no code, the preview behind, then a SageTeX item added before the render:
      //  the key was for the text it was pressed on, so nothing at all: no Run of the later code, no newline)
      await until(`!!document.querySelector(".tex-head .tex-run")?.hidden`, 10000);
      const later = await ev(`(() => { const t = document.querySelector(".tex-src"); t.value = ${JSON.stringify(plain)}; t.dispatchEvent(new Event("input")); t.focus(); t.setSelectionRange(${atP}, ${atP}); document.querySelector(".tex-status").textContent = ""; const e = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }); t.dispatchEvent(e); t.value = ${JSON.stringify(withSage)}; t.dispatchEvent(new Event("input")); return e.defaultPrevented; })()`);
      await until(`!document.querySelector(".tex-head .tex-run")?.hidden`, 10000);
      await sleep(3000);
      const st3 = await ev(`document.querySelector(".tex-status")?.textContent ?? ""`);
      check(later && !/^(Ran|Starting|Running)/.test(st3) && (await srcNow()) === withSage, "Shift+Enter pressed on one text, the text changed before its render: nothing (no Run of the later code, no newline)", { later, status: st3, src: JSON.stringify((await srcNow()).slice(0, 120)) });
    }
    // ---- grader's #874 r4 gap H11: the count said is of the stale items, not of all: three items, the last edited, one
    // stale, said in the singular
    {
      const THREE = "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n$\\sage{1+1}$ $\\sage{2+2}$ $\\sage{3+3}$\n\\end{document}\n";
      await open(await mk("/t/three.tex", enc(THREE)));
      await until(`!document.querySelector(".tex-head .tex-run")?.hidden`, 20000);
      await ev(`(document.querySelector(".tex-head .tex-run").click(), 1)`);
      const ran3 = await statusIs(/^Ran 3 SageTeX items in [0-9.]+ s$/, 120000);
      await ev(`(document.querySelector(".tex-status").textContent = "", 1)`);
      await typeInto(THREE.replace("3+3", "3+4"));
      const one = await statusIs(/^1 SageTeX item out of date: Shift\+Enter runs it again$/, 10000);
      check(ran3 && one, "stale: three items, one changed: the count said is of the stale one (1, singular), not of all three",
        { ran3, status: await ev(`document.querySelector(".tex-status")?.textContent ?? ""`), stale: await ev(`document.querySelectorAll(".tex-preview .sagestale").length`) });
    }
    // ---- grader's #874 r3 gaps: a Run under way (K3, H4), a modified Shift+Enter (K6), another message kept over a
    // re-render (the status rule), Present's Shift+Enter on a text with no code (K8), its digits (P3), its chips (P4)
    {
      const KEYS = "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n$\\sage{1+1}$\n\\begin{sagesilent}\nimport time\ntime.sleep(3)\n\\end{sagesilent}\n\\end{document}\n";
      await open(await mk("/t/keys.tex", enc(KEYS)));
      await until(`!document.querySelector(".tex-head .tex-run")?.hidden`, 20000);
      const st = () => ev(`document.querySelector(".tex-status")?.textContent ?? ""`);
      const src = () => ev(`document.querySelector(".tex-src").value`);
      const shiftEnter = async (mods = 8) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: mods, text: "\r" }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: mods }); };
      await ev(`(document.querySelector(".tex-head .tex-run").click(), 1)`);
      await statusIs(/^Ran 2 SageTeX items in [0-9.]+ s$/, 120000);
      // (K3, H4: a Run under way: an edit makes an item stale, and Shift+Enter is pressed; the Run goes on to its end,
      //  never stopped by the key, and the stale count isn't said while it runs)
      await ev(`(document.querySelector(".tex-status").textContent = "", document.querySelector(".tex-head .tex-run").click(), 1)`);
      const running1 = await until(`/Running|Starting/.test(document.querySelector(".tex-head .tex-run").textContent)`, 20000);
      await typeInto(KEYS.replace("1+1", "1+2"));
      await sleep(600);
      const midStatus = await st();
      const before = await src();
      await ev(`(() => { const t = document.querySelector(".tex-src"); t.focus(); t.setSelectionRange(5, 5); return 1; })()`);
      await shiftEnter();
      await sleep(300);
      const midStatus2 = await st(), kept = (await src()) === before;
      const ended = await statusIs(/^Ran 2 SageTeX items in [0-9.]+ s$/, 60000);
      check(running1 && ended && kept && !/out of date|stopping|stopped/.test(midStatus + midStatus2), "a Run under way: Shift+Enter is consumed and never stops it; no stale count while it runs; it ends with its results",
        { running1, ended, kept, midStatus, midStatus2, status: await st() });
      // (K6: Shift+Enter with Ctrl: not a Run)
      await typeInto(KEYS.replace("1+1", "1+4"));
      await statusIs(/out of date/, 5000);
      await ev(`(document.querySelector(".tex-status").textContent = "", document.querySelector(".tex-src").focus(), 1)`);
      await shiftEnter(2 | 8);
      await sleep(1500);
      const noRun = !/Running|Starting/.test(await ev(`document.querySelector(".tex-head .tex-run").textContent`)) && !/^Ran/.test(await st());
      check(noRun, "Ctrl+Shift+Enter is not a Run", { status: await st(), btn: await ev(`document.querySelector(".tex-head .tex-run").textContent`) });
      // (the status rule: a message that isn't the stale count stays over a render that changes nothing (the results file
      //  read again: written again, the same bytes))
      await ev(`(document.querySelector(".tex-status").textContent = "another message", 1)`);
      await ev(`${W}.stat("/t/keys.tex.results.json").then((e) => ${W}.read("/t/keys.tex.results.json").then((r) => ${W}.write("/t/keys.tex.results.json", r.content, { fid: e.fid, base: e.rev ?? 0 }))).then(() => (window.dispatchEvent(new Event("focus")), 1))`);
      await sleep(2000);
      check((await st()) === "another message", "the stale count is never said over another message (a render that changes nothing)", { status: await st() });
      // (K8, P3, P4: Present)
      const NB = "\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{One}\nA\n\\end{frame}\n\\begin{frame}{Two}\nB\n\\end{frame}\n\\begin{frame}{Three}\nC\n\\end{frame}\n\\end{document}\n";
      await open(await mk("/t/keys-beamer.tex", enc(NB)));
      await until(`!document.querySelector(".tex-present-btn")?.hidden`, 20000);
      const Pk = `document.querySelector(".tex-present")`;
      await ev(`(document.querySelector(".tex-present-btn").click(), 1)`);
      await until(`!!${Pk}`, 15000);
      const edited = NB.replace("A\n", "A changed\n");
      await ev(`(() => { const t = document.querySelector(".tex-src"); t.value = ${JSON.stringify(edited)}; t.dispatchEvent(new Event("input")); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })); return 1; })()`);
      await sleep(1500);
      check((await src()) === edited, "Present: Shift+Enter on a text with no code (the preview behind) never edits the source", { src: JSON.stringify((await src()).slice(0, 120)) });
      const pk = async (k, code, vk) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, ...(k.length === 1 ? { text: k } : {}) }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk }); };
      await pk("Home", "Home", 36);
      await until(`${Pk}.dataset.frame === "1"`, 5000);
      await pk("3", "Digit3", 51);
      await shiftEnter();
      await pk("Enter", "Enter", 13);
      const nextNot3 = await until(`${Pk}.dataset.frame === "2"`, 5000);
      check(nextNot3, "Present: digits typed before Shift+Enter are dropped: Enter after it is the next slide (2), not slide 3", { frame: await ev(`${Pk}.dataset.frame`) });
      await pk("Escape", "Escape", 27);
      await until(`!${Pk}`, 5000);
      const NR = "\\documentclass{beamer}\n\\usepackage{sagetex}\n\\begin{document}\n\\begin{frame}{Not run}\nValue: \\sage{2+2}\n\\end{frame}\n\\end{document}\n";
      await open(await mk("/t/notrun-beamer.tex", enc(NR)));
      await until(`!document.querySelector(".tex-present-btn")?.hidden && !!document.querySelector(".tex-preview .sagechip.s-notrun")`, 20000);
      await ev(`(document.querySelector(".tex-present-btn").click(), 1)`);
      const chipHidden = await until(`!!${Pk} && !!${Pk}.querySelector(".tp-stage .sagechip.s-notrun") && getComputedStyle(${Pk}.querySelector(".tp-stage .sagechip.s-notrun")).display === "none"`, 15000);
      await pk("Escape", "Escape", 27);
      await until(`!${Pk}`, 5000);
      check(chipHidden, "Present: a not-run item's chip is not shown on the slide", null);
      // (Q7: a decimal paper, aspectratio=141: 148.5 x 105 mm; Q8: a document that isn't beamer gets no slide page, the
      //  print layout's own page standing)
      const pageOf = async (tex) => { await open(await mk(tex.path, enc(tex.text))); await until(`!!document.querySelector(".tex-preview .ch:not([hidden]) ${tex.sel}")`, 20000);
        await ev(`(window.sagebrush.latex.printMode(true), 1)`); const p = await ev(`document.getElementById("sb-tex-slide-page")?.textContent ?? null`); await ev(`(window.sagebrush.latex.printMode(false), 1)`); return p; };
      const p141 = await pageOf({ path: "/t/print-141.tex", sel: "section.slide", text: "\\documentclass[aspectratio=141]{beamer}\n\\begin{document}\n\\begin{frame}{A}\nx\n\\end{frame}\n\\end{document}\n" });
      const pArt = await pageOf({ path: "/t/print-article.tex", sel: ".p", text: "\\documentclass{article}\n\\begin{document}\nSome text.\n\\end{document}\n" });
      check(p141 === "@page { size: 148.5mm 105mm; margin: 0; }" && pArt === null, "Print: a beamer deck at aspectratio=141 gets its 148.5 x 105 mm page; an article gets no slide page", { p141, pArt });
      // (#888's dispose note: a page left in its print layout (printMode(true)) and another file opened: the layout and the
      //  slide page put back, not left on the next page)
      await open(await mk("/t/print-left.tex", enc("\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{L}\nx\n\\end{frame}\n\\end{document}\n")));
      await until(`!!document.querySelector(".tex-preview .ch:not([hidden]) section.slide")`, 20000);
      const leftOn = await ev(`(window.sagebrush.latex.printMode(true), !!document.getElementById("sb-tex-slide-page") && document.documentElement.classList.contains("tex-print"))`);
      const fNext = await mk("/t/print-next.tex", enc("\\documentclass{article}\n\\begin{document}\nNext.\n\\end{document}\n"));
      await ev(`(window.__noReload = true, window.__sbTex({ path: "/t/print-next.tex", fid: ${JSON.stringify(fNext)} }), 1)`);
      await until(`document.querySelector(".tex-preview")?.textContent.includes("Next.")`, 20000);
      const leftAfter = await ev(`({ kept: window.__noReload === true, cls: document.documentElement.classList.contains("tex-print"), page: !!document.getElementById("sb-tex-slide-page") })`);
      check(leftOn && leftAfter.kept && !leftAfter.cls && !leftAfter.page, "Print: a page left in its print layout, another file opened: the layout and its slide page put back", { leftOn, ...leftAfter });
    }
    // ---- @interact (a Sagebrush extension, William Nov 8; the Beamer plan's PR 3): a Run keeps an interact with its item,
    // and the preview draws it (the interact chunk, /sagebrush-latex-interact.js, fetched only now: no document before
    // this one had an interact) with its controls at their defaults, not live, what its function printed and showed,
    // and "Interactive in Sagebrush"; so does Present, and the print layout (William's Q2); an edit marks it stale
    {
      const interactFetches = () => requests.filter((u) => /sagebrush-latex-interact\.js/.test(u)).length;
      const before = interactFetches();
      const IA = String.raw`\documentclass{beamer}
\usepackage{sagetex}
\begin{document}
\begin{frame}{A widget}
\begin{sagesilent}
@interact
def h(k=slider(1, 5, 1, 2)):
    print('k^2 =', k^2)
    show(plot(sin(k*x), (x, 0, pi)))
\end{sagesilent}
\end{frame}
\begin{frame}{End}
The end.
\end{frame}
\end{document}
`;
      await open(await mk("/t/interact.tex", enc(IA)));
      await until(`document.querySelectorAll(".tex-preview .ch:not([hidden]) section.slide").length === 2 && !document.querySelector(".tex-head .tex-run")?.hidden`, 20000);
      await ev(`(document.querySelector(".tex-head .tex-run").click(), 1)`);
      const ranI = await statusIs(/^Ran 1 SageTeX item in [0-9.]+ s$/, 120000);
      const W1 = `document.querySelector('.tex-preview .ch:not([hidden]) section.slide .sageinteract')`;
      const IAU = `performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /sagebrush-latex-interact\\.js/.test(n)).pop()`;
      const drawn = await until(`!!${W1} && !!${W1}.querySelector('input[type=range][value="2"]') && ${W1}.querySelector(".si-out")?.textContent === "k^2 = 4\\n" && !!${W1}.querySelector("img.sageplot") && ${W1}.querySelector(".si-note")?.textContent === "Interactive in Sagebrush"`, 20000);
      check(before === 0 && ranI && drawn && interactFetches() === 1, "@interact: a Run keeps it; the preview draws it (its slider at 2, its output, its plot, the note), the interact chunk fetched only now, once",
        { before, ranI, drawn, fetched: interactFetches(), slide: await ev(`(document.querySelector(".tex-preview section.slide")?.innerHTML ?? "").slice(0, 400)`) });
      // (PR 4: live in the preview, the Run's interact in this page's session: its slider moved to 4 runs its function
      //  again, and its output is the new one, printed and plotted)
      const liveNow = await until(`!!${W1} && !${W1}.querySelector("input[type=range]").disabled`, 10000);
      const src0 = await ev(`${W1}.querySelector("img.sageplot")?.src ?? ""`);
      await ev(`(() => { const i = ${W1}.querySelector("input[type=range]"); i.value = "4"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
      const moved = await until(`${W1}.querySelector(".si-out")?.textContent === "k^2 = 16\\n" && !!${W1}.querySelector("img.sageplot") && ${W1}.querySelector("img.sageplot").src !== ${JSON.stringify(src0)} && ${W1}.querySelector(".si-v")?.textContent === "4"`, 20000);
      check(liveNow && moved, "@interact live: after a Run its controls work; the slider moved to 4 runs its function again (k^2 = 16, a new plot)",
        { liveNow, moved, out: await ev(`${W1}?.querySelector(".si-out")?.textContent ?? null`), shown: await ev(`${W1}?.querySelector(".si-v")?.textContent ?? null`) });
      // (a redraw of its block (its frame's title edited) keeps the values and output it has now: 4, k^2 = 16)
      const tx = await ev(`document.querySelector(".tex-src").value`);
      await typeInto(tx.replace("{A widget}", "{A widget!}"));
      const kept4 = await until(`document.querySelector('.tex-preview .ch:not([hidden]) section.slide .slide-title')?.textContent === "A widget!" && ${W1}?.querySelector("input[type=range]")?.value === "4" && ${W1}?.querySelector(".si-out")?.textContent === "k^2 = 16\\n"`, 15000);
      await typeInto(tx);
      await until(`document.querySelector('.tex-preview .ch:not([hidden]) section.slide .slide-title')?.textContent === "A widget"`, 15000);
      check(kept4, "@interact live: its block drawn again (an edit beside it) keeps the values and output it had (4, k^2 = 16)", { value: await ev(`${W1}?.querySelector("input[type=range]")?.value ?? null`), out: await ev(`${W1}?.querySelector(".si-out")?.textContent ?? null`) });
      // (grader's L19: drawn again, it is still live: a change after the redraw runs its function (5, then back to 4))
      const move = (v) => ev(`(() => { const i = ${W1}.querySelector("input[type=range]"); i.value = "${v}"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
      await move(5);
      const after5 = await until(`${W1}?.querySelector(".si-out")?.textContent === "k^2 = 25\\n"`, 20000);
      await move(4);
      const back4 = await until(`${W1}?.querySelector(".si-out")?.textContent === "k^2 = 16\\n" && ${W1}.querySelector(".si-v")?.textContent === "4"`, 20000);
      check(after5 && back4, "@interact live: drawn again, still live: a change after the redraw runs its function (k^2 = 25)", { after5, back4 });
      // (PR 5, grader's #937 L19: the interpreter started again, then a Run whose results are the last one's (its ids
      //  start again and the output is the same, so the preview's HTML is kept as it was, its placeholder the same
      //  element): the widget is live for the new Run, at its defaults (2, k^2 = 4), not left dead)
      const AT = `document.querySelector('.tex-preview .ch:not([hidden]) section.slide .sageinteract-at')`;
      await ev(`(${AT}.__kept = 1, window.__sbTexSession().kernel.restart(), 1)`);
      const deadR = await until(`${W1}?.querySelector("input[type=range]")?.disabled === true`, 20000);
      await ev(`(document.querySelector(".tex-status").textContent = "", document.querySelector(".tex-head .tex-run").click(), 1)`);
      const ranR = await statusIs(/^Ran 1 SageTeX item in [0-9.]+ s$/, 120000);
      const reliveR = await until(`${AT}?.__kept === 1 && !!${W1} && !${W1}.querySelector("input[type=range]").disabled && ${W1}.querySelector("input[type=range]").value === "2" && ${W1}.querySelector(".si-out")?.textContent === "k^2 = 4\\n"`, 20000);
      await move(4);
      const again4 = await until(`${W1}?.querySelector(".si-out")?.textContent === "k^2 = 16\\n"`, 20000);
      check(deadR && ranR && reliveR && again4, "@interact live: the interpreter started again, then a Run with the same results (its HTML kept): the widget live for the new Run, at its defaults; a change runs it",
        { deadR, ranR, reliveR, again4, kept: await ev(`${AT}?.__kept ?? null`), value: await ev(`${W1}?.querySelector("input[type=range]")?.value ?? null`), out: await ev(`${W1}?.querySelector(".si-out")?.textContent ?? null`) });
      const Pi = `document.querySelector(".tex-present")`;
      await ev(`(document.querySelector(".tex-present-btn").click(), 1)`);
      const inPresent = await until(`!!${Pi} && !!${Pi}.querySelector(".tp-stage .sageinteract input[type=range]") && !!${Pi}.querySelector(".tp-stage .sageinteract img.sageplot")`, 15000);
      // (PR 5: live in Present: the slide's copy has the preview's values and output (4, k^2 = 16); a change there runs
      //  the function again and both copies show it; a click on its slider and a key on it are its own, never a slide
      //  change; a key elsewhere still moves the slides, and Escape from the slider still ends the presentation)
      const key = async (k, code, vk) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code }); };
      await key("Home", "Home", 36);
      const SW = `${Pi}?.querySelector(".tp-stage .sageinteract")`, PS = `${SW}?.querySelector("input[type=range]")`;
      const stageLive = await until(`${Pi}.dataset.frame === "1" && !!${PS} && !${PS}.disabled && ${PS}.value === "4" && ${SW}.querySelector(".si-out")?.textContent === "k^2 = 16\\n"`, 10000);
      await ev(`(() => { const i = ${PS}; if (!i) return 0; i.value = "5"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
      const both = await until(`${SW}?.querySelector(".si-out")?.textContent === "k^2 = 25\\n" && ${W1}?.querySelector(".si-out")?.textContent === "k^2 = 25\\n" && ${W1}?.querySelector("input[type=range]")?.value === "5"`, 20000);
      const pr = await ev(`(() => { const b = ${PS}?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 }; return { x: b.left + b.width * 0.97, y: b.top + b.height / 2 }; })()`);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pr.x, y: pr.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pr.x, y: pr.y, button: "left", clickCount: 1 });
      await sleep(300);
      const clickStayed = await ev(`${Pi}?.dataset.frame ?? null`);
      await ev(`(${PS}?.focus(), 1)`);
      await key("ArrowLeft", "ArrowLeft", 37);
      const keyed = await until(`${PS}?.value === "4" && ${SW}?.querySelector(".si-out")?.textContent === "k^2 = 16\\n" && ${W1}?.querySelector(".si-out")?.textContent === "k^2 = 16\\n"`, 20000);
      const keyStayed = await ev(`${Pi}?.dataset.frame ?? null`);
      await ev(`(document.activeElement?.blur?.(), 1)`);
      await key("ArrowRight", "ArrowRight", 39);
      const navStill = await until(`${Pi}?.dataset.frame === "2"`, 5000);
      await key("Home", "Home", 36);
      await until(`${Pi}?.dataset.frame === "1" && !!${PS} && !${PS}.disabled`, 5000);
      await ev(`(${PS}?.focus(), 1)`);
      await key("Escape", "Escape", 27);
      const escaped = await until(`!${Pi}`, 5000);
      check(inPresent && stageLive && both && clickStayed === "1" && keyed && keyStayed === "1" && navStill && escaped,
        "@interact in Present: live on the slide with the preview's values and output; a change runs it and both copies show it; a click and a key on it are its own (no slide change); a key elsewhere still moves the slides; Escape from it still ends", { inPresent, stageLive, both, clickStayed, keyed, keyStayed, navStill, escaped });
      // (daybreak3's #961 race: presenting, the interpreter started again, then a Run (Shift+Enter) whose ids are the
      //  last ones again; the slide shown again after its ids are set and before its results are drawn (the test
      //  build's hold), so its copy is made live first: the Run's widget still drawn afresh, at its defaults (2,
      //  k^2 = 4), live, in the preview and on the slide; not the last Run's 4 from the copy, nor left dead)
      await ev(`(document.querySelector(".tex-present-btn").click(), 1)`);
      await until(`!!${Pi}`, 15000);
      await key("Home", "Home", 36);
      const live4 = await until(`${Pi}?.dataset.frame === "1" && !!${PS} && !${PS}.disabled && ${PS}.value === "4"`, 10000);
      await ev(`(window.__sbTexSession().kernel.restart(), 1)`);
      const deadP = await until(`!!${PS} && ${PS}.disabled && ${W1}?.querySelector("input[type=range]")?.disabled === true`, 20000);
      await ev(`(document.querySelector(".tex-status").textContent = "", window.__sbTexResultsHold = () => new Promise((r) => { window.__rheld = true; window.__rgo = r; }), 1)`);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8, text: "\r" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
      const rHeld = await until(`window.__rheld === true`, 120000);
      await key("End", "End", 35); await until(`${Pi}?.dataset.frame === "2"`, 5000);
      await key("Home", "Home", 36); await until(`${Pi}?.dataset.frame === "1"`, 5000);
      await sleep(300);
      // (daybreak3's #961 r2: the copy shown again before the Run's results are drawn stays dead: a change there sends
      //  nothing, so nothing done in it is lost when the Run's widgets are drawn afresh)
      const sentH0 = await ev(`import(${IAU}).then((m) => m.sent)`);
      const heldDead = await ev(`(() => { const i = ${PS}; if (!i) return null; const dis = i.disabled; i.value = "5"; i.dispatchEvent(new Event("input", { bubbles: true })); return dis; })()`);
      await sleep(300);
      const sentH1 = await ev(`import(${IAU}).then((m) => m.sent)`);
      await ev(`(delete window.__sbTexResultsHold, delete window.__rheld, window.__rgo(), 1)`);
      const ranP = await statusIs(/^Ran 1 SageTeX item in [0-9.]+ s$/, 120000);
      const fresh2 = await until(`(() => { const p = ${W1}?.querySelector("input[type=range]"), s = ${PS}; return !!p && !!s && p.value === "2" && !p.disabled && ${W1}.querySelector(".si-out")?.textContent === "k^2 = 4\\n" && s.value === "2" && !s.disabled && ${SW}.querySelector(".si-out")?.textContent === "k^2 = 4\\n"; })()`, 20000);
      const got2 = await ev(`({ preview: ${W1}?.querySelector("input[type=range]")?.value ?? null, pDis: ${W1}?.querySelector("input[type=range]")?.disabled ?? null, slide: ${PS}?.value ?? null, sDis: ${PS}?.disabled ?? null, out: ${SW}?.querySelector(".si-out")?.textContent ?? null })`);
      await key("Escape", "Escape", 27);
      await until(`!${Pi}`, 5000);
      check(live4 && deadP && rHeld && heldDead === true && sentH1 === sentH0 && ranP && fresh2, "@interact in Present: the interpreter started again, a Run whose ids are the last ones again, the slide shown again before its results are drawn: dead there until they are (a change sends nothing), then drawn afresh at its defaults, live, in the preview and on the slide",
        { live4, deadP, rHeld, heldDead, sentH0, sentH1, ranP, fresh2, got2 });
      await until(`!${Pi}`, 5000);
      await ev(`(window.sagebrush.latex.printMode(true), 1)`);
      await send("Emulation.setEmulatedMedia", { media: "print" });
      const printed = await ev(`(() => { const w = ${W1}; if (!w) return null; const r = w.getBoundingClientRect(); return { shown: getComputedStyle(w).display !== "none" && r.height > 0, note: w.querySelector(".si-note")?.textContent }; })()`);
      await send("Emulation.setEmulatedMedia", { media: "" });
      await ev(`(window.sagebrush.latex.printMode(false), 1)`);
      check(inPresent && printed?.shown && printed.note === "Interactive in Sagebrush", "@interact: Present shows it, and the print layout, with its note", { inPresent, printed });
      // (astra's and daybreak3's #937 r2 notes: a new Run ends the last Run's widgets as it starts, before it takes the
      //  session's turn: a change made while it holds its turn (the test build's hold) sends nothing (the chunk's count),
      //  and the widget is shown dead; once it has run, its own widget is live)
      const sent0 = await ev(`import(${IAU}).then((m) => m.sent)`);
      await ev(`(document.querySelector(".tex-status").textContent = "", window.__sbTexRunHold = () => new Promise((r) => { window.__held = true; window.__go = r; }), document.querySelector(".tex-head .tex-run").click(), 1)`);
      const heldRun = await until(`window.__held === true`, 60000);
      await ev(`(() => { const i = ${W1}.querySelector("input[type=range]"); i.value = "5"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
      await sleep(300);
      const during = await ev(`({ dis: ${W1}.querySelector("input[type=range]").disabled, title: ${W1}.title })`);
      await ev(`(delete window.__sbTexRunHold, delete window.__held, window.__go(), 1)`);
      const ranAgain = await statusIs(/^Ran 1 SageTeX item in [0-9.]+ s$/, 120000);
      const relive = await until(`!!${W1} && !${W1}.querySelector("input[type=range]").disabled`, 15000);
      const sent1 = await ev(`import(${IAU}).then((m) => m.sent)`);
      check(heldRun && during.dis && during.title === "Run the code (Shift+Enter) to use these controls" && ranAgain && relive && sent1 === sent0,
        "@interact live: a new Run ends the last one's widgets as it starts: a change while it holds the session's turn sends nothing, the widget shown dead; its own widget live after", { heldRun, during, ranAgain, relive, sent0, sent1 });
      const t = await ev(`document.querySelector(".tex-src").value`);
      // (its default now 3; and at 5 it takes 5 s, for the leave row below)
      await typeInto(t.replace("slider(1, 5, 1, 2)", "slider(1, 5, 1, 3)").replace("    print('k^2 =', k^2)", "    if k == 5: import time; time.sleep(5)\n    print('k^2 =', k^2)"));
      const stale = await until(`!!document.querySelector('.tex-preview .ch:not([hidden]) .sageinteract.sagestale')`, 10000);
      check(stale, "@interact: its code edited, the interact kept, marked stale", null);
      // (grader's L2: a stale widget isn't live: disabled, saying it changed; moving its slider sends nothing)
      const sentS0 = await ev(`import(${IAU}).then((m) => m.sent)`);
      const WS = `document.querySelector('.tex-preview .ch:not([hidden]) .sageinteract.sagestale')`;
      const st2 = await ev(`(() => { const i = ${WS}.querySelector("input[type=range]"); const dis = i.disabled; i.value = "5"; i.dispatchEvent(new Event("input", { bubbles: true })); return { dis, title: ${WS}.title }; })()`);
      await sleep(300);
      const sentS1 = await ev(`import(${IAU}).then((m) => m.sent)`);
      check(st2.dis && st2.title === "Changed since the last Run: Shift+Enter or Run updates it" && sentS1 === sentS0, "@interact live: a stale widget (its code edited) isn't live: disabled, saying it changed; a change sends nothing", { st2, sentS0, sentS1 });
      // (Shift+Enter while presenting: the Run's interact drawn after the slide was shown, and the slide shown again with it)
      await ev(`(document.querySelector(".tex-status").textContent = "", document.querySelector(".tex-present-btn").click(), 1)`);
      await until(`!!${Pi}`, 15000);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Home", code: "Home", windowsVirtualKeyCode: 36 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Home", code: "Home" });
      await until(`!!${Pi} && !!${Pi}.querySelector(".tp-stage .sageinteract.sagestale")`, 15000);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8, text: "\r" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
      const reran = await statusIs(/^Ran 1 SageTeX item in [0-9.]+ s$/, 120000);
      const fresh3 = await until(`!!${Pi}.querySelector('.tp-stage .sageinteract:not(.sagestale) input[type=range][value="3"]') && ${Pi}.querySelector(".tp-stage .si-out")?.textContent === "k^2 = 9\\n"`, 15000);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
      await until(`!${Pi}`, 5000);
      check(reran && fresh3, "@interact: Shift+Enter while presenting runs it again; the slide shows the new interact (at 3, k^2 = 9), nothing stale", { reran, fresh3 });
      // (astra's LIVE937-1: the page leaves the document for one with no widget at all, then comes back: the Run's widget
      //  isn't live any more (until the next Run), its controls disabled, saying to run the code)
      const fIa = await ev(`${W}.stat("/t/interact.tex").then((e) => e.fid)`), fNo = await mk("/t/no-widget.tex", enc("\\documentclass{article}\n\\begin{document}\nNo widget here.\n\\end{document}\n"));
      // (grader's O12: a change waiting while its request runs (at 5: 5 s) when the page leaves the document is never sent)
      const liveL = await until(`!!${W1} && !${W1}.querySelector("input[type=range]").disabled`, 15000);
      const sentL0 = await ev(`import(${IAU}).then((m) => m.sent)`);
      await move(5);
      const runningL = await until(`import(${IAU}).then((m) => m.sent === ${sentL0} + 1)`, 10000);
      await move(4);
      await ev(`(window.__sbTex({ path: "/t/no-widget.tex", fid: ${JSON.stringify(fNo)} }), 1)`);
      await until(`document.querySelector(".tex-preview")?.textContent.includes("No widget here.")`, 20000);
      const sentLater = await until(`import(${IAU}).then((m) => m.sent > ${sentL0} + 1)`, 8000);
      check(liveL && runningL && !sentLater, "@interact live: the page left the document while a request ran, a change waiting: that change never sent", { liveL, runningL, sentLater, sentL0 });
      await ev(`(window.__sbTex({ path: "/t/interact.tex", fid: ${JSON.stringify(fIa)} }), 1)`);
      const backDead = await until(`document.querySelector(".tex-title")?.textContent === "interact.tex" && (() => { const w = document.querySelector('.tex-preview .ch:not([hidden]) .sageinteract'); return !!w && w.querySelector("input[type=range]").disabled && w.title === "Run the code (Shift+Enter) to use these controls"; })()`, 20000);
      check(backDead, "@interact live: the page left the document (for one with no widget) and came back: not live until the next Run", null);
      // (PR 4: another document in this page and session, whose results (the same file's bytes) have the same ids: not live,
      //  as its ids aren't this session's Run's for it)
      const iaText = await ev(`document.querySelector(".tex-src").value`);
      const fCopy = await mk("/t/interact-copy.tex", enc(iaText));
      await ev(`${W}.read("/t/interact.tex.results.json").then((r) => ${W}.create("/t/interact-copy.tex.results.json", { content: r.content })).then(() => 1)`);
      await ev(`(window.__sbTex({ path: "/t/interact-copy.tex", fid: ${JSON.stringify(fCopy)} }), 1)`);
      const copyNotLive = await until(`document.querySelector(".tex-title")?.textContent === "interact-copy.tex" && (() => { const w = document.querySelector('.tex-preview .ch:not([hidden]) .sageinteract'); return !!w && w.querySelector("input[type=range]").disabled; })()`, 20000);
      check(copyNotLive, "@interact live: another document in the same session, its results with the same ids, is not live", null);
      // (PR 4: the page opened again, a new session: its interacts drawn from the results file, not live, saying to run)
      await open((await ev(`${W}.stat("/t/interact.tex").then((e) => e.fid)`)));
      const notLive = await until(`(() => { const w = document.querySelector('.tex-preview .ch:not([hidden]) .sageinteract'); return !!w && w.querySelector("input[type=range]").disabled && w.title === "Run the code (Shift+Enter) to use these controls"; })()`, 20000);
      check(notLive, "@interact live: in a new page (no Run of its session), drawn but not live, saying to run the code first", null);
      // (grader's #926 I9: a drawn widget is marked, so a later render draws nothing again)
      const again = await ev(`(() => { const u = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /sagebrush-latex-interact\\.js/.test(n)); return import(u).then((m) => m.draw(document.querySelector(".tex-preview"))); })()`);
      check(again === 0, "@interact: drawn once: drawing the preview again draws nothing", { again });
      // (grader's #926 P1: the interact chunk's load refused once (the page opened again, its results file's widget to
      //  draw): the widget waits, and the next render loads the chunk by a URL of its own (?try=) and draws it)
      let iaRefused = 0;
      onPaused = (p) => { if (!iaRefused++) send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionFailed" }); else send("Fetch.continueRequest", { requestId: p.requestId }); };
      await send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-latex-interact.js*" }] });
      await send("Network.setCacheDisabled", { cacheDisabled: true });
      const n0 = requests.length;
      await open(await ev(`new URLSearchParams(location.search).get("tex")`));
      const waits = await until(`!!document.querySelector('.tex-preview .ch:not([hidden]) .sageinteract-at:not([data-drawn])')`, 20000);
      await sleep(1000);
      const notYet = await ev(`!document.querySelector('.tex-preview .ch:not([hidden]) .sageinteract')`);
      const t3 = await ev(`document.querySelector(".tex-src").value`);
      await typeInto(t3 + "%\n");
      const drawnLater = await until(`!!document.querySelector('.tex-preview .ch:not([hidden]) .sageinteract input[type=range][value="3"]')`, 20000);
      await send("Fetch.disable");
      await send("Network.setCacheDisabled", { cacheDisabled: false });
      onPaused = null;
      const iaUrls = requests.slice(n0).filter((u) => /sagebrush-latex-interact\.js/.test(u));
      check(iaRefused >= 2 && waits && notYet && drawnLater && iaUrls.length >= 2 && !/\?try=/.test(iaUrls[0]) && /\?try=\d+$/.test(iaUrls[iaUrls.length - 1]),
        "@interact: the interact chunk's load refused once: the widget waits; the next render loads it by a URL of its own (?try=) and draws it", { iaRefused, waits, notYet, drawnLater, iaUrls });
      // (astra's LIVE937-1/2, daybreak3: what is live belongs to one Run, in its interpreter, in its document, and a request
      //  waits for the session's turn. A session of the test's own (a kernel that keeps each request until told), on
      //  widgets of its own (id 901), with the chunk the page loaded)
      const own = await ev(`(async () => {
        const u = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /sagebrush-latex-interact\\.js/.test(n)).pop();
        const m = await import(u);
        const box = document.createElement("div"); box.className = "tex-page"; document.body.appendChild(box);
        const html = (v) => m.interactsHtml([{ id: 901, name: "f", controls: [{ kind: "slider", name: "k", label: "k", min: 0, max: 9, step: 1, value: v }], out: "", shows: [] }]);
        const calls = [], vals = [], held = [], tick = () => new Promise((r) => setTimeout(r, 0));
        const readyFns = [];
        const k = { generation: 1, targetSink: () => null, on(e, f) { if (e === "ready") readyFns.push(f); }, interact(iid, values, sink) { calls.push(iid + ":" + (values.k ?? values.t)); vals.push(JSON.stringify(values)); held.push(sink); } };
        let gate = null;
        const s = { kernel: k, serial: (fn) => (gate ?? Promise.resolve()).then(fn) };
        const w = () => box.querySelector(".sageinteract"), slider = () => w().querySelector("input[type=range]");
        const change = async (v) => { slider().value = String(v); slider().dispatchEvent(new Event("input", { bubbles: true })); await tick(); await tick(); };
        const runOf = (gen) => Object.assign(new Set([901]), { gen });
        // (a Run's ids, drawn for first as the page draws for them (draw() on the preview), then made live here)
        const lv = (ids) => (m.draw(document.createElement("div"), s, ids), m.live(box, s, ids));
        const r = {};
        // a Run A: live; a change sends its values, and output addressed to it is shown
        box.innerHTML = html(2); const A = runOf(1); lv(A);
        await change(5); r.sentA = calls.join();
        k.targetSink(901)?.out("five\\n"); r.outA = w().querySelector(".si-out")?.textContent ?? null;
        await change(6);
        // a new Run B with the same id while A's request runs: B's widget fresh (its own default, no output of A's); A's
        // output not shown in it; A's dirty follow-up (6) never sent
        box.innerHTML = html(2); const B = runOf(1); lv(B);
        r.freshB = { value: slider().value, out: w().querySelector(".si-out")?.textContent ?? null, sink: k.targetSink(901) === null };
        held.shift().done(); await tick(); await tick(); r.afterA = calls.join();
        // the interpreter started again (a new generation: its interacts gone): B's widget no longer sends, and is shown dead
        await change(3); k.generation = 2; r.sinkRestart = k.targetSink(901) === null; held.shift()?.done(); await tick();
        await change(4);
        r.restart = { sent: calls.join(), dis: slider().disabled, title: w().title, value: slider().value };
        // a Run C, then the document left (its ids marked over) while a request runs with a change waiting: nothing more sent
        k.generation = 2; box.innerHTML = html(2); const C = runOf(2); lv(C);
        await change(7); await change(8); C.over = 1; r.sinkOver = k.targetSink(901) === null; held.shift()?.done(); await tick(); await tick();
        r.left = calls.join();
        // the session's turn: a request waits for it (a Run's folder going in), and is checked again when its turn comes
        let open1; gate = new Promise((res) => (open1 = res));
        box.innerHTML = html(2); const D = runOf(2); lv(D);
        await change(1); r.waiting = calls.join(); open1(); await tick(); await tick(); r.turned = calls.join(); held.shift()?.done(); await tick();
        let open2; gate = new Promise((res) => (open2 = res));
        await change(2); D.over = 1; open2(); await tick(); await tick(); r.overWait = calls.join();
        gate = null;
        // (agents-ui's A1: a text control runs on change (Enter, or leaving it), as the notebook's, not on each key)
        box.innerHTML = m.interactsHtml([{ id: 901, name: "g", controls: [{ kind: "input", name: "t", label: "t", value: "a" }], out: "", shows: [] }]);
        const E = runOf(2); lv(E);
        const tb = box.querySelector("input[type=text]"), n0 = calls.length;
        tb.value = "si"; tb.dispatchEvent(new Event("input", { bubbles: true })); await tick(); await tick();
        r.typed = calls.length - n0;
        tb.value = "sin"; tb.dispatchEvent(new Event("change", { bubbles: true })); await tick(); await tick();
        r.entered = calls.slice(n0).join();
        // (agents-ui's n2: the interpreter started again (its "ready"): every live widget shown dead at once, untouched)
        box.innerHTML = html(2); const F = runOf(2); lv(F);
        r.liveF = !slider().disabled; k.generation = 3; readyFns.forEach((f) => f());
        r.readyDead = { dis: slider().disabled, title: w().title, hooks: readyFns.length };
        // (a widget whose id isn't among its Run's (an older result kept past a stopped Run, say): never live)
        k.generation = 3; box.innerHTML = html(2).replace('data-iid="901"', 'data-iid="902"'); lv(runOf(3));
        r.otherId = { dis: slider().disabled, title: w().title };
        // (grader's #937 r3 rows. What a request prints and shows reaches the page only as text, or as an image whose
        //  data is checked (an SVG that is one, a PNG in base64), never as HTML: L10-L12, L9, L8)
        held.length = 0; k.generation = 4; box.innerHTML = html(2); lv(runOf(4));
        const shown = () => { const o = w().querySelector(".si-outs"); return { text: o.textContent, tags: Array.from(o.querySelectorAll("*")).map((e) => e.tagName.toLowerCase()).join() }; };
        const req = async (v, f) => { await change(v); f(k.targetSink(901), held[held.length - 1]); const x = shown(); held.splice(0).forEach((h) => h.done()); await tick(); await tick(); return x; };
        r.esc = {
          display: await req(3, (t) => t.display({ "text/plain": "<b>x</b>&amp;" })),
          printed: await req(4, (t) => t.out("<img src=x onerror=alert(1)>")),
          stopped: await req(5, (t, h) => h.stopped("ZeroDivisionError: <i>x</i>")),
          png: await req(6, (t) => t.display({ "image/png": 'AAAA" onerror="alert(1)">', "text/plain": "png as text" })),
          pngOk: await req(7, (t) => t.display({ "image/png": "iVBORw0KGgo=", "text/plain": "p" })),
          svg: await req(8, (t) => t.display({ "image/svg+xml": "<b>not an svg</b>", "text/plain": "svg as text" })),
          svgOk: await req(1, (t) => t.display({ "image/svg+xml": '<svg xmlns="http://www.w3.org/2000/svg"></svg>', "text/plain": "s" })),
        };
        // (L7: each request's output replaces the last's)
        await req(2, (t) => t.out("first")); r.latest = await req(3, (t) => t.out("second"));
        // (L6: two changes while a request runs: one request follows it, with the last values, and its output shown)
        const n6 = calls.length;
        await change(3); await change(4); await change(5); r.busy = calls.slice(n6).join();
        held.shift().done(); await tick(); await tick(); r.follow = calls.slice(n6).join();
        k.targetSink(901)?.out("k=5"); r.followOut = shown().text; held.splice(0).forEach((h) => h.done()); await tick(); await tick();
        // (L13: drawn twice (as Present's copy is): a change in one shown in the other, values and output)
        box.innerHTML = html(2) + html(2); lv(runOf(4));
        const sl = Array.from(box.querySelectorAll("input[type=range]"));
        sl[0].value = "7"; sl[0].dispatchEvent(new Event("input", { bubbles: true })); await tick(); await tick();
        k.targetSink(901)?.out("seven");
        r.copies = { value: sl[1].value, shownV: box.querySelectorAll(".si-v")[1]?.textContent, outs: Array.from(box.querySelectorAll(".si-outs")).map((o) => o.textContent).join("|") };
        held.splice(0).forEach((h) => h.done()); await tick(); await tick();
        // (L15, L16, L21, L22: each kind's value as Python's convert() takes it)
        box.innerHTML = m.interactsHtml([{ id: 901, name: "v", controls: [{ kind: "range", name: "r", label: "r", min: 0, max: 10, step: 1, value: [2, 8] },
          { kind: "button", name: "b", label: "b", text: "go" }, { kind: "checkbox", name: "c", label: "c", value: true },
          { kind: "selector", name: "s", label: "s", options: ["a", "b", "c"], value: 0 }], out: "", shows: [] }]);
        lv(runOf(4));
        const vreq = async (f) => { f(); await tick(); await tick(); const v = JSON.parse(vals[vals.length - 1]); held.splice(0).forEach((h) => h.done()); await tick(); await tick(); return v; };
        const lo = box.querySelector("input[type=range]"), btn = box.querySelector("button"), cb = box.querySelector("input[type=checkbox]"), sel = box.querySelector("select");
        r.values = {
          range: (await vreq(() => { lo.value = "9"; lo.dispatchEvent(new Event("input", { bubbles: true })); })).r,
          click1: (await vreq(() => btn.click())).b,
          click2: (await vreq(() => btn.click())).b,
          check: (await vreq(() => cb.click())).c,
          sel: (await vreq(() => { sel.value = "1"; sel.dispatchEvent(new Event("input", { bubbles: true })); })).s,
        };
        // (O6: a Run over (a new one started) or its interpreter started again: a redraw leaves its widgets dead)
        const J = runOf(4); box.innerHTML = html(2); lv(J); const live6 = !slider().disabled;
        J.over = 1; box.innerHTML = html(2); lv(J);
        r.over6 = { live6, dis: slider().disabled, title: w().title };
        const K = runOf(4); box.innerHTML = html(2); lv(K); const liveK = !slider().disabled;
        k.generation = 5; box.innerHTML = html(2); lv(K);
        r.gen6 = { liveK, dis: slider().disabled, title: w().title };
        box.remove();
        return r;
      })()`);
      check(own?.sentA === "901:5" && own.outA === "five\n" && own.freshB?.value === "2" && own.freshB.out === null && own.freshB.sink && own.afterA === "901:5",
        "@interact live: a new Run reusing an id: its widget fresh (no values or output of the old one's); the old request's output and its waiting change dropped", own);
      check(own?.sinkRestart && own?.restart?.sent === "901:5,901:3" && own.restart.value === "3" && own.restart.dis && own.restart.title === "Run the code (Shift+Enter) to use these controls",
        "@interact live: the interpreter started again: output for the request running dropped; a change sends nothing, its control put back (3), and the widget shown dead, saying to run the code", own?.restart);
      check(own?.sinkOver && own?.left === "901:5,901:3,901:7", "@interact live: the document left while a request runs: its output dropped, its waiting change never sent", own);
      check(own?.waiting === "901:5,901:3,901:7" && own.turned === "901:5,901:3,901:7,901:1" && own.overWait === own.turned,
        "@interact live: a request waits for the session's turn (as a Run does), and isn't sent if its Run ended meanwhile", own);
      check(own?.typed === 0 && own.entered === "901:sin", "@interact live: a text control runs its function on change (Enter or leaving it), not on each key", own);
      check(own?.liveF && own.readyDead?.dis && own.readyDead.title === "Run the code (Shift+Enter) to use these controls" && own.readyDead.hooks === 1,
        "@interact live: the interpreter started again (its ready): every live widget shown dead at once, before any touch", own?.readyDead);
      check(own?.otherId?.dis && own.otherId.title === "Run the code (Shift+Enter) to use these controls", "@interact live: a widget whose id isn't one its Run made is never live", own?.otherId);
      const e = own?.esc ?? {};
      check(e.display?.text === "<b>x</b>&amp;" && e.display.tags === "pre" && e.printed?.text === "<img src=x onerror=alert(1)>" && e.printed.tags === "pre" && e.stopped?.text === "ZeroDivisionError: <i>x</i>" && e.stopped.tags === "pre",
        "@interact live: what a request displays as text, prints, or stops with is shown as text, never HTML", e);
      check(e.png?.text === "png as text" && e.png.tags === "pre" && e.pngOk?.tags === "img" && e.svg?.text === "svg as text" && e.svg.tags === "pre" && e.svgOk?.tags === "img",
        "@interact live: a shown image only if its data is one (a PNG in base64, an SVG that is one); else its text", e);
      check(own?.latest?.text === "second", "@interact live: each request's output replaces the last's", own?.latest);
      check(own?.busy === "901:3" && own.follow === "901:3,901:5" && own.followOut === "k=5", "@interact live: changes made while a request runs: one request follows it, with the last values, and its output shown", own);
      check(own?.copies?.value === "7" && own.copies.shownV === "7" && own.copies.outs === "seven|seven", "@interact live: drawn twice, a change in one is shown in the other, values and output", own?.copies);
      const v = own?.values ?? {};
      check(JSON.stringify(v.range) === "[8,9]" && v.click1 === 1 && v.click2 === 2 && v.check === false && v.sel === 1,
        "@interact live: values sent as Python's convert() takes them: a range low to high, a button's clicks, a checkbox's bool, a selector's index", v);
      check(own?.over6?.live6 && own.over6.dis && own.over6.title === "Run the code (Shift+Enter) to use these controls" && own.gen6?.liveK && own.gen6.dis && own.gen6.title === "Run the code (Shift+Enter) to use these controls",
        "@interact live: a Run over (a new one started), or its interpreter started again: a redraw leaves its widgets dead", own);
    }
    // (Codex friction P5, the editor's half: a helper .py beside the .tex, imported by the document's code as by real
    //  SageTeX run in the document's folder. The .tex's folder is given to Sage, read-only, at each Run, as it is then:
    //  #772's example in its own folder gives its values; a second folder's document imports its own helper.py (same
    //  name), not the first's (gone from the session), works in its folder, last on sys.path after the runtime's own
    //  entries, and gets the standard statistics over a statistics.py beside it (imported cold); its code can't make a
    //  file; its helper edited, the next Run sees the edit; deleted, the next Run can't import it. A folder past the
    //  bound: Run says so and runs nothing)
    {
      const exDir = new URL("../../examples/latex/sagetex-helper/", import.meta.url);
      const paper = await mk("/ex-helper/paper.tex", enc(readFileSync(new URL("paper.tex", exDir), "utf8")));
      await mk("/ex-helper/helper.py", enc(readFileSync(new URL("helper.py", exDir), "utf8")));
      await open(paper);
      await until(`!document.querySelector(".tex-head .tex-run")?.hidden`, 20000);
      await ev(`(document.querySelector(".tex-head .tex-run").click(), 1)`);
      const ranH = await statusIs(/Ran 6 SageTeX items in [0-9.]+ s$/, 120000);
      const hj = JSON.parse((await resultsOf("/ex-helper/paper.tex")) ?? "null");
      const hl = hj?.items?.map((x) => x.latex ?? x.msg ?? x.s) ?? [];
      check(ranH && hj?.items?.length === 6 && hj.items.every((x) => x.s === "ok") && hl.some((l) => /1766319049.*226153980/.test(l)) && hl.includes("871") && hl.includes("178"),
        "Run (Codex P5): #772's example imports helper.py beside the .tex: Pell's (1766319049, 226153980), Collatz 871 after 178 steps", { ranH, status: await ev(`document.querySelector(".tex-status")?.textContent ?? ""`), hl: hl.map((l) => String(l).slice(0, 120)) });
      const B_DOC = String.raw`\documentclass{article}
\usepackage{sagetex}
\begin{document}
\begin{sagesilent}
import sys, os
sys.modules.pop('statistics', None)
import statistics, helper
\end{sagesilent}
$\sage{helper.v()}$, $\sage{(hasattr(statistics, 'median'), hasattr(statistics, 'SHADOW'))}$,
$\sage{(os.getcwd() == '/ex-b', any(str(p).startswith('/$') for p in sys.path[:-1]), sys.path[-1] == '/ex-b', sys.path.count('/ex-b'), str(sys.path))}$,
$\sage{(os.path.exists('/ex-helper/helper.py'), os.path.exists('helper.py'))}$.
\begin{sagesilent}
open('made.txt', 'w').write('x')
\end{sagesilent}
\end{document}
`;
      const fbB = await mk("/ex-b/doc.tex", enc(B_DOC));
      await mk("/ex-b/helper.py", enc("def v():\n    return 7\n"));
      await mk("/ex-b/statistics.py", enc("SHADOW = 1\n"));
      const runB = async () => { await ev(`(document.querySelector(".tex-status").textContent = "", document.querySelector(".tex-head .tex-run").click(), 1)`); await statusIs(/Ran 6 SageTeX items|Not run/, 120000); return JSON.parse((await resultsOf("/ex-b/doc.tex")) ?? "null"); };
      await open(fbB);
      await until(`!document.querySelector(".tex-head .tex-run")?.hidden`, 20000);
      const b1 = await runB();
      const L = (j, i) => String(j?.items?.[i]?.latex ?? j?.items?.[i]?.msg ?? "").replace(/\\left|\\right/g, "");
      const made = await ev(`${W}.stat("/ex-b/made.txt").then((e) => !!e && !e.trashed)`);
      check(L(b1, 1) === "7" && /\\mathrm\{True\}, \\mathrm\{False\}/.test(L(b1, 2)) && /^\(\\mathrm\{True\}, \\mathrm\{True\}, \\mathrm\{True\}, 1,/.test(L(b1, 3)) && /\(\\mathrm\{False\}, \\mathrm\{True\}\)/.test(L(b1, 4)),
        "Run (Codex P5): another folder's document imports its own helper.py, not the first folder's (gone from the session); its folder is the working one, last on sys.path, once, the runtime's own library ahead of it; the standard statistics over one beside it", { items: [1, 2, 3, 4].map((i) => L(b1, i)) });
      check(b1?.items?.[5]?.s === "error" && !made, "Run (Codex P5): the document's code can't make a file (read-only), and no file is made", { item: L(b1, 5).slice(-160), made });
      // (Codex W01: the results record what their Run imported from the folder: helper.py, with its hash)
      const w01deps = b1?.deps?.map((d) => d[0]) ?? [];
      await ev(`${W}.stat("/ex-b/helper.py").then((e) => ${W}.write("/ex-b/helper.py", new TextEncoder().encode("def v():\\n    return 8\\n"), { fid: e.fid, base: e.rev ?? 0 })).then(() => 1)`);
      // (the helper edited, the page read again (its window back in focus): its results aren't used, said; the items
      //  not run, the old 7 gone from the preview)
      await ev(`(document.querySelector(".tex-status").textContent = "", window.dispatchEvent(new Event("focus")), 1)`);
      const staleSaid = await statusIs(/The SageTeX results aren't used: helper\.py changed or was removed since they were run; press Run/, 15000);
      // (inline in math, an item not run shows as "…" where its value was: the old 7 gone, four of them)
      const notRun = await until(`(() => { const t = document.querySelector(".tex-preview")?.textContent ?? ""; return (t.match(/\u2026/g) || []).length >= 4 && !/\b7\b/.test(t); })()`, 15000);
      check(w01deps.includes("helper.py") && w01deps.includes("statistics.py") === false && staleSaid && notRun, "Run (Codex W01): the results record helper.py; it edited, the page doesn't use them: says why, the items not run", { w01deps, staleSaid, notRun, status: await ev(`document.querySelector(".tex-status")?.textContent ?? ""`), preview: await ev(`(document.querySelector(".tex-preview")?.textContent ?? "").slice(0, 200)`) });
      const b2 = await runB();
      check(L(b2, 1) === "8", "Run (Codex P5): the helper edited, the next Run imports the edit", { got: L(b2, 1) });
      // (grader's #804 P2: what was checked is what is seen: back in focus with nothing changed, the results file isn't
      //  read again)
      await sleep(1500);
      const rp = "/ex-b/doc.tex.results.json";
      const quiet = await ev(`(async () => { const ws = window.__sbTexWs, real = ws.readUpTo, reads = [];
        ws.readUpTo = function (p, ...a) { reads.push(p); return real.call(this, p, ...a); };
        window.dispatchEvent(new Event("focus")); await new Promise((r) => setTimeout(r, 1500)); ws.readUpTo = real;
        return reads.filter((p) => p === ${JSON.stringify(rp)}).length; })()`);
      check(quiet === 0, "Run (Codex W01): back in focus with nothing changed, the results file isn't read again (what was checked is what is seen)", { reads: quiet });
      // (grader's #804 P3: the helper changed while its results are checked: nothing used then, and checked again
      //  shortly by the page itself (no further focus, no Run): then said not used)
      const settle = await ev(`(async () => { const ws = window.__sbTexWs, real = ws.readUpTo; let once = true;
        ws.readUpTo = async function (p, ...a) { const r = await real.call(this, p, ...a);
          if (once && p === "/ex-b/helper.py") { once = false; const e = await ${W}.stat(p); await ${W}.write(p, new TextEncoder().encode("def v():\\n    return 9\\n"), { fid: e.fid, base: e.rev ?? 0 }); }
          return r; };
        // (the results file rewritten as it is (its entry changes), so the page, back in focus, checks it again)
        const rp = ${JSON.stringify(rp)}, re = await ${W}.stat(rp), rb = (await ${W}.read(rp)).content;
        await ${W}.write(rp, rb, { fid: re.fid, base: re.rev ?? 0 });
        document.querySelector(".tex-status").textContent = ""; window.dispatchEvent(new Event("focus"));
        for (let i = 0; i < 60 && once; i++) await new Promise((r) => setTimeout(r, 50));
        const mid = !once;
        for (let i = 0; i < 80 && !/helper\.py changed or was removed/.test(document.querySelector(".tex-status")?.textContent ?? ""); i++) await new Promise((r) => setTimeout(r, 100));
        ws.readUpTo = real;
        return { mid, said: /helper\.py changed or was removed/.test(document.querySelector(".tex-status")?.textContent ?? ""), status: document.querySelector(".tex-status")?.textContent ?? "" }; })()`);
      check(settle.mid && settle.said, "Run (Codex W01): the helper changed while its results are checked: checked again by the page shortly after, then said not used", settle);
      await ev(`${W}.remove("/ex-b/helper.py").then(() => 1)`);
      const b3 = await runB();
      check(b3?.items?.[0]?.s === "error" && /No module named .?helper/.test(L(b3, 0)), "Run (Codex P5): the helper deleted, the next Run can't import it", { got: L(b3, 0).slice(-160) });
      // (grader's #812 P1: files of the folder only in the cloud aren't given to Sage, and the Run's status line says how
      //  many: one, then two (the listing marks them so, as the cloud's entries are))
      await mk("/ex-b/data.txt", enc("1\n"));
      await ev(`(() => { const ws = window.__sbTexWs, real = ws.list; window.__cloud = []; ws.list = async function (...a) { const r = await real.apply(this, a); return r.map((e) => window.__cloud.includes(e.path) ? { ...e, remote: true } : e); }; window.__cloudRestore = () => { ws.list = real; }; return 1; })()`);
      const statusNow = () => ev(`document.querySelector(".tex-status")?.textContent ?? ""`);
      await ev(`(window.__cloud = ["/ex-b/statistics.py"], 1)`);
      await runB(); const one = await statusNow();
      await ev(`(window.__cloud = ["/ex-b/statistics.py", "/ex-b/data.txt"], 1)`);
      await runB(); const two = await statusNow();
      await ev(`(window.__cloudRestore(), delete window.__cloudRestore, delete window.__cloud, 1)`);
      check(/^Ran 6 SageTeX items in [0-9.]+ s(; [0-9]+ failed)?; 1 file in its folder is only in the cloud, not given to Sage$/.test(one) && /^Ran 6 SageTeX items in [0-9.]+ s(; [0-9]+ failed)?; 2 files in its folder are only in the cloud, not given to Sage$/.test(two),
        "Run (#812 P1): the folder's files only in the cloud: the status line says how many weren't given to Sage (1 file is, 2 files are)", { one, two });
      // (a folder past the bound: 501 files; Run says so, starts nothing and writes no results file)
      const fbig = await mk("/ex-big/doc.tex", enc("\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n$\\sage{1+1}$\n\\end{document}\n"));
      await ev(`(async () => { for (let i = 0; i < 500; i++) await ${W}.create("/ex-big/f" + i + ".txt", { content: new Uint8Array([120]) }); return 1; })()`);
      await open(fbig);
      await until(`!document.querySelector(".tex-head .tex-run")?.hidden`, 20000);
      await ev(`(document.querySelector(".tex-head .tex-run").click(), 1)`);
      const tooBig = await statusIs(/Not run: the \.tex's folder is too large/, 30000);
      await sleep(1000);
      check(tooBig && (await resultsOf("/ex-big/doc.tex")) === null, "Run (Codex P5): a folder past the bound (over 500 files): Run says so, runs nothing, writes no results", { tooBig, status: await ev(`document.querySelector(".tex-status")?.textContent ?? ""`) });
    }
    // (astra's LATEX-QUEUE-STOP-1: Stop on a Run waiting for another one in the session: A's Run held in its turn (the
    //  test build's hook), B opened in place and its Run queued behind it, then B's Stop; A's turn released: B runs
    //  nothing ("Stopped before it ran", no results file), and A, its page gone, writes nothing)
    {
      const qa = await mk("/qs/a.tex", enc(RUN_DOC)), qb = await mk("/qs/b.tex", enc(RUN_DOC));
      await open(qa);
      await until(`!document.querySelector(".tex-head .tex-run")?.hidden`, 20000);
      await ev(`(window.__qsN = 0, window.__qsHold = new Promise((r) => (window.__qsRel = r)), window.__sbTexRunHold = () => (++window.__qsN === 1 ? window.__qsHold : undefined), document.querySelector(".tex-head .tex-run").click(), 1)`);
      const heldA = await until(`window.__qsN === 1`, 120000);
      await ev(`(window.__sbTex({ path: "/qs/b.tex", fid: ${JSON.stringify(qb)} }), 1)`);
      await until(`document.querySelector(".tex-title")?.textContent === "b.tex" && !document.querySelector(".tex-head .tex-run")?.hidden`, 20000);
      await ev(`(document.querySelector(".tex-head .tex-run").click(), 1)`);
      const queued = await until(`document.querySelector(".tex-head .tex-run")?.textContent === "Running…"`, 60000);
      await ev(`(document.querySelector(".tex-head .tex-run").click(), 1)`);
      await sleep(300);
      const nBefore = await ev(`window.__qsN`);
      await ev(`(window.__qsRel(), 1)`);
      const said = await statusIs(/Stopped before it ran/, 20000);
      await sleep(1000);
      const ra = await resultsOf("/qs/a.tex"), rb = await resultsOf("/qs/b.tex");
      await ev(`(delete window.__sbTexRunHold, 1)`);
      check(heldA && queued && nBefore === 1 && said && ra === null && rb === null, "Run (astra LATEX-QUEUE-STOP-1): Stop on a Run waiting for another in the session: it runs nothing, says so, no results; the one ahead (its page gone) writes nothing",
        { heldA, queued, nBefore, said, status: await ev(`document.querySelector(".tex-status")?.textContent ?? ""`), ra: ra && ra.slice(0, 80), rb: rb && rb.slice(0, 80) });
    }
    // (a Run made stale: another file opened in place while it runs; it writes nothing)
    const fs = await mk("/t/run-stale.tex", enc(RUN_DOC.replace("x = 2^10", "x = 2^10\n_s = sum(i for i in range(2*10^6))")));
    const fo = await mk("/t/run-other.tex", enc(DOC));
    await open(fs);
    await until(`!document.querySelector(".tex-head .tex-run")?.hidden`, 20000);
    await ev(`(document.querySelector(".tex-head .tex-run").click(), 1)`);
    const started = await until(`document.querySelector(".tex-head .tex-run")?.textContent === "Running…"`, 60000);
    await ev(`(window.__sbTex({ path: "/t/run-other.tex", fid: ${JSON.stringify(fo)} }), 1)`);
    await until(`document.querySelector(".tex-preview")?.textContent.includes("Hello")`, 20000);
    await sleep(15000);
    check(started && (await resultsOf("/t/run-stale.tex")) === null, "Run: a Run made stale (another file opened in place while it runs) writes no results", { started });
    // (no runner here: ?runner=0 on a loopback host; Run says why, and runs nothing)
    const fn0 = await mk("/t/run-none.tex", enc(RUN_DOC));
    const n1 = requests.length;
    await open(fn0, "&latex=1&runner=0");
    await until(`!document.querySelector(".tex-head .tex-run")?.hidden`, 20000);
    await ev(`(document.querySelector(".tex-head .tex-run").click(), 1)`);
    const said = await statusIs(/Run needs the sandbox/, 10000);
    await sleep(1000);
    check(said && !requests.slice(n1).some((u) => /\/runner\//.test(u)) && (await resultsOf("/t/run-none.tex")) === null, "Run: without the runner, it says why and runs nothing (no plain worker, no results)", { said });
  }
  // ---- a file in Trash, opened by its fid
  const ftr = await mk("/t/trashme.tex", enc(DOC));
  await ev(`${W}.remove("/t/trashme.tex").then(() => 1)`);
  await go(base + "?tex=" + ftr + "&latex=1"); await sleep(1500);
  check(await ev(`document.querySelector(".tex-page")?.textContent.includes("This file isn't here any more (it's in the Trash).")`), "a fid only in Trash: Gone, in the Trash");
  // ---- gone: an unknown fid
  await go(base + "?tex=ffffffffffffffff&latex=1"); await sleep(1500);
  check(await ev(`document.querySelector(".tex-page")?.textContent.includes("This file isn't here any more.")`), "an unknown fid: Gone");
  // (grader R5 on #546) the worker replaced by its watchdog (a reply held past its 15 s): the new worker is sent the
  // \input files again, so a macro from the macros file still renders in its reply
  {
    const rHook = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      window.__holdReplies = false; window.__replyHolds = [];
      window.__sbTexReplyHold = () => { if (window.__holdReplies) return new Promise((r) => window.__replyHolds.push(r)); };
    })()` });
    await mk("/shared2/macros.tex", enc("\\newcommand{\\greet}{Hello again from the macros file}\n"));
    const MAIN = "\\documentclass{article}\n\\input{../shared2/macros}\n\\begin{document}\n\\greet.\n\\end{document}\n";
    await open(await mk("/paper2/main.tex", enc(MAIN)));
    const first = await until(`(document.querySelector(".tex-preview")?.textContent ?? "").includes("Hello again from the macros file")`, 20000);
    await ev(`window.__holdReplies = true`);
    await typeInto(MAIN.replace("\\greet.", "\\greet. After the restart."));
    const held = await until(`window.__replyHolds.length === 1`, 20000);
    // (only that reply held: the replaced worker's reply, after the watchdog's 15 s, is installed)
    await ev(`window.__holdReplies = false`);
    const shown = await until(`(() => { const t = document.querySelector(".tex-preview")?.textContent ?? ""; return t.includes("After the restart") && t.includes("Hello again from the macros file"); })()`, 40000);
    check(first && held && shown, "\\input: after the worker is replaced (its watchdog), the macros file's macro still renders",
      { first, held, shown, text: await ev(`(document.querySelector(".tex-preview")?.textContent ?? "").slice(0, 200)`) });
    await ev(`(() => { for (const r of window.__replyHolds.splice(0)) r(); return true; })()`);
    await sleep(500);
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: rHook.identifier });
  }
  check(errors.length === 0, "no page errors", errors);
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  ws.close(); chrome.kill(); server.kill();
  await sleep(300); rmSync(profile, { recursive: true, force: true });
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks}:\n  ${fails.join("\n  ")}` : `ok: the LaTeX editor's page, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
