// What the page accepts from a Delegate host (design/workspace-agent-protocol.md §6.1, `delegate.1`), checked closed
// before any use: each tasks.* result has exactly its listed keys, each value its rule, and an event is one of the
// listed kinds; anything else is refused (TaskShapeError), never shown. The agent checks the page's requests with the
// same rules on its side (sagebrush-agent lib/tasks-schema.mjs).
//
// One reading of §6.1 where it is open: a list entry's and a diff's `round` may be 0 (no proposal yet; the base), as the
// host gives them. A chat turn event inside a task (§6.1 "the chat turn events") is checked here only for its kind and
// form; its fields are checked where it is applied (agent-chat/events.ts), as a Pair turn's are.

export class TaskShapeError extends Error {}
const bad = (m: string): never => { throw new TaskShapeError(m); };

export const TASK_STATUSES = ["working", "proposal", "merged", "closed", "failed", "interrupted"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_LIMITS = Object.freeze({ list: 64, title: 200, text: 64 * 1024, reason: 1024, files: 2000, path: 1024, component: 255, doc: 4 * 2 ** 20 });

const HEX32 = /^[0-9a-f]{32}$/, HEX40 = /^[0-9a-f]{40}$/;
const enc = new TextEncoder();
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function keys(v: unknown, want: readonly string[], what: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!isObj(v)) return bad(`${what} isn't an object`);
  for (const k of Object.keys(v)) if (!want.includes(k) && !optional.includes(k)) bad(`${what}: unknown field ${JSON.stringify(k.slice(0, 40))}`);
  for (const k of want) if (!Object.hasOwn(v, k)) bad(`${what}: missing ${k}`);
  return v;
}
const task = (v: unknown, what = "task") => (typeof v === "string" && HEX32.test(v) ? v : bad(`${what} isn't 32 lowercase hex`));
const oid = (v: unknown, what: string) => (typeof v === "string" && HEX40.test(v) ? v : bad(`${what} isn't 40 lowercase hex`));
const oidOrNull = (v: unknown, what: string) => (v === null ? null : oid(v, what));
const int = (v: unknown, min: number, what: string) => (typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : bad(`${what} isn't an integer of at least ${min}`));
const bool = (v: unknown, what: string) => (typeof v === "boolean" ? v : bad(`${what} isn't true or false`));
const text = (v: unknown, max: number, what: string) => (typeof v === "string" && enc.encode(v).length <= max ? v : bad(`${what} isn't text of at most ${max} bytes`));
const status = (v: unknown, what = "status") => ((TASK_STATUSES as readonly unknown[]).includes(v) ? (v as TaskStatus) : bad(`${what} isn't a task status`));
// (§6.1's path rules, as the host's own checker has them (sagebrush-agent lib/task-paths.mjs pathProblem), and §2's
//  common rule that text is well formed: relative and normalized, no empty, "." or ".." component, no backslash,
//  ":" (drive or ADS), control character or NUL, no lone surrogate, no Windows reserved name (CON, NUL, COM1, ... with
//  any extension), no component ending in a space or dot, no .git (any case) or .sagebrush component, each component at
//  most 255 bytes and the path at most 1,024)
const RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
function path(v: unknown, what: string): string {
  if (typeof v !== "string" || v === "" || enc.encode(v).length > TASK_LIMITS.path) return bad(`${what} isn't a path of 1 to ${TASK_LIMITS.path} bytes`);
  if (LONE_SURROGATE.test(v)) bad(`${what} isn't well-formed text`);
  if (v.startsWith("/") || /[\\:\x00-\x1f\x7f]/.test(v)) bad(`${what} isn't relative, or has a backslash, colon or control character`);
  for (const c of v.split("/")) {
    if (c === "" || c === "." || c === "..") bad(`${what} has an empty, . or .. component`);
    if (enc.encode(c).length > TASK_LIMITS.component) bad(`${what} has a component over ${TASK_LIMITS.component} bytes`);
    if (c.toLowerCase() === ".git" || c === ".sagebrush") bad(`${what} has a .git or .sagebrush component`);
    if (RESERVED.test(c) || /[ .]$/.test(c)) bad(`${what} has a Windows reserved name, or a component ending in a space or dot`);
  }
  return v;
}
function kindFor(p: string, v: unknown, what: string): "notebook" | "file" {
  if (v !== "notebook" && v !== "file") return bad(`${what} isn't "notebook" or "file"`);
  if ((v === "notebook") !== /\.ipynb$/.test(p)) bad(`${what}: a notebook's path ends .ipynb, and only a notebook's`);
  return v;
}

