// ci: web-browser/notebook order=81
// A Run in the reactive notebook runs what the cell needs first, in headless Chromium on the full page (web/dist):
//   - a cell typed and never run that the cell reads runs first (Python and Sage: a = 10, then print(a+1));
//   - said over the cell while it runs ("Running 1 cell this needs…");
//   - through a chain; a never-run cell it doesn't need stays as it is;
//   - a cell it needs that last took over 10 s is asked about first, in the cell: Not now runs nothing, Run it runs;
//   - where the dependencies the analyzer sees miss the definition (exec): the NameError offers the cell that defines
//     the name, and its button runs that cell and this one again;
//   - a name several cells define (a helper pasted twice with IPython magics, data defined again between uses):
//     nothing refused; each use reads its nearest definition above, as a run from the top; rerunning a definition
//     reruns only the uses that read it;
//   - the classic notebook (?reactive=0) runs only the cell, as Jupyter does.
//   bun web/build.ts && python3 web/serve.py 8765 &  node web/test-reactive-upstream.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
import { allowFiles } from "./test-allow.mjs";
const base = (process.env.SB_URL ?? "http://127.0.0.1:8765/") + "?reactive";
let port = Number(process.env.CDP_PORT) || 0; // (CDP_PORT: several agents' runs do not collide)
const profile = mkdtempSync(join(tmpdir(), "sb-reactive-"));
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
const ready = "window.sagebrush && document.querySelectorAll('#cells .cell').length > 0 && sagebrush.kernel?.ready";
const out = (i) => ev(`sagebrush.notebook.cells()[${i}].out.textContent.trim()`);
const has = (i, cls) => ev(`sagebrush.notebook.cells()[${i}].el.classList.contains(${JSON.stringify(cls)})`);
// set cells' code (adding cells as needed), without running
const set = (codes) => ev(`(() => { const nb = sagebrush.notebook; const cs = ${JSON.stringify(codes)}; for (let i = 0; i < cs.length; i++) { if (cs[i] === null) continue; while (nb.cells().length <= i) nb.addCell(''); nb.setInput(nb.cells()[i], cs[i]); } return true; })()`);
// run a cell (or several, as one action: an array); resolves to the run's report (ids as cell numbers)
const run = (i) => ev(`(async () => { const nb = sagebrush.notebook, ids = nb.cells().map((c) => c.id); const r = await ${Array.isArray(i) ? `nb.runCells(${JSON.stringify(i)}.map((j) => ids[j]))` : `nb.run(nb.cells()[${i}])`}; const k = (id) => ids.indexOf(id); return r && { ran: r.ran.map(k), stale: r.stale.map(k).sort(), failed: r.failed.map(k), cancelled: r.cancelled.map(k), errors: Object.keys(r.errors).map(k).sort() }; })()`);
const fileNew = async () => {
  const k = await ev("sagebrush.kernel.uid");
  await ev(`document.querySelector('#filebtn').click(); document.querySelector('[data-f="new"]').click(); true`);
  await until(`sagebrush.kernel.uid !== ${k} && sagebrush.kernel.ready`, 15000);
  await sleep(300);
  await allowFiles(send, ev); // (some cells write files the others read: the person allows it, as a person does)
};
// (the person's next Run after allowing, which applies the widening: a new interpreter (confinement phase 2); for a case
// that puts something into the interpreter itself, so it goes into that one)
const widen = async () => {
  await ev("(window.__fnW = sagebrush.kernel.worker, 1)");
  await ev("sagebrush.notebook.run(sagebrush.notebook.cells()[0]).then(() => 1)");
  await until("sagebrush.kernel.ready && sagebrush.kernel.worker !== window.__fnW", 15000);
};
const cellsN = (k) => ev(`sagebrush.notebook.cells().length`);
const fresh = async (mode, codes) => { await fileNew(); await ev(`sagebrush.notebook.setMode(${JSON.stringify(mode)}); true`); await set(codes); await sleep(300); };
try {
  await send("Page.navigate", { url: base });
  await until(ready);

  // his case: a = 10 typed, never run; print(a+1) run
  for (const mode of ["python", "sage"]) {
    await fresh(mode, ["a = 10", "print(a+1)"]);
    const r = await run(1);
    ok((await out(1)) === "11" && JSON.stringify(r?.ran) === "[0,1]" && !(await has(0, "stale")), `${mode}: a cell typed and never run that the cell reads runs first (${JSON.stringify([await out(1), r])})`);
  }
  // said while it runs, over the cell, and gone after
  await fresh("python", ["import time\ntime.sleep(1.5)\nb = 3", "print(b)"]);
  await ev("(window.__p = sagebrush.notebook.run(sagebrush.notebook.cells()[1]), 1)");
  const said = await until("sagebrush.notebook.cells()[1].el.querySelector('.upstream')?.textContent === 'Running 1 cell this needs…'", 10000).catch(() => false);
  await ev("window.__p.then(() => 1)");
  ok(said && (await out(1)) === "3" && !(await ev("!!sagebrush.notebook.cells()[1].el.querySelector('.upstream')")), `said while it runs ("Running 1 cell this needs…"), gone after (${JSON.stringify(await out(1))})`);
  // a chain, and a never-run cell not needed
  await fresh("python", ["x = 2", "print('UNRELATED')", "y = x * 3", "print(y + 1)"]);
  const rc = await run(3);
  ok((await out(3)) === "7" && JSON.stringify(rc?.ran) === "[0,2,3]", `through a chain: x, then y, then the cell (${JSON.stringify([await out(3), rc])})`);
  ok((await out(1)) === "" && !JSON.stringify(rc?.ran).includes("1"), `a never-run cell the cell doesn't need doesn't run (${JSON.stringify(await out(1))})`);

  // a slow one it needs: asked first, in the cell
  await fresh("python", ["a = 5", "print(a)"]);
  await run(1);
  await ev("sagebrush.kernel.restart(); true");
  await until("sagebrush.kernel.ready", 15000);
  await until("sagebrush.notebook.cells()[0].el.classList.contains('stale')", 10000);
  await ev("(sagebrush.notebook.reactive.times.set(sagebrush.notebook.cells()[0].id, 40000), 1)");
  await ev("(sagebrush.notebook.cells()[1].out.replaceChildren(), window.__p = sagebrush.notebook.run(sagebrush.notebook.cells()[1]), 1)");
  await until("!!sagebrush.notebook.cells()[1].el.querySelector('.upstream.fixes')", 10000);
  const ask = await ev("sagebrush.notebook.cells()[1].el.querySelector('.upstream.fixes').textContent");
  ok(ask === "This needs 1 earlier cell; it took 40 s. Run it? Run itNot now", `a cell it needs that took over 10 s: asked first (${JSON.stringify(ask)})`);
  await ev("([...sagebrush.notebook.cells()[1].el.querySelectorAll('.upstream.fixes button')].find((b) => b.textContent === 'Not now').click(), window.__p).then(() => 1)");
  ok((await out(1)) === "" && (await has(0, "stale")) && !(await ev("!!sagebrush.notebook.cells()[1].el.querySelector('.upstream')")), `Not now: nothing runs, the ask goes (${JSON.stringify(await out(1))})`);
  await ev("(window.__p = sagebrush.notebook.run(sagebrush.notebook.cells()[1]), 1)");
  await until("!!sagebrush.notebook.cells()[1].el.querySelector('.upstream.fixes')", 10000);
  await ev("([...sagebrush.notebook.cells()[1].el.querySelectorAll('.upstream.fixes button')].find((b) => b.textContent === 'Run it').click(), window.__p).then(() => 1)");
  ok((await out(1)) === "5" && !(await has(0, "stale")), `Run it: the cell it needs runs, then this one (${JSON.stringify(await out(1))})`);

  // the analyzer can't see exec's definition: the NameError offers the cell that defines it
  await fresh("python", ["exec('q = 5')", "print(q)"]);
  await run(1);
  await until("!!sagebrush.notebook.cells()[1].out.querySelector('.definer button')", 10000).catch(() => {});
  const fb = await ev("sagebrush.notebook.cells()[1].out.querySelector('.definer button')?.textContent ?? null");
  ok(/NameError: name 'q' is not defined/.test(await out(1)) && fb === "Run the cell that defines q", `a NameError for a name exec defines: offers that cell (${JSON.stringify(fb)})`);
  await ev("sagebrush.notebook.cells()[1].out.querySelector('.definer button').click(), 1");
  await until("sagebrush.notebook.cells()[1].out.textContent.trim() === '5'", 15000).catch(() => {});
  ok((await out(1)) === "5", `its button runs that cell, then this one (${JSON.stringify(await out(1))})`);

  // a name several cells define, as a run from the top reads it: each use, its nearest definition above. A helper
  // pasted twice with IPython's magic lines (the same code, then different), the data defined again between uses
  const H = "%reload_ext autoreload\n%autoreload 2\nimport math\ndef helper(p, e):\n    return len(p) * 10 + len(e)";
  const twice = [H, "vals = [1, 2]\nitems = [3]\nprint(helper(vals, items))", H, "vals = []\nitems = []\nprint(helper(vals, items))", "%reload_ext autoreload\ndef helper(p, e):\n    return -1", "print(helper(vals, items), vals)"];
  await fresh("python", twice);
  await ev("sagebrush.notebook.runAll().then(() => 1)");
  const all = await ev("sagebrush.notebook.cells().map((c) => c.out.textContent.trim())");
  const errs = await ev("sagebrush.notebook.cells().filter((c) => c.el.classList.contains('error')).length");
  ok(errs === 0 && JSON.stringify(all) === JSON.stringify(["", "21", "", "0", "", "-1 []"]), `defined in several cells: no cell refused, each use reads its nearest definition above, as Run all from the top (${JSON.stringify([errs, all])})`);
  await fresh("python", twice);
  const r5 = await run(5);
  ok((await out(5)) === "-1 []" && JSON.stringify(r5?.ran) === "[2,3,4,5]", `a Run of the last use runs the definitions it reads, not the earlier ones (${JSON.stringify([await out(5), r5])})`);
  await ev("sagebrush.notebook.runAll().then(() => 1)");
  await set([H.replace("* 10", "* 100")]);
  const r0 = await run(0);
  ok(JSON.stringify(r0?.ran) === "[0,1]" && (await out(1)) === "201" && (await out(3)) === "0" && (await out(5)) === "-1 []", `a definition run again reruns only the uses that read it (${JSON.stringify([r0, await out(1), await out(3), await out(5)])})`);

  // the classic notebook: only the cell
  await send("Page.navigate", { url: base.replace("?reactive", "?reactive=0") });
  await until(ready);
  await fresh("python", ["a = 10", "print(a+1)"]);
  await ev("sagebrush.notebook.run(sagebrush.notebook.cells()[1]).then(() => 1)");
  await until("/NameError|11/.test(sagebrush.notebook.cells()[1].out.textContent)", 15000).catch(() => {});
  ok(/NameError: name 'a' is not defined/.test(await out(1)) && !(await ev("!!sagebrush.notebook.cells()[1].out.querySelector('.definer')")), `the classic notebook runs only the cell, as Jupyter does (${JSON.stringify((await out(1)).slice(-60))})`);
  await send("Page.navigate", { url: base });
} catch (e) {
  ok(false, "threw: " + String(e?.stack ?? e).slice(0, 400));
} finally {
  chrome.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
console.log(process.exitCode ? "FAIL: a run's upstream" : "ok: a run's upstream");
