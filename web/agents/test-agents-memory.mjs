// ci: web-artifacts.1 order=47 runner=bun chrome
// Agent memory v1 on the Agents page (the memory v1 protocol §7, to land in design/workspace-agent-protocol.md; lane C1): a proposed note's card in a
// Pair turn, as the stand-in agent (test-delegate-host.mjs with memory.1, test-memory-host.mjs) sends it.
//   - The card is text: a note's name, place, description and body, never Markdown, so a note can't fetch anything.
//   - A later revision replaces the card; a malformed proposal shows nothing.
//   - Save, Edit… and Dismiss are the page's decisions, naming the card's pending id and revision. An answer changes
//     the card: saved (its text then dropped from the chat), dismissed, or stale. A refusal is said in the page's
//     words: secret, full, forbidden.
//   - "Used notes" under the agent's name lists the notes the turn read.
//   - Memory events never reach the log mirror.
//   - The grant dialog offers the agent's own notes and this browser's tags by name; Allow grants exactly those ids.
//     Without that grant the page refuses Save itself and sends nothing.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-memory.mjs
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
const H = delegateHost({ features: ["delegate.1", "chat.resume", "memory.1"], log: "aaaa1111" });
const B = await browser();
const TAG = "abcdefghijklmnopqrstuvwxya";
const H2 = delegateHost({ features: ["delegate.1", "chat.resume", "memory.1"] });
const H3 = delegateHost({ features: ["delegate.1", "chat.resume", "memory.1"], log: "aaaa1111" });
// (Connect, then Allow: with memory ticked (own notes and the tag), or not)
async function pair(P, host, memory) {
  await P.navigate(`${site}/agents/?pair=123-456&port=${host.port}`);
  await P.ev(`(localStorage.setItem('sb-memory-tags-v1', JSON.stringify([{ id: ${JSON.stringify(TAG)}, name: 'algebra' }, { id: 'NOT-A-TAG', name: 'bad' }])), true)`);
  await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Connect')`, 30000);
  await P.ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Connect').click()`);
  await P.until(`[...document.querySelectorAll('.sbag-box h2')].some((h) => h.textContent === 'Allow this agent?')`, 30000);
  const offered = await P.ev(`(() => { const m = [...document.querySelectorAll('.sbag-box')].at(-1).querySelector('.memory'); return m ? { text: m.textContent, tags: [...m.querySelectorAll('input[data-tag]')].map((i) => i.dataset.tag) } : null; })()`);
  if (memory) await P.ev(`(() => { const d = [...document.querySelectorAll('.sbag-box')].at(-1); const own = d.querySelector('input[name=memory-own]'); own.click(); d.querySelector('input[data-tag=${TAG}]').click(); return true; })()`);
  await P.ev(`(() => { const d = [...document.querySelectorAll('.sbag-box')].at(-1); d.querySelector('button.primary').click(); return true; })()`);
  await P.until(`document.querySelector('#connect').textContent === 'Connected'`);
  return offered;
}
try {
  const P = await B.tab();
  const offered = await pair(P, H, true);
  ok(offered?.tags?.length === 1 && offered.tags[0] === TAG && /algebra/.test(offered.text), "M0: the grant dialog offers own notes and this browser's tags by name (a malformed kept tag is dropped)", offered);
  for (const t = Date.now(); !H.grant?.memory && Date.now() - t < 5000; ) await sleep(50);
  ok(JSON.stringify(H.grant?.memory) === JSON.stringify({ tags: [TAG] }) && !!H.pageFeatures?.includes("memory.1"), "M0: Allow grants own notes and exactly that tag, and the page says memory.1", { memory: H.grant?.memory, features: H.pageFeatures });
  await P.draft("remember my notation");
  await P.ev(`(document.querySelector('#send').click(), true)`);
  for (const t = Date.now(); !H.got.some((m) => m.method === "chat.message") && Date.now() - t < 10000; ) await sleep(50);
  const conversation = H.got.find((m) => m.method === "chat.message")?.params?.conversation;
  ok(!!conversation, "the person's message reached the agent");
  const turn = "t-mem";
  const send = (event) => H.turnEvent(conversation, turn, event);
  send({ type: "turn_started" });
  const CARD = `[data-memory]`;
  const card = (sel = CARD) => P.ev(`(() => { const c = [...document.querySelectorAll(${JSON.stringify(sel)})].at(-1); return c ? { text: c.textContent, html: c.innerHTML, imgs: c.querySelectorAll('img').length, links: c.querySelectorAll('a').length, buttons: [...c.querySelectorAll('button')].map((b) => b.textContent), state: c.querySelector('.mem-state')?.textContent ?? null, body: c.querySelector('.mem-body')?.textContent ?? null, n: document.querySelectorAll(${JSON.stringify(sel)}).length } : null; })()`);

  // ======================================================================== M1: the card is text
  const hostile = "x is metres.\n![pixel](http://127.0.0.1:9/pixel.png) <img src=x onerror=\"window.__mem=1\"> [link](http://example.com)";
  const pr = H.memory.propose(send, { name: "notation", description: "x is distance, in metres", body: hostile });
  await P.until(`!!document.querySelector('[data-memory]')`, 10000);
  const c1 = await card();
  ok(c1.text.includes("Remember this?") && c1.text.includes("notation") && c1.text.includes("x is distance, in metres") && c1.body === hostile, "M1: the card shows the note's name, description and its body as written", c1);
  ok(c1.imgs === 0 && c1.links === 0 && !(await P.ev(`!!window.__mem`)), "M1: the body is text: no image, no link, nothing run", c1);
  ok(c1.text.includes("this agent's own notes") && /expires \d{4}-\d\d-\d\d/.test(c1.text), "M1: it says where the note goes and when it expires", c1.text);
  ok(JSON.stringify(c1.buttons) === JSON.stringify(["Save", "Edit…", "Dismiss"]), "M1: Save, Edit… and Dismiss", c1.buttons);

  // ======================================================================== M2: a revision replaces the card
  H.memory.revise(send, pr.pending, { body: "x is metres (revised)." });
  await P.until(`document.querySelector('[data-memory] .mem-body')?.textContent === 'x is metres (revised).'`, 10000);
  ok((await card()).n === 1, "M2: a later revision replaces the card, still one card");

  // ======================================================================== M9: Used notes
  const seen = H.memory.add({ name: "units", description: "SI units throughout", body: "SI." });
  H.memory.used(send, [seen]);
  await P.until(`/Used notes: units/.test(document.querySelector('.who-used')?.textContent ?? '')`, 10000).catch(() => {});
  ok(/^Used notes: units$/.test((await P.ev(`document.querySelector('.who-used')?.textContent ?? ''`)) ?? ""), "M9: the notes the turn read are listed under the agent's name");

  // ======================================================================== M10: a malformed proposal shows nothing
  const before = (await card()).n;
  send({ type: "memory_proposal", pending: "f".repeat(32), revision: 1, op: "new", scope: { tag: "NOT-A-TAG" }, name: "bad", description: "d", body: "b", expires: null });
  send({ type: "memory_proposal", pending: "e".repeat(32), revision: 1, op: "new", scope: "own", name: "bad", description: "d", body: "b", expires: null, extra: 1 });
  send({ type: "memory_proposal", pending: "d".repeat(32), revision: 1, op: "new", scope: "own", name: "far", description: "d", body: "b", expires: Number.MAX_SAFE_INTEGER });
  await sleep(600);
  ok((await card()).n === before, "M10: a proposal that isn't as §7.4 has it (a bad tag, an unknown field, an expiry past year 9999) shows no card", (await card()).n);
  ok(P.errors.length === 0, "M10: and the chat still draws", P.errors);

  // ======================================================================== M3: Save
  await P.ev(`([...document.querySelectorAll('[data-memory] button')].find((b) => b.textContent === 'Save').click(), true)`);
  await sleep(800);
  const saveSent = H.got.filter((m) => m.method === "memory.save");
  {
    await P.until(`/Saved to your notes/.test(document.querySelector('[data-memory] .mem-state')?.textContent ?? '')`, 10000).catch(() => {});
    const m3 = saveSent.at(-1)?.params;
    const c3 = await card();
    ok(m3?.pending === pr.pending && m3?.revision === 2 && /^[0-9a-f]{32}$/.test(m3?.decision_id ?? ""), "M3: Save sends memory.save with the card's pending id, its current revision and a decision id", m3);
    ok(/Saved to your notes/.test(c3.state ?? "") && c3.body === null, "M3: the card says Saved, and its text leaves the chat", c3);
    const stored = await P.ev(`localStorage.getItem('sagebrush-agents-preview-v1') ?? ''`);
    ok(!stored.includes("x is metres (revised)"), "M3: the kept chat (localStorage) holds no saved note's text");
    ok([...H.memory.notes.values()].some((n) => n.body === "x is metres (revised)."), "M3: the agent saved exactly the shown text");
    // ======================================================================== M4: Dismiss
    const pr4 = H.memory.propose(send, { name: "draft", description: "a passing thought", body: "maybe" });
    await P.until(`document.querySelectorAll('[data-memory]').length >= 2`, 10000);
    await P.ev(`([...document.querySelectorAll('[data-memory]')].at(-1).querySelector('[data-mem=dismiss]').click(), true)`);
    await P.until(`/Not saved/.test([...document.querySelectorAll('[data-memory]')].at(-1).querySelector('.mem-state')?.textContent ?? '')`, 10000).catch(() => {});
    ok(!H.memory.pending.has(pr4.pending) && ![...H.memory.notes.values()].some((n) => n.name === "draft"), "M4: Dismiss saves nothing, and the proposal is gone");
    const c4 = await card();
    ok(c4.state === "Not saved" && c4.body === null, "M4: the card says Not saved, and its text leaves the chat", c4);
    // ======================================================================== M5: Edit…
    H.memory.propose(send, { name: "style", description: "proof style", body: "Explain proofs first." });
    await P.until(`document.querySelectorAll('[data-memory]').length >= 3`, 10000);
    await P.ev(`([...document.querySelectorAll('[data-memory]')].at(-1).querySelector('[data-mem=edit]').click(), true)`);
    await P.until(`!!document.querySelector('dialog.memory-edit[open]')`, 5000);
    await P.ev(`(() => { const d = document.querySelector('dialog.memory-edit[open]'); d.querySelector('[name=body]').value = 'Explain proofs before code.'; d.querySelector('[name=scope]').value = 'tag:${TAG}'; [...d.querySelectorAll('button')].find((b) => b.textContent === 'Save').click(); return true; })()`);
    await P.until(`/Saved to your notes/.test([...document.querySelectorAll('[data-memory]')].at(-1).querySelector('.mem-state')?.textContent ?? '')`, 10000).catch(() => {});
    const n5 = [...H.memory.notes.values()].find((n) => n.name === "style");
    ok(n5?.body === "Explain proofs before code." && n5?.scopeKey === "tag:" + TAG, "M5: Edit… saves the person's text, in the place they chose", n5);
    // ======================================================================== M6: stale
    const pr6 = H.memory.propose(send, { name: "stale-one", description: "d", body: "b" });
    await P.until(`document.querySelectorAll('[data-memory]').length >= 4`, 10000);
    H.memory.pending.get(pr6.pending).revision = 9; // (moved on at the agent, the page not told)
    await P.ev(`([...document.querySelectorAll('[data-memory]')].at(-1).querySelector('[data-mem=save]').click(), true)`);
    await P.until(`/changed/.test([...document.querySelectorAll('[data-memory]')].at(-1).querySelector('.mem-state')?.textContent ?? '')`, 10000).catch(() => {});
    ok(/Not saved: it changed/.test((await card()).state ?? ""), "M6: a card the agent moved past is stale, and says so", (await card()).state);
    // ======================================================================== M7: secret, then Edit… saves
    const lastCard = `[...document.querySelectorAll('[data-memory]')].at(-1)`;
    const clickLast = (what) => P.ev(`(${lastCard}.querySelector('[data-mem=${what}]').click(), true)`);
    const toastText = () => P.ev(`document.querySelector('#toast')?.textContent ?? ''`);
    H.memory.secret = "sk-live-";
    H.memory.propose(send, { name: "key", description: "an api key", body: "use sk-live-123456 here" });
    await P.until(`document.querySelectorAll('[data-memory]').length >= 5`, 10000);
    await clickLast("save");
    await P.until(`/looks like it holds a secret/.test(document.querySelector('#toast')?.textContent ?? '')`, 10000).catch(() => {});
    const t7 = await toastText();
    ok(/looks like it holds a secret/.test(t7) && !t7.includes("sk-live") && (await card()).buttons.includes("Save"), "M7: a secret is refused in the page's words, without echoing it; the card stays open", t7);
    const id7 = H.got.filter((m) => m.method === "memory.save").at(-1)?.params?.decision_id;
    await clickLast("edit");
    await P.until(`!!document.querySelector('dialog.memory-edit[open]')`, 5000);
    await P.ev(`(() => { const d = document.querySelector('dialog.memory-edit[open]'); d.querySelector('[name=body]').value = 'use the key from the keychain'; [...d.querySelectorAll('button')].find((b) => b.textContent === 'Save').click(); return true; })()`);
    await P.until(`/Saved to your notes/.test(${lastCard}.querySelector('.mem-state')?.textContent ?? '')`, 10000).catch(() => {});
    const m7 = H.got.filter((m) => m.method === "memory.save").at(-1)?.params;
    ok([...H.memory.notes.values()].some((n) => n.name === "key" && n.body === "use the key from the keychain") && m7?.decision_id !== id7, "M7: after a refusal, Edit… without the secret saves, under a new decision id", m7);
    H.memory.secret = null;
    // ======================================================================== M8: full, then the same Save once there is room
    H.memory.propose(send, { name: "big", description: "a long one", body: "a lot of text" });
    await P.until(`document.querySelectorAll('[data-memory]').length >= 6`, 10000);
    H.memory.full = true;
    await clickLast("save");
    await P.until(`/Your notes are full/.test(document.querySelector('#toast')?.textContent ?? '')`, 10000).catch(() => {});
    ok(/Your notes are full/.test(await toastText()) && (await card()).buttons.includes("Save"), "M8: a full store is said so, and the card stays open");
    const id8 = H.got.filter((m) => m.method === "memory.save").at(-1)?.params?.decision_id;
    H.memory.full = false;
    await clickLast("save");
    await P.until(`/Saved to your notes/.test(${lastCard}.querySelector('.mem-state')?.textContent ?? '')`, 10000).catch(() => {});
    const id8b = H.got.filter((m) => m.method === "memory.save").at(-1)?.params?.decision_id;
    ok([...H.memory.notes.values()].some((n) => n.name === "big") && id8b !== id8, "M8: once there is room, Save again saves (a new decision id: the agent keeps each id's answer)", { id8, id8b });
    // ======================================================================== M11: the agent's own end of a card
    const pr11 = H.memory.propose(send, { name: "elsewhere", description: "decided elsewhere", body: "ELSEWHERE-TEXT" });
    await P.until(`document.querySelectorAll('[data-memory]').length >= 7`, 10000);
    H.memory.pending.delete(pr11.pending);
    send({ type: "memory_decided", pending: pr11.pending, outcome: "dismissed" });
    await P.until(`/Not saved/.test(${lastCard}.querySelector('.mem-state')?.textContent ?? '')`, 10000).catch(() => {});
    const c11 = await card();
    ok(c11.state === "Not saved" && c11.body === null && !c11.buttons.length, "M11: memory_decided from the agent ends the card, and its text leaves the chat", c11);
    // ======================================================================== M15: a revision while Edit… is open
    const pr15 = H.memory.propose(send, { name: "moving", description: "revised under the dialog", body: "first" });
    await P.until(`document.querySelectorAll('[data-memory]').length >= 8`, 10000);
    await clickLast("edit");
    await P.until(`!!document.querySelector('dialog.memory-edit[open]')`, 5000);
    H.memory.revise(send, pr15.pending, { body: "second" });
    await P.until(`${lastCard}.querySelector('.mem-body')?.textContent === 'second'`, 10000).catch(() => {});
    const sent15 = H.got.filter((m) => m.method === "memory.save").length;
    await P.ev(`(() => { const d = document.querySelector('dialog.memory-edit[open]'); d.querySelector('[name=body]').value = 'mine'; [...d.querySelectorAll('button')].find((b) => b.textContent === 'Save').click(); return true; })()`);
    await sleep(500);
    const c15 = await card();
    ok(H.got.filter((m) => m.method === "memory.save").length === sent15 && c15.body === "second" && c15.buttons.includes("Save") && /changed this note while you were looking/.test(await toastText()) && (await P.ev(`!!document.querySelector('dialog.memory-edit[open]')`)), "M15: Save in Edit… after the agent revised the note sends nothing; the card shows the new text, still open, and the dialog stays", c15);
    await P.ev(`([...document.querySelector('dialog.memory-edit[open]').querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click(), true)`);
    await clickLast("dismiss");
    await P.until(`/Not saved/.test(${lastCard}.querySelector('.mem-state')?.textContent ?? '')`, 10000).catch(() => {});
    // ======================================================================== M16: a revision while Save is on its way
    const pr16 = H.memory.propose(send, { name: "racing", description: "revised in flight", body: "one" });
    await P.until(`document.querySelectorAll('[data-memory]').length >= 9`, 10000);
    H.hold.add("memory.save");
    await clickLast("save");
    for (const t = Date.now(); !H.held.length && Date.now() - t < 5000; ) await sleep(50);
    const held16 = H.held.map((m) => m.params);
    ok(held16.length === 1 && held16[0].pending === pr16.pending && held16[0].revision === 1, "M16: Save went, naming revision 1", held16);
    H.memory.revise(send, pr16.pending, { body: "two" });
    await P.until(`${lastCard}.querySelector('.mem-body')?.textContent === 'two'`, 10000).catch(() => {});
    H.hold.delete("memory.save");
    H.release(); // (the agent answers stale: it was for revision 1)
    await sleep(500);
    const c16 = await card();
    ok(c16.body === "two" && c16.buttons.includes("Save") && c16.state === null, "M16: a stale answer for the revision Save named leaves the newer revision's card open, with its text", c16);
    // ======================================================================== M17: an answer the page can't read
    H.hold.add("memory.save");
    await clickLast("save");
    for (const t = Date.now(); !H.held.length && Date.now() - t < 5000; ) await sleep(50);
    const m17 = H.held.splice(0)[0];
    H.answer(m17.id, { note: "not-a-note-id", extra: true });
    await P.until(`/couldn't be read/.test(document.querySelector('#toast')?.textContent ?? '')`, 5000).catch(() => {});
    const t17 = await toastText();
    const c17 = await card();
    await clickLast("save");
    for (const t = Date.now(); !H.held.length && Date.now() - t < 5000; ) await sleep(50);
    const again = H.held[0]?.params;
    H.hold.delete("memory.save");
    H.release();
    await P.until(`/Saved to your notes/.test(${lastCard}.querySelector('.mem-state')?.textContent ?? '')`, 10000).catch(() => {});
    ok(/couldn't be read/.test(t17) && c17.buttons.includes("Save") && again?.decision_id === m17.params.decision_id && /Saved to your notes/.test((await card()).state ?? ""), "M17: an unreadable answer is said so, the card stays open, and Save again sends the same decision id", { t17, again: again?.decision_id, first: m17.params.decision_id });
    // ======================================================================== M18: the agent's end while Save is on its way
    const pr18 = H.memory.propose(send, { name: "ended", description: "ended in flight", body: "x" });
    await P.until(`document.querySelectorAll('[data-memory]').length >= 10`, 10000);
    H.hold.add("memory.save");
    await clickLast("save");
    for (const t = Date.now(); !H.held.length && Date.now() - t < 5000; ) await sleep(50);
    const m18 = H.held.splice(0)[0];
    H.hold.delete("memory.save");
    H.memory.pending.delete(pr18.pending);
    send({ type: "memory_decided", pending: pr18.pending, outcome: "dismissed" });
    await P.until(`/Not saved/.test(${lastCard}.querySelector('.mem-state')?.textContent ?? '')`, 10000).catch(() => {});
    H.refuse(m18.id, "not_found");
    await sleep(400);
    const c18 = await card();
    ok(!!m18 && c18.state === "Not saved" && !c18.buttons.length, "M18: the agent's end of a card stands when Save's answer comes after it", c18);
    // ======================================================================== M20: a tag this browser hasn't named
    const keptTags = await P.ev(`localStorage.getItem('sb-memory-tags-v1')`);
    await P.ev(`(localStorage.setItem('sb-memory-tags-v1', '[]'), true)`);
    H.memory.propose(send, { name: "unnamed", description: "to a tag named elsewhere", body: "u", scope: { tag: TAG } });
    await P.until(`document.querySelectorAll('[data-memory]').length >= 11`, 10000);
    const where20 = await P.ev(`${lastCard}.querySelector('.mem-where')?.textContent ?? ''`);
    await clickLast("edit");
    await P.until(`!!document.querySelector('dialog.memory-edit[open]')`, 5000);
    const opts20 = await P.ev(`[...document.querySelector('dialog.memory-edit[open] [name=scope]').options].map((o) => o.textContent)`);
    await P.ev(`([...document.querySelector('dialog.memory-edit[open]').querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click(), true)`);
    ok(where20.includes(`In the tag ${TAG} ·`) && opts20.includes(`Tag ${TAG}`), "M20: a tag this browser hasn't named is shown by its whole id, on the card and in Edit…", { where20, opts20 });
    await P.ev(`(localStorage.setItem('sb-memory-tags-v1', ${JSON.stringify(keptTags ?? "[]")}), true)`);
    await clickLast("dismiss");
    await P.until(`/Not saved/.test(${lastCard}.querySelector('.mem-state')?.textContent ?? '')`, 10000).catch(() => {});
    // ======================================================================== M13: no note's text is kept in this browser
    H.memory.propose(send, { name: "later", description: "left open", body: "LATER-TEXT" });
    await P.until(`document.querySelectorAll('[data-memory]').length >= 12`, 10000);
    await sleep(700); // (the chat is kept 300 ms after a change)
    const kept = await P.ev(`localStorage.getItem('sagebrush-agents-preview-v1') ?? ''`);
    ok(kept.includes("left open") && !/LATER-TEXT|ELSEWHERE-TEXT|keychain|a lot of text|Explain proofs/.test(kept), "M13: the kept chat has the cards but none of their text, an open card's included");
  }
  send({ type: "turn_finished", outcome: "completed" });
  ok(P.errors.length === 0, "no page errors", P.errors);
  // (the first chat kept with its turn finished, so that in the next tab only the card's agent keeps it from a decision)
  await P.until(`(() => { try { const v = JSON.parse(localStorage.getItem('sagebrush-agents-preview-v1')); return v.threads.some((t) => t.entries.some((e) => e.turn_id === 't-mem' && e.state !== 'running' && e.finished)); } catch { return false; } })()`, 10000);

  // ======================================================================== M12: no memory in the grant
  // (another agent, allowed without memory: its proposal still shows, but Save is refused by the page itself, in its
  //  words, and nothing is sent; the stand-in's own grant holds memory, so only the page's gate stands between)
  const P2 = await B.tab();
  await pair(P2, H2, false);
  for (const t = Date.now(); !H2.pageFeatures && Date.now() - t < 5000; ) await sleep(50);
  ok(H2.grant?.memory === undefined, "M12: Allow without the memory choice grants no memory", H2.grant);
  // (a chat of its own: this tab opens on the first agent's, kept)
  await P2.ev(`(document.querySelector('#new').click(), true)`);
  await sleep(300);
  await P2.draft("hello");
  await P2.ev(`(document.querySelector('#send').click(), true)`);
  for (const t = Date.now(); !H2.got.some((m) => m.method === "chat.message") && Date.now() - t < 10000; ) await sleep(50);
  const conv2 = H2.got.find((m) => m.method === "chat.message")?.params?.conversation;
  H2.grant = { ...(H2.grant ?? {}), memory: { tags: [] } };
  const send2 = (event) => H2.turnEvent(conv2, "t-mem2", event);
  send2({ type: "turn_started" });
  H2.memory.propose(send2, { name: "nope", description: "d", body: "b" });
  // (this tab shares the kept chat with the first: its card is the one named "nope")
  const nope = `[...document.querySelectorAll('[data-memory]')].find((c) => /nope/.test(c.textContent))`;
  await P2.until(`!!${nope}`, 10000);
  await P2.ev(`([...${nope}.querySelectorAll('button')].find((b) => b.textContent === 'Save').click(), true)`);
  await P2.until(`/Memory isn't turned on for this agent/.test(document.querySelector('#toast')?.textContent ?? '')`, 5000).catch(() => {});
  const t12 = await P2.ev(`document.querySelector('#toast')?.textContent ?? ''`);
  ok(!H2.got.some((m) => m.method === "memory.save") && /Memory isn't turned on for this agent/.test(t12), "M12: with no memory grant on the page's side, Save sends nothing and says so", t12);
  send2({ type: "turn_finished", outcome: "completed" });
  // (M13/M14: this tab reads the kept chat: the first agent's open card is there without its text, and takes no
  //  decision here, where another agent is connected)
  const later = await P2.ev(`(async () => { for (const el of document.querySelectorAll('#threads .thread:not(.mirror)')) { el.click(); await new Promise((r) => setTimeout(r, 150)); const c = [...document.querySelectorAll('[data-memory]')].find((x) => /left open/.test(x.textContent)); if (c) return { body: c.querySelector('.mem-body')?.textContent ?? null, buttons: [...c.querySelectorAll('button')].map((b) => b.textContent), text: c.textContent, away: /connection to the agent was lost|Interrupted/.test(c.closest('.turn')?.textContent ?? '') }; } return null; })()`);
  ok(later && later.body === null && !/LATER-TEXT/.test(later.text) && later.buttons.length === 0 && !later.away, "M14: another tab shows the first agent's open card without its text, and with no decision while another agent is connected", later);

  // ======================================================================== M19: another connection to the same run
  // (an agent whose hello names the first one's run, as a reconnect or a reload does: its open card (without its text,
  //  as kept) takes Dismiss only, and that goes to the agent connected now)
  const P3 = await B.tab();
  await pair(P3, H3, true);
  const later3 = `[...document.querySelectorAll('[data-memory]')].find((x) => /left open/.test(x.textContent))`;
  await P3.ev(`(async () => { for (const el of document.querySelectorAll('#threads .thread:not(.mirror)')) { el.click(); await new Promise((r) => setTimeout(r, 150)); if (${later3}) return true; } return false; })()`);
  const c19 = await P3.ev(`(() => { const c = ${later3}; return c ? { buttons: [...c.querySelectorAll('button')].map((b) => b.textContent), body: c.querySelector('.mem-body')?.textContent ?? null } : null; })()`);
  ok(c19 && c19.body === null && JSON.stringify(c19.buttons) === '["Dismiss"]', "M19: over another connection to the same run, the open card offers Dismiss only", c19);
  await P3.ev(`(${later3}.querySelector('[data-mem=dismiss]').click(), true)`);
  for (const t = Date.now(); !H3.got.some((m) => m.method === "memory.dismiss") && Date.now() - t < 5000; ) await sleep(50);
  await P3.until(`/Not saved/.test(${later3}?.querySelector('.mem-state')?.textContent ?? '')`, 5000).catch(() => {});
  ok(H3.got.some((m) => m.method === "memory.dismiss") && !H3.got.some((m) => m.method === "memory.save") && /Not saved/.test(await P3.ev(`${later3}?.querySelector('.mem-state')?.textContent ?? ''`)), "M19: its Dismiss goes to the agent connected now (which no longer has it), and the card ends");
  ok(P3.errors.length === 0, "no page errors (third tab)", P3.errors);
  ok(P2.errors.length === 0, "no page errors (second agent)", P2.errors);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  H.stop();
  H2.stop();
  H3.stop();
  server.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
