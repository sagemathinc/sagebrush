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
const nowS = () => Math.floor((Date.now() + stub.skew) / 1000);
function durations(t = nowS()) {
  const d = new Date(t * 1000);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  const dow = (d.getUTCDay() + 6) % 7; // Monday 0
  const nextDay = day + 86400, nextWeek = day + (7 - dow) * 86400, nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  return { nd: nextDay - t, nw: nextWeek - t, nm: nextMonth - t };
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
  Date.now = () => realNow() + (window.__skew ?? 0);
  if (navigator.locks) {
    const req = navigator.locks.request.bind(navigator.locks);
    navigator.locks.request = function (name, ...a) { c.locks++; c.lockNames.push(name); if (window.__lockReject) return Promise.reject(new Error("locks refused")); return req(name, ...a); };
  }
  if (window.__noLocks) Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
  const f = window.fetch.bind(window);
  window.fetch = (u, init) => { if (String(u).endsWith("/api/active")) c.fetch++; return f(u, init); };
  const st = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...a) => { if (!c.released && ms === 10000) c.timers++; return st(fn, ms, ...a); };
  window.requestIdleCallback = (cb) => { c.idle.push(cb); return c.idle.length; };
  window.__releaseIdle = () => { c.before = JSON.parse(JSON.stringify({ get: c.get, set: c.set, rm: c.rm, locks: c.locks, fetch: c.fetch })); c.released = true; for (const cb of c.idle.splice(0)) cb({ didTimeout: false, timeRemaining: () => 50 }); };
})();`;
const browsers = new Set();
/** every case runs to its end or fails as "threw" (its message shown): the browsers it started are stopped either way */
async function guarded(f) {
  try { await f(); } catch (e) { c("threw", false, String(e?.stack ?? e).slice(0, 600)); }
  for (const b of [...browsers]) await b.stop();
}
class Browser {
  constructor(flags = "") { this.flags = flags; this.errors = []; }
  async start() {
    browsers.add(this);
    this.profile = mkdtempSync(join(tmp, "chrome-"));
    this.proc = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${this.profile}`, `--host-resolver-rules=MAP sagebrush.space 127.0.0.1:${front.port}`, "--ignore-certificate-errors", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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
  async stop() { browsers.delete(this); try { this.proc.kill("SIGKILL"); } catch {} await sleep(200); rmSync(this.profile, { recursive: true, force: true }); }
}
class Tab {
  constructor(t, b) { this.t = t; this.b = b; this.n = 0; this.waiting = new Map(); this.errors = []; }
  async attach(pre) {
    this.ws = new WebSocket(this.t.webSocketDebuggerUrl);
    await new Promise((r) => (this.ws.onopen = r));
    this.ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.waiting.has(m.id)) { this.waiting.get(m.id)(m.result ?? m.error); this.waiting.delete(m.id); } if (m.method === "Runtime.exceptionThrown") this.errors.push(m.params.exceptionDetails?.exception?.description?.slice(0, 200) ?? "exception"); };
    for (const m of ["Page.enable", "Runtime.enable"]) await this.send(m);
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: pre + INSTRUMENT });
  }
  // (every DevTools call bounded: a stuck case fails with its name instead of hanging the run)
  send(method, params = {}) { return new Promise((r, no) => { const id = ++this.n; const to = setTimeout(() => { this.waiting.delete(id); no(new Error(`DevTools ${method}: no answer in 30 s`)); }, 30000); this.waiting.set(id, (v) => { clearTimeout(to); r(v); }); this.ws.send(J({ id, method, params })); }); }
  async ev(expression) { const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(J(r.exceptionDetails).slice(0, 300)); return r.result?.value; }
  // (loaded: the instrument ran and the document's scripts too, so a harness page's __sbHarness exists)
  async open(url = ORIGIN + "/") { await this.send("Page.navigate", { url }); for (let i = 0; i < 200; i++) { if (await this.ev("!!window.__c && document.readyState === 'complete'").catch(() => false)) return; await sleep(50); } throw new Error("page didn't load"); }
  async until(expr, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (await this.ev(expr).catch(() => false)) return true; await sleep(50); } return false; }
  state() { return this.ev(`({ a: localStorage.getItem("sb-active"), b: localStorage.getItem("sb-active-b"), consent: localStorage.getItem("sb-consent") })`); }
  counts() { return this.ev("JSON.parse(JSON.stringify(window.__c))"); }
  async close() { try { this.ws.close(); } catch {} }
}

