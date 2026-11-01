// First-party active-user counting, the browser side (active-users plan r2 §5, r3 §F/§G, r4, r4b; country r2 adds
// nothing client-side).  Run with bun:   bun web/test-active.mjs            (after bun web/build.ts)
//   ACTIVE_CONTROL=K-25 bun web/test-active.mjs     the tests, then that control only;  =none: the tests only
//
// The origin is the real one: Chromium maps sagebrush.space to a local TLS front (a self-signed certificate, as
// test-dev-sync-tryit.mjs does), which serves either a harness page or the production dist, and a stub /api/active
// that records each request and answers as a case says.  The harness page loads web/active.ts and web/consent.ts
// exactly as they are, bundled by bun with one harness-only entry that exposes signedOut and setMeasure (the page has
// no sign-out of its own yet) — nothing test-only ships: production is checked separately (C-0, C-8).  Each control is
// a fixed text substitution in a copy of those two files (asserted to match once); the copy is bundled and the cases
// run again; the cases that fail must EQUAL the control's closed set.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // web
const DIST = process.env.SITE ?? join(here, "dist");
const ORIGIN = "https://sagebrush.space";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
if (!existsSync(join(DIST, "index.html"))) { console.log("FAIL no built site (bun web/build.ts first)"); process.exit(1); }
const tmp = mkdtempSync(join(tmpdir(), "sb-active-"));

