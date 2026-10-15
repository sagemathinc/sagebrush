// Pictures on a board (web/board/images.ts): pasted, dropped, chosen with
// the toolbar's Image or a note's + Image; kept in this browser by a hash of
// their bytes, so the document holds only their names and sizes (and a large
// one is scaled down); carried as data: URLs by a board leaving the browser,
// and taken back in when one is opened; resized by the handle at a selected
// note's corner (a picture keeps its shape); still there after a reload.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-images.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-img-prof-"));
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
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon/.test(m.params.entry.url ?? "")) errors.push(m.params.entry.text + " " + (m.params.entry.url ?? ""));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const docOf = () => ev("JSON.parse(JSON.stringify(window.sagebrush.board.snapshot().doc))");
const nodes = async () => (await docOf()).nodes;
const pictures = async () => (await nodes()).filter((x) => x.image);
const mouse = async (type, x, y, o = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...o });
const drag = async (from, to) => {
  await mouse("mousePressed", from.x, from.y);
  for (let i = 1; i <= 8; i++) await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
  await mouse("mouseReleased", to.x, to.y, { buttons: 0 });
  await sleep(400);
};
const rect = (id) => ev(`(() => { const r = window.board.clientRect(${JSON.stringify(id)}); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
const click = async (id) => { const r = await rect(id); await mouse("mousePressed", r.x + r.w / 2, r.y + r.h / 2); await mouse("mouseReleased", r.x + r.w / 2, r.y + r.h / 2, { buttons: 0 }); await sleep(250); };
const item = (id) => ev(`window.sagebrush.board.snapshot().items.find((it) => it.id === ${JSON.stringify(id)})`);
// a PNG made in the page: w by h, noisy (so that it is large) or plain
const png = (w, h, noisy = false, name = "pic.png") => `(async () => {
  const c = document.createElement("canvas"); c.width = ${w}; c.height = ${h};
  const g = c.getContext("2d"); g.fillStyle = "#c33"; g.fillRect(0, 0, ${w}, ${h}); g.fillStyle = "#36c"; g.fillRect(0, 0, ${w} / 2, ${h} / 2);
  if (${noisy}) { const d = g.getImageData(0, 0, ${w}, ${h}); for (let i = 0; i < d.data.length; i++) d.data[i] = (Math.random() * 256) | 0; g.putImageData(d, 0, 0); }
  const b = await new Promise((r) => c.toBlob(r, "image/png"));
  return new File([b], ${JSON.stringify(name)}, { type: "image/png" });
})()`;
const paste = (file) => ev(`(async () => { const dt = new DataTransfer(); dt.items.add(await ${file}); document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })); return 1; })()`);
try {
  for (const m of ["Page.enable", "Runtime.enable", "Log.enable", "DOM.enable"]) await send(m);
  const url = `${base}board/?mermaid=${encodeURIComponent("flowchart LR\n a[First] --> b[Second]")}`;
  await send("Page.navigate", { url });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  await ev("localStorage.clear(), window.sagebrush.board.editing(true), 1");
  // pasted: a note that is the picture, its bytes kept apart from the document
  await paste(png(300, 200));
  check(await until("window.sagebrush.board.snapshot().doc.nodes.some((x) => x.image)"), "a pasted picture is added");
  let [p1] = await pictures();
  const d1 = await docOf();
  check(/^i[0-9a-f]{32}$/.test(p1.image) && JSON.stringify(d1.images[p1.image]) === '{"w":300,"h":200}', "named by its content's hash, with its size: " + JSON.stringify([p1, d1.images]));
  check(p1.w === 300 && !JSON.stringify(d1).includes("data:"), "the document holds no bytes: " + JSON.stringify(d1).length + " characters");
  check(await until(`(() => { const im = [...document.querySelectorAll(".board-picture img.board-img")].find((i) => i.complete && i.naturalWidth === 300); return !!im && im.src.startsWith("blob:"); })()`), "it shows, as the picture alone (its bytes from this browser)");
  check((await item(p1.id)).h === 200, "its height from its shape: " + (await item(p1.id)).h);
  // the same picture again: kept once
  await paste(png(300, 200));
  await until("window.sagebrush.board.snapshot().doc.nodes.filter((x) => x.image).length === 2");
  const twice = await pictures();
  check(twice.length === 2 && twice[0].image === twice[1].image && Object.keys((await docOf()).images).length === 1, "the same picture twice is kept once");
  await ev(`window.sagebrush.board.edit((d) => { d.nodes = d.nodes.filter((x) => x.id !== ${JSON.stringify(twice[1].id)}); })`);
  // a large one is scaled down on the way in
  await paste(png(3000, 900, true, "big.png"));
  check(await until("Object.values(window.sagebrush.board.snapshot().doc.images ?? {}).some((i) => i.w === 2400 && i.h === 720)", 20000), "a 3000 x 900 picture is kept at 2400 x 720: " + JSON.stringify((await docOf()).images));
  const big = (await pictures()).find((x) => (x.w ?? 0) <= 480 && x.id !== p1.id);
  check(big && big.w === 480 && Math.abs((await item(big.id)).h - 144) <= 1, "shown 480 wide at first: " + JSON.stringify(big));
  // (out of the way: pasted pictures go to the middle of the view, over each other)
  await ev(`window.sagebrush.board.edit((d) => { d.nodes.find((x) => x.id === ${JSON.stringify(big?.id)}).x = 2400; })`);
  // dropped: where it is let go
  const at = { x: 900, y: 600 };
  await ev(`(async () => { const dt = new DataTransfer(); dt.items.add(await ${png(120, 120, false, "drop.png")}); document.querySelector("#board").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: ${at.x}, clientY: ${at.y}, bubbles: true, cancelable: true })); return 1; })()`);
  check(await until("window.sagebrush.board.snapshot().doc.nodes.filter((x) => x.image).length === 3"), "a dropped picture is added");
  const dropped = (await pictures()).find((x) => x.w === 120);
  const dr = dropped && (await rect(dropped.id));
  check(dr && Math.abs(dr.x + dr.w / 2 - at.x) < 3 && Math.abs(dr.y + dr.h / 2 - at.y) < 3, "where it was dropped: " + JSON.stringify(dr));
  // resized by its corner: a picture keeps its shape
  await ev(`window.board.focus([${JSON.stringify(p1.id)}], true), 1`);
  await sleep(500);
  await click(p1.id);
  let r = await rect(p1.id);
  const z = await ev("window.board.camera.z");
  await drag({ x: r.x + r.w, y: r.y + r.h }, { x: r.x + r.w + 150, y: r.y + r.h + 20 });
  p1 = (await pictures()).find((x) => x.id === p1.id);
  const want = Math.round(300 + 150 / z);
  check(Math.abs(p1.w - want) <= 1 && Math.abs((await item(p1.id)).h - (p1.w * 2) / 3) <= 1, `the handle widened it to ${want}, its height following: ` + JSON.stringify([p1, (await item(p1.id)).h]));
  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
  await sleep(400);
  check((await pictures()).find((x) => x.id === p1.id).w === 300, "undo takes the resize back");
  // any note: its width, its height following its text
  await ev("window.sagebrush.board.edit((d) => { d.nodes.push({ id: 't', text: 'A note with enough words in it to wrap onto several lines when it is narrow, and fewer when it is wide.', x: 1400, y: 0 }); })");
  await ev("window.board.focus(['t'], true), 1");
  await sleep(500);
  await click("t");
  r = await rect("t");
  const h0 = (await item("t")).h, z2 = await ev("window.board.camera.z");
  await drag({ x: r.x + r.w, y: r.y + r.h }, { x: r.x + r.w + 200 * z2, y: r.y + r.h });
  const t = (await nodes()).find((x) => x.id === "t");
  check(t.w === 460 && (await item("t")).h < h0, `a note resized to 460 wide, and shorter: ${t.w}, ${h0} -> ${(await item("t")).h}`);
  // + Image in a note's editor: title, picture, text, in that order
  writeFileSync(join(profile, "chosen.png"), Buffer.from(await ev(`(async () => { const f = await ${png(80, 40, false)}; const b = new Uint8Array(await f.arrayBuffer()); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); })()`), "base64"));
  // The board's own file inputs (toolbar Image, + Image) carry class
  // sb-fileinput; set the chosen file on the one the click just created,
  // which fires its change handler.  (Avoids the flaky CDP file-chooser
  // event, and the page's unrelated Open-file input.)
  const choose = async () => {
    for (let i = 0; i < 200; i++) {
      const doc = await send("DOM.getDocument", { depth: -1 });
      const q = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "input.sb-fileinput" });
      if (q?.nodeId) { await send("DOM.setFileInputFiles", { files: [join(profile, "chosen.png")], nodeId: q.nodeId }); return true; }
      await sleep(50);
    }
    return false;
  };
  r = await rect("t");
  await ev(`(() => { const x = ${r.x + 20}, y = ${r.y + 12}; document.elementFromPoint(x, y).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: x, clientY: y })); return 1; })()`);
  await until("!!document.querySelector('.board-editing .be-title')", 5000);
  await ev("document.querySelector('.ip-bar .ip-image').click(), 1");
  check(await choose(), "+ image asks for a file");
  check(await until("document.querySelector('.board-editing .be-pic .board-img')?.naturalWidth === 80"), "the item being edited shows the chosen picture");
  await ev("document.querySelector('.board-editing .be-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 1");
  check(await until("(() => { const t = window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 't'); return !!t.image && !!t.text; })()"), "the note has the picture and keeps its text");
  await ev("window.board.focus(['t'], true), 1");
  await sleep(400);
  const order = await ev("(() => { const el = document.querySelector('.board-item.selected') ?? [...document.querySelectorAll('.board-note')].find((e) => e.querySelector('.board-img') && e.querySelector('.board-text')); return [...el.children].map((c) => c.className); })()");
  check(JSON.stringify(order) === '["board-img","board-text"]', "shown: the picture, then the text: " + JSON.stringify(order));
  // the toolbar's Image
  const k0 = (await pictures()).length;
  await ev("document.querySelector('.board-toolbar [data-tool=image]').click(), 1");
  check(await choose(), "the toolbar's Image asks for files");
  check(await until(`window.sagebrush.board.snapshot().doc.nodes.filter((x) => x.image).length === ${k0 + 1}`), "...and adds the picture");
  // HiDPI: a screenshot shows at its size on its screen (sharp), not one CSS
  // pixel per pixel (twice as large, and blurry): its density from the file
  // (a PNG's pHYs: 144 dpi is 2x), else, for a paste, the screen's
  const dpi = (w, h, d) => `(async () => {
    const f = await ${png(w, h)}, b = new Uint8Array(await f.arrayBuffer());
    const crc = (bytes) => { let c = ~0; for (const x of bytes) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
    const ppm = Math.round(${d} / 0.0254), chunk = new Uint8Array(21), v = new DataView(chunk.buffer);
    v.setUint32(0, 9); chunk.set([0x70, 0x48, 0x59, 0x73], 4); v.setUint32(8, ppm); v.setUint32(12, ppm); chunk[16] = 1; v.setUint32(17, crc(chunk.subarray(4, 17)));
    return new File([b.subarray(0, 33), chunk, b.subarray(33)], "shot.png", { type: "image/png" });
  })()`;
  const widthOf = async (pw) => { await until(`Object.values(window.sagebrush.board.snapshot().doc.images ?? {}).some((i) => i.w === ${pw})`); const d = await docOf(); const key = Object.keys(d.images).find((k) => d.images[k].w === pw); return d.nodes.find((x) => x.image === key)?.w; };
  await paste(dpi(400, 200, 144));
  check((await widthOf(400)) === 200, "a 144 dpi (2x) screenshot is shown at half its pixels");
  await paste(dpi(410, 200, 96));
  check((await widthOf(410)) === 410, "a 96 dpi picture at its pixels");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await paste(png(420, 100));
  check((await widthOf(420)) === 210, "pasted on a 2x screen, with no density of its own: half its pixels");
  await ev(`(async () => { const dt = new DataTransfer(); dt.items.add(await ${png(430, 100, false, "drop2.png")}); document.querySelector("#board").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: 600, clientY: 400, bubbles: true, cancelable: true })); return 1; })()`);
  check((await widthOf(430)) === 430, "a dropped file is not a screenshot of this screen: at its pixels");
  await send("Emulation.clearDeviceMetricsOverride");
  // leaving the browser: Download / Copy / exported HTML carry the bytes
  const portable = await ev("window.sagebrush.board.portable()");
  check(Object.values(portable.images).every((i) => /^data:image\/(png|webp|jpeg);base64,/.test(i.src)), "a downloaded board carries its pictures: " + JSON.stringify(Object.values(portable.images).map((i) => (i.src ?? "").slice(0, 30))));
  check((await ev("window.sagebrush.board.exportHtml()")).includes("data:image/png;base64,"), "an exported HTML file carries them");
  // still there after a reload (the document's names; the bytes from this browser)
  const keys = Object.keys((await docOf()).images).sort();
  await send("Page.reload");
  await sleep(500);
  await until("window.sagebrush?.board?.snapshot().items.length > 3", 30000);
  check(JSON.stringify(Object.keys((await docOf()).images).sort()) === JSON.stringify(keys), "after a reload: the same pictures");
  await ev(`window.board.focus([${JSON.stringify(p1.id)}], true), 1`);
  check(await until(`[...document.querySelectorAll("img.board-img")].some((i) => i.complete && i.naturalWidth === 300)`), "...shown, from this browser's store");
  // a board that carries pictures, opened: taken in, under their own names; hostile sources dropped
  const carried = await ev(`(async () => { const c = document.createElement("canvas"); c.width = 7; c.height = 5; c.getContext("2d").fillRect(0, 0, 3, 3); return c.toDataURL("image/png"); })()`);
  await ev(`window.sagebrush.board.load({ title: "carried", nodes: [{ id: "q", image: "${p1.image}" }, { id: "r", image: "x" }, { id: "s", image: "y" }],
    images: { "${p1.image}": { w: 7, h: 5, src: ${JSON.stringify(carried)} }, x: { w: 1, h: 1, src: "javascript:alert(1)" }, y: { w: 1, h: 1, src: "data:image/svg+xml;base64,PHN2Zy8+" } } })`);
  const dc = await docOf();
  const q = dc.nodes.find((x) => x.id === "q");
  check(q.image !== p1.image && /^i[0-9a-f]{32}$/.test(q.image) && JSON.stringify(dc.images[q.image]) === '{"w":7,"h":5}', "a carried picture is kept under its own content's name (a document cannot replace another picture): " + JSON.stringify([q, dc.images]));
  check(!dc.images.x && !dc.images.y && !dc.images[p1.image], "a javascript: or SVG source is dropped: " + JSON.stringify(Object.keys(dc.images)));
  check(await until(`[...document.querySelectorAll("img.board-img")].some((i) => i.complete && i.naturalWidth === 7)`), "the carried picture shows");
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
