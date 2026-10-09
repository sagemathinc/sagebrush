// TimeTravel (web/notebook/history.js) on the full page, in headless Chromium:
// edits are recorded as patchflow patches on CoCalc-style records in
// IndexedDB; the panel shows past versions read-only, reverts (as a new
// version), survives a reload and clears; and the page says when the same
// notebook is open in another tab.  Serve web/dist first:
//   bun web/build.ts && (cd web/dist && python3 ../serve.py 8765) &
//   node web/test-timetravel.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const profile = mkdtempSync(join(tmpdir(), "sb-timetravel-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9340", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 100; i++) { try { targets = await (await fetch("http://127.0.0.1:9340/json")).json(); break; } catch { await sleep(100); } }
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
async function tab(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
  return { ws, send, ev, until };
}
const mainCells = "[...document.querySelectorAll('#cells .cell textarea')].map(t => t.value).join('|')";
const info = "document.querySelector('#ttinfo').textContent";
const versions = `(+(/of (\\d+)/.exec(${info}) ?? [0, 0])[1])`;

try {
  const a = await tab(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await a.send("Page.navigate", { url: base });
  await a.until("window.sagebrush && document.querySelector('#status').textContent.startsWith('ready')");
  await a.ev("document.querySelector('[data-f=new]').click()");
  await a.until("document.querySelector('#nbname').value === 'Untitled'");
  const edit = async (js) => { await a.ev(`(() => { const nb = sagebrush.notebook; ${js} })()`); await sleep(800); };
  await sleep(500);
  await edit("nb.setInput(nb.cells()[0], 'a = 1')");
  await edit("nb.setInput(nb.cells()[0], 'a = 2')");
  await edit("nb.addCell('print(a)')");
  await edit("nb.setType(nb.addCell(''), 'markdown'); nb.setInput(nb.cells()[2], '# Notes'); nb.renderMd(nb.cells()[2])");
  ok((await a.ev(mainCells)) === "a = 2|print(a)|# Notes", "edits: " + (await a.ev(mainCells)));

  // the panel: the latest version, then an older one
  await a.ev("document.querySelector('#ttbtn').click()");
  await a.until(`!document.querySelector('#timetravel').hidden && document.querySelector('#cells').hidden && ${versions} >= 5`);
  const n = await a.ev(versions);
  ok((await a.ev(info)).startsWith(`Version ${n} of ${n}`), "TimeTravel opens at the latest version: " + (await a.ev(info)));
  ok((await a.ev("[...document.querySelectorAll('#ttview .cell')].length")) === 3 && (await a.ev("!!document.querySelector('#ttview .cell.markdown.rendered h1')")), "...the version shown read-only, Markdown rendered");
  const older = await a.ev(`(() => { const s = document.querySelector('#ttslider'); for (let i = 0; i <= +s.max; i++) { s.value = i; s.dispatchEvent(new Event('input')); if ([...document.querySelectorAll('#ttview .cell textarea')].map(t => t.value).join('|') === 'a = 1') return i; } return -1; })()`);
  ok(older >= 0 && (await a.ev(info)).startsWith(`Version ${older + 1} of ${n}`), `the slider shows an older version (${older + 1}): a = 1`);
  ok(await a.ev("document.querySelector('#ttview .cell textarea').readOnly && !document.querySelector('#ttview .addend')?.offsetParent"), "...read-only");

  // revert: the notebook becomes that version, as a new version
  await a.ev("document.querySelector('#ttrevert').click()");
  await a.until("document.querySelector('#timetravel').hidden && !document.querySelector('#cells').hidden");
  ok((await a.ev(mainCells)) === "a = 1", "revert restores the cells: " + (await a.ev(mainCells)));
  await sleep(900);
  await a.ev("document.querySelector('#ttbtn').click()");
  await a.until(`${versions} === ${n + 1}`, 5000);
  ok(true, `...as a new version (${n + 1})`);
  await a.ev("document.querySelector('#ttclose').click()");

  // the stored patches: CoCalc's Jupyter records
  const rec = await a.ev(`new Promise((res) => { const r = indexedDB.open("sagebrush", 2); r.onsuccess = () => { const q = r.result.transaction("history").objectStore("history").getAll(); q.onsuccess = () => res({ n: q.result.length, first: JSON.stringify(q.result[0].env.patch), size: JSON.stringify(q.result.map((x) => x.env)).length }); }; })`);
  ok(/"type":"settings","kernel":"python3"/.test(rec.first) && /"type":"cell"/.test(rec.first) && /"cell_type":"code"/.test(rec.first) && /"pos":0/.test(rec.first), `kept in IndexedDB as CoCalc Jupyter records (${rec.n} patches, ${rec.size} bytes): ${rec.first.slice(0, 120)}`);

  // a reload keeps the history
  await a.send("Page.reload");
  await a.until("window.sagebrush && document.querySelectorAll('#cells .cell').length > 0");
  await sleep(1500);
  await a.ev("document.querySelector('#ttbtn').click()");
  await a.until(`${versions} === ${n + 1}`, 8000);
  ok(true, "the history survives a reload");

  // clear: one version left, the notebook unchanged
  await a.ev("window.confirm = () => true; document.querySelector('#ttclear').click()");
  await a.until(`${versions} === 1`, 5000);
  await a.ev("document.querySelector('#ttclose').click()");
  ok((await a.ev(mainCells)) === "a = 1", "Clear history forgets the versions, not the notebook");

  // the same notebook in another tab: the page says so
  const t2 = await (await fetch("http://127.0.0.1:9340/json/new?" + encodeURIComponent(base), { method: "PUT" })).json();
  const b = await tab(t2.webSocketDebuggerUrl);
  await b.until("window.sagebrush && document.querySelector('#nbname').value === 'Untitled'");
  await a.until("document.querySelector('#tabs').textContent.includes('another tab')", 5000);
  ok((await b.ev("document.querySelector('#tabs').textContent")).includes("each tab runs its own Python"), "both tabs say the notebook is open in another tab: " + (await a.ev("document.querySelector('#tabs').textContent")));
  // an edit in tab B is recorded in tab A's history too
  await b.ev("(() => { const nb = sagebrush.notebook; nb.setInput(nb.cells()[0], 'a = 3'); })()");
  await a.until(`(${mainCells}) === 'a = 3'`, 5000);
  await sleep(500);
  await a.ev("document.querySelector('#ttbtn').click()");
  await a.until(`${versions} === 2`, 5000);
  ok(true, "an edit in the other tab is a version here too");
  b.ws.close();
  a.ws.close();
} catch (e) {
  console.log("ERROR", e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
}
