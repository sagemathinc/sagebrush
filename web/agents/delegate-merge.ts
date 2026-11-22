// A Delegate proposal's Merge into the person's files (Pair and Delegate plan, UI r3.2 §2 "The proposal"; SEC r1 item
// 4; H2). No DOM here: delegate-ui.ts draws it. The workspace and the agent come in as MergeIO (workspaceIO, below,
// is the page's).
// - What is merged is pinned: each file's base and proposal read from the agent (the proposal source checks their bytes
//   against the blob ids tasks.diff gave), and the person's file as it is at the click: its entry (kind, fid, created,
//   ref), its revision, its text and that text's SHA-256 (the preimage).
// - Each file is merged three-way (review/merge3.ts): a notebook by cell, text by line. A file deleted on one side and
//   changed on the other is one conflict for the whole file. Every conflict is the person's pick. Picks are kept for
//   the session under the task, the proposal, the base and the file's preimage; a pick made against another is
//   dropped, and the view says so.
// - The outputs a merged notebook takes from the proposal are kept as sanitizeOutputsOnly keeps them. The person's own
//   outputs, and every cell's type, source and attachments, stay as merged.
// - One decision, one record (MergeRecord), kept in the workspace's meta store before anything is written: its
//   merge_id, and per file its entry, preimage, merged text and state. Each file is then written by revision, only to
//   the same entry. One that changed meanwhile is unresolved, never retried silently. run() is also the recovery after
//   a crash or a reload.
// - tasks.merged is sent only when every file is written or skipped, built from the record, so a retry sends the same
//   request. The record is cleared once the agent has recorded it.
import { mergeNotebooks, mergeText, resolveNotebook, resolveText, type Cell, type Notebook, type Pick as Side3 } from "../workspace/review/merge3";
import { sanitizeOutputsOnly } from "../workspace/review/outputs";
import { kindOf } from "../workspace/paths";
import { blobId, type DiffFile } from "../workspace/tasks-schema";
import { TASK_REQUESTS } from "../workspace/tasks-client";
import type { Entry, Workspace } from "../workspace/api";
import { fromFile, toIpynb } from "../notebook/ipynb.js";

export const MERGE_TEXT = {
  notKept: "[An output not taken from the proposal: only text and pictures are merged]",
  kind: (path: string) => `Can't merge this kind yet: ${path}`,
  notText: (path: string) => `${path} isn't a text file`,
  notNotebook: (path: string) => `${path} isn't a notebook this page can read`,
  youDeleted: "You deleted this file since the task started",
  theyDeleted: "The proposal deletes this file, which you changed",
  recreate: "Merge recreates it",
  skip: "Skip",
  keepYours: "Keep mine",
  deleteIt: "Delete it",
  cell: (n: number) => `Cell ${n}`,
  field: (k: string) => `The notebook's ${k}`,
  lines: (n: number) => `From line ${n}`,
  removed: "(removed)",
  changed: "It changed since it was read",
} as const;

export class MergeError extends Error {
  constructor(public code: "kind" | "unreadable", message: string) { super(message); }
}

export type MergeKind = "notebook" | "file";
/** A workspace entry's identity, as a write checks it. */
export type Ident = Pick<Entry, "kind" | "fid" | "created" | "ref">;
/** The person's file now: its entry, its revision, its text (a notebook's .ipynb text), and that text's SHA-256. */
export type Mine = { id: Ident; rev: number; text: string; hash: string };

export interface MergeIO {
  /** The person's file at `path` (the protocol's, relative), or null if there is none; MergeError if it isn't `kind`. */
  mine(path: string, kind: MergeKind): Promise<Omit<Mine, "hash"> | null>;
  /** `text` written over the file read as `at`: only at that revision, to that same entry (else it throws). */
  write(path: string, kind: MergeKind, text: string, at: Omit<Mine, "hash">): Promise<Ident>;
  /** `text` as a new file at `path` (a path that's taken is refused: it throws). */
  create(path: string, kind: MergeKind, text: string): Promise<Ident>;
  /** The file read as `at` removed (to Trash), only if it is still that entry at that revision (else it throws). */
  remove(path: string, at: Omit<Mine, "hash">): Promise<void>;
  /** The task's merge record, as kept (checked here: recordOf). */
  load(task: string): Promise<unknown>;
  save(task: string, rec: MergeRecord | null): Promise<void>;
  /** tasks.merged */
  merged(task: string, params: MergedParams): Promise<{ recorded: "merge" | "receipt"; commit: string | null }>;
}

