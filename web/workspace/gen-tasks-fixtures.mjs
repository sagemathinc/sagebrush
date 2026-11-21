// Records a Delegate host's real answers and events (sagebrush-agent's lib/fake-tasks.mjs: its real task store, a
// scripted agent) as web/workspace/tasks-fixtures.json, for test-tasks-schema.mjs: a whole task through §6.1's frames
// (start, list, get, diff, file, merged, close, ask, stop, resume, revoke) and its task.event notifications. Run by
// hand against an agent checkout, which it names in the fixture; CI only reads the fixture.
//   bun web/workspace/gen-tasks-fixtures.mjs /path/to/sagebrush-agent
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const agent = process.argv[2];
if (!agent) { console.error("usage: bun web/workspace/gen-tasks-fixtures.mjs /path/to/sagebrush-agent"); process.exit(2); }
const { fakeTasks } = await import(join(agent, "lib", "fake-tasks.mjs"));
const head = execFileSync("git", ["-C", agent, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const root = mkdtempSync(join(tmpdir(), "sb-tasks-fixtures-"));
try {
  const host = await fakeTasks({ root });
  const notes = [];
  host.onNotify((m) => notes.push(m.params));
  let n = 1;
  const answers = [];
  const call = async (method, params) => {
    const a = await host.handle({ jsonrpc: "2.0", id: `p${++n}`, method, params });
    answers.push({ method, params: method === "tasks.start" || method === "tasks.ask" || method === "tasks.merged" ? "(omitted)" : params, answer: a });
    if (a.error) throw new Error(`${method}: ${JSON.stringify(a.error)}`);
    return a.result;
  };
  const nb = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { sagebrush: { seed: 7 } }, cells: [{ id: "c1", cell_type: "code", source: "x = 1", metadata: {}, outputs: [], execution_count: null }] });
  const docs = [{ path: "work/a.ipynb", kind: "notebook", content: nb }, { path: "work/notes.txt", kind: "file", content: "one\n" }];
  const s = await call("tasks.start", { title: "Fixture task", prompt: "Add a note.", target: "local", run: false, docs });
  await host.settled();
  await call("tasks.list", {});
  await call("tasks.get", { task: s.task, after: 0 });
  const listed = (await call("tasks.list", {})).tasks.find((t) => t.task === s.task);
  const d = await call("tasks.diff", { task: s.task, commit: listed.proposal });
  for (const f of d.files) {
    if (f.base_blob) await call("tasks.file", { task: s.task, commit: d.base, path: f.path });
    if (f.blob) await call("tasks.file", { task: s.task, commit: d.commit, path: f.path });
  }
  // (Ask for changes, a second round, then a merge recorded as a receipt and, in a second task, a stop/resume/revoke)
  await call("tasks.ask", { task: s.task, proposal: listed.proposal, seq: d.seq, note: "Also a line at the top.", current: docs });
  await host.settled();
  const l2 = (await call("tasks.list", {})).tasks.find((t) => t.task === s.task);
  const d2 = await call("tasks.diff", { task: s.task, commit: l2.proposal });
  await call("tasks.merged", { task: s.task, proposal: l2.proposal, seq: d2.seq, merge_id: "a".repeat(32), files: d2.files.map((f) => ({ path: f.path, kind: f.kind, proposal_blob: f.blob, mine: null, merged: null })) });
  await call("tasks.get", { task: s.task, after: 0 });
  const s2 = await call("tasks.start", { title: "Second", prompt: "Stop me.", target: "local", run: false, docs: [docs[1]] });
  // (refusals are recorded too: a stop may find the scripted turn done, and a resume then refuses)
  const tryCall = (m, p) => call(m, p).catch(() => null);
  await tryCall("tasks.stop", { task: s2.task });
  await tryCall("tasks.resume", { task: s2.task });
  await host.settled();
  await tryCall("tasks.revoke", { task: s2.task });
  await tryCall("tasks.close", { task: s.task, proposal: null, seq: 0 });
  await tryCall("tasks.get", { task: "f".repeat(32), after: 0 });
  writeFileSync(new URL("./tasks-fixtures.json", import.meta.url), JSON.stringify({ agent: { repo: "sagebrush-agent", head }, answers, notifications: notes }, null, 1) + "\n");
  console.log(`tasks-fixtures.json: ${answers.length} answers, ${notes.length} notifications, from sagebrush-agent ${head.slice(0, 10)}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
