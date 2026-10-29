// The sync client's cases (sync-client-cases.js: design/sync-client.md §3, C1, L2, L3, L4) in headless Chromium against
// core's reference server (web/sync-protocol/reference-server.ts), in this process: the sender lock, the account
// socket, hello/welcome/index/pull_index, ops and acks, lost acks, refusals (the rebuild asked for, never done here),
// pace and backoff, blobs check, PUT and GET, and docWire's claim.  The page is served by a small front here, which
// also proxies the site's sync API to the reference server (the account socket too) on the page's own origin, keeps
// the session cookie, and can drop, fake or hold what passes, as a network or a server would (/__ctl).  The cloud
// repository runs the same cases against its own server in Miniflare (its web/sync/test-workspace-sync-client.mjs),
// through a front with the same /__ctl.  This file reads only core: nothing under web/{site,files,share,sync,lti}.
// The 2 cases that need the cloud's plan limits (storageFull, tooLarge) are skipped by name, each saying so.
//   SYNC_REQUIRE_CLAIM=1 CHROME=google-chrome bun web/workspace/test-sync-client-ref.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";
import { ReferenceServer } from "../sync-protocol/reference-server.ts";
import { checkFgen } from "../sync-protocol/doc-protocol.ts";
import { clientOf } from "../sync-protocol/protocol.ts";

// (the reference server has the claim protocol, so a refused doc_claim must be a failed check, never the legacy path:
// this runner refuses to start without the flag rather than run the cases without it)
if (process.env.SYNC_REQUIRE_CLAIM !== "1") {
  console.error("FAIL: this runner needs SYNC_REQUIRE_CLAIM=1 (the reference server has the claim protocol)");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const J = JSON.stringify;
// (each case signs in its own account, so none sees another's log)
const ACCOUNTS = Array.from({ length: 89 }, (_, i) => `c1c1c1c1-${String(i).padStart(4, "0")}-4c1c-8c1c-c1c1c1c1c1${String(i).padStart(2, "0")}`);
// (the cloud's fake CoCalc gives FULL a small storage and SMALL small files; the reference server has no plan limits,
// so the two cases that use them are skipped here, by name)
const FULL = ACCOUNTS[87], SMALL = ACCOUNTS[88];
const CLOUD_ONLY = ["storageFull", "tooLarge"];
// (the cases that download a blob through the redirect to /__files/: a full run must show such downloads)
const DOWNLOADS = ["downloadBasic", "downloadChecks", "downloadStale", "downloadBudget", "downloadStale2"];
const ONLY = process.env.ONLY ?? "";
const selected = (name) => !ONLY || ONLY.split(",").includes(name);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** what the run is waiting on, for any failure's message */
let waitingOn = "(nothing yet)";
/** `p`, or a rejection naming `what` once `ms` pass without an answer. */
const bounded = (p, what, ms) => { let t; return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(`no answer within ${ms} ms: ${what}`)), ms); })]).finally(() => clearTimeout(t)); };
const CALL_MS = 30_000;
const LIMIT_S = Number(process.env.RUN_LIMIT_S ?? 720);

// ---- the front: the page, and the site's sync API proxied to the reference server, with what the cases ask of it (ctl)

const ref = new ReferenceServer();
/** the front's own origin (the page's): every request to the reference server is made on it, so the URLs it answers
 * with (the blob GET's 303 to /__files/<sha>) are the page's own */
let origin = "";
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
  /** GETs of the user-content files (/__files) held until released */
  holdGet: false,
  /** answers for the next `rebuilt` messages, instead of the server's (the reference server has no `rebuilt`: the server
   * half is the cloud's): [{ack: {floor, count}} | {code, detail} | {hold: true}] (default: an ack with floor = through) */
  rebuilt: [],
  /** `rebuilt` sent on to the real server (the reference server: it answers "unknown message"), not answered here */
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
  /** the server's own index_changed passed on to the page.  The reference server sends them, to an account's other
   * sockets after ops that move its head, as the cloud's account object does (plan-sync-index-changed r1).  Off by
   * default, so each case decides when the page hears of a change (it injects notices with `notice`): the server's are
   * dropped and counted (log.serverNotices) */
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
/** over the whole run: /__files/ GETs answered 200 (the downloads through the redirect), and answers that would have sent
 * the page to another origin (a Location, or a 3xx, not on the front's own) */
