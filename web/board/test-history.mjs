// Board TimeTravel (web/board/history.ts) in headless Chromium: every change
// kept is a version (a drag when it ends), recorded as patchflow patches in
// this browser's IndexedDB, in a database of the board's own; moving an item
// is a tiny patch; any version comes back as it was; the ⋯ menu's TimeTravel
// shows a bar (a slider, Revert, ✕) to look at a version, read only, its code
// not run, and to revert to it (undoable); each document its own history
// (New board, Revert, another loaded: one afresh).  Serve web/dist first (python3
// web/serve.py 8765), then
//   node web/board/test-history.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = Number(process.env.CDP_PORT ?? 9460), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-history-"));
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
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });

const B = "window.sagebrush.board";
const count = () => ev(`${B}.versions().then((v) => v.length)`);
const docOf = () => ev(`JSON.parse(JSON.stringify(${B}.snapshot().doc))`);
// (the same board: key order aside, and the toolbar's tools, a setting not recorded)
const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).filter((key) => key !== "tools").sort().map((key) => [key, v[key]])) : v));
// the patches kept for this board, in its own database
const rows = (id) => ev(`new Promise((res) => { const r = indexedDB.open("sagebrush-board-history"); r.onsuccess = () => { const q = r.result.transaction("history").objectStore("history").getAll(IDBKeyRange.bound([${JSON.stringify(id)}, ""], [${JSON.stringify(id)}, "\\uffff"])); q.onsuccess = () => res(q.result.map((x) => JSON.stringify(x.env))); }; r.onerror = () => res(null); })`);
const noteOn = (pageIx, id) => (d) => d.pages[pageIx].nodes.find((x) => x.id === id) ?? d.pages[pageIx].nodes.flatMap((g) => g.children ?? []).find((x) => x.id === id);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/primes.json")}` });
  await until(`${B}?.snapshot().items.length > 0`, 60000);
  const d0 = await docOf();
  check(d0.pages?.length === 3, "primes.json has pages");
  check((await count()) === 0, "no versions before any change");
  // an edit: the board as it was, and as it is, are versions
  const id = d0.pages[0].nodes.find((x) => x.title)?.id;
  const t0 = noteOn(0, id)(d0).title;
  await ev(`${B}.edit((d) => { d.pages[0].nodes.find((x) => x.id === ${JSON.stringify(id)}).title = "Renamed"; })`);
  check(await until(`${B}.versions().then((v) => v.length === 2)`, 5000), "an edit: two versions, before and after: " + await count());
  // a drag: no version while it moves, one when it ends
  await ev(`${B}.editing(true), window.board.focus([${JSON.stringify(id)}], true), 1`);
  await sleep(300);
  const r = await ev(`window.board.clientRect(${JSON.stringify(id)})`);
  const x = r.left + r.width / 2, y = r.top + Math.min(20, r.height / 2);
  await mouse("mousePressed", x, y);
  for (let i = 1; i <= 6; i++) { await mouse("mouseMoved", x + 15 * i, y + 8 * i); await sleep(20); }
  await sleep(300);
  check((await count()) === 2, "no version while dragging");
  await mouse("mouseReleased", x + 90, y + 48);
  check(await until(`${B}.versions().then((v) => v.length === 3)`, 5000), "the drag, when it ends, is a version: " + await count());
  const moved = noteOn(0, id)(await docOf());
  // moving an item: a tiny patch (its x and y), nothing of the other items
  // (the board's history: by the board's name in this browser, kept beside it)
  const kept = await rows("board:examples/primes.json:" + (await ev("localStorage.getItem('sagebrush-board:examples/primes.json#outputs')")));
  const last = kept?.[kept.length - 1] ?? "";
  check(kept?.length === 3 && last.length < 700, `moving an item is a tiny patch: ${last.length} bytes`);
  check(last.includes(String(moved.x)) && !last.includes("Euclid") && !last.includes("Renamed"), "...holding its new place, not the other items' text: " + last.slice(0, 300));
  // any version comes back as it was
  const v0 = await ev(`${B}.version(0)`), v2 = await ev(`${B}.version(2)`);
  check(canon(v0) === canon(d0), "version 1 is the board as it was");
  check(canon(v2) === canon(await docOf()), "the newest version is the board as it is");
  check(v0.format === "sagebrush-board" && v0.version === 1, "a version is a board document, with its format and version");
  // the ⋯ menu's TimeTravel: a bar with a slider, at the newest version
  await ev(`${B}.editing(false)`);
  await ev("document.querySelector('[data-sbb=timetravel]').click(), 1");
  check(await until("!document.querySelector('[data-sbb=tt]').hidden", 3000), "TimeTravel… shows its bar");
  check(await ev("(() => { const s = document.querySelector('[data-sbb=ttslider]'); return s.max === '2' && s.value === '2' && document.querySelector('[data-sbb=ttrevert]').disabled && /Version 3 of 3/.test(document.querySelector('[data-sbb=ttwhen]').textContent); })()"), "the slider is at the newest of 3 versions: " + await ev("document.querySelector('[data-sbb=ttwhen]').textContent"));
  // looking at the first: shown, read only (the document is still the board as it is)
  await ev("(() => { const s = document.querySelector('[data-sbb=ttslider]'); s.value = '0'; s.dispatchEvent(new Event('input')); return 1; })()");
  check(await until(`[...document.querySelectorAll('.board-note b')].some((b) => b.textContent === ${JSON.stringify(t0)})`, 5000), "the slider at version 1 shows it");
  check(noteOn(0, id)(await docOf()).title === "Renamed" && (await count()) === 3, "looking at a version changes nothing");
  check(await ev("!document.querySelector('[data-sbb=ttrevert]').disabled && !document.querySelector('[data-sbb=edit]').getAttribute('aria-pressed').includes('true')"), "Revert is offered; Edit is off");
  // PageDown: the version's next page
  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })), 1");
  check(await until(`${B}.snapshot().page === 1`, 3000) && !(await ev("document.querySelector('[data-sbb=tt]').hidden")), "PageDown shows the version's next page");
  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true })), 1");
  // Revert: the board is that version again, as an edit (a version, undoable)
  await ev("document.querySelector('[data-sbb=ttrevert]').click(), 1");
  check(await until("document.querySelector('[data-sbb=tt]').hidden", 3000), "Revert closes the bar");
  check(await until(`(() => { const d = ${B}.snapshot().doc; return d.pages[0].nodes.find((x) => x.id === ${JSON.stringify(id)}).title === ${JSON.stringify(t0)}; })()`, 3000), "Revert: the board is version 1 again");
  check(canon(await docOf()) === canon(d0), "...all of it");
  check(await until(`${B}.versions().then((v) => v.length === 4)`, 3000), "...and that is a version");
  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })), 1");
  check(await until(`${B}.snapshot().doc.pages[0].nodes.find((x) => x.id === ${JSON.stringify(id)}).title === "Renamed"`, 3000), "undo takes the revert back");
  // ✕ and Esc close the bar: the board as it is
  await ev("document.querySelector('[data-sbb=timetravel]').click(), 1");
  await until("!document.querySelector('[data-sbb=tt]').hidden", 3000);
  await ev("(() => { const s = document.querySelector('[data-sbb=ttslider]'); s.value = '0'; s.dispatchEvent(new Event('input')); return 1; })()");
  await sleep(300);
  await ev("document.querySelector('[data-sbb=ttclose]').click(), 1");
  check(await until(`document.querySelector('[data-sbb=tt]').hidden && window.board.item(${JSON.stringify(id)})?.title === "Renamed"`, 3000), "✕ closes it: the board as it is: " + await ev(`window.board.item(${JSON.stringify(id)})?.title`));
  await ev("document.querySelector('[data-sbb=timetravel]').click(), 1");
  await until("!document.querySelector('[data-sbb=tt]').hidden", 3000);
  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 1");
  check(await until("document.querySelector('[data-sbb=tt]').hidden", 2000), "Esc closes it");
  // kept across a reload, in a database of the board's own (the notebook's is untouched)
  const nv = await count();
  await send("Page.reload");
  await until(`${B}?.snapshot().items.length > 0`, 60000);
  check((await count()) === nv, `the versions are kept across a reload: ${await count()} of ${nv}`);
  const dbs = await ev("indexedDB.databases().then((ds) => ds.map((d) => d.name))");
  check(dbs.includes("sagebrush-board-history"), "the board's history has its own database: " + dbs);
  const nb = await ev(`new Promise((res) => { const r = indexedDB.open("sagebrush-history"); r.onupgradeneeded = () => {}; r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains("history")) return res(0); const q = db.transaction("history").objectStore("history").count(); q.onsuccess = () => res(q.result); }; r.onerror = () => res(-1); })`);
  check(nb === 0, "no board patch is in the notebook's history: " + nb);

  // a history per document (William): New board, Revert and another document loaded each start one afresh, the one before gone; kept across a reload
  const groups = () => ev(`new Promise((res) => { const r = indexedDB.open("sagebrush-board-history"); r.onsuccess = () => { const q = r.result.transaction("history").objectStore("history").getAll(); q.onsuccess = () => { const by = {}; for (const row of q.result) by[row.nb] = (by[row.nb] ?? 0) + 1; r.result.close(); res(by); }; }; })`);
  check(Object.keys(await groups()).length === 1, "(one board's history so far: " + JSON.stringify(await groups()) + ")");
  await ev("document.querySelector('[data-sbb=newboard]').click(), 1");
  await until(`${B}.snapshot().doc.title === "Untitled board"`, 5000);
  await sleep(500);
  const afterNew = await count();
  check(afterNew <= 1 && (await ev("document.querySelector('[data-sbb=tt]').hidden")), "New board: TimeTravel has only the new board's versions: " + afterNew + " of " + nv + " before");
  await ev(`${B}.edit((d) => { d.nodes.push({ id: "fresh", title: "Fresh" }); }).then(() => 1)`);
  check(await until(`${B}.versions().then((v) => v.length === 2)`, 5000), "...an edit of it: its second version: " + await count());
  await sleep(300);
  const g1 = await groups();
  check(Object.keys(g1).length === 1, "...and the old board's history is gone: " + JSON.stringify(g1));
  await send("Page.reload");
  await until(`${B}?.snapshot().doc?.title === "Untitled board"`, 60000);
  check((await count()) === 2, "reloaded: the new board's history is still its own: " + await count());
  // Revert (the original again): a history afresh
  await ev("document.querySelector('[data-sbb=revert]').click(), 1");
  await until(`${B}.snapshot().doc.title !== "Untitled board"`, 5000);
  await sleep(500);
  check((await count()) <= 1 && Object.keys(await groups()).length <= 1, "Revert: a history afresh: " + await count() + " " + JSON.stringify(await groups()));
  // another document loaded (the agent's load): its own
  await ev(`${B}.load({ title: "Another", nodes: [{ id: "x", title: "X" }] }).then(() => 1)`);
  await sleep(300);
  check((await count()) === 0, "another document loaded: no versions yet: " + await count());

  // a board with code: a version is shown with its code, not run
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until(`${B}?.snapshot().items.length > 0`, 60000);
  check(await until(`${B}.outputs().then((os) => os.length === 5 && os.every((o) => o.state === ''))`, 90000), "the code board ran");
  const before = await ev(`${B}.outputs().then((os) => JSON.stringify(os))`);
  await ev(`${B}.edit((d) => { d.nodes.find((x) => x.id === 'start').code = 'start = 97'; })`);
  await until(`${B}.outputs().then((os) => /^118 steps/.test(os.find((x) => x.id === 'path').output))`, 30000);
  const after = await ev(`${B}.outputs().then((os) => JSON.stringify(os))`);
  await ev("document.querySelector('[data-sbb=timetravel]').click(), 1");
  await until("!document.querySelector('[data-sbb=tt]').hidden", 3000);
  await ev("(() => { const s = document.querySelector('[data-sbb=ttslider]'); s.value = '0'; s.dispatchEvent(new Event('input')); return 1; })()");
  check(await ev("document.querySelector('[data-sbb=tour]').hidden"), "the tour's caption is not shown over the bar");
  check(await until("[...document.querySelectorAll('.board-code-src')].some((p) => p.textContent === 'start = 27')", 5000), "a version's code is shown: " + await ev("[...document.querySelectorAll('.board-code-src')].map((p) => p.textContent).join(' | ')"));
  check(await ev("!document.querySelector('.board-code-run') && !document.querySelector('.board-code-out')"), "...not run: no ▶, no outputs");
  await sleep(500);
  check((await ev(`${B}.outputs().then((os) => JSON.stringify(os))`)) === after, "nothing ran while looking at it");
  await ev("document.querySelector('[data-sbb=ttclose]').click(), 1");
  check(await until("!!document.querySelector('[data-code=path] .board-code-out') && !!document.querySelector('.board-code-run')", 5000), "closed, the board's outputs are back");
  check(before !== after, "(the edit had run)");
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
