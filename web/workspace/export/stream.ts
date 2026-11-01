// A document's file, written as a stream of slices (export E1 r2d §6; daybreak2's E1-D2-1): no piece of work on the
// main thread grows with the document, and a Cancel takes effect between slices.  The bytes are Download's
// (file-bytes.ts), exactly:
// - a notebook: the page's own ipynbObject (what toIpynb writes), written as JSON.stringify(value, null, 1) writes it,
//   a small part by JSON.stringify itself, a large one value by value; a long string in pieces, a long text's lines
//   split as they are written;
// - a board: the page's own boardFileText, over the document with each picture's data: URL left as a short stand-in
//   of the same type, and each stand-in then written as the picture's real data: URL, read from its bytes in slices.
import type { Images } from "../../board/images";
import type { BoardDoc } from "../../board/doc";

const enc = new TextEncoder();
/** At most this many UTF-16 units go into one slice (so at most 768 KiB of UTF-8, under the pump's 1 MiB), and a
 * string longer than PIECE is escaped in pieces of it.  Tests make both small (sizes()). */
let CHUNK = 256 * 1024, PIECE = 64 * 1024;
/** Tests only: smaller slices and pieces, so that cuts land everywhere. */
export const sizes = (chunk: number, piece: number) => { CHUNK = chunk; PIECE = piece; };

const high = (c: number) => c >= 0xd800 && c <= 0xdbff;
const low = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** A cut at or before `j` that doesn't split a surrogate pair. */
const safeCut = (s: string, j: number) => (j < s.length && j > 0 && high(s.charCodeAt(j - 1)) && low(s.charCodeAt(j)) ? j - 1 : j);

export type Pace = { signal: AbortSignal; breathe(): Promise<void>; stopped(): never };

/** The text being written: pieces gathered, and handed on as one encoded slice once there are CHUNK units. */
class Out {
  private parts: string[] = [];
  private n = 0;
  constructor(private put: (b: Uint8Array) => Promise<void>, private pace: Pace) {}
  add(s: string) { this.parts.push(s); this.n += s.length; }
  /** Between two values: the slice handed on once it is full, a yield once 8 ms of work have passed, Cancel seen. */
  async step() {
    if (this.pace.signal.aborted) this.pace.stopped();
    if (this.n >= CHUNK) await this.flush();
    await this.pace.breathe();
  }
  async flush() {
    if (!this.n) return;
    const s = this.parts.join("");
    this.parts = []; this.n = 0;
    await this.put(enc.encode(s));
  }
  /** A long text as it is (its pieces cut between whole characters). */
  async text(s: string) {
    for (let i = 0; i < s.length;) {
      const j = safeCut(s, Math.min(s.length, i + CHUNK));
      this.add(s.slice(i, j)); i = j;
      await this.step();
    }
  }
  /** A string as JSON.stringify writes it: a long one escaped in pieces (escaping is per character; a cut never
   * splits a surrogate pair, which would be escaped as two lone halves). */
  async str(s: string) {
    if (s.length <= PIECE) { this.add(JSON.stringify(s)); return; }
    this.add('"');
    for (let i = 0; i < s.length;) {
      const j = safeCut(s, Math.min(s.length, i + PIECE));
      this.add(JSON.stringify(s.slice(i, j)).slice(1, -1)); i = j;
      await this.step();
    }
    this.add('"');
  }
}

/** Slices from a producer, handed on one at a time as the consumer takes them (the producer waits for room); the
 * consumer stopping early (a cap, Cancel) stops the producer at its next slice. */
export function sliced(produce: (put: (b: Uint8Array) => Promise<void>) => Promise<void>): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      // (the state both sides share: the slot, and who waits on whom)
      const st: { slot: Uint8Array | null; done: boolean; err: unknown; stop: boolean; wakeC: (() => void) | null; wakeP: (() => void) | null } = { slot: null, done: false, err: null, stop: false, wakeC: null, wakeP: null };
      const wake = (k: "wakeC" | "wakeP") => { const f = st[k]; st[k] = null; f?.(); };
      const put = async (b: Uint8Array) => {
        while (st.slot && !st.stop) await new Promise<void>((r) => (st.wakeP = r));
        if (st.stop) throw new Error("the stream's reader stopped");
        st.slot = b;
        wake("wakeC");
      };
      const run = produce(put).then(() => { st.done = true; }, (e) => { st.err = e; st.done = true; }).finally(() => wake("wakeC"));
      try {
        for (;;) {
          if (st.slot) { const b = st.slot; st.slot = null; wake("wakeP"); yield b; continue; }
          if (st.done) { if (st.err) throw st.err; return; }
          await new Promise<void>((r) => (st.wakeC = r));
        }
      } finally {
        st.stop = true;
        wake("wakeP");
        await run;
      }
    },
  };
}

