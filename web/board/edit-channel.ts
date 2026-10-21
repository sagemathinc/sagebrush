// The frame's side of editing (web/board-host-protocol.md, "Editing: a host
// that saves the board"): a host that grants `edit: true` saves the board,
// and the frame sends it what the user does, as changes with what they were
// changed from (`was`), and shows what the host says the board has become.
//
// The frame keeps two things: the host's state at the latest revision it
// received, and its own transactions not yet saved (the edit in flight, then
// those made since).  It shows the host's state with its own changes over it.
// What it holds unsaved is bounded in total (Bounds, daybreak2's
// LIMIT-9B5-1): counted as it changes, editing paused before the bound, and
// nothing dropped that the user made; what can't be saved is kept for the user
// to download until they discard it.
//
// No DOM here: the page gives the frame's channel a port and an EditUi.

import { cleanDoc, isBoard, type BoardDoc } from "./doc";
import { toRecords, fromRecords, SCHEMA } from "./history";
import { uuid } from "./channel";

/** The bounds (web/board-host-protocol.md, Bounds). */
export const EDIT_BOUNDS = {
  /** one message (`edit`), as UTF-8 */
  messageBytes: 2 ** 20,
  messageChanges: 1000,
  /** everything held unsaved: the edit in flight, the transactions not sent, the copies kept (LIMIT-9B5-1) */
  heldBytes: 8 * 2 ** 20,
  heldChanges: 8000,
  /** transactions made within this long go into one edit */
  batchMs: 250,
  /** an editable board, as JSON text */
  boardBytes: 8 * 2 ** 20,
  /** edit ids answered, remembered */
  ids: 100,
};
/** The UTF-8 bytes of an edit message apart from its changes, exactly: `{"sagebrush":"edit","version":1,"id":"<a UUID>",
 * "base":<the revision>,"changes":}` (daybreak2's LIMIT-BFE-1: exact, not an allowance; revisions are at most 200
 * characters, else refused) */
const envelopeBytes = (revision: string) => utf8Length(`{"sagebrush":"edit","version":1,"id":"","base":,"changes":}`) + 36 + jsonBytes(revision, Infinity);
/** A revision as the protocol bounds it. */
const REVISION_MAX = 200;

type Key = { type: string; page: string; id: string };
type Rec = Key & { [field: string]: unknown };
export type Change =
  | { op: "set"; key: Key; fields: Record<string, unknown>; was: Record<string, unknown>; create?: true; record?: Record<string, unknown> }
  | { op: "delete"; key: Key; was: Record<string, unknown> };
/** One editor action, with every record it touched; `bytes`: its UTF-8 JSON as an array, plus one for the
 * separator a download puts after it (daybreak2's check 2: the framing counted, not allowed for). */
interface Tx { changes: Change[]; bytes: number; ready: boolean }
/** What the frame keeps for the user to download: a refused edit's changes, or everything unsaved when editing
 * ended with keepUnsaved (then with the view as the user saw it). */
export interface Kept { id: number; why: string; revision: string; txs: Tx[]; view?: BoardDoc }

/** What the frame shows: the page's side of the channel. */
export interface EditUi {
  /** show this board (the host's state with the frame's unsaved changes over it), with a note for the caption;
   * a promise: resolved once the editor shows it (the channel's view of what the user sees moves only then) */
  show(doc: BoardDoc, note?: string): void | Promise<unknown>;
  /** Edit allowed or not: paused at the bound, or ended by the host (`why` said) */
  allowed(on: boolean, why: string): void;
  /** the copies kept for download changed */
  kept(copies: readonly Kept[]): void;
  /** say this in the caption */
  say(md: string): void;
}

const keyOf = (k: { type: unknown; page: unknown; id: unknown }) => JSON.stringify([k.type, k.page, k.id]);
const KEY_FIELDS = new Set(["type", "page", "id"]);
const TEXT = new Set(SCHEMA.stringCols);
/** UTF-8 bytes of a string, without encoding it. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
// (a transaction of changes already admitted: its JSON as an array, and the separator a download puts after it)
const txOf = (changes: Change[]): Tx => ({ changes, bytes: jsonBytes(changes, Infinity) + 1, ready: true });

/** How much a walk may do: every key and array entry it visits counts, those JSON leaves out too. */
export interface WalkStats { work: number; maxStack: number }
// (an object's own enumerable keys, one at a time: never all of them made at once, as Object.keys would)
function* ownKeys(o: object): Generator<string> {
  for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) yield k;
}
const omitted = (v: unknown) => v === undefined || typeof v === "function" || typeof v === "symbol";
type Frame = { a: unknown[]; i: number; d: number } | { o: Record<string, unknown>; it: Generator<string>; k: number; d: number };

