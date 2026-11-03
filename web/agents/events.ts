// The agents chat's headless core: typed turn events (the stream cocalc-ai's
// turn-event projector produces) folded into a thread model the page renders.
// Nothing here touches the DOM, so other clients (CoCalc's own agent chat,
// mobile) can reuse it.
//
// Two kinds here are not (yet) in the projector's stream, and exist for the
// preview's UI questions: `tool_output` (a call's output while it runs) and
// `artifact` (a document, file or diff the turn produced, shown beside the
// chat).

export type TurnOutcome = "completed" | "interrupted" | "error";

// One event of the stream. `seq` is per thread, strictly increasing by one.
export type TurnEvent = { seq: number; turn_id: string } & (
  | { type: "turn_started" }
  | { type: "turn_state"; state: string }
  | { type: "message_revised"; message: string; revision: number }
  | { type: "text_delta"; message: string; revision: number; text: string }
  | { type: "message_truncated"; message: string; revision: number }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_started"; call: string; tool: string; name?: string; summary?: string }
  | { type: "tool_output"; call: string; text: string }
  | {
      type: "tool_call_finished";
      call: string;
      status: string;
      summary?: string;
      duration_ms: number;
      body?: string;
      body_cut?: true;
      diff?: { path: string; before: string; after: string };
    }
  | { type: "attention"; id: string; kind: string; state: "open" | "approved" | "denied"; title: string; summary?: string; detail?: string }
  | { type: "artifact"; id: string; kind: "markdown" | "code" | "diff" | "notebook"; title: string; lang?: string; body: string; path?: string }
  | { type: "turn_usage"; usage: { input_tokens: number; output_tokens: number } }
  | { type: "turn_error"; code: string; message: string }
  | { type: "turn_finished"; outcome: TurnOutcome; code?: string }
);

// What the person wrote, kept beside the agent's events.
export interface UserEntry {
  kind: "user";
  id: string;
  text: string;
  // "sent": to the agent now; "queued": after the running turn; "note": never sent
  mode: "sent" | "queued" | "note";
  time: number;
}

export interface ToolCall {
  call: string;
  tool: string;
  name?: string;
  summary?: string;
  status: string; // "running" until finished
  output: string;
  body_cut?: boolean;
  duration_ms?: number;
  diff?: { path: string; before: string; after: string };
}

export interface Attention {
  id: string;
  kind: string;
  state: "open" | "approved" | "denied";
  title: string;
  summary?: string;
  detail?: string; // all of the request's arguments, for the person to review
}

export interface Artifact {
  id: string;
  kind: "markdown" | "code" | "diff" | "notebook";
  title: string;
  lang?: string;
  body: string;
  turn_id: string;
  // a workspace file: the pane shows (and edits) the file itself
  path?: string;
}

// A turn's parts in arrival order: what the page lays out top to bottom.
export type Part =
  | { kind: "thinking"; text: string }
  | { kind: "message"; id: string; revision: number; text: string; truncated: boolean }
  | { kind: "tool"; call: string }
  | { kind: "attention"; id: string }
  | { kind: "artifact"; id: string };

export interface Turn {
  kind: "turn";
  turn_id: string;
  state: string; // "running", then the outcome
  parts: Part[];
  tools: Record<string, ToolCall>;
  attention: Record<string, Attention>;
  outcome?: TurnOutcome;
  error?: { code: string; message: string };
  usage?: { input_tokens: number; output_tokens: number };
  started: number;
  finished?: number;
  // set for a turn of an agent on the person's computer (else the scripted demo's)
  agent?: string;
  // how many parts weren't kept (CHAT_BOUNDS.parts), for the page to say so
  cut?: { parts?: number };
}

export interface Thread {
  id: string;
  title: string;
  entries: (UserEntry | Turn)[];
  artifacts: Artifact[];
  applied_seq: number;
  // how many of its oldest entries and artifacts aren't kept (CHAT_BOUNDS), for the page to say so
  dropped?: { entries: number; artifacts: number };
}

export function newThread(id: string, title: string): Thread {
  return { id, title, entries: [], artifacts: [], applied_seq: 0 };
}

