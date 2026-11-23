// ci: web-artifacts.1 order=48 runner=bun chrome
// The Memory view on the Agents page (agent memory v1, the memory v1 protocol §7.3; lane C2), against the stand-in
// agent (test-delegate-host.mjs with memory.1, test-memory-host.mjs):
//   - Memory… opens the notes the agent may use in place of the chat: where they're kept, their use of the room (with
//     warnings at 80% and 90%), what reading them does and doesn't do, and each note's place, size, expiry and source.
//   - Search and the place filter are the agent's (memory.list's query and scope); the text is shown as text only.
//   - Edit (only what changed), Renew, Accept (a note changed outside Sagebrush) and Delete are decisions with ids;
//     stale and secret answers are said in the page's words.
//   - A tag this browser hasn't named shows its id, with Name this tag.
//   - Another tab says "Memory is open in your other tab"; a lost connection, and an agent without memory granted, say
//     so; no note's text is kept by the page.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-memory-view.mjs
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
const TAG = "abcdefghijklmnopqrstuvwxya", TAG2 = "bbbbbbbbbbbbbbbbbbbbbbbbbe";
const H = delegateHost({ features: ["delegate.1", "chat.resume", "memory.1"], log: "dddd4444" });
const H2 = delegateHost({ features: ["delegate.1", "chat.resume", "memory.1"] });
const B = await browser();

// (Connect, then Allow: with memory ticked (own notes and every tag offered), or not)
async function pair(P, host, memory) {
  await P.navigate(`${site}/agents/?pair=123-456&port=${host.port}`);
  // (both tags named here, so the dialog offers them; the second's name is dropped once granted, as a browser that
  //  hasn't named it would show it)
  await P.ev(`(localStorage.setItem('sb-memory-tags-v1', JSON.stringify([{ id: ${JSON.stringify(TAG)}, name: 'algebra' }, { id: ${JSON.stringify(TAG2)}, name: 'second' }])), true)`);
  await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Connect')`, 30000);
  await P.ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Connect').click()`);
  await P.until(`[...document.querySelectorAll('.sbag-box h2')].some((h) => h.textContent === 'Allow this agent?')`, 30000);
  if (memory) await P.ev(`(() => { const d = [...document.querySelectorAll('.sbag-box')].at(-1); d.querySelector('input[name=memory-own]').click(); for (const i of d.querySelectorAll('input[data-tag]')) i.click(); return true; })()`);
  await P.ev(`(() => { const d = [...document.querySelectorAll('.sbag-box')].at(-1); d.querySelector('button.primary').click(); return true; })()`);
  await P.until(`document.querySelector('#connect').textContent === 'Connected'`);
  await P.ev(`(localStorage.setItem('sb-memory-tags-v1', JSON.stringify([{ id: ${JSON.stringify(TAG)}, name: 'algebra' }])), true)`);
}
const viewText = (P) => P.ev(`document.querySelector('#memory-view')?.textContent ?? ''`);
const rows = (P) => P.ev(`[...document.querySelectorAll('#memory-view .memory-note')].map((b) => ({ note: b.dataset.note, name: b.querySelector('.n').textContent, meta: b.querySelector('small').textContent }))`);
const toast = (P) => P.ev(`document.querySelector('#toast')?.textContent ?? ''`);
const sent = (host, method) => host.got.filter((m) => m.method === method).map((m) => m.params);

