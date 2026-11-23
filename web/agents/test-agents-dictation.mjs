// ci: web-artifacts.1 order=50 runner=bun chrome
// Dictation into the Agents page's composer (#1791), with a stand-in for the browser's SpeechRecognition (no
// microphone, no speech service):
//   - no recognition in the browser: no mic at all;
//   - off until turned on: the first click asks, next to the mic, saying where the voice goes; nothing listens before;
//   - turned on (kept in this browser): a click listens; what is heard collects by the mic, never in the draft; Stop
//     puts it at the draft's end, Discard drops it; sending, another chat, a hidden tab or a failure stop it, its
//     words in the draft they were spoken for; refusals said in the page's words.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-dictation.mjs
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startServe } from "../test-port.mjs";
import { browser } from "./a14-cases.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 800) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
const sitePort = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const site = `http://127.0.0.1:${sitePort}`;
const B = await browser();
// (the stand-in: every recognizer made is kept in window.__recs; the test drives its events)
const FAKE = `(() => {
  window.__recs = [];
  class FakeRecognition {
    constructor() { this.continuous = false; this.interimResults = false; this.lang = ""; this.onresult = null; this.onerror = null; this.onend = null; this.started = false; this.aborted = false; window.__recs.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; setTimeout(() => this.onend?.(), 0); }
    abort() { this.aborted = true; setTimeout(() => this.onend?.(), 0); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  window.__say = (parts) => { const r = window.__recs.at(-1); const results = parts.map(([t, fin]) => Object.assign([{ transcript: t }], { isFinal: fin })); r.onresult?.({ resultIndex: 0, results }); };
})();`;
const NONE = `(() => { try { delete window.SpeechRecognition; } catch {} try { delete window.webkitSpeechRecognition; } catch {} window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; })();`;
const mic = (P) => P.ev(`(() => { const b = document.querySelector('#mic'); const a = document.querySelector('#mic-ask'); const s = document.querySelector('#mic-status'); return b ? { label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), rec: b.classList.contains('rec'), ask: a && !a.hidden ? a.textContent : null, status: s && !s.hidden ? s.textContent : null, recs: window.__recs?.length ?? 0, started: window.__recs?.at(-1)?.started ?? false, aborted: window.__recs?.at(-1)?.aborted ?? false } : null; })()`);
const draftOf = (P) => P.ev(`document.querySelector('#editor textarea')?.value ?? document.querySelector('#editor')?.textContent ?? ''`);
const toast = (P) => P.ev(`document.querySelector('#toast')?.textContent ?? ''`);
const heardNow = (P) => P.ev(`document.querySelector('#mic-status:not([hidden]) .mic-heard')?.textContent ?? null`);
const setDraft = async (P, v) => { await P.draft(""); await P.ev(`(() => { const t = document.querySelector('#editor textarea'); t.value = ${JSON.stringify(v)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); };
const clickMic = (P) => P.ev(`(document.querySelector('#mic').click(), true)`);
const statusBtn = (P, name) => P.ev(`([...document.querySelectorAll('#mic-status button')].find((b) => b.textContent === ${JSON.stringify(name)}).click(), true)`);
try {
  // ---- D1: no recognition in the browser: no mic
  const P0 = await B.tab();
  await P0.send("Page.addScriptToEvaluateOnNewDocument", { source: NONE });
  await P0.navigate(`${site}/agents/?speed=20`);
  ok(!(await P0.ev(`!!document.querySelector('#mic')`)), "D1: where the browser can't turn speech into text, there is no mic");

  const P = await B.tab();
  await P.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE });
  await P.navigate(`${site}/agents/?speed=20`);
  await P.ev(`(localStorage.removeItem('sb-dictation-on-v1'), true)`);
  await P.navigate(`${site}/agents/?speed=20`);
  // (the page settled: its first render puts the keyboard in the composer, after load)
  await sleep(1500);

  // ---- D2: off until turned on: the first click asks, saying where the voice goes; nothing listens
  const m0 = await mic(P);
  // (a real click, as the person's: the mouse moves the focus off the composer)
  const [mx, my] = await P.ev(`(() => { const r = document.querySelector('#mic').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await P.send("Input.dispatchMouseEvent", { type, x: mx, y: my, button: "left", clickCount: 1 });
  await sleep(100);
  const m2 = await mic(P);
  ok(m0?.label === "Dictate" && m0.pressed === "false" && m2.ask && /sends your voice to your browser's speech service \(Google's, in Chrome\)/.test(m2.ask) && m2.recs === 0, "D2: dictation is off until turned on: the first click asks next to the mic, saying where the voice goes, and nothing listens", { m0, m2 });
  ok(await P.ev(`document.activeElement?.textContent === "Turn on"`), "D2: the question has the keyboard, on Turn on", await P.ev(`document.activeElement?.tagName + " " + (document.activeElement?.textContent ?? "").slice(0, 30)`));

  // ---- D3: Not now: the question goes, nothing listens
  await P.ev(`([...document.querySelectorAll('#mic-ask button')].find((b) => b.textContent === 'Not now').click(), true)`);
  const m3 = await mic(P);
  ok(m3.ask === null && m3.recs === 0 && m3.pressed === "false", "D3: Not now puts the question away; nothing listens", m3);

  // ---- D4: Turn on: it listens, and says so with the service, Discard and Turn off
  await setDraft(P, "Plot");
  await clickMic(P);
  await P.ev(`([...document.querySelectorAll('#mic-ask button')].find((b) => b.textContent === 'Turn on').click(), true)`);
  const m4 = await mic(P);
  ok(m4.started && m4.pressed === "true" && m4.rec && /Stop dictating/.test(m4.label) && /Listening \(your browser's speech service\)/.test(m4.status ?? "") && /Discard/.test(m4.status ?? "") && /Turn off/.test(m4.status ?? ""), "D4: Turn on starts listening: the mic is pressed and red, and the line by it names the service, with Discard and Turn off", m4);

  // ---- D5: what is heard collects by the mic, never in the draft, until Stop puts it at the draft's end
  await P.ev(`(window.__say([["a sine", false]]), true)`);
  const h5a = await heardNow(P), d5a = await draftOf(P);
  await P.ev(`(window.__say([["a sine wave", true]]), true)`);
  const h5b = await heardNow(P), d5b = await draftOf(P);
  await clickMic(P);
  await sleep(100);
  const d5c = await draftOf(P), m5 = await mic(P);
  ok(/a sine/.test(h5a ?? "") && d5a.trim() === "Plot" && h5b === "a sine wave" && d5b.trim() === "Plot", "D5: what is heard shows by the mic only, while it listens; the draft stays the person's", { h5a, d5a, h5b, d5b });
  ok(d5c.trim() === "Plot a sine wave" && m5.aborted && m5.pressed === "false" && m5.status === null, "D6: Stop (the mic again) stops listening and puts what was heard at the end of the draft", { d5c, m5 });

  // ---- D7: turned on is kept: after a reload, a click listens at once
  await P.navigate(`${site}/agents/?speed=20`);
  await sleep(1000);
  await clickMic(P);
  const m7 = await mic(P);
  ok(m7.ask === null && m7.started && m7.pressed === "true", "D7: once turned on in this browser, a click listens at once (after a reload too)", m7);

  // ---- D8: a refused microphone, in the page's words; listening ends, the draft as it was
  const d8a = await draftOf(P);
  await P.ev(`(window.__recs.at(-1).onerror({ error: 'not-allowed' }), window.__recs.at(-1).onend(), true)`);
  await sleep(50);
  ok(/The microphone isn't allowed for this page/.test(await toast(P)) && (await mic(P)).pressed === "false" && (await draftOf(P)) === d8a, "D8: a refused microphone is said in the page's words; listening ends; the draft is as it was", await toast(P));

  // ---- D9: sending stops it, and what was heard goes with the message; the message count is the one D12 relies on
  await setDraft(P, "What can you do?");
  await clickMic(P);
  await P.ev(`(window.__say([["tell me", true]]), true)`);
  const users9 = await P.ev(`document.querySelectorAll('#log .user').length`);
  await P.ev(`(document.querySelector('#send').click(), true)`);
  await sleep(200);
  const m9 = await mic(P);
  const sent9 = await P.ev(`[...document.querySelectorAll('#log .user')].at(-1)?.textContent ?? ''`);
  ok(m9.aborted && m9.pressed === "false" && (await P.ev(`document.querySelectorAll('#log .user').length`)) === users9 + 1 && /What can you do\? tell me/.test(sent9), "D9: sending stops listening; the words heard went with the message, which is in the chat", { m9, sent9 });
  await P.until(`document.querySelector('#stop').hidden`, 60000).catch(() => {});

  // ---- D10: Turn off: it stops (what was heard kept in the draft), and the next click asks again
  await setDraft(P, "");
  await clickMic(P);
  await P.ev(`(window.__say([["kept words", true]]), true)`);
  await statusBtn(P, "Turn off");
  await sleep(50);
  const m10a = await mic(P), d10 = await draftOf(P);
  await clickMic(P);
  const m10b = await mic(P);
  ok(m10a.aborted && m10a.pressed === "false" && d10.trim() === "kept words" && m10b.ask !== null && m10b.recs === m10a.recs && (await P.ev(`localStorage.getItem('sb-dictation-on-v1')`)) === null, "D10: Turn off stops listening (what was heard kept in the draft) and turns dictation off: the next click asks again", { m10a, m10b, d10 });
  await P.ev(`([...document.querySelectorAll('#mic-ask button')].find((b) => b.textContent === 'Turn on').click(), true)`); // (on again, listening)

  // ---- D11: Discard drops what was heard; the draft, typed while it listened, stays exactly the person's
  await setDraft(P, "Keep this");
  await P.ev(`(window.__say([["drop this", true]]), true)`);
  // (the person types meanwhile, the same words included)
  await setDraft(P, "Keep this drop this too");
  await statusBtn(P, "Discard");
  await sleep(50);
  ok((await draftOf(P)).trim() === "Keep this drop this too" && (await mic(P)).pressed === "false" && (await heardNow(P)) === null, "D11: Discard stops listening and drops what was heard; what the person typed, the same words included, stays exactly", await draftOf(P));

  // ---- D12: never in the background: a hidden tab stops listening; a failure keeps the draft and sends nothing
  await clickMic(P);
  await P.ev(`(window.__say([["hidden words", true]]), true)`);
  await P.ev(`(Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }), document.dispatchEvent(new Event('visibilitychange')), true)`);
  await sleep(50);
  const m12 = await mic(P);
  await P.ev(`(delete document.visibilityState, true)`);
  ok(m12.aborted && m12.pressed === "false" && /hidden words$/.test((await draftOf(P)).trim()), "D12: when the tab is hidden, listening stops; what was heard is in the draft, not lost", m12);
  const sent12 = await P.ev(`document.querySelectorAll('#log .user').length`);
  const d12 = await draftOf(P);
  await clickMic(P);
  await P.ev(`(window.__recs.at(-1).onerror({ error: 'network' }), window.__recs.at(-1).onend(), true)`);
  await sleep(100);
  ok(/couldn't be reached/.test(await toast(P)) && (await draftOf(P)) === d12 && (await P.ev(`document.querySelectorAll('#log .user').length`)) === sent12, "D12: a network failure is said, keeps the draft, and sends nothing", { toast: await toast(P), draft: await draftOf(P) });

  // (D12's toast put away: it lies over the composer, where the typing helper clicks)
  await P.ev(`(() => { const t = document.querySelector('#toast'); if (t) t.style.display = 'none'; return true; })()`);
  // ---- D13: a failure after words were heard: the typed draft stays, the words heard go after it, nothing is sent
  await setDraft(P, "typed");
  const sent13 = await P.ev(`document.querySelectorAll('#log .user').length`);
  await clickMic(P);
  await P.ev(`(window.__say([["heard words", true]]), true)`);
  await P.ev(`(window.__recs.at(-1).onerror({ error: 'network' }), window.__recs.at(-1).onend(), true)`);
  await sleep(100);
  ok((await draftOf(P)).trim() === "typed heard words" && (await P.ev(`document.querySelectorAll('#log .user').length`)) === sent13, "D13: a failure after words were heard keeps the typed draft, puts the words after it, and sends nothing", await draftOf(P));
  // (late callbacks of a stopped or discarded listening change nothing: no word added twice, none discarded comes back)
  await clickMic(P);
  const old = await P.ev(`window.__recs.length - 1`);
  await P.ev(`(window.__say([["once", true]]), true)`);
  await clickMic(P); // (Stop: "once" added)
  await sleep(50);
  await P.ev(`(window.__recs[${old}].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'late' }], { isFinal: true })] }), window.__recs[${old}].onend(), true)`);
  await clickMic(P);
  const old2 = await P.ev(`window.__recs.length - 1`);
  await P.ev(`(window.__say([["dropped", true]]), true)`);
  await statusBtn(P, "Discard");
  await P.ev(`(window.__recs[${old2}].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'dropped' }], { isFinal: true })] }), window.__recs[${old2}].onend(), true)`);
  await sleep(50);
  const d13 = (await draftOf(P)).trim();
  ok(d13 === "typed heard words once" && (await mic(P)).pressed === "false", "D13: late results after Stop or Discard add nothing: no word twice, nothing discarded comes back", d13);

  // ---- D14: another chat shown: it stops, its words go to the chat they were spoken for, none to the new one
  await setDraft(P, "first chat");
  await clickMic(P);
  await P.ev(`(window.__say([["for the first", true]]), true)`);
  await P.ev(`(document.querySelector('#new').click(), true)`);
  await sleep(400);
  const m14 = await mic(P), newDraft = await draftOf(P);
  await P.ev(`([...document.querySelectorAll('#threads .thread:not(.mirror)')].find((t) => !t.classList.contains('on'))?.click(), true)`);
  await sleep(400);
  const back = await draftOf(P);
  ok(m14.pressed === "false" && !/for the first/.test(newDraft) && back.trim() === "first chat for the first", "D14: another chat shown stops listening; what was heard goes to the chat it was spoken for, none to the new one", { m14, newDraft, back });

  // ---- D15: posting a note stops it too, its words in the note
  await setDraft(P, "a note");
  await clickMic(P);
  await P.ev(`(window.__say([["said", true]]), true)`);
  await P.ev(`(document.querySelector('#note').click(), true)`);
  await sleep(150);
  const m15 = await mic(P);
  ok(m15.aborted && m15.pressed === "false" && /a note said/.test(await P.ev(`[...document.querySelectorAll('#log .user')].at(-1)?.textContent ?? ''`)), "D15: posting a note stops listening, its words heard in the note", m15);
  ok(P.errors.length === 0 && P0.errors.length === 0, "no page errors", [P.errors, P0.errors]);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
