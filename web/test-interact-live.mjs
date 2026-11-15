// ci: web-browser/notebook order=31
// An @interact's rerun on the notebook page, in headless Chromium: a slow one
// shows its output as it prints, its cell shows it running (the time counting,
// ▶ a Stop), Stop interrupts it, and changes made while it runs interrupt it
// and run the latest values only; a fast one still replaces its output in one
// step; one that computes without sleeping shows what it prints as it goes; and a
// cell that prints, then computes without printing, shows what it printed while it computes.
// Serve web/dist first:
//   bun web/build.ts && (cd web/dist && python3 ../serve.py 8765) &
//   node web/test-interact-live.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-ilive-"));
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
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(50); } throw new Error("timeout: " + expr + "\nstate at the failure: " + JSON.stringify(await ev(STATE).catch(() => null))); };
const CELLS = [
  "kept = 42\ncalls = []",
  "import time\nfrom ipywidgets import interact\n@interact\ndef f(n='0.01'):\n    calls.append(n)\n    print('running...', n)\n    print('hi')\n    time.sleep(float(n))\n    print('done')",
  "print(kept, calls)",
];
// the interact's state: its output, and how its cell shows the rerun
const STATE = `(() => { const c = sagebrush.notebook.cells()[1]; return { out: c.out.querySelector('.iout')?.textContent ?? null, running: c.el.classList.contains('running'), queued: c.el.classList.contains('queued'), time: c.time.textContent, button: c.runb.textContent }; })()`;
const KEY = "sagebrush.notebook.cells()[1].out.querySelector('.interact').dataset.key";
// (a change of the control, not waited for: resolves, in the page, when the interact is idle again)
const change = (v) => ev(`(() => { window.__done = sagebrush.notebook.setInteract(${KEY}, { n: ${JSON.stringify(v)} }).then(() => (window.__idle = true)); window.__idle = false; return true; })()`);
try {
  await send("Page.navigate", { url: base });
  await until("window.sagebrush && document.querySelector('#status').textContent.startsWith('ready')");
  await ev(`(() => { sagebrush.notebook.replace({ mode: "python", cells: ${JSON.stringify(CELLS.map((code, i) => ({ id: "i" + i, code })))} }); return true; })()`);
  await sleep(500);
  await ev("(async () => { const nb = sagebrush.notebook; for (const c of nb.cells().slice(0, 2)) await nb.run(c); return true; })()");
  await until(`!!sagebrush.notebook.cells()[1].out.querySelector('.interact .iout')`);
  const first = await ev(STATE);
  ok(/done/.test(first.out) && !first.running, "the cell's run draws the controls and runs f at its default: " + JSON.stringify(first));

  // 1. a slow rerun shows what it prints at once, and its cell shows it running
  const t0 = Date.now();
  await change("3");
  await until(`/running\\.\\.\\. 3\\s+hi/.test(sagebrush.notebook.cells()[1].out.querySelector('.iout').textContent)`, 2500);
  const early = await ev(STATE);
  ok(Date.now() - t0 < 2500 && !/done/.test(early.out) && !/running\.\.\. 0\.01/.test(early.out), `its first lines show while it sleeps (${Date.now() - t0} ms in), the old output gone: ` + JSON.stringify(early.out));
  ok(early.running && early.button === "■" && /^running… \d+\.\d s$/.test(early.time), "its cell shows it running, ▶ a Stop, the time counting: " + JSON.stringify(early));
  await sleep(800);
  const later = await ev(STATE);
  ok(later.running && later.time !== early.time, `the time counts on: ${early.time} -> ${later.time}`);
  await until("window.__idle === true", 10000);
  const after = await ev(STATE);
  const ms = +/^(\d+) ms$/.exec(after.time)?.[1];
  ok(/running\.\.\. 3\s+hi\s+done/.test(after.out) && !after.running && after.button === "▶" && ms >= 3000 && ms < 6000, "it ends with all its output, its cell settled, its own time shown (not the first run's): " + JSON.stringify(after));

  // 2. Stop interrupts it, the interpreter kept
  await change("20");
  await until(`/hi/.test(sagebrush.notebook.cells()[1].out.querySelector('.iout').textContent) && sagebrush.notebook.cells()[1].el.classList.contains('running')`, 5000);
  await sleep(500); // (past the Stop's guard against a double click)
  const ts = Date.now();
  await ev("(() => { sagebrush.notebook.cells()[1].runb.click(); return true; })()");
  await until("window.__idle === true", 5000);
  const stopped = await ev(STATE);
  ok(Date.now() - ts < 3000 && /KeyboardInterrupt/.test(stopped.out) && !/done/.test(stopped.out) && !stopped.running && stopped.button === "▶", `Stop interrupts it within ${Date.now() - ts} ms: ` + JSON.stringify(stopped));
  await ev("(async () => { const nb = sagebrush.notebook; await nb.run(nb.cells()[2]); return true; })()");
  const kept = (await ev("sagebrush.notebook.cells()[2].out.textContent")).trim();
  ok(/^42 \[/.test(kept), "the interpreter was kept: " + kept);

  // 3. changes while it runs: it is interrupted, and only the latest values run
  await ev("(async () => { const nb = sagebrush.notebook; await nb.run(nb.cells()[0]); return true; })()");
  await change("20");
  await until(`/running\\.\\.\\. 20\\s+hi/.test(sagebrush.notebook.cells()[1].out.querySelector('.iout').textContent)`, 5000);
  const tc = Date.now();
  // (three changes at once, as a person typing or dragging makes them)
  await ev(`(() => { const nb = sagebrush.notebook; window.__done = Promise.all(["0.31", "0.32", "0.33"].map((v) => nb.setInteract(${KEY}, { n: v }))).then(() => (window.__idle = true)); window.__idle = false; return true; })()`);
  await until("window.__idle === true", 8000);
  const coalesced = await ev(STATE);
  ok(Date.now() - tc < 4000 && /^running\.\.\. 0\.33\s+hi\s+done\s*$/.test(coalesced.out) && !coalesced.running, `three quick changes during it: interrupted at once, the last one's output only (${Date.now() - tc} ms): ` + JSON.stringify(coalesced.out));
  await ev("(async () => { const nb = sagebrush.notebook; await nb.run(nb.cells()[2]); return true; })()");
  const calls = (await ev("sagebrush.notebook.cells()[2].out.textContent")).trim();
  // (the reactive notebook reruns f at its default after the cell that empties calls: then 20, then 0.33 only)
  ok(/^42 \[('0\.01', )?'20', '0\.33'\]$/.test(calls), "f ran for the slow value and then the last only: " + calls);

  // 4. a fast rerun replaces its output in one step: never empty, never half
  await ev(`(() => { const o = sagebrush.notebook.cells()[1].out.querySelector('.iout'); window.__seen = []; window.__mo = new MutationObserver(() => window.__seen.push(o.textContent)); window.__mo.observe(o, { childList: true, subtree: true, characterData: true }); return true; })()`);
  await change("0.01");
  await until("window.__idle === true", 5000);
  const seen = await ev("(() => { window.__mo.disconnect(); return window.__seen; })()");
  ok(seen.length >= 1 && seen.every((t) => /^running\.\.\. 0\.01\s+hi\s+done\s*$/.test(t)), "a fast rerun's output comes in one step: " + JSON.stringify(seen));

  // 5. without a sleep: what a busy function prints shows while it computes (a write more than 100 ms after
  // the last flush goes out at once), not only when it returns
  await ev(`(() => { sagebrush.notebook.replace({ mode: "python", cells: [{ id: "b0", code: "kept = 42" }, { id: "b1", code: ${JSON.stringify("import time\nfrom ipywidgets import interact\n@interact\ndef f(n='0'):\n    def busy(s):\n        t = time.monotonic()\n        while time.monotonic() - t < s:\n            pass\n    print('begin')\n    busy(float(n))\n    print('middle')\n    busy(float(n))\n    print('end')")} }] }); return true; })()`);
  await sleep(500);
  await ev("(async () => { const nb = sagebrush.notebook; for (const c of nb.cells()) await nb.run(c); return true; })()");
  await until(`/end/.test(sagebrush.notebook.cells()[1].out.querySelector('.interact .iout')?.textContent ?? '')`);
  await change("0.6");
  // (the old output stays until the rerun's first 150 ms are over: its middle, without its end yet)
  await until(`/^begin\\s+middle\\s*$/.test(sagebrush.notebook.cells()[1].out.querySelector('.iout').textContent)`, 5000);
  const busy = await ev(STATE);
  ok(/^begin\s+middle\s*$/.test(busy.out) && busy.running, "a computation with no sleep shows what it printed while it runs: " + JSON.stringify(busy));
  await until("window.__idle === true", 8000);
  ok(/^begin\s+middle\s+end\s*$/.test((await ev(STATE)).out), "and ends with all of it");

  // 6. a cell that prints and then computes without printing: the page asks the run for its output while
  // it computes (the flush request), so what it printed shows before it ends
  // ('start' goes out at once, the first write in a while; 'begin', right after it, waits for the request)
  await ev(`(() => { sagebrush.notebook.replace({ mode: "python", cells: [{ id: "s0", code: ${JSON.stringify("import time\nprint('start')\nprint('begin')\nt = time.monotonic()\nwhile time.monotonic() - t < 1.5:\n    pass\nprint('end')")} }] }); return true; })()`);
  await sleep(500);
  const ts6 = Date.now();
  await ev("(() => { window.__ran = sagebrush.notebook.run(sagebrush.notebook.cells()[0]).then(() => (window.__ran6 = true)); window.__ran6 = false; return true; })()");
  const OUT6 = "sagebrush.notebook.cells()[0].out.textContent";
  await until(`/begin/.test(${OUT6})`, 5000);
  const silent = await ev(`({ out: ${OUT6}, running: sagebrush.notebook.cells()[0].el.classList.contains('running') })`);
  ok(/^start\s+begin\s*$/.test(silent.out) && silent.running, `a silent computation shows what was printed before it while it runs (${Date.now() - ts6} ms): ` + JSON.stringify(silent));
  await until("window.__ran6 === true", 8000);
  ok(/^start\s+begin\s+end\s*$/.test(await ev(OUT6)), "and ends with all of it");
} catch (e) {
  ok(false, String(e?.stack ?? e));
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
