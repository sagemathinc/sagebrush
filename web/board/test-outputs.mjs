// Outputs on boards (design/outputs.md), in headless Chrome.  Step 1: a
// board's seed makes its random numbers the same at every load (and another
// seed, others); each code item's output key changes exactly when its code or
// anything upstream does; its time from root is its own time and its
// ancestors'; a new board gets a seed of its own.  Step 2: an item slow
// from root keeps a bounded preview in the file (and loses it when fast),
// written only when its output changes; opened again, the board shows the
// previews, marked, without running them, and runs the rest.  Serve web/dist first
// (python3 web/serve.py 8765), then
//   node web/board/test-outputs.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = +(process.env.CDP_PORT ?? 9457), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-outputs-prof-"));
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
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

const SEED_A = "a".repeat(64), SEED_B = "b".repeat(64);
// r draws a random number; p prints it (reads r); q is on its own
const board = (seed, rCode = "import random\nx = random.random()") => ({
  title: "Outputs", ...(seed ? { seed } : {}),
  nodes: [
    { id: "r", title: "draw", code: rCode },
    { id: "p", title: "show", code: "print(x)" },
    { id: "q", title: "alone", code: "y = 2\nprint(y)" },
  ],
});
const outputs = () => ev("window.sagebrush.board.outputs().then((os) => Object.fromEntries(os.map((o) => [o.id, o])))");
const ran = () => until("window.sagebrush.board.outputs().then((os) => os.length === 3 && os.every((o) => o.state === '') && /\\d/.test(os.find((o) => o.id === 'p').output) && /2/.test(os.find((o) => o.id === 'q').output))", 90000);
const open = async (doc) => {
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  await ev(`window.sagebrush.board.load(${JSON.stringify(doc)}).then(() => 1)`);
  check(await ran(), "the board's code items ran: " + JSON.stringify(await outputs().catch(() => null)).slice(0, 300));
  return (await outputs()).p.output.trim();
};
const keys = () => ev("window.sagebrush.board.outputKeys()");

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  // the same seed: the same numbers, at every load; another seed: others
  const a1 = await open(board(SEED_A));
  const k1 = await keys();
  const a2 = await open(board(SEED_A));
  const k2 = await keys();
  check(/^0\.\d+$/.test(a1) && a1 === a2, `the same seed drew different numbers: ${a1} ${a2}`);
  check(k1 && ["r", "p", "q"].every((id) => /^[0-9a-f]{64}$/.test(k1[id]?.key ?? "")), "every item has a key: " + JSON.stringify(k1));
  check(k1 && k2 && ["r", "p", "q"].every((id) => k1[id].key === k2[id].key), "the same board has the same keys at every load");
  const b1 = await open(board(SEED_B));
  const kb = await keys();
  check(b1 !== a1, `another seed drew the same number: ${b1}`);
  check(["r", "p", "q"].every((id) => kb[id].key !== k1[id].key), "the seed is in every key");
  // a board without a seed: the same numbers at every load too
  const n1 = await open(board(null)), n2 = await open(board(null));
  check(n1 === n2 && n1 !== a1, `a board without a seed: ${n1} ${n2}`);
  // an item named __proto__: its own entry, and the result's prototype untouched (SEC-781-1)
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "ids", nodes: [{ id: "__proto__", code: "a = 1" }, { id: "q", code: "b = a" }] })}).then(() => 1)`);
  await until("window.sagebrush.board.outputs().then((os) => os.length === 2 && os.every((o) => o.state === ''))", 30000);
  const special = await ev("window.sagebrush.board.outputKeys().then((k) => ({ own: Object.hasOwn(k, '__proto__'), keys: Object.keys(k).sort(), proto: Object.getPrototypeOf(k) === Object.prototype, inherited: k.key === undefined }))");
  check(special.own && special.keys.join() === "__proto__,q" && special.proto && special.inherited, "an item named __proto__ has its own entry, and the result is a plain object: " + JSON.stringify(special));
  // the file keeps the seed (canonical, after the engine's field)
  await open(board(SEED_A));
  const file = await ev("window.sagebrush.board.json()");
  check(file.includes(`  "seed": "${SEED_A}",\n`), "the file keeps the board's seed");
  // editing r changes the keys of r and p (which reads it), not q's
  await ev(`window.sagebrush.board.edit((d) => { d.nodes.find((x) => x.id === "r").code = "import random\\nx = random.random() + 1"; }).then(() => 1)`);
  check(await until("window.sagebrush.board.outputs().then((os) => /^1\\.\\d+/.test(os.find((o) => o.id === 'p').output.trim()))", 30000), "p reran after r changed");
  const k3 = await keys();
  check(k3.r.key !== k1.r.key && k3.p.key !== k1.p.key && k3.q.key === k1.q.key, "editing r changed r's and p's keys only: " + JSON.stringify([k1, k3]).slice(0, 400));
  // time from root: p's is its own time and r's; q's its own
  const close = (x, y) => Math.abs(x - y) < 1e-6;
  check(k3.p.untimed === 0 && close(k3.p.fromRoot, k3.p.ms + k3.r.ms), "p's time from root is p's and r's: " + JSON.stringify(k3.p) + JSON.stringify(k3.r));
  check(close(k3.q.fromRoot, k3.q.ms) && close(k3.r.fromRoot, k3.r.ms), "q's and r's time from root are their own");
  check(!k3.p.widget && !k3.r.widget, "no widget moved");
  // a new board gets a seed of its own (a board of its own, at its own address: once it is there)
  await ev("document.querySelector('[data-sbb=newboard]').click(), 1");
  await until("/^\\?doc=local:/.test(location.search) && !!window.sagebrush?.board?.snapshot()?.doc", 30000);
  check(await until("window.sagebrush.board.json().then((t) => /\"seed\": \"[0-9a-f]{64}\"/.test(t) && !t.includes('aaaa'))", 10000), "a new board has a seed of its own");
  // (back to the board the steps below load their documents into)
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);

  // Step 2: previews.  s takes 2.5 s; d and p and big read it; f is on its own.
  // (an item over 1 s from root keeps one here, rather than 10 s)
  const slow = (extra = "") => `import time\nt0 = time.time()\nwhile time.time() - t0 < 2.5:\n    pass\nx = 42${extra}\nprint("slow done", x)`;
  const pboard = (sCode) => ({
    title: "Previews", seed: SEED_A,
    nodes: [
      { id: "s", code: sCode },
      { id: "d", code: "y = x + 1\nprint('y is', y)" },
      { id: "big", code: "print('a' * 100000 + str(x))" },
      { id: "p", code: "import matplotlib.pyplot as plt\nplt.plot([1, 2, x])\nplt.show()" },
      { id: "f", code: "print('fast')" },
    ],
  });
  const doneAll = (ms = 120000) => until("window.sagebrush.board.outputs().then((os) => os.length === 5 && os.every((o) => o.state === ''))", ms);
  const nodesOf = async () => Object.fromEntries(JSON.parse(await ev("window.sagebrush.board.json()")).nodes.map((n) => [n.id, n]));
  await ev("window.sagebrush.board.setPreviewThreshold(1000), 1");
  await ev(`window.sagebrush.board.load(${JSON.stringify(pboard(slow()))}).then(() => 1)`);
  check(await doneAll(), "the board with a slow item ran: " + JSON.stringify(await outputs()).slice(0, 300));
  check(await until("window.sagebrush.board.json().then((t) => ['s', 'd', 'big', 'p'].every((id) => JSON.parse(t).nodes.find((n) => n.id === id).preview))", 20000), "the items slow from root have previews");
  let ns = await nodesOf();
  check(!ns.f.preview, "the fast item has none");
  check(ns.s.preview.total >= 2400 && ns.d.preview.total >= ns.s.preview.total && ns.f && /slow done 42/.test(ns.s.preview.outputs[0].text), "a preview: its time from root and its output: " + JSON.stringify(ns.s.preview).slice(0, 200));
  const bigText = ns.big.preview.outputs.map((o) => o.text ?? "").join("");
  check(bigText.length < 6000 && /… \d+ characters …/.test(bigText) && bigText.endsWith("42\n"), "a long output is cut to its head and tail: " + bigText.length);
  const pic = JSON.stringify(ns.p.preview.outputs);
  check(/image\/(webp|png)/.test(pic) && !/svg/.test(pic) && pic.length < 32 * 1024, "a plot's preview is a small raster picture: " + pic.slice(0, 120));
  // run again, the same output: the file doesn't change
  const file1 = await ev("window.sagebrush.board.json()");
  await ev("window.sagebrush.board.run(['s']).then(() => 1)");
  await sleep(1500);
  check((await ev("window.sagebrush.board.json()")) === file1, "rerun with the same output: the file is as it was");

  // opened again, in a fresh page: the previews show, marked, and the slow items don't run; the fast one does
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  // (without the cache of step 3, whose full outputs would show instead)
  await ev("new Promise((res) => { const r = indexedDB.deleteDatabase('sagebrush-outputs'); r.onsuccess = r.onerror = r.onblocked = () => res(1); })");
  const t0 = Date.now();
  await ev(`window.sagebrush.board.load(${JSON.stringify(JSON.parse(file1))}).then(() => 1)`);
  check(await until("window.sagebrush.board.outputs().then((os) => os.find((o) => o.id === 'f')?.state === '' && /fast/.test(os.find((o) => o.id === 'f').output))", 60000), "the fast item ran");
  const o2 = await outputs();
  check(["s", "d", "big", "p"].every((id) => o2[id].state === "stale") && /slow done 42/.test(o2.s.output) && /y is 43/.test(o2.d.output), "the slow items show their previews, stale: " + JSON.stringify(Object.values(o2).map((o) => [o.id, o.state])));
  // (not run: their times are their previews', and the fast one's its own)
  const kp = await keys(), saved = JSON.parse(file1).nodes;
  check(kp.s.ms === saved.find((n) => n.id === "s").preview.ms && kp.d.ms === saved.find((n) => n.id === "d").preview.ms, "...and did not run: " + JSON.stringify([kp.s, kp.d]));
  await ev("window.board.focus(['s'], true), window.board.render(), 1");
  check(await until("(() => { const el = document.querySelector('[data-code=s] .board-code-out > [data-preview]'); return !!el && getComputedStyle(el, '::before').content.includes('Preview, computed') && getComputedStyle(el, '::before').content.includes('Run to update.'); })()", 5000), "a preview says so");
  check(Date.now() - t0 < 30000, "shown without waiting for them");
  await ev("window.board.focus(['p'], true), window.board.render(), 1");
  check(await until("(() => { const img = document.querySelector('[data-code=p] .board-code-out img'); return !!img && /^data:image\\/(webp|png);base64,/.test(img.src) && img.naturalWidth > 0 && img.naturalWidth <= 640; })()", 5000), "the plot's preview shows as a picture, at most 640 wide (CORR-14C-3)");
  // run it: the preview's label goes, and what reads it runs too
  await ev("window.sagebrush.board.run(['s']).then(() => 1)");
  check(await doneAll(), "run, the slow item and what reads it are up to date");
  check(await ev("!document.querySelector('[data-code=s] .board-code-out > [data-preview]')"), "...and no longer say they are previews");
  // made fast: its preview, and its readers', go
  await ev(`window.sagebrush.board.edit((d) => { d.nodes.find((x) => x.id === "s").code = "x = 42\\nprint('slow done', x)"; }).then(() => 1)`);
  check(await until("window.sagebrush.board.json().then((t) => JSON.parse(t).nodes.every((n) => !n.preview))", 30000), "fast now: no previews: " + JSON.stringify(Object.values(await nodesOf()).map((n) => [n.id, !!n.preview])));

  // A preview is of one run: one whose picture is still being drawn when the
  // item runs again is dropped, whether the later run keeps a preview or
  // none (SEC-14C-1).  Pictures are held (decode() waits) to make it so.
  await ev("window.__held = []; (() => { const decode = HTMLImageElement.prototype.decode; HTMLImageElement.prototype.decode = function () { const p = decode.call(this); return window.__holding ? new Promise((res, rej) => window.__held.push(() => p.then(res, rej))) : p; }; })(), 1");
  const loop = "import time\nt0 = time.time()\nwhile time.time() - t0 < 1.3:\n    pass\n";
  const plot = (label) => loop + `import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nplt.show()\nprint("${label}")`;
  const setG = (code) => ev(`window.sagebrush.board.edit((d) => { d.nodes.find((x) => x.id === "g").code = ${JSON.stringify(code)}; }).then(() => 1)`);
  const gPreview = () => ev("window.sagebrush.board.json().then((t) => JSON.stringify(JSON.parse(t).nodes.find((n) => n.id === 'g').preview ?? null))");
  await ev("window.__holding = false, 1");
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "race", seed: SEED_A, nodes: [{ id: "g", code: "print('start')" }] })}).then(() => 1)`);
  await until("window.sagebrush.board.outputs().then((os) => os[0]?.state === '')", 30000);
  await ev("window.sagebrush.board.setPreviewThreshold(1000), window.__holding = true, 1");
  await setG(plot("OLD"));
  check(await until("window.__held.length > 0", 30000), "the first run's picture is held");
  await setG(loop + "print('NEW')");
  check(await until("window.sagebrush.board.json().then((t) => /NEW/.test(JSON.stringify(JSON.parse(t).nodes.find((n) => n.id === 'g').preview ?? '')))", 30000), "the later run's preview is kept");
  await ev("window.__holding = false, window.__held.splice(0).forEach((f) => f()), 1");
  await sleep(1500);
  const after = await gPreview();
  check(/NEW/.test(after) && !/OLD/.test(after), "...and the earlier one, finished after it, doesn't replace it: " + after.slice(0, 160));
  // the later run fast (no preview): the earlier one doesn't bring one back
  await ev("window.__holding = true, 1");
  await setG(plot("OLD2"));
  check(await until("window.__held.length > 0", 30000), "another picture held");
  await setG("print('FAST')");
  check(await until("window.sagebrush.board.json().then((t) => !JSON.parse(t).nodes.find((n) => n.id === 'g').preview)", 30000), "fast now: no preview");
  await ev("window.__holding = false, window.__held.splice(0).forEach((f) => f()), 1");
  await sleep(1500);
  check((await gPreview()) === "null", "...and the earlier run's, finished after, doesn't come back: " + (await gPreview()).slice(0, 160));

  // Step 3: the cache beside the board (outcache.ts).  An item over 2 s from
  // root keeps its full outputs in this browser; opened again, it shows them
  // as computed, without running, and what reads it too; changed, it runs.
  const SEED_C = "c".repeat(64);
  const cboard = (sCode) => ({ title: "Cached", seed: SEED_C, nodes: [
    { id: "s", code: sCode }, { id: "d", code: "print('d sees', stamp)" }, { id: "f", code: "print('fast')" },
  ] });
  // (os.urandom: not the seed's, so each run's stamp is its own)
  const slowStamp = "import time, os\nt0 = time.time()\nwhile time.time() - t0 < 2.3:\n    pass\nstamp = os.urandom(8).hex()\nprint('s ran:', stamp)";
  // (counted without creating the database, which would stop the app from making its stores)
  const cacheCount = () => ev("indexedDB.databases().then((ds) => !ds.some((d) => d.name === 'sagebrush-outputs') ? 0 : new Promise((res) => { const r = indexedDB.open('sagebrush-outputs'); r.onsuccess = () => { const db = r.result; const c = db.transaction('entries').objectStore('entries').count(); c.onsuccess = () => { db.close(); res(c.result); }; }; }))");
  // (a clean start: no board kept in this browser from the steps above, previews at their usual 10 s)
  await ev("localStorage.clear(), 1");
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  const n0 = await cacheCount();
  await ev(`window.sagebrush.board.load(${JSON.stringify(cboard(slowStamp))}).then(() => 1)`);
  check(await until("window.sagebrush.board.outputs().then((os) => os.length === 3 && os.every((o) => o.state === ''))", 60000), "the board ran");
  const first = await outputs();
  let kept = false;
  for (let i = 0; i < 100 && !kept; i++) { kept = (await cacheCount()) >= n0 + 2; if (!kept) await sleep(100); }
  check(kept, "s and d (over 2 s from root) are kept in the cache; f isn't: " + (await cacheCount()) + " from " + n0);
  // (kept in this browser as an edited board is: an edit saves it, with its cache's name beside it)
  await ev(`window.sagebrush.board.edit((d) => { d.title = "Cached, kept"; }).then(() => 1)`);
  const idKey = "sagebrush-board:examples/live.json#outputs";
  const id1 = await ev(`localStorage.getItem(${JSON.stringify(idKey)})`);
  check(/^[0-9a-f]{32}$/.test(id1 ?? "") && !(id1 ?? "").includes("c".repeat(8)), "the cache's name is the store's, not the board's seed: " + id1);
  const countFor = (id) => ev(`new Promise((res) => { const r = indexedDB.open('sagebrush-outputs'); r.onsuccess = () => { const db = r.result; const c = db.transaction('entries').objectStore('entries').index('doc').count(${JSON.stringify(id)}); c.onsuccess = () => { db.close(); res(c.result); }; }; })`);
  check((await countFor(id1)) === 2, "...and the entries are under it");
  // opened again, in a fresh page of this browser: the board kept, and its cache
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().doc.title === 'Cached, kept'", 60000);
  check(await until("window.sagebrush.board.outputs().then((os) => os.find((o) => o.id === 'f')?.state === '')", 60000), "the fast item ran");
  const again = await outputs();
  check(again.s.output === first.s.output && again.d.output === first.d.output && /^s ran: [0-9a-f]{16}/.test(first.s.output), "s and d show their cached outputs (the same run's stamp): " + JSON.stringify([first.s.output, again.s.output]));
  await ev("window.board.focus(['s'], true), window.board.render(), 1");
  check(await until("(() => { const el = document.querySelector('[data-code=s] .board-code-out > [data-cached]'); return !!el && getComputedStyle(el, '::before').content.includes('kept in this browser') && getComputedStyle(el.parentElement).opacity === '1'; })()", 5000), "a cached output says so, and isn't greyed");
  // changed, it runs (another key), and its reader with it
  await ev(`window.sagebrush.board.edit((d) => { d.nodes.find((x) => x.id === "s").code = ${JSON.stringify(slowStamp + "\n1")}; }).then(() => 1)`);
  check(await until(`window.sagebrush.board.outputs().then((os) => os.every((o) => o.state === '') && os.find((o) => o.id === 's').output !== ${JSON.stringify(first.s.output)})`, 60000), "changed, s runs again, and d with it");
  check(await ev("!document.querySelector('[data-cached]')"), "...and no longer says it is cached");
  for (let i = 0; i < 100 && (await countFor(id1)) < 3; i++) await sleep(100);
  check((await countFor(id1)) > 0, "the changed board's outputs are kept too");
  // New board: a board of its own, at its own address, with its own name;
  // the board it leaves stays, and so do its outputs (as the notebook's New notebook)
  await ev("document.querySelector('[data-sbb=newboard]').click(), 1");
  check(await until("/^\\?doc=local:/.test(location.search) && !!window.sagebrush?.board?.snapshot()?.doc", 30000), "New board: a board of its own");
  const id2 = await ev("localStorage.getItem('sagebrush-board:' + decodeURIComponent(location.search.slice(5)) + '#outputs')");
  check(!!id2 && id2 !== id1 && (await countFor(id1)) > 0, "...with its own name, the board it left keeping its outputs: " + JSON.stringify([id1, id2, await countFor(id1)]));
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  check((await ev(`localStorage.getItem(${JSON.stringify(idKey)})`)) === id1, "back on that board: the same name");
  // (and done: what it ran, and wrote, written before another document takes its place)
  await until("window.sagebrush.board.outputs().then((os) => os.length === 3 && os.every((o) => o.state === '' || o.state === 'stale'))", 60000);
  await sleep(1500);
  // another document loaded in its place (an empty one, as New board makes
  // in a host without boards of their own): a new name, and the old board's entries gone (SEC-B88-3)
  await ev(`window.sagebrush.board.load({ title: "Untitled board", nodes: [] }).then(() => 1)`);
  await sleep(500);
  const id2b = await ev(`localStorage.getItem(${JSON.stringify(idKey)})`);
  check(id2b !== id1 && (await countFor(id1)) === 0, "another document loaded in its place: a new name, and the old board's entries gone (SEC-B88-3): " + JSON.stringify([id1, id2b, await countFor(id1)]));
  // another document with the same seed, ids and code (anyone can copy a
  // board's), opened in a clean page where its items are new: its own
  // cache, so nothing of another's (SEC-B88-1).  First, a board whose
  // outputs are kept; then its copy.
  await ev(`window.sagebrush.board.load(${JSON.stringify(cboard(slowStamp))}).then(() => 1)`);
  check(await until("window.sagebrush.board.outputs().then((os) => os.length === 3 && os.every((o) => o.state === ''))", 60000), "a board runs");
  const orig = await outputs();
  const id3 = await ev(`localStorage.getItem(${JSON.stringify(idKey)})`);
  for (let i = 0; i < 100 && (await countFor(id3)) < 2; i++) await sleep(100);
  check((await countFor(id3)) === 2, "...and its outputs are kept: " + await countFor(id3));
  await ev("localStorage.clear(), 1");
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  await until("window.sagebrush.board.outputs().then((os) => os.length > 0 && os.every((o) => o.state === ''))", 60000);
  await ev(`window.sagebrush.board.load(${JSON.stringify(cboard(slowStamp))}).then(() => 1)`);
  check(await until("window.sagebrush.board.outputs().then((os) => os.length === 3 && os.every((o) => o.state === ''))", 60000), "a copy of it runs");
  const copy = await outputs();
  check(copy.s.output !== orig.s.output && !(await ev("!!document.querySelector('[data-cached]')")), "...its own outputs, none from the other's cache: " + JSON.stringify([orig.s.output, copy.s.output]));
  // what reads a file, or reads what read one, is not kept (its key doesn't say the file's bytes: SEC-B88-2)
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "files", seed: SEED_C, nodes: [
    { id: "a", code: "import os, time\nopen('cache-test.bin', 'wb').write(os.urandom(8))\nt0 = time.time()\nwhile time.time() - t0 < 2.2:\n    pass\nsecret = open('cache-test.bin', 'rb').read().hex()" },
    { id: "b", code: "print('B', secret)" },
  ] })}).then(() => 1)`);
  check(await until("window.sagebrush.board.outputs().then((os) => os.length === 2 && os.every((o) => o.state === '') && /^B [0-9a-f]{16}/.test(os[1].output))", 60000), "a board whose item reads a file ran");
  const fk = await keys(), idFiles = await ev(`localStorage.getItem(${JSON.stringify(idKey)})`);
  await sleep(1500);
  check(fk.a.reads > 0 && fk.b.reads > 0 && (await countFor(idFiles)) === 0, "neither the item reading the file nor the one reading it is kept: " + JSON.stringify([fk.a.reads, fk.b.reads]));

  // A board replaced while its outputs are being kept: nothing of it is kept
  // after its cache is dropped (SEC-975-4).  (The first write's completion is
  // held; meanwhile another board is loaded, which drops this one's cache;
  // then it is released: no second write may follow.)
  await ev(`(() => { window.__holdPut = 0; window.__released = []; const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (value, key) { const r = put.call(this, value, key); if (window.__holdPut === 1 && this.name === "entries" && value && Array.isArray(value.outputs)) { window.__holdPut = 2; const t = this.transaction; let h = null; Object.defineProperty(t, "oncomplete", { configurable: true, set(f) { h = f; }, get() { return h; } }); t.addEventListener("complete", (e) => window.__released.push(() => h && h.call(t, e))); } return r; }; })(), 1`);
  const twoSlow = { title: "two slow", seed: SEED_C, nodes: [
    { id: "t1", code: "import time\nt0 = time.time()\nwhile time.time() - t0 < 2.1:\n    pass\nprint('t1')" },
    { id: "t2", code: "import time\nt0 = time.time()\nwhile time.time() - t0 < 2.1:\n    pass\nprint('t2')" },
  ] };
  await ev(`window.sagebrush.board.load(${JSON.stringify(twoSlow)}).then(() => 1)`);
  const idHeld = await ev(`localStorage.getItem(${JSON.stringify(idKey)})`);
  await ev("window.__holdPut = 1, 1");
  check(await until("window.sagebrush.board.outputs().then((os) => os.length === 2 && os.every((o) => o.state === ''))", 60000), "two slow items ran");
  check(await until("window.__holdPut === 2 && window.__released.length === 1", 10000), "the first write is held");
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "next", nodes: [{ id: "x", code: "print('x')" }] })}).then(() => 1)`);
  await ev("window.__released.splice(0).forEach((f) => f()), 1");
  await sleep(1500);
  check((await countFor(idHeld)) === 0, "the replaced board's cache stays dropped: " + (await countFor(idHeld)));
  // An older run's entries, held, don't overwrite a newer run's: t1's write
  // is held, t2 runs again meanwhile, then it is released (CORR-4DF-2)
  const twoStamps = { title: "two stamps", seed: SEED_C, nodes: [
    { id: "t1", code: "import time\nt0 = time.time()\nwhile time.time() - t0 < 2.1:\n    pass\nprint('t1')" },
    { id: "t2", code: "import time, os\nt0 = time.time()\nwhile time.time() - t0 < 2.1:\n    pass\nprint('t2', os.urandom(8).hex())" },
  ] };
  await ev("window.__holdPut = 0, window.__released = [], 1");
  await ev(`window.sagebrush.board.load(${JSON.stringify(twoStamps)}).then(() => 1)`);
  const idTwo = await ev(`localStorage.getItem(${JSON.stringify(idKey)})`);
  await ev("window.__holdPut = 1, 1");
  check(await until("window.sagebrush.board.outputs().then((os) => os.length === 2 && os.every((o) => o.state === ''))", 60000), "two items ran");
  check(await until("window.__holdPut === 2 && window.__released.length === 1", 10000), "t1's write is held");
  await ev("window.sagebrush.board.run(['t2']).then(() => 1)");
  const newer = (await outputs()).t2.output, t2key = (await keys()).t2.key;
  await sleep(500);
  await ev("window.__released.splice(0).forEach((f) => f()), 1");
  for (let i = 0; i < 50 && (await countFor(idTwo)) < 2; i++) await sleep(100);
  await sleep(800);
  const keptOut = await ev(`new Promise((res) => { const r = indexedDB.open('sagebrush-outputs'); r.onsuccess = () => { const db = r.result; const g = db.transaction('entries').objectStore('entries').get([${JSON.stringify(idTwo)}, ${JSON.stringify(t2key)}]); g.onsuccess = () => { db.close(); res(JSON.stringify(g.result?.outputs ?? null)); }; }; })`);
  check(keptOut.includes(newer.trim()), "t2's cached output is the newer run's: " + JSON.stringify([newer, keptOut.slice(0, 120)]));

  // A sweep after the writes marks the items' keys as they are then, not as
  // before: with the board over its cap, a newer run's entry, written while
  // the older run's were held, stays (CORR-A48-3).  (Five large entries,
  // used more recently than anything, put it over 64 MB.)
  await ev("window.__holdPut = 0, window.__released = [], 1");
  // (code of their own: the last board's items, with the same ids, would not run again)
  const swept = { title: "swept", seed: SEED_C, nodes: [
    { id: "t1", code: "import time\nt0 = time.time()\nwhile time.time() - t0 < 2.1:\n    pass\nprint('t1 swept')" },
    { id: "t2", code: "import time, os\nt0 = time.time()\nwhile time.time() - t0 < 2.1:\n    pass\nprint('t2 swept', os.urandom(8).hex())" },
  ] };
  await ev(`window.sagebrush.board.load(${JSON.stringify(swept)}).then(() => 1)`);
  const idSwept = await ev(`localStorage.getItem(${JSON.stringify(idKey)})`);
  await ev(`new Promise((res) => { const r = indexedDB.open('sagebrush-outputs'); r.onsuccess = () => { const db = r.result, t = db.transaction(['entries', 'docs'], 'readwrite'); for (let i = 0; i < 5; i++) t.objectStore('entries').put({ doc: ${JSON.stringify(idSwept)}, key: 'big-' + i, outputs: [], at: '2026-10-14T00:00:00.000Z', ms: 1, total: 1, bytes: 16000000, used: Date.now() + 1e9 }); t.objectStore('docs').put({ doc: ${JSON.stringify(idSwept)}, bytes: 80000000, used: Date.now() }); t.oncomplete = () => { db.close(); res(1); }; }; })`);
  await ev("window.__holdPut = 1, 1");
  check(await until("window.sagebrush.board.outputs().then((os) => os.length === 2 && os.every((o) => o.state === ''))", 60000), "the board ran");
  check(await until("window.__holdPut === 2 && window.__released.length === 1", 10000), "the older run's first write is held: " + JSON.stringify([await ev("window.__holdPut"), await countFor(idSwept), await keys()]).slice(0, 400));
  await ev(`window.sagebrush.board.edit((d) => { d.nodes.find((x) => x.id === "t2").code += "\\n2"; }).then(() => 1)`);
  check(await until("window.sagebrush.board.outputs().then((os) => os.every((o) => o.state === '') && /\\n2$/.test(os.find((o) => o.id === 't2').code))", 60000), "t2, changed, ran again");
  const newKey = (await keys()).t2.key;
  await ev("window.__released.splice(0).forEach((f) => f()), 1");
  await sleep(2500);
  const hasNew = await ev(`new Promise((res) => { const r = indexedDB.open('sagebrush-outputs'); r.onsuccess = () => { const db = r.result; const g = db.transaction('entries').objectStore('entries').get([${JSON.stringify(idSwept)}, ${JSON.stringify(newKey)}]); g.onsuccess = () => { db.close(); res(!!g.result); }; }; })`);
  check(hasNew, "the newer run's entry survives the older run's sweep");

  // The sweep's mark is of one moment: if an item runs while the older run's
  // keys are being found (their hash held here), that sweep doesn't happen,
  // and the newer entry stays, the board over its cap (CORR-68B-2)
  await ev(`(() => { window.__holdDigest = 0; const digest = crypto.subtle.digest.bind(crypto.subtle); crypto.subtle.digest = (...a) => { const p = digest(...a); if (window.__holdDigest !== 1) return p; window.__holdDigest = 2; return new Promise((res, rej) => { window.__digestHeld = () => p.then(res, rej); }); }; const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (value, key) { const r = put.call(this, value, key); if (window.__digestAfterPut && this.name === "entries" && value && Array.isArray(value.outputs)) { window.__digestAfterPut = false; this.transaction.addEventListener("complete", () => { window.__holdDigest = 1; }); } return r; }; })(), 1`);
  await ev("window.__holdPut = 0, window.__released = [], 1");
  const marked = { title: "marked", seed: SEED_C, nodes: [{ id: "m", code: "import time, os\nt0 = time.time()\nwhile time.time() - t0 < 2.1:\n    pass\nprint('m', os.urandom(8).hex())" }] };
  await ev(`window.sagebrush.board.load(${JSON.stringify(marked)}).then(() => 1)`);
  const idMarked = await ev(`localStorage.getItem(${JSON.stringify(idKey)})`);
  await ev(`new Promise((res) => { const r = indexedDB.open('sagebrush-outputs'); r.onsuccess = () => { const db = r.result, t = db.transaction(['entries', 'docs'], 'readwrite'); for (let i = 0; i < 5; i++) t.objectStore('entries').put({ doc: ${JSON.stringify(idMarked)}, key: 'big-' + i, outputs: [], at: '2026-10-14T00:00:00.000Z', ms: 1, total: 1, bytes: 16000000, used: Date.now() + 1e9 }); t.objectStore('docs').put({ doc: ${JSON.stringify(idMarked)}, bytes: 80000000, used: Date.now() }); t.oncomplete = () => { db.close(); res(1); }; }; })`);
  // (the old run's entry written, then the hash of its keys for the sweep held)
  await ev("window.__digestAfterPut = true, 1");
  check(await until("window.__holdDigest === 2", 60000), "the older run's keys, for its sweep, held");
  // (meanwhile the item changes and runs; its write's completion held, so the older sweep comes first)
  await ev("window.__holdPut = 1, 1");
  await ev(`window.sagebrush.board.edit((d) => { d.nodes[0].code += "\\n3"; }).then(() => 1)`);
  check(await until("window.sagebrush.board.outputs().then((os) => os[0].state === '' && /\\n3$/.test(os[0].code))", 60000) && await until("window.__holdPut === 2 && window.__released.length === 1", 10000), "the item, changed, ran; its write held");
  const markedKey = (await keys()).m.key;
  await ev("window.__digestHeld(), 1");
  await sleep(500);
  await ev("window.__released.splice(0).forEach((f) => f()), 1");
  await sleep(2500);
  const stays = await ev(`new Promise((res) => { const r = indexedDB.open('sagebrush-outputs'); r.onsuccess = () => { const db = r.result; const g = db.transaction('entries').objectStore('entries').get([${JSON.stringify(idMarked)}, ${JSON.stringify(markedKey)}]); g.onsuccess = () => { db.close(); res(!!g.result); }; }; })`);
  check(stays, "the newer run's entry stays");
  check(!errors.length, "no exceptions: " + errors.join(" | ").slice(0, 400));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
if (fails.length) {
  console.log(`${fails.length} of ${checks} checks failed:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed`);
