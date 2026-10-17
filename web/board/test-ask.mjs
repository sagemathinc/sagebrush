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
let n = 0; const waiting = new Map(); const errors = []; const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) logs.push(m.params.type + ": " + m.params.args.map((x) => x.value ?? x.description ?? "").join(" ").slice(0, 300));
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
  // ---- the reviews' cases (astra's CORR-448-1, -3, -4, UI-448-2; daybreak2's HARD-448-1, -2)
  const B = "window.sagebrush.board";
  await ev(`${B}.load(${JSON.stringify({ title: "Review", layout: "grid", columns: 3, nodes: [
    { id: "v", kind: "ask", input: "radio", text: "Choose", options: [{ value: "old", label: "Same label" }] },
    { id: "s", kind: "ask", input: "number", text: "Even?", min: 0, max: 10, step: 1 },
    { id: "w", kind: "ask", input: "radio", text: "Words", options: ["a", "b"] },
    { id: "big", kind: "ask", input: "scale", text: "Huge", min: 9007199254740992, max: 9007199254740994 },
    { id: "t", kind: "ask", input: "text", text: "Long" },
  ] })}).then(() => 1)`);
  await until("!!document.querySelector('.board-ask[data-ask=\"v\"]')", 10000);
  await ev("window.board.setCamera({ x: -40, y: -100, z: 1 }), window.board.render(), 1");
  await sleep(300);
  // (a changed option value, the same label: the control the current question's)
  await ev(`${B}.edit((d) => { d.nodes[0].options[0].value = "new"; }).then(() => 1)`);
  await sleep(300);
  await press('.board-ask[data-ask="v"] input[type=radio]');
  check((await answer("v")) === "new", "an option's value changed under the same label: the new value kept: " + JSON.stringify(await answer("v")));
  // (a changed step: 3 refused against step 2)
  await ev(`${B}.edit((d) => { d.nodes[1].step = 2; }).then(() => 1)`);
  await sleep(300);
  await press('.board-ask[data-ask="s"] .board-ask-number');
  await type("3");
  await click(1200, 760); await sleep(300);
  check((await answer("s")) === undefined && /not on its step, 2/.test(await ev("document.querySelector('.board-ask[data-ask=\"s\"] .board-ask-why').textContent")), "a changed step: an answer off it refused: " + JSON.stringify(await answer("s")));
  // (In your own words opened by a real click: the card grows, the field visible and pressable)
  const h0 = await ev("document.querySelector('.board-ask[data-ask=\"w\"]').closest('.board-item').offsetHeight");
  await press('.board-ask[data-ask="w"] summary');
  await sleep(500);
  const hit = await ev("(() => { const t = document.querySelector('.board-ask[data-ask=\"w\"] details textarea'), r = t.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === t; })()");
  const h1 = await ev("document.querySelector('.board-ask[data-ask=\"w\"]').closest('.board-item').offsetHeight");
  check(hit && h1 > h0, "In your own words, opened: its field inside a taller card: " + JSON.stringify({ hit, h0, h1 }));
  await press('.board-ask[data-ask="w"] details textarea');
  await type("some $x^2$ words");
  await sleep(600);
  const h2 = await ev("document.querySelector('.board-ask[data-ask=\"w\"]').closest('.board-item').offsetHeight");
  const focused = await ev("document.activeElement === document.querySelector('.board-ask[data-ask=\"w\"] details textarea')");
  check(h2 > h1 && focused, "its typeset preview grows the card, the field keeps its focus: " + JSON.stringify({ h1, h2, focused }));
  await click(1200, 760); await sleep(300);
  check((await note("w")) === "some $x^2$ words", "...and the words are kept");
  // (a scale whose ends are past 2^53: no buttons, and refused by the check)
  check((await ev("document.querySelectorAll('.board-ask[data-ask=\"big\"] .board-ask-scale button').length")) === 0, "a scale with ends past 2^53: no buttons made");
  // (a paste longer than an answer may be: not previewed, not kept, said)
  await press('.board-ask[data-ask="t"] .board-ask-text');
  await type("y".repeat(12000));
  await sleep(500);
  await click(1200, 760); await sleep(300);
  check((await answer("t")) === undefined && /Longer than 10000 characters/.test(await ev("document.querySelector('.board-ask[data-ask=\"t\"] .board-ask-preview').textContent")), "a 12000-character paste: said, not kept");
  // (a touch double tap on a control: the board does not move)
  const cam0 = await ev("JSON.stringify(window.board.camera)");
  const [tx, ty] = await at('.board-ask[data-ask="w"] input[type=radio]');
  for (let k = 0; k < 2; k++) {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: tx, y: ty }] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(60);
  }
  await sleep(500);
  check((await ev("JSON.stringify(window.board.camera)")) === cam0, "a double tap on a control: the board stays where it is");
  // (TimeTravel: its version's questions shown, not answerable; the board's again after)
  await ev("document.querySelector('[data-sbb=timetravel]').click(), 1");
  await until("!document.querySelector('[data-sbb=tt]').hidden", 5000);
  await sleep(500);
  check(await ev("[...document.querySelectorAll('.board-ask input, .board-ask textarea')].every((x) => x.disabled)"), "while viewing a version: every control disabled");
  await ev("document.querySelector('[data-sbb=ttclose]').click(), 1");
  await sleep(500);
  check(await ev("[...document.querySelectorAll('.board-ask[data-ask=\"w\"] input')].every((x) => !x.disabled)"), "TimeTravel closed: the controls answer again");
  // ---- checks, hints and next (stream 5): run in the board's interpreter, with the board's names
  await ev(`${B}.load(${JSON.stringify({ title: "Checked", layout: "grid", columns: 3, nodes: [
    { id: "c0", code: "G = 12" },
    { id: "k", kind: "ask", input: "number", text: "A divisor of $G$ other than 1",
      check: "G % answer == 0 and answer != 1 or (f'{answer} leaves {G % answer}' if G % answer else False)",
      hints: ["Try a small one.", { code: "f'{G} = 2 * 2 * 3, and {answer} is not one of those'" }], next: { right: "good", wrong: "help" } },
    { id: "good", title: "Well done" },
    { id: "help", title: "Divisors" },
    { id: "slow", kind: "ask", input: "text", text: "Wait", check: "while True: pass", checkMs: 500 },
    { id: "nocheck", kind: "ask", input: "text", text: "Plain" },
  ] })}).then(() => 1)`);
  const K = (sel = "") => `.board-ask[data-ask="k"] ${sel}`;
  const q$ = (sel, then = "") => `document.querySelector(${JSON.stringify(sel)})${then}`;
  await until(q$(K(".board-ask-check"), " !== null"), 20000);
  await ev("window.board.setCamera({ x: -40, y: -100, z: 1 }), window.board.render(), 1");
  await sleep(300);
  check(await ev(q$('.board-ask[data-ask="nocheck"] .board-ask-check', " === null")), "a question with no check: no Check button");
  // (Check with nothing answered: said, nothing run, nothing kept)
  await press(K(".board-ask-check"));
  check(/Answer first/.test(await ev(q$(K(".board-ask-checked .board-ask-why"), ".textContent"))) && (await node("k")).attempts === undefined, "Check with no answer: said, not counted");
  // (a wrong answer, typed and not yet saved: checked as it is; the check's words, the first hint, the wrong way on)
  await press(K("input[type=number]"));
  await type("5");
  await press(K(".board-ask-check"));
  await until("window.sagebrush.board.snapshot().doc.nodes[1].result !== undefined", 30000);
  await sleep(300);
  let q = await node("k");
  check(q.answer === 5 && q.result === "wrong" && q.attempts === 1, "a wrong answer: kept, counted, wrong: " + JSON.stringify(q));
  const kText = () => ev(q$(K(), ".textContent"));
  let t = await kText();
  check(/Not yet/.test(t) && /5 leaves 2/.test(t) && /Try a small one/.test(t) && !/Hint 2/.test(t), "wrong: the verdict, the check's words, one hint: " + t.slice(0, 300));
  check((await ev(q$(K("a.board-ref"), "?.getAttribute('href')"))) === "#help", "wrong: sent on to `next.wrong`");
  const setK = (v, change = false) => ev(`(() => { const n = ${q$(K("input[type=number]"))}; n.value = ${JSON.stringify(v)}; ${change ? "n.dispatchEvent(new Event('change'));" : ""} return 1; })()`);
  // (wrong again: the computed hint, computed with this answer)
  await setK("7");
  await press(K(".board-ask-check"));
  await until("window.sagebrush.board.snapshot().doc.nodes[1].attempts === 2", 30000);
  await sleep(300);
  t = await kText();
  check(/Hint 2/.test(t) && /7 is not one of those/.test(t), "wrong twice: the computed hint, with this answer: " + t.slice(0, 300));
  // (its card as tall as what the check said, also when that changes and the
  // question doesn't, as a second error with the same answer: nothing cut off below)
  await ev(`(() => { window.board.askFeedback.set("k", { message: "a longer message:\\n\\n" + "it says more, line after line. ".repeat(12), hints: [null, "a hint"] }); return ${B}.edit((d) => { d.title = "Checked again"; }).then(() => 1); })()`);
  await sleep(500);
  check(await ev(`(() => { const c = ${q$(K(".board-ask-clear"))}, card = c?.closest(".board-item"); if (!c || !card) return false; return c.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom + 1; })()`), "wrong twice: the card holds its hints, nothing cut off");
  // (right: the verdict, sent on to next.right)
  await setK("4");
  await press(K(".board-ask-check"));
  await until("window.sagebrush.board.snapshot().doc.nodes[1].result === 'right'", 30000);
  await sleep(300);
  q = await node("k");
  check(q.answer === 4 && q.attempts === 3 && /Right/.test(await kText()) && (await ev(q$(K("a.board-ref"), "?.getAttribute('href')"))) === "#good", "right: kept, counted, sent on to `next.right`: " + JSON.stringify([q.answer, q.attempts, q.result]) + " " + (await kText()).slice(0, 300));
  // (another answer: the verdict was the last one's, so it goes)
  await setK("6", true);
  await sleep(400);
  q = await node("k");
  check(q.answer === 6 && q.result === undefined && q.attempts === 3, "an answer changed: its verdict gone, attempts kept: " + JSON.stringify(q));
  // (a check past its deadline: could not decide, not counted; checks run again after)
  await press('.board-ask[data-ask="slow"] .board-ask-text');
  await type("x");
  await press('.board-ask[data-ask="slow"] .board-ask-check');
  await until("window.sagebrush.board.snapshot().doc.nodes[4].result !== undefined", 30000);
  await sleep(300);
  q = await node("slow");
  check(q.result === "error" && q.attempts === undefined && /out of time/.test(await ev(q$('.board-ask[data-ask="slow"]', ".textContent"))), "a check past its deadline: could not decide, not counted: " + JSON.stringify([q.answer, q.attempts, q.result]) + " " + (await ev(q$('.board-ask[data-ask="slow"]', ".textContent"))).slice(0, 300));
  await setK("3");
  await press(K(".board-ask-check"));
  check(await until("window.sagebrush.board.snapshot().doc.nodes[1].result === 'right'", 30000), "after a check out of time: checks run again");
  // (one Check bounded as a whole: six computed hints that never end share
  // the check's 2 x checkMs, not checkMs each, HARD-A19-1)
  await ev(`${B}.edit((d) => { d.nodes.push({ id: "many", kind: "ask", input: "text", text: "Many hints", check: "False", checkMs: 2000, answer: "a", attempts: 5, wrongAttempts: 5, result: "wrong",
    hints: Array.from({ length: 6 }, () => ({ code: "while True:\\n    pass" })) }); }).then(() => 1)`);
  await until(`!!document.querySelector('.board-ask[data-ask="many"] .board-ask-check')`, 10000);
  await ev("(() => { const it = window.board.item('many'); window.board.setCamera({ x: it.x - 40, y: it.y - 40, z: 1 }); window.board.render(); return 1; })()");
  await sleep(300);
  const t0 = Date.now();
  await press('.board-ask[data-ask="many"] .board-ask-check');
  await until("window.sagebrush.board.snapshot().doc.nodes.find((n) => n.id === 'many').attempts === 6", 30000);
  const took = Date.now() - t0, manyText = await ev(q$('.board-ask[data-ask="many"]', ".textContent"));
  // (unbounded, six hints of 2 s each and the runs of the code before them: past 20 s; bounded, the check, the hints' 4 s and a run of the code at the end)
  check(took < 12000 && /this check's time ran out/.test(manyText), `one Check with six endless computed hints ends within its budget (${took} ms): ` + manyText.slice(0, 300));
  // (right twice: no hint, which only wrong attempts reveal, CORR-A19-5)
  await ev(`${B}.edit((d) => { d.nodes.push({ id: "rr", kind: "ask", input: "number", text: "Right twice", check: "answer > 0", hints: ["HINT-A", "HINT-B", "HINT-C"] }); }).then(() => 1)`);
  await until(`!!document.querySelector('.board-ask[data-ask="rr"] .board-ask-check')`, 10000);
  await ev("(() => { const it = window.board.item('rr'); window.board.setCamera({ x: it.x - 40, y: it.y - 40, z: 1 }); window.board.render(); return 1; })()");
  await sleep(300);
  const rr = () => node("rr");
  for (const v of ["1", "2"]) {
    await ev(`(() => { const n = ${q$('.board-ask[data-ask="rr"] input[type=number]')}; n.value = ${JSON.stringify(v)}; return 1; })()`);
    await press('.board-ask[data-ask="rr"] .board-ask-check');
    await until(`window.sagebrush.board.snapshot().doc.nodes.find((n) => n.id === 'rr').answer === ${v}`, 30000);
    await sleep(300);
  }
  const rrq = await rr();
  check(rrq.attempts === 2 && rrq.result === "right" && !rrq.wrongAttempts && !/HINT-/.test(await ev(q$('.board-ask[data-ask="rr"]', ".textContent"))), "right twice: no hint shown: " + JSON.stringify(rrq));
  // (the answer changed while its check runs: the completion is dropped, not written over it, CORR-A19-4)
  await ev(`${B}.edit((d) => { d.nodes.push({ id: "pend", kind: "ask", input: "number", text: "Slow", check: "import time\\ntime.sleep(1.5)\\nanswer == 1", checkMs: 5000 }); }).then(() => 1)`);
  await until(`!!document.querySelector('.board-ask[data-ask="pend"] .board-ask-check')`, 10000);
  await ev("(() => { const it = window.board.item('pend'); window.board.setCamera({ x: it.x - 40, y: it.y - 40, z: 1 }); window.board.render(); return 1; })()");
  await sleep(300);
  await ev(`(() => { const n = ${q$('.board-ask[data-ask="pend"] input[type=number]')}; n.value = "1"; return 1; })()`);
  await press('.board-ask[data-ask="pend"] .board-ask-check');
  await sleep(300);
  await ev(`${B}.edit((d) => { d.nodes.find((n) => n.id === "pend").answer = 2; }).then(() => 1)`);
  await sleep(3000);
  const pq = await node("pend");
  check(pq.answer === 2 && pq.result === undefined && !pq.attempts, "an answer changed while its check ran: the old completion dropped: " + JSON.stringify(pq));
  // (the same, the answer changed and changed back meanwhile: 1 saved, 3 typed
  // and checked, 2 then 1 saved during the check: still dropped, astra's CORR-A19-4 at cb1a5279)
  await ev(`${B}.edit((d) => { const n = d.nodes.find((n) => n.id === "pend"); n.answer = 1; delete n.result; delete n.attempts; }).then(() => 1)`);
  await sleep(500);
  await ev(`(() => { const n = ${q$('.board-ask[data-ask="pend"] input[type=number]')}; n.value = "3"; return 1; })()`);
  await press('.board-ask[data-ask="pend"] .board-ask-check');
  await sleep(300);
  for (const v of [2, 1]) { await ev(`${B}.edit((d) => { d.nodes.find((n) => n.id === "pend").answer = ${v}; }).then(() => 1)`); await sleep(200); }
  await sleep(3000);
  const pq2 = await node("pend");
  check(pq2.answer === 1 && pq2.result === undefined && !pq2.attempts, "an answer changed and changed back while its check ran: the completion dropped: " + JSON.stringify(pq2));
  // (a check that changes the board's own state, through its function: the
  // board's code is run again, in a new interpreter, before the next check
  // runs; it starts from the state the code leaves, CORR-A19-1)
  await ev(`${B}.load(${JSON.stringify({ title: "Fresh", layout: "grid", columns: 2, nodes: [
    { id: "s", code: "class Box:\n    pass\nb = Box()\nb.n = 0\ndef bump():\n    b.n += 1\n    return b.n" },
    { id: "f", kind: "ask", input: "number", text: "Bump", check: "bump() == answer" },
  ] })}).then(() => 1)`);
  await until(`!!document.querySelector('.board-ask[data-ask="f"] .board-ask-check')`, 20000);
  await ev("window.board.setCamera({ x: -40, y: -100, z: 1 }), window.board.render(), 1");
  await sleep(500);
  for (const k of [1, 2]) {
    await ev(`(() => { const n = ${q$('.board-ask[data-ask="f"] input[type=number]')}; n.value = "1"; return 1; })()`);
    await press('.board-ask[data-ask="f"] .board-ask-check');
    await until(`window.sagebrush.board.snapshot().doc.nodes[1].attempts === ${k}`, 30000);
    await sleep(300);
  }
  const fq = await node("f");
  check(fq.attempts === 2 && fq.result === "right" && !fq.wrongAttempts, "a check that changed the board's state: the next one starts fresh (bump() is 1 again): " + JSON.stringify(fq));
  // (the board's own Run, all its code and one item, beside the Checks: astra's CORR-AFB-1)
  const ran = (args) => ev(`window.sagebrush.board.run(${args}).then((os) => JSON.stringify(os.map((o) => [o.id, o.state]))).catch((e) => "ERR " + e)`);
  const all = await ran(""), one = await ran(`["s"]`);
  check(all === '[["s",""]]' && one === '[["s",""]]', "board.run() and board.run([id]) run the code: " + JSON.stringify([all, one]));
  // (a computed hint's text is this document's: another board with the same question, hint and answer computes its own, CORR-CB1-1)
  const hintBoard = (n) => ({ title: "Hints " + n, layout: "grid", columns: 2, nodes: [
    { id: "nc", code: `N = ${n}` },
    { id: "h", kind: "ask", input: "number", text: "N?", check: "False", hints: [{ code: "'N is ' + str(N)" }] },
  ] });
  const hintShown = async (n) => {
    await ev(`${B}.load(${JSON.stringify(hintBoard(n))}).then(() => 1)`);
    await until(`!!document.querySelector('.board-ask[data-ask="h"] .board-ask-check')`, 20000);
    await ev("window.board.setCamera({ x: -40, y: -100, z: 1 }), window.board.render(), 1");
    await sleep(500);
    await ev(`(() => { const n = ${q$('.board-ask[data-ask="h"] input[type=number]')}; n.value = "5"; return 1; })()`);
    await press('.board-ask[data-ask="h"] .board-ask-check');
    await until("window.sagebrush.board.snapshot().doc.nodes[1].attempts === 1", 30000);
    await sleep(300);
    return ev(q$('.board-ask[data-ask="h"]', ".textContent"));
  };
  const h10 = await hintShown(10), h20 = await hintShown(20);
  check(/N is 10/.test(h10) && /N is 20/.test(h20), "a computed hint's text is its own board's: " + JSON.stringify([h10.slice(-60), h20.slice(-60)]));
  // (a computed hint sees the state the board's code leaves, not the check's: astra's note at 7294c800)
  await ev(`${B}.load(${JSON.stringify({ title: "Gen", layout: "grid", columns: 2, nodes: [
    { id: "g0", code: "gen = (i for i in range(20))" },
    { id: "g", kind: "ask", input: "number", text: "Next?", check: "next(gen) == answer", hints: [{ code: "'next is ' + str(next(gen))" }] },
    { id: "g2", kind: "ask", input: "number", text: "Again?", check: "next(gen) == answer" },
  ] })}).then(() => 1)`);
  await until(`!!document.querySelector('.board-ask[data-ask="g"] .board-ask-check')`, 20000);
  await ev("window.board.setCamera({ x: -40, y: -100, z: 1 }), window.board.render(), 1");
  await sleep(500);
  await ev(`(() => { const n = ${q$('.board-ask[data-ask="g"] input[type=number]')}; n.value = "5"; return 1; })()`);
  await press('.board-ask[data-ask="g"] .board-ask-check');
  await until("window.sagebrush.board.snapshot().doc.nodes[1].attempts === 1", 30000);
  await sleep(300);
  check(/next is 0/.test(await ev(q$('.board-ask[data-ask="g"]', ".textContent"))), "a computed hint from the state the code leaves (next is 0): " + (await ev(q$('.board-ask[data-ask="g"]', ".textContent"))).slice(-80));
  // (two Checks at once, on two questions: one after the other, each from the state the code leaves, neither stopped by the other)
  await ev(`(() => { for (const [q, v] of [["g", "0"], ["g2", "0"]]) { const n = document.querySelector('.board-ask[data-ask="' + q + '"] input[type=number]'); n.value = v; } return 1; })()`);
  await ev(`(() => { for (const q of ["g", "g2"]) document.querySelector('.board-ask[data-ask="' + q + '"] .board-ask-check').click(); return 1; })()`);
  await until("(() => { const ns = window.sagebrush.board.snapshot().doc.nodes; return ns[1].attempts === 2 && ns[2].attempts === 1; })()", 60000);
  await sleep(300);
  const [gq, g2q] = [await node("g"), await node("g2")];
  check(gq.result === "right" && g2q.result === "right", "two Checks at once: each right from the state the code leaves: " + JSON.stringify([gq, g2q].map((q) => [q.answer, q.result, q.attempts])));
  // (a question's id is its page's own: page 2's q, the id of page 1's, is
  // checked by its own check, its feedback and verdict its own, also when
  // the reader goes to another page while it runs: CORR-B21-2's sibling for Check)
  await ev(`${B}.load(${JSON.stringify({ title: "Two pages", pages: [
    { id: "one", title: "One", nodes: [{ id: "q", kind: "ask", input: "number", text: "Page one: 1?", check: "answer == 1 or 'page one says no'" }] },
    { id: "two", title: "Two", nodes: [{ id: "q", kind: "ask", input: "number", text: "Page two: 2?", check: "answer == 2 or 'page two says no'" }] },
  ] })}).then(() => 1)`);
  const Q = '.board-ask[data-ask="q"]';
  const onPage = (n) => until(`(${q$(Q, "?.textContent")} || "").includes(${JSON.stringify(n === 1 ? "Page one" : "Page two")}) && !!${q$(Q + " .board-ask-check")}`, 20000);
  const pageQ = (i) => ev(`JSON.stringify(window.sagebrush.board.snapshot().doc.pages[${i}].nodes[0])`).then(JSON.parse);
  const setQ = (v) => ev(`(() => { const n = ${q$(Q + " input[type=number]")}; n.value = ${JSON.stringify(v)}; return 1; })()`);
  await onPage(1);
  await ev("window.board.setCamera({ x: -40, y: -100, z: 1 }), window.board.render(), 1");
  await sleep(300);
  await setQ("5");
  await press(Q + " .board-ask-check");
  await until("window.sagebrush.board.snapshot().doc.pages[0].nodes[0].attempts === 1", 30000);
  await sleep(300);
  check(/page one says no/.test(await ev(q$(Q, ".textContent"))), "page 1's q: its own check's words");
  await ev(`document.querySelector('[data-sbb="pgnext"]').click(), 1`);
  await onPage(2);
  await ev("window.board.setCamera({ x: -40, y: -100, z: 1 }), window.board.render(), 1");
  await sleep(300);
  let pt = await ev(q$(Q, ".textContent"));
  check(!/says no/.test(pt), "page 2's q, the same id: none of page 1's feedback: " + pt.slice(0, 120));
  await setQ("5");
  await press(Q + " .board-ask-check");
  await until("window.sagebrush.board.snapshot().doc.pages[1].nodes[0].attempts === 1", 30000);
  await sleep(300);
  pt = await ev(q$(Q, ".textContent"));
  check(/page two says no/.test(pt) && !/page one/.test(pt), "page 2's q: checked by its own check: " + pt.slice(0, 160));
  await ev(`document.querySelector('[data-sbb="pgprev"]').click(), 1`);
  await onPage(1);
  await sleep(300);
  pt = await ev(q$(Q, ".textContent"));
  check(/page one says no/.test(pt) && !/page two/.test(pt), "back on page 1: its own feedback, none of page 2's: " + pt.slice(0, 160));
  // (Check on page 2, and to page 1 before it finishes: the verdict is page 2's q's, page 1's untouched)
  await ev(`document.querySelector('[data-sbb="pgnext"]').click(), 1`);
  await onPage(2);
  await ev("window.board.setCamera({ x: -40, y: -100, z: 1 }), window.board.render(), 1");
  await sleep(300);
  await setQ("2");
  await ev(`(() => { ${q$(Q + " .board-ask-check")}.click(); document.querySelector('[data-sbb="pgprev"]').click(); return 1; })()`);
  await until("window.sagebrush.board.snapshot().doc.pages[1].nodes[0].attempts === 2", 30000);
  await sleep(500);
  const [p1q, p2q] = [await pageQ(0), await pageQ(1)];
  check(p2q.answer === 2 && p2q.result === "right" && p1q.answer === 5 && p1q.result === "wrong" && p1q.attempts === 1, "a Check whose page is left while it runs: kept with its own page's q, page 1's untouched: " + JSON.stringify([p1q, p2q].map((x) => [x.answer, x.result, x.attempts])));
  // (the pages reordered: no feedback goes with the place, to the other page's
  // q now there; astra's CORR-F11-1 at f112eca4)
  // (page one's q: 5, wrong, "page one says no"; page two's: 2, right; page 1 shown)
  await onPage(1);
  await ev(`window.sagebrush.board.edit((d) => { d.pages.reverse(); }).then(() => 1)`);
  await onPage(2);
  await sleep(500);
  pt = await ev(q$(Q, ".textContent"));
  check(/Page two: 2\?/.test(pt) && /Right/.test(pt) && !/says no/.test(pt), "the pages reordered: page two's q, now first, shows none of page one's feedback: " + pt.slice(0, 160));
  await ev(`document.querySelector('[data-sbb="pgnext"]').click(), 1`);
  await until(`(${q$(Q, "?.textContent")} || "").includes("Page one")`, 20000);
  await sleep(500);
  pt = await ev(q$(Q, ".textContent"));
  check(/Page one: 1\?/.test(pt) && !/page two/.test(pt), "and page one's q, now second, none of page two's: " + pt.slice(0, 160));
  // (a Check running when the pages are reordered: dropped, its verdict recorded on neither page's q; by page id, in id order)
  const byPage = () => ev(`JSON.stringify(window.sagebrush.board.snapshot().doc.pages.map((p) => [p.id, p.nodes[0].answer, p.nodes[0].result, p.nodes[0].attempts]).sort())`);
  await setQ("1");
  const before = await byPage();
  await ev(`(() => { ${q$(Q + " .board-ask-check")}.click(); window.sagebrush.board.edit((d) => { d.pages.reverse(); }); return 1; })()`);
  await sleep(5000);
  const after = await byPage();
  check(after === before, "a Check running as the pages are reordered: dropped, neither page's q changed: " + after + " (before " + before + ")");
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
if (fails.length) for (const l of logs.slice(-40)) console.log("console", l);
process.exit(fails.length ? 1 : 0);