// ---- results
const results = new Map();
const c = (id, ok, what) => { if (process.env.TRACE) console.log(`  ${ok ? "ok" : "FAIL"} ${id} (${new Date().toISOString().slice(11, 19)})${ok ? "" : ": " + what}`); if (!results.has(id)) results.set(id, true); if (!ok) { results.set(id, false); if (process.env.SHOW_FAILS) console.log(`  fail ${id}: ${what}`); } };
const reset = () => { stub.requests.length = 0; stub.mode = null; stub.hold = null; stub.skew = 0; };
const posts = () => stub.requests.filter((r) => !r.unlisted);
/** the held POST's arrival, bounded (15 s) */
const heldArrival = () => Promise.race([new Promise((r) => (stub.holdArrived = r)), sleep(15000).then(() => { throw new Error("the held POST never arrived"); })]);
const DAY = 86400;
async function fresh(pre = "") { const b = new Browser(); await b.start(); const t = await b.tab(pre); return { b, t }; }
/** a page load with idle held, then released; waits for its ping (or for quiet) */
async function load(t, { skew = 0, before = "", wait = 1500 } = {}) {
  await t.open();
  if (skew) await t.ev(`window.__skew = ${skew}`);
  if (before) await t.ev(before);
  const n = posts().length;
  await t.ev("window.__releaseIdle()");
  const until = Date.now() + wait;
  while (Date.now() < until && posts().length === n) await sleep(25);
  // (a POST arrived: wait until the page is done with it, its lock released and the answer persisted, before
  // anything navigates; a fixed pause lost the persist on a loaded machine)
  if (posts().length > n) await t.until(`navigator.locks.query().then((q) => !q.held.some((h) => h.name === "sb-active") && !q.pending.some((h) => h.name === "sb-active"))`, 5000);
  await sleep(150);
}

// C-3, as a function: ONLY=C-3 runs it alone, REPEAT times (a stress probe; not part of the suite's verdict)
async function caseC3() {
  { reset(); const { b, t } = await fresh(); const t2 = await b.tab();
    let release; stub.hold = new Promise((r) => (release = r)); const arrived = heldArrival();
    await t.open(); await t2.open();
    await t.ev("window.__releaseIdle()"); await arrived;
    await t2.ev("window.__releaseIdle()");
    const waiting = await t2.until(`navigator.locks.query().then((q) => q.pending.some((p) => p.name === "sb-active"))`, 5000);
    const heldMs = Date.now() - (posts()[0]?.at ?? 0) * 1000;
    stub.hold = null; release(); await sleep(1000);
    c("C-3", waiting && posts().length === 1, `waiting ${waiting}; posts ${posts().length}; held ${heldMs} ms; bodies ${J(posts().map((p) => p.body))}; tab1 ${J(await t.state())}; tab2 ${J(await t2.state())}; errors ${J([...t.errors, ...t2.errors])}`);
    await b.stop(); }
}

