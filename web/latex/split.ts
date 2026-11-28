// Splitting a large top-level chunk of the renderer's HTML into pieces (plan sbspace r5 §4, in the Worker), so that
// no single insertion is larger than PIECE_MAX:
//  - a container (a theorem div.thm, a proof div.proof, a list ol/ul.list, and the other block divs) is split at its
//    top-level children, and a child over PIECE_MAX (a theorem's long list) in turn, at most SPLIT_DEPTH deep; each later piece is a COPY of the container (same tag and classes, plus "cont"; no id, no
//    head), so styles carry over; list items keep their explicit labels (span.lbl: the list CSS has no counters);
//  - a paragraph div.p is split at the boundaries between its inline runs, each later piece a div.p.cont;
//  - a table is never split (its columns would misalign): over PIECE_MAX it is a placeholder, with its size;
//  - nor a beamer slide (section.slide: a box of fixed size), the same way, its placeholder still that slide (its own
//    open tag: Present and the tools find every frame);
//  - anything that can't be split into pieces of PIECE_MAX or less (one inline element, one cell, one formula), and
//    any chunk over CHUNK_MAX, is a placeholder saying so, with its size.
// A piece's size against PIECE_TARGET and PIECE_MAX leaves out the data: URLs of its images' src (a \sageplot's SVG,
// sagetex.mjs): one attribute value, read in one pass, not markup to parse; CHUNK_MAX counts every byte.
// The input is the renderer's own HTML: well formed, every text escaped (no raw "<" in text), attributes quoted (with
// spaces around "=" where KaTeX's MathML has them: <mtd class ="mtr-glue">, in gather, align and the like).
export const PIECE_MAX = 128 * 1024, CHUNK_MAX = 2 * 2 ** 20;
// (the size aimed for: smaller pieces parse in less time each; PIECE_MAX stays the most any piece may be)
export const PIECE_TARGET = 32 * 1024;
// (how many containers deep an element over PIECE_MAX is split in turn: a theorem's list's item's list)
export const SPLIT_DEPTH = 4;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const enc = new TextEncoder();
export const bytes = (s: string) => enc.encode(s).length;
/** The UTF-8 size less the data: URLs in img src attributes (ASCII: one byte a character). */
export function weight(s: string): number {
  let n = bytes(s);
  for (const m of s.matchAll(/<img\s[^>]*?\ssrc="(data:[^"]*)"/g)) n -= m[1].length;
  return n;
}
const kib = (n: number) => Math.ceil(n / 1024) + " KiB";

export function placeholder(why: string, size: number): string {
  return '<div class="placeholder toolarge">[' + why + " (" + kib(size) + ")]</div>";
}

/** latex check's problem (check.ts, kind "toolarge") for a chunk splitChunk showed as a placeholder: why, its size
 * and the limit it is over, at the chunk's source offset. */
export function tooLargeProblem(why: string, size: number, at: number | undefined): { kind: string; name: string; at: number } {
  return { kind: "toolarge", name: why.replace(/ to display in the prototype$/, "") + " (" + kib(size) + ", over " + kib(size > CHUNK_MAX ? CHUNK_MAX : PIECE_MAX) + ")", at: typeof at === "number" ? at : -1 };
}

type Node = { start: number; end: number };
/** The outermost element's open tag, its children's [start,end) spans, and its close tag; null if not one element. */
function outer(h: string): { tag: string; open: string; close: string; kids: Node[] } | null {
  const m = /^<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>"'/]+(?:\s*=\s*"[^"]*")?)*)\s*>/.exec(h);
  if (!m) return null;
  const tag = m[1].toLowerCase(), close = "</" + m[1] + ">";
  if (!h.endsWith(close) || VOID.has(tag)) return null;
  const innerStart = m[0].length, innerEnd = h.length - close.length;
  const kids: Node[] = [];
  let i = innerStart, depth = 0, kidStart = innerStart;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s+[^\s=>"'/]+(?:\s*=\s*"[^"]*")?)*\s*(\/?)>|<!--[\s\S]*?-->/g;
  re.lastIndex = innerStart;
  for (let t = re.exec(h); t && t.index < innerEnd; t = re.exec(h)) {
    if (t[0].startsWith("<!--")) continue;
    // (text before a tag at depth 0 is its own run)
    if (depth === 0 && t.index > kidStart) { kids.push({ start: kidStart, end: t.index }); kidStart = t.index; }
    const name = t[2].toLowerCase(), closing = t[1] === "/", selfClosing = t[3] === "/" || VOID.has(name);
    if (closing) depth--;
    else if (!selfClosing) depth++;
    if (depth < 0) return null;
    i = re.lastIndex;
    if (depth === 0) { kids.push({ start: kidStart, end: i }); kidStart = i; }
  }
  if (depth !== 0) return null;
  if (kidStart < innerEnd) kids.push({ start: kidStart, end: innerEnd });
  void i;
  return { tag, open: m[0], close, kids };
}

