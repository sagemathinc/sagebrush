// ci: web-browser/board-unit.1 order=52 runner=bun
// pair-tunnel.js, the page's tunnel to "Your computer (paired)", against a fake socket playing the runner
// (local-kernel plan r2 §3, deltas r3 D2-D5 and r3.1): the closed table; dispatch in fetch's turn and the one
// NotSent classification; answers, nonce retries and event streams through the real RemoteClient; aborts and the
// retirement handshake, late frames ignored; every protocol failure closing the socket; the 8 open ids, 256
// retired and 1 MiB / 16 MiB stream bounds; the hello; and zero network besides the paired socket.
// The real runner end to end: test-pair-runner.mjs.
//   bun web/notebook/test-pair-tunnel.mjs
import { RemoteClient, NotSentError, AmbiguousError, StreamError } from "./remote-client.js";
import { Tunnel, pairTunnel, route, TunnelNotSent, PairError, SYNTHETIC_BASE, TUNNEL_LIMITS, parsePairLink, versionAtLeast, RUNNER_MIN } from "./pair-tunnel.js";

setTimeout(() => { console.log("FAIL the tests did not finish within 120 s"); process.exit(1); }, 120_000).unref?.();
let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms = 3000) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), new Promise((r) => setTimeout(() => r({ timeout: true }), ms))]);
// (until the socket has been handed `n` request frames: the page signs each one first, which on a loaded runner can
//  take longer than a tick, and an answer delivered before its request is sent goes to no id; false after `ms`)
const sent = async (ws, n, ms = 3000) => { const end = Date.now() + ms; while (ws.requests().length < n) { if (Date.now() > end) return false; await tick(1); } return true; };

// ---- zero network: every other way out is a spy (D2)
const spied = { fetch: 0, xhr: 0, beacon: 0, ws: 0 };
globalThis.fetch = () => { spied.fetch++; return Promise.reject(new Error("no network")); };
globalThis.XMLHttpRequest = class { constructor() { spied.xhr++; } };
globalThis.navigator ??= {};
try { globalThis.navigator.sendBeacon = () => { spied.beacon++; return false; }; } catch {}
globalThis.WebSocket = class { constructor() { spied.ws++; throw new Error("no network"); } };

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closedWith = null;
    FakeSocket.last = this;
  }
  open() { this.readyState = 1; this.onopen?.({}); }
  send(t) { if (this.readyState !== 1) throw new Error("not open"); this.sent.push(JSON.parse(t)); }
  close(code, reason) { if (this.readyState === 3) return; this.closedWith = code; this.closedFor = reason; this.readyState = 3; queueMicrotask(() => this.onclose?.({ code })); }
  deliver(m) { this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) }); }
  requests() { return this.sent.filter((f) => f.rpc); }
}
const RESULT = { protocol: 1, purpose: "kernel", token: "T".repeat(43), nonce: "n1", incarnation: "0123456789abcdef", limits: { frame: 4 * 1024 * 1024 }, version: "dev" };

async function setup() {
  const ws = new FakeSocket("ws://127.0.0.1:1/sagebrush-kernel");
  ws.readyState = 1;
  const closes = [];
  const t = new Tunnel(ws, RESULT, { onClose: (why) => closes.push(why) });
  const client = await RemoteClient.create({ base: SYNTHETIC_BASE, token: () => t.tokenSource(), fetch: t.fetch });
  client.nonce = t.nonce;
  return { ws, t, client, closes };
}
const json = (id, status, body, headers = {}) => ({ id, status, headers: { "content-type": "application/json", "dpop-nonce": "n2", ...headers }, body: JSON.stringify(body) });

// ================= the closed table
{
  const B = SYNTHETIC_BASE;
  const ok = [
    ["POST", `${B}/bindings`, "g.bind", {}],
    ["POST", `${B}/bindings/b1/runs`, "g.run", { b: "b1" }],
    ["GET", `${B}/bindings/b1/runs/r.1-x_~`, "g.record", { b: "b1", r: "r.1-x_~" }],
    ["GET", `${B}/bindings/b1/runs/r1/events?after=7`, "g.events", { b: "b1", r: "r1", after: 7 }],
    ["POST", `${B}/bindings/b1/interrupt`, "g.interrupt", { b: "b1" }],
    ["POST", `${B}/bindings/b1/restart`, "g.restart", { b: "b1" }],
    ["POST", `${B}/bindings/b1/takeover`, "g.takeover", { b: "b1" }],
    ["POST", `${B}/bindings/b1/complete`, "g.complete", { b: "b1" }],
  ];
  check(ok.every(([m, u, rpc, ref]) => { const r = route(m, u); return r.rpc === rpc && JSON.stringify(r.ref) === JSON.stringify(ref); }), "the eight routes, and their refs");
  const refused = [
    ["GET", `${B}/bindings`], // (a method the route doesn't take)
    ["POST", "https://evil.example/api/compute/v1/bindings"],
    ["POST", "https://local.sagebrush.invalid/api/compute/v2/bindings"],
    ["POST", `${B}/bindings/b1/files`],
    ["POST", `${B}/bindings/b1/runs?x=1`],
    ["GET", `${B}/bindings/b1/runs/r1/events`],
    ["GET", `${B}/bindings/b1/runs/r1/events?after=-1`],
    ["GET", `${B}/bindings/b1/runs/r1/events?after=01`],
    ["GET", `${B}/bindings/b1/runs/r1/events?after=1&x=2`],
    ["GET", `${B}/bindings/b1/runs/r1/events?after=99999999999999999`],
    ["GET", `${B}/bindings/b1/runs/../runs/r1`],
    ["GET", `${B}/bindings/b1/runs/a%2Fb`],
    ["GET", `${B}/bindings/b1/runs/r1#x`],
    ["GET", `${B}/bindings/${"a".repeat(65)}/runs/r1`],
  ];
  const all = refused.map(([m, u]) => { try { route(m, u); return false; } catch (e) { return e instanceof TunnelNotSent; } });
  check(all.every(Boolean), `everything else is refused unsent (${all.map((x, i) => (x ? "" : i)).join("")})`);
}

