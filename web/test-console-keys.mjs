// ci: web-browser/notebook order=61
// The page's Console's copy and paste keys, on the full page in headless Chromium, as CoCalc's terminal has them
// (connected-terminal.ts initKeyHandler, and the remote terminal: test-remote-terminal-page.mjs 7c): Ctrl+C with
// nothing selected is a KeyboardInterrupt; with text selected it is the browser's copy (xterm leaves the key alone),
// and the line being typed is untouched; Ctrl+V is the browser's paste, never a ^V: the word just copied lands on the
// line, as does a paste event's text; and with Caps Lock on ("V"), the same.  Serve web/dist first:
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
let checks = 0;
const ok = (c, msg) => { checks++; console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
// (every step bounded: Chrome's start, its targets, the connection and each request, which a closed or failed socket
//  also ends, so a reply that never comes fails the suite instead of leaving it pending past its cleanup)
const REQUEST_MS = 90000;
const within = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: no answer in ${ms} ms`)), ms); })]).finally(() => clearTimeout(t)); };
let chrome = null, ws = null, n = 0;
const waiting = new Map();
const fail = (e) => { for (const [, w] of waiting) w.reject(e); waiting.clear(); };
const send = (method, params = {}) => {
  if (!ws || ws.readyState !== 1) return Promise.reject(new Error(`${method}: the DevTools connection is closed`));
  const id = ++n;
  const p = new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  return within(p, REQUEST_MS, method).finally(() => waiting.delete(id));
};
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
  // (its process watched from the start: one that can't start (no such executable) fails here, through the cleanup)
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1000,700", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const said = await devtoolsPort(profile, 30000, { child: chrome });
  if (!port) port = said;
  let targets;
  for (let i = 0; i < 300 && !targets; i++) { try { targets = await within(fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()), 5000, "the targets"); } catch { await sleep(100); } }
  const page = targets?.find((t) => t.type === "page");
  if (!page) throw new Error("no page target from Chrome");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const w = m.id && waiting.get(m.id); if (w) { waiting.delete(m.id); w.resolve(m.result ?? m.error); } };
  await within(new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("the DevTools connection failed")); }), 30000, "the DevTools connection");
  ws.onerror = () => fail(new Error("the DevTools connection failed"));
  ws.onclose = () => fail(new Error("the DevTools connection closed"));

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

  // Ctrl+V with Caps Lock on (the key reported as "V"): still the browser's paste, never xterm's
  k = await ctrl("V", "KeyV", 86);
  ok(k?.key === "V" && k.ctrl && k.prevented === false, `Ctrl+V with Caps Lock ("V"): left to the browser, its paste (${JSON.stringify(k)})`);
  ok(await until(`${LAST} === ">>> xyzSELECTME + 1SELECTME"`, 10000), `...the copied word pasted again (${JSON.stringify(await ev(LAST))})`);
} catch (e) {
  ok(false, String(e?.stack ?? e));
} finally {
  fail(new Error("the suite ended"));
  try { ws?.close(); } catch {}
  // (its profile removed once Chrome has exited: a profile removed while Chrome still writes is left behind)
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    const gone = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    try { await within(gone, 10000, "Chrome's exit"); } catch {
      chrome.kill("SIGKILL");
      await within(gone, 5000, "Chrome's exit after SIGKILL").catch((e) => ok(false, String(e.message)));
    }
  }
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  console.log(process.exitCode ? `FAIL: the Console's copy and paste keys` : `ok: the Console's copy and paste keys, ${checks} checks`);
}
