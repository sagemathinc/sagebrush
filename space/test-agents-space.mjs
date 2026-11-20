// A space in the agents chat, end to end in headless Chromium: the built site (web/dist, with the space built into
// web/dist/space), served by web/serve.py, paired as a person pairs it with a stand-in for sagebrush-agent that
// writes a .space.json with the workspace verbs and shows it as an artifact, as the daemon does after workspace_write.
// Checks: the space appears in the pane; a click's selection is written to the file as "selected"; the agent's next
// write shows up in the space with the camera and selection kept.
//   bun web/build.ts && (cd space && node build.mjs --site ../web/dist) && bun web/csp.ts
//   CHROME=chromium bun space/test-agents-space.mjs [shot.png]
// (condensed from web/agents/test-agents-artifacts.mjs: its pairing and stand-in)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../web/test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => {
  console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : ""));
  if (!c) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sitePort = await startServe(() => spawn("python3", [join(here, "..", "web", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] })).port;
const site = `http://127.0.0.1:${sitePort}`;

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

// ---- the browser (WebGL in software)
const profile = mkdtempSync(join(tmpdir(), "sb-space-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--password-store=basic",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1500,900", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
process.on("exit", () => { chrome.kill("SIGKILL"); });
const cdpPort = await devtoolsPort(profile, undefined, { child: chrome });
let targets;
for (let i = 0; i < 300 && !targets; i++) targets = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json(), () => sleep(100).then(() => undefined));
const cdp = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (cdp.onopen = r));
let n = 0, loads = 0;
const waiting = new Map(), logs = [];
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  else if (m.method === "Page.loadEventFired") loads++;
  else if (m.method === "Runtime.exceptionThrown") logs.push("exception: " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
  else if (m.method === "Runtime.consoleAPICalled" && /error|warn/.test(m.params.type)) logs.push(m.params.type + ": " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); cdp.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result?.value;
};
const until = async (expr, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); }
  const page = await ev(`({ href: location.href, text: (document.body?.innerText ?? "").slice(0, 300) })`).catch((e) => String(e));
  throw new Error("timeout: " + expr + "\n  page: " + JSON.stringify(page) + "\n  logs: " + JSON.stringify(logs.slice(-8)));
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
const path = "/modular.space.json";
const space = JSON.parse(readFileSync(join(here, "public", "demo.space.json"), "utf8"));
await call("workspace.create", { path, content: { text: JSON.stringify(space, null, 1) } });
let t = `t${++turnN}`;
event(t, { type: "turn_started" });
event(t, { type: "text_delta", message: "m0", revision: 1, text: "Here it is in 3D." });
event(t, { type: "artifact", id: path, kind: "code", lang: "json", title: "modular.space.json", path, body: "" });
event(t, { type: "turn_finished", outcome: "completed" });
const W = `document.querySelector('#artifacts .pane-host:not([hidden]) .space-frame')?.contentWindow?.whitespace`;
await until(`(${W})?.space?.nodes?.length === ${space.nodes.length}`, 30000);
ok(true, `the space is shown in the pane (${space.nodes.length} objects)`);
const box = await ev(`(() => { const r = document.querySelector('.space-frame').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`);
ok(box[0] > 500 && box[1] > 600, "the frame fills the pane", box);

// ---- the person selects an object: the agent reads it in the file
const pick = space.nodes.find((x) => x.kind === "code") ?? space.nodes[0];
await ev(`(${W}).select(${JSON.stringify(pick.id)})`);
await sleep(1500);
const read1 = await call("workspace.read", { path });
const text1 = typeof read1.content === "string" ? read1.content : read1.content?.text ?? JSON.stringify(read1.content);
ok(JSON.parse(text1).selected === pick.id, `the selection is in the file: "selected": ${JSON.stringify(pick.id)}`, JSON.parse(text1).selected);
const camBefore = await ev(`(${W}).camera.position.toArray().map((x) => +x.toFixed(2))`);

// ---- the agent writes the space again (one more object, on the revision it read)
const next = { ...JSON.parse(text1), nodes: [...space.nodes, { id: "added", kind: "note", title: "Added by the agent", text: "A new note with $\\frac{p}{q}$ and\n\n$$\\sum_{n \\ge 1} a_n q^n$$\n\n<img src=x onerror=\"parent.__pwned = 1\"> <script>parent.__pwned = 2</script> <b>bold</b>" }] };
await call("workspace.write", { path, content: { text: JSON.stringify(next, null, 1) }, base: read1.rev });
await until(`(${W})?.space?.nodes?.length === ${space.nodes.length + 1}`, 10000);
ok(true, "the agent's rewrite shows up in the space");
ok((await ev(`(${W}).selection?.id`)) === pick.id, "the selection is kept");
const camAfter = await ev(`(${W}).camera.position.toArray().map((x) => +x.toFixed(2))`);
ok(JSON.stringify(camAfter) === JSON.stringify(camBefore), "the camera is kept", [camBefore, camAfter]);

