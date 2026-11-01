// An agent's edit of a notebook (A12 step 1, plan /scratch/sagebrush-reviews/agents-panel/a12-step1-r2*): the cells it
// names changed, inserted or removed, every other cell kept exactly as it is, outputs too.  Pure: the closed grammar,
// the cells' hashes, and the preflight of a whole edit against the live document before anything changes.
//
// - The grammar: {conversation, path, ref, base, set?: [{id, source?, type?}], insert?: [{source, type?, after}],
//   remove?: [id], was: {id: sha256}}; type "code" | "markdown"; nothing else, anywhere.
// - Three-way: `ref` is the document the agent read, `was` each named cell's hash as read.  A named cell the person
//   changed (or removed) since refuses the whole edit; a cell it doesn't name isn't looked at, so what the person did
//   there is kept.
// - Refused whole, with nothing changed: an unknown id (set, remove, insert.after), an id named twice, a code cell
//   with outputs made markdown (setType drops a cell's outputs), more than EDIT_LIMITS.changes changes.
// The page (web/agents/notebook-artifact.ts) runs preflight and the component's applyEdits in one synchronous stretch.

import { sha256Hex } from "../sync-protocol/doc-protocol";

export const EDIT_LIMITS = Object.freeze({ changes: 200, sourceBytes: 256 * 1024, totalBytes: 4 * 1024 * 1024, idLength: 64, conversationLength: 128 });

type CellType = "code" | "markdown";
export type NotebookEdit = {
  conversation: string;
  path: string;
  ref: string;
  base: number;
  set?: { id: string; source?: string; type?: CellType }[];
  insert?: { source: string; type?: CellType; after: string | null }[];
  remove?: string[];
  was: Record<string, string>;
};
/** The component's applyEdits batch (web/notebook/notebook.js), its text as `code`. */
export type ComponentEdits = { set: { id: string; code?: string; type?: CellType }[]; insert: { code: string; type?: CellType; after: string | null }[]; remove: string[] };

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const onlyKeys = (o: Record<string, unknown>, keys: string[], at: string) => { for (const k of Object.keys(o)) if (!keys.includes(k)) return `${at}: ${k} isn't a field`; return null; };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** Why `p` isn't an edit in the grammar, or null. */
export function editProblem(p: unknown): string | null {
  if (!plain(p)) return "an edit is an object";
  const bad = onlyKeys(p, ["conversation", "path", "ref", "base", "set", "insert", "remove", "was"], "edit");
  if (bad) return bad;
  if (typeof p.conversation !== "string" || !p.conversation || p.conversation.length > EDIT_LIMITS.conversationLength) return "edit: conversation is the chat's id";
  if (typeof p.path !== "string" || !/^\/.*\.ipynb$/i.test(p.path) || p.path.length > 1024) return "edit: path is a notebook's (/….ipynb)";
  if (typeof p.ref !== "string" || !p.ref || p.ref.length > 128) return "edit: ref is the document's, from its read";
  if (typeof p.base !== "number" || !Number.isSafeInteger(p.base) || p.base < 0) return "edit: base is the revision read";
  let n = 0, total = 0;
  const source = (s: unknown, at: string) => {
    if (typeof s !== "string") return `${at}: source is text`;
    const b = utf8Bytes(s);
    if (b > EDIT_LIMITS.sourceBytes) return `${at}: ${b} bytes of source, at most ${EDIT_LIMITS.sourceBytes}`;
    total += b;
    return null;
  };
  const type = (t: unknown, at: string) => (t === undefined || t === "code" || t === "markdown" ? null : `${at}: type is code or markdown`);
  const id = (v: unknown, at: string) => (typeof v === "string" && ID.test(v) ? null : `${at}: not a cell id`);
  for (const [k, list] of [["set", p.set], ["insert", p.insert], ["remove", p.remove]] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) return `edit: ${k} is a list`;
    n += list.length;
  }
  if (n === 0) return "edit: nothing to change";
  if (n > EDIT_LIMITS.changes) return `edit: ${n} changes, at most ${EDIT_LIMITS.changes} in one edit`;
  for (const [i, c] of ((p.set as unknown[]) ?? []).entries()) {
    const at = `set[${i}]`;
    if (!plain(c)) return `${at}: is {id, source?, type?}`;
    const r = onlyKeys(c, ["id", "source", "type"], at) ?? id(c.id, at) ?? (c.source !== undefined ? source(c.source, at) : null) ?? type(c.type, at);
    if (r) return r;
    if (c.source === undefined && c.type === undefined) return `${at}: changes nothing (give source or type)`;
  }
  for (const [i, c] of ((p.insert as unknown[]) ?? []).entries()) {
    const at = `insert[${i}]`;
    if (!plain(c)) return `${at}: is {source, type?, after}`;
    const r = onlyKeys(c, ["source", "type", "after"], at) ?? source(c.source, at) ?? type(c.type, at) ?? (c.after === null ? null : id(c.after, `${at}.after`));
    if (r) return r;
    if (!("after" in c)) return `${at}: after is a cell id, or null for first`;
  }
  for (const [i, c] of ((p.remove as unknown[]) ?? []).entries()) { const r = id(c, `remove[${i}]`); if (r) return r; }
  if (total > EDIT_LIMITS.totalBytes) return `edit: ${total} bytes of source, at most ${EDIT_LIMITS.totalBytes}`;
  if (!plain(p.was)) return "edit: was is {id: sha256}";
  for (const [k, v] of Object.entries(p.was)) if (!ID.test(k) || typeof v !== "string" || !HASH.test(v)) return `edit: was.${k.slice(0, 64)} isn't a cell's hash`;
  return null;
}

