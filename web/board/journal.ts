// The board journal (DEV-only): a board of the workspace saved through the journal's
// store (web/journal/store.js), as notebooks are once the workspace's journal is active: each save its T1 (an intent
// and its version, in sagebrush-board-history), then its T2 (the board's row with the journal's envelope), so a page
// closed mid-write loses nothing and TimeTravel and the row can't disagree.  Here:
//
//   BoardRecordStore   the store's Base, the T2 side: the board's row through Workspace.journalWrite, never
//                      the workspace's database itself
//   boardKind(mod)     the store's kind: its history (a PatchHistory subclass, history.ts's records), the
//                      record/document boundary (the store's own fields never in a version), and 2c-3's merge
//
// The store's id is the board's history key without a document name, "board:local:<ref>" (one journal per
// board, whatever document it shows): its versions and journal rows are where a board's deletion drops them
// (api.ts).  Loaded with sagebrush-history.js, never in the board page's own bundle: only types are imported here
// but for history.ts's codec-free functions and merge.ts.
import { toRecords, fromRecords, keptRecord, recordInto, SCHEMA, type HistoryModule, type Records } from "./history";
import { boardMerge3, keyOf, canon, type Rec } from "./merge";
import type { BoardDoc } from "./doc";
import { stripBoard, type Workspace, type BoardJournalWord } from "../workspace/api";

/** The board journal's store id of the board `ref`. */
export const JOURNAL_PREFIX = "board:local:";
export const journalId = (ref: string) => JOURNAL_PREFIX + ref;
const REF = /^[0-9a-f]{12}$/;

/** The board journal store's Base (web/journal/store.js): constructor(ws, id, initial, {journal: true}),
 * loadRecord(), save(doc, {journal, tag?}). */
export class BoardRecordStore {
  workspace: Workspace; id: string; ref: string; initial: unknown; journal: boolean;
  constructor(ws: Workspace, id: string, initial: unknown = null, opts: { journal?: boolean } = {}) {
    const ref = typeof id === "string" && id.startsWith(JOURNAL_PREFIX) ? id.slice(JOURNAL_PREFIX.length) : "";
    if (!REF.test(ref)) throw new TypeError(`a board journal's id is ${JOURNAL_PREFIX}<ref>, not ${String(id)}`);
    this.workspace = ws; this.id = id; this.ref = ref; this.initial = initial; this.journal = !!opts.journal;
  }
  /** The record: the board's document with the store's own fields beside it ({...doc, rev, j?, hash?, unjournaled?}),
   * or null. */
  loadRecord(): Promise<any> { return this.workspace.journalRecord(this.ref); }
  /** T2: {saved, rev}, {conflict}, {marked}, or a refusal's text (Workspace.journalWrite). */
  save(doc: any, opts: { journal?: BoardJournalWord; tag?: string } = {}) {
    if (!this.journal || !opts.journal) return Promise.resolve("not saved: this board's save didn't come through sync's journal: reload this page");
    return this.workspace.journalWrite(this.ref, doc, { journal: opts.journal, ...(opts.tag ? { tag: opts.tag } : {}) });
  }
}

/** The board's records as a version keeps them, in one order: what the record's hash is of. */
const versioned = (doc: BoardDoc) => toRecords(stripBoard(doc)).map(keptRecord).sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
/** Top-level fields of a board that its records don't keep (history.ts toRecords): kept from the record. */
const UNVERSIONED = ["format", "version", "tools"] as const;
/** A merge's work ledger and deadline (2c-3's: as the hub's). */
export const MERGE_WORK = 2_000_000, MERGE_MS = 2_000;

// (what of patch-history.js's PatchHistory this subclass uses; the store uses the rest)
interface PatchHistoryBase { committed(): Records | null; commit(next: Records): unknown; valueAt(time: string): Records; versions(): { time: string; ms: number; index: number }[] }
type PatchHistoryCtor = new (store: unknown, codec: unknown) => PatchHistoryBase;
const historyClasses = new WeakMap<object, PatchHistoryCtor>();
/** The board journal's history: a PatchHistory (the module's) with BoardHistory's record and docAt; the store uses
 * the rest (refused, init, close, session, codec, paused, rebuilding, clientId, lastMs, sessionOptions, on). */
