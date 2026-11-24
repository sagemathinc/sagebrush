// ci: web-browser/space order=60 runner=bun chrome
// A .space.json in the Agents chat, end to end in headless Chromium against the built site, served by web/serve.py and
// reached by DEV's name (the browser maps dev.sagebrush.space to this machine), where the 3D view is offered; paired as a person pairs it with a stand-in for sagebrush-agent that writes the file with
// the workspace verbs and shows it as an artifact, as the daemon does after workspace_write. Checks: the 3D view
// appears in the pane; a click's selection is written to the file as "selected"; the agent's next write shows up with
// the camera and selection kept; a selection that names no object of the space, or a too-long id, isn't written; an
// agent's write between a click and its saving is kept, the selection put on it; a note's HTML is only formatting;
// the pane reads no files for the view.
//   (after a site build: bun web/build.ts)   CHROME=chromium bun web/space/test-agents-space.mjs
// (condensed from web/agents/test-agents-artifacts.mjs: its pairing and stand-in)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("FAIL the suite didn't end in 240 s"); process.exit(1); }, 240_000).unref();

let server = null;
const sitePort = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const site = `http://dev.sagebrush.space:${sitePort}`;

// ---- the stand-in agent
let sock = null, nextId = 1;
const pending = new Map(), notes = [];
const daemon = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/sagebrush" && srv.upgrade(req)) return;
    return new Response("not here", { status: 404 });
  },
  websocket: {
    message(ws, data) {
      const m = JSON.parse(String(data));
      if (m.method === "hello") {
        sock = ws;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocol: 1, agent: { name: "Claude", client: "claude-agent-sdk", version: "0.3.0" }, wants: { folders: ["/"], write: true, run: false } } }));
      } else if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.no(Object.assign(new Error(m.error.message), { code: m.error.data?.code }));
        else p.ok(m.result);
      } else if (m.method) notes.push(m);
    },
  },
});
const call = (method, params) => new Promise((ok_, no) => {
  if (!sock) return no(new Error("no page paired"));
  const id = "s" + nextId++;
  pending.set(id, { ok: ok_, no });
  sock.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
});
let conv = null, turnN = 0;
const event = (turn_id, e) => sock.send(JSON.stringify({ jsonrpc: "2.0", method: "turn.event", params: { conversation: conv, turn_id, event: e } }));
const textOf = (r) => (typeof r.content === "string" ? r.content : r.content?.text ?? JSON.stringify(r.content));

// ---- the browser (WebGL in software)
const profile = mkdtempSync(join(tmpdir(), "sb-space-agents-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--password-store=basic",
  "--host-resolver-rules=MAP dev.sagebrush.space 127.0.0.1", `--unsafely-treat-insecure-origin-as-secure=${site}`,
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1500,900", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
process.on("exit", () => { chrome.kill("SIGKILL"); server?.kill("SIGKILL"); });
const cdpPort = await devtoolsPort(profile, undefined, { child: chrome });
let targets;
for (let i = 0; i < 300 && !targets; i++) targets = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json(), () => sleep(100).then(() => undefined));
const cdp = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (cdp.onopen = r));
let n = 0, loads = 0;
const waiting = new Map(), logs = [], contexts = [];
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  else if (m.method === "Page.loadEventFired") loads++;
  else if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
  else if (m.method === "Runtime.exceptionThrown") logs.push("exception: " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
};
const send = (method, params = {}, ms = 30000) => Promise.race([new Promise((r) => { const id = ++n; waiting.set(id, r); cdp.send(JSON.stringify({ id, method, params })); }), sleep(ms).then(() => ({ timeout: method }))]);
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result?.value;
};
const until = async (expr, ms = 20000) => {
  for (const t = Date.now(); Date.now() - t < ms; ) { if (await ev(expr).catch(() => false)) return true; await sleep(100); }
  const page = await ev(`({ href: location.href, text: (document.body?.innerText ?? "").slice(0, 300) })`).catch((e) => String(e));
  throw new Error("timeout: " + expr + "\n  page: " + JSON.stringify(page) + "\n  logs: " + JSON.stringify(logs.slice(-8)));
};
// (in the view's own frame, as the viewer itself would post)
const inFrame = async (expr) => {
  const ctx = contexts.filter((c) => c.auxData?.isDefault && c.auxData?.frameId && c.auxData.frameId !== contexts[0]?.auxData?.frameId).at(-1);
  const r = await send("Runtime.evaluate", { contextId: ctx?.id, awaitPromise: true, returnByValue: true, expression: expr });
  return r.result?.value;
};
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });

