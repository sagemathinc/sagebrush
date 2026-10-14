// Present (mount.ts): a slideshow of the board, the whole window (or
// screen): a slide's card fitted, the rest dark; its tour's steps after it,
// each step's words under it (not the page's intro, a slide's speaker
// notes); then the next page, whole; → ← Home End move; code items run;
// Esc (or ✕) leaves, the page, camera and Edit as they were.  Full screen
// where the browser lets it (a click on Present asks); leaving full screen
// (the browser's own Esc) leaves Present too, and the two don't fight.
// ▶ runs an item on a slide.  Serve web/dist
// first (python3 web/serve.py 8765), then
//   node web/board/test-present.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = Number(process.env.CDP_PORT ?? 9469), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1200, H = 900;
const profile = mkdtempSync(join(tmpdir(), "sb-present-prof-"));
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
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const B = "window.sagebrush.board";
const key = async (k, code) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code }); await sleep(500); };
const pixelAt = async (x, y) => {
  const r = await send("Page.captureScreenshot", { format: "png", clip: { x, y, width: 1, height: 1, scale: 1 } });
  return ev(`new Promise((ok) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d"); g.drawImage(i, 0, 0); ok([...g.getImageData(0, 0, 1, 1).data.slice(0, 3)]); }; i.src = "data:image/png;base64,${r.data}"; })`);
};
const click = async (sel) => { const p = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`); for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }); await sleep(150); };
const near = (a, b, d = 6) => a.every((v, i) => Math.abs(v - b[i]) <= d);
// where the card is on the screen
const cardOnScreen = () => ev(`(() => { const s = ${B}.snapshot().doc.pages[0].slide, c = window.board.camera, r = window.board.el.getBoundingClientRect(); return { x0: r.left + (s.x - c.x) * c.z, y0: r.top + (s.y - c.y) * c.z, x1: r.left + (s.x + s.w - c.x) * c.z, y1: r.top + (s.y + s.h - c.y) * c.z }; })()`);
const DOC = {
  title: "A talk",
  pages: [
    { title: "Slide", intro: "Speaker notes: not for the audience", slide: { x: 0, y: 0, w: 1280, h: 720 }, background: { color: "#d7e6fa" },
      nodes: [{ id: "t", title: "The title", text: "Of the talk", x: 60, y: 60 }, { id: "c", title: "Live", code: "x = 6 * 7\nprint(x)", x: 60, y: 360 }],
      steps: [{ focus: "t", say: "The *title*" }, { focus: "c", say: "Some code, live" }] },
    { title: "Plain", nodes: [{ id: "p", title: "A plain page", x: 0, y: 0 }], steps: [{ focus: "p", say: "PAGE TWO STEP" }] },
  ],
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/?runner=0&doc=${encodeURIComponent("examples/primes.json")}` });
  await until(`${B}?.snapshot().items.length > 0`, 60000);
  await ev("localStorage.clear(), 1");
  await ev(`${B}.load(${JSON.stringify(DOC)}).then(() => 1)`);
  await until(`${B}.outputs().then((os) => os.some((o) => o.id === "c" && /42/.test(o.output)))`, 60000);
  // as it was: Edit on, a camera of its own
  await ev("document.querySelector('[data-sbb=edit]').click(), window.board.setCamera({ x: 100, y: 50, z: 0.8 }), window.board.render(), 1");
  await sleep(200);
  const before = await ev("({ ...window.board.camera })");
  // ⋯ Present (clicked: the browser lets it ask for full screen): nothing else of the board's
  await click("[data-sbb=menubtn]");
  await click("[data-sbb=present]");
  check(await until("document.querySelector('.sbb').classList.contains('sbb-present')", 3000), "⋯ Present presents");
  check(await until("document.fullscreenElement === document.querySelector('.sbb')", 3000), "...full screen, where the browser lets it");
  await sleep(600);
  const geo = await ev("(() => { const r = document.querySelector('.sbb').getBoundingClientRect(), b = window.board.el.getBoundingClientRect(); return JSON.stringify({ root: [r.left, r.top, r.width, r.height], board: [b.left, b.top, b.width, b.height], inner: [innerWidth, innerHeight], screen: [screen.width, screen.height], fs: !!document.fullscreenElement }); })()");
  check(await ev(`(() => { const r = document.querySelector('.sbb').getBoundingClientRect(); return r.left === 0 && r.top === 0 && r.width === innerWidth && r.height === innerHeight; })()`), "...the board fills the window (or screen): " + geo);
  check(await ev("['top', 'tour'].every((p) => getComputedStyle(document.querySelector(`[data-sbb=${p}]`)).display === 'none') && getComputedStyle(document.querySelector('.board-toolbar')).display === 'none'"), "...none of its other parts show (the top bar, the caption, the Edit toolbar)");
  // the first frame: the slide's card, fitted, letterboxed
  const fr = await ev(`${B}.present()`);
  check(fr?.frame === 0 && fr.of === 5, "frames: the slide, its two steps, the next page, its step: " + JSON.stringify(fr));
  // (the screen's size: full screen's, or the window's)
  const card = await cardOnScreen(), [w, h] = await ev("[innerWidth, innerHeight]");
  check(Math.abs(card.x0) < 2 && Math.abs(card.x1 - w) < 2 && Math.abs(card.y0 - (h - (card.x1 - card.x0) * 9 / 16) / 2) < 2, "the card fills the screen's width, centered: " + JSON.stringify([card, w, h]));
  const outside = await pixelAt(w / 2, Math.max(2, card.y0 / 2)), inside = await pixelAt(w - 20, card.y1 - 20);
  check(near(outside, [22, 24, 26]) && near(inside, [215, 230, 250]), `around the card, dark (${outside}); on it, its color (${inside})`);
  check(await ev("document.querySelector('[data-sbb=pr-say]').hidden"), "the page's intro (a slide's speaker notes) doesn't show");
  check(await ev(`${B}.outputs().then((os) => os.some((o) => o.id === "c" && /42/.test(o.output) && o.state === ""))`) && await ev("!!document.querySelector('[data-code=c] .board-code-out')?.textContent.includes('42')"), "a code item shows its output, live");
  // ▶ on a slide runs its item
  await ev("(() => { const code = window.board.code, run = code.run.bind(code); window.__ran = []; code.run = (id) => { window.__ran.push(id); return run(id); }; return 1; })()");
  await click("[data-code=c] .board-code-run");
  check((await ev("window.__ran.join()")) === "c" && await until(`${B}.outputs().then((os) => os.some((o) => o.id === "c" && /42/.test(o.output) && o.state === ""))`, 20000), "▶ on a slide runs its item: " + await ev("window.__ran.join()"));
  // → a step: its words under it, the camera on its items
  await key("ArrowRight", 39);
  check(await ev("!document.querySelector('[data-sbb=pr-say]').hidden && /title/.test(document.querySelector('[data-sbb=pr-say]').textContent) && !!document.querySelector('[data-sbb=pr-say] em')") && (await ev("document.querySelector('[data-sbb=pr-where]').textContent")) === "2 / 5", "→: the tour's step, its words under it (Markdown)");
  const t = await ev("(() => { const r = window.board.clientRect('t'); return { w: r.width, l: r.left, r: r.right }; })()");
  check(t.w > 250 && t.l > 0 && t.l + t.w < (await ev("innerWidth")), "...the camera on its item: " + JSON.stringify(t));
  // → → the next page, whole, no card
  await key("ArrowRight", 39);
  await key("ArrowRight", 39);
  check((await ev(`${B}.snapshot().page`)) === 1 && (await ev(`${B}.snapshot().step`)) === -1 && await ev("document.querySelector('[data-sbb=pr-mask]').hidden && document.querySelector('[data-sbb=pr-say]').hidden"), "→ →: the next page, whole, no card");
  await key("ArrowLeft", 37);
  check((await ev(`${B}.snapshot().page`)) === 0 && (await ev("document.querySelector('[data-sbb=pr-where]').textContent")) === "3 / 5", "←: back to the slide's last step");
  await key("Home", 36);
  check((await ev("document.querySelector('[data-sbb=pr-where]').textContent")) === "1 / 5", "Home: the first");
  await key("End", 35);
  check((await ev("document.querySelector('[data-sbb=pr-where]').textContent")) === "5 / 5" && await ev("document.querySelector('[data-sbb=pr-next]').disabled"), "End: the last (the next page's step)");
  // moves overtaken (CORR-2B5-1, daybreak): a page slow to draw (the host's
  // pictures, held), End then Home, done in the other order: Home's frame,
  // not End's step
  await key("Home", 36);
  await ev(`(async () => { const m = await import(new URL("board.js", location.href).href), im = m.host.images, ensure = im.ensure.bind(im); window.__ensure = ensure; window.__gates = []; im.ensure = (names) => new Promise((ok) => window.__gates.push(() => ensure(names).then(ok))); return 1; })()`);
  await ev("(() => { for (const key of ['End', 'Home']) window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); return 1; })()");
  check(await until("window.__gates.length === 2", 3000), "two moves wait for their pages: " + await ev("window.__gates.length"));
  await ev("window.__gates[1](), 1");
  await sleep(300);
  await ev("window.__gates[0](), 1");
  await sleep(600);
  const raced = await ev(`${B}.present().then((p) => ({ p, s: ${B}.snapshot(), say: document.querySelector('[data-sbb=pr-say]').hidden, where: document.querySelector('[data-sbb=pr-where]').textContent }))`);
  check(raced.p?.frame === 0 && raced.s.page === 0 && raced.s.step === -1 && raced.say && raced.where === "1 / 5", "End then Home, drawn in the other order: Home's frame (page 0 whole, no words), not End's: " + JSON.stringify({ p: raced.p, page: raced.s.page, step: raced.s.step, sayHidden: raced.say, where: raced.where }));
  await ev(`import(new URL("board.js", location.href).href).then((m) => { m.host.images.ensure = window.__ensure; return 1; })`);
  // Esc: as it was
  await key("Escape", 27);
  await sleep(300);
  const after = await ev("({ ...window.board.camera })");
  check(await ev("!document.querySelector('.sbb').classList.contains('sbb-present') && getComputedStyle(document.querySelector('[data-sbb=top]')).display !== 'none' && document.querySelector('[data-sbb=pr-bar]').hidden"), "Esc leaves: the board's parts again");
  check((await ev(`${B}.snapshot().page`)) === 0 && Math.abs(after.x - before.x) < 0.01 && Math.abs(after.y - before.y) < 0.01 && Math.abs(after.z - before.z) < 0.001, "...on the page it was on, the camera as it was: " + JSON.stringify([before, after]));
  check(await ev("document.querySelector('[data-sbb=edit]').getAttribute('aria-pressed') === 'true' && !document.querySelector('.board-toolbar').hidden"), "...in Edit, as it was");
  check(await until("!document.fullscreenElement", 3000), "...and out of full screen");
  // the browser leaving full screen itself (its own Esc): Present leaves too, once, as it was
  await click("[data-sbb=menubtn]");
  await click("[data-sbb=present]");
  await until("document.fullscreenElement === document.querySelector('.sbb')", 3000);
  await key("ArrowRight", 39);
  await ev("document.exitFullscreen().then(() => 1)");
  check(await until("!document.querySelector('.sbb').classList.contains('sbb-present')", 3000), "leaving full screen leaves Present");
  await sleep(500);
  const after2 = await ev("({ ...window.board.camera })");
  check(Math.abs(after2.x - before.x) < 0.01 && Math.abs(after2.z - before.z) < 0.001 && (await ev(`${B}.snapshot().page`)) === 0, "...the camera as it was: " + JSON.stringify(after2));
  // ✕ leaves too
  await ev(`${B}.present().then(() => document.querySelector('[data-sbb=pr-exit]').click()).then(() => 1)`);
  check(await until("!document.querySelector('.sbb').classList.contains('sbb-present')", 3000), "✕ leaves too");
  // no full screen (an iPhone's Safari): the window, all of it; Esc leaves
  await ev("Element.prototype.requestFullscreen = undefined, 1");
  await ev(`${B}.present()`);
  await sleep(500);
  check(await ev("!document.fullscreenElement && (() => { const r = document.querySelector('.sbb').getBoundingClientRect(); return r.left === 0 && r.top === 0 && r.width === innerWidth && r.height === innerHeight; })()"), "without full screen, Present fills the window: " + await ev("JSON.stringify({ fs: !!document.fullscreenElement, r: document.querySelector('.sbb').getBoundingClientRect(), inner: [innerWidth, innerHeight], present: document.querySelector('.sbb').classList.contains('sbb-present') })"));
  check(await ev("document.querySelector('.sbb').classList.contains('sbb-present')"), "...and stays presenting (a full screen left earlier doesn't end it)");
  if (process.env.SHOT) { await key("ArrowRight", 39); const r = await send("Page.captureScreenshot", { format: "png" }); (await import("node:fs")).writeFileSync(process.env.SHOT, Buffer.from(r.data, "base64")); }
  await key("Escape", 27);
  check(await ev("!document.querySelector('.sbb').classList.contains('sbb-present')"), "...and Esc leaves it");
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
