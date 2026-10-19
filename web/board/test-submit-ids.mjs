// Questions whose ids are names an object already has ("__proto__",
// "constructor", "toString": a board's ids are any strings): answered on the
// board, with notes, and submitted, every answer and note reaches the host
// under its id and passes its check (checkSubmission).  Before, the frame
// built the answers by assignment, so "__proto__" set the object's
// prototype: a string answer or note was dropped, an array answer became the
// prototype, and a required "__proto__" question was refused as unanswered.
// Build web/dist first, then
//   python3 web/serve.py 8765 &   bun web/board/test-submit-ids.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";
import { checkSubmission, decideRequest } from "./ask.ts";

const site = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const shots = process.env.SB_SHOTS ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) failed++; };


// (page 1: a required check question "__proto__" (its answer a list) with a
// note, a text question "constructor", a radio question "toString" with a
// note; page 2: a text question "__proto__" (its answer a string))
const BOARD = JSON.stringify({ format: "sagebrush-board", version: 1, title: "Odd ids", pages: [
  { id: "p1", title: "One", nodes: [
    { id: "__proto__", kind: "ask", text: "Pick some", input: "check", options: ["a", "b"], required: true, x: 0, y: 0 },
    { id: "constructor", kind: "ask", text: "Say something", input: "text", x: 400, y: 0 },
    { id: "toString", kind: "ask", text: "Pick one", input: "radio", options: ["x", "y"], x: 800, y: 0 },
  ] },
  { id: "p2", title: "Two", nodes: [
    { id: "__proto__", kind: "ask", text: "Say it again", input: "text", required: true, x: 0, y: 0 },
  ] },
] });
const NONCE = crypto.randomUUID();
// the host: the frame in an iframe, given the nonce (or not), the board and a port; its answers as `mode` says
const parent = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>host</title><body style="margin:0;overflow:hidden">
<script>
window.got = []; window.mode = { submit: "received", decide: null, message: "" };
const nonce = ${JSON.stringify(NONCE)}, given = !location.search.includes("nonce=0");
const f = document.createElement("iframe");
f.style.cssText = "width:100vw;height:100vh;border:0;display:block";
f.src = ${JSON.stringify(site + "frame/board/")} + (given ? "#sb-nonce=" + nonce : "");
document.body.append(f);
let port = null, granted = false;
const reply = (m) => port.postMessage(m);
window.answer = (m) => {
  if (m.sagebrush === "answers") {
    if (mode.submit === "silent") return;
    reply(mode.submit === "received" ? { sagebrush: "received", version: 1, id: m.id } : { sagebrush: "refused", version: 1, id: m.id, message: mode.message });
  } else if (m.sagebrush === "decide") {
    if (mode.decide === "hold") window.held = m;
    else if (mode.decide === "refused") reply({ sagebrush: "refused", version: 1, id: m.id, message: mode.message });
    else if (mode.decide !== "silent") reply({ sagebrush: "decided", version: 1, id: m.id, option: mode.decide });
  }
};
addEventListener("message", (e) => {
  if (e.source !== f.contentWindow) return;
  got.push({ ready: e.data });
  if (e.data?.sagebrush !== "ready" || granted) return;
  granted = true;
  const ch = new MessageChannel();
  port = ch.port1;
  port.onmessage = (ev) => { got.push({ port: ev.data }); answer(ev.data); };
  f.contentWindow.postMessage({ sagebrush: "board", version: 1, text: ${JSON.stringify(BOARD)}, name: "ids.board.json", revision: "r1" }, "*", [ch.port2]);
});
</script></body>`);
}).listen(0, "127.0.0.1");
await new Promise((r) => parent.once("listening", r));
const parentUrl = `http://127.0.0.1:${parent.address().port}/`;
const posted = { text: BOARD, name: "ids.board.json", revision: "r1" };

let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-submit-ids-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1100,760", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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

