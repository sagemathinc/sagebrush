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
const port = Number(process.env.CDP_PORT ?? 9351); // (CDP_PORT: several agents' runs do not collide)
const profile = mkdtempSync(join(tmpdir(), "sb-reactive-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1000,700", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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

  // a second definition (page-order scoping): no error; the cells above it still read the first, those below it the second
  await set([null, null, null, "a = 5\nprint('A2', a)", "print('D', a)"]);
  r = await run([3, 4]);
  ok(JSON.stringify(r?.errors) === "[]" && (await out(3)) === "A2 5" && (await out(4)) === "D 5" && (await out(1)) === "C 11", `a second definition of a: no error; the cell below it reads it (D 5), the cells above the first (C 11): ${JSON.stringify(r)}`);
  await set(["a = 20\nprint('A', a)"]);
  r = await run(0);
  ok((await out(1)) === "C 21" && (await out(4)) === "D 5" && !r.ran.includes(await ev("sagebrush.notebook.cells()[4].id")), `editing the first definition reruns only the cells reading it (C 21, D still 5): ${JSON.stringify(r.ran.length)}`);
  ok(JSON.stringify(await ev("sagebrush.notebook.graph()[3].defines")) === '["a"]', "the graph shows names as written (a, not a\u02b92)");
  await set(["a = 10\nprint('A', a)", null, null, "a2 = 5", "pass"]);
  await run([0, 3, 4]);

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
  ok(JSON.stringify(r?.ran) === "[4]" && JSON.stringify(r?.stale) === "[5]", `with a 300 ms budget, a 600 ms dependent is left stale (${JSON.stringify(r)}; ${await out(5)})`);
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

  // IPython's magics: %timeit's assignments are its own, not a second
  // definition of x; %time sees the cell's own _ names
  await fileNew();
  await set(["x = 5", "%timeit -n 1 -r 1 x = 7", "print(x)", "_x = 3\n%time _x + 1"]);
  r = await run([0, 1, 2, 3]);
  ok(JSON.stringify(r?.errors) === "[]" && (await out(2)) === "5", `%timeit x = 7 does not define x: print(x) is 5 (${JSON.stringify(r?.errors)}, ${await out(2)})`);
  ok(/^Wall time: .*4$/s.test(await out(3)), `%time _x + 1 reads the cell's _x (${JSON.stringify(await out(3))})`);

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
  await until("!document.querySelector('#runstale').hidden", 5000).catch(() => {});
  ok((await has(1, "stale")) && /^Run 1 stale/.test(await ev("document.querySelector('#runstale').textContent")) && !(await ev("document.querySelector('#runstale').hidden")), `with auto-run off, the dependent is stale and Run stale offers it (${await ev("document.querySelector('#runstale').textContent")})`);
  await ev("document.querySelector('#runstale').click(); true");
  // (the button updates on the next frame)
  await until("sagebrush.notebook.cells()[1].out.textContent.trim() === '30' && !sagebrush.notebook.cells()[1].el.classList.contains('stale') && document.querySelector('#runstale').hidden", 10000);
  ok(true, "Run stale runs it");
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

  // a Jupyter-style notebook (x redefined): page-order scoping keeps its meaning, with no errors
  await fileNew();
  await set(["x = 1", "print(x)", "x = x + 1", "print(x * 100)"]);
  r = await run([0, 1, 2, 3]);
  ok(JSON.stringify(r?.errors) === "[]" && (await out(1)) === "1" && (await out(3)) === "200", `x = 1 ... x = x + 1: each cell reads the definition above it (1, 200): ${JSON.stringify(r)}`);
  ok(JSON.stringify(await ev("sagebrush.notebook.cells().map((c) => c.ta.value)")) === JSON.stringify(["x = 1", "print(x)", "x = x + 1", "print(x * 100)"]) && !(await has(2, "edited")), "the page shows the code as written (not edited)");
  await set([null, null, null, "del x\nprint(x)"]);
  await run(3);
  ok(/NameError: name 'x' is not defined/.test(await out(3)) && !/\u02b9/.test(await out(3)), `errors name x as written: ${(await out(3)).split("\n").pop()}`);
  // Sage: R.<x>, then x = var('x'), then var('x') alone, in later cells
  await fileNew();
  await ev("sagebrush.notebook.setMode('sage'); true");
  await set(["R.<x> = QQ[]", "print((x^2 - 1).factor())", "x = var('x')\nprint(solve(x^2 == 4, x))", "print(diff(sin(x), x))", "var('x')\nprint(integrate(x, x))", "print((x^3).diff(x))"]);
  r = await run([0, 1, 2, 3, 4, 5]);
  const sg = [await out(1), await out(2), await out(3), await out(4), await out(5)];
  ok(JSON.stringify(r?.errors) === "[]" && JSON.stringify(sg) === JSON.stringify(["(x - 1) * (x + 1)", "[x == -2, x == 2]", "cos(x)", "1/2*x^2", "3*x^2"]), `Sage's x redefined cell by cell: ${JSON.stringify(sg)}`);
  await set(["R.<x> = ZZ[]"]);
  r = await run(0);
  ok((await out(1)) === "(x - 1) * (x + 1)" && r.ran.length === 2, `editing the first x reruns only the cell reading it (${r.ran.length} ran)`);
  // K.<a> = NumberField(...) twice (the preparser writes K twice on that line), then K read below
  await fileNew();
  await ev("sagebrush.notebook.setMode('sage'); true");
  await set(["R.<x> = QQ[]", "K.<a> = NumberField(x^3 - 11)\nK.degree()", "K.<a> = NumberField(x^7 - 11)\nK.degree(), a^7", "K", "a^2"]);
  r = await run([0, 1, 2, 3, 4]);
  const kf = [await out(1), await out(2), await out(3), await out(4)];
  ok(JSON.stringify(r?.errors) === "[]" && JSON.stringify(kf) === JSON.stringify(["3", "(7, 11)", "Number Field in a with defining polynomial x^7 - 11", "a^2"]), `K.<a> defined twice: the cells below read the second, named a as written: ${JSON.stringify(kf)}`);

  // review findings (sagebrush-codex, REACT-F1..F3)
  await fileNew();
  await set(["v = []", "x = 1", "v.append(x)", "print(v)", "α = 7", "print(α)"]);
  await run([0, 1, 2, 3, 4, 5]);
  await set([null, "x = 2"]);
  await run(1);
  // (the reader's output may arrive just after the run's report: waited for, up to 10 s)
  await until(`sagebrush.notebook.cells()[3].out.textContent.trim() !== "[1]"`, 10000).catch(() => {});
  ok((await out(3)) === "[2]", `F2: an updater reached automatically runs with its definer: v is [2], not [1, 2] (${await out(3)})`);
  await set([null, null, null, null, "pass"]);
  await run(4);
  ok(/NameError: name 'α' is not defined/.test(await out(5)), `F3: a removed definition with a non-ASCII name is gone (${(await out(5)).split("\n").pop()})`);
  // F1: a run whose worker fails, or whose kernel is closed, settles; the next action runs
  await set([null, null, null, null, null, "while True:\n    pass"]);
  const settled = await ev(`(async () => {
    const nb = sagebrush.notebook, k = sagebrush.kernel, ids = nb.cells().map((c) => c.id);
    const p = nb.runCells([ids[5]], { budget: Infinity });
    for (let i = 0; i < 100 && !nb.cells()[5].el.classList.contains("running"); i++) await new Promise((r) => setTimeout(r, 50));
    k.worker.onerror({ message: "injected" });
    const a = await Promise.race([p.then(() => "settled"), new Promise((r) => setTimeout(() => r("hung"), 10000))]);
    for (let i = 0; i < 100 && !k.ready; i++) await new Promise((r) => setTimeout(r, 100));
    const b = await Promise.race([nb.runCells([ids[1]]).then(() => "ran"), new Promise((r) => setTimeout(() => r("hung"), 10000))]);
    const p2 = nb.runCells([ids[5]], { budget: Infinity });
    for (let i = 0; i < 100 && !nb.cells()[5].el.classList.contains("running"); i++) await new Promise((r) => setTimeout(r, 50));
    k.close();
    const c = await Promise.race([p2.then(() => "settled"), new Promise((r) => setTimeout(() => r("hung"), 10000))]);
    return [a, b, c];
  })()`);
  ok(JSON.stringify(settled) === '["settled","ran","settled"]', `F1: a worker error or a closed kernel settles the run, and the next action runs (${JSON.stringify(settled)})`);
  await ev("sagebrush.kernel.restart(); true");
  await until("sagebrush.kernel.ready", 15000);

  // F9: the same numbers on a cell's first run and its rerun (numpy imported before random); os.urandom stays random
  await fileNew();
  await set(["import numpy as np\nimport random\nprint(np.random.random(), random.random(), np.random.default_rng().random())", "import os\nprint(os.urandom(8).hex())"]);
  await run([0, 1]);
  const f9a = [await out(0), await out(1)];
  await run(0);
  await run(1);
  const f9b = [await out(0), await out(1)];
  ok(f9a[0] === f9b[0] && f9a[1] !== f9b[1], `F9: a cell's random, numpy.random and default_rng() numbers are the same on its first run and its rerun; os.urandom is not (${f9a[0]} | ${f9a[1]} vs ${f9b[1]})`);
  // F8: a reader that ran before the writer (the file edge discovered by running) is rerun
  await fileNew();
  await ev("sagebrush.kernel.post({ fsPut: '/react_f8', data: new TextEncoder().encode('old') }); true");
  await set(["print(open('/react_f8').read())", "open('/react_f8', 'w').write('new')"]);
  r = await run([0, 1]);
  ok((await out(0)) === "new", `F8: a cell that read a file before another cell wrote it reruns (${await out(0)}; ran ${r.ran.length})`);
  // F5: switching notebooks during a run: the old run does not write into the new notebook's cells
  await fileNew();
  const idA = await ev("localStorage.getItem('sagebrush-current')");
  await set(["import time\ntime.sleep(1.2)\nx = 1", "print('FROM A', x)"]);
  const cellIds = await ev("sagebrush.notebook.cells().map((c) => c.id)");
  await ev("window.__runA = sagebrush.notebook.runAll(); true");
  await sleep(300);
  await fileNew();
  // a notebook with the same cell ids (as a copy has)
  await ev(`(() => { sagebrush.notebook.replace({ mode: "python", cells: [{ id: ${JSON.stringify(cellIds[0])}, code: "x = 987" }, { id: ${JSON.stringify(cellIds[1])}, code: "print('FROM B', x)" }] }); return true; })()`);
  await sleep(300);
  await run([0, 1]);
  await sleep(2000);
  ok((await out(1)) === "FROM B 987", `F5: a run of a notebook switched away from does not write into the one shown (${await out(1)})`);

  // F14: graph() says how a cell's run ended; F15: a name of the user's own with U+02B9 is shown as written
  await fileNew();
  await set(["raise ValueError('bad')", "x\u02b92 = 7", "print(x\u02b92)"]);
  await run([0, 1, 2]);
  const g14 = await ev("sagebrush.notebook.graph()");
  ok(g14[0].state === "failed" && JSON.stringify(g14[1].defines) === '["x\u02b92"]' && (await out(2)) === "7", `F14/F15: a cell that raised is "failed" in the graph; the user's own xʹ2 is not renamed (${g14[0].state}, ${JSON.stringify(g14[1].defines)})`);
  // F10: the analyzer failing: what waited settles with an error, and the next run analyzes again
  await set(["print('analyzed again')"]);
  const f10 = await ev(`(async () => {
    const nb = sagebrush.notebook, id = nb.cells()[0].id;
    await sagebrush.analyzer.analyze("1", "python");
    const p = nb.runCells([id]);
    sagebrush.analyzeWorker.onerror({ message: "injected" });
    const a = await Promise.race([p.then(() => "settled"), new Promise((r) => setTimeout(() => r("hung"), 8000))]);
    const b = await Promise.race([nb.runCells([id]).then(() => "ran"), new Promise((r) => setTimeout(() => r("hung"), 8000))]);
    return [a, b, nb.cells()[0].out.textContent.trim()];
  })()`);
  ok(f10[0] === "settled" && f10[1] === "ran" && f10[2] === "analyzed again", `F10: an analyzer failure settles the run, and the next run analyzes again (${JSON.stringify(f10)})`);

  // F11: Restart while a cell runs: it stays stale, and Run stale recovers both cells
  await fileNew();
  await set(["import time\ntime.sleep(0.6)\nx = 1", "print(x)"]);
  await run([0, 1]);
  const f11 = await ev(`(async () => {
    const nb = sagebrush.notebook, k = sagebrush.kernel;
    const p = nb.runAll();
    for (let i = 0; i < 100 && !nb.cells()[0].el.classList.contains("running"); i++) await new Promise((r) => setTimeout(r, 30));
    k.restart();
    await p;
    for (let i = 0; i < 100 && !k.ready; i++) await new Promise((r) => setTimeout(r, 100));
    const stale = nb.reactive.staleSummary().cells.length;
    const r = await nb.runCells(nb.reactive.staleSummary().cells, { budget: Infinity });
    return [stale, r.ran.length, nb.cells()[1].out.textContent.trim()];
  })()`);
  ok(JSON.stringify(f11) === '[2,2,"1"]', `F11: after Restart during a run, both cells are stale and Run stale recovers them (${JSON.stringify(f11)})`);

  // F16: verify compares pictures by their data (a point moved inside fixed axes)
  await fileNew();
  await ev("sagebrush.notebook.setMode('sage'); true");
  await set(["v = [1]", "w = v\nw[0] += 1", "list_plot(v, xmin=-1, xmax=1, ymin=0, ymax=5)"]);
  await run([0, 1, 2]);
  await run(1);
  await run(2);
  let v16 = await ev("sagebrush.notebook.verify().then((r) => ({ same: r.same.length, changed: r.changed.map((c) => !!c.pictures) }))");
  ok(JSON.stringify(v16.changed) === "[true]" && v16.same === 2, `F16: verify finds a picture that differs though its description does not (${JSON.stringify(v16)})`);
  v16 = await ev("sagebrush.notebook.verify().then((r) => r.changed.length)");
  ok(v16 === 0, `...and finds nothing when nothing differs (${v16})`);

  // second review: var('_x') is the cell's own; tracebacks keep longer names; verify does not hide text
  await fileNew();
  await ev("sagebrush.notebook.setMode('sage'); true");
  await set(["var('_x')\n_x = 1\ndef f():\n    return _x", "var('_x')\n_x = 2", "print(f())"]);
  await run([0, 1, 2]);
  ok((await out(2)) === "1", `var('_x') in two cells: two variables (f() = ${await out(2)})`);
  await ev("sagebrush.notebook.setMode('python'); true");
  await set(["x = 1", "x = 2", "print(x + x\u02b920)"]);
  await run([0, 1, 2]);
  ok(/NameError: name 'x\u02b920' is not defined/.test(await out(2)), `a traceback keeps a longer name whole (${(await out(2)).split("\n").pop()})`);
  await set(["v = [1]", "w = v\nw[0] += 1", "print('sbclip' + str(v[0]))"]);
  await run([0, 1, 2]);
  await run(1);
  await run(2);
  const vt = await ev("sagebrush.notebook.verify().then((r) => r.changed.map((c) => [c.before.trim(), c.after.trim()]))");
  ok(JSON.stringify(vt) === '[["sbclip3","sbclip2"]]', `verify finds a text difference, whatever the text (${JSON.stringify(vt)})`);

  // second review, F5: away and back during a run: the output lands in the cell shown
  await fileNew();
  const idA5 = await ev("localStorage.getItem('sagebrush-current')");
  await set(["import time\ntime.sleep(1.5)\nx = 1\nprint('OLD')", "print(x)"]);
  await run([0, 1]);
  await set(["import time\ntime.sleep(1.5)\nx = 2\nprint('NEW')"]);
  await ev("window.__runA5 = sagebrush.notebook.runAll(); true");
  await sleep(300);
  await fileNew();
  await set(["b = 987\nprint(b)"]);
  await run(0);
  await ev(`sagebrush.open(${JSON.stringify(idA5)})`);
  await until(`localStorage.getItem('sagebrush-current') === ${JSON.stringify(idA5)}`, 10000);
  await ev("window.__runA5");
  await sleep(1500);
  const a5 = [await out(0), await out(1), await ev("sagebrush.notebook.graph().map((c) => c.state).join(',')")];
  ok((a5[0] === "NEW" && a5[1] === "2") || /stale/.test(a5[2]), `F5: switching away and back during a run: the cell shows its output, or is stale (${JSON.stringify(a5)})`);

  // third review, F16: verify keeps which clip path an SVG reference names
  await set(["v = [1]", "w = v\nw[0] += 1", "from IPython.display import SVG, display\ndisplay(SVG('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"200\" height=\"80\"><clipPath id=\"sbclip1\"><rect width=\"100\" height=\"80\"/></clipPath><clipPath id=\"sbclip2\"><rect width=\"200\" height=\"80\"/></clipPath><rect width=\"200\" height=\"80\" fill=\"blue\" clip-path=\"url(#sbclip%d)\"/></svg>' % (1 + v[0] % 2)))"]);
  await run([0, 1, 2]);
  await run(1);
  await run(2);
  const v16b = await ev("sagebrush.notebook.verify().then((r) => r.changed.length)");
  ok(v16b === 1, `F16: verify sees an SVG reference that names another clip path (${v16b} changed)`);

  // third review: a Python function named var is the user's; Sage private vars of any script, several arguments
  await set(["def var(name):\n    print('CALLED', name)", "var('_x')"]);
  await run([0, 1]);
  ok((await out(1)) === "CALLED _x", `a Python function named var is called as written (${await out(1)})`);
  await ev("sagebrush.notebook.setMode('sage'); true");
  await set(["var('_\u03b1')\nprint(_\u03b1)", "var('_x', '_y')\nprint(_x, _y)"]);
  await run([0, 1]);
  ok((await out(0)) === "_\u03b1" && (await out(1)) === "_x _y", `Sage var() of private names of any script, and of several (${await out(0)} | ${await out(1)})`);

  // fourth review: var() with keywords; a public name of any script; an escaped triple quote
  await set(["var('_x', domain='real')\nprint(_x^2)", "var('_x', latex_name='t')\n_x = _x + 1\nprint(_x)", "print(_x)"]);
  await run([0, 1, 2]);
  ok((await out(0)) === "_x^2" && (await out(1)) === "_x + 1" && /NameError/.test(await out(2)), `Sage private var() with domain= and latex_name= are each cell's own (${await out(0)} | ${await out(1)} | ${(await out(2)).split("\n").pop()})`);
  await set(["var('_x', domain='real')\nprint(assumptions())\nprint(solve(abs(_x) == 1, _x))\nforget()"]);
  await run(0);
  ok((await out(0)) === "[_x is real]\n[_x == 1, _x == -1]", `Sage private var() keeps domain='real' (${await out(0)})`);
  await set(["print(α^2)", "var('α')"]);
  await run([0, 1]);
  ok((await out(0)) === "α^2", `Sage var('α') defines α for the cell above (${await out(0)})`);
  await set(["x = 1", "print(x)", "x = 2\nprint(\"\"\"hello\\\"\"\"\nvar('x')\nbye\"\"\")", "print(x)"]);
  await run([0, 1, 2, 3]);
  ok((await out(2)) === "hello\"\"\"\nvar('x')\nbye" && (await out(3)) === "2", `an escaped triple quote does not end the string (${JSON.stringify([await out(2), await out(3)])})`);
  await ev("sagebrush.notebook.setMode('python'); true");

  // fourth review: class bodies through compound statements and nested scopes
  for (const [code, show, want] of [
    ["x = 2\nclass C:\n    x = 100\n    del x\n    y = x", "C.y", "2 2"],
    ["x = 2\nclass C:\n    if True:\n        x = 100\n        y = x", "C.y", "100 2"],
    ["x = 2\nclass C:\n    x = 100\n    f = lambda self: x", "C().f()", "2 2"],
    ["x = 2\nclass C:\n    x = 100\n    ys = [x for _i in range(1)]", "C.ys", "[2] 2"],
    ["x = 2\nclass C:\n    x = 100\n    if True:\n        def f(self): return x", "C().f()", "2 2"],
  ]) {
    await set(["x = 1", "print(x)", code, `print(${show}, x)`]);
    await run([0, 1, 2, 3]);
    ok((await out(3)) === want, `class body: ${JSON.stringify(code)} (${await out(3)})`);
  }

  // fifth review: del of a tuple; except as binding a class body's global; refused when undetermined
  // (the end of `except ... as x` deletes the global x: the reader prints C.y only)
  for (const [code, reader, want] of [
    ["x = 2\nclass C:\n    x = 100\n    z = 200\n    del (x, z)\n    y = x", "print(C.y, x)", "2 2"],
    ["x = 2\nclass C:\n    global x\n    try:\n        1/0\n    except ZeroDivisionError as x:\n        y = str(x)", "print(C.y)", "division by zero"],
  ]) {
    await set(["x = 1", "print(x)", code, reader]);
    await run([0, 1, 2, 3]);
    ok((await out(3)) === want, `class body: ${JSON.stringify(code)} (${await out(3)})`);
  }
  await set(["x = 1", "print(x)", "x = 2\nclass C:\n    x = 100\n    for _i in range(1):\n        del x\n        break\n        x = 200\n    y = x", "print(C.y, x)"]);
  await run([0, 1, 2, 3]);
  ok(/x is defined by cell 1 and cell 3/.test(await out(3)) && /x is also defined by/.test(await out(2)), `a class-body read that depends on a loop is not renamed: the several-definitions error (${(await out(2)).slice(0, 120)} | ${(await out(3)).slice(0, 120)})`);

  // sixth review: the target of except ... as x is the one after the type, not text in a string
  await set(["x = 1", "print(x)", "x = 2\ntry:\n    1/0\nexcept (ZeroDivisionError if 'as x:' else Exception) as x:\n    result = str(x)", "print(result)"]);
  await run([0, 1, 2, 3]);
  ok((await out(3)) === "division by zero", `except ... as x after a string containing "as x:" (${await out(3)})`);

  // daybreak's review, F25: a renamed class and function keep their names (in this interpreter)
  await set(["class C:\n    pass\ndef f():\n    pass", "class C:\n    def m(self):\n        pass\ndef f():\n    pass\nprint(C.__name__, C.__qualname__, C.m.__qualname__, f.__name__, C())", "print(C.__name__)"]);
  await run([0, 1, 2]);
  ok(/^C C C\.m f <__main__\.C object at/.test(await out(1)) && (await out(2)) === "C", `renamed definitions keep their names (${await out(1)} | ${await out(2)})`);

  // a definition the class body declares global is qualified as the module's (as CPython)
  await set(["class Outer:\n    global gf, GC\n    def gf():\n        pass\n    class GC:\n        pass\nprint(gf.__qualname__, GC.__qualname__)"]);
  await run(0);
  ok((await out(0)) === "gf GC", `global definitions in a class body: module qualified names (${await out(0)})`);

  // fourth review, F16: verify compares an SVG's text as text
  await set(["v = [1]", "w = v\nw[0] += 1", "from IPython.display import SVG, display\ndisplay(SVG('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"300\" height=\"80\"><text x=\"0\" y=\"30\">id=\"sbclip'+str(v[0])+'\"</text></svg>'))"]);
  await run([0, 1, 2]);
  await run(1);
  await run(2);
  const v16c = await ev("sagebrush.notebook.verify().then((r) => r.changed.length)");
  ok(v16c === 1, `F16: verify sees SVG text that differs, though it looks like an id (${v16c} changed)`);
  await ev("sagebrush.notebook.setMode('python'); true");

  // second review: generators made or reseeded without a seed draw from the cell's seed too
  await set(["import random\nimport numpy as np\nrandom.seed()\nprint(random.Random().random(), np.random.RandomState().rand(), random.random())"]);
  await run(0);
  const g1 = await out(0);
  await run(0);
  ok((await out(0)) === g1, `random.Random(), RandomState() and random.seed() without a seed repeat in a cell (${g1})`);

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
  // Revert to this version: the cells as they were, computed again (the same random number, through the file)
  await ev("document.querySelector('#ttbtn').click(); true");
  await until("!document.querySelector('#timetravel').hidden && sagebrush.history?.versions().length > 1", 10000);
  await ev(`(() => { const s = document.querySelector('#ttslider'), vs = sagebrush.history.versions(); s.value = vs.findIndex((v) => v.time === ${JSON.stringify(target.time)}); s.dispatchEvent(new Event('input')); return true; })()`);
  ok(!(await ev("!!document.querySelector('#ttresume')")), "TimeTravel has one button: Revert to this version");
  await ev("window.sagebrush.replayReport = null; document.querySelector('#ttrevert').click(); true");
  await until("window.sagebrush?.replayReport", 30000);
  const rep = await ev("sagebrush.replayReport");
  ok(rep.recomputed && rep.ran.length === 3 && (await out(2)) === x0 && /random\.random/.test(await ev("sagebrush.notebook.cells()[0].ta.value")), `reverting computes the version again: the same random number through the file (${await out(2)} = ${x0}; ${await ev("document.querySelector('#status').textContent")})`);
  // an old Resume link still works
  await send("Page.navigate", { url: base.replace("?reactive", "") + `?resume=${encodeURIComponent(target.id)}&at=${encodeURIComponent(target.time)}` });
  await until("window.sagebrush?.replayReport", 30000);
  ok((await out(2)) === x0, "an old Resume from here link computes the version in a new notebook");
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
  await send("Page.reload");
  await until(ready);
  await until(`sagebrush.notebook.cells().length >= 3 && sagebrush.notebook.cells()[2].el.classList.contains('stale')`, 10000);
  ok((await out(2)) === "6", "after a reload, the outputs are shown, stale");
  // the last run times are kept in the document: a stale cell and the Run stale button give estimates
  const est = await ev("[sagebrush.notebook.cells()[1].time.textContent, document.querySelector('#runstale').textContent]");
  ok(/^stale \(~\d+ ms\)$/.test(est[0]) && /^Run 3 stale \(<1 s\)$/.test(est[1]), `after a reload, time estimates from the last runs (${JSON.stringify(est)})`);
  const before = JSON.stringify(await ev("sagebrush.notebook.graph().map((c) => [c.state, c.reads, c.defines])"));
  r = await run(2);
  ok(JSON.stringify(r?.ran) === "[0,1,2]" && (await out(2)) === "6", `running the last cell first runs its stale ancestors (${JSON.stringify(r?.ran)}; before: ${before}; ${await out(2)})`);

  // last run times merge with changes from elsewhere: there only -> taken (and known to the
  // scheduler); here only -> kept; a document without them changes nothing
  const tm = await ev(`(() => {
    const nb = sagebrush.notebook, R = 1e12;
    const doc = (rev, ms0, code1) => { const d = nb.snapshot(); d.rev = rev; d.cells = d.cells.map((c, i) => ({ ...c, ...(i === 0 ? { ms: ms0 } : {}), ...(i === 1 && code1 != null ? { code: code1 } : {}) })); if (ms0 === null) delete d.cells[0].ms; return d; };
    const c0 = nb.cells()[0], c1 = nb.cells()[1], code1 = c1.ta.value;
    nb.applyRemote(doc(R + 1, 100, code1));
    c1.ta.value = code1 + "  # here"; c1.ta.dispatchEvent(new Event("input", { bubbles: true }));
    nb.applyRemote(doc(R + 2, 200, code1));
    const a = [c0.ms, nb.reactive.times.get(c0.id), c1.ta.value.endsWith("# here")];
    c0.ms = 300;
    nb.applyRemote(doc(R + 3, 200, code1 + "  # here"));
    const b = c0.ms;
    nb.applyRemote(doc(R + 4, null, code1 + "  # here"));
    return [...a, b, c0.ms, nb.snapshot().cells[0].ms];
  })()`);
  ok(JSON.stringify(tm) === "[200,200,true,300,300,300]", `run times merge: taken from elsewhere, kept from here (${JSON.stringify(tm)})`);

  // a redefinition that may not run (William, October 12): the new name
  // starts as the previous value, so a skipped one leaves it, as in Python;
  // the cell then reads the previous definition (editing it reruns the
  // cell); its line numbers are as written (the initialization runs on the
  // first statement's line, not a line of its own)
  await fileNew();
  await ev("sagebrush.notebook.setBudget(Infinity); true");
  await set(["w = 1", "if False:\n    w = 2\nprint('W', w)", "print('V', w)"]);
  r = await run([0, 1, 2]);
  ok(JSON.stringify(r?.errors) === "[]" && (await out(1)) === "W 1" && (await out(2)) === "V 1", `a skipped redefinition leaves the previous value (${await out(1)}, ${await out(2)}; ${JSON.stringify(r)})`);
  await set(["w = 5"]);
  r = await run(0);
  ok((await out(1)) === "W 5" && (await out(2)) === "V 5", `editing the previous definition reruns it (${await out(1)}, ${await out(2)})`);
  await set([null, "if False:\n    w = 2\nprint('W', w)\n1/0"]);
  await run(1);
  const tb = await out(1);
  ok(/line 4/.test(tb) && /ZeroDivisionError/.test(tb) && !/\u02b9|page-order/.test(tb), `its traceback has the line as written, and no internal names (${JSON.stringify(tb)})`);
  // (the initialization reads no name of the cell's but the previous one:
  // a user's hasattr is not called; it comes after a docstring and a
  // __future__ import; a `global w` outside functions stays legal:
  // sagebrush-codex's REACT-8C82-1, -2)
  await set(["w = 1\nhasattr = 7\n__import__ = 8", "'''doc'''\nfrom __future__ import annotations\nglobal w\nif False:\n    w = 2\nprint('W', w, __doc__)", "print('V', w)"]);
  r = await run([0, 1, 2]);
  ok(JSON.stringify(r?.errors) === "[]" && /^W 1 (doc|None)$/.test(await out(1)) && (await out(2)) === "V 1", `the initialization after the prologue, with a global and a user's hasattr (${await out(1)}, ${await out(2)}; ${JSON.stringify(r)})`);
  // (a statement on the prologue's line, `"doc"; print(w)`: the
  // initialization goes between them, and the line numbers stay as written:
  // REACT-5EE9-1)
  await set(["w = 1", "\"doc\"; print('W', w); False and (w := 2)\nprint('W2', w)", "print('V', w)"]);
  r = await run([0, 1, 2]);
  ok(JSON.stringify(r?.errors) === "[]" && (await out(1)) === "W 1\nW2 1" && (await out(2)) === "V 1", `an initialization inside the prologue's line (${await out(1)}, ${await out(2)}; ${JSON.stringify(r)})`);
  await set([null, "\"doc\"; print('W', w); False and (w := 2)\nprint('W2', w)\n1/0"]);
  await run(1);
  const tb2 = await out(1);
  ok(/^W 1\nW2 1\n/.test(tb2) && /line 3/.test(tb2) && !/ʹ|page-order/.test(tb2), `its traceback has the line as written (${JSON.stringify(tb2)})`);
  // (and when the line goes on after a backslash, REACT-D2C5-2)
  await set(["w = 1", "\"doc\"; \\\nprint('W', w); False and (w := 2)\nprint('W2', w)", "print('V', w)"]);
  r = await run([0, 1, 2]);
  ok(JSON.stringify(r?.errors) === "[]" && (await out(1)) === "W 1\nW2 1" && (await out(2)) === "V 1", `an initialization after a prologue going on after a backslash (${await out(1)}, ${await out(2)}; ${JSON.stringify(r)})`);
  // (a module's global after an import, or a comprehension's :=, is valid Python: REACT-D2C5-3)
  await set(["w = 1", "if False:\n    import math as w\nglobal w\nprint('W', w)", "from math import floor\nglobal floor\nprint(floor(3.5))", "[(z := 2) for _ in [0]]\nglobal z\nprint(z)"]);
  r = await run([0, 1, 2, 3]);
  ok((await out(1)) === "W 1" && (await out(2)) === "3" && (await out(3)) === "2", `a global after an import or a comprehension's := (${await out(1)}, ${await out(2)}, ${await out(3)}; ${JSON.stringify(r)})`);
  // MATLAB (src/dataflow.ts's matlab mode): definitions and reads flow the same way;
  // a function defined in a cell is a definition; ans links no cells
  await fileNew();
  await ev("sagebrush.notebook.setMode('matlab'); sagebrush.notebook.setBudget(Infinity); true");
  await set(["x = 2;", "y = twice(x)", "function r = twice(v)\n  r = 2 * v;\nend", "3 + 4", "ans"]);
  r = await run([0, 1, 2, 3, 4]);
  ok(JSON.stringify(r?.errors) === "[]" && /y =\s+4/.test(await out(1)), `MATLAB cells run in graph order, the function first (${JSON.stringify(await out(1))}; ${JSON.stringify(r)})`);
  await set(["x = 5;"]);
  r = await run(0);
  ok(JSON.stringify(r?.ran) === "[0,1]" && /y =\s+10/.test(await out(1)), `editing x reruns y = twice(x) only (${JSON.stringify(r?.ran)}, ${JSON.stringify(await out(1))})`);
} catch (e) {
  ok(false, String(e?.stack ?? e));
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