// ---- the harness bundle (base or a control's copy)
const SRC = { A: "active.ts", C: "consent.ts" };
function bundle(subs = [], extra = "") {
  const d = mkdtempSync(join(tmp, "src-"));
  for (const f of Object.values(SRC)) cpSync(join(here, f), join(d, f));
  for (const [k, find, repl] of subs) {
    const p = join(d, SRC[k]), s = readFileSync(p, "utf8"), n = s.split(find).length - 1;
    if (n !== 1) throw new Error(`a substitution in ${SRC[k]} matched ${n} times: ${find.slice(0, 80)}`);
    writeFileSync(p, s.replace(find, () => repl));
  }
  writeFileSync(join(d, "harness.ts"), `import { signedOut } from "./active.ts";\nimport { setMeasure, mayMeasure } from "./consent.ts";\n${extra}\n(globalThis as any).__sbHarness = { signedOut, setMeasure, mayMeasure };\n`);
  const r = spawnSync("bun", ["build", join(d, "harness.ts"), "--target", "browser", "--format", "iife"], { encoding: "utf8", maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error("harness build: " + r.stderr.slice(0, 400));
  return r.stdout;
}

// ---- the stub server's clock and answers
const stub = { skew: 0, requests: [], mode: null, hold: null, holdArrived: null };
// (signedOut's deadline, read from active.ts so the cases' bounds follow it; C-7.hang allows it + 2 s, grader 5a5a2551)
const SIGNOUT_MS = (() => { const m = /SIGNOUT_MS = ([\d_]+);/.exec(readFileSync(join(here, "active.ts"), "utf8")); if (!m) { console.log("FAIL active.ts has no SIGNOUT_MS"); process.exit(2); } return Number(m[1].replace(/_/g, "")); })();
// (the host clock (grader 61bd935a, 51c26387): ONE constant shift of the epoch, not the rate, for every calendar read --
// the stub's clock below, the pins, and every page and worker (INSTRUMENT).  ACTIVE_HOST_AT=<ISO> sets the host's
// effective time at start for the uncounted invariance runs; unset, the shift is 0 and the host clock is real.  Elapsed
// measurements (waits, lags, `took`) keep the real Date.now.)
const PROCESS_T0 = Date.now();
const HOST_SHIFT = process.env.ACTIVE_HOST_AT ? Date.parse(process.env.ACTIVE_HOST_AT) - PROCESS_T0 : 0;
if (Number.isNaN(HOST_SHIFT)) { console.log(`FAIL ACTIVE_HOST_AT is not a date: ${process.env.ACTIVE_HOST_AT}`); process.exit(2); }
const hostNow = () => Date.now() + HOST_SHIFT;
const nowS = () => Math.floor((hostNow() + stub.skew) / 1000);
function durations(t = nowS()) {
  const d = new Date(t * 1000);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  const dow = (d.getUTCDay() + 6) % 7; // Monday 0
  const nextDay = day + 86400, nextWeek = day + (7 - dow) * 86400, nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  return { nd: nextDay - t, nw: nextWeek - t, nm: nextMonth - t };
}
// (the semantic pins: the cases whose expectation encodes a calendar fact get their own fixed effective time (and zone),
// whatever the host clock (astra 861223bc, 1c36fb52; grader 61bd935a).  The stub's clock and the page's both read host
// time + A, A = pin - hostNow() at the case's start, so time still runs and every bounded wait stays real; a case's own
// skews are added to A.  Each pinned case asserts its precondition and reports precondition:<case> otherwise.
//   C-1.tz    Wed 2026-10-14 22:00Z: both test zones' local midnights (Kiritimati 10:00Z, Adak 09:00Z, HDT) lie after
//             that UTC day's midnight, so a local-midnight due() repeats; 2 h before the next UTC midnight
//   C-7.prior Wed 2026-10-14 12:00Z: the next stub day (Thursday) is in the same ISO week and month, so the week flag
//             is checked; 12 h from either midnight
//   C-1s      Wed 2026-10-14 02:00Z, zone UTC: the case loads every 3 h of stub time; a local-midnight due() with the +2 h
//             client skew sends twice in one stub day exactly when a load falls in the 2 h before a stub midnight,
//             i.e. iff (start mod 3 h) is in [1 h, 3 h): the pin's phase is 2 h, asserted in [1 h 5 min, 2 h 55 min]
//   C-1d      Wed 2026-10-14 12:00Z, zone UTC: the case runs at its stub day's 23:59:59 by construction; a local-midnight
//             due() then depends on the browser's zone, pinned to UTC and asserted
// No zone changes its offset near these dates (US DST ends Nov 1).  reset() puts the stub's clock back after the case.)
const PINS = { "C-1.tz": Date.UTC(2026, 9, 14, 22, 0, 0), "C-7.prior": Date.UTC(2026, 9, 14, 12, 0, 0), "C-1s": Date.UTC(2026, 9, 14, 2, 0, 0), "C-1d": Date.UTC(2026, 9, 14, 12, 0, 0) };
const PIN_ZONES = { "C-1s": "UTC", "C-1d": "UTC" };
let pinOverride = null; // (K-PIN alone sets deliberately wrong pins: { pins: {...}, zones: {...} })
const pinOf = (id) => pinOverride?.pins?.[id] ?? PINS[id];
const zoneOf = (id) => pinOverride?.zones?.[id] ?? PIN_ZONES[id];
const anchorAt = (id) => pinOf(id) - hostNow();
let pinnedCase = false; // (set by a pinned case: one()'s midnight precondition is for host-clock cases only)
const iso = (ms) => new Date(ms).toISOString();
const utcMidnight = (ms) => Math.floor(ms / 86400000) * 86400000;
/** the zone's local midnight, as UTC ms, for the local day containing `ms` */
function localMidnight(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return ms - ms % 1000 - (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000;
}
let harnessJs = "";
let pageMode = "harness";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const key = join(tmp, "key.pem"), cert = join(tmp, "cert.pem");
const ssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=sagebrush.space", "-addext", "subjectAltName=DNS:sagebrush.space"], { encoding: "utf8" });
if (ssl.status !== 0) { console.log("FAIL openssl " + ssl.stderr.slice(0, 200)); process.exit(1); }
function serveDist(p) {
  let f = normalize(join(DIST, decodeURIComponent(p)));
  if (!f.startsWith(DIST)) return new Response("no", { status: 403 });
  if (p.endsWith("/")) f = join(f, "index.html");
  if (!existsSync(f) || statSync(f).isDirectory()) return new Response("not found", { status: 404 });
  if (p === "/sw.js") return new Response("not here", { status: 404 });
  return new Response(Bun.file(f), { headers: { "content-type": TYPES[extname(f)] ?? "application/octet-stream" } });
}
const front = Bun.serve({
  port: 0, hostname: "127.0.0.1", tls: { cert: Bun.file(cert), key: Bun.file(key) },
  async fetch(req) {
    const u = new URL(req.url), p = u.pathname;
    if (p === "/api/active") {
      const body = await req.text();
      const rec = { method: req.method, body, headers: Object.fromEntries(req.headers), at: nowS(), url: req.url };
      stub.requests.push(rec);
      if (stub.hold) { const h = stub.hold; stub.holdArrived?.(); await h; }
      const m = stub.mode ?? { status: 200, as: "b" };
      if (m.network) return new Response(null, { status: 599 });
      if (m.status !== 200) return new Response("no", { status: m.status });
      if (m.raw) return new Response(m.raw, { status: 200, headers: { "content-type": "application/json" } });
      const t = m.sampleAt ?? nowS();
      return Response.json({ as: m.as ?? "b", ...durations(t) });
    }
    if (pageMode === "harness") {
      if (p === "/" || p === "/index.html") return new Response(`<!doctype html><meta charset="utf-8"><title>active harness</title><script src="/active-harness.js"></script>`, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (p === "/active-harness.js") return new Response(harnessJs, { headers: { "content-type": "text/javascript" } });
      return new Response("not found", { status: 404 });
    }
    return serveDist(p);
  },
});
// (the same production dist from an origin that isn't listed: C-8.origin)
const plain = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { const p = new URL(req.url).pathname; if (p === "/api/active") { stub.requests.push({ body: "", headers: {}, at: nowS(), unlisted: true }); return new Response("no", { status: 404 }); } return serveDist(p); } });

// ---- the browser: its own Chrome, sagebrush.space mapped to the front; instrumented before any page script
const INSTRUMENT = `(() => {
  const c = window.__c = { get: {}, set: {}, rm: {}, locks: 0, lockNames: [], fetch: 0, timers: 0, idle: [], released: false, before: null };
  const K = (k) => typeof k === "string" && (k === "sb-active" || k === "sb-active-b" || k === "sb-consent");
  const S = Storage.prototype, g = S.getItem, s = S.setItem, r = S.removeItem;
  S.getItem = function (k) { if (K(k)) { c.get[k] = (c.get[k] ?? 0) + 1; if (window.__throwGet) throw new Error("blocked"); } return g.call(this, k); };
  S.setItem = function (k, v) { if (K(k)) { c.set[k] = (c.set[k] ?? 0) + 1; if (window.__throwSet) throw new Error("blocked"); } return s.call(this, k, v); };
  S.removeItem = function (k) { if (K(k)) c.rm[k] = (c.rm[k] ?? 0) + 1; return r.call(this, k); };
  const realNow = Date.now.bind(Date);
  // (c.clock: the skew each of the page's first 32 clock reads used: C-1j's diagnostics; no case asserts on it)
  c.clock = [];
  // (the host shift, one constant for the whole run (0 unless ACTIVE_HOST_AT), then a case's skew)
  Date.now = () => { const s = window.__skew ?? 0; if (c.clock.length < 32) c.clock.push(s); return realNow() + ${HOST_SHIFT} + s; };
  // (workers read the same shifted clock: a classic or module worker gets a prelude that shifts its Date.now alike)
  if (window.Worker) {
    const W = window.Worker;
    window.Worker = function (url, opts) {
      const u = new URL(url, location.href).href, sh = "const __n = Date.now.bind(Date); Date.now = () => __n() + ${HOST_SHIFT} + " + (window.__skew ?? 0) + ";";
      const src = opts && opts.type === "module" ? sh + "await import(" + JSON.stringify(u) + ");" : sh + "importScripts(" + JSON.stringify(u) + ");";
      return new W(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), opts);
    };
  }
  if (navigator.locks) {
    const req = navigator.locks.request.bind(navigator.locks);
    navigator.locks.request = function (name, ...a) { c.locks++; c.lockNames.push(name); if (window.__lockReject) return Promise.reject(new Error("locks refused")); return req(name, ...a); };
  }
  if (window.__noLocks) Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
  // (IndexedDB: every page call counted in c.idb; window.__idb* switches inject faults; __orig is the harness's own,
  // uncounted path to the store)
  c.idb = {}; c.rw = 0;
  const n = (k) => (c.idb[k] = (c.idb[k] ?? 0) + 1);
  const F = IDBFactory.prototype, D = IDBDatabase.prototype, OS = IDBObjectStore.prototype;
  const o = window.__orig = { open: F.open, tx: D.transaction, close: D.close, get: OS.get, put: OS.put, del: OS.delete, clear: OS.clear };
  let opens = 0;
  const fake = () => ({ result: undefined, error: null });
  F.open = function (name, ...a) {
    if (name !== "sb-active") return o.open.call(this, name, ...a);
    n("open"); opens++;
    const f = window.__idbOpen, nth = window.__idbOpenFrom ?? 1;
    if (!f || opens < nth) return o.open.call(this, name, ...a);
    const r = fake();
    if (f === "error") setTimeout(() => r.onerror?.({}), 0);
    else if (f === "blocked") setTimeout(() => r.onblocked?.({}), 0);
    else if (f === "delay" || f === "late") setTimeout(() => { const q = o.open.call(this, name, ...a); q.onupgradeneeded = (e) => { r.result = q.result; r.onupgradeneeded?.(e); }; q.onsuccess = (e) => { r.result = q.result; r.onsuccess?.(e); }; q.onerror = (e) => r.onerror?.(e); }, f === "delay" ? (window.__idbOpenMs ?? 1500) : 7000);
    // ("hang": never settles)
    return r;
  };
  D.close = function () { if (this.name === "sb-active" && !this.__harness) n("close"); return o.close.call(this); };
  D.transaction = function (store, mode, ...a) {
    const tx = o.tx.call(this, store, mode, ...a);
    if (this.name !== "sb-active" || this.__harness) return tx;
    n("tx:" + (mode ?? "readonly"));
    if (window.__idbTxFail === (mode ?? "readonly")) setTimeout(() => { try { tx.abort(); } catch {} }, 0);
    if (mode === "readwrite") {
      c.rw++;
      const h = window.__idbHold;
      // (held: the transaction kept alive by a get from each get's success, until released or forever)
      if (h && (h.nth === undefined || h.nth === c.rw)) {
        window.__idbHeld = true; const st = tx.objectStore(store);
        const loop = () => { if (window.__idbHold === h && !h.released) { const q = o.get.call(st, "__hold"); q.onsuccess = loop; } else window.__idbHeld = false; };
        loop();
      }
    }
    return tx;
  };
  window.__idbRelease = () => { if (window.__idbHold) window.__idbHold.released = true; };
  const wrap = (m, f) => function (...a) {
    if (this.transaction?.db?.__harness) return f.apply(this, a);
    const key = m === "put" ? a[1] : a[0];
    if (key !== "__hold") n(m + (key === undefined ? "" : ":" + key));
    if (window.__idbPutFail && m === "put") { try { this.transaction.abort(); } catch {} }
    if (window.__idbClearFail && m === "clear") { try { this.transaction.abort(); } catch {} }
    return f.apply(this, a);
  };
  OS.get = wrap("get", o.get); OS.put = wrap("put", o.put); OS.delete = wrap("delete", o.del); OS.clear = wrap("clear", o.clear);
  // (the harness's own access: an uncounted connection, flagged so no wrapper counts or faults it)
  window.__notes = (fn) => new Promise((res) => { const r = o.open.call(indexedDB, "sb-active", 1); r.onupgradeneeded = () => r.result.createObjectStore("notes"); r.onerror = () => res({ err: true }); r.onsuccess = () => { const db = r.result; db.__harness = true; const tx = o.tx.call(db, "notes", "readwrite"); const st = tx.objectStore("notes"); const out = fn(st); tx.oncomplete = () => { o.close.call(db); res(out()); }; tx.onabort = () => { o.close.call(db); res({ err: true }); }; }; });
  const f = window.fetch.bind(window);
  window.fetch = (u, init) => { if (String(u).endsWith("/api/active")) c.fetch++; return f(u, init); };
  const st = window.setTimeout.bind(window);
  c.t5 = { set: 0, fired: 0 };
  window.setTimeout = (fn, ms, ...a) => { if (!c.released && ms === 10000) c.timers++; if (ms === 5000) { c.t5.set++; return st((...b) => { c.t5.fired++; return fn(...b); }, ms, ...a); } return st(fn, ms, ...a); };
  window.requestIdleCallback = (cb) => { c.idle.push(cb); return c.idle.length; };
  window.__releaseIdle = () => { c.before = JSON.parse(JSON.stringify({ get: c.get, set: c.set, rm: c.rm, locks: c.locks, fetch: c.fetch, idb: c.idb })); c.released = true; for (const cb of c.idle.splice(0)) cb({ didTimeout: false, timeRemaining: () => 50 }); };
})();`;
const browsers = new Set();
/** every case runs to its end or fails as "threw" (its message shown): the browsers it started are stopped either way */
async function guarded(f) {
  try { await f(); } catch (e) { c("threw", false, String(e?.stack ?? e).slice(0, 600)); }
  finally { await stopAll("cleanup"); }
}
/** stops every browser still running; a stop that throws (a profile's removal, say) is recorded as `id` failing, with
 * its message, and the rest are still stopped: a cleanup can never end the roster (astra 88686cad) */
async function stopAll(id) {
  for (const b of [...browsers]) {
    try { await b.stop(); } catch (e) { c(id, false, `stopping a browser: ${String(e?.stack ?? e).slice(0, 400)}`); browsers.delete(b); }
  }
}
/** one case, or one iteration of a looped one: a throw records "threw:<id>" (its message shown) and the next case still
 * runs (grader 6f728d4a B1: one throw had ended every later case); its browsers are stopped (a failed stop records
 * "cleanup:<id>") and the stub and the page mode put back, in finally, either way */
async function one(id, f) {
  const day0 = utcMidnight(hostNow()); pinnedCase = false;
  try { await f(); } catch (e) { c(`threw:${id}`, false, String(e?.stack ?? e).slice(0, 1500)); }
  finally {
    // (a host-clock case must not straddle a UTC midnight of the host clock: that would make its "same day" loads
    // different days; an explicit precondition instead of a silently different set.  Pinned cases carry their own.)
    if (!pinnedCase && utcMidnight(hostNow()) !== day0) c("precondition:midnight", false, `${id} straddled the host clock's UTC midnight ${iso(utcMidnight(hostNow()))}`);
    await stopAll(`cleanup:${id}`);
    reset(); pageMode = "harness"; pinnedCase = false;
  }
}
class Browser {
  constructor(flags = "") { this.flags = flags; this.errors = []; }
  async start() {
    browsers.add(this);
    this.profile = mkdtempSync(join(tmp, "chrome-"));
    this.proc = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${this.profile}`, `--host-resolver-rules=MAP sagebrush.space 127.0.0.1:${front.port}`, "--ignore-certificate-errors",
      // (no OS keyring: where a D-Bus session bus exists without one, Chrome's first run otherwise waits out D-Bus's 25 s
      // timeout before the first page loads (Chrome 155, VM2); found with a minimal repro, auth-msgs/c155-repro.mjs)
      "--password-store=basic", "about:blank"], { stdio: ["ignore", "ignore", "pipe"],
      // (the browser's default zone is UTC whatever the host's (grader fca8000e 2): K-31's local midnight follows it;
      // the zone-pinned cases set their own per tab; asserted in the host-time case as precondition:host-zone)
      env: { ...process.env, TZ: "UTC" } });
    this.port = await new Promise((ok, no) => { let b = ""; const t = setTimeout(() => no(new Error("no DevTools")), 30000); this.proc.stderr.on("data", (d) => { b += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(b); if (m) { clearTimeout(t); ok(Number(m[1])); } }); });
    let ts; for (let i = 0; i < 300 && !ts; i++) { try { ts = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json(); } catch { await sleep(100); } }
    this.first = ts.find((t) => t.type === "page");
  }
  async tab(pre = "") {
    const t = this.first ? this.first : await (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: "PUT" })).json();
    this.first = null;
    const tab = new Tab(t, this);
    await tab.attach(pre);
    return tab;
  }
  /** the renderer processes (SystemInfo, on the browser's own DevTools connection) */
  async procs() {
    if (!this.bws) {
      const v = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json();
      this.bws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => (this.bws.onopen = r));
      this.bn = 0; this.bwait = new Map();
      this.bws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.bwait.has(m.id)) { this.bwait.get(m.id)(m.result ?? m.error); this.bwait.delete(m.id); } };
    }
    const r = await new Promise((res) => { const id = ++this.bn; this.bwait.set(id, res); this.bws.send(J({ id, method: "SystemInfo.getProcessInfo" })); });
    return (r.processInfo ?? []).filter((x) => x.type === "renderer");
  }
  /** a tab's renderer pid: the renderer whose CPU time grows most over a 150 ms busy loop in that tab */
  async pidOf(tab) {
    const a = await this.procs();
    await tab.ev("(() => { const z = performance.now(); while (performance.now() - z < 150); return 1; })()");
    const b = await this.procs();
    let best = null, d = -1;
    for (const x of b) { const dd = x.cpuTime - (a.find((y) => y.id === x.id)?.cpuTime ?? 0); if (dd > d) { d = dd; best = x.id; } }
    return best;
  }
  async stop() { browsers.delete(this); try { this.bws?.close(); } catch {} try { this.proc.kill("SIGKILL"); } catch {} await sleep(200); rmSync(this.profile, { recursive: true, force: true }); }
}
class Tab {
  constructor(t, b) { this.t = t; this.b = b; this.n = 0; this.waiting = new Map(); this.errors = []; }
  async attach(pre) {
    this.ws = new WebSocket(this.t.webSocketDebuggerUrl);
    await new Promise((r) => (this.ws.onopen = r));
    // (the main frame's navigations, kept for diagnostics (grader 61bd935a item 5): each failed ev() reports them)
    // (and the main frame's committed loaders: open() accepts only the document of the loader its own navigate returned)
    this.navs = []; this.loaders = new Set(); this.mainLoader = null; const t0 = Date.now(), nav = (what) => { this.navs.push(`+${Date.now() - t0}ms ${what}`); if (this.navs.length > 40) this.navs.shift(); };
    // (a protocol error rejects the call, with its method and the whole error (astra e6fb3af4 1); before, it resolved as
    // though it were a result)
    this.ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.waiting.has(m.id)) { const w = this.waiting.get(m.id); this.waiting.delete(m.id); if (m.error) w.no(new Error(`DevTools ${w.method}: protocol error ${J(m.error)}`)); else w.ok(m.result); } if (m.method === "Runtime.exceptionThrown") this.errors.push(m.params.exceptionDetails?.exception?.description?.slice(0, 200) ?? "exception");
      const p = m.params ?? {};
      if (m.method === "Page.frameNavigated" && !p.frame?.parentId) { this.loaders.add(p.frame?.loaderId); this.mainLoader = p.frame?.loaderId; nav(`navigated ${p.frame?.url} loader ${p.frame?.loaderId} origin ${p.frame?.securityOrigin}`); }
      else if (m.method === "Page.navigatedWithinDocument") nav(`within-document ${p.url}`);
      else if (m.method === "Page.frameStartedLoading") nav("started loading");
      else if (m.method === "Page.frameStoppedLoading") nav("stopped loading");
      else if (m.method === "Inspector.targetCrashed") nav("RENDERER CRASHED");
      else if (m.method === "Inspector.detached") nav(`detached ${p.reason}`); };
    for (const m of ["Page.enable", "Runtime.enable", "Inspector.enable"]) await this.send(m);
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: pre + INSTRUMENT });
  }
  /** where the tab is, for a failure message: href, origin, readyState, and the main frame's recent navigations */
  // (bounded: 3 s, so a gone target still yields the navigation log)
  async where() {
    const r = await Promise.race([this.send("Runtime.evaluate", { expression: "JSON.stringify({ href: location.href, origin: location.origin, readyState: document.readyState })", returnByValue: true }), sleep(3000).then(() => { throw new Error("no answer in 3 s"); })]).catch((e) => ({ result: { value: `unreadable: ${e.message}` } }));
    return `at ${r?.result?.value ?? J(r?.exceptionDetails ?? r)}; main loader ${this.mainLoader}; navigations ${J(this.navs.slice(-12))}`;
  }
  // (every DevTools call bounded: a stuck case fails with its name instead of hanging the run)
  send(method, params = {}) { return new Promise((r, no) => { const id = ++this.n; const to = setTimeout(() => { this.waiting.delete(id); no(new Error(`DevTools ${method}: no answer in 30 s`)); }, 30000); this.waiting.set(id, { method, ok: (v) => { clearTimeout(to); r(v); }, no: (e) => { clearTimeout(to); no(e); } }); this.ws.send(J({ id, method, params })); }); }
  // (quiet: a poll (until, open) whose failures are expected and swallowed gets no diagnostics, so it adds no evaluate)
  // A non-poll failure -- an exception in the page, a protocol error, a transport error or a timeout -- is printed whole,
  // with where(), as one "(diag)" line in the log (astra e6fb3af4 2), and rethrown with the same text.
  async ev(expression, quiet = false) {
    let r;
    try { r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); }
    catch (e) { if (quiet) throw e; throw await this.diag(`${e.message} (evaluating ${expression.slice(0, 120)})`); }
    if (r.exceptionDetails) { if (quiet) throw new Error(J(r.exceptionDetails).slice(0, 300)); throw await this.diag(`${J(r.exceptionDetails)} (evaluating ${expression.slice(0, 120)})`); }
    return r.result?.value;
  }
  async diag(what) { const m = `${what}; ${await this.where()}`; console.log(`  (diag) ev failure: ${m}`); return new Error(m); }
  // (loaded: the navigation committed (no error) and the document is of the target's origin -- the initial about:blank,
  // which carries the instrument too, no longer passes (grader 61bd935a item 5) -- the instrument ran and the
  // document's scripts too, so a harness page's __sbHarness exists)
  // (and the main frame committed THIS navigation's loader and is still on it: a previous same-origin document no
  // longer passes either (astra e6fb3af4 1))
  async open(url = ORIGIN + "/") {
    const r = await this.send("Page.navigate", { url }).catch(async (e) => { throw await this.diag(`navigation to ${url}: ${e.message}`); });
    if (r?.errorText) throw await this.diag(`navigation to ${url} failed: ${r.errorText}`);
    if (!r?.loaderId) throw await this.diag(`navigation to ${url} returned no loader: ${J(r)}`);
    const origin = J(new URL(url).origin);
    for (let i = 0; i < 200; i++) { if (this.loaders.has(r.loaderId) && this.mainLoader === r.loaderId && await this.ev(`location.origin === ${origin} && !!window.__c && document.readyState === 'complete'`, true).catch(() => false)) return; await sleep(50); }
    throw await this.diag(`page didn't load: ${url} (loader ${r.loaderId})`);
  }
  async until(expr, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (await this.ev(expr, true).catch(() => false)) return true; await sleep(50); } return false; }
  // (the notes, read on the harness's own uncounted connection; null when absent, else their JSON)
  state() { return this.ev(`window.__notes((st) => { const ga = window.__orig.get.call(st, "a"), gb = window.__orig.get.call(st, "b"); return () => ({ a: ga.result === undefined ? null : JSON.stringify(ga.result), b: gb.result === undefined ? null : JSON.stringify(gb.result), consent: localStorage.getItem("sb-consent") }); })`); }
  /** writes the notes given (a value, or undefined to leave it), on the harness's own connection */
  seed(v) { return this.ev(`window.__notes((st) => { const v = ${J(v)}; for (const k of ["a", "b"]) if (k in v) { if (v[k] === null) window.__orig.del.call(st, k); else window.__orig.put.call(st, v[k], k); } return () => 1; })`); }
  wipe() { return this.ev(`window.__notes((st) => { window.__orig.clear.call(st); return () => 1; })`); }
  counts() { return this.ev("JSON.parse(JSON.stringify(window.__c))"); }
  async close() { try { this.ws.close(); } catch {} }
}

// (in-page: whether this tab holds or waits on the count lock)
const LOCK_FREE = `navigator.locks.query().then((q) => !q.held.some((h) => h.name === "sb-active") && !q.pending.some((h) => h.name === "sb-active"))`;
const sees = (v) => `localStorage.getItem("sb-consent") === ${J(v)}`;
const putsAB = (k) => (k.idb["put:a"] ?? 0) + (k.idb["put:b"] ?? 0);
const getsAB = (k) => (k.idb["get:a"] ?? 0) + (k.idb["get:b"] ?? 0);
const txs = (k) => (k.idb["tx:readonly"] ?? 0) + (k.idb["tx:readwrite"] ?? 0);

// ---- results
const results = new Map();
const c = (id, ok, what) => { if (process.env.TRACE) console.log(`  ${ok ? "ok" : "FAIL"} ${id} (${new Date().toISOString().slice(11, 19)})${ok ? "" : ": " + what}`); if (!results.has(id)) results.set(id, true); if (!ok) { results.set(id, false); if (process.env.SHOW_FAILS) console.log(`  fail ${id}: ${what}`); } };
const reset = () => { stub.requests.length = 0; stub.mode = null; stub.hold = null; stub.skew = 0; };
const posts = () => stub.requests.filter((r) => !r.unlisted);
/** the held POST's arrival, bounded (60 s: a hang guard only, never a measured bound; it covers the tabs' opening,
 * which a loaded host or a first run can make slow) */
// (marked handled: a case that throws before awaiting it leaves no unhandled rejection 60 s later)
// (its timeout says how far the case got (grader 5a5a2551 2): the POSTs and requests so far, the stages the caller
// recorded in `stage.opened`, each tab's page errors, and the time waited -- text only)
const heldArrival = (stage = {}) => { const t0 = Date.now(); const p = Promise.race([new Promise((r) => (stub.holdArrived = r)), sleep(60000).then(() => { throw new Error(`the held POST never arrived (${Date.now() - t0} ms): ${posts().length} posts, ${stub.requests.length} requests so far; stages ${J(stage.opened ?? [])}; tab errors ${J((stage.tabs ?? []).map((x) => x.errors))}`); })]); p.catch(() => {}); return p; };
const DAY = 86400;
async function fresh(pre = "") { const b = new Browser(); await b.start(); const t = await b.tab(pre); return { b, t }; }
/** the pin took effect: the page's clock reads host time + `skew` (within 2 s); `what` is for the message */
async function pageClock(t, skew) {
  const want = hostNow() + skew, got = await t.ev("Date.now()").catch(() => null);
  const ok = typeof got === "number" && Math.abs(got - want) < 2000;
  return { ok, what: got == null ? "unreadable" : `${iso(got)} (wanted ${iso(want)})` };
}
/** a page load with idle held, then released; waits for its ping (or for quiet) */
// (the page's run has ended: every IndexedDB connection it opened is closed, run()'s and removeNotes()' alike)
const RUN_ENDED = `(() => { const i = window.__c.idb; return (i.open ?? 0) >= 1 && (i.close ?? 0) >= (i.open ?? 0); })()`;
async function load(t, { skew = 0, before = "", wait = 5000 } = {}) {
  await t.open();
  if (skew) await t.ev(`window.__skew = ${skew}`);
  if (before) await t.ev(before);
  const n = posts().length;
  await t.ev("window.__releaseIdle()");
  // (until a POST arrives or the run has ended, at most `wait`: not a fixed pause, which a loaded host outran)
  const until = Date.now() + wait;
  while (Date.now() < until && posts().length === n) { if (await t.ev(RUN_ENDED, true).catch(() => false)) break; await sleep(25); }
  // (a POST arrived: wait until the page is done with it, its lock released and the answer persisted, before
  // anything navigates; a fixed pause lost the persist on a loaded machine)
  if (posts().length > n) await t.until(`navigator.locks.query().then((q) => !q.held.some((h) => h.name === "sb-active") && !q.pending.some((h) => h.name === "sb-active"))`, 5000);
  await sleep(150);
}

// C-3, as a function: ONLY=C-3 runs it alone, REPEAT times (a stress probe; not part of the suite's verdict)
async function caseC3() {
  const r = await c3Once();
  c("C-3", r.waiting && r.posts === 1, J(r));
}
/** the C-3 interleaving once, on a fresh profile: tab 1's answer held until tab 2 waits on the lock, then released */
async function c3Once(pids = false) {
  { reset(); const { b, t } = await fresh(); const t2 = await b.tab();
    let release; stub.hold = new Promise((r) => (release = r)); const stage = { tabs: [t, t2], opened: [] }; const arrived = heldArrival(stage);
    await t.open(); stage.opened.push("t opened"); await t2.open(); stage.opened.push("t2 opened");
    await t.ev("window.__releaseIdle()"); stage.opened.push("t released"); await arrived; const heldFrom = Date.now();
    await t2.ev("window.__releaseIdle()");
    const waiting = await t2.until(`navigator.locks.query().then((q) => q.pending.some((p) => p.name === "sb-active"))`, 5000);
    const heldMs = Date.now() - heldFrom;
    stub.hold = null; release(); await sleep(1000);
    await t2.until(LOCK_FREE, 12000);
    const out = { waiting, posts: posts().length, heldMs, bodies: posts().map((p) => p.body), tab1: await t.state(), tab2: await t2.state(), errors: [...t.errors, ...t2.errors] };
    if (pids) { out.pid1 = await b.pidOf(t); out.pid2 = await b.pidOf(t2); out.gap1 = await t.ev("window.__lsGap ?? null"); out.gap2 = await t2.ev("window.__lsGap ?? null"); }
    await b.stop();
    return out; }
}

// ---- the cases
async function cases() {
  if (process.env.ONLY === "C-3") { for (let i = 0; i < Number(process.env.REPEAT ?? 20); i++) await caseC3(); return; }
  // (the host clock took effect (grader 51c26387): the harness, a page and a worker each read it, logged; with
  // ACTIVE_HOST_AT, all three within 2 s of it plus the elapsed time; without, all three within 2 s of each other)
  await one("host-time", async () => { reset(); const { b, t } = await fresh();
    await t.open();
    const h = hostNow(), pageT = await t.ev("Date.now()");
    const workerT = await t.ev(`new Promise((ok, no) => { const w = new Worker(URL.createObjectURL(new Blob(["postMessage(Date.now())"], { type: "text/javascript" }))); w.onmessage = (e) => { ok(e.data); w.terminate(); }; w.onerror = (e) => no(new Error("worker: " + e.message)); setTimeout(() => no(new Error("worker: no answer")), 5000); })`);
    const want = process.env.ACTIVE_HOST_AT ? Date.parse(process.env.ACTIVE_HOST_AT) + (Date.now() - PROCESS_T0) : h;
    const ok = [h, pageT, workerT].every((x) => typeof x === "number" && Math.abs(x - want) < 2000);
    const zone = await t.ev("Intl.DateTimeFormat().resolvedOptions().timeZone"), offset = await t.ev("new Date(Date.now()).getTimezoneOffset()");
    console.log(`  (info) host clock: ACTIVE_HOST_AT ${process.env.ACTIVE_HOST_AT ?? "(unset: real)"}; harness ${iso(h)}, page ${iso(pageT)}, worker ${iso(workerT)}; page zone ${zone} (offset ${offset} min)`);
    if (!ok) c("precondition:host-time", false, `the host clock did not take effect alike: harness ${iso(h)}, page ${iso(pageT)}, worker ${iso(workerT)}, wanted ${iso(want)}`);
    if (!((zone === "UTC" || zone === "Etc/UTC") && offset === 0)) c("precondition:host-zone", false, `the browser's default zone is ${zone} (offset ${offset} min), not UTC`);
    await b.stop(); });
  // C-1: due once a day; the next day by the server's durations; week and month flags; time zones change nothing
  await one("C-1", async () => { reset(); const { b, t } = await fresh();
    await load(t);
    const p1 = posts()[0], s1 = await t.state();
    c("C-1.first", posts().length === 1 && p1?.body === '{"v":1,"day":1,"week":1,"month":1,"client":"web"}' && !!JSON.parse(s1.b ?? "null")?.bd, `first: ${J(posts().map((p) => p.body))} ${J(s1)}`);
    await load(t);
    c("C-1.same", posts().length === 1, `a reload sent ${posts().length - 1} more`);
    const d = durations();
    await load(t, { skew: (d.nd + 5) * 1000 });
    const p3 = posts()[1];
    const sameWeek = d.nw > d.nd + 5, sameMonth = d.nm > d.nd + 5;
    c("C-1.next", posts().length === 2 && JSON.parse(p3?.body ?? "{}").week === (sameWeek ? 0 : 1) && JSON.parse(p3?.body ?? "{}").month === (sameMonth ? 0 : 1), `next day: ${J(posts().map((p) => p.body))}`);
    await b.stop(); });
  // (C-1.tz at the calendar anchor (astra 861223bc): the repeated load is after both zones' local midnight relative to
  // the stored UTC boundary, asserted, so a local-midnight due() repeats whatever the real time of day)
  for (const tz of ["Pacific/Kiritimati", "America/Adak"]) await one(`C-1.tz:${tz}`, async () => {
    reset(); const { b, t } = await fresh();
    pinnedCase = true;
    await t.send("Emulation.setTimezoneOverride", { timezoneId: tz });
    const A = anchorAt("C-1.tz"); stub.skew = A;
    await load(t, { skew: A }); const pg = await pageClock(t, A);
    await load(t, { skew: A });
    const e2 = hostNow() + A, u = utcMidnight(e2), lm = localMidnight(e2, tz), pre = lm > u && pg.ok;
    const d = durations();
    await load(t, { skew: A + (d.nd + 5) * 1000 });
    const cal = `effective ${iso(e2)}, UTC midnight ${iso(u)}, local midnight ${iso(lm)}; page clock ${pg.what}; d ${J(d)}`;
    // (an unmet calendar precondition is reported as such, and the case's own assertion is not made: grader 69f2f06c)
    if (!pre) c("precondition:C-1.tz", false, `${tz}: ${pg.ok ? "the local midnight is not after the UTC midnight" : "the pin did not take effect in the page"} (${cal})`);
    else c("C-1.tz", posts().length === 2, `${tz}: ${posts().length} posts (${cal})`);
    await b.stop();
  });
  // C-1s: a skewed client clock: one POST per stub day, the week flag exactly on the stub's Monday
  // (at its pin: the stub starts at a 2 h phase of its 3 h steps, in zone UTC; both asserted (see PINS))
  for (const skewMs of [2 * 3600_000, -DAY * 1000]) await one(`C-1s:${skewMs}`, async () => {
    pinnedCase = true;
    reset(); const { b, t } = await fresh();
    const zone = zoneOf("C-1s"); await t.send("Emulation.setTimezoneOverride", { timezoneId: zone });
    const A = anchorAt("C-1s"); stub.skew = A;
    const s0 = hostNow() + A, phase = s0 % (3 * 3600_000), d0 = durations();
    const perDay = new Map(); let pg = null, pz = null;
    for (let h = 0; h < 72; h += 3) {
      stub.skew = A + h * 3600_000;
      await load(t, { skew: skewMs + stub.skew, wait: 700 });
      if (h === 0) { pg = await pageClock(t, skewMs + stub.skew); pz = await t.ev("Intl.DateTimeFormat().resolvedOptions().timeZone"); }
    }
    for (const p of posts()) { const day = Math.floor(p.at / DAY); perDay.set(day, (perDay.get(day) ?? 0) + 1); }
    const cal = `stub start ${iso(s0)}, phase ${(phase / 60000).toFixed(1)} min of 180, page zone ${pz}, page clock ${pg?.what}; d0 ${J(d0)}`;
    const pre = phase >= 65 * 60000 && phase <= 175 * 60000 && pz === "UTC" && pg?.ok;
    if (!pre) c("precondition:C-1s", false, `skew ${skewMs}: the pin did not hold (${cal})`);
    else c("C-1s", [...perDay.values()].every((n) => n === 1) && perDay.size >= 3, `skew ${skewMs}: per stub day ${J([...perDay])} (${cal})`);
    await b.stop();
  });
  // C-1d: an answer sampled at 23:59:59 held 3 s: bd ≈ arrival + 1 s; a load 0.5 s after the arrival sends nothing, 1.5 s after one POST
  // (at its pin: zone UTC, asserted (see PINS); the 23:59:59 is of the pinned stub day)
  await one("C-1d", async () => { pinnedCase = true; reset(); const { b, t } = await fresh();
    const zone = zoneOf("C-1d"); await t.send("Emulation.setTimezoneOverride", { timezoneId: zone });
    const A = anchorAt("C-1d"); stub.skew = A;
    const d = durations(); stub.skew = A + (d.nd - 1) * 1000; // stub time 23:59:59
    stub.mode = { status: 200, as: "b", sampleAt: nowS() };
    let release; stub.hold = new Promise((r) => (release = r));
    const arrived = heldArrival();
    await t.open(); await t.ev(`window.__skew = ${stub.skew}`);
    const pg = await pageClock(t, stub.skew), pz = await t.ev("Intl.DateTimeFormat().resolvedOptions().timeZone");
    if (!(pz === "UTC" && pg.ok)) { c("precondition:C-1d", false, `the pin did not hold: page zone ${pz}, page clock ${pg.what}`); release(); await b.stop(); return; }
    await t.ev("window.__releaseIdle()");
    await arrived; await sleep(3000); stub.hold = null; release();
    await sleep(300);
    const arrival = hostNow() + stub.skew;
    const st = JSON.parse((await t.state()).b ?? "{}");
    stub.mode = null;
    const n = posts().length;
    await sleep(200); await load(t, { skew: stub.skew + 0, wait: 600 }); // ≈ arrival + 0.5 s
    const quiet = posts().length === n;
    await sleep(1200); await load(t, { skew: stub.skew, wait: 1500 });
    c("C-1d", Math.abs(st.bd - (arrival + 1000)) < 500 && quiet && posts().length === n + 1, `bd ${st.bd - arrival} ms after arrival; quiet ${quiet}; posts ${posts().length - n}`);
    await b.stop(); });
  // C-1j: a forward clock jump past bd on the same server day: one more POST (the disclosed duplicate).  Its failure
  // message carries the POSTs (body, the stub's `at`), each load's notes and the skews the page's clock reads used
  // (grader 6f728d4a C: a failure under K-43, which can't reach it, is to be explained, not re-run)
  await one("C-1j", async () => { reset(); const { b, t } = await fresh();
    await load(t); const s1 = await t.state(), k1 = await t.counts();
    await load(t, { skew: 25 * 3600_000 }); const s2 = await t.state(), k2 = await t.counts();
    c("C-1j", posts().length === 2, `${posts().length} posts ${J(posts().map((p) => ({ body: p.body, at: p.at })))}; load 1 ${J(s1)} clock skews ${J(k1.clock)}; load 2 ${J(s2)} clock skews ${J(k2.clock)}; stub skew ${stub.skew}`);
    await b.stop(); });
  // C-1.gpc: Global Privacy Control on: nothing sent, nothing written
  await one("C-1.gpc", async () => { reset(); const { b, t } = await fresh(`Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true, configurable: true });`);
    await load(t);
    const s = await t.state(), k = await t.counts();
    c("C-1.gpc", posts().length === 0 && s.a === null && s.b === null && putsAB(k) === 0, `gpc: ${posts().length} posts, ${J(s)} ${J(k.idb)}`);
    await b.stop(); });
  // C-2: only consent.ts (and the bundle that holds it) contains a measurement path
  await one("C-2", async () => { const hits = [];
    // (the sources git knows, tracked or new; build output such as dist/ and site/public/ is ignored)
    const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "."], { cwd: here, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    for (const f of listed) { const p = join(here, f); if (/\.(ts|js|mjs|html)$/.test(f) && !/(^|\/)test-[^/]*$/.test(f) && existsSync(p) && readFileSync(p, "utf8").includes("/api/active")) hits.push(relative(here, p)); }
    const distHits = [];
    const walkDist = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walkDist(p); else if (/\.(js|html)$/.test(f) && readFileSync(p, "utf8").includes("/api/active")) distHits.push(relative(DIST, p)); } };
    walkDist(DIST);
    c("C-2", hits.join() === "consent.ts" && distHits.join() === "index.html", `sources ${J(hits)}, dist ${J(distHits)}`); });
  // C-2a: consent "no": one consent read, the notes removed, no lock, timer or fetch after it
  await one("C-2a", async () => { reset(); const { b, t } = await fresh();
    await t.open(); await t.seed({ a: { p: "b", ad: 0 }, b: { bd: 1, bw: 1, bm: 1 } }); await t.ev(`localStorage.setItem("sb-consent", "no")`);
    await load(t);
    await t.until(`window.__notes((st) => { const g = window.__orig.get.call(st, "b"); return () => g.result === undefined; })`, 6000);
    const k = await t.counts(), s = await t.state();
    c("C-2a", posts().length === 0 && k.locks === 0 && s.a === null && s.b === null && (k.get["sb-consent"] ?? 0) - (k.before.get["sb-consent"] ?? 0) === 1 && getsAB(k) === 0 && (k.idb.clear ?? 0) === 1, `off: ${J(k)} ${J(s)}`);
    await t.ev(`localStorage.setItem("sb-consent", "yes")`); await t.seed({ b: { bd: 1, bw: 1, bm: 1 } }); await t.ev("__sbHarness.setMeasure(false)");
    c("C-2a", await t.until(`window.__notes((st) => { const g = window.__orig.get.call(st, "b"); return () => g.result === undefined; })`, 6000), "setMeasure(false) removes the note");
    await b.stop(); });
  // C-2c.lock: tab 2 waits on the lock while tab 1's request is held; tab 1 withdraws; tab 2 sends nothing
  await one("C-2c.lock", async () => { reset(); const { b, t } = await fresh(); const t2 = await b.tab();
    let release; stub.hold = new Promise((r) => (release = r)); const arrived = heldArrival();
    await t.open(); await t.ev("window.__releaseIdle()"); await arrived;
    await t2.open(); await t2.ev("window.__releaseIdle()");
    const waiting = await t2.until(`navigator.locks.query().then((q) => q.pending.some((p) => p.name === "sb-active"))`, 5000);
    await t.ev("__sbHarness.setMeasure(false)");
    const seen = await t2.until(sees("no"), 5000);
    stub.hold = null; release(); await t2.until(LOCK_FREE, 6000); await sleep(300);
    const k2 = await t2.counts();
    // (check 2 alone keeps tab 2 from its in-lock transaction, the one with the probe put; check 3 would stop the POST
    // anyway.  Tab 2's other readwrite transaction is its listener's clear)
    c("C-2c.lock", waiting && seen && posts().length === 1 && !k2.idb["put:w"], `tab 2 waiting ${waiting}, sees "no" ${seen}; posts ${posts().length}; tab 2 ${J(k2.idb)}`);
    await b.stop(); });
  // C-2c.persist: the answer held; consent withdrawn (this tab, then another tab): no note afterwards
  for (const where of ["self", "other"]) await one(`C-2c.persist.${where}`, async () => {
    reset(); const { b, t } = await fresh(); const t2 = where === "other" ? await b.tab() : null;
    if (t2) await t2.open();
    let release; stub.hold = new Promise((r) => (release = r)); const arrived = heldArrival();
    await t.open(); await t.ev("window.__releaseIdle()"); await arrived;
    await (t2 ?? t).ev("__sbHarness.setMeasure(false)");
    const seen = await t.until(sees("no"), 5000);
    stub.hold = null; release(); await t.until(LOCK_FREE, 6000); await sleep(300);
    const k = await t.counts(), s = await t.state();
    // (check 4 alone keeps the persist from being created; the clears would remove its notes anyway)
    c(`C-2c.persist.${where}`, seen && putsAB(k) === 0 && s.a === null && s.b === null, `after a ${where} withdrawal: ${J(s)} ${J(k.idb)}`);
    await b.stop();
  });
  // C-2c.admit: the in-lock transaction held; a withdrawal during it (this tab, then another); released: no POST (check 3)
  for (const where of ["self", "other"]) await one(`C-2c.admit.${where}`, async () => {
    reset(); const { b, t } = await fresh(); const t2 = where === "other" ? await b.tab() : null;
    if (t2) await t2.open();
    await t.open(); await t.ev("window.__idbHold = { nth: 1 }"); await t.ev("window.__releaseIdle()");
    const held = await t.until("window.__idbHeld === true", 5000);
    await (t2 ?? t).ev("__sbHarness.setMeasure(false)");
    const seen = await t.until(sees("no"), 5000);
    await t.ev("window.__idbRelease()"); await t.until(LOCK_FREE, 6000); await sleep(300);
    c(`C-2c.admit.${where}`, held && seen && posts().length === 0, `held ${held}, sees "no" ${seen}; posts ${posts().length}`);
    await b.stop();
  });
  // C-2c.persist.tx: the persist transaction held; setMeasure(false); released: no notes once the clears are done
  await one("C-2c.persist.tx", async () => { reset(); const { b, t } = await fresh();
    await t.open(); await t.ev("window.__idbHold = { nth: 2 }"); await t.ev("window.__releaseIdle()");
    const held = await t.until("window.__idbHeld === true", 5000);
    await t.ev("__sbHarness.setMeasure(false)");
    await t.ev("window.__idbRelease()"); await t.until(LOCK_FREE, 12000);
    const gone = await t.until(`window.__notes((st) => { const a = window.__orig.get.call(st, "a"), b = window.__orig.get.call(st, "b"); return () => a.result === undefined && b.result === undefined; })`, 6000);
    c("C-2c.persist.tx", held && posts().length === 1 && gone, `held ${held}; posts ${posts().length}; notes gone ${gone}`);
    await b.stop(); });
  // C-2c.lag: (i) after A sees B's "no", A's idle: no POST; (ii) A's idle as B withdraws: at most one POST, and no notes
  // once A sees "no" (the lag is reported, as information)
  await one("C-2c.lag:i", async () => { reset(); const { b, t } = await fresh(); const t2 = await b.tab();
    await t.open(); await t2.open();
    await t2.ev("__sbHarness.setMeasure(false)"); const t0 = Date.now();
    const seen = await t.until(sees("no"), 6000); const lag = Date.now() - t0;
    await t.ev("window.__releaseIdle()"); await t.until(RUN_ENDED, 8000); await sleep(300);
    c("C-2c.lag", seen && posts().length === 0, `(i) A saw "no" after ${lag} ms; posts ${posts().length}`);
    console.log(`  (info) C-2c.lag (i): A observed the withdrawal ${lag} ms after B's setMeasure(false)`);
    await b.stop(); });
  await one("C-2c.lag:ii", async () => { reset(); const { b, t } = await fresh(); const t2 = await b.tab();
    await t.open(); await t2.open();
    await Promise.all([t2.ev("__sbHarness.setMeasure(false)"), t.ev("window.__releaseIdle()")]); const t0 = Date.now();
    const seen = await t.until(sees("no"), 6000); const lag = Date.now() - t0;
    await t.until(LOCK_FREE, 12000);
    const gone = await t.until(`window.__notes((st) => { const a = window.__orig.get.call(st, "a"), b = window.__orig.get.call(st, "b"); return () => a.result === undefined && b.result === undefined; })`, 6000);
    c("C-2c.lag", seen && posts().length <= 1 && gone, `(ii) posts ${posts().length}; notes gone ${gone}; A saw "no" after ${lag} ms`);
    console.log(`  (info) C-2c.lag (ii): ${posts().length} POST, A observed the withdrawal ${lag} ms after it`);
    await b.stop(); });
  // C-2c.regrant: withdraw in tab A, re-grant in tab B: A's next due ping persists
  await one("C-2c.regrant", async () => { reset(); const { b, t } = await fresh(); const t2 = await b.tab();
    await t.open(); await t2.open();
    await t2.ev("__sbHarness.setMeasure(false)"); await t.until(`localStorage.getItem("sb-consent") === "no"`, 5000);
    await t2.ev("__sbHarness.setMeasure(true)");
    // (another process's localStorage write reaches this tab later, not at once: wait until it has)
    await t.until(`localStorage.getItem("sb-consent") === "yes"`, 5000);
    await t.ev("window.__releaseIdle()"); await t.until(RUN_ENDED, 8000); await t.until(LOCK_FREE, 8000); await sleep(150);
    const s = await t.state();
    c("C-2c.regrant", posts().length === 1 && s.b !== null, `after a re-grant: ${posts().length} posts ${J(s)}`);
    await b.stop(); });
  // C-3: two tabs at once: one POST (the first answer held until the second waits on the lock)
  for (let i = 0; i < 5; i++) await one(`C-3:${i + 1}`, caseC3);
  // C-4: 429, 503, 500, a network error, a malformed 200: nothing written; the next load POSTs once
  for (const m of [{ status: 429 }, { status: 503 }, { status: 500 }, { network: true, status: 200 }, { status: 200, raw: '{"as":"b","nd":0}' }]) await one(`C-4:${J(m)}`, async () => {
    reset(); const { b, t } = await fresh();
    stub.mode = m; await load(t);
    const s = await t.state();
    stub.mode = null; await load(t);
    c("C-4", s.a === null && s.b === null && posts().length === 2, `${J(m)}: ${J(s)} then ${posts().length} posts`);
    await b.stop();
  });
  // C-5: the request, byte-exact
  await one("C-5", async () => { reset(); const { b, t } = await fresh();
    await load(t);
    const p = posts()[0];
    c("C-5", p && p.body === '{"v":1,"day":1,"week":1,"month":1,"client":"web"}' && p.body.length === 49 && !p.headers.referer && p.headers["content-type"] === "application/json" && !new URL(p.url).search && p.method === "POST", `request: ${J(p)}`);
    // (keepalive and credentials, read from the page's own fetch call)
    await t.wipe();
    await load(t, { before: `(() => { const real = window.fetch; window.fetch = (u, i) => { if (String(u).endsWith("/api/active")) window.__seenInit = { keepalive: i.keepalive, credentials: i.credentials, referrerPolicy: i.referrerPolicy, cache: i.cache }; return real(u, i); }; return 1; })()` });
    const seen = await t.ev("window.__seenInit");
    c("C-5", seen && seen.keepalive === true && seen.credentials === "same-origin" && seen.referrerPolicy === "no-referrer" && seen.cache === "no-store", "init: " + J(seen));
    await b.stop(); });
  // C-6: the work per load (upper bounds) and nothing before idle
  await one("C-6", async () => { reset(); const { b, t } = await fresh();
    await t.open(); await sleep(400);
    const k0 = await t.counts();
    c("C-6.pre", Object.keys(k0.get).length === 0 && Object.keys(k0.set).length === 0 && Object.keys(k0.idb).length === 0 && k0.locks === 0 && k0.fetch === 0 && k0.timers === 0 && k0.idle.length === 1, "before idle: " + J(k0));
    // (each path is waited for until it has ended (its connection closed by run()'s finally, and on the due path its POST
    // sent and the lock free), not for a fixed time: a cold profile's first open can take over a second on a loaded host)
    const ended = (tab, post) => tab.until(`window.__c.idb.close >= 1${post ? " && window.__c.fetch >= 1" : ""}`, 8000).then(() => tab.until(LOCK_FREE, 8000));
    // due (signed out)
    await t.ev("window.__releaseIdle()"); await ended(t, true); await sleep(150);
    const k1 = await t.counts();
    const reads = (k, key) => (k.get[key] ?? 0);
    // (due: ≤ 5 consent reads, 1 open, ≤ 3 transactions, ≤ 4 gets, the probe and ≤ 2 note puts, ≤ 1 lock, 1 POST)
    const dueOk = (k) => reads(k, "sb-consent") <= 5 && (k.idb.open ?? 0) === 1 && txs(k) <= 3 && getsAB(k) <= 4 && (k.idb["put:w"] ?? 0) <= 1 && putsAB(k) <= 2 && k.locks <= 1 && k.fetch === 1;
    c("C-6.due-out", dueOk(k1) && posts().length === 1 && posts()[0].body.length <= 64, "due: " + J(k1));
    // counted
    await t.open(); await t.ev("window.__releaseIdle()"); await ended(t, false); await sleep(150);
    const k2 = await t.counts();
    c("C-6.counted", reads(k2, "sb-consent") <= 1 && (k2.idb.open ?? 0) === 1 && (k2.idb["tx:readonly"] ?? 0) === 1 && !k2.idb["tx:readwrite"] && getsAB(k2) <= 2 && k2.locks === 0 && k2.fetch === 0, "counted: " + J(k2));
    // due, with a live session (the stub answers "a"): the same counts
    reset(); await t.ev(`localStorage.clear(); document.cookie = "__Host-sb_session=x; Secure; Path=/"`); await t.wipe();
    stub.mode = { status: 200, as: "a" };
    await t.open(); await t.ev("window.__releaseIdle()"); await ended(t, true); await sleep(150);
    const k3 = await t.counts();
    c("C-6.due-in", dueOk(k3) && posts().length === 1 && !!posts()[0].headers.cookie, "due, signed in: " + J(k3));
    // off
    await t.ev(`localStorage.setItem("sb-consent", "no")`);
    await t.open(); await t.ev("window.__releaseIdle()"); await sleep(500);
    const k4 = await t.counts();
    await t.until(`window.__c.idb.close >= 1`, 6000); const k4b = await t.counts();
    c("C-6.off", reads(k4b, "sb-consent") <= 1 && (k4b.idb.open ?? 0) === 1 && (k4b.idb.clear ?? 0) === 1 && getsAB(k4b) === 0 && k4b.locks === 0 && k4b.fetch === 0, "off: " + J(k4b));
    await b.stop(); });
  // C-6's task bound: no RunTask on the page's main thread over 5 ms overlapping the window from just before the idle
  // release to the end of the page's run, in 5 cold contexts, each a due load then a counted one.  Whole tasks (grader
  // 6f728d4a B2): every RunTask on the thread carrying both of a load's sb-c6 marks that overlaps the window, at its full
  // duration, whatever it ran (callbacks,
  // their microtask checkpoints, GC), so work in a promise continuation counts; the FunctionCall attribution it replaces
  // missed it (K-30's 20 ms loop was inert).  A window without its two marks on one thread, or with no task seen, is
  // unmeasured: a failure, never a pass.
  await one("C-6.bound", async () => { let worst = 0, tasksSeen = 0; const ok = [], notes = [];
    for (let i = 0; i < 5; i++) {
      reset(); const { b, t } = await fresh();
      await t.send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "toplevel"] }, transferMode: "ReportEvents" });
      const events = []; const done = new Promise((r) => { const prev = t.ws.onmessage; t.ws.onmessage = (ev) => { prev(ev); const m = JSON.parse(ev.data); if (m.method === "Tracing.dataCollected") events.push(...m.params.value); if (m.method === "Tracing.tracingComplete") r(); }; });
      for (let j = 0; j < 2; j++) { await load(t, { before: `console.timeStamp("sb-c6-start-${j}")` }); await t.ev(`console.timeStamp("sb-c6-end-${j}")`); }
      await t.send("Tracing.end"); await done;
      const mark = (m) => events.find((e) => e.name === "TimeStamp" && e.args?.data?.message === m);
      for (let j = 0; j < 2; j++) {
        const s = mark(`sb-c6-start-${j}`), e = mark(`sb-c6-end-${j}`);
        if (!s || !e || s.pid !== e.pid || s.tid !== e.tid) { ok.push(false); notes.push(`context ${i + 1} load ${j + 1}: marks ${!!s}/${!!e}${s && e ? " on different threads" : ""}`); continue; }
        // (every RunTask on the marks' thread that OVERLAPS [start mark, end mark], at its full duration (astra 88686cad,
        // grader 4d388158): a task crossing either edge counts whole.  A stated limit, not a bound: work run inside a
        // DevTools Runtime.evaluate (the marks themselves, and __releaseIdle() with start()'s synchronous prefix) may run
        // as a V8 interrupt rather than as a RunTask, and is then not measured; no case or control claims to bound it)
        const tasks = events.filter((x) => (x.name === "RunTask" || x.name === "ThreadControllerImpl::RunTask") && x.ph === "X" && x.pid === s.pid && x.tid === s.tid && x.ts < e.ts && x.ts + (x.dur ?? 0) > s.ts);
        if (!tasks.length) { ok.push(false); notes.push(`context ${i + 1} load ${j + 1}: no task seen`); continue; }
        tasksSeen += tasks.length;
        const w = Math.max(...tasks.map((x) => (x.dur ?? 0) / 1000));
        worst = Math.max(worst, w); ok.push(w <= 5);
        if (w > 5) notes.push(`context ${i + 1} load ${j + 1}: a ${w.toFixed(2)} ms task`);
        // (the raw window, always printed, pass or fail: the marks' ts (µs), the task count and the three longest tasks
        // (name, start relative to the start mark in ms, duration in ms))
        const top = [...tasks].sort((x, y) => (y.dur ?? 0) - (x.dur ?? 0)).slice(0, 3).map((x) => `${x.name}@${((x.ts - s.ts) / 1000).toFixed(2)}:${((x.dur ?? 0) / 1000).toFixed(3)}`);
        console.log(`  (info) C-6.bound context ${i + 1} load ${j + 1}: marks ${s.ts}..${e.ts} (${((e.ts - s.ts) / 1000).toFixed(1)} ms), ${tasks.length} tasks, worst ${w.toFixed(3)} ms, top ${top.join(" ")}`);
      }
      await b.stop();
    }
    const what = `worst task ${worst.toFixed(2)} ms over ${tasksSeen} tasks in ${ok.length} windows${notes.length ? "; " + notes.join("; ") : ""}`;
    c("C-6.due-out", ok.length === 10 && ok.every(Boolean), what);
    c("C-6.due-in", ok.length === 10 && ok.every(Boolean), what); });
  // C-7: populations (signedOut through the harness: the page itself has no sign-out yet)
  const pop = (id, steps, expect) => one(id, async () => { reset(); const { b, t } = await fresh(); const t2 = await b.tab(); const ctx = { b, t, t2 }; let ok = true, note = ""; try { const r = await steps(ctx); ok = expect(r); note = J(r); } catch (e) { ok = false; note = String(e); } c(id, ok, `${id}: ${note}`); await b.stop(); });
  await pop("C-7.logout", async ({ t }) => { stub.mode = { status: 200, as: "a" }; await load(t); stub.mode = { status: 200, as: "b" }; await t.ev("__sbHarness.signedOut()"); const n = posts().length; await load(t); return { more: posts().length - n }; }, (r) => r.more === 1);
  await pop("C-7.signin", async ({ t }) => { await load(t); const n = posts().length; await load(t); return { more: posts().length - n }; }, (r) => r.more === 0);
  await pop("C-7.abs", async ({ t }) => { await load(t); await t.ev("__sbHarness.signedOut()"); const n = posts().length; await load(t); return { more: posts().length - n }; }, (r) => r.more === 0);
  await pop("C-7.firstweek", async ({ t }) => { stub.mode = { status: 200, as: "a" }; await load(t); stub.mode = null; await t.ev("__sbHarness.signedOut()"); const n = posts().length; await load(t); const p = posts()[n]; return { more: posts().length - n, body: p?.body }; }, (r) => r.more === 1 && /"week":1,"month":1/.test(r.body ?? ""));
  // (C-7.prior at the calendar anchor (astra 861223bc): the next day stays in the same ISO week, asserted, so the week
  // flag is always checked; the anchor offset is composed with the next-day skew)
  // (outside pop(): an unmet precondition records "precondition:C-7.prior" alone, grader 69f2f06c)
  await one("C-7.prior", async () => { pinnedCase = true; reset(); const { b, t } = await fresh();
    const A = anchorAt("C-7.prior"); stub.skew = A; await load(t, { skew: A }); const pg = await pageClock(t, A); const s1 = await t.state(); const d = durations();
    const sameWeek = d.nw > d.nd + 5, cal = `effective ${iso(hostNow() + A)}; page clock ${pg.what}; d ${J(d)}`;
    if (!sameWeek || !pg.ok) { c("precondition:C-7.prior", false, `${pg.ok ? "the next day is not in the same ISO week" : "the pin did not take effect in the page"} (${cal})`); await b.stop(); return; }
    stub.mode = { status: 200, as: "a" }; await load(t, { skew: A + (d.nd + 5) * 1000 }); const s2 = await t.state(); stub.mode = null; await t.ev("__sbHarness.signedOut()"); const s3 = await t.state(); const n = posts().length; await load(t, { skew: A + (d.nd + 5) * 1000 }); const p = posts()[n];
    const r = { more: posts().length - n, body: p?.body, s1, s2, s3, posts: posts().map((x) => x.body) };
    c("C-7.prior", r.more === 1 && /"week":0/.test(r.body ?? ""), `C-7.prior: ${J(r)} (${cal})`);
    await b.stop(); });
  await pop("C-7.repeat", async ({ t }) => { await load(t); await t.ev("__sbHarness.signedOut()"); await load(t); await t.ev("__sbHarness.signedOut()"); const n = posts().length; await load(t); return { more: posts().length - n }; }, (r) => r.more === 0);
  for (const where of ["self", "other"]) await pop(`C-7.held.${where}`, async ({ t, t2 }) => {
    if (where === "other") await t2.open();
    stub.mode = { status: 200, as: "a" };
    let release; stub.hold = new Promise((r) => (release = r)); const arrived = heldArrival();
    await t.open(); await t.ev("window.__releaseIdle()"); await arrived;
    const who = where === "self" ? t : t2;
    // (fire-and-forget DevTools calls: a rejection is caught here, so none prints as an unhandled one: grader 6f728d4a D)
    void who.ev("window.__so = __sbHarness.signedOut().then(() => 1)").catch(() => {});
    const pending = await who.until(`navigator.locks.query().then((q) => q.pending.some((p) => p.name === "sb-active"))`, 5000);
    // (the stub reads its mode once the hold ends: the held answer stays "a" until it has been sent)
    stub.hold = null; release();
    await who.until("window.__so !== undefined", 5000); await sleep(400);
    stub.mode = { status: 200, as: "b" };
    const s = JSON.parse((await t.state()).a ?? "{}");
    const n = posts().length; await load(t);
    return { pending, p: s.p, more: posts().length - n };
  }, (r) => r.pending && r.p === "b" && r.more === 1);
  await pop("C-7.hang", async ({ t, t2 }) => {
    await t.open(); await t2.open();
    await t.seed({ a: { p: "a", ad: 1 }, b: { bd: 2, bw: 3, bm: 4 } });
    void t2.ev(`navigator.locks.request("sb-active", () => new Promise(() => {}))`).catch(() => {});
    await sleep(300);
    const before = await t.state(); const t0 = Date.now();
    await t.ev("__sbHarness.signedOut()");
    const took = Date.now() - t0, after = await t.state();
    return { took, same: J(before) === J(after) };
  }, (r) => r.took < SIGNOUT_MS + 2_000 && r.same); // (grader 5a5a2551 1: 12 s + 1 s had missed by 1 ms under load)
  // C-7.off: consent off, signedOut(): no lock, no IndexedDB, no put (the entry check)
  await pop("C-7.off", async ({ t }) => {
    await t.open(); await t.ev(`localStorage.setItem("sb-consent", "no")`); await sleep(300);
    const k0 = await t.counts(); await t.ev("__sbHarness.signedOut()"); const k = await t.counts();
    return { locks: k.locks - k0.locks, opens: (k.idb.open ?? 0) - (k0.idb.open ?? 0), puts: (k.idb["put:a"] ?? 0) - (k0.idb["put:a"] ?? 0) };
  }, (r) => r.locks === 0 && r.opens === 0 && r.puts === 0);
  // C-7.off.lock / .open: consent on at the call, withdrawn while signedOut waits on the lock (another tab holds it) or on
  // its open (delayed): no put (the pre-put check; the clears would empty the store anyway, so the put itself is asserted)
  await pop("C-7.off.lock", async ({ t, t2 }) => {
    await t.open(); await t2.open(); await sleep(300);
    void t2.ev(`navigator.locks.request("sb-active", () => new Promise((r) => setTimeout(r, 1500)))`).catch(() => {}); await sleep(200);
    const k0 = await t.counts();
    // (handled at once, so a throw before the await leaves no unhandled rejection; the await below still sees it)
    const so = t.ev("__sbHarness.signedOut()"); so.catch(() => {}); await sleep(300);
    await t.ev("__sbHarness.setMeasure(false)"); await so;
    const k = await t.counts();
    return { puts: (k.idb["put:a"] ?? 0) - (k0.idb["put:a"] ?? 0) };
  }, (r) => r.puts === 0);
  await pop("C-7.off.open", async ({ t }) => {
    await t.open(); await sleep(300); await t.ev(`window.__idbOpen = "delay"; window.__idbOpenMs = 1500`);
    const k0 = await t.counts();
    const so = t.ev("__sbHarness.signedOut()"); so.catch(() => {}); await sleep(300);
    await t.ev("__sbHarness.setMeasure(false)"); await so;
    const k = await t.counts();
    return { puts: (k.idb["put:a"] ?? 0) - (k0.idb["put:a"] ?? 0) };
  }, (r) => r.puts === 0);
  // C-7.hang.tx: another tab holds the lock 10 s, then signedOut's transaction is held forever: settled ≤ 12 s + 1 s,
  // nothing written
  await pop("C-7.hang.tx", async ({ t, t2 }) => {
    await t.open(); await t2.open();
    await t.seed({ a: { p: "a", ad: 1 }, b: { bd: 2, bw: 3, bm: 4 } });
    void t2.ev(`navigator.locks.request("sb-active", () => new Promise((r) => setTimeout(r, 10000)))`).catch(() => {});
    await sleep(300);
    const before = await t.state(); await t.ev("window.__idbHold = { nth: 1 }"); const t0 = Date.now();
    await t.ev("__sbHarness.signedOut()");
    const took = Date.now() - t0; await t.ev("window.__idbRelease()"); await sleep(300);
    const after = await t.state();
    return { took, same: J(before) === J(after) };
  }, (r) => r.took < 13_000 && r.same);
  // C-8.static: active.ts and consent.ts are bundled into the "/" page only (the production dist)
  await one("C-8.static", async () => { const hits = [];
    const walkDist = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walkDist(p); else if (/\.(js|html|mjs)$/.test(f) && readFileSync(p, "utf8").includes("sb-active-b")) hits.push(relative(DIST, p)); } };
    walkDist(DIST);
    const harnessStrings = ["__sbHarness", "__SB_MEASURE_TEST__", "MEASURE_BARRIER"].filter((s) => readdirSync(DIST).some((f) => /\.(js|html)$/.test(f) && readFileSync(join(DIST, f), "utf8").includes(s)));
    c("C-8.static", hits.join() === "index.html" && harnessStrings.length === 0, `the counter's code in ${J(hits)}; harness strings ${J(harnessStrings)}`); });
  // C-0 and C-8.origin: the unmodified production page, on the real origin (one POST after idle) and on an unlisted one (none)
  await one("C-0", async () => { pageMode = "prod"; reset(); const { b, t } = await fresh();
    await t.open(ORIGIN + "/"); await sleep(2000); await t.ev("window.__releaseIdle()"); await sleep(2500);
    c("C-0.prod", posts().length === 1 && posts()[0].body.startsWith('{"v":1,'), `production / on the real origin: ${posts().length} posts`);
    const n = stub.requests.length;
    await t.open(`http://127.0.0.1:${plain.port}/`); await sleep(2000); await t.ev("window.__releaseIdle()"); await sleep(2500);
    const k = await t.counts();
    c("C-8.origin", stub.requests.length === n && !k.lockNames.includes("sb-active") && !k.idb.open, `unlisted origin: ${stub.requests.length - n} requests ${J(k)}`);
    await b.stop(); pageMode = "harness"; });
  // C-9: storage and lock errors: no uncaught error, no POST, no retry loop.  C-9.get also asserts the cleanup (grader
  // 6f728d4a B4): mayMeasure's catch turns the blocked read into "no", so measure() removes the notes: one clear
  for (const [id, flag] of [["C-9.get", "window.__throwGet = true"], ["C-9.set", "window.__throwSet = true"], ["C-9.lockreject", "window.__lockReject = true"]]) await one(id, async () => {
    reset(); const { b, t } = await fresh();
    await load(t, { before: flag, wait: 1200 });
    const okPost = id === "C-9.set" ? posts().length <= 1 : posts().length === 0;
    const k = await t.counts(), cleared = id !== "C-9.get" || (k.idb.clear ?? 0) === 1;
    c(id, t.errors.length === 0 && okPost && cleared, `${id}: ${t.errors.length} errors, ${posts().length} posts${id === "C-9.get" ? `, clears ${k.idb.clear ?? 0}` : ""}`);
    await b.stop();
  });
  await one("C-9.nolocks", async () => { reset(); const { b, t } = await fresh("window.__noLocks = true;");
    await load(t);
    c("C-9.nolocks", t.errors.length === 0 && posts().length === 0, `no locks: ${posts().length} posts`);
    await b.stop(); });
  // C-9.idb: no IndexedDB, or it fails: no count, no lock, no uncaught error, and nothing left hanging
  for (const [id, pre, before] of [["C-9.idb.missing", `Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true });`, ""], ["C-9.idb.open", "", `window.__idbOpen = "error"`], ["C-9.idb.blocked", "", `window.__idbOpen = "blocked"`], ["C-9.idb.pre", "", `window.__idbTxFail = "readonly"`]]) await one(id, async () => {
    reset(); const { b, t } = await fresh(pre);
    await load(t, { before, wait: 1500 });
    const k = await t.counts();
    c(id, t.errors.length === 0 && posts().length === 0 && k.locks === 0, `${id}: ${t.errors.length} errors, ${posts().length} posts, ${k.locks} locks`);
    await b.stop();
  });
  await one("C-9.idb.hang", async () => { reset(); const { b, t } = await fresh();
    await load(t, { before: `window.__idbOpen = "hang"`, wait: 7000 });
    const k = await t.counts();
    c("C-9.idb.hang", t.errors.length === 0 && posts().length === 0 && k.locks === 0 && k.t5.set >= 1 && k.t5.fired >= 1, `hang: ${posts().length} posts, ${k.locks} locks, 5 s timers ${J(k.t5)}`);
    await b.stop(); });
  await one("C-9.idb.late", async () => { reset(); const { b, t } = await fresh();
    await load(t, { before: `window.__idbOpen = "late"`, wait: 10000 });
    const k = await t.counts();
    c("C-9.idb.late", t.errors.length === 0 && posts().length === 0 && k.locks === 0 && (k.idb.open ?? 0) === 1 && (k.idb.close ?? 0) === 1, `late: ${posts().length} posts, ${k.locks} locks, ${J(k.idb)}`);
    await b.stop(); });
  await one("C-9.idb.txhang", async () => { reset(); const { b, t } = await fresh();
    await t.open(); await t.ev("window.__idbHold = { nth: 1 }"); await t.ev("window.__releaseIdle()");
    const held = await t.until("window.__idbHeld === true", 5000); const t0 = Date.now();
    const freed = await t.until(LOCK_FREE, 8000); const took = Date.now() - t0;
    c("C-9.idb.txhang", held && freed && took < 6500 && posts().length === 0, `txhang: held ${held}, the lock freed after ${took} ms; ${posts().length} posts`);
    await t.ev("window.__idbRelease()"); await b.stop(); });
  await one("C-9.idb.write", async () => { reset(); const { b, t } = await fresh();
    await load(t, { before: "window.__idbPutFail = true", wait: 1500 });
    await load(t, { before: "window.__idbPutFail = true", wait: 1500 });
    c("C-9.idb.write", t.errors.length === 0 && posts().length === 0, `every put aborts: ${posts().length} posts over two loads`);
    await b.stop(); });
  await one("C-9.idb.clear", async () => { reset(); const { b, t } = await fresh();
    await t.open(); await t.ev(`localStorage.setItem("sb-consent", "no")`);
    await load(t, { before: "window.__idbClearFail = true", wait: 300 }); await sleep(1500);
    const k = await t.counts();
    c("C-9.idb.clear", t.errors.length === 0 && (k.idb.open ?? 0) >= 1 && (k.idb.close ?? 0) === (k.idb.open ?? 0), `the clear aborts: ${J(k.idb)}, ${t.errors.length} errors`);
    await b.stop(); });
  // C-9.idb.clear.fence: a withdrawal during the persist; the fence's removeNotes can't open: the lock goes ≤ 6.5 s after
  await one("C-9.idb.clear.fence", async () => { reset(); const { b, t } = await fresh();
    await t.open(); await t.ev("window.__idbHold = { nth: 2 }"); await t.ev("window.__releaseIdle()");
    const held = await t.until("window.__idbHeld === true", 5000);
    await t.ev(`window.__idbOpen = "hang"; window.__idbOpenFrom = 2`); await t.ev("__sbHarness.setMeasure(false)");
    await t.ev("window.__idbRelease()"); const t0 = Date.now();
    const freed = await t.until(LOCK_FREE, 12000); const took = Date.now() - t0;
    c("C-9.idb.clear.fence", held && freed && took < 6500 && t.errors.length === 0, `fence: the lock freed after ${took} ms; ${t.errors.length} errors`);
    await b.stop(); });
  await one("C-9.malformed", async () => { reset(); const { b, t } = await fresh();
    await t.open(); await t.seed({ a: "{not json", b: [1, 2] });
    await load(t);
    const s = await t.state();
    c("C-9.malformed", t.errors.length === 0 && posts().length === 1 && JSON.parse(s.b ?? "null")?.bd > 0, `malformed: ${posts().length} posts ${J(s)}`);
    await b.stop(); });
}

