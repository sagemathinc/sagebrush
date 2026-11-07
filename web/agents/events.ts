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
  // the entry's charge (BH-1: see Ledger below) and whether its text was cut to fit
  size?: number;
  cut?: boolean;
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
  // a diff too large to keep whole (BH-1): not kept, said
  diff_cut?: boolean;
  // its charge: its fields', and its output's
  size?: number;
  osize?: number;
}

export interface Attention {
  id: string;
  kind: string;
  state: "open" | "approved" | "denied";
  title: string;
  summary?: string;
  detail?: string; // all of the request's arguments, for the person to review
  size?: number;
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
  // BH-1: a body too large to keep: a diff's or a notebook's is never cut (it would no longer parse), so it is left out
  // (`omitted`, its length), and a text one keeps its start (`truncated`, its whole length); both are said
  omitted?: number;
  truncated?: number;
  size?: number;
}

// A turn's parts in arrival order: what the page lays out top to bottom.
export type Part =
  | { kind: "thinking"; text: string; cut?: boolean }
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
  // what of this turn wasn't kept (BH-1), for the page to say so: parts, tools and requests past their counts, and text
  // events cut to fit
  cut?: { parts?: number; tools?: number; attention?: number; text?: number };
  size?: number;
}

export interface Thread {
  id: string;
  title: string;
  entries: (UserEntry | Turn)[];
  artifacts: Artifact[];
  applied_seq: number;
  // how many of its oldest entries and artifacts aren't kept, and artifact bodies left out (BH-1), for the page to say so
  dropped?: { entries: number; artifacts: number; bodies?: number };
  size?: number;
}

/** What all the chats lost to their bounds, kept with them (saved), for the page to say on every chat. */
export interface Lost {
  threads: number;
  entries: number;
  running: number;
  artifacts: number;
  bodies: number;
  parts: number;
  text: number;
}
/** All the chats: the saved form, and the ledger their bounds are charged to (BH-1). */
export interface Chats {
  threads: Thread[];
  current: string;
  lost?: Lost;
  size?: number;
}

// ---------------------------------------------------------------------------
// BH-1: no history grows without bounds (William, Nov 3).  Every string kept is CHARGED as it is admitted: its JSON
// length (escapes included, UTF-16 code units, as localStorage stores it), plus a fixed overhead for each object (its
// keys and numbers), to the turn, the chat and all the chats (`Chats.size`).  The charge is an upper bound on the saved
// JSON, so the cap holds for what is saved, checked at every admission, never later; nothing is serialized whole to
// check it.  Past a cap the oldest goes first, in a fixed order (Ledger.evict): finished entries, then artifact bodies,
// then whole chats not in use, then, last, running turns; each step bounded, and every loss counted (Lost, and each
// chat's and turn's own counts) for the page to say.  A new message is never refused (@sagebrush's ruling): if nothing
// can go, what arrives is cut to what fits, and said.
export const CHAT_BOUNDS = {
  threads: 200,
  entries: 1000, // per chat (the dense window)
  parts: 2000, // per turn
  tools: 1000, // per turn
  attention: 200, // per turn
  artifacts: 100, // per chat
  text: 256 * 1024, // one message, thinking part, tool output, user entry or artifact body (code units)
  meta: 1024, // one name, id, title, summary, status, error, path (code units)
  detail: 16 * 1024, // one request's detail
  turn: 512 * 1024, // one turn's charge
  chatArtifacts: 512 * 1024, // one chat's artifact bodies
  total: 1792 * 1024, // all the chats' charge: 3.5 MiB saved (2 bytes a code unit), under `bytes`
  bytes: 4 * 2 ** 20, // the saved JSON, in bytes
  evictSteps: 64, // evictions at most per admission (bounded work: each O(chats))
} as const;
export type ChatBounds = { [K in keyof typeof CHAT_BOUNDS]: number };
// (each object's fixed charge: its keys, punctuation and numbers, at their longest)
const OVER = { thread: 200, entry: 120, turn: 260, part: 90, tool: 220, attention: 160, artifact: 200 } as const;

