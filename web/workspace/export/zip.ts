// The export's zip writer (export plan E1 r2c §3, §5, §5a, §6): one member at a time, streamed to a sink; each
// member's central-directory record and manifest entry appended to a spool, never kept as one object per member.
//   - a member: a local header (general-purpose bits 3 and 11: sizes after the data, UTF-8 names), its data (STOREd,
//     or DEFLATEd through the browser's CompressionStream("deflate-raw")), a data descriptor;
//   - a folder: a directory member, `name/`, size 0, STOREd;
//   - the end: the central directory replayed from the spool, then the Zip64 end record, its locator and the end of
//     central directory, always (so a small export and a large one have the same form).
// A member is at most 200 MiB (its kind's cap) and is in memory once read, so no member's own sizes need Zip64; an
// offset past 4 GiB does, and gets a Zip64 extra field in its central record.

/** 1 MiB: the slice every step works in (the sink's chunks, the CRC's, the spool's), so no task runs long. */
export const SLICE = 1 << 20;

export class ExportStopped extends Error {
  constructor(public why: string) { super(why); }
}

// ------------------------------------------------------------------ the worker
export class ExportWorker {
  private n = 0;
  private waiting = new Map<number, [(v: any) => void, (e: Error) => void]>();
  constructor(private w: Worker) {
    w.onmessage = (ev) => {
      const m = ev.data, p = this.waiting.get(m.id);
      if (!p) return;
      this.waiting.delete(m.id);
      if (m.ok) p[0](m.value); else p[1](new Error(m.error));
    };
    w.onerror = (ev) => { for (const [, p] of this.waiting) p[1](new Error(`the export's worker failed: ${ev.message}`)); this.waiting.clear(); };
  }
  ask<T = unknown>(op: string, args: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.n;
    return new Promise<T>((ok, no) => { this.waiting.set(id, [ok, no]); this.w.postMessage({ id, op, ...args }, transfer); });
  }
  terminate() { this.w.terminate(); for (const [, p] of this.waiting) p[1](new Error("the export's worker was stopped")); this.waiting.clear(); }
}

// ------------------------------------------------------------------ sinks
/** Where the bundle's bytes go, in order. */
export interface Sink {
  write(chunk: Uint8Array): Promise<void>;
  /** the bundle is complete: commit it (the picker's file closed; OPFS or Blob handed to the browser's download) */
  close(name: string): Promise<void>;
  /** stopped: nothing committed, nothing left behind */
  abort(): Promise<void>;
}

export class PickerSink implements Sink {
  constructor(private out: any) {}
  write(chunk: Uint8Array) { return this.out.write(chunk); }
  async close() { await this.out.close(); }
  async abort() { try { await this.out.abort(); } catch {} }
}

/** A download of `blob` as `name`; the object URL is revoked a minute later (the download has its bytes by then). */
export function hand(blob: Blob, name: string, then?: () => void) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => { URL.revokeObjectURL(url); then?.(); }, 60_000);
}

export class BlobSink implements Sink {
  private parts: Blob[] = [];
  bytes = 0;
  constructor(private cap: number, private onHand: (blob: Blob, name: string) => void = hand) {}
  async write(chunk: Uint8Array) {
    if (this.bytes + chunk.length > this.cap) throw new ExportStopped(`the export grew past ${this.cap} bytes, the most this browser can hold in memory`);
    this.parts.push(new Blob([chunk as BlobPart]));
    this.bytes += chunk.length;
  }
  async close(name: string) { const b = new Blob(this.parts, { type: "application/zip" }); this.parts = []; this.onHand(b, name); }
  async abort() { this.parts = []; }
}

export class OpfsSink implements Sink {
  constructor(private wk: ExportWorker, private file: string, private fileOf: () => Promise<File>, private onHand: (blob: Blob, name: string, then: () => void) => void = hand) {}
  async open() { await this.wk.ask("open", { name: this.file }); }
  // (each chunk is the writer's own copy: transferred, not cloned)
  async write(chunk: Uint8Array) { await this.wk.ask("append", { name: this.file, data: chunk }, [chunk.buffer]); }
  async close(name: string) {
    await this.wk.ask("close", { name: this.file });
    // (the disk-backed File, handed to the download; the scratch file is removed once the download has its bytes)
    this.onHand(await this.fileOf(), name, () => void this.wk.ask("remove", { name: this.file }).catch(() => {}));
  }
  async abort() { await this.wk.ask("remove", { name: this.file }).catch(() => {}); }
}

