// The cases of web/workspace/test-workspace-sync-d11.mjs (design/sync-client.md D11, plan-pr65-d11-chunked-moves r7 and
// its r8 notes): large moves applied in chunks, on small trees (D11.chunk and D11.page set to 10), each compared with
// the same change made the old way (one transaction: D11.chunk set past the tree's size) in a workspace of its own.
import * as W from "./ws.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
let n = 0;
const names = () => { n++; return { name: `ws-d11-${n}-${Math.random().toString(36).slice(2, 8)}`, mainName: `main-d11-${n}` }; };
const J = (x) => JSON.stringify(x);
const OTHER = "fedcba9876543210";
const hex = (k) => [...crypto.getRandomValues(new Uint8Array(k / 2))].map((b) => b.toString(16).padStart(2, "0")).join("");
const SHA = (c) => c.repeat(64).slice(0, 64);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SMALL = { ...W.D11, chunk: 10, page: 10, planPage: 100, validatePage: 10, backoffMin: 10, backoffMax: 20, fails: 10, deadlineMs: 900_000 };
const OLD = { ...SMALL, chunk: 1000 };

/** An entry's fields that a move decides (not its times, which each run takes from its own clock). */
const shape = (e, ids = false) => J({ path: e.path, kind: e.kind, ...(ids ? { ident: e.ident ?? null, fid: e.fid ?? null } : {}), ref: e.ref ?? null, nkey: e.nkey ?? null, size: e.size ?? null, sha256: e.sha256 ?? null, trashed: e.trashed ? e.trashed.from : null, remote: !!e.remote });
const tree = async (w) => (await w.list("/", { recursive: true })).map((e) => shape(e)).sort();
/** What differs between two trees (a check's message). */
const diff = (a, b) => { const A = new Set(a), B = new Set(b); return J({ only: a.filter((x) => !B.has(x)).slice(0, 3), want: b.filter((x) => !A.has(x)).slice(0, 3) }); };
const raw = (db, store) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const byKey = ([x], [y]) => (x < y ? -1 : x > y ? 1 : 0);
/** Every identity's path (CORR-D11-IMPL-3: the settled result compared identity by identity, not by shape alone). */
const identities = async (w) => Object.fromEntries((await raw(w.ws, "entries")).filter((e) => e.ident && e.path.startsWith("/")).map((e) => [e.ident, e.path]).sort(byKey));
/** The identities two maps put in different places: [identity, one's path, the other's] (a check's message). */
const idDiff = (a, b) => J([...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).slice(0, 4).map((k) => [k.slice(0, 6), a[k] ?? null, b[k] ?? null]));
/** The paths of a tree (shapes) whose folder isn't a folder in it (none: every entry reachable by folder listings). */
const orphans = (t) => {
  const kinds = new Map(t.map((x) => JSON.parse(x)).map((e) => [e.path, e.kind]));
  return [...kinds.keys()].filter((p) => { const f = p.slice(0, p.lastIndexOf("/")) || "/"; return f !== "/" && f !== "/Trash" && kinds.get(f) !== "folder"; });
};

// ---- (LIMIT-D11-IMPL-1/2/3) IndexedDB's requests (reads and writes) and the rows its reads return, counted at the
// browser's own API (not by the replay's meter): every request of each closure or validation transaction, from its first
// to its last (the transaction named as it begins)

const probe = { txs: [], by: new Map() };
let probed = false;
const WRITES = new Set(["put", "add", "delete", "clear"]);
function probeIDB() {
  if (probed) return;
  probed = true;
  for (const P of [IDBObjectStore.prototype, IDBIndex.prototype]) for (const k of ["get", "getAll", "getAllKeys", "getKey", "count", "openCursor", "openKeyCursor", "put", "add", "delete", "clear"]) {
    const f = P[k];
    if (typeof f !== "function") continue;
    P[k] = function (...a) {
      const r = f.apply(this, a);
      const cur = probe.by.get(r.transaction);
      if (cur && WRITES.has(k)) cur.writes++;
      else if (cur) {
        cur.req++;
        r.addEventListener("success", () => { const v = r.result; cur.rows += k === "get" ? (v === undefined ? 0 : 1) : Array.isArray(v) ? v.length : k.startsWith("open") && v ? 1 : 0; });
      }
      return r;
    };
  }
}
/** The probe on: each closure and validation transaction's requests, [{ phase, req, rows, writes }] */
function startProbe() {
  probeIDB();
  probe.txs = [];
  probe.by = new Map();
  W.REPLAY.reads = (at, phase, tx) => {
    if (at !== "begin") return;
    const cur = { phase, req: 0, rows: 0, writes: 0 };
    probe.txs.push(cur);
    probe.by.set(tx, cur);
  };
}
const stopProbe = () => { W.REPLAY.reads = null; probe.by = new Map(); return probe.txs; };
const sum = (txs, k, phase = "close") => txs.filter((t) => t.phase === phase).reduce((a, t) => a + t[k], 0);

// ---- the local workspace's own large move

/** A folder /big of `n` files in a few subfolders. */
async function bigTree(w, n = 30) {
  await w.mkdir("/big/s1");
  await w.mkdir("/big/s2/deep");
  for (let i = 0; i < n; i++) await w.create(`/big/${["s1", "s2", "s2/deep"][i % 3]}/f${i}.txt`, { content: `x${i}` });
}

async function localLarge() {
  W.configureD11(SMALL);
  const w = await W.Workspace.open(names());
  await bigTree(w);
  // (the oracle: the same move made in one transaction)
  W.configureD11(OLD);
  const o = await W.Workspace.open(names());
  await bigTree(o);
  await o.rename("/big", "/bag");
  const want = await tree(o);
  W.configureD11(SMALL);
  // (the rewrite held after its first page: reads, writes and the fence observed half way)
  let gate = null, pages = 0;
  W.Workspace.rewriteCut = () => { pages++; if (pages === 2) { gate = true; throw new Error("held (test)"); } };
  const top = await w.rename("/big", "/bag");
  check(top.path === "/bag" && top.kind === "folder", `the large rename returns its top at once (${J(top.path)})`);
  // (wait until the second page was refused once: half moved now)
  for (let i = 0; i < 200 && !gate; i++) await sleep(10);
  W.Workspace.rewriteCut = () => { throw new Error("held (test)"); };
  const rec = await w.rewriteState();
  check(rec?.kind === "local" && rec.published, `half moved: the record published (${J(rec && { kind: rec.kind, published: rec.published, fails: rec.fails })})`);
  const mid = await tree(w);
  check(J(mid) === J(want), `half moved, every reader sees the moved tree (list recursive): ${mid.length} entries, equal to the one-transaction move's ${J(mid) === J(want) ? "" : diff(mid, want)}`);
  check(!(await w.stat("/big")) && !(await w.stat("/big/s1/f0.txt")) && (await w.stat("/bag/s1/f0.txt"))?.ident !== undefined, "stat: the old paths absent, the new ones there");
  const l = (await w.list("/bag/s2")).map((e) => e.path).sort();
  check(J(l) === J(["/bag/s2/deep", ...want.map((x) => JSON.parse(x).path).filter((p) => p.startsWith("/bag/s2/") && p.split("/").length === 4 && p !== "/bag/s2/deep")].sort()), `a listing of /bag/s2 half moved: ${J(l.length)} children`);
  const f = await w.stat("/bag/s1/f0.txt");
  const bytes = await w.contents(f);
  check(bytes && new TextDecoder().decode(bytes) === "x0", "a moved file's contents read through the projection");
  // (the fence: writes under either prefix, or an ancestor's move, refused busy; elsewhere allowed)
  const busy = async (f) => { try { await f(); return false; } catch (e) { return e?.code === "busy"; } };
  check(await busy(() => w.create("/bag/new.txt", { content: "n" })), "a create under the destination: busy");
  check(await busy(() => w.create("/big/new.txt", { content: "n" })), "a create under the old source: busy");
  check(await busy(() => w.write("/bag/s1/f0.txt", "w")), "a write to a moved file: busy");
  check(await busy(() => w.rename("/bag/s1", "/s1")), "a move out of the moved folder: busy");
  check(!(await busy(() => w.create("/elsewhere.txt", { content: "e" }))), "a create elsewhere: allowed");
  check(await busy(() => w.rename("/elsewhere.txt", "/bag/e.txt")), "a move into the destination: busy");
  // (released: the rewrite goes on and drains; the record gone, the tree equal)
  W.Workspace.rewriteCut = null;
  void w.driveRewrite();
  const end = await w.rewriteSettled(60_000);
  check(!end, `drained (${J(end && { fails: end.fails, stuck: end.stuck })})`);
  await w.remove("/elsewhere.txt");
  const fin = (await tree(w)).filter((x) => !x.includes("elsewhere"));
  check(J(fin) === J(want), `drained: equal to the one-transaction move (${fin.length} entries) ${J(fin) === J(want) ? "" : diff(fin, want)}`);
  const ctl = (await raw(w.ws, "entries")).filter((e) => e.path < "/");
  check(ctl.length === 0, `no control row left (${ctl.length})`);
  w.close(); o.close();
}

async function localStuckAndReload() {
  W.configureD11(SMALL);
  const opts = names();
  let w = await W.Workspace.open(opts);
  await bigTree(w, 24);
  W.Workspace.rewriteCut = () => { throw new Error("failing (test)"); };
  await w.rename("/big", "/bag");
  let rec;
  for (let i = 0; i < 500; i++) { rec = await w.rewriteState(); if (rec?.stuck) break; await sleep(20); }
  check(rec?.stuck && rec.fails === 10, `ten failures in a row: stuck, told (${J(rec && { fails: rec.fails, stuck: rec.stuck?.slice(0, 60) })})`);
  check((await w.stat("/bag/s1/f0.txt")) && !(await w.stat("/big")), "stuck: the moved tree still read through the projection");
  // (a reload tries once more: still failing, stuck again after one try)
  w.close();
  w = await W.Workspace.open(opts);
  for (let i = 0; i < 200; i++) { rec = await w.rewriteState(); if (rec?.stuck && rec.fails === 10) break; await sleep(20); }
  check(rec?.stuck, "a reload: one more try, stuck again");
  // (the fault gone, a reload: drained)
  W.Workspace.rewriteCut = null;
  w.close();
  w = await W.Workspace.open(opts);
  const end = await w.rewriteSettled(60_000);
  check(!end && (await w.stat("/bag/s1/f0.txt")) && !(await w.stat("/big/s1/f0.txt")), "the fault gone, a reload: drained");
  w.close();
}