/** A string's charge: its JSON text's length less the quotes (each escape counted as written). */
export const esc = (s: string) => JSON.stringify(s).length - 2;
// (the longest start of `s` whose charge is at most `units`)
function fitTo(s: string, units: number): string {
  if (esc(s) <= units) return s;
  let lo = 0, hi = Math.min(s.length, units);
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (esc(s.slice(0, mid)) <= units) lo = mid; else hi = mid - 1; }
  // (never half a surrogate pair)
  const c = s.charCodeAt(lo - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? lo - 1 : lo);
}
const metaOf = (s: string | undefined, B: ChatBounds) => (s == null ? s : s.slice(0, B.meta));
const lostOf = (L: Chats): Lost => (L.lost ??= { threads: 0, entries: 0, running: 0, artifacts: 0, bodies: 0, parts: 0, text: 0 });
const droppedOf = (t: Thread) => (t.dropped ??= { entries: 0, artifacts: 0 });
const cutOf = (turn: Turn) => (turn.cut ??= {});
const isRunning = (e: UserEntry | Turn) => e.kind === "turn" && !e.outcome;
const entryTime = (e: UserEntry | Turn) => (e.kind === "user" ? e.time : e.started);
const usedAt = (t: Thread) => { const e = t.entries[t.entries.length - 1]; return e ? (e.kind === "user" ? e.time : (e.finished ?? e.started)) : 0; };

/**
 * The ledger's operations on `L` (all the chats).  `keep`: the chats never let go whole (the current one; the page's
 * running ones), `B`: the bounds (tests pass smaller ones).
 */
