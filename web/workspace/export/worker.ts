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
/** (tests only: the nth spool append fails, as a full disk would; 0: none) */
let failAfter = 0, appends = 0;
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
      // (can a scratch file be made and written here: OPFS present, a sync handle, and room)
      const d = await scratch(), f = await d.getFileHandle(m.name, { create: true }), h = await f.createSyncAccessHandle();
      try { h.write(new Uint8Array([1]), { at: 0 }); h.flush(); } finally { h.close(); }
      await d.removeEntry(m.name);
      return true;
    }
    case "open": {
      if (files.has(m.name)) throw new Error(`${m.name} is open already`);
      const d = await scratch(), f = await d.getFileHandle(m.name, { create: true }), h = await f.createSyncAccessHandle();
      h.truncate(0);
      files.set(m.name, { h, size: 0 });
      return null;
    }
    case "failAfter":
      failAfter = m.n; appends = 0;
      return null;
    case "append": {
      const f = files.get(m.name);
      if (!f) throw new Error(`${m.name} isn't open`);
      if (failAfter && /-(cd|manifest)$/.test(m.name) && ++appends >= failAfter) throw new Error("the scratch file couldn't be written (a test)");
      const data = m.data as Uint8Array;
      const n = f.h.write(data, { at: f.size });
      if (n !== data.length) throw new Error(`a short write to ${m.name} (${n} of ${data.length} bytes)`);
      f.size += n;
      return f.size;
    }
    case "read": {
      const f = files.get(m.name);
      if (!f) throw new Error(`${m.name} isn't open`);
      const len = Math.max(0, Math.min(m.len, f.size - m.at)), out = new Uint8Array(len);
      const n = f.h.read(out, { at: m.at });
      if (n !== len) throw new Error(`a short read of ${m.name} (${n} of ${len} bytes)`);
      return out;
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
      // (what an earlier export left, ended by a closed tab: each file whose export (the first 36 characters of its
      // name, the export's id) no longer holds its lock, m.lockPrefix + id; a running or handing-off export, in any
      // tab, holds it until its last file is removed (astra's E1-A3).  A file still open elsewhere refuses removal.)
      const q = await navigator.locks.query();
      const live = new Set([...(q.held ?? []), ...(q.pending ?? [])].map((l: any) => String(l.name)).filter((n) => n.startsWith(m.lockPrefix)).map((n) => n.slice(m.lockPrefix.length)));
      const d = await scratch();
      const names: string[] = [];
      for await (const [name] of (d as any).entries()) names.push(name);
      let n = 0;
      for (const name of names) {
        if (live.has(name.slice(0, 36))) continue;
        try { await d.removeEntry(name); n++; } catch {}
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
      self.postMessage({ id: m.id, ok: true, value }, value instanceof Uint8Array ? [value.buffer] : []);
    } catch (e: any) {
      self.postMessage({ id: m.id, ok: false, error: `${e?.name ?? "Error"}: ${e?.message ?? e}` });
    }
  });
};