export type TaskEntry = { task: string; title: string; status: TaskStatus; target: "local"; run: boolean; round: number; seq: number; proposal: string | null; question: boolean; updated: number };
export function taskEntry(v: unknown, what = "task"): TaskEntry {
  const o = keys(v, ["task", "title", "status", "target", "run", "round", "seq", "proposal", "question", "updated"], what);
  if (typeof o.title !== "string" || [...o.title].length > TASK_LIMITS.title) bad(`${what}.title isn't text of at most ${TASK_LIMITS.title} characters`);
  if (o.target !== "local") bad(`${what}.target isn't "local"`);
  return { task: task(o.task, `${what}.task`), title: o.title as string, status: status(o.status, `${what}.status`), target: "local", run: bool(o.run, `${what}.run`), round: int(o.round, 0, `${what}.round`), seq: int(o.seq, 0, `${what}.seq`), proposal: oidOrNull(o.proposal, `${what}.proposal`), question: bool(o.question, `${what}.question`), updated: int(o.updated, 0, `${what}.updated`) };
}

export type DiffFile = { path: string; kind: "notebook" | "file"; change: "added" | "modified" | "deleted"; base_blob: string | null; blob: string | null };
function diffFile(v: unknown, what: string): DiffFile {
  const o = keys(v, ["path", "kind", "change", "base_blob", "blob"], what);
  const p = path(o.path, `${what}.path`);
  const change = o.change === "added" || o.change === "modified" || o.change === "deleted" ? o.change : bad(`${what}.change isn't added, modified or deleted`);
  const base_blob = oidOrNull(o.base_blob, `${what}.base_blob`), blob = oidOrNull(o.blob, `${what}.blob`);
  // (each change with the blobs it has: added has no base, deleted has no proposal)
  if ((change === "added") !== (base_blob === null) || (change === "deleted") !== (blob === null)) bad(`${what}: its blobs don't match its change`);
  return { path: p, kind: kindFor(p, o.kind, `${what}.kind`), change, base_blob, blob };
}
function diffFiles(v: unknown, what: string): DiffFile[] {
  if (!Array.isArray(v) || v.length > TASK_LIMITS.files) return bad(`${what} isn't a list of at most ${TASK_LIMITS.files}`);
  const out = v.map((f, i) => diffFile(f, `${what}[${i}]`));
  // (one task's set of paths, as the host's pathSetProblem: none twice ignoring case, and none also another's folder)
  const seen = new Set<string>();
  for (const f of out) { const k = f.path.toLowerCase(); if (seen.has(k)) bad(`${what}: a path twice (case aside)`); seen.add(k); }
  for (const f of out) { const parts = f.path.toLowerCase().split("/"); for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join("/"))) bad(`${what}: a path is also another's folder`); }
  return out;
}

/** A document's content as the host sends it: UTF-8 text, or {base64}; at most 4 MiB of bytes (§6.1: the text's UTF-8
 * bytes, or the base64's decoded bytes). */
export type TaskContent = string | { base64: string };
function content(v: unknown, what: string): TaskContent {
  if (typeof v === "string") {
    // (counted without encoding when it can't be under: 4 MiB of UTF-8 is at least 4 Mi / 3 UTF-16 units, at most 4 Mi)
    if (v.length > TASK_LIMITS.doc || enc.encode(v).length > TASK_LIMITS.doc) bad(`${what} is over ${TASK_LIMITS.doc} bytes`);
    return v;
  }
  if (isObj(v) && Object.keys(v).length === 1 && typeof v.base64 === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(v.base64) && v.base64.length % 4 === 0) {
    const pad = v.base64.endsWith("==") ? 2 : v.base64.endsWith("=") ? 1 : 0;
    if ((v.base64.length / 4) * 3 - pad > TASK_LIMITS.doc) bad(`${what} is over ${TASK_LIMITS.doc} bytes decoded`);
    return { base64: v.base64 };
  }
  return bad(`${what} isn't text or {base64}`);
}