// C-2b (the "ask" default) and C-2c.listener (a barrier right after check 4, before the persist is created) need their
// own harness bundles, built from substitutions as the controls are, on top of a control's own (subs).
const ASK = ["C", 'export const MEASURE_DEFAULT: "on" | "ask" = "on";', 'export const MEASURE_DEFAULT: "on" | "ask" = "ask";'];
const BARRIER = ["A", "        if (!mayMeasure()) return;\n        const at = Date.now(), as = ans.as, d = ans;", "        if (!mayMeasure()) return;\n        await (globalThis as any).__barrier?.();\n        const at = Date.now(), as = ans.as, d = ans;"];
async function variantCases(subs = []) {
  let ok = true;
  try { harnessJs = bundle([...subs, ASK]); } catch { ok = false; }
  if (ok) await one("C-2b", async () => { reset(); const { b, t } = await fresh();
    await load(t);
    const k = await t.counts();
    // ("ask" with no consent is off: no lock, no note read, no POST; the per-load clear runs, as C-6.off)
    c("C-2b", posts().length === 0 && k.locks === 0 && getsAB(k) === 0 && !k.idb["put:w"], `ask: ${posts().length} posts, ${k.locks} locks, ${J(k.idb)}`);
    await b.stop(); });
  ok = true;
  try { harnessJs = bundle([...subs, BARRIER]); } catch { ok = false; }
  // (the clear before the persist: B's listener clears while B waits at the barrier; B then persists; the fence clears)
  if (ok) await one("C-2c.listener", async () => { reset(); const { b, t } = await fresh(); const t2 = await b.tab();
    await t2.open();
    await t.open(); await t.ev(`window.__barrier = () => new Promise((r) => { window.__releaseBarrier = r; })`);
    await t.ev("window.__releaseIdle()");
    const atBarrier = await t.until("!!window.__releaseBarrier", 5000);
    await t2.ev("__sbHarness.setMeasure(false)");
    const seen = await t.until(sees("no"), 6000); await sleep(600);
    await t.ev("window.__releaseBarrier && window.__releaseBarrier()");
    await t.until(LOCK_FREE, 12000); await sleep(300);
    const s = await t.state();
    c("C-2c.listener", atBarrier && seen && s.a === null && s.b === null, `the clear before the persist: ${J(s)}`);
    await b.stop(); });
}

