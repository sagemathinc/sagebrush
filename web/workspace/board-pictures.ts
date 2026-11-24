// A workspace board's pictures as workspace files (#1872): /Attachments/board-<id>/, named by their content
// (web/board/images.ts), through the one image helper (image-store.ts). The page that edits a board saves there; an
// export, the disk mirror and Push only read.
import type { PictureFiles } from "../board/images";
import { IMAGE_BYTES_MAX, imageFolder, saveImage } from "./image-store";

/** What of the workspace a board's pictures need (Workspace has them). */
export interface PictureWorkspace {
  list(folder: string): Promise<{ path: string; kind?: string }[]>;
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

/** Copy the pictures `names` of board `from` to board `to`'s folder (a board's copy: Duplicate, a conflict's), by
 * `create` (the copy's own provenance, never more than the board's); what can't be copied (not there, refused) is
 * left, so the copy shows it from this browser if it can. */
export async function copyBoardPictures(w: PictureWorkspace, from: string, to: string, names: Iterable<string>, create: (path: string, bytes: Uint8Array) => Promise<unknown>): Promise<void> {
  const a = boardPictureFiles(w, from), b = boardPictureFiles(w, to);
  if (!a || !b) return;
  const want = new Set(names);
  for (const p of await a.list().catch(() => [] as string[])) {
    const base = p.slice(p.lastIndexOf("/") + 1), name = base.slice(0, base.lastIndexOf("."));
    if (!want.has(name) || p !== `${a.folder}/${base}`) continue;
    const u = await a.read(p).catch(() => null);
    if (u) await saveImage(create, b.folder, u, { name, read: b.read }).catch(() => {});
  }
}
