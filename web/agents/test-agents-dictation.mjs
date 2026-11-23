// ci: web-artifacts.1 order=50 runner=bun chrome
// Dictation into the Agents page's composer (#1791), with a stand-in for the browser's SpeechRecognition (no
// microphone, no speech service):
//   - no recognition in the browser: no mic at all;
//   - off until turned on: the first click asks, next to the mic, saying where the voice goes; nothing listens before;
//   - turned on (kept in this browser): a click listens; what is heard is added after what was typed, the part still
//     being recognized only in the status line; a click, sending, or Turn off stops it; refusals said in the page's
//     words.
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

  // ---- D2: off until turned on: the first click asks, saying where the voice goes; nothing listens
  const m0 = await mic(P);
  await P.ev(`(document.querySelector('#mic').click(), true)`);
  const m2 = await mic(P);
  ok(m0?.label === "Dictate" && m0.pressed === "false" && m2.ask && /sends your voice to your browser's speech service \(Google's, in Chrome\)/.test(m2.ask) && m2.recs === 0, "D2: dictation is off until turned on: the first click asks next to the mic, saying where the voice goes, and nothing listens", { m0, m2 });
  await sleep(50);
  ok(await P.ev(`document.activeElement?.textContent === "Turn on"`), "D2: the question has the keyboard, on Turn on", await P.ev(`document.activeElement?.tagName + " " + document.activeElement?.textContent?.slice(0, 30)`));

  // ---- D3: Not now: the question goes, nothing listens
  await P.ev(`([...document.querySelectorAll('#mic-ask button')].find((b) => b.textContent === 'Not now').click(), true)`);
  const m3 = await mic(P);
  ok(m3.ask === null && m3.recs === 0 && m3.pressed === "false", "D3: Not now puts the question away; nothing listens", m3);

  // ---- D4: Turn on: it listens, and says so with the service and Turn off
  await P.draft("Plot");
  await P.ev(`(document.querySelector('#mic').click(), true)`);
  await P.ev(`([...document.querySelectorAll('#mic-ask button')].find((b) => b.textContent === 'Turn on').click(), true)`);
  const m4 = await mic(P);
  ok(m4.started && m4.pressed === "true" && m4.rec && m4.label === "Stop dictating" && /Listening \(your browser's speech service\)/.test(m4.status ?? "") && /Turn off/.test(m4.status ?? ""), "D4: Turn on starts listening: the mic is pressed and red, and the status line names the service, with Turn off", m4);

  // ---- D5: what is heard goes after what was typed; the part still being recognized only in the status line
  await P.ev(`(window.__say([["a sine", false]]), true)`);
  const d5a = await draftOf(P), s5a = (await mic(P)).status;
  await P.ev(`(window.__say([["a sine wave", true]]), true)`);
  await sleep(100);
  const d5b = await draftOf(P);
  ok(d5a.trim() === "Plot" && /a sine/.test(s5a ?? "") && d5b.trim() === "Plot a sine wave", "D5: words still being recognized show in the status line only; once recognized they are added after what was typed", { d5a, s5a, d5b });

  // ---- D6: a click stops it
  await P.ev(`(document.querySelector('#mic').click(), true)`);
  await sleep(50);
  const m6 = await mic(P);
  ok(m6.aborted && m6.pressed === "false" && !m6.rec && m6.status === null && (await draftOf(P)).trim() === "Plot a sine wave", "D6: a second click stops listening; the draft stays", m6);

  // ---- D7: turned on is kept: after a reload, a click listens at once
  await P.navigate(`${site}/agents/?speed=20`);
  await P.ev(`(document.querySelector('#mic').click(), true)`);
  const m7 = await mic(P);
  ok(m7.ask === null && m7.started && m7.pressed === "true", "D7: once turned on in this browser, a click listens at once (after a reload too)", m7);

  // ---- D8: a refused microphone, in the page's words
  await P.ev(`(window.__recs.at(-1).onerror({ error: 'not-allowed' }), window.__recs.at(-1).onend(), true)`);
  await sleep(50);
  ok(/The microphone isn't allowed for this page/.test(await toast(P)) && (await mic(P)).pressed === "false", "D8: a refused microphone is said in the page's words, and listening ends", await toast(P));

  // ---- D9: sending stops it
  await P.draft("What can you do?");
  await P.ev(`(document.querySelector('#mic').click(), true)`);
  const n9 = await P.ev(`window.__recs.length`);
  await P.ev(`(document.querySelector('#send').click(), true)`);
  await sleep(100);
  const m9 = await mic(P);
  ok(m9.recs === n9 && m9.aborted && m9.pressed === "false", "D9: sending the message stops listening", m9);

  // ---- D10: Turn off: it stops, and the next click asks again
  await P.until(`document.querySelector('#stop').hidden`, 60000).catch(() => {});
  await P.ev(`(document.querySelector('#mic').click(), true)`);
  await P.ev(`([...document.querySelectorAll('#mic-status button')].find((b) => b.textContent === 'Turn off').click(), true)`);
  await sleep(50);
  const m10a = await mic(P);
  const n10 = m10a.recs;
  await P.ev(`(document.querySelector('#mic').click(), true)`);
  const m10b = await mic(P);
  ok(m10a.aborted && m10a.pressed === "false" && m10b.ask !== null && m10b.recs === n10 && (await P.ev(`localStorage.getItem('sb-dictation-on-v1')`)) === null, "D10: Turn off stops listening and turns dictation off: the next click asks again", { m10a, m10b });

  // ---- D11: Discard: listening stops, and what was dictated is dropped (the draft as it was before)
  await P.ev(`(document.querySelector('#mic').click(), true)`);
  await P.ev(`([...document.querySelectorAll('#mic-ask button')].find((b) => b.textContent === 'Turn on').click(), true)`);
  await P.draft("Keep this");
  await P.ev(`(document.querySelector('#mic').click(), document.querySelector('#mic').click(), true)`); // (stop, then listen again from "Keep this")
  await P.ev(`(window.__say([["drop this", true]]), true)`);
  await sleep(100);
  const d11a = await draftOf(P);
  await P.ev(`([...document.querySelectorAll('#mic-status button')].find((b) => b.textContent === 'Discard').click(), true)`);
  await sleep(100);
  const d11b = await draftOf(P);
  ok(d11a.trim() === "Keep this drop this" && d11b.trim() === "Keep this" && (await mic(P)).pressed === "false", "D11: Discard stops listening and drops what was dictated; the typed draft stays", { d11a, d11b });

  // ---- D12: never in the background: a hidden tab stops listening; a recognition failure keeps the draft and sends nothing
  await P.ev(`(document.querySelector('#mic').click(), true)`);
  await P.ev(`(Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }), document.dispatchEvent(new Event('visibilitychange')), true)`);
  await sleep(50);
  const m12 = await mic(P);
  await P.ev(`(delete document.visibilityState, true)`);
  ok(m12.aborted && m12.pressed === "false", "D12: when the tab is hidden, listening stops", m12);
  const sent12 = await P.ev(`document.querySelectorAll('#log .user').length`);
  await P.ev(`(document.querySelector('#mic').click(), true)`);
  await P.ev(`(window.__recs.at(-1).onerror({ error: 'network' }), window.__recs.at(-1).onend(), true)`);
  await sleep(100);
  ok(/couldn't be reached/.test(await toast(P)) && (await draftOf(P)).trim() === "Keep this" && (await P.ev(`document.querySelectorAll('#log .user').length`)) === sent12, "D12: a network failure is said, keeps the draft, and sends nothing", { toast: await toast(P), draft: await draftOf(P) });
  ok(P.errors.length === 0 && P0.errors.length === 0, "no page errors", [P.errors, P0.errors]);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