// ---- the controls: [name, substitutions [file, find, replace], the closed FAIL set] (r4c3/r4c3a, frozen by the grader
// 5acb533a; the §5 file lists each text)
const PERSIST_FENCE = "        if (ok && (wasWithdrawn() || !mayMeasure())) await removeNotes();\n";
const CONTROLS = [
  ["K-21", [["C", "  if (!mayMeasure()) {\n    await removeNotes();\n    return;\n  }\n  await run(", "  await run("]], ["C-2a", "C-2b", "C-6.off", "C-9.get"]],
  ["K-22", [["A", "      await locks.request(LOCK, async () => {\n        if (!mayMeasure()) return;\n", "      await locks.request(LOCK, async () => {\n"]], ["C-2c.lock"]],
  ["K-55", [["A", "        if (!mayMeasure()) return; // (after the awaited transaction, immediately before the send)\n", ""]], ["C-2c.admit.self", "C-2c.admit.other"]],
  ["K-23a", [["A", "        if (!mayMeasure()) return;\n        const at = Date.now(), as = ans.as, d = ans;", "        const at = Date.now(), as = ans.as, d = ans;"]], ["C-2c.persist.self", "C-2c.persist.other"]],
  ["K-57", [["A", PERSIST_FENCE, ""]], ["C-2c.listener"]],
  ["K-24", [["C", "  return MEASURE_DEFAULT === \"on\";", "  return true;"]], ["C-2b"]],
  ["K-25", [["A", "      await locks.request(LOCK, async () => {", "      await (async (f: any) => f())(async () => {"]], ["C-3", "C-2c.lock", "C-7.held.self", "C-7.held.other", "C-9.lockreject"]],
  ["C-C3", [["A", "        a = readA(inl.v[0]);\n        let bb = readB(inl.v[1]);", "        a = readA(pre.v[0]);\n        let bb = readB(pre.v[1]);"]], ["C-3"]],
  ["K-26", [["A", "          if (r.status !== 200) return; // (429, 503, …: nothing written; a later load tries again)\n          ans = answerOf(await r.json());", "          ans = answerOf(await r.json().catch(() => ({ as: \"b\", nd: 86400, nw: 86400, nm: 86400 }))) ?? { as: \"b\", nd: 86400, nw: 86400, nm: 86400 };"]], ["C-4"]],
  ["K-27", [["A", ' referrerPolicy: "no-referrer",', ""]], ["C-5"]],
  ["K-28", [["A", " keepalive: true,", ""]], ["C-5"]],
  // (K-29, PROPOSED for the grader's ruling (6f728d4a B1): a consent read before idle, instead of start() at load,
  // whose run raced every case's after-open setup and so had no closed set)
  ["K-29", [["A", "if (self.requestIdleCallback) requestIdleCallback(start);\nelse setTimeout(start, FETCH_MS);", "void mayMeasure();\nif (self.requestIdleCallback) requestIdleCallback(start);\nelse setTimeout(start, FETCH_MS);"]], ["C-6.pre", "C-6.counted", "C-6.off", "C-6.due-out", "C-6.due-in"]],
  ["K-30", [["A", "        const body = JSON.stringify(", "        { const z = Date.now(); while (Date.now() - z < 20); }\n        const body = JSON.stringify("]], ["C-6.due-out", "C-6.due-in"]],
  ["K-31", [["A", "const due = (a: A, b: B | null, t: number) => (a.p === \"a\" ? t >= a.ad : t >= (b?.bd ?? 0));", "const due = (a: A, b: B | null, t: number) => { const m = new Date(t); m.setHours(0, 0, 0, 0); const last = a.p === \"a\" ? a.ad : (b?.bd ?? 0); return last === 0 || last - 86_400_000 < m.valueOf(); };"]], ["C-1.tz", "C-1s", "C-1d"]],
  ["K-32", [["A", "export async function signedOut(): Promise<void> {\n  if (!mayMeasure()) return;\n", "export async function signedOut(): Promise<void> {\n  if (Date.now() > 0) return;\n  if (!mayMeasure()) return;\n"]], ["C-7.logout", "C-7.firstweek", "C-7.prior", "C-7.held.self", "C-7.held.other"]],
  ["K-35", [["C", "    return permits(localStorage.getItem(CONSENT_KEY));\n  } catch {\n    return false;\n  }", "    return permits(localStorage.getItem(CONSENT_KEY));\n  } finally {\n  }"]], ["C-9.get"]],
  ["K-36", [["A", "          if (as === \"b\") s.put({ bd:", "          s.put({ bd:"]], ["C-7.logout", "C-7.firstweek", "C-7.prior", "C-7.held.self", "C-7.held.other"]],
  ["K-38", [["A", "          ra.onsuccess = () => { if (mayMeasure()) s.put({ p: \"b\", ad: readA(ra.result).ad }, \"a\"); };", "          ra.onsuccess = () => { if (mayMeasure()) s.put({ p: \"b\", ad: readA(ra.result).ad }, \"a\"); s.delete(\"b\"); };"]], ["C-7.abs", "C-7.prior", "C-7.repeat"]],
  ["K-41", [["A", "    await locks.request(LOCK, { signal: AbortSignal.timeout(SIGNOUT_MS) }, async () => {", "    await (async (f: any) => f())(async () => {"]], ["C-7.held.self", "C-7.held.other", "C-7.hang", "C-7.off.lock"]],
  ["K-43", [["A", "{ signal: AbortSignal.timeout(SIGNOUT_MS) }, ", ""]], ["C-7.hang"]],
  ["K-44", [["C", "  withdrawn = !v;\n", "  if (!v) withdrawn = true;\n"], ["C", "  if (permits(e.newValue)) withdrawn = false;\n", "  if (permits(e.newValue)) void 0;\n"]], ["C-2c.regrant"]],
  ["K-45", [["A", "  } catch {\n    // (settled, nothing written)\n  }", "  } catch {\n    const db = await openNotes(IDB_MS);\n    if (db) { await notesTx(db, \"readwrite\", IDB_MS, (s) => { s.put({ p: \"b\", ad: 0 }, \"a\"); return () => 1; }); db.close(); }\n  }"]], ["C-7.hang"]],
  ["K-60", [["A", "export async function signedOut(): Promise<void> {\n  if (!mayMeasure()) return;\n", "export async function signedOut(): Promise<void> {\n"]], ["C-7.off"]],
  ["K-61", [["A", "          ra.onsuccess = () => { if (mayMeasure()) s.put(", "          ra.onsuccess = () => { s.put("]], ["C-7.off.lock", "C-7.off.open"]],
  ["K-56", [["A", "  const left = () => Math.max(0, Math.min(IDB_MS, deadline - Date.now()));", "  const left = () => IDB_MS + 0 * deadline;"]], ["C-7.hang.tx"]],
  ["K-47", [["A", "          s.put(1, \"w\");\n", ""]], ["C-9.idb.write"]],
  ["K-49m", [["A", "    if (!self.indexedDB) return;\n", "    if (!self.indexedDB) return void (await send({ method: \"POST\", body: \"{}\" }));\n"]], ["C-9.idb.missing"]],
  ["K-49h", [["A", "    const db = await openNotes(IDB_MS);\n    if (!db) return;\n", "    const db = await openNotes(IDB_MS);\n    if (!db) return void (await send({ method: \"POST\", body: \"{}\" }));\n"]], ["C-9.idb.open", "C-9.idb.blocked", "C-9.idb.hang", "C-9.idb.late"]],
  ["K-51", [["A", "      if (!pre) return;\n", "      if (!pre) pre = { v: [undefined, undefined] };\n"]], ["C-9.idb.pre"]],
  // (the open and transaction timers are shared helpers: K-50 and K-52 reach every caller's case, the §5 file derives them)
  ["K-50", [["C", "    const timer = setTimeout(() => end(null), ms);\n", "    const timer = 0;\n"]], ["C-9.idb.hang", "C-9.idb.late", "C-9.idb.clear.fence"]],
  ["K-53", [["C", "      if (settled) return void db?.close();\n", "      if (settled) return;\n"]], ["C-9.idb.late"]],
  ["K-52", [["C", "    const timer = setTimeout(() => {\n      try {\n        tx?.abort();\n      } catch {\n        // (already finished)\n      }\n      resolve(null);\n    }, ms);\n", "    const timer = 0;\n"]], ["C-9.idb.txhang", "C-7.hang.tx"]],
  ["K-58", [["C", "  dropLegacy();\n  const db = await openNotes(IDB_MS);\n", "  dropLegacy();\n  const db = await openNotes(1e9);\n"]], ["C-9.idb.clear.fence"]],
  ["K-59", [["C", "  } finally {\n    db.close();\n  }\n}\n\n/** Set when consent", "  } finally {\n  }\n}\n\n/** Set when consent"]], ["C-9.idb.clear"]],
  ["K-GPC", [["C", "    if (HONOR_GPC && (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true) return false;\n", ""]], ["C-1.gpc"]],
];

