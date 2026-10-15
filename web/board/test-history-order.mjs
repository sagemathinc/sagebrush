// TimeTravel's versions, recorded once an edit is drawn (mount.ts), with a
// fake history whose opening can be held (daybreak's repros of ca3bf8d):
// another document shown while the first's history opens: each document's
// versions in its own history, in order (CORR-CA3-1); TimeTravel's bar
// asked for meanwhile: not opened over the other document, nor anything of
// it recorded in the first's history (CORR-CA3-2); the board destroyed with
// versions waiting: recorded first (CORR-CA3-3).  Serve web/dist first
// (python3 web/serve.py 8765), then
//   node web/board/test-history-order.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-horder-prof-"));
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
const until = async (expr, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(30); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

// in the page: a board mounted with a store naming documents d1, d2, ... and a history per name whose opening is held until let go
const SETUP = `(async () => {
  const m = await import(new URL("board.js", location.href).href);
  await m.mounted.destroy();
  window.__m = m;
  window.mountWith = async (title, autoOpen) => {
    if (window.cur) { await window.cur.b.destroy(); window.cur.el.remove(); }
    const H = { calls: [], open: {}, hist: {} };
    let n = 0, id = null;
    const doc = { title, nodes: [{ id: "a", title: "A note", x: 0, y: 0 }] };
    const store = { load: async () => ({ doc }), save() {}, documentId: (fresh) => (fresh || !id ? (id = "d" + ++n) : id) };
    const fake = (name) => {
      const f = { name, docs: [], notes: [], closed: 0, ons: 0, record(d) { if (this.closed) throw new Error("recorded after closing: " + name); this.docs.push(d.title); this.notes.push(d.nodes?.[0]?.title); }, versions() { return this.docs.map((t, i) => ({ time: String(i), ms: 0, index: i })); }, docAt() { return doc; }, on() { this.ons++; return () => {}; }, close() { this.closed++; } };
      H.hist[name] = f;
      return f;
    };
    const history = (name) => { H.calls.push(name); if (autoOpen) return Promise.resolve(fake(name)); return new Promise((ok) => { H.open[name] = () => ok(fake(name)); }); };
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;inset:0";
    document.body.append(el);
    const b = m.mountBoard(el, { images: m.host.images, store, history, dropHistory: async () => {} });
    window.cur = { b, el, H };
    for (let i = 0; i < 100 && b.agent.snapshot().doc?.title !== title; i++) await new Promise((r) => setTimeout(r, 20));
    return 1;
  };
  return 1;
})()`;
const H = (expr) => ev(`(() => { const H = window.cur.H; return ${expr}; })()`);
const edit = (title) => ev(`window.cur.b.agent.edit((d) => { d.title = ${JSON.stringify(title)}; }).then(() => 1)`);
const recorded = (name) => H(`H.hist[${JSON.stringify(name)}] ? { docs: H.hist[${JSON.stringify(name)}].docs, notes: H.hist[${JSON.stringify(name)}].notes, closed: H.hist[${JSON.stringify(name)}].closed, ons: H.hist[${JSON.stringify(name)}].ons } : null`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/?runner=0` });
  if (!(await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000))) throw new Error("the page's board was not shown");

  // the page's own board and history: versions waiting (frames held) when the
  // page goes out of sight, or away: recorded, there after a reload (CORR-CA3-3)
  for (const [how, fire] of [["out of sight", "Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));"], ["away", "window.dispatchEvent(new Event('pagehide'));"]]) {
    const count0 = await ev("window.sagebrush.board.versions().then((v) => v.length)");
    await ev("(() => { window.requestAnimationFrame = () => 1; return 1; })()");
    await ev(`window.sagebrush.board.edit((d) => { d.title = ${JSON.stringify("Flushed " + how)}; }).then(() => 1)`);
    await ev(`(() => { ${fire} return 1; })()`);
    await sleep(400);
    await send("Page.reload");
    await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
    const vs = await ev("window.sagebrush.board.versions()"), last = vs.length ? await ev(`window.sagebrush.board.version(${vs.length - 1}).then((d) => d?.title)`) : null;
    check(vs.length >= count0 + 1 && last === "Flushed " + how, `the page ${how} with versions waiting: recorded, there after a reload: ` + JSON.stringify({ count0, count: vs.length, last }));
  }
  await ev(SETUP);

  // CORR-CA3-1: d1's history held while it opens; another document (C, D) shown and edited; then each opens
  await ev(`mountWith("A", false)`);
  await edit("B");
  check(await until(`window.cur.H.calls.includes("d1")`), "the edit's versions ask for the document's history: " + JSON.stringify(await H("H.calls")));
  await ev(`window.cur.b.agent.load({ title: "C", nodes: [{ id: "c", title: "C note" }] }).then(() => 1)`);
  await edit("D");
  await sleep(100);
  await H(`(H.open.d1(), 1)`);
  await until(`!!window.cur.H.open.d2`);
  await H(`(H.open.d2?.(), 1)`);
  await ev("window.cur.b.agent.versions().then(() => 1)");
  await sleep(100);
  const d1 = await recorded("d1"), d2 = await recorded("d2");
  check(JSON.stringify(d1?.docs) === '["A","B"]' && d1?.closed === 1 && JSON.stringify(d2?.docs) === '["C","D"]', "another document shown while the first's history opened: each one's versions in its own history, in order: " + JSON.stringify({ d1, d2 }));

  // CORR-CA3-2: TimeTravel asked for while d1 opens; another document shown; then d1 opens
  await ev(`mountWith("A", false)`);
  await edit("B");
  await until(`window.cur.H.calls.includes("d1")`);
  await ev("document.querySelector('[data-sbb=timetravel]').click(), 1");
  await ev(`window.cur.b.agent.load({ title: "C", nodes: [{ id: "c", title: "C note" }] }).then(() => 1)`);
  await H(`(H.open.d1(), 1)`);
  await sleep(200);
  const bar = await ev("!window.cur.el.querySelector('[data-sbb=tt]').hidden"), e1 = await recorded("d1"), now = await ev("window.cur.b.agent.snapshot().doc.title");
  check(!bar && now === "C" && !e1?.docs.includes("C") && e1?.closed === 1, "TimeTravel asked for while the history opened, another document shown meanwhile: no bar over it, nothing of it in the first's history: " + JSON.stringify({ bar, now, d1: e1 }));
  await H(`(H.open.d2?.(), 1)`);

  // CORR-CA3-3: the history open; frames held; an edit; the board destroyed
  await ev(`mountWith("A", true)`);
  await ev("window.cur.b.agent.versions().then(() => 1)");
  await ev("(() => { window.__raf = window.requestAnimationFrame; window.__held = []; window.requestAnimationFrame = (f) => (window.__held.push(f), 1); return 1; })()");
  await edit("B");
  await ev("window.cur.b.destroy().then(() => 1)");
  const e3 = await recorded("d1");
  await ev("(() => { window.requestAnimationFrame = window.__raf; window.cur.el.remove(); window.cur = null; return 1; })()");
  check(JSON.stringify(e3?.docs) === '["A","B"]' && e3?.closed === 1, "destroyed with versions waiting for a frame: recorded first, then closed: " + JSON.stringify(e3));
  // CORR-54B-1: a history still opening, nothing waiting to be recorded, the board destroyed; then it opens: closed, not listened to
  await ev(`mountWith("A", false)`);
  await ev("(window.cur.b.agent.versions(), 1)");
  await until(`window.cur.H.calls.includes("d1")`);
  await ev("window.cur.b.destroy().then(() => 1)");
  await H(`(H.open.d1(), 1)`);
  await sleep(100);
  const s1 = await recorded("d1");
  await ev("(() => { window.cur.el.remove(); window.cur = null; return 1; })()");
  check(s1?.closed === 1 && s1?.ons === 0, "destroyed while its history opened: once open, it is closed and not listened to: " + JSON.stringify(s1));

  // CORR-54B-2: a note being written when the board is destroyed: kept, and a version of it
  await ev(`mountWith("A", true)`);
  await edit("B");
  await ev("window.cur.b.agent.versions().then(() => 1)");
  await ev("window.cur.b.agent.editing(true), window.cur.b.board.focus(['a'], true), window.cur.b.board.render(), 1");
  await sleep(200);
  await ev("(() => { const r = window.cur.b.board.clientRect('a'); const x = r.left + 20, y = r.top + 12; document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y })); return 1; })()");
  const open = await until("!!window.cur.el.querySelector('.board-editing')", 3000);
  await ev("(() => { const f = window.cur.el.querySelector('.board-editing .be-title, .board-editing input, .board-editing textarea'); f.value = 'Written as destroyed'; f.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()");
  await ev("window.cur.b.destroy().then(() => 1)");
  const s2 = await recorded("d1");
  await ev("(() => { window.cur.el.remove(); window.cur = null; return 1; })()");
  check(open && s2?.notes.at(-1) === "Written as destroyed" && s2?.closed === 1, "a note being written when the board is destroyed: a version of it, then the history closed: " + JSON.stringify(s2));
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
