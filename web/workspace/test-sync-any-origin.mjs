// ci: web-sync.2 order=90 runner=bun chrome
// Files sync on a page loaded after sync was turned on, on an origin that is not one of the hosted sites (a self-hosted
// server's, here https://files-sync.example.test): two browsers (two Chrome processes, each its own profile: two devices
// of one account) open the built site there, which Chrome maps to a front with a self-signed certificate; the front
// serves web/dist and passes the sync API and the account socket to core's reference server, in this process.  Each
// browser signs in and turns sync on (Files, Storage…, "Turn on sync…"), then:
//   1. after a reload: the sidebar says Synced (not an empty line); a file made in one reaches the other with its bytes,
//      and an edit made there comes back;
//   2. after opening a notebook (a page load at /?nb=): the same, both ways;
//   3. with its account socket refused: a file made there is not "Synced" in its line, which names it as not sent;
//      once let through, the file reaches the other and the line says Synced again.
// Notebooks' contents don't sync on this origin (web/workspace/doc-sync-switch.ts): that is not asked here.  Every
// wait is bounded; a watchdog ends an overrunning run.
//   bun web/build.ts, then CHROME=chromium bun web/workspace/test-sync-any-origin.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ReferenceServer, SESSION_COOKIE } from "../sync-protocol/reference-server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = process.env.SITE ?? join(here, "..", "dist");
const HOST = "files-sync.example.test";
const ORIGIN = "https://" + HOST;
const ACCOUNT = "7e57d5d5-0000-4ccc-8ccc-7e57d5d5d5d6";
const RUN_S = Number(process.env.ANY_ORIGIN_RUN_S ?? 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
const fails = [];
let checks = 0, last = "(none yet)";
const check = (ok, what) => { checks++; last = what; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); return ok; };

if (!existsSync(join(DIST, "index.html"))) { console.log(`FAIL no built site at ${DIST} (bun web/build.ts first)`); process.exit(1); }
const tmp = mkdtempSync(join(tmpdir(), "sb-anyorigin-"));
const browsers = [];
let closing = false, front;
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

const key = join(tmp, "key.pem"), cert = join(tmp, "cert.pem");
const ssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=" + HOST, "-addext", "subjectAltName=DNS:" + HOST], { encoding: "utf8" });
if (ssl.status !== 0) { console.log("FAIL openssl: " + ssl.stderr.slice(0, 300)); await cleanup(1); }
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".ttf": "font/ttf" };

// ---- the server, and the front (a session's account socket refused while it is in `refused`)
const ref = new ReferenceServer();
const refused = new Set(), sockets = new Set();
const sessionOf = (req) => (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(SESSION_COOKIE + "="))?.slice(SESSION_COOKIE.length + 1) ?? null;
front = Bun.serve({
  port: 0, hostname: "127.0.0.1", tls: { cert: Bun.file(cert), key: Bun.file(key) },
  async fetch(req, server) {
    const u = new URL(req.url), p = u.pathname, s = sessionOf(req);
    if (p === "/api/sync/v1/account") {
      if (s && refused.has(s)) return new Response("refused (a test)", { status: 503 });
      return server.upgrade(req, { data: { cookie: req.headers.get("cookie"), session: s } }) ? undefined : new Response("no", { status: 400 });
    }
    if (p === "/api/share/me") return s ? Response.json({ account_id: ACCOUNT }) : Response.json({ error: "sign in first" }, { status: 401 });
    if (p === "/auth/dev" || p.startsWith("/api/sync/") || p.startsWith("/__files/")) {
      const h = new Headers();
      for (const k of ["cookie", "content-type", "content-length", "x-sync-account", "x-sync-generation", "x-sb-ct-sha256"]) { const v = req.headers.get(k); if (v) h.set(k, v); }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      const r = await ref.fetch(new Request(ORIGIN + p + u.search, { method: req.method, headers: h, body }));
      const out = new Headers();
      for (const k of ["content-type", "cache-control", "retry-after", "location", "set-cookie", "content-length"]) { const v = r.headers.get(k); if (v !== null) out.set(k, v); }
      for (const [k, v] of r.headers) if (/^x-sync-/.test(k)) out.set(k, v);
      return new Response([204, 205, 304].includes(r.status) || req.method === "HEAD" ? null : await r.arrayBuffer(), { status: r.status, headers: out });
    }
    if (p.startsWith("/api/") || p.startsWith("/auth/")) return Response.json({ error: "not here" }, { status: 404 });
    if (p === "/sw.js") return new Response("not here", { status: 404 });
    let f = normalize(join(DIST, decodeURIComponent(p)));
    if (!f.startsWith(DIST)) return new Response("no", { status: 403 });
    if (p.endsWith("/")) f = join(f, "index.html");
    if (!existsSync(f)) return new Response("not found", { status: 404 });
    return new Response(Bun.file(f), { headers: { "content-type": TYPES[extname(f)] ?? "application/octet-stream" } });
  },
  websocket: {
    async open(ws) {
      const s = await ref.connect(ws.data.cookie);
      if (!s.send) return ws.close(4401, "no session");
      ws.data.s = s;
      sockets.add(ws);
      s.onmessage = (text) => { try { ws.send(text); } catch {} };
      s.onclose = (code) => { try { ws.close(code === 1005 ? 1000 : code); } catch {} };
      for (const m of ws.data.early ?? []) s.send(m);
    },
    message(ws, m) { if (ws.data.s) ws.data.s.send(String(m)); else (ws.data.early ??= []).push(String(m)); },
    close(ws) { sockets.delete(ws); try { ws.data.s?.close(); } catch {} },
  },
});

