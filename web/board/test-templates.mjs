// Templates (mount.ts, doc.ts templateOf and lookOf): a page made from a
// template page shows the template's card, background and items under its
// own; they are not its to edit (not picked, not selected); a change to the
// template shows on every page made from it; the page picker says which
// pages are templates; Present and printing leave templates out (all
// templates: show them); a JSON Canvas has a template's items on the pages
// made from it, leaves the template out and says so; the template layer's
// ids are none of the page's own (CORR-00C-1, -2, -3); Add a
// page makes the new page from the template of the page shown; Page… makes
// a page a template, or one made from a template, or neither.  Serve
// web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-templates.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-templates-prof-"));
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
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
const key = async (k, code, mods = 0) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code, modifiers: mods }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code, modifiers: mods }); await sleep(300); };
const toClient = (x, y) => ev(`(() => { const r = window.board.el.getBoundingClientRect(), c = window.board.camera; return { x: r.left + (${x} - c.x) * c.z, y: r.top + (${y} - c.y) * c.z }; })()`);
const pixel = async (x, y) => {
  const p = await toClient(x, y);
  const r = await send("Page.captureScreenshot", { format: "png", clip: { x: p.x, y: p.y, width: 1, height: 1, scale: 1 } });
  return ev(`new Promise((ok) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d"); g.drawImage(i, 0, 0); ok([...g.getImageData(0, 0, 1, 1).data.slice(0, 3)]); }; i.src = "data:image/png;base64,${r.data}"; })`);
};
const near = (a, b, d = 6) => a.every((v, i) => Math.abs(v - b[i]) <= d);
const docNow = () => ev(`${B}.snapshot().doc`);
const DOC = {
  title: "A deck",
  pages: [
    { id: "tA", title: "Look", template: true, slide: { x: 0, y: 0, w: 1280, h: 720 }, background: { color: "#fff2bf" }, nodes: [{ id: "logo", title: "Logo", x: 1050, y: 30 }, { id: "foot", title: "Footer", x: 30, y: 630 }] },
    { title: "First", uses: "tA", nodes: [{ id: "hello", title: "Hello", x: 300, y: 250 }] },
    { title: "Plain", nodes: [{ id: "plain", title: "Plain", x: 0, y: 0 }] },
  ],
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/?runner=0&doc=${encodeURIComponent("examples/primes.json")}` });
  await until(`${B}?.snapshot().items.length > 0`, 60000);
  await ev("localStorage.clear(), 1");
  await ev(`${B}.load(${JSON.stringify(DOC)}).then(() => ${B}.page(1)).then(() => 1)`);
  await until(`${B}.snapshot().page === 1 && !!window.board.item("hello")`, 5000);
  // the page made from the template: the template's items under its own, its card and color
  check(await ev(`(() => { const l = window.board.item("tpl:logo"), f = window.board.item("tpl:foot"); return !!l && l.inert && !!f && f.inert && !!window.board.item("hello"); })()`), "a page made from a template shows the template's items, under its own");
  await ev("window.board.setCamera({ x: -60, y: -60, z: 0.8 }), window.board.render(), 1");
  await sleep(300);
  check(near(await pixel(700, 500), [255, 242, 191]), "...and the template's card and color: " + await pixel(700, 500));
  check(await ev("[...document.querySelector('[data-sbb=pgsel]').options].map((o) => o.text).join('|')") === "1. Look (template)|2. First|3. Plain", "the page picker says which pages are templates");
  // not the page's to edit: a click on the logo picks nothing; Delete deletes nothing; a rectangle selects the page's own
  await ev("document.querySelector('[data-sbb=edit]').click(), 1");
  await sleep(200);
  const lr = await ev(`(() => { const it = window.board.item("tpl:logo"), r = window.board.el.getBoundingClientRect(), c = window.board.camera; return { x: r.left + (it.x + it.w / 2 - c.x) * c.z, y: r.top + (it.y + 10 - c.y) * c.z }; })()`);
  await mouse("mousePressed", lr.x, lr.y); await mouse("mouseReleased", lr.x, lr.y);
  await sleep(200);
  check((await ev("[...window.board.selection].join()")) === "", "a click on a template's item picks nothing: " + await ev("[...window.board.selection].join()"));
  check((await ev("window.board.itemsIn(-1e9, -1e9, 1e9, 1e9).map((i) => i.id).join()")) === "hello", "a rectangle holds only the page's own items");
  // a change to the template shows on the pages made from it
  await ev(`${B}.edit((d) => { d.pages[0].nodes[0].title = "New logo"; }).then(() => 1)`);
  check(await until(`window.board.item("tpl:logo")?.title === "New logo"`, 3000), "a change to the template shows on the page made from it");
  // Present and printing leave the template out
  const pr = await ev(`${B}.present()`);
  check(pr?.of === 2, "Present leaves the template out: " + JSON.stringify(pr));
  await key("Escape", 27);
  const sheets = await ev(`${B}.print({ dialog: false })`);
  const firstSheet = await ev("document.querySelector('#board-print .pr-sheet')?.textContent ?? ''");
  check(sheets === 2 && /New logo/.test(firstSheet) && /Hello/.test(firstSheet), `printing leaves the template out (${sheets} sheets), and a page made from it has its items: ${firstSheet.slice(0, 80)}`);
  await ev("document.getElementById('board-print')?.remove(), 1");
  // Add a page: made from the template of the page shown
  await ev("document.querySelector('[data-sbb=addpage]').click(), 1");
  await until(`${B}.snapshot().page === 2`, 3000);
  let d = await docNow();
  check(d.pages.length === 4 && d.pages[2].uses === "tA" && (await ev(`!!window.board.item("tpl:logo")`)), "Add a page on a page made from a template: the new page is made from it too");
  // Page…: on the plain page, made from the template; then the template no longer one
  await ev(`${B}.page(3)`);
  await until(`${B}.snapshot().page === 3`, 3000);
  await ev("document.querySelector('[data-sbb=pageprops]').click(), 1");
  check(await ev("!document.querySelector('[data-sbb=pg-tpl-set]').hidden && !document.querySelector('[data-sbb=pg-uses-set]').hidden && [...document.querySelector('[data-sbb=pg-uses]').options].map((o) => o.text).join('|') === 'No template|Look'"), "Page… on a board with a template: a template, or made from one");
  await ev("(() => { const s = document.querySelector('[data-sbb=pg-uses]'); s.value = 'tA'; document.querySelector('[data-sbb=pg-go]').click(); return 1; })()");
  await sleep(300);
  check((await docNow()).pages[3].uses === "tA" && (await ev(`!!window.board.item("tpl:foot") && !!window.board.item("plain")`)), "...made from the template: its items under the page's own");
  await ev(`${B}.page(0)`);
  await until(`${B}.snapshot().page === 0`, 3000);
  await ev("document.querySelector('[data-sbb=pageprops]').click(), 1");
  check(await ev("document.querySelector('[data-sbb=pg-template]').checked && document.querySelector('[data-sbb=pg-uses-set]').hidden"), "Page… on the template: it is one (and is made from none)");
  await ev("document.querySelector('[data-sbb=pg-template]').click(), document.querySelector('[data-sbb=pg-go]').click(), 1");
  await sleep(300);
  await ev(`${B}.page(1)`);
  await until(`${B}.snapshot().page === 1`, 3000);
  check(!(await docNow()).pages[0].template && !(await ev(`!!window.board.item("tpl:logo")`)), "a template no longer one: the pages made from it are their own again");
  // one undo: a template again
  await key("z", 90, 2);
  check(await until(`${B}.snapshot().doc.pages[0].template === true`, 3000), "one undo makes it a template again");
  // a page made a template: its id, made for it
  await ev(`${B}.page(2)`);
  await until(`${B}.snapshot().page === 2`, 3000);
  await ev("document.querySelector('[data-sbb=pageprops]').click(), document.querySelector('[data-sbb=pg-template]').click(), document.querySelector('[data-sbb=pg-go]').click(), 1");
  await sleep(300);
  d = await docNow();
  check(d.pages[2].template === true && /^t[a-z0-9]+$/.test(d.pages[2].id ?? "") && !d.pages[2].uses, "a page made a template gets an id, and is made from none: " + JSON.stringify([d.pages[2].id, d.pages[2].uses]));
  // CORR-00C-1: a page's own item with the id the template layer would give the template's item: both shown
  const clash = { pages: [{ id: "t", template: true, nodes: [{ id: "x", title: "Template", x: 0, y: 0 }] }, { uses: "t", nodes: [{ id: "tpl:x", title: "Own", x: 600, y: 0 }] }] };
  await ev(`${B}.load(${JSON.stringify(clash)}).then(() => ${B}.page(1)).then(() => 1)`);
  await until(`${B}.snapshot().page === 1 && !!window.board.item("tpl:x")`, 3000);
  await sleep(300);
  const both = await ev(`(() => { const own = window.board.item("tpl:x"), els = [...document.querySelectorAll(".board-item")].map((e) => e.textContent.trim()); return { own: own && { title: own.title, inert: !!own.inert }, els }; })()`);
  const tplItem = await ev(`[...document.querySelectorAll(".board-item.board-inert")].map((e) => e.textContent.trim()).join()`);
  check(both.own?.title === "Own" && !both.own.inert && both.els.includes("Own") && both.els.includes("Template") && tplItem === "Template", "a page's own item named as the template layer's: both shown, the page's own its own: " + JSON.stringify([both, tplItem]));
  // (an element shown again under the same id and title, inert once and the page's own now: not inert)
  const swap = { pages: [{ id: "t", template: true, nodes: [{ id: "x", title: "Same", x: 0, y: 0 }] }, { uses: "t", nodes: [] }, { nodes: [{ id: "tpl:x", title: "Same", x: 0, y: 0 }] }] };
  await ev(`${B}.load(${JSON.stringify(swap)}).then(() => ${B}.page(1)).then(() => 1)`);
  await until(`!!document.querySelector(".board-item.board-inert")`, 3000);
  await ev(`${B}.page(2).then(() => 1)`);
  await until(`${B}.snapshot().page === 2`, 3000);
  await sleep(300);
  check(await ev(`[...document.querySelectorAll(".board-item")].filter((e) => /Same/.test(e.textContent)).map((e) => e.classList.contains("board-inert")).join() === "false"`), "an item no longer inert is drawn so (its element not kept)");
  await ev(`${B}.load(${JSON.stringify(clash)}).then(() => ${B}.page(1)).then(() => 1)`);
  await until(`${B}.snapshot().page === 1`, 3000);
  // CORR-00C-3: a JSON Canvas has the template's items on the page made from it; the template's own page left out, said so
  const cv = await ev(`${B}.canvas()`), cn = JSON.parse(cv.text).nodes;
  const texts = cn.filter((x) => x.type === "text").map((x) => x.text).sort().join(), groups = cn.filter((x) => x.type === "group").map((x) => x.label).join();
  check(texts === "## Own,## Template" && groups === "Page 2" && /1 template page/.test(cv.left), "a JSON Canvas: the template's items on the page made from it, the template itself left out, said so: " + JSON.stringify([texts, groups, cv.left]));
  // CORR-00C-2: a board whose pages are all templates: Present and printing show the templates themselves
  await ev(`${B}.load(${JSON.stringify({ pages: [{ id: "a", template: true, nodes: [{ id: "p", title: "P" }] }, { id: "b", template: true, nodes: [] }] })}).then(() => 1)`);
  const allT = await ev(`${B}.present()`);
  check(allT?.of === 2 && /^\d \/ 2$/.test(await ev("document.querySelector('[data-sbb=pr-where]').textContent")), "all templates: Present shows them: " + JSON.stringify(allT));
  await key("Escape", 27);
  await sleep(200);
  check((await ev(`${B}.print({ dialog: false })`)) === 2, "all templates: printing prints them");
  await ev("document.getElementById('board-print')?.remove(), 1");
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
