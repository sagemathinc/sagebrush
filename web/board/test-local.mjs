// Boards of this browser's own (web/board/page.ts, mount.ts), in headless
// Chromium: ?new=MODE makes a blank board in that language, opened in Edit,
// at ?doc=local:ID and listed; ?recent=MODE opens that language's latest (a
// new one if there is none); File > New board and Duplicate make boards of
// their own, the one shown staying as it is.  The top bar's two menus, File
// and ⋯, hold what the notebook's do, one open at a time.  An example board
// (not blank) opens as before, not in Edit.  Serve web/dist first
// (python3 web/serve.py 8765), then
//   node web/board/test-local.mjs
// (Since the workspace (step 1b), it runs on the fallback: ?workspace=0.)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-local-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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

// (this test is of the fallback, boards kept in localStorage, where the
// workspace can't be opened: ?workspace=0, on a loopback host only; the
// workspace's own boards are web/workspace/test-workspace-pages.mjs's)
const noWs = (q) => { const [path, hash = ""] = q.split("#"); return path + (path.includes("?") ? "&" : "?") + "workspace=0" + (hash ? "#" + hash : ""); };
const go = async (q) => {
  await send("Page.navigate", { url: `${base}board/${noWs(q)}` });
  return until("!!window.sagebrush?.board?.snapshot && window.sagebrush.board.snapshot().doc !== null", 60000);
};
const here = () => ev("(() => { const s = window.sagebrush.board.snapshot(); return { search: location.search.replace(/([?&])workspace=0(&|$)/, (m, a, b) => (b ? a : '')), editing: document.querySelector('[data-sbb=edit]').getAttribute('aria-pressed') === 'true', mode: s.doc.mode ?? 'python', title: s.doc.title, items: s.items.length, revert: !document.querySelector('[data-sbb=revert]').hidden }; })()");
const list = () => ev("JSON.parse(localStorage.getItem('sagebrush-boards') ?? '[]')");
const LOCAL = /^\?doc=local:[0-9a-f]{12}$/;

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  // a new Sage board: blank, in Edit, at its own address, listed
  await go("?new=sage");
  await until("document.querySelector('[data-sbb=edit]').getAttribute('aria-pressed') === 'true'", 10000);
  const a = await here();
  check(LOCAL.test(a.search) && a.editing && a.mode === "sage" && a.items === 0 && a.title === "Untitled board" && !a.revert, "?new=sage: a blank Sage board in Edit, at ?doc=local:ID, no Revert: " + JSON.stringify(a));
  const idA = a.search.slice(11);
  check((await list()).some((b) => b.id === idA && b.mode === "sage"), "...listed as a Sage board: " + JSON.stringify(await list()));
  // something in it, then ?recent=sage: the same board, as it was left
  await ev("window.sagebrush.board.edit((d) => { d.title = 'Sage sketch'; d.nodes = [{ id: 'n', title: 'kept' }]; }).then(() => 1)");
  await go("?recent=sage");
  const b = await here();
  check(b.search === a.search && b.title === "Sage sketch" && b.items === 1 && !b.editing, "?recent=sage: the latest Sage board, as left (not blank: not in Edit): " + JSON.stringify(b));
  // ?recent=magma, with no Magma board yet: a new one
  await go("?recent=magma");
  const c = await here();
  check(LOCAL.test(c.search) && c.search !== a.search && c.mode === "magma" && c.items === 0 && c.editing, "?recent=magma with none: a new blank Magma board, in Edit: " + JSON.stringify(c));
  // (a language it doesn't know: Python)
  await go("?new=cobol");
  check((await here()).mode === "python", "?new= of an unknown language: Python");
  // the two menus: File's and ⋯'s items, as the notebook splits them; one open at a time
  await go(a.search);
  const items = (m) => ev(`[...document.querySelectorAll('[data-sbb=${m}] > button')].map((b) => b.dataset.sbb)`);
  // (the one File menu, as the notebook's (design/workspace-files.md §3): New ▸, Open…, Recent ▸, Upload…; Save a copy…, Rename…, Download ▸, Print, Share…; Delete)
  const top = await ev(`[...document.querySelectorAll('[data-sbb=filemenu] > button')].map((b) => b.dataset.group ?? b.dataset.item)`);
  check(JSON.stringify(top) === JSON.stringify(["new", "open", "recent", "upload", "saveCopy", "rename", "download", "print", "share", "delete"]), "File: " + JSON.stringify(top));
  const grp = (g) => ev(`[...document.querySelector('[data-sbb=filemenu] [data-group=${g}]').nextElementSibling.querySelectorAll('button')].map((b) => b.dataset.sbb)`);
  check(JSON.stringify(await grp("new")) === JSON.stringify(["newnotebook", "newboard", "newfolder", "examples"]) && JSON.stringify(await grp("download")) === JSON.stringify(["download", "html", "canvas", "copyjson"]), "File's New ▸ and Download ▸: " + JSON.stringify([await grp("new"), await grp("download")]));
  check(JSON.stringify(await items("menu")) === JSON.stringify(["addpage", "pageprops", "rmpage", "tidy", "mermaid", "revert", "present", "timetravel", "term", "helpitem"]) && await ev("!!document.querySelector('[data-sbb=menu] [data-sbb=lang]')"), "⋯ (Import Mermaid… and Revert moved here): " + JSON.stringify(await items("menu")));
  await ev("document.querySelector('[data-sbb=menubtn]').click(), document.querySelector('[data-sbb=filebtn]').click(), 1");
  check(await ev("!document.querySelector('[data-sbb=filemenu]').hidden && document.querySelector('[data-sbb=menu]').hidden"), "one menu open at a time");
  await ev("document.body.click(), 1");
  check(await ev("document.querySelector('[data-sbb=filemenu]').hidden"), "a click elsewhere closes it");
  // File > Duplicate: a board of its own, a copy; the first stays as it is
  await ev("document.querySelector('[data-sbb=duplicate]').click(), 1");
  await until(`location.search !== ${JSON.stringify(a.search)} && !!window.sagebrush?.board?.snapshot()?.doc`, 30000);
  const d = await here();
  check(LOCAL.test(d.search) && d.title === "Sage sketch (copy)" && d.items === 1 && d.mode === "sage", "Duplicate: a copy of its own: " + JSON.stringify(d));
  const markOf = (search) => ev(`localStorage.getItem("sagebrush-board:local:" + ${JSON.stringify(search.match(/local:([0-9a-f]{12})/)[1])} + "#here")`);
  check((await markOf(d.search)) === "1", "...a copy of a board written here, marked as one");
  // File > New board: a new blank board in the same language, in Edit; the copy stays
  await ev("document.querySelector('[data-sbb=newboard]').click(), 1");
  await until(`location.search !== ${JSON.stringify(d.search)} && !!window.sagebrush?.board?.snapshot()?.doc`, 30000);
  await until("document.querySelector('[data-sbb=edit]').getAttribute('aria-pressed') === 'true'", 10000);
  const e = await here();
  check(LOCAL.test(e.search) && e.items === 0 && e.mode === "sage" && e.editing, "New board: a new blank Sage board, in Edit: " + JSON.stringify(e));
  await go(d.search);
  check((await here()).items === 1, "...and the copy is as it was");
  await go(a.search);
  check((await here()).title === "Sage sketch", "...and so is the first");
  // Duplicate of a board not written here: a copy not marked either (CORR-30D-1)
  await ev(`(localStorage.removeItem("sagebrush-board:local:" + ${JSON.stringify(a.search.match(/local:([0-9a-f]{12})/)[1])} + "#here"), 1)`);
  await ev("document.querySelector('[data-sbb=duplicate]').click(), 1");
  await until(`location.search !== ${JSON.stringify(a.search)} && !!window.sagebrush?.board?.snapshot()?.doc`, 30000);
  const d2 = await here();
  check(d2.search !== d.search && (await markOf(d2.search)) === null, "Duplicate of a board not marked as written here: not marked: " + JSON.stringify(d2));
  await ev(`(localStorage.setItem("sagebrush-board:local:" + ${JSON.stringify(a.search.match(/local:([0-9a-f]{12})/)[1])} + "#here", "1"), 1)`);
  await go(a.search);
  // a board of this browser's, written and read again: as written
  await go("?new=sage");
  await ev("window.sagebrush.board.edit((d) => { d.title = 'Kept'; d.nodes = [{ id: 'k', title: 'here' }]; }).then(() => 1)");
  const kept = (await here()).search;
  await send("Page.reload");
  await until("!!window.sagebrush?.board?.snapshot()?.doc", 60000);
  const k2 = await here();
  check(k2.search === kept && k2.title === "Kept" && k2.items === 1 && k2.mode === "sage", "written, reloaded: as written: " + JSON.stringify(k2));

  // ?new and ?recent together: new, its own language; either repeated: its first (CORR-7F9-3)
  await go("?new=magma&recent=sage");
  const both = await here();
  check(LOCAL.test(both.search) && both.mode === "magma" && both.items === 0, "?new=magma&recent=sage: a new Magma board: " + JSON.stringify(both));
  await go("?recent=sage&new=sage");
  check((await here()).items === 0 && (await here()).search !== kept, "?recent=sage&new=sage: a new board, not the latest");
  await go("?new=matlab&new=sage");
  check((await here()).mode === "matlab", "?new repeated: its first");
  await go("?recent=matlab&recent=sage");
  check((await here()).mode === "matlab", "?recent repeated: its first");

  // the list: records of boards gone or not boards dropped, and ?recent
  // goes on to the next, or makes a new one; titles cut, one record an id,
  // none from the future, at most 200 (HARD-7F9-2)
  const now = Date.now();
  await ev(`(() => {
    const l = [
      { id: "aaaaaaaaaaaa", title: "gone", mode: "sage", at: ${now} + 5000 },
      { id: "bbbbbbbbbbbb", title: "not a board", mode: "sage", at: ${now} + 4000 },
      { id: "dddddddddddd", title: "future", mode: "sage", at: 1e15 },
      { id: "${kept.slice(11)}", title: "x".repeat(10000), mode: "sage", at: ${now} - 1000 },
      { id: "${kept.slice(11)}", title: "dup", mode: "sage", at: ${now} - 9000 },
      ...Array.from({ length: 300 }, (_, i) => ({ id: (1e11 + i).toString(16).padStart(12, "0"), title: "m" + i, mode: "magma", at: ${now} - 100000 - i })),
    ];
    localStorage.setItem("sagebrush-boards", JSON.stringify(l));
    localStorage.setItem("sagebrush-board:local:bbbbbbbbbbbb", "{not json");
    return 1;
  })()`);
  await go("?recent=sage");
  const rec = await here();
  check(rec.search === kept && rec.title === "Kept", "?recent=sage: past a record of a board gone, one not a board, and one from the future, the latest that is there: " + JSON.stringify(rec));
  const l2 = await list();
  check(!l2.some((b) => b.id === "aaaaaaaaaaaa" || b.id === "bbbbbbbbbbbb" || b.id === "dddddddddddd"), "...those records dropped: " + JSON.stringify(l2.slice(0, 4).map((b) => b.id)));
  check(l2.length <= 200 && l2.filter((b) => b.id === kept.slice(11)).length === 1 && l2.every((b) => b.title.length <= 200), "...at most 200 records, one an id, titles cut: " + l2.length);
  // (only gone ones of this language: a new one)
  await ev(`localStorage.setItem("sagebrush-boards", JSON.stringify([{ id: "cccccccccccc", title: "gone", mode: "matlab", at: ${now} }])), 1`);
  await go("?recent=matlab");
  const fresh = await here();
  check(LOCAL.test(fresh.search) && fresh.search !== "?doc=local:cccccccccccc" && fresh.mode === "matlab" && fresh.items === 0, "?recent=matlab, its only record a board gone: a new MATLAB board: " + JSON.stringify(fresh));

  // storage full: no board made, nothing presented as kept (HARD-7F9-1)
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "if (sessionStorage.getItem('full')) { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (this === localStorage) throw new DOMException('full', 'QuotaExceededError'); return set.call(this, k, v); }; }" });
  await ev("sessionStorage.setItem('full', '1'), 1");
  const before = JSON.stringify(await list());
  await go("?new=sage");
  const full = await here();
  check(full.search === "?new=sage" && full.mode === "sage" && /isn't kept/.test(await ev("document.querySelector('[data-sbb=say]').textContent")), "?new=sage, storage full: the address as it was, a Sage board that says it isn't kept: " + JSON.stringify(full));
  check(JSON.stringify(await list()) === before, "...and nothing listed");
  await ev("window.sagebrush.board.edit((d) => { d.nodes = [{ id: 'w', title: 'written' }]; }).then(() => 1)");
  check(/Not kept/.test(await ev("document.querySelector('[data-sbb=say]').textContent")), "...an edit: it says it isn't kept");
  // (a board of this browser's, storage full meanwhile: New board and Duplicate go nowhere, and say why)
  await ev("sessionStorage.removeItem('full'), 1");
  await go(kept);
  await ev("(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (this === localStorage) throw new DOMException('full', 'QuotaExceededError'); return set.call(this, k, v); }; return 1; })()");
  await ev("document.querySelector('[data-sbb=newboard]').click(), 1");
  await sleep(800);
  check((await here()).search === kept && /No new board/.test(await ev("document.querySelector('[data-sbb=say]').textContent")), "New board, storage full: this board stays, saying why: " + await ev("document.querySelector('[data-sbb=say]').textContent"));
  await ev("document.querySelector('[data-sbb=duplicate]').click(), 1");
  await sleep(800);
  check((await here()).search === kept && /No copy/.test(await ev("document.querySelector('[data-sbb=say]').textContent")), "Duplicate, storage full: this board stays, saying why");
  // (this board's own save failed, and there is room again by New board or
  // Duplicate (or room for a small board, not this one): what was written
  // kept first, or this board stays, HARD-933-1)
  const keptKey = "sagebrush-board:local:" + kept.slice("?doc=local:".length);
  const failKept = `(() => { const set = window.__set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (this === localStorage && k === ${JSON.stringify(keptKey)}) throw new DOMException('full', 'QuotaExceededError'); return set.call(this, k, v); }; return 1; })()`;
  const stored = () => ev(`JSON.parse(localStorage.getItem(${JSON.stringify(keptKey)})).title`);
  const said = () => ev("document.querySelector('[data-sbb=say]').textContent");
  for (const [button, what] of [["newboard", "New board"], ["duplicate", "Duplicate"]]) {
    await go(kept);
    const was = await stored();
    await ev(failKept);
    await ev(`window.sagebrush.board.edit((d) => { d.title = 'Unsaved ${what}'; d.nodes.push({ id: 'u-${button}', title: 'unsaved' }); }).then(() => 1)`);
    check(await stored() === was && /Not kept/.test(await said()), `${what}: its save failed first: ${await stored()} | ${await said()}`);
    await ev("Storage.prototype.setItem = window.__set, 1");
    await ev(`document.querySelector('[data-sbb=${button}]').click(), 1`);
    await until(`location.search !== ${JSON.stringify(kept)} && !!window.sagebrush?.board?.snapshot()?.doc`, 30000);
    check(await stored() === `Unsaved ${what}`, `${what} after a failed save, room again: what was written is kept before it goes: ${await stored()}`);
  }
  await go(kept);
  await ev(failKept);
  await ev("window.sagebrush.board.edit((d) => { d.title = 'Still unsaved'; }).then(() => 1)");
  for (const [button, what] of [["newboard", "No new board"], ["duplicate", "No copy"]]) {
    await ev(`document.querySelector('[data-sbb=${button}]').click(), 1`);
    await sleep(800);
    const h = await here();
    check(h.search === kept && h.title === "Still unsaved" && new RegExp(`${what}.*stays open`).test(await said()), `${button}, this board's save failing still: it stays, saying why: ${JSON.stringify(h)} | ${await said()}`);
  }

  // an example board (not blank) opens as before: not in Edit, Revert there once edited
  await go("?doc=examples/primes.json");
  check(!(await here()).editing, "an example board opens out of Edit");
  check(!errors.length, "errors: " + errors.join(" | "));
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
