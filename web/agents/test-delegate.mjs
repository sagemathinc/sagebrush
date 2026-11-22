// ci: web-runner order=176 runner=bun
// The Agents page's Delegate tasks (delegate.ts) over a real pairing (agent-pair.ts) to a stand-in host
// (test-delegate-host.mjs): the switch, the list and its chips, a task's thread read page by page and moved on by
// task.event, an event the page refuses skipped, Start, the switch's off (the chosen tasks closed first, each failure,
// timeout or disconnect never stopping the capability's revoke; Start refused from its first moment), and a proposal's
// files checked against their blob ids.
//   bun web/agents/test-delegate.mjs
import { AgentPairing } from "../workspace/agent-pair.ts";
import { DelegateTasks, chipOf, currentOf, DELEGATE_TEXT, DELEGATE_LIMITS } from "./delegate.ts";
import { delegateHost } from "./test-delegate-host.mjs";
import { isDone, mergedParams, newRecord, prepare, run } from "./delegate-merge.ts";

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

// ---- Ask for changes (S3 P2): the note and the person's current versions back to the same task; its next round
{
  const asks = () => sentTasks(H).filter((m) => m.method === "tasks.ask").length;
  const commit1 = tA().proposal.commit;
  ok((await why(D.ask(A.task, { proposal: commit1, seq: 0, note: "   ", current: [] }))) === "bad_request" && asks() === 0, "an empty note: refused here, nothing sent");
  ok((await why(D.ask(A.task, { proposal: commit1, seq: 0, note: "x".repeat(DELEGATE_LIMITS.noteBytes + 1), current: [] }))) === "too_large" && asks() === 0, "a note over 16 KB: refused here, nothing sent");
  ok((await why(D.ask(A.task, { proposal: "f".repeat(40), seq: 0, note: "more", current: [] }))) === "stale" && asks() === 0, "a proposal that isn't the task's latest: refused here (stale), nothing sent");
  ok((await why(D.ask(A.task, { proposal: commit1, seq: 0, note: "more", current: [{ path: "work/notes.txt", kind: "file", content: "x".repeat(4 * 2 ** 20 + 1) }] }))) === "too_large" && asks() === 0, "a current version over 4 MB: refused here, by name, nothing sent");
  // (the current versions: the task's own files only, as the workspace has them; one gone is left out)
  const files = [{ path: "work/a.ipynb", change: "modified" }, { path: "work/new.txt", change: "added" }, { path: "work/notes.txt", change: "modified" }];
  const read = async (path) => { if (path === "work/notes.txt") throw new Error("gone"); return { path, kind: path.endsWith(".ipynb") ? "notebook" : "file", content: "mine of " + path }; };
  const current = await currentOf(files, read);
  ok(current.map((d) => d.path).join() === "work/a.ipynb" && current[0].content === "mine of work/a.ipynb", "the current versions: the task's own files (not one the agent added), one gone from the workspace left out", current.map((d) => d.path));
  const src = D.source(A.task, commit1);
  await src.diff();
  const seq = src.seen().seq;
  const r = await D.ask(A.task, { proposal: commit1, seq, note: "  Also a line at the top.\n", current });
  const sent = sentTasks(H).findLast((m) => m.method === "tasks.ask")?.params;
  ok(r.status === "working" && sent?.task === A.task && sent.proposal === commit1 && sent.seq === seq && sent.note === "Also a line at the top." && sent.current.length === 1 && H.asks.length === 1, "Ask for changes: tasks.ask with the proposal, the task's seq, the note (trimmed) and the current versions", sent);
  ok(chipOf(tA().entry) === "Working", "the chip back to Working at once", chipOf(tA().entry));
  await until(() => tA().entry.seq > seq);
  ok((await why(D.ask(A.task, { proposal: commit1, seq, note: "again", current: [] }))) === "stale" && asks() === 1, "asked again on the same proposal, now moved on: refused (stale), said as such", asks());
  ok((await D.ask(A.task, { proposal: commit1, seq, note: "again", current: [] }).catch((e) => e.message)) === DELEGATE_TEXT.askMoved, "its words: open the latest proposal");
  // (the next round, from the agent: the chip Proposal ready again, with round 2's commit)
  const commit2 = await H.propose(A.task, { "work/notes.txt": "top\none\ntwo\n" });
  await until(() => tA().entry.proposal === commit2 && tA().entry.status === "proposal");
  ok(tA().entry.proposal === commit2 && tA().entry.round === 2 && chipOf(tA().entry) === "Proposal ready", "round 2: the chip Proposal ready again, the task's proposal now round 2's commit", { round: tA().entry.round, chip: chipOf(tA().entry) });
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

// ---- a tasks.get answer older than an event (made before it, delivered after it): its older events go into the
//      thread, never back into the chip; a fresh list at the same seq then keeps the newer status
for (const [what, event, chip] of [["failed", { type: "task_status", status: "failed", reason: "new failure" }, "Failed"], ["closed", { type: "task_status", status: "closed" }, "Closed"]]) {
  const H6 = delegateHost();
  const T = await H6.addTask({ title: "x" });
  const D6 = new DelegateTasks({ changed: () => {} });
  const P6 = pairWith(H6);
  D6.attach(P6);
  await P6.paired();
  await P6.allow({ folders: ["/"], write: true, expires: null }, false);
  D6.turnOn();
  await until(() => D6.tasks.length === 1);
  const send = H6.sock.send.bind(H6.sock);
  let held = null;
  H6.sock.send = (data, ...a) => { if (!held && JSON.parse(data).result?.events) { held = data; return data.length; } return send(data, ...a); };
  const r = D6.open(T.task);
  await until(() => held !== null);
  const seq0 = JSON.parse(held).result.task.seq;
  H6.emit(T.task, event);
  await until(() => D6.task(T.task).entry.status === event.status);
  send(held);
  await r.catch(() => {});
  const e1 = D6.task(T.task).entry;
  ok(seq0 === 1 && e1.status === event.status && e1.seq === 2 && D6.task(T.task).thread.applied_seq >= 1, `a stale tasks.get (seq 1) after a newer event (seq 2, ${what}): its events go into the thread, the task stays ${chip}, seq 2`, { seq0, status: e1.status, seq: e1.seq });
  H6.sock.send = send;
  await D6.refresh();
  const e2 = D6.task(T.task).entry;
  ok(e2.status === event.status && e2.seq === 2 && chipOf(e2) === chip, `then a fresh list at the same seq (2): still ${chip}, seq 2`, { status: e2.status, seq: e2.seq });
  P6.revoke();
  H6.stop();
}
// (a replay at the chip's own seq fills in what is missing: the proposal's files, when the list named only its commit)
{
  const H7 = delegateHost();
  const T = await H7.addTask({ title: "x" });
  const commit = "c".repeat(40);
  H7.emit(T.task, { type: "proposal", round: 1, base: T.base, commit, files: [] });
  const D7 = new DelegateTasks({ changed: () => {} });
  const P7 = pairWith(H7);
  D7.attach(P7);
  await P7.paired();
  await P7.allow({ folders: ["/"], write: true, expires: null }, false);
  D7.turnOn();
  await until(() => D7.tasks.length === 1);
  const t0 = D7.task(T.task);
  const before = { proposal: t0.proposal, entry: t0.entry.proposal, seq: t0.entry.seq };
  await D7.open(T.task);
  const t1 = D7.task(T.task);
  ok(before.proposal === null && before.entry === commit && before.seq === 2 && t1.proposal?.commit === commit && t1.entry.seq === 2 && t1.entry.status === "working", "a replay at the chip's seq (the proposal event, seq 2): the proposal's details filled in, the status and seq kept", { before, after: { proposal: t1.proposal?.commit, seq: t1.entry.seq, status: t1.entry.status } });
  P7.revoke();
  H7.stop();
}

// ---- Close (tasks.close {proposal, seq}): the proposal as it was read; a task that moved on since is refused (stale)
{
  const H8 = delegateHost();
  const T1 = await H8.addTask({ title: "one", base: { "a.txt": "x\n" }, proposal: { "a.txt": "y\n" } });
  const T2 = await H8.addTask({ title: "two", base: { "a.txt": "x\n" }, proposal: { "a.txt": "z\n" } });
  const D8 = new DelegateTasks({ changed: () => {} });
  const P8 = pairWith(H8);
  D8.attach(P8);
  await P8.paired();
  await P8.allow({ folders: ["/"], write: true, expires: null }, false);
  ok((await why(D8.close(T1.task, T1.proposal, 1))) === "forbidden" && !H8.got.some((m) => m.method === "tasks.close"), "Close with the switch off: refused here, nothing sent");
  D8.turnOn();
  await until(() => D8.tasks.length === 2);
  const s1 = D8.source(T1.task, T1.proposal);
  ok(s1.seen() === null, "a proposal not read yet has no seq to close it with");
  await s1.diff();
  ok(s1.seen()?.seq === T1.log.length, "read: the seq it was read at, the task's", { seen: s1.seen(), log: T1.log.length });
  ok((await D8.close(T1.task, T1.proposal, s1.seen().seq)) === "closed", "Close: tasks.close answered closed");
  const sent = H8.got.findLast((m) => m.method === "tasks.close")?.params;
  ok(sent && sent.task === T1.task && sent.proposal === T1.proposal && sent.seq === s1.seen().seq && Object.keys(sent).length === 3, "it names the task, the proposal commit and the seq it was read at, nothing else", sent);
  await until(() => D8.task(T1.task)?.entry.status === "closed");
  ok(chipOf(D8.task(T1.task).entry) === "Closed", "its chip: Closed");
  // (the task moves on after the proposal was read: Close refused, nothing closed)
  const s2 = D8.source(T2.task, T2.proposal);
  await s2.diff();
  H8.emit(T2.task, { type: "turn_started" });
  ok((await why(D8.close(T2.task, T2.proposal, s2.seen().seq))) === "stale" && H8.tasks.get(T2.task).status === "proposal", "a task that moved on since it was read: refused (stale), not closed");
  P8.revoke();
  H8.stop();
}

// ---- Merge's record at the agent (tasks.merged): from the proposal as read; idempotent by merge_id
{
  const H9 = delegateHost();
  const T = await H9.addTask({ title: "merge", base: { "a.txt": "x\nb\nc\n" }, proposal: { "a.txt": "y\nb\nc\n" } });
  const U = await H9.addTask({ title: "moved", base: { "a.txt": "x\nb\nc\n" }, proposal: { "a.txt": "z\nb\nc\n" } });
  const D9 = new DelegateTasks({ changed: () => {} });
  const P9 = pairWith(H9);
  D9.attach(P9);
  await P9.paired();
  await P9.allow({ folders: ["/"], write: true, expires: null }, false);
  const mine = { "a.txt": { id: { kind: "file", fid: "f1", created: 1, ref: null }, rev: 1, text: "x\nb\nc\nmine\n" } };
  const io = { async mine(p) { return mine[p] ? { ...mine[p] } : null; }, async write(p, k, text, at) { mine[p] = { ...at, rev: at.rev + 1, text }; return at.id; }, async create() { throw new Error("no"); }, async remove() {}, async load() {}, async save() {}, merged: (t, p) => D9.merged(t, p) };
  const params = { task: T.task, proposal: T.proposal, seq: 1, merge_id: "a".repeat(32), files: [] };
  ok((await why(D9.merged(T.task, params))) === "forbidden" && !H9.got.some((m) => m.method === "tasks.merged"), "tasks.merged with the switch off: refused here, nothing sent");
  D9.turnOn();
  await until(() => D9.tasks.length === 2);
  const src = D9.source(T.task, T.proposal);
  await src.diff();
  const seen = src.seen();
  ok(seen.base === T.base && seen.commit === T.proposal && seen.files.length === 1, "a proposal read: its base, commit and files, for the decision", seen);
  const pin = { task: T.task, base: seen.base, proposal: seen.commit, seq: seen.seq, files: seen.files };
  const plans = await prepare(io, src, pin);
  const rec = await run(io, newRecord(pin, plans, {}));
  ok(isDone(rec) && mine["a.txt"].text === "y\nb\nc\nmine\n" && H9.got.filter((m) => m.method === "tasks.file").length === 2, "Merge through the page's source: both sides read and checked, the person's file written", mine["a.txt"]);
  const req = await mergedParams(rec);
  const r1 = await D9.merged(T.task, req);
  ok(r1.recorded === "merge" && /^[0-9a-f]{40}$/.test(r1.commit), "tasks.merged with every file in full: recorded as a merge, its commit", r1);
  await until(() => D9.task(T.task)?.entry.status === "merged");
  ok(chipOf(D9.task(T.task).entry) === "Merged", "after it is recorded, the chip says Merged");
  const r2 = await D9.merged(T.task, await mergedParams(rec));
  ok(JSON.stringify(r2) === JSON.stringify(r1) && H9.tasks.get(T.task).log.filter((e) => e.event.status === "merged").length === 1, "a retry after a lost answer (the same merge_id, the same bytes): the same answer, recorded once");
  ok((await why(D9.merged(T.task, { ...req, files: req.files.map((f) => ({ ...f, merged: { absent: true } })) }))) === "conflict", "the same merge_id with another request: refused (conflict)");
  ok((await why(D9.merged(T.task, { ...req, merge_id: "b".repeat(32) }))) === "final", "a new merge_id for a task already merged: refused (final)");
  // (the task moved on after its proposal was read: a decision on it refused)
  mine["a.txt"].text = "x\nb\nc\nmine\n";
  const su = D9.source(U.task, U.proposal);
  await su.diff();
  const pu = { task: U.task, base: U.base, proposal: U.proposal, seq: su.seen().seq, files: su.seen().files };
  H9.emit(U.task, { type: "turn_started" });
  ok((await why(D9.merged(U.task, await mergedParams(newRecord(pu, await prepare(io, su, pu), {}))))) === "stale", "a decision on a proposal the task moved on from: refused (stale)");
  ok((await why(D9.merged(U.task, { ...req }))) === "bad_request", "a request for another task than named: refused here");
  P9.revoke();
  H9.stop();
}

// ---- Delegate briefs (chat.brief): only to an agent that lists it, with the switch on; its answer checked; cancel
{
  const conv = "c".repeat(32);
  const brief = { title: "Plot sin(x)", brief: "Goal\nPlot sin(x)", bytes: 17, cut: false };
  // (an agent without chat.brief: not offered, nothing sent)
  const H0 = delegateHost();
  const D0 = new DelegateTasks({ changed: () => {} });
  const P0 = pairWith(H0);
  D0.attach(P0);
  await P0.paired();
  await P0.allow({ folders: ["/"], write: true, expires: null }, false);
  D0.turnOn();
  await until(() => H0.grant?.delegate === true);
  ok(!D0.briefOffered() && (await why(D0.brief(conv))) === "unavailable" && !H0.got.some((m) => m.method === "chat.brief"), "an agent without chat.brief: briefs not offered, refused here, nothing sent");
  P0.revoke();
  H0.stop();
  const HB = delegateHost({ features: ["delegate.1", "chat.resume", "chat.brief"] });
  const DB = new DelegateTasks({ changed: () => {} });
  const PB = pairWith(HB);
  DB.attach(PB);
  await PB.paired();
  await PB.allow({ folders: ["/"], write: true, expires: null }, false);
  ok(!DB.briefOffered() && (await why(DB.brief(conv))) === "unavailable", "chat.brief listed but the switch off: not offered");
  DB.turnOn();
  await until(() => HB.grant?.delegate === true);
  HB.briefs.set(conv, brief);
  const r = await DB.brief(conv);
  const sent = HB.got.findLast((m) => m.method === "chat.brief")?.params;
  ok(DB.briefOffered() && JSON.stringify(r) === JSON.stringify({ title: brief.title, brief: brief.brief, cut: false }) && JSON.stringify(sent) === JSON.stringify({ conversation: conv }), "chat.brief {conversation}: its title, brief and cut", { r, sent });
  for (const [bad, what] of [[{ ...brief, title: "" }, "an empty title"], [{ ...brief, title: "t".repeat(201) }, "a title over 200 characters"], [{ ...brief, extra: 1 }, "an unknown field"], [{ ...brief, brief: "x\u0000" }, "a NUL in the brief"], [{ ...brief, cut: "no" }, "cut not true or false"]]) {
    HB.briefs.set(conv, bad);
    ok((await why(DB.brief(conv))) !== "resolved", `an answer with ${what}: refused`);
  }
  HB.briefs.set(conv, { error: "busy" });
  ok((await why(DB.brief(conv))) === "busy", "the agent's refusal (busy): its code");
  HB.briefs.set(conv, brief);
  HB.hold.add("chat.brief");
  const held = why(DB.brief(conv));
  await until(() => HB.held.some((m) => m.method === "chat.brief"));
  DB.cancelBrief(conv);
  ok((await held) === "stopped" && JSON.stringify(HB.got.findLast((m) => m.method === "chat.brief_cancel")?.params) === JSON.stringify({ conversation: conv }), "cancelBrief: chat.brief_cancel {conversation}; the held draft answered stopped");
  HB.hold.clear();
  PB.revoke();
  HB.stop();
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
