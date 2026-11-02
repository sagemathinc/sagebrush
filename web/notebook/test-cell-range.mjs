// B2n (William): a range of cells in the notebook, in headless Chromium on the notebook page, with real clicks and
// keys: a click selects a cell, a shift-click (or Shift+↓) the contiguous range from it; C, X and V copy, cut and paste
// all of it, the pasted cells in their order with their outputs and counts; a drag moves all of it; Z undoes a cut or a
// move as one; Esc and a plain click end the range.  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/notebook/test-cell-range.mjs        (SHOT=file.png: a screenshot with a range selected)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const url = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-range-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1100,1400", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
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
const SHIFT = 8;
const mouse = (type, x, y, modifiers = 0) => send("Input.dispatchMouseEvent", { type, x, y, modifiers, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
const CODES = { Escape: 27, ArrowUp: 38, ArrowDown: 40 };
const key = async (k, modifiers = 0) => {
  const p = { key: k, code: CODES[k] ? k : `Key${k.toUpperCase()}`, windowsVirtualKeyCode: CODES[k] ?? k.toUpperCase().charCodeAt(0), modifiers };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...p });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
  await sleep(80);
};
const NB = "sagebrush.notebook";
const C = (i) => `${NB}.cells()[${i}]`;
// (a click on cell i's gutter, below its prompt and run button: where a click selects the cell)
const gutter = async (i, modifiers = 0) => {
  const [x, y] = await ev(`(() => { ${C(i)}.el.scrollIntoView({ block: "center" }); const r = ${C(i)}.el.querySelector(".gutter").getBoundingClientRect(); return [r.left + 6, r.bottom - 4]; })()`);
  await mouse("mousePressed", x, y, modifiers);
  await mouse("mouseReleased", x, y, modifiers);
  await sleep(80);
};
// (the cells as [code, its output's text, its count], in order; the cells in the range; the active cell's index)
const state = () => ev(`(() => { const cs = ${NB}.cells(); return { cells: cs.map((c) => [c.ta.value, c.out.textContent, c.n.textContent]), range: cs.flatMap((c, i) => c.el.classList.contains("inrange") ? [i] : []), active: cs.indexOf(${NB}.active), ids: cs.map((c) => c.id) }; })()`);
const codes = (s) => s.cells.map((c) => c[0]).join(" ");
const J = JSON.stringify;
const DOC = { name: "Ranges", mode: "python", cells: [0, 1, 2, 3, 4].map((i) => ({ id: `r${i}`, code: `c${i}`, n: String(i + 1), outputs: [{ output_type: "stream", name: "stdout", text: `out${i}\n` }] })) };
const fresh = async () => {
  await ev(`(() => { ${NB}.load(${J(DOC)}); return 1; })()`);
  await until(`${NB}.cells().length === 5 && ${NB}.cells()[4].out.textContent === "out4\\n"`);
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url });
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
  await until("document.querySelectorAll('.cell').length > 0", 20000);
  await fresh();
  // a click selects a cell; a shift-click selects the range from it
  await gutter(1);
  let s = await state();
  check(s.active === 1 && s.range.length === 0, "a click on a cell selects it, no range: " + J(s));
  await gutter(3, SHIFT);
  s = await state();
  check(s.active === 1 && J(s.range) === J([1, 2, 3]) && (await ev("document.activeElement === " + C(1) + ".el")), "a shift-click selects the contiguous range from the selected cell, which keeps the focus: " + J({ range: s.range, active: s.active }));
  if (process.env.SHOT) { await sleep(200); writeFileSync(process.env.SHOT, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64")); }
  // copy, then paste below another cell: the copies in their order, with their outputs and counts, new ids, selected
  await key("c");
  await gutter(4);
  s = await state();
  check(s.active === 4 && s.range.length === 0, "a plain click ends the range: " + J(s.range));
  await key("v");
  s = await state();
  check(codes(s) === "c0 c1 c2 c3 c4 c1 c2 c3", "paste: the copied range below the cell, in order: " + codes(s));
  check(J(s.cells.slice(5)) === J([["c1", "out1\n", "[2]"], ["c2", "out2\n", "[3]"], ["c3", "out3\n", "[4]"]]), "paste keeps each cell's output and count: " + J(s.cells.slice(5)));
  check(new Set(s.ids).size === 8 && J(s.range) === J([5, 6, 7]) && s.active === 5, "the pasted cells are new cells (their own ids), selected as a range: " + J({ range: s.range, active: s.active }));
  // cut the pasted range; Z puts all of it back, in place, with its outputs
  await key("x");
  s = await state();
  check(codes(s) === "c0 c1 c2 c3 c4", "cut: the whole range removed: " + codes(s));
  await key("z");
  s = await state();
  check(codes(s) === "c0 c1 c2 c3 c4 c1 c2 c3" && s.cells[6][1] === "out2\n" && J(s.range) === J([5, 6, 7]), "Z after a cut puts the whole range back where it was, outputs too, selected: " + J({ codes: codes(s), range: s.range }));
  const saved = await ev(`${NB}.snapshot().cells.map((c) => c.code).join(" ")`);
  check(saved === "c0 c1 c2 c3 c4 c1 c2 c3", "…and the document (what is saved) has them in that order: " + saved);
  // Shift+↓ extends a range; Esc ends it
  await fresh();
  await gutter(0);
  await key("ArrowDown", SHIFT);
  await key("ArrowDown", SHIFT);
  s = await state();
  check(J(s.range) === J([0, 1, 2]), "Shift+↓ extends the range: " + J(s.range));
  await key("Escape");
  check((await state()).range.length === 0, "Esc ends the range");
  // a drag moves the whole range; Z moves it back
  await gutter(0);
  await gutter(1, SHIFT);
  await ev(`(() => {
    const dt = new DataTransfer(), g = ${C(0)}.el.querySelector(".gutter"), cs = ${NB}.cells(), last = cs.at(-1).el.getBoundingClientRect();
    g.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    cs[4].el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: last.bottom + 5 }));
    cs[4].el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: last.bottom + 5 }));
    g.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    return 1;
  })()`);
  await sleep(100);
  s = await state();
  check(codes(s) === "c2 c3 c4 c0 c1" && s.cells[3][1] === "out0\n" && J(s.range) === J([3, 4]), "a drag of a cell in the range moves all of it, outputs and all, still selected: " + J({ codes: codes(s), range: s.range }));
  await ev(`(() => { ${NB}.active.el.focus(); return 1; })()`);
  await key("z");
  s = await state();
  check(codes(s) === "c0 c1 c2 c3 c4" && s.cells[0][1] === "out0\n", "Z after a drag moves the range back: " + codes(s));
  // one cell, no range: copy and paste keeps its output too (before B2n, a paste had the code only)
  await gutter(2);
  await key("c");
  await key("v");
  s = await state();
  check(codes(s) === "c0 c1 c2 c2 c3 c4" && J(s.cells[3]) === J(["c2", "out2\n", "[3]"]), "one cell copied and pasted keeps its output and count: " + J(s.cells[3]));
  for (const e of errors) fails.push("page error: " + e);
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: ranges of cells, ${checks} checks`);
process.exit(0);
