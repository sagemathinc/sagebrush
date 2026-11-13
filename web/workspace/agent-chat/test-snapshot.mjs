// ci: web-runner order=374 runner=bun
// A conversation's snapshot to share (web/workspace/agent-chat/snapshot.ts): only the person's sent messages and the
// text of finished agent turns go in; notes, queued messages, a running turn, thinking, tool calls, cards and
// artifacts stay out; a snapshot over a limit is refused, never cut; and validSnapshot, which the share server copies,
// takes exactly that shape.
//   bun web/workspace/agent-chat/test-snapshot.mjs
const { snapshotOf, validSnapshot, SNAPSHOT_LIMITS } = await import("./snapshot.ts");

const results = [];
const check = (ok, what, detail) => { results.push([!!ok, what]); if (!ok) console.log("FAIL", what, JSON.stringify(detail)?.slice(0, 500)); };

const user = (text, mode = "sent") => ({ kind: "user", id: "u" + Math.random(), text, mode, time: 1 });
const turn = (parts, o = {}) => ({ kind: "turn", turn_id: "t" + Math.random(), state: "completed", parts, tools: {}, attention: {}, started: 1, ...o });
const msg = (text) => ({ kind: "message", id: "m", revision: 1, text, truncated: false });
const thread = (entries, title = "Fourier series") => ({ id: "th", title, entries, artifacts: [], applied_seq: 0 });
const NOW = new Date("2026-11-13T06:30:00.000Z");

// what goes in, and what stays out
{
  const t = thread([
    user("Plot $\\sin x$"),
    turn([{ kind: "thinking", text: "SECRET THINKING" }, msg("Here is the plot:"), { kind: "tool", call: "c1" }, { kind: "attention", id: "a1" }, { kind: "artifact", id: "x.ipynb" }, msg("```python\nplot(sin)\n```")], { agent: "Claude", tools: { c1: { output: "SECRET TOOL OUTPUT" } } }),
    user("a private note", "note"),
    user("waiting", "queued"),
    turn([msg("still going")], { state: "running", agent: "Claude" }),
  ]);
  const r = snapshotOf(t, NOW);
  check(r.ok, "a thread with messages: a snapshot", r);
  const s = r.snapshot;
  check(s.v === 1 && s.title === "Fourier series" && s.created === "2026-11-13T06:30:00.000Z", "v 1, the thread's title, the ISO time it was made", s);
  check(JSON.stringify(s.messages) === JSON.stringify([{ role: "user", text: "Plot $\\sin x$" }, { role: "agent", name: "Claude", text: "Here is the plot:\n\n```python\nplot(sin)\n```" }]), "the sent message, then the finished turn's text parts joined, named by the agent", s.messages);
  for (const secret of ["SECRET THINKING", "SECRET TOOL OUTPUT", "a private note", "waiting", "still going", "x.ipynb", "a1", "c1"]) check(!r.json.includes(secret), `left out: ${secret}`);
  check(JSON.parse(r.json).messages.length === 2 && r.bytes === new TextEncoder().encode(r.json).length, "the JSON is the snapshot, and bytes counts its UTF-8");
  check(validSnapshot(r.json), "what it makes is valid");
}

// a scripted turn has no agent name: none is made up
{
  const r = snapshotOf(thread([user("hi"), turn([msg("hello")])]), NOW);
  check(r.ok && !("name" in r.snapshot.messages[1]), "a turn without an agent name: no name", r.snapshot?.messages);
}

// nothing to share
{
  check(snapshotOf(thread([]), NOW).why === "empty", "an empty thread: refused, empty");
  check(snapshotOf(thread([user("n", "note"), turn([msg("x")], { state: "running" }), turn([{ kind: "thinking", text: "t" }])]), NOW).why === "empty", "only notes, a running turn and a turn with no text: refused, empty");
  check(snapshotOf(thread([user("   ")]), NOW).why === "empty", "a blank message doesn't count");
  check(snapshotOf(thread([user("hi")], "  "), NOW).snapshot?.title === "Conversation", "a blank title: \"Conversation\"");
}

