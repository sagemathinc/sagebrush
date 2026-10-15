// The block Markdown editor (web/board/blocks.ts), as a note's text is
// written in place on a board, with the keyboard in headless Chromium: the
// text is blocks, each shown rendered until it is clicked, then its own
// Markdown; Enter at the end starts a block (a list's next item), Backspace
// at the start joins one to the block before, the arrows cross blocks,
// "# " makes a heading as it is typed, a paste is text; the Markdown comes
// back unchanged when nothing is changed.  Also: math in titles.  Serve
// web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-blocks.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = Number(process.env.CDP_PORT ?? 9459), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-blocks-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
const dblclick = async (x, y) => { await click(x, y); await mouse("mousePressed", x, y, { clickCount: 2 }); await mouse("mouseReleased", x, y, { clickCount: 2 }); await sleep(150); };
const CODES = { Enter: 13, Escape: 27, Delete: 46, Backspace: 8, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, End: 35, Home: 36 };
const key = async (k, extra = {}) => {
  const p = { key: k, code: k, windowsVirtualKeyCode: CODES[k] ?? 0, nativeVirtualKeyCode: CODES[k] ?? 0, ...extra };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...(k === "Enter" ? { text: "\r" } : {}), ...p });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
  await sleep(40);
};
const type = (text) => send("Input.insertText", { text });
const text = (id) => ev(`window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === ${JSON.stringify(id)})?.text`);
const rect = (id) => ev(`window.board.clientRect(${JSON.stringify(id)})`);
const outside = async () => { await click(1200, 760); await sleep(250); };
// the blocks as shown: rendered (their kind) or being written ("edit:" its Markdown)
const blocks = () => ev("[...document.querySelector('.board-editing .mb').children].map((v) => v.classList.contains('mb-edit') ? 'edit:' + v.querySelector('textarea').value : v.className.replace('mb-block mb-', ''))");
const active = () => ev("(() => { const t = document.activeElement; return t?.closest?.('.mb-edit') ? [t.value, t.selectionStart] : null; })()");
const caret = (k) => ev(`(() => { const t = document.activeElement; t.setSelectionRange(${k}, ${k}); return 1; })()`);
// (a block's middle, the board panned to show it first)
const blockAt = (i) => ev(`(() => { const v = document.querySelector('.board-editing .mb').children[${i}]; let r = v.getBoundingClientRect(); if (r.bottom > innerHeight - 20) { window.board.panBy(0, r.bottom - innerHeight + 120); window.board.render(); r = v.getBoundingClientRect(); } return { x: r.left + 4, y: r.top + r.height / 2 }; })()`);