/**
 * The UTF-8 bytes of `x` as JSON.stringify writes it (strings escaped as it escapes them, `undefined` and functions
 * left out of objects and written null in arrays), without writing it.  -1 once past `cap` bytes, `depth` levels,
 * or `budget` steps (each key and array entry visited, those left out too: default, `cap`): stopped there, the rest
 * never walked (daybreak2's LIMIT-BFE-1 and 1b).  Containers are walked a key or an entry at a time, so what it
 * holds besides `x` is one frame a level, never one a sibling; keys are never all listed at once, and a key or a
 * string longer than what is left is refused unread.
 */
export function jsonBytes(x: unknown, cap: number, depth = 64, budget = cap, stats?: WalkStats): number {
  let n = 0, work = 0;
  const stack: Frame[] = [];
  // (a value: a primitive counted, a container opened; false: past a bound)
  const value = (v: unknown, d: number): boolean => {
    if (v === null) n += 4;
    else if (typeof v === "string") { if (v.length > cap - n) return false; n += stringBytes(v); }
    else if (typeof v === "number") n += Number.isFinite(v) ? String(v).length : 4;
    else if (typeof v === "boolean") n += v ? 4 : 5;
    else if (typeof v !== "object") n += 4;
    else {
      if (d >= depth) return false;
      n += 2;
      stack.push(Array.isArray(v) ? { a: v, i: 0, d } : { o: v as Record<string, unknown>, it: ownKeys(v), k: 0, d });
      if (stats && stack.length > stats.maxStack) stats.maxStack = stack.length;
    }
    return n <= cap;
  };
  if (!value(x, 0)) return -1;
  while (stack.length) {
    const f = stack[stack.length - 1];
    if ("a" in f) {
      if (f.i >= f.a.length) { stack.pop(); continue; }
      if (++work > budget) return -1;
      const e = f.a[f.i];
      n += f.i++ ? 1 : 0;
      if (!value(omitted(e) ? null : e, f.d + 1)) return -1;
    } else {
      const r = f.it.next();
      if (r.done) { stack.pop(); continue; }
      if (++work > budget) return -1;
      const key = r.value, e = f.o[key];
      if (omitted(e)) continue;
      if (key.length > cap - n) return -1;
      n += (f.k++ ? 1 : 0) + stringBytes(key) + 1;
      if (!value(e, f.d + 1)) return -1;
    }
  }
  if (stats) stats.work = work;
  return n;
}
// (a string's bytes as JSON writes it: its quotes, its escapes, its UTF-8; a lone surrogate as \\uXXXX)
function stringBytes(s: string): number {
  let n = 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x0c || c === 0x0a || c === 0x0d || c === 0x09) n += 2;
    else if (c < 0x20) n += 6;
    else if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { if (i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; } else n += 6; }
    else if (c >= 0xdc00 && c <= 0xdfff) n += 6;
    else n += 3;
  }
  return n;
}
/**
 * Whether two JSON values are the same, whatever the order of their objects' keys.  Its contract is JSON values
 * (as records are, made by a JSON round trip: toRecords): it doesn't take NaN for null, nor undefined for null or
 * absent in an array (astra's note on fcb3842d).  Bounded as jsonBytes is: a frame a level, keys one at a time,
 * `depth` levels and `budget` steps; past either, not the same (fails closed: such a change is then counted, and
 * refused, by diffWithin's bound).
 */
