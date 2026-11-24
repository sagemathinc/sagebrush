// ci: web-artifacts.1 order=46 runner=bun chrome
// The agents page as William tried it on DEV (Nov 22 2026): the composer's draft is kept by chat, through another chat,
// a reload and a visit to Files, and goes once sent (#1615); an artifact's status says Saving… only while a change is
// saved, never after a touch that changed nothing (#1617); a code file is shown in colour, read only, with ✎ Edit to
// write in it (#1618); the pane's head has Open, the file on its own page in a new tab (#1614). The built page (SAGEBRUSH_AGENTS=1), served by
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

  // (D6: the limit in all holds when many chats' drafts wait to be written together: the page's 300 ms draft timer held
  //  (the test's, never fired), so all ten are written only when the page is left; the composer's chat keeps its own,
  //  astra4's SEC case)
  await P.ev(`(() => { const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => (ms === 300 ? 0 : st(f, ms, ...a)); return true; })()`);
  const big = "x".repeat(60000);
  for (let i = 0; i < 10; i++) {
    const n = await P.ev(`document.querySelectorAll('#threads .thread').length`);
    await P.ev(`(document.querySelector('#new').click(), true)`);
    await P.until(`document.querySelectorAll('#threads .thread').length === ${n + 1}`);
    await P.draft(big + "#" + i);
  }
  const pendingBefore = await P.ev(`Object.values(JSON.parse(localStorage.getItem('sagebrush-agents-drafts-v1') ?? '{}')).filter((t) => t.startsWith('xxx')).length`);
  await P.reload();
  const raw6 = await P.ev(`localStorage.getItem('sagebrush-agents-drafts-v1') ?? ''`);
  const bigs = Object.values(JSON.parse(raw6 || "{}")).filter((t) => t.startsWith("xxx"));
  ok(pendingBefore === 0 && raw6.length <= 524288 && bigs.length === 8 && bigs.some((t) => t.endsWith("#9")), "D6: ten long drafts written at once: the record stays within its limit as stored, the composer's chat's draft kept", { pendingBefore, size: raw6.length, kept: bigs.map((t) => t.slice(-2)) });
  // (the newest chat, first in the list: the test's hold kept the chats' own save from saying which was shown)
  await chat(0);
  ok((await P.composer()).endsWith("#9"), "D6: and that chat has its draft after the reload");

  // (D7: the browser's storage refuses the drafts' record: a draft still comes back on a switch to another chat and
  //  back, as this page keeps it (astra2's TESTS case))
  await P.ev(`(document.querySelector('#new').click(), true)`);
  const n7 = await P.ev(`document.querySelectorAll('#threads .thread').length`);
  await P.ev(`(() => { const old = Storage.prototype.setItem; window.__restoreStorage = () => (Storage.prototype.setItem = old); Storage.prototype.setItem = function (k, v) { if (k === 'sagebrush-agents-drafts-v1') throw new DOMException('fixture quota', 'QuotaExceededError'); return old.call(this, k, v); }; return true; })()`);
  await P.draft("UNSENT_QUOTA_DRAFT");
  await sleep(800);
  await P.ev(`(document.querySelector('#new').click(), true)`);
  await P.until(`document.querySelectorAll('#threads .thread').length === ${n7 + 1}`);
  await chat(1);
  ok((await P.composer()) === "UNSENT_QUOTA_DRAFT", "D7: storage refusing the drafts' record, a draft still comes back after a switch to another chat", await P.composer());
  await P.ev(`(__restoreStorage(), true)`);
  // (and once the storage takes it again, the next draft's write writes the refused one too)
  await chat(0);
  await P.draft("after the refusal");
  await sleep(800);
  const d7 = await P.ev(`Object.values(JSON.parse(localStorage.getItem('sagebrush-agents-drafts-v1') ?? '{}'))`);
  ok(d7.includes("UNSENT_QUOTA_DRAFT") && d7.includes("after the refusal"), "D7: once storage takes writes again, the refused draft is written with the next one", d7.map((t) => t.slice(0, 30)));

  // (D8: a new chat's draft written before the chats' own save: the chat is added to the stored record as the one shown,
  //  not with the record's older choice (the page came back to the other chat after Files, astra2's D3 note). The
  //  page's 300 ms timers are held, the test's, and only the draft's is run)
  // (cleared from another page of the site: the Agents page stores its chats as it is left)
  await P.send("Page.navigate", { url: `${site}/agents/connect/` });
  await P.until(`location.pathname === '/agents/connect/' && document.readyState === 'complete'`);
  await P.ev(`(localStorage.clear(), sessionStorage.clear(), true)`);
  await P.navigate(`${site}/agents/`);
  await P.until(`document.querySelectorAll('#threads .thread').length === 1`);
  await P.draft("in the first chat");
  await sleep(800);
  await P.ev(`(() => { const st = window.setTimeout, ct = window.clearTimeout; window.__held = []; window.setTimeout = (f, ms, ...a) => (ms === 300 ? (__held.push(f), -__held.length) : st(f, ms, ...a)); window.clearTimeout = (id) => (typeof id === 'number' && id < 0 ? (__held[-id - 1] = null) : ct(id)); return true; })()`);
  await P.ev(`(document.querySelector('#new').click(), true)`);
  await P.until(`document.querySelectorAll('#threads .thread').length === 2`);
  await P.draft("in the new chat");
  const ran = await P.ev(`(() => { const f = __held.filter(Boolean).at(-1); f?.(); return !!f; })()`);
  const d8 = await P.ev(`(() => { const v = JSON.parse(localStorage.getItem('sagebrush-agents-preview-v1') ?? '{}'); return { current: v.current, ids: v.threads?.map((t) => t.id) }; })()`);
  ok(ran && d8.ids?.length === 2 && d8.current === d8.ids[1], "D8: the new chat, added to the stored chats with its draft, is stored as the one shown", d8);
  await P.reload();

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
  // (S3: a notebook save that completes while its pane closes: Closing… stays, never Saved over it (astra2's TESTS
  //  case: the save held in IndexedDB until the close has begun))
  await P.ev(`(() => { window.__closeSaid=[];const el=document.querySelector('#artifacts .pane-host:not([hidden]) .saved');new MutationObserver(()=>__closeSaid.push(el.textContent)).observe(el,{childList:true,characterData:true,subtree:true}); const r=indexedDB.open('sagebrush');r.onsuccess=()=>{const db=r.result,t=db.transaction('notebooks','readwrite'),st=t.objectStore('notebooks'),end=Date.now()+1000;window.__holding=true;const spin=()=>{if(Date.now()<end)st.get('__hold__').onsuccess=spin;};spin();t.oncomplete=()=>db.close();};return true;})()`);
  await P.until(`window.__holding===true`);
  await P.ev(`(document.querySelector('#artifacts .nb-root .cell textarea').focus(),true)`);
  await P.send('Input.insertText',{text:' # close'});
  await P.ev(`(document.querySelector('#close').click(),true)`);
  await P.until(`!document.body.classList.contains('has-artifact')`,10000);
  const closingTrace=await P.ev(`__closeSaid`);
  const ci=closingTrace.indexOf('Closing…');ok(ci>=0&&!closingTrace.slice(ci+1).includes('Saved'),'S3: a save that completes while the notebook closes never says Saved over Closing…',closingTrace);

  // (a script, the same way)
  made = await H.call("workspace.create", { path: "/qa.py", content: { text: "print(1)\n" } });
  ok(!made.error, "the agent wrote /qa.py", made.error);
  show("t-py", "/qa.py", "code");
  await P.until(`!!document.querySelector('#artifacts .pane-host:not([hidden]) .mode-toggle:not([hidden])') && document.querySelector('#artifacts .pane-host:not([hidden]) .saved')?.textContent === 'Saved'`, 30000);
  await P.ev(`(document.querySelector('#artifacts .pane-host:not([hidden]) .mode-toggle').click(), true)`);
  await P.until(`!!document.querySelector('#artifacts .pane-host:not([hidden]) textarea.code-edit')`);
  await P.ev(watch);
  await P.ev(`(document.querySelector('#artifacts .pane-host:not([hidden]) textarea.code-edit').focus(), true)`);
  await P.send("Input.insertText", { text: "x" });
  await backspace();
  await sleep(1800);
  ok((await said()) === "Saved", "S2: a script touched but not changed says Saved again", { now: await said(), said: await P.ev(`__said`) });
  ok(!(await P.ev(`__said`)).includes("Editing…"), "S2: it never says Editing…", await P.ev(`__said`));

  // ======================================================================== #1618: a code file in colour, ✎ Edit
  const HOST = "#artifacts .pane-host:not([hidden])";
  made = await H.call("workspace.create", { path: "/mandel.py", content: { text: "def f(z):\n    return z * z + 1  # step\n# <img src=x onerror=\"window.__xss = 1\">\n" } });
  ok(!made.error, "the agent wrote /mandel.py", made.error);
  show("t-mandel", "/mandel.py", "code");
  await P.until(`document.querySelector('${HOST} .file-path')?.textContent.startsWith('/mandel.py') && !!document.querySelector('${HOST} pre.code-view .hk')`, 30000);
  const v = await P.ev(`(() => { const h = document.querySelector('${HOST}'), b = h.querySelector('.mode-toggle'); return { text: h.querySelector('pre.code-view').textContent, kw: [...h.querySelectorAll('pre.code-view .hk')].map((e) => e.textContent), comment: h.querySelector('pre.code-view .hc')?.textContent, ta: !!h.querySelector('textarea'), label: b.textContent, img: !!h.querySelector('img'), xss: !!window.__xss }; })()`);
  ok(v.text === "def f(z):\n    return z * z + 1  # step\n# <img src=x onerror=\"window.__xss = 1\">\n" && v.kw.includes("def") && v.kw.includes("return") && v.comment === "# step", "C1: a .py artifact is shown in colour (keywords, comment), its text exactly", v);
  ok(!v.ta && v.label === "✎ Edit", "C1: read only (no field), with ✎ Edit", v);
  ok(!v.img && !v.xss, "C1: markup in the file is text, never an element (no <img>, its onerror never runs)", v);
  await P.ev(`(document.querySelector('${HOST} .mode-toggle').click(), true)`);
  await P.until(`!!document.querySelector('${HOST} textarea.code-edit')`);
  const e = await P.ev(`(() => { const h = document.querySelector('${HOST}'), ta = h.querySelector('textarea.code-edit'), hl = h.querySelector('pre.code-hl'), b = h.querySelector('.mode-toggle'), r1 = ta.getBoundingClientRect(), r2 = hl.getBoundingClientRect(), s1 = getComputedStyle(ta), s2 = getComputedStyle(hl);
    return { value: ta.value, focused: document.activeElement === ta, hlKw: [...hl.querySelectorAll('.hk')].map((x) => x.textContent), label: b.textContent, same: r1.left === r2.left && r1.top === r2.top && s1.font === s2.font && s1.paddingLeft === s2.paddingLeft && s1.paddingTop === s2.paddingTop && s1.lineHeight === s2.lineHeight, color: s1.color,
      d: [r1.left, r2.left, r1.top, r2.top, s1.font, s2.font, s1.paddingLeft, s2.paddingLeft, s1.paddingTop, s2.paddingTop, s1.lineHeight, s2.lineHeight] }; })()`);
  ok(e.value === "def f(z):\n    return z * z + 1  # step\n# <img src=x onerror=\"window.__xss = 1\">\n" && e.focused && e.label === "View", "C2: ✎ Edit makes it a field, with its text, focused; the switch says View", e);
  ok(e.hlKw.includes("def") && e.same && e.color === "rgba(0, 0, 0, 0)", "C2: the colours are behind the field's (transparent) text, in the same font, place and padding", e);
  await P.ev(`(() => { const t = document.querySelector('${HOST} textarea.code-edit'); t.setSelectionRange(t.value.length, t.value.length); return true; })()`);
  await P.send("Input.insertText", { text: "while True:\n" });
  await P.until(`document.querySelector('${HOST} .saved')?.textContent === 'Saved' && [...document.querySelectorAll('${HOST} pre.code-hl .hk')].some((x) => x.textContent === 'while')`, 10000).catch(() => {});
  const r = await H.call("workspace.read", { path: "/mandel.py" });
  ok(JSON.stringify(r.result ?? r).includes("while True:"), "C2: typed text is saved to the file", r);
  ok(await P.ev(`[...document.querySelectorAll('${HOST} pre.code-hl .hk')].some((x) => x.textContent === 'while')`), "C2: and coloured as it is typed (the new keyword)");
  await P.ev(`(document.querySelector('${HOST} .mode-toggle').click(), true)`);
  const back = await P.ev(`(() => { const h = document.querySelector('${HOST}'); return { ta: !!h.querySelector('textarea'), text: h.querySelector('pre.code-view')?.textContent ?? null }; })()`);
  ok(!back.ta && back.text?.endsWith("while True:\n"), "C3: View again shows the text as edited, read only", back);
  // (the one remembered is /qa.py's, left in Edit above (S2); /mandel.py, left in View, isn't)
  const modes = await P.ev(`Object.keys(JSON.parse(localStorage.getItem('sagebrush-doc-modes') ?? '{}'))`);
  ok(Array.isArray(modes) && modes.length === 1, "C3: left in View, this file isn't remembered (View is the default); the one left in Edit is", modes);

  // ======================================================================== #1614: Open, at the head's right
  const o = await P.ev(`(() => { const a = document.querySelector('#artifacts .pane-head a.open-full'), head = document.querySelector('#artifacts .pane-head'), tabs = head.querySelector('.tabs'), close = head.querySelector('#close');
    const ra = a.getBoundingClientRect(), rt = tabs.getBoundingClientRect(), rc = close.getBoundingClientRect();
    return { hidden: a.hidden, href: a.getAttribute('href'), target: a.target, rel: a.rel, text: a.textContent, right: ra.left >= rt.right && ra.right <= rc.left, row: Math.abs((ra.top + ra.bottom) / 2 - (rc.top + rc.bottom) / 2) < 3, inBody: !!document.querySelector('${HOST} .file-path a') }; })()`);
  const st = await H.call("workspace.stat", { path: "/mandel.py" }).catch(() => null);
  ok(!o.hidden && /^\/\?code=[0-9a-f]+$/.test(o.href ?? "") && o.target === "_blank" && /noopener/.test(o.rel) && /^Open/.test(o.text), "O1: the head has Open, the code file's own page (/?code=<its id>), in a new tab", { o, st });
  ok(o.right && o.row, "O1: at the head's right, after the tabs, in the row of Copy and Close", o);
  ok(!o.inBody, "O1: the small text link under the head is gone (one way, the head's)", o);
  await P.ev(`([...document.querySelectorAll('#artifacts .pane-head [data-tab]')].find((t) => /qa\.ipynb/.test(t.textContent)).click(), true)`);
  await P.until(`(document.querySelector('#artifacts .pane-head a.open-full:not([hidden])')?.getAttribute('href') ?? '').startsWith('/?nb=')`, 10000).catch(() => {});
  const onb = await P.ev(`document.querySelector('#artifacts .pane-head a.open-full:not([hidden])')?.getAttribute('href') ?? null`);
  ok((onb ?? "").startsWith("/?nb="), "O2: on the notebook's tab, Open is the notebook's page (/?nb=<its id>)", onb);
  const page = await P.ev(`fetch(${"document.querySelector('#artifacts .pane-head a.open-full').getAttribute('href')"}).then((r) => r.status)`);
  ok(page === 200, "O2: that address answers 200", page);
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