// No history grows without bounds (William, Nov 3: BH; BH-1): every level of the chats has a count cap, and the whole a
// byte cap, checked as each thing is added, never later.  Past a cap the OLDEST goes (a new message is never refused:
// @sagebrush's ruling); what goes is counted, and the page says how much isn't kept.  Text is measured in UTF-16 code
// units, as localStorage stores it (2 bytes each); `bytes` is for the saved JSON of all the chats together.
export const CHAT_BOUNDS = {
  threads: 200,
  entries: 1000, // per chat: the dense window (BH's baseline)
  parts: 2000, // per turn
  tools: 2000, // per turn
  attention: 200, // per turn
  artifacts: 100, // per chat
  text: 256 * 1024, // per message, thinking part, tool output or artifact body (UTF-16 code units)
  bytes: 4 * 2 ** 20, // the saved JSON, in bytes (2 per code unit), under localStorage's ~5 MiB a site
} as const;
export type ChatBounds = { [K in keyof typeof CHAT_BOUNDS]: number };
// (text appended up to the bound: true when some of it wasn't kept)
function appendCapped(have: string, add: string, max: number): [string, boolean] {
  if (have.length + add.length <= max) return [have + add, false];
  return [have + add.slice(0, Math.max(0, max - have.length)), true];
}
function dropped(thread: Thread) {
  return (thread.dropped ??= { entries: 0, artifacts: 0 });
}
/** The chat's entries within the bound: its oldest let go (never a running turn), counted. */
export function boundEntries(thread: Thread, B: ChatBounds = CHAT_BOUNDS) {
  while (thread.entries.length > B.entries) {
    const i = thread.entries.findIndex((e) => !(e.kind === "turn" && !e.outcome));
    if (i < 0) break;
    thread.entries.splice(i, 1);
    dropped(thread).entries++;
  }
}
/** The chat's artifacts within the bound: the oldest let go (a turn's card for it is then not shown), counted. */
export function boundArtifacts(thread: Thread, B: ChatBounds = CHAT_BOUNDS) {
  while (thread.artifacts.length > B.artifacts) {
    thread.artifacts.shift();
    dropped(thread).artifacts++;
  }
}
/** Bytes the saved form takes (its JSON, 2 bytes a UTF-16 code unit, as localStorage counts). */
export const savedBytes = (v: unknown) => 2 * JSON.stringify(v).length;
/**
 * All the chats within the bounds, before they are saved (page.ts save): at most `threads` chats (the ones not used
 * longest let go, never `keep`'s), then the byte cap: the oldest entry of all the chats let go, one at a time, never a
 * running turn; then, if that isn't enough, whole chats, least recently used first (never `keep`'s).  Returns what it
 * let go.
 */
export function boundSaved(saved: { threads: Thread[] }, keep: Set<string>, B: ChatBounds = CHAT_BOUNDS): { threads: number; entries: number } {
  const out = { threads: 0, entries: 0 };
  const usedAt = (t: Thread) => {
    const e = t.entries[t.entries.length - 1];
    return e ? (e.kind === "user" ? e.time : (e.finished ?? e.started)) : 0;
  };
  const dropThread = () => {
    let k = -1;
    saved.threads.forEach((t, i) => { if (!keep.has(t.id) && (k < 0 || usedAt(t) < usedAt(saved.threads[k]))) k = i; });
    if (k < 0) return false;
    saved.threads.splice(k, 1);
    out.threads++;
    return true;
  };
  while (saved.threads.length > B.threads && dropThread());
  // (each chat's own bounds too: chats saved before them load within them)
  for (const t of saved.threads) {
    const before = t.dropped?.entries ?? 0;
    boundEntries(t, B);
    boundArtifacts(t, B);
    out.entries += (t.dropped?.entries ?? 0) - before;
  }
  let size = savedBytes(saved);
  while (size > B.bytes) {
    // (the oldest entry that may go, of all the chats)
    let best: { t: Thread; i: number; at: number } | null = null;
    for (const t of saved.threads) {
      const i = t.entries.findIndex((e) => !(e.kind === "turn" && !e.outcome));
      if (i < 0) continue;
      const e = t.entries[i], at = e.kind === "user" ? e.time : e.started;
      if (!best || at < best.at) best = { t, i, at };
    }
    if (best) {
      size -= savedBytes(best.t.entries[best.i]) + 2; // (and its comma)
      best.t.entries.splice(best.i, 1);
      dropped(best.t).entries++;
      out.entries++;
    } else if (!dropThread()) break;
    else size = savedBytes(saved);
  }
  return out;
}

function turnOf(thread: Thread, turn_id: string, time: number): Turn {
  for (let i = thread.entries.length - 1; i >= 0; i--) {
    const e = thread.entries[i];
    if (e.kind === "turn" && e.turn_id === turn_id) return e;
  }
  const turn: Turn = { kind: "turn", turn_id, state: "running", parts: [], tools: {}, attention: {}, started: time };
  thread.entries.push(turn);
  boundEntries(thread);
  return turn;
}

function messagePart(turn: Turn, id: string) {
  for (const p of turn.parts) if (p.kind === "message" && p.id === id) return p;
  return undefined;
}

