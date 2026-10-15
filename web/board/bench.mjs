// The board's speed budgets (design/board.md, "Fast"), measured in headless
// Chromium (CHROME=...): first paint, and frames while panning and zooming a
// synthetic board.  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/board/bench.mjs [items] [strokes]
// Prints JSON; exits 1 if a budget is missed (BOARD_BUDGET=0 to only report).
// First paint is the median of BOARD_RUNS loads (5), its budget 300 ms
// (400 where CI is set: a shared runner).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const items = Number(process.argv[2] ?? 2000), strokes = Number(process.argv[3] ?? 20000);
const runs = Math.max(1, Math.floor(Number(process.env.BOARD_RUNS ?? 5)) || 1);
const url = `${process.env.SB_URL ?? "http://127.0.0.1:8765/"}board/?items=${items}&strokes=${strokes}`;
const port = Number(process.env.CDP_PORT ?? 9450);
const profile = mkdtempSync(join(tmpdir(), "sb-board-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return; await sleep(50); } throw new Error("timeout: " + expr); };

const out = { items, strokes };
let failed = false;
try {
  await send("Page.enable");
  await send("Network.enable");
  // first paint: the median of several loads, each cold (a shared CI
  // runner's one slow sample is not the board's speed)
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  out.firstPaints = [];
  for (let i = 0; i < runs; i++) {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", { url });
    await until("typeof window.firstPaint === 'number'");
    out.firstPaints.push(Math.round(await ev("window.firstPaint")));
  }
  out.firstPaint = [...out.firstPaints].sort((a, b) => a - b)[Math.floor(runs / 2)];
  // the paths: camera positions, one per frame
  const paths = {
    // panning at 100%: notes as DOM, ink on the canvas
    pan100: "Array.from({ length: 400 }, (_, i) => ({ x: i * 12, y: i * 5, z: 1 }))",
    // panning at 200%
    pan200: "Array.from({ length: 300 }, (_, i) => ({ x: 2000 + i * 6, y: 1000 + i * 3, z: 2 }))",
    // zooming out to see everything and back (crossing to rectangles on the canvas)
    zoom: "Array.from({ length: 300 }, (_, i) => { const t = i < 150 ? i / 150 : (300 - i) / 150; return { x: 0, y: 0, z: Math.exp(Math.log(1) * (1 - t) + Math.log(0.04) * t) }; })",
    // panning far out: every note a rectangle, the ink thinned
    panFar: "Array.from({ length: 300 }, (_, i) => ({ x: i * 40, y: i * 10, z: 0.1 }))",
  };
  for (const [k, p] of Object.entries(paths)) out[k] = await ev(`boardBench(${p})`);
} catch (e) {
  out.error = String(e?.stack ?? e);
  failed = true;
} finally {
  ws.close();
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
// budgets (design/board.md): 60 fps (the render's own work well under a
// frame: 8 ms at the 95th percentile, so the browser has the rest), first
// paint under 300 ms (the median's; on a shared CI runner, CI set, 400)
const misses = [];
out.paintBudget = /^(1|true)$/i.test(process.env.CI ?? "") ? 400 : 300;
if (out.firstPaint > out.paintBudget) misses.push(`first paint ${out.firstPaint} ms > ${out.paintBudget}`);
for (const k of ["pan100", "pan200", "zoom", "panFar"]) if (out[k] && out[k].work.p95 > 8) misses.push(`${k}: render p95 ${out[k].work.p95.toFixed(1)} ms > 8`);
out.misses = misses;
console.log(JSON.stringify(out, (k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v), 2));
if (failed || (misses.length && process.env.BOARD_BUDGET !== "0")) process.exitCode = 1;
