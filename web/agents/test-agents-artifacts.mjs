// Notebook and LaTeX artifacts in the agents chat (web/agents; the artifacts plan r2 + r2.1), end to end in headless
// Chromium: the built page (dist/agents, SAGEBRUSH_AGENTS=1), served cross-origin isolated by web/serve.py on a
// loopback port, paired as a person pairs it (a ?pair= link, Connect, the grant dialog) with a stand-in for
// sagebrush-agent on another loopback port: a WebSocket server that speaks the protocol (design/
// workspace-agent-protocol.md) and writes files with the workspace verbs, as the daemon's tools do. Nothing on the
// page's side is mocked: the real notebook component (sagebrush-notebook.js), its kernel worker
// (sagebrush-worker.js) and the workspace in IndexedDB. "Saved" is read back through Workspace.read (the agent's
// workspace.read) and the store's record; "reopen" is a fresh page load.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-artifacts.mjs
//   (AGENTS_LATEX=1: the build has the LaTeX editor, SAGEBRUSH_LATEX_PREVIEW=test; ONLY=a,b: those sections)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const LATEX = process.env.AGENTS_LATEX === "1";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const want = (s) => !ONLY || ONLY.has(s);
let failures = 0;
const ok = (c, msg, detail) => {
  // (a check's detail: on a failure, or always with DETAIL=1)
  console.log((c ? "ok   " : "FAIL ") + msg + ((!c || process.env.DETAIL) && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : ""));
  if (!c) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the site, cross-origin isolated as the preview host serves it
let server;
const sitePort = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const site = `http://127.0.0.1:${sitePort}`;

// ---- the agent: a stand-in for sagebrush-agent (its hello, its calls, its turn events)
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
let sock = null, nextId = 1, picHits = 0;
// (whether the stand-in says it edits notebooks by cell, notebook.edit: the A12 section pairs again with it)
let FEATURES = false;
const pending = new Map(), notes = [];
const daemon = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === "/sagebrush" && srv.upgrade(req)) return;
    if (u.pathname === "/pic.png") {
      picHits++;
      return new Response(PNG, { headers: { "content-type": "image/png", "cross-origin-resource-policy": "cross-origin" } });
    }
    return new Response("not here", { status: 404 });
  },
  websocket: {
    message(ws, data) {
      const m = JSON.parse(String(data));
      if (m.method === "hello") {
        sock = ws;
        // (it asks for run too: the page's grant must say run false whatever it asks)
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocol: 1, agent: { name: "Claude", client: "claude-agent-sdk", version: "0.3.0" }, wants: { folders: ["/"], write: true, run: true }, ...(FEATURES ? { features: ["notebook.edit"] } : {}) } }));
      } else if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.no(Object.assign(new Error(m.error.message), { code: m.error.data?.code }));
        else p.ok(m.result);
      } else if (m.method) notes.push(m);
    },
    close(ws) {
      if (sock === ws) sock = null;
    },
  },
});
const call = (method, params) =>
  new Promise((ok_, no) => {
    if (!sock) return no(new Error("no page paired"));
    const id = "s" + nextId++;
    pending.set(id, { ok: ok_, no });
    sock.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
let conv = null, turnN = 0;
const event = (turn_id, e) => sock.send(JSON.stringify({ jsonrpc: "2.0", method: "turn.event", params: { conversation: conv, turn_id, event: e } }));
/** A turn of the agent's that shows a file as an artifact (its tool wrote the file first, as the daemon's does). */
async function artifactTurn(path, { finish = true, turn = null } = {}) {
  const t = turn ?? `t${++turnN}`;
  if (!turn) event(t, { type: "turn_started" });
  const nb = /\.ipynb$/.test(path);
  event(t, { type: "artifact", id: path, kind: nb ? "notebook" : "code", lang: nb ? undefined : path.split(".").pop(), title: path.split("/").pop(), path, body: nb ? "notebook" : "" });
  if (finish) event(t, { type: "turn_finished", outcome: "completed" });
  return t;
}
// (each document's cell ids are its own, so its record is found by them: the agent is never told a document's ref)
const tagOf = (s) => "k" + [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16);
const nbDoc = (cells, extra = {}, tag = "c") => ({ json: { mode: "python", ...extra, cells: cells.map((c, i) => ({ id: `${tag}${i}`, type: c.type ?? "code", code: c.code })) } });
const docFor = (path, cells, extra, salt = "") => nbDoc(cells, extra, tagOf(path + salt));
const write = async (path, cells, extra) => {
  const r = await call("workspace.read", { path });
  return call("workspace.write", { path, content: docFor(path, cells, extra), base: r.rev });
};
const readCells = async (path) => (await call("workspace.read", { path })).content.json.cells;
// (the hash an edit by cell names a cell by, as the helper computes it: web/workspace/notebook-edit.ts cellHash)
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v) ?? "null";
// (in the form the notebook keeps a cell: web/workspace/notebook-edit.ts cellForm)
const cellForm = (c) => {
  const type = c?.type ?? "code";
  const out = { id: c?.id, ...(type === "code" ? {} : { type }), code: c?.code ?? "" };
  if (type === "code") { out.outputs = Array.isArray(c?.outputs) ? c.outputs : []; out.n = c?.n == null ? null : String(c.n); if (c?.ms != null) out.ms = c.ms; }
  if (type === "markdown" && c?.attachments) out.attachments = c.attachments;
  if (c?.metadata) out.metadata = c.metadata;
  return out;
};
const cellHash = (c) => createHash("sha256").update(canonical(cellForm(c)), "utf8").digest("hex");

// ---- the browser
const profile = mkdtempSync(join(tmpdir(), "sb-agents-art-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
const cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    break;
  } catch {
    await sleep(100);
  }
}
const cdp = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (cdp.onopen = r));
let n = 0;
const waiting = new Map();
const requested = []; // (every URL the page or its workers asked for)
const workers = []; // (every worker started: its URL)
const liveWorkers = new Map(); // (the workers running now: session -> URL)
const paused = []; // (requests held by Fetch: their ids)
const logs = []; // (the page's errors and warnings: shown when something fails)
cdp.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m.result ?? m.error);
    waiting.delete(m.id);
  } else if (m.method === "Network.requestWillBeSent") requested.push(m.params.request.url);
  else if (m.method === "Target.detachedFromTarget") liveWorkers.delete(m.params.sessionId);
  else if (m.method === "Fetch.requestPaused") paused.push(m.params.requestId);
  else if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") {
    workers.push(m.params.targetInfo.url);
    liveWorkers.set(m.params.sessionId, m.params.targetInfo.url);
    cdp.send(JSON.stringify({ id: ++n, sessionId: m.params.sessionId, method: "Runtime.enable" }));
  }
  else if (m.method === "Runtime.exceptionThrown") logs.push("exception: " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
  else if (m.method === "Runtime.consoleAPICalled" && /error|warn/.test(m.params.type)) logs.push(m.params.type + ": " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++n;
    waiting.set(id, r);
    cdp.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result?.value;
};
const until = async (expr, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(100);
  }
  throw new Error("timeout: " + expr);
};
const key = (k, extra = {}) => send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: { Escape: 27, Tab: 9 }[k] ?? 0, ...extra }).then(() => send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: { Escape: 27, Tab: 9 }[k] ?? 0 }));
const size = (width, height = 900) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true }); // (every module fetched again by a fresh page: hold() sees it)
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await send("Page.enable");
await send("Runtime.enable");
await size(1280);

// The page's IndexedDB, read and written beside the page (as another tab of the same site would): the notebooks'
// store and its fence (notebook/stores.js FENCE).
const IDB = `(window.__t ??= (() => {
  const open = () => new Promise((ok, no) => { const r = indexedDB.open("sagebrush"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const tx = async (mode, f) => { const db = await open(); try { return await new Promise((ok, no) => { const t = db.transaction("notebooks", mode), st = t.objectStore("notebooks"); let out; f(st, (v) => (out = v)); t.oncomplete = () => ok(out); t.onerror = () => no(t.error); t.onabort = () => no(t.error); }); } finally { db.close(); } };
  return { get: (k) => tx("readonly", (st, set) => { const r = st.get(k); r.onsuccess = () => set(r.result); }), put: (v) => tx("readwrite", (st) => st.put(v)),
    byCell: (id) => tx("readonly", (st, set) => { const r = st.getAll(); r.onsuccess = () => set(r.result.find((x) => x?.cells?.[0]?.id === id)?.id); }) };
})())`;
const FENCE = "__sagebrush-workspace__";
const record = (ref) => ev(`${IDB}.get(${JSON.stringify(ref)})`);
const putRecord = (rec) => ev(`${IDB}.put(${JSON.stringify(rec)})`);
const refOf = (path, salt = "") => ev(`${IDB}.byCell(${JSON.stringify(tagOf(path + salt) + "0")})`);

const PANE = "#artifacts .pane-host:not([hidden])";
const cellJs = (i) => `document.querySelectorAll('${PANE} .nb-root .cell')[${i}]`;
const shown = () => ev(`[...document.querySelectorAll('${PANE} .nb-root .cell textarea')].map((t) => t.value)`);
const outs = () => ev(`[...document.querySelectorAll('#artifacts .nb-root .cell .out')].map((o) => o.textContent).join('|')`);
const savedText = () => ev(`document.querySelector('${PANE} .saved')?.textContent ?? ''`);
const barText = () => ev(`(() => { const b = document.querySelector('#artifacts .pane-bar'); return b && !b.hidden ? b.className + ': ' + b.textContent : ''; })()`);
async function typeInto(i, text) {
  await ev(`(() => { const t = ${cellJs(i)}.querySelector('textarea'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
  await send("Input.insertText", { text });
}
/** Hold the next request for `name` (a module the page imports) until resume(): a mount paused at that await. */
let heldFrom = 0;
async function hold(name) {
  paused.length = 0;
  heldFrom = requested.length;
  await send("Fetch.enable", { patterns: [{ urlPattern: `*/${name}*`, requestStage: "Request" }] });
}
async function untilHeld(ms = 15000) {
  const t = Date.now();
  while (!paused.length && Date.now() - t < ms) await sleep(50);
  if (!paused.length) throw new Error("nothing was held; asked since: " + JSON.stringify(requested.slice(heldFrom).map((u) => new URL(u).pathname)) + " pane: " + JSON.stringify(await ev(`document.querySelector('#artifacts')?.textContent.slice(0, 200)`)));
}
async function resume() {
  for (const id of paused.splice(0)) await send("Fetch.continueRequest", { requestId: id });
  await send("Fetch.disable");
}
/** Another tab's exclusive hold on the workspace (navigator.locks): every save and create waits until window.__release(). */
async function lockWorkspace() {
  await ev(`(() => { window.__release = null; navigator.locks.request("sagebrush-workspace", { mode: "exclusive" }, () => new Promise((r) => (window.__release = r))); return true; })()`);
  await until(`typeof window.__release === "function"`);
}
/** Another tab's long readwrite transaction on the notebooks' store, for `ms`: the pane's reads and writes of
 * notebooks wait for it. */
const holdStore = (ms) => ev(`(() => { const r = indexedDB.open("sagebrush"); r.onsuccess = () => { const db = r.result, t = db.transaction("notebooks", "readwrite"), st = t.objectStore("notebooks"), end = Date.now() + ${ms}; const spin = () => { if (Date.now() < end) st.get("__hold__").onsuccess = spin; }; spin(); t.oncomplete = () => db.close(); }; return true; })()`);
/** In a host whose close failed (BAC-8): is its content readable (not inert), selectable, and is Ctrl+C let through,
 * while typing changes nothing? `sel` is its text box. */
async function readableKept(sel) {
  await ev(`(() => { window.__copy = "never"; document.addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "c") window.__copy = e.defaultPrevented ? "prevented" : "let through"; }); return true; })()`);
  const before = await ev(`document.querySelector(${JSON.stringify(sel)})?.value ?? null`);
  const r = await ev(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); if (!t) return null; let el = t, inert = false; while (el) { if (el.inert) inert = true; el = el.parentElement; } t.focus(); t.select(); return { inert, focused: document.activeElement === t, selected: t.selectionEnd - t.selectionStart }; })()`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 2 });
  await ev(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); t?.setSelectionRange(t.value.length, t.value.length); })()`);
  await send("Input.insertText", { text: " # typed" });
  const after = await ev(`document.querySelector(${JSON.stringify(sel)})?.value ?? null`);
  return { ...r, copy: await ev(`window.__copy`), unchanged: before === after };
}
/** Press the bar's "Download a copy" and return the file it downloads ({name, text}), its <a download> caught. */
async function downloadCopy() {
  await ev(`(() => { window.__dl = null; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl = { name: this.download, href: this.href }; return; } return click.call(this); }; return true; })()`);
  await ev(`[...document.querySelectorAll('#artifacts .pane-bar button')].find((b) => b.textContent === 'Download a copy')?.click()`);
  return ev(`(async () => window.__dl ? { name: window.__dl.name, text: await (await fetch(window.__dl.href)).text() } : null)()`);
}
/** Try to change and run a frozen notebook's first cell, as a person would: typing, its Run button, Shift+Enter. */
async function poke(i, text) {
  await ev(`(() => { const t = ${cellJs(i)}?.querySelector('textarea'); t?.focus(); t?.setSelectionRange(t.value.length, t.value.length); })()`);
  await send("Input.insertText", { text });
  await ev(`${cellJs(i)}?.querySelector('.runb')?.click()`);
  await key("Enter", { modifiers: 8, windowsVirtualKeyCode: 13 });
}
const live = (name) => [...liveWorkers.values()].filter((u) => u.includes(name)).length;
const tabJs = (path) => `document.querySelector('#artifacts .tab[data-tab="${path}"]')`;
const workerCount = () => workers.filter((u) => u.includes("sagebrush-worker.js")).length;
const loaded = (name) => requested.some((u) => new URL(u).pathname.endsWith("/" + name));

/** Open the page with a pairing link, connect, and allow everything (the person's grant dialog). */
async function pair() {
  await send("Page.navigate", { url: `${site}/agents/?pair=123-456&port=${daemon.port}` });
  await until(`[...document.querySelectorAll('button')].some((b) => b.textContent === 'Connect' && b.offsetParent)`);
  await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Connect' && b.offsetParent).click()`);
  await until(`[...document.querySelectorAll('button')].some((b) => b.textContent === 'Allow' && b.offsetParent)`);
  await ev(`(() => { const all = [...document.querySelectorAll('label')].find((l) => l.textContent.startsWith('Everything')).querySelector('input'); all.checked = true; all.dispatchEvent(new Event('change')); [...document.querySelectorAll('button')].find((b) => b.textContent === 'Allow').click(); })()`);
  const t = Date.now();
  while (!notes.some((m) => m.method === "grant.changed") && Date.now() - t < 10000) await sleep(50);
  await until(`document.querySelector('#connect').textContent === 'Connected'`);
}
/** A fresh page with nothing of the notebook loaded: an empty chat is made current first (a reload reopens the
 * current chat's last artifact), then the page is loaded and paired again. */
