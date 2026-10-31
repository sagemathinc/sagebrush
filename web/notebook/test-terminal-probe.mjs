// The Terminal's bridge probe and its verdicts, without an app (plan-native-checks r2.2; the grader's AM-2 and
// B): terminal-probe.js's probe() on fake scopes (a route there is attempted, recorded, and makes the worker's
// verdict FAIL; an empty scope is "unavailable" everywhere), and selftest-terminal.js's policyVerdict
// (check 1: the policy missing, changed, extra, reordered or doubled, a status other than 200, a redirect,
// another URL or content type all FAIL) and workerVerdict (check 3: no report, another nonce, a fetch fetched,
// timed out or refused without its connect-src violation all FAIL; the events matched to the requests one to one,
// astra's NC-R1-A1: duplicates, a wrong or unrelated URI in a request's place, report-only, another directive,
// an extra event, webkit's partial or unmatched sets all FAIL).  The probe's text, as the page and the worker get
// it, is the file itself.
//   bun web/notebook/test-terminal-probe.mjs
import { probe, ROUTES } from "./terminal-probe.js";
import { policyVerdict, workerVerdict, engineOf, reportForms, matchEvents, requestUrls, TERMINAL_CHECKS } from "./selftest-terminal.js";
import { shellWorkerPolicy } from "../csp-policy.mts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); console.log(`${ok ? "ok" : "FAIL"} ${what}`); };
const nonce = "0b8c2a3e-1f2d-4e5f-8a9b-0c1d2e3f4a5b";
const marker = (route) => "terminal bridge probe: worker-route:" + route + " " + nonce;
const goodFetches = { "ipc-scheme": "refused", "ipc-localhost": "refused", "own-origin": "refused" };
// (the violation events as the worker records them; the three requests' own: the IPC scheme's as CSP 3 reports a
// URL of a non-HTTP(S) scheme, its scheme alone)
const ORIGIN = "http://127.0.0.1:1430", OWN = ORIGIN + "/shell/preview-set.json";
const ev = (uri, directive = "connect-src", disposition = "enforce") => ({ uri, directive, disposition });
const GOOD_EVENTS = [ev("ipc"), ev("http://ipc.localhost/app_log"), ev(OWN)];
const report = (routes) => ({ done: true, nonce, routes, fetches: goodFetches, violations: GOOD_EVENTS });
// (the differential's context: the engine fixed by the UA table, the control's own-origin result, the page's policy;
// and what the events are matched against: the own-origin URL and the worker's origin)
const CHROMIUM = { engine: "chromium", control: "fetched-ok", pageCsp: null, ownUrl: OWN, origin: ORIGIN }, WEBKIT = { ...CHROMIUM, engine: "webkit" };

