// A page's backdrop (doc.ts slide and background, board.ts, print.ts): a
// slide's card is drawn behind its items, its background color on it, the
// board around it as it was; a page without a card has its color behind the
// whole board; a picture covers a card (its name renamed as a picture's is,
// taken in); printing shows a slide as its card; the board's file keeps
// them; a JSON Canvas says it left them out; a board downloaded as HTML
// draws them.  In Edit, Page… makes a page a slide (a 16:9 card around what
// it holds), gives it a color and a picture, and names a page of a board
// with pages; one undo takes it back; the card is dragged by its edge and
// resized by its corner, keeping its shape.  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-backdrop.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-backdrop-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1200,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const B = "window.sagebrush.board";
// the color at a point of the board (world coordinates), as on the screen
const pixel = async (x, y) => {
  const p = await ev(`(() => { const r = window.board.el.getBoundingClientRect(), c = window.board.camera; return { x: r.left + (${x} - c.x) * c.z, y: r.top + (${y} - c.y) * c.z }; })()`);
  const r = await send("Page.captureScreenshot", { format: "png", clip: { x: p.x, y: p.y, width: 1, height: 1, scale: 1 } });
  return ev(`new Promise((ok) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d"); g.drawImage(i, 0, 0); ok([...g.getImageData(0, 0, 1, 1).data.slice(0, 3)]); }; i.src = "data:image/png;base64,${r.data}"; })`);
};
const near = (a, b, d = 6) => a.every((v, i) => Math.abs(v - b[i]) <= d);
const view = () => ev("window.board.setCamera({ x: -100, y: -100, z: 1 }), window.board.render(), 1").then(() => sleep(300));
// a 4 x 4 red picture
const RED = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==";
const DOC = {
  title: "Slides",
  images: { bgpic: { w: 4, h: 4, src: RED } },
  pages: [
    { title: "A slide", slide: { x: 0, y: 0, w: 640, h: 360 }, background: { color: "#d7e6fa" }, nodes: [{ id: "a", title: "On the slide", x: 40, y: 40 }] },
    { title: "Colored", background: { color: "#fbd4d1" }, nodes: [{ id: "b", title: "On a colored page", x: 40, y: 40 }] },
    { title: "A picture", slide: { x: 0, y: 0, w: 640, h: 360 }, background: { image: "bgpic" }, nodes: [{ id: "c", title: "Over a picture", x: 40, y: 40 }] },
  ],
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/?runner=0&doc=${encodeURIComponent("examples/primes.json")}` });
  await until(`${B}?.snapshot().items.length > 0`, 60000);
  await ev("localStorage.clear(), 1");
  await ev(`${B}.load(${JSON.stringify(DOC)}).then(() => 1)`);
  await until(`${B}.snapshot().items.some((i) => i.id === "a")`, 5000);
  // a slide: the card, its color on it, the board around it as it was
  await view();
  const onCard = await pixel(600, 330), offCard = await pixel(720, 420);
  check(near(onCard, [215, 230, 250]) && near(offCard, [250, 250, 247]), `a slide: its card has its color (${onCard}), the board around it is the board's (${offCard})`);
  // a page with a color and no card: behind the whole board
  await ev(`${B}.page(1)`);
  await until(`${B}.snapshot().items.some((i) => i.id === "b")`, 5000);
  await view();
  const p2a = await pixel(600, 330), p2b = await pixel(900, 600);
  check(near(p2a, [251, 212, 209]) && near(p2b, [251, 212, 209]), `a page's color without a card is behind the whole board: ${p2a}, ${p2b}`);
  // a picture: covering the card; its name is the picture's own (taken in, renamed)
  await ev(`${B}.page(2)`);
  await until(`${B}.snapshot().items.some((i) => i.id === "c")`, 5000);
  await view();
  await until(`(() => { const d = ${B}.snapshot().doc; return d.pages[2].background.image !== "bgpic" && !!d.images[d.pages[2].background.image]; })()`, 3000);
  await sleep(300);
  const pic = await pixel(600, 330), offPic = await pixel(720, 420);
  check(near(pic, [255, 0, 0], 12) && near(offPic, [250, 250, 247]), `a picture covers the card, and only the card: ${pic} on it, ${offPic} beside it`);
  check(await ev(`(() => { const d = ${B}.snapshot().doc, k = d.pages[2].background.image; return k !== "bgpic" && !!d.images[k] && !d.images.bgpic; })()`), "the picture, taken in, is renamed as a picture is, and the page says the new name");
  // printing: a slide is its card, on its sheet with its color, or its picture
  await ev(`${B}.print({ dialog: false }).then(() => 1)`);
  const sheets = await ev(`[...document.querySelectorAll("#board-print .pr-sheet")].map((s) => [...s.querySelectorAll(".pr-world > div")].map((d) => ({ w: d.style.width, color: d.style.backgroundColor, picture: d.style.backgroundImage.startsWith("url("), card: !!d.style.boxShadow })))`);
  const has = (i, f) => (sheets[i] ?? []).some(f);
  check(sheets.length === 3 && has(0, (l) => l.card && l.w === "640px") && has(0, (l) => l.color === "rgb(215, 230, 250)" && l.w === "640px") && has(1, (l) => l.color === "rgb(251, 212, 209)") && !has(1, (l) => l.card) && has(2, (l) => l.picture && l.w === "640px"), "printed: a slide's card, its color or its picture; a page's color: " + JSON.stringify(sheets));
  await ev("document.getElementById('board-print')?.remove(), 1");
  // the board's file keeps them; a JSON Canvas leaves them out, and says so
  const file = await ev(`${B}.json()`);
  check(/"slide": \{\n\s+"x": 0,/.test(file) && /"background": \{\n\s+"color": "#d7e6fa"/.test(file), "the board's file keeps a page's slide and background");
  const cv = await ev(`${B}.canvas()`);
  check(/2 slides' cards/.test(cv.left) && /3 pages' backgrounds/.test(cv.left), "a JSON Canvas leaves the cards and backgrounds out, and says so: " + cv.left);
  // Page…: a board of one page made a slide, colored, given a picture; one undo each
  const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  const toClient = (x, y) => ev(`(() => { const r = window.board.el.getBoundingClientRect(), c = window.board.camera; return { x: r.left + (${x} - c.x) * c.z, y: r.top + (${y} - c.y) * c.z }; })()`);
  const dragFrom = async (x, y, dx, dy) => { await mouse("mousePressed", x, y); for (let k = 1; k <= 8; k++) await mouse("mouseMoved", x + (dx * k) / 8, y + (dy * k) / 8); await mouse("mouseReleased", x + dx, y + dy); await sleep(300); };
  const undo = async () => { await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })), 1"); await sleep(300); };
  const docNow = () => ev(`${B}.snapshot().doc`);
  await ev(`${B}.load({ title: "One page", nodes: [{ id: "a", title: "A", x: 0, y: 0 }, { id: "b", title: "B", x: 400, y: 260 }] }).then(() => 1)`);
  await ev("document.querySelector('[data-sbb=edit]').click(), 1");
  await view();
  await ev("document.querySelector('[data-sbb=pageprops]').click(), 1");
  check(await ev("document.querySelector('[data-sbb=pgdlg]').open && document.querySelector('[data-sbb=pg-title-set]').hidden && !document.querySelector('[data-sbb=pg-slide]').checked && document.querySelector('[data-sbb=pg-pic-set]').hidden"), "Page… opens: no title for a board of one page, not a slide, no picture to choose");
  await ev("document.querySelector('[data-sbb=pg-slide]').click(), document.querySelector('[data-sbb=pg-colors] [title=Blue]').click(), 1");
  check(await ev("!document.querySelector('[data-sbb=pg-pic-set]').hidden"), "...a slide can have a picture");
  await ev("document.querySelector('[data-sbb=pg-go]').click(), 1");
  await sleep(300);
  let d1 = await docNow();
  const items = await ev(`${B}.snapshot().items.map((i) => [i.x, i.y, i.x + i.w, i.y + i.h])`);
  check(d1.slide && Math.abs(d1.slide.w / d1.slide.h - 16 / 9) < 0.01 && items.every(([x0, y0, x1, y1]) => x0 >= d1.slide.x && y0 >= d1.slide.y && x1 <= d1.slide.x + d1.slide.w && y1 <= d1.slide.y + d1.slide.h) && d1.background?.color === "#d7e6fa", "a slide: a 16:9 card around what the page holds, in its color: " + JSON.stringify([d1.slide, d1.background]));
  await undo();
  d1 = await docNow();
  check(!d1.slide && !d1.background, "one undo takes it back");
  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true })), 1");
  await sleep(300);
  // a picture, chosen
  const png = join(profile, "red.png");
  writeFileSync(png, Buffer.from(RED.split(",")[1], "base64"));
  await ev("document.querySelector('[data-sbb=pageprops]').click(), document.querySelector('[data-sbb=pg-pic]').click(), 1");
  const root = await send("DOM.getDocument", { depth: -1 });
  const inp = await send("DOM.querySelector", { nodeId: root.root.nodeId, selector: "input.sb-fileinput" });
  await send("DOM.setFileInputFiles", { files: [png], nodeId: inp.nodeId });
  await until("/picture covers/.test(document.querySelector('[data-sbb=pg-pic-on]').textContent)", 5000);
  await ev("document.querySelector('[data-sbb=pg-go]').click(), 1");
  await sleep(500);
  d1 = await docNow();
  const s1 = d1.slide;
  check(d1.background?.image && d1.images?.[d1.background.image]?.w === 4 && d1.background.color === "#d7e6fa", "a picture chosen covers the card: " + JSON.stringify(d1.background));
  check(near(await pixel(s1.x + s1.w - 20, s1.y + s1.h - 20), [255, 0, 0], 12), "...drawn on it");
  // the card dragged by its edge, resized by its corner (keeping its shape)
  // (its left edge: its top may be under the Edit toolbar)
  const top = await toClient(s1.x, s1.y + s1.h / 2);
  const z = (await ev("window.board.camera.z"));
  await dragFrom(top.x, top.y, 60, 40);
  const s2 = (await docNow()).slide;
  check(Math.abs(s2.x - s1.x - 60 / z) < 1.5 && Math.abs(s2.y - s1.y - 40 / z) < 1.5 && s2.w === s1.w, `the card dragged by its edge: moved by (${(s2.x - s1.x).toFixed(1)}, ${(s2.y - s1.y).toFixed(1)})`);
  const corner = await toClient(s2.x + s2.w, s2.y + s2.h);
  await dragFrom(corner.x, corner.y, 120, 10);
  const s3 = (await docNow()).slide;
  check(Math.abs(s3.w - s2.w - 120 / z) < 2 && Math.abs(s3.w / s3.h - s2.w / s2.h) < 0.01 && s3.x === s2.x && s3.y === s2.y, `the card resized by its corner, keeping its shape: ${JSON.stringify([s2, s3])}`);
  // not a slide any more: its picture goes, its color stays, behind the whole board
  await ev("document.querySelector('[data-sbb=pageprops]').click(), document.querySelector('[data-sbb=pg-slide]').click(), document.querySelector('[data-sbb=pg-go]').click(), 1");
  await sleep(300);
  d1 = await docNow();
  check(!d1.slide && JSON.stringify(d1.background) === '{"color":"#d7e6fa"}', "no longer a slide: its picture goes, its color stays: " + JSON.stringify(d1.background));
  // a board with pages: Page… names the page
  await ev(`${B}.load(${JSON.stringify(DOC)}).then(() => 1)`);
  await ev("document.querySelector('[data-sbb=pageprops]').click(), 1");
  check(await ev("!document.querySelector('[data-sbb=pg-title-set]').hidden && document.querySelector('[data-sbb=pg-title]').value === 'A slide' && document.querySelector('[data-sbb=pg-slide]').checked"), "Page… on a board with pages: the page's title, and its being a slide");
  await ev("(() => { const t = document.querySelector('[data-sbb=pg-title]'); t.value = 'Renamed'; document.querySelector('[data-sbb=pg-go]').click(); return 1; })()");
  await sleep(300);
  check((await docNow()).pages[0].title === "Renamed" && !(await ev("!!document.querySelector('[data-sbb=namepage]')")), "...renames it (Rename this page… is no more: it is here)");
  await ev("document.querySelector('[data-sbb=edit]').click(), 1");
  await ev(`${B}.load(${JSON.stringify(DOC)}).then(() => 1)`);

  // downloaded as HTML: drawn there too
  const html = await ev(`${B}.exportHtml()`);
  const f = join(profile, "slides.html");
  writeFileSync(f, html);
  await send("Page.navigate", { url: "file://" + f });
  await until(`${B}?.snapshot().items.some((i) => i.id === "a")`, 30000);
  await view();
  check(near(await pixel(600, 330), [215, 230, 250]), "a board downloaded as HTML draws its slide's card and color");
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