async function localPreflightAbandoned() {
  // (a preflight record whose caller is gone (its tab closed before publishing): abandoned at the next open, the move not made)
  W.configureD11(SMALL);
  const opts = names();
  let w = await W.Workspace.open(opts);
  await bigTree(w, 15);
  await new Promise((ok, no) => { const tx = w.ws.transaction("entries", "readwrite"); tx.objectStore("entries").put({ path: W.RW, rid: "deadbeef", kind: "local", published: false, rev: 1, n: 1, maps: [{ i: 0, from: "/big", to: "/bag" }], fails: 0, at: Date.now() }); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  check((await (async () => { try { await w.create("/big/x.txt", { content: "x" }); return false; } catch (e) { return e.code === "busy"; } })()), "an unpublished record fences as well (busy)");
  check((await w.stat("/big/s1/f0.txt")) && !(await w.stat("/bag")), "unpublished: the old tree, as it was");
  w.close();
  w = await W.Workspace.open(opts);
  for (let i = 0; i < 100 && (await w.rewriteState()); i++) await sleep(20);
  check(!(await w.rewriteState()) && (await w.stat("/big/s1/f0.txt")) && !(await w.stat("/bag")), "reopened: abandoned, the move not made");
  w.close();
}

async function fenceParticipation() {
  // (every transaction that writes entries read the fence first: put, add and delete on "entries" wrapped)
  W.configureD11(SMALL);
  const bad = [];
  const proto = IDBObjectStore.prototype, orig = { put: proto.put, add: proto.add, delete: proto.delete };
  for (const k of ["put", "add", "delete"]) proto[k] = function (...a) {
    if (this.name === "entries" && !W.FENCE_READ.has(this.transaction)) bad.push(`${k} ${String(a[0]?.path ?? a[0]).slice(0, 60)} ${new Error().stack.split("\n").slice(2, 4).join(" | ").slice(0, 200)}`);
    return orig[k].apply(this, a);
  };
  try {
    const w = await W.Workspace.open(names());
    await bigTree(w, 15);
    await w.write("/big/s1/f0.txt", "w2");
    await w.rename("/big/s1/f0.txt", "/f0.txt");
    await w.remove("/f0.txt");
    await w.restore("/Trash/f0.txt");
    await w.rename("/big", "/bag");
    await w.rewriteSettled(30_000);
    await w.duplicate("/f0.txt");
    await w.remove("/bag/s2");
    await w.emptyTrash();
    w.close();
  } catch (e) {
    bad.push("threw " + (e?.stack ?? e));
  } finally {
    Object.assign(proto, orig);
  }
  // (the open's own writes (migration, identity) aren't the verbs': listed if any, to read)
  check(bad.length === 0, `every entries write after its transaction read the fence (${bad.length}): ${bad.slice(0, 3).join(" ;; ")}`);
}

// ---- large confirmed moves

async function setupSync(d11) {
  W.configureD11(d11);
  localStorage.clear();
  const w = await W.Workspace.open(names());
  const ns = "a".repeat(32) + ":1:" + w.device;
  const lease = await W.switchTo(w, ns), ob = new W.Outbox(w, lease);
  await ob.begin(await w.lastSeq());
  let seq = 0, dseq = 0;
  const log = [];
  const op = (o) => { const x = { seq: ++seq, device: OTHER, dseq: ++dseq, t: 1_900_000_000_000 + seq, by: "person", ...o }; log.push(x); return x; };
  const onIndex = W.confirmedIndex(w);
  const apply = (ops) => onIndex({ ns, ops });
  return { w, ns, ob, op, apply, log };
}

/** The server's tree: folder /d (fid d) with `n` files in subfolders; returns the ops and the ids. */
function serverTree(op, n = 30, top = "/d") {
  const d = hex(16), s = [hex(16), hex(16)], ops = [op({ op: "mkdir", path: top, kind: "folder", fid: d })];
  ops.push(op({ op: "mkdir", path: `${top}/s0`, kind: "folder", fid: s[0], parent: d }));
  ops.push(op({ op: "mkdir", path: `${top}/s1`, kind: "folder", fid: s[1], parent: d }));
  const files = [];
  for (let i = 0; i < n; i++) {
    const f = hex(16);
    files.push(f);
    ops.push(op({ op: "create", path: `${top}/s${i % 2}/f${i}.txt`, kind: "file", fid: f, parent: s[i % 2], sha256: SHA("a"), size: 3 }));
  }
  return { d, s, files, ops };
}

/** The confirmed index's rows of generation 0, as the reducer would have them (without its prefix fields). */
const confirmedRows = async (w, ns) => (await raw(w.ws, "syncIndex")).filter((r) => r.ns === W.genPrefix(ns, 0)).map((r) => { const { ns: _n, key: _k, parentKey: _p, ...e } = r; return J(e); }).sort();
const reducerRows = (log) => { const ix = W.reduceAll(log); return [...[...ix.byId.values()].map((e) => J(e)), ...[...ix.gone].map(([id, lastPath]) => J({ id, gone: true, lastPath }))].sort(); };

async function confirmedRename() {
  const a = await setupSync(SMALL), b = await setupSync(OLD);
  for (const x of [a, b]) {
    const t = serverTree(x.op, 30);
    await x.apply(t.ops);
    x.t = t;
  }
  // (the same ids in both: b's log made from a's)
  const same = async (x, ops) => { await x.apply(ops); };
  const ra = [a.op({ op: "rename", path: "/d", to: "/e", kind: "folder", fid: a.t.d })];
  const rb = [b.op({ op: "rename", path: "/d", to: "/e", kind: "folder", fid: b.t.d })];
  await same(a, ra); await same(b, rb);
  const ca = await confirmedRows(a.w, a.ns), want = reducerRows(a.log);
  check(J(ca) === J(want), `a large confirmed rename: the confirmed rows equal the in-memory reducer's (${ca.length} rows)`);
  check(!(await W.replayOf(a.w, a.ns)), "its view replayed: no marker left");
  const ta = (await tree(a.w)).map((x) => x.replace(/"ident":"[0-9a-f]+"|"fid":"[0-9a-f]+"/g, "")), tb = (await tree(b.w)).map((x) => x.replace(/"ident":"[0-9a-f]+"|"fid":"[0-9a-f]+"/g, ""));
  check(J(ta) === J(tb) && ta.length === 33, `its view equals the one-transaction view (${ta.length} entries)`);
  const logged = (await a.w.ops()).filter((o) => o.origin === "server" && o.op === "rename");
  check(logged.length === 1 && logged[0].path === "/d" && logged[0].to === "/e", `one server op logged for the move (${J(logged.map((o) => [o.op, o.path, o.to]))})`);
  a.w.close(); b.w.close();
}

async function confirmedHalfMoved() {
  // (the confirmed rewrite held after one page: the confirmed reads through the projection; then resumed after a reload)
  const a = await setupSync({ ...SMALL, fails: 100 });
  const t = serverTree(a.op, 30);
  await a.apply(t.ops);
  let pages = 0;
  W.setConfirmedCut(() => { if (++pages >= 2) throw new Error("held (test)"); });
  const p = a.apply([a.op({ op: "rename", path: "/d", to: "/e", kind: "folder", fid: t.d })]).catch((e) => e);
  let rec;
  for (let i = 0; i < 300; i++) { rec = await new Promise((ok) => { const r = a.w.ws.transaction("meta").objectStore("meta").get(W.crecordKey(W.genPrefix(a.ns, 0))); r.onsuccess = () => ok(r.result); }); if (rec?.published && rec.fails >= 1) break; await sleep(10); }
  check(rec?.published && rec.maps?.length === 1, `half rewritten: the record published, one mapping (${J(rec && { published: rec.published, maps: rec.maps?.map((m) => [m.from, m.to]), fails: rec.fails })})`);
  const e = await W.confirmedEntry(a.w, a.ns, t.files[0]);
  check(e?.path?.startsWith("/e/"), `by identity: a row not yet rewritten read at its new path (${e?.path})`);
  W.setConfirmedCut(null);
  const r = await p;
  check(!(r instanceof Error), `then drained and applied (${r instanceof Error ? r.message : "ok"})`);
  const ca = await confirmedRows(a.w, a.ns), want = reducerRows(a.log);
  check(J(ca) === J(want), "equal to the reducer's");
  a.w.close();
}

// ---- the view's replay: a plan through staging (r5 §2, r7 §1)

/** A workspace with sync's namespace, its confirmed index and entries seeded as given (a view to replay: the local
 * tree diverged from the confirmed one, as a rebuild's or a large move's view finds it). */
async function seeded(d11, confirmed, local, limits) {
  W.configureD11(d11);
  localStorage.clear();
  const w = await W.Workspace.open({ ...names(), ...(limits ? { limits: { ...W.LIMITS, ...limits } } : {}) });
  const ns = "b".repeat(32) + ":1:" + w.device;
  const lease = await W.switchTo(w, ns), ob = new W.Outbox(w, lease);
  await ob.begin(await w.lastSeq());
  const gp = W.genPrefix(ns, 0), now = 1_800_000_000_000;
  const pk = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
  const put = (store, rows) => new Promise((ok, no) => { const tx = w.ws.transaction(store, "readwrite"); for (const r of rows) tx.objectStore(store).put(r); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  await put("syncIndex", confirmed.map(([id, path, kind]) => ({ ns: gp, id, path, key: path.normalize("NFC"), parentKey: pk(path).normalize("NFC"), kind, fid: id, ...(kind === "file" ? { sha256: SHA("a"), size: 3 } : {}), created: now, updated: now, by: "person", seq: 1 })));
  await put("entries", local.map(([id, path, kind]) => ({ path, kind, ref: kind === "file" ? path : null, created: now, updated: now, fid: id, ident: id, nkey: pk(path) + "\u0000" + path.slice(path.lastIndexOf("/") + 1).normalize("NFC"), ...(kind === "file" ? { size: 3, rev: 0, migrated: true, sha256: SHA("a"), remote: true } : {}) })));
  return { w, ns, gp };
}
/** Folders with `n` files each: [id, path, kind] for a confirmed tree and a local one, the folder `f`'s local path
 * `from` and confirmed path `to`. */
function folders(spec, n = 15) {
  const confirmed = [], local = [], ids = {};
  for (const [name, from, to] of spec) {
    const f = hex(16);
    ids[name] = f;
    confirmed.push([f, to, "folder"]);
    local.push([f, from, "folder"]);
    for (let i = 0; i < n; i++) {
      const id = hex(16);
      confirmed.push([id, `${to}/${name}${i}.txt`, "file"]);
      local.push([id, `${from}/${name}${i}.txt`, "file"]);
    }
  }
  return { confirmed, local, ids };
}
/** The oracle: today's view of every identity applied in one transaction. */
async function oneTransactionView(o, ns, gp, ids) {
  const cap = await W.capNow();
  await new Promise((ok, no) => {
    const tx = o.ws.transaction([...new Set([...W.VIEW_STORES, "syncIndex", "meta"])], "readwrite");
    W.applyView({ w: o, tx, ns, store: W.idbStore(tx, gp), cap }, ids).catch((e) => { try { tx.abort(); } catch {} no(e); });
    tx.oncomplete = ok;
    tx.onerror = () => no(tx.error);
  });
}
/** Every listing of the tree read in pages of `n` (r7 §1's paging), each child with its point read and its identity
 * read; returns the paths, and what disagreed. */
async function readAll(w, n) {
  const out = [], bad = [];
  const walk = async (F) => {
    let after = "";
    for (;;) {
      const p = await new Promise((ok, no) => { const tx = w.ws.transaction("entries"); W.entriesOf(tx).then((ev) => ev.page(F, after, n)).then(ok, no); });
      for (const e of p.list) {
        out.push(e.path);
        const s = await w.stat(e.path);
        const byId = e.ident ? await new Promise((ok, no) => { const tx = w.ws.transaction("entries"); W.entriesOf(tx).then((ev) => ev.byIdent(e.ident)).then(ok, no); }) : e;
        if (!s || s.path !== e.path || !byId || byId.path !== e.path) bad.push([e.path, s?.path, byId?.path]);
        if (e.kind === "folder") await walk(e.path);
      }
      if (p.next === undefined) break;
      after = p.next;
    }
  };
  await walk("/");
  return { paths: out.sort(), bad };
}

/** A plan replayed (a "debts" marker over `ranges`), each page's reads checked, compared with the oracle; returns
 * the final tree, the settled closure's figures and the plan's mappings (N8). */
async function replayRows(what, f, ranges, expect = {}) {
  const a = await seeded(SMALL, f.confirmed, f.local), o = await seeded(OLD, f.confirmed, f.local);
  if (expect.seed) { await expect.seed(a.w, a.ns); await expect.seed(o.w, o.ns); }
  const ids = [...new Set([...f.confirmed.map((x) => x[0])])];
  await oneTransactionView(o.w, o.ns, o.gp, ids);
  const want = await tree(o.w), wantById = await identities(o.w);
  const before = await tree(a.w);
  // (the marker, as a rebuild's view leaves it after resume, and the entries' slot reserved)
  await new Promise((ok, no) => {
    const tx = a.w.ws.transaction(["meta", "entries"], "readwrite"), now = Date.now();
    tx.objectStore("meta").put({ gen: a.gp, rid: "c0ffee00", kind: "debts", ranges: ranges.map((r) => r.normalize("NFC")), phase: "pass", start: now, deadline: now + 900_000, times: {} }, W.markerKey(a.ns));
    tx.objectStore("entries").put({ path: W.RW, rid: "c0ffee00", kind: "reserved", published: false, rev: 1, n: 0, fails: 0, at: now });
    tx.oncomplete = ok; tx.onerror = () => no(tx.error);
  });
  const snaps = [];
  W.configureD11({ ...SMALL, ...(expect.d11 ?? {}) });
  let classes = null, crashed = 0, closure = null, validation = null, nmaps = null;
  if (expect.crashAtTransition) W.REPLAY.cut = (at) => { if (at === "sweep1to2" && !crashed++) throw new Error("crash before the transition (test)"); };
  if (expect.cut) W.REPLAY.cut = (at) => { if (at === expect.cut && !crashed++) throw new Error(`crash at ${at} (test)`); };
  if (expect.probe) startProbe();
  let txs = null;
  W.REPLAY.before = async (phase, m) => {
    if (m.closure) closure = m.closure;
    if (m.validation) validation = m.validation;
    if (expect.hook) await expect.hook(phase, m, a);
    const rec = await a.w.rewriteState();
    if (rec?.published && nmaps === null) nmaps = rec.n;
    if (rec?.published && !classes) classes = Object.fromEntries((await raw(a.w.ws, "entries")).filter((e) => e.path.startsWith(W.MAPS)).map((e) => [e.from, !!e.direct]));
    snaps.push({ rid: m.rid, phase, sweep: rec?.sweep ?? null, published: !!rec?.published, t: await tree(a.w), r1: await readAll(a.w, 1), r2: await readAll(a.w, 2), r1000: await readAll(a.w, 1000) });
  };
  try {
    try {
      await W.runReplay(a.w, a.ns);
    } catch (e) {
      // (a crash between transactions (test): a new page drives it on)
      if (!expect.resume) throw e;
      crashed++;
      W.REPLAY.reload();
      await expect.resume(a);
      await W.runReplay(a.w, a.ns);
    }
  } finally {
    W.REPLAY.before = null;
    W.REPLAY.cut = null;
    if (expect.probe) txs = stopProbe();
  }
  if (expect.cut || expect.resume) check(crashed >= 1, `${what}: crashed once${expect.cut ? ` at ${expect.cut}` : " between transactions"}, then resumed`);
  const sorted = (o) => o && Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  if (expect.classes) check(J(sorted(classes)) === J(sorted(expect.classes)), `${what}: each mapping's class persisted at publication (${J(classes)})`);
  if (expect.crashAtTransition) check(crashed >= 1, `${what}: a crash after the last direct page, before the transition: resumed`);
  const fin = await tree(a.w);
  const paths = (t) => t.map((x) => JSON.parse(x).path);
  const pdiff = () => { const a = paths(fin), b = paths(want); return J({ ours: a.filter((x) => !b.includes(x)).slice(0, 6), oracle: b.filter((x) => !a.includes(x)).slice(0, 6) }); };
  const byId = await identities(a.w);
  if (expect.oracle !== false) {
    check(J(fin) === J(want), `${what}: the replay's result equals today's one-transaction view (${fin.length} entries) ${J(fin) === J(want) ? "" : pdiff()}`);
    check(J(byId) === J(wantById), `${what}: every identity where today's one-transaction view puts it (${Object.keys(byId).length} identities) ${J(byId) === J(wantById) ? "" : idDiff(byId, wantById)}`);
  } else {
    // (an input today's one-transaction view gets wrong (CORR-D11-IMPL-2): the result named, identity by identity)
    const got = Object.fromEntries(Object.keys(expect.paths).map((k) => [k, byId[k]]));
    check(J(got) === J(expect.paths), `${what}: each identity where the plan puts it ${J(got) === J(expect.paths) ? "" : idDiff(got, expect.paths)}`);
  }
  const bad = [...snaps.map((s) => [s.phase, s.sweep, orphans(s.t)]), ["end", null, orphans(fin)]].filter((x) => x[2].length);
  check(!bad.length, `${what}: at every page, every entry's folder a folder ${bad.length ? J(bad[0]) : ""}`);
  // (each logical move of the replay on its own (a move, then the debts its placement left, CORR-D11-R1-1): before its
  // plan's publication, the tree it began with; from it, the tree it plans)
  const rids = [...new Set(snaps.map((s) => s.rid))];
  const cycles = rids.map((rid, c) => {
    const ss = snaps.filter((s) => s.rid === rid), nextFirst = snaps.find((s) => s.rid === rids[c + 1]);
    return { ss, before: c === 0 ? before : ss[0].t, after: ss.find((s) => s.phase === "place")?.t ?? nextFirst?.t ?? fin };
  });
  const pre = cycles.flatMap((x) => x.ss.filter((s) => !s.published && s.phase !== "place").map((s) => [s, x.before]));
  check(pre.every(([s, b]) => J(s.t) === J(b)), `${what}: before each plan's publication (${pre.length} pages, ${cycles.length} logical moves) every reader sees the tree it began with`);
  const planned = cycles.map((x) => ({ ...x, ps: x.ss.filter((s) => s.published) })).filter((x) => x.ps.length);
  check(planned.length >= 1 && planned.every((x) => x.ps.length >= 2 && x.ps.every((s) => J(s.t) === J(x.after))), `${what}: from each publication, after every sweep page (${J(planned.map((x) => x.ps.map((s) => s.sweep)))}), the logical tree is the planned one ${J(snaps.map((s) => [s.phase, s.sweep, s.published]))}`);
  const listingsOk = snaps.every((s) => {
    const want = J(s.t.map((x) => JSON.parse(x).path).sort());
    return [s.r1, s.r2, s.r1000].every((r) => J(r.paths) === want && r.bad.length === 0);
  });
  const firstBad = snaps.find((s) => ![s.r1, s.r2, s.r1000].every((r) => J(r.paths) === J(s.t.map((x) => JSON.parse(x).path).sort()) && r.bad.length === 0));
  check(listingsOk, `${what}: at every page, listings paged by 1, 2 and 1,000 enumerate each entry once, equal to point and identity reads ${firstBad ? J({ phase: firstBad.phase, sweep: firstBad.sweep, r1: firstBad.r1.paths.length, want: firstBad.t.length, bad: firstBad.r1.bad.slice(0, 2) }) : ""}`);
  const m = await W.replayOf(a.w, a.ns);
  check(!m && !(await a.w.rewriteState()), `${what}: the marker and the plan gone`);
  const logged = (await a.w.ops()).filter((x) => x.origin === "server");
  check(logged.every((x) => !String(x.path).startsWith("\u0001") && !String(x.to ?? "").startsWith("\u0001")), `${what}: no op logged with a staging path (${logged.length} ops)`);
  const listed = (await metaOf(a.w, `sync:${a.ns}:listed`))?.paths ?? [];
  a.w.close(); o.w.close();
  return { fin, want, closure, validation, nmaps, byId, listed, txs, cycles: cycles.length };
}
const replayCase = (what, spec, ranges, expect = {}) => replayRows(what, folders(spec), ranges, expect);

const swap = () => replayCase("a large-folder swap", [["A", "/a", "/b"], ["B", "/b", "/a"]], ["/a", "/b"]);
const direct1 = () => replayCase("one free large move: direct", [["A", "/a", "/q"]], ["/q"], { classes: { "/a": true }, crashAtTransition: true });
const destNested = () => replayCase("destination inside destination: staged", [["A", "/a", "/x"], ["B", "/b", "/x/sub"]], ["/x"], { classes: { "/a": false, "/b": false } });
const siblings = () => replayCase("adjacent names (/a, /a-old): both direct", [["A", "/a", "/q"], ["B", "/a-old", "/r"]], ["/q", "/r"], { classes: { "/a": true, "/a-old": true } });
const mixed = () => replayCase("a free move beside a swap: direct and staged", [["A", "/a", "/b"], ["B", "/b", "/a"], ["C", "/c", "/q"]], ["/a", "/b", "/q"], { classes: { "/a": false, "/b": false, "/c": true } });
const cycle3 = () => replayCase("a three-cycle", [["A", "/a", "/b"], ["B", "/b", "/c"], ["C", "/c", "/a"]], ["/a", "/b", "/c"]);
const nested = () => replayCase("a large folder inside another, each moving elsewhere", [["A", "/a", "/x"], ["B", "/a/in", "/y"]], ["/x", "/y"]);
const deep = () => replayCase("astra's trace: a deep folder under a moved one (/a -> /b, listing /b/sub)", [["A", "/a", "/b"], ["S", "/a/sub", "/b/sub"], ["D", "/a/sub/deep", "/b/sub/deep"]], ["/b"]);

// ---- r8 N8 v3: occupants carried into a nested destination (the plan's closure)

/** Rows for N8's vectors: [name, local path or null, confirmed path or null, kind, files]: a folder's `files` children
 * (`name0.txt`...) in both trees; no confirmed path: local only (no view: it stays where it is). */
function rows8(items) {
  const confirmed = [], local = [], ids = {};
  for (const [name, l, c, kind = "folder", n = 0] of items) {
    const id = hex(16);
    ids[name] = id;
    if (c) confirmed.push([id, c, kind]);
    if (l) local.push([id, l, kind]);
    for (let i = 0; i < n; i++) {
      const f = hex(16);
      if (c) confirmed.push([f, `${c}/${name}${i}.txt`, "file"]);
      if (l) local.push([f, `${l}/${name}${i}.txt`, "file"]);
    }
  }
  return { confirmed, local, ids };
}
/** O /T -> /U (large) with L carried, and I /T/L/F -> `want` (large): v1's vector, with `extra` rows. */
const outerInner = (want, extra = []) => rows8([["T", "/T", "/U", "folder", 15], ["L", "/T/L", "/U/L"], ["I", "/T/L/F", want, "folder", 15], ...extra]);
const pathOf = (r, id) => r.byId[id];
/** The same rows replayed in both planning orders (O first, I first): each equal to the oracle, and to each other. */
async function bothOrders(what, f, rangesA, rangesB, expect = {}) {
  const x = await replayRows(`${what} (O first)`, f, rangesA, expect);
  const y = await replayRows(`${what} (I first)`, f, rangesB, expect);
  check(J(x.fin) === J(y.fin), `${what}: the same settled result in both orders ${J(x.fin) === J(y.fin) ? "" : diff(x.fin, y.fin)}`);
  check(J(x.byId) === J(y.byId), `${what}: every identity in the same place in both orders ${J(x.byId) === J(y.byId) ? "" : idDiff(x.byId, y.byId)}`);
  return x;
}

async function n8MovesOn() {
  // (1: X at /T/F, carried by O onto I's /U/F, its view moving it on: an occupant mapping; I keeps /U/F)
  const f = outerInner("/U/F", [["X", "/T/F", "/U/X", "file"]]);
  const r = await bothOrders("N8 1: a carried occupant that moves on", f, ["/U"], ["/U/F", "/U"]);
  check(pathOf(r, f.ids.I) === "/U/F" && pathOf(r, f.ids.X) === "/U/X" && r.nmaps === 3, `…I at /U/F, X at /U/X, three mappings (${J({ I: pathOf(r, f.ids.I), X: pathOf(r, f.ids.X), maps: r.nmaps, closure: r.closure })})`);
}
async function n8Stays() {
  // (2: X stays (local only): I beside it at applyView's first free name)
  const f = outerInner("/U/F", [["X", "/T/F", null, "file"]]);
  const r = await bothOrders("N8 2: a carried claimant that stays", f, ["/U"], ["/U/F", "/U"]);
  check(pathOf(r, f.ids.I) === "/U/F (2)" && pathOf(r, f.ids.X) === "/U/F", `…I at /U/F (2), X at /U/F (${J({ I: pathOf(r, f.ids.I), X: pathOf(r, f.ids.X) })})`);
}
async function n8StaysY() {
  // (3: and Y at /T/F (2), carried and staying: I at /U/F (3), no new mapping (astra's Y))
  const f = outerInner("/U/F", [["X", "/T/F", null, "file"], ["Y", "/T/F (2)", null, "file"]]);
  const r = await bothOrders("N8 3: X and Y staying", f, ["/U"], ["/U/F", "/U"]);
  check(pathOf(r, f.ids.I) === "/U/F (3)" && r.nmaps === 2, `…I at /U/F (3), two mappings (${J({ I: pathOf(r, f.ids.I), maps: r.nmaps })})`);
  return { f, r };
}
async function n8Nfc() {
  // (4: I -> /U/é (precomposed), X at /T/e + combining acute staying: I beside it, never a second lookalike)
  const f = outerInner("/U/é", [["X", "/T/é", null, "file"]]);
  const r = await bothOrders("N8 4: NFC lookalikes", f, ["/U"], ["/U/é", "/U"]);
  const names = r.fin.map((x) => JSON.parse(x).path).filter((p) => p.startsWith("/U/") && p.lastIndexOf("/") === 2).map((p) => p.normalize("NFC"));
  check(new Set(names).size === names.length && pathOf(r, f.ids.I) !== "/U/é", `…no two names in /U look the same (I at ${J(pathOf(r, f.ids.I))})`);
}
async function n8Folder() {
  // (5: X a folder of rows, carried under /U/F/..., moving on with them)
  const f = outerInner("/U/F", [["X", "/T/F", "/U/X", "folder", 3]]);
  const r = await bothOrders("N8 5: a carried folder occupant", f, ["/U"], ["/U/F", "/U"]);
  check(pathOf(r, f.ids.X) === "/U/X", `…X at /U/X with its rows (${pathOf(r, f.ids.X)})`);
}
async function n8Planned() {
  // (6: the occupant already planned (a large lift of its own): no occupant mapping)
  const f = outerInner("/U/F", [["X", "/T/F", "/U/X", "folder", 15]]);
  const r = await bothOrders("N8 6: an occupant already planned", f, ["/U"], ["/U/F", "/U"]);
  check(r.nmaps === 3, `…three mappings, none added for it (${r.nmaps})`);
}
async function n8Unobstructed() {
  // (7: nothing carried into I's destination: no occupant mappings, the ordinary carried rows none)
  const f = outerInner("/U/F");
  const r = await bothOrders("N8 7: an unobstructed carried subtree", f, ["/U"], ["/U/F", "/U"]);
  check(r.nmaps === 2 && r.closure?.rounds === 1, `…two mappings, settled in one round (${J({ maps: r.nmaps, closure: r.closure })})`);
}
/** 8's rows: I first beside W (carried, staying, inside P); K's occupant J then wants P's place, and P moves away
 * with W: I's name comes free (a vacate), settled in the next round. */
const vacateRows = () => rows8([
  ["T", "/T", "/U", "folder", 15], ["L", "/T/L", "/U/L"], ["I", "/T/L/F", "/U/P/F", "folder", 15],
  ["P", "/T/P", "/U/Q"], ["W", "/T/P/F", null, "file"],
  ["a", "/T/a", "/U/a"], ["b", "/T/a/b", "/U/a/b"], ["c", "/T/a/b/c", "/U/a/b/c"],
  ["K", "/T/L/K", "/U/a/b/c/K", "folder", 15], ["J", "/T/a/b/c/K", "/U/P"],
]);
async function n8Vacate() {
  const f = vacateRows();
  const r = await bothOrders("N8 8: a vacate", f, ["/U"], ["/U/a", "/U"]);
  check(pathOf(r, f.ids.I) === "/U/P/F" && r.closure?.rounds >= 2, `…I at /U/P/F, settled in round ${r.closure?.rounds} (${J({ I: pathOf(r, f.ids.I), closure: r.closure })})`);
}

/** A plan that must fail stably before publication: said, its rows dropped, nothing visible, the sender released. */
async function replayFails(what, f, ranges, d11, re, opts = {}) {
  const a = await seeded(SMALL, f.confirmed, f.local);
  if (opts.seed) await opts.seed(a.w, a.ns);
  const before = await tree(a.w);
  await new Promise((ok, no) => {
    const tx = a.w.ws.transaction(["meta", "entries"], "readwrite"), now = Date.now();
    tx.objectStore("meta").put({ gen: a.gp, rid: "c0ffee08", kind: "debts", ranges: ranges.map((r) => r.normalize("NFC")), phase: "pass", start: now, deadline: now + 900_000, times: {} }, W.markerKey(a.ns));
    tx.objectStore("entries").put({ path: W.RW, rid: "c0ffee08", kind: "reserved", published: false, rev: 1, n: 0, fails: 0, at: now });
    tx.oncomplete = ok; tx.onerror = () => no(tx.error);
  });
  const cfg = W.configureD11({ ...SMALL, ...d11 });
  let err;
  startProbe();
  try { await W.runReplay(a.w, a.ns); } catch (e) { err = e; }
  const txs = stopProbe();
  W.configureD11(SMALL);
  // (LIMIT-D11-IMPL-1: the failing plan's reads too, as IndexedDB served them, within every budget: no read past one made)
  const most = (k, ph) => Math.max(0, ...txs.filter((t) => t.phase === ph).map((t) => t[k]));
  const sr = W.PLAN_STATE.requests, sw = cfg.large + cfg.small + 6;
  check(["close", "validate"].every((ph) => most("req", ph) <= cfg.requests + sr && most("rows", ph) <= cfg.page + sw) && sum(txs, "req") + sum(txs, "req", "validate") <= cfg.closureRequests && sum(txs, "rows") + sum(txs, "rows", "validate") <= cfg.closureRows, `${what}: no transaction's requests, from its first to its last, past ${cfg.requests} + ${sr} or its rows past ${cfg.page} + ${sw}; the closure's past ${cfg.closureRequests} or ${cfg.closureRows} (${J({ txs: txs.length, most: [most("req", "close"), most("rows", "close")], all: [sum(txs, "req") + sum(txs, "req", "validate"), sum(txs, "rows") + sum(txs, "rows", "validate")] })})`);
  const m = await W.replayOf(a.w, a.ns), ctl = (await raw(a.w.ws, "entries")).filter((e) => e.path.startsWith(W.MAPS) || e.path.startsWith("\u0001q/"));
  check(err instanceof W.ReplayHalted && re.test(m?.failed ?? "") && ctl.length === 0 && !(await a.w.rewriteState())?.published && !W.SENDER_HOLD.has(a.ns) && J(await tree(a.w)) === J(before), `${what}: the stable failure before publication: said, the plan dropped, nothing visible, the sender released (${J({ err: err?.constructor?.name, failed: m?.failed?.slice(0, 70), ctl: ctl.length })})`);
  W.REPLAY.reload();
  a.w.close();
}
async function n8Caps() {
  // (9: each cap at exactly what the plan uses (succeeds) and one under it (that operation would exceed it: fails))
  const v1 = outerInner("/U/F", [["X", "/T/F", "/U/X", "file"]]);
  const m0 = await replayRows("N8 9: the measured plan", v1, ["/U"]), base = m0.closure, val = m0.validation;
  check(base && base.rounds === 2 && val, `…measured: ${J({ closure: base, validation: val })}`);
  // (the plan's reads: its closure's and its validation's (LIMIT-D11-IMPL-4))
  for (const [k, v] of [["closureItems", base.items], ["closureRequests", base.requests + val.requests], ["closureRows", base.rows + val.rows], ["closureRounds", base.rounds]]) {
    await replayRows(`N8 9: ${k} at exactly ${v}`, v1, ["/U"], { d11: { [k]: v } });
    await replayFails(`N8 9: ${k} at ${v - 1}`, v1, ["/U"], { [k]: v - 1 }, /reload to try again/);
  }
}
async function n8CapsNames() {
  const taken = (n, name = (i) => (i === 1 ? "F" : `F (${i})`)) => Array.from({ length: n }, (_, i) => [`X${i}`, `/T/${name(i + 1)}`, null, "file"]);
  // (freeNames: candidate 0 counts; vector 3's I needs three)
  const v3 = outerInner("/U/F", [["X", "/T/F", null, "file"], ["Y", "/T/F (2)", null, "file"]]);
  await replayRows("N8 9: freeNames at exactly 3", v3, ["/U"], { d11: { freeNames: 3 } });
  await replayFails("N8 9: freeNames at 2", v3, ["/U"], { freeNames: 2 }, /no free name/);
  // (the 100th candidate: the first 99 taken by ordinary names; all 100 taken, by ordinary names, then by lookalikes)
  // (rows a transaction reads: the default 1,000, so an item of 100 names fits)
  const P = { page: 1000 };
  const r100 = await replayRows("N8 9: the 100th candidate", outerInner("/U/F", taken(99)), ["/U"], { d11: P });
  check(r100.fin.map((x) => JSON.parse(x).path).includes("/U/F (100)"), "…I at /U/F (100)");
  await replayFails("N8 9: all 100 taken by ordinary names", outerInner("/U/F", taken(100)), ["/U"], P, /no free name/);
  await replayFails("N8 9: all 100 taken by lookalikes", outerInner("/U/é", taken(100, (i) => (i === 1 ? "é" : `é (${i})`))), ["/U"], P, /no free name/);
}
/** (LIMIT-D11-IMPL-1/2) A replay's closure and validation reads against IndexedDB's own count (the probe): every
 * transaction within D11.requests and D11.page, the closure's counters equal to what IndexedDB served it. */
function metered(what, r, cfg) {
  const close = r.txs.filter((t) => t.phase === "close"), val = r.txs.filter((t) => t.phase === "validate");
  const most = (ts, k) => Math.max(0, ...ts.map((t) => t[k]));
  const st = { requests: W.PLAN_STATE.requests, rows: cfg.large + cfg.small + 6, writes: cfg.large + cfg.small + 4 };
  const ledger = (L, ts) => L && sum(ts, "req", ts[0]?.phase) === L.requests && sum(ts, "rows", ts[0]?.phase) === L.rows && sum(ts, "writes", ts[0]?.phase) === L.writes && ts.length === L.txs && most(ts, "req") === L.allTxReq && most(ts, "rows") === L.allTxRows;
  check(ledger(r.closure, close) && ledger(r.validation, val), `${what}: the closure's and validation's counters are every request, row and write IndexedDB served their transactions, from the first to the last (${J({ ledger: [r.closure, r.validation], idb: [[close.length, sum(close, "req"), sum(close, "rows"), sum(close, "writes"), most(close, "req"), most(close, "rows")], [val.length, sum(val, "req", "validate"), sum(val, "rows", "validate"), sum(val, "writes", "validate"), most(val, "req"), most(val, "rows")]] })})`);
  const within = (ts, L) => L.txReq <= cfg.requests && L.txRows <= cfg.page && ts.every((t) => t.req <= cfg.requests + st.requests && t.rows <= cfg.page + st.rows && t.writes <= st.writes);
  check(val.length > 0 && within(close, r.closure) && within(val, r.validation), `${what}: every closure and validation transaction's work within ${cfg.requests} requests and ${cfg.page} rows, and all of it within that and its state's (${st.requests} requests, ${st.rows} rows; ${st.writes} writes) (${J({ close: [close.length, r.closure.txReq, r.closure.txRows, most(close, "req"), most(close, "rows"), most(close, "writes")], validate: [val.length, r.validation.txReq, r.validation.txRows, most(val, "req"), most(val, "rows"), most(val, "writes")] })})`);
  check(r.closure.requests + r.validation.requests <= cfg.closureRequests && r.closure.rows + r.validation.rows <= cfg.closureRows, `${what}: the plan's reads (its closure's and its validation's) within ${cfg.closureRequests} requests and ${cfg.closureRows} rows`);
  return { txs: close.length, txReq: r.closure.txReq, txRows: r.closure.txRows, waits: r.closure?.waits ?? 0 };
}
/** One transaction's budget: measured with one item a transaction, then each at exactly the largest transaction's
 * use (succeeds) and one under it (that item's next read isn't admitted: the stable failure, nothing past it read),
 * and at exactly it with many items a transaction (an item that doesn't fit waits for the next). */
async function txBudget(what, f, ranges, d11, opts = {}) {
  const one = { ...d11, planPage: 1 };
  const r = await replayRows(`${what}: one item a transaction`, f, ranges, { d11: one, probe: true, ...opts });
  const m = metered(`${what}: one item a transaction`, r, { ...SMALL, ...one });
  check(m.txReq > 50 && m.txRows > 10, `${what}: its largest item's transaction above the floors (50 requests, 10 rows): ${J(m)}`);
  const xs = [];
  for (const [k, v] of [["requests", m.txReq], ["page", m.txRows]]) {
    const at = { ...one, [k]: v };
    metered(`${what}: ${k} at exactly ${v}`, await replayRows(`${what}: ${k} at exactly ${v}`, f, ranges, { d11: at, probe: true, ...opts }), { ...SMALL, ...at });
    await replayFails(`${what}: ${k} at ${v - 1}`, f, ranges, { ...one, [k]: v - 1 }, /for one name/, opts);
    const many = { ...d11, [k]: v };
    const x = metered(`${what}: ${k} at exactly ${v}, many items a transaction`, await replayRows(`${what}: ${k} at exactly ${v}, many items a transaction`, f, ranges, { d11: many, probe: true, ...opts }), { ...SMALL, ...many });
    check(x.txs <= m.txs, `${what}: …in no more transactions than one item each (${J({ txs: x.txs, one: m.txs, waited: x.waits })})`);
    xs.push(x);
  }
  check(xs.some((x) => x.waits > 0), `${what}: an item that didn't fit waited for the next transaction (${J(xs.map((x) => x.waits))})`);
}
async function n8CapsTx() {
  // (one transaction's requests and rows: 30 staying names before I's free one)
  const taken = (n) => Array.from({ length: n }, (_, i) => [`X${i}`, `/T/${i === 0 ? "F" : `F (${i + 1})`}`, null, "file"]);
  await txBudget("N8 9: an item of many requests", outerInner("/U/F", taken(30)), ["/U"], { page: 1000 });
}
/** The adversarial closure (LIMIT-D11-IMPL-2): I's view under two carriers (A1 and A2, mappings whose targets hold its
 * folder) as well as O, twelve staying claimants at its candidates, six of them in lookalike pairs, each claimant with
 * an intent (its view reads its intents and its folders' too). */
function meterRows() {
  const items = [["T", "/T", "/U", "folder", 15], ["L", "/T/L", "/U/L"], ["A1", "/T/a", "/U/a2", "folder", 15], ["A2", "/T/a/b", "/U/a2/b2", "folder", 15], ["I", "/T/L/F", "/U/a2/b2/é", "folder", 15]];
  for (let i = 1; i <= 12; i++) {
    const name = i === 1 ? "é" : `é (${i})`;
    items.push([`X${i}`, `/T/a/b/${name}`, null, "file"]);
    if (i <= 6) items.push([`Y${i}`, `/T/a/b/${name.replace("é", "e\u0301")}`, null, "file"]);
  }
  return rows8(items);
}
/** Each identity given an intent (held: its view reduced with its intents and its folders'). */
const held = (ids) => (w, ns) => new Promise((ok, no) => {
  const tx = w.ws.transaction("pending", "readwrite");
  for (const id of ids) tx.objectStore("pending").put({ id, byNs: { [ns]: { held: true } } });
  tx.oncomplete = ok;
  tx.onerror = () => no(tx.error);
});
async function n8Meter() {
  const f = meterRows(), seed = held(Object.keys(f.ids).filter((k) => /^[XY]/.test(k)).map((k) => f.ids[k]));
  const P = { page: 1000 };
  const r = await replayRows("LIMIT: an adversarial closure", f, ["/U"], { d11: P, seed, probe: true });
  metered("LIMIT: an adversarial closure", r, { ...SMALL, ...P });
  check(r.nmaps === 4 && r.closure.maxReq > 50 && /é \(13\)$/.test(pathOf(r, f.ids.I) ?? ""), `…I beside its twelve claimants (${J({ I: pathOf(r, f.ids.I), maps: r.nmaps, closure: r.closure })})`);
  // (the closure's own ceilings: at exactly what it used (succeeds), one under (the read past it never made: stable))
  // (the plan's reads, its closure's and its validation's (LIMIT-D11-IMPL-4): at exactly what it used (its last
  // transaction, the publication, ends at it: succeeds); one under (the read past it never made: stable); at the
  // closure's own (no room for validation's bootstrap: the settling transaction's reservation fails it); and a little
  // past it (validation's own reads past it))
  for (const [k, c, v] of [["closureRequests", r.closure.requests, r.validation.requests], ["closureRows", r.closure.rows, r.validation.rows]]) {
    const at = { ...P, [k]: c + v };
    metered(`LIMIT: ${k} at exactly ${c + v}`, await replayRows(`LIMIT: ${k} at exactly ${c + v}`, f, ["/U"], { d11: at, seed, probe: true }), { ...SMALL, ...at });
    for (const x of [c + v - 1, c, c + 6]) await replayFails(`LIMIT: ${k} at ${x} (the closure's ${c}, validation's ${v})`, f, ["/U"], { ...P, [k]: x }, /requests or \d+ rows: reload/, { seed });
  }
  await txBudget("LIMIT: the adversarial closure", f, ["/U"], P, { seed });
}
async function n8Crashes() {
  // (10: a crash at each point, then on to the same result)
  const f = vacateRows();
  for (const at of ["close", "close-round", "close-settled", "validate", "publish", "sweep1", "sweep2"]) await replayRows(`N8 10: a crash at ${at}`, f, ["/U"], { cut: at });
  // (between transactions: after a mapping persisted, after a retarget; and in validation, done again from its start)
  let n = 0;
  await replayRows("N8 10: a crash between closure transactions", f, ["/U"], { d11: { planPage: 1 }, hook: (p) => { if (p === "close" && ++n === 3) throw new Error("crash (test)"); }, resume: async () => {} });
  const vis = [];
  let v = 0;
  await replayRows("N8 10: a crash inside validation", f, ["/U"], { d11: { validatePage: 1 }, hook: (p, m) => { if (p !== "validate") return; vis.push(m.vi ?? 0); if (++v === 3) throw new Error("crash (test)"); }, resume: async () => {} });
  check(vis.includes(0) && vis.indexOf(0, vis.findIndex((x) => x > 0)) > 0, `…the validation begun before the crash done again from its start (vi seen ${J(vis)})`);
}
/** 11's group: three names NFC-equal to /U/Ǻ: two lifted away (large, their own mappings), the third staying. */
const legacy = (dir, outer) => rows8([
  ...(outer ? [["T", "/T", "/U", "folder", 15]] : [["U", "/U", "/U"]]),
  ["G1", `${dir}/Ǻ`, "/V1", "folder", 15], ["G2", `${dir}/Ǻ`, "/V2", "folder", 15], ["G3", `${dir}/Ǻ`, null, "file"],
  ["L", "/L", "/L"], ["I", "/L/F", "/U/Ǻ", "folder", 15],
]);
async function n8Legacy() {
  const f = legacy("/U", false);
  const r = await replayRows("N8 11: a legacy lookalike group", f, ["/U", "/V1", "/V2"]);
  check(pathOf(r, f.ids.I) !== "/U/Ǻ" && pathOf(r, f.ids.G3) === "/U/Ǻ", `…I beside the third, never on it (${J({ I: pathOf(r, f.ids.I) })})`);
  const g = legacy("/T", true);
  const s = await replayRows("N8 11: the group carried, two owned by more specific mappings", g, ["/U", "/V1", "/V2"]);
  check(pathOf(s, g.ids.I) !== "/U/Ǻ" && pathOf(s, g.ids.G3) === "/U/Ǻ", `…I beside the third, never on it (${J({ I: pathOf(s, g.ids.I) })})`);
  await replayRows("N8 11: lookalikes at exactly 3", f, ["/U", "/V1", "/V2"], { d11: { lookalikes: 3 } });
  await replayFails("N8 11: lookalikes at 2 (the group truncated)", f, ["/U", "/V1", "/V2"], { lookalikes: 2 }, /look the same/);
}
async function n8EqualDepth() {
  // (12: two mappings wanting one key at one depth: B's view /U2/F taken by Z (staying), C's view /U2/F (2))
  const f = rows8([["U2", "/U2", "/U2"], ["Z", "/U2/F", null, "file"], ["B", "/b", "/U2/F", "folder", 15], ["C", "/c", "/U2/F (2)", "folder", 15]]);
  const r = await bothOrders("N8 12: equal-depth claims", f, ["/U2/F", "/U2/F (2)"], ["/U2/F (2)", "/U2/F"]);
  // (B's view first in key order: B beside Z at the first free name, C on past it; Z where it is)
  const got = { B: pathOf(r, f.ids.B), C: pathOf(r, f.ids.C), Z: pathOf(r, f.ids.Z) };
  check(J(got) === J({ B: "/U2/F (2)", C: "/U2/F (2) (2)", Z: "/U2/F" }), `…B at /U2/F (2), C at /U2/F (2) (2), Z at /U2/F (${J(got)})`);
}

// ---- the D11 implementation review's vectors (CORR-D11-IMPL-1/2)

async function astraIndependent() {
  // (an independent move into the claimant's folder (J, from outside, to /U/F/new.txt) is no carried row of I, which
  // a settled top beside X: J into X, as in one transaction; I's own rows carried with it)
  const f = outerInner("/U/F", [["X", "/T/F", null, "folder"], ["J", "/outside", "/U/F/new.txt", "file"]]);
  const r = await bothOrders("CORR-1: an independent file below a conflicted top", f, ["/U"], ["/U/F", "/U"]);
  const got = { I: pathOf(r, f.ids.I), X: pathOf(r, f.ids.X), J: pathOf(r, f.ids.J) };
  check(J(got) === J({ I: "/U/F (2)", X: "/U/F", J: "/U/F/new.txt" }), `…I at /U/F (2), X at /U/F, J at /U/F/new.txt (${J(got)})`);
}
async function astraNestedSettled() {
  // (a settled top inside a settled top's view: each one's rows carried with it)
  const f = outerInner("/U/F", [["X", "/T/F", null, "folder"], ["J", "/T/L/F/H", "/U/F/G", "folder", 15], ["Y", "/T/F/G", null, "file"]]);
  await bothOrders("CORR-1: nested settled tops", f, ["/U"], ["/U/F", "/U"]);
}
async function astraConfirmedParent() {
  // (CORR-D11-R1-1: A's view under a folder this device hasn't yet (P, confirmed only): not no-folder; A's lift is left
  // to placement, which makes /dest, and replayed as a debt once /dest is there, as in one transaction)
  const f = rows8([["P", null, "/dest", "folder"], ["A", "/a", "/dest/a", "folder", 15]]);
  const r = await bothOrders("CORR-D11-R1-1: a confirmed-only folder for a large move's view", f, ["/dest"], ["/dest/a", "/dest"]);
  check(pathOf(r, f.ids.A) === "/dest/a" && pathOf(r, f.ids.P) === "/dest" && r.cycles >= 2, `…A at /dest/a after its debt's replay (${J({ A: pathOf(r, f.ids.A), P: pathOf(r, f.ids.P), cycles: r.cycles })})`);
  for (const at of ["pass", "place", "close", "close-settled", "validate", "publish", "sweep1", "sweep1to2"]) await replayRows(`CORR-D11-R1-1: a crash at ${at}`, f, ["/dest"], { cut: at });
}
async function astraMappedParent() {
  // (CORR-D11-R2-1: A's view under /new/dest, inside O's target, though O's source has no /old/dest (P is confirmed
  // only): nothing will be there after the plan, so A's lift is left to placement, as with no mapping at all)
  const f = rows8([["O", "/old", "/new", "folder", 15], ["P", null, "/new/dest", "folder"], ["A", "/a", "/new/dest/a", "folder", 15]]);
  const r = await bothOrders("CORR-D11-R2-1: a confirmed-only folder inside a mapping's target", f, ["/new"], ["/new/dest/a", "/new"]);
  check(pathOf(r, f.ids.A) === "/new/dest/a" && pathOf(r, f.ids.O) === "/new" && r.cycles >= 2, `…A at /new/dest/a after its debt's replay (${J({ A: pathOf(r, f.ids.A), O: pathOf(r, f.ids.O), cycles: r.cycles })})`);
  for (const at of ["pass", "place", "close", "close-settled", "validate", "publish", "sweep1", "sweep1to2"]) await replayRows(`CORR-D11-R2-1: a crash at ${at}`, f, ["/new"], { cut: at });
}
async function astraParentFile() {
  // (X a file: I beside it, and J's view (/U/F/G) under what is then the file X: J stays where I carries it
  // (/U/F (2)/H), listed no-folder, never published under a file; today's one-transaction view puts it under the file)
  const f = outerInner("/U/F", [["X", "/T/F", null, "file"], ["J", "/T/L/F/H", "/U/F/G", "folder", 15]]);
  const paths = { [f.ids.I]: "/U/F (2)", [f.ids.X]: "/U/F", [f.ids.J]: "/U/F (2)/H" };
  const x = await replayRows("CORR-2: a retarget leaves a file as the view's folder (O first)", f, ["/U"], { oracle: false, paths });
  const y = await replayRows("CORR-2: a retarget leaves a file as the view's folder (I first)", f, ["/U/F", "/U"], { oracle: false, paths });
  check(J(x.byId) === J(y.byId), `CORR-2: every identity in the same place in both orders ${J(x.byId) === J(y.byId) ? "" : idDiff(x.byId, y.byId)}`);
  check(x.listed.some(([p, why]) => p === "/U/F (2)/H" && why === "no-folder") && !orphans(x.fin).length, `…J listed no-folder where it is, nothing under a file (${J(x.listed.slice(0, 4))})`);
}

// ---- r8 N2's vectors: an op that relocates two large folders, or writes beneath one it brings back

/** Two workspaces fed the same ops (the same ids, seqs and times): one with D11 (SMALL), one the old way (OLD). */
async function pair() {
  const a = await setupSync(SMALL), b = await setupSync(OLD);
  const both = (o) => [a.op(o), b.op(o)];
  const apply = async (list) => {
    W.configureD11(SMALL);
    await a.apply(list.map((x) => x[0]));
    W.configureD11(OLD);
    await b.apply(list.map((x) => x[1]));
    W.configureD11(SMALL);
  };
  return { a, b, both, apply };
}
/** A folder of `n` files under `path` (fid `id`), its parent `parent`: the ops, from `both`. */
function folderOps(both, path, n, parent, id = hex(16)) {
  const ops = [both({ op: "mkdir", path, kind: "folder", fid: id, ...(parent ? { parent } : {}) })];
  for (let i = 0; i < n; i++) ops.push(both({ op: "create", path: `${path}/f${i}.txt`, kind: "file", fid: hex(16), parent: id, sha256: SHA("a"), size: 3 }));
  return { id, ops };
}
/** Both workspaces' confirmed rows against the reducer, and their entries against each other. */
async function samePair(what, { a, b }, ids = true) {
  const ca = await confirmedRows(a.w, a.ns), want = reducerRows(a.log);
  check(J(ca) === J(want), `${what}: the confirmed rows equal the in-memory reducer's (${ca.length}) ${J(ca) === J(want) ? "" : J(W.LARGE_LOG.slice(-3)) + " " + diff(ca, want).slice(0, 600)}`);
  const ta = (await a.w.list("/", { recursive: true })).map((e) => shape(e, ids)).sort(), tb = (await b.w.list("/", { recursive: true })).map((e) => shape(e, ids)).sort();
  check(J(ta) === J(tb), `${what}: the entries equal the one-transaction view's (${ta.length}) ${J(ta) === J(tb) ? "" : diff(ta, tb)}`);
  check(!(await W.replayOf(a.w, a.ns)) && !(await a.w.rewriteState()), `${what}: nothing left pending`);
}

async function nestedRestoreRename() {
  const t = await pair();
  const P = folderOps(t.both, "/p", 20), X = folderOps(t.both, "/p/x", 2, P.id), Y = folderOps(t.both, "/p/y", 2, P.id), S = folderOps(t.both, "/p/x/S", 15, X.id);
  await t.apply([...P.ops, ...X.ops, ...Y.ops, ...S.ops]);
  await t.apply([t.both({ op: "remove", path: "/p", to: "/Trash/p", kind: "folder", fid: P.id })]);
  // (a crash in the drain of the next op's rewrite: a page refused once, then resumed)
  let k = 0;
  W.setConfirmedCut(() => { if (++k === 2) throw new Error("crash (test)"); });
  // (S renamed into /p/y, a folder inside P, in Trash: P comes back first, then S moves: two large relocations, nested)
  await t.apply([t.both({ op: "rename", path: "/Trash/p/x/S", to: "/p/y/S2", kind: "folder", fid: S.id, parent: Y.id })]);
  W.setConfirmedCut(null);
  await samePair("nested: a rename into a large folder in Trash (P back, then S moved)", t);
  t.a.w.close(); t.b.w.close();
}

async function disjointRestore() {
  const t = await pair();
  const A = folderOps(t.both, "/a", 15), B = folderOps(t.both, "/b", 15), Bq = folderOps(t.both, "/b/q", 1, B.id);
  await t.apply([...A.ops, ...B.ops, ...Bq.ops]);
  await t.apply([t.both({ op: "remove", path: "/a", to: "/Trash/a", kind: "folder", fid: A.id }), t.both({ op: "remove", path: "/b", to: "/Trash/b", kind: "folder", fid: B.id })]);
  // (A restored into /b/q, a folder inside B, in Trash: B comes back, then A moves there: two disjoint relocations)
  await t.apply([t.both({ op: "restore", path: "/Trash/a", to: "/b/q/a", kind: "folder", fid: A.id, parent: Bq.id })]);
  await samePair("two disjoint relocations (B back, A restored into it)", t);
  t.a.w.close(); t.b.w.close();
}

async function writeInRestored() {
  const t = await pair();
  const P = folderOps(t.both, "/p", 20);
  await t.apply(P.ops);
  const f0 = P.ops[1][0].fid;
  await t.apply([t.both({ op: "remove", path: "/p", to: "/Trash/p", kind: "folder", fid: P.id })]);
  // (a write to a file in P, in Trash: the edit wins, P comes back, the file written at its new path)
  await t.apply([t.both({ op: "write", path: "/Trash/p/f0.txt", kind: "file", fid: f0, sha256: SHA("b"), size: 5, base: SHA("a") })]);
  await samePair("a write inside a large folder in Trash (it comes back, the file written there)", t);
  await t.apply([t.both({ op: "remove", path: "/p", to: "/Trash/p", kind: "folder", fid: P.id })]);
  // (a write with another base: P back, and a conflict copy beside the file)
  await t.apply([t.both({ op: "write", path: "/Trash/p/f1.txt", kind: "file", fid: P.ops[2][0].fid, sha256: SHA("c"), size: 5, base: SHA("d") })]);
  await samePair("a conflicting write inside a large folder in Trash (back, a conflict copy beside it)", t);
  t.a.w.close(); t.b.w.close();
}

async function secondRefused() {
  const t = await pair();
  const P = folderOps(t.both, "/p", 20), X = folderOps(t.both, "/p/x", 1, P.id), Y = folderOps(t.both, "/p/y", 1, P.id), S = folderOps(t.both, "/p/x/S", 12, X.id);
  // (deep and long under S: 3 folders of 240 characters and a file: S's subtree reaches about 740 characters below S)
  let at = "/p/x/S", par = S.id;
  const deep = [];
  for (let i = 0; i < 3; i++) { const id = hex(16); at += "/" + String(i) + "d".repeat(239); deep.push(t.both({ op: "mkdir", path: at, kind: "folder", fid: id, parent: par })); par = id; }
  deep.push(t.both({ op: "create", path: at + "/z.txt", kind: "file", fid: hex(16), parent: par, sha256: SHA("a"), size: 3 }));
  await t.apply([...P.ops, ...X.ops, ...Y.ops, ...S.ops, ...deep]);
  await t.apply([t.both({ op: "remove", path: "/p", to: "/Trash/p", kind: "folder", fid: P.id })]);
  // (S renamed into /p/y under a 250-character name: its subtree would pass 1,024 characters there; refused whole: P
  // stays in Trash, as the in-memory reducer leaves it)
  await t.apply([t.both({ op: "rename", path: "/Trash/p/x/S", to: "/p/y/" + "n".repeat(250), kind: "folder", fid: S.id, parent: Y.id })]);
  await samePair("the second relocation refused: the op skipped whole (P not brought back)", t);
  t.a.w.close(); t.b.w.close();
}

async function confirmedReload() {
  // (the confirmed rewrite held; the page reloaded (a new Workspace), the client's next run resumes it, then the replay)
  const t = await pair();
  const P = folderOps(t.both, "/d", 30);
  await t.apply(P.ops);
  W.setConfirmedCut(() => { throw new Error("held (test)"); });
  W.configureD11({ ...SMALL, fails: 100 });
  const o = t.both({ op: "rename", path: "/d", to: "/e", kind: "folder", fid: P.id });
  const run = t.a.apply([o[0]]).catch((e) => e);
  await sleep(300);
  // (the page goes: its run left behind)
  const name = t.a.w.ws.name;
  W.setConfirmedCut(null);
  W.configureD11(SMALL);
  await run;
  const w2 = await W.Workspace.open({ name, mainName: "main-d11-reload" });
  await W.confirmedIndex(w2)({ ns: t.a.ns, ops: [] });
  W.configureD11(OLD);
  await t.b.apply([o[1]]);
  W.configureD11(SMALL);
  const ca = await confirmedRows(w2, t.a.ns), want = reducerRows(t.a.log);
  check(J(ca) === J(want), `reloaded mid-rewrite: resumed, the confirmed rows equal the reducer's ${J(ca) === J(want) ? "" : diff(ca, want)}`);
  const ta = (await w2.list("/", { recursive: true })).map((e) => shape(e, true)).sort(), tb = (await t.b.w.list("/", { recursive: true })).map((e) => shape(e, true)).sort();
  check(J(ta) === J(tb), `reloaded mid-rewrite: the view replayed after it, equal to the one-transaction view ${J(ta) === J(tb) ? "" : diff(ta, tb)}`);
  w2.close(); t.a.w.close(); t.b.w.close();
}

// ---- the replay's other contracts (r6 §2–§4, r8 N1, N4)

/** A seeded replay set up (not run): the D11 workspace `a`, the oracle `o` (the same seeds), the marker written. */
async function replaySetup(spec, ranges, opts = {}) {
  const f = folders(spec, opts.n ?? 15);
  const conf = [...f.confirmed, ...(opts.confirmed ?? [])], loc = [...f.local, ...(opts.local ?? [])];
  const a = await seeded(SMALL, conf, loc, opts.limits), o = await seeded(OLD, conf, loc);
  W.configureD11({ ...SMALL, ...(opts.d11 ?? {}) });
  await new Promise((ok, no) => {
    const tx = a.w.ws.transaction(["meta", "entries"], "readwrite"), now = Date.now();
    tx.objectStore("meta").put({ gen: a.gp, rid: "c0ffee01", kind: "debts", ranges: ranges.map((r) => r.normalize("NFC")), phase: "pass", start: now, deadline: now + (opts.d11?.deadlineMs ?? 900_000), times: {} }, W.markerKey(a.ns));
    tx.objectStore("entries").put({ path: W.RW, rid: "c0ffee01", kind: "reserved", published: false, rev: 1, n: 0, fails: 0, at: now });
    tx.oncomplete = ok; tx.onerror = () => no(tx.error);
  });
  return { a, o, f, ids: [...new Set(conf.map((x) => x[0]))] };
}
const metaOf = (w, k) => new Promise((ok) => { const r = w.ws.transaction("meta").objectStore("meta").get(k); r.onsuccess = () => ok(r.result); });
const busyOf = async (f) => { try { await f(); return "ok"; } catch (e) { return e?.code ?? String(e); } };
/** Each phase's first page only, `f` called before it. */
const once = (phase, f) => { let done = false; return async (p, m) => { if (p === phase && !done) { done = true; await f(m); } }; };

async function frozenRevision() {
  // (r6 §2: a sender path that skipped the pause (a test seam: the intent revision moved during validation): the
  // publication refuses, the plan dropped, the replay stable, said; nothing visible changed)
  const { a, o } = await replaySetup([["A", "/a", "/b"], ["B", "/b", "/a"]], ["/a", "/b"]);
  const before = await tree(a.w);
  W.REPLAY.before = once("validate", () => new Promise((ok, no) => { const tx = a.w.ws.transaction("meta", "readwrite"); const st = tx.objectStore("meta"); st.put(1e9, `sync:${a.ns}:intentRev`); tx.oncomplete = ok; tx.onerror = () => no(tx.error); }));
  let err;
  try { await W.runReplay(a.w, a.ns); } catch (e) { err = e; }
  W.REPLAY.before = null;
  const m = await W.replayOf(a.w, a.ns);
  check(err instanceof W.ReplayHalted && /inputs change/.test(m?.failed ?? ""), `a changed intent revision at publication: stable failed, said (${J({ err: err?.message?.slice(0, 80), failed: m?.failed?.slice(0, 60) })})`);
  check(J(await tree(a.w)) === J(before) && !(await a.w.rewriteState())?.published, "…nothing visible changed, the plan not published");
  check(!W.SENDER_HOLD.has(a.ns), "…the sender's pause released");
  let again;
  try { await W.runReplay(a.w, a.ns); } catch (e) { again = e; }
  check(again instanceof W.ReplayHalted, "…held: the same page doesn't try again");
  // (a reload tries once more: inputs steady now, it completes)
  W.REPLAY.reload();
  await W.runReplay(a.w, a.ns);
  await oneTransactionView(o.w, o.ns, o.gp, [...new Set((await raw(o.w.ws, "syncIndex")).map((r) => r.id))]);
  check(J(await tree(a.w)) === J(await tree(o.w)), "…a reload: tried once more, completed, equal to the oracle");
  a.w.close(); o.w.close();
}

async function fencedAndUnplanned() {
  // (r8 N1: a planned identity's inputs fenced from its observation; an unplanned one's local change after its
  // observation goes to placement)
  const extraC = [["u0", "/u", "folder"], ["u1", "/u/f.txt", "file"], ["xa", "/x", "folder"]];
  const extraL = [["u0", "/u", "folder"], ["u1", "/u/f.txt", "file"], ["xa", "/x", "folder"]];
  const { a, o } = await replaySetup([["A", "/x/a", "/b"]], ["/b", "/u"], { confirmed: extraC, local: extraL });
  const seen = {};
  W.REPLAY.before = once("validate", async () => {
    seen.top = await busyOf(() => a.w.rename("/x/a", "/x/a2"));
    seen.inside = await busyOf(() => a.w.create("/x/a/new.txt", { content: "n" }));
    seen.ancestor = await busyOf(() => a.w.rename("/x", "/x2"));
    seen.dest = await busyOf(() => a.w.create("/b", { content: "n" }));
    seen.unplanned = await busyOf(() => a.w.rename("/u/f.txt", "/u/g.txt"));
  });
  await W.runReplay(a.w, a.ns);
  W.REPLAY.before = null;
  check(seen.top === "busy" && seen.inside === "busy" && seen.ancestor === "busy" && seen.dest === "busy", `during the plan, the planned top, inside it, its ancestor and its destination: busy (${J(seen)})`);
  check(seen.unplanned === "ok", `an unplanned identity (observed, not fenced) renamed meanwhile: allowed (${seen.unplanned})`);
  await o.w.rename("/u/f.txt", "/u/g.txt");
  const oids = [...new Set((await raw(o.w.ws, "syncIndex")).map((r) => r.id))];
  await oneTransactionView(o.w, o.ns, o.gp, oids);
  const ta = await tree(a.w), tb = await tree(o.w);
  check(J(ta) === J(tb), `…placement applies it, equal to the oracle with the same change ${J(ta) === J(tb) ? "" : diff(ta, tb)}`);
  a.w.close(); o.w.close();
}

async function deadlines() {
  // (r6 §4: past the deadline before the publication: the plan dropped, nothing visible, late, stable; after it:
  // finished, its lateness kept)
  {
    const { a } = await replaySetup([["A", "/a", "/b"], ["B", "/b", "/a"]], ["/a", "/b"], { d11: { deadlineMs: 1000 } });
    const before = await tree(a.w);
    W.REPLAY.before = once("pass", () => sleep(1300));
    let err;
    try { await W.runReplay(a.w, a.ns); } catch (e) { err = e; }
    W.REPLAY.before = null;
    const m = await W.replayOf(a.w, a.ns);
    check(err instanceof W.ReplayHalted && m?.late && /late/.test(m.failed ?? ""), `past the deadline before publication: late, stable, said (${J({ late: m?.late, failed: m?.failed?.slice(0, 50) })})`);
    check(J(await tree(a.w)) === J(before) && !(await a.w.rewriteState())?.published, "…the plan dropped: nothing visible changed");
    a.w.close();
  }
  {
    const { a, o } = await replaySetup([["A", "/a", "/b"], ["B", "/b", "/a"]], ["/a", "/b"], { d11: { deadlineMs: 1000 } });
    W.REPLAY.before = once("sweep", () => sleep(1300));
    await W.runReplay(a.w, a.ns);
    W.REPLAY.before = null;
    await oneTransactionView(o.w, o.ns, o.gp, [...new Set((await raw(o.w.ws, "syncIndex")).map((r) => r.id))]);
    const late = await metaOf(a.w, W.lateKey(a.ns));
    check(J(await tree(a.w)) === J(await tree(o.w)) && late?.rid === "c0ffee01", `past the deadline after publication: finished, equal to the oracle, its lateness kept (${J(late && { rid: late.rid, over: late.end - late.deadline })})`);
    a.w.close(); o.w.close();
  }
}

async function caps() {
  // (r5 §2: past the caps, a stable failed, said, no growth)
  const { a } = await replaySetup([["A", "/a", "/b"], ["B", "/b", "/a"]], ["/a", "/b"], { d11: { large: 1 } });
  const before = await tree(a.w);
  let err;
  try { await W.runReplay(a.w, a.ns); } catch (e) { err = e; }
  const m = await W.replayOf(a.w, a.ns), rows = (await raw(a.w.ws, "entries")).filter((e) => e.path.startsWith(W.MAPS));
  check(err instanceof W.ReplayHalted && /too many large moves/.test(m?.failed ?? "") && rows.length === 0, `a second large mapping past a cap of 1: failed, said, its mappings dropped (${J({ failed: m?.failed?.slice(0, 40), mapRows: rows.length })})`);
  check(J(await tree(a.w)) === J(before), "…nothing visible changed");
  a.w.close();
}

async function debtsReplayed() {
  // (r6 §3: what placement would still lift large is a debt, replayed as the next logical move)
  const extra = [];
  const zc = [], zl = [];
  zc.push(["z0", "/z", "folder"]); zl.push(["z0", "/z", "folder"]);
  for (let i = 0; i < 12; i++) { zc.push([`zf${i}`, `/z/f${i}.txt`, "file"]); zl.push([`zf${i}`, `/z/f${i}.txt`, "file"]); }
  const { a, o } = await replaySetup([["A", "/a", "/b"]], ["/b", "/z"], { confirmed: zc, local: zl });
  const phases = [];
  W.REPLAY.before = async (p, m) => {
    phases.push(m.kind + ":" + p);
    if (p === "place" && m.kind === "debts" && !extra.length) {
      extra.push(1);
      // (Z's local rows moved under it, as an intent changed after the plan would leave it: now a large lift)
      await new Promise((ok, no) => {
        const tx = a.w.ws.transaction("entries", "readwrite"), st = tx.objectStore("entries");
        const r = st.getAll(IDBKeyRange.bound("/z", "/z0", false, true));
        r.onsuccess = () => { for (const e of r.result) { if (e.path !== "/z" && !e.path.startsWith("/z/")) continue; st.delete(e.path); const p = "/zz" + e.path.slice(2); st.put({ ...e, path: p, nkey: (p.slice(0, p.lastIndexOf("/")) || "/") + "\u0000" + p.slice(p.lastIndexOf("/") + 1) }); } };
        tx.oncomplete = ok; tx.onerror = () => no(tx.error);
      });
    }
  };
  await W.runReplay(a.w, a.ns);
  W.REPLAY.before = null;
  await oneTransactionView(o.w, o.ns, o.gp, [...new Set((await raw(o.w.ws, "syncIndex")).map((r) => r.id))]);
  const ta = await tree(a.w), tb = await tree(o.w);
  const rounds = phases.filter((x) => x.endsWith(":pass")).length;
  check(J(ta) === J(tb) && rounds >= 2, `a large lift left by placement: a debt, replayed as the next logical move (${rounds} passes), equal to the oracle ${J(ta) === J(tb) ? "" : diff(ta, tb)}`);
  a.w.close(); o.w.close();
}

// (the user-range rows and the staged rows, read raw: what the cap counts)
const logicalCount = async (w) => {
  const rows = await raw(w.ws, "entries");
  const u = rows.filter((e) => e.path >= "/" && e.path < "0").map((e) => e.path), s = rows.filter((e) => e.path.startsWith(W.STAGE)).length;
  // (the user-range rows outside /a and /b named: what the cap counts besides the swap's)
  return { u: u.length, s, other: u.filter((p) => !/^\/[ab](\/|$)/.test(p)) };
};

async function capDuringSweeps() {
  // (r8 N4: the logical count, staged rows once each and control rows never, in both sweeps)
  const spec = [["A", "/a", "/b"], ["B", "/b", "/a"]];
  const total = 2 * 16;
  // (one more for Trash's own entry, made now: at the cap, a remove that has to make /Trash is refused, as before D11)
  const { a } = await replaySetup(spec, ["/a", "/b"], { limits: { maxEntries: total + 2 } });
  await a.w.create("/t.txt", { content: "t" });
  await a.w.remove("/t.txt");
  await a.w.emptyTrash();
  const seen = [];
  let i = 0;
  W.REPLAY.before = async (p) => {
    if (p !== "sweep") return;
    const rec = await a.w.rewriteState();
    const staged = (await raw(a.w.ws, "entries")).filter((e) => e.path.startsWith(W.STAGE)).length;
    if (!staged || seen.some((s) => s.sweep === rec.sweep)) return;
    const before = await logicalCount(a.w);
    const first = await busyOf(() => a.w.create(`/cap${i++}.txt`, { content: "c" }));
    const second = await busyOf(() => a.w.create(`/cap${i++}.txt`, { content: "c" }));
    // (the one admitted removed for good: Trash keeps an entry, so it is emptied too)
    const rm = await busyOf(() => a.w.remove(`/cap${i - 2}.txt`));
    const et = await busyOf(() => a.w.emptyTrash());
    seen.push({ sweep: rec.sweep, staged, before, first, second, rm, et, after: await logicalCount(a.w) });
  };
  await W.runReplay(a.w, a.ns);
  W.REPLAY.before = null;
  check(seen.length === 2 && seen.every((s) => s.first === "ok" && s.second === "limit"), `at the entries cap during sweep 1 and sweep 2 (staged rows present, control rows too): the last allowed admitted, the next refused (${J(seen)})`);
  a.w.close();
}

async function stagedIndexed() {
  // (r8 N4: a staged row stays in the indexes: its identity counted (the bytes' garbage collection), its ref kept)
  const { a } = await replaySetup([["A", "/a", "/b"], ["B", "/b", "/a"]], ["/a", "/b"]);
  const fid = (await raw(a.w.ws, "entries")).find((e) => e.path === "/a/A0.txt").fid;
  let got = null;
  W.REPLAY.before = async (p) => {
    if (p !== "sweep" || got) return;
    const rows = (await raw(a.w.ws, "entries")).filter((e) => e.fid === fid);
    if (!rows.length || !rows[0].path.startsWith(W.STAGE)) return;
    const n = await new Promise((ok) => { const r = a.w.ws.transaction("entries").objectStore("entries").index("byIdent").count(fid); r.onsuccess = () => ok(r.result); });
    got = { staged: rows[0].path.slice(0, 12), ref: rows[0].ref, byIdent: n };
  };
  await W.runReplay(a.w, a.ns);
  W.REPLAY.before = null;
  check(got && got.byIdent === 1 && got.ref === "/a/A0.txt", `a staged file: counted by its identity (its bytes kept), its ref kept until sweep 2 (${J(got)})`);
  a.w.close();
}

async function localTakeover() {
  // (r2 §5: another tab takes the rewrite over when the driving one goes)
  W.configureD11({ ...SMALL, fails: 100 });
  const opts = names();
  const w1 = await W.Workspace.open(opts);
  await bigTree(w1, 24);
  W.Workspace.rewriteCut = () => { throw new Error("held (test)"); };
  await w1.rename("/big", "/bag");
  const w2 = await W.Workspace.open(opts);
  await sleep(100);
  w1.close();
  W.Workspace.rewriteCut = null;
  void w2.driveRewrite();
  const end = await w2.rewriteSettled(30_000);
  check(!end && (await w2.stat("/bag/s1/f0.txt")) && !(await w2.stat("/big")), `the driving tab gone, the other took the rewrite over and drained it (${J(end && { fails: end.fails, stuck: !!end.stuck })})`);
  w2.close();
}

// ---- the fixtures (run when named: FIXTURE=… / WIDE=…): maximum-width trees, measured and asserted

const DEFAULTS = { ...W.D11 };
/** `f` measured: its time, its longest task (Long Tasks API) with how many there were and the three longest, the heap's
 * growth over its start (sampled every 5 ms). */
async function measured(f) {
  globalThis.gc?.();
  await sleep(200);
  const longs = [];
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push(e.duration); });
  obs.observe({ type: "longtask" });
  const heap0 = performance.memory?.usedJSHeapSize ?? 0;
  let heapMax = heap0;
  const sampler = setInterval(() => { heapMax = Math.max(heapMax, performance.memory?.usedJSHeapSize ?? 0); }, 5);
  const t0 = performance.now();
  let out;
  try { out = await f(); } finally {
    await sleep(50);
    clearInterval(sampler);
    obs.disconnect();
  }
  const top = longs.map(Math.round).sort((a, b) => b - a).slice(0, 3);
  return { out, ms: Math.round(performance.now() - t0), longestTaskMs: Math.round(Math.max(0, ...longs)), longTasks: { count: longs.length, top }, heapMiB: +((heapMax - heap0) / 2 ** 20).toFixed(1) };
}
/** A measurement's long tasks, for a check's text: one sample, so a single spike shows as one. */
function longsOf(m) {
  const { count, top } = m.longTasks;
  return count ? `${count} long task${count === 1 ? "" : "s"}, the longest ${J(top)} ms` : "no long task";
}
async function seedRows(db, store, values, n = 20_000) {
  for (let i = 0; i < values.length; i += n) await new Promise((ok, no) => { const tx = db.transaction(store, "readwrite"), st = tx.objectStore(store); for (const v of values.slice(i, i + n)) st.put(v); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
}
/** A tree of `dirs` × `per` files under `top`, at maximum width (1,024-character paths at depth 32) or short:
 * [id, path, kind] rows, the top first. */
function wideTree(top, dirs, per, wide) {
  const rows = [[hex(16), top, "folder"]];
  let base = top;
  if (wide) {
    base += "/" + "A".repeat(255); rows.push([hex(16), base, "folder"]);
    for (let k = 0; k < 28; k++) { base += "/" + String(k).padStart(2, "0") + "c".repeat(18); rows.push([hex(16), base, "folder"]); }
  }
  for (let d = 0; d < dirs; d++) {
    const dp = `${base}/d${d}`;
    rows.push([hex(16), dp, "folder"]);
    for (let i = 0; i < per; i++) rows.push([hex(16), wide ? `${dp}/${(`f${i}-` + "x".repeat(1024)).slice(0, 1024 - dp.length - 1)}` : `${dp}/f${i}`, "file"]);
  }
  return rows;
}
const pk = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
const entryRow = ([id, path, kind], now) => ({ path, kind, ref: kind === "file" ? path : null, created: now, updated: now, fid: id, ident: id, nkey: pk(path) + "\u0000" + path.slice(path.lastIndexOf("/") + 1).normalize("NFC"), ...(kind === "file" ? { size: 1, rev: 0, migrated: true, sha256: SHA("a"), remote: true } : {}) });
const confRow = (gp, [id, path, kind], now) => ({ ns: gp, id, path, key: path.normalize("NFC"), parentKey: pk(path).normalize("NFC"), kind, fid: id, ...(kind === "file" ? { sha256: SHA("a"), size: 1 } : {}), created: now, updated: now, by: "person", seq: 1 });

async function fixtureLocal(wide) {
  // (the workspace's own move of a 100,000-entry folder, in chunks: published at once, rewritten a page at a time)
  W.configureD11(DEFAULTS);
  const w = await W.Workspace.open(names()), now = Date.now();
  let rows = wideTree("/big", 10, 9_998, wide);
  const n = rows.length;
  await seedRows(w.ws, "entries", rows.map((r) => entryRow(r, now)));
  rows = null;
  let published = 0;
  const m = await measured(async () => {
    const t0 = performance.now();
    await w.rename("/big", "/bag");
    published = performance.now() - t0;
    return w.rewriteSettled(1_200_000);
  });
  const moved = (await new Promise((ok) => { const r = w.ws.transaction("entries").objectStore("entries").count(IDBKeyRange.bound("/bag/", "/bag0")); r.onsuccess = () => ok(r.result); }));
  const what = `the workspace's own move of ${n} ${wide ? "maximum-width " : ""}entries`;
  check(!m.out && moved === n - 1, `${what}: all moved, the record drained (${moved})`);
  check(m.heapMiB < 256, `${what}: heap growth ${m.heapMiB} MiB (under 256 MiB)`);
  check(m.longestTaskMs < 50, `${what}: longest task ${m.longestTaskMs} ms (under 50 ms; one sample: ${longsOf(m)})`);
  check(m.ms <= 300_000, `${what}: rewritten in ${Math.round(m.ms / 1000)} s (at most 300 s)`);
  check(true, `fixture figures (local${wide ? ", wide" : ""}): ` + J({ entries: n, publishMs: Math.round(published), totalMs: m.ms, longestTaskMs: m.longestTaskMs, heapGrowthMiB: m.heapMiB }));
  w.close();
}

async function fixtureConfirmed(wide, kind = "rename") {
  // (a server's move of a 100,000-entry folder through the client's onIndex: the confirmed rewrite, then the view's
  // replay (plan, sweeps, placement): measured end to end, and by component)
  const { w, ns, op } = await setupSync(DEFAULTS);
  const gp = W.genPrefix(ns, 0), now = Date.now();
  let rows = wideTree("/big", 10, 9_998, wide);
  const n = rows.length, big = rows[0][0];
  await seedRows(w.ws, "syncIndex", rows.map((r) => confRow(gp, r, now)));
  await seedRows(w.ws, "entries", rows.map((r) => entryRow(r, now)));
  rows = null;
  await new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); tx.objectStore("meta").put(10, `sync:${ns}:cursor`); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  for (let i = 0; i < 10; i++) op({ op: "noop-seq", path: "/", kind: "folder", fid: big });
  let marker = null, last = "", t0 = performance.now();
  W.REPLAY.before = async (p, m) => {
    marker = m;
    if (p !== last) { console.log(`[d11] ${kind}${wide ? " wide" : ""}: ${p} at ${Math.round(performance.now() - t0)} ms ${J(m.times ?? {})}`); last = p; }
  };
  const said = { told: 0 };
  const pub = setInterval(() => { const l = W.LARGE_LOG.at(-1); if (l?.published && !said.told) { said.told = 1; console.log(`[d11] published at ${Math.round(performance.now() - t0)} ms`); } if (l?.drained && said.told === 1) { said.told = 2; console.log(`[d11] confirmed rewrite drained at ${Math.round(performance.now() - t0)} ms`); } }, 500);
  const forget = kind === "forget";
  t0 = performance.now();
  const m = await measured(() => W.confirmedIndex(w)({ ns, ops: [forget ? op({ op: "forget", path: "/big", kind: "folder", fid: big }) : op({ op: "rename", path: "/big", to: "/bag", kind: "folder", fid: big })] }));
  W.REPLAY.before = null;
  clearInterval(pub);
  const log = W.LARGE_LOG.at(-1);
  const at = forget ? "/big" : "/bag";
  const moved = (await new Promise((ok) => { const r = w.ws.transaction("entries").objectStore("entries").count(IDBKeyRange.bound(at + "/", at + "0")); r.onsuccess = () => ok(r.result); }));
  const times = marker?.times ?? {};
  const rewriteMs = log?.drained && log?.published ? log.drained - log.published : null;
  const what = `a server's ${forget ? "forget" : "move"} of ${n} ${wide ? "maximum-width " : ""}entries`;
  check((forget ? moved === 0 && !(await w.stat("/big")) : moved === n - 1) && !(await W.replayOf(w, ns)), `${what}: its view applied here, nothing pending (${moved} left under ${at})`);
  check(m.heapMiB < 256, `${what}: heap growth ${m.heapMiB} MiB (under 256 MiB)`);
  check(m.longestTaskMs < 50, `${what}: longest task ${m.longestTaskMs} ms (under 50 ms; one sample: ${longsOf(m)})`);
  check(rewriteMs !== null && rewriteMs <= 300_000, `${what}: the confirmed rewrite ${Math.round((rewriteMs ?? 0) / 1000)} s (at most 300 s)`);
  const mv = marker?.moved ?? { D: 0, S: 0 }, bound = mv.D + mv.S ? 300_000 * (mv.D + 2 * mv.S) / (mv.D + mv.S) : 0;
  check((times.sweep ?? 0) <= bound || (!mv.D && !mv.S && !times.sweep), `${what}: the plan's sweeps ${Math.round((times.sweep ?? 0) / 1000)} s (at most ${Math.round(bound / 1000)} s: D ${mv.D}, S ${mv.S})`);
  check((times.pause ?? 0) <= 150_000, `${what}: the sender's pause ${Math.round((times.pause ?? 0) / 1000)} s (at most 150 s)`);
  check(m.ms <= 900_000, `${what}: the whole ${Math.round(m.ms / 1000)} s (at most 900 s)`);
  check(true, `fixture figures (${kind}${wide ? ", wide" : ""}): ` + J({ entries: n, totalMs: m.ms, rewriteMs, moved: marker?.moved ?? null, ...times, longestTaskMs: m.longestTaskMs, heapGrowthMiB: m.heapMiB }));
  w.close();
}

async function fixtureFlat() {
  // (a flat server folder of 100,000 entries (legal on the server, more than a folder here holds): never read whole;
  // a new entry there probes names in batches (r2 §2))
  const { w, ns, op } = await setupSync(DEFAULTS);
  const gp = W.genPrefix(ns, 0), now = Date.now(), flat = hex(16);
  const rows = [[flat, "/flat", "folder"]];
  for (let i = 0; i < 100_000; i++) rows.push([hex(16), `/flat/f${i}.txt`, "file"]);
  // (a series to probe: x.txt, x (2).txt … x (1500).txt taken)
  rows.push([hex(16), "/flat/x.txt", "file"]);
  for (let k = 2; k <= 1500; k++) rows.push([hex(16), `/flat/x (${k}).txt`, "file"]);
  await seedRows(w.ws, "syncIndex", rows.map((r) => confRow(gp, r, now)));
  await new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); tx.objectStore("meta").put(10, `sync:${ns}:cursor`); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  for (let i = 0; i < 10; i++) op({ op: "noop-seq", path: "/", kind: "folder", fid: flat });
  const id = hex(16);
  const m = await measured(() => W.applyOps(w, ns, [op({ op: "create", path: "/flat/x.txt", kind: "file", fid: id, parent: flat, sha256: SHA("b"), size: 2 })]));
  const e = await W.confirmedEntry(w, ns, id);
  check(e?.path === "/flat/x (1501).txt", `a create into a flat folder of ${rows.length - 1}: named past its taken series, as the reducer names it (${e?.path})`);
  check(m.heapMiB < 64 && m.longestTaskMs < 50, `…the folder never read whole: heap growth ${m.heapMiB} MiB, longest task ${m.longestTaskMs} ms (one sample: ${longsOf(m)})`);
  check(true, "fixture figures (flat): " + J({ entries: rows.length, ms: m.ms, longestTaskMs: m.longestTaskMs, heapGrowthMiB: m.heapMiB }));
  w.close();
}

async function persistentFailure() {
  // (a confirmed rewrite page failing every time: after D11.fails, stuck: a Halt, said; a reload tries once more)
  const a = await setupSync(SMALL);
  const t = serverTree(a.op, 30);
  await a.apply(t.ops);
  W.setConfirmedCut(() => { throw new Error("always failing (test)"); });
  let err;
  try { await a.apply([a.op({ op: "rename", path: "/d", to: "/e", kind: "folder", fid: t.d })]); } catch (e) { err = e; }
  const rec = await new Promise((ok) => { const r = a.w.ws.transaction("meta").objectStore("meta").get(W.crecordKey(W.genPrefix(a.ns, 0))); r.onsuccess = () => ok(r.result); });
  check(err && /couldn't be applied/.test(err.message) && rec?.stuck && rec.fails >= 10, `a confirmed page failing ten times in a row: stuck, said (${J({ err: err?.message?.slice(0, 50), fails: rec?.fails })})`);
  W.setConfirmedCut(null);
  await a.apply([]);
  const ca = await confirmedRows(a.w, a.ns), want = reducerRows(a.log);
  check(J(ca) === J(want) && !(await W.replayOf(a.w, a.ns)), "…the fault gone, the next run (a reload's) tries once more and completes, equal to the reducer's");
  a.w.close();
}

async function fixtureMaxPlan(wide) {
  // (r6 §5: the maximum plan, end to end: a server's move of /T to /U whose view needs /T's lift and 98 large folders'
  // (1,001 entries each), a swap and a 3-cycle among them, and 1,000 one-row occupants in chains in the way; within
  // 900 s from the confirmed publication, every component reported.  98 folders keep the local tree under the
  // workspace's 100,000 entries (99,227 here))
  const { w, ns, op } = await setupSync(DEFAULTS);
  const gp = W.genPrefix(ns, 0), now = Date.now();
  const conf = [], loc = [];
  const both = (id, cp, lp, kind) => { conf.push([id, cp, kind]); loc.push([id, lp, kind]); };
  const T = hex(16);
  both(T, "/T", "/T", "folder");
  let C = "/T";
  if (wide) {
    C += "/" + "A".repeat(255); both(hex(16), C, C, "folder");
    for (let k = 0; k < 27; k++) { C += "/" + String(k).padStart(2, "0") + "c".repeat(18); both(hex(16), C, C, "folder"); }
  }
  const N = 98, F = (i) => `${C}/F${String(i).padStart(3, "0")}`;
  // (local places: F0 and F1 swapped, F2 -> F3 -> F4 -> F2, the rest moved under a local folder L)
  const lpath = (i) => (i === 0 ? F(1) : i === 1 ? F(0) : i === 2 ? F(3) : i === 3 ? F(4) : i === 4 ? F(2) : `${C}/L/F${String(i).padStart(3, "0")}`);
  loc.push([hex(16), `${C}/L`, "folder"]);
  for (let i = 0; i < N; i++) {
    const id = hex(16);
    both(id, F(i), lpath(i), "folder");
    // (1,001 entries under each: more than D11.chunk, so each one is a large lift (r6 §5), as `count(under(a)) > chunk`)
    for (let j = 0; j < 1001; j++) {
      const name = wide ? (`f${j}-` + "x".repeat(1024)).slice(0, 1024 - F(i).length - 1) : `f${j}`;
      const lname = wide ? (`f${j}-` + "x".repeat(1024)).slice(0, 1024 - lpath(i).length - 1) : `f${j}`;
      // (the local name the same as the confirmed one, where both fit: a folder moved locally keeps its names)
      const nm = lpath(i).length <= F(i).length ? name : lname;
      both(hex(16), `${F(i)}/${nm}`, `${lpath(i)}/${nm}`, "file");
    }
  }
  // (1,000 occupants: chains of 10 or 11 for F5..F97: the first where F_i comes, each next where the one before goes)
  let made = 0;
  for (let i = 5; i < N && made < 1000; i++) {
    const len = Math.min(i < 75 ? 11 : 10, 1000 - made);
    for (let j = 0; j < len; j++) {
      both(hex(16), `${C}/O${i}_${j}.txt`, j === 0 ? F(i) : `${C}/O${i}_${j - 1}.txt`, "file");
      made++;
    }
  }
  await seedRows(w.ws, "syncIndex", conf.map((r) => confRow(gp, r, now)));
  await seedRows(w.ws, "entries", loc.map((r) => entryRow(r, now)));
  const want = new Map(conf.map(([id, p]) => [id, "/U" + p.slice(2)]));
  const counts = { confirmed: conf.length, local: loc.length, occupants: made };
  conf.length = 0; loc.length = 0;
  await new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); tx.objectStore("meta").put(10, `sync:${ns}:cursor`); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  for (let i = 0; i < 10; i++) op({ op: "noop-seq", path: "/", kind: "folder", fid: T });
  let marker = null, maps = 0;
  W.REPLAY.before = async (p, m) => { marker = m; if (p === "sweep" && !maps) maps = (await w.rewriteState())?.n ?? 0; };
  const m = await measured(() => W.confirmedIndex(w)({ ns, ops: [op({ op: "rename", path: "/T", to: "/U", kind: "folder", fid: T })] }));
  W.REPLAY.before = null;
  await reportPlan(w, ns, `the maximum plan (${maps} mappings${wide ? ", maximum width" : ""})`, `max plan${wide ? ", wide" : ""}`, m, marker, maps, want, counts, 99 + 1000 - 5);
  w.close();
}

async function fixtureChain(wide, folders = 97) {
  // (N8 v3 §8, daybreak3 5: one outer lift (/T -> /U) and one large inner mapping (I, 1,001 entries under it), and a
  // single chain of 1,000 one-row occupants, each closure step finding exactly one: O0 sits where the outer lift
  // carries it onto I's view, and O(j)'s view is where O(j+1) is carried; the rest filled to near 100,000 rows with
  // folders the outer lift carries, all at maximum width)
  const { w, ns, op } = await setupSync(DEFAULTS);
  const gp = W.genPrefix(ns, 0), now = Date.now();
  const conf = [], loc = [];
  const both = (id, cp, lp, kind) => { conf.push([id, cp, kind]); loc.push([id, lp, kind]); };
  const T = hex(16);
  both(T, "/T", "/T", "folder");
  let C = "/T";
  if (wide) {
    C += "/" + "A".repeat(255); both(hex(16), C, C, "folder");
    for (let k = 0; k < 27; k++) { C += "/" + String(k).padStart(2, "0") + "c".repeat(18); both(hex(16), C, C, "folder"); }
  }
  const fill = (dir, j) => (wide ? (`f${j}-` + "x".repeat(1024)).slice(0, 1024 - dir.length - 1) : `f${j}`);
  // (I: in L locally, its view C/I; its names fit both places)
  const I = hex(16), Ic = `${C}/I`, Il = `${C}/L/I`;
  loc.push([hex(16), `${C}/L`, "folder"]);
  both(I, Ic, Il, "folder");
  for (let j = 0; j < 1001; j++) { const nm = fill(Il, j); both(hex(16), `${Ic}/${nm}`, `${Il}/${nm}`, "file"); }
  // (the chain)
  for (let j = 0; j < 1000; j++) both(hex(16), `${C}/O${j}.txt`, j === 0 ? Ic : `${C}/O${j - 1}.txt`, "file");
  // (97 folders the outer lift carries, unchanged locally)
  for (let i = 0; i < folders; i++) {
    const G = `${C}/G${String(i).padStart(3, "0")}`;
    both(hex(16), G, G, "folder");
    for (let j = 0; j < 1001; j++) { const nm = fill(G, j); both(hex(16), `${G}/${nm}`, `${G}/${nm}`, "file"); }
  }
  await seedRows(w.ws, "syncIndex", conf.map((r) => confRow(gp, r, now)));
  await seedRows(w.ws, "entries", loc.map((r) => entryRow(r, now)));
  const want = new Map(conf.map(([id, p]) => [id, "/U" + p.slice(2)]));
  const counts = { confirmed: conf.length, local: loc.length, chain: 1000 };
  conf.length = 0; loc.length = 0;
  await new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); tx.objectStore("meta").put(10, `sync:${ns}:cursor`); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  for (let i = 0; i < 10; i++) op({ op: "noop-seq", path: "/", kind: "folder", fid: T });
  let marker = null, maps = 0;
  W.REPLAY.before = async (p, m) => { marker = m; if (p === "sweep" && !maps) maps = (await w.rewriteState())?.n ?? 0; };
  const m = await measured(() => W.confirmedIndex(w)({ ns, ops: [op({ op: "rename", path: "/T", to: "/U", kind: "folder", fid: T })] }));
  W.REPLAY.before = null;
  await reportPlan(w, ns, `the chain fixture (${maps} mappings${wide ? ", maximum width" : ""})`, `chain${wide ? ", wide" : ""}`, m, marker, maps, want, counts, 1002);
  w.close();
}

/** A plan fixture's assertions and figures (r6 §5, N7 v2 (c), N8 v3 §8). */
async function reportPlan(w, ns, what, label, m, marker, maps, want, counts, least) {
  const log = W.LARGE_LOG.at(-1);
  // (every identity of the server's tree where the server has it: the whole view applied)
  let wrong = 0, first;
  for (const e of await raw(w.ws, "entries")) {
    const p = want.get(e.ident);
    if (p !== undefined && p !== e.path) { wrong++; first ??= [e.path.slice(-40), p.slice(-40)]; }
  }
  const times = marker?.times ?? {}, rewriteMs = log?.drained && log?.published ? log.drained - log.published : null;
  const pending = !!(await W.replayOf(w, ns));
  check(wrong === 0 && !pending, `${what}: every identity where its view puts it, nothing pending (${wrong} wrong ${J(first ?? null)}, pending ${pending})`);
  check(maps >= least, `${what}: at least ${least} mappings`);
  check(m.heapMiB < 256, `${what}: heap growth ${m.heapMiB} MiB (under 256 MiB)`);
  check(m.longestTaskMs < 50, `${what}: longest task ${m.longestTaskMs} ms (under 50 ms; one sample: ${longsOf(m)})`);
  check(rewriteMs !== null && rewriteMs <= 300_000, `${what}: the confirmed rewrite ${Math.round((rewriteMs ?? 0) / 1000)} s (at most 300 s)`);
  const mv = marker?.moved ?? { D: 0, S: 0 }, bound = mv.D + mv.S ? 300_000 * (mv.D + 2 * mv.S) / (mv.D + mv.S) : 0;
  check((times.sweep ?? 0) <= bound && (times.pause ?? 0) <= 150_000, `${what}: sweeps ${Math.round((times.sweep ?? 0) / 1000)} s (at most ${Math.round(bound / 1000)}: D ${mv.D}, S ${mv.S}), the sender's pause ${Math.round((times.pause ?? 0) / 1000)} s (at most 150)`);
  check(m.ms <= 900_000, `${what}: the whole ${Math.round(m.ms / 1000)} s from the page (at most 900 s)`);
  const stores = {};
  for (const n of ["pending", "outbox", "adoptJournal", "ops"]) stores[n] = await new Promise((ok) => { const r = w.ws.transaction(n).objectStore(n).count(); r.onsuccess = () => ok(r.result); r.onerror = () => ok(-1); });
  check(true, `fixture figures (${label}): ` + J({ ...counts, mappings: maps, moved: marker?.moved ?? null, closure: marker?.closure ?? null, validation: marker?.validation ?? null, headroom: marker?.closure && marker?.validation ? { requests: W.D11.closureRequests - marker.closure.requests - marker.validation.requests, rows: W.D11.closureRows - marker.closure.rows - marker.validation.rows } : null, placed: marker?.placed ?? null, stores, totalMs: m.ms, rewriteMs, ...times, longestTaskMs: m.longestTaskMs, heapGrowthMiB: m.heapMiB }));
}

// ---- N6: a large forget, bounded

async function forgetPair() {
  const t = await pair();
  const P = folderOps(t.both, "/p", 20), S = folderOps(t.both, "/p/s", 12, P.id), K = folderOps(t.both, "/p/k", 3, P.id);
  await t.apply([...P.ops, ...S.ops, ...K.ops]);
  return { t, P, S, K };
}
async function forgetPlain() {
  const { t, P } = await forgetPair();
  await t.apply([t.both({ op: "remove", path: "/p", to: "/Trash/p", kind: "folder", fid: P.id })]);
  await t.apply([t.both({ op: "forget", path: "/Trash/p", kind: "folder", fid: P.id })]);
  await samePair("a large forget (N6)", t);
  const ledger = (await raw(t.a.w.ws, "syncIndex")).filter((r) => String(r.ns).includes("~forget"));
  check(ledger.length === 0, `…its ledger empty once replayed (${ledger.length})`);
  t.a.w.close(); t.b.w.close();
}
async function forgetMovedOut() {
  // (astra's CORR-D11-FORGET-1: /p/s moved out locally to /out/s, its files with no intent of their own: found by the
  // ledger, by identity, and treated as today's view treats them)
  const { t, P } = await forgetPair();
  for (const x of [t.a, t.b]) { await x.w.mkdir("/out"); await x.w.rename("/p/s", "/out/s"); }
  await t.apply([t.both({ op: "forget", path: "/p", kind: "folder", fid: P.id })]);
  await samePair("a large forget with a folder moved out locally (no intents below it)", t, false);
  t.a.w.close(); t.b.w.close();
}
async function forgetMovedBetweenPages() {
  // (a folder moved out locally between replay pages, and one moved across the ledger's order)
  const { t, P } = await forgetPair();
  let k = 0;
  W.REPLAY.before = async (p) => {
    if (p !== "forget" || k++ !== 1) return;
    await t.a.w.mkdir("/out").catch(() => {});
    await t.a.w.rename("/p/k", "/out/k").catch(() => {});
    await t.a.w.rename("/p/s/f0.txt", "/p/f0moved.txt").catch(() => {});
  };
  await t.apply([t.both({ op: "forget", path: "/p", kind: "folder", fid: P.id })]);
  W.REPLAY.before = null;
  // (the oracle: the same local changes, then the same view)
  await t.b.w.mkdir("/out").catch(() => {});
  const ta = (await t.a.w.list("/", { recursive: true })).map((e) => e.path).sort();
  const gone = (await raw(t.a.w.ws, "syncIndex")).filter((r) => String(r.ns).includes("~forget")).length;
  check(gone === 0 && !(await W.replayOf(t.a.w, t.a.ns)) && !ta.some((p) => p.startsWith("/p/")), `moves during the replay: every affected identity processed by identity, nothing left under /p, the ledger empty (${J(ta.filter((p) => p !== "/out" && !p.startsWith("/out/")).slice(0, 5))})`);
  t.a.w.close(); t.b.w.close();
}
async function forgetProducerComplete() {
  // (N6 addendum 1: the replay waits for the confirmed rewrite (producer-complete); paused mid-way, driven directly,
  // it does nothing and its marker survives; after a reload, every id replayed, the marker retired only then)
  const { t, P } = await forgetPair();
  W.configureD11({ ...SMALL, fails: 100 });
  let pages = 0;
  W.setConfirmedCut(() => { if (++pages >= 2) throw new Error("producer paused (test)"); });
  const run = t.a.apply([t.both({ op: "forget", path: "/p", kind: "folder", fid: P.id })[0]]).catch((e) => e);
  await sleep(300);
  await W.runReplay(t.a.w, t.a.ns);
  const m = await W.replayOf(t.a.w, t.a.ns);
  const ledger = (await raw(t.a.w.ws, "syncIndex")).filter((r) => String(r.ns).includes("~forget")).length;
  check(m?.kind === "forget" && ledger >= 1 && (await t.a.w.stat("/p/s/f0.txt")), `the producer paused mid-rewrite: the replay driven directly does nothing, its marker kept (${J({ marker: m?.phase, ledger })})`);
  W.setConfirmedCut(null);
  W.configureD11(SMALL);
  await run;
  const w2 = await W.Workspace.open({ name: t.a.w.ws.name, mainName: "main-d11-pc" });
  await W.confirmedIndex(w2)({ ns: t.a.ns, ops: [] });
  W.configureD11(OLD);
  await t.b.apply([t.b.log.at(-1)]);
  W.configureD11(SMALL);
  const left = (await raw(w2.ws, "syncIndex")).filter((r) => String(r.ns).includes("~forget")).length;
  const ta = (await w2.list("/", { recursive: true })).map((e) => shape(e, true)).sort(), tb = (await t.b.w.list("/", { recursive: true })).map((e) => shape(e, true)).sort();
  check(!(await W.replayOf(w2, t.a.ns)) && left === 0 && J(ta) === J(tb), `…a reload: the rewrite finished, every id replayed (the later ledger rows too), the marker retired, equal to the oracle ${J(ta) === J(tb) ? "" : diff(ta, tb)}`);
  w2.close(); t.a.w.close(); t.b.w.close();
}

async function localDuringRebuildView() {
  // (r4 §4: a local large move during a rebuild's view or retire: refused busy; at another phase, made)
  W.configureD11(SMALL);
  const w = await W.Workspace.open(names());
  await bigTree(w, 15);
  const ns = "c".repeat(32) + ":1:" + w.device;
  const put = (k, v) => new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); tx.objectStore("meta").put(v, k); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  await put("sync:current", { ns, epoch: 1 });
  const out = {};
  for (const phase of ["view", "retire", "log"]) {
    await put(`sync:${ns}:pass`, { phase, gen: 1, n0: 1, serverNext: 1 });
    out[phase] = await busyOf(() => w.rename(phase === "log" ? "/big" : "/big", phase === "log" ? "/bag" : "/bog"));
  }
  check(out.view === "busy" && out.retire === "busy" && out.log === "ok", `a local large move during a rebuild's view or retire refused busy, at another phase made (${J(out)})`);
  await w.rewriteSettled(30_000);
  w.close();
}