export function sameJson(a: unknown, b: unknown, depth = 64, budget = 1 << 24, stats?: WalkStats): boolean {
  type SFrame = { x: unknown[]; y: unknown[]; i: number; d: number } | { xo: Record<string, unknown>; yo: Record<string, unknown>; it: Generator<string>; d: number; phase: 0 | 1; nx: number; ny: number };
  const stack: SFrame[] = [];
  let work = 0;
  const open = (x: unknown, y: unknown, d: number): boolean => {
    if (x === y) return true;
    if (x === null || y === null || typeof x !== "object" || typeof y !== "object") return false;
    if (Array.isArray(x) !== Array.isArray(y) || d >= depth) return false;
    if (Array.isArray(x)) { if (x.length !== (y as unknown[]).length) return false; stack.push({ x, y: y as unknown[], i: 0, d }); }
    else stack.push({ xo: x as Record<string, unknown>, yo: y as Record<string, unknown>, it: ownKeys(x), d, phase: 0, nx: 0, ny: 0 });
    if (stats && stack.length > stats.maxStack) stats.maxStack = stack.length;
    return true;
  };
  if (!open(a, b, 0)) return false;
  while (stack.length) {
    if (++work > budget) return false;
    const f = stack[stack.length - 1];
    if ("x" in f) {
      if (f.i >= f.x.length) { stack.pop(); continue; }
      const i = f.i++;
      if (!open(f.x[i], f.y[i], f.d + 1)) return false;
      continue;
    }
    const r = f.it.next();
    if (f.phase === 0) {
      // (each of x's keys: in y, and the same there)
      if (r.done) { f.phase = 1; f.it = ownKeys(f.yo); continue; }
      const xv = f.xo[r.value];
      if (xv === undefined) continue;
      f.nx++;
      const yv = Object.prototype.hasOwnProperty.call(f.yo, r.value) ? f.yo[r.value] : undefined;
      if (yv === undefined || !open(xv, yv, f.d + 1)) return false;
    } else {
      // (then y has no others)
      if (r.done) { stack.pop(); if (f.ny !== f.nx) return false; continue; }
      if (f.yo[r.value] !== undefined) f.ny++;
    }
  }
  if (stats) stats.work = work;
  return true;
}

/** What a transaction's pictures need before it can be sent (astra's CORR-FRAMEEDIT-1: the transaction is taken
 * at the editor's action, its `was` from the view then; this only prepares it): to a host that keeps them inline,
 * their bytes in it; by reference, their bytes put to the host first. */
export interface PicturePrep {
  /** inline: a picture the view has, unchanged, carries the bytes the host has */
  inline: boolean;
  /** of the pictures an action's change to the board's map gives, those that need preparing */
  needs(entries: Record<string, unknown>): string[];
  /** the bytes they add to the transaction once prepared, exactly as far as can be known now (for the bound) */
  extraBytes(names: string[]): number;
  /** prepare them (may fill the entries in `changes`); not ok: kept for download (`keep`), or that action taken out */
  prepare(changes: Change[], names: string[]): Promise<{ ok: true } | { ok: false; keep: boolean; why: string }>;
}
/** To a host that keeps pictures inline: each picture an action adds without its bytes, given them (data: URLs). */
export function inlinePictures(store: { sizeOf(name: string): { size: number; type: string } | undefined; dataUrl(name: string): Promise<string | undefined> }): PicturePrep {
  return {
    inline: true,
    needs: (entries) => Object.entries(entries ?? {}).filter(([, v]) => !!v && typeof v === "object" && !(v as any).src).map(([k]) => k),
    // (,"src":"data:<type>;base64,<base64>")
    extraBytes: (names) => names.reduce((t, n) => { const s = store.sizeOf(n); return t + (s ? 9 + utf8Length(`data:${s.type};base64,`) + 4 * Math.ceil(s.size / 3) : 0); }, 0),
    async prepare(changes, names) {
      const docChange = changes.find((c) => c.op === "set" && c.key.type === "doc" && c.fields.images) as Extract<Change, { op: "set" }> | undefined;
      for (const n of names) {
        const url = await store.dataUrl(n);
        if (!url) return { ok: false, keep: true, why: "a picture in it isn't in this browser any more" };
        const e = (docChange?.fields.images as Record<string, any> | undefined)?.[n];
        if (e && typeof e === "object") e.src = url;
      }
      return { ok: true };
    },
  };
}
// (inline: the pictures the editor names as the view has them carry the view's bytes: the editor keeps them apart)
function carryPictures(view: Map<string, Rec>, next: Map<string, Rec>) {
  const k = keyOf({ type: "doc", page: "", id: "" }), v = view.get(k)?.images as Record<string, any> | undefined, n = next.get(k)?.images as Record<string, any> | undefined;
  if (!v || !n) return;
  for (const [name, e] of Object.entries(n)) if (e && typeof e === "object" && !e.src && v[name]?.src) n[name] = { ...e, src: v[name].src };
}
const fieldsOf = (r: Rec) => { const o: Record<string, unknown> = {}; for (const k of Object.keys(r)) if (!KEY_FIELDS.has(k)) o[k] = r[k]; return o; };
const textOf = (r: Rec) => { const o: Record<string, unknown> = {}; for (const k of Object.keys(r)) if (TEXT.has(k)) o[k] = r[k]; return o; };

