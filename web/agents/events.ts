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
  | { type: "attention"; id: string; kind: string; state: "open" | "approved" | "denied"; title: string; summary?: string }
  | { type: "artifact"; id: string; kind: "markdown" | "code" | "diff"; title: string; lang?: string; body: string; path?: string }
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
}

export interface Artifact {
  id: string;
  kind: "markdown" | "code" | "diff";
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
}

export interface Thread {
  id: string;
  title: string;
  entries: (UserEntry | Turn)[];
  artifacts: Artifact[];
  applied_seq: number;
}

export function newThread(id: string, title: string): Thread {
  return { id, title, entries: [], artifacts: [], applied_seq: 0 };
}

function turnOf(thread: Thread, turn_id: string, time: number): Turn {
  for (let i = thread.entries.length - 1; i >= 0; i--) {
    const e = thread.entries[i];
    if (e.kind === "turn" && e.turn_id === turn_id) return e;
  }
  const turn: Turn = { kind: "turn", turn_id, state: "running", parts: [], tools: {}, attention: {}, started: time };
  thread.entries.push(turn);
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
        turn.parts.push({ kind: "message", id: e.message, revision: e.revision, text: "", truncated: false });
      }
      break;
    }
    case "text_delta": {
      const part = messagePart(turn, e.message);
      if (part && part.revision === e.revision) part.text += e.text;
      break;
    }
    case "message_truncated": {
      const part = messagePart(turn, e.message);
      if (part) part.truncated = true;
      break;
    }
    case "thinking_delta":
      if (last?.kind === "thinking") last.text += e.text;
      else turn.parts.push({ kind: "thinking", text: e.text });
      break;
    case "tool_call_started":
      turn.tools[e.call] = { call: e.call, tool: e.tool, name: e.name, summary: e.summary, status: "running", output: "" };
      turn.parts.push({ kind: "tool", call: e.call });
      break;
    case "tool_output": {
      const tool = turn.tools[e.call];
      if (tool) tool.output += e.text;
      break;
    }
    case "tool_call_finished": {
      const tool = turn.tools[e.call];
      if (!tool) break;
      tool.status = e.status;
      if (e.summary != null) tool.summary = e.summary;
      if (e.body != null) tool.output = e.body;
      tool.body_cut = e.body_cut;
      tool.duration_ms = e.duration_ms;
      tool.diff = e.diff;
      break;
    }
    case "attention":
      if (!turn.attention[e.id]) turn.parts.push({ kind: "attention", id: e.id });
      turn.attention[e.id] = { id: e.id, kind: e.kind, state: e.state, title: e.title, summary: e.summary };
      break;
    case "artifact": {
      const existing = thread.artifacts.find((a) => a.id === e.id);
      const value: Artifact = { id: e.id, kind: e.kind, title: e.title, lang: e.lang, body: e.body, turn_id: e.turn_id, ...(e.path ? { path: e.path } : {}) };
      if (existing) Object.assign(existing, value);
      else {
        thread.artifacts.push(value);
        turn.parts.push({ kind: "artifact", id: e.id });
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
