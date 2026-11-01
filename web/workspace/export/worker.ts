// The export's worker (sagebrush-export-worker.js; export plan E1 r2c §5-§6): the members' CRC-32 and SHA-256, over
// 1 MiB slices, off the main thread (no whole-member digest anywhere: daybreak2's E1-D2-1); and its scratch files in the origin-private file system, through sync access handles (which
// exist only in a worker): the metadata spool and the OPFS sink.  One request at a time per file; every answer is
// {id, ok, value} or {id, ok: false, error}.
import { crc32Final, crc32Init, crc32Update } from "./crc32";
import { Sha256 } from "./sha256";

declare const self: any;
/** The scratch folder, under the origin-private root: everything the export writes there, and only that. */
export const SCRATCH = "sagebrush-export";

let crc = crc32Init(), sha = new Sha256();
/** (tests only: the nth append to a file whose name matches failRe fails, as a full disk would; 0: none) */
let failAfter = 0, appends = 0, failRe = /-(cd|manifest)$/;
/** (tests only: the answer to each append to a file whose name matches appendDelayRe held back this long, the append
 * itself done at once and the worker going on with the next request: so a Cancel lands with a slice still away, and
 * a fast path meets its slice still away, while everything else the worker does is answered as usual) */
let appendDelay = 0, appendDelayRe: RegExp | null = null;
const files = new Map<string, { h: any; size: number }>();
let dir: any;

async function scratch(): Promise<any> {
  dir ??= await (await navigator.storage.getDirectory()).getDirectoryHandle(SCRATCH, { create: true });
  return dir;
}

async function handle(m: any): Promise<unknown> {
  switch (m.op) {
    case "hashInit":
      crc = crc32Init();
      sha = new Sha256();
      return null;
    case "hashAdd":
      crc = crc32Update(crc, m.data as Uint8Array);
      sha.update(m.data as Uint8Array);
      return null;
    case "hashEnd":
      return { crc: crc32Final(crc), sha256: sha.hex() };
    case "probe": {
      // (can a scratch file be made and written here: OPFS present, a sync handle, and room.  The file is removed
      // however the probe ends: a failed write, flush or handle leaves nothing (astra's E1-R2-A2))
      const d = await scratch();
      try {
        const f = await d.getFileHandle(m.name, { create: true }), h = await f.createSyncAccessHandle();
        try {
          if (m.fail === "write") throw new Error("the probe's write failed (a test)");
          h.write(new Uint8Array([1]), { at: 0 });
          if (m.fail === "flush") throw new Error("the probe's flush failed (a test)");
          h.flush();
        } finally { h.close(); }
      } finally { await d.removeEntry(m.name).catch(() => {}); }
      return true;
    }
    case "open": {
      if (files.has(m.name)) throw new Error(`${m.name} is open already`);
      // (the file and its handle owned from the moment they exist: on any failure, closed and removed)
      const d = await scratch();
      let h: any = null;
      try {
        const f = await d.getFileHandle(m.name, { create: true });
        h = await f.createSyncAccessHandle();
        if (m.fail === "truncate") throw new Error("the scratch file couldn't be truncated (a test)");
        h.truncate(0);
        files.set(m.name, { h, size: 0 });
      } catch (e) {
        try { h?.close(); } catch {}
        await d.removeEntry(m.name).catch(() => {});
        throw e;
      }
      return null;
    }
    case "failAfter":
      failAfter = m.n; appends = 0; failRe = m.re ? new RegExp(m.re) : /-(cd|manifest)$/;
      return null;
    case "appendDelay":
      appendDelay = m.ms; appendDelayRe = m.re ? new RegExp(m.re) : null;
      return null;
    case "append": {
      // (a slice: its buffer and its valid length; only [0, len) written, and the buffer transferred back in the
      // reply (E1 r2a heap plan r2c §3))
      const f = files.get(m.name);
      if (!f) throw new Error(`${m.name} isn't open`);
      if (failAfter && failRe.test(m.name) && ++appends >= failAfter) throw new Error("the scratch file couldn't be written (a test)");
      const data = new Uint8Array(m.data as ArrayBuffer, 0, m.len);
      const n = f.h.write(data, { at: f.size });
      if (n !== data.length) throw new Error(`a short write to ${m.name} (${n} of ${data.length} bytes)`);
      f.size += n;
      return m.data;
    }
    case "read": {
      // (into the lent buffer: [0, n) filled, n and the buffer sent back; n is less than asked only past the file's end)
      const f = files.get(m.name);
      if (!f) throw new Error(`${m.name} isn't open`);
      const len = Math.max(0, Math.min(m.len, f.size - m.at));
      const n = f.h.read(new Uint8Array(m.data as ArrayBuffer, 0, len), { at: m.at });
      if (n !== len) throw new Error(`a short read of ${m.name} (${n} of ${len} bytes)`);
      return { n, buf: m.data };
    }
    case "truncate": {
      // (tests only: the file cut by its last `by` bytes, as a lost write would leave it)
      const f = files.get(m.name);
      if (!f) throw new Error(`${m.name} isn't open`);
      f.size = Math.max(0, f.size - m.by);
      f.h.truncate(f.size);
      return null;
    }
    case "close": {
      const f = files.get(m.name);
      if (f) { f.h.flush(); f.h.close(); files.delete(m.name); }
      return null;
    }
    case "remove": {
      const f = files.get(m.name);
      if (f) { try { f.h.close(); } catch {} files.delete(m.name); }
      const d = await scratch();
      try { await d.removeEntry(m.name); } catch (e: any) { if (e?.name !== "NotFoundError") throw e; }
      return null;
    }
    case "removeStale": {
      // (what an earlier export left, ended by a closed tab: each file is removed only while holding ITS export's lock
      // (m.lockPrefix + the first 36 characters of its name, the export's id), taken if no one holds it: a running or
      // handing-off export, in any tab, holds its lock from before its first file until its last is gone, so its
      // files are never removed, whenever it started relative to this sweep (astra's E1-R2-A2).  A file still open
      // elsewhere refuses removal.)
      // (tests only: a pause before the listing, where another export may start and hand off: its files are then
      // listed here, and must be left)
      if (m.pauseMs) await new Promise((r) => setTimeout(r, m.pauseMs));
      const d = await scratch();
      const names: string[] = [];
      for await (const [name] of (d as any).entries()) names.push(name);
      let n = 0;
      for (const name of names) {
        const id = name.slice(0, 36);
        await navigator.locks.request(m.lockPrefix + id, { ifAvailable: true }, async (lock: unknown) => {
          if (!lock) return;
          try { await d.removeEntry(name); n++; } catch {}
        });
      }
      return n;
    }
  }
  throw new Error(`unknown op ${m.op}`);
}

// (one request at a time, in the order they came: a removal asked after a Cancel runs after the append still running)
let queue: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  queue = queue.then(async () => {
    try {
      const value = await handle(m);
      // (a buffer in the answer goes back by transfer: a slice's, or a read's)
      const give = value instanceof ArrayBuffer ? [value] : (value as any)?.buf instanceof ArrayBuffer ? [(value as any).buf] : value instanceof Uint8Array ? [value.buffer] : [];
      const answer = () => self.postMessage({ id: m.id, ok: true, value }, give);
      if (m.op === "append" && appendDelay && (!appendDelayRe || appendDelayRe.test(m.name))) setTimeout(answer, appendDelay);
      else answer();
    } catch (e: any) {
      self.postMessage({ id: m.id, ok: false, error: `${e?.name ?? "Error"}: ${e?.message ?? e}` });
    }
  });
};