const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const q = (id) => `document.querySelector('[data-ask=${JSON.stringify(id)}]')`;
try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.navigate", { url: parentUrl });
  const frame = await frameEval();
  check(!!(await until(() => frame(`!!${q("__proto__")} && !${$("submitbtn")}.hidden`))), "the board with the odd ids shows, with Submit");
  await frame("window.__sbSendAgainMs = 1500");
  // page 1: the check question (a list), a text, a radio, and notes on "__proto__" and "toString"
  await frame(`${q("__proto__")}.querySelector('input[type=checkbox]').click()`);
  await sleep(300);
  await frame(`(() => { const t = ${q("constructor")}.querySelector('input.board-ask-text, textarea.board-ask-text'); t.value = "built"; t.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(300);
  await frame(`${q("toString")}.querySelector('input[type=radio]').click()`);
  await sleep(300);
  for (const [id, note] of [["__proto__", "a note on proto"], ["toString", "a note on toString"]]) {
    await frame(`(() => { const d = ${q(id)}.querySelector('details'); d.open = true; const w = d.querySelector('textarea'); w.value = ${JSON.stringify(note)}; w.dispatchEvent(new Event("change")); })()`);
    await sleep(300);
  }
  await frame(`${$("submitbtn")}.click()`);
  check(!!(await until(() => frame(`!${$("subsend")}.disabled`), 10000)), "page 1: the required \"__proto__\" question answered, Send enabled");
  await frame(`${$("subsend")}.click()`);
  check(!!(await until(async () => (await sent("answers")).length === 1, 10000)), "page 1's answers sent");
  let subs = await sent("answers");
  let r = checkSubmission(posted, subs[0]);
  check(r.ok, "and they pass the host's check" + (r.ok ? "" : ": " + r.message));
  const s1 = r.ok ? r.submission : subs[0];
  check(JSON.stringify(own(s1.answers, "__proto__")) === '["a"]', "the check question \"__proto__\": its list answer, under its id: " + JSON.stringify(s1.answers));
  check(own(s1.answers, "constructor") === "built" && own(s1.answers, "toString") === "x", "\"constructor\" and \"toString\": their answers, under their ids");
  check(own(s1.notes, "__proto__") === "a note on proto" && own(s1.notes, "toString") === "a note on toString", "the notes on \"__proto__\" and \"toString\", under their ids: " + JSON.stringify(s1.notes));
  check(!!(await until(() => frame(`${$("substatus")}.textContent.includes("Received")`), 10000)), "received");
  await frame(`${$("subclose")}.click()`);
  // page 2: a text question "__proto__": its string answer
  await frame(`document.querySelector('[data-sbb="pgnext"]').click()`);
  check(!!(await until(() => frame(`${q("__proto__")}?.textContent.includes("Say it again")`), 10000)), "page 2, with its own \"__proto__\" question");
  await frame(`(() => { const t = ${q("__proto__")}.querySelector('input.board-ask-text, textarea.board-ask-text'); t.value = "again"; t.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(400);
  await frame(`${$("submitbtn")}.click()`);
  check(!!(await until(() => frame(`!${$("subsend")}.disabled`), 10000)), "page 2: the required text question \"__proto__\" answered, Send enabled");
  await frame(`${$("subsend")}.click()`);
  check(!!(await until(async () => (await sent("answers")).length === 2, 10000)), "page 2's answers sent");
  subs = await sent("answers");
  r = checkSubmission(posted, subs[1]);
  check(r.ok, "and they pass the host's check" + (r.ok ? "" : ": " + r.message));
  const s2 = r.ok ? r.submission : subs[1];
  check(own(s2.answers, "__proto__") === "again" && s2.page?.number === 2, "the text question \"__proto__\": its string answer, under its id: " + JSON.stringify(s2.answers));
  check(!errors.length, "no exceptions: " + errors.join(" | ").slice(0, 300));
} catch (e) {
  check(false, String(e?.stack ?? e));
} finally {
  ws.close();
  chrome.kill();
  parent.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
