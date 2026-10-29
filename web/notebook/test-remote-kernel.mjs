// RemoteKernel (remote-kernel.js) and its client (remote-client.js) against
// an in-memory fake of CoCalc's compute gateway (remote-fake.js): DPoP
// proofs and nonces; https only, no redirects; size caps at their exact
// boundaries; one terminal per request; the plan's prep-result table and the
// gateway's outcomes; busy; lost, oversized and unreadable acknowledgements;
// broken, oversized, duplicated and gapped event streams; interrupt;
// restart; the restart fence in each order; late answers of every lifecycle
// operation (they never change what came after them); aborts while waiting
// for headers, for a body that never comes, and while polling; takeover,
// quarantine and a moved binding.  Every wait is bounded.
//   bun web/notebook/test-remote-kernel.mjs
import { RemoteClient, GatewayError, NotSentError, AmbiguousError, StreamError, EVENT_DATA_MAX, EVENT_RAW_MAX, RESPONSE_MAX, BODY_MAX } from "./remote-client.js";
import { RemoteKernel, NOTES, outcomeNote } from "./remote-kernel.js";
import { FakeGateway } from "./remote-fake.js";

// (the whole file is bounded: a hang is a failure, never a stuck CI job)
setTimeout(() => { console.log("FAIL the tests did not finish within 120 s"); process.exit(1); }, 120_000).unref?.();

let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
const fast = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}
const within = (p, ms = 3000) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), new Promise((r) => setTimeout(() => r({ timeout: true }), ms))]);
const enc = new TextEncoder();
const streamOf = (chunks, { close = true } = {}) => new ReadableStream({
  start(c) { for (const x of chunks) c.enqueue(typeof x === "string" ? enc.encode(x) : x); if (close) c.close(); },
});
const jsonOfSize = (n) => JSON.stringify({ p: "x".repeat(n - 8) }); // ({"p":""} is 8 bytes)

async function makeClient(fake, extra = {}) {
  let token = null;
  const client = await RemoteClient.create({ base: fake.base, token: () => token, fetch: fake.fetch, ...extra });
  token = fake.issueToken(client.jkt);
  return client;
}
async function setup() {
  const fake = new FakeGateway();
  const client = await makeClient(fake);
  const kernel = new RemoteKernel({ client, notebook: "fid-1", clientId: "c1", sleep: fast });
  const restarts = { n: 0 }, readies = { n: 0 };
  kernel.on("restart", () => restarts.n++);
  kernel.on("ready", () => readies.n++);
  const statuses = [];
  kernel.on("status", (t) => statuses.push(t));
  check(await kernel.start(), "the kernel binds");
  return { fake, client, kernel, restarts, readies, statuses };
}

const sinks = [];
function sink() {
  let end;
  const s = {
    outs: [], displays: [], terminal: null, terminals: 0, started: false,
    ended: new Promise((r) => (end = r)),
    start() { s.started = true; },
    out(t, e) { s.outs.push([t, !!e]); },
    display(b) { s.displays.push(b); },
    interact() {},
    clear() { s.outs.push(["<clear>", false]); },
    done(ms, x) { s.terminals++; s.terminal ??= ["done", x ?? {}]; end(); },
    stopped(m) { s.terminals++; s.terminal ??= ["stopped", m]; end(); },
    skipped() { s.terminals++; s.terminal ??= ["skipped"]; end(); },
  };
  sinks.push(s);
  return s;
}
async function run(kernel, code, opts = {}) {
  const s = sink();
  kernel.execute(code, { mode: "python", ...opts }, s);
  const t = await within(s.ended, 5000);
  if (t.timeout) check(false, `a terminal for ${JSON.stringify(code).slice(0, 40)} within 5 s`);
  return s;
}
const text = (s) => s.outs.map((o) => o[0]).join("");
const posted = (fake, re) => fake.calls.filter(([m, p]) => m === "POST" && re.test(p)).length;
const runsPosted = (fake) => posted(fake, /\/runs$/);
const lastRun = (fake) => fake.runs.get([...fake.runs.keys()].pop());

// ---- DPoP: the proofs, the key, the nonce
{
  const { fake, client, kernel } = await setup();
  check(client.privateKey.extractable === false, "the private key is not extractable");
  const s = await run(kernel, "1+1");
  check(s.terminal?.[0] === "done" && s.terminal[1].error === false && text(s) === "ran: 1+1\n", "a run: its output, then done without error");
  const p = fake.proofs;
  check(p.length >= 3 && p.every((x) => x.header.typ === "dpop+jwt" && x.header.alg === "ES256"), "every proof is a dpop+jwt, ES256");
  check(p.every((x) => Object.keys(x.header.jwk).sort().join() === "crv,kty,x,y"), "every proof's jwk is exactly the public key (no private member)");
  check(p.every((x) => !x.claims.htu.includes("?") && x.claims.htu.startsWith(fake.base)), "htu excludes the query");
  check(new Set(p.map((x) => x.claims.jti)).size === p.length && p.every((x) => x.claims.jti.length >= 22), "every jti is new and at least 128 bits");
  check(p.every((x) => typeof x.claims.ath === "string"), "every proof binds the access token (ath)");
  check(p[0].claims.nonce === undefined && p[1].claims.nonce === fake.nonce, "no nonce yet: refused, then retried once with the server's nonce");
  fake.rotateNonce();
  const s2 = await run(kernel, "2+2");
  check(s2.terminal?.[0] === "done", "a rotated nonce: retried once, and it runs");
  fake.faults.staleNonceAlways = true;
  const before = fake.proofs.length;
  let err = null;
  try { await client.request("GET", "/bindings/b1/runs/none"); } catch (e) { err = e; }
  check(err instanceof GatewayError && err.status === 401 && fake.proofs.length - before === 2, "a second nonce refusal is an error, after exactly one retry");
  fake.faults.staleNonceAlways = false;
}

// ---- a run asked before the first bind finishes runs on it
{
  const fake = new FakeGateway();
  const client = await makeClient(fake);
  const k = new RemoteKernel({ client, notebook: "fid-3", clientId: "c3", sleep: fast });
  const hold = fake.intercept("POST", /^\/bindings$/, { pause: true });
  const starting = k.start();
  await hold.reached;
  const s = sink();
  k.execute("asked-before-bind", { mode: "python" }, s);
  hold.release();
  await within(starting);
  await within(s.ended);
  check(s.terminal?.[0] === "done" && fake.executions.some((x) => x.code === "asked-before-bind"), "a run asked before the first bind finished: it runs on that binding");
}