/** The copy of a container's open tag for a later piece: its tag and classes plus "cont", without id or other
 * attributes but class and style. */
function contOpen(open: string, tag: string): string {
  const cls = /\sclass\s*=\s*"([^"]*)"/.exec(open), style = /\sstyle\s*=\s*"([^"]*)"/.exec(open);
  return "<" + tag + ' class="' + ((cls ? cls[1] + " " : "") + "cont") + '"' + (style ? ' style="' + style[1] + '"' : "") + ">";
}

/** A text run split at spaces into parts of at most `max` bytes (a run without spaces that large: null). */
function splitText(t: string, max: number): string[] | null {
  // (byte counts kept as it goes: linear in the text)
  const out: string[] = []; let cur: string[] = [], n = 0;
  for (const w of t.split(/(?<= )/)) {
    const b = bytes(w);
    if (b > max) return null;
    if (n + b > max) { out.push(cur.join("")); cur = []; n = 0; }
    cur.push(w); n += b;
  }
  if (cur.length) out.push(cur.join(""));
  return out;
}

/** One chunk as pieces, each at most PIECE_MAX bytes (or one placeholder: `tooLarge`, if given, is told why and its
 * size, for latex check). */
export function splitChunk(h: string, tooLarge?: (why: string, size: number) => void, depth = 0): string[] {
  const n = bytes(h), w = weight(h);
  // (a placeholder only for what is over a limit: a chunk that fits one piece but can't be split is kept whole, one
  //  piece; and the size said is the one compared with the limit said, the chunk's bytes over CHUNK_MAX, else its
  //  weight over PIECE_MAX: "50 KiB, over 128 KiB" was a table kept from the reader)
  const ph = (why: string, open = "", close = "") => {
    if (n <= CHUNK_MAX && w <= PIECE_MAX) return [h];
    const size = n > CHUNK_MAX ? n : w;
    tooLarge?.(why, size);
    return [open + placeholder(why, size) + close];
  };
  if (w <= PIECE_TARGET && n <= CHUNK_MAX) return [h];
  if (n > CHUNK_MAX) {
    // (a slide over it too keeps its own open tag, found without parsing it all: every frame still a slide)
    const so = /^<section\s[^>]*?\bclass="(?:[^"]*\s)?slide(?:\s[^"]*)?"[^>]*>/.exec(h.slice(0, 4096));
    return so && h.endsWith("</section>") ? ph("this slide is too large to display in the prototype", so[0], "</section>") : ph("this block is too large to display in the prototype");
  }
  const o = outer(h);
  if (!o) return ph("this block is too large to display in the prototype");
  const cls = (/\sclass\s*=\s*"([^"]*)"/.exec(o.open) || [])[1] || "";
  // (a beamer slide neither: it is one box of a fixed size, and its pieces would each be a slide)
  if (o.tag === "section" && /\bslide\b/.test(cls)) return w <= PIECE_MAX ? [h] : ph("this slide is too large to display in the prototype", o.open, o.close);
  if (o.tag === "table" || /\btabular\b/.test(cls) || o.kids.some((k) => /^<table\b/.test(h.slice(k.start, k.end)) && weight(h.slice(k.start, k.end)) > PIECE_MAX))
    return w <= PIECE_MAX ? [h] : ph("this table is too large to display in the prototype");
  const para = o.tag === "div" && /(^|\s)p(\s|$)/.test(cls);
  // the children, a text run split further where it is itself too large (a paragraph's long text)
  const parts: string[] = [];
  for (const k of o.kids) {
    const s = h.slice(k.start, k.end);
    const b = weight(s);
    if (b <= PIECE_TARGET - 256) { parts.push(s); continue; }
    if (!s.startsWith("<")) { const t = splitText(s, PIECE_TARGET - 256); if (!t) return ph("this block is too large to display in the prototype"); parts.push(...t); continue; }
    // (one element over the target: a piece of its own, if it fits the maximum)
    if (b <= PIECE_MAX - 256) { parts.push(s); continue; }
    // (one element over the maximum, a theorem's long list: split in turn, at most SPLIT_DEPTH containers deep, each
    //  of its pieces a whole element (a later one a copy of its container, "cont") and a part of this one; one
    //  placeholder piece means it couldn't be, and the pieces made here are checked against PIECE_MAX below)
    if (depth < SPLIT_DEPTH) {
      const sub = splitChunk(s, undefined, depth + 1);
      if (sub.length > 1) { parts.push(...sub); continue; }
    }
    return w <= PIECE_MAX ? [h] : ph("this block is too large to display in the prototype");
  }
  const first = o.open, later = contOpen(o.open, o.tag);
  // (byte counts kept as it goes: linear in the chunk)
  const pieces: string[] = []; let cur: string[] = [], cn = 0;
  const flush = () => { if (cur.length) pieces.push((pieces.length ? later : first) + cur.join("") + o.close); cur = []; cn = 0; };
  for (const s of parts) {
    const b = weight(s);
    if (cur.length && cn + b + 256 > PIECE_TARGET) flush();
    cur.push(s); cn += b;
  }
  flush();
  void para;
  return pieces.every((p) => weight(p) <= PIECE_MAX) ? pieces : ph("this block is too large to display in the prototype");
}