// ---- run
// ---- the worktree controls (r3 §G): an edit outside active.ts/consent.ts, so the tree itself is changed (and the
// site rebuilt when the built assets are what a case reads), then put back and its sha256 checked, whatever happens
const TREE = [
  ["K-20", { file: "zz-k20-measure.ts", create: 'export const sendAgain = () => fetch("/api/active", { method: "POST" });\n' }, false, ["C-2"]],
  ["K-34", { file: "board/board.ts", prepend: 'import "../active.ts";\n' }, true, ["C-2", "C-8.static"]],
  // (K-33, the origin check removed: C-8.origin loads the production dist, so the edit is made in the tree and the site
  // rebuilt (grader 6f728d4a B3); the harness bundle, built from the same tree, is served on a listed origin only)
  ["K-33", { file: "active.ts", sub: ["  if (!MEASURE_ORIGINS.includes(location.origin)) return;\n", ""] }, true, ["C-8.origin"]],
];
// ---- the pin controls: [name, deliberately wrong pins, the closed FAIL set] (grader 69f2f06c: a wrong pin must fail
// only with "precondition:").  Each pinned case gets a pin that breaks its precondition:
//   C-1.tz, C-7.prior  Sunday 2026-11-01 02:00:00Z: both zones' local midnights lie before that UTC day's midnight
//                      (Kiritimati Oct 31 10:00Z, Adak Oct 31 09:00Z, HDT), and the next day (Monday) starts a new week
//   C-1s               Wed 2026-10-14 00:30Z: phase 30 min, outside [65, 175] min
//   C-1d               zone Pacific/Kiritimati instead of UTC
const PIN = [
  ["K-PIN", { pins: { "C-1.tz": Date.UTC(2026, 10, 1, 2, 0, 0), "C-7.prior": Date.UTC(2026, 10, 1, 2, 0, 0), "C-1s": Date.UTC(2026, 9, 14, 0, 30, 0) }, zones: { "C-1d": "Pacific/Kiritimati" } },
    ["precondition:C-1.tz", "precondition:C-7.prior", "precondition:C-1s", "precondition:C-1d"]],
];
const rebuild = () => { const r = spawnSync("bun", ["web/build.ts"], { cwd: dirname(here), encoding: "utf8", maxBuffer: 1 << 26 }); if (r.status !== 0) throw new Error("the site didn't build: " + (r.stderr || r.stdout).slice(-300)); };

