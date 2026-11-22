// ci: web-artifacts.1 order=31 runner=bun chrome
// A mirrored conversation and a Delegate task's view on the Agents page, together (M2 with Delegate's UI-3): the built
// page (SAGEBRUSH_AGENTS=1), served by web/serve.py, paired with the stand-in Delegate host (test-delegate-host.mjs),
// with the site's mirror routes answered by this test (Chromium's Fetch domain). What it pins: the two never share the
// main pane (a task shown closes the mirrored conversation; a mirrored conversation opened closes the task's view); a
// task opened while a mirrored conversation is still being read stays (the later choice wins); and, with a cell running
// in the chat, the task's view closes before the "Stop and close?" prompt, so the prompt is asked over the chat it is
// about, and Cancel keeps the chat and its cell.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-mirror-delegate.mjs
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startServe } from "../test-port.mjs";
import { browser } from "./a14-cases.mjs";
import { delegateHost } from "./test-delegate-host.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostUntil = async (f, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(25); } return false; };


// ---- the site's mirror routes, as this test answers them: one conversation of the account this browser doesn't have
const LOC = "0123456789abcdef0123456789abcdef", INST = "aaaaaaaa00000001";
const segs = [{ first_n: 1, last_n: 2, entries: [{ k: "user", n: 1, seq: 1, id: "u1", text: "Plot the partial sums" }, { k: "turn_started", n: 2, seq: 2, turn: "T1" }] }];
const fake = { holdRead: false, held: [], reads: 0, ends: 0 };
function answer(method, path) {
  if (path === "/api/mirror/v1/status") return [200, { available: true, state: "on", bytes: 1234, quota: 5e9, pending: 0, conversations: 1, csrf: "tok" }];
  if (path === "/api/mirror/v1/conversations" && method === "GET")
    return [200, { conversations: [{ conversation: "remote-1", locator: LOC, mode: "B", streams: [{ log_instance: INST, next_n: 3, last_seq: 2, last_digest: "ab".repeat(32), stale_from: null, stale_reason: null }] }] }];
  const m = path.match(/^\/api\/mirror\/v1\/read\/[0-9a-f]{32}\/[A-Za-z0-9_-]+\?after=(\d+)$/);
  if (m) {
    const g = segs.find((s) => s.first_n === +m[1] + 1);
    if (!g) { fake.ends++; return [200, { end: true, stale_from: null, stale_reason: null }]; }
    return [200, { log_instance: INST, first_n: g.first_n, last_n: g.last_n, entries: g.entries, stale_from: null, stale_reason: null }];
  }
  return [404, { error: "not found" }];
}

