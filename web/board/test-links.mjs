// Links to places on a board (doc.ts boardLink(), mount.ts, board.ts; round
// 0's 15): a note's ref `#page-id` shows "→ " and the page's title, and a
// click goes to that page; `#page-id/item-id` to an item on it, in view;
// `#p2-1` to a page's step; a Markdown link in a note's text, and in the
// caption, the same; one naming nothing does nothing; refBase is not put
// before one.  A link to the page shown goes to its start and intro too
// (UI-07E-1), and a link whose page is still being drawn when another
// document is loaded or dropped does nothing there (UI-07E-2).  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-links.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-links-"));
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
const B = "window.sagebrush.board";
const where = () => ev(`(() => { const s = ${B}.snapshot(); return { page: s.page, step: s.step, hash: location.hash }; })()`);
// (a real click on a link's middle)
const clickLink = async (sel) => {
  const r = await ev(`(() => { const a = document.querySelector(${JSON.stringify(sel)}); if (!a) return null; a.scrollIntoView?.({ block: "nearest" }); const b = a.getBoundingClientRect(); return { x: b.left + Math.min(b.width / 2, 20), y: b.top + b.height / 2 }; })()`);
  if (!r) return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
  await sleep(900);
  return true;
};
// (an item wholly in the window)
const inView = (id) => ev(`(() => { const r = window.board.clientRect(${JSON.stringify(id)}); return !!r && r.left >= 0 && r.top >= 40 && r.left + r.width <= innerWidth && r.top + r.height <= innerHeight; })()`);

