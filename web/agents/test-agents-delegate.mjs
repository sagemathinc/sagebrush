// ci: web-artifacts.1 order=30 runner=bun chrome
// ci: web-artifacts.2 order=20 runner=bun chrome env=AGENTS_LATEX=1
// Delegate on the Agents page (Pair and Delegate plan, UI-3), end to end in headless Chromium: the built page
// (SAGEBRUSH_AGENTS=1), served by web/serve.py, paired as a person pairs it (a ?pair= link, Connect, the grant dialog)
// with the stand-in Delegate host (test-delegate-host.mjs). What it shows: nothing of Delegate until the agent offers
// it; the switch on only after its confirmation, and the host told; the Tasks list with chips; a task's view (its
// thread, its proposal's card) in place of the chat, and back; the proposal view from the host, each file checked;
// Delegate… (the sheet: the composer's text, the documents, May run code) and Start; the switch off, with the running
// tasks closed first when ticked, Delegate… disabled while it turns off, then the host told. A proposal's .tex: its
// diff, and (AGENTS_LATEX=1, the LaTeX test build) the document rendered read only beside Before; without the LaTeX
// editor on this host, its diff only. A proposal's .md: its diff, and the text rendered by the page's own Markdown
// renderer (a remote picture click-to-load), As proposed and Before.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-delegate.mjs
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServe } from "../test-port.mjs";
import { browser } from "./a14-cases.mjs";
import { delegateHost } from "./test-delegate-host.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostUntil = async (f, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(25); } return false; };

let server;
const sitePort = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const site = `http://127.0.0.1:${sitePort}`;