export class Ledger {
  constructor(public L: Chats, public B: ChatBounds = CHAT_BOUNDS, public keep: () => Set<string> = () => new Set([L.current])) {
    L.size ??= measure(L, B);
  }
  // (`units` more for `thread` (and `turn`): what may be granted, room made for it first; never past the turn's
  // subcap or the total)
  grant(thread: Thread, turn: Turn | null, units: number): number {
    const { L, B } = this;
    let want = Math.max(0, units);
    if (turn) want = Math.min(want, Math.max(0, B.turn - (turn.size ?? 0)));
    if ((L.size ?? 0) + want > B.total) this.evict((L.size ?? 0) + want - B.total, thread, turn);
    want = Math.min(want, Math.max(0, B.total - (L.size ?? 0)));
    this.add(thread, turn, want);
    return want;
  }
  add(thread: Thread | null, turn: Turn | null, units: number) {
    this.L.size = (this.L.size ?? 0) + units;
    if (thread) thread.size = (thread.size ?? 0) + units;
    if (turn) turn.size = (turn.size ?? 0) + units;
  }
  /**
   * Room for `need` units, the oldest first, in this order, at most B.evictSteps steps: (1) a finished entry (the oldest
   * of all the chats), (2) an artifact's body (the oldest), (3) a whole chat not kept (least recently used), (4) last, a
   * running turn (the oldest; never `turn`, the one being added to).  Each counted in Lost.
   */
  evict(need: number, thread: Thread | null, turn: Turn | null) {
    const { L, B } = this;
    for (let step = 0; need > 0 && step < B.evictSteps; step++) {
      const freed = this.dropOldestEntry(false, turn) || this.dropOldestBody(null) || this.dropLeastUsedThread(thread) || this.dropOldestEntry(true, turn);
      if (!freed) break;
      need -= freed;
    }
  }
  private dropOldestEntry(running: boolean, spare: Turn | null): number {
    let best: { t: Thread; i: number; at: number } | null = null;
    for (const t of this.L.threads) {
      const i = t.entries.findIndex((e) => isRunning(e) === running && e !== spare);
      if (i < 0) continue;
      const at = entryTime(t.entries[i]);
      if (!best || at < best.at) best = { t, i, at };
    }
    if (!best) return 0;
    return this.removeEntry(best.t, best.i, running);
  }
  removeEntry(t: Thread, i: number, running = isRunning(t.entries[i])): number {
    const [e] = t.entries.splice(i, 1);
    const units = e.size ?? 0;
    this.add(t, null, -units);
    droppedOf(t).entries++;
    const lost = lostOf(this.L);
    if (running) lost.running++; else lost.entries++;
    return Math.max(1, units);
  }
  // (the oldest artifact body kept, of `only`'s chat or of all; left out, its placeholder kept)
  dropOldestBody(only: Thread | null, spare?: Artifact): number {
    for (const t of only ? [only] : this.L.threads) {
      // (the chats in order are oldest first enough for a bounded step: the first chat holding a body)
      const a = t.artifacts.find((x) => x !== spare && x.body.length > 0);
      if (!a) continue;
      return this.omitBody(t, a);
    }
    return 0;
  }
  omitBody(t: Thread, a: Artifact): number {
    const units = esc(a.body);
    a.omitted = a.truncated ?? a.body.length;
    delete a.truncated;
    a.body = "";
    a.size = (a.size ?? 0) - units;
    this.add(t, null, -units);
    droppedOf(t).bodies = (droppedOf(t).bodies ?? 0) + 1;
    lostOf(this.L).bodies++;
    return Math.max(1, units);
  }
  private dropLeastUsedThread(spare: Thread | null): number {
    const keep = this.keep();
    let k = -1;
    this.L.threads.forEach((t, i) => { if (t !== spare && !keep.has(t.id) && (k < 0 || usedAt(t) < usedAt(this.L.threads[k]))) k = i; });
    if (k < 0) return 0;
    const [t] = this.L.threads.splice(k, 1);
    this.add(null, null, -(t.size ?? 0));
    lostOf(this.L).threads++;
    return Math.max(1, t.size ?? 0);
  }
  /** A chat's entries within its count (a new one never refused): the oldest finished, else the oldest running. */
  boundEntries(t: Thread, spare: Turn | null = null) {
    while (t.entries.length > this.B.entries) {
      let i = t.entries.findIndex((e) => !isRunning(e));
      if (i < 0) i = t.entries.findIndex((e) => e !== spare);
      if (i < 0) break;
      this.removeEntry(t, i);
    }
  }
  /** A new chat, within the count of chats (the least recently used not kept let go). */
  newThread(id: string, title: string): Thread {
    while (this.L.threads.length >= this.B.threads && this.dropLeastUsedThread(null));
    const t = newThread(id, title.slice(0, this.B.meta));
    t.size = 0;
    this.L.threads.push(t);
    this.grant(t, null, OVER.thread + esc(t.id) + esc(t.title));
    return t;
  }
  /** The person's own entry: its text within `text` and what fits (cut, said), the chat within its count. */
  addUser(t: Thread, e: UserEntry): UserEntry {
    const B = this.B;
    let text = e.text.slice(0, B.text);
    const fixed = OVER.entry + esc(e.id.slice(0, B.meta));
    const want = fixed + esc(text);
    const got = this.grant(t, null, want);
    if (got < want) {
      text = fitTo(text, Math.max(0, got - fixed));
      this.add(t, null, fixed + esc(text) - got);
    }
    const entry: UserEntry = { ...e, id: e.id.slice(0, B.meta), text, size: fixed + esc(text), ...(text.length < e.text.length ? { cut: true } : {}) };
    if (entry.cut) lostOf(this.L).text++;
    t.entries.push(entry);
    this.boundEntries(t);
    return entry;
  }
  /** `add` appended to `have` within `max` code units and what the turn and the total allow; whether some was cut. */
  appendText(t: Thread, turn: Turn, have: string, add: string, max: number): [string, boolean] {
    let piece = add.slice(0, Math.max(0, max - have.length));
    const want = esc(piece);
    const got = this.grant(t, turn, want);
    if (got < want) {
      piece = fitTo(piece, got);
      this.add(t, turn, esc(piece) - got);
    }
    const cut = piece.length < add.length;
    if (cut) { cutOf(turn).text = (cutOf(turn).text ?? 0) + 1; lostOf(this.L).text++; }
    return [have + piece, cut];
  }
  /** A charged string replaced: `next`, within `max` and what's allowed (cut to fit), the old one's charge refunded. */
  setText(t: Thread, turn: Turn | null, prev: string | undefined, next: string | undefined, max: number): string | undefined {
    if (prev) this.add(t, turn, -esc(prev));
    if (next == null) return next;
    let s = next.slice(0, max);
    const want = esc(s), got = this.grant(t, turn, want);
    if (got < want) { s = fitTo(s, got); this.add(t, turn, esc(s) - got); }
    if (s.length < next.length && turn) cutOf(turn).text = (cutOf(turn).text ?? 0) + 1;
    return s;
  }
}

