// ci: web-runner order=21 chrome
// The broker harness's CDP call that gets no answer (web/test-broker-lib.mjs; grader's flake log: runner-broker P1's
// Network.setCookie, no answer within 30 s, twice under load, Nov 4), in headless Chromium: the call still fails,
// naming its method, and its error says what the browser looked like then (the target list, whether the same session
// still answers, whether the browser does, the sessions), each step bounded; the harness carries on after it.
//   node web/test-broker-lib-diag.mjs
import { browser } from "./test-broker-lib.mjs";

let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
// (a short deadline, so a call with no answer is quick to make: a promise that never settles, awaited)
const b = await browser({ cdpMs: 1500 });
try {
  const t0 = Date.now();
  let err = null;
  try {
    await b.ev("new Promise(() => {})");
  } catch (e) {
    err = String(e?.message ?? e);
  }
  const took = Date.now() - t0;
  ok(err !== null && /^CDP Runtime\.evaluate: no answer within 1\.5 s \[/.test(err), `a call with no answer still fails, naming its method: ${String(err).slice(0, 80)}`);
  ok(/targets \(\/json\): \[\["page"/.test(err ?? ""), "…with the target list");
  ok(/the same session, Runtime\.evaluate\(1\): answered \(1\)/.test(err ?? ""), "…whether the same session still answers (here it does)");
  ok(/the browser, Browser\.getVersion: answered \(\w*Chrom/.test(err ?? ""), "…whether the browser itself does");
  ok(/sessions: \d+ attached, \d+ detached; \d+ other calls unanswered\]$/.test(err ?? ""), "…and the sessions");
  ok(took < 1500 + 16000, `…all within bounds (${took} ms)`);
  ok((await b.ev("1 + 1")) === 2, "the harness carries on after it");
  console.log("  (the error: " + String(err).slice(0, 700) + ")");
} catch (e) {
  ok(false, "the test ran: " + String(e?.stack ?? e).slice(0, 400));
} finally {
  await b.close();
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