// ---- a notebook

/** A text's lines, split as they are written (ipynbObject's toLines, for a long text). */
export class LazyLines {
  constructor(readonly t: unknown) {}
}
/** An array whose items are made as they are written (a notebook's cells, each through the page's ipynbObject). */
export class LazyArray {
  constructor(readonly length: number, readonly at: (i: number) => unknown) {}
}
const textLength = (t: unknown) => (Array.isArray(t) ? t.reduce((n: number, x: unknown) => n + (x == null ? 0 : String(x).length), 0) : typeof t === "string" ? t.length : 0);
/** What ipynb.js's lines(joinText(t)) gives, for a short text. */
const splitLines = (t: unknown) => (Array.isArray(t) ? t.join("") : ((t ?? "") as string)).split(/(?<=\n)/);
/** ipynbObject's toLines: a short text's lines at once, a long one's as it is written. */
export const toLines = (t: unknown) => (textLength(t) > PIECE ? new LazyLines(t) : splitLines(t));

/** lines(joinText(t)): each piece through a "\n", then the rest if any; "" for an empty text.  (String.split with a
 * zero-width match never cuts at the very end.) */
function* linesOf(t: unknown): Generator<string> {
  const parts: unknown[] = Array.isArray(t) ? t : [t ?? ""];
  let carry = "", any = false;
  for (const p of parts) {
    const s = carry + (p == null ? "" : String(p));
    let start = 0;
    for (;;) {
      const i = s.indexOf("\n", start);
      if (i < 0) break;
      yield s.slice(start, i + 1); any = true;
      start = i + 1;
    }
    carry = s.slice(start);
  }
  if (carry || !any) yield carry;
}

/** Whether a value (no LazyLines in it) writes to at most `budget` units: walked with an early stop. */
function small(v: unknown, budget: number): boolean {
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    if (x instanceof LazyLines || x instanceof LazyArray) return false;
    if (typeof x === "string") budget -= x.length + 8;
    else if (x && typeof x === "object") {
      if (typeof (x as any).toJSON === "function") { budget -= 64; continue; }
      if (Array.isArray(x)) { budget -= 4 + 8 * x.length; for (const y of x) stack.push(y); }
      else for (const k of Object.keys(x)) { budget -= k.length + 12; stack.push((x as any)[k]); }
    } else budget -= 24;
    if (budget < 0) return false;
  }
  return true;
}
const SMALL = 32 * 1024;

/** JSON.stringify's SerializeJSONProperty, toJSON included: the value written, or undefined for none. */
const resolve = (v: any, key: string) => (v !== null && (typeof v === "object" || typeof v === "bigint") && typeof v.toJSON === "function" ? v.toJSON(key) : v);
const skipped = (v: unknown) => v === undefined || typeof v === "function" || typeof v === "symbol";

/** One value as JSON.stringify(…, null, 1) writes it at indent `ind` (its key's indent); `v` already resolved. */
async function value(v: any, ind: string, out: Out): Promise<void> {
  if (v instanceof LazyLines) {
    // (an array of strings, never empty: [""] for an empty text)
    const i2 = ind + " ";
    let first = true;
    for (const line of linesOf(v.t)) {
      out.add((first ? "[\n" : ",\n") + i2);
      first = false;
      await out.str(line);
      await out.step();
    }
    out.add("\n" + ind + "]");
    return;
  }
  if (v instanceof LazyArray) {
    if (!v.length) { out.add("[]"); return; }
    const i2 = ind + " ";
    for (let i = 0; i < v.length; i++) {
      out.add((i ? ",\n" : "[\n") + i2);
      const x = resolve(v.at(i), String(i));
      if (skipped(x)) out.add("null");
      else await value(x, i2, out);
      await out.step();
    }
    out.add("\n" + ind + "]");
    return;
  }
  if (typeof v === "string") return out.str(v);
  if (v === null || typeof v !== "object") { out.add(JSON.stringify(v)); return; }
  // (a small value: JSON.stringify itself, its lines indented to here; newlines in its text come only from the
  // layout, as JSON escapes those in strings)
  if (small(v, SMALL)) { out.add(JSON.stringify(v, null, 1).replaceAll("\n", "\n" + ind)); return; }
  const i2 = ind + " ";
  if (Array.isArray(v)) {
    if (!v.length) { out.add("[]"); return; }
    for (let i = 0; i < v.length; i++) {
      out.add((i ? ",\n" : "[\n") + i2);
      const x = resolve(v[i], String(i));
      if (skipped(x)) out.add("null");
      else await value(x, i2, out);
      await out.step();
    }
    out.add("\n" + ind + "]");
    return;
  }
  let first = true;
  for (const k of Object.keys(v)) {
    const x = resolve(v[k], k);
    if (skipped(x)) continue;
    out.add((first ? "{\n" : ",\n") + i2 + JSON.stringify(k) + ": ");
    first = false;
    await value(x, i2, out);
    await out.step();
  }
  out.add(first ? "{}" : "\n" + ind + "}");
}

