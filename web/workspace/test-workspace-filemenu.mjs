// ci: web-runner order=500 chrome
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
// (File ▸ Examples…, sim run 12: the gallery's catalog as a site with the gallery serves it (this test's server has
// none): one notebook and one board, as each page's panel opens on its own kind)
const STUB_CATALOG = `(() => { const f0 = window.__sbFetch0 ??= window.fetch; window.fetch = (u, o) => new URL(String(u?.url ?? u), location.href).pathname === "/examples/index.json" ? Promise.resolve(new Response(JSON.stringify({ examples: [{ id: "notebook/stub", kind: "notebook", title: "Stub notebook", summary: "" }, { id: "board/stub", kind: "board", title: "Stub board", summary: "" }] }), { headers: { "content-type": "application/json" } })) : f0(u, o); return 1; })()`;
const UNSTUB = `(() => { if (window.__sbFetch0) window.fetch = window.__sbFetch0; return 1; })()`;
// (the panel open on this page's own kind first: its example listed, the other kind's not)
const galleryShown = (own, other) => `!!document.querySelector("dialog.sb-examples[open]") && (() => { const t = [...document.querySelectorAll("dialog.sb-examples [role=option]")].map((b) => b.textContent); return t.some((x) => x.includes(${JSON.stringify(own)})) && !t.some((x) => x.includes(${JSON.stringify(other)})); })()`;
const closeGallery = `(() => { [...document.querySelectorAll("dialog.sb-examples button")].find((b) => b.textContent === "Close")?.click(); return 1; })()`;
const labels = (menu) => ev(`[...document.querySelector(${JSON.stringify(menu)}).querySelectorAll("button")].map((b) => b.dataset.group ? b.textContent.replace(/ [▸▾]$/, "") : b.dataset.item ? b.firstChild.textContent : null).filter(Boolean)`);
const pick = (menu, item) => ev(`(() => { const b = document.querySelector(${JSON.stringify(menu)} + " [data-item=${item}]"); if (!b) throw new Error("no ${item}"); b.click(); return !b.disabled; })()`);
const key = (k, mods) => ev(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, ctrlKey: true, altKey: ${!!mods?.alt}, bubbles: true, cancelable: true })); return 1; })()`);
const nbRef = () => ev(`sagebrush.notebook.store?.id ?? null`);
// (Export all started from somewhere: the Storage panel open, its export going or ready (no save picker: the export's
// test hook); then stopped and the panel closed, so that nothing holds the export's lock afterwards)
const exportStarted = () => until(`!!document.querySelector(".sbfprev") && [...document.querySelectorAll(".sbfprev button")].some((b) => /^(Cancel|Save…|Export again)$/.test(b.textContent))`, 30000);
const closeStorage = async () => {
  for (let i = 0; i < 20 && (await ev(`!!document.querySelector(".sbfprev")`)); i++) {
    await ev(`(() => { const bs = [...document.querySelectorAll(".sbfprev button")]; (bs.find((b) => b.textContent === "Cancel") ?? bs.find((b) => b.textContent === "Close") ?? bs.find((b) => b.getAttribute("aria-label") === "Close"))?.click(); return 1; })()`);
    await sleep(300);
  }
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await go(base);
  await until(`!!${W} && !!document.querySelector("#filemenu [data-item=open]:not([disabled])")`, 60000);
  // the same items in the same order, on both pages
  const nbShape = await shape(NB), nbLabels = await labels(NB);
  check(JSON.stringify(nbShape) === JSON.stringify(["new▸[newNotebook,newBoard,newFolder,fromExample]", "open", "examples", "recent▸[]", "upload", "-", "saveCopy", "rename", "download▸[.ipynb,.py,marimo (.py),with its files (.zip),with history (.sbreplay),Everything (.zip)…]", "print", "share", "-", "delete"]), "the notebook page's File menu: " + JSON.stringify(nbShape));
  await ev(`(() => { document.querySelector("#filebtn").click(); document.querySelector("#filemenu [data-group=new]").click(); return 1; })()`);
  check(await ev(`!document.querySelector("#filemenu").hidden && !document.querySelector("#filemenu [data-group=new]").nextElementSibling.hidden`), "New ▸ opens in place, the menu staying open");
  check(await ev(`document.querySelector("#filemenu [data-group=download]").nextElementSibling.getBoundingClientRect().height === 0`), "…a group not opened shows nothing");
  await shot("notebook-file-menu");
  // File ▸ Examples…: New ▸ From an example…, at the top. A site without the gallery: this page's own list, as before
  await ev(`(() => { document.querySelector("#filemenu [data-item=examples]").click(); return 1; })()`);
  check(await until(`!!document.querySelector("#exdlg[open]")`), "File ▸ Examples… on a site without the gallery: the page's own list");
  await ev(`(() => { document.querySelector("#exdlg").close(); return 1; })()`);
  // (a site with the gallery: its panel, for Examples… and From an example… alike)
  await ev(STUB_CATALOG);
  await ev(`(() => { document.querySelector("#filemenu [data-item=examples]").click(); return 1; })()`);
  check(await until(galleryShown("Stub notebook", "Stub board")), "File ▸ Examples…: the gallery's panel, on notebooks first");
  await ev(closeGallery);
  await until(`!document.querySelector("dialog.sb-examples")`);
  await ev(`(() => { document.querySelector("#filemenu [data-item=fromExample]").click(); return 1; })()`);
  check(await until(galleryShown("Stub notebook", "Stub board")) && !(await ev(`!!document.querySelector("#exdlg[open]")`)), "New ▸ From an example…: the same panel, not the old list");
  await ev(closeGallery);
  await ev(UNSTUB);
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
  // (Export all where a person looks for it: sim run 11, X05's agent never found the Storage panel's button, and
  // zipped the files itself)
  {
    await ev(`(() => { window.__SB_EXPORT_TEST__ = { noPicker: true }; return 1; })()`);
    await ev(`(() => { document.querySelector("#filebtn").click(); document.querySelector("#filemenu [data-group=download]").click(); document.querySelector('#filemenu [data-f="allzip"]')?.click(); return 1; })()`);
    check(await exportStarted(), "File ▸ Download ▸ Everything (.zip)…: the Storage panel, its export started");
    await closeStorage();
    await ev(`(() => { document.querySelector("#wssidebar button[title='Trash, Storage']").click(); [...document.querySelectorAll(".sbfmenu button")].find((b) => b.textContent === "Download everything (.zip)…")?.click(); return 1; })()`);
    check(await exportStarted(), "the Files ⋯ ▸ Download everything (.zip)…: the same");
    await closeStorage();
    // (a selection with no file in it: its Download offers the whole workspace instead)
    await until(`!!document.querySelector('#wssidebar .frow[data-sel][data-path="/From the menu"] .sel')`);
    await ev(`(() => { document.querySelector('#wssidebar .frow[data-sel][data-path="/From the menu"] .sel').click(); [...document.querySelectorAll("#wssidebar .fsel button")].find((b) => b.textContent === "Download")?.click(); return 1; })()`);
    const offered = await until(`[...document.querySelectorAll("#wssidebar .ftoast button")].some((b) => b.textContent === "Export all (.zip)")`, 5000);
    await ev(`(() => { [...document.querySelectorAll("#wssidebar .ftoast button")].find((b) => b.textContent === "Export all (.zip)")?.click(); return 1; })()`);
    check(offered && (await exportStarted()), "a selection's Download with a folder in it: its toast offers Export all (.zip), which starts it");
    await closeStorage();
    await ev(`(() => { [...document.querySelectorAll("#wssidebar .fsel button")].find((b) => b.textContent === "Clear")?.click(); return 1; })()`);
    // (a file and a folder: the file downloads, and the toast offers the whole workspace for what was skipped)
    await ev(`${W}.create("/dl one.txt", { content: "1" }).then(() => 1)`);
    const selRow = (p) => `#wssidebar .frow[data-sel][data-path=${JSON.stringify(p)}] .sel`;
    await until(`!!document.querySelector(${JSON.stringify(selRow("/dl one.txt"))}) && !!document.querySelector(${JSON.stringify(selRow("/From the menu"))})`);
    await ev(`(() => { document.querySelector(${JSON.stringify(selRow("/dl one.txt"))}).click(); document.querySelector(${JSON.stringify(selRow("/From the menu"))}).click(); [...document.querySelectorAll("#wssidebar .fsel button")].find((b) => b.textContent === "Download")?.click(); return 1; })()`);
    const mixed = await until(`[...document.querySelectorAll("#wssidebar .ftoast")].some((t) => /1 file downloaded \\(1 not a file/.test(t.textContent) && [...t.querySelectorAll("button")].some((b) => b.textContent === "Export all (.zip)"))`, 10000);
    await ev(`(() => { [...document.querySelectorAll("#wssidebar .ftoast button")].find((b) => b.textContent === "Export all (.zip)")?.click(); return 1; })()`);
    check(mixed && (await exportStarted()), "a selection's Download with a file and a folder: the file downloaded, the toast offers Export all (.zip), which starts it");
    await closeStorage();
    await ev(`(() => { [...document.querySelectorAll("#wssidebar .fsel button")].find((b) => b.textContent === "Clear")?.click(); return 1; })()`);
  }
  // (sim run 11, X05: a rename, and a move's Undo, in Open… happen: its host has no `renamed`, and an optional call
  // made with the rename as its argument never made the rename)
  {
    await ev(`${W}.create("/om one.txt", { content: "1" }).then(() => 1)`);
    await key("o");
    const row = (p) => `.sbfopen .frow[data-sel][data-path=${JSON.stringify(p)}]`;
    await until(`!!document.querySelector(${JSON.stringify(row("/From the menu"))}) && !!document.querySelector(${JSON.stringify(row("/om one.txt"))})`);
    await ev(`(() => { document.querySelector(${JSON.stringify(row("/From the menu"))} + " button[aria-label^='More']").click(); [...document.querySelectorAll(".sbfmenu button")].find((b) => b.textContent === "Rename").click(); return 1; })()`);
    await until(`!!document.querySelector(".sbfopen .frow input")`);
    await ev(`(() => { const i = document.querySelector(".sbfopen .frow input"); i.value = "Renamed in Open"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return 1; })()`);
    const renamed = await until(`${W}.stat("/Renamed in Open").then((a) => ${W}.stat("/From the menu").then((b) => a?.kind === "folder" && !b))`, 10000);
    check(renamed, "Open…: a folder renamed in the dialog is renamed, its old name gone");
    await until(`!!document.querySelector(${JSON.stringify(row("/Renamed in Open"))})`);
    // (a move by drag, then its Undo: both happen in the dialog too)
    const drag = await ev(`(() => {
      const f = document.querySelector(${JSON.stringify(row("/om one.txt"))}), t = document.querySelector(${JSON.stringify(row("/Renamed in Open"))});
      if (!f || !t) return false; // (no folder to drag onto: the rename above failed, and its check says so)
      const dt = new DataTransfer();
      f.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
      t.dispatchEvent(over);
      t.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      f.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
      return over.defaultPrevented;
    })()`);
    const moved = await until(`${W}.stat("/Renamed in Open/om one.txt").then((e) => !!e)`, 10000);
    await until(`[...document.querySelectorAll(".sbfopen .ftoast button")].some((b) => b.textContent === "Undo")`, 5000);
    await ev(`(() => { [...document.querySelectorAll(".sbfopen .ftoast button")].find((b) => b.textContent === "Undo")?.click(); return 1; })()`);
    const back = await until(`${W}.stat("/om one.txt").then((a) => ${W}.stat("/Renamed in Open/om one.txt").then((b) => !!a && !b))`, 10000);
    check(drag && moved && back, "Open…: a file dragged into a folder there moves, and its Undo moves it back: " + JSON.stringify({ drag, moved, back }));
    await ev(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1; })()`);
    await until(`!document.querySelector(".sbfopen")`);
  }
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
  check(bdShape[8]?.startsWith("download▸[.board.json,HTML (one file),JSON Canvas,Copy JSON,Everything (.zip)…]") && (await ev(`(() => { const b = document.querySelector("[data-sbb=filemenu] [data-item=share]"); return b.disabled && !b.hidden; })()`)), "…its own downloads; Share… shown, disabled (Sagebrush's board page: disabled, not hidden, design §3): " + JSON.stringify(bdShape));
  // (why Share… is disabled, said where it is: run 12, X01 clicked it and got nothing)
  check(await ev(`/isn't available yet.*HTML \\(one file\\)/.test(document.querySelector("[data-sbb=filemenu] [data-item=share]").title)`), "…its disabled Share… says why, and what to do instead (Download ▸ HTML)");
  // File ▸ Examples… on the board page: the page's own list here; the gallery's panel where the site has it
  await ev(`(() => { document.querySelector("[data-sbb=filemenu] [data-item=examples]").click(); return 1; })()`);
  check(await until(`!!document.querySelector("[data-sbb=exdlg][open]")`), "the board page's File ▸ Examples… on a site without the gallery: its own list");
  await ev(`(() => { document.querySelector("[data-sbb=exdlg]").close(); return 1; })()`);
  await ev(STUB_CATALOG);
  await ev(`(() => { document.querySelector("[data-sbb=filemenu] [data-item=examples]").click(); return 1; })()`);
  check(await until(galleryShown("Stub board", "Stub notebook")) && !(await ev(`!!document.querySelector("[data-sbb=exdlg][open]")`)), "the board page's File ▸ Examples…: the gallery's panel, on boards first");
  await ev(closeGallery);
  await ev(UNSTUB);
  check(await ev(`!!document.querySelector("[data-sbb=menu] [data-sbb=mermaid]") && !!document.querySelector("[data-sbb=menu] [data-sbb=revert]")`), "Import Mermaid… and Revert are in the board's ⋯");
  await ev(`(() => { document.querySelector("[data-sbb=filebtn]").click(); document.querySelector("[data-sbb=filemenu] [data-group=new]").click(); return 1; })()`);
  check(await ev(`document.querySelector("[data-sbb=filemenu] [data-group=download]").nextElementSibling.getBoundingClientRect().height === 0 && document.querySelector("[data-sbb=filemenu] [data-item=newBoard]").getBoundingClientRect().top > document.querySelector("[data-sbb=filemenu] [data-item=newNotebook]").getBoundingClientRect().bottom - 1`), "the board page: a group not opened shows nothing; an open group's items one per line");
  await shot("board-file-menu");
  await ev(`(() => { document.querySelector("[data-sbb=filebtn]").click(); return 1; })()`);
  // (Download ▸ Everything (.zip)… on the board page: the Files sidebar's export, the sidebar shown)
  await ev(`(() => { window.__SB_EXPORT_TEST__ = { noPicker: true }; document.querySelector("[data-sbb=filebtn]").click(); document.querySelector("[data-sbb=filemenu] [data-group=download]").click(); document.querySelector("[data-sbb=filemenu] [data-sbb=allzip]")?.click(); return 1; })()`);
  check(await exportStarted(), "the board page's File ▸ Download ▸ Everything (.zip)…: the Storage panel, its export started");
  await closeStorage();
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
  // (no MATLAB notebook in New ▸, on either page: H10; the language is the notebook's own choice)
  await until(`!!document.querySelector("#filemenu [data-item=newNotebook]")`, 30000);
  check(await ev(`!document.querySelector("#filemenu [data-item=newMatlab]")`), "H10: no New ▸ MATLAB notebook on the notebook page");
  await go(base + "board/?new=python");
  await until(`!!window.sagebrush?.board?.snapshot() && !!document.querySelector("[data-sbb=filemenu] [data-item=newNotebook]")`, 60000);
  check(await ev(`!document.querySelector("[data-sbb=filemenu] [data-item=newMatlab]") && !document.querySelector("[data-sbb=newmatlab]")`), "H10: no New ▸ MATLAB notebook on the board page");
  // File ▸ Examples… on a page with no workspace (?workspace=0, a localhost-only switch): the gallery would have
  // nowhere to copy into, so even where the site has it, the page's own list opens
  await go(base + "board/?workspace=0");
  await until(`!!window.sagebrush?.board?.snapshot() && !!document.querySelector("[data-sbb=filemenu] [data-item=examples]:not([disabled])")`, 60000);
  await ev(STUB_CATALOG);
  await ev(`(() => { document.querySelector("[data-sbb=filemenu] [data-item=examples]").click(); return 1; })()`);
  check(await until(`!!document.querySelector("[data-sbb=exdlg][open]")`) && !(await ev(`!!document.querySelector("dialog.sb-examples")`)), "a page with no workspace: File ▸ Examples… opens its own list, not the gallery (nowhere to copy into)");
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
