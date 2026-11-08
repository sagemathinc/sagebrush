// ci: web-browser/board-unit.1 order=140 runner=bun
// remote-terminal.js, the page's side of a terminal on a paired runner (terminal addendum §T3-§T5; step T-3), against a
// fake relay leg playing the runner: the hello and the open's proof (remote, generation and body bound; a reattach is a
// fresh hello and proof); replay, out and live in order, acked only once the view has drawn them, counting from 0 at
// each open; input in frames of at most 16,384 bytes with at most 64 KiB un-inacked, the rest held in the page;
// exit as the last message; "elsewhere"; every protocol failure ending the page; and zero other network.
//   bun web/notebook/test-remote-terminal.mjs
import { RemoteTerminal, TERMINAL, openHtu, toB64, fromB64, terminalKey } from "./remote-terminal.js";

setTimeout(() => { console.log("FAIL the tests did not finish within 60 s"); process.exit(1); }, 60_000).unref?.();
let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const spied = { fetch: 0, xhr: 0 };
globalThis.fetch = () => { spied.fetch++; return Promise.reject(new Error("no network")); };
globalThis.XMLHttpRequest = class { constructor() { spied.xhr++; } };

class FakeLeg {
  static last = null;
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.handlers = { open: [], message: [], close: [], error: [] };
    this.closed = null;
    FakeLeg.last = this;
    setTimeout(() => this.fire("open", {}), 0);
  }
  addEventListener(k, f) { this.handlers[k].push(f); }
  fire(k, e) { for (const f of this.handlers[k]) f(e); }
  send(t) { this.sent.push(JSON.parse(t)); }
  close(code, why) { this.closed = { code, why }; }
  runner(obj) { this.fire("message", { data: JSON.stringify(obj) }); }
  of(t) { return this.sent.filter((m) => m.t === t); }
}

const key = { jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, jkt: "J".repeat(43), proofs: [],
  async proof(htm, htu, token, nonce) { this.proofs.push({ htm, htu, token, nonce }); return "proof-" + this.proofs.length; } };

class View {
  constructor(defer = false) { this.defer = defer; this.drawn = []; this.pending = []; this.resets = 0; }
  write(bytes, done) { this.drawn.push(bytes); if (this.defer) this.pending.push(done); else done(); }
  flush(n = Infinity) { while (n-- > 0 && this.pending.length) this.pending.shift()(); }
  reset() { this.resets++; }
  text() { return new TextDecoder().decode(new Uint8Array(this.drawn.flatMap((b) => [...b]))); }
}

async function attached({ session, view = new View(), events = [] } = {}) {
  const t = new RemoteTerminal({ url: "wss://example.invalid/api/remote/v1/page?remote=R1&chan=terminal", remoteId: "R1", key,
    view, rows: 24, cols: 80, session, on: (e) => events.push(e), WebSocket: FakeLeg }).start();
  await tick();
  const leg = FakeLeg.last;
  leg.runner({ jsonrpc: "2.0", id: "t1", result: { protocol: 1, purpose: "terminal", token: "TOK", nonce: "N1", gen: 7 } });
  await tick(20);
  return { t, leg, view, events };
}

// ================= the hello and the open's proof
{
  key.proofs.length = 0;
  const { t, leg, events } = await attached();
  const hello = leg.sent[0];
  check(hello.method === "hello" && hello.params.purpose === "terminal" && hello.params.jkt === key.jkt && hello.params.protocol === 1,
    "hello: protocol 1, purpose terminal, the page's key");
  const open = leg.of("open")[0];
  const body = '{"rows":24,"cols":80}';
  const want = await openHtu("R1", 7, body);
  check(open && open.body === body && open.auth === "DPoP TOK" && open.dpop === "proof-1", "open: the body, the token, the proof");
  check(key.proofs[0].htm === "POST" && key.proofs[0].htu === want && key.proofs[0].nonce === "N1" && key.proofs[0].token === "TOK",
    "the proof binds this remote, generation 7, the body's digest, the hello's nonce and token");
  leg.runner({ t: "opened", session: "S".repeat(22), nonce: "N2" });
  await tick();
  check(t.state === "attached" && t.session === "S".repeat(22) && events.some((e) => e.t === "opened"), "opened: attached, with the session id");
}

// ================= a reattach: a fresh hello and a fresh proof, the session in the body
{
  key.proofs.length = 0;
  const { leg } = await attached({ session: "Q".repeat(22) });
  const open = leg.of("open")[0];
  check(open.body === JSON.stringify({ session: "Q".repeat(22), rows: 24, cols: 80 }) && key.proofs.length === 1 && key.proofs[0].htu === await openHtu("R1", 7, open.body),
    "reattach: the session in the body, bound by its own proof");
}

