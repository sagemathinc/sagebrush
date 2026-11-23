// ci: web-runner order=171 runner=bun
// web/workspace/tasks-schema.ts: the page's checks of what a Delegate host sends (design/workspace-agent-protocol.md
// §6.1), against a real host's recorded answers and events (tasks-fixtures.json, made by gen-tasks-fixtures.mjs from
// sagebrush-agent's fake-tasks: its real task store), and each answer altered in the ways §6.1 refuses.
//   bun web/workspace/test-tasks-schema.mjs
import { readFileSync } from "node:fs";
import { TASK_RESULTS, TaskShapeError, taskNotification, taskEvent, taskLog, taskNotice, blobId, contentBytes } from "./tasks-schema.ts";

const F = JSON.parse(readFileSync(new URL("./tasks-fixtures.json", import.meta.url), "utf8"));
let checks = 0;
const fails = [];
const ok = (c, what, got) => { checks++; if (!c) fails.push(`${what}${got === undefined ? "" : `  ${JSON.stringify(got).slice(0, 300)}`}`); };
const refused = (f) => { try { f(); return false; } catch (e) { return e instanceof TaskShapeError; } };
const clone = (v) => JSON.parse(JSON.stringify(v));
// (event kinds an earlier host emitted that §6.1 doesn't list: the host no longer emits them (A1 4f2ce4d2), and the page
//  refuses them, as any unlisted kind)
const NOT_IN_P0 = new Set(["ask", "merge_receipt", "merged"]);

// ---- every answer the real host gave is accepted, and each file's bytes have the blob id it says
const results = F.answers.filter((a) => a.answer.result !== undefined);
ok(results.length >= 15 && F.answers.some((a) => a.answer.error), "the fixture: a whole task's answers, and some refusals", F.answers.length);
// (a tasks.get answer holding an event kind §6.1 doesn't list yet is refused whole, as any unknown kind is)
const pending = (a) => a.method === "tasks.get" && a.answer.result.events.some((e) => NOT_IN_P0.has(e.event.type));
for (const a of results) {
  let why = null;
  try { TASK_RESULTS[a.method](a.answer.result); } catch (e) { why = e.message; }
  ok(pending(a) ? why !== null : why === null, `the host's ${a.method} answer is ${pending(a) ? "refused (an event kind not in §6.1 yet)" : "accepted"}`, why);
}
for (const a of results.filter((x) => x.method === "tasks.file")) {
  const r = TASK_RESULTS["tasks.file"](a.answer.result);
  ok((await blobId(contentBytes(r.content))) === r.blob, `tasks.file ${a.params.path}: the git blob id of its content is the blob it names`);
}
ok((await blobId(new TextEncoder().encode("hello\n"))) === "ce013625030ba8dba906f756967f9e9ca394464a", "blobId is git's (git hash-object of \"hello\\n\")");
for (const n of F.notifications) {
  const known = !NOT_IN_P0.has(n.event.type);
  ok(known ? !refused(() => taskNotification(n)) : refused(() => taskNotification(n)), `task.event ${n.event.type}: ${known ? "accepted" : "refused until §6.1 lists it"}`, n.event.type);
}
// (the events inside tasks.get answers too)
for (const a of results.filter((x) => x.method === "tasks.get")) for (const e of a.answer.result.events.filter((x) => !NOT_IN_P0.has(x.event.type))) ok(!refused(() => taskEvent(e.event)), `tasks.get's ${e.event.type} event accepted`);