// ---- the cases
async function cases() {
  if (process.env.ONLY === "C-3") { for (let i = 0; i < Number(process.env.REPEAT ?? 20); i++) await caseC3(); return; }
  // C-1: due once a day; the next day by the server's durations; week and month flags; time zones change nothing
  { reset(); const { b, t } = await fresh();
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
    await b.stop(); }
  for (const tz of ["Pacific/Kiritimati", "America/Adak"]) {
    reset(); const { b, t } = await fresh();
    await t.send("Emulation.setTimezoneOverride", { timezoneId: tz });
    await load(t); await load(t);
    const d = durations();
    await load(t, { skew: (d.nd + 5) * 1000 });
    c("C-1.tz", posts().length === 2, `${tz}: ${posts().length} posts`);
    await b.stop();
  }
  // C-1s: a skewed client clock: one POST per stub day, the week flag exactly on the stub's Monday
  for (const skewMs of [2 * 3600_000, -DAY * 1000]) {
    reset(); const { b, t } = await fresh();
    const d0 = durations();
    stub.skew = 0;
    const perDay = new Map();
    for (let h = 0; h < 72; h += 3) {
      stub.skew = h * 3600_000;
      await load(t, { skew: skewMs + stub.skew, wait: 700 });
    }
    for (const p of posts()) { const day = Math.floor(p.at / DAY); perDay.set(day, (perDay.get(day) ?? 0) + 1); }
    c("C-1s", [...perDay.values()].every((n) => n === 1) && perDay.size >= 3, `skew ${skewMs}: per stub day ${J([...perDay])} (d0 ${J(d0)})`);
    await b.stop();
  }
  // C-1d: an answer sampled at 23:59:59 held 3 s: bd ≈ arrival + 1 s; a load 0.5 s after the arrival sends nothing, 1.5 s after one POST
  { reset(); const { b, t } = await fresh();
    const d = durations(); stub.skew = (d.nd - 1) * 1000; // stub time 23:59:59
    stub.mode = { status: 200, as: "b", sampleAt: nowS() };
    let release; stub.hold = new Promise((r) => (release = r));
    const arrived = heldArrival();
    await t.open(); await t.ev(`window.__skew = ${stub.skew}`); await t.ev("window.__releaseIdle()");
    await arrived; await sleep(3000); stub.hold = null; release();
    await sleep(300);
    const arrival = Date.now() + stub.skew;
    const st = JSON.parse((await t.state()).b ?? "{}");
    stub.mode = null;
    const n = posts().length;
    await sleep(200); await load(t, { skew: stub.skew + 0, wait: 600 }); // ≈ arrival + 0.5 s
    const quiet = posts().length === n;
    await sleep(1200); await load(t, { skew: stub.skew, wait: 1500 });
    c("C-1d", Math.abs(st.bd - (arrival + 1000)) < 500 && quiet && posts().length === n + 1, `bd ${st.bd - arrival} ms after arrival; quiet ${quiet}; posts ${posts().length - n}`);
    await b.stop(); }
  // C-1j: a forward clock jump past bd on the same server day: one more POST (the disclosed duplicate)
  { reset(); const { b, t } = await fresh();
    await load(t); await load(t, { skew: 25 * 3600_000 });
    c("C-1j", posts().length === 2, `${posts().length} posts`);
    await b.stop(); }
  // C-1.gpc: Global Privacy Control on: nothing sent, nothing written
  { reset(); const { b, t } = await fresh(`Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true, configurable: true });`);
    await load(t);
    const s = await t.state(), k = await t.counts();
    c("C-1.gpc", posts().length === 0 && s.a === null && s.b === null && !k.set["sb-active"] && !k.set["sb-active-b"], `gpc: ${posts().length} posts, ${J(s)}`);
    await b.stop(); }
  // C-2: only consent.ts (and the bundle that holds it) contains a measurement path
  { const hits = [];
    // (the sources git knows, tracked or new; build output such as dist/ and site/public/ is ignored)
    const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "."], { cwd: here, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    for (const f of listed) { const p = join(here, f); if (/\.(ts|js|mjs|html)$/.test(f) && !/(^|\/)test-[^/]*$/.test(f) && existsSync(p) && readFileSync(p, "utf8").includes("/api/active")) hits.push(relative(here, p)); }
    const distHits = [];
    const walkDist = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walkDist(p); else if (/\.(js|html)$/.test(f) && readFileSync(p, "utf8").includes("/api/active")) distHits.push(relative(DIST, p)); } };
    walkDist(DIST);
    c("C-2", hits.join() === "consent.ts" && distHits.join() === "index.html", `sources ${J(hits)}, dist ${J(distHits)}`); }
  // C-2a: consent "no": one consent read, the notes removed, no lock, timer or fetch after it
  { reset(); const { b, t } = await fresh();
    await t.open(); await t.ev(`localStorage.setItem("sb-active-b", "{}"); localStorage.setItem("sb-consent", "no")`);
    await load(t);
    const k = await t.counts(), s = await t.state();
    c("C-2a", posts().length === 0 && k.locks === 0 && s.b === null && (k.get["sb-consent"] ?? 0) - (k.before.get["sb-consent"] ?? 0) === 1 && !(k.get["sb-active"] > (k.before.get["sb-active"] ?? 0)), `off: ${J(k)} ${J(s)}`);
    await t.ev(`localStorage.setItem("sb-consent", "yes"); localStorage.setItem("sb-active-b", "{}"); __sbHarness.setMeasure(false)`);
    c("C-2a", (await t.state()).b === null, "setMeasure(false) removes the note");
    await b.stop(); }
  // C-2c.lock: tab 2 waits on the lock while tab 1's request is held; tab 1 withdraws; tab 2 sends nothing
  { reset(); const { b, t } = await fresh(); const t2 = await b.tab();
    let release; stub.hold = new Promise((r) => (release = r)); const arrived = heldArrival();
    await t.open(); await t.ev("window.__releaseIdle()"); await arrived;
    await t2.open(); await t2.ev("window.__releaseIdle()");
    const waiting = await t2.until(`navigator.locks.query().then((q) => q.pending.some((p) => p.name === "sb-active"))`, 5000);
    await t.ev("__sbHarness.setMeasure(false)");
    stub.hold = null; release(); await sleep(800);
    c("C-2c.lock", waiting && posts().length === 1, `tab 2 waiting ${waiting}; posts ${posts().length}`);
    await b.stop(); }
  // C-2c.persist: the answer held; consent withdrawn (this tab, then another tab): no note afterwards
  for (const where of ["self", "other"]) {
    reset(); const { b, t } = await fresh(); const t2 = where === "other" ? await b.tab() : null;
    if (t2) await t2.open();
    let release; stub.hold = new Promise((r) => (release = r)); const arrived = heldArrival();
    await t.open(); await t.ev("window.__releaseIdle()"); await arrived;
    await (t2 ?? t).ev("__sbHarness.setMeasure(false)");
    stub.hold = null; release(); await sleep(800);
    const s = await t.state();
    c(`C-2c.persist.${where}`, s.a === null && s.b === null, `after a ${where} withdrawal: ${J(s)}`);
    await b.stop();
  }
  // C-2c.regrant: withdraw in tab A, re-grant in tab B: A's next due ping persists
  { reset(); const { b, t } = await fresh(); const t2 = await b.tab();
    await t.open(); await t2.open();
    await t2.ev("__sbHarness.setMeasure(false)"); await t.until(`localStorage.getItem("sb-consent") === "no"`, 5000);
    await t2.ev("__sbHarness.setMeasure(true)");
    // (another process's localStorage write reaches this tab later, not at once: wait until it has)
    await t.until(`localStorage.getItem("sb-consent") === "yes"`, 5000);
    await t.ev("window.__releaseIdle()"); await sleep(1200);
    const s = await t.state();
    c("C-2c.regrant", posts().length === 1 && s.b !== null, `after a re-grant: ${posts().length} posts ${J(s)}`);
    await b.stop(); }
  // C-3: two tabs at once: one POST (the first answer held until the second waits on the lock)
  await caseC3();
  // C-4: 429, 503, 500, a network error, a malformed 200: nothing written; the next load POSTs once
  for (const m of [{ status: 429 }, { status: 503 }, { status: 500 }, { network: true, status: 200 }, { status: 200, raw: '{"as":"b","nd":0}' }]) {
    reset(); const { b, t } = await fresh();
    stub.mode = m; await load(t);
    const s = await t.state();
    stub.mode = null; await load(t);
    c("C-4", s.a === null && s.b === null && posts().length === 2, `${J(m)}: ${J(s)} then ${posts().length} posts`);
    await b.stop();
  }
  // C-5: the request, byte-exact
  { reset(); const { b, t } = await fresh();
    await load(t);
    const p = posts()[0];
    c("C-5", p && p.body === '{"v":1,"day":1,"week":1,"month":1,"client":"web"}' && p.body.length === 49 && !p.headers.referer && p.headers["content-type"] === "application/json" && !new URL(p.url).search && p.method === "POST", `request: ${J(p)}`);
    // (keepalive and credentials, read from the page's own fetch call)
    const init = await t.ev(`(async () => { const f = window.fetch; let seen; window.fetch = (u, i) => { seen = i; return f(u, i); }; localStorage.removeItem("sb-active-b"); localStorage.removeItem("sb-active"); return null; })()`);
    await t.ev(`(async () => { const real = window.fetch; window.__seenInit = null; window.fetch = (u, i) => { if (String(u).endsWith("/api/active")) window.__seenInit = { keepalive: i.keepalive, credentials: i.credentials, referrerPolicy: i.referrerPolicy, cache: i.cache }; return real(u, i); }; return 1; })()`);
    void init;
    await t.ev(`localStorage.clear()`);
    await load(t, { before: `(() => { const real = window.fetch; window.fetch = (u, i) => { if (String(u).endsWith("/api/active")) window.__seenInit = { keepalive: i.keepalive, credentials: i.credentials, referrerPolicy: i.referrerPolicy, cache: i.cache }; return real(u, i); }; return 1; })()` });
    const seen = await t.ev("window.__seenInit");
    c("C-5", seen && seen.keepalive === true && seen.credentials === "same-origin" && seen.referrerPolicy === "no-referrer" && seen.cache === "no-store", "init: " + J(seen));
    await b.stop(); }
  // C-6: the work per load (upper bounds) and nothing before idle
  { reset(); const { b, t } = await fresh();
    await t.open(); await sleep(400);
    const k0 = await t.counts();
    c("C-6.pre", Object.keys(k0.get).length === 0 && Object.keys(k0.set).length === 0 && k0.locks === 0 && k0.fetch === 0 && k0.timers === 0 && k0.idle.length === 1, "before idle: " + J(k0));
    // due (signed out)
    await t.ev("window.__releaseIdle()"); await sleep(1200);
    const k1 = await t.counts();
    const reads = (k, key) => (k.get[key] ?? 0);
    const dueOk = (k) => reads(k, "sb-active") + reads(k, "sb-active-b") <= 4 && reads(k, "sb-consent") <= 3 && (k.set["sb-active"] ?? 0) + (k.set["sb-active-b"] ?? 0) <= 2 && k.locks <= 1 && k.fetch === 1;
    c("C-6.due-out", dueOk(k1) && posts().length === 1 && posts()[0].body.length <= 64, "due: " + J(k1));
    // counted
    await t.open(); await t.ev("window.__releaseIdle()"); await sleep(600);
    const k2 = await t.counts();
    c("C-6.counted", reads(k2, "sb-consent") <= 1 && reads(k2, "sb-active") + reads(k2, "sb-active-b") <= 2 && k2.locks === 0 && k2.fetch === 0, "counted: " + J(k2));
    // due, with a live session (the stub answers "a"): the same counts
    reset(); await t.ev(`localStorage.clear(); document.cookie = "__Host-sb_session=x; Secure; Path=/"`);
    stub.mode = { status: 200, as: "a" };
    await t.open(); await t.ev("window.__releaseIdle()"); await sleep(1200);
    const k3 = await t.counts();
    c("C-6.due-in", dueOk(k3) && posts().length === 1 && !!posts()[0].headers.cookie, "due, signed in: " + J(k3));
    // off
    await t.ev(`localStorage.setItem("sb-consent", "no")`);
    await t.open(); await t.ev("window.__releaseIdle()"); await sleep(500);
    const k4 = await t.counts();
    c("C-6.off", reads(k4, "sb-consent") <= 1 && reads(k4, "sb-active") + reads(k4, "sb-active-b") === 0 && k4.locks === 0 && k4.fetch === 0 && (k4.rm["sb-active"] ?? 0) + (k4.rm["sb-active-b"] ?? 0) <= 2, "off: " + J(k4));
    await b.stop(); }
  // C-6's task bound: no task attributable to the harness over 5 ms, in 5 cold contexts per path
  { let worst = 0; const ok = [];
    for (let i = 0; i < 5; i++) {
      reset(); const { b, t } = await fresh();
      await t.send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline"] }, transferMode: "ReportEvents" });
      const events = []; const done = new Promise((r) => { const prev = t.ws.onmessage; t.ws.onmessage = (ev) => { prev(ev); const m = JSON.parse(ev.data); if (m.method === "Tracing.dataCollected") events.push(...m.params.value); if (m.method === "Tracing.tracingComplete") r(); }; });
      await load(t); await load(t);
      await t.send("Tracing.end"); await done;
      const mine = events.filter((e) => e.name === "FunctionCall" && /active-harness\.js/.test(e.args?.data?.url ?? "") && e.dur);
      const w = Math.max(0, ...mine.map((e) => e.dur / 1000));
      worst = Math.max(worst, w); ok.push(w <= 5);
      await b.stop();
    }
    c("C-6.due-out", ok.every(Boolean), `worst attributable task ${worst.toFixed(2)} ms`);
    c("C-6.due-in", ok.every(Boolean), `worst attributable task ${worst.toFixed(2)} ms`); }
  // C-7: populations (signedOut through the harness: the page itself has no sign-out yet)
  const pop = async (id, steps, expect) => { reset(); const { b, t } = await fresh(); const t2 = await b.tab(); const ctx = { b, t, t2 }; let ok = true, note = ""; try { const r = await steps(ctx); ok = expect(r); note = J(r); } catch (e) { ok = false; note = String(e); } c(id, ok, `${id}: ${note}`); await b.stop(); };
  await pop("C-7.logout", async ({ t }) => { stub.mode = { status: 200, as: "a" }; await load(t); stub.mode = { status: 200, as: "b" }; await t.ev("__sbHarness.signedOut()"); const n = posts().length; await load(t); return { more: posts().length - n }; }, (r) => r.more === 1);
  await pop("C-7.signin", async ({ t }) => { await load(t); const n = posts().length; await load(t); return { more: posts().length - n }; }, (r) => r.more === 0);
  await pop("C-7.abs", async ({ t }) => { await load(t); await t.ev("__sbHarness.signedOut()"); const n = posts().length; await load(t); return { more: posts().length - n }; }, (r) => r.more === 0);
  await pop("C-7.firstweek", async ({ t }) => { stub.mode = { status: 200, as: "a" }; await load(t); stub.mode = null; await t.ev("__sbHarness.signedOut()"); const n = posts().length; await load(t); const p = posts()[n]; return { more: posts().length - n, body: p?.body }; }, (r) => r.more === 1 && /"week":1,"month":1/.test(r.body ?? ""));
  await pop("C-7.prior", async ({ t }) => { await load(t); const s1 = await t.state(); const d = durations(); stub.mode = { status: 200, as: "a" }; await load(t, { skew: (d.nd + 5) * 1000 }); const s2 = await t.state(); stub.mode = null; await t.ev("__sbHarness.signedOut()"); const s3 = await t.state(); const n = posts().length; await load(t, { skew: (d.nd + 5) * 1000 }); const p = posts()[n]; return { more: posts().length - n, body: p?.body, sameWeek: d.nw > d.nd + 5, d, s1, s2, s3, posts: posts().map((x) => x.body), now: Date.now() }; }, (r) => r.more === 1 && (r.sameWeek ? /"week":0/.test(r.body ?? "") : true));
  await pop("C-7.repeat", async ({ t }) => { await load(t); await t.ev("__sbHarness.signedOut()"); await load(t); await t.ev("__sbHarness.signedOut()"); const n = posts().length; await load(t); return { more: posts().length - n }; }, (r) => r.more === 0);
  for (const where of ["self", "other"]) await pop(`C-7.held.${where}`, async ({ t, t2 }) => {
    if (where === "other") await t2.open();
    stub.mode = { status: 200, as: "a" };
    let release; stub.hold = new Promise((r) => (release = r)); const arrived = heldArrival();
    await t.open(); await t.ev("window.__releaseIdle()"); await arrived;
    const who = where === "self" ? t : t2;
    void who.ev("window.__so = __sbHarness.signedOut().then(() => 1)");
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
    await t.ev(`localStorage.setItem("sb-active", JSON.stringify({ p: "a", ad: 1 })); localStorage.setItem("sb-active-b", JSON.stringify({ bd: 2, bw: 3, bm: 4 }))`);
    void t2.ev(`navigator.locks.request("sb-active", () => new Promise(() => {}))`);
    await sleep(300);
    const before = await t.state(); const t0 = Date.now();
    await t.ev("__sbHarness.signedOut()");
    const took = Date.now() - t0, after = await t.state();
    return { took, same: J(before) === J(after) };
  }, (r) => r.took < 13_000 && r.same);
  // C-8.static: active.ts and consent.ts are bundled into the "/" page only (the production dist)
  { const hits = [];
    const walkDist = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walkDist(p); else if (/\.(js|html|mjs)$/.test(f) && readFileSync(p, "utf8").includes("sb-active-b")) hits.push(relative(DIST, p)); } };
    walkDist(DIST);
    const harnessStrings = ["__sbHarness", "__SB_MEASURE_TEST__", "MEASURE_BARRIER"].filter((s) => readdirSync(DIST).some((f) => /\.(js|html)$/.test(f) && readFileSync(join(DIST, f), "utf8").includes(s)));
    c("C-8.static", hits.join() === "index.html" && harnessStrings.length === 0, `the counter's code in ${J(hits)}; harness strings ${J(harnessStrings)}`); }
  // C-0 and C-8.origin: the unmodified production page, on the real origin (one POST after idle) and on an unlisted one (none)
  { pageMode = "prod"; reset(); const { b, t } = await fresh();
    await t.open(ORIGIN + "/"); await sleep(2000); await t.ev("window.__releaseIdle()"); await sleep(2500);
    c("C-0.prod", posts().length === 1 && posts()[0].body.startsWith('{"v":1,'), `production / on the real origin: ${posts().length} posts`);
    const n = stub.requests.length;
    await t.open(`http://127.0.0.1:${plain.port}/`); await sleep(2000); await t.ev("window.__releaseIdle()"); await sleep(2500);
    const k = await t.counts();
    c("C-8.origin", stub.requests.length === n && !k.lockNames.includes("sb-active") && !(k.set["sb-active"] || k.set["sb-active-b"]), `unlisted origin: ${stub.requests.length - n} requests ${J(k)}`);
    await b.stop(); pageMode = "harness"; }
  // C-9: storage and lock errors: no uncaught error, no POST, no retry loop
  for (const [id, flag] of [["C-9.get", "window.__throwGet = true"], ["C-9.set", "window.__throwSet = true"], ["C-9.lockreject", "window.__lockReject = true"]]) {
    reset(); const { b, t } = await fresh();
    await load(t, { before: flag, wait: 1200 });
    const okPost = id === "C-9.set" ? posts().length <= 1 : posts().length === 0;
    c(id, t.errors.length === 0 && okPost, `${id}: ${t.errors.length} errors, ${posts().length} posts`);
    await b.stop();
  }
  { reset(); const { b, t } = await fresh("window.__noLocks = true;");
    await load(t);
    c("C-9.nolocks", t.errors.length === 0 && posts().length === 0, `no locks: ${posts().length} posts`);
    await b.stop(); }
  { reset(); const { b, t } = await fresh();
    await t.open(); await t.ev(`localStorage.setItem("sb-active", "{not json"); localStorage.setItem("sb-active-b", "[1,2")`);
    await load(t);
    const s = await t.state();
    c("C-9.malformed", t.errors.length === 0 && posts().length === 1 && JSON.parse(s.b ?? "null")?.bd > 0, `malformed: ${posts().length} posts ${J(s)}`);
    await b.stop(); }
}

