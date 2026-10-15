// ipywidgets' widgets on their own, on the full page in headless Chromium: a
// widget (or a VBox of them) that is a cell's value is drawn as controls;
// moving one sets its .value, calls its observers and Button.on_click
// handlers, and reruns interactive_output's function.  Serve web/dist first:
//   bun web/build.ts && (cd web/dist && python3 ../serve.py 8765) &
//   node web/test-widgets.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-widgets-"));
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
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
const outs = "sagebrush.notebook.cells().map((c) => c.out.textContent)";
const CELLS = [
  "from ipywidgets import IntSlider, Button, VBox, Dropdown, interactive_output\nn = IntSlider(5, 1, 10, description='n')\nn",
  "clicks = []\nb = Button(description='Go')\nb.on_click(lambda w: (clicks.append(1), print('clicked', len(clicks))))\nd = Dropdown(options=['a', 'b'], description='d')\nseen = []\nd.observe(lambda ch: seen.append(ch['new']), names='value')\nout = interactive_output(lambda n, d: print('f', n, d), {'n': n, 'd': d})\nVBox([n, d, b])",
  "print(n.value, d.value, len(clicks), seen)",
  "IntSlider(1, 10)",
];
try {
  await send("Page.navigate", { url: base });
  await until("window.sagebrush && document.querySelector('#status').textContent.startsWith('ready')");
  await ev(`(() => { sagebrush.notebook.replace({ mode: "python", cells: ${JSON.stringify(CELLS.map((code, i) => ({ id: "w" + i, code })))} }); return true; })()`);
  await sleep(500);
  await ev("(async () => { const nb = sagebrush.notebook; for (const c of nb.cells().slice(0, 2)) await nb.run(c); return true; })()");
  const c0 = await ev("(() => { const o = sagebrush.notebook.cells()[0].out; return { sliders: o.querySelectorAll('.interact input[type=range]').length, label: o.querySelector('.interact label')?.textContent, text: o.textContent }; })()");
  ok(c0.sliders === 1 && c0.label === "n" && !/IntSlider\(value/.test(c0.text), "a widget as a cell's value is a slider, not its repr: " + JSON.stringify(c0));
  const c1 = await ev("(() => { const o = sagebrush.notebook.cells()[1].out; return { range: o.querySelectorAll('input[type=range]').length, select: o.querySelectorAll('select').length, button: o.querySelector('.interact button:not(.play)')?.textContent, text: o.querySelector('.iout')?.textContent }; })()");
  ok(c1.range === 1 && c1.select === 1 && c1.button === "Go" && c1.text.trim() === "f 5 a", "a VBox of a slider, a dropdown and a button, with interactive_output's first output: " + JSON.stringify(c1));
  const key1 = "(() => { const o = sagebrush.notebook.cells()[1].out; return o.querySelector('.interact').dataset.key; })()";
  const after = await ev(`(async () => { const nb = sagebrush.notebook; const box = await nb.setInteract(${key1}, { _w0: 8 }); return box.textContent; })()`);
  ok(after.trim() === "f 8 a", "moving the slider reruns the function: " + after.trim());
  const after2 = await ev(`(async () => { const nb = sagebrush.notebook; const box = await nb.setInteract(${key1}, { _w1: 1 }); return box.textContent; })()`);
  ok(after2.trim() === "f 8 b", "choosing in the dropdown too: " + after2.trim());
  await ev("(() => { sagebrush.notebook.cells()[1].out.querySelector('.interact button:not(.play)').click(); return true; })()");
  await until("/clicked 1/.test(sagebrush.notebook.cells()[1].out.querySelector('.iout').textContent)", 10000);
  ok(true, "a click calls on_click's handler");
  await ev("(async () => { const nb = sagebrush.notebook; await nb.run(nb.cells()[2]); return true; })()");
  const c2 = (await ev(outs))[2].trim();
  ok(c2 === "8 b 1 ['b']", "the values are the widgets', and observe saw the change: " + c2);
  await ev("(async () => { const nb = sagebrush.notebook; await nb.run(nb.cells()[3]); return true; })()");
  const c3 = await ev("(() => { const i = sagebrush.notebook.cells()[3].out.querySelector('input[type=range]'); return i ? [i.min, i.max, i.value] : null; })()");
  ok(JSON.stringify(c3) === '["10","100","10"]', "IntSlider(1, 10) is value 1, min 10: clipped to 10, as ipywidgets: " + JSON.stringify(c3));
} catch (e) {
  ok(false, String(e?.stack ?? e));
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
