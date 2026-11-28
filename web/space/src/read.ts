// What the viewer reads, and how much (web/space): a space and a file's text are read from this site only (the page's
// policy allows nothing else). A URL is parsed and must be of this origin; it is fetched without following a redirect,
// and at most LIMITS.bytes are read. A space, from a URL or from the page around (an embed), is checked whole before
// anything of it is drawn: its depth, its values and strings, its objects and links, and its tree's files.
export const LIMITS = { bytes: 8 << 20, depth: 24, values: 400000, string: 2 << 20, nodes: 4000, edges: 20000, files: 50000 };
// (the most of a file's text parsed into its room, in UTF-8 bytes: the file as read, and again as parsed (Sage's
//  preparser lengthens it), so a long file's parse can't hold the page)
export const ROOM_TEXT = 1 << 20;
// (a string's length in UTF-8, without encoding it)
export function utf8Bytes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
export function sameSite(href, { space = false } = {}) {
  const u = new URL(href, location.href);
  if (u.origin !== location.origin || u.username || u.password) throw new Error("only files of this site are read");
  if (space && !u.pathname.endsWith(".space.json")) throw new Error("a space is a .space.json file");
  return u;
}
export async function readText(u, max = LIMITS.bytes) {
  const r = await fetch(u.href, { redirect: "manual", credentials: "same-origin" });
  if (r.type === "opaqueredirect" || (r.status >= 300 && r.status < 400)) throw new Error("it moved; a redirect isn't followed");
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  if (new URL(r.url || u.href).origin !== location.origin) throw new Error("only files of this site are read");
  if (Number(r.headers.get("content-length")) > max) throw new Error("it's too large to show here");
  const reader = r.body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { reader.cancel().catch(() => {}); throw new Error("it's too large to show here"); }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const x of parts) { all.set(x, at); at += x.length; }
  return new TextDecoder().decode(all);
}
// (a string's length in compact JSON, UTF-8: its quotes, and each character as JSON.stringify writes it: " and \ and
//  \b \f \n \r \t escaped in two bytes, other control characters and lone surrogates in six, the rest as UTF-8)
function jsonStringBytes(s) {
  let n = 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x0c || c === 0x0a || c === 0x0d || c === 0x09) n += 2;
    else if (c < 0x20) n += 6;
    else if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else if (c >= 0xd800 && c < 0xe000) n += 6;
    else n += 3;
  }
  return n;
}
// (a value's size as compact JSON, in UTF-8 bytes: every string, number, true, false and null, and every bracket,
//  brace, comma and colon; anything JSON can't hold counted as null, an over-count at most. Within `lim`, or it throws.
//  Walked lazily, one frame for each array or object open: an array's length is checked against the values and bytes
//  left before any of it is read, and an object's keys are taken one at a time (for…in), so nothing past the first limit
//  passed is read, and nothing grows with the value's size but the frames, at most lim.depth of them)
function measure(root, lim) {
  let values = 0, bytes = 0;
  const big = () => new Error("the space is too large to show here");
  type Frame = { a: unknown[]; i: number; d: number } | { o: object; keys: Generator<string>; first: boolean; d: number };
  const frames: Frame[] = [];
  function* ownKeys(o: object) { for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) yield k; }
  const visit = (v, d) => {
    if (++values > lim.values) throw big();
    if (d > lim.depth) throw new Error("the space is nested too deeply");
    if (typeof v === "string") {
      if (v.length > lim.string) throw new Error("a text in the space is too long");
      bytes += jsonStringBytes(v);
    } else if (typeof v === "number") bytes += Number.isFinite(v) ? String(v).length : 4;
    else if (typeof v === "boolean") bytes += v ? 4 : 5;
    else if (v && typeof v === "object") {
      if (Array.isArray(v)) {
        // (each element is a value, and each but the first a comma: known before any element is read)
        if (values + v.length > lim.values) throw big();
        bytes += 2 + Math.max(0, v.length - 1);
        frames.push({ a: v, i: 0, d });
      } else {
        bytes += 2;
        frames.push({ o: v, keys: ownKeys(v), first: true, d });
      }
    } else bytes += 4; // (null, and what JSON writes as null)
    if (bytes > lim.bytes) throw big();
  };
  visit(root, 0);
  while (frames.length) {
    const f = frames[frames.length - 1];
    if ("a" in f) {
      if (f.i >= f.a.length) { frames.pop(); continue; }
      visit(f.a[f.i++], f.d + 1);
    } else {
      const k = f.keys.next();
      if (k.done) { frames.pop(); continue; }
      bytes += jsonStringBytes(k.value) + 1 + (f.first ? 0 : 1);
      f.first = false;
      if (bytes > lim.bytes) throw big();
      visit(f.o[k.value], f.d + 1);
    }
  }
  return bytes;
}
// (the size of a value as compact JSON, in UTF-8 bytes, as measure counts it: for tests)
export const jsonSize = (v) => measure(v, { values: Infinity, depth: Infinity, string: Infinity, bytes: Infinity });
// (a value's size as compact JSON, walked within limits ({ values, depth, string, bytes }): it stops, throwing, at the
//  first one passed, so a value too large is never walked whole; for what the page around the view reads for it)
export const jsonSizeWithin = (v, lim: { values: number; depth: number; string: number; bytes: number }) => measure(v, lim);
// (a space, checked whole, wherever it came from (a URL, the page around, the page's API): a JSON value within the
//  limits, its size as compact JSON LIMITS.bytes at most (UTF-8: every value and every structural byte), of the
//  format, with at most LIMITS.nodes objects)
export function checkSpace(s) {
  measure(s, LIMITS);
  if (s?.format !== "sagebrush-space") throw new Error("it isn't a sagebrush-space");
  if (s.nodes !== undefined && !Array.isArray(s.nodes)) throw new Error("its objects aren't a list");
  if ((s.nodes?.length ?? 0) > LIMITS.nodes) throw new Error(`it has more than ${LIMITS.nodes} objects`);
  if ((s.edges?.length ?? 0) > LIMITS.edges) throw new Error(`it has more than ${LIMITS.edges} links`);
  if (s.tree && !(Array.isArray(s.tree.files) && s.tree.files.length <= LIMITS.files)) throw new Error("its tree is too large");
  return s;
}
