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
import type { Kind } from "./paths";

export type Canon = 1 | 2;
/** The version new branches are made with. */
export const CANON: Canon = 2;

const enc = new TextEncoder();

/** `v` with every object's keys in sorted order (arrays kept in order), for JSON.stringify. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** The canonical bytes of a document of `kind` whose content is `content`, under `version`. */
export function canonBytes(kind: Exclude<Kind, "folder">, content: any, version: Canon = CANON): Uint8Array {
  if (version === 1) return branchCopy(kind, content).canonical;
  if (kind === "file") return content instanceof Uint8Array ? content : enc.encode(String(content ?? ""));
  if (kind === "notebook") {
    const d = content ?? {};
    const cells = Array.isArray(d.cells) ? d.cells : [];
    return enc.encode(JSON.stringify(sortKeys({ mode: d.mode ?? null, cells: cells.map((c: any) => ({ type: c?.type ?? "code", code: String(c?.code ?? "") })) })));
  }
  return enc.encode(boardText(content));
}