// ================= answers through the real client; the nonce retry
{
  const { ws, t, client } = await setup();
  const p = client.request("POST", "/bindings", { notebook: "n" });
  await sent(ws, 1);
  let f = ws.requests()[0];
  check(f.id === "t1" && f.rpc === "g.bind" && f.auth === "DPoP " + RESULT.token && f.dpop.split(".").length === 3 && f.accept === "application/json" && JSON.parse(f.body).notebook === "n"
    && Object.keys(f).sort().join() === "accept,auth,body,dpop,id,ref,rpc", "a request frame: exactly its members, the body as text");
  ws.deliver({ id: "t1", status: 401, headers: { "www-authenticate": 'DPoP error="use_dpop_nonce"', "dpop-nonce": "n9", "content-type": "application/json" }, body: JSON.stringify({ error: "use_dpop_nonce" }) });
  await sent(ws, 2);
  f = ws.requests()[1];
  check(f?.id === "t2" && JSON.parse(atob(f.dpop.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).nonce === "n9", "a nonce challenge is retried once, with the new nonce");
  ws.deliver(json("t2", 200, { binding: "b1", epoch: 1 }));
  const r = await within(p);
  check(r.v?.binding === "b1" && t.pending.size === 0, "the answer resolves the request");
  const g = client.request("POST", "/bindings/b1/interrupt", { epoch: 1, op_id: "o" });
  await sent(ws, 3);
  ws.deliver(json("t3", 409, { error: "stale" }));
  check((await within(g)).e?.code === "stale", "a typed refusal is a GatewayError");
}

// ================= events: a stream, its end; a slow end at the runner, then the resume and the handshake
{
  const { ws, t, client } = await setup();
  const got = [];
  const it = (async () => { for await (const ev of client.events("/bindings/b1/runs/r1", 0)) got.push(ev); })();
  await sent(ws, 1);
  const f = ws.requests()[0];
  check(f.rpc === "g.events" && f.ref.after === 0 && f.accept === "text/event-stream" && !("body" in f), "an events request: after in its ref, no body");
  ws.deliver({ id: "t1", status: 200, headers: { "content-type": "text/event-stream", "dpop-nonce": "n2" } });
  ws.deliver({ id: "t1", chunk: 'id: 1\ndata: {"seq":1,"type":"stream","text":"a"}\n\n' });
  ws.deliver({ id: "t1", chunk: 'id: 2\ndata: {"seq":2,"type":"terminal"}\n\n' });
  ws.deliver({ id: "t1", end: true });
  await within(it);
  check(got.map((e) => e.seq).join() === "1,2" && t.pending.size === 0 && t.retired.size === 0, "chunks become the client's events; end closes the stream, nothing retired");
  const it2 = (async () => { const out = []; for await (const ev of client.events("/bindings/b1/runs/r1", 2)) out.push(ev); return out; })();
  await sent(ws, 2);
  ws.deliver({ id: "t2", status: 200, headers: { "content-type": "text/event-stream" } });
  ws.deliver({ id: "t2", streamError: "slow" });
  const r2 = await within(it2);
  check(r2.e instanceof StreamError, "a slow end at the runner is a StreamError (the client resumes from its last seq)");
  check(ws.sent.at(-1)?.cancel === "t2" && t.retired.has("t2"), "and the page retires it: {cancel}");
  ws.deliver({ id: "t2", chunk: "id: 3\ndata: {}\n\n" });
  check(t.stats.late === 1 && !ws.closedWith, "a late frame for a retired id is ignored and counted");
  ws.deliver({ id: "t2", retired: true });
  check(!t.retired.has("t2") && !ws.closedWith, "its retired answer forgets it");
  const u = client.request("POST", "/bindings/b1/interrupt", { epoch: 1, op_id: "o" });
  await sent(ws, 3);
  ws.deliver(json("t3", 200, { outcome: { status: "done" } }));
  check((await within(u)).v?.outcome?.status === "done", "an unrelated request still works");
}

// ================= aborts: cancel once, the late answer ignored, the handshake; unsent if aborted first
{
  const { ws, t, client } = await setup();
  const ac = new AbortController();
  const p = client.request("POST", "/bindings/b1/runs", { request: "r1" }, { signal: ac.signal });
  await sent(ws, 1);
  ac.abort();
  const r = await within(p);
  check(r.e instanceof AmbiguousError && r.e.aborted, "an abort after the send: ambiguous (the run may have been admitted)");
  check(ws.sent.filter((f) => f.cancel === "t1").length === 1 && t.retired.get("t1") === true, "one {cancel}; the retired request still counts at the runner");
  ws.deliver(json("t1", 202, { request: "r1", state: "admitted" }));
  ws.deliver({ id: "t1", retired: true });
  check(t.stats.late === 1 && t.retired.size === 0 && !ws.closedWith, "its late answer ignored, then retired");
  const ac2 = new AbortController();
  ac2.abort();
  const q = await within(client.request("POST", "/bindings/b1/runs", { request: "r2" }, { signal: ac2.signal }));
  check(q.e instanceof NotSentError && ws.requests().length === 1, "aborted before: never sent");
}

// ================= dispatch: 8 open ids at most, refused unsent (never later); the frame cap; a closed socket
{
  const { ws, t, client } = await setup();
  const ps = [];
  for (let i = 0; i < 8; i++) ps.push(client.request("POST", "/bindings/b1/complete", { epoch: 1, op_id: `o${i}`, code: "x", cursor_pos: 1 }));
  ps.forEach((p) => p.catch(() => {}));
  await sent(ws, 8);
  check(ws.requests().length === 8, "8 requests open");
  const ninth = await within(client.request("POST", "/bindings/b1/complete", { epoch: 1, op_id: "o9", code: "x", cursor_pos: 1 }));
  check(ninth.e instanceof NotSentError && ws.requests().length === 8, "a 9th is NotSent, at once");
  // (o0's own frame, whatever order the 8 reached the socket in (grader's :179 flake): the rest stay in flight)
  const f0 = ws.requests().find((f) => JSON.parse(f.body).op_id === "o0");
  ws.deliver(json(f0.id, 200, { matches: [] }));
  await tick(20);
  check(ws.requests().length === 8, "credit returning doesn't send it later");
  // (a raw fetch past the frame cap)
  let threw = null;
  try { t.fetch(`${SYNTHETIC_BASE}/bindings/b1/runs`, { method: "POST", headers: { Authorization: "DPoP x", DPoP: "y" }, body: "x".repeat(RESULT.limits.frame) }); } catch (e) { threw = e; }
  check(threw instanceof TunnelNotSent, "a frame over the runner's limit is refused unsent");
  // the socket goes: every request in flight ambiguous, later ones NotSent
  ws.close(1006);
  await tick();
  const rs = await Promise.all(ps.slice(1).map((p) => within(p)));
  check(rs.every((x) => x.e instanceof AmbiguousError), "the socket lost: the requests in flight are ambiguous");
  check((await within(client.request("POST", "/bindings/b1/interrupt", { epoch: 1, op_id: "z" }))).e instanceof NotSentError, "and a request afterwards is NotSent");
}

// ================= a TunnelNotSent from fetch is the only NotSent; a socket that fails after the send is ambiguous
{
  const { ws, t, client } = await setup();
  ws.send = () => { throw new Error("the socket broke during send"); };
  const r = await within(client.request("POST", "/bindings", { notebook: "n" }));
  check(r.e instanceof AmbiguousError, "a failure inside the socket's send is ambiguous, not NotSent");
}

// ================= protocol failures close the socket (4002 etc.)
for (const [what, m, code] of [
  ["a frame for an id never sent", { id: "t5", status: 200, headers: {}, body: "{}" }, 4002],
  ["a malformed frame", { id: "x1", status: 200 }, 4002],
  ["not JSON", "{", 4002],
  ["an unsolicited retirement", { id: "t1", retired: true }, 4002],
  ["an answer with an extra member", { id: "t1", status: 200, headers: {}, body: "{}", x: 1 }, 4002],
  ["a status out of range", { id: "t1", status: 700, headers: {}, body: "{}" }, 4002],
  ["a header not a string", { id: "t1", status: 200, headers: { a: 1 }, body: "{}" }, 4002],
  // (astra's PROTO-1: answers fetch's Response refuses, each closing rather than leaving the request unsettled)
  ["a 204 with a body", { id: "t1", status: 204, headers: {}, body: "x" }, 4002],
  ["a 205 with a body", { id: "t1", status: 205, headers: {}, body: "x" }, 4002],
  ["a 304 with a body", { id: "t1", status: 304, headers: {}, body: "x" }, 4002],
  ["an invalid header name", { id: "t1", status: 200, headers: { "bad header": "x" }, body: "{}" }, 4002],
  ["an invalid header value", { id: "t1", status: 200, headers: { a: "x\r\ny: z" }, body: "{}" }, 4002],
  ["a frame over its limit", JSON.stringify({ id: "t1", pad: "x".repeat(TUNNEL_LIMITS.frameIn) }), 4009],
]) {
  const { ws, t, client } = await setup();
  const p = client.request("POST", "/bindings", { notebook: "n" });
  p.catch(() => {});
  await sent(ws, 1);
  ws.deliver(m);
  await tick();
  check(ws.closedWith === code && t.closed && (await within(p)).e instanceof AmbiguousError, `${what}: closed ${code}, the request ambiguous`);
}
{
  const { ws, t, client } = await setup();
  const p = client.request("POST", "/bindings", { notebook: "n" });
  await sent(ws, 1);
  ws.deliver(json("t1", 200, { binding: "b1" }));
  await within(p);
  ws.deliver(json("t1", 200, { binding: "b2" }));
  check(ws.closedWith === 4002, "a second answer closes the socket");
  const { ws: ws2, t: t2 } = await setup();
  ws2.onmessage({ data: new Uint8Array(3) });
  check(ws2.closedWith === 4003 && t2.closed, "a binary frame closes the socket");
}

{
  // (the stream head too: an invalid header on an events head closes, the stream never handed out)
  const { ws, t } = await setup();
  const p = t.fetch(`${SYNTHETIC_BASE}/bindings/b1/runs/r1/events?after=0`, { method: "GET", headers: { Authorization: "a", DPoP: "d" } });
  p.catch(() => {});
  ws.deliver({ id: "t1", status: 200, headers: { "bad header": "x" } });
  const r = await within(p);
  check(ws.closedWith === 4002 && r.e instanceof TypeError, "an events head fetch refuses: closed, the request ambiguous");
  // (and the healthy control: a 204 without a body, an ordinary header, resolve)
  const { ws: w2, t: t2 } = await setup();
  const q = t2.fetch(`${SYNTHETIC_BASE}/bindings/b1/interrupt`, { method: "POST", headers: { Authorization: "a", DPoP: "d" }, body: "{}" });
  w2.deliver({ id: "t1", status: 204, headers: { "x-ok": "1" } });
  const ok204 = await within(q);
  check(ok204.v?.status === 204 && ok204.v.headers.get("x-ok") === "1" && !w2.closedWith, "the control: a 204 without a body resolves");
}

// ================= bounds: 256 retired rotate; a stream the page doesn't read; 16 MiB across streams
{
  const { ws, t } = await setup();
  for (let i = 0; i < TUNNEL_LIMITS.retired; i++) {
    const ac = new AbortController();
    const p = t.fetch(`${SYNTHETIC_BASE}/bindings/b1/runs/r1/events?after=0`, { method: "GET", headers: { Authorization: "a", DPoP: "d", Accept: "text/event-stream" }, signal: ac.signal });
    p.catch(() => {});
    ws.deliver({ id: `t${i + 1}`, status: 200, headers: {} });
    (await p).body.getReader(); // (a reader that never reads)
    ac.abort();
  }
  check(t.retired.size === TUNNEL_LIMITS.retired && !t.closed, "256 retired ids awaiting their answer");
  const ac = new AbortController();
  const p = t.fetch(`${SYNTHETIC_BASE}/bindings/b1/runs/r1/events?after=0`, { method: "GET", headers: { Authorization: "a", DPoP: "d" }, signal: ac.signal });
  p.catch(() => {});
  ws.deliver({ id: "t257", status: 200, headers: {} });
  await p;
  ac.abort();
  await tick();
  check(t.closed && ws.closedWith === 4000, "the 257th: the socket is closed and pairs again (no silent eviction)");
}
{
  const { ws, t } = await setup();
  const p = t.fetch(`${SYNTHETIC_BASE}/bindings/b1/runs/r1/events?after=0`, { method: "GET", headers: { Authorization: "a", DPoP: "d" } });
  ws.deliver({ id: "t1", status: 200, headers: {} });
  const res = await p;
  const reader = res.body.getReader();
  const chunk = "x".repeat(256 * 1024);
  for (let i = 0; i < 4; i++) ws.deliver({ id: "t1", chunk });
  check(t.pending.has("t1"), "1 MiB unread: still open");
  ws.deliver({ id: "t1", chunk: "x" });
  check(!t.pending.has("t1") && ws.sent.at(-1)?.cancel === "t1", "a byte more: the stream is cancelled (the page isn't reading it)");
  const r = await within(reader.read().then(async function drain(x) { while (!(x = await reader.read()).done); }));
  check(r.e, "and its reader sees an error");
}
{
  const { ws, t } = await setup();
  const readers = [];
  for (let k = 0; k < 8; k++) {
    const p = t.fetch(`${SYNTHETIC_BASE}/bindings/b1/runs/r${k}/events?after=0`, { method: "GET", headers: { Authorization: "a", DPoP: "d" } });
    ws.deliver({ id: `t${k + 1}`, status: 200, headers: {} });
    readers.push((await p).body.getReader());
  }
  const chunk = "y".repeat(TUNNEL_LIMITS.subBytes - 64);
  for (let k = 0; k < 8; k++) ws.deliver({ id: `t${k + 1}`, chunk });
  check(t.pending.size === 8, "8 streams, each just under 1 MiB unread");
  // (the aggregate, made smaller for the test: the same check)
  const real = TUNNEL_LIMITS.allSubBytes;
  check(t.buffered() > 8 * (TUNNEL_LIMITS.subBytes - 128) && t.buffered() <= 8 * TUNNEL_LIMITS.subBytes, "the page counts every stream's unread bytes");
  check(real === 16 * 1024 * 1024 && TUNNEL_LIMITS.open * TUNNEL_LIMITS.subBytes <= real, "16 MiB in all bounds the 8 streams' 1 MiB each");
}

// ================= the hello
{
  const made = [];
  class S extends FakeSocket { constructor(u) { super(u); made.push(this); setTimeout(() => this.open(), 1); } }
  const jwk = { kty: "EC", crv: "P-256", x: "X".repeat(43), y: "Y".repeat(43), ext: true, key_ops: [] };
  const p = pairTunnel({ port: 4321, code: " abcd ", remember: true, jwk, jkt: "J".repeat(43), WebSocket: S });
  await tick(10);
  const h = made[0].sent[0];
  check(made[0].url === "ws://127.0.0.1:4321/sagebrush-kernel", "only ws://127.0.0.1:<port>/sagebrush-kernel");
  check(h.method === "hello" && h.id === "h1" && h.params.code === "ABCD" && h.params.remember === true && h.params.purpose === "kernel" && h.params.protocol === 1
    && JSON.stringify(h.params.jwk) === JSON.stringify({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }), "the hello: the code, purpose, protocol, and exactly the key's four members");
  made[0].deliver({ jsonrpc: "2.0", id: "h1", result: { ...RESULT, session: "s".repeat(43) } });
  const t = (await within(p)).v;
  check(t instanceof Tunnel && t.session === "s".repeat(43) && t.token === RESULT.token, "paired: the tunnel, its token and session");
  const refusal = pairTunnel({ port: 4321, code: "x", jwk, jkt: "j", WebSocket: S });
  await tick(10);
  made[1].deliver({ jsonrpc: "2.0", id: "h1", error: { code: -32000, message: "wrong code", data: { code: "refused" } } });
  const e1 = (await within(refusal)).e;
  check(e1 instanceof PairError && e1.message === "wrong code" && e1.kind === "refused" && made[1].closedWith === 1000, "a refusal is a PairError with the runner's words");
  const odd = pairTunnel({ port: 4321, code: "x", jwk, jkt: "j", WebSocket: S });
  await tick(10);
  made[2].deliver({ jsonrpc: "2.0", id: "h1", result: { ...RESULT, token: "short" } });
  check((await within(odd)).e?.kind === "protocol", "a malformed result is refused");
  const n = made.length;
  for (const port of [0, 65536, "80; evil", 1.5, -1]) check((await within(pairTunnel({ port, code: "x", jwk, jkt: "j", WebSocket: S }))).e instanceof PairError && made.length === n, `port ${JSON.stringify(port)}: refused, no socket made`);
  check((await within(pairTunnel({ port: 1, jwk, jkt: "j", WebSocket: S }))).e instanceof PairError && made.length === n, "neither code nor session: refused");
  const slow = pairTunnel({ port: 4321, code: "x", jwk, jkt: "j", WebSocket: class extends FakeSocket {}, timeoutMs: 30 });
  check((await within(slow)).e?.kind === "timeout", "no answer: a timeout");
  const shut = pairTunnel({ port: 4321, code: "x", jwk, jkt: "j", WebSocket: class extends FakeSocket { constructor(u) { super(u); setTimeout(() => this.onclose?.({ code: 1006 }), 1); } } });
  check((await within(shut)).e?.kind === "unreachable", "nothing listening: unreachable, said plainly");
}

// ================= the words a person sees for a lost socket; the paired start keeps a code that never reached the runner
{
  const { ws, t, closes } = await setup();
  ws.onerror();
  check(closes[0] === "the connection dropped" && t.closed, "a socket error: \"the connection dropped\" (no raw codes)");
  const { ws: w2, closes: c2 } = await setup();
  w2.onclose({ code: 1006 });
  const { ws: w3, closes: c3 } = await setup();
  w3.onclose({ code: 1001 });
  check(c2[0] === "the connection dropped" && c3[0] === "the runner on your computer stopped", "1006: dropped; 1001: the runner stopped");
  const { pairedStarter, PAIRED } = await import("./remote-ui.js");
  const hellos = [];
  let n = 0;
  class S extends FakeSocket {
    constructor(u) {
      super(u);
      const first = n++ === 0;
      setTimeout(() => (first ? this.onclose?.({ code: 1006 }) : this.open()), 1);
    }
    send(t) {
      super.send(t);
      const m = JSON.parse(t);
      if (m.method === "hello") {
        hellos.push(m.params);
        this.deliver({ jsonrpc: "2.0", id: "h1", result: { ...RESULT, session: "s".repeat(43) } });
      } else if (m.rpc === "g.bind") queueMicrotask(() => this.deliver(json(m.id, 200, { binding: "b1", epoch: 1, incarnation: 1, state: "ready" })));
    }
  }
  const start = pairedStarter({ WebSocket: S });
  const r = await start({ notebook: "nb", answer: { code: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", port: 4321 } });
  check(/nothing answered on that port/.test(r.failed) && /site settings/.test(r.hint) && /Retry/.test(r.hint) && !/`/.test(r.failed + r.hint), `nothing listening (or blocked): says how to undo a Block, after the reason (${r.failed} / ${r.hint})`);
  await r.retry();
  check(hellos.length === 1 && hellos[0].code === "ABCDEFGHIJKLMNOPQRSTUVWXYZ" && r.tunnel && r.kernel.ready && r.failed === null, "Retry pairs with the code that never reached the runner, and binds");
  r.close();
  check(PAIRED.sessionGone === "this page needs a new link from your computer: run uvx sagebrush@latest remote --loopback again, then choose Your computer and paste it", "the session-gone words: neutral, since a post-send timeout ends there too (board's R3-a)");
  // (board's R3-b: a bad port isn't a Block, so no Block hint; its code was never sent, so Retry keeps it)
  const rp = await pairedStarter({ WebSocket: class extends FakeSocket {} })({ notebook: "nb", answer: { code: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", port: 70000 } });
  check(/port is a number/.test(rp.failed) && rp.hint === null, `a bad port: said, and no Block hint (${rp.failed} / ${rp.hint})`);
  rp.close();
}

// ================= astra's RETRY-2: a code that may have reached the runner is never sent again
{
  const { pairedStarter } = await import("./remote-ui.js");
  const CODE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  // (a socket that never opens within the hello's time: the hello was never handed to it; Retry may use the code)
  {
    const hellos = [];
    let n = 0;
    class S extends FakeSocket {
      constructor(u) {
        super(u);
        if (n++ > 0) setTimeout(() => this.open(), 1); // (the first never opens)
      }
      send(t) {
        super.send(t);
        const m = JSON.parse(t);
        if (m.method === "hello") { hellos.push(m.params.code); this.deliver({ jsonrpc: "2.0", id: "h1", result: { ...RESULT, session: "s".repeat(43) } }); }
        else if (m.rpc === "g.bind") queueMicrotask(() => this.deliver(json(m.id, 200, { binding: "b1", epoch: 1, incarnation: 1, state: "ready" })));
      }
    }
    const r = await pairedStarter({ WebSocket: S, helloMs: 30 })({ notebook: "nb", answer: { code: CODE, port: 4321 } });
    check(r.failed === "your computer didn't answer" && hellos.length === 0, `a pre-open timeout: no hello was sent (${r.failed})`);
    await r.retry();
    check(hellos.length === 1 && hellos[0] === CODE && r.kernel.ready, "and Retry pairs with the same code");
    r.close();
  }
  // (a hello sent and never answered: the code may have arrived; Retry sends no second hello and asks for a new link)
  {
    const hellos = [];
    class S extends FakeSocket {
      constructor(u) { super(u); setTimeout(() => this.open(), 1); }
      send(t) { super.send(t); const m = JSON.parse(t); if (m.method === "hello") hellos.push(m.params.code); } // (never answered)
    }
    const r = await pairedStarter({ WebSocket: S, helloMs: 30 })({ notebook: "nb", answer: { code: CODE, port: 4321 } });
    check(hellos.length === 1 && /new link/.test(r.failed), `a post-send timeout: the hello went once, and a new link is asked for (${r.failed})`);
    const again = await r.retry();
    check(!again && hellos.length === 1, "Retry sends no second hello with that code");
    r.close();
  }
  // (a hello the socket closed on, after it was sent: likewise never sent again)
  {
    const hellos = [];
    class S extends FakeSocket {
      constructor(u) { super(u); setTimeout(() => this.open(), 1); }
      send(t) { super.send(t); const m = JSON.parse(t); if (m.method === "hello") { hellos.push(m.params.code); this.close(1006); } }
    }
    const r = await pairedStarter({ WebSocket: S, helloMs: 1000 })({ notebook: "nb", answer: { code: CODE, port: 4321 } });
    await r.retry();
    check(hellos.length === 1, "a close after the hello: Retry sends no second hello");
    r.close();
  }
}

// ================= the runner's version: reported, compared, a too-old runner refused before anything is bound
{
  // (one table for both sides: test_remote_pair.py reads the same file (daybreak3's VERSION-1 parity))
  const table = JSON.parse(await Bun.file(new URL("./version-cases.json", import.meta.url)).text()).cases;
  check(table.length > 15 && table.every(([v, n, want]) => versionAtLeast(v, n) === want), `the version compare, a release gate (${table.filter(([v, n, w]) => versionAtLeast(v, n) !== w).map(([v, n]) => JSON.stringify(v) + " vs " + JSON.stringify(n)).join(", ") || "all as expected"})`);
  check(RUNNER_MIN === "0.9.0", "the minimum: 0.9.0, the release that first ships sagebrush remote");
  const made = [];
  class S extends FakeSocket { constructor(u) { super(u); made.push(this); setTimeout(() => this.open(), 1); } }
  const jwk = { kty: "EC", crv: "P-256", x: "X".repeat(43), y: "Y".repeat(43) };
  // (a minimum passed exactly as given, falsy ones included)
  const answerMin = async (result, min) => {
    const p = pairTunnel({ port: 4321, code: "x", jwk, jkt: "J".repeat(43), WebSocket: S, min });
    await tick(10);
    const sock = made.at(-1);
    sock.deliver({ jsonrpc: "2.0", id: "h1", result });
    return { r: await within(p), hello: sock.sent[0], sock };
  };
  const answer = async (result, min) => {
    const p = pairTunnel({ port: 4321, code: "x", jwk, jkt: "J".repeat(43), WebSocket: S, ...(min ? { min } : {}) });
    await tick(10);
    const sock = made.at(-1);
    sock.deliver({ jsonrpc: "2.0", id: "h1", result });
    return { r: await within(p), hello: sock.sent[0], sock };
  };
  let a = await answer({ ...RESULT, version: undefined });
  check(a.r.e?.kind === "protocol", "a runner that reports no version isn't paired with");
  a = await answer({ ...RESULT, version: "0.8.2" }, "0.9.0");
  check(a.r.e?.kind === "old" && a.r.e.message === "your computer's sagebrush is 0.8.2; this page needs 0.9.0 or newer" && a.sock.closedWith === 1000 && a.hello.params.needs === "0.9.0",
    `a too-old runner: refused, said, the socket closed; the hello said what it needs (${a.r.e?.message})`);
  a = await answer({ ...RESULT, version: "0.9.0" }, "0.9.0");
  check(a.r.v instanceof Tunnel, "a new-enough runner pairs");
  // (astra's VERSION-2: a version outside the whole grammar is never paired with, minimum or not)
  for (const bad of ["0.9.0+", "0.9.0.post1junk", "0.9.1-old", "0.9.0RC1", "v1.0"]) {
    const x = await answer({ ...RESULT, version: bad }, "0.9.0");
    const y = await answer({ ...RESULT, version: bad });
    check(x.r.e?.kind === "protocol" && y.r.e?.kind === "protocol" && x.sock.closedWith === 1000, `a malformed version (${JSON.stringify(bad)}) is refused, with a minimum and without (${x.r.e?.kind}, ${y.r.e?.kind})`);
  }
  a = await answer({ ...RESULT, version: "0.9.0rc1" }, "0.9.0");
  check(a.r.e?.kind === "old", "a pre-release of the minimum is too old");
  // (daybreak3's VERSION-3: a page whose own minimum is malformed accepts no runner, a checkout's "dev" included)
  // (VERSION-4: every configured minimum is checked, the empty one and other types included; only null is "none")
  for (const badMin of ["0.9.0rc1", "0.9.0\n", "v1", "", false, 0, 9, {}]) {
    const z = await answerMin({ ...RESULT, version: "dev" }, badMin);
    check(z.r.e?.kind === "config" && z.sock.closedWith === 1000, `a malformed minimum (${JSON.stringify(badMin)}) pairs with nothing, not even dev (${z.r.e?.kind})`);
  }
  // (an explicit null: no minimum; undefined: the page's own, RUNNER_MIN)
  let z = await answerMin({ ...RESULT, version: "dev" }, null);
  check(z.r.v instanceof Tunnel && !("needs" in z.hello.params), "no minimum (null): dev pairs, and no needs is sent");
  z = await answerMin({ ...RESULT, version: "dev" }, undefined);
  check(z.r.v instanceof Tunnel && z.hello.params.needs === RUNNER_MIN, "the default minimum (undefined): needs is RUNNER_MIN, and dev pairs");
  // (the release's gate, with the page's own minimum: 0.8.2 refused as old, 0.9.0 and dev paired)
  for (const [version, pairs] of [["0.8.2", false], ["0.9.0rc1", false], ["0.9.0", true], ["0.9.1", true], ["dev", true]]) {
    const x = await answer({ ...RESULT, version });
    check(pairs ? x.r.v instanceof Tunnel : x.r.e?.kind === "old", `with the page's own minimum (${RUNNER_MIN}), a ${version} runner ${pairs ? "pairs" : "is refused as old"} (${x.r.e?.kind ?? "paired"})`);
  }
  a = await answer({ ...RESULT, version: "dev" });
  // (the default is the page's own: a call without `min` sends RUNNER_MIN as needs, none while it is null (grader's
  // r782 J22 note))
  check(RUNNER_MIN === null ? !("needs" in a.hello.params) : a.hello.params.needs === RUNNER_MIN, `a call without min sends RUNNER_MIN (${RUNNER_MIN}) as needs`);
  const { pairedStarter, PAIRED, PAIR_SHEET } = await import("./remote-ui.js");
  class Old extends FakeSocket {
    constructor(u) { super(u); setTimeout(() => this.open(), 1); }
    send(t) { super.send(t); if (JSON.parse(t).method === "hello") this.deliver({ jsonrpc: "2.0", id: "h1", result: { ...RESULT, version: "0.8.2" } }); }
  }
  const r = await pairedStarter({ WebSocket: Old, min: "0.9.0" })({ notebook: "nb", answer: { code: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", port: 4321 } });
  check(/is 0\.8\.2; this page needs 0\.9\.0/.test(r.failed) && r.hint === PAIRED.upgrade && /uvx sagebrush@latest/.test(r.hint) && !/pip/.test(r.hint) && !r.kernel.ready && !r.noRetry,
    `the too-old runner's words: the reason, then the uvx command; nothing bound (${r.failed} / ${r.hint})`);
  r.close();
  check(PAIR_SHEET.command === "uvx sagebrush@latest remote --loopback" && !("ownCommand" in PAIR_SHEET) && !Object.values(PAIR_SHEET).some((v) => /pip/.test(v)),
    "the sheet: one command, uvx, and no pip (William, Nov 6: uvx only)");
  // (board's V-1: a broken minimum is ours, not the person's: said so, This browser offered, no Retry)
  const rc = await pairedStarter({ WebSocket: Old, min: "" })({ notebook: "nb", answer: { code: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", port: 4321 } });
  check(rc.failed === "this page has a broken version setting (a Sagebrush problem, not your computer)" && rc.hint === PAIRED.config && rc.noRetry === true,
    `a broken minimum: the words, the hint, no Retry (${rc.failed} / ${rc.hint})`);
  rc.close();
}

// (board's #782 B-1: uvx installs no `sagebrush` command, so every string the page shows that names the command names
// the uvx one: checked over the two modules' string literals)
{
  const src = (await Bun.file(new URL("./remote-ui.js", import.meta.url)).text()) + (await Bun.file(new URL("./pair-tunnel.js", import.meta.url)).text());
  const strings = [...src.matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]).filter((t) => /remote --loopback/.test(t));
  const bare = strings.filter((t) => t.split("remote --loopback").length - 1 !== t.split("uvx sagebrush@latest remote --loopback").length - 1);
  check(strings.length >= 5 && bare.length === 0, `every message naming the command says uvx sagebrush@latest remote --loopback (${strings.length} strings; bare: ${JSON.stringify(bare)})`);
}

// ================= grader's #778 pins (r778 at 67a59056)
{
  const B = SYNTHETIC_BASE;
  const H = { Authorization: "DPoP x", DPoP: "y" };
  const notSent = (t, url, init) => { try { t.fetch(url, init); return false; } catch (e) { return e instanceof TunnelNotSent; } };
  // T5: an after= past 2^53 - 1
  let threw = null;
  try { route("GET", `${B}/bindings/b1/runs/r1/events?after=9007199254740992`); } catch (e) { threw = e; }
  check(threw instanceof TunnelNotSent && route("GET", `${B}/bindings/b1/runs/r1/events?after=9007199254740991`).ref.after === 9007199254740991, "T5: after= is at most 2^53 - 1");
  // T12, T13, T15: no DPoP header; a body on a GET; an already-aborted signal: each refused unsent, nothing on the socket
  {
    const { ws, t } = await setup();
    const ac = new AbortController();
    ac.abort();
    check(notSent(t, `${B}/bindings`, { method: "POST", headers: { Authorization: "DPoP x" }, body: "{}" })
      && notSent(t, `${B}/bindings/b1/runs/r1`, { method: "GET", headers: H, body: "{}" })
      && notSent(t, `${B}/bindings`, { method: "POST", headers: H, body: "{}", signal: ac.signal })
      && ws.sent.length === 0, "T12, T13, T15: no proof, a GET's body, an aborted signal: refused unsent, nothing sent");
  }
  // T8: a cancelled request still counts at the runner until its answer: 1 retired + 7 open = 8, the 9th refused
  {
    const { ws, t } = await setup();
    const ac = new AbortController();
    t.fetch(`${B}/bindings`, { method: "POST", headers: H, body: "{}", signal: ac.signal }).catch(() => {});
    ac.abort();
    for (let i = 0; i < 7; i++) t.fetch(`${B}/bindings`, { method: "POST", headers: H, body: "{}" }).catch(() => {});
    check(t.retired.get("t1") === true && t.pending.size === 7 && notSent(t, `${B}/bindings`, { method: "POST", headers: H, body: "{}" }), "T8: a retired request counts toward the 8");
  }
  // T19, T20, T21, T24, T26: frames that close the socket (or don't retire)
  // (each closes 4002 for its own reason, the one the runner is told)
  for (const [what, frame, why] of [
    ["T19: id t0", { id: "t0", status: 200, headers: {}, body: "{}" }, "a malformed frame"],
    ["T19: id t01", { id: "t01", status: 200, headers: {}, body: "{}" }, "a malformed frame"],
    ["T19: an id of 16 digits", { id: "t1000000000000000", status: 200, headers: {}, body: "{}" }, "a malformed frame"],
    ["T20: the next id, never sent", { id: "t2", status: 200, headers: {}, body: "{}" }, "a frame for an id never sent"],
    ["T24: a 1xx answer", { id: "t1", status: 101, headers: {}, body: "{}" }, "an answer's status"],
  ]) {
    const { ws, t } = await setup();
    t.fetch(`${B}/bindings`, { method: "POST", headers: H, body: "{}" }).catch(() => {});
    ws.deliver(frame);
    check(ws.closedWith === 4002 && ws.closedFor === why && t.closed, `${what}: closed 4002, "${why}" (${ws.closedFor})`);
  }
  {
    const { ws, t } = await setup();
    const p = t.fetch(`${B}/bindings/b1/runs/r1/events?after=0`, { method: "GET", headers: H });
    p.catch(() => {});
    ws.deliver({ id: "t1", status: 200, headers: {}, body: "x" });
    check(ws.closedWith === 4002, "T26: an event stream's head with a body closes 4002");
  }
  {
    const { ws, t } = await setup();
    const ac = new AbortController();
    t.fetch(`${B}/bindings`, { method: "POST", headers: H, body: "{}", signal: ac.signal }).catch(() => {});
    ac.abort();
    ws.deliver({ id: "t1", retired: true, extra: 1 });
    check(t.retired.has("t1") && t.stats.late === 1 && !ws.closedWith, "T21: a retired frame with another member doesn't retire (ignored, counted)");
  }
  // T29: an end closes the stream: its reader sees done
  {
    const { ws, t } = await setup();
    const p = t.fetch(`${B}/bindings/b1/runs/r1/events?after=0`, { method: "GET", headers: H });
    ws.deliver({ id: "t1", status: 200, headers: {} });
    const reader = (await p).body.getReader();
    ws.deliver({ id: "t1", chunk: "id: 1\ndata: {}\n\n" });
    ws.deliver({ id: "t1", end: true });
    const first = await reader.read();
    const second = await within(reader.read(), 1000);
    check(first.done === false && second.v?.done === true, `T29: after end, the reader sees done (${JSON.stringify(second.v ?? second)})`);
  }
  // P2, P7, P8, P9: the hello's own checks
  {
    const made = [];
    class S extends FakeSocket { constructor(u) { super(u); made.push(this); setTimeout(() => this.open(), 1); } }
    const jwk = { kty: "EC", crv: "P-256", x: "X".repeat(43), y: "Y".repeat(43) };
    const both = await within(pairTunnel({ port: 4321, code: "c", session: "s", jwk, jkt: "J".repeat(43), WebSocket: S }));
    check(both.e instanceof PairError && both.e.sent === false && made.length === 0, "P2: a code and a session together: refused, no socket made");
    const reply = async (m, raw) => {
      const p = pairTunnel({ port: 4321, code: "c", jwk, jkt: "J".repeat(43), WebSocket: S });
      await tick(10);
      made.at(-1).deliver(raw ?? m);
      return (await within(p)).e?.kind;
    };
    check(await reply({ jsonrpc: "2.0", id: "h1", result: { ...RESULT, incarnation: "0".repeat(15) } }) === "protocol"
      && await reply({ jsonrpc: "2.0", id: "h1", result: { ...RESULT, incarnation: "0".repeat(17) } }) === "protocol", "P7: an incarnation of 15 or 17 hex digits is a protocol error");
    check(await reply({ jsonrpc: "2.0", id: "h2", result: RESULT }) === "protocol", "P8: an answer for another id is a protocol error");
    const big = JSON.stringify({ jsonrpc: "2.0", id: "h1", result: { ...RESULT, pad: "x".repeat(64 * 1024) } });
    check(big.length > 64 * 1024 && await reply(null, big) === "protocol", "P9: a hello answer over 64 KiB is refused unparsed");
  }
  // L1: a link's code is base32 (A-Z, 2-7)
  check(["0", "1", "8", "9"].every((d) => parsePairLink(`?kpair=${d}BCDEFGHIJKLMNOPQRSTUVWXYZ&kport=5`) === null) && parsePairLink("?kpair=ABCDEFGHIJKLMNOPQRSTUVWXY2&kport=5") !== null,
    "L1: a code with 0, 1, 8 or 9 isn't a pairing link");
}

// ================= the runner's link
check(JSON.stringify(parsePairLink("https://sagebrush.space/?kpair=ABCDEFGHIJKLMNOPQRSTUVWXYZ&kport=5123")) === JSON.stringify({ code: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", port: 5123 }), "the link's code and port");
check(["?kpair=ABC&kport=1", "?kpair=ABCDEFGHIJKLMNOPQRSTUVWXYZ&kport=0", "?kpair=ABCDEFGHIJKLMNOPQRSTUVWXYZ&kport=70000", "nothing"].every((s) => parsePairLink(s) === null), "a bad code or port: none");

check(spied.fetch === 0 && spied.xhr === 0 && spied.beacon === 0 && spied.ws === 0, `zero network besides the paired socket (${JSON.stringify(spied)})`);
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
