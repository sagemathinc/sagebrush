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
// changed there stays removed (CORR-891-4); a change made elsewhere while
// the copy's push was on its way is merged and pushed (CORR-C06-1); a
// blank page keeps its identity (CORR-C06-2); documents are given the board
// one at a time, in order (CORR-C06-3); an answer asked for before a
// change made elsewhere is not taken over it (CORR-EB9-1); pages are told
// apart by their own fields too, and the store gives pages ids (CORR-EB9-2);
// the store opens by giving the remote's pages ids, saved only over the
// document they were given to, and from the new one if it changed
// (CORR-DB8-1, -2); a tie between pages is ours kept and said (CORR-DB8-3);
// pages without ids arriving later get the ids of the pages they are; a
// remote without compare-and-swap is refused (CORR-DAF-2); a page match is
// taken only if mutual (CORR-DAF-3); a remote changing at every try opens,
// busy, and its ids go with the next save (CORR-DAF-4); a first save
// expects no document, and one made meanwhile is merged (CORR-6B0-1); saves
// refused again and again stop, busy (PERF-6B0-2); an older store's save
// landing never writes over a newer store's copy (CORR-67E-1); edits made
// while the remote is asked wait for its answer (PERF-67E-2); an edit whose
// writes to the copy are refused again and again is kept, never dropped
// (CORR-1EC-1).
//   bun web/board/test-cached-store.mjs
import { adopted, cachedStore, merge3, IdbDocCache, COPY_UNAVAILABLE } from "./cached.ts";
import { canonical, cleanDoc, formatError } from "./doc.ts";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const tick = (n = 20) => new Promise((r) => setTimeout(r, n));
const held = () => { let open; const p = new Promise((r) => (open = r)); return { p, open }; };
const copy = (x) => JSON.parse(JSON.stringify(x));
const doc = (title, extra = {}) => ({ title: "T", nodes: [{ id: "n", title }], ...extra });
const titleOf = (json) => JSON.parse(json).nodes[0].title;
// (a refused save's retries, quick: a test's wait)
const FAST = { first: 5, max: 40, tries: 8 };

