// The export's zip writer (export plan E1 r2c §3, §5, §5a, §6): one member at a time, streamed to a sink; each
// member's central-directory record and manifest entry appended to a spool, never kept as one object per member.
//   - a member: a local header (general-purpose bits 3 and 11: sizes after the data, UTF-8 names), its data (STOREd,
//     or DEFLATEd through the browser's CompressionStream("deflate-raw")), a data descriptor;
//   - a folder: a directory member, `name/`, size 0, STOREd;
//   - the end: the central directory replayed from the spool, then the Zip64 end record, its locator and the end of
//     central directory, always (so a small export and a large one have the same form).
// A member is at most 200 MiB (its kind's cap) and is in memory once read, so no member's own sizes need Zip64; an
// offset past 4 GiB does, and gets a Zip64 extra field in its central record.
//
// The slices (E1 r2a heap plan r2c §3, astra's H-A2): a slice is a 1 MiB buffer and its valid length; each spool and
// the archive keep two, recycled.  A flush hands the buffer over with its valid length; whoever takes it touches only
// [0, length) and gives the buffer back (the worker transfers it back in its reply; the picker's write is awaited; a
// Blob copies it), and the slice is free only then.  Meanwhile the other slice is written; before a slice is reused
// its return is awaited.  A Cancel never gets a buffer back: the page doesn't touch it again, makes no replacement,
// and the late reply is ignored.

/** 1 MiB: the slice every step works in (the sink's chunks, the CRC's, the spool's), so no task runs long. */
export const SLICE = 1 << 20;

export class ExportStopped extends Error {
  /** `plain`: `why` is a whole sentence, shown as it is (the no-OPFS refusal, @sagebrush's condition) */
  constructor(public why: string, public plain = false) { super(why); }
}

/** The page's slice and Blob accounting for one export (r2c R3, information and the CI assertions): slices made (each
 * SLICE bytes), bytes kept in Blob parts (the no-OPFS spools and the Blob sink: held, not recycled), bytes read back
 * from Blob parts, and the 1 MiB copies each member's slices take to the hash worker (unchanged by r2c, reported). */
export const counts = { slices: 0, sliceBytes: 0, blobBytes: 0, blobReadBytes: 0, hashCopyBytes: 0, afterStop: 0, postsAfterStop: 0, stopped: false };
export function resetCounts() { counts.slices = counts.sliceBytes = counts.blobBytes = counts.blobReadBytes = counts.hashCopyBytes = counts.afterStop = counts.postsAfterStop = 0; counts.stopped = false; }

type Slot = { buf: Uint8Array; used: number; back: Promise<void> | null };
function newSlot(): Slot {
  counts.slices++;
  counts.sliceBytes += SLICE;
  if (counts.stopped) counts.afterStop++;
  return { buf: new Uint8Array(SLICE), used: 0, back: null };
}
/** `s`'s buffer handed over by `give`, which resolves to the buffer to reuse; free (its valid length 0) only then.
 * The promise is marked handled here and awaited by whoever reuses the slot or settles. */
function handOver(s: Slot, give: Promise<Uint8Array>) {
  if (counts.stopped) counts.postsAfterStop++;
  const back = give.then((buf) => { s.buf = buf; s.used = 0; s.back = null; });
  back.catch(() => {});
  s.back = back;
}

/** `n` bytes of `src` from `from` copied into `dst` at `at`: a short run by an index loop (no view), a long one (a
 * member's data) by set. */
function copyIn(dst: Uint8Array, at: number, src: Uint8Array, from: number, n: number) {
  if (n <= 4096) { for (let i = 0; i < n; i++) dst[at + i] = src[from + i]; return; }
  dst.set(from === 0 && n === src.length ? src : src.subarray(from, from + n), at);
}

