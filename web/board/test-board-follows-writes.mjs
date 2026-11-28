// ci: web-browser/board-c order=160
// An open board follows its writes made elsewhere (web/board/page.ts, followWrites), in headless Chromium: another tab
// of this browser writes the board through the workspace, as an agent paired with the notebook page does, and the
// board shows the new version at once, without a reload.  Whether its new and changed code runs is decided by where it
// runs (web/board/capability.ts, William's ruling of Nov 28): in the runner (a sandbox with nothing of the person's)
// it runs at once, whoever wrote it; unconfined (?runner=0 here: a plain worker with the page's storage) it waits
// until the person runs it ("Run this board's code"), then runs once, what didn't change keeping its outputs, and that
// decision outlives a reload (Codex S14 F1): a change written while the board is open, or while no page has it open,
// still waits after a reload; code the person ran runs at the next open; an edit of the person's doesn't approve
// another writer's code held meanwhile.  The board's own edits are never taken for a write made elsewhere (no "changed
// elsewhere" copy).  An edit made here while a version from elsewhere is still being drawn (its pictures read) wins:
// that version stands down, and the edit's save meets the write as a conflict, so both are kept (the board shows the
// other version, the person's is a board of its own, said), whether it waited on its pictures or on KaTeX, loaded the
// first time a board has math.  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-board-follows-writes.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-follows-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
// (a browser that goes away is a failure that says so, with Chrome's last stderr lines, never a silent exit)
let chromeTail = "", dead = "";
chrome.stderr.on("data", (d) => { chromeTail = (chromeTail + d).slice(-2048); });
const tabs = [];
const die = (why) => { if (dead) return; dead = why; for (const t of tabs) t.dieAll(why); };
chrome.on("exit", (code, signal) => die(`Chrome exited (code ${code}, signal ${signal})`));
const port = await devtoolsPort(profile, 60_000, { child: chrome });
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

/** A tab: its DevTools socket, with bounded calls that fail at once when the browser is gone. */
async function tab(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onclose = () => fail(new Error(`the DevTools socket closed before it opened; Chrome's stderr: ${chromeTail}`)); });
  let n = 0;
  const waiting = new Map(), errors = [];
  const t = {
    errors,
    held: [],
    dieAll(why) { for (const [, w] of waiting) { clearTimeout(w.timer); w.at.message = why; w.fail(w.at); } waiting.clear(); },
    send(method, params = {}, ms = 120000) {
      return new Promise((ok, fail) => {
        const at = new Error(dead);
        if (dead) return fail(at);
        const id = ++n;
        const timer = setTimeout(() => { waiting.delete(id); at.message = `${method}: no answer in ${ms / 1000} s`; fail(at); }, ms);
        waiting.set(id, { ok, fail, timer, at });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async ev(expression) { const r = await t.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; },
    async until(expr, ms = 30000) { const s = Date.now(); while (Date.now() - s < ms) { if (await t.ev(expr).catch((e) => { if (dead) throw e; return false; })) return true; await sleep(100); } return false; },
  };
  ws.onclose = () => die("the DevTools socket closed");
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); clearTimeout(w.timer); w.ok(m.result ?? m.error); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
    if (m.method === "Inspector.targetCrashed") die("a page crashed");
    if (m.method === "Fetch.requestPaused") t.held.push(m.params);
  };
  tabs.push(t);
  for (const m of ["Page.enable", "Runtime.enable", "Inspector.enable"]) await t.send(m);
  return t;
}
const pageTarget = async (url) => {
  for (let i = 0; i < 100; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json().catch(() => []);
    const p = list.find((x) => x.type === "page" && (url ? x.url.startsWith(url) : true));
    if (p) return p;
    await sleep(100);
  }
  throw new Error("no page target" + (url ? " at " + url : ""));
};

