// The notebook's Markdown cells written as blocks (web/board/blocks.ts, as a
// board's text is), in headless Chromium on the notebook page: a rendered
// cell double-clicked shows its blocks where the rendered text was (nothing
// moves), the block clicked becomes its Markdown; Enter at the end starts a
// block, Backspace at the start joins, the arrows cross blocks and leave the
// cell at its first and last lines; Shift+Enter shows the text and goes on,
// Esc is command mode; a paste is text; the cell's text is the Markdown,
// unchanged when nothing was changed.  Serve web/dist first (python3
// web/serve.py 8765), then
//   node web/test-notebook-blocks.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

const url = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-nbblocks-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1100,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
const click = async (x, y) => { await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); await sleep(60); };
const dblclick = async (x, y) => { await click(x, y); await mouse("mousePressed", x, y, { clickCount: 2 }); await mouse("mouseReleased", x, y, { clickCount: 2 }); await sleep(200); };
const CODES = { Enter: 13, Escape: 27, Delete: 46, Backspace: 8, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
const key = async (k, extra = {}) => {
  const p = { key: k, code: k, windowsVirtualKeyCode: CODES[k] ?? 0, nativeVirtualKeyCode: CODES[k] ?? 0, ...extra };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...(k === "Enter" ? { text: "\r" } : {}), ...p });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
  await sleep(60);
};
const type = (text) => send("Input.insertText", { text });
const NB = "sagebrush.notebook";
const C = (i) => `${NB}.cells()[${i}]`;
const active = () => ev("(() => { const t = document.activeElement; return t?.closest?.('.mb-edit') ? [t.value, t.selectionStart] : null; })()");
const caret = (k) => ev(`(() => { const t = document.activeElement; t.setSelectionRange(${k}, ${k}); return 1; })()`);

