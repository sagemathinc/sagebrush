// The frame's editing side in a real frame (web/board/edit-channel.ts, page.ts; web/board-host-protocol.md,
// "Editing"): a parent page on another origin plays the host, with the host's own merge and checks
// (editState, bundled for the page).  Without edit: true, no Edit.  Granted: an edit made in the frame reaches
// the host as changes with their was, passes its checks, and is saved; a change made elsewhere is shown;
// editing ended with keepUnsaved: Edit left, the unsaved changes kept in a bar, downloadable (one object URL
// live at a time) and discardable.
// Build web/dist first, then
//   python3 web/serve.py 8765 &   bun web/board/test-frame-edit.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const site = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const shots = process.env.SB_SHOTS ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) failed++; };

const BOARD = JSON.stringify({ format: "sagebrush-board", version: 1, title: "Editing", nodes: [
  { id: "a", text: "hello", x: 0, y: 0, w: 200, h: 80 },
  { id: "b", text: "other", x: 300, y: 0, w: 200, h: 80 },
] });
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const BOARD_PIC = JSON.stringify({ format: "sagebrush-board", version: 1, title: "Editing", images: { pic: { w: 1, h: 1, src: PNG } }, nodes: [
  { id: "a", text: "with a picture", image: "pic", x: 0, y: 0, w: 200, h: 120 },
] });
const NONCE = crypto.randomUUID();
// (the host's merge, for the page)
const built = await Bun.build({ entrypoints: [join(import.meta.dir, "edit-state.ts")], target: "browser", format: "esm" });
if (!built.success) throw new Error("edit-state.ts didn't build: " + built.logs.join("; "));
const editStateJs = await built.outputs[0].text();
const parent = createServer((req, res) => {
  if (req.url === "/edit-state.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(editStateJs); }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>host</title><body style="margin:0;overflow:hidden">
<script type="module">
import { editState } from "/edit-state.js";
window.got = []; window.mode = "save";
const text = location.search.includes("pic=1") ? ${JSON.stringify(BOARD_PIC)} : ${JSON.stringify(BOARD)}, grant = !location.search.includes("edit=0");
const st = window.st = editState(text);
let rev = 0, port = null, granted = false;
window.rev = () => "r" + rev;
const f = document.createElement("iframe");
f.style.cssText = "width:100vw;height:100vh;border:0;display:block";
f.src = ${JSON.stringify(site + "frame/board/")} + "#sb-nonce=" + ${JSON.stringify(NONCE)};
document.body.append(f);
window.post = (m) => port.postMessage(m);
// (a change made elsewhere, sent as a remote)
window.remote = (changes) => { const r = st.remote(changes); if (!r.ok) throw new Error(r.message); const base = "r" + rev; post({ sagebrush: "remote", version: 1, base, revision: "r" + ++rev, changes }); };
window.answer = (m) => {
  if (m.sagebrush === "resync") return post({ sagebrush: "replace", version: 1, revision: "r" + ++rev, text: JSON.stringify(st.board()), answered: [] });
  if (m.sagebrush !== "edit" || mode === "hold") return;
  const a = st.apply(m, Date.now());
  if (!a.ok) return post({ sagebrush: "refused", version: 1, id: m.id, message: a.message, ...(a.retryAfter ? { retryAfter: a.retryAfter } : {}) });
  const base = "r" + rev;
  post({ sagebrush: "saved", version: 1, id: m.id, base, revision: "r" + ++rev, changes: a.changes, dropped: a.dropped });
};
addEventListener("message", (e) => {
  if (e.source !== f.contentWindow) return;
  got.push({ ready: e.data });
  if (e.data?.sagebrush !== "ready" || granted) return;
  granted = true;
  const ch = new MessageChannel();
  port = ch.port1;
  port.onmessage = (ev) => { got.push({ port: ev.data }); answer(ev.data); };
  f.contentWindow.postMessage({ sagebrush: "board", version: 1, text, name: "e.board.json", revision: "r0", ...(grant ? { edit: true } : {}) }, "*", [ch.port2]);
});
</script></body>`);
}).listen(0, "127.0.0.1");
await new Promise((r) => parent.once("listening", r));
const parentUrl = `http://127.0.0.1:${parent.address().port}/`;

let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-fedit-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--js-flags=--expose-gc", `--remote-debugging-port=${port}`, "--window-size=1100,760", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
// (each frame's main world, by its frame id; and frames in processes of their own, by session)
const contexts = new Map(), sessions = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.executionContextCreated" && m.params.context.auxData?.isDefault) contexts.set(m.params.context.auxData.frameId, { id: m.params.context.id, session: m.sessionId });
  if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "iframe") {
    sessions.push(m.params.sessionId);
    send("Runtime.enable", {}, m.params.sessionId);
    send("Runtime.runIfWaitingForDebugger", {}, m.params.sessionId);
  }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const evalIn = async (expression, sessionId, contextId) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, sessionId);
  if (r?.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)).slice(0, 300) + " in: " + expression.slice(0, 300));
  return r?.result?.value;
};
const top = (e) => evalIn(e);
const until = async (f, ms = 60000) => { const t = Date.now(); for (;;) { const v = await f().catch(() => null); if (v) return v; if (Date.now() - t > ms) return null; await sleep(200); } };
// the frame's main world (its own globals, the board's page)
async function frameEval() {
  return until(async () => {
    for (const s of sessions) if ((await evalIn("location.pathname", s).catch(() => null)) === "/frame/board/") return (e) => evalIn(e, s);
    const tree = await send("Page.getFrameTree");
    const child = tree.frameTree.childFrames?.[0]?.frame, c = child && contexts.get(child.id);
    return c && !c.session ? (e) => evalIn(e, undefined, c.id) : null;
  }, 30000);
}
async function shot(name) {
  if (!shots) return;
  const r = await send("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(shots, name), Buffer.from(r.data, "base64"));
}
const sent = (kind) => top(`JSON.stringify(got.filter((g) => g.port?.sagebrush === ${JSON.stringify(kind)}).map((g) => g.port))`).then(JSON.parse);
const $ = (part) => `document.querySelector('[data-sbb="${part}"]')`;

const edits = () => top(`JSON.stringify(got.filter((g) => g.port?.sagebrush === "edit").map((g) => g.port))`).then(JSON.parse);
const textOf = (id) => `(sagebrush.board.snapshot().doc.nodes.find((n) => n.id === ${JSON.stringify(id)})?.text)`;

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  // no edit: true: the board shows, with no Edit
  await send("Page.navigate", { url: parentUrl + "?edit=0" });
  let frame = await frameEval();
  check(!!(await until(() => frame("document.title.startsWith('Editing')"))), "a host that doesn't grant editing: the board shows");
  await sleep(1000);
  check(await frame(`${$("edit")}.hidden`), "and offers no Edit");

  // granted
  contexts.clear();
  await send("Page.navigate", { url: parentUrl });
  frame = await frameEval();
  check(!!(await until(() => frame("document.title.startsWith('Editing') && !!window.sagebrushEdit"))), "a host that grants editing: the board shows, editing taken");
  check(await frame(`!${$("edit")}.hidden && !${$("edit")}.disabled`), "Edit offered");

  // an edit in the frame: to the host, with its was, merged by the host's own checks, saved
  await frame(`sagebrush.board.edit((d) => { d.nodes.find((n) => n.id === "a").text = "hello world"; })`);
  check(!!(await until(async () => (await edits()).length === 1, 10000)), "the edit reaches the host");
  const e1 = (await edits())[0];
  const c1 = e1.changes.find((c) => c.key.id === "a");
  check(e1.base === "r0" && c1?.fields.text === "hello world" && c1?.was.text === "hello", "with what it changed and what that was: " + JSON.stringify(c1));
  check(!!(await until(() => top(`st.board().nodes.find((n) => n.id === "a").text === "hello world"`))), "merged into the host's board");
  check(!!(await until(() => frame(`sagebrushEdit.revision === "r1" && sagebrushEdit.pending === 0`))), "saved: the frame at the host's revision, nothing pending");

  // a change made elsewhere: shown
  await top(`remote([{ op: "set", key: { type: "item", page: "", id: "b" }, fields: { text: "changed elsewhere" } }])`);
  check(!!(await until(() => frame(`${textOf("b")} === "changed elsewhere"`), 10000)), "a change made elsewhere: shown in the frame");
  check(await frame(`${textOf("a")} === "hello world"`), "the frame's own saved change still there");

  // editing ended with keepUnsaved: Edit left, the unsaved change kept, downloadable, discardable
  await top(`mode = "hold"`);
  await frame(`sagebrush.board.edit((d) => { d.nodes.find((n) => n.id === "a").text = "not saved yet"; })`);
  check(!!(await until(async () => (await edits()).length === 2, 10000)), "a second edit sent, the host holding it");
  await top(`post({ sagebrush: "editing", version: 1, allowed: false, message: "The history is full.", reason: "history-full", keepUnsaved: true })`);
  check(!!(await until(() => frame(`${$("edit")}.disabled && !!document.getElementById("sbb-unsaved")`))), "keepUnsaved: Edit left and disabled, the unsaved change kept in a bar");
  check(await frame(`document.getElementById("sbb-unsaved").textContent.includes("The history is full.")`), "the bar says why");
  // (Download: a Blob from parts, one object URL live at a time; an earlier one revoked: daybreak2's check 3)
  await frame(`(() => { window.__blobs = []; window.__revoked = []; const c = URL.createObjectURL.bind(URL), r = URL.revokeObjectURL.bind(URL); URL.createObjectURL = (b) => { const u = c(b); __blobs.push([u, b]); return u; }; URL.revokeObjectURL = (u) => { __revoked.push(u); r(u); }; })()`);
  await frame(`${$("unsaved-download")}.click()`);
  await frame(`${$("unsaved-download")}.click()`);
  const dl = await frame(`(async () => { const t = JSON.parse(await __blobs[0][1].text()); return { n: __blobs.length, firstRevoked: __revoked.includes(__blobs[0][0]), view: t.view?.nodes?.find((n) => n.id === "a")?.text, tx: t.transactions?.[0]?.[0]?.fields?.text, was: t.transactions?.[0]?.[0]?.was?.text }; })()`);
  check(dl?.n === 2 && dl.firstRevoked && dl.view === "not saved yet" && dl.tx === "not saved yet" && dl.was === "hello world", "Download: the board as seen and the transaction with its was; the earlier URL revoked: " + JSON.stringify(dl));
  check(!!(await until(() => frame(`__revoked.includes(__blobs[1][0])`), 5000)), "...and the last one revoked once handed over");
  await frame(`${$("unsaved-discard")}.click()`);
  check(!!(await until(() => frame(`!document.getElementById("sbb-unsaved") && sagebrushEdit.totals().bytes === 0`))), "Discard: the bar gone, nothing held");
  // a board with a picture, kept inline by the host: an edit sends it with its bytes, and the host's board keeps them
  contexts.clear();
  await send("Page.navigate", { url: parentUrl + "?pic=1" });
  frame = await frameEval();
  await until(() => frame("!!window.sagebrushEdit && !!document.querySelector('img')"));
  await frame(`sagebrush.board.edit((d) => { d.nodes.find((n) => n.id === "a").text = "edited"; })`);
  check(!!(await until(() => top(`st.board().nodes[0].text === "edited"`), 10000)), "a board with a picture: the edit saved");
  const pics = await top(`(() => { const b = st.board(); return { refs: b.nodes.map((n) => n.image).filter(Boolean), images: Object.fromEntries(Object.entries(b.images ?? {}).map(([k, v]) => [k, String(v.src ?? "").slice(0, 22)])) }; })()`);
  check(pics.refs.length === 1 && pics.refs.every((r) => pics.images[r]?.startsWith("data:image/png")), "every picture the host's board names has its bytes: " + JSON.stringify(pics));

  // a host that never answers, the same near-limit field changed over and over (LIMIT-9B5-1's acceptance):
  // Edit paused before the bound, nothing lost, the totals exact, the heap within a constant times the bound
  contexts.clear();
  await send("Page.navigate", { url: parentUrl });
  frame = await frameEval();
  await until(() => frame("!!window.sagebrushEdit && !!window.gc"));
  await top(`mode = "hold"`);
  const heap = () => frame("(() => { gc(); gc(); return performance.memory.usedJSHeapSize; })()");
  const base = await heap();
  let made = 0;
  for (let i = 0; i < 40; i++) {
    const r = await frame(`(async () => { if (sagebrushEdit.isPaused) return "paused"; const before = sagebrushEdit.pending; await sagebrush.board.edit((d) => { d.nodes.find((n) => n.id === "a").text = String(${i} % 10).repeat(300000); }); return sagebrushEdit.pending > before ? "taken" : "not"; })()`);
    if (r === "paused") break;
    if (r === "taken") made++;
    await sleep(300);
  }
  const st1 = await frame(`(() => { const t = sagebrushEdit.totals(); return { paused: sagebrushEdit.isPaused, t, pending: sagebrushEdit.pending, edit: ${$("edit")}.disabled }; })()`);
  const held = await heap();
  check(st1.paused && st1.edit && st1.t.bytes <= 8 * 2 ** 20 && st1.t.bytes > 7 * 2 ** 20 && st1.pending === made, "a silent host: Edit paused before the bound, every change made still held: " + JSON.stringify({ ...st1, made }));
  check(held - base < 6 * 8 * 2 ** 20, "the heap within 6 times the bound of where it began: " + JSON.stringify({ base, held, mb: Math.round((held - base) / 2 ** 20) }));
  await top(`post({ sagebrush: "editing", version: 1, allowed: false, message: "Can't take more now.", keepUnsaved: true })`);
  await until(() => frame(`!!document.getElementById("sbb-unsaved")`));
  const before = await heap();
  await frame(`(() => { window.__big = []; const c = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { __big.push(b); return c(b); }; })()`);
  await frame(`${$("unsaved-download")}.click()`);
  const after = await heap();
  const parsed = await frame(`(async () => { const t = JSON.parse(await __big[0].text()); return { n: t.transactions.length, view: t.view.nodes.find((n) => n.id === "a").text.length }; })()`);
  check(parsed.n === made && parsed.view === 300000, "the download holds every transaction, and the view: " + JSON.stringify(parsed));
  check(after - before < 2 ** 20, "making it kept no second copy in the heap: " + JSON.stringify({ before, after, kb: Math.round((after - before) / 1024) }));
  check(errors.length === 0, "no exceptions" + (errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""));
} finally {
  ws.close(); chrome.kill(); parent.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