/** Each tasks.* result, checked. */
export const TASK_RESULTS = {
  "tasks.start": (v: unknown) => { const o = keys(v, ["task", "base", "seq"], "result"); return { task: task(o.task), base: oid(o.base, "base"), seq: int(o.seq, 0, "seq") }; },
  "tasks.list": (v: unknown) => {
    const o = keys(v, ["tasks"], "result");
    if (!Array.isArray(o.tasks) || o.tasks.length > TASK_LIMITS.list) return bad(`tasks isn't a list of at most ${TASK_LIMITS.list}`);
    return { tasks: o.tasks.map((t, i) => taskEntry(t, `tasks[${i}]`)) };
  },
  "tasks.get": (v: unknown) => {
    const o = keys(v, ["task", "events", "last", "reset"], "result");
    if (!Array.isArray(o.events)) return bad("events isn't a list");
    const events = o.events.map((e, i) => { const x = keys(e, ["seq", "event"], `events[${i}]`); return { seq: int(x.seq, 1, `events[${i}].seq`), event: taskEvent(x.event, `events[${i}].event`) }; });
    for (let i = 1; i < events.length; i++) if (events[i].seq <= events[i - 1].seq) bad("events aren't in increasing seq");
    return { task: taskEntry(o.task), events, last: int(o.last, 0, "last"), reset: bool(o.reset, "reset") };
  },
  "tasks.diff": (v: unknown) => { const o = keys(v, ["task", "base", "commit", "round", "seq", "files"], "result"); return { task: task(o.task), base: oid(o.base, "base"), commit: oid(o.commit, "commit"), round: int(o.round, 0, "round"), seq: int(o.seq, 0, "seq"), files: diffFiles(o.files, "files") }; },
  "tasks.file": (v: unknown) => { const o = keys(v, ["blob", "content"], "result"); return { blob: oid(o.blob, "blob"), content: content(o.content, "content") }; },
  "tasks.merged": (v: unknown) => {
    const o = keys(v, ["recorded", "commit"], "result");
    if (o.recorded !== "merge" && o.recorded !== "receipt") bad('recorded isn\'t "merge" or "receipt"');
    const commit = oidOrNull(o.commit, "commit");
    if ((o.recorded === "merge") !== (commit !== null)) bad("a merge has its commit, and a receipt none");
    return { recorded: o.recorded as "merge" | "receipt", commit };
  },
  "tasks.close": (v: unknown) => { const o = keys(v, ["status"], "result"); return { status: status(o.status) }; },
  "tasks.ask": (v: unknown) => { const o = keys(v, ["status", "round"], "result"); return { status: status(o.status), round: int(o.round, 0, "round") }; },
  "tasks.stop": (v: unknown) => { const o = keys(v, ["status"], "result"); return { status: status(o.status) }; },
  "tasks.revoke": (v: unknown) => { const o = keys(v, ["status"], "result"); return { status: status(o.status) }; },
  "tasks.resume": (v: unknown) => { const o = keys(v, ["status"], "result"); return { status: status(o.status) }; },
  "tasks.answer": (v: unknown) => { const o = keys(v, ["accepted", "current"], "result"); return { accepted: bool(o.accepted, "accepted"), current: bool(o.current, "current") }; },
} as const;
export type TaskMethod = keyof typeof TASK_RESULTS;
export type TaskResult<M extends TaskMethod> = ReturnType<(typeof TASK_RESULTS)[M]>;