try {
  const P = await B.tab();
  await pair(P, H, true);
  // (the grant holds both tags: the page sends them ascending, so the second (unnamed here) is in it too)
  for (const t = Date.now(); !H.grant?.memory && Date.now() - t < 5000; ) await sleep(50);
  ok(JSON.stringify(H.grant?.memory?.tags) === JSON.stringify([TAG, TAG2]), "V0: the grant holds own notes and both tags", H.grant?.memory);
  // the agent's notes: one own, one in each tag, one changed outside Sagebrush, one hostile
  const nOwn = H.memory.add({ name: "notation", description: "x is distance, in metres", body: "x is metres.", expires: Date.now() + 30 * 86400000 });
  const nAlg = H.memory.add({ scope: { tag: TAG }, name: "rings", description: "rings are commutative", body: "All rings here are commutative." });
  H.memory.add({ scope: { tag: TAG2 }, name: "plots", description: "plot style", body: "Plots in grayscale." });
  const nOut = H.memory.add({ name: "style", description: "proof style", body: "Proofs first." });
  H.memory.outside(nOut.note, "Proofs first, then code.");
  const nBad = H.memory.add({ name: "hostile", description: "a hostile body", body: "<img src=x onerror=\"window.__mv=1\"> [link](http://example.com)" });

  // ======================================================================== V1: the view
  await P.until(`!document.querySelector('#memory-btn')?.hidden`, 10000);
  await P.ev(`(document.querySelector('#memory-btn').click(), true)`);
  await P.until(`document.querySelectorAll('#memory-view .memory-note').length >= 5`, 10000);
  const t1 = await viewText(P);
  const r1 = await rows(P);
  ok(/kept on this computer, in \/home\/person\//.test(t1) && /sends them nowhere/.test(t1) && /model provider/.test(t1) && /connect your own Claude Code instead \(a native session\), it doesn't use these notes: it keeps its own memory/.test(t1) && /Tag names are kept in this browser only/.test(t1), "V1: the view says where the notes are, what reading them does and doesn't do, the native session's own memory, and where tag names live", t1.slice(0, 600));
  ok(/ of 10\.0 MB used/.test(t1), "V1: and their use of the room", t1.slice(0, 600));
  ok(r1.length === 5 && r1.some((r) => r.name === "rings" && /Tag algebra/.test(r.meta)) && r1.some((r) => r.name === "plots" && r.meta.includes(`Tag ${TAG2}`)) && r1.some((r) => r.name === "notation" && /This agent's own notes/.test(r.meta) && /expires \d{4}-\d\d-\d\d/.test(r.meta) && /Proposed by Claude Code/.test(r.meta)) && r1.some((r) => r.name === "style" && /Changed outside Sagebrush/.test(r.meta)), "V1: each note with its place (a tag by this browser's name, or by its id), size, expiry, state and source", r1);
  ok(await P.ev(`document.body.classList.contains('memory-shown') && getComputedStyle(document.querySelector('#log')).display === 'none'`), "V1: the view takes the chat's place");

  // ======================================================================== V2: search and place
  await P.ev(`(() => { const s = document.querySelector('#memory-view input[name=memory-search]'); s.value = 'commutative'; s.dispatchEvent(new Event('input')); return true; })()`);
  await P.until(`document.querySelectorAll('#memory-view .memory-note').length === 1`, 5000).catch(() => {});
  const q2 = sent(H, "memory.list").at(-1);
  ok(q2?.query === "commutative" && (await rows(P)).map((r) => r.name).join() === "rings", "V2: search is the agent's (memory.list's query), and lists what matches", { q2, rows: await rows(P) });
  await P.ev(`(() => { const s = document.querySelector('#memory-view input[name=memory-search]'); s.value = ''; s.dispatchEvent(new Event('input')); return true; })()`);
  await P.until(`document.querySelectorAll('#memory-view .memory-note').length === 5`, 5000).catch(() => {});
  await P.ev(`(() => { const s = document.querySelector('#memory-view select[name=memory-scope]'); s.value = 'tag:${TAG2}'; s.dispatchEvent(new Event('change')); return true; })()`);
  await P.until(`document.querySelectorAll('#memory-view .memory-note').length === 1`, 5000).catch(() => {});
  const q2b = sent(H, "memory.list").at(-1);
  ok(q2b?.scope?.tag === TAG2 && (await rows(P)).map((r) => r.name).join() === "plots", "V2: the place filter is memory.list's scope", { q2b, rows: await rows(P) });
  await P.ev(`(() => { const s = document.querySelector('#memory-view select[name=memory-scope]'); s.value = 'all'; s.dispatchEvent(new Event('change')); return true; })()`);
  await P.until(`document.querySelectorAll('#memory-view .memory-note').length === 5`, 5000).catch(() => {});

  // ======================================================================== V2b: typing while a listing is out
  // (keys typed one at a time; the listing for the first few is held, then answered: the box keeps its focus and all
  //  that was typed, and the last listing is for all of it)
  await P.ev(`(document.querySelector('#memory-view input[name=memory-search]').focus(), true)`);
  H.hold.add("memory.list");
  for (const c of "comm") { await P.send("Input.insertText", { text: c }); await sleep(30); }
  await sleep(400);
  for (const c of "utative") { await P.send("Input.insertText", { text: c }); await sleep(30); }
  H.hold.delete("memory.list");
  H.release();
  await sleep(600);
  const s2b = await P.ev(`(() => { const s = document.querySelector('#memory-view input[name=memory-search]'); return { value: s.value, focused: document.activeElement === s }; })()`);
  await P.until(`document.querySelectorAll('#memory-view .memory-note').length === 1`, 5000).catch(() => {});
  ok(s2b.value === "commutative" && s2b.focused && sent(H, "memory.list").at(-1)?.query === "commutative" && (await rows(P)).map((r) => r.name).join() === "rings", "V2: typing while a listing is out keeps the box's focus and every key; the last listing is for all of it", { s2b, last: sent(H, "memory.list").at(-1) });
  await P.ev(`(() => { const s = document.querySelector('#memory-view input[name=memory-search]'); s.value = ''; s.dispatchEvent(new Event('input')); return true; })()`);
  await P.until(`document.querySelectorAll('#memory-view .memory-note').length === 5`, 5000).catch(() => {});

  // ======================================================================== V3: a note, as text
  const openNote = async (note) => {
    await P.ev(`(document.querySelector('#memory-view .memory-note[data-note="${note}"]').click(), true)`);
    await P.until(`document.querySelector('#memory-view .memory-open:not([hidden])')?.dataset.note === ${JSON.stringify(note)}`, 5000);
  };
  await openNote(nBad.note);
  const o3 = await P.ev(`(() => { const o = document.querySelector('#memory-view .memory-open'); return { body: o.querySelector('.mem-body').textContent, imgs: o.querySelectorAll('img').length, links: o.querySelectorAll('a').length }; })()`);
  await sleep(300);
  ok(o3.body.includes("<img src=x") && o3.imgs === 0 && o3.links === 0 && !(await P.ev(`!!window.__mv`)), "V3: a note's text is text: no image, no link, nothing run", o3);
  ok(sent(H, "memory.get").at(-1)?.note === nBad.note, "V3: opened with memory.get");
  const back = () => P.ev(`([...document.querySelectorAll('#memory-view .memory-open button')].find((b) => b.textContent === '← All notes').click(), true)`);
  await back();
  await P.until(`document.querySelectorAll('#memory-view .memory-note').length === 5`, 5000);

  // ======================================================================== V4: Edit sends only what changed
  await openNote(nOwn.note);
  await P.ev(`(document.querySelector('#memory-view [data-act=edit]').click(), true)`);
  await P.until(`!!document.querySelector('dialog.memory-edit[open]')`, 5000);
  await P.ev(`(() => { const d = document.querySelector('dialog.memory-edit[open]'); d.querySelector('[name=body]').value = 'x is metres; t is seconds.'; [...d.querySelectorAll('button')].find((b) => b.textContent === 'Save').click(); return true; })()`);
  await P.until(`/t is seconds/.test(document.querySelector('#memory-view .memory-open .mem-body')?.textContent ?? '')`, 5000).catch(() => {});
  const e4 = sent(H, "memory.edit").at(-1);
  ok(e4 && e4.note === nOwn.note && e4.revision === 1 && e4.body === "x is metres; t is seconds." && !("name" in e4) && !("description" in e4) && !("scope" in e4) && /^[0-9a-f]{32}$/.test(e4.decision_id), "V4: Edit sends memory.edit with the revision shown, a decision id, and only the text that changed", e4);
  ok(H.memory.notes.get(nOwn.note).body === "x is metres; t is seconds." && /t is seconds/.test(await viewText(P)), "V4: the agent has it, and the view shows the note as it is now");

  // ======================================================================== V5: Renew
  const before5 = H.memory.notes.get(nOwn.note).expires;
  await P.ev(`(document.querySelector('#memory-view [data-act=renew]').click(), true)`);
  await P.until(`/Renewed/.test(document.querySelector('#toast')?.textContent ?? '')`, 5000).catch(() => {});
  const e5 = sent(H, "memory.edit").at(-1);
  const in90 = e5 && Math.abs(e5.expires - (Date.now() + 90 * 86400000)) < 60000;
  ok(in90 && e5.revision === 2 && Object.keys(e5).sort().join() === "decision_id,expires,note,revision" && H.memory.notes.get(nOwn.note).expires > before5, "V5: Renew is memory.edit with an expiry 90 days from now, and nothing else", e5);
  await back();

  // ======================================================================== V6: Accept a note changed outside Sagebrush
  await P.until(`!!document.querySelector('#memory-view .memory-note[data-note="${nOut.note}"]')`, 5000);
  await openNote(nOut.note);
  const t6 = await viewText(P);
  ok(/changed outside Sagebrush, so the agent doesn't read it until you accept it/.test(t6) && /Proofs first, then code\./.test(t6), "V6: a note changed outside Sagebrush says so, with its text as it is now", t6.slice(0, 400));
  await P.ev(`(document.querySelector('#memory-view [data-act=accept]').click(), true)`);
  await P.until(`/Accepted/.test(document.querySelector('#toast')?.textContent ?? '')`, 5000).catch(() => {});
  await P.until(`!document.querySelector('#memory-view [data-act=accept]')`, 5000).catch(() => {});
  const a6 = sent(H, "memory.accept").at(-1);
  ok(a6?.note === nOut.note && a6.revision === 2 && H.memory.notes.get(nOut.note).state === "ok" && !(await P.ev(`!!document.querySelector('#memory-view [data-act=accept]')`)), "V6: Accept is memory.accept at the revision shown; the note is ok again", a6);
  await back();

  // ======================================================================== V7: stale
  await P.until(`!!document.querySelector('#memory-view .memory-note[data-note="${nAlg.note}"]')`, 5000);
  await openNote(nAlg.note);
  Object.assign(H.memory.notes.get(nAlg.note), { body: "Rings are commutative, with 1.", revision: 2 }); // (changed at the agent since it was opened)
  // (a note without an expiry: no Renew; Edit)
  ok(!(await P.ev(`!!document.querySelector('#memory-view [data-act=renew]')`)), "V7: a note that never expires has no Renew");
  await P.ev(`(document.querySelector('#memory-view [data-act=edit]').click(), true)`);
  await P.until(`!!document.querySelector('dialog.memory-edit[open]')`, 5000);
  await P.ev(`(() => { const d = document.querySelector('dialog.memory-edit[open]'); d.querySelector('[name=description]').value = 'mine'; [...d.querySelectorAll('button')].find((b) => b.textContent === 'Save').click(); return true; })()`);

  await P.until(`/changed while you were editing it/.test(document.querySelector('dialog.memory-edit[open] .msg')?.textContent ?? '')`, 5000).catch(() => {});
  const v7 = await P.ev(`(() => { const d = document.querySelector('dialog.memory-edit[open]'); return d ? { msg: d.querySelector('.msg').textContent, description: d.querySelector('[name=description]').value } : null; })()`);
  ok(/changed while you were editing it/.test(v7?.msg ?? "") && v7.description === "mine" && /with 1\./.test(await P.ev(`document.querySelector('#memory-view .memory-open .mem-body')?.textContent ?? ''`)) && H.memory.notes.get(nAlg.note).description === "rings are commutative", "V7: a stale answer keeps the dialog and the person's text, says so, and shows the note behind it as it is now; nothing changed at the agent", v7);
  // (Save again: now at the note's new revision)
  await P.ev(`([...document.querySelector('dialog.memory-edit[open]').querySelectorAll('button')].find((b) => b.textContent === 'Save').click(), true)`);
  await P.until(`!document.querySelector('dialog.memory-edit[open]')`, 5000).catch(() => {});
  const e7 = sent(H, "memory.edit").at(-1);
  ok(H.memory.notes.get(nAlg.note).description === "mine" && e7?.revision === 2 && !("body" in e7) && /with 1\./.test(H.memory.notes.get(nAlg.note).body), "V7: Save again goes at the note's new revision with only the person's change: the agent's new text stays", { e7, body: H.memory.notes.get(nAlg.note).body });

  // ======================================================================== V8: a secret
  H.memory.secret = "sk-live-";
  await P.ev(`(document.querySelector('#memory-view [data-act=edit]').click(), true)`);
  await P.until(`!!document.querySelector('dialog.memory-edit[open]')`, 5000);
  await P.ev(`(() => { const d = document.querySelector('dialog.memory-edit[open]'); d.querySelector('[name=body]').value = 'key sk-live-999'; [...d.querySelectorAll('button')].find((b) => b.textContent === 'Save').click(); return true; })()`);
  await P.until(`/looks like it holds a secret/.test(document.querySelector('#toast')?.textContent ?? '')`, 5000).catch(() => {});
  const t8 = await toast(P);
  ok(await P.ev(`!!document.querySelector('#memory-view [data-act=delete]:not([disabled])')`), "V8: after the refusal, with the dialog still open, the note's buttons are free again");
  ok(/looks like it holds a secret/.test(t8) && !t8.includes("sk-live") && (await P.ev(`document.querySelector('dialog.memory-edit[open] [name=body]')?.value`)) === "key sk-live-999", "V8: a secret is refused in the page's words, without echoing it; the dialog keeps the text to fix", t8);
  // (an answer that can't be read: the dialog stays, says so, and Save again is a new request)
  H.memory.secret = null;
  H.hold.add("memory.edit");
  await P.ev(`(() => { const d = document.querySelector('dialog.memory-edit[open]'); d.querySelector('[name=body]').value = 'Rings are commutative, with 1, always.'; [...d.querySelectorAll('button')].find((b) => b.textContent === 'Save').click(); return true; })()`);
  for (const t = Date.now(); !H.held.length && Date.now() - t < 5000; ) await sleep(50);
  const m8 = H.held.splice(0)[0];
  H.answer(m8.id, { note: "x" });
  await P.until(`/couldn't be read/.test(document.querySelector('dialog.memory-edit[open] .msg')?.textContent ?? '')`, 5000).catch(() => {});
  const msg8 = await P.ev(`document.querySelector('dialog.memory-edit[open] .msg')?.textContent ?? ''`);
  H.hold.delete("memory.edit");
  await P.ev(`([...document.querySelector('dialog.memory-edit[open]').querySelectorAll('button')].find((b) => b.textContent === 'Save').click(), true)`);
  await P.until(`!document.querySelector('dialog.memory-edit[open]')`, 5000).catch(() => {});
  const e8 = sent(H, "memory.edit").at(-1);
  ok(/the note behind this is shown as it is now, and Save again sends only what still differs/.test(msg8) && e8.decision_id !== m8.params.decision_id && H.memory.notes.get(nAlg.note).body === "Rings are commutative, with 1, always.", "V8: an Edit answer that can't be read keeps the dialog and says so; Save again is a new request, and saves", { msg8, first: m8.params.decision_id, again: e8.decision_id });
  // (while a Save is out, Cancel and Escape wait; and an unreadable answer to an Edit that did go through: Save again
  //  finds nothing left to send, and closes)
  await P.until(`document.querySelector('#memory-view .memory-open:not([hidden])')?.dataset.note === ${JSON.stringify(nAlg.note)}`, 5000);
  await P.ev(`(document.querySelector('#memory-view [data-act=edit]').click(), true)`);
  await P.until(`!!document.querySelector('dialog.memory-edit[open]')`, 5000);
  H.hold.add("memory.edit");
  await P.ev(`(() => { const d = document.querySelector('dialog.memory-edit[open]'); d.querySelector('[name=body]').value = 'Went through.'; [...d.querySelectorAll('button')].find((b) => b.textContent === 'Save').click(); return true; })()`);
  for (const t = Date.now(); !H.held.length && Date.now() - t < 5000; ) await sleep(50);
  const cancelOff = await P.ev(`[...document.querySelector('dialog.memory-edit[open]').querySelectorAll('button')].find((b) => b.textContent === 'Cancel').disabled`);
  await P.ev(`(document.querySelector('dialog.memory-edit[open]').dispatchEvent(new Event('cancel', { cancelable: true })), true)`);
  await sleep(200);
  ok(cancelOff && await P.ev(`!!document.querySelector('dialog.memory-edit[open]')`), "V8: while a Save is out, Cancel is off and Escape waits for its answer");
  const m8b = H.held.splice(0)[0];
  H.hold.delete("memory.edit");
  const nb = H.memory.notes.get(nAlg.note);
  Object.assign(nb, { body: "Went through.", revision: nb.revision + 1 }); // (the agent did apply it)
  H.answer(m8b.id, { note: "x" });
  await P.until(`/couldn't be read/.test(document.querySelector('dialog.memory-edit[open] .msg')?.textContent ?? '')`, 5000).catch(() => {});
  const edits8 = sent(H, "memory.edit").length;
  await P.ev(`([...document.querySelector('dialog.memory-edit[open]').querySelectorAll('button')].find((b) => b.textContent === 'Save').click(), true)`);
  await P.until(`!document.querySelector('dialog.memory-edit[open]')`, 5000).catch(() => {});
  ok(sent(H, "memory.edit").length === edits8 && !(await P.ev(`!!document.querySelector('dialog.memory-edit[open]')`)), "V8: an unreadable answer to an Edit that went through: Save again has nothing left to send, and closes");
  // (the dialog closed anyway while a Save was out (a browser may let a second Escape through): its refusal is still
  //  said, and the note's buttons are free again)
  await P.until(`document.querySelector('#memory-view .memory-open:not([hidden])')?.dataset.note === ${JSON.stringify(nAlg.note)}`, 5000);
  await P.ev(`(document.querySelector('#memory-view [data-act=edit]').click(), true)`);
  await P.until(`!!document.querySelector('dialog.memory-edit[open]')`, 5000);
  H.hold.add("memory.edit");
  await P.ev(`(() => { const d = document.querySelector('dialog.memory-edit[open]'); d.querySelector('[name=name]').value = 'plots'; [...d.querySelectorAll('button')].find((b) => b.textContent === 'Save').click(); return true; })()`);
  for (const t = Date.now(); !H.held.length && Date.now() - t < 5000; ) await sleep(50);
  await P.ev(`(document.querySelector('dialog.memory-edit[open]').close(), true)`);
  const busy8 = await P.ev(`!!document.querySelector('#memory-view [data-act=delete][disabled]')`);
  const m8c = H.held.splice(0)[0];
  H.hold.delete("memory.edit");
  H.refuse(m8c.id, "conflict");
  await P.until(`/already there/.test(document.querySelector('#toast')?.textContent ?? '')`, 5000).catch(() => {});
  const said8 = await toast(P);
  // (free again: Delete asks its question, not "wait")
  await P.until(`!!document.querySelector('#memory-view [data-act=delete]:not([disabled])')`, 5000).catch(() => {});
  await P.ev(`(document.querySelector('#memory-view [data-act=delete]').click(), true)`);
  const asked8 = await P.until(`!!document.querySelector('dialog.memory-dlg[open]')`, 3000).then(() => true, () => false);
  if (asked8) await P.ev(`([...document.querySelector('dialog.memory-dlg[open]').querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click(), true)`);
  ok(busy8 && /already there/.test(said8) && asked8, "V8: a dialog closed while its Save was out: the note waits until the answer, the refusal is still said, and the note is free again", { busy8, said8, asked8 });

  // ======================================================================== V9: Delete
  // (first its answer can't be read: the id is kept, and Delete again sends the very same request)
  H.hold.add("memory.delete");
  await P.ev(`(document.querySelector('#memory-view [data-act=delete]').click(), true)`);
  await P.until(`!!document.querySelector('dialog.memory-dlg[open]')`, 5000);
  const d9 = await P.ev(`document.querySelector('dialog.memory-dlg[open]').textContent`);
  await P.ev(`(document.querySelector('dialog.memory-dlg[open] button.primary').click(), true)`);
  for (const t = Date.now(); !H.held.length && Date.now() - t < 5000; ) await sleep(50);
  ok(await P.ev(`[...document.querySelectorAll('#memory-view .memory-actions button')].every((b) => b.disabled)`), "V9: while a change is out, the note's buttons wait");
  const m9 = H.held.splice(0)[0];
  H.answer(m9.id, { deleted: "yes" });
  await P.until(`/couldn't be read/.test(document.querySelector('#toast')?.textContent ?? '')`, 5000).catch(() => {});
  ok(/couldn't be read/.test(await toast(P)) && H.memory.notes.has(nAlg.note), "V9: an answer that can't be read is said so", await toast(P));
  H.hold.delete("memory.delete");
  await P.until(`!!document.querySelector('#memory-view [data-act=delete]:not([disabled])')`, 5000);
  await P.ev(`(document.querySelector('#memory-view [data-act=delete]').click(), true)`);
  await P.until(`!!document.querySelector('dialog.memory-dlg[open]')`, 5000);
  await P.ev(`(document.querySelector('dialog.memory-dlg[open] button.primary').click(), true)`);
  await P.until(`/Deleted/.test(document.querySelector('#toast')?.textContent ?? '')`, 5000).catch(() => {});
  await P.until(`!document.querySelector('#memory-view .memory-note[data-note="${nAlg.note}"]') && !!document.querySelector('#memory-view .memory-note')`, 5000).catch(() => {});
  const del9 = sent(H, "memory.delete").at(-1);
  ok(del9?.decision_id === m9.params.decision_id, "V9: Delete again after the unreadable answer sends the same decision id", { first: m9.params.decision_id, again: del9?.decision_id });
  ok(/stops reading it at once/.test(d9) && del9?.note === nAlg.note && del9.revision === 5 && !H.memory.notes.has(nAlg.note) && !(await P.ev(`!!document.querySelector('#memory-view .memory-note[data-note="${nAlg.note}"]')`)), "V9: Delete asks first, then sends memory.delete at the revision shown; the note leaves the list", { d9, del9 });

  // ======================================================================== V16: an answer after the person moved on
  // (Renew the first note, go to another before its answer: the answer is said, and the person stays where they went)
  await P.until(`!!document.querySelector('#memory-view .memory-note[data-note="${nOwn.note}"]')`, 5000);
  await openNote(nOwn.note);
  H.hold.add("memory.edit");
  await P.ev(`(document.querySelector('#memory-view [data-act=renew]').click(), true)`);
  for (const t = Date.now(); !H.held.length && Date.now() - t < 5000; ) await sleep(50);
  await back();
  await P.until(`!!document.querySelector('#memory-view .memory-note[data-note="${nOut.note}"]')`, 5000);
  await openNote(nOut.note);
  H.hold.delete("memory.edit");
  H.release();
  await P.until(`/Renewed/.test(document.querySelector('#toast')?.textContent ?? '')`, 5000).catch(() => {});
  await sleep(400);
  ok(/Renewed/.test(await toast(P)) && (await P.ev(`document.querySelector('#memory-view .memory-open:not([hidden])')?.dataset.note`)) === nOut.note, "V16: a change's answer after the person moved to another note is said, and they stay on that note", await P.ev(`document.querySelector('#memory-view .memory-open:not([hidden])')?.dataset.note`));
  // (and back on the same note before the answer: it's shown as it is now, its buttons free)
  await back();
  await P.until(`!!document.querySelector('#memory-view .memory-note[data-note="${nOwn.note}"]')`, 5000);
  await openNote(nOwn.note);
  H.hold.add("memory.edit");
  await P.ev(`(document.querySelector('#memory-view [data-act=renew]').click(), true)`);
  for (const t = Date.now(); !H.held.length && Date.now() - t < 5000; ) await sleep(50);
  await back();
  await P.until(`!!document.querySelector('#memory-view .memory-note[data-note="${nOut.note}"]')`, 5000);
  await openNote(nOut.note);
  await back();
  await P.until(`!!document.querySelector('#memory-view .memory-note[data-note="${nOwn.note}"]')`, 5000);
  await openNote(nOwn.note);
  const rev16 = H.memory.notes.get(nOwn.note).revision;
  H.hold.delete("memory.edit");
  H.release();
  await P.until(`!!document.querySelector('#memory-view [data-act=renew]:not([disabled])')`, 5000).catch(() => {});
  await sleep(300);
  await P.ev(`(document.querySelector('#memory-view [data-act=renew]').click(), true)`);
  for (const t = Date.now(); sent(H, "memory.edit").at(-1)?.revision !== rev16 + 1 && Date.now() - t < 5000; ) await sleep(50);
  ok(sent(H, "memory.edit").at(-1)?.revision === rev16 + 1, "V16: back on the same note before its answer: shown again as it is now, its buttons free (the next Renew goes at the new revision)", { last: sent(H, "memory.edit").at(-1), rev16 });
  await back();
  await P.until(`document.querySelectorAll('#memory-view .memory-note').length >= 3`, 5000).catch(() => {});

  // ======================================================================== V10: Name this tag
  const tagRow = `document.querySelector('#memory-view .memory-tag[data-tag="${TAG2}"]')`;
  const t10 = await P.ev(`${tagRow}?.textContent ?? ''`);
  await P.ev(`([...${tagRow}.querySelectorAll('button')].find((b) => b.textContent === 'Name this tag').click(), true)`);
  await P.until(`!!document.querySelector('dialog.memory-dlg[open]')`, 5000);
  await P.ev(`(() => { const d = document.querySelector('dialog.memory-dlg[open]'); d.querySelector('input').value = 'own'; [...d.querySelectorAll('button')].find((b) => b.textContent === 'Save').click(); return true; })()`);
  const bad10 = await P.ev(`document.querySelector('dialog.memory-dlg[open] .msg')?.textContent ?? ''`);
  await P.ev(`(() => { const d = document.querySelector('dialog.memory-dlg[open]'); d.querySelector('input').value = 'figures'; [...d.querySelectorAll('button')].find((b) => b.textContent === 'Save').click(); return true; })()`);
  await P.until(`/Tag figures/.test(${tagRow}?.textContent ?? '')`, 5000).catch(() => {});
  const kept10 = JSON.parse(await P.ev(`localStorage.getItem('sb-memory-tags-v1')`));
  ok(t10.includes(`Tag ${TAG2}`) && /Name this tag/.test(t10) && /can't be used/.test(bad10) && /Tag figures/.test(await P.ev(`${tagRow}?.textContent ?? ''`)) && kept10.some((t) => t.id === TAG2 && t.name === "figures"), "V10: a tag this browser hasn't named shows its id and Name this tag; a reserved name is refused; the name is kept in this browser", { t10, bad10, kept10 });
  ok(sent(H, "memory.edit").every((e) => !JSON.stringify(e).includes("figures")) && !JSON.stringify(H.got).includes("figures"), "V10: a tag's name never goes to the agent");

  // ======================================================================== V11: the room's warnings
  H.memory.usageBytes = Math.round(0.85 * 10 * 1024 * 1024);
  await P.ev(`(() => { const s = document.querySelector('#memory-view input[name=memory-search]'); s.value = 'x'; s.dispatchEvent(new Event('input')); return true; })()`);
  await P.until(`/over 80%/.test(document.querySelector('#memory-view .memory-usage')?.textContent ?? '')`, 5000).catch(() => {});
  const w80 = await P.ev(`document.querySelector('#memory-view .memory-usage')?.textContent ?? ''`);
  H.memory.usageBytes = Math.round(0.95 * 10 * 1024 * 1024);
  await P.ev(`(() => { const s = document.querySelector('#memory-view input[name=memory-search]'); s.value = ''; s.dispatchEvent(new Event('input')); return true; })()`);
  await P.until(`/over 90%/.test(document.querySelector('#memory-view .memory-usage')?.textContent ?? '')`, 5000).catch(() => {});
  const w90 = await P.ev(`document.querySelector('#memory-view .memory-usage')?.textContent ?? ''`);
  ok(/over 80%/.test(w80) && /over 90%/.test(w90), "V11: the room's use warns at 80% and at 90%", { w80, w90 });
  H.memory.usageBytes = undefined;

  // ======================================================================== V12: nothing of a note kept by the page
  await sleep(500);
  const store12 = await P.ev(`JSON.stringify([localStorage, sessionStorage].map((st) => Object.fromEntries(Object.keys(st).map((k) => [k, st.getItem(k)]))))`);
  ok(!/metres; t is seconds|Proofs first, then code|Plots in grayscale|onerror/.test(store12), "V12: no note's text is kept in this browser's storage (local or session)");

  // ======================================================================== V13: another tab
  const P2 = await B.tab();
  await P2.navigate(`${site}/agents/`);
  await P2.until(`!document.querySelector('#memory-btn')?.hidden`, 10000).catch(() => {});
  await P2.ev(`(document.querySelector('#memory-btn')?.click(), true)`);
  await P2.until(`/Memory is open in your other tab/.test(document.querySelector('#memory-view')?.textContent ?? '')`, 5000).catch(() => {});
  const t13 = await P2.ev(`document.querySelector('#memory-view')?.textContent ?? ''`);
  ok(/Memory is open in your other tab/.test(t13) && !document_has_notes(t13), "V13: another tab of this browser says Memory is open in the other tab, and shows no notes", t13.slice(0, 300));
  ok(P2.errors.length === 0, "no page errors (second tab)", P2.errors);

  // ======================================================================== V14: a lost connection
  H.sock.close();
  await P.until(`/isn't connected/.test(document.querySelector('#memory-view')?.textContent ?? '')`, 10000).catch(() => {});
  const t14 = await viewText(P);
  await P2.until(`!/Memory is open in your other tab/.test(document.querySelector('#memory-view')?.textContent ?? '')`, 5000).catch(() => {});
  ok(!/Memory is open in your other tab/.test(await P2.ev(`document.querySelector('#memory-view')?.textContent ?? ''`)), "V14: the other tab no longer says Memory is open there once it's gone", await P2.ev(`document.querySelector('#memory-view')?.textContent ?? ''`));
  ok(/Memory isn't available: .* isn't connected/.test(t14) && !(await P.ev(`!!document.querySelector('#memory-view .memory-note')`)), "V14: a lost connection says Memory isn't available, and the notes go", t14.slice(0, 300));
  ok(P.errors.length === 0, "no page errors", P.errors);

  // ======================================================================== V15: memory not granted
  const P3 = await B.tab();
  await pair(P3, H2, false);
  await P3.until(`!document.querySelector('#memory-btn')?.hidden`, 10000).catch(() => {});
  await P3.ev(`(document.querySelector('#memory-btn')?.click(), true)`);
  await P3.until(`/isn't turned on for this agent/.test(document.querySelector('#memory-view')?.textContent ?? '')`, 5000).catch(() => {});
  ok(/Memory isn't turned on for this agent/.test(await P3.ev(`document.querySelector('#memory-view')?.textContent ?? ''`)) && !H2.got.some((m) => m.method?.startsWith("memory.")), "V15: an agent connected without memory: the view says it isn't turned on, and asks the agent nothing");
  ok(P3.errors.length === 0, "no page errors (third tab)", P3.errors);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  H.stop();
  H2.stop();
  server.kill();
}
function document_has_notes(text) { return /Proposed by|notation|commutative/.test(text); }
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
