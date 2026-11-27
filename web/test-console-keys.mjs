// ci: web-browser/notebook order=61
// The page's Console's copy and paste keys, on the full page in headless Chromium, as CoCalc's terminal has them
// (connected-terminal.ts initKeyHandler, and the remote terminal: test-remote-terminal-page.mjs 7c): Ctrl+C with
// nothing selected is a KeyboardInterrupt; with text selected it is the browser's copy (xterm leaves the key alone),
// and the line being typed is untouched; Ctrl+V is the browser's paste, never a ^V: the word just copied lands on the
// line, as does a paste event's text.  Serve web/dist first:
//   bun web/build.ts && bash web/run-tests.sh console-keys
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-console-keys-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1000,700", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
let checks = 0;
const ok = (c, msg) => { checks++; console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } return false; };
const ready = "window.sagebrush && document.querySelectorAll('#cells .cell').length > 0 && sagebrush.kernel?.ready";
const SCREEN = "[...document.querySelectorAll('#term .xterm-rows > div')].map((d) => d.textContent.replace(/\\s+$/, '')).join('\\n').replace(/\\n+$/, '')";
const screen = () => ev(SCREEN);
const LAST = `${SCREEN}.split('\\n').pop()`;
const TEXTAREA = "document.querySelector('#term textarea')";
const waitPrompt = (p) => until(`${LAST} === ${JSON.stringify(p)}`, 60000);
const type = async (text) => {
  await ev(`${TEXTAREA}.focus(), 1`);
  if (text) await send("Input.insertText", { text });
  if (text && !(await until(`${LAST}.endsWith(${JSON.stringify(text)})`, 10000))) throw new Error(`${JSON.stringify(text)} wasn't shown: ${JSON.stringify(await ev(LAST))}`);
  const line = await ev(LAST);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await until(`${LAST} !== ${JSON.stringify(line)}`, 10000);
};
// (Ctrl+<k>, as a person presses it; the page records the keydown on the window, after xterm's own listener: a key xterm
// takes is cancelled there and stopped (null here), and one it leaves to the browser arrives not prevented)
const ctrl = async (k, code, vk) => {
  await ev("window.__lastKey = null, 1");
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: 2 });
  await sleep(300);
  return ev("window.__lastKey");
};

try {
  await send("Page.navigate", { url: base });
  ok(await until(ready, 60000), "the page is up");
  await ev("document.querySelector('#consolebtn').click(); true");
  ok(await until("/console ready/.test(document.querySelector('#status').textContent)", 60000), "the Console is ready");
  ok(await waitPrompt(">>>"), "its prompt");
  await ev("addEventListener('keydown', (e) => { window.__lastKey = { key: e.key, ctrl: e.ctrlKey, prevented: e.defaultPrevented }; }), 1");

  // Ctrl+C with nothing selected: a KeyboardInterrupt, the line dropped
  await ev(`${TEXTAREA}.focus(), 1`);
  await send("Input.insertText", { text: "abc" });
  await until(`${LAST} === ">>> abc"`, 10000);
  let k = await ctrl("c", "KeyC", 67);
  ok(k === null, `Ctrl+C with nothing selected: xterm takes it (${JSON.stringify(k)})`);
  ok(await until(`${SCREEN}.split('\\n').slice(-2).join('|') === "KeyboardInterrupt|>>>"`, 10000), `...a KeyboardInterrupt and a fresh prompt (${JSON.stringify(await ev(`${SCREEN}.split('\\n').slice(-3)`))})`);

  // text on the screen, selected with a double-click
  await type("print('SELECTME and more')");
  ok(await waitPrompt(">>>"), "printed");
  // (the line being typed first: typing clears a selection)
  await ev(`${TEXTAREA}.focus(), 1`);
  await send("Input.insertText", { text: "xyz" });
  await until(`${LAST} === ">>> xyz"`, 10000);
  const r = await ev(`(() => {
    const it = document.createTreeWalker(document.querySelector('#term .xterm-rows'), NodeFilter.SHOW_TEXT);
    for (let t; (t = it.nextNode());) {
      const i = t.data.indexOf("SELECTME");
      if (i < 0 || t.data.includes("print(")) continue;
      const range = document.createRange(); range.setStart(t, i + 2); range.setEnd(t, i + 3);
      const b = range.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  })()`);
  ok(r !== null, "the printed line is on the screen");
  for (const c of [1, 2]) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: c });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: c });
  }
  await sleep(200);
  ok(await ev("document.querySelectorAll('#term .xterm-selection div').length > 0"), "a double-click selects a word");
  const before = await screen();

  // Ctrl+C with text selected: the browser's copy; no KeyboardInterrupt, the line kept
  k = await ctrl("c", "KeyC", 67);
  ok(k?.key === "c" && k.ctrl && k.prevented === false, `Ctrl+C with text selected: left to the browser, its copy (${JSON.stringify(k)})`);
  ok((await screen()) === before && (await ev(LAST)) === ">>> xyz", "...no KeyboardInterrupt, and the line being typed is kept");

  // Ctrl+V: the browser's paste, never a ^V; a paste's text goes on the line
  k = await ctrl("v", "KeyV", 86);
  ok(k?.key === "v" && k.ctrl && k.prevented === false, `Ctrl+V: left to the browser, its paste (${JSON.stringify(k)})`);
  ok(await until(`${LAST} === ">>> xyzSELECTME"`, 10000), `...the word Ctrl+C copied is pasted on the line, and no ^V (${JSON.stringify(await ev(LAST))})`);
  await ev(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', ' + 1'); ${TEXTAREA}.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()`);
  ok(await until(`${LAST} === ">>> xyzSELECTME + 1"`, 10000), `the paste's text is on the line (${JSON.stringify(await ev(LAST))})`);
} catch (e) {
  ok(false, String(e?.stack ?? e));
} finally {
  console.log(process.exitCode ? `FAIL: the Console's copy and paste keys` : `ok: the Console's copy and paste keys, ${checks} checks`);
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
