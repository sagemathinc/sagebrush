// The files sidebar's chrome (web/workspace/sidebar-chrome.ts, William's B3): on the notebook page and the board
// page, the toggle is Sagebrush's logo and an arrow (not a "Files" text button), first in the notebook's bar; the
// sidebar's right edge resizes it, by pointer and by keyboard, the width remembered across a reload and across pages;
// a double click puts it back. In headless Chromium against the built site. SHOT_DIR=dir saves screenshots there.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-files-sidebar.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const shots = process.env.SHOT_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-files-side-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const go = async (url) => { await send("Page.navigate", { url }); await sleep(300); };
const shot = async (name) => {
  if (!shots) return;
  await sleep(300);
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(shots, name + ".png"), Buffer.from(r.data, "base64"));
};
const key = async (k, code) => {
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code: code ?? k, windowsVirtualKeyCode: { ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35 }[k] ?? 0 });
};
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
const fails = [];
let checks = 0;
const check = (ok, what, got) => { checks++; if (!ok) fails.push(got === undefined ? what : `${what}: ${JSON.stringify(got)}`); };
const S = "document.querySelector('#wssidebar')";
const H = "document.querySelector('.sb-filesresize')";
const state = `(() => { const b = document.querySelector('#wsfilesbtn'), s = ${S}, h = ${H};
  return { pressed: b.getAttribute('aria-pressed'), arrow: b.querySelector('.sb-filesarrow')?.textContent, label: b.getAttribute('aria-label'),
    open: !s.hidden, width: s.getBoundingClientRect().width, pad: parseFloat(getComputedStyle(document.body).paddingLeft),
    handle: !!h && !h.hidden, now: h && Number(h.getAttribute('aria-valuenow')) }; })()`;

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await go(base);
  await until(`!!document.querySelector('#wsfilesbtn') && !document.querySelector('#wsfilesbtn').hidden`, 60000);
  // (a fresh profile: the sidebar closed, the default width)
  if (await ev(`!${S}.hidden`)) await ev(`(document.querySelector('#wsfilesbtn').click(), 1)`);
  const btn = await ev(`(() => { const b = document.querySelector('#wsfilesbtn'), bar = b.closest('.bar');
    return { first: bar.querySelector('button:not([hidden]), select:not([hidden])') === b, svg: !!b.querySelector('svg'), text: b.textContent.replace(/\\s+/g, ''),
      label: b.getAttribute('aria-label'), controls: b.getAttribute('aria-controls') }; })()`);
  check(btn.first && btn.svg && btn.label === "Files" && btn.controls === "wssidebar" && btn.text === "›", "B3-button: the notebook bar starts with the logo and an arrow (named Files, controls the sidebar), not a Files text button", btn);
  const closed = await ev(state);
  check(closed.pressed === "false" && closed.arrow === "›" && !closed.open && !closed.handle, "B3-closed: closed: not pressed, the arrow points right, no handle", closed);
  await shot("b3-closed");

  await ev(`(document.querySelector('#wsfilesbtn').click(), 1)`);
  await until(`!${S}.hidden`);
  const open = await ev(state);
  check(open.pressed === "true" && open.arrow === "‹" && open.open && open.handle && open.width === 272 && open.pad === 272 && open.now === 272, "B3-open: open: pressed, the arrow points left, the handle shown, 272 px wide and the page beside it", open);
  await shot("b3-open");

  // the keyboard: focus the handle; → twice (16 px each), Home (the narrowest), End (the widest), Shift+← (64 px)
  await ev(`(${H}.focus(), 1)`);
  await key("ArrowRight"); await key("ArrowRight");
  const k1 = await ev(state);
  check(k1.width === 304 && k1.pad === 304 && k1.now === 304, "B3-keys: → → widens it by 16 px each (the page follows)", k1);
  await key("Home");
  const k2 = await ev(state);
  check(k2.width === 180 && k2.now === 180, "B3-home: Home: the narrowest, 180 px", k2);
  await key("End");
  const k3 = await ev(state);
  const max = await ev(`Math.max(180, Math.min(640, Math.round(innerWidth * 0.6)))`);
  check(k3.width === max && k3.now === max, "B3-end: End: the widest (60% of the window, at most 640 px)", { ...k3, max });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 8 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 8 });
  const k4 = await ev(state);
  check(k4.width === max - 64, "B3-shift: Shift+← narrows it by 64 px", { ...k4, max });

  // the pointer: drag the handle to x = 400
  const hx = await ev(`(() => { const r = ${H}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: 300 }; })()`);
  await mouse("mouseMoved", hx.x, hx.y, { buttons: 0 });
  await mouse("mousePressed", hx.x, hx.y);
  for (const x of [hx.x - 40, 450, 400]) await mouse("mouseMoved", x, hx.y);
  await mouse("mouseReleased", 400, hx.y);
  const d = await ev(state);
  check(d.width === 400 && d.pad === 400 && d.now === 400, "B3-drag: dragged to x = 400: 400 px, and the page beside it", d);
  check(!(await ev(`document.body.classList.contains('sb-resizing')`)), "B3-drag-end: after the drag, the page isn't left in resizing mode");
  await shot("b3-resized");

  // remembered: a reload opens it at the same width
  await go(base);
  await until(`!!document.querySelector('#wsfilesbtn') && !${S}.hidden`, 60000);
  const re = await ev(state);
  check(re.open && re.width === 400 && re.now === 400 && re.arrow === "‹", "B3-kept: after a reload, open at 400 px (remembered in this browser)", re);

  // the board page: the same toggle and width
  const ref = await ev(`window.sagebrush.workspace.create("/B3 board.board.json").then((e) => e.ref)`);
  await go(`${base}board/?doc=local:${ref}`);
  await until(`!!document.querySelector('[data-sbb="files"]') && !${S}.hidden`, 60000);
  const bd = await ev(`(() => { const b = document.querySelector('[data-sbb="files"]'), s = ${S}, h = ${H}, board = document.getElementById('board');
    return { svg: !!b.querySelector('svg'), label: b.getAttribute('aria-label'), arrow: b.querySelector('.sb-filesarrow')?.textContent, pressed: b.getAttribute('aria-pressed'),
      width: s.getBoundingClientRect().width, left: board.getBoundingClientRect().left, handle: !!h && !h.hidden }; })()`);
  check(bd.svg && bd.label === "Files" && bd.arrow === "‹" && bd.pressed === "true" && bd.width === 400 && bd.left === 400 && bd.handle, "B3-board: the board page: the same logo toggle, open at the remembered 400 px, the board beside it, with the handle", bd);
  await shot("b3-board");
  // a double click on the handle: back to 272 px
  const bh = await ev(`(() => { const r = ${H}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: 300 }; })()`);
  await mouse("mousePressed", bh.x, bh.y); await mouse("mouseReleased", bh.x, bh.y);
  await mouse("mousePressed", bh.x, bh.y, { clickCount: 2 }); await mouse("mouseReleased", bh.x, bh.y, { clickCount: 2 });
  const back = await ev(`({ width: ${S}.getBoundingClientRect().width, left: document.getElementById('board').getBoundingClientRect().left })`);
  check(back.width === 272 && back.left === 272, "B3-reset: a double click on the handle: back to 272 px", back);
  // closing it: no handle, the board at the left edge
  await ev(`(document.querySelector('[data-sbb="files"]').click(), 1)`);
  const shut = await ev(`({ open: !${S}.hidden, handle: !${H}.hidden, left: document.getElementById('board').getBoundingClientRect().left, arrow: document.querySelector('[data-sbb="files"] .sb-filesarrow').textContent })`);
  check(!shut.open && !shut.handle && shut.left === 0 && shut.arrow === "›", "B3-board-closed: closed on the board page: no handle, the board at the left edge, the arrow points right", shut);
  check(errors.length === 0, "B3-errors: no page errors", errors.slice(0, 3));
} catch (e) {
  fails.push("threw: " + String(e?.stack ?? e).slice(0, 600));
} finally {
  ws.close();
  // (Chrome writes its profile until it has exited: wait for that, then remove it, retrying)
  const gone = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await Promise.race([gone, sleep(5000)]);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
if (fails.length) {
  console.log(`FAIL: ${fails.length} of ${checks} checks`);
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
console.log(`ok: the files sidebar's chrome, ${checks} checks`);
