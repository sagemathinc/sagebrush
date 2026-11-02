// A jupyter-book's chapters, for a MyST notebook whose folder is a book (plan-myst-notebooks-p2 r2): its _toc.yml read
// by a closed grammar (no YAML library: nothing is built from it but a list of names), every chapter name checked
// (D1, web/workspace/book-names.ts) before the page's capability is asked for it, the chapters' numbers taken from
// the TOC's order, and each present chapter's labels indexed by P1's reader and indexer, as that chapter numbers them.
// The page's capability (web/workspace/book-cap.ts) does every read, confined to the book's folder; this module only
// asks, one chapter at a time, and stops when the document it was built for isn't the open one any more.
import { badChapterName, chapterFile } from "../workspace/book-names";
import { isMystHead, frontMatter, lf, TEXT } from "../notebook/myst-head.js";
import { buildIndex } from "./index";

/** The bounds (r3 §8.3): past any, the book isn't linked, and the notebook is drawn on its own. */
export const BOUNDS = { toc: 64 * 1024, chapters: 200, chapter: 2 * 1024 * 1024, total: 32 * 1024 * 1024, labels: 20000, scalar: 255 };

/** The page's book capability, as this asset sees it (web/workspace/book-cap.ts makes it). */
export type BookCap = {
  /** the book's folder, as an opaque key (the cache's) */
  book: string;
  /** the open notebook's own name in the folder (its copy's) */
  self: string;
  /** whether it is still the open document's: false once another document opened */
  live(): boolean;
  /** whether the folder holds a file of that name (its listing: no content read) */
  has(name: string): Promise<boolean>;
  /** a file's bytes, up to `max` (else refused: "large"); refused with a reason code for a name it won't read */
  read(name: string, max: number): Promise<{ bytes?: Uint8Array; refused?: string }>;
  /** open a chapter as a notebook (its copy, or one made after asking): what happened */
  open(name: string, target: OpenTarget): Promise<OpenResult>;
  /** what the document that opened this one asked to be shown here, once (and only by the document opened for it) */
  take(): Pending | null;
};
export type OpenTarget = { label?: string; cell?: string; number?: number; title?: string; back?: { name: string; cell: string; number: number } };
export type OpenResult = "opened" | "cancelled" | { refused: string };
export type Pending = { label?: string; cell?: string; back?: { name: string; cell: string; number: number } };

export type Toc = { root: string | null; parts: { caption: string; numbered: boolean; chapters: string[] }[] };
export type BookChapter = { entry: string; file: string | null; number: number; title: string; present: boolean; myst: boolean; part: number; root: boolean };
export type BookLabel = { chapter: number; kind: string; display: string };
export type Book = { parts: { caption: string; numbered: boolean }[]; chapters: BookChapter[]; labels: Map<string, BookLabel>; dups: Set<string>; own: number };
export type BookResult = { book: Book } | { refused: "unsupported" | "large"; why: string } | null;

// ------------------------------------------------------------------ the TOC's closed grammar

type Line = { indent: number; dash: number; key: string; value: string | null; n: number };