try {
  // the board, made in tab A (a board of the workspace, shown in Edit as one made here)
  const A = await tab((await pageTarget()).webSocketDebuggerUrl);
  await A.send("Page.navigate", { url: `${base}board/?new=python` });
  check(await A.until("/doc=local:/.test(location.search) && !!window.sagebrush?.board?.snapshot?.()?.doc", 60000), "the board page makes a board of the workspace");
  const id = await A.ev("new URLSearchParams(location.search).get('doc').slice('local:'.length)");
  // (unconfined from here on: a plain worker, where code runs only once approved)
  const unconfined = `${base}board/?doc=local:${id}&runner=0`;
  await A.send("Page.navigate", { url: unconfined });
  check(await A.until("!!window.sagebrush?.board?.snapshot?.()?.doc", 60000), "the board, opened unconfined (a plain worker: ?runner=0)");
  const W = "window.sagebrush.workspace";
  check(await A.until(`${W}.list("/").then((l) => l.some((e) => e.kind === "board" && e.ref === ${JSON.stringify(id)}))`, 20000), "…listed in the workspace");
  const path = await A.ev(`${W}.list("/").then((l) => l.find((e) => e.kind === "board" && e.ref === ${JSON.stringify(id)}).path)`);
  let origin0 = await A.ev("performance.timeOrigin");
  const items = "window.sagebrush.board.snapshot().items.length";
  const outOf = (nid) => `window.sagebrush.board.outputs().then((os) => String(os.find((o) => o.id === ${JSON.stringify(nid)})?.output ?? ''))`;

  // tab B, another page of this browser (the notebook page, where an agent pairs), writes the board
  const created = await A.send("Target.createTarget", { url: "about:blank" });
  const B = await tab((await (async () => { for (let i = 0; i < 100; i++) { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((x) => x.id === created.targetId); if (p) return p; await sleep(100); } throw new Error("tab B not found"); })()).webSocketDebuggerUrl);
  await B.send("Page.navigate", { url: base });
  check(await B.until(`!!${W}`, 60000), "tab B, the notebook page, has the workspace");
  const write = (doc) => B.ev(`${W}.read(${JSON.stringify(path)}).then((r) => ${W}.write(${JSON.stringify(path)}, ${JSON.stringify(doc)}, { base: r.rev })).then((r) => r.rev)`);
  const runBtn = `document.querySelector("[data-sbb=runpaused]")`;
  const runIt = () => A.ev(`(${runBtn}.click(), 1)`);
  const KEEP = { id: "keep", title: "Unchanged", code: "import time\nprint('at', time.time())" };
  // (first, a board with one code item, as the person runs it)
  const rev1 = await write({ title: "Followed", nodes: [KEEP], edges: [] });
  check(typeof rev1 === "number" && await A.until(`${items} === 1`, 15000), "tab B writes the board (its base): shown at once");
  check(await A.until(`!${runBtn}.hidden`, 5000), "…its code not run: \"Run this board's code\" is offered", await A.ev(`${runBtn}.title`).catch(() => null));
  await runIt();
  check(await A.until(`${outOf("keep")}.then((o) => /^at \\d/.test(o))`, 60000), "the person's Run runs it", await A.ev(outOf("keep")).catch(() => null));
  const kept = await A.ev(outOf("keep"));
  // (a note and a new code item, written elsewhere)
  const rev2 = await write({ title: "Followed", nodes: [KEEP, { id: "intro", title: "About", text: "Its square: $x^2$." }, { id: "sq", title: "A square", code: "x = 6\nprint(x * 7)" }], edges: [] });
  check(rev2 === rev1 + 1, "tab B writes it again: a note and a new code item", rev2);
  check(await A.until(`${items} === 3`, 15000), "the open board shows the write at once", await A.ev(`${items}`).catch(() => null));
  await sleep(3000);
  check(!/42/.test(await A.ev(outOf("sq"))) && !(await A.ev(`${runBtn}.hidden`)), "…its new code not run, whoever wrote it: Run is offered", { sq: await A.ev(outOf("sq")), title: await A.ev(`${runBtn}.title`) });
  check(/can't be protected here/.test(await A.ev(`${runBtn}.title`)), "…Run's title says why", await A.ev(`${runBtn}.title`));
  check((await A.ev(outOf("keep"))) === kept, "…the unchanged item keeps its output");
  check(await A.ev("performance.timeOrigin") === origin0, "…without a reload");
  // (F1: held across a reload, no page subscribed meanwhile)
  await A.send("Page.navigate", { url: unconfined });
  check(await A.until(`!!window.sagebrush?.board?.snapshot?.()?.doc && ${items} === 3`, 60000), "reloaded: the board as written elsewhere");
  await sleep(3000);
  check(!/42/.test(await A.ev(outOf("sq"))) && !(await A.ev(`${runBtn}.hidden`)), "…its new code still not run after the reload: Run is offered", { sq: await A.ev(outOf("sq")) });
  await runIt();
  check(await A.until(`${outOf("sq")}.then((o) => /42/.test(o))`, 60000) && await A.ev(`${runBtn}.hidden`), "the person's Run runs the new code", await A.ev(outOf("sq")).catch(() => null));
  await sleep(1500);
  check(/^at \d/.test(await A.ev(outOf("keep"))), "…the unchanged item has its output");
  // (a change to its code and a new item: shown, not run, until the person runs them, once)
  const rev3 = await write({ title: "Followed", nodes: [KEEP, { id: "intro", title: "About", text: "Its square: $x^2$." }, { id: "sq", title: "A square", code: "x = 6\nprint(x * 8)" }, { id: "more", title: "More", code: "print(x + 100)" }], edges: [] });
  check(rev3 === rev2 + 1, "tab B writes it again: changed code and a new item", rev3);
  check(await A.until(`${items} === 4`, 15000), "the changed board is shown at once");
  await sleep(3000);
  check(/42/.test(await A.ev(outOf("sq"))) && !/106/.test(await A.ev(outOf("more"))) && !(await A.ev(`${runBtn}.hidden`)), "…its changed and new code not run until the person runs it", { sq: await A.ev(outOf("sq")), more: await A.ev(outOf("more")) });
  await runIt();
  check(await A.until(`${outOf("sq")}.then((o) => /48/.test(o))`, 60000) && await A.until(`${outOf("more")}.then((o) => /106/.test(o))`, 60000), "the person's Run runs the changed code and the new item", { sq: await A.ev(outOf("sq")), more: await A.ev(outOf("more")) });
  // (F1: code the person ran runs at the next open)
  await A.send("Page.navigate", { url: unconfined });
  check(await A.until(`!!window.sagebrush?.board?.snapshot?.()?.doc && ${items} === 4`, 60000) && await A.until(`${outOf("more")}.then((o) => /106/.test(o))`, 60000) && await A.ev(`${runBtn}.hidden`), "reloaded: the code the person ran runs by itself, no Run offered", { more: await A.ev(outOf("more")).catch(() => null) });
  // (an edit of the person's to approved code: runs at once, approved as it is made)
  await A.ev("window.sagebrush.board.editing(true), 1");
  await A.ev(`window.sagebrush.board.personEditForTests((d) => { d.nodes.find((n) => n.id === "more").code = "print(x + 200)"; }).then(() => 1)`);
  check(await A.until(`${outOf("more")}.then((o) => /206/.test(o))`, 60000) && await A.ev(`${runBtn}.hidden`), "the person's own edit of approved code runs at once", await A.ev(outOf("more")).catch(() => null));
  // (Codex F1 on #2477: a write from elsewhere and then the person's edit, close together, the edit's digest finished
  // first: it carries only its exact predecessor's decision, the write's, never the approval of the board before)
  await A.ev(`(() => { const orig = crypto.subtle.digest.bind(crypto.subtle); window.__codeWaits = []; crypto.subtle.digest = async (alg, data) => { if (window.__holdCode && new TextDecoder().decode(data).startsWith('["sagebrush-board-code"')) await new Promise((r) => window.__codeWaits.push(r)); return orig(alg, data); }; window.__holdCode = true; return 1; })()`);
  const revRace = await write({ title: "Followed", nodes: [KEEP, { id: "intro", title: "About", text: "Its square: $x^2$." }, { id: "sq", title: "A square", code: "x = 6\nprint(x * 8)" }, { id: "more", title: "More", code: "print(x + 200)" }, { id: "race", title: "Race", code: "print('RACE RAN')" }], edges: [] });
  check(typeof revRace === "number" && await A.until(`${items} === 5 && window.__codeWaits.length >= 1`, 15000), "a write from elsewhere shown, its digest still being computed");
  await A.ev(`(window.sagebrush.board.personEditForTests((d) => { d.nodes.find((n) => n.id === "more").code = "print(x + 250)"; }), 1)`);
  check(await A.until("window.__codeWaits.length >= 2", 15000), "…then the person's edit, its digest still being computed too");
  await A.ev("(window.__holdCode = false, window.__codeWaits.pop()(), 1)");
  await sleep(1500);
  await A.ev("(window.__codeWaits.splice(0).forEach((r) => r()), 1)");
  await sleep(3000);
  check(!/RACE RAN/.test(await A.ev(outOf("race"))) && !(await A.ev(`${runBtn}.hidden`)), "…the edit's digest finished first: it carries nothing from the board before the write, the write's code held", { race: await A.ev(outOf("race")) });
  await runIt();
  check(await A.until(`${outOf("race")}.then((o) => /RACE RAN/.test(o))`, 60000), "…until the person runs it");
  // (D4: another writer's code held, then the person edits another item: that edit approves nothing of the held code)
  const rev4 = await write({ title: "Followed", nodes: [KEEP, { id: "intro", title: "About", text: "Its square: $x^2$." }, { id: "sq", title: "A square", code: "x = 6\nprint(x * 8)" }, { id: "more", title: "More", code: "print(x + 200)" }, { id: "theirs", title: "Theirs", code: "print('THEIRS RAN')" }], edges: [] });
  check(typeof rev4 === "number" && await A.until(`${items} === 5`, 15000) && await A.until(`!${runBtn}.hidden`, 10000), "another writer's new code: held, Run offered");
  await A.ev(`window.sagebrush.board.personEditForTests((d) => { d.nodes.find((n) => n.id === "more").code = "print(x + 300)"; }).then(() => 1)`);
  await sleep(3000);
  check(!/THEIRS RAN/.test(await A.ev(outOf("theirs"))) && !/306/.test(await A.ev(outOf("more"))) && !(await A.ev(`${runBtn}.hidden`)), "…the person's edit of another item meanwhile doesn't approve it: nothing runs, Run still offered", { theirs: await A.ev(outOf("theirs")), more: await A.ev(outOf("more")) });
  // (F1: a change written while no page has the board open waits at its first open)
  await A.send("Page.navigate", { url: "about:blank" });
  const rev5 = await write({ title: "Followed", nodes: [KEEP, { id: "late", title: "Late", code: "print('LATE RAN')" }], edges: [] });
  check(typeof rev5 === "number", "written while no page has the board open");
  await A.send("Page.navigate", { url: unconfined });
  check(await A.until(`!!window.sagebrush?.board?.snapshot?.()?.doc && ${items} === 2`, 60000), "opened after: the board as written");
  await sleep(3000);
  check(!/LATE RAN/.test(await A.ev(outOf("late"))) && !(await A.ev(`${runBtn}.hidden`)), "…its code not run: Run is offered at the first open");
  await runIt();
  check(await A.until(`${outOf("late")}.then((o) => /LATE RAN/.test(o))`, 60000), "…and runs when the person presses it");

  // (a board of questions only, their checks its only code: held unconfined, Run offered; Check runs nothing until the
  // person runs it; then it does)
  const revQ = await write({ title: "Asks", layout: "grid", columns: 1, nodes: [{ id: "k", kind: "ask", input: "number", text: "Two?", answer: 2, check: "answer == 2" }], edges: [] });
  const askNode = `window.sagebrush.board.snapshot().doc.nodes.find((n) => n.id === "k")`;
  check(typeof revQ === "number" && await A.until(`${askNode}?.check === "answer == 2"`, 15000), "a board of questions only, written elsewhere: shown");
  // (its question in view, so its controls are drawn, as test-ask.mjs does)
  await A.ev("window.board.setCamera({ x: -40, y: -100, z: 1 }), window.board.render(), 1");
  check(await A.until(`!!document.querySelector('.board-ask[data-ask="k"] .board-ask-check')`, 15000) && await A.until(`!${runBtn}.hidden`, 10000), "…held: Run offered, its Check drawn");
  await A.ev(`(document.querySelector('.board-ask[data-ask="k"] .board-ask-check').click(), 1)`);
  await sleep(3000);
  check((await A.ev(`${askNode}.result ?? null`)) === null && !(await A.ev(`${runBtn}.hidden`)), "…Check runs nothing before the person's Run", await A.ev(`${askNode}.result ?? null`));
  await runIt();
  check(await A.until(`${runBtn}.hidden`, 10000), "…Run approves it");
  await A.ev(`(document.querySelector('.board-ask[data-ask="k"] .board-ask-check').click(), 1)`);
  check(await A.until(`${askNode}.result === "right"`, 60000), "…then Check runs its check: right", await A.ev(`${askNode}.result ?? null`));

  // in the runner (the sandbox: nothing of the person's in reach), a change written elsewhere runs at once, unasked
  const created3 = await A.send("Target.createTarget", { url: "about:blank" });
  const R = await tab((await (async () => { for (let i = 0; i < 100; i++) { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((x) => x.id === created3.targetId); if (p) return p; await sleep(100); } throw new Error("tab R not found"); })()).webSocketDebuggerUrl);
  await R.send("Page.navigate", { url: `${base}board/?doc=local:${id}` });
  check(await R.until(`!!window.sagebrush?.board?.snapshot?.()?.doc && crossOriginIsolated === true`, 60000), "the board opened with the runner (a cross-origin-isolated page)");
  const rev6 = await write({ title: "Followed", nodes: [KEEP, { id: "sandboxed", title: "Sandboxed", code: "print('IN THE RUNNER', 6 * 7)" }], edges: [] });
  check(typeof rev6 === "number" && await R.until(`window.sagebrush.board.snapshot().items.length === 2`, 15000), "a change written elsewhere, shown in the runner's page");
  check(await R.until(`window.sagebrush.board.outputs().then((os) => /IN THE RUNNER 42/.test(String(os.find((o) => o.id === "sandboxed")?.output ?? "")))`, 90000) && await R.ev(`document.querySelector("[data-sbb=runpaused]").hidden`), "…its code runs at once, whoever wrote it: no Run asked for");
  // (Codex F2 on #2477: a board the page has from its source, not the workspace (an example): left running as its page
  // goes, it opens paused next time, in the runner too, until the person runs it)
  const example = `${base}board/?doc=${encodeURIComponent("examples/live.board.json")}`;
  await R.send("Page.navigate", { url: example });
  check(await R.until("!!window.sagebrush?.board?.snapshot?.()?.doc", 60000), "an example board, opened in the runner");
  await R.ev(`(window.sagebrush.board.load({ title: "Spins", nodes: [{ id: "spin", code: "while True:\n    pass" }] }), 1)`);
  check(await R.until(`window.sagebrush.board.outputs ? (window.sagebrush.board.snapshot().doc.title === "Spins") : false`, 15000), "…its code running, left so");
  await sleep(3000);
  await R.send("Page.navigate", { url: "about:blank" });
  await sleep(500);
  await R.send("Page.navigate", { url: example });
  check(await R.until(`!!window.sagebrush?.board?.snapshot?.()?.doc && !document.querySelector("[data-sbb=runpaused]").hidden`, 60000) && /stopped/.test(await R.ev(`document.querySelector("[data-sbb=runpaused]").title`)), "…opened again: paused, as its last run was left running", await R.ev(`document.querySelector("[data-sbb=runpaused]").title`).catch(() => null));
  await R.ev(`(document.querySelector("[data-sbb=runpaused]").click(), 1)`);
  check(await R.until(`document.querySelector("[data-sbb=runpaused]").hidden`, 10000) && (await R.ev(`JSON.parse(localStorage.getItem("sagebrush-board-stopped") ?? "[]").some((x) => x.startsWith("source:examples/live.board.json"))`)) === false, "…Run runs it, and it opens unpaused again");
  await R.send("Page.navigate", { url: "about:blank" });
  await A.send("Page.navigate", { url: unconfined });
  await A.until("!!window.sagebrush?.board?.snapshot?.()?.doc", 60000);
  // (what follows is without a reload from here)
  origin0 = await A.ev("performance.timeOrigin");

  // the board's own edit, here: saved over the version it shows, never taken for a write made elsewhere
  await A.ev("window.sagebrush.board.editing(true), 1");
  const revHere = await B.ev(`${W}.read(${JSON.stringify(path)}).then((r) => r.rev)`);
  await A.ev(`window.sagebrush.board.edit((d) => { d.title = "Followed, renamed here"; }).then(() => 1)`);
  check(await B.until(`${W}.read(${JSON.stringify(path)}).then((r) => r.content.title === "Followed, renamed here" && r.rev === ${revHere + 1})`, 15000), "the board's own edit is saved over the version it shows");
  await sleep(1500);
  check(!(await A.ev(`${W}.list("/").then((l) => l.some((e) => /changed elsewhere/.test(e.path)))`)), "…no \"changed elsewhere\" copy is made");
  check((await A.ev("window.sagebrush.board.snapshot().doc.title")) === "Followed, renamed here" && !/changed elsewhere/.test(await A.ev("document.body.innerText")), "…and the board shows its own edit, saying nothing");
  check(await A.ev("performance.timeOrigin") === origin0, "…still without a reload");
  // an edit here while a version from elsewhere is still being drawn: its picture's bytes held once (their digest waits), the
  // person edits, then the picture goes on. The edit wins on the page; its save meets the write as a conflict: the
  // board shows the other version, the person's is kept as a board of its own, and the next edit loses neither
  await A.ev(`(() => { const orig = crypto.subtle.digest.bind(crypto.subtle); crypto.subtle.digest = async (...a) => { if (!window.__held && new TextDecoder().decode(a[1]).includes("held-picture-marker")) { window.__held = true; await new Promise((r) => (window.__go = r)); } return orig(...a); }; return 1; })()`);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--held-picture-marker--></svg>';
  // (its file renamed by the title edited here: found again by its id)
  const path2 = await B.ev(`${W}.list("/").then((l) => l.find((e) => e.kind === "board" && e.ref === ${JSON.stringify(id)}).path)`);
  const write2 = (doc) => B.ev(`${W}.read(${JSON.stringify(path2)}).then((r) => ${W}.write(${JSON.stringify(path2)}, ${JSON.stringify(doc)}, { base: r.rev })).then((r) => r.rev)`);
  const revR = await write2({ title: "REMOTE IMAGE", nodes: [{ id: "remote", text: "remote" }], edges: [], images: { p: { w: 1, h: 1, src: "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64") } } });
  check(typeof revR === "number" && await A.until("window.__held === true", 15000), "a version from elsewhere, its picture held while it is drawn");
  await A.ev(`window.sagebrush.board.edit((d) => { d.title = "PERSON WHILE HELD"; }).then(() => 1)`);
  await A.ev(`window.sagebrush.board.edit((d) => { d.nodes.push({ id: "mine", text: "MINE TOO" }); }).then(() => 1)`);
  check((await A.ev("window.sagebrush.board.snapshot().doc.title")) === "PERSON WHILE HELD" && await A.ev(`window.sagebrush.board.snapshot().doc.nodes.some((n) => n.id === "mine")`), "…the person's two edits meanwhile are shown");
  await A.ev("(window.__go(), 1)");
  const copyPath = "/PERSON WHILE HELD (your changes, made while it changed elsewhere).board.json";
  check(await B.until(`${W}.list("/").then((l) => l.some((e) => e.path === ${JSON.stringify(copyPath)}))`, 15000), "the person's edit is kept, as a board of its own", await B.ev(`${W}.list("/").then((l) => l.map((e) => e.path))`));
  check(await A.until(`window.sagebrush.board.snapshot().doc.title === "REMOTE IMAGE" && /changed elsewhere while you edited/.test(document.body.innerText)`, 15000), "…the board shows the other version, and says so");
  check(await B.ev(`${W}.read(${JSON.stringify(path2)}).then((r) => r.content.title === "REMOTE IMAGE" && r.rev === ${revR})`), "…which the workspace keeps as it was written, not written over");
  await A.ev(`window.sagebrush.board.edit((d) => { d.nodes.push({ id: "next", text: "NEXT EDIT" }); }).then(() => 1)`);
  check(await B.until(`${W}.read(${JSON.stringify(path2)}).then((r) => r.content.title === "REMOTE IMAGE" && r.content.nodes.some((n) => n.id === "next"))`, 15000), "the next edit is saved over the version shown");
  check(await B.ev(`${W}.read(${JSON.stringify(copyPath)}).then((r) => r.content.title.startsWith("PERSON WHILE HELD") && r.content.nodes.some((n) => n.id === "mine"))`), "…and the person's earlier edits, both, are still kept");
  // the same while KaTeX loads, the first time a board has math: a fresh tab, C, its board without math, the math
  // module's request held (Fetch); a version with math from elsewhere waits on it; the person makes two edits; then
  // it loads. Both kept, as above, and the next edit loses neither
  const created2 = await A.send("Target.createTarget", { url: "about:blank" });
  const C = await tab((await (async () => { for (let i = 0; i < 100; i++) { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((x) => x.id === created2.targetId); if (p) return p; await sleep(100); } throw new Error("tab C not found"); })()).webSocketDebuggerUrl);
  await C.send("Page.navigate", { url: `${base}board/?new=python` });
  check(await C.until("/doc=local:/.test(location.search) && !!window.sagebrush?.board?.snapshot?.()?.doc", 60000), "tab C makes a board of its own, no math in it");
  const id3 = await C.ev("new URLSearchParams(location.search).get('doc').slice('local:'.length)");
  check(await C.until(`${W}.list("/").then((l) => l.some((e) => e.kind === "board" && e.ref === ${JSON.stringify(id3)}))`, 20000), "…listed in the workspace");
  const path3 = await C.ev(`${W}.list("/").then((l) => l.find((e) => e.kind === "board" && e.ref === ${JSON.stringify(id3)}).path)`);
  check(!(await C.ev("[...performance.getEntriesByType('resource')].some((r) => /sagebrush-math\\.js/.test(r.name))")), "…KaTeX not loaded in it yet");
  // (with this tab's cache and the site's service worker bypassed: tab A has loaded the module, and either would
  //  serve it to this tab unseen)
  await C.send("Network.enable");
  await C.send("Network.setCacheDisabled", { cacheDisabled: true });
  await C.send("Network.setBypassServiceWorker", { bypass: true });
  await C.send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-math.js*", requestStage: "Request" }] });
  const write3 = (doc) => B.ev(`${W}.read(${JSON.stringify(path3)}).then((r) => ${W}.write(${JSON.stringify(path3)}, ${JSON.stringify(doc)}, { base: r.rev })).then((r) => r.rev)`);
  const revM = await write3({ title: "REMOTE MATH", nodes: [{ id: "m", title: "Math", text: "Its square: $x^2$." }], edges: [] });
  let mathHeld = false;
  for (const t0 = Date.now(); !mathHeld && Date.now() - t0 < 15000; await sleep(100)) mathHeld = C.held.length > 0;
  check(typeof revM === "number" && mathHeld, "a version with math from elsewhere, KaTeX's load held while it is drawn", C.held.map((h) => h.request?.url));
  check(!(await C.ev("window.sagebrush.board.snapshot().doc.nodes.some((n) => n.id === 'm')")) && (await C.ev("window.sagebrush.board.snapshot().doc.title")) !== "REMOTE MATH", "…while it waits, the board is still the one it was: the version from elsewhere isn't taken in before it is drawn", await C.ev("JSON.stringify(window.sagebrush.board.snapshot().doc)"));
  await C.ev("window.sagebrush.board.editing(true), 1");
  // (the person's edits, not waited for: one waiting on KaTeX would wait for the release)
  await C.ev(`(window.sagebrush.board.edit((d) => { d.title = "PERSON WHILE MATH"; }), 1)`);
  await C.ev(`(window.sagebrush.board.edit((d) => { d.nodes.push({ id: "mine2", text: "MINE TOO" }); }), 1)`);
  check(await C.until(`window.sagebrush.board.snapshot().doc.title === "PERSON WHILE MATH" && window.sagebrush.board.snapshot().doc.nodes.some((n) => n.id === "mine2")`, 5000), "…the person's two edits meanwhile are shown, on the board as it was (not on the version still being drawn)", await C.ev("JSON.stringify(window.sagebrush.board.snapshot().doc)").catch(() => null));
  const mine = await C.ev("JSON.stringify({ title: window.sagebrush.board.snapshot().doc.title, nodes: window.sagebrush.board.snapshot().doc.nodes.map((n) => n.id) })");
  for (const h of C.held.splice(0)) await C.send("Fetch.continueRequest", { requestId: h.requestId });
  await C.send("Fetch.disable");
  const copy3 = "/PERSON WHILE MATH (your changes, made while it changed elsewhere).board.json";
  check(await B.until(`${W}.list("/").then((l) => l.some((e) => e.path === ${JSON.stringify(copy3)}))`, 20000), "KaTeX loaded: the person's edits are kept, as a board of their own", await B.ev(`${W}.list("/").then((l) => l.map((e) => e.path))`));
  check(await C.until(`window.sagebrush.board.snapshot().doc.title === "REMOTE MATH" && /changed elsewhere while you edited/.test(document.body.innerText)`, 20000), "…the board shows the other version, and says so", await C.ev("window.sagebrush.board.snapshot().doc.title"));
  const path3b = await B.ev(`${W}.list("/").then((l) => l.find((e) => e.kind === "board" && e.ref === ${JSON.stringify(id3)}).path)`);
  check(await B.ev(`${W}.read(${JSON.stringify(path3b)}).then((r) => r.content.title === "REMOTE MATH" && r.rev === ${revM})`), "…which the workspace keeps as it was written, not written over");
  await C.ev(`window.sagebrush.board.edit((d) => { d.nodes.push({ id: "next2", text: "NEXT EDIT" }); }).then(() => 1)`);
  check(await B.until(`${W}.read(${JSON.stringify(path3b)}).then((r) => r.content.title === "REMOTE MATH" && JSON.stringify(r.content.nodes.map((n) => n.id)) === '["m","next2"]' && r.content.nodes[0].text === "Its square: $x^2$.")`, 15000), "the next edit is saved over the version shown: exactly the other version and the new item", await B.ev(`${W}.read(${JSON.stringify(path3b)}).then((r) => JSON.stringify(r.content))`));
  const copyNow = await B.ev(`${W}.read(${JSON.stringify(copy3)}).then((r) => JSON.stringify({ title: r.content.title, nodes: r.content.nodes.map((n) => n.id) }))`);
  const mineDoc = JSON.parse(mine);
  check(copyNow === JSON.stringify({ title: mineDoc.title + " (your changes, made while it changed elsewhere)", nodes: mineDoc.nodes }), "…and the person's copy is exactly the board they edited, both edits in it", { copyNow, mine });
  check(!C.errors.length, "no exceptions in tab C: " + C.errors.join(" | ").slice(0, 400));
  check(!A.errors.length && !B.errors.length, "no exceptions: " + [...A.errors, ...B.errors].join(" | ").slice(0, 400));
} catch (e) {
  fails.push(String(e?.stack ?? e) + (dead && chromeTail.trim() ? `\n  Chrome's stderr, its end:\n    ${chromeTail.trim().split("\n").slice(-15).join("\n    ")}` : ""));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
if (fails.length) {
  console.log(`${fails.length} of ${checks} checks failed:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed`);
process.exit(0);