// C-2b (the "ask" default) and C-2c.listener (a barrier between the final consent read and the write) need their own
// harness bundles, built here from substitutions as the controls are.
async function variantCases() {
  harnessJs = bundle([["C", 'export const MEASURE_DEFAULT: "on" | "ask" = "on";', 'export const MEASURE_DEFAULT: "on" | "ask" = "ask";']]);
  { reset(); const { b, t } = await fresh();
    await load(t);
    const k = await t.counts();
    c("C-2b", posts().length === 0 && k.locks === 0, `ask: ${posts().length} posts, ${k.locks} locks`);
    await b.stop(); }
  harnessJs = bundle([["A", "      if (!mayMeasure()) return;\n      const at = Date.now();", "      if (!mayMeasure()) return;\n      await (globalThis as any).__barrier?.();\n      const at = Date.now();"]]);
  { reset(); const { b, t } = await fresh(); const t2 = await b.tab();
    await t2.open();
    await t.open(); await t.ev(`window.__barrier = () => new Promise((r) => { window.__releaseBarrier = r; })`);
    await t.ev("window.__releaseIdle()");
    const atBarrier = await t.until("!!window.__releaseBarrier", 5000);
    await t2.ev("__sbHarness.setMeasure(false)"); await sleep(300);
    await t.ev("window.__releaseBarrier()"); await sleep(500);
    const s = await t.state();
    c("C-2c.listener", atBarrier && s.a === null && s.b === null, `a withdrawal between the final consent read and the write: ${J(s)}`);
    await b.stop(); }
}