// ---- each kind of answer, altered as §6.1 refuses
const pick = (m) => clone(results.find((a) => a.method === m).answer.result);
const alter = (m, what, f) => { const v = pick(m); f(v); ok(refused(() => TASK_RESULTS[m](v)), `${m}: ${what}: refused`); };
alter("tasks.start", "an unknown field", (v) => { v.extra = 1; });
alter("tasks.start", "a missing field", (v) => { delete v.base; });
alter("tasks.start", "a task id not 32 lowercase hex", (v) => { v.task = v.task.toUpperCase(); });
alter("tasks.start", "a base not 40 hex", (v) => { v.base = v.base.slice(1); });
alter("tasks.start", "a seq that isn't an integer", (v) => { v.seq = 1.5; });
alter("tasks.list", "more than 64 tasks", (v) => { v.tasks = Array.from({ length: 65 }, () => v.tasks[0]); });
alter("tasks.list", "a status not in §6.1", (v) => { v.tasks[0].status = "done"; });
alter("tasks.list", "a target not local", (v) => { v.tasks[0].target = "remote"; });
alter("tasks.list", "a title over 200 characters", (v) => { v.tasks[0].title = "x".repeat(201); });
alter("tasks.list", "an entry with a field more", (v) => { v.tasks[0].secret = "x"; });
alter("tasks.get", "events out of seq order", (v) => { v.events = [...v.events].reverse(); if (v.events.length < 2) v.events.push(v.events[0]); });
alter("tasks.get", "an event of no listed kind", (v) => { v.events[0].event = { type: "shell", cmd: "rm -rf /" }; });
alter("tasks.get", "reset not a boolean", (v) => { v.reset = "no"; });
alter("tasks.diff", "a path with .. (on a text file, so only the path rule can refuse it)", (v) => { v.files.find((x) => x.kind === "file").path = "../escape.txt"; });
alter("tasks.diff", "an absolute path", (v) => { v.files.find((x) => x.kind === "file").path = "/etc/passwd.txt"; });
alter("tasks.diff", "a .git component (any case)", (v) => { v.files.find((x) => x.kind === "file").path = "work/.GIT/config.txt"; });
alter("tasks.diff", "a backslash or a drive", (v) => { v.files.find((x) => x.kind === "file").path = "C:\\work\\x.txt"; });
alter("tasks.diff", "an empty component", (v) => { v.files.find((x) => x.kind === "file").path = "work//x.txt"; });
// (§6.1's path rules in full, each on the text file's entry, so only the path rule can refuse it; and in a proposal event too)
const PATHS_REFUSED = [
  ["a Windows reserved name", "work/NUL.txt"], ["a reserved name with a superscript digit", "work/COM\u00b9.txt"], ["an embedded NUL", "work/a\u0000b.txt"],
  ["a control character", "work/a\u0007.txt"], ["a component over 255 bytes", "work/" + "x".repeat(252) + ".txt"], ["a component ending in a dot", "work./a.txt"],
  ["a component ending in a space", "work /a.txt"], ["a lone surrogate", "work/a\ud800.txt"], ["a lone low surrogate", "work/\udc00a.txt"], ["a .sagebrush component", ".sagebrush/a.txt"],
  ["a colon (an alternate stream)", "work/a.txt:x.txt"], ["a path over 1,024 bytes", ("d/").repeat(520) + "a.txt"],
];
for (const [what, p] of PATHS_REFUSED) {
  alter("tasks.diff", `${what}`, (v) => { v.files.find((x) => x.kind === "file").path = p; });
  const e = clone(F.notifications.find((n) => n.event.type === "proposal").event);
  e.files.find((x) => x.kind === "file").path = p;
  ok(refused(() => taskEvent(e)), `a proposal event: ${what}: refused`);
}
ok(!refused(() => TASK_RESULTS["tasks.diff"]({ ...pick("tasks.diff"), files: pick("tasks.diff").files.map((f) => (f.kind === "file" ? { ...f, path: "work/" + "x".repeat(251) + ".txt" } : f)) })), "a component of exactly 255 bytes: accepted");
ok(!refused(() => TASK_RESULTS["tasks.diff"]({ ...pick("tasks.diff"), files: pick("tasks.diff").files.map((f) => (f.kind === "file" ? { ...f, path: "work/\ud83d\ude00 notes.txt" } : f)) })), "a well-formed pair (an emoji) and an inner space: accepted");
alter("tasks.diff", "a path that is also another's folder", (v) => { const f = v.files.find((x) => x.kind === "file"); v.files.push({ ...f, path: f.path + "/inner.txt" }); });
alter("tasks.diff", "a notebook kind on a .txt", (v) => { const f = v.files.find((x) => x.kind === "file"); f.kind = "notebook"; });
alter("tasks.diff", "a change whose blobs don't match it (added with a base)", (v) => { v.files[0].change = "added"; });
alter("tasks.diff", "a path twice (case aside)", (v) => { v.files.push({ ...v.files[0], path: v.files[0].path.toUpperCase().replace(".IPYNB", ".ipynb").replace(".TXT", ".txt") }); });
// (the 4 MiB content bound: text by its UTF-8 bytes, base64 by its decoded bytes, at the boundary)
const D = 4 * 2 ** 20;
const fileWith = (c) => ({ ...pick("tasks.file"), content: c });
ok(!refused(() => TASK_RESULTS["tasks.file"](fileWith("x".repeat(D)))), "tasks.file: text of exactly 4 MiB: accepted");
ok(refused(() => TASK_RESULTS["tasks.file"](fileWith("x".repeat(D + 1)))), "tasks.file: text one byte over 4 MiB: refused");
ok(refused(() => TASK_RESULTS["tasks.file"](fileWith("\u00e9".repeat(D / 2 + 1)))), "tasks.file: text under 4 Mi characters but over 4 MiB in UTF-8 (é): refused");
const b64 = (n) => { const full = Math.floor(n / 3), rem = n % 3; return "A".repeat(full * 4) + (rem === 1 ? "AA==" : rem === 2 ? "AAA=" : ""); };
ok(!refused(() => TASK_RESULTS["tasks.file"](fileWith({ base64: b64(D) }))), "tasks.file: base64 of exactly 4 MiB decoded: accepted");
ok(refused(() => TASK_RESULTS["tasks.file"](fileWith({ base64: b64(D + 1) }))), "tasks.file: base64 of 4 MiB + 1 decoded: refused");
alter("tasks.file", "content neither text nor {base64}", (v) => { v.content = { bytes: [1, 2] }; });
alter("tasks.file", "base64 that isn't", (v) => { v.content = { base64: "@@@=" }; });
alter("tasks.merged", "a merge without its commit", (v) => { v.recorded = "merge"; v.commit = null; });
alter("tasks.merged", "a receipt with a commit", (v) => { v.recorded = "receipt"; v.commit = "a".repeat(40); });
alter("tasks.ask", "a round below 0", (v) => { v.round = -1; });
alter("tasks.revoke", "a status not in §6.1", (v) => { v.status = "revoked"; });
ok(refused(() => TASK_RESULTS["tasks.answer"]({ accepted: true })), "tasks.answer: a missing field: refused");
ok(refused(() => TASK_RESULTS["tasks.list"](Object.assign(Object.create({ polluted: 1 }), { tasks: [] }))), "a result that isn't a plain object: refused");
ok(refused(() => TASK_RESULTS["tasks.list"](JSON.parse('{"tasks": [], "__proto__": {"x": 1}}'))), "a result with an own __proto__ field: refused (an unknown field)");

