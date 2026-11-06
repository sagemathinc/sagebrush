// ci: web-browser/board-unit.1 order=52 runner=bun
// pair-tunnel.js, the page's tunnel to "Your computer (paired)", against a fake socket playing the runner
// (local-kernel plan r2 §3, deltas r3 D2-D5 and r3.1): the closed table; dispatch in fetch's turn and the one
// NotSent classification; answers, nonce retries and event streams through the real RemoteClient; aborts and the
// retirement handshake, late frames ignored; every protocol failure closing the socket; the 8 open ids, 256
// retired and 1 MiB / 16 MiB stream bounds; the hello; and zero network besides the paired socket.
// The real runner end to end: test-pair-runner.mjs.
//   bun web/notebook/test-pair-tunnel.mjs
import { RemoteClient, NotSentError, AmbiguousError, StreamError } from "./remote-client.js";
import { Tunnel, pairTunnel, route, TunnelNotSent, PairError, SYNTHETIC_BASE, TUNNEL_LIMITS, parsePairLink } from "./pair-tunnel.js";

setTimeout(() => { console.log("FAIL the tests did not finish within 120 s"); process.exit(1); }, 120_000).unref?.();
let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms = 3000) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), new Promise((r) => setTimeout(() => r({ timeout: true }), ms))]);

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
  close(code) { if (this.readyState === 3) return; this.closedWith = code; this.readyState = 3; queueMicrotask(() => this.onclose?.({ code })); }
  deliver(m) { this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) }); }
  requests() { return this.sent.filter((f) => f.rpc); }
}
const RESULT = { protocol: 1, purpose: "kernel", token: "T".repeat(43), nonce: "n1", incarnation: "0123456789abcdef", limits: { frame: 4 * 1024 * 1024 } };

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
  await tick();
  let f = ws.requests()[0];
  check(f.id === "t1" && f.rpc === "g.bind" && f.auth === "DPoP " + RESULT.token && f.dpop.split(".").length === 3 && f.accept === "application/json" && JSON.parse(f.body).notebook === "n"
    && Object.keys(f).sort().join() === "accept,auth,body,dpop,id,ref,rpc", "a request frame: exactly its members, the body as text");
  ws.deliver({ id: "t1", status: 401, headers: { "www-authenticate": 'DPoP error="use_dpop_nonce"', "dpop-nonce": "n9", "content-type": "application/json" }, body: JSON.stringify({ error: "use_dpop_nonce" }) });
  await tick();
  f = ws.requests()[1];
  check(f?.id === "t2" && JSON.parse(atob(f.dpop.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).nonce === "n9", "a nonce challenge is retried once, with the new nonce");
  ws.deliver(json("t2", 200, { binding: "b1", epoch: 1 }));
  const r = await within(p);
  check(r.v?.binding === "b1" && t.pending.size === 0, "the answer resolves the request");
  const g = client.request("POST", "/bindings/b1/interrupt", { epoch: 1, op_id: "o" });
  await tick();
  ws.deliver(json("t3", 409, { error: "stale" }));
  check((await within(g)).e?.code === "stale", "a typed refusal is a GatewayError");
}

// ================= events: a stream, its end; a slow end at the runner, then the resume and the handshake
{
  const { ws, t, client } = await setup();
  const got = [];
  const it = (async () => { for await (const ev of client.events("/bindings/b1/runs/r1", 0)) got.push(ev); })();
  await tick();
  const f = ws.requests()[0];
  check(f.rpc === "g.events" && f.ref.after === 0 && f.accept === "text/event-stream" && !("body" in f), "an events request: after in its ref, no body");
  ws.deliver({ id: "t1", status: 200, headers: { "content-type": "text/event-stream", "dpop-nonce": "n2" } });
  ws.deliver({ id: "t1", chunk: 'id: 1\ndata: {"seq":1,"type":"stream","text":"a"}\n\n' });
  ws.deliver({ id: "t1", chunk: 'id: 2\ndata: {"seq":2,"type":"terminal"}\n\n' });
  ws.deliver({ id: "t1", end: true });
  await within(it);
  check(got.map((e) => e.seq).join() === "1,2" && t.pending.size === 0 && t.retired.size === 0, "chunks become the client's events; end closes the stream, nothing retired");
  const it2 = (async () => { const out = []; for await (const ev of client.events("/bindings/b1/runs/r1", 2)) out.push(ev); return out; })();
  await tick();
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
  await tick();
  ws.deliver(json("t3", 200, { outcome: { status: "done" } }));
  check((await within(u)).v?.outcome?.status === "done", "an unrelated request still works");
}

// ================= aborts: cancel once, the late answer ignored, the handshake; unsent if aborted first
{
  const { ws, t, client } = await setup();
  const ac = new AbortController();
  const p = client.request("POST", "/bindings/b1/runs", { request: "r1" }, { signal: ac.signal });
  await tick();
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
  await tick(20);
  check(ws.requests().length === 8, "8 requests open");
  const ninth = await within(client.request("POST", "/bindings/b1/complete", { epoch: 1, op_id: "o9", code: "x", cursor_pos: 1 }));
  check(ninth.e instanceof NotSentError && ws.requests().length === 8, "a 9th is NotSent, at once");
  ws.deliver(json("t1", 200, { matches: [] }));
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
  await tick();
  ws.deliver(m);
  await tick();
  check(ws.closedWith === code && t.closed && (await within(p)).e instanceof AmbiguousError, `${what}: closed ${code}, the request ambiguous`);
}
{
  const { ws, t, client } = await setup();
  const p = client.request("POST", "/bindings", { notebook: "n" });
  await tick();
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
  check(/site settings/.test(r.failed) && /Retry/.test(r.failed) && !/`/.test(r.failed), `nothing listening (or blocked): says how to undo a Block (${r.failed})`);
  await r.retry();
  check(hellos.length === 1 && hellos[0].code === "ABCDEFGHIJKLMNOPQRSTUVWXYZ" && r.tunnel && r.kernel.ready && r.failed === null, "Retry pairs with the code that never reached the runner, and binds");
  r.close();
  check(PAIRED.sessionGone === "the runner restarted, so this page needs its new link: choose Your computer again and paste it", "the session-gone words");
}

// ================= the runner's link
check(JSON.stringify(parsePairLink("https://sagebrush.space/?kpair=ABCDEFGHIJKLMNOPQRSTUVWXYZ&kport=5123")) === JSON.stringify({ code: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", port: 5123 }), "the link's code and port");
check(["?kpair=ABC&kport=1", "?kpair=ABCDEFGHIJKLMNOPQRSTUVWXYZ&kport=0", "?kpair=ABCDEFGHIJKLMNOPQRSTUVWXYZ&kport=70000", "nothing"].every((s) => parsePairLink(s) === null), "a bad code or port: none");

check(spied.fetch === 0 && spied.xhr === 0 && spied.beacon === 0 && spied.ws === 0, `zero network besides the paired socket (${JSON.stringify(spied)})`);
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
