// The app self-test's checks of the Terminal's shell worker in the real app (plan-native-checks r2.2, after
// #380; astra's R-NC-1..3, the grader's A/B/AM-1/AM-2), part of sagebrush-selftest.js (imported only when the
// self-test runs).  Three checks, each a REQUIRED report key (app/selftest/run.mjs, android-report.py):
//   1 "the shell worker's policy (lib.rs)": worker-boot.js, 200, not redirected, at its exact URL, JavaScript,
//     with exactly the site's shell worker policy (web/csp-policy.mts shellWorkerPolicy, as lib.rs sends it);
//   2 "the page reaches the app's bridge": the page's own app_log, and the probe (terminal-probe.js) run in the
//     page, which must find a real route and reach the native log (the positive; its detail is the grammar's
//     "nonce=… routes=…", read by app/selftest/probe-log.py with the app's log);
//   3 "the shell worker can't reach the app's bridge": the same probe in a real shell worker (worker-boot.js,
//     as the Terminal starts it, with that response's policy): no route, and every fetch refused WITH its
//     connect-src violation; a worker that never reports fails.
import { shellWorkerPolicy } from "../csp-policy.mts";
import probeText from "./terminal-probe.js" with { type: "text" };

export const TERMINAL_CHECKS = ["the shell worker's policy (lib.rs)", "the page reaches the app's bridge", "the shell worker can't reach the app's bridge"];
const ROUTES = ["tauri-internals-invoke", "tauri-core-invoke", "ipc-postmessage", "webkit-ipc-postmessage", "webview2-postmessage"];

// Check 1's verdict, pure: what the fetch saw against what it must be.
export function policyVerdict(r, expectedUrl, policy = shellWorkerPolicy()) {
  const bad = [];
  if (r.status !== 200) bad.push("status " + r.status);
  if (r.redirected) bad.push("redirected");
  if (r.url !== expectedUrl) bad.push("url " + JSON.stringify(r.url));
  if (!/^(text|application)\/javascript\b/.test(r.contentType ?? "")) bad.push("content type " + JSON.stringify(r.contentType));
  if (r.csp !== policy) bad.push("policy " + JSON.stringify(r.csp));
  return [bad.length === 0, bad.length ? bad.join("; ") : JSON.stringify(r.csp)];
}

