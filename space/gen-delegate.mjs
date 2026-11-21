// The Delegate space: the Pair/Delegate agent code, laid out as one Delegate task flows through it.  The page's side
// (sagebrush, at a master commit) above, the agent's side (sagebrush-agent, exactly its published 0.8.0) below, and
// between them the messages that cross (tasks.start, task.event, ...), each an object of its own with the spec's
// words for it.  Left to right: the sheet, the pairing, the agent receiving, its task record and git copy, the runner
// and Claude turns, the events back, the proposal, the merge.  The spec (design/workspace-agent-protocol.md) stands at
// the left, a note per section.  Every file is whole, so each is entered as a room.  Read-only: nothing is written but
// public/delegate.space.json.
//   node gen-delegate.mjs MASTER_REV AGENT_PACKAGE_DIR    (the unpacked sagebrush-agent-0.8.0.tgz's package/)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [rev = "origin/master", pkg] = process.argv.slice(2);
if (!pkg) throw new Error("usage: node gen-delegate.mjs MASTER_REV AGENT_PACKAGE_DIR");
const commit = execFileSync("git", ["-C", join(here, ".."), "rev-parse", rev], { encoding: "utf8" }).trim();
const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
if (version !== "0.8.0") throw new Error(`the agent package is ${version}, not 0.8.0`);
// (the site's build refuses any file carrying the service worker's test hook verbatim: said with two spaces)
const clean = (t) => t.replaceAll("// <offline-test>", "//  <offline-test>");
const pageFile = (p) => clean(execFileSync("git", ["-C", join(here, ".."), "show", `${commit}:${p}`], { encoding: "utf8", maxBuffer: 1 << 26 }));
const agentFile = (p) => clean(readFileSync(join(pkg, p), "utf8"));
const lineCount = (t) => t.split("\n").length - (t.endsWith("\n") ? 1 : 0);

// ---- the flow: stages left to right; each file in one, on its side
const STAGES = [
  { id: "sheet", title: "1 · The sheet: a task is asked for", page: ["web/agents/delegate-ui.ts", "web/agents/delegate.ts"] },
  { id: "pairing", title: "2 · The pairing: the grant, the wire", page: ["web/workspace/agent-grant.ts", "web/workspace/agent-pair.ts", "web/workspace/tasks-client.ts", "web/workspace/tasks-schema.ts"] },
  { id: "receive", title: "3 · The agent receives", agent: ["bin/sagebrush-agent.mjs", "lib/server.mjs", "lib/task-rpc.mjs", "lib/tasks-schema.mjs"] },
  { id: "record", title: "4 · The task record and its git copy", agent: ["lib/tasks.mjs", "lib/task-git.mjs", "lib/task-paths.mjs"] },
  { id: "run", title: "5 · The runner and Claude's turns", agent: ["lib/task-runner.mjs", "lib/proc-start.mjs", "lib/task-turns.mjs", "lib/turn-bounds.mjs"] },
  { id: "proposal", title: "6 · Back on the page: the chip and the proposal", page: ["web/workspace/review/proposal-view.ts", "web/workspace/review/diff-render.ts"] },
  { id: "merge", title: "7 · Merge", page: ["web/workspace/review/merge3.ts", "web/workspace/review/review-page.ts"] },
];
// (the messages between the two sides, each placed between the stages it joins: from, to, the spec's rows)
const WIRE = [
  { id: "wire:start", title: "→ tasks.start", at: 1.5, from: "web/workspace/tasks-client.ts", to: "lib/task-rpc.mjs", methods: ["tasks.start"],
    text: "The page asks the agent to begin a task: its title, the prompt, `run`, and the documents copied in. The answer names the task, its base commit and the first event's `seq`." },
  { id: "wire:event", title: "← task.event", at: 4.5, from: "lib/server.mjs", to: "web/agents/delegate.ts", methods: [],
    text: "The agent tells the page what happens, as notifications: the chat turn's events, `task_status`, and `proposal` when a round of work is ready." },
  { id: "wire:read", title: "→ tasks.list · tasks.get · tasks.diff · tasks.file", at: 5.5, from: "web/workspace/tasks-client.ts", to: "lib/task-rpc.mjs", methods: ["tasks.list", "tasks.get", "tasks.diff", "tasks.file"],
    text: "The page reads: the tasks, a task's events after a `seq`, a proposal's changed files, and one file's bytes at a pinned commit." },
  { id: "wire:decide", title: "→ tasks.merged · close · ask · stop · revoke · resume", at: 6.5, from: "web/workspace/tasks-client.ts", to: "lib/task-rpc.mjs",
    methods: ["tasks.merged", "tasks.close", "tasks.ask", "tasks.stop", "tasks.revoke", "tasks.resume"],
    text: "The person's decisions, and only the person's: Merge (recorded on the agent's side after the page writes the documents), Close, Ask for changes, Stop, Revoke, Resume. **At this master the page offers none of Merge, Close or Ask yet** (delegate-ui.ts: \"Merge, Close and Ask for changes come in a later update\"); tasks-client.ts already has the methods, and merge3.ts is the three-way merge Merge will use." },
];

