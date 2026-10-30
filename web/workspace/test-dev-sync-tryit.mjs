// The DEV try-it flow for notebook sync, end to end on the real notebook page: two browsers (two Chrome processes,
// each its own profile: two devices of one account) open the built site as https://dev.sagebrush.space (the only
// origin notebooks' contents sync on, web/workspace/doc-sync-switch.ts), which Chrome maps to a front here with a
// self-signed certificate; the front serves web/dist with its _headers and passes the sync API, the account socket and
// /__files to core's reference server (web/sync-protocol/reference-server.ts), in this process.  Each browser signs in
// (the reference server's /auth/dev sets the real __Host- session cookie) and then does what a person does:
//   2. Files sidebar, Storage…, "Turn on sync…" (the confirm accepted), then a reload: the sidebar says "Synced";
//   3. the Files sidebar's New makes a notebook with the journal on (it was refused); a notebook made with File, New
//      and typed in one browser is listed in the other, which, clicking it in Files before any of its history has
//      arrived (the front holds that browser's `changed`), says it is still arriving, writes nothing and asks for
//      its pull; with nothing more from the first browser, a click again opens it with its cell; an edit there comes back;
//   4. different cells edited in both at once: both kept, the two the same; the same cell in both: the two the same;
//   5. a data file made, renamed and moved to Trash in one appears, follows and goes in the other;
//   6. one browser offline (its network emulated off, and cut at the front): it says "Offline: …"; an edit made
//      there reaches the other once it is back online, and it says "Synced" again;
//   7, 8. second tabs (regression guards of today's behaviour): a second tab of the other browser opens a notebook
//      still arriving once its history is here; a notebook made in a second tab of the first reaches the other.
// Before the reload (step 2), whether a notebook typed in one browser reaches the other is said (OBS), not checked:
// the switch is decided at a page's load.  Every wait is bounded; a watchdog ends an overrunning run.
//   bun web/build.ts, then CHROME=chromium bun web/workspace/test-dev-sync-tryit.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ReferenceServer, SESSION_COOKIE } from "../sync-protocol/reference-server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = process.env.SITE ?? join(here, "..", "dist");
const ORIGIN = "https://dev.sagebrush.space";
const ACCOUNT = "7e57d5d5-0000-4ccc-8ccc-7e57d5d5d5d5";
const RUN_S = Number(process.env.TRYIT_RUN_S ?? 540);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
const fails = [];
let checks = 0, last = "(none yet)";
const check = (ok, what) => { checks++; last = what; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); return ok; };
const obs = (what, x) => console.log(`OBS  ${what}: ${typeof x === "string" ? x : J(x)}`);

if (!existsSync(join(DIST, "index.html"))) { console.log(`FAIL no built site at ${DIST} (bun web/build.ts first)`); process.exit(1); }
const tmp = mkdtempSync(join(tmpdir(), "sb-tryit-"));
const browsers = [];
let closing = false;
async function cleanup(code) {
  if (closing) return;
  closing = true;
  clearTimeout(watchdog);
  for (const b of browsers) await b.stop();
  try { front?.stop(true); } catch {}
  rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}
const watchdog = setTimeout(() => { console.log(`FAIL the run didn't end within ${RUN_S} s; the last check was ${J(last)}`); cleanup(1); }, RUN_S * 1000);
process.on("SIGTERM", () => cleanup(1));

// ---- the certificate: dev.sagebrush.space, self-signed, for this run only
const key = join(tmp, "key.pem"), cert = join(tmp, "cert.pem");
const ssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=dev.sagebrush.space", "-addext", "subjectAltName=DNS:dev.sagebrush.space"], { encoding: "utf8" });
if (ssl.status !== 0) { console.log("FAIL openssl: " + ssl.stderr.slice(0, 300)); await cleanup(1); }

// ---- the site's headers (web/dist/_headers: a path pattern, then its headers indented)
const rules = [];
for (const line of readFileSync(join(DIST, "_headers"), "utf8").split("\n")) {
  if (!line.trim() || line.trim().startsWith("#")) continue;
  if (!/^\s/.test(line)) rules.push({ pat: line.trim(), h: [] });
  else { const i = line.indexOf(":"); rules.at(-1)?.h.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); }
}
const headersFor = (p) => rules.filter((r) => (r.pat.endsWith("*") ? p.startsWith(r.pat.slice(0, -1)) : p === r.pat)).flatMap((r) => r.h);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".md": "text/plain", ".woff2": "font/woff2", ".ttf": "font/ttf" };