// The engine family, from a closed table of the user agent (the grader's condition: fixed by the engine, never by
// what a run observed; the judges outside the page cross-check it with the platform they run on): "chromium"
// (Chrome, Edge/WebView2, Android's WebView), "webkit" (Safari, WKWebView, WebKitGTK), else "unknown" (a FAIL).
export function engineOf(ua) {
  if (typeof ua !== "string" || !ua) return "unknown";
  // (HeadlessChrome/ too: no word boundary before "Chrome" there)
  if (/(?:\b|Headless)(?:Chrome|Chromium|Edg)\//.test(ua)) return "chromium";
  if (/\bAppleWebKit\//.test(ua) && !/\b(Firefox|Gecko\/\d{8})\b/.test(ua)) return "webkit";
  return "unknown";
}

// The three requests the shell worker makes, each of which its policy must refuse (terminal-probe.js start()).
export const REQUESTS = ["ipc-scheme", "ipc-localhost", "own-origin"];
export const requestUrls = (ownUrl) => ({ "ipc-scheme": "ipc://localhost/app_log", "ipc-localhost": "http://ipc.localhost/app_log", "own-origin": ownUrl });

// The forms a violation event's blockedURI may take for a request to `url` from a worker of `origin` (astra's
// NC-R1-A1: explicit normalization rules, nothing looser):
//   not HTTP(S): its scheme alone (CSP 3, "strip URL for use in reports"), or the URL without fragment/credentials;
//   HTTP(S), same origin: the URL without fragment or credentials, only;
//   HTTP(S), another origin: that, or the origin alone (CSP 2's cross-origin rule, which WebKit may still follow).
export function reportForms(url, origin) {
  let u;
  try { u = new URL(url); } catch { return []; }
  u.hash = ""; u.username = ""; u.password = "";
  if (u.protocol !== "http:" && u.protocol !== "https:") return [u.protocol.slice(0, -1), u.href];
  return u.origin === origin ? [u.href] : [u.href, u.origin];
}

// Match the recorded events to the requests, one to one: an event counts for a request only if it is enforced
// (disposition "enforce"), its directive is connect-src and its blockedURI is one of that request's forms; any other
// event (a report-only one, another directive, a URI of no request, or a second for the same request) is
// "unmatched".  -> { per: {request: matching events}, unmatched, total }.
export function matchEvents(events, urls, origin) {
  const per = Object.fromEntries(REQUESTS.map((k) => [k, 0]));
  let unmatched = 0;
  const list = Array.isArray(events) ? events : [];
  for (const ev of list) {
    const k = ev && ev.disposition === "enforce" && ev.directive === "connect-src"
      ? REQUESTS.find((k) => per[k] === 0 && reportForms(urls[k], origin).includes(ev.uri)) : undefined;
    if (k) per[k]++;
    else unmatched++;
  }
  return { per, unmatched, total: list.length };
}

// Check 3's verdict, pure: the worker's report (terminal-probe.js start()) for this nonce, on this engine, with the
// differential's control (the identical own-origin fetch from a policy-free worker), the page's own policy, and the
// URLs and origin the events are matched against (ctx.ownUrl, ctx.origin).
//   chromium: every route unavailable; the three fetches refused; for EACH request exactly one matching enforced
//     connect-src violation and no other event (3 events, matched one to one); and the differential.
//   webkit (astra's narrow amendment): every route unavailable; the own-origin fetch refused while the control
//     fetched the asset (the differential); events: none at all, or the full set matched one to one as chromium's;
//     the two IPC fetches information only (their refusal not attributed to the policy).
//   Either: any other event set FAILS (partial, duplicated, unrelated, report-only); a control that failed or timed
//   out FAILS (inconclusive), as does a page with a policy of its own (the control would not be policy-free).
export function workerVerdict(rep, nonce, ctx = {}) {
  if (!rep || rep.done !== true) return [false, "the worker didn't report: " + JSON.stringify(rep?.error ?? rep ?? "no report")];
  if (rep.nonce !== nonce) return [false, "another nonce: " + JSON.stringify(rep.nonce)];
  const engine = ctx.engine ?? "unknown";
  const bad = [];
  if (engine !== "chromium" && engine !== "webkit") bad.push("unknown engine");
  for (const r of ROUTES) if (rep.routes?.[r] !== "unavailable") bad.push(r + ":" + rep.routes?.[r]);
  const { per, unmatched, total } = matchEvents(rep.violations, requestUrls(ctx.ownUrl), ctx.origin);
  const full = REQUESTS.every((k) => per[k] === 1) && unmatched === 0 && total === 3;
  if (!full && !(engine === "webkit" && total === 0))
    bad.push("violations " + total + " not one matching enforced connect-src event per request" + (engine === "webkit" ? " (nor none)" : ""));
  if (rep.fetches?.["own-origin"] !== "refused") bad.push("own-origin:" + rep.fetches?.["own-origin"]);
  if (ctx.control !== "fetched-ok") bad.push("control:" + ctx.control + " (inconclusive)");
  if (ctx.pageCsp !== null) bad.push("the page has a policy " + JSON.stringify(ctx.pageCsp) + " (the control isn't policy-free)");
  if (engine === "chromium")
    for (const f of ["ipc-scheme", "ipc-localhost"]) if (rep.fetches?.[f] !== "refused") bad.push(f + ":" + rep.fetches?.[f]);
  const mode = engine === "webkit" ? "webkit-differential" : "all-events";
  const detail = "engine=" + engine + " mode=" + mode + " violations=" + total + " events=" + REQUESTS.map((k) => k + ":" + per[k]).join(",") + " unmatched=" + unmatched +
    " differential=own-origin:" + rep.fetches?.["own-origin"] + ",control:" + ctx.control +
    " routes=" + ROUTES.map((r) => r + ":" + rep.routes?.[r]).join(",") + " ipc=" + ["ipc-scheme", "ipc-localhost"].map((f) => f + ":" + rep.fetches?.[f]).join(",") + (engine === "webkit" ? "(information)" : "");
  return [bad.length === 0, bad.length ? "reachable or unproven: " + bad.join(", ") + " (" + detail + ")" : detail];
}

const timeout = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(what + " timed out after " + ms / 1000 + " s")), ms); })]).finally(() => clearTimeout(t)); };

