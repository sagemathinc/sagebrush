// What the page accepts from an agent's memory (agent memory v1, design/workspace-agent-protocol.md §7, accepted by the
// agent side), checked closed before any use, as tasks-schema.ts checks Delegate's: each memory.* result has exactly
// its listed keys, each value its rule, and each memory turn event exactly its fields; anything else is refused
// (MemoryShapeError), never shown. Limits are UTF-8 bytes with the metadata (name, description and scope count with
// the body). Note text is data: the page shows it as plain text only.
import { validTagId } from "./agent-tags";

export class MemoryShapeError extends Error {}
const bad = (m: string): never => { throw new MemoryShapeError(m); };

export const MEMORY_FEATURE = "memory.1";
export const MEMORY_METHODS: readonly string[] = ["memory.list", "memory.get", "memory.save", "memory.dismiss", "memory.edit", "memory.delete", "memory.accept"];
export const MEMORY_LIMITS = Object.freeze({ note: 8 * 1024, name: 64, description: 200, listPage: 200, query: 200, pending: 8, used: 64, path: 4096, proposalEvent: 16 * 1024 });
export const NOTE_STATES = ["ok", "expired", "outside_edit", "invalid"] as const;
export type NoteState = (typeof NOTE_STATES)[number];

const HEX32 = /^[0-9a-f]{32}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).length;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function keys(v: unknown, want: readonly string[], what: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!isObj(v)) return bad(`${what} isn't an object`);
  for (const k of Object.keys(v)) if (!want.includes(k) && !optional.includes(k)) bad(`${what}: unknown field ${JSON.stringify(k.slice(0, 40))}`);
  for (const k of want) if (!Object.hasOwn(v, k)) bad(`${what}: missing ${k}`);
  return v;
}
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const text = (v: unknown, max: number, what: string): string =>
  typeof v === "string" && bytes(v) <= max && !LONE_SURROGATE.test(v) && !v.includes("\u0000") ? v : bad(`${what} isn't well-formed text of at most ${max} bytes`);
const hex32 = (v: unknown, what: string) => (typeof v === "string" && HEX32.test(v) ? v : bad(`${what} isn't 32 lowercase hex`));
const int = (v: unknown, min: number, what: string) => (typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : bad(`${what} isn't an integer of at least ${min}`));
const name = (v: unknown, what: string) => (typeof v === "string" && NAME.test(v) ? v : bad(`${what} isn't a note name`));
const description = (v: unknown, what: string) => {
  const s = text(v, MEMORY_LIMITS.description * 4, what);
  return s.length >= 1 && s.length <= MEMORY_LIMITS.description && !/[\r\n]/.test(s) ? s : bad(`${what} isn't one line of 1 to ${MEMORY_LIMITS.description} characters`);
};
// (a time: ms since the epoch, within what a Date holds and a card can draw: up to the last moment of year 9999)
export const TIME_MAX = 253402300799999;
const time = (v: unknown, what: string) => (int(v, 0, what) <= TIME_MAX ? (v as number) : bad(`${what} is past year 9999`));
const expires = (v: unknown, what: string) => (v === null ? null : time(v, what));

export type Scope = "own" | { tag: string };
export function scope(v: unknown, what = "scope"): Scope {
  if (v === "own") return "own";
  const o = keys(v, ["tag"], what);
  return typeof o.tag === "string" && validTagId(o.tag) ? { tag: o.tag } : bad(`${what}.tag isn't a tag id`);
}
const scopeText = (s: Scope) => (s === "own" ? "own" : s.tag);
// (the note's size as the agent counts it: name, description, scope and body together)
const within = (n: { name: string; description: string; body: string; scope: Scope }, what: string) =>
  bytes(n.name) + bytes(n.description) + bytes(n.body) + bytes(scopeText(n.scope)) <= MEMORY_LIMITS.note ? n : bad(`${what} is over ${MEMORY_LIMITS.note} bytes`);

export type NoteEntry = { note: string; scope: Scope; name: string; description: string; bytes: number; revision: number; modified: number; expires: number | null; state: NoteState; proposed_by: string };
function entry(v: unknown, what: string): NoteEntry {
  const o = keys(v, ["note", "scope", "name", "description", "bytes", "revision", "modified", "expires", "state", "proposed_by"], what);
  const state = (NOTE_STATES as readonly unknown[]).includes(o.state) ? (o.state as NoteState) : bad(`${what}.state isn't a note state`);
  return { note: hex32(o.note, `${what}.note`), scope: scope(o.scope, `${what}.scope`), name: name(o.name, `${what}.name`), description: description(o.description, `${what}.description`), bytes: int(o.bytes, 0, `${what}.bytes`), revision: int(o.revision, 1, `${what}.revision`), modified: time(o.modified, `${what}.modified`), expires: expires(o.expires, `${what}.expires`), state, proposed_by: text(o.proposed_by, 80, `${what}.proposed_by`) };
}
export type Note = Omit<NoteEntry, "bytes" | "proposed_by"> & { body: string };
const saved = (v: unknown, what: string) => {
  const o = keys(v, ["note", "revision"], what);
  return { note: hex32(o.note, `${what}.note`), revision: int(o.revision, 1, `${what}.revision`) };
};