/** What a Merge names: the task, the proposal and its base, the task's seq when it was read, and its files (tasks.diff). */
export type Pinned = { task: string; base: string; proposal: string; seq: number; files: DiffFile[] };
export type MergeSource = { file(path: string, commit: string): Promise<string | null> };

export type Conflict = { id: string; label: string; mine: string; theirs: string; mineLabel?: string; theirsLabel?: string };
export type Picks = Record<string, Side3>;
export type FileMerge = {
  path: string;
  kind: MergeKind;
  proposal_blob: string | null;
  mine: Mine | null;
  conflicts: Conflict[];
  /** The merged text for these picks (every conflict picked), or null: the file is removed (or stays absent). */
  result(picks: Picks): string | null;
};

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const short = (s: string, n = 400) => (s.length > n ? s.slice(0, n) + "…" : s);

function parse(path: string, text: string | null): Notebook {
  if (text === null) return { cells: [] };
  try { return fromFile(nameOf(path), text) as Notebook; } catch { throw new MergeError("unreadable", MERGE_TEXT.notNotebook(path)); }
}
// (a notebook's text as Merge writes it: its cells taken from the proposal with their outputs sanitized, together)
function notebookText(doc: Notebook, fromProposal: (c: Cell) => boolean): string {
  const at = doc.cells.flatMap((c, i) => (fromProposal(c) ? [i] : []));
  const clean = sanitizeOutputsOnly(at.map((i) => doc.cells[i]), MERGE_TEXT.notKept);
  const cells = [...doc.cells];
  at.forEach((i, k) => { cells[i] = clean[k]; });
  return toIpynb({ ...doc, cells });
}
/** A notebook's .ipynb text as this page writes it (the same document read and written again): what comparisons use. */
export const canonical = (path: string, kind: MergeKind, text: string) => (kind === "notebook" ? toIpynb(parse(path, text)) : text);

/** Each of the proposal's files merged against the person's file now (nothing written). MergeError if one can't be. */
export async function prepare(io: MergeIO, src: MergeSource, pin: Pinned, only?: readonly string[]): Promise<FileMerge[]> {
  const out: FileMerge[] = [];
  for (const f of pin.files) {
    if (only && !only.includes(f.path)) continue;
    // (a board, or a file named as another kind than the agent says: not merged here yet)
    if (kindOf("/" + f.path) !== (f.kind === "notebook" ? "notebook" : "file")) throw new MergeError("kind", MERGE_TEXT.kind(f.path));
    const base = f.base_blob === null ? null : await src.file(f.path, pin.base);
    const theirs = f.blob === null ? null : await src.file(f.path, pin.proposal);
    const m = await io.mine(f.path, f.kind);
    const mine = m && { ...m, hash: await sha256(m.text) };
    out.push(fileMerge(f, base, theirs, mine));
  }
  return out;
}