// ---- P1A-A3-2: https only, no credentials in the address, no redirects, no escaping the base
{
  const fake = new FakeGateway();
  let tokens = 0;
  const token = () => { tokens++; return "t"; };
  for (const [base, what] of [["http://cocalc.test/api/compute/v1", "an http base"], ["https://u:p@cocalc.test/api/compute/v1", "a base with credentials"], ["https://cocalc.test/api/compute/v1?x=1", "a base with a query"]]) {
    let err = null;
    try { await RemoteClient.create({ base, token, fetch: fake.fetch }); } catch (e) { err = e; }
    check(err instanceof TypeError && fake.fetches.length === 0 && tokens === 0, `P1A-A3-2 ${what}: refused before any token, proof or request`);
  }
  const extractable = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  let err = null;
  try { await RemoteClient.create({ base: fake.base, token, fetch: fake.fetch, keys: extractable }); } catch (e) { err = e; }
  check(err instanceof TypeError, "P1A-A3-2 carry: a supplied extractable private key is refused");
  const client = await makeClient(fake);
  fake.faults.redirectTo = "http://evil.test/steal";
  err = null;
  try { await client.request("GET", "/bindings/b1/runs/x"); } catch (e) { err = e; }
  check(err instanceof AmbiguousError && fake.insecure.length === 0, "P1A-A3-2 a redirect (https to http): refused; no credential-bearing request follows it");
  const n = fake.fetches.length;
  for (const bad of ["/bindings/../x", "/bindings//x", "/bindings/%2e%2e/x", "bindings/x", "/bindings/a\\b"]) {
    err = null;
    try { await client.request("GET", bad); } catch (e) { err = e; }
    check(err instanceof NotSentError && fake.fetches.length === n, `P1A-A3-2 a path escaping the base (${JSON.stringify(bad)}): not sent`);
  }
  const ok = await client.request("POST", "/bindings", { notebook: "n" });
  check(ok.binding === "b1", "P1A-A3-2 the https fake: the positive case works");
}

// ---- P1A-D2-1, P1A-D2-2: the caps, at the limit and one past it
{
  const fake = new FakeGateway();
  const client = await makeClient(fake);
  // responses: read as a stream, refused at the first byte past the cap, never trusting a length
  fake.raw("GET", /^\/caps\/exact$/, () => new Response(streamOf([jsonOfSize(RESPONSE_MAX)]), { status: 200 }));
  const r1 = await client.request("GET", "/caps/exact");
  check(r1?.p?.length === RESPONSE_MAX - 8, `P1A-D2-1 a response of exactly ${RESPONSE_MAX} bytes, no Content-Length: read`);
  fake.raw("GET", /^\/caps\/over$/, () => new Response(streamOf([jsonOfSize(RESPONSE_MAX + 1)]), { status: 200 }));
  let err = null;
  try { await client.request("GET", "/caps/over"); } catch (e) { err = e; }
  check(err instanceof AmbiguousError && err.tooLarge, "P1A-D2-1 one byte past it: refused");
  fake.raw("GET", /^\/caps\/endless$/, () => new Response(streamOf(["{\"p\":\"", "x".repeat(RESPONSE_MAX)], { close: false }), { status: 200 }));
  const t = await within(client.request("GET", "/caps/endless"), 3000);
  check(!t.timeout && t.e instanceof AmbiguousError && t.e.tooLarge, "P1A-D2-1 a body past the cap that never ends: refused at the cap, without waiting for its end");
  // events: the JSON at most EVENT_DATA_MAX, the raw event at most EVENT_RAW_MAX, an unfinished one refused at once
  const evOfSize = (n) => {
    const base = JSON.stringify({ seq: 1, type: "stream", name: "stdout", text: "" });
    return JSON.stringify({ seq: 1, type: "stream", name: "stdout", text: "x".repeat(n - base.length) });
  };
  const events = async (path) => { const out = []; for await (const ev of client.events(path, 0)) out.push(ev); return out; };
  fake.raw("GET", /^\/caps\/ev1\/events$/, () => new Response(streamOf([`data: ${evOfSize(EVENT_DATA_MAX)}\n\n`]), { status: 200 }));
  const e1 = await within(events("/caps/ev1"));
  check(e1.v?.length === 1, `P1A-D2-2 an event of exactly ${EVENT_DATA_MAX} bytes of JSON: accepted`);
  fake.raw("GET", /^\/caps\/ev2\/events$/, () => new Response(streamOf([`data: ${evOfSize(EVENT_DATA_MAX + 1)}\n\n`]), { status: 200 }));
  const e2 = await within(events("/caps/ev2"));
  check(e2.e instanceof StreamError && e2.e.tooLarge, "P1A-D2-2 one byte past it: refused before parsing");
  fake.raw("GET", /^\/caps\/ev3\/events$/, () => new Response(streamOf(["data: ", "x".repeat(EVENT_RAW_MAX - 6 + 1)], { close: false }), { status: 200 }));
  const e3 = await within(events("/caps/ev3"));
  check(!e3.timeout && e3.e instanceof StreamError && e3.e.tooLarge, "P1A-D2-2 an unfinished event one byte past the raw cap: refused at once, without waiting");
  fake.raw("GET", /^\/caps\/ev4\/events$/, () => new Response(streamOf(["data: ", "x".repeat(EVENT_RAW_MAX - 6), "\n"]), { status: 200 }));
  const e4 = await within(events("/caps/ev4"));
  check(!e4.timeout && !e4.e, "P1A-D2-2 an unfinished event of exactly the raw cap, its separator begun: not refused");
  // request bodies: each class at its cap is sent, one byte past it is not
  for (const [method, path, cap, what] of [["POST", "/bindings/bx/runs", BODY_MAX.run, "a run"], ["PUT", "/bindings/bx/files/f", BODY_MAX.put, "a file chunk"], ["POST", "/bindings", BODY_MAX.other, "anything else"]]) {
    const n0 = fake.fetches.length;
    let e = null;
    try { await client.request(method, path, JSON.parse(jsonOfSize(cap))); } catch (x) { e = x; }
    check(!(e instanceof NotSentError) && fake.fetches.length > n0, `P1A-D2 ${what} body of exactly ${cap} bytes: sent`);
    const n1 = fake.fetches.length;
    e = null;
    try { await client.request(method, path, JSON.parse(jsonOfSize(cap + 1))); } catch (x) { e = x; }
    check(e instanceof NotSentError && fake.fetches.length === n1, `P1A-D2 ${what} body one byte past it: not sent`);
  }
}