function boardHistoryClass(mod: HistoryModule): PatchHistoryCtor {
  let C = historyClasses.get(mod);
  if (!C) {
    const Base = mod.PatchHistory as unknown as PatchHistoryCtor;
    C = class BoardJournalHistory extends Base {
      /** The board as a version (the journal's own fields never in it): nothing if it has not changed. */
      record(d: BoardDoc) { return recordInto(this, stripBoard(d)); }
      docAt(time: string): BoardDoc { return fromRecords(this.valueAt(time)); }
    };
    historyClasses.set(mod, C);
  }
  return C;
}

/** Boards' kind (web/journal/store.js), over the history's module `mod`. */
export function boardKind(mod: HistoryModule) {
  const codec: any = mod.createImmerDbCodec(SCHEMA), History = boardHistoryClass(mod);
  // (records as the codec's document, as a version holds them)
  const asDoc = (recs: any[]): Records => {
    const empty = codec.fromString("");
    if (empty.withRecords) return empty.withRecords(recs);
    let d = empty;
    for (const r of recs) d = d.set(r);
    return d;
  };
  return {
    kind: "boards",
    noun: "board",
    lockPrefix: "sagebrush-board-writer:",
    // (boards don't sync yet: that needs the server's rows first, then the page's wiring)
    sync: { on: false, saved: () => {} },
    versionedOf: versioned,
    history: (patchStore: unknown) => new History(patchStore, codec),
    // (the record/document boundary: the store's own fields dropped before the records, wherever the store asks for them)
    toRecords: (doc: BoardDoc): Records => asDoc(toRecords(stripBoard(doc)).map(keptRecord)),
    fromRecords: (records: Records): BoardDoc => fromRecords(records),
    // (the record's versioned part replaced by `value`; what its records don't keep, the record's own: the law,
    // withValue(rec, toRecords(rec)) is rec but for the store's own fields)
    withValue(rec: any, value: Records): BoardDoc {
      const v: any = fromRecords(value);
      if (rec) {
        for (const k of UNVERSIONED) { if (k in rec) v[k] = rec[k]; else delete v[k]; }
        // (no links, which records can't tell from an empty list: as the record has it)
        if (!("edges" in rec) && Array.isArray(v.edges) && !v.edges.length) delete v.edges;
        if (Array.isArray(rec.pages) && Array.isArray(v.pages)) v.pages.forEach((p: any, i: number) => { const q = rec.pages[i]; if (q && !("edges" in q) && Array.isArray(p.edges) && !p.edges.length) delete p.edges; });
      }
      return v;
    },
    empty: (_id: string, initial: unknown): BoardDoc => (initial && typeof initial === "object" ? { ...(initial as BoardDoc) } : { title: "Untitled board", nodes: [] }),
    // (2c-3's merge, of documents: boardMerge3 on their records, with a ledger and a deadline; refused (work,
    // paging, conservation, time), the side `wins` names, every changed record a clash)
    apply(lastSynced: BoardDoc | null, shown: BoardDoc, remote: BoardDoc, wins: "shown" | "remote") {
      const [a, b] = wins === "remote" ? [remote, shown] : [shown, remote];
      const base: Rec[] = lastSynced ? versioned(lastSynced) : [], ra: Rec[] = versioned(a), rb: Rec[] = versioned(b);
      const r = boardMerge3(base, ra, rb, { work: MERGE_WORK, deadline: Date.now() + MERGE_MS });
      if ("refused" in r) {
        const was = new Map(base.map((x) => [keyOf(x), canon(x)]));
        const changed = new Set<string>();
        for (const side of [ra, rb]) {
          const here = new Set<string>();
          for (const x of side) { const k = keyOf(x); here.add(k); if (was.get(k) !== canon(x)) changed.add(k); }
          for (const k of was.keys()) if (!here.has(k)) changed.add(k);
        }
        return { value: a, clashes: [...changed].sort() };
      }
      const value: any = fromRecords(asDoc(r.records));
      for (const k of UNVERSIONED) { if (k in a) value[k] = (a as any)[k]; else delete value[k]; }
      return { value, clashes: [...new Set(r.reports.map((x) => x.key))].sort() };
    },
    conflictCopy: null,
  };
}