ok(!F.notifications.some((n) => NOT_IN_P0.has(n.event.type)), "the recorded host emits only §6.1's event kinds");
for (const k of NOT_IN_P0) ok(refused(() => taskEvent({ type: k, proposal: "a".repeat(40), merge_id: "b".repeat(32) })), `an event of kind ${k} (not in §6.1): refused`);

// ---- task events, altered
const prop = clone(F.notifications.find((n) => n.event.type === "proposal").event);
ok(!refused(() => taskEvent(prop)), "a proposal event accepted");
ok(refused(() => taskEvent({ ...prop, round: 0 })), "a proposal of round 0: refused (a proposal's round is at least 1)");
ok(refused(() => taskEvent({ ...prop, extra: true })), "a proposal with a field more: refused");
// (the bound is the agent's own for a reason, in its state and its events: 2000 UTF-8 bytes, sagebrush-agent's wellText)
ok(!refused(() => taskEvent({ type: "task_status", status: "failed", reason: "x" })) && !refused(() => taskEvent({ type: "task_status", status: "failed", reason: "x".repeat(2000) })) && refused(() => taskEvent({ type: "task_status", status: "failed", reason: "x".repeat(2001) })), "task_status: a reason within its bound (2000 bytes, the agent's), and over it refused");
ok(!refused(() => taskEvent({ type: "task_status", status: "failed", reason: "界".repeat(666) })) && refused(() => taskEvent({ type: "task_status", status: "failed", reason: "界".repeat(667) })), "task_status: the bound in UTF-8 bytes: 666 three-byte characters (1998 bytes) taken, 667 (2001 bytes) refused");
const q = { type: "question", qid: 1, revision: 2, text: "Which?", blocking: true, choices: ["a", "b"] };
ok(!refused(() => taskEvent(q)) && refused(() => taskEvent({ ...q, revision: 0 })) && refused(() => taskEvent({ ...q, choices: Array(17).fill("c") })) && refused(() => taskEvent({ ...q, blocking: "yes" })), "question: accepted; revision 0, 17 choices, or a blocking that isn't a boolean refused");
ok(!refused(() => taskEvent({ type: "question_answered", qid: 1, revision: 2, answer_id: "b".repeat(32), current: false })) && refused(() => taskEvent({ type: "question_answered", qid: 1, revision: 2, answer_id: "B".repeat(32), current: false })), "question_answered: accepted; an answer_id not lowercase hex refused");
// (every text field well formed: a lone surrogate refused in each)
const LONE = "a\ud800b";
ok(refused(() => TASK_RESULTS["tasks.file"](fileWith(LONE))), "tasks.file: content with a lone surrogate: refused");
alter("tasks.list", "a title with a lone surrogate", (v) => { v.tasks[0].title = LONE; });
ok(refused(() => taskEvent({ ...q, text: LONE })), "question: text with a lone surrogate: refused");
ok(refused(() => taskEvent({ ...q, choices: ["ok", LONE] })), "question: a choice with a lone surrogate: refused");
ok(refused(() => taskEvent({ type: "task_status", status: "failed", reason: LONE })), "task_status: a reason with a lone surrogate: refused");
ok(refused(() => taskEvent({ type: "text_delta", message: "m", revision: 1, text: LONE })), "a turn event's text with a lone surrogate: refused");
// (and no NUL in any text field; binary documents come as base64)
const NUL = "a\u0000b";
ok(refused(() => TASK_RESULTS["tasks.file"](fileWith(NUL))) && !refused(() => TASK_RESULTS["tasks.file"](fileWith({ base64: "YQBi" }))), "tasks.file: content with a NUL: refused as text, accepted as base64");
alter("tasks.list", "a title with a NUL", (v) => { v.tasks[0].title = NUL; });
ok(refused(() => taskEvent({ ...q, text: NUL })), "question: text with a NUL: refused");
ok(refused(() => taskEvent({ ...q, choices: ["ok", NUL] })), "question: a choice with a NUL: refused");
ok(refused(() => taskEvent({ type: "task_status", status: "failed", reason: NUL })), "task_status: a reason with a NUL: refused");
ok(refused(() => taskEvent({ type: "text_delta", message: "m", revision: 1, text: NUL })), "a turn event's text with a NUL: refused");

