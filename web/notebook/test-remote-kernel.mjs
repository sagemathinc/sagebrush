// RemoteKernel (remote-kernel.js) and its client (remote-client.js) against
// an in-memory fake of CoCalc's compute gateway (remote-fake.js): DPoP
// proofs and nonces, one terminal per request, the plan's prep-result table
// and the gateway's outcomes, busy, a lost reply resent once, broken and
// oversized event streams, interrupt, restart, the restart fence in each
// order (a restart never lets an old run's code into the new kernel), stale
// callbacks, takeover, quarantine and a moved binding.
//   bun web/notebook/test-remote-kernel.mjs
import { RemoteClient, GatewayError, EVENT_MAX } from "./remote-client.js";
import { RemoteKernel, NOTES, outcomeNote } from "./remote-kernel.js";
import { FakeGateway } from "./remote-fake.js";

let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
const fast = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

async function setup() {
  const fake = new FakeGateway();
  let token = null;
  const client = await RemoteClient.create({ base: fake.base, token: () => token, fetch: fake.fetch });
  token = fake.issueToken(client.jkt);
  const kernel = new RemoteKernel({ client, notebook: "fid-1", clientId: "c1", sleep: fast });
  const restarts = { n: 0 };
  kernel.on("restart", () => restarts.n++);
  const statuses = [];
  kernel.on("status", (t) => statuses.push(t));
  check(await kernel.start(), "the kernel binds");
  return { fake, client, kernel, restarts, statuses };
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
  const t = await Promise.race([s.ended.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
  if (!t) check(false, `a terminal for ${JSON.stringify(code).slice(0, 40)} within 5 s`);
  return s;
}
const text = (s) => s.outs.map((o) => o[0]).join("");
const runsPosted = (fake) => fake.calls.filter(([m, p]) => m === "POST" && /\/runs$/.test(p)).length;

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

// ---- the plan's §2.3 table: a prep result that is not ok never sends the user's code
{
  const { fake, kernel } = await setup();
  const rows = [
    ["wrong-binding", /^\nNot run: the remote kernel's setup failed \(kernel belongs to another binding\)/],
    ["setup-failed", /^\nNot run: the remote kernel's setup failed/],
    ["helper-error", /^\nNot run: the remote kernel's setup failed \(helper error: NameError\)/],
    ["malformed", /^\nNot run: the remote kernel's setup failed \(no valid response from the kernel helper\)/],
    ["interrupted", new RegExp("^" + NOTES.beforeCode.replace(/[.()]/g, "\\$&") + "$")],
  ];
  for (const [prep, want] of rows) {
    fake.prep = () => prep;
    const n = fake.executions.length;
    const s = await run(kernel, `x_${prep}`);
    check(s.terminal?.[0] === "stopped" && want.test(s.terminal[1]) && fake.executions.length === n, `prep ${prep}: ${JSON.stringify(s.terminal?.[1]).slice(0, 70)}; the user's code never sent`);
  }
  for (const prep of ["missing-helper", "wrong-incarnation"]) {
    fake.prep = () => prep;
    const g = kernel.generation, n = fake.executions.length;
    const s = await run(kernel, `y_${prep}`);
    fake.prep = () => "ok";
    check(s.terminal?.[1] === NOTES.restartedBeforeRun && fake.executions.length === n, `prep ${prep}: restarted before the run, the user's code never sent`);
    check(await until(() => kernel.generation === g + 1), `prep ${prep}: one recovery (a restart, a new generation)`);
  }
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
  fake.kernel = async (code) => ({ events: [], outcome: { status: "ok", ms: 1 } });
  const s2 = await run(kernel, "v");
  check(s2.terminal?.[0] === "done" && fake.calls.some(([m, p]) => m === "POST" && p.endsWith("/takeover")), "the next run takes the binding over first, then runs");
}

// ---- busy, a lost reply, a broken stream, an oversized event, the envelope MIME, the body cap
{
  const { fake, kernel } = await setup();
  const b = fake.bindings.get(kernel.binding);
  b.busy = "someone-else";
  const n = runsPosted(fake);
  const s = await run(kernel, "busy");
  check(s.terminal?.[1] === NOTES.busy && runsPosted(fake) === n + 1, "busy: not run, said so, and not resubmitted");
  b.busy = null;

  fake.faults.loseReply = 1;
  const e0 = fake.executions.length, r0 = runsPosted(fake);
  const s2 = await run(kernel, "lost");
  check(s2.terminal?.[0] === "done" && fake.executions.length === e0 + 1 && runsPosted(fake) === r0 + 2, "a lost reply: resent once, identically; it runs exactly once");

  fake.kernel = async () => ({ events: [1, 2, 3].map((i) => ({ type: "stream", name: "stdout", text: `${i}\n` })), outcome: { status: "ok", ms: 1 } });
  fake.faults.breakStream = 2;
  const s3 = await run(kernel, "broken");
  check(s3.terminal?.[0] === "done" && text(s3) === "1\n2\n3\n", "a stream broken twice: resumed after the last event seen, every output exactly once");

  fake.faults.bigEvent = true;
  const s4 = await run(kernel, "big");
  check(s4.terminal?.[0] === "done" && s4.outs.some(([t, err]) => t === NOTES.tooLarge && err), `an event over ${EVENT_MAX} bytes: refused unparsed, said so, and the outcome is still reported`);

  fake.kernel = async () => ({ events: [
    { type: "display", data: { "application/vnd.sagebrush.envelope.v1+json": { v: 1 } } },
    { type: "display", data: { "text/plain": "shown" } },
  ], outcome: { status: "ok", ms: 1 } });
  const s5 = await run(kernel, "env");
  check(s5.displays.length === 1 && s5.displays[0]["text/plain"] === "shown", "an envelope never reaches a cell; other displays do");

  const e1 = fake.executions.length;
  const s6 = await run(kernel, "x".repeat(2.5 * 1024 * 1024));
  check(s6.terminal?.[0] === "stopped" && /over its size limit/.test(s6.terminal[1]) && fake.executions.length === e1, "a run over its body cap: not sent");

  const c = await kernel.ask({ complete: "ab" }, "python", "fallback");
  check(c.matches?.[0] === "ab_x" && c.prefix === "ab", "completion");
  check((await kernel.ask({ check: "x" }, "python", "fallback")) === "fallback", "other questions: the fallback");
}

// ---- interrupt: the running run is interrupted, the queued one skipped
{
  const { fake, kernel } = await setup();
  fake.kernel = (code, r) => new Promise(() => {}); // (runs until interrupted)
  const s1 = sink(), s2 = sink();
  kernel.execute("loop", { mode: "python" }, s1);
  kernel.execute("next", { mode: "python" }, s2);
  check(await until(() => fake.executions.length === 1), "the first run reaches the kernel");
  kernel.interrupt();
  await s1.ended; await s2.ended;
  check(s1.terminal?.[0] === "done" && s1.terminal[1].error && s1.terminal[1].interrupted, "interrupted: KeyboardInterrupt, an error, marked interrupted");
  check(s2.terminal?.[0] === "skipped" && fake.executions.length === 1, "the queued run: skipped, never sent");
}

// ---- restart: the running run is stopped, a new generation; and the restart fence in each order
{
  const { fake, kernel, restarts } = await setup();
  // (d), and the old-user-first case: the code is still running when the kernel is killed
  fake.kernel = (code, r) => new Promise(() => {});
  const s = sink();
  kernel.execute("forever", { mode: "python" }, s);
  check(await until(() => fake.executions.length === 1), "(d) the user phase reaches the kernel, and keeps running");
  const g = kernel.generation;
  kernel.restart();
  await s.ended;
  const old = fake.runs.get([...fake.runs.keys()].pop());
  check(s.terminal?.[1] === NOTES.stoppedRestart && old.outcome?.status === "stopped" && /restart/.test(old.outcome.reason), "(d) killed by the restart: stopped, kernel restarted");
  check(await until(() => kernel.generation === g + 1 && restarts.n === 1), "a new generation, and the restart event");
  // a late event for the old request changes nothing
  const outs = s.outs.length;
  fake.emitEvent(old, { type: "stream", name: "stdout", text: "late\n" });
  await fast(20);
  check(s.outs.length === outs && s.terminals === 1, "a late event of the old request: dropped");
  fake.kernel = async (code) => ({ events: [], outcome: { status: "ok", ms: 1 } });

  // (K3) a run that finished before the kill keeps its done(ok)
  const s0 = await run(kernel, "quick");
  const quick = fake.runs.get([...fake.runs.keys()].pop());
  kernel.restart();
  await until(() => kernel.generation === g + 2);
  check(s0.terminal?.[0] === "done" && quick.outcome.status === "ok", "(K3) a done(ok) before the restart stays historical: never rewritten");

  // (a) prep done, not yet validated; (b) validated, not yet allocated: fenced when the restart is admitted
  for (const point of ["after-prep", "before-user-alloc"]) {
    const pz = fake.pause(point);
    const sp = sink();
    kernel.execute(`paused_${point}`, { mode: "python" }, sp);
    const r = await pz.reached;
    const g0 = kernel.generation, n = fake.executions.length;
    kernel.restart();
    await until(() => kernel.generation === g0 + 1);
    pz.release();
    await sp.ended;
    await fast(20);
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
    await sp.ended;
    check(r.outcome?.status === "stopped" && fake.executions.length === n, "the gateway's atomic allocation check, on its own: nothing is sent");
  }

  // (c) allocated, the RPC not yet delivered, then a restart commits: the receiver refuses it
  {
    const pz = fake.pause("after-user-alloc");
    const sp = sink();
    kernel.execute("in-transit", { mode: "python" }, sp);
    const r = await pz.reached;
    const g0 = kernel.generation, n = fake.executions.length;
    kernel.restart();
    await until(() => kernel.generation === g0 + 1);
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
    await sp.ended;
    check(r.outcome?.reason === "stale-incarnation" && fake.executions.length === n && sp.terminal?.[1] === NOTES.notHanded, "the receiver's incarnation check, on its own: refused, never runs");
  }

  // a refused restart changes nothing
  fake.faults.restartRefused = "deadline";
  const g2 = kernel.generation;
  const st = [];
  const off = kernel.on("status", (t) => st.push(t));
  kernel.restart();
  await until(() => st.some((t) => /restart failed/.test(t)));
  off();
  check(kernel.generation === g2 && st.some((t) => t.includes("access expired")), "a refused restart: the status says why, and the generation is unchanged");
  fake.faults.restartRefused = null;
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
  const s2 = await run(kernel, "quarantine");
  check(s2.terminal?.[1] === NOTES.kernelReplaced && kernel.binding !== b0 && kernel.generation === g0 + 1 && restarts.n === r0 + 1, "quarantined: a new binding, a new generation, said so");
  const s3 = await run(kernel, "fresh");
  check(s3.terminal?.[0] === "done", "and the new binding runs");

  fake.bindings.get(kernel.binding).epoch++; // (another tab took it over)
  const s4 = await run(kernel, "moved");
  check(s4.terminal?.[1] === NOTES.moved && kernel.moved, "another tab took it over: this one stops");
  const s5 = await run(kernel, "after-moved");
  check(s5.terminal?.[1] === NOTES.moved, "and refuses more work at once");
}

check(sinks.every((s) => s.terminals === 1), `every request had exactly one terminal (${sinks.length} requests)`);
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
