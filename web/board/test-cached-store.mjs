// The store that opens from a copy first (cached.ts cachedStore) and its
// merge, deterministically (daybreak's repros, 3d21f26): edits kept in the
// order made, whatever order their hashes finish in, and the first sync
// pushes the newest (CORR-3D2-1); a change made elsewhere during the first,
// uncached load is shown after it (CORR-3D2-2); merge3(d, d, d) is d, for
// ids holding anything (CORR-3D2-3); a picture removed on one side stays
// removed (CORR-3D2-4); an edit made from the view before a document given
// the board was shown is merged with it; a change made elsewhere during the
// first sync is merged before a copy's edits are pushed (CORR-891-1); pages
// without ids keep their identity when another is put in front
// (CORR-891-2); an edit made from the first of two documents given the
// board is merged with the second (CORR-891-3); a picture removed here and
// changed there stays removed (CORR-891-4).
//   bun web/board/test-cached-store.mjs
import { cachedStore, merge3 } from "./cached.ts";
import { canonical, cleanDoc, formatError } from "./doc.ts";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const tick = (n = 20) => new Promise((r) => setTimeout(r, n));
const held = () => { let open; const p = new Promise((r) => (open = r)); return { p, open }; };
const copy = (x) => JSON.parse(JSON.stringify(x));
const doc = (title, extra = {}) => ({ title: "T", nodes: [{ id: "n", title }], ...extra });
const titleOf = (json) => JSON.parse(json).nodes[0].title;

// an in-memory copy, and a remote whose calls can be held
const memCache = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (c) => { m.set(c.key, { ...c }); } }; };
const fakeRemote = (d) => {
  const r = { doc: d && copy(d), calls: [], holds: {}, fs: new Set() };
  const gate = async (name) => { r.calls.push(name); const h = r.holds[name]; if (h) { delete r.holds[name]; await h.p; } };
  // (the hash of the document it has when asked, answered when let go)
  r.hash = async () => { const h = r.doc ? await hashOf(r.doc) : null; await gate("hash"); return h; };
  r.load = async () => { const d0 = r.doc && copy(r.doc); await gate("load"); return d0; };
  r.save = async (x) => { await gate("save"); r.doc = copy(x); };
  r.subscribe = (f) => { r.fs.add(f); return () => r.fs.delete(f); };
  r.change = (x) => { r.doc = copy(x); for (const f of r.fs) f(copy(x)); };
  return r;
};
const realDigest = crypto.subtle.digest.bind(crypto.subtle);
async function hashOf(d) { const h = new Uint8Array(await realDigest("SHA-256", new TextEncoder().encode(canonical(cleanDoc(d))))); return [...h].map((b) => b.toString(16).padStart(2, "0")).join(""); }
// (crypto.subtle.digest's calls from now: the k-th held until opened)
function holdDigest(k) {
  let n = 0;
  const h = held();
  crypto.subtle.digest = async (...a) => { if (++n === k) await h.p; return realDigest(...a); };
  return h;
}
const freeDigest = () => { crypto.subtle.digest = realDigest; };

// CORR-3D2-1: two edits; the first one's hash held; the remote's answer held
{
  const cache = memCache(), base = cleanDoc(doc("base"));
  await cache.put({ key: "k", json: canonical(base), hash: await hashOf(base), remoteHash: await hashOf(base), at: 0 });
  const R = fakeRemote(base);
  R.holds.hash = held();
  const hashGate = R.holds.hash;
  const store = cachedStore(R, "k", cache);
  await store.load();
  const dg = holdDigest(1);
  store.save(cleanDoc(doc("one")));
  store.save(cleanDoc(doc("two")));
  await tick();
  dg.open();
  await tick();
  freeDigest();
  check(titleOf(cache.m.get("k").json) === "two", "edits kept in the order made, the first one's hash finishing last: " + titleOf(cache.m.get("k").json));
  hashGate.open();
  await store.synced;
  await tick(50);
  check(titleOf(cache.m.get("k").json) === "two" && R.doc.nodes[0].title === "two", "...and the first sync pushes the newest: copy " + titleOf(cache.m.get("k").json) + ", remote " + R.doc.nodes[0].title + " " + R.calls.join());
}

// CORR-3D2-2: no copy; a change made elsewhere while the remote's document is being loaded
{
  const cache = memCache();
  const R = fakeRemote(doc("old"));
  R.holds.load = held();
  const loadGate = R.holds.load;
  const store = cachedStore(R, "k2", cache);
  const shown = [];
  store.subscribe((d) => { shown.push(d.nodes[0].title); });
  const loading = store.load();
  await tick();
  R.change(doc("new"));
  loadGate.open();
  const first = await loading;
  await store.synced;
  await tick(50);
  check(first.doc.nodes[0].title === "old" && shown.join() === "new" && titleOf(cache.m.get("k2").json) === "new", "a change made elsewhere during the first load: shown after it, and the copy's: " + JSON.stringify({ first: first.doc.nodes[0].title, shown, copy: titleOf(cache.m.get("k2").json) }));
}