function fileMerge(f: DiffFile, base: string | null, theirs: string | null, mine: Mine | null): FileMerge {
  const { path, kind } = f, nb = kind === "notebook";
  const head = { path, kind, proposal_blob: f.blob, mine };
  // (the proposal's whole file, as Merge writes it: a notebook's outputs sanitized)
  const proposed = () => (theirs === null ? null : nb ? notebookText(parse(path, theirs), () => true) : theirs);
  const same = (a: string, b: string) => canonical(path, kind, a) === canonical(path, kind, b);
  const whole = (label: string, mineLabel: string, theirsLabel: string, keep: string | null, take: () => string | null): FileMerge => ({
    ...head,
    conflicts: [{ id: "file", label, mine: keep === null ? MERGE_TEXT.removed : short(keep), theirs: take() === null ? MERGE_TEXT.removed : short(theirs ?? ""), mineLabel, theirsLabel }],
    result: (p) => (pick(p, "file") === "mine" ? keep : take()),
  });
  // (the person deleted it since the base, and the proposal changed it: recreate it or skip it)
  if (!mine && base !== null && theirs !== null) return whole(MERGE_TEXT.youDeleted, MERGE_TEXT.skip, MERGE_TEXT.recreate, null, proposed);
  if (!mine) return { ...head, conflicts: [], result: proposed };
  // (the proposal deletes it: removed if the person's is the base, else theirs to pick)
  if (theirs === null) {
    if (base !== null && same(mine.text, base)) return { ...head, conflicts: [], result: () => null };
    return whole(MERGE_TEXT.theyDeleted, MERGE_TEXT.keepYours, MERGE_TEXT.deleteIt, mine.text, () => null);
  }
  if (nb) {
    const T = parse(path, theirs);
    const r = mergeNotebooks(parse(path, base), parse(path, mine.text), T);
    const fromThem = new Set(T.cells);
    const pos = (id: string) => r.order.indexOf(id) + 1;
    const code = (c: Cell | null) => (c ? short(String(c.code ?? "")) : MERGE_TEXT.removed);
    const conflicts = r.conflicts.map((c): Conflict => (c.kind === "cell"
      ? { id: c.id, label: MERGE_TEXT.cell(pos(c.cell)), mine: code(c.mine), theirs: code(c.theirs) }
      : { id: c.id, label: MERGE_TEXT.field(c.key), mine: short(JSON.stringify(c.mine) ?? MERGE_TEXT.removed), theirs: short(JSON.stringify(c.theirs) ?? MERGE_TEXT.removed) }));
    return { ...head, conflicts, result: (p) => notebookText(resolveNotebook(r, p), (c) => fromThem.has(c)) };
  }
  const r = mergeText(base ?? "", mine.text, theirs);
  const conflicts: Conflict[] = [];
  let line = 1;
  for (const part of r.parts) {
    if (part.kind === "conflict") conflicts.push({ id: part.id, label: MERGE_TEXT.lines(line), mine: short(part.mine), theirs: short(part.theirs) });
    line += ((part.kind === "same" ? part.text : part.mine).match(/\n/g) ?? []).length;
  }
  return { ...head, conflicts, result: (p) => resolveText(r, p) };
}
const pick = (p: Picks, id: string) => {
  const v = p[id];
  if (v !== "mine" && v !== "theirs") throw new Error(`not picked: ${id}`);
  return v;
};

/** The conflicts of `plans` not picked yet. */
export const unpicked = (plans: readonly FileMerge[], picks: Record<string, Picks>) =>
  plans.flatMap((f) => f.conflicts.filter((c) => picks[f.path]?.[c.id] !== "mine" && picks[f.path]?.[c.id] !== "theirs").map((c) => ({ path: f.path, id: c.id })));

// ---- picks, for this session: under the task, the proposal, the base and each file's preimage

const PICKS_KEY = (task: string) => "sagebrush-delegate-picks:" + task;
type KeptPicks = { proposal: string; base: string; files: Record<string, { hash: string; picks: Picks }> };
const hashOf = (f: FileMerge) => f.mine?.hash ?? "absent";

/** The picks kept for these plans: only those made against the same proposal, base and preimage, and only of a
 * conflict still there; `dropped` the files whose picks were made against another. */