const front = { files200: 0, leaks: [] };
const resetLog = () => Object.assign(log, { sent: [], got: [], http: [], sockets: 0, putsNow: 0, maxPuts: 0, ops: [], bindings: [], rebuilt: [], serverNotices: 0, fgenRefused: 0, batchesUp: 0 });

async function upstream(method, path, headers, body) {
  const h = new Headers({ origin, ...headers });
  if (jar) h.set("cookie", jar);
  const r = await ref.fetch(new Request(origin + path, { method, headers: h, body, redirect: "manual" }));
  const c = r.headers.getSetCookie?.().map((x) => x.split(";")[0]).find((x) => x.startsWith("__Host-sb_session="));
  if (c) {
    jar = c;
    if (path === "/auth/dev") try { session = hashOf(JSON.parse(String(body)).account_id); } catch {}
  }
  return r;
}

const signInAs = (account_id) => upstream("POST", "/auth/dev", { "content-type": "application/json" }, JSON.stringify({ token: "dev-token", account_id }));

/** The account socket, for the front's two users (the page's proxied socket and probe): the reference server's
 * RefSocket (its messages and its close as callbacks, onmessage(text) and onclose(code, reason)), or its refusal. */
async function connectUp() {
  const s = await ref.connect(jar || null);
  if (typeof s.send !== "function") return { refused: s };
  // (what the server sends before its user takes over (the page's socket opens a moment later) is kept, not dropped:
  // the user's onmessage replaces this, and then takes what was kept, in order)
  const buf = [];
  let early = null;
  s.onmessage = (text) => buf.push(text);
  s.onclose = (code, reason) => { early = [code, reason]; };
  return { up: s, buf, early: () => early };
}