// (the chat turn events, by kind: their fields are agent-chat/events.ts's to check)
const TURN_KINDS = new Set(["turn_started", "turn_state", "message_revised", "text_delta", "message_truncated", "thinking_delta", "tool_call_started", "tool_output", "tool_call_finished", "attention", "artifact", "turn_usage", "turn_info", "turn_error", "turn_finished"]);

export type TaskEvent =
  | { type: "task_status"; status: TaskStatus; reason?: string }
  | { type: "proposal"; round: number; base: string; commit: string; files: DiffFile[] }
  | { type: "question"; qid: number; revision: number; text: string; blocking: boolean; choices?: string[] }
  | { type: "question_withdrawn"; qid: number; revision: number }
  | { type: "question_answered"; qid: number; revision: number; answer_id: string; current: boolean }
  | { type: "turn"; event: Record<string, unknown> };

/** One task event (§6.1), checked: a task's own, or a chat turn event (kind only; see above). */
export function taskEvent(v: unknown, what = "event"): TaskEvent {
  if (!isObj(v) || typeof v.type !== "string") return bad(`${what} isn't an event`);
  switch (v.type) {
    case "task_status": {
      const o = keys(v, ["type", "status"], what, ["reason"]);
      return { type: "task_status", status: status(o.status, `${what}.status`), ...(o.reason !== undefined ? { reason: text(o.reason, TASK_LIMITS.reason, `${what}.reason`) } : {}) };
    }
    case "proposal": {
      const o = keys(v, ["type", "round", "base", "commit", "files"], what);
      return { type: "proposal", round: int(o.round, 1, `${what}.round`), base: oid(o.base, `${what}.base`), commit: oid(o.commit, `${what}.commit`), files: diffFiles(o.files, `${what}.files`) };
    }
    case "question": {
      const o = keys(v, ["type", "qid", "revision", "text", "blocking"], what, ["choices"]);
      let choices: string[] | undefined;
      if (o.choices !== undefined) {
        if (!Array.isArray(o.choices) || o.choices.length > 16) bad(`${what}.choices isn't a list of at most 16`);
        choices = (o.choices as unknown[]).map((c, i) => text(c, 400, `${what}.choices[${i}]`));
      }
      return { type: "question", qid: int(o.qid, 1, `${what}.qid`), revision: int(o.revision, 1, `${what}.revision`), text: text(o.text, TASK_LIMITS.text, `${what}.text`), blocking: bool(o.blocking, `${what}.blocking`), ...(choices ? { choices } : {}) };
    }
    case "question_withdrawn": {
      const o = keys(v, ["type", "qid", "revision"], what);
      return { type: "question_withdrawn", qid: int(o.qid, 1, `${what}.qid`), revision: int(o.revision, 1, `${what}.revision`) };
    }
    case "question_answered": {
      const o = keys(v, ["type", "qid", "revision", "answer_id", "current"], what);
      return { type: "question_answered", qid: int(o.qid, 1, `${what}.qid`), revision: int(o.revision, 1, `${what}.revision`), answer_id: task(o.answer_id, `${what}.answer_id`), current: bool(o.current, `${what}.current`) };
    }
    default:
      if (TURN_KINDS.has(v.type)) return { type: "turn", event: v };
      return bad(`${what}: not a task event (${JSON.stringify(v.type.slice(0, 40))})`);
  }
}

/** A task.event notification's params ({task, seq, event}), checked. */
export function taskNotification(v: unknown): { task: string; seq: number; event: TaskEvent } {
  const o = keys(v, ["task", "seq", "event"], "task.event");
  return { task: task(o.task), seq: int(o.seq, 1, "seq"), event: taskEvent(o.event) };
}

/** A git blob id (SHA-1 of "blob <n>\0" + the bytes), for the page's check of what tasks.file gives. */
export async function blobId(bytes: Uint8Array): Promise<string> {
  const head = enc.encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head);
  all.set(bytes, head.length);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", all));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** A task document's bytes: its text as UTF-8, or its base64 decoded. */
export function contentBytes(c: TaskContent): Uint8Array {
  if (typeof c === "string") return enc.encode(c);
  const bin = atob(c.base64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
