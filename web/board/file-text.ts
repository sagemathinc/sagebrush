// A board's file, as its text: what Download JSON writes, and (through web/workspace/file-bytes.ts) what the export
// puts in its zip.  Here, not in file-bytes.ts, so the board (and its package, packages/sagebrush-board) doesn't
// import the notebook's .ipynb writer to get it.
import { canonical, type BoardDoc } from "./doc";

/** A board's .board.json text, with its pictures in it (data: URLs) from `images` (a mounted board's own Images,
 * or a fresh one over the same store for a board that isn't open). */
export async function boardFileText(doc: BoardDoc, images: { inline(d: BoardDoc): Promise<BoardDoc> }): Promise<string> {
  return canonical(await images.inline(doc));
}
