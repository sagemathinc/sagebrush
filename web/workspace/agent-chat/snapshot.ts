// A conversation, as a snapshot to share (a read-only link, like claude.ai's and chatgpt.com's): its title and its
// messages, as Markdown text, and nothing else. What goes in: the person's messages that were sent, and the text of
// each finished agent turn. What stays out: notes, queued messages, a turn still running, thinking, tool calls and
// their output, permission cards, diffs and artifacts. A snapshot over a limit is refused, never cut. The share server
// will keep a copy of these limits and of validSnapshot.
import type { Thread, Turn, UserEntry } from "./events";

export const SNAPSHOT_LIMITS = {
  /** conversation.json, as UTF-8 bytes */
  bytes: 1024 * 1024,
  title: 200,
  messages: 2000,
  name: 80,
} as const;

export interface SnapshotMessage {
  role: "user" | "agent";
  /** the agent's own name ("Claude"); never an account's */
  name?: string;
  text: string;
}
export interface Snapshot {
  v: 1;
  title: string;
  /** when it was made: an ISO time */
  created: string;
  messages: SnapshotMessage[];
}

export type SnapshotResult =
  | { ok: true; snapshot: Snapshot; json: string; bytes: number }
  | { ok: false; why: "empty" | "title" | "name" | "messages" | "bytes"; count?: number; bytes?: number };

const utf8 = (s: string) => new TextEncoder().encode(s).length;

/** A thread's snapshot, or why it can't be one. */
export function snapshotOf(thread: Thread, now: Date = new Date()): SnapshotResult {
  const messages: SnapshotMessage[] = [];
  for (const e of thread.entries) {
    if (e.kind === "user") {
      const u = e as UserEntry;
      if (u.mode === "sent" && u.text.trim()) messages.push({ role: "user", text: u.text });
    } else if (e.kind === "turn") {
      const t = e as Turn;
      if (t.state === "running") continue;
      const text = t.parts.filter((p) => p.kind === "message").map((p) => (p as { text: string }).text).join("\n\n");
      if (!text.trim()) continue;
      messages.push({ role: "agent", ...(t.agent ? { name: t.agent } : {}), text });
    }
  }
  if (!messages.length) return { ok: false, why: "empty" };
  const title = thread.title.trim() || "Conversation";
  if (title.length > SNAPSHOT_LIMITS.title) return { ok: false, why: "title" };
  if (messages.some((m) => m.name !== undefined && m.name.length > SNAPSHOT_LIMITS.name)) return { ok: false, why: "name" };
  if (messages.length > SNAPSHOT_LIMITS.messages) return { ok: false, why: "messages", count: messages.length };
  const snapshot: Snapshot = { v: 1, title, created: now.toISOString(), messages };
  const json = JSON.stringify(snapshot);
  const bytes = utf8(json);
  if (bytes > SNAPSHOT_LIMITS.bytes) return { ok: false, why: "bytes", bytes };
  return { ok: true, snapshot, json, bytes };
}

/** Whether a conversation.json's text is a snapshot within the limits: exactly these keys, these types, these sizes. */
export function validSnapshot(json: string): boolean {
  if (typeof json !== "string" || utf8(json) > SNAPSHOT_LIMITS.bytes) return false;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return false;
  }
  const keys = (o: object, allowed: string[], required: string[]) => Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => k in o);
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  if (!keys(s, ["v", "title", "created", "messages"], ["v", "title", "created", "messages"])) return false;
  if (s.v !== 1 || typeof s.title !== "string" || s.title.length > SNAPSHOT_LIMITS.title) return false;
  if (typeof s.created !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s.created) || Number.isNaN(Date.parse(s.created))) return false;
  if (!Array.isArray(s.messages) || s.messages.length > SNAPSHOT_LIMITS.messages) return false;
  return s.messages.every((m) => {
    if (!m || typeof m !== "object" || Array.isArray(m) || !keys(m, ["role", "name", "text"], ["role", "text"])) return false;
    const x = m as Record<string, unknown>;
    return (x.role === "user" || x.role === "agent") && typeof x.text === "string" && (x.name === undefined || (typeof x.name === "string" && x.name.length <= SNAPSHOT_LIMITS.name));
  });
}
