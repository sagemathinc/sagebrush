// ci: web-browser/notebook order=61
// Leaving the page's Console, on the full page in headless Chromium: exit() and quit() (Python and Sage), Magma's
// quit; and MATLAB's exit, Ctrl+D at an empty prompt, exit(1) and sys.exit('bye') (its text first) each end the
// Console's session and start a new one, saying so in one line, its variables gone; exit's repr says how to leave, as
// CPython's; a raised ValueError, a Magma error, Ctrl+D on a line with text in it and Ctrl+D in a continuation don't
// end anything; a notebook cell's exit and exit() are as before (NameError); the notebook's own interpreter is never
// touched.  Serve web/dist first:
//   bun web/build.ts && bash web/run-tests.sh console-exit
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-console-exit-"));
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
// (the Console's screen: xterm's rows, as text; its last line, the prompt waiting)
const SCREEN = "[...document.querySelectorAll('#term .xterm-rows > div')].map((d) => d.textContent.replace(/\\s+$/, '')).join('\\n').replace(/\\n+$/, '')";
const screen = () => ev(SCREEN);
const ENDED = "Session ended. A new one started: earlier variables are gone.";
// (typed as a person types: the text into xterm's textarea, shown on the prompt's line, then Enter, and the line
// left: a prompt waited for next is then a new one, never the one this line was typed at)
const LAST = `${SCREEN}.split('\\n').pop()`;
const type = async (text) => {
  await ev("document.querySelector('#term textarea').focus(), 1");
  if (text) await send("Input.insertText", { text });
  if (text && !(await until(`${LAST}.endsWith(${JSON.stringify(text)})`, 10000))) throw new Error(`${JSON.stringify(text)} wasn't shown: ${JSON.stringify(await ev(LAST))}`);
  const line = await ev(LAST);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  // (the line left: what the screen ends with is no longer it)
  await until(`${LAST} !== ${JSON.stringify(line)}`, 10000);
};
const ctrlD = async () => {
  await ev("document.querySelector('#term textarea').focus(), 1");
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "d", code: "KeyD", windowsVirtualKeyCode: 68, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "d", code: "KeyD", windowsVirtualKeyCode: 68, modifiers: 2 });
};
// (the screen's last lines: what was said just before the prompt now waiting)
const tail = (k) => `${SCREEN}.split('\\n').slice(-${k})`;
const endedNow = (before = null) => until(`JSON.stringify(${tail(before === null ? 2 : 3)}) === ${JSON.stringify(JSON.stringify([...(before === null ? [] : [before]), ENDED, ">>>"]))}`, 60000);
const notEnded = async () => { const t = await ev(tail(2)); return t[1] === ">>>" && t[0] !== ENDED; };
const waitPrompt = (p) => until(`(() => { const s = ${SCREEN}; return s.split('\\n').pop() === ${JSON.stringify(p)}; })()`, 60000);

