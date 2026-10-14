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
// (A page without an id is "#" and its place; an edge is "from→to", then
// "#2" and so on for more between the same two.)  The text fields are string
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
interface Records {
  get(where: object): any[];
  getOne(where: object): any;
  set(r: object): Records;
  delete(where: object): Records;
  isEqual(o: Records): boolean;
}
interface PatchHistoryLike {
  init(): Promise<unknown>;
  on(f: () => void): () => void;
  committed(): Records;
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
      const k = `${e.from}→${e.to}`, c = (seen.get(k) ?? 0) + 1;
      seen.set(k, c);
      out.push({ type: "edge", page: pid, ...e, id: c > 1 ? `${k}#${c}` : k, pos });
    });
  };
  if (pages?.length) {
    pages.forEach((p, i) => {
      const { nodes: _n, edges: _e, id, ...rest } = p as any;
      const pid = id ?? `#${i}`;
      out.push({ type: "page", page: pid, ...rest, id: "", pos: i });
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
      const { type: _a, page: pid, id: _c, pos: _d, ...rest } = plain(p);
      return { ...(pid.startsWith("#") ? {} : { id: pid }), ...rest, ...build(pid) };
    });
  } else Object.assign(d, build(""));
  return d as BoardDoc;
}

export class BoardHistory {
  private h: PatchHistoryLike;
  constructor(mod: HistoryModule, store: unknown) {
    this.h = new mod.PatchHistory(store, mod.createImmerDbCodec(SCHEMA));
  }
  async init() { await this.h.init(); return this; }
  on(f: () => void) { return this.h.on(f); }
  /** Keep the board as it is now as a version (nothing if it has not changed): only what changed. */
  record(d: BoardDoc) {
    const cur = this.h.committed();
    let next = cur;
    const key = (r: any) => `${r.type}\0${r.page}\0${r.id}`;
    const want = new Map(toRecords(d).map((r) => [key(r), r]));
    for (const t of TYPES) for (const r of cur.get({ type: t })) if (!want.has(key(r))) next = next.delete({ type: r.type, page: r.page, id: r.id });
    for (const r of want.values()) {
      const old = cur.getOne({ type: r.type, page: r.page, id: r.id });
      if (old && canon(old) === canon(r)) continue;
      // (a field taken off: the record anew; otherwise patched in place)
      if (old && Object.keys(old).some((k) => !(k in r))) next = next.delete({ type: r.type, page: r.page, id: r.id });
      next = next.set(r);
    }
    return this.h.commit(next);
  }
  /** The versions, oldest first. */
  versions(): Version[] { return this.h.versions(); }
  /** The board at a version. */
  docAt(time: string): BoardDoc { return fromRecords(this.h.valueAt(time)); }
  /** The patches (for agents and tests). */
  patches() { return this.h.patches(); }
  close() { this.h.close(); }
}
