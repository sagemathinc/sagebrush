// ci: web-artifacts.1 order=33 runner=bun chrome
// Delegate briefs on the Agents page (PLAN-delegate-brief r2, the page's half), in headless Chromium: the built page
// (SAGEBRUSH_AGENTS=1), served by web/serve.py, paired with the stand-in Delegate host (test-delegate-host.mjs). What it
// shows: an agent that doesn't list chat.brief gets the sheet as before (nothing asked); one that does, in a chat where
// something was said and with nothing typed in the composer, drafts the task: "Drafting a brief…" with the task and title
// read only and Start off, then both filled, editable, and sent as tasks.start's prompt; what's typed in the composer
// stays the task (no brief asked); Stop drafting and closing the sheet each send chat.brief_cancel for that chat, and a
// late result changes nothing; a refusal says so in the page's own words and leaves the box to the person.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-delegate-brief.mjs
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startServe } from "../test-port.mjs";
import { browser } from "./a14-cases.mjs";
import { delegateHost } from "./test-delegate-host.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostUntil = async (f, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(25); } return false; };

let server, Br;
const hosts = [];
try {
  const sitePort = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
  const site = `http://127.0.0.1:${sitePort}`;
  Br = await browser();
  const P = await Br.tab();
  const pair = async (H) => {
    await P.navigate(`${site}/agents/?pair=123-456&port=${H.port}`);
    await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Connect')`, 30000);
    await P.ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Connect').click()`);
    await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Allow')`, 30000);
    await P.ev(`(() => { const d = [...document.querySelectorAll('.sbag-dlg')].at(-1); const all = [...d.querySelectorAll('label')].find((l) => l.textContent.startsWith('Everything')).querySelector('input'); all.checked = true; all.dispatchEvent(new Event('change')); [...d.querySelectorAll('button')].find((b) => b.textContent === 'Allow').click(); })()`);
    await P.until(`document.querySelector('#connect').textContent === 'Connected'`);
    await P.until(`!!document.querySelector('#delegate-switch')?.offsetParent`);
    await hostUntil(() => !!H.grant);
    await P.ev(`document.querySelector('#delegate-switch').click()`);
    await P.until(`!!document.querySelector('dialog.delegate-dlg[open]')`);
    await P.ev(`[...document.querySelectorAll('dialog.delegate-dlg[open] button')].find((b) => b.textContent === 'Turn on').click()`);
    await hostUntil(() => H.grant?.delegate === true);
  };
  // (something said in the chat: a message sent, which the agent records under the chat's conversation id)
  const say = async (H, text) => {
    await P.draft(text);
    await P.ev(`document.querySelector('#send').click()`);
    await hostUntil(() => H.got.some((m) => m.method === "chat.message" && m.params?.text === text));
    return H.got.find((m) => m.method === "chat.message" && m.params?.text === text).params.conversation;
  };
  const sheet = async () => {
    await P.ev(`document.querySelector('#delegate').click()`);
    await P.until(`!!document.querySelector('dialog.sheet[open]')`);
  };
  const state = () => P.ev(`(() => { const d = document.querySelector('dialog.sheet[open]'); if (!d) return null; const line = d.querySelector('.brief-drafting'); return { drafting: !!line && !line.hidden, prompt: d.querySelector('#delegate-prompt').value, title: d.querySelector('#delegate-title').value, ro: d.querySelector('#delegate-prompt').readOnly && d.querySelector('#delegate-title').readOnly, start: d.querySelector('button[type=submit]').getAttribute('aria-disabled'), msg: d.querySelector('.msg').textContent }; })()`);
  const closeSheet = () => P.ev(`[...document.querySelectorAll('dialog.sheet[open] button')].find((b) => b.textContent === 'Cancel').click()`);

  // ---- an agent without chat.brief: the sheet as before, nothing asked
  {
    const H = delegateHost();
    hosts.push(H);
    await pair(H);
    await say(H, "Plot sin(x)");
    await sheet();
    const s = await state();
    await sleep(300);
    ok(s && !s.drafting && s.prompt === "" && !s.ro && s.start === null && !H.got.some((m) => m.method === "chat.brief"), "an agent without chat.brief: the sheet as before, empty and editable, no brief asked", s);
    await closeSheet();
  }
  // ---- an agent that drafts briefs
  const H = delegateHost({ features: ["delegate.1", "chat.resume", "chat.brief"] });
  hosts.push(H);
  await pair(H);
  const conv = await say(H, "Plot sin(x) and Decision: plot with matplotlib, not plotly");
  const brief = "Goal\nPlot sin(x)\n\nDecisions made\n- plot with matplotlib, not plotly\n\nFiles\n- work/plot.ipynb\n\nDone when\n- the plot shows sin(x)";
  H.briefs.set(conv, { title: "Plot sin(x)", brief, bytes: new TextEncoder().encode(brief).length, cut: false });
  {
    // (drafting: the line, the box read only, Start off; then the brief and its title, editable; Start sends them)
    H.hold.add("chat.brief");
    await sheet();
    await hostUntil(() => H.held.some((m) => m.method === "chat.brief"));
    const sent = H.held.find((m) => m.method === "chat.brief")?.params;
    const s = await state();
    ok(JSON.stringify(sent) === JSON.stringify({ conversation: conv }) && s?.drafting && s.ro && s.start === "true", "Delegate… in a Pair chat: chat.brief for that chat, \"Drafting a brief…\" shown, the task and title read only, Start off", { sent, s });
    H.hold.clear();
    H.release();
    await P.until(`document.querySelector('dialog.sheet[open] #delegate-prompt')?.value.startsWith('Goal')`, 10000).catch(() => {});
    const f = await state();
    ok(f && !f.drafting && !f.ro && f.start === null && f.prompt === brief && f.title === "Plot sin(x)", "the brief arrives: the task and its title filled, editable, Start on", f);
    await P.ev(`(() => { const t = document.querySelector('dialog.sheet[open] #delegate-title'); t.value = 'Plot sin(x), matplotlib'; const i = document.querySelector('#delegate-add'); i.value = 'work/plot.ipynb'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await H.call("workspace.create", { path: "/work/plot.ipynb", content: { json: { mode: "python", cells: [{ id: "c1", type: "code", code: "x = 1" }] } } });
    await P.ev(`document.querySelector('dialog.sheet[open] button[type=submit]').click()`);
    await hostUntil(() => H.got.some((m) => m.method === "tasks.start"), 10000);
    const st = H.got.find((m) => m.method === "tasks.start")?.params;
    ok(st && st.title === "Plot sin(x), matplotlib" && st.prompt === brief && st.prompt.includes("plot with matplotlib, not plotly"), "Start: tasks.start with the edited title and the brief as its prompt, the decision in it", st && { title: st.title, prompt: st.prompt.slice(0, 80) });
    await P.until(`!document.querySelector('dialog.sheet[open]')`, 10000).catch(() => {});
    await P.ev(`document.querySelector('#task-view .task-head .link')?.click()`);
  }
  {
    // (Stop drafting: chat.brief_cancel for that chat; said; a late answer changes nothing)
    H.hold.add("chat.brief");
    await sheet();
    await hostUntil(() => H.held.some((m) => m.method === "chat.brief"));
    await P.ev(`document.querySelector('dialog.sheet[open] .brief-drafting button').click()`);
    await hostUntil(() => H.got.some((m) => m.method === "chat.brief_cancel"));
    await sleep(300);
    const s = await state();
    const cancel = H.got.filter((m) => m.method === "chat.brief_cancel").at(-1)?.params;
    ok(JSON.stringify(cancel) === JSON.stringify({ conversation: conv }) && s && !s.drafting && !s.ro && s.prompt === "" && /Drafting stopped/.test(s.msg), "Stop drafting: chat.brief_cancel for that chat, the box left empty and editable, said so", { cancel, s });
    H.hold.clear();
    await closeSheet();
  }
  {
    // (closing the sheet while it drafts: cancelled too)
    H.hold.add("chat.brief");
    await sheet();
    await hostUntil(() => H.held.some((m) => m.method === "chat.brief"));
    const n = H.got.filter((m) => m.method === "chat.brief_cancel").length;
    await closeSheet();
    await hostUntil(() => H.got.filter((m) => m.method === "chat.brief_cancel").length === n + 1);
    ok(H.got.filter((m) => m.method === "chat.brief_cancel").length === n + 1, "the sheet closed while drafting: chat.brief_cancel sent");
    H.hold.clear();
    H.held.splice(0);
  }
  {
    // (a refusal: the page's own words, the box left to the person)
    H.briefs.set(conv, { error: "busy" });
    await sheet();
    await P.until(`/still answering/.test(document.querySelector('dialog.sheet[open] .msg')?.textContent ?? '')`, 10000).catch(() => {});
    const s = await state();
    ok(s && !s.drafting && !s.ro && s.prompt === "" && /The chat is still answering/.test(s.msg), "the agent busy: said so in the page's words, the box empty and editable", s);
    await closeSheet();
    H.briefs.set(conv, { error: "failed" });
    await sheet();
    await P.until(`/Couldn't draft a brief/.test(document.querySelector('dialog.sheet[open] .msg')?.textContent ?? '')`, 10000).catch(() => {});
    ok(/Couldn't draft a brief: write the task yourself\./.test((await state())?.msg ?? ""), "the agent's draft failed: the page's own words, never the agent's text");
    await closeSheet();
  }
  {
    // (typed in the composer: that is the task, as before; no brief asked)
    const briefsBefore = H.got.filter((m) => m.method === "chat.brief").length;
    await P.draft("Number the lines");
    await sheet();
    await sleep(300);
    const s = await state();
    const asked = H.got.filter((m) => m.method === "chat.brief").length;
    ok(s && !s.drafting && s.prompt === "Number the lines" && asked === briefsBefore, "something typed in the composer: it stays the task, no brief asked", s);
    await closeSheet();
  }
  ok(P.errors.length === 0, "no page errors", P.errors);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await Br?.close();
  for (const H of hosts) H.stop();
  server?.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
