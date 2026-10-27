// boardMerge3: the exact three-way merge of a board's records (history.ts's,
// keyed by (type, page, id)), shared by `sagebrush board open --edit`'s hub
// and its pages (plan-board-open-edit r7 §3).  A pure function of its three
// record sets: deterministic, symmetric in its two sides (its value and its
// reports), and charged to a work ledger.
//
// - Records: a record changed on one side only is that side's; deleted on one
//   side and unchanged on the other, deleted; deleted on one side and changed
//   on the other, kept as changed (reported, the deletion its alternative);
//   created on both sides with the same key, merged field by field from an
//   empty base (two different edges between the same ends: both kept).
// - Fields: changed on one side, that side's; changed to equal values, taken
//   once; a text field changed differently on both sides, merged by lines
//   (web/notebook/text-overlap.ts's lineMerge3, the notebooks' detector too)
//   when the two sides' line edits provably don't overlap; when they do (or
//   might: same-gap insertions, touching or ambiguous ranges), a text-overlap
//   conflict, never a hybrid text; any other field changed differently, a
//   conflict.  A conflict keeps the value whose canonical JSON sorts first
//   (absent < null < any JSON value) and the other as its alternative, so both
//   sides' whole values survive.  A missing field is never null.
// - Then the graph, on records, before anything decodes it (fromRecords walks
//   from the roots, so a cycle would vanish there): a parent cycle is broken by
//   moving its member with the smallest key to the top of its page; an item
//   whose parent is missing, not a group or on another page goes to the top of
//   its page; an item whose page is gone brings the page back; an edge with a
//   missing end is removed (its end, restorable, is the alternative);
//   siblings with the same `pos` are ordered by (pos, key).  A change of
//   `paged` on one side with any change on the other is refused.  Every
//   record must then be reachable from a root, or the merge is refused.
// - Work: one ledger per merge.  Every record and field costs a unit; a text
//   merge charges lineMerge3's own work to the same ledger, before it
//   allocates (each diff also at most TEXT_DIFF_PRODUCT_LIMIT units); past the
//   ledger it is {exhausted: true} (a tagged result: no merged text can be taken
//   for it), and the merge is refused, never guessed.  Using exactly
//   the ledger succeeds; the next unit refuses the merge.

import { lineMerge3 } from "../notebook/text-overlap";

/** A record: {type, page, id, ...fields}. */
export type Rec = Record<string, unknown>;
export type MergeReport =
  | { kind: "conflict"; key: string; field: string; kept: unknown; other: unknown }
  /** a text field whose two sides' line edits overlap (or may): a conflict, kept and other whole texts */
  | { kind: "text-overlap"; key: string; field: string; kept: string; other: string }
  | { kind: "kept-after-delete"; key: string }
  | { kind: "both-added-edge"; key: string; other: string }
  | { kind: "cycle"; key: string }
  | { kind: "orphan"; key: string; parent: string }
  | { kind: "page-restored"; key: string }
  | { kind: "edge-removed"; key: string; missing: string[] }
  | { kind: "reordered"; key: string };
/** What a report's one-click alternative would set: a field (ABSENT: removed), a whole record (null: deleted), or
 * several whole records together (a removed edge with the ends it needs). */
export type MergeAlternative =
  | { key: string; field: string; value: unknown }
  | { key: string; record: Rec | null }
  | { key: string; records: { key: string; record: Rec }[] };
export type MergeResult =
  | { records: Rec[]; reports: MergeReport[]; alternatives: MergeAlternative[]; used: number }
  | { refused: "work" | "paged" | "conservation" | "time"; used: number };

export interface MergeOptions {
  /** the work ledger: units this merge may use */
  work: number;
  /** a wall-clock deadline (ms since the epoch): past it, refused (the hub's MERGE_MS) */
  deadline?: number;
  /** the clock (tests) */
  now?: () => number;
}

/** The text fields: merged as text (history.ts's SCHEMA.stringCols). */
export const TEXT_FIELDS = ["title", "text", "code", "detail", "label", "intro"];
/** A field's absence, as an alternative's value. */
export const ABSENT = { absent: true } as const;