// ================= output: replay, out, live; acks only once drawn, cumulative from 0
{
  const view = new View(true);
  const { leg } = await attached({ view });
  leg.runner({ t: "opened", session: "S".repeat(22), nonce: "N2" });
  leg.runner({ t: "replay" });
  leg.runner({ t: "out", b: toB64(new TextEncoder().encode("\x1bcold ")) });
  leg.runner({ t: "out", b: toB64(new TextEncoder().encode("lines")) });
  leg.runner({ t: "live" });
  leg.runner({ t: "out", b: toB64(new Uint8Array([0, 255, 128, 10])) });
  await tick();
  check(view.resets === 1 && view.drawn.length === 3, "replay resets the view; three frames handed to it in order");
  check(leg.of("ack").length === 0, "no ack before the view has drawn anything");
  view.flush(1);
  check(JSON.stringify(leg.of("ack")) === JSON.stringify([{ t: "ack", upto: 6 }]), "the first frame drawn: ack upto 6 (the reset included)");
  view.flush();
  check(leg.of("ack").at(-1).upto === 6 + 5 + 4 && leg.of("ack").length === 3, "all drawn: cumulative acks, 15 in all");
  check([...view.drawn[2]].join(",") === "0,255,128,10", "bytes, not text: NUL and high bytes unchanged");
}

// ================= input credit: frames of at most 16 KiB, at most 64 KiB un-inacked, the rest held here
{
  const { t, leg } = await attached();
  leg.runner({ t: "opened", session: "S".repeat(22), nonce: "N2" });
  await tick();
  const paste = new Uint8Array(100_000).map((_, i) => i % 251);
  t.input(paste);
  const frames = leg.of("in").map((m) => fromB64(m.b));
  const sent = frames.reduce((n, b) => n + b.length, 0);
  check(frames.every((b) => b.length <= TERMINAL.inFrame) && sent === TERMINAL.inPending, `at most 64 KiB sent before an inack (${sent})`);
  // (the literals, the runner's IN_MAX and IN_PENDING: a frame of 16,385 bytes closes the page there)
  check(frames.every((b) => b.length <= 16_384) && frames[0].length === 16_384 && sent === 65_536, `frames of at most 16384 bytes, the first exactly 16384 (${frames[0].length})`);
  check(t.pendingInput() === 100_000 - TERMINAL.inPending, "the rest waits in the page");
  leg.runner({ t: "inack", upto: 16_384 });
  await tick();
  const sent2 = leg.of("in").map((m) => fromB64(m.b)).reduce((n, b) => n + b.length, 0);
  check(sent2 === TERMINAL.inPending + 16_384, "an inack of 16 KiB lets 16 KiB more go");
  leg.runner({ t: "inack", upto: sent2 });
  await tick();
  const all = new Uint8Array(leg.of("in").flatMap((m) => [...fromB64(m.b)]));
  check(all.length === 100_000 && all.every((v, i) => v === paste[i]), "the whole paste, in order, exactly");
  t.input("\x03");
  check(fromB64(leg.of("in").at(-1).b)[0] === 3, "Ctrl-C goes as its byte");
}
// (an inack going back ends the page)
{
  const { t, leg, events } = await attached();
  leg.runner({ t: "opened", session: "S".repeat(22), nonce: "N2" });
  await tick();
  t.input(new Uint8Array(100));
  leg.runner({ t: "inack", upto: 100 });
  leg.runner({ t: "inack", upto: 50 });
  await tick();
  check(leg.closed !== null && events.some((e) => e.t === "error" && e.reason === "a bad inack"), "an inack going back ends the page");
}

// ================= exit is last; anything after it ends the page
{
  const { t, leg, events } = await attached();
  leg.t = t;
  leg.runner({ t: "opened", session: "S".repeat(22), nonce: "N2" });
  leg.runner({ t: "exit", code: 3, signal: null });
  await tick();
  check(events.some((e) => e.t === "exit" && e.code === 3), "exit reported with its code");
  FakeLeg.last.sent.length = 0;
  leg.t.input("x");
  check(leg.of("in").length === 0, "no input is sent after the exit");
  leg.runner({ t: "out", b: toB64(new Uint8Array([1])) });
  await tick();
  check(leg.closed !== null && events.some((e) => e.t === "error" && e.reason === "a message after the exit"), "an out frame after the exit ends the page");
}

// ================= protocol failures end the page
for (const [what, msg] of [
  ["an unknown type", { t: "wat" }],
  ["non-canonical base64", { t: "out", b: "eA" }],
  ["an out frame with another key", { t: "out", b: "eA==", x: 1 }],
  ["an inack past what was sent", { t: "inack", upto: 5 }],
  ["an opened when already attached", { t: "opened", session: "T".repeat(22), nonce: "N3" }],
]) {
  const { leg, events } = await attached();
  leg.runner({ t: "opened", session: "S".repeat(22), nonce: "N2" });
  leg.runner(msg);
  await tick();
  check(leg.closed !== null && events.some((e) => e.t === "error" && e.error === "protocol"), `${what} ends the page`);
}

