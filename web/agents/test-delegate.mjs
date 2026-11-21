// ci: web-runner order=176 runner=bun
// The Agents page's Delegate tasks (delegate.ts) over a real pairing (agent-pair.ts) to a stand-in host
// (test-delegate-host.mjs): the switch, the list and its chips, a task's thread read page by page and moved on by
// task.event, an event the page refuses skipped, Start, the switch's off (the chosen tasks closed first, each failure,
// timeout or disconnect never stopping the capability's revoke; Start refused from its first moment), and a proposal's
// files checked against their blob ids.
//   bun web/agents/test-delegate.mjs
import { AgentPairing } from "../workspace/agent-pair.ts";
import { DelegateTasks, chipOf, DELEGATE_TEXT } from "./delegate.ts";
import { delegateHost } from "./test-delegate-host.mjs";

let failures = 0;
const ok = (c, msg, extra) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && extra !== undefined ? " " + JSON.stringify(extra).slice(0, 400) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(10); } return false; };
const why = async (p) => { try { await p; return "resolved"; } catch (e) { return e?.code ?? String(e); } };
const page = { origin: "http://127.0.0.1:1", path: "/test" };
const pairWith = (H) => new AgentPairing(H.port, { code: "abcd" }, { verbsFor: () => ({}), store: { agentGrants: async () => ({}), putAgentGrant: async () => {} }, trashEntry: async () => null, page });
const sentTasks = (H) => H.got.filter((m) => typeof m.method === "string" && m.method.startsWith("tasks."));