// Applies one event. A duplicate (seq <= applied_seq) is dropped; a gap
// means the caller must ask for a reset (returns false).
export function apply(thread: Thread, e: TurnEvent, time = Date.now()): boolean {
  if (e.seq <= thread.applied_seq) return true;
  if (e.seq !== thread.applied_seq + 1) return false;
  thread.applied_seq = e.seq;
  const turn = turnOf(thread, e.turn_id, time);
  const last = turn.parts[turn.parts.length - 1];
  // (a new part, tool or request only under its bound: past it, the turn says how many weren't kept)
  const room = () => turn.parts.length < CHAT_BOUNDS.parts || ((turn.cut ??= {}).parts = (turn.cut.parts ?? 0) + 1, false);
  switch (e.type) {
    case "turn_started":
      turn.state = "running";
      break;
    case "turn_state":
      turn.state = e.state;
      break;
    case "message_revised": {
      const part = messagePart(turn, e.message);
      if (part) {
        part.revision = e.revision;
        part.text = "";
        part.truncated = false;
      } else {
        if (room()) turn.parts.push({ kind: "message", id: e.message, revision: e.revision, text: "", truncated: false });
      }
      break;
    }
    case "text_delta": {
      const part = messagePart(turn, e.message);
      if (part && part.revision === e.revision) {
        const [text, cut] = appendCapped(part.text, e.text, CHAT_BOUNDS.text);
        part.text = text;
        if (cut) part.truncated = true;
      }
      break;
    }
    case "message_truncated": {
      const part = messagePart(turn, e.message);
      if (part) part.truncated = true;
      break;
    }
    case "thinking_delta":
      if (last?.kind === "thinking") last.text = appendCapped(last.text, e.text, CHAT_BOUNDS.text)[0];
      else if (room()) turn.parts.push({ kind: "thinking", text: e.text.slice(0, CHAT_BOUNDS.text) });
      break;
    case "tool_call_started":
      if (Object.keys(turn.tools).length >= CHAT_BOUNDS.tools || !room()) break;
      turn.tools[e.call] = { call: e.call, tool: e.tool, name: e.name, summary: e.summary, status: "running", output: "" };
      turn.parts.push({ kind: "tool", call: e.call });
      break;
    case "tool_output": {
      const tool = turn.tools[e.call];
      if (tool) {
        const [output, cut] = appendCapped(tool.output, e.text, CHAT_BOUNDS.text);
        tool.output = output;
        if (cut) tool.body_cut = true;
      }
      break;
    }
    case "tool_call_finished": {
      const tool = turn.tools[e.call];
      if (!tool) break;
      tool.status = e.status;
      if (e.summary != null) tool.summary = e.summary;
      if (e.body != null) tool.output = e.body.slice(0, CHAT_BOUNDS.text);
      tool.body_cut = e.body_cut || (e.body != null && e.body.length > CHAT_BOUNDS.text) || tool.body_cut || undefined;
      tool.duration_ms = e.duration_ms;
      tool.diff = e.diff;
      break;
    }
    case "attention":
      if (!turn.attention[e.id]) {
        if (Object.keys(turn.attention).length >= CHAT_BOUNDS.attention || !room()) break;
        turn.parts.push({ kind: "attention", id: e.id });
      }
      turn.attention[e.id] = { id: e.id, kind: e.kind, state: e.state, title: e.title, summary: e.summary, detail: e.detail };
      break;
    case "artifact": {
      const existing = thread.artifacts.find((a) => a.id === e.id);
      // (an artifact's body: bounded as text is; a workspace file's own bytes are the workspace's, not the chat's)
      const value: Artifact = { id: e.id, kind: e.kind, title: e.title, lang: e.lang, body: e.body.slice(0, CHAT_BOUNDS.text), turn_id: e.turn_id, ...(e.path ? { path: e.path } : {}) };
      if (existing) Object.assign(existing, value);
      else {
        thread.artifacts.push(value);
        boundArtifacts(thread);
        if (room()) turn.parts.push({ kind: "artifact", id: e.id });
      }
      break;
    }
    case "turn_usage":
      turn.usage = e.usage;
      break;
    case "turn_error":
      turn.error = { code: e.code, message: e.message };
      break;
    case "turn_finished":
      turn.outcome = e.outcome;
      turn.state = e.outcome;
      turn.finished = time;
      for (const tool of Object.values(turn.tools)) if (tool.status === "running") tool.status = "unknown";
      break;
  }
  return true;
}

export function runningTurn(thread: Thread): Turn | undefined {
  for (let i = thread.entries.length - 1; i >= 0; i--) {
    const e = thread.entries[i];
    if (e.kind === "turn") return e.outcome ? undefined : e;
  }
  return undefined;
}
