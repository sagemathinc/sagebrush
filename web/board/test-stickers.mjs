// Stickers (doc.ts DocSticker, stickers.ts, board.ts): an emoji or a CoCalc
// icon by name, drawn without a frame, the emoji as tall as the sticker; an
// icon the host draws when it can, else the emoji close to it, else a mark
// named by its tooltip; only one emoji, only an icon's name, else no
// sticker; drawn far out too; printed; an item as a note is (dragged, held
// by a rectangle); kept in the board's file; in a JSON Canvas an emoji is a
// text card and an icon is left out, said so.  In Edit: Sticker in ⋯ (not
// on the toolbar) opens a picker of 48 emoji and Picture…; an emoji chosen
// is a sticker, selected; its corner resizes it, square; a double-click or
// Enter opens the picker for it, an emoji chosen replacing an icon; Esc or
// a press outside closes it.  Serve web/dist first (python3 web/serve.py
// 8765), then
//   node web/board/test-stickers.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = Number(process.env.CDP_PORT ?? 9471), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-stickers-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1200,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
const toClient = (x, y) => ev(`(() => { const r = window.board.el.getBoundingClientRect(), c = window.board.camera; return { x: r.left + (${x} - c.x) * c.z, y: r.top + (${y} - c.y) * c.z }; })()`);
const pixel = async (x, y) => {
  const p = await toClient(x, y);
  const r = await send("Page.captureScreenshot", { format: "png", clip: { x: p.x - 3, y: p.y - 3, width: 7, height: 7, scale: 1 } });
  return ev(`new Promise((ok) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = c.height = 7; const g = c.getContext("2d"); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, 7, 7).data; let best = [255, 255, 255]; for (let k = 0; k < d.length; k += 4) if (d[k] + d[k + 1] + d[k + 2] < best[0] + best[1] + best[2]) best = [d[k], d[k + 1], d[k + 2]]; ok(best); }; i.src = "data:image/png;base64,${r.data}"; })`);
};
const DOC = {
  title: "Stickers",
  nodes: [
    { id: "n", title: "A note", x: 0, y: 0 },
    { id: "e", kind: "sticker", emoji: "🚀", x: 400, y: 0, w: 100 },
    { id: "k", kind: "sticker", icon: "star", x: 600, y: 0, w: 60 },
    { id: "u", kind: "sticker", icon: "cocalc-unknown", color: "#c0392b", x: 700, y: 0, w: 60 },
    { id: "p", kind: "sticker", emoji: "👩🏽‍💻", x: 400, y: 200, w: 120 },
    // (not one emoji, or not an icon's name: no sticker)
    { id: "x1", kind: "sticker", emoji: "🚀🚀", x: 0, y: 300 },
    { id: "x2", kind: "sticker", emoji: "ok", x: 0, y: 300 },
    { id: "x3", kind: "sticker", emoji: "\u0007", x: 0, y: 300 },
    { id: "x4", kind: "sticker", emoji: "1\ufe0f\u20e3", x: 0, y: 300 },
    { id: "x5", kind: "sticker", emoji: "👩‍👩‍👧‍👦\u200d👩‍👩‍👧‍👦", x: 0, y: 300 },
    { id: "x6", kind: "sticker", icon: "Star", x: 0, y: 300 },
    { id: "x7", kind: "sticker", icon: "-star", x: 0, y: 300 },
    { id: "x8", kind: "sticker", icon: "a".repeat(65), x: 0, y: 300 },
    { id: "x9", kind: "sticker", image: "pic", x: 0, y: 300 },
  ],
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/?runner=0&doc=${encodeURIComponent("examples/primes.json")}` });
  await until(`${B}?.snapshot().items.length > 0`, 60000);
  await ev("localStorage.clear(), 1");
  await ev(`${B}.load(${JSON.stringify(DOC)}).then(() => 1)`);
  await until(`!!window.board.item("p")`, 5000);
  await ev("window.board.setCamera({ x: -50, y: -50, z: 1 }), window.board.render(), 1");
  await sleep(400);
  // only one emoji, or an icon's name: else no sticker
  const kept = (await ev(`${B}.snapshot().doc`)).nodes.map((x) => x.id).join();
  check(kept === "n,e,k,u,p,x4", "only one emoji (a keycap is one), or an icon's name: " + kept);
  // drawn: no frame; the emoji as tall as the sticker; an icon as its emoji, or a mark with its name
  const els = await ev(`Object.fromEntries(["e", "k", "u", "p"].map((id) => { const el = window.board.cache.get(id); return [id, el && { text: el.textContent, title: el.title, border: getComputedStyle(el).borderTopWidth, bg: getComputedStyle(el).backgroundColor, h: el.getBoundingClientRect().height, fs: el.querySelector(".board-sticker-glyph") && parseFloat(getComputedStyle(el.querySelector(".board-sticker-glyph")).fontSize), color: el.querySelector(".board-sticker-glyph")?.style.color, img: !!el.querySelector("img") }]; }))`);
  check(els.e && els.e.text === "🚀" && els.e.border === "0px" && els.e.bg === "rgba(0, 0, 0, 0)" && Math.abs(els.e.fs - 80) < 2, "an emoji sticker: no frame, the emoji 80% of its height: " + JSON.stringify(els.e));
  check(els.k?.text === "⭐" && els.k.title === "star", "a CoCalc icon close to an emoji: the emoji, its name as its tooltip: " + JSON.stringify(els.k));
  check(els.u?.text === "●" && els.u.title === "cocalc-unknown" && els.u.color === "rgb(192, 57, 43)", "an icon with no emoji close: a mark in its color, its name as its tooltip: " + JSON.stringify(els.u));
  check(els.p?.text === "👩🏽‍💻" && Math.abs(els.p.h - 120) < 1.5, "an emoji of several code points: one sticker, square: " + JSON.stringify(els.p));
  // the host draws an icon when it can
  // (the host's hook is there before the board is drawn: a board shown afresh)
  await ev(`window.board.icon = (name) => { const i = document.createElement("i"); i.className = "host-icon"; i.textContent = "[" + name + "]"; return i; }; ${B}.load({ title: "Empty", nodes: [{ id: "z", title: "Z" }] }).then(() => ${B}.load(${JSON.stringify(DOC)})).then(() => 1)`);
  await until(`!!document.querySelector(".board-sticker .host-icon")`, 5000);
  check(await ev(`[...document.querySelectorAll(".board-sticker .host-icon")].map((i) => i.textContent).sort().join() === "[cocalc-unknown],[star]"`), "the host draws CoCalc's icons when it can");
  await ev("window.board.icon = null, 1");
  // far out: the emoji drawn on the canvas
  await ev("window.board.setCamera({ x: -2000, y: -1500, z: 0.2 }), window.board.render(), 1");
  await sleep(400);
  const far = await pixel(450, 50);
  check(far[0] + far[1] + far[2] < 600, "far out, an emoji sticker is still drawn: " + far);
  await ev("window.board.setCamera({ x: -50, y: -50, z: 1 }), window.board.render(), 1");
  await sleep(300);
  // printed
  await ev(`${B}.print({ dialog: false }).then(() => 1)`);
  check(await ev(`(() => { const t = document.querySelector("#board-print .pr-sheet")?.textContent ?? ""; return /🚀/.test(t) && /⭐/.test(t) && document.querySelectorAll("#board-print .board-sticker").length === 5; })()`), "printed: the stickers");
  await ev("document.getElementById('board-print')?.remove(), 1");
  // an item as a note is: dragged; held by a rectangle
  await ev("document.querySelector('[data-sbb=edit]').click(), 1");
  await sleep(200);
  const s0 = await ev(`window.board.item("e")`), a = await toClient(s0.x + s0.w / 2, s0.y + s0.h / 2);
  await mouse("mousePressed", a.x, a.y);
  for (let k = 1; k <= 8; k++) await mouse("mouseMoved", a.x + k * 10, a.y + k * 5);
  await mouse("mouseReleased", a.x + 80, a.y + 40);
  await sleep(400);
  const e1 = (await ev(`${B}.snapshot().doc`)).nodes.find((x) => x.id === "e");
  check(Math.abs(e1.x - 480) < 4 && Math.abs(e1.y - 40) < 4, "a sticker is dragged as a note is: " + JSON.stringify([e1.x, e1.y]));
  check((await ev("window.board.itemsIn(350, -100, 800, 400).map((i) => i.id).sort().join()")) === "e,k,p,u", "a rectangle holds stickers: " + await ev("window.board.itemsIn(350, -100, 800, 400).map((i) => i.id).sort().join()"));
  // the board's file keeps them; a JSON Canvas leaves them out, and says so
  const file = await ev(`${B}.json()`);
  check(/"kind": "sticker",\n\s+"emoji": "🚀"/.test(file) && /"icon": "cocalc-unknown"/.test(file), "the board's file keeps its stickers");
  const cv = await ev(`${B}.canvas()`);
  const cards = JSON.parse(cv.text).nodes.filter((x) => x.type === "text").map((x) => x.text).sort().join();
  check(/2 stickers/.test(cv.left) && cards.includes("🚀") && cards.includes("👩🏽‍💻"), "a JSON Canvas: an emoji sticker a text card; an icon left out, said so: " + cv.left + " " + cards);
  // the picker (Edit): Sticker in ⋯, not on the toolbar; 48 emoji and Picture…
  const snap = () => ev(`${B}.snapshot().doc`);
  const picker = "document.querySelector('[data-sbb=stickers]')";
  check(await ev("!document.querySelector('.board-toolbar > [data-tool=sticker]')"), "Sticker is not on the toolbar");
  await ev("document.querySelector('.board-toolbar .tb-more').click(), 1");
  check(await ev("!!document.querySelector('.board-toolbar-panel .tb-use[data-tool=sticker]')"), "Sticker is in ⋯");
  await ev("document.querySelector('.board-toolbar-panel .tb-use[data-tool=sticker]').click(), 1");
  check(await ev(`!!${picker} && ${picker}.querySelectorAll('.bs-emoji').length === 48 && !!${picker}.querySelector('.bs-picture') && document.activeElement?.classList.contains('bs-emoji')`), "Sticker opens the picker: 48 emoji (the first focused) and Picture…");
  if (process.env.SHOT) { const r = await send("Page.captureScreenshot", { format: "png" }); (await import("node:fs")).writeFileSync(process.env.SHOT, Buffer.from(r.data, "base64")); }
  const n0 = (await snap()).nodes.length;
  await ev(`[...${picker}.querySelectorAll('.bs-emoji')].find((b) => b.textContent === "🎉").click(), 1`);
  await sleep(300);
  const added = (await snap()).nodes.at(-1);
  check((await snap()).nodes.length === n0 + 1 && added.kind === "sticker" && added.emoji === "🎉" && !added.w && (await ev(`!${picker} && window.board.handle === ${JSON.stringify(added.id)}`)), "an emoji chosen: a sticker of it, selected, its corner a handle: " + JSON.stringify(added));
  // resized by its corner: square
  const a0 = await ev(`window.board.item(${JSON.stringify(added.id)})`), h0 = await toClient(a0.x + a0.w, a0.y + a0.h);
  await mouse("mousePressed", h0.x, h0.y);
  for (let k = 1; k <= 6; k++) await mouse("mouseMoved", h0.x + k * 10, h0.y + k * 3);
  await mouse("mouseReleased", h0.x + 60, h0.y + 18);
  await sleep(400);
  const a1 = await ev(`window.board.item(${JSON.stringify(added.id)})`), w1 = (await snap()).nodes.find((x) => x.id === added.id).w;
  check(Math.abs(a1.w - 124) < 2 && a1.h === a1.w && w1 === a1.w, "a sticker resized by its corner stays square: " + JSON.stringify([a1.w, a1.h, w1]));
  // double-click: the picker for it (no Picture…), its emoji marked; a choice changes it
  const c1 = await toClient(a1.x + a1.w / 2, a1.y + a1.h / 2);
  await mouse("mousePressed", c1.x, c1.y); await mouse("mouseReleased", c1.x, c1.y);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c1.x, y: c1.y, button: "left", buttons: 1, clickCount: 2 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c1.x, y: c1.y, button: "left", buttons: 0, clickCount: 2 });
  await sleep(300);
  check(await ev(`!!${picker} && !${picker}.querySelector('.bs-picture') && ${picker}.querySelector('.bs-emoji.on')?.textContent === "🎉"`), "a double-click opens the picker for that sticker, its emoji marked");
  await ev(`[...${picker}.querySelectorAll('.bs-emoji')].find((b) => b.textContent === "🚀").click(), 1`);
  await sleep(300);
  check((await snap()).nodes.find((x) => x.id === added.id).emoji === "🚀", "...and a choice changes it");
  // Enter on a selected icon sticker: the picker; an emoji chosen replaces the icon (and its color)
  await ev(`window.board.setCamera({ x: 300, y: -300, z: 1 }), window.board.render(), 1`);
  await sleep(200);
  const u0 = await ev(`window.board.item("u")`), uc = await toClient(u0.x + u0.w / 2, u0.y + u0.h / 2);
  await mouse("mousePressed", uc.x, uc.y); await mouse("mouseReleased", uc.x, uc.y);
  await sleep(200);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(200);
  check(await ev(`!!${picker}`), "Enter on a selected sticker opens its picker");
  await ev(`[...${picker}.querySelectorAll('.bs-emoji')].find((b) => b.textContent === "✅").click(), 1`);
  await sleep(300);
  check(JSON.stringify((await snap()).nodes.find((x) => x.id === "u")) === '{"id":"u","kind":"sticker","emoji":"✅","x":700,"y":0,"w":60}', "an emoji chosen for an icon sticker replaces the icon and its color: " + JSON.stringify((await snap()).nodes.find((x) => x.id === "u")));
  // closed by Esc, and by a press outside it; Picture… chooses pictures (a file input), the picker closed
  await ev("document.querySelector('.board-toolbar .tb-more').click(), document.querySelector('.board-toolbar-panel .tb-use[data-tool=sticker]').click(), 1");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(100);
  const escaped = await ev(`!${picker}`);
  await ev("document.querySelector('.board-toolbar .tb-more').click(), document.querySelector('.board-toolbar-panel .tb-use[data-tool=sticker]').click(), 1");
  await sleep(50);
  const far0 = await toClient(-20, 600);
  await mouse("mousePressed", far0.x, far0.y); await mouse("mouseReleased", far0.x, far0.y);
  await sleep(100);
  check(escaped && (await ev(`!${picker}`)), "Esc closes the picker, and so does a press outside it");
  await ev(`document.querySelector('.board-toolbar .tb-more').click(), document.querySelector('.board-toolbar-panel .tb-use[data-tool=sticker]').click(), HTMLInputElement.prototype.click = function () { window.__chose = this.type + ":" + this.accept; }, ${picker}.querySelector('.bs-picture').click(), 1`);
  check(await ev(`!${picker} && /^file:image/.test(window.__chose ?? "")`), "Picture… chooses pictures: " + await ev("window.__chose"));
  // one undo takes back one change
  await ev("window.sagebrush.board.editing(true), 1");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 2 });
  await sleep(300);
  check((await snap()).nodes.find((x) => x.id === "u").icon === "cocalc-unknown", "one undo takes back the icon's change");
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