/** A notebook's .ipynb, as slices, byte for byte notebookFileText's: the page's own ipynbObject (what toIpynb writes)
 * over the captured record, its cells made one at a time as they are written (each through ipynbObject over a
 * document of that one cell: its cells are independent of each other), long texts' lines split as they go. */
export function notebookSlices(doc: any, ipynbObject: (doc: any, toLines: (t: unknown) => unknown) => any, pace: Pace): AsyncIterable<Uint8Array> {
  return sliced(async (put) => {
    const out = new Out(put, pace);
    const cells: unknown[] = Array.isArray(doc?.cells) ? doc.cells : [];
    const top = ipynbObject({ ...doc, cells: [] }, toLines);
    top.cells = new LazyArray(cells.length, (i) => ipynbObject({ ...doc, cells: [cells[i]] }, toLines).cells[0]);
    const v = resolve(top, "");
    if (skipped(v)) throw new Error("a notebook with no JSON value");
    await value(v, "", out);
    await out.flush();
  });
}

// ---- a board

/** The board's check of a source's rest (web/image-size.ts dataUrl): base64's characters and whitespace only. */
const SOURCE_HEAD = /^data:(image\/(?:png|jpe?g|webp|gif));base64,/i;
const SOURCE_REST = /^[A-Za-z0-9+/=\s]*$/;
/** The document with each long data: URL in `images` that the board would keep replaced by a stand-in of its type (a
 * shallow copy: nothing else is touched); the stand-ins recorded in `stand`. */
async function shrinkSources(doc: BoardDoc, standIn: (type: string) => string, stand: Map<string, Blob | string>, pace: Pace): Promise<BoardDoc> {
  const imgs = (doc as any)?.images;
  if (!imgs || typeof imgs !== "object" || Array.isArray(imgs)) return doc;
  let copy: Record<string, unknown> | null = null;
  for (const k of Object.keys(imgs)) {
    const v = imgs[k], src = v?.src;
    if (typeof src !== "string" || src.length <= PIECE) continue;
    const head = SOURCE_HEAD.exec(src.slice(0, 64));
    if (!head) continue;
    let ok = true;
    for (let p = head[0].length; p < src.length && ok; p += PIECE) { ok = SOURCE_REST.test(src.slice(p, p + PIECE)); await pace.breathe(); }
    if (!ok) continue;
    const s = standIn(src.slice(5, head[0].length - 8));
    stand.set(s, src);
    const c = (copy ??= { ...imgs });
    c[k] = { ...v, src: s };
  }
  return copy ? ({ ...(doc as any), images: copy } as BoardDoc) : doc;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(20)), (x) => B64[x % 62]).join("");
/** base64 of bytes (a multiple of 3 long, except the last slice) */
function base64(b: Uint8Array): string {
  const native = (b as any).toBase64;
  if (typeof native === "function") return native.call(b);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}
/** A picture's bytes are read this many at a time: 1 MiB of base64 a slice. */
const PICTURE_SLICE = 3 * 256 * 1024;

/** JSON.parse(JSON.stringify(v)), in steps (Images.inline's clone of a board): toJSON called, what JSON doesn't
 * write dropped from objects and null in arrays, -0 as 0, a non-finite number as null, boxed values unwrapped, an own
 * property for every key ("__proto__" included, as JSON.parse makes it); a yield once 8 ms of work have passed. */
