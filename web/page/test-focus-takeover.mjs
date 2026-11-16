// ci: web-runner order=486 chrome
// Focus takeover (web/page/handover.ts, web/journal/store.js's yieldLock, enqueue and passOn): a notebook open in
// several tabs of one browser, saved through sync's journal (its fence switched to the journal for this test).  The tab
// in use writes; the others follow, quietly, showing every change; no keystroke is lost on the way.  In headless
// Chromium, every tab given the focus (Emulation.setFocusEmulationEnabled), and every use a real one (CDP Input):
//  1. a second tab follows: read-only, nothing said about another tab; the first's typing shown in it;
//  2. the follower used (a click, then a key at once): it writes within moments, the first key and all after it kept
//     where they were typed, and the first follows; what the first typed up to then is kept too;
//  3. a page's own focus, or events a script makes (not a use), take nothing;
//  4. back: the first used again writes again;
//  5. a third tab, idle, queued first: the lock goes to the tab in use, not to it;
//  6. a hand-over asked during a save that is still running: the save completes first, then the hand-over;
//  7. a follower saves nothing while it follows;
//  8. the writer hidden and frozen (Page.setWebLifecycleState), the follower used meanwhile: nothing lost on either
//     side, nothing said, and the follower writes (here, a frozen page still takes the channel's message, so it hands
//     over while frozen: said as OBS);
//  8b. the writer unable to answer at all (paused in the debugger): the follower used meanwhile stays quiet, read-only,
//     what is typed kept; the writer going on hands over, nothing lost on either side;
//  9. a reload: no "another tab" text at any moment, and the reloaded page writes;
// 10. a phone: the toolbar stays while a read-only cell, or a field the page focused itself, has the focus; it steps
//     aside only while the keyboard is up (the visible viewport shrunk).
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/page/test-focus-takeover.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const profile = mkdtempSync(join(tmpdir(), "sb-takeover-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,860", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const port = await devtoolsPort(profile);
const fails = [];
let checks = 0;
const check = (ok, what, detail) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what + (ok || detail === undefined ? "" : " " + J(detail).slice(0, 500))); if (!ok) fails.push(what); return ok; };