const DOC = { title: "Links", refBase: "https://github.com/o/r/blob/main/", intro: "Start here, or [go to the releases](#rel).", pages: [
  { id: "ov", title: "Overview", nodes: [
    { id: "a", title: "See the boards", ref: "#boards" },
    { id: "b", title: "A release", ref: "#rel/r2" },
    { id: "c", title: "Text", text: "Read [the second step](#p2-1), or [nothing](#nowhere)." },
    { id: "d", title: "A file", ref: "lib/x.py" }] },
  { id: "boards", title: "Boards", nodes: [{ id: "x", title: "X" }], steps: [{ focus: "x", say: "X here" }] },
  { id: "rel", title: "Releases", nodes: Array.from({ length: 12 }, (_, i) => ({ id: "r" + i, title: "Release " + i, x: (i % 4) * 700, y: Math.floor(i / 4) * 500 })) },
] };

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/?runner=0` });
  if (!(await until(`${B}?.snapshot().items.length > 0`, 60000))) throw new Error("the board did not open");
  await ev("history.replaceState(null, '', location.pathname + location.search)");
  await ev(`${B}.load(${JSON.stringify(DOC)}).then(() => 1)`);
  await sleep(500);
  const refs = await ev("[...document.querySelectorAll('.board-ref')].map((a) => [a.textContent, a.getAttribute('href'), a.target])");
  check(JSON.stringify(refs.find((r) => r[1] === "#boards")) === JSON.stringify(["→ Boards", "#boards", ""]), "a ref to a page: \"→ \" and its title, on the board: " + JSON.stringify(refs));
  check(refs.some((r) => r[1] === "#rel/r2" && r[0] === "→ Release 2"), "a ref to an item on a page: its title: " + JSON.stringify(refs));
  check(refs.some((r) => r[1] === "https://github.com/o/r/blob/main/lib/x.py"), "a path still under refBase; a place on the board never: " + JSON.stringify(refs));

  // a click on the ref to a page: that page, from its start
  check(await clickLink(".board-ref[href='#boards']"), "(the ref to Boards clicked)");
  let w = await where();
  check(w.page === 1 && w.step === -1 && w.hash === "#p2", "a page's ref clicked: that page, from its start: " + JSON.stringify(w));
  // back, and an item on another page: that page, the item in view
  await ev(`${B}.page(0)`); await sleep(600);
  await clickLink(".board-ref[href='#rel/r2']");
  w = await where();
  check(w.page === 2 && (await inView("r2")), "an item's ref clicked: its page, the item in view: " + JSON.stringify(w));
  // a Markdown link in a note's text: a page's step
  await ev(`${B}.page(0)`); await sleep(600);
  await clickLink(".board-item a[href='#p2-1']");
  w = await where();
  check(w.page === 1 && w.step === 0 && w.hash === "#p2-1", "a Markdown link to #p2-1: page 2's first step: " + JSON.stringify(w));
  // one naming nothing: nothing
  await ev(`${B}.page(0)`); await sleep(600);
  const before = await where();
  await clickLink(".board-item a[href='#nowhere']");
  w = await where();
  check(JSON.stringify(w) === JSON.stringify(before), "a link naming nothing on the board: nothing happens, the address as it was: " + JSON.stringify([before, w]));
  // the caption's: the intro's link to a page
  await ev(`${B}.page(0)`); await sleep(600);
  await clickLink("[data-sbb=say] a[href='#rel']");
  w = await where();
  check(w.page === 2 && w.hash === "#p3", "a link in the caption: its page: " + JSON.stringify(w));

  // (astra's probes, UI-07E-1 and 2)
  const TOUR = { title: "Original", pages: [
    { id: "ov", title: "Overview", intro: "Overview intro", nodes: [{ id: "a", title: "A", text: "[this page](#ov) [numbered page](#p1)", ref: "#ov" }], steps: [{ focus: "a", say: "Original first" }, { focus: "a", say: "Original second" }] },
    { id: "target", title: "Target", nodes: [{ id: "b", title: "B" }], steps: [{ focus: "b", say: "Target first" }, { focus: "b", say: "Target second" }] },
  ] };
  const NEW = { title: "Replacement", pages: [{ id: "new", title: "New", intro: "New intro", nodes: [{ id: "x", title: "X" }], steps: [{ focus: "x", say: "New first" }, { focus: "x", say: "New second" }] }, { id: "end", title: "End", nodes: [{ id: "y", title: "Y" }] }] };
  const clearHash = "history.replaceState(null, '', location.pathname + location.search)";
  const open = async (d) => { await ev(clearHash); await ev(`${B}.load(${JSON.stringify(d)}).then(() => 1)`); await ev(`${B}.editing(false)`); await sleep(300); };
  const state = () => ev(`(() => { const s = ${B}.snapshot(); return { title: s.doc.title, page: s.page, step: s.step, hash: location.hash, say: document.querySelector('[data-sbb=say]').textContent.trim() }; })()`);
  // a link to the page shown, from its tour's second step: its start, its intro (as from another page)
  for (const sel of [".board-ref[href='#ov']", ".board-item a[href='#ov']:not(.board-ref)", ".board-item a[href='#p1']"]) {
    await open(TOUR); await ev(`${B}.step(1)`); await sleep(400);
    check(await clickLink(sel), `(${sel} clicked)`);
    const s = await state();
    check(s.page === 0 && s.step === -1 && s.hash === "" && s.say === "Overview intro", `UI-07E-1: a link to the page shown (${sel}), from its tour: the page's start and intro: ` + JSON.stringify(s));
  }
  // a link to another page's step, its page still being drawn (a picture held)
  // when another document is loaded or dropped: nothing of it done there
  const holdOne = () => ev(`(async () => { const im = (await import(new URL('board.js', location.href).href)).host.images; const old = im.ensure.bind(im); window.__releaseOne = null; im.ensure = (names) => { im.ensure = old; return new Promise((ok) => (window.__releaseOne = () => old(names).then(ok))); }; return 1; })()`);
  for (const how of ["loaded", "dropped"]) {
    const race = structuredClone(TOUR);
    race.pages[0].nodes[0].ref = "#p2-2";
    await open(race); await holdOne();
    check(await clickLink(".board-ref[href='#p2-2']"), `(the link to #p2-2 clicked, ${how})`);
    if (!(await until("!!window.__releaseOne"))) { check(false, `(${how}: page 2 did not wait on its pictures)`); continue; }
    await ev(clearHash);
    if (how === "loaded") await ev(`${B}.load(${JSON.stringify(NEW)}).then(() => 1)`);
    else await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(JSON.stringify(NEW))}], "replacement.board.json", { type: "application/json" })); document.querySelector(".board-world").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 300, clientY: 300 })); return 1; })()`);
    check(await until(`${B}.snapshot().doc.title === 'Replacement'`), `(${how}: the replacement shown)`);
    await sleep(250); await ev(`${B}.step(0)`); await sleep(250);
    const before = await state();
    await ev("window.__releaseOne(), 1"); await sleep(700);
    const after = await state();
    check(JSON.stringify(after) === JSON.stringify(before) && before.step === 0, `UI-07E-2: another document ${how} while a link's page is drawn: the link does nothing there: ` + JSON.stringify({ before, after }));
    // (and the new one's own moves still go)
    await ev(`${B}.step(1)`); await sleep(300);
    const own = await state();
    check(own.title === "Replacement" && own.step === 1 && own.say === "New second", `(${how}: the replacement's own tour still moves) ` + JSON.stringify(own));
  }

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
