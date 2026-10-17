// End-to-end checks of the notebook page in headless Chromium: notebooks and
// files persist across reloads, File > New/Open/Download/Upload, the files
// panel, share links.  Serve web/dist first:
//   bun web/build.ts && (cd web/dist && python3 -m http.server 8765) &
//   node web/test-notebook.mjs          (CHROME=... for another browser binary)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
const url = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const profile = mkdtempSync(join(tmpdir(), "sb-notebook-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// (the DevTools port: CDP_PORT, so that runs of several agents do not collide)
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!cdpPort) cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
// (a script copying this harness must close ws at its end, as the finally
// below does: an open WebSocket keeps node running, and piped output is
// then held back until exit, which looks like a hang)
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
const ready = () => until("document.querySelector('#status')?.textContent.startsWith('ready')");
async function runCode(code) {
  await ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); })()`);
  // (done: a prompt number; or, in the reactive notebook, not run: waiting for a cell, or an error in the graph)
  await until("(() => { const c = [...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1); return /\\[\\d+\\]/.test(c.querySelector('.n').textContent) || c.classList.contains('cancelled') || c.classList.contains('error'); })()");
  return ev("[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1).querySelector('.out').textContent");
}
// Start a cell, press Stop after `ms`, and return its output once it settles.
async function runAndStop(code, ms) {
  await ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); c.querySelector('[data-a=run]').click(); })()`);
  await sleep(ms);
  await ev("document.querySelector('#stop').click()");
  await until("(() => { const c = [...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1); return !c.classList.contains('running') && !c.classList.contains('queued'); })()");
  return ev("[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1).querySelector('.out').textContent");
}
try {
  await send("Page.navigate", { url });
  await ready();
  await until("document.querySelectorAll('.cell').length > 0");
  ok((await ev("document.querySelector('#nbname').value")) === "Welcome", "fresh profile opens the Welcome notebook");
  // Markdown: the welcome's first cell is text, with math typeset by KaTeX
  await until("document.querySelector('.cell.markdown.rendered .katex')");
  ok(true, "the welcome's Markdown cell is rendered, math by KaTeX");
  await ev(`(() => { document.querySelector('#addmd').click(); const c = [...document.querySelectorAll('.cell')].at(-1); const ta = c.querySelector('textarea');
    ta.value = '**bold** and <img src=x onerror=alert(1)> [bad](javascript:alert(1)) [good](https://sagemath.org)\\n\\n| a | b |\\n|---|---|\\n| 1 | 2 |';
    ta.dispatchEvent(new Event('input', {bubbles: true})); ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true})); })()`);
  await until("[...document.querySelectorAll('.cell.markdown.rendered')].length >= 2");
  const md = await ev("(() => { const m = [...document.querySelectorAll('.cell.markdown.rendered .mdout')].at(-1); return { strong: !!m.querySelector('strong'), img: !!m.querySelector('img'), js: [...m.querySelectorAll('a')].some(a => /javascript/i.test(a.href)), good: !!m.querySelector('a[href^=\"https://sagemath.org\"]'), table: !!m.querySelector('table td') }; })()");
  ok(md.strong && md.table && md.good && !md.img && !md.js, "Shift+Enter renders Markdown, safely: " + JSON.stringify(md));
  await ev("(() => { const m = [...document.querySelectorAll('.cell.markdown.rendered .mdout')].at(-1); m.dispatchEvent(new MouseEvent('dblclick', {bubbles: true})); })()");
  ok(await ev("![...document.querySelectorAll('.cell.markdown')].at(-1).classList.contains('rendered')"), "double-click edits a Markdown cell");
  ok(await ev("(() => { const c = document.querySelector('.cell.markdown:not(.rendered)') ?? [...document.querySelectorAll('.cell.markdown')].at(-1); const hl = c.querySelector('.mb-edit pre'); return !!hl && (!!hl.querySelector('.hp') || !!hl.querySelector('.hk')); })()"), "the Markdown being edited is highlighted (the block written in)");
  await ev("(() => { const ta = [...document.querySelectorAll('.cell.markdown textarea')].at(-1); ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true})); })()");
  await until("[...document.querySelectorAll('.cell.markdown')].at(-1).classList.contains('rendered')");
  // the toolbar stays in view as the notebook scrolls (William, Oct 17): Run all, the
  // function search and the File menu a press away at the bottom of a long notebook
  {
    await ev("document.querySelector('main').insertAdjacentHTML('beforeend', '<div id=\"__tall\" style=\"height: 4000px\"></div>'), scrollTo(0, document.body.scrollHeight), 1");
    await sleep(300);
    const s = await ev("(() => { const bar = document.querySelector('.bar').getBoundingClientRect(), run = document.querySelector('#runall').getBoundingClientRect(), q = document.querySelector('#docsearch').getBoundingClientRect(); const at = document.elementFromPoint(run.x + run.width / 2, run.y + run.height / 2); return { scrolled: scrollY > 1000, top: Math.round(bar.top), run: at === document.querySelector('#runall') || document.querySelector('#runall').contains(at), q: q.top >= 0 && q.bottom <= bar.bottom + 1, stuck: document.querySelector('.bar').classList.contains('stuck') }; })()");
    ok(s.scrolled && s.top === 0 && s.run && s.q && s.stuck, "scrolled far down, the toolbar stays at the top: Run all pressable, the function search in view: " + JSON.stringify(s));
    await ev("document.querySelector('#filebtn').click(), 1");
    const m = await ev("(() => { const b = document.querySelector('#filebtn').getBoundingClientRect(), r = document.querySelector('#filemenu').getBoundingClientRect(); return { open: !document.querySelector('#filemenu').hidden, below: Math.round(r.top - b.bottom), inView: r.top >= 0 && r.top < innerHeight }; })()");
    ok(m.open && m.below === 4 && m.inView, "...and its File menu opens under its button, in view: " + JSON.stringify(m));
    await ev("document.querySelector('#filebtn').click(), 1");
    // (a menu opened before the toolbar sticks stays under its button as the page scrolls, astra's UI-CA2-2)
    await ev("scrollTo(0, 0), document.querySelector('#filebtn').click(), 1");
    await sleep(100);
    await ev("scrollTo(0, 2000), 1");
    await sleep(200);
    const g = await ev("(() => { const b = document.querySelector('#filebtn').getBoundingClientRect(), r = document.querySelector('#filemenu').getBoundingClientRect(); return { open: !document.querySelector('#filemenu').hidden, below: Math.round(r.top - b.bottom) }; })()");
    ok(g.open && g.below === 4, "a File menu opened at the top stays under its button as the toolbar sticks: " + JSON.stringify(g));
    await ev("document.querySelector('#filebtn').click(), 1");
    // (in a short window a menu fits in it, scrolling within itself: its last entry reachable, by mouse and keyboard)
    await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 420, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    for (const [btn, menu] of [["#filebtn", "#filemenu"], ["#morebtn", "#moremenu"]]) {
      await ev(`scrollTo(0, 1000), document.querySelector('${btn}').click(), 1`);
      await sleep(200);
      const fit = await ev(`(() => { const m = document.querySelector('${menu}'), r = m.getBoundingClientRect(); return { bottom: Math.round(r.bottom), h: innerHeight, scrolls: m.scrollHeight <= m.clientHeight + 1 || getComputedStyle(m).overflowY === 'auto' }; })()`);
      // (the last entry, from the first by ↑, as a keyboard reaches it; focused, it is scrolled into view within the menu)
      await ev(`document.querySelector('${menu}').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })), 1`);
      await sleep(100);
      const last = await ev(`(() => { const m = document.querySelector('${menu}'), items = [...m.querySelectorAll('button:not([hidden]), a:not([hidden])')], l = items.at(-1), r = l.getBoundingClientRect(), at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { focused: document.activeElement === l, inView: r.top >= 0 && r.bottom <= innerHeight, pressable: l === at || l.contains(at) }; })()`);
      ok(fit.bottom <= fit.h && fit.scrolls && last.focused && last.inView && last.pressable, `in a 420 px window, ${menu} fits in it, its last entry reachable by keyboard and pointer: ` + JSON.stringify([fit, last]));
      await ev(`document.querySelector('${btn}').click(), 1`);
    }
    // (the function search's results, from the toolbar's middle, within the window at laptop widths, astra's UI-CA2-1)
    for (const width of [1100, 1024]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      await ev("(() => { const q = document.querySelector('#docsearch'); q.focus(); q.value = 'sin'; q.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()");
      await until("!document.querySelector('#docresults').hidden && document.querySelectorAll('#docresults li').length > 0");
      const d = await ev("(() => { const r = document.querySelector('#docresults').getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), w: innerWidth }; })()");
      ok(d.left >= 0 && d.right <= d.w, `at ${width} px, the function search's results are within the window: ` + JSON.stringify(d));
      await ev("(() => { const q = document.querySelector('#docsearch'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); q.blur(); return 1; })()");
    }
    await send("Emulation.clearDeviceMetricsOverride");
    await ev("document.querySelector('#__tall').remove(), scrollTo(0, 0), 1");
    await sleep(200);
  }
  let out = await runCode("import os\nwith open('data.txt', 'w') as f:\n    f.write('hello from python')\nos.makedirs('sub/dir', exist_ok=True)\nopen('sub/dir/x.csv', 'w').write('a,b\\n1,2\\n')\nprint(sorted(os.listdir('.')), os.path.exists('sub/dir/x.csv'), os.path.getsize('data.txt'))");
  ok(out.includes("['data.txt', 'sub'] True 17"), "open() and os work: " + out.trim());
  await ev("document.querySelector('#nbname').value = 'My research'; document.querySelector('#nbname').dispatchEvent(new Event('input'))");
  await until("document.querySelector('#saved').textContent.includes('saved')");
  await send("Page.reload");
  await ready();
  await until("document.querySelectorAll('.cell').length > 0");
  ok((await ev("document.querySelector('#nbname').value")) === "My research", "the notebook and its name survive a reload");
  ok((await ev("document.body.textContent.includes(\"['data.txt', 'sub'] True 17\")")), "outputs survive a reload");
  ok((await ev("document.querySelectorAll('.cell.markdown.rendered').length")) === 2, "Markdown cells survive a reload, rendered");
  out = await runCode("print(open('data.txt').read(), open('sub/dir/x.csv').read().split())");
  ok(out.includes("hello from python ['a,b', '1,2']"), "files survive a reload: " + out.trim());
  out = await runCode("from IPython.display import display, JSON\ndisplay(JSON({'exact': '9007199254740993/7', 'precision': 150}))\nprint('after json')");
  ok(out.includes("9007199254740993/7") && out.includes("after json"), "a JSON display result is shown: " + out.trim().slice(0, 80));
  // export .ipynb
  await ev("window.__blobs = []; URL.createObjectURL = (b) => { window.__blobs.push(b); return 'blob:x'; }; document.querySelector('[data-f=ipynb]').click()");
  const ipynb = await ev("window.__blobs[0].text()");
  const j = JSON.parse(ipynb);
  ok(j.cells.filter((c) => c.cell_type === "markdown").length === 2, "ipynb export has the Markdown cells");
  const jouts = j.cells.flatMap((c) => c.outputs ?? []);
  const jd = jouts.find((o) => o.output_type === "display_data" && o.data?.["application/json"]);
  ok(jd?.data["application/json"].exact === "9007199254740993/7" && jouts.some((o) => o.output_type === "stream" && [o.text].flat().join("").includes("after json")),
    "ipynb export keeps application/json as JSON (R2-DOC-F2): " + JSON.stringify(jd?.data ?? null).slice(0, 120));
  ok(j.nbformat === 4 && j.cells.length >= 2 && j.cells.some(c => c.outputs?.length), `ipynb export: ${j.cells.length} cells, kernel ${j.metadata.kernelspec.name}, outputs ${j.cells.map(c => c.outputs?.length ?? "md")}`);
  // new notebook, then import the ipynb
  await ev("document.querySelector('[data-f=new]').click()");
  await until("document.querySelector('#nbname').value === 'Untitled'");
  ok((await ev("document.querySelectorAll('.cell').length")) === 1, "File > New gives an empty notebook");
  await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(ipynb)}], 'imported.ipynb')); const i = document.querySelector('#importinput'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
  await until("document.querySelector('#nbname').value === 'imported'");
  ok((await ev("document.body.textContent.includes('hello from python')")), "ipynb import restores cells and outputs");
  await until("document.querySelectorAll('.cell.markdown.rendered').length === 2");
  ok(true, "ipynb import restores Markdown cells");
  // open dialog lists the notebooks
  await ev("document.querySelector('[data-f=open]').click()");
  await until("document.querySelector('#opendlg').open");
  const names = await ev("[...document.querySelectorAll('#nblist .open span:first-child')].map(s => s.textContent)");
  ok(names.includes("My research") && names.includes("Untitled") && names.includes("imported"), "Open lists: " + names.join(", "));
  await ev("[...document.querySelectorAll('#nblist .open')].find(b => b.textContent.startsWith('My research')).click()");
  await until("document.querySelector('#nbname').value === 'My research'");
  ok(true, "Open switches notebooks");
  // upload a file through the panel, read it from Python
  await ev(`(() => { document.querySelector('#filesbtn').click(); const dt = new DataTransfer(); dt.items.add(new File(['x,y\\n3,4\\n'], 'up.csv')); const i = document.querySelector('#uploadinput'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
  await until("document.querySelector('#filelist').textContent.includes('up.csv')");
  out = await runCode("open('up.csv').read().split()");
  ok(out.includes("['x,y', '3,4']"), "an uploaded file is visible to Python: " + out.trim());
  ok((await ev("document.querySelector('#filelist').textContent")).includes("data.txt"), "the files panel lists Python's files");
  // Sage mode: polynomial factoring and newforms on the Rust engine (WebAssembly)
  // (changing the language of a notebook with code asks first: yes)
  await ev("(() => { window.confirm = () => true; const m = document.querySelector('#mode'); m.value = 'sage'; m.dispatchEvent(new Event('change')); })()");
  out = await runCode("R.<x> = ZZ[]\nprint((x^4 - 1).factor(), Newforms(37, names='a'))");
  ok(out.includes("(x - 1) * (x + 1) * (x^2 + 1) [q - 2*q^2 - 3*q^3 + 2*q^4 - 2*q^5 + O(q^6), q + q^3 - 2*q^4 + O(q^6)]"), "Sage mode factors polynomials and finds newforms: " + out.trim());
  // number fields, class groups and LLL (engine/classgroup in WebAssembly)
  out = await runCode("x = polygen(QQ, 'x')\nK.<a> = NumberField(x^3 - 11)\nprint(K.class_group().invariants(), K.regulator(), matrix(ZZ, [[1,2,3],[4,5,6],[7,8,10]]).LLL()[0])");
  ok(out.includes("(2,) 5.58720662606091 (0, 0, 1)"), "Sage mode: class group, regulator, LLL: " + out.trim());
  // the symbolic x, and a field on which Sage 10.8.beta0's PARI fails ("bug in small_norm")
  out = await runCode("x = var('x')\nK.<a> = NumberField(x^3 + 838398*x - 5077)\nprint(K.class_group().invariants())");
  ok(out.includes("(8, 2, 2)"), "Sage mode: NumberField of a symbolic polynomial: " + out.trim());
  // symbolic calculus (the Rust engine, engine/sym) and 3D graphics: an
  // interactive WebGL view over the SVG, which stays when WebGL is missing
  out = await runCode("print(solve(x^2 == 2, x), diff(x^3, x), limit(sin(x)/x, x=0))");
  ok(out.includes("x == -sqrt(2)") && out.includes("3*x^2 1"), "Sage mode: solve, diff, limit: " + JSON.stringify(out.trim()));
  // Tab completion in a code cell: `e.ra<Tab>` completes the common prefix and lists the rest
  await runCode("e = EllipticCurve([1..5]); e");
  const key = (k) => ev(`(() => { const ta = document.querySelector('#tabtest'); ta.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })); })()`);
  await ev("(() => { document.querySelector('#add').click(); const ta = [...document.querySelectorAll('.cell textarea')].at(-1); ta.id = 'tabtest'; ta.focus(); document.execCommand('insertText', false, 'r = e.ra'); })()");
  await key("Tab");
  await until("!document.querySelector('.sbnb-completer').hidden");
  const listed = await ev("[...document.querySelectorAll('.sbnb-completer li')].map(li => li.textContent).join(' ')");
  ok((await ev("document.querySelector('#tabtest').value")) === "r = e.rank" && /\brank_bounds\b/.test(listed), "Tab completes e.ra to e.rank and lists " + listed);
  await key("ArrowDown");
  await key("Enter");
  ok((await ev("document.querySelector('#tabtest').value")) === "r = e." + listed.split(" ")[1] && (await ev("document.querySelector('.sbnb-completer').hidden")), "↓ Enter accepts a listed completion");
  await ev("(() => { const ta = document.querySelector('#tabtest'); ta.select(); document.execCommand('insertText', false, 'if 1:\\n'); })()");
  await key("Tab");
  ok((await ev("document.querySelector('#tabtest').value")) === "if 1:\n    ", "Tab after whitespace still indents");
  // the documentation search box: results, the documentation, its examples in a new cell
  await ev("(() => { const i = document.querySelector('#docsearch'); i.focus(); i.value = 'two descent'; i.dispatchEvent(new Event('input')); })()");
  await until("document.querySelectorAll('#docresults li[role=option]').length > 0");
  const firstHit = await ev("document.querySelector('#docresults li .sig').textContent");
  ok(firstHit.startsWith("EllipticCurve_rational_field.two_descent("), "searching 'two descent' finds two_descent: " + firstHit.slice(0, 60));
  await ev("document.querySelector('#docsearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await until("document.querySelector('#docdlg').open");
  ok((await ev("document.querySelector('#docbody').textContent")).includes("EXAMPLES::"), "Enter opens the function's documentation");
  const ncells = await ev("document.querySelectorAll('.cell').length");
  await ev("document.querySelector('#docinsert').click()");
  ok((await ev("document.querySelectorAll('.cell').length")) === ncells + 1 && (await ev("[...document.querySelectorAll('.cell textarea')].at(-1).value")).includes("E.two_descent()"), "its examples go into a new cell");
  await ev("(() => { const t = [...document.querySelectorAll('.cell textarea')].at(-1); t.value = ''; t.dispatchEvent(new Event('input', {bubbles: true})); })()");
  out = await runCode("e.two_descent?");
  ok(out.includes("Signature: e.two_descent(") && out.includes("EXAMPLES::") && out.includes("Type:      method"), "obj? shows the signature and docstring: " + JSON.stringify(out.slice(0, 80)));
  await ev("(() => { const ta = document.querySelector('#tabtest'); ta.select(); document.execCommand('insertText', false, 'pass'); ta.removeAttribute('id'); })()");
  out = await runCode("show(integrate_steps(x*cos(x^2), x))");
  await sleep(1500);
  ok(await ev("!!document.querySelector('.latex-out .katex') && !document.querySelector('.latex-out .katex-error')"),
     "show() typesets with KaTeX (integration steps): " + JSON.stringify(out.trim().slice(0, 60)));
  out = await runCode("y = var('y')\nplot3d(sin(x*y), (x, -3, 3), (y, -3, 3))");
  ok(await ev("!!document.querySelector('figure.plot3d svg[aria-label^=\"3D plot\"]')"), "plot3d shows a 3D figure with its SVG and description");
  await sleep(500);
  const webgl = await ev("(() => { const c = document.querySelector('figure.plot3d canvas'); return c ? c.getAttribute('aria-label').slice(0, 30) : null; })()");
  console.log("     " + (webgl ? "WebGL view mounted: " + webgl : "no WebGL in this browser: the SVG shows"));
  if (webgl) {
    // fly mode: F, then W moves the camera forward; Home glides back
    const moved = await ev(`(async () => {
      const c = document.querySelector('figure.plot3d canvas'), t0 = c.sagebrush.view.t;
      c.focus();
      const key = (type, code) => c.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
      key('keydown', 'KeyF'); key('keydown', 'KeyW');
      await new Promise((r) => setTimeout(r, 700));
      key('keyup', 'KeyW');
      const fly = c.sagebrush.fly, t1 = c.sagebrush.view.t;
      key('keydown', 'KeyF');
      return fly && !c.sagebrush.fly && Math.hypot(t1[0] - t0[0], t1[1] - t0[1], t1[2] - t0[2]) > 0.05;
    })()`);
    ok(moved, "the 3D view flies: F toggles fly mode and W moves forward");
  }
  // Stop: KeyboardInterrupt, in Python loops and in the Rust engine, keeping variables
  ok(await ev("crossOriginIsolated"), "the page is cross-origin isolated (COOP/COEP), so Stop can interrupt");
  out = await runAndStop("keep = 41\nwhile True:\n    pass", 800);
  ok(/KeyboardInterrupt/.test(out), "Stop interrupts a Python loop: " + JSON.stringify(out.trim().slice(-60)));
  // (the reactive notebook: a cell reading what the interrupted cell defines waits for it; the others run)
  out = await runCode("print(keep + 1)");
  ok(/Not run: cell \d+, which this cell depends on, was interrupted/.test(out), "...a cell reading its variables waits for it: " + out.trim());
  out = await runCode("print(globals()['keep'] + 1)");
  ok(out.includes("42"), "...and the interpreter kept them: " + out.trim());
  out = await runAndStop("factor(100000000000000000000000012349 * 300000000000000000000000000823)", 1500);
  ok(/KeyboardInterrupt/.test(out), "Stop interrupts the Rust engine (ECM): " + JSON.stringify(out.trim().slice(-60)));
  out = await runCode("print(globals()['keep'], factor(2^64 + 1))");
  ok(out.includes("41 274177 * 67280421310721"), "...the engine works after it, variables kept: " + out.trim());
  // a call that never checks the flag (a backtracking re match): within 2 s
  // the interpreter is ended and restarted, which the cell says, and the
  // next cell runs
  const t0 = Date.now();
  out = await runAndStop("import re\nre.match('(a+)+$', 'a' * 40 + 'b')", 800);
  ok(/did not stop when interrupted, so the interpreter was restarted; variables are gone/.test(out) && Date.now() - t0 - 800 < 4000, `Stop ends a catastrophic re.match by restarting the interpreter (${Date.now() - t0 - 800} ms): ` + JSON.stringify(out.trim().slice(-120)));
  await ready();
  out = await runCode("print(6 * 7)");
  ok(out.includes("42"), "...and the next cell runs: " + out.trim());
  if (process.env.SHOT) {
    // (SHOT=file.png: the page after the restart, the stopped cell and the next one in view)
    await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
    await ev("(() => { const cs = [...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()); cs.at(-2).scrollIntoView({ block: 'center' }); })()");
    await sleep(300);
    writeFileSync(process.env.SHOT, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await send("Emulation.clearDeviceMetricsOverride");
  }
  // Magma mode: translated to Python in the page
  await ev("(() => { window.confirm = () => true; const m = document.querySelector('#mode'); m.value = 'magma'; m.dispatchEvent(new Event('change')); })()");
  out = await runCode("R<x> := PolynomialRing(Integers());\nFactorization(x^4 - 1);\n[ p : p in [1..30] | IsPrime(p) ];");
  ok(out.includes("[\n    <x - 1, 1>,\n    <x + 1, 1>,\n    <x^2 + 1, 1>\n]\n[ 2, 3, 5, 7, 11, 13, 17, 19, 23, 29 ]"), "Magma mode runs Magma: " + JSON.stringify(out.trim().slice(0, 80)));
  out = await runCode("x := ;");
  ok(/bad syntax/.test(out), "a Magma syntax error is reported: " + JSON.stringify(out.trim().slice(0, 60)));
  await ev("(() => { window.confirm = () => true; const m = document.querySelector('#mode'); m.value = 'python'; m.dispatchEvent(new Event('change')); })()");
  // share link round trip
  await ev("navigator.clipboard.writeText = async () => {}; document.querySelector('[data-f=share]').click()");
  await until("location.hash.includes('z=')");
  const link = await ev("location.href");
  await send("Page.navigate", { url: "about:blank" });
  await send("Page.navigate", { url: link });
  await ready();
  await until("document.querySelector('#nbname').value === 'Shared notebook'");
  ok((await ev("[...document.querySelectorAll('textarea')].some(t => t.value.includes(\"open('up.csv')\"))")), `share link (${link.length} chars) opens the cells`);
  // MATLAB mode: values printed as MATLAB prints them, a function for later cells, an
  // error, a figure; MATLAB's highlighting; a share link that reopens in MATLAB
  await ev("(() => { window.confirm = () => true; const m = document.querySelector('#mode'); m.value = 'matlab'; m.dispatchEvent(new Event('change')); })()");
  out = await runCode("A = magic(3);\nb = A(2, :)");
  ok(out.includes("b =") && /3\s+5\s+7/.test(out), "MATLAB mode prints as MATLAB: " + JSON.stringify(out.trim()));
  // the search box in MATLAB mode: a function's examples, after MATLAB's prompt, and into a new cell
  await ev("(() => { const i = document.querySelector('#docsearch'); i.focus(); i.value = 'magic'; i.dispatchEvent(new Event('input')); })()");
  await until("document.querySelectorAll('#docresults li[role=option]').length > 0");
  ok((await ev("document.querySelector('#docresults li .sig').textContent")).startsWith("magic(") && (await ev("document.querySelector('#docresults li .badge')?.textContent")) === "1 example",
    "MATLAB mode's search finds magic, with an example");
  await ev("document.querySelector('#docsearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await until("document.querySelector('#docdlg').open");
  ok((await ev("document.querySelector('#docbody').textContent")).includes(">> magic(3)\n\nans =\n\n     8     1     6"), "its documentation shows the example and its output");
  const mcells = await ev("document.querySelectorAll('.cell').length");
  await ev("document.querySelector('#docinsert').click()");
  ok((await ev("document.querySelectorAll('.cell').length")) === mcells + 1 && (await ev("[...document.querySelectorAll('.cell textarea')].at(-1).value")) === "magic(3)", "its example goes into a new cell");
  await ev("(() => { const t = [...document.querySelectorAll('.cell textarea')].at(-1); t.value = ''; t.dispatchEvent(new Event('input', {bubbles: true})); })()");
  await runCode("function y = twice(x)\n  y = 2 * x; % doubled\nend");
  out = await runCode("twice(b)");
  ok(/6\s+10\s+14/.test(out), "a MATLAB function defined in a cell works in the next: " + JSON.stringify(out.trim()));
  out = await runCode("c = nothere + 1");
  ok(out.trim() === "Unrecognized function or variable 'nothere'.", "a MATLAB error is MATLAB's message: " + JSON.stringify(out.trim()));
  await runCode("plot(1:3, [2 4 3])");
  ok(await ev("!![...document.querySelectorAll('.cell')].at(-1).querySelector('.out svg, .out img')"), "a MATLAB figure is shown");
  // stacked scripts in the SVG, as rendered: a pair's two scripts start where its base ends, the text after
  // starts where the wider ends (narrow/wide both ways, nested)
  await runCode("plot(1:3)\nxlabel('a_{iiii}^W b')\ntitle('x^{a_1^2}_b c')\ntext(1.5, 2, 'a^{WWWW}_{iiii} b')");
  const stacked = await ev(`(() => {
    const svg = [...document.querySelectorAll('.cell')].at(-1).querySelector('.out svg');
    const find = (s) => [...svg.querySelectorAll('text')].find((t) => t.textContent === s);
    const at = (t, i) => [t.getStartPositionOfChar(i).x, t.getEndPositionOfChar(i).x];
    const near = (a, b) => Math.abs(a - b) < 0.05;
    const out = [];
    let t = find('a iiiiW b');
    if (!t) t = find('aiiiiW b');
    out.push(!!t && near(at(t, 1)[0], at(t, 0)[1]) && near(at(t, 5)[0], at(t, 1)[0]) && near(at(t, 6)[0], Math.max(at(t, 4)[1], at(t, 5)[1])));
    t = find('xa12b c');
    out.push(!!t && near(at(t, 1)[0], at(t, 0)[1]) && near(at(t, 3)[0], at(t, 2)[0]) && near(at(t, 4)[0], at(t, 1)[0]) && near(at(t, 5)[0], Math.max(at(t, 3)[1], at(t, 4)[1])));
    t = find('aWWWWiiii b');
    out.push(!!t && near(at(t, 5)[0], at(t, 1)[0]) && near(at(t, 9)[0], Math.max(at(t, 4)[1], at(t, 8)[1])));
    return out.join(' ');
  })()`);
  ok(stacked === "true true true", "MATLAB TeX: a stacked pair's scripts share their place, and the text after follows the wider (as rendered): " + stacked);
  // a MATLAB 3-D figure: the 3D view over its SVG, which a drag rotates
  await runCode("[X,Y] = meshgrid(-3:3);\nsurf(X,Y,peaks(X,Y))\ntitle(\"Original Sampling\")");
  const m3d = "[...document.querySelectorAll('.cell')].at(-1).querySelector('figure.plot3d')";
  ok(await ev(`!!${m3d}?.querySelector('svg')`), "a MATLAB 3-D figure shows as a 3D figure with its SVG");
  await sleep(500);
  // a scene the viewer refuses (a saved document's is untrusted): the SVG stays, saying why
  const refused = await ev(`(() => {
    const d = document.createElement('div');
    d.innerHTML = '<svg></svg>';
    document.body.appendChild(d);
    const r = window.SagebrushViewer3d.mount(d, { version: 1, lo: [0, 0, 0], hi: [1, 1, 1], scale: [2, 2, 2],
      objects: [{ type: 'lines', color: '#000000', width: 2, pos: new Array(6 * 125000).fill(0) }] });
    const why = d.querySelector('.sb3d-why')?.textContent ?? '';
    const still = d.querySelector('svg').style.display !== 'none' && !d.querySelector('canvas');
    d.remove();
    return r === false && still ? why : 'mounted';
  })()`);
  ok(/more than 2000000 vertices/.test(refused), "...a scene too big once drawn is refused: the SVG stays, saying why: " + JSON.stringify(refused.slice(0, 120)));
  // (mounting decodes each of a scene's base64 arrays once)
  const decodes = await ev(`(() => {
    const real = window.atob, b = (a) => btoa(String.fromCharCode(...new Uint8Array(a.buffer)));
    let n = 0;
    window.atob = (t) => { n++; return real(t); };
    const d = document.createElement('div');
    d.innerHTML = '<svg></svg>';
    document.body.appendChild(d);
    try {
      window.SagebrushViewer3d.mount(d, { version: 2, lo: [0, 0, 0], hi: [1, 1, 1], scale: [2, 2, 2], objects: [{ type: 'mesh2', color: '#ff0000',
        positions: b(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])), indices: b(new Uint32Array([0, 1, 2])) }] });
    } finally {
      window.atob = real;
      d.remove();
    }
    return n;
  })()`);
  ok(decodes === 2, "...a scene's base64 arrays are decoded once each when it is mounted: " + decodes);
  if (await ev(`!!${m3d}.querySelector('canvas')`)) {
    const at = await ev(`(() => { const c = ${m3d}.querySelector('canvas'); c.scrollIntoView(); const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, az: c.sagebrush.view.az }; })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
    for (let k = 1; k <= 10; k++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x + 12 * k, y: at.y, button: "left", buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x + 120, y: at.y, button: "left", clickCount: 1 });
    await sleep(300);
    const az = await ev(`${m3d}.querySelector('canvas').sagebrush.view.az`);
    ok(Math.abs(az - at.az) > 5, `...a drag rotates it (azimuth ${at.az} to ${az.toFixed(1)})`);
  }
  ok(await ev("[...document.querySelectorAll('.cell')].some(c => [...c.querySelectorAll('.hc')].some(e => e.textContent === '% doubled') && [...c.querySelectorAll('.hf')].some(e => e.textContent === 'twice'))"),
    "MATLAB code is highlighted as MATLAB (% comments, the function's name)");
  await ev("navigator.clipboard.writeText = async () => {}; document.querySelector('[data-f=share]').click()");
  await until("location.hash.includes('m=matlab')");
  const mlink = await ev("location.href");
  await send("Page.navigate", { url: "about:blank" });
  await send("Page.navigate", { url: mlink });
  await ready();
  await until("document.querySelector('#nbname').value === 'Shared notebook'");
  ok((await ev("document.querySelector('#mode').value")) === "matlab", "a MATLAB share link reopens in MATLAB mode");
  // the whiteboard (William): File > New whiteboard just under New notebook, ⋯ Whiteboard beside Console
  ok(await ev("(() => { const f = [...document.querySelectorAll('#filemenu [data-f]')].map((b) => b.dataset.f); return f.indexOf('whiteboard') === f.indexOf('new') + 1; })()"), "File: New whiteboard, just under New notebook");
  ok(await ev("document.querySelector('#consolebtn').nextElementSibling?.id === 'boardbtn'"), "⋯: Whiteboard, beside Console");
  // New whiteboard: a blank board in the notebook's language (MATLAB here), in Edit, at an address of its own
  await ev("document.querySelector('[data-f=whiteboard]').click(), 1");
  await until("location.pathname === '/board/' && /^\\?doc=local:[0-9a-f]{12}$/.test(location.search) && document.querySelector('[data-sbb=edit]')?.getAttribute('aria-pressed') === 'true'", 60000);
  const wb = await ev("({ search: location.search, mode: window.sagebrush.board.snapshot().doc.mode, items: window.sagebrush.board.snapshot().items.length })");
  ok(wb.mode === "matlab" && wb.items === 0, "New whiteboard: a blank MATLAB board, in Edit: " + JSON.stringify(wb));
  // ⋯ Whiteboard, back in the notebook: that board again, the latest in its language
  await send("Page.navigate", { url: mlink });
  await ready();
  await ev("document.querySelector('#boardbtn').click(), 1");
  await until(`location.pathname === '/board/' && location.search === ${JSON.stringify(wb.search)}`, 60000);
  ok(true, "⋯ Whiteboard: the latest board in the notebook's language");
  // leaving for the whiteboard waits for the notebook's saves: an edit made
  // just before, with a slow save, is kept; a save that fails keeps the
  // notebook open, saying so (CORR-7F9-1, after astra's probe)
  await send("Page.navigate", { url: url });
  await ready();
  await ev("document.querySelector('[data-f=new]').click(), 1");
  await sleep(500);
  await ev("(() => { const n = document.querySelector('#nbname'); n.value = 'WB save'; n.dispatchEvent(new Event('input')); window.sagebrush.notebook.flush(); return 1; })()");
  await sleep(1000);
  const docsIn = "import('/sagebrush-notebook.js').then(async (m) => { const db = await m.openDb(); return new Promise((res) => { const r = db.transaction('notebooks', 'readonly').objectStore('notebooks').getAll(); r.onsuccess = () => res(r.result.filter((d) => d.name === 'WB save').map((d) => d.cells.map((c) => c.code))); }); })";
  // (its store's saves slowed to 2 s, or made to fail)
  const slowStore = (fail) => ev(`import('/sagebrush-notebook.js').then(async (m) => { const db = await m.openDb(); const docs = await new Promise((r) => { const q = db.transaction('notebooks', 'readonly').objectStore('notebooks').getAll(); q.onsuccess = () => r(q.result); }); const d = docs.find((x) => x.name === 'WB save'); const store = new m.IdbStore(db, d.id), save = store.save.bind(store); store.save = async (doc) => { await new Promise((r) => setTimeout(r, 2000)); if (${fail}) throw new Error('disk full'); return save(doc); }; await window.sagebrush.notebook.attach(store); return 1; })`);
  await slowStore(true);
  await ev("(() => { const ta = window.sagebrush.notebook.cells()[0].ta; ta.value = 'not kept'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#boardbtn').click(); return 1; })()");
  await until("/whiteboard was not opened/.test(document.querySelector('#saved').textContent)", 10000);
  ok((await ev("location.pathname")) === "/", "a save that fails: the notebook stays open, and says the whiteboard wasn't opened: " + await ev("document.querySelector('#saved').textContent"));
  await slowStore(false);
  await ev("(() => { const ta = window.sagebrush.notebook.cells()[0].ta; ta.value = 'latest edit kept'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-f=whiteboard]').click(); return 1; })()");
  await until("location.pathname === '/board/' && !!window.sagebrush?.board?.snapshot()?.doc", 60000);
  const kept = await ev(docsIn);
  ok(JSON.stringify(kept) === JSON.stringify([["latest edit kept"]]), "New whiteboard with a slow save: the edit made just before is saved before leaving: " + JSON.stringify(kept));
  // (written elsewhere before each of its first n saves: a real conflict,
  // merged and saved again, after astra's probe)
  const conflictStore = (n) => ev(`import('/sagebrush-notebook.js').then(async (m) => { const db = await m.openDb(); const docs = await new Promise((r) => { const q = db.transaction('notebooks', 'readonly').objectStore('notebooks').getAll(); q.onsuccess = () => r(q.result); }); const d = docs.find((x) => x.name === 'WB save'); const store = new m.IdbStore(db, d.id), other = new m.IdbStore(db, d.id), save = store.save.bind(store); let k = 0; store.save = async (doc) => { if (k++ < ${n}) { const cur = await other.load(); await other.save({ ...cur, baseRev: cur.rev, other_writer: k }); } return save(doc); }; await window.sagebrush.notebook.attach(store); return 1; })`);
  const editAndGo = (text, sel) => ev(`(() => { const ta = window.sagebrush.notebook.cells()[0].ta; ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector(${JSON.stringify(sel)}).click(); return 1; })()`);
  // written elsewhere each time, more often than it tries: the notebook
  // stays open with the edit, from either entry (CORR-7F9-1)
  for (const [sel, what] of [["#boardbtn", "⋯ Whiteboard"], ["[data-f=whiteboard]", "New whiteboard"]]) {
    await send("Page.navigate", { url: url });
    await ready();
    await conflictStore(1e9);
    await editAndGo(`conflicted (${what})`, sel);
    await until("/whiteboard was not opened/.test(document.querySelector('#saved')?.textContent ?? '')", 20000).catch(() => {});
    const at = await ev("({ path: location.pathname, code: window.sagebrush?.notebook?.cells()[0]?.ta.value ?? null, said: document.querySelector('#saved')?.textContent ?? null })");
    ok(at.path === "/" && at.code === `conflicted (${what})`, `${what}, written elsewhere at every save: the notebook stays open with the edit, saying so: ${JSON.stringify(at)}`);
  }
  // written elsewhere twice: merged, the merge saved, then the whiteboard
  await send("Page.navigate", { url: url });
  await ready();
  await conflictStore(2);
  await editAndGo("kept after two conflicts", "#boardbtn");
  await until("location.pathname === '/board/' && !!window.sagebrush?.board?.snapshot()?.doc", 60000);
  const merged = await ev(docsIn);
  ok(JSON.stringify(merged) === JSON.stringify([["kept after two conflicts"]]), "⋯ Whiteboard, written elsewhere twice: the merge is saved before leaving: " + JSON.stringify(merged));
} catch (e) {
  console.log("ERROR", e.message);
  process.exitCode = 1;
} finally {
  ws.close();
  chrome.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), 500);
}