// ---- the server, and the front
const ref = new ReferenceServer();
// (a browser's network cut at the front: its session's requests refused and its socket closed, as offline)
const cut = new Set(), holdChanged = new Set();
const sockets = new Set();
const sessionOf = (req) => (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(SESSION_COOKIE + "="))?.slice(SESSION_COOKIE.length + 1) ?? null;
const front = Bun.serve({
  port: 0, hostname: "127.0.0.1", tls: { cert: Bun.file(cert), key: Bun.file(key) },
  async fetch(req, server) {
    const u = new URL(req.url), p = u.pathname, s = sessionOf(req);
    if (s && cut.has(s) && (p.startsWith("/api/") || p.startsWith("/__files/"))) return new Response("offline", { status: 503 });
    if (p === "/api/sync/v1/account") return server.upgrade(req, { data: { cookie: req.headers.get("cookie"), session: s } }) ? undefined : new Response("no", { status: 400 });
    if (p === "/api/share/me") return s ? Response.json({ account_id: ACCOUNT }) : Response.json({ error: "sign in first" }, { status: 401 });
    if (p === "/auth/dev" || p.startsWith("/api/sync/") || p.startsWith("/__files/")) {
      const h = new Headers();
      // (content-length too: the reference server checks a blob's PUT against it, as the site's server does; a Request
      // made from an ArrayBuffer carries none, sync-docs' finding on run 3)
      for (const k of ["cookie", "content-type", "content-length", "x-sync-account", "x-sync-generation"]) { const v = req.headers.get(k); if (v) h.set(k, v); }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      const r = await ref.fetch(new Request(ORIGIN + p + u.search, { method: req.method, headers: h, body }));
      const out = new Headers();
      for (const k of ["content-type", "cache-control", "retry-after", "location", "set-cookie", "content-length"]) { const v = r.headers.get(k); if (v !== null) out.set(k, v); }
      for (const [k, v] of r.headers) if (/^x-sync-/.test(k)) out.set(k, v);
      return new Response([204, 205, 304].includes(r.status) || req.method === "HEAD" ? null : await r.arrayBuffer(), { status: r.status, headers: out });
    }
    if (p.startsWith("/api/") || p.startsWith("/auth/")) return Response.json({ error: "not here" }, { status: 404 });
    let f = normalize(join(DIST, decodeURIComponent(p)));
    if (!f.startsWith(DIST)) return new Response("no", { status: 403 });
    if (p.endsWith("/")) f = join(f, "index.html");
    if (!existsSync(f)) return new Response("not found", { status: 404 });
    const h = new Headers({ "content-type": TYPES[extname(f)] ?? "application/octet-stream" });
    for (const [k, v] of headersFor(p)) h.set(k, v);
    // (the service worker is not this test's: a page that registers it gets a 404, as a page whose registration fails)
    if (p === "/sw.js") return new Response("not here", { status: 404 });
    return new Response(Bun.file(f), { headers: h });
  },
  websocket: {
    async open(ws) {
      if (ws.data.session && cut.has(ws.data.session)) return ws.close(1001, "offline");
      const s = await ref.connect(ws.data.cookie);
      if (!s.send) return ws.close(4401, "no session");
      ws.data.s = s;
      sockets.add(ws);
      // (a browser's `changed` held back here while asked: it lists another device's notebook, but has none of its history)
      s.onmessage = (text) => { if (holdChanged.has(ws.data.session) && /^\{"t":"changed"/.test(text)) return; try { ws.send(text); } catch {} };
      s.onclose = (code) => { try { ws.close(code === 1005 ? 1000 : code); } catch {} };
      for (const m of ws.data.early ?? []) s.send(m);
    },
    message(ws, m) { if (ws.data.s) ws.data.s.send(String(m)); else (ws.data.early ??= []).push(String(m)); },
    close(ws) { sockets.delete(ws); try { ws.data.s?.close(); } catch {} },
  },
});

// ---- a browser: its own Chrome and profile, dev.sagebrush.space mapped to the front
class Browser {
  constructor(name) { this.name = name; this.errors = []; this.dialogs = []; browsers.push(this); }
  async start() {
    this.profile = mkdtempSync(join(tmp, `chrome-${this.name}-`));
    this.proc = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,900", `--user-data-dir=${this.profile}`,
      `--host-resolver-rules=MAP dev.sagebrush.space 127.0.0.1:${front.port}`, "--ignore-certificate-errors", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const port = await new Promise((ok, no) => {
      let buf = "";
      const t = setTimeout(() => no(new Error("no DevTools port")), 30_000);
      this.proc.stderr.on("data", (d) => { buf += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(buf); if (m) { clearTimeout(t); ok(Number(m[1])); } });
    });
    this.port = port;
    let targets;
    for (let i = 0; i < 300 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(100); } }
    await this.attach(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  }
  /** Another tab of this browser (its profile, its storage): a page target of its own, driven as this one is. */
  async newTab(name) {
    let target;
    for (let i = 0; i < 100 && !target; i++) { try { target = await (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: "PUT" })).json(); } catch { await sleep(100); } }
    const t = new Browser(name);
    t.tabOf = this; t.port = this.port; t.targetId = target.id;
    await t.attach(target.webSocketDebuggerUrl);
    return t;
  }
  async attach(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    await new Promise((r) => (this.ws.onopen = r));
    this.n = 0; this.waiting = new Map();
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) { this.waiting.get(m.id)(m.result ?? m.error); this.waiting.delete(m.id); }
      if (m.method === "Runtime.exceptionThrown") this.errors.push(m.params.exceptionDetails?.exception?.description?.slice(0, 300) ?? "exception");
      if (m.method === "Page.javascriptDialogOpening") { this.dialogs.push(m.params.message.slice(0, 200)); this.send("Page.handleJavaScriptDialog", { accept: true, promptText: "" }); }
    };
    for (const m of ["Page.enable", "Runtime.enable", "Network.enable"]) await this.send(m);
  }
  async stop() {
    try { this.ws?.close(); } catch {}
    if (this.tabOf) { try { await fetch(`http://127.0.0.1:${this.port}/json/close/${this.targetId}`); } catch {} return; }
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      await Promise.race([new Promise((r) => this.proc.once("exit", r)), sleep(5000)]);
      if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
    }
  }
  send(method, params = {}) { return new Promise((r) => { const id = ++this.n; this.waiting.set(id, r); this.ws.send(J({ id, method, params })); setTimeout(() => { if (this.waiting.has(id)) { this.waiting.delete(id); r({ error: "timeout " + method }); } }, 30_000); }); }
  async ev(expression) { const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails || r?.error) throw new Error(J(r.exceptionDetails?.exception?.description ?? r.exceptionDetails ?? r.error).slice(0, 300)); return r.result?.value; }
  async until(expr, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await this.ev(expr).catch(() => false)) return true; await sleep(150); } return false; }
  async go(url = ORIGIN + "/") {
    const nav = await this.send("Page.navigate", { url });
    await sleep(300);
    const ok = await this.until("!!window.sagebrush?.workspace && document.querySelectorAll('#cells .cell').length > 0", 45_000);
    // (a load that doesn't come up: what the page was, said, so a slow or stuck load can be told apart)
    if (!ok) obs(`${this.name}: the load that didn't come up`, { nav, page: await this.ev(`({ href: location.href, ready: document.readyState, ws: !!window.sagebrush?.workspace, cells: document.querySelectorAll("#cells .cell").length, status: document.querySelector("#status")?.textContent ?? null, title: document.title })`).catch((e) => String(e).slice(0, 200)), errors: this.errors.slice(0, 3) });
    return ok;
  }
  syncLine() { return this.ev(`document.querySelector("#wssidebar .fsync")?.textContent ?? null`); }
  codes() { return this.ev(`[...document.querySelectorAll("#cells .cell textarea")].map((t) => t.value)`); }
  has(code) { return `[...document.querySelectorAll("#cells .cell textarea")].some((t) => t.value === ${J(code)})`; }
  async type(i, code) {
    return this.ev(`(() => { while (document.querySelectorAll("#cells .cell").length <= ${i}) document.querySelector("#add").click(); const ta = document.querySelectorAll("#cells .cell textarea")[${i}]; if (ta.readOnly || ta.disabled) return "read-only"; ta.focus(); ta.value = ${J(code)}; ta.dispatchEvent(new Event("input", { bubbles: true })); return "typed"; })()`);
  }
  click(text, sel = "button") { return this.ev(`(() => { const b = [...document.querySelectorAll(${J(sel)})].find((x) => x.textContent.trim() === ${J(text)} && !x.disabled); if (!b) return false; b.click(); return true; })()`); }
  async offline(on) {
    await this.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const s = await this.ev(`fetch("/api/share/me").then((r) => r.ok).catch(() => "unreachable")`).catch(() => null);
    return s;
  }
}
const W = "window.sagebrush.workspace";
const row = (p) => `[...document.querySelectorAll("#wssidebar .frow")].some((r) => r.dataset.path === ${J(p)})`;

