// Code items on a board (web/board/code.ts): examples/live.json runs, in
// reading order, reactively; outputs show in their items, which grow to hold
// them; editing (the agent API, and the code editor: double-click, then
// Shift+Enter) reruns what depends on the change; deleting an item removes
// its definitions; ▶ runs an item.  Serve web/dist first (python3
// web/serve.py 8765), then
//   node web/board/test-code.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = 9454, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-code-prof-"));
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
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon/.test(m.params.entry.url ?? "")) errors.push(m.params.entry.text + " " + (m.params.entry.url ?? ""));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const outputs = () => ev("window.sagebrush.board.outputs().then((os) => Object.fromEntries(os.map((o) => [o.id, o])))");
const item = (id) => ev(`window.sagebrush.board.snapshot().items.find((it) => it.id === ${JSON.stringify(id)})`);
const show = (id) => ev(`window.board.focus([${JSON.stringify(id)}], true), window.board.render(), 1`);
const setCode = (id, code) => ev(`window.sagebrush.board.edit((d) => { const walk = (ns) => { for (const x of ns) { if (x.id === ${JSON.stringify(id)}) x.code = ${JSON.stringify(code)}; if (x.children) walk(x.children); } }; walk(d.nodes); })`);
try {
  for (const m of ["Page.enable", "Runtime.enable", "Log.enable"]) await send(m);
  // (SLOW=1: a slow network, as a first visit)
  if (process.env.SLOW) { await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true }); await send("Network.emulateNetworkConditions", { offline: false, latency: 300, downloadThroughput: 400000, uploadThroughput: 100000 }); }
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  await ev("localStorage.clear()");
  // everything runs on load, in reading order
  check(await until("window.sagebrush.board.outputs().then((os) => os.length === 5 && os.every((o) => o.state === '' && (o.output || o.id === 'start' || o.id === 'collatz')))", 90000), "the board's code items all ran");
  check(await until("document.querySelectorAll('.board-code .board-code-run').length === 5 && !!document.querySelector('[data-code=path] .board-code-out pre.txt')", 10000), "every code item is shown, with ▶");
  let o = await outputs();
  if (fails.length) fails.push(JSON.stringify(o).slice(0, 600));
  check(/^111 steps, as high as 9232/.test(o.path?.output), "path: " + o.path?.output);
  check(/^27 → 82 → 41/.test(o.head?.output), "head: " + o.head?.output);
  check(/^871 takes 178 steps/.test(o.record?.output), "record: " + o.record?.output);
  const order = await ev("Object.keys(window.sagebrush.board.snapshot()) && [...document.querySelectorAll('.board-code')].map((el) => [el.dataset.code, el.querySelector('.board-code-n').textContent])");
  const nth = Object.fromEntries(order);
  // (by position: rows top to bottom, each left to right)
  const pos = await ev("Object.fromEntries(window.sagebrush.board.snapshot().items.map((it) => [it.id, it]))");
  const byRows = Object.keys(nth).sort((a, b) => (Math.abs(pos[a].y - pos[b].y) < 30 ? pos[a].x - pos[b].x : pos[a].y - pos[b].y));
  check(byRows.every((id, i) => nth[id] === String(i + 1)), "reading order: " + JSON.stringify(nth) + " rows: " + byRows);
  check(Number(nth.start) < Number(nth.path) && Number(nth.collatz) < Number(nth.path) && Number(nth.path) < Number(nth.head), "definitions read before their readers");
  // the output is the notebook's, in the item, and the item holds it
  check(await ev("!!document.querySelector('[data-code=path] .board-code-out pre.txt')"), "path's output is in its item");
  const fits = await until("[...document.querySelectorAll('.board-code')].every((el) => el.scrollHeight <= el.clientHeight + 2)", 5000);
  check(fits, "code items hold their output (no overflow)");
  // a change reruns what reads it, and only that
  const diag = await ev("JSON.stringify({ it: window.board.item('record'), view: window.board.view(), cam: window.board.camera, mounted: window.board.stats.mounted, codes: [...document.querySelectorAll('.board-code')].map((e) => e.dataset.code), pages: location.href })");
  if (!(await ev("!!document.querySelector('[data-code=record] .board-code-out')"))) console.log("note: record was not mounted here (seen once on a first visit): " + diag);
  await show("record");
  const recordBefore = await ev("document.querySelector('[data-code=record] .board-code-out').textContent");
  await ev("window.__marker = document.querySelector('[data-code=record] .board-code-out pre.txt'); 1");
  await setCode("start", "start = 97");
  check(await until("window.sagebrush.board.outputs().then((os) => /^118 steps/.test(os.find((x) => x.id === 'path').output))", 30000), "path reran after start changed");
  o = await outputs();
  check(/^97 → 292/.test(o.head?.output), "head reran: " + o.head?.output);
  check(await ev("document.querySelector('[data-code=record] .board-code-out pre.txt') === window.__marker"), "record did not rerun (its output element is the same)");
  check(recordBefore === (await ev("document.querySelector('[data-code=record] .board-code-out').textContent")), "record's output unchanged");
  // more output: the item grows
  const h0 = (await item("head")).h;
  await setCode("head", "for k in path[:12]:\n    print(k)");
  check(await until("window.sagebrush.board.outputs().then((os) => os.find((x) => x.id === 'head').output.split('\\n').filter(Boolean).length === 12)", 30000), "head printed 12 lines");
  check(await until(`window.sagebrush.board.snapshot().items.find((it) => it.id === 'head').h > ${h0 + 80}`, 10000), "head grew with its output");
  check(await ev("[...document.querySelectorAll('.board-code')].every((el) => el.scrollHeight <= el.clientHeight + 2)"), "still no overflow after growing");
  // an error shows, and its item is marked
  await setCode("start", "start = 1 // 0");
  check(await until("window.sagebrush.board.outputs().then((os) => os.find((x) => x.id === 'start').state === 'failed')", 30000), "start is an error");
  o = await outputs();
  check(/ZeroDivisionError/.test(o.start.output), "the error's traceback: " + o.start.output);
  await show("start");
  check(await until("document.querySelector('[data-code=start]').classList.contains('code-failed')", 3000), "the item shows the error: " + await ev("document.querySelector('[data-code=start]').className + ' ' + window.board.code.state('start') + ' ' + document.querySelectorAll('[data-code=start]').length + ' ' + window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 'start').code"));
  // the code editor: outside Edit, a double-click only flies there; in Edit it opens the editor; type, Shift+Enter
  const dbl = () => ev(`(() => { const el = document.querySelector('[data-code=start]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 })); return 1; })()`);
  await dbl();
  await sleep(600);
  check(await ev("!document.querySelector('.board-editing')"), "outside Edit, a double-click does not edit the item");
  await ev("window.sagebrush.board.editing(true)");
  await show("start");
  await dbl();
  check(await until("!!document.querySelector('[data-code=start].board-editing .be-code')", 5000), "in Edit, a double-click makes the item's code editable where it is");
  await ev(`(() => { const ta = document.querySelector('.board-editing .be-code'); ta.value = 'start = 6'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); return 1; })()`);
  check(await until("window.sagebrush.board.outputs().then((os) => /^8 steps, as high as 16/.test(os.find((x) => x.id === 'path').output))", 30000), "Shift+Enter in its code ran the change");
  check(await ev("!!document.querySelector('[data-code=start].board-editing .be-code')"), "...and it is still being edited");
  await ev("document.querySelector('.board-editing .be-code').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 1");
  check(await until("!document.querySelector('.board-editing') && !document.querySelector('.ip-bar')", 3000), "Esc leaves it");
  check(await ev("window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 'start').code") === "start = 6", "the document has the new code");
  // ▶ runs an item
  await setCode("record", "import time\nprint(time.time())");
  await until("window.sagebrush.board.outputs().then((os) => /^\\d+\\.\\d/.test(os.find((x) => x.id === 'record').output))", 30000);
  const r0 = (await outputs()).record.output;
  await show("record");
  await ev("document.querySelector('[data-code=record] .board-code-run').click(), 1");
  check(await until(`window.sagebrush.board.outputs().then((os) => { const t = os.find((x) => x.id === 'record').output; return /^\\d+\\.\\d/.test(t) && t !== ${JSON.stringify(r0)}; })`, 30000), "▶ ran the item again: " + r0 + " / " + (await outputs()).record.output + " " + await ev("document.querySelector('[data-code=record] .board-code-run')?.outerHTML"));
  // an item added while another runs: its output shows in it when it runs
  await setCode("record", "import time\nt0 = time.time()\nwhile time.time() - t0 < 1.5:\n    pass\nprint('slow')");
  await sleep(300);
  await ev("window.sagebrush.board.edit((d) => { d.nodes.push({ id: 'late', kind: 'code', code: 'print(\"late\", 6 * 7)' }); })");
  check(await until("window.sagebrush.board.outputs().then((os) => os.find((x) => x.id === 'late')?.output === 'late 42\\n')", 30000), "the late item ran");
  await show("late");
  check(await until("document.querySelector('[data-code=late] .board-code-out')?.textContent === 'late 42\\n'", 5000), "its output is in its item: " + await ev("document.querySelector('[data-code=late]')?.innerHTML.slice(0, 300)"));
  await ev("window.sagebrush.board.edit((d) => { d.nodes = d.nodes.filter((x) => x.id !== 'late'); })");
  // deleting an item: its names go, and what read them fails
  await ev("window.sagebrush.board.edit((d) => { d.nodes = d.nodes.filter((x) => x.id !== 'start'); d.edges = d.edges.filter((e) => e.from !== 'start' && e.to !== 'start'); })");
  check(await until("window.sagebrush.board.outputs().then((os) => os.length === 4 && os.find((x) => x.id === 'path').state === 'failed')", 30000), "path fails without start");
  check(/NameError/.test((await outputs()).path.output), "a NameError: " + (await outputs()).path.output);
  // a new item from the menu, at the view's center
  await ev("window.sagebrush.board.editing(true)");
  await ev("document.querySelector('.board-toolbar [data-tool=code]').click(), 1");
  check(await until("document.activeElement === document.querySelector('.board-editing .be-code')", 5000), "Add Python code: its code is being written");
  await ev(`(() => { const ta = document.querySelector('.board-editing .be-code'); ta.value = 'start = 7'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); return 1; })()`);
  check(await until("window.sagebrush.board.outputs().then((os) => os.length === 5 && /^16 steps, as high as 52/.test(os.find((x) => x.id === 'path').output))", 30000), "the new item defines start: path runs again");
  await ev("document.querySelector('.board-editing .be-code').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 1");
  // one kind of item: any note can have code; its parts are edited in the order they show
  await ev("window.sagebrush.board.edit((d) => { d.nodes.push({ id: 'plain', title: 'Square', text: 'A note', x: 3000, y: 0 }); })");
  await show("plain");
  const dblAt = (id) => ev(`(() => { const r = window.board.clientRect(${JSON.stringify(id)}); const x = r.left + 20, y = r.top + 12; document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y })); return 1; })()`);
  await dblAt("plain");
  check(await until("!!document.querySelector('.board-editing .be-title')", 5000), "a note is being edited where it is");
  const partNames = await ev("[...document.querySelectorAll('.board-editing .be-title, .board-editing .be-text, .board-editing .be-codepart, .board-editing .be-detail, .board-editing .be-ref, .ip-bar > button')].filter((e) => e.offsetParent).map((e) => e.classList[0])");
  check(JSON.stringify(partNames) === JSON.stringify(["be-title", "be-text", "ip-image", "ip-code", "ip-detail", "ip-link", "ip-color", "ip-delete"]), "a plain note: its title and text, and a toolbar with + image, + code, + detail, + link, color and delete: " + JSON.stringify(partNames));
  // its text is Markdown, highlighted as in the notebook (headings, math, emphasis), under a clear textarea
  await ev(`(() => { const ta = document.querySelector('.board-editing .be-text'); ta.value = '## Head\\n$x^2$ and **bold**'; ta.dispatchEvent(new Event('input')); return 1; })()`);
  check(await ev("(() => { const ta = document.querySelector('.board-editing .be-text'), pre = ta.parentElement.querySelector('pre'); return ta.parentElement.className === 'be-md' && !!pre.querySelector('.hf') && !!pre.querySelector('.hd') && !!pre.querySelector('.hk') && pre.textContent === ta.value + '\\n' && getComputedStyle(ta).color === 'rgba(0, 0, 0, 0)'; })()"), "a note's text is highlighted Markdown");
  await ev("(() => { const ta = document.querySelector('.board-editing .be-text'); ta.value = 'A note'; ta.dispatchEvent(new Event('input')); return 1; })()");
  await ev("document.querySelector('.ip-bar .ip-code').click(), 1");
  check(await ev("document.activeElement?.classList.contains('be-code') && !document.querySelector('.ip-bar .ip-run').hidden && document.querySelector('.ip-bar .ip-code').hidden"), "+ code: the code is being written, and the toolbar has run instead of + code");
  check(await ev("!!document.querySelector('.board-editing .be-codebox pre')"), "code is written over its highlighted copy");
  await ev(`(() => { const ta = document.querySelector('.board-editing .be-code'); ta.value = 'sq = 12 ** 2\\nprint(sq)'; ta.dispatchEvent(new Event('input')); return 1; })()`);
  check(await ev("document.querySelector('.board-editing .be-codebox pre').textContent.startsWith('sq = 12') && !!document.querySelector('.board-editing .be-codebox pre span')"), "highlighted as it is typed");
  await ev(`(() => { document.querySelector('.board-editing .be-code').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); return 1; })()`);
  check(await until("window.sagebrush.board.outputs().then((os) => os.find((x) => x.id === 'plain')?.output === '144\\n')", 30000), "the note's code ran");
  check(await until("document.querySelector('.board-editing .board-code-out')?.textContent === '144\\n'", 5000), "its output shows in it while it is being written");
  await ev("document.querySelector('.board-editing .be-code').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 1");
  const pn = await ev("window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 'plain')");
  check(pn.title === "Square" && pn.text === "A note" && pn.code === "sq = 12 ** 2\nprint(sq)" && pn.kind === undefined, "the note kept its title and text, and has the code: " + JSON.stringify(pn));
  await show("plain");
  const shown = () => ev("[...document.querySelector('[data-code=plain]').children].map((e) => ['board-code-head', 'board-text', 'board-code-src', 'board-code-out'].find((c) => e.classList.contains(c)) ?? e.className).join()");
  check(await until("document.querySelector('[data-code=plain] .board-code-out')?.textContent === '144\\n'", 5000) && (await shown()) === "board-code-head,board-text,board-code-src,board-code-out", "shown in order: title, text, code, output: " + (await shown()));
  // { } hides the code (its output stays): in Edit, in the document
  await ev("document.querySelector('[data-code=plain] .board-code-toggle').click(), 1");
  check(await until("window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 'plain').hideCode === true", 5000), "in Edit, { } hides the code, in the document");
  await show("plain");
  check(await until("document.querySelector('[data-code=plain] .board-code-out')?.textContent === '144\\n'", 5000) && (await shown()) === "board-code-head,board-text,board-code-out", "hidden: the output shows, not the code: " + (await shown()));
  // outside Edit, { } shows it to this reader only
  await ev("window.sagebrush.board.editing(false)");
  await show("plain");
  await ev("document.querySelector('[data-code=plain] .board-code-toggle').click(), 1");
  check(await until("!!document.querySelector('[data-code=plain] .board-code-src')", 5000), "outside Edit, { } shows the code");
  check((await ev("window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 'plain').hideCode")) === true, "...to this reader: the document still hides it");
  await ev("document.querySelector('[data-code=plain] .board-code-toggle').click(), 1");
  check(await until("!document.querySelector('[data-code=plain] .board-code-src') && !!document.querySelector('[data-code=plain] .board-code-out')", 5000), "{ } again hides it");
  // the editor's switch; and code left empty: a plain note again
  await ev("window.sagebrush.board.editing(true)");
  await show("plain");
  await dblAt("plain");
  await until("!!document.querySelector('.board-editing')", 5000);
  check(await ev("document.querySelector('.ip-bar .ip-hide').getAttribute('aria-pressed') === 'true' && document.querySelector('.board-editing .be-codepart').hidden && !!document.querySelector('.board-editing .board-code-out')"), "being edited, its code stays hidden (its output shows), and { } says so");
  await ev("document.querySelector('.ip-bar .ip-hide').click(), 1");
  check(await until("!document.querySelector('.board-editing .be-codepart').hidden && window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 'plain').hideCode === undefined", 3000), "{ } on its toolbar shows the code again");
  await ev(`(() => { const ta = document.querySelector('.board-editing .be-code'); ta.value = ''; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1; })()`);
  check(await until("(() => { const n = window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 'plain'); return n.code === undefined && n.hideCode === undefined && n.title === 'Square' && n.text === 'A note'; })()", 5000), "code left empty: a plain note again");
  check(await until("window.sagebrush.board.outputs().then((os) => !os.some((x) => x.id === 'plain'))", 10000), "...no longer a code item");
  await ev("window.sagebrush.board.edit((d) => { d.nodes = d.nodes.filter((x) => x.id !== 'plain'); })");
  // run() for agents: everything, then the outputs
  const all = await ev("window.sagebrush.board.run()");
  check(all.length === 5 && all.every((x) => x.state === "" || x.id === "record"), "run(): " + JSON.stringify(all.map((x) => [x.id, x.state])));
  // print has the outputs
  const printed = await ev("window.sagebrush.board.print({ dialog: false }).then(() => document.querySelector('.pr-sheet [data-code=path] .board-code-out')?.textContent ?? JSON.stringify([document.querySelectorAll('.pr-sheet').length, document.querySelectorAll('.pr-sheet .board-code').length, document.querySelector('.pr-sheet')?.dataset.far, document.querySelector('.pr-sheet [data-code=path]')?.outerHTML.slice(0, 300)]))");
  check(/16 steps/.test(printed), "printed sheets show outputs: " + printed.slice(0, 80));
  // widgets (I2): one shown with display() (a builtin, as in IPython), and the
  // item reading it reruns when it changes
  await ev(`window.sagebrush.board.edit((d) => { d.nodes.push({ id: 'wid', code: 'import ipywidgets as wg\\nknob = wg.IntSlider(value=2, min=1, max=9)\\ndisplay(knob)', x: 0, y: 3000 }, { id: 'reader', code: 'print("knob is", knob.value)', x: 600, y: 3000 }); })`);
  check(await until("window.sagebrush.board.outputs().then((os) => /knob is 2/.test(os.find((x) => x.id === 'reader')?.output ?? ''))", 30000), "a widget shown with display() (no import)");
  await show("wid");
  await ev("(() => { const r = [...document.querySelectorAll('.board-item input[type=range]')].pop(); r.value = 7; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()");
  check(await until("window.sagebrush.board.outputs().then((os) => /knob is 7/.test(os.find((x) => x.id === 'reader')?.output ?? ''))", 20000), "moving it reruns the item that reads it");
  // a board's language (I3): Sage from the ⋯ menu, every item runs in it; Python again
  await ev(`window.sagebrush.board.edit((d) => { d.nodes.push({ id: 'pow', code: 'print(2^10)', x: 0, y: 3600 }); })`);
  check(await until("window.sagebrush.board.outputs().then((os) => (os.find((x) => x.id === 'pow')?.output ?? '') === '8\\n')", 20000), "Python: ^ is xor");
  await ev("document.querySelector('#lang [data-mode=sage]').click(), 1");
  check(await until("window.sagebrush.board.outputs().then((os) => (os.find((x) => x.id === 'pow')?.output ?? '') === '1024\\n' && /knob is 2/.test(os.find((x) => x.id === 'reader')?.output ?? ''))", 60000), "Sage, from the menu: ^ is a power, and every item ran again (the knob made anew)");
  check(await ev("window.sagebrush.board.snapshot().doc.mode === 'sage' && document.querySelector('#lang [data-mode=sage]').getAttribute('aria-pressed') === 'true'"), "the document says Sage, and so does the menu");
  await ev("document.querySelector('#lang [data-mode=python]').click(), 1");
  check(await until("window.sagebrush.board.outputs().then((os) => (os.find((x) => x.id === 'pow')?.output ?? '') === '8\\n')", 20000) && await ev("window.sagebrush.board.snapshot().doc.mode === undefined"), "Python again (the default, not written)");
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
