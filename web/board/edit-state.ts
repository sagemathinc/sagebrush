// A host's side of editing a board in its frame (web/board-host-protocol.md,
// "Editing"): the board as records keyed by (type, page, id) (history.ts
// toRecords), each `edit` the frame sends merged into them as they are now,
// field by field (text as a patch from what the user saw, `was`; any other
// field the edit's: the later side; dbMerge3's rules for deletes), and the
// board that results checked, before anything is kept, on the records the
// edit touched and those beside them: pages, parents (groups on the page, no
// cycles, at most 64 levels), no orphans, edges' ends, the size.  Indexes
// kept as the records change (items' kinds, children per group, edges per
// item, records per page, each record's size) make every check, and the
// merge, cost what the edit touches, never the whole board.  The host's own
// changes (another tab, an agent writing the file) come in by remote() or
// reset(), and keep the indexes as edits do.  recordProblems() is the same
// rules over a whole board, for tests and for hosts that want them.
import { toRecords, fromRecords, SCHEMA } from "./history";
import { formatError, isBoard, type BoardDoc } from "./doc";

export const EDIT_LIMITS = {
  /** an editable board, as UTF-8 JSON of its records */
  boardBytes: 8 * 2 ** 20,
  /** one message, as UTF-8 JSON */
  messageBytes: 2 ** 20,
  changes: 1000,
  fields: 200,
  keyChars: 200,
  fieldName: 64,
  depth: 16,
  /** edit ids remembered per channel */
  ids: 100,
  /** parents followed from an item */
  levels: 64,
  /** records in an editable board */
  records: 100_000,
  /** edits per channel: a bucket of 20, refilled at 2 a second */
  editBurst: 20,
  editsPerSecond: 2,
  /** work per channel, in bytes (the edit, plus the current size of the records it touches): 32 MiB, refilled at 3.2 MiB a second */
  workBurst: 32 * 2 ** 20,
  workPerSecond: 3.2 * 2 ** 20,
} as const;

export type RecordType = "doc" | "page" | "item" | "edge";
export interface Key { type: RecordType; page: string; id: string }
export type Rec = Key & { [field: string]: unknown };
/** A change as the frame sends it (with `was`), or as the host sends and writes it (without). */
export type Change =
  | { op: "set"; key: Key; fields: { [field: string]: unknown }; was?: { [field: string]: unknown }; create?: boolean; record?: { [field: string]: unknown } }
  | { op: "delete"; key: Key; was?: { [field: string]: unknown } };
/** Why an edit was refused, for the host's `refused` (web/board-host-protocol.md, Refusals): "busy" (the
 * rate or the work budget: `retryAfter` says when), "too-large" (the edit, the board or the work it needs:
 * `limit` and `size`, in bytes or records), "invalid" (it failed a check). */
export type RefusalReason = "busy" | "too-large" | "invalid";
export type Applied =
  /** merged: `changes` is what changed in the board (for the host to write, and to send in `saved`), `dropped` the keys of the edit's changes that had no effect */
  | { ok: true; id: string; changes: Change[]; dropped: Key[] }
  /** not merged: why (the host's `refused`); `retryAfter` (ms): the rate or the work budget, to send again;
   * `ignore`: an id already answered (nothing to answer) */
  | { ok: false; id?: string; message: string; reason?: RefusalReason; limit?: number; size?: number; retryAfter?: number; ignore?: true };
/** What apply would do with the same message now, nothing of the board's changed: merged, with the board's
 * size after it (`boardBytes`) and the message's own (`editBytes`, its UTF-8 JSON: what a host's admission
 * charges for the edit, never `boardBytes`), or refused, as apply would refuse it. */
// (`workBytes`: the work the preview did, in the work budget's bytes (the edit's size, the records its changes
// passed over, 64 a visit of the walk): for a host to charge its own admission, refused or not: LIMIT-74B-1)
export type Previewed = (Applied & { ok: true; boardBytes: number; editBytes: number; workBytes: number }) | (Applied & { ok: false; editBytes?: number; workBytes: number });
/** How the board's pictures travel: "inline" (in the board, as data: URLs: the default, as before) or
 * "by-reference" (sent apart, by `imagePut`: an edit giving a picture any source but an https: address is
 * refused). */
export interface EditOptions { pictures?: "inline" | "by-reference" }

