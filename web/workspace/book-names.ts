// The names a book's table of contents (a jupyter-book _toc.yml) may give its chapters: relative, inside the
// book's folder, plain (plan-myst-notebooks-p2 r2 §2, §3, §11.6).  Checked twice, independently: by the TOC's reader
// in the MyST asset (web/myst/book.ts, D1) and by the page's book capability before it reads or opens anything
// (web/workspace/book-cap.ts, D2); either alone keeps a name inside the folder.
import { normPath, join, within } from "./paths";

/** Why `name` isn't a chapter name (a reason code), or null if it is one. */
export function badChapterName(name: string): string | null {
  if (new TextEncoder().encode(name).length > 255) return "length";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "control";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(name)) return "scheme";
  if (/^[/\\]{2}/.test(name)) return "authority";
  if (/^[/\\]/.test(name) || name.includes("\\")) return "absolute";
  const segs = name.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return "dot-segment";
  if (segs.length > 8) return "segments";
  return null;
}

/** A chapter's file name from its TOC entry: as jupyter-book reads it, "<name>.md" without an extension; null for one
 * with another extension (listed, never read). */
export function chapterFile(name: string): string | null {
  const last = name.slice(name.lastIndexOf("/") + 1);
  if (!last.includes(".")) return name + ".md";
  return /\.md$/i.test(last) ? name : null;
}

/** A chapter name resolved to a path in the book's folder, or the reason it isn't (D2 → D3 → D4); `open`: a chapter
 * entry, its extension settled (<name> → <name>.md), else `_toc.yml` or an .md name as given. */
export function resolveIn(root: string, name: string, open: boolean): { path: string } | { refused: string } {
  const bad = badChapterName(name);
  if (bad) return { refused: bad };
  let n = name;
  if (open) {
    const f = chapterFile(name);
    if (!f) return { refused: "extension" };
    n = f;
  } else if (name !== "_toc.yml" && !/\.md$/i.test(name)) return { refused: "extension" };
  let p: string;
  try { p = normPath(join(root, n)); } catch { return { refused: "path" }; }
  return insideOf(root, p);
}
/** D4, the folder's containment, on a resolved path: its own interface (no name that passes D2 resolves outside). */
export function insideOf(root: string, p: string): { path: string } | { refused: string } {
  return within(p, root) && p !== root ? { path: p } : { refused: "outside" };
}
