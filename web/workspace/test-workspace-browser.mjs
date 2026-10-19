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
  const f2Cur = () => ev(`(() => { const r = document.querySelector("#wssidebar .frow.cur"); r.focus(); r.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })); return 1; })()`);
  const typeTitle = (t) => ev(`(() => { const i = document.querySelector("#nbname"); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event("input")); return 1; })()`);
  const nbPaths = () => ev(`${W}.list("/").then((l) => l.filter((e) => e.kind === "notebook").map((e) => e.path).sort())`);
  // a title typed, then (before its rename, 0.8 s later) the file renamed in
  // the sidebar: the sidebar's, the later, stays (CORR-0B0-1)
  await typeTitle("Queued title");
  await f2Cur();
  await until(`!!document.querySelector("#wssidebar .frow input")`);
  await typeInto("Sidebar final");
  await sleep(1500);
  check((await ev(`document.querySelector("#nbname").value`)) === "Sidebar final" && (await ev(`${W}.stat("/Sidebar final.ipynb").then((e) => !!e)`)) && !(await ev(`${W}.stat("/Queued title.ipynb").then((e) => !!e)`)), "a typed title's rename, superseded by a rename in the sidebar before it was made, isn't made: " + JSON.stringify(await nbPaths()));
  // …even one already waiting for the workspace's lock when the sidebar's is asked for
  await ev(`(() => { navigator.locks.request("sagebrush-workspace", () => new Promise((r) => (window.__unlock = r))); return 1; })()`);
  await typeTitle("Held title");
  await sleep(1300); // (its rename asked for: waiting for the lock)
  await until(`!!document.querySelector("#wssidebar .frow.cur")`);
  await f2Cur();
  await until(`!!document.querySelector("#wssidebar .frow input")`);
  await typeInto("After held");
  await sleep(300);
  await ev(`(() => { window.__unlock(); return 1; })()`);
  await sleep(1500);
  check((await ev(`document.querySelector("#nbname").value`)) === "After held" && (await ev(`${W}.stat("/After held.ipynb").then((e) => !!e)`)) && !(await ev(`${W}.stat("/Held title.ipynb").then((e) => !!e)`)), "…even one already waiting for the lock: " + JSON.stringify(await nbPaths()));
  // the open notebook renamed in another tab while its saves are queued
  // here: no save made before that change writes the old name back over it
  // (CORR-0B0-2).  The first save held, a second queued behind it.
  await ev(`sagebrush.notebook.saved().then(() => 1)`);
  await ev(`(async () => {
    const nb = sagebrush.notebook, real = nb.store;
    let calls = 0, release;
    window.__real = real;
    window.__entered = new Promise((r) => (window.__enter = r));
    const hold = new Promise((r) => (release = r));
    window.__releaseSave = () => release();
    await nb.attach({ load: () => real.load(), save: async (d) => { if (++calls === 1) { __enter(); await hold; } return real.save(d); }, subscribe: (f) => real.subscribe(f) });
    nb.setMeta({ probeOne: 1 }); nb.flush();
    await __entered;
    nb.setMeta({ probeTwo: 2 }); nb.flush();
    return 1;
  })()`);
  const t2 = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`, { method: "PUT" })).json();
  const ws2 = new WebSocket(t2.webSocketDebuggerUrl);
  await new Promise((r) => (ws2.onopen = r));
  let n2 = 0; const waiting2 = new Map();
  ws2.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting2.has(d.id)) { waiting2.get(d.id)(d.result ?? d.error); waiting2.delete(d.id); } };
  const ev2 = async (expression) => { const id = ++n2; const r = await new Promise((ok) => { waiting2.set(id, ok); ws2.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result?.value; };
  for (let i = 0; i < 600 && !(await ev2(`!!window.sagebrush?.workspace`).catch(() => false)); i++) await sleep(100);
  await ev2(`sagebrush.workspace.rename("/After held.ipynb", "/While saving.ipynb").then(() => 1)`);
  check(await until(`sagebrush.notebook.snapshot().name === "While saving"`), "(the rename in another tab, shown here)");
  await ev(`(() => { __releaseSave(); return 1; })()`);
  await ev(`sagebrush.notebook.saved().then(() => 1)`);
  await sleep(500);
  const kept = await ev2(`sagebrush.workspace.read("/While saving.ipynb").then((r) => ({ name: r.content.name, one: r.content.probeOne, two: r.content.probeTwo }))`);
  check(kept.name === "While saving" && kept.one === 1 && kept.two === 2, "saves queued here before a rename in another tab don't write the old name back: " + JSON.stringify(kept));
  ws2.close();
  await send("Target.closeTarget", { targetId: t2.id });
  await ev(`sagebrush.notebook.attach(__real).then(() => 1)`);
  // the open notebook renamed in its own sidebar while saves are queued: the name kept is the new one
  await ev(`(async () => {
    const nb = sagebrush.notebook, real = __real;
    let calls = 0, release;
    window.__entered = new Promise((r) => (window.__enter = r));
    const hold = new Promise((r) => (release = r));
    window.__releaseSave = () => release();
    await nb.attach({ load: () => real.load(), save: async (d) => { if (++calls === 1) { __enter(); await hold; } return real.save(d); }, subscribe: (f) => real.subscribe(f) });
    nb.setMeta({ probeThree: 3 }); nb.flush();
    await __entered;
    nb.setMeta({ probeFour: 4 }); nb.flush();
    return 1;
  })()`);
  await until(`document.querySelector("#wssidebar .frow.cur")?.dataset.path === "/While saving.ipynb"`);
  await f2Cur();
  await until(`!!document.querySelector("#wssidebar .frow input")`);
  await typeInto("Own sidebar");
  check(await until(`document.querySelector("#nbname").value === "Own sidebar"`), "(renamed in its own sidebar while a save is held)");
  await ev(`(() => { __releaseSave(); return 1; })()`);
  await ev(`sagebrush.notebook.saved().then(() => 1)`);
  await sleep(500);
  const kept2 = await ev(`${W}.read("/Own sidebar.ipynb").then((r) => ({ name: r.content.name, four: r.content.probeFour }))`);
  check(kept2.name === "Own sidebar" && kept2.four === 4, "…its saves queued before it keep the new name: " + JSON.stringify(kept2));
  await ev(`sagebrush.notebook.attach(__real).then(() => 1)`);
  // a save still waiting its turn when another notebook is opened is made
  // of its own notebook, from its own revision, never of the one shown now,
  // even after that one changed elsewhere (CORR-989-1, astra's trace)
  const cross = await ev(`(async () => {
    const nb = sagebrush.notebook, w = sagebrush.workspace;
    await nb.saved();
    const ae = (await w.list("/")).find((e) => e.kind === "notebook" && e.ref === nb.store?.id) ?? (await w.list("/")).find((e) => e.kind === "notebook");
    const ar = await w.read(ae.path);
    const be = await w.create("/B separate.ipynb", { content: { name: "B separate", mode: "python", cells: [{ id: "bPrivate", code: "B private" }] } });
    let br = await w.read(be.path);
    // (B's revision past A's: a save of A made from B's would be taken)
    while (br.rev <= ar.rev) { await w.write(be.path, br.content, { base: br.rev }); br = await w.read(be.path); }
    const real = nb.store;
    let n = 0, enter;
    window.__sentA = [];
    window.__enterA = new Promise((r) => (enter = r));
    const hold = new Promise((r) => (window.__releaseA = r));
    await nb.attach({ load: () => real.load(), save: async (d) => { __sentA.push({ name: d.name, code: d.cells[0].code, base: d.baseRev }); if (++n === 1) { enter(); await hold; } return real.save(d); }, subscribe: (f) => real.subscribe(f) });
    await new Promise((r) => setTimeout(r, 0));
    nb.setInput(nb.cells()[0], "A first"); nb.flush();
    await __enterA;
    nb.setInput(nb.cells()[0], "A second"); nb.flush();
    window.__aPath = ae.path;
    await sagebrush.open(be.ref);
    return { A: ae.path, aName: ar.content.name };
  })()`);
  const t3 = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`, { method: "PUT" })).json();
  const ws3 = new WebSocket(t3.webSocketDebuggerUrl);
  await new Promise((r) => (ws3.onopen = r));
  let n3 = 0; const waiting3 = new Map();
  ws3.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting3.has(d.id)) { waiting3.get(d.id)(d.result ?? d.error); waiting3.delete(d.id); } };
  const ev3 = async (expression) => { const id = ++n3; const r = await new Promise((ok) => { waiting3.set(id, ok); ws3.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result?.value; };
  for (let i = 0; i < 600 && !(await ev3(`!!window.sagebrush?.workspace`).catch(() => false)); i++) await sleep(100);
  await ev3(`(async () => { const w = sagebrush.workspace, r = await w.read("/B separate.ipynb"); await w.write("/B separate.ipynb", { ...r.content, cells: r.content.cells.map((c) => ({ ...c, code: "B remote private" })) }, { base: r.rev }); return 1; })()`);
  check(await until(`sagebrush.notebook.snapshot().cells[0].code === "B remote private"`), "(B, shown here, changed in another tab)");
  ws3.close();
  await send("Target.closeTarget", { targetId: t3.id });
  const crossed = await ev(`(async () => { __releaseA(); await sagebrush.notebook.saved(); await new Promise((r) => setTimeout(r, 500)); const a = await sagebrush.workspace.read(__aPath), b = await sagebrush.workspace.read("/B separate.ipynb"); return { sent: __sentA, A: { name: a.content.name, code: a.content.cells[0].code }, B: { name: b.content.name, code: b.content.cells[0].code } }; })()`);
  check(crossed.A.name === cross.aName && crossed.A.code === "A second" && crossed.B.name === "B separate" && crossed.B.code === "B remote private" && crossed.sent.every((x) => x.name === cross.aName && x.code.startsWith("A ")), "a save of A still queued when B was opened (and changed elsewhere) writes A's second edit to A, from A's revision, nothing of B: " + JSON.stringify(crossed));
  // …and if it meets a change made elsewhere to its own notebook, no longer
  // shown here, nothing is lost: the other version stays, and what the save
  // had is kept as a notebook of its own (CORR-B54-1, astra's trace)
  await ev(`(async () => {
    const nb = sagebrush.notebook, w = sagebrush.workspace;
    await nb.saved();
    const ce = await w.create("/C conflict.ipynb", { content: { name: "C conflict", mode: "python", cells: [{ id: "c1", code: "C start" }] } });
    await sagebrush.open(ce.ref);
    await nb.saved();
    const real = nb.store;
    let n = 0, enter;
    window.__enterC = new Promise((r) => (enter = r));
    const hold = new Promise((r) => (window.__releaseC = r));
    await nb.attach({ load: () => real.load(), save: async (d) => { if (++n === 1) { enter(); await hold; } return real.save(d); }, subscribe: (f) => real.subscribe(f) });
    await new Promise((r) => setTimeout(r, 0));
    nb.setInput(nb.cells()[0], "C first"); nb.flush();
    await __enterC;
    nb.setInput(nb.cells()[0], "C second"); nb.flush();
    await sagebrush.open((await w.stat("/B separate.ipynb")).ref);
    return 1;
  })()`);
  const t4 = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`, { method: "PUT" })).json();
  const ws4 = new WebSocket(t4.webSocketDebuggerUrl);
  await new Promise((r) => (ws4.onopen = r));
  let n4 = 0; const waiting4 = new Map();
  ws4.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting4.has(d.id)) { waiting4.get(d.id)(d.result ?? d.error); waiting4.delete(d.id); } };
  const ev4 = async (expression) => { const id = ++n4; const r = await new Promise((ok) => { waiting4.set(id, ok); ws4.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result?.value; };
  for (let i = 0; i < 600 && !(await ev4(`!!window.sagebrush?.workspace`).catch(() => false)); i++) await sleep(100);
  await ev4(`(async () => { const w = sagebrush.workspace, r = await w.read("/C conflict.ipynb"); await w.write("/C conflict.ipynb", { ...r.content, cells: r.content.cells.map((c) => ({ ...c, code: "C remote concurrent" })) }, { base: r.rev }); return 1; })()`);
  ws4.close();
  await send("Target.closeTarget", { targetId: t4.id });
  const keptC = await ev(`(async () => {
    __releaseC();
    let error = null;
    try { await sagebrush.notebook.saved(); } catch (e) { error = String(e?.message ?? e); }
    const w = sagebrush.workspace, c = await w.read("/C conflict.ipynb");
    const copy = await w.read("/C conflict (your changes, made while it changed elsewhere).ipynb").catch(() => null);
    return { error, theirs: c.content.cells[0].code, copy: copy && { name: copy.content.name, code: copy.content.cells[0].code }, notebooks: (await w.list("/")).filter((e) => e.kind === "notebook").map((e) => e.path) };
  })()`);
  check(keptC.theirs === "C remote concurrent", "a save of C, no longer shown, meeting a change made elsewhere to C: the other version stays: " + JSON.stringify(keptC));
  check(keptC.error === null && keptC.copy?.code === "C second" && keptC.copy?.name === "C conflict (your changes, made while it changed elsewhere)", "…and C's latest edit is kept as a notebook of its own, before saved() resolves: " + JSON.stringify(keptC));
  // Undo of Move to Trash: that file, put in Trash that time; not another
  // since put there under the same name (CORR-0B0-3)
  await ev(`${W}.create("/undo.txt", { content: "original" }).then(() => 1)`);
  await until(`!!document.querySelector(${JSON.stringify(rowSel("/undo.txt"))})`);
  await click(rowSel("/undo.txt") + " .more");
  await menu("Move to Trash");
  await until(`!!document.querySelector("#wssidebar .ftoast button")`);
  await ev(`(async () => { await ${W}.restore("/Trash/undo.txt"); await ${W}.rename("/undo.txt", "/original-moved.txt"); await ${W}.create("/undo.txt", { content: "UNRELATED" }); await ${W}.remove("/undo.txt"); return 1; })()`);
  await until(`!!document.querySelector("#wssidebar .ftoast button")`);
  await click("#wssidebar .ftoast button");
  await sleep(800);
  const after = await ev(`(async () => ({ trashed: await ${W}.read("/Trash/undo.txt").then((r) => new TextDecoder().decode(r.content)).catch(() => null), back: await ${W}.stat("/undo.txt").then((e) => !!e), moved: await ${W}.read("/original-moved.txt").then((r) => new TextDecoder().decode(r.content)).catch(() => null), said: document.querySelector("#wssidebar .ftoast")?.textContent ?? "" }))()`);
  check(after.trashed === "UNRELATED" && !after.back && after.moved === "original", "Undo after the file was restored elsewhere and another trashed under its name: nothing moved: " + JSON.stringify(after));
  check(/already restored or deleted/.test(after.said), "…and it says so: " + JSON.stringify(after.said));
  // opening a board from the notebook page
  await click(rowSel("/Sylow theorems.board.json"));
  check(await until(`location.pathname.startsWith("/board/") && /doc=local:[0-9a-f]{12}/.test(location.search) && !!window.sagebrush?.board?.snapshot()`, 60000), "a board opens from the notebook page's sidebar");
  check(await until(`!!document.querySelector('[data-sbb="files"]') && !${S}.hidden`), "the board page has Files, and the sidebar is still open (remembered)");
  check(await until(`document.querySelector("#wssidebar .frow.cur")?.dataset.path === "/Sylow theorems.board.json"`), "…with the board marked");
  await shot("board-sidebar");
  // the open board renamed in its sidebar: its title follows, saved by the
  // page with its other changes; nothing taken for a change made elsewhere
  // (no copy of "your changes"), CORR-0B0-2
  await f2Cur();
  await until(`!!document.querySelector("#wssidebar .frow input")`);
  await typeInto("Sylow renamed");
  check(await until(`${W}.stat("/Sylow renamed.board.json").then((e) => !!e) && document.querySelector('[data-sbb="title"]').textContent === "Sylow renamed"`), "renaming the open board renames it on the page");
  check(await until(`document.querySelector("#wssidebar .frow.cur")?.dataset.path === "/Sylow renamed.board.json"`), "…still marked as open");
  await sleep(800);
  await ev(`sagebrush.board.edit((d) => { (d.nodes ??= []).push({ id: "after", text: "after the rename" }); }).then(() => 1)`);
  await sleep(2000);
  const rb = await ev(`(async () => { const r = await ${W}.read("/Sylow renamed.board.json"); return { title: r.content.title, after: (r.content.nodes ?? []).some((n) => n.id === "after"), copies: (await ${W}.list("/", { recursive: true })).filter((e) => e.kind === "board" && /your changes/.test(e.path)).map((e) => e.path), log: sagebrush.saveLog().map((x) => x.what) }; })()`);
  check(rb.title === "Sylow renamed" && rb.after && rb.copies.length === 0, "…and an edit after it is saved over it, the new title kept, no conflict: " + JSON.stringify(rb));

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