const KEY_FIELDS = new Set(["type", "page", "id"]);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** A record's key. */
export const keyOf = (r: Rec) => JSON.stringify([r.type, r.page, r.id]);
/** Canonical JSON (object keys sorted). */
export const canon = (x: unknown): string =>
  JSON.stringify(x, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const NONE = Symbol("absent");
// (the tie-break's order: absent < null < any JSON value, by canonical JSON)
const rank = (v: unknown) => (v === NONE ? "0" : v === null ? "1" : "2" + canon(v));
const same = (x: unknown, y: unknown) => (x === NONE || y === NONE ? x === y : canon(x) === canon(y));
const out = (v: unknown) => (v === NONE ? ABSENT : v);

class Refused extends Error {
  constructor(readonly why: "work" | "paged" | "conservation" | "time") { super(why); }
}

/** Merge a and b, both made from base. */
export function boardMerge3(base: Rec[], a: Rec[], b: Rec[], o: MergeOptions): MergeResult {
  let left = o.work;
  const now = o.now ?? Date.now;
  const charge = (units: number) => {
    left -= units;
    if (left < 0) throw new Refused("work");
    if (o.deadline !== undefined && now() > o.deadline) throw new Refused("time");
  };
  try {
    const r = merge(base, a, b, charge, () => left);
    return { ...r, used: o.work - left };
  } catch (e) {
    if (e instanceof Refused) return { refused: e.why, used: o.work - Math.max(left, 0) };
    throw e;
  }
}

function merge(base: Rec[], a: Rec[], b: Rec[], charge: (n: number) => void, left: () => number) {
  const index = (rs: Rec[]) => {
    const m = new Map<string, Rec>();
    for (const r of rs) { charge(1); m.set(keyOf(r), r); }
    return m;
  };
  const B = index(base), A = index(a), C = index(b);
  const reports: MergeReport[] = [], alternatives: MergeAlternative[] = [];

  // (a change of `paged` on one side, with any change on the other: refused, never merged)
  const DOC = keyOf({ type: "doc", page: "", id: "" });
  const pagedOf = (m: Map<string, Rec>) => !!m.get(DOC)?.paged;
  const changed = (m: Map<string, Rec>) => m.size !== B.size || [...m].some(([k, r]) => !B.has(k) || canon(B.get(k)) !== canon(r));
  if ((pagedOf(A) !== pagedOf(B) && changed(C)) || (pagedOf(C) !== pagedOf(B) && changed(A))) throw new Refused("paged");

  // (both sides' line edits applied to the base, or false when they overlap or may; its work on this merge's ledger)
  const text = (base: string, x: string, y: string): string | false => {
    const ledger = { left: Math.max(left(), 0) };
    const r = lineMerge3(base, x, y, ledger);
    charge(Math.max(left(), 0) - ledger.left);
    if ("exhausted" in r) throw new Refused("work");
    return "text" in r ? r.text : false;
  };
  // a record changed (or created) on both sides: field by field
  const fields = (key: string, r0: Rec | undefined, r1: Rec, r2: Rec): Rec => {
    const names = [...new Set([...Object.keys(r0 ?? {}), ...Object.keys(r1), ...Object.keys(r2)])].sort();
    // (fields defined as own properties: a JSON key such as "__proto__" stays a field, never a prototype)
    const res: Rec = {};
    for (const f of names) {
      charge(1);
      const v0 = r0 && has(r0, f) ? r0[f] : NONE, v1 = has(r1, f) ? r1[f] : NONE, v2 = has(r2, f) ? r2[f] : NONE;
      let v: unknown;
      if (same(v1, v2)) v = v1;
      else if (same(v0, v1)) v = v2;
      else if (same(v0, v2)) v = v1;
      else if (TEXT_FIELDS.includes(f) && typeof v1 === "string" && typeof v2 === "string" && (v0 === NONE || typeof v0 === "string")) {
        const m = text(v0 === NONE ? "" : (v0 as string), v1, v2);
        if (m !== false) v = m;
        else {
          // (the line edits overlap, or may: the two whole texts, one kept and one its alternative, never a hybrid)
          const [kept, other] = rank(v1) <= rank(v2) ? [v1, v2] : [v2, v1];
          v = kept;
          reports.push({ kind: "text-overlap", key, field: f, kept, other });
          alternatives.push({ key, field: f, value: other });
        }
      } else {
        // (a conflict: the first by the tie-break's order kept, the other its alternative)
        const [kept, other] = rank(v1) <= rank(v2) ? [v1, v2] : [v2, v1];
        v = kept;
        reports.push({ kind: "conflict", key, field: f, kept: out(kept), other: out(other) });
        alternatives.push({ key, field: f, value: out(other) });
      }
      if (v !== NONE) Object.defineProperty(res, f, { value: v, enumerable: true, writable: true, configurable: true });
    }
    return res;
  };

  const merged = new Map<string, Rec>();
  const keys = [...new Set([...B.keys(), ...A.keys(), ...C.keys()])].sort();
  const extraEdges: Rec[] = [];
  for (const k of keys) {
    charge(1);
    const r0 = B.get(k), r1 = A.get(k), r2 = C.get(k);
    const c1 = r1 !== undefined && (r0 === undefined || canon(r0) !== canon(r1)); // changed (or created) on a
    const c2 = r2 !== undefined && (r0 === undefined || canon(r0) !== canon(r2));
    if (r1 === undefined && r2 === undefined) continue; // (deleted on both, or on one and never on the other)
    if (r1 === undefined || r2 === undefined) {
      const there = (r1 ?? r2)!, changedThere = r1 === undefined ? c2 : c1;
      if (r0 === undefined) { merged.set(k, there); continue; } // (created on one side)
      if (!changedThere) continue; // (deleted on one side, unchanged on the other)
      merged.set(k, there); // (deleted on one side, edited on the other: kept)
      reports.push({ kind: "kept-after-delete", key: k });
      alternatives.push({ key: k, record: null });
      continue;
    }
    if (!c1) { merged.set(k, r2); continue; }
    if (!c2 || canon(r1) === canon(r2)) { merged.set(k, r1); continue; }
    if (r0 === undefined && r1.type === "edge") {
      // (two edges added between the same ends: both kept, the one first by canonical JSON at this key)
      const [first, second] = canon(r1) <= canon(r2) ? [r1, r2] : [r2, r1];
      merged.set(k, first);
      extraEdges.push(second);
      continue;
    }
    merged.set(k, fields(k, r0, r1, r2));
  }
  for (const e of extraEdges) {
    // (the next free count between the same ends: a key of its own)
    const [from, to] = JSON.parse(String(e.id));
    let c = 1;
    while (merged.has(keyOf({ type: "edge", page: e.page, id: JSON.stringify([from, to, c]) }))) { charge(1); c++; }
    const moved = { ...e, id: JSON.stringify([from, to, c]) };
    merged.set(keyOf(moved), moved);
    reports.push({ kind: "both-added-edge", key: keyOf(e), other: keyOf(moved) });
  }

  repair(merged, B, A, C, reports, alternatives, charge);
  conserve(merged, charge);
  const order = (x: { key: string }, y: { key: string }) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
  const sortStable = <T extends { key: string }>(xs: T[]) => xs.map((x, i) => [x, canon(x), i] as const).sort((p, q) => order(p[0], q[0]) || (p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0)).map((p) => p[0]);
  return {
    records: [...merged.keys()].sort().map((k) => merged.get(k)!),
    reports: sortStable(reports),
    alternatives: sortStable(alternatives),
  };
}

/** The graph's repair, on records (§3.3). */
function repair(m: Map<string, Rec>, B: Map<string, Rec>, A: Map<string, Rec>, C: Map<string, Rec>, reports: MergeReport[], alternatives: MergeAlternative[], charge: (n: number) => void) {
  const doc = m.get(keyOf({ type: "doc", page: "", id: "" }));
  const paged = !!doc?.paged;
  const pageKey = (pid: unknown) => keyOf({ type: "page", page: pid, id: "" });
  // an item or an edge whose page is gone: the page back (from the base, or the side that still has it)
  if (paged) {
    for (const r of [...m.values()]) {
      charge(1);
      if ((r.type === "item" || r.type === "edge") && !m.has(pageKey(r.page))) {
        const k = pageKey(r.page), back = B.get(k) ?? A.get(k) ?? C.get(k) ?? { type: "page", page: r.page, id: "", pos: Number.MAX_SAFE_INTEGER };
        m.set(k, back);
        reports.push({ kind: "page-restored", key: k });
        alternatives.push({ key: k, record: null });
      }
    }
  }
  // (each page's item keys, found once: repair below replaces items' records, never adds or removes one)
  const keysOf = new Map<unknown, string[]>();
  for (const [k, r] of m) if (r.type === "item") (keysOf.get(r.page) ?? keysOf.set(r.page, []).get(r.page)!).push(k);
  const byId = (pid: unknown) => new Map((keysOf.get(pid) ?? []).map((k) => m.get(k)!).filter(Boolean).map((r) => [String(r.id), r]));
  const pages = [...keysOf.keys()].sort((x, y) => canon(x) < canon(y) ? -1 : 1);
  for (const pid of pages) {
    const ids = byId(pid);
    // a parent missing, or not a group: the item to the top of its page
    for (const r of [...ids.values()].sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : 1))) {
      charge(1);
      if (r.parent === "" || r.parent === undefined) continue;
      const p = ids.get(String(r.parent));
      if (!p || p.kind !== "group") {
        const k = keyOf(r);
        alternatives.push({ key: k, field: "parent", value: r.parent });
        reports.push({ kind: "orphan", key: k, parent: String(r.parent) });
        m.set(k, { ...r, parent: "" });
        ids.set(String(r.id), m.get(k)!);
      }
    }
    // parent cycles: each broken at its member with the smallest key
    const state = new Map<string, number>(); // 1: on the path, 2: done
    for (const start of [...ids.keys()].sort()) {
      const path: string[] = [];
      let id: string | undefined = start;
      while (id !== undefined && !state.has(id)) {
        charge(1);
        state.set(id, 1);
        path.push(id);
        const r: Rec = ids.get(id)!;
        id = r.parent === "" || r.parent === undefined ? undefined : String(r.parent);
      }
      if (id !== undefined && state.get(id) === 1) {
        const cycle = path.slice(path.indexOf(id));
        const cut = cycle.map((x) => ids.get(x)!).sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : 1))[0];
        const k = keyOf(cut);
        alternatives.push({ key: k, field: "parent", value: cut.parent });
        reports.push({ kind: "cycle", key: k });
        m.set(k, { ...cut, parent: "" });
        ids.set(String(cut.id), m.get(k)!);
      }
      for (const x of path) state.set(x, 2);
    }
  }
  // an edge with a missing end: removed; its alternative brings back the edge as merged (every edit kept) together
  // with each missing end, from the side that still had it (each page's items indexed once: removing edges
  // changes no item)
  const idsOf = new Map<unknown, Map<string, Rec>>();
  for (const r of [...m.values()].filter((r) => r.type === "edge").sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : 1))) {
    charge(1);
    let ids = idsOf.get(r.page);
    if (!ids) { ids = byId(r.page); idsOf.set(r.page, ids); }
    const missing = [...new Set([r.from, r.to].map(String))].filter((e) => !ids.has(e));
    if (missing.length) {
      const k = keyOf(r), endKeys = missing.map((id) => keyOf({ type: "item", page: r.page, id })).sort();
      m.delete(k);
      reports.push({ kind: "edge-removed", key: k, missing: endKeys });
      const ends = endKeys.map((ek) => ({ key: ek, record: A.get(ek) ?? C.get(ek) ?? B.get(ek) })).filter((e): e is { key: string; record: Rec } => !!e.record);
      alternatives.push({ key: k, records: [{ key: k, record: r }, ...ends] });
    }
  }
  // siblings with the same pos: ordered by (pos, key)
  const groups = new Map<string, Rec[]>();
  for (const r of m.values()) {
    charge(1);
    const g = r.type === "item" ? JSON.stringify(["item", r.page, r.parent ?? ""]) : r.type === "edge" ? JSON.stringify(["edge", r.page]) : r.type === "page" ? "page" : null;
    if (g !== null) (groups.get(g) ?? groups.set(g, []).get(g)!).push(r);
  }
  for (const g of [...groups.keys()].sort()) {
    const rs = groups.get(g)!;
    const poses = rs.map((r) => Number(r.pos ?? 0));
    if (new Set(poses).size === poses.length) continue;
    rs.sort((x, y) => Number(x.pos ?? 0) - Number(y.pos ?? 0) || (keyOf(x) < keyOf(y) ? -1 : 1));
    rs.forEach((r, i) => {
      charge(1);
      if (r.pos !== i) {
        const k = keyOf(r);
        m.set(k, { ...r, pos: i });
        reports.push({ kind: "reordered", key: k });
      }
    });
  }
}

