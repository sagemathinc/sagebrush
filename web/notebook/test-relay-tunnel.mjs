// ci: web-browser/board-unit.1 order=53 runner=bun
// relay-tunnel.js, the page's kernel tunnel to an enrolled computer through the site's relay, against a fake socket
// playing the relay leg and the runner behind it:
// - the leg's URL: only a kernel page leg on this site's relay, else refused before any socket;
// - the hello: purpose "kernel", via "relay", the page's public key, and no pairing code, no session and no version
//   minimum; the answer must be a relay kernel answer (via "relay", "kernel" among the channels) or the pairing fails
//   (protocol), and a refusal is the runner's own message;
// - the relay's controls, before and after the pairing: every receipt acked at once with its own token, in the exact
//   serialization; a receipt out of order, an unknown control, or one not in its exact serialization ends the leg;
//   pings every 15 s from the open, a pong resets them, and 2 unanswered end the leg (4002); the pinger stops when the
//   leg ends;
// - pair-tunnel's own tunnel behind it, unchanged: a request and its answer through the real RemoteClient, a request
//   frame held to the relay's cap, a malformed frame still closing the socket (4002);
// - zero network besides the leg.
// The real runner end to end: engine/py/test_remote_kernel_page.py.
//   bun web/notebook/test-relay-tunnel.mjs
import { RemoteClient, NotSentError } from "./remote-client.js";
import { relayTunnel, RelayTunnel, RELAY_TUNNEL, SYNTHETIC_BASE, legUrlProblem } from "./relay-tunnel.js";
import { PairError, Tunnel } from "./pair-tunnel.js";

setTimeout(() => { console.log("FAIL the tests did not finish within 60 s"); process.exit(1); }, 60_000).unref?.();
let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms = 3000) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), new Promise((r) => setTimeout(() => r({ timeout: true }), ms))]);

// ---- zero network: every other way out is a spy
const spied = { fetch: 0, xhr: 0, ws: 0 };
globalThis.fetch = () => { spied.fetch++; return Promise.reject(new Error("no network")); };
globalThis.XMLHttpRequest = class { constructor() { spied.xhr++; } };
globalThis.WebSocket = class { constructor() { spied.ws++; throw new Error("no network"); } };

class FakeLeg {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.raw = []; // every text the page sent, as sent
    this.closedWith = null;
    FakeLeg.last = this;
  }
  open() { this.readyState = 1; this.onopen?.({}); }
  send(t) { if (this.readyState !== 1) throw new Error("not open"); this.raw.push(t); }
  close(code, reason) { if (this.readyState === 3) return; this.closedWith = code; this.closedFor = reason; this.readyState = 3; queueMicrotask(() => this.onclose?.({ code })); }
  deliver(m) { this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) }); }
  sent() { return this.raw.map((t) => JSON.parse(t)); }
  requests() { return this.sent().filter((f) => f.rpc); }
}
// (the page's pings come from these timers: the test fires them)
class Timers {
  constructor() { this.fns = new Map(); this.n = 0; }
  setInterval(f, ms) { this.n++; this.fns.set(this.n, { f, ms }); return this.n; }
  clearInterval(h) { this.fns.delete(h); }
  fire() { for (const { f } of [...this.fns.values()]) f(); }
  get live() { return this.fns.size; }
}

const ORIGIN = "https://dev.sagebrush.test"; // (the page's own origin, as location.origin gives it)
const URL_OK = "wss://dev.sagebrush.test/api/remote/v1/page?remote=r-abc&chan=kernel";
const KEY = { jwk: { kty: "EC", crv: "P-256", x: "X".repeat(43), y: "Y".repeat(43), d: "secret-never-sent" }, jkt: "J".repeat(43) };
const RESULT = { protocol: 1, purpose: "kernel", via: "relay", token: "T".repeat(43), nonce: "n1", incarnation: "0123456789abcdef", limits: { frame: 4 * 1024 * 1024 }, channels: ["kernel", "terminal"] };
const R22 = (c) => c.repeat(22);

/** Open a tunnel: the leg opens, the hello goes, `answer` comes back. */
async function open({ answer = RESULT, before = [], url = URL_OK } = {}) {
  const timers = new Timers();
  const closes = [];
  const p = within(relayTunnel({ url, origin: ORIGIN, ...KEY, WebSocket: FakeLeg, timers, onClose: (w) => closes.push(w) }));
  const ws = FakeLeg.last;
  ws.open();
  for (const m of before) ws.deliver(m);
  const hello = ws.sent().find((m) => m.method === "hello");
  ws.deliver(answer && typeof answer === "object" && !("error" in answer) && !("result" in answer) ? { jsonrpc: "2.0", id: hello?.id, result: answer } : answer);
  return { r: await p, ws, timers, closes, hello };
}

