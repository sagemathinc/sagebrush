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
import { devtoolsPort } from "./test-port.mjs";

const doc = process.argv[2] ?? "examples/sagebrush.json";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const url = `${base}board/?doc=${encodeURIComponent(doc)}`;
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-board-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [W, H] = (process.env.SIZE ?? "1280x800").split("x").map(Number);
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(), errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  // (the site's /version.json is optional: a build without it is a 404 the
  // board answers with its own engine (page.ts); that 404 only, nothing else
  // about it, astra's TEST-4D0-1)
  const optional = (e) => /status of 404\b/.test(e.text) && (() => { try { return new URL(e.url).pathname === "/version.json"; } catch { return false; } })();
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon/.test(m.params.entry.url ?? "") && !optional(m.params.entry)) errors.push(m.params.entry.text + " " + (m.params.entry.url ?? ""));
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
  // (once the page's fonts are in, KaTeX's among them, and the board laid out again for them)
  await ev("document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))))");
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
    // (a large board: a region of it, close up, its math typeset: the
    // window's worth with the most notes, not its corner, which for a
    // generated board, source.json being the repository's files, changes
    // as the repository does)
    const at = await ev(`(() => { const its = window.sagebrush.board.snapshot().items.filter((i) => i.kind === "note"), W = window.board.el.clientWidth, H = window.board.el.clientHeight; let best = { x: ${b.x0}, y: ${b.y0} }, most = -1; for (const a of its) { const x = a.x - 8, y = a.y - 8, n = its.filter((i) => i.x >= x && i.y >= y && i.x + i.w <= x + W && i.y + i.h <= y + H).length; if (n > most) { most = n; best = { x, y }; } } return best; })()`);
    await ev(`window.board.setCamera({ x: ${at.x}, y: ${at.y}, z: 1 })`);
    await until("window.board.math.length === 0 && !window.board.unbuilt", 20000).catch(() => {});
    await sleep(300);
    const over = await ev("[...document.querySelectorAll('.board-note')].filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.querySelector('b')?.textContent)");
    const n = await ev("document.querySelectorAll('.board-note').length");
    check(n > 20 && !over.length, `text overflows in ${over.length} of ${n} notes: ${over.slice(0, 8).join(", ")}`);
    await ev("window.board.focus(undefined, true)");
  }
  // input: a trackpad's pinch (many small ctrl+wheel deltas) zooms quickly;
  // a double-click flies to a note and leaves no text selected; on the note
  // already shown, it selects a word and the camera stays
  {
    await ev("window.board.focus(undefined, true)");
    await sleep(100);
    const z0 = await ev("window.board.camera.z");
    for (let i = 0; i < 50; i++) await ev(`window.board.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -3, ctrlKey: true, clientX: ${W / 2}, clientY: ${H / 2}, bubbles: true, cancelable: true })), 1`);
    const z1 = await ev("window.board.camera.z");
    check(z1 / z0 > 10 || z1 > 7.9, `a pinch of 150 zooms ${(z1 / z0).toFixed(2)}x (want more than 10x)`);
    await ev("window.board.focus(undefined, true)");
    await sleep(200);
    const pick = await ev(`(() => { const r = window.board.el.getBoundingClientRect(); for (let y = r.top + 70; y < r.bottom - 40; y += 17) for (let x = r.left + 20; x < r.right - 20; x += 17) { const it = window.board.itemAt(x - r.left, y - r.top); if (it && it.kind === 'note' && it.w * window.board.camera.z > 30) return { id: it.id, x, y }; } return null; })()`);
    const dbl = async (x, y) => {
      for (const clickCount of [1, 2]) {
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount });
      }
      await sleep(700);
    };
    if (pick) {
      const c0 = await ev("window.board.camera");
      await dbl(pick.x, pick.y);
      const c1 = await ev("window.board.camera");
      check(Math.abs(c1.z / c0.z - 1) > 0.02 || Math.hypot(c1.x - c0.x, c1.y - c0.y) > 1, "a double-click on a note flies to it");
      check(await ev("getSelection().toString() === ''"), `a double-click that flies selects no text (${await ev("getSelection().toString()")})`);
      // (a word of that note's text, now in view)
      const word = await ev(`(() => { const c = window.board.clientRect(${JSON.stringify(pick.id)}); const el = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)?.closest('.board-note'); if (!el) return null; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const m = /\\w{3,}/.exec(n.textContent); if (!m) continue; const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + 1); const b = r.getBoundingClientRect(); if (b.width) return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } return null; })()`);
      if (word) {
        await dbl(word.x, word.y);
        const c2 = await ev("window.board.camera");
        check(Math.abs(c2.z / c1.z - 1) < 0.02 && Math.hypot(c2.x - c1.x, c2.y - c1.y) < 1, "a double-click on the note shown leaves the camera");
        check(await ev("getSelection().toString().trim().length > 0"), "a double-click on the note shown selects a word");
      }
    }
    await ev("getSelection().removeAllRanges(), window.board.focus(undefined, true)");
    await sleep(300);
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
      check(await ev(`document.querySelector("[data-sbb=pgsel]").value === "${p}" && !document.querySelector("[data-sbb=pages]").hidden`), `page ${p + 1}: the picker`);
      if (s.doc.pages[p].steps?.length) {
        await ev("window.sagebrush.board.step(1)");
        check((await ev("location.hash")) === `#p${p + 1}-2`, `page ${p + 1} step 2: hash`);
      }
      await shot(`page${p + 1}`);
    }
    await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))");
    await sleep(300);
    check((await ev("window.sagebrush.board.snapshot().page")) === s.pages - 2, "PageUp did not go back a page");
    // → alone goes through every page's intro and tour, ← back again;
    // the caption's arrows stop only at the board's ends (William's B4)
    {
      const seq = [];
      for (let p = 0; p < s.pages; p++) for (let i = -1; i < (s.doc.pages[p].steps?.length ?? 0); i++) seq.push([p, i]);
      const where = () => ev("(() => { const s = window.sagebrush.board.snapshot(); return [s.page, s.step]; })()");
      const press = (key) => ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true })), 1`);
      // (this file's until throws on a timeout: here, true or false)
      const reach = (w) => until(`(() => { const s = window.sagebrush.board.snapshot(); return s.page === ${w[0]} && s.step === ${w[1]}; })()`, 10000).then(() => true, () => false);
      await ev("window.sagebrush.board.page(0)");
      check(await reach(seq[0]), "B4: (the first page, from its start)");
      const disabled = (b) => ev(`document.querySelector('[data-sbb=${b}]').disabled`);
      check(await disabled("prev"), "B4: at the board's start ← is disabled");
      let ok = true;
      for (let k = 1; k < seq.length && ok; k++) {
        await press("ArrowRight");
        if (!(await reach(seq[k]))) { ok = false; check(false, `B4: → from ${JSON.stringify(seq[k - 1])} went to ${JSON.stringify(await where())}, not ${JSON.stringify(seq[k])}`); }
      }
      if (ok) check(true, "B4: → went through every page's intro and steps: " + seq.length);
      check(await disabled("next"), "B4: at the board's end → is disabled");
      await press("ArrowRight");
      await sleep(300);
      check(JSON.stringify(await where()) === JSON.stringify(seq.at(-1)), "B4: → at the board's end stays");
      ok = true;
      for (let k = seq.length - 2; k >= 0 && ok; k--) {
        await press("ArrowLeft");
        if (!(await reach(seq[k]))) { ok = false; check(false, `B4: ← from ${JSON.stringify(seq[k + 1])} went to ${JSON.stringify(await where())}, not ${JSON.stringify(seq[k])}`); }
      }
      if (ok) check(true, "B4: ← went back through them all");
      // (the caption's → at a page's last step: the next page's start)
      const last0 = s.doc.pages[0].steps?.length ?? 0;
      await ev(`window.sagebrush.board.step(${last0 - 1})`);
      await reach([0, last0 - 1]);
      check(!(await disabled("next")), "B4: at a page's last step the caption's → is not disabled");
      await ev("document.querySelector('[data-sbb=next]').click(), 1");
      check(await reach([1, -1]), "B4: ...and it goes to the next page's start: " + JSON.stringify(await where()));
      await ev("document.querySelector('[data-sbb=prev]').click(), 1");
      check(await reach([0, last0 - 1]), "B4: the caption's ← there goes back to the last step: " + JSON.stringify(await where()));
    }
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
    // (with Alt held unless told otherwise: no snapping to other items, so a drag moves exactly as far)
    const drag = async (from, to, o0 = {}) => {
      const o = { modifiers: 1, ...o0 };
      await mouse("mousePressed", from.x, from.y, o);
      for (let i = 1; i <= 8; i++) await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8, o);
      await mouse("mouseReleased", to.x, to.y, { ...o, buttons: 0 });
      await sleep(300);
    };
    const center = (id) => ev(`(() => { const r = window.board.clientRect(${JSON.stringify(id)}); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 30) }; })()`);
    const box = (id) => ev(`(() => { const i = window.sagebrush.board.snapshot().items.find((i) => i.id === ${JSON.stringify(id)}); return i && { x: i.x, y: i.y }; })()`);
    const docOf = () => ev("JSON.parse(JSON.stringify(window.sagebrush.board.snapshot().doc))");
    await ev("localStorage.clear(), window.sagebrush.board.editing(true)");
    check(await ev("document.querySelector('[data-sbb=revert]').hidden"), "Revert is shown for a board not edited (its format and version, added, are no edit)");
    // few items in view: their text shows down to zoom 0.35 (William's I8); fewer than that, boxes
    await ev("(() => { const c = window.board.camera; window.board.setCamera({ ...c, z: 0.42 }); window.board.render(); return 1; })()");
    check(await ev("getComputedStyle(document.querySelector('.board-world')).visibility === 'visible' && document.querySelectorAll('.board-note').length > 5"), "at zoom 0.42, with few items in view, their text shows");
    await ev("(() => { const c = window.board.camera; window.board.setCamera({ ...c, z: 0.3 }); window.board.render(); return 1; })()");
    check(await ev("getComputedStyle(document.querySelector('.board-world')).visibility === 'hidden'"), "at zoom 0.3, boxes on the canvas");
    // the board's title: in Edit, a click renames it where it is (William's I7)
    // (until here throws on a timeout: as a yes or no)
    const waits = (expr, ms) => until(expr, ms).then(() => true, () => false);
    const t0 = (await docOf()).title;
    const tb = await ev("(() => { const r = document.querySelector('[data-sbb=title]').getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; })()");
    await mouse("mousePressed", tb.x, tb.y); await mouse("mouseReleased", tb.x, tb.y, { buttons: 0 });
    check(await waits("document.activeElement === document.querySelector('[data-sbb=title] input')", 2000), "in Edit, a click on the title renames it there");
    await ev("document.activeElement.select(), 1");
    await send("Input.insertText", { text: "Renamed board" });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    check(await waits("window.sagebrush.board.snapshot().doc.title === 'Renamed board' && document.querySelector('[data-sbb=title]').textContent === 'Renamed board'", 3000), "Enter keeps the new title: " + (await docOf()).title);
    await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })), 1");
    check(await waits(`window.sagebrush.board.snapshot().doc.title === ${JSON.stringify(t0)}`, 3000), "undo takes it back");
    await mouse("mousePressed", tb.x, tb.y); await mouse("mouseReleased", tb.x, tb.y, { buttons: 0 });
    await until("!!document.querySelector('[data-sbb=title] input')", 2000);
    await send("Input.insertText", { text: "Not this" });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    check(await waits(`!document.querySelector('[data-sbb=title] input') && window.sagebrush.board.snapshot().doc.title === ${JSON.stringify(t0)}`, 3000), "Esc keeps the title as it was");
    // show one group's notes, large enough to hit
    await ev("window.board.focus(['nb'], true)");
    await sleep(200);
    const [a, b] = ["graph", "page"];
    const a0 = await box(a), other0 = await box("page"), z = await ev("window.board.camera.z");
    const ca = await center(a);
    // (while dragging, only the dragged note's edges may lose their routes;
    // let go, every edge is routed again, none left straight)
    const straight = `window.sagebrush.board.snapshot().edges.filter((e) => !e.points).map((e) => e.from + "->" + e.to)`;
    // (Alt held: no snapping, so it moves exactly as far; and the press is
    // quick: a drag shows from its first move)
    const tPress = Date.now();
    await mouse("mousePressed", ca.x, ca.y, { modifiers: 1 });
    await mouse("mouseMoved", ca.x + 1, ca.y + 1, { modifiers: 1 });
    check(Date.now() - tPress < 250, `pressing a note to drag it took ${Date.now() - tPress} ms`);
    for (let i = 1; i <= 8; i++) await mouse("mouseMoved", ca.x + (60 * i) / 8, ca.y + (90 * i) / 8, { modifiers: 1 });
    const during = await ev(straight);
    check(during.every((x) => x.split("->").includes(a)), `while dragging ${a}, other edges went straight: ${during.join(", ")}`);
    await mouse("mouseReleased", ca.x + 60, ca.y + 90, { buttons: 0, modifiers: 1 });
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
    await until("document.querySelector('.board-editing .be-title') === document.activeElement", 5000);
    await send("Input.insertText", { text: "A new note" });
    await ev("document.querySelector('.board-editing .mb-block').click(), 1");
    await send("Input.insertText", { text: "with $x^2$" });
    await ev("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))");
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
    check(!(await ev("document.querySelector('[data-sbb=revert]').hidden")), "Revert is hidden after edits");
    await ev("document.querySelector('[data-sbb=revert]').click()");
    await sleep(400);
    check(!(await docOf()).nodes.some((n) => n.title === "A new note"), "Revert did not restore the original");
    // (no saved board; its outputs' cache keeps a name beside it, page.ts)
    check(await ev("Object.keys(localStorage).every((k) => k.endsWith('#outputs'))"), "Revert left the edits saved");
    // Tidy forgets positions
    await ev("window.sagebrush.board.edit((d) => { d.nodes[0].x = 5000; d.nodes[0].y = 5000; })");
    await ev("document.querySelector('[data-sbb=tidy]').click()");
    await sleep(300);
    check((await docOf()).nodes.every((n) => n.x === undefined), "Tidy kept positions");
    // Import Mermaid…: a flowchart pasted in replaces the board (undoable);
    // its shapes, labels, subgraph and edge styles carry over
    {
      const before = (await docOf()).nodes.length;
      await ev("document.querySelector('[data-sbb=mermaid]').click()");
      await until("document.querySelector('[data-sbb=mmdlg]').open");
      await ev(`document.querySelector('[data-sbb=mmtext]').value = ${JSON.stringify("flowchart LR\n  a([Start]) --> b{Is it?}\n  b -->|yes| c[Done]\n  b -. no .-> d[[Retry]]\n  subgraph s [Later]\n    d <--> e[(Store)]\n  end\n  classDef hot fill:#fbb\n  class b hot")}`);
      await ev("document.querySelector('[data-sbb=mm-go]').click()");
      await until("!document.querySelector('[data-sbb=mmdlg]').open && window.sagebrush.board.snapshot().routed", 10000);
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
      // edges: click one to select it, Delete, undo; double-click for its panel
      await ev("window.sagebrush.board.editing(true)");
      const toClient = (x, y) => ev(`(() => { const r = window.board.el.getBoundingClientRect(), c = window.board.camera; return { x: r.left + (${x} - c.x) * c.z, y: r.top + (${y} - c.y) * c.z }; })()`);
      const edgeOf = async (from, to) => (await ev("window.sagebrush.board.snapshot().edges")).find((e) => e.from === from && e.to === to);
      await ev("window.board.focus(['b', 'c'], true)");
      await sleep(300);
      let ebc = await edgeOf("b", "c");
      let at = await toClient(ebc.lx, ebc.ly);
      await mouse("mousePressed", at.x, at.y); await mouse("mouseReleased", at.x, at.y, { buttons: 0 });
      check((await ev("window.sagebrush.board.snapshot().selectedEdge")) === ebc.id, "clicking an edge's label did not select it");
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))");
      await sleep(300);
      check(!(await docOf()).edges.some((e) => e.from === "b" && e.to === "c"), "Delete did not remove the selected edge");
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
      await sleep(400);
      check((await docOf()).edges.some((e) => e.from === "b" && e.to === "c" && e.label === "yes"), "undo did not bring the edge back");
      ebc = await edgeOf("b", "c");
      // (on its line this time, not its label: the middle of its longest segment)
      const p = ebc.points ?? [];
      let best = 0;
      for (let i = 0; i + 3 < p.length; i += 2) if (Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]) > Math.hypot(p[best + 2] - p[best], p[best + 3] - p[best + 1])) best = i;
      const onLine = { x: (p[best] + p[best + 2]) / 2, y: (p[best + 1] + p[best + 3]) / 2 };
      // (away from the label, which may sit on that segment)
      if (Math.hypot(onLine.x - ebc.lx, onLine.y - ebc.ly) < 30) { onLine.x = p[best] + (p[best + 2] - p[best]) * 0.15; onLine.y = p[best + 1] + (p[best + 3] - p[best + 1]) * 0.15; }
      at = await toClient(onLine.x, onLine.y);
      await mouse("mousePressed", at.x, at.y, { clickCount: 1 }); await mouse("mouseReleased", at.x, at.y, { clickCount: 1, buttons: 0 });
      await mouse("mousePressed", at.x, at.y, { clickCount: 2 }); await mouse("mouseReleased", at.x, at.y, { clickCount: 2, buttons: 0 });
      await until("document.querySelector('.board-edge-editor .be-label') === document.activeElement", 5000);
      await ev("document.querySelector('.be-label').select()");
      await send("Input.insertText", { text: "maybe so" });
      await ev("(() => { const s = document.querySelector('.be-line'); s.value = 'dotted'; s.dispatchEvent(new Event('change')); })()");
      await ev("document.querySelector('.be-label').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
      await sleep(400);
      check((await docOf()).edges.some((e) => e.from === "b" && e.to === "c" && e.label === "maybe so" && e.line === "dotted"), `the edge panel did not set the label and line: ${JSON.stringify((await docOf()).edges)}`);
      // a note dragged into a group joins it; dragged out, it leaves
      await ev("window.board.focus(['c', 's'], true)");
      await sleep(300);
      const sg = (await ev("window.sagebrush.board.snapshot().items")).find((i) => i.id === "s");
      const cc = await center("c"), into = await toClient(sg.x + sg.w - 10, sg.y + sg.h - 10);
      await drag(cc, into);
      await sleep(300);
      let dg = await docOf();
      check(dg.nodes.find((n) => n.id === "s")?.children.some((c) => c.id === "c") && !dg.nodes.some((n) => n.id === "c"), "dragging a note into a group did not put it there");
      const inside = (await ev("window.sagebrush.board.snapshot().items")).filter((i) => i.id === "c" || i.id === "s");
      const [ci, si] = [inside.find((i) => i.id === "c"), inside.find((i) => i.id === "s")];
      check(ci && si && ci.x >= si.x && ci.y >= si.y && ci.x + ci.w <= si.x + si.w && ci.y + ci.h <= si.y + si.h, "the group does not hold the note dragged into it");
      const bb = await ev("window.board.bounds()");
      await ev(`window.board.setCamera({ x: ${bb.x0} - 50, y: ${bb.y0} - 50, z: Math.min(1, (innerWidth - 40) / (${bb.x1 - bb.x0} + 700)) })`);
      await sleep(300);
      const cc2 = await center("c"), out = await toClient(bb.x1 + 400, bb.y0 + 40);
      await drag(cc2, out);
      await sleep(300);
      dg = await docOf();
      check(dg.nodes.some((n) => n.id === "c") && !dg.nodes.find((n) => n.id === "s")?.children.some((c) => c.id === "c"), "dragging a note out of its group did not take it out");
      check(dg.nodes.find((n) => n.id === "s")?.children.length === 2, "the group lost its other members");
      // Help, where the hint strip was (William's B5): a ? in the top bar, ⋯'s
      // Help, or the ? key, open a dialog of the keys and gestures with links to
      // read more; Esc closes it
      check(await ev("!/Drag to move/.test(document.querySelector('[data-sbb=top]').textContent)"), "B5: no hint strip in the top bar");
      const helpOpen = () => ev("document.querySelector('[data-sbb=helpdlg]').open");
      check(await ev("(() => { const b = document.querySelector('[data-sbb=help]'); return !!b.offsetParent && b.getAttribute('aria-label') === 'Help'; })()"), "B5: a Help button in the top bar");
      await ev("document.querySelector('[data-sbb=help]').click(), 1");
      check(await helpOpen(), "B5: Help opens its dialog");
      check(await ev("(() => { const d = document.querySelector('[data-sbb=helpdlg]'), t = d.textContent; return /Shift-drag from one note to another/.test(t) && /Double-click an item to write in it/.test(t) && [...d.querySelectorAll('a')].map((a) => a.href).join() === 'https://sagebrush.space/board-format.md,https://sagebrush.space/articles/notebook/01-how-cells-run,https://sagebrush.space/articles/' && [...d.querySelectorAll('a')].every((a) => a.target === '_blank' && /noopener/.test(a.rel)); })()"), "B5: ...what the hint said, more, and links to read more (in a new tab)");
      // (real keys, astra's UI-D74-1: while Help is open the board's
      // shortcuts wait, its tour, Delete, undo and redo, and the arrows that
      // move a selection; Esc closes it, as the browser closes a dialog)
      {
        await ev("document.querySelector('[data-sbb=helpdlg]').close(), 1");
        const rk = async (key, code, vk, modifiers = 0) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, modifiers }); await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers }); await sleep(200); };
        const cn = await center("c");
        await mouse("mousePressed", cn.x, cn.y); await mouse("mouseReleased", cn.x, cn.y, { buttons: 0 });
        await sleep(300);
        const selected = await ev("window.board.selection.has('c')"), before = JSON.stringify(await docOf()), step0 = await ev("window.sagebrush.board.snapshot().step");
        await ev("document.querySelector('[data-sbb=help]').click(), 1");
        check((await helpOpen()) && await ev("document.querySelector('[data-sbb=helpdlg]').contains(document.activeElement)"), "B5: Help opens with the focus in it");
        for (const k of [["ArrowRight", "ArrowRight", 39], ["ArrowDown", "ArrowDown", 40], ["Delete", "Delete", 46], ["Backspace", "Backspace", 8], [" ", "Space", 32], ["0", "Digit0", 48], ["?", "Slash", 191, 8], ["z", "KeyZ", 90, 2], ["z", "KeyZ", 90, 10], ["y", "KeyY", 89, 2]]) await rk(...k);
        check(selected && JSON.stringify(await docOf()) === before, "B5: with Help open, real keys (arrows, Delete, Backspace, undo, redo) leave the board as it was: " + selected);
        check((await ev("window.sagebrush.board.snapshot().step")) === step0 && (await helpOpen()), "B5: ...and its tour, Help still open");
        await rk("Escape", "Escape", 27);
        check(!(await helpOpen()), "B5: Esc closes Help (the browser's, not the board's)");
        await rk("Delete", "Delete", 46);
        check(!(await docOf()).nodes.some((n) => n.id === "c" || n.children?.some((m) => m.id === "c")), "B5: ...after which the board's keys are its own again (Delete deletes the selected note)");
        await rk("z", "KeyZ", 90, 2);
        check(JSON.stringify(await docOf()) === before, "B5: ...and undo brings it back");
      }
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })), 1");
      check(await helpOpen(), "B5: the ? key opens it");
      await ev("document.querySelector('[data-sbb=helpdlg]').close(), 1");
      await ev("document.querySelector('[data-sbb=menubtn]').click(), document.querySelector('[data-sbb=helpitem]').click(), 1");
      check((await helpOpen()) && await ev("document.querySelector('[data-sbb=menu]').hidden"), "B5: ⋯'s Help opens it, the menu closed");
      await ev("document.querySelector('[data-sbb=helpdlg]').close(), 1");
      // the toolbar (Edit mode only): the default tools; connecting by taps;
      // a note added, then cancelled; choosing this board's tools
      check(await ev("!document.querySelector('.board-toolbar').hidden"), "the toolbar shows in Edit");
      const tools = () => ev("[...document.querySelectorAll('.board-toolbar [data-tool]')].map((b) => b.dataset.tool).join()");
      check((await tools()) === "note,code,image,group,connect,draw", `the default tools: ${await tools()}`);
      await ev("window.board.focus(['b', 'c'], true)");
      await sleep(300);
      await ev("document.querySelector('.board-toolbar [data-tool=connect]').click(), 1");
      check(await ev("document.querySelector('.board-toolbar [data-tool=connect]').getAttribute('aria-pressed') === 'true'"), "Connect is on");
      for (const id of ["c", "b"]) {
        const p = await center(id);
        await mouse("mousePressed", p.x, p.y);
        await mouse("mouseReleased", p.x, p.y);
        await sleep(200);
      }
      await sleep(300);
      check((await docOf()).edges.some((e) => e.from === "c" && e.to === "b"), `tapping c, then b, in Connect did not connect them: ${JSON.stringify((await docOf()).edges.map((e) => e.from + ">" + e.to))}`);
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      check(await ev("document.querySelector('.board-toolbar [data-tool=connect]').getAttribute('aria-pressed') === 'false'"), "Escape leaves Connect");
      const n0 = (await docOf()).nodes.length;
      await ev("document.querySelector('.board-toolbar [data-tool=note]').click(), 1");
      await until("!!document.querySelector('.board-editing .be-title')", 5000);
      check((await docOf()).nodes.length === n0 + 1, "Note adds a note, being written where it is");
      await ev("document.querySelector('.board-editing .be-title').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await sleep(400);
      // (left empty, it is kept, to be moved and written in later, William's B2: then undone, for what follows)
      check((await docOf()).nodes.length === n0 + 1, "a new note left empty is kept");
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
      await sleep(300);
      check((await docOf()).nodes.length === n0, "...and one undo takes it back");
      await ev("document.querySelector('.board-toolbar .tb-more').click(), 1");
      check(await ev("document.querySelectorAll('.board-toolbar-panel .tb-use').length >= 8"), "⋯ lists every tool");
      await ev("(() => { const b = document.querySelector('.board-toolbar-panel input[data-tool=group]'); b.checked = false; b.dispatchEvent(new Event('change')); })()");
      await sleep(400);
      check(JSON.stringify((await docOf()).tools) === '["note","code","image","connect","draw"]' && (await tools()) === "note,code,image,connect,draw", `the board's tools without Group: ${JSON.stringify((await docOf()).tools)}, shown ${await tools()}`);
      // (which tools a board shows is a setting: undo leaves it)
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
      await sleep(400);
      check((await tools()) === "note,code,image,connect,draw", `undo changed the toolbar: ${await tools()}`);
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }))");
      await sleep(400);
      // (a tool used from the menu: Select, not on the toolbar, shows its icon on ⋯; a plain drag on the background selects)
      await ev("document.querySelector('.board-toolbar-panel') || document.querySelector('.board-toolbar .tb-more').click(), 1");
      await ev("document.querySelector('.board-toolbar-panel .tb-use[data-tool=select]').click(), 1");
      await sleep(200);
      check(await ev("!document.querySelector('.board-toolbar-panel') && !!document.querySelector('.board-toolbar .tb-more [data-icon=select]')"), `Select from the menu: ⋯ shows its icon (${await ev("document.querySelector('.board-toolbar .tb-more').textContent")})`);
      await ev("window.board.focus(['b', 'c'], true)");
      await sleep(300);
      const sr = await ev("(() => { const a = window.board.clientRect('b'), c = window.board.clientRect('c'); const r = window.board.el.getBoundingClientRect(); const x0 = Math.min(a.left, c.left) - 14, y0 = Math.min(a.top, c.top) - 14; return { x0, y0, x1: Math.max(a.left + a.width, c.left + c.width) + 14, y1: Math.max(a.top + a.height, c.top + c.height) + 14, free: !window.board.itemAt(x0 - r.left, y0 - r.top) }; })()");
      if (sr.free) {
        const cam0 = await ev("JSON.stringify(window.board.camera)");
        await drag({ x: sr.x0, y: sr.y0 }, { x: sr.x1, y: sr.y1 }, { modifiers: 0 });
        check((await ev("document.querySelectorAll('.board-item.selected').length")) >= 2 && cam0 === (await ev("JSON.stringify(window.board.camera)")), "with Select, a plain drag on the background selects (and does not pan)");
      }
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      check(await ev("document.querySelector('.board-toolbar .tb-more').textContent === '⋯' && !document.querySelector('.board-toolbar .tb-more svg')"), "Esc leaves Select");
      await ev("window.sagebrush.board.editing(false)");
      check(await ev("document.querySelector('.board-toolbar').hidden && !document.querySelector('.board-toolbar-panel')"), "the toolbar goes with Edit");
      await ev("window.sagebrush.board.editing(true)");
      // selecting several (shift-click), moving them together, duplicating,
      // copying and pasting, deleting, a rectangle (shift-drag on the
      // background), snapping to another item's edge, the arrow keys
      await ev("window.board.focus(['b', 'c'], true)");
      await sleep(300);
      const selected = () => ev("[...document.querySelectorAll('.board-item.selected')].length");
      const shiftClick = async (id) => { const p = await center(id); await mouse("mousePressed", p.x, p.y, { modifiers: 8 }); await mouse("mouseReleased", p.x, p.y, { modifiers: 8 }); await sleep(150); };
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await shiftClick("b");
      await shiftClick("c");
      check((await selected()) === 2, `shift-click selects two (${await selected()})`);
      const [b0, c0] = [await box("b"), await box("c")];
      const zz = await ev("window.board.camera.z");
      await drag(await center("b"), { x: (await center("b")).x + 40, y: (await center("b")).y + 30 });
      const [b1, c1] = [await box("b"), await box("c")];
      check(Math.abs(b1.x - b0.x - 40 / zz) < 2 && Math.abs(c1.x - c0.x - 40 / zz) < 2 && Math.abs(c1.y - c0.y - (b1.y - b0.y)) < 1, `dragging one of two selected moves both (b ${b1.x - b0.x}, ${b1.y - b0.y}; c ${c1.x - c0.x}, ${c1.y - c0.y}; want ${40 / zz})`);
      const nodes0 = (await docOf()).nodes.length, edges0 = (await docOf()).edges.length;
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }))");
      await sleep(400);
      let dd = await docOf();
      check(dd.nodes.length === nodes0 + 2 && dd.edges.length > edges0 && (await selected()) === 2, `Ctrl+D duplicates the two, with their edge, and selects the copies (${dd.nodes.length - nodes0} nodes, ${dd.edges.length - edges0} edges)`);
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))");
      await sleep(400);
      dd = await docOf();
      check(dd.nodes.length === nodes0 && dd.edges.length === edges0, "Delete removes the selected copies and their edges");
      // (the clipboard: the page's own copy and paste events)
      await shiftClick("b");
      const copied = await ev("(() => { const t = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: t, bubbles: true })); return t.getData('text/plain'); })()");
      check(/"sagebrush-board"/.test(copied), "copying puts the selection on the clipboard");
      await ev(`(() => { const t = new DataTransfer(); t.setData('text/plain', ${JSON.stringify(copied)}); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: t, bubbles: true })); })()`);
      await sleep(400);
      check((await docOf()).nodes.length === nodes0 + 1, "pasting it adds a copy");
      await ev("(() => { const t = new DataTransfer(); t.setData('text/plain', 'Pasted words'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: t, bubbles: true })); })()");
      await sleep(400);
      check((await docOf()).nodes.some((n) => n.text === "Pasted words"), "pasting text makes a note of it");
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
      await sleep(300);
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
      await sleep(300);
      check((await docOf()).nodes.length === nodes0, "undo takes the pastes back");
      // (a rectangle around b and c, from empty background)
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await ev("window.board.focus(['b', 'c'], true)");
      await sleep(300);
      const rect = await ev("(() => { const a = window.board.clientRect('b'), c = window.board.clientRect('c'); const r = window.board.el.getBoundingClientRect(); const x0 = Math.min(a.left, c.left) - 14, y0 = Math.min(a.top, c.top) - 14; return { x0, y0, x1: Math.max(a.left + a.width, c.left + c.width) + 14, y1: Math.max(a.top + a.height, c.top + c.height) + 14, free: !window.board.itemAt(x0 - r.left, y0 - r.top) }; })()");
      if (rect.free) {
        await drag({ x: rect.x0, y: rect.y0 }, { x: rect.x1, y: rect.y1 }, { modifiers: 8 });
        const sel = await ev("[...document.querySelectorAll('.board-item.selected')].length");
        check(sel >= 2, `a shift-drag rectangle selects what it holds (${sel})`);
      }
      // (snapping: two notes of their own, far from the rest; one let go 3
      // pixels from the other's left edge lines up with it)
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await ev("window.sagebrush.board.edit((d) => { d.nodes.push({ id: 'sa', text: 'Snap A', x: 20000, y: 20000 }, { id: 'sb', text: 'Snap B', x: 20300, y: 20260 }); })");
      await sleep(400);
      await ev("window.board.focus(['sa', 'sb'], true)");
      await sleep(400);
      const [sa, sb] = [await box("sa"), await box("sb")], z3 = await ev("window.board.camera.z");
      const sp = await center("sb");
      await drag(sp, { x: sp.x + (sa.x - sb.x) * z3 + 3, y: sp.y }, { modifiers: 0 });
      check(Math.abs((await box("sb")).x - sa.x) < 0.01, `a note let go 3 px from another's left edge snaps to it (${(await box("sb")).x - sa.x})`);
      // (the note dragged is the one selected)
      // (the arrow keys: the selection moves)
      const sx0 = (await box("sb")).x;
      await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))");
      await sleep(300);
      check(Math.abs((await box("sb")).x - sx0 - 10) < 0.01, `shift+→ moves the selection 10 (${(await box("sb")).x - sx0})`);
      // (undone, all of it: the board before the import)
      for (let i = 0; i < 12 && (await docOf()).nodes.length !== before; i++) {
        await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
        await sleep(300);
      }
      check((await docOf()).nodes.length === before, "undo did not bring the board back after Import Mermaid");
    }
    // pages: add one (the board becomes page 1), write on it, delete it
    const nodes0 = (await docOf()).nodes.length;
    await ev("document.querySelector('[data-sbb=addpage]').click()");
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
    await ev("document.querySelector('[data-sbb=rmpage]').click()");
    await sleep(500);
    dp = await docOf();
    check(!dp.pages && dp.nodes.length === nodes0, "Delete this page did not leave the board as it was");
    // the format's name and version: first in every document; a board
    // without them is version 1; another format or a later version is refused
    const keys = await ev("Object.keys(window.sagebrush.board.snapshot().doc).slice(0, 2).join()");
    const port = await ev("window.sagebrush.board.portable().then((d) => JSON.stringify([d.format, d.version]))");
    check(keys === "format,version" && port === '["sagebrush-board",1]', `the document does not start with its format and version: ${keys} ${port}`);
    // Download JSON: the board's file, foo.board.json, its canonical text (doc.ts canonical(); test-format.mjs)
    const dl = await ev(`new Promise((resolve) => { const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { HTMLAnchorElement.prototype.click = click; fetch(this.href).then((r) => r.text()).then((text) => resolve({ name: this.download, text })); }; document.querySelector("[data-sbb=download]").click(); })`);
    const file = await ev("window.sagebrush.board.json()");
    check(/\.board\.json$/.test(dl.name) && dl.text === file && file.startsWith('{\n  "format": "sagebrush-board",\n  "version": 1,\n'), `Download JSON is not the board's file, foo.board.json, in canonical JSON: ${dl.name} ${JSON.stringify(dl.text.slice(0, 60))}`);
    // Download JSON Canvas: foo.canvas, the board as a canvas (canvas.ts; test-canvas.mjs), and what it left out said;
    // opened again (Open…), the board's notes and groups
    const dc = await ev(`new Promise((resolve) => { const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { HTMLAnchorElement.prototype.click = click; fetch(this.href).then((r) => r.text()).then((text) => resolve({ name: this.download, text })); }; document.querySelector("[data-sbb=canvas]").click(); })`);
    const cv = await ev("window.sagebrush.board.canvas()");
    const steps = await ev("(() => { const d = window.sagebrush.board.snapshot().doc; return (d.pages ?? [d]).reduce((n, p) => n + (p.steps?.length ?? 0), 0); })()");
    check(/\.canvas$/.test(dc.name) && dc.text === cv.text && JSON.parse(dc.text).nodes.length > 0, `Download JSON Canvas is not the board as a canvas: ${dc.name}`);
    check(steps > 0 && (await waits(`/Downloaded as JSON Canvas/.test(document.querySelector("[data-sbb=say]").textContent) && document.querySelector("[data-sbb=say]").textContent.includes("${steps} step${steps === 1 ? "" : "s"} of the tour")`, 3000)), `Download JSON Canvas does not say it left out the tour (${steps} steps)`);
    const before = await ev("window.sagebrush.board.snapshot().items.filter((i) => i.kind === 'note' || i.kind === 'group').map((i) => i.id).sort().join()");
    const cf = join(profile, "board.canvas");
    writeFileSync(cf, dc.text);
    await ev("document.querySelector('[data-sbb=open]').click(), 1");
    const droot = await send("DOM.getDocument", { depth: -1 });
    const picker = await send("DOM.querySelector", { nodeId: droot.root.nodeId, selector: "[data-sbb=openfile]" });
    await send("DOM.setFileInputFiles", { files: [cf], nodeId: picker.nodeId });
    check(await waits(`window.sagebrush.board.snapshot().items.filter((i) => i.kind === 'note' || i.kind === 'group').map((i) => i.id).sort().join() === ${JSON.stringify(before)} && /Converted from a JSON Canvas/.test(document.querySelector("[data-sbb=say]").textContent)`, 5000), "a .canvas opened (Open…) is not the board's notes and groups again, or doesn't say it was converted");
    // a document loaded while a file opened is still being read: the load, newer, wins; the file is not opened over it
    await ev("(() => { const t = File.prototype.text; File.prototype.text = function () { return new Promise((r) => { window.__release = () => { File.prototype.text = t; r(t.call(this)); }; }); }; return 1; })()");
    await ev("document.querySelector('[data-sbb=open]').click(), 1");
    const droot2 = await send("DOM.getDocument", { depth: -1 });
    const picker2 = await send("DOM.querySelector", { nodeId: droot2.root.nodeId, selector: "[data-sbb=openfile]" });
    await send("DOM.setFileInputFiles", { files: [cf], nodeId: picker2.nodeId });
    await waits("!!window.__release", 5000);
    await ev(`window.sagebrush.board.load({ title: "Meanwhile", nodes: [{ id: "m1", title: "Loaded while the file was read" }] })`);
    await ev("window.__release(), 1");
    await sleep(1500);
    check((await ev("window.sagebrush.board.snapshot().items.map((i) => i.id).join()")) === "m1", "a file whose reading ends after a document was loaded is opened over it: " + (await ev("window.sagebrush.board.snapshot().items.length")) + " items");
    await ev(`window.sagebrush.board.load({ title: "Old", nodes: [{ id: "o1", title: "Written before versions" }] })`);
    check((await docOf()).version === 1 && (await ev("window.sagebrush.board.snapshot().items.map((i) => i.id).join()")) === "o1", "a board without a version is not read as version 1");
    for (const [bad, says] of [[{ format: "sagebrush-board", version: 2, nodes: [{ id: "n2" }] }, "version 2"], [{ format: "excalidraw", nodes: [{ id: "x" }] }, "excalidraw"]]) {
      const err = await ev(`window.sagebrush.board.load(${JSON.stringify(bad)}).then(() => "", (e) => String(e.message))`);
      check(err.includes(says) && (await ev("window.sagebrush.board.snapshot().items.map((i) => i.id).join()")) === "o1", `a board in ${says} was not refused, or replaced the board shown: ${err}`);
    }
    // a board's language: MATLAB and Magma code items, translated as in the notebook;
    // the language buttons switch it, and every item runs again in the new one
    await ev(`window.sagebrush.board.load({ title: "Languages", mode: "matlab", nodes: [{ id: "m1", title: "Data", code: "x = 1:5;\\ny = x.^2" }, { id: "m2", title: "Sum", code: "s = sum(y)" }] })`);
    let outs = (await ev("(async () => JSON.stringify(await window.sagebrush.board.run()))()"));
    const text = (j) => JSON.parse(j).map((o) => o.output).join(" ");
    check(/y =\s+1\s+4\s+9\s+16\s+25/.test(text(outs)) && /s =\s+55/.test(text(outs)), "a MATLAB board's code items run as MATLAB: " + outs);
    check((await ev("document.querySelector('[data-sbb=lang] button[data-mode=matlab]').getAttribute('aria-pressed')")) === "true", "the MATLAB button is pressed on a MATLAB board");
    await ev(`window.sagebrush.board.edit((d) => { d.mode = "magma"; for (const n of d.nodes) n.code = n.id === "m1" ? "x := 2^10;\\nx;" : "Factorization(x + 2);"; })`);
    outs = await ev("(async () => JSON.stringify(await window.sagebrush.board.outputs()))()");
    check(outs.includes("1024") && outs.includes("<2, 1>, <3, 3>, <19, 1>"), "switched to Magma, the items run as Magma: " + outs);
    check((await docOf()).mode === "magma", "the board's file says magma");
    // notes measured all at once (mount.ts premeasure) are the sizes measuring each alone gives
    const many = { title: "Measured", nodes: [
      ...Array.from({ length: 60 }, (_, i) => ({ id: "s" + i, title: "Note " + i, text: "Some *text* " + "word ".repeat(i % 13) + (i % 5 === 0 ? "with $x^{" + i + "}$" : ""), ...(i % 4 === 0 ? { detail: "More, when zoomed in" } : {}), ...(i % 6 === 0 ? { ref: "https://example.org/" + i } : {}), ...(i % 3 === 0 ? { fit: true } : { w: 220 + (i % 5) * 40 }), x: (i % 10) * 420, y: Math.floor(i / 10) * 400 })),
      { id: "grp", kind: "group", title: "A group", text: "Its own text, measured too", children: [{ id: "g1", title: "Member", text: "inside" }], x: 0, y: 3000 },
    ] };
    await ev("(() => { const b = window.board; window.__counts = { one: 0, many: 0 }; for (const k of ['measure', 'measureWidth']) { const f = b[k].bind(b); b[k] = (...a) => (window.__counts.one++, f(...a)); } if (b.measureMany) { const g = b.measureMany.bind(b); b.measureMany = (l) => (window.__counts.many++, g(l)); } return 1; })()");
    await ev(`window.sagebrush.board.load(${JSON.stringify(many)}).then(() => 1)`);
    const counts = await ev("window.__counts");
    await ev("(() => { for (const k of ['measure', 'measureWidth', 'measureMany']) delete window.board[k]; return 1; })()");
    check(counts.one === 0 && counts.many >= 1 && counts.many <= 3, "a board's notes are measured together, not one layout each: " + JSON.stringify(counts));
    const mismatched = await ev(`(() => { const d = window.sagebrush.board.snapshot().doc, bad = []; for (const n of d.nodes) { if (n.kind === "group") continue; const it = window.board.item(n.id); const h = Math.max(60, Math.ceil(window.board.measure({ kind: "note", title: n.title, text: n.text, detail: n.detail, ref: n.ref }, it.w)) + 2); if (h !== it.h) bad.push([n.id, it.w, it.h, h]); } return bad; })()`);
    check(mismatched.length === 0, "notes measured all at once have the sizes measuring each alone gives: " + JSON.stringify(mismatched.slice(0, 5)));
    // (and its template's code items: PERF-F2A-1, daybreak)
    const templated = { title: "Templated", pages: [{ id: "t", template: true, nodes: Array.from({ length: 40 }, (_, i) => ({ id: "c" + i, title: "Code " + i, code: "x" + i + " = " + i, x: (i % 8) * 400, y: Math.floor(i / 8) * 260 })) }, { uses: "t", nodes: [{ id: "o", title: "Own", x: 0, y: 1600 }] }] };
    await ev("(() => { const b = window.board; window.__counts = { one: 0, many: 0 }; for (const k of ['measure', 'measureWidth']) { const f = b[k].bind(b); b[k] = (...a) => (window.__counts.one++, f(...a)); } if (b.measureMany) { const g = b.measureMany.bind(b); b.measureMany = (l) => (window.__counts.many++, g(l)); } return 1; })()");
    await ev(`window.sagebrush.board.load(${JSON.stringify(templated)}).then(() => window.sagebrush.board.page(1)).then(() => 1)`);
    const tcounts = await ev("window.__counts");
    await ev("(() => { for (const k of ['measure', 'measureWidth', 'measureMany']) delete window.board[k]; return 1; })()");
    check(tcounts.one === 0, "a template's code items are measured with the rest, not one layout each: " + JSON.stringify(tcounts));
    // fonts arriving after the notes were measured (KaTeX's, on a slow line): measured again, the text fits
    await ev(`window.sagebrush.board.load({ title: "Fonts", nodes: [{ id: "f", title: "Late font", text: "Text whose font comes later, " + "and is larger. ".repeat(6), x: 0, y: 0, w: 260 }] }).then(() => 1)`);
    await ev("window.board.setCamera({ x: -40, y: -40, z: 1 }), window.board.render(), 1");
    await sleep(200);
    const h0 = await ev("window.board.item('f').h");
    await ev("(() => { const s = document.createElement('style'); s.id = 'late-font'; s.textContent = '.sbb .board-note { font-size: 22px !important; }'; document.head.append(s); document.fonts.dispatchEvent(new Event('loadingdone')); return 1; })()");
    const grew = await until(`window.board.item('f').h > ${h0 + 20}`, 3000).then(() => true, () => false);
    await sleep(200);
    const fits = await ev("(() => { const e = window.board.cache.get('f'); return !!e && e.scrollHeight <= e.clientHeight + 1; })()");
    await ev("document.getElementById('late-font').remove(), document.fonts.dispatchEvent(new Event('loadingdone')), 1");
    check(grew && fits, "a font arriving after the notes were measured: measured again, the text fits: " + JSON.stringify({ h0, h: await ev("window.board.item('f').h"), fits }));
    await ev("localStorage.clear()");
  }
  check(!errors.length, "page errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
  if (errors.length) fails.push("page errors: " + errors.join(" | "));
  fails.push("the page says: " + (await ev("document.querySelector('[data-sbb=say]')?.textContent ?? ''").catch(() => "")));
} finally {
  ws.close();
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
if (fails.length) {
  console.log("FAIL\n  " + fails.join("\n  "));
  process.exit(1);
}
console.log("ok");
