// ci: web-runner order=166 runner=bun
// The page's agent leg to one of your computers (agent-relay.ts), its pairing (agent-pair.ts over a link) and its
// permission cards (agent-cards.ts), against a fake leg playing the relay and the runner (W2 B plan r3, r3a, r3b, r3c,
// the Bounds 6 ruling): the hello's proof and every message's (verified here with the page's public key: htu over the
// exact payload, ath, nonce, jti once), the relay's controls, the exact envelope length (F sent, F + 1 refused), the
// queue's and the reply reserve's caps exactly and +1, the browser buffer, Disconnect's ordered drain, the page-wide
// signing and digest bounds across repeated Chat here, the one-shot card, and cleanup.
//   bun web/workspace/test-agent-relay.mjs
import { AgentLeg, LEG, legKey, signGate, digestGate, DIGEST_CHARGE, jsonStringBytes, b64url } from "./agent-relay.ts";
import { AgentPairing } from "./agent-pair.ts";
import { PermissionCards } from "./agent-cards.ts";
import { permissionDigest } from "./agent-canon.ts";

let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timed out: " + what); await tick(2); } };
const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;
const sha = async (t) => b64url(new Uint8Array(await subtle.digest("SHA-256", enc.encode(t))));
LEG.unpairMs = 300; // (the drain's bound, shortened for the rows; its own row checks it holds)
LEG.bufferPollMs = 5;

const RID = "rid-test-0001", INC = "0123456789abcdef", F = 64 * 1024;

// ---- a fake leg: the relay's page socket with the runner behind it
class FakeWS {
  static last = null;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.bufferedAmount = 0; this.l = {}; FakeWS.last = this; queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); }); }
  addEventListener(t, f) { (this.l[t] ??= []).push(f); }
  emit(t, e) { for (const f of this.l[t] ?? []) f(e); }
  send(s) { if (this.readyState !== 1) throw new Error("send on a closed socket"); this.sent.push(s); this.onsend?.(s); }
  close(code) { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.emit("close", { code: code ?? 1000, reason: "" })); }
  recv(o) { this.emit("message", { data: typeof o === "string" ? o : JSON.stringify(o) }); }
  peerClose(code = 1000, reason = "") { this.readyState = 3; this.emit("close", { code, reason }); }
}

/** The runner's check of one proof (dpop.py's, in brief): signature by the hello's key, htm, htu, ath, nonce, jti. */
async function verify(env, { jwk, token, nonce, htu, jtis, now = Date.now() }) {
  const [h, c, s] = env.p.split(".");
  const header = JSON.parse(atob(h.replace(/-/g, "+").replace(/_/g, "/")));
  const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(c.replace(/-/g, "+").replace(/_/g, "/")), (x) => x.charCodeAt(0))));
  const key = await subtle.importKey("jwk", { ...header.jwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (x) => x.charCodeAt(0));
  const good = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, enc.encode(h + "." + c));
  const why = !good ? "signature" : header.jwk.x !== jwk.x ? "key" : claims.htm !== "AGENT" ? "htm" : claims.htu !== htu ? "htu" : claims.ath !== (await sha(token)) ? "ath"
    : (nonce === null ? "nonce" in claims : claims.nonce !== nonce) ? "nonce" : jtis.has(claims.jti) ? "jti-reused" : claims.jti.length !== 22 ? "jti-length"
    : Math.abs(claims.iat - Math.floor(now / 1000)) > 5 ? "iat" : env.a !== "DPoP " + token ? "token" : null;
  if (!why) jtis.add(claims.jti);
  return { why, claims, header };
}