/** The charge of all the chats as saved (and each chat's, turn's, entry's and artifact's set): for chats loaded. */
export function measure(L: Chats, B: ChatBounds = CHAT_BOUNDS): number {
  let total = 200;
  for (const t of L.threads) {
    let ts = OVER.thread + esc(t.id) + esc(t.title ?? "");
    for (const e of t.entries) { e.size = esc(JSON.stringify(e)) + OVER.entry; ts += e.size; }
    for (const a of t.artifacts) { a.size = esc(JSON.stringify(a)) + OVER.artifact; ts += a.size; }
    t.size = ts;
    total += ts;
  }
  return total;
}
/**
 * Chats loaded (saved before their bounds, or by another version) within them: each chat's count, the count of chats,
 * and the total charge, the oldest going first as at admission; every loss counted.  A loaded chat's sizes are measured
 * once (bounded by what localStorage can hold).  Returns the ledger.
 */
export function boundLoaded(L: Chats, keep: () => Set<string>, B: ChatBounds = CHAT_BOUNDS): Ledger {
  L.size = measure(L, B);
  const g = new Ledger(L, B, keep);
  for (const t of L.threads) {
    g.boundEntries(t);
    while (t.artifacts.length > B.artifacts) { const [a] = t.artifacts.splice(0, 1); g.add(t, null, -(a.size ?? 0)); droppedOf(t).artifacts++; lostOf(L).artifacts++; }
  }
  while (L.threads.length > B.threads) { const before = L.threads.length; g.evict(1, null, null); if (L.threads.length === before) { const k = L.threads.findIndex((t) => !keep().has(t.id)); if (k < 0) break; const [t] = L.threads.splice(k, 1); g.add(null, null, -(t.size ?? 0)); lostOf(L).threads++; } }
  while ((L.size ?? 0) > B.total) { const before = L.size; g.evict((L.size ?? 0) - B.total, null, null); if (L.size === before) break; }
  return g;
}

export function newThread(id: string, title: string): Thread {
  return { id, title, entries: [], artifacts: [], applied_seq: 0 };
}

function turnOf(g: Ledger, thread: Thread, turn_id: string, time: number): Turn {
  for (let i = thread.entries.length - 1; i >= 0; i--) {
    const e = thread.entries[i];
    if (e.kind === "turn" && e.turn_id === turn_id) return e;
  }
  const turn: Turn = { kind: "turn", turn_id: turn_id.slice(0, g.B.meta), state: "running", parts: [], tools: {}, attention: {}, started: time, size: 0 };
  thread.entries.push(turn);
  g.grant(thread, turn, OVER.turn + esc(turn.turn_id));
  g.boundEntries(thread, turn);
  return turn;
}

function messagePart(turn: Turn, id: string) {
  for (const p of turn.parts) if (p.kind === "message" && p.id === id) return p;
  return undefined;
}