/** Each memory.* result, checked closed. */
export const MEMORY_RESULTS = {
  "memory.list": (v: unknown) => {
    const o = keys(v, ["notes", "next", "usage", "path"], "memory.list");
    if (!Array.isArray(o.notes) || o.notes.length > MEMORY_LIMITS.listPage) bad(`memory.list: notes isn't a list of at most ${MEMORY_LIMITS.listPage}`);
    const u = keys(o.usage, ["bytes", "limit"], "memory.list.usage");
    return { notes: (o.notes as unknown[]).map((n, i) => entry(n, `notes[${i}]`)), next: o.next === null ? null : hex32(o.next, "next"), usage: { bytes: int(u.bytes, 0, "usage.bytes"), limit: int(u.limit, 1, "usage.limit") }, path: text(o.path, MEMORY_LIMITS.path, "path") };
  },
  "memory.get": (v: unknown): Note => {
    const o = keys(v, ["note", "scope", "name", "description", "body", "revision", "modified", "expires", "state"], "memory.get", ["bytes", "proposed_by"]);
    const { body: _body, ...rest } = o;
    const e = entry({ bytes: 0, proposed_by: "", ...rest }, "memory.get");
    const n = { note: e.note, scope: e.scope, name: e.name, description: e.description, body: text(o.body, MEMORY_LIMITS.note, "body"), revision: e.revision, modified: e.modified, expires: e.expires, state: e.state };
    within(n, "memory.get");
    return n;
  },
  "memory.save": (v: unknown) => saved(v, "memory.save"),
  "memory.edit": (v: unknown) => saved(v, "memory.edit"),
  "memory.accept": (v: unknown) => saved(v, "memory.accept"),
  "memory.dismiss": (v: unknown) => { keys(v, [], "memory.dismiss"); return {}; },
  "memory.delete": (v: unknown) => { const o = keys(v, ["deleted"], "memory.delete"); return o.deleted === true ? { deleted: true as const } : bad("memory.delete: deleted isn't true"); },
} as const;

export type MemoryProposal = { type: "memory_proposal"; pending: string; revision: number; op: "new" | "edit"; note?: string; scope: Scope; name: string; description: string; body: string; expires: number | null };
export type MemoryDecided = { type: "memory_decided"; pending: string; outcome: "saved" | "dismissed" | "stale"; note?: string };
export type MemoryUsed = { type: "memory_used"; notes: { note: string; name: string; revision: number }[] };
export type MemoryEvent = MemoryProposal | MemoryDecided | MemoryUsed;
export const MEMORY_EVENTS = ["memory_proposal", "memory_decided", "memory_used"] as const;

/** A memory turn event, checked closed (its turn fields, seq and turn_id, are the chat's). */
export function memoryEvent(v: unknown): MemoryEvent {
  const t = isObj(v) ? v.type : undefined;
  if (t === "memory_proposal") {
    const o = keys(v, ["type", "pending", "revision", "op", "scope", "name", "description", "body", "expires"], "memory_proposal", ["note", "seq", "turn_id"]);
    if (bytes(JSON.stringify(v)) > MEMORY_LIMITS.proposalEvent) bad("memory_proposal is over its encoded bound");
    const op = o.op === "new" || o.op === "edit" ? o.op : bad("memory_proposal.op isn't new or edit");
    if ((op === "edit") !== (o.note !== undefined)) bad("memory_proposal: an edit names its note, and only an edit");
    const p: MemoryProposal = { type: "memory_proposal", pending: hex32(o.pending, "pending"), revision: int(o.revision, 1, "revision"), op, ...(o.note !== undefined ? { note: hex32(o.note, "note") } : {}), scope: scope(o.scope), name: name(o.name, "name"), description: description(o.description, "description"), body: text(o.body, MEMORY_LIMITS.note, "body"), expires: expires(o.expires, "expires") };
    within(p, "memory_proposal");
    return p;
  }
  if (t === "memory_decided") {
    const o = keys(v, ["type", "pending", "outcome"], "memory_decided", ["note", "seq", "turn_id"]);
    const outcome = o.outcome === "saved" || o.outcome === "dismissed" || o.outcome === "stale" ? o.outcome : bad("memory_decided.outcome isn't saved, dismissed or stale");
    if ((outcome === "saved") !== (o.note !== undefined)) bad("memory_decided: a save names its note, and only a save");
    return { type: "memory_decided", pending: hex32(o.pending, "pending"), outcome, ...(o.note !== undefined ? { note: hex32(o.note, "note") } : {}) };
  }
  if (t === "memory_used") {
    const o = keys(v, ["type", "notes"], "memory_used", ["seq", "turn_id"]);
    if (!Array.isArray(o.notes) || o.notes.length < 1 || o.notes.length > MEMORY_LIMITS.used) bad(`memory_used: notes isn't a list of 1 to ${MEMORY_LIMITS.used}`);
    return { type: "memory_used", notes: (o.notes as unknown[]).map((n, i) => { const x = keys(n, ["note", "name", "revision"], `notes[${i}]`); return { note: hex32(x.note, `notes[${i}].note`), name: name(x.name, `notes[${i}].name`), revision: int(x.revision, 1, `notes[${i}].revision`) }; }) };
  }
  return bad("not a memory event");
}
