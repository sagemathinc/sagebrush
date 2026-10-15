// mountBoard's destroy() leaves nothing behind (web/board/mount.ts), in
// headless Chromium on the board page with its own host: a board with code
// (examples/live.json: its engine, the runner's frame and workers, the
// analyzer) is mounted, run, edited in place, looked at in TimeTravel, and
// destroyed, 20 times.  Afterwards the page has the elements, frames,
// workers and listeners (on window and document) it had before.  (What a page
// gets once, whatever it shows, is there before: the shared stylesheets, the
// notebook's module.  So the page's own board is used as the rounds use theirs
// before the count starts.)  Also: a document loaded while the page's store
// is still opening its own stays; a board destroyed during a drag takes the
// drag's listeners with it.  Serve
// web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-mount.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROUNDS = Number(process.env.ROUNDS ?? 20);
const profile = mkdtempSync(join(tmpdir(), "sb-mount-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1200,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [], held = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Fetch.requestPaused") held.push(m.params.requestId);
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

// what the page holds: elements (body, head), frames, live workers, listeners on window and document
async function census() {
  const listeners = async (expr) => {
    const o = await send("Runtime.evaluate", { expression: expr });
    const r = await send("DOMDebugger.getEventListeners", { objectId: o.result.objectId });
    return r.listeners.map((l) => l.type).sort().join(",");
  };
  return {
    body: await ev("document.body.querySelectorAll('*').length"),
    head: await ev("document.head.children.length"),
    frames: await ev("document.querySelectorAll('iframe').length"),
    workers: await ev("window.__workers()"),
    window: await listeners("window"),
    document: await listeners("document"),
  };
}

try {
  for (const m of ["Page.enable", "Runtime.enable", "DOM.enable"]) await send(m);
  // (workers made and not yet terminated, counted from the start)
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const W = window.Worker; let live = 0;
    window.__workers = () => live;
    window.Worker = class extends W {
      constructor(...a) { super(...a); live++; this.__live = true; }
      terminate() { if (this.__live) { this.__live = false; live--; } super.terminate(); }
    };
  })();` });
  // a document loaded while the page's store is still opening its own (its
  // file held, through CDP): it stays; the store's, arriving later, is not
  // shown over it (the start of several tests, on CI)
  await send("Fetch.enable", { patterns: [{ urlPattern: "*examples/primes.json*" }] });
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/primes.json")}` });
  await until("!!window.sagebrush?.board?.load", 60000);
  for (let i = 0; i < 100 && !held.length; i++) await sleep(20);
  const wasHeld = held.length > 0;
  await ev(`window.sagebrush.board.load({ title: "Loaded meanwhile", nodes: [{ id: "m", title: "Mine" }] }).then(() => 1)`);
  for (const id of held.splice(0)) await send("Fetch.continueRequest", { requestId: id });
  await send("Fetch.disable");
  await sleep(1500);
  check(wasHeld && (await ev("window.sagebrush.board.snapshot().doc.title")) === "Loaded meanwhile", "a document loaded while the store opens its own stays: " + await ev("window.sagebrush.board.snapshot().doc.title"));
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  await ev("localStorage.clear()");
  check(await until("window.sagebrush.board.outputs().then((os) => os.length === 5 && os.every((o) => o.state === ''))", 90000), "the page's board ran its code");
  check(await ev("document.querySelectorAll('iframe').length >= 1 && window.__workers() >= 1"), "...in the runner's frame, with its workers: " + JSON.stringify(await census()));
  // the page's own board, used as the rounds use theirs (a note written in place), then destroyed: what the page holds without a board
  await ev("window.sagebrush.board.editing(true), window.board.focus(['about'], true), window.board.render(), 1");
  await sleep(100);
  await ev("(() => { const r = window.board.clientRect('about'); const x = r.left + 30, y = r.top + 12; document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y })); return 1; })()");
  check(await until("!!document.querySelector('.ip-bar')", 3000), "a note of the page's board is being written");
  await send("Input.insertText", { text: "Kept at destroy" });
  await ev("import('/board/board.js').then((m) => m.mounted.destroy()).then(() => 1)");
  check(await ev("Object.keys(localStorage).some((k) => k.startsWith('sagebrush-board:') && localStorage.getItem(k).includes('Kept at destroy'))"), "what was being written when the board was destroyed is saved (though no longer drawn)");
  const start = await census();
  check(start.frames === 0 && start.workers === 0 && !(await ev("!!document.querySelector('.board-code-engine, .ip-bar, .board-toolbar-panel, style[data-sbb]')")), "destroy() takes the board, its engine, frame and workers away: " + JSON.stringify(start));
  for (let i = 0; i < ROUNDS; i++) {
    await ev("import('/board/board.js').then((m) => { window.__b = m.mountBoard(document.getElementById('board'), m.host); return 1; })");
    const ran = await until("window.__b.agent.outputs().then((os) => os.length === 5 && os.every((o) => o.state === '') && /steps/.test(os.find((o) => o.id === 'path').output))", 90000);
    if (!ran) { fails.push(`round ${i + 1}: the code did not run: ` + await ev("window.__b.agent.outputs().then((os) => JSON.stringify(os.map((o) => [o.id, o.state])))")); break; }
    // every few rounds: a note being written where it is, and TimeTravel's bar open, when it is destroyed
    if (i % 5 === 1) {
      await ev("window.__b.agent.editing(true), window.__b.board.focus(['about'], true), window.__b.board.render(), 1");
      await sleep(100);
      await ev("(() => { const r = window.__b.board.clientRect('about'); const x = r.left + 30, y = r.top + 12; document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y })); return 1; })()");
      check(await until("!!document.querySelector('.ip-bar')", 3000), `round ${i + 1}: a note is being written`);
    }
    if (i % 5 === 3) {
      await ev("window.__b.agent.edit((d) => { d.title = 'Edited ' + Date.now(); })");
      await ev("document.querySelector('#board [data-sbb=timetravel]').click(), 1");
      check(await until("!document.querySelector('#board [data-sbb=tt]').hidden", 5000), `round ${i + 1}: TimeTravel's bar is open`);
    }
    await ev("window.__b.destroy().then(() => { window.__b = null; return 1; })");
  }
  // a board destroyed while one of its notes is dragged (CORR-1D9-1, daybreak): the drag's listeners go with it, and letting go afterwards does nothing
  {
    const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    await ev("import('/board/board.js').then((m) => { window.__b = m.mountBoard(document.getElementById('board'), m.host); return 1; })");
    check(await until("window.__b.agent.snapshot().items.length > 0", 30000), "a board to drag in");
    await ev("window.__b.agent.editing(true), window.__b.board.focus(['about'], true), window.__b.board.render(), 1");
    await sleep(300);
    const p = await ev("(() => { const r = window.__b.board.clientRect('about'); return { x: r.left + r.width / 2, y: r.top + 12, x0: window.__b.board.item('about').x }; })()");
    await mouse("mousePressed", p.x, p.y);
    for (let i = 1; i <= 4; i++) { await mouse("mouseMoved", p.x + 15 * i, p.y); await sleep(40); }
    const moved = await ev("window.__b.board.item('about').x");
    await ev("window.__b.destroy().then(() => { window.__b = null; return 1; })");
    const held = await census();
    check(JSON.stringify(held) === JSON.stringify(start), "destroyed with the button still down, the page holds what it did: " + JSON.stringify({ start, held }));
    for (let i = 5; i <= 8; i++) { await mouse("mouseMoved", p.x + 15 * i, p.y); await sleep(40); }
    await mouse("mouseReleased", p.x + 120, p.y);
    await sleep(400);
    check(moved > p.x0, `the note was being dragged when the board was destroyed: ${p.x0} -> ${moved}`);
  }
  await sleep(500);
  const end = await census();
  check(JSON.stringify(end) === JSON.stringify(start), `after ${ROUNDS} boards mounted and destroyed, the page holds what it did: ` + JSON.stringify({ start, end }));
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