/** A board's records, keyed. */
function recordsOf(d: BoardDoc): Map<string, Rec> {
  const m = new Map<string, Rec>();
  for (const r of toRecords(d)) m.set(keyOf(r), r);
  return m;
}
function boardOf(m: Map<string, Rec>): BoardDoc {
  const rs = [...m.values()];
  const match = (w: any) => (r: any) => Object.entries(w).every(([k, v]) => r[k] === v);
  return fromRecords({ get: (w: object) => rs.filter(match(w)), getOne: (w: object) => rs.find(match(w)) } as any);
}

/** The changes that take `from` to `to`, each with what it was (`was`), as an editor action's transaction. */
export function diff(from: Map<string, Rec>, to: Map<string, Rec>): Change[] {
  return diffWithin(from, to, Infinity, Infinity)!.changes;
}
/** The same, counted as it is made: null as soon as it passes `maxBytes` (its JSON as an array, exactly) or
 * `maxChanges`, the rest never compared or counted (daybreak2's LIMIT-BFE-1). */
export function diffWithin(from: Map<string, Rec>, to: Map<string, Rec>, maxBytes: number, maxChanges: number): { changes: Change[]; bytes: number } | null {
  const out: Change[] = [];
  let bytes = 2;
  const add = (c: Change): boolean => {
    if (out.length >= maxChanges) return false;
    const b = jsonBytes(c, maxBytes - bytes - (out.length ? 1 : 0));
    if (b < 0) return false;
    bytes += b + (out.length ? 1 : 0);
    out.push(c);
    return true;
  };
  for (const [k, r] of to) {
    const o = from.get(k), key = { type: r.type, page: r.page, id: r.id } as Key;
    if (!o) { if (!add({ op: "set", key, fields: fieldsOf(r), was: {}, create: true })) return null; continue; }
    const fields: Record<string, unknown> = {}, was: Record<string, unknown> = {};
    let text = false;
    for (const f of new Set([...Object.keys(o), ...Object.keys(r)])) {
      if (KEY_FIELDS.has(f)) continue;
      // (the board's pictures: an edit adds or changes them, never removes one: the editor keeps pictures apart, by
      // their content's name, and may not take one in at all (its pixels), so one missing from its view needn't be
      // one the user deleted; its bytes stay with the host)
      const v = r.type === "doc" && f === "images" ? keptPictures(o[f], r[f]) : r[f];
      if (sameJson(o[f], v)) continue;
      fields[f] = v === undefined ? null : v;
      was[f] = o[f] === undefined ? null : o[f];
      if (TEXT.has(f)) text = true;
    }
    if (Object.keys(fields).length && !add({ op: "set", key, fields, was, ...(text ? { record: fieldsOf(r) } : {}) })) return null;
  }
  for (const [k, o] of from) if (!to.has(k) && !add({ op: "delete", key: { type: o.type, page: o.page, id: o.id } as Key, was: textOf(o) })) return null;
  return { changes: out, bytes };
}

// (the pictures map after an edit: what the view has, over what was there)
function keptPictures(before: unknown, after: unknown): unknown {
  const plainMap = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
  const a = plainMap(before), b = plainMap(after);
  if (!a) return after;
  return { ...a, ...(b ?? {}) };
}

/** `changes` applied to `m` (a host's: without `was`; or the frame's own, over the host's state).  For the
 * frame's own: a set of a record that isn't there is taken only if it makes it (`create`) or restores it
 * (`record`); else it returns false, for the caller to drop it. */
function applyTo(m: Map<string, Rec>, changes: readonly any[], own = false): boolean[] {
  return changes.map((c) => {
    const k = keyOf(c.key);
    if (c.op === "delete") { m.delete(k); return true; }
    const cur = m.get(k);
    if (!cur) {
      if (own && !c.create && !c.record) return false;
      const base: Rec = { ...(c.record ?? {}), type: c.key.type, page: c.key.page, id: c.key.id };
      m.set(k, setFields(base, c.fields));
      return true;
    }
    m.set(k, setFields({ ...cur }, c.fields));
    return true;
  });
}
function setFields(r: Rec, fields: Record<string, unknown>): Rec {
  for (const [f, v] of Object.entries(fields ?? {})) {
    if (KEY_FIELDS.has(f)) continue;
    if (v === null) delete r[f];
    else r[f] = v;
  }
  return r;
}

