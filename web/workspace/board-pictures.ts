// A workspace board's pictures as workspace files (#1872): /Attachments/board-<id>/, named by their content
// (web/board/images.ts), through the one image helper (image-store.ts). The page that edits a board saves there; an
// export, the disk mirror and Push only read.
import type { PictureFiles } from "../board/images";
import { IMAGE_BYTES_MAX, imageFolder, saveImage } from "./image-store";

/** What of the workspace a board's pictures need (Workspace has them). */
export interface PictureWorkspace {
  list(folder: string): Promise<{ path: string; kind?: string; size?: number }[]>;
  readUpTo(p: string, max: number): Promise<{ content: Uint8Array }>;
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

/** The picture files of board `from` named in `names` (its folder's `<name>.<raster ext>`), with their sizes: what a
 * copy of the board copies, for a caller to admit and charge before anything is copied. */
export async function pictureFilesOf(w: PictureWorkspace, from: string, names: Iterable<string>): Promise<{ path: string; name: string; size: number }[]> {
  const a = boardPictureFiles(w, from);
  const want = new Set(names), out: { path: string; name: string; size: number }[] = [];
  if (!a || !want.size) return out;
  const seen = new Set<string>();
  // (no folder: no picture of the board is a file)
  for (const e of await w.list(a.folder).catch(() => [] as { path: string; kind?: string; size?: number }[])) {
    if (e.kind !== undefined && e.kind !== "file") continue;
    const base = e.path.slice(e.path.lastIndexOf("/") + 1), name = base.slice(0, base.lastIndexOf("."));
    if (!want.has(name) || seen.has(name) || e.path !== `${a.folder}/${base}`) continue;
    seen.add(name);
    out.push({ path: e.path, name, size: e.size ?? 0 });
  }
  return out;
}

/** Copy the pictures `names` of board `from` to board `to`'s folder (a board's copy: Duplicate, a conflict's, an
 * agent's or the shell's), by `create` (the copy's own provenance, never more than the board's, admitted per picture
 * with its bytes). Every name asked for is copied, kept by the caller (`keep`), or returned: the names neither copied
 * nor kept, so the caller says the copy is incomplete. */
export async function copyBoardPictures(w: PictureWorkspace, from: string, to: string, names: Iterable<string>, create: (path: string, bytes: Uint8Array) => Promise<unknown>, keep?: PictureKeep): Promise<string[]> {
  const want = [...new Set(names)];
  if (!want.length) return [];
  const a = boardPictureFiles(w, from), b = boardPictureFiles(w, to);
  const files = a && b ? new Map((await pictureFilesOf(w, from, want)).map((f) => [f.name, f.path])) : new Map<string, string>();
  const lost: string[] = [];
  for (const name of want) {
    const p = files.get(name);
    const u = p && a ? await a.read(p).catch(() => null) : null;
    const r = u && b ? await saveImage(create, b.folder, u, { name, read: b.read }).catch(() => null) : null;
    if (r && "path" in r) continue;
    if (!(keep && (await keep(name, u).catch(() => false)))) lost.push(name);
  }
  return lost;
}
