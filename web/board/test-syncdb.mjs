// A board kept in a CoCalc syncdb (syncdb.ts; design/board-cocalc-adapter.md),
// deterministically, over replicas of real patchflow sessions (the records of
// history.ts, its codec with a records merge3 written from CoCalc's
// documented rules, @cocalc/sync/editor/db/merge3.ts), each browser's
// replica joined to the others by a transport whose delivery to it can be
// held.  Both designs: the syncdb as cachedStore's remote (syncdbRemote,
// compare-and-swap) and the syncdb as the merge (syncdbStore).
//   bun web/board/test-syncdb.mjs
import { EventEmitter } from "node:events";
import { Session, createImmerDbCodec, mergeStrings3 } from "patchflow";
import { canonical, cleanDoc } from "./doc.ts";
import { SCHEMA } from "./history.ts";
import { cachedStore } from "./cached.ts";
import { boardOf, jsonl, syncdbRemote, syncdbStore } from "./syncdb.ts";
import { docHash } from "./cached.ts";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const tick = (n = 10) => new Promise((r) => setTimeout(r, n));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(10); };
const copy = (x) => JSON.parse(JSON.stringify(x));
// (put as IdbDocCache's: only over the version expected; the tests' own, without one, as they are)
const memCache = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? { ...m.get(k) } : null), put: async (c, expected) => { const cur = m.get(c.key), v = cur ? cur.v ?? 0 : null; if (expected !== undefined && v !== expected) return false; m.set(c.key, { ...c, v: (v ?? 0) + 1 }); return true; } }; };

// ---- a records merge3, from CoCalc's documented rules -----------------------
// (fields merged one by one: changed on one side, that side's; on both,
// strings merged as text, maps key by key, else the later side's; a record
// deleted on one side and edited on the other stays deleted, unless its
// text was edited: then kept whole)
const STRING = new Set(SCHEMA.stringCols), KEYS = SCHEMA.primaryKeys;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
function mergeValue(base, a, b, isString) {
  if (eq(a, b)) return a;
  if (eq(base, a)) return b;
  if (eq(base, b)) return a;
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (isString && typeof a === "string" && typeof b === "string") return mergeStrings3({ base: typeof base === "string" ? base : "", a, b });
  if (plain(a) && plain(b)) return mergeFields(plain(base) ? base : {}, a, b, false);
  return b;
}
function mergeFields(base, a, b, top = true) {
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(a), ...Object.keys(b)])) {
    const v = mergeValue(base[k], a[k], b[k], top && STRING.has(k));
    if (v !== undefined) out[k] = v;
  }
  return out;
}
const textChanged = (from, to) => [...STRING].some((k) => typeof to[k] === "string" && to[k] !== from[k]);
const lines = (s) => new Map(s.split("\n").filter((l) => l.trim()).map((l) => { const r = JSON.parse(l); return [JSON.stringify(KEYS.map((k) => r[k] ?? null)), r]; }));
function recordsMerge3(baseS, aS, bS) {
  const B = lines(baseS), A = lines(aS), C = lines(bS), out = [];
  for (const k of new Set([...B.keys(), ...A.keys(), ...C.keys()])) {
    const b = B.get(k), a = A.get(k), c = C.get(k);
    let r;
    if (a && c) r = mergeFields(b ?? {}, a, c);
    else if (!a && !c) r = undefined;
    else {
      const there = a ?? c;
      // (added on one side; or deleted on one side: unless the other edited its text, deleted)
      r = !b ? there : eq(b, there) ? undefined : textChanged(b, there) ? there : undefined;
    }
    if (r) out.push(JSON.stringify(r));
  }
  return out.join("\n");
}
const base = createImmerDbCodec(SCHEMA);
const codec = { ...base, merge3: (b, a, c) => base.fromString(recordsMerge3(base.toString(b), base.toString(a), base.toString(c))) };

