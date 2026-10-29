// TimeTravel for boards: a board's edit history, as patchflow patches on
// records (web/notebook/patch-history.js, shared with the notebook's), kept
// in this browser's IndexedDB in a database of its own
// (sagebrush-board-history), so a notebook's history is never touched.
// A board is records keyed by (type, page, id):
//
//   {type: "doc", page: "", id: ""}    its title, language, links' base,
//                                      pictures' sizes, and (without pages)
//                                      its intro, layout and tour; paged: true
//                                      if it has pages
//   {type: "page", page, id: ""}       a page: pos, title, intro, layout, tour
//   {type: "item", page, id}           a note or a group: parent ("" at the
//                                      top), pos among its siblings, and its
//                                      fields (x and y among them)
//   {type: "edge", page, id}           from, to, pos, label, arrows, line
//
// (A page without an id is "#" and its place, marked `anon`, and not an id
// another page has; an edge is the JSON of its ends and which of those
// between the same two it is.)  The text fields are string
// columns, patched character by character, and a changed record is patched
// in place, so moving an item is a tiny patch (its x and y) and so is typing
// a letter.  Every change kept is a version: a drag when it ends.  Not
// recorded: the format's name and version, and the toolbar's tools (a
// setting, which undo leaves alone too).
//
// patchflow (170 kB) comes in the sagebrush-history.js bundle, loaded the
// first time it is needed: the module is passed in.

import { FORMAT, VERSION, type BoardDoc, type BoardPage, type DocNode } from "./doc";

/** Records as patchflow's immer-db codec keeps them. */
export interface Records {
  get(where: object): any[];
  getOne(where: object): any;
  set(r: object): Records;
  delete(where: object): Records;
  isEqual(o: Records): boolean;
  /** (patchflow's immer-db document: the same document with these records, its indexes made once) */
  withRecords?(records: any[]): Records;
}
interface PatchHistoryLike {
  init(): Promise<unknown>;
  on(f: () => void): () => void;
  committed(): Records | null;
  commit(next: Records): unknown;
  versions(): Version[];
  valueAt(time: string): Records;
  patches(): unknown[];
  close(): void;
}
/** The sagebrush-history.js bundle (web/notebook/history.js). */
export interface HistoryModule {
  PatchHistory: new (store: unknown, codec: unknown) => PatchHistoryLike;
  createImmerDbCodec(schema: object): unknown;
}
export interface Version { time: string; ms: number; index: number }

export const SCHEMA = { primaryKeys: ["type", "page", "id"], stringCols: ["title", "text", "code", "detail", "label", "intro"] };
const TYPES = ["doc", "page", "item", "edge"];