// an in-memory copy, and a remote whose calls can be held
// (put as IdbDocCache's: only over the version expected; the tests' own, without one, as they are)
const memCache = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? { ...m.get(k) } : null), put: async (c, expected) => { const cur = m.get(c.key), v = cur ? cur.v ?? 0 : null; if (expected !== undefined && v !== expected) return false; m.set(c.key, { ...c, v: (v ?? 0) + 1 }); return true; } }; };
const fakeRemote = (d, o = {}) => {
  const r = { doc: d && copy(d), calls: [], holds: {}, fs: new Set(), saves: 0, cas: o.cas ?? true };
  const gate = async (name) => { r.calls.push(name); const h = r.holds[name]; if (h) { delete r.holds[name]; await h.p; } };
  // (the hash of the document it has when asked, answered when let go)
  r.hash = async () => { const h = r.doc ? await hashOf(r.doc) : null; await gate("hash"); return h; };
  r.load = async () => { const d0 = r.doc && copy(r.doc); await gate("load"); return d0; };
  // (compare-and-swap: only over the document whose hash it is given, null: none, as it is when the save is done)
  r.save = async (x, expected) => { await gate("save"); if ((r.doc ? await hashOf(r.doc) : null) !== expected) return false; r.doc = copy(x); r.saves++; return true; };
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
  check((first.doc.nodes[0].title === "new" || shown.at(-1) === "new") && titleOf(cache.m.get("k2").json) === "new", "a change made elsewhere during the first load: the board ends with it (given at once, or after), and so does the copy: " + JSON.stringify({ first: first.doc.nodes[0].title, shown, copy: titleOf(cache.m.get("k2").json) }));
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
  const firstShow = showGate;
  store.subscribe((d) => { shown.push(d.nodes.map((x) => x.title).join("+")); const g = showGate; showGate = null; return g ? g.p : undefined; });
  await store.load();
  for (let k = 0; k < 50 && !shown.length; k++) await tick(10);
  // (the remote's, given the board; not yet shown; an edit made from the copy; then shown)
  store.save(cleanDoc({ title: "T", nodes: [{ id: "n", title: "mine" }] }));
  await tick();
  firstShow.open();
  await store.synced;
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
  await tick(30);
  gates[1]?.open();
  await tick(50);
  const kept = JSON.parse(cache.m.get("k5").json);
  check(kept.title === "r2" && kept.nodes[0].title === "mine", "an edit made from the first of two documents given: merged with the second, not over it: " + JSON.stringify({ title: kept.title, n: kept.nodes[0].title }));
  for (let k = 0; k < 5; k++) { for (const g of gates) g.open(); await tick(20); }
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

// CORR-C06-1: a copy with an edit the remote has not seen; a change made elsewhere while the copy's push is on its way
{
  const cache = memCache(), base = cleanDoc({ title: "T", nodes: [{ id: "n", title: "base" }] }), ours = cleanDoc({ title: "T", nodes: [{ id: "n", title: "ours" }] });
  await cache.put({ key: "k6", json: canonical(ours), hash: await hashOf(ours), remoteHash: await hashOf(base), base: canonical(base), at: 0 });
  const R = fakeRemote(base);
  R.holds.save = held();
  const saveGate = R.holds.save;
  const store = cachedStore(R, "k6", cache, FAST);
  const shown = [];
  store.subscribe((d) => { shown.push(d.nodes.map((x) => x.title).join("+")); });
  await store.load();
  for (let k = 0; k < 50 && !R.calls.includes("save"); k++) await tick(10);
  R.change({ title: "T", nodes: [{ id: "n", title: "base" }, { id: "t", title: "theirs" }] });
  saveGate.open();
  await store.synced;
  await tick(80);
  const copyNow = JSON.parse(cache.m.get("k6").json).nodes.map((x) => x.title).join("+"), remoteNow = R.doc.nodes.map((x) => x.title).join("+");
  check(R.calls.includes("save") && copyNow === "ours+theirs" && remoteNow === "ours+theirs" && shown.at(-1) === "ours+theirs", "a change made elsewhere while the copy's push was on its way: merged, and the merge pushed: " + JSON.stringify({ copy: copyNow, remote: remoteNow, shown }));
}

// CORR-C06-2: a page without an id, items or title; another put in front of it there, it edited here
{
  const A = { nodes: [] }, B = { nodes: [{ id: "b", title: "B" }] }, X = { nodes: [{ id: "x", title: "X" }] };
  const { doc: m, conflicts } = merge3(cleanDoc({ pages: [A, B] }), cleanDoc({ pages: [{ ...A, intro: "mine" }, B] }), cleanDoc({ pages: [X, A, B] }));
  const pages = m.pages.map((p) => (p.intro ? "A:" + p.intro : p.nodes.map((n) => n.id).join("") || "A")).join(",");
  check(pages === "A:mine,b" && conflicts.some((c) => c.field === "pages"), "a blank page (no id, items or title) that cannot be told apart: ours kept, never a page doubled nor an edit moved, and the conflict said: " + pages + " " + JSON.stringify(conflicts));
}

// CORR-C06-3: two documents given the board, the second's showing done first: shown in the order given
{
  const cache = memCache(), base = cleanDoc({ title: "base", nodes: [{ id: "n", title: "N" }] });
  await cache.put({ key: "k7", json: canonical(base), hash: await hashOf(base), remoteHash: await hashOf(base), at: 0 });
  const R = fakeRemote(base);
  const store = cachedStore(R, "k7", cache);
  const gates = new Map(), given = [], done = [];
  store.subscribe((d) => { given.push(d.title); const g = held(); gates.set(d.title, g); return g.p.then(() => done.push(d.title)); });
  await store.load();
  await store.synced;
  R.change({ title: "r1", nodes: [{ id: "n", title: "N" }] });
  await tick(20);
  R.change({ title: "r2", nodes: [{ id: "n", title: "N" }] });
  await tick(20);
  const before = given.join();
  gates.get("r2")?.open();
  await tick(20);
  gates.get("r1")?.open();
  await tick(20);
  gates.get("r2")?.open();
  await tick(30);
  check(before === "r1" && given.join() === "r1,r2" && done.join() === "r1,r2", "two documents given the board: the second given once the first is shown: " + JSON.stringify({ before, given, done }));
}

// CORR-EB9-1: the remote's document asked for, then changed elsewhere before the answer came: the change kept, the old answer not taken
{
  const cache = memCache(), base = cleanDoc({ title: "base", nodes: [{ id: "n", title: "N" }] });
  await cache.put({ key: "k8", json: canonical(base), hash: await hashOf(base), remoteHash: await hashOf(base), at: 0 });
  const R = fakeRemote({ title: "r1", nodes: [{ id: "n", title: "N" }] });
  R.holds.load = held();
  const loadGate = R.holds.load;
  const store = cachedStore(R, "k8", cache);
  const shown = [];
  store.subscribe((d) => { shown.push(d.title); });
  await store.load();
  for (let k = 0; k < 50 && !R.calls.includes("load"); k++) await tick(10);
  R.change({ title: "r2", nodes: [{ id: "n", title: "N" }] });
  await tick(30);
  loadGate.open();
  await store.synced;
  await tick(50);
  const copyNow = JSON.parse(cache.m.get("k8").json).title;
  check(copyNow === "r2" && shown.at(-1) === "r2" && R.doc.title === "r2", "an answer asked for before a change made elsewhere came: not taken over it: " + JSON.stringify({ copy: copyNow, shown, remote: R.doc.title, calls: R.calls }));
}

// CORR-EB9-2: pages with no items or title, told apart by their intros; one put in front there, another made a slide here
{
  const A = { intro: "A", nodes: [] }, B = { intro: "B", nodes: [] }, X = { intro: "X", nodes: [] };
  const { doc: m, conflicts } = merge3(cleanDoc({ pages: [A, B] }), cleanDoc({ pages: [A, { ...B, slide: { x: 0, y: 0, w: 100, h: 100 } }] }), cleanDoc({ pages: [X, A, B] }));
  const pages = m.pages.map((p) => p.intro + (p.slide ? ":slide" : "")).join(",");
  check(pages === "X,A,B:slide" && !conflicts.length, "pages told apart by their intro: one put in front there, another made a slide here: each on its own page: " + pages + " " + JSON.stringify(conflicts));
}

// pages without ids: given ids by the store, in what the board is given, the copy and the remote
{
  const cache = memCache(), anon = cleanDoc({ pages: [{ title: "One", nodes: [{ id: "a" }] }, { title: "Two", nodes: [{ id: "b" }] }] });
  await cache.put({ key: "k9", json: canonical(anon), hash: await hashOf(anon), remoteHash: await hashOf(anon), at: 0 });
  const R = fakeRemote(anon);
  const store = cachedStore(R, "k9", cache);
  store.subscribe(() => {});
  const got = await store.load();
  await store.synced;
  await tick(50);
  const ids = got.doc.pages.map((p) => p.id), copyIds = JSON.parse(cache.m.get("k9").json).pages.map((p) => p.id), remoteIds = R.doc.pages.map((p) => p.id);
  check(ids.every((x) => typeof x === "string" && x) && new Set(ids).size === 2 && JSON.stringify(copyIds) === JSON.stringify(ids) && JSON.stringify(remoteIds) === JSON.stringify(ids), "pages without ids: given ids, the same in the board's, the copy's and the remote's: " + JSON.stringify({ ids, copyIds, remoteIds }));
}

// CORR-DB8-1: no copy, the remote's pages without ids: given ids, saved to the remote, the same everywhere
{
  const cache = memCache(), anon = { pages: [{ title: "One", nodes: [{ id: "a" }] }, { title: "Two", nodes: [{ id: "b" }] }] };
  const R = fakeRemote(anon);
  const store = cachedStore(R, "m1", cache);
  store.subscribe(() => {});
  const got = await store.load();
  const s1 = await store.synced;
  await tick(50);
  const e = cache.m.get("m1"), ids = got.doc.pages.map((p) => p.id), copyIds = JSON.parse(e.json).pages.map((p) => p.id), remoteIds = R.doc.pages.map((p) => p.id);
  check(s1 === "fresh" && ids.every(Boolean) && JSON.stringify(copyIds) === JSON.stringify(ids) && JSON.stringify(remoteIds) === JSON.stringify(ids) && R.saves === 1 && e.hash === e.remoteHash, "no copy, the remote's pages without ids: given ids, saved to the remote before anything else, the same everywhere: " + JSON.stringify({ s1, ids, copyIds, remoteIds, saves: R.saves, clean: e.hash === e.remoteHash }));
}

// CORR-DB8-2: the ids' save held, the remote changed meanwhile (compare-and-swap): the save refused, the migration from the new document, one page
{
  const cache = memCache(), old = { pages: [{ title: "One", nodes: [{ id: "a", title: "old" }] }] };
  await cache.put({ key: "m2", json: JSON.stringify(cleanDoc(old)), hash: await hashOf(old), remoteHash: await hashOf(old), at: 0 });
  const R = fakeRemote(old, { cas: true });
  R.holds.save = held();
  const saveGate = R.holds.save;
  const store = cachedStore(R, "m2", cache);
  store.subscribe(() => {});
  const loading = store.load();
  for (let k = 0; k < 50 && !R.calls.includes("save"); k++) await tick(10);
  R.change({ pages: [{ title: "One!", nodes: [{ id: "a", title: "new" }] }] });
  saveGate.open();
  const got = await loading;
  await store.synced;
  await tick(50);
  const pages = (d) => d.pages.map((p) => [p.id, p.title, p.nodes[0]?.title]);
  const copyP = pages(JSON.parse(cache.m.get("m2").json)), remoteP = pages(R.doc);
  check(got.doc.pages.length === 1 && got.doc.pages[0].title === "One!" && copyP.length === 1 && JSON.stringify(copyP) === JSON.stringify(remoteP) && copyP[0][2] === "new" && copyP[0][0], "the remote changed while the ids were being saved: refused, given ids again from the new document, one page everywhere: " + JSON.stringify({ got: pages(got.doc), copyP, remoteP, calls: R.calls }));
}
// CORR-DAF-2: a remote without compare-and-swap (a hash asked just before a save is not one): refused
{
  let err = "";
  try { cachedStore(fakeRemote(doc("x"), { cas: false }), "m3", memCache()); } catch (e) { err = String(e); }
  check(/compare-and-swap/.test(err), "a remote without compare-and-swap: the store refuses it: " + err);
}

// CORR-DB8-3: pages that tie (two the same): ours kept, and the conflict said; never a guess by place
{
  const S = { title: "Same", nodes: [] };
  const { doc: m, conflicts } = merge3(cleanDoc({ pages: [S, S] }), cleanDoc({ pages: [S, { ...S, slide: { x: 0, y: 0, w: 100, h: 100 } }] }), cleanDoc({ pages: [S, S, S] }));
  check(m.pages.length === 2 && !!m.pages[1].slide && conflicts.some((c) => c.field === "pages"), "pages that tie: ours kept, the conflict said: " + JSON.stringify({ pages: m.pages.map((p) => !!p.slide), conflicts }));
}

// after the migration, a document from elsewhere whose pages have no ids: given those of the pages they are; which is which cannot be told: ours kept, said
{
  const cache = memCache(), start = cleanDoc({ pages: [{ id: "p1", title: "One", nodes: [{ id: "a" }] }, { id: "p2", title: "Two", nodes: [{ id: "b" }] }] });
  await cache.put({ key: "m4", json: canonical(start), hash: await hashOf(start), remoteHash: await hashOf(start), at: 0 });
  const R = fakeRemote(start);
  const store = cachedStore(R, "m4", cache);
  const notes = [];
  store.subscribe((d, n) => { if (n) notes.push(n); });
  await store.load();
  await store.synced;
  R.change({ pages: [{ title: "Zero", nodes: [{ id: "z" }] }, { title: "One, edited", nodes: [{ id: "a" }] }, { title: "Two", nodes: [{ id: "b" }] }] });
  await tick(80);
  const after = JSON.parse(cache.m.get("m4").json).pages;
  check(after.length === 3 && after[1].id === "p1" && after[1].title === "One, edited" && after[2].id === "p2" && after[0].id && !["p1", "p2"].includes(after[0].id) && JSON.stringify(R.doc.pages.map((p) => p.id)) === JSON.stringify(after.map((p) => p.id)), "pages without ids from elsewhere: given the ids of the pages they are, a new one its own, the remote's too: " + JSON.stringify(after.map((p) => [p.id, p.title])));
  R.change({ pages: [{ title: "Dup", nodes: [] }, { title: "Dup", nodes: [] }] });
  await tick(80);
  const kept = JSON.parse(cache.m.get("m4").json).pages.map((p) => p.title).join();
  check(kept === after.map((p) => p.title).join() && notes.length === 1 && R.doc.pages.map((p) => p.title).join() === kept, "which page is which cannot be told: ours kept, said, and the remote's ours again: " + JSON.stringify({ kept, notes: notes.length, remote: R.doc.pages.map((p) => p.title) }));
}

// CORR-DAF-3: a match taken only if it is the one best both ways: A's best is p1 and B's p2, but p2's best is A: which is which cannot be told
{
  const items = (ids) => ids.split("").map((id) => ({ id }));
  const base = cleanDoc({ pages: [{ id: "p1", nodes: items("abcde") }, { id: "p2", nodes: items("abcduvw") }] });
  check(adopted(base, cleanDoc({ pages: [{ nodes: items("abcde") }, { nodes: items("uvw") }] })) === null, "A best matched to p1 and B to p2, but p2's best is A: not taken");
  const base2 = cleanDoc({ pages: [{ id: "p1", nodes: items("abcde") }, { id: "p2", nodes: items("uvwx") }] });
  const ok = adopted(base2, cleanDoc({ pages: [{ nodes: items("abcde") }, { nodes: items("uvw") }] }));
  check(JSON.stringify(ok?.pages.map((p) => p.id)) === '["p1","p2"]', "...and each the other's one best: taken: " + JSON.stringify(ok?.pages.map((p) => p.id)));
}

// CORR-DAF-4: the remote's document changes at every try to give its pages ids: opened, the newest with ids given here, not saved, "busy";
// then the next edit: refused once (changed again), the remote's newer merged, and the ids saved with it
{
  const cache = memCache();
  const R = fakeRemote({ pages: [{ title: "One", nodes: [{ id: "a", title: "v0" }] }] });
  let loads = 0, busy = true;
  const load0 = R.load;
  R.load = async () => { loads++; const d = await load0(); if (busy) R.doc = { pages: [{ title: "One", nodes: [{ id: "a", title: "v" + loads }] }] }; return d; };
  const store = cachedStore(R, "m5", cache, FAST);
  store.subscribe(() => {});
  let got = null, err = "";
  try { got = await store.load(); } catch (e) { err = String(e); }
  const s1 = await store.synced;
  const shownId = got?.doc.pages[0].id;
  check(!err && s1 === "busy" && loads === 11 && R.saves === 0 && !!shownId && got.doc.pages[0].nodes[0].title === "v10" && R.doc.pages[0].id === undefined, "the remote changing at every try: opened with the newest, its ids given here, not saved, and busy (not offline): " + JSON.stringify({ err, s1, loads, saves: R.saves, shownId, title: got?.doc.pages[0].nodes[0].title }));
  busy = false;
  const g0 = got?.doc.pages[0] ?? { nodes: [] };
  store.save(cleanDoc({ pages: [{ ...g0, nodes: [...g0.nodes, { id: "m", title: "mine" }] }] }));
  await tick(100);
  const rp = R.doc.pages, cp = JSON.parse(cache.m.get("m5")?.json ?? "{}").pages;
  check(rp.length === 1 && rp[0].id === shownId && rp[0].nodes.map((n) => n.title).join("+") === "v11+mine" && JSON.stringify(cp) === JSON.stringify(rp) && R.saves === 1, "...the next edit: the remote's newer merged, and saved with the ids by compare-and-swap: " + JSON.stringify({ remote: rp, copy: cp, saves: R.saves, calls: R.calls }));
}

// (and a change made elsewhere heard during the last try: not lost, though heard before the store was open: asked again, shown, the ids saved with it)
{
  const cache = memCache();
  const R = fakeRemote({ pages: [{ title: "One", nodes: [{ id: "a", title: "v0" }] }] });
  let loads = 0;
  const load0 = R.load;
  R.load = async () => {
    loads++;
    const d = await load0();
    if (loads < 11) R.doc = { pages: [{ title: "One", nodes: [{ id: "a", title: "v" + loads }] }] };
    // (heard before the load's answer: before the store is open)
    else if (loads === 11) R.change({ pages: [{ title: "One", nodes: [{ id: "a", title: "late" }] }] });
    return d;
  };
  const store = cachedStore(R, "m6", cache);
  const shown = [];
  store.subscribe((d) => { shown.push(d.pages[0].nodes[0].title); });
  const got = await store.load();
  const s1 = await store.synced;
  await tick(100);
  const cp = JSON.parse(cache.m.get("m6")?.json ?? "{}").pages;
  check(s1 === "busy" && shown.at(-1) === "late" && cp?.[0].nodes[0].title === "late" && R.doc.pages[0].id === got?.doc.pages[0].id && !!R.doc.pages[0].id, "busy, a change made elsewhere heard during the last try: shown, kept, and the ids saved with it: " + JSON.stringify({ s1, shown, copy: cp, remote: R.doc.pages, calls: R.calls }));
}

// CORR-6B0-1: a copy with an edit, the remote with no document; one made elsewhere while the copy's first save is on its way (no change event): refused (none expected), then the two merged
{
  const cache = memCache(), mine = cleanDoc({ title: "T", nodes: [{ id: "mine", title: "local" }] });
  await cache.put({ key: "x1", json: canonical(mine), hash: await hashOf(mine), remoteHash: null, at: 0 });
  const R = fakeRemote(null);
  R.holds.save = held();
  const saveGate = R.holds.save;
  const args = [];
  const save0 = R.save;
  R.save = (x, expected) => { args.push(expected); return save0(x, expected); };
  const store = cachedStore(R, "x1", cache, FAST);
  store.subscribe(() => {});
  await store.load();
  for (let k = 0; k < 50 && !R.calls.includes("save"); k++) await tick(10);
  R.doc = { title: "T", nodes: [{ id: "their", title: "their edit" }] };
  saveGate.open();
  await tick(200);
  const ids = (d) => d.nodes.map((n) => n.id).sort().join("+"), copyIds = ids(JSON.parse(cache.m.get("x1").json));
  check(args[0] === null && ids(R.doc) === "mine+their" && copyIds === "mine+their", "the remote with no document, one made elsewhere during the first save: refused (null expected: none), then merged, both kept: " + JSON.stringify({ args, remote: ids(R.doc), copy: copyIds }));
}

// PERF-6B0-2: the remote changing at every save: retried with a wait, then no more (busy, the copy kept); an edit, one more try; quiet, saved
{
  const cache = memCache(), base = cleanDoc(doc("base")), ours = cleanDoc(doc("ours"));
  await cache.put({ key: "x2", json: canonical(ours), hash: await hashOf(ours), remoteHash: await hashOf(base), base: canonical(base), at: 0 });
  const R = fakeRemote(base);
  let contend = true, attempts = 0, k = 0;
  const save0 = R.save;
  R.save = (x, expected) => { attempts++; if (contend) R.doc = { title: "T" + ++k, nodes: [{ id: "n", title: "base" }] }; return save0(x, expected); };
  const store = cachedStore(R, "x2", cache, { first: 5, max: 20, tries: 5 });
  store.subscribe(() => {});
  await store.load();
  await store.synced;
  await tick(400);
  const stopped = attempts;
  await tick(300);
  check(stopped === 5 && attempts === 5 && store.busy?.() && titleOf(cache.m.get("x2").json) === "ours", "the remote changing at every save: five tries, waits between, then no more; busy, the copy kept: " + JSON.stringify({ stopped, after: attempts, busy: store.busy?.(), copy: titleOf(cache.m.get("x2").json) }));
  store.save(cleanDoc({ ...JSON.parse(cache.m.get("x2").json), nodes: [{ id: "n", title: "ours again" }] }));
  await tick(300);
  check(attempts === 6 && store.busy?.(), "...an edit: one more try, refused, busy again: " + JSON.stringify({ attempts, busy: store.busy?.() }));
  contend = false;
  store.save(cleanDoc({ ...JSON.parse(cache.m.get("x2").json), nodes: [{ id: "n", title: "ours, quiet" }] }));
  await tick(300);
  check(!store.busy?.() && R.doc.nodes[0].title === "ours, quiet" && R.doc.title === JSON.parse(cache.m.get("x2").json).title, "...the remote quiet, an edit: saved, merged with the remote's last, not busy: " + JSON.stringify({ attempts, busy: store.busy?.(), remote: [R.doc.title, R.doc.nodes[0].title] }));
}

// CORR-67E-1: store A's save on its way; A closed (or not); store B opens the same copy, edits it, closes; then A's save lands: B's edit stays the copy, and reaches the remote
for (const closeA of [true, false]) {
  const cache = memCache(), base = cleanDoc(doc("base")), key = closeA ? "y1" : "y2";
  await cache.put({ key, json: canonical(base), hash: await hashOf(base), remoteHash: await hashOf(base), at: 0 });
  const R = fakeRemote(base);
  const A = cachedStore(R, key, cache, FAST);
  const offA = A.subscribe(() => {});
  await A.load();
  await A.synced;
  R.holds.save = held();
  const saveGate = R.holds.save;
  A.save(cleanDoc(doc("edit A")));
  for (let k = 0; k < 50 && !R.calls.includes("save"); k++) await tick(10);
  if (closeA) offA();
  R.holds.hash = held();
  const hashGate = R.holds.hash;
  const B = cachedStore(R, key, cache, FAST);
  const offB = B.subscribe(() => {});
  const got = await B.load();
  B.save(cleanDoc(doc("edit B")));
  await tick(30);
  offB();
  saveGate.open();
  await tick(80);
  const cached = titleOf(cache.m.get(key).json);
  hashGate.open();
  await tick(50);
  // (opened again: B's edit, kept, goes to the remote)
  const C = cachedStore(R, key, cache, FAST);
  C.subscribe(() => {});
  await C.load();
  await C.synced;
  await tick(100);
  check(got?.doc.nodes[0].title === "edit A" && cached === "edit B" && R.doc.nodes[0].title === "edit B" && titleOf(cache.m.get(key).json) === "edit B", `store A's save landing after store B's edit (A ${closeA ? "closed" : "still open"}): B's edit stays the copy, and reaches the remote: ` + JSON.stringify({ bOpened: got?.doc.nodes[0].title, cached, remote: R.doc.nodes[0].title, after: titleOf(cache.m.get(key).json) }));
}

// PERF-67E-2: stopped (busy); an edit asks the remote (its answer held); a second edit meanwhile; the remote quiet, the answer let go: the latest edit, merged, saved
{
  const cache = memCache(), base = cleanDoc(doc("base")), ours = cleanDoc(doc("ours"));
  await cache.put({ key: "y3", json: canonical(ours), hash: await hashOf(ours), remoteHash: await hashOf(base), base: canonical(base), at: 0 });
  const R = fakeRemote(base);
  let contend = true, attempts = 0, k = 0;
  const save0 = R.save;
  R.save = (x, expected) => { attempts++; if (contend) R.doc = { title: "T" + ++k, nodes: [{ id: "n", title: "base" }] }; return save0(x, expected); };
  const store = cachedStore(R, "y3", cache, { first: 1, max: 1, tries: 2 });
  store.subscribe(() => {});
  await store.load();
  await store.synced;
  await tick(100);
  const stoppedAt = attempts, wasBusy = store.busy?.();
  contend = false;
  R.holds.hash = held();
  const hashGate = R.holds.hash;
  store.save(cleanDoc({ ...JSON.parse(cache.m.get("y3").json), nodes: [{ id: "n", title: "edit A" }] }));
  await tick(30);
  store.save(cleanDoc({ ...JSON.parse(cache.m.get("y3").json), nodes: [{ id: "n", title: "edit B" }] }));
  await tick(30);
  hashGate.open();
  await tick(150);
  check(stoppedAt === 2 && wasBusy && !store.busy?.() && R.doc.nodes[0].title === "edit B" && R.doc.title === "T" + k && titleOf(cache.m.get("y3").json) === "edit B", "stopped, then two edits as the remote is asked: the latest, merged with the remote's newer document, saved once it answers: " + JSON.stringify({ stoppedAt, wasBusy, busy: store.busy?.(), attempts, remote: [R.doc.title, R.doc.nodes[0].title], cached: titleOf(cache.m.get("y3").json) }));
}

// CORR-1EC-1: this store's writes of an edit refused twelve times running (another store writing the copy each time): never dropped; busy meanwhile; written on closing (or after a wait), and there when opened again
for (const closeAtOnce of [true, false]) {
  const cache = memCache(), base = cleanDoc(doc("base")), key = closeAtOnce ? "z1" : "z2";
  await cache.put({ key, json: canonical(base), hash: await hashOf(base), remoteHash: await hashOf(base), at: 0 });
  // (when each refusal came; the tenth's, awaited: not a fixed wait, which a
  // loaded machine outlasts)
  let refusals = 0, tenth;
  const at = [], tenthSeen = new Promise((r) => (tenth = r));
  const put0 = cache.put;
  cache.put = async (c, expected) => {
    if (expected !== undefined && refusals < 12) {
      // (another store writes the copy: the board's title, the next version)
      refusals++;
      at.push(Date.now());
      if (refusals === 10) tenth();
      const cur = cache.m.get(c.key), o = cleanDoc({ title: "other " + refusals, nodes: [{ id: "n", title: "base" }] });
      cache.m.set(c.key, { ...cur, json: canonical(o), hash: await hashOf(o), v: (cur.v ?? 0) + 1 });
      return false;
    }
    return put0(c, expected);
  };
  const R = fakeRemote(base);
  R.holds.hash = held();
  const store = cachedStore(R, key, cache, FAST);
  const off = store.subscribe(() => {});
  await store.load();
  store.save(cleanDoc({ title: "T", nodes: [{ id: "n", title: "LOCAL" }] }));
  await Promise.race([tenthSeen, tick(10000)]);
  const first = { refusals, busy: store.busy(), cached: titleOf(cache.m.get(key).json) };
  if (closeAtOnce) off();
  // (written: on closing, or after the wait; left open, the eleventh try only after that wait, 50 ms)
  for (const t0 = Date.now(); titleOf(cache.m.get(key).json) !== "LOCAL" && Date.now() - t0 < 10000; ) await tick(5);
  if (!closeAtOnce) off();
  if (!closeAtOnce) first.waited = at.length > 10 && at[10] - at[9] >= 45;
  const again = cachedStore(fakeRemote(base), key, cache, FAST);
  const got = await again.load();
  check(first.refusals === 10 && first.busy && first.cached === "base" && first.waited !== false && got?.doc.nodes[0].title === "LOCAL" && got.doc.title === "other 12", `an edit whose writes are refused more than ten times (${closeAtOnce ? "closed at once" : "left open"}): busy, kept, written ${closeAtOnce ? "on closing" : "after a wait"}, there when opened again: ` + JSON.stringify({ first, refusals, reopened: got && [got.doc.title, got.doc.nodes[0].title] }));
}

// This browser's copy whose database never opens (an IndexedDB open with no
// answer at all, as behind another page's upgrade, web/board/idb-open.ts):
// the board opens from the remote within the open's bound, and says so; an
// edit goes to the remote, the copy failing at once (board-doccache-bounded)
{
  const realIdb = globalThis.indexedDB;
  globalThis.indexedDB = { open: () => ({}) }; // (a request that never answers)
  try {
    const cache = new IdbDocCache("stalled", 200, 100), R = fakeRemote(doc("saved"));
    const t0 = Date.now(), store = cachedStore(R, "k-stall", cache, FAST);
    const got = await store.load(), took = Date.now() - t0;
    check(got?.doc.nodes[0].title === "saved" && got.notice === COPY_UNAVAILABLE && took < 2000, `a copy whose database never opens: the remote's, within the bound, said (${took} ms): ` + JSON.stringify(got && [got.doc.nodes[0].title, got.notice]));
    const t1 = Date.now();
    store.save(cleanDoc(doc("edited")));
    for (let i = 0; i < 50 && R.doc.nodes[0].title !== "edited"; i++) await tick(10);
    check(R.doc.nodes[0].title === "edited" && !store.busy() && Date.now() - t1 < 1000, "...an edit goes to the remote, at once, the copy failing at once: " + JSON.stringify([R.doc.nodes[0].title, store.busy(), Date.now() - t1]));
  } finally {
    globalThis.indexedDB = realIdb;
  }
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
