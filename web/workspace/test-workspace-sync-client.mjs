// Sync client step 3 (design/sync-client.md §3, C1, L2, L3, L4) in headless Chromium against the sync service in
// Miniflare: the sender lock, the account socket, hello/welcome/index/pull_index, ops and acks, lost acks,
// refusals (the rebuild asked for, never done here), pace and backoff, blobs check and PUT.  The page is served by
// a small front here, which also proxies the site's API to Miniflare (the socket too) on the page's own origin, keeps
// the session cookie, and can drop, fake or hold what passes, as a network or a server would.  The cases are in
// sync-client-cases.js.
//   CHROME=google-chrome node web/workspace/test-workspace-sync-client.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { devtoolsPort } from "../test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { WebSocketServer } = require("ws");

const SITE = "https://sagebrush.test";
// (each case signs in its own account, so none sees another's log)
const ACCOUNTS = Array.from({ length: 89 }, (_, i) => `c1c1c1c1-${String(i).padStart(4, "0")}-4c1c-8c1c-c1c1c1c1c1${String(i).padStart(2, "0")}`);
// (the limits each has, from the fake CoCalc: most roomy; FULL's storage is small; SMALL's files are)
const FULL = ACCOUNTS[87], SMALL = ACCOUNTS[88];
const limitsOf = (a) => a === FULL ? { storage_bytes: 10_000, max_file_bytes: 50_000, sync: { enabled: true, version_bytes: 1000, read_bytes_per_day: 1 << 20 } }
  : a === SMALL ? { storage_bytes: 1 << 20, max_file_bytes: 5_000, sync: { enabled: true, version_bytes: 1000, read_bytes_per_day: 1 << 20 } }
  : { storage_bytes: 64 << 20, max_file_bytes: 50 << 20, sync: { enabled: true, version_bytes: 1 << 20, read_bytes_per_day: 64 << 20 } };
async function cocalc(req) {
  const u = new URL(req.url);
  if (u.pathname === "/api/v2/sagebrush/limits") return Response.json(limitsOf(u.searchParams.get("account_id")));
  return new Response("not found", { status: 404 });
}

