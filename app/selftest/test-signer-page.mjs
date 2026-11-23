// The approvals window's page (app/signer/signer.js) in a VM, with a fake window: the self-test probe's paths, and the
// diagnostic's reports (a refused call reports once; a call that neither answers nor fails within 8 s reports "hung",
// and that is final: a late answer or failure after it reports nothing more and runs no control).
//   node app/selftest/test-signer-page.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../signer/signer.js", import.meta.url), "utf8");
let fails = 0, checks = 0;
const ok = (c, what) => { checks++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Run the page once. `probe`: the self-test's global (or none); `search`: the page's query. Returns its world. */
function page({ probe = { control: null, other: "http://127.0.0.1:9" }, search = "" } = {}) {
  const w = { navigations: [], frames: [], invokes: 0, timers: [], settle: null };
  const status = { textContent: "" };
  let pending;
  const window = {
    __SB_SIGNER_PROBE__: probe ?? undefined,
    __TAURI__: { core: { invoke: () => { w.invokes++; return new Promise((resolve, reject) => { pending = { resolve, reject }; }); } } },
  };
  const location = {
    search, pathname: "/signer/index.html",
    replace: (u) => w.navigations.push(u),
    set href(u) { w.navigations.push(u); },
  };
  const ctx = {
    window, location, console,
    document: { getElementById: () => status, createElement: () => ({}), body: { append: (f) => w.frames.push(f.src) } },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; w.timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
  };
  vm.runInNewContext(SOURCE, Object.assign(ctx, window));
  w.status = status;
  w.resolve = (v) => pending.resolve(v);
  w.reject = (e) => pending.reject(e);
  w.fire = (ms) => { for (const t of w.timers) if (t.ms === ms && !t.cleared) { t.cleared = true; t.fn(); } };
  return w;
}
const flush = () => new Promise((r) => setImmediate(r));

// (no probe: nothing at all; a reloaded page: no call)
{ const w = page({ probe: null }); ok(w.invokes === 0 && w.timers.length === 0 && w.navigations.length === 0, "no probe: the page does nothing"); }
{ const w = page({ search: "?probe=hung" }); ok(w.invokes === 0 && w.navigations.length === 0, "a reloaded page never calls again"); }

// (an answer in time: no report; the timer is cleared; the control runs)
{
  const w = page({ probe: { control: "csp-off", other: "http://127.0.0.1:9" } });
  w.resolve("sig"); await flush();
  w.fire(8000);
  ok(w.invokes === 1 && same(w.navigations, []) && same(w.frames, ["http://127.0.0.1:9/sframe"]), "an answer in time: signed, no report, the control runs, the timer can't fire");
}

// (a failure in time: one report)
{
  const w = page();
  w.reject(new Error("Command signer_probe_sign not allowed by ACL")); await flush();
  w.fire(8000);
  ok(same(w.navigations, ["/signer/index.html?probe=refused-acl"]), "an ACL refusal in time: exactly one report, refused-acl");
}
{ const w = page(); w.reject(new Error("boom")); await flush(); ok(same(w.navigations, ["/signer/index.html?probe=refused"]), "another refusal: refused"); }

// (the races: hung is final)
{
  const w = page();
  w.fire(8000);
  w.reject(new Error("Command signer_probe_sign not allowed by ACL")); await flush();
  ok(same(w.navigations, ["/signer/index.html?probe=hung"]), "a failure after hung reports nothing more");
}
{
  const w = page({ probe: { control: "guard-off", other: "http://127.0.0.1:9" } });
  w.fire(8000);
  w.resolve("sig"); await flush();
  w.fire(1500);
  ok(same(w.navigations, ["/signer/index.html?probe=hung"]) && w.frames.length === 0 && w.status.textContent === "", "an answer after hung runs no control and reports nothing more");
}
{
  const w = page({ probe: { control: "csp-off", other: "http://127.0.0.1:9" } });
  w.fire(8000);
  w.resolve("sig"); await flush();
  ok(w.frames.length === 0, "nor frames the other server");
}

console.log(fails ? `${fails} of ${checks} failed` : `test-signer-page: all ${checks} passed`);
process.exit(fails ? 1 : 0);