// ================= the leg's URL: this page's own relay only, checked before any socket
{
  const P = "/api/remote/v1/page?remote=r-abc&chan=kernel";
  const bad = [
    ["another host, the right path", "wss://evil.test" + P],
    ["a loopback host, the right path", "ws://127.0.0.1:12345" + P],
    ["this host on another port", "wss://dev.sagebrush.test:8443" + P],
    ["a downgrade: ws from an https page", "ws://dev.sagebrush.test" + P],
    ["not a socket URL", "https://dev.sagebrush.test" + P],
    ["credentials", "wss://u:p@dev.sagebrush.test" + P],
    ["a fragment", "wss://dev.sagebrush.test" + P + "#x"],
    ["an empty fragment", "wss://dev.sagebrush.test" + P + "#"],
    ["another path", "wss://dev.sagebrush.test/api/remote/v1/page/x?remote=r&chan=kernel"],
    ["a terminal leg", "wss://dev.sagebrush.test/api/remote/v1/page?remote=r&chan=terminal"],
    ["no remote", "wss://dev.sagebrush.test/api/remote/v1/page?chan=kernel"],
    ["no chan", "wss://dev.sagebrush.test/api/remote/v1/page?remote=r"],
    ["malformed", "wss://[bad"],
    ["no URL", null],
  ];
  const before = FakeLeg.last;
  const out = [];
  for (const [what, url] of bad) {
    const o = await within(relayTunnel({ url, origin: ORIGIN, ...KEY, WebSocket: FakeLeg, timers: new Timers() }));
    out.push([what, o.e instanceof PairError && o.e.kind === "config" && o.e.sent === false]);
  }
  check(out.every(([, ok]) => ok) && FakeLeg.last === before,
    `anything but this page's own kernel leg is refused (config, nothing sent) before a socket is made: ${out.filter(([, ok]) => !ok).map(([w]) => w).join(", ") || "all"}`);
  // (no page origin to compare against: refused too; and an http page's leg is ws on its own host)
  const noOrigin = await within(relayTunnel({ url: URL_OK, origin: undefined, ...KEY, WebSocket: FakeLeg, timers: new Timers() }));
  check(noOrigin.e instanceof PairError && noOrigin.e.kind === "config" && FakeLeg.last === before, "no page origin: refused before a socket");
  check(legUrlProblem("ws://localhost:8787" + P, "http://localhost:8787") === null && legUrlProblem("wss://localhost:8787" + P, "http://localhost:8787") !== null
    && legUrlProblem(URL_OK, "https://dev.sagebrush.test") === null && legUrlProblem(URL_OK, "file://x") !== null
    && legUrlProblem(URL_OK, "https://dev.sagebrush.test/x") !== null && legUrlProblem(URL_OK, "https://dev.sagebrush.test/") !== null,
    "an http page's leg is ws on its own host (and not wss); an https page's is wss; a non-http page, or an origin that isn't just an origin, has none");
}

