// A workspace board's pictures as workspace files (#1872): /Attachments/board-<id>/, named by their content
// (web/board/images.ts), through the one image helper (image-store.ts). The page that edits a board saves there; an
// export, the disk mirror and Push only read.
import type { PictureFiles } from "../board/images";
import { IMAGE_BYTES_MAX, imageFolder, saveImage } from "./image-store";

/** What of the workspace a board's pictures need (Workspace has them). */
export interface PictureWorkspace {
  list(folder: string): Promise<{ path: string; kind?: string; size?: number; fid?: string }[]>;
  readUpTo(p: string, max: number): Promise<{ content: Uint8Array; entry?: { fid?: string; size?: number } }>;
  createByPerson(p: string, opts: { content: Uint8Array }): Promise<unknown>;
}

/** Board `id`'s picture files (null if its id can't name a folder: its pictures stay in this browser). `save`: also
 * saved there, by the person (a picture they paste, drop or open, or one kept before in this browser alone). */
export function boardPictureFiles(w: PictureWorkspace, id: string | null | undefined, opts: { save?: boolean } = {}): PictureFiles | null {
  const folder = id ? imageFolder("board", id) : null;
  if (!folder) return null;
  return {
    folder,
    list: async () => (await w.list(folder)).filter((e) => e.kind === undefined || e.kind === "file").map((e) => e.path),
    read: async (p) => (await w.readUpTo(p, IMAGE_BYTES_MAX)).content,
    create: opts.save ? (p, bytes) => w.createByPerson(p, { content: bytes }) : undefined,
  };
}

/** What a board's copy does with a picture it couldn't copy as a file (its bytes, if they were read; null if it has
 * none to copy: never a file, gone, unreadable): true if the caller keeps it where the copy shows it (a page: this
 * browser's store, its write committed), else it is reported. */
export type PictureKeep = (name: string, bytes: Uint8Array | null) => Promise<boolean>;

/** A picture file a copy copies: its path, its name, and what it was when measured (its file id and size). */
export type PictureFile = { path: string; name: string; size: number; fid?: string };

/** The names of a board's pictures that its files hold: those in its `images` without a source of their own (an
 * https: address, or embedded data a stored board carries until it is opened), which the board keeps itself. */
export function filePictureNames(images: unknown): string[] {
  if (!images || typeof images !== "object" || Array.isArray(images)) return [];
  return Object.entries(images as Record<string, { src?: unknown } | null>).filter(([, v]) => !(v && typeof v.src === "string" && v.src)).map(([k]) => k);
}

/** The picture files of board `from` named in `names` (its folder's `<name>.<raster ext>`), with their file ids and
 * sizes: what a copy of the board copies, for a caller to admit and charge before anything is copied, and to hold the
 * copy to (copyBoardPictures' `expect`). */
export async function pictureFilesOf(w: PictureWorkspace, from: string, names: Iterable<string>): Promise<PictureFile[]> {
  const a = boardPictureFiles(w, from);
  const want = new Set(names), out: PictureFile[] = [];
  if (!a || !want.size) return out;
  const seen = new Set<string>();
  // (no folder: no picture of the board is a file)
  for (const e of await w.list(a.folder).catch(() => [] as { path: string; kind?: string; size?: number; fid?: string }[])) {
    // (one over the image cap can't be read as a picture: not one a copy copies)
    if ((e.kind !== undefined && e.kind !== "file") || (e.size ?? 0) > IMAGE_BYTES_MAX) continue;
    const base = e.path.slice(e.path.lastIndexOf("/") + 1), name = base.slice(0, base.lastIndexOf("."));
    if (!want.has(name) || seen.has(name) || e.path !== `${a.folder}/${base}`) continue;
    seen.add(name);
    out.push({ path: e.path, name, size: e.size ?? 0, ...(e.fid !== undefined ? { fid: e.fid } : {}) });
  }
  return out;
}

/** Copy the pictures `names` of board `from` to board `to`'s folder (a board's copy: Duplicate, a conflict's, an
 * agent's or the shell's), by `create` (the copy's own provenance, never more than the board's, admitted per picture
 * with its bytes). Every name asked for is copied, kept by the caller (`keep`), or returned: the names neither copied
 * nor kept, so the caller says the copy is incomplete. With `o.expect` (the files as measured before: the shell's),
 * only those are copied, each only as it was then (its file id and size: else `o.stale(path)` is thrown, nothing more
 * copied); a file not measured is not copied. After each picture, `o.stopped()`, if it gives one, is thrown: the
 * caller's own refusal (a limit, a revoked grant), never taken as a picture that couldn't be copied. */
export async function copyBoardPictures(w: PictureWorkspace, from: string, to: string, names: Iterable<string>, create: (path: string, bytes: Uint8Array) => Promise<unknown>, keep?: PictureKeep,
  o: { expect?: PictureFile[]; stale?: (path: string) => unknown; stopped?: () => unknown } = {}): Promise<string[]> {
  const want = [...new Set(names)];
  if (!want.length) return [];
  const a = boardPictureFiles(w, from), b = boardPictureFiles(w, to);
  const measured = o.expect ?? (a && b ? await pictureFilesOf(w, from, want) : []);
  const files = new Map(a && b ? measured.map((f) => [f.name, f]) : []);
  const lost: string[] = [];
  for (const name of want) {
    const f = files.get(name);
    let u: Uint8Array | null = null;
    if (f) {
      const r = await w.readUpTo(f.path, IMAGE_BYTES_MAX).catch(() => null);
      // (held to what was measured: the same file, the same size)
      if (o.expect && (!r || r.content.length !== f.size || (f.fid !== undefined && r.entry?.fid !== f.fid))) throw o.stale ? o.stale(f.path) : new Error(`${f.path} changed since it was measured`);
      u = r ? r.content : null;
    }
    const r = u && b ? await saveImage(create, b.folder, u, { name, read: b.read }).catch(() => null) : null;
    const stop = o.stopped?.();
    if (stop) throw stop;
    if (r && "path" in r) continue;
    if (!(keep && (await keep(name, u).catch(() => false)))) lost.push(name);
  }
  return lost;
}