const H = delegateHost();
const nb = JSON.stringify({ cells: [{ cell_type: "code", id: "c1", metadata: {}, source: ["1+1"], outputs: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5 });
const A = await H.addTask({ title: "Factor the polynomial", base: { "work/a.ipynb": nb, "work/notes.txt": "one\n" }, proposal: { "work/a.ipynb": nb.replace("1+1", "2+2"), "work/notes.txt": "one\ntwo\n" } });
const B = await H.addTask({ title: "Plot it" });
H.emit(B.task, { type: "turn_started" });
H.emit(B.task, { type: "message_revised", message: "m1", revision: 1 });
H.emit(B.task, { type: "text_delta", message: "m1", revision: 1, text: "Plotting the first terms." });

const Br = await browser();
try {
  const P = await Br.tab();
  // (SHOTS=<dir>: a picture of the page at each step, for a person to look at)
  const shot = async (name) => { if (process.env.SHOTS) writeFileSync(join(process.env.SHOTS, name + ".png"), Buffer.from((await P.send("Page.captureScreenshot", { format: "png" })).data, "base64")); };
  const ui = () => P.ev(`(() => { const q = (s) => document.querySelector(s); const vis = (s) => !!q(s) && !q(s).hidden && !!q(s).offsetParent; return { sw: vis('#delegate-switch') ? q('#delegate-switch').textContent : null, btn: vis('#delegate'), btnOff: q('#delegate')?.getAttribute('aria-disabled') ?? null, tasks: vis('#tasks') ? [...document.querySelectorAll('#tasks .task')].map((b) => b.querySelector('.t').textContent + ' · ' + b.querySelector('.chip').textContent) : null, view: vis('#task-view'), log: vis('#log'), dialogs: [...document.querySelectorAll('dialog[open]')].map((d) => d.querySelector('h3')?.textContent ?? d.className) }; })()`);

  // ---- paired: the switch shown, off; nothing of the tasks
  await P.navigate(`${site}/agents/?pair=123-456&port=${H.port}`);
  await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Connect')`, 30000);
  ok((await ui()).sw === null && !(await ui()).btn, "before the grant: no Delegate switch, no Delegate…");
  await P.ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Connect').click()`);
  await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Allow')`, 30000);
  await P.ev(`(() => { const d = [...document.querySelectorAll('.sbag-dlg')].at(-1); const all = [...d.querySelectorAll('label')].find((l) => l.textContent.startsWith('Everything')).querySelector('input'); all.checked = true; all.dispatchEvent(new Event('change')); [...d.querySelectorAll('button')].find((b) => b.textContent === 'Allow').click(); })()`);
  await P.until(`document.querySelector('#connect').textContent === 'Connected'`);
  await P.until(`!!document.querySelector('#delegate-switch')?.offsetParent`);
  let u = await ui();
  ok(u.sw === "Delegate: off" && u.btn && u.tasks === null && H.grant && !H.grant.delegate, "granted, an agent that offers Delegate: the switch shown, off; Delegate… shown; no tasks; the grant has no delegate", u);
  ok(H.got.filter((m) => m.method?.startsWith("tasks.")).length === 0, "nothing asked of the host's tasks while the switch is off");

  // ---- on: only after its confirmation
  await P.ev(`document.querySelector('#delegate-switch').click()`);
  await P.until(`!!document.querySelector('dialog.delegate-dlg[open]')`);
  await shot("1-switch-on");
  const onText = await P.ev(`document.querySelector('dialog.delegate-dlg[open]').textContent`);
  ok(/Allow Delegate tasks on this computer\?/.test(onText) && /read every existing Delegate task of this agent installation/.test(onText), "the switch's confirmation says what it allows", onText);
  await P.ev(`[...document.querySelectorAll('dialog.delegate-dlg[open] button')].find((b) => b.textContent === 'Cancel').click()`);
  await sleep(200);
  ok((await ui()).sw === "Delegate: off" && !H.grant.delegate, "Cancel: still off, nothing sent");
  await P.ev(`document.querySelector('#delegate-switch').click()`);
  await P.until(`!!document.querySelector('dialog.delegate-dlg[open]')`);
  await P.ev(`[...document.querySelectorAll('dialog.delegate-dlg[open] button')].find((b) => b.textContent === 'Turn on').click()`);
  await hostUntil(() => H.grant?.delegate === true);
  await P.until(`document.querySelectorAll('#tasks .task').length === 2`);
  u = await ui();
  ok(H.grant.delegate === true && u.sw === "Delegate: on", "Turn on: the host told (delegate: true), the switch on", u.sw);
  await shot("2-tasks");
  ok(u.tasks?.join() === "Plot it · Working,Factor the polynomial · Proposal ready", "the Tasks list, newest first, each with its chip", u.tasks);

  // ---- a task's view: in place of the chat, its thread and its proposal's card; back to the chats
  await P.ev(`document.querySelector('#tasks .task[data-task="${B.task}"]').click()`);
  await P.until(`!!document.querySelector('#task-view .turn')`);
  u = await ui();
  const bText = await P.ev(`document.querySelector('#task-view').textContent`);
  ok(u.view && !u.log && /Plotting the first terms\./.test(bText), "a task opened: its view in place of the chat, its thread from the host", { u, bText: bText.slice(0, 200) });
  const tags = await P.ev(`[...document.querySelectorAll('#task-view .turn .demo')].map((e) => e.textContent)`);
  ok(tags.length > 0 && tags.every((t) => t === "on your computer"), "a task's turns are the agent's on this computer, never labelled demo", tags);
  H.emit(B.task, { type: "text_delta", message: "m1", revision: 1, text: " Done." });
  await P.until(`document.querySelector('#task-view').textContent.includes('first terms. Done.')`);
  ok(true, "the open task's next event (task.event) shown at once");
  await P.ev(`document.querySelector('#tasks .task[data-task="${A.task}"]').click()`);
  await P.until(`!!document.querySelector('#task-view .proposal-card')`);
  await shot("3-task");
  const card = await P.ev(`document.querySelector('#task-view .proposal-card').textContent`);
  ok(card === `Proposal: 2 files changed · base ${A.base.slice(0, 7)} · proposal ${A.proposal.slice(0, 7)}`, "a task with a proposal: its card, the files changed and both commits", card);
  await P.ev(`document.querySelector('#task-view .proposal-card').click()`);
  await P.until(`!!document.querySelector('dialog.proposal[open] .sbpv .file')`, 20000);
  const rows = await P.ev(`[...document.querySelectorAll('dialog.proposal[open] .sbpv .file')].map((r) => r.textContent.slice(0, 60))`);
  ok(rows.length === 2 && rows.some((r) => r.includes("work/notes.txt")) && rows.some((r) => r.includes("work/a.ipynb")), "the proposal view from the host (tasks.diff): its files", rows);
  const fileAsks = () => H.got.filter((m) => m.method === "tasks.file").map((m) => m.params.path + "@" + (m.params.commit === A.base ? "base" : m.params.commit === A.proposal ? "proposal" : "?"));
  await P.ev(`[...document.querySelectorAll('dialog.proposal[open] .sbpv .file')].find((r) => r.textContent.includes('work/notes.txt')).querySelector('.path').click()`);
  await P.until(`document.querySelector('dialog.proposal[open]').textContent.includes('two')`, 20000).catch(() => {});
  ok(fileAsks().includes("work/notes.txt@base") && fileAsks().includes("work/notes.txt@proposal") && (await P.ev(`document.querySelector('dialog.proposal[open]').textContent.includes('two')`)), "a file opened: both sides read (tasks.file, base and proposal), its diff shown", fileAsks());
  await shot("4-proposal");
  // (its actions: Close now; Merge and Ask for changes not yet, and said so)
  const acts = await P.ev(`[...document.querySelectorAll('dialog.proposal[open] button[data-act]')].map((b) => [b.dataset.act, b.textContent, b.getAttribute('aria-disabled')])`);
  ok(JSON.stringify(acts) === JSON.stringify([["merge", "Merge", "true"], ["ask", "Ask for changes", "true"], ["close", "Close", null]]) && /Merge and Ask for changes come in the next update\./.test(await P.ev(`document.querySelector('dialog.proposal[open]').textContent`)), "the proposal's actions: Close; Merge and Ask for changes not yet, said so", acts);
  // (a newer round of the task, while its proposal is open: it replaces the one shown, in place)
  const r2 = await H.propose(A.task, { "work/notes.txt": "one\ntwo\nthree\n" });
  await P.until(`document.querySelector('dialog.proposal[open] .sbpv h3')?.textContent === 'Proposal, round 2'`, 20000);
  const round2 = await P.ev(`({ status: document.querySelector('dialog.proposal[open] .proposal-actions [role=status]').textContent, files: [...document.querySelectorAll('dialog.proposal[open] .sbpv .file')].map((r) => r.querySelector('.path').textContent) })`);
  ok(/round 2/.test(round2.status) && round2.files.join() === "work/notes.txt" && H.got.some((m) => m.method === "tasks.diff" && m.params.commit === r2), "a new round while the proposal is open: it replaces the one shown, in the same dialog, said so", round2);
  // (Close: asked first, then the task closed at the host with the proposal shown and its seq; the dialog goes)
  await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="close"]').click()`);
  await P.until(`[...document.querySelectorAll('dialog.delegate-dlg[open] h3')].some((h) => h.textContent === 'Close this proposal?')`);
  ok(!H.got.some((m) => m.method === "tasks.close"), "Close asks first: nothing sent yet");
  await P.ev(`[...document.querySelectorAll('dialog.delegate-dlg[open] button')].find((b) => b.textContent === 'Close the task').click()`);
  await hostUntil(() => H.tasks.get(A.task).status === "closed");
  const closeSent = H.got.find((m) => m.method === "tasks.close")?.params;
  ok(closeSent?.proposal === r2 && closeSent?.seq === A.log.length - 1, "Close: tasks.close for the round shown, at the seq it was read at", { closeSent, log: A.log.length });
  await P.until(`!document.querySelector('dialog.proposal[open]') && document.querySelector('#tasks .task[data-task="${A.task}"] .chip')?.textContent === 'Closed'`);
  ok(true, "closed: the dialog goes, and the task's chip says Closed");
  await P.ev(`document.querySelector('#task-view .task-head .link').click()`);
  u = await ui();
  ok(!u.view && u.log, "Back to chats: the chat shown again", u);

  // ---- a proposal's .tex: its diff, and the document rendered (the LaTeX page module's read-only preview), As proposed
  //  and Before; on a host without the LaTeX editor, its diff only
  const TEX0 = "\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\nHello.\n\\end{document}\n";
  const C = await H.addTask({ title: "Add a results section", status: "proposal", base: { "work/paper.tex": TEX0 }, proposal: { "work/paper.tex": TEX0.replace("\\end{document}", "\\section{Results}\nIt works.\n\\end{document}") } });
  await P.until(`!!document.querySelector('#tasks .task[data-task="${C.task}"]')`);
  await P.ev(`document.querySelector('#tasks .task[data-task="${C.task}"]').click()`);
  await P.until(`!!document.querySelector('#task-view .proposal-card')`);
  await P.ev(`document.querySelector('#task-view .proposal-card').click()`);
  await P.until(`!!document.querySelector('dialog.proposal[open] .sbpv pre.diff')`, 20000);
  const latexHere = process.env.AGENTS_LATEX === "1";
  if (latexHere) {
    const drawn = await P.until(`/Results/.test(document.querySelector('dialog.proposal[open] .tex-rendered .tex-preview')?.textContent ?? '')`, 60000);
    await shot("4b-proposal-tex");
    const tv = await P.ev(`(() => { const r = document.querySelector('dialog.proposal[open] .tex-rendered'); const run = r?.querySelector('.tex-run'); return { buttons: [...r.querySelectorAll(':scope > p button')].map((b) => b.textContent + ":" + b.getAttribute('aria-pressed')), plus: [...document.querySelectorAll('dialog.proposal[open] .l\\\\+')].map((x) => x.textContent), run: !!run && !run.hidden && !!run.offsetParent, typing: [...r.querySelectorAll('textarea')].filter((t) => !t.readOnly && t.offsetParent).length }; })()`);
    ok(drawn && tv.plus.includes("+ \\section{Results}") && JSON.stringify(tv.buttons) === JSON.stringify(["As proposed:true", "Before:false"]), "a proposal's .tex: its line diff, and the document as proposed rendered under it (its new section), Before offered", { drawn, tv });
    ok(!tv.run && tv.typing === 0, "the rendered document is read only: no Run, nothing to type in", tv);
    await P.ev(`[...document.querySelectorAll('dialog.proposal[open] .tex-rendered button')].find((b) => b.textContent === 'Before').click()`);
    const before = await P.until(`(() => { const t = document.querySelector('dialog.proposal[open] .tex-rendered .tex-preview')?.textContent ?? ''; return /Introduction/.test(t) && !/Results/.test(t); })()`, 60000);
    ok(before, "Before: the document as it was rendered in its place (no Results section)");
  } else {
    await sleep(500);
    ok(await P.ev(`!document.querySelector('dialog.proposal[open] .tex-rendered') && !document.querySelector('dialog.proposal[open] .file .msg')`), "a proposal's .tex where this host has no LaTeX editor: its diff only, nothing said");
  }
  await P.ev(`document.querySelector('dialog.proposal[open] .x').click()`);
  await P.ev(`document.querySelector('#task-view .task-head .link').click()`);

  // ---- a proposal's .md: its diff, and the text rendered by this page's own Markdown renderer (the chat's: a remote
  //  picture is click-to-load, never fetched), As proposed and Before
  const MD0 = "# Notes\n\nOld text.\n";
  const M = await H.addTask({ title: "Write up the results", status: "proposal", base: { "work/notes.md": MD0 }, proposal: { "work/notes.md": "# Results\n\nIt **works**.\n\n![plot](https://example.com/plot.png)\n" } });
  await P.until(`!!document.querySelector('#tasks .task[data-task="${M.task}"]')`);
  await P.ev(`document.querySelector('#tasks .task[data-task="${M.task}"]').click()`);
  await P.until(`!!document.querySelector('#task-view .proposal-card')`);
  await P.ev(`document.querySelector('#task-view .proposal-card').click()`);
  // (P.until gives the time it waited, 0 when already true: the verdict is the page's, read below)
  await P.until(`document.querySelector('dialog.proposal[open] .md-rendered h1')?.textContent === 'Results'`, 20000).catch(() => {});
  const mdDrawn = await P.ev(`document.querySelector('dialog.proposal[open] .md-rendered h1')?.textContent === 'Results'`);
  await shot("4c-proposal-md");
  const mv = await P.ev(`(() => { const r = document.querySelector('dialog.proposal[open] .md-rendered'); return { buttons: [...r.querySelectorAll(':scope > p button')].map((b) => b.textContent + ":" + b.getAttribute('aria-pressed')), strong: r.querySelector(':scope > div strong')?.textContent ?? null, remote: [...r.querySelectorAll('img')].filter((i) => /example\\.com/.test(i.getAttribute('src') ?? '')).length, plus: [...document.querySelectorAll('dialog.proposal[open] .l\\\\+')].map((x) => x.textContent) }; })()`);
  ok(mdDrawn && mv.strong === "works" && mv.plus.includes("+ # Results") && JSON.stringify(mv.buttons) === JSON.stringify(["As proposed:true", "Before:false"]), "a proposal's .md: its line diff, and under it the text as proposed, rendered by the page's Markdown renderer (heading, bold), Before offered", { mdDrawn, mv });
  ok(mv.remote === 0, "a remote picture in the proposed Markdown isn't fetched (the chat's click-to-load)", mv);
  await P.ev(`[...document.querySelectorAll('dialog.proposal[open] .md-rendered button')].find((b) => b.textContent === 'Before').click()`);
  await P.until(`document.querySelector('dialog.proposal[open] .md-rendered h1')?.textContent === 'Notes'`, 10000).catch(() => {});
  const mb = await P.ev(`(() => { const r = document.querySelector('dialog.proposal[open] .md-rendered'); return { h1: [...r.querySelectorAll(':scope > div h1')].map((x) => x.textContent), buttons: [...r.querySelectorAll(':scope > p button')].map((b) => b.textContent + ":" + b.getAttribute('aria-pressed')) }; })()`);
  ok(JSON.stringify(mb.h1) === JSON.stringify(["Notes"]) && JSON.stringify(mb.buttons) === JSON.stringify(["As proposed:false", "Before:true"]), "Before: the text as it was, rendered in its place", mb);
  await P.ev(`document.querySelector('dialog.proposal[open] .x').click()`);
  await P.ev(`document.querySelector('#task-view .task-head .link').click()`);

  // ---- Delegate…: the sheet, from the composer's text and the documents; Start
  await H.call("workspace.create", { path: "/work/notes.txt", content: { text: "alpha\n" } });
  await P.draft("Tidy these notes\nand number the sections.");
  await P.ev(`document.querySelector('#delegate').click()`);
  await P.until(`!!document.querySelector('dialog.sheet[open]')`);
  await shot("5-sheet");
  const sheet = await P.ev(`(() => { const d = document.querySelector('dialog.sheet[open]'); return { prompt: d.querySelector('#delegate-prompt').value, title: d.querySelector('#delegate-title').value, run: d.querySelector('#delegate-run').disabled, where: d.textContent.includes('This computer') }; })()`);
  ok(sheet.prompt === "Tidy these notes\nand number the sections." && sheet.title === "Tidy these notes" && sheet.where, "the sheet: the task from the composer, its title from the first line, Where: this computer", sheet);
  await P.ev(`document.querySelector('dialog.sheet[open] button[type=submit]').click()`);
  await sleep(200);
  ok(/No documents/.test(await P.ev(`document.querySelector('dialog.sheet[open] .msg').textContent`)) && !H.got.some((m) => m.method === "tasks.start"), "Start with no documents: says so, nothing sent");
  await P.ev(`(() => { const i = document.querySelector('#delegate-add'); i.value = 'work/notes.txt'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); document.querySelector('dialog.sheet[open] button[type=submit]').click(); })()`);
  await hostUntil(() => H.got.some((m) => m.method === "tasks.start"));
  const start = H.got.find((m) => m.method === "tasks.start")?.params;
  ok(start && start.title === "Tidy these notes" && start.target === "local" && start.run === false && start.docs.length === 1 && start.docs[0].path === "work/notes.txt" && start.docs[0].kind === "file" && start.docs[0].content === "alpha\n", "Start: tasks.start with the task, its document's text from the workspace, target local, May run code off", start);
  await P.until(`!document.querySelector('dialog.sheet[open]') && !!document.querySelector('#task-view')?.offsetParent`);
  ok((await P.ev(`document.querySelector('#task-view h2').textContent`)) === "Tidy these notes" && (await P.composer()) === "", "started: the new task's view shown, the composer emptied");

  // ---- the switch off: the running tasks closed first (ticked), Delegate… disabled while it turns off, then the host told
  await P.ev(`document.querySelector('#delegate-switch').click()`);
  await P.until(`!!document.querySelector('#delegate-also-close')`);
  await shot("6-off");
  const offText = await P.ev(`document.querySelector('dialog.delegate-dlg[open]').textContent`);
  const running = [...H.tasks.values()].filter((t) => t.status === "working").map((t) => t.title);
  ok(running.length === 2 && running.every((t) => offText.includes(t)) && (await P.ev(`document.querySelector('#delegate-also-close').checked`)) === false, "Turn off's confirmation: the running tasks named, \"Also close\" unticked", { offText, running });
  H.hold.add("tasks.revoke");
  await P.ev(`(() => { document.querySelector('#delegate-also-close').click(); [...document.querySelectorAll('dialog.delegate-dlg[open] button')].find((b) => b.textContent === 'Turn off').click(); })()`);
  await hostUntil(() => H.held.length === 2);
  u = await ui();
  ok(u.sw === "Delegate: turning off…" && u.btnOff === "true" && H.grant.delegate === true, "while it turns off: the switch says so, Delegate… disabled; the revokes sent first, the switch still on at the host", u);
  H.hold.clear();
  H.release();
  await hostUntil(() => H.grant?.delegate === undefined);
  await P.until(`document.querySelector('#delegate-switch').textContent === 'Delegate: off'`);
  u = await ui();
  const order = H.got.filter((m) => m.method === "tasks.revoke" || m.method === "grant.changed").map((m) => m.method === "grant.changed" ? (m.params.delegate ? "on" : "off") : "revoke").slice(-3);
  ok(order.join() === "revoke,revoke,off" && u.tasks === null && !u.view && u.log, "off: the chosen tasks closed, then the host told (no delegate); no tasks shown, back to the chats", { order, u });
  ok([...H.tasks.values()].filter((t) => running.includes(t.title)).every((t) => t.status === "closed"), "the ticked tasks are closed at the host");
  ok(P.errors.length === 0, "no page errors", P.errors);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await Br.close();
  H.stop();
  server.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
