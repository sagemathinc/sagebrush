// Editing an item where it is (web/board/inplace.ts), with the mouse and
// keyboard in headless Chromium: a double-click in Edit makes the item's
// parts fields at its place and size, the caret where it was clicked; a
// small toolbar floats over it (run, { }, + image, + code, + detail,
// + link, color, delete); leaving (a click outside, Esc) keeps what was
// written, as one undo step; a part left empty is taken off.  Serve web/dist
// first (python3 web/serve.py 8765), then
//   node web/board/test-inplace.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = 9458, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-inplace-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
const click = async (x, y) => { await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
const dblclick = async (x, y) => { await click(x, y); await mouse("mousePressed", x, y, { clickCount: 2 }); await mouse("mouseReleased", x, y, { clickCount: 2 }); await sleep(150); };
const key = (k, extra = {}) => send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: { Enter: 13, Escape: 27, Delete: 46, ArrowRight: 39, ArrowLeft: 37 }[k] ?? 0, ...extra });
const type = (text) => send("Input.insertText", { text });
const node = (id) => ev(`(() => { const f = (ns) => { for (const x of ns) { if (x.id === ${JSON.stringify(id)}) return x; if (x.children) { const y = f(x.children); if (y) return y; } } return null; }; return f(window.sagebrush.board.snapshot().doc.nodes); })()`);
const rect = (id) => ev(`window.board.clientRect(${JSON.stringify(id)})`);
const elRect = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null; })()`);
const show = async (id, z = 1) => { await ev(`(() => { const it = window.board.item(${JSON.stringify(id)}); window.board.setCamera({ x: it.x - 200, y: it.y - 200, z: ${z} }); window.board.render(); return 1; })()`); await sleep(100); };
const editing = () => ev("window.board.editing");
const bar = () => ev("[...document.querySelectorAll('.ip-bar > button')].filter((b) => !b.hidden).map((b) => b.classList[0]).join(' ')");
// a press on the background, away from every item
const outside = async () => { await click(1200, 760); await sleep(250); };
const undoKey = async () => { await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })), 1"); await sleep(250); };

const DOC = {
  title: "In place",
  nodes: [
    { id: "a", title: "Alpha", text: "Some *text* with $x^2$", x: 0, y: 0, w: 300 },
    { id: "b", title: "Beta", text: "More", detail: "A detail", ref: "https://example.org/b", x: 500, y: 0, w: 300 },
    { id: "c", title: "Code", code: "x = 2\nprint(x * 21)", x: 0, y: 400, w: 360 },
    { id: "g", kind: "group", title: "Group", children: [{ id: "m", title: "Member", text: "inside" }], x: 1000, y: 0 },
  ],
  edges: [],
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/` });
  await until("!!window.sagebrush?.board?.load", 60000);
  await ev("localStorage.clear()");
  await ev(`window.sagebrush.board.load(${JSON.stringify(DOC)}).then(() => 1)`);
  await until("window.sagebrush.board.outputs().then((os) => os.length === 1 && os[0].output === '42\\n')", 60000);
  await ev("window.sagebrush.board.editing(true)");

  // a double-click in Edit: the item's own element, where it is, at its size; no panel
  await show("a");
  const r0 = await rect("a");
  await dblclick(r0.left + 40, r0.top + 14);
  check(await until("window.board.editing === 'a'", 3000), "a double-click in Edit edits the item");
  const e0 = await elRect(".board-editing");
  check(e0 && Math.abs(e0.left - r0.left) < 1 && Math.abs(e0.top - r0.top) < 1 && Math.abs(e0.width - r0.width) < 1, "it stays where it is, at its width: " + JSON.stringify([r0, e0]));
  check(await ev("!document.querySelector('.board-editor')"), "no editor panel");
  check(await ev("document.activeElement === document.querySelector('.board-editing .be-title')"), "the title, double-clicked, has the caret");
  check(await ev("(() => { const t = document.querySelector('.board-editing .be-title'); return t.selectionStart > 0 && t.selectionStart < t.value.length; })()"), "...where it was clicked: " + await ev("document.activeElement.selectionStart"));
  check(await ev("getComputedStyle(document.querySelector('.board-editing .be-title')).fontWeight >= 600"), "the title is written as a title");
  // the toolbar: over it, with a plain note's tools
  check((await bar()) === "ip-image ip-code ip-detail ip-link ip-color ip-delete", "a note's toolbar: " + await bar());
  const b0 = await elRect(".ip-bar");
  check(b0 && b0.bottom <= e0.top + 1 && b0.left >= e0.left - 1, "the toolbar floats above the item: " + JSON.stringify([b0, e0]));
  // keys in a field are the field's: arrows do not move the item, Delete does not delete it
  const x0 = (await node("a")).x;
  await key("ArrowRight");
  await key("Delete");
  await sleep(200);
  check((await node("a"))?.x === x0, "keys typed in a field neither move nor delete the item");
  check(await ev("document.querySelector('.board-editing .be-title').value.length === 4"), "...they edit the field (Delete took a letter)");
  await ev("(() => { const t = document.querySelector('.board-editing .be-title'); t.value = 'Alpha'; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()");
  // writing in two fields, then leaving with a click outside: one undo step
  await ev("(() => { const t = document.querySelector('.board-editing .be-title'); t.setSelectionRange(t.value.length, t.value.length); return 1; })()");
  await type(" one");
  await ev("(() => { const t = document.querySelector('.board-editing .be-text'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return 1; })()");
  await type(" and more");
  check(await ev("document.querySelector('.board-editing .be-md pre').textContent === 'Some *text* with $x^2$ and more\\n'"), "the text is its Markdown, highlighted as it is typed");
  check((await node("a")).title === "Alpha", "nothing is kept while writing");
  await outside();
  check(!(await editing()) && await ev("!document.querySelector('.ip-bar')"), "a click outside leaves it, and its toolbar goes");
  let a = await node("a");
  check(a.title === "Alpha one" && a.text === "Some *text* with $x^2$ and more", "leaving keeps what was written: " + JSON.stringify(a));
  check(await until("!!document.querySelector('.board-note .katex') && [...document.querySelectorAll('.board-note b')].some((b) => b.textContent === 'Alpha one')", 3000), "it is shown again (rendered, math typeset)");
  await undoKey();
  a = await node("a");
  check(a.title === "Alpha" && a.text === "Some *text* with $x^2$", "one undo takes back the whole visit: " + JSON.stringify(a));

  // Esc also keeps (there is no Cancel)
  await dblclick(r0.left + 40, r0.top + 14);
  await until("window.board.editing === 'a'", 3000);
  await type("Z");
  await key("Escape");
  await sleep(250);
  check(!(await editing()) && (await node("a")).title.includes("Z"), "Esc leaves, keeping what was written");
  await undoKey();

  // a code item: the code in its box, the caret where it was clicked; Shift+Enter runs it, and it stays open
  await show("c");
  const src = await elRect("[data-code=c] .board-code-src");
  await dblclick(src.left + 8 + 4.3 * 7.5, src.top + 10); // (on line 1, after "x = ")
  check(await until("window.board.editing === 'c'", 3000), "a double-click edits a code item");
  check((await bar()) === "ip-run ip-hide ip-image ip-detail ip-link ip-color ip-delete", "a code item's toolbar: run and { } instead of + code: " + await bar());
  check(await ev("document.activeElement === document.querySelector('.board-editing .be-code')"), "the code, double-clicked, has the caret");
  check(await ev("Math.abs(document.activeElement.selectionStart - 4) <= 1"), "...where it was clicked: " + await ev("document.activeElement.selectionStart"));
  check(await ev("(() => { const e = document.querySelector('.board-editing .be-codebox pre'), s = getComputedStyle(e); return !!e.querySelector('span') && s.fontFamily.includes('monospace'); })()"), "the code is highlighted, in its box");
  await ev("(() => { const t = document.activeElement; t.setSelectionRange(4, 5); return 1; })()");
  await type("3");
  await key("Enter", { modifiers: 8 });
  check(await until("window.sagebrush.board.outputs().then((os) => os[0].output === '63\\n')", 20000), "Shift+Enter runs the code as written");
  check((await editing()) === "c" && await until("document.querySelector('.board-editing .board-code-out')?.textContent === '63\\n'", 5000), "...and it is still being written, its new output in it");
  await type("0");
  await ev("document.querySelector('.ip-bar .ip-run').click(), 1");
  check(await until("window.sagebrush.board.outputs().then((os) => os[0].output === '630\\n')", 20000), "run on its toolbar runs it again");
  await outside();
  check((await node("c")).code === "x = 30\nprint(x * 21)", "the code is kept");
  await undoKey();
  check((await node("c")).code === "x = 2\nprint(x * 21)", "one undo takes back two runs and leaving: " + JSON.stringify((await node("c")).code));
  // { } hides the code (the output stays), as one more change in the visit
  await show("c");
  const rc = await rect("c");
  await dblclick(rc.left + 120, rc.top + 14);
  await until("window.board.editing === 'c'", 3000);
  await ev("document.querySelector('.ip-bar .ip-hide').click(), 1");
  check(await until("document.querySelector('.board-editing .be-codepart').hidden && !!document.querySelector('.board-editing .board-code-out') && document.querySelector('.ip-hide').getAttribute('aria-pressed') === 'true'", 3000), "{ } hides the code, its output stays");
  check((await node("c")).hideCode === true, "...in the document");
  await outside();
  await undoKey();
  check(!(await node("c")).hideCode, "undone");

  // colors: eight and none
  await show("a");
  await dblclick(r0.left + 40, r0.top + 14);
  await until("window.board.editing === 'a'", 3000);
  await ev("document.querySelector('.ip-bar .ip-color').click(), 1");
  check(await ev("document.querySelectorAll('.ip-colors .ip-c').length === 9 && document.querySelector('.ip-colors .ip-c.none').getAttribute('aria-pressed') === 'true'"), "color: eight colors and none (chosen)");
  await ev("[...document.querySelectorAll('.ip-colors .ip-c')].find((b) => b.title === 'Blue').click(), 1");
  check(await until("!document.querySelector('.ip-colors')", 2000) && (await node("a")).color === "#d7e6fa", "choosing Blue colors it: " + (await node("a")).color);
  check(await ev("getComputedStyle(document.querySelector('.board-editing')).backgroundColor === 'rgb(215, 230, 250)'"), "...and it shows at once");
  await ev("document.querySelector('.ip-bar .ip-color').click(), 1");
  await ev("document.querySelector('.ip-colors .ip-c.none').click(), 1");
  check(await until("window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 'a').color === undefined", 2000), "none takes the color off");
  // + detail and + link: fields under the text; left empty, not kept
  await ev("document.querySelector('.ip-bar .ip-detail').click(), 1");
  check(await ev("document.activeElement === document.querySelector('.board-editing .be-detail') && document.querySelector('.ip-bar .ip-detail').hidden"), "+ detail: its field, being written");
  await type("Deep");
  await ev("document.querySelector('.ip-bar .ip-link').click(), 1");
  check(await ev("document.activeElement === document.querySelector('.board-editing .be-ref')"), "+ link: its field, being written");
  const order = await ev("[...document.querySelector('.board-editing').children].filter((e) => !e.hidden).map((e) => e.classList.contains('be-md') && e.querySelector('.be-detail') ? 'detail' : e.classList.contains('be-md') ? 'text' : e.classList[0]).join()");
  check(order === "be-title,text,detail,be-ref", "the parts in the order an item shows them: " + order);
  await type("https://example.org/a");
  await outside();
  a = await node("a");
  check(a.detail === "Deep" && a.ref === "https://example.org/a" && a.color === undefined, "detail and link kept: " + JSON.stringify(a));
  await dblclick(r0.left + 40, r0.top + 14);
  await until("window.board.editing === 'a'", 3000);
  check(await ev("!!document.querySelector('.board-editing .be-detail') && !!document.querySelector('.board-editing .be-ref') && document.querySelector('.ip-bar .ip-detail').hidden && document.querySelector('.ip-bar .ip-link').hidden"), "an item with a detail and a link shows them as fields, and no + for them");
  await ev("(() => { for (const s of ['.be-detail', '.be-ref']) { const f = document.querySelector('.board-editing ' + s); f.value = '  '; f.dispatchEvent(new Event('input', { bubbles: true })); } return 1; })()");
  await key("Escape");
  await sleep(250);
  a = await node("a");
  check(!("detail" in a) && !("ref" in a), "a part left empty is taken off: " + JSON.stringify(a));

  // the camera far out: double-clicking an item comes close enough to write in
  await ev("(() => { const it = window.board.item('b'); window.board.setCamera({ x: it.x - 1500, y: it.y - 900, z: 0.3 }); window.board.render(); return 1; })()");
  await sleep(150);
  const rb = await rect("b");
  await dblclick(rb.left + rb.width / 2, rb.top + rb.height / 2);
  check(await until("window.board.editing === 'b'", 3000), "far out, a double-click edits the item");
  check(await ev("window.board.camera.z >= 0.75 && getComputedStyle(document.querySelector('.board-world')).visibility === 'visible'"), "...close enough to write in: " + await ev("window.board.camera.z"));
  // panning away and back: it stays mounted, and the toolbar follows it
  await ev("window.board.panBy(4000, 0), window.board.render(), 1");
  await sleep(100);
  check(await ev("!!document.querySelector('.board-editing')?.isConnected"), "panned far away, it stays mounted");
  await ev("window.board.panBy(-4000, 0), window.board.render(), 1");
  await sleep(100);
  const eb = await elRect(".board-editing"), bb = await elRect(".ip-bar");
  check(Math.abs(bb.left - Math.max(8, eb.left)) < 2, "the toolbar follows the camera: " + JSON.stringify([eb, bb]));
  // pasting into a field is the field's (no note made of it)
  const count = await ev("window.sagebrush.board.snapshot().doc.nodes.length");
  await ev("(() => { const t = document.querySelector('.board-editing .be-text'); t.focus(); const dt = new DataTransfer(); dt.setData('text/plain', 'pasted'); dt.setData('text/html', '<b onclick=alert(1)>pasted</b>'); t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()");
  await sleep(200);
  check((await ev("window.sagebrush.board.snapshot().doc.nodes.length")) === count, "a paste in a field makes no note");
  // the item removed while it is being written (an agent's edit): editing ends
  await ev("window.sagebrush.board.edit((d) => { d.nodes = d.nodes.filter((x) => x.id !== 'b'); }).then(() => 1)");
  check(await until("!window.board.editing && !document.querySelector('.ip-bar')", 3000), "its item removed by someone else, editing it ends");
  await undoKey();
  check(!!(await node("b")), "(undone)");

  // delete on the toolbar: gone, one undo step
  await show("b");
  const rb2 = await rect("b");
  await dblclick(rb2.left + 40, rb2.top + 14);
  await until("window.board.editing === 'b'", 3000);
  await type("X");
  await ev("document.querySelector('.ip-bar .ip-delete').click(), 1");
  check(await until("!window.board.editing", 2000) && !(await node("b")), "delete removes it");
  await undoKey();
  const b = await node("b");
  check(b?.title === "Beta" && b.detail === "A detail", "undo brings it back as it was: " + JSON.stringify(b));

  // a group: its title and text, and only color and delete
  await show("g", 0.8);
  const rg = await rect("g");
  await dblclick(rg.left + 30, rg.top + 14);
  check(await until("window.board.editing === 'g'", 3000) && (await bar()) === "ip-color ip-delete", "a group: its toolbar has color and delete: " + await bar());
  check(await ev("document.activeElement === document.querySelector('.board-editing .be-title')"), "...and its title is being written");
  await type(" two");
  await outside();
  check((await node("g")).title.endsWith(" two"), "a group's title is kept");

  // a new note from the toolbar: written where it is; left empty, no note and no undo step
  const before = await ev("JSON.stringify(window.sagebrush.board.snapshot().doc)");
  await ev("document.querySelector('.board-toolbar [data-tool=note]').click(), 1");
  check(await until("document.activeElement === document.querySelector('.board-editing .be-title')", 3000), "Note: a new note, its title being written");
  await outside();
  check((await ev("JSON.stringify(window.sagebrush.board.snapshot().doc)")) === before, "left empty, it is not kept");
  await undoKey();
  check(!(await node("g")).title.endsWith(" two"), "...and leaves no undo step (undo takes back the edit before it)");
  // markup typed in a title is text
  await show("a");
  await dblclick(r0.left + 40, r0.top + 14);
  await until("window.board.editing === 'a'", 3000);
  await ev("(() => { const t = document.querySelector('.board-editing .be-title'); t.select(); return 1; })()");
  await type("<img src=x onerror=window.__pwn=1>");
  await outside();
  check(await until("[...document.querySelectorAll('.board-note b')].some((b) => b.textContent === '<img src=x onerror=window.__pwn=1>')", 3000) && await ev("!window.__pwn && !document.querySelector('.board-note b img')"), "markup typed in a title stays text");
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