// (the browser's own socket: its windows)
const bws = new WebSocket((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
await new Promise((r) => (bws.onopen = r));
let bn = 0;
const bwait = new Map();
bws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && bwait.has(m.id)) { bwait.get(m.id)(m.result ?? m.error); bwait.delete(m.id); } };
const bsend = (method, params = {}) => new Promise((r) => { const id = ++bn; bwait.set(id, r); bws.send(J({ id, method, params })); });
/** A tab: its own DevTools socket, evaluate, real input, and its exceptions. */
async function tab(url) {
  let t;
  // (in the browser's one window, so only the tab in front is visible, as in a person's browser)
  const made = await bsend("Target.createTarget", { url });
  for (let i = 0; i < 100 && !t; i++) { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.id === made.targetId); if (!t) await sleep(50); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map(), errors = [], logs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? J(m.params.exceptionDetails));
    if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "warning" || m.params.type === "error")) logs.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(J({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails) throw new Error(J(r.exceptionDetails).slice(0, 300)); return r?.result?.value; };
  const until = async (expr, ms = 15000) => { const s = Date.now(); while (Date.now() - s < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const key = async (k) => {
    const text = k.length === 1 ? k : k === "Enter" ? "\r" : undefined;
    const code = k.length === 1 ? (/[a-z]/i.test(k) ? "Key" + k.toUpperCase() : /\d/.test(k) ? "Digit" + k : "") : k;
    const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : { Enter: 13, Backspace: 8, ArrowLeft: 37, ArrowRight: 39 }[k] ?? 0;
    await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, text, windowsVirtualKeyCode: vk });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
  };
  const type = async (s) => { for (const c of s) await key(c); };
  // (a click on the first cell's editor, at its end: the tab brought to the front first, as a person's would be; the
  // window's other tabs are hidden then)
  const clickCell = async () => {
    await send("Page.bringToFront");
    const r = await ev(`(() => { const t = document.querySelector("#cells .cell textarea"); t.scrollIntoView({ block: "center" }); const b = t.getBoundingClientRect(); return { x: b.left + b.width - 6, y: b.top + b.height / 2 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  };
  return { t, ws, send, ev, until, key, type, clickCell, errors, logs, close: async () => { try { ws.close(); } catch {} await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); } };
}
const S = "window.sagebrush?.notebook", N = "window.sagebrush.notebook";
// (every key kept: `now` is `was` with `added` typed in somewhere, each character once: where it lands depends on
// where the caret was in what the tab showed, which may not have had the other tab's last keys yet)
const keptAll = (now, was, added) => typeof now === "string" && now.length === was.length + added.length && [...now].sort().join("") === [...was + added].sort().join("");
const st = (x) => x.ev(`(() => { const s = ${S}?.store; return s ? { journaled: !!s.journaled, writer: !!s.writer, ready: !!s.ready, readOnly: s.readOnly ?? null, code: ${S}.snapshot().cells[0]?.code ?? null } : null; })()`);
const writes = (x) => `!!(${S}?.store?.journaled && ${S}.store.writer && ${S}.store.ready && !document.querySelector("#cells .cell textarea").readOnly)`;
const follows = `!!(${S}?.store?.journaled && ${S}.store.readOnly === "other" && document.querySelector("#cells .cell textarea")?.readOnly)`;
const code = (x) => x.ev(`${S}.snapshot().cells[0].code`);
// (nothing on the page says another tab has it: the bar hidden, no "open for editing" anywhere)
const quiet = (x) => x.ev(`(() => { const b = document.querySelector("#writerbar"); return (!b || b.hidden || !b.textContent) && !/open for editing in another tab|other tab let go/i.test(document.body.innerText); })()`);

const tabs = [];
try {
  // ---- a notebook, saved through the journal
  const A = await tab(base);
  tabs.push(A);
  check(await A.until(`!!window.sagebrush?.workspace`, 60000), "the notebook page, its workspace open");
  const FENCE = "__sagebrush-workspace__";
  const fence = await A.ev(`new Promise((ok, no) => { const r = indexedDB.open("sagebrush"); r.onerror = () => no(String(r.error)); r.onsuccess = () => { const db = r.result; const tx = db.transaction("notebooks", "readwrite"), s = tx.objectStore("notebooks"); const g = s.get(${J(FENCE)}); g.onsuccess = () => { if (g.result) s.put({ ...g.result, phase: "journal", journal: 1 }); }; tx.oncomplete = () => { db.close(); ok(!!g.result); }; }; })`);
  check(fence, "the notebooks' fence, switched to the journal");
  const ref = await A.ev(`window.sagebrush.workspace.create("/Handover.ipynb", { content: { name: "Handover", mode: "python", cells: [{ id: "c1", code: "start" }] } }).then((e) => e.ref)`);
  const url = base + "?nb=" + encodeURIComponent(ref);
  await A.send("Page.navigate", { url });
  check(await A.until(writes(A), 30000), "A opens it and writes it", await st(A).catch(() => null));

  // ---- 1. B follows, quietly, and shows A's typing
  const B = await tab(url);
  tabs.push(B);
  check(await B.until(follows, 30000), "1. B, opened second, follows (read-only)", await st(B).catch(() => null));
  check(await quiet(B), "1. …and says nothing about another tab");
  await A.clickCell();
  await A.type("x");
  check(await B.until(`${S}.snapshot().cells[0].code === "startx"`, 8000), "1. A's typing shown in B", await code(B));

  // ---- 2. B used: a click, then a key at once; A's typing up to then kept
  await A.type("yz");
  let doc = "startxyz";
  const t0 = Date.now();
  await B.clickCell();
  await B.key("Q");
  const took = await B.until(writes(B), 5000), ms = Date.now() - t0;
  check(took && ms < 2000, `2. B, used, writes (in ${ms} ms)`, await st(B));
  // (B's caret was put at the end of what B showed then: "startx", A's last keys not yet saved; Q lands there)
  check(await B.until(`${S}.snapshot().cells[0].code === "startxQyz"`, 5000), "2. …the first key typed at once is kept, where it was typed (after the x B showed), and A's typing after it", await code(B));
  doc = "startxQyz";
  check(await A.until(follows, 5000), "2. A follows", await st(A));
  await B.type("rs");
  doc = "startxQrsyz";
  check(await A.until(`${S}.snapshot().cells[0].code === ${J(doc)}`, 8000) && await quiet(A) && await quiet(B), "2. B's typing shown in A; neither says anything about another tab", { a: await code(A), b: await code(B) });

  // ---- 3. a page's own focus takes nothing
  await A.ev(`(document.querySelector("#cells .cell textarea").focus(), 1)`);
  await sleep(600);
  check(await A.ev(follows) && await B.ev(writes(B)), "3. A's page focusing its cell itself: still B writes");
  // (events a script makes, not a person: not a use)
  await A.ev(`(() => { const t = document.querySelector("#cells .cell textarea"); t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); t.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true, cancelable: true })); return 1; })()`);
  await sleep(600);
  check(await A.ev(follows) && await B.ev(writes(B)), "3. …nor events a script made there (not a person's): still B writes");

  // ---- 4. back to A
  await A.clickCell();
  await A.type("!");
  check(await A.until(writes(A), 5000) && await A.until(`${S}.snapshot().cells[0].code === ${J(doc + "!")}`, 5000) && await B.until(follows, 5000), "4. A used again: A writes, its key kept; B follows", { a: await st(A), b: await st(B) });
  doc += "!";

  // ---- 5. a third tab, idle and first in the lock's queue: the lock goes to the tab in use
  const C = await tab(url);
  tabs.push(C);
  check(await C.until(follows, 30000), "5. C opened third, follows");
  // (C first in the lock's queue: B reloaded, so its request is made again behind C's; then B used: A hands over, C is
  // granted first and passes it on to B)
  await B.send("Page.reload", {});
  await sleep(500);
  await B.until(follows, 30000);
  const queue = await A.ev(`navigator.locks.query().then((q) => q.pending.length)`);
  // (C's takeovers counted: passing the lock on runs none, no reload in the idle tab)
  await C.ev(`(() => { const s = ${N}.store, f = s.ontakeover; window.__took = 0; s.ontakeover = () => { window.__took++; return f?.(); }; return 1; })()`);
  await B.clickCell();
  await B.key("b");
  const tookB5 = await B.until(writes(B), 5000);
  await sleep(500);
  const tookC = await C.ev(`window.__took`);
  check(queue === 2 && tookB5 && tookC === 0 && await C.ev(follows) && await A.until(follows, 5000), "5. C first in the queue, B second; B, used, writes; C, idle, passed it on without taking over, and still follows", { queue, tookC, a: await st(A), b: await st(B), c: await st(C) });
  await sleep(300);
  check(keptAll(await code(B), doc, "b"), "5. …B's key kept", await code(B));
  doc = await code(B);
  await C.close();
  tabs.pop();

  // ---- 6. a hand-over asked while a save is running: the save first
  await B.ev(`(() => { window.__hold = new Promise((r) => { window.__release = r; }); ${N}.store.t2Hold = window.__hold; return 1; })()`);
  await B.type("6");
  await B.ev(`(${N}.flush(), 1)`);
  await sleep(150);
  await A.clickCell();
  await A.key("a");
  await sleep(500);
  const heldB = await st(B);
  await B.ev(`(window.__release(), ${N}.store.t2Hold = undefined, 1)`);
  const tookA = await A.until(writes(A), 5000);
  await sleep(300);
  const after6 = await code(A);
  check(heldB.writer && tookA && keptAll(after6, doc, "6a"), "6. a want during B's running save: B kept the lock until it was done; then A writes, B's 6 and A's a both kept", { heldB, a: after6 });
  doc = after6;

  // ---- 7. a follower saves nothing
  await B.ev(`(() => { window.__saves = 0; const s = ${S}.store, f = s.save.bind(s); s.save = (...a) => { window.__saves++; return f(...a); }; return 1; })()`);
  await A.type("77");
  doc = await code(A);
  await B.until(`${S}.snapshot().cells[0].code === ${J(doc)}`, 8000);
  await sleep(1200);
  check((await B.ev(`window.__saves`)) === 0, "7. B, following, shows A's typing and saves nothing", await B.ev(`window.__saves`));

  // ---- 8a. the writer hidden (another tab of its window in front), alive: it answers a want as any writer does
  // (its focus emulation off meanwhile: an emulated focus keeps a tab shown)
  await A.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await B.send("Page.bringToFront");
  const hidden = await A.until(`document.visibilityState === "hidden"`, 5000);
  await B.clickCell();
  await B.key("h");
  const tookB = await B.until(writes(B), 5000);
  await sleep(300);
  check(hidden && tookB && keptAll(await code(B), doc, "h"), "8a. A hidden (minimized), alive: B, used, writes, its key kept", { hidden, b: await st(B) });
  doc = await code(B);
  await A.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await A.clickCell();
  await A.key("k");
  const tookA2 = await A.until(writes(A), 5000);
  await sleep(300);
  check(tookA2 && keptAll(await code(A), doc, "k"), "8a. …and A, shown and used again, writes, its key kept", await code(A));
  doc = await code(A);

  // ---- 8. the writer frozen: the follower used meanwhile keeps what is typed; the writer resumed hands over
  await A.type("8");
  await A.ev(`${N}.saved().then(() => 1)`);
  doc = await code(A);
  // (A hidden first: only a hidden page can be frozen)
  await A.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await B.send("Page.bringToFront");
  const hid = await A.until(`document.visibilityState === "hidden"`, 5000);
  const froze = await A.send("Page.setWebLifecycleState", { state: "frozen" });
  await B.clickCell();
  await B.type("fz");
  await sleep(800);
  const frozenB = await st(B), quietB = await quiet(B);
  await A.send("Page.setWebLifecycleState", { state: "active" });
  await A.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  console.log(`OBS  8. B writing while A was frozen: ${frozenB.writer} (a frozen page here still takes the channel's message)`);
  const tookB2 = await B.until(writes(B), 8000);
  await sleep(300);
  check(hid && !froze?.code && quietB && tookB2 && keptAll(await code(B), doc, "fz"), "8. A hidden and frozen, B used: nothing said; B writes; A's typing before the freeze and B's during it both kept", { hid, froze, frozenB, b: await code(B) });
  doc = await code(B);

  // ---- 8b. the writer unable to answer at all (paused in the debugger)
  await A.clickCell();
  await A.key("p");
  await A.until(writes(A), 5000);
  await A.ev(`${N}.saved().then(() => 1)`);
  doc = await code(A);
  await A.send("Debugger.enable");
  await A.send("Debugger.pause");
  await B.clickCell();
  await B.type("dq");
  await sleep(1000);
  const pausedB = await st(B), quietP = await quiet(B), roP = await B.ev(`document.querySelector("#cells .cell textarea").readOnly`);
  await A.send("Debugger.resume");
  await A.send("Debugger.disable");
  check(!pausedB.writer && pausedB.readOnly === "other" && roP && quietP && pausedB.code === doc, "8b. A unable to answer (paused): B, used, still follows, read-only, nothing said, nothing typed shown yet", pausedB);
  const tookB3 = await B.until(writes(B), 8000);
  await sleep(300);
  check(tookB3 && keptAll(await code(B), doc, "dq"), "8b. A going on: B writes; A's typing before and B's during the pause both kept", await code(B));

  // ---- 9. a reload: nothing said at any moment; the reloaded page writes
  await B.send("Page.reload", {});
  let said = false;
  const r0 = Date.now();
  while (Date.now() - r0 < 4000) {
    const w = await B.ev(`(() => { const re = /open for editing in another tab|other tab let go/i; if (!re.test(document.body?.innerText ?? "")) return null; const el = [...document.querySelectorAll("body *")].reverse().find((e) => re.test(e.innerText ?? "")); return (el?.id || el?.className || el?.tagName) + ": " + (el?.innerText ?? "").slice(0, 160); })()`).catch(() => null);
    if (w) said = w;
    await sleep(25);
  }
  await B.clickCell().catch(() => {});
  const wrote9 = await B.until(writes(B), 15000);
  check(!said && wrote9, "9. B reloaded: never says another tab has it, and writes", { said, b: await st(B).catch(() => null), bar: await B.ev(`document.querySelector("#writerbar")?.textContent`).catch(() => null), logs: B.logs.slice(-6), a: await st(A).catch(() => null), alogs: A.logs.slice(-4) });

  // ---- 10. a phone: the toolbar steps aside only while the keyboard is up
  const P = await tab("about:blank");
  tabs.push(P);
  await P.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await P.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await P.send("Network.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36" });
  // (the visible viewport, the test's: its height set by the test, as a keyboard's coming up shrinks it)
  await P.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const vv = new EventTarget(); let h = innerHeight; Object.defineProperties(vv, { height: { get: () => h }, width: { get: () => innerWidth }, scale: { get: () => 1 }, offsetTop: { get: () => 0 }, offsetLeft: { get: () => 0 } }); vv.__set = (x) => { h = x; vv.dispatchEvent(new Event("resize")); }; Object.defineProperty(window, "visualViewport", { get: () => vv }); })();` });
  await P.send("Page.navigate", { url: base });
  check(await P.until(`document.documentElement.classList.contains("phone") && !!document.querySelector("#cells .cell textarea")`, 30000), "10. a phone: the notebook page in the phone layout");
  const bar = `getComputedStyle(document.querySelector(".bar[role=toolbar]")).display !== "none"`;
  await P.ev(`(() => { const t = document.querySelector("#cells .cell textarea"); t.readOnly = true; t.focus(); return 1; })()`);
  await sleep(100);
  const roBar = await P.ev(bar);
  await P.ev(`(() => { const t = document.querySelector("#cells .cell textarea"); t.blur(); t.readOnly = false; t.focus(); return 1; })()`);
  await sleep(100);
  const focusBar = await P.ev(bar);
  await P.ev(`(visualViewport.__set(innerHeight - 300), 1)`);
  await sleep(100);
  const kbBar = await P.ev(bar);
  await P.ev(`(visualViewport.__set(innerHeight), 1)`);
  await sleep(100);
  const downBar = await P.ev(bar);
  check(roBar && focusBar && !kbBar && downBar, "10. the toolbar: kept for a read-only cell and a field with no keyboard up; aside while the keyboard is up; back when it goes", { roBar, focusBar, kbBar, downBar });

  const errs = tabs.flatMap((x) => x.errors);
  check(errs.length === 0, "no uncaught exceptions", errs.slice(0, 3));
} catch (e) {
  check(false, "the test ran: " + (e?.stack ?? e));
} finally {
  for (const x of tabs) await x.close();
  try { bws.close(); } catch {}
  const exited = new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once("exit", r)));
  chrome.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: focus takeover, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