async function freshPage() {
  await ev(`document.querySelector('#new')?.click()`);
  await sleep(700); // (the chats are saved 300 ms after a change)
  await pair();
  await converse();
}
/** The conversation: the page's current thread, as its first message says it. */
async function converse() {
  notes.length = 0;
  // (a new chat, whose first message is one of the suggestions)
  await ev(`document.querySelector('#new').click()`);
  await until(`!!document.querySelector('[data-try]')?.offsetParent`);
  await ev(`document.querySelector('[data-try]').click()`);
  const t = Date.now();
  while (!notes.some((m) => m.method === "chat.message") && Date.now() - t < 5000) await sleep(50);
  conv = notes.find((m) => m.method === "chat.message")?.params.conversation ?? conv;
  if (!conv) throw new Error("no chat.message from the page");
  // (that message's turn ends: the agent answers nothing more)
  const t2 = `t${++turnN}`;
  event(t2, { type: "turn_started" });
  event(t2, { type: "turn_finished", outcome: "completed" });
}
async function openNotebook(path, o = {}) {
  await artifactTurn(path, o);
  // (this notebook's host, shown: its path heads it)
  await until(`document.querySelector('${PANE} .file-path')?.textContent.startsWith(${JSON.stringify(path + " ")}) && document.querySelectorAll('${PANE} .nb-root .cell').length > 0 && !!document.querySelector('${PANE} .saved')?.textContent`, 30000);
}