// --- AM-2: a scope with a route: attempted (the stub records the call, with the worker's marker), and the verdict FAILs
{
  const calls = [];
  const scope = { __TAURI_INTERNALS__: { invoke: async (cmd, args) => { calls.push([cmd, args]); return null; } } };
  const routes = await probe(scope, marker, 1000);
  check(routes["tauri-internals-invoke"] === "ok" && calls.length === 1 && calls[0][0] === "app_log" && calls[0][1].message === marker("tauri-internals-invoke"),
    `a stub __TAURI_INTERNALS__.invoke: attempted with the worker's marker and recorded: ${JSON.stringify({ routes, calls })}`);
  const [ok, detail] = workerVerdict(report(routes), nonce, CHROMIUM);
  check(!ok && detail.includes("tauri-internals-invoke:ok"), `...and the worker's verdict FAILS: ${detail}`);
}
{
  const posted = [];
  const scope = { ipc: { postMessage: (m) => posted.push(m) } };
  const routes = await probe(scope, marker, 1000);
  check(routes["ipc-postmessage"] === "no-native-effect" && posted.length === 1 && JSON.parse(posted[0]).payload.message === marker("ipc-postmessage"),
    `a stub ipc.postMessage (Android's route): attempted with the worker's marker and recorded: ${JSON.stringify({ routes, posted })}`);
  const [ok, detail] = workerVerdict(report(routes), nonce, CHROMIUM);
  check(!ok && detail.includes("ipc-postmessage:no-native-effect"), `...and the worker's verdict FAILS: ${detail}`);
}
{
  // (each of the other routes, and one that throws or rejects or never answers: "failed", still a FAIL)
  const scope = {
    __TAURI__: { core: { invoke: () => Promise.reject(new Error("denied")) } },
    webkit: { messageHandlers: { ipc: { postMessage: () => { throw new Error("no"); } } } },
    chrome: { webview: { postMessage: () => {} } },
  };
  const routes = await probe(scope, marker, 1000);
  check(routes["tauri-core-invoke"] === "failed" && routes["webkit-ipc-postmessage"] === "failed" && routes["webview2-postmessage"] === "no-native-effect",
    `the other routes seen and attempted: ${JSON.stringify(routes)}`);
  check(!workerVerdict(report(routes), nonce, CHROMIUM)[0], "...and the worker's verdict FAILS");
  const slow = await probe({ __TAURI_INTERNALS__: { invoke: () => new Promise(() => {}) } }, marker, 200);
  check(slow["tauri-internals-invoke"] === "failed", `an invoke that never answers: "failed" at the probe's bound: ${JSON.stringify(slow)}`);
  const trap = await probe(Object.defineProperty({}, "__TAURI_INTERNALS__", { get() { throw new Error("trap"); } }), marker, 200);
  check(trap["tauri-internals-invoke"] === "unavailable", "a scope whose getter throws: unavailable, no exception");
}
{
  const routes = await probe({}, marker, 1000);
  check(ROUTES.every((r) => routes[r] === "unavailable") && Object.keys(routes).join() === ROUTES.join(), `an empty scope: every route unavailable, in the grammar's order: ${JSON.stringify(routes)}`);
  check(workerVerdict(report(routes), nonce, CHROMIUM)[0], "...and with every fetch refused with its violation: the worker's verdict passes");
}