/** The frame's side of an editing channel. */
export class EditChannel {
  /** the latest revision received */
  revision: string;
  private host: Map<string, Rec>;
  /** the view as the editor has it (what it was last shown, with its own saves), normalized as it saves */
  private view: Map<string, Rec>;
  /** transactions not yet saved: the in-flight edit's first */
  private unsaved: Tx[] = [];
  private inFlight: { id: string; n: number } | null = null;
  private keptCopies: Kept[] = [];
  private nextKept = 1;
  /** everything held: unsaved and kept (LIMIT-9B5-1).  Changed only where state is made or released, never
   * when it moves from unsaved to kept (daybreak2's check 1, astra's clarification) */
  private held = { bytes: 0, changes: 0 };
  private paused = false;
  private ended = false;
  private waitingReplace = false;
  private answered: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryAt = 0;
  // (refreshes shown, and actions taken: an action taken while a refresh is still being shown was made on the board
  // shown before it: astra's CORR-PICREF-2)
  private showGen = 0;
  private saves = 0;
  /** what happened, the latest 200: for tests */
  readonly log: { what: string; id?: string; n?: number }[] = [];

  private pictures?: PicturePrep;
  constructor(text: string, revision: string, private post: (m: object) => void, private ui: EditUi, private now: () => number = () => Date.now(), opts: { pictures?: PicturePrep } = {}) {
    this.pictures = opts.pictures;
    const d = JSON.parse(text);
    if (!isBoard(d)) throw new Error("not a board");
    this.revision = revision;
    this.host = recordsOf(d);
    this.view = recordsOf(cleanDoc(d));
  }

  /** Everything held unsaved, for the bound and for tests. */
  totals(): { bytes: number; changes: number } { return { ...this.held }; }
  get isPaused(): boolean { return this.paused; }
  get isEnded(): boolean { return this.ended; }
  get inFlightId(): string | null { return this.inFlight?.id ?? null; }
  get pending(): number { return this.unsaved.length; }
  copies(): readonly Kept[] { return this.keptCopies; }
  private note(what: string, extra: { id?: string; n?: number } = {}) { this.log.push({ what, ...extra }); if (this.log.length > 200) this.log.shift(); }

  /** The editor kept `doc`: one action, so one transaction (none if nothing changed). */
  save(doc: BoardDoc) {
    const undo = (why: string, n = 0) => { this.note("undone", { n }); this.ui.show(boardOf(this.viewMap()), why); };
    if (this.ended) return undo("**Not saved:** editing here has ended.");
    // (the document the editor kept, its size bounded before anything of it is copied or compared: one past an
    // editable board and an edit can't be saved here, LIMIT-BFE-1)
    // (and its walk's steps: half that, as each key or entry JSON writes is at least two bytes: LIMIT-BFE-1b)
    const docCap = EDIT_BOUNDS.boardBytes + EDIT_BOUNDS.messageBytes;
    if (jsonBytes(doc, docCap, 64, docCap / 2) < 0) return undo("**That change is too large to save here**, so it was undone.");
    const next = recordsOf(cleanDoc(doc));
    if (this.pictures?.inline) carryPictures(this.view, next);
    // (the action's changes, counted as they are made, within one edit message: never compared or counted past it)
    const d = diffWithin(this.view, next, EDIT_BOUNDS.messageBytes - envelopeBytes(this.revision), EDIT_BOUNDS.messageChanges);
    if (!d) return undo("**That change is too large to save here**, so it was undone.");
    const changes = d.changes;
    if (!changes.length) { this.view = next; return; }
    const tx: Tx = { changes, bytes: d.bytes + 1, ready: true };
    // (its pictures, prepared after it is taken: counted now, as they will be sent)
    const docChange = changes.find((c) => c.op === "set" && c.key.type === "doc" && c.fields.images) as Extract<Change, { op: "set" }> | undefined;
    const names = docChange && this.pictures ? this.pictures.needs(docChange.fields.images as Record<string, unknown>) : [];
    if (names.length) { tx.bytes += this.pictures!.extraBytes(names); tx.ready = false; }
    // (with its pictures' bytes, still within one edit: else never sent; undone at once, said)
    if (tx.bytes - 1 > EDIT_BOUNDS.messageBytes - envelopeBytes(this.revision)) return undo("**That change is too large to save here**, so it was undone.", changes.length);
    // (both margins, before it is taken: daybreak2's check 4; paused, nothing new is taken, and what is held fits)
    if (this.paused || this.held.bytes + tx.bytes > EDIT_BOUNDS.heldBytes || this.held.changes + changes.length > EDIT_BOUNDS.heldChanges) return undo("**Not saved:** waiting for the host to save your earlier changes.");
    this.unsaved.push(tx);
    this.saves++;
    this.held.bytes += tx.bytes;
    this.held.changes += changes.length;
    this.view = next;
    this.note("tx", { n: changes.length });
    this.checkBound();
    if (!tx.ready) this.prepare(tx, names);
    this.schedule(EDIT_BOUNDS.batchMs);
  }