// ---- the replicas, and the transport between them ---------------------------
class Hub {
  log = [];
  reps = new Map();
  t = 0;
  clock = () => (this.t += 10);
  store(name) {
    const r = { fs: [], held: false, queue: [] };
    this.reps.set(name, r);
    return {
      loadInitial: async () => ({ patches: this.log.slice() }),
      append: (env) => { this.log.push(env); for (const [n, o] of this.reps) if (n !== name) this.deliver(o, env); },
      subscribe: (f) => { r.fs.push(f); return () => { r.fs = r.fs.filter((g) => g !== f); }; },
    };
  }
  deliver(o, env) { if (o.held) o.queue.push(env); else for (const f of o.fs) f(env); }
  hold(...names) { for (const n of names) this.reps.get(n).held = true; }
  release(...names) { for (const n of names) { const o = this.reps.get(n); o.held = false; for (const env of o.queue.splice(0)) for (const f of o.fs) f(env); } }
}
// a replica, by the names CoCalc's SyncDB uses (syncdb.ts's SyncDbLike)
let users = 0;
class FakeSyncDb extends EventEmitter {
  constructor(hub, name) { super(); this.hub = hub; this.name = name; this.ready = new Promise((r) => (this.go = r)); this.user = ++users; }
  async start() {
    this.session = new Session({ codec, patchStore: this.hub.store(this.name), clock: this.hub.clock, userId: this.user, clientId: this.name });
    await this.session.init();
    this.session.on("change", () => this.emit("change"));
    this.go();
  }
  isReady() { return !!this.session; }
  wait_until_ready() { return this.ready; }
  to_str() { return codec.toString(this.session.getDocument()); }
  from_str(value, opts) { this.draft = value; this.draftBase = opts?.base; }
  commit() {
    if (this.draft == null) return false;
    const committed = this.session.getCommittedDocument(), draft = this.draft, b = this.draftBase;
    this.draft = this.draftBase = undefined;
    const next = b != null ? codec.merge3(codec.fromString(b), codec.fromString(draft), committed) : codec.fromString(draft);
    if (codec.toString(next) === codec.toString(committed)) return false;
    this.session.commit(next);
    return true;
  }
}
const replica = async (hub, name) => { const db = new FakeSyncDb(hub, name); await db.start(); return db; };
// the project: what it loads from the file is the syncdb's first document
const loadFile = (db, d) => { db.from_str(jsonl(cleanDoc(d))); db.commit(); };

// a board: what it shows, its edits made from that
function board(store) {
  const b = { view: null, shown: [] };
  store.subscribe((d) => { b.view = d; b.shown.push(d); });
  b.open = async () => { const r = await store.load(); if (r) b.view = r.doc; return r; };
  b.edit = (f) => { const d = copy(b.view); f(d); const c = cleanDoc(d); b.view = c; store.save(c); };
  return b;
}
const FAST = { first: 5, max: 40, tries: 8 };
const designs = {
  remote: (db, key) => cachedStore(syncdbRemote(db), key, memCache(), FAST),
  merge: (db, key) => syncdbStore(db, key, memCache()),
};
const note = (d, id) => d.nodes.find((n) => n.id === id);
const start = () => cleanDoc({ title: "B", nodes: [{ id: "n1", title: "One", text: "hello world", x: 0, y: 0 }, { id: "n2", title: "Two", text: "second", x: 400, y: 0 }] });
// every replica the same, and every board shows it
async function converged(dbs, boards) {
  await settle();
  const s = dbs.map((d) => canonical(boardOf(d)));
  return s.every((x) => x === s[0]) && boards.every((b) => canonical(b.view) === s[0]) ? JSON.parse(s[0]) : null;
}