/** A leg against the fake runner: answers the hello, verifies every later message, records what it forwarded. */
async function openLeg({ hold = false, frame = F, refuse = null } = {}) {
  const key = await legKey();
  const real = key.sign;
  const held = [];
  const signer = { hold, held, fail: false };
  key.sign = (input) => signer.fail ? Promise.reject(new Error("signing failed")) : signer.hold ? new Promise((res, rej) => held.push({ res: () => real(input).then(res, rej), rej })) : real(input);
  const leg = new AgentLeg({ remoteId: RID, url: "wss://x/api/remote/v1/page?remote=" + RID + "&chan=agent", key, WebSocket: FakeWS, recordLengths: true });
  leg.start();
  const ws = FakeWS.last;
  const runner = { jtis: new Set(), hello: null, forwarded: [], refused: [], token: "tok_" + "A".repeat(40), nonce: "n0nce-XYZ", gen: 7 };
  ws.onsend = async (s) => {
    if (s.startsWith('{"relay":')) return;
    const env = JSON.parse(s);
    if (!runner.hello) {
      runner.hello = env;
      const m = JSON.parse(env.m);
      runner.helloCheck = await verify(env, { jwk: m.params.jwk, token: "", nonce: null, htu: `sb-agent-hello:${RID}#${await sha(env.m)}`, jtis: runner.jtis });
      runner.helloParams = m.params;
      runner.jwk = m.params.jwk;
      if (refuse) return ws.recv({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: refuse, data: { code: "refused", message: refuse } } });
      return ws.recv({ jsonrpc: "2.0", id: m.id, result: { protocol: 1, purpose: "agent", via: "relay", token: runner.token, nonce: runner.nonce, maxFrameBytes: frame - 2048, limits: { frame }, gen: runner.gen, incarnation: INC, remote_id: RID, channels: ["agent"], resumed: false } });
    }
    const v = await verify(env, { jwk: runner.jwk, token: runner.token, nonce: runner.nonce, htu: `sb-agent:${RID}/${INC}/${runner.gen}#${await sha(env.m)}`, jtis: runner.jtis });
    (v.why ? runner.refused : runner.forwarded).push(v.why ? { why: v.why, m: env.m } : env.m);
  };
  const opened = await new Promise((res) => { leg.on("open", () => res(true)); leg.on("end", () => res(false)); });
  return { leg, ws, runner, signer, opened };
}
const release = async (signer) => { signer.hold = false; while (signer.held.length) { signer.held.shift().res(); await tick(1); } };
const note = (n, text = "x") => JSON.stringify({ jsonrpc: "2.0", method: "chat.message", params: { conversation: "c1", id: "m" + n, author: "person", text } });

// ---- the hello and its proof
{
  const { leg, ws, runner, opened } = await openLeg();
  ok(opened && leg.state === "open", "the leg opens on the runner's hello result");
  ok(runner.helloCheck.why === null, `the hello's proof: htu sb-agent-hello:<remote>#<sha of the hello>, method AGENT, ath of "", no nonce, a 22-character jti, now (${runner.helloCheck.why})`);
  ok(runner.hello.a === "DPoP " && runner.helloParams.purpose === "agent" && runner.helloParams.fresh === true && runner.helloParams.protocol === 1 && !("resume" in runner.helloParams) && !("remember" in runner.helloParams), "the hello asks fresh, purpose agent, protocol 1, and remembers nothing");
  ok(leg.result.frame === F && leg.result.gen === 7, "its result: the frame F and the generation");
  // (each later message: signed over its exact bytes, in order)
  for (let i = 0; i < 5; i++) leg.send(note(i, "é\"\\\n" + i));
  await until(() => runner.forwarded.length === 5, "five forwarded");
  ok(runner.refused.length === 0 && runner.forwarded.every((m, i) => m === note(i, "é\"\\\n" + i)), "every message verified by the runner over its exact bytes (htu, ath, nonce, jti once), in order");
  ok(leg.lengths.every((x) => x.computed === x.actual), `the exact envelope length, computed before signing, equals the written one for every envelope (${leg.lengths.length})`);
  // (a byte changed after signing, and a jti used twice: both refused by the runner's check)
  const env = JSON.parse(ws.sent.filter((s) => !s.startsWith('{"relay"')).at(-1));
  const tampered = await verify({ ...env, m: env.m.replace("é", "e") }, { jwk: runner.jwk, token: runner.token, nonce: runner.nonce, htu: `sb-agent:${RID}/${INC}/7#${await sha(env.m.replace("é", "e"))}`, jtis: new Set() });
  ok(tampered.why === "htu", "a message changed by one byte after signing is refused (its htu binds the signed bytes)");
  const again = await verify(env, { jwk: runner.jwk, token: runner.token, nonce: runner.nonce, htu: `sb-agent:${RID}/${INC}/7#${await sha(env.m)}`, jtis: runner.jtis });
  ok(again.why === "jti-reused", "the same envelope again: its jti is refused");
  // (the relay's controls)
  ws.recv({ relay: "receipt", r: "A".repeat(22), upto: 10 });
  ok(ws.sent.at(-1) === JSON.stringify({ relay: "ack", r: "A".repeat(22) }), "a receipt is acked at once");
  ws.recv({ relay: "receipt", r: "B".repeat(22), upto: 5 });
  await tick(5);
  ok(leg.state === "closed" && leg.ended.kind === "lost", "a receipt out of order ends the leg (lost)");
}

