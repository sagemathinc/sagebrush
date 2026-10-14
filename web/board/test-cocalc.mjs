// CoCalc whiteboards as Sagebrush boards (web/board/cocalc.ts), opened with
// the ⋯ menu's Open… in headless Chromium: a current .board (pages, notes,
// texts, code, frames within frames, edges, and what a board has nothing
// like) and one from before page ids and CoCalc's schema version 1.  Serve
// web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-cocalc.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = Number(process.env.CDP_PORT ?? 9461), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-cocalc-"));
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
const B = "window.sagebrush.board";
const docOf = () => ev(`JSON.parse(JSON.stringify(${B}.snapshot().doc))`);
// Open… with a file (the picker's input given it through the DevTools protocol)
const open = async (name, text) => {
  const f = join(profile, name);
  writeFileSync(f, text);
  await ev("document.querySelector('[data-sbb=open]').click(), 1");
  const d = await send("DOM.getDocument", { depth: -1 });
  const q = await send("DOM.querySelector", { nodeId: d.root.nodeId, selector: "[data-sbb=openfile]" });
  await send("DOM.setFileInputFiles", { files: [f], nodeId: q.nodeId });
  await sleep(800);
};
const jsonl = (els) => els.map((e) => JSON.stringify(e)).join("\n") + "\n";

// a current CoCalc board: two pages; on the first, a frame holding a note,
// a highlighter's stroke and a frame holding a code cell; texts, math, an
// edge, a pen stroke and an edge to it, and things a board has nothing like
// (a timer, a hidden note), a selection (not content), speaker notes; an icon (a sticker)
const CURRENT = jsonl([
  { id: "p1", type: "page", z: 0, data: { pos: 0, schemaVersion: 1 } },
  { id: "p2", type: "page", z: 0, data: { pos: 1, schemaVersion: 1 } },
  { id: "f1", type: "frame", x: 100, y: 100, w: 900, h: 700, z: 1, page: "p1", str: "Ideas" },
  { id: "f2", type: "frame", x: 500, y: 300, w: 450, h: 400, z: 2, page: "p1" },
  { id: "n1", type: "note", x: 150, y: 200, w: 250, h: 120, z: 3, page: "p1", str: "A note with \\(x^2\\) in it", data: { color: "#e8edfa" } },
  { id: "c1", type: "code", x: 550, y: 350, w: 360, h: 100, z: 4, page: "p1", str: "print(2^10)", data: { kernel: "sage-10.4", hideInput: true, output: { 0: { text: "1024" } } } },
  { id: "t1", type: "text", x: 1200, y: 100, w: 300, h: 60, z: 5, page: "p1", str: "# Plain text" },
  { id: "n2", type: "note", x: 1200, y: 400, w: 200, h: 100, z: 6, page: "p1", str: "No color of its own" },
  { id: "e1", type: "edge", x: 0, y: 0, w: 0, h: 0, z: 7, page: "p1", data: { from: "n1", to: "t1" } },
  { id: "pen1", type: "pen", x: 0, y: 0, w: 10, h: 10, z: 8, page: "p1", data: { path: [0, 0, 5, 5, 10, 10], color: "#000" } },
  { id: "e2", type: "edge", x: 0, y: 0, w: 0, h: 0, z: 9, page: "p1", data: { from: "n1", to: "pen1" } },
  { id: "pen2", type: "pen", x: 300, y: 500, w: 200, h: 40, z: 14, page: "p1", data: { path: [0, 0, 50, 20, 100, 40, 150, 20, 200, 0], color: "#c0392b", radius: 3, opacity: 0.4, nib: "chisel" } },
  { id: "tm", type: "timer", x: 0, y: 0, w: 100, h: 50, z: 10, page: "p1", data: { countdown: 60 } },
  { id: "ic", type: "icon", x: 0, y: 0, w: 50, h: 50, z: 11, page: "p1", data: { icon: "star" } },
  { id: "hid", type: "note", x: 0, y: 0, w: 50, h: 50, z: 12, page: "p1", str: "hidden", invisible: true },
  { id: "sel", type: "selection", x: 0, y: 0, w: 50, h: 50, z: 13, page: "p1" },
  { id: "n3", type: "note", x: 0, y: 0, w: 260, h: 100, z: 1, page: "p2", str: "On the second page" },
  { id: "sp", type: "speaker_notes", x: 0, y: 0, w: 0, h: 0, z: 0, page: "p2", str: "Say this", invisible: true },
]);
// before page ids (page numbers) and schema version 1: \( was an escaped parenthesis, not math
const LEGACY = jsonl([
  { id: "a", type: "note", x: 0, y: 0, w: 300, h: 100, z: 1, page: 1, str: "Old \\(not math\\) and \\[brackets\\]" },
  { id: "b", type: "text", x: 0, y: 0, w: 300, h: 100, z: 1, page: 2, str: "Page two" },
]);

