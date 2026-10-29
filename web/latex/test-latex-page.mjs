// The LaTeX editor's page end to end, in headless Chrome against a web/dist built with SAGEBRUSH_LATEX_PREVIEW=test
// (the page also on loopback hosts), served by web/serve.py (cross-origin isolated, as the site):
//   - the flag: off, no editor and no LaTeX file fetched; on, nothing fetched before a .tex is opened;
//   - a middle-click on a file row: a new tab of the editor only for a .tex it takes; otherwise nothing, as before;
//   - opening by fid, the banner, Save gated on edits, Ctrl/Cmd+S, "Saved" / "No changes to save", cleared by an edit;
//   - the byte rules: the fixtures saved and read back; mixed endings and NUL open without Save;
//   - the save target: a rename followed; the file in Trash, refused; another tab's save overwritten (and kept as a
//     version); beforeunload with unsaved edits;
//   - images: one in the folder shown from a blob: URL; one outside refused with its reason; a held read under a
//     second render: each name read and kept once, within the count bound;
//   - a 1.5 MiB paragraph and list shown as pieces of at most 128 KiB, never two versions at once;
//   - non-ASCII HTML: no patch step over 512 KiB of UTF-8.
//   - the layout and controls: New offers a LaTeX file only with the editor on; the files beside the page, not over
//     it, Files hiding and showing them with the document open; long lines wrapped (not over 16 KiB); the font size and
//     zoom kept; a notebook from the files opened by URL; an unclosed $$ ended at a blank line.
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && CHROME=google-chrome node web/latex/test-latex-page.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";
import { boxClass } from "./boxclass.mjs";

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
let n = 0; const waiting = new Map(); const errors = [], requests = [], dialogs = [], sizes = new Map(), reqUrl = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Network.requestWillBeSent") { requests.push(m.params.request.url); reqUrl.set(m.params.requestId, m.params.request.url); }
  if (m.method === "Network.loadingFinished") sizes.set(reqUrl.get(m.params.requestId) ?? m.params.requestId, m.params.encodedDataLength);
  if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params.type); send("Page.handleJavaScriptDialog", { accept: true }); }
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
const statusIs = (re, ms = 10000) => until(`${re}.test(document.querySelector(".tex-status")?.textContent ?? "")`, ms);