const TEXT = new Set(SCHEMA.stringCols);
const TYPES = new Set<string>(["doc", "page", "item", "edge"]);
const BAD_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const KEY_FIELDS = new Set(["type", "page", "id"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enc = new TextEncoder();
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v: unknown): v is { [k: string]: unknown } => !!v && typeof v === "object" && !Array.isArray(v);
// (a record's key, and an item's place, as JSON: no two (type, page, id) the same, whatever the ids
// hold, NUL and quotes included (astra's CORR-64C-1))
const keyOf = (k: Key) => JSON.stringify([k.type, k.page, k.id]);
const at = (page: string, id: string) => JSON.stringify([page, id]);
const itemKey = (page: string, id: string) => keyOf({ type: "item", page, id });
const DOC = keyOf({ type: "doc", page: "", id: "" });
const bytesOf = (r: Rec) => enc.encode(JSON.stringify(r)).length;
// (a record from fields, as own properties only, its key first)
function record(key: Key, fields: { [k: string]: unknown }): Rec {
  const r: { [k: string]: unknown } = Object.create(null);
  r.type = key.type; r.page = key.page; r.id = key.id;
  for (const f of Object.keys(fields)) if (!KEY_FIELDS.has(f) && fields[f] !== null && fields[f] !== undefined) r[f] = fields[f];
  return r as Rec;
}
function copyRec(r: Rec): Rec {
  const c: { [k: string]: unknown } = Object.create(null);
  for (const f of Object.keys(r)) c[f] = r[f];
  return c as Rec;
}

// ------------------------------------------------------------ text merge
/** Where `x` differs from `base`: base[s, e) replaced by `text` (one span, surrogate pairs kept whole). */
function span(base: string, x: string): { s: number; e: number; text: string } {
  const n = Math.min(base.length, x.length);
  let p = 0;
  while (p < n && base.charCodeAt(p) === x.charCodeAt(p)) p++;
  if (p > 0 && p < base.length && /[\ud800-\udbff]/.test(base[p - 1])) p--;
  let q = 0;
  while (q < n - p && base.charCodeAt(base.length - 1 - q) === x.charCodeAt(x.length - 1 - q)) q++;
  if (q > 0 && q < base.length - p && /[\udc00-\udfff]/.test(base[base.length - q])) q--;
  return { s: p, e: base.length - q, text: x.slice(p, x.length - q) };
}
/**
 * A text field merged three ways: what the user saw (`base`), what they made
 * of it (`ours`), what it is now (`theirs`).  Changes in different places
 * both kept; two insertions at one place both kept, theirs first; where the
 * two changed the same text, ours (the later side) for that part.
 */
export function mergeText(base: string, ours: string, theirs: string): string {
  if (ours === base || ours === theirs) return theirs;
  if (theirs === base) return ours;
  const a = span(base, ours), b = span(base, theirs);
  const bothInsert = a.s === a.e && b.s === b.e && a.s === b.s;
  if (bothInsert) return base.slice(0, a.s) + b.text + a.text + base.slice(a.e);
  if (a.e <= b.s || b.e <= a.s) {
    // (in order; at one place, an insertion before a change that starts there)
    const [first, second] = a.s < b.s || (a.s === b.s && a.e <= b.e) ? [a, b] : [b, a];
    return base.slice(0, first.s) + first.text + base.slice(first.e, second.s) + second.text + base.slice(second.e);
  }
  const s = Math.min(a.s, b.s), e = Math.max(a.e, b.e);
  return base.slice(0, s) + base.slice(s, a.s) + a.text + base.slice(a.e, e) + base.slice(e);
}

const isPlain = (v: unknown): v is { [k: string]: unknown } => !!v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
/** Two JSON values equal (maps whatever their keys' order). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isPlain(a) && isPlain(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => own(b, k) && same(a[k], b[k]));
  }
  return false;
}
/**
 * A field merged three ways, as CoCalc's dbMerge3 (mergeValue) merges: what
 * the user saw (`base`), what it is now (`cur`), what the edit makes it
 * (`ours`); `undefined` is absent.  Unchanged on one side: the other's.  A
 * removal against a change: the change.  Text: mergeText.  Maps: key by
 * key, against {} when the base isn't one.  Otherwise the edit's (the later
 * side).
 */
export function mergeValue(base: unknown, cur: unknown, ours: unknown, text = false): unknown {
  if (same(cur, ours)) return cur;
  if (same(base, cur)) return ours;
  if (same(base, ours)) return cur;
  if (cur === undefined) return ours;
  if (ours === undefined) return cur;
  if (text && typeof cur === "string" && typeof ours === "string") return mergeText(typeof base === "string" ? base : "", ours, cur);
  if (isPlain(cur) && isPlain(ours)) {
    const b = isPlain(base) ? base : {}, out: { [k: string]: unknown } = Object.create(null);
    for (const k of new Set([...Object.keys(b), ...Object.keys(cur), ...Object.keys(ours)])) {
      const v = mergeValue(own(b, k) ? b[k] : undefined, own(cur, k) ? cur[k] : undefined, own(ours, k) ? ours[k] : undefined);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return ours;
}

// ------------------------------------------------------------ checking a message
/** Plain JSON data, nested at most `depth`, at most `bytes` as UTF-8: why not, or null. */
function plainProblem(m: unknown, depth: number, bytes: number, MAX = 200_000): string | null {
  const plain = "an edit is plain JSON data";
  const stack: [unknown, number][] = [[m, 1]];
  let found = 1, chars = 0;
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (typeof v === "string") { if ((chars += v.length) > bytes) return `an edit is at most ${bytes / 2 ** 20} MiB`; continue; }
    if (v === null || typeof v === "boolean") continue;
    if (typeof v === "number") { if (!Number.isFinite(v)) return "an edit's numbers are finite"; continue; }
    if (d > depth) return `an edit nests at most ${depth} deep`;
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) return plain;
      if ((found += v.length) > MAX) return "an edit has too many values";
      for (let i = 0; i < v.length; i++) stack.push([v[i], d + 1]);
      continue;
    }
    if (typeof v !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return plain;
    for (const k in v) {
      if (!own(v, k)) continue;
      if (++found > MAX) return "an edit has too many values";
      if ((chars += k.length) > bytes) return `an edit is at most ${bytes / 2 ** 20} MiB`;
      stack.push([(v as any)[k], d + 1]);
    }
  }
  let n: number;
  try { n = enc.encode(JSON.stringify(m)).length; } catch { return plain; }
  return n > bytes ? `an edit is at most ${bytes / 2 ** 20} MiB` : null;
}
const goodName = (f: string) => f.length > 0 && f.length <= EDIT_LIMITS.fieldName && !BAD_NAMES.has(f);
function keyProblem(k: unknown): string | null {
  if (!isObj(k) || !TYPES.has(k.type as string) || typeof k.page !== "string" || typeof k.id !== "string") return "a change's key is {type, page, id}";
  // (an edge's id is the JSON of its two ends and its ordinal (history.ts toRecords): room for both ends
  // escaped at worst, 6 characters each (\u0000), and the ordinal (astra's CORR-40A-1))
  const idMax = k.type === "edge" ? 2 * (6 * EDIT_LIMITS.keyChars + 2) + 48 : EDIT_LIMITS.keyChars;
  if (k.page.length > EDIT_LIMITS.keyChars || k.id.length > idMax) return `a key's page and id are at most ${EDIT_LIMITS.keyChars} characters (an edge's id ${idMax})`;
  if (k.type === "doc" && (k.page !== "" || k.id !== "")) return "the doc record's key is {type: \"doc\", page: \"\", id: \"\"}";
  if (k.type === "page" && k.id !== "") return "a page record's id is \"\"";
  if (k.type === "page" && k.page === "") return "a page record's page isn't \"\"";
  // (an item's or edge's id is never "": that is the top's, a parent of none (astra's CORR-64C-2))
  if ((k.type === "item" || k.type === "edge") && k.id === "") return `an ${k.type}'s id isn't ""`;
  return null;
}
function fieldsProblem(f: unknown, what: string): string | null {
  if (!isObj(f)) return `a change's ${what} is an object`;
  let n = 0;
  for (const k of Object.keys(f)) {
    if (++n > EDIT_LIMITS.fields) return `a change has at most ${EDIT_LIMITS.fields} fields`;
    if (!goodName(k)) return `a field's name is 1 to ${EDIT_LIMITS.fieldName} characters, and not ${[...BAD_NAMES].join(", ")}`;
  }
  return null;
}
function changeProblem(c: unknown): string | null {
  if (!isObj(c) || (c.op !== "set" && c.op !== "delete")) return "a change is {op: \"set\" or \"delete\", key, …}";
  const kp = keyProblem(c.key);
  if (kp) return kp;
  if (c.op === "delete") {
    if (c.was !== undefined) { const p = fieldsProblem(c.was, "was"); if (p) return p; }
    return null;
  }
  const p = fieldsProblem(c.fields, "fields") ?? (c.was !== undefined ? fieldsProblem(c.was, "was") : null) ?? (c.record !== undefined ? fieldsProblem(c.record, "record") : null);
  if (p) return p;
  if (Object.keys(c.fields as object).some((f) => KEY_FIELDS.has(f))) return "a change's fields never hold type, page or id";
  if (c.create !== undefined && c.create !== true) return "create is true, or not given";
  const was = (c.was ?? {}) as object, fields = c.fields as object;
  if (c.create) { if (Object.keys(was).length) return "a creation has no was"; }
  else if (Object.keys(was).length !== Object.keys(fields).length || Object.keys(fields).some((f) => !own(was, f))) return "was has exactly the fields of fields";
  if (c.record !== undefined) {
    const r = c.record as { [k: string]: unknown };
    for (const f of ["type", "page", "id"]) if (own(r, f) && r[f] !== (c.key as any)[f]) return "a change's record has its key";
  }
  return null;
}

// ------------------------------------------------------------ the board's rules
/** An item's parents: groups on its page, never round to one seen before, at most 64 levels.  Why not, or null. */
function parentProblem(r: Rec, get: (page: string, id: string) => Rec | null): string | null {
  if (typeof r.parent !== "string") return `item "${r.id}" has a parent ("" at the top)`;
  const seen = new Set<string>([r.id]);
  let x: Rec = r;
  while (x.parent !== "") {
    const p = get(x.page, x.parent as string);
    if (!p || p.kind !== "group") return `item "${x.id}"'s parent is a group on its page`;
    if (seen.has(p.id)) return `item "${r.id}"'s parents go round`;
    seen.add(p.id);
    if (seen.size - 1 > EDIT_LIMITS.levels) return `item "${r.id}" is more than ${EDIT_LIMITS.levels} levels deep`;
    if (typeof p.parent !== "string") return `item "${p.id}" has a parent ("" at the top)`;
    x = p;
  }
  return null;
}
/** What breaks the rules in these records (the whole board): [] when nothing. */
export function recordProblems(records: Iterable<Rec>): string[] {
  const all = new Map<string, Rec>();
  for (const r of records) all.set(keyOf(r), r);
  const out: string[] = [];
  const doc = all.get(DOC);
  if (!doc) return ["no doc record"];
  const paged = doc.paged === true;
  const pages = new Set([...all.values()].filter((r) => r.type === "page").map((r) => r.page));
  if (paged && !pages.size) out.push("a paged board without pages");
  if (!paged && pages.size) out.push("page records on a board without pages");
  for (const r of all.values()) {
    const kp = keyProblem(r);
    if (kp) out.push(kp);
    if (r.type !== "item" && r.type !== "edge") continue;
    if (paged ? !pages.has(r.page) : r.page !== "") out.push(`${r.type} ${r.id} on a page that isn't there`);
    if (r.type === "item") {
      if (typeof r.parent !== "string") { out.push(`item ${r.id} without a parent`); continue; }
      const why = parentProblem(r, (page, id) => all.get(itemKey(page, id)) ?? null);
      if (why) out.push(why);
    } else for (const end of [r.from, r.to]) if (typeof end !== "string" || !all.has(itemKey(r.page, end))) out.push(`edge ${r.id} names an item that isn't on its page`);
  }
  let bytes = 0;
  for (const r of all.values()) bytes += bytesOf(r);
  if (bytes > EDIT_LIMITS.boardBytes) out.push(`more than ${EDIT_LIMITS.boardBytes / 2 ** 20} MiB`);
  if (all.size > EDIT_LIMITS.records) out.push(`more than ${EDIT_LIMITS.records} records`);
  return out;
}

// ------------------------------------------------------------ the state
export interface EditState {
  /** An `edit` message from the frame, merged and checked; kept only if it passes.  `now`: the clock (ms) for the rate. */
  apply(message: unknown, now?: number): Applied;
  /** The same as apply, changing nothing of the board's: not the records, apply's rate and work budgets, the ids
   * answered or lastWalk.  Its own work is metered by budgets of its own, the same as apply's, so previews
   * alone are bounded too (daybreak2's LIMIT-74B-1).  apply with the same message, state and clock decides the
   * same; between the two, other edits and remote changes can make apply decide otherwise, so a host still
   * applies (and may be refused) at commit. */
  preview(message: unknown, now?: number): Previewed;
  /** The host's own changes (another tab, an agent), as they are, merged without rules but within the
   * bounds: plain JSON, 8 MiB, 100,000 records, all or none.  Refused: the board can't be edited here as
   * it now is (the host ends editing, or resets to a board that can be). */
  remote(changes: Change[]): { ok: true } | { ok: false; message: string };
  /** The host's whole board, anew (an agent rewrote the file). */
  reset(text: string): void;
  /** An edit id the host answered itself (a refusal for the rate): remembered as answered. */
  answered(id: string): void;
  /** The board as it is now (for a `replace`: costs the whole board). */
  board(): BoardDoc;
  /** Its records as they are now. */
  records(): Rec[];
  /** Its size: UTF-8 bytes of its records' JSON. */
  readonly bytes: number;
  /** Items the last edit's walk visited (under the groups it moved or made): for tests and a host's metrics. */
  readonly lastWalk: number;
}

/**
 * A board posted for editing (web/board-host-protocol.md, "Editing"), as its
 * host's record of it: at most 8 MiB as UTF-8 text, a board of this format.
 * Throws when it can't be edited in a frame (too large, not a board).
 */
export function editState(postedText: string, options: EditOptions = {}): EditState {
  if (enc.encode(postedText).length > EDIT_LIMITS.boardBytes) throw new Error(`a board edited in a frame is at most ${EDIT_LIMITS.boardBytes / 2 ** 20} MiB`);
  const recs = new Map<string, Rec>(), sizes = new Map<string, number>();
  // (indexes: children per group and edges per item, keyed page\0id; items and edges per page; page records)
  const kids = new Map<string, number>(), edges = new Map<string, number>(), onPage = new Map<string, number>();
  // (each group's children, by page\0group: for the walk under a moved group)
  const kidSets = new Map<string, Set<string>>();
  let pageRecs = 0, bytes = 0;
  const ids: string[] = [], idSet = new Set<string>();
  const bump = (m: Map<string, number>, k: string, d: number) => { const v = (m.get(k) ?? 0) + d; if (v) m.set(k, v); else m.delete(k); };
  // (a record's part in the indexes, added (+1) or taken out (-1))
  function index(r: Rec, d: number, into = { kids, edges, onPage, pages: (n: number) => { pageRecs += n; } }) {
    if (r.type === "page") into.pages(d);
    if (r.type === "item") { bump(into.onPage, r.page, d); if (typeof r.parent === "string" && r.parent !== "") bump(into.kids, at(r.page, r.parent), d); }
    if (r.type === "edge") {
      bump(into.onPage, r.page, d);
      if (typeof r.from === "string") bump(into.edges, at(r.page, r.from), d);
      if (typeof r.to === "string" && r.to !== r.from) bump(into.edges, at(r.page, r.to), d);
    }
  }
  function kid(r: Rec, add: boolean) {
    if (r.type !== "item" || typeof r.parent !== "string" || r.parent === "") return;
    const g = at(r.page, r.parent);
    let set = kidSets.get(g);
    if (add) { if (!set) kidSets.set(g, (set = new Set())); set.add(r.id); }
    else if (set) { set.delete(r.id); if (!set.size) kidSets.delete(g); }
  }
  function put(k: string, r: Rec | null) {
    const old = recs.get(k);
    if (old) { index(old, -1); kid(old, false); bytes -= sizes.get(k)!; recs.delete(k); sizes.delete(k); }
    if (r) { const n = bytesOf(r); recs.set(k, r); sizes.set(k, n); bytes += n; index(r, 1); kid(r, true); }
  }
  function load(text: string) {
    const d = JSON.parse(text);
    const bad = formatError(d);
    if (bad) throw new Error(bad);
    if (!isBoard(d)) throw new Error("not a board: a document needs nodes (or pages of them)");
    const all = toRecords(d as BoardDoc);
    if (all.length > EDIT_LIMITS.records) throw new Error(`a board edited in a frame has at most ${EDIT_LIMITS.records} records`);
    for (const r of all) { const bad = keyProblem(r); if (bad) throw new Error(`not a board this page can edit: ${bad}`); }
    // (the size an edit is held to: its records' JSON, a little more than the file's text;
    // checked before anything here changes, so a reset refused leaves the board as it was)
    const made = all.map((r) => record(r, r));
    let total = 0;
    for (const r of made) total += bytesOf(r);
    if (total > EDIT_LIMITS.boardBytes) throw new Error(`a board edited in a frame is at most ${EDIT_LIMITS.boardBytes / 2 ** 20} MiB`);
    recs.clear(); sizes.clear(); kids.clear(); kidSets.clear(); edges.clear(); onPage.clear(); pageRecs = 0; bytes = 0;
    for (const r of made) put(keyOf(r), r);
  }
  load(postedText);
  function remember(id: string) {
    if (idSet.has(id)) return;
    ids.push(id); idSet.add(id);
    while (ids.length > EDIT_LIMITS.ids) idSet.delete(ids.shift()!);
  }
  const textChanged = (now: Rec, was: { [k: string]: unknown } | undefined) => {
    for (const f of TEXT) if ((now[f] ?? null) !== ((was && own(was, f) ? was[f] : null) ?? null)) return true;
    return false;
  };
  const touchesText = (fields: object) => Object.keys(fields).some((f) => TEXT.has(f));

  let lastWalk = 0;
  // (the rate and the work budget: token buckets, full at the start)
  const bucket = { edits: EDIT_LIMITS.editBurst as number, work: EDIT_LIMITS.workBurst as number, clock: -1 };
  function refill(b: typeof bucket, now: number) {
    if (b.clock >= 0 && now > b.clock) {
      const s = (now - b.clock) / 1000;
      b.edits = Math.min(EDIT_LIMITS.editBurst, b.edits + s * EDIT_LIMITS.editsPerSecond);
      b.work = Math.min(EDIT_LIMITS.workBurst, b.work + s * EDIT_LIMITS.workPerSecond);
    }
    if (now > b.clock) b.clock = now;
  }
  // (preview's own rate and work: as apply's, charged by previews alone)
  const previewBucket = { ...bucket };
  let charged = 0;
  const byReference = options.pictures === "by-reference";

  // (apply and preview are this one function: `commit` false runs every step on preview's own budgets, and
  // keeps nothing else (the records, the ids answered, lastWalk), so the two decide alike: lite2's A2B-GATE-1)
  function run(m: unknown, now: number, commit: boolean): Applied & { boardBytes?: number } {
    const B = commit ? bucket : previewBucket;
    charged = 0;
    const id = isObj(m) && typeof m.id === "string" && UUID.test(m.id) ? m.id : undefined;
    const keep = (id: string) => { if (commit) remember(id); };
    const no = (message: string, reason: RefusalReason = "invalid", sized?: { limit: number; size: number }): Applied => { if (id) keep(id); return { ok: false, ...(id ? { id } : {}), message, reason, ...(sized ?? {}) }; };
    if (id && idSet.has(id)) return { ok: false, id, message: "answered already", ignore: true };
    const plain = plainProblem(m, EDIT_LIMITS.depth, EDIT_LIMITS.messageBytes);
    if (plain) return no(plain, /MiB|too many values/.test(plain) ? "too-large" : "invalid");
    const msg = m as { [k: string]: unknown };
    if (msg.sagebrush !== "edit" || msg.version !== 1) return no("not an edit");
    if (!id) return no("an edit's id is a UUID");
    if (typeof msg.base !== "string" || msg.base.length > 200) return no("an edit's base is a revision");
    if (!Array.isArray(msg.changes)) return no(`an edit has a list of at most ${EDIT_LIMITS.changes} changes`);
    if (msg.changes.length > EDIT_LIMITS.changes) return no(`an edit has a list of at most ${EDIT_LIMITS.changes} changes`, "too-large", { limit: EDIT_LIMITS.changes, size: msg.changes.length });
    for (const c of msg.changes) { const p = changeProblem(c); if (p) return no(p); }
    const changes = msg.changes as Change[];

    // the rate, then the work: the edit's size and the current size of the records it touches
    refill(B, now);
    const later = (message: string, ms: number): Applied => { keep(id); return { ok: false, id, message, reason: "busy", retryAfter: Math.max(1, Math.ceil(ms)) }; };
    if (B.edits < 1) return later("too many edits at once", ((1 - B.edits) / EDIT_LIMITS.editsPerSecond) * 1000);
    // (each change is a pass over its record as it is then, which is at most its size before the edit
    // plus the bytes of this edit's changes to it: charged so, an upper bound, before anything is
    // merged; a record's first pass is only its size before (daybreak2's LIMIT-C075-1).  An edit
    // costing more than the whole budget is never merged; within it, all or none, as ever)
    const msgBytes = enc.encode(JSON.stringify(m)).length, keyBytes = new Map<string, number>();
    for (const c of changes) { const k = keyOf(c.key); keyBytes.set(k, (keyBytes.get(k) ?? 0) + enc.encode(JSON.stringify(c)).length); }
    let cost = msgBytes;
    const passed = new Set<string>();
    for (const c of changes) {
      const k = keyOf(c.key);
      cost += sizes.get(k) ?? 0;
      if (passed.has(k)) cost += keyBytes.get(k)!; else passed.add(k);
    }
    if (cost > EDIT_LIMITS.workBurst) return no(`an edit is at most ${EDIT_LIMITS.workBurst / 2 ** 20} MiB of merging: its changes and the records each one passes over`, "too-large", { limit: EDIT_LIMITS.workBurst, size: cost });
    if (cost > B.work) return later("too much to merge at once", ((cost - B.work) / EDIT_LIMITS.workPerSecond) * 1000);
    B.edits -= 1;
    B.work -= cost;
    charged = cost;

    // the merge, staged over the records: nothing kept until every check passes
    const staged = new Map<string, Rec | null>(), dropped: Key[] = [];
    const cur = (k: string): Rec | null => (staged.has(k) ? staged.get(k)! : recs.get(k) ?? null);
    for (const c of changes) {
      const k = keyOf(c.key), now = cur(k), key = { type: c.key.type, page: c.key.page, id: c.key.id } as Key;
      if (c.op === "delete") {
        if (!now) continue;
        // (deleted here, its text changed elsewhere since the user saw it: kept)
        if (textChanged(now, c.was)) { dropped.push(key); continue; }
        staged.set(k, null);
        continue;
      }
      if (!now) {
        if (c.create) staged.set(k, record(key, c.fields));
        // (an edit to a record deleted elsewhere: made again whole if its text was edited, else no effect)
        else if (touchesText(c.fields) && c.record) staged.set(k, record(key, c.record));
        else dropped.push(key);
        continue;
      }
      const next = copyRec(now);
      for (const f of Object.keys(c.fields)) {
        const v = c.fields[f], was = c.create || !c.was ? undefined : c.was[f];
        const merged = mergeValue(was === null ? undefined : was, own(now, f) ? now[f] : undefined, v === null ? undefined : v, TEXT.has(f));
        if (merged === undefined) delete next[f]; else next[f] = merged;
      }
      staged.set(k, next);
    }

    // the indexes as they would be, by the difference the staged records make
    const d = { kids: new Map<string, number>(), edges: new Map<string, number>(), onPage: new Map<string, number>(), pages: 0 };
    const into = { kids: d.kids, edges: d.edges, onPage: d.onPage, pages: (n: number) => { d.pages += n; } };
    let size = bytes;
    for (const [k, r] of staged) {
      const old = recs.get(k);
      if (old) { index(old, -1, into); size -= sizes.get(k)!; }
      if (r) { index(r, 1, into); size += bytesOf(r); }
    }
    const count = (m: Map<string, number>, dm: Map<string, number>, k: string) => (m.get(k) ?? 0) + (dm.get(k) ?? 0);
    const pagesNow = pageRecs + d.pages;
    if (size > EDIT_LIMITS.boardBytes) return no(`a board edited here is at most ${EDIT_LIMITS.boardBytes / 2 ** 20} MiB`, "too-large", { limit: EDIT_LIMITS.boardBytes, size });
    let made = 0;
    for (const [k, r] of staged) made += (r ? 1 : 0) - (recs.has(k) ? 1 : 0);
    if (recs.size + made > EDIT_LIMITS.records) return no(`a board edited here has at most ${EDIT_LIMITS.records} records`, "too-large", { limit: EDIT_LIMITS.records, size: recs.size + made });
    const doc = cur(DOC);
    if (!doc) return no("the board's doc record isn't deleted");
    // (pictures sent apart: a picture this edit adds or changes carries no source of its own but an https:
    // address, and is named as the frame names pictures (the SHA-256 of its bytes); one the board had before
    // is its own business)
    if (byReference && staged.has(DOC)) {
      const was = (isPlain(recs.get(DOC)?.images) ? recs.get(DOC)!.images : {}) as { [k: string]: unknown }, nowImages = isPlain(doc.images) ? (doc.images as { [k: string]: unknown }) : {};
      for (const [name, v] of Object.entries(nowImages)) {
        if (own(was, name) && same(was[name], v)) continue;
        if (!/^i[0-9a-f]{16}(?:[0-9a-f]{16})?$/.test(name)) return no(`a picture's name is "i" and the hex of its bytes' SHA-256 (picture "${name.slice(0, 40)}")`);
        const src = isPlain(v) ? (v as { src?: unknown }).src : undefined;
        if (src !== undefined && !(typeof src === "string" && /^https:\/\//i.test(src))) return no(`pictures are sent by imagePut, not in the board: picture "${name}" carries its bytes`);
      }
    }
    const paged = doc.paged === true, wasPaged = recs.get(DOC)?.paged === true;
    const pageThere = (p: string) => !!cur(keyOf({ type: "page", page: p, id: "" }));
    // (pages: every page with records has its record; with no pages, none; checked for every page only when `paged` changes)
    if (paged && pagesNow < 1) return no("a board with pages keeps at least one");
    if (!paged && pagesNow > 0 && (paged !== wasPaged || [...staged.values()].some((r) => r?.type === "page"))) return no("a board without pages has no page records");
    if (paged !== wasPaged) {
      const pagesWithRecords = new Set([...onPage.keys(), ...d.onPage.keys()]);
      for (const p of pagesWithRecords) if (count(onPage, d.onPage, p) > 0 && (paged ? p === "" || !pageThere(p) : p !== "")) return no(paged ? "every item and edge is on a page that is there" : "a board without pages has its items on no page");
    }
    for (const [k, r] of staged) {
      if (r) {
        if (r.type === "item" || r.type === "edge") {
          if (paged ? r.page === "" || !pageThere(r.page) : r.page !== "") return no(`${r.type} "${r.id}" is on a page that isn't there`);
        }
        if (r.type === "item") {
          // (its parents: groups on its page, never round, at most 64 levels)
          const why = parentProblem(r, (page, id) => cur(itemKey(page, id)));
          if (why) return no(why);
          // (no longer a group: no children left)
          const old = recs.get(k);
          if (old?.kind === "group" && r.kind !== "group" && count(kids, d.kids, at(r.page, r.id)) > 0) return no(`item "${r.id}" has children: it stays a group`);
        }
        if (r.type === "edge") for (const end of [r.from, r.to]) if (typeof end !== "string" || !cur(itemKey(r.page, end))) return no(`edge "${r.id}" names an item that isn't on its page`);
      } else {
        // (made and deleted within this edit: never there, nothing to check)
        const old = recs.get(k);
        if (!old) continue;
        if (old.type === "doc") return no("the board's doc record isn't deleted");
        if (old.type === "item") {
          if (count(kids, d.kids, at(old.page, old.id)) > 0) return no(`group "${old.id}" still has children`);
          if (count(edges, d.edges, at(old.page, old.id)) > 0) return no(`item "${old.id}" still has edges`);
        }
        if (old.type === "page" && count(onPage, d.onPage, old.page) > 0) return no(`page "${old.page}" still has items or edges`);
      }
    }

    // the walk under the groups the edit moved or made: every item under them within
    // 64 levels, each visited once (one set for the whole edit, by whole key), a
    // cycle met refused; 64 bytes of work a visit, charged as it goes
    const stagedKids = new Map<string, Rec[]>();
    for (const r of staged.values()) if (r?.type === "item" && typeof r.parent === "string" && r.parent !== "") {
      const g = at(r.page, r.parent);
      (stagedKids.get(g) ?? stagedKids.set(g, []).get(g)!).push(r);
    }
    const childrenOf = (g: Rec): Rec[] => {
      const out: Rec[] = [], gk = at(g.page, g.id);
      for (const id of kidSets.get(gk) ?? []) {
        const k = itemKey(g.page, id);
        if (staged.has(k)) continue;
        const r = recs.get(k);
        if (r && r.parent === g.id) out.push(r);
      }
      for (const r of stagedKids.get(gk) ?? []) out.push(r);
      return out;
    };
    const depthOf = (r: Rec) => { let n = 0, x = r; while (x.parent !== "" && n <= EDIT_LIMITS.levels) { const p = cur(itemKey(x.page, x.parent as string)); if (!p) break; x = p; n++; } return n; };
    // (each visit marked with its walk: met again in the same walk, a cycle; in an
    // earlier one, a group under another the edit moved, already checked)
    const visited = new Map<string, number>();
    let walk = 0;
    if (commit) lastWalk = 0;
    for (const [k, r] of staged) {
      if (r?.type !== "item" || r.kind !== "group") continue;
      const old = recs.get(k);
      if (old && old.kind === "group" && old.parent === r.parent) continue;
      if (visited.has(k)) continue;
      walk++;
      const stack: [Rec, number][] = [[r, depthOf(r)]];
      while (stack.length) {
        const [g, d] = stack.pop()!, gk = itemKey(g.page, g.id), by = visited.get(gk);
        if (by === walk) return no(`item "${g.id}"'s parents go round`);
        if (by !== undefined) continue;
        visited.set(gk, walk);
        charged += 64;
        if ((B.work -= 64) < 0) { B.work = 0; keep(id); return { ok: false, id, message: "too much to check at once", reason: "busy", retryAfter: Math.ceil((64 / EDIT_LIMITS.workPerSecond) * 1000 * Math.max(1, visited.size)) }; }
        if (d > EDIT_LIMITS.levels) return no(`item "${g.id}" is more than ${EDIT_LIMITS.levels} levels deep`);
        if (g.kind === "group") for (const c of childrenOf(g)) stack.push([c, d + 1]);
      }
    }

    if (commit) lastWalk = visited.size;
    // kept: what changed in the board, record by record
    const out: Change[] = [];
    for (const [k, r] of staged) {
      const old = recs.get(k) ?? null;
      if (!r) { if (old) out.push({ op: "delete", key: { type: old.type, page: old.page, id: old.id } }); continue; }
      const fields: { [f: string]: unknown } = {};
      let changed = !old;
      for (const f of Object.keys(r)) if (!KEY_FIELDS.has(f) && (!old || JSON.stringify(old[f]) !== JSON.stringify(r[f]))) { fields[f] = r[f]; changed = true; }
      if (old) for (const f of Object.keys(old)) if (!KEY_FIELDS.has(f) && !own(r, f)) { fields[f] = null; changed = true; }
      if (changed) out.push({ op: "set", key: { type: r.type, page: r.page, id: r.id }, fields });
    }
    if (!commit) return { ok: true, id, changes: out, dropped, boardBytes: size };
    for (const [k, r] of staged) put(k, r);
    remember(id);
    return { ok: true, id, changes: out, dropped };
  }
  function apply(m: unknown, now: number = Date.now()): Applied { return run(m, now, true); }
  function preview(m: unknown, now: number = Date.now()): Previewed {
    const r = run(m, now, false) as Previewed;
    // (editBytes: the UTF-8 length of JSON.stringify of the whole message as received, every field of it: the
    // envelope's size, what a host's admission caps an edit by)
    let editBytes: number | undefined;
    try { editBytes = enc.encode(JSON.stringify(m)).length; } catch {}
    return { ...r, workBytes: charged, ...(editBytes === undefined ? {} : { editBytes }) };
  }

  function remote(changes: Change[]): { ok: true } | { ok: false; message: string } {
    const no = (message: string) => ({ ok: false as const, message });
    // (values bounded by the bytes: a board's worth, at most)
    const plain = plainProblem(changes, 32, EDIT_LIMITS.boardBytes, 2_000_000);
    if (plain) return no(plain.replace(/an edit/g, "a remote change"));
    if (!Array.isArray(changes)) return no("remote changes are a list");
    // (staged: nothing kept unless the board stays within the bounds)
    const staged = new Map<string, Rec | null>();
    const cur = (k: string): Rec | null => (staged.has(k) ? staged.get(k)! : recs.get(k) ?? null);
    for (const c of changes) {
      const kp = keyProblem(c?.key);
      if (kp) return no(kp);
      const k = keyOf(c.key);
      if (c.op === "delete") { staged.set(k, null); continue; }
      if (c.op !== "set" || !isPlain(c.fields)) return no("a remote change is {op, key, fields}");
      const now = cur(k), next = now ? copyRec(now) : record(c.key, {});
      for (const f of Object.keys(c.fields)) {
        if (KEY_FIELDS.has(f)) continue;
        if (!goodName(f)) return no(`a field's name is 1 to ${EDIT_LIMITS.fieldName} characters, and not ${[...BAD_NAMES].join(", ")}`);
        const v = c.fields[f];
        if (v === null || v === undefined) delete next[f]; else next[f] = v;
      }
      staged.set(k, next);
    }
    let size = bytes, count = recs.size;
    const sized = new Map<string, number>();
    for (const [k, r] of staged) {
      if (recs.has(k)) { size -= sizes.get(k)!; count--; }
      if (r) { const n = bytesOf(r); sized.set(k, n); size += n; count++; }
    }
    if (size > EDIT_LIMITS.boardBytes) return no(`the board is now more than ${EDIT_LIMITS.boardBytes / 2 ** 20} MiB: it can't be edited here`);
    if (count > EDIT_LIMITS.records) return no(`the board now has more than ${EDIT_LIMITS.records} records: it can't be edited here`);
    if (!cur(DOC)) return no("the board's doc record is gone");
    for (const [k, r] of staged) put(k, r);
    return { ok: true };
  }

  return {
    apply,
    preview,
    remote,
    reset: load,
    answered: (id: string) => remember(id),
    records: () => [...recs.values()],
    board: () => {
      const all = [...recs.values()];
      const match = (r: Rec, where: { [k: string]: unknown }) => Object.keys(where).every((f) => r[f] === where[f]);
      return fromRecords({ get: (w: object) => all.filter((r) => match(r, w as any)), getOne: (w: object) => all.find((r) => match(r, w as any)) } as any);
    },
    get bytes() { return bytes; },
    get lastWalk() { return lastWalk; },
  };
}