export async function terminalChecks(invoke, base = location.href) {
  const nonce = crypto.randomUUID();
  const workerUrl = new URL("shell/worker-boot.js", base).href;
  const out = [];
  // 1: the header
  try {
    const r = await timeout(fetch(workerUrl, { cache: "no-store", redirect: "manual" }), 5000, "the fetch");
    await r.body?.cancel().catch(() => {});
    out.push([TERMINAL_CHECKS[0], ...policyVerdict({ status: r.status, redirected: r.redirected || r.type === "opaqueredirect", url: r.url, contentType: r.headers.get("content-type"), csp: r.headers.get("content-security-policy") }, workerUrl)]);
  } catch (e) { out.push([TERMINAL_CHECKS[0], false, String(e?.message ?? e)]); }
  // 2: the page's own app_log, then the probe in the page (the same text the worker gets)
  const blob = URL.createObjectURL(new Blob([probeText], { type: "text/javascript" }));
  try {
    await timeout(invoke("app_log", { message: "terminal bridge probe: page " + nonce }), 5000, "the page's app_log");
    const { probe } = await timeout(import(blob), 10000, "the probe's import");
    const routes = await probe(globalThis, (route) => "terminal bridge probe: page-route:" + route + " " + nonce);
    const own = await timeout(fetch(base, { cache: "no-store" }), 5000, "the page's own fetch");
    await own.body?.cancel().catch(() => {});
    const anyOk = ROUTES.some((r) => routes[r] === "ok");
    const detail = "nonce=" + nonce + " routes=" + ROUTES.map((r) => r + ":" + routes[r]).join(",");
    out.push([TERMINAL_CHECKS[1], anyOk && own.ok, anyOk && own.ok ? detail : detail + (anyOk ? "" : " (no route reached the bridge)") + (own.ok ? "" : " (own fetch " + own.status + ")")]);
  } catch (e) { out.push([TERMINAL_CHECKS[1], false, "nonce=" + nonce + " " + String(e?.message ?? e)]); }
  finally { URL.revokeObjectURL(blob); }
  // 3: the same probe in a real shell worker, as the Terminal starts one (web/shell/loader.ts), and the
  // differential's control: the identical own-origin fetch from a policy-free worker of this same text
  const ownUrl = new URL("shell/preview-set.json", base).href;
  let worker, ch, control, cblob;
  try {
    const engine = engineOf(navigator.userAgent);
    const page = await timeout(fetch(base, { cache: "no-store" }), 5000, "the page's own fetch");
    await page.body?.cancel().catch(() => {});
    const pageCsp = page.headers.get("content-security-policy");
    cblob = URL.createObjectURL(new Blob([probeText], { type: "text/javascript" }));
    control = new Worker(cblob, { type: "module", name: "sagebrush-probe-control" });
    const ctl = await timeout(new Promise((resolve) => {
      control.onmessage = (e) => resolve(e.data?.nonce === nonce ? e.data.result : "another nonce");
      control.onerror = () => resolve("control worker error");
      control.postMessage({ url: ownUrl, nonce });
    }), 10000, "the control worker").catch((e) => String(e?.message ?? e));
    worker = new Worker(workerUrl, { type: "module", name: "sagebrush-shell" });
    ch = new MessageChannel();
    const rep = await timeout(new Promise((resolve) => {
      ch.port1.onmessage = (e) => resolve(e.data?.name === "boot.failed" ? { done: false, error: "boot failed: " + e.data?.payload?.message } : e.data);
      worker.onerror = (e) => resolve({ done: false, error: "worker error: " + (e?.message ?? "load failed") });
      worker.postMessage({ text: probeText, port: ch.port2 }, [ch.port2]);
      ch.port1.postMessage({ nonce, ownUrl });
    }), 30000, "the worker's report");
    out.push([TERMINAL_CHECKS[2], ...workerVerdict(rep, nonce, { engine, control: ctl, pageCsp, ownUrl, origin: new URL(workerUrl).origin })]);
  } catch (e) { out.push([TERMINAL_CHECKS[2], false, String(e?.message ?? e)]); }
  finally {
    try { ch?.port1.close(); } catch {}
    try { worker?.terminate(); } catch {}
    try { control?.terminate(); } catch {}
    if (cblob) URL.revokeObjectURL(cblob);
  }
  // The capture's end (sage2's sentinel, astra's placement): with every probe worker terminated above and before
  // the page reports (selftest_report exits the desktop app), the page logs "done" once, whatever the checks found.
  // probe-log.py requires it exactly once, after this run's page markers, with no probe marker after it: proof
  // that the native log was read through the self-test's end.  (It is not an ordering barrier for IPC sent
  // earlier by another sender; a worker route that was callable already fails check 3.)
  await timeout(invoke("app_log", { message: "terminal bridge probe: done " + nonce }), 5000, "the done marker").catch(() => {});
  return out;
}
