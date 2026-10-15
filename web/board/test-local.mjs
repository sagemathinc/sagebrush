// Boards of this browser's own (web/board/page.ts, mount.ts), in headless
// Chromium: ?new=MODE makes a blank board in that language, opened in Edit,
// at ?doc=local:ID and listed; ?recent=MODE opens that language's latest (a
// new one if there is none); File > New board and Duplicate make boards of
// their own, the one shown staying as it is.  The top bar's two menus, File
// and ⋯, hold what the notebook's do, one open at a time.  An example board
// (not blank) opens as before, not in Edit.  Serve web/dist first
// (python3 web/serve.py 8765), then
//   node web/board/test-local.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = Number(process.env.CDP_PORT ?? 9467), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-local-"));
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

const go = async (q) => {
  await send("Page.navigate", { url: `${base}board/${q}` });
  return until("!!window.sagebrush?.board?.snapshot && window.sagebrush.board.snapshot().doc !== null", 60000);
};
const here = () => ev("(() => { const s = window.sagebrush.board.snapshot(); return { search: location.search, editing: document.querySelector('[data-sbb=edit]').getAttribute('aria-pressed') === 'true', mode: s.doc.mode ?? 'python', title: s.doc.title, items: s.items.length, revert: !document.querySelector('[data-sbb=revert]').hidden }; })()");
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
  check(JSON.stringify(await items("filemenu")) === JSON.stringify(["newboard", "open", "mermaid", "examples", "duplicate", "html", "download", "canvas", "copyjson", "print", "revert"]), "File: " + JSON.stringify(await items("filemenu")));
  check(JSON.stringify(await items("menu")) === JSON.stringify(["addpage", "pageprops", "rmpage", "tidy", "present", "timetravel"]) && await ev("!!document.querySelector('[data-sbb=menu] [data-sbb=lang]')"), "⋯: " + JSON.stringify(await items("menu")));
  await ev("document.querySelector('[data-sbb=menubtn]').click(), document.querySelector('[data-sbb=filebtn]').click(), 1");
  check(await ev("!document.querySelector('[data-sbb=filemenu]').hidden && document.querySelector('[data-sbb=menu]').hidden"), "one menu open at a time");
  await ev("document.body.click(), 1");
  check(await ev("document.querySelector('[data-sbb=filemenu]').hidden"), "a click elsewhere closes it");
  // File > Duplicate: a board of its own, a copy; the first stays as it is
  await ev("document.querySelector('[data-sbb=duplicate]').click(), 1");
  await until(`location.search !== ${JSON.stringify(a.search)} && !!window.sagebrush?.board?.snapshot()?.doc`, 30000);
  const d = await here();
  check(LOCAL.test(d.search) && d.title === "Sage sketch (copy)" && d.items === 1 && d.mode === "sage", "Duplicate: a copy of its own: " + JSON.stringify(d));
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
  // an example board (not blank) opens as before: not in Edit, Revert there once edited
  await go("?doc=examples/primes.json");
  check(!(await here()).editing, "an example board opens out of Edit");
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
