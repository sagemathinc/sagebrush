// A document's file, as its text: what Download writes (the notebook page's .ipynb, the board's Download JSON)
// and what "Export all current files (.zip)" puts in its zip (web/workspace/export/run.ts; export plan E1 r2c
// §1).  One function per kind, called by both, so the export's bytes are Download's bytes by construction.
import { toIpynb, ipynbObject } from "../notebook/ipynb.js";
import { cleanDocSteps, boardTextParts } from "../board/doc";
import { boardFileText } from "../board/file-text";

// (for the export's streaming writer, built into its chunk: the notebook's JSON value, which notebookFileText writes,
// and the board's cleanDoc in steps and boardText in parts; web/workspace/export/stream.ts)
export { ipynbObject, cleanDocSteps, boardTextParts };
// (the board's own, in web/board/file-text.ts, so the board doesn't import the .ipynb writer)
export { boardFileText };

/** A notebook's .ipynb text: `doc` is the open editor's snapshot (Download) or the saved record (the export). */
export function notebookFileText(doc: any): string {
  return toIpynb(doc);
}
