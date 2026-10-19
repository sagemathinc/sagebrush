// The file browser (web/workspace/browser.ts, design/workspace-files.md §4)
// on both pages, in headless Chromium against the built site: the Files
// button and the sidebar (remembered across pages); New board, folder,
// renamed in place; files dropped on a folder uploaded into it; Move to
// Trash with Undo; Trash's Restore and Empty Trash; search; opening a board
// from the notebook page, and the open document marked; renaming the open
// notebook renames it on the page.  SHOT_DIR=dir saves screenshots there.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-workspace-browser.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const shots = process.env.SHOT_DIR;
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ws-browser-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true });
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
const S = "document.querySelector('#wssidebar')";
const rowSel = (p) => `#wssidebar .frow[data-path=${JSON.stringify(p)}]`;
const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error("no " + ${JSON.stringify(sel)}); e.click(); return 1; })()`);
const menu = (label) => ev(`(() => { const b = [...document.querySelectorAll(".sbfmenu button")].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) throw new Error("no menu item " + ${JSON.stringify(label)}); b.click(); return 1; })()`);
const typeInto = (text) => ev(`(() => { const i = document.querySelector("#wssidebar .frow input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return 1; })()`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  // a few documents to show
  await go(base);
  await until(`!!${W}`, 60000);
  await ev(`${W}.create("/Algebra/groups.ipynb", { mode: "sage" }).then(() => ${W}.create("/Sylow theorems.board.json")).then(() => ${W}.create("/data/primes.csv", { content: "2\\n3\\n5\\n" })).then(() => 1)`);
  await go(base);
  check(await until(`!!document.querySelector("#wsfilesbtn") && !document.querySelector("#wsfilesbtn").hidden`, 60000), "the notebook page has a Files button");
  if (await ev(`${S}.hidden`)) await click("#wsfilesbtn");
  check(await until(`!${S}.hidden && document.body.classList.contains("wsfiles")`), "Files shows the sidebar, the page beside it");
  check(await until(`!!document.querySelector(${JSON.stringify(rowSel("/Sylow theorems.board.json"))}) && !!document.querySelector(${JSON.stringify(rowSel("/Algebra"))})`), "the sidebar lists the workspace");
  check(await until(`!!document.querySelector("#wssidebar .frow.cur")`), "the open notebook is marked");
  await click(rowSel("/Algebra"));
  check(await until(`!!document.querySelector(${JSON.stringify(rowSel("/Algebra/groups.ipynb"))})`), "a folder opens");
  await shot("notebook-sidebar");
  // New board, named in place
  await click("#wssidebar .fh button[aria-label=New]");
  await menu("Board");
  check(await until(`!!document.querySelector("#wssidebar .frow input")`), "New board: named in place");
  await typeInto("Course plan");
  check(await until(`${W}.stat("/Course plan.board.json").then((e) => !!e)`), "…as Course plan.board.json");
  // a folder, and files dropped on it
  await click("#wssidebar .fh button[aria-label=New]");
  await menu("Folder");
  await until(`!!document.querySelector("#wssidebar .frow input")`);
  await typeInto("Data sets");
  check(await until(`${W}.stat("/Data sets").then((e) => e?.kind === "folder")`), "New folder, named in place");
  await until(`!!document.querySelector(${JSON.stringify(rowSel("/Data sets"))})`);
  await ev(`(() => { const r = document.querySelector(${JSON.stringify(rowSel("/Data sets"))}); const dt = new DataTransfer(); dt.items.add(new File(["a,b\\n1,2\\n"], "table.csv")); r.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true })); r.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); return 1; })()`);
  check(await until(`${W}.read("/Data sets/table.csv").then((r) => new TextDecoder().decode(r.content) === "a,b\\n1,2\\n").catch(() => false)`), "a file dropped on a folder is uploaded into it");
  // Move to Trash, Undo
  await until(`!!document.querySelector(${JSON.stringify(rowSel("/Course plan.board.json"))})`);
  await click(rowSel("/Course plan.board.json") + " .more");
  await menu("Move to Trash");
  check(await until(`${W}.stat("/Trash/Course plan.board.json").then((e) => !!e)`), "Move to Trash");
  check(await until(`!!document.querySelector("#wssidebar .ftoast button")`), "…offers Undo");
  await click("#wssidebar .ftoast button");
  check(await until(`${W}.stat("/Course plan.board.json").then((e) => !!e)`), "…which puts it back");
  // Trash: Restore and Empty
  await click(rowSel("/Course plan.board.json") + " .more");
  await menu("Move to Trash");
  await until(`${W}.stat("/Trash/Course plan.board.json").then((e) => !!e)`);
  await click("#wssidebar .ffoot button");
  check(await until(`!!document.querySelector(${JSON.stringify(rowSel("/Trash/Course plan.board.json"))})`), "Trash lists what was deleted");
  await shot("trash");
  await click("#wssidebar .ffoot button:last-child");
  check(await until(`${W}.list("/Trash").then((l) => l.length === 0)`), "Empty Trash (confirmed) empties it");
  await click("#wssidebar .ffoot button");
  // search
  await ev(`(() => { const i = document.querySelector("#wssidebar .fsearch"); i.value = "sylow"; i.dispatchEvent(new Event("input")); return 1; })()`);
  check(await until(`document.querySelectorAll("#wssidebar .frow").length === 1 && !!document.querySelector(${JSON.stringify(rowSel("/Sylow theorems.board.json"))})`), "search shows what matches");
  await ev(`(() => { const i = document.querySelector("#wssidebar .fsearch"); i.value = ""; i.dispatchEvent(new Event("input")); return 1; })()`);
  await until(`!!document.querySelector("#wssidebar .frow.cur")`);
  // renaming the open notebook renames it on the page
  const cur = await ev(`document.querySelector("#wssidebar .frow.cur")?.dataset.path`);
  await ev(`(() => { const r = document.querySelector("#wssidebar .frow.cur"); r.focus(); r.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })); return 1; })()`);
  await until(`!!document.querySelector("#wssidebar .frow input")`);
  await typeInto("Renamed here");
  check(await until(`document.querySelector("#nbname").value === "Renamed here"`), "renaming the open notebook renames it on the page: " + cur);
  check(await until(`${W}.stat("/Renamed here.ipynb").then((e) => !!e)`), "…and its file");
  // opening a board from the notebook page
  await click(rowSel("/Sylow theorems.board.json"));
  check(await until(`location.pathname.startsWith("/board/") && /doc=local:[0-9a-f]{12}/.test(location.search) && !!window.sagebrush?.board?.snapshot()`, 60000), "a board opens from the notebook page's sidebar");
  check(await until(`!!document.querySelector('[data-sbb="files"]') && !${S}.hidden`), "the board page has Files, and the sidebar is still open (remembered)");
  check(await until(`document.querySelector("#wssidebar .frow.cur")?.dataset.path === "/Sylow theorems.board.json"`), "…with the board marked");
  await shot("board-sidebar");

  // many entries (LIMIT-0B0-1, -2): put straight into the index, as a big workspace would hold them
  await ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const tx = r.result.transaction("entries", "readwrite"), st = tx.objectStore("entries"), t = Date.now();
    st.put({ path: "/many", kind: "folder", ref: null, created: t, updated: t });
    for (let i = 0; i < 2500; i++) { const f = "/many/f" + String(i).padStart(4, "0"); st.put({ path: f, kind: "folder", ref: null, created: t, updated: t }); for (let k = 0; k < 3; k++) st.put({ path: f + "/x" + k + ".txt", kind: "file", ref: f + "/x" + k + ".txt", size: 1, rev: 0, created: t, updated: t }); }
    st.put({ path: "/full", kind: "folder", ref: null, created: t, updated: t });
    for (let i = 0; i < 10000; i++) st.put({ path: "/full/e" + i, kind: "file", ref: "/full/e" + i, size: 1, rev: 0, created: t, updated: t });
    tx.oncomplete = () => { r.result.close(); ok(1); }; }; })`);
  await go(base);
  await until(`!!${W} && !${S}.hidden && !!document.querySelector(${JSON.stringify(rowSel("/many"))})`, 60000);
  // a search matching 7,500 entries in 2,500 folders: drawn once typing pauses, quickly, and capped
  const tSearch = await ev(`new Promise((ok) => { const i = document.querySelector("#wssidebar .fsearch"); const t0 = performance.now(); i.value = "x"; i.dispatchEvent(new Event("input")); const wait = () => (document.querySelectorAll("#wssidebar .frow").length > 100 ? ok(performance.now() - t0) : setTimeout(wait, 20)); wait(); })`);
  const rowsN = await ev(`document.querySelectorAll("#wssidebar .frow").length`);
  check(tSearch < 3000 && rowsN <= 1000 && /more not shown/.test(await ev(`document.querySelector("#wssidebar .ftree").innerText`)), `a search over 10,000+ entries in 2,500 folders: ${Math.round(tSearch)} ms, ${rowsN} rows drawn, the rest said`);
  await ev(`(() => { const i = document.querySelector("#wssidebar .fsearch"); i.value = ""; i.dispatchEvent(new Event("input")); return 1; })()`);
  await sleep(400);
  // a drop into a full folder reads nothing
  await ev(`(() => { window.__reads = 0; const ab = File.prototype.arrayBuffer; File.prototype.arrayBuffer = function () { window.__reads++; return ab.call(this); }; return 1; })()`);
  await until(`!!document.querySelector(${JSON.stringify(rowSel("/full"))})`);
  await ev(`(() => { const r = document.querySelector(${JSON.stringify(rowSel("/full"))}); const dt = new DataTransfer(); dt.items.add(new File(["1"], "new1.txt")); dt.items.add(new File(["2"], "new2.txt")); r.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true })); r.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); return 1; })()`);
  check(await until(`/is full/.test(document.querySelector("#wssidebar .ftoast")?.textContent ?? "")`), "a drop into a full folder is refused, and says so");
  check(await ev(`window.__reads === 0`) && await ev(`${W}.stat("/full/new1.txt").then((e) => e === undefined)`), "…without reading the files");
  // a menu on a short, narrow screen stays inside it, scrolling (LIMIT-0B0-3)
  await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 240, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await ev(`(() => { const r = document.querySelector(${JSON.stringify(rowSel("/many"))}); r.scrollIntoView(); r.querySelector(".more").click(); return 1; })()`);
  const mr = await ev(`(() => { const m = document.querySelector(".sbfmenu").getBoundingClientRect(); return [m.left, m.top, m.right, m.bottom, innerWidth, innerHeight, getComputedStyle(document.querySelector(".sbfmenu")).overflowY]; })()`);
  check(mr[0] >= 0 && mr[1] >= 0 && mr[2] <= mr[4] && mr[3] <= mr[5] && mr[6] === "auto", "a menu on a 320×240 screen stays inside it: " + JSON.stringify(mr));
  await ev(`(() => { document.querySelectorAll(".sbfmenu").forEach((m) => m.remove()); return 1; })()`);
  await send("Emulation.clearDeviceMetricsOverride");
  // a phone: the sidebar over the page
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await go(base);
  await until(`!!${W} && !${S}.hidden`, 60000);
  check(await ev(`${S}.getBoundingClientRect().width > 380`), "on a phone the file browser covers the page");
  await shot("phone");
  await click("#wssidebar .fh button[aria-label='Hide the files']");
  check(await until(`${S}.hidden`), "on a phone, ✕ hides the file browser");
  await send("Emulation.clearDeviceMetricsOverride");
  for (const e of errors) fails.push("page error: " + e);
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: the file browser, ${checks} checks`);
process.exit(0);
