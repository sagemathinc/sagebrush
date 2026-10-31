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
    if (x instanceof LazyLines) return false;
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

/** A notebook's .ipynb, as slices: `object` is the page's ipynbObject over the captured record, with toLines. */
export function notebookSlices(object: unknown, pace: Pace): AsyncIterable<Uint8Array> {
  return sliced(async (put) => {
    const out = new Out(put, pace);
    const v = resolve(object, "");
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

/**
 * A board's .board.json, as slices.  `fileText` is the page's boardFileText; it runs over a stand-in for the
 * Images it is given, whose inline() does what Images.inline does (the document cloned through JSON, each picture
 * this browser has and the document doesn't carry given a src) but with a short stand-in data: URL of the picture's
 * own type, unique to this call: a stand-in passes the board's check of a source exactly when the real data: URL
 * would (that check reads only the type, web/image-size.ts dataUrl).  Each stand-in is then written as the real
 * data: URL, as FileReader.readAsDataURL makes it ("data:" + type + ";base64," + base64), from the picture's bytes.
 */
export function boardSlices(doc: BoardDoc, images: Images, fileText: (d: BoardDoc, i: { inline(d: BoardDoc): Promise<BoardDoc> }) => Promise<string>, pace: Pace): AsyncIterable<Uint8Array> {
  return sliced(async (put) => {
    const out = new Out(put, pace);
    // (a stand-in, and what it stands for: a picture's bytes, or a long data: URL the document already carries)
    const stand = new Map<string, Blob | string>(), tag = nonce();
    let i = 0;
    const standIn = (type: string) => `data:${type};base64,SBX${tag}${i++}`;
    // (a source the document carries already, long: stood in before anything clones the document.  The stand-in has
    // its type, so it passes the board's check exactly when the source does: its rest checked here, in pieces)
    const carried = await shrinkSources(doc, standIn, stand, pace);
    const text = await fileText(carried, {
      inline: async (d) => {
        const o = JSON.parse(JSON.stringify(d)) as BoardDoc;
        if (!o.images) return o;
        for (const [name, v] of Object.entries(o.images)) {
          // (the picture's bytes, from this browser's store: Images.blob, as Images.inline reads them)
          const b = v.src ? undefined : await images.blob(name);
          if (v.src || !b) continue;
          const s = standIn(b.type || "application/octet-stream");
          stand.set(s, b);
          v.src = s;
        }
        return o;
      },
    });
    // (each stand-in where it is in the text, in order; one the board dropped isn't there)
    const at = [...stand.keys()].map((s) => ({ s, i: text.indexOf(s) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i);
    let from = 0;
    for (const { s, i } of at) {
      await out.text(text.slice(from, i));
      const b = stand.get(s)!;
      if (typeof b === "string") {
        // (a carried source, its characters as they are: base64 and whitespace, which JSON writes as \n, \t, \r…)
        for (let p = 0; p < b.length; p += PIECE) { out.add(JSON.stringify(b.slice(p, p + PIECE)).slice(1, -1)); await out.step(); }
      } else {
        out.add(`data:${b.type || "application/octet-stream"};base64,`);
        for (let p = 0; p < b.size; p += PICTURE_SLICE) {
          out.add(base64(new Uint8Array(await b.slice(p, Math.min(b.size, p + PICTURE_SLICE)).arrayBuffer())));
          await out.step();
        }
      }
      from = i + s.length;
    }
    await out.text(text.slice(from));
    await out.flush();
  });
}
