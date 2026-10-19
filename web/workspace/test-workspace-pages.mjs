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
  await ev(`localStorage.setItem("sagebrush-workspace-pending:${id}", JSON.stringify({ title: "Pending", nodes: [] })); true`);
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