// ------------------------------------------------------------------ the worker
export class ExportWorker {
  private n = 0;
  private waiting = new Map<number, [(v: any) => void, (e: Error) => void]>();
  private stopped = false;
  /** (astra's E1 code R3) why the worker can't be used any more: it failed (its module didn't load, or it threw), and
   * every request then, and every one after, is refused at once, never left waiting */
  failed: string | null = null;
  constructor(private w: Worker) {
    w.onmessage = (ev) => {
      const m = ev.data, p = this.waiting.get(m.id);
      if (!p) return;
      this.waiting.delete(m.id);
      if (m.ok) p[0](m.value); else p[1](new Error(m.error));
    };
    w.onerror = (ev) => { ev.preventDefault?.(); this.fail(`the export's worker failed: ${ev.message || "it couldn't start"}`); };
    w.onmessageerror = () => this.fail("the export's worker sent a message the page couldn't read");
  }
  private fail(why: string) {
    if (this.failed) return;
    this.failed = why;
    try { this.w.terminate(); } catch {}
    for (const [, p] of this.waiting) p[1](new Error(why));
    this.waiting.clear();
  }
  ask<T = unknown>(op: string, args: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
    // (a stopped or failed worker answers nothing: refused at once, never left waiting (astra's E1-A3, E1 code R3))
    if (this.failed) return Promise.reject(new Error(this.failed));
    if (this.stopped) return Promise.reject(new Error("the export's worker was stopped"));
    const id = ++this.n;
    return new Promise<T>((ok, no) => {
      this.waiting.set(id, [ok, no]);
      // (a message the browser refuses to post: this request alone refused, nothing left waiting for it)
      try { this.w.postMessage({ id, op, ...args }, transfer); } catch (e) { this.waiting.delete(id); no(e as Error); }
    });
  }
  /** A Cancel ends every request waiting on the worker at once (astra's E1-A4): each rejects as cancelled, and its
   * late answer is ignored.  The worker takes requests one at a time, in order (worker.ts), so a cleanup asked after
   * the Cancel runs after whatever was still running there. */
  cancelOn(signal: AbortSignal) {
    signal.addEventListener("abort", () => { counts.stopped = true; for (const [, p] of this.waiting) p[1](new ExportStopped("cancelled")); this.waiting.clear(); }, { once: true });
  }
  terminate() { this.stopped = true; this.w.terminate(); for (const [, p] of this.waiting) p[1](new Error("the export's worker was stopped")); this.waiting.clear(); }
}

// ------------------------------------------------------------------ sinks
/** Where the bundle's bytes go, in order. */
export interface Sink {
  /** `buf[0, len)`, the next bytes; resolves to the buffer to reuse once the sink is done with it */
  write(buf: Uint8Array, len: number): Promise<Uint8Array>;
  /** the bundle is complete: commit it (the picker's file closed; OPFS or Blob handed to the browser's download).
   * Resolves once committed, to what is still to happen after (the scratch's delayed removal), if anything: wrapped,
   * as a promise resolved with a promise would wait for that one too. */
  close(name: string): Promise<{ later: Promise<void> } | void>;
  /** stopped: nothing committed, nothing left behind */
  abort(): Promise<void>;
}

export class PickerSink implements Sink {
  constructor(private out: any) {}
  // (a view of the valid prefix; the write awaited before the buffer is reused)
  async write(buf: Uint8Array, len: number) { await this.out.write(buf.subarray(0, len)); return buf; }
  async close() { await this.out.close(); }
  async abort() { try { await this.out.abort(); } catch {} }
}

/** A download of `blob` as `name`; the object URL is revoked a minute later (the download has its bytes by then);
 * then `then`.  (A test page may set the delay: __SB_EXPORT_TEST__.handDelay.) */
export function hand(blob: Blob, name: string, then?: () => void) {
  const delay = (globalThis as any).__SB_EXPORT_TEST__?.handDelay ?? 60_000;
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => { URL.revokeObjectURL(url); then?.(); }, delay);
}