// ---- no answer to the pings: the leg is dead
{
  let interval = null;
  const key = await legKey();
  const leg = new AgentLeg({ remoteId: RID, url: "wss://x", key, WebSocket: FakeWS, clock: { setInterval: (f) => (interval = f, 1), clearInterval: () => { interval = null; } } });
  leg.start();
  await tick(5);
  interval(); interval();
  ok(leg.state !== "closed", "two pings unanswered: not yet");
  interval();
  ok(leg.state === "closed" && leg.ended.kind === "lost" && interval === null, "the third ping finds two unanswered: the leg is dead (lost), its timer gone");
}

// ---- a refused hello: the runner's own words (a second tab, fresh: true; a runner without --serve-agents)
{
  const words = "The agent is already open in another page or tab. Close it there, then reload this page.";
  const { leg, opened } = await openLeg({ refuse: words });
  await until(() => leg.state === "closed", "refused");
  ok(!opened && leg.ended.kind === "refused" && leg.ended.why === words, "a second tab's refusal (fresh: true too) is said in the runner's words");
  ok(Object.values(leg.counters()).every((v) => v === 0), `after a failed hello: no timers, listeners or queue (${JSON.stringify(leg.counters())})`);
}

// ---- the exact envelope length: F sent, F + 1 refused
{
  const { leg, runner } = await openLeg();
  const base = (s) => note(0, "é\"\\" + s);
  let n = 0;
  while (leg.envelopeBytes(base("x".repeat(n + 1))) <= F) n++;
  const exact = base("x".repeat(n)), over = base("x".repeat(n + 1));
  ok(leg.envelopeBytes(exact) === F && leg.envelopeBytes(over) === F + 1, "a message whose envelope is exactly F, and one at F + 1 (escapes and non-ASCII in it)");
  ok(leg.send(over) === "over" && leg.send(exact) === "ok", "F + 1 is refused (\"over\"), the leg kept; F is admitted");
  await until(() => runner.forwarded.length === 1, "the F message forwarded");
  ok(leg.lengths.at(-1).actual === F && leg.state === "open", "…and written at exactly F bytes; the leg stays open");
  ok(jsonStringBytes("a\ud800 😀\u0001") === new TextEncoder().encode(JSON.stringify("a\ud800 😀\u0001")).length, "jsonStringBytes counts as JSON.stringify writes (a lone surrogate escaped)");
}

// ---- the queue under a held signer: entries and bytes, exactly and +1; the PEAK, not the end
{
  const { leg, runner, signer } = await openLeg();
  signer.hold = true;
  let i = 0;
  while (leg.send(note(i, "s")) === "ok") i++;
  ok(i === LEG.queueEntries && leg.peaks.entries === LEG.queueEntries, `small messages: ${LEG.queueEntries} admitted, the next one refused ("full") (${i})`);
  await release(signer);
  await until(() => runner.forwarded.length === i, "all written");
  // (max-width messages: 2F bytes at most)
  signer.hold = true;
  let big = "x".repeat(F - 600);
  while (leg.envelopeBytes(note(0, big)) > F) big = big.slice(1);
  const w = leg.envelopeBytes(note(0, big));
  let j = 0;
  while (leg.send(note(j, big)) === "ok") j++;
  ok(j === Math.floor((2 * F) / w) && leg.peaks.bytes <= 2 * F && leg.peaks.bytes > 2 * F - w, `max-width messages: the 2F byte cap, exactly (${j} of ${w} bytes; peak ${leg.peaks.bytes})`);
  await release(signer);
  await until(() => runner.forwarded.length === i + j, "all written");
  ok(leg.counters().bytes === 0 && leg.counters().entries === 0, "the queue empties as it is written");
}

