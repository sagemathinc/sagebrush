// Boards on a phone: an iPhone-sized screen with touch.  The top bar fits
// on one line; Edit shows the toolbar (with Undo, there being no Ctrl+Z);
// a double tap on a code item opens its editor as a sheet, whose buttons
// are a thin row under the Edit toolbar, in view when the keyboard takes
// half the screen; typing and Run work; the toolbar's Note opens one too.
// The page does not zoom (double taps are the board's), and the tour's
// caption is a line until tapped.  Two fingers, the first on a note in
// Edit, pinch: the board zooms, the note stays.  Presenting, the faded
// controls come back with a tap, and a tap on one only shows it; a phone
// turned fits the frame to the turned screen.  Every control has a name in
// words for a screen reader.  Serve web/dist first (python3
// web/serve.py 8765), then
//   node web/board/test-mobile.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 390, H = 844;
const profile = mkdtempSync(join(tmpdir(), "sb-mobile-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
  // the page does not zoom: a double tap or a pinch is the board's
  check(await ev("/maximum-scale=1/.test(document.querySelector('meta[name=viewport]').content) && getComputedStyle(document.querySelector('.sbb')).touchAction === 'manipulation'"), "the page itself does not zoom");
  // the tour's caption: a line; a tap shows it whole, and the board keeps clear of it
  const sayH = () => ev("document.querySelector('[data-sbb=say]').getBoundingClientRect().height");
  const line = await ev("parseFloat(getComputedStyle(document.querySelector('[data-sbb=say]')).lineHeight) || 20");
  const h1 = await sayH();
  check(!(await ev("document.querySelector('[data-sbb=tour]').hidden")) && h1 <= line * 1.5, `the tour's caption is one line (${h1} px)`);
  await tapEl("[data-sbb=say]");
  await sleep(200);
  const h2 = await sayH();
  check(h2 > line * 2.5, `a tap shows the whole caption (${h2} px)`);
  check(await ev("window.board.insets.bottom >= document.querySelector('[data-sbb=tour]').offsetHeight"), "the board keeps clear of the whole caption");
  await tapEl("[data-sbb=next]");
  await sleep(200);
  check((await sayH()) <= line * 1.5, "the next step's caption is a line again");
  await tapEl("[data-sbb=prev]");
  // the top bar: one line, every control in view
  check(await ev("document.querySelector('[data-sbb=top]').offsetHeight < 60"), `the top bar wraps (${await ev("document.querySelector('[data-sbb=top]').offsetHeight")} px)`);
  check(await ev("[...document.querySelectorAll('[data-sbb=top] button, [data-sbb=top] select')].filter((e) => e.offsetParent).every((e) => { const b = e.getBoundingClientRect(); return b.right <= innerWidth + 1 && b.left >= -1; })"), "a top bar control is off screen");
  // Edit: the toolbar, in view, with Undo
  await tapEl("[data-sbb=edit]");
  await until("!document.querySelector('.board-toolbar').hidden", 5000);
  check(await inView(".board-toolbar"), "the toolbar is in view");
  check(await ev("!!document.querySelector('.board-toolbar [data-tool=undo]')"), "Undo is in the toolbar on a touch screen");
  // every control a screen reader meets has a name in words, not a glyph (✎, ⤢, ⋯, ←, ↶, ▶, { })
  {
    // (a code item in view, its ▶ drawn: items are in the page only while
    // in view, and where the tour's last flight left the camera varies)
    await ev("window.board.focus(['start'], true)");
    check(await until("!!document.querySelector('[data-code=start] .board-code-run')", 10000), "the code item 'start', in view, has its ▶");
    await send("Accessibility.enable");
    const { nodes } = await send("Accessibility.getFullAXTree");
    const glyphs = nodes.filter((x) => !x.ignored && ["button", "combobox", "link", "menuitem", "slider", "checkbox"].includes(x.role?.value) && !/[A-Za-z]{2}/.test(x.name?.value ?? "")).map((x) => x.role.value + " " + JSON.stringify(x.name?.value ?? ""));
    check(!glyphs.length && nodes.some((x) => x.role?.value === "button" && x.name?.value === "Run"), "every control has a name in words for a screen reader: " + glyphs.join(", "));
  }
  // its tools are drawn icons, at least 22 px, in buttons at least 40 px
  check(await ev("[...document.querySelectorAll('.board-toolbar button[data-tool]')].every((b) => { const s = b.querySelector('.tb-i svg')?.getBoundingClientRect(), r = b.getBoundingClientRect(); return s && s.width >= 22 && r.width >= 40 && r.height >= 40; })"), "the toolbar's icons are drawings of a readable size");
  // the top bar's ⋯ menu opens over the toolbar, not under it
  await tapEl("[data-sbb=menubtn]");
  check(await ev("(() => { const t = document.querySelector('.board-toolbar').getBoundingClientRect(); const hit = [...document.querySelectorAll('[data-sbb=menu] button')].find((b) => { const r = b.getBoundingClientRect(); return r.bottom > t.top && r.top < t.bottom && r.right > t.left && r.left < t.right; }); if (!hit) return 'no overlap'; const r = hit.getBoundingClientRect(), x = Math.max(r.left, t.left) + 4, y = (Math.max(r.top, t.top) + Math.min(r.bottom, t.bottom)) / 2; return document.querySelector('[data-sbb=menu]').contains(document.elementFromPoint(x, y)); })()") === true, "the ⋯ menu is above the toolbar");
  await tapEl("[data-sbb=menubtn]");
  // a double tap on a code item, in Edit: its editor, a sheet with its buttons in view
  await ev("window.board.focus(['start'], true)");
  await sleep(400);
  const c = await ev("(() => { const r = window.board.clientRect('start'); return { x: r.left + r.width / 2, y: r.top + 12 }; })()");
  await tap(c.x, c.y);
  await sleep(80);
  await tap(c.x, c.y);
  check(await until("!!document.querySelector('[data-code=start].board-editing .be-code')", 5000), "a double tap in Edit makes the code item editable where it is");
  const under = "(() => { const b = document.querySelector('.ip-bar').getBoundingClientRect(), t = document.querySelector('.board-toolbar').getBoundingClientRect(), v = window.visualViewport; return Math.abs(b.top - Math.max(t.bottom, v.offsetTop)) <= 1 && b.height <= 40; })()";
  check(await until("!!document.querySelector('.ip-bar.ip-dock')", 3000) && await inView(".ip-bar .ip-run"), "its toolbar is in view, with run");
  check(await ev(under), "its toolbar is a thin row right under the Edit toolbar: " + await ev("JSON.stringify([document.querySelector('.ip-bar').getBoundingClientRect(), document.querySelector('.board-toolbar').getBoundingClientRect()])"));
  check(await inView(".ip-bar"), "the whole row is on screen");
  // the keyboard: half the screen (the visual viewport shrinks)
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: 400, deviceScaleFactor: 3, mobile: true });
  await sleep(400);
  check(await inView(".ip-bar .ip-run"), "with the keyboard up, run is still in view");
  check(await ev(under), "with the keyboard up, the toolbar is still under the Edit toolbar");
  check(await ev("(() => { const t = document.querySelector('.board-editing .be-code').getBoundingClientRect(), b = document.querySelector('.ip-bar').getBoundingClientRect(), v = window.visualViewport; return t.top >= b.bottom && t.top + 20 <= v.offsetTop + v.height; })()"), "the code being written is in view, between the toolbar and the keyboard: " + await ev("JSON.stringify([document.querySelector('.board-editing .be-code').getBoundingClientRect(), document.querySelector('.ip-bar').getBoundingClientRect()])"));
  // the colors open below the row, on screen
  await tapEl(".ip-bar .ip-color");
  check(await until("!!document.querySelector('.ip-colors')", 2000) && await ev("document.querySelector('.ip-colors').getBoundingClientRect().top >= document.querySelector('.ip-bar').getBoundingClientRect().bottom") && await inView(".ip-colors"), "the colors open below the toolbar, in view");
  await tapEl(".ip-bar .ip-color");
  // typing and run
  await ev("(() => { const ta = document.querySelector('.board-editing .be-code'); ta.focus(); ta.select(); })()");
  await send("Input.insertText", { text: "start = 6" });
  await tapEl(".ip-bar .ip-run");
  check(await until("window.sagebrush.board.outputs().then((os) => /^8 steps/.test(os.find((x) => x.id === 'path').output))", 30000), "Run on the phone ran the change");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 3, mobile: true });
  // the toolbar's Note: written where it is; Undo takes it back
  await ev("window.sagebrush.board.editing(true)");
  const n0 = await ev("window.sagebrush.board.snapshot().doc.nodes.length");
  await tapEl(".board-toolbar [data-tool=note]");
  check(await until("document.activeElement === document.querySelector('.board-editing .be-title')", 5000), "Note adds a note, its title being written");
  await send("Input.insertText", { text: "From the phone" });
  await tapEl("[data-sbb=top]");
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
  check(await until("!!document.querySelector('.board-editing .be-title')", 3000), "a tap on the note selected edits it where it is");
  await tapEl("[data-sbb=top]");
  await sleep(600);
  check(await ev("!document.querySelector('.board-editing')"), "a tap elsewhere leaves it");
  await tap(ab.x, ab.y);
  await sleep(80);
  await tap(ab.x, ab.y);
  check(await until("!!document.querySelector('.board-editing .be-title')", 3000), "a double tap edits a note in Edit");
  await tapEl("[data-sbb=top]");
  await sleep(600);
  // its text's blocks: a tap writes in one, a tap on another (the first, shown again, is now two) writes in that one
  await ev("window.sagebrush.board.edit((d) => { d.nodes.find((x) => x.id === 'about').text = 'First block\\n\\nSecond block\\n\\nThird block'; }).then(() => 1)");
  await ev("window.board.focus(['about'], true)");
  await sleep(500);
  const ab2 = await ev("(() => { const r = window.board.clientRect('about'); return { x: r.left + r.width / 2, y: r.top + 14 }; })()");
  await tap(ab2.x, ab2.y);
  await sleep(80);
  await tap(ab2.x, ab2.y);
  await until("!!document.querySelector('.board-editing .mb')", 3000);
  const blockMid = (i) => ev(`(() => { const r = document.querySelector('.board-editing .mb').children[${i}].getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
  let bm = await blockMid(0);
  await tap(bm.x, bm.y);
  check(await until("document.activeElement?.closest?.('.mb-edit') && document.activeElement.value === 'First block'", 3000), "a tap on a block writes in it: " + await ev("document.activeElement?.value"));
  await ev("(() => { const t = document.activeElement; t.value = 'First\\n\\nblock, now two'; t.dispatchEvent(new Event('input')); return 1; })()");
  bm = await blockMid(2);
  await tap(bm.x, bm.y);
  check(await until("document.activeElement?.closest?.('.mb-edit') && document.activeElement.value === 'Third block'", 3000), "a tap on another block writes in that one: " + await ev("document.activeElement?.value"));
  await tapEl("[data-sbb=top]");
  check(await until("window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 'about').text === 'First\\n\\nblock, now two\\n\\nSecond block\\n\\nThird block'", 3000), "what was written is kept: " + await ev("JSON.stringify(window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 'about').text)"));
  // in Edit, two fingers, the first on a note: a pinch (the board zooms), not a drag of the note
  {
    const touch = (type, pts) => send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
    await ev("window.sagebrush.board.editing(true), window.board.focus(['start'], true)");
    await sleep(500);
    const z0 = await ev("window.board.camera.z"), at0 = await ev("JSON.stringify(window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 'start'))");
    const p = await ev("(() => { const r = window.board.clientRect('start'); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    await touch("touchStart", [[p.x - 20, p.y]]);
    await touch("touchMove", [[p.x - 24, p.y]]);
    await touch("touchStart", [[p.x - 24, p.y], [p.x + 20, p.y]]);
    for (let k = 1; k <= 8; k++) { await touch("touchMove", [[p.x - 24 - 7 * k, p.y], [p.x + 20 + 7 * k, p.y]]); await sleep(16); }
    await touch("touchEnd", []);
    await sleep(400);
    const z1 = await ev("window.board.camera.z"), at1 = await ev("JSON.stringify(window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 'start'))");
    // (the fingers 44 px apart, then 156: the board zooms by about that, the note where it was)
    check(Math.abs(z1 / z0 - 156 / 44) < 0.2 && at1 === at0 && !(await ev("document.querySelector('.board-item.dragging')")), "a pinch that starts on a note, in Edit: the board zooms, the note stays: " + JSON.stringify({ zoom: z1 / z0, note: at1 === at0 ? "the same" : [at0, at1] }));
  }
  // Present on a phone: the controls, faded while nothing moves, come back with a tap; a tap where a faded control is only brings them back
  {
    const deck = { title: "A talk", pages: [{ title: "Slide", slide: { x: 0, y: 0, w: 1280, h: 720 }, nodes: [{ id: "t", title: "The title", x: 60, y: 60 }], steps: [{ focus: "t", say: "The title" }] }, { title: "Two", nodes: [{ id: "p", title: "Page two" }] }] };
    await ev(`window.sagebrush.board.load(${JSON.stringify(deck)}).then(() => 1)`);
    await sleep(500);
    await ev("window.sagebrush.board.present().then(() => 1)");
    await sleep(2900);
    const idle = () => ev("document.querySelector('.sbb').classList.contains('sbb-idle')"), where = () => ev("document.querySelector('[data-sbb=pr-where]').textContent");
    const faded = await idle();
    await tap(W / 2, H / 3);
    await sleep(200);
    const back = !(await idle());
    await sleep(2900);
    const f0 = await where(), fadedAgain = await idle();
    await tapEl("[data-sbb=pr-next]");
    await sleep(500);
    const f1 = await where(), shown = !(await idle());
    await tapEl("[data-sbb=pr-next]");
    await sleep(500);
    const f2 = await where();
    check(faded && back && fadedAgain && f1 === f0 && shown && f2 !== f0, "Present on a phone: the faded controls come back with a tap; a tap on a faded control only shows it, the next presses it: " + JSON.stringify({ faded, back, fadedAgain, f0, f1, shown, f2 }));
    // the phone turned on a step: the step's item fitted again, whole and in the middle of the turned screen
    await ev("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })), 1");
    await ev("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })), 1");
    await sleep(700);
    await send("Emulation.setDeviceMetricsOverride", { width: H, height: W, deviceScaleFactor: 2, mobile: true });
    await sleep(700);
    const fit = await ev("(() => { const r = window.board.clientRect('t'), b = window.board.el.getBoundingClientRect(); return { inside: r.left >= b.left - 1 && r.top >= b.top - 1 && r.left + r.width <= b.right + 1 && r.top + r.height <= b.bottom + 1, dx: Math.round(r.left + r.width / 2 - (b.left + b.width / 2)), dy: Math.round(r.top + r.height / 2 - (b.top + b.height / 2)), w: b.width }; })()");
    check(fit.inside && Math.abs(fit.dx) < 40 && Math.abs(fit.dy) < 40 && fit.w === H, "Present, a phone turned on a step: its item fitted again to the turned screen, whole and in the middle: " + JSON.stringify(fit));
    await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 3, mobile: true });
    await ev("window.sagebrush.board.present(false).then(() => 1)");
  }
  check(!errors.length, "errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