try {
  const A = new Browser("A"), B = new Browser("B");
  await A.start(); await B.start();
  // ---- 1. each signs in (the session cookie on the page's own origin), the Files sidebar shown
  for (const b of [A, B]) {
    check(await b.go(), `${b.name}: the notebook page opens as ${ORIGIN}`);
    const signed = await b.ev(`fetch("/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: ${J(ACCOUNT)} }) }).then((r) => r.status)`);
    await b.ev(`localStorage.setItem("sagebrush-files-sidebar", "1")`);
    check(signed === 204 && (await b.go()), `${b.name}: signed in (${signed}), reloaded`);
    b.session = (await b.send("Network.getCookies", { urls: [ORIGIN + "/"] })).cookies?.find((c) => c.name === SESSION_COOKIE)?.value ?? null;
    check(!!b.session, `${b.name}: holds the __Host- session cookie`);
  }
  // ---- 2. sync turned on in each: Storage…, Turn on sync…, the confirm accepted
  for (const b of [A, B]) {
    check(await b.until(`!!document.querySelector("#wssidebar .fh button[aria-label=More]")`, 10_000), `${b.name}: the Files sidebar is shown`);
    await b.ev(`document.querySelector("#wssidebar .fh button[aria-label=More]").click()`);
    check(await b.until(`[...document.querySelectorAll(".sbfmenu button")].some((x) => x.textContent === "Storage…")`, 5000), `${b.name}: ⋯ offers Storage…`);
    await b.ev(`[...document.querySelectorAll(".sbfmenu button")].find((x) => x.textContent === "Storage…").click()`);
    check(await b.until(`[...document.querySelectorAll("button")].some((x) => x.textContent.trim() === "Turn on sync…" && !x.disabled)`, 15_000), `${b.name}: the Storage panel offers "Turn on sync…"`);
    await b.click("Turn on sync…");
    const on = await b.until(`[...document.querySelectorAll("button")].some((x) => x.textContent.trim() === "Turn off sync here")`, 20_000);
    obs(`${b.name}'s dialogs`, b.dialogs.splice(0));
    check(on, `${b.name}: sync is on ("Turn off sync here" offered)`);
    obs(`${b.name}'s sync line after turning on`, await b.syncLine());
  }
  // (before any reload: a notebook typed in A, and whether B gets it: said, not checked)
  const pre = await A.ev(`${W}.create("/Before reload.ipynb", { mode: "python" }).then((e) => "made " + e.path, (e) => "refused: " + (e?.message ?? e))`);
  obs("before the reload: A makes a notebook", pre);
  if (pre.startsWith("made")) obs("before the reload: B lists A's new notebook", await B.until(row("/Before reload.ipynb"), 15_000));
  // ---- the reload the try-it script asks for
  for (const b of [A, B]) {
    check(await b.go(), `${b.name}: reloaded after turning sync on`);
    check(await b.until(`/^Synced/.test(document.querySelector("#wssidebar .fsync")?.textContent ?? "")`, 30_000), `${b.name}: the sidebar says Synced (${J(await b.syncLine())})`);
  }
  // ---- 3. a notebook made and typed in A appears, with its cell, in B; B's edit comes back
  // (the Files sidebar's New, Notebook, with the journal on: a notebook made, listed (it was refused before the fix))
  const notebooks = () => A.ev(`${W}.list("/", { recursive: true }).then((l) => l.filter((e) => e.kind === "notebook").map((e) => ({ path: e.path, ref: e.ref })))`);
  const nb0 = await notebooks();
  await A.ev(`document.querySelector("#wssidebar .fh button[aria-label=New]").click()`);
  await A.until(`[...document.querySelectorAll(".sbfmenu button")].some((x) => x.textContent === "Notebook")`, 5000);
  await A.ev(`[...document.querySelectorAll(".sbfmenu button")].find((x) => x.textContent === "Notebook")?.click()`);
  let nb1 = nb0;
  for (let i = 0; i < 40 && nb1.length === nb0.length; i++) { await sleep(250); nb1 = await notebooks(); }
  check(nb1.length === nb0.length + 1, `A: the Files sidebar's New, Notebook makes one with sync on (${J({ made: nb1.filter((x) => !nb0.some((y) => y.ref === x.ref)).map((x) => x.path), toast: await A.ev(`document.querySelector("#wssidebar .ftoast")?.textContent ?? null`) })})`);
  await A.ev(`document.activeElement?.blur?.()`);
  // (B's `changed` held from here: it will list A's next notebook with none of its history, as one still arriving)
  holdChanged.add(B.session);
  // (the notebook page's File, New: a new notebook, opened here, typed into, then named SyncTest)
  await A.ev(`document.querySelector('[data-f="new"]').click()`);
  let ref3 = null;
  for (let i = 0; i < 60 && !ref3; i++) { const l = await notebooks(); ref3 = l.find((x) => !nb1.some((y) => y.ref === x.ref))?.ref ?? null; if (!ref3) await sleep(250); }
  check(!!ref3, `A: File, New makes a notebook with sync on (${J(await A.ev(`document.querySelector("#saved")?.textContent ?? ""`))})`);
  if (!ref3) throw new Error("no notebook to sync: File, New made none");
  check((await A.type(0, "x = 1")) === "typed", "A types x = 1");
  const named = await A.ev(`(() => { const n = document.querySelector("#nbname"); n.value = "SyncTest"; n.dispatchEvent(new Event("input", { bubbles: true })); n.dispatchEvent(new Event("change", { bubbles: true })); n.blur(); return n.value; })()`);
  await sleep(1500);
  const path3 = (await notebooks()).find((x) => x.ref === ref3)?.path;
  obs("A's new notebook", { named, path: path3 });
  check(await B.until(row(path3), 20_000), `B's Files list ${path3} within 20 s`);
  // (B opens it as a person does: its row in Files, clicked.  First with none of its history: still arriving, said,
  // nothing written, B's own notebook left as it was)
  const hasRecord = (b) => b.ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush"); r.onsuccess = () => { try { const g = r.result.transaction("notebooks").objectStore("notebooks").get(${J(ref3)}); g.onsuccess = () => { ok(g.result ? { cells: (g.result.cells ?? []).length, j: g.result.j ?? null } : null); r.result.close(); }; g.onerror = () => ok("error"); } catch (e) { ok(String(e)); } }; r.onerror = () => ok("no db"); })`);
  const clickRow = (b) => b.ev(`[...document.querySelectorAll("#wssidebar .frow")].find((r) => r.dataset.path === ${J(path3)})?.click()`);
  const nameB = await B.ev(`document.querySelector("#nbname")?.value`);
  await clickRow(B);
  const said = await B.until(`/still arriving/.test(document.querySelector("#wssidebar .ftoast")?.textContent ?? "")`, 10_000);
  check(said && (await B.ev(`document.querySelector("#nbname")?.value`)) === nameB && (await hasRecord(B)) === null, `B, with none of its history yet: "still arriving" said, nothing opened or written (${J({ toast: await B.ev(`document.querySelector("#wssidebar .ftoast")?.textContent ?? null`), record: await hasRecord(B) })})`);
  check((await B.ev(`window.sagebrush.open(crypto.randomUUID())`)) === false, "B: a notebook not listed: open() false, as before");
  // (its `changed` let through, but none sent again: A doesn't edit, as when B was closed while A made it.  B's click
  // asks for the pull itself (DOC_SYNC.pull); B clicks again, as a person would, until it opens)
  holdChanged.delete(B.session);
  let opened = false;
  for (let i = 0; i < 15 && !opened; i++) { await clickRow(B); opened = await B.until(`document.querySelector("#nbname")?.value === "SyncTest"`, 2000); }
  // (where the notebook's history is: the server's documents, and each browser's history rows that name it)
  const histKeys = (b) => b.ev(`(async () => { const out = {}; for (const { name } of await indexedDB.databases()) { const db = await new Promise((ok) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); }); if (!db) continue; for (const s of db.objectStoreNames) { if (!/history/.test(s)) continue; const keys = await new Promise((ok) => { const g = db.transaction(s).objectStore(s).getAllKeys(); g.onsuccess = () => ok(g.result); g.onerror = () => ok([]); }); const mine = keys.filter((k) => JSON.stringify(k).includes(${J(ref3)})); if (mine.length) out[name + "/" + s] = { n: mine.length, first: mine.slice(0, 3).map((k) => JSON.stringify(k).slice(0, 80)) }; } db.close(); } return out; })()`);
  obs("the server's documents", [...(ref.accounts?.get(ACCOUNT)?.docs ?? new Map()).entries()].map(([k, d]) => ({ doc: String(k).slice(0, 60), head: d.head, batches: d.batches?.length })));
  obs("A's history rows naming SyncTest", await histKeys(A).catch((e) => String(e)));
  obs("B's history rows naming SyncTest", await histKeys(B).catch((e) => String(e)));
  obs("B after clicking SyncTest in Files", { opened, name: await B.ev(`document.querySelector("#nbname")?.value`), saved: await B.ev(`document.querySelector("#saved")?.textContent`), toast: await B.ev(`document.querySelector("#wssidebar .ftoast")?.textContent ?? null`), record: await hasRecord(B), syncA: await A.syncLine(), syncB: await B.syncLine() });
  check(opened, "B opens SyncTest from its Files once its history is here (within 30 s)");
  if (!opened) throw new Error("B couldn't open the notebook A made: the rest of the flow needs it");
  check(await B.until(B.has("x = 1"), 20_000), `B shows A's cell within 20 s (${J(await B.codes())})`);
  check((await B.type(1, "y = 2")) === "typed", "B types y = 2 in a second cell");
  check(await A.until(A.has("y = 2"), 20_000), `…and A shows it within 20 s (${J(await A.codes())})`);
  // ---- 4. at once: different cells (both kept), then the same cell (the two the same)
  await Promise.all([A.type(0, "x = 10"), B.type(1, "y = 20")]);
  const both = await A.until(`${A.has("x = 10")} && ${A.has("y = 20")}`, 25_000) && await B.until(`${B.has("x = 10")} && ${B.has("y = 20")}`, 25_000);
  check(both, `different cells edited at once: both kept on both (A ${J(await A.codes())}, B ${J(await B.codes())})`);
  await A.type(0, "x = 100"); await sleep(300); await B.type(0, "x = 200");
  let same = false;
  for (let i = 0; i < 100 && !same; i++) { const [a, b] = [await A.codes(), await B.codes()]; same = J(a) === J(b) && ["x = 100", "x = 200"].includes(a[0]); if (!same) await sleep(250); }
  const [a4, b4] = [await A.codes(), await B.codes()];
  check(same, `the same cell edited in both: the two converge (A ${J(a4)}, B ${J(b4)})`);
  // (what the merge kept, said whole: on DEV's early 2c-3 both edits may stay, as two cells, where the Sync panel's note
  // says the later is kept)
  obs("the same cell edited in both: the cells both have", a4);
  // ---- 5. a data file made, renamed and moved to Trash in A; followed in B
  await A.ev(`${W}.create("/data.csv", { content: "1,2,3\\n" })`);
  check(await B.until(row("/data.csv"), 20_000), "a file made in A appears in B's Files within 20 s");
  check(await B.until(`${W}.read("/data.csv").then((r) => new TextDecoder().decode(r.content) === "1,2,3\\n").catch(() => false)`, 20_000), "…with its bytes");
  await A.ev(`${W}.rename("/data.csv", "/numbers.csv")`);
  check(await B.until(`${row("/numbers.csv")} && !${row("/data.csv")}`, 20_000), "renamed in A: renamed in B");
  await A.ev(`${W}.remove("/numbers.csv")`);
  check(await B.until(`!${row("/numbers.csv")}`, 20_000), "moved to Trash in A: gone from B's Files");
  // ---- 6. B offline, an edit there, B back: it reaches A, and B says Synced
  cut.add(B.session);
  for (const ws of sockets) if (ws.data.session === B.session) ws.close(1001, "offline");
  await B.offline(true);
  check(await B.until(`/^Offline/.test(document.querySelector("#wssidebar .fsync")?.textContent ?? "")`, 30_000), `B offline: its sidebar says Offline (${J(await B.syncLine())})`);
  check((await B.type(0, "x = offline")) === "typed", "B types while offline");
  await sleep(2000);
  check(!(await A.ev(A.has("x = offline"))), "…which A doesn't have yet");
  obs("B's sync line while offline, after typing", await B.syncLine());
  cut.delete(B.session);
  await B.offline(false);
  check(await A.until(A.has("x = offline"), 45_000), "B back online: its edit reaches A within 45 s");
  check(await B.until(`/^Synced/.test(document.querySelector("#wssidebar .fsync")?.textContent ?? "")`, 45_000), `…and B says Synced again (${J(await B.syncLine())})`);
  // ---- 7. a second tab of B (B's first tab holds the account connection) clicking a notebook still arriving: said,
  // then, with nothing more from A, opened once its history is here (a regression guard of today's behaviour:
  // sync-docs' N-2C3-2 asked whether a second tab gets its pull; it does)
  const B2 = await B.newTab("B2");
  check(await B2.go(), "B2: a second tab of B opens the notebook page");
  await sleep(22_000); // (its switch decided: it waits up to 20 s for a client of its own)
  holdChanged.add(B.session);
  const nb7 = await notebooks();
  await A.ev(`document.querySelector('[data-f="new"]').click()`);
  let ref7 = null;
  for (let i = 0; i < 60 && !ref7; i++) { const l = await notebooks(); ref7 = l.find((x) => !nb7.some((y) => y.ref === x.ref))?.ref ?? null; if (!ref7) await sleep(250); }
  check(!!ref7 && (await A.type(0, "w = 7")) === "typed", "A: another notebook, made with File, New and typed into");
  await sleep(1500);
  const path7 = (await notebooks()).find((x) => x.ref === ref7)?.path;
  check(await B2.until(row(path7), 20_000), `B2's Files list ${path7}`);
  const click7 = () => B2.ev(`[...document.querySelectorAll("#wssidebar .frow")].find((r) => r.dataset.path === ${J(path7)})?.click()`);
  await click7();
  check(await B2.until(`/still arriving/.test(document.querySelector("#wssidebar .ftoast")?.textContent ?? "")`, 10_000), "B2, with none of its history: \"still arriving\" said");
  holdChanged.delete(B.session);
  let opened7 = false;
  for (let i = 0; i < 15 && !opened7; i++) { await click7(); opened7 = await B2.until(B2.has("w = 7"), 2000); }
  check(opened7, `B2 opens it with A's cell, nothing more from A (within 30 s; ${J(await B2.codes())})`);
  // ---- 8. a notebook made and typed in a second tab of A reaches B (a regression guard of today's behaviour)
  const A2 = await A.newTab("A2");
  await A2.go();
  await sleep(22_000);
  const nb8 = await notebooks();
  await A2.ev(`document.querySelector('[data-f="new"]').click()`);
  let ref8 = null;
  for (let i = 0; i < 60 && !ref8; i++) { const l = await notebooks(); ref8 = l.find((x) => !nb8.some((y) => y.ref === x.ref))?.ref ?? null; if (!ref8) await sleep(250); }
  const typed8 = ref8 ? await A2.type(0, "v = 8") : "no notebook";
  await sleep(1500);
  const path8 = ref8 ? (await notebooks()).find((x) => x.ref === ref8)?.path : null;
  let reached8 = false;
  if (path8) for (let i = 0; i < 15 && !reached8; i++) { await B.ev(`[...document.querySelectorAll("#wssidebar .frow")].find((r) => r.dataset.path === ${J(path8)})?.click()`); reached8 = await B.until(B.has("v = 8"), 2000); }
  check(typed8 === "typed" && !!path8 && reached8, `a notebook made and typed in A's second tab opens in B with its cell (within 30 s; ${J({ typed8, path8, reached8, server: [...(ref.accounts?.get(ACCOUNT)?.docs?.keys() ?? [])].includes(ref8) })})`);
  void pre;
  for (const b of browsers) for (const e of b.errors) fails.push(`${b.name}: page error: ${e}`);
} catch (e) {
  fails.push("threw: " + String(e?.stack ?? e).slice(0, 600));
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: the DEV try-it flow, ${checks} checks`);
await cleanup(fails.length ? 1 : 0);
