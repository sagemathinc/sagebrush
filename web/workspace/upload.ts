// Upload's rule (design/workspace-files.md §3), the same on both pages:
// Upload never converts behind the person's back.
// - `.ipynb`, `.board.json` and `.sbreplay` become documents (a `.sbreplay`
//   keeps its history), each under a free name, never written over another;
// - everything else is kept as a data file, under its own name (one already
//   there is written over, its bytes before kept as a version, §2.5);
// - a data file whose kind is recognised can then be opened as what it can
//   be (openableAs): `.py` (and `.sage`, `.m`, `.mag`) as a notebook;
//   `.json`, `.canvas`, `.mmd`, `.md`, a board `.html`, a CoCalc `.board` (or
//   `.slides`) as a board.  Opening it makes a converted copy beside it (convertCopy), and
//   the original stays.
// (a board's other formats are read by the board page's converter, given
// as `asBoard`: this module doesn't carry them into the notebook's page)
import type { Workspace, Entry } from "./api";
import { freePath, join, nameOf, parentOf, safeName, splitExt, uploadAs, type DocKind } from "./paths";
import { formatError, isBoard } from "../board/doc";
import { fromFile } from "../notebook/ipynb.js";

export { uploadAs, openableAs, type DocKind } from "./paths";

/** A `.board.json`'s text as a board: JSON of this format (or an earlier version), with items. */
export function boardJson(text: string): unknown {
  const d = JSON.parse(text);
  const bad = formatError(d);
  if (bad) throw new Error(bad);
  if (!isBoard(d)) throw new Error("not a board: a document needs nodes (or pages of them)");
  return d;
}

export type UploadOptions = {
  /** At most this many bytes a file (said before it is read). */
  maxBytes: number;
  /** The language of a notebook whose file doesn't say (a script). */
  mode: string;
  /** A `.sbreplay` read: its notebook, and its history kept as `ref`'s once that notebook is made (the page's databases). */
  replay?(bytes: Uint8Array): Promise<{ notebook: unknown; keep(ref: string): Promise<void> }>;
  /** A data file kept (the page's own writer, one that also gives it to the interpreters); by default the workspace's. */
  keepFile?(path: string, bytes: Uint8Array): Promise<void>;
};

export type UploadResult = {
  /** The documents made, in the order given. */
  made: Entry[];
  /** The data files kept. */
  kept: Entry[];
  /** "name (why)" for each file not taken, or not all of it. */
  refused: string[];
};

const message = (e: unknown) => String((e as Error)?.message ?? e);

/** `files` uploaded into `folder` by the rule above. */
export async function uploadFiles(ws: Workspace, files: File[], folder: string, o: UploadOptions): Promise<UploadResult> {
  const out: UploadResult = { made: [], kept: [], refused: [] };
  const taken = new Set((await ws.list(folder)).map((e) => e.path));
  // (a new name only while the folder has room, said before the file is read; a data file's name
  // already there is written over and takes none: the workspace checks again as it writes, LIMIT-0B0-1)
  const room = () => taken.size < ws.limits.maxFolderEntries;
  for (const f of files) {
    const name = safeName(f.name);
    if (f.size > o.maxBytes) { out.refused.push(`${name} (over ${Math.round(o.maxBytes / 2 ** 20)} MB)`); continue; }
    const as = uploadAs(name);
    if (!room() && !(as === "file" && taken.has(join(folder, name)))) { out.refused.push(`${name} (the folder is full: ${ws.limits.maxFolderEntries} entries)`); continue; }
    try {
      if (as === "file") {
        const p = join(folder, name), bytes = new Uint8Array(await f.arrayBuffer());
        if (o.keepFile) await o.keepFile(p, bytes);
        else await ws.putFile(p, bytes);
        const e = await ws.stat(p);
        if (!e || e.kind !== "file") throw new Error("not kept");
        taken.add(p);
        out.kept.push(e);
        continue;
      }
      // (a document: under a free name, never over another)
      let doc: unknown, keep: ((ref: string) => Promise<void>) | undefined;
      if (as === "replay") {
        if (!o.replay) throw new Error("a notebook with history can't be read here");
        ({ notebook: doc, keep } = await o.replay(new Uint8Array(await f.arrayBuffer())));
      } else doc = as === "notebook" ? fromFile(name, await f.text(), o.mode) : boardJson(await f.text());
      const p = freePath(folder, splitExt(name)[0], as === "board" ? ".board.json" : ".ipynb", (x) => taken.has(x));
      if (!p) throw new Error("no free name in this folder");
      const e = await ws.create(p, { content: doc });
      taken.add(p);
      out.made.push(e);
      if (keep) await keep(e.ref!).catch((err) => out.refused.push(`${name}: its history (${message(err)})`));
    } catch (err) {
      out.refused.push(`${name} (${message(err)})`);
    }
  }
  return out;
}

/** A recognised data file opened as a document: its converted copy, made
 * beside it (`name.ipynb` or `name.board.json`, a free name), the original
 * left as it is.  Only the file `entry` is (its fid), read up to `maxBytes`.
 * `asBoard`: the board page's converter (a notebook needs none). */
export async function convertCopy(ws: Workspace, entry: Entry, as: DocKind, o: { maxBytes: number; mode: string; asBoard?(name: string, text: string): unknown }): Promise<Entry> {
  const { entry: now, content } = await ws.readUpTo(entry.path, o.maxBytes);
  if (now.fid !== entry.fid) throw new Error(`${entry.path} was replaced`);
  const name = nameOf(now.path), text = new TextDecoder().decode(content);
  let doc: unknown;
  if (as === "notebook") doc = fromFile(name, text, o.mode);
  else {
    if (!o.asBoard) throw new Error("a board is made from it on the board page");
    doc = o.asBoard(name, text);
    const bad = formatError(doc);
    if (bad) throw new Error(bad);
    if (!isBoard(doc)) throw new Error("not a board: a document needs nodes (or pages of them)");
  }
  const folder = parentOf(now.path), taken = new Set((await ws.list(folder)).map((e) => e.path));
  const p = freePath(folder, splitExt(name)[0], as === "board" ? ".board.json" : ".ipynb", (x) => taken.has(x));
  if (!p) throw new Error("no free name beside it");
  return ws.create(p, { content: doc });
}