// ------------------------------------------------------------------ the spool
/** Records appended into one reused 1 MiB buffer, flushed as whole chunks to OPFS (a worker file) or to Blob parts;
 * replayed in order in 1 MiB slices.  Never one object per record. */
export class Spool {
  private buf = new Uint8Array(SLICE);
  private used = 0;
  private parts: Blob[] = [];
  size = 0;
  /** (tests) chunks flushed */
  chunks = 0;
  constructor(private name: string, private wk: ExportWorker | null, private cap: number) {}
  async open() { if (this.wk) await this.wk.ask("open", { name: this.name }); }
  async append(b: Uint8Array) {
    if (this.size + b.length > this.cap) throw new ExportStopped(`the export's index grew past ${this.cap} bytes`);
    let at = 0;
    while (at < b.length) {
      const n = Math.min(b.length - at, SLICE - this.used);
      this.buf.set(b.subarray(at, at + n), this.used);
      this.used += n;
      at += n;
      if (this.used === SLICE) await this.flush();
    }
    this.size += b.length;
  }
  /** Text appended as UTF-8, encoded straight into the buffer (no array per record). */
  async appendText(s: string) {
    let rest = s;
    for (;;) {
      const r = enc.encodeInto(rest, this.buf.subarray(this.used));
      this.used += r.written;
      this.size += r.written;
      if (this.size > this.cap) throw new ExportStopped(`the export's index grew past ${this.cap} bytes`);
      if (r.read === rest.length) { if (this.used === SLICE) await this.flush(); return; }
      // (the buffer is full, up to a whole character: flushed, and the rest goes on)
      rest = rest.slice(r.read);
      await this.flush();
    }
  }
  private async flush() {
    if (!this.used) return;
    const chunk = this.buf.slice(0, this.used);
    this.used = 0;
    this.chunks++;
    if (this.wk) await this.wk.ask("append", { name: this.name, data: chunk }, [chunk.buffer]);
    else this.parts.push(new Blob([chunk]));
  }
  /** Every byte appended, in order, in slices of at most 1 MiB. */
  async *replay(): AsyncGenerator<Uint8Array> {
    await this.flush();
    for (let at = 0; at < this.size; at += SLICE) {
      if (this.wk) yield await this.wk.ask<Uint8Array>("read", { name: this.name, at, len: SLICE });
      else yield new Uint8Array(await new Blob(this.parts).slice(at, at + SLICE).arrayBuffer());
    }
  }
  async remove() { this.parts = []; this.used = 0; if (this.wk) await this.wk.ask("remove", { name: this.name }).catch(() => {}); }
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

export type Written = { crc: number; csize: number; usize: number; offset: number };
export type Hooks = { signal: AbortSignal; progress(bytes: number): void; crc: ExportWorker; /** (tests only) ms after each slice */ slicePause?: number };

const pause = () => new Promise<void>((r) => setTimeout(r, 0));

export class ZipWriter {
  offset = 0;
  members = 0;
  private out = new Uint8Array(SLICE);
  private used = 0;
  constructor(private sink: Sink, private cd: Spool, private hooks: Hooks) {}

  private check() { if (this.hooks.signal.aborted) throw new ExportStopped("cancelled"); }
  private async emit(b: Uint8Array) {
    let at = 0;
    while (at < b.length) {
      const n = Math.min(b.length - at, SLICE - this.used);
      this.out.set(b.subarray(at, at + n), this.used);
      this.used += n;
      at += n;
      if (this.used === SLICE) await this.drain();
    }
    this.offset += b.length;
  }
  private async drain() {
    if (!this.used) return;
    const chunk = this.out.slice(0, this.used);
    this.used = 0;
    this.check();
    await this.sink.write(chunk);
  }

