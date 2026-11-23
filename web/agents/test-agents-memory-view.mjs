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
  ok(/kept on this computer, in \/home\/person\//.test(t1) && /sends them nowhere/.test(t1) && /model provider/.test(t1) && /Your own Claude Code, run outside Sagebrush, keeps its own memory/.test(t1) && /Tag names are kept in this browser only/.test(t1), "V1: the view says where the notes are, what reading them does and doesn't do, the native session's own memory, and where tag names live", t1.slice(0, 600));
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

  // ======================================================================== V3: a note, as text
  const openNote = async (note) => {
    await P.ev(`(document.querySelector('#memory-view .memory-note[data-note="${note}"]').click(), true)`);
    await P.until(`!!document.querySelector('#memory-view .memory-open')`, 5000);
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
  const a6 = sent(H, "memory.accept").at(-1);
  ok(a6?.note === nOut.note && a6.revision === 2 && H.memory.notes.get(nOut.note).state === "ok" && !(await P.ev(`!!document.querySelector('#memory-view [data-act=accept]')`)), "V6: Accept is memory.accept at the revision shown; the note is ok again", a6);
  await back();

  // ======================================================================== V7: stale
  await P.until(`!!document.querySelector('#memory-view .memory-note[data-note="${nAlg.note}"]')`, 5000);
  await openNote(nAlg.note);
  Object.assign(H.memory.notes.get(nAlg.note), { body: "Rings are commutative, with 1.", revision: 2 }); // (changed at the agent since it was opened)
  await P.ev(`(document.querySelector('#memory-view [data-act=renew]').click(), true)`).catch(() => {});
  const hasRenew = await P.ev(`!!document.querySelector('#memory-view [data-act=renew]')`);
  // (a note without an expiry has no Renew: Edit instead)
  if (!hasRenew) {
    await P.ev(`(document.querySelector('#memory-view [data-act=edit]').click(), true)`);
    await P.until(`!!document.querySelector('dialog.memory-edit[open]')`, 5000);
    await P.ev(`(() => { const d = document.querySelector('dialog.memory-edit[open]'); d.querySelector('[name=description]').value = 'mine'; [...d.querySelectorAll('button')].find((b) => b.textContent === 'Save').click(); return true; })()`);
  }
  await P.until(`/changed since you opened it/.test(document.querySelector('#toast')?.textContent ?? '')`, 5000).catch(() => {});
  await P.until(`/with 1\\./.test(document.querySelector('#memory-view .memory-open .mem-body')?.textContent ?? '')`, 5000).catch(() => {});
  ok(/changed since you opened it/.test(await toast(P)) && /with 1\./.test(await viewText(P)) && H.memory.notes.get(nAlg.note).description === "rings are commutative", "V7: a stale answer says so and shows the note as it is now; nothing changed at the agent", await toast(P));

  // ======================================================================== V8: a secret
  H.memory.secret = "sk-live-";
  await P.ev(`(document.querySelector('#memory-view [data-act=edit]').click(), true)`);
  await P.until(`!!document.querySelector('dialog.memory-edit[open]')`, 5000);
  await P.ev(`(() => { const d = document.querySelector('dialog.memory-edit[open]'); d.querySelector('[name=body]').value = 'key sk-live-999'; [...d.querySelectorAll('button')].find((b) => b.textContent === 'Save').click(); return true; })()`);
  await P.until(`/looks like it holds a secret/.test(document.querySelector('#toast')?.textContent ?? '')`, 5000).catch(() => {});
  const t8 = await toast(P);
  ok(/looks like it holds a secret/.test(t8) && !t8.includes("sk-live") && (await P.ev(`document.querySelector('dialog.memory-edit[open] [name=body]')?.value`)) === "key sk-live-999", "V8: a secret is refused in the page's words, without echoing it; the dialog keeps the text to fix", t8);
  await P.ev(`([...document.querySelector('dialog.memory-edit[open]').querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click(), true)`);
  H.memory.secret = null;

  // ======================================================================== V9: Delete
  await P.ev(`(document.querySelector('#memory-view [data-act=delete]').click(), true)`);
  await P.until(`!!document.querySelector('dialog.memory-dlg[open]')`, 5000);
  const d9 = await P.ev(`document.querySelector('dialog.memory-dlg[open]').textContent`);
  await P.ev(`(document.querySelector('dialog.memory-dlg[open] button.primary').click(), true)`);
  await P.until(`/Deleted/.test(document.querySelector('#toast')?.textContent ?? '')`, 5000).catch(() => {});
  await P.until(`!document.querySelector('#memory-view .memory-note[data-note="${nAlg.note}"]') && !!document.querySelector('#memory-view .memory-note')`, 5000).catch(() => {});
  const del9 = sent(H, "memory.delete").at(-1);
  ok(/stops reading it at once/.test(d9) && del9?.note === nAlg.note && del9.revision === 2 && !H.memory.notes.has(nAlg.note) && !(await P.ev(`!!document.querySelector('#memory-view .memory-note[data-note="${nAlg.note}"]')`)), "V9: Delete asks first, then sends memory.delete at the revision shown; the note leaves the list", { d9, del9 });

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
  const store12 = await P.ev(`JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])))`);
  ok(!/metres; t is seconds|Proofs first, then code|Plots in grayscale|onerror/.test(store12), "V12: no note's text is kept in this browser's storage");

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