export function loadPicks(store: Pick<Storage, "getItem">, pin: Pinned, plans: readonly FileMerge[]): { picks: Record<string, Picks>; dropped: string[] } {
  let kept: KeptPicks | null = null;
  try { kept = JSON.parse(store.getItem(PICKS_KEY(pin.task)) ?? "null"); } catch { kept = null; }
  const picks: Record<string, Picks> = {}, dropped: string[] = [];
  if (!kept || typeof kept !== "object" || typeof kept.files !== "object" || !kept.files) return { picks, dropped };
  const sameRound = kept.proposal === pin.proposal && kept.base === pin.base;
  for (const f of plans) {
    const k = Object.hasOwn(kept.files, f.path) ? kept.files[f.path] : undefined;
    if (!k || typeof k.picks !== "object" || !k.picks || !Object.keys(k.picks).length) continue;
    if (!sameRound || k.hash !== hashOf(f)) { dropped.push(f.path); continue; }
    const ids = new Set(f.conflicts.map((c) => c.id));
    picks[f.path] = Object.fromEntries(Object.entries(k.picks).filter(([id, v]) => ids.has(id) && (v === "mine" || v === "theirs")));
  }
  return { picks, dropped };
}
export function savePicks(store: Pick<Storage, "setItem">, pin: Pinned, plans: readonly FileMerge[], picks: Record<string, Picks>) {
  const files: KeptPicks["files"] = {};
  for (const f of plans) if (picks[f.path] && Object.keys(picks[f.path]).length) files[f.path] = { hash: hashOf(f), picks: picks[f.path] };
  try { store.setItem(PICKS_KEY(pin.task), JSON.stringify({ proposal: pin.proposal, base: pin.base, files } satisfies KeptPicks)); } catch { /* (a full session store: the picks only aren't kept) */ }
}
export const clearPicks = (store: Pick<Storage, "removeItem">, task: string) => { try { store.removeItem(PICKS_KEY(task)); } catch { /* (nothing kept) */ } };

// ---- the decision's record, and its writes

export type FileState = "pending" | "written" | "unresolved" | "skipped";
export type RecordFile = {
  path: string;
  kind: MergeKind;
  proposal_blob: string | null;
  /** the person's file as it was read (null: none): its entry, revision, text and hash */
  id: Ident | null;
  rev: number | null;
  pre: string | null;
  hash: string | null;
  /** what the person approved: the merged text, or null (the file removed, or left absent) */
  merged: string | null;
  state: FileState;
  /** why it is unresolved */
  why?: string;
  /** skipped when the person closed what was left: its content not sent (a receipt) */
  closed?: true;
};
export type MergeRecord = { v: 1; merge_id: string; task: string; proposal: string; base: string; seq: number; files: RecordFile[] };

const randomId = () => hex(crypto.getRandomValues(new Uint8Array(16)));

/** A new decision's record, every file pending (or skipped: nothing on either side). */
export function newRecord(pin: Pinned, plans: readonly FileMerge[], picks: Record<string, Picks>): MergeRecord {
  return { v: 1, merge_id: randomId(), task: pin.task, proposal: pin.proposal, base: pin.base, seq: pin.seq, files: plans.map((f) => fileRecord(f, picks[f.path] ?? {})) };
}
function fileRecord(f: FileMerge, picks: Picks): RecordFile {
  const merged = f.result(picks), m = f.mine;
  return { path: f.path, kind: f.kind, proposal_blob: f.proposal_blob, id: m ? m.id : null, rev: m ? m.rev : null, pre: m ? m.text : null, hash: m ? m.hash : null, merged, state: !m && merged === null ? "skipped" : "pending" };
}
/** The record with its unresolved files merged again (fresh plans of those files, against the person's files now),
 * under the same merge_id. */
export function revise(rec: MergeRecord, plans: readonly FileMerge[], picks: Record<string, Picks>): MergeRecord {
  const by = new Map(plans.map((f) => [f.path, f]));
  return { ...rec, files: rec.files.map((r) => (r.state === "unresolved" && by.has(r.path) ? fileRecord(by.get(r.path)!, picks[r.path] ?? {}) : r)) };
}
/** The record with what is left closed: its unresolved files skipped, their content not sent. */
export const closeRest = (rec: MergeRecord): MergeRecord => ({ ...rec, files: rec.files.map((r) => (r.state === "unresolved" ? { path: r.path, kind: r.kind, proposal_blob: r.proposal_blob, id: r.id, rev: r.rev, pre: r.pre, hash: r.hash, merged: r.merged, state: "skipped", closed: true } : r)) });
export const isDone = (rec: MergeRecord) => rec.files.every((f) => f.state === "written" || f.state === "skipped");
export const unresolved = (rec: MergeRecord) => rec.files.filter((f) => f.state === "unresolved");

