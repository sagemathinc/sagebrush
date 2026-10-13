// Boards on a phone: an iPhone-sized screen with touch.  The top bar fits
// on one line; Edit shows the toolbar (with Undo, there being no Ctrl+Z);
// a double tap on a code item opens its editor as a sheet, whose buttons
// stay in view when the keyboard takes half the screen; typing and Run
// work; the toolbar's Note opens one too.  Serve web/dist first (python3
// web/serve.py 8765), then
//   node web/board/test-mobile.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = 9455, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 390, H = 844;
const profile = mkdtempSync(join(tmpdir(), "sb-mobile-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const tap = async (x, y) => {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
const tapEl = async (sel) => { const r = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`); await tap(r.x, r.y); };
const inView = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const b = e.getBoundingClientRect(), v = window.visualViewport; return b.width > 0 && b.top >= v.offsetTop - 1 && b.bottom <= v.offsetTop + v.height + 1 && b.left >= -1 && b.right <= innerWidth + 1; })()`);
try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  await ev("localStorage.clear()");
  await until("window.sagebrush.board.outputs().then((os) => os.every((o) => o.state === ''))", 90000);
  check(await ev("matchMedia('(pointer: coarse)').matches"), "the emulated phone has a coarse pointer");
  // the top bar: one line, every control in view
  check(await ev("document.getElementById('top').offsetHeight < 60"), `the top bar wraps (${await ev("document.getElementById('top').offsetHeight")} px)`);
  check(await ev("[...document.querySelectorAll('#top button, #top select')].filter((e) => e.offsetParent).every((e) => { const b = e.getBoundingClientRect(); return b.right <= innerWidth + 1 && b.left >= -1; })"), "a top bar control is off screen");
  // Edit: the toolbar, in view, with Undo
  await tapEl("#edit");
  await until("!document.querySelector('.board-toolbar').hidden", 5000);
  check(await inView(".board-toolbar"), "the toolbar is in view");
  check(await ev("!!document.querySelector('.board-toolbar [data-tool=undo]')"), "Undo is in the toolbar on a touch screen");
  // its tools are drawn icons, at least 22 px, in buttons at least 40 px
  check(await ev("[...document.querySelectorAll('.board-toolbar button[data-tool]')].every((b) => { const s = b.querySelector('.tb-i svg')?.getBoundingClientRect(), r = b.getBoundingClientRect(); return s && s.width >= 22 && r.width >= 40 && r.height >= 40; })"), "the toolbar's icons are drawings of a readable size");
  // the top bar's ⋯ menu opens over the toolbar, not under it
  await tapEl("#menubtn");
  check(await ev("(() => { const t = document.querySelector('.board-toolbar').getBoundingClientRect(); const hit = [...document.querySelectorAll('#menu button')].find((b) => { const r = b.getBoundingClientRect(); return r.bottom > t.top && r.top < t.bottom && r.right > t.left && r.left < t.right; }); if (!hit) return 'no overlap'; const r = hit.getBoundingClientRect(), x = Math.max(r.left, t.left) + 4, y = (Math.max(r.top, t.top) + Math.min(r.bottom, t.bottom)) / 2; return document.getElementById('menu').contains(document.elementFromPoint(x, y)); })()") === true, "the ⋯ menu is above the toolbar");
  await tapEl("#menubtn");
  // a double tap on a code item, in Edit: its editor, a sheet with its buttons in view
  await ev("window.board.focus(['start'], true)");
  await sleep(400);
  const c = await ev("(() => { const r = window.board.clientRect('start'); return { x: r.left + r.width / 2, y: r.top + 12 }; })()");
  await tap(c.x, c.y);
  await sleep(80);
  await tap(c.x, c.y);
  check(await until("!!document.querySelector('.board-editor.be-sheet .be-code')", 5000), "a double tap in Edit opens the code editor, as a sheet");
  check(await inView(".board-editor .be-done"), "its Run button is in view");
  check(await ev("(() => { const p = document.querySelector('.board-editor'), d = p.querySelector('.be-done').getBoundingClientRect(), t = p.querySelector('.be-code').getBoundingClientRect(); return d.top < t.top; })()"), "the buttons come before the code");
  // the keyboard: half the screen (the visual viewport shrinks)
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: 400, deviceScaleFactor: 3, mobile: true });
  await sleep(400);
  check(await inView(".board-editor .be-done"), "with the keyboard up, Run is still in view");
  check(await ev("document.querySelector('.board-editor').getBoundingClientRect().bottom <= window.visualViewport.height + 1"), "the sheet fits above the keyboard");
  // typing and Run
  await ev("(() => { const ta = document.querySelector('.board-editor .be-code'); ta.focus(); ta.select(); })()");
  await send("Input.insertText", { text: "start = 6" });
  await tapEl(".board-editor .be-done");
  check(await until("window.sagebrush.board.outputs().then((os) => /^8 steps/.test(os.find((x) => x.id === 'path').output))", 30000), "Run on the phone ran the change");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 3, mobile: true });
  // the toolbar's Note: a sheet too; Undo takes the change back
  await ev("window.sagebrush.board.editing(true)");
  const n0 = await ev("window.sagebrush.board.snapshot().doc.nodes.length");
  await tapEl(".board-toolbar [data-tool=note]");
  check(await until("!!document.querySelector('.board-editor.be-sheet .be-title')", 5000), "Note opens its editor as a sheet");
  await ev("document.querySelector('.board-editor .be-title').focus()");
  await send("Input.insertText", { text: "From the phone" });
  await tapEl(".board-editor .be-done");
  await sleep(400);
  check((await ev("window.sagebrush.board.snapshot().doc.nodes.length")) === n0 + 1, "the note was added");
  await tapEl(".board-toolbar [data-tool=undo]");
  await sleep(400);
  check((await ev("window.sagebrush.board.snapshot().doc.nodes.length")) === n0, "Undo took it back");
  // editing a note on the phone, in Edit: a tap on the note selected, or a double tap
  await ev("window.sagebrush.board.editing(true), window.board.focus(['about'], true)");
  await sleep(500);
  const ab = await ev("(() => { const r = window.board.clientRect('about'); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  await tap(ab.x, ab.y);
  await sleep(600);
  await tap(ab.x, ab.y);
  check(await until("!!document.querySelector('.board-editor.be-sheet .be-title')", 3000), "a tap on the note selected opens its editor");
  await tapEl(".board-editor .be-cancel");
  await sleep(600);
  await tap(ab.x, ab.y);
  await sleep(80);
  await tap(ab.x, ab.y);
  check(await until("!!document.querySelector('.board-editor.be-sheet .be-title')", 3000), "a double tap opens a note's editor in Edit");
  await tapEl(".board-editor .be-cancel");
  check(!errors.length, "errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