  // (one buffer for the member's name and one for a header, reused: no arrays per member. A name is at most 1024
  // UTF-16 units of path (MAX_PATH), so at most 3,080 UTF-8 bytes with "files/" and a "/")
  private nameBuf = new Uint8Array(8192);
  private hdr = new Uint8Array(46 + 8192 + 12);
  private hv = new DataView(this.hdr.buffer);
  private nameOf(name: string): Uint8Array {
    const r = enc.encodeInto(name, this.nameBuf);
    if (r.read < name.length) throw new ExportStopped(`a name is too long to export: ${name.slice(0, 80)}…`);
    return this.nameBuf.subarray(0, r.written);
  }
  private local(name: Uint8Array, flags: number, method: number, t: { time: number; date: number }): Uint8Array {
    const b = this.hdr, v = this.hv;
    u32(v, 0, 0x04034b50); u16(v, 4, 20); u16(v, 6, flags); u16(v, 8, method); u16(v, 10, t.time); u16(v, 12, t.date);
    // (crc, sizes: 0 here, in the data descriptor after the data (bit 3); a folder's are 0 anyway)
    u32(v, 14, 0); u32(v, 18, 0); u32(v, 22, 0);
    u16(v, 26, name.length); u16(v, 28, 0);
    b.set(name, 30);
    return b.subarray(0, 30 + name.length);
  }
  private async central(name: Uint8Array, flags: number, method: number, t: { time: number; date: number }, w: Written, dir: boolean) {
    const big = w.offset >= 0xffffffff, extra = big ? 12 : 0;
    const b = this.hdr, v = this.hv;
    u32(v, 0, 0x02014b50); u16(v, 4, (3 << 8) | 45); u16(v, 6, big ? 45 : 20); u16(v, 8, flags); u16(v, 10, method);
    u16(v, 12, t.time); u16(v, 14, t.date); u32(v, 16, w.crc); u32(v, 20, w.csize); u32(v, 24, w.usize);
    u16(v, 28, name.length); u16(v, 30, extra); u16(v, 32, 0); u16(v, 34, 0); u16(v, 36, 0);
    u32(v, 38, dir ? ((0o40755 << 16) | 0x10) : (0o100644 << 16));
    u32(v, 42, big ? 0xffffffff : w.offset);
    b.set(name, 46);
    if (big) { u16(v, 46 + name.length, 0x0001); u16(v, 48 + name.length, 8); u64(v, 50 + name.length, w.offset); }
    await this.cd.append(b.subarray(0, 46 + name.length + extra));
  }

  /** A folder: `name` ends in "/". */
  async folder(name: string, mtime: number) {
    this.check();
    const n = this.nameOf(name), t = dosTime(mtime), w: Written = { crc: 0, csize: 0, usize: 0, offset: this.offset };
    await this.emit(this.local(n, 0x0800, 0, t));
    await this.central(n, 0x0800, 0, t, w, true);
    this.members++;
    return w;
  }

  /** A member from slices (at most `cap` bytes in all; past it, ExportStopped with `capWhy`). */
  async member(name: string, source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, deflate: boolean, mtime: number, cap: number, capWhy: string): Promise<Written> {
    this.check();
    const n = this.nameOf(name), t = dosTime(mtime), method = deflate ? 8 : 0, flags = 0x0808;
    const w: Written = { crc: 0, csize: 0, usize: 0, offset: this.offset };
    await this.emit(this.local(n, flags, method, t));
    await this.hooks.crc.ask("crcInit");
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
          // (the CRC in the worker: a 1 MiB copy of the slice is transferred there (posting the slice itself would
          // clone its whole buffer, the member); the slice goes on)
          const copy = slice.slice();
          await this.hooks.crc.ask("crcAdd", { data: copy }, [copy.buffer]);
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
    w.crc = await this.hooks.crc.ask<number>("crcEnd");
    const d = new Uint8Array(16), v = new DataView(d.buffer);
    u32(v, 0, 0x08074b50); u32(v, 4, w.crc); u32(v, 8, w.csize); u32(v, 12, w.usize);
    await this.emit(d);
    await this.central(n, flags, method, t, w, false);
    this.members++;
    return w;
  }

  /** The central directory (replayed from the spool), the Zip64 end record, its locator, the end record. */
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
  }
}
