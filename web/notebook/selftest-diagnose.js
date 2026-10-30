// The app self-test's diagnosis of cross-origin isolation, a module of its
// own (web/build.ts -> sagebrush-selftest.js), imported by selftest() in
// web/index.html only when the app's self-test runs, so the page everyone
// loads carries only that call (app/selftest/check-diagnose-lazy.mjs checks
// it).  diagnoseLines(kernel) gives the report's "info <key>: <value>" lines,
// every key once, in SELFTEST_INFO_KEYS's order (android-report.py's closed
// list).
//
// What the page and its kernel see, and what the app's server
// answers to two marked same-origin fetches (?sb-diag=, which the debug
// app's server log tells apart from the page's own loads).  Bounded: 5 s per
// fetch, 15 s in all; a key not reached keeps 'error: "not reached"'.  Each
// value is one line of at most 200 characters (400 for the fetches' two
// full URLs), longer ones cut with "...(truncated N)".
export const SELFTEST_INFO_KEYS = ["origin", "secure-context", "top-level", "isolated-document", "sab-document", "coi-policy", "kernel-interrupt-shared", "kernel-isolated", "kernel-sab", "fetch-page", "fetch-kernel-script", "user-agent"];
async function diagnose(info, kernel) {
  const cap = (s, n = 200) => (s.length > n ? s.slice(0, n) + "...(truncated " + (s.length - n) + ")" : s);
  const str = (v) => cap(JSON.stringify(String(v)));
  const err = (e) => "error: " + str((e?.name ?? "Error") + ": " + (e?.message ?? e));
  const bool = (v) => (v === true ? "true" : v === false ? "false" : "error: " + str("not a boolean: " + v));
  // (each fetch aborts after 5 s, or when the whole diagnosis runs out)
  const pending = new Set();
  let retired = false;  // (set when the whole diagnosis runs out: no new fetch starts after it)
  const probe = async (url, corp) => {
    if (retired) return "timeout";
    const ac = new AbortController();
    pending.add(ac);
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ac.signal });
      const q = new URL(url), u = new URL(r.url);
      const o = { status: r.status, ok: r.ok, requested: q.origin + q.pathname + q.search, final: u.origin + u.pathname + u.search, redirected: r.redirected, COOP: r.headers.get("cross-origin-opener-policy"), COEP: r.headers.get("cross-origin-embedder-policy") };
      if (corp) o.CORP = r.headers.get("cross-origin-resource-policy");
      await r.body?.cancel().catch(() => {});
      return cap(JSON.stringify(o), 400);  // (two full URLs and the headers)
    } catch (e) {
      return ac.signal.aborted ? "timeout" : err(e);
    } finally {
      clearTimeout(timer);
      pending.delete(ac);
    }
  };
  const facts = async () => {
    info.origin = str(location.origin);
    info["secure-context"] = bool(window.isSecureContext);
    info["top-level"] = bool(window.top === window);
    info["isolated-document"] = bool(window.crossOriginIsolated);
    info["sab-document"] = str(typeof SharedArrayBuffer);
    // (the permission policy, where it can be asked, and only for a feature
    // name it knows)
    try {
      const pp = document.permissionsPolicy ?? document.featurePolicy;
      info["coi-policy"] = !pp ? "unsupported" : !pp.features().includes("cross-origin-isolated") ? "unrecognized" : bool(pp.allowsFeature("cross-origin-isolated"));
    } catch (e) { info["coi-policy"] = err(e); }
    info["kernel-interrupt-shared"] = bool(!!kernel.interruptFlag);
    const c = kernel.context;
    info["kernel-isolated"] = c ? bool(c.isolated) : 'error: "the kernel sent no context"';
    info["kernel-sab"] = c ? str(c.sab) : 'error: "the kernel sent no context"';
    info["user-agent"] = str(navigator.userAgent);
    info["fetch-page"] = await probe(new URL(location.pathname + "?sb-diag=1", location.href).href, false);
    info["fetch-kernel-script"] = await probe(new URL("sagebrush-worker.js?sb-diag=2", location.href).href, true);
  };
  let timer;
  try {
    await Promise.race([facts(), new Promise((r) => { timer = setTimeout(r, 15000); })]);
  } catch (e) {
    console.log("diagnose: " + (e?.stack ?? e));
  } finally {
    clearTimeout(timer);
    retired = true;
    for (const ac of pending) ac.abort();
  }
}

export async function diagnoseLines(kernel) {
  const info = Object.fromEntries(SELFTEST_INFO_KEYS.map((k) => [k, 'error: "not reached"']));
  await diagnose(info, kernel);
  return SELFTEST_INFO_KEYS.map((k) => "info " + k + ": " + info[k]);
}