/** Every record reachable from a root, or refused (§3.3, conservation). */
function conserve(m: Map<string, Rec>, charge: (n: number) => void) {
  const doc = m.get(keyOf({ type: "doc", page: "", id: "" }));
  if (!doc) throw new Refused("conservation");
  const paged = !!doc.paged;
  const pages = new Set([...m.values()].filter((r) => r.type === "page").map((r) => canon(r.page)));
  for (const r of m.values()) {
    charge(1);
    if (r.type === "doc") continue;
    if (r.type === "page") { if (!paged) throw new Refused("conservation"); continue; }
    if (r.type !== "item" && r.type !== "edge") throw new Refused("conservation");
    // (on a page that exists: a page of a paged board, or the one page "" of an unpaged one)
    if (paged ? !pages.has(canon(r.page)) : r.page !== "") throw new Refused("conservation");
  }
  // (every item reachable from its page's top level: no parent chain left dangling or circular)
  const items = [...m.values()].filter((r) => r.type === "item");
  const kids = new Map<string, Rec[]>();
  for (const r of items) {
    const k = JSON.stringify([r.page, r.parent ?? ""]);
    (kids.get(k) ?? kids.set(k, []).get(k)!).push(r);
  }
  let reached = 0;
  const seen = new Set<string>();
  const walk = (page: unknown, parent: string) => {
    for (const r of kids.get(JSON.stringify([page, parent])) ?? []) {
      charge(1);
      const k = keyOf(r);
      if (seen.has(k)) throw new Refused("conservation");
      seen.add(k);
      reached++;
      if (r.kind === "group") walk(page, String(r.id));
    }
  };
  for (const page of new Set(items.map((r) => r.page))) walk(page, "");
  if (reached !== items.length) throw new Refused("conservation");
}
