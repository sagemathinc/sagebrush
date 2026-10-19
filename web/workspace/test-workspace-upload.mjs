// Upload's rule (design/workspace-files.md §3, web/workspace/upload.ts) on
// both pages, in headless Chromium against the built site: Upload never
// converts behind the person's back.  .ipynb, .board.json and .sbreplay
// become documents (the .sbreplay with its history), never written over
// another; anything else is kept as a data file; one file of a kind the page
// recognises is offered as what it can be, a converted copy made beside it
// and the original kept (declined: nothing made); the file browser's
// "Open as…" the same; the board page's Upload… and drops no longer replace
// the open board.  Files go through the real file chooser (CDP).
// SHOT_DIR=dir saves screenshots there.  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-workspace-upload.mjs
import { spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createGzip, gzipSync } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const shots = process.env.SHOT_DIR;
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ws-upload-"));
const dir = mkdtempSync(join(tmpdir(), "sb-ws-upload-files-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = []; const dialogs = []; const choosers = [];
// (a confirm accepted, or declined while acceptConfirm is false)
let acceptConfirm = true;
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params); send("Page.handleJavaScriptDialog", { accept: m.params.type === "confirm" ? acceptConfirm : true }); }
  if (m.method === "Page.fileChooserOpened") choosers.push(m.params);
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const go = async (url) => { await send("Page.navigate", { url }); await sleep(300); };
const shot = async (name) => {
  if (!shots) return;
  await sleep(400);
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(shots, name + ".png"), Buffer.from(r.data, "base64"));
};
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const W = "window.sagebrush?.workspace";
const NB = "#filemenu", BD = "[data-sbb=filemenu]";
const pick = (menu, item) => ev(`(() => { const b = document.querySelector(${JSON.stringify(menu)} + " [data-item=${item}]"); if (!b) throw new Error("no ${item}"); b.click(); return !b.disabled; })()`);
const nbRef = () => ev(`sagebrush.notebook.store?.id ?? null`);
const stat = (p) => ev(`${W}.stat(${JSON.stringify(p)}).then((e) => e ? { kind: e.kind, ref: e.ref ?? null, fid: e.fid } : null)`);
const file = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
// (File ▸ Upload…: the chooser it opens, given these files; its mode said)
async function upload(menu, paths) {
  const had = choosers.length;
  // (as a person's click: a file chooser opens only on one)
  await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(menu)} + " [data-item=upload]").click()`, userGesture: true });
  if (!(await (async () => { for (let i = 0; i < 100 && choosers.length === had; i++) await sleep(50); return choosers.length > had; })())) throw new Error("no file chooser opened");
  const c = choosers.at(-1);
  await send("DOM.setFileInputFiles", { files: paths, backendNodeId: c.backendNodeId });
  return c.mode;
}
// (files dropped on an element, as the page sees a drop: made in the page)
const drop = (selector, name, text) => ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)})); const t = document.querySelector(${JSON.stringify(selector)}); t.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true })); t.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); return 1; })()`);
const historyRows = (ref) => ev(`new Promise((ok, no) => { const r = indexedDB.open("sagebrush-history"); r.onsuccess = () => { const db = r.result, c = db.transaction("history").objectStore("history").count(IDBKeyRange.bound([${JSON.stringify(ref)}, ""], [${JSON.stringify(ref)}, "\\uffff"])); c.onsuccess = () => { db.close(); ok(c.result); }; c.onerror = () => no(c.error); }; r.onerror = () => no(r.error); })`);

