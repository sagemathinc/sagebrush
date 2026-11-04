// ci: web-runner order=21 chrome
// The broker harness's CDP call that gets no answer (web/test-broker-lib.mjs; grader's flake log: runner-broker P1's
// Network.setCookie, no answer within 30 s, twice under load, Nov 4), in headless Chromium: the call still fails,
// naming its method, and its error says what the browser looked like then (the target list, whether the same session
// still answers, whether the browser does, the sessions and the other calls waiting), each step bounded; the harness
// carries on after it.
//   1. the page's own session: a call that never settles, the browser answering;
//   2. an attached session (a worker's), with another call still waiting: the probe asks that same session (the
//      worker's scope answers, not the page's Window), and the counts say one session and one other call;
//   3. the whole browser stopped (SIGSTOP of the Chromium this test started): each probe reports its own deadline,
//      and the whole error comes within cdpMs + 3 × 5 s + margin; then it is resumed.
//   node web/test-broker-lib-diag.mjs
import { browser, sleep } from "./test-broker-lib.mjs";

let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const fails = async (p) => { try { await p; return null; } catch (e) { return String(e?.message ?? e); } };
const CDP_MS = 1500;
const b = await browser({ cdpMs: CDP_MS });
let stopped = false;
try {
  // ---- 1. the page's session
  let t0 = Date.now();
  const err = await fails(b.ev("new Promise(() => {})"));
  let took = Date.now() - t0;
  ok(err !== null && /^CDP Runtime\.evaluate: no answer within 1\.5 s \[/.test(err), `a call with no answer still fails, naming its method: ${String(err).slice(0, 80)}`);
  // (the page among them; a browser may list others too, as Google Chrome lists an extension's background page)
  ok(/targets \(\/json\): \[.*\["page","about:blank"\]/.test(err ?? ""), "…with the target list (the page among them)");
  ok(/the same session, Runtime\.evaluate: answered \(Window\)/.test(err ?? ""), "…whether the same session still answers, and which context did (here the page: Window)");
  ok(/the browser, Browser\.getVersion: answered \(\w*Chrom/.test(err ?? ""), "…whether the browser itself does");
  ok(/; sessions: 0 attached, 0 detached; 0 other calls unanswered\]$/.test(err ?? ""), "…and the sessions and other calls, counted (none)");
  ok(took < CDP_MS + 3000, `…promptly when the browser answers (${took} ms)`);
  ok((await b.ev("1 + 1")) === 2, "the harness carries on after it");
  console.log("  (1: " + String(err).slice(0, 600) + ")");

  // ---- 2. an attached session (a worker's), with another call waiting
  await b.ev("(window.__w = new Worker(URL.createObjectURL(new Blob(['setInterval(() => {}, 1000)'], { type: 'text/javascript' }))), 1)");
  for (let i = 0; i < 100 && ![...b.attached.values()].some((t) => t.type === "worker"); i++) await sleep(100);
  const worker = [...b.attached.values()].find((t) => t.type === "worker");
  ok(!!worker, "(a worker is attached: its own session)");
  // (the worker's call first; the page's, 300 ms later, is still waiting when the worker's deadline comes)
  const wp = fails(b.ev("new Promise(() => {})", worker?.sessionId));
  await sleep(300);
  const other = fails(b.ev("new Promise(() => {})"));
  const werr = await wp;
  await other;
  ok(/^CDP Runtime\.evaluate: no answer within 1\.5 s \[/.test(werr ?? ""), "an attached session's call with no answer fails too");
  ok(/the same session, Runtime\.evaluate: answered \(DedicatedWorkerGlobalScope\)/.test(werr ?? ""), "…and the probe asks that same session: the worker answers, not the page");
  ok(/; sessions: 1 attached, 0 detached; 1 other calls unanswered\]$/.test(werr ?? ""), `…the counts: one session, one other call waiting (${String(werr).slice(-70)})`);

  // ---- 3. the whole browser stopped
  process.kill(b.pid, "SIGSTOP");
  stopped = true;
  t0 = Date.now();
  const serr = await fails(b.ev("1"));
  took = Date.now() - t0;
  process.kill(b.pid, "SIGCONT");
  stopped = false;
  ok(/^CDP Runtime\.evaluate: no answer within 1\.5 s \[/.test(serr ?? ""), "a stopped browser: the call fails, naming its method");
  ok(/targets \(\/json\): (The operation was aborted due to timeout|.*timeout)/i.test(serr ?? ""), "…the target list's own deadline is said");
  ok(/the same session, Runtime\.evaluate: its probe: no answer within 5 s/.test(serr ?? ""), "…the same session's probe: its own deadline");
  ok(/the browser, Browser\.getVersion: its probe: no answer within 5 s/.test(serr ?? ""), "…the browser's probe: its own deadline");
  ok(took < CDP_MS + 15000 + 3000, `…all within cdpMs + 15 s + margin (${took} ms)`);
  console.log("  (3: " + String(serr).slice(0, 600) + ")");
  ok((await b.ev("2 + 2")) === 4, "resumed, the harness carries on");
} catch (e) {
  ok(false, "the test ran: " + String(e?.stack ?? e).slice(0, 400));
} finally {
  if (stopped) try { process.kill(b.pid, "SIGCONT"); } catch {}
  await b.close();
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