const site = mkdtempSync(join(tmpdir(), "sb-sc-site-"));
const script = execFileSync("bun", ["build", join(here, "../sync/test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8", maxBuffer: 64 << 20 });
execFileSync("bun", ["build", join(here, "index.ts"), "--outdir", site, "--entry-naming", "ws.js", "--target", "browser", "--format", "esm"], { stdio: "inherit" });
copyFileSync(join(here, "sync-client-cases.js"), join(site, "cases.js"));
// (the protocol's own batch check, as the canonical reference server runs it (sync-protocol's checkFgen and clientOf),
// bundled for this front: every page's batch passes it here first, whatever server is behind)
writeFileSync(join(site, "canon-entry.ts"), `export { checkFgen } from ${JSON.stringify(join(here, "../sync-protocol/doc-protocol.ts"))};\nexport { clientOf } from ${JSON.stringify(join(here, "../sync-protocol/protocol.ts"))};\n`);
execFileSync("bun", ["build", join(site, "canon-entry.ts"), "--outfile", join(site, "canon.mjs"), "--target", "node", "--format", "esm"], { stdio: "inherit" });
const canon = await import(pathToFileURL(join(site, "canon.mjs")).href);
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>sync client test</title><script>window.ACCOUNTS = ${JSON.stringify(ACCOUNTS)}; window.FULL = ${JSON.stringify(FULL)}; window.SMALL = ${JSON.stringify(SMALL)}; window.REQUIRE_CLAIM = ${JSON.stringify(process.env.SYNC_REQUIRE_CLAIM === "1")};</script><script type="module">import { run } from "./cases.js"; window.run = run; window.ready = true;</script>`);

const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{
    modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"],
    name: "sync",
    bindings: { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", COCALC_ORIGIN: "https://cocalc.test", COCALC_CLIENT_SECRET: "client-secret", PURGE_KEY: "purge-key", LIMITS_KEY: "limits-key", SYNC_ACCOUNTS: ACCOUNTS.join(","), SYNC_URL_KEY: "url-key", FILES_ORIGIN: "https://files.test" },
    durableObjects: { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } },
    routes: ["sagebrush.test/*", "files.test/*"],
    outboundService: cocalc,
    ratelimits: { SYNC_PREAUTH: { namespace_id: "1001", simple: { limit: 1000000, period: 60 } }, SYNC_FILES_LIMIT: { namespace_id: "1002", simple: { limit: 1000000, period: 60 } } },
  }],
}));
const db = await mf.getD1Database("SHARE_DB", "sync");
const mig = join(here, "../share/migrations");
for (const m of readdirSync(mig).filter((f) => f.endsWith(".sql")).sort())
  for (const s of readFileSync(join(mig, m), "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();

// ---- the front: the page, and the site's API proxied, with what the cases ask of it (ctl)

let jar = "";
// (the account the session is now: its hash, for the binding checks)
let session = null;
const hashOf = (id) => createHash("sha256").update("sagebrush-account\n" + id).digest("hex");
const ctl = {
  /** answers faked for the next `ops` messages, instead of the server's: [{code, detail}] */
  fakeOps: [],
  /** acks with ops dropped (the next n), then the socket closed if closeAfterDrop */
  dropAcks: 0, closeAfterDrop: false,
  /** connections closed as soon as they open (the next n) */
  closeOnOpen: 0,
  /** the next welcome changed: {generation?, next_dseq?} */
  rewriteWelcome: null,
  /** PUTs held until released */
  holdPut: false,
  /** GETs of the user-content domain (/__files) held until released */
  holdGet: false,
  /** answers for the next `rebuilt` messages, instead of the server's (core's has no `rebuilt`: the server half is
   * the cloud's): [{ack: {floor, count}} | {code, detail} | {hold: true}] (default: an ack with floor = through) */
  rebuilt: [],
  /** `rebuilt` sent on to the real server (core's: it answers "unknown message"), not answered here */
  rebuiltReal: false,
  /** the next n unasked-for index pages (a hello's) dropped */
  dropIndex: 0,
  /** the next n pulled index pages (answers to pull_index) dropped */
  dropPulled: 0,
  /** the next n pulled index pages answered {ops: [], more: true} instead (a page that moves nothing) */
  emptyMore: 0,
  /** HTTP answers faked: [{method, path (a part of it), status, body, times}] */
  fakeHttp: [],
  /** answers faked for the next pull_index requests: [{code, detail}] */
  fakePull: [],
  /** the session switched to this account just before the next socket upgrade, or the next PUT, is forwarded (as
   * another tab signing in would) */
  switchOnUpgrade: null, switchOnPut: null,
  /** the next PUT answered with this, after `ms`: {ms, status, body} (a late answer) */
  delayFakePut: null,
  /** the server's own index_changed passed on to the page.  The cloud's account object sends them (plan-sync-index-
   * changed r1); core's server doesn't.  Off by default, so each case decides when the page hears of a change (it
   * injects notices with `notice`): the server's are dropped and counted (log.serverNotices) */
  serverNotices: false,
};
/** every open proxied socket's closer */
const closers = new Set();
/** every open proxied socket's sender to the page (a notice injected as the server would send it, D8) */
const toPage = new Set();
const log = { sent: [], got: [], http: [], sockets: 0, open: 0, putsNow: 0, maxPuts: 0, ops: [], bindings: [], rebuilt: [], serverNotices: 0, fgenRefused: 0, batchesUp: 0 };
const held = [];
/** the server's own index_changed dropped by the front over the whole run (log.serverNotices is per case: reset) */
let serverNoticesDropped = 0;
const resetLog = () => Object.assign(log, { sent: [], got: [], http: [], sockets: 0, putsNow: 0, maxPuts: 0, ops: [], bindings: [], rebuilt: [], serverNotices: 0, fgenRefused: 0, batchesUp: 0 });

async function upstream(method, path, headers, body) {
  const h = { origin: SITE, ...headers };
  if (jar) h.cookie = jar;
  const r = await mf.dispatchFetch(SITE + path, { method, headers: h, body, redirect: "manual" });
  const c = r.headers.getSetCookie?.().map((x) => x.split(";")[0]).find((x) => x.startsWith("__Host-sb_session="));
  if (c) {
    jar = c;
    if (path === "/auth/dev") try { session = hashOf(JSON.parse(String(body)).account_id); } catch {}
  }
  return r;
}

const signInAs = (account_id) => upstream("POST", "/auth/dev", { "content-type": "application/json" }, JSON.stringify({ token: "dev-token", account_id }));

// a second device, from here: its own socket on the same account
async function probe({ ops = [], device = "0f0f0f0f0f0f0f0f" } = {}) {
  const r = await upstream("GET", "/api/sync/v1/account", { upgrade: "websocket" });
  if (r.status !== 101) return { status: r.status };
  const ws = r.webSocket;
  ws.accept();
  const got = [];
  let wake = null;
  ws.addEventListener("message", (e) => { got.push(JSON.parse(e.data)); wake?.(); });
  const next = async (f, ms = 5000) => {
    const t = Date.now();
    for (;;) {
      const i = got.findIndex(f);
      if (i >= 0) return got.splice(i, 1)[0];
      if (Date.now() - t > ms) return null;
      await new Promise((ok) => { wake = ok; setTimeout(ok, 50); });
    }
  };
  ws.send(JSON.stringify({ t: "hello", v: 1, device, name: "probe", index_after: 0 }));
  const welcome = await next((m) => m.t === "welcome");
  const index = [];
  let page = await next((m) => m.t === "index");
  for (let req = 1; page; req++) {
    index.push(...page.ops);
    if (!page.more) break;
    ws.send(JSON.stringify({ t: "pull_index", req, after: index.at(-1).seq }));
    page = await next((m) => m.t === "index" && m.req === req);
  }
  let ack = null;
  if (ops.length) {
    ws.send(JSON.stringify({ t: "ops", req: 1000, ops }));
    ack = await next((m) => m.req === 1000);
  }
  ws.close(1000, "done");
  return { welcome, index, ack };
}

async function control(body) {
  switch (body.cmd) {
    case "set": Object.assign(ctl, body.set); return { ok: true };
    case "log": { const out = JSON.parse(JSON.stringify(log)); if (body.reset) resetLog(); return out; }
    case "closeAll": { const n = closers.size; for (const f of [...closers]) f(1000); return { closed: n }; }
    case "release": { const n = held.length; for (const f of held.splice(0)) f(); return { released: n }; }
    case "probe": return probe(body);
    // (index_changed notices, as the account object sends them (plan-sync-index-changed r1), `times` of them to every
    // open socket: the client's side is tested by injecting them here; the server's own are dropped unless
    // ctl.serverNotices)
    // (a frame of the server's own, pushed to every page socket as the server would push it (no req): 2c-3's docWire)
    case "frame": { let sent = 0; for (const f of toPage) { f(JSON.stringify(body.frame)); sent++; } return { sent }; }
    case "notice": { let sent = 0; for (let i = 0; i < (body.times ?? 1); i++) for (const f of toPage) { f(JSON.stringify({ t: "index_changed", head: body.head })); sent++; } return { sent }; }
    case "reset": Object.assign(ctl, { fakeOps: [], dropAcks: 0, closeAfterDrop: false, closeOnOpen: 0, rewriteWelcome: null, holdPut: false, holdGet: false, rebuilt: [], rebuiltReal: false, dropIndex: 0, dropPulled: 0, emptyMore: 0, fakeHttp: [], fakePull: [], switchOnUpgrade: null, switchOnPut: null, delayFakePut: null, serverNotices: false }); for (const f of held.splice(0)) f(); resetLog(); return { ok: true };
    default: return { error: "unknown" };
  }
}

const readBody = (req) => new Promise((ok) => { const parts = []; req.on("data", (d) => parts.push(d)); req.on("end", () => ok(Buffer.concat(parts))); });
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  try {
    if (p === "/" || p === "/ws.js" || p === "/cases.js") {
      res.writeHead(200, { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" });
      return res.end(readFileSync(join(site, p === "/" ? "index.html" : p.slice(1))));
    }
    if (p === "/__ctl") {
      const out = await control(JSON.parse((await readBody(req)).toString() || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(out));
    }
    // (the user-content domain, for the page: the signed URLs a blob GET redirects to are rewritten to /__files/…,
    // served by the real handler (server.ts handleSyncFiles) on files.test in Miniflare.  Test harness only)
    if (p.startsWith("/__files/")) {
      const entry = { method: req.method, path: p, files: true };
      log.http.push(entry);
      if (ctl.holdGet) await new Promise((ok) => held.push(ok));
      const r = await mf.dispatchFetch("https://files.test" + p.slice("/__files".length) + u.search, { method: req.method, headers: req.headers.range ? { range: req.headers.range } : {} });
      entry.status = r.status;
      const out = Buffer.from(await r.arrayBuffer());
      const h = {};
      r.headers.forEach((v, k) => { if (k !== "content-encoding") h[k] = v; });
      res.writeHead(r.status, h);
      return res.end(out);
    }
    if (!p.startsWith("/api/") && !p.startsWith("/auth/")) { res.writeHead(404); return res.end(); }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const isPut = req.method === "PUT";
    const entry = { method: req.method, path: p, bytes: body?.length ?? 0, ...(p.endsWith("/blobs/check") ? { check: JSON.parse(body.toString()).blobs.length } : {}) };
    log.http.push(entry);
    const fake = ctl.fakeHttp.find((f) => f.method === req.method && (!f.path || p.includes(f.path)) && f.times > 0);
    if (fake) {
      fake.times--;
      entry.status = fake.status;
      entry.faked = true;
      res.writeHead(fake.status, { "content-type": "application/json" });
      return res.end(JSON.stringify(fake.body ?? {}));
    }
    if (isPut && ctl.delayFakePut) {
      const f = ctl.delayFakePut;
      ctl.delayFakePut = null;
      entry.faked = true;
      await new Promise((r) => setTimeout(r, f.ms));
      entry.status = f.status;
      res.writeHead(f.status, { "content-type": "application/json" });
      return res.end(JSON.stringify(f.body ?? {}));
    }
    if (isPut && ctl.switchOnPut) {
      await signInAs(ctl.switchOnPut);
      ctl.switchOnPut = null;
      entry.switched = true;
    }
    if (isPut || entry.check !== undefined) Object.assign(entry, { session, bind: req.headers["x-sync-account"] ?? null });
    if (isPut) {
      log.putsNow++;
      log.maxPuts = Math.max(log.maxPuts, log.putsNow);
      if (ctl.holdPut) await new Promise((ok) => held.push(ok));
    }
    const headers = {};
    for (const k of ["content-type", "content-length", "x-sync-account", "x-sync-generation"]) if (req.headers[k]) headers[k] = req.headers[k];
    let r;
    try {
      r = await upstream(req.method, p + u.search, headers, body);
    } finally {
      if (isPut) log.putsNow--;
    }
    entry.status = r.status;
    const out = Buffer.from(await r.arrayBuffer());
    const h = {};
    r.headers.forEach((v, k) => { if (k !== "set-cookie" && k !== "content-length" && k !== "content-encoding") h[k] = v; });
    if (h.location?.startsWith("https://files.test/")) h.location = "/__files/" + h.location.slice("https://files.test/".length);
    res.writeHead(r.status, h);
    res.end(out);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});

// the account socket, proxied message by message, so the cases can drop, fake or close
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", async (req, socket, head) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p !== "/api/sync/v1/account") return socket.destroy();
  log.sockets++;
  if (ctl.switchOnUpgrade) {
    await signInAs(ctl.switchOnUpgrade);
    ctl.switchOnUpgrade = null;
    log.switchedUpgrade = (log.switchedUpgrade ?? 0) + 1;
  }
  const r = await upstream("GET", p, { upgrade: "websocket" }).catch(() => null);
  if (!r || r.status !== 101) {
    socket.write(`HTTP/1.1 ${r?.status ?? 502} refused\r\nconnection: close\r\n\r\n`);
    return socket.destroy();
  }
  const up = r.webSocket;
  up.accept();
  // (the session's account when this socket was opened: the one it is authenticated as)
  const socketSession = session;
  let helloAccount = null;
  wss.handleUpgrade(req, socket, head, (client) => {
    log.open++;
    const okCode = (c) => (c === 1000 || (c >= 3000 && c <= 4999) ? c : 1000);
    let closed = false;
    const closeBoth = (code = 1000) => {
      if (closed) return;
      closed = true;
      closers.delete(closeBoth);
      log.open--;
      try { up.close(1000, "proxy"); } catch {}
      try { client.close(okCode(code), "proxy"); } catch {}
    };
    closers.add(closeBoth);
    const send = (text) => { try { client.send(text); } catch {} };
    toPage.add(send);
    client.on("close", () => toPage.delete(send));
    if (ctl.closeOnOpen > 0) {
      ctl.closeOnOpen--;
      return closeBoth(1000);
    }
    client.on("message", (data) => {
      const text = data.toString();
      let m;
      try { m = JSON.parse(text); } catch { m = {}; }
      log.sent.push(m.t === "ops" ? { t: "ops", req: m.req, dseqs: m.ops.map((o) => o.dseq), json: m.ops.map((o) => JSON.stringify(o)), at: Date.now() } : { t: m.t, req: m.req, index_after: m.index_after, after: m.after, at: Date.now() });
      if (m.t === "hello") helloAccount = m.account ?? null;
      // (every batch checked as the canonical reference server checks it (§5.8: one generation for each client in its
      // patches, and no other): a failing one is refused here, routed to its request, and never forwarded)
      if (m.t === "batch") {
        let why = null;
        try { canon.checkFgen(m.fgen, new Set((Array.isArray(m.patches) ? m.patches : []).map((p) => canon.clientOf(String(p?.id ?? ""))))); } catch (e) { why = String(e?.message ?? e); }
        if (why !== null) {
          log.fgenRefused++;
          client.send(JSON.stringify({ t: "error", req: m.req, code: "invalid", detail: { message: why } }));
          return;
        }
      }
      if (m.t === "ops") log.bindings.push({ session: socketSession, hello: helloAccount, dseqs: m.ops.map((o) => o.dseq) });
      if (m.t === "ops") log.ops.push(...m.ops.map((o) => JSON.stringify(o)));
      if (m.t === "rebuilt" && ctl.rebuiltReal) log.rebuilt.push({ through: m.through, answer: "server", at: Date.now() });
      if (m.t === "rebuilt" && !ctl.rebuiltReal) {
        const f = ctl.rebuilt.shift() ?? { ack: { floor: m.through, count: 0 } };
        log.rebuilt.push({ through: m.through, answer: f, at: Date.now() });
        const answer = () => client.send(JSON.stringify(f.ack ? { t: "ack", req: m.req, rebuilt: f.ack } : { t: "error", req: m.req, code: f.code, detail: f.detail ?? { message: "faked" } }));
        if (f.hold) held.push(() => { f.ack = f.ack ?? { floor: m.through, count: 0 }; answer(); });
        else answer();
        return;
      }
      if (m.t === "pull_index" && ctl.fakePull.length) {
        const f = ctl.fakePull.shift();
        client.send(JSON.stringify({ t: "error", req: m.req, code: f.code, detail: f.detail ?? { message: "faked" } }));
        return;
      }
      if (m.t === "ops" && ctl.fakeOps.length) {
        const f = ctl.fakeOps.shift();
        // (hold: answered only when the test releases it, after it has seen the client's sender idle)
        const answer = () => client.send(JSON.stringify({ t: "error", req: m.req, code: f.code, detail: f.detail ?? { message: "faked" } }));
        if (f.hold) held.push(answer);
        else answer();
        return;
      }
      // (the one place a page's frame goes upstream: batches counted here, so a case can tell a refused batch was never
      // forwarded)
      if (m.t === "batch") log.batchesUp++;
      try { up.send(text); } catch {}
    });
    client.on("close", (code) => closeBoth(code));
    up.addEventListener("message", (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { m = {}; }
      log.got.push({ t: m.t, req: m.req, ops: m.t === "ack" ? m.ops : m.t === "index" ? m.ops?.length : undefined, code: m.code });
      if (m.t === "index_changed" && !ctl.serverNotices) {
        log.serverNotices++;
        serverNoticesDropped++;
        // (marked as filtered, never as `dropped`: the cases' `g.dropped` means a drop they asked for)
        log.got.at(-1).filtered = true;
        return;
      }
      if (m.t === "welcome" && ctl.rewriteWelcome) {
        Object.assign(m, ctl.rewriteWelcome);
        ctl.rewriteWelcome = null;
        client.send(JSON.stringify(m));
        return;
      }
      if (m.t === "index" && m.req !== undefined && ctl.emptyMore > 0) {
        ctl.emptyMore--;
        log.got.at(-1).faked = true;
        client.send(JSON.stringify({ t: "index", req: m.req, ops: [], more: true }));
        return;
      }
      if (m.t === "index" && m.req !== undefined && ctl.dropPulled > 0) {
        ctl.dropPulled--;
        log.got.at(-1).dropped = true;
        return;
      }
      if (m.t === "index" && m.req === undefined && ctl.dropIndex > 0) {
        ctl.dropIndex--;
        log.got.at(-1).dropped = true;
        return;
      }
      if (m.t === "ack" && m.ops && ctl.dropAcks > 0) {
        ctl.dropAcks--;
        log.got.at(-1).dropped = true;
        if (ctl.closeAfterDrop) closeBoth(1000);
        return;
      }
      try { client.send(e.data); } catch {}
    });
    up.addEventListener("close", (e) => closeBoth(e.code));
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- Chrome, driven over the DevTools protocol, as the other workspace tests are

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-sc-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--js-flags=--expose-gc", "--enable-precise-memory-info", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let code = 1;
try {
  if (!port) port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map(), errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
    if (m.method === "Runtime.consoleAPICalled" && process.env.SHOW_CONSOLE) console.log("page:", m.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 2000)); return r.result?.value; };
  await send("Runtime.enable");
  await send("Page.navigate", { url: `${origin}/` });
  for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
  // (a watchdog: a run that doesn't end says which case it was in, and the last checks, rather than being killed silently)
  const limit = Number(process.env.RUN_LIMIT_S ?? 720) * 1000;
  let timer;
  const results = await Promise.race([
    ev(`window.run(${JSON.stringify(process.env.ONLY ?? "")})`),
    new Promise((_, no) => { timer = setTimeout(() => no(new Error("timeout")), limit); }),
  ]).catch(async (e) => {
    const where = await Promise.race([ev("JSON.stringify({ progress: window.progress })"), sleep(5000).then(() => "(the page doesn't answer)")]);
    console.error(`FAIL: the run didn't end within ${limit / 1000} s (${e.message}): ${where}`);
    throw e;
  });
  clearTimeout(timer);
  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  // (measurements, printed pass or fail)
  for (const [, what] of results) if (/figures/.test(what)) console.log("  " + what);
  // (0 against core's server, which sends none; the cloud's sends them: plan-sync-index-changed r1)
  console.log(`  front: the server's own index_changed notices dropped (ctl.serverNotices off): ${serverNoticesDropped}`);
  for (const e of errors) fails.push("page error: " + e);
  if (fails.length) console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  else {
    console.log(`ok: sync's client (step 3), ${results.length} checks`);
    if (process.env.SHOW) for (const [, what] of results) console.log("  " + what);
    code = 0;
  }
  ws.close();
} finally {
  // (Chrome's exit awaited before its profile is removed: on a loaded runner it may still be writing there)
  const exited = chrome.exitCode !== null || chrome.signalCode !== null ? Promise.resolve() : new Promise((ok) => chrome.once("exit", ok));
  chrome.kill();
  await Promise.race([exited, new Promise((ok) => setTimeout(ok, 5000))]);
  server.close();
  await mf.dispose().catch(() => {});
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(site, { recursive: true, force: true });
}
process.exit(code);
