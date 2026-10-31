// The Terminal's bridge probe (the app self-test; plan-native-checks r2.2, its marker grammar
// app/selftest/probe-grammar.md): ONE text, run twice.  The page imports it as a blob: module and calls probe()
// on itself, the positive: a real transport there must reach the app's native log.  The shell worker gets the
// same text through worker-boot.js's own protocol ({text, port}), which imports it and calls start(port): there
// every route must be unavailable, and the fetches refused by the worker's own policy.  Self-contained (no
// imports): web/notebook/selftest-terminal.js takes it as text.

// (the routes, a closed set in this order: the app's bridge as a page or a worker might see it)
export const ROUTES = ["tauri-internals-invoke", "tauri-core-invoke", "ipc-postmessage", "webkit-ipc-postmessage", "webview2-postmessage"];

// For each route: present and callable in `scope`?  If so, the benign app_log is attempted through it, with the
// route's marker.  "ok": the call resolved; "no-native-effect": a raw postMessage was made (nothing comes back
// to tell); "failed": it threw or rejected or ran out of time; "unavailable": not there.
export async function probe(scope, marker, ms = 5000) {
  const out = {};
  const get = (f) => { try { return f(); } catch { return undefined; } };
  const call = async (thisArg, fn, args) => {
    let t;
    try {
      await Promise.race([fn.apply(thisArg, args), new Promise((_, no) => { t = setTimeout(() => no(new Error("timed out")), ms); })]);
      return "ok";
    } catch {
      return "failed";
    } finally {
      clearTimeout(t);
    }
  };
  const post = (thisArg, fn, msg) => { try { fn.call(thisArg, msg); return "no-native-effect"; } catch { return "failed"; } };
  const invokeArgs = (route) => ["app_log", { message: marker(route) }];
  const raw = (route) => JSON.stringify({ cmd: "app_log", payload: { message: marker(route) } });
  const internals = get(() => scope.__TAURI_INTERNALS__);
  const core = get(() => scope.__TAURI__?.core);
  const ipc = get(() => scope.ipc);
  const webkit = get(() => scope.webkit?.messageHandlers?.ipc);
  const webview = get(() => scope.chrome?.webview);
  out["tauri-internals-invoke"] = typeof internals?.invoke === "function" ? await call(internals, internals.invoke, invokeArgs("tauri-internals-invoke")) : "unavailable";
  out["tauri-core-invoke"] = typeof core?.invoke === "function" ? await call(core, core.invoke, invokeArgs("tauri-core-invoke")) : "unavailable";
  out["ipc-postmessage"] = typeof ipc?.postMessage === "function" ? post(ipc, ipc.postMessage, raw("ipc-postmessage")) : "unavailable";
  out["webkit-ipc-postmessage"] = typeof webkit?.postMessage === "function" ? post(webkit, webkit.postMessage, raw("webkit-ipc-postmessage")) : "unavailable";
  out["webview2-postmessage"] = typeof webview?.postMessage === "function" ? post(webview, webview.postMessage, raw("webview2-postmessage")) : "unavailable";
  return out;
}

// The own-origin fetch, the SAME code in the shell worker and in the policy-free control worker (astra's
// differential): a known public asset of the app's own origin, shell/preview-set.json, whose content must be the
// set's id.  "fetched-ok", "fetched-<status>" or "fetched-bad" (a response, not the asset), "refused" (rejected),
// "timeout".
export async function ownOrigin(url, ms = 5000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ac.signal });
    if (!r.ok) return "fetched-" + r.status;
    let S = null;
    try { S = JSON.parse(await r.text())?.S; } catch {}
    return typeof S === "string" && /^[0-9a-f]{64}$/.test(S) ? "fetched-ok" : "fetched-bad";
  } catch {
    return ac.signal.aborted ? "timeout" : "refused";
  } finally {
    clearTimeout(t);
  }
}

// The control worker (selftest-terminal.js starts this same text as a module worker of its own, named so,
// under the page's policy, which in the app is none): it fetches what it is told, with ownOrigin, once.
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope && self.name === "sagebrush-probe-control")
  self.onmessage = async (e) => { self.onmessage = null; self.postMessage({ nonce: e.data?.nonce, result: await ownOrigin(String(e.data?.url ?? "")) }); };

// In the shell worker (worker-boot.js calls start(port)): the page's first message on the port carries the
// nonce and the own-origin URL; the worker runs the probe on itself, then three fetches its policy must refuse
// (the app's IPC scheme two ways, with Tauri's header names, and the own-origin asset, with ownOrigin), counts
// the connect-src violations, and reports once, naming every attempt.
export function start(port) {
  port.onmessage = async (e) => {
    port.onmessage = null;
    const nonce = String(e.data?.nonce ?? "");
    const violations = [];
    const onViolation = (v) => violations.push(v.effectiveDirective);
    self.addEventListener("securitypolicyviolation", onViolation);
    const report = { done: false, nonce, routes: {}, fetches: {}, violations };
    try {
      report.routes = await probe(self, (route) => "terminal bridge probe: worker-route:" + route + " " + nonce);
      const headers = { "Content-Type": "application/json", "Tauri-Callback": "0", "Tauri-Error": "1", "Tauri-Invoke-Key": "" };
      const body = JSON.stringify({ message: "terminal bridge probe: worker-route:fetch " + nonce });
      const tries = { "ipc-scheme": ["ipc://localhost/app_log", { method: "POST", headers, body }], "ipc-localhost": ["http://ipc.localhost/app_log", { method: "POST", headers, body }] };
      for (const [name, [url, init]] of Object.entries(tries)) {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 5000);
        try {
          await fetch(url, { ...init, cache: "no-store", signal: ac.signal });
          report.fetches[name] = "fetched";
        } catch {
          report.fetches[name] = ac.signal.aborted ? "timeout" : "refused";
        } finally {
          clearTimeout(t);
        }
      }
      // (the own-origin fetch: ownOrigin, as the control worker does it, of the URL the page names)
      report.fetches["own-origin"] = await ownOrigin(String(e.data?.ownUrl ?? ""));
      // (the violation events come asynchronously: a moment for the last ones)
      await new Promise((r) => setTimeout(r, 500));
      report.done = true;
    } catch (err) {
      report.error = String(err?.message ?? err);
    } finally {
      self.removeEventListener("securitypolicyviolation", onViolation);
      port.postMessage(report);
    }
  };
}
