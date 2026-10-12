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
  const t0 = Date.now();
  await send("Page.navigate", { url });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  const loadMs = Date.now() - t0;
  await until("window.sagebrush.board.snapshot().routed", 60000);
  const routeMs = Date.now() - t0;
  await sleep(300);
  const s = await ev("window.sagebrush.board.snapshot()");
  // (a document with pages: its first page is shown)
  const pg = s.doc.pages?.length ? s.doc.pages[s.page] : s.doc;
  const notes = s.items.filter((i) => i.kind === "note"), groups = s.items.filter((i) => i.kind === "group");
  console.log(`${notes.length} notes, ${groups.length} groups, ${pg.edges?.length ?? 0} edges, ${pg.steps?.length ?? 0} steps${s.pages > 1 ? ` on the first of ${s.pages} pages` : ""}; shown in ${loadMs} ms, routed by ${routeMs} ms`);
  // no two boxes overlap unless one holds the other (a sweep over x)
  const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
  const byX = [...s.items].sort((a, b) => a.x - b.x);
  for (let i = 0; i < byX.length; i++) for (let j = i + 1; j < byX.length && byX[j].x < byX[i].x + byX[i].w; j++) {
    const a = byX[i], b = byX[j];
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    check(!overlap || inside(a, b) || inside(b, a), `${a.id} and ${b.id} overlap`);
  }
  // each routed edge: axis-parallel segments, from its box's border to the
  // other's, through no other note
  {
    const s2 = await ev("window.sagebrush.board.snapshot()");
    const box = new Map(s2.items.map((i) => [i.id, i]));
    const onBorder = (b, x, y) => (Math.abs(x - b.x) < 0.5 || Math.abs(x - b.x - b.w) < 0.5) && y >= b.y - 0.5 && y <= b.y + b.h + 0.5 || (Math.abs(y - b.y) < 0.5 || Math.abs(y - b.y - b.h) < 0.5) && x >= b.x - 0.5 && x <= b.x + b.w + 0.5;
    const noteList = s2.items.filter((i) => i.kind === "note");
    let routedN = 0, bad = [];
    for (const e of s2.edges) {
      const p = e.points;
      if (!p) continue;
      routedN++;
      const a = box.get(e.from), b = box.get(e.to);
      if (!onBorder(a, p[0], p[1]) || !onBorder(b, p[p.length - 2], p[p.length - 1])) bad.push(`${e.from}->${e.to}: ends off the borders`);
      for (let i = 0; i + 3 < p.length; i += 2) {
        const [x0, y0, x1, y1] = [p[i], p[i + 1], p[i + 2], p[i + 3]];
        if (x0 !== x1 && y0 !== y1) { bad.push(`${e.from}->${e.to}: a diagonal segment`); break; }
        const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) }, hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) };
        const hit = noteList.find((n) => n.id !== e.from && n.id !== e.to && lo.x < n.x + n.w - 0.5 && hi.x > n.x + 0.5 && lo.y < n.y + n.h - 0.5 && hi.y > n.y + 0.5);
        if (hit) { bad.push(`${e.from}->${e.to}: through ${hit.id}`); break; }
      }
    }
    check(!bad.length, `routes: ${bad.slice(0, 6).join("; ")}${bad.length > 6 ? ` (${bad.length} in all)` : ""}`);
    check(!s2.edges.length || routedN >= s2.edges.length * 0.9, `only ${routedN} of ${s2.edges.length} edges routed`);
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
  pg.nodes.forEach(walk);
  // notes' text fits (fully zoomed in, at the whole board's camera, every mounted note)
  await ev("window.sagebrush.board.step(-1)");
  await shot("board");
  // (every note mounted: the camera on the whole board, at full size; boards
  // of fixed-size notes are not measured, and too large to mount at once)
  const b = await ev("window.board.bounds()");
  if (notes.length <= 150) {
    const overflow = await ev(`window.board.setCamera({ x: ${b.x0}, y: ${b.y0}, z: 1 }), window.board.el.style.width = "${b.x1 - b.x0}px", window.board.el.style.height = "${b.y1 - b.y0}px", window.board.el.style.position = "relative", new Promise((r) => setTimeout(() => requestAnimationFrame(() => r([...document.querySelectorAll('.board-note')].filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.querySelector('b')?.textContent))), 300))`);
    // (notes are mounted a few dozen a frame)
    await until(`document.querySelectorAll('.board-note').length >= ${notes.length}`, 20000).catch(() => {});
    const mounted = await ev("document.querySelectorAll('.board-note').length");
  check(mounted === notes.length, `${mounted} of ${notes.length} notes mounted to check their text`);
    const overflow2 = await ev("[...document.querySelectorAll('.board-note')].filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.querySelector('b')?.textContent)");
    check(!overflow.length && !overflow2.length, `text overflows: ${[...overflow, ...overflow2].join(", ")}`);
    await ev(`window.board.el.style.cssText = "", window.board.focus(undefined, true)`);
  } else {
    // (a large board: a region of it, close up, its math typeset)
    await ev(`window.board.setCamera({ x: ${b.x0}, y: ${b.y0}, z: 1 })`);
    await until("window.board.math.length === 0 && !window.board.unbuilt", 20000).catch(() => {});
    await sleep(300);
    const over = await ev("[...document.querySelectorAll('.board-note')].filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.querySelector('b')?.textContent)");
    const n = await ev("document.querySelectorAll('.board-note').length");
    check(n > 20 && !over.length, `text overflows in ${over.length} of ${n} notes: ${over.slice(0, 8).join(", ")}`);
    await ev("window.board.focus(undefined, true)");
  }
  // math was typeset where the document has it (close to the first note with math)
  const withMath = notes.find((n) => /\$/.test(JSON.stringify(pg.nodes).match(new RegExp(`"id":"${n.id}"[^}]*`))?.[0] ?? ""));
  if (withMath) {
    await ev(`window.board.focus([${JSON.stringify(withMath.id)}], true)`);
    await sleep(400);
    // (where the page found math: a $ in a code comment need not be)
    check(await ev("document.querySelectorAll('.board-note .math').length === 0 || document.querySelectorAll('.board-note .katex').length > 0"), "no math typeset");
  }
  // the tour moves the camera, and #N is its step
  for (let i = 0; i < (pg.steps?.length ?? 0); i++) {
    const before = await ev("JSON.stringify(window.board.camera)");
    await ev(`window.sagebrush.board.step(${i})`);
    await sleep(550);
    check((await ev("JSON.stringify(window.board.camera)")) !== before || i === 0, `step ${i + 1} did not move the camera`);
    check((await ev("location.hash")) === `#${i + 1}`, `step ${i + 1}: hash`);
    await shot(`step${String(i + 1).padStart(2, "0")}`);
  }
  // pages: each its own board, #pP its address; PageDown and PageUp
  if (s.pages > 1) {
    for (let p = 1; p < s.pages; p++) {
      await ev(`window.sagebrush.board.page(${p})`);
      await until("window.sagebrush.board.snapshot().routed", 20000);
      const sp = await ev("window.sagebrush.board.snapshot()");
      const want = s.doc.pages[p].nodes.length;
      check(sp.page === p && sp.items.filter((i) => i.kind === "note").length === want, `page ${p + 1}: ${sp.items.length} items, not its ${want} notes`);
      check((await ev("location.hash")) === `#p${p + 1}`, `page ${p + 1}: hash ${await ev("location.hash")}`);
      check(await ev(`document.getElementById("pgsel").value === "${p}" && !document.getElementById("pages").hidden`), `page ${p + 1}: the picker`);
      if (s.doc.pages[p].steps?.length) {
        await ev("window.sagebrush.board.step(1)");
        check((await ev("location.hash")) === `#p${p + 1}-2`, `page ${p + 1} step 2: hash`);
      }
      await shot(`page${p + 1}`);
    }
    await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))");
    await sleep(300);
    check((await ev("window.sagebrush.board.snapshot().page")) === s.pages - 2, "PageUp did not go back a page");
    // the address opens the page and step
    // (a new hash alone does not reload the page)
    await send("Page.navigate", { url: url + `#p${s.pages}-1` });
    await ev("window.oldPage = 1");
    await send("Page.reload");
    await until("!window.oldPage && window.sagebrush?.board?.snapshot().items.length > 0", 30000);
    await sleep(300);
    const sn = await ev("window.sagebrush.board.snapshot()");
    check(sn.page === s.pages - 1 && sn.step === (s.doc.pages[s.pages - 1].steps?.length ? 0 : -1), `#p${s.pages}-1 opened page ${sn.page + 1}, step ${sn.step + 1}`);
    await ev("window.sagebrush.board.page(0)");
  }
  // print (or save as PDF): a sheet per page, or per step of the tours; the
  // PDF has as many pages, and the sheets' notes fit their text, math typeset
  {
    const sp = await ev("window.sagebrush.board.snapshot()");
    const pages = sp.doc.pages?.length ? sp.doc.pages : [sp.doc];
    for (const mode of ["pages", "tour"]) {
      const want = mode === "pages" ? pages.length : pages.reduce((n, p) => n + (p.steps?.length ? p.steps.length + (p.intro ? 1 : 0) : 1), 0);
      if (mode === "tour" && want === pages.length) continue;
      if (want > 40) continue; // (a large board's: the layout is checked above)
      const n = await ev(`window.sagebrush.board.print({ mode: "${mode}", dialog: false })`);
      check(n === want, `print ${mode}: ${n} sheets, not ${want}`);
      const sheet = await ev(`[...document.querySelectorAll("#board-print .pr-sheet")].map((s) => ({ notes: s.querySelectorAll(".board-note").length, over: [...s.querySelectorAll(".board-note")].filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.querySelector("b")?.textContent), math: s.querySelectorAll(".math").length, katex: s.querySelectorAll(".katex").length, paths: s.querySelectorAll(".pr-back path").length, far: !!s.dataset.far }))`);
      sheet.forEach((x, i) => {
        check(x.notes > 0 || x.far, `print ${mode}: sheet ${i + 1} has no notes`);
        check(!x.over.length, `print ${mode}: sheet ${i + 1}: text overflows in ${x.over.join(", ")}`);
        check(!x.math || x.katex, `print ${mode}: sheet ${i + 1}: math not typeset`);
      });
      const pdf = await send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true });
      const bytes = Buffer.from(pdf.data ?? "", "base64"), text = bytes.toString("latin1");
      const pdfPages = (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
      check(pdfPages === want, `print ${mode}: the PDF has ${pdfPages} pages, not ${want}`);
      // (landscape letter: 792 x 612 points)
      check(/\/MediaBox\s*\[\s*0 0 792 612\s*\]/.test(text), `print ${mode}: the PDF's pages are not landscape Letter`);
      if (process.env.SHOT) writeFileSync(join(process.env.SHOT, `print-${mode}.pdf`), bytes);
      console.log(`print ${mode}: ${n} sheets, a ${(bytes.length / 1024).toFixed(0)} KB PDF`);
    }
    await ev(`document.getElementById("board-print")?.remove()`);
  }
  if (process.env.SHOT) {
    const id = notes[Math.min(20, notes.length - 1)].id;
    await ev(`window.board.setCamera({ x: window.board.bounds([${JSON.stringify(id)}]).x0 - 40, y: window.board.bounds([${JSON.stringify(id)}]).y0 - 40, z: 1.6 })`);
    await shot("close");
  }
  // how it feels: frames while panning close up and far out, and zooming out and in
  if (process.env.PERF) {
    const B = await ev("window.board.bounds()");
    const paths = {
      pan1: `Array.from({ length: 240 }, (_, i) => ({ x: ${B.x0} + i * 14, y: ${B.y0} + i * 6, z: 1 }))`,
      pan04: `Array.from({ length: 240 }, (_, i) => ({ x: ${B.x0} + i * 30, y: ${B.y0} + i * 12, z: 0.4 }))`,
      panFar: `Array.from({ length: 240 }, (_, i) => ({ x: ${B.x0} + i * 120, y: ${B.y0} + i * 40, z: 0.06 }))`,
      zoom: `Array.from({ length: 240 }, (_, i) => { const t = i < 120 ? i / 120 : (240 - i) / 120; return { x: ${B.x0}, y: ${B.y0}, z: Math.exp(Math.log(1.2) * (1 - t) + Math.log(${Math.max(0.01, 1200 / (B.x1 - B.x0))}) * t) }; })`,
    };
    paths.zoomAgain = paths.zoom;
    for (const [k, p] of Object.entries(paths)) {
      const r = await ev(`boardBench(${p})`);
      console.log(`${k}: frame interval p50 ${r.interval.p50.toFixed(1)} p95 ${r.interval.p95.toFixed(1)} max ${r.interval.max.toFixed(0)} ms; render p95 ${r.work.p95.toFixed(1)} ms; mounted ${r.mounted}`);
    }
    await sleep(1000);
    console.log("math still waiting:", await ev("window.board.math?.length ?? 0"));
  }
  // editing (web/board/edit.ts), with the mouse
  if (!process.env.NO_EDIT) {
    const mouse = async (type, x, y, o = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...o });
    const drag = async (from, to, o = {}) => {
      await mouse("mousePressed", from.x, from.y, o);
      for (let i = 1; i <= 8; i++) await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8, o);
      await mouse("mouseReleased", to.x, to.y, { ...o, buttons: 0 });
      await sleep(300);
    };
    const center = (id) => ev(`(() => { const r = window.board.clientRect(${JSON.stringify(id)}); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 30) }; })()`);
    const box = (id) => ev(`(() => { const i = window.sagebrush.board.snapshot().items.find((i) => i.id === ${JSON.stringify(id)}); return i && { x: i.x, y: i.y }; })()`);
    const docOf = () => ev("JSON.parse(JSON.stringify(window.sagebrush.board.snapshot().doc))");
    await ev("localStorage.clear(), window.sagebrush.board.editing(true)");
    // show one group's notes, large enough to hit
    await ev("window.board.focus(['nb'], true)");
    await sleep(200);
    const [a, b] = ["graph", "page"];
    const a0 = await box(a), other0 = await box("page"), z = await ev("window.board.camera.z");
    const ca = await center(a);
    // (while dragging, only the dragged note's edges may lose their routes;
    // let go, every edge is routed again, none left straight)
    const straight = `window.sagebrush.board.snapshot().edges.filter((e) => !e.points).map((e) => e.from + "->" + e.to)`;
    await mouse("mousePressed", ca.x, ca.y);
    for (let i = 1; i <= 8; i++) await mouse("mouseMoved", ca.x + (60 * i) / 8, ca.y + (90 * i) / 8);
    const during = await ev(straight);
    check(during.every((x) => x.split("->").includes(a)), `while dragging ${a}, other edges went straight: ${during.join(", ")}`);
    await mouse("mouseReleased", ca.x + 60, ca.y + 90, { buttons: 0 });
    await sleep(120);
    const after = await ev(straight);
    check(after.length === 0, `after dropping ${a}, edges left straight: ${after.join(", ")}`);
    await sleep(200);
    const a1 = await box(a), other1 = await box("page");
    check(Math.abs(a1.x - a0.x - 60 / z) < 2 && Math.abs(a1.y - a0.y - 90 / z) < 2, `drag moved ${a} by (${a1.x - a0.x}, ${a1.y - a0.y}), not (${60 / z}, ${90 / z})`);
    check(Math.abs(other1.x - other0.x) < 0.5 && Math.abs(other1.y - other0.y) < 0.5, `dragging a note moved another in its group: (${other0.x}, ${other0.y}) to (${other1.x}, ${other1.y})`);
    // undo, redo
    await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
    await sleep(200);
    const a2 = await box(a);
    check(Math.abs(a2.x - a0.x) < 1 && Math.abs(a2.y - a0.y) < 1, "undo did not put the note back");
    await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }))");
    await sleep(200);
    check(Math.abs((await box(a)).x - a1.x) < 1, "redo did not move it again");
    // (back where it was: on a small screen it may now cover another note)
    await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
    await sleep(200);
    // connect: shift-drag from one note to another
    const edges0 = (await docOf()).edges.length;
    await ev(`window.board.focus(${JSON.stringify([a, b])}, true)`);
    await sleep(200);
    const cb = await center(b), ca2 = await center(a);
    await drag(ca2, cb, { modifiers: 8 });
    const d1 = await docOf();
    check(d1.edges.length === edges0 + 1 && d1.edges.some((e) => e.from === a && e.to === b), "shift-drag did not connect the notes");
    // a new note: double-click the background, write, Ctrl+Enter
    // (the camera over empty space right of everything)
    await ev("(() => { const b = window.board.bounds(); window.board.setCamera({ x: b.x1 + 100, y: b.y0, z: 1 }); })()");
    await sleep(200);
    const empty = await ev("({ x: innerWidth / 2, y: innerHeight / 2 })");
    await mouse("mousePressed", empty.x, empty.y, { clickCount: 1 }); await mouse("mouseReleased", empty.x, empty.y, { clickCount: 1, buttons: 0 });
    await mouse("mousePressed", empty.x, empty.y, { clickCount: 2 }); await mouse("mouseReleased", empty.x, empty.y, { clickCount: 2, buttons: 0 });
    await until("document.querySelector('.board-editor .be-title') === document.activeElement", 5000);
    await send("Input.insertText", { text: "A new note" });
    await ev("document.querySelector('.be-text').focus()");
    await send("Input.insertText", { text: "with $x^2$" });
    await ev("document.querySelector('.be-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))");
    await sleep(400);
    const d2 = await docOf(), added = d2.nodes.find((n) => n.title === "A new note");
    check(added && added.text === "with $x^2$" && typeof added.x === "number", "double-click did not add the note");
    check(!d2.nodes.some((n) => n.id !== added?.id && n.x === undefined), "adding a note did not keep the others in place");
    // a group's members do not move when one of them is dragged, nor do other groups
    // delete it (selected by a click), and undo
    if (added) {
      const cn = await center(added.id);
      await mouse("mousePressed", cn.x, cn.y); await mouse("mouseReleased", cn.x, cn.y, { buttons: 0 });
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))");
      await sleep(300);
      check(!(await docOf()).nodes.some((n) => n.id === added.id), "Delete did not remove the selected note");
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
      await sleep(300);
      check((await docOf()).nodes.some((n) => n.id === added.id), "undo did not bring the note back");
    }
    // kept across a reload; Revert
    await send("Page.reload");
    await until("window.sagebrush?.board?.snapshot().items.length > 0");
    check((await docOf()).nodes.some((n) => n.title === "A new note"), "the edits were not kept across a reload");
    check(!(await ev("document.getElementById('revert').hidden")), "Revert is hidden after edits");
    await ev("document.getElementById('revert').click()");
    await sleep(400);
    check(!(await docOf()).nodes.some((n) => n.title === "A new note"), "Revert did not restore the original");
    check(await ev("localStorage.length === 0"), "Revert left the edits saved");
    // Tidy forgets positions
    await ev("window.sagebrush.board.edit((d) => { d.nodes[0].x = 5000; d.nodes[0].y = 5000; })");
    await ev("document.getElementById('tidy').click()");
    await sleep(300);
    check((await docOf()).nodes.every((n) => n.x === undefined), "Tidy kept positions");
    // Import Mermaid…: a flowchart pasted in replaces the board (undoable);
    // its shapes, labels, subgraph and edge styles carry over
    {
      const before = (await docOf()).nodes.length;
      await ev("document.getElementById('mermaid').click()");
      await until("document.getElementById('mmdlg').open");
      await ev(`document.getElementById('mmtext').value = ${JSON.stringify("flowchart LR\n  a([Start]) --> b{Is it?}\n  b -->|yes| c[Done]\n  b -. no .-> d[[Retry]]\n  subgraph s [Later]\n    d <--> e[(Store)]\n  end\n  classDef hot fill:#fbb\n  class b hot")}`);
      await ev("document.getElementById('mm-go').click()");
      await until("!document.getElementById('mmdlg').open && window.sagebrush.board.snapshot().routed", 10000);
      const dm = await docOf(), items = await ev("window.sagebrush.board.snapshot().items");
      const sub = dm.nodes.find((n) => n.id === "s");
      check(dm.nodes.length === 4 && sub?.kind === "group" && sub.title === "Later" && sub.children.map((c) => c.id).join() === "d,e", `Import Mermaid: nodes ${JSON.stringify(dm.nodes).slice(0, 200)}`);
      check(dm.nodes.find((n) => n.id === "b")?.shape === "diamond" && dm.nodes.find((n) => n.id === "b")?.color === "#ffbbbb", "Import Mermaid: the diamond, its color");
      check(dm.edges.some((e) => e.from === "b" && e.to === "d" && e.label === "no" && e.line === "dotted") && dm.edges.some((e) => e.from === "d" && e.to === "e" && e.arrow === "both"), `Import Mermaid: edges ${JSON.stringify(dm.edges)}`);
      await ev("window.board.focus(['b'], true)");
      await sleep(300);
      check(items.length === 6 && await ev("document.querySelectorAll('.board-shape-diamond').length === 1"), "Import Mermaid: not drawn");
      // (fitted widths: a short label, a narrow box)
      check(items.find((i) => i.id === "c").w < 120, "Import Mermaid: notes not fitted to their labels");
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
      await sleep(400);
      check((await docOf()).nodes.length === before, "undo did not bring the board back after Import Mermaid");
    }
    // pages: add one (the board becomes page 1), write on it, delete it
    const nodes0 = (await docOf()).nodes.length;
    await ev("document.getElementById('addpage').click()");
    await sleep(500);
    let dp = await docOf();
    check(dp.pages?.length === 2 && dp.pages[0].nodes.length === nodes0 && !dp.nodes && dp.pages[1].nodes.length === 0, "Add a page did not make two pages");
    check((await ev("window.sagebrush.board.snapshot().page")) === 1 && (await ev("location.hash")) === "#p2", "Add a page did not show the new page");
    await ev("window.sagebrush.board.edit((d) => { d.pages[1].nodes.push({ id: 'p2note', title: 'On page 2' }); })");
    await sleep(300);
    check((await ev("window.sagebrush.board.snapshot().items.map((i) => i.id).join()")) === "p2note", "page 2 does not show its own note");
    await ev("window.sagebrush.board.page(0)");
    await sleep(300);
    check((await ev("window.sagebrush.board.snapshot().items.filter((i) => i.kind === 'note').length")) > 1, "page 1 lost its notes");
    await ev("window.sagebrush.board.page(1)");
    await ev("window.sagebrush.board.edit((d) => { d.pages[1].nodes = []; })");
    await ev("document.getElementById('rmpage').click()");
    await sleep(500);
    dp = await docOf();
    check(!dp.pages && dp.nodes.length === nodes0, "Delete this page did not leave the board as it was");
    await ev("localStorage.clear()");
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
