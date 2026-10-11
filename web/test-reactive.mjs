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

  // agents: a batch of edits run once; the graph; mutation tracking; verify finds hidden state
  await fileNew();
  let e = await ev(`(async () => { const nb = sagebrush.notebook; const first = nb.cells()[0].id; const r = await nb.applyEdits({ set: [{ id: first, code: "v = [1, 2, 3]" }], insert: [{ code: "v.append(4)" }, { code: "print(len(v))" }, { code: "# notes", type: "markdown" }] }, { budget: Infinity }); return { ...r, first }; })()`);
  ok(e.ids.length === 3 && e.report.ran.length === 3 && e.outputs[e.ids[1]] === "4\n", `edit: three changes, one run (${JSON.stringify(e.report.ran.length)} cells ran; len(v) = ${JSON.stringify(e.outputs[e.ids[1]])})`);
  const g = await ev("sagebrush.notebook.graph()");
  ok(g.length === 3 && JSON.stringify(g[0].defines) === '["v"]' && JSON.stringify(g[1].mutates) === '["v"]' && JSON.stringify(g[2].reads) === '["v"]' && g[2].parents.length === 2 && g.every((c) => c.state === "ok"), `graph: ${JSON.stringify(g.map((c) => [c.defines, c.reads, c.mutates ?? [], c.parents.length, c.state]))}`);
  r = await run(1);
  ok(JSON.stringify(r?.ran) === "[0,1,2]" && (await out(2)) === "4", `running the append again reruns v's definer first, so it never appends twice; the reader follows (${JSON.stringify(r?.ran)}, len(v) = ${await out(2)})`);
  // an alias (w = v) hides a mutation from the analysis: verify finds it
  e = await ev(`(async () => { const r = await sagebrush.notebook.applyEdits({ insert: [{ code: "w = v" }, { code: "w.append(9)" }] }, { budget: Infinity }); return r.report.ran.length; })()`);
  await run(4);
  await run(2);
  ok((await out(2)) === "6", `appending through the alias, by hand, twice: len(v) = ${await out(2)}`);
  const v = await ev("sagebrush.notebook.verify().then((r) => ({ same: r.same.length, changed: r.changed.map((c) => [c.before.trim(), c.after.trim()]) }))");
  ok(JSON.stringify(v.changed) === '[["6","4"]]', `verify recomputes from scratch and finds the cell that differs (${JSON.stringify(v)})`);
  e = await ev(`(async () => { const nb = sagebrush.notebook; const ids = nb.cells().map((c) => c.id); const r = await nb.applyEdits({ remove: [ids[1]] }); return r.report; })()`);
  ok((await out(1)) === "3", `edit: removing the append (an updater) reruns v's definer and the reader (len(v) = ${await out(1)})`);

  // files: a cell writing a file runs before the cells reading it, which rerun when it changes
  await fileNew();
  await set(["k = 3", "with open('data.txt', 'w') as f:\n    f.write('x' * k)", "print(len(open('data.txt').read()))"]);
  await run([0, 1, 2]);
  ok((await out(2)) === "3", "a cell reads the file another wrote");
  r = await run(0);
  ok(JSON.stringify(r?.ran) === "[0,1,2]" && (await out(2)) === "3", `the reader depends on the writer through the file (${JSON.stringify(r?.ran)})`);
  await set(["k = 5"]);
  await run(0);
  ok((await out(2)) === "5", `changing what is written reruns the reader (${await out(2)})`);
  const g2 = await ev("sagebrush.notebook.graph()");
  ok(g2[2].parents.includes(g2[1].id), "the graph has the file edge");
  await ev("sagebrush.kernel.post({ fsPut: '/data.txt', data: new TextEncoder().encode('abcdefg') }); true");
  r = await ev("sagebrush.notebook.filesChanged(['/data.txt']).then((r) => r.ran.length)");
  ok(r === 1 && (await out(2)) === "7", `a file changed outside (an upload) reruns its readers (${await out(2)})`);

  // the controls: the auto-run time (kept in the notebook), Run stale, manual cells
  await fileNew();
  ok(!(await ev("document.querySelector('#autorun').hidden")), "the auto-run control shows");
  await ev("(() => { const a = document.querySelector('#autorun'); a.value = 'never'; a.dispatchEvent(new Event('change')); return true; })()");
  ok((await ev("sagebrush.notebook.budget")) === 0 && (await ev("sagebrush.notebook.meta.autorun")) === "never", "Auto-run: never sets the budget to 0, kept in the notebook");
  await set(["m = 2", "print(m * 10)"]);
  await run([0, 1]);
  await set(["m = 3"]);
  await run(0);
  await sleep(100);
  ok((await has(1, "stale")) && /Run stale \(1/.test(await ev("document.querySelector('#runstale').textContent")) && !(await ev("document.querySelector('#runstale').hidden")), `with auto-run off, the dependent is stale and Run stale offers it (${await ev("document.querySelector('#runstale').textContent")})`);
  await ev("document.querySelector('#runstale').click(); true");
  await until("sagebrush.notebook.cells()[1].out.textContent.trim() === '30'", 10000);
  ok(!(await has(1, "stale")) && (await ev("document.querySelector('#runstale').hidden")), "Run stale runs it");
  await ev("(() => { const a = document.querySelector('#autorun'); a.value = 'always'; a.dispatchEvent(new Event('change')); return true; })()");
  await ev(`(() => { const c = sagebrush.notebook.cells()[1]; c.menuBtn.click(); document.querySelector('.sbnb-menu [data-m="manual"]').click(); return true; })()`);
  ok((await has(1, "manual")) && (await ev("sagebrush.notebook.cells()[1].metadata?.sagebrush?.manual")) === true, "the cell menu makes a cell manual (in its metadata)");
  await set(["m = 4"]);
  r = await run(0);
  ok(JSON.stringify(r?.stale) === "[1]" && (await out(1)) === "30", `a manual cell is not rerun automatically, even with auto-run always (${JSON.stringify(r)})`);

  // widgets are inputs: moving a slider reruns the cells that read it
  await fileNew();
  await set(["from ipywidgets import IntSlider\nn = IntSlider(5, 1, 10, description='n')\nn", "print(n.value ** 2)"]);
  await run([0, 1]);
  ok((await out(1)) === "25", "a cell reads a slider's value (25)");
  await ev(`(async () => { const nb = sagebrush.notebook; const key = nb.cells()[0].out.querySelector('.interact').dataset.key; await nb.setInteract(key, { _w0: 7 }); return true; })()`);
  await until(`sagebrush.notebook.cells()[1].out.textContent.trim() === '49'`, 10000);
  ok((await ev("sagebrush.notebook.cells()[0].out.querySelectorAll('.interact input[type=range]').length")) === 1, "moving the slider reruns the cell reading it (49), not the one showing it");

  // a Jupyter-style notebook (x redefined): the fix renames the later definitions, in page order
  await fileNew();
  await set(["x = 1", "print(x)", "x = x + 1", "print(x * 100)"]);
  r = await run([0, 1, 2, 3]);
  ok(JSON.stringify(r?.errors) === "[0,1,2,3]", `x defined by two cells and read: errors (${JSON.stringify(r?.errors)})`);
  ok(await ev("!!sagebrush.notebook.cells()[2].out.querySelector('.fixes button')"), "the error offers a fix");
  await ev("sagebrush.notebook.cells()[2].out.querySelector('.fixes button').click(); true");
  await until("sagebrush.notebook.cells()[3].out.textContent.trim() === '200'", 15000);
  const codes = await ev("sagebrush.notebook.cells().map((c) => c.ta.value)");
  ok(JSON.stringify(codes) === JSON.stringify(["x = 1", "print(x)", "x_2 = x + 1", "print(x_2 * 100)"]) && (await out(1)) === "1", `the fix keeps the notebook's meaning in page order (${JSON.stringify(codes)})`);
  ok(JSON.stringify(await ev("sagebrush.notebook.graph().map((c) => c.state)")) === '["ok","ok","ok","ok"]', "...and every cell runs");

  // per-cell seeds: a cell draws the same random numbers however often it runs; verify agrees
  await fileNew();
  await set(["import random\nimport numpy as np\nprint(random.random(), np.random.rand())", "x = random.randint(1, 10**9)\nprint(x)"]);
  await run([0, 1]);
  const r1 = [await out(0), await out(1)];
  await run(1);
  await run(0);
  const r2 = [await out(0), await out(1)];
  ok(r1[0] === r2[0] && r1[1] === r2[1] && /^0\.\d+ 0\.\d+$/.test(r1[0]), `a cell's random numbers are the same on every run (${r1.join(" | ")})`);
  const vs = await ev("sagebrush.notebook.verify().then((r) => r.changed.length)");
  ok(vs === 0, `...and in a fresh interpreter: verify finds no difference (${vs})`);
  ok(/^[0-9a-f]{64}$/.test(await ev("sagebrush.notebook.meta.seed")), "the notebook's seed is in its document");

  // TimeTravel: resuming a version recomputes it (the same random numbers: per-cell seeds)
  await fileNew();
  await set(["import random\nr = random.random()", "with open('f.txt', 'w') as f:\n    f.write(str(r))", "print(open('f.txt').read()[:8])"]);
  await run([0, 1, 2]);
  const x0 = await out(2);
  await ev("sagebrush.notebook.flush(); true");
  await sleep(1200);
  await set(["r = 5"]);
  await run(0);
  ok((await out(2)) === "5", "after the edit, the file holds 5");
  await ev("sagebrush.notebook.flush(); true");
  await sleep(1200);
  const target = await ev(`(() => { const h = sagebrush.history; const vs = h.versions(); const v = [...vs].reverse().find((v) => /random\.random/.test(h.docAt(v.time).cells[0]?.code ?? "")); return v ? { time: v.time, id: localStorage.getItem('sagebrush-current') } : null; })()`);
  ok(!!target, "TimeTravel has the version before the edit");
  await send("Page.navigate", { url: base.replace("?reactive", "") + `?reactive&resume=${encodeURIComponent(target.id)}&at=${encodeURIComponent(target.time)}` });
  await until("window.sagebrush?.replayReport", 30000);
  const rep = await ev("sagebrush.replayReport");
  ok(rep.recomputed && rep.ran.length === 3 && (await out(2)) === x0, `resuming recomputes the version: the same random number through the file (${await out(2)} = ${x0}; ${await ev("document.querySelector('#status').textContent")})`);
  await until(ready);

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
  ok(await ev("location.search === '?reactive'"), "after resuming, the address keeps ?reactive");
  await send("Page.reload");
  await until(ready);
  await until(`sagebrush.notebook.cells().length >= 3 && sagebrush.notebook.cells()[2].el.classList.contains('stale')`, 10000);
  ok((await out(2)) === "6", "after a reload, the outputs are shown, stale");
  const before = JSON.stringify(await ev("sagebrush.notebook.graph().map((c) => [c.state, c.reads, c.defines])"));
  r = await run(2);
  ok(JSON.stringify(r?.ran) === "[0,1,2]" && (await out(2)) === "6", `running the last cell first runs its stale ancestors (${JSON.stringify(r?.ran)}; before: ${before}; ${await out(2)})`);
} catch (e) {
  ok(false, String(e?.stack ?? e));
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