try {
  await send("Page.navigate", { url: base });
  ok(await until(ready, 60000), "the page is up");
  await ev("sagebrush.notebook.cells()[0] && 1");
  const notebookKernel = await ev("(window.__nbk = sagebrush.kernel, 1)");
  await ev("document.querySelector('#consolebtn').click(); true");
  ok(await until("/console ready/.test(document.querySelector('#status').textContent)", 60000), "the Console is ready");
  ok(await waitPrompt(">>>"), "its prompt: " + JSON.stringify((await screen()).split("\n").pop()));

  // exit's repr, as CPython's site gives it
  await type("exit");
  ok(await until(`${SCREEN}.includes("Use exit() or Ctrl-D (i.e. EOF) to exit")`), "exit alone: CPython's 'Use exit() or Ctrl-D (i.e. EOF) to exit'");
  ok(await waitPrompt(">>>"), "...and the prompt again");

  // exit(): the session ends, a new one starts, the old variables gone
  await type("x = 5");
  await waitPrompt(">>>");
  await type("exit()");
  ok(await endedNow(), `exit(): "${ENDED}"`);
  ok(await waitPrompt(">>>"), "...then a fresh prompt");
  await type("x");
  ok(await until(`${SCREEN}.includes("NameError: name 'x' is not defined")`), "...in a new session: x is gone");
  await waitPrompt(">>>");

  // quit(5): the same, its status not an error to show
  await type("y = 1");
  await waitPrompt(">>>");
  await type("quit()");
  ok(await endedNow(), "quit(): the session ends too");
  await waitPrompt(">>>");
  await type("y");
  ok(await until(`${SCREEN}.includes("NameError: name 'y' is not defined")`), "...y gone");
  await waitPrompt(">>>");

  // Ctrl+D on a line with text: deletes, as Delete does; nothing ends
  await ev("document.querySelector('#term textarea').focus(), 1");
  await send("Input.insertText", { text: "z = 7" });
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Home", code: "Home", windowsVirtualKeyCode: 36 });
  await ctrlD();
  await sleep(300);
  ok((await screen()).split("\n").pop() === ">>>  = 7" && (await ev(tail(2)))[0] !== ENDED, "Ctrl+D with text on the line: deletes a character, nothing ends: " + JSON.stringify((await screen()).split("\n").pop()));
  await ev("document.querySelector('#term textarea').focus(), 1");
  await send("Input.insertText", { text: "z" });
  await type("");
  await waitPrompt(">>>");
  // Ctrl+D at an empty prompt: ends it
  await ctrlD();
  ok(await endedNow(), "Ctrl+D at an empty prompt: the session ends, a new one starts");
  ok(await waitPrompt(">>>"), "...then a fresh prompt");
  await type("z");
  ok(await until(`${SCREEN}.includes("NameError: name 'z' is not defined")`), "...z gone");
  await waitPrompt(">>>");

  // sys.exit(3): a failing status is written, then the session ends, as CPython's prompt ends
  // Ctrl+D inside a continuation (its indent cleared, the line empty, a statement held): nothing ends, no notice; the
  // statement goes on and the session keeps its variables
  await type("k = 9");
  await waitPrompt(">>>");
  await type("def f():");
  ok(await waitPrompt("..."), "a continuation: ...");
  const bs = async () => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  };
  await bs();
  await ctrlD();
  await sleep(1500);
  ok((await screen()).split("\n").pop() === "..." && (await ev(tail(2)))[0] === ">>> def f():", `Ctrl+D in a continuation, its line empty: nothing ends, no notice, the same ... (${JSON.stringify(await ev(tail(2)))})`);
  await type("    return 7");
  await bs();
  await type("");
  await waitPrompt(">>>");
  await type("f() + k");
  ok(await until(`${tail(2)}[0] === "16"`), "...the statement went on, and k is still there: f() + k is 16");
  await waitPrompt(">>>");

  await type("import sys; sys.exit('bye')");
  ok(await endedNow("bye"), "sys.exit('bye'): its message written, then the session ends");
  await waitPrompt(">>>");

  // exit(1): a failing status ends it too, as CPython's prompt; a raised ValueError doesn't
  await type("w = 2");
  await waitPrompt(">>>");
  await type("raise ValueError('v')");
  ok(await until(`${SCREEN}.includes("ValueError: v")`), "raise ValueError: its traceback");
  ok(await waitPrompt(">>>") && await notEnded(), "...and the prompt goes on, the session kept");
  await type("w");
  ok(await until(`${tail(2)}[0] === "2"`), "...w is still 2");
  await waitPrompt(">>>");
  await type("exit(1)");
  ok(await endedNow(), "exit(1): the session ends");
  await waitPrompt(">>>");
  await type("w");
  ok(await until(`${SCREEN}.includes("NameError: name 'w' is not defined")`), "...w gone");
  await waitPrompt(">>>");

  // a notebook cell, after the Console has run: exit and exit() as before (a NameError: the Console's builtins are
  // its own), the cell's run never ending a session, the notebook's interpreter the same one
  const cell = (code) => ev(`new Promise((res) => { let o = ''; sagebrush.kernel.execute(${JSON.stringify(code)}, { mode: 'python' }, { start() {}, out(t) { o += t; }, display() {}, interact() {}, clear() {}, done(ms, info) { res({ o, exited: !!info?.exited }); }, stopped(m) { res({ o: 'stopped ' + m }); }, skipped() { res({ o: 'skipped' }); } }); })`);
  for (const code of ["exit", "exit()"]) {
    const r = await cell(code);
    ok(r.o.includes("NameError: name 'exit' is not defined") && !r.exited, `a notebook cell's ${code}: NameError, as before; nothing exited (${JSON.stringify(r).slice(0, 160)})`);
  }

  // the notebook's interpreter: the same one, untouched
  ok(await ev("window.__nbk === sagebrush.kernel && sagebrush.kernel.ready === true"), "the notebook's own interpreter is the same, ready");

  // Magma: quit; ends it; an error does not
  await ev("sagebrush.notebook.setMode('magma'), 1");
  await type("");
  ok(await waitPrompt(">>>"), "(Magma)");
  await type("a := 3;");
  await waitPrompt(">>>");
  await type("Foo(1);");
  await until(`/User error|error/i.test(${SCREEN}.split('\\n').slice(-3).join('\\n'))`);
  await waitPrompt(">>>");
  ok(await notEnded(), "Magma: an error doesn't end the session");
  await type("a;");
  ok(await until(`${SCREEN}.split('\\n').slice(-2)[0] === "3"`), "...a is still 3");
  await waitPrompt(">>>");
  await type("quit;");
  ok(await endedNow(), "Magma: quit; ends it");
  await waitPrompt(">>>");

  // MATLAB: exit ends it
  await ev("sagebrush.notebook.setMode('matlab'), 1");
  await type("b = 4;");
  await waitPrompt(">>>");
  await type("exit");
  ok(await endedNow(), "MATLAB: exit ends it");
  await waitPrompt(">>>");
  await type("b");
  ok(await until(`${SCREEN}.includes("Unrecognized function or variable 'b'")`), "...b gone");
  await ev("sagebrush.notebook.setMode('python'), 1");
} catch (e) {
  ok(false, String(e?.stack ?? e));
} finally {
  console.log(process.exitCode ? `FAIL: the Console's exit` : `ok: the Console's exit, ${checks} checks`);
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