const ipynb = (code) => JSON.stringify({ cells: [{ cell_type: "code", source: code, metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 });
const boardJson = (title) => JSON.stringify({ format: "sagebrush-board", version: 1, title, nodes: [{ id: "n", text: title }] });

try {
  for (const m of ["Page.enable", "Runtime.enable", "DOM.enable"]) await send(m);
  await send("Page.setInterceptFileChooserDialog", { enabled: true });
  await go(base);
  await until(`!!${W} && !!sagebrush.notebook.store?.id && !!document.querySelector("#filemenu [data-item=open]:not([disabled])")`, 60000);
  const welcome = await nbRef();
  // a .sbreplay of this notebook, with its history (an edit made first, and kept)
  await ev(`(() => { sagebrush.notebook.addCell("x = 6 * 7"); sagebrush.notebook.flush(); return 1; })()`);
  for (let i = 0; i < 100 && !((await historyRows(welcome)) > 0); i++) await sleep(100);
  const bundle = await ev(`sagebrush.bundle().then((b) => b instanceof Blob ? b.arrayBuffer() : b).then((b) => Array.from(new Uint8Array(b)))`);
  writeFileSync(join(dir, "e.sbreplay"), Buffer.from(bundle));
  // several files at once: documents become documents; anything else, data files; nothing converted, nothing asked
  const mode = await upload(NB, [file("a.ipynb", ipynb("1 + 1")), file("b.board.json", boardJson("B")), file("c.py", "# %%\nprint(3)\n"), file("d.csv", "x,y\n1,2\n"), join(dir, "e.sbreplay"), file("bad.board.json", JSON.stringify({ nodes: "not a list" }))]);
  check(mode === "selectMultiple", "File ▸ Upload… takes several files: " + mode);
  check(await until(`${W}.stat("/d.csv").then((e) => !!e)`), "the upload is done");
  const got = Object.fromEntries(await Promise.all(["/a.ipynb", "/b.board.json", "/c.py", "/d.csv", "/e.ipynb", "/c.ipynb", "/bad.board.json"].map(async (p) => [p, await stat(p)])));
  check(got["/a.ipynb"]?.kind === "notebook" && got["/b.board.json"]?.kind === "board" && got["/e.ipynb"]?.kind === "notebook", ".ipynb, .board.json and .sbreplay become documents: " + JSON.stringify(got));
  check(got["/c.py"]?.kind === "file" && got["/d.csv"]?.kind === "file" && !got["/c.ipynb"], "…a .py and a .csv are kept as data files, the .py not converted");
  check(!got["/bad.board.json"] && (await ev(`document.querySelector("#status")?.textContent ?? ""`)).includes("bad.board.json"), "…one that isn't a board is refused, and said");
  check((await historyRows(got["/e.ipynb"]?.ref)) > 0, "…the .sbreplay keeps its history");
  check(!dialogs.some((d) => d.type === "confirm") && (await nbRef()) === welcome, "…several files: nothing asked, nothing opened");
  check((await ev(`${W}.read("/a.ipynb").then((r) => r.content.cells.map((c) => c.code).join())`)) === "1 + 1", "…the notebook as uploaded");
  // one .py: offered as a notebook; a converted copy beside it, opened; the .py kept
  await upload(NB, [file("s.py", "# %%\nprint('s')\n")]);
  check(await until(`${W}.stat("/s.ipynb").then((e) => !!e)`), "one .py, accepted: a converted copy, s.ipynb, made beside it");
  check(dialogs.some((d) => d.type === "confirm" && /Open "s\.py" as a notebook\?/.test(d.message) && /stays as it is/.test(d.message)), "…asked first, saying the original stays");
  check((await stat("/s.py"))?.kind === "file", "…s.py kept as it is");
  check(await until(`sagebrush.notebook.store?.id === ${JSON.stringify((await stat("/s.ipynb"))?.ref)}`), "…the copy opened");
  // declined: nothing made, nothing opened
  acceptConfirm = false;
  const before = await nbRef();
  await upload(NB, [file("t.py", "print('t')\n")]);
  check(await until(`${W}.stat("/t.py").then((e) => !!e)`), "declined: t.py kept");
  await sleep(500);
  check(!(await stat("/t.ipynb")) && (await nbRef()) === before, "…no copy made, nothing opened");
  acceptConfirm = true;
  // one .ipynb again: a document of its own, under a free name, opened; the first untouched
  await upload(NB, [file("a.ipynb", ipynb("2 + 2"))]);
  check(await until(`${W}.stat("/a (2).ipynb").then((e) => !!e)`), "the same name again: a (2).ipynb, never written over");
  check((await ev(`${W}.read("/a.ipynb").then((r) => r.content.cells.map((c) => c.code).join())`)) === "1 + 1", "…a.ipynb untouched");
  check(await until(`sagebrush.notebook.store?.id === ${JSON.stringify((await stat("/a (2).ipynb"))?.ref)}`), "…one document made: opened");
  // several files, one a board with code and one refused: nothing opened, nothing run, the refusal said (astra's CORR-4B3-1)
  const stay = await nbRef();
  const runBoard = (title) => JSON.stringify({ format: "sagebrush-board", version: 1, title, nodes: [{ id: "c", code: "print('RAN_' + 'MARKER')" }] });
  await upload(NB, [file("run.board.json", runBoard("Run")), file("bad.ipynb", "{ not json")]);
  check(await until(`${W}.stat("/run.board.json").then((e) => e?.kind === "board")`), "two files, a board and a bad notebook: the board kept");
  await sleep(800);
  const toast = `document.querySelector(".sbfiles .ftoast")?.textContent ?? ""`;
  check((await nbRef()) === stay && !(await ev(`location.pathname`)).startsWith("/board") && (await until(`(${toast}).includes("bad.ipynb")`)), "…nothing opened, and the refusal of bad.ipynb said: " + JSON.stringify([(await nbRef()) === stay, await ev(`location.pathname`), await ev(toast)]));
  await sleep(9000);
  check((await ev(toast)).includes("bad.ipynb"), "…and still said after the toast's usual 8 seconds (until closed)");
  // the limits: a notebook over 64 MiB refused before it is read; a .sbreplay that unpacks too far, or holds too long a history, refused before anything of it is kept (daybreak2's LIMIT-4B3-1/2)
  writeFileSync(join(dir, "huge.ipynb"), Buffer.alloc(65 * 2 ** 20, 32));
  await upload(NB, [join(dir, "huge.ipynb")]);
  check(await until(`(document.querySelector("#status")?.textContent ?? "").includes("huge.ipynb (over 64 MB)")`) && !(await stat("/huge.ipynb")), "a notebook over 64 MiB: refused before it is read");
  await pipeline(Readable.from((function* () { const z = Buffer.alloc(2 ** 20); for (let i = 0; i < 300; i++) yield z; })()), createGzip(), createWriteStream(join(dir, "bomb.sbreplay")));
  const tb = Date.now();
  await upload(NB, [join(dir, "bomb.sbreplay")]);
  check(await until(`(document.querySelector("#status")?.textContent ?? "").includes("bomb.sbreplay (a notebook with history is at most 256 MiB unpacked")`, 60000) && !(await stat("/bomb.ipynb")), `a .sbreplay that unpacks to 300 MiB: refused as it unpacks (${Date.now() - tb} ms)`);
  writeFileSync(join(dir, "long.sbreplay"), gzipSync(JSON.stringify({ format: "sagebrush-notebook-history", version: 1, notebook: { cells: [] }, history: Array.from({ length: 200_001 }, (_, i) => ({ time: "t" + i })), blobs: {} })));
  await upload(NB, [join(dir, "long.sbreplay")]);
  check(await until(`(document.querySelector("#status")?.textContent ?? "").includes("at most 200000 changes")`) && !(await stat("/long.ipynb")), "a .sbreplay with more than 200,000 changes: refused, nothing kept");
  // a file dropped on the page: the same rule
  await drop("body", "dropped.ipynb", ipynb("3 + 3"));
  check(await until(`${W}.stat("/dropped.ipynb").then((e) => e?.kind === "notebook")`), "a dropped .ipynb becomes a document (not a data file)");
  // the file browser: Open as a notebook, on a .py it recognises
  await ev(`(() => { if (document.querySelector("#wssidebar")?.hidden !== false) document.querySelector("#wsfilesbtn").click(); return 1; })()`);
  await until(`!!document.querySelector('.frow[data-path="/c.py"]')`);
  await ev(`(() => { const r = document.querySelector('.frow[data-path="/c.py"]'); r.querySelector("button.more").click(); return 1; })()`);
  const items = await ev(`[...document.querySelectorAll(".sbfmenu button")].map((b) => b.textContent)`);
  check(items?.[0] === "Open as a notebook", "the file browser offers a .py as a notebook: " + JSON.stringify(items));
  await shot("browser-open-as-notebook");
  await ev(`[...document.querySelectorAll(".sbfmenu button")].find((b) => b.textContent === "Open as a notebook").click()`);
  check(await until(`${W}.stat("/c.ipynb").then((e) => !!e)`) && (await stat("/c.py"))?.kind === "file", "…a converted copy, c.ipynb, beside it; c.py kept");
  // a recognised board file from the notebook page: made on the board page, opened there
  await upload(NB, [file("f.mmd", "graph TD\n  A --> B\n")]);
  check(await until(`location.pathname.startsWith("/board") && /doc=local:/.test(location.search) && !!window.sagebrush?.board?.snapshot()?.doc`, 60000), "one .mmd from the notebook page, accepted: opened as a board, on the board page");
  check(await until(`${W}.stat("/f.board.json").then((e) => e?.kind === "board")`) && (await stat("/f.mmd"))?.kind === "file", "…f.board.json beside it, f.mmd kept");
  check(await ev(`window.sagebrush.board.snapshot().doc.nodes.length === 2 && !/openas/.test(location.search)`), "…the flowchart's two items; the address the board's own");
  // the board page: Upload… keeps, never replaces the open board
  await go(base + "board/?new=python");
  await until(`!!window.sagebrush?.board?.snapshot()?.doc && !!document.querySelector("${BD} [data-item=upload]:not([disabled])")`, 60000);
  const boardHere = await ev(`location.search.match(/local:([0-9a-f]{12})/)[1]`);
  const bmode = await upload(BD, [file("g.md", "# G\n\n```mermaid\ngraph LR\n  X --> Y\n```\n")]);
  check(bmode === "selectMultiple", "the board's Upload… takes several files, of any kind: " + bmode);
  check(await until(`${W}.stat("/g.board.json").then((e) => e?.kind === "board")`), "one .md on the board page, accepted: a converted copy, g.board.json");
  check(dialogs.some((d) => d.type === "confirm" && /Open "g\.md" as a board\?/.test(d.message)), "…asked first");
  check(await until(`!location.search.includes(${JSON.stringify(boardHere)}) && window.sagebrush?.board?.snapshot()?.doc?.title === "G"`, 30000), "…the copy opened");
  check((await ev(`${W}.list("/").then((l) => l.find((e) => e.ref === ${JSON.stringify(boardHere)})).then((e) => ${W}.read(e.path)).then((r) => r.content.nodes.length)`)) === 0, "…the board that was open untouched");
  // a JSON Canvas: its copy says, when it opens, that it was converted
  await upload(BD, [file("k.canvas", JSON.stringify({ nodes: [{ id: "c1", type: "text", text: "Canvas note", x: 0, y: 0, width: 200, height: 60 }], edges: [] }))]);
  check(await until(`${W}.stat("/k.board.json").then((e) => e?.kind === "board")`) && (await stat("/k.canvas"))?.kind === "file", "one .canvas, accepted: k.board.json beside it, k.canvas kept");
  check(await until(`/local:/.test(location.search) && /Converted from a JSON Canvas/.test(document.querySelector("[data-sbb=say]")?.textContent ?? "")`, 30000), "…opened, saying it was converted (what the conversion said, carried to the copy)");
  await shot("board-converted-copy");
  // declined on the board page: kept, nothing converted, the board as it was
  acceptConfirm = false;
  const here2 = await ev(`location.search`);
  await upload(BD, [file("i.mmd", "graph TD\n  P --> Q\n")]);
  check(await until(`${W}.stat("/i.mmd").then((e) => !!e)`), "declined on the board page: i.mmd kept");
  await sleep(500);
  check(!(await stat("/i.board.json")) && (await ev(`location.search`)) === here2, "…nothing made, the open board as it was");
  acceptConfirm = true;
  // a .board.json dropped on the board: a board of its own, opened
  await drop("#board", "h.board.json", boardJson("H"));
  check(await until(`${W}.stat("/h.board.json").then((e) => e?.kind === "board")`), "a .board.json dropped on the board: a document of its own");
  check(await until(`window.sagebrush?.board?.snapshot()?.doc?.title === "H"`, 30000), "…opened, not poured into the open board");
  // a single board brought in: opened with its code paused until the person runs it (@sagebrush's interim, astra's CORR-4B3-1)
  await go(base);
  await until(`!!${W} && !!sagebrush.notebook.store?.id`, 60000);
  await upload(NB, [file("runs.board.json", runBoard("Runs"))]);
  check(await until(`location.pathname.startsWith("/board") && window.sagebrush?.board?.snapshot()?.doc?.title === "Runs"`, 60000), "one board uploaded from the notebook page: opened");
  check(await until(`document.querySelector("[data-sbb=runpaused]")?.hidden === false`), "…with \"Run this board's code\" shown");
  await sleep(3000);
  check(!(await ev(`document.body.innerText.includes("RAN_MARKER")`)), "…its code not run by itself");
  await ev(`(() => { document.querySelector("[data-sbb=runpaused]").click(); return 1; })()`);
  check(await until(`document.body.innerText.includes("RAN_MARKER")`, 90000) && (await ev(`document.querySelector("[data-sbb=runpaused]").hidden`)), "…run when the person presses it");
  // an in-place edit under way when a file is dropped: kept before the page goes (astra's CORR-4B3-2)
  const edited = await ev(`${W}.create("/Edited.board.json", { content: { title: "Edited board", nodes: [{ id: "a", title: "Before", text: "body", x: 0, y: 0 }] } }).then((e) => e.ref)`);
  await go(base + "board/?doc=local:" + edited);
  await until(`window.sagebrush?.board?.snapshot()?.doc?.title === "Edited board"`, 60000);
  await ev(`(() => { sagebrush.board.editing(true); const it = board.item("a"); board.setCamera({ x: it.x - 200, y: it.y - 200, z: 1 }); board.render(); return 1; })()`);
  await sleep(300);
  const rect = await ev(`board.clientRect("a")`);
  const mouse = (type, clickCount = 1) => send("Input.dispatchMouseEvent", { type, x: rect.left + 40, y: rect.top + 14, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount });
  await mouse("mousePressed"); await mouse("mouseReleased"); await mouse("mousePressed", 2); await mouse("mouseReleased", 2);
  check(await until(`!!document.querySelector(".board-editing .be-title")`, 5000), "(an item's title being written in place)");
  await ev(`(() => { const t = document.querySelector(".board-editing .be-title"); t.value = "WRITTEN_BEFORE_THE_DROP"; t.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await drop(".board-editing", "Other.board.json", boardJson("Other"));
  check(await until(`window.sagebrush?.board?.snapshot()?.doc?.title === "Other"`, 30000), "a board dropped while an item is written: opened");
  check(await until(`${W}.read("/Edited.board.json").then((r) => r.content.nodes[0].title === "WRITTEN_BEFORE_THE_DROP")`), "…what was being written kept first");
  // (an item's title written in place, as a person double-clicks it and types: the board at this ref)
  const writeInPlace = async (ref, text) => {
    await ev(`(() => { sagebrush.board.editing(true); const it = board.item("a"); board.setCamera({ x: it.x - 200, y: it.y - 200, z: 1 }); board.render(); return 1; })()`);
    await sleep(300);
    const r = await ev(`board.clientRect("a")`);
    const m = (type, clickCount = 1) => send("Input.dispatchMouseEvent", { type, x: r.left + 40, y: r.top + 14, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount });
    await m("mousePressed"); await m("mouseReleased"); await m("mousePressed", 2); await m("mouseReleased", 2);
    if (!(await until(`!!document.querySelector(".board-editing .be-title")`, 5000))) return false;
    await ev(`(() => { const t = document.querySelector(".board-editing .be-title"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
    return true;
  };
  const freshBoard = async (path) => {
    const ref = await ev(`${W}.create(${JSON.stringify(path)}, { content: { title: "Edited board", nodes: [{ id: "a", title: "Before", text: "body", x: 0, y: 0 }] } }).then((e) => e.ref)`);
    await go(base + "board/?doc=local:" + ref);
    await until(`window.sagebrush?.board?.snapshot()?.doc?.title === "Edited board"`, 60000);
    return ref;
  };
  // the same, the file dropped on the sidebar's file tree: every way of leaving the board keeps it (astra's CORR-BCD-1)
  await freshBoard("/Sidebar.board.json");
  await ev(`(() => { const b = document.querySelector("[data-sbb=files]"); if (b?.getAttribute("aria-pressed") !== "true") b?.click(); return 1; })()`);
  check(await until(`!!document.querySelector(".ftree")`, 5000), "(the sidebar's file tree shown)");
  check(await writeInPlace(null, "WRITTEN_BEFORE_THE_SIDEBAR_DROP"), "(an item's title being written in place, the sidebar open)");
  await drop(".ftree", "Fourth.board.json", boardJson("Fourth"));
  check(await until(`window.sagebrush?.board?.snapshot()?.doc?.title === "Fourth"`, 30000), "a board dropped on the sidebar while an item is written: opened");
  check(await until(`${W}.read("/Sidebar.board.json").then((r) => r.content.nodes[0].title === "WRITTEN_BEFORE_THE_SIDEBAR_DROP")`), "…what was being written kept first");
  // typing while the dropped file is still being read: kept too, as the page goes (astra's CORR-BCD-1)
  await freshBoard("/Typed.board.json");
  await ev(`(() => { window.__gate = new Promise((r) => (window.__open = r)); const ab = Blob.prototype.arrayBuffer, tx = Blob.prototype.text; Blob.prototype.arrayBuffer = async function () { await window.__gate; return ab.call(this); }; Blob.prototype.text = async function () { await window.__gate; return tx.call(this); }; return 1; })()`);
  await drop("#board", "Fifth.board.json", boardJson("Fifth"));
  check(await writeInPlace(null, "TYPED_WHILE_UPLOADING"), "(an item's title written in place while the drop is read)");
  await ev(`(() => { window.__open(); return 1; })()`);
  check(await until(`window.sagebrush?.board?.snapshot()?.doc?.title === "Fifth"`, 30000), "a board dropped, then an item written while it is read: opened");
  check(await until(`${W}.read("/Typed.board.json").then((r) => r.content.nodes[0].title === "TYPED_WHILE_UPLOADING")`), "…what was written meanwhile kept first");
  // the same, the board's own save refused (its storage full): it stays open, saying so, and what was written is not left behind
  await ev(`(() => { sagebrush.board.editing(true); return 1; })()`);
  await sleep(300);
  await ev(`(() => { const put = IDBObjectStore.prototype.put; window.__put = put; IDBObjectStore.prototype.put = function (v, k) { if (this.name === "boards" && JSON.stringify(v).includes("REFUSED_SAVE")) throw new DOMException("the disk is full", "QuotaExceededError"); return put.call(this, v, k); }; return 1; })()`);
  const here = await ev(`location.search`), seenDialogs = dialogs.length;
  await ev(`sagebrush.board.edit((d) => { d.title = "REFUSED_SAVE"; }).then(() => 1)`);
  await sleep(500);
  await drop("#board", "Third.board.json", boardJson("Third"));
  check(await until(`${W}.stat("/Third.board.json").then((e) => !!e)`), "(the dropped board made)");
  await sleep(1500);
  check((await ev(`location.search`)) === here && dialogs.slice(seenDialogs).some((d) => d.type === "alert" && /stays open/.test(d.message)), "a drop when this board's save is refused: it stays open, saying so");
  await ev(`(() => { IDBObjectStore.prototype.put = window.__put; return 1; })()`);
  // ?openas= for a file replaced meanwhile (another fid): nothing made, said
  await go(base + "board/?openas=" + encodeURIComponent("/f.mmd") + "&fid=not-this-one");
  await until(`!!window.sagebrush?.board?.snapshot()?.doc`, 60000);
  check(await until(`document.body.innerText.includes("couldn't be opened as a board")`), "Open as a board, the file replaced meanwhile: said");
  check(!(await stat("/f (2).board.json")), "…nothing made");
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  for (const e of errors) fails.push("page error: " + e);
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(dir, { recursive: true, force: true });
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: Upload's rule, ${checks} checks`);
process.exit(0);
