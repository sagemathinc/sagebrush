// ci: web-browser/board-c order=150
// Boards open in View mode (web/doc-mode.ts; William, Nov 4), in headless Chromium against web/dist: a board made
// here opens in Edit, and keeps opening in Edit until the person leaves it in View; one left in View opens in View;
// a board not made here (an example) opens in View; E switches to Edit and Esc back to View, but never while typing
// in a field, and Esc with something selected is the editor's; the Edit control says the shortcut. Serve web/dist
// first (python3 web/serve.py 8765), then
//   node web/board/test-doc-mode-board.mjs
// (boards of this browser's own, on the fallback: ?workspace=0, as test-local.mjs)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-mode-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
let failures = 0;
const ok = (c, what) => { console.log((c ? "ok   " : "FAIL ") + what); if (!c) failures++; };

const noWs = (q) => q + (q.includes("?") ? "&" : "?") + "workspace=0";
const go = async (q) => {
  await send("Page.navigate", { url: `${base}board/${noWs(q)}` });
  await until("!!window.sagebrush?.board?.snapshot && window.sagebrush.board.snapshot().doc !== null", 60000);
  await sleep(300);
};
const editing = () => ev("document.querySelector('[data-sbb=edit]').getAttribute('aria-pressed') === 'true'");
const title = () => ev("document.querySelector('[data-sbb=edit]').title");
const search = () => ev("location.search.replace(/([?&])workspace=0(&|$)/, (m, a, b) => (b ? a : ''))");
// (a key as the person presses it: to the page, where focus is)
const press = async (key, code = key === "Escape" ? "Escape" : "Key" + key.toUpperCase()) => {
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, code, text: type === "keyDown" && key.length === 1 ? key : undefined, windowsVirtualKeyCode: key === "Escape" ? 27 : key.toUpperCase().charCodeAt(0) });
  await sleep(150);
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  // ---- a board made here: Edit, and again on the next visit
  await go("?new=python");
  await until("document.querySelector('[data-sbb=edit]').getAttribute('aria-pressed') === 'true'", 10000);
  const made = await search();
  ok(/^\?doc=local:[0-9a-f]{12}$/.test(made) && (await editing()), `a board made here opens in Edit (${made})`);
  ok((await title()) === "Editing: Esc for View", `…and the Edit control says how to leave it ("${await title()}")`);
  await ev("window.sagebrush.board.edit((d) => { d.nodes = [{ id: 'n1', title: 'a note' }]; }).then(() => 1)");
  await go(made);
  ok(await editing(), "…and opens in Edit again on the next visit, not blank any more (made here)");

  // ---- Esc: back to View, and remembered
  await ev("document.activeElement?.blur?.(), 1");
  await press("Escape");
  ok(!(await editing()), "Esc, nothing selected: back to View");
  ok((await title()) === "Edit (E)", `…the control says the shortcut ("${await title()}")`);
  await go(made);
  ok(!(await editing()), "…left in View: it opens in View");

  // ---- E: Edit, and remembered; never while typing
  await press("e");
  ok(await editing(), "E: Edit");
  await go(made);
  ok(await editing(), "…left in Edit: it opens in Edit");
  await ev("(() => { const b = document.querySelector('[data-sbb=edit]'); b.click(); return 1; })()");
  ok(!(await editing()), "the Edit control: back to View");
  await go(made);
  ok(!(await editing()), "…remembered too");
  // (focus in a field: E types there, nothing switches)
  await ev("(() => { const i = document.createElement('input'); i.id = 'probe'; document.body.append(i); i.focus(); return 1; })()");
  await press("e");
  ok(!(await editing()) && (await ev("document.getElementById('probe').value")) === "e", "E while typing in a field types e, and stays in View");
  await ev("(() => { document.querySelector('[data-sbb=edit]').click(); return 1; })()");
  await ev("document.getElementById('probe').focus(), 1");
  await press("Escape");
  ok(await editing(), "Esc while typing in a field keeps its own meaning: still in Edit");
  await ev("document.getElementById('probe').remove(), 1");
  // (Esc with a note selected: the editor's (the selection goes), still in Edit; then Esc: View)
  // (the note in the middle of the view, clear of the top bar and the Edit toolbar, then a click on its middle)
  await ev("(window.board.focus(['n1']), 1)");
  await sleep(400);
  const r = await ev("(() => { const r = window.board.clientRect('n1'); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  await sleep(250);
  ok(await ev("window.board.grip === 'n1'"), "(a click selects the note)");
  await press("Escape");
  ok((await editing()) && (await ev("window.board.grip !== 'n1'")), "Esc with a note selected: the selection goes, still in Edit");
  await press("Escape");
  ok(!(await editing()), "Esc, nothing selected: View");
  // (a modifier: nothing)
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "e", code: "KeyE", modifiers: 2, windowsVirtualKeyCode: 69 });
  await sleep(150);
  ok(!(await editing()), "Ctrl+E: nothing (the browser's)");

  // ---- a board not made here (an example): View
  await go("?doc=examples/sagebrush.board.json");
  ok(!(await editing()), "an example board (not made here) opens in View");
  await press("e");
  ok(await editing(), "…E: Edit");
  await go("?doc=examples/sagebrush.board.json");
  ok(!(await editing()), "…and an example's mode isn't kept (only this browser's own boards are)");

  // ---- View writes nothing (@sagebrush's ruling on #658): undo and redo, a menu's edit, slow code's previews
  await go("?new=python");
  await until("document.querySelector('[data-sbb=edit]').getAttribute('aria-pressed') === 'true'", 10000);
  const nodes = () => ev("JSON.stringify((window.sagebrush.board.snapshot().doc.nodes ?? []).map((n) => n.id))");
  // (an edit in Edit, through the page's API: a step to undo)
  await ev("window.sagebrush.board.edit((d) => { (d.nodes ??= []).push({ id: 'u1', title: 'one', x: 0, y: 0 }); }).then(() => 1)");
  ok((await nodes()) === JSON.stringify(["u1"]), "(an edit in Edit)");
  await ev("document.activeElement?.blur?.(), 1");
  await press("Escape");
  ok(!(await editing()), "(back to View)");
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "z", code: "KeyZ", modifiers: 2, windowsVirtualKeyCode: 90 });
  await sleep(400);
  ok((await nodes()) === JSON.stringify(["u1"]), "Ctrl+Z in View: nothing undone (View writes nothing)");
  await press("e");
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "z", code: "KeyZ", modifiers: 2, windowsVirtualKeyCode: 90 });
  await until(`(${JSON.stringify("[]")}) === JSON.stringify((window.sagebrush.board.snapshot().doc.nodes ?? []).map((n) => n.id))`, 5000);
  ok((await nodes()) === "[]", "…in Edit, Ctrl+Z undoes it");
  // (the page's API writes in View too: an agent's edit, under its own grants, ruling 3)
  await press("Escape");
  await ev("window.sagebrush.board.edit((d) => { (d.nodes ??= []).push({ id: 'a1', title: 'by an agent', x: 0, y: 0 }); }).then(() => 1)");
  ok(!(await editing()) && (await nodes()) === JSON.stringify(["a1"]), "an edit through the page's API (an agent's) is made in View: its own grants");
  // (a menu's edit in View: the board goes to Edit first, and the change is made there)
  const pagesBefore = await ev("window.sagebrush.board.snapshot().pages");
  await ev("document.querySelector('[data-sbb=addpage]').click(), 1");
  await until(`window.sagebrush.board.snapshot().pages === ${pagesBefore + 1}`, 5000);
  ok((await editing()) && (await ev("window.sagebrush.board.snapshot().pages")) === pagesBefore + 1, "Add page chosen in View: Edit first, then the page added");
  await ev("window.sagebrush.board.page(0)").catch(() => {});
  // (slow code's output: shown in View, its preview not kept in the document; in Edit, kept: a board of its own)
  await go("?new=python");
  await until("document.querySelector('[data-sbb=edit]').getAttribute('aria-pressed') === 'true'", 10000);
  await ev("document.activeElement?.blur?.(), 1");
  await press("Escape");
  ok(!(await editing()), "(a new board, in View)");
  await ev("window.sagebrush.board.edit((d) => { d.nodes = [{ id: 'c1', title: 'code', code: 'print(6*7)', x: 0, y: 0, w: 300 }]; }).then(() => 1)");
  await ev("window.sagebrush.board.setPreviewThreshold(0), 1");
  const ran = await ev("window.sagebrush.board.run().then((os) => JSON.stringify(os.map((o) => [o.id, o.output])))");
  await sleep(1500);
  ok(/"c1","42\\n"/.test(ran) && !(await ev("!!window.sagebrush.board.snapshot().doc.nodes[0].preview")), `code run in View: its output shown (${ran}), its preview not kept in the document`);
  await press("e");
  await ev("window.sagebrush.board.run().then(() => 1)");
  ok(await until("!!window.sagebrush.board.snapshot().doc.nodes[0].preview", 10000), "…run in Edit: its preview kept (as before)");

  // ---- what is kept: this browser's, by kind and id
  const keptKeys = await ev("Object.keys(JSON.parse(localStorage.getItem('sagebrush-doc-modes') ?? '{}'))");
  ok(!keptKeys.includes("board:" + made.slice(11)) && keptKeys.every((k) => /^(board|notebook):[\w-]+$/.test(k)), `what is kept: boards left in Edit, by id (${JSON.stringify(keptKeys).slice(0, 200)})`);

  // ---- undo started in Edit while a note is being written, the board left for View as it waits (astra's
  // MODE658-UNDO-1): the note's words are kept (typed in Edit), and nothing is undone
  await go("?new=python");
  await until("document.querySelector('[data-sbb=edit]').getAttribute('aria-pressed') === 'true'", 10000);
  await ev("window.sagebrush.board.edit((d) => { (d.nodes ??= []).push({ id: 'w1', title: 'first', x: 0, y: 0, w: 300 }); }).then(() => 1)");
  await ev("window.sagebrush.board.edit((d) => { d.nodes.push({ id: 'w2', title: 'second', x: 0, y: 200, w: 300 }); }).then(() => 1)");
  await ev("window.board.focus(['w1'], true), window.board.render(), 1");
  await sleep(300);
  await ev("(() => { const r = window.board.clientRect('w1'); const x = r.left + 30, y = r.top + 12; document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y })); return 1; })()");
  ok(await until("!!document.querySelector('.ip-bar')", 3000), "(a note is being written, in Edit)");
  await send("Input.insertText", { text: " typed" });
  await sleep(200);
  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })), window.sagebrush.board.editing(false), 1");
  await sleep(1200);
  const after = await ev("JSON.stringify(window.sagebrush.board.snapshot().doc.nodes.map((n) => [n.id, n.title ?? '', n.text ?? '']))");
  ok(!(await editing()) && /"w1"/.test(after) && /"w2"/.test(after) && /typed/.test(after), `Ctrl+Z, then View while the note's words were being kept: kept, nothing undone (${after})`);
  // (redo the same way: a step undone in Edit, a note open (unchanged: a change would clear the redo step), Ctrl+Shift+Z,
  // then View as it waits: nothing redone)
  await press("e");
  ok(await editing(), "(Edit again)");
  await ev("document.activeElement?.blur?.(), 1");
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "z", code: "KeyZ", modifiers: 2, windowsVirtualKeyCode: 90 });
  await sleep(600);
  const undone = await ev("JSON.stringify(window.sagebrush.board.snapshot().doc.nodes.map((n) => [n.id, n.title ?? '']))");
  ok(!/typed/.test(undone), `(a step undone in Edit: ${undone})`);
  await ev("window.board.focus(['w1'], true), window.board.render(), 1");
  await sleep(300);
  await ev("(() => { const r = window.board.clientRect('w1'); const x = r.left + 30, y = r.top + 12; document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y })); return 1; })()");
  ok(await until("!!document.querySelector('.ip-bar')", 3000), "(a note is being written, in Edit)");
  await sleep(200);
  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true })), window.sagebrush.board.editing(false), 1");
  await sleep(1200);
  const after2 = await ev("JSON.stringify(window.sagebrush.board.snapshot().doc.nodes.map((n) => [n.id, n.title ?? '']))");
  ok(!(await editing()) && !/typed/.test(after2), `Ctrl+Shift+Z, then View while the note was being closed: nothing redone (${after2})`);

  // ---- a host that doesn't let edit (grader's B3, B5): a remembered Edit, E, the control and the page's API all
  // leave it in View, and nothing is kept
  await go("?doc=examples/sagebrush.board.json");
  await ev("import('/board/board.js').then((m) => m.mounted.destroy()).then(() => 1)");
  await ev(`import('/board/board.js').then((m) => { window.__kept = []; const store = { ...m.host.store, editing: (f) => { f({ allowed: false, why: "Not here" }); return () => {}; } }; window.__b = m.mountBoard(document.getElementById("board"), { ...m.host, store, mode: { start: true, toggled: (on) => window.__kept.push(on) } }); return 1; })`);
  await until("!!window.__b?.agent && !!document.querySelector('[data-sbb=edit]')", 20000);
  await sleep(500);
  ok(!(await editing()) && (await ev("document.querySelector('[data-sbb=edit]').hasAttribute('disabled')")), "a board remembered in Edit, on a host that doesn't let edit: it opens in View, Edit disabled");
  await ev("document.activeElement?.blur?.(), 1");
  await press("e");
  ok(!(await editing()), "…E: still View");
  await ev("document.querySelector('[data-sbb=edit]').onclick(), 1");
  ok(!(await editing()), "…the control's own handler: still View");
  await ev("window.__b.agent.editing(true), 1");
  ok(!(await editing()), "…the page's API asking for Edit: still View (the host's say)");
  ok((await ev("JSON.stringify(window.__kept)")) === "[]", `…and nothing kept (${await ev("JSON.stringify(window.__kept)")})`);

  // (a host that offers no Edit at all, `hidden` (grader's A2), though it says allowed: the same, every way)
  const remount = async (state) => {
    await go("?doc=examples/sagebrush.board.json");
    await ev("import('/board/board.js').then((m) => m.mounted.destroy()).then(() => 1)");
    await ev(`import('/board/board.js').then((m) => { window.__kept = []; window.__setEditing = null; const store = { ...m.host.store, editing: (f) => { window.__setEditing = f; f(${JSON.stringify(state)}); return () => {}; } }; window.__b = m.mountBoard(document.getElementById("board"), { ...m.host, store, mode: { start: true, toggled: (on) => window.__kept.push(on) } }); return 1; })`);
    await until("!!window.__b?.agent && !!document.querySelector('[data-sbb=edit]')", 20000);
    await sleep(500);
  };
  await remount({ allowed: true, hidden: true });
  ok(!(await editing()), "a host that offers no Edit (hidden), a board remembered in Edit: View");
  await ev("document.activeElement?.blur?.(), 1");
  await press("e");
  ok(!(await editing()), "…E: still View");
  await ev("window.__b.agent.editing(true), 1");
  ok(!(await editing()), "…the page's API asking for Edit: still View");
  ok((await ev("JSON.stringify(window.__kept)")) === "[]", `…and nothing kept (${await ev("JSON.stringify(window.__kept)")})`);

  // (a host that takes Edit away while the board is in Edit (grader's A4): View, Edit disabled; then a menu's edit
  // (grader's I2) changes nothing, and doesn't move the board to another page)
  await remount({ allowed: true });
  ok(await until("document.querySelector('[data-sbb=edit]').getAttribute('aria-pressed') === 'true'", 5000), "(Edit allowed, a remembered Edit: in Edit)");
  await ev("window.__b.agent.edit((d) => { if (!d.pages) { const { nodes, edges } = d; delete d.nodes; delete d.edges; d.pages = [{ title: 'One', nodes: nodes ?? [], edges: edges ?? [] }]; } d.pages.push({ title: 'Two', nodes: [{ id: 'p2n', title: 'on page two' }] }); }).then(() => 1)");
  await ev("Promise.resolve(window.__b.agent.page(1)).then(() => 1)");
  ok(await until("window.__b.agent.snapshot().page === 1", 5000), "(a board of pages, on its second)");
  await ev("window.__setEditing({ allowed: false, why: 'Taken back' }), 1");
  await sleep(200);
  ok(!(await editing()) && (await ev("document.querySelector('[data-sbb=edit]').hasAttribute('disabled')")), "the host takes Edit away while the board is in Edit: View, Edit disabled");
  const docBefore = await ev("JSON.stringify(window.__b.agent.snapshot().doc)");
  await ev("document.querySelector('[data-sbb=addpage]').click(), 1");
  await sleep(600);
  await ev("document.querySelector('[data-sbb=tidy]').click(), 1");
  await sleep(600);
  ok((await ev("JSON.stringify(window.__b.agent.snapshot().doc)")) === docBefore && (await ev("window.__b.agent.snapshot().page")) === 1 && !(await editing()), `…Add page and Tidy chosen then: the board unchanged, still on its page, in View (page ${await ev("window.__b.agent.snapshot().page")})`);

  // (an HTML download in View with another engine (grader's G1): the download uses it, the board is left as it is)
  await remount({ allowed: true });
  await ev("document.activeElement?.blur?.(), 1");
  await press("Escape");
  ok(!(await editing()), "(a board in View)");
  await send("Browser.setDownloadBehavior", { behavior: "deny" });
  const engineBefore = await ev("JSON.stringify(window.__b.agent.snapshot().doc.engine ?? null)");
  await ev("(() => { for (const r of document.querySelectorAll('[data-sbb=htmlform] input[name=engine]')) r.checked = r.value === 'latest'; document.querySelector('[data-sbb=html-go]').click(); return 1; })()");
  await sleep(1500);
  ok(engineBefore === "null" && (await ev("JSON.stringify(window.__b.agent.snapshot().doc.engine ?? null)")) === "null" && !(await editing()), `an HTML download in View choosing another engine: the board's engine unchanged (${engineBefore} -> ${await ev("JSON.stringify(window.__b.agent.snapshot().doc.engine ?? null)")})`);
} catch (e) {
  ok(false, "the test ran: " + String(e?.stack ?? e).slice(0, 500));
} finally {
  chrome.kill();
  await sleep(300);
  // (Chromium may still be writing its profile as it exits: retried, and never the test's verdict, as web/test-board.mjs)
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