// a second device, from here: its own socket on the same account
async function probe({ ops = [], device = "0f0f0f0f0f0f0f0f" } = {}) {
  const c = await connectUp();
  if (c.refused) return { status: c.refused.status };
  const ws = c.up;
  const got = [];
  let wake = null;
  ws.onmessage = (text) => { got.push(JSON.parse(text)); wake?.(); };
  for (const text of c.buf.splice(0)) ws.onmessage(text);
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

/** The headers of an answer passed to the page, without those the front sets itself; a Location (or a 3xx) that isn't
 * on the front's own origin is counted as a leak of another origin, and the run fails on any */
function pageHeaders(r, path) {
  const h = {};
  r.headers.forEach((v, k) => { if (k !== "set-cookie" && k !== "content-length" && k !== "content-encoding") h[k] = v; });
  const loc = r.headers.get("location");
  if ((loc !== null || (r.status >= 300 && r.status < 400)) && !(loc !== null && new URL(loc, origin).origin === origin)) front.leaks.push(`${r.status} ${path} -> ${loc}`);
  return h;
}

/** A status that carries no body (the Fetch rule: a body there is a TypeError), as /auth/dev's 204 */
const NULL_BODY = [101, 103, 204, 205, 304];
/** An answer to the page: `body`, unless the status, or a HEAD, carries none */
const respond = (status, body, headers, method) => new Response(NULL_BODY.includes(status) || method === "HEAD" ? null : body, { status, headers });
/** The reference server's answer passed on: its body read only when it may have one */
const passOn = async (r, path, method) => respond(r.status, NULL_BODY.includes(r.status) || method === "HEAD" ? null : await r.arrayBuffer(), pageHeaders(r, path), method);

let site = "";
async function serve(req, server) {
  const u = new URL(req.url);
  const p = u.pathname;
  try {
    if (p === "/" || p === "/ws.js" || p === "/cases.js") {
      return new Response(Bun.file(join(site, p === "/" ? "index.html" : p.slice(1))), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
    }
    if (p === "/__ctl") return Response.json(await control(JSON.parse((await req.text()) || "{}")));
    // the account socket, proxied message by message (websocket, below), so the cases can drop, fake or close
    if (p === "/api/sync/v1/account" && (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      log.sockets++;
      if (ctl.switchOnUpgrade) {
        await signInAs(ctl.switchOnUpgrade);
        ctl.switchOnUpgrade = null;
        log.switchedUpgrade = (log.switchedUpgrade ?? 0) + 1;
      }
      const c = await connectUp().catch(() => null);
      if (!c || c.refused) return new Response("refused", { status: c?.refused.status ?? 502, headers: { connection: "close" } });
      // (the session's account when this socket was opened: the one it is authenticated as)
      if (server.upgrade(req, { data: { up: c.up, buf: c.buf, early: c.early, socketSession: session, helloAccount: null } })) return undefined;
      c.up.close(1000, "no upgrade");
      return new Response("no upgrade", { status: 400 });
    }
    // (the user-content files: the reference server's blob GET answers 303 to /__files/<sha> on the origin it was asked
    // on, the front's; served by the reference server's own route, through this branch, so the cases can hold them.
    // The cloud's front also forwarded the query and a range here; the reference server ignores both, and no case sends
    // a range, so neither is forwarded)
    if (p.startsWith("/__files/")) {
      const entry = { method: req.method, path: p, files: true };
      log.http.push(entry);
      if (ctl.holdGet) await new Promise((ok) => held.push(ok));
      const h = new Headers();
      if (jar) h.set("cookie", jar);
      const r = await ref.fetch(new Request(origin + p, { method: req.method, headers: h }));
      entry.status = r.status;
      if (r.status === 200) front.files200++;
      return passOn(r, p, req.method);
    }
    if (!p.startsWith("/api/") && !p.startsWith("/auth/")) return new Response(null, { status: 404 });
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.from(await req.arrayBuffer());
    const isPut = req.method === "PUT";
    const entry = { method: req.method, path: p, bytes: body?.length ?? 0, ...(p.endsWith("/blobs/check") ? { check: JSON.parse(body.toString()).blobs.length } : {}) };
    log.http.push(entry);
    const fake = ctl.fakeHttp.find((f) => f.method === req.method && (!f.path || p.includes(f.path)) && f.times > 0);
    if (fake) {
      fake.times--;
      entry.status = fake.status;
      entry.faked = true;
      return respond(fake.status, JSON.stringify(fake.body ?? {}), { "content-type": "application/json" }, req.method);
    }
    if (isPut && ctl.delayFakePut) {
      const f = ctl.delayFakePut;
      ctl.delayFakePut = null;
      entry.faked = true;
      await new Promise((r) => setTimeout(r, f.ms));
      entry.status = f.status;
      return respond(f.status, JSON.stringify(f.body ?? {}), { "content-type": "application/json" }, req.method);
    }
    if (isPut && ctl.switchOnPut) {
      await signInAs(ctl.switchOnPut);
      ctl.switchOnPut = null;
      entry.switched = true;
    }
    if (isPut || entry.check !== undefined) Object.assign(entry, { session, bind: req.headers.get("x-sync-account") ?? null });
    if (isPut) {
      log.putsNow++;
      log.maxPuts = Math.max(log.maxPuts, log.putsNow);
      if (ctl.holdPut) await new Promise((ok) => held.push(ok));
    }
    const headers = {};
    for (const k of ["content-type", "content-length", "x-sync-account", "x-sync-generation"]) { const v = req.headers.get(k); if (v !== null) headers[k] = v; }
    // (the reference server reads a PUT's length from its header: the page's, forwarded; else the body's own)
    if (isPut && headers["content-length"] === undefined) headers["content-length"] = String(body.length);
    let r;
    try {
      r = await upstream(req.method, p + u.search, headers, body);
    } finally {
      if (isPut) log.putsNow--;
    }
    entry.status = r.status;
    return passOn(r, p, req.method);
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
}

const okCode = (c) => (c === 1000 || (c >= 3000 && c <= 4999) ? c : 1000);
/** every proxied pair's close failure over the run, whoever called the closer (the cases' paths ignore what it returns;
 * the cleanup reports these, so a failure before the cleanup still fails the run) */
const closeFailures = [];
/** One proxied pair's closer: both sides closed, once (`first` runs then); says what failed, each side tried whatever
 * the other did (empty when both closed, or when it had already closed them), and keeps each failure in `ledger` */
const pairCloser = (up, client, first, ledger = closeFailures) => {
  let closed = false;
  return (code = 1000) => {
    if (closed) return [];
    closed = true;
    first();
    const bad = [];
    try { up.close(1000, "proxy"); } catch (e) { bad.push(`the server's side (${why(e)})`); }
    try { client.close(okCode(code), "proxy"); } catch (e) { bad.push(`the page's side (${why(e)})`); }
    ledger.push(...bad);
    return bad;
  };
};
const websocket = {
  open(client) {
    const d = client.data, up = d.up;
    log.open++;
    d.closeBoth = pairCloser(up, client, () => { closers.delete(d.closeBoth); log.open--; });
    closers.add(d.closeBoth);
    d.send = (text) => { try { client.send(text); } catch {} };
    toPage.add(d.send);
    if (ctl.closeOnOpen > 0) {
      ctl.closeOnOpen--;
      return d.closeBoth(1000);
    }
    up.onmessage = (text) => {
      let m;
      try { m = JSON.parse(text); } catch { m = {}; }
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
        d.send(JSON.stringify(m));
        return;
      }
      if (m.t === "index" && m.req !== undefined && ctl.emptyMore > 0) {
        ctl.emptyMore--;
        log.got.at(-1).faked = true;
        d.send(JSON.stringify({ t: "index", req: m.req, ops: [], more: true }));
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
        if (ctl.closeAfterDrop) d.closeBoth(1000);
        return;
      }
      d.send(text);
    };
    up.onclose = (code) => d.closeBoth(code);
    for (const text of d.buf.splice(0)) up.onmessage(text);
    // (a close the server made before this socket opened, kept, then passed on)
    const early = d.early();
    if (early) up.onclose(...early);
  },
  message(client, data) {
    const d = client.data, up = d.up;
    const text = typeof data === "string" ? data : Buffer.from(data).toString();
    let m;
    try { m = JSON.parse(text); } catch { m = {}; }
    log.sent.push(m.t === "ops" ? { t: "ops", req: m.req, dseqs: m.ops.map((o) => o.dseq), json: m.ops.map((o) => JSON.stringify(o)), at: Date.now() } : { t: m.t, req: m.req, index_after: m.index_after, after: m.after, at: Date.now() });
    if (m.t === "hello") d.helloAccount = m.account ?? null;
    // (every batch checked as the canonical reference server checks it (§5.8: one generation for each client in its
    // patches, and no other): a failing one is refused here, routed to its request, and never forwarded)
    if (m.t === "batch") {
      let why = null;
      try { checkFgen(m.fgen, new Set((Array.isArray(m.patches) ? m.patches : []).map((p) => clientOf(String(p?.id ?? ""))))); } catch (e) { why = String(e?.message ?? e); }
      if (why !== null) {
        log.fgenRefused++;
        d.send(JSON.stringify({ t: "error", req: m.req, code: "invalid", detail: { message: why } }));
        return;
      }
    }
    if (m.t === "ops") log.bindings.push({ session: d.socketSession, hello: d.helloAccount, dseqs: m.ops.map((o) => o.dseq) });
    if (m.t === "ops") log.ops.push(...m.ops.map((o) => JSON.stringify(o)));
    if (m.t === "rebuilt" && ctl.rebuiltReal) log.rebuilt.push({ through: m.through, answer: "server", at: Date.now() });
    if (m.t === "rebuilt" && !ctl.rebuiltReal) {
      const f = ctl.rebuilt.shift() ?? { ack: { floor: m.through, count: 0 } };
      log.rebuilt.push({ through: m.through, answer: f, at: Date.now() });
      const answer = () => d.send(JSON.stringify(f.ack ? { t: "ack", req: m.req, rebuilt: f.ack } : { t: "error", req: m.req, code: f.code, detail: f.detail ?? { message: "faked" } }));
      if (f.hold) held.push(() => { f.ack = f.ack ?? { floor: m.through, count: 0 }; answer(); });
      else answer();
      return;
    }
    if (m.t === "pull_index" && ctl.fakePull.length) {
      const f = ctl.fakePull.shift();
      d.send(JSON.stringify({ t: "error", req: m.req, code: f.code, detail: f.detail ?? { message: "faked" } }));
      return;
    }
    if (m.t === "ops" && ctl.fakeOps.length) {
      const f = ctl.fakeOps.shift();
      // (hold: answered only when the test releases it, after it has seen the client's sender idle)
      const answer = () => d.send(JSON.stringify({ t: "error", req: m.req, code: f.code, detail: f.detail ?? { message: "faked" } }));
      if (f.hold) held.push(answer);
      else answer();
      return;
    }
    // (the one place a page's frame goes upstream: batches counted here, so a case can tell a refused batch was never
    // forwarded)
    if (m.t === "batch") log.batchesUp++;
    try { up.send(text); } catch {}
  },
  close(client, code) {
    toPage.delete(client.data.send);
    client.data.closeBoth?.(code);
  },
};

// ---- Chrome, driven over the DevTools protocol, as the other workspace tests are; every wait bounded and named, one
// cleanup however the run ends

const fails = [];
/** the runner's own controls (of its cleanup), beside the page's checks */
const controls = [];
const control1 = (ok, what) => { controls.push(what); if (!ok) fails.push(what); };
const sockets = [];
let server = null, chrome = null, profile = null;
/** how Chrome ended, once it has: {exit: [code, signal]}, or {error} for a spawn that failed (never an observed exit) */
let chromeEnded = Promise.resolve(null);
const why = (e) => String(e?.code ?? e?.message ?? e);
/** A process stopped and seen to end: TERM, up to 5 s for its end, then KILL and up to 5 s more; says which.  A kill
 * that throws is a stop only on ESRCH (it had gone); any other error is a failure, said.  An `error` end (a spawn that
 * failed) is never taken for an exit. */
const stopChrome = async (p = chrome, ended = () => chromeEnded) => {
  if (!p?.pid) return { ok: true, said: "never started" };
  if (p.exitCode !== null || p.signalCode !== null) return { ok: true, said: "had exited" };
  for (const [sig, name] of [["SIGTERM", "TERM"], ["SIGKILL", "KILL"]]) {
    try { p.kill(sig); } catch (e) { if (e?.code !== "ESRCH") return { ok: false, said: `${name} failed (${why(e)})` }; }
    const end = await Promise.race([ended(), sleep(5000).then(() => undefined)]);
    if (end?.exit) return { ok: true, said: `exited on ${name}` };
    if (end?.error) return { ok: false, said: `ended with an error (${why(end.error)})` };
  }
  return { ok: false, said: "NOT seen to exit" };
};
/** The proxied pairs still open closed now; the stage fails on any close that failed, now or earlier in the run (the
 * ledger keeps those after their closer has left the registry) */
const proxiedStage = (registry, ledger) => {
  const all = [...registry];
  for (const f of all) try { f(1000); } catch (e) { ledger.push(why(e)); }
  return ledger.length ? { ok: false, said: `NOT all closed (${ledger.join(", ")})` } : { ok: true, said: `${all.length} closed` };
};
/** Each closed; any that throws is said */
const closeEach = (list, f) => { const bad = []; for (const s of list) try { f(s); } catch (e) { bad.push(why(e)); } return bad.length ? { ok: false, said: `NOT all closed (${bad.join(", ")})` } : { ok: true, said: `${list.length} closed` }; };
const removeDir = (d) => { if (!d) return { ok: true, said: "never made" }; try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); return { ok: true, said: "removed" }; } catch (e) { return { ok: false, said: `NOT removed (${why(e)})` }; } };
/** Stages run one after another, each whatever the ones before it did: a stage that throws, says it failed, or doesn't
 * end within `ms`, is a failure, named; none is skipped.  Never rejects, and ends within (stages x ms).  Says each
 * stage, and whether all were done. */
const STAGE_MS = 15_000;
const runStages = async (stages, ms = STAGE_MS) => {
  const out = [];
  for (const [name, f] of stages) {
    try { const r = await bounded(Promise.resolve().then(f), name, ms); out.push({ name, ok: !!r?.ok, said: r?.said ?? "(said nothing)" }); }
    catch (e) { out.push({ name, ok: false, said: `threw (${why(e)})` }); }
  }
  return { line: "cleanup: " + out.map((s) => `${s.name} ${s.said}`).join("; "), ok: out.every((s) => s.ok) };
};
let cleaned = null;
/** Everything this run started, ended, and what it made, removed: once, however the run ends (its end, a failure, the
 * watchdog or SIGTERM), every stage attempted. */
const cleanup = () => (cleaned ??= runStages([
  ["DevTools sockets", () => closeEach(sockets, (s) => s.close())],
  ["proxied sockets", () => proxiedStage(closers, closeFailures)],
  ["Chrome", () => stopChrome()],
  ["front", async () => { if (!server) return { ok: true, said: "never started" }; await server.stop(true); return { ok: true, said: "stopped" }; }],
  ["profile", () => removeDir(profile)],
  ["site", () => removeDir(site)],
]).catch((e) => ({ line: `cleanup: rejected (${why(e)})`, ok: false })));
/** The run ended from outside its flow (the watchdog, SIGTERM): said, cleaned up, exit 1. */
const endNow = async (why) => {
  console.error(`FAIL: ${why}; waiting on: ${waitingOn}`);
  // (a backstop past the cleanup's own bound: the run ends even if the cleanup somehow doesn't)
  setTimeout(() => { console.error("FAIL: the cleanup didn't end within 120 s"); process.exit(1); }, 120_000);
  console.error("  " + (await cleanup()).line);
  process.exit(1);
};
// (the watchdog, armed before anything starts: past the run's own limit and its cleanup, the run is ended, named)
setTimeout(() => endNow(`the run didn't end within ${LIMIT_S + 120} s`), (LIMIT_S + 120) * 1000).unref();
process.once("SIGTERM", () => endNow("ended by SIGTERM"));

let results = [];
try {
  // (the temporary directories, made inside the try: if the second can't be, the cleanup still removes the first)
  profile = mkdtempSync(join(tmpdir(), "sb-scr-"));
  site = mkdtempSync(join(tmpdir(), "sb-scr-site-"));
  // (controls of the cleanup itself, in this process, with faults injected: every stage still runs, each failure is
  // named and the whole fails; a kill that throws other than ESRCH is not a stop; a spawn error is never an exit)
  {
    const d = mkdtempSync(join(tmpdir(), "sb-scr-ctl-"));
    const c = await runStages([
      ["a kill", () => { throw Object.assign(new Error("injected"), { code: "EPERM" }); }],
      ["a front", async () => { throw new Error("injected stop failure"); }],
      ["a directory", () => removeDir(d)],
    ]);
    control1(!c.ok && c.line === "cleanup: a kill threw (EPERM); a front threw (injected stop failure); a directory removed" && !existsSync(d), "(control) the cleanup runs every stage after failures, names each and fails: " + c.line);
    // (the real pair closer, registered as the front registers one, its server side refusing, closed the way the cases'
    // paths close it (its answer ignored) BEFORE the cleanup: the failure is kept, the page's side still closed, once
    // only, and the cleanup's proxied-sockets stage, run on that registry and ledger, fails naming it)
    let pageClosed = false;
    const reg = new Set(), led = [];
    const pc = pairCloser({ close() { throw Object.assign(new Error("injected"), { code: "EPIPE" }); } }, { close() { pageClosed = true; } }, () => reg.delete(pc), led);
    reg.add(pc);
    pc(1000);
    const pcAgain = pc(1000), stage = proxiedStage(reg, led);
    control1(pageClosed && pcAgain.length === 0 && reg.size === 0 && J(led) === J(["the server's side (EPIPE)"]) && !stage.ok && stage.said === "NOT all closed (the server's side (EPIPE))", "(control) a proxied pair's close that fails before the cleanup still fails the cleanup's stage: " + J(stage));
    const d2 = mkdtempSync(join(tmpdir(), "sb-scr-ctl-"));
    const t0 = Date.now(), c2 = await runStages([["a front stop that never settles", () => new Promise(() => {})], ["a directory", () => removeDir(d2)]], 200);
    control1(!c2.ok && c2.line === "cleanup: a front stop that never settles threw (no answer within 200 ms: a front stop that never settles); a directory removed" && !existsSync(d2) && Date.now() - t0 < 5000, "(control) a stage that never ends fails within its bound, and the stages after it still run: " + c2.line);
    const eperm = await stopChrome({ pid: 1, exitCode: null, signalCode: null, kill() { throw Object.assign(new Error("injected"), { code: "EPERM" }); } }, () => new Promise(() => {}));
    control1(!eperm.ok && eperm.said === "TERM failed (EPERM)", "(control) a kill refused (EPERM) is a failure, not a stop: " + eperm.said);
    const esrch = await stopChrome({ pid: 1, exitCode: null, signalCode: null, kill() { throw Object.assign(new Error("injected"), { code: "ESRCH" }); } }, async () => ({ exit: [0, null] }));
    control1(esrch.ok && esrch.said === "exited on TERM", "(control) a kill that finds the process gone (ESRCH), then its exit seen, is a stop: " + esrch.said);
    const spawnError = await stopChrome({ pid: 1, exitCode: null, signalCode: null, kill() {} }, async () => ({ error: Object.assign(new Error("injected"), { code: "ENOENT" }) }));
    control1(!spawnError.ok && spawnError.said === "ended with an error (ENOENT)", "(control) a spawn error is never taken for an observed exit: " + spawnError.said);
  }
  // (the page: the workspace bundled in this process, and the cases beside it)
  waitingOn = "the page's bundle (Bun.build of index.ts)";
  const b = await bounded(Bun.build({ entrypoints: [join(here, "index.ts")], outdir: site, naming: "ws.js", target: "browser", format: "esm" }), waitingOn, 120_000);
  if (!b.success) throw new Error("the page's bundle: " + b.logs.map(String).join("\n"));
  copyFileSync(join(here, "sync-client-cases.js"), join(site, "cases.js"));
  writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>sync client test</title><script>window.ACCOUNTS = ${J(ACCOUNTS)}; window.FULL = ${J(FULL)}; window.SMALL = ${J(SMALL)}; window.REQUIRE_CLAIM = true;</script><script type="module">import { run } from "./cases.js"; window.run = run; window.ready = true;</script>`);
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: serve, websocket });
  origin = `http://127.0.0.1:${server.port}`;

  let port = Number(process.env.CDP_PORT) || 0;
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--js-flags=--expose-gc", "--enable-precise-memory-info", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  chromeEnded = new Promise((r) => { chrome.once("exit", (code, signal) => r({ exit: [code, signal] })); chrome.once("error", (error) => r({ error })); });
  waitingOn = "Chrome's DevTools port";
  if (!port) port = await bounded(Promise.race([devtoolsPort(profile), chromeEnded.then((end) => { throw new Error(end?.error ? `Chrome didn't start: ${why(end.error)}` : `Chrome ended before its DevTools port: exit ${J(end?.exit)}`); })]), waitingOn, 60_000);
  let targets;
  waitingOn = "the page list (/json)";
  for (let i = 0; i < 300; i++) { try { targets = await bounded(fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()), waitingOn, 5000); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
  const pageTarget = Array.isArray(targets) ? targets.find((t) => t.type === "page") : undefined;
  if (!pageTarget) throw new Error("no page target in /json after 300 tries");
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  sockets.push(ws);
  await bounded(new Promise((r) => (ws.onopen = r)), (waitingOn = "the page's DevTools socket to open"), 10_000);
  let n = 0;
  const waiting = new Map(), errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? J(m.params.exceptionDetails));
    if (m.method === "Runtime.consoleAPICalled" && process.env.SHOW_CONSOLE) console.log("page:", m.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  const describe = (method, params) => method + (params?.expression ? ": " + String(params.expression).replace(/\s+/g, " ").slice(0, 160) : "");
  const send = (method, params = {}, ms = CALL_MS) => { const id = ++n, what = describe(method, params); waitingOn = what; return bounded(new Promise((r) => { waiting.set(id, r); ws.send(J({ id, method, params })); }), what, ms).finally(() => waiting.delete(id)); };
  const ev = async (expression, ms) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms); if (r.exceptionDetails) throw new Error(J(r.exceptionDetails).slice(0, 2000)); return r.result?.value; };
  await send("Runtime.enable");
  await send("Page.navigate", { url: `${origin}/` });
  let ready = false;
  for (let i = 0; i < 200 && !(ready = await ev("window.ready === true", 5000).catch(() => false)); i++) await sleep(50);
  if (!ready) throw new Error("the page didn't become ready (window.ready)");
  // (the run: every case but the cloud-only ones, which are skipped by name; a run that doesn't end within its limit
  // says which case it was in)
  for (const name of CLOUD_ONLY) if (selected(name)) console.log(`skipped (cloud-only, the reference server has no quotas): ${name}`);
  results = await ev(`window.run(${J(ONLY)}, ${J(CLOUD_ONLY.join(","))})`, LIMIT_S * 1000).catch(async (e) => {
    const where = await ev("JSON.stringify({ progress: window.progress })", 5000).catch(() => "(the page doesn't answer)");
    throw new Error(`the run didn't end within ${LIMIT_S} s (${e.message}): ${where}`);
  });
  waitingOn = "(the run's results)";
  fails.push(...results.filter(([ok]) => !ok).map(([, what]) => what));
  // (claims: with SYNC_REQUIRE_CLAIM the legacy path is a failure, never a pass; its only result says "not exercised")
  for (const [, what] of results) if (/not exercised/.test(what)) fails.push(`a "not exercised" result: ${what}`);
  // (measurements, printed pass or fail)
  for (const [, what] of results) if (/figures/.test(what)) console.log("  " + what);
  // (informational: the reference server sends index_changed after ops that move an account's head; ctl.serverNotices
  // is off, so the front drops them)
  console.log(`  front: the server's own index_changed notices dropped (ctl.serverNotices off): ${serverNoticesDropped}`);
  // (the downloads went through the redirect to the page's own /__files/: required when a download case ran)
  if (DOWNLOADS.some(selected)) {
    console.log(`  front: downloads through /__files/: ${front.files200}`);
    if (front.files200 === 0) fails.push("no download went through /__files/ (the blob GET's redirect)");
  } else console.log("  front: downloads through /__files/: not required (ONLY names no download case)");
  if (front.leaks.length) fails.push(`the internal origin leaked to the page: ${front.leaks.length} responses: ${front.leaks.slice(0, 5).join("; ")}`);
  for (const e of errors) fails.push("page error: " + e);
} catch (e) {
  fails.push(`threw: ${e?.stack ?? e} (waiting on: ${waitingOn})`);
} finally {
  const c = await cleanup();
  console.log("  " + c.line);
  if (!c.ok) fails.push("not everything was cleaned up: " + c.line);
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
const skipped = CLOUD_ONLY.filter(selected).length;
console.log(`ok: sync's client against the reference server, ${results.length} checks, ${controls.length} runner controls, ${skipped} cloud-only cases skipped`);
if (process.env.SHOW) for (const [, what] of results) console.log("  " + what);
process.exit(0);