try {
  // ======================================================================== the page, paired; lazy loading
  await pair();
  const grant = notes.find((m) => m.method === "grant.changed")?.params;
  ok(grant && grant.run === false && grant.write === true, "the grant says run false although the agent asked for run (only the person runs code)", grant);
  ok(await ev("crossOriginIsolated"), "the page is cross-origin isolated (COOP/COEP from web/_headers)");
  await call("workspace.mkdir", { path: "/notes" });
  await converse();
  ok(!loaded("sagebrush-notebook.js") && !loaded("sagebrush-worker.js") && workerCount() === 0, "nothing of the notebook is loaded before a notebook opens", requested.filter((u) => /sagebrush-/.test(u)));
  {
    const r = await call("workspace.run", { path: "/notes" }).then(() => "answered", (e) => e.code ?? e.message);
    ok(r !== "answered", "the page has no run verb for the agent", r);
  }

  // ======================================================================== opening runs nothing
  if (want("open")) {
    // (a document asking to autorun: only a reactive notebook would; the pane's isn't)
    await call("workspace.create", { path: "/notes/plot.ipynb", content: docFor("/notes/plot.ipynb", [{ code: "x = 1" }, { code: "print('OLD')" }, { type: "markdown", code: "Some *text*" }], { autorun: "always" }), mode: "python" });
    const rec0 = await record(await refOf("/notes/plot.ipynb"));
    ok(rec0?.autorun === "always", "the document says autorun: always", rec0 && Object.keys(rec0));
    await openNotebook("/notes/plot.ipynb");
    ok(loaded("sagebrush-notebook.js"), "the notebook component is loaded when the notebook opens");
    await sleep(2500);
    const o = await outs();
    ok(workerCount() === 0 && !/OLD/.test(o), "opening runs nothing: no kernel worker, no output", { workers, o });
    ok((await shown()).join("|") === "x = 1|print('OLD')|Some *text*", "the cells are shown as written", await shown());
    ok(await ev(`!!document.querySelector('${PANE} .nb-notice') && /Runs here when you click Run/.test(document.querySelector('${PANE} .nb-notice').textContent)`), "the run notice is shown beside the notebook");
    ok(await ev(`document.body.classList.contains('wide-artifact')`), "a notebook gets the wide pane");
    ok(await ev(`document.activeElement?.closest('#artifacts') === null`), "the artifact the agent opened didn't take the focus");

    // ---- written by the agent: the label, and when it goes
    const marks = await ev(`[...document.querySelectorAll('${PANE} .nb-agent-mark')].map((m) => [m.textContent, m.id, document.querySelector('[aria-describedby~="' + m.id + '"]') !== null])`);
    ok(marks.length === 3 && marks.every(([t, , d]) => t === "Written by Claude" && d), "each cell the agent wrote says so (Written by Claude), in its accessible description", marks);
    // (BAC-1) the label above the cell, across its gutter and code: the code keeps the cell's width
    const widths = await ev(`(() => { const c = ${cellJs(1)}; return { label: c.querySelector('.nb-agent-mark').getBoundingClientRect().width, code: c.querySelector('textarea').getBoundingClientRect().width, cell: c.getBoundingClientRect().width }; })()`);
    ok(widths.code > 0.6 * widths.cell && widths.label > 0.8 * widths.cell, "a cell with the written-by label keeps its code at the cell's width (the label spans the cell)", widths);
    await typeInto(0, "  # mine");
    const afterEdit = await ev(`[...${cellJs(0)}.querySelectorAll('.nb-agent-mark')].length`);
    ok(afterEdit === 0, "the label goes when the person edits that cell", afterEdit);

    // ---- the first Run: lazy, and it runs the code the cell had at the click (the agent's write meanwhile doesn't)
    const rev0 = (await call("workspace.read", { path: "/notes/plot.ipynb" })).rev;
    const wBefore = workerCount();
    await ev(`${cellJs(1)}.querySelector('.runb').click()`);
    await call("workspace.write", { path: "/notes/plot.ipynb", content: docFor("/notes/plot.ipynb", [{ code: "x = 1" }, { code: "print('NEW')" }, { type: "markdown", code: "Some *text*" }]), base: rev0 }).catch((e) => e);
    await until(`/OLD|NEW/.test([...document.querySelectorAll('${PANE} .cell .out')].map((o) => o.textContent).join())`, 120000);
    const o1 = await outs();
    ok(/OLD/.test(o1) && !/NEW/.test(o1), "the run executes the cell's code at the click, not the agent's write that landed while the kernel started", o1);
    ok(wBefore === 0 && workerCount() === 1, "the kernel worker starts on the first Run, not before", { wBefore, workers });
    ok((await ev(`[...${cellJs(1)}.querySelectorAll('.nb-agent-mark')].length`)) === 0, "the label goes when the cell runs");
    ok(await ev(`document.querySelector('#stop').textContent === 'Stop Claude'`), "the chat's Stop is named after the agent");

    // ---- an incoming change runs nothing
    await sleep(500);
    await write("/notes/plot.ipynb", [{ code: "x = 1" }, { code: "print('AGENT-RAN', x)" }, { type: "markdown", code: "Some *text*" }], { autorun: "always" });
    await until(`[...document.querySelectorAll('${PANE} .cell textarea')].some((t) => t.value.includes('AGENT-RAN'))`, 10000).catch(() => {});
    await sleep(2500);
    const o2 = await outs();
    ok((await shown()).some((v) => v.includes("AGENT-RAN")) && !/AGENT-RAN/.test(o2), "the agent's change is shown, and runs nothing (no applyEdits, no autorun)", { o2, cells: await shown() });
    // ---- a Run runs that cell only. The person runs x = 1 and the agent's cell (it reads x: AGENT-RAN 1), then changes x and runs
    // that cell alone: the agent's cell isn't rerun with it (the reactive notebook's autorun would rerun it, a stale
    // descendant: notebook.js 843; a cell changed and not yet run is never autorun, so this is the case it would run)
    const nA = await ev(`${cellJs(0)}.querySelector('.n').textContent`);
    await ev(`${cellJs(0)}.querySelector('.runb').click()`);
    await until(`${cellJs(0)}.querySelector('.n').textContent !== ${JSON.stringify(nA)}`, 60000);
    await ev(`${cellJs(1)}.querySelector('.runb').click()`);
    await until(`/AGENT-RAN 1/.test(${cellJs(1)}.querySelector('.out').textContent)`, 60000);
    await ev(`(() => { const t = ${cellJs(0)}.querySelector('textarea'); t.focus(); t.select(); })()`);
    await send("Input.insertText", { text: "x = 2" });
    const n0 = await ev(`${cellJs(0)}.querySelector('.n').textContent`);
    await ev(`${cellJs(0)}.querySelector('.runb').click()`);
    await until(`${cellJs(0)}.querySelector('.n').textContent !== ${JSON.stringify(n0)} && /\\[\\d+\\]/.test(${cellJs(0)}.querySelector('.n').textContent)`, 60000);
    await sleep(2500);
    const o3 = await ev(`${cellJs(1)}.querySelector('.out').textContent`);
    const states = await ev(`[...document.querySelectorAll('${PANE} .cell')].map((c) => c.className + ' ' + c.querySelector('.n')?.textContent + ' ' + (c.querySelector('.time')?.textContent ?? ''))`);
    ok(/AGENT-RAN 1/.test(o3) && !/AGENT-RAN 2/.test(o3), "the person's Run runs that cell only: the agent's cell that reads it isn't rerun with it (no autorun)", { o3, states });
  }

  // ======================================================================== saved, with its base; reopened
  if (want("save")) {
    const path = "/notes/save.ipynb";
    await call("workspace.create", { path, content: docFor(path, [{ code: "a = 1" }, { code: "print(41 + 1)" }, { code: "b = 2" }]), mode: "python" });
    await openNotebook(path);
    await ev(`${cellJs(1)}.querySelector('.runb').click()`);
    await until(`/42/.test(${cellJs(1)}.querySelector('.out')?.textContent ?? '')`, 120000);
    await typeInto(0, "  # edited");
    await until(`document.querySelector('${PANE} .saved')?.textContent === 'Saved'`, 5000).catch(() => {});
    await sleep(800);
    const r = await call("workspace.read", { path });
    const c = r.content.json.cells;
    ok(c[0].code === "a = 1  # edited" && JSON.stringify(c[1].outputs ?? []).includes("42"), "the person's edit and the output are saved (read back through Workspace.read)", c);
    // a change made since the pane's revision, which the pane hasn't seen (written beside the page, told to no one)
    const ref = await refOf(path);
    const rec = await record(ref);
    await putRecord({ ...rec, rev: rec.rev + 1, cells: rec.cells.map((x, i) => (i === 2 ? { ...x, code: "b = 2  # theirs" } : x)) });
    await typeInto(0, " again");
    await sleep(2000);
    const after = await record(ref);
    const codes = after.cells.map((x) => x.code);
    ok(codes[0] === "a = 1  # edited again" && codes[2] === "b = 2  # theirs", "a save never goes over a change made since its base: both are kept (the store's compare and swap)", codes);
    // reopen: a fresh load
    await send("Page.reload", { ignoreCache: true });
    await until(`document.querySelectorAll('${PANE} .nb-root .cell').length === 3`, 30000);
    const again = await shown();
    ok(again[0] === "a = 1  # edited again" && again[2] === "b = 2  # theirs" && /42/.test(await outs()), "a fresh load reopens the notebook as saved, its output too", { again, o: await outs() });
    await pair();
    await converse();
  }

  // ======================================================================== a forged `here`: remote pictures wait for a click
  if (want("here")) {
    const path = "/notes/pics.ipynb";
    const pic = `http://127.0.0.1:${daemon.port}/pic.png`;
    await call("workspace.create", { path, content: docFor(path, [{ type: "markdown", code: `![a picture](${pic})` }]), mode: "python" });
    const ref = await refOf(path);
    await putRecord({ ...(await record(ref)), here: true });
    ok((await record(ref)).here === true, "the document claims here: true (forged)");
    picHits = 0;
    await openNotebook(path);
    await sleep(2500);
    ok(picHits === 0 && !requested.includes(pic), "opening it fetches no remote picture: the pane's notebook loads them only on a click", { picHits });
  }

  // ======================================================================== Escape inside the notebook is the notebook's
  if (want("escape")) {
    const path = "/notes/esc.ipynb";
    await call("workspace.create", { path, content: docFor(path, [{ code: "1 + 1" }]), mode: "python" });
    // (a turn running, as the person's message started it, that opens the notebook: Escape outside the pane would
    // interrupt it)
    notes.length = 0;
    await ev(`document.querySelector('#new').click()`);
    await until(`!!document.querySelector('[data-try]')?.offsetParent`);
    await ev(`document.querySelector('[data-try]').click()`);
    const t0 = Date.now();
    while (!notes.some((m) => m.method === "chat.message") && Date.now() - t0 < 5000) await sleep(50);
    conv = notes.find((m) => m.method === "chat.message").params.conversation;
    const t = `t${++turnN}`;
    event(t, { type: "turn_started" });
    await openNotebook(path, { finish: false, turn: t });
    await ev(`document.querySelector('#full').click()`);
    await until(`document.querySelector('#stop') && !document.querySelector('#stop').hidden`);
    notes.length = 0;
    await ev(`${cellJs(0)}.querySelector('textarea').focus()`);
    await key("Escape");
    await sleep(400);
    ok((await ev(`document.body.classList.contains('fullscreen')`)) && !notes.some((m) => m.method === "chat.interrupt"), "Escape in a cell neither leaves full screen nor interrupts the agent", notes.map((m) => m.method));
    // (BAC-5) the notebook's shortcuts dialog (h in command mode), on the document body: its Escape is its own
    await ev(`${cellJs(0)}.querySelector('textarea').focus()`);
    await key("Escape");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "h", code: "KeyH", text: "h", windowsVirtualKeyCode: 72 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "h", code: "KeyH", windowsVirtualKeyCode: 72 });
    const keysOpen = await until(`[...document.querySelectorAll('dialog.sbnb-keys')].some((d) => d.open)`, 3000).then(() => true, () => false);
    notes.length = 0;
    await key("Escape");
    await sleep(400);
    const afterKeys = await ev(`({ full: document.body.classList.contains('fullscreen'), open: [...document.querySelectorAll('dialog.sbnb-keys')].some((d) => d.open) })`);
    ok(keysOpen && afterKeys.full && !afterKeys.open && !notes.some((m) => m.method === "chat.interrupt"), "Escape in the notebook's shortcuts dialog closes it, and neither leaves full screen nor interrupts the agent", { keysOpen, afterKeys, notes: notes.map((m) => m.method) });
    await ev(`document.querySelector('#artifacts .tab').focus()`);
    await key("Escape");
    await sleep(300);
    ok(!(await ev(`document.body.classList.contains('fullscreen')`)), "Escape from the pane's own tabs still leaves full screen");
    // (BAC-6) Enter on full screen: the button keeps the focus though the pane's head is redrawn
    await ev(`document.querySelector('#full').focus()`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await sleep(300);
    const fsFocus = await ev(`({ full: document.body.classList.contains('fullscreen'), focus: document.activeElement?.id || document.activeElement?.tagName })`);
    ok(fsFocus.full && fsFocus.focus === "full", "Enter on the full-screen button: full screen, and the focus stays on that button", fsFocus);
    await ev(`document.querySelector('#full').click()`);
    event(t, { type: "turn_finished", outcome: "completed" });
  }

  // ======================================================================== the popups above the pane
  if (want("popups")) {
    const path = "/notes/pop.ipynb";
    await call("workspace.create", { path, content: docFor(path, [{ code: "x = 1" }]), mode: "python" });
    await openNotebook(path);
    // (the completer asks the kernel: a run first)
    await ev(`${cellJs(0)}.querySelector('.runb').click()`);
    await until(`/\\[\\d+\\]/.test(${cellJs(0)}.querySelector('.n').textContent)`, 120000);
    const hit = (cls) => `(() => { const p = [...document.querySelectorAll('.${cls}')].find((x) => !x.hidden); if (!p) return 'not open'; const r = p.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 10)); return p.contains(e) ? 'hit' : 'under ' + (e?.closest('#artifacts') ? '#artifacts' : e?.tagName); })()`;
    for (const [w, full] of [[1280, true], [800, false]]) {
      await size(w);
      const isFull = await ev(`document.body.classList.contains('fullscreen')`);
      if (isFull !== full) await ev(`document.querySelector('#full').click()`);
      await sleep(300);
      await ev(`${cellJs(0)}.querySelector('[data-a="menu"]').click()`);
      await sleep(200);
      const menu = await ev(hit("sbnb-menu"));
      await ev(`${cellJs(0)}.querySelector('[data-a="menu"]').click()`); // (closed again)
      await ev(`(() => { const t = ${cellJs(0)}.querySelector('textarea'); t.focus(); t.value = 'pr'; t.dispatchEvent(new Event('input', { bubbles: true })); t.setSelectionRange(2, 2); })()`);
      await key("Tab");
      await until(`[...document.querySelectorAll('.sbnb-completer')].some((x) => !x.hidden)`, 10000).catch(() => {});
      const comp = await ev(hit("sbnb-completer"));
      await key("Escape");
      ok(menu === "hit" && comp === "hit", `the cell menu and the completer are above the pane (${full ? "full screen, 1280 px" : "the pane, 800 px"})`, { menu, comp });
    }
    await size(1280);
    if (await ev(`document.body.classList.contains('fullscreen')`)) await ev(`document.querySelector('#full').click()`);
  }

  // ======================================================================== the compact layout: by the pane's width, and the page's
  if (want("layout")) {
    const path = "/notes/layout.ipynb";
    await call("workspace.create", { path, content: docFor(path, [{ code: "y = 2" }]), mode: "python" });
    await openNotebook(path);
    await size(1600);
    await sleep(300);
    const gutter = () => ev(`[document.querySelector('${PANE} .nb-root').clientWidth, getComputedStyle(document.querySelector('${PANE} .sbnb')).getPropertyValue('--gutter').trim()]`);
    const wide = await gutter();
    ok(wide[0] > 640 && wide[1] !== "44px", "the pane at its width (1600 px window) has the full layout", wide);
    // (BAC-3) the chat beside a notebook keeps at least 420 px; (BAC-2) at 800 px the pane covers the page
    const chatAt = async (w) => (await size(w), await sleep(300), ev(`({ chat: document.querySelector('main').getBoundingClientRect().width, pane: document.querySelector('#artifacts').getBoundingClientRect().width, vw: innerWidth })`));
    const at1280 = await chatAt(1280), at1100 = await chatAt(1100), at800 = await chatAt(800);
    await size(1280);
    ok(at1280.chat >= 420 && at1100.chat >= 420, "beside a notebook the chat keeps at least 420 px (1280 and 1100 px windows)", { at1280, at1100 });
    ok(at800.pane === at800.vw, "at 800 px a notebook's pane covers the page", at800);
    await sleep(300);
    await ev(`document.head.append(Object.assign(document.createElement('style'), { id: 'narrow', textContent: 'body.has-artifact.wide-artifact #artifacts { width: 589px !important; }' }))`);
    await sleep(300);
    const narrow = await gutter();
    ok(narrow[0] <= 640 && narrow[1] === "44px", "the pane at 589 px in a 1280 px window gets the compact layout (@container sbnb-pane)", narrow);
    await ev(`document.getElementById('narrow').remove()`);
    // the notebook page itself, at a 600 px viewport: compact by its @media rules (no sbnb-pane there)
    await size(600);
    await send("Page.navigate", { url: `${site}/` });
    await until(`!!document.querySelector('.sbnb .cell')`, 30000);
    const page = await ev(`[getComputedStyle(document.querySelector('.sbnb')).getPropertyValue('--gutter').trim(), !!document.querySelector('.sbnb')?.closest('.nb-root')]`);
    ok(page[0] === "44px" && !page[1], "the notebook page at a 600 px viewport gets the compact layout (@media)", page);
    await size(1280);
    await pair();
    await converse();
  }

  // ======================================================================== let go: moved, Trash, a reset fence, replaced
  if (want("detach")) {
    // Each: an edit in the pane, its save pending (the notebook's 500 ms), then the file moves on; that save must
    // not land anywhere. (If the move took longer than the save's delay, the case is tried again.)
    const cases = {
      moved: async (path) => call("workspace.rename", { from: path, to: path.replace(".ipynb", "-moved.ipynb") }),
      trash: async (path) => call("workspace.remove", { path }),
      fence: async () => {
        const f = await record(FENCE);
        await putRecord({ ...(f ?? { id: FENCE, workspace: "test", phase: "ok", step: 1 }), generation: (f?.generation ?? 0) + 1 });
      },
      replaced: async (path) => {
        await call("workspace.rename", { from: path, to: path.replace(".ipynb", "-old.ipynb") });
        await call("workspace.create", { path, content: docFor(path, [{ code: "z = 'new one'" }], {}, "new"), mode: "python" });
      },
    };
    for (const [name, act] of Object.entries(cases)) {
      let done = false;
      for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        const path = `/notes/let-go-${name}-${attempt}.ipynb`;
        const fence0 = await record(FENCE);
        await call("workspace.create", { path, content: docFor(path, [{ code: "z = 0" }]), mode: "python" });
        const ref = await refOf(path);
        await openNotebook(path);
        await sleep(300);
        const t0 = Date.now();
        await typeInto(0, "  # pending");
        await act(path);
        await until(`/gone|refused/.test(document.querySelector('#artifacts .pane-bar')?.className ?? '') && !document.querySelector('#artifacts .pane-bar').hidden`, 5000).catch(() => {});
        const took = Date.now() - t0;
        // (a reset is seen when the pending save is refused, so after its delay: its timing is no precondition)
        if (took > 350 && name !== "fence" && attempt < 3) {
          console.log(`     (${name}: the change took ${took} ms, past the save's delay: again)`);
          if (name === "fence") await putRecord(fence0);
          continue;
        }
        done = true;
        await sleep(1500);
        const old = await record(ref);
        const bar = await barText();
        const atPath = name === "replaced" ? (await readCells(path))[0].code : null;
        const kept = (await shown())[0];
        ok(
          !JSON.stringify(old?.cells ?? []).includes("# pending") && (atPath === null || atPath === "z = 'new one'") && /gone/.test(bar) && kept === "z = 0  # pending",
          `let go (${name}): the pending save landed nowhere, the pane says so, and the edit is still shown`,
          { old: old?.cells?.map((c) => c.code), atPath, bar, kept, took },
        );
        if (name === "fence") {
          await putRecord(fence0 ?? { id: FENCE });
          if (!fence0) await ev(`(async () => { const db = await new Promise((ok) => { const r = indexedDB.open("sagebrush"); r.onsuccess = () => ok(r.result); }); await new Promise((ok) => { const t = db.transaction("notebooks", "readwrite"); t.objectStore("notebooks").delete(${JSON.stringify(FENCE)}); t.oncomplete = ok; }); db.close(); })()`);
          // (the page, fresh, binds to the fence as it is again)
          await pair();
          await converse();
        }
      }
    }
  }

  // ======================================================================== a running cell: the tab says so; closing asks
  if (want("running")) {
    const path = "/notes/slow.ipynb";
    await call("workspace.create", { path, content: docFor(path, [{ code: "import time\nfor i in range(600):\n    time.sleep(0.05)" }]), mode: "python" });
    await openNotebook(path);
    await ev(`${cellJs(0)}.querySelector('.runb').click()`);
    await until(`/· running/.test([...document.querySelectorAll('#artifacts .tab')].map((t) => t.textContent).join())`, 120000);
    ok(true, "the tab of a notebook with a running cell says · running");
    await ev(`document.querySelector('#close').click()`);
    await until(`document.querySelector('#close-running').open`);
    ok(true, "closing the pane while a cell runs asks first (a dialog)");
    await ev(`document.querySelector('#close-running').close('')`);
    await sleep(300);
    const kept = await ev(`({ open: document.body.classList.contains('has-artifact'), cls: ${cellJs(0)}?.className ?? null, dialog: document.querySelector('#close-running').open, out: ${cellJs(0)}?.querySelector('.out').textContent.slice(0, 200) ?? null })`);
    ok(kept.open && /running|queued/.test(kept.cls ?? ""), "Cancel keeps the pane, the cell still running", kept);
    await ev(`document.querySelector('#close').click()`);
    await until(`document.querySelector('#close-running').open`);
    await ev(`document.querySelector('#close-running').close('stop')`);
    await until(`!document.body.classList.contains('has-artifact')`, 10000);
    ok(true, "Stop and close: the pane closes");
    // a notebook closed while it opens (closed the moment its host appears, before its store is read): nothing of it
    // stays, and its late load and attach let go
    await call("workspace.create", { path: "/notes/late.ipynb", content: docFor("/notes/late.ipynb", [{ code: "late = 1" }]), mode: "python" });
    await ev(`(() => { const o = new MutationObserver(() => { if (document.querySelector('#artifacts .nb-root') && document.querySelector('#close')) { o.disconnect(); window.__closedAt = document.querySelectorAll('#artifacts .sbnb').length; document.querySelector('#close').click(); } }); o.observe(document.body, { subtree: true, childList: true }); })()`);
    await artifactTurn("/notes/late.ipynb");
    await until(`window.__closedAt !== undefined`, 10000);
    await sleep(2500);
    const late = await ev(`({ closedAt: window.__closedAt, roots: document.querySelectorAll('#artifacts .nb-root').length, nbs: document.querySelectorAll('.sbnb').length, open: document.body.classList.contains('has-artifact') })`);
    ok(late.closedAt === 0 && late.roots === 0 && late.nbs === 0 && !late.open, "a notebook closed while it opened leaves nothing behind (its late load and attach let go)", late);
  }

  // ======================================================================== LaTeX: the editor where the build has it
  if (want("latex")) {
    const path = "/notes/paper.tex";
    await call("workspace.create", { path, content: { text: "\\documentclass{article}\n\\begin{document}\nHello $x^2$.\n\\end{document}\n" } });
    const before = requested.length;
    await artifactTurn(path);
    await until(`!!document.querySelector('${PANE} .file-body')`, 10000);
    await sleep(2500);
    const got = await ev(`({ editor: !!document.querySelector('${PANE} .tex-embed'), text: !!document.querySelector('${PANE} textarea.code-edit'), open: !!document.querySelector('${PANE} a.open-full') })`);
    const asked = requested.slice(before).some((u) => u.includes("sagebrush-latex.js"));
    if (LATEX) ok(got.editor && !got.text && asked, "a .tex artifact opens in the LaTeX editor (this build has it)", { got, asked });
    else ok(!got.editor && got.text && got.open && !asked, "a .tex artifact is its source, with Open in Sagebrush, and no LaTeX module is asked for (this build has none)", { got, asked });
  }

  // ======================================================================== ART-C2: the mount, held at its module's load
  if (want("mount")) {
    // (a) the file replaced while the mount waits: the pane lets go once it attaches, and nothing is written
    await freshPage();
    const P = "/notes/mount-a.ipynb";
    await call("workspace.create", { path: P, content: docFor(P, [{ code: "m = 0" }]), mode: "python" });
    const refA = await refOf(P);
    await hold("sagebrush-notebook.js");
    await artifactTurn(P);
    await untilHeld();
    await call("workspace.rename", { from: P, to: "/notes/mount-a-old.ipynb" });
    await call("workspace.create", { path: P, content: docFor(P, [{ code: "m = 'new'" }], {}, "new"), mode: "python" });
    await resume();
    await until(`document.querySelectorAll('${PANE} .nb-root .cell').length > 0`, 30000);
    await until(`/gone/.test(document.querySelector('#artifacts .pane-bar')?.className ?? '')`, 5000).catch(() => {});
    await typeInto(0, "  # late");
    await sleep(1500);
    const old = (await record(refA)).cells[0].code, now = (await readCells(P))[0].code, bar = await barText();
    ok(old === "m = 0" && now === "m = 'new'" && /gone/.test(bar), "a file replaced while its notebook was loading: the pane lets go when it attaches, and writes neither the old nor the new document", { old, now, bar });
    // (b) closed while the mount waits: nothing of it is made, and its late load lets go
    await freshPage();
    const Q = "/notes/mount-b.ipynb";
    await call("workspace.create", { path: Q, content: docFor(Q, [{ code: "print('B-RAN')" }]), mode: "python" });
    const w0 = workerCount();
    await hold("sagebrush-notebook.js");
    await artifactTurn(Q);
    await untilHeld();
    await until(`!!document.querySelector('#close')`);
    await ev(`document.querySelector('#close').click()`);
    await until(`!document.body.classList.contains('has-artifact')`, 10000);
    await resume();
    await sleep(2500);
    const left = await ev(`({ roots: document.querySelectorAll('.nb-root').length, nbs: document.querySelectorAll('.sbnb').length, pops: document.querySelectorAll('.sbnb-menu, .sbnb-completer').length })`);
    ok(left.roots === 0 && left.nbs === 0 && left.pops === 0 && workerCount() === w0, "a notebook closed while its module was loading: nothing of it is made once the module arrives", { left, workers: workerCount() - w0 });
  }

  // ======================================================================== ART-C2: a save held at the workspace's lock
  if (want("admission")) {
    // Closing keeps what isn't saved (ART-C2 r3). (a) The workspace held by another tab: the edit's save waits; closing
    // can neither save nor copy in time, so the notebook stays, saying so; once the workspace is free, the waiting save
    // is refused where it would write, and Try again keeps the edit as a copy.
    const P = "/notes/held.ipynb";
    await call("workspace.create", { path: P, content: docFor(P, [{ code: "h = 0" }]), mode: "python" });
    const ref = await refOf(P);
    await openNotebook(P);
    await lockWorkspace();
    await typeInto(0, "  # held");
    await sleep(1000);
    await ev(`document.querySelector('#close').click()`);
    await until(`/couldn't be saved or kept/.test(document.querySelector('#artifacts .pane-bar')?.textContent ?? '')`, 15000).catch(() => {});
    const stayed = await ev(`({ open: document.body.classList.contains('has-artifact'), bar: document.querySelector('#artifacts .pane-bar')?.textContent ?? '', text: ${cellJs(0)}?.querySelector('textarea').value ?? null })`);
    // (BAC-8) kept open after a failed close: readable, selectable, Ctrl+C let through; typing and Run do nothing
    const wKept = workerCount();
    const kept = await readableKept(`${PANE} .nb-root .cell textarea`);
    await ev(`${cellJs(0)}?.querySelector('.runb')?.click()`);
    await sleep(800);
    const dl = await downloadCopy();
    const dlCells = (() => { try { return JSON.parse(dl.text).cells.map((c) => [c.cell_type, [].concat(c.source).join("")]); } catch { return null; } })();
    const shownCells = await ev(`[...document.querySelectorAll('${PANE} .nb-root .cell')].map((c) => c.querySelector('textarea').value)`);
    ok(dl?.name === "held (copy).ipynb" && JSON.stringify(dlCells?.map((c) => c[1])) === JSON.stringify(shownCells), "Download a copy, after a failed close: an .ipynb of exactly the notebook it kept frozen", { name: dl?.name, dlCells, shownCells });
    ok(stayed.open && kept.inert === false && kept.focused && kept.selected > 0 && kept.copy === "let through" && kept.unchanged && workerCount() === wKept && !/\[\d+\]/.test(await ev(`${cellJs(0)}?.querySelector('.n').textContent ?? ''`)), "a notebook kept open after a failed close is readable (not inert), selectable and copyable (Ctrl+C), and typing and Run do nothing", { kept, workers: workerCount() - wKept });
    await ev(`window.__release()`);
    await sleep(1500);
    const rec = (await record(ref)).cells[0].code;
    await ev(`[...document.querySelectorAll('#artifacts .pane-bar button')].find((b) => b.textContent === 'Try again')?.click()`);
    await until(`!document.body.classList.contains('has-artifact')`, 10000).catch(() => {});
    const copy = await readCells("/notes/held (copy).ipynb").then((c) => c[0].code, (e) => "no copy: " + e.message);
    const closed = !(await ev(`document.body.classList.contains('has-artifact')`));
    ok(stayed.open && /couldn't be saved or kept/.test(stayed.bar) && stayed.text === "h = 0  # held" && rec === "h = 0" && copy === "h = 0  # held" && closed, "closing while the workspace is busy: the notebook stays with its edit, the waiting save is refused where it would write, Try again keeps the edit as a copy", { stayed, rec, copy, closed });

    // (a2, astra's r5 item) a Markdown cell's editor already open when a close fails: Alt+ArrowUp/Down in it change
    // nothing (the order stays), the download has the order shown, and Try again copies that order
    const O2 = "/notes/held-md.ipynb";
    await call("workspace.create", { path: O2, content: docFor(O2, [{ type: "markdown", code: "# first" }, { code: "second = 2" }]), mode: "python" });
    await openNotebook(O2);
    await ev(`(() => { const m = ${cellJs(0)}.querySelector('.mdout'); m.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
    await until(`${cellJs(0)}.classList.contains('blocks')`, 5000).catch(() => {});
    const opened = await ev(`${cellJs(0)}.classList.contains('blocks')`);
    await lockWorkspace();
    await typeInto(1, "  # edit");
    await sleep(800);
    await ev(`document.querySelector('#close').click()`);
    await until(`/couldn't be saved or kept/.test(document.querySelector('#artifacts .pane-bar')?.textContent ?? '')`, 15000).catch(() => {});
    const order = () => ev(`[...document.querySelectorAll('${PANE} .nb-root .cell')].map((c) => c.classList.contains('markdown') ? 'md' : c.querySelector('textarea').value)`);
    // (kept open? if the close didn't fail (a control changing closing), there is nothing to press keys in: this check
    // fails alone, and the workspace is freed and the pane closed for what follows)
    const keptA2 = await ev(`document.body.classList.contains('has-artifact') && /couldn't be saved or kept/.test(document.querySelector('#artifacts .pane-bar')?.textContent ?? '')`);
    let a2 = { opened, keptA2 };
    if (keptA2) {
      const before = await order();
      // (into the open Markdown editor's block, as a person would: a real click on it, which the kept state lets through)
      const at = await ev(`(() => { const c = ${cellJs(0)}; const blk = c?.querySelector('.body > :first-child:not(.ed)') ?? c?.querySelector('.body'); if (!blk) return null; const r = blk.getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(12, r.height / 2) }; })()`);
      if (at) for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
      await sleep(300);
      const inEditor = await ev(`(() => { const a = document.activeElement, c = ${cellJs(0)}; return !!a && !!c && c.contains(a) && !a.closest('.ed'); })()`);
      for (const key of ["ArrowDown", "ArrowUp", "ArrowDown"]) await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: key === "ArrowUp" ? 38 : 40, modifiers: 1 }).then(() => send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: key === "ArrowUp" ? 38 : 40, modifiers: 1 }));
      await sleep(500);
      const afterKeys = await order();
      const dl2 = await downloadCopy();
      const dlOrder = (() => { try { return JSON.parse(dl2.text).cells.map((c) => c.cell_type === "markdown" ? "md" : [].concat(c.source).join("")); } catch { return null; } })();
      a2 = { ...a2, inEditor, before, afterKeys, dlOrder };
    }
    await ev(`window.__release?.()`);
    await sleep(1500);
    if (keptA2) await ev(`[...document.querySelectorAll('#artifacts .pane-bar button')].find((b) => b.textContent === 'Try again')?.click()`);
    await until(`!document.body.classList.contains('has-artifact')`, 10000).catch(() => {});
    if (await ev(`document.body.classList.contains('has-artifact')`)) await ev(`[...document.querySelectorAll('#artifacts .pane-bar button')].find((b) => b.textContent === 'Close without keeping')?.click()`);
    await until(`!document.body.classList.contains('has-artifact')`, 5000).catch(() => {});
    a2.copy2 = await readCells("/notes/held-md (copy).ipynb").then((c) => c.map((x) => x.type === "markdown" ? "md" : x.code), (e) => "no copy: " + e.message);
    const want = JSON.stringify(["md", "second = 2  # edit"]);
    ok(a2.opened && a2.keptA2 && a2.inEditor && JSON.stringify(a2.before) === want && JSON.stringify(a2.afterKeys) === want && JSON.stringify(a2.dlOrder) === want && JSON.stringify(a2.copy2) === want, "after a failed close, Alt+ArrowUp/Down in an open Markdown editor move nothing: the order shown, downloaded and copied on Try again is the same", a2);

    // (b) An edit pending when the file goes to Trash, then closed without Save as a copy: the edit is kept as a copy.
    const T = "/notes/letgo-close.ipynb";
    await call("workspace.create", { path: T, content: docFor(T, [{ code: "t = 0" }]), mode: "python" });
    const refT = await refOf(T);
    await openNotebook(T);
    await typeInto(0, "  # pending");
    await call("workspace.remove", { path: T });
    await until(`/gone/.test(document.querySelector('#artifacts .pane-bar')?.className ?? '')`, 5000).catch(() => {});
    await ev(`document.querySelector('#close').click()`);
    await until(`!document.body.classList.contains('has-artifact')`, 12000).catch(() => {});
    const recT = (await record(refT)).cells[0].code;
    const copyT = await readCells("/notes/letgo-close (copy).ipynb").then((c) => c[0].code, (e) => "no copy: " + e.message);
    ok(recT === "t = 0" && copyT === "t = 0  # pending", "a notebook let go (Trash) with an edit pending, closed without Save as a copy: the edit is kept as a copy, the trashed one unchanged", { recT, copyT });

    // (c) A save refused with a resolved "not saved" (the workspace's fence moved), during close: kept as a copy.
    const F = "/notes/refused-close.ipynb";
    await call("workspace.create", { path: F, content: docFor(F, [{ code: "f = 0" }]), mode: "python" });
    const refF = await refOf(F);
    await openNotebook(F);
    const fence0 = await record(FENCE);
    await typeInto(0, "  # refused");
    await putRecord({ ...(fence0 ?? { id: FENCE, workspace: "test", phase: "ok", step: 1 }), generation: (fence0?.generation ?? 0) + 1 });
    await ev(`document.querySelector('#close').click()`);
    // (the copy may be refused too while the fence is moved: then the notebook stays, and is kept once it is back)
    const outcome = await Promise.race([
      until(`!document.body.classList.contains('has-artifact')`, 15000).then(() => "closed"),
      until(`/couldn't be saved or kept/.test(document.querySelector('#artifacts .pane-bar')?.textContent ?? '')`, 15000).then(() => "stayed"),
    ]).catch(() => "neither");
    if (fence0) await putRecord(fence0);
    if (outcome === "stayed") {
      await ev(`[...document.querySelectorAll('#artifacts .pane-bar button')].find((b) => b.textContent === 'Try again')?.click()`);
      await until(`!document.body.classList.contains('has-artifact')`, 12000).catch(() => {});
    }
    const recF = (await record(refF)).cells[0].code;
    const copyF = await readCells("/notes/refused-close (copy).ipynb").then((c) => c[0].code, (e) => "no copy: " + e.message);
    ok(outcome !== "neither" && recF === "f = 0" && copyF === "f = 0  # refused", "a save refused during close with a resolved not-saved: the edit is kept as a copy, the original unchanged", { outcome, recF, copyF });
    // (d, ART-C2a r4) only a cell's metadata changed ("Run only by hand"), pending when the file goes to Trash, then
    // closed: the change is content, so it is kept as a copy (tried again if its save beat the Trash)
    let metaDone = false;
    for (let attempt = 1; attempt <= 3 && !metaDone; attempt++) {
      const M = `/notes/meta-only-${attempt}.ipynb`;
      await call("workspace.create", { path: M, content: docFor(M, [{ code: "m = 0" }]), mode: "python" });
      const refM = await refOf(M);
      await openNotebook(M);
      await ev(`${cellJs(0)}.querySelector('[data-a="menu"]').click()`);
      await ev(`[...document.querySelectorAll('.sbnb-menu')].find((x) => !x.hidden).querySelector('[data-m="manual"]').click()`);
      await call("workspace.remove", { path: M });
      await until(`/gone/.test(document.querySelector('#artifacts .pane-bar')?.className ?? '')`, 5000).catch(() => {});
      const saved = (await record(refM)).cells[0].metadata?.sagebrush?.manual === true;
      if (saved && attempt < 3) { console.log(`     (meta-only: its save beat the Trash: again)`); await ev(`document.querySelector('#close').click()`); await until(`!document.body.classList.contains('has-artifact')`, 12000).catch(() => {}); continue; }
      metaDone = true;
      await ev(`document.querySelector('#close').click()`);
      await until(`!document.body.classList.contains('has-artifact')`, 12000).catch(() => {});
      const copy = await call("workspace.read", { path: M.replace(".ipynb", " (copy).ipynb") }).then((r) => r.content.json.cells[0], (e) => "no copy: " + e.message);
      ok(!saved && copy?.metadata?.sagebrush?.manual === true && copy.code === "m = 0", "only a cell's metadata changed, then let go and closed: the change is kept as a copy", { saved, copy });
    }
    // (e, ART-C2a r4) a copy keeps the whole notebook: its metadata (seed, autorun) and a Markdown cell's attachments
    const A = "/notes/meta-copy.ipynb";
    const tagA = tagOf(A);
    await call("workspace.create", { path: A, content: { json: { mode: "python", autorun: "always", seed: "s-42", cells: [{ id: `${tagA}0`, type: "markdown", code: "![x](attachment:x.png)", attachments: { "x.png": { "image/png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } } }, { id: `${tagA}1`, code: "a = 1" }] } }, mode: "python" });
    const recA = await record(await refOf(A));
    await openNotebook(A);
    await typeInto(1, "  # edit");
    await call("workspace.remove", { path: A });
    await until(`/gone/.test(document.querySelector('#artifacts .pane-bar')?.className ?? '')`, 5000).catch(() => {});
    await ev(`document.querySelector('#close').click()`);
    await until(`!document.body.classList.contains('has-artifact')`, 12000).catch(() => {});
    const copyA = await call("workspace.read", { path: "/notes/meta-copy (copy).ipynb" }).then((r) => r.content.json, (e) => ({ error: e.message }));
    ok(recA?.seed === "s-42" && !!recA?.cells?.[0]?.attachments && copyA.seed === "s-42" && copyA.autorun === "always" && !!copyA.cells?.[0]?.attachments?.["x.png"] && copyA.cells?.[1]?.code === "a = 1  # edit", "a recovery copy keeps the whole notebook: its seed and autorun, a Markdown cell's attachments, and the edit", { before: { seed: recA?.seed, att: !!recA?.cells?.[0]?.attachments }, copy: { seed: copyA.seed, autorun: copyA.autorun, att: Object.keys(copyA.cells?.[0]?.attachments ?? {}), code: copyA.cells?.[1]?.code, error: copyA.error } });

    // (f, ART-C2b r4) while a close waits for its copy (the workspace busy), the notebook is frozen: typing, its Run
    // button and Shift+Enter change and run nothing; once the copy is made it closes, with the content it showed
    const Z = "/notes/frozen.ipynb";
    await call("workspace.create", { path: Z, content: docFor(Z, [{ code: "z = 0" }, { code: "print('Z-RAN')" }]), mode: "python" });
    const refZ = await refOf(Z);
    await openNotebook(Z);
    const w0 = workerCount();
    await lockWorkspace();
    await typeInto(0, "  # before");
    await ev(`document.querySelector('#close').click()`);
    await sleep(1500);
    const during = await ev(`({ inert: !!document.querySelector('${PANE} .nb-root')?.inert, said: document.querySelector('${PANE} .saved')?.textContent })`);
    await poke(0, " # late");
    await poke(1, "");
    const shownZ = await ev(`${cellJs(0)}?.querySelector('textarea').value ?? null`);
    await sleep(3000);
    await ev(`window.__release()`);
    await until(`!document.body.classList.contains('has-artifact')`, 12000).catch(() => {});
    const copyZ = await readCells("/notes/frozen (copy).ipynb").then((c) => c, (e) => "no copy: " + e.message);
    const recZ = (await record(refZ)).cells[0].code;
    ok(during.inert && during.said === "Closing…" && shownZ === "z = 0  # before" && copyZ?.[0]?.code === "z = 0  # before" && !(copyZ?.[1]?.outputs ?? []).length && workerCount() === w0 && recZ === "z = 0", "while a close waits for its copy the notebook is frozen (no typing, no Run, no Shift+Enter); it closes with what it showed, kept as a copy", { during, shownZ, copy: Array.isArray(copyZ) ? copyZ.map((c) => [c.code, (c.outputs ?? []).length]) : copyZ, workers: workerCount() - w0, recZ });

    // (g, ART-C2b r4) the same while the close waits for the store's read: frozen, and its edit saved before it closes
    const Y = "/notes/frozen-read.ipynb";
    await call("workspace.create", { path: Y, content: docFor(Y, [{ code: "y = 0" }]), mode: "python" });
    const refY = await refOf(Y);
    await openNotebook(Y);
    await typeInto(0, "  # before");
    await holdStore(3500);
    await ev(`document.querySelector('#close').click()`);
    await sleep(800);
    const duringY = await ev(`({ inert: !!document.querySelector('${PANE} .nb-root')?.inert, said: document.querySelector('${PANE} .saved')?.textContent })`);
    await poke(0, " # late");
    const shownY = await ev(`${cellJs(0)}?.querySelector('textarea').value ?? null`);
    await until(`!document.body.classList.contains('has-artifact')`, 15000).catch(() => {});
    await sleep(500);
    const recY = (await record(refY)).cells[0].code;
    const copyY = await readCells("/notes/frozen-read (copy).ipynb").then((c) => c[0].code, () => null);
    ok(duringY.inert && duringY.said === "Closing…" && shownY === "y = 0  # before" && (recY === "y = 0  # before" || copyY === "y = 0  # before") && recY !== "y = 0  # before # late" && copyY !== "y = 0  # before # late", "while a close waits for the store's read the notebook is frozen; what it showed is saved (or kept), nothing typed later", { duringY, shownY, recY, copyY });
    await freshPage();
  }

  // ======================================================================== ART-C3, C4: file artifacts
  if (want("files")) {
    const P = "/notes/f.py";
    await call("workspace.create", { path: P, content: { text: "a = 1\n" } });
    await artifactTurn(P);
    await until(`!!document.querySelector('${PANE} textarea.code-edit') && document.querySelector('${PANE} .saved').textContent === 'Saved'`);
    await ev(`(() => { const t = document.querySelector('${PANE} textarea.code-edit'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
    await send("Input.insertText", { text: "# mine\n" });
    await sleep(1500);
    const r1 = await call("workspace.read", { path: P });
    ok(r1.content.text === "a = 1\n# mine\n", "a file artifact's edit is saved, with its base", r1.content);
    await call("workspace.write", { path: P, content: { text: "a = 2\n" }, base: r1.rev });
    await send("Input.insertText", { text: "# more\n" });
    await sleep(1500);
    const r2 = await call("workspace.read", { path: P });
    const said = await savedText();
    const kept = await ev(`document.querySelector('${PANE} textarea.code-edit').value`);
    await ev(`document.querySelector('#close').click()`);
    await until(`!document.body.classList.contains('has-artifact')`, 10000);
    await sleep(1500);
    const copy = await call("workspace.read", { path: "/notes/f (copy).py" }).then((r) => r.content.text, (e) => "no copy: " + e.message);
    ok(r2.content.text === "a = 2\n" && /changed or replaced elsewhere/.test(said) && kept === "a = 1\n# mine\n# more\n" && copy === kept, "a change made since is never written over: the person's text stays, and is kept as a copy when the pane closes", { file: r2.content.text, said, kept, copy });
    // (ART-C3 r3) another file put at the path, at the same revision: the old pane's write is refused (the file's identity)
    const R = "/notes/r.py";
    await call("workspace.create", { path: R, content: { text: "old\n" } });
    await artifactTurn(R);
    await until(`!!document.querySelector('${PANE} textarea.code-edit') && document.querySelector('${PANE} .saved').textContent === 'Saved'`);
    const revOld = (await call("workspace.read", { path: R })).rev;
    await call("workspace.rename", { from: R, to: "/notes/r-old.py" });
    await call("workspace.create", { path: R, content: { text: "new\n" } });
    const revNew = (await call("workspace.read", { path: R })).rev;
    await ev(`(() => { const t = document.querySelector('${PANE} textarea.code-edit'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
    await send("Input.insertText", { text: "# mine\n" });
    await sleep(1500);
    const atR = (await call("workspace.read", { path: R })).content.text;
    const saidR = await savedText();
    ok(revOld === revNew && atR === "new\n" && /replaced|changed/.test(saidR), "another file at the path, at the same revision: the old pane's write is refused, the new file unchanged", { revOld, revNew, atR, saidR });
    await ev(`document.querySelector('#close').click()`);
    await until(`!document.body.classList.contains('has-artifact')`, 12000).catch(() => {});

    // (ART-C4 r3) writes queued while the workspace is busy, then the pane closed: none of them is written after, and the
    // latest text is kept (the pane stays until it can be: Try again)
    const queued = async (Q, latex) => {
      await call("workspace.create", { path: Q, content: { text: "q = 1\n" } });
      await artifactTurn(Q);
      const box = latex ? `${PANE} .tex-left textarea` : `${PANE} textarea.code-edit`;
      await until(`!!document.querySelector('${box}') && document.querySelector('${PANE} .saved').textContent === 'Saved'`, 20000);
      await lockWorkspace();
      const type = async (t) => {
        await ev(`(() => { const x = document.querySelector('${box}'); x.focus(); x.setSelectionRange(x.value.length, x.value.length); })()`);
        await send("Input.insertText", { text: t });
      };
      await type("# one\n");
      await sleep(1200);
      await type("# two\n");
      if (!latex) await sleep(1200); // (a second write queued; with LaTeX, closed within the editor's debounce)
      await ev(`document.querySelector('#close').click()`);
      await until(`/couldn't be saved or kept/.test(document.querySelector('#artifacts .pane-bar')?.textContent ?? '')`, 15000).catch(() => {});
      const bar = await barText();
      const kept = latex ? null : await readableKept(`${PANE} textarea.code-edit`);
      const shownText = await ev(`document.querySelector('${latex ? `${PANE} .tex-left textarea` : `${PANE} textarea.code-edit`}')?.value ?? null`);
      const dl = await downloadCopy();
      await ev(`window.__release()`);
      await sleep(2000);
      const file = (await call("workspace.read", { path: Q })).content.text;
      await ev(`[...document.querySelectorAll('#artifacts .pane-bar button')].find((b) => b.textContent === 'Try again')?.click()`);
      await until(`!document.body.classList.contains('has-artifact')`, 12000).catch(() => {});
      const copy = await call("workspace.read", { path: Q.replace(/(\.[a-z]+)$/, " (copy)$1") }).then((r) => r.content.text, (e) => "no copy: " + e.message);
      return { bar, file, copy, kept, shownText, dl, closed: !(await ev(`document.body.classList.contains('has-artifact')`)) };
    };
    const qa = await queued("/notes/queued.py", false);
    ok(/couldn't be saved or kept/.test(qa.bar) && qa.file === "q = 1\n" && qa.copy === "q = 1\n# one\n# two\n" && qa.closed, "file writes queued behind a busy workspace, then closed: nothing is written after the close, the latest text is kept as a copy", qa);
    ok(qa.dl?.name === "queued (copy).py" && qa.dl.text === qa.shownText && qa.shownText === "q = 1\n# one\n# two\n", "Download a copy of a file, after a failed close: exactly the text it kept frozen", { dl: qa.dl, shown: qa.shownText });
    ok(qa.kept && qa.kept.inert === false && qa.kept.selected > 0 && qa.kept.copy === "let through" && qa.kept.unchanged, "a file kept open after a failed close is readable (not inert), selectable and copyable (Ctrl+C), and typing does nothing", qa.kept);
    // (ART-C2b/C4 r4) while a file's close waits for its copy, its editor is frozen: typing changes nothing; it closes
    // with what it showed, kept as a copy
    const frozenFile = async (Q, latex) => {
      await call("workspace.create", { path: Q, content: { text: "f = 1\n" } });
      await artifactTurn(Q);
      const box = latex ? `${PANE} .tex-left textarea` : `${PANE} textarea.code-edit`;
      await until(`!!document.querySelector('${box}') && document.querySelector('${PANE} .saved').textContent === 'Saved'`, 20000);
      await lockWorkspace();
      const type = async (t) => {
        await ev(`(() => { const x = document.querySelector('${box}'); x?.focus(); x?.setSelectionRange(x.value.length, x.value.length); })()`);
        await send("Input.insertText", { text: t });
      };
      await type("# before\n");
      if (!latex) await sleep(1200);
      await ev(`document.querySelector('#close').click()`);
      await sleep(1500);
      const during = await ev(`({ inert: !!document.querySelector('${PANE} .file-body')?.inert, said: document.querySelector('${PANE} .saved')?.textContent })`);
      await type("# late\n");
      const shown = await ev(`document.querySelector('${box}')?.value ?? null`);
      await sleep(3000);
      await ev(`window.__release()`);
      await until(`!document.body.classList.contains('has-artifact')`, 12000).catch(() => {});
      const copy = await call("workspace.read", { path: Q.replace(/(\.[a-z]+)$/, " (copy)$1") }).then((r) => r.content.text, (e) => "no copy: " + e.message);
      return { during, shown, copy, file: (await call("workspace.read", { path: Q })).content.text };
    };
    const fz = await frozenFile("/notes/frozen.py", false);
    ok(fz.during.inert && fz.during.said === "Closing…" && fz.shown === "f = 1\n# before\n" && fz.copy === "f = 1\n# before\n" && fz.file === "f = 1\n", "while a file's close waits for its copy its editor is frozen (typing changes nothing); it closes with what it showed, kept as a copy", fz);
    if (LATEX) {
      const fl = await frozenFile("/notes/frozen.tex", true);
      ok(fl.during.inert && fl.shown === "f = 1\n# before\n" && fl.copy === "f = 1\n# before\n" && fl.file === "f = 1\n", "a LaTeX file closed within its debounce while the workspace is busy: frozen, it closes with what it showed, kept as a copy", fl);
    }
    if (LATEX) {
      const ql = await queued("/notes/queued.tex", true);
      ok(/couldn't be saved or kept/.test(ql.bar) && ql.file === "q = 1\n" && ql.copy === "q = 1\n# one\n# two\n" && ql.closed, "a LaTeX file closed within its editor's debounce while the workspace is busy: nothing is written after the close, the latest text is kept as a copy", ql);
    }
    if (LATEX) {
      // (no editor until the file and its revision are read: here the LaTeX module is held)
      await freshPage();
      const T = "/notes/g.tex";
      await call("workspace.create", { path: T, content: { text: "Hello.\n" } });
      await hold("sagebrush-latex.js");
      await artifactTurn(T);
      await untilHeld();
      const before = await ev(`({ ta: document.querySelectorAll('${PANE} textarea').length, ed: !!document.querySelector('${PANE} .tex-embed'), said: document.querySelector('${PANE} .saved')?.textContent })`);
      await resume();
      await until(`!!document.querySelector('${PANE} .tex-embed')`, 20000);
      ok(before.ta === 0 && !before.ed && before.said === "Loading…", "a .tex artifact offers no editing until its file and revision are read", before);
      // (ART-C4) closed during the editor's own debounce, its preview running: the edit is saved, the editor destroyed
      await until(`document.querySelector('${PANE} .saved').textContent === 'Saved'`);
      await sleep(1500);
      const lw = live("sagebrush-latex-worker.js");
      await ev(`(() => { const t = document.querySelector('${PANE} .tex-left textarea'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
      await send("Input.insertText", { text: "Bye.\n" });
      await ev(`document.querySelector('#close').click()`);
      await until(`!document.body.classList.contains('has-artifact')`, 10000);
      await sleep(2000);
      const text = (await call("workspace.read", { path: T })).content.text;
      ok(lw >= 1 && live("sagebrush-latex-worker.js") === 0 && text === "Hello.\nBye.\n", "a LaTeX artifact closed during its editor's debounce: the last edit is saved and the editor and its worker are gone", { workersBefore: lw, workersAfter: live("sagebrush-latex-worker.js"), text });
    }
  }

  // ======================================================================== ART-C5: each notebook's bar is its own
  if (want("bars")) {
    const A = "/notes/bar-a.ipynb", B = "/notes/bar-b.ipynb";
    await call("workspace.create", { path: A, content: docFor(A, [{ code: "who = 'A'" }]), mode: "python" });
    await call("workspace.create", { path: B, content: docFor(B, [{ code: "who = 'B'" }]), mode: "python" });
    await openNotebook(A);
    await openNotebook(B);
    await call("workspace.remove", { path: A }); // (A, hidden, goes to Trash)
    await sleep(1000);
    const onB = await barText();
    await ev(`${tabJs(A)}.click()`);
    await sleep(300);
    const onA = await barText();
    await ev(`[...document.querySelectorAll('#artifacts .pane-bar button')].find((b) => b.textContent.startsWith('Save as a copy'))?.click()`);
    // (the copy is made through the workspace: waited for, up to 8 s)
    let copy = "no copy";
    for (let t = Date.now(); Date.now() - t < 8000; await sleep(200)) {
      copy = await readCells("/notes/bar-a (copy).ipynb").then((c) => c[0].code, (e) => "no copy: " + e.message);
      if (!copy.startsWith("no copy")) break;
    }
    await ev(`${tabJs(B)}.click()`);
    await sleep(300);
    const backOnB = await barText();
    const strip = await ev(`(() => { const b = document.querySelector('#artifacts .pane-bar'); return { display: getComputedStyle(b).display, role: b.getAttribute('role'), cls: b.className, h: b.getBoundingClientRect().height }; })()`);
    ok(strip.display === "none" && strip.role === null && strip.cls === "pane-bar" && strip.h === 0, "with no bar to show, the bar takes no room and has no kind or alert role (after another notebook's warning)", strip);
    ok(onB === "" && /gone/.test(onA) && copy === "who = 'A'" && backOnB === "", "a hidden notebook's warning waits for it: shown with its own Save as a copy when it is selected (copying it), and not over the other", { onB, onA, copy, backOnB });
  }

  // ======================================================================== ART-C6: leaving a thread with a running cell asks
  if (want("navigate")) {
    const P = "/notes/nav.ipynb";
    await call("workspace.create", { path: P, content: docFor(P, [{ code: "import time\nfor i in range(1200):\n    time.sleep(0.05)" }]), mode: "python" });
    await openNotebook(P);
    await ev(`${cellJs(0)}.querySelector('.runb').click()`);
    await until(`${cellJs(0)}.classList.contains('running')`, 120000);
    const asks = async (how, answer) => {
      await ev(how);
      const asked = await until(`document.querySelector('#close-running').open`, 3000).then(() => true, () => false);
      if (asked) await ev(`document.querySelector('#close-running').close(${JSON.stringify(answer)})`);
      await sleep(400);
      return asked;
    };
    const newAsks = await asks(`document.querySelector('#new').click()`, "cancel");
    const keptNew = await ev(`!!${cellJs(0)} && ${cellJs(0)}.classList.contains('running')`);
    const otherAsks = await asks(`document.querySelector('#threads .thread:not(.on)').click()`, "cancel");
    const keptOther = await ev(`!!${cellJs(0)} && ${cellJs(0)}.classList.contains('running')`);
    const stopAsks = await asks(`document.querySelector('#new').click()`, "stop");
    await sleep(1500);
    const after = await ev(`({ roots: document.querySelectorAll('.nb-root').length, empty: !!document.querySelector('[data-try]')?.offsetParent })`);
    ok(newAsks && keptNew && otherAsks && keptOther && stopAsks && after.roots === 0 && after.empty, "New chat and another thread ask first while a cell runs: Cancel keeps it running, Stop and close leaves", { newAsks, keptNew, otherAsks, keptOther, stopAsks, after });
    await converse();
  }

  // ======================================================================== the journal: read only in the pane
  if (want("journal")) {
    const path = "/notes/journal.ipynb";
    await call("workspace.create", { path, content: docFor(path, [{ code: "print('J-RAN')" }]), mode: "python" });
    const ref = await refOf(path);
    const fence0 = await record(FENCE);
    await putRecord({ ...(fence0 ?? { id: FENCE, workspace: "test", generation: 1, step: 1 }), phase: "journal", journal: 1 });
    try {
      await openNotebook(path);
      await typeInto(0, "  # typed");
      await sleep(1500);
      const v = (await shown())[0];
      const rec = await record(ref);
      const bar = await barText();
      const runs = await ev(`[...document.querySelectorAll('${PANE} .runb')].every((b) => b.disabled)`);
      const open = await ev(`[...document.querySelectorAll('#artifacts .pane-bar button')].some((b) => b.textContent === 'Open in Sagebrush')`);
      ok(v === "print('J-RAN')" && rec.cells[0].code === "print('J-RAN')" && runs && open && /readonly/.test(bar), "under sync's journal the pane is read only: an edit changes nothing, Run is off, Open in Sagebrush is offered", { v, saved: rec.cells[0].code, runs, open, bar });
      // (ART-C1) the keyboard's Run gestures, in the cell and in command mode: nothing runs, no interpreter starts
      const w0 = workerCount();
      await ev(`${cellJs(0)}.querySelector('textarea').focus()`);
      for (const modifiers of [8, 2, 1]) await key("Enter", { modifiers, windowsVirtualKeyCode: 13 });
      await key("Escape");
      await key("Enter", { modifiers: 8, windowsVirtualKeyCode: 13 });
      await sleep(2500);
      const o = await outs();
      const rec2 = await record(ref);
      ok(workerCount() === w0 && !/J-RAN/.test(o) && rec2.rev === rec.rev, "under the journal, Shift/Ctrl/Alt+Enter (in the cell and in command mode) run nothing: no interpreter, no output, no write", { workers: workerCount() - w0, o, rev: [rec.rev, rec2.rev] });
    } finally {
      if (fence0) await putRecord(fence0);
    }
  }

  // ======================================================================== A12 step 1: an agent's edit by cell
  // (cases E1-E20 of /scratch/sagebrush-reviews/agents-panel/a12-step1-r2.1 + r2.2; whole JSON read from the store)
  if (want("edit")) {
    // E17 (page, an old helper): no notebook.edit in its hello, so notebooks are written whole as before, and the page
    // takes no notebook.edit from it
    {
      const P0 = "/notes/e17.ipynb";
      await call("workspace.create", { path: P0, content: docFor(P0, [{ code: "1" }]), mode: "python" });
      const w = await write(P0, [{ code: "2" }]).then(() => "written", (e) => e.code ?? e.message);
      const r0 = await call("workspace.read", { path: P0 });
      const ed = await call("notebook.edit", { conversation: conv, path: P0, ref: "x", base: r0.rev, set: [{ id: r0.content.json.cells[0].id, source: "3" }], was: {} }).then(() => "answered", (e) => e.message);
      ok(w === "written" && /not a verb/.test(ed) && r0.ref === undefined, "E17: with an old helper (no notebook.edit) a notebook is written whole as today, no ref is read, and no edit is taken", { w, ed });
    }
    FEATURES = true;
    await ev(`document.querySelector('#new')?.click()`);
    await sleep(700);
    await pair();
    ok(notes.some((m) => m.method === "page.features" && m.params?.features?.includes("notebook.edit")), "with a helper that says notebook.edit, the page offers it once granted (page.features)");
    await converse();
    let turn = `t${++turnN}`;
    event(turn, { type: "turn_started" });
    // (a new running turn, after one finished: what the following cases' edits come from)
    const newTurn = () => { turn = `t${++turnN}`; event(turn, { type: "turn_started" }); };
    // a notebook with outputs: c0 and c1 code (each its output), c2 markdown; ids tagged so its record is found
    let made = 0;
    const refs = new Map();
    // (form: the notebook's own form, cellForm, as a document it saved: so a save keeps it byte for byte)
    const mk = async (cells0, { form = false } = {}) => {
      const path = `/notes/edit-${++made}.ipynb`, tag = tagOf(path);
      const cells0f = (cells0 ?? [
        { code: "x = 1", outputs: [{ output_type: "stream", name: "stdout", text: "A\n" }], n: 1 },
        { code: "print(2)", outputs: [{ output_type: "stream", name: "stdout", text: "B\n" }], n: 2 },
        { type: "markdown", code: "# heading" },
      ]).map((c, i) => ({ id: `${tag}${i}`, type: c.type ?? "code", ...c }));
      const cells = form ? cells0f.map(cellForm) : cells0f;
      await call("workspace.create", { path, content: { json: { mode: "python", cells } }, mode: "python" });
      refs.set(path, await refOf(path)); // (found by its first cell now: an insert first changes that)
      return { path, ids: cells.map((c) => c.id) };
    };
    const open = (path) => openNotebook(path, { finish: false, turn });
    // (another tab's long readwrite on a store, holding the page's reads and writes of it for ms: "notebooks" in
    // "sagebrush", or "entries" in "sagebrush-workspace", the index a stat reads)
    const holdDb = (db, store, ms) => ev(`(() => { const r = indexedDB.open(${JSON.stringify(db)}); r.onsuccess = () => { const d = r.result, t = d.transaction(${JSON.stringify(store)}, "readwrite"), st = t.objectStore(${JSON.stringify(store)}), end = Date.now() + ${ms}; const spin = () => { if (Date.now() < end) st.get("__hold__").onsuccess = spin; }; spin(); t.oncomplete = () => d.close(); }; return true; })()`);
    const readOf = async (path) => {
      const r = await call("workspace.read", { path });
      return { ref: r.ref, base: r.rev, cells: r.content.json.cells, was: Object.fromEntries(r.content.json.cells.map((c) => [c.id, cellHash(c)])) };
    };
    // (each answered within 15 s: a control that leaves an edit waiting doesn't hold the run)
    const edit = (path, r, e) => Promise.race([
      call("notebook.edit", { conversation: conv, path, ref: r.ref, base: r.base, was: r.was, ...e }).then((x) => ({ ok: true, x }), (err) => ({ ok: false, code: err.code, msg: err.message })),
      sleep(15000).then(() => ({ ok: false, code: "timeout", msg: "no answer in 15 s" })),
    ]);
    const rec = (path) => record(refs.get(path));
    const same = (a, b) => canonical(a) === canonical(b);
    const byId = (cs) => Object.fromEntries(cs.map((c) => [c.id, c]));
    const untilSaved = () => until(`/^Saved/.test(document.querySelector('${PANE} .saved')?.textContent ?? '')`, 10000);

    // E1, E2, E3, E15: one set: every unnamed cell byte-identical, in order; the set cell's text changed, its output kept
    // and marked as from before; exactly one new version (a document in the notebook's own form: a save keeps it byte
    // for byte; one in another form is re-formed by any save, the person's too: E5)
    {
      const { path, ids } = await mk(null, { form: true });
      await open(path);
      const r = await readOf(path);
      const before = await rec(path);
      const res = await edit(path, r, { set: [{ id: ids[1], source: "print(22)" }] });
      const after = await rec(path);
      const b = byId(before.cells), a = byId(after.cells);
      ok(res.ok && same(a[ids[0]], b[ids[0]]) && same(a[ids[2]], b[ids[2]]) && after.cells.map((c) => c.id).join() === before.cells.map((c) => c.id).join() && same(a[ids[1]].outputs, b[ids[1]].outputs), "E1: an edit of one cell keeps every other cell byte-identical (whole JSON), in order, and that cell's outputs", { res, a, b });
      ok(a[ids[1]].code === "print(22)", "E2: the set cell's stored source is the new text (source -> code)", a[ids[1]]);
      ok(await ev(`/Changed by Claude/.test(${cellJs(1)}.querySelector('.nb-edit-mark')?.textContent ?? '')`), "E3: the changed cell is marked: its output is from before the change");
    }
    // E15: one new version for a whole edit, of two cells (so a save per change would make two)
    {
      const { path, ids } = await mk(null, { form: true });
      await open(path);
      const r = await readOf(path);
      const before = await rec(path);
      const res = await edit(path, r, { set: [{ id: ids[0], source: "x = 3" }, { id: ids[1], source: "print(3)" }] });
      await sleep(800); // (past the component's save debounce: no late second save)
      const after = await rec(path);
      ok(res.ok && after.rev === before.rev + 1 && after.cells[0].code === "x = 3" && after.cells[1].code === "print(3)", "E15: exactly one new version for an edit of two cells", { res, before: before.rev, after: after.rev });
    }
    // E4: insert after an id, insert first, remove by id
    {
      const { path, ids } = await mk();
      await open(path);
      const r = await readOf(path);
      const res = await edit(path, r, { insert: [{ source: "y = 2", after: ids[0] }, { source: "top", type: "markdown", after: null }], remove: [ids[2]] });
      const cs = (await rec(path)).cells;
      ok(res.ok && cs.length === 4 && cs[0].code === "top" && cs[0].type === "markdown" && cs[1].id === ids[0] && cs[2].code === "y = 2" && cs[3].id === ids[1] && !cs.some((c) => c.id === ids[2]), "E4: an insert after an id, an insert first and a remove by id, each as asked", { res, cs: cs.map((c) => [c.id, c.type, c.code]) });
    }
    // E5, E6: three-way: the person changed another cell (applied, the person's change kept), or a named one (refused)
    {
      const { path, ids } = await mk();
      await open(path);
      const r = await readOf(path);
      await typeInto(0, " # mine");
      await untilSaved();
      const mid = await rec(path);
      const res = await edit(path, r, { set: [{ id: ids[1], source: "print(5)" }] });
      const a = byId((await rec(path)).cells), m = byId(mid.cells);
      ok(res.ok && a[ids[1]].code === "print(5)" && same(a[ids[0]], m[ids[0]]) && /# mine/.test(a[ids[0]].code), "E5: the person changed another cell since the read: the edit applies, and the person's change is kept byte-identical", { res, c0: a[ids[0]]?.code });
      const r2 = await readOf(path);
      await typeInto(1, " # theirs");
      await untilSaved();
      const mid2 = await rec(path);
      const res2 = await edit(path, r2, { set: [{ id: ids[1], source: "print(6)" }] });
      ok(!res2.ok && res2.code === "conflict" && /changed since/.test(res2.msg) && same(await rec(path), mid2), "E6: the person changed a named cell since the read: the whole edit is refused, the file byte-identical", res2);
    }
    // E7b, E8, E9, E10, E11, E19, E20: refused whole, the file byte-identical (each its own notebook, so one case's
    // outcome never reaches another's)
    const fresh = async () => {
      const n = await mk();
      await open(n.path);
      const r = await readOf(n.path), before = await rec(n.path);
      return { ...n, r, before, unchanged: async () => same(await rec(n.path), before) };
    };
    {
      const f = await fresh();
      const res = await edit(f.path, { ...f.r, ref: "another" }, { set: [{ id: f.ids[1], source: "z" }] });
      ok(!res.ok && (await f.unchanged()), "E7b: an edit naming another document (ref) is refused, the file byte-identical", res);
    }
    {
      const f = await fresh();
      const res = await edit(f.path, f.r, { set: [{ id: f.ids[1], source: "z" }, { id: "nosuch", source: "w" }] });
      await sleep(800); // (past the component's save debounce)
      ok(!res.ok && (await f.unchanged()) && (await shown())[1] === "print(2)", "E8: a valid change then an unknown id: refused whole, the file byte-identical, nothing changed here", res);
    }
    {
      const f = await fresh();
      const res = await edit(f.path, f.r, { remove: ["nosuch"] });
      ok(!res.ok && (await f.unchanged()), "E9: a remove of an unknown id is refused, not ignored", res);
    }
    {
      const f = await fresh();
      const res = await edit(f.path, f.r, { set: [{ id: f.ids[1], type: "markdown" }] });
      await sleep(800);
      const ok1 = !res.ok && (await f.unchanged());
      const g = await fresh();
      const res2 = await edit(g.path, g.r, { set: [{ id: g.ids[2], type: "code" }] });
      ok(ok1 && res2.ok && ((await rec(g.path)).cells[2].type ?? "code") === "code", "E10: code -> markdown on a cell with outputs is refused (it would drop them); markdown -> code is applied", [res, res2]);
    }
    {
      const f = await fresh();
      const res = await edit(f.path, f.r, { set: [{ id: f.ids[1], source: "z", outputs: [] }] });
      const res2 = await edit(f.path, f.r, { set: [{ id: f.ids[1], type: "raw" }] });
      await sleep(800);
      ok(!res.ok && !res2.ok && res.code === "invalid" && (await f.unchanged()), "E11: an extra field, or a type outside the grammar, is refused whole by the page", [res, res2]);
    }
    {
      const f = await fresh();
      const res = await edit(f.path, f.r, { set: [{ id: f.ids[1], source: "a" }, { id: f.ids[1], source: "b" }] });
      const res2 = await edit(f.path, f.r, { set: [{ id: f.ids[1], source: "a" }], remove: [f.ids[1]] });
      await sleep(800);
      ok(!res.ok && !res2.ok && (await f.unchanged()), "E19: an id named twice (set twice, or set and removed) is refused", [res, res2]);
    }
    {
      const f = await fresh();
      const res = await edit(f.path, f.r, { insert: Array.from({ length: 201 }, (_, i) => ({ source: `${i}`, after: null })) });
      await sleep(800);
      const ok1 = !res.ok && (await f.unchanged());
      const g = await fresh();
      const res2 = await edit(g.path, g.r, { insert: Array.from({ length: 200 }, (_, i) => ({ source: `${i}`, after: null })) });
      ok(ok1 && res2.ok && (await rec(g.path)).cells.length === 203, "E20: 201 changes are refused; 200 in one edit are applied", [res, res2.ok || res2]);
    }
    // E12, E13: no notebook is rewritten whole: create on a taken path, a raw write from this helper
    {
      const { path } = await mk();
      const before = await rec(path);
      const c = await call("workspace.create", { path, content: docFor(path, [{ code: "over" }]), mode: "python" }).then(() => "made", (e) => e.code);
      ok(c === "exists" && same(await rec(path), before), "E12: create on a taken notebook path is refused, the file byte-identical", c);
    }
    {
      // (its own notebook: what E12 does to its one never reaches this case)
      const { path } = await mk();
      const before = await rec(path);
      const r = await call("workspace.read", { path });
      const w = await call("workspace.write", { path, content: docFor(path, [{ code: "over" }]), base: r.rev }).then(() => "written", (e) => e.message);
      ok(/workspace_edit_notebook/.test(w) && same(await rec(path), before), "E13: a whole write of a notebook from a notebook.edit helper is refused", w);
    }
    // E14: a notebook not open: the page opens it, then applies
    {
      const { path, ids } = await mk();
      const r = await readOf(path);
      const res = await edit(path, r, { set: [{ id: ids[0], source: "x = 7" }] });
      ok(res.ok && (await ev(`!!${tabJs(path)}`)) && (await rec(path)).cells[0].code === "x = 7", "E14: a notebook that isn't open is opened (its tab), then edited", res);
    }
    // E18: applyEdits throwing after its first change (a test hook): put back, nothing saved, during or after
    {
      const { path, ids } = await mk();
      await open(path);
      const r = await readOf(path);
      const before = await rec(path);
      await ev(`(window.__sbTestApplyEdits = (comp, e) => { comp.applyEdits({ set: e.set.slice(0, 1), insert: [], remove: [] }, { run: false }); throw new Error("injected"); }, true)`);
      const res = await edit(path, r, { set: [{ id: ids[0], source: "x = 8" }, { id: ids[1], source: "print(8)" }] });
      await ev(`(delete window.__sbTestApplyEdits, true)`);
      const now = await rec(path);
      await sleep(1500); // (past the component's save debounce: no late save)
      const later = await rec(path);
      ok(!res.ok && /nothing changed/.test(res.msg) && same(now, before) && same(later, before) && (await shown())[0] === "x = 1", "E18: an apply that throws midway is put back: nothing saved, no version, during or after", { res, rev: [before.rev, now.rev, later.rev] });
    }
    // E16a (read only under sync's journal), E16b (closing): refused, nothing changed
    {
      const { path, ids } = await mk();
      await open(path);
      const r = await readOf(path);
      const before = await rec(path);
      await lockWorkspace();
      await ev(`document.querySelector('#close').click()`);
      await sleep(300);
      const res = await edit(path, r, { set: [{ id: ids[0], source: "x = 9" }] });
      await ev(`window.__release()`);
      await sleep(500);
      ok(!res.ok && /closing|isn't saved here/.test(res.msg) && same(await rec(path), before), "E16b: an edit of a notebook while its pane closes is refused, nothing changed", res);
    }
    {
      const fence0 = await record(FENCE);
      try {
        const { path, ids } = await mk();
        const r = await readOf(path);
        const before = await rec(path);
        await putRecord({ ...(fence0 ?? { id: FENCE, workspace: "test", generation: 1, step: 1 }), phase: "journal", journal: 1 });
        await open(path);
        const res = await edit(path, r, { set: [{ id: ids[0], source: "x = 10" }] });
        ok(!res.ok && /read only/.test(res.msg) && same(await rec(path), before), "E16a: under sync's journal the pane is read only: an edit is refused, nothing changed", res);
      } finally {
        if (fence0) await putRecord(fence0);
      }
    }
    // E21 (astra's C1): the authority lost while the edit waits, at each of its waits W1-W4 (r2.6), by the turn
    // finishing (a) or the person revoking the grant (b); E21c: another turn started meanwhile. Refused, nothing changed.
    const lose = async (how) => {
      if (how === "a") event(turn, { type: "turn_finished", outcome: "completed" });
      else if (how === "c") { event(turn, { type: "turn_finished", outcome: "completed" }); newTurn(); }
      else await ev(`[...document.querySelectorAll('.sbag-bar button')].find((b) => b.textContent === 'Revoke')?.click()`);
    };
    // (after a revoke: paired again, a new chat and turn, as before this section's first case)
    const regain = async (how) => {
      if (how === "b") { await ev(`document.querySelector('#new')?.click()`); await sleep(700); await pair(); await converse(); turn = `t${++turnN}`; event(turn, { type: "turn_started" }); }
      else if (how === "a") newTurn();
    };
    for (const w of ["W1", "W2", "W3", "W4"]) for (const how of w === "W3" ? ["a", "b", "c"] : ["a", "b"]) {
      const { path, ids } = await mk();
      if (w !== "W1") await open(path);
      const r = await readOf(path);
      const before = await rec(path);
      if (w === "W1") await holdDb("sagebrush-workspace", "entries", 3000); // (its mount's stat waits)
      if (w === "W2") { await lockWorkspace(); await typeInto(0, " # mine"); } // (its preliminary save waits for the lock)
      if (w === "W3") await holdDb("sagebrush", "notebooks", 3000); // (the record read waits)
      if (w === "W4") await holdDb("sagebrush-workspace", "entries", 3000); // (the document's stat waits; the record read doesn't)
      const pending = edit(path, r, { set: [{ id: ids[1], source: "print('AGENT')" }] });
      await sleep(700);
      await lose(how);
      if (w === "W2") await ev(`window.__release()`);
      const res = await pending;
      await sleep(900);
      const after = await rec(path);
      const agentNone = !after.cells.some((c) => /AGENT/.test(c.code ?? ""));
      const name = how === "c" ? "E21c" : `E21-${w}${how}`;
      const what = how === "a" ? "the turn finished" : how === "b" ? "the grant was revoked" : "another turn started";
      ok(!res.ok && agentNone && (w === "W2" ? /# mine/.test(after.cells[0].code) : same(after, before)), `${name}: ${what} while the edit waited at ${w}: refused, nothing of it written${w === "W2" ? " (the person's own text saved, as theirs)" : ", the file byte-identical"}`, { res, rev: [before.rev, after.rev] });
      await regain(how === "c" ? "none" : how);
    }
    // E22 (C2, final) and E22b (C2, preliminary): a save the store refuses ("not saved: ...") while saved() still
    // resolves: never answered ok, nothing applied or written
    const refuseNext = () => ev(`(() => { let n = 0; window.__sbTestStoreSave = () => (n++ === 0 ? "not saved: (test)" : null); return true; })()`);
    const refuseNone = () => ev(`(delete window.__sbTestStoreSave, true)`);
    {
      const { path, ids } = await mk();
      await open(path);
      const r = await readOf(path);
      const before = await rec(path);
      await refuseNext();
      const res = await edit(path, r, { set: [{ id: ids[1], source: "print(22)" }] });
      await refuseNone();
      ok(!res.ok && /not saved/.test(res.msg) && same(await rec(path), before), "E22: the edit's final save refused by the store: answered not ok, the record unchanged", res);
    }
    {
      const { path, ids } = await mk();
      await open(path);
      const r = await readOf(path);
      const before = await rec(path);
      await typeInto(0, " # p");
      await refuseNext();
      const res = await edit(path, r, { set: [{ id: ids[1], source: "print(23)" }] });
      await refuseNone();
      ok(!res.ok && /couldn't be saved first/.test(res.msg) && same(await rec(path), before) && /# p/.test((await shown())[0]) && (await shown())[1] === "print(2)", "E22b: the person's pending change refused by the store: refused before anything is applied, the record unchanged, their text shown", res);
    }
    // E23, E23b (C3): the rollback keeps the revision it was saved at, so the person's next save conflicts with another
    // tab's change and merges it: E23 with that change made after the rollback, E23b with it made during the apply
    const otherTab = (ref, i, text) => ev(`(async () => { const r = await ${IDB}.get(${JSON.stringify(ref)}); r.cells[${i}].code = ${JSON.stringify(text)}; r.rev = (r.rev ?? 0) + 1; await ${IDB}.put(r); return r.rev; })()`);
    for (const during of [false, true]) {
      const { path, ids } = await mk(null, { form: true });
      await open(path);
      const r = await readOf(path);
      const ref = refs.get(path);
      // (during: the hook writes the other tab's change, as that tab would, before it throws)
      const inPage = `const x = await ${IDB}.get(${JSON.stringify(ref)}); x.cells[2].code = "# other tab"; x.rev = (x.rev ?? 0) + 1; await ${IDB}.put(x);`;
      await ev(`(window.__sbTestApplyEdits = (comp, e) => { comp.applyEdits({ set: e.set.slice(0, 1), insert: [], remove: [] }, { run: false }); ${during ? `return (async () => { ${inPage} throw new Error("injected"); })();` : `throw new Error("injected");`} }, true)`);
      const res = await edit(path, r, { set: [{ id: ids[0], source: "x = 8" }, { id: ids[1], source: "print(8)" }] });
      await ev(`(delete window.__sbTestApplyEdits, true)`);
      if (!during) await otherTab(ref, 2, "# other tab");
      await typeInto(1, " # mine");
      await sleep(2500); // (its save, its conflict with the other tab's write, the merge and its save)
      const cs = (await rec(path)).cells;
      ok(!res.ok && cs[2].code === "# other tab" && /# mine/.test(cs[1].code) && cs[0].code === "x = 1", `${during ? "E23b" : "E23"}: after a rollback, another tab's change (made ${during ? "during the apply" : "after it"}) and the person's next edit both survive`, { res, cs: cs.map((c) => c.code) });
    }
    // E24 (board's BA12-1): the person types in another artifact while the agent edits a notebook, first one not open,
    // then one open in a hidden tab: the pane stays, the focus and the caret too, and the notebook's tab says it changed
    {
      const draft = "/notes/draft.txt";
      await call("workspace.create", { path: draft, content: { text: "abcdef" } }).catch(() => null);
      await artifactTurn(draft, { finish: false, turn });
      await until(`!!document.querySelector('${PANE} textarea')`);
      const focusDraft = () => ev(`(() => { const t = document.querySelector('${PANE} textarea'); t.focus(); t.setSelectionRange(3, 3); return true; })()`);
      const state = () => ev(`(() => { const t = document.activeElement; return { tab: document.querySelector('#artifacts .tab.on')?.dataset.tab, tag: t?.tagName, inDraft: !!t?.closest('${PANE}') && t?.tagName === 'TEXTAREA', caret: t?.selectionStart }; })()`);
      const results = [];
      for (const hidden of [false, true]) {
        const { path, ids } = await mk();
        if (hidden) { await open(path); await ev(`${tabJs(draft)}.click()`); await sleep(300); }
        await focusDraft();
        const r = await readOf(path);
        const res = await edit(path, r, { set: [{ id: ids[1], source: "print(24)" }] });
        await sleep(300);
        const st = await state();
        const changedTab = await ev(`/changed/.test(${tabJs(path)}?.textContent ?? '')`);
        const stored = (await rec(path)).cells[1].code === "print(24)";
        results.push({ hidden, res: res.ok, st, changedTab, stored });
      }
      ok(results.every((x) => x.res && x.st.tab === draft && x.st.inDraft && x.st.caret === 3 && x.changedTab && x.stored), "E24: the agent's edit of a notebook (not open, then in a hidden tab) leaves the shown tab, the focus and the caret as they were; its tab says it changed; the edit is stored", results);
    }
    event(turn, { type: "turn_finished", outcome: "completed" });
  }
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
  console.log("the page said:\n  " + logs.slice(-20).join("\n  "));
  console.log("cells: " + JSON.stringify(await ev(`[...document.querySelectorAll('#artifacts .cell')].map((c) => [c.className, c.querySelector('.n')?.textContent, c.querySelector('.time')?.textContent, c.querySelector('.out')?.textContent.slice(0, 200)])`).catch((x) => String(x))));
  console.log("workers: " + JSON.stringify(workers));
} finally {
  cdp.close();
  chrome.kill("SIGKILL");
  server.kill();
  daemon.stop(true);
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
