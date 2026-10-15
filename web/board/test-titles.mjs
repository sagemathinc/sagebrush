// Groups' titles (board.ts, board.css, svg.ts; friction 10 and 11): drawn
// far out, every group's title is drawn, wrapper and long ones too, in the
// band the layout keeps above the group's members (not over them), at its
// level's size (16, 14, 13 px) or as large as that band allows, and cut
// with "…" to its group's width; near, one line, cut the same way (the SVG
// export: test-svg).  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-titles.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-titles-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1200,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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

const notes = (p, k) => Array.from({ length: k }, (_, i) => ({ id: `${p}${i}`, title: `#${1070 + i}`, text: "A change that does something useful, in a sentence or two." }));
const TITLES = { all: "24 PRs", rr: "Restart & resume (4)", se: "Sensors (scheduled wakes) (6)", wb: "Workbench, browser & tools (8)", ui: "UI (6)" };
const DOC = { title: "Group titles", nodes: [{ id: "all", kind: "group", title: TITLES.all, layout: "grid", columns: 2, children: [
  { id: "rr", kind: "group", title: TITLES.rr, layout: "grid", columns: 2, children: notes("r", 4) },
  { id: "se", kind: "group", title: TITLES.se, layout: "graph", children: notes("s", 6) },
  { id: "wb", kind: "group", title: TITLES.wb, layout: "grid", columns: 2, children: notes("w", 8) },
  { id: "ui", kind: "group", title: TITLES.ui, layout: "grid", columns: 3, children: notes("u", 6) },
] }] };

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/?runner=0` });
  if (!(await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000))) throw new Error("the board did not open");
  await ev(`window.sagebrush.board.load(${JSON.stringify(DOC)}).then(() => 1)`);
  await until("!!window.board.item('u5')");
  await sleep(800);
  // (what the canvas draws as text, in world units, as it is drawn again)
  const drawn = async () => ev(`(() => {
    const out = [], P = CanvasRenderingContext2D.prototype, fill = P.fillText;
    P.fillText = function (t, x, y, ...r) { out.push({ t, x, y, font: this.font, w: this.measureText(t).width }); return fill.call(this, t, x, y, ...r); };
    try { window.board.render(); } finally { P.fillText = fill; }
    return out;
  })()`);
  const box = (id) => ev(`(() => { const i = window.board.item(${JSON.stringify(id)}); return i && { x: i.x, y: i.y, w: i.w, h: i.h, inner: i.inner, depth: i.depth ?? 0 }; })()`);
  // (far out, the whole board on screen: zoom 0.3, not the fitted zoom, which
  // a compact layout puts near, where titles are the page's)
  const zoomTo = (z) => ev(`(() => { const b = window.board.bounds(), c = window.board.cameraFor(b.x0, b.y0, b.x1, b.y1); window.board.setCamera({ x: (b.x0 + b.x1) / 2 - window.board.el.clientWidth / 2 / ${z}, y: (b.y0 + b.y1) / 2 - window.board.el.clientHeight / 2 / ${z}, z: ${z} }); window.board.render(); return 1; })()`);
  await zoomTo(0.3);
  const z = await ev("window.board.camera.z");
  const fits = await ev("(() => { const b = window.board.bounds(); return (b.x1 - b.x0) * 0.3 <= window.board.el.clientWidth && (b.y1 - b.y0) * 0.3 <= window.board.el.clientHeight; })()");
  check(z === 0.3 && fits, "(far out, the whole board on screen: drawn on the canvas) " + z + " " + fits);
  const texts = await drawn();
  for (const [id, full] of Object.entries(TITLES)) {
    const g = await box(id), t = texts.find((d) => d.t === full || (d.t.endsWith("…") && full.startsWith(d.t.slice(0, -1)) && d.x >= g.x && d.x < g.x + 20 / z && d.y > g.y && d.y < g.inner.y));
    if (!t) { check(false, `the title of ${id} is drawn far out: ${full}; drawn: ${JSON.stringify(texts.map((d) => d.t))}`); continue; }
    check(true, "drawn: " + id);
    // (its size on screen: its level's, or as large as its band allows, never under 10 px)
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(t.font)[1]) * z, band = (g.inner.y - g.y) * z, want = Math.max(10, Math.min([16, 14][g.depth] ?? 13, band - 6));
    check(Math.abs(px - want) < 0.05, `${id}: its title at its level's size within its band: ${px} px, want ${want} (band ${band})`);
    // (in its band: its baseline above its members' top, by its descent at least)
    check(t.y + (0.25 * px) / z <= g.inner.y + 0.5 / z, `${id}: its title is drawn above its members, not over them: baseline ${t.y}, members from ${g.inner.y}`);
    check(t.w <= g.w - 12 / z + 0.5, `${id}: its title fits its group's width: ${t.w} of ${g.w}`);
  }
  const long = texts.find((d) => d.t.startsWith("Workbench"));
  check(long && long.t.endsWith("…") && long.t !== TITLES.wb, "a long title too wide for its group is cut with …: " + long?.t);
  check(texts.some((d) => d.t === TITLES.all), "the title of a group around other groups is drawn: " + TITLES.all);

  // near: the title one line, cut with "…" by the page, as tall as one line
  const NEAR = { title: "Near", nodes: [{ id: "wb", kind: "group", title: "Workbench, browser and tools, and a great deal more besides (8)", children: [{ id: "n1", title: "One", w: 160 }] }] };
  await ev(`window.sagebrush.board.load(${JSON.stringify(NEAR)}).then(() => 1)`);
  await until("!!window.board.item('n1')");
  await ev("(() => { const g = window.board.item('wb'); window.board.setCamera({ x: g.x - 20, y: g.y - 20, z: 1 }); window.board.render(); return 1; })()");
  await sleep(500);
  const near = await ev(`(() => { const el = window.board.cache.get('wb'), b = el?.querySelector(':scope > b'); if (!b) return null; const s = getComputedStyle(b);
    return { text: b.textContent, ws: s.whiteSpace, to: s.textOverflow, h: b.getBoundingClientRect().height, lh: parseFloat(s.fontSize) * 1.6, cut: b.scrollWidth > b.clientWidth }; })()`);
  check(near && near.text === NEAR.nodes[0].title && near.ws === "nowrap" && near.to === "ellipsis" && near.h <= near.lh, "near, a group's title is one line, cut with … when too long: " + JSON.stringify(near));
  check(near?.cut, "...this one is cut: " + JSON.stringify(near));

  // UI-0CC-1: far out, the band too small on screen, a title is never drawn
  // over its group's members: above the group where nothing is, else not
  // at all (zooms 0.3 down to 0.05; astra's group, its child 600 and 2000 wide)
  for (const w of [600, 2000]) {
    const LOW = { title: "Low", nodes: [{ id: "g", kind: "group", title: "Group title above its child", children: [{ id: "a", title: "Child", w, h: 300 }] }] };
    await ev(`window.sagebrush.board.load(${JSON.stringify(LOW)}).then(() => 1)`);
    await until("!!window.board.item('a')");
    for (const z of [0.3, 0.2, 0.1, 0.05]) {
      await zoomTo(z);
      const a = await box("a"), g = await box("g"), t = (await drawn()).filter((d) => /^Group|^G.*…$/.test(d.t) && d.t !== "Child");
      const over = t.filter((d) => { const f = Number(/(\d+(?:\.\d+)?)px/.exec(d.font)[1]); return d.x < a.x + a.w && d.x + d.w > a.x && d.y - 0.8 * f < a.y + a.h && d.y + 0.25 * f > a.y; });
      check(!over.length, `UI-0CC-1: width ${w}, zoom ${z}: the title not drawn over the group's child: ` + JSON.stringify(over.map((d) => [d.t, Math.round(d.y)])) + " child from " + a.y);
      if (w === 2000 && z <= 0.2) check(t.some((d) => d.y < g.y), `UI-0CC-1: width ${w}, zoom ${z}: drawn above the group, where nothing is: ` + JSON.stringify(t.map((d) => [d.t, Math.round(d.y), g.y])));
    }
  }
  // nested, far out: the inner group's title above it only where the outer's is not
  {
    const NEST = { title: "Nest", nodes: [{ id: "o", kind: "group", title: "Outer group", children: [{ id: "i", kind: "group", title: "Inner group", children: [{ id: "n", title: "Note", w: 900, h: 200 }] }] }] };
    await ev(`window.sagebrush.board.load(${JSON.stringify(NEST)}).then(() => 1)`);
    await until("!!window.board.item('n')");
    await zoomTo(0.12);
    const ts = (await drawn()).filter((d) => /group/.test(d.t)), n = await box("n");
    const rect = (d) => { const f = Number(/(\d+(?:\.\d+)?)px/.exec(d.font)[1]); return { x0: d.x, x1: d.x + d.w, y0: d.y - 0.8 * f, y1: d.y + 0.25 * f }; };
    const clash = ts.some((d, i) => ts.some((e, j) => j > i && rect(d).x0 < rect(e).x1 && rect(e).x0 < rect(d).x1 && rect(d).y0 < rect(e).y1 && rect(e).y0 < rect(d).y1));
    check(!clash && ts.every((d) => rect(d).y1 <= n.y + 0.5), "nested, far out: no two titles over each other, none over the note: " + JSON.stringify(ts.map((d) => [d.t, Math.round(d.y)])));
  }

  // UI-0CC-2: a title cut (or not drawn) shown whole: a hover over its band
  // (a tooltip), a click there in reading (and again, hidden), and Find
  const LONG = { title: "Long", nodes: [{ id: "lg", kind: "group", title: "Workbench, browser and tools, and a great deal more besides (8)", children: [{ id: "c1", title: "Child", w: 160 }] }] };
  await ev(`window.sagebrush.board.load(${JSON.stringify(LONG)}).then(() => 1)`);
  await until("!!window.board.item('c1')");
  await ev("window.sagebrush.board.editing(false), (() => { const g = window.board.item('lg'); window.board.setCamera({ x: g.x - 40, y: g.y - 40, z: 1 }); window.board.render(); return 1; })()");
  await sleep(400);
  const bandAt = () => ev("(() => { const g = window.board.item('lg'), r = window.board.el.getBoundingClientRect(), c = window.board.camera; return { x: r.left + (g.x + 30 - c.x) * c.z, y: r.top + (g.y + 20 - c.y) * c.z }; })()");
  let p = await bandAt();
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
  await sleep(100);
  check((await ev("window.board.el.title")) === LONG.nodes[0].title, "UI-0CC-2: a hover over a group's title band: its whole title, as a tooltip: " + (await ev("window.board.el.title")));
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y + 200 });
  await sleep(100);
  check(!(await ev("window.board.el.title")), "...and none away from it");
  const whole = () => ev("(() => { const b = window.board.cache.get('lg')?.querySelector(':scope > b'); return !!b && getComputedStyle(b).whiteSpace !== 'nowrap' && b.scrollWidth <= b.clientWidth + 1 && window.board.cache.get('lg').classList.length > 0; })()");
  const click = async (x, y) => { await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }); await sleep(250); };
  check(!(await whole()), "(near, its title cut to one line)");
  await click(p.x, p.y);
  check(await whole(), "UI-0CC-2: a click on its band shows its whole title");
  check(await ev("(() => { const g = window.board.cache.get('lg'), b = g.querySelector(':scope > b'); return b.getBoundingClientRect().right > g.getBoundingClientRect().right && !/paint/.test(getComputedStyle(g).contain); })()"), "...on one line past its narrow group, not clipped to it");
  await click(p.x, p.y);
  check(!(await whole()), "...a second, cut again");
  // far out: the whole title drawn on a click
  await zoomTo(0.3);
  p = await bandAt();
  await click(p.x, p.y);
  check((await drawn()).some((d) => d.t === LONG.nodes[0].title), "UI-0CC-2: far out, a click on its band draws its whole title");
  await click(p.x, p.y + 150);
  check(!(await drawn()).some((d) => d.t === LONG.nodes[0].title), "...a click elsewhere, cut again");
  // Find: the group found, its whole title shown
  await ev("(() => { const g = window.board.item('lg'); window.board.setCamera({ x: g.x - 40, y: g.y - 40, z: 1 }); window.board.render(); return 1; })()");
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 });
  await sleep(200);
  await send("Input.insertText", { text: "great deal more" });
  await sleep(300);
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(900);
  check(await whole(), "UI-0CC-2: Find, matching the title's end: its whole title shown");

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
