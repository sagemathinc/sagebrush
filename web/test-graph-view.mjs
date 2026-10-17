// The canvas view of Graph.plot's picture (web/graph/view.ts), in the full
// page in headless Chromium: it replaces the SVG (kept, hidden); dragging a
// vertex moves it; Reset gives back the first picture, pixel for pixel;
// "Lay out again" with nothing moved ends on the first picture too (the
// same layout as Python's), and with a vertex moved keeps it where it was
// put; check() refuses malformed data. Serve web/dist first:
//   bun web/build.ts && (cd web/dist && python3 ../serve.py 8765) &
//   node web/test-graph-view.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-graphview-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1000,900", "--force-device-scale-factor=1", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
const until = async (expr, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
const CELLS = [
  "graphs.PetersenGraph().plot()",
  "DiGraph({0: {1: 'a'}, 1: {0: 'b', 1: 'c'}}, loops=True).plot(edge_labels=True)",
  "Graph([(i, (3 * i + 1) % 16) for i in range(16)] + [(i, i + 1) for i in range(15)]).plot()",
  "graphs.CycleGraph(5).plot() + point((0, 0))",
  "Graph([(i, (3 * i + 1) % 16) for i in range(16)] + [(i, i + 1) for i in range(15)]).plot(iterations=60)",
  "Graph([(0, 1, 'a'), (1, 2, 'b'), (2, 2, 'c'), (0, 0, 'd')], loops=True).plot(loop_size=2, edge_labels=True)",
  "DiGraph([(0, 1), (1, 0)]).plot(pos={0: (1000, 1000), 1: (1001, 1000)})",
  "graphs.CycleGraph(4).plot(title='T')",
];
const cv = (i) => `sagebrush.notebook.cells()[${i}].out.querySelector('figure.plotgraph canvas')`;
const png = (i) => ev(`${cv(i)}.toDataURL()`);
// a real drag (CDP mouse events), from vertex v of cell i's canvas by (ddx, ddy)
async function drag(i, v, ddx, ddy) {
  const p = await ev(`(() => { const c = ${cv(i)}; c.scrollIntoView(); const r = c.getBoundingClientRect(), s = c.sbGraph.screen(${v}); return { x: r.left + s.x, y: r.top + s.y }; })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
  for (let k = 1; k <= 5; k++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x + (ddx * k) / 5, y: p.y + (ddy * k) / 5, button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x + ddx, y: p.y + ddy, button: "left", clickCount: 1 });
}
const click = (i, text) => ev(`(() => { [...sagebrush.notebook.cells()[${i}].out.querySelectorAll('.sbgraph button')].find((b) => b.textContent === ${JSON.stringify(text)}).click(); return true; })()`);
try {
  await send("Page.navigate", { url: base });
  await until("window.sagebrush && document.querySelector('#status').textContent.startsWith('ready')");
  await ev(`(() => { sagebrush.notebook.replace({ mode: "sage", cells: ${JSON.stringify(CELLS.map((code, i) => ({ id: "g" + i, code })))} }); return true; })()`);
  await sleep(500);
  await ev("(async () => { const nb = sagebrush.notebook; for (const c of nb.cells()) await nb.run(c); return true; })()");
  await until(`!!${cv(0)} && !!${cv(1)} && !!${cv(2)}`);
  await sleep(300);
  const hidden = await ev("sagebrush.notebook.cells()[0].out.querySelector('figure.plotgraph svg').style.display");
  ok(hidden === "none", "the canvas is over the SVG, which is kept, hidden");
  ok(await ev("!sagebrush.notebook.cells()[3].out.querySelector('canvas') && !!sagebrush.notebook.cells()[3].out.querySelector('svg')"), "a graph's picture added to other graphics is plain Graphics: an SVG, no canvas");
  const label = await ev(`${cv(0)}.getAttribute('aria-label')`);
  ok(/^Plot: /.test(label ?? ""), "the canvas has the SVG's description: " + label);
  // drag and Reset
  const d0 = await png(0);
  const p0 = await ev(`${cv(0)}.sbGraph.pos(0)`);
  await drag(0, 0, 60, 40);
  const p1 = await ev(`${cv(0)}.sbGraph.pos(0)`);
  ok(p1.x > p0.x && p1.y < p0.y && JSON.stringify(await ev(`${cv(0)}.sbGraph.pinned()`)) === "[0]", `dragging vertex 0 moves it right and down, and pins it: ${JSON.stringify(p0)} -> ${JSON.stringify(p1)}`);
  ok((await png(0)) !== d0, "the picture changed");
  await click(0, "Reset");
  ok((await png(0)) === d0, "Reset gives back the first picture, pixel for pixel");
  // Lay out again with nothing moved: the same picture as Python's layout
  const s0 = await png(2);
  const before = await ev(`({ all: ${cv(2)}.sbGraph.all(), range: ${cv(2)}.sbGraph.range() })`);
  await click(2, "Lay out again");
  await until(`!${cv(2)}.sbGraph.busy()`, 60000);
  const after = await ev(`({ all: ${cv(2)}.sbGraph.all(), range: ${cv(2)}.sbGraph.range() })`);
  const same = (await png(2)) === s0;
  ok(same, "Lay out again with nothing moved ends on the first picture (Python's layout, the same seed)" + (same ? "" : ": " + JSON.stringify({
    pos: Math.max(...before.all.map((p, i) => Math.max(Math.abs(p[0] - after.all[i][0]), Math.abs(p[1] - after.all[i][1])))), before: before.range, after: after.range })));
  // ... and with a vertex moved, that vertex stays where it was put
  await drag(2, 3, -50, 30);
  const q = await ev(`${cv(2)}.sbGraph.pos(3)`);
  await click(2, "Lay out again");
  await until(`!${cv(2)}.sbGraph.busy()`, 60000);
  const q2 = await ev(`${cv(2)}.sbGraph.pos(3)`);
  ok(Math.abs(q2.x - q.x) < 1e-6 && Math.abs(q2.y - q.y) < 1e-6, `Lay out again keeps a moved vertex where it was put: ${JSON.stringify(q)} ${JSON.stringify(q2)}`);
  ok((await png(2)) !== s0, "... and the others move around it");
  // (GRAPH_SHOT=dir: pictures of the views, for people to look at)
  if (process.env.GRAPH_SHOT) {
    for (const i of [0, 1, 2]) {
      const r = await ev(`(() => { const w = ${cv(i)}.closest('.sbgraph'); w.scrollIntoView(); const b = w.getBoundingClientRect(); return { x: b.left + window.scrollX, y: b.top + window.scrollY, width: b.width, height: b.height }; })()`);
      const shot = await send("Page.captureScreenshot", { format: "png", clip: { ...r, scale: 1 } });
      writeFileSync(join(process.env.GRAPH_SHOT, `graph-view-${i}.png`), Buffer.from(shot.data, "base64"));
    }
  }
  // astra's CORR-4D6: "Lay out again" with nothing moved ends on the first
  // picture with iterations given (4) and with loops of size 2 and labels,
  // the range covering them as Python's does (5); a reciprocal pair far
  // from the origin is offset by 1.2% of its own extent (3); a picture with
  // a title is the SVG only (2)
  await until(`!!${cv(4)} && !!${cv(5)} && !!${cv(6)}`);
  for (const i of [4, 5]) {
    const before = await png(i), r0 = await ev(`${cv(i)}.sbGraph.range()`);
    await click(i, "Lay out again");
    await until(`!${cv(i)}.sbGraph.busy()`, 60000);
    const r1 = await ev(`${cv(i)}.sbGraph.range()`);
    ok((await png(i)) === before && JSON.stringify(r0) === JSON.stringify(r1), `cell ${i}: Lay out again with nothing moved ends on the first picture and range ${JSON.stringify(r0)} ${JSON.stringify(r1)}`);
  }
  const off = await ev(`${cv(6)}.sbGraph.offset()`);
  ok(Math.abs(off - 0.012) < 1e-12, "a reciprocal pair at (1000, 1000), (1001, 1000) is offset by 1.2% of its own extent: " + off);
  ok(await ev("!sagebrush.notebook.cells()[7].out.querySelector('canvas') && sagebrush.notebook.cells()[7].out.querySelector('svg')?.style.display === ''"), "a picture with a title is the SVG only, shown");
  // check() refuses malformed data, before anything is drawn
  const refusals = await ev(`(() => {
    const good = { format: 1, directed: false, nodes: [{ label: "0", x: 0, y: 0, color: "#fec7b8" }], edges: [], radius: 12, thickness: 1, dash: "-", loop: 0.1, offset: 0, label_background: null, spring: true, range: [-1, 1, -1, 1] };
    const bad = [
      { ...good, format: 2 },
      { ...good, nodes: Array.from({ length: 1501 }, () => good.nodes[0]) },
      { ...good, edges: [{ s: 0, t: 1, color: "black", label: null }] },
      { ...good, nodes: [{ ...good.nodes[0], color: "red;background:url(x)" }] },
      { ...good, nodes: [{ ...good.nodes[0], x: NaN }] },
      { ...good, nodes: [{ ...good.nodes[0], label: "x".repeat(201) }] },
      { ...good, dash: "dotted" },
      { ...good, range: [1, 1, 0, 1] },
    ];
    const out = bad.map((b) => { try { SagebrushGraphView.check(b); return "accepted"; } catch (e) { return e.message; } });
    let fine; try { SagebrushGraphView.check(good); fine = true; } catch { fine = false; }
    return { out, fine };
  })()`);
  ok(refusals.fine && refusals.out.every((m) => m !== "accepted"), "check() accepts good data and refuses each malformed one: " + JSON.stringify(refusals.out));
  // past the size cap (text) or with an oversized colour, refused before
  // anything is parsed or matched: the SVG stays, no canvas (HARD-4D6-1);
  // a graph as JSON (a saved notebook's) is read without serializing it
  const big = await ev(`(() => {
    const good = { format: 1, directed: false, nodes: [{ label: "0", x: 0, y: 0, color: "#fec7b8" }], edges: [], radius: 12, thickness: 1, dash: "-", loop: 0.1, offset: 0, label_background: null, spring: true, range: [-1, 1, -1, 1] };
    const tryMount = (data) => { const f = document.createElement('figure'); f.innerHTML = '<svg></svg>'; document.body.append(f); const r = SagebrushGraphView.mount(f, data); return [r, !!f.querySelector('canvas'), f.querySelector('svg').style.display, f.querySelector('.sbgraph-why')?.textContent ?? ""]; };
    return {
      text: tryMount(JSON.stringify({ ...good, junk: "x".repeat(8_000_001) })),
      colour: tryMount({ ...good, nodes: [{ ...good.nodes[0], color: "a".repeat(65) }] }),
      object: tryMount({ ...good, junk: new Array(10).fill("y") }),
    };
  })()`);
  ok(big.text[0] === false && !big.text[1] && big.text[2] === "" && /more than 8000000 characters/.test(big.text[3]), "a graph text past 8,000,000 characters is refused before it is parsed; the SVG stays, no canvas: " + big.text[3]);
  ok(big.colour[0] === false && !big.colour[1] && /colour/.test(big.colour[3]), "a colour longer than 64 characters is refused before the pattern: " + big.colour[3]);
  ok(big.object[0] === true && big.object[1], "a graph given as JSON (an .ipynb file's) is drawn, its other fields ignored");
  // a refused graph leaves the still picture, saying why
  const why = await ev(`(() => { const f = document.createElement('figure'); f.innerHTML = '<svg></svg>'; document.body.append(f); const r = SagebrushGraphView.mount(f, '{"format": 7}'); return [r, f.querySelector('.sbgraph-why')?.textContent, f.querySelector('svg').style.display]; })()`);
  ok(why[0] === false && /still picture/.test(why[1] ?? "") && why[2] === "", "refused data: the SVG stays, and it says why: " + why[1]);
} catch (e) {
  ok(false, String(e?.stack ?? e));
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