export class BlobSink implements Sink {
  private parts: Blob[] = [];
  bytes = 0;
  constructor(private cap: number, private onHand: (blob: Blob, name: string) => void = hand) {}
  async write(buf: Uint8Array, len: number) {
    if (this.bytes + len > this.cap) throw new ExportStopped(`the export grew past ${this.cap} bytes, the most this browser can hold in memory`);
    // (the Blob copies the valid prefix: the buffer is free at once)
    this.parts.push(new Blob([buf.subarray(0, len) as BlobPart]));
    this.bytes += len;
    counts.blobBytes += len;
    return buf;
  }
  async close(name: string) { const b = new Blob(this.parts, { type: "application/zip" }); this.parts = []; this.onHand(b, name); }
  async abort() { this.parts = []; }
}

export class OpfsSink implements Sink {
  constructor(private wk: ExportWorker, private file: string, private fileOf: () => Promise<File>, private onHand: (blob: Blob, name: string, then: () => void) => void = hand) {}
  async open() { await this.wk.ask("open", { name: this.file, fail: (globalThis as any).__SB_EXPORT_TEST__?.failOpen === "sink" ? "truncate" : undefined }); }
  // (the buffer transferred with its valid length, and transferred back in the reply)
  async write(buf: Uint8Array, len: number) { return new Uint8Array(await this.wk.ask<ArrayBuffer>("append", { name: this.file, data: buf.buffer, len }, [buf.buffer])); }
  async close(name: string) {
    await this.wk.ask("close", { name: this.file });
    // (the disk-backed File, handed to the download; the scratch file is removed once the download has its bytes:
    // the promise returned settles then, and the caller keeps the worker (and the export's lock) until it does)
    const file = await this.fileOf();
    // (astra's E1 code R2: the handoff called here, not inside a promise's executor, so a failure before the download
    // starts rejects close(): nothing is committed and the abort removes the scratch file.  Only once it has started is
    // the delayed removal what is left to happen)
    let done!: () => void;
    const later = new Promise<void>((r) => (done = r));
    this.onHand(file, name, () => void this.wk.ask("remove", { name: this.file }).catch(() => {}).finally(done));
    return { later };
  }
  async abort() { await this.wk.ask("remove", { name: this.file }).catch(() => {}); }
}

// ------------------------------------------------------------------ the spool
/** The export's scratch data was found shorter than written (the rows spool's check, r2c): the export stops. */
export function cutShort(): never { throw new ExportStopped("the export's scratch data was cut short"); }

/**
 * Records written straight into one of two recycled 1 MiB slices (room(), then buf/at/done(): no promise unless a
 * flush is due), flushed to OPFS (a worker file) or to Blob parts; read back in order.  Never one object per record.
 * A byte stream (the central directory, the manifest, the capture log) is read in 1 MiB slices across records; the
 * rows spool (`segmented`) keeps each flushed segment's length, every segment ending on a record boundary (a record
 * that doesn't fit what is left of the slice flushes it first), and is read back segment by segment.
 */
