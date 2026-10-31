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
  console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : ""));
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
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocol: 1, agent: { name: "Claude", client: "claude-agent-sdk", version: "0.3.0" }, wants: { folders: ["/"], write: true, run: true } } }));
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
const logs = []; // (the page's errors and warnings: shown when something fails)
cdp.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m.result ?? m.error);
    waiting.delete(m.id);
  } else if (m.method === "Network.requestWillBeSent") requested.push(m.params.request.url);
  else if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") {
    workers.push(m.params.targetInfo.url);
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
    await typeInto(0, "  # mine");
    const afterEdit = await ev(`[...${cellJs(0)}.querySelectorAll('.nb-agent-mark')].length`);
    ok(afterEdit === 0, "the label goes when the person edits that cell", afterEdit);

    // ---- the first Run: lazy, and it runs the code the cell had at the click (the agent's write meanwhile doesn't)
    const rev0 = (await call("workspace.read", { path: "/notes/plot.ipynb" })).rev;
    await ev(`${cellJs(1)}.querySelector('.runb').click()`);
    await call("workspace.write", { path: "/notes/plot.ipynb", content: docFor("/notes/plot.ipynb", [{ code: "x = 1" }, { code: "print('NEW')" }, { type: "markdown", code: "Some *text*" }]), base: rev0 }).catch((e) => e);
    await until(`/OLD|NEW/.test([...document.querySelectorAll('${PANE} .cell .out')].map((o) => o.textContent).join())`, 120000);
    const o1 = await outs();
    ok(/OLD/.test(o1) && !/NEW/.test(o1), "the run executes the cell's code at the click, not the agent's write that landed while the kernel started", o1);
    ok(workerCount() === 1, "the kernel worker starts on the first Run, not before", workers);
    ok((await ev(`[...${cellJs(1)}.querySelectorAll('.nb-agent-mark')].length`)) === 0, "the label goes when the cell runs");
    ok(await ev(`document.querySelector('#stop').textContent === 'Stop Claude'`), "the chat's Stop is named after the agent");

    // ---- an incoming change runs nothing
    await sleep(500);
    await write("/notes/plot.ipynb", [{ code: "x = 1" }, { code: "print('AGENT-RAN', x)" }, { type: "markdown", code: "Some *text*" }], { autorun: "always" });
    await until(`[...document.querySelectorAll('${PANE} .cell textarea')].some((t) => t.value.includes('AGENT-RAN'))`, 10000).catch(() => {});
    await sleep(2500);
    const o2 = await outs();
    ok((await shown()).some((v) => v.includes("AGENT-RAN")) && !/AGENT-RAN/.test(o2), "the agent's change is shown, and runs nothing (no applyEdits, no autorun)", { o2, cells: await shown() });
    // ---- a Run runs that cell only: the agent's cell, which reads x, doesn't run with the cell that sets x (the
    // reactive notebook's autorun would run it: its stale descendants, notebook.js 843)
    await ev(`${cellJs(0)}.querySelector('.runb').click()`);
    await until(`/\\[\\d+\\]/.test(${cellJs(0)}.querySelector('.n').textContent)`, 60000);
    await sleep(2500);
    const o3 = await outs();
    ok(!/AGENT-RAN/.test(o3), "the person's Run runs that cell only: the agent's cell that depends on it doesn't run with it (no autorun)", { o3 });
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
    await ev(`document.querySelector('#artifacts .tab').focus()`);
    await key("Escape");
    await sleep(300);
    ok(!(await ev(`document.body.classList.contains('fullscreen')`)), "Escape from the pane's own tabs still leaves full screen");
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
    await size(1280);
    const gutter = () => ev(`[document.querySelector('${PANE} .nb-root').clientWidth, getComputedStyle(document.querySelector('${PANE} .sbnb')).getPropertyValue('--gutter').trim()]`);
    const wide = await gutter();
    ok(wide[0] > 640 && wide[1] !== "44px", "the pane at its width (1280 px window) has the full layout", wide);
    await ev(`document.head.append(Object.assign(document.createElement('style'), { id: 'narrow', textContent: 'body.has-artifact.wide-artifact #artifacts { width: 589px; }' }))`);
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
    ok(await ev(`document.body.classList.contains('has-artifact') && ${cellJs(0)}.classList.contains('running')`), "Cancel keeps the pane, the cell still running");
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

  // ======================================================================== the journal: read only in the pane
  if (want("journal")) {
    const path = "/notes/journal.ipynb";
    await call("workspace.create", { path, content: docFor(path, [{ code: "j = 1" }]), mode: "python" });
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
      ok(v === "j = 1" && rec.cells[0].code === "j = 1" && runs && open && /readonly/.test(bar), "under sync's journal the pane is read only: an edit changes nothing, Run is off, Open in Sagebrush is offered", { v, saved: rec.cells[0].code, runs, open, bar });
    } finally {
      if (fence0) await putRecord(fence0);
    }
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
