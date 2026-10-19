// The one File menu (web/workspace/filemenu.ts, design/workspace-files.md
// §3) on both pages, in headless Chromium against the built site: the same
// items in the same order; New ▸ (Notebook, Board, Folder, From an
// example…), Open… (the file browser as a dialog), Recent ▸ (both kinds,
// both pages), Save a copy… (asking the name), Rename…, Download ▸,
// Delete (to Trash, another document opened), the keys Ctrl+Alt+N and
// Ctrl+O; the board's Import Mermaid… and Revert in its ⋯.
// SHOT_DIR=dir saves screenshots there.  Serve web/dist first
// (python3 web/serve.py 8765), then
//   node web/workspace/test-workspace-filemenu.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const shots = process.env.SHOT_DIR;
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ws-filemenu-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = []; const dialogs = [];
// (a prompt answered with promptText; a confirm, accepted)
let promptText = "";
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params); send("Page.handleJavaScriptDialog", { accept: true, ...(m.params.type === "prompt" ? { promptText } : {}) }); }
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
// (the notebook page's menu: #filemenu; the board page's: [data-sbb=filemenu])
const NB = "#filemenu", BD = "[data-sbb=filemenu]";
const shape = (menu) => ev(`[...document.querySelector(${JSON.stringify(menu)}).children].map((x) => x.tagName === "HR" ? "-" : x.dataset.group ? x.dataset.group + "▸[" + [...x.nextElementSibling.querySelectorAll("button")].map((b) => b.dataset.item ?? b.textContent).join(",") + "]" : x.dataset.item ?? "").filter(Boolean)`);
const labels = (menu) => ev(`[...document.querySelector(${JSON.stringify(menu)}).querySelectorAll("button")].map((b) => b.dataset.group ? b.textContent.replace(/ [▸▾]$/, "") : b.dataset.item ? b.firstChild.textContent : null).filter(Boolean)`);
const pick = (menu, item) => ev(`(() => { const b = document.querySelector(${JSON.stringify(menu)} + " [data-item=${item}]"); if (!b) throw new Error("no ${item}"); b.click(); return !b.disabled; })()`);
const key = (k, mods) => ev(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, ctrlKey: true, altKey: ${!!mods?.alt}, bubbles: true, cancelable: true })); return 1; })()`);
const nbRef = () => ev(`sagebrush.notebook.store?.id ?? null`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await go(base);
  await until(`!!${W} && !!document.querySelector("#filemenu [data-item=open]:not([disabled])")`, 60000);
  // the same items in the same order, on both pages
  const nbShape = await shape(NB), nbLabels = await labels(NB);
  check(JSON.stringify(nbShape) === JSON.stringify(["new▸[newNotebook,newBoard,newFolder,fromExample]", "open", "recent▸[]", "upload", "-", "saveCopy", "rename", "download▸[.ipynb,.py,marimo (.py),with history (.sbreplay)]", "print", "share", "-", "delete"]), "the notebook page's File menu: " + JSON.stringify(nbShape));
  await ev(`(() => { document.querySelector("#filebtn").click(); document.querySelector("#filemenu [data-group=new]").click(); return 1; })()`);
  check(await ev(`!document.querySelector("#filemenu").hidden && !document.querySelector("#filemenu [data-group=new]").nextElementSibling.hidden`), "New ▸ opens in place, the menu staying open");
  check(await ev(`document.querySelector("#filemenu [data-group=download]").nextElementSibling.getBoundingClientRect().height === 0`), "…a group not opened shows nothing");
  await shot("notebook-file-menu");
  await ev(`(() => { document.querySelector("#filebtn").click(); return 1; })()`);
  // Ctrl+Alt+N: a new notebook
  const first = await nbRef();
  await key("n", { alt: true });
  check(await until(`sagebrush.notebook.store?.id && sagebrush.notebook.store.id !== ${JSON.stringify(first)}`), "Ctrl+Alt+N: a new notebook");
  const second = await nbRef();
  // Save a copy…: asks the name, opens the copy
  promptText = "Copied by name";
  await pick(NB, "saveCopy");
  check(await until(`document.querySelector("#nbname").value === "Copied by name" && sagebrush.notebook.store?.id !== ${JSON.stringify(second)}`), "Save a copy…: the name asked, the copy opened under it");
  check(dialogs.some((d) => d.type === "prompt" && /Save a copy/.test(d.message)), "…after asking for the name");
  check(await until(`${W}.stat("/Copied by name.ipynb").then((e) => !!e)`), "…listed as /Copied by name.ipynb");
  // Rename…: the title, to type in
  await pick(NB, "rename");
  check(await ev(`document.activeElement === document.querySelector("#nbname")`), "Rename…: the title, focused, to type the new name");
  // New ▸ Folder: asks the name
  promptText = "From the menu";
  await pick(NB, "newFolder");
  check(await until(`${W}.stat("/From the menu").then((e) => e?.kind === "folder")`), "New ▸ Folder: the folder made, named");
  // Recent ▸: the documents opened, newest first, this one not among them
  await ev(`(() => { document.querySelector("#filebtn").click(); document.querySelector("#filemenu [data-group=recent]").click(); return 1; })()`);
  check(await until(`document.querySelectorAll("#filemenu [data-recent]").length >= 2`), "Recent ▸ lists the documents opened lately: " + (await ev(`[...document.querySelectorAll("#filemenu [data-recent]")].map((b) => b.dataset.recent).join(", ")`)));
  const rec = await ev(`[...document.querySelectorAll("#filemenu [data-recent]")].map((b) => b.dataset.recent)`);
  check(!rec.includes("/Copied by name.ipynb"), "…not the one open: " + JSON.stringify(rec));
  await shot("notebook-recent");
  await ev(`(() => { document.querySelector("#filemenu [data-recent]").click(); return 1; })()`);
  check(await until(`sagebrush.notebook.store?.id === ${JSON.stringify(second)} || document.querySelector("#nbname").value !== "Copied by name"`), "…choosing one opens it");
  // Ctrl+O: Open…, the file browser as a dialog
  await key("o");
  check(await until(`!!document.querySelector(".sbfopen .sbfiles")`), "Ctrl+O: Open…, the file browser in a dialog");
  await shot("notebook-open-dialog");
  await until(`!!document.querySelector('.sbfopen .frow[data-path="/Copied by name.ipynb"]')`);
  await ev(`(() => { document.querySelector('.sbfopen .frow[data-path="/Copied by name.ipynb"]').click(); return 1; })()`);
  check(await until(`!document.querySelector(".sbfopen") && document.querySelector("#nbname").value === "Copied by name"`), "…choosing a notebook opens it, the dialog closing");
  await key("o");
  await until(`!!document.querySelector(".sbfopen")`);
  await ev(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1; })()`);
  check(await until(`!document.querySelector(".sbfopen")`), "…Esc closes it");
  // Delete: to Trash, after asking; another notebook opened
  const doomed = await nbRef();
  await pick(NB, "delete");
  check(await until(`${W}.stat("/Trash/Copied by name.ipynb").then((e) => !!e)`), "Delete: the notebook to Trash, after asking");
  check(dialogs.some((d) => d.type === "confirm" && /Move "Copied by name" to Trash/.test(d.message)), "…asked");
  check(await until(`sagebrush.notebook.store?.id && sagebrush.notebook.store.id !== ${JSON.stringify(doomed)}`), "…another notebook open");
  // Delete of a notebook the index doesn't list (the workspace on): listed,
  // then to Trash, its contents kept; never deleted for good (CORR-FD1-1)
  const lost = await nbRef();
  const unlisted = await ev(`new Promise((ok, no) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const db = r.result, tx = db.transaction("entries", "readwrite"), st = tx.objectStore("entries"), q = st.index("byRef").getKey(["notebook", ${JSON.stringify(lost)}]); q.onsuccess = () => { if (q.result != null) st.delete(q.result); }; tx.oncomplete = () => { db.close(); ok(q.result ?? null); }; tx.onerror = () => no(tx.error); }; r.onerror = () => no(r.error); })`);
  const asked = dialogs.length;
  await pick(NB, "delete");
  check(!!unlisted && await until(`${W}.list("/Trash").then((l) => l.some((e) => e.kind === "notebook" && e.ref === ${JSON.stringify(lost)}))`), "Delete of a notebook missing from the index: listed again, then to Trash: " + JSON.stringify(unlisted));
  check(await ev(`new Promise((ok, no) => { const r = indexedDB.open("sagebrush"); r.onsuccess = () => { const db = r.result, g = db.transaction("notebooks").objectStore("notebooks").get(${JSON.stringify(lost)}); g.onsuccess = () => { db.close(); ok(!!g.result); }; g.onerror = () => no(g.error); }; })`), "…its contents kept");
  check(dialogs.slice(asked).every((d) => !/from this browser/.test(d.message)) && dialogs.slice(asked).some((d) => /to Trash/.test(d.message)), "…asked to move it to Trash, never to delete it for good: " + JSON.stringify(dialogs.slice(asked).map((d) => d.message)));
  // the board page: the same menu; New ▸ Notebook from there
  await go(base + "board/?new=python");
  await until(`!!window.sagebrush?.board?.snapshot() && !!document.querySelector("[data-sbb=filemenu] [data-item=open]:not([disabled])")`, 60000);
  const bdLabels = await labels(BD), bdShape = await shape(BD);
  check(JSON.stringify(bdLabels) === JSON.stringify(nbLabels.filter((l) => l)), "the board page's File menu: the same items, in the same order: " + JSON.stringify([bdLabels, nbLabels]));
  check(bdShape[7]?.startsWith("download▸[.board.json,HTML (one file),JSON Canvas,Copy JSON]") && (await ev(`(() => { const b = document.querySelector("[data-sbb=filemenu] [data-item=share]"); return b.disabled && !b.hidden; })()`)), "…its own downloads; Share… shown, disabled (Sagebrush's board page: disabled, not hidden, design §3): " + JSON.stringify(bdShape));
  check(await ev(`!!document.querySelector("[data-sbb=menu] [data-sbb=mermaid]") && !!document.querySelector("[data-sbb=menu] [data-sbb=revert]")`), "Import Mermaid… and Revert are in the board's ⋯");
  await ev(`(() => { document.querySelector("[data-sbb=filebtn]").click(); document.querySelector("[data-sbb=filemenu] [data-group=new]").click(); return 1; })()`);
  check(await ev(`document.querySelector("[data-sbb=filemenu] [data-group=download]").nextElementSibling.getBoundingClientRect().height === 0 && document.querySelector("[data-sbb=filemenu] [data-item=newBoard]").getBoundingClientRect().top > document.querySelector("[data-sbb=filemenu] [data-item=newNotebook]").getBoundingClientRect().bottom - 1`), "the board page: a group not opened shows nothing; an open group's items one per line");
  await shot("board-file-menu");
  await ev(`(() => { document.querySelector("[data-sbb=filebtn]").click(); return 1; })()`);
  // Recent ▸ on the board page has the notebooks too
  await ev(`(() => { document.querySelector("[data-sbb=filebtn]").click(); document.querySelector("[data-sbb=filemenu] [data-group=recent]").click(); return 1; })()`);
  check(await until(`[...document.querySelectorAll("[data-sbb=filemenu] [data-recent]")].some((b) => b.dataset.recent.endsWith(".ipynb"))`), "the board page's Recent ▸ lists notebooks too");
  // (the notebook just put in Trash was opened here, and is in the record: not listed)
  check(await ev(`JSON.parse(localStorage.getItem("sagebrush-recent-opened")).some((o) => o.ref === ${JSON.stringify(doomed)})`) && (await ev(`[...document.querySelectorAll("[data-sbb=filemenu] [data-recent]")].every((b) => !b.dataset.recent.startsWith("/Trash/"))`)), "…not what is in Trash: " + (await ev(`[...document.querySelectorAll("[data-sbb=filemenu] [data-recent]")].map((b) => b.dataset.recent).join(", ")`)));
  await ev(`(() => { document.querySelector("[data-sbb=filebtn]").click(); return 1; })()`);
  // Delete the board: to Trash, a board opened in its place
  const boardRef = await ev(`location.search.match(/local:([0-9a-f]{12})/)[1]`);
  await ev(`window.sagebrush.board.edit((d) => { d.title = "Doomed board"; }).then(() => 1)`);
  await sleep(500);
  await pick(BD, "delete");
  check(await until(`${W}?.list("/Trash").then((l) => l.some((e) => e.kind === "board" && e.ref === ${JSON.stringify(boardRef)}))`, 30000), "the board page's Delete: the board to Trash");
  check(await until(`!location.search.includes(${JSON.stringify(boardRef)}) && !!window.sagebrush?.board?.snapshot()`, 30000), "…another board open in its place");
  // New ▸ Notebook from the board page: a notebook of the workspace, opened on the notebook page
  await pick(BD, "newNotebook");
  check(await until(`location.pathname === "/" && !!window.sagebrush?.notebook?.store?.id`, 60000), "New ▸ Notebook from the board page opens a new notebook");
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  for (const e of errors) fails.push("page error: " + e);
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: the one File menu, ${checks} checks`);
process.exit(0);
