// The log mirror's format (plan r7, design B; amendment A1): which of an agent's log entries a page may mirror, in
// what normalized shape, and their canonical encoding.  The page normalizes with it before uploading; the mirror's
// Worker validates every upload with the same rules and refuses anything else; a page that pairs again filters the
// agent's log with it before comparing.  No DOM, no network: pure functions, shared by both sides.
//
// Kept (the allowlist, version MIRROR_ALLOWLIST): visible text (the person's messages, the assistant's text); turn
// start, finish and outcome; a tool call's bounded name, status and duration, and its summary when it passes
// safeSummary(); an artifact's kind, title and id (an opaque link: never a path or a body); an approval's kind,
// outcome and safe title; a steer's receipt.  Everything else is filtered out before numbering, and leaves no trace:
// arguments and result bodies, tool output, diffs, thinking, usage, error messages, a card's detail and its page
// token, and any kind not listed here.  A secret pasted in visible text is kept as written: this is not redaction.
//
// Numbering (A1): the agent numbers its log with one counter for the whole process, so one conversation's numbers
// jump.  Each mirrored entry keeps the agent's `seq` (strictly increasing), and gets a mirror position `n`, contiguous
// from 1 per (conversation, log_instance), assigned only to allowlisted entries.

export const MIRROR_SCHEMA = 1;
export const MIRROR_ALLOWLIST = 1;

export const MIRROR_CAPS = Object.freeze({
  /** a segment's canonical plaintext */
  segmentBytes: 256 * 1024,
  /** an upload's body: the segment, as JSON, with room for escaping */
  requestBytes: 320 * 1024,
  entries: 2000,
  /** visible text, in UTF-16 code units */
  text: 192 * 1024,
  /** a summary or title */
  short: 200,
  /** an id: a turn's, a message's, a call's, an artifact's */
  id: 256,
  /** the JSON nesting of a body: the body, its entries, an entry */
  depth: 3,
});

export type MirrorEntry = { n: number; seq: number } & (
  | { k: "user"; id: string; text: string; steer?: true }
  | { k: "receipt"; id: string; state: "steering" | "delivered" | "queued" | "rejected"; reason?: "ended" | "codex" | "idle" }
  | { k: "turn_started"; turn: string }
  | { k: "text"; turn: string; message: string; revision: number; text: string }
  | { k: "message_revised"; turn: string; message: string; revision: number }
  | { k: "message_truncated"; turn: string; message: string; revision: number }
  | { k: "tool_started"; turn: string; call: string; tool: string; summary?: string }
  | { k: "tool_finished"; turn: string; call: string; status: string; duration_ms: number; summary?: string }
  | { k: "approval"; turn: string; id: string; kind: string; state: "open" | "approved" | "denied"; title?: string }
  | { k: "artifact"; turn: string; id: string; kind: "markdown" | "code" | "diff" | "notebook" | "board"; title?: string }
  | { k: "turn_error"; turn: string; code: string }
  | { k: "turn_finished"; turn: string; outcome: "completed" | "interrupted" | "error"; code?: string }
);
/** An entry before the page gives it its position. */
export type MirrorDraft = MirrorEntry extends infer E ? (E extends unknown ? Omit<E, "n"> : never) : never;

/** What an upload's body is: one segment of one stream. */
export interface MirrorBody {
  schema: typeof MIRROR_SCHEMA;
  allowlist: typeof MIRROR_ALLOWLIST;
  log_instance: string;
  entries: MirrorEntry[];
}

// ---- checks

const CODE = /^[a-z0-9_.-]{1,64}$/;
const TOOL = /^[A-Za-z0-9_.:-]{1,128}$/;
const STATUS = /^[a-z_]{1,32}$/;
export const LOG_INSTANCE = /^[A-Za-z0-9_-]{1,64}$/;
const isNat = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isPos = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
/** Well-formed (no lone surrogate) and without control characters but tab, newline and carriage return. */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) return false;
    if (c === 0x7f) return false;
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && wellFormed(v);
const id = (v: unknown): v is string => str(v, MIRROR_CAPS.id) && (v as string).length > 0;

