// ci: web-browser/space order=5
// What the viewer reads, and how much (src/read.ts), in Node against a server of its own: a space and a file's text
// come from this site only (another origin, a user in the URL, or a space not named .space.json is refused), a
// redirect is never followed, and an answer over the limit is refused, by its length or as it arrives. A space is
// checked whole: its depth, values, strings, objects, links and tree.
//   node web/space/test-read.mjs
import { createServer } from "node:http";

let failures = 0, checks = 0;
const ok = (c, msg, detail) => { checks++; console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 200) : "")); if (!c) failures++; };
const refuses = async (f, re) => { try { await f(); return false; } catch (e) { return re.test(String(e?.message ?? e)); } };

const server = createServer((req, res) => {
  if (req.url === "/space/a.space.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ format: "sagebrush-space", nodes: [] }));
  if (req.url === "/space/moved.space.json") return res.writeHead(302, { location: "/space/a.space.json" }).end();
  if (req.url === "/space/big-declared.txt") return res.writeHead(200, { "content-length": String(64) }).end("x".repeat(64));
  if (req.url === "/space/big-streamed.txt") { res.writeHead(200); for (let i = 0; i < 8; i++) res.write("y".repeat(16)); return res.end(); }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/space/`;
globalThis.location = new URL(base);
const { BUILD_COMMIT, LIMITS, checkSpace, jsonSize, jsonSizeWithin, pinnedRaw, readText, readable, sameSite, utf8Bytes } = await import("./src/read.ts");
const { treeRoom } = await import("./src/treeroom.ts");
const { KEPT, EDIT, keepEdit } = await import("./src/keep.ts");
const { layered } = await import("./src/roomlayout.ts");

try {
  // ---- where from
  ok(sameSite("a.space.json", { space: true }).href === base + "a.space.json", "a space of this site, by a relative name");
  ok(await refuses(() => sameSite("https://example.com/a.space.json", { space: true }), /only files of this site/), "another origin is refused");
  ok(await refuses(() => sameSite(`http://user:pw@127.0.0.1:${server.address().port}/space/a.space.json`, { space: true }), /only files of this site/), "a URL with a user in it is refused");
  ok(await refuses(() => sameSite("/index.html", { space: true }), /a \.space\.json file/), "a space must be a .space.json file");
  ok(await refuses(() => sameSite("//example.com/x.space.json", { space: true }), /only files of this site/), "a protocol-relative URL to another host is refused");

  // ---- reading
  ok(JSON.parse(await readText(sameSite("a.space.json", { space: true }))).format === "sagebrush-space", "a space is read");
  ok(await refuses(() => readText(sameSite("moved.space.json", { space: true })), /redirect/), "a redirect is not followed");
  // (the one other place a file's text is read from: Sagebrush's repository on GitHub, at the commit the viewer was
  //  built from; here, alone, the module has none compiled in, so the commit is given)
  const H = "0123456789abcdef0123456789abcdef01234567", RAW = `https://raw.githubusercontent.com/sagemathinc/sagebrush/${H}/`;
  const PIN = /only files of this site, or of Sagebrush's repository at the commit this was built from/;
  ok(BUILD_COMMIT === null, "this module alone has no build commit");
  ok(await refuses(() => pinnedRaw(RAW + "lib/sagebrush/nf.py"), PIN) && await refuses(() => readable(RAW + "x.py"), PIN), "without a build commit, nothing of the repository is read");
  ok(pinnedRaw(RAW + "lib/sagebrush/nf.py", H).href === RAW + "lib/sagebrush/nf.py", "a file of the repository at the build's commit");
  ok(pinnedRaw(RAW + "web/a%20b.ts", H).href === RAW + "web/a%20b.ts", "with an encoded space in its path");
  ok(pinnedRaw(RAW + "a/%2E/x.py", H).href === RAW + "a/x.py", "an encoded . segment is resolved by the URL, to the same file at the same commit");
  ok(readable("a.space.json").origin === new URL(base).origin, "readable: this site's, by sameSite");
  for (const [href, why] of [
    [`https://raw.githubusercontent.com/sagemathinc/sagebrush/${"f".repeat(40)}/x.py`, "another full commit (a fork's, say: GitHub serves those under this path too)"],
    [`http://raw.githubusercontent.com/sagemathinc/sagebrush/${H}/x.py`, "over http"],
    [`https://raw.githubusercontent.com.example.com/sagemathinc/sagebrush/${H}/x.py`, "another host that begins like it"],
    [`https://example.com/sagemathinc/sagebrush/${H}/x.py`, "another host"],
    [`https://raw.githubusercontent.com/someone/sagebrush/${H}/x.py`, "another owner"],
    [`https://raw.githubusercontent.com/sagemathinc/other/${H}/x.py`, "another repository"],
    [`https://raw.githubusercontent.com/sagemathinc/sagebrush/master/x.py`, "a branch name"],
    [`https://raw.githubusercontent.com/sagemathinc/sagebrush/${H.slice(0, 12)}/x.py`, "a short hash"],
    [`https://raw.githubusercontent.com/sagemathinc/sagebrush/${H.toUpperCase()}/x.py`, "the hash in capitals"],
    [`https://raw.githubusercontent.com/sagemathinc/sagebrush/${H}/`, "no file"],
    [RAW + "x.py?token=1", "a query"],
    [RAW + "x.py#a", "a fragment"],
    [`https://u:p@raw.githubusercontent.com/sagemathinc/sagebrush/${H}/x.py`, "a user and password"],
    [RAW + "a%2F..%2F..%2Fother%2Fx.py", "an encoded slash"],
    [RAW + "a%5Cx.py", "an encoded backslash"],
    [RAW + "a//x.py", "an empty segment"],
    [RAW + "%2e%2e/x.py", "an encoded .. (resolved by the URL, so the hash is gone)"],
    [`https://raw.githubusercontent.com/sagemathinc/sagebrush/${H}/../../other/x/${H}/x.py`, "a .. that leaves the commit"],
  ]) ok(await refuses(() => pinnedRaw(href, H), PIN), `refused: ${why}`, href);
  ok(await refuses(() => pinnedRaw(RAW + "x.py", "master"), PIN) && await refuses(() => pinnedRaw(RAW + "x.py", H.slice(0, 39)), PIN), "and a build commit that isn't a full hash allows nothing");
  // (read as a file of this site is: no redirect followed, the caps, and the answer's origin the URL's own; here the
  //  server stands for the other host, read from a page of another origin)
  const page = globalThis.location;
  globalThis.location = new URL("http://localhost:1/space/");
  try {
    ok(await refuses(() => readText(new URL(base + "moved.space.json")), /redirect/), "another origin's redirect is not followed");
    ok(await refuses(() => readText(new URL(base + "big-declared.txt"), 32), /too large/), "nor is its answer read past the cap");
    ok((await readText(new URL(base + "a.space.json"))).includes("sagebrush-space"), "its file is read");
  } finally { globalThis.location = page; }
  ok(await refuses(() => readText(sameSite("big-declared.txt"), 32), /too large/), "an answer whose length is over the limit is refused");
  ok(await refuses(() => readText(sameSite("big-streamed.txt"), 100), /too large/), "an answer that grows past the limit as it arrives is refused");
  ok((await readText(sameSite("big-streamed.txt"), 128)).length === 128, "and one within it is read whole");

  // ---- a space, checked whole
  const sp = (x) => ({ format: "sagebrush-space", nodes: [], ...x });
  ok(checkSpace(sp({})).format === "sagebrush-space", "a small space passes");
  ok(await refuses(() => checkSpace({ nodes: [] }), /isn't a sagebrush-space/), "something else is refused");
  let deep = {}; for (let i = 0; i < LIMITS.depth + 2; i++) deep = { x: deep };
  ok(await refuses(() => checkSpace(sp({ extra: deep })), /nested too deeply/), "a space nested too deeply is refused");
  ok(await refuses(() => checkSpace(sp({ extra: "z".repeat(LIMITS.string + 1) })), /too long/), "a text over the limit is refused");
  ok(await refuses(() => checkSpace(sp({ nodes: Array.from({ length: LIMITS.nodes + 1 }, (_, i) => ({ id: String(i) })) })), /objects/), "too many objects are refused");
  ok(await refuses(() => checkSpace(sp({ edges: Array.from({ length: LIMITS.edges + 1 }, () => ({})) })), /links/), "too many links are refused");
  ok(await refuses(() => checkSpace(sp({ extra: new Array(LIMITS.values + 1).fill(0) })), /too large/), "too many values in all are refused");
  ok(await refuses(() => checkSpace(sp({ tree: { files: "not a list" } })), /tree/), "a tree whose files aren't a list is refused");
  ok(await refuses(() => checkSpace(sp({ nodes: "x" })), /objects aren't a list/), "objects that aren't a list are refused");

  // ---- the whole space's bytes, wherever it comes from: its strings and keys, in UTF-8, LIMITS.bytes in all
  ok(utf8Bytes("a€😀") === 1 + 3 + 4, "UTF-8 lengths: a, €, and a character beyond the BMP", utf8Bytes("a€😀"));
  const mib = "m".repeat(1 << 20);
  ok(await refuses(() => checkSpace(sp({ nodes: Array.from({ length: 9 }, (_, i) => ({ id: String(i), text: mib })) })), /too large/), "nine 1 MiB texts, each within the string limit, are refused in all (9 MiB > 8 MiB)");
  ok(checkSpace(sp({ nodes: Array.from({ length: 7 }, (_, i) => ({ id: String(i), text: mib })) })).nodes.length === 7, "seven pass");
  ok(await refuses(() => checkSpace(sp({ nodes: Array.from({ length: 3 }, (_, i) => ({ id: String(i), text: "€".repeat(1 << 20) })) })), /too large/), "the bound is in bytes: three million € (9 MiB in UTF-8, 3 Mi characters) are refused");

  // ---- the whole space's size is its size as compact JSON: every value (numbers, true, false, null too) and every
  //      structural byte, measured as JSON.stringify writes it
  const sample = { s: 'q"b\\s\n\t\u0001 € 😀 \ud800', n: [0, -0, 0.1, -12.5e-7, 1e300, Number.MAX_VALUE, -Number.MAX_VALUE, 2 ** 53], b: [true, false, null], o: { "k\"ey": { deep: [[], {}, [1, [2, { x: "y" }]]] } }, e: "" };
  ok(jsonSize(sample) === utf8Bytes(JSON.stringify(sample)), "its size is exactly compact JSON's, in UTF-8 (escapes, control characters, €, a character beyond the BMP, a lone surrogate, numbers, true/false/null, nesting)", [jsonSize(sample), utf8Bytes(JSON.stringify(sample))]);
  // (the walk is lazy: refused at the first limit passed, it hasn't read what comes after; a getter late in a value says so)
  {
    const sentinel = () => { const t = { touched: false }; return t; };
    const arr = (t) => { const a = new Array(5000).fill(null); Object.defineProperty(a, 4999, { get() { t.touched = true; return null; }, enumerable: true }); return a; };
    const obj = (t) => { const o = {}; for (let k = 0; k < 4999; k++) o["k" + k] = null; Object.defineProperty(o, "k4999", { get() { t.touched = true; return null; }, enumerable: true }); return o; };
    const refusesWithin = (v, lim) => { try { jsonSizeWithin(v, { values: Infinity, depth: Infinity, string: Infinity, bytes: Infinity, ...lim }); return false; } catch { return true; } };
    let t = sentinel();
    ok(refusesWithin(arr(t), { values: 10 }) && !t.touched, "an array of 5,000 values, 10 allowed: refused before its 5,000th is read");
    t = sentinel();
    ok(refusesWithin(arr(t), { bytes: 100 }) && !t.touched, "and 100 bytes allowed: refused from its length, before any element is read");
    t = sentinel();
    ok(refusesWithin(obj(t), { values: 10 }) && !t.touched, "an object of 5,000 keys, 10 values allowed: refused before its last key's value is read");
    t = sentinel();
    ok(jsonSize(arr(t)) === utf8Bytes(JSON.stringify(new Array(5000).fill(null))) && t.touched, "within limits, every value is read and the size is compact JSON's");
  }
  const surface = (n, pad) => sp({ nodes: [{ id: "p", kind: "plot3d", surface: { z: new Array(n).fill(Number.MAX_VALUE) } }], pad: "x".repeat(pad) });
  const n = 340000, bare = utf8Bytes(JSON.stringify(surface(n, 0)));
  const atLimit = surface(n, LIMITS.bytes - bare);
  ok(utf8Bytes(JSON.stringify(atLimit)) === LIMITS.bytes && checkSpace(atLimit) === atLimit, `a surface of ${n} numbers (Number.MAX_VALUE), padded to exactly 8 MiB as JSON: passes`);
  ok(await refuses(() => checkSpace(surface(n, LIMITS.bytes - bare + 1)), /too large/), "one byte more: refused");
  ok(await refuses(() => checkSpace(sp({ z: new Array(350000).fill(Number.MAX_VALUE) })), /too large/), "350,000 numbers alone (8.4 MB as JSON, no strings to speak of): refused");

  // ---- a room made from a tree, within the same limits, refused before it is laid out
  const flat = (n, prefix = "") => ({ name: "t", base: "/", files: Array.from({ length: n }, (_, i) => [`${prefix}f${i}.py`, 1]), imports: [] });
  ok(checkSpace(treeRoom(flat(LIMITS.nodes), "")).nodes.length === LIMITS.nodes, `a top folder of ${LIMITS.nodes} files: its room is made`);
  ok(await refuses(() => treeRoom(flat(LIMITS.nodes + 1), ""), /more than 4000 entries/), `one more file: refused, before the room is laid out`);
  ok(checkSpace(sp({ tree: flat(LIMITS.nodes + 1) })).tree.files.length === LIMITS.nodes + 1, "(the tree itself passes the input check: the limit is the room's)");
  ok(await refuses(() => treeRoom(flat(LIMITS.nodes + 1, "sub/"), "sub"), /more than 4000 entries/), "an entered folder over the limit is refused the same way");
  ok(treeRoom(flat(LIMITS.nodes + 1, "sub/"), "").nodes.length === 1, "while the folder above it, one entry, is made");
  const linked = flat(150); linked.imports = []; for (let i = 0; i < 150; i++) for (let j = 0; j < 150; j++) if (i !== j) linked.imports.push([i, j]);
  ok(await refuses(() => treeRoom(linked, ""), /more than 20000 links/), "a room whose links (from its tree's imports) are over the limit is refused");

  // ---- every room is checked whole before it is laid out (roomlayout.js layered): a refused one is never laid out
  const parts = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: "n" + i, kind: "fn", title: "f" + i, ...extra }));
  { const nodes = parts(LIMITS.nodes); layered(nodes, []);
    ok(nodes.every((n) => Array.isArray(n.position)), `a room of ${LIMITS.nodes} parts is laid out (each given a position)`); }
  { const nodes = parts(LIMITS.nodes + 1);
    ok(await refuses(() => layered(nodes, []), /more than 4000 objects/) && nodes.every((n) => n.position === undefined), "one part more: refused before any is laid out (none has a position)"); }
  { const nodes = parts(10, { text: "t".repeat(1 << 20) });
    ok(await refuses(() => layered(nodes, []), /too large/) && nodes.every((n) => n.position === undefined), "a room whose parts are 10 MiB in all: refused before layout too"); }
  { const nodes = parts(200), edges = []; for (let i = 0; i < 200; i++) for (let j = 0; j < 200; j++) if (i !== j && edges.length <= LIMITS.edges) edges.push({ from: "n" + i, to: "n" + j });
    ok(await refuses(() => layered(nodes, edges), /links/) && nodes.every((n) => n.position === undefined), "and one with more links than a space may have"); }

  // ---- what is kept in this browser: bytes in UTF-8, the oldest dropped before a write, never over the limits
  const store = () => { const m = new Map(); return { m, get length() { return m.size; }, key: (k) => [...m.keys()][k] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const bytesIn = (st) => [...st.m].filter(([k]) => k.startsWith(EDIT)).reduce((n, [k, v]) => n + utf8Bytes(k) + utf8Bytes(v), 0);
  { const st = store();
    ok(keepEdit(st, EDIT + "a", { at: 1, text: "x" }) && st.m.size === 1, "an edit is kept");
    ok(!keepEdit(st, EDIT + "big", { at: 2, text: "€".repeat(100000) }) && !st.m.has(EDIT + "big"), "a copy of 300 KB in UTF-8 (100,000 characters) is over the 256 KiB entry limit: not kept");
    ok(keepEdit(st, EDIT + "fig", { at: 3, text: "y", svg: "s".repeat(300000) }) && JSON.parse(st.m.get(EDIT + "fig")).svg === null, "one over the limit only by its figure is kept without it"); }
  { const st = store(), lim = { entries: 200, bytes: 600000, entry: 256 << 10 };
    for (let i = 0; i < 5; i++) keepEdit(st, EDIT + i, { at: i, text: "€".repeat(40000) }, lim); // (about 120 KB each)
    ok(bytesIn(st) <= lim.bytes && !st.m.has(EDIT + "0") && st.m.has(EDIT + "4"), "the total, in bytes: the oldest dropped, never over", { kept: [...st.m.keys()], bytes: bytesIn(st) }); }
  { const st = store(), lim = { entries: 3, bytes: 1 << 20, entry: 1 << 10 };
    for (let i = 0; i < 5; i++) keepEdit(st, EDIT + i, { at: i, text: "t" }, lim);
    ok(st.m.size === 3 && [...st.m.keys()].join() === [2, 3, 4].map((i) => EDIT + i).join(), "at most so many copies: the oldest dropped", [...st.m.keys()]); }
  { // (a storage that refuses a write that would take it over its quota: the oldest are dropped first, so the write fits)
    const st = store(), quota = 300000, lim = { entries: 200, bytes: quota, entry: 256 << 10 };
    const setItem = st.setItem; st.setItem = (k, v) => { if (bytesIn(st) + utf8Bytes(k) + utf8Bytes(v) > quota) throw new Error("QuotaExceededError"); setItem(k, v); };
    for (let i = 0; i < 3; i++) keepEdit(st, EDIT + i, { at: i, text: "€".repeat(30000) }, lim);
    ok(keepEdit(st, EDIT + "new", { at: 9, text: "€".repeat(30000) }, lim) && st.m.has(EDIT + "new"), "pruned before the write: a full store still takes the newest", [...st.m.keys()]); }
  ok(KEPT.entries === 200 && KEPT.bytes === 4 << 20 && KEPT.entry === 256 << 10, "the limits: 200 copies, 4 MiB, 256 KiB each");
} finally {
  server.close();
}
console.log(failures ? `${failures} of ${checks} FAILED` : `all ${checks} passed`);
process.exit(failures ? 1 : 0);
