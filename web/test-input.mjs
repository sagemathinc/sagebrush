// input() on the full page in headless Chromium: the run asks for a line, a
// field under the cell takes it (typed, then Enter), and the prompt with the
// line is the cell's output, as in Jupyter; several in one cell; a Stop while
// it waits is a KeyboardInterrupt that keeps the variables.  The page runs
// Python in the sandboxed runner, whose frame keeps the buffer the run waits
// on (web/runner/index.html, web/worker.ts's stdin).  Serve web/dist first:
//   bun web/build.ts && (cd web/dist && python3 ../serve.py 8765) &
//   node web/test-input.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-input-"));
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
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
// (real key events, to the focused element)
const typeText = (text) => send("Input.insertText", { text });
const press = async (key, code = key, keyCode = 0) => {
  // (a one-character key carries its text, as a real key press does)
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, ...(key.length === 1 ? { text: key } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
};
const enter = () => press("Enter", "Enter", 13);
const cellOut = (i) => `sagebrush.notebook.outputText(sagebrush.notebook.cells()[${i}].out)`;
const field = (i) => `sagebrush.notebook.cells()[${i}].out.querySelector('.stdin-field')`;
const running = (i) => `sagebrush.notebook.cells()[${i}].el.classList.contains('running')`;
const CELLS = [
  "print('before')\nname = input('Your name? ')\nprint('hi', name)",
  "total = 0\nfor i in range(3):\n    total += int(input(f'number {i + 1}: '))\nprint('sum', total)",
  "x = input('waiting: ')",
  "print(total, name)",
];
try {
  await send("Page.navigate", { url: base });
  await until("window.sagebrush && document.querySelector('#status').textContent.startsWith('ready')");
  await ev(`(() => { sagebrush.notebook.replace({ mode: "python", cells: ${JSON.stringify(CELLS.map((code, i) => ({ id: "in" + i, code })))} }); return true; })()`);
  await sleep(500);

  // one input(): the field, its prompt and focus; what was printed before it is shown first
  await ev("(() => { sagebrush.notebook.run(sagebrush.notebook.cells()[0]); return true; })()");
  await until(`!!${field(0)}`);
  const asked = await ev(`(() => { const c = sagebrush.notebook.cells()[0]; return { prompt: c.out.querySelector('.stdin-prompt').textContent, focused: document.activeElement === c.out.querySelector('.stdin-field'), out: ${cellOut(0)} }; })()`);
  ok(asked.prompt === "Your name? " && asked.focused && asked.out.startsWith("before\n"), "input('Your name? ') shows a focused field with its prompt, after what was printed before: " + JSON.stringify(asked));
  // (a notebook key typed in the field is text, not a command: 'b' would insert a cell, 'd d' delete one)
  const before = await ev("sagebrush.notebook.cells().length");
  await typeText("Ada");
  await press("b", "KeyB", 66);
  await press("d", "KeyD", 68);
  await press("d", "KeyD", 68);
  await typeText(" Lovelace");
  ok((await ev("sagebrush.notebook.cells().length")) === before, "keys typed in the field don't act on the notebook's cells");
  await enter();
  await until(`!${running(0)}`);
  const out0 = await ev(cellOut(0));
  ok(out0 === "before\nYour name? Adabdd Lovelace\nhi Adabdd Lovelace\n" && !(await ev(`!!${field(0)}`)), "Enter sends the line: the prompt and the line, then what follows, as Jupyter shows them: " + JSON.stringify(out0));

  // three in a loop, each its own field
  await ev("(() => { sagebrush.notebook.run(sagebrush.notebook.cells()[1]); return true; })()");
  for (const v of ["4", "5", "33"]) {
    await until(`!!${field(1)}`);
    await typeText(v);
    await enter();
    await until(`!${field(1)} || ${field(1)}.value === ''`);
  }
  await until(`!${running(1)}`);
  const out1 = await ev(cellOut(1));
  ok(out1 === "number 1: 4\nnumber 2: 5\nnumber 3: 33\nsum 42\n", "three input() calls in a loop: " + JSON.stringify(out1));

  // a Stop while it waits: KeyboardInterrupt, the field gone, the variables kept
  await ev("(() => { sagebrush.notebook.run(sagebrush.notebook.cells()[2]); return true; })()");
  await until(`!!${field(2)}`);
  const t0 = Date.now();
  await ev("(() => { [...document.querySelectorAll('button')].find((b) => /Stop/.test(b.textContent)).click(); return true; })()");
  await until(`!${running(2)}`);
  const stopMs = Date.now() - t0;
  const out2 = await ev(cellOut(2));
  ok(/KeyboardInterrupt\n$/.test(out2) && !(await ev(`!!${field(2)}`)) && stopMs < 5000, `Stop while input() waits: KeyboardInterrupt in ${stopMs} ms, the field gone: ` + JSON.stringify(out2.slice(-80)));
  await ev("(async () => { await sagebrush.notebook.run(sagebrush.notebook.cells()[3]); return true; })()");
  const out3 = (await ev(cellOut(3))).trim();
  ok(out3 === "42 Adabdd Lovelace", "the variables are kept after the Stop: " + out3);
} catch (e) {
  ok(false, String(e?.stack ?? e));
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
