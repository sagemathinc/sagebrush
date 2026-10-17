// The frame's Submit bar and "Get feedback on my words"
// (web/board-host-protocol.md): a parent page on another origin plays the
// host.  Given a nonce, the frame says it in its first ready, takes it out
// of its address, and takes the port posted with the board; the bar shows
// on a page with questions and sends the page's answers, notes and comment,
// which pass the host's own check (checkSubmission).  Once: Send is
// disabled in its click until received or refused; with no answer, Send
// again sends the same id; answers changed after refused, a new one.  A
// required question unanswered: no Send.  A question's words are decided
// only when the reader asks, by a request decideRequest accepts; an option,
// none, or a refusal each shown as it is, math typeset.  No nonce, or no
// questions: no Submit.
// Build web/dist first, then
//   python3 web/serve.py 8765 &   bun web/board/test-submit.mjs
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

// a teaching board: a choice, a required question with a decide, a text question; and a page with none
const BOARD = JSON.stringify({ format: "sagebrush-board", version: 1, title: "Transitive actions", pages: [
  { id: "p1", title: "Questions", nodes: [
    { id: "q1", kind: "ask", title: "Which group acts transitively?", text: "On $\\{1, 2, 3\\}$:", input: "radio", options: ["$S_3$", "$\\langle (1\\,2) \\rangle$"] },
    { id: "q2", kind: "ask", title: "Why?", text: "Say in your own words what **transitive** means here.", input: "check", options: ["Every point can reach every other"], required: true,
      decide: [{ name: "confuses-transitive-with-two-transitive", about: "Transitive asks only that one $g$ takes $x$ to $y$, not that pairs go to pairs.", next: "n1" }, { name: "says-every-point-reaches-every-other" }] },
    { id: "n1", text: "**Transitive vs 2-transitive.** $G$ acts transitively when for all $x, y$ some $g$ has $g x = y$." },
  ] },
  { id: "p2", title: "Notes", nodes: [{ id: "n2", text: "Nothing to answer here." }] },
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
    if (mode.decide === "refused") reply({ sagebrush: "refused", version: 1, id: m.id, message: mode.message });
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
  f.contentWindow.postMessage({ sagebrush: "board", version: 1, text: ${JSON.stringify(BOARD)}, name: "transitive.board.json", revision: "r1" }, "*", [ch.port2]);
});
</script></body>`);
}).listen(0, "127.0.0.1");
await new Promise((r) => parent.once("listening", r));
const parentUrl = `http://127.0.0.1:${parent.address().port}/`;
const posted = { text: BOARD, name: "transitive.board.json", revision: "r1" };

let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-submit-"));
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
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
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

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  // without a nonce: the board shows, with no Submit (a port posted anyway is not taken)
  await send("Page.navigate", { url: parentUrl + "?nonce=0" });
  let frame = await frameEval();
  check(!!(await until(() => frame("document.title.startsWith('Transitive actions')"))), "a host with no nonce: the board shows");
  // (the board's chrome mounted, and a moment for a port to be taken, were one taken)
  await until(() => frame(`!!${$("submitbtn")}`));
  await sleep(1500);
  check(await frame(`${$("submitbtn")}.hidden`), "and has no Submit");
  check(await top("got[0]?.ready?.sagebrush === 'ready' && !('nonce' in got[0].ready)"), "its ready says no nonce");

  // with a nonce: ready says it, the address no longer has it, and Submit shows
  contexts.clear();
  await send("Page.navigate", { url: parentUrl });
  frame = await frameEval();
  check(!!(await until(() => frame("document.title.startsWith('Transitive actions')"))), "a host with a nonce: the board shows");
  check(await top(`got[0]?.ready?.nonce === ${JSON.stringify(NONCE)}`), "its first ready says the nonce");
  check(await frame("!location.href.includes('sb-nonce')"), "the frame's address no longer has it");
  check(!!(await until(() => frame(`!${$("submitbtn")}.hidden`))), "a page with questions has Submit");

  // the panel: a required question unanswered, no Send
  await frame(`${$("submitbtn")}.click()`);
  check(await frame(`!${$("submit")}.hidden`), "Submit opens its panel");
  check(await frame(`${$("subsend")}.disabled && ${$("substatus")}.textContent.includes("required")`), "a required question unanswered: Send disabled, and it says why");

  // answered: the choice, and q2 in the reader's own words, with math
  await frame(`document.querySelector('[data-ask="q1"] input[type=radio]').click()`);
  await frame(`(() => { const d = document.querySelector('[data-ask="q2"] details'); d.open = true; const w = d.querySelector('textarea'); w.value = "Each $x$ can be sent to each $y$ by some $g \\\\in G$."; w.dispatchEvent(new Event("change")); })()`);
  check(!!(await until(() => frame(`!${$("subsend")}.disabled`))), "the required question answered in words: Send enabled");
  check(await frame(`!document.body.innerText.includes("Not kept")`), "an answer in a frame, which keeps nothing by design: no notice that it isn't kept");
  await frame(`(() => { const c = ${$("subcomment")}; c.value = "I think $|G| = 6$ matters."; c.dispatchEvent(new Event("input")); })()`);
  check(!!(await until(() => frame(`!${$("subpreview")}.hidden && !!${$("subpreview")}.querySelector('.katex')`))), "the comment's math typeset under it");
  await top(`mode.submit = "silent"`);
  await shot("submit-1-panel.png");

  // Send: disabled in its click; with no answer, Send again, the same id
  await frame(`window.__sbSendAgainMs = 1500`);
  check(await frame(`(() => { ${$("subsend")}.click(); return ${$("subsend")}.disabled; })()`), "Send is disabled in its own click");
  check(!!(await until(async () => (await sent("answers")).length === 1)), "the answers sent on the port");
  let subs = await sent("answers");
  const r1 = checkSubmission(posted, subs[0]);
  check(r1.ok, "and they pass the host's check" + (r1.ok ? "" : ": " + r1.message));
  check(r1.ok && r1.submission.answers.q1 === "$S_3$" && r1.submission.notes.q2?.includes("$g \\in G$") && r1.submission.comment.includes("|G| = 6") && r1.submission.page.number === 1 && r1.submission.page.id === "p1", "the page, its answers, notes and comment, as given");
  check(!!(await until(() => frame(`${$("subsend")}.textContent === "Send again" && !${$("subsend")}.disabled`), 10000)), "no answer: Send again offered");
  await shot("submit-2-late.png");
  await top(`mode.submit = "refused"; mode.message = "The board changed: reload it."`);
  await frame(`${$("subsend")}.click()`);
  check(!!(await until(async () => (await sent("answers")).length === 2)), "Send again sends");
  subs = await sent("answers");
  check(subs[1].id === subs[0].id, "with the same id");
  check(!!(await until(() => frame(`${$("substatus")}.textContent.includes("Not sent: The board changed: reload it. You can")`))), "refused: the host's words shown");
  check(await frame(`!${$("subsend")}.disabled`), "and the reader can send again");
  await shot("submit-3-refused.png");

  // answers changed after refused: a new id; received
  await top(`mode.submit = "received"`);
  await frame(`document.querySelectorAll('[data-ask="q1"] input[type=radio]')[1].click()`);
  await sleep(500);
  await frame(`${$("subsend")}.click()`);
  check(!!(await until(async () => (await sent("answers")).length === 3)), "changed answers sent");
  subs = await sent("answers");
  check(subs[2].id !== subs[0].id && checkSubmission(posted, subs[2]).ok, "with a new id, passing the check");
  check(!!(await until(() => frame(`${$("substatus")}.textContent.includes("Received") && ${$("subsend")}.disabled && ${$("submitbtn")}.textContent.includes("Submitted")`))), "received: said, and Send disabled until something changes");
  await shot("submit-4-received.png");
  await frame(`${$("subclose")}.click()`);

  // Get feedback: asked only when the reader asks, by a request decideRequest accepts
  check((await sent("decide")).length === 0, "nothing decided unasked");
  const fb = `document.querySelector('[data-ask="q2"] .board-ask-decide')`;
  check(await frame(`!!${fb}`), "a question with decide offers Get feedback on my words");
  check(await frame(`!document.querySelector('[data-ask="q1"] .board-ask-decide')`), "a question without, doesn't");
  await top(`mode.decide = "confuses-transitive-with-two-transitive"`);
  await frame(`${fb}.querySelector('button').click()`);
  check(!!(await until(async () => (await sent("decide")).length === 1)), "the request sent on the port");
  const d1 = decideRequest(posted, (await sent("decide"))[0]);
  check(d1.ok && d1.request.item === "q2" && d1.request.answer.includes("$g \\in G$"), "and it passes the host's check, the reader's words its answer" + (d1.ok ? "" : ": " + d1.message));
  check(!!(await until(() => frame(`${fb}?.textContent.includes("Your words suggest") && !!${fb}.querySelector('.katex') && !!${fb}.querySelector('a.board-ref[href="#n1"]')`))), "an option: its about shown, typeset, with its next");
  check(!!(await until(() => frame(`(() => { const card = ${fb}.closest(".board-item"); return card.scrollHeight <= card.clientHeight + 1; })()`), 10000)), "and its card as tall as what it now shows");
  // (nothing over it: the tour's caption at the bottom never covers what the card now shows)
  const uncovered = (sel) => `(() => { const el = ${sel}; if (!el) return false; const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.width > 0 && r.bottom <= innerHeight && !!at && (at === el || el.contains(at)); })()`;
  check(!!(await until(() => frame(uncovered(`${fb}.querySelector('a.board-ref')`)), 10000)), "its next link is visible, nothing over it (elementFromPoint at its center)");
  check(!!(await until(() => frame(uncovered(`document.querySelector('[data-ask="q2"] .board-ask-req')`)), 10000)), "and so is the question's \"required\"");
  await shot("submit-5-decided.png");
  await top(`mode.decide = null`);
  await frame(`${fb}.querySelector('button').click()`);
  check(!!(await until(() => frame(`${fb}?.textContent.includes("didn't match any of the ideas")`))), "none: said honestly, and that submitting still reaches the board's maker");
  await shot("submit-6-none.png");
  await top(`mode.decide = "refused"; mode.message = "Too many requests: try again in a minute."`);
  await frame(`${fb}.querySelector('button').click()`);
  check(!!(await until(() => frame(`${fb}?.textContent.includes("Couldn't get feedback: Too many requests: try again in a minute. Your words")`))), "refused: the host's words shown");
  await shot("submit-7-refused.png");
  await top(`mode.decide = "not-one-of-these-names"`);
  await frame(`${fb}.querySelector('button').click()`);
  check(!!(await until(() => frame(`${fb}?.textContent.includes("not one of this question's ideas")`))), "a name not among its options: not shown as one");

  // a page with no questions: no Submit
  await frame(`document.querySelector('[data-sbb="pgnext"]').click()`);
  check(!!(await until(() => frame(`${$("submitbtn")}.hidden`))), "a page with no questions has no Submit");
  check(errors.length === 0, "no exceptions" + (errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""));
} finally {
  ws.close(); chrome.kill(); parent.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
