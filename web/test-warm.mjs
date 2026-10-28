// X1 (design r3) on the full page in headless Chromium: the language's
// environment loads at the user's own actions (pointing at a code cell,
// typing in it, moving onto it with the keyboard, choosing the language in
// the menu), once per language and interpreter, and never from opening, a
// programmatic setMode, or a real element.focus() (which makes trusted focus
// events); Tab before any run completes in Sage; the trigger path's main-
// thread work stays under the 50 ms long-task rule.  Serve web/dist first:
//   bun web/build.ts && bash web/run-tests.sh warm
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-warm-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1000,700", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
const ready = "window.sagebrush && document.querySelectorAll('#cells .cell').length > 0 && sagebrush.kernel?.ready";
// (the warm-ups this kernel sent: its ask() wrapped, so the kernel's own warm() is what is counted)
const COUNT = `(() => { const k = sagebrush.kernel; if (!k.__warms) { k.__warms = []; const ask = k.ask.bind(k); k.ask = (msg, mode, ...a) => { if (msg.warm) k.__warms.push(mode); return ask(msg, mode, ...a); }; } return k.__warms.length; })()`;
const warms = () => ev(COUNT);
// (long tasks on the page's main thread, from now)
const LONG = `(() => { window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: false }); return true; })()`;
const rect = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const click = async ([x, y]) => {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
};
const key = async (k, code = k, vk = 0) => {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
};
const fileNew = async () => {
  const k = await ev("sagebrush.kernel.uid");
  await ev(`document.querySelector('#filebtn').click(); document.querySelector('[data-f="new"]').click(); true`);
  await until(`sagebrush.kernel.uid !== ${k} && sagebrush.kernel.ready`, 15000);
  await sleep(300);
};
const toSage = () => ev("sagebrush.notebook.setMode('sage'); true"); // (programmatic, as an agent or a document would)

try {
  await send("Page.navigate", { url: base });
  await until(ready);
  await fileNew();
  await warms();

  // 1. opening, a programmatic setMode, and a real element.focus(): no warm-up
  await toSage();
  await ev("sagebrush.notebook.cells()[0].ta.focus(); true");
  await sleep(300);
  await ev("document.activeElement.blur(); sagebrush.notebook.cells()[0].el.focus(); true");
  await sleep(300);
  ok((await warms()) === 0, `opening, setMode('sage') and element.focus() on a code cell send no warm-up (${await warms()})`);

  // 2. a real click on the code cell: one warm-up, in Sage; more clicks and keys: still one
  await ev(LONG);
  const t0 = await ev("performance.now()");
  await click(await rect("#cells .cell .ed textarea"));
  await until("sagebrush.kernel.__warms.length >= 1", 5000);
  ok(JSON.stringify(await ev("sagebrush.kernel.__warms")) === '["sage"]', `a real click on a code cell sends one Sage warm-up (${JSON.stringify(await ev("sagebrush.kernel.__warms"))})`);
  for (let i = 0; i < 5; i++) { await click(await rect("#cells .cell .ed textarea")); await key("a", "KeyA", 65); }
  ok((await warms()) === 1, `more clicks and keys while it is pending or done: still one (${await warms()})`);
  await sleep(200);
  const long = await ev(`window.__long.filter(([s]) => s >= ${t0} && s <= ${t0} + 1000)`);
  ok(long.every(([, d]) => d <= 50), `the trigger path: no long task over 50 ms on the main thread (${JSON.stringify(long)})`);
  await until("sagebrush.kernel.modeState.get('sage')?.state === 'ready'", 60000);
  ok(true, "the warm-up's answer made Sage ready");

  // 3. Tab before any run completes in Sage (the environment loaded by the warm-up, or by Tab itself)
  await fileNew(); await warms(); await toSage();
  await click(await rect("#cells .cell .ed textarea"));
  await ev("(() => { const ta = sagebrush.notebook.cells()[0].ta; ta.focus(); ta.value = ''; return true; })()");
  await send("Input.insertText", { text: "graphs.Pet" });
  await key("Tab", "Tab", 9);
  await until("sagebrush.notebook.cells()[0].ta.value.startsWith('graphs.Petersen')", 60000);
  ok(true, `Tab before any run completes in Sage: ${await ev("sagebrush.notebook.cells()[0].ta.value")}`);

  // 4. the keyboard: command mode, an arrow onto a code cell: one warm-up
  await fileNew(); await warms(); await toSage();
  await ev("sagebrush.notebook.addCell('', null, false); sagebrush.notebook.cells()[0].el.focus(); true");
  await key("ArrowDown", "ArrowDown", 40);
  await until("sagebrush.kernel.__warms.length >= 1", 5000);
  ok((await warms()) === 1, `moving onto a code cell with the keyboard sends one warm-up (${await warms()})`);

  // 5. the language menu, used with the keyboard (trusted): one warm-up for the chosen language
  await fileNew(); await warms();
  await ev("document.querySelector('#mode').focus(); true");
  const before = await warms();
  await key("ArrowDown", "ArrowDown", 40); // (python -> sage, the next option: a trusted change)
  await sleep(500);
  const chosen = await ev("sagebrush.notebook.mode");
  ok(chosen !== "python" && (await warms()) === before + 1 && (await ev("sagebrush.kernel.__warms.at(-1)")) === chosen, `choosing ${chosen} in the menu sends one warm-up for it (${await warms() - before})`);
} catch (e) {
  ok(false, String(e?.message ?? e).slice(0, 300));
} finally {
  ws.close();
  // (Chromium writes into its profile until it exits: wait for it, then remove it)
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await Promise.race([exited, sleep(5000)]);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