// ---- a browser: its own Chrome and profile, HOST mapped to the front
class Browser {
  constructor(name) { this.name = name; this.errors = []; browsers.push(this); }
  async start() {
    this.profile = mkdtempSync(join(tmp, `chrome-${this.name}-`));
    this.proc = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,900", `--user-data-dir=${this.profile}`,
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${front.port}`, "--ignore-certificate-errors", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const port = await new Promise((ok, no) => {
      let buf = "";
      const t = setTimeout(() => no(new Error("no DevTools port")), 30_000);
      this.proc.stderr.on("data", (d) => { buf += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(buf); if (m) { clearTimeout(t); ok(Number(m[1])); } });
    });
    let targets;
    for (let i = 0; i < 300 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(100); } }
    this.ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => (this.ws.onopen = r));
    this.n = 0; this.waiting = new Map();
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) { this.waiting.get(m.id)(m.result ?? m.error); this.waiting.delete(m.id); }
      if (m.method === "Runtime.exceptionThrown") this.errors.push(m.params.exceptionDetails?.exception?.description?.slice(0, 300) ?? "exception");
      if (m.method === "Page.javascriptDialogOpening") this.send("Page.handleJavaScriptDialog", { accept: true, promptText: "" });
    };
    for (const m of ["Page.enable", "Runtime.enable", "Network.enable"]) await this.send(m);
  }
  async stop() {
    try { this.ws?.close(); } catch {}
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
    await this.send("Page.navigate", { url });
    await sleep(300);
    return this.until("!!window.sagebrush?.workspace && document.querySelectorAll('#cells .cell').length > 0", 45_000);
  }
  syncLine() { return this.ev(`document.querySelector("#wssidebar .fsync")?.textContent ?? null`); }
}
const W = "window.sagebrush.workspace";
const row = (p) => `[...document.querySelectorAll("#wssidebar .frow")].some((r) => r.dataset.path === ${J(p)})`;
const make = (b, p, text) => b.ev(`${W}.create(${J(p)}, { content: ${J(text)} }).then((e) => e.path, (e) => "refused: " + (e?.message ?? e))`);
const write = (b, p, text) => b.ev(`${W}.write(${J(p)}, ${J(text)}).then(() => "written", (e) => "refused: " + (e?.message ?? e))`);
const has = (p, text) => `${W}.read(${J(p)}).then((r) => new TextDecoder().decode(r.content) === ${J(text)}).catch(() => false)`;
const synced = `/^Synced/.test(document.querySelector("#wssidebar .fsync")?.textContent ?? "")`;
/** One file made in `from` reaches `to` with its bytes, and an edit made in `to` comes back. */
async function bothWays(from, to, p, what) {
  check((await make(from, p, `made in ${from.name}\n`)) === p, `${what}: ${from.name} makes ${p}`);
  check(await to.until(`${row(p)} && ${has(p, `made in ${from.name}\n`)}`, 20_000), `${what}: ${to.name} lists ${p} with its bytes within 20 s (its line ${J(await to.syncLine())})`);
  check((await write(to, p, `edited in ${to.name}\n`)) === "written", `${what}: ${to.name} edits it`);
  check(await from.until(has(p, `edited in ${to.name}\n`), 20_000), `${what}: …and ${from.name} has the edit within 20 s (its line ${J(await from.syncLine())})`);
}

try {
  const A = new Browser("A"), B = new Browser("B");
  await A.start(); await B.start();
  for (const b of [A, B]) {
    check(await b.go(), `${b.name}: the notebook page opens as ${ORIGIN}`);
    const signed = await b.ev(`fetch("/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: ${J(ACCOUNT)} }) }).then((r) => r.status)`);
    await b.ev(`localStorage.setItem("sagebrush-files-sidebar", "1")`);
    check(signed === 204 && (await b.go()), `${b.name}: signed in (${signed}), reloaded`);
    b.session = (await b.send("Network.getCookies", { urls: [ORIGIN + "/"] })).cookies?.find((c) => c.name === SESSION_COOKIE)?.value ?? null;
    check(!!b.session, `${b.name}: holds the session cookie`);
    // (Files, ⋯, Storage…, "Turn on sync…", the confirm accepted)
    check(await b.until(`!!document.querySelector("#wssidebar .fh button[aria-label=More]")`, 10_000), `${b.name}: the Files sidebar is shown`);
    await b.ev(`document.querySelector("#wssidebar .fh button[aria-label=More]").click()`);
    await b.until(`[...document.querySelectorAll(".sbfmenu button")].some((x) => x.textContent === "Storage…")`, 5000);
    await b.ev(`[...document.querySelectorAll(".sbfmenu button")].find((x) => x.textContent === "Storage…").click()`);
    check(await b.until(`[...document.querySelectorAll("button")].some((x) => x.textContent.trim() === "Turn on sync…" && !x.disabled)`, 15_000), `${b.name}: the Storage panel offers "Turn on sync…"`);
    await b.ev(`[...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Turn on sync…").click()`);
    check(await b.until(`[...document.querySelectorAll("button")].some((x) => x.textContent.trim() === "Turn off sync here")`, 20_000), `${b.name}: sync is on`);
  }
  // ---- 1. after a reload
  for (const b of [A, B]) {
    check(await b.go(), `${b.name}: reloaded after turning sync on`);
    check(await b.until(synced, 30_000), `${b.name}: after the reload, the sidebar says Synced (${J(await b.syncLine())})`);
  }
  await bothWays(A, B, "/after-reload-a.txt", "after a reload");
  await bothWays(B, A, "/after-reload-b.txt", "after a reload");
  // ---- 2. after opening a notebook (a page load at /?nb=, as a click on a notebook elsewhere does)
  for (const b of [A, B]) {
    // (a notebook of this browser's own: the one its page shows)
    const nb = await b.ev(`localStorage.getItem("sagebrush-current")`);
    check(!!nb && (await b.go(`${ORIGIN}/?nb=${nb}`)), `${b.name}: opens a notebook (/?nb=${nb})`);
    check(await b.until(synced, 30_000), `${b.name}: after opening a notebook, the sidebar says Synced (${J(await b.syncLine())})`);
  }
  await bothWays(A, B, "/after-notebook-a.txt", "after opening a notebook");
  await bothWays(B, A, "/after-notebook-b.txt", "after opening a notebook");
  // ---- 3. A's account socket refused: a file made there is said not sent, never "Synced"; then let through
  refused.add(A.session);
  for (const ws of sockets) if (ws.data.session === A.session) ws.close(1001, "refused (a test)");
  await sleep(1000);
  check((await make(A, "/not-sent.txt", "waiting\n")) === "/not-sent.txt", "A, its socket refused: makes /not-sent.txt");
  const says = await A.until(`/1 change/.test(document.querySelector("#wssidebar .fsync")?.textContent ?? "")`, 15_000);
  const line = await A.syncLine();
  check(says && !/^Synced/.test(line ?? ""), `A's line names the change not sent, and isn't "Synced" (${J(line)})`);
  await sleep(2000);
  check(!(await B.ev(row("/not-sent.txt"))) && !/^Synced/.test((await A.syncLine()) ?? ""), `…B doesn't have it, and A still doesn't say Synced (${J(await A.syncLine())})`);
  refused.delete(A.session);
  check(await B.until(`${row("/not-sent.txt")} && ${has("/not-sent.txt", "waiting\n")}`, 60_000), "let through: B has /not-sent.txt within 60 s");
  check(await A.until(synced, 30_000), `…and A says Synced again (${J(await A.syncLine())})`);
  for (const b of browsers) for (const e of b.errors) fails.push(`${b.name}: page error: ${e}`);
} catch (e) {
  fails.push("threw: " + String(e?.stack ?? e).slice(0, 600));
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: files sync on any origin, ${checks} checks`);
await cleanup(fails.length ? 1 : 0);
