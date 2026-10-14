// Drawing on a board (Edit: the Draw and Erase tools, pen.ts's row,
// board.ts): the toolbar's Draw shows the pen row; a drag draws, shown as
// it goes, kept when let go, in the row's color and width; a mouse's
// pressure is its speed's, a pen's its own; a finger draws, until a pen has
// drawn (then it pans: a palm on the screen draws nothing); a second finger
// drops the stroke and pinches; the eraser removes what a drag goes across,
// and one Undo brings it all back; Esc stops.  With Draw off, a stroke is
// an item: picked on it (not in a loop's empty middle, where the note under
// it is), dragged, deleted, selected by a rectangle.  Serve web/dist first
// (python3 web/serve.py 8765), then
//   node web/board/test-ink-draw.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = Number(process.env.CDP_PORT ?? 9467), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-draw-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1200,1100", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
const until = async (expr, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const B = "window.sagebrush.board";
const strokes = () => ev(`${B}.snapshot().doc.nodes.filter((x) => x.kind === "ink")`);
const notes = () => ev(`${B}.snapshot().doc.nodes.filter((x) => x.kind !== "ink").map((x) => x.id).join()`);
const camera = () => ev("({ ...window.board.camera })");
const toClient = (x, y) => ev(`(() => { const r = window.board.el.getBoundingClientRect(), c = window.board.camera; return { x: r.left + (${x} - c.x) * c.z, y: r.top + (${y} - c.y) * c.z }; })()`);
const pixel = async (x, y) => {
  const r = await send("Page.captureScreenshot", { format: "png", clip: { x: x - 1, y: y - 1, width: 3, height: 3, scale: 1 } });
  return ev(`new Promise((ok) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = 3; c.height = 3; const g = c.getContext("2d"); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, 3, 3).data; let best = [255, 255, 255]; for (let k = 0; k < 36; k += 4) if (d[k] + d[k + 1] + d[k + 2] < best[0] + best[1] + best[2]) best = [d[k], d[k + 1], d[k + 2]]; ok(best); }; i.src = "data:image/png;base64,${r.data}"; })`);
};
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
// a drag through screen points (a mouse, or a pen with a force at each)
const drag = async (pts, extra = () => ({})) => {
  await mouse("mousePressed", pts[0][0], pts[0][1], extra(0));
  for (let i = 1; i < pts.length; i++) await mouse("mouseMoved", pts[i][0], pts[i][1], extra(i));
  await mouse("mouseReleased", pts.at(-1)[0], pts.at(-1)[1], extra(pts.length - 1));
  await sleep(250);
};
const touch = (type, points) => send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
const key = async (k, code, mods = 0) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code, modifiers: mods }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code, modifiers: mods }); await sleep(250); };
const line = (x0, y0, x1, y1, k = 25) => Array.from({ length: k }, (_, i) => [x0 + ((x1 - x0) * i) / (k - 1), y0 + ((y1 - y0) * i) / (k - 1)]);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.navigate", { url: `${base}board/?runner=0&doc=${encodeURIComponent("examples/primes.json")}` });
  await until(`${B}?.snapshot().items.length > 0`, 60000);
  await ev("localStorage.clear(), 1");
  await ev(`${B}.load({ title: "Draw", nodes: [{ id: "n1", title: "A note", text: "Draw over me, and around me.", x: 0, y: 0, w: 240 }] }).then(() => 1)`);
  await ev("window.board.setCamera({ x: -300, y: -250, z: 1 }), window.board.render(), 1");
  await ev("document.querySelector('[data-sbb=edit]').click(), 1");
  await until("!document.querySelector('.board-toolbar').hidden", 3000);
  // Draw, on the toolbar: the pen row, its choice the person's default
  check(await ev("!!document.querySelector('.board-toolbar [data-tool=draw]')"), "Draw is on the Edit toolbar");
  await ev("document.querySelector('.board-toolbar [data-tool=draw]').click(), 1");
  check(await until("!document.querySelector('.ink-row').hidden", 2000), "Draw shows the pen row");
  check(await ev("(() => { const r = document.querySelector('.ink-row').getBoundingClientRect(), t = document.querySelector('.board-toolbar').getBoundingClientRect(); return r.top >= t.bottom && r.top - t.bottom < 12; })()"), "...just under the Edit toolbar");
  check(await ev("[...document.querySelectorAll('.ink-row [aria-pressed=true]')].map((b) => b.title).join() === 'Black,Medium'"), "...black, medium: " + await ev("[...document.querySelectorAll('.ink-row [aria-pressed=true]')].map((b) => b.title).join()"));
  // blue, thick: a drag draws, shown as it goes, kept when let go
  await ev("document.querySelector('.ink-row [title=Blue]').click(), document.querySelector('.ink-row [title=Thick]').click(), 1");
  const a = await toClient(-100, 150);
  await mouse("mousePressed", a.x, a.y);
  for (const [x, y] of line(a.x, a.y, a.x + 300, a.y, 30).slice(1)) await mouse("mouseMoved", x, y);
  await sleep(100);
  const mid = await pixel(a.x + 150, a.y);
  check(mid[2] > mid[0] + 60 && (await strokes()).length === 0, `a stroke shows as it is drawn (blue ${mid}), and is kept only when let go`);
  await mouse("mouseReleased", a.x + 300, a.y);
  await sleep(250);
  let ss = await strokes();
  check(ss.length === 1 && ss[0].color === "#1d4ed8" && ss[0].size === 6 && ss[0].points.length >= 6, "let go, the stroke is the board's, in the row's color and width: " + JSON.stringify(ss).slice(0, 200));
  check(Math.abs(ss[0].x - (-100 - 6)) < 2 && Math.abs(ss[0].y - (150 - 6)) < 2, "...where it was drawn: " + JSON.stringify([ss[0].x, ss[0].y]));
  check(await ev("JSON.parse(localStorage.getItem('sagebrush-board-pen')).color === '#1d4ed8'"), "the pen's choice is kept, the person's");
  // a mouse: its pressure is its speed's (slow, then fast)
  await ev("document.querySelector('.ink-row [title=Medium]').click(), 1");
  const b = await toClient(-100, 250);
  await drag([...line(b.x, b.y, b.x + 60, b.y, 30), ...line(b.x + 60, b.y, b.x + 400, b.y, 6).slice(1)]);
  ss = await strokes();
  // (its points' pressure where it went slowly, and where fast)
  const at = (s, x0, x1) => { const ps = []; for (let i = 0; i < s.points.length; i += 3) if (s.x + s.points[i] >= x0 && s.x + s.points[i] <= x1) ps.push(s.points[i + 2]); return ps; };
  const slow = at(ss[1], -95, -30), fast = at(ss[1], 100, 300);
  check(slow.length && fast.length && Math.min(...slow) > Math.max(...fast) + 0.05, `a mouse's pressure is its speed's: slow ${slow.map((p) => p.toFixed(2))}, fast ${fast.map((p) => p.toFixed(2))}`);
  // a finger draws (no pen yet)
  const c = await toClient(-100, 330);
  await touch("touchStart", [[c.x, c.y]]);
  for (const [x, y] of line(c.x, c.y, c.x + 200, c.y + 30, 15).slice(1)) await touch("touchMove", [[x, y]]);
  await touch("touchEnd", []);
  await sleep(250);
  check((await strokes()).length === 3, "a finger draws, while no pen has drawn");
  // a second finger: the stroke is dropped, the two pinch
  const z0 = (await camera()).z, d = await toClient(-100, 420);
  await touch("touchStart", [[d.x, d.y]]);
  await touch("touchMove", [[d.x + 20, d.y]]);
  await touch("touchStart", [[d.x + 20, d.y], [d.x + 120, d.y]]);
  for (let k = 1; k <= 8; k++) await touch("touchMove", [[d.x + 20 - k * 10, d.y], [d.x + 120 + k * 10, d.y]]);
  await touch("touchEnd", []);
  await sleep(250);
  check((await strokes()).length === 3 && (await camera()).z > z0 * 1.2, `a second finger drops the stroke and pinches: ${(await strokes()).length} strokes, zoom ${z0} to ${(await camera()).z}`);
  await ev("window.board.setCamera({ x: -300, y: -250, z: 1 }), window.board.render(), 1");
  // a pen: its own pressure
  const e = await toClient(-100, 500);
  await drag(line(e.x, e.y, e.x + 300, e.y, 20), (i) => ({ pointerType: "pen", force: 0.1 + (0.8 * i) / 19 }));
  ss = await strokes();
  const pp = ss[3]?.points.filter((_, i) => i % 3 === 2) ?? [];
  check(ss.length === 4 && pp[0] < 0.2 && pp.at(-1) > 0.8, "a pen draws with its own pressure: " + pp.map((p) => p.toFixed(2)).join(" "));
  // ...and from then on a finger pans (a palm on the screen draws nothing)
  const cx = (await camera()).x, f = await toClient(-100, 560);
  await touch("touchStart", [[f.x, f.y]]);
  for (const [x, y] of line(f.x, f.y, f.x + 200, f.y, 10).slice(1)) await touch("touchMove", [[x, y]]);
  await touch("touchEnd", []);
  await sleep(250);
  check((await strokes()).length === 4 && (await camera()).x < cx - 100, `once a pen has drawn, a finger pans: ${(await strokes()).length} strokes, camera x ${cx} to ${(await camera()).x}`);
  await ev("window.board.setCamera({ x: -300, y: -250, z: 1 }), window.board.render(), 1");
  // the eraser: what a drag goes across goes (shown faded meanwhile); one Undo brings it all back
  await ev("document.querySelector('.ink-row .ink-e').click(), 1");
  check(await ev("document.querySelector('.ink-row .ink-e').getAttribute('aria-pressed') === 'true' && window.board.el.classList.contains('erasing')"), "the row's eraser: Erase on");
  const g = await toClient(0, 130);
  await drag(line(g.x, g.y, g.x, g.y + 140, 20));
  ss = await strokes();
  // (the first two, at y 150 and 250, were across its way; the finger's and the pen's, below, not)
  check(ss.length === 2 && ss.every((s) => s.y > 300), `the eraser removes the strokes a drag goes across: ${ss.length} left: ${JSON.stringify(ss.map((s) => [s.x, s.y]))}`);
  await key("z", 90, 2);
  check((await strokes()).length === 4, "one Undo brings them all back");
  // Esc: no more drawing or erasing
  await key("Escape", 27);
  check(await ev("document.querySelector('.ink-row').hidden && !window.board.el.classList.contains('erasing') && !window.board.el.classList.contains('drawing')"), "Esc stops erasing (and drawing): the row goes");
  // with Draw off, a stroke is an item: picked on it, 3 pixels from it, not in a loop's empty middle
  const pen = (await strokes()).find((s) => s.points.length && s.points[2] < 0.2);
  // (half way along it: a straight stroke keeps only its ends)
  const k = pen.points.length - 3, h = await toClient(pen.x + (pen.points[0] + pen.points[k]) / 2, pen.y + (pen.points[1] + pen.points[k + 1]) / 2);
  await mouse("mousePressed", h.x, h.y - 4); await mouse("mouseReleased", h.x, h.y - 4);
  await sleep(150);
  const picked = await ev("[...window.board.selection].join()");
  await key("Delete", 46);
  check((await strokes()).length === 3 && !(await strokes()).some((s) => s.id === pen.id), "a click a few pixels from a thin stroke picks it (Delete removes it): selected " + picked + ", the pen's " + pen.id);
  await key("z", 90, 2);
  // a loop around the note: a click in its middle is the note's
  await ev("document.querySelector('.board-toolbar [data-tool=draw]').click(), 1");
  const loop = [];
  for (let k = 0; k <= 40; k++) { const p = await toClient(120 + Math.cos((k / 40) * 2 * Math.PI) * 190, 40 + Math.sin((k / 40) * 2 * Math.PI) * 90); loop.push([p.x, p.y]); }
  await drag(loop);
  await key("Escape", 27);
  const lid = (await strokes()).at(-1).id;
  const m = await toClient(120, 40);
  await mouse("mousePressed", m.x, m.y); await mouse("mouseReleased", m.x, m.y);
  await sleep(150);
  await key("Delete", 46);
  check((await notes()) === "" && (await strokes()).some((s) => s.id === lid), "a click in a loop's empty middle picks the note under it, not the loop");
  await key("z", 90, 2);
  // dragged, it moves
  const L = (await strokes()).find((s) => s.id === lid), lp = await toClient(L.x + L.points[0], L.y + L.points[1]);
  // (Alt: not snapped to the others)
  await drag(line(lp.x, lp.y, lp.x + 100, lp.y + 50, 10), () => ({ modifiers: 1 }));
  const L2 = (await strokes()).find((s) => s.id === lid), zz = (await camera()).z;
  check(Math.abs(L2.x - L.x - 100 / zz) < 2 && Math.abs(L2.y - L.y - 50 / zz) < 2, `a stroke is dragged: moved by (${(L2.x - L.x).toFixed(1)}, ${(L2.y - L.y).toFixed(1)})`);
  // a rectangle selects strokes (Select's drag), Delete removes them
  await ev("document.querySelector('.board-toolbar .tb-more').click(), 1");
  await ev("[...document.querySelectorAll('.board-toolbar-panel .tb-use')].find((b) => /Select/.test(b.textContent))?.click(), document.querySelector('.board-toolbar .tb-more').click(), 1");
  await sleep(150);
  const r0 = await toClient(-130, 120), r1 = await toClient(260, 210);
  await drag(line(r0.x, r0.y, r1.x, r1.y, 8));
  const inRect = await ev("[...window.board.selection].join()");
  await key("Delete", 46);
  ss = await strokes();
  check(ss.length === 3 && !ss.some((s) => s.y < 200), `a rectangle selects the strokes it holds: ${ss.length} strokes left; selected ${inRect}; selecting ${await ev("window.board.el.classList.contains('selecting')")}`);
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
