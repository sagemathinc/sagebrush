// ci: web-artifacts.1 order=46 runner=bun chrome
// The agents page as William tried it on DEV (Nov 22 2026): the composer's draft is kept by chat, through another chat,
// a reload and a visit to Files, and goes once sent (#1615); an artifact's status says Saving… only while a change is
// saved, never after a touch that changed nothing (#1617). The built page (SAGEBRUSH_AGENTS=1), served by
// web/serve.py; for the artifacts, paired with the stand-in agent (test-delegate-host.mjs), which writes the files with
// the workspace verb and shows them as its turn's artifacts, as sagebrush-agent does.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-pane-qa.mjs
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startServe } from "../test-port.mjs";
import { browser } from "./a14-cases.mjs";
import { delegateHost } from "./test-delegate-host.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 800) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
const sitePort = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const site = `http://127.0.0.1:${sitePort}`;
const H = delegateHost();
const B = await browser();
try {
  const P = await B.tab();
  // (the chat list's buttons, newest first: the one at `i`, clicked, and its chat shown)
  const chat = async (i) => {
    await P.until(`document.querySelectorAll('#threads .thread').length > ${i}`);
    await P.ev(`(document.querySelectorAll('#threads .thread')[${i}].click(), true)`);
    await P.until(`document.querySelectorAll('#threads .thread')[${i}].classList.contains('on')`);
    await P.ev(`new Promise((r) => requestAnimationFrame(() => r(true)))`);
  };
  const backspace = async () => {
    for (const type of ["rawKeyDown", "keyUp"]) await P.send("Input.dispatchKeyEvent", { type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  };

  // ======================================================================== #1615: the draft, by chat
  await P.navigate(`${site}/agents/`);
  await P.draft("draft in chat one");
  // (reloaded at once: within the 300 ms the draft waits to be written, so it is the page's leaving that keeps it)
  await P.reload();
  ok((await P.composer()) === "draft in chat one", "D1: a draft typed and reloaded at once is in the composer again", await P.composer());

  await P.ev(`(document.querySelector('#new').click(), true)`);
  await P.until(`document.querySelectorAll('#threads .thread').length === 2`);
  ok((await P.composer()) === "", "D2: a new chat's composer is empty (the other chat's draft isn't carried over)", await P.composer());
  await P.draft("second draft");
  await chat(1);
  ok((await P.composer()) === "draft in chat one", "D2: back in the first chat, its own draft", await P.composer());
  await chat(0);
  ok((await P.composer()) === "second draft", "D2: and in the second chat, its own", await P.composer());

  // (to Files and back, as the person goes: the chat list's Files…, then the Agents page again)
  await P.ev(`(document.querySelector('#files-big').click(), true)`);
  for (const t = Date.now(); (await P.ev(`location.pathname`).catch(() => "")) !== "/" && Date.now() - t < 15000; ) await sleep(100);
  ok((await P.ev(`location.pathname`).catch(() => "")) === "/", "D3: Files… left the Agents page");
  await P.navigate(`${site}/agents/`);
  ok((await P.composer()) === "second draft", "D3: back from Files, the chat shown has its draft", await P.composer());
  await chat(1);
  ok((await P.composer()) === "draft in chat one", "D3: and the other chat has its own", await P.composer());

  // (sent: the draft goes, and stays gone after a reload; the other chat's stays)
  const users0 = await P.users();
  await P.ev(`(document.querySelector('#send').click(), true)`);
  await P.until(`document.querySelectorAll('.user').length > ${users0}`);
  ok((await P.composer()) === "", "D4: sent, the composer is empty");
  await P.reload();
  await P.until(`document.querySelectorAll('#threads .thread').length === 2`);
  ok((await P.composer()) === "", "D4: after a reload too: a sent draft doesn't come back", await P.composer());
  await chat(0);
  ok((await P.composer()) === "second draft", "D4: the other chat's draft stays", await P.composer());
  const stored = await P.ev(`JSON.parse(localStorage.getItem('sagebrush-agents-drafts-v1') ?? '{}')`);
  ok(Object.values(stored).length === 1 && Object.values(stored)[0] === "second draft", "D4: the stored drafts are the one not sent", stored);
  // (bounded: a chat no longer stored loses its draft when drafts are next written)
  await P.ev(`(localStorage.setItem('sagebrush-agents-drafts-v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('sagebrush-agents-drafts-v1')), gone: 'a chat not stored' })), true)`);
  await P.draft(" more");
  await sleep(700);
  const d5 = await P.ev(`JSON.parse(localStorage.getItem('sagebrush-agents-drafts-v1') ?? '{}')`);
  ok(!("gone" in d5) && Object.values(d5).length === 1 && Object.values(d5)[0].includes("more"), "D5: a draft of a chat no longer stored goes; the chat's own is written", d5);

  // ======================================================================== #1617: Saving… only while a change is saved
  // (from a page of no chats: the pairing link's dialog, as a first visit shows it)
  await P.ev(`(localStorage.clear(), sessionStorage.clear(), true)`);
  await P.navigate(`${site}/agents/?pair=123-456&port=${H.port}`);
  await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Connect')`, 30000);
  await P.ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Connect').click()`);
  await P.until(`[...document.querySelectorAll('.sbag-box h2')].some((h) => h.textContent === 'Allow this agent?')`, 30000);
  await P.ev(`(() => { const d = [...document.querySelectorAll('.sbag-box')].at(-1); d.querySelector('button.primary').click(); return true; })()`);
  await P.until(`document.querySelector('#connect').textContent === 'Connected'`);
  await P.ev(`(document.querySelector('#new').click(), true)`);
  await P.draft("make a notebook and a script");
  await P.ev(`(document.querySelector('#send').click(), true)`);
  for (const t = Date.now(); !H.got.some((m) => m.method === "chat.message") && Date.now() - t < 10000; ) await sleep(50);
  const conversation = H.got.find((m) => m.method === "chat.message")?.params?.conversation;
  ok(!!conversation, "the person's message reached the agent");
  const show = (turn, path, kind) => {
    for (const event of [{ type: "turn_started" }, { type: "artifact", id: path, kind, title: path.slice(1), body: "", path }, { type: "turn_finished", outcome: "completed" }])
      H.sock.send(JSON.stringify({ jsonrpc: "2.0", method: "turn.event", params: { conversation, turn_id: turn, event } }));
  };
  // (every status the pane's host shows, as it is set)
  const watch = `(() => { window.__said = []; const el = document.querySelector('#artifacts .pane-host:not([hidden]) .saved'); new MutationObserver(() => __said.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); return true; })()`;
  const said = () => P.ev(`document.querySelector('#artifacts .pane-host:not([hidden]) .saved')?.textContent ?? null`);

  // (a notebook: a character typed and taken back within the save's half second changes nothing; then a real change)
  let made = await H.call("workspace.create", { path: "/qa.ipynb", mode: "python", content: { json: { mode: "python", cells: [{ id: "c0", type: "code", code: "1 + 1" }] } } });
  ok(!made.error, "the agent wrote /qa.ipynb", made.error);
  show("t-nb", "/qa.ipynb", "notebook");
  await P.until(`document.querySelectorAll('#artifacts .nb-root .cell').length === 1 && document.querySelector('#artifacts .pane-host:not([hidden]) .saved')?.textContent === 'Saved'`, 30000);
  await P.ev(watch);
  await P.ev(`(document.querySelector('#artifacts .nb-root .cell textarea').focus(), true)`);
  await P.send("Input.insertText", { text: "x" });
  await backspace();
  await sleep(1500);
  ok((await said()) === "Saved", "S1: a notebook touched but not changed still says Saved (no Saving… or Editing… left behind)", { now: await said(), said: await P.ev(`__said`) });
  await P.send("Input.insertText", { text: "y" });
  await P.until(`document.querySelector('#artifacts .pane-host:not([hidden]) .saved')?.textContent === 'Saved' && __said.includes('Saving…')`, 10000).catch(() => {});
  const nbSaid = await P.ev(`__said`);
  ok(nbSaid.includes("Saving…") && (await said()) === "Saved", "S1: a real change says Saving…, then Saved", nbSaid);
  ok(!nbSaid.includes("Editing…"), "S1: it never says Editing…", nbSaid);
  const nb = await H.call("workspace.read", { path: "/qa.ipynb" });
  ok(JSON.stringify(nb.result ?? nb).includes("1 + 1y"), "S1: and the change is in the file", nb);
  // (a refused save stays said: a touch after it never says Saved, as nothing was)
  await P.ev(`(window.__sbTestStoreSave = () => "not saved: refused for the test", true)`);
  await P.send("Input.insertText", { text: "z" });
  await P.until(`/^not saved/.test(document.querySelector('#artifacts .pane-host:not([hidden]) .saved')?.textContent ?? '')`, 10000).catch(() => {});
  await P.send("Input.insertText", { text: "q" });
  await backspace();
  await sleep(1800);
  const refusedSaid = await said();
  ok(/^not saved: refused for the test/.test(refusedSaid ?? ""), "S1: after a refused save, a touch still says why it wasn't saved (never Saved)", refusedSaid);
  await P.ev(`(delete window.__sbTestStoreSave, true)`);
  await P.send("Input.insertText", { text: "w" });
  await P.until(`document.querySelector('#artifacts .pane-host:not([hidden]) .saved')?.textContent === 'Saved'`, 10000).catch(() => {});
  ok((await said()) === "Saved", "S1: and once a save goes through, Saved", await said());

  // (a script, the same way)
  made = await H.call("workspace.create", { path: "/qa.py", content: { text: "print(1)\n" } });
  ok(!made.error, "the agent wrote /qa.py", made.error);
  show("t-py", "/qa.py", "code");
  await P.until(`!!document.querySelector('#artifacts .pane-host:not([hidden]) textarea.code-edit') && document.querySelector('#artifacts .pane-host:not([hidden]) .saved')?.textContent === 'Saved'`, 30000);
  await P.ev(watch);
  await P.ev(`(document.querySelector('#artifacts .pane-host:not([hidden]) textarea.code-edit').focus(), true)`);
  await P.send("Input.insertText", { text: "x" });
  await backspace();
  await sleep(1800);
  ok((await said()) === "Saved", "S2: a script touched but not changed says Saved again", { now: await said(), said: await P.ev(`__said`) });
  ok(!(await P.ev(`__said`)).includes("Editing…"), "S2: it never says Editing…", await P.ev(`__said`));
  ok(P.errors.length === 0, "no page errors", P.errors);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  H.stop();
  server.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