// What a summary or title must not look like to be kept (r7's exclusions): a local path, a URL with credentials,
// a query or a fragment, a key, a token, a long base64 run, a header.  A summary that does is left out, not cut.
const UNSAFE = [
  /(^|[\s"'`(=])(~\/|\/(?!\/))[^\s]*\//, // an absolute or home path (two segments or more; a URL's // is not one)
  /(^|[\s"'`(=])[A-Za-z]:[\\/]/, // a drive path
  /\\\\[^\s]+\\/, // a UNC path
  /[a-z][a-z0-9+.-]*:\/\/[^\s/]*@/i, // a URL with credentials
  /[a-z][a-z0-9+.-]*:\/\/[^\s]*[?#]/i, // a URL with a query or a fragment
  /-----BEGIN [A-Z ]*-----/, // a PEM block
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(authorization|cookie|set-cookie|x-api-key)\s*[:=]/i,
  /\b(sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abpr]|AKIA|ASIA)[-_][A-Za-z0-9_-]{8,}/,
  /[A-Za-z0-9+_-]{40,}/, // a long base64 or hex run: a blob, a key or a token
];
/** A summary or title as the mirror keeps it: bounded, one line, and nothing that looks like a path or a secret. */
export function safeSummary(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s || s.length > MIRROR_CAPS.short || !wellFormed(s)) return undefined;
  return UNSAFE.some((r) => r.test(s)) ? undefined : s;
}

// ---- normalizing an agent's log entry (the page's side)

/** One entry of the agent's log, as chat.replay and the live stream give it. */
export interface LogEntry {
  seq: number;
  method: string;
  params: Record<string, unknown>;
}

const RECEIPT = ["steering", "delivered", "queued", "rejected"] as const;
const REASON = ["ended", "codex", "idle"] as const;
const OUTCOME = ["completed", "interrupted", "error"] as const;
const ART = ["markdown", "code", "diff", "notebook", "board"] as const;
const ATT = ["open", "approved", "denied"] as const;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/**
 * The mirrored form of one agent log entry, or null when the allowlist leaves it out (an excluded or unknown kind, or
 * a field out of bounds: nothing of it is kept).  Only fields named here are ever read.
 */
export function normalize(e: LogEntry): MirrorDraft | null {
  if (!e || !isPos(e.seq) || typeof e.method !== "string" || !e.params || typeof e.params !== "object") return null;
  const p = e.params;
  const seq = e.seq;
  if (e.method === "chat.message") {
    if (p.author !== "person" || !id(p.id) || !str(p.text, MIRROR_CAPS.text)) return null;
    return { k: "user", seq, id: p.id, text: p.text, ...(p.steer === true ? { steer: true as const } : {}) };
  }
  if (e.method === "chat.receipt") {
    if (!id(p.id) || !oneOf(RECEIPT, p.state)) return null;
    return { k: "receipt", seq, id: p.id, state: p.state, ...(oneOf(REASON, p.reason) ? { reason: p.reason } : {}) };
  }
  if (e.method === "chat.rejected") return id(p.id) ? { k: "receipt", seq, id: p.id, state: "rejected" } : null;
  if (e.method !== "turn.event") return null;
  const turn = p.turn_id;
  const ev = p.event as Record<string, unknown> | undefined;
  if (!id(turn) || !ev || typeof ev !== "object") return null;
  switch (ev.type) {
    case "turn_started":
      return { k: "turn_started", seq, turn };
    case "text_delta":
      return id(ev.message) && isNat(ev.revision) && str(ev.text, MIRROR_CAPS.text) ? { k: "text", seq, turn, message: ev.message, revision: ev.revision, text: ev.text } : null;
    case "message_revised":
    case "message_truncated":
      return id(ev.message) && isNat(ev.revision) ? { k: ev.type, seq, turn, message: ev.message, revision: ev.revision } : null;
    case "tool_call_started": {
      if (!id(ev.call) || typeof ev.tool !== "string" || !TOOL.test(ev.tool)) return null;
      const summary = safeSummary(ev.summary);
      return { k: "tool_started", seq, turn, call: ev.call, tool: ev.tool, ...(summary ? { summary } : {}) };
    }
    case "tool_call_finished": {
      if (!id(ev.call) || typeof ev.status !== "string" || !STATUS.test(ev.status) || !isNat(ev.duration_ms)) return null;
      const summary = safeSummary(ev.summary);
      return { k: "tool_finished", seq, turn, call: ev.call, status: ev.status, duration_ms: ev.duration_ms, ...(summary ? { summary } : {}) };
    }
    case "attention": {
      if (!id(ev.id) || typeof ev.kind !== "string" || !CODE.test(ev.kind) || !oneOf(ATT, ev.state)) return null;
      const title = safeSummary(ev.title);
      return { k: "approval", seq, turn, id: ev.id, kind: ev.kind, state: ev.state, ...(title ? { title } : {}) };
    }
    case "artifact": {
      if (!id(ev.id) || !oneOf(ART, ev.kind)) return null;
      const title = safeSummary(ev.title);
      return { k: "artifact", seq, turn, id: ev.id, kind: ev.kind, ...(title ? { title } : {}) };
    }
    case "turn_error":
      return typeof ev.code === "string" && CODE.test(ev.code) ? { k: "turn_error", seq, turn, code: ev.code } : null;
    case "turn_finished":
      if (!oneOf(OUTCOME, ev.outcome)) return null;
      return { k: "turn_finished", seq, turn, outcome: ev.outcome, ...(typeof ev.code === "string" && CODE.test(ev.code) ? { code: ev.code } : {}) };
    default:
      return null;
  }
}

// ---- validating an upload (the Worker's side): exactly the shapes normalize() makes, nothing else

// Each kind's fields: required, then optional.  An entry with any other field is refused (r7 S7: no `verified`).
const SHAPES: Record<MirrorEntry["k"], [string[], string[]]> = {
  user: [["id", "text"], ["steer"]],
  receipt: [["id", "state"], ["reason"]],
  turn_started: [["turn"], []],
  text: [["turn", "message", "revision", "text"], []],
  message_revised: [["turn", "message", "revision"], []],
  message_truncated: [["turn", "message", "revision"], []],
  tool_started: [["turn", "call", "tool"], ["summary"]],
  tool_finished: [["turn", "call", "status", "duration_ms"], ["summary"]],
  approval: [["turn", "id", "kind", "state"], ["title"]],
  artifact: [["turn", "id", "kind"], ["title"]],
  turn_error: [["turn", "code"], []],
  turn_finished: [["turn", "outcome"], ["code"]],
};

/** Whether `e` is exactly an entry normalize() could have made (its n and seq aside). */
export function entryOk(e: unknown): e is MirrorEntry {
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  const x = e as Record<string, unknown>;
  const shape = typeof x.k === "string" && Object.hasOwn(SHAPES, x.k) ? SHAPES[x.k as MirrorEntry["k"]] : undefined;
  if (!shape || !isPos(x.n) || !isPos(x.seq)) return false;
  const [req, opt] = shape;
  for (const key of Object.keys(x)) if (key !== "k" && key !== "n" && key !== "seq" && !req.includes(key) && !opt.includes(key)) return false;
  if (!req.every((key) => Object.hasOwn(x, key))) return false;
  // (rebuilt by normalize's own rules, from the entry as if the agent had logged it: equal, or refused)
  const again = renormalize(x);
  return again !== null && canonical({ ...again, n: x.n }) === canonical(x);
}

/** The agent log entry a mirrored entry stands for, normalized again: the one definition of each kind's bounds. */
function renormalize(x: Record<string, unknown>): MirrorDraft | null {
  const seq = x.seq as number;
  const ev = (type: string, f: Record<string, unknown>) => normalize({ seq, method: "turn.event", params: { turn_id: x.turn, event: { type, ...f } } });
  switch (x.k) {
    case "user":
      if (Object.hasOwn(x, "steer") && x.steer !== true) return null;
      return normalize({ seq, method: "chat.message", params: { author: "person", id: x.id, text: x.text, steer: x.steer } });
    case "receipt":
      if (Object.hasOwn(x, "reason") && !oneOf(REASON, x.reason)) return null;
      return normalize({ seq, method: "chat.receipt", params: { id: x.id, state: x.state, reason: x.reason } });
    case "turn_started":
      return ev("turn_started", {});
    case "text":
      return ev("text_delta", { message: x.message, revision: x.revision, text: x.text });
    case "message_revised":
    case "message_truncated":
      return ev(x.k, { message: x.message, revision: x.revision });
    case "tool_started":
      if (Object.hasOwn(x, "summary") && safeSummary(x.summary) !== x.summary) return null;
      return ev("tool_call_started", { call: x.call, tool: x.tool, summary: x.summary });
    case "tool_finished":
      if (Object.hasOwn(x, "summary") && safeSummary(x.summary) !== x.summary) return null;
      return ev("tool_call_finished", { call: x.call, status: x.status, duration_ms: x.duration_ms, summary: x.summary });
    case "approval":
      if (Object.hasOwn(x, "title") && safeSummary(x.title) !== x.title) return null;
      return ev("attention", { id: x.id, kind: x.kind, state: x.state, title: x.title });
    case "artifact":
      if (Object.hasOwn(x, "title") && safeSummary(x.title) !== x.title) return null;
      return ev("artifact", { id: x.id, kind: x.kind, title: x.title });
    case "turn_error":
      return ev("turn_error", { code: x.code });
    case "turn_finished":
      if (Object.hasOwn(x, "code") && !(typeof x.code === "string" && CODE.test(x.code))) return null;
      return ev("turn_finished", { outcome: x.outcome, code: x.code });
    default:
      return null;
  }
}

export interface Range {
  log_instance: string;
  first_n: number;
  last_n: number;
  first_seq: number;
  last_seq: number;
}

/**
 * An upload's body, checked whole: the exact top-level fields, every entry by entryOk, positions contiguous from the
 * first, agent numbers strictly increasing.  Returns the body and its range, or a reason.  The text must already be
 * bounded (MIRROR_CAPS.requestBytes) by the caller; its nesting is checked before it is parsed.
 */
export function parseBody(text: string): { body: MirrorBody; range: Range } | { error: string } {
  if (!depthOk(text, MIRROR_CAPS.depth)) return { error: "nesting" };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { error: "json" };
  }
  const b = v as Record<string, unknown>;
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "body" };
  const keys = Object.keys(b).sort().join(",");
  if (keys !== "allowlist,entries,log_instance,schema") return { error: "fields" };
  if (b.schema !== MIRROR_SCHEMA || b.allowlist !== MIRROR_ALLOWLIST) return { error: "schema" };
  if (typeof b.log_instance !== "string" || !LOG_INSTANCE.test(b.log_instance)) return { error: "log_instance" };
  const es = b.entries;
  if (!Array.isArray(es) || es.length < 1 || es.length > MIRROR_CAPS.entries) return { error: "entries" };
  for (let i = 0; i < es.length; i++) {
    if (!entryOk(es[i])) return { error: "entry" };
    const e = es[i] as MirrorEntry;
    if (i > 0 && (e.n !== (es[i - 1] as MirrorEntry).n + 1 || e.seq <= (es[i - 1] as MirrorEntry).seq)) return { error: "order" };
  }
  const first = es[0] as MirrorEntry, last = es[es.length - 1] as MirrorEntry;
  return {
    body: b as unknown as MirrorBody,
    range: { log_instance: b.log_instance, first_n: first.n, last_n: last.n, first_seq: first.seq, last_seq: last.seq },
  };
}

/** Whether JSON text nests at most `max` levels of objects and arrays (scanned, not parsed). */
export function depthOk(text: string, max: number): boolean {
  let d = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) {
      if (c === 92) i++; // (a backslash: the next character is escaped)
      else if (c === 34) inStr = false;
    } else if (c === 34) inStr = true;
    else if (c === 123 || c === 91) {
      if (++d > max) return false;
    } else if (c === 125 || c === 93) d--;
  }
  return true;
}