// (a tool's own fields' charge, its output's apart)
const toolFields = (x: ToolCall) => OVER.tool + esc(x.call) + esc(x.tool) + esc(x.name ?? "") + esc(x.summary ?? "") + esc(x.status) + (x.diff ? esc(x.diff.path) + esc(x.diff.before) + esc(x.diff.after) : 0);
const attentionFields = (x: Attention) => OVER.attention + esc(x.id) + esc(x.kind) + esc(x.state) + esc(x.title) + esc(x.summary ?? "") + esc(x.detail ?? "");
const artifactFields = (x: Artifact) => OVER.artifact + esc(x.id) + esc(x.kind) + esc(x.title) + esc(x.lang ?? "") + esc(x.turn_id) + esc(x.path ?? "");
// (an object's fields charged exactly: if they don't all fit, its optional fields are let go, one at a time, in
// `shrink`'s order, until they do; every step but the last is said by the caller.  Returns its charge, or -1 when even
// the essential fields don't fit (the caller then doesn't keep it))
function chargeFields<T>(g: Ledger, thread: Thread, turn: Turn | null, x: T, fields: (x: T) => number, shrink: ((x: T) => void)[]): number {
  for (let i = 0; ; i++) {
    const units = fields(x), got = g.grant(thread, turn, units);
    if (got >= units) return units;
    g.add(thread, turn, -got);
    if (i >= shrink.length) return -1;
    shrink[i](x);
  }
}