// ---- the browser's buffer: nothing written while bufferedAmount plus the envelope is over F
{
  const { leg, ws, runner } = await openLeg();
  ws.bufferedAmount = F - 10;
  leg.send(note(1, "y".repeat(100)));
  await tick(40);
  ok(runner.forwarded.length === 0, "held while the buffer has no room for it");
  ws.bufferedAmount = 0;
  await until(() => runner.forwarded.length === 1, "written once it has");
  ok(leg.peaks.buffered + leg.lengths.at(-1).actual <= F, "the buffer plus the envelope stayed at most F");
  const peak = leg.peaks.bytes + leg.peaks.buffered + leg.peaks.reserved * LEG.reserveEnvelope;
  ok(peak <= 2 * F + F + LEG.replySlots * LEG.reserveEnvelope, `the combined wire peak (queue + buffer + reserve) within Bounds 6 (${peak})`);
}

// ---- owed replies: 32 under a held signer and socket all written; the 33rd ends the pairing (r3c)
{
  const { leg, ws, runner, signer } = await openLeg();
  signer.hold = true;
  ws.bufferedAmount = F;
  for (let k = 0; k < LEG.queueEntries; k++) leg.send(note(k, "q")); // (the queue full: every reply goes to the reserve)
  let owed = 0;
  for (let k = 0; k < LEG.replySlots; k++) if (leg.owe()) owed++;
  for (let k = 0; k < owed; k++) leg.reply(JSON.stringify({ jsonrpc: "2.0", id: "s" + k, result: { big: "z".repeat(1000) } }), JSON.stringify({ jsonrpc: "2.0", id: "s" + k, error: { code: -32000, message: "limit" } }));
  ok(owed === 32 && leg.peaks.owed === 32 && leg.peaks.reserved === 32, `32 owed replies, each from its reserve place (owed ${leg.peaks.owed}, reserve ${leg.peaks.reserved})`);
  ws.bufferedAmount = 0;
  await release(signer);
  await until(() => runner.forwarded.length === LEG.queueEntries + 32, "all written");
  ok(runner.forwarded.slice(-32).every((m, k) => JSON.parse(m).id === "s" + k && JSON.parse(m).error), "…all 32 written, in order, none lost");
  for (let k = 0; k < 32; k++) leg.owe();
  ok(leg.owe() === false && leg.state === "closed" && leg.ended.kind === "full" && leg.ended.why === "the agent sent too many requests at once", "the 33rd owed reply ends the pairing, failing closed, with board's why");
}

// ---- Disconnect: the ordered drain (E1), from the control reserve, after the one being written
{
  const { leg, ws, runner, signer } = await openLeg();
  signer.hold = true;
  leg.send(note(1, "first"));
  leg.send(note(2, "unstarted"));
  for (let k = 0; k < 32; k++) { leg.owe(); leg.reply("x".repeat(3 * F), JSON.stringify({ jsonrpc: "2.0", id: "s" + k, error: { code: -32000, message: "limit" } })); }
  await tick(5);
  const done = leg.disconnect();
  ok(leg.send(note(3)) === "closed" && leg.counters().controls === 2, "Disconnect: nothing new admitted; the controls from their own reserve, with 32 reserve replies pending");
  await release(signer);
  await done;
  await until(() => runner.forwarded.length === 3, "the drain's writes verified");
  ok(JSON.stringify(runner.forwarded) === JSON.stringify([note(1, "first"), JSON.stringify({ jsonrpc: "2.0", method: "grant.changed", params: {} }), JSON.stringify({ unpair: true })]), "written exactly: the message being signed, grant.changed {}, {\"unpair\":true}; the unstarted ones dropped");
  ok(leg.state === "closed" && leg.ended.kind === "disconnected" && ws.readyState === 3, "then the close; the stop is requested, not confirmed");
}

// ---- the drain's bound; a late signature after it sends nothing
{
  const { leg, ws, runner, signer } = await openLeg();
  signer.hold = true;
  leg.send(note(1));
  await tick(5);
  const t0 = Date.now();
  await leg.disconnect();
  const took = Date.now() - t0;
  ok(leg.state === "closed" && took >= LEG.unpairMs - 20 && took < LEG.unpairMs + 500, `a signer that never answers: the leg closes at UNPAIR_MS (${took} ms)`);
  const before = ws.sent.length;
  await release(signer);
  await tick(20);
  ok(ws.sent.length === before && runner.forwarded.length === 0, "the late signature then sends nothing");
  ok(signGate.active === 0 && signGate.bytes === 0, "and its charge is released at settlement");
}