const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
// (equal records: the same JSON, whatever the order of their keys)
const canon = (x: unknown): string => JSON.stringify(x, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

/** A board as records. */
export function toRecords(d: BoardDoc): any[] {
  const { format: _f, version: _v, tools: _t, pages, nodes, edges, ...meta } = d;
  const out: any[] = [{ type: "doc", page: "", id: "", ...meta, ...(pages?.length ? { paged: true } : {}) }];
  const page = (p: BoardPage, pid: string) => {
    const walk = (list: DocNode[], parent: string) => list.forEach((n, pos) => {
      const { children, ...rest } = n as any;
      out.push({ type: "item", page: pid, ...rest, id: n.id, parent, pos });
      if (n.kind === "group") walk(n.children, n.id);
    });
    walk(p.nodes ?? [], "");
    const seen = new Map<string, number>();
    (p.edges ?? []).forEach((e, pos) => {
      // (its ends, and which of those between them: unambiguous whatever the ids hold, CORR-3D2-3)
      const k = JSON.stringify([e.from, e.to]), c = (seen.get(k) ?? 0) + 1;
      seen.set(k, c);
      out.push({ type: "edge", page: pid, ...e, id: JSON.stringify([e.from, e.to, c]), pos });
    });
  };
  if (pages?.length) {
    // (a page without an id: "#" and its place, marked as made so; never an id another page has)
    const taken = new Set(pages.map((p) => p.id).filter((x) => x != null).map(String));
    pages.forEach((p, i) => {
      const { nodes: _n, edges: _e, id, ...rest } = p as any;
      let pid = id ?? `#${i}`;
      if (id == null) while (taken.has(pid)) pid += "#";
      out.push({ type: "page", page: pid, ...rest, ...(id == null ? { anon: true } : /^#\d+#*$/.test(id) ? { anon: false } : {}), id: "", pos: i });
      page(p, pid);
    });
  } else page({ nodes, edges } as BoardPage, "");
  return plain(out);
}

/** Records as a board. */
export function fromRecords(rs: Records): BoardDoc {
  const byPos = (a: any, b: any) => (a.pos ?? 0) - (b.pos ?? 0);
  const { type: _t, page: _p, id: _i, paged, ...meta } = rs.getOne({ type: "doc" }) ?? {};
  const d: any = { format: FORMAT, version: VERSION, ...plain(meta) };
  const items = rs.get({ type: "item" }), edges = rs.get({ type: "edge" });
  const build = (pid: string) => {
    const kids = new Map<string, any[]>();
    for (const r of items) if (r.page === pid) (kids.get(r.parent) ?? kids.set(r.parent, []).get(r.parent)!).push(r);
    const tree = (parent: string): DocNode[] => (kids.get(parent) ?? []).sort(byPos).map((r) => {
      const { type: _a, page: _b, parent: _c, pos: _d, ...n } = plain(r);
      return n.kind === "group" ? { ...n, children: tree(n.id) } : n;
    });
    return { nodes: tree(""), edges: edges.filter((e) => e.page === pid).sort(byPos).map((e) => { const { type: _a, page: _b, id: _c, pos: _d, ...rest } = plain(e); return rest; }) };
  };
  if (paged) {
    d.pages = rs.get({ type: "page" }).slice().sort(byPos).map((p) => {
      const { type: _a, page: pid, id: _c, pos: _d, anon, ...rest } = plain(p);
      // (an id made for a page without one: marked so; records from before the mark, by its form)
      return { ...((anon ?? /^#\d+#*$/.test(pid)) ? {} : { id: pid }), ...rest, ...build(pid) };
    });
  } else Object.assign(d, build(""));
  return d as BoardDoc;
}

/** A record as a version keeps it (a field null, or a text field that isn't text, isn't kept): what `record` writes
 * at once, and what the board journal's hash is of (journal.ts versionedOf). */
export function keptRecord(r: any): any {
  const o = { ...r };
  for (const k of Object.keys(o)) if (o[k] === null || (SCHEMA.stringCols.includes(k) && Array.isArray(o[k]))) delete o[k];
  return o;
}
/** `d` recorded into `h` as a version (nothing if it has not changed): only what changed; null while the history is
 * (re)opened (BoardHistory.record's, and the board journal's history's: journal.ts). */
export function recordInto(h: { committed(): Records | null; commit(next: Records): unknown }, d: BoardDoc) {
  const cur = h.committed();
  if (!cur) return null;
  const recs = toRecords(d);
  // (the version: its records, as inserting or patching each would leave
  // them, made at once; the patch is what changed, computed from the two.
  // Made one record at a time, each remade the document's indexes: a
  // large board's first version, or an item removed (every later one's
  // place changed), took seconds)
  if (cur.withRecords) return h.commit(cur.withRecords(recs.map(keptRecord)));
  let next = cur;
  // (a record's key: its type, page and id, whatever they hold, CORR-3D2-3)
  const key = (r: any) => JSON.stringify([r.type, r.page, r.id]);
  const want = new Map(recs.map((r) => [key(r), r]));
  for (const t of TYPES) for (const r of cur.get({ type: t })) if (!want.has(key(r))) next = next.delete({ type: r.type, page: r.page, id: r.id });
  for (const r of want.values()) {
    const old = cur.getOne({ type: r.type, page: r.page, id: r.id });
    if (old && canon(old) === canon(r)) continue;
    // (a field taken off: the record anew; otherwise patched in place)
    if (old && Object.keys(old).some((k) => !(k in r))) next = next.delete({ type: r.type, page: r.page, id: r.id });
    next = next.set(r);
  }
  return h.commit(next);
}

export class BoardHistory {
  private h: PatchHistoryLike;
  constructor(mod: HistoryModule, store: unknown) {
    this.h = new mod.PatchHistory(store, mod.createImmerDbCodec(SCHEMA));
  }
  async init() { await this.h.init(); return this; }
  on(f: () => void) { return this.h.on(f); }
  /** Keep the board as it is now as a version (nothing if it has not changed): only what changed; null while the
   *  history is (re)opened, none made then (the next one has the change: astra's CORR-529-1). */
  record(d: BoardDoc) { return recordInto(this.h, d); }
  /** The versions, oldest first. */
  versions(): Version[] { return this.h.versions(); }
  /** The board at a version. */
  docAt(time: string): BoardDoc { return fromRecords(this.h.valueAt(time)); }
  /** The patches (for agents and tests). */
  patches() { return this.h.patches(); }
  close() { this.h.close(); }
}
