// The names a book's table of contents (a jupyter-book _toc.yml) may give its chapters: relative, inside the
// book's folder, plain (plan-myst-notebooks-p2 r2 §2, §3, §11.6).  Checked twice, independently: by the TOC's reader
// in the MyST asset (web/myst/book.ts, D1) and by the page's book capability before it reads or opens anything
// (web/workspace/book-cap.ts, D2); either alone keeps a name inside the folder.

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