// --- check 3's other conditions, and the engine rule (the grader's four conditions; astra's narrow WebKit amendment)
{
  const none = Object.fromEntries(ROUTES.map((r) => [r, "unavailable"]));
  const base = report(none);
  const zero = { ...base, violations: [], fetches: { ...goodFetches, "ipc-localhost": "timeout" } };
  const pass = [
    ["chromium, 3 of 3 events and the differential", base, CHROMIUM],
    ["webkit, 0 events and the differential (its IPC fetches information)", zero, WEBKIT],
    ["webkit, 3 of 3 events and the differential (reported)", base, WEBKIT],
    ["chromium, the three events in another order", { ...base, violations: [...GOOD_EVENTS].reverse() }, CHROMIUM],
    ["chromium, the IPC scheme's as its whole URL, the IPC host's as its origin (CSP 2's cross-origin form)",
      { ...base, violations: [ev("ipc://localhost/app_log"), ev("http://ipc.localhost"), ev(OWN)] }, CHROMIUM],
  ];
  for (const [what, rep, ctx] of pass) check(workerVerdict(rep, nonce, ctx)[0], `check 3 passes: ${what}: ${workerVerdict(rep, nonce, ctx)[1].slice(0, 200)}`);
  const fail = [
    ["no report (a dead worker)", null, CHROMIUM],
    ["a report that isn't done", { ...base, done: false, error: "boot failed" }, CHROMIUM],
    ["another nonce", { ...base, nonce: "11111111-2222-4333-8444-555555555555" }, CHROMIUM],
    ["chromium with 0 events (never downgraded)", { ...base, violations: [] }, CHROMIUM],
    ["chromium with 1 of 3", { ...base, violations: [ev(OWN)] }, CHROMIUM],
    ["webkit with 2 of 3 (partial)", { ...base, violations: [ev("ipc"), ev(OWN)] }, WEBKIT],
    // (astra's NC-R1-A1: each request needs ITS event, one to one; a count of three is not enough)
    ["chromium, three events, all the own-origin's (duplicates only)", { ...base, violations: [ev(OWN), ev(OWN), ev(OWN)] }, CHROMIUM],
    ["chromium, the IPC localhost's missing, replaced by a duplicate", { ...base, violations: [ev("ipc"), ev("ipc"), ev(OWN)] }, CHROMIUM],
    ["chromium, the IPC localhost's missing, replaced by an unrelated URI", { ...base, violations: [ev("ipc"), ev("https://example.com/x"), ev(OWN)] }, CHROMIUM],
    ["chromium, a wrong URI on the IPC host", { ...base, violations: [ev("ipc"), ev("http://ipc.localhost/other"), ev(OWN)] }, CHROMIUM],
    ["chromium, one report-only (not enforced)", { ...base, violations: [ev("ipc"), ev("http://ipc.localhost/app_log", "connect-src", "report"), ev(OWN)] }, CHROMIUM],
    ["chromium, one of another directive", { ...base, violations: [ev("ipc"), ev("http://ipc.localhost/app_log", "script-src-elem"), ev(OWN)] }, CHROMIUM],
    ["chromium, the three and an unrelated fourth", { ...base, violations: [...GOOD_EVENTS, ev("https://example.com/x")] }, CHROMIUM],
    ["chromium, the own-origin reported as its origin only (same origin: the URL only)", { ...base, violations: [ev("ipc"), ev("http://ipc.localhost/app_log"), ev(ORIGIN)] }, CHROMIUM],
    ["webkit, three unrelated events", { ...base, violations: [ev("https://example.com/a"), ev("https://example.com/b"), ev("https://example.com/c")] }, WEBKIT],
    ["webkit, one report-only event alone", { ...base, violations: [ev(OWN, "connect-src", "report")] }, WEBKIT],
    ["webkit, the three and a duplicate", { ...base, violations: [...GOOD_EVENTS, ev(OWN)] }, WEBKIT],
    ["chromium with an IPC fetch timed out", { ...base, fetches: { ...goodFetches, "ipc-scheme": "timeout" } }, CHROMIUM],
    ["the own-origin fetch fetched", { ...base, fetches: { ...goodFetches, "own-origin": "fetched-ok" } }, WEBKIT],
    ["the control failed (inconclusive)", zero, { ...WEBKIT, control: "fetched-404" }],
    ["the control timed out (inconclusive)", zero, { ...WEBKIT, control: "the control worker timed out after 10 s" }],
    ["the page has a policy of its own", zero, { ...WEBKIT, pageCsp: "default-src 'self'" }],
    ["an unknown engine", base, { ...CHROMIUM, engine: "unknown" }],
  ];
  for (const [what, rep, ctx] of fail) check(!workerVerdict(rep, nonce, ctx)[0], `check 3 FAILS on ${what}: ${workerVerdict(rep, nonce, ctx)[1].slice(0, 200)}`);
}

// --- the verdict's own ok detail, as the report judge reads it (app/selftest/android-report.py's closed grammar),
// with the caller's engine: passes with its own engine, fails with the other
{
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = join(import.meta.dir, "..", "..");
  const good = readFileSync(join(root, "app/selftest/report-fixtures/good.txt"), "utf8").split("\n");
  const dir = mkdtempSync(join(tmpdir(), "sb-term-judge-"));
  const none = Object.fromEntries(ROUTES.map((r) => [r, "unavailable"]));
  for (const [engine, rep, ctx] of [["chromium", report(none), CHROMIUM], ["webkit", { ...report(none), violations: [] }, WEBKIT]]) {
    const [ok, detail] = workerVerdict(rep, nonce, ctx);
    const f = join(dir, engine + ".txt");
    writeFileSync(f, good.map((l) => (l.startsWith("ok   " + TERMINAL_CHECKS[2] + ": ") ? "ok   " + TERMINAL_CHECKS[2] + ": " + detail : l)).join("\n"));
    const judge = (eng) => spawnSync("python3", ["-I", join(root, "app/selftest/android-report.py"), "--engine", eng, f], { encoding: "utf8" }).status;
    const other = engine === "chromium" ? "webkit" : "chromium";
    check(ok && judge(engine) === 0 && judge(other) === 1, `the ${engine} verdict's detail passes the report judge with --engine ${engine} (0) and fails with ${other} (1)`);
  }
}