// ---- pair (a ?pair= link, Connect, Allow everything), then a chat
const before = loads;
const nav = await send("Page.navigate", { url: `${site}/agents/?pair=123-456&port=${daemon.port}` });
if (!nav?.frameId || nav.errorText) throw new Error("navigate: " + JSON.stringify(nav));
for (let t = Date.now(); loads === before && Date.now() - t < 20000; ) await sleep(50);
await until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Connect' && b.offsetParent)`);
await ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Connect' && b.offsetParent).click()`);
await until(`[...document.querySelectorAll('button')].some((b) => b.textContent === 'Allow' && b.offsetParent)`);
await ev(`(() => { const all = [...document.querySelectorAll('label')].find((l) => l.textContent.startsWith('Everything')).querySelector('input'); all.checked = true; all.dispatchEvent(new Event('change')); [...document.querySelectorAll('button')].find((b) => b.textContent === 'Allow').click(); })()`);
await until(`document.querySelector('#connect').textContent === 'Connected'`);
ok(true, "paired");
await ev(`document.querySelector('#new').click()`);
await until(`!!document.querySelector('[data-try]')?.offsetParent`);
await ev(`document.querySelector('[data-try]').click()`);
for (let t = Date.now(); !notes.some((m) => m.method === "chat.message") && Date.now() - t < 5000; ) await sleep(50);
conv = notes.find((m) => m.method === "chat.message")?.params.conversation;
if (!conv) throw new Error("no chat.message from the page");

// ---- the agent writes a space (as workspace_write does) and the daemon shows it as an artifact
const path = "/intro.space.json";
const space = JSON.parse(readFileSync(join(here, "examples", "intro.space.json"), "utf8"));
await call("workspace.create", { path, content: { text: JSON.stringify(space, null, 1) } });
const t = `t${++turnN}`;
event(t, { type: "turn_started" });
event(t, { type: "text_delta", message: "m0", revision: 1, text: "Here it is in 3D." });
event(t, { type: "artifact", id: path, kind: "code", lang: "json", title: "intro.space.json", path, body: "" });
event(t, { type: "turn_finished", outcome: "completed" });
const W = `document.querySelector('#artifacts .pane-host:not([hidden]) .space-frame')?.contentWindow?.space3d`;
await until(`(${W})?.space?.nodes?.length === ${space.nodes.length}`, 30000);
ok(true, `the 3D view is shown in the pane (${space.nodes.length} objects)`);
ok(await ev(`performance.getEntriesByType("resource").some((r) => r.name.endsWith("/sagebrush-space3d.js"))`), "its chunk was fetched for it");
const box = await ev(`(() => { const r = document.querySelector('.space-frame').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`);
ok(box[0] > 500 && box[1] > 600, "the frame fills the pane", box);

// ---- the person selects an object: the agent reads it in the file
const pick = space.nodes.find((x) => x.kind === "code");
await ev(`(${W}).select(${JSON.stringify(pick.id)})`);
await sleep(1500);
const read1 = await call("workspace.read", { path });
ok(JSON.parse(textOf(read1)).selected === pick.id, `the selection is in the file: "selected": ${JSON.stringify(pick.id)}`, JSON.parse(textOf(read1)).selected);
const camBefore = await ev(`(${W}).camera.position.toArray().map((x) => +x.toFixed(2))`);