const report = {};
for (const [name, make] of Object.entries(designs)) {
  // two browsers edit different items at once (each one's patch held from the other)
  {
    const hub = new Hub(), project = await replica(hub, "project");
    loadFile(project, start());
    const db1 = await replica(hub, "b1"), db2 = await replica(hub, "b2");
    const A = board(make(db1, "k")), B = board(make(db2, "k"));
    await A.open(); await B.open(); await settle();
    hub.hold("b1", "b2");
    A.edit((d) => { note(d, "n1").x = 100; });
    B.edit((d) => { note(d, "n2").title = "Two!"; });
    await settle();
    hub.release("b1", "b2");
    const c = await converged([project, db1, db2], [A, B]);
    check(!!c && note(c, "n1").x === 100 && note(c, "n2").title === "Two!", `${name}: two browsers edit different items at once: both kept, everywhere: ` + JSON.stringify(c?.nodes));
  }
  // both type in one note's text at once
  {
    const hub = new Hub(), project = await replica(hub, "project");
    loadFile(project, start());
    const db1 = await replica(hub, "b1"), db2 = await replica(hub, "b2");
    const A = board(make(db1, "k")), B = board(make(db2, "k"));
    await A.open(); await B.open(); await settle();
    hub.hold("b1", "b2");
    A.edit((d) => { note(d, "n1").text = "hello brave world"; });
    B.edit((d) => { note(d, "n1").text = "hello world!"; });
    await settle();
    hub.release("b1", "b2");
    const c = await converged([project, db1, db2], [A, B]);
    report[name + " typing"] = c && note(c, "n1").text;
    check(!!c && note(c, "n1").text === "hello brave world!", `${name}: both type in one note at once: both typings kept, everywhere: ` + JSON.stringify(c && note(c, "n1").text));
  }
  // a change from elsewhere reaches this browser's replica just as it edits the same note's text (from the document it showed)
  {
    const hub = new Hub(), project = await replica(hub, "project");
    loadFile(project, start());
    const db1 = await replica(hub, "b1"), db2 = await replica(hub, "b2");
    const A = board(make(db1, "k")), B = board(make(db2, "k"));
    await A.open(); await B.open(); await settle();
    hub.hold("b1");
    B.edit((d) => { note(d, "n1").text = "hello world!"; });
    await settle();
    hub.release("b1");
    A.edit((d) => { note(d, "n1").text = "hello brave world"; });
    const c = await converged([project, db1, db2], [A, B]);
    report[name + " typing, arriving"] = c && note(c, "n1").text;
    // (the syncdb as the merge: both kept; as cachedStore's remote: the store's merge3 keeps ours, the field whole: the outcome, for the design note)
    // (the design note's table, asserted: the syncdb as the merge keeps both; cachedStore's merge3 keeps ours, the field whole, theirs lost, TEST-DC9-3)
    if (name === "merge") check(!!c && note(c, "n1").text === "hello brave world!", `${name}: typing as another's typing in the same note arrives: both kept: ` + JSON.stringify(c && note(c, "n1").text));
    else check(!!c && note(c, "n1").text === "hello brave world", `${name}: typing as another's typing in the same note arrives: ours, theirs lost (the note's table), everywhere: ` + JSON.stringify(c && note(c, "n1").text));
  }
  // a delete from elsewhere reaches this browser's replica just as it moves the note (from the document it showed)
  {
    const hub = new Hub(), project = await replica(hub, "project");
    loadFile(project, start());
    const db1 = await replica(hub, "b1"), db2 = await replica(hub, "b2");
    const A = board(make(db1, "k")), B = board(make(db2, "k"));
    await A.open(); await B.open(); await settle();
    hub.hold("b1");
    B.edit((d) => { d.nodes = d.nodes.filter((n) => n.id !== "n1"); });
    await settle();
    hub.release("b1");
    A.edit((d) => { note(d, "n1").x = 999; });
    const c = await converged([project, db1, db2], [A, B]);
    const n1 = c && note(c, "n1");
    report[name + " delete arriving/moves"] = c ? (n1 ? n1 : "deleted") : "not converged";
    if (name === "merge") check(!!c && !n1, `${name}: a delete arrives as this browser moves the note: deleted, everywhere (CoCalc's rule): ` + JSON.stringify(report[name + " delete arriving/moves"]));
    else check(!!c && n1?.x === 999 && n1.title === "One" && n1.text === "hello world" && n1.y === 0, `${name}: a delete arrives as this browser moves the note: brought back, moved, whole (the note's table), everywhere: ` + JSON.stringify(report[name + " delete arriving/moves"]));
  }
  // one browser deletes an item as the other moves it; then deletes one as the other types in it
  for (const [what, edit, kept] of [["moves", (n) => { n.x = 999; }, false], ["types in", (n) => { n.text = "hello world, typed"; }, true]]) {
    const hub = new Hub(), project = await replica(hub, "project");
    loadFile(project, start());
    const db1 = await replica(hub, "b1"), db2 = await replica(hub, "b2");
    const A = board(make(db1, "k")), B = board(make(db2, "k"));
    await A.open(); await B.open(); await settle();
    hub.hold("b1", "b2");
    A.edit((d) => { d.nodes = d.nodes.filter((n) => n.id !== "n1"); });
    B.edit((d) => edit(note(d, "n1")));
    await settle();
    hub.release("b1", "b2");
    const c = await converged([project, db1, db2], [A, B]);
    const n1 = c && note(c, "n1");
    report[`${name} delete/${what}`] = c ? (n1 ? n1 : "deleted") : "not converged";
    const whole = n1 && n1.title === "One" && n1.y === 0 && typeof n1.x === "number";
    check(!!c && (kept ? whole && n1.text === "hello world, typed" : !n1), `${name}: one deletes a note as the other ${what} it: ${kept ? "kept whole, with the typing" : "deleted"}, everywhere, no part of a record left: ` + JSON.stringify(report[`${name} delete/${what}`]));
  }
}

