// ci: web-browser/notebook order=82
// IPython's output names in the reactive notebook (design/reactive-notebook.md), on the full page in headless
// Chromium, typed and run with Shift+Enter as a person does:
//   1. William's report: cell 1 `10`, cell 2 `_`, both show 10; cell 1 changed to `5`, Shift+Enter: cell 2 shows 5;
//   2. __ and ___ are the 2nd and 3rd nearest cells above that showed a value; a cell showing none is skipped;
//   3. the value is the cell above's, not the last one run: a cell below that runs first doesn't change it.
//   4. a cell that stops or starts showing a value moves ___ for a reader below it that it doesn't supply: it reruns.
// Serve web/dist first:
//   bun web/build.ts && bash web/run-tests.sh reactive-outputs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
const base = (process.env.SB_URL ?? "http://127.0.0.1:8765/") + "?reactive";
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-reactive-outputs-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1000,700", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill("SIGKILL"); } catch {} });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
// (every CDP call has its own deadline)
const send = (method, params = {}) => Promise.race([
  new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); }),
  sleep(30000).then(() => { throw new Error(`no answer to ${method} in 30 s`); }),
]);
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
const ready = "window.sagebrush && document.querySelectorAll('#cells .cell').length > 0 && sagebrush.kernel?.ready";
const out = (i) => ev(`sagebrush.notebook.cells()[${i}].out.textContent.trim()`);
const count = () => ev("sagebrush.notebook.cells().length");
// (cell i, made if needed, its text replaced as typed, then Shift+Enter: a trusted key, the person's)
// (and waits for that run: the cell's count label changed from what it was, and nothing queued or running)
const typeAndRun = async (i, text) => {
  await ev(`(() => { const nb = sagebrush.notebook; while (nb.cells().length <= ${i}) nb.addCell(''); const c = nb.cells()[${i}]; window.__n = c.n.textContent; c.n.textContent = '[?]'; c.ta.focus(); c.ta.select(); return true; })()`);
  await send("Input.insertText", { text });
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
  await until(`(() => { const t = sagebrush.notebook.cells()[${i}].n.textContent; return /^\\[\\d+\\]$/.test(t); })()`, 30000);
  await settled();
};
// (nothing queued or running)
const settled = () => until("!document.querySelector('#cells .cell.running, #cells .cell.queued')", 30000);
try {
  await send("Page.navigate", { url: base });
  await until(ready);
  // (a new notebook: nothing from an earlier test)
  const k = await ev("sagebrush.kernel.uid");
  await ev(`document.querySelector('#filebtn').click(); document.querySelector('[data-f="new"]').click(); true`);
  await until(`sagebrush.kernel.uid !== ${k} && sagebrush.kernel.ready`, 15000);
  ok(await ev("!!sagebrush.notebook.reactive"), "the reactive notebook is on");
  await ev("sagebrush.notebook.setBudget(Infinity); true");

  // 1. William's report, as he did it
  await typeAndRun(0, "10");
  await settled();
  await typeAndRun(1, "_");
  await settled();
  ok((await out(0)) === "10" && (await out(1)) === "10", `cell 1 \`10\`, cell 2 \`_\`: both show 10 (${await out(0)}, ${await out(1)})`);
  await typeAndRun(0, "5");
  await settled();
  await until("sagebrush.notebook.cells()[1].out.textContent.trim() === '5'", 15000).catch(() => {});
  ok((await out(0)) === "5" && (await out(1)) === "5", `cell 1 changed to \`5\`, Shift+Enter: cell 2 shows 5 (${await out(0)}, ${await out(1)})`);

  // 2. __ and ___, and a cell showing nothing skipped (cells 3, 4: one showing nothing, then all three)
  await typeAndRun(2, "x = 1");
  await settled();
  await typeAndRun(3, "(_, __, ___)");
  await settled();
  ok((await out(3)) === "(5, 5, '')", `__ and ___: the 2nd and 3rd cells above that showed a value, the one showing nothing skipped (${await out(3)})`);
  await typeAndRun(0, "7");
  await settled();
  await until("sagebrush.notebook.cells()[3].out.textContent.trim() === '(7, 7, \\'\\')'", 15000).catch(() => {});
  ok((await out(1)) === "7" && (await out(3)) === "(7, 7, '')", `a change at the top reaches both (${await out(1)}, ${await out(3)})`);

  // 3. the cell above's value, not the last one run: B reads z from D below it, so D runs first and shows 3
  const at = await count();
  await typeAndRun(at, "1");
  await settled();
  await typeAndRun(at + 2, "z = 3\nz");
  await settled();
  await typeAndRun(at + 1, "_ + z");
  await settled();
  ok((await out(at + 1)) === "4", `\`_ + z\` below \`1\`, with \`z = 3; z\` below it run first: 1 + 3 = 4, not 3 + 3 (${await out(at + 1)})`);
  await typeAndRun(at + 2, "z = 30\nz");
  await settled();
  await until(`sagebrush.notebook.cells()[${at + 1}].out.textContent.trim() === '31'`, 15000).catch(() => {});
  ok((await out(at + 1)) === "31", `changing D reruns B with A's value still: 1 + 30 = 31 (${await out(at + 1)})`);

  // 4. a cell that stops or starts showing a value moves ___ for a reader below it that it doesn't supply.
  // Stops: below D (showing 30), P `100`, Q `200`, S `300`, R `___` (100); Q to `y = 0`: R's ___ is D's 30.
  const p = at + 3;
  for (const [i, code] of [[p, "100"], [p + 1, "200"], [p + 2, "300"], [p + 3, "___"]]) { await typeAndRun(i, code); await settled(); }
  ok((await out(p + 3)) === "100", `\`___\` below \`100\`, \`200\`, \`300\`: 100 (${await out(p + 3)})`);
  await typeAndRun(p + 1, "y = 0");
  await settled();
  await until(`sagebrush.notebook.cells()[${p + 3}].out.textContent.trim() === '30'`, 15000).catch(() => {});
  ok((await out(p + 3)) === "30", `the 2nd of them stops showing a value: \`___\` reruns, now D's 30 (${await out(p + 3)})`);
  // Starts: below R (showing 30), P2 `1000`, Q2 `y = 0`, S2 `3000`, R2 `___` (R's 30); Q2 to `2000`: R2's ___ is P2's 1000.
  const q = p + 4;
  for (const [i, code] of [[q, "1000"], [q + 1, "y = 0"], [q + 2, "3000"], [q + 3, "___"]]) { await typeAndRun(i, code); await settled(); }
  ok((await out(q + 3)) === "30", `\`___\` below \`1000\`, \`y = 0\`, \`3000\`: the 3rd cell above showing one, 30 (${await out(q + 3)})`);
  await typeAndRun(q + 1, "2000");
  await settled();
  await until(`sagebrush.notebook.cells()[${q + 3}].out.textContent.trim() === '1000'`, 15000).catch(() => {});
  ok((await out(q + 3)) === "1000", `the middle one starts showing a value: \`___\` reruns, now 1000 (${await out(q + 3)})`);
} catch (e) {
  ok(false, "threw: " + (e?.stack ?? e));
} finally {
  try { ws.close(); } catch {}
  try { chrome.kill("SIGKILL"); } catch {}
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
