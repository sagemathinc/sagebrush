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
  // a file kept by an older version, too large to move beside the index (capabilities 1a): Trash can't take
  // it, so Delete asks, and deletes it for good, never reading it
  await ev(`(async () => {
    const put = (db, store, v, k) => new Promise((ok, no) => { const r = indexedDB.open(db); r.onsuccess = () => { const tx = r.result.transaction(store, "readwrite"); tx.objectStore(store).put(v, k); tx.oncomplete = () => { r.result.close(); ok(); }; tx.onerror = () => no(tx.error); }; });
    await put("sagebrush", "files", new Uint8Array([1, 2, 3]), "/Old huge.bin");
    await put("sagebrush-workspace", "entries", { path: "/Old huge.bin", kind: "file", ref: "/Old huge.bin", size: 300 * 2 ** 20, rev: 0, fid: "0123456789abcdef", created: 1, updated: 1, unmoved: "too large to move" });
    await ${W}.mkdir("/refresh-list");
    return 1;
  })()`);
  check(await until(`!!document.querySelector(${JSON.stringify(rowSel("/Old huge.bin"))})`), "(a file too large to move, listed)");
  await click(rowSel("/Old huge.bin") + " .more");
  await menu("Move to Trash");
  check(await until(`${W}.stat("/Old huge.bin").then((e) => !e)`) && !(await ev(`${W}.stat("/Trash/Old huge.bin").then((e) => !!e)`)), "Delete on a file too large to move: deleted for good (confirmed), not put in Trash");
  check(await ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush"); r.onsuccess = () => { const q = r.result.transaction("files").objectStore("files").getKey("/Old huge.bin"); q.onsuccess = () => { r.result.close(); ok(q.result === undefined); }; }; })`), "…its old bytes gone too");
  // search
  await ev(`(() => { const i = document.querySelector("#wssidebar .fsearch"); i.value = "sylow"; i.dispatchEvent(new Event("input")); return 1; })()`);
  check(await until(`document.querySelectorAll("#wssidebar .frow").length === 1 && !!document.querySelector(${JSON.stringify(rowSel("/Sylow theorems.board.json"))})`), "search shows what matches");
  await ev(`(() => { const i = document.querySelector("#wssidebar .fsearch"); i.value = ""; i.dispatchEvent(new Event("input")); return 1; })()`);
  await until(`!!document.querySelector("#wssidebar .frow.cur")`);
  // a change while a name is typed in place (here, another tab, an agent)
  // doesn't take the half-typed name away; the tree is drawn once it's done
  await until(`!!document.querySelector(${JSON.stringify(rowSel("/Sylow theorems.board.json"))})`);
  await ev(`(() => { const r = document.querySelector(${JSON.stringify(rowSel("/Sylow theorems.board.json"))}); r.focus(); r.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })); const i = r.querySelector("input"); i.value = "Sylow half"; return 1; })()`);
  await ev(`${W}.create("/meanwhile.txt", { content: "x" }).then(() => 1)`);
  await sleep(800);
  check(await ev(`document.querySelector("#wssidebar .frow input")?.value === "Sylow half"`), "a change while a name is typed in place keeps what was typed");
  await ev(`(() => { document.querySelector("#wssidebar .frow input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1; })()`);
  check(await until(`!!document.querySelector(${JSON.stringify(rowSel("/meanwhile.txt"))}) && !document.querySelector("#wssidebar .frow input")`), "…and once it's done (here Esc), the change is drawn");
  // a name typed in place for an entry moved away meanwhile, another put at
  // its path: neither renamed (CORR-4B2-1)
  await ev(`${W}.create("/rename.txt", { content: "original" }).then(() => 1)`);
  await until(`!!document.querySelector(${JSON.stringify(rowSel("/rename.txt"))})`);
  await ev(`(() => { const r = document.querySelector(${JSON.stringify(rowSel("/rename.txt"))}); r.focus(); r.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })); r.querySelector("input").value = "renamed.txt"; return 1; })()`);
  await ev(`(async () => { const w = ${W}; await w.rename("/rename.txt", "/moved-rename.txt"); await w.create("/rename.txt", { content: "replacement" }); return 1; })()`);
  await sleep(800);
  await ev(`(() => { document.querySelector("#wssidebar .frow input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return 1; })()`);
  await sleep(800);
  const rn = await ev(`(async () => ({ renamed: !!(await ${W}.stat("/renamed.txt")), here: await ${W}.read("/rename.txt").then((r) => new TextDecoder().decode(r.content)), moved: !!(await ${W}.stat("/moved-rename.txt")), said: document.querySelector("#wssidebar .ftoast")?.textContent ?? "" }))()`);
  check(!rn.renamed && rn.here === "replacement" && rn.moved && /moved or replaced meanwhile/.test(rn.said), "a name typed for a file moved away meanwhile, another put at its path: neither renamed, said: " + JSON.stringify(rn));
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
  // a tab of its own for the next two: changes made elsewhere
  const t5 = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`, { method: "PUT" })).json();
  const ws5 = new WebSocket(t5.webSocketDebuggerUrl);
  await new Promise((r) => (ws5.onopen = r));
  let n5 = 0; const waiting5 = new Map();
  ws5.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting5.has(d.id)) { waiting5.get(d.id)(d.result ?? d.error); waiting5.delete(d.id); } };
  const ev5 = async (expression) => { const id = ++n5; const r = await new Promise((ok) => { waiting5.set(id, ok); ws5.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result?.value; };
  for (let i = 0; i < 600 && !(await ev5(`!!window.sagebrush?.workspace`).catch(() => false)); i++) await sleep(100);
  const writeElsewhere = (path, code) => ev5(`(async () => { const w = sagebrush.workspace, r = await w.read(${JSON.stringify(path)}); await w.write(${JSON.stringify(path)}, { ...r.content, cells: r.content.cells.map((c) => ({ ...c, code: ${JSON.stringify(code)} })) }, { base: r.rev }); return 1; })()`);
  // a notebook X opened, its saves held (gates 1 and 2), edits "X first", "X second" made, then B opened
  const heldSwitch = (name) => ev(`(async () => {
    const nb = sagebrush.notebook, w = sagebrush.workspace;
    await nb.saved();
    const e = await w.create(${JSON.stringify("/" + name + ".ipynb")}, { content: { name: ${JSON.stringify(name)}, mode: "python", cells: [{ id: "x1", code: "start" }] } });
    await sagebrush.open(e.ref);
    await nb.saved();
    const real = nb.store;
    let n = 0;
    window.__gate = [0, 1, 2].map(() => { let open; const p = new Promise((r) => (open = r)); return { p, open }; });
    window.__entered = [0, 1, 2].map(() => { let hit; const p = new Promise((r) => (hit = r)); return { p, hit }; });
    await nb.attach({ load: () => real.load(), save: async (d) => { const k = ++n; if (k <= 2) { __entered[k].hit(); await __gate[k].p; } return real.save(d); }, subscribe: (f) => real.subscribe(f) });
    await new Promise((r) => setTimeout(r, 0));
    nb.setInput(nb.cells()[0], ${JSON.stringify(name + " first")}); nb.flush();
    await __entered[1].p;
    nb.setInput(nb.cells()[0], ${JSON.stringify(name + " second")}); nb.flush();
    await sagebrush.open((await w.stat("/B separate.ipynb")).ref);
    return 1;
  })()`);
  const copyOf = (name) => "/" + name + " (your changes, made while it changed elsewhere)";
  const unloadAsks = () => ev(`(() => { const e = new Event("beforeunload", { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; })()`);
  check((await unloadAsks()) === false, "closing the page with nothing of a notebook left outstanding doesn't ask");
  // CORR-E46-1: the page fails to keep them; a save of B meanwhile succeeds;
  // saved() still rejects, and once keeping works again, the edit is kept
  await heldSwitch("D held");
  check((await unloadAsks()) === true, "closing the page while a notebook left (D) has saves still being written asks first");
  await ev(`(() => { window.__pageKeep = sagebrush.notebook.onDetachedConflict(() => { throw new Error("injected: no room"); }); return 1; })()`);
  await ev(`(async () => { const nb = sagebrush.notebook; nb.setInput(nb.cells()[0], "B saved meanwhile"); nb.flush(); return 1; })()`);
  await writeElsewhere("/D held.ipynb", "D remote concurrent");
  const failed = await ev(`(async () => { __gate[1].open(); __gate[2].open(); let error = null; try { await sagebrush.notebook.saved(); } catch (e) { error = String(e?.message ?? e); } const w = sagebrush.workspace; return { error, b: (await w.read("/B separate.ipynb")).content.cells[0].code, copies: (await w.list("/")).filter((e) => e.path.startsWith(${JSON.stringify(copyOf("D held"))})).map((e) => e.path) }; })()`);
  check((await unloadAsks()) === true, "…and while they couldn't be kept");
  check(failed.error && /injected/.test(failed.error) && failed.b === "B saved meanwhile" && failed.copies.length === 0, "a save of D no longer shown that the page couldn't keep: saved() rejects, though B's save after it succeeded: " + JSON.stringify(failed));
  const recovered = await ev(`(async () => { sagebrush.notebook.onDetachedConflict(__pageKeep); let error = null; try { await sagebrush.notebook.saved(); } catch (e) { error = String(e?.message ?? e); } const w = sagebrush.workspace, c = await w.read(${JSON.stringify(copyOf("D held") + ".ipynb")}).catch(() => null); return { error, theirs: (await w.read("/D held.ipynb")).content.cells[0].code, copy: c?.content.cells[0].code ?? null }; })()`);
  check(recovered.error === null && recovered.copy === "D held second" && recovered.theirs === "D remote concurrent", "…and is tried again: kept once it can be, D's latest edit, the other version as it was: " + JSON.stringify(recovered));
  check((await unloadAsks()) === false, "…and not once they are kept");
  // CORR-E46-2: a copy changed by someone after it was made is never written over by a later save
  await heldSwitch("E held");
  await writeElsewhere("/E held.ipynb", "E remote concurrent");
  await ev(`(() => { __gate[1].open(); return 1; })()`);
  check(await until(`sagebrush.workspace.read(${JSON.stringify(copyOf("E held") + ".ipynb")}).then((r) => r.content.cells[0].code === "E held first").catch(() => false)`), "(E's first save kept as a copy)");
  await writeElsewhere(copyOf("E held") + ".ipynb", "Copy edited by person");
  const both = await ev(`(async () => { __gate[2].open(); let error = null; try { await sagebrush.notebook.saved(); } catch (e) { error = String(e?.message ?? e); } const w = sagebrush.workspace, l = (await w.list("/")).filter((e) => e.path.startsWith(${JSON.stringify(copyOf("E held"))})); const codes = {}; for (const e of l) codes[e.path] = (await w.read(e.path)).content.cells[0].code; return { error, codes, theirs: (await w.read("/E held.ipynb")).content.cells[0].code }; })()`);
  check(both.error === null && both.codes[copyOf("E held") + ".ipynb"] === "Copy edited by person" && Object.values(both.codes).includes("E held second") && both.theirs === "E remote concurrent", "a later save of E, its copy edited meanwhile: the edit to the copy stays, E's second edit is a copy of its own: " + JSON.stringify(both));
  // LIMIT-E46-1: no room at the top for the copy: nothing written that the
  // workspace doesn't list, saved() rejects saying why; with room again, kept
  await heldSwitch("F held");
  await writeElsewhere("/F held.ipynb", "F remote concurrent");
  const nbCount = `new Promise((ok) => { const r = indexedDB.open("sagebrush"); r.onsuccess = () => { const q = r.result.transaction("notebooks").objectStore("notebooks").count(); q.onsuccess = () => { r.result.close(); ok(q.result); }; }; })`;
  const fill = (put) => ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const tx = r.result.transaction("entries", "readwrite"), st = tx.objectStore("entries"), t = Date.now();
    if (${put}) { for (let i = 0; i < 10000; i++) st.put({ path: "/zfill" + String(i).padStart(5, "0"), kind: "folder", ref: null, created: t, updated: t }); }
    else st.delete(IDBKeyRange.bound("/zfill", "/zfill\uffff"));
    tx.oncomplete = () => { r.result.close(); ok(1); }; }; })`);
  const nbBefore = await ev(nbCount);
  await fill(true);
  const full = await ev(`(async () => { __gate[1].open(); __gate[2].open(); let error = null; try { await sagebrush.notebook.saved(); } catch (e) { error = String(e?.message ?? e); } return { error, copies: (await sagebrush.workspace.list("/")).filter((e) => e.path.startsWith(${JSON.stringify(copyOf("F held"))})).length }; })()`);
  const nbAfter = await ev(nbCount);
  check(full.error && /full/.test(full.error) && full.copies === 0 && nbAfter === nbBefore, "the top folder full: F's copy isn't written outside the workspace, and saved() says why: " + JSON.stringify({ ...full, nbBefore, nbAfter }));
  await fill(false);
  const roomAgain = await ev(`(async () => { let error = null; try { await sagebrush.notebook.saved(); } catch (e) { error = String(e?.message ?? e); } const c = await sagebrush.workspace.read(${JSON.stringify(copyOf("F held") + ".ipynb")}).catch(() => null); return { error, copy: c?.content.cells[0].code ?? null }; })()`);
  check(roomAgain.error === null && roomAgain.copy === "F held second", "…with room again, kept: " + JSON.stringify(roomAgain));
  // CORR-900-1: an older keeping, tried again by an earlier saved(), never
  // lands after a newer one: H's first keeping fails, saved() (asked while
  // H's first save was held) tries it again; H's second save is kept; then
  // the old one, held at the page, is let go: the copy is H's second edit
  await ev(`(async () => {
    const nb = sagebrush.notebook, w = sagebrush.workspace;
    await nb.saved();
    const e = await w.create("/H held.ipynb", { content: { name: "H held", mode: "python", cells: [{ id: "x1", code: "start" }] } });
    await sagebrush.open(e.ref);
    await nb.saved();
    const real = nb.store;
    let n = 0, calls = 0;
    window.__gate = [0, 1, 2].map(() => { let open; const p = new Promise((r) => (open = r)); return { p, open }; });
    window.__entered = [0, 1, 2].map(() => { let hit; const p = new Promise((r) => (hit = r)); return { p, hit }; });
    window.__retryHold = new Promise((r) => (window.__releaseRetry = r));
    window.__origKeep = nb.onDetachedConflict(null);
    nb.onDetachedConflict(async (doc, theirs, key) => {
      if (++calls === 1) throw new Error("first keeping unavailable");
      if (doc.cells[0].code === "H held first") { window.__retryIn = true; await window.__retryHold; }
      return __origKeep(doc, theirs, key);
    });
    await nb.attach({ load: () => real.load(), save: async (d) => { const k = ++n; if (k <= 2) { __entered[k].hit(); await __gate[k].p; } return real.save(d); }, subscribe: (f) => real.subscribe(f) });
    await new Promise((r) => setTimeout(r, 0));
    nb.setInput(nb.cells()[0], "H held first"); nb.flush();
    await __entered[1].p;
    window.__earlySaved = nb.saved().then(() => ({ ok: true }), (e) => ({ error: String(e?.message ?? e) }));
    nb.setInput(nb.cells()[0], "H held second"); nb.flush();
    await sagebrush.open((await w.stat("/B separate.ipynb")).ref);
    return 1;
  })()`);
  await writeElsewhere("/H held.ipynb", "H remote concurrent");
  await ev(`(() => { __gate[1].open(); return 1; })()`);
  await sleep(800);
  await ev(`(() => { __gate[2].open(); return 1; })()`);
  check(await until(`sagebrush.workspace.read(${JSON.stringify(copyOf("H held") + ".ipynb")}).then((r) => r.content.cells[0].code === "H held second").catch(() => false)`, 20000), "(H's second save kept as a copy)");
  const hRes = await ev(`(async () => {
    __releaseRetry();
    const early = await __earlySaved;
    let error = null;
    try { await sagebrush.notebook.saved(); } catch (e) { error = String(e?.message ?? e); }
    await new Promise((r) => setTimeout(r, 300));
    const w = sagebrush.workspace, codes = {};
    for (const e of (await w.list("/")).filter((e) => e.path.startsWith(${JSON.stringify(copyOf("H held"))}))) codes[e.path] = (await w.read(e.path)).content.cells[0].code;
    sagebrush.notebook.onDetachedConflict(__origKeep);
    return { early, error, codes, retryIn: !!window.__retryIn };
  })()`);
  check(hRes.error === null && hRes.codes[copyOf("H held") + ".ipynb"] === "H held second" && !Object.values(hRes.codes).includes("H held first"), "an older keeping tried again by an earlier saved() never writes over the newer one: " + JSON.stringify(hRes));
  // LIMIT-900-2: at most 4 notebooks left with changes not kept; past it,
  // no other opens until they are, and nothing is dropped
  await ev(`(async () => { window.__origKeep2 = sagebrush.notebook.onDetachedConflict(async () => { throw new Error("injected: not kept"); }); return 1; })()`);
  for (let i = 1; i <= 4; i++) {
    await ev(`(async () => {
      const nb = sagebrush.notebook, w = sagebrush.workspace;
      const e = await w.create("/K${i}.ipynb", { content: { name: "K${i}", mode: "python", cells: [{ id: "k", code: "start" }] } });
      await sagebrush.open(e.ref);
      const real = nb.store;
      let enter, open;
      const entered = new Promise((r) => (enter = r)), gate = new Promise((r) => (open = r));
      await nb.attach({ load: () => real.load(), save: async (d) => { enter(); await gate; return { conflict: { ...d, cells: [{ id: "k", code: "K elsewhere" }], rev: 1e6 } }; }, subscribe: () => () => {} });
      await new Promise((r) => setTimeout(r, 0));
      nb.setInput(nb.cells()[0], "K${i} edit"); nb.flush();
      await entered;
      await sagebrush.open((await w.stat("/B separate.ipynb")).ref);
      open();
      await nb.saved().catch(() => {});
      return 1;
    })()`);
  }
  const bound = await ev(`(async () => {
    const nb = sagebrush.notebook, w = sagebrush.workspace, left = nb.leftOutstanding;
    const e = await w.create("/K5.ipynb", { content: { name: "K5", mode: "python", cells: [{ id: "k", code: "start" }] } });
    let refused = null;
    try { await sagebrush.open(e.ref); } catch (err) { refused = String(err?.message ?? err); }
    return { left, refused, after: nb.leftOutstanding, shown: nb.snapshot().name };
  })()`);
  check(bound.left === 4 && /4 notebooks you left/.test(bound.refused ?? "") && bound.after === 4 && bound.shown === "B separate", "4 notebooks left with changes not kept: another isn't opened, saying why, and B stays: " + JSON.stringify(bound));
  // …the same from the file browser: said there and in the status line,
  // B staying; and closing the page now, the browser asks first
  await until(`!!document.querySelector(${JSON.stringify(rowSel("/K5.ipynb"))})`);
  await click(rowSel("/K5.ipynb"));
  await sleep(1500);
  const side = await ev(`({ status: document.querySelector("#status").textContent, toast: document.querySelector("#wssidebar .ftoast")?.textContent ?? "", shown: sagebrush.notebook.snapshot().name })`);
  check(/4 notebooks you left/.test(side.status) && /4 notebooks you left/.test(side.toast) && side.shown === "B separate", "…opened from the file browser: not opened, said there and in the status line, B staying: " + JSON.stringify(side));
  check((await unloadAsks()) === true, "…and closing the page asks first, those changes only here");
  const unbound = await ev(`(async () => {
    const nb = sagebrush.notebook, w = sagebrush.workspace;
    nb.onDetachedConflict(__origKeep2);
    let error = null;
    try { await nb.saved(); } catch (e) { error = String(e?.message ?? e); }
    const copies = {};
    for (let i = 1; i <= 4; i++) copies[i] = (await w.read("/K" + i + " (your changes, made while it changed elsewhere).ipynb").catch(() => null))?.content.cells[0].code ?? null;
    await sagebrush.open((await w.stat("/K5.ipynb")).ref);
    return { error, copies, left: nb.leftOutstanding, shown: nb.snapshot().name };
  })()`);
  check(unbound.error === null && [1, 2, 3, 4].every((i) => unbound.copies[i] === "K" + i + " edit") && unbound.left === 0 && unbound.shown === "K5", "…once kept (each its own copy), another opens: " + JSON.stringify(unbound));
  check((await unloadAsks()) === false, "…and closing the page doesn't ask once they are kept");
  // LIMIT-900-1: a copy made before the workspace is open (here: another
  // tab holds its lock as the page loads) isn't kept as a notebook the
  // workspace doesn't list; once it opens, saved() keeps it
  const gIds = await ev(`(async () => { const w = sagebrush.workspace; const g = await w.create("/G held.ipynb", { content: { name: "G held", mode: "python", cells: [{ id: "g", code: "start" }] } }); return { g: g.ref, b: (await w.stat("/B separate.ipynb")).ref }; })()`);
  await ev5(`(() => { navigator.locks.request("sagebrush-workspace", () => new Promise((r) => (window.__unlockG = r))); return 1; })()`);
  await sleep(300);
  await go(base + "?nb=" + encodeURIComponent(gIds.g));
  check(await until(`sagebrush.notebook?.snapshot().name === "G held" && !window.sagebrush.workspace`, 30000), "(G open, the workspace not yet: another tab holds its lock)");
  // (a save waits for the workspace's lock at most LOCK_WAIT, then gives up, saying the files are busy, its change
  // kept to be sent again: shortened here, as the lock is held for good meanwhile)
  await ev(`(() => { sagebrush.lockWait.ms = 500; return 1; })()`);
  await ev(`(async () => {
    const nb = sagebrush.notebook, real = nb.store;
    let n = 0, enter, open;
    const entered = new Promise((r) => (enter = r));
    window.__gateG = new Promise((r) => (window.__openG = r));
    await nb.attach({ load: () => real.load(), save: async (d) => { if (++n === 1) { enter(); await __gateG; } return real.save(d); }, subscribe: (f) => real.subscribe(f) });
    await new Promise((r) => setTimeout(r, 0));
    nb.setInput(nb.cells()[0], "G held first"); nb.flush();
    await entered;
    nb.setInput(nb.cells()[0], "G held second"); nb.flush();
    await sagebrush.open(${JSON.stringify(gIds.b)});
    return 1;
  })()`);
  await ev5(`new Promise((ok) => { const r = indexedDB.open("sagebrush"); r.onsuccess = () => { const tx = r.result.transaction("notebooks", "readwrite"), st = tx.objectStore("notebooks"), q = st.get(${JSON.stringify(gIds.g)}); q.onsuccess = () => st.put({ ...q.result, cells: [{ id: "g", code: "G remote concurrent" }], rev: q.result.rev + 1 }); tx.oncomplete = () => { r.result.close(); ok(1); }; }; })`);
  const gBefore = await ev(nbCount);
  const gWait = await ev(`(async () => { __openG(); let error = null; try { await sagebrush.notebook.saved(); } catch (e) { error = String(e?.message ?? e); } return { error, ws: !!window.sagebrush.workspace, said: document.querySelector("#saved")?.textContent ?? "" }; })()`);
  check(!/files are busy/.test(gWait.error ?? "") || /not saved: your files are busy/.test(gWait.said), "…a save given up as busy is said in the notebook's status: " + JSON.stringify(gWait.said));
  const gAfter = await ev(nbCount);
  check(/isn't open yet|files are busy/.test(gWait.error ?? "") && !gWait.ws && gAfter === gBefore, "the workspace not open yet: G's copy isn't kept unlisted, and saved() says why: " + JSON.stringify({ ...gWait, gBefore, gAfter }));
  // (the lock let go: saves wait for it as long as ever, behind the workspace's own opening)
  await ev(`(() => { sagebrush.lockWait.ms = 10_000; return 1; })()`);
  await ev5(`(() => { window.__unlockG(); return 1; })()`);
  check(await until(`!!window.sagebrush.workspace`, 30000), "(the workspace open once the other tab lets go)");
  const gKept = await ev(`(async () => { let error = null; try { await sagebrush.notebook.saved(); } catch (e) { error = String(e?.message ?? e); } const w = sagebrush.workspace, c = await w.read(${JSON.stringify(copyOf("G held") + ".ipynb")}).catch(() => null); return { error, copy: c?.content.cells[0].code ?? null, theirs: (await w.read("/G held.ipynb")).content.cells[0].code }; })()`);
  check(gKept.error === null && gKept.copy === "G held second" && gKept.theirs === "G remote concurrent", "…once it is, saved() keeps G's latest edit, listed: " + JSON.stringify(gKept));
  ws5.close();
  await send("Target.closeTarget", { targetId: t5.id });
  // a notebook left while its save was busy (the workspace's lock held, here by the page itself): counted as left
  // with changes not kept (the page asks before closing), and its change kept, sent again by saved(), once the
  // lock is let go (notebook.js queueSave and busy; @sagebrush's point 3)
  {
    const ids = await ev(`(async () => { const w = sagebrush.workspace; const x = await w.create("/Busy X.ipynb", { content: { name: "Busy X", mode: "python", cells: [{ id: "x", code: "x0" }] } }); const y = await w.create("/Busy Y.ipynb", { content: { name: "Busy Y", mode: "python", cells: [{ id: "y", code: "y0" }] } }); return { x: x.ref, y: y.ref }; })()`);
    await ev(`sagebrush.open(${JSON.stringify(ids.x)}).then(() => 1)`);
    check(await until(`sagebrush.notebook?.snapshot().name === "Busy X"`, 10000), "(Busy X open)");
    const busyLeft = await ev(`(async () => {
      const nb = sagebrush.notebook;
      sagebrush.lockWait.ms = 300;
      await nb.saved().catch(() => {});
      await new Promise((r) => navigator.locks.request("sagebrush-workspace", () => new Promise((g) => { window.__unlockBusy = g; r(); })));
      nb.setInput(nb.cells()[0], "x busy"); nb.flush();
      // (every save of X given up before Y is shown: none still waiting for the lock, to go through once it is free)
      await nb.saved().catch(() => {});
      await new Promise((r) => setTimeout(r, 600));
      const said = document.querySelector("#saved")?.textContent ?? "";
      await sagebrush.open(${JSON.stringify(ids.y)});
      return { said, shown: nb.snapshot().name, left: nb.leftOutstanding };
    })()`);
    const asks = await unloadAsks();
    const busyKept = await ev(`(async () => {
      window.__unlockBusy(); sagebrush.lockWait.ms = 10_000;
      let error = null; try { await sagebrush.notebook.saved(); } catch (e) { error = String(e?.message ?? e); }
      const w = sagebrush.workspace;
      return { error, x: (await w.read("/Busy X.ipynb")).content.cells[0].code, left: sagebrush.notebook.leftOutstanding };
    })()`);
    check(/files are busy/.test(busyLeft.said) && busyLeft.shown === "Busy Y" && busyLeft.left === 1 && asks === true, "a notebook left while its save was busy: said, counted as left with changes not kept, and closing the page asks: " + JSON.stringify({ ...busyLeft, asks }));
    check(busyKept.error === null && busyKept.x === "x busy" && busyKept.left === 0, "…once the lock is let go, saved() sends it again: kept: " + JSON.stringify(busyKept));
  }
  // the editor itself (notebook.js), with stores of the test's own: a save refused as busy (the error's busy flag,
  // as notebook/stores.js gives it), the document then left for another: counted as left until it is sent again,
  // and sent again, as it was, by saved() once the store takes it
  {
    const r = await ev(`(async () => {
      const nb = sagebrush.notebook, saves = [];
      let busy = true;
      const mk = (name) => { let doc = { name, mode: "python", cells: [{ id: "c", code: name + "0" }] }, rev = 1; return { load: async () => ({ ...doc, rev }), save: async (d) => { if (busy) throw Object.assign(new Error("your files are busy (test)"), { busy: true }); saves.push([name, d.cells[0].code]); doc = d; rev++; return { saved: "saved", rev }; }, subscribe: () => () => {} }; };
      const A = mk("A"), B = mk("B");
      await nb.attach(A);
      nb.setInput(nb.cells()[0], "A busy"); nb.flush();
      let first = null; try { await nb.saved(); } catch (e) { first = String(e?.message ?? e); }
      await nb.attach(B);
      const left = nb.leftOutstanding;
      busy = false;
      let error = null; try { await nb.saved(); } catch (e) { error = String(e?.message ?? e); }
      return { first, left, error, saves, after: nb.leftOutstanding };
    })()`);
    check(/busy/.test(r.first ?? "") && r.left === 1 && r.error === null && r.saves.some(([n, c]) => n === "A" && c === "A busy") && r.after === 0, "the editor: a busy save, its document left: counted as left, then sent again by saved() and kept: " + JSON.stringify(r));
    // (astra's CORR-9D7-1: A1 held, then refused busy; A2, asked for meanwhile, saved; A left: A1 is never sent
    // again over A2, and nothing is left outstanding)
    const r2 = await ev(`(async () => {
      const nb = sagebrush.notebook, writes = [];
      let release, n = 0;
      const gate = new Promise((g) => (release = g));
      const mk = (name, gated) => { let doc = { name, mode: "python", cells: [{ id: "c", code: name + "0" }] }, rev = 1; return { load: async () => ({ ...doc, rev }), save: async (d) => { if (gated && ++n === 1) { await gate; throw Object.assign(new Error("your files are busy (test)"), { busy: true }); } if (d.baseRev !== undefined && d.baseRev !== rev) return { conflict: { ...doc, rev } }; writes.push([name, d.cells[0].code, d.baseRev]); doc = d; rev++; return { saved: "saved", rev }; }, subscribe: () => () => {} }; };
      const A = mk("A", true), B = mk("B", false);
      await nb.attach(A);
      nb.setInput(nb.cells()[0], "A1"); nb.flush();
      await new Promise((r) => setTimeout(r, 50));
      nb.setInput(nb.cells()[0], "A2"); nb.flush();
      await nb.attach(B);
      release();
      let error = null; try { await nb.saved(); } catch (e) { error = String(e?.message ?? e); }
      await new Promise((r) => setTimeout(r, 100));
      try { await nb.saved(); } catch (e) { error = error ?? String(e?.message ?? e); }
      return { error, writes, left: nb.leftOutstanding };
    })()`);
    check(r2.error === null && JSON.stringify(r2.writes.filter((w) => w[0] === "A").map((w) => w[1])) === '["A2"]' && r2.left === 0, "the editor: an older busy save superseded by a newer one saved is never sent again over it: " + JSON.stringify(r2));
    await ev(`sagebrush.workspace.stat("/Busy Y.ipynb").then((e) => sagebrush.open(e.ref)).then(() => 1)`);
  }
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
  // (B1) …an error, said as one: role=alert, styled apart, kept until Dismissed (a ✕ named "Dismiss"); Dismissing it
  // from the keyboard puts the focus back in the list, never on the body
  const errToast = await ev(`(() => { const t = document.querySelector("#wssidebar .ftoast"); const x = [...(t?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "✕"); return { err: !!t?.classList.contains("err"), role: t?.getAttribute("role") ?? null, bg: t ? getComputedStyle(t).backgroundColor : null, close: x?.getAttribute("aria-label") ?? null }; })()`);
  check(errToast.err && errToast.role === "alert" && errToast.bg === "rgb(253, 236, 234)" && errToast.close === "Dismiss", "B1-err: an error is said as one (role=alert, its own colours, a ✕ named Dismiss): " + JSON.stringify(errToast));
  const dis = await ev(`(() => { const x = [...document.querySelectorAll("#wssidebar .ftoast button")].find((b) => b.textContent === "✕"); x?.focus(); x?.click(); const a = document.activeElement; return { gone: !document.querySelector("#wssidebar .ftoast"), active: a?.classList.contains("frow") ? "row" : a?.tagName }; })()`);
  check(dis.gone && dis.active === "row", "B1-dismiss: Dismiss from the keyboard puts the focus on a row of the list, never the body: " + JSON.stringify(dis));
  // (B1, William Nov 1) Move to Trash on the notebook OPEN here: no "open something else first"
  {
    const toastTxt = `document.querySelector("#wssidebar .ftoast")?.textContent ?? ""`;
    const press = (label) => ev(`(() => { [...document.querySelectorAll("#wssidebar .ftoast button")].find((b) => b.textContent === ${JSON.stringify(label)})?.click(); return 1; })()`);
    const trashRow = async (p) => { await until(`!!document.querySelector(${JSON.stringify(rowSel(p))})`); await click(rowSel(p) + " .more"); await menu("Move to Trash"); };
    const openNb = (p, name, code) => ev(`${W}.create(${JSON.stringify(p)}, { content: { name: ${JSON.stringify(name)}, mode: "python", cells: [{ id: "c", code: ${JSON.stringify(code)} }] } }).then((e) => sagebrush.open(e.ref)).then(() => 1)`);
    const shown = () => ev(`document.querySelector("#nbname").value`);
    const isAt = (p) => ev(`${W}.stat(${JSON.stringify(p)}).then((e) => !!e)`);
    // (the trashing hook held once, at `stage`, by its test-only seam (sagebrush.trashTest.pause, unset in production))
    const holdAt = (stage) => ev(`(() => { window.__b1at = null; sagebrush.trashTest.pause = (s) => { if (s !== ${JSON.stringify(stage)}) return; sagebrush.trashTest.pause = null; window.__b1at = s; return new Promise((r) => (window.__b1go = r)); }; return 1; })()`);
    const reached = () => until(`window.__b1at !== null`, 30000);
    const release = () => ev(`(() => { window.__b1go?.(); return 1; })()`);
    const dismissAny = () => press("✕");
    // (each T case starts on a freshly loaded page, so nothing one leaves (a save that failed and is still pending) can
    // reach the next: the grader's ruling (d)(i) on #447 r2)
    const freshPage = async () => { await go(base); await until(`!!${W}`, 60000); if (await ev(`${S}.hidden`)) await click("#wsfilesbtn"); await until(`!${S}.hidden`); };
    // (its save failing: not moved, and said so, in board's words; it stays open, where it was)
    check((await openNb("/B1 open.ipynb", "B1 open", "first")) === 1 && (await until(`document.querySelector("#nbname").value === "B1 open"`)), "B1: the notebook to trash is open here");
    await ev(`(() => { const nb = sagebrush.notebook; window.__b1saved = nb.saved; nb.saved = () => Promise.reject(new Error("disk full")); return 1; })()`);
    await trashRow("/B1 open.ipynb");
    const refused = await until(`(document.querySelector("#wssidebar .ftoast.err")?.textContent ?? "").startsWith("Not moved to Trash: its changes couldn't be saved (disk full).")`);
    const rs = await ev(`(async () => { const nb = sagebrush.notebook; nb.saved = window.__b1saved; return { shown: document.querySelector("#nbname").value, here: await ${W}.stat("/B1 open.ipynb").then((e) => !!e), trash: await ${W}.stat("/Trash/B1 open.ipynb").then((e) => !!e) }; })()`);
    await shot("b1-error");
    check(refused && rs.shown === "B1 open" && rs.here && !rs.trash, "B1-save: its save failing, it isn't moved: said as an error, and it stays open: " + JSON.stringify(rs));
    await dismissAny();
    // (moved: saved first, another opened in its place; the toast at the foot of the files, under the list, which
    // doesn't move)
    await ev(`(() => { const nb = sagebrush.notebook; nb.setInput(nb.cells()[0], "edited, not saved yet"); return 1; })()`);
    await until(`!!document.querySelector(${JSON.stringify(rowSel("/B1 open.ipynb"))})`);
    const top0 = await ev(`document.querySelector("#wssidebar .ftree").getBoundingClientRect().top`);
    await trashRow("/B1 open.ipynb");
    const moved = await until(`/"B1 open\\.ipynb" moved to Trash/.test(${toastTxt})`);
    const st = await ev(`(async () => { const t = document.querySelector("#wssidebar .ftoast"), tr = document.querySelector("#wssidebar .ftree"); return { shown: document.querySelector("#nbname").value, top: tr.getBoundingClientRect().top, below: t ? t.getBoundingClientRect().top >= tr.getBoundingClientRect().bottom - 1 : null, role: t?.getAttribute("role") ?? null, undo: [...document.querySelectorAll("#wssidebar .ftoast button")].find((b) => b.textContent === "Undo")?.tagName ?? null, trashed: await ${W}.read("/Trash/B1 open.ipynb").then((r) => r.content?.cells?.[0]?.code ?? null).catch((e) => "unread: " + e), here: await ${W}.stat("/B1 open.ipynb").then((e) => !!e) }; })()`);
    check(moved && st.undo === "BUTTON" && st.role === "status" && st.shown !== "B1 open" && !st.here, "B1-move: the open notebook moved to Trash from the file browser, another opened in its place, a status with an Undo button: " + JSON.stringify(st));
    check(st.trashed === "edited, not saved yet", "B1-savedfirst: what it had yet to save was saved first, so Trash has what was last seen: " + JSON.stringify(st.trashed));
    await shot("b1-moved");
    check(st.top === top0 && st.below === true, `B1-place: the toast is under the list, which didn't move: top ${top0} -> ${st.top}, below ${st.below}`);
    // (Undo kept while it holds the focus, past its 10 s)
    await ev(`(() => { [...document.querySelectorAll("#wssidebar .ftoast button")].find((b) => b.textContent === "Undo")?.focus(); return 1; })()`);
    await sleep(11_000);
    check(/"B1 open\.ipynb" moved to Trash/.test(await ev(toastTxt)), "B1-keep: the toast stays past 10 s while its Undo holds the focus");
    await press("Undo");
    const back = await until(`document.querySelector("#nbname").value === "B1 open"`);
    const bk = await ev(`(async () => ({ code: sagebrush.notebook.snapshot().cells[0]?.code ?? null, here: await ${W}.stat("/B1 open.ipynb").then((e) => !!e), trash: await ${W}.stat("/Trash/B1 open.ipynb").then((e) => !!e) }))()`);
    check(back && bk.here && !bk.trash && bk.code === "edited, not saved yet", "B1-undo: Undo puts it back and opens it again, as it was last seen: " + JSON.stringify(bk));
    check(await until(`document.activeElement?.dataset?.path === "/B1 open.ipynb"`, 5000), "B1-undofocus: after Undo the focus is on its row: " + (await ev(`document.activeElement?.dataset?.path ?? document.activeElement?.tagName`)));
    // …and a folder the open notebook is in: the same, another opened that isn't in it
    await openNb("/B1 dir/inner.ipynb", "inner", "inside");
    await until(`document.querySelector("#nbname").value === "inner"`);
    await trashRow("/B1 dir");
    const fmoved = await until(`/"B1 dir" moved to Trash/.test(${toastTxt})`);
    const fs = await ev(`(async () => ({ shown: document.querySelector("#nbname").value, inTrash: await ${W}.stat("/Trash/B1 dir/inner.ipynb").then((e) => !!e) }))()`);
    check(fmoved && fs.shown !== "inner" && fs.inTrash, "B1-folder: a folder holding the open notebook goes to Trash too, another (not in it) opened: " + JSON.stringify(fs));
    await press("Undo");
    check(await until(`document.querySelector("#nbname").value === "inner"`), "B1-folderundo: …and Undo opens the notebook in it again");
    // (astra R1, T2) the path replaced while the hook waits: what is there now is NOT moved, and the conflict is said
    for (const [id, sel, open, moveTo, fresh] of [["T2", "/T2 a.ipynb", "/T2 a.ipynb", "/T2 moved.ipynb", "/T2 a.ipynb"], ["T2.folder", "/T2 dir", "/T2 dir/x.ipynb", "/T2 dir moved", "/T2 dir/new.txt"]]) {
      const nm = open.split("/").pop().replace(/\.ipynb$/, "");
      await freshPage();
      await openNb(open, nm, "t2");
      await until(`document.querySelector("#nbname").value === ${JSON.stringify(nm)}`);
      await holdAt("switched");
      await trashRow(sel);
      const r0 = await reached();
      await ev(`(async () => { await ${W}.rename(${JSON.stringify(sel)}, ${JSON.stringify(moveTo)}); await ${W}.create(${JSON.stringify(fresh)}, { content: ${JSON.stringify(fresh)}.endsWith(".ipynb") ? { name: "REPLACEMENT", mode: "python", cells: [{ id: "r", code: "REPLACEMENT" }] } : "REPLACEMENT" }); return 1; })()`);
      await release();
      const said = await until(`!!document.querySelector("#wssidebar .ftoast.err")`);
      const t = await ev(`(async () => ({ fresh: await ${W}.read(${JSON.stringify(fresh)}).then((r) => typeof r.content === "string" ? r.content : r.content?.cells ? r.content.cells[0]?.code : new TextDecoder().decode(r.content)).catch(() => null), inTrash: await ${W}.stat(${JSON.stringify("/Trash/" + sel.slice(1))}).then((e) => !!e), said: document.querySelector("#wssidebar .ftoast.err")?.textContent ?? "" }))()`);
      check(r0 && said && t.fresh === "REPLACEMENT" && !t.inTrash, `${id}: the path replaced while it waited: what is there now isn't moved, and it is said: ` + JSON.stringify(t));
      await dismissAny();
    }
    // (astra R2, T3) an edit after the save, and ITS save failing: nothing moves, the edit is kept, it stays open
    {
      await freshPage();
      await openNb("/T3.ipynb", "T3", "t3");
      await until(`document.querySelector("#nbname").value === "T3"`);
      await holdAt("saved");
      await trashRow("/T3.ipynb");
      const r0 = await reached();
      await ev(`(() => { const nb = sagebrush.notebook, s = nb.store; window.__t3store = s; window.__t3save = s.save; s.save = () => Promise.reject(new Error("disk full")); nb.setInput(nb.cells()[0], "T3 edit"); return 1; })()`);
      await release();
      const said = await until(`!!document.querySelector("#wssidebar .ftoast.err")`, 20000);
      const t = await ev(`(async () => ({ shown: document.querySelector("#nbname").value, code: sagebrush.notebook.snapshot().cells[0]?.code ?? null, here: await ${W}.stat("/T3.ipynb").then((e) => !!e), inTrash: await ${W}.stat("/Trash/T3.ipynb").then((e) => !!e), said: document.querySelector("#wssidebar .ftoast.err")?.textContent ?? "" }))()`);
      check(r0 && said && t.shown === "T3" && t.code === "T3 edit" && t.here && !t.inTrash, "T3: an edit after the save, its save failing: nothing moves, and the edit is kept, open here: " + JSON.stringify(t));
      await ev(`(async () => { window.__t3store.save = window.__t3save; await sagebrush.notebook.saved().catch(() => {}); return 1; })()`);
      await dismissAny();
    }
    // (astra R2, T4) a page switch in between. T4: while it switched, a notebook INSIDE the folder opened: nothing
    // moves. T4.same: before it switched, another notebook opened: nothing moves, and that one stays open
    {
      await freshPage();
      await ev(`${W}.create("/T4 dir/b.ipynb", { content: { name: "b", mode: "python", cells: [{ id: "c", code: "b" }] } }).then(() => 1)`);
      await openNb("/T4 dir/a.ipynb", "a", "a");
      await until(`document.querySelector("#nbname").value === "a"`);
      await holdAt("switched");
      await trashRow("/T4 dir");
      const r0 = await reached();
      await ev(`${W}.stat("/T4 dir/b.ipynb").then((e) => sagebrush.open(e.ref)).then(() => 1)`);
      await release();
      const said = await until(`!!document.querySelector("#wssidebar .ftoast.err")`, 20000);
      const t = await ev(`(async () => ({ shown: document.querySelector("#nbname").value, here: await ${W}.stat("/T4 dir/b.ipynb").then((e) => !!e), inTrash: await ${W}.stat("/Trash/T4 dir").then((e) => !!e), said: document.querySelector("#wssidebar .ftoast.err")?.textContent ?? "" }))()`);
      check(r0 && said && t.shown === "b" && t.here && !t.inTrash, "T4: a notebook inside the folder opened while it switched: nothing moves, and that notebook stays open: " + JSON.stringify(t));
      await dismissAny();
      await freshPage();
      await ev(`${W}.create("/T4 other.ipynb", { content: { name: "T4 other", mode: "python", cells: [{ id: "c", code: "o" }] } }).then(() => 1)`);
      await openNb("/T4s.ipynb", "T4s", "s");
      await until(`document.querySelector("#nbname").value === "T4s"`);
      await holdAt("saved");
      await trashRow("/T4s.ipynb");
      const r1 = await reached();
      await ev(`${W}.stat("/T4 other.ipynb").then((e) => sagebrush.open(e.ref)).then(() => 1)`);
      await release();
      const said1 = await until(`!!document.querySelector("#wssidebar .ftoast.err")`, 20000);
      const u = await ev(`(async () => ({ shown: document.querySelector("#nbname").value, here: await ${W}.stat("/T4s.ipynb").then((e) => !!e), inTrash: await ${W}.stat("/Trash/T4s.ipynb").then((e) => !!e) }))()`);
      check(r1 && said1 && u.shown === "T4 other" && u.here && !u.inTrash, "T4.same: another notebook opened before it switched: nothing moves, and the one opened stays open: " + JSON.stringify(u));
      await dismissAny();
    }
    // (astra R2 on r2, T5) another notebook opened while Trash's OWN switch waits inside open(), after every check of the
    // hook: that switch is dropped before it detaches anything; nothing moves, and the notebook opened stays open
    {
      await freshPage();
      await ev(`${W}.create("/T5 other.ipynb", { content: { name: "T5 other", mode: "python", cells: [{ id: "c", code: "o" }] } }).then(() => 1)`);
      await openNb("/T5.ipynb", "T5", "t5");
      await until(`document.querySelector("#nbname").value === "T5"`);
      await holdAt("beforeDetach");
      await trashRow("/T5.ipynb");
      const r0 = await reached();
      await ev(`${W}.stat("/T5 other.ipynb").then((e) => sagebrush.open(e.ref)).then(() => 1)`);
      await release();
      const said = await until(`!!document.querySelector("#wssidebar .ftoast.err")`, 20000);
      const t = await ev(`(async () => ({ shown: document.querySelector("#nbname").value, here: await ${W}.stat("/T5.ipynb").then((e) => !!e), inTrash: await ${W}.stat("/Trash/T5.ipynb").then((e) => !!e), said: document.querySelector("#wssidebar .ftoast.err")?.textContent ?? "" }))()`);
      check(r0 && said && t.shown === "T5 other" && t.here && !t.inTrash, "T5: another notebook opened while Trash's own switch waited (after its checks): that switch is dropped, nothing moves, the one opened stays open: " + JSON.stringify(t));
      await dismissAny();
    }
    // (astra R2 on r2, T6) a notebook INSIDE the folder opened after the hook's last check, before the move: the
    // workspace's own check, holding its lock, refuses it; nothing moves, and that notebook stays open
    {
      await freshPage();
      await ev(`${W}.create("/T6 dir/b.ipynb", { content: { name: "b", mode: "python", cells: [{ id: "c", code: "b" }] } }).then(() => 1)`);
      await openNb("/T6 dir/a.ipynb", "a", "a");
      await until(`document.querySelector("#nbname").value === "a"`);
      await holdAt("checked");
      await trashRow("/T6 dir");
      const r0 = await reached();
      await ev(`${W}.stat("/T6 dir/b.ipynb").then((e) => sagebrush.open(e.ref)).then(() => 1)`);
      await release();
      const said = await until(`!!document.querySelector("#wssidebar .ftoast.err")`, 20000);
      const t = await ev(`(async () => ({ shown: document.querySelector("#nbname").value, here: await ${W}.stat("/T6 dir/b.ipynb").then((e) => !!e), inTrash: await ${W}.stat("/Trash/T6 dir").then((e) => !!e), said: document.querySelector("#wssidebar .ftoast.err")?.textContent ?? "" }))()`);
      check(r0 && said && t.shown === "b" && t.here && !t.inTrash, "T6: a notebook inside the folder opened after the last check, before the move: the workspace refuses under its lock, nothing moves: " + JSON.stringify(t));
      await dismissAny();
    }
  }
  // the typed title's rename, its notebook moved and another put at its path
  // while the rename waited for the lock: this notebook gets the name, the
  // other is untouched (CORR-5D2-3)
  const tr = await ev(`(async () => {
    const ref = sagebrush.notebook.store.id, w = ${W};
    const cur = (await w.list("/", { recursive: true })).find((e) => e.kind === "notebook" && e.ref === ref);
    let entered; const ready = new Promise((r) => (entered = r));
    const gate = new Promise((r) => (window.__releaseT = r));
    window.__heldT = navigator.locks.request("sagebrush-workspace", async () => { entered(); await gate; });
    await ready;
    window.__mvT = w.rename(cur.path, "/Moved title.ipynb");
    window.__rpT = w.create(cur.path, { content: { name: "Replacement", mode: "python", cells: [] } });
    return { path: cur.path, ref };
  })()`);
  await until(`navigator.locks.query().then((q) => q.pending.filter((x) => x.name === "sagebrush-workspace" && x.mode === "exclusive").length >= 2)`);
  await typeTitle("Typed title");
  check(await until(`navigator.locks.query().then((q) => q.pending.filter((x) => x.name === "sagebrush-workspace" && x.mode === "exclusive").length >= 3)`, 8000), "(the typed title's rename waiting third for the lock)");
  await ev(`(async () => { __releaseT(); await __heldT; await __mvT; await __rpT; await new Promise((r) => setTimeout(r, 2500)); return 1; })()`);
  const trAfter = await ev(`(async () => { const l = await ${W}.list("/", { recursive: true }); return { typed: l.find((e) => e.path === "/Typed title.ipynb")?.ref ?? null, there: l.find((e) => e.path === ${JSON.stringify(tr.path)})?.ref ?? null }; })()`);
  check(trAfter.typed === tr.ref && trAfter.there && trAfter.there !== tr.ref, "a typed title's rename waiting while its notebook moved and another took its path: this notebook renamed, the other untouched: " + JSON.stringify({ ...trAfter, tr }));
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
  // (grader R1 on #447, T1) open for editing in ANOTHER tab (sync's journal: that tab holds its writer lock): Move to
  // Trash from this tab's files is refused, said as an error, and nothing moves. (The fence switched to the journal
  // for this check only, and put back after it.)
  {
    const FENCE = "__sagebrush-workspace__";
    const idbDo = (body) => ev(`new Promise((ok, no) => { const r = indexedDB.open("sagebrush"); r.onerror = () => no(String(r.error)); r.onsuccess = () => { const db = r.result; const tx = db.transaction("notebooks", "readwrite"), st = tx.objectStore("notebooks"); ${body} }; })`);
    const fence0 = await idbDo(`const g = st.get(${JSON.stringify(FENCE)}); g.onsuccess = () => { db.close(); ok(g.result ?? null); };`);
    const t1 = await ev(`${W}.create("/T1.ipynb", { content: { name: "T1", mode: "python", cells: [{ id: "c", code: "t1" }] } }).then((e) => e.ref)`);
    let t1tab = null, j = { fence: !!fence0 };
    try {
      if (fence0) await idbDo(`st.put(${JSON.stringify({ ...fence0, phase: "journal", journal: 1 })}); tx.oncomplete = () => { db.close(); ok(1); };`);
      t1tab = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base + "?nb=" + encodeURIComponent(t1))}`, { method: "PUT" })).json();
      const wsT = new WebSocket(t1tab.webSocketDebuggerUrl);
      await new Promise((r) => (wsT.onopen = r));
      let nT = 0; const waitT = new Map();
      wsT.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waitT.has(d.id)) { waitT.get(d.id)(d.result ?? d.error); waitT.delete(d.id); } };
      const evT = async (expression) => { const id = ++nT; const r = await new Promise((ok) => { waitT.set(id, ok); wsT.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); }); return r?.result?.value; };
      for (let i = 0; i < 300 && !(await evT(`!!(window.sagebrush?.notebook?.store?.journaled && !sagebrush.notebook.store.viewOnly && sagebrush.notebook.snapshot().name === "T1")`).catch(() => false)); i++) await sleep(100);
      j.writer = await evT(`!!(sagebrush.notebook.store?.journaled && !sagebrush.notebook.store.viewOnly)`).catch(() => false);
      await go(base + "?nb=" + encodeURIComponent(t1));
      j.viewOnly = await until(`!!(${W} && sagebrush.notebook?.store?.journaled && sagebrush.notebook.store.viewOnly && sagebrush.notebook.snapshot().name === "T1")`, 30000);
      if (await ev(`${S}.hidden`)) await click("#wsfilesbtn");
      await until(`!!document.querySelector(${JSON.stringify(rowSel("/T1.ipynb"))})`);
      await click(rowSel("/T1.ipynb") + " .more");
      await menu("Move to Trash");
      j.said = await until(`/open for editing in another tab/.test(document.querySelector("#wssidebar .ftoast.err")?.textContent ?? "")`, 20000);
      j.here = await ev(`${W}.stat("/T1.ipynb").then((e) => !!e)`);
      j.inTrash = await ev(`${W}.stat("/Trash/T1.ipynb").then((e) => !!e)`);
      j.shown = await ev(`document.querySelector("#nbname").value`);
    } finally {
      if (t1tab) await send("Target.closeTarget", { targetId: t1tab.id });
      if (fence0) await idbDo(`st.put(${JSON.stringify(fence0)}); tx.oncomplete = () => { db.close(); ok(1); };`);
      await go(base);
      await until(`!!${W}`, 60000);
    }
    check(j.fence && j.writer && j.viewOnly && j.said && j.here && !j.inTrash && j.shown === "T1", "T1: open for editing in another tab, Move to Trash here is refused, said as an error, and nothing moves: " + JSON.stringify(j));
  }
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
  // (a profile Chrome is still writing as it exits: tried again, and never allowed to lose the checks' report)
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.error("note: the profile wasn't removed: " + (e?.code ?? e)); }
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: the file browser, ${checks} checks`);
process.exit(0);
