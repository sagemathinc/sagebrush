// Both pages wired to the workspace (web/workspace/, design/workspace-files.md
// step 1b), in headless Chromium against the built site:
// - the board page: a board kept before in localStorage is brought in, under
//   its id; an edit is written to the workspace, the old localStorage copy
//   left as it was and the pending copy dropped once written; a reload shows
//   the workspace's copy; a pending copy left by a page closed mid-write is
//   taken at the next load and written; ?new= makes a board of the
//   workspace; window.sagebrush.workspace is the agent's view (no
//   dropVersions, no forget), its changes credited to agent:page;
// - the notebook page: the open notebook is listed, renamed with its name,
//   and dropped from the list when deleted; uploads go through the
//   workspace, an overwrite keeping a version, and so do Python's writes;
//   the Files panel's ✕ puts a file in Trash.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-workspace-pages.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ws-pages-"));
const files = mkdtempSync(join(tmpdir(), "sb-ws-up-"));
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
  // (Delete's confirm: yes)
  if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true });
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const go = async (url) => { await send("Page.navigate", { url }); await sleep(300); };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const W = "window.sagebrush?.workspace";
const B = "window.sagebrush?.board";

try {
  for (const m of ["Page.enable", "Runtime.enable", "DOM.enable"]) await send(m);
  // ---------------------------------------------------------------- the board page
  await go(base + "board/");
  await until(`${B}?.snapshot()`, 60000);
  const id = "abcdefabcdef", key = "sagebrush-board:local:" + id;
  const old = JSON.stringify({ title: "Old board", nodes: [{ id: "n", title: "a note" }] });
  await ev(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(old)}); localStorage.setItem("sagebrush-boards", JSON.stringify([{ id: ${JSON.stringify(id)}, title: "Old board", mode: "python", at: 1000 }])); true`);
  await go(base + "board/?doc=local:" + id);
  check(await until(`${B}?.snapshot()?.doc?.title === "Old board"`, 60000), "a board kept in localStorage opens");
  check(await until(`${W}?.list("/").then((l) => l.some((e) => e.path === "/Old board.board.json" && e.ref === ${JSON.stringify(id)}))`), "…and is in the workspace, under its id");
  check(await ev(`typeof ${W}.dropVersions === "undefined" && typeof ${W}.forget === "undefined" && typeof ${W}.rename === "function"`), "window.sagebrush.workspace is the agent's view: no dropVersions, no forget");
  await ev(`${B}.edit((d) => { d.title = "Changed"; }).then(() => 1)`);
  check(await until(`${W}.read("/Old board.board.json").then((r) => r.content.title === "Changed")`), "an edit is written to the workspace");
  check(await until(`localStorage.getItem("sagebrush-workspace-pending:${id}") === null`), "…the pending copy dropped once written");
  check(await ev(`localStorage.getItem(${JSON.stringify(key)}) === ${JSON.stringify(old)}`), "…the old localStorage copy left as it was");
  await go(base + "board/?doc=local:" + id);
  check(await until(`${B}?.snapshot()?.doc?.title === "Changed"`, 60000), "a reload shows the workspace's copy");
  check(await ev(`${W}.list("/").then((l) => l.filter((e) => e.kind === "board").length)`) === 1, "…and brings nothing in twice");
  // a page closed mid-write: its pending copy is taken at the next load
  const revNow = await ev(`${W}.read("/Old board.board.json").then((r) => r.rev)`);
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", "abababababababab:1:" + ${revNow} + "\\n" + JSON.stringify({ title: "Pending", nodes: [] })); true`);
  await go(base + "board/?doc=local:" + id);
  check(await until(`${B}?.snapshot()?.doc?.title === "Pending"`, 60000), "a pending copy left by a closed page is shown");
  check(await until(`${W}.read("/Old board.board.json").then((r) => r.content.title === "Pending")`), "…and written to the workspace");
  check(await until(`localStorage.getItem("sagebrush-workspace-pending:${id}") === null`), "…then dropped");
  // ?new=: a board of the workspace
  await go(base + "board/?new=python");
  check(await until(`/[?&]doc=local:[0-9a-f]{12}/.test(location.search) && !!${B}?.snapshot()`, 60000), "?new= opens a new board");
  const newId = await ev(`location.search.match(/local:([0-9a-f]{12})/)[1]`);
  check(await until(`${W}?.list("/").then((l) => l.some((e) => e.path === "/Untitled board.board.json" && e.ref === ${JSON.stringify(newId)}))`), "…listed as /Untitled board.board.json");
  check(await ev(`localStorage.getItem("sagebrush-board:local:${newId}") === null`), "…and not written to localStorage");
  // an agent's change through window.sagebrush.workspace is credited to it
  await ev(`${W}.mkdir("/From the agent").then(() => 1)`);
  check(await ev(`${W}.ops().then((o) => o.at(-1).op === "mkdir" && o.at(-1).by === "agent:page")`), "an agent's change is credited to agent:page");


  // two savers: a commit never drops a newer save's pending copy (CORR-12C-1)
  const hold = (tag) => ev(`(() => { navigator.locks.request("sagebrush-workspace", () => new Promise((r) => (window.__release${tag} = r))); return 1; })()`);
  const release = (tag) => ev(`(() => { window.__release${tag}?.(); return 1; })()`);
  await go(base + "board/?doc=local:" + id);
  await until(`${B}?.snapshot()?.doc?.title === "Pending"`, 60000);
  await hold("A");
  await ev(`${B}.edit((d) => { d.title = "Mine"; }).then(() => 1)`);
  check(await until(`(localStorage.getItem("sagebrush-workspace-pending:${id}") ?? "").includes('"Mine"')`), "(this page's save is pending)");
  const other = "ffffffffffffffff:1:0\n" + JSON.stringify({ title: "Other tab's", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(other)}); 1`);
  await release("A");
  check(await until(`${W}.read("/Old board.board.json").then((r) => r.content.title === "Mine")`), "(this page's save is written)");
  await sleep(300);
  check(await ev(`localStorage.getItem("sagebrush-workspace-pending:${id}") === ${JSON.stringify(other)}`), "another tab's newer pending copy isn't dropped by this page's commit");
  await ev(`localStorage.removeItem("sagebrush-workspace-pending:${id}"); 1`);
  // a pending copy the record has moved past (another writer since): kept as a board of its own, the record shown (CORR-12C-2)
  const rev0 = await ev(`${W}.read("/Old board.board.json").then((r) => r.rev)`);
  const stale = `eeeeeeeeeeeeeeee:3:${rev0}\n` + JSON.stringify({ title: "Left by a closed page", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(stale)}); 1`);
  await ev(`${W}.read("/Old board.board.json").then((r) => ${W}.write("/Old board.board.json", { title: "The agent's", nodes: [] }, { base: r.rev })).then(() => 1)`);
  await go(base + "board/?doc=local:" + id);
  check(await until(`${B}?.snapshot()?.doc?.title === "The agent's"`, 60000), "the record another writer moved on is shown, not the stale pending copy");
  check(await until(`${W}.list("/").then((l) => l.some((e) => e.path === "/Left by a closed page (unsaved changes from a closed page).board.json"))`), "…the pending copy kept as a board of its own");
  check(await until(`localStorage.getItem("sagebrush-workspace-pending:${id}") === null`), "…and then dropped");

  // recovery removes only the pending copy it read (CORR-2D1-1): a newer save written while it worked stays
  const S = "9999999999999999";
  const revA = await ev(`${W}.read("/Old board.board.json").then((r) => r.rev)`);
  const staleS1 = `${S}:1:${revA - 1}\n` + JSON.stringify({ title: "Stale S1", nodes: [] });
  const liveS2 = `${S}:2:${revA}\n` + JSON.stringify({ title: "Live S2", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(staleS1)}); 1`);
  await hold("R");
  await ev(`(() => { window.__loadP = import("/board/board.js").then((m) => m.host.store.load()); return 1; })()`);
  await sleep(500);
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(liveS2)}); 1`);
  await release("R");
  await ev(`window.__loadP.then(() => 1)`);
  check(await ev(`localStorage.getItem("sagebrush-workspace-pending:${id}") === ${JSON.stringify(liveS2)}`), "a recovery drops only the pending copy it read, not a newer one written meanwhile");
  await ev(`localStorage.removeItem("sagebrush-workspace-pending:${id}"); 1`);
  // a session's later committed save beats its own earlier pending copy (CORR-2D1-2)
  await ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const tx = r.result.transaction("boards", "readwrite"), st = tx.objectStore("boards"); const g = st.get(${JSON.stringify(id)}); g.onsuccess = () => { const rec = g.result; st.put({ ...rec, doc: { title: "B committed", nodes: [] }, rev: rec.rev + 1, tag: "${S}:2:0" }); }; tx.oncomplete = () => { r.result.close(); ok(1); }; }; })`);
  const revB = await ev(`${W}.read("/Old board.board.json").then((r) => r.rev)`);
  const staleA = `${S}:1:${revB - 2}\n` + JSON.stringify({ title: "A pending", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(staleA)}); 1`);
  await go(base + "board/?doc=local:" + id);
  check(await until(`${B}?.snapshot()?.doc?.title === "B committed"`, 60000), "a session's later committed save is shown over its own earlier pending copy");
  check(await until(`localStorage.getItem("sagebrush-workspace-pending:${id}") === null`), "…and the earlier pending copy is dropped");
  check(await ev(`${W}.list("/").then((l) => !l.some((e) => e.path.startsWith("/A pending")))`), "…with no conflict copy made of it");
  // an agent can't claim a page session's tag
  await ev(`${W}.read("/Old board.board.json").then((r) => ${W}.write("/Old board.board.json", r.content, { base: r.rev, tag: "${S}:99:0" })).then(() => 1)`);
  check(await ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const g = r.result.transaction("boards").objectStore("boards").get(${JSON.stringify(id)}); g.onsuccess = () => { const t = g.result.tag; r.result.close(); ok(t === undefined); }; }; })`), "an agent's write carries no session tag, whatever it asks");

  // a recovery's write meets a change made since load read the board: both kept (CORR-AA2-1)
  const R = await ev(`${W}.read("/Old board.board.json").then((r) => r.rev)`);
  const pendA = `8888888888888888:1:${R}\n` + JSON.stringify({ title: "A recovered", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(pendA)}); 1`);
  await hold("C");
  await ev(`(() => { window.__agentP = ${W}.write("/Old board.board.json", { title: "B by agent", nodes: [] }, { base: ${R} }); return 1; })()`);
  await ev(`(() => { window.__loadP2 = import("/board/board.js").then((m) => m.host.store.load()); return 1; })()`);
  await sleep(500);
  await release("C");
  await ev(`Promise.all([window.__agentP, window.__loadP2]).then(() => 1)`);
  check(await until(`${W}.read("/Old board.board.json").then((r) => r.content.title === "B by agent")`), "the change made in between isn't written over");
  check(await until(`${W}.list("/").then((l) => l.some((e) => e.path === "/A recovered (your changes, made while it changed elsewhere).board.json"))`), "…the recovered version is kept as a board of its own");
  check(await until(`localStorage.getItem("sagebrush-workspace-pending:${id}") === null`), "…and only then its pending copy dropped");
  check(await until(`${B}?.snapshot()?.doc?.title === "B by agent" && /changed elsewhere while you edited/.test(document.body.innerText)`), "…the board shows the other version, and says so");
  // a board only a pending copy holds: brought in (CORR-12C-3)
  const lone = "fedcba987654", loneText = "dddddddddddddddd:1:0\n" + JSON.stringify({ title: "Only pending", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${lone}", ${JSON.stringify(loneText)}); 1`);
  await go(base + "board/?doc=local:" + lone);
  check(await until(`${B}?.snapshot()?.doc?.title === "Only pending"`, 60000), "a board only a pending copy holds is shown");
  check(await until(`${W}.list("/").then((l) => l.some((e) => e.ref === ${JSON.stringify(lone)} && e.path === "/Only pending.board.json"))`), "…and brought into the workspace under its id");
  // a pending copy that can't be read: set aside, said, never parsed again (LIMIT-12C-4)
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${lone}", "not a pending copy"); 1`);
  await go(base + "board/?doc=local:" + lone);
  check(await until(`${B}?.snapshot()?.doc?.title === "Only pending" && /couldn't be read/.test(document.body.innerText)`, 60000), "an unreadable pending copy is said, the board as kept shown");
  check(await ev(`localStorage.getItem("sagebrush-workspace-pending-unread:${lone}") === "not a pending copy" && localStorage.getItem("sagebrush-workspace-pending:${lone}") === null`), "…set aside, not dropped");
  // a workspace that opens after the page gave up on it: closed, the page keeps boards as before (LIMIT-12C-3)
  const legacy = "cccccccccccc";
  await ev(`localStorage.setItem("sagebrush-board:local:${legacy}", JSON.stringify({ title: "Legacy", nodes: [] })); 1`);
  // (the second tab: a board page with no workspace, the benchmark's, holding the workspace's lock)
  const t2 = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base + "board/?items=10&strokes=0")}`, { method: "PUT" })).json();
  const ws2 = new WebSocket(t2.webSocketDebuggerUrl);
  await new Promise((r) => (ws2.onopen = r));
  let n2 = 0; const w2 = new Map();
  ws2.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w2.has(m.id)) { w2.get(m.id)(m.result); w2.delete(m.id); } };
  const ev2 = (expression) => new Promise((r) => { const i = ++n2; w2.set(i, r); ws2.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, returnByValue: true } })); });
  await sleep(1500);
  await ev2(`navigator.locks.request("sagebrush-workspace", () => new Promise((r) => (window.__held = r))); 1`);
  await go(base + "board/?doc=local:" + legacy);
  check(await until(`${B}?.snapshot()?.doc?.title === "Legacy"`, 60000), "with the workspace held up, the board opens as before");
  check(await ev(`!${W}`), "…without a workspace for this visit");
  await ev(`${B}.edit((d) => { d.title = "Legacy edited"; }).then(() => 1)`);
  check(await until(`JSON.parse(localStorage.getItem("sagebrush-board:local:${legacy}")).title === "Legacy edited"`), "…kept in localStorage, as before");
  await ev2(`window.__held(); 1`);
  ws2.close();
  await sleep(1500);
  const migratedLate = await ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const q = r.result.transaction("entries").objectStore("entries").getAll(); q.onsuccess = () => { const hit = q.result.some((e) => e.ref === "${legacy}"); r.result.close(); ok(hit); }; }; })`);
  check(migratedLate === false, "…and the workspace that opened late, once the page gave up on it, brought nothing in");

  // ---------------------------------------------------------------- the notebook page
  await go(base);
  check(await until(`!!window.sagebrush?.notebook && !!${W}`, 60000), "the notebook page opens its workspace");
  const nbId = await ev(`localStorage.getItem("sagebrush-current")`);
  check(await until(`${W}.list("/").then((l) => l.some((e) => e.kind === "notebook" && e.ref === ${JSON.stringify(nbId)}))`), "the open notebook is listed");
  await ev(`(() => { const i = document.querySelector("#nbname"); i.value = "Renamed nb"; i.dispatchEvent(new Event("input")); return 1; })()`);
  check(await until(`${W}.list("/").then((l) => l.some((e) => e.path === "/Renamed nb.ipynb" && e.ref === ${JSON.stringify(nbId)}))`, 8000), "renaming the notebook renames its file");
  // uploads through the workspace: an overwrite keeps a version
  const up = async (content) => {
    const f = join(files, "data.txt");
    writeFileSync(f, content);
    const doc = await send("DOM.getDocument", {});
    const q = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#uploadinput" });
    await send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: [f] });
  };
  await up("first");
  check(await until(`${W}.read("/data.txt").then((r) => new TextDecoder().decode(r.content) === "first")`), "an upload goes into the workspace");
  await up("second");
  check(await until(`${W}.read("/data.txt").then((r) => new TextDecoder().decode(r.content) === "second")`), "…an upload over it writes it");
  check(await until(`${W}.history("/data.txt").then((h) => h.length === 1)`), "…keeping the old bytes as a version");
  check(await ev(`${W}.version("/data.txt", 0).then((b) => new TextDecoder().decode(b))`) === "first", "…which are the first upload's");
  // Python's writes go through the workspace: a second write keeps the first as a version
  // (the first code cell: the Welcome notebook starts with Markdown)
  const runPy = (code) => ev(`(async () => { const nb = sagebrush.notebook, c = nb.cells().find((x) => x.type === "code"); c.ta.value = ${JSON.stringify(code)}; c.ta.dispatchEvent(new Event("input", { bubbles: true })); await nb.run(c); return true; })()`);
  await runPy('with open("/py.txt", "w") as f:\n    f.write("one")\nprint("wrote one")');
  const pyOk = await until(`${W}.read("/py.txt").then((r) => new TextDecoder().decode(r.content) === "one")`, 60000);
  const diag = pyOk ? "" : await ev(`(async () => { const keys = await new Promise((ok) => { const r = indexedDB.open("sagebrush"); r.onsuccess = () => { const q = r.result.transaction("files").objectStore("files").getAllKeys(); q.onsuccess = () => ok(q.result); }; }); const c = sagebrush.notebook.cells().find((x) => x.type === "code"); return JSON.stringify({ keys, stat: await ${W}.stat("/py.txt").catch((e) => String(e)), input: c?.ta?.value, out: c?.el?.innerText?.slice(0, 300) ?? Object.keys(c ?? {}).join(",") }); })()`).catch((e) => String(e));
  check(pyOk, "a file Python writes is in the workspace " + diag);
  await runPy('with open("/py.txt", "w") as f:\n    f.write("two")\nprint("wrote two")');
  check(await until(`${W}.read("/py.txt").then((r) => new TextDecoder().decode(r.content) === "two")`, 30000), "…written again by Python");
  check(await until(`${W}.history("/py.txt").then((h) => h.length === 1)`) && (await ev(`${W}.version("/py.txt", 0).then((b) => new TextDecoder().decode(b))`)) === "one", "…keeping Python's first write as a version: " + (await ev(`${W}.history("/py.txt").then((h) => h.length)`)));

  // an upload over the limit is refused by its size, never read, never given to Python (LIMIT-12C-1)
  await ev(`window.sagebrush.files.add([{ name: "huge.bin", size: 300 * 2 ** 20, arrayBuffer() { window.__readHuge = true; return Promise.resolve(new ArrayBuffer(0)); } }]).then(() => 1)`);
  check(await ev(`window.__readHuge === undefined`), "an upload over the limit isn't read");
  check(await ev(`${W}.stat("/huge.bin").then((e) => e === undefined)`) && /Not added: huge\.bin/.test(await ev(`document.querySelector("#status").textContent`)), "…isn't kept, and says so");
  // Python's write storm: the queue keeps each path's latest only (LIMIT-12C-2)
  await hold("Q");
  await runPy('for i in range(30):\n    with open("/storm.txt", "w") as f:\n        f.write("x" * 1000 + str(i))\nprint("stormed")');
  const q = await ev(`window.sagebrush.files.queue()`);
  check(q.paths <= 1 && q.bytes <= 1100, "a storm of writes to one file waits as one: " + JSON.stringify(q));
  await ev(`window.sagebrush.files.setQueueMax(1500); 1`);
  await runPy('with open("/other.txt", "w") as f:\n    f.write("y" * 1000)\nprint("other")');
  check((await ev(`window.sagebrush.files.queue()`)).refused > 0 && /too much is waiting/.test(await ev(`document.querySelector("#status").textContent`)), "past the queue's bound, a write isn't queued, and says so");
  await ev(`window.sagebrush.files.setQueueMax(256 * 2 ** 20); 1`);
  await release("Q");
  check(await until(`${W}.read("/storm.txt").then((r) => new TextDecoder().decode(r.content).endsWith("29"))`, 30000), "…and the file ends as Python left it");
  check(await until(`window.sagebrush.files.queue().paths === 0`), "…the queue empties");

  // the Files panel's ✕: to Trash
  await ev(`(() => { document.querySelector("#filesbtn").click(); return 1; })()`);
  check(await until(`!!document.querySelector('#filelist button[aria-label="Delete /data.txt"]')`), "the Files panel lists the file");
  await ev(`(() => { document.querySelector('#filelist button[aria-label="Delete /data.txt"]').click(); return 1; })()`);
  check(await until(`${W}.list("/Trash").then((l) => l.some((e) => e.path === "/Trash/data.txt"))`), "the Files panel's ✕ puts the file in Trash");
  check(await ev(`${W}.stat("/data.txt").then((e) => e === undefined)`), "…out of the folder");
  // deleting the notebook drops it from the list
  await ev(`(() => { document.querySelector('[data-f="delete"]').click(); return 1; })()`);
  check(await until(`${W}.list("/").then((l) => !l.some((e) => e.ref === ${JSON.stringify(nbId)}))`), "a deleted notebook is dropped from the workspace");
  for (const e of errors) fails.push("page error: " + e);
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  rmSync(files, { recursive: true, force: true });
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: both pages in the workspace, ${checks} checks`);
process.exit(0);
