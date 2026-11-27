// ci: web-browser/notebook order=62
// An R notebook on the full page in headless Chromium: the mode menu offers R; a cell runs R on Sagebrush's R
// (lib/_rill, fetched as its own lazy group), R prints its own values, variables persist from cell to cell, and a
// function R has that Sagebrush doesn't implement yet says so on the cell's error output.  Serve web/dist first:
//   bun web/build.ts && bash web/run-tests.sh r-notebook
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-r-notebook-"));
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
// (each evaluation has its own deadline, so a wedged page fails the check instead of hanging the run)
const ev = async (expression, ms = 60000) => {
  const r = await Promise.race([send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), sleep(ms).then(() => ({ exceptionDetails: { text: "evaluation timed out" } }))]);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500));
  return r.result?.value;
};
const until = async (expr, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr, ms)) return true; await sleep(200); } return false; };
const J = JSON.stringify;
const out = (i) => ev(`sagebrush.notebook.cells()[${i}].out.textContent`);
const run = (i) => ev(`sagebrush.notebook.run(sagebrush.notebook.cells()[${i}]).then(() => 1)`, 120000);
try {
  await send("Page.navigate", { url: base });
  ok(await until("window.sagebrush && sagebrush.kernel?.ready", 90000), "the page is ready");
  ok(await ev(`[...document.querySelectorAll('#mode option')].some((o) => o.value === 'r' && o.textContent === 'R')`), "the mode menu offers R");
  const cells = [
    { id: "r1", code: "x <- c(4, 8, 15)\nx * 2" },
    { id: "r2", code: "x + 1" },
    { id: "r3", code: "sd(x)" },
  ];
  await ev(`(sagebrush.notebook.load(${J({ mode: "r", cells })}), sagebrush.notebook.setReactive?.(false), 1)`);
  ok((await ev("sagebrush.notebook.mode")) === "r", "a notebook loaded in R mode is in R mode");
  await run(0);
  ok(await until(`sagebrush.notebook.cells()[0].out.textContent.includes("[1]  8 16 30")`, 120000), "a cell runs R and prints R's value: " + J(await out(0)));
  await run(1);
  ok(await until(`sagebrush.notebook.cells()[1].out.textContent.includes("[1]  5  9 16")`), "the next cell sees x: " + J(await out(1)));
  await run(2);
  ok(await until(`sagebrush.notebook.cells()[2].out.textContent.includes("not implemented in Sagebrush yet")`), "a function R has and Sagebrush doesn't yet says so: " + J(await out(2)));
} catch (e) {
  ok(false, String(e?.stack ?? e));
} finally {
  console.log(process.exitCode ? "FAIL: the R notebook" : `ok: the R notebook, ${checks} checks`);
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