async function jsonClone(v: unknown, pace: Pace): Promise<unknown> {
  const SKIP = Symbol("skip");
  let n = 0;
  const own = (o: any, k: string, x: unknown) => Object.defineProperty(o, k, { value: x, enumerable: true, writable: true, configurable: true });
  // (every value counted, a primitive too: an await on a value already there is only a microtask, never a yield to the
  // page, so the pause comes from breathe()'s timer, every 256 values once 8 ms have passed)
  const count = async () => { if (++n % 256 === 0) { if (pace.signal.aborted) pace.stopped(); await pace.breathe(); } };
  const prim = (x: any): unknown => {
    if (x === null || typeof x === "string" || typeof x === "boolean") return x;
    if (typeof x === "number") return Number.isFinite(x) ? (x === 0 ? 0 : x) : null;
    if (typeof x === "bigint") return JSON.stringify(x); // (throws, as JSON.stringify does)
    return SKIP;
  };
  const one = async (x: any, key: string): Promise<unknown> => {
    await count();
    if (x !== null && (typeof x === "object" || typeof x === "bigint") && typeof x.toJSON === "function") x = x.toJSON(key);
    if (x instanceof Number) x = Number(x); else if (x instanceof String) x = String(x); else if (x instanceof Boolean) x = x.valueOf();
    if (x === null || typeof x !== "object") return prim(x);
    if (Array.isArray(x)) {
      const out: unknown[] = new Array(x.length);
      for (let i = 0; i < x.length; i++) {
        const e = x[i];
        const y = e !== null && (typeof e === "object" || typeof e === "bigint") ? await one(e, String(i)) : (await count(), prim(e));
        out[i] = y === SKIP ? null : y;
      }
      return out;
    }
    const out: any = {};
    for (const k of Object.keys(x)) {
      const e = x[k];
      const y = e !== null && (typeof e === "object" || typeof e === "bigint") ? await one(e, k) : (await count(), prim(e));
      if (y !== SKIP) own(out, k, y);
    }
    return out;
  };
  const r = await one(v, "");
  return r === SKIP ? undefined : r;
}

/** The page's steps of work (cleanDocSteps), driven with a yield between them. */
async function drive<T>(g: Generator<void, T, void>, pace: Pace): Promise<T> {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    if (pace.signal.aborted) pace.stopped();
    await pace.breathe();
  }
}

/** The board's functions the export writes with (web/board/doc.ts): cleanDoc in steps, and boardText in parts. */
export type BoardKit = {
  cleanDocSteps(d: unknown): Generator<void, BoardDoc, void>;
  boardTextParts(d: unknown): Generator<string | { s: string }, void, void>;
};

/**
 * A board's .board.json, as slices, byte for byte what Download writes: boardFileText(doc, images) is
 * canonical(await images.inline(doc)) = boardText(cleanDoc(inline(doc))), where inline clones the document through
 * JSON and gives each picture this browser has, and the document doesn't carry, its data: URL.  Here each step is
 * paced: the clone (jsonClone), cleanDoc (cleanDocSteps, which cleanDoc runs) and boardText (boardTextParts).
 * A picture's src is a short stand-in of the picture's own type through all three (the board's check of a source
 * reads only its type, web/image-size.ts dataUrl), and each stand-in is written as the real data: URL, as
 * FileReader.readAsDataURL makes it ("data:" + type + ";base64," + base64), from the picture's bytes in slices; a long
 * data: URL the document already carries is stood in for, before the clone, and written as it is.
 */
export function boardSlices(doc: BoardDoc, images: Images, kit: BoardKit, pace: Pace): AsyncIterable<Uint8Array> {
  return sliced(async (put) => {
    const out = new Out(put, pace);
    const stand = new Map<string, Blob | string>(), tag = nonce();
    let i = 0;
    const standIn = (type: string) => `data:${type};base64,SBX${tag}${i++}`;
    const carried = await shrinkSources(doc, standIn, stand, pace);
    // (Images.inline: the clone, then each picture this browser has and the document doesn't carry)
    const o = (await jsonClone(carried, pace)) as BoardDoc;
    if (o?.images) {
      for (const [name, v] of Object.entries(o.images)) {
        const b = v.src ? undefined : await images.blob(name);
        if (!b) continue;
        const s = standIn(b.type || "application/octet-stream");
        stand.set(s, b);
        v.src = s;
      }
    }
    const cleaned = await drive(kit.cleanDocSteps(o), pace);
    let parts = 0;
    for (const p of kit.boardTextParts(cleaned)) {
      if (typeof p === "string") out.add(p);
      else {
        const b = stand.get(p.s);
        if (b === undefined) await out.str(p.s);
        else if (typeof b === "string") await out.str(b);
        else {
          out.add(`"data:${b.type || "application/octet-stream"};base64,`);
          for (let at = 0; at < b.size; at += PICTURE_SLICE) {
            out.add(base64(new Uint8Array(await b.slice(at, Math.min(b.size, at + PICTURE_SLICE)).arrayBuffer())));
            await out.step();
          }
          out.add('"');
        }
      }
      if (++parts % 256 === 0) await out.step();
    }
    await out.flush();
  });
}