// ---- the agent writes the space again (one more object, on the revision it read)
const next = { ...JSON.parse(textOf(read1)), nodes: [...space.nodes, { id: "added", kind: "note", title: "Added by the agent", text: "A new note with $\\frac{p}{q}$.\n\n<img src=x onerror=\"parent.__pwned = 1\"> <script>parent.__pwned = 2</script> <b>bold</b>" }] };
const w2 = await call("workspace.write", { path, content: { text: JSON.stringify(next, null, 1) }, base: read1.rev });
await until(`(${W})?.space?.nodes?.length === ${space.nodes.length + 1}`, 10000);
ok(true, "the agent's rewrite shows up in the view");
ok((await ev(`(${W}).selection?.id`)) === pick.id, "the selection is kept");
const camAfter = await ev(`(${W}).camera.position.toArray().map((x) => +x.toFixed(2))`);
ok(JSON.stringify(camAfter) === JSON.stringify(camBefore), "the camera is kept", [camBefore, camAfter]);

// ---- a note's Markdown: raw HTML only formatting, never a script
await ev(`(${W}).select("added")`);
const DOC = `document.querySelector('#artifacts .pane-host:not([hidden]) .space-frame').contentDocument`;
await until(`!!${DOC}.querySelector('[data-c="overlay"] .md b')`, 10000);
ok((await ev(`${DOC}.querySelector('[data-c="overlay"] .md b')?.textContent ?? null`)) === "bold", "a note's formatting HTML is kept");
await sleep(300);
ok((await ev(`window.__pwned ?? null`)) === null && (await ev(`${DOC}.querySelectorAll('[data-c="overlay"] .md script, [data-c="overlay"] .md [onerror]').length`)) === 0, "a note's script and handlers never run (nor are kept)");
await sleep(1200);
const read2 = await call("workspace.read", { path });
ok(JSON.parse(textOf(read2)).selected === "added" && JSON.parse(textOf(read2)).nodes.length === space.nodes.length + 1, "a new selection replaces it, and keeps the agent's objects");

// ---- a selection is written only when it names an object of the space shown
const post = (sel) => inFrame(`(window.parent.postMessage({ sagebrush: "space-select", version: 1, selection: ${JSON.stringify(sel)} }, location.origin), true)`);
await post({ id: "no-such-object" });
await sleep(1200);
ok(JSON.parse(textOf(await call("workspace.read", { path }))).selected === "added", "a selection naming no object of the space isn't written");
await post({ id: "x".repeat(2000) });
await sleep(1200);
ok(JSON.parse(textOf(await call("workspace.read", { path }))).selected === "added", "nor one with a 2,000-character id");
await post({ id: 7 });
await sleep(1200);
ok(JSON.parse(textOf(await call("workspace.read", { path }))).selected === "added", "nor one whose id isn't text");
await post(null);
await sleep(1200);
ok(JSON.parse(textOf(await call("workspace.read", { path }))).selected === null, "and none (null) is written as null");

// ---- the agent writes between a click and its saving: its write is kept, the selection put on it
const read3 = await call("workspace.read", { path });
await post({ id: pick.id });
const third = { ...JSON.parse(textOf(read3)), nodes: [...JSON.parse(textOf(read3)).nodes, { id: "later", kind: "note", title: "Written meanwhile" }] };
await call("workspace.write", { path, content: { text: JSON.stringify(third, null, 1) }, base: read3.rev });
await sleep(2000);
const after = JSON.parse(textOf(await call("workspace.read", { path })));
ok(after.nodes.some((x) => x.id === "later") && after.selected === pick.id, "the agent's newer write is kept, and the selection is on it", { selected: after.selected, n: after.nodes.length });

// ---- the pane reads no files for the view
const refused = await inFrame(`new Promise((res) => { const h = (e) => { if (e.data?.sagebrush === "space-file" && e.data.id === 7001) { removeEventListener("message", h); res(e.data.error ?? "read"); } };
  addEventListener("message", h); window.parent.postMessage({ sagebrush: "space-read", version: 1, id: 7001, path: "intro.space.json" }, location.origin);
  setTimeout(() => res("no answer"), 3000); })`);
ok(/only Open in 3D reads your files/.test(refused), "a read asked of the Agents pane is refused at once", refused);

if (logs.length) console.log("page logs:", logs.slice(-10));
ok(!logs.some((l) => l.startsWith("exception")), "no page errors", logs.slice(-3));
daemon.stop(true);
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