// ---- a signing failure during the drain: one terminal close, nothing after
{
  const { leg, ws, runner, signer } = await openLeg();
  signer.fail = true;
  await leg.disconnect();
  await tick(10);
  ok(leg.state === "closed" && leg.ended.kind === "disconnected" && runner.forwarded.length === 0 && ws.readyState === 3, "a signing that fails in the drain: one close, nothing written");
}

// ---- after the page's own unpair, the runner's agent.ended and an unrelated close: still the Disconnect
{
  const { leg, ws, runner, signer } = await openLeg();
  signer.hold = true;
  const done = leg.disconnect();
  await until(() => signer.held.length === 1, "grant.changed being signed");
  signer.held.shift().res();
  await until(() => runner.forwarded.length === 1, "grant.changed written; the unpair's signing held");
  ws.recv({ jsonrpc: "2.0", method: "agent.ended", params: { text: "The agent stopped. Reload to start it again." } });
  ws.peerClose(1000, "");
  await done;
  ok(leg.ended.kind === "disconnected" && leg.ended.why === "", "agent.ended \"The agent stopped\" and a close right after the unpair: the end is the person's Disconnect (requested), not the runner's line");
  await release(signer); // (the unpair's signing, settled: its page-wide charge goes)
}

// ---- the runner's agent.ended otherwise: its words
{
  const { leg, ws } = await openLeg();
  ws.recv({ jsonrpc: "2.0", method: "agent.ended", params: { text: "The agent couldn't start (OSError). Check the runner's --agent-cmd." } });
  ws.peerClose(1011, "");
  ok(leg.ended.kind === "ended" && leg.ended.why.startsWith("The agent couldn't start"), "an agent.ended the page didn't ask for: the runner's words, as they are");
}

// ---- the pairing over a link: agent.ready pairs; nothing before it; an old leg's messages reach nothing
const ws0 = { forAgent: () => ({}), stat: async () => null, agentGrants: async () => ({}), putAgentGrant: async () => {} };
const pairOn = (leg) => new AgentPairing(0, { link: leg, computer: "laptop" }, { verbsFor: () => ({ list: async () => [], stat: async () => null, read: async () => ({ entry: { path: "/a", kind: "file" }, content: "hi", rev: 1 }) }), store: ws0, trashEntry: async () => null, page: { origin: "https://x", path: "/agents/" } });
const ready = (child = "child-1") => ({ jsonrpc: "2.0", method: "agent.ready", params: { agent: { name: "Claude", client: "claude-agent-sdk", version: "0.4.0" }, features: ["notebook.edit", "permission.digest"], child } });
{
  const { leg, ws, runner } = await openLeg();
  const p = pairOn(leg);
  p.paired().catch(() => {});
  ws.recv({ jsonrpc: "2.0", id: "s1", method: "workspace.read", params: { path: "/a" } });
  await tick(5);
  ok(p.state === "closed" && runner.forwarded.length === 0, "a call before agent.ready ends the pairing; nothing reaches the workspace");
}
{
  const { leg, ws, runner } = await openLeg();
  const p = pairOn(leg);
  ws.recv(ready());
  const h = await p.paired();
  ok(p.state === "paired" && h.child === "child-1" && h.agent.name === "Claude" && h.features.includes("permission.digest"), "agent.ready pairs: the agent, its features and its child");
  ws.recv({ jsonrpc: "2.0", id: "s1", method: "workspace.read", params: { path: "/a" } });
  await until(() => runner.forwarded.length === 1, "the refusal");
  ok(/not granted|grant/.test(JSON.parse(runner.forwarded[0]).error?.message ?? ""), "before the person's grant, a call is refused (nothing of the workspace read)");
  await p.allow({ folders: ["/"], write: false, expires: null }, false);
  await until(() => runner.forwarded.some((m) => JSON.parse(m).method === "page.features"), "the grant told");
  const n = runner.forwarded.length;
  ok(runner.forwarded.slice(1, n).some((m) => JSON.parse(m).method === "grant.changed") && runner.forwarded.some((m) => JSON.parse(m).method === "page.features" && JSON.parse(m).params.features.includes("permission.digest")), "the grant is told, and permission.digest among the page's features");
  ws.recv({ jsonrpc: "2.0", id: "s2", method: "workspace.read", params: { path: "/a" } });
  await until(() => runner.forwarded.length === n + 1, "the answer");
  ok(JSON.parse(runner.forwarded.at(-1)).result?.content?.text === "hi", "once granted, a call is answered through the leg");
  ok(p.notifyWhy("chat.message", { conversation: "c", id: "1", author: "person", text: "x".repeat(F) }) === "over", "a chat message over F: \"over\" (board's 4 MB line), the pairing kept");
  await p.revoke("revoked by the person");
  await tick(10);
  ok(p.state === "closed" && leg.state === "closed" && JSON.parse(runner.forwarded.at(-1)).unpair === true, "Revoke: the pairing over at once; the leg's drain ends with {\"unpair\":true}");
  const before = runner.forwarded.length;
  ws.recv(ready("child-2"));
  ws.recv({ jsonrpc: "2.0", id: "s3", method: "workspace.read", params: { path: "/a" } });
  await tick(10);
  ok(runner.forwarded.length === before && p.hello.child === "child-1", "the old leg's later messages (an agent.ready, a call) reach nothing");
}