// ---- the ordering evidence (r4c3 §4; a packet run, not CI): EVIDENCE=N runs the C-3 interleaving ABAB on the IDB
// build and on the localStorage-restored build (LS_ENTRY: r4b's in-lock read, through a localStorage mirror of the
// notes) until each has N iterations whose two tabs have distinct renderer pids; shared-pid and errored iterations are
// excluded and counted.  One line per iteration.  PASS iff IDB 0 doubles AND localStorage ≥ 3; localStorage < 3 is
// INCONCLUSIVE, never a pass.  LS_ENTRY reads the mirror as the lock callback's first statement and writes it as the
// last statement before the lock goes (after the persist's commit and the fence), so nothing of the IDB build sits
// between the holder's write and the waiter's read; everything else is the IDB build.  window.__lsGap carries the
// times (performance.timeOrigin + now(), one clock across the tabs): w (write), a (callback entry) and r (read done),
// and seen (the read found a mirror).
const LS_ENTRY = [
  ["A", "      await locks.request(LOCK, async () => {\n        if (!mayMeasure()) return;\n        dropLegacy();", "      await locks.request(LOCK, async () => {\n        const lsA = performance.timeOrigin + performance.now(), lsMa = localStorage.getItem(\"sb-mirror-a\"), lsMb = localStorage.getItem(\"sb-mirror-b\");\n        (globalThis as any).__lsGap = { ...(globalThis as any).__lsGap, a: lsA, r: performance.timeOrigin + performance.now(), seen: lsMa !== null };\n        if (!mayMeasure()) return;\n        dropLegacy();"],
  ["A", "        a = readA(inl.v[0]);\n        let bb = readB(inl.v[1]);", "        a = readA(JSON.parse(lsMa ?? \"null\"));\n        let bb = readB(JSON.parse(lsMb ?? \"null\"));"],
  ["A", "        if (ok && (wasWithdrawn() || !mayMeasure())) await removeNotes();\n", "        if (ok && (wasWithdrawn() || !mayMeasure())) await removeNotes();\n        else if (ok) {\n          if (as === \"b\") localStorage.setItem(\"sb-mirror-b\", JSON.stringify({ bd: at + d.nd * 1000, bw: at + d.nw * 1000, bm: at + d.nm * 1000 }));\n          localStorage.setItem(\"sb-mirror-a\", JSON.stringify(as === \"b\" ? { p: \"b\", ad: a.ad } : { p: \"a\", ad: at + d.nd * 1000 }));\n          (globalThis as any).__lsGap = { ...(globalThis as any).__lsGap, w: performance.timeOrigin + performance.now() };\n        }\n"],
];
if (process.env.EVIDENCE) {
  const N = Number(process.env.EVIDENCE), builds = { idb: bundle(), ls: bundle(LS_ENTRY) };
  const tally = { idb: { included: 0, doubles: 0, shared: 0, errors: 0 }, ls: { included: 0, doubles: 0, shared: 0, errors: 0 } };
  const t0 = Date.now();
  for (let i = 0, cap = 3 * N; (tally.idb.included < N || tally.ls.included < N) && i < cap; i++) {
    for (const k of ["idb", "ls"]) {
      if (tally[k].included >= N) continue;
      harnessJs = builds[k];
      let r;
      try { r = await c3Once(true); } catch (e) { r = { error: String(e?.message ?? e).slice(0, 160) }; for (const b of [...browsers]) await b.stop(); }
      const shared = !r.error && r.pid1 != null && r.pid1 === r.pid2;
      if (r.error) tally[k].errors++; else if (shared) tally[k].shared++; else { tally[k].included++; if (r.posts > 1) tally[k].doubles++; }
      // (the gaps, ls only: the holder's mirror write -> the waiter's callback entry, which bounds write -> release from
      // above, and the waiter's entry -> its read done; seen = the waiter's read found a mirror)
      const g1 = r.gap1, g2 = r.gap2, ms = (x) => (x == null ? "-" : x.toFixed(1));
      const gaps = k === "ls" ? ` w->acq=${ms(g1?.w != null && g2?.a != null ? g2.a - g1.w : null)}ms acq->read=${ms(g2?.a != null ? g2.r - g2.a : null)}ms seen=${g2?.seen ?? "-"}` : "";
      console.log(`${k} attempt ${i + 1}: posts=${r.posts} waiting=${r.waiting} held=${r.heldMs}ms${gaps} pids=${r.pid1},${r.pid2}${shared ? " SHARED (excluded)" : ""}${r.error ? " ERROR (excluded) " + r.error : ""}`);
    }
  }
  const pass = tally.idb.included >= N && tally.ls.included >= N && tally.idb.doubles === 0 && tally.ls.doubles >= 3;
  console.log(`tally ${J(tally)} (${((Date.now() - t0) / 1000).toFixed(0)} s): ${pass ? "PASS" : tally.idb.doubles > 0 ? "FAIL" : "INCONCLUSIVE"}${tally.ls.doubles < 3 ? " (the localStorage build doubled fewer than 3 times: the zero says nothing)" : ""}`);
  front.stop(true); plain.stop(true); rmSync(tmp, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}
// (DUMP_CONTROLS=1: the controls, their exact substitutions and sets, as JSON, then stop: the frozen §5 file's source)
if (process.env.DUMP_CONTROLS) {
  console.log(JSON.stringify({ files: SRC, variants: { ASK, BARRIER, LS_ENTRY }, controls: CONTROLS.map(([name, subs, set]) => ({ name, subs: subs.map(([f, find, replace]) => ({ file: SRC[f], find, replace })), set })), tree: TREE.map(([name, edit, build, set]) => ({ name, edit, rebuild: build, set })), pin: PIN.map(([name, pin, set]) => ({ name, pins: Object.fromEntries(Object.entries(pin.pins ?? {}).map(([k, v]) => [k, new Date(v).toISOString()])), zones: pin.zones ?? {}, set })), pins: Object.fromEntries(Object.entries(PINS).map(([k, v]) => [k, new Date(v).toISOString()])), zones: PIN_ZONES }, null, 1));
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}
// (CHECK_SUBS=1: every control's substitutions match exactly once and its copy bundles, then stop)
if (process.env.CHECK_SUBS) {
  let n = 0;
  for (const [name, subs] of CONTROLS) { try { bundle(subs); n++; } catch (e) { console.log(`FAIL ${name}: ${String(e.message).slice(0, 200)}`); } }
  try { bundle(LS_ENTRY); n++; } catch (e) { console.log(`FAIL LS_ENTRY: ${String(e.message).slice(0, 200)}`); }
  for (const v of [ASK, BARRIER]) { try { bundle([v]); n++; } catch (e) { console.log(`FAIL variant: ${String(e.message).slice(0, 200)}`); } }
  console.log(`substitutions: ${n} of ${CONTROLS.length + 3} bundle`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(n === CONTROLS.length + 3 ? 0 : 1);
}
let bad = 0;
const t0 = Date.now();
harnessJs = bundle();
await guarded(cases); await guarded(variantCases);
const baseFailed = [...results].filter(([, v]) => !v).map(([k]) => k);
console.log(`${baseFailed.length ? "FAIL" : "ok  "} the cases: ${results.size}${baseFailed.length ? "; failed: " + baseFailed.join(", ") : ""} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
bad += baseFailed.length;
const which = process.env.ACTIVE_CONTROL;
if (which !== "none" && !baseFailed.length) {
  for (const [name, subs, want] of CONTROLS) {
    if (which && which !== name) continue;
    const t1 = Date.now();
    results.clear();
    harnessJs = bundle(subs);
    await guarded(cases);
    await guarded(() => variantCases(subs));
    const f = [...results].filter(([, v]) => !v).map(([k]) => k).sort(), w = [...want].sort();
    const ok = f.length > 0 && f.join() === w.join();
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${ok ? "exactly its set" : `failed {${f.join(", ")}}, wanted {${w.join(", ")}}`} (${((Date.now() - t1) / 1000).toFixed(0)} s)`);
    if (!ok) bad++;
  }
}
if (which !== "none" && !baseFailed.length) {
  for (const [name, edit, build, want] of TREE) {
    if (which && which !== name) continue;
    const t1 = Date.now(), f = join(here, edit.file), had = existsSync(f), orig = had ? readFileSync(f) : null;
    const hash = (b) => createHash("sha256").update(b).digest("hex");
    try {
      // (create a file, prepend to one, or substitute in one: sub = [find, replace], which must match exactly once)
      const subbed = () => { const s = orig.toString("utf8"), n = s.split(edit.sub[0]).length - 1; if (n !== 1) throw new Error(`${name}'s substitution in ${edit.file} matched ${n} times`); return s.replace(edit.sub[0], () => edit.sub[1]); };
      writeFileSync(f, edit.create ?? (edit.sub ? subbed() : edit.prepend + orig.toString("utf8")));
      if (build) rebuild();
      results.clear(); harnessJs = bundle();
      await guarded(cases); await guarded(() => variantCases());
    } finally {
      if (had) writeFileSync(f, orig); else rmSync(f, { force: true });
      if (had && hash(readFileSync(f)) !== hash(orig)) { console.log(`FAIL ${name}: ${edit.file} wasn't restored`); bad++; }
      if (build) rebuild();
    }
    const failed = [...results].filter(([, v]) => !v).map(([k]) => k).sort(), w = [...want].sort();
    const ok = failed.length > 0 && failed.join() === w.join();
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${ok ? "exactly its set" : `failed {${failed.join(", ")}}, wanted {${w.join(", ")}}`} (${((Date.now() - t1) / 1000).toFixed(0)} s)`);
    if (!ok) bad++;
  }
}
// (the pin controls: the unmodified code, with the calendar anchor set wrong; only the precondition results may fail)
if (which !== "none" && !baseFailed.length) {
  for (const [name, pin, want] of PIN) {
    if (which && which !== name) continue;
    const t1 = Date.now();
    results.clear(); harnessJs = bundle();
    try { pinOverride = pin; await guarded(cases); await guarded(() => variantCases()); } finally { pinOverride = null; }
    const failed = [...results].filter(([, v]) => !v).map(([k]) => k).sort(), w = [...want].sort();
    const ok = failed.length > 0 && failed.join() === w.join();
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${ok ? "exactly its set" : `failed {${failed.join(", ")}}, wanted {${w.join(", ")}}`} (${((Date.now() - t1) / 1000).toFixed(0)} s)`);
    if (!ok) bad++;
  }
}
front.stop(true); plain.stop(true);
rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `${bad} problems` : "every case passed and every control failed exactly its set");
process.exit(bad ? 1 : 0);