// ---- the switch, the list, the chips
const H = delegateHost({ pageSize: 2 });
const nb = JSON.stringify({ cells: [{ cell_type: "code", id: "c1", metadata: {}, source: "1+1", outputs: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5 });
const A = await H.addTask({ title: "Factor the polynomial", base: { "work/a.ipynb": nb, "work/notes.txt": "one\n" }, proposal: { "work/a.ipynb": nb.replace("1+1", "2+2"), "work/notes.txt": "one\ntwo\n", "work/new.txt": "fresh\n" } });
const B = await H.addTask({ title: "Plot it" });
let changes = 0;
const D = new DelegateTasks({ changed: () => changes++, closeMs: 300 });
const P = pairWith(H);
D.attach(P);
await P.paired();
ok(D.state() === "unoffered", "paired, not granted: Delegate not offered", D.state());
await P.allow({ folders: ["/"], write: true, expires: null }, false);
ok(D.state() === "off" && D.tasks.length === 0, "granted: the switch off, no tasks shown");
ok((await why(D.start({ title: "t", prompt: "p", docs: [], run: false }))) === "forbidden" && sentTasks(H).length === 0, "Start with the switch off: refused here, nothing sent");
ok(D.turnOn() === true, "the switch turned on");
await until(() => D.tasks.length === 2);
ok(D.state() === "on" && D.tasks.length === 2 && H.grant?.delegate === true, "on: the host was told (delegate: true), and the list read (tasks.list)", D.tasks.map((t) => t.entry.title));
const tA = () => D.task(A.task), tB = () => D.task(B.task);
ok(chipOf(tA().entry) === "Proposal ready" && chipOf(tB().entry) === "Working", "each task's chip from its status", [chipOf(tA().entry), chipOf(tB().entry)]);
ok(!tA().loaded && tA().thread.entries.length === 0, "a task not opened: no thread read yet");

// ---- a task's thread: read page by page (tasks.get, 2 events an answer here), its turn events into a chat thread
H.emit(A.task, { type: "turn_started" });
H.emit(A.task, { type: "message_revised", message: "m1", revision: 1 });
H.emit(A.task, { type: "text_delta", message: "m1", revision: 1, text: "Expanding first." });
H.emit(A.task, { type: "turn_finished", outcome: "completed" });
H.emit(A.task, { type: "turn_started" });
H.emit(A.task, { type: "text_delta", message: "m2", revision: 1, text: "x", summary: "a field the protocol doesn't have" });
H.emit(A.task, { type: "message_revised", message: "m2", revision: 1 });
H.emit(A.task, { type: "text_delta", message: "m2", revision: 1, text: "Second turn." });
const seqA = A.log.length;
await D.open(A.task);
const gets = sentTasks(H).filter((m) => m.method === "tasks.get" && m.params.task === A.task);
ok(tA().loaded && tA().thread.applied_seq === seqA && gets.length === Math.ceil(seqA / 2), "opened: the whole log read, page by page (after = what the page has)", { applied: tA().thread.applied_seq, seqA, gets: gets.map((m) => m.params.after) });
ok(gets.map((m) => m.params.after).join() === Array.from({ length: gets.length }, (_, i) => i * 2).join(), "each page asked after the last one's end", gets.map((m) => m.params.after));
const turns = tA().thread.entries.filter((e) => e.kind === "turn");
const text = (t) => t.parts.filter((p) => p.kind === "message").map((p) => p.text).join("|");
ok(turns.length === 2 && text(turns[0]) === "Expanding first." && turns[0].outcome === "completed" && text(turns[1]) === "Second turn." && !turns[1].outcome, "its turn events, untagged, are two turns of a chat thread, split at turn_started", turns.map((t) => [text(t), t.outcome ?? null]));
ok(tA().skipped === 1, "an event this page refuses (a field the protocol doesn't have): skipped and counted, the rest shown", tA().skipped);
ok(tA().proposal?.round === 1 && tA().proposal.files.length === 3 && tA().entry.proposal === tA().proposal.commit, "the proposal event: the task's proposal, its round and files");

// ---- task.event while connected: an open task takes it in order; a gap reads the log again; a task not open moves
//      its chip only; a task not listed yet reads the list
H.emit(A.task, { type: "text_delta", message: "m2", revision: 1, text: " More." });
await until(() => text(tA().thread.entries.at(-1)).endsWith("More."));
ok(text(tA().thread.entries.at(-1)) === "Second turn. More." && tA().thread.applied_seq === A.log.length, "an open task's next event: taken at once", text(tA().thread.entries.at(-1)));
// (a gap: one event the page never heard; the next one makes it read the log again)
const t0 = A.log.length;
A.log.push({ seq: t0 + 1, event: { type: "text_delta", message: "m2", revision: 1, text: " Quiet." } });
H.emit(A.task, { type: "text_delta", message: "m2", revision: 1, text: " Loud." });
await until(() => tA().thread.applied_seq === A.log.length);
ok(text(tA().thread.entries.at(-1)) === "Second turn. More. Quiet. Loud.", "a gap in seq: the log read again from where the page was, nothing lost or doubled", text(tA().thread.entries.at(-1)));
H.emit(B.task, { type: "task_status", status: "failed", reason: "the runner stopped" });
await until(() => tB().entry.status === "failed");
ok(chipOf(tB().entry) === "Failed" && tB().reason === "the runner stopped" && !tB().loaded, "a task not opened: its chip moves (Failed, with its reason), its thread isn't read", chipOf(tB().entry));
const C = await H.addTask({ title: "A third" });
await until(() => D.tasks.length === 3);
ok(D.task(C.task)?.entry.title === "A third", "an event for a task not listed: the list read again");
H.sock.send(JSON.stringify({ jsonrpc: "2.0", method: "task.event", params: { task: A.task, seq: A.log.length + 1, event: { type: "ask", note: "x" } } }));
A.log.push({ seq: A.log.length + 1, event: { type: "ask", note: "x" } });
await until(() => tA().skipped === 2);
ok(tA().skipped === 2 && tA().thread.applied_seq === A.log.length, "an event of a kind M1 doesn't have (ask): skipped, counted, the seq moves on");

// ---- Start
const before = D.tasks.length;
const id = await D.start({ title: "New task", prompt: "Simplify.", docs: [{ path: "work/a.ipynb", kind: "notebook", content: nb }], run: false });
const st = sentTasks(H).findLast((m) => m.method === "tasks.start");
ok(/^[0-9a-f]{32}$/.test(id) && D.tasks.length === before + 1 && st.params.target === "local" && st.params.run === false && st.params.docs[0].path === "work/a.ipynb", "Start: tasks.start with the docs, target local; the new task listed", st?.params);

// ---- a proposal's files, for the proposal view: checked against tasks.diff's blob ids
{
  const src = D.source(A.task, tA().proposal.commit);
  const d = await src.diff();
  ok(d.files.map((f) => f.path + ":" + f.change).join() === "work/a.ipynb:modified,work/new.txt:added,work/notes.txt:modified" && d.base === A.base, "the diff: the files changed, from the proposal commit named", d.files);
  ok((await src.file("work/notes.txt", d.proposal)) === "one\ntwo\n" && (await src.file("work/notes.txt", d.base)) === "one\n", "a file at the proposal and at its base, each checked against its blob id");
  ok((await src.file("work/new.txt", d.base)) === null && sentTasks(H).filter((m) => m.method === "tasks.file" && m.params.path === "work/new.txt" && m.params.commit === d.base).length === 0, "an added file at the base: none, nothing asked");
  ok((await why(src.file("work/notes.txt", "f".repeat(40)))) === "bad_request", "a commit that isn't this proposal's or its base: refused here");
  ok((await why(src.file("work/other.txt", d.proposal))) === "bad_request", "a path that isn't in the proposal: refused here");
  // (the host's bytes for a file no longer what the diff named: refused, the view told the proposal changed)
  A.commits.get(d.proposal)["work/notes.txt"].content = "one\nTWO\n";
  ok((await why(src.file("work/notes.txt", d.proposal))) === "stale", "bytes whose blob id isn't the diff's: refused (stale), never shown");
  A.commits.get(d.proposal)["work/notes.txt"].blob = "0".repeat(40);
  ok((await why(src.file("work/notes.txt", d.proposal))) === "stale", "an answer naming another blob than the diff's: refused (stale)");
}

// ---- the switch's off: Start refused from its first moment; the chosen tasks closed first; then the capability
H.hold.add("tasks.revoke");
const off = D.turnOff([A.task, B.task]);
ok(D.state() === "turning-off", "turning off: the state says so at once (the page disables its task actions)");
const n0 = sentTasks(H).length;
ok((await why(D.start({ title: "late", prompt: "p", docs: [], run: false }))) === "forbidden" && sentTasks(H).filter((m) => m.method === "tasks.start").length === 1, "a Start while it turns off: refused here, nothing sent");
await until(() => H.held.length === 2);
ok(H.grant?.delegate === true && H.held.map((m) => m.params.task).sort().join() === [A.task, B.task].sort().join(), "the chosen tasks' revokes are sent first, while the switch is still on", H.held.map((m) => m.params.task));
const failed = await off;
await until(() => H.grant?.delegate === undefined);
ok(failed.length === 2 && H.grant && H.grant.delegate === undefined && D.state() === "off" && D.tasks.length === 0, "revokes unanswered (timed out): reported, and the capability revoked anyway; no tasks shown", { failed, grant: H.grant });
const order = H.got.filter((m) => m.method === "tasks.revoke" || m.method === "grant.changed").map((m) => m.method === "grant.changed" ? (m.params.delegate ? "on" : "off") : "revoke");
ok(order.slice(-3).join() === "revoke,revoke,off", "on the wire: the revokes, then the grant without delegate", order);
ok((await why(D.start({ title: "t", prompt: "p", docs: [], run: false }))) === "forbidden" && sentTasks(H).filter((m) => m.method === "tasks.start").length === 1, "off: Start refused here, nothing sent");
H.hold.clear();
// (a refused revoke: the same)
D.turnOn();
await until(() => D.tasks.length > 0 && H.grant?.delegate === true);
H.fail.set("tasks.revoke", "final");
const f1 = await D.turnOff([C.task]);
await until(() => H.grant?.delegate === undefined);
ok(f1.join() === C.task && H.grant.delegate === undefined && D.state() === "off", "a revoke refused by the host: reported, the capability revoked anyway");
H.fail.clear();
// (nothing chosen: the capability only, and the host's tasks go on, interrupted, not closed)
const busy = await H.addTask({ title: "Busy" });
D.turnOn();
await until(() => D.tasks.length > 0 && H.grant?.delegate === true);
const working = [...H.tasks.values()].filter((t) => t.status === "working").map((t) => t.task);
const f0 = await D.turnOff([]);
await until(() => H.grant?.delegate === undefined);
ok(f0.length === 0 && H.grant.delegate === undefined && working.includes(busy.task) && working.every((t) => H.tasks.get(t).status === "interrupted"), "no task chosen: only the capability revoked; the host's running tasks are interrupted, not closed", working.map((t) => H.tasks.get(t).status));
P.revoke();
H.stop();

// ---- a disconnect during the off: the off ends, the revokes reported; a new pairing starts with the switch off
{
  const H2 = delegateHost();
  const T = await H2.addTask({ title: "x" });
  const D2 = new DelegateTasks({ changed: () => {}, closeMs: 5000 });
  const P2 = pairWith(H2);
  D2.attach(P2);
  await P2.paired();
  await P2.allow({ folders: ["/"], write: true, expires: null }, false);
  D2.turnOn();
  await until(() => D2.tasks.length === 1);
  H2.hold.add("tasks.revoke");
  const off2 = D2.turnOff([T.task]);
  await until(() => H2.held.length === 1);
  H2.sock.close();
  const t1 = Date.now();
  const f2 = await off2;
  ok(f2.join() === T.task && Date.now() - t1 < 2000 && D2.state() === "unoffered" && D2.tasks.length === 0, "the connection lost during the off: its revoke ends at once (reported), no tasks shown", { f2, state: D2.state(), ms: Date.now() - t1 });
  const seen = H2.changes.length;
  const P3 = pairWith(H2);
  D2.attach(P3);
  await P3.paired();
  await P3.allow({ folders: ["/"], write: true, expires: null }, false);
  await until(() => H2.changes.length > seen);
  ok(D2.state() === "off" && H2.grant && H2.grant.delegate === undefined, "a new pairing after it: the switch off, the host told so");
  P3.revoke();
  H2.stop();
}

// ---- a list answer older than an event (made before it, delivered after it): the higher seq wins, the task never
//      goes back
for (const [what, event, chip] of [["failed", { type: "task_status", status: "failed", reason: "new failure" }, "Failed"], ["closed", { type: "task_status", status: "closed" }, "Closed"]]) {
  const H5 = delegateHost();
  const T = await H5.addTask({ title: "x" });
  const D5 = new DelegateTasks({ changed: () => {} });
  const P5 = pairWith(H5);
  D5.attach(P5);
  await P5.paired();
  await P5.allow({ folders: ["/"], write: true, expires: null }, false);
  D5.turnOn();
  await until(() => D5.tasks.length === 1);
  // (the next tasks.list answer held back, as made, while a newer event goes out)
  const send = H5.sock.send.bind(H5.sock);
  let held = null;
  H5.sock.send = (data, ...a) => { if (!held && JSON.parse(data).result?.tasks) { held = data; return data.length; } return send(data, ...a); };
  const r = D5.refresh();
  await until(() => held !== null);
  const seq0 = JSON.parse(held).result.tasks[0].seq;
  H5.emit(T.task, event);
  await until(() => D5.task(T.task).entry.status === event.status);
  send(held);
  await r;
  const e = D5.task(T.task).entry;
  ok(seq0 === 1 && e.status === event.status && e.seq === 2 && chipOf(e) === chip, `a stale list (seq 1) after a newer event (seq 2, ${what}): the task stays ${chip}, seq 2`, { seq0, status: e.status, seq: e.seq });
  P5.revoke();
  H5.stop();
}

// ---- an agent that doesn't offer Delegate: no switch
{
  const H3 = delegateHost({ features: ["chat.resume"] });
  const D3 = new DelegateTasks({ changed: () => {} });
  const P4 = pairWith(H3);
  D3.attach(P4);
  await P4.paired();
  await P4.allow({ folders: ["/"], write: true, expires: null }, false);
  ok(D3.state() === "unoffered" && D3.turnOn() === false && H3.changes.every((g) => !g?.delegate), "an agent whose hello doesn't list delegate.1: not offered, the switch can't be turned on");
  P4.revoke();
  H3.stop();
}
ok(DELEGATE_TEXT.chip.question === "Question" && chipOf({ status: "working", question: true }) === "Question", "a working task waiting for an answer: its chip says Question");

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