// syncdbStore: the copy shown at once, before the syncdb is open; then the syncdb's document
{
  const hub = new Hub(), project = await replica(hub, "project");
  loadFile(project, start());
  const cache = memCache(), old = start();
  note(old, "n2").title = "Two (old copy)";
  await cache.put({ key: "k", json: canonical(old), hash: "x", remoteHash: "x", at: 0 });
  const db1 = new FakeSyncDb(hub, "b1");
  const store = syncdbStore(db1, "k", cache), A = board(store);
  const r = await A.open();
  const first = r?.doc && note(r.doc, "n2").title;
  await db1.start();
  await store.opened;
  await settle();
  check(first === "Two (old copy)" && note(A.view, "n2").title === "Two" && A.shown.length === 1, "the copy shown at once, before the syncdb is open; then the syncdb's document, once: " + JSON.stringify({ first, now: note(A.view, "n2").title, shown: A.shown.length }));
}
// syncdbStore: an edit made before the syncdb is open, and a change made elsewhere meanwhile: both
{
  const hub = new Hub(), project = await replica(hub, "project");
  loadFile(project, start());
  const cache = memCache(), s = start();
  await cache.put({ key: "k", json: canonical(s), hash: "x", remoteHash: "x", at: 0 });
  const db1 = new FakeSyncDb(hub, "b1");
  const store = syncdbStore(db1, "k", cache), A = board(store);
  await A.open();
  A.edit((d) => { note(d, "n1").x = 55; });
  await settle();
  // (elsewhere meanwhile: another note retitled)
  const other = await replica(hub, "b2");
  other.from_str(jsonl({ ...s, nodes: s.nodes.map((n) => (n.id === "n2" ? { ...n, title: "Two, elsewhere" } : n)) }), { base: jsonl(s) });
  other.commit();
  await db1.start();
  await store.opened;
  const c = await converged([project, db1, other], [A]);
  check(!!c && note(c, "n1").x === 55 && note(c, "n2").title === "Two, elsewhere", "an edit made before the syncdb is open, and a change elsewhere meanwhile: both, everywhere: " + JSON.stringify(c?.nodes.map((n) => [n.id, n.x, n.title])));
}
// syncdbStore: an edit made before the syncdb is open and a change elsewhere meanwhile, to the same note's place: the syncdb's rule, the later side's (the change elsewhere, already committed)
{
  const hub = new Hub(), project = await replica(hub, "project");
  loadFile(project, start());
  const cache = memCache(), s = start();
  await cache.put({ key: "k", json: canonical(s), hash: "x", remoteHash: "x", at: 0 });
  const db1 = new FakeSyncDb(hub, "b1");
  const store = syncdbStore(db1, "k", cache), A = board(store);
  await A.open();
  A.edit((d) => { note(d, "n1").x = 55; });
  await settle();
  const other = await replica(hub, "b2");
  other.from_str(jsonl({ ...s, nodes: s.nodes.map((n) => (n.id === "n1" ? { ...n, x: 77 } : n)) }), { base: jsonl(s) });
  other.commit();
  await db1.start();
  await store.opened;
  const c = await converged([project, db1, other], [A]);
  check(!!c && note(c, "n1").x === 77, "an edit made before the syncdb is open and a change elsewhere to the same field: the change elsewhere (CoCalc's rule: the later side), everywhere: " + JSON.stringify(c && note(c, "n1")));
}
// an agent rewrites the file: the project's replica takes it (the records that differ), as a browser edits another note
{
  const hub = new Hub(), project = await replica(hub, "project");
  loadFile(project, start());
  const db1 = await replica(hub, "b1"), A = board(syncdbStore(db1, "k", memCache()));
  await A.open(); await settle();
  hub.hold("project");
  A.edit((d) => { note(d, "n2").x = 444; });
  await settle();
  const file = start();
  note(file, "n1").title = "One, by an agent";
  project.from_str(jsonl(file));
  project.commit();
  hub.release("project");
  const c = await converged([project, db1], [A]);
  check(!!c && note(c, "n1").title === "One, by an agent" && note(c, "n2").x === 444, "an agent rewrites the file as a browser moves another note: both, everywhere: " + JSON.stringify(c?.nodes.map((n) => [n.id, n.x, n.title])));
}

