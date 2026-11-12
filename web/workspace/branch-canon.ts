// What a document's bytes are, for an agent's branch: the one function both the branch's base hashes (git_branch,
// git_branch's pages) and the branch store's commits (branch-store.ts) use, so the two always agree.  Versioned: a branch's
// record names the version its base hashes were made with, and a later change is a new version, never a silent
// reinterpretation.  Only in the pages that offer branches (git-branch.ts imports it): the board's canonical text
// isn't in every page.
//
//   canon 1   git_branch's first form (branch-rules.ts branchCopy().canonical): kept, for branches made before canon 2.
//   canon 2   a notebook: its `mode` (the kernel) and each cell's type and code, as JSON with its keys sorted, never
//             outputs, counts or ids;
//             a board: its file text, web/board/doc.ts's canonical() (cleanDoc rebuilds it from its known fields,
//             so the store's own fields never reach it; the keys in the file's fixed order; the same text Download
//             writes);
//             a data file: its bytes.

import { canonical as boardText } from "../board/doc";
import { branchCopy } from "./branch-rules";
import { docCanonBytes, type Canon } from "./canon-doc";
import type { Kind } from "./paths";

export type { Canon };
/** The version new branches are made with. */
export const CANON: Canon = 2;

const enc = new TextEncoder();

/** The canonical bytes of a document of `kind` whose content is `content`, under `version` (a notebook's and a data
 * file's: canon-doc.ts's). */
export function canonBytes(kind: Exclude<Kind, "folder">, content: any, version: Canon = CANON): Uint8Array {
  if (kind === "file" || kind === "notebook") return docCanonBytes(kind, content, version);
  if (version === 1) return branchCopy(kind, content).canonical;
  return enc.encode(boardText(content));
}