// Applies one event, within the bounds of `g`'s chats (a ledger of its own when none is given: this chat alone). A
// duplicate (seq <= applied_seq) is dropped; a gap
// (seq > applied_seq + 1) is refused, false: the caller asks again from applied_seq.
export function apply(thread: Thread, e: TurnEvent, time = Date.now(), g?: Ledger): boolean {
  if (e.seq <= thread.applied_seq) return true;
  if (e.seq !== thread.applied_seq + 1) return false;
  g ??= new Ledger({ threads: [thread], current: thread.id });
  const B = g.B;
  thread.applied_seq = e.seq;
  const turn = turnOf(g, thread, e.turn_id, time);
  const last = turn.parts[turn.parts.length - 1];
  // (a new part only under its count; past it, counted: the page says so)
  const room = (units: number) => {
    if (turn.parts.length >= B.parts) { cutOf(turn).parts = (cutOf(turn).parts ?? 0) + 1; lostOf(g.L).parts++; return false; }
    if (g.grant(thread, turn, units) < units) { cutOf(turn).parts = (cutOf(turn).parts ?? 0) + 1; lostOf(g.L).parts++; return false; }
    return true;
  };
  switch (e.type) {
    case "turn_started":
      turn.state = "running";
      break;
    case "turn_state":
      turn.state = g.setText(thread, turn, turn.state, e.state, B.meta) ?? "running";
      break;
    case "message_revised": {
      const part = messagePart(turn, e.message);
      if (part) {
        g.add(thread, turn, -esc(part.text));
        part.revision = e.revision;
        part.text = "";
        part.truncated = false;
      } else {
        const id = e.message.slice(0, B.meta);
        if (room(OVER.part + esc(id))) turn.parts.push({ kind: "message", id, revision: e.revision, text: "", truncated: false });
      }
      break;
    }
    case "text_delta": {
      const part = messagePart(turn, e.message.slice(0, B.meta));
      if (part && part.revision === e.revision) {
        const [text, cut] = g.appendText(thread, turn, part.text, e.text, B.text);
        part.text = text;
        if (cut) part.truncated = true;
      }
      break;
    }
    case "message_truncated": {
      const part = messagePart(turn, e.message.slice(0, B.meta));
      if (part) part.truncated = true;
      break;
    }
    case "thinking_delta":
      if (last?.kind === "thinking") {
        const [text, cut] = g.appendText(thread, turn, last.text, e.text, B.text);
        last.text = text;
        if (cut) last.cut = true;
      } else if (room(OVER.part)) {
        const p: Part & { kind: "thinking" } = { kind: "thinking", text: "" };
        const [text, cut] = g.appendText(thread, turn, "", e.text, B.text);
        p.text = text;
        if (cut) p.cut = true;
        turn.parts.push(p);
      }
      break;
    case "tool_call_started": {
      if (Object.keys(turn.tools).length >= B.tools) { cutOf(turn).tools = (cutOf(turn).tools ?? 0) + 1; lostOf(g.L).parts++; break; }
      const x: ToolCall = { call: e.call.slice(0, B.meta), tool: e.tool.slice(0, B.meta), name: metaOf(e.name, B), summary: metaOf(e.summary, B), status: "running", output: "" };
      const units = toolFields(x);
      if (!room(OVER.part + esc(x.call) + units)) break;
      x.size = units;
      x.osize = 0;
      turn.tools[x.call] = x;
      turn.parts.push({ kind: "tool", call: x.call });
      break;
    }
    case "tool_output": {
      const tool = turn.tools[e.call.slice(0, B.meta)];
      if (tool) {
        const before = esc(tool.output);
        const [output, cut] = g.appendText(thread, turn, tool.output, e.text, B.text);
        tool.output = output;
        tool.osize = (tool.osize ?? 0) + esc(output) - before;
        if (cut) tool.body_cut = true;
      }
      break;
    }
    case "tool_call_finished": {
      const tool = turn.tools[e.call.slice(0, B.meta)];
      if (!tool) break;
      // (its fields re-charged as they now are: what doesn't fit (its diff, then summary, then name) let go, said; its
      // body, when it comes, in place of its output)
      g.add(thread, turn, -(tool.size ?? 0));
      tool.status = e.status.slice(0, 64);
      if (e.summary != null) tool.summary = e.summary.slice(0, B.meta);
      tool.duration_ms = e.duration_ms;
      tool.diff = undefined;
      if (e.diff) {
        const d = { path: e.diff.path.slice(0, B.meta), before: e.diff.before, after: e.diff.after };
        // (a diff is kept whole or not at all: half a diff would say something false)
        if (d.before.length + d.after.length <= B.text) tool.diff = d; else tool.diff_cut = true;
      }
      const said = () => { cutOf(turn).text = (cutOf(turn).text ?? 0) + 1; };
      tool.size = chargeFields(g, thread, turn, tool, toolFields, [
        (x) => { if (x.diff) { x.diff = undefined; x.diff_cut = true; } said(); },
        (x) => { x.summary = undefined; said(); },
        (x) => { x.name = undefined; x.status = ""; said(); },
      ]);
      // (its essential fields were charged before (refunded above), so they always fit again)
      if (tool.size < 0) tool.size = 0;
      if (e.body != null) {
        g.add(thread, turn, -(tool.osize ?? 0));
        const [output, cut] = g.appendText(thread, turn, "", e.body, B.text);
        tool.output = output;
        tool.osize = esc(output);
        if (cut) tool.body_cut = true;
      }
      if (e.body_cut) tool.body_cut = true;
      break;
    }
    case "attention": {
      const id = e.id.slice(0, B.meta);
      const x: Attention = { id, kind: e.kind.slice(0, B.meta), state: e.state, title: e.title.slice(0, B.meta), summary: metaOf(e.summary, B), detail: e.detail?.slice(0, B.detail) };
      const prev = turn.attention[id];
      if (!prev) {
        if (Object.keys(turn.attention).length >= B.attention) { cutOf(turn).attention = (cutOf(turn).attention ?? 0) + 1; lostOf(g.L).parts++; break; }
        const units = attentionFields(x);
        if (!room(OVER.part + esc(id) + units)) break;
        x.size = units;
        turn.parts.push({ kind: "attention", id });
      } else {
        g.add(thread, turn, -(prev.size ?? 0));
        // (no room now: the decision kept, its detail, then summary, then title left out, said)
        const said = () => { cutOf(turn).text = (cutOf(turn).text ?? 0) + 1; };
        x.size = chargeFields(g, thread, turn, x, attentionFields, [(y) => { y.detail = undefined; said(); }, (y) => { y.summary = undefined; said(); }, (y) => { y.title = ""; said(); }]);
        if (x.size < 0) x.size = 0;
      }
      turn.attention[id] = x;
      if (x.detail !== undefined && e.detail && x.detail.length < e.detail.length) cutOf(turn).text = (cutOf(turn).text ?? 0) + 1;
      break;
    }
    case "artifact": {
      const id = e.id.slice(0, B.meta);
      const existing = thread.artifacts.find((a) => a.id === id);
      const value: Artifact = { id, kind: e.kind, title: e.title.slice(0, B.meta), lang: metaOf(e.lang, B), body: "", turn_id: e.turn_id.slice(0, B.meta), ...(e.path ? { path: e.path.slice(0, B.meta) } : {}) };
      if (existing) { g.add(thread, null, -(existing.size ?? 0)); Object.assign(existing, value, { omitted: undefined, truncated: undefined }); }
      else {
        if (!room(OVER.part + esc(id))) break;
        thread.artifacts.push(value);
        turn.parts.push({ kind: "artifact", id });
        while (thread.artifacts.length > B.artifacts) {
          const [a] = thread.artifacts.splice(0, 1);
          g.add(thread, null, -(a.size ?? 0));
          droppedOf(thread).artifacts++;
          lostOf(g.L).artifacts++;
        }
      }
      const a = existing ?? value;
      const said = () => { cutOf(turn).text = (cutOf(turn).text ?? 0) + 1; };
      let units = chargeFields(g, thread, null, a, artifactFields, [(y) => { y.lang = undefined; y.title = ""; said(); }, (y) => { delete y.path; said(); }]);
      if (units < 0) {
        // (not even its id fits: not kept, counted)
        thread.artifacts.splice(thread.artifacts.indexOf(a), 1);
        droppedOf(thread).artifacts++;
        lostOf(g.L).artifacts++;
        break;
      }
      // the body: within `text` and the chat's artifact budget (older bodies of this chat left out first), and the total
      const structured = e.kind === "diff" || e.kind === "notebook";
      const bodies = () => thread.artifacts.reduce((n, x) => n + esc(x.body), 0);
      let body = e.body;
      if (body.length > B.text) {
        if (structured) { a.omitted = body.length; body = ""; } else { a.truncated = body.length; body = body.slice(0, B.text); }
      }
      const want = esc(body);
      while (bodies() + want > B.chatArtifacts && g.dropOldestBody(thread, a));
      const got = want ? g.grant(thread, null, Math.min(want, Math.max(0, B.chatArtifacts - bodies()))) : 0;
      if (got < want) {
        if (structured) { g.add(thread, null, -got); a.omitted = e.body.length; body = ""; }
        else { body = fitTo(body, got); g.add(thread, null, esc(body) - got); a.truncated = e.body.length; }
      }
      a.body = body;
      a.size = units + esc(body);
      if (a.omitted !== undefined || a.truncated !== undefined) { droppedOf(thread).bodies = (droppedOf(thread).bodies ?? 0) + 1; lostOf(g.L).bodies++; }
      break;
    }
    case "turn_usage":
      turn.usage = { input_tokens: Number(e.usage.input_tokens) || 0, output_tokens: Number(e.usage.output_tokens) || 0 };
      break;
    case "turn_error": {
      const prev = turn.error;
      if (prev) g.add(thread, turn, -(esc(prev.code) + esc(prev.message)));
      const err = { code: e.code.slice(0, B.meta), message: e.message.slice(0, B.meta) };
      const units = esc(err.code) + esc(err.message), got = g.grant(thread, turn, units);
      turn.error = got < units ? { code: fitTo(err.code, got), message: "" } : err;
      if (got < units) g.add(thread, turn, esc(turn.error.code) - got);
      break;
    }
    case "turn_finished":
      turn.outcome = e.outcome;
      turn.state = g.setText(thread, turn, turn.state, e.outcome, B.meta) ?? e.outcome;
      turn.finished = time;
      for (const tool of Object.values(turn.tools)) if (tool.status === "running") { g.add(thread, turn, esc("unknown") - esc(tool.status)); tool.status = "unknown"; tool.size = (tool.size ?? 0) + esc("unknown") - esc("running"); }
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
