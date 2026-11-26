// A chat as Markdown, for the person to copy and paste elsewhere (decided Nov 19 2026): what the person wrote and what
// the agent answered, each of the agent's tool calls on one line (its name and what it worked on), and the files it
// wrote as links. The agent's thinking is left out; a permission prompt is one line, with its answer.
import { errorLine, own, type Artifact, type Thread, type ToolCall, type Turn, type UserEntry } from "./events";

export interface TranscriptOptions {
  /** the agent's name, as the chat shows it ("Claude") */
  agent: string;
  /** a file's address, where the page knows it (else the file is named by its path) */
  link?: (path: string) => string | null | undefined;
}

// (inline code that stays code whatever it holds: a backtick inside is fenced by a longer run, as CommonMark has it)
const code = (s: string) => {
  const runs = s.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  return fence + (/^`|`$/.test(s) ? " " + s + " " : s) + fence;
};
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function toolLine(t: ToolCall): string {
  const what = t.summary ? " " + code(oneLine(t.summary).slice(0, 200)) : "";
  return `- ${code(t.name ?? t.tool)}${what}${t.status === "ok" ? "" : ` (${t.status})`}`;
}

function fileLine(a: Artifact, o: TranscriptOptions): string {
  const url = a.path ? o.link?.(a.path) : null;
  const name = a.path ?? a.title;
  return url ? `- file: [${name.replace(/[[\]]/g, "\\$&")}](<${url}>)` : `- file: ${code(name)}`;
}

/** What the person wrote, as Markdown. */
export function userMarkdown(e: UserEntry): string {
  const tag = e.mode === "note" ? " (a note, not sent to the agent)" : e.mode === "queued" ? " (queued)" : "";
  return `**You${tag}:**\n\n${e.text.trim()}`;
}

/** One turn of the agent's, as Markdown: its messages, a line per tool call and per file, a line per prompt. */
export function turnMarkdown(thread: Thread, turn: Turn, o: TranscriptOptions): string {
  const blocks: string[] = [`**${o.agent}:**`];
  // (list lines next to each other are one list)
  const push = (s: string) => {
    const last = blocks[blocks.length - 1];
    if (s.startsWith("- ") && /(^|\n)- [^\n]*$/.test(last) && !last.startsWith("**")) blocks[blocks.length - 1] = last + "\n" + s;
    else blocks.push(s);
  };
  for (const p of turn.parts) {
    if (p.kind === "message") {
      if (p.text.trim()) push(p.text.trim() + (p.truncated ? "\n\n(cut at 256 KiB)" : ""));
    } else if (p.kind === "tool") {
      const t = own(turn.tools, p.call);
      if (t) push(toolLine(t));
    } else if (p.kind === "artifact") {
      const a = thread.artifacts.find((x) => x.id === p.id);
      if (a) push(fileLine(a, o));
    } else if (p.kind === "attention") {
      const a = own(turn.attention, p.id);
      if (a) push(`- asked: ${oneLine(a.title)} (${a.state === "approved" ? "allowed" : a.state === "denied" ? "denied" : "no answer"})`);
    }
  }
  if (turn.error) push(oneLine(errorLine(turn.error.code, turn.error.message)));
  return blocks.join("\n\n");
}

/** The whole chat, as Markdown: its title, then each entry in order. */
export function threadMarkdown(thread: Thread, o: TranscriptOptions): string {
  const entries = thread.entries.map((e) => (e.kind === "user" ? userMarkdown(e) : turnMarkdown(thread, e, o)));
  return [`# ${oneLine(thread.title) || "Chat"}`, ...entries].join("\n\n") + "\n";
}