// over a limit: refused, never cut
{
  const big = "é".repeat(Math.ceil(SNAPSHOT_LIMITS.bytes / 2) + 10);
  const r = snapshotOf(thread([user(big)]), NOW);
  check(!r.ok && r.why === "bytes" && r.bytes > SNAPSHOT_LIMITS.bytes, "over 1 MB as UTF-8 (two bytes per é): refused, with its size", { why: r.why, bytes: r.bytes });
  const justUnder = snapshotOf(thread([user("a".repeat(SNAPSHOT_LIMITS.bytes - 200))]), NOW);
  check(justUnder.ok && justUnder.bytes <= SNAPSHOT_LIMITS.bytes, "just under 1 MB: a snapshot", justUnder.bytes);
  const many = thread(Array.from({ length: SNAPSHOT_LIMITS.messages + 1 }, (_, i) => user("m" + i)));
  const m = snapshotOf(many, NOW);
  check(!m.ok && m.why === "messages" && m.count === SNAPSHOT_LIMITS.messages + 1, "2,001 messages: refused, with the count", m);
  check(snapshotOf(thread(Array.from({ length: SNAPSHOT_LIMITS.messages }, (_, i) => user("m" + i))), NOW).ok, "2,000 messages: a snapshot");
  check(snapshotOf(thread([user("x")], "t".repeat(SNAPSHOT_LIMITS.title + 1)), NOW).why === "title", "a title over 200 characters: refused");
  check(snapshotOf(thread([user("x"), turn([msg("y")], { agent: "n".repeat(SNAPSHOT_LIMITS.name + 1) })]), NOW).why === "name", "an agent name over 80 characters: refused");
}

// validSnapshot: exactly the shape, within the limits
{
  const ok = { v: 1, title: "t", created: "2026-11-13T06:30:00.000Z", messages: [{ role: "user", text: "a" }, { role: "agent", name: "Claude", text: "b" }] };
  const j = (o) => JSON.stringify(o);
  check(validSnapshot(j(ok)), "a well-formed snapshot is valid");
  check(validSnapshot(j({ ...ok, created: "2026-11-13T06:30:00Z" })), "an ISO time without milliseconds is valid");
  const bad = [
    ["not JSON", "{"], ["an array", "[]"], ["v 2", j({ ...ok, v: 2 })], ["an extra key", j({ ...ok, html: "<b>x</b>" })], ["no messages", j({ v: 1, title: "t", created: ok.created })],
    ["a title over 200", j({ ...ok, title: "t".repeat(201) })], ["a time that isn't ISO", j({ ...ok, created: "yesterday" })], ["a time that isn't a date", j({ ...ok, created: "2026-13-45T99:99:99Z" })],
    ["a role other than user or agent", j({ ...ok, messages: [{ role: "system", text: "x" }] })], ["text that isn't a string", j({ ...ok, messages: [{ role: "user", text: 5 }] })],
    ["a message key other than role, name and text", j({ ...ok, messages: [{ role: "user", text: "x", html: "<i>" }] })], ["a name over 80", j({ ...ok, messages: [{ role: "agent", name: "n".repeat(81), text: "x" }] })],
    ["a message without text", j({ ...ok, messages: [{ role: "user" }] })], ["2,001 messages", j({ ...ok, messages: Array.from({ length: 2001 }, () => ({ role: "user", text: "x" })) })],
    ["over 1 MB", j({ ...ok, messages: [{ role: "user", text: "x".repeat(SNAPSHOT_LIMITS.bytes) }] })],
  ];
  for (const [what, text] of bad) check(!validSnapshot(text), `invalid: ${what}`);
}

const failed = results.filter(([ok]) => !ok).length;
console.log(failed ? `test-snapshot: ${failed} failed` : `ok: a conversation's snapshot, ${results.length} checks`);
process.exit(failed ? 1 : 0);