// ---- the plan's §2.3 table: a prep result that is not ok never sends the user's code
{
  const { fake, kernel } = await setup();
  const rows = [
    ["wrong-binding", /^\nNot run: the remote kernel's setup failed \(kernel belongs to another binding\)/],
    ["setup-failed", /^\nNot run: the remote kernel's setup failed/],
    ["helper-error", /^\nNot run: the remote kernel's setup failed \(helper error: NameError\)/],
    ["malformed", /^\nNot run: the remote kernel's setup failed \(no valid response from the kernel helper\)/],
  ];
  for (const [prep, want] of rows) {
    fake.prep = () => prep;
    const n = fake.executions.length;
    const s = await run(kernel, `x_${prep}`);
    check(s.terminal?.[0] === "stopped" && want.test(s.terminal[1]) && fake.executions.length === n, `prep ${prep}: ${JSON.stringify(s.terminal?.[1]).slice(0, 70)}; the user's code never sent`);
  }
  fake.prep = () => "interrupted";
  const si = await run(kernel, "x_interrupted");
  check(si.terminal?.[1] === NOTES.beforeCode, "prep interrupted: not run, interrupted before the code");
  for (const prep of ["missing-helper", "wrong-incarnation"]) {
    fake.prep = () => prep;
    const g = kernel.generation, n = fake.executions.length;
    const s = await run(kernel, `y_${prep}`);
    fake.prep = () => "ok";
    check(s.terminal?.[1] === NOTES.restartedBeforeRun && fake.executions.length === n, `prep ${prep}: restarted before the run, the user's code never sent`);
    check(await until(() => kernel.generation === g + 1), `prep ${prep}: one recovery (a restart, a new generation)`);
  }
  // (P1A-C1) a recovery while another run is queued: that run waits for the recovery, and is told the kernel restarted
  fake.prep = () => "missing-helper";
  const g = kernel.generation;
  const a = sink(), b = sink();
  kernel.execute("needs-recovery", { mode: "python" }, a);
  kernel.execute("queued-behind", { mode: "python" }, b);
  await within(Promise.all([a.ended, b.ended]));
  fake.prep = () => "ok";
  check(await until(() => kernel.generation === g + 1) && b.terminal?.[0] === "stopped" && !fake.executions.some((x) => x.code === "queued-behind"), "P1A-C1 a run queued behind a recovery: never sent to the old kernel, told the kernel restarted");
  const s = await run(kernel, "after");
  check(s.terminal?.[0] === "done", "after the recoveries, runs work again");
}

// ---- the gateway's outcomes: every no-effect terminal has its note (the plan's §9.4)
{
  const want = {
    deadline: NOTES.deadline, "send-refused": NOTES.sendRefused, "crash-before-handoff": NOTES.notHanded,
    "reset-before-handoff": NOTES.notHanded, "restart-before-handoff": NOTES.notHanded, cancelled: NOTES.notHanded,
    "stale-generation": NOTES.notHanded, "stale-incarnation": NOTES.notHanded, "no-prep": NOTES.notHanded,
    "no-process": NOTES.noProcess, "interrupted before your code ran": NOTES.beforeCode, busy: NOTES.busy,
  };
  check(Object.entries(want).every(([r, n]) => outcomeNote({ status: "refused", reason: r }) === n), "refused(reason): each reason's note");
  check(outcomeNote({ status: "stopped", reason: "kernel restarted" }) === NOTES.stoppedRestart, "stopped(kernel restarted): its note");
  check(outcomeNote({ status: "unknown" }) === NOTES.unknown && outcomeNote({ status: "nonsense" }) === NOTES.unknown, "unknown, or anything unrecognised: unknown");
  check(outcomeNote({ status: "ok" }) === null && outcomeNote({ status: "error" }) === null, "ok and error are completed runs, not notes");
  const { fake, kernel } = await setup();
  fake.kernel = async () => ({ events: [], outcome: { status: "unknown" } });
  const s = await run(kernel, "u");
  check(s.terminal?.[1] === NOTES.unknown && kernel.needsFence, "an unknown outcome: said so, and the binding is fenced before more work");
  fake.kernel = async () => ({ events: [], outcome: { status: "ok", ms: 1 } });
  const s2 = await run(kernel, "v");
  check(s2.terminal?.[0] === "done" && posted(fake, /\/takeover$/) === 1, "the next run takes the binding over first, then runs");
}

// ---- busy; lost, oversized and unreadable acknowledgements (P1A-C3); streams; envelopes; completion
{
  const { fake, kernel } = await setup();
  const b = fake.bindings.get(kernel.binding);
  b.busy = "someone-else";
  const n = runsPosted(fake);
  const s = await run(kernel, "busy");
  check(s.terminal?.[1] === NOTES.busy && runsPosted(fake) === n + 1, "busy: not run, said so, and not resubmitted");
  b.busy = null;

  fake.faults.loseReply = 1;
  let e0 = fake.executions.length, r0 = runsPosted(fake);
  const s2 = await run(kernel, "lost");
  check(s2.terminal?.[0] === "done" && fake.executions.length === e0 + 1 && runsPosted(fake) === r0 + 2, "a lost reply: resent once, identically; it runs exactly once");

  fake.faults.oversizeAck = 1;
  e0 = fake.executions.length; r0 = runsPosted(fake);
  const s3 = await run(kernel, "oversized-ack");
  check(s3.terminal?.[0] === "done" && fake.executions.length === e0 + 1 && runsPosted(fake) === r0 + 2 && !/Not run/.test(text(s3)), "P1A-C3 an oversized acknowledgement of an admitted run: never 'Not run'; reconciled by the identical resend; it runs exactly once");

  fake.intercept("POST", /\/runs$/, { skip: false, respond: { status: 202, body: "not an object" } });
  e0 = fake.executions.length;
  const s4 = await run(kernel, "malformed-ack");
  check(s4.terminal?.[0] === "done" && fake.executions.length === e0 + 1, "P1A-C3 an unreadable acknowledgement: reconciled, runs exactly once");

  fake.faults.oversizeAck = 2;
  e0 = fake.executions.length;
  const s5 = await run(kernel, "twice-ambiguous");
  check(s5.terminal?.[0] === "done" && fake.executions.length === e0 + 1, "P1A-C3 ambiguous twice: reconciled from the request's own record (it ran), runs exactly once");
  fake.faults.oversizeAck = 2;
  fake.intercept("GET", /\/runs\/[^/]+$/, { respond: { status: 503, body: "unavailable" } });
  e0 = fake.executions.length;
  const s5b = await run(kernel, "twice-ambiguous-unreconciled");
  check(s5b.terminal?.[1] === NOTES.unknown && kernel.needsFence && fake.executions.length === e0 + 1, "P1A-C3 ambiguous twice and its record unreachable: unknown (not 'Not run'), and fenced before more work");
  await until(() => !fake.bindings.get(kernel.binding).busy);
  const s6 = await run(kernel, "after-unknown");
  check(s6.terminal?.[0] === "done" && !kernel.needsFence, "the next run fences first, then runs");

  const e1 = fake.executions.length;
  const s7 = await run(kernel, "x".repeat(2.5 * 1024 * 1024));
  check(s7.terminal?.[0] === "stopped" && /^\nNot run: this request is over its size limit/.test(s7.terminal[1]) && fake.executions.length === e1 && !kernel.needsFence, "P1A-C3 negative control: a body over its cap is refused before sending: 'Not run', no fence");

  fake.kernel = async () => ({ events: [1, 2, 3].map((i) => ({ type: "stream", name: "stdout", text: `${i}\n` })), outcome: { status: "ok", ms: 1 } });
  fake.faults.breakStream = 2;
  const s8 = await run(kernel, "broken");
  check(s8.terminal?.[0] === "done" && text(s8) === "1\n2\n3\n", "a stream broken twice: resumed after the last event seen, every output exactly once");

  // (astra's carry) duplicates and a gap, checked by the client itself, not the fake
  fake.kernel = async () => ({ events: [{ type: "stream", name: "stdout", text: "a\n" }, { type: "stream", name: "stdout", text: "b\n" }], outcome: { status: "ok", ms: 1 } });
  fake.raw("GET", /\/events$/, () => new Response(streamOf([
    'data: {"seq":1,"type":"start"}\n\n', 'data: {"seq":1,"type":"start"}\n\n',
    'data: {"seq":2,"type":"stream","name":"stdout","text":"a\\n"}\n\n', 'data: {"seq":2,"type":"stream","name":"stdout","text":"a\\n"}\n\n',
    'data: {"seq":4,"type":"terminal","outcome":{"status":"ok"}}\n\n',
  ]), { status: 200 }));
  const s9 = await run(kernel, "dupes");
  check(s9.terminal?.[0] === "done" && text(s9) === "a\nb\n", "duplicated events are skipped, and a gap reconnects from the last one seen: every output once, in order");

  fake.faults.bigEvent = true;
  fake.kernel = async () => ({ events: [{ type: "stream", name: "stdout", text: "1\n" }], outcome: { status: "ok", ms: 1 } });
  const s10 = await run(kernel, "big");
  check(s10.terminal?.[0] === "done" && s10.outs.some(([t, err]) => t === NOTES.tooLarge && err), "an event over its cap: refused unparsed, said so, and the outcome is still reported");

  fake.kernel = async () => ({ events: [
    { type: "display", data: { "application/vnd.sagebrush.envelope.v1+json": { v: 1 } } },
    { type: "display", data: { "text/plain": "shown" } },
  ], outcome: { status: "ok", ms: 1 } });
  const s11 = await run(kernel, "env");
  check(s11.displays.length === 1 && s11.displays[0]["text/plain"] === "shown", "an envelope never reaches a cell; other displays do");

  const c = await kernel.ask({ complete: "ab" }, "python", "fallback");
  check(c.matches?.[0] === "ab_x" && c.prefix === "ab", "completion");
  check((await kernel.ask({ check: "x" }, "python", "fallback")) === "fallback", "other questions: the fallback");
}

// ---- interrupt: the running run is interrupted, the queued one skipped
{
  const { fake, kernel } = await setup();
  fake.kernel = () => new Promise(() => {}); // (runs until interrupted)
  const s1 = sink(), s2 = sink();
  kernel.execute("loop", { mode: "python" }, s1);
  kernel.execute("next", { mode: "python" }, s2);
  check(await until(() => fake.executions.length === 1), "the first run reaches the kernel");
  kernel.interrupt();
  await within(Promise.all([s1.ended, s2.ended]));
  check(s1.terminal?.[0] === "done" && s1.terminal[1].error && s1.terminal[1].interrupted, "interrupted: KeyboardInterrupt, an error, marked interrupted");
  check(s2.terminal?.[0] === "skipped" && fake.executions.length === 1, "the queued run: skipped, never sent");
}

// ---- restart: the running run is stopped, a new generation; and the restart fence in each order
{
  const { fake, kernel, restarts } = await setup();
  // (d), and the old-user-first case: the code is still running when the kernel is killed
  fake.kernel = () => new Promise(() => {});
  const s = sink();
  kernel.execute("forever", { mode: "python" }, s);
  check(await until(() => fake.executions.length === 1), "(d) the user phase reaches the kernel, and keeps running");
  const jobA = kernel.current;
  const g = kernel.generation;
  await kernel.restart();
  await within(s.ended);
  const old = lastRun(fake);
  check(s.terminal?.[1] === NOTES.stoppedRestart && old.outcome?.status === "stopped" && /restart/.test(old.outcome.reason), "(d) killed by the restart: stopped, kernel restarted");
  check(kernel.generation === g + 1 && restarts.n === 1 && kernel.current === null, "a new generation, the restart event, and the old run released");
  // (P1A-C1) the old run's late callbacks change nothing: no fence, no recovery, no output
  const outs = s.outs.length;
  fake.emitEvent(old, { type: "stream", name: "stdout", text: "late\n" });
  kernel.finish(jobA, { status: "unknown" });
  kernel.finish(jobA, { status: "restarted-before-run", incarnation: 9 });
  await tick(50);
  check(s.outs.length === outs && s.terminals === 1 && !kernel.needsFence && kernel.generation === g + 1, "P1A-C1 an old request's late event, unknown outcome or restarted-before-run: dropped; no fence, no recovery");
  fake.kernel = async () => ({ events: [], outcome: { status: "ok", ms: 1 } });

  // (K3) a run that finished before the kill keeps its done(ok)
  const s0 = await run(kernel, "quick");
  const quick = lastRun(fake);
  await kernel.restart();
  check(s0.terminal?.[0] === "done" && quick.outcome.status === "ok" && kernel.generation === g + 2, "(K3) a done(ok) before the restart stays historical: never rewritten");

  // (a) prep done, not yet validated; (b) validated, not yet allocated: fenced when the restart is admitted
  for (const point of ["after-prep", "before-user-alloc"]) {
    const pz = fake.pause(point);
    const sp = sink();
    kernel.execute(`paused_${point}`, { mode: "python" }, sp);
    const r = await pz.reached;
    const n = fake.executions.length;
    await kernel.restart();
    pz.release();
    await within(sp.ended);
    await tick();
    check(r.outcome?.status === "stopped" && fake.executions.length === n && sp.terminal?.[1] === NOTES.stoppedRestart, `(${point === "after-prep" ? "a" : "b"}) paused at ${point}, then a restart: the run is fenced, its user code never runs`);
  }

  // the allocation check alone (a restart version moved, the fence missed): nothing is sent
  {
    const pz = fake.pause("before-user-alloc");
    const sp = sink();
    kernel.execute("alloc-check", { mode: "python" }, sp);
    const r = await pz.reached;
    const n = fake.executions.length;
    fake.bindings.get(kernel.binding).restartVersion++;
    pz.release();
    await within(sp.ended);
    check(r.outcome?.status === "stopped" && fake.executions.length === n, "K2 the gateway's atomic allocation check, on its own: nothing is sent");
  }

  // (c) allocated, the RPC not yet delivered, then a restart commits: the receiver refuses it
  {
    const pz = fake.pause("after-user-alloc");
    const sp = sink();
    kernel.execute("in-transit", { mode: "python" }, sp);
    const r = await pz.reached;
    const n = fake.executions.length;
    await kernel.restart();
    pz.release();
    await until(() => !!r.outcome);
    check(r.outcome?.status === "refused" && r.outcome.reason === "stale-incarnation" && fake.executions.length === n, "(c) delivered after the restart: refused as a stale incarnation, never runs in the new kernel");
    check(sp.terminal?.[1] === NOTES.stoppedRestart && sp.terminals === 1, "(c) the cell: stopped by the restart, one terminal");
  }

  // the receiver's check alone (the incarnation moved, the gateway's pins did not)
  {
    const pz = fake.pause("after-user-alloc");
    const sp = sink();
    kernel.execute("receiver-check", { mode: "python" }, sp);
    const r = await pz.reached;
    const n = fake.executions.length;
    fake.bindings.get(kernel.binding).incarnation++;
    pz.release();
    await within(sp.ended);
    check(r.outcome?.reason === "stale-incarnation" && fake.executions.length === n && sp.terminal?.[1] === NOTES.notHanded, "K2 the receiver's incarnation check, on its own: refused, never runs");
  }

  // a refused restart changes nothing
  fake.faults.restartRefused = "deadline";
  const g2 = kernel.generation;
  const st = [];
  const off = kernel.on("status", (t) => st.push(t));
  await kernel.restart();
  off();
  check(kernel.generation === g2 && st.some((t) => /restart failed/.test(t) && t.includes("access expired")), "a refused restart: the status says why, and the generation is unchanged");
  fake.faults.restartRefused = null;

  // (P1A-C1) a restart answer without an outcome is not success: checked with the gateway (nothing applied)
  fake.intercept("POST", /\/restart$/, { respond: { status: 200, body: {} } });
  const g3 = kernel.generation, t3 = posted(fake, /\/takeover$/);
  await kernel.restart();
  check(kernel.generation === g3 && posted(fake, /\/takeover$/) === t3 + 1 && !kernel.needsFence, "P1A-C1 a restart answer with no outcome: not taken as success; a takeover finds it didn't happen");
  // (P1A-C1) applied, its answer lost: the takeover finds it, and the restart's effects follow
  fake.intercept("POST", /\/restart$/, { lose: true });
  const r4 = restarts.n;
  await kernel.restart();
  check(kernel.generation === g3 + 1 && restarts.n === r4 + 1, "P1A-C1 a restart applied with its answer lost: found by the takeover, a new generation");
  // (P1A-C1) two restarts asked at once: one restart, never two answers applied out of order
  const g5 = kernel.generation, n5 = posted(fake, /\/restart$/);
  await Promise.all([kernel.restart(), kernel.restart()]);
  check(kernel.generation === g5 + 1 && posted(fake, /\/restart$/) === n5 + 1, "P1A-C1 two restarts at once: serialized, one restart, one new generation");
  // (P1A-C1) a completion answered after a restart: the fallback, not the old kernel's answer
  const hold = fake.intercept("POST", /\/complete$/, { pause: true });
  const asking = kernel.ask({ complete: "ab" }, "python", "fallback");
  await hold.reached;
  await kernel.restart();
  hold.release();
  check((await asking) === "fallback", "P1A-C1 a completion answered after a restart: the fallback");
  const after = await run(kernel, "after-restarts");
  check(after.terminal?.[0] === "done", "and runs work after all of it");
}

// ---- P1A-C1 / A3-1 / A5-1: late answers of lifecycle operations never touch what came after them
{
  // a late epoch refusal, and a late quarantine, for a run the restart already settled
  for (const [code, body, what] of [[409, { error: "epoch" }, "an epoch refusal"], [410, { error: "quarantined" }, "a quarantine"]]) {
    const { fake, kernel } = await setup();
    const hold = fake.intercept("POST", /\/runs$/, { respond: { status: code, body }, pause: true, ignoreAbort: true });
    const sa = sink();
    kernel.execute(`late-${code}`, { mode: "python" }, sa);
    await hold.reached;
    const b0 = kernel.binding;
    await kernel.restart();
    hold.release();
    await tick(50);
    check(sa.terminal?.[1] === NOTES.stoppedRestart && !kernel.moved && kernel.binding === b0 && kernel.ready, `P1A-C1 a late ${what} for a run the restart settled: the kernel is not moved or replaced`);
    const sb = await run(kernel, "b-runs");
    check(sb.terminal?.[0] === "done", `P1A-C1 after a late ${what}: the next run works`);
  }
  // a late restart answer after close
  {
    const { fake, kernel, restarts, readies } = await setup();
    const hold = fake.intercept("POST", /\/restart$/, { pause: true, ignoreAbort: true });
    const restarting = kernel.restart();
    await hold.reached;
    const g = kernel.generation;
    kernel.close();
    hold.release();
    await within(restarting);
    check(kernel.closed && kernel.generation === g && restarts.n === 0 && readies.n === 1, "P1A-C1 a restart answered after close: no new generation, no restart or ready event");
  }
  // a late bind answer after close
  {
    const fake = new FakeGateway();
    const client = await makeClient(fake);
    const k = new RemoteKernel({ client, notebook: "fid-2", clientId: "c2", sleep: fast });
    let ready = 0;
    k.on("ready", () => ready++);
    const hold = fake.intercept("POST", /^\/bindings$/, { pause: true, ignoreAbort: true });
    const starting = k.start();
    await hold.reached;
    k.close();
    hold.release();
    const r = await within(starting);
    check(r.v === false && !k.ready && ready === 0 && k.binding === null, "P1A-C1 a bind answered after close: no binding, never ready");
  }
  // a late takeover answer after close
  {
    const { fake, kernel } = await setup();
    kernel.needsFence = true;
    const hold = fake.intercept("POST", /\/takeover$/, { pause: true, ignoreAbort: true });
    const s = sink();
    kernel.execute("waits-for-fence", { mode: "python" }, s);
    await hold.reached;
    const e0 = kernel.epoch;
    kernel.close();
    hold.release();
    await within(s.ended);
    await tick();
    check(s.terminal?.[1] === NOTES.closed && kernel.epoch === e0 && kernel.closed && posted(fake, /\/runs$/) === 0, "P1A-C1 a takeover answered after close: no new epoch, nothing sent");
  }
}

// ---- P1A-C2 / A5-2: aborts reach every wait, and a lifecycle change releases the queue
{
  const { fake, kernel } = await setup();
  fake.kernel = () => new Promise(() => {});
  // paused response headers for the event stream
  const hold = fake.intercept("GET", /\/events$/, { pause: true });
  const s1 = sink();
  kernel.execute("paused-headers", { mode: "python" }, s1);
  await hold.reached;
  await kernel.restart();
  await within(s1.ended);
  check(s1.terminal?.[1] === NOTES.stoppedRestart && kernel.current === null, "P1A-C2 a restart while the stream's headers are pending: the run is settled and released");
  fake.kernel = async () => ({ events: [], outcome: { status: "ok", ms: 1 } });
  const s2 = await run(kernel, "after-paused-headers");
  check(s2.terminal?.[0] === "done", "P1A-C2 and the queue moves on");
  // a body that never produces anything
  fake.kernel = () => new Promise(() => {});
  fake.faults.silentStream = true;
  const s3 = sink();
  kernel.execute("silent-body", { mode: "python" }, s3);
  check(await until(() => fake.executions.some((x) => x.code === "silent-body")), "the run reaches the kernel; its stream never yields");
  await kernel.restart();
  await within(s3.ended);
  fake.kernel = async () => ({ events: [], outcome: { status: "ok", ms: 1 } });
  const s4 = await run(kernel, "after-silent");
  check(s3.terminal?.[1] === NOTES.stoppedRestart && s4.terminal?.[0] === "done", "P1A-C2 a restart while reading a body that never yields: aborted, released, and the next run works");
  // polling an outcome (the stream was refused as too big), then a restart
  fake.kernel = () => new Promise(() => {});
  fake.faults.bigEvent = true;
  const s5 = sink();
  kernel.execute("polling", { mode: "python" }, s5);
  check(await until(() => fake.calls.filter(([m, p]) => m === "GET" && /\/runs\/[^/]+$/.test(p)).length > 0), "the run's outcome is being polled");
  await kernel.restart();
  await within(s5.ended);
  const polls = fake.calls.filter(([m, p]) => m === "GET" && /\/runs\/[^/]+$/.test(p)).length;
  await tick(100);
  const polls2 = fake.calls.filter(([m, p]) => m === "GET" && /\/runs\/[^/]+$/.test(p)).length;
  check(s5.terminal?.[1] === NOTES.stoppedRestart && polls2 === polls, "P1A-C2 a restart while polling: settled, and the polling stops");
  // close while the headers are pending: nothing left running
  fake.kernel = () => new Promise(() => {});
  const hold2 = fake.intercept("GET", /\/events$/, { pause: true });
  const s6 = sink();
  kernel.execute("close-in-headers", { mode: "python" }, s6);
  await hold2.reached;
  kernel.close();
  await within(s6.ended);
  check(s6.terminal?.[1] === NOTES.closed && kernel.current === null, "P1A-C2 close while the headers are pending: settled, no job left");
}

// ---- P1A-R2-C1 / P1A2-A5-1: once a run may have been admitted, no retry outcome makes it "Not run"
{
  // (a) admitted, its answer lost, then another tab takes the binding over: the retry hears "epoch"
  {
    const { fake, kernel } = await setup();
    const b = fake.bindings.get(kernel.binding);
    fake.intercept("POST", /\/runs$/, { lose: true, after: () => { b.epoch++; } });
    const e0 = fake.executions.length;
    const s = await run(kernel, "r2c1-epoch");
    check(s.terminal?.[0] === "done" && fake.executions.length === e0 + 1 && !/Not run/.test(s.terminal[1] ?? "") && !text(s).includes("Not run"), "P1A-R2-C1 (a) admitted, its answer lost, then another tab took over: the retry's epoch refusal is not 'Not run'; the request's own record shows it ran, once");
  }
  // (a') the same, and the request's record can't be read: unknown, fenced, and this tab stops taking work
  {
    const { fake, kernel } = await setup();
    const b = fake.bindings.get(kernel.binding);
    fake.intercept("POST", /\/runs$/, { lose: true, after: () => { b.epoch++; } });
    fake.intercept("GET", /\/runs\/[^/]+$/, { respond: { status: 503, body: "unavailable" } });
    const e0 = fake.executions.length;
    const s = await run(kernel, "r2c1-epoch-unreconciled");
    check(s.terminal?.[1] === NOTES.unknown && kernel.needsFence && kernel.moved && fake.executions.length === e0 + 1, "P1A-R2-C1 (a') and its record unreachable: unknown (never 'Not run'), fenced, and moved for future work");
  }
  // (b) the retry hears a typed authorization or fencing refusal
  for (const [status, error] of [[401, "invalid_token"], [409, "fencing"]]) {
    const { fake, kernel } = await setup();
    fake.intercept("POST", /\/runs$/, { lose: true });
    fake.intercept("POST", /\/runs$/, { respond: { status, body: { error } } });
    const e0 = fake.executions.length;
    const s = await run(kernel, `r2c1-${error}`);
    check(s.terminal?.[0] === "done" && fake.executions.length === e0 + 1, `P1A-R2-C1 (b) admitted, its answer lost, the retry refused (${error}): reconciled from its record, it ran, once; never 'Not run'`);
  }
  // (c) the retry fails before it is sent (the token is gone): unknown, fenced
  {
    const { fake, client, kernel } = await setup();
    const realToken = client.token;
    fake.intercept("POST", /\/runs$/, { lose: true, after: () => { client.token = () => { throw new Error("signed out"); }; } });
    const e0 = fake.executions.length;
    const s = await run(kernel, "r2c1-presend");
    check(s.terminal?.[1] === NOTES.unknown && kernel.needsFence && fake.executions.length === e0 + 1, "P1A-R2-C1 (c) admitted, its answer lost, the retry not even sent: unknown (never 'Not run'), and fenced");
    client.token = realToken;
    const s2 = await run(kernel, "r2c1-after");
    check(s2.terminal?.[0] === "done" && posted(fake, /\/takeover$/) === 1, "P1A-R2-C1 (c) the next run fences first, then runs");
  }
}

// ---- P1A-R3-C1 / P1A3-A5-1: a "not-found" for a run that may have been admitted proves nothing
{
  const { fake, kernel } = await setup();
  fake.intercept("POST", /\/runs$/, { respond: { status: 202, body: "unreadable" } }); // (sent; the answer can't be read)
  fake.intercept("POST", /\/runs$/, { respond: { status: 409, body: { error: "busy" } } }); // (the retry is refused)
  const e0 = fake.executions.length;
  const s = await run(kernel, "r3c1-not-found");
  check(s.terminal?.[1] === NOTES.unknown && kernel.needsFence && fake.executions.length === e0 && fake.calls.some(([m, p]) => m === "GET" && /\/runs\/[^/]+$/.test(p)), "P1A-R3-C1 an unreadable answer, a refused retry, then the record answers 404: unknown and fenced, never 'Not run'");
}

// ---- P1A-R2-C2 / P1A2-A5-3: an incomplete takeover answer is no evidence: nothing concluded, the fence stays
{
  const { fake, kernel, statuses } = await setup();
  const variants = [
    ["applied_before_takeover omitted", (r) => { delete r.applied_before_takeover; }],
    ["applied_before_takeover not an array", (r) => { r.applied_before_takeover = {}; }],
    ["in_flight omitted", (r) => { delete r.in_flight; }],
    ["in_flight not an array", (r) => { r.in_flight = "none"; }],
    ["a malformed entry", (r) => { r.applied_before_takeover = [{ op_id: 7, kind: "restart" }]; }],
    ["an applied restart without its incarnation", (r) => { delete r.incarnation; }],
  ];
  for (const [what, mutate] of variants) {
    // (each variant from a consistent start: the fake's epoch is the client's, as an invalid takeover
    // answer leaves the client's unchanged while the fake moved on)
    fake.bindings.get(kernel.binding).epoch = kernel.epoch;
    let applied = false;
    fake.intercept("POST", /\/restart$/, { lose: true });
    fake.intercept("POST", /\/takeover$/, { mutate: (r) => { applied = (r.applied_before_takeover ?? []).some((a) => a.kind === "restart"); mutate(r); } });
    const g = kernel.generation, n = statuses.length;
    await kernel.restart();
    const said = statuses.slice(n);
    check(applied, `P1A-R2-C2 (${what}) the restart really was applied, and the gateway's real answer said so`);
    check(kernel.generation === g && kernel.needsFence && !said.some((t) => /did not happen/.test(t)) && said.some((t) => /could not be checked/.test(t)), `P1A-R2-C2 a restart applied, its answer lost, then a takeover answer with ${what}: nothing concluded, the fence stays`);
  }
  // (an old run still executing, and a ready answer that leaves in_flight out: not taken as "nothing running")
  fake.kernel = () => new Promise(() => {});
  const sa = sink();
  kernel.execute("still-running", { mode: "python" }, sa);
  check(await until(() => fake.executions.some((x) => x.code === "still-running")), "a run is executing");
  kernel.close();
  const fake2 = fake; // (the same gateway, a second tab)
  const client2 = await makeClient(fake2);
  const k2 = new RemoteKernel({ client: client2, notebook: "fid-1", clientId: "c9", sleep: fast });
  await k2.start();
  k2.lc = Object.freeze({ ...k2.lc, binding: kernel.binding }); // (k2 joins the first tab's binding)
  k2.needsFence = true;
  fake2.intercept("POST", /\/takeover$/, { mutate: (r) => { delete r.in_flight; } });
  const sb = sink();
  k2.execute("second-tab", { mode: "python" }, sb);
  await within(sb.ended);
  check(sb.terminal?.[1] === NOTES.unreachable && k2.needsFence && !fake2.executions.some((x) => x.code === "second-tab"), "P1A-R2-C2 a ready answer leaving in_flight out while an old run executes: nothing submitted, the fence stays");
}

// ---- P1A-R2-A3-1 / P1A2-A5-4: a replacement queued behind a restart never touches the kernel the restart made
{
  const { fake, kernel, restarts, readies } = await setup();
  const holdA = fake.intercept("POST", /\/runs$/, { respond: { status: 410, body: { error: "quarantined" } }, pause: true });
  const sa = sink();
  kernel.execute("A", { mode: "python" }, sa);
  await holdA.reached;
  const holdR = fake.intercept("POST", /\/restart$/, { pause: true });
  const b0 = kernel.binding, g0 = kernel.generation, r0 = restarts.n, rd0 = readies.n, binds0 = posted(fake, /^\/bindings$/);
  const restarting = kernel.restart();
  await holdR.reached;
  holdA.release();
  check(await until(() => kernel.lifeOps >= 2), "the quarantine arrived while the restart was pending: a replacement is queued behind it");
  holdR.release();
  await within(restarting);
  await tick(50);
  check(sa.terminal?.[1] === NOTES.kernelReplaced && kernel.binding === b0 && kernel.generation === g0 + 1 && restarts.n === r0 + 1 && readies.n === rd0 && posted(fake, /^\/bindings$/) === binds0 && kernel.lifeOps === 0, "P1A-R2-A3-1 the queued replacement found the restart's new record: it did nothing (same binding, one new generation, no new bind, no extra events)");
  const sb = await run(kernel, "after-queued-replace");
  check(sb.terminal?.[0] === "done", "P1A-R2-A3-1 and the restarted kernel runs");
}

// ---- P1A-R2-A3-2 / P1A2-A5-2 (controls per P1A-R3-C2 / P1A3-A5-2 / P1A-R3-A3-1): a token or proof that
// never comes can't hold a cancelled request.  Each stub signals when it is entered, the abort comes
// only after that, the original operation itself must settle (its finally included), and when the
// stub answers late, nothing more is sent and nothing changes.
{
  const { fake, client, kernel } = await setup();
  const pathCount = (re) => fake.fetches.filter((u) => re.test(new URL(u).pathname)).length;
  // (a) a run's token never comes; a restart aborts it
  const realToken = client.token;
  let tokenEntered, releaseToken = null;
  const tokenIn = new Promise((r) => (tokenEntered = r));
  let firstToken = true;
  client.token = (o) => {
    if (!firstToken) return realToken(o);
    firstToken = false;
    tokenEntered();
    return new Promise((res) => { releaseToken = () => res(realToken(o)); });
  };
  const s1 = sink();
  kernel.execute("token-hang", { mode: "python" }, s1);
  const t1 = await within(tokenIn);
  check(!t1.timeout, "P1A-R3-C2 (a) the run's token provider is entered (latch), and never answers");
  const jobA = kernel.current;
  const runs0 = pathCount(/\/runs$/);
  await kernel.restart();
  const settled = await within(jobA.settled, 3000);
  check(!settled.timeout && s1.terminal?.[1] === NOTES.stoppedRestart && kernel.lifeOps === 0 && kernel.current === null, "P1A-R3-C2 (a) a restart after the token wait was entered: the original run settles (its finally ran), the lifecycle is free");
  const g = kernel.generation;
  releaseToken();
  await tick(50);
  check(pathCount(/\/runs$/) === runs0 && kernel.generation === g && s1.terminals === 1, "P1A-R3-C2 (a) the token answers late: nothing is sent, nothing changes");
  const s2 = await run(kernel, "after-token-hang");
  check(s2.terminal?.[0] === "done", "P1A-R3-C2 (a) and the next run works");
  // (b) a takeover's proof never comes; close aborts it
  const realProof = client.proof.bind(client);
  let proofEntered, releaseProof = null;
  const proofIn = new Promise((r) => (proofEntered = r));
  let firstProof = true;
  client.proof = (...a) => {
    if (!firstProof) return realProof(...a);
    firstProof = false;
    proofEntered();
    return new Promise((res) => { releaseProof = () => res(realProof(...a)); });
  };
  kernel.needsFence = true;
  const s3 = sink();
  kernel.execute("proof-hang", { mode: "python" }, s3);
  const t3 = await within(proofIn);
  check(!t3.timeout, "P1A-R3-C2 (b) the takeover's signer is entered (latch), and never answers");
  const jobB = kernel.current;
  const life = kernel.lifeChain; // (the takeover, a lifecycle operation, still pending)
  const take0 = pathCount(/\/takeover$/), runs1 = pathCount(/\/runs$/);
  kernel.close();
  const lifeDone = await within(life, 3000), jobDone = await within(jobB.settled, 3000);
  check(!lifeDone.timeout && !jobDone.timeout && s3.terminal?.[1] === NOTES.closed && kernel.lifeOps === 0 && kernel.current === null, "P1A-R3-C2 (b) close after the signer was entered: the takeover and the original run settle (their finally ran), the lifecycle is free");
  const e0 = kernel.epoch;
  releaseProof();
  await tick(50);
  check(pathCount(/\/takeover$/) === take0 && pathCount(/\/runs$/) === runs1 && kernel.epoch === e0 && kernel.closed && s3.terminals === 1, "P1A-R3-C2 (b) the signature comes late: no takeover or run is sent, nothing changes");
}

// ---- takeover, quarantine, a moved binding, a run still executing elsewhere
{
  const { fake, kernel, restarts } = await setup();
  kernel.needsFence = true;
  fake.faults.takeover = ["fencing", "ready"];
  const s = await run(kernel, "after-fence");
  check(s.terminal?.[0] === "done" && kernel.epoch === 2 && !kernel.needsFence, "fencing, then ready: it waits, takes the new epoch, then runs");

  kernel.needsFence = true;
  fake.inFlight = [{ op_id: "x", kind: "run" }];
  const s1 = await run(kernel, "in-flight");
  check(s1.terminal?.[1] === NOTES.inFlight && kernel.needsFence, "a run from the previous tab still executing: nothing is submitted");
  fake.inFlight = [];

  fake.faults.takeover = ["quarantined"];
  const b0 = kernel.binding, g0 = kernel.generation, r0 = restarts.n;
  const holdBind = fake.intercept("POST", /^\/bindings$/, { pause: true });
  const s2 = sink();
  kernel.execute("quarantine", { mode: "python" }, s2);
  await holdBind.reached; // (the replacement is binding: there is no binding right now)
  const sq = sink();
  kernel.execute("asked-during-replacement", { mode: "python" }, sq);
  holdBind.release();
  await within(Promise.all([s2.ended, sq.ended]));
  await until(() => kernel.ready && kernel.binding !== b0 && restarts.n === r0 + 1);
  check(s2.terminal?.[1] === NOTES.kernelReplaced && kernel.binding !== b0 && kernel.generation === g0 + 1 && restarts.n === r0 + 1, "quarantined: a new binding, a new generation, said so");
  check(sq.terminal?.[0] === "done" && fake.executions.some((x) => x.code === "asked-during-replacement"), "a run asked while the replacement was binding: it runs on the new binding");
  const s3 = await run(kernel, "fresh");
  check(s3.terminal?.[0] === "done", "and the new binding runs");

  fake.bindings.get(kernel.binding).epoch++; // (another tab took it over)
  const s4 = await run(kernel, "moved");
  check(s4.terminal?.[1] === NOTES.moved && kernel.moved, "another tab took it over: this one stops");
  const s5 = await run(kernel, "after-moved");
  check(s5.terminal?.[1] === NOTES.moved, "and refuses more work at once");
}

check(sinks.every((s) => s.terminals === 1), `every request had exactly one terminal (${sinks.length} requests)`);

// ---- remote approval end to end: the scheduler, the gate, this kernel and client
{
  const { runGateTests } = await import("./test-remote-gate.mjs");
  const ran = await runGateTests(check);
  console.log(`remote-gate: ${ran} controls ran`);
  check(ran === 32, `remote-gate: every control ran (${ran} of 32)`);
}
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
