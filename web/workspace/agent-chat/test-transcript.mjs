// ci: web-runner order=372 runner=bun
// A chat as Markdown (web/workspace/agent-chat/transcript.ts), what Copy chat and a message's Copy put on the clipboard:
// the person's and the agent's messages, one line per tool call (its name and what it worked on) and per file (a link
// where the page knows its address), a prompt as one line with its answer; the agent's thinking left out.
//   bun web/workspace/agent-chat/test-transcript.mjs
import { threadMarkdown, turnMarkdown, userMarkdown } from "./transcript.ts";

let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (c || detail === undefined ? "" : "\n" + String(detail))); if (!c) failures++; };

const turn = {
  kind: "turn", turn_id: "t1", state: "completed", started: 1,
  parts: [
    { kind: "thinking", text: "secret reasoning" },
    { kind: "message", id: "m1", revision: 1, text: "I'll make the notebook.", truncated: false },
    { kind: "tool", call: "c1" },
    { kind: "artifact", id: "/sin x squared.ipynb" },
    { kind: "tool", call: "c2" },
    { kind: "attention", id: "p1" },
    { kind: "message", id: "m2", revision: 1, text: "Done: it plots sin(x^2).", truncated: false },
  ],
  tools: { c1: { call: "c1", tool: "tool", name: "workspace_write_notebook", summary: "/sin x squared.ipynb", status: "ok", output: "" }, c2: { call: "c2", tool: "terminal", name: "Bash", summary: "echo `hi`", status: "error", output: "" } },
  attention: { p1: { id: "p1", kind: "permission", state: "approved", title: "Run   Bash?" } },
};
const thread = {
  id: "x", title: "draw a plot of sin(x^2)", applied_seq: 0,
  artifacts: [{ id: "/sin x squared.ipynb", kind: "notebook", title: "sin x squared.ipynb", body: "", turn_id: "t1", path: "/sin x squared.ipynb" }],
  entries: [{ kind: "user", id: "u1", text: "draw a plot of sin(x^2)\n", mode: "sent", time: 1 }, turn, { kind: "user", id: "u2", text: "for me only", mode: "note", time: 2 }],
};
const link = (p) => (p === "/sin x squared.ipynb" ? "https://sagebrush.space/?nb=abc" : null);

const md = threadMarkdown(thread, { agent: "Claude", link });
const want = `# draw a plot of sin(x^2)

**You:**

draw a plot of sin(x^2)

**Claude:**

I'll make the notebook.

- \`workspace_write_notebook\` \`/sin x squared.ipynb\`
- file: [/sin x squared.ipynb](<https://sagebrush.space/?nb=abc>)
- \`Bash\` \`\` echo \`hi\` \`\` (error)
- asked: Run Bash? (allowed)

Done: it plots sin(x^2).

**You (a note, not sent to the agent):**

for me only
`;
ok(md === want, "the whole chat: title, each message, a line per tool call, file and prompt, as one list between messages", md);
ok(!md.includes("secret reasoning"), "the agent's thinking is left out");
ok(turnMarkdown(thread, turn, { agent: "Claude" }).includes("- file: `/sin x squared.ipynb`"), "a file whose address the page doesn't know: named by its path");
ok(userMarkdown({ kind: "user", id: "q", text: "later", mode: "queued", time: 3 }) === "**You (queued):**\n\nlater", "a queued message says so");
ok(threadMarkdown({ id: "e", title: "", entries: [], artifacts: [], applied_seq: 0 }, { agent: "Claude" }) === "# Chat\n", "an empty chat: its title only");
ok(turnMarkdown(thread, { ...turn, parts: [], error: { code: "x", message: "the agent\nstopped" } }, { agent: "Codex" }) === "**Codex:**\n\nError: the agent stopped", "an error, on one line, under the agent's name");

console.log(failures ? `FAIL: ${failures}` : "all passed");
process.exit(failures ? 1 : 0);