const sameId = (a: Ident | null, b: Ident | null) => !!a && !!b && a.kind === b.kind && a.fid === b.fid && a.created === b.created && (a.ref ?? null) === (b.ref ?? null);

/** The record's writes: each pending file written by revision to its same entry (recovery too, after a crash or a
 * reload), each written one checked again; the record saved after each change. One that changed meanwhile is
 * unresolved. */
export async function run(io: MergeIO, rec: MergeRecord): Promise<MergeRecord> {
  for (const f of rec.files) {
    if (f.state !== "pending" && f.state !== "written") continue;
    const was = f.state;
    let cur: Omit<Mine, "hash"> | null;
    try { cur = await io.mine(f.path, f.kind); } catch (e) { setUnresolved(f, e); await io.save(rec.task, rec); continue; }
    const holds = (t: string | null) => (t === null ? !cur : !!cur && canonical(f.path, f.kind, cur.text) === canonical(f.path, f.kind, t));
    if (f.state === "written") {
      // (a file written is still that entry; one removed, or one left absent, has nothing to check)
      if (f.merged !== null && (!cur || !sameId(cur.id, f.id))) setUnresolved(f, MERGE_TEXT.changed);
    } else if (f.merged === null) {
      // (a removal: done if it is gone, removed if it is still the person's file as read)
      if (!cur) f.state = "written";
      else if (f.id && sameId(cur.id, f.id) && (await sha256(cur.text)) === f.hash) await attempt(f, () => io.remove(f.path, cur!));
      else setUnresolved(f, MERGE_TEXT.changed);
    } else if (!f.id) {
      // (a file made: done if it holds the merge, made if there is still none)
      if (cur && holds(f.merged)) { f.id = cur.id; f.state = "written"; }
      else if (!cur) await attempt(f, async () => { f.id = await io.create(f.path, f.kind, f.merged!); });
      else setUnresolved(f, MERGE_TEXT.changed);
    } else if (cur && sameId(cur.id, f.id) && holds(f.merged)) f.state = "written";
    else if (cur && sameId(cur.id, f.id) && (await sha256(cur.text)) === f.hash) await attempt(f, async () => { f.id = await io.write(f.path, f.kind, f.merged!, cur!); });
    else setUnresolved(f, MERGE_TEXT.changed);
    if (f.state !== was) await io.save(rec.task, rec);
  }
  return rec;
}
async function attempt(f: RecordFile, op: () => Promise<unknown>) {
  try { await op(); f.state = "written"; delete f.why; } catch (e) { setUnresolved(f, e); }
}
function setUnresolved(f: RecordFile, why: unknown) {
  f.state = "unresolved";
  f.why = typeof why === "string" ? why : why instanceof Error ? why.message : String(why);
}

export type Side = { blob: string; content: string } | { absent: true } | null;
export type MergedParams = { task: string; proposal: string; seq: number; merge_id: string; files: { path: string; kind: MergeKind; proposal_blob: string | null; mine: Side; merged: Side }[] };
/** A tasks.merged request's bytes, as sent, at most (the connection's frame, less room for the message around it). */
export const MERGED_BYTES = TASK_REQUESTS.frameBytes - 4096;

/** tasks.merged's request, from the record alone (so a retry is the same request): every file's mine and merged in
 * full; a receipt (content not sent) for the files closed, or for all if the request would be past MERGED_BYTES. */