/** A render's whole size: its chunks' pieces in all, at most `html` bytes and `chunks` chunks (the page's memory). */
export const RENDER_BOUNDS = { chunks: 20000, html: 16 * 2 ** 20 };

/** A render's chunks as the page's items, within RENDER_BOUNDS: whole chunks in order while they fit, and if any are
 * left, one more chunk in their place saying where the preview stops (its source line) and why, the chunks before it
 * fewer if the note needs their room; never part of a chunk. `tooLarge` is told of the shown chunks' placeholders
 * only; `cut` is where the rest begins. */
export function boundRender(chunks: string[], chunkPos: number[] | undefined, text: string,
  tooLarge?: (g: number, why: string, size: number) => void): { items: { g: number; h: string; b: number }[]; groups: number; pos: number[]; cut: { at: number; line: number | null } | null } {
  const kept: { ps: string[]; bs: number[]; told: [string, number][]; n: number }[] = [];
  let total = 0, g = 0;
  for (; g < chunks.length && g < RENDER_BOUNDS.chunks; g++) {
    const told: [string, number][] = [];
    const ps = splitChunk(chunks[g], (why, size) => told.push([why, size])), bs = ps.map(bytes), n = bs.reduce((a, b) => a + b, 0);
    if (total + n > RENDER_BOUNDS.html) break;
    total += n;
    kept.push({ ps, bs, told, n });
  }
  let note: string | null = null, at = -1, line: number | null = null;
  if (g < chunks.length) {
    // (the note in the place of the chunks left: a chunk of its own, within both bounds with the ones before it)
    const say = (k: number) => {
      at = typeof chunkPos?.[k] === "number" ? chunkPos[k] : -1;
      line = null;
      if (at >= 0) { line = 1; for (let i = text.indexOf("\n"); i !== -1 && i < at; i = text.indexOf("\n", i + 1)) line++; }
      return '<div class="bounderr">The preview stops here: it shows at most ' + RENDER_BOUNDS.html / 2 ** 20 + " MiB of a document, and the rest" +
        (line ? ", from line " + line + " of the source on," : "") + " is past that. <code>sagebrush latex render</code> shows all of it.</div>";
    };
    note = say(kept.length);
    while (kept.length && (kept.length + 1 > RENDER_BOUNDS.chunks || total + bytes(note) > RENDER_BOUNDS.html)) { total -= kept.pop()!.n; note = say(kept.length); }
  }
  const items: { g: number; h: string; b: number }[] = [];
  kept.forEach((c, k) => { c.ps.forEach((h, j) => items.push({ g: k, h, b: c.bs[j] })); for (const [why, size] of c.told) tooLarge?.(k, why, size); });
  if (note === null) return { items, groups: chunks.length, pos: chunkPos || [], cut: null };
  items.push({ g: kept.length, h: note, b: bytes(note) });
  const pos = Array.from({ length: kept.length }, (_, k) => (typeof chunkPos?.[k] === "number" ? chunkPos[k] : -1));
  return { items, groups: kept.length + 1, pos: pos.concat([at]), cut: { at, line } };
}