  /** A taken transaction's pictures prepared.  Ready: sent in its turn (the ones before it never wait for it, nor do
   * the ones after it overtake it).  Not: kept for download with those after it, or that action taken out. */
  private prepare(tx: Tx, names: string[]) {
    void this.pictures!.prepare(tx.changes, names).then((r) => r, (e: any) => ({ ok: false as const, keep: true, why: String(e?.message ?? e) })).then((r) => {
      const at = this.unsaved.indexOf(tx), kept = at < 0 && this.keptCopies.some((c) => c.txs.includes(tx));
      // (released meanwhile: editing ended without keepUnsaved)
      if (at < 0 && !kept) return;
      if (r.ok) {
        // (counted again as it is now: the bytes added as predicted, or not quite)
        const bytes = jsonBytes(tx.changes, Infinity) + 1;
        this.held.bytes += bytes - tx.bytes;
        tx.bytes = bytes;
        tx.ready = true;
        this.note("prepared", { n: names.length });
        this.checkBound();
        this.schedule(0);
        return;
      }
      // (frozen already, kept for download: kept as it is)
      if (kept) { tx.ready = true; return; }
      if (r.keep) {
        // (can't be sent: it, and those made on it, kept for download: moved, not released)
        this.keep(r.why, this.unsaved.splice(at));
        this.note("prepare kept", { n: names.length });
        this.refresh(`**Your last changes couldn't be saved:** ${r.why}. They're kept for you to download.`);
      } else {
        // (that action taken out, said: a picture the host refused)
        this.unsaved.splice(at, 1);
        this.release([tx]);
        this.note("prepare dropped", { n: names.length });
        this.refresh(`**A picture couldn't be saved:** ${r.why}`);
      }
      this.checkBound();
    });
  }

  /** A message from the host on the port: true if it was editing's. */
  receive(m: any): boolean {
    if (!m || typeof m !== "object" || m.version !== 1) return false;
    switch (m.sagebrush) {
      case "saved": return this.onSaved(m), true;
      case "remote": return this.onRemote(m), true;
      case "replace": return this.onReplace(m), true;
      case "editing": return this.onEditing(m), true;
      case "refused": return this.inFlight !== null && m.id === this.inFlight.id ? (this.onRefused(m), true) : false;
    }
    return false;
  }

  /** The kept copy `id` as a file, built from parts (no second whole-state string), and its name. */
  download(id: number): { blob: Blob; name: string } | null {
    const k = this.keptCopies.find((c) => c.id === id);
    if (!k) return null;
    const parts: string[] = [`{"format":"sagebrush-board-unsaved","version":1,"revision":${JSON.stringify(k.revision)},"why":${JSON.stringify(k.why)}`];
    if (k.view) parts.push(`,"view":`, JSON.stringify(k.view));
    parts.push(`,"transactions":[`);
    k.txs.forEach((t, i) => parts.push((i ? "," : "") + JSON.stringify(t.changes)));
    parts.push("]}\n");
    return { blob: new Blob(parts, { type: "application/json" }), name: "unsaved-changes.json" };
  }
  /** Forget the kept copy `id` (the user discarded it): what it held is released. */
  discard(id: number) {
    const i = this.keptCopies.findIndex((c) => c.id === id);
    if (i < 0) return;
    const [k] = this.keptCopies.splice(i, 1);
    this.release(k.txs);
    this.note("discard", { n: k.txs.length });
    this.ui.kept(this.keptCopies);
    this.checkBound();
  }

