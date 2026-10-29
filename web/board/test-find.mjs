// Find in a board (web/board/find.ts, mount.ts), with the keyboard in
// headless Chromium: Ctrl/Cmd+F opens a small bar; what is typed is looked
// for in what the items say as written (titles, text, code, details), never
// in their outputs; Enter and Shift+Enter go to the next and the previous
// item that says it, in reading order, page by page, each shown in view,
// outlined, its words marked; Esc closes the bar.  A large board is
// searched quickly.  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-find.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";
import { CDPError, connectCDP, discoverPage } from "./find-test-cdp.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-find-"));
let chrome, cdp, phase = "browser startup";
const errors = [];
const stage = (name) => { phase = name; console.log(`test-find: ${name}`); };
const send = (method, params = {}) => cdp.send(method, params, phase);
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch((error) => { if (error instanceof CDPError) throw error; return false; })) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

const key = async (k, code, vk, modifiers = 0) => {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
const ctrlF = () => key("f", "KeyF", 70, 2);
const enter = (shift = false) => key("Enter", "Enter", 13, shift ? 8 : 0);
const escape = () => key("Escape", "Escape", 27);
// what the bar says, the item outlined, whether it is wholly in the window, and how many words are marked
const state = () => ev(`(() => {
  const f = document.querySelectorAll('.board-item.found'), el = f[0], r = el?.getBoundingClientRect();
  const id = el ? [...window.board.cache].find(([, e]) => e === el)?.[0] : null;
  return { open: !document.querySelector('[data-sbb=find]').hidden, says: document.querySelector('[data-sbb=findn]').textContent, found: f.length, id, page: window.sagebrush.board.snapshot().page,
    inView: !!r && r.top >= 40 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth, marked: CSS.highlights.get('sb-find')?.size ?? 0 };
})()`);
// (the board's camera still: a jump's flight done)
const settled = async () => { let last = ""; for (let i = 0; i < 40; i++) { const c = await ev("JSON.stringify(window.board.camera)"); if (c === last) return; last = c; await sleep(120); } };
// (the state an action is to reach, waited for, with a bound; then the camera
// still, and the state read again: a still camera alone can be read before a
// jump's flight starts, on a slow runner (#243's ci 40720240636, test-find.mjs:90)).
// On a timeout the last state is returned, and the caller's check says what it was.
const reach = async (want, ms = 10000) => {
  const t = Date.now();
  let s = await state();
  while (!want(s) && Date.now() - t < ms) { await sleep(50); s = await state(); }
  await settled();
  return state();
};

const DOC = {
  title: "Find",
  pages: [
    { title: "One", nodes: [
      { id: "a", title: "Alpha apple", x: 0, y: 0, w: 260 },
      { id: "b", title: "Beta", text: "a banana and an **Apple**", x: 400, y: 0, w: 260 },
      { id: "g", kind: "group", title: "Group", x: 0, y: 300, children: [{ id: "c", code: "apple_count = 1\nprint(apple_count)", x: 0, y: 0, w: 300 }] },
      { id: "d", title: "Out", code: "print('ap' + 'ple')", x: 450, y: 300, w: 300 },
      { id: "far", title: "Far away", text: "a pineapple, far off", x: 6000, y: 4000, w: 260 },
    ] },
    { title: "Two", nodes: [{ id: "e", title: "Epsilon", detail: "an apple a day", x: 0, y: 0, w: 260 }] },
  ],
};

try {
  stage("browser startup");
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { chrome.once("spawn", resolve); chrome.once("error", reject); });
  if (!port) port = await devtoolsPort(profile);
  const url = await discoverPage(`http://127.0.0.1:${port}/json`);
  cdp = await connectCDP(url, { onEvent: (message) => {
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails?.exception?.description ?? JSON.stringify(message.params.exceptionDetails));
  } });
  stage("board startup");
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `${base}board/` });
  if (!(await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000))) throw new Error("the page's board was not shown");
  stage("example board and code output");
  await ev(`window.sagebrush.board.load(${JSON.stringify(DOC)}).then(() => 1)`);
  await until(`window.sagebrush.board.snapshot().doc?.title === "Find" && !!window.board.item("a")`, 20000);
  // (the item whose output says apple, its code not: run, its output shown)
  check(await until("window.sagebrush.board.outputs().then((os) => os.find((o) => o.id === 'd')?.output === 'apple\\n')", 60000), "the code item's output is shown");
  await ev("window.board.focus(undefined, true), 1");

  stage("find navigation");
  await ctrlF();
  check(await until("!document.querySelector('[data-sbb=find]').hidden && document.activeElement === document.querySelector('[data-sbb=findq]')", 3000), "Ctrl+F opens the bar, ready to type in");
  await send("Input.insertText", { text: "apple" });
  let s = await reach((s) => s.says === "1 of 5" && s.id === "a" && s.found === 1 && s.inView && s.marked === 1);
  check(s.says === "1 of 5" && s.id === "a" && s.found === 1 && s.inView && s.marked === 1, "typed, the first item that says it, outlined and in view, its word marked: " + JSON.stringify(s));
  // in reading order: across, then down; a group's items; far off; the next page
  const order = [["b", 0, 1], ["c", 0, 2], ["far", 0, 1], ["e", 1, 1], ["a", 0, 1]];
  for (const [id, page, marked] of order) {
    await enter();
    s = await reach((s) => s.id === id && s.page === page && s.found === 1 && s.inView && s.marked === marked);
    check(s.id === id && s.page === page && s.found === 1 && s.inView && s.marked === marked, `Enter: ${id} next, on page ${page + 1}, in view, ${marked} marked: ` + JSON.stringify(s));
  }
  check(s.says === "1 of 5", "...and round again to the first: " + s.says);
  await enter(true);
  s = await reach((s) => s.id === "e" && s.page === 1 && s.says === "5 of 5");
  check(s.id === "e" && s.page === 1 && s.says === "5 of 5", "Shift+Enter: the one before (the last): " + JSON.stringify(s));
  // (outputs are never searched: the code item whose output says apple was never one; nor in a word not in any item)
  await send("Input.insertText", { text: "z" });
  s = await reach((s) => s.says === "No matches" && !s.found && !s.marked);
  check(s.says === "No matches" && !s.found && !s.marked, "nothing says it: No matches, nothing outlined: " + JSON.stringify(s));
  await ev("(() => { const q = document.querySelector('[data-sbb=findq]'); q.value = 'print('; q.dispatchEvent(new Event('input')); return 1; })()");
  s = await reach((s) => s.says === "1 of 2");
  check(s.says === "1 of 2", "code is searched as written: " + JSON.stringify(s));
  await escape();
  s = await reach((s) => !s.open && !s.found && !s.marked);
  check(!s.open && !s.found && !s.marked, "Esc closes the bar, nothing outlined or marked: " + JSON.stringify(s));
  await ctrlF();
  check(await until("!document.querySelector('[data-sbb=find]').hidden && document.querySelector('[data-sbb=findq]').selectionEnd - document.querySelector('[data-sbb=findq]').selectionStart === 6", 3000), "Ctrl+F again: the bar, what was typed selected");
  // (in Edit: under the Edit toolbar, not over it)
  await ev("window.sagebrush.board.editing(true), 1");
  check(await until("(() => { const t = document.querySelector('.board-toolbar:not([hidden])')?.getBoundingClientRect(), f = document.querySelector('[data-sbb=find]').getBoundingClientRect(); return !!t && t.height > 0 && f.top >= t.bottom; })()", 3000), "in Edit, the bar is under the Edit toolbar");
  await ev("window.sagebrush.board.editing(false), 1");
  await escape();

  stage("5,000 notes");
  // a large board: 5,000 notes, quickly
  const big = { title: "Big", nodes: Array.from({ length: 5000 }, (_, i) => ({ id: "n" + i, title: "Note " + i, text: `Some text of note ${i}${i === 4321 ? ", the needle" : ""}, and more words to search through`, x: (i % 100) * 300, y: Math.floor(i / 100) * 200, w: 260 })) };
  await ev(`window.sagebrush.board.load(${JSON.stringify(big)}).then(() => 1)`);
  await until("window.sagebrush.board.snapshot().doc?.title === 'Big'", 30000);
  await ctrlF();
  const time = (q) => ev(`(() => { const f = document.querySelector('[data-sbb=findq]'), t = performance.now(); f.value = ${JSON.stringify(q)}; f.dispatchEvent(new Event('input')); return { ms: performance.now() - t, says: document.querySelector('[data-sbb=findn]').textContent }; })()`);
  const first = await time("needl"), again = await time("needle");
  s = await reach((s) => s.id === "n4321" && s.inView && s.marked === 1);
  console.log(`5,000 notes: the first search ${first.ms.toFixed(1)} ms (the index made), the next ${again.ms.toFixed(1)} ms`);
  check(again.says === "1 of 1" && s.id === "n4321" && s.inView && s.marked === 1, "on a large board, the one note that says it: " + JSON.stringify(s));
  check(first.ms < 500 && again.ms < 50, `searched quickly: ${first.ms.toFixed(1)} ms, then ${again.ms.toFixed(1)} ms`);
  // ids repeat across pages (unique only on a page): Enter and Shift+Enter
  // step through every match by its page and id; a page changed by hand
  // leaves no other item outlined or marked (CORR-8CE-1)
  await escape();
  stage("repeated item IDs across pages");
  const REP = { title: "Repeated", pages: [
    { title: "P1", nodes: [{ id: "a", title: "kiwi one", x: 0, y: 0, w: 260 }, { id: "z", title: "plain", x: 400, y: 0, w: 260 }] },
    { title: "P2", nodes: [{ id: "a", title: "plum", x: 0, y: 0, w: 260 }, { id: "b", title: "kiwi two", x: 400, y: 0, w: 260 }] },
    { title: "P3", nodes: [{ id: "a", title: "kiwi three", x: 0, y: 0, w: 260 }] },
  ] };
  await ev(`window.sagebrush.board.load(${JSON.stringify(REP)}).then(() => 1)`);
  await sleep(300);
  await ctrlF();
  await ev("(() => { const q = document.querySelector('[data-sbb=findq]'); q.value = 'kiwi'; q.dispatchEvent(new Event('input')); return 1; })()");
  const want = [["1 of 3", 0, "a"], ["2 of 3", 1, "b"], ["3 of 3", 2, "a"], ["1 of 3", 0, "a"]], same = (st, w) => st.says === w[0] && st.page === w[1] && st.id === w[2];
  const seen = [];
  let st = await reach((st) => same(st, want[0]));
  seen.push([st.says, st.page, st.id]);
  for (let i = 1; i <= 3; i++) { await enter(); st = await reach((st) => same(st, want[i])); seen.push([st.says, st.page, st.id]); }
  check(JSON.stringify(seen) === JSON.stringify([["1 of 3", 0, "a"], ["2 of 3", 1, "b"], ["3 of 3", 2, "a"], ["1 of 3", 0, "a"]]), "Enter through matches whose ids repeat on other pages: " + JSON.stringify(seen));
  await enter(true);
  st = await reach((st) => st.says === "3 of 3" && st.page === 2 && st.id === "a");
  check(st.says === "3 of 3" && st.page === 2 && st.id === "a", "Shift+Enter back to the last: " + JSON.stringify(st));
  // (page 2 chosen by hand, whose "a" says plum)
  await ev("(() => { const p = document.querySelector('[data-sbb=pgsel]'); p.value = '1'; p.dispatchEvent(new Event('change')); return 1; })()");
  st = await reach((st) => st.page === 1 && st.found === 0 && st.marked === 0);
  check(st.page === 1 && st.found === 0 && st.marked === 0, "a page changed by hand: no item on it outlined or marked: " + JSON.stringify(st));
  await enter();
  st = await reach((st) => st.says === "1 of 3" && st.page === 0);
  check(st.says === "1 of 3" && st.page === 0, "...and Enter goes on from the match it left: " + JSON.stringify(st));
  await escape();

  stage("document replacement");
  // another document loaded while Find is open: the old matches gone (no
  // stale count, no word of the new one marked), the query asked of the new
  // one (CORR-F33-1)
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "First", nodes: [{ id: "a", title: "apple", x: 0, y: 0, w: 260 }] })}).then(() => 1)`);
  await sleep(300);
  await ctrlF();
  await ev("(() => { const q = document.querySelector('[data-sbb=findq]'); q.value = 'apple'; q.dispatchEvent(new Event('input')); return 1; })()");
  st = await reach((st) => st.says === "1 of 1" && st.marked === 1);
  check(st.says === "1 of 1" && st.marked === 1, "apple, found: " + JSON.stringify(st));
  const marks = () => ev("(() => { const h = CSS.highlights.get('sb-find'); return h ? [...h].map((r) => r.toString()) : []; })()");
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "Second", nodes: [{ id: "a", title: "banana", x: 0, y: 0, w: 260 }] })}).then(() => 1)`);
  st = await reach((st) => st.says === "No matches" && st.found === 0 && st.marked === 0);
  check(st.says === "No matches" && st.found === 0 && JSON.stringify(await marks()) === "[]", "another document loaded: no stale count, nothing of it marked: " + JSON.stringify([st, await marks()]));
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "Third", nodes: [{ id: "a", title: "crab apple", x: 0, y: 0, w: 260 }] })}).then(() => 1)`);
  st = await reach((st) => st.says === "1 of 1" && st.marked === 1);
  check(st.says === "1 of 1" && JSON.stringify(await marks()) === JSON.stringify(["apple"]), "...and one that says it: found in it: " + JSON.stringify([st, await marks()]));
  await escape();

  stage("shared highlights and board cleanup");
  // two boards on one page: each its own marked words in the page's one
  // highlight; one destroyed takes its own, and only its own (CORR-8CE-2)
  await ev(`window.sagebrush.board.load(${JSON.stringify(DOC)}).then(() => 1)`);
  await sleep(300);
  await ev(`import('/board/board.js').then((m) => { const div = document.createElement('div'); div.id = 'second'; div.style.cssText = 'position:fixed;left:0;bottom:0;width:640px;height:360px'; document.body.append(div); window.__b2 = m.mountBoard(div, { ...m.host, store: undefined, address: undefined }); return window.__b2.agent.load(${JSON.stringify({ title: "Second", nodes: [{ id: "p", title: "pear and apple", x: 0, y: 0, w: 260 }] })}); }).then(() => 1)`);
  await sleep(500);
  const findIn = (root, q) => ev(`(() => { const f = document.querySelector('${root} [data-sbb=findq]'); f.value = ${JSON.stringify(q)}; f.dispatchEvent(new Event('input')); return 1; })()`);
  await findIn("#board", "apple");
  await sleep(800);
  await findIn("#second", "pear");
  const owners = () => ev("(() => { const h = CSS.highlights.get('sb-find'); const rs = h ? [...h] : []; return { first: rs.filter((r) => document.getElementById('board').contains(r.startContainer)).length, second: rs.filter((r) => document.getElementById('second')?.contains(r.startContainer)).length, detached: rs.filter((r) => !document.contains(r.startContainer)).length }; })()");
  // (each board's marks waited for, with a bound, as reach does for one)
  const ownersUntil = async (want, ms = 10000) => { const t = Date.now(); let o = await owners(); while (!want(o) && Date.now() - t < ms) { await sleep(50); o = await owners(); } return o; };
  const both = await ownersUntil((o) => o.first > 0 && o.second > 0);
  check(both.first > 0 && both.second > 0 && both.detached === 0, "two boards: each one's marked words in the highlight: " + JSON.stringify(both));
  await ev("window.__b2.destroy().then(() => (document.getElementById('second').remove(), 1))");
  const after = await ownersUntil((o) => o.second === 0);
  check(after.first === both.first && after.second === 0 && after.detached === 0, "one destroyed: its own gone, the other's kept, nothing detached: " + JSON.stringify(after));
  check(!errors.length, "errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  cdp?.close();
  chrome?.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