export class Spool {
  /** the slice being written, and the other (in flight, free, or not yet made) */
  private a: Slot | null = null;
  private b: Slot | null = null;
  private parts: Blob[] = [];
  /** (segmented) each flushed segment's length */
  readonly segs: number[] = [];
  /** bytes appended */
  size = 0;
  /** bytes flushed */
  private out = 0;
  /** (tests) chunks flushed; flushes that had to wait for the other slice's return */
  chunks = 0;
  waits = 0;
  /** Bytes appended and not yet written out (at most SLICE). */
  get buffered() { return this.a?.used ?? 0; }
  /** `signal`: the export's Cancel, after which nothing more is handed to the worker */
  constructor(private name: string, readonly wk: ExportWorker | null, private cap: number, readonly segmented = false, private signal?: AbortSignal) {}
  async open() {
    const fail = (globalThis as any).__SB_EXPORT_TEST__?.failOpen;
    if (this.wk) await this.wk.ask("open", { name: this.name, fail: fail === (this.segmented ? "rows" : "spool") ? "truncate" : undefined });
    // (O-2: the rows spool's open failing after its file exists, as a late failure or a Cancel would leave it: its
    // owner must remove it)
    if (this.segmented && fail === "rows-late") throw new Error("the export's scratch file failed after it was made (a test)");
  }
  /** Room for `n` more bytes in the slice being written: undefined at once, else a promise (a flush, and the other
   * slice's return) to await before writing. */
  room(n: number): Promise<void> | undefined {
    const s = (this.a ??= newSlot());
    if (SLICE - s.used >= n) return undefined;
    if (n > SLICE) throw new ExportStopped("an entry's index record is larger than the export's 1 MiB slices");
    return this.flush();
  }
  /** The slice being written, and where its valid bytes end (after room()). */
  get buf() { return this.a!.buf; }
  get at() { return this.a!.used; }
  /** The slice written up to `end`. */
  done(end: number) {
    const s = this.a!;
    this.size += end - s.used;
    s.used = end;
    if (this.size > this.cap) throw new ExportStopped(`the export's index grew past ${this.cap} bytes`);
  }
  /** `src[0, n)` appended (n at most SLICE): undefined, or a promise when a flush was due. */
  put(src: Uint8Array, n: number): Promise<void> | undefined {
    const p = this.room(n);
    if (p) return p.then(() => this.copy(src, n));
    this.copy(src, n);
  }
  private copy(src: Uint8Array, n: number) { copyIn(this.a!.buf, this.a!.used, src, 0, n); this.done(this.a!.used + n); }
  /** The slice being written handed over with its valid length; writing goes on in the other once it is back. */
  private flush(): Promise<void> | undefined {
    const s = this.a;
    if (!s || !s.used) return;
    if (this.signal?.aborted) throw new ExportStopped("cancelled");
    this.chunks++;
    this.out += s.used;
    if (this.segmented) this.segs.push(s.used);
    if (!this.wk) {
      // (a Blob part copies the valid prefix: the slice is free at once)
      this.parts.push(new Blob([s.buf.subarray(0, s.used) as BlobPart]));
      counts.blobBytes += s.used;
      s.used = 0;
      return;
    }
    handOver(s, this.wk.ask<ArrayBuffer>("append", { name: this.name, data: s.buf.buffer, len: s.used }, [s.buf.buffer]).then((buf) => new Uint8Array(buf)));
    this.a = this.b ?? newSlot();
    this.b = s;
    if (this.a.back) this.waits++;
    return this.a.back ?? undefined;
  }
  /** What is in the slice written out, and every slice back: after it, read() sees everything appended. */
  async settle() {
    await this.flush();
    if (this.a?.back) await this.a.back;
    if (this.b?.back) await this.b.back;
  }
  /** Every byte appended, in order (settled first). */
  async *replay(): AsyncGenerator<Uint8Array> {
    await this.settle();
    yield* this.read();
  }
  /** What has been written out, in order, WITHOUT a flush first: the caller settles (the capture log's lookup does,
   * E1 r2a).  Each slice yielded is a view of a lent buffer, valid until the next is asked for: its consumer copies
   * what it keeps.  A byte stream: 1 MiB slices; the rows spool: its segments, each checked whole. */
  async *read(): AsyncGenerator<Uint8Array> {
    if (this.segmented) {
      let sum = 0;
      for (const n of this.segs) sum += n;
      if (sum !== this.out) cutShort();
    }
    if (!this.wk) {
      for (let i = 0; i < this.parts.length; i++) {
        const ab = await this.parts[i].arrayBuffer();
        counts.blobReadBytes += ab.byteLength;
        if (this.segmented && ab.byteLength !== this.segs[i]) cutShort();
        yield new Uint8Array(ab);
      }
      return;
    }
    if (!this.out) return;
    // (the other slice, lent to the worker's reads: the one being written keeps its bytes)
    const s = (this.b ??= newSlot());
    if (s.back) await s.back;
    for (let at = 0, i = 0; at < this.out; i++) {
      const len = this.segmented ? this.segs[i] : Math.min(SLICE, this.out - at);
      const r = await this.wk.ask<{ n: number; buf: ArrayBuffer }>("read", { name: this.name, at, len, data: s.buf.buffer }, [s.buf.buffer]);
      s.buf = new Uint8Array(r.buf);
      if (r.n !== len) { if (this.segmented) cutShort(); throw new Error(`a short read of ${this.name} (${r.n} of ${len} bytes)`); }
      yield s.buf.subarray(0, r.n);
      at += len;
    }
  }
  /** (tests only) the written-out data cut by its last byte, as a lost write would leave it */
  async cutForTest() {
    if (this.wk) await this.wk.ask("truncate", { name: this.name, by: 1 });
    else if (this.parts.length) { const p = this.parts.pop()!; this.parts.push(p.slice(0, p.size - 1)); }
  }
  async remove() { this.parts = []; if (this.a && !this.a.back) this.a.used = 0; if (this.wk) await this.wk.ask("remove", { name: this.name }).catch(() => {}); }
}

