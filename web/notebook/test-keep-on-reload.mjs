// ci: web-runner order=506 chrome
// The notebook page (index.html, notebook.js) reloaded the moment after typing, before its save's half second: the
// page requests the browser's leave prompt (beforeunload); declined, the page stays and the edit is saved (there after a later
// reload); a save still running, or one refused as busy, asks too; typed and undone, nothing waiting, or the notebook
// destroyed, a reload asks nothing; the notebook's listener is there only while something is unsaved.  Typing is real input (CDP Input), as the browser
// asks only on a page the person has used.  In headless Chromium against the built site:
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/notebook/test-keep-on-reload.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const profile = mkdtempSync(join(tmpdir(), "sb-keep-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map(), errors = [], dialogs = [];
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(J({ id, method, params })); });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  // (the browser's leave prompt: recorded, and declined: the page stays)
  if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params.type); send("Page.handleJavaScriptDialog", { accept: false }); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? J(m.params.exceptionDetails));
};
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(J(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what, detail) => { checks++; if (!ok) fails.push(what + (detail === undefined ? "" : " " + J(detail).slice(0, 400))); };
const W = "window.sagebrush?.workspace";
const opened = (ref) => until(`!!window.sagebrush?.notebook && window.sagebrush.notebook.store?.id === ${J(ref)} && !!document.querySelector("#cells textarea") && !document.querySelector("#cells textarea[readonly]")`, 30000);
const codes = () => ev(`[...document.querySelectorAll("#cells textarea")].map((t) => t.value)`);
// (typed as a person types: the cell focused, its text selected, then real input (CDP Input.insertText); no wait)
const type = async (i, text) => { await ev(`(() => { const ta = document.querySelectorAll("#cells textarea")[${i}]; ta.focus(); ta.select(); return 1; })()`); await send("Input.insertText", { text }); };
// (a reload asked for: the leave prompts it brought, declined)
const reloadNow = async () => { const d0 = dialogs.length; await ev("(window.__old = 1, 1)"); await send("Page.reload"); await sleep(1500); return dialogs.slice(d0); };
// (the window's beforeunload listeners, each by where its handler is: script, line and column)
const unloadKeys = async () => {
  const w = await send("Runtime.evaluate", { expression: "window" });
  const r = await send("DOMDebugger.getEventListeners", { objectId: w.result.objectId });
  return (r.listeners ?? []).filter((l) => l.type === "beforeunload").map((l) => `${l.scriptId}:${l.lineNumber}:${l.columnNumber}`);
};
const unloadListeners = async () => {
  const w = await send("Runtime.evaluate", { expression: "window" });
  const r = await send("DOMDebugger.getEventListeners", { objectId: w.result.objectId });
  return (r.listeners ?? []).filter((l) => l.type === "beforeunload").length;
};
// (the notebook's own saves done (a load marks outputs stale and saves that): what follows starts from a clean notebook)
const settled = async () => { await ev("window.sagebrush.notebook.saved().then(() => 1)"); await sleep(300); };
const reloaded = () => until("!window.__old && document.readyState !== 'loading'", 30000);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: base });
  await until(`!!${W} && !!window.sagebrush?.notebook`, 60000);
  const ref = await ev(`${W}.create("/keep.ipynb", { content: { cells: [{ id: "a", code: "a0" }, { id: "b", code: "b0" }] } }).then((e) => e.ref)`);
  await send("Page.navigate", { url: base + "?nb=" + encodeURIComponent(ref) });
  check(await opened(ref), "the notebook opens, writable");

  // 1. typed, reloaded at once: the browser asks to confirm leaving; declined, the page stays, and the edit is saved
  await type(0, "a1 typed then reloaded");
  const asked = await reloadNow();
  check(J(asked) === J(["beforeunload"]), "1: a reload the moment after typing asks to confirm leaving", asked);
  check((await ev("window.__old === 1").catch(() => false)) === true, "1: declined, the page stays");
  check((await codes())[0] === "a1 typed then reloaded", "1: …with what was typed", await codes());
  await sleep(1500);
  const asked2 = await reloadNow();
  check(asked2.length === 0, "1: once saved, a reload asks nothing", asked2);
  check(await reloaded(), "1: the page reloads");
  check(await opened(ref), "1: the notebook opens again after the reload");
  check((await codes())[0] === "a1 typed then reloaded", "1: the edit was saved: there after the reload", await codes());
  check((await codes())[1] === "b0", "1: the other cell as it was", await codes());

  // 2. nothing typed since the last save: a reload asks nothing
  const asked3 = await reloadNow();
  check(asked3.length === 0, "2: nothing waiting: a reload asks nothing", asked3);
  check(await reloaded(), "2: the page reloads");
  check(await opened(ref), "2: the notebook opens");
  // 3. a save still running (held behind the workspace's lock, which another holder keeps): a reload asks too; declined,
  // the page stays, and once the lock is let go the edit is saved
  await ev(`(() => { navigator.locks.request("sagebrush-workspace", () => new Promise((r) => (window.__release = r))); return 1; })()`);
  await sleep(300);
  await type(1, "b1 saved while the lock was held");
  await sleep(1200);
  const asked4 = await reloadNow();
  check(J(asked4) === J(["beforeunload"]), "3: a save still running (its half second past) asks to confirm leaving", asked4);
  check((await ev("window.__old === 1").catch(() => false)) === true, "3: declined, the page stays");
  await ev("(window.__release(), 1)");
  await sleep(1500);
  const asked5 = await reloadNow();
  check(asked5.length === 0, "3: the lock let go and the save done, a reload asks nothing", asked5);
  check(await reloaded(), "3: the page reloads");
  check(await opened(ref), "3: the notebook opens");
  check((await codes())[1] === "b1 saved while the lock was held", "3: the edit was saved once the lock was let go", await codes());
  // 5. typed and undone before its save's half second: nothing differs from what was saved, so a reload asks nothing
  await settled();
  const was = (await codes())[0];
  await type(0, "zz typed and undone");
  await type(0, was);
  const asked7 = await reloadNow();
  check(asked7.length === 0, "5: typed and undone before the save: a reload asks nothing", asked7);
  check(await reloaded(), "5: the page reloads");
  check(await opened(ref), "5: the notebook opens");

  // 6. a save refused as busy (the workspace's lock held past its wait): settled, it still asks; a later save that
  // succeeds clears it
  await ev(`(() => { navigator.locks.request("sagebrush-workspace", () => new Promise((r) => (window.__release = r))); return 1; })()`);
  await sleep(300);
  await type(0, "a3 refused as busy");
  await sleep(12_000);
  const asked8 = await reloadNow();
  check(J(asked8) === J(["beforeunload"]), "6: a save refused as busy, settled, still asks", asked8);
  await ev("(window.__release(), 1)");
  await sleep(300);
  await type(0, "a3 refused as busy, then saved");
  await sleep(2000);
  const asked9 = await reloadNow();
  check(asked9.length === 0, "6: a later save that succeeds: a reload asks nothing", asked9);
  check(await reloaded(), "6: the page reloads");
  check(await opened(ref), "6: the notebook opens");
  check((await codes())[0] === "a3 refused as busy, then saved", "6: the later edit saved", await codes());

  // 7. other notebooks opened in turn on the page: still exactly one notebook listener (none added per notebook)
  await settled();
  const n0 = await unloadListeners();
  const ref2 = await ev(`${W}.create("/keep2.ipynb", { content: { cells: [{ id: "x", code: "x0" }] } }).then((e) => e.ref)`);
  for (const r of [ref2, ref, ref2, ref]) { await ev(`window.sagebrush.open(${J(r)}).then(() => 1)`); check(await opened(r), "7: opened " + r); }
  await settled();
  check((await unloadListeners()) === n0, "7: the listeners as many after opening notebooks in turn", { n0, n1: await unloadListeners() });

  // 9. typed, then another notebook opened at once, its save still running (held behind the workspace's lock): a
  // reload asks (the notebook left is the page's to ask about); declined, the page stays, and once the lock is let go
  // that edit is saved
  await settled();
  await ev(`(() => { navigator.locks.request("sagebrush-workspace", () => new Promise((r) => (window.__release = r))); return 1; })()`);
  await sleep(300);
  await type(0, "a6 typed, then another notebook opened");
  await sleep(1200);
  await ev(`(window.__opening = window.sagebrush.open(${J(ref2)}), 1)`);
  await sleep(300);
  const asked10 = await reloadNow();
  check(J(asked10) === J(["beforeunload"]), "9: another notebook opened with a save still running: a reload asks to confirm leaving", asked10);
  check((await ev("window.__old === 1").catch(() => false)) === true, "9: declined, the page stays");
  await ev("(window.__release(), window.__opening.then(() => 1))");
  check(await opened(ref2), "9: the other notebook opens");
  await settled();
  await ev(`window.sagebrush.open(${J(ref)}).then(() => 1)`);
  check(await opened(ref), "9: the first notebook opens again");
  check((await codes())[0] === "a6 typed, then another notebook opened", "9: the edit was saved once the lock was let go", await codes());

  // 8. the notebook's listener is there only while something is unsaved: none on a clean notebook (its page reloads
  // exactly as one without it), one once something is typed, none again once it is saved
  await settled();
  const clean = await unloadKeys();
  await type(0, "a4 typed: the listener comes");
  const typing = await unloadKeys();
  const mine = typing.filter((k) => !clean.includes(k));
  check(mine.length === 1, "8: typed, the notebook adds its beforeunload listener", { clean, typing });
  await sleep(1500);
  const saved = await unloadKeys();
  check(!saved.includes(mine[0]) && saved.length === clean.length, "8: saved, the listener is taken away again", { clean, saved });

  // 10. a save that failed with nothing typed (a script's change: an untrusted input event), then a key of the person's
  // own while another tab has the writer lock: the failed save alone asks nothing, and the key records that the person
  // worked but can't arm the prompt while this tab is read-only.  The moment it becomes writable, setReadOnly re-checks
  // the pending failed save and arms the prompt; once a later save succeeds, nothing is asked again.
  await settled();
  const clean10 = await unloadKeys();
  await ev("(window.__save = window.sagebrush.notebook.store.save, window.sagebrush.notebook.store.save = () => Promise.reject(new Error('refused for the test')), 1)");
  await ev(`(() => { const t = document.querySelectorAll("#cells textarea")[1]; t.value = "b9 a script's change"; t.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  check((await ev("window.sagebrush.notebook.saved().then(() => false, () => true)")) === true, "10: the script's change: its save fails");
  await sleep(300);
  check(J(await unloadKeys()) === J(clean10), "10: a failed save with nothing typed: the notebook adds no listener", { clean10, now: await unloadKeys() });
  await ev(`(window.sagebrush.notebook.store.readOnly = "other", window.sagebrush.notebook.setReadOnly(true), 1)`);
  await ev(`(document.querySelectorAll("#cells textarea")[1].focus(), 1)`);
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
  await sleep(100);
  const keyed = await unloadKeys();
  check(J(keyed) === J(clean10), "10: a key of the person's own while the failed notebook is read-only: no listener yet", { clean10, keyed });
  await ev(`(window.sagebrush.notebook.store.readOnly = null, window.sagebrush.notebook.setReadOnly(false), 1)`);
  const writable10 = await unloadKeys();
  check(writable10.length === clean10.length + 1, "10: when the failed notebook becomes writable: the listener at once", { clean10, writable10 });
  check((await ev("(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()")) === true, "10: ...and leaving is asked about");
  await ev("(window.sagebrush.notebook.store.save = window.__save, 1)");
  await type(1, "b10 saved again");
  await sleep(2000);
  check(J(await unloadKeys()) === J(clean10), "10: a later save that succeeds: the listener goes", { clean10, now: await unloadKeys() });

  // 4. the notebook destroyed with an edit unsaved (as a page tearing it down does): its listener goes with it, and a
  // reload then asks nothing
  await type(0, "a5 typed, then the notebook destroyed");
  check((await unloadKeys()).includes(mine[0]), "4: typed, the listener is there");
  await ev("(window.sagebrush.notebook.destroy(), 1)");
  check(!(await unloadKeys()).includes(mine[0]), "4: destroy takes the notebook's listener away", await unloadKeys());
  await sleep(1500);
  const asked6 = await reloadNow();
  check(asked6.length === 0, "4: destroyed, a reload asks nothing", asked6);
  check(await reloaded(), "4: the page reloads");
  check(errors.length === 0, "no page errors: " + errors.join(" | ").slice(0, 400));
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: a notebook reloaded the moment after typing asks to confirm leaving, and keeps the edit when declined, ${checks} checks`);
process.exit(0);
