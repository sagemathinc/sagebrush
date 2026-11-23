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
const { LIMITS, checkSpace, jsonSize, readText, sameSite, utf8Bytes } = await import("./src/read.ts");
const { treeRoom } = await import("./src/treeroom.ts");
const { KEPT, EDIT, keepEdit } = await import("./src/keep.ts");

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