// ---- the controls: [name, substitutions, the closed FAIL set]
const CONTROLS = [
  ["K-21", [["C", "  if (!mayMeasure()) {\n    removeNotes();\n    return;\n  }\n  await run(", "  await run("]], ["C-2a", "C-2b", "C-6.off"]],
  ["K-22", [["A", "    await locks.request(LOCK, async () => {\n      if (!mayMeasure()) return;", "    await locks.request(LOCK, async () => {"]], ["C-2c.lock"]],
  ["K-23a", [["A", "      if (!mayMeasure()) return;\n      const at = Date.now();", "      const at = Date.now();"]], ["C-2c.persist.self"]],
  ["K-23b", [["C", "    if (permits(e.newValue)) withdrawn = false;\n    else {\n      withdrawn = true;\n      removeNotes();\n    }", "    void e;"]], ["C-2c.listener"]],
  ["K-24", [["C", "  return MEASURE_DEFAULT === \"on\";", "  return true;"]], ["C-2b"]],
  ["K-25", [["A", "    await locks.request(LOCK, async () => {\n      if (!mayMeasure()) return;", "    await (async (f: any) => f())(async () => {\n      if (!mayMeasure()) return;"]], ["C-3", "C-2c.lock"]],
  ["K-26", [["A", "        if (r.status !== 200) return; // (429, 503, …: nothing written; a later load tries again)\n        ans = answerOf(await r.json());", "        ans = answerOf(await r.json().catch(() => ({ as: \"b\", nd: 86400, nw: 86400, nm: 86400 }))) ?? { as: \"b\", nd: 86400, nw: 86400, nm: 86400 };"]], ["C-4"]],
  ["K-27", [["A", ' referrerPolicy: "no-referrer",', ""]], ["C-5"]],
  ["K-28", [["A", " keepalive: true,", ""]], ["C-5"]],
  ["K-29", [["A", "if (typeof globalThis.requestIdleCallback === \"function\") globalThis.requestIdleCallback(start);\nelse globalThis.setTimeout?.(start, FETCH_MS);", "start();"]], ["C-6.pre"]],
  ["K-30", [["A", "      const body = JSON.stringify(", "      { const z = Date.now(); while (Date.now() - z < 20); }\n      const body = JSON.stringify("]], ["C-6.due-out", "C-6.due-in"]],
  ["K-31", [["A", "const due = (a: A, b: B | null, t: number) => (a.p === \"a\" ? t >= a.ad : t >= (b?.bd ?? 0));", "const due = (a: A, b: B | null, t: number) => { const m = new Date(t); m.setHours(0, 0, 0, 0); const last = a.p === \"a\" ? a.ad : (b?.bd ?? 0); return last === 0 || last - 86_400_000 < m.valueOf(); };"]], ["C-1.tz", "C-1s", "C-1d"]],
  ["K-33", [["A", "  if (!MEASURE_ORIGINS.includes(globalThis.location?.origin ?? \"\")) return;\n", ""]], ["C-8.origin"]],
  ["K-35", [["C", "    return permits(globalThis.localStorage.getItem(CONSENT_KEY));\n  } catch {\n    return false;\n  }", "    return permits(globalThis.localStorage.getItem(CONSENT_KEY));\n  } finally {\n  }"]], ["C-9.get"]],
  ["K-36", [["A", "        localStorage.setItem(KEY_A, JSON.stringify({ p: \"a\", ad: at + ans.nd * 1000 }));", "        localStorage.setItem(KEY_A, JSON.stringify({ p: \"a\", ad: at + ans.nd * 1000 }));\n        localStorage.setItem(KEY_B, JSON.stringify({ bd: at + ans.nd * 1000, bw: at + ans.nw * 1000, bm: at + ans.nm * 1000 }));"]], ["C-7.logout", "C-7.firstweek", "C-7.prior", "C-7.repeat", "C-7.held.self", "C-7.held.other"]],
  ["K-38", [["A", "      localStorage.setItem(KEY_A, JSON.stringify({ p: \"b\", ad: a.ad }));\n      afterNoteWrite();\n    });\n  } catch {", "      localStorage.setItem(KEY_A, JSON.stringify({ p: \"b\", ad: a.ad }));\n      localStorage.removeItem(KEY_B);\n      afterNoteWrite();\n    });\n  } catch {"]], ["C-7.abs", "C-7.repeat"]],
  ["K-41", [["A", "    await locks.request(LOCK, { signal: AbortSignal.timeout(SIGNOUT_LOCK_MS) }, async () => {", "    await (async (f: any) => f())(async () => {"]], ["C-7.held.self", "C-7.held.other", "C-7.hang"]],
  ["K-43", [["A", "{ signal: AbortSignal.timeout(SIGNOUT_LOCK_MS) }, ", ""]], ["C-7.hang"]],
  ["K-44", [["C", "  if (v) withdrawn = false;\n", ""], ["C", "    if (permits(e.newValue)) withdrawn = false;\n    else {", "    if (permits(e.newValue)) void 0;\n    else {"]], ["C-2c.regrant"]],
  ["K-45", [["A", "  } catch {\n    // (settled, nothing written)\n  }", "  } catch {\n    localStorage.setItem(KEY_A, JSON.stringify({ p: \"b\", ad: 0 }));\n  }"]], ["C-7.hang"]],
  ["K-GPC", [["C", "    if (HONOR_GPC && (globalThis.navigator as { globalPrivacyControl?: boolean } | undefined)?.globalPrivacyControl === true) return false;\n", ""]], ["C-1.gpc"]],
];