try {
  for (const m of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(m);
  // ---- the flag: off (no ?latex=1, nothing stored): ?tex= shows the note, and nothing of the editor is fetched
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
    check(fb.found && fb.inView && fb.top && items.indexOf("LaTeX document") >= 0 && items.indexOf("LaTeX document") === items.indexOf("newFolder") - 2 && items.indexOf("LaTeX example") === items.indexOf("newFolder") - 1 && mr.found && mr.inView && mr.top,
      "phone: File > New offers LaTeX document and LaTeX example (before Folder), File and the item in view and not covered", { fb, items, mr });
    await mark(); await ev(`([...document.querySelectorAll('.fmgroup[aria-label="New"] button')].find((b) => b.textContent === "LaTeX document").click(), true)`);
    check(await madeAs("/Untitled (2).tex"), "phone: File > New > LaTeX document: /Untitled (2).tex made and opened in the editor");
    // File > New > LaTeX example: the examples' list fits the phone (10 large buttons, the dialog within the width,
    // each button reachable), and the figure example opens with its image (a folder of its own, plot.png beside it)
    await go(base + "?latex=1"); await until(`!!${W}`, 60000);
    await ev(`(document.getElementById("filebtn").click(), true)`);
    await until(`!!document.querySelector('.fmgroup[aria-label="New"]')`, 10000);
    await ev(`(document.querySelector('#filemenu button[data-group="new"]').click(), true)`);
    const exItem = await reach('.fmgroup[aria-label="New"] button', "LaTeX example");
    await ev(`([...document.querySelectorAll('.fmgroup[aria-label="New"] button')].find((b) => b.textContent === "LaTeX example").click(), true)`);
    const listed2 = await until(`document.querySelectorAll("dialog.sb-tex-examples[open] button[data-example]").length === 10`, 20000);
    const dlg = listed2 && await ev(`(() => { const d = document.querySelector("dialog.sb-tex-examples"), r = d.getBoundingClientRect(), bs = [...d.querySelectorAll("button[data-example]")];
      const last = bs[bs.length - 1]; last.scrollIntoView({ block: "center" }); const lr = last.getBoundingClientRect(), at = document.elementFromPoint(lr.left + lr.width / 2, lr.top + lr.height / 2);
      return { menuHidden: document.getElementById("filemenu").hidden, left: r.left, right: r.right, w: innerWidth, n: bs.length, minH: Math.min(...bs.map((b) => b.getBoundingClientRect().height)), lastReach: at === last || last.contains(at) }; })()`);
    check(exItem.found && exItem.inView && exItem.top && listed2 && dlg.menuHidden && dlg.left >= 0 && dlg.right <= dlg.w && dlg.n === 10 && dlg.minH >= 44 && dlg.lastReach,
      "phone: File > New > LaTeX example: the File menu closed, the list of 10 fits the screen, every button at least 44 px and reachable", { exItem, dlg });
    await mark(); await ev(`(document.querySelector('dialog.sb-tex-examples button[data-example="figure"]').click(), true)`);
    const figOk = await madeAs("/LaTeX examples/Figure with an image/figure.tex");
    const figImg = figOk && await until(`[...document.querySelectorAll(".tex-preview img.graphic")].some((i) => i.src.startsWith("blob:"))`, 20000);
    check(figOk && figImg && await ev(`${W}.stat("/LaTeX examples/Figure with an image/plot.png").then((e) => e?.kind === "file")`), "phone: the figure example: its folder made, figure.tex opened, plot.png beside it and shown in the preview");
    await ev(`localStorage.removeItem("sagebrush-files-sidebar"); true`);
    await send("Emulation.clearDeviceMetricsOverride");
  }
  // ---- every example opened in the editor (made by the page module's makeExample, as the list does; the test's
  // workspace handle has create, not the page's createByPerson): each renders in the preview,
  // with nothing shown as unsupported (gray tags; the SageTeX and PythonTeX "not run" chips are expected), recorded
  {
    await go(base + "?latex=1"); await until(`!!${W}`, 60000);
    const ids = await ev(`import("/sagebrush-latex.js").then((x) => x.EXAMPLES.map((e) => e.id))`);
    const rec = [];
    for (const id of ids) {
      const fidEx = await ev(`import("/sagebrush-latex.js").then(async (x) => (await x.makeExample({ stat: (p) => ${W}.stat(p), mkdir: (p) => ${W}.mkdir(p), createByPerson: (p, o) => ${W}.create(p, o) }, x.EXAMPLES.find((e) => e.id === ${JSON.stringify(id)}))).fid)`);
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
  const fid = await mk("/t/doc.tex", enc(DOC));
  requests.length = 0;
  await go(base + "?tex=" + fid);
  await sleep(1500);
  check(await ev(`!document.querySelector(".tex-page") && document.body.innerText.includes("The LaTeX editor isn't enabled here.")`), "flag off: the note, no editor");
  check(latexFetches().length === 0, "flag off: no LaTeX file fetched", latexFetches());
  check(await ev(`[...document.querySelectorAll("button")].some((b) => b.textContent === "Preview it")`), "flag off: the note offers the file's preview");
  // ---- a middle-click on a file row (board i1c01 U1): a new tab of the editor only for a .tex file it takes; any
  // other file (or the flag off), nothing, as before the editor: no preview here, no tab
  await mk("/mid.txt", enc("plain\n")); const midFid = await mk("/mid.tex", enc(DOC));
  const middle = async (q) => {
    await ev(`localStorage.setItem("sagebrush-files-sidebar", "1"); true`);
    await go(base + q); await until(`!!${W}`, 60000);
    const sel = (p) => JSON.stringify(`.frow[data-path="${p}"]`);
    const rows = await until(`!!document.querySelector(${sel("/mid.txt")}) && !!document.querySelector(${sel("/mid.tex")})`, 20000);
    const out = { rows };
    for (const p of ["/mid.txt", "/mid.tex"]) out[p] = rows && await ev(`(async () => {
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
  check(mOff.rows && nothing(mOff["/mid.txt"]) && nothing(mOff["/mid.tex"]), "flag off: a middle-click on a file does nothing (no preview here, no tab)", mOff);
  const mOn = await middle("?latex=1");
  check(mOn.rows && nothing(mOn["/mid.txt"]), "flag on: a middle-click on a non-.tex file does nothing (no preview here, no tab)", mOn);
  check(mOn.rows && mOn["/mid.tex"] && mOn["/mid.tex"].opened.length === 1 && mOn["/mid.tex"].opened[0].includes("?tex=" + midFid) && !mOn["/mid.tex"].preview && mOn["/mid.tex"].here, "flag on: a middle-click on a .tex file opens the editor in a new tab only", mOn);
  // on, by the URL: no LaTeX file fetched before a .tex is opened
  requests.length = 0;
  await go(base + "?latex=1"); await until(`!!${W}`, 60000); await sleep(1000);
  check(latexFetches().length === 0, "flag on: nothing fetched before a .tex is opened (zero eager fetch)", latexFetches());
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
  check(await page(`P.querySelector(".tex-banner").textContent.startsWith("LaTeX editor: an early prototype. Save (Ctrl/Cmd+S) overwrites the file.")`), "the banner says save overwrites");
  check(await page(`P.querySelector(".tex-save").disabled === true && P.querySelector(".tex-dirty").hidden === true`), "Save disabled, nothing unsaved");
  check(latexFetches().some((u) => /sagebrush-latex\.js/.test(u)) && latexFetches().some((u) => /sagebrush-latex-worker\.js/.test(u)), "the page and its worker fetched now", latexFetches());
  const rev0 = await ev(`${W}.stat("/t/doc.tex").then((e) => e.rev ?? 0)`);
  await send("Runtime.evaluate", { expression: `document.querySelector(".tex-src").focus()` });
  await ctrlS();
  check(await statusIs(/No changes to save/), "Ctrl+S on clean text: no write, said");
  check((await ev(`${W}.stat("/t/doc.tex").then((e) => e.rev ?? 0)`)) === rev0, "…and the revision unchanged");
  await typeInto(DOC.replace("Some text", "Edited text"));
  check(await page(`P.querySelector(".tex-dirty").hidden === false && P.querySelector(".tex-save").disabled === false`), "an edit: Unsaved changes, Save enabled");
  // (plan r5 §6's marks, for the TIMING harness: an edit's input, request, reply, patch and paint carry its revision;
  // the highlighter's done mark carries its wall and busy ms)
  const marksOk = await until(`(() => { const m = (n) => performance.getEntriesByName(n); const inp = m("tex-input").at(-1); if (!inp) return false; const r = inp.detail.rev;
    return ["tex-request", "tex-parse-done", "tex-patch-done", "tex-paint"].every((n) => m(n).some((e) => e.detail.rev === r && e.startTime >= inp.startTime))
      && m("tex-highlight-done").some((e) => e.startTime >= inp.startTime && e.detail.wall >= e.detail.busy && e.detail.busy >= 0)
      && m("tex-mount").length === 1 && m("tex-read-done").length === 1; })()`, 10000);
  check(marksOk, "the §6 marks: an edit's input, request, parse, patch and paint by revision; the highlighter's wall and busy", await ev(`performance.getEntriesByType("mark").map((e) => [e.name, e.detail]).slice(-12)`));
  await ctrlS();
  check(await statusIs(/^Saved$/), "Ctrl+S: Saved");
  check(JSON.stringify(await bytesOf("/t/doc.tex")) === JSON.stringify(enc(DOC.replace("Some text", "Edited text"))), "…the bytes written are the text");
  check(await page(`P.querySelector(".tex-dirty").hidden === true && P.querySelector(".tex-save").disabled === true`), "…and nothing unsaved after");
  // the next keystroke after "Saved": the old message goes, beside "Unsaved changes" (board i1c01 U2)
  await typeInto(DOC.replace("Some text", "Edited again"));
  check(await page(`P.querySelector(".tex-status").textContent === "" && P.querySelector(".tex-dirty").hidden === false`), "an edit after Saved: the status cleared, Unsaved changes shown", await page(`P.querySelector(".tex-status").textContent`));
  await typeInto(DOC.replace("Some text", "Edited text"));
  check(await page(`P.querySelector(".tex-dirty").hidden === true`), "…typed back to the saved text: nothing unsaved");

  // ---- the byte rules, through the page: the fixtures saved after an edit and read back
  const BOM = [0xef, 0xbb, 0xbf];
  const fixtures = [["crlf", enc("a\r\nb\r\n"), (t) => enc(t.replace(/\n/g, "\r\n"))], ["bom", BOM.concat(enc("a\nb\n")), (t) => enc(t)], ["bom-crlf", BOM.concat(enc("a\r\nb\r\n")), (t) => enc(t.replace(/\n/g, "\r\n"))]];
  for (const [name, b, expect] of fixtures) {
    const f = await mk(`/t/${name}.tex`, b);
    await open(f);
    await until(`document.querySelector(".tex-save") && !document.querySelector(".tex-save").hidden`, 10000);
    const text = await ev(`document.querySelector(".tex-src").value`);
    await typeInto(text + "c\n"); await ctrlS();
    await statusIs(/^Saved$/);
    const got = await bytesOf(`/t/${name}.tex`), want = expect(text + "c\n");
    check(JSON.stringify(got) === JSON.stringify(want) && got.filter((x, i) => x === 0xef && got[i + 1] === 0xbb && got[i + 2] === 0xbf).length === (b[0] === 0xef ? 1 : 0), "fixture " + name + ": saved and read back exactly, one BOM at most", { got: got.slice(0, 12), want: want.slice(0, 12) });
  }
  const mixed = await mk("/t/mixed.tex", enc("a\r\nb\nc\n"));
  await open(mixed); await sleep(800);
  check(await page(`P.querySelector(".tex-save").hidden === true && P.querySelector(".tex-banner").textContent.includes("mixes line endings")`), "mixed line endings: no Save, the banner says why");
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
  check(await statusIs(/^Saved$/) && JSON.stringify(await bytesOf("/t/moved.tex")) === JSON.stringify(enc(DOC + "% x\n")), "a rename elsewhere: the save follows the file");
  await ev(`${W}.remove("/t/moved.tex").then(() => 1)`);
  await typeInto(DOC + "% y\n"); await ctrlS();
  check(await statusIs(/Not saved: this file isn't here any more/), "the file in Trash: not saved");
  // another tab's save, then this one's: last write wins, the other kept as a version
  const f3 = await mk("/t/lw.tex", enc(DOC));
  await open(f3); await sleep(500);
  await ev(`${W}.write("/t/lw.tex", new TextEncoder().encode("other tab\\n")).then(() => 1)`);
  await typeInto(DOC + "% mine\n"); await ctrlS(); await statusIs(/^Saved$/);
  const hist = await ev(`${W}.history("/t/lw.tex").then((h) => h.length)`);
  check(JSON.stringify(await bytesOf("/t/lw.tex")) === JSON.stringify(enc(DOC + "% mine\n")) && hist >= 2, "another tab saved: overwritten (last write wins), its bytes kept as a version", { hist });
  // beforeunload with unsaved edits
  await typeInto(DOC + "% unsaved\n");
  dialogs.length = 0;
  await send("Page.navigate", { url: base + "?latex=1" }); await sleep(1500);
  check(dialogs.includes("beforeunload"), "unsaved edits: the browser asks before leaving", dialogs);

  // ---- images: in the folder, from a blob: URL; outside, refused with its reason
  const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 227, 85, 242, 156, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
  await go(base + "?latex=1"); await until(`!!${W}`, 60000);
  await mk("/img/fig.png", png);
  await mk("/other.png", png);
  const fi = await mk("/img/doc.tex", enc("\\documentclass{article}\n\\begin{document}\n\\includegraphics{fig}\n\\includegraphics{../other.png}\n\\end{document}\n"));
  await open(fi);
  check(await until(`[...document.querySelectorAll(".tex-preview img.graphic")].some((i) => i.src.startsWith("blob:"))`, 15000), "an image in the folder: shown from a blob: URL");
  check(await until(`document.querySelector(".tex-preview").textContent.includes("[image: ../other.png: outside this folder]")`, 15000), "an image outside the folder: refused, with its reason");

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

  // ---- non-ASCII HTML (daybreak2 i1c01): the patch budget's 512 KiB is UTF-8 bytes, split.ts's measure: a 1.95 MB
  // (UTF-8) paragraph of three-byte characters is patched with no step over 512 KiB, the byte stop seen ending steps
  const cjk = "\\documentclass{article}\n\\begin{document}\n" + "中文字体 ".repeat(150000) + "\n\\end{document}\n";
  const fc = await mk("/t/cjk.tex", enc(cjk));
  await open(fc);
  const cjkOk = await until(`document.querySelectorAll(".tex-preview .pc").length > 10 && !!document.querySelector(".tex-preview").dataset.stops`, 60000);
  const cj = await ev(`(() => { const d = document.querySelector(".tex-preview").dataset; const pcs = [...document.querySelectorAll(".tex-preview .pc")]; const enc = new TextEncoder(); return { pcs: pcs.length, utf8: pcs.reduce((a, p) => a + enc.encode(p.innerHTML).length, 0), units: pcs.reduce((a, p) => a + p.innerHTML.length, 0), stepBytesMax: +d.stepBytesMax, stops: JSON.parse(d.stops) }; })()`);
  console.log("non-ASCII patch (UTF-8 bytes, UTF-16 units, the most bytes in one step, the stops):", JSON.stringify(cj));
  check(cjkOk && cj.utf8 > 3 * 512 * 1024 && cj.utf8 > 2 * cj.units && cj.stepBytesMax > 0 && cj.stepBytesMax <= 512 * 1024 && cj.stops.bytes > 0, "non-ASCII: no patch step over 512 KiB of UTF-8, the byte stop ending steps", cj);

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

  // ---- the patch loop: no Long Task over 50 ms while a large paragraph and list are re-patched. Timing assertions
  // gate only on a timing box (BOX "timing", VM3/VM4: @sagebrush's ruling, Oct 29); on a build box they are recorded
  await ev(`(() => { window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: false }); return true; })()`);
  await typeInto(para.replace("CHANGED word", "AGAIN word"));
  await until(`document.querySelector(".tex-preview").textContent.includes("AGAIN")`, 60000);
  await sleep(500);
  const lts = await ev(`window.__lt`);
  const own = await ev(`({ step: +document.querySelector(".tex-preview").dataset.patchMaxMs, swap: +document.querySelector(".tex-preview").dataset.swapMaxMs, reply: +document.querySelector(".tex-preview").dataset.replyMs })`);
  console.log("long tasks during the re-patch (ms):", JSON.stringify(lts), "patch loop's own longest step and swap (ms):", JSON.stringify(own));
  if (BOX === "timing") {
    check(own.step <= 50 && own.swap <= 50, "the patch loop's own steps and swap each under 50 ms (a timing box)", own);
    check(lts.every((d) => d <= 50), "no Long Task over 50 ms while re-patching (a timing box)", { lts, own });
  } else console.log("timing, reported, not gated (a build box): long tasks over 50 ms:", JSON.stringify(lts.filter((d) => d > 50)), "own step/swap over 50 ms:", own.step > 50 || own.swap > 50);

  // ---- a 1.5 MiB enumerate and a 1.5 MiB plain theorem: pieces whose styles and labels continue; a large table: a placeholder
  const thmDoc = "\\documentclass{article}\n\\newtheorem{theorem}{Theorem}\n\\begin{document}\n\\begin{theorem}\n" + "theorem words go on and on here. ".repeat(6000).split(". ").join(".\n\n") + "\n\\end{theorem}\n\n\\begin{enumerate}\n" + "\\item an item\n".repeat(6000) + "\\end{enumerate}\n\\end{document}\n";
  const ft = await mk("/t/thm.tex", enc(thmDoc));
  await open(ft);
  await until(`document.querySelectorAll(".tex-preview .thm.cont").length > 0 && document.querySelectorAll(".tex-preview .list.cont").length > 0`, 60000);
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
  check(JSON.stringify(offItems) === JSON.stringify(["Notebook", "Board", "Folder"]), "A0: the editor off: New offers no LaTeX file", offItems);
  const onItems = await newMenu("?latex=1");
  check(JSON.stringify(onItems) === JSON.stringify(["Notebook", "Board", "LaTeX document", "Folder"]), "A0: the editor on: New offers a LaTeX file", onItems);
  await mark();
  await ev(`([...document.querySelectorAll(".sbfmenu button")].find((b) => b.textContent === "LaTeX document").click(), true)`);
  const made = await fresh(`!!document.querySelector(".tex-page .tex-src") && !!${W}`, 20000);
  const newTex = made && await ev(`${W}.stat("/Untitled (3).tex").then((e) => ({ kind: e?.kind, fid: e?.fid ?? "", here: !!e?.fid && new URLSearchParams(location.search).get("tex") === e.fid }))`);
  check(made && newTex.kind === "file" && newTex.fid && newTex.here && JSON.stringify(await bytesOf("/Untitled (3).tex")) === JSON.stringify(enc("\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n")), "A0: New, LaTeX document: /Untitled (3).tex (the phone checks made the first two) made, with a short document, and opened in the editor", newTex);
  // A1, A7: the files shown beside the page, not over it; Files hides and shows them, the document staying open
  const UXDOC = "\\documentclass{article}\n\\begin{document}\n\\section{Hello}\nSome text " + "long words ".repeat(60) + "\n\\end{document}\n";
  const fu = await mk("/t/ux.tex", enc(UXDOC));
  await open(fu);
  await until(`!document.getElementById("wssidebar").hidden && !!document.querySelector(".tex-src")`, 20000);
  const lay = () => ev(`(() => { const s = document.getElementById("wssidebar"), P = document.querySelector(".tex-page"), fb = P.querySelector(".tex-back"), b = fb.getBoundingClientRect();
    return { shown: !s.hidden, sideRight: s.hidden ? 0 : Math.round(s.getBoundingClientRect().right), left: Math.round(P.getBoundingClientRect().left), top: document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === fb, pressed: fb.getAttribute("aria-pressed"), text: P.querySelector(".tex-src")?.value }; })()`);
  const l1 = await lay();
  check(l1.shown && l1.left >= l1.sideRight - 1 && l1.top && l1.pressed === "true", "A1: files shown: the page starts right of them, its Files button not covered and pressed", l1);
  await page(`(P.querySelector(".tex-back").click(), true)`); await sleep(300);
  const l2 = await lay();
  check(!l2.shown && l2.left === 0 && l2.pressed === "false" && l2.text === UXDOC, "A7: Files: the files hidden, the page full width, the same document open", { ...l2, text: l2.text?.length });
  await page(`(P.querySelector(".tex-back").click(), true)`); await sleep(300);
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

  // ---- a file in Trash, opened by its fid
  const ftr = await mk("/t/trashme.tex", enc(DOC));
  await ev(`${W}.remove("/t/trashme.tex").then(() => 1)`);
  await go(base + "?tex=" + ftr + "&latex=1"); await sleep(1500);
  check(await ev(`document.querySelector(".tex-page")?.textContent.includes("This file isn't here any more (it's in the Trash).")`), "a fid only in Trash: Gone, in the Trash");
  // ---- gone: an unknown fid
  await go(base + "?tex=ffffffffffffffff&latex=1"); await sleep(1500);
  check(await ev(`document.querySelector(".tex-page")?.textContent.includes("This file isn't here any more.")`), "an unknown fid: Gone");
  check(errors.length === 0, "no page errors", errors);
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  ws.close(); chrome.kill(); server.kill();
  await sleep(300); rmSync(profile, { recursive: true, force: true });
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks}:\n  ${fails.join("\n  ")}` : `ok: the LaTeX editor's page, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