export async function run(only = "") {
  const fixtures = { local: () => fixtureLocal(false), "local-wide": () => fixtureLocal(true), confirmed: () => fixtureConfirmed(false), "confirmed-wide": () => fixtureConfirmed(true), forget: () => fixtureConfirmed(false, "forget"), "forget-wide": () => fixtureConfirmed(true, "forget"), flat: fixtureFlat, plan: () => fixtureMaxPlan(false), "plan-wide": () => fixtureMaxPlan(true), "plan-chain": () => fixtureChain(false), "plan-chain-wide": () => fixtureChain(true), "plan-chain-small": () => fixtureChain(true, 5) };
  if (only && !String(only).startsWith("case:")) {
    for (const name of only.split(",")) {
      try { await fixtures[name](); } catch (e) { check(false, `${name}: threw ${e?.stack ?? e}`); }
      W.configureD11(DEFAULTS);
    }
    return results;
  }
  W.configureD11(SMALL);
  // (WIDE=case:<name>,<name>: those cases alone)
  const pick = String(only).startsWith("case:") ? String(only).slice(5).split(",") : null;
  for (const t of [astraIndependent, astraNestedSettled, astraParentFile, astraConfirmedParent, astraMappedParent, n8MovesOn, n8Stays, n8StaysY, n8Nfc, n8Folder, n8Planned, n8Unobstructed, n8Vacate, n8Caps, n8CapsNames, n8CapsTx, n8Meter, n8Crashes, n8Legacy, n8EqualDepth, localLarge, localStuckAndReload, localPreflightAbandoned, fenceParticipation, confirmedRename, confirmedHalfMoved, swap, cycle3, nested, deep, direct1, destNested, siblings, mixed, nestedRestoreRename, disjointRestore, writeInRestored, secondRefused, confirmedReload, frozenRevision, fencedAndUnplanned, deadlines, caps, debtsReplayed, capDuringSweeps, stagedIndexed, localTakeover, persistentFailure, forgetPlain, forgetMovedOut, forgetMovedBetweenPages, forgetProducerComplete, localDuringRebuildView]) {
    if (pick && !pick.includes(t.name)) continue;
    // (each case at most 2 minutes: one that hangs is named, and the rest go on)
    let timer;
    try { await Promise.race([t(), new Promise((_, no) => { timer = setTimeout(() => no(new Error("timed out after 120 s")), 120_000); })]); } catch (e) { check(false, `${t.name}: threw ${e?.stack ?? e}`); } finally { clearTimeout(timer); }
    W.Workspace.rewriteCut = null;
    W.setConfirmedCut(null);
    W.REPLAY.before = null;
    W.configureD11(SMALL);
  }
  return results;
}