  // (state released: the only place the totals go down)
  private release(txs: readonly Tx[]) {
    for (const t of txs) { this.held.bytes -= t.bytes; this.held.changes -= t.changes.length; }
  }
  private checkBound() {
    const near = this.held.bytes > EDIT_BOUNDS.heldBytes - EDIT_BOUNDS.messageBytes || this.held.changes > EDIT_BOUNDS.heldChanges - EDIT_BOUNDS.messageChanges;
    const below = this.held.bytes < EDIT_BOUNDS.heldBytes / 2 && this.held.changes < EDIT_BOUNDS.heldChanges / 2;
    if (!this.paused && near) {
      this.paused = true;
      this.note("pause");
      if (!this.ended) this.ui.allowed(false, this.keptCopies.length && !this.unsaved.length ? "Edit is paused: you have unsaved changes kept for download. Download them, then discard them, to go on editing." : "Waiting for the host to save your changes. Edit comes back once it has.");
    } else if (this.paused && below) {
      this.paused = false;
      this.note("resume");
      if (!this.ended) this.ui.allowed(true, "");
    }
  }
  private schedule(ms: number) {
    if (this.timer || this.inFlight || this.ended || !this.unsaved.length) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, Math.max(ms, this.retryAt - this.now()));
  }
  /** Send the next edit, if none is in flight: whole transactions, within one message's bounds. */
  flush() {
    if (this.inFlight || this.ended || !this.unsaved.length) return;
    if (this.now() < this.retryAt) return this.schedule(0);
    // (the message's bytes exactly: its envelope, and its changes array, each transaction's changes without their own
    // brackets and separator, a comma between)
    let bytes = envelopeBytes(this.revision) + 2, n = 0, count = 0;
    while (n < this.unsaved.length) {
      const t = this.unsaved[n];
      // (one still being prepared: it and those after it wait)
      if (!t.ready) break;
      const inner = t.bytes - 3 + (n ? 1 : 0);
      if (n && (bytes + inner > EDIT_BOUNDS.messageBytes || count + t.changes.length > EDIT_BOUNDS.messageChanges)) break;
      bytes += inner;
      count += t.changes.length;
      n++;
    }
    if (!n) return;
    const id = uuid(), changes = this.unsaved.slice(0, n).flatMap((t) => t.changes);
    this.inFlight = { id, n };
    this.note("edit", { id, n: changes.length });
    this.post({ sagebrush: "edit", version: 1, id, base: this.revision, changes });
  }

  private settle(id: string) {
    this.answered.push(id);
    if (this.answered.length > EDIT_BOUNDS.ids) this.answered.shift();
  }
  /** The view: the host's state with the frame's unsaved changes over it. */
  private viewMap(): Map<string, Rec> {
    const m = new Map(this.host);
    for (const t of this.unsaved) applyTo(m, t.changes, true);
    return m;
  }
  /** Show the view, if it isn't what the editor has. */
  private refresh(note?: string) {
    const m = this.viewMap(), d = boardOf(m), shown = recordsOf(cleanDoc(d));
    const same = shown.size === this.view.size && [...shown].every(([k, r]) => { const o = this.view.get(k); return !!o && sameJson(o, r); });
    if (same && !note) return;
    // (the view, what the user's actions are taken against, becomes this board only once the editor shows it: an
    // action meanwhile was made on the board shown before, and is taken against that; this board is then shown
    // again, with it: astra's CORR-PICREF-2)
    const g = ++this.showGen, savesAt = this.saves;
    const r = this.ui.show(d, note);
    if (!r || typeof (r as Promise<unknown>).then !== "function") { this.view = shown; return; }
    void (r as Promise<unknown>).then(() => {
      if (g !== this.showGen) return;
      this.view = shown;
      if (this.saves !== savesAt) this.refresh();
    }, () => {});
  }
  /** The pictures the host's board names (its own state, never the frame's unsaved changes over it): those the host
   * has (astra's CORR-PICREF-1). */
  hostPictures(): string[] {
    const im = this.host.get(keyOf({ type: "doc", page: "", id: "" }))?.images;
    return im && typeof im === "object" && !Array.isArray(im) ? Object.keys(im) : [];
  }
  // (the host's changes, from `base`: applied if base is the latest revision; else resync, and changes ignored
  // until a replace)
  private takeChanges(m: any): boolean {
    if (this.waitingReplace) return false;
    if (m.base !== this.revision || !Array.isArray(m.changes) || typeof m.revision !== "string" || m.revision.length > REVISION_MAX) {
      this.waitingReplace = true;
      this.note("resync");
      this.post({ sagebrush: "resync", version: 1 });
      return false;
    }
    try { applyTo(this.host, m.changes); } catch {
      this.waitingReplace = true;
      this.post({ sagebrush: "resync", version: 1 });
      return false;
    }
    this.revision = m.revision;
    return true;
  }

  private onSaved(m: any) {
    if (!this.inFlight || m.id !== this.inFlight.id) return this.note("ignored", { id: m.id });
    const txs = this.unsaved.splice(0, this.inFlight.n);
    this.release(txs);
    this.settle(m.id);
    this.inFlight = null;
    this.note("saved", { id: m.id });
    this.takeChanges(m);
    const dropped = Array.isArray(m.dropped) ? m.dropped.length : 0;
    this.refresh(dropped ? `**${dropped} of your changes had no effect:** what they changed was deleted elsewhere, or kept back because it was changed there.` : undefined);
    this.checkBound();
    this.schedule(0);
  }
  private onRemote(m: any) {
    if (this.takeChanges(m)) this.refresh();
  }
  private onRefused(m: any) {
    const id = this.inFlight!.id, n = this.inFlight!.n;
    this.settle(id);
    this.inFlight = null;
    const message = typeof m.message === "string" ? m.message.slice(0, 500) : "refused";
    if (typeof m.retryAfter === "number" && m.retryAfter >= 0) {
      // (kept, each with its `was`, and sent again with what came since as a new edit, no sooner)
      this.retryAt = this.now() + Math.min(m.retryAfter, 3_600_000);
      this.note("retry", { id, n });
      this.schedule(0);
      return;
    }
    // (failed a check: those changes and the ones made on top of them, kept for download, moved there whole:
    // the totals don't change, as nothing is released, astra's clarification)
    this.keep(message, this.unsaved.splice(0, this.unsaved.length));
    this.note("refused", { id, n });
    this.refresh(`**Your last changes couldn't be saved:** ${message}. They're kept for you to download.`);
    this.checkBound();
  }
  private keep(why: string, txs: Tx[], view?: BoardDoc) {
    if (!txs.length && !view) return;
    this.keptCopies.push({ id: this.nextKept++, why, revision: this.revision, txs, ...(view ? { view } : {}) });
    this.ui.kept(this.keptCopies);
  }
  private onReplace(m: any) {
    if (typeof m.text !== "string" || typeof m.revision !== "string" || m.revision.length > REVISION_MAX) return;
    let d: any;
    try { d = JSON.parse(m.text); } catch { return; }
    if (!isBoard(d)) return;
    this.host = recordsOf(d);
    this.revision = m.revision;
    this.waitingReplace = false;
    this.note("replace");
    // (the edits it answers)
    for (const a of Array.isArray(m.answered) ? m.answered : []) {
      if (!a || !this.inFlight || a.id !== this.inFlight.id) continue;
      if (a.outcome === "saved") {
        this.release(this.unsaved.splice(0, this.inFlight.n));
        this.settle(a.id);
        this.inFlight = null;
        this.note("saved", { id: a.id });
      } else if (a.outcome === "refused") {
        this.settle(a.id);
        this.inFlight = null;
        this.keep(typeof a.message === "string" ? a.message.slice(0, 500) : "refused", this.unsaved.splice(0, this.unsaved.length));
        this.note("refused", { id: a.id });
      }
    }
    // (unsaved changes to a record not there now: kept if they make it or restore it, else dropped, said)
    let lost = 0;
    const m2 = new Map(this.host);
    for (const t of this.unsaved) {
      const ok = applyTo(m2, t.changes, true);
      if (ok.every(Boolean)) continue;
      const kept = t.changes.filter((_, i) => ok[i]);
      lost += t.changes.length - kept.length;
      const nt = txOf(kept);
      // (one still being prepared: its pictures' bytes still to come, still counted)
      if (!t.ready) nt.bytes += t.bytes - (jsonBytes(t.changes, Infinity) + 1);
      this.held.bytes += nt.bytes - t.bytes;
      this.held.changes += kept.length - t.changes.length;
      t.changes = kept;
      t.bytes = nt.bytes;
    }
    // (a transaction left empty: gone; never the in-flight edit's, whose answer still counts them)
    for (let i = this.unsaved.length - 1; i >= (this.inFlight?.n ?? 0); i--) if (!this.unsaved[i].changes.length) { this.release([this.unsaved[i]]); this.unsaved.splice(i, 1); }
    this.refresh(lost ? `**${lost} of your changes had no effect:** what they changed isn't on the board any more.` : undefined);
    this.checkBound();
    this.schedule(0);
  }
  private onEditing(m: any) {
    if (m.allowed !== false || this.ended) return;
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const message = typeof m.message === "string" ? m.message.slice(0, 500) : "Editing has ended.";
    const txs = this.unsaved.splice(0, this.unsaved.length);
    this.inFlight = null;
    if (m.keepUnsaved === true) {
      // (kept, frozen: the view as the user saw it and every transaction not saved; nothing more is added)
      this.keep(message, txs, boardOf(this.viewMap2(txs)));
      this.note("keepUnsaved", { n: txs.length });
    } else {
      this.release(txs);
      this.note("dropped", { n: txs.length });
    }
    this.ui.allowed(false, message);
    this.refresh();
  }
  // (the view with these transactions over the host's state)
  private viewMap2(txs: readonly Tx[]): Map<string, Rec> {
    const m = new Map(this.host);
    for (const t of txs) applyTo(m, t.changes, true);
    return m;
  }
}
