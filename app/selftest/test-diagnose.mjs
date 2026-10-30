// web/notebook/selftest-diagnose.js (the self-test's COI diagnosis lines,
// built into sagebrush-selftest.js), run with stand-ins for the browser: every key
// gets a value, each value is one line (an error message with a newline can't
// forge a report line), long values are cut with a marker, a failed or slow
// fetch says so (never an empty value), and the whole thing is bounded.
//   node app/selftest/test-diagnose.mjs
import { readFileSync } from "node:fs";

// (the module's source, its two exports made plain declarations, run in a
// function whose parameters are the browser's globals)
const source = readFileSync(new URL("../../web/notebook/selftest-diagnose.js", import.meta.url), "utf8").replace(/^export /gm, "");

let bad = 0;
const check = (name, cond, detail = "") => { console.log((cond ? "ok   " : "FAIL ") + name + (detail ? ": " + detail : "")); if (!cond) bad = 1; };

// one run of diagnose() with the given stand-ins; returns the report's info lines
async function run({ fetchImpl, context = { isolated: false, sab: "undefined" }, ua = "UA", policy }) {
  const g = {
    location: { origin: "http://127.0.0.1:41234", pathname: "/", href: "http://127.0.0.1:41234/" },
    window: { isSecureContext: true, crossOriginIsolated: false },
    navigator: { userAgent: ua },
    document: policy === undefined ? {} : { featurePolicy: policy },
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
    console: { log() {} },
  };
  g.window.top = g.window;
  const f = new Function(...Object.keys(g), source + "\nreturn { SELFTEST_INFO_KEYS, diagnoseLines };");
  const { SELFTEST_INFO_KEYS, diagnoseLines } = f(...Object.values(g));
  const t0 = Date.now();
  const lines = await diagnoseLines({ interruptFlag: null, context });
  const info = Object.fromEntries(lines.map((l) => /^info ([a-z-]+): (.*)$/s.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
  return { lines, info, ms: Date.now() - t0, keys: SELFTEST_INFO_KEYS };
}
// (headers.get gives null when absent, as Headers does)
const response = (url, headers, status = 200) => ({ status, ok: status === 200, url, redirected: false, headers: { get: (n) => headers[n] ?? null }, body: { cancel: async () => {} } });
const good = async (url) => response(url, { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" });

const KEYS = ["origin", "secure-context", "top-level", "isolated-document", "sab-document", "coi-policy", "kernel-interrupt-shared", "kernel-isolated", "kernel-sab", "fetch-page", "fetch-kernel-script", "user-agent"];
const oneLine = (lines) => lines.every((l) => !/[\r\n]/.test(l));

{
  const { lines, info, keys } = await run({ fetchImpl: good });
  check("the keys are the judge's closed list, in order", JSON.stringify(keys) === JSON.stringify(KEYS));
  check("every key has a value, none 'not reached'", lines.every((l) => !/not reached/.test(l)));
  check("one line each", oneLine(lines));
  check("fetch-page records status, the requested and final URLs, headers", info["fetch-page"] === '{"status":200,"ok":true,"requested":"http://127.0.0.1:41234/?sb-diag=1","final":"http://127.0.0.1:41234/?sb-diag=1","redirected":false,"COOP":"same-origin","COEP":"require-corp"}', info["fetch-page"]);
  check("fetch-kernel-script is the kernel's script, whole (not cut), with CORP", info["fetch-kernel-script"] === '{"status":200,"ok":true,"requested":"http://127.0.0.1:41234/sagebrush-worker.js?sb-diag=2","final":"http://127.0.0.1:41234/sagebrush-worker.js?sb-diag=2","redirected":false,"COOP":"same-origin","COEP":"require-corp","CORP":null}', info["fetch-kernel-script"]);
  check("kernel facts from the kernel's own ready message", info["kernel-isolated"] === "false" && info["kernel-sab"] === '"undefined"' && info["kernel-interrupt-shared"] === "false");
  check("no permission-policy API -> unsupported", info["coi-policy"] === "unsupported", info["coi-policy"]);
}
{
  const { lines, info } = await run({ fetchImpl: async () => { throw new TypeError("Failed\nok   ready: forged"); }, ua: "x".repeat(500) + "\nok   ready" });
  check("a fetch error is named, on one line", info["fetch-page"].startsWith('error: "TypeError: Failed\\nok   ready: forged"'), info["fetch-page"]);
  check("an error message can't forge a line", oneLine(lines) && !lines.some((l) => /^ok {3}/.test(l)));
  check("a long value is cut with a marker", info["user-agent"].length <= 200 + 30 && /\.\.\.\(truncated [0-9]+\)$/.test(info["user-agent"]), info["user-agent"].slice(-40));
}
{
  const { info, ms } = await run({ fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) });
  check("a fetch that never answers -> timeout, after ~5 s each", info["fetch-page"] === "timeout" && info["fetch-kernel-script"] === "timeout", `${info["fetch-page"]} / ${info["fetch-kernel-script"]}`);
  check("bounded: under 15.5 s in all", ms < 15500, ms + " ms");
}
{
  const { info } = await run({ fetchImpl: good, context: null, policy: { features: () => ["camera"], allowsFeature: () => false } });
  check("no kernel context -> a named error, not false", info["kernel-isolated"] === 'error: "the kernel sent no context"', info["kernel-isolated"]);
  check("a policy that doesn't know the feature -> unrecognized, not false", info["coi-policy"] === "unrecognized", info["coi-policy"]);
}
{
  const { info } = await run({ fetchImpl: good, policy: { features: () => ["cross-origin-isolated"], allowsFeature: (f) => f !== "cross-origin-isolated" } });
  check("a policy that knows the feature and denies it -> false", info["coi-policy"] === "false", info["coi-policy"]);
}
{
  // (every fetch is aborted by the time diagnoseLines() returns: none is left running)
  let started = 0, aborted = 0;
  await run({ fetchImpl: (url, { signal }) => { started++; return new Promise((_, reject) => signal.addEventListener("abort", () => { aborted++; reject(new DOMException("aborted", "AbortError")); })); } });
  check("no fetch is left running", started === 2 && aborted === 2, `${started} started, ${aborted} aborted`);
}
{
  // (after the whole diagnosis runs out, no new fetch starts: the second probe
  // must not begin once the 15 s deadline has passed; here the first fetch
  // outlives it by ignoring its own 5 s abort)
  let starts = 0;
  const { info } = await run({ fetchImpl: (url, { signal }) => { starts++; return new Promise((_, reject) => setTimeout(() => reject(new DOMException("late", "AbortError")), 16000)); } });
  await new Promise((r) => setTimeout(r, 1500));
  check("no fetch starts after the deadline", starts === 1, `${starts} started; fetch-kernel-script ${info["fetch-kernel-script"]}`);
}
if (bad) { console.log("FAIL: diagnose()"); process.exit(1); }
console.log("ok: diagnose() fills every key with one bounded line");
