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
  if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true, ...(m.params.type === "prompt" ? { promptText: m.params.defaultPrompt ?? "" } : {}) });
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
  // ?recent=MODE, New board and Duplicate, in the workspace (what web/board/test-local.mjs checks for the fallback)
  await go(base + "board/?new=sage");
  await until(`/[?&]doc=local:[0-9a-f]{12}/.test(location.search) && !!${B}?.snapshot()`, 60000);
  const sageId = await ev(`location.search.match(/local:([0-9a-f]{12})/)[1]`);
  check(await until(`${W}.list("/").then((l) => l.some((e) => e.ref === ${JSON.stringify(sageId)} && e.mode === "sage"))`), "?new=sage: a Sage board of the workspace");
  await go(base + "board/?recent=sage");
  check(await until(`location.search.includes(${JSON.stringify("local:" + sageId)}) && !!${B}?.snapshot()`, 60000), "?recent=sage opens the latest Sage board of the workspace");
  const countBoards = () => ev(`${W}.list("/", { recursive: true }).then((l) => l.filter((e) => e.kind === "board").length)`);
  const before = await countBoards();
  await ev(`(() => { document.querySelector('[data-sbb="newboard"]').click(); return 1; })()`);
  check(await until(`!location.search.includes(${JSON.stringify("local:" + sageId)}) && /doc=local:[0-9a-f]{12}/.test(location.search) && !!${B}?.snapshot()`, 60000), "File > New board opens a new board");
  check((await countBoards()) === before + 1 && (await ev(`localStorage.getItem("sagebrush-board:local:" + location.search.match(/local:([0-9a-f]{12})/)[1]) === null`)), "…a board of the workspace, not of localStorage");
  check(await ev(`localStorage.getItem("sagebrush-board:local:" + location.search.match(/local:([0-9a-f]{12})/)[1] + "#here") === "1"`), "…marked as written here (its remote pictures show at once)");
  // provenance (design/capabilities.md §6): the person's own New is theirs; a board brought in from before is unknown
  const madeOfRef = (ref) => ev(`${W}.list("/", { recursive: true }).then((l) => l.find((e) => e.ref === ${ref})?.made ?? "unknown")`);
  check((await madeOfRef(`location.search.match(/local:([0-9a-f]{12})/)[1]`)) === "person", "File > New board: made by the person (provenance)");
  check((await madeOfRef(JSON.stringify(id))) === "unknown", "…a board brought in from before the workspace: unknown");
  await ev(`${B}.edit((d) => { d.title = "To copy"; }).then(() => 1)`);
  await sleep(300);
  // (Duplicate saves, then opens the copy: what follows waits for the copy's page,
  // never acting on the page that is going, or on the copy's before its workspace is
  // there, where ${W}'s optional chain would quietly give undefined)
  const toCopy = await ev(`location.search`);
  await ev(`(() => { document.querySelector('[data-sbb="duplicate"]').click(); return 1; })()`);
  check(await until(`location.search !== ${JSON.stringify(toCopy)} && !!window.sagebrush?.workspace && !!${B}?.snapshot()`, 60000), "Duplicate opens the copy");
  check(await until(`${W}.list("/").then((l) => l.some((e) => e.path === "/To copy (copy).board.json"))`, 30000), "Duplicate makes a board of the workspace: To copy (copy)");
  const markOf = (path) => ev(`${W}.stat(${JSON.stringify(path)}).then((e) => localStorage.getItem("sagebrush-board:local:" + e.ref + "#here"))`);
  check((await markOf("/To copy (copy).board.json")) === "1", "…a copy of a board written here, marked as one");
  check((await ev(`${W}.stat("/To copy (copy).board.json").then((e) => e.made)`)) === "person", "…its provenance the source's: the person's");
  // a copy is never trusted more than what it copies (CORR-30D-1): a board
  // an agent wrote, with a remote picture, isn't marked; a closed page's
  // changes to it, recovered as a board of their own, aren't either, and
  // their picture waits for a click; of a board written here, they are
  const remotePics = () => ev(`[...document.querySelectorAll("img")].filter((i) => (i.getAttribute("src") ?? "").includes("example.invalid")).length`);
  for (const [name, trusted] of [["Foreign source", false], ["Own source", true]]) {
    const ref = await ev(`(async () => {
      const original = { title: ${JSON.stringify(name)}, nodes: [{ id: "remote", text: "![remote](https://example.invalid/probe.png)" }] };
      const e = await ${W}.create(${JSON.stringify("/" + name + ".board.json")}, { content: original });
      if (${trusted}) localStorage.setItem("sagebrush-board:local:" + e.ref + "#here", "1");
      const r = await ${W}.read(e.path);
      await ${W}.write(e.path, { ...original, title: "Changed elsewhere" }, { base: r.rev });
      localStorage.setItem("sagebrush-workspace-pending:" + e.ref, "0123456789abcdef:1:1" + String.fromCharCode(10) + JSON.stringify(original));
      return e.ref;
    })()`);
    await go(base + "board/?doc=local:" + ref);
    const copy = "/" + name + " (unsaved changes from a closed page).board.json";
    check(await until(`${W}?.stat(${JSON.stringify(copy)}).then((e) => !!e)`, 60000), `${name}: a closed page's changes, recovered as a board of their own`);
    check((await markOf(copy)) === (trusted ? "1" : null), `…${trusted ? "marked, as the board written here is" : "not marked as written here: the agent's board isn't"}`);
    await go(base + "board/?doc=local:" + (await ev(`${W}.stat(${JSON.stringify(copy)}).then((e) => e.ref)`)));
    await until(`!!${B}?.snapshot()`, 60000);
    await sleep(1500);
    check((await remotePics()) === (trusted ? 1 : 0), `…opened, its remote picture ${trusted ? "shown at once" : "waits for a click"}`);
    if (!trusted) {
      // Duplicate of a board not written here: not marked either
      const from = await ev(`location.search`);
      await ev(`(() => { document.querySelector('[data-sbb="duplicate"]').click(); return 1; })()`);
      check(await until(`location.search !== ${JSON.stringify(from)} && !!window.sagebrush?.workspace && !!${B}?.snapshot()`, 60000), "…Duplicate opens the copy");
      const dup = "/" + name + " (unsaved changes from a closed page) (copy).board.json";
      check(await until(`${W}.list("/").then((l) => l.some((e) => e.path === ${JSON.stringify(dup)}))`, 30000) && (await markOf(dup)) === null, "…and its Duplicate isn't marked");
    }
  }
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

  // a save typed on the old view while a conflict is handled goes to the conflict's copy, never over the other version (CORR-0FC-1)
  await go(base + "board/?doc=local:" + id);
  await until(`${B}?.snapshot()?.doc?.title === "B by agent"`, 60000);
  const R2 = await ev(`${W}.read("/Old board.board.json").then((r) => r.rev)`);
  const pendA2 = `7777777777777777:1:${R2}\n` + JSON.stringify({ title: "A2 recovered", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(pendA2)}); 1`);
  // (the order on the workspace's lock: the agent's write B, the recovery's write A (which conflicts), then a hold
  // that lets the edit C be typed while the conflict waits on the lock to make its copy: astra's sequence exactly)
  await hold("D");
  await ev(`(() => { window.__agentP2 = ${W}.write("/Old board.board.json", { title: "B2 by agent", nodes: [] }, { base: ${R2} }); return 1; })()`);
  await ev(`(() => { window.__loadP3 = import("/board/board.js").then((m) => m.host.store.load()); return 1; })()`);
  await sleep(400);
  await ev(`(() => { navigator.locks.request("sagebrush-workspace", () => new Promise((r) => { window.__heldE = true; window.__releaseE = r; })); return 1; })()`);
  await release("D");
  check(await until(`window.__heldE === true`), "(the conflict waits on the lock to make its copy)");
  await ev(`${B}.edit((d) => { d.title = "C typed"; }).then(() => 1)`);
  await sleep(200);
  await release("E");
  await ev(`Promise.all([window.__agentP2, window.__loadP3]).then(() => 1)`);
  await sleep(1500); // (every queued save has had its turn)
  check(await ev(`${W}.read("/Old board.board.json").then((r) => r.content.title === "B2 by agent")`), "a save typed on the old view during a conflict doesn't write over the other version");
  const copyOk = await until(`${W}.read("/A2 recovered (your changes, made while it changed elsewhere).board.json").then((r) => r.content.title === "C typed").catch(() => false)`);
  const boardsNow = copyOk ? "" : await ev(`${W}.list("/").then((l) => Promise.all(l.filter((e) => e.kind === "board").map((e) => ${W}.read(e.path).then((r) => e.path + " => " + r.content.title)))).then((x) => JSON.stringify(x))`);
  check(copyOk, "…it goes into the conflict's copy " + boardsNow + " shown: " + (await ev(`${B}?.snapshot()?.doc?.title`)));
  // the conflict's copy is a board like any other: an agent's write to it is never written over (CORR-105-1)
  await go(base + "board/?doc=local:" + id);
  await until(`!!${B}?.snapshot()`, 60000);
  const R3 = await ev(`${W}.read("/Old board.board.json").then((r) => r.rev)`);
  const pendA3 = `6666666666666666:1:${R3}\n` + JSON.stringify({ title: "A3 recovered", nodes: [] });
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", ${JSON.stringify(pendA3)}); 1`);
  const copy3 = "/A3 recovered (your changes, made while it changed elsewhere).board.json";
  await hold("F");
  await ev(`(() => { window.__agentP3 = ${W}.write("/Old board.board.json", { title: "B3 by agent", nodes: [] }, { base: ${R3} }); return 1; })()`);
  await ev(`(() => { window.__loadP4 = import("/board/board.js").then((m) => m.host.store.load()); return 1; })()`);
  await sleep(400);
  await ev(`(() => { navigator.locks.request("sagebrush-workspace", () => new Promise((r) => { window.__heldG = true; window.__releaseG = r; })); return 1; })()`);
  await release("F");
  await until(`window.__heldG === true`);
  await ev(`${B}.edit((d) => { d.title = "C3 typed"; }).then(() => 1)`);
  await sleep(300);
  await ev(`(() => { window.__agentZ = ${W}.write(${JSON.stringify(copy3)}, { title: "Z on the copy", nodes: [] }, { base: 1 }).then(() => "ok", (e) => String(e)); return 1; })()`);
  await release("G");
  await ev(`Promise.all([window.__agentP3, window.__loadP4]).then(() => 1)`);
  await sleep(1500);
  check((await ev(`window.__agentZ`)) === "ok" && (await ev(`${W}.read(${JSON.stringify(copy3)}).then((r) => r.content.title)`)) === "Z on the copy", "an agent's write to the conflict's copy stays: " + (await ev(`window.__agentZ`)));
  check(await ev(`${W}.list("/").then((l) => Promise.all(l.filter((e) => e.kind === "board").map((e) => ${W}.read(e.path).then((r) => r.content.title)))).then((t) => t.includes("C3 typed (your changes, made while it changed elsewhere)"))`), "…and the page's later save goes to a new copy");
  // random interleavings of the page's saves and an agent's writes (30 fixed seeds and one random, CORR-105-2): nothing either
  // wrote last is lost, unless the other wrote after it, which CAS lets only a writer that read it do
  const rngOf = (seed) => { let r = seed; return () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648); };
  const seeds = process.env.WS_SEED ? [Number(process.env.WS_SEED)] : [...Array(30).keys()].map((k) => k + 1).concat([1000 + Math.floor(Math.random() * 100000)]);
  const lost = [];
  await go(base + "board/?doc=local:" + id);
  await until(`!!${B}?.snapshot()`, 60000);
  for (const seed of seeds) {
    const rand = rngOf(seed);
    let lastPage = null, lastAgent = null, lastAgentK = -1, lastPageK = -1;
    for (let k = 0; k < 12; k++) {
      const r = rand();
      if (r < 0.4) {
        lastPage = `s${seed} page ${k}`;
        lastPageK = k;
        await ev(`${B}.edit((d) => { d.title = ${JSON.stringify(lastPage)}; }).then(() => 1)`);
      } else if (r < 0.8) {
        const t = `s${seed} agent ${k}`;
        const ok = await ev(`${W}.read("/Old board.board.json").then((x) => ${W}.write("/Old board.board.json", { title: ${JSON.stringify(t)}, nodes: [] }, { base: x.rev })).then(() => true, () => false)`);
        if (ok) { lastAgent = t; lastAgentK = k; }
      } else {
        await hold("Z");
        await sleep(Math.floor(rand() * 200));
        await release("Z");
      }
      await sleep(Math.floor(rand() * 120));
    }
    await sleep(1200);
    const titles = await ev(`${W}.list("/").then((l) => Promise.all(l.filter((e) => e.kind === "board").map((e) => ${W}.read(e.path).then((r) => r.content.title))))`);
    const kept = (t) => titles.some((x) => x === t || x === t + " (your changes, made while it changed elsewhere)");
    // (a writer's last write may be gone only if the other wrote after it, with CAS: it read that write, or it couldn't have written)
    if (lastPage && !kept(lastPage) && !(lastAgentK > lastPageK)) lost.push(`seed ${seed}: the page's last save "${lastPage}" is in no board; log ${JSON.stringify((await ev(`window.sagebrush.saveLog?.()`)).slice(-30))}`);
    if (lastAgent && !kept(lastAgent) && !(lastPageK > lastAgentK)) lost.push(`seed ${seed}: the agent's last write "${lastAgent}" is gone`);
  }
  check(lost.length === 0, `random interleavings, seeds ${seeds.join(",")}: nothing lost` + (lost.length ? "\n    " + lost.join("\n    ") : ""));
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
  // provenance: the Welcome notebook isn't the person's; File > New is; Save a copy keeps it
  check((await ev(`${W}.list("/").then((l) => l.find((e) => e.ref === ${JSON.stringify(nbId)})?.made ?? "unknown")`)) !== "person", "the Welcome notebook a first visit makes: not made by the person");
  await ev(`(() => { document.querySelector('[data-f="new"]').click(); return 1; })()`);
  check(await until(`localStorage.getItem("sagebrush-current") !== ${JSON.stringify(nbId)}`, 15000), "(File > New notebook)");
  const newNb = await ev(`localStorage.getItem("sagebrush-current")`);
  check(await until(`${W}.list("/").then((l) => l.find((e) => e.ref === ${JSON.stringify(newNb)})?.made === "person")`), "File > New notebook: made by the person");
  await ev(`(() => { document.querySelector('[data-f="duplicate"]').click(); return 1; })()`);
  check(await until(`localStorage.getItem("sagebrush-current") !== ${JSON.stringify(newNb)}`, 15000), "(Save a copy)");
  const copyNb = await ev(`localStorage.getItem("sagebrush-current")`);
  check(await until(`${W}.list("/").then((l) => l.find((e) => e.ref === ${JSON.stringify(copyNb)})?.made === "person")`), "…Save a copy: the source's provenance");
  await ev(`(async () => { await sagebrush.notebook.saved?.(); return 1; })()`).catch(() => {});
  await go(base + "?nb=" + encodeURIComponent(nbId));
  check(await until(`!!window.sagebrush?.notebook && !!${W} && localStorage.getItem("sagebrush-current") === ${JSON.stringify(nbId)}`, 60000), "(back on the notebook the rest of this test uses)");
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
  // after a reload, the interpreter is given the files kept beside the index (capabilities §2b: the
  // notebook page reads them through the workspace, wherever each is kept)
  await go(base);
  check(await until(`!!window.sagebrush?.notebook && !!${W} && /^ready/.test(document.querySelector("#status")?.textContent ?? "")`, 60000), "(the notebook page reloaded, its interpreter ready)");
  check(await ev(`${W}.stat("/py.txt").then((e) => e?.migrated === true)`), "(Python's file is kept beside the index)");
  await runPy('print("READ:" + open("/py.txt").read())');
  const readOk = await until(`sagebrush.notebook.cells().some((c) => c.type === "code" && /READ:two/.test(c.el?.innerText ?? ""))`, 30000);
  const readDiag = readOk ? "" : await ev(`(async () => JSON.stringify({ out: sagebrush.notebook.cells().filter((c) => c.type === "code").map((c) => (c.el?.innerText ?? "").slice(0, 300)), status: document.querySelector("#status")?.textContent, errs: ${JSON.stringify(errors.slice(-3))}, stat: await ${W}.stat("/py.txt") }))()`).catch((e) => String(e));
  check(readOk, "a new interpreter reads it: its bytes given from the workspace " + readDiag);

  // deleting the notebook drops it from the list
  await ev(`(() => { document.querySelector('[data-f="delete"]').click(); return 1; })()`);
  check(await until(`${W}.list("/").then((l) => !l.some((e) => e.ref === ${JSON.stringify(nbId)}))`), "a deleted notebook is dropped from the workspace");
  // a newer Sagebrush page upgrading the workspace's database: this page and a board page in another
  // tab both lose it, and both say so, with Reload (capabilities step 1; last: nothing opens it after)
  const tU = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base + "board/")}`, { method: "PUT" })).json();
  const wsU = new WebSocket(tU.webSocketDebuggerUrl);
  await new Promise((r) => (wsU.onopen = r));
  let nU = 0; const waitingU = new Map();
  wsU.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waitingU.has(d.id)) { waitingU.get(d.id)(d.result ?? d.error); waitingU.delete(d.id); } };
  const evU = async (expression) => { const id = ++nU; const r = await new Promise((ok) => { waitingU.set(id, ok); wsU.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); }); return r?.result?.value; };
  for (let i = 0; i < 600 && !(await evU(`!!window.sagebrush?.workspace`).catch(() => false)); i++) await sleep(100);
  check(await evU(`!!window.sagebrush?.workspace`), "(a board page open in another tab, with the workspace)");
  await ev(`new Promise((ok, no) => { const r = indexedDB.open("sagebrush-workspace", 99); r.onsuccess = () => { r.result.close(); ok(1); }; r.onerror = () => no(r.error); r.onblocked = () => no(new Error("blocked")); })`);
  const notice = `(() => { const b = document.getElementById("sagebrush-reload-notice"); return !!b && /updated in another tab/.test(b.textContent) && [...b.querySelectorAll("button")].some((x) => x.textContent === "Reload"); })()`;
  check(await until(notice, 10000), "the workspace upgraded by a newer page: the notebook page says so, with Reload");
  let boardSays = false;
  for (let i = 0; i < 100 && !(boardSays = await evU(notice).catch(() => false)); i++) await sleep(100);
  check(boardSays, "…and so does the board page in the other tab");
  check(/reload/.test(await ev(`${W}.read("/py.txt").then(() => "", (e) => String(e.message))`)), "…reading the files then says to reload");
  wsU.close();
  await send("Target.closeTarget", { targetId: tU.id });
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