// ------------------------------------------------------------------ the writer
const enc = new TextEncoder();
const u16 = (v: DataView, at: number, x: number) => v.setUint16(at, x, true);
const u32 = (v: DataView, at: number, x: number) => v.setUint32(at, x >>> 0, true);
const u64 = (v: DataView, at: number, x: number) => { v.setUint32(at, x % 2 ** 32, true); v.setUint32(at + 4, Math.floor(x / 2 ** 32), true); };

/** DOS date and time (local), as zip headers carry them. */
export function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms), y = Math.min(2107, Math.max(1980, d.getFullYear()));
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

export type Written = { crc: number; csize: number; usize: number; offset: number; sha256?: string };
export type Hooks = { signal: AbortSignal; progress(bytes: number): void; crc: ExportWorker; /** (tests only) ms after each slice */ slicePause?: number };

const pause = () => new Promise<void>((r) => setTimeout(r, 0));
/** The longest name a member may have, in UTF-8 bytes. */
const NAME_MAX = 8192;

export class ZipWriter {
  offset = 0;
  members = 0;
  /** (tests) slices handed to the sink that had to wait for the other slice's return */
  waits = 0;
  /** the archive's slice being written, and the other */
  private a: Slot = newSlot();
  private b: Slot | null = null;
  constructor(private sink: Sink, private cd: Spool, private hooks: Hooks) {}

  private check() { if (this.hooks.signal.aborted) throw new ExportStopped("cancelled"); }
  /** `b[0, len)` appended to the archive: undefined, or a promise when a slice is due to go to the sink. */
  private emit(b: Uint8Array, len = b.length): Promise<void> | undefined {
    const s = this.a;
    if (len < SLICE - s.used) {
      copyIn(s.buf, s.used, b, 0, len);
      s.used += len;
      this.offset += len;
      return;
    }
    return this.emitSlow(b, len);
  }
  private async emitSlow(b: Uint8Array, len: number) {
    let at = 0;
    while (at < len) {
      const s = this.a, n = Math.min(len - at, SLICE - s.used);
      copyIn(s.buf, s.used, b, at, n);
      s.used += n;
      at += n;
      if (s.used === SLICE) { const p = this.drain(); if (p) await p; }
    }
    this.offset += len;
  }
  /** The slice handed to the sink with its valid length; writing goes on in the other once it is back. */
  private drain(): Promise<void> | undefined {
    const s = this.a;
    if (!s.used) return;
    this.check();
    handOver(s, this.sink.write(s.buf, s.used));
    this.a = this.b ?? newSlot();
    this.b = s;
    if (this.a.back) this.waits++;
    return this.a.back ?? undefined;
  }