/** JSON with every object's keys in order, so the helper and the page hash a cell alike. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
/** A cell in the form the notebook keeps it (web/notebook/notebook.js snapshot): what a save of it writes, whatever
 * form it was stored in (a code cell's type implicit, its count as text, empty fields left out).  Hashed in this form,
 * so a save that only re-forms a cell (the pane's first save of a document written elsewhere) isn't a change. */
export function cellForm(c: any): Record<string, unknown> {
  const type = c?.type ?? "code";
  const out: Record<string, unknown> = { id: c?.id, ...(type === "code" ? {} : { type }), code: c?.code ?? "" };
  if (type === "code") {
    out.outputs = Array.isArray(c?.outputs) ? c.outputs : [];
    out.n = c?.n === null || c?.n === undefined ? null : String(c.n);
    if (c?.ms !== null && c?.ms !== undefined) out.ms = c.ms;
  }
  if (type === "markdown" && c?.attachments) out.attachments = c.attachments;
  if (c?.metadata) out.metadata = c.metadata;
  return out;
}
/** A cell's hash: its whole JSON in the notebook's own form (cellForm: id, type, code, outputs, count, time,
 * attachments, metadata), canonical. */
export const cellHash = (cell: unknown) => sha256Hex(canonical(cellForm(cell)));

/** The ids an edit names (and so must have a `was`): set, remove, insert.after. */
export function named(e: NotebookEdit): string[] {
  return [...(e.set ?? []).map((c) => c.id), ...(e.remove ?? []), ...(e.insert ?? []).map((c) => c.after).filter((a): a is string => a !== null)];
}

/** The edit checked whole against `cells`: the component's batch, or why it is refused (nothing to change).  With
 * `hashes`, each named cell's hash too: against the document as stored (the shape the agent read), not the
 * component's own snapshot, which writes a cell in its own form. */
export function preflight(e: NotebookEdit, live: { id: string; type?: string; outputs?: unknown[] }[], { hashes = true } = {}): { ok: true; edits: ComponentEdits } | { ok: false; why: string; ids?: string[] } {
  const byId = new Map(live.map((c) => [c.id, c]));
  // (an id named twice: set twice, or set and removed, or removed twice)
  const seen = new Set<string>(), twice: string[] = [];
  for (const id of [...(e.set ?? []).map((c) => c.id), ...(e.remove ?? [])]) { if (seen.has(id)) twice.push(id); seen.add(id); }
  if (twice.length) return { ok: false, why: "a cell is named twice in one edit", ids: [...new Set(twice)] };
  const ids = [...new Set(named(e))];
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) return { ok: false, why: "no such cell (it was removed, or never was)", ids: missing };
  const unread = ids.filter((id) => !e.was[id]);
  if (unread.length) return { ok: false, why: "a cell this edit names wasn't in the read", ids: unread };
  const changed = hashes ? ids.filter((id) => cellHash(byId.get(id)) !== e.was[id]) : [];
  if (changed.length) return { ok: false, why: "changed since it was read (read it again)", ids: changed };
  const losing = (e.set ?? []).filter((c) => c.type === "markdown" && (byId.get(c.id)!.type ?? "code") === "code" && (byId.get(c.id)!.outputs?.length ?? 0) > 0).map((c) => c.id);
  if (losing.length) return { ok: false, why: "this cell has outputs: making it markdown would drop them (remove it and insert a markdown cell instead)", ids: losing };
  // (the tool's source is the component's code: mapped here, in one place)
  return {
    ok: true,
    edits: {
      set: (e.set ?? []).map((c) => ({ id: c.id, ...(c.source !== undefined ? { code: c.source } : {}), ...(c.type ? { type: c.type } : {}) })),
      insert: (e.insert ?? []).map((c) => ({ code: c.source, ...(c.type ? { type: c.type } : {}), after: c.after })),
      remove: [...(e.remove ?? [])],
    },
  };
}