// ---- run
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
    // (the two variant cases, with the control's change applied on top of their own)
    const vs = [["C", 'export const MEASURE_DEFAULT: "on" | "ask" = "on";', 'export const MEASURE_DEFAULT: "on" | "ask" = "ask";']];
    try { harnessJs = bundle([...subs, ...vs]); } catch { harnessJs = bundle(subs); }
    { reset(); const { b, t } = await fresh(); await load(t); const k = await t.counts(); c("C-2b", posts().length === 0 && k.locks === 0, "ask"); await b.stop(); }
    try {
      harnessJs = bundle([...subs, ["A", "      if (!mayMeasure()) return;\n      const at = Date.now();", "      if (!mayMeasure()) return;\n      await (globalThis as any).__barrier?.();\n      const at = Date.now();"]]);
    } catch {
      harnessJs = bundle([...subs, ["A", "      const at = Date.now();", "      await (globalThis as any).__barrier?.();\n      const at = Date.now();"]]);
    }
    { reset(); const { b, t } = await fresh(); const t2 = await b.tab(); await t2.open(); await t.open(); await t.ev(`window.__barrier = () => new Promise((r) => { window.__releaseBarrier = r; })`); await t.ev("window.__releaseIdle()"); const at = await t.until("!!window.__releaseBarrier", 5000); await t2.ev("__sbHarness.setMeasure(false)"); await sleep(300); await t.ev("window.__releaseBarrier && window.__releaseBarrier()"); await sleep(500); const s = await t.state(); c("C-2c.listener", at && s.a === null && s.b === null, "listener"); await b.stop(); }
    const f = [...results].filter(([, v]) => !v).map(([k]) => k).sort(), w = [...want].sort();
    const ok = f.length > 0 && f.join() === w.join();
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${ok ? "exactly its set" : `failed {${f.join(", ")}}, wanted {${w.join(", ")}}`} (${((Date.now() - t1) / 1000).toFixed(0)} s)`);
    if (!ok) bad++;
  }
}
front.stop(true); plain.stop(true);
rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `${bad} problems` : "every case passed and every control failed exactly its set");
process.exit(bad ? 1 : 0);