  // (one buffer for the member's name and one for a header, reused: no arrays per member. A name is at most 1024
  // UTF-16 units of path (MAX_PATH), so at most 3,080 UTF-8 bytes with "files/" and a "/")
  private nameBuf = new Uint8Array(NAME_MAX);
  private hdr = new Uint8Array(46 + NAME_MAX + 12);
  private hv = new DataView(this.hdr.buffer);
  /** `name` into the name buffer, its length returned. */
  private nameOf(name: string): number {
    const r = enc.encodeInto(name, this.nameBuf);
    if (r.read < name.length) throw new ExportStopped(`a name is too long to export: ${name.slice(0, 80)}…`);
    return r.written;
  }
  /** A name's UTF-8 bytes (a record's) into the name buffer, by an index loop. */
  private nameFrom(src: Uint8Array, from: number, to: number): number {
    if (to - from > NAME_MAX) throw new ExportStopped(`a name is too long to export: ${new TextDecoder().decode(src.subarray(from, from + 80))}…`);
    for (let i = from; i < to; i++) this.nameBuf[i - from] = src[i];
    return to - from;
  }
  /** The local header, with the name buffer's first `n` bytes, in the header buffer; its length. */
  private local(n: number, flags: number, method: number, time: number, date: number): number {
    const b = this.hdr, v = this.hv, name = this.nameBuf;
    u32(v, 0, 0x04034b50); u16(v, 4, 20); u16(v, 6, flags); u16(v, 8, method); u16(v, 10, time); u16(v, 12, date);
    // (crc, sizes: 0 here, in the data descriptor after the data (bit 3); a folder's are 0 anyway)
    u32(v, 14, 0); u32(v, 18, 0); u32(v, 22, 0);
    u16(v, 26, n); u16(v, 28, 0);
    for (let i = 0; i < n; i++) b[30 + i] = name[i];
    return 30 + n;
  }
  /** The central record, with the name buffer's first `n` bytes, appended to the CD spool. */
  private central(n: number, flags: number, method: number, time: number, date: number, crc: number, csize: number, usize: number, offset: number, dir: boolean): Promise<void> | undefined {
    const big = offset >= 0xffffffff, extra = big ? 12 : 0;
    const b = this.hdr, v = this.hv, name = this.nameBuf;
    u32(v, 0, 0x02014b50); u16(v, 4, (3 << 8) | 45); u16(v, 6, big ? 45 : 20); u16(v, 8, flags); u16(v, 10, method);
    u16(v, 12, time); u16(v, 14, date); u32(v, 16, crc); u32(v, 20, csize); u32(v, 24, usize);
    u16(v, 28, n); u16(v, 30, extra); u16(v, 32, 0); u16(v, 34, 0); u16(v, 36, 0);
    u32(v, 38, dir ? ((0o40755 << 16) | 0x10) : (0o100644 << 16));
    u32(v, 42, big ? 0xffffffff : offset);
    for (let i = 0; i < n; i++) b[46 + i] = name[i];
    if (big) { u16(v, 46 + n, 0x0001); u16(v, 48 + n, 8); u64(v, 50 + n, offset); }
    return this.cd.put(b, 46 + n + extra);
  }

  /** A folder, from its record: its name's UTF-8 bytes `src[from, to)` (ending in "/") and its DOS time and date.
   * No string, view or promise unless a slice is due (r2c §1, §4). */
  folderAt(src: Uint8Array, from: number, to: number, time: number, date: number): Promise<void> | undefined {
    this.check();
    const n = this.nameFrom(src, from, to), offset = this.offset;
    this.members++;
    // (the header buffer holds the local header until emit has copied it, then the central record)
    const p = this.emit(this.hdr, this.local(n, 0x0800, 0, time, date));
    if (p) return p.then(() => this.central(n, 0x0800, 0, time, date, 0, 0, 0, offset, true));
    return this.central(n, 0x0800, 0, time, date, 0, 0, 0, offset, true);
  }