// --- the engine table, on real user agents (the judges outside the page cross-check it by platform)
{
  const UA = [
    ["Chrome desktop", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", "chromium"],
    ["headless Chromium (the CI tests')", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36", "chromium"],
    ["Edge / WebView2", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", "chromium"],
    ["Android WebView", "Mozilla/5.0 (Linux; Android 14; sdk_gphone64_x86_64 Build/UE1A.230829.050; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/113.0.5672.136 Mobile Safari/537.36", "chromium"],
    ["Safari", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "webkit"],
    ["WKWebView (macOS app)", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)", "webkit"],
    ["WKWebView (iOS)", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", "webkit"],
    ["WebKitGTK (Linux app)", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)", "webkit"],
    ["Firefox", "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "unknown"],
    ["an empty UA", "", "unknown"],
  ];
  for (const [what, ua, want] of UA) check(engineOf(ua) === want, `engineOf(${what}) = ${want}: ${engineOf(ua)}`);
}

// --- check 1's comparison
{
  const policy = shellWorkerPolicy();
  const url = "http://127.0.0.1:1234/shell/worker-boot.js";
  const base = { status: 200, redirected: false, url, contentType: "text/javascript; charset=utf-8", csp: policy };
  check(policyVerdict(base, url)[0], `the site's policy, exactly: ok (${policy})`);
  check(policyVerdict({ ...base, contentType: "application/javascript" }, url)[0], "application/javascript: ok");
  const parts = policy.split("; ");
  const cases = [
    ["missing", { csp: null }],
    ["changed", { csp: policy.replace("connect-src 'none'", "connect-src 'self'") }],
    ["extra", { csp: policy + "; img-src 'none'" }],
    ["reordered", { csp: [...parts].reverse().join("; ") }],
    ["doubled (fetch joins two headers with \", \")", { csp: policy + ", " + policy }],
    ["a 404", { status: 404 }],
    ["a redirect", { redirected: true }],
    ["another URL", { url: "http://127.0.0.1:1234/shell/other.js" }],
    ["another content type", { contentType: "text/html" }],
  ];
  for (const [what, change] of cases) check(!policyVerdict({ ...base, ...change }, url)[0], `check 1 FAILS on the policy ${what}: ${policyVerdict({ ...base, ...change }, url)[1].slice(0, 120)}`);
}
check(TERMINAL_CHECKS.length === 3 && new Set(TERMINAL_CHECKS).size === 3, "three check names, distinct");

// --- the blockedURI forms (explicit, nothing looser)
{
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check(eq(reportForms("ipc://localhost/app_log", ORIGIN), ["ipc", "ipc://localhost/app_log"]), "a non-HTTP(S) URL: its scheme, or the URL");
  check(eq(reportForms("http://ipc.localhost/app_log", ORIGIN), ["http://ipc.localhost/app_log", "http://ipc.localhost"]), "another origin: the URL, or the origin");
  check(eq(reportForms("http://u:p@127.0.0.1:1430/shell/preview-set.json#x", ORIGIN), [OWN]), "the same origin: the URL only, without credentials or fragment");
  check(eq(reportForms("not a url", ORIGIN), []), "no URL: no form");
  const m = matchEvents([ev(OWN), ev(OWN), ev("ipc", "connect-src", "report")], requestUrls(OWN), ORIGIN);
  check(m.per["own-origin"] === 1 && m.per["ipc-scheme"] === 0 && m.unmatched === 2 && m.total === 3, `a duplicate and a report-only event are unmatched: ${JSON.stringify(m)}`);
}

if (fails.length) { console.log(`test-terminal-probe: ${fails.length} of ${checks} FAILED`); process.exit(1); }
console.log(`test-terminal-probe: all ${checks} checks pass`);