const RICH = "# Heading\n\nA paragraph with $x^2$ and **bold** text, long enough to wrap onto a second line in a cell of this width, or nearly so, and then some more words.\n\n- one\n- two\n\n> a quote\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n```python\nprint(1)\n```";
const TRICKY = "Tight\n- a\n  more of a\n- b\n\n\n1. x\n2. y\n\n$$\na\n\nb\n$$\nafter";
// the rendered parts' tops (an item each), relative to the cell
const tops = (sel) => ev(`(() => { const c = ${C(1)}.el, top = c.getBoundingClientRect().top, root = c.querySelector(${JSON.stringify(sel)}); return [...root.querySelectorAll('h1, :scope > p, .mb-block > p, li, blockquote, .math.display, pre.code, .mb-edit')].filter((e) => !e.closest('.mb-edit') || e.classList.contains('mb-edit')).map((e) => [e.classList.contains('mb-edit') ? 'edit' : e.tagName, Math.round((e.getBoundingClientRect().top - top) * 10) / 10]); })()`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url });
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
  await until("document.querySelectorAll('.cell').length > 0", 20000);
  // a notebook of three cells: code, Markdown (rendered), code
  await ev(`(async () => { const nb = ${NB}; const cs = nb.cells(); const a = nb.addCell("x = 1", { first: true }); const m = nb.addCell(${JSON.stringify(RICH)}, { after: a.el }, false, "markdown"); nb.addCell("y = 2", { after: m.el }); for (const c of cs) c.el.remove(); await nb.renderMd(m); return 1; })()`);
  await until(`${C(1)}.el.classList.contains('rendered') && !!${C(1)}.el.querySelector('.mdout .katex')`, 10000);
  check((await ev(`${NB}.cells().length`)) === 3, "three cells");
  await ev(`${C(1)}.el.scrollIntoView({ block: "start" }), scrollBy(0, -40), 1`);
  await sleep(200);
  // double-click the code block (the last): the blocks before it exactly where they were
  const before = await tops(".mdout");
  const pre = await ev(`(() => { const r = ${C(1)}.el.querySelector('.mdout pre.code').getBoundingClientRect(); return { x: r.left + 30, y: r.top + r.height / 2 }; })()`);
  await dblclick(pre.x, pre.y);
  check(await until(`${C(1)}.el.classList.contains('blocks') && !${C(1)}.el.classList.contains('rendered')`, 3000), "a double-click writes in the cell as blocks");
  const after = await tops(".mb");
  check(after.length === before.length && after.slice(0, -1).every(([t, y], i) => t === before[i][0] && Math.abs(y - before[i][1]) <= 1), "the blocks before the one written are where the rendered text was: " + JSON.stringify({ before, after }));
  check(after.at(-1)[0] === "edit" && Math.abs(after.at(-1)[1] - before.at(-1)[1]) <= 3, "the block written is where it was shown: " + JSON.stringify([before.at(-1), after.at(-1)]));
  check(JSON.stringify(await active()) === JSON.stringify(["```python\nprint(1)\n```", (await active())?.[1]]), "...its Markdown, the caret in it: " + JSON.stringify(await active()));
  // the paragraph: written in where it was clicked; typing changes the cell's text
  await key("Escape");
  await ev(`${NB}.renderMd(${C(1)})`);
  await until(`${C(1)}.el.classList.contains('rendered')`, 3000);
  const para = await ev(`(() => { const r = ${C(1)}.el.querySelector('.mdout > p').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 8 }; })()`);
  const h1top = (await tops(".mdout"))[0][1];
  await dblclick(para.x, para.y);
  const a1 = await active();
  check(a1?.[0]?.startsWith("A paragraph") && a1[1] <= 4, "a double-click on the paragraph writes in it, the caret at its start: " + JSON.stringify(a1));
  check(Math.abs((await tops(".mb"))[0][1] - h1top) <= 1, "the heading above it does not move");
  await caret(1e6);
  await type(" More.");
  check((await ev(`${C(1)}.ta.value`)).includes("some more words. More.\n\n- one"), "what is typed is the cell's text");
  // Enter at the end: a block; ArrowUp back; Backspace at the start joins
  await key("Enter");
  await type("New block");
  check((await ev(`${C(1)}.ta.value`)).includes("words. More.\n\nNew block\n\n- one"), "Enter at the end starts a block: " + JSON.stringify(await ev(`${C(1)}.ta.value`)));
  await caret(0);
  await key("ArrowUp");
  check((await active())?.[0]?.startsWith("A paragraph"), "ArrowUp on a block's first line: the block above");
  await key("ArrowDown");
  await caret(0);
  await key("Backspace");
  check((await active())?.[0]?.endsWith("words. More.New block"), "Backspace at the start joins it to the block above: " + JSON.stringify((await active())?.[0]?.slice(-30)));
  // a paste is its text, never its HTML
  await ev("(() => { const t = document.activeElement, dt = new DataTransfer(); dt.setData('text/plain', ' (pasted)'); dt.setData('text/html', '<b onclick=x>pasted</b>'); t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()");
  check((await active())?.[0]?.endsWith("More. (pasted)New block"), "a paste is text, at the caret: " + JSON.stringify((await active())?.[0]?.slice(-30)));
  // a change made elsewhere (an agent's) while it is written: the blocks show it
  await ev(`${NB}.setInput(${C(1)}, ${JSON.stringify("# Changed\n\n" + RICH.split("\n\n").slice(1).join("\n\n"))})`);
  check(await until(`${C(1)}.el.querySelector('.mb h1')?.textContent === 'Changed'`, 3000), "a change made elsewhere shows in the blocks");
  // the first line of the first block: ↑ goes to the cell above; the last line of the last: ↓ to the cell below
  const h = await ev(`(() => { const r = ${C(1)}.el.querySelector('.mb h1').getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; })()`);
  await click(h.x, h.y);
  check((await active())?.[0] === "# Changed", "a click on a block writes in it");
  await key("ArrowUp");
  check(await ev(`document.activeElement === ${C(0)}.ta`), "↑ on the first line of the first block: the cell above");
  await ev(`${NB}.edit(${C(1)}, "end")`);
  check((await active())?.[0] === "```python\nprint(1)\n```", "edit(cell, 'end') writes in the last block: " + JSON.stringify(await active()));
  await caret(1e6);
  await key("ArrowDown");
  check(await ev(`document.activeElement === ${C(2)}.ta`), "↓ on the last line of the last block: the cell below");
  // Shift+Enter: the text shown, the next cell written in; Esc: command mode
  await ev(`${NB}.edit(${C(1)}, "start")`);
  await key("Enter", { modifiers: 8 });
  check(await until(`${C(1)}.el.classList.contains('rendered') && !${C(1)}.el.classList.contains('blocks') && document.activeElement === ${C(2)}.ta`, 3000), "Shift+Enter shows the text and goes on to the next cell");
  check(await ev(`${C(1)}.el.querySelector('.mdout h1')?.textContent === 'Changed'`), "...rendered");
  const p2 = await ev(`(() => { const r = ${C(1)}.el.querySelector('.mdout h1').getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; })()`);
  await dblclick(p2.x, p2.y);
  await key("Escape");
  check(await ev(`document.activeElement === ${C(1)}.el && !${C(1)}.el.querySelector('.mb-edit') && !!${C(1)}.el.querySelector('.mb h1')`), "Esc: command mode, the blocks shown");
  // the text as it was when nothing changes
  await ev(`${NB}.setInput(${C(1)}, ${JSON.stringify(TRICKY)}), ${NB}.renderMd(${C(1)})`);
  await until(`${C(1)}.el.classList.contains('rendered')`, 3000);
  const t0 = await ev(`(() => { const r = ${C(1)}.el.querySelector('.mdout').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 8 }; })()`);
  await dblclick(t0.x, t0.y);
  await key("Escape");
  await ev(`${NB}.run(${C(1)})`);
  check((await ev(`${C(1)}.ta.value`)) === TRICKY, "written in and shown again with no change, the Markdown is the same: " + JSON.stringify(await ev(`${C(1)}.ta.value`)));
  // a new Markdown cell (+ Text): written as blocks at once; M makes a code cell Markdown, as blocks
  await ev(`${C(2)}.el.querySelector('[data-a=addmd]').click(), 1`);
  check(await until(`document.activeElement?.closest?.('.cell.markdown.blocks .mb-edit') && document.activeElement.placeholder.startsWith('Text')`, 3000), "+ Text: a new Markdown cell, written as blocks");
  await type("Fresh **text**");
  await key("Enter", { modifiers: 8 });
  check(await until(`${C(3)}.el.classList.contains('rendered') && ${C(3)}.ta.value === 'Fresh **text**' && !!${C(3)}.el.querySelector('.mdout strong')`, 3000), "...its text, shown");
  await ev(`${NB}.select(${C(2)})`);
  await key("m");
  check(await until(`${C(2)}.el.classList.contains('markdown') && ${C(2)}.el.classList.contains('blocks') && ${C(2)}.el.querySelector('.mb p')?.textContent === 'y = 2'`, 3000), "M makes a code cell Markdown, as blocks");
  // a heading written in (William's report, Oct 30): its field is as tall as the heading's line, on opening and as it
  // is typed, and its highlighted copy is where the field is, so nothing of the text is cut off (the cell's first
  // block too, which the page's first-child margin had moved down)
  const HEADS = "# Welcome to Sagebrush\n\n## Second heading gjpq\n\n### Third heading gjpq\n\nA paragraph.";
  const fits = `(() => { const ta = document.activeElement, box = ta.closest('.mb-edit'), pre = box.querySelector('pre');
    const rg = document.createRange(); rg.selectNodeContents(pre); const t = rg.getBoundingClientRect(), f = ta.getBoundingClientRect(), p = pre.getBoundingClientRect();
    let top = -Infinity, bottom = Infinity;
    for (let e = pre; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { const r = e.getBoundingClientRect(); top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); } }
    const m = { kind: box.className, scroll: ta.scrollHeight, client: ta.clientHeight, text: [t.top, t.bottom].map(Math.round), clip: [top, bottom].map(Math.round), field: Math.round(f.top), copy: Math.round(p.top) };
    return { ok: ta.scrollHeight <= ta.clientHeight && t.top >= top - 0.5 && t.bottom <= bottom + 0.5 && Math.abs(p.top - f.top) <= 0.5, m }; })()`;
  await ev(`${NB}.setInput(${C(1)}, ${JSON.stringify(HEADS)}), ${NB}.renderMd(${C(1)})`);
  for (const lv of [1, 2, 3]) {
    await ev(`${NB}.renderMd(${C(1)})`);
    await until(`${C(1)}.el.classList.contains('rendered') && !!${C(1)}.el.querySelector('.mdout h${lv}')`, 3000);
    const hd = await ev(`(() => { const r = ${C(1)}.el.querySelector('.mdout h${lv}').getBoundingClientRect(); return { x: r.left + 30, y: r.top + r.height / 2 }; })()`);
    await dblclick(hd.x, hd.y);
    const opened = await ev(fits);
    check(opened.ok && opened.m.kind.includes(`mb-h${lv}`), `H${lv} written in: its field fits its line and nothing is cut off: ` + JSON.stringify(opened.m));
    await caret(1e6);
    await type("x");
    const typed = await ev(fits);
    check(typed.ok, `H${lv} as it is typed: still nothing cut off: ` + JSON.stringify(typed.m));
    await key("Escape");
  }
  check(await ev("document.querySelectorAll('style[data-mb]').length === 1"), "the blocks' stylesheet is in the page once");
  check(!errors.length, "errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