try {
  for (const m of ["Page.enable", "Runtime.enable", "DOM.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/` });
  await until(`${B}?.snapshot().items.length > 0`, 60000);
  await ev("localStorage.clear()");

  await open("ideas.board", CURRENT);
  let d = await docOf();
  check(d.format === "sagebrush-board" && d.version === 1 && d.title === "ideas", "a CoCalc board opens as a board, titled by its file: " + JSON.stringify([d.format, d.title]));
  check(d.pages?.length === 2 && d.pages[0].title === "Page 1" && d.pages[1].title === "Page 2", "its pages, in order: " + JSON.stringify(d.pages?.map((p) => p.title)));
  check(d.mode === "sage", "a Sage kernel makes the board Sage");
  const p1 = d.pages[0];
  const f1 = p1.nodes.find((x) => x.id === "f1"), f2 = f1?.children?.find((x) => x.id === "f2");
  check(f1?.kind === "group" && f1.title === "Ideas" && f2?.kind === "group" && !f2.title, "frames are groups, a frame within a frame a group within a group: " + JSON.stringify(p1.nodes.map((x) => x.id)));
  check(f1?.children?.some((x) => x.id === "n1") && f2?.children?.some((x) => x.id === "c1"), "what a frame holds is in its group");
  const n1 = f1?.children?.find((x) => x.id === "n1"), c1 = f2?.children?.find((x) => x.id === "c1");
  check(n1?.text === "A note with \\(x^2\\) in it" && n1.color === "#e8edfa" && n1.w === 250, "a note: its Markdown (math kept), color and width: " + JSON.stringify(n1));
  check(c1?.code === "print(2^10)" && c1.hideCode === true && !("output" in c1), "a code cell: its code, its input hidden, no outputs: " + JSON.stringify(c1));
  const t1 = p1.nodes.find((x) => x.id === "t1"), n2 = p1.nodes.find((x) => x.id === "n2");
  check(t1?.text === "# Plain text" && !t1.color && n2?.color === "#fff9c4", "a text is a note without a color; a note without one has CoCalc's");
  check(JSON.stringify(p1.edges) === JSON.stringify([{ from: "n1", to: "t1" }, { from: "n1", to: "pen1" }]), "the edges are kept, the one to a pen stroke too: " + JSON.stringify(p1.edges));
  check(!JSON.stringify(d).includes("hidden") && !JSON.stringify(d).includes('"sel"'), "nothing of what was left out is in the board");
  // pen strokes: strokes, as wide as CoCalc drew them (2 radius), their color, a highlighter's opacity, in their frame's group
  const pen1 = p1.nodes.find((x) => x.id === "pen1"), pen2 = f1?.children?.find((x) => x.id === "pen2");
  check(pen1?.kind === "ink" && pen1.size === 2 && pen1.color === "#000" && pen2?.kind === "ink" && pen2.size === 6 && pen2.color === "#c0392b" && pen2.opacity === 0.4, "pen strokes are strokes: their width (2 radius), color, a highlighter's opacity, in their frame's group: " + JSON.stringify([pen1, pen2]).slice(0, 300));
  // an icon: a sticker, its name kept, its color and size
  const ic = p1.nodes.find((x) => x.id === "ic");
  check(ic?.kind === "sticker" && ic.icon === "star" && ic.w === 50, "an icon is a sticker, its name and size kept: " + JSON.stringify(ic));
  const at2 = await ev(`(() => { const it = window.board.item("pen2"); return it && [it.x, it.y]; })()`);
  check(at2 && Math.abs(at2[0] + pen2.points[0] - 300) < 1 && Math.abs(at2[1] + pen2.points[1] - 500) < 1, "...each where it was on CoCalc's board: its first point at " + JSON.stringify(at2 && [at2[0] + pen2.points[0], at2[1] + pen2.points[1]]));
  check(d.pages[1].nodes.map((x) => x.id).join() === "n3", "the second page has its note");
  const said = await ev("document.querySelector('[data-sbb=say]').textContent");
  check(!(await ev("document.querySelector('[data-sbb=tour]').hidden")) && /Converted from a CoCalc whiteboard file/.test(said) && !/pen stroke/.test(said) && /1 timer/.test(said) && !/icon/.test(said) && !/connection/.test(said) && /1 hidden note/.test(said) && /speaker notes/.test(said) && !/selection/.test(said), "the caption says it was converted, and what was left out: " + said);
  // shown where they were: a member of a group at its place on CoCalc's board
  await until(`!!window.board.item("n1") && !!window.board.item("c1")`, 5000);
  const at = await ev(`["n1", "c1", "t1", "f1"].map((id) => { const it = window.board.item(id); return it && [id, Math.round(it.x), Math.round(it.y), it.parent ?? ""]; })`);
  // (a group fits what it holds: Ideas's begins its padding, 24, left of n1, and its padding and title, 58, above)
  const want = { n1: [150, 200, "f1"], c1: [550, 350, "f2"], t1: [1200, 100, ""], f1: [126, 142, ""] };
  check(at.every((a) => a && Math.abs(a[1] - want[a[0]][0]) <= 1 && Math.abs(a[2] - want[a[0]][1]) <= 1 && a[3] === want[a[0]][2]), "each note is where it was on CoCalc's board, in its frame's group: " + JSON.stringify(at));
  check(await until(`[...document.querySelectorAll('.board-note')].some((e) => e.querySelector('.katex') && e.textContent.includes('A note with'))`, 5000), "its math is typeset");
  // undo: back to the board before
  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })), 1");
  check(await until(`!${B}.snapshot().doc.pages && ${B}.snapshot().doc.title !== "ideas"`, 3000), "undo takes the opened board back");

  // the oldest: page numbers, and \( \) \[ \] escaped (not math)
  await open("old.board", LEGACY);
  d = await docOf();
  check(d.pages?.length === 2 && d.pages[0].nodes[0]?.text === "Old (not math) and [brackets]" && d.pages[1].nodes[0]?.text === "Page two", "an old board: its pages by number, \\( \\[ unescaped: " + JSON.stringify(d.pages?.map((p) => p.nodes.map((x) => x.text))));
  check(/Converted from a CoCalc whiteboard file\.$/.test((await ev("document.querySelector('[data-sbb=say]').textContent")).trim()), "nothing left out: the caption says only that it was converted");
  check(!d.pages.some((p) => p.slide) && !(await docOf()).slide, "a whiteboard's pages are not slides");
  // a slides file: its pages are slides, on CoCalc's card (or a page's own, when it has one)
  await open("deck.slides", jsonl([
    { id: "q1", type: "page", z: 0, data: { pos: 0, schemaVersion: 1 } },
    { id: "q2", type: "page", z: 0, data: { pos: 1, schemaVersion: 1 } },
    { id: "q3", type: "page", z: 0, data: { pos: 2, schemaVersion: 1 } },
    { id: "a1", type: "text", x: -400, y: -400, w: 300, h: 60, z: 1, page: "q1", str: "# A title" },
    { id: "a2", type: "note", x: -400, y: -300, w: 300, h: 100, z: 2, page: "q2", str: "Second" },
    { id: "s2", type: "slide", x: -600, y: -500, w: 1200, h: 675, z: 0, page: "q2" },
  ]));
  d = await docOf();
  const said2 = await ev("document.querySelector('[data-sbb=say]').textContent");
  check(JSON.stringify(d.pages?.[0]?.slide) === JSON.stringify({ x: -295.5, y: -492, w: 1050, h: 591 }) && JSON.stringify(d.pages?.[1]?.slide) === JSON.stringify({ x: -600, y: -500, w: 1200, h: 675 }) && JSON.stringify(d.pages?.[2]?.slide) === JSON.stringify({ x: -295.5, y: -492, w: 1050, h: 591 }), "a slides file's pages are slides: CoCalc's card (an empty page too), or the page's own: " + JSON.stringify(d.pages?.map((p) => p.slide)));
  check(/Converted from a CoCalc slides file/.test(said2) && !/Left out/.test(said2), "...and the caption leaves nothing out: " + said2);
  // a one-line JSON board is still a board, not taken for CoCalc's
  await open("one.json", JSON.stringify({ title: "One line", nodes: [{ id: "solo", title: "Solo" }] }));
  d = await docOf();
  check(d.title === "One line" && d.nodes?.[0]?.id === "solo", "a board on one line still opens as itself");
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