// CORR-3D2-3: merge3(d, d, d) is d, whatever the ids hold
{
  const docs = {
    "ids with NUL": { pages: [{ id: "p", nodes: [{ id: "q\u0000r", title: "1" }] }, { id: "p\u0000q", nodes: [{ id: "r", title: "2" }] }] },
    "a page's id #custom": { pages: [{ id: "#custom", nodes: [{ id: "a", title: "A" }] }] },
    "an explicit #0 beside a page without an id": { pages: [{ nodes: [{ id: "a", title: "A" }] }, { id: "#0", nodes: [{ id: "b", title: "B" }] }] },
    "edges whose ends hold → and #": { nodes: [{ id: "a→b" }, { id: "c" }, { id: "a" }, { id: "b→c" }, { id: "x#2" }], edges: [{ from: "a→b", to: "c" }, { from: "a", to: "b→c" }, { from: "a", to: "c" }, { from: "a", to: "c", label: "again" }, { from: "x#2", to: "a" }] },
    "pictures and groups": { images: { a: { w: 1, h: 2 } }, nodes: [{ id: "g", kind: "group", title: "G", children: [{ id: "m", title: "M", image: "a" }] }] },
  };
  for (const [name, d] of Object.entries(docs)) {
    check(formatError(d) === null, `(${name}: a board)`);
    const c = cleanDoc(d), { doc: m, conflicts } = merge3(c, copy(c), copy(c));
    check(canonical(m) === canonical(c) && !conflicts.length, `merge3(d, d, d) is d: ${name}: ` + (canonical(m) === canonical(c) ? "" : canonical(m).slice(0, 300)));
  }
  check(/two pages have the id "p"/.test(formatError({ pages: [{ id: "p", nodes: [{ id: "x" }] }, { id: "p", nodes: [{ id: "x" }] }] }) ?? ""), "two pages with one id: not a board this page can show");
}

// CORR-3D2-4: a picture removed on one side, the title changed on the other
{
  const base = cleanDoc({ title: "b", images: { a: { w: 10, h: 10 }, z: { w: 2, h: 2 } }, nodes: [{ id: "n", title: "N" }] });
  const ours = copy(base); ours.title = "ours";
  const theirs = copy(base); delete theirs.images.a;
  const { doc: m, conflicts } = merge3(base, ours, theirs);
  check(m.title === "ours" && JSON.stringify(m.images) === '{"z":{"w":2,"h":2}}' && !conflicts.length, "a picture removed on one side stays removed: " + JSON.stringify([m.title, m.images, conflicts]));
  const o2 = copy(base); o2.images.a = { w: 20, h: 20 };
  const t2 = copy(base); t2.images.a = { w: 30, h: 30 };
  const r2 = merge3(base, o2, t2);
  check(r2.doc.images.a.w === 20 && r2.conflicts.length === 1, "...changed on both sides differently: ours, listed");
}

// an edit made from the view before a document given the board was shown: merged with it
{
  const cache = memCache(), base = cleanDoc({ title: "T", nodes: [{ id: "n", title: "base" }] });
  await cache.put({ key: "k3", json: canonical(base), hash: await hashOf(base), remoteHash: await hashOf(base), at: 0 });
  const R = fakeRemote({ title: "T", nodes: [{ id: "n", title: "base" }, { id: "t", title: "theirs" }] });
  const store = cachedStore(R, "k3", cache);
  const shown = [];
  let showGate = held();
  store.subscribe((d) => { shown.push(d.nodes.map((x) => x.title).join("+")); const g = showGate; showGate = null; return g ? g.p : undefined; });
  await store.load();
  await store.synced;
  await tick();
  // (the remote's, given the board; not yet shown; an edit made from the copy)
  store.save(cleanDoc({ title: "T", nodes: [{ id: "n", title: "mine" }] }));
  await tick(50);
  const kept = JSON.parse(cache.m.get("k3").json).nodes.map((x) => x.title).join("+");
  check(kept === "mine+theirs", "an edit made from the view before the remote's was shown: merged with it, in the copy: " + kept);
  check(shown.at(-1) === "mine+theirs", "...and the merge shown: " + shown.join(" | "));
  await tick(50);
  check(R.doc.nodes.map((x) => x.title).join("+") === "mine+theirs", "...and the remote's: " + R.doc.nodes.map((x) => x.title).join("+"));
}

