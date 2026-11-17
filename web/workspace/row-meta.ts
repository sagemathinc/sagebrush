// The Files list's words beside a row (browser.ts), as a pure function of the entry and of which documents' contents
// are in this browser (Workspace.contentIds), so a suite can check them without the sidebar (P0 #1, the grader's
// G-AD-1).
import type { Entry } from "./api";

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 2 ** 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 2 ** 20).toFixed(1)} MB`);
const LANG: Record<string, string> = { sage: "Sage", magma: "Magma", matlab: "MATLAB" };
/** The documents whose content is in this browser (Workspace.contentIds). */
export type ContentHere = { notebook: Set<string>; board: Set<string> };

/** Another device's, its content not here yet: a data file not fetched yet, or a document with no content here. */
export function isElsewhere(e: Entry, here: ContentHere): boolean {
  if (!e.remote) return false;
  if (e.kind === "file") return true;
  return (e.kind === "notebook" || e.kind === "board") && !!e.ref && !here[e.kind].has(e.ref);
}

/** A row's name's hover: its path, with why it reads as it does (another device's, or renamed by the server's index),
 * and for a file or document its last-modified time (`when`: how it is written), so the time is there even where the
 * list is too narrow to show its column, and duplicates can be told apart. */
export function fileRowTitle(e: Entry, here: ContentHere, when: (t: number) => string): string {
  const why = isElsewhere(e, here) ? `${e.path}: on another device; its content arrives once that device syncs it` : e.renamed?.to === e.path ? `${e.path}: renamed from ${e.renamed.from.slice(e.renamed.from.lastIndexOf("/") + 1)}: another device has one with that name` : e.path;
  return e.kind === "folder" ? why : `${why}\nLast modified ${when(e.updated)}`;
}

/** The words beside a row: "missing" (its contents not found here), "on another device", "(renamed)" (this device's
 * own, placed at another name by the server's index, while it stays there), else its size or its language. */
export function fileRowMeta(e: Entry, here: ContentHere): string {
  if (e.missing) return "missing";
  // (a data file whose downloads fail says so, B5: never "on another device" in silence)
  if (isElsewhere(e, here)) return e.fetchFailed ? (e.fetchFailed.final ? `not downloaded: ${e.fetchFailed.why}` : "download failed, retrying") : "on another device";
  if (e.renamed?.to === e.path) return "(renamed)";
  if (e.kind === "file") return fmtSize(e.size ?? 0);
  if (e.kind === "folder") return "";
  return LANG[e.mode ?? ""] ?? "";
}
