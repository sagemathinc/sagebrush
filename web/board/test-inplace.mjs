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
// (the DevTools port: CDP_PORT, so that runs of several agents do not collide)
const port = Number(process.env.CDP_PORT ?? 9458), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  // (the page's own board shown first, then the test's, and that one checked: as on CI once, the page's arriving later replaced it)
  if (!(await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000))) throw new Error("the page's board was not shown");
  await ev("localStorage.clear()");
  await ev(`window.sagebrush.board.load(${JSON.stringify(DOC)}).then(() => 1)`);
  if (!(await until(`window.sagebrush.board.snapshot().doc?.title === ${JSON.stringify(DOC.title)} && !!window.board?.item("a")`, 20000))) throw new Error("the test's board was not shown: " + await ev("window.sagebrush.board.snapshot().doc?.title"));
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
  await ev("document.querySelector('.board-editing .mb-block').click(), 1");
  await ev("(() => { const t = document.querySelector('.board-editing .mb-edit textarea'); t.setSelectionRange(t.value.length, t.value.length); return 1; })()");
  await type(" and more");
  check(await ev("document.querySelector('.board-editing .mb-edit pre').textContent === 'Some *text* with $x^2$ and more\\n'"), "the text is its Markdown, highlighted as it is typed");
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
  // its code hidden when editing starts, then shown with { }: as tall as its code (William's I1)
  await ev("window.sagebrush.board.edit((d) => { d.nodes.find((x) => x.id === 'c').hideCode = true; })");
  await show("c");
  const rc2 = await rect("c");
  await dblclick(rc2.left + 120, rc2.top + 14);
  await until("window.board.editing === 'c'", 3000);
  await ev("document.querySelector('.ip-bar .ip-hide').click(), 1");
  check(await until("(() => { const t = document.querySelector('.board-editing .be-code'); return !t.closest('[hidden]') && t.offsetHeight >= t.scrollHeight - 1 && t.offsetHeight >= 30; })()", 3000), "code hidden when editing began, shown with { }: its field as tall as its code: " + await ev("(() => { const t = document.querySelector('.board-editing .be-code'); return [t.offsetHeight, t.scrollHeight]; })()"));
  await outside();
  await undoKey();
  await undoKey();

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
  const order = await ev("[...document.querySelector('.board-editing').children].filter((e) => !e.hidden).map((e) => e.classList.contains('be-md') && e.querySelector('.be-detail') ? 'detail' : e.classList.contains('mb') ? 'text' : e.classList[0]).join()");
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
  await ev("document.querySelector('.board-editing .mb-edit') || document.querySelector('.board-editing .mb-block').click(), 1");
  await ev("(() => { const t = document.querySelector('.board-editing .mb-edit textarea'); const dt = new DataTransfer(); dt.setData('text/plain', 'pasted'); dt.setData('text/html', '<b onclick=alert(1)>pasted</b>'); t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()");
  await sleep(200);
  check((await ev("window.sagebrush.board.snapshot().doc.nodes.length")) === count, "a paste in a field makes no note");
  check(await ev("(() => { const v = document.querySelector('.board-editing .mb-edit textarea').value; return v.includes('pasted') && !v.includes('<'); })()"), "a paste in the text is its plain text, never its HTML: " + await ev("document.querySelector('.board-editing .mb-edit textarea').value"));
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

  // a new note from the toolbar: written where it is; left empty, it is
  // kept, to be moved and written in later, saying so in Edit (William's
  // B2); one undo takes it back, not the edit before it
  const n0 = await ev("window.sagebrush.board.snapshot().doc.nodes.length");
  await ev("document.querySelector('.board-toolbar [data-tool=note]').click(), 1");
  check(await until("document.activeElement === document.querySelector('.board-editing .be-title')", 3000), "Note: a new note, its title being written");
  const emptyId = await ev("window.board.editing");
  await outside();
  check((await ev("window.sagebrush.board.snapshot().doc.nodes.length")) === n0 + 1 && !!(await node(emptyId)), "left empty, it is kept (B2)");
  check(await until(`(() => { const e = [...document.querySelectorAll('.board-empty')].at(-1); return !!e && getComputedStyle(e).visibility === 'visible' && /Empty note/.test(e.textContent); })()`, 3000), "...and in Edit it says it is an empty note");
  await undoKey();
  check(!(await node(emptyId)) && (await node("g")).title.endsWith(" two"), "...one undo takes it back, not the edit before it");
  // a new note, dragged by its frame while it is written, then written in (William's I5)
  await ev("document.querySelector('.board-toolbar [data-tool=note]').click(), 1");
  check(await until("!!window.board.editing && document.activeElement === document.querySelector('.board-editing .be-title')", 3000), "Note: a new note being written");
  const nid = await ev("window.board.editing");
  const e1 = await elRect(".board-editing"), x1 = (await ev(`window.board.item(${JSON.stringify(nid)}).x`));
  // (120 pixels on the screen: 120 / zoom in the world)
  const moved = 120 / (await ev("window.board.camera.z"));
  // (its frame: the padding at its left edge)
  const fx = e1.left + 4, fy = e1.top + (e1.bottom - e1.top) / 2;
  await mouse("mousePressed", fx, fy);
  for (let i = 1; i <= 8; i++) await mouse("mouseMoved", fx + 15 * i, fy + 5 * i, { buttons: 1 });
  await mouse("mouseReleased", fx + 120, fy + 40);
  await sleep(300);
  check(await until(`window.board.editing === ${JSON.stringify(nid)} && Math.abs(window.board.item(${JSON.stringify(nid)}).x - ${x1 + moved}) <= 8`, 3000), "dragged by its frame, it moves, and is still being written: " + JSON.stringify([x1, await ev(`window.board.item(${JSON.stringify(nid)})?.x`), await ev("window.board.editing")]));
  await ev("document.querySelector('.board-editing .be-title').focus(), 1");
  await type("Placed first");
  await key("Escape");
  await sleep(300);
  const placed = await node(nid);
  check(placed?.title === "Placed first" && Math.abs(placed.x - (x1 + moved)) <= 8, "then written in, it is kept, where it was put: " + JSON.stringify(placed));
  // markup typed in a title is text
  await show("a");
  await dblclick(r0.left + 40, r0.top + 14);
  await until("window.board.editing === 'a'", 3000);
  await ev("(() => { const t = document.querySelector('.board-editing .be-title'); t.select(); return 1; })()");
  await type("<img src=x onerror=window.__pwn=1>");
  await outside();
  check(await until("[...document.querySelectorAll('.board-note b')].some((b) => b.textContent === '<img src=x onerror=window.__pwn=1>')", 3000) && await ev("!window.__pwn && !document.querySelector('.board-note b img')"), "markup typed in a title stays text");
  // another document shown while a note is being written, with an item of the same id (CORR-A48-4, daybreak): what was being written is dropped, not written into the new one
  const one = (title) => ({ title: "Doc " + title, nodes: [{ id: "same-edit", title, x: 0, y: 0, w: 300 }] });
  await ev(`window.sagebrush.board.load(${JSON.stringify(one("OLD A"))}).then(() => window.sagebrush.board.editing(true)).then(() => 1)`);
  await show("same-edit");
  const ra = await rect("same-edit");
  await dblclick(ra.left + 40, ra.top + 14);
  check(await until("window.board.editing === 'same-edit' && !!document.querySelector('.ip-bar')", 3000), "a note of the first document is being written");
  await ev(`window.sagebrush.board.load(${JSON.stringify(one("NEW B"))}).then(() => 1)`);
  await sleep(300);
  const shownB = await ev(`({ editing: window.board.editing, bar: !!document.querySelector('.ip-bar'), fields: document.querySelectorAll('.board-item textarea, .board-item input').length, text: window.board.cache.get('same-edit')?.textContent ?? null })`);
  check(shownB.editing === null && !shownB.bar && !shownB.fields && /NEW B/.test(shownB.text ?? "") && !/OLD A/.test(shownB.text ?? ""), "another document shown: the note is no longer being written, and shows the new document's: " + JSON.stringify(shownB));
  await ev("window.sagebrush.board.editing(false), 1");
  await sleep(400);
  check((await node("same-edit"))?.title === "NEW B", "...and leaving Edit writes nothing of the old document into the new one: " + JSON.stringify(await node("same-edit")));
  // (and the board itself: an item edited where it is is not kept as edited into another epoch)
  check(await ev("(() => { const b = window.board; b.editElement('same-edit'); b.epoch++; b.setItems(b.itemsIn(-1e9, -1e9, 1e9, 1e9), b.edgeList()); b.render(); return b.editing === null && b.cache.get('same-edit')?.dataset.key.startsWith(b.epoch + '['); })()"), "the board: an element being edited is not kept into another epoch");
  await ev("window.sagebrush.board.editing(false), 1");

  // William: the text being edited does not move as editing starts.  Each
  // part double-clicked where its first line begins: that line's first
  // letter, on the screen, before and after (as shown: its text; being
  // written: the highlighted copy under the field, or where the field puts
  // it); the item high enough that its toolbar has no room above it.
  const STILL = { title: "Still", nodes: [
    { id: "full", title: "TTLA full note", text: "TXTA the text of it, long enough to wrap onto a second line here", detail: "DTLA the detail of it, shown close up", ref: "https://example.org/REFA", x: 0, y: 0, w: 320 },
    { id: "code1", title: "CTTL with a title", text: "CTXT its text", code: "CODEA = 2\nb = 3", x: 400, y: 0, w: 380 },
    { id: "code2", code: "CODEB = 2\nb = 3", x: 400, y: 300, w: 380 },
    { id: "plain", text: "PLNA only text here", x: 0, y: 400, w: 260 },
    { id: "multi", text: "## HDGA a heading\n\nPRGA first paragraph\n\n- LSTA an item\n- LSTB another\n\n> QUTA a quote\n\nPRGB last", x: 0, y: 1000, w: 300 },
    { id: "grp", kind: "group", title: "GRPT the group", text: "GRPX its text", x: 0, y: 600, children: [{ id: "inner", title: "INNT inner", x: 0, y: 0 }] },
    // (untitled notes of other parts than text: only a detail, only a link, a picture and a detail, CORR-9E1-1)
    { id: "detailOnly", detail: "DONA only a detail", x: 800, y: 400, w: 260 },
    { id: "refOnly", ref: "https://example.org/RONA", x: 800, y: 700, w: 260 },
    { id: "picDetail", image: "dot", detail: "PDTA a picture's detail", x: 800, y: 1000, w: 200 },
  ], images: { dot: { w: 4, h: 1, src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" } } };
  // (the first letter of the text, or the field, holding `marker`)
  const firstLine = (marker, edited) => ev(`(() => {
    const root = ${edited} ? window.board.editingElement : document.querySelector('.board-world');
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      const el = t.parentElement;
      if (!t.textContent.includes(${JSON.stringify(marker)}) || el.closest('textarea, [hidden], .board-measure')) continue;
      // (its line's first letter: a highlighted copy's first, its Markdown's, as "## " or "- ")
      const pre = ${edited} && el.closest('pre'), first = pre ? document.createTreeWalker(pre, NodeFilter.SHOW_TEXT).nextNode() : t;
      const r = document.createRange(); r.setStart(first, 0); r.setEnd(first, 1);
      const b = r.getBoundingClientRect();
      if (b.width > 0) return { top: b.top, left: b.left, via: el.tagName };
    }
    // (a field shown as itself, a title or the link: a copy of it laid out as it is)
    for (const f of root.querySelectorAll('textarea, input')) {
      if (!f.value.includes(${JSON.stringify(marker)}) || f.previousElementSibling?.tagName === 'PRE') continue;
      const cs = getComputedStyle(f), fr = f.getBoundingClientRect(), m = document.createElement('div');
      for (const p of ['font', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'borderTopWidth', 'borderLeftWidth', 'borderRightWidth', 'borderStyle', 'boxSizing', 'lineHeight', 'overflowWrap']) m.style[p] = cs[p];
      Object.assign(m.style, { position: 'fixed', left: fr.left + 'px', top: fr.top + 'px', width: fr.width + 'px', whiteSpace: 'pre-wrap', visibility: 'hidden', margin: '0' });
      // (an input's line is in its middle)
      if (f.tagName === 'INPUT') Object.assign(m.style, { height: fr.height + 'px', display: 'flex', alignItems: 'center', whiteSpace: 'pre' });
      m.textContent = f.value;
      document.body.append(m);
      const r = document.createRange(); r.setStart(m.firstChild, 0); r.setEnd(m.firstChild, 1);
      const b = r.getBoundingClientRect(); m.remove();
      return { top: b.top, left: b.left, via: f.tagName };
    }
    return null;
  })()`);
  for (const [id, markers] of [["full", ["TTLA", "TXTA", "DTLA", "REFA"]], ["code1", ["CTTL", "CTXT", "CODEA"]], ["code2", ["CODEB"]], ["plain", ["PLNA"]], ["multi", ["HDGA", "PRGA", "LSTA", "QUTA", "PRGB"]], ["grp", ["GRPT", "GRPX"]], ["detailOnly", ["DONA"]], ["refOnly", ["RONA"]], ["picDetail", ["PDTA"]]]) {
    for (const mk of markers) {
      await ev(`window.sagebrush.board.load(${JSON.stringify(STILL)}).then(() => (window.sagebrush.board.editing(true), 1))`);
      await until(`!!window.board.item(${JSON.stringify(id)})`, 5000);
      await ev(`(() => { const b = window.board.bounds([${JSON.stringify(id)}]); window.board.setCamera({ x: b.x0 - 100, y: b.y0 - 120, z: 1 }); window.board.render(); return 1; })()`);
      await sleep(300);
      const was = {}, now = {};
      for (const m of markers) was[m] = await firstLine(m, false);
      if (!was[mk]) { check(false, `${mk}: not shown`); continue; }
      const at = was[mk];
      // (a link's own click opens it: its double-click as the page gets it)
      if (mk === "REFA" || mk === "RONA") await ev(`(() => { const x = ${at.left + 3}, y = ${at.top + 5}; document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y })); return 1; })()`);
      else await dblclick(at.left + 3, at.top + 5);
      const started = await until(`window.board.editing === ${JSON.stringify(id)}`, 3000);
      await sleep(300);
      // (the part double-clicked, and every other part of the item with it)
      for (const m of markers) {
        now[m] = started ? await firstLine(m, true) : null;
        const dy = now[m] && now[m].top - was[m].top, dx = now[m] && now[m].left - was[m].left;
        check(started && now[m] && Math.abs(dy) < 0.5 && Math.abs(dx) < 0.5, `${id}, ${mk} double-clicked: ${m === mk ? "its" : m + "'s"} first line stays where it was as editing starts: ` + JSON.stringify({ started, dy, dx, was: was[m], now: now[m] }));
      }
      await key("Escape");
      await sleep(200);
      if (await editing()) await outside();
    }
  }
  // (a note with text and no title: no title field until + Title asks for it)
  await ev(`window.sagebrush.board.load(${JSON.stringify(STILL)}).then(() => (window.sagebrush.board.editing(true), 1))`);
  await show("plain");
  const rp = await firstLine("PLNA", false);
  await dblclick(rp.left + 3, rp.top + 5);
  await until("window.board.editing === 'plain'", 3000);
  check(await ev("document.querySelector('.board-editing .be-title').hidden && !document.querySelector('.ip-bar .ip-title').hidden"), "an untitled note: no title field, and + Title: " + await bar());
  await ev("document.querySelector('.ip-bar .ip-title').click(), 1");
  check(await ev("!document.querySelector('.board-editing .be-title').hidden && document.activeElement === document.querySelector('.board-editing .be-title') && document.querySelector('.ip-bar .ip-title').hidden"), "+ Title: its field, being written");
  await type("Named");
  await key("Escape");
  await sleep(300);
  check((await node("plain"))?.title === "Named", "...and kept: " + JSON.stringify(await node("plain")));
  // (a note of only a detail: no title field and no text field above it, + Title and + Text offering them)
  await ev(`window.sagebrush.board.load(${JSON.stringify(STILL)}).then(() => (window.sagebrush.board.editing(true), 1))`);
  await show("detailOnly");
  const rd = await firstLine("DONA", false);
  await dblclick(rd.left + 3, rd.top + 5);
  await until("window.board.editing === 'detailOnly'", 3000);
  check(await ev("(() => { const e = document.querySelector('.board-editing'); return e.querySelector('.be-title').hidden && e.querySelector('.be-text').hidden && document.activeElement === e.querySelector('.be-detail') && !document.querySelector('.ip-bar .ip-title').hidden && !document.querySelector('.ip-bar .ip-text').hidden; })()"), "a note of only a detail: its detail being written, no title or text field, + Title and + Text: " + await bar());
  await ev("document.querySelector('.ip-bar .ip-text').click(), 1");
  check(await ev("(() => { const e = document.querySelector('.board-editing'); return !e.querySelector('.be-text').hidden && e.querySelector('.be-text').contains(document.activeElement) && document.querySelector('.ip-bar .ip-text').hidden; })()"), "+ Text: its field, being written");
  await type("Words");
  await key("Escape");
  await sleep(300);
  if (await editing()) await outside();
  check((await node("detailOnly"))?.text === "Words" && (await node("detailOnly"))?.detail === "DONA only a detail", "...and kept: " + JSON.stringify(await node("detailOnly")));
  // (a code item's ▶ and { }, where they are, while it is being written: run it as written, hide it)
  await show("code1");
  const rk = await firstLine("CODEA", false);
  await dblclick(rk.left + 3, rk.top + 5);
  await until("window.board.editing === 'code1'", 3000);
  check(await ev("(() => { const h = document.querySelector('.board-editing .board-code-head'); return !!h.querySelector('.board-code-run').offsetParent && !!h.querySelector('.board-code-toggle').offsetParent; })()"), "being written, a code item keeps ▶ and { } where they are");
  await ev("(() => { const t = document.querySelector('.board-editing .be-code'); t.value = 'CODEA = 5\\nprint(CODEA * 2)'; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()");
  await ev("document.querySelector('.board-editing .board-code-run').click(), 1");
  check(await until("window.sagebrush.board.outputs().then((os) => os.find((x) => x.id === 'code1')?.output === '10\\n')", 30000) && (await editing()) === "code1", "▶ runs the code as it is written, still being written: " + JSON.stringify(await ev("window.sagebrush.board.outputs()")));
  // ({ }: a toggle named "Show the code", pressed while the code shows; its tooltip the action it takes, A11Y-9E1-2)
  const toggleState = () => ev("(() => { const t = document.querySelector('.board-editing .board-code-toggle'); return [t.getAttribute('aria-label'), t.getAttribute('aria-pressed'), t.title]; })()");
  check(JSON.stringify(await toggleState()) === JSON.stringify(["Show the code", "true", "Hide the code (its output stays)"]), "{ } with the code shown: " + JSON.stringify(await toggleState()));
  await ev("document.querySelector('.board-editing .board-code-toggle').click(), 1");
  check(await until("document.querySelector('.board-editing .be-codepart').hidden && document.querySelector('.board-editing .board-code-toggle').classList.contains('off')", 2000) && (await editing()) === "code1", "{ } hides the code, still being written");
  check(JSON.stringify(await toggleState()) === JSON.stringify(["Show the code", "false", "Show the code"]), "{ } with the code hidden: " + JSON.stringify(await toggleState()));
  await key("Escape");
  await sleep(300);
  if (await editing()) await outside();
  check((await node("code1"))?.hideCode === true, "...and that is kept: " + JSON.stringify(await node("code1")));

  // William's B2 and B3: a grip that drags the item selected, or the one
  // being written; a new item placed clear of what is there; groups made
  // large, resized by their corner and never smaller than their items;
  // things dropped into one landing clear of each other; one a person sized
  // not shrinking when an item leaves it
  const GB = { title: "Groups", nodes: [{ id: "p", title: "Pin", text: "A note", x: 0, y: 0 }, { id: "q", title: "Quill", text: "Another", x: 0, y: 200 }, { id: "r", title: "Rook", text: "A third", x: 0, y: 400 }] };
  await ev(`window.sagebrush.board.load(${JSON.stringify(GB)}).then(() => 1)`);
  await until("!!window.board.item('r')", 10000);
  await ev("window.sagebrush.board.editing(true), window.board.setCamera({ x: -150, y: -100, z: 1 }), window.board.render(), 1");
  await sleep(300);
  const gripOf = (id) => ev(`(() => { const r = window.board.clientRect(${JSON.stringify(id)}); return { x: r.left - 12, y: r.top + 13 }; })()`);
  const dragFrom = async (x, y, dx, dy) => {
    await mouse("mousePressed", x, y);
    for (let i = 1; i <= 8; i++) await mouse("mouseMoved", x + (dx * i) / 8, y + (dy * i) / 8, { buttons: 1 });
    await mouse("mouseReleased", x + dx, y + dy);
    await sleep(350);
  };
  const box = (id) => ev(`(() => { const i = window.board.item(${JSON.stringify(id)}); return i && { x: i.x, y: i.y, w: i.w, h: i.h }; })()`);
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  // a note selected: its grip, outside its top left, drags it
  const rpin = await rect("p");
  await click(rpin.left + 60, rpin.top + 30);
  await sleep(200);
  check(await ev("window.board.grip === 'p'"), "B2: a note selected has a grip");
  const gp = await gripOf("p"), p0 = await node("p");
  await dragFrom(gp.x, gp.y, 200, 40);
  const p1 = await node("p");
  check(Math.abs(p1.x - (p0.x + 200)) <= 12 && Math.abs(p1.y - (p0.y + 40)) <= 12, "B2: its grip drags it: " + JSON.stringify([p0.x, p0.y, p1.x, p1.y]));
  // a new note being written: its grip drags it, still being written; placed clear of what is there
  await ev("document.querySelector('.board-toolbar [data-tool=note]').click(), 1");
  await until("!!window.board.editing", 3000);
  const wn = await ev("window.board.editing");
  check(await ev(`window.board.grip === ${JSON.stringify(wn)}`), "B2: a new note being written has a grip");
  const shown = await Promise.all(["p", "q", "r"].map(box));
  const wb = await box(wn);
  check(shown.every((o) => !overlap(wb, o)), "B3: a new note from the toolbar is placed clear of what is there: " + JSON.stringify([wb, shown]));
  const gw = await gripOf(wn);
  await dragFrom(gw.x, gw.y, 150, 0);
  check((await editing()) === wn && Math.abs((await box(wn)).x - (wb.x + 150)) <= 12, "B2: ...its grip drags it, and it is still being written: " + JSON.stringify([wb.x, (await box(wn)).x, await editing()]));
  await key("Escape");
  await sleep(300);
  // a new group: large, placed clear of what is there
  await ev("document.querySelector('.board-toolbar [data-tool=group]').click(), 1");
  await until("!!window.board.editing", 3000);
  const gid = await ev("window.board.editing");
  await key("Escape");
  await sleep(300);
  const gn = await node(gid), gi = await box(gid);
  check(gn?.w === 480 && gn?.h === 320 && Math.round(gi.w) === 480 && Math.round(gi.h) === 320, "B3: a new group is large, 480 by 320: " + JSON.stringify([gn, gi]));
  const around = await Promise.all(["p", "q", "r", wn].map(box));
  check(around.every((o) => !overlap(gi, o)), "B3: ...and placed clear of what is there: " + JSON.stringify([gi, around]));
  // two notes dropped into it at the same place: the second lands clear of the first
  await ev("window.board.focus(undefined, true), 1");
  await sleep(300);
  const dropIn = async (id) => {
    const a = await rect(id), g = await rect(gid);
    await dragFrom(a.left + 20, a.top + 12, g.left + g.width / 2 - (a.left + 20), g.top + g.height / 2 - (a.top + 12));
  };
  await dropIn("q");
  await dropIn("r");
  const kids = ((await node(gid))?.children ?? []).map((c) => c.id);
  const iq = await box("q"), ir = await box("r");
  check(kids.includes("q") && kids.includes("r"), "B3: two notes dropped into the group are its items: " + JSON.stringify(kids));
  check(!overlap(iq, ir), "B3: ...the second, dropped where the first is, lands clear of it: " + JSON.stringify([iq, ir]));
  // resized by its corner, both ways
  const gr = await rect(gid);
  await click(gr.left + gr.width - 25, gr.top + gr.height - 25);
  await sleep(200);
  check(await ev(`window.board.handle === ${JSON.stringify(gid)} && window.board.grip === ${JSON.stringify(gid)}`), "B3: a group selected has a resize handle (and a grip)");
  // (from its size as shown: its items may need more than it was made)
  const z = await ev("window.board.camera.z"), g0 = await box(gid), gr2 = await rect(gid);
  await dragFrom(gr2.left + gr2.width, gr2.top + gr2.height, 100, 60);
  const g1 = await node(gid), gb1 = await box(gid);
  check(Math.abs(g1.w - (g0.w + 100 / z)) <= 3 && Math.abs(g1.h - (g0.h + 60 / z)) <= 3 && Math.abs(gb1.w - g1.w) <= 1 && Math.abs(gb1.h - g1.h) <= 1, "B3: its corner resizes it, both ways: " + JSON.stringify([g0.w, g0.h, g1.w, g1.h, gb1.w, gb1.h, z]));
  // never smaller than its items need
  const gr3 = await rect(gid);
  await dragFrom(gr3.left + gr3.width, gr3.top + gr3.height, -2000, -2000);
  const gb2 = await box(gid), mq = await box("q"), mr = await box("r");
  check([mq, mr].every((m) => m.x >= gb2.x && m.y >= gb2.y && m.x + m.w <= gb2.x + gb2.w + 1 && m.y + m.h <= gb2.y + gb2.h + 1), "B3: ...never smaller than its items need: " + JSON.stringify([gb2, mq, mr]));
  // an item taken out: the group a person sized keeps its size and place
  const before3 = await box(gid), ar = await rect("r"), grr = await rect(gid);
  await dragFrom(ar.left + 20, ar.top + 12, grr.left + grr.width + 160 - (ar.left + 20), 0);
  const after3 = await box(gid), kids3 = ((await node(gid))?.children ?? []).map((c) => c.id);
  check(!kids3.includes("r") && kids3.includes("q"), "B3: an item dragged out of the group leaves it: " + JSON.stringify(kids3));
  check(Math.abs(after3.w - before3.w) <= 1 && Math.abs(after3.h - before3.h) <= 1 && Math.abs(after3.x - before3.x) <= 1 && Math.abs(after3.y - before3.y) <= 1, "B3: ...and the group keeps its size and place: " + JSON.stringify([before3, after3]));
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