// CORR-891-1: a copy with an edit the remote has not seen; a change made elsewhere while the remote's hash is asked
{
  const cache = memCache(), base = cleanDoc({ title: "T", nodes: [{ id: "n", title: "base" }] }), ours = cleanDoc({ title: "T", nodes: [{ id: "n", title: "ours" }] });
  await cache.put({ key: "k4", json: canonical(ours), hash: await hashOf(ours), remoteHash: await hashOf(base), base: canonical(base), at: 0 });
  const R = fakeRemote(base);
  R.holds.hash = held();
  const hashGate = R.holds.hash;
  const store = cachedStore(R, "k4", cache);
  const shown = [];
  store.subscribe((d) => { shown.push(d.nodes.map((x) => x.title).join("+")); });
  await store.load();
  await tick();
  R.change({ title: "T", nodes: [{ id: "n", title: "base" }, { id: "t", title: "theirs" }] });
  hashGate.open();
  await store.synced;
  await tick(50);
  const copyNow = JSON.parse(cache.m.get("k4").json).nodes.map((x) => x.title).join("+"), remoteNow = R.doc.nodes.map((x) => x.title).join("+");
  check(copyNow === "ours+theirs" && remoteNow === "ours+theirs" && shown.at(-1) === "ours+theirs", "a change made elsewhere during the first sync is merged before the copy is pushed: " + JSON.stringify({ copy: copyNow, remote: remoteNow, shown }));
}

// CORR-891-2: pages without ids, one put in front on one side, another's edited on the other
{
  const A = { title: "A", nodes: [{ id: "a", title: "A1" }] }, B = { title: "B", nodes: [{ id: "b", title: "B1" }] }, X = { title: "X", nodes: [{ id: "x", title: "X1" }] };
  const base = cleanDoc({ pages: [A, B] });
  const ours = cleanDoc({ pages: [{ ...A, intro: "mine" }, B] });
  const theirs = cleanDoc({ pages: [X, A, B] });
  const { doc: m, conflicts } = merge3(base, ours, theirs);
  const pages = m.pages.map((p) => p.title + (p.intro ? ":" + p.intro : "")).join(",");
  check(pages === "X,A:mine,B" && !conflicts.length, "pages without ids: one put in front there, another edited here: each edit on its own page: " + pages);
  // (and a page removed there, its neighbour edited here)
  const t2 = cleanDoc({ pages: [B] });
  const r2 = merge3(base, cleanDoc({ pages: [A, { ...B, intro: "mine" }] }), t2);
  check(r2.doc.pages.map((p) => p.title + (p.intro ? ":" + p.intro : "")).join(",") === "B:mine", "...a page removed there, the next edited here: " + r2.doc.pages.map((p) => p.title + (p.intro ? ":" + p.intro : "")).join(","));
}

// CORR-891-3: two documents given the board, the first shown, the second not yet; an edit made from the first
{
  const cache = memCache(), base = cleanDoc({ title: "base", nodes: [{ id: "n", title: "N" }] });
  await cache.put({ key: "k5", json: canonical(base), hash: await hashOf(base), remoteHash: await hashOf(base), at: 0 });
  const R = fakeRemote(base);
  const store = cachedStore(R, "k5", cache);
  const gates = [], given = [];
  store.subscribe((d) => { given.push(d.title + "/" + d.nodes[0].title); const g = held(); gates.push(g); return g.p; });
  await store.load();
  await store.synced;
  R.change({ title: "r1", nodes: [{ id: "n", title: "N" }] });
  await tick(30);
  R.change({ title: "r2", nodes: [{ id: "n", title: "N" }] });
  await tick(30);
  gates[0].open();
  await tick(30);
  store.save(cleanDoc({ title: "r1", nodes: [{ id: "n", title: "mine" }] }));
  await tick(50);
  const kept = JSON.parse(cache.m.get("k5").json);
  check(kept.title === "r2" && kept.nodes[0].title === "mine", "an edit made from the first of two documents given: merged with the second, not over it: " + JSON.stringify({ title: kept.title, n: kept.nodes[0].title }));
  for (const g of gates) g.open();
  await tick(50);
  check(given.at(-1) === "r2/mine" && R.doc.title === "r2" && R.doc.nodes[0].title === "mine", "...given the board, and the remote's: " + JSON.stringify({ given, remote: [R.doc.title, R.doc.nodes[0].title] }));
}

// CORR-891-4: a picture removed here and changed there: ours, removed
{
  const base = cleanDoc({ images: { a: { w: 10, h: 10 } }, nodes: [{ id: "n" }] });
  const ours = copy(base); delete ours.images;
  const theirs = copy(base); theirs.images.a = { w: 30, h: 30 };
  const { doc: m, conflicts } = merge3(base, ours, theirs);
  check(!m.images?.a && conflicts.length === 1, "a picture removed here and changed there: ours, removed, listed: " + JSON.stringify([m.images, conflicts.length]));
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
