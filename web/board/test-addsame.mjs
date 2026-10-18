// Another item of the selected item's kind, below it (William's item 7):
// its control by the selected item (a "+", or a chip with its kind's name),
// B or Alt+Enter on the selected item, Alt+Enter in its editor (a code item
// run first).  Checked: its kind and look (a code item's language, a note's
// color and shape, a question's way of being answered), its place (below,
// at its x, the layouts' gap; past what is in the way below, else to the
// right; never over another item; in its group), selected and shown, a note
// or code item written in, no edge, one undo step.  Serve web/dist first
// (python3 web/serve.py 8765), then
//   node web/board/test-addsame.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
// (the DevTools port: CDP_PORT, so that runs of several agents do not collide)
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-addsame-"));
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

const GAP = 40;
const stack = Array.from({ length: 16 }, (_, i) => ({ id: "s" + i, title: "Stack " + i, x: 2400, y: 160 + i * 90, w: 200 }));
const DOC = {
  title: "Add same",
  nodes: [
    { id: "c1", code: "a = 6", x: 0, y: 0, w: 360 },
    { id: "cs", code: "", mode: "sage", x: 0, y: 1400, w: 360 },
    { id: "n1", title: "A note", text: "Colored", color: "#e8f0fb", shape: "round", x: 600, y: 0, w: 300 },
    { id: "q1", kind: "ask", text: "Which?", input: "radio", options: ["one", "two"], x: 1200, y: 0 },
    { id: "c3", code: "b = 7", x: 0, y: 600, w: 360 },
    { id: "blk", title: "In the way", text: "below c3", x: 0, y: 760, w: 360 },
    { id: "r0", title: "Top of a stack", x: 2400, y: 0, w: 200 },
    ...stack,
    { id: "g", kind: "group", title: "Group", x: 1200, y: 600, children: [{ id: "m1", title: "Member", text: "inside", x: 0, y: 0 }] },
  ],
  edges: [{ from: "c1", to: "n1" }],
};
const nodes = () => ev("JSON.stringify(window.sagebrush.board.snapshot().doc.nodes)").then(JSON.parse);
const all = (ns) => ns.flatMap((n) => (n.kind === "group" ? [n, ...all(n.children)] : [n]));
const ids0 = new Set();
const fresh = async () => all(await nodes()).filter((n) => !ids0.has(n.id));
const box = (id) => ev(`(() => { const it = window.board.item(${JSON.stringify(id)}); return it && { x: it.x, y: it.y, w: it.w, h: it.h, parent: it.parent ?? null }; })()`);
// (no two items' boxes overlap, strokes and a group with its own items aside)
const overlaps = (id) => ev(`(() => { const a = window.board.item(${JSON.stringify(id)}); const up = new Set(); for (let p = a.parent; p; p = window.board.item(p)?.parent) up.add(p); return window.board.near(a.x, a.y, a.x + a.w, a.y + a.h).filter((o) => o.id !== a.id && o.kind !== "ink" && !up.has(o.id) && o.x < a.x + a.w && o.x + o.w > a.x && o.y < a.y + a.h && o.y + o.h > a.y).map((o) => o.id); })()`);
const select = async (id) => { await show(id); const r = await rect(id); await click(r.left + r.width / 2, r.top + 10); await sleep(250); return ev(`window.board.grip === ${JSON.stringify(id)}`); };
const settle = async (n) => { await until(`window.sagebrush.board.snapshot().doc && JSON.stringify(window.sagebrush.board.snapshot().doc.nodes).split('"id"').length - 1 >= ${n}`, 5000); await sleep(400); };
const count = async () => all(await nodes()).length;
const leave = async () => { if (await editing()) { await key("Escape"); await sleep(300); } await ev("window.sagebrush.board.editing(true), 1"); };
const forget = async () => { for (const n of await fresh()) ids0.add(n.id); };

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/` });
  if (!(await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000))) throw new Error("the page's board was not shown");
  await ev("localStorage.clear()");
  await ev(`window.sagebrush.board.load(${JSON.stringify(DOC)}).then(() => 1)`);
  if (!(await until(`window.sagebrush.board.snapshot().doc?.title === "Add same" && !!window.board?.item("c1")`, 20000))) throw new Error("the test's board was not shown");
  await ev("window.sagebrush.board.editing(true)");
  await sleep(500);
  for (const n of all(await nodes())) ids0.add(n.id);
  const edges0 = await ev("JSON.stringify(window.sagebrush.board.snapshot().doc.edges)");

  // the "+" by the selected code item: a code item below it, at its x, as wide, the gap under it; written in, no edge
  check(await select("c1"), "a click selects the code item (its grip shown)");
  const c1 = await box("c1");
  const plus = await ev(`(() => { const r = window.board.clientRect("c1"); return { x: r.left + r.width + 4 + 11, y: r.top + 11 }; })()`);
  check(await ev(`window.board.addSameAt(${plus.x}, ${plus.y}) === "c1"`), "the selected item has the + control, just outside its top right corner");
  const n0 = await count();
  await click(plus.x, plus.y);
  await settle(n0 + 1);
  let made = await fresh();
  check(made.length === 1 && made[0].code === "" && made[0].mode === undefined && made[0].kind === undefined, "+ on a code item: one new code item, empty, in the board's language: " + JSON.stringify(made));
  const nb = made[0] && await box(made[0].id);
  check(nb && Math.abs(nb.x - c1.x) < 1 && Math.abs(nb.y - (c1.y + c1.h + GAP)) < 1.5 && Math.abs(nb.w - c1.w) < 1, "...below it: at its x, as wide, the layouts' gap under it: " + JSON.stringify([c1, nb]));
  check(made[0] && (await editing()) === made[0].id && await until("document.activeElement?.classList.contains('be-code')", 3000), "...being written, the caret in its code");
  check(made[0] && (await overlaps(made[0].id)).length === 0, "...over no other item");
  check((await ev("JSON.stringify(window.sagebrush.board.snapshot().doc.edges)")) === edges0, "...and no edge added");
  // one undo takes it away (the visit and its adding: one step)
  await leave();
  await undoKey();
  check(!(await fresh()).length, "one undo takes it away");

  // a code item in its own language: the new one in that language
  check(await select("cs"), "(the Sage code item selected)");
  await key("b");
  await settle(n0 + 1);
  made = await fresh();
  check(made.length === 1 && made[0].mode === "sage" && made[0].code === "", "B on a Sage code item: a Sage code item: " + JSON.stringify(made));
  await leave(); await undoKey();

  // Alt+Enter in a code item's editor: it is run, kept, then another below
  await show("c1");
  const r1 = await rect("c1");
  await dblclick(r1.left + 120, r1.top + 40);
  await until("window.board.editing === 'c1'", 3000);
  await ev("(() => { const t = document.querySelector('.board-editing .be-code'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return 1; })()");
  await type("0");
  await key("Enter", { windowsVirtualKeyCode: 13, modifiers: 1 });
  await settle(n0 + 1);
  made = await fresh();
  check((await node("c1")).code === "a = 60" && made.length === 1 && made[0].code === "", "Alt+Enter in a code item: its code kept, a new code item: " + JSON.stringify([(await node("c1")).code, made]));
  check(made[0] && (await editing()) === made[0].id, "...the new one being written");
  await leave(); await undoKey(); await undoKey();
  check((await node("c1")).code === "a = 6" && !(await fresh()).length, "(undone)");

  // a note: another with its color and shape, below it, written in (B)
  check(await select("n1"), "(the note selected)");
  await key("b");
  await settle(n0 + 1);
  made = await fresh();
  const n1 = await box("n1"), nn = made[0] && await box(made[0].id);
  check(made.length === 1 && made[0].color === "#e8f0fb" && made[0].shape === "round" && made[0].w === 300 && !made[0].text && !made[0].title && made[0].code === undefined, "B on a note: an empty note with its color, shape and width: " + JSON.stringify(made));
  check(nn && Math.abs(nn.x - n1.x) < 1 && Math.abs(nn.y - (n1.y + n1.h + GAP)) < 1.5 && (await editing()) === made[0].id, "...below it, being written: " + JSON.stringify([n1, nn]));
  await leave(); await undoKey();

  // a question: another answered the same way, its options too, not its text nor answer; selected, not written in
  check(await select("q1"), "(the question selected)");
  await key("Enter", { windowsVirtualKeyCode: 13, modifiers: 1 });
  await settle(n0 + 1);
  made = await fresh();
  check(made.length === 1 && made[0].kind === "ask" && made[0].input === "radio" && JSON.stringify(made[0].options) === '["one","two"]' && !made[0].text && made[0].answer === undefined, "Alt+Enter on a selected question: a question answered the same way: " + JSON.stringify(made));
  check(made[0] && (await ev(`window.board.grip === ${JSON.stringify(made[0].id)}`)) && !(await editing()), "...selected, not written in");
  check(made[0] && await ev(`(() => { const r = window.board.clientRect(${JSON.stringify(made[0].id)}); return r.top >= 0 && r.top + r.height <= innerHeight && r.left >= 0 && r.left + r.width <= innerWidth; })()`), "...and in view");
  await leave(); await undoKey();

  // the place below taken: the next free place below what is in the way
  check(await select("c3"), "(c3 selected: a note right under it)");
  await key("b");
  await settle(n0 + 1);
  made = await fresh();
  const blk = await box("blk"), n3 = made[0] && await box(made[0].id);
  check(n3 && Math.abs(n3.x - 0) < 1 && Math.abs(n3.y - (blk.y + blk.h + GAP)) < 1.5 && (await overlaps(made[0].id)).length === 0, "the place below taken: below what is in the way, over nothing: " + JSON.stringify([blk, n3]));
  await leave(); await undoKey();

  // ...taken all the way down (a stack of 16): to its right
  check(await select("r0"), "(the top of a stack selected)");
  await key("b");
  await settle(n0 + 1);
  made = await fresh();
  const r0 = await box("r0"), n4 = made[0] && await box(made[0].id);
  check(n4 && Math.abs(n4.x - (r0.x + r0.w + GAP)) < 1.5 && Math.abs(n4.y - r0.y) < 1.5 && (await overlaps(made[0].id)).length === 0, "...taken further down than 12 items: to its right, over nothing: " + JSON.stringify([r0, n4]));
  await leave(); await undoKey();

  // in a group: another in the same group, after it
  check(await select("m1"), "(a group's member selected)");
  await key("b");
  await settle(n0 + 1);
  made = await fresh();
  const g = (await nodes()).find((n) => n.id === "g");
  check(made.length === 1 && g.children.length === 2 && g.children[1].id === made[0].id && (await box(made[0].id)).parent === "g", "in a group: the new note in that group, after the one selected: " + JSON.stringify(g.children.map((c) => c.id)));
  const m1 = await box("m1"), n5 = made[0] && await box(made[0].id);
  check(n5 && Math.abs(n5.x - m1.x) < 1 && Math.abs(n5.y - (m1.y + m1.h + GAP)) < 1.5 && (await overlaps(made[0].id)).length === 0, "...below it in the group, over nothing: " + JSON.stringify([m1, n5]));
  await leave(); await undoKey();

  // B twice at once, or held down: one item (daybreak2's INPUT-AS-2)
  check(await select("c3"), "(c3 selected)");
  await ev("(() => { for (const k of [0, 1]) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true })); return 1; })()");
  await settle(n0 + 1);
  await sleep(800);
  check((await fresh()).length === 1, "B twice at once: one new item: " + (await fresh()).length);
  await leave(); await undoKey();
  check(await select("c3"), "(c3 selected again)");
  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', repeat: true, bubbles: true, cancelable: true })), 1");
  await sleep(800);
  check(!(await fresh()).length, "a held key's repeat adds nothing");
  // the control's press: only its own pointer's release adds; a cancelled press adds nothing (INPUT-AS-1)
  check(await select("c1"), "(c1 selected again)");
  const p2 = await ev(`(() => { const r = window.board.clientRect("c1"); return { x: r.left + r.width + 4 + 11, y: r.top + 11 }; })()`);
  const pe = (type, id, on = "window") => ev(`(${on === "board" ? "window.board.el" : "window"}).dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { pointerId: ${id}, clientX: ${p2.x}, clientY: ${p2.y}, isPrimary: true, button: 0, buttons: ${type === "pointerdown" ? 1 : 0}, pointerType: "mouse", bubbles: true, cancelable: true })), 1`);
  await pe("pointerdown", 7, "board");
  await pe("pointerup", 8);
  await sleep(600);
  check(!(await fresh()).length, "another pointer's release on the control: nothing added");
  await pe("pointercancel", 7);
  await pe("pointerup", 7);
  await sleep(600);
  check(!(await fresh()).length, "...the press cancelled, then its pointer released there: nothing added");
  await pe("pointerdown", 9, "board");
  await pe("pointerup", 9);
  await settle(n0 + 1);
  check((await fresh()).length === 1, "...a press and its own release there: one added");
  await leave(); await undoKey();

  // the other look: a chip "+ Code" under the item's bottom edge, which adds the same
  await ev("window.board.addSameStyle = 'chip', window.board.request(), 1");
  check(await select("c1"), "(c1 selected again)");
  const c1b = await box("c1");
  const chip = await ev(`(() => { const r = window.board.clientRect("c1"); return { x: r.left + r.width / 2, y: r.top + r.height + 6 + 11 }; })()`);
  check(await ev(`window.board.addSameAt(${chip.x}, ${chip.y}) === "c1" && window.board.addSame?.label === "Code"`), "the chip look: under the item's bottom edge, named for its kind (Code)");
  await click(chip.x, chip.y);
  await settle(n0 + 1);
  made = await fresh();
  const n6 = made[0] && await box(made[0].id);
  check(made.length === 1 && made[0].code === "" && n6 && Math.abs(n6.y - (c1b.y + c1b.h + GAP)) < 1.5, "...a click on it adds a code item below: " + JSON.stringify([made, n6]));
  await leave(); await undoKey();
  await ev("window.board.addSameStyle = 'plus', 1");

  // the new item's real size, measured once laid out: a tall question, a narrow one, over nothing; a group as large as it shows (astra's CORR-2B8-1, CORR-2B8-2)
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "Sizes", nodes: [
    { id: "tq", kind: "ask", text: "Choose", input: "radio", options: Array.from({ length: 14 }, (_, i) => "Choice " + i), x: 0, y: 0 },
    { id: "blockA", title: "OBSTACLE A", x: 0, y: 594, w: 320, h: 80 },
    { id: "nq", kind: "ask", text: "Pick", input: "text", w: 140, x: 1000, y: 0 },
    { id: "blockB", title: "OBSTACLE B", x: 1200, y: 159, w: 180, h: 100 },
    { id: "wg", kind: "group", title: "Wide group", x: 0, y: 1400, children: [{ id: "inside", title: "Child", w: 800, h: 100, x: 0, y: 0 }] },
  ] })}).then(() => 1)`);
  await until(`window.sagebrush.board.snapshot().doc?.title === "Sizes" && !!window.board.item("tq")`, 20000);
  await ev("window.sagebrush.board.editing(true), 1");
  await sleep(500);
  ids0.clear();
  for (const n of all(await nodes())) ids0.add(n.id);
  check(await select("tq"), "(the tall question selected)");
  await key("b");
  await until(`window.sagebrush.board.snapshot().doc.nodes.length === 6`, 5000);
  await sleep(600);
  made = await fresh();
  const tq = await box("tq"), ntq = made[0] && await box(made[0].id), ov1 = made[0] ? await overlaps(made[0].id) : ["?"];
  check(made.length === 1 && ntq && ov1.length === 0 && Math.abs(ntq.x - tq.x) < 1 && Math.abs(ntq.h - tq.h) < 60, "a tall question (14 options): the new one, as tall, over nothing: " + JSON.stringify([tq, ntq, ov1]));
  await leave(); await undoKey();
  check(!(await fresh()).length, "...and one undo takes it away (its move too)");
  check(await select("nq"), "(the narrow question selected)");
  await key("b");
  await until(`window.sagebrush.board.snapshot().doc.nodes.length === 6`, 5000);
  await sleep(600);
  made = await fresh();
  const nq = await box("nq"), nnq = made[0] && await box(made[0].id), ov2 = made[0] ? await overlaps(made[0].id) : ["?"];
  check(made.length === 1 && made[0].w === 140 && nnq && Math.abs(nnq.w - nq.w) < 1 && ov2.length === 0, "a question 140 wide: the new one 140 wide, over nothing: " + JSON.stringify([nq, nnq, ov2]));
  await leave(); await undoKey();
  check(await select("wg"), "(the group sized by its item selected)");
  const wg = await box("wg");
  await key("b");
  await until(`window.sagebrush.board.snapshot().doc.nodes.length === 6`, 5000);
  await sleep(600);
  made = await fresh();
  const nwg = made[0] && await box(made[0].id);
  check(made.length === 1 && made[0].kind === "group" && !made[0].children.length && nwg && Math.abs(nwg.w - wg.w) < 1.5 && Math.abs(nwg.h - wg.h) < 1.5 && (await overlaps(made[0].id)).length === 0, "a group as large as its item makes it: an empty group as large: " + JSON.stringify([wg, nwg]));
  await leave(); await undoKey();
  // far out, but with so few items they are drawn: the control drawn, and pressable (astra's UI-2B8-1)
  check(await select("nq"), "(the narrow question selected again)");
  await ev("(() => { const it = window.board.item('nq'); window.board.setCamera({ x: it.x - 300, y: it.y - 300, z: 0.4 }); window.board.render(); return 1; })()");
  await sleep(400);
  const pz = await ev(`(() => { const r = window.board.clientRect("nq"); return { x: r.left + r.width + 4 + 11, y: r.top + 11 }; })()`);
  check(await ev(`window.board.addSameAt(${pz.x}, ${pz.y}) === "nq"`), "at zoom 0.4, the items drawn: the control there is pressable");
  await click(pz.x, pz.y);
  await until(`window.sagebrush.board.snapshot().doc.nodes.length === 6`, 5000);
  check((await fresh()).length === 1, "...and a click on it adds one");
  await leave(); await undoKey();

  // out of Edit: no control, B does nothing
  await ev("window.sagebrush.board.editing(false), 1");
  await sleep(300);
  check(await ev("window.board.addSame === null"), "out of Edit: no control");
  await key("b");
  await sleep(500);
  check(!(await fresh()).length, "...and B adds nothing");
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
