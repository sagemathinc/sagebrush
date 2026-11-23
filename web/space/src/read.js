// What the viewer reads, and how much (web/space): a space and a file's text are read from this site only (the page's
// policy allows nothing else). A URL is parsed and must be of this origin; it is fetched without following a redirect,
// and at most LIMITS.bytes are read. A space, from a URL or from the page around (an embed), is checked whole before
// anything of it is drawn: its depth, its values and strings, its objects and links, and its tree's files.
export const LIMITS = { bytes: 8 << 20, depth: 24, values: 400000, string: 2 << 20, nodes: 4000, edges: 20000, files: 50000 };
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
// (a space, checked whole: a JSON value within the limits, of the format, with at most LIMITS.nodes objects)
export function checkSpace(s) {
  let values = 0;
  const stack = [[s, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (++values > LIMITS.values) throw new Error("the space is too large to show here");
    if (d > LIMITS.depth) throw new Error("the space is nested too deeply");
    if (typeof v === "string" && v.length > LIMITS.string) throw new Error("a text in the space is too long");
    if (v && typeof v === "object") for (const x of Array.isArray(v) ? v : Object.values(v)) stack.push([x, d + 1]);
  }
  if (s?.format !== "sagebrush-space") throw new Error("it isn't a sagebrush-space");
  if (s.nodes !== undefined && !Array.isArray(s.nodes)) throw new Error("its objects aren't a list");
  if ((s.nodes?.length ?? 0) > LIMITS.nodes) throw new Error(`it has more than ${LIMITS.nodes} objects`);
  if ((s.edges?.length ?? 0) > LIMITS.edges) throw new Error(`it has more than ${LIMITS.edges} links`);
  if (s.tree && !(Array.isArray(s.tree.files) && s.tree.files.length <= LIMITS.files)) throw new Error("its tree is too large");
  return s;
}