// ---- canonical encoding

/**
 * The canonical JSON of a value made of objects, arrays, strings, safe integers, booleans and null: object keys
 * sorted by code unit, no whitespace, JSON.stringify's string escaping.  A segment's plaintext is the canonical JSON of
 * its body; its digest is the SHA-256 of that, as UTF-8.
 */
export function canonical(v: unknown): string {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("canonical: not a safe integer");
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  throw new Error("canonical: unsupported value");
}

/**
 * The page's segments for a run of normalized drafts, from position `next_n`: each at most MIRROR_CAPS.entries
 * entries and MIRROR_CAPS.segmentBytes of canonical plaintext.  A single entry too big for a segment alone can't be
 * mirrored (its text is within MIRROR_CAPS.text, so this is only a body near the cap): it ends the run, and the
 * caller stops there rather than skip it.
 */
export function segments(log_instance: string, next_n: number, drafts: MirrorDraft[]): { bodies: MirrorBody[]; stuck: boolean } {
  const bodies: MirrorBody[] = [];
  const empty = (): MirrorBody => ({ schema: MIRROR_SCHEMA, allowlist: MIRROR_ALLOWLIST, log_instance, entries: [] });
  const enc = new TextEncoder();
  let cur = empty(), size = enc.encode(canonical(cur)).length, n = next_n;
  for (const d of drafts) {
    const e = { ...d, n } as MirrorEntry;
    const add = enc.encode(canonical(e)).length + 1;
    if (cur.entries.length && (cur.entries.length >= MIRROR_CAPS.entries || size + add > MIRROR_CAPS.segmentBytes)) {
      bodies.push(cur);
      cur = empty();
      size = enc.encode(canonical(cur)).length;
    }
    if (size + add > MIRROR_CAPS.segmentBytes) return { bodies, stuck: true };
    cur.entries.push(e);
    size += add;
    n++;
  }
  if (cur.entries.length) bodies.push(cur);
  return { bodies, stuck: false };
}
