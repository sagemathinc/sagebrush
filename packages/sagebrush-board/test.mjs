// The package with a host of its own, in headless Chromium: two boards
// mounted side by side on a plain page (not sagebrush.space's), each with an
// in-memory store and nothing else (no code engine, math, history, examples
// or export).  Each shows its own document, keeps its parts within its own
// element, saves its own edits, offers nothing its host lacks, shows code as
// text, edits in place, takes the page's keys and clipboard only when it is
// the one in use, and is unmounted by destroy() while the other works.
// Their parts have no ids, and the host's own elements of the same names
// or classes, and its buttons, are left alone.
// Build first (bun build.mjs), then
//   node test.mjs
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../../web/test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const site = mkdtempSync(join(tmpdir(), "sb-pkg-site-")), profile = mkdtempSync(join(tmpdir(), "sb-pkg-"));
copyFileSync(join(here, "dist", "index.js"), join(site, "index.js"));
const A = { title: "A", nodes: [{ id: "a1", title: "In A", text: "first" }, { id: "a2", title: "Code in A", code: "x = 1" }], steps: [{ focus: "a1" }, { focus: "a2" }] };
const B = { title: "B", nodes: [{ id: "b1", title: "In B", text: "second" }, { id: "b2", title: "Also in B" }], steps: [{ focus: "b1" }, { focus: "b2" }] };
writeFileSync(join(site, "index.html"), `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<div id="a" style="position:absolute;left:0;top:0;width:620px;height:560px"></div>
<div id="b" style="position:absolute;left:640px;top:0;width:620px;height:560px"></div>
<div style="position:absolute;left:0;top:580px"><div id="top">The host's top</div><span id="title">The host's title</span><div id="menu">The host's menu</div><div class="menu">The host's .menu</div><button id="hostbtn">The host's button</button></div>
<script type="module">
import { mountBoard } from "./index.js";
const images = { url: () => undefined, put: async () => "", ensure: async () => {}, absorb: async () => {}, inline: async (d) => d };
const host = (doc) => {
  const kept = { saves: 0, doc: null };
  return { kept, host: { images, store: { load: async () => ({ doc, original: doc }), save: (d) => { kept.saves++; kept.doc = d; } } } };
};
const a = host(${JSON.stringify(A)}), b = host(${JSON.stringify(B)});
window.A = { ...a, api: mountBoard(document.getElementById("a"), a.host) };
window.B = { ...b, api: mountBoard(document.getElementById("b"), b.host) };
</script></body></html>`);
// (a plain server: the files as they are)
const server = createServer((req, res) => {
  const f = join(site, req.url === "/" ? "index.html" : req.url.slice(1).split("?")[0]);
  let body;
  try { body = readFileSync(f); } catch { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html" });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
let port = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1300,700", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
const until = async (expr, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
// (an element's box, of a board's part found within its root)
const box = (who, sel) => ev(`(() => { const r = document.getElementById(${JSON.stringify(who)}).querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url });
  check(await until("window.A?.api.agent.snapshot().items.length === 2 && window.B?.api.agent.snapshot().items.length === 2", 20000), "each board shows its own document");
  check((await ev("A.api.agent.snapshot().items.map((i) => i.id).join()")) === "a1,a2" && (await ev("B.api.agent.snapshot().items.map((i) => i.id).join()")) === "b1,b2", "...A's items in A, B's in B");
  // the page's keys: the first board mounted's, until another is used
  const key = async (k, code) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code }); await sleep(80); };
  const steps = () => ev("[A.api.agent.snapshot().step, B.api.agent.snapshot().step].join()");
  await key("ArrowRight", 39);
  check((await steps()) === "0,-1", "→ steps A's tour (the first mounted), not B's: " + await steps());
  // a press in B: B's
  const inB = await ev("(() => { const r = document.getElementById('b').getBoundingClientRect(); return { x: r.left + 40, y: r.bottom - 40 }; })()");
  await mouse("mousePressed", inB.x, inB.y); await mouse("mouseReleased", inB.x, inB.y);
  await key("ArrowRight", 39);
  check((await steps()) === "0,0", "after a press in B, → steps B's tour only: " + await steps());
  // Delete and the clipboard, in Edit: the board in use's only
  await ev("A.api.agent.editing(true), B.api.agent.editing(true), A.api.agent.step(-1), B.api.agent.step(-1), 1");
  await sleep(500);
  const centre = async (who, id) => ev(`(() => { const r = ${who}.api.board.clientRect(${JSON.stringify(id)}); return { x: r.left + r.width / 2, y: r.top + Math.min(20, r.height / 2) }; })()`);
  let p = await centre("A", "a1");
  await mouse("mousePressed", p.x, p.y); await mouse("mouseReleased", p.x, p.y);
  p = await centre("B", "b2");
  await mouse("mousePressed", p.x, p.y); await mouse("mouseReleased", p.x, p.y);
  await key("Delete", 46);
  check(await until("B.api.agent.snapshot().doc.nodes.map((x) => x.id).join() === 'b1' && A.api.agent.snapshot().doc.nodes.length === 2", 3000), "Delete deletes what is selected in B, the board in use, and nothing in A: " + await ev("JSON.stringify([A.api.agent.snapshot().doc.nodes.map((x) => x.id), B.api.agent.snapshot().doc.nodes.map((x) => x.id)])"));
  await ev("(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'Pasted'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()");
  check(await until("B.api.agent.snapshot().doc.nodes.some((x) => x.text === 'Pasted') && !A.api.agent.snapshot().doc.nodes.some((x) => x.text === 'Pasted')", 3000), "a paste makes a note in B only");
  // the focus in A (its menu's button): A's again
  await ev("document.querySelector('#a button').focus(), 1");
  await ev("A.api.agent.editing(false), B.api.agent.editing(false), 1");
  await key("ArrowRight", 39);
  check((await steps()).startsWith("0,"), "with the focus in A, → steps A's tour: " + await steps());
  await ev("A.api.agent.step(-1), B.api.agent.step(-1), document.activeElement.blur(), 1");
  check(await ev("document.querySelectorAll('style[data-sbb-css]').length === 1 && document.querySelectorAll('style[data-mb]').length === 0"), "the board's stylesheet is in the page once");
  // the parts have no ids, which two boards (or a board and its host) would
  // share: the host's own #top, #title and #menu are left as they are
  check(await ev("document.querySelectorAll('#a [id], #b [id]').length === 0"), "ids in the boards: " + await ev("[...document.querySelectorAll('#a [id], #b [id]')].slice(0, 5).map((e) => e.id).join()"));
  check(await ev("getComputedStyle(document.getElementById('top')).position === 'static' && document.getElementById('title').textContent === \"The host's title\" && getComputedStyle(document.getElementById('title')).fontWeight === '400' && getComputedStyle(document.getElementById('menu')).position === 'static'"), "the board's styles reach the host's own #top, #title or #menu");
  // nor its class and element rules: the host's own .menu and buttons
  check(await ev("getComputedStyle(document.querySelector('body > div > .menu')).position === 'static' && getComputedStyle(document.getElementById('hostbtn')).paddingLeft !== '10px' && getComputedStyle(document.querySelector('#a [data-sbb=fit]')).paddingLeft === '10px'"), "the board's rules reach the host's own .menu or buttons: " + await ev("JSON.stringify([getComputedStyle(document.querySelector('body > div > .menu')).position, getComputedStyle(document.getElementById('hostbtn')).padding])"));
  // the parts are within each board's element
  const at = await box("b", "[data-sbb=top]"), bb = await ev("(() => { const r = document.getElementById('b').getBoundingClientRect(); return { left: r.left, right: r.right }; })()");
  check(at.left >= bb.left - 1 && at.right <= bb.right + 1, "B's top bar is within B: " + JSON.stringify([at, bb]));
  check(await ev("[...document.querySelectorAll('#a .board-note, #b .board-note')].every((e) => { const root = e.closest('.sbb'), r = e.getBoundingClientRect(), b = root.getBoundingClientRect(); return r.left >= b.left - 1; })"), "each board's notes are in its own element");
  // what the host does not give is not offered; code shows as text
  check(await ev("['timetravel', 'examples', 'html'].every((id) => document.querySelector('#a [data-sbb=' + id + ']').hidden)"), "no history, examples or export: TimeTravel…, Examples… and Download as HTML are not in the menu");
  check(await until("document.querySelector('#a .board-code-src')?.textContent === 'x = 1' && !document.querySelector('#a .board-code-run')", 3000), "no code engine: code shows as text, with no ▶");
  // each board's menu is its own
  await ev("document.querySelector('#b [data-sbb=menubtn]').click(), 1");
  check(await ev("!document.querySelector('#b [data-sbb=menu]').hidden && document.querySelector('#a [data-sbb=menu]').hidden"), "B's ⋯ opens B's menu");
  await ev("document.body.click(), 1");
  // an edit in A is A's: its store keeps it, B's does not
  await ev("A.api.agent.edit((d) => { d.nodes[0].title = 'Renamed in A'; })");
  const bSaves = await ev("B.kept.saves");
  check(await until(`A.kept.doc.nodes[0].title === 'Renamed in A' && B.kept.saves === ${bSaves} && !B.kept.doc.nodes.some((x) => x.title === 'Renamed in A')`, 3000), "an edit in A goes to A's store only");
  // editing in place, with the mouse, within A
  await ev("A.api.agent.editing(true), A.api.board.focus(['a1'], true), A.api.board.render(), 1");
  await sleep(200);
  const n1 = await ev("(() => { const r = A.api.board.clientRect('a1'); return { x: r.left + 30, y: r.top + 12 }; })()");
  await mouse("mousePressed", n1.x, n1.y); await mouse("mouseReleased", n1.x, n1.y);
  await mouse("mousePressed", n1.x, n1.y, { clickCount: 2 }); await mouse("mouseReleased", n1.x, n1.y, { clickCount: 2 });
  check(await until("A.api.board.editing === 'a1' && !!document.querySelector('#a .board-editing .be-title') && !!document.querySelector('.ip-bar')", 3000), "a double-click edits A's note where it is");
  await send("Input.insertText", { text: "!" });
  await mouse("mousePressed", 1290, 690); await mouse("mouseReleased", 1290, 690);
  check(await until("A.kept.doc.nodes[0].title.includes('!')", 3000), "leaving keeps it, in A's store");
  // destroy: B is gone, and the page's events are no longer its; A goes on
  await ev("B.api.destroy(), 1");
  check(await ev("document.getElementById('b').children.length === 0 && !document.getElementById('b').classList.contains('sbb')"), "destroy() takes B off its element");
  await ev("A.api.agent.edit((d) => { d.nodes[1].code = 'x = 2'; })");
  check(await until(`A.kept.doc.nodes[1].code === 'x = 2' && B.kept.saves === ${bSaves}`, 3000), "A goes on after B is gone");
  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })), 1");
  check(!errors.length, "errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  server.close();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
