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
      decide: [{ name: "confuses-transitive-with-two-transitive", about: "Transitive asks only that one $g$ takes $x$ to $y$, not that pairs go to pairs.", next: "n1" }, { name: "says-every-point-reaches-every-other", next: "s1" }] },
    { id: "n1", text: "**Transitive vs 2-transitive.** $G$ acts transitively when for all $x, y$ some $g$ has $g x = y$." },
    { id: "s1", kind: "sticker", emoji: "⭐", x: 900, y: 40 },
  ] },
  { id: "p2", title: "Notes", nodes: [{ id: "n2", text: "Nothing to answer here." }] },
  // (a later page whose question has the id of page 1's, with ideas of its own: ids are their page's)
  { id: "p3", title: "More", nodes: [
    { id: "q2", kind: "ask", title: "Orbits", text: "What is an orbit?", input: "text", decide: [{ name: "says-the-set-of-images-of-a-point", about: "The orbit of $x$ is $\\{g x : g \\in G\\}$." }] },
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
  // (a silent host, sent again and again: the same id each time, HARD-B21-1)
  for (let k = 0; k < 3; k++) {
    await frame(`${$("subsend")}.click()`);
    await until(async () => (await sent("answers")).length === 2 + k);
    await until(() => frame(`${$("subsend")}.textContent === "Send again" && !${$("subsend")}.disabled`), 10000);
  }
  subs = await sent("answers");
  check(subs.length === 4 && subs.every((m) => m.id === subs[0].id), "a silent host, sent again three times: the same id each time");
  await top(`mode.submit = "refused"; mode.message = "The board changed: reload it."`);
  await frame(`${$("subsend")}.click()`);
  check(!!(await until(async () => (await sent("answers")).length === 5)), "Send again sends");
  subs = await sent("answers");
  check(subs[4].id === subs[0].id, "with the same id");
  check(!!(await until(() => frame(`${$("substatus")}.textContent.includes("Not sent: The board changed: reload it. You can")`))), "refused: the host's words shown");
  check(await frame(`!${$("subsend")}.disabled`), "and the reader can send again");
  await shot("submit-3-refused.png");

  // answers changed after refused: a new id; received
  await top(`mode.submit = "received"`);
  await frame(`document.querySelectorAll('[data-ask="q1"] input[type=radio]')[1].click()`);
  await sleep(500);
  await frame(`${$("subsend")}.click()`);
  check(!!(await until(async () => (await sent("answers")).length === 6)), "changed answers sent");
  subs = await sent("answers");
  check(subs[5].id !== subs[0].id && checkSubmission(posted, subs[5]).ok, "with a new id, passing the check");
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
  // (the host proposes, the reader confirms, William Oct 17: the option with Yes, to its next step, and No)
  check(!!(await until(() => frame(`${fb}?.textContent.includes("Your words suggest") && ${fb}.textContent.includes("Is that what you meant?") && !!${fb}.querySelector('.katex') && !!${fb}.querySelector('a.board-ask-yes[href="#n1"]') && ${fb}.querySelector('button.board-ask-no')?.textContent === "No"`))), "an option proposed: its about shown, typeset, with Yes (to its next) and No");
  // (Yes says where it goes: the item's title or first line, never its id)
  const linkText = () => frame(`${fb}.querySelector('a.board-ask-yes').title`);
  check(await linkText() === "→ Transitive vs 2-transitive. G acts transitively when for…", "its Yes says where it goes, the item's first line, its Markdown and math signs dropped, cut short: " + JSON.stringify(await linkText()));
  check(!!(await until(() => frame(`(() => { const card = ${fb}.closest(".board-item"); return card.scrollHeight <= card.clientHeight + 1; })()`), 10000)), "and its card as tall as what it now shows");
  // (nothing over it: the tour's caption at the bottom never covers what the card now shows)
  const uncovered = (sel) => `(() => { const el = ${sel}; if (!el) return false; const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.width > 0 && r.bottom <= innerHeight && !!at && (at === el || el.contains(at)); })()`;
  check(!!(await until(() => frame(uncovered(`${fb}.querySelector('a.board-ask-yes')`)), 10000)) && !!(await frame(uncovered(`${fb}.querySelector('.board-ask-no')`))), "Yes and No are visible, nothing over them (elementFromPoint at their centers)");
  check(!!(await until(() => frame(uncovered(`document.querySelector('[data-ask="q2"] .board-ask-req')`)), 10000)), "and so is the question's \"required\"");
  await shot("submit-5-decided.png");
  // No: every option, each to its own next step, and the reader's own words
  await frame(`${fb}.querySelector('.board-ask-no').click()`);
  const choices = () => frame(`[...${fb}.querySelectorAll('.board-ask-choice')].map((c) => (c.getAttribute('href') ?? '') + '|' + c.textContent.trim().slice(0, 30).trim())`);
  check(!!(await until(async () => JSON.stringify(await choices()) === JSON.stringify(["#n1|Transitive asks only that one", "#s1|Says every point reaches every", "|Something else: in my own word"]) && await frame(`${fb}.textContent.includes("Then which is closest") && !!${fb}.querySelector('.board-ask-choice .katex')`), 10000)), "No: every option, typeset, to its next step, and Something else: " + JSON.stringify(await choices()));
  check(!!(await until(() => frame(uncovered(`${fb}.querySelector('.board-ask-own')`)), 10000)), "...the last of them in view, nothing over it (No)");
  await shot("submit-5b-no.png");
  check(await frame(`${fb}.querySelector('a.board-ask-choice[href="#s1"]').title === "→ Go to the next step"`), "a next item with no title or text: \"Go to the next step\", not its id");
  // Something else: the reader's own words, their field open and focused; Choose again: the options again
  await frame(`${fb}.querySelector('.board-ask-own').click()`);
  check(!!(await until(() => frame(`${fb}.textContent.includes("Something else: your own words stand") && document.activeElement === document.querySelector('[data-ask="q2"] details textarea') && document.querySelector('[data-ask="q2"] details').open`))), "Something else: said, the reader's own words open and focused");
  await shot("submit-5d-own.png");
  check((await sent("decide")).length === 1, "...and nothing more asked of the host");
  // (other words written: Something else stands; then Choose again: the options, whatever the host said of the words before, astra's UI-E29-1)
  await frame(`(() => { const w = document.querySelector('[data-ask="q2"] details textarea'); w.value = "Each $x$ goes to each $y$ under some $g \\in G$."; w.dispatchEvent(new Event("change")); })()`);
  await sleep(800);
  check(await frame(`${fb}.textContent.includes("Something else: your own words stand")`), "...it stands as other words are written");
  await frame(`${fb}.querySelector('.board-ask-clear').click()`);
  check(!!(await until(async () => (await choices()).length === 3)) && (await sent("decide")).length === 1, "Choose again, after other words: the options again, nothing asked of the host: " + JSON.stringify(await choices()));
  // a choice with a next step: there, and said
  const cam0 = await frame(`JSON.stringify(window.board.camera)`);
  await frame(`${fb}.querySelector('a.board-ask-choice[href="#n1"]').click()`);
  // (there: the camera moved to its next step, n1 in the middle of the view)
  check(!!(await until(() => frame(`(() => { const r = window.board.clientRect("n1"); if (!r || JSON.stringify(window.board.camera) === ${JSON.stringify(cam0)}) return false; const x = r.left + r.width / 2, y = r.top + r.height / 2; return Math.abs(x - innerWidth / 2) < innerWidth / 4 && y > 0 && y < innerHeight; })()`), 10000)), "an option chosen: it goes to its next step: " + await frame(`JSON.stringify([${JSON.stringify(cam0)}, window.board.camera, window.board.clientRect("n1"), innerWidth, innerHeight])`));
  // (back to the question, for what follows)
  await frame(`window.board.focus(["q2"], true), 1`);
  await sleep(300);
  check(!!(await until(() => frame(`${fb}?.textContent.includes("You chose:") && ${fb}.querySelector('a.board-ref[href="#n1"]')?.textContent === "→ Transitive vs 2-transitive. G acts transitively when for…"`))), "...and says it was chosen, with the way to its next step");
  // Yes: the proposed option chosen, and its next step
  await top(`mode.decide = "says-every-point-reaches-every-other"`);
  await frame(`${fb}.querySelector('button').click()`);
  await until(() => frame(`!!${fb}?.querySelector('a.board-ask-yes[href="#s1"]')`));
  await frame(`${fb}.querySelector('a.board-ask-yes').click()`);
  check(!!(await until(() => frame(`${fb}?.textContent.includes("You chose: Says every point reaches every other") && ${fb}.querySelector('a.board-ref[href="#s1"]')?.textContent === "→ Go to the next step"`))), "Yes: the proposed option chosen, with its next step");
  const linkFont = await frame(`(() => { const a = ${fb}.querySelector('a.board-ref'), m = ${fb}.querySelector('.board-ask-clear'); return [getComputedStyle(a).fontFamily, getComputedStyle(m).fontFamily, getComputedStyle(a).fontSize, getComputedStyle(m).fontSize]; })()`);
  check(!/mono/i.test(linkFont[0]) && linkFont[0] === linkFont[1] && linkFont[2] === linkFont[3], "...its next step's link in the card's own type, as Choose again beside it, not monospace: " + JSON.stringify(linkFont));
  await shot("submit-5c-chosen.png");
  // (back to the question, from its next step, for what follows)
  await frame(`window.board.focus(["q2"], true), 1`);
  await sleep(300);
  await top(`mode.decide = null`);
  await frame(`${fb}.querySelector('button').click()`);
  check(!!(await until(() => frame(`${fb}?.textContent.includes("didn't match any of the ideas")`))) && (await choices()).length === 3, "none: said honestly, and every option offered, and the reader's own words");
  check(!!(await until(() => frame(uncovered(`${fb}.querySelector('.board-ask-own')`)), 10000)), "...the last of them in view, nothing over it (6-none)");
  await shot("submit-6-none.png");
  await top(`mode.decide = "refused"; mode.message = "Too many requests: try again in a minute."`);
  await frame(`${fb}.querySelector('button').click()`);
  check(!!(await until(() => frame(`${fb}?.textContent.includes("Couldn't get feedback: Too many requests: try again in a minute. Choose what is closest yourself")`))) && (await choices()).length === 3, "refused: the host's words shown, and every option offered");
  check(!!(await until(() => frame(uncovered(`${fb}.querySelector('.board-ask-own')`)), 10000)), "...the last of them in view, nothing over it (7-refused)");
  await shot("submit-7-refused.png");
  await top(`mode.decide = "not-one-of-these-names"`);
  await frame(`${fb}.querySelector('button').click()`);
  check(!!(await until(() => frame(`${fb}?.textContent.includes("not one of this question's ideas")`))), "a name not among its options: not shown as one");

  // an answer to words since changed: dropped, never shown under the new ones (CORR-B21-1)
  // (the question in view again: the options' card was kept clear of the caption by its bottom, its top above)
  await frame(`window.board.focus(["q2"], true), 1`);
  await sleep(300);
  await top(`mode.decide = "hold"`);
  await frame(`${fb}.querySelector('button').click()`);
  check(!!(await until(() => top("!!window.held"))), "(a request the host holds)");
  await frame(`(() => { const w = document.querySelector('[data-ask="q2"] details textarea'); w.value = "Something else entirely."; w.dispatchEvent(new Event("change")); })()`);
  await sleep(500);
  await top(`port.postMessage({ sagebrush: "decided", version: 1, id: held.id, option: "confuses-transitive-with-two-transitive" })`);
  await sleep(1500);
  check(await frame(`!${fb}.textContent.includes("Your words suggest") && !${fb}.textContent.includes("not one of") && ${fb}.querySelector('button').textContent === "Get feedback on my words"`), "an answer to words changed since it was asked: dropped, not shown under the new words");

  // (page 1's q2 with feedback of its own, before page 3's)
  await top(`mode.decide = "says-every-point-reaches-every-other"`);
  await frame(`${fb}.querySelector('button').click()`);
  check(!!(await until(() => frame(`${fb}.textContent.includes("Says every point reaches every other")`))), "page 1's q2 decided again, on its new words");

  // (the document changed by any path, the API's here, as Undo and Redo do:
  // a decision kept only while the question, as defined, has the words it
  // was asked about; astra's CORR-B21-1 at 8e31c0a2)
  const words = `document.querySelector('[data-ask="q2"] details textarea')`;
  const editQ2 = (body) => frame(`window.sagebrush.board.edit((d) => { const n = d.pages[0].nodes.find((x) => x.id === "q2"); ${body} }).then(() => 1)`);
  // (only the choice changed: the decision stays)
  await frame(`document.querySelector('[data-ask="q2"] input[type=checkbox]').click()`);
  await sleep(800);
  check(await frame(`${fb}.textContent.includes("Says every point reaches every other")`), "only the choice changed, the words and the question the same: the decision stays");
  // (1) done, then the words changed by the API: gone
  await editQ2(`n.note = "API NEW WORDS";`);
  check(!!(await until(() => frame(`${words}.value === "API NEW WORDS" && !${fb}.textContent.includes("Your words suggest")`))), "a decision done, its words changed by the API: gone");
  // (2) pending, the words changed and changed back (ABA): its answer dropped
  await top(`window.held = null; mode.decide = "hold"`);
  await frame(`${fb}.querySelector('button').click()`);
  check(!!(await until(() => top("!!window.held"))), "(a request for API NEW WORDS, held)");
  await editQ2(`n.note = "API temporary words";`);
  await until(() => frame(`${words}.value === "API temporary words"`));
  await editQ2(`n.note = "API NEW WORDS";`);
  await until(() => frame(`${words}.value === "API NEW WORDS"`));
  await top(`port.postMessage({ sagebrush: "decided", version: 1, id: held.id, option: "says-every-point-reaches-every-other" })`);
  await sleep(1500);
  check(await frame(`!${fb}.textContent.includes("Your words suggest") && ${fb}.querySelector('button').textContent === "Get feedback on my words"`), "a decision pending, its words changed and changed back: its answer dropped");
  // (3) pending, the question changed (its words the same): its answer dropped
  await top(`window.held = null`);
  await frame(`${fb}.querySelector('button').click()`);
  check(!!(await until(() => top("!!window.held"))), "(another request, held)");
  await editQ2(`n.text = "NEW QUESTION: explain a stabilizer instead.";`);
  await until(() => frame(`document.querySelector('[data-ask="q2"]').textContent.includes("NEW QUESTION")`));
  await top(`port.postMessage({ sagebrush: "decided", version: 1, id: held.id, option: "confuses-transitive-with-two-transitive" })`);
  await sleep(1500);
  check(await frame(`!${fb}.textContent.includes("Your words suggest") && !${fb}.textContent.includes("not one of")`), "a decision pending, the question's text changed: its answer dropped");
  // (and decided again, on these words and this question, for what follows)
  await top(`mode.decide = "says-every-point-reaches-every-other"`);
  await frame(`${fb}.querySelector('button').click()`);
  check(!!(await until(() => frame(`${fb}.textContent.includes("Says every point reaches every other")`))), "decided again, on the question and words as they are now");

  // a page with no questions: no Submit
  await frame(`document.querySelector('[data-sbb="pgnext"]').click()`);
  check(!!(await until(() => frame(`${$("submitbtn")}.hidden`))), "a page with no questions has no Submit");

  // page 3's q2, the id of page 1's: its own options, its own feedback (CORR-B21-2)
  await frame(`document.querySelector('[data-sbb="pgnext"]').click()`);
  check(!!(await until(() => frame(`!!document.querySelector('[data-ask="q2"] input.board-ask-text') && !${$("submitbtn")}.hidden`))), "page 3, with its own q2");
  check(await frame(`!document.querySelector('[data-ask="q2"] .board-ask-decide').textContent.includes("Says every point")`), "page 1's feedback for its q2 is not shown on page 3's");
  await frame(`(() => { const t = document.querySelector('[data-ask="q2"] input.board-ask-text'); t.value = "All the points $g x$."; t.dispatchEvent(new Event("change")); })()`);
  await sleep(300);
  await top(`mode.decide = "says-the-set-of-images-of-a-point"`);
  const before3 = (await sent("decide")).length;
  await frame(`document.querySelector('[data-ask="q2"] .board-ask-decide button').click()`);
  check(!!(await until(async () => (await sent("decide")).length === before3 + 1)), "page 3's request sent");
  const d3 = (await sent("decide")).at(-1), r3 = decideRequest(posted, d3);
  check(d3.page.number === 3 && r3.ok && r3.request.options.length === 1 && r3.request.options[0].name === "says-the-set-of-images-of-a-point" && r3.request.answer === "All the points $g x$.", "it names page 3, and the host's check finds page 3's question and options" + (r3.ok ? "" : ": " + r3.message));
  const fb3 = `document.querySelector('[data-ask="q2"] .board-ask-decide')`;
  check(!!(await until(() => frame(`${fb3}.textContent.includes("Your words suggest") && !!${fb3}.querySelector('.katex')`))), "page 3's own option accepted and shown");
  await top(`mode.decide = "confuses-transitive-with-two-transitive"`);
  await frame(`${fb3}.querySelector('button').click()`);
  check(!!(await until(() => frame(`${fb3}.textContent.includes("not one of this question's ideas")`))), "page 1's option, for page 3's q2: refused, never shown");
  // back on page 1: its q2's own feedback, not page 3's
  await frame(`document.querySelector('[data-sbb="pgprev"]').click()`);
  await sleep(300);
  await frame(`document.querySelector('[data-sbb="pgprev"]').click()`);
  check(!!(await until(() => frame(`!!document.querySelector('[data-ask="q2"] details textarea')`))), "back on page 1");
  check(!!(await until(() => frame(`${fb}.textContent.includes("Says every point reaches every other") && !${fb}.textContent.includes("orbit") && !${fb}.textContent.includes("not one of")`))), "page 1's q2 shows its own feedback, none of page 3's");
  check(errors.length === 0, "no exceptions" + (errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""));
} finally {
  ws.close(); chrome.kill(); parent.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