/** A _toc.yml's chapters, or why it isn't read (the whole TOC refused: no partial book). */
export function parseToc(text: string): { toc: Toc } | { refused: string } {
  const lines: Line[] = [];
  const src = text.replace(/\r\n?/g, "\n").split("\n");
  for (let n = 0; n < src.length; n++) {
    const raw = src[n];
    if (!raw.trim() || /^ *#/.test(raw)) continue;
    if (raw.includes("\t")) return { refused: `line ${n + 1}: a tab` };
    const m = /^( *)(- +)?([A-Za-z_]+):(?: +(.*?))? *$/.exec(raw);
    if (!m) return { refused: `line ${n + 1}: not "key: value"` };
    let value: string | null = m[4] ?? null;
    if (value !== null) {
      const v = scalar(value);
      if (v === null) return { refused: `line ${n + 1}: not a plain or quoted value` };
      value = v;
    }
    lines.push({ indent: m[1].length, dash: m[2]?.length ?? 0, key: m[3], value, n: n + 1 });
  }
  let i = 0;
  const why = (l: Line | undefined, w: string) => (l ? `line ${l.n}: ${w}` : w);
  const toc: Toc = { root: null, parts: [] };
  // a chapters list under a key at indent `key`: "- file: <name>" items, at one indent, at least the key's (YAML lets a
  // list sit at its key's own indent, as jupyter-book's TOCs do); each item that one key only
  const chapters = (key: number, into: string[]): string | null => {
    const first = lines[i];
    if (!first || !first.dash || first.indent < key) return why(first, "a chapters list is \"- file: <name>\" items");
    const at = first.indent;
    while (i < lines.length && lines[i].dash && lines[i].indent === at) {
      const l = lines[i++];
      if (l.key !== "file" || l.value === null) return why(l, 'a chapter is "- file: <name>"');
      if (i < lines.length && !lines[i].dash && lines[i].indent === at + l.dash) return why(lines[i], 'a chapter is "- file: <name>" only');
      into.push(l.value);
    }
    return null;
  };
  // the parts list: "- caption: ...", "numbered: ...", "chapters:" (each once) per item
  const parts = (): string | null => {
    const first = lines[i];
    if (!first || !first.dash) return why(first, "parts is a list");
    const at = first.indent;
    while (i < lines.length && lines[i].dash && lines[i].indent === at) {
      const ci = at + lines[i].dash, part = { caption: "", numbered: false, chapters: [] as string[] }, keys = new Set<string>();
      // (the item's keys: its "- key" line, then lines at its content's indent, none with a dash)
      for (let first = true; i < lines.length; first = false) {
        const l = lines[i];
        if (!first && (l.dash || l.indent !== ci)) break;
        i++;
        if (keys.has(l.key)) return why(l, `"${l.key}" twice`);
        keys.add(l.key);
        if (l.key === "caption") { if (l.value === null) return why(l, "a caption is text"); part.caption = l.value; }
        else if (l.key === "numbered") { if (l.value !== "true" && l.value !== "false") return why(l, "numbered is true or false"); part.numbered = l.value === "true"; }
        else if (l.key === "chapters") { if (l.value !== null) return why(l, "chapters is a list"); const w = chapters(ci, part.chapters); if (w) return w; }
        else return why(l, `"${l.key}" isn't read`);
      }
      toc.parts.push(part);
    }
    return null;
  };
  const seen = new Set<string>();
  while (i < lines.length) {
    const l = lines[i];
    if (l.indent !== 0 || l.dash) return { refused: why(l, "unexpected indentation") };
    if (seen.has(l.key)) return { refused: why(l, `"${l.key}" twice`) };
    seen.add(l.key);
    i++;
    let w: string | null = null;
    if (l.key === "format") { if (l.value !== "jb-book") w = why(l, 'format is "jb-book"'); }
    else if (l.key === "root") { if (l.value === null) w = why(l, "root is a name"); else toc.root = l.value; }
    else if (l.key === "chapters" && l.value === null && !seen.has("parts")) {
      // (unnumbered, as jupyter-book has a TOC without parts unless its defaults say otherwise, which aren't read)
      const part = { caption: "", numbered: false, chapters: [] as string[] };
      w = chapters(0, part.chapters);
      toc.parts.push(part);
    } else if (l.key === "parts" && l.value === null && !seen.has("chapters")) w = parts();
    else w = why(l, `"${l.key}" isn't read here`);
    if (w) return { refused: w };
  }
  if (!seen.has("format")) return { refused: 'no "format: jb-book"' };
  // (every name, root and chapters, checked here first: D1)
  for (const name of [toc.root, ...toc.parts.flatMap((p) => p.chapters)]) {
    if (name === null) continue;
    const bad = badChapterName(name);
    if (bad) return { refused: `a chapter name (${bad})` };
  }
  if (toc.parts.reduce((n, p) => n + p.chapters.length, 0) + (toc.root ? 1 : 0) > BOUNDS.chapters) return { refused: "large" };
  return { toc };
}

// a plain or quoted scalar (no escapes), at most BOUNDS.scalar bytes; null for anything else (a trailing comment, a
// flow collection, an anchor, an alias, a tag, a block scalar, a document marker)
function scalar(v: string): string | null {
  let s: string;
  const q = /^"([^"\\]*)"$|^'([^']*)'$/.exec(v);
  if (q) s = q[1] ?? q[2];
  else {
    if (/^[&*!|>{[%@`#'"]/.test(v) || /\s#/.test(v) || v === "---" || v === "...") return null;
    s = v;
  }
  return new TextEncoder().encode(s).length <= BOUNDS.scalar ? s : null;
}

// ------------------------------------------------------------------ the book

// a chapter's title: its first "# " heading outside fenced blocks, as text
export function titleOf(body: string): string {
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,}|:{3,})/.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !/\S/.test(line.slice(line.indexOf(f[1]) + f[1].length))) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    const h = /^ {0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (h) return h[1];
  }
  return "";
}

// (one book's chapters, by name, each with the sha256 and number it was indexed with: rebuilding the same book
// re-reads its chapters but indexes again only those changed; another book replaces it)
// (a test's hold on a step (the stale-work rows: hold one, switch documents, release); unset in use)
export const hold = (phase: string): unknown => (globalThis as any).__sbBookHold?.(phase);

let cache: { book: string; files: Map<string, { key: string; title: string; labels: [string, string, string][]; markdown: boolean }> } | null = null;
const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");

/** The book `cap`'s folder is, built one chapter at a time; null if stopped (another document opened: `signal`, or
 * the capability not live), refused if its TOC isn't read or it's past a bound. */
export async function buildBook(cap: BookCap, signal: AbortSignal): Promise<BookResult> {
  const live = () => !signal.aborted && cap.live();
  if (!live()) return null;
  const t = await cap.read("_toc.yml", BOUNDS.toc);
  if (!live()) return null;
  if (t.refused === "large") return { refused: "large", why: "its table of contents is over 64 KiB" };
  if (!t.bytes) return { refused: "unsupported", why: t.refused ?? "no table of contents" };
  const parsed = parseToc(new TextDecoder(TEXT.encoding, TEXT).decode(t.bytes));
  if ("refused" in parsed) return parsed.refused === "large" ? { refused: "large", why: `over ${BOUNDS.chapters} chapters` } : { refused: "unsupported", why: parsed.refused };
  const toc = parsed.toc;
  if (cache?.book !== cap.book) cache = { book: cap.book, files: new Map() };
  const book: Book = { parts: toc.parts.map((p) => ({ caption: p.caption, numbered: p.numbered })), chapters: [], labels: new Map(), dups: new Set(), own: -1 };
  const entries: { entry: string; part: number; root: boolean }[] = [];
  if (toc.root) entries.push({ entry: toc.root, part: -1, root: true });
  toc.parts.forEach((p, k) => { for (const c of p.chapters) entries.push({ entry: c, part: k, root: false }); });
  let number = 0, total = 0, labels = 0;
  const own = cap.self.replace(/(?: \(\d+\))?\.ipynb$/i, "");
  for (const e of entries) {
    const n = !e.root && toc.parts[e.part].numbered ? ++number : 0;
    const file = chapterFile(e.entry);
    const ch: BookChapter = { entry: e.entry, file, number: n, title: "", present: false, myst: false, part: e.part, root: e.root };
    book.chapters.push(ch);
    if (file && !file.includes("/") && file.replace(/\.md$/i, "") === own) book.own = book.chapters.length - 1;
    // (a chapter of another kind: listed, never read; a missing one: listed, keeps its number, never read)
    if (!file || !live()) { if (!live()) return null; continue; }
    if (!(await cap.has(file))) { if (!live()) return null; continue; }
    await hold("before-read");
    if (!live()) return null;
    const left = BOUNDS.total - total;
    if (left <= 0) return { refused: "large", why: "its chapters are over 32 MiB in all" };
    const r = await cap.read(file, Math.min(BOUNDS.chapter, left));
    if (!live()) return null;
    if (r.refused === "large") return { refused: "large", why: left < BOUNDS.chapter ? "its chapters are over 32 MiB in all" : `${file} is over 2 MiB` };
    if (!r.bytes) continue;
    ch.present = true;
    total += r.bytes.length;
    const key = (await sha(r.bytes)) + ":" + n;
    if (!live()) return null;
    let got = cache.files.get(file);
    if (got?.key !== key) {
      const text = new TextDecoder(TEXT.encoding, TEXT).decode(r.bytes);
      got = { key, title: "", labels: [], markdown: false };
      // (a non-MyST .md: listed, no labels)
      if (isMystHead(text)) {
        // (its body indexed as one text: the indexer skips fenced blocks, and a ```{code-cell} is one, so only the
        // Markdown's directives and targets count, in order, numbered as the notebook would number them)
        const t2 = lf(text), body = t2.slice(frontMatter(t2)?.end ?? 0);
        const idx = buildIndex([{ id: "b", text: body }], n);
        got.markdown = true;
        got.labels = [...idx.labels].map(([l, x]) => [l, x.kind, x.display]);
        got.title = titleOf(body);
      }
      cache.files.set(file, got);
    }
    ch.title = got.title;
    ch.myst = got.markdown;
    for (const [l, kind, display] of got.labels) {
      if (++labels > BOUNDS.labels) return { refused: "large", why: `over ${BOUNDS.labels} labels` };
      // (a label two chapters define: the first in the TOC's order, the reference saying so)
      if (book.labels.has(l)) book.dups.add(l);
      else book.labels.set(l, { chapter: book.chapters.length - 1, kind, display });
    }
  }
  return live() ? { book } : null;
}