  /** A member from slices (at most `cap` bytes in all; past it, ExportStopped with `capWhy`).  `name`: a string, or
   * its UTF-8 bytes (a record's). */
  async member(name: string | Uint8Array, source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, deflate: boolean, mtime: number, cap: number, capWhy: string): Promise<Written> {
    this.check();
    const n = typeof name === "string" ? this.nameOf(name) : this.nameFrom(name, 0, name.length), t = dosTime(mtime), method = deflate ? 8 : 0, flags = 0x0808;
    const w: Written = { crc: 0, csize: 0, usize: 0, offset: this.offset };
    await this.emit(this.hdr, this.local(n, flags, method, t.time, t.date));
    await this.hooks.crc.ask("hashInit");
    let cs: CompressionStream | undefined, writer: WritableStreamDefaultWriter<Uint8Array> | undefined, pumping: Promise<void> | undefined;
    if (deflate) {
      cs = new CompressionStream("deflate-raw");
      writer = cs.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
      const reader = cs.readable.getReader();
      pumping = (async () => {
        for (;;) {
          const r = await reader.read();
          if (r.done) return;
          w.csize += r.value.length;
          await this.emit(r.value);
        }
      })();
      // (a failed or cancelled pump stops the writer too: never a write left waiting on a reader that's gone)
      const wr = writer;
      pumping.catch((e) => wr.abort(e).catch(() => {}));
    }
    try {
      for await (const s of source as AsyncIterable<Uint8Array>) {
        for (let at = 0; at < s.length; at += SLICE) {
          this.check();
          const slice = s.subarray(at, Math.min(s.length, at + SLICE));
          w.usize += slice.length;
          if (w.usize > cap) throw new ExportStopped(capWhy);
          // (the CRC and the SHA-256 in the worker: a 1 MiB copy of the slice is transferred there (posting the slice
          // itself would clone its whole buffer, the member); the slice goes on.  A slice may be a lent buffer (a
          // spool's replay): the compressor has taken its bytes when its write resolves, before the next is asked for)
          const copy = slice.slice();
          counts.hashCopyBytes += copy.length;
          await this.hooks.crc.ask("hashAdd", { data: copy }, [copy.buffer]);
          if (writer) await writer.write(slice);
          else { w.csize += slice.length; await this.emit(slice); }
          this.hooks.progress(slice.length);
          await (this.hooks.slicePause ? new Promise<void>((r) => setTimeout(r, this.hooks.slicePause)) : pause());
        }
      }
      if (writer) { await writer.close(); await pumping; }
    } catch (e) {
      if (writer) { try { await writer.abort(e); } catch {} try { await pumping; } catch {} }
      throw e;
    }
    const hashed = await this.hooks.crc.ask<{ crc: number; sha256: string }>("hashEnd");
    w.crc = hashed.crc;
    w.sha256 = hashed.sha256;
    const d = new Uint8Array(16), v = new DataView(d.buffer);
    u32(v, 0, 0x08074b50); u32(v, 4, w.crc); u32(v, 8, w.csize); u32(v, 12, w.usize);
    await this.emit(d);
    await this.central(n, flags, method, t.time, t.date, w.crc, w.csize, w.usize, w.offset, false);
    this.members++;
    return w;
  }

  /** The central directory (replayed from the spool), the Zip64 end record, its locator, the end record; then every
   * slice back from the sink. */
  async finish() {
    const cdStart = this.offset;
    for await (const s of this.cd.replay()) { this.check(); await this.emit(s); this.hooks.progress(s.length); await pause(); }
    const cdSize = this.offset - cdStart, z64 = this.offset, n = this.members;
    const e = new Uint8Array(56 + 20 + 22), v = new DataView(e.buffer);
    u32(v, 0, 0x06064b50); u64(v, 4, 44); u16(v, 12, (3 << 8) | 45); u16(v, 14, 45); u32(v, 16, 0); u32(v, 20, 0);
    u64(v, 24, n); u64(v, 32, n); u64(v, 40, cdSize); u64(v, 48, cdStart);
    u32(v, 56, 0x07064b50); u32(v, 60, 0); u64(v, 64, z64); u32(v, 72, 1);
    u32(v, 76, 0x06054b50); u16(v, 80, 0); u16(v, 82, 0); u16(v, 84, Math.min(n, 0xffff)); u16(v, 86, Math.min(n, 0xffff));
    u32(v, 88, Math.min(cdSize, 0xffffffff)); u32(v, 92, Math.min(cdStart, 0xffffffff)); u16(v, 96, 0);
    await this.emit(e);
    await this.drain();
    if (this.a.back) await this.a.back;
    if (this.b?.back) await this.b.back;
  }
}
