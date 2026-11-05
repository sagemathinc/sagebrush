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
  const r = await ev("(() => { const r = window.board.clientRect('n1'); return { x: r.left + r.width / 2, y: r.top + 10 }; })()");
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
  await go("?doc=examples/sagebrush.json");
  ok(!(await editing()), "an example board (not made here) opens in View");
  await press("e");
  ok(await editing(), "…E: Edit");
  await go("?doc=examples/sagebrush.json");
  ok(!(await editing()), "…and an example's mode isn't kept (only this browser's own boards are)");

  // ---- what is kept: this browser's, by kind and id
  const keptKeys = await ev("Object.keys(JSON.parse(localStorage.getItem('sagebrush-doc-modes') ?? '{}'))");
  ok(!keptKeys.includes("board:" + made.slice(11)) && keptKeys.every((k) => /^(board|notebook):[\w-]+$/.test(k)), `what is kept: boards left in Edit, by id (${JSON.stringify(keptKeys).slice(0, 200)})`);
} catch (e) {
  ok(false, "the test ran: " + String(e?.stack ?? e).slice(0, 500));
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