const RICH = "# Heading\n\nA paragraph with $x^2$ and [a link](https://example.org).\n\n- one\n- two\n\n> a quote\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n```python\nprint(1)\n\nprint(2)\n```";
const TRICKY = [
  "Tight\n- a\n  more of a\n- b\n\n\n1. x\n2. y",
  "Para one\nstill one\n  \nPara two",
  "$$\na\n\nb\n$$\nafter",
  "```\nunclosed\n\nfence",
];
const DOC = {
  title: "Blocks",
  nodes: [
    { id: "r", title: "Rich", text: RICH, x: 0, y: 0, w: 420 },
    ...TRICKY.map((t, i) => ({ id: "t" + i, title: "T" + i, text: t, x: 600 + 400 * i, y: 0, w: 320 })),
    { id: "m", title: "Area $\\pi r^2$ of a disc", text: "x", x: 0, y: 900, w: 300 },
  ],
  edges: [],
};
const open = async (id, at = { dx: 40, dy: 14 }) => {
  await ev(`(() => { const it = window.board.item(${JSON.stringify(id)}); window.board.setCamera({ x: it.x - 200, y: it.y - 160, z: 1 }); window.board.render(); return 1; })()`);
  await sleep(100);
  const r = await rect(id);
  await dblclick(r.left + at.dx, r.top + at.dy);
  return until(`window.board.editing === ${JSON.stringify(id)}`, 3000);
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/` });
  // (the page's own board shown first: loaded before it, ours would be replaced by it, as on CI once)
  if (!(await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000))) throw new Error("the page's board was not shown");
  await ev("localStorage.clear()");
  await ev(`window.sagebrush.board.load(${JSON.stringify(DOC)}).then(() => 1)`);
  await ev("window.sagebrush.board.editing(true)");
  // (laid out: on a slow machine the items come a moment after load)
  if (!(await until("window.sagebrush.board.snapshot().doc?.title === 'Blocks' && !!window.board?.item('m')", 20000))) throw new Error("the test's board was not shown: " + await ev("window.sagebrush.board.snapshot().doc?.title"));

  // math in a title: typeset (KaTeX), not shown as $...$
  await ev("(() => { const it = window.board.item('m'); window.board.setCamera({ x: it.x - 100, y: it.y - 100, z: 1 }); window.board.render(); return 1; })()");
  check(await until("[...document.querySelectorAll('.board-note > b')].some((b) => b.querySelector('.katex') && b.textContent.startsWith('Area') && !b.textContent.includes('$'))", 8000), "math in a title is typeset");
  check(await ev("window.sagebrush.board.snapshot().doc.nodes.find((x) => x.id === 'm').title === 'Area $\\\\pi r^2$ of a disc'"), "...the title is unchanged");
  check(await ev("(() => { window.board.setCamera({ ...window.board.camera, z: 0.1 }); window.board.render(); return 1; })()") && true, "(far out)");
  await ev("(() => { window.board.setCamera({ ...window.board.camera, z: 1 }); window.board.render(); return 1; })()");

  // nothing changed: the Markdown comes back exactly
  for (const id of ["r", "t0", "t1", "t2", "t3"]) {
    const before = await text(id);
    check(await open(id), `${id}: being edited`);
    await outside();
    check((await text(id)) === before, `${id}: left unchanged, its Markdown is the same: ${JSON.stringify(await text(id))}`);
  }

  // the blocks, rendered; a click on one writes in it, the others stay rendered
  check(await open("r", { dx: 40, dy: 10 }), "the rich note is being edited");
  const kinds = await blocks();
  check(JSON.stringify(kinds) === JSON.stringify(["heading", "paragraph", "item", "item", "quote", "math", "code"]), "the text is blocks: " + JSON.stringify(kinds));
  check(await ev("!!document.querySelector('.board-editing .mb-heading h1') && !!document.querySelector('.board-editing .mb-paragraph .katex') && !!document.querySelector('.board-editing .mb-math .katex-display')"), "each rendered (math typeset)");
  // a click on a block (here on its link, which is not followed) writes in it; the others stay rendered
  const href = await ev("location.href");
  let p = await ev("(() => { const r = document.querySelector('.board-editing .mb-paragraph a').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  await click(p.x, p.y);
  let b = await blocks();
  check(b[1] === "edit:A paragraph with $x^2$ and [a link](https://example.org)." && b.filter((x) => x.startsWith("edit:")).length === 1, "a click on a block: its Markdown, the others rendered: " + JSON.stringify(b));
  check((await ev("location.href")) === href, "...a link clicked in it is not followed");
  check(await ev("document.activeElement === document.querySelector('.board-editing .mb-edit textarea')"), "...and its field has the caret");
  check(await ev("!!document.querySelector('.board-editing .mb-edit pre .hd')"), "...highlighted (its math)");
  // Enter at the end: a new block after it
  await caret(1e6);
  await key("Enter");
  await type("New one");
  b = await blocks();
  check(b[1] === "paragraph" && b[2] === "edit:New one" && b.length === 8, "Enter at the end starts a block after it: " + JSON.stringify(b));
  // Shift+Enter is a new line in the block
  await caret(3);
  await key("Enter", { modifiers: 8 });
  check((await active())?.[0] === "New\n one", "Shift+Enter is a new line in the block: " + JSON.stringify(await active()));
  // Backspace at the start joins it to the block before, the caret where they meet
  await caret(0);
  await key("Backspace");
  let a = await active();
  const P = "A paragraph with $x^2$ and [a link](https://example.org).";
  check(a?.[0] === P + "New\n one" && a[1] === P.length, "Backspace at the start joins it to the block before: " + JSON.stringify(a));
  await ev("(() => { const t = document.activeElement; t.value = 'A paragraph.'; t.dispatchEvent(new Event('input')); t.setSelectionRange(12, 12); return 1; })()");
  // the arrows cross blocks
  await key("ArrowDown");
  check((await active())?.[0] === "- one", "ArrowDown on the last line: the next block: " + JSON.stringify(await active()));
  await key("ArrowUp");
  check((await active())?.[0] === "A paragraph.", "ArrowUp on the first line: the block before: " + JSON.stringify(await active()));
  await caret(1e6);
  await key("ArrowRight");
  check((await active())?.join() === "- one,0", "ArrowRight at the end: the start of the next block: " + JSON.stringify(await active()));
  await key("ArrowLeft");
  check((await active())?.join() === "A paragraph.,12", "ArrowLeft at the start: the end of the block before: " + JSON.stringify(await active()));
  // a list: Enter at the end of an item, the next item; on an empty item, the list ends
  await key("ArrowRight");
  await caret(1e6);
  await key("Enter");
  check((await active())?.[0] === "- ", "Enter at the end of an item: the next item: " + JSON.stringify(await active()));
  await type("mid");
  await key("Enter");
  await key("Enter");
  check((await active())?.[0] === "", "Enter on an empty item ends the list: " + JSON.stringify(await active()));
  // "# " makes a heading as it is typed
  await type("# Big");
  check(await ev("document.querySelector('.board-editing .mb-edit').classList.contains('mb-h1') && parseFloat(getComputedStyle(document.querySelector('.board-editing .mb-edit textarea')).fontSize) >= 24"), "\"# \" at the start: a heading as it is typed");
  // Backspace at the start of the first block takes its marker off
  p = await blockAt(0);
  await click(p.x + 30, p.y);
  await caret(0);
  await key("Backspace");
  check((await active())?.[0] === "Heading", "Backspace at the start of the first block: its marker goes: " + JSON.stringify(await active()));
  await ev("(() => { const t = document.activeElement; t.value = '# Heading'; t.dispatchEvent(new Event('input')); return 1; })()");
  // Delete at the end joins the next block to it (its marker dropped)
  await caret(1e6);
  await key("ArrowDown");
  await caret(1e6);
  await key("Delete");
  check((await active())?.[0] === "A paragraph.one", "Delete at the end joins the next block to it: " + JSON.stringify(await active()));
  await ev("(() => { const t = document.activeElement; t.value = 'A paragraph.\\n\\n- one'; t.dispatchEvent(new Event('input')); t.setSelectionRange(12, 12); return 1; })()");
  // a paste is its text, never its HTML; with blank lines it makes blocks once left
  await ev("(() => { const t = document.activeElement, dt = new DataTransfer(); dt.setData('text/plain', ' Then\\n\\nSecond pasted'); dt.setData('text/html', '<p onclick=x>Then</p><p>Second</p>'); t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()");
  check((await active())?.[0] === "A paragraph. Then\n\nSecond pasted\n\n- one", "a paste is its text: " + JSON.stringify(await active()));
  // fenced code: Enter is a new line until it is closed
  p = await blockAt((await blocks()).length - 1);
  await click(p.x + 30, p.y);
  b = await blocks();
  check(JSON.stringify(b.slice(0, 8)) === JSON.stringify(["heading", "paragraph", "paragraph", "item", "item", "heading", "item", "quote"]), "what was pasted is blocks, once left: " + JSON.stringify(b));
  await ev("(() => { const t = document.activeElement; t.value = '```python\\nprint(1)'; t.dispatchEvent(new Event('input')); t.setSelectionRange(t.value.length, t.value.length); return 1; })()");
  await key("Enter");
  check((await active())?.[0] === "```python\nprint(1)\n", "in unclosed fenced code, Enter is a new line: " + JSON.stringify(await active()));
  await type("```");
  await outside();
  const t = await text("r");
  check(t === "# Heading\n\nA paragraph. Then\n\nSecond pasted\n\n- one\n- mid\n# Big\n- two\n\n> a quote\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n```python\nprint(1)\n```", "the text kept is the blocks' Markdown: " + JSON.stringify(t));
  check(await until("!!document.querySelector('.board-note h1') && [...document.querySelectorAll('.board-note p')].some((x) => x.textContent === 'Second pasted')", 3000), "shown again, rendered");
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
