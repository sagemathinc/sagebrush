// A board's questions answered with their controls (board.ts askEl), in
// headless Chromium: a radio button, checkboxes, a text, a number (one it
// doesn't take said, not kept), a scale, a yes/no box, and the reader's own
// words; each answer kept in the document at once, one undo step; "Clear
// the answer"; the board's keys and presses not taken from the controls;
// and inline math kept on its line with the punctuation that touches it.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-ask.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
// (the DevTools port: CDP_PORT, so that runs of several agents do not collide)
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ask-"));
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
// a press on the background, away from every item
const outside = async () => { await click(1200, 760); await sleep(250); };
const undoKey = async () => { await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })), 1"); await sleep(250); };

const DOC = {
  title: "Questions",
  layout: "grid",
  columns: 3,
  nodes: [
    { id: "q1", kind: "ask", title: "Radio", text: "Which?", input: "radio", options: [{ value: "a", label: "$x^2$" }, { value: "b", label: "Plan **B**" }] },
    { id: "q2", kind: "ask", title: "Check", text: "Which ones?", input: "check", options: ["one", "two", "three"] },
    { id: "q3", kind: "ask", title: "Text", text: "Name it", input: "text" },
    { id: "q4", kind: "ask", title: "Number", text: "How many?", input: "number", min: 0, max: 10, step: 1 },
    { id: "q5", kind: "ask", title: "Scale", text: "How sure?", input: "scale", low: "no", high: "yes" },
    { id: "q6", kind: "ask", title: "Yes/no", text: "Ship it?", input: "check" },
    { id: "n", title: "A note", text: "Is $p \\equiv 1 \\pmod 4$? And ($q$) too." },
  ],
};
const at = async (sel) => { const r = await elRect(sel); if (!r) throw new Error("no " + sel); return [r.left + Math.min(8, r.width / 2), r.top + r.height / 2]; };
const press = async (sel) => { const [x, y] = await at(sel); await click(x, y); await sleep(200); };
const answer = (id) => node(id).then((x) => x?.answer);
const note = (id) => node(id).then((x) => x?.note);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/` });
  if (!(await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000))) throw new Error("the page's board was not shown");
  await ev("localStorage.clear()");
  await ev(`window.sagebrush.board.load(${JSON.stringify(DOC)}).then(() => 1)`);
  if (!(await until(`window.sagebrush.board.snapshot().doc?.title === ${JSON.stringify(DOC.title)} && !!document.querySelector('.board-ask')`, 20000))) throw new Error("the test's board was not shown");
  await ev("window.board.setCamera({ x: -40, y: -40, z: 1 }), window.board.render(), 1");
  await sleep(300);

  // a radio button: kept at once, the label's math typeset
  await press('input[name^="sbq-q1-"][value="b"]');
  check((await answer("q1")) === "b", "a radio button: its value kept: " + JSON.stringify(await answer("q1")));
  check(await ev("!!document.querySelector('input[name^=\"sbq-q1-\"][value=\"a\"]')?.closest('label').querySelector('.katex')"), "an option's math typeset");
  // checkboxes: the values chosen, in the options' order
  await press('input[name^="sbq-q2-"][value="three"]');
  await press('input[name^="sbq-q2-"][value="one"]');
  check(JSON.stringify(await answer("q2")) === '["one","three"]', "checkboxes: the values chosen, in order: " + JSON.stringify(await answer("q2")));
  // a text: kept when it is left
  await press(".board-ask-text:not(.board-ask-words textarea)");
  await type("the minimal polynomial");
  await click(1200, 760); await sleep(300);
  check((await answer("q3")) === "the minimal polynomial", "a text: kept when left: " + JSON.stringify(await answer("q3")));
  // a number it doesn't take: said, not kept; then one it does
  await press(".board-ask-number");
  await type("11");
  await click(1200, 760); await sleep(300);
  check((await answer("q4")) === undefined && /more than its max, 10/.test(await ev("document.querySelector('.board-ask-why')?.textContent ?? ''")), "a number past its max: said, not kept: " + await ev("document.querySelector('.board-ask-why')?.textContent"));
  await ev("(() => { const n = document.querySelector('.board-ask-number'); n.focus(); n.select(); return 1; })()");
  await type("7");
  await click(1200, 760); await sleep(300);
  check((await answer("q4")) === 7, "a number it takes: kept as a number: " + JSON.stringify(await answer("q4")));
  // a scale: a press keeps it; the same press again takes it back
  await press('.board-ask-scale button:nth-of-type(4)');
  check((await answer("q5")) === 4, "a scale: kept: " + JSON.stringify(await answer("q5")));
  await press('.board-ask-scale button:nth-of-type(4)');
  check((await answer("q5")) === undefined, "a scale: pressed again, taken back");
  // yes/no
  await press('input[name^="sbq-q6-"]');
  check((await answer("q6")) === true, "a yes/no box: true");
  // the reader's own words, on every question: kept, one undo step
  check((await ev("document.querySelectorAll('.board-ask-words').length")) === 6, "every question offers its own words");
  await press('input[name^="sbq-q1-"][value="b"]');
  await ev("(() => { const d = document.querySelector('.board-ask[data-ask=\"q1\"] details'); d.open = true; d.querySelector('textarea').focus(); return 1; })()");
  await type("neither, really: plan C");
  await click(1200, 760); await sleep(300);
  check((await note("q1")) === "neither, really: plan C" && (await answer("q1")) === "b", "own words kept beside the answer: " + JSON.stringify(await note("q1")));
  await undoKey();
  check((await note("q1")) === undefined && (await answer("q1")) === "b", "undo takes back the note, one step");
  // "Clear the answer"
  await ev("(document.querySelector('input[name^=\"sbq-q1-\"]').closest('.board-ask').querySelector('.board-ask-clear').id = 'clear-q1', 1)");
  await press("#clear-q1");
  check((await answer("q1")) === undefined, "Clear the answer: taken back");
  // (math in a text field: shown typeset under it, as it is typed)
  await ev("(() => { const d = document.querySelector('.board-ask[data-ask=\"q3\"] > .board-ask-text'); d.focus(); return 1; })()");
  await type(" of $\\sqrt{2}$");
  check(await until("!![...document.querySelectorAll('.board-ask-preview')].find((p) => !p.hidden && p.querySelector('.katex'))", 5000), "math typed in a text field: shown typeset under it");
  await click(1200, 760); await sleep(300);
  // the board's keys not taken from a control: Delete in Edit, typing in a text field
  await ev("window.sagebrush.board.editing(true), 1");
  await sleep(300);
  await press(".board-ask-text:not(.board-ask-words textarea)");
  await key("Delete");
  await sleep(200);
  check(!!(await node("q3")), "Delete in a question's text field: the question stays");
  await ev("window.sagebrush.board.editing(false), 1");
  // inline math with the punctuation that touches it: one line
  const glued = await ev("[...document.querySelectorAll('.board-nowrap')].map((g) => g.textContent.trim().slice(-1) + g.textContent.trim()[0])");
  check(glued.some((s) => s.startsWith("?")) && glued.some((s) => s.startsWith(")") && s.endsWith("(")), "math kept with the punctuation that touches it: " + JSON.stringify(glued));
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
