// Open from IndexedDB first (cached.ts cachedStore), with a fake remote that
// answers after a delay: a document opened the first time waits for the
// remote; opened again, its copy is drawn at once and the remote asked for
// its hash only (the same: nothing more); a document changed elsewhere
// meanwhile replaces the copy once the remote answers; offline, the copy is
// shown and edits are kept in it, then saved to the remote when it is back;
// an edit made before the remote answered is merged with the remote's
// change (the same field: ours, and the caption says so); edits go to the
// copy and the remote; a change made elsewhere later is shown; a load made
// while the store's first is still open wins.  First paint with and without
// the copy is measured (printed).  Serve web/dist first (python3
// web/serve.py 8765), then
//   node web/board/test-cached.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = Number(process.env.CDP_PORT ?? 9473), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-cached-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1200,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
const until = async (expr, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(30); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

const D = 1500; // the remote's delay, ms
const doc = (title, extra = {}) => ({ title: "Cached", nodes: [{ id: "n1", title, text: "base text", x: 0, y: 0, w: 300 }], ...extra });
const big = (k) => ({ title: "Big", nodes: Array.from({ length: k }, (_, i) => ({ id: "b" + i, title: "Note " + i, text: "Some text for note " + i, x: (i % 40) * 320, y: Math.floor(i / 40) * 200, w: 300 })) });

// in the page: the board module, a fake remote, and a board opened with it
const SETUP = `(async () => {
  const m = await import(new URL("board.js", location.href).href);
  await m.mounted.destroy();
  window.__m = m;
  window.fake = (d, delay) => {
    const r = { doc: d && JSON.parse(JSON.stringify(d)), delay, offline: false, calls: [], fs: new Set(), cas: true };
    r.wait = () => new Promise((ok, no) => setTimeout(() => (r.offline ? no(new Error("offline")) : ok()), r.delay));
    r.hash = async () => { r.calls.push("hash"); await r.wait(); return r.doc ? m.docHash(r.doc) : null; };
    r.load = async () => { r.calls.push("load"); await r.wait(); return r.doc && JSON.parse(JSON.stringify(r.doc)); };
    // (compare-and-swap: only over the document whose hash it is given, null: none, as it is when the save is done)
    r.save = async (x, expected) => { r.calls.push("save"); await r.wait(); if ((r.doc ? await m.docHash(r.doc) : null) !== expected) return false; r.doc = JSON.parse(JSON.stringify(x)); return true; };
    r.subscribe = (f) => { r.fs.add(f); return () => r.fs.delete(f); };
    r.change = (x) => { r.doc = JSON.parse(JSON.stringify(x)); for (const f of r.fs) f(JSON.parse(JSON.stringify(x))); };
    return r;
  };
  window.cache = new m.IdbDocCache("test-board-docs");
  // open: the board in a fresh element; resolves at its first paint, with what it showed then
  window.openWith = async (key, r, before) => {
    if (window.cur) { await window.cur.b.destroy(); window.cur.el.remove(); }
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;inset:0";
    document.body.append(el);
    const store = m.cachedStore(r, key, window.cache);
    const t0 = performance.now();
    const b = m.mountBoard(el, { images: m.host.images, store });
    before?.(b);
    // (laid out, and the frame after: drawn, as elements or, far out, on the canvas)
    await new Promise((ok) => { const tick = () => (b.agent.snapshot().items?.length ? requestAnimationFrame(() => ok()) : requestAnimationFrame(tick)); tick(); });
    const paint = performance.now() - t0;
    window.cur = { b, el, store, r };
    return { paint, title: b.agent.snapshot().doc?.nodes?.[0]?.title ?? null, calls: [...r.calls] };
  };
  return 1;
})()`;
const title = () => ev("window.cur.b.agent.snapshot().doc.nodes[0].title");
const synced = () => ev("window.cur.store.synced");
const entry = (key) => ev(`window.cache.get(${JSON.stringify(key)}).then((c) => c && { ...c, doc: JSON.parse(c.json) })`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/?runner=0` });
  if (!(await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000))) throw new Error("the page's board was not shown");
  await ev(SETUP);
  await ev(`window.R = fake(${JSON.stringify(doc("One"))}, ${D}), 1`);

  // the first time: no copy, the remote's (after its delay); then a copy
  const first = await ev(`openWith("k1", window.R)`);
  check(first.paint >= D && first.title === "One" && (await synced()) === "fresh", "no copy: the remote's, once it answers: " + JSON.stringify(first));
  check((await entry("k1"))?.doc.nodes[0].title === "One", "...and a copy kept");
  // again: the copy at once; the remote asked for its hash only
  const again = await ev(`(window.R.calls = [], openWith("k1", window.R))`);
  check(again.paint < D / 3 && again.title === "One", "opened again: the copy, drawn before the remote answers: " + JSON.stringify(again));
  check((await synced()) === "same" && (await ev("window.R.calls.join()")) === "hash", "...the same hash: only the hash asked, nothing more: " + await ev("window.R.calls.join()"));

  // changed elsewhere meanwhile: the copy first, then the remote's
  await ev(`window.R.doc.nodes[0].title = "One, changed elsewhere", 1`);
  const stale = await ev(`(window.R.calls = [], openWith("k1", window.R))`);
  check(stale.paint < D / 3 && stale.title === "One", "changed elsewhere: the copy is drawn first: " + JSON.stringify(stale));
  check((await synced()) === "replaced" && (await title()) === "One, changed elsewhere", "...then the remote's replaces it: " + await title());
  await sleep(100);
  check((await entry("k1"))?.doc.nodes[0].title === "One, changed elsewhere" && (await entry("k1")).hash === (await entry("k1")).remoteHash, "...and the copy is the remote's now");

  // edits go to both: the copy at once, the remote once it answers
  await ev(`window.cur.b.agent.edit((d) => { d.nodes[0].title = "Edited"; }).then(() => 1)`);
  await sleep(100);
  const atOnce = await entry("k1");
  check(atOnce.doc.nodes[0].title === "Edited", "an edit: in the copy at once");
  check(await until("window.R.doc.nodes[0].title === 'Edited'", D * 3), "...and in the remote");
  await sleep(200);
  check((await entry("k1")).hash === (await entry("k1")).remoteHash, "...the copy based on the remote's version again");

  // a change made elsewhere later: shown
  await ev(`window.R.change({ ...window.R.doc, nodes: [{ ...window.R.doc.nodes[0], title: "Live from elsewhere" }] }), 1`);
  check(await until("window.cur.b.agent.snapshot().doc.nodes[0].title === 'Live from elsewhere'", D * 3), "a change made elsewhere later is shown: " + await title());

  // offline: the copy, edits kept in it; back online, saved to the remote
  await ev(`(window.R.offline = true, window.R.calls = [], 1)`);
  const off = await ev(`openWith("k1", window.R)`);
  check(off.paint < D / 3 && off.title === "Live from elsewhere" && (await synced()) === "offline", "offline: the copy is shown: " + JSON.stringify(off));
  await ev(`window.cur.b.agent.edit((d) => { d.nodes[0].title = "Written offline"; }).then(() => 1)`);
  await sleep(300);
  const offEntry = await entry("k1");
  check(offEntry.doc.nodes[0].title === "Written offline" && offEntry.hash !== offEntry.remoteHash && !(await ev("window.R.calls.includes('save')")), "...an edit is kept in the copy (not yet the remote's)");
  await ev(`(window.R.offline = false, window.R.calls = [], 1)`);
  await ev(`openWith("k1", window.R)`);
  check((await synced()) === "pushed" && (await until("window.R.doc.nodes[0].title === 'Written offline'", D * 3)), "back online: the edit made offline goes to the remote: " + await synced());

  // an edit before the remote answers, and a change there meanwhile: merged
  await ev(`(window.R.doc.nodes[0].text = "their text", window.R.doc.nodes.push({ id: "n2", title: "Theirs", x: 400, y: 0 }), 1)`);
  await ev(`openWith("k1", window.R, (b) => setTimeout(() => b.agent.edit((d) => { d.nodes[0].title = "My title"; }), 200))`);
  check((await synced()) === "merged", "an edit before the remote answered, a change there: merged: " + await synced());
  await sleep(200);
  const merged = await ev("window.cur.b.agent.snapshot().doc");
  check(merged.nodes[0].title === "My title" && merged.nodes[0].text === "their text" && merged.nodes.some((x) => x.id === "n2"), "...both kept: " + JSON.stringify(merged.nodes));
  check(await until("window.R.doc.nodes[0].title === 'My title' && window.R.doc.nodes.some((x) => x.id === 'n2')", D * 3), "...and the merge is the remote's");
  await sleep(D * 1.5);
  check(await ev("window.R.doc.nodes[0].title === 'My title' && window.R.doc.nodes[0].text === 'their text' && window.R.doc.nodes.some((x) => x.id === 'n2')"), "...and stays so: the edit made before the remote answered is not sent again over it: " + await ev("JSON.stringify(window.R.doc.nodes)"));
  // (an undo after the merge cannot write the copy from before it back: the undo steps before it are forgotten)
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1100, y: 820, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1100, y: 820, button: "left", buttons: 0, clickCount: 1 });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 2 });
  await sleep(300);
  check(await ev("(() => { const d = window.cur.b.agent.snapshot().doc; return d.nodes.some((x) => x.id === 'n2') && d.nodes[0].text === 'their text'; })()"), "an undo after a merge does not put the copy from before it back: " + JSON.stringify((await ev("window.cur.b.agent.snapshot().doc")).nodes));
  check(await ev("document.querySelector('[data-sbb=tour]').hidden || !/changed elsewhere/.test(document.querySelector('[data-sbb=say]').textContent)"), "...no conflict: nothing said");
  // the same field: ours, and the caption says so
  await sleep(300);
  await ev(`(window.R.doc.nodes[0].title = "Their title", 1)`);
  await ev(`openWith("k1", window.R, (b) => setTimeout(() => b.agent.edit((d) => { d.nodes[0].title = "Our title"; }), 200))`);
  check((await synced()) === "merged" && (await title()) === "Our title", "the same field changed on both sides: ours: " + await title());
  check(await until("/changed elsewhere/.test(document.querySelector('[data-sbb=say]')?.textContent ?? '') && !document.querySelector('[data-sbb=tour]').hidden", 3000), "...and the caption says so: " + await ev("document.querySelector('[data-sbb=say]')?.textContent"));

  // a load made while the store's first is still open wins
  await ev(`window.R2 = fake(${JSON.stringify(doc("From the remote"))}, ${D}), 1`);
  await ev(`(async () => { if (window.cur) { await window.cur.b.destroy(); window.cur.el.remove(); window.cur = null; } const el = document.createElement("div"); el.style.cssText = "position:fixed;inset:0"; document.body.append(el); const store = __m.cachedStore(window.R2, "k2", window.cache); const b = __m.mountBoard(el, { images: __m.host.images, store }); window.cur = { b, el, store, r: window.R2 }; await b.agent.load(${JSON.stringify(doc("Loaded meanwhile"))}); return 1; })()`);
  await ev("window.cur.store.synced");
  await sleep(300);
  check((await title()) === "Loaded meanwhile", "a load made while the store's first is open wins: " + await title());

  // first paint, with and without the copy: a small board and a large one
  const times = {};
  for (const [name, d] of [["small", doc("Small")], ["1000 notes", big(1000)]]) {
    const key = "m-" + name;
    await ev(`window.RM = fake(${JSON.stringify(d)}, ${D}), 1`);
    const cold = await ev(`openWith(${JSON.stringify(key)}, window.RM)`);
    await ev("window.cur.store.synced");
    const warm = [];
    for (let i = 0; i < 3; i++) { warm.push((await ev(`openWith(${JSON.stringify(key)}, window.RM)`)).paint); await ev("window.cur.store.synced"); }
    times[name] = { withoutCopy: Math.round(cold.paint), withCopy: Math.round(Math.min(...warm)) };
  }
  console.log(`first paint, the remote answering after ${D} ms: ` + JSON.stringify(times));
  check(times["1000 notes"].withCopy < D / 2 && times.small.withCopy < D / 3, "with the copy, first paint does not wait for the remote: " + JSON.stringify(times));
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