// ---- a held signer, Revoke with a queued Allow, Chat here again, then release: nothing old reaches the new leg
{
  const a = await openLeg();
  const pa = pairOn(a.leg);
  a.ws.recv(ready());
  await pa.paired();
  await pa.allow({ folders: ["/"], write: false, expires: null }, false);
  await until(() => a.runner.forwarded.length >= 2, "grant told");
  a.signer.hold = true;
  pa.notify("chat.permission", { request_id: "perm-1", behavior: "allow", digest: "D".repeat(43) });
  await tick(5);
  const revoked = pa.revoke("revoked by the person");
  // (Chat here again while the old signing is held: the new hello waits for the page's one signing place)
  const opening = openLeg();
  await tick(20);
  ok(signGate.active === 1 && signGate.queued === 1, "the new leg's hello waits for the old signing to settle (one signing in the page)");
  await release(a.signer);
  const b = await opening;
  const pb = pairOn(b.leg);
  b.ws.recv(ready("child-b"));
  await pb.paired();
  await revoked;
  await tick(20);
  ok(!b.runner.forwarded.some((m) => m.includes("perm-1")), "the old pairing's Allow, signed late, never reaches the new leg");
  ok(pb.state === "paired" && b.leg.state === "open", "the new pairing is untouched");
  pb.drop();
}

// ---- page-wide: signings and digests outstanding across repeated Chat here and close; PEAK bytes, then zero
{
  signGate.resetPeaks(); digestGate.resetPeaks();
  const legs = [];
  for (let k = 0; k < 4; k++) {
    const x = await openLeg();
    x.signer.hold = true;
    x.leg.send(note(k, "w".repeat(F - 1000)));
    await tick(5);
    legs.push(x);
    x.leg.close(); // (closed while its signing is held: the charge stays until it settles)
  }
  ok(signGate.peak === 1 && signGate.active <= 1, `at most one signing outstanding in the whole page, across close and Chat here again (peak ${signGate.peak})`);
  const heldDigests = [];
  const slow = (a) => new Promise((res) => heldDigests.push(() => res(permissionDigest(a))));
  const pairing = { state: "granted", link: {}, hello: { child: "ch" }, sent: [], notify(m, p) { this.sent.push(p); return true; } };
  let current = pairing;
  const cards = new PermissionCards({ current: () => current, gate: digestGate, charge: DIGEST_CHARGE, digest: slow });
  for (let k = 0; k < 6; k++) {
    cards.admit("conv", { id: "perm-" + k, child: "ch", conversation: "conv", request_id: "perm-" + k, action: { tool: "WebFetch", input: { url: "https://e/" + k } } });
    cards.answer("perm-" + k, true);
  }
  await tick(5);
  ok(digestGate.peak === 4 && digestGate.peakBytes === 4 * DIGEST_CHARGE && digestGate.queued === 2, `at most 4 digests outstanding, charged ${4 * DIGEST_CHARGE} bytes at the peak (the Bounds 6 ruling's 192 KiB); the rest wait`);
  current = null; // (the pairing closed: the waiting ones are dropped, the started ones keep their charge until they settle)
  digestGate.sweep();
  ok(digestGate.queued === 0 && digestGate.active === 4, "closed: the waiting digests dropped, the 4 started still charged");
  while (heldDigests.length) heldDigests.shift()();
  for (const x of legs) await release(x.signer);
  await tick(20);
  ok(pairing.sent.length === 0, "no stale Allow from a closed pairing");
  ok(signGate.active === 0 && signGate.bytes === 0 && digestGate.active === 0 && digestGate.bytes === 0, "after settlement everything returns to zero");
  ok(legs.every((x) => x.runner.forwarded.length === 0 && Object.values(x.leg.counters()).every((v) => v === 0)), "and no closed leg wrote anything, its timers, listeners and queue all gone");
}

