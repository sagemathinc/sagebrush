// How a board opens (board.ts overview(), mount.ts look(); friction 6, 12,
// 13): all of it when that is legible (zoom LEGIBLE, 0.6, or more), clear
// of the title bar and the caption; a larger board at that zoom, from its
// start (top left), centered along an axis it fits, the rest a scroll away;
// the Show everything button and 0, all of it however small; Esc, the board
// as it opens again; a tour step, its items, as before.  Serve web/dist
// first (python3 web/serve.py 8765), then
//   node web/board/test-fit.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = Number(process.env.CDP_PORT ?? 9474), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-fit-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1200,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
const B = "window.sagebrush.board";
const key = async (k, code) => { await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k, windowsVirtualKeyCode: code }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code }); };
// (the camera still: a flight done)
const settled = async () => { let last = ""; for (let i = 0; i < 40; i++) { const c = await ev("JSON.stringify(window.board.camera)"); if (c === last) return; last = c; await sleep(120); } };
// the clear area (between the title bar and the caption) and where each item is on screen
const view = () => ev(`(() => {
  const b = window.board, r = b.el.getBoundingClientRect(), c = b.camera, top = document.querySelector('[data-sbb=top]').getBoundingClientRect().bottom;
  const t = document.querySelector('[data-sbb=tour]'), bottom = t.hidden ? innerHeight : t.getBoundingClientRect().top;
  const items = ${B}.snapshot().items.filter((i) => i.kind !== 'group').map((i) => ({ id: i.id, l: r.left + (i.x - c.x) * c.z, t: r.top + (i.y - c.y) * c.z, r: r.left + (i.x + i.w - c.x) * c.z, b: r.top + (i.y + i.h - c.y) * c.z }));
  return { z: c.z, top, bottom, left: r.left, right: r.right, items };
})()`);
const inClear = (v, i) => i.l >= v.left - 1 && i.r <= v.right + 1 && i.t >= v.top - 1 && i.b <= v.bottom + 1;
const T = "A change that does something useful, with a sentence or two of explanation that wraps onto a second line.";
const note = (i) => ({ id: "n" + i, title: `#${1070 + i} Something shipped`, text: T });
const load = async (d) => { await ev("history.replaceState(null, '', location.pathname + location.search)"); await ev(`${B}.load(${JSON.stringify(d)}).then(() => 1)`); await ev(`${B}.editing(false)`); await settled(); };

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/?runner=0` });
  if (!(await until(`${B}?.snapshot().items.length > 0`, 60000))) throw new Error("the board did not open");
  const LEGIBLE = 0.6;

  // a small board, with a caption: all of it, clear of the title bar and the caption (friction 13)
  await load({ title: "Small", intro: "**A small board.** It fits.", layout: "column", nodes: [0, 1, 2, 3].map(note) });
  let v = await view();
  check(v.z >= LEGIBLE && v.items.every((i) => inClear(v, i)), "a small board opens all of it, clear of the title bar and the caption: " + JSON.stringify({ z: v.z, top: v.top, bottom: v.bottom, out: v.items.filter((i) => !inClear(v, i)) }));

  // friction 6's page: a 3 by 3 grid and a row of releases, too large to read whole
  const DENSE = { title: "Dense", intro: "**This week.** Nine themes and the releases.", nodes: [
    { id: "g", kind: "group", title: "Themes", layout: "grid", columns: 3, children: Array.from({ length: 9 }, (_, i) => ({ ...note(i), text: T + " " + T })) },
    { id: "r", kind: "group", title: "Releases", layout: "row", children: Array.from({ length: 6 }, (_, i) => note(20 + i)) }], edges: [{ from: "g", to: "r" }] };
  await load(DENSE);
  v = await view();
  const first = v.items.find((i) => i.id === "n0");
  check(Math.abs(v.z - LEGIBLE) < 1e-6, "a page too large to read whole opens at the least legible zoom: " + v.z);
  check(first && inClear(v, first), "...its start (the first note) in view, clear of the bars: " + JSON.stringify(first));
  check(v.items.some((i) => !inClear(v, i)), "...the rest a scroll away");
  // (wider than the window: from its left; the releases row, the widest, starts at the margin)
  const left = Math.min(...v.items.map((i) => i.l));
  // (its notes a group's margin in from the board's left edge)
  check(left >= v.left && left <= v.left + 100, "...from its left, as it is wider than the window: " + left);
  // Show everything: all of it, however small
  await ev("document.querySelector('[data-sbb=fit]').click(), 1");
  await settled();
  v = await view();
  check(v.z < LEGIBLE && v.items.every((i) => inClear(v, i)), "Show everything: all of it, smaller: " + v.z);
  // Esc: the board as it opens again; 0: everything
  await key("Escape", 27);
  await settled();
  check(Math.abs((await view()).z - LEGIBLE) < 1e-6, "Esc: the board as it opens again: " + (await view()).z);
  await key("0", 48);
  await settled();
  v = await view();
  check(v.z < LEGIBLE && v.items.every((i) => inClear(v, i)), "0 (as the button says): everything: " + v.z);

  // tall and narrow: centered across, from its top
  await load({ title: "Tall", layout: "column", nodes: Array.from({ length: 14 }, (_, i) => note(i)) });
  v = await view();
  const xs = v.items.map((i) => (i.l + i.r) / 2), mid = (v.left + v.right) / 2;
  check(Math.abs(v.z - LEGIBLE) < 1e-6 && Math.abs(xs[0] - mid) < 2, "a tall narrow board: at the legible zoom, centered across: " + JSON.stringify({ z: v.z, x: xs[0], mid }));
  check(inClear(v, v.items.find((i) => i.id === "n0")), "...from its top");

  // a tour step: its items, as before (not held to the least zoom)
  await load({ ...DENSE, steps: [{ focus: ["g", "r"], say: "All of it." }] });
  await ev(`${B}.step(0)`);
  await settled();
  v = await view();
  check(v.z < LEGIBLE && v.items.every((i) => inClear(v, i)), "a tour step showing it all: all of it, as before: " + v.z);

  check(!errors.length, "no errors: " + errors.join(" | "));
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
