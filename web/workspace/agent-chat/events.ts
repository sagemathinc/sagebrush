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
  | { type: "attention"; id: string; kind: string; state: "open" | "approved" | "denied"; title: string; summary?: string; detail?: string; instance?: string }
  | { type: "artifact"; id: string; kind: "markdown" | "code" | "diff" | "notebook"; title: string; lang?: string; body: string; path?: string }
  | { type: "turn_usage"; usage: { input_tokens: number; output_tokens: number } }
  | { type: "turn_error"; code: string; message: string }
  | { type: "turn_finished"; outcome: TurnOutcome; code?: string }
);
// An event without the stream's own fields, which the page (or the session) assigns.
export type Draft = TurnEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "turn_id"> : never) : never;

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
  instance?: string; // (the page's own token for this card, which its click gives back: agent-cards.ts)
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
  const turn: Turn = { kind: "turn", turn_id, state: "running", parts: [], tools: Object.create(null), attention: Object.create(null), started: time };
  thread.entries.push(turn);
  return turn;
}

function messagePart(turn: Turn, id: string) {
  for (const p of turn.parts) if (p.kind === "message" && p.id === id) return p;
  return undefined;
}

// What an event may carry into the thread, checked as it's applied (turn events come from the agent's side): the kinds
// and states the view knows, an artifact's language as a short name, counts as numbers. A field outside its set is
// replaced by its fallback value, or the event is left out. A tool's or a prompt's id is the agent's: its record is
// read and written as an own property only (own, put), so an id like "__proto__" or "constructor" is an ordinary key, in
// a turn made here (null prototype) and in one kept from before (JSON's, an ordinary object) alike.
export const TOOL_STATUSES = ["running", "ok", "error", "unknown"] as const;
export const ATTENTION_STATES = ["open", "approved", "denied"] as const;
export const ARTIFACT_KINDS = ["markdown", "code", "diff", "notebook"] as const;
const OUTCOMES: readonly TurnOutcome[] = ["completed", "interrupted", "error"];
const oneOf = <T extends string>(v: unknown, xs: readonly T[]): v is T => typeof v === "string" && (xs as readonly string[]).includes(v);
/** An artifact's language as a name the view can show: letters, digits and "+#._-", at most 32; anything else, none. */
export const langOf = (v: unknown): string | undefined => (typeof v === "string" && /^[A-Za-z0-9+#._-]{1,32}$/.test(v) ? v : undefined);
/** A count or a duration as a number the view can show: finite and not negative; anything else, none. */
export const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
/** A record's own entry for `k`, never one inherited (an id like "__proto__" or "toString"). */
export const own = <T,>(rec: Record<string, T> | undefined, k: string): T | undefined => (rec && Object.hasOwn(rec, k) ? rec[k] : undefined);
const put = <T,>(rec: Record<string, T>, k: string, v: T) => { Object.defineProperty(rec, k, { value: v, writable: true, enumerable: true, configurable: true }); };

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
      put(turn.tools, e.call, { call: e.call, tool: e.tool, name: e.name, summary: e.summary, status: "running", output: "" });
      turn.parts.push({ kind: "tool", call: e.call });
      break;
    case "tool_output": {
      const tool = own(turn.tools, e.call);
      if (tool) tool.output += e.text;
      break;
    }
    case "tool_call_finished": {
      const tool = own(turn.tools, e.call);
      if (!tool) break;
      tool.status = oneOf(e.status, TOOL_STATUSES) && e.status !== "running" ? e.status : "unknown";
      if (e.summary != null) tool.summary = e.summary;
      if (e.body != null) tool.output = e.body;
      tool.body_cut = e.body_cut;
      tool.duration_ms = count(e.duration_ms);
      tool.diff = e.diff;
      break;
    }
    case "attention":
      if (!oneOf(e.state, ATTENTION_STATES)) break;
      if (!own(turn.attention, e.id)) turn.parts.push({ kind: "attention", id: e.id });
      put(turn.attention, e.id, { id: e.id, kind: e.kind, state: e.state, title: e.title, summary: e.summary, detail: e.detail, ...(typeof e.instance === "string" ? { instance: e.instance } : {}) });
      break;
    case "artifact": {
      if (!oneOf(e.kind, ARTIFACT_KINDS)) break;
      const existing = thread.artifacts.find((a) => a.id === e.id);
      const value: Artifact = { id: e.id, kind: e.kind, title: e.title, lang: langOf(e.lang), body: e.body, turn_id: e.turn_id, ...(e.path ? { path: e.path } : {}) };
      if (existing) Object.assign(existing, value);
      else {
        thread.artifacts.push(value);
        turn.parts.push({ kind: "artifact", id: e.id });
      }
      break;
    }
    case "turn_usage":
      // (a fresh object of the two counts, each finite and not negative; without an output count, none)
      if (count(e.usage?.output_tokens) !== undefined) turn.usage = { input_tokens: count(e.usage.input_tokens) ?? 0, output_tokens: count(e.usage.output_tokens)! };
      break;
    case "turn_error":
      turn.error = { code: e.code, message: e.message };
      break;
    case "turn_finished":
      turn.outcome = OUTCOMES.includes(e.outcome) ? e.outcome : "error";
      turn.state = turn.outcome;
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
