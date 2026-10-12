// The board page with a document (web/board/examples/*.json), in headless
// Chromium (CHROME=...): it loads without errors, its notes do not overlap
// and fit their text, each group holds its members, and the tour moves the
// camera.  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/test-board.mjs [doc.json]
// SHOT=dir also saves screenshots (the whole board, each tour step, zoomed in).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const doc = process.argv[2] ?? "examples/sagebrush.json";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const url = `${base}board/?doc=${encodeURIComponent(doc)}`;
const port = 9451;
const profile = mkdtempSync(join(tmpdir(), "sb-board-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [W, H] = (process.env.SIZE ?? "1280x800").split("x").map(Number);
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 100; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(), errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon/.test(m.params.entry.url ?? "")) errors.push(m.params.entry.text + " " + (m.params.entry.url ?? ""));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return; await sleep(50); } throw new Error("timeout: " + expr); };
const shot = async (name) => {
  if (!process.env.SHOT) return;
  mkdirSync(process.env.SHOT, { recursive: true });
  await sleep(600); // the flight, then a frame
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(process.env.SHOT, name + ".png"), Buffer.from(r.data, "base64"));
};

const fails = [];
const check = (ok, what) => { if (!ok) fails.push(what); };
try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 });
  await send("Page.navigate", { url });
  await until("window.sagebrush?.board?.snapshot().items.length > 0");
  await sleep(300);
  const s = await ev("window.sagebrush.board.snapshot()");
  const notes = s.items.filter((i) => i.kind === "note"), groups = s.items.filter((i) => i.kind === "group");
  console.log(`${notes.length} notes, ${groups.length} groups, ${s.doc.edges?.length ?? 0} edges, ${s.doc.steps?.length ?? 0} steps`);
  // no two boxes overlap unless one holds the other
  const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
  for (let i = 0; i < s.items.length; i++) for (let j = i + 1; j < s.items.length; j++) {
    const a = s.items[i], b = s.items[j];
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    check(!overlap || inside(a, b) || inside(b, a), `${a.id} and ${b.id} overlap`);
  }
  // each group holds its children
  const walk = (node) => {
    if (node.kind !== "group") return;
    const g = s.items.find((i) => i.id === node.id);
    for (const c of node.children) {
      check(inside(s.items.find((i) => i.id === c.id), g), `${c.id} is outside its group ${node.id}`);
      walk(c);
    }
  };
  s.doc.nodes.forEach(walk);
  // notes' text fits (fully zoomed in, at the whole board's camera, every mounted note)
  await ev("window.sagebrush.board.step(-1)");
  await shot("board");
  // (every note mounted: the camera on the whole board, at full size)
  const b = await ev("window.board.bounds()");
  const overflow = await ev(`window.board.setCamera({ x: ${b.x0}, y: ${b.y0}, z: 1 }), window.board.el.style.width = "${b.x1 - b.x0}px", window.board.el.style.height = "${b.y1 - b.y0}px", window.board.el.style.position = "relative", new Promise((r) => setTimeout(() => requestAnimationFrame(() => r([...document.querySelectorAll('.board-note')].filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.querySelector('b')?.textContent))), 300))`);
  const mounted = await ev("document.querySelectorAll('.board-note').length");
  check(mounted === notes.length, `${mounted} of ${notes.length} notes mounted to check their text`);
  await ev(`window.board.el.style.cssText = "", window.board.focus(undefined, true)`);
  check(!overflow.length, `text overflows: ${overflow.join(", ")}`);
  // math was typeset where the document has it
  if (/\$/.test(JSON.stringify(s.doc.nodes))) check(await ev("document.querySelectorAll('.board-note .katex').length > 0"), "no math typeset");
  // the tour moves the camera, and #N is its step
  for (let i = 0; i < (s.doc.steps?.length ?? 0); i++) {
    const before = await ev("JSON.stringify(window.board.camera)");
    await ev(`window.sagebrush.board.step(${i})`);
    await sleep(550);
    check((await ev("JSON.stringify(window.board.camera)")) !== before || i === 0, `step ${i + 1} did not move the camera`);
    check((await ev("location.hash")) === `#${i + 1}`, `step ${i + 1}: hash`);
    await shot(`step${String(i + 1).padStart(2, "0")}`);
  }
  if (process.env.SHOT) {
    await ev("window.board.setCamera({ x: window.board.bounds(['sched']).x0 - 40, y: window.board.bounds(['sched']).y0 - 40, z: 1.6 })");
    await shot("close");
  }
  check(!errors.length, "page errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
  if (errors.length) fails.push("page errors: " + errors.join(" | "));
  fails.push("the page says: " + (await ev("document.getElementById('say')?.textContent ?? ''").catch(() => "")));
} finally {
  ws.close();
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
if (fails.length) {
  console.log("FAIL\n  " + fails.join("\n  "));
  process.exit(1);
}
console.log("ok");
