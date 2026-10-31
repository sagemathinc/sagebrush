// The export's worker (sagebrush-export-worker.js; export plan E1 r2c §5-§6): the members' CRC-32, over 1 MiB slices,
// off the main thread; and its scratch files in the origin-private file system, through sync access handles (which
// exist only in a worker): the metadata spool and the OPFS sink.  One request at a time per file; every answer is
// {id, ok, value} or {id, ok: false, error}.
import { crc32Final, crc32Init, crc32Update } from "./crc32";

declare const self: any;
/** The scratch folder, under the origin-private root: everything the export writes there, and only that. */
export const SCRATCH = "sagebrush-export";

let crc = crc32Init();
const files = new Map<string, { h: any; size: number }>();
let dir: any;

async function scratch(): Promise<any> {
  dir ??= await (await navigator.storage.getDirectory()).getDirectoryHandle(SCRATCH, { create: true });
  return dir;
}

async function handle(m: any): Promise<unknown> {
  switch (m.op) {
    case "crcInit":
      crc = crc32Init();
      return null;
    case "crcAdd":
      crc = crc32Update(crc, m.data as Uint8Array);
      return null;
    case "crcEnd":
      return crc32Final(crc);
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
    case "append": {
      const f = files.get(m.name);
      if (!f) throw new Error(`${m.name} isn't open`);
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
      // (what an earlier export left, ended by a closed tab: each file removed if it can be; one still open in
      // another tab's export (its sync handle held) refuses removal, and is left)
      const d = await scratch();
      const names: string[] = [];
      for await (const [name] of (d as any).entries()) names.push(name);
      for (const name of names) { try { await d.removeEntry(name); } catch {} }
      return names.length;
    }
  }
  throw new Error(`unknown op ${m.op}`);
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  try {
    const value = await handle(m);
    self.postMessage({ id: m.id, ok: true, value }, value instanceof Uint8Array ? [value.buffer] : []);
  } catch (e: any) {
    self.postMessage({ id: m.id, ok: false, error: `${e?.name ?? "Error"}: ${e?.message ?? e}` });
  }
};