// ================= the hello and its answer
{
  const { r, ws, hello, timers } = await open();
  check(r.v instanceof RelayTunnel && r.v instanceof Tunnel, "a relay kernel answer pairs: a RelayTunnel (pair-tunnel's Tunnel)");
  const p = hello?.params ?? {};
  check(hello?.jsonrpc === "2.0" && hello?.method === "hello" && JSON.stringify(Object.keys(p)) === JSON.stringify(["protocol", "purpose", "via", "jwk", "jkt"])
    && p.protocol === 1 && p.purpose === "kernel" && p.via === "relay" && p.jkt === KEY.jkt,
    `the hello: protocol 1, purpose kernel, via relay, the key; nothing else (${JSON.stringify(Object.keys(p))})`);
  check(JSON.stringify(p.jwk) === JSON.stringify({ kty: "EC", crv: "P-256", x: KEY.jwk.x, y: KEY.jwk.y }) && !ws.raw[0].includes("secret-never-sent"),
    "the hello carries the public key only (never d)");
  check(!("code" in p) && !("session" in p) && !("needs" in p) && !("remember" in p), "no pairing code, no session, no version minimum on the relay");
  check(r.v.token === RESULT.token && r.v.nonce === "n1" && r.v.incarnation === RESULT.incarnation && JSON.stringify(r.v.channels) === '["kernel","terminal"]',
    "the tunnel keeps the answer's token, nonce, incarnation and channels");
  check(r.v.frameMax === RELAY_TUNNEL.pageToPeer, `a request frame is held to the relay's cap when the runner's is higher (${r.v.frameMax})`);
  check(timers.live === 1, "the pinger runs from the leg's open");
  r.v.close();
  await tick();
  check(timers.live === 0 && ws.closedWith === 1000, "Disconnect: the leg closed (1000) and the pinger stopped");
}
{
  const small = await open({ answer: { ...RESULT, limits: { frame: 1000 } } });
  check(small.r.v?.frameMax === 1000, "a runner's lower limit is kept");
  small.r.v.close();
}
{
  const cases = [
    ["no via", (() => { const x = { ...RESULT }; delete x.via; return x; })()],
    ["via loopback", { ...RESULT, via: "loopback" }],
    ["a terminal's answer", { ...RESULT, purpose: "terminal" }],
    ["no kernel channel", { ...RESULT, channels: ["terminal"] }],
    ["no channels", (() => { const x = { ...RESULT }; delete x.channels; return x; })()],
    ["a short token", { ...RESULT, token: "T".repeat(42) }],
    ["a bad incarnation", { ...RESULT, incarnation: "XYZ" }],
    ["no frame limit", { ...RESULT, limits: {} }],
    ["protocol 2", { ...RESULT, protocol: 2 }],
  ];
  const out = [];
  for (const [what, answer] of cases) {
    const { r, ws, timers } = await open({ answer });
    await tick();
    out.push([what, r.e instanceof PairError && r.e.kind === "protocol" && ws.closedWith === 1000 && timers.live === 0]);
  }
  check(out.every(([, ok]) => ok), `an answer that isn't a relay kernel answer fails the pairing (protocol), the leg closed, no pinger: ${out.filter(([, ok]) => !ok).map(([w]) => w).join(", ") || "all"}`);
  const refused = await open({ answer: { jsonrpc: "2.0", id: "h1", error: { code: -32000, message: "a code or session hello on the relay", data: { code: "refused" } } } });
  check(refused.r.e instanceof PairError && refused.r.e.kind === "refused" && refused.r.e.message === "a code or session hello on the relay", "a refusal is the runner's own message (refused)");
  const notJson = await open({ answer: "not json" });
  check(notJson.r.e instanceof PairError && notJson.r.e.kind === "protocol", "an answer that isn't JSON: protocol");
  const big = await open({ answer: JSON.stringify({ jsonrpc: "2.0", id: "h1", result: { ...RESULT, pad: "x".repeat(RELAY_TUNNEL.answerMax) } }) });
  check(big.r.e instanceof PairError && big.r.e.kind === "protocol", "an answer over 64 KiB is refused before it is parsed");
}
{
  // (the leg closes before the answer; and never opens)
  const timers = new Timers();
  const p = within(relayTunnel({ url: URL_OK, origin: ORIGIN, ...KEY, WebSocket: FakeLeg, timers }));
  const ws = FakeLeg.last;
  ws.open();
  ws.close(1008, "x");
  const r = await p;
  check(r.e instanceof PairError && r.e.kind === "closed" && r.e.sent === true, "the leg closed after the hello: closed, the hello sent");
  const p2 = within(relayTunnel({ url: URL_OK, origin: ORIGIN, ...KEY, WebSocket: FakeLeg, timers: new Timers() }));
  const ws2 = FakeLeg.last;
  ws2.readyState = 3;
  ws2.onclose?.({ code: 1006 });
  const r2 = await p2;
  check(r2.e instanceof PairError && r2.e.kind === "unreachable" && r2.e.sent === false, "the leg never opened: unreachable, nothing sent");
  const p3 = within(relayTunnel({ url: URL_OK, origin: ORIGIN, ...KEY, WebSocket: FakeLeg, timers: new Timers(), timeoutMs: 30 }));
  FakeLeg.last.open();
  const r3 = await p3;
  check(r3.e instanceof PairError && r3.e.kind === "timeout" && FakeLeg.last.closedWith === 1000, "no answer: timeout, the leg closed");
}

