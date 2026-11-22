// ci: web-artifacts.1 order=32 runner=bun chrome
// Merge on the Agents page (Pair and Delegate plan, UI r3.2 §2; S3 item 1), end to end in headless Chromium: the built
// page (SAGEBRUSH_AGENTS=1), served by web/serve.py, paired with the stand-in Delegate host (test-delegate-host.mjs),
// over this browser's real workspace. What it shows: a proposal merged into the person's notebook and text file as they
// are now (both sides' changes in), the proposal's rich outputs taken out and its Markdown and attachments kept, the
// written notebook read back as the very text tasks.merged reported; a conflict waiting for a pick (Merge off until
// then); a board refused; and a lost tasks.merged answer finished after a reload, with the same request.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-delegate-merge.mjs
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServe } from "../test-port.mjs";
import { browser } from "./a14-cases.mjs";
import { delegateHost } from "./test-delegate-host.mjs";
import { toIpynb } from "../notebook/ipynb.js";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 700) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostUntil = async (f, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(25); } return false; };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let server, H, Br;
try {
  const sitePort = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
  const site = `http://127.0.0.1:${sitePort}`;
  H = delegateHost();
  Br = await browser();
  const P = await Br.tab();
  // (SHOTS=<dir>: a picture of the page at each step, for a person to look at)
  const shot = async (name) => { if (process.env.SHOTS) writeFileSync(join(process.env.SHOTS, name + ".png"), Buffer.from((await P.send("Page.captureScreenshot", { format: "png" })).data, "base64")); };
  const pair = async () => {
    await P.navigate(`${site}/agents/?pair=123-456&port=${H.port}`);
    await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Connect')`, 30000);
    await P.ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Connect').click()`);
    await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Allow')`, 30000);
    await P.ev(`(() => { const d = [...document.querySelectorAll('.sbag-dlg')].at(-1); const all = [...d.querySelectorAll('label')].find((l) => l.textContent.startsWith('Everything')).querySelector('input'); all.checked = true; all.dispatchEvent(new Event('change')); [...d.querySelectorAll('button')].find((b) => b.textContent === 'Allow').click(); })()`);
    await P.until(`document.querySelector('#connect').textContent === 'Connected'`);
    await P.until(`!!document.querySelector('#delegate-switch')?.offsetParent`);
    await P.ev(`document.querySelector('#delegate-switch').click()`);
    await P.until(`!!document.querySelector('dialog.delegate-dlg[open]')`);
    await P.ev(`[...document.querySelectorAll('dialog.delegate-dlg[open] button')].find((b) => b.textContent === 'Turn on').click()`);
    await hostUntil(() => H.grant?.delegate === true);
  };
  const chip = (t) => P.ev(`document.querySelector('#tasks .task[data-task="${t.task}"] .chip')?.textContent ?? null`);
  const openProposal = async (t) => {
    await P.until(`!!document.querySelector('#tasks .task[data-task="${t.task}"]')`);
    await P.ev(`document.querySelector('#tasks .task[data-task="${t.task}"]').click()`);
    await P.until(`!!document.querySelector('#task-view .proposal-card')`);
    await P.ev(`document.querySelector('#task-view .proposal-card').click()`);
    await P.until(`!!document.querySelector('dialog.proposal[open] .sbpv .file')`, 20000);
    await P.until(`document.querySelector('dialog.proposal[open] button[data-act="merge"]')?.getAttribute('aria-disabled') === null`);
  };
  const status = () => P.ev(`document.querySelector('dialog.proposal[open] .proposal-actions [role=status]')?.textContent ?? null`);
  const read = async (path) => (await H.call("workspace.read", { path })).result;

  await pair();
  // ---- the person's files, in this browser's workspace; the task's base is what the page sent (its .ipynb text)
  const att = { "p.png": { "image/png": PNG } };
  await H.call("workspace.create", { path: "/work/a.ipynb", content: { json: { mode: "python", cells: [{ id: "m1", type: "markdown", code: "![p](attachment:p.png) Notes", attachments: att }, { id: "c1", type: "code", code: "1+1" }, { id: "c2", type: "code", code: "plot()" }] } } });
  await H.call("workspace.create", { path: "/work/notes.txt", content: { text: "one\ntwo\nthree\n" } });
  const r0 = await read("/work/a.ipynb");
  const base = toIpynb(r0.content.json);
  const j = JSON.parse(base);
  j.cells[0].source = ["![p](attachment:p.png) Notes, and more"];
  const c2 = j.cells.find((c) => c.id === "c2");
  c2.source = ["plot(cos)"];
  c2.outputs = [{ output_type: "display_data", data: { "text/html": "<script>alert(1)</script>", "application/javascript": "alert(1)", "image/png": PNG, "text/plain": "<Figure>" }, metadata: {} }];
  const A = await H.addTask({ title: "Add a cos curve", base: { "work/a.ipynb": base, "work/notes.txt": "one\ntwo\nthree\n" }, proposal: { "work/a.ipynb": JSON.stringify(j, null, 1), "work/notes.txt": "ONE\ntwo\nthree\n" } });
  // (the person goes on working after the task started)
  const rn = await read("/work/notes.txt");
  await H.call("workspace.write", { path: "/work/notes.txt", content: { text: "one\ntwo\nthree\nmine\n" }, base: rn.rev });
  await P.until(`document.querySelectorAll('#tasks .task').length === 1`);

  // ---- Merge: the person's versions as they are now, both sides' changes in; recorded; the chip Merged
  await openProposal(A);
  await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="merge"]').click()`);
  await hostUntil(() => H.got.some((m) => m.method === "tasks.merged"), 20000);
  const sent = H.got.find((m) => m.method === "tasks.merged")?.params;
  await P.until(`!document.querySelector('dialog.proposal[open]')`, 20000).catch(() => {});
  const notes = await read("/work/notes.txt");
  const nb = await read("/work/a.ipynb");
  const text = new TextDecoder().decode(Uint8Array.from(atob(notes.content.base64 ?? btoa(notes.content.text ?? "")), (c) => c.charCodeAt(0)));
  ok((notes.content.text ?? text) === "ONE\ntwo\nthree\nmine\n", "Merge: the text file has both sides' changes (the proposal's and the person's since)", notes.content);
  const cells = nb.content.json.cells, w2 = cells.find((c) => c.id === "c2"), m1 = cells.find((c) => c.id === "m1");
  ok(w2?.code === "plot(cos)" && cells.length === 3, "Merge: the notebook has the proposal's cell change", cells.map((c) => c.code));
  ok(JSON.stringify(w2?.outputs?.[0]?.data) === JSON.stringify({ "image/png": PNG, "text/plain": "<Figure>" }), "the proposal's rich output: HTML and JavaScript not written, the picture and its text kept", w2?.outputs);
  ok(m1?.type === "markdown" && m1.code === "![p](attachment:p.png) Notes, and more" && JSON.stringify(m1.attachments) === JSON.stringify(att), "its Markdown stays Markdown, its attachment byte for byte", m1);
  const fNb = sent?.files.find((f) => f.path === "work/a.ipynb"), fTx = sent?.files.find((f) => f.path === "work/notes.txt");
  ok(sent && sent.task === A.task && sent.proposal === A.proposal && /^[0-9a-f]{32}$/.test(sent.merge_id) && fTx?.mine?.content === "one\ntwo\nthree\nmine\n" && fTx?.merged?.content === "ONE\ntwo\nthree\nmine\n" && fNb?.mine?.content === base, "tasks.merged: the proposal and its seq, a merge_id, every file's mine and merged in full", sent && { ...sent, files: sent.files.map((f) => ({ path: f.path, mine: f.mine?.content?.slice(0, 40), merged: f.merged?.content?.slice(0, 40) })) });
  ok(fNb?.merged?.content === toIpynb(nb.content.json), "the notebook written, read back, is the very text reported as merged (what recovery compares)");
  await P.until(`document.querySelector('#tasks .task[data-task="${A.task}"] .chip')?.textContent === 'Merged'`, 10000).catch(() => {});
  ok((await chip(A)) === "Merged", "recorded: the chip says Merged", await chip(A));

  // ---- a conflict: listed with both sides, Merge off until it is picked; then written as picked
  const B = await H.addTask({ title: "Rename the first line", base: { "work/notes.txt": "ONE\ntwo\nthree\nmine\n" }, proposal: { "work/notes.txt": "First\ntwo\nthree\nmine\n" } });
  const r1 = await read("/work/notes.txt");
  await H.call("workspace.write", { path: "/work/notes.txt", content: { text: "Uno\ntwo\nthree\nmine\n" }, base: r1.rev });
  await openProposal(B);
  await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="merge"]').click()`);
  await P.until(`!!document.querySelector('dialog.proposal[open] .merge-slot .conflict')`, 20000);
  await shot("merge-1-conflict");
  const conf = await P.ev(`(() => { const c = document.querySelector('dialog.proposal[open] .merge-slot .conflict'); return { text: c.textContent, buttons: [...c.querySelectorAll('button[data-pick]')].map((b) => b.textContent), merge: document.querySelector('dialog.proposal[open] button[data-act="merge"]').getAttribute('aria-disabled') }; })()`);
  ok(/Uno/.test(conf.text) && /First/.test(conf.text) && conf.buttons.join() === "Keep mine,Take Claude Code's" && conf.merge === "true" && /Pick a side for the conflict/.test(await status()), "a conflict: both sides shown, Keep mine / Take the agent's; Merge off until it's picked", conf);
  ok((await read("/work/notes.txt")).content.text === "Uno\ntwo\nthree\nmine\n" && !H.got.some((m) => m.method === "tasks.merged" && m.params.task === B.task), "nothing written or sent while a conflict is open");
  await P.ev(`document.querySelector('dialog.proposal[open] .merge-slot button[data-pick="theirs"]').click()`);
  ok((await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="merge"]').getAttribute('aria-disabled')`)) === null, "picked: Merge on");
  await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="merge"]').click()`);
  await hostUntil(() => H.got.some((m) => m.method === "tasks.merged" && m.params.task === B.task), 20000);
  ok((await read("/work/notes.txt")).content.text === "First\ntwo\nthree\nmine\n", "Merge: written as picked");
  await P.until(`!document.querySelector('dialog.proposal[open]')`, 10000).catch(() => {});

  // ---- a board: not merged here yet, said, nothing written
  const C = await H.addTask({ title: "Rearrange the board", base: { "work/plan.board.json": "{}" }, proposal: { "work/plan.board.json": "{\"x\":1}" } });
  await openProposal(C);
  await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="merge"]').click()`);
  await P.until(`/Can't merge this kind yet/.test(document.querySelector('dialog.proposal[open] .proposal-actions [role=status]')?.textContent ?? '')`, 10000).catch(() => {});
  ok(/Can't merge this kind yet: work\/plan\.board\.json/.test(await status()) && !H.got.some((m) => m.method === "tasks.merged" && m.params.task === C.task), "a board: Can't merge this kind yet, nothing sent", await status());
  await P.ev(`document.querySelector('dialog.proposal[open] .x').click()`);

  // ---- a file changed after it was pinned, before its write (another tab): it isn't written, the merge is incomplete
  //      (no tasks.merged), the other file is written; Close what's left records the rest as not sent
  await H.call("workspace.create", { path: "/work/x1.txt", content: { text: "x1\n" } });
  await H.call("workspace.create", { path: "/work/x2.txt", content: { text: "x2\n" } });
  const E = await H.addTask({ title: "Two files", base: { "work/x1.txt": "x1\n", "work/x2.txt": "x2\n" }, proposal: { "work/x1.txt": "X1\n", "work/x2.txt": "X2\n" } });
  await openProposal(E);
  H.hold.add("tasks.file");
  await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="merge"]').click()`);
  // (x1's base and proposal let through; x1 is pinned next; x2's first read held while x1 changes in "another tab")
  for (let i = 0; i < 2; i++) { await hostUntil(() => H.held.length === 1); H.release(); }
  await hostUntil(() => H.held.length === 1);
  const x1 = await read("/work/x1.txt");
  await H.call("workspace.write", { path: "/work/x1.txt", content: { text: "x1 from the other tab\n" }, base: x1.rev });
  H.hold.clear();
  H.release();
  await P.until(`!!document.querySelector('dialog.proposal[open] .merge-slot .incomplete')`, 20000).catch(() => {});
  await shot("merge-2-incomplete");
  const inc = await P.ev(`document.querySelector('dialog.proposal[open] .merge-slot')?.textContent ?? null`);
  ok(/couldn't be merged: work\/x1\.txt\./.test(inc ?? "") && !/x2/.test(inc ?? "") && (await status()) === "Merge incomplete" && (await chip(E)) === "Merge incomplete", "a file changed between the pin and its write: Merge incomplete, it named; the chip says so", { inc, chip: await chip(E) });
  ok((await read("/work/x1.txt")).content.text === "x1 from the other tab\n" && (await read("/work/x2.txt")).content.text === "X2\n" && !H.got.some((m) => m.method === "tasks.merged" && m.params.task === E.task), "x1 left as the other tab left it, x2 written; no tasks.merged");
  await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="close-rest"]').click()`);
  await hostUntil(() => H.got.some((m) => m.method === "tasks.merged" && m.params.task === E.task), 20000);
  const er = H.got.find((m) => m.method === "tasks.merged" && m.params.task === E.task)?.params;
  const ex = Object.fromEntries((er?.files ?? []).map((f) => [f.path, f]));
  await P.until(`/^Recorded\\./.test(document.querySelector('#toast')?.textContent ?? '')`, 10000).catch(() => {});
  const toastText = await P.ev(`document.querySelector('#toast')?.textContent ?? null`);
  ok(toastText === "Recorded. Merged: work/x2.txt. Left as they were: work/x1.txt.", "Close what's left: the page names what it merged and what it left, never \"your files have the changes\"", toastText);
  ok(ex["work/x1.txt"]?.mine === null && ex["work/x1.txt"]?.merged === null && ex["work/x2.txt"]?.merged?.content === "X2\n", "Close what's left: tasks.merged with x1 not sent (a receipt), x2 as written", ex);
  await P.until(`!document.querySelector('dialog.proposal[open]')`, 10000).catch(() => {});

  // ---- a lost answer: the files written, tasks.merged unanswered, the page reloaded; the kept record finishes the
  //      decision with the same request (merge_id and bytes), and the chip says Merged
  const D = await H.addTask({ title: "Number the lines", base: { "work/notes.txt": "First\ntwo\nthree\nmine\n" }, proposal: { "work/notes.txt": "1 First\ntwo\nthree\nmine\n" } });
  await openProposal(D);
  H.hold.add("tasks.merged");
  await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="merge"]').click()`);
  await hostUntil(() => H.held.some((m) => m.method === "tasks.merged"), 20000);
  ok((await read("/work/notes.txt")).content.text === "1 First\ntwo\nthree\nmine\n", "written before tasks.merged is answered");
  const first = H.held.find((m) => m.method === "tasks.merged").params;
  await pair();
  await hostUntil(() => H.held.filter((m) => m.method === "tasks.merged").length === 2, 20000);
  const second = H.held.filter((m) => m.method === "tasks.merged")[1]?.params;
  ok(second && JSON.stringify(second) === JSON.stringify(first), "after a reload: the kept decision sent again, the same request (merge_id and bytes)", { first: first?.merge_id, second: second?.merge_id });
  const writesBefore = (await read("/work/notes.txt")).rev;
  H.hold.clear();
  H.release();
  await P.until(`document.querySelector('#tasks .task[data-task="${D.task}"] .chip')?.textContent === 'Merged'`, 10000).catch(() => {});
  ok((await chip(D)) === "Merged" && H.tasks.get(D.task).log.filter((e) => e.event.status === "merged").length === 1 && (await read("/work/notes.txt")).rev === writesBefore, "both answered alike, recorded once; the chip Merged; nothing written again", await chip(D));

  // ---- consolidate two files into one: the proposal deletes both starting documents and adds the new file. The view
  //      lists each deletion; Merge removes both (to Trash, by revision) and makes the new one; recorded as absent.
  await H.call("workspace.create", { path: "/work/tmp1.py", content: { text: "def f(): return 1\n" } });
  await H.call("workspace.create", { path: "/work/tmp2.py", content: { text: "def g(): return 2\n" } });
  const K = await H.addTask({ title: "Consolidate tmp1.py and tmp2.py into lib.py", base: { "work/tmp1.py": "def f(): return 1\n", "work/tmp2.py": "def g(): return 2\n" }, proposal: { "work/tmp1.py": null, "work/tmp2.py": null, "work/lib.py": "def f(): return 1\n\ndef g(): return 2\n" } });
  await openProposal(K);
  const krows = await P.ev(`[...document.querySelectorAll('dialog.proposal[open] .sbpv .file')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40))`);
  ok(krows.some((r) => r.startsWith("work/tmp1.py deleted")) && krows.some((r) => r.startsWith("work/tmp2.py deleted")) && krows.some((r) => r.startsWith("work/lib.py added")), "consolidate: the view lists both deletions and the new file", krows);
  await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="merge"]').click()`);
  await hostUntil(() => H.got.some((m) => m.method === "tasks.merged" && m.params.task === K.task), 20000);
  const gone = async (p) => (await H.call("workspace.read", { path: p })).error !== undefined;
  ok((await gone("/work/tmp1.py")) && (await gone("/work/tmp2.py")) && (await read("/work/lib.py")).content.text === "def f(): return 1\n\ndef g(): return 2\n", "consolidate: Merge removes both starting documents and makes lib.py");
  const kp = Object.fromEntries(H.got.find((m) => m.method === "tasks.merged" && m.params.task === K.task).params.files.map((f) => [f.path, f]));
  ok(kp["work/tmp1.py"].merged?.absent && kp["work/tmp2.py"].merged?.absent && kp["work/tmp1.py"].mine?.content === "def f(): return 1\n" && kp["work/lib.py"].mine?.absent && kp["work/lib.py"].merged?.content?.startsWith("def f()"), "consolidate: tasks.merged reports the two removed (absent) and the one made", kp);
  await P.until(`!document.querySelector('dialog.proposal[open]')`, 10000).catch(() => {});

  // ---- one action at a time per task, whichever dialog started it (a dialog closed and opened again included)
  const acts = () => P.ev(`Object.fromEntries([...document.querySelectorAll('dialog.proposal[open] button[data-act]')].map((b) => [b.dataset.act, b.getAttribute('aria-disabled') === 'true']))`);
  const reopen = async (t) => {
    await P.ev(`document.querySelector('dialog.proposal[open] .x')?.click()`);
    await P.ev(`document.querySelector('#task-view .proposal-card').click()`);
    await P.until(`!!document.querySelector('dialog.proposal[open] .sbpv .file')`, 20000);
    await sleep(300);
  };
  {
    // (A: a Merge's write held: Ask for changes is off in the same dialog, its Send refuses, and so after close/reopen)
    await H.call("workspace.create", { path: "/work/held.txt", content: { text: "h\n" } });
    const G = await H.addTask({ title: "Held merge", base: { "work/held.txt": "h\n" }, proposal: { "work/held.txt": "H\n" } });
    await openProposal(G);
    await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="ask"]').click()`);
    await P.until(`!!document.querySelector('dialog.proposal[open] .ask-block textarea')`);
    await P.ev(`(() => { const t = document.querySelector('dialog.proposal[open] .ask-block textarea'); t.value = 'a note'; t.dispatchEvent(new Event('input')); })()`);
    await P.ev(`(window.__seamAt = null, window.__mergeSeam = (op, p) => op === "write" && p === "work/held.txt" ? new Promise((go) => { window.__seamAt = p; window.__seamGo = go; }) : undefined, 1)`);
    await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="merge"]').click()`);
    await P.until(`window.__seamAt === "work/held.txt"`, 20000);
    const same = await acts();
    await P.ev(`document.querySelector('dialog.proposal[open] .ask-block button.primary').click()`);
    await sleep(300);
    ok(same.merge && same.ask && same.close && !H.got.some((m) => m.method === "tasks.ask" && m.params.task === G.task), "a Merge writing: every action off in its dialog, and an open Ask's Send sends nothing", same);
    await reopen(G);
    const again = await acts();
    await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="ask"]').click()`);
    await sleep(200);
    ok(again.merge && again.ask && again.close && !(await P.ev(`!!document.querySelector('dialog.proposal[open] .ask-block')`)), "closed and opened again while the Merge writes: still every action off, Ask opens nothing", again);
    await P.ev(`(window.__mergeSeam = null, window.__seamGo(), 1)`);
    await hostUntil(() => H.got.some((m) => m.method === "tasks.merged" && m.params.task === G.task), 20000);
    ok((await read("/work/held.txt")).content.text === "H\n" && !H.got.some((m) => m.method === "tasks.ask" && m.params.task === G.task), "the Merge finishes and is recorded; no Ask was sent meanwhile");
    await P.until(`!document.querySelector('dialog.proposal[open]')`, 10000).catch(() => {});
    await P.ev(`document.querySelector('dialog.proposal[open] .x')?.click()`);
  }
  {
    // (B: an Ask for changes held at the agent: Merge is off in the same dialog, and so after close/reopen; nothing written)
    await H.call("workspace.create", { path: "/work/asked.txt", content: { text: "a\n" } });
    const Q = await H.addTask({ title: "Held ask", base: { "work/asked.txt": "a\n" }, proposal: { "work/asked.txt": "A\n" } });
    await openProposal(Q);
    H.hold.add("tasks.ask");
    await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="ask"]').click()`);
    await P.until(`!!document.querySelector('dialog.proposal[open] .ask-block textarea')`);
    await P.ev(`(() => { const t = document.querySelector('dialog.proposal[open] .ask-block textarea'); t.value = 'make it louder'; t.dispatchEvent(new Event('input')); document.querySelector('dialog.proposal[open] .ask-block button.primary').click(); })()`);
    await hostUntil(() => H.held.some((m) => m.method === "tasks.ask"), 20000);
    const same = await acts();
    await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="merge"]').click()`);
    await sleep(300);
    ok(same.merge && same.ask && same.close && (await read("/work/asked.txt")).content.text === "a\n", "an Ask for changes sending: every action off in its dialog, Merge writes nothing", same);
    await reopen(Q);
    const again = await acts();
    await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="merge"]').click()`);
    await sleep(500);
    ok(again.merge && again.ask && again.close && (await read("/work/asked.txt")).content.text === "a\n" && !H.got.some((m) => m.method === "tasks.merged" && m.params.task === Q.task), "closed and opened again while the Ask is sent: still every action off, Merge writes nothing and sends nothing", again);
    H.hold.clear();
    H.release();
    await hostUntil(() => H.tasks.get(Q.task).status === "working", 10000);
    ok((await read("/work/asked.txt")).content.text === "a\n", "the Ask is answered; the person's file never written");
    await P.ev(`document.querySelector('dialog.proposal[open] .x')?.click()`);
  }

  // ---- a removal and a late edit: the proposal deletes a file the person hasn't changed; the person edits it after
  //      Merge checked it and before it is removed (the page's seam, on this host only). The removal is refused at the
  //      workspace (its revision checked with its identity): the file stays with the edit, the merge is incomplete,
  //      nothing is sent and no "Merged" is said. Then the same for a notebook saved through sync's journal.
  const lateEdit = async (path, content, edit, label) => {
    const base0 = await read("/" + path);
    const baseText = path.endsWith(".ipynb") ? toIpynb(base0.content.json) : base0.content.text;
    const T = await H.addTask({ title: "Remove " + path, base: { [path]: baseText }, proposal: { [path]: null } });
    await openProposal(T);
    await P.ev(`(window.__seamAt = null, window.__mergeSeam = (op, p) => op === "remove" && p === ${JSON.stringify(path)} ? new Promise((go) => { window.__seamAt = p; window.__seamGo = go; }) : undefined, 1)`);
    await P.ev(`document.querySelector('#toast').textContent = ''`);
    await P.ev(`document.querySelector('dialog.proposal[open] button[data-act="merge"]').click()`);
    await P.until(`window.__seamAt === ${JSON.stringify(path)}`, 20000);
    const now = await read("/" + path);
    await H.call("workspace.write", { path: "/" + path, content: edit, base: now.rev });
    await P.ev(`(window.__mergeSeam = null, window.__seamGo(), 1)`);
    await P.until(`!!document.querySelector('dialog.proposal[open] .merge-slot .incomplete')`, 20000).catch(() => {});
    const after = await read("/" + path).catch(() => null);
    ok(after && JSON.stringify(after.content).includes(label) && (await status()) === "Merge incomplete" && (await chip(T)) === "Merge incomplete", `${path}: an edit after Merge checked it, before its removal: not removed, the edit kept, Merge incomplete`, { after: JSON.stringify(after?.content ?? null).slice(0, 200), status: await status(), chip: await chip(T) });
    await sleep(300);
    ok(!H.got.some((m) => m.method === "tasks.merged" && m.params.task === T.task) && !/Merged/.test(await P.ev(`document.querySelector('#toast').textContent`)), `${path}: no tasks.merged, and no "Merged" said`);
    await P.ev(`document.querySelector('dialog.proposal[open] .x')?.click()`);
  };
  await H.call("workspace.create", { path: "/work/del.txt", content: { text: "keep\n" } });
  await lateEdit("work/del.txt", null, { text: "keep, and a late line\n" }, "a late line");
  // (sync's journal on in this browser, as Workspace.activateJournal leaves its fences; the page loaded again under it)
  await H.call("workspace.create", { path: "/work/jn.ipynb", content: { json: { mode: "python", cells: [{ id: "j1", type: "code", code: "x = 1" }] } } });
  const FENCE = "__sagebrush-workspace__";
  const on = await P.ev(`(async () => {
    const db = await new Promise((ok, no) => { const r = indexedDB.open("sagebrush"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const f0 = await new Promise((ok) => { const r = db.transaction("notebooks").objectStore("notebooks").get(${JSON.stringify(FENCE)}); r.onsuccess = () => ok(r.result); });
    if (!f0) return false;
    await new Promise((ok) => { const t = db.transaction("notebooks", "readwrite"); t.objectStore("notebooks").put({ ...f0, phase: "journal", journal: 1 }); t.oncomplete = ok; });
    db.close();
    return true;
  })()`);
  await pair();
  await lateEdit("work/jn.ipynb", null, { json: { mode: "python", cells: [{ id: "j1", type: "code", code: "x = 2  # a late edit" }] } }, "a late edit");
  const journaled = await P.ev(`(async () => {
    const db = await new Promise((ok, no) => { const r = indexedDB.open("sagebrush"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const all = await new Promise((ok) => { const r = db.transaction("notebooks").objectStore("notebooks").getAll(); r.onsuccess = () => ok(r.result); });
    db.close();
    const rec = all.find((x) => JSON.stringify(x.cells ?? []).includes("a late edit"));
    return !!rec && ("j" in rec || "unjournaled" in rec);
  })()`);
  ok(on && journaled, "the notebook row ran under sync's journal (its late edit saved through it)", { on, journaled });
  ok(P.errors.length === 0, "no page errors", P.errors);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await Br?.close();
  H?.stop();
  server?.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
