// What the viewer reads, and how much (web/space): a space and a file's text are read from this site only (the page's
// policy allows nothing else). A URL is parsed and must be of this origin; it is fetched without following a redirect,
// and at most LIMITS.bytes are read. A space, from a URL or from the page around (an embed), is checked whole before
// anything of it is drawn: its depth, its values and strings, its objects and links, and its tree's files.
export const LIMITS = { bytes: 8 << 20, depth: 24, values: 400000, string: 2 << 20, nodes: 4000, edges: 20000, files: 50000 };
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
// (a space, checked whole, wherever it came from (a URL, the page around, the page's API): a JSON value within the
//  limits, its strings and keys LIMITS.bytes in all (UTF-8), of the format, with at most LIMITS.nodes objects)
export function checkSpace(s) {
  let values = 0, bytes = 0;
  const stack = [[s, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (++values > LIMITS.values) throw new Error("the space is too large to show here");
    if (d > LIMITS.depth) throw new Error("the space is nested too deeply");
    if (typeof v === "string") {
      if (v.length > LIMITS.string) throw new Error("a text in the space is too long");
      bytes += utf8Bytes(v);
    }
    if (v && typeof v === "object") {
      if (!Array.isArray(v)) for (const k of Object.keys(v)) bytes += utf8Bytes(k);
      for (const x of Array.isArray(v) ? v : Object.values(v)) stack.push([x, d + 1]);
    }
    if (bytes > LIMITS.bytes) throw new Error("the space is too large to show here");
  }
  if (s?.format !== "sagebrush-space") throw new Error("it isn't a sagebrush-space");
  if (s.nodes !== undefined && !Array.isArray(s.nodes)) throw new Error("its objects aren't a list");
  if ((s.nodes?.length ?? 0) > LIMITS.nodes) throw new Error(`it has more than ${LIMITS.nodes} objects`);
  if ((s.edges?.length ?? 0) > LIMITS.edges) throw new Error(`it has more than ${LIMITS.edges} links`);
  if (s.tree && !(Array.isArray(s.tree.files) && s.tree.files.length <= LIMITS.files)) throw new Error("its tree is too large");
  return s;
}