// ================= the relay's controls
{
  // (before the answer: a receipt is acked, a pong is taken; then the pairing)
  const r1 = R22("a"), r2 = R22("b");
  const { r, ws } = await open({ before: [`{"relay":"receipt","r":"${r1}","upto":100}`, '{"relay":"pong"}'] });
  check(r.v instanceof RelayTunnel && ws.raw.includes(`{"relay":"ack","r":"${r1}"}`), "a receipt before the answer is acked at once, and the pairing goes on");
  // (after it: acked at once, each in the exact serialization, never passed to the tunnel)
  const n = ws.raw.length;
  ws.deliver(`{"relay":"receipt","r":"${r2}","upto":200}`);
  check(ws.raw.length === n + 1 && ws.raw[n] === `{"relay":"ack","r":"${r2}"}` && ws.closedWith === null, "a receipt after the pairing: acked at once, exactly, the leg open");
  ws.deliver(`{"relay":"receipt","r":"${R22("c")}","upto":200}`);
  await tick();
  check(ws.closedWith === 4000 && r.v.closed && r.v.closeReason === "a receipt out of order", `a receipt not above the last ends the leg (4000): ${r.v.closeReason}`);
}
{
  const bad = [
    ['{"relay":"receipt","r":"' + R22("a") + '","upto":-1}', "a negative upto"],
    ['{"relay":"receipt","r":"short","upto":1}', "a short token"],
    ['{"relay":"pong","x":1}', "a pong with more"],
    ['{"relay":"receipt","upto":1,"r":"' + R22("a") + '"}', "keys out of order"],
    ['{"relay":"close"}', "an unknown control"],
    ['{"relay":"', "a malformed control"],
  ];
  const out = [];
  for (const [text, what] of bad) {
    const { r, ws } = await open();
    ws.deliver(text);
    await tick();
    out.push([what, ws.closedWith === 4000 && r.v.closed]);
  }
  check(out.every(([, ok]) => ok), `every other control ends the leg (4000): ${out.filter(([, ok]) => !ok).map(([w]) => w).join(", ") || "all"}`);
  // (a control with its keys in order but spaced otherwise, so still a control by its prefix: only the exact
  // serialization refuses it, after the pairing (4000) and before it (the pairing fails))
  {
    const spaced = ['{"relay":"pong" }', `{"relay":"receipt","r":"${R22("s")}", "upto":7}`, `{"relay":"receipt", "r":"${R22("t")}","upto":7}`];
    const after = [];
    for (const text of spaced) {
      const { r: r3, ws: w3 } = await open();
      const n0 = w3.raw.length;
      w3.deliver(text);
      await tick();
      after.push(r3.v.closed && w3.closedWith === 4000 && r3.v.closeReason === "a malformed relay control" && w3.raw.length === n0);
    }
    check(after.every(Boolean), `a control spaced otherwise after the pairing ends the leg (4000), nothing acked (${after.join()})`);
    const before = [];
    for (const text of spaced) {
      const p4 = within(relayTunnel({ url: URL_OK, origin: ORIGIN, ...KEY, WebSocket: FakeLeg, timers: new Timers() }));
      const w4 = FakeLeg.last;
      w4.open();
      w4.deliver(text);
      const r4 = await p4;
      before.push(r4.e instanceof PairError && r4.e.kind === "protocol" && r4.e.message === "a malformed relay control" && !w4.raw.some((t) => t.includes('"ack"')));
    }
    check(before.every(Boolean), `a control spaced otherwise before the answer fails the pairing, nothing acked (${before.join()})`);
  }
  // (a control in another serialization doesn't start with {"relay":" so it is no control at all: the tunnel's frame,
  // malformed, and the leg ends all the same (4002), as on the terminal's page)
  {
    const { r: r2, ws: w } = await open();
    w.deliver('{"relay": "pong"}');
    await tick();
    check(r2.v.closed && w.closedWith === 4002, "a control in another serialization isn't taken as one: the leg ends (4002)");
  }
  const { r, ws } = await open({ answer: RESULT });
  const before = (() => { const x = within(relayTunnel({ url: URL_OK, origin: ORIGIN, ...KEY, WebSocket: FakeLeg, timers: new Timers() })); return x; })();
  const w2 = FakeLeg.last;
  w2.open();
  w2.deliver('{"relay":"close"}');
  const b = await before;
  check(b.e instanceof PairError && b.e.kind === "protocol" && b.e.message === "an unknown relay control", "an unknown control before the answer fails the pairing");
  r.v.close();
  void ws;
}
{
  // (pings: every pingMs; a pong resets them; 2 unanswered end the leg)
  const { r, ws, timers, closes } = await open();
  const pings = () => ws.raw.filter((t) => t === '{"relay":"ping"}').length;
  timers.fire();
  ws.deliver('{"relay":"pong"}');
  timers.fire();
  ws.deliver('{"relay":"pong"}');
  timers.fire();
  check(pings() === 3 && !r.v.closed, "pings, each answered: the leg stays");
  timers.fire();
  check(pings() === 4 && !r.v.closed, "one unanswered: still there");
  timers.fire();
  await tick();
  check(pings() === 4 && r.v.closed && ws.closedWith === 4002 && r.v.closeReason === "no pong" && timers.live === 0 && closes[0] === "no pong",
    `2 unanswered: the leg ends (4002, no pong), the pinger stopped, onClose told (${ws.closedWith} ${r.v.closeReason})`);
  check(RELAY_TUNNEL.pingMs === 15_000 && RELAY_TUNNEL.missedPongs === 2, "15 s between pings, 2 missed: the relay's and the terminal page's figures");
}