// ---- the card: one-shot, its fields as admitted
{
  const mk = () => ({ state: "granted", link: {}, hello: { child: "ch" }, sent: [], notify(m, p) { this.sent.push(p); return true; } });
  const card = (id, extra = {}) => ({ id, child: "ch", conversation: "conv", request_id: id, action: { tool: "WebFetch", input: { url: "https://e/x" } }, ...extra });
  // (Allow, the digest held, then Deny and more clicks: exactly one Allow, for the card first shown)
  {
    const p = mk();
    let hold;
    const cards = new PermissionCards({ current: () => p, gate: digestGate, charge: DIGEST_CHARGE, digest: (a) => new Promise((res) => { hold = () => res(permissionDigest(a)); }) });
    const shown = card("perm-a");
    cards.admit("conv", shown);
    shown.action.input.url = "https://evil/"; // (the shown object changed after admission: the card's own copy stands)
    ok(cards.answer("perm-a", true) === true, "the first click (Allow) claims the card");
    ok(cards.answer("perm-a", false) === false && cards.answer("perm-a", true) === false, "Deny after it, and Allow again: nothing (claimed)");
    await tick(2); hold(); await cards.pending;
    const want = await permissionDigest({ child: "ch", conversation: "conv", request: "perm-a", tool: "WebFetch", input: { url: "https://e/x" } });
    ok(p.sent.length === 1 && p.sent[0].behavior === "allow" && p.sent[0].digest === want, "exactly one Allow, with the digest of the card as admitted");
  }
  {
    const p = mk();
    let started = 0;
    const cards = new PermissionCards({ current: () => p, gate: digestGate, charge: DIGEST_CHARGE, digest: (a) => { started++; return permissionDigest(a); } });
    cards.admit("conv", card("perm-b"));
    cards.answer("perm-b", false); cards.answer("perm-b", true);
    await tick(5);
    ok(p.sent.length === 1 && p.sent[0].behavior === "deny" && started === 0, "Deny first: exactly one Deny, no digest started");
  }
  {
    let p = mk();
    let hold;
    const cards = new PermissionCards({ current: () => p, gate: digestGate, charge: DIGEST_CHARGE, digest: (a) => new Promise((res) => { hold = () => res(permissionDigest(a)); }) });
    cards.admit("conv", card("perm-c"));
    cards.answer("perm-c", true);
    const old = p;
    p = mk(); // (the pairing replaced while the digest is held)
    await tick(2); hold(); await cards.pending;
    ok(old.sent.length === 0 && p.sent.length === 0, "claimed, then the pairing replaced or closed: nothing sent");
  }
  {
    const p = mk();
    const cards = new PermissionCards({ current: () => p, gate: digestGate, charge: DIGEST_CHARGE });
    ok(cards.admit("other-conv", card("perm-d")) === false && p.sent.at(-1)?.behavior === "deny", "a card naming another conversation than its turn's: not shown, answered Deny");
    ok(cards.admit("conv", card("perm-e", { child: "someone-else" })) === false, "…nor one with another child");
    ok(cards.admit("conv", { id: "perm-f", title: "Allow WebFetch?" }) === false, "over a runner, a card without the fields its digest needs: Deny");
    cards.admit("conv", card("perm-g", { action: { tool: "WebFetch", input: { n: 1.5 } } }));
    cards.answer("perm-g", true);
    await cards.pending;
    ok(p.sent.at(-1).request_id === "perm-g" && p.sent.at(-1).behavior === "deny", "a card the page's canon refuses: Allow isn't sent, it's answered Deny (fails closed)");
  }
}

console.log(failures ? `test-agent-relay: ${failures} failed` : "test-agent-relay: all passed");
process.exit(failures ? 1 : 0);