let server, H, Br;
try {
  const sitePort = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
  const site = `http://127.0.0.1:${sitePort}`;
  H = delegateHost();
  const T = await H.addTask({ title: "Plot it" });
  H.emit(T.task, { type: "turn_started" });
  H.emit(T.task, { type: "message_revised", message: "m1", revision: 1 });
  H.emit(T.task, { type: "text_delta", message: "m1", revision: 1, text: "Plotting the first terms." });
  Br = await browser();
  const P = await Br.tab();
  const fulfill = (requestId, [status, body]) => P.send("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(body)).toString("base64") });
  Br.handlers.add((m) => {
    if (m.sessionId !== P.sessionId || m.method !== "Fetch.requestPaused") return;
    const u = new URL(m.params.request.url), path = u.pathname + u.search;
    const a = answer(m.params.request.method, path);
    if (path.startsWith("/api/mirror/v1/read/")) {
      fake.reads++;
      // (a read held: answered only when the row lets it go)
      if (fake.holdRead) return void fake.held.push(() => fulfill(m.params.requestId, a));
    }
    void fulfill(m.params.requestId, a);
  });
  const release = () => { for (const f of fake.held.splice(0)) void f(); };
  await P.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/mirror/*" }] });
  // (the main pane: which of the chat, a task's view and a mirrored conversation are shown)
  const pane = () => P.ev(`(() => { const q = (s) => document.querySelector(s); const vis = (s) => !!q(s) && !q(s).hidden && !!q(s).offsetParent && getComputedStyle(q(s)).display !== "none";
    return { task: vis('#task-view'), mirror: vis('#mirror-log'), chat: vis('#log'), prompt: !!q('#close-running')?.open }; })()`);
  const openTask = async () => { await P.ev(`document.querySelector('#tasks .task[data-task="${T.task}"]').click()`); await P.until(`!!document.querySelector('#task-view .turn')`); };
  const openMirrorItem = () => P.ev(`(document.querySelector('#threads .thread.mirror').click(), true)`);
  const backToChats = async () => { await P.ev(`document.querySelector('#task-view .task-head .link').click()`); await P.until(`!document.querySelector('#task-view')?.offsetParent`); };
  const toChat = async () => { await P.ev(`document.querySelector('#threads .thread:not(.mirror)').click()`); await P.until(`!!document.querySelector('#log')?.offsetParent`); };

  // ---- paired, Delegate on, the mirror available
  await P.navigate(`${site}/agents/?pair=123-456&port=${H.port}`);
  await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Connect')`, 30000);
  await P.ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Connect').click()`);
  await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Allow')`, 30000);
  await P.ev(`(() => { const d = [...document.querySelectorAll('.sbag-dlg')].at(-1); const all = [...d.querySelectorAll('label')].find((l) => l.textContent.startsWith('Everything')).querySelector('input'); all.checked = true; all.dispatchEvent(new Event('change', { bubbles: true })); [...d.querySelectorAll('button')].find((b) => b.textContent === 'Allow').click(); })()`);
  await P.until(`document.querySelector('#connect').textContent === 'Connected'`);
  await P.until(`!!document.querySelector('#delegate-switch')?.offsetParent`);
  await P.ev(`document.querySelector('#delegate-switch').click()`);
  await P.until(`!!document.querySelector('dialog.delegate-dlg[open]')`);
  await P.ev(`[...document.querySelectorAll('dialog.delegate-dlg[open] button')].find((b) => b.textContent === 'Turn on').click()`);
  await hostUntil(() => H.grant?.delegate === true);
  await P.until(`document.querySelectorAll('#tasks .task').length === 1`);
  ok(await P.until(`!!document.querySelector('#threads .thread.mirror')`, 15000).then(() => true, () => false), "set up: paired, Delegate on with one task, and the account's mirrored conversation listed");

  // ---- MD-1: a mirrored conversation shown, then a task opened: the task's view alone (the mirror closes)
  await openMirrorItem();
  await P.until(`!document.querySelector('#mirror-log').hidden && !!document.querySelector('#mirror-log .mirror-section')`);
  let u = await pane();
  ok(u.mirror && !u.task, "MD-1 precondition: the mirrored conversation shown", u);
  await openTask();
  await sleep(200);
  u = await pane();
  ok(u.task && !u.mirror, "MD-1: a task opened over a mirrored conversation: the task's view alone, the mirrored conversation closed", u);
  await backToChats();
  u = await pane();
  ok(!u.task && !u.mirror && u.chat, "MD-1: Back to chats: the chat, not the mirrored conversation again", u);

  // ---- MD-2: a task's view shown, then a mirrored conversation opened: the mirrored conversation alone
  await openTask();
  await openMirrorItem();
  await P.until(`!document.querySelector('#mirror-log').hidden`, 5000).catch(() => {});
  await sleep(200);
  u = await pane();
  ok(u.mirror && !u.task, "MD-2: a mirrored conversation opened from a task's view: the mirrored conversation alone, the task's view closed", u);
  if (u.task) await backToChats();
  await toChat();

  // ---- MD-3: a task opened while the mirrored conversation is still being read: the task stays
  fake.holdRead = true;
  const r0 = fake.reads;
  await openMirrorItem();
  await hostUntil(() => fake.held.length > 0 && fake.reads > r0, 10000);
  ok(fake.held.length > 0, "MD-3 precondition: the mirrored conversation's read is held");
  await openTask();
  fake.holdRead = false;
  const e0 = fake.ends;
  release();
  // (the read let go runs to its end, as a read that succeeds does: the page has its answer, so the guard decides)
  const readDone = await hostUntil(() => fake.ends > e0, 10000);
  await sleep(300);
  u = await pane();
  ok(readDone, "MD-3: the held read, let go, read to its end (a read that succeeded, not one that failed)");
  ok(u.task && !u.mirror, "MD-3: a task opened while the mirrored conversation was read: the task's view stays, the late read opens nothing", u);
  await backToChats();

  // ---- MD-4: a cell running in the chat, a task's view shown, then a mirrored conversation opened: the task's view
  //      closes BEFORE "Stop and close?", which is asked over the chat; Cancel keeps the chat, its cell running
  await P.ev(`document.querySelector('#new').click()`);
  await P.until(`!!document.querySelector('[data-try]')?.offsetParent`);
  const before = H.got.length;
  await P.ev(`document.querySelector('[data-try]').click()`);
  await hostUntil(() => H.got.slice(before).some((m) => m.method === "chat.message"));
  const conv = H.got.slice(before).find((m) => m.method === "chat.message")?.params.conversation;
  const path = "/notes/held.ipynb";
  await H.call("workspace.create", { path, content: { json: { mode: "python", cells: [{ id: "md0", type: "code", code: "import time\nfor i in range(2400):\n    time.sleep(0.05)" }] } }, mode: "python" });
  const ev = (event) => H.sock.send(JSON.stringify({ jsonrpc: "2.0", method: "turn.event", params: { conversation: conv, turn_id: "t1", event } }));
  ev({ type: "turn_started" });
  ev({ type: "artifact", id: path, kind: "notebook", title: "held.ipynb", path, body: "notebook" });
  ev({ type: "turn_finished", outcome: "completed" });
  const CELL = `document.querySelectorAll('#artifacts .pane-host:not([hidden]) .nb-root .cell')[0]`;
  await P.until(`!!${CELL}`, 60000);
  await P.ev(`${CELL}.querySelector('.runb').click()`);
  ok(await P.until(`${CELL}.classList.contains('running')`, 120000).then(() => true, () => false), "MD-4 precondition: a cell running in the chat's notebook");
  await openTask();
  await openMirrorItem();
  const asked = await P.until(`document.querySelector('#close-running').open`, 5000).then(() => true, () => false);
  u = await pane();
  ok(asked && u.prompt && !u.task && !u.mirror && u.chat, "MD-4: the task's view closed first; then \"Stop and close?\" is asked, over the chat it is about", { asked, u });
  if (asked) await P.ev(`(document.querySelector('#close-running').close('cancel'), true)`);
  await sleep(500);
  u = await pane();
  const running = await P.ev(`!!${CELL} && ${CELL}.classList.contains('running')`);
  ok(!u.task && !u.mirror && u.chat && running, "MD-4: Cancel: the chat stays, its cell still running; no mirrored conversation, no task's view", { u, running });
  // (Stop and close: the cell stopped, the mirrored conversation opens)
  await openMirrorItem();
  await P.until(`document.querySelector('#close-running').open`, 5000);
  await P.ev(`(document.querySelector('#close-running').close('stop'), true)`);
  const opened = await P.until(`!document.querySelector('#mirror-log').hidden`, 10000).then(() => true, () => false);
  u = await pane();
  const stopped = await P.ev(`!document.querySelector('#artifacts .nb-root .cell.running')`);
  ok(opened && u.mirror && !u.task && stopped, "MD-4: Stop and close: the cell stopped, the mirrored conversation opens, no task's view", { opened, u, stopped });
  ok(P.errors.length === 0, "no page errors", P.errors);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  // (each step on its own: one that throws never leaves the others running)
  await Br?.close().catch(() => {});
  try { H?.stop(); } catch {}
  try { server?.kill(); } catch {}
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