// ================= pair-tunnel's tunnel behind it
{
  const { r, ws } = await open();
  const t = r.v;
  const client = await RemoteClient.create({ base: SYNTHETIC_BASE, token: () => t.tokenSource(), fetch: t.fetch });
  client.nonce = t.nonce;
  const p = within(client.request("POST", "/bindings", { notebook: "nb", client_id: "c1" }));
  const end = Date.now() + 3000;
  while (ws.requests().length < 1 && Date.now() < end) await tick(1);
  const req = ws.requests()[0];
  check(req?.rpc === "g.bind" && req.id === "t1" && typeof req.dpop === "string" && req.auth === `DPoP ${RESULT.token}`, "a request goes as pair-tunnel's frame (rpc, id, DPoP)");
  // (a control between the request and its answer is taken off; the answer is the tunnel's)
  ws.deliver(`{"relay":"receipt","r":"${R22("z")}","upto":5}`);
  ws.deliver({ id: "t1", status: 200, headers: { "content-type": "application/json", "dpop-nonce": "n2" }, body: JSON.stringify({ binding: "b1", epoch: 1 }) });
  const a = await p;
  check(a.v?.binding === "b1" && !t.closed, `its answer reaches the client, the control in between taken off (${JSON.stringify(a.v ?? a.e?.message)})`);
  // (a request over the relay's cap is refused unsent)
  const big = within(client.request("POST", "/bindings/b1/runs", { code: "x".repeat(RELAY_TUNNEL.pageToPeer), epoch: 1 }));
  const bigR = await big;
  check(bigR.e instanceof NotSentError && ws.requests().length === 1, `a request over the relay's cap: NotSent, nothing sent (${bigR.e?.name})`);
  // (a frame that is neither a control nor a tunnel frame: pair-tunnel closes the socket, 4002)
  ws.deliver({ nonsense: true });
  await tick();
  check(t.closed && ws.closedWith === 4002, "a malformed frame still closes the leg (4002)");
}
{
  // (a tunnel frame that starts like a control is never one: `{"relay":` only when it starts the text)
  const { r, ws } = await open();
  ws.deliver('{"id":"t9","relay":"pong"}');
  await tick();
  check(r.v.closed && ws.closedWith === 4002, "a frame with a relay key not at its start is the tunnel's, and malformed (4002)");
}