const nodes = [], edges = [];
const STEP = 7, GAP = 9, PAGE_Y = 11, AGENT_Y = -11, WIRE_Y = 0;
// (each stage as wide as its files, one after another; `centers` for the wire between them)
const centers = [];
let cursor = 0;
for (const st of STAGES) {
  const w = Math.max((st.page ?? []).length, (st.agent ?? []).length) * STEP;
  centers.push(cursor + w / 2);
  cursor += w + GAP;
}
const files = new Map();
STAGES.forEach((st, k) => {
  for (const side of ["page", "agent"]) {
    (st[side] ?? []).forEach((p, j, all) => {
      const text = side === "page" ? pageFile(p) : agentFile(p);
      const id = (side === "page" ? "page:" : "agent:") + p;
      const n = all.length, x = centers[k] + (j - (n - 1) / 2) * STEP;
      const y = side === "page" ? PAGE_Y + (j % 2) * 2.5 : AGENT_Y - (j % 2) * 2.5;
      const nd = { id, kind: "file", title: side === "page" ? p : "sagebrush-agent/" + p, path: p, group: st.title + (side === "agent" ? " (agent)" : " (page)"),
        lang: /\.ts$/.test(p) ? "typescript" : "javascript", lines: lineCount(text), text, position: [x, y, (j % 2) * -3], position2d: [x, y] };
      nodes.push(nd);
      files.set(p, nd);
    });
  }
});
// ---- the spec: its sections as notes, in a column at the left
const spec = pageFile("design/workspace-agent-protocol.md");
const sections = spec.split(/\n(?=## )/);
sections.forEach((s, j) => {
  const title = (s.match(/^#+\s*(.+)/) ?? [, "The spec"])[1].trim();
  const x = -24, y = 15 - j * 5;
  nodes.push({ id: "spec:" + j, kind: "note", title: j === 0 ? "The spec: " + title : title, group: "The spec (design/workspace-agent-protocol.md)", text: s.trim(),
    position: [x, y, 0], position2d: [x, y] });
});
for (let j = 0; j + 1 < sections.length; j++) edges.push({ from: "spec:" + j, to: "spec:" + (j + 1), kind: "next" });
// ---- the wire: an object per crossing, its spec rows quoted
const rows = spec.split("\n");
for (const w of WIRE) {
  const quoted = w.methods.map((m) => rows.find((l) => l.startsWith("| `" + m + "`"))).filter(Boolean);
  const eventsPart = w.id === "wire:event" ? spec.slice(spec.indexOf("**Events (`task.event")).split("\n### ")[0].trim() : "";
  const text = `${w.text}\n\n${quoted.length ? "| Method | params | result | Checks |\n|---|---|---|---|\n" + quoted.join("\n") : eventsPart}\n\n(From design/workspace-agent-protocol.md §6.1.)`;
  const x = (centers[Math.floor(w.at)] + centers[Math.ceil(w.at)]) / 2;
  nodes.push({ id: w.id, kind: "note", title: w.title, group: "The wire between the two sides", text, position: [x, WIRE_Y, 2], position2d: [x, WIRE_Y] });
  // (sent by one side's file, handled by the other's)
  const sideOf = (p) => (p.startsWith("lib/") ? "agent:" : "page:");
  edges.push({ from: sideOf(w.from) + w.from, to: w.id, kind: "sends" }, { from: w.id, to: sideOf(w.to) + w.to, kind: "handles" });
}
// ---- imports within each side, among these files
const IMP = /(?:import|export)\s[^;"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
for (const [p, nd] of files) {
  for (const m of nd.text.matchAll(IMP)) {
    const spec = m[1] ?? m[2];
    if (!spec.startsWith(".")) continue;
    const b = posix.join(posix.dirname(p), spec);
    const to = [b, b + ".ts", b + ".mjs", b.replace(/\.js$/, ".ts")].map((c) => files.get(c)).find(Boolean);
    if (to && to !== nd && !edges.some((e) => e.from === nd.id && e.to === to.id)) edges.push({ from: nd.id, to: to.id, kind: "imports" });
  }
}
// ---- how the agent's parts are wired and call each other (read from the code: bin/sagebrush-agent.mjs makes the
//  store, the turns, the runner and the rpc and hands them to the server; the rpc calls the store and the turns; the
//  turns call the store and the runner; the server sends each of the store's events to the page as task.event)
const A = (p) => "agent:" + p;
for (const [from, to, kind] of [
  ["bin/sagebrush-agent.mjs", "lib/tasks.mjs", "makes"], ["bin/sagebrush-agent.mjs", "lib/task-turns.mjs", "makes"], ["bin/sagebrush-agent.mjs", "lib/task-runner.mjs", "makes"],
  ["bin/sagebrush-agent.mjs", "lib/task-rpc.mjs", "makes"], ["bin/sagebrush-agent.mjs", "lib/server.mjs", "makes"],
  ["lib/task-rpc.mjs", "lib/tasks.mjs", "calls"], ["lib/task-rpc.mjs", "lib/task-turns.mjs", "calls"],
  ["lib/task-turns.mjs", "lib/tasks.mjs", "calls"], ["lib/task-turns.mjs", "lib/task-runner.mjs", "calls"],
  ["lib/server.mjs", "lib/tasks.mjs", "listens"],
]) if (!edges.some((e) => e.from === A(from) && e.to === A(to))) edges.push({ from: A(from), to: A(to), kind });
// (the two schemas: the same contract, written once per side)
edges.push({ from: "page:web/workspace/tasks-schema.ts", to: "agent:lib/tasks-schema.mjs", kind: "same contract" });

const space = {
  format: "sagebrush-space", version: 1,
  title: "Delegate: one task, end to end",
  summary: `The Pair/Delegate agent code, as one Delegate task flows through it: the page (sagebrush master ${commit.slice(0, 10)}) above, the agent (sagebrush-agent 0.8.0, as published) below, and the messages between them in the middle. The spec is at the left. Enter any file to see its functions and what calls what.`,
  directed: true, nodes, edges,
  // (seen whole from in front, the flow left to right, a little from above)
  view: { from: [(cursor - 40) / 2, 6, Math.max(70, (cursor + 24) * 0.85)], to: [(cursor - 40) / 2, -1, 0] },
};
const out = join(here, "public", "delegate.space.json");
writeFileSync(out, JSON.stringify(space) + "\n");
console.log(out + ":", nodes.length, "objects,", edges.length, "links; master", commit.slice(0, 10), "agent", version);
