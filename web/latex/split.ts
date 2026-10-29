// Splitting a large top-level chunk of the renderer's HTML into pieces (plan sbspace r5 §4, in the Worker), so that
// no single insertion is larger than PIECE_MAX:
//  - a container (a theorem div.thm, a proof div.proof, a list ol/ul.list, and the other block divs) is split at its
//    top-level children; each later piece is a COPY of the container (same tag and classes, plus "cont"; no id, no
//    head), so styles carry over; list items keep their explicit labels (span.lbl: the list CSS has no counters);
//  - a paragraph div.p is split at the boundaries between its inline runs, each later piece a div.p.cont;
//  - a table is never split (its columns would misalign): over PIECE_MAX it is a placeholder, with its size;
//  - anything that can't be split into pieces of PIECE_MAX or less (one inline element, one cell, one formula), and
//    any chunk over CHUNK_MAX, is a placeholder saying so, with its size.
// The input is the renderer's own HTML: well formed, every text escaped (no raw "<" in text), attributes quoted.
export const PIECE_MAX = 128 * 1024, CHUNK_MAX = 2 * 2 ** 20;
// (the size aimed for: smaller pieces parse in less time each; PIECE_MAX stays the most any piece may be)
export const PIECE_TARGET = 32 * 1024;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const enc = new TextEncoder();
export const bytes = (s: string) => enc.encode(s).length;
const kib = (n: number) => Math.ceil(n / 1024) + " KiB";

export function placeholder(why: string, size: number): string {
  return '<div class="placeholder toolarge">[' + why + " (" + kib(size) + ")]</div>";
}

type Node = { start: number; end: number };
/** The outermost element's open tag, its children's [start,end) spans, and its close tag; null if not one element. */
function outer(h: string): { tag: string; open: string; close: string; kids: Node[] } | null {
  const m = /^<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>"'/]+(?:="[^"]*")?)*)\s*>/.exec(h);
  if (!m) return null;
  const tag = m[1].toLowerCase(), close = "</" + m[1] + ">";
  if (!h.endsWith(close) || VOID.has(tag)) return null;
  const innerStart = m[0].length, innerEnd = h.length - close.length;
  const kids: Node[] = [];
  let i = innerStart, depth = 0, kidStart = innerStart;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s+[^\s=>"'/]+(?:="[^"]*")?)*\s*(\/?)>|<!--[\s\S]*?-->/g;
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
  const cls = /\sclass="([^"]*)"/.exec(open), style = /\sstyle="([^"]*)"/.exec(open);
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

/** One chunk as pieces, each at most PIECE_MAX bytes (or one placeholder). */
export function splitChunk(h: string): string[] {
  const n = bytes(h);
  if (n <= PIECE_TARGET) return [h];
  if (n > CHUNK_MAX) return [placeholder("this block is too large to display in the prototype", n)];
  const o = outer(h);
  if (!o) return [placeholder("this block is too large to display in the prototype", n)];
  const cls = (/\sclass="([^"]*)"/.exec(o.open) || [])[1] || "";
  if (o.tag === "table" || /\btabular\b/.test(cls) || o.kids.some((k) => /^<table\b/.test(h.slice(k.start, k.end)) && bytes(h.slice(k.start, k.end)) > PIECE_MAX))
    return n <= PIECE_MAX ? [h] : [placeholder("this table is too large to display in the prototype", n)];
  const para = o.tag === "div" && /(^|\s)p(\s|$)/.test(cls);
  // the children, a text run split further where it is itself too large (a paragraph's long text)
  const parts: string[] = [];
  for (const k of o.kids) {
    const s = h.slice(k.start, k.end);
    const b = bytes(s);
    if (b <= PIECE_TARGET - 256) { parts.push(s); continue; }
    if (!s.startsWith("<")) { const t = splitText(s, PIECE_TARGET - 256); if (!t) return [placeholder("this block is too large to display in the prototype", n)]; parts.push(...t); continue; }
    // (one element over the target: a piece of its own, if it fits the maximum)
    if (b <= PIECE_MAX - 256) { parts.push(s); continue; }
    return [n <= PIECE_MAX ? h : placeholder("this block is too large to display in the prototype", n)].filter(Boolean) as string[];
  }
  const first = o.open, later = contOpen(o.open, o.tag);
  // (byte counts kept as it goes: linear in the chunk)
  const pieces: string[] = []; let cur: string[] = [], cn = 0;
  const flush = () => { if (cur.length) pieces.push((pieces.length ? later : first) + cur.join("") + o.close); cur = []; cn = 0; };
  for (const s of parts) {
    const b = bytes(s);
    if (cur.length && cn + b + 256 > PIECE_TARGET) flush();
    cur.push(s); cn += b;
  }
  flush();
  void para;
  return pieces.every((p) => bytes(p) <= PIECE_MAX) ? pieces : [placeholder("this block is too large to display in the prototype", n)];
}