// ================= a refused hello, and "elsewhere"
{
  const events = [];
  const t = new RemoteTerminal({ url: "wss://x.invalid/p", remoteId: "R1", key, view: new View(), rows: 24, cols: 80,
    on: (e) => events.push(e), WebSocket: FakeLeg }).start();
  await tick();
  FakeLeg.last.runner({ jsonrpc: "2.0", id: "t1", error: { code: -32000, message: "this page is paired for a kernel, not a terminal" } });
  await tick();
  check(t.state === "ended" && events.some((e) => e.t === "error" && e.error === "hello"), "a refused hello ends the page, nothing opened");
  check(FakeLeg.last.of("open").length === 0, "no open after a refused hello");
}
{
  const view = new View(true);
  const { t, leg, events } = await attached({ view });
  leg.runner({ t: "opened", session: "S".repeat(22), nonce: "N2" });
  leg.runner({ t: "out", b: toB64(new Uint8Array([65])) });
  leg.runner({ t: "error", error: "elsewhere" });
  await tick();
  view.flush();
  t.input("x");
  check(events.some((e) => e.t === "elsewhere") && leg.of("ack").length === 0 && leg.of("in").length === 0,
    "elsewhere: no more acks or input from this page");
}

// (a hello answered for another purpose: refused, nothing opened)
{
  const events = [];
  const t = new RemoteTerminal({ url: "wss://x.invalid/p", remoteId: "R1", key, view: new View(), rows: 24, cols: 80,
    on: (e) => events.push(e), WebSocket: FakeLeg }).start();
  await tick();
  FakeLeg.last.runner({ jsonrpc: "2.0", id: "t1", result: { protocol: 1, purpose: "kernel", token: "TOK", nonce: "N1", gen: 7 } });
  await tick(20);
  check(t.state === "ended" && events.some((e) => e.t === "error" && e.error === "hello") && FakeLeg.last.of("open").length === 0, "a hello answered for a kernel ends the page, nothing opened");
}
// (anything from the runner before the open was sent, while its proof is still being made: an opened, an out frame)
for (const msg of [{ t: "opened", session: "S".repeat(22), nonce: "N2" }, { t: "out", b: toB64(new Uint8Array([65])) }]) {
  const events = [];
  const view = new View();
  const slowKey = { ...key, proof: () => new Promise((r) => setTimeout(() => r("late-proof"), 50)) };
  const t = new RemoteTerminal({ url: "wss://x.invalid/p", remoteId: "R1", key: slowKey, view, rows: 24, cols: 80,
    on: (e) => events.push(e), WebSocket: FakeLeg }).start();
  await tick();
  const leg = FakeLeg.last;
  leg.runner({ jsonrpc: "2.0", id: "t1", result: { protocol: 1, purpose: "terminal", token: "TOK", nonce: "N1", gen: 7 } });
  await tick();
  leg.runner(msg);
  await tick(80);
  check(t.state === "ended" && events.some((e) => e.t === "error" && e.error === "protocol") && leg.of("open").length === 0 && view.drawn.length === 0,
    `${msg.t === "out" ? "an out frame" : "an opened"} before the open (its proof still being made) ends the page, nothing drawn`);
}
// (a page handler that throws doesn't break the protocol)
{
  const view = new View();
  const t = new RemoteTerminal({ url: "wss://x.invalid/p", remoteId: "R1", key, view, rows: 24, cols: 80,
    on: () => { throw new Error("the page's own bug"); }, WebSocket: FakeLeg }).start();
  await tick();
  const leg = FakeLeg.last;
  leg.runner({ jsonrpc: "2.0", id: "t1", result: { protocol: 1, purpose: "terminal", token: "TOK", nonce: "N1", gen: 7 } });
  await tick(20);
  leg.runner({ t: "opened", session: "S".repeat(22), nonce: "N2" });
  leg.runner({ t: "replay" });
  leg.runner({ t: "out", b: toB64(new Uint8Array([65, 66])) });
  leg.runner({ t: "live" });
  await tick();
  check(t.state === "attached" && leg.of("ack").at(-1)?.upto === 2 && leg.closed === null, "a handler that throws: the out, ack and live sequence goes on");
}
// (the page's key: non-extractable, as generated; its private half can't be exported)
{
  const calls = [];
  const real = globalThis.crypto.subtle;
  const spy = new Proxy(real, { get: (o, k) => (k === "generateKey" ? (...a) => { calls.push(a); return real.generateKey(...a); } : typeof o[k] === "function" ? o[k].bind(o) : o[k]) });
  const k = await terminalKey(spy);
  // (the same call again, here: what it makes is what terminalKey holds)
  const again = await real.generateKey(...calls[0]);
  let exported = true;
  try { await real.exportKey("jwk", again.privateKey); } catch { exported = false; }
  check(calls.length === 1 && calls[0][1] === false && calls[0][0].namedCurve === "P-256", "terminalKey: a P-256 pair generated with extractable false");
  check(!exported, "a pair made that way: its private key can't be exported");
  check(k.jwk && !("d" in k.jwk) && Object.keys(k.jwk).sort().join(",") === "crv,kty,x,y", "the JWK sent is the public key only");
}

check(spied.fetch === 0 && spied.xhr === 0, "zero network besides the relay leg");
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