// ---- deselect (Escape in the space): null in the file
await ev(`(${W}).select("added")`);
await sleep(1200);
const read2 = await call("workspace.read", { path });
const text2 = typeof read2.content === "string" ? read2.content : read2.content?.text ?? JSON.stringify(read2.content);
ok(JSON.parse(text2).selected === "added", "a new selection replaces it");
ok(JSON.parse(text2).nodes.length === space.nodes.length + 1, "the selection write keeps the agent's objects");
// (a note's Markdown: math typeset with KaTeX; raw HTML only formatting, never a script)
const DOC = `document.querySelector('#artifacts .pane-host:not([hidden]) .space-frame').contentDocument`;
await until(`${DOC}.querySelectorAll('#overlay .md .katex').length === 2`, 10000).then(() => ok(true, "a note's math is typeset (inline and display)"), (e) => ok(false, "a note's math is typeset", String(e).slice(0, 200)));
ok((await ev(`${DOC}.querySelector('#overlay .md b')?.textContent ?? null`)) === "bold", "a note's formatting HTML is kept");
await sleep(300);
ok((await ev(`window.__pwned ?? null`)) === null && (await ev(`${DOC}.querySelectorAll('#overlay .md script, #overlay .md [onerror]').length`)) === 0, "a note's script and handlers never run (nor are kept)");

// ---- code runs in the space, on the site's own engine
const D = `document.querySelector('#artifacts .pane-host:not([hidden]) .space-frame').contentDocument`;
await ev(`(${W}).select(${JSON.stringify(pick.id)})`);
await until(`!!${D}.querySelector('#overlay:not([hidden]) .runbar')`);
await ev(`${D}.querySelector('#overlay .runbar .run').click()`);
try {
  await until(`/^(done|failed) in/.test(${D}.querySelector('#overlay .runstate').textContent)`, 120000);
  const st = await ev(`${D}.querySelector('#overlay .runstate').textContent`);
  ok(st.startsWith("done"), "Run in the embedded space: " + st, await ev(`${D}.querySelector('#overlay .output').textContent.slice(0, 120)`));
} catch (e) {
  ok(false, "Run in the embedded space", String(e).slice(0, 300));
}

// ---- a Run without an edit keeps no copy of the code: the agent's next version of it is what shows (and runs)
const kept = await ev(`(() => { const f = document.querySelector('.space-frame').contentWindow; const k = Object.keys(f.localStorage).find((k) => k.endsWith(':' + ${JSON.stringify(pick.id)})); return k ? JSON.parse(f.localStorage.getItem(k)) : null; })()`);
ok(kept && kept.text === null && typeof kept.base === "string", "a Run without an edit keeps the output, not the code", kept && { text: kept.text, base: kept.base?.slice(0, 30) });
// (and an edit made here, to another object, is kept through the agent's rewrite of something else)
const other = space.nodes.find((x) => x.kind === "code" && x.id !== pick.id);
await ev(`(() => { const W = ${W}; W.select(${JSON.stringify(other.id)}); return true; })()`);
await until(`!!${DOC}.querySelector('#overlay:not([hidden]) textarea')`);
await ev(`(() => { const ta = ${DOC}.querySelector('#overlay textarea'); ta.value = 'print("edited here")'; ta.dispatchEvent(new Event('input')); return true; })()`);
const read3 = await call("workspace.read", { path });
const text3 = typeof read3.content === "string" ? read3.content : read3.content?.text ?? JSON.stringify(read3.content);
const third = JSON.parse(text3);
third.nodes = third.nodes.map((x) => (x.id === pick.id ? { ...x, text: 'print("the agent\'s fix")' } : x));
await call("workspace.write", { path, content: { text: JSON.stringify(third, null, 1) }, base: read3.rev });
await until(`(${W}).space.nodes.find((x) => x.id === ${JSON.stringify(pick.id)}).text === 'print("the agent\\'s fix")'`, 10000).then(() => ok(true, "the agent's rewrite of an object that was run here is what the space has"), (e) => ok(false, "the agent's rewrite of an object that was run here is what the space has", String(e).slice(0, 200)));
ok((await ev(`(${W}).space.nodes.find((x) => x.id === ${JSON.stringify(other.id)}).text`)) === 'print("edited here")', "an edit made here to another object is kept");
await ev(`(${W}).select(${JSON.stringify(pick.id)})`);
await until(`${DOC}.querySelector('#overlay textarea')?.value === 'print("the agent\\'s fix")'`, 5000).then(() => ok(true, "its panel shows the agent's version"), (e) => ok(false, "its panel shows the agent's version", String(e).slice(0, 200)));

if (process.argv[2]) {
  await sleep(1500);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(process.argv[2], Buffer.from(shot.data, "base64"));
  console.log("screenshot:", process.argv[2]);
}
if (logs.length) console.log("page logs:", logs.slice(-10));
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
