// The reactive notebook (design/reactive-notebook.md) on the full page in
// headless Chromium, with ?reactive: running a cell reruns what depends on
// it, in graph order; definitions below their use; a removed definition
// disappears; errors (multiple definitions, cycles) on the cells; an
// exception stops the cells below it; the budget leaves slow cells stale;
// deleting a cell; Sage mode; edited cells; a reload.  Serve web/dist first:
//   bun web/build.ts && bash web/run-tests.sh reactive
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const base = (process.env.SB_URL ?? "http://127.0.0.1:8765/") + "?reactive";
const port = 9351;
const profile = mkdtempSync(join(tmpdir(), "sb-reactive-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1000,700", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 100; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
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
};
try {
  await send("Page.navigate", { url: base });
  await until(ready);
  await fileNew();
  ok(await ev("!!sagebrush.notebook.reactive"), "?reactive turns the reactive notebook on");
  await ev("sagebrush.notebook.setBudget(Infinity); true");

  // a chain, with a definition below its use
  await set(["a = 1\nprint('A', a)", "print('C', c)", "c = a + 1\nprint('B', c)"]);
  ok(await has(2, "edited"), "a cell with code that never ran is marked");
  let r = await run([0, 1, 2]);
  ok(JSON.stringify(r?.ran) === "[0,2,1]", `running cells as one action runs them in graph order: a definition below its use first (${JSON.stringify(r?.ran)})`);
  ok((await out(1)) === "C 2" && (await out(2)) === "B 2", "...with the values flowing through");
  r = await run(0);
  ok(JSON.stringify(r?.ran) === "[0,2,1]", `running cell 1 runs what depends on it (${JSON.stringify(r?.ran)})`);
  await set(["a = 10\nprint('A', a)"]);
  ok(await has(0, "edited"), "an edited cell is marked until it runs");
  r = await run(0);
  ok((await out(1)) === "C 11" && !(await has(0, "edited")), "editing and running cell 1 updates the cells below (C 11)");

  // a definition removed from the code disappears
  await set([null, null, null, "z = 5", "print(z)"]);
  await run([3, 4]);
  ok((await out(4)) === "5", "a new cell's dependents run (z)");
  await set([null, null, null, "pass"]);
  r = await run(3);
  ok(/NameError/.test(await out(4)), `removing z's definition reruns its reader, which fails: ${await out(4)}`);

  // multiple definitions: the new cell has the error; the old one keeps working
  await set([null, null, null, "a = 5"]);
  r = await run(3);
  ok(JSON.stringify(r?.errors) === "[3]" && /a is also defined by cell 1/.test(await out(3)), `a second definition is an error on the new cell: ${await out(3)}`);
  ok((await out(1)) === "C 11" && !(await has(0, "error")), `...not on the first (no action at a distance): ${await out(1)} ${await has(0, "error")}`);
  await set([null, null, null, "a2 = 5"]);
  r = await run(3);
  ok(JSON.stringify(r?.errors) === "[]" && !(await has(3, "error")), "renaming it clears the error");

  // an exception stops the cells that depend on it
  await set([null, null, "c = a + 1\nprint('B', c)\n1/0"]);
  r = await run(2);
  ok(JSON.stringify(r?.failed) === "[2]" && JSON.stringify(r?.cancelled) === "[1]", `an exception cancels the dependents (${JSON.stringify(r)})`);
  ok(/Not run: cell 3, which this cell depends on, raised an error/.test(await out(1)), `...which say why: ${await out(1)}`);
  await set([null, null, "c = a + 1\nprint('B', c)"]);
  await run(2);
  ok((await out(1)) === "C 11" && !(await has(1, "cancelled")), "fixing it runs them again");

  // a cycle
  await set([null, null, null, null, "p = q", "q = p"]);
  r = await run([4, 5]);
  ok(JSON.stringify(r?.errors) === "[4,5]" && /cycle/.test(await out(5)), `a cycle is an error on its cells: ${await out(5)}`);
  await set([null, null, null, null, "p = 1", "q = p"]);
  r = await run(4);
  ok(JSON.stringify(r?.errors) === "[]" && JSON.stringify(r?.ran) === "[4,5]", `breaking it runs both (${JSON.stringify(r)})`);

  // the budget: a slow cell below waits, stale
  await ev("sagebrush.notebook.setBudget(300); true");
  await set([null, null, null, null, null, "import time\ntime.sleep(0.6)\nq = p\nprint('slow', q)"]);
  await run(5);
  r = await run(4);
  ok(JSON.stringify(r?.ran) === "[4]" && JSON.stringify(r?.stale) === "[5]", `with a 300 ms budget, a 600 ms dependent is left stale (${JSON.stringify(r)})`);
  ok((await has(5, "stale")) && /stale: not rerun automatically \(it takes about \d+ ms\)/.test(await ev("sagebrush.notebook.cells()[5].time.textContent")), "...and says so");
  ok((await out(5)) === "slow 1", "...showing its last output");
  await ev("sagebrush.notebook.setBudget(Infinity); true");

  // deleting a cell deletes its names; its readers rerun
  await ev(`(() => { const nb = sagebrush.notebook, c = nb.cells()[4]; c.el.querySelector('[data-a="del"]').click(); return true; })()`);
  await until(`/NameError/.test(sagebrush.notebook.cells()[4].out.textContent)`, 10000);
  ok(true, "deleting cell 5 (p) reruns its reader, which fails with NameError");

  // #1477: two cells may define a name nobody reads
  await fileNew();
  await set(["for i in range(3):\n    pass", "for i in range(5):\n    pass"]);
  await run(0);
  r = await run(1);
  ok(JSON.stringify(r?.errors) === "[]", "two cells may define a name no cell reads (for i in ...)");

  // `_` names are the cell's own (marimo's renaming)
  await fileNew();
  await set(["_t = 5\nprint(_t)", "print(_t)", "_h = 3\ndef f():\n    return _h + 1", "print(f())"]);
  r = await run([0, 1, 2, 3]);
  ok((await out(0)) === "5" && /NameError: name '_t' is not defined/.test(await out(1)), `a cell's _t is its own: another cell does not see it (${(await out(1)).split("\n").pop()})`);
  ok((await out(3)) === "4", `a function keeps its cell's _h (f() = ${await out(3)})`);
  await set(["_t = 6\nprint(_t)"]);
  await run(0);
  ok((await out(0)) === "6" && (await ev("(async () => 1)()")) === 1, "rerunning it");

  // Sage mode
  await fileNew();
  await ev("sagebrush.notebook.setMode('sage'); true");
  await set(["R.<x> = QQ[]", "f = x^2 - 1\nprint(f.factor())"]);
  await run([0, 1]);
  ok((await out(1)) === "(x - 1) * (x + 1)", `Sage: R.<x> = QQ[] defines x for the cell below (${await out(1)})`);
  await set(["var('y')", "print((y^2).diff(y))"]);
  await run([0, 1]);
  ok((await out(1)) === "2*y", `Sage: var('y') defines y (${await out(1)})`);

  // a reload: the outputs are shown, stale; running a cell runs its stale ancestors
  await ev("sagebrush.notebook.setMode('python'); true");
  await set(["u = 2", "v = u * 3", "print(v)"]);
  await run([0, 1, 2]);
  ok((await out(2)) === "6", "u, v, print(v)");
  await ev("sagebrush.notebook.flush(); true");
  await sleep(500);
  await send("Page.reload");
  await until(ready);
  await until(`sagebrush.notebook.cells().length >= 3 && sagebrush.notebook.cells()[2].el.classList.contains('stale')`, 10000);
  ok((await out(2)) === "6", "after a reload, the outputs are shown, stale");
  r = await run(2);
  ok(JSON.stringify(r?.ran) === "[0,1,2]" && (await out(2)) === "6", `running the last cell first runs its stale ancestors (${JSON.stringify(r?.ran)})`);
} catch (e) {
  ok(false, String(e?.stack ?? e));
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