// ================= relayedStarter (remote-ui.js): a notebook's kernel on one of your computers, through this leg
{
  const { relayedStarter, relayedStatusText, RELAYED } = await import("./remote-ui.js");
  const json = (id, status, body) => ({ id, status, headers: { "content-type": "application/json", "dpop-nonce": "n2" }, body: JSON.stringify(body) });
  const legUrl = (rid) => `wss://dev.sagebrush.test/api/remote/v1/page?${new URLSearchParams({ remote: rid, chan: "kernel" })}`;
  // (a leg that opens, answers the hello as the runner does on the relay, binds, and may refuse the first hello)
  const legs = [];
  let refuseNext = false;
  class S extends FakeLeg {
    constructor(u) { super(u); legs.push(this); setTimeout(() => this.open(), 1); }
    send(t) {
      super.send(t);
      const m = JSON.parse(t);
      if (m.method === "hello") {
        if (refuseNext) { refuseNext = false; this.deliver({ jsonrpc: "2.0", id: "h1", error: { code: -32000, message: "this computer isn't serving notebooks" } }); }
        else this.deliver({ jsonrpc: "2.0", id: "h1", result: RESULT });
      } else if (m.rpc === "g.bind") queueMicrotask(() => this.deliver(json(m.id, 200, { binding: "b1", epoch: 1, incarnation: 1, state: "ready" })));
    }
  }
  const statuses = [], lost = [];
  const start = relayedStarter({ legUrl, WebSocket: S, origin: ORIGIN });
  const r = await start({ notebook: "nb", answer: { remoteId: "r-abc", name: "lite" }, onStatus: (t) => statuses.push(t), onLost: (w) => lost.push(w) });
  const hello = legs[0].sent().find((m) => m.method === "hello");
  check(r.kernel.ready && r.failed === null && legs.length === 1 && legs[0].url === URL_OK, `the chosen computer's kernel leg, paired and bound (${r.failed}, ${legs[0]?.url})`);
  check(hello?.params.via === "relay" && hello.params.purpose === "kernel" && !("code" in hello.params) && !("session" in hello.params) && !("d" in hello.params.jwk), "the hello: relay, kernel, the page's public key; no code, no session, no private key");
  check(statuses.includes("On lite · ready"), `the status line names the computer (${JSON.stringify(statuses.slice(-2))})`);
  check(r.kernel.relayed === "lite", "the kernel knows which computer it is on");
  check(r.kernel.requireGate === true, "every run needs the page's gate, as the paired kernel's does");
  // (the leg ends, as when another notebook or tab chooses this computer: the runner keeps one kernel page)
  legs[0].close(1000);
  await tick(10);
  check(lost.length === 1 && lost[0].endsWith(`; ${RELAYED.maybeReplaced}`) && r.tunnel === null, `a lost leg is said, with its likely cause and not as a fact (${lost[0]})`);
  // (Retry, without an answer: the same computer again)
  const again = await r.retry();
  check(again && legs.length === 2 && legs[1].url === URL_OK && r.kernel.ready, "Retry opens the same computer's leg again and binds");
  r.close();
  check(legs[1].readyState === 3, "close() ends the leg");
  // (Reconnect: a new start with no answer, a fresh kernel on the computer chosen last)
  const rc = await start({ notebook: "nb" });
  check(rc.kernel.ready && legs.length === 3 && legs[2].url === URL_OK, `Reconnect opens the last computer's leg (${legs[2]?.url})`);
  rc.close();
  // (the runner's refusal: its own words, and Retry may try again)
  refuseNext = true;
  const r2 = await start({ notebook: "nb2", answer: { remoteId: "r-xyz", name: "big box" } });
  check(r2.failed === "this computer isn't serving notebooks" && !r2.kernel.ready && !r2.noRetry, `a refusal: the runner's own message, Retry offered (${r2.failed})`);
  check(await r2.retry() && r2.kernel.ready && legs.at(-1).url.includes("remote=r-xyz"), "Retry after a refusal binds on that computer");
  r2.close();
  // (a leg that isn't this site's: refused before any socket, and not retried)
  const before = legs.length;
  const r3 = await relayedStarter({ legUrl: () => "wss://evil.test/api/remote/v1/page?remote=r-abc&chan=kernel", WebSocket: S, origin: ORIGIN })({ notebook: "nb3", answer: { remoteId: "r-abc", name: "lite" } });
  check(/not a kernel page leg on this site's relay/.test(r3.failed) && r3.noRetry && legs.length === before, `another site's leg: refused unopened, no Retry (${r3.failed})`);
  r3.close();
  // (the words: the picker's option and status, and the help's three limits, said plainly)
  check(RELAYED.option("lite") === "On lite" && relayedStatusText("lite", "ready (remote) · python3") === "On lite · ready · python3" && relayedStatusText("lite", "starting") === "On lite: starting", "the option and status words");
  check(/in the folder sagebrush remote started in/.test(RELAYED.help) && /one notebook at a time/.test(RELAYED.help) && /board's hidden notebook still runs in this browser/.test(RELAYED.help), "the help says the three limits: the folder and files, one notebook at a time, the board's notebook");
}

check(spied.fetch === 0 && spied.xhr === 0 && spied.ws === 0, `zero network besides the leg (fetch ${spied.fetch}, xhr ${spied.xhr}, other sockets ${spied.ws})`);
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
