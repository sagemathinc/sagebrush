// File > Download "with its files (.zip)" (dependencies 2b): a notebook and the files chosen beside it, one .zip,
// written by the export's own writer (zip.ts ZipWriter, its worker's CRC) into a Blob and handed over as an export's
// is (zip.ts hand).  The page gives the members already named and frozen, each with a read of its own: nothing here
// lists the workspace or decides what goes in.
//
// Every name is checked first, all of them, before any body is read (astra's DEP2B-ZIPNAME-1, the rules of
// EXPORT-ZIPNAME-1, names.ts): one unsafe or repeated name refuses the download, never renamed.  The caps hold on the
// actual bytes as they are read and written (a file, the total, the Blob's bound), not only on the sizes listed.
import { BlobSink, ExportStopped, hand, Spool, ZipWriter } from "./zip";
import { capsInEffect, deflates, LOCK_PREFIX, startWorker } from "./run";
import { unsafeMember } from "./names";

export type Pick = { name: string; read(): Promise<Uint8Array> };
export type PickCaps = { files: number; file: number; total: number };

const enc = new TextEncoder();
const mib = (n: number) => `${Math.round(n / 2 ** 20)} MB`;

/** Why the names `names` can't be written as one .zip, or null: an unsafe name or a repeated one (the first few said). */
export function picksWhy(names: string[]): string | null {
  const bad: string[] = [], seen = new Set<string>();
  let count = 0, again = "";
  for (const n of names) {
    if (unsafeMember(n, false) && ++count <= 5) bad.push(n);
    if (seen.has(n)) again ||= n;
    seen.add(n);
  }
  if (count) return `${count === 1 ? "A file's name" : `${count} files' names`} can't go safely into a .zip (a character such as \\ or :, a device name such as NUL, or a name ending in a dot or space): ${bad.join(", ")}${count > bad.length ? ` and ${count - bad.length} more` : ""}. Rename ${count === 1 ? "it" : "them"}, or untick ${count === 1 ? "it" : "them"}, then download again.`;
  if (again) return `Two files would have the same name in the .zip: ${again}.`;
  return null;
}

/** The .zip of `picks`, named `name`, handed to the browser's download; resolves once it has been, with its size.
 * Throws ExportStopped (nothing handed over) for an unsafe name, a cap, a failed read or `signal`. */
export async function zipPicks(o: { workerUrl: string; picks: Pick[]; name: string; caps: PickCaps; signal: AbortSignal; progress?(done: number, of: number): void }): Promise<{ members: number; bytes: number }> {
  const stop = () => { if (o.signal.aborted) throw new ExportStopped("cancelled"); };
  const why = picksWhy(o.picks.map((p) => p.name));
  if (why) throw new ExportStopped(why, true);
  if (o.picks.length > o.caps.files) throw new ExportStopped(`At most ${o.caps.files.toLocaleString("en-US")} files can be downloaded together.`, true);
  stop();
  const id = crypto.randomUUID();
  let release!: () => void;
  const lifetime = new Promise<void>((r) => (release = r));
  await new Promise<void>((held, no) => { (navigator as any).locks.request(LOCK_PREFIX + id, () => { held(); return lifetime; }).catch(no); });
  let worker: Awaited<ReturnType<typeof startWorker>>["worker"] | undefined;
  const blob = capsInEffect().blob;
  const sink = new BlobSink(blob, (globalThis as any).__SB_EXPORT_TEST__?.onHand ?? hand);
  // (the central directory's records: 46 bytes, the name and a Zip64 extra's 12 at most, each)
  const cd = new Spool(`${id}-cd`, null, o.picks.reduce((n, p) => n + 58 + enc.encode(p.name).length, 0), false, o.signal);
  let committed = false;
  try {
    ({ worker } = await startWorker(o.workerUrl, id));
    worker.cancelOn(o.signal);
    const zip = new ZipWriter(sink, cd, { signal: o.signal, crc: worker, progress: () => {} });
    let total = 0, done = 0;
    for (const p of o.picks) {
      stop();
      const bytes = await p.read();
      stop();
      if (bytes.length > o.caps.file) throw new ExportStopped(`${p.name} is larger than ${mib(o.caps.file)}, the most one file can be in a download.`, true);
      if ((total += bytes.length) > o.caps.total) throw new ExportStopped(`These files are more than ${mib(o.caps.total)} in all, the most one download can hold.`, true);
      await zip.member(p.name, [bytes], await deflates(p.name, "file", bytes), Date.now(), o.caps.file, `${p.name} grew past ${mib(o.caps.file)}`);
      o.progress?.(++done, o.picks.length);
    }
    await zip.finish();
    stop();
    await sink.close(o.name);
    committed = true;
    return { members: zip.members, bytes: zip.offset };
  } catch (e) {
    if (!committed) await sink.abort();
    if (e instanceof ExportStopped) throw e;
    // (a Blob past its bound: said as the cap it is)
    throw new ExportStopped(String((e as Error)?.message ?? e));
  } finally {
    await cd.remove();
    worker?.terminate();
    release();
  }
}