export async function mergedParams(rec: MergeRecord): Promise<MergedParams> {
  const side = async (t: string | null): Promise<Side> => (t === null ? { absent: true } : { blob: await blobId(enc.encode(t)), content: t });
  const build = (all: boolean) => Promise.all(rec.files.map(async (f) => {
    const sent = all && !f.closed;
    // (a file skipped as absent on both sides: absent, which is full information)
    return { path: f.path, kind: f.kind, proposal_blob: f.proposal_blob, mine: sent ? await side(f.pre) : null, merged: sent ? await side(f.state === "skipped" && !f.closed ? f.pre : f.merged) : null };
  }));
  const head = { task: rec.task, proposal: rec.proposal, seq: rec.seq, merge_id: rec.merge_id };
  const full = { ...head, files: await build(true) };
  const text = JSON.stringify(full);
  return text.length <= MERGED_BYTES && enc.encode(text).length <= MERGED_BYTES ? full : { ...head, files: await build(false) };
}

/** A kept record read back: null for none, or for one this page can't trust (malformed). */
export function recordOf(v: unknown, task: string): MergeRecord | null {
  const o = v as MergeRecord;
  const str = (x: unknown) => typeof x === "string";
  const strOrNull = (x: unknown) => x === null || typeof x === "string";
  const ident = (x: unknown) => x === null || (!!x && typeof x === "object" && str((x as Ident).kind) && Number.isFinite((x as Ident).created) && strOrNull((x as Ident).ref ?? null) && ((x as Ident).fid === undefined || str((x as Ident).fid)));
  if (!o || typeof o !== "object" || o.v !== 1 || o.task !== task || !/^[0-9a-f]{32}$/.test(String(o.merge_id)) || !str(o.proposal) || !str(o.base) || !Number.isSafeInteger(o.seq) || !Array.isArray(o.files)) return null;
  const ok = o.files.every((f) => f && typeof f === "object" && str(f.path) && (f.kind === "notebook" || f.kind === "file") && strOrNull(f.proposal_blob) && ident(f.id) && (f.rev === null || Number.isFinite(f.rev)) && strOrNull(f.pre) && strOrNull(f.hash) && strOrNull(f.merged) && ["pending", "written", "unresolved", "skipped"].includes(f.state));
  return ok ? o : null;
}

// ---- the page's MergeIO: this browser's workspace, and the agent's tasks.merged

type WorkspaceLike = Pick<Workspace, "stat" | "read" | "write" | "create" | "remove" | "delegateMerge" | "setDelegateMerge">;
const identOf = (e: Ident): Ident => ({ kind: e.kind, ...(e.fid !== undefined ? { fid: e.fid } : {}), created: e.created, ref: e.ref ?? null });

/** `seam` (tests on localhost only): awaited right before each write or removal, after the file was read and checked. */
export function workspaceIO(ws: () => WorkspaceLike | null, merged: MergeIO["merged"], seam?: (op: "write" | "remove", path: string) => Promise<void>): MergeIO {
  const W = () => { const w = ws(); if (!w) throw new Error("this browser's workspace isn't open"); return w; };
  const content = (path: string, kind: MergeKind, text: string) => (kind === "notebook" ? parse(path, text) : enc.encode(text));
  return {
    async mine(path, kind) {
      const w = W(), p = "/" + path, e = await w.stat(p);
      if (!e || e.trashed) return null;
      if (e.kind !== kind) throw new MergeError("kind", MERGE_TEXT.kind(path));
      const r = await w.read(p);
      let text: string;
      if (kind === "notebook") text = toIpynb(r.content);
      else if (typeof r.content === "string") text = r.content;
      else {
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(r.content); } catch { throw new MergeError("unreadable", MERGE_TEXT.notText(path)); }
      }
      return { id: identOf(r.entry), rev: r.rev, text };
    },
    async write(path, kind, text, at) { await seam?.("write", path); return identOf((await W().write("/" + path, content(path, kind, text), { base: at.rev, expect: at.id })).entry); },
    async create(path, kind, text) { return identOf(await W().create("/" + path, { content: content(path, kind, text) })); },
    // (only that entry, still at the revision whose text was checked: a later edit refuses it, nothing moved)
    async remove(path, at) { await seam?.("remove", path); await W().remove("/" + path, { ...at.id, rev: at.rev }); },
    load: (task) => W().delegateMerge(task),
    save: (task, rec) => W().setDelegateMerge(task, rec),
    merged,
  };
}
