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
// pages without ids arriving later get the ids of the pages they are.
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
const fakeRemote = (d, o = {}) => {
  const r = { doc: d && copy(d), calls: [], holds: {}, fs: new Set(), saves: 0, cas: !!o.cas };
  const gate = async (name) => { r.calls.push(name); const h = r.holds[name]; if (h) { delete r.holds[name]; await h.p; } };
  // (the hash of the document it has when asked, answered when let go)
  r.hash = async () => { const h = r.doc ? await hashOf(r.doc) : null; await gate("hash"); return h; };
  r.load = async () => { const d0 = r.doc && copy(r.doc); await gate("load"); return d0; };
  // (with cas: only over the document whose hash it is given, as it is when the save is done)
  r.save = async (x, ifHash) => { await gate("save"); if (r.cas && ifHash && (r.doc ? await hashOf(r.doc) : null) !== ifHash) return false; r.doc = copy(x); r.saves++; };
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
  const store = cachedStore(R, "k6", cache);
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
// (a remote without compare-and-swap: changed before the save, its hash asked just before: the same)
{
  const cache = memCache(), old = { pages: [{ title: "One", nodes: [{ id: "a", title: "old" }] }] };
  const R = fakeRemote(old);
  R.holds.load = held();
  const loadGate = R.holds.load;
  const store = cachedStore(R, "m3", cache);
  store.subscribe(() => {});
  const loading = store.load();
  for (let k = 0; k < 50 && !R.calls.includes("load"); k++) await tick(10);
  R.change({ pages: [{ title: "One!", nodes: [{ id: "a", title: "new" }] }] });
  loadGate.open();
  const got = await loading;
  await store.synced;
  await tick(50);
  check(got.doc.pages.length === 1 && got.doc.pages[0].title === "One!" && R.doc.pages.length === 1 && R.doc.pages[0].id === got.doc.pages[0].id && R.saves === 1, "a remote without compare-and-swap, changed before the save: its hash asked just before, the ids given again from the new document: " + JSON.stringify({ got: got.doc.pages.map((p) => [p.id, p.title]), remote: R.doc.pages.map((p) => [p.id, p.title]), saves: R.saves, calls: R.calls }));
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

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
