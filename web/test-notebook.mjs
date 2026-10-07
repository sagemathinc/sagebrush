// End-to-end checks of the notebook page in headless Chromium: notebooks and
// files persist across reloads, File > New/Open/Download/Upload, the files
// panel, share links.  Serve web/dist first:
//   bun web/build.ts && (cd web/dist && python3 -m http.server 8765) &
//   node web/test-notebook.mjs          (CHROME=... for another browser binary)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const url = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const profile = mkdtempSync(join(tmpdir(), "sb-notebook-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9337", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 100; i++) { try { targets = await (await fetch("http://127.0.0.1:9337/json")).json(); break; } catch { await sleep(100); } }
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
  await until("(() => { const c = [...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1); return /\\[\\d+\\]/.test(c.querySelector('.n').textContent); })()");
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
  await ev("(() => { const ta = [...document.querySelectorAll('.cell.markdown textarea')].at(-1); ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true})); })()");
  await until("[...document.querySelectorAll('.cell.markdown')].at(-1).classList.contains('rendered')");
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
  // export .ipynb
  await ev("window.__blobs = []; URL.createObjectURL = (b) => { window.__blobs.push(b); return 'blob:x'; }; document.querySelector('[data-f=ipynb]').click()");
  const ipynb = await ev("window.__blobs[0].text()");
  const j = JSON.parse(ipynb);
  ok(j.cells.filter((c) => c.cell_type === "markdown").length === 2, "ipynb export has the Markdown cells");
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
  await ev("(() => { const m = document.querySelector('#mode'); m.value = 'sage'; m.dispatchEvent(new Event('change')); })()");
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
  await until("!document.querySelector('#completer').hidden");
  const listed = await ev("[...document.querySelectorAll('#completer li')].map(li => li.textContent).join(' ')");
  ok((await ev("document.querySelector('#tabtest').value")) === "r = e.rank" && /\brank_bounds\b/.test(listed), "Tab completes e.ra to e.rank and lists " + listed);
  await key("ArrowDown");
  await key("Enter");
  ok((await ev("document.querySelector('#tabtest').value")) === "r = e." + listed.split(" ")[1] && (await ev("document.querySelector('#completer').hidden")), "↓ Enter accepts a listed completion");
  await ev("(() => { const ta = document.querySelector('#tabtest'); ta.select(); document.execCommand('insertText', false, 'if 1:\\n'); })()");
  await key("Tab");
  ok((await ev("document.querySelector('#tabtest').value")) === "if 1:\n    ", "Tab after whitespace still indents");
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
  out = await runCode("print(keep + 1)");
  ok(out.includes("42"), "...and the variables are kept: " + out.trim());
  out = await runAndStop("factor(100000000000000000000000012349 * 300000000000000000000000000823)", 1500);
  ok(/KeyboardInterrupt/.test(out), "Stop interrupts the Rust engine (ECM): " + JSON.stringify(out.trim().slice(-60)));
  out = await runCode("print(keep, factor(2^64 + 1))");
  ok(out.includes("41 274177 * 67280421310721"), "...the engine works after it, variables kept: " + out.trim());
  // Magma mode: translated to Python in the page
  await ev("(() => { const m = document.querySelector('#mode'); m.value = 'magma'; m.dispatchEvent(new Event('change')); })()");
  out = await runCode("R<x> := PolynomialRing(Integers());\nFactorization(x^4 - 1);\n[ p : p in [1..30] | IsPrime(p) ];");
  ok(out.includes("[\n    <x - 1, 1>,\n    <x + 1, 1>,\n    <x^2 + 1, 1>\n]\n[ 2, 3, 5, 7, 11, 13, 17, 19, 23, 29 ]"), "Magma mode runs Magma: " + JSON.stringify(out.trim().slice(0, 80)));
  out = await runCode("x := ;");
  ok(/bad syntax/.test(out), "a Magma syntax error is reported: " + JSON.stringify(out.trim().slice(0, 60)));
  await ev("(() => { const m = document.querySelector('#mode'); m.value = 'python'; m.dispatchEvent(new Event('change')); })()");
  // share link round trip
  await ev("navigator.clipboard.writeText = async () => {}; document.querySelector('[data-f=share]').click()");
  await until("location.hash.includes('z=')");
  const link = await ev("location.href");
  await send("Page.navigate", { url: "about:blank" });
  await send("Page.navigate", { url: link });
  await ready();
  await until("document.querySelector('#nbname').value === 'Shared notebook'");
  ok((await ev("[...document.querySelectorAll('textarea')].some(t => t.value.includes(\"open('up.csv')\"))")), `share link (${link.length} chars) opens the cells`);
} catch (e) {
  console.log("ERROR", e.message);
  process.exitCode = 1;
} finally {
  ws.close();
  chrome.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
}
