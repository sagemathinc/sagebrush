// A document's file, as its text: what Download writes (the notebook page's .ipynb, the board's Download JSON)
// and what "Export all current files (.zip)" puts in its zip (web/workspace/export/run.ts; export plan E1 r2c
// §1).  One function per kind, called by both, so the export's bytes are Download's bytes by construction.
import { toIpynb } from "../notebook/ipynb.js";
import { canonical, type BoardDoc } from "../board/doc";

/** A notebook's .ipynb text: `doc` is the open editor's snapshot (Download) or the saved record (the export). */
export function notebookFileText(doc: any): string {
  return toIpynb(doc);
}

/** A board's .board.json text, with its pictures in it (data: URLs) from `images` (a mounted board's own Images,
 * or a fresh one over the same store for a board that isn't open). */
export async function boardFileText(doc: BoardDoc, images: { inline(d: BoardDoc): Promise<BoardDoc> }): Promise<string> {
  return canonical(await images.inline(doc));
}