// (chat turn events: each kind closed)
const GOOD_TURN = [
  { type: "turn_started", turn_id: "t1" }, { type: "turn_state", state: "running" }, { type: "message_revised", message: "m1", revision: 1 },
  { type: "text_delta", message: "m1", revision: 1, text: "hi" }, { type: "message_truncated", message: "m1", revision: 2 }, { type: "thinking_delta", text: "hmm" },
  { type: "tool_call_started", call: "c1", tool: "edit", name: "workspace_write", summary: "a.ipynb" }, { type: "tool_output", call: "c1", text: "ok" },
  { type: "tool_call_finished", call: "c1", status: "ok", duration_ms: 12, body: "done", body_cut: true, diff: { path: "a.txt", before: "x", after: "y" } },
  { type: "attention", id: "q1", kind: "approval", state: "open", title: "Allow?", summary: "s", detail: "d", instance: "i1" },
  { type: "artifact", id: "a1", kind: "notebook", title: "plot", body: "notebook", path: "work/a.ipynb", lang: "python" },
  { type: "turn_usage", usage: { input_tokens: 1, output_tokens: 2 } }, { type: "turn_info", model: "claude-opus-5-5", effort: "medium" },
  { type: "turn_error", code: "limit", message: "too long" }, { type: "turn_finished", outcome: "completed", code: "ok" },
];
for (const e of GOOD_TURN) ok(!refused(() => taskEvent(e)) && taskEvent(e).type === "turn", `a well-formed ${e.type} turn event: accepted`);
const BAD_TURN = [
  ["an artifact with a field more (astra4's probe)", { type: "artifact", id: "a1", kind: "code", title: "t", body: "b", surprise: { x: 1 } }],
  ["a text_delta whose text isn't text (astra4's probe)", { type: "text_delta", message: "m", revision: 1, text: { unexpected: true } }],
  ["a text_delta without its message", { type: "text_delta", revision: 1, text: "hi" }],
  ["a revision that isn't an integer", { type: "message_revised", message: "m", revision: "1" }],
  ["an id with a space", { type: "tool_output", call: "c 1", text: "x" }],
  ["an id over 128 characters", { type: "tool_output", call: "c".repeat(129), text: "x" }],
  ["an attention state not open, approved or denied", { type: "attention", id: "q", kind: "k", state: "maybe", title: "t" }],
  ["an artifact kind not listed", { type: "artifact", id: "a", kind: "html", title: "t", body: "b" }],
  ["body_cut other than true", { type: "tool_call_finished", call: "c", status: "ok", duration_ms: 1, body_cut: false }],
  ["a diff with a field more", { type: "tool_call_finished", call: "c", status: "ok", duration_ms: 1, diff: { path: "a", before: "", after: "", extra: 1 } }],
  ["usage with a field more", { type: "turn_usage", usage: { input_tokens: 1, output_tokens: 2, cost: 9 } }],
  ["an outcome not listed", { type: "turn_finished", outcome: "exploded" }],
  ["a summary over its bound", { type: "tool_call_started", call: "c", tool: "t", summary: "s".repeat(401) }],
  ["a text_delta over its bound", { type: "text_delta", message: "m", revision: 1, text: "x".repeat(192 * 1024 + 1) }],
  ["a turn_id that isn't an id", { type: "turn_started", turn_id: { x: 1 } }],
];
for (const [what, e] of BAD_TURN) ok(refused(() => taskEvent(e)), `a turn event: ${what}: refused`);
ok(refused(() => taskNotification({ task: "c".repeat(32), seq: 0, event: prop })), "a task.event with seq 0: refused");

