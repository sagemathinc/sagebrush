// The package with a host of its own, in headless Chromium: two boards
// mounted side by side on a plain page (not sagebrush.space's), each with an
// in-memory store and nothing else (no code engine, math, history, examples
// or export).  Each shows its own document, keeps its parts within its own
// element, saves its own edits, offers nothing its host lacks, shows code as
// text, edits in place, and is unmounted by destroy() while the other works.
// Build first (bun build.mjs), then
//   node test.mjs
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const site = mkdtempSync(join(tmpdir(), "sb-pkg-site-")), profile = mkdtempSync(join(tmpdir(), "sb-pkg-"));
copyFileSync(join(here, "dist", "index.js"), join(site, "index.js"));
const A = { title: "A", nodes: [{ id: "a1", title: "In A", text: "first" }, { id: "a2", title: "Code in A", code: "x = 1" }] };
const B = { title: "B", nodes: [{ id: "b1", title: "In B", text: "second" }] };
writeFileSync(join(site, "index.html"), `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<div id="a" style="position:absolute;left:0;top:0;width:620px;height:560px"></div>
<div id="b" style="position:absolute;left:640px;top:0;width:620px;height:560px"></div>
<script type="module">
import { mountBoard } from "./index.js";
const images = { url: () => undefined, put: async () => "", ensure: async () => {}, absorb: async () => {}, inline: async (d) => d };
const host = (doc) => {
  const kept = { saves: 0, doc: null };
  return { kept, host: { images, store: { load: async () => ({ doc, original: doc }), save: (d) => { kept.saves++; kept.doc = d; } } } };
};
const a = host(${JSON.stringify(A)}), b = host(${JSON.stringify(B)});
window.A = { ...a, api: mountBoard(document.getElementById("a"), a.host) };
window.B = { ...b, api: mountBoard(document.getElementById("b"), b.host) };
</script></body></html>`);
// (a plain server: the files as they are)
const server = createServer((req, res) => {
  const f = join(site, req.url === "/" ? "index.html" : req.url.slice(1).split("?")[0]);
  let body;
  try { body = readFileSync(f); } catch { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html" });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
const port = Number(process.env.CDP_PORT ?? 9463);
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1300,700", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
// (an element's box, of a board's part found within its root)
const box = (who, sel) => ev(`(() => { const r = document.getElementById(${JSON.stringify(who)}).querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url });
  check(await until("window.A?.api.agent.snapshot().items.length === 2 && window.B?.api.agent.snapshot().items.length === 1", 20000), "each board shows its own document");
  check((await ev("A.api.agent.snapshot().items.map((i) => i.id).join()")) === "a1,a2" && (await ev("B.api.agent.snapshot().items.map((i) => i.id).join()")) === "b1", "...A's items in A, B's in B");
  check(await ev("document.querySelectorAll('style[data-sbb]').length === 1 && document.querySelectorAll('style[data-mb]').length === 0"), "the board's stylesheet is in the page once");
  // the parts are within each board's element
  const at = await box("b", "#top"), bb = await ev("(() => { const r = document.getElementById('b').getBoundingClientRect(); return { left: r.left, right: r.right }; })()");
  check(at.left >= bb.left - 1 && at.right <= bb.right + 1, "B's top bar is within B: " + JSON.stringify([at, bb]));
  check(await ev("[...document.querySelectorAll('#a .board-note, #b .board-note')].every((e) => { const root = e.closest('.sbb'), r = e.getBoundingClientRect(), b = root.getBoundingClientRect(); return r.left >= b.left - 1; })"), "each board's notes are in its own element");
  // what the host does not give is not offered; code shows as text
  check(await ev("['timetravel', 'examples', 'html'].every((id) => document.querySelector('#a #' + id).hidden)"), "no history, examples or export: TimeTravel…, Examples… and Download as HTML are not in the menu");
  check(await until("document.querySelector('#a .board-code-src')?.textContent === 'x = 1' && !document.querySelector('#a .board-code-run')", 3000), "no code engine: code shows as text, with no ▶");
  // each board's menu is its own
  await ev("document.querySelector('#b #menubtn').click(), 1");
  check(await ev("!document.querySelector('#b #menu').hidden && document.querySelector('#a #menu').hidden"), "B's ⋯ opens B's menu");
  await ev("document.body.click(), 1");
  // an edit in A is A's: its store keeps it, B's does not
  await ev("A.api.agent.edit((d) => { d.nodes[0].title = 'Renamed in A'; })");
  check(await until("A.kept.saves === 1 && A.kept.doc.nodes[0].title === 'Renamed in A' && B.kept.saves === 0", 3000), "an edit in A goes to A's store only: " + await ev("JSON.stringify([A.kept.saves, B.kept.saves])"));
  // editing in place, with the mouse, within A
  await ev("A.api.agent.editing(true), A.api.board.focus(['a1'], true), A.api.board.render(), 1");
  await sleep(200);
  const n1 = await ev("(() => { const r = A.api.board.clientRect('a1'); return { x: r.left + 30, y: r.top + 12 }; })()");
  await mouse("mousePressed", n1.x, n1.y); await mouse("mouseReleased", n1.x, n1.y);
  await mouse("mousePressed", n1.x, n1.y, { clickCount: 2 }); await mouse("mouseReleased", n1.x, n1.y, { clickCount: 2 });
  check(await until("A.api.board.editing === 'a1' && !!document.querySelector('#a .board-editing .be-title') && !!document.querySelector('.ip-bar')", 3000), "a double-click edits A's note where it is");
  await send("Input.insertText", { text: "!" });
  await mouse("mousePressed", 1290, 690); await mouse("mouseReleased", 1290, 690);
  check(await until("A.kept.doc.nodes[0].title.includes('!')", 3000), "leaving keeps it, in A's store");
  // destroy: B is gone, and the page's events are no longer its; A goes on
  await ev("B.api.destroy(), 1");
  check(await ev("document.getElementById('b').children.length === 0 && !document.getElementById('b').classList.contains('sbb')"), "destroy() takes B off its element");
  await ev("A.api.agent.edit((d) => { d.nodes[1].code = 'x = 2'; })");
  check(await until("A.kept.doc.nodes[1].code === 'x = 2' && B.kept.saves === 0", 3000), "A goes on after B is gone");
  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })), 1");
  check(!errors.length, "errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  server.close();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
