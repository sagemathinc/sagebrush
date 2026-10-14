// Ink on a board (doc.ts strokes, board.ts, print.ts): strokes are drawn
// where they are, above the notes (a stroke over a note shows over it), a
// highlighter's see-through, still there far out; a group holds its
// strokes; printing draws them; TimeTravel keeps them; the board's file
// has them, their points on one line; a JSON Canvas says it left them out;
// a board downloaded as HTML draws them.  Serve web/dist first (python3
// web/serve.py 8765), then
//   node web/board/test-ink-board.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = Number(process.env.CDP_PORT ?? 9466), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ink-prof-"));
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
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const B = "window.sagebrush.board";
// a point of the board on the screen, and the color there (the darkest of the 3 x 3 around it)
const toClient = (x, y) => ev(`(() => { const r = window.board.el.getBoundingClientRect(), c = window.board.camera; return { x: r.left + (${x} - c.x) * c.z, y: r.top + (${y} - c.y) * c.z }; })()`);
const pixel = async (x, y) => {
  const p = await toClient(x, y);
  const r = await send("Page.captureScreenshot", { format: "png", clip: { x: p.x - 1, y: p.y - 1, width: 3, height: 3, scale: 1 } });
  const rgb = await ev(`new Promise((ok) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = 3; c.height = 3; const g = c.getContext("2d"); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, 3, 3).data; let best = [255, 255, 255]; for (let k = 0; k < 36; k += 4) if (d[k] + d[k + 1] + d[k + 2] < best[0] + best[1] + best[2]) best = [d[k], d[k + 1], d[k + 2]]; ok(best); }; i.src = "data:image/png;base64,${r.data}"; })`);
  return rgb;
};
const dark = ([r, g, b]) => r + g + b < 250;
const line = (x0, y0, x1, y1, k = 30, p = 0.5) => Array.from({ length: k }, (_, i) => [+(x0 + ((x1 - x0) * i) / (k - 1)).toFixed(1), +(y0 + ((y1 - y0) * i) / (k - 1)).toFixed(1), p]).flat();
// a note with a stroke across it; a group with a note and a red stroke; a highlighter's stroke
const DOC = {
  title: "Ink",
  nodes: [
    { id: "n1", title: "A note", text: "A stroke goes across this note, over it.\n\nAnd more text, to make it taller.", x: 0, y: 0, w: 260 },
    { id: "s1", kind: "ink", x: -30, y: 34, points: line(6, 6, 326, 6), size: 6 },
    { id: "g", kind: "group", title: "G", x: 500, y: 0, children: [{ id: "n2", title: "In G", x: 0, y: 0 }, { id: "s2", kind: "ink", x: 0, y: 90, points: line(4, 4, 204, 44), size: 4, color: "#c0392b" }] },
    { id: "s3", kind: "ink", x: 0, y: 300, points: line(10, 10, 310, 10), size: 20, color: "#facc15", opacity: 0.4 },
  ],
};

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/?runner=0&doc=${encodeURIComponent("examples/primes.json")}` });
  await until(`${B}?.snapshot().items.length > 0`, 60000);
  await ev("localStorage.clear(), 1");
  await ev(`${B}.load(${JSON.stringify(DOC)}).then(() => 1)`);
  await until(`${B}.snapshot().items.some((i) => i.id === "s3")`, 5000);
  const items = await ev(`${B}.snapshot().items.map((i) => ({ id: i.id, kind: i.kind, x: i.x, y: i.y, w: i.w, h: i.h }))`);
  const at = Object.fromEntries(items.map((i) => [i.id, i]));
  check(["s1", "s2", "s3"].every((id) => at[id]?.kind === "ink"), "the strokes are the board's items: " + JSON.stringify(items));
  check(at.s1 && Math.abs(at.s1.x + 30) < 0.5 && Math.abs(at.s1.y - 34) < 0.5 && Math.abs(at.s1.w - 332) < 1, "a stroke is where its document says, its box its points and its size around them: " + JSON.stringify(at.s1));
  check(at.g.x <= at.s2.x && at.s2.x + at.s2.w <= at.g.x + at.g.w && at.s2.y + at.s2.h <= at.g.y + at.g.h, "a group holds its stroke: " + JSON.stringify([at.g, at.s2]));
  // drawn: over the note, a highlighter see-through, and far out still
  await ev("window.board.setCamera({ x: -100, y: -100, z: 1.5 }), window.board.render(), 1");
  await sleep(300);
  const onNote = await pixel(136, 40), offStroke = await pixel(136, 75);
  check(dark(onNote) && !dark(offStroke), `a stroke over a note is drawn over it: ${onNote} on the stroke, ${offStroke} beside it`);
  const hl = await pixel(160, 310);
  check(hl[0] > 200 && hl[2] < 215 && hl[2] > 120, `a highlighter's stroke is see-through yellow: ${hl}`);
  const red = await pixel(at.s2.x + at.s2.w / 2, at.s2.y + at.s2.h / 2);
  check(red[0] > 150 && red[1] < 110 && red[2] < 110, `a stroke's own color: ${red}`);
  await ev("window.board.setCamera({ x: -300, y: -400, z: 0.35 }), window.board.render(), 1");
  await sleep(300);
  const far = await pixel(136, 40);
  check(far[0] + far[1] + far[2] < 600, `far out (zoom 0.35), the stroke is still drawn: ${far}`);
  // printing: a filled path a stroke, its color, the highlighter's opacity
  await ev(`${B}.print({ dialog: false }).then(() => 1)`);
  const printed = await ev("[...document.querySelectorAll('#board-print svg path')].map((p) => [p.getAttribute('fill'), p.getAttribute('fill-opacity'), p.getAttribute('d').length])");
  check(printed.length === 3 && printed.some(([f]) => f === "#1d241a") && printed.some(([f]) => f === "#c0392b") && printed.some(([f, o]) => f === "#facc15" && o === "0.4") && printed.every(([, , l]) => l > 100), "printed, each stroke a filled path with its color (the highlighter's opacity): " + JSON.stringify(printed));
  await ev("document.getElementById('board-print')?.remove(), 1");
  // the board's file: the strokes, their points on one line
  const file = await ev(`${B}.json()`);
  check(/"kind": "ink",\n\s+"x": -30,\n\s+"y": 34,\n\s+"points": \[6, 6, 0.5, /.test(file) && (file.match(/"kind": "ink"/g) ?? []).length === 3, "the board's file has its strokes, their points on one line:\n" + file.slice(0, 400));
  // a JSON Canvas leaves them out, and says so
  const cv = await ev(`${B}.canvas()`);
  check(/3 pen strokes/.test(cv.left) && !JSON.parse(cv.text).nodes.some((x) => /^s\d$/.test(x.id)), "a JSON Canvas leaves the strokes out, and says so: " + cv.left);
  // TimeTravel: a stroke moved, and the version before has it where it was
  await ev(`${B}.edit((d) => { d.nodes.find((x) => x.id === "s1").x = 70; }).then(() => 1)`);
  check(await until(`${B}.versions().then((v) => v.length >= 2)`, 5000), "moving a stroke is a version");
  const v0 = await ev(`${B}.versions().then((vs) => ${B}.version(vs.length - 2))`);
  const s1 = v0?.nodes?.find((x) => x.id === "s1");
  check(s1 && s1.x === -30 && s1.points.length === 90, "TimeTravel: the version before has the stroke where it was, all its points: " + JSON.stringify(s1)?.slice(0, 200));
  // downloaded as HTML: drawn there too
  await ev(`${B}.load(${JSON.stringify(DOC)}).then(() => 1)`);
  const html = await ev(`${B}.exportHtml()`);
  const f = join(profile, "ink.html");
  writeFileSync(f, html);
  await send("Page.navigate", { url: "file://" + f });
  await until(`${B}?.snapshot().items.some((i) => i.id === "s1")`, 30000);
  await ev("window.board.setCamera({ x: -100, y: -100, z: 1.5 }), window.board.render(), 1");
  await sleep(300);
  check(dark(await pixel(136, 40)), "a board downloaded as HTML draws its strokes");
  check(!errors.length, "errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