// (the page's showing of a task's log, taskLog and taskNotice: everything around each event checked closed, and each
//  event alone, so one it refuses is kept as refused, with its seq, and the rest still show)
{
  const g = pick("tasks.get");
  const n = g.events.length;
  g.events.splice(1, 0, { seq: g.events[0].seq + 0.5, event: { type: "task_status", status: "working" } });
  ok(refused(() => taskLog(g)), "taskLog: a seq that isn't an integer: refused, the whole answer");
  const h = pick("tasks.get");
  h.events[0].event = { ...h.events[0].event, extra: 1 };
  const l = taskLog(h);
  ok(refused(() => TASK_RESULTS["tasks.get"](h)) && l.events.length === n && "refused" in l.events[0] && l.events[0].seq === h.events[0].seq && l.events.slice(1).every((e) => "event" in e), "taskLog: an event the page refuses kept as refused, with its seq; the others as tasks.get's check gives them (which refuses the whole answer)");
  const k = pick("tasks.get");
  k.extra = 1;
  ok(refused(() => taskLog(k)), "taskLog: a field the answer doesn't have: refused, the whole answer");
  const m = pick("tasks.get");
  if (m.events.length > 1) { [m.events[0], m.events[1]] = [m.events[1], m.events[0]]; ok(refused(() => taskLog(m)), "taskLog: events out of seq order: refused"); }
  ok("refused" in taskNotice({ task: "c".repeat(32), seq: 3, event: { type: "ask" } }) && taskNotice({ task: "c".repeat(32), seq: 3, event: { type: "ask" } }).seq === 3, "taskNotice: an event the page refuses: kept as refused, with its task and seq");
  ok("event" in taskNotice({ task: "c".repeat(32), seq: 3, event: prop }), "taskNotice: a good event: checked as taskNotification's");
  ok(refused(() => taskNotice({ task: "C".repeat(32), seq: 3, event: prop })) && refused(() => taskNotice({ task: "c".repeat(32), seq: 0, event: prop })) && refused(() => taskNotice({ task: "c".repeat(32), seq: 3, event: prop, x: 1 })), "taskNotice: a bad task, seq or field around the event: refused, the whole notification");
}

console.log(fails.length ? `FAIL: ${fails.length} of ${checks}\n  ${fails.join("\n  ")}` : `ok: tasks-schema, ${checks} checks (fixture from sagebrush-agent ${F.agent.head.slice(0, 10)})`);
process.exit(fails.length ? 1 : 0);