// CORR-B5C-1: a copy with an edit made before the syncdb opened; the syncdb ready at once, the copy's reading held: the edit is not passed over, but written into the syncdb
{
  const hub = new Hub(), project = await replica(hub, "project");
  loadFile(project, start());
  const cache = memCache(), s = start(), mine = start();
  note(mine, "n1").x = 55;
  await cache.put({ key: "k", json: canonical(mine), hash: await docHash(mine), remoteHash: await docHash(s), base: canonical(s), at: 0 });
  const db1 = await replica(hub, "b1");
  let release;
  const gate = new Promise((r) => (release = r)), get0 = cache.get;
  cache.get = async (k) => { await gate; return get0(k); };
  const store = syncdbStore(db1, "k", cache), A = board(store);
  const opening = A.open();
  await settle();
  release();
  const r = await opening;
  await store.opened;
  const c = await converged([project, db1], [A]);
  check(r?.doc && note(r.doc, "n1").x === 55 && !!c && note(c, "n1").x === 55 && note(JSON.parse(cache.m.get("k").json), "n1").x === 55, "the syncdb ready before the copy is read: the copy's edit written into it, everywhere, and kept: " + JSON.stringify({ loaded: r?.doc && note(r.doc, "n1").x, now: c && note(c, "n1").x, cache: note(JSON.parse(cache.m.get("k").json), "n1").x }));
}
// CORR-78A-2: before the syncdb opens, this store's edit and another store's (each its own note), the other's written to the copy just as this one's is: both, in the syncdb and the copy
{
  const hub = new Hub(), project = await replica(hub, "project");
  loadFile(project, start());
  const cache = memCache(), s = start();
  await cache.put({ key: "k", json: canonical(s), hash: await docHash(s), remoteHash: await docHash(s), at: 0 });
  let raced = false;
  const put0 = cache.put;
  cache.put = async (c, expected) => {
    if (expected !== undefined && !raced) {
      raced = true;
      // (another store, before it too is open: the second note retitled, written first)
      const other = start();
      note(other, "n2").title = "OTHER";
      const cur = cache.m.get("k");
      cache.m.set("k", { ...cur, json: canonical(other), hash: await docHash(other), base: canonical(s), v: (cur.v ?? 0) + 1 });
      return false;
    }
    return put0(c, expected);
  };
  const db1 = new FakeSyncDb(hub, "b1");
  const store = syncdbStore(db1, "k", cache), A = board(store);
  await A.open();
  A.edit((d) => { note(d, "n1").title = "LOCAL"; });
  await settle();
  await db1.start();
  await store.opened;
  const c = await converged([project, db1], [A]), copy = JSON.parse(cache.m.get("k").json);
  check(raced && !!c && note(c, "n1").title === "LOCAL" && note(c, "n2").title === "OTHER" && note(copy, "n1").title === "LOCAL" && note(copy, "n2").title === "OTHER", "two stores' edits before the syncdb opens, the other's written to the copy just as this one's: both, in the syncdb and the copy: " + JSON.stringify({ raced, syncdb: c?.nodes.map((n) => n.title), copy: copy.nodes.map((n) => n.title) }));
}
// CORR-B5C-2: the replica read A, then B, then A again: a save expecting B's hash is refused (what is hashed is what is compared and written over)
{
  const doc = (t) => cleanDoc({ title: t, nodes: [{ id: "n", title: t }] });
  const A = jsonl(doc("A")), B = jsonl(doc("B"));
  // (read A, B, A expecting B: daybreak's; read A, then B, expecting A: changed between the hash and the write)
  for (const [seq, want] of [[[A, B, A], "B"], [[A, B], "A"]]) {
    let i = 0, writes = 0;
    const fake = { isReady: () => true, wait_until_ready: async () => {}, to_str: () => seq[Math.min(i++, seq.length - 1)], from_str: () => { writes++; }, commit: () => true, on() {}, removeListener() {} };
    // (the hash of the board as the replica holds it, read back from its lines)
    const ok = await syncdbRemote(fake).save(doc("C"), await docHash(boardOf({ to_str: () => (want === "A" ? A : B) })));
    check(ok === false && writes === 0, `the replica read ${seq.map((x) => (x === A ? "A" : "B")).join(", ")}: a save expecting ${want} refused, nothing written: ` + JSON.stringify({ ok, writes }));
  }
}

console.log("outcomes:", JSON.stringify(report));
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
