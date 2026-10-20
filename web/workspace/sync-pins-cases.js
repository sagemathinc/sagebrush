// The cases of web/workspace/test-workspace-sync-pins.mjs (sync client step 2b-2, design/sync-client.md C2 and its
// "As built" plan): pins at the local commit; bytes kept apart, exempt, orphaned and released; the pending
// summary, its base rule, held writes and their successors; the cap and its collapse; the lease's lifecycle;
// bounded costs.
import * as W from "./ws.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
let n = 0;
const names = () => { n++; return { name: `ws-pin-${n}-${Math.random().toString(36).slice(2, 8)}`, mainName: `main-pin-${n}` }; };
const fresh = async (limits) => { localStorage.clear(); return W.Workspace.open({ ...names(), ...(limits ? { limits: { ...W.LIMITS, ...limits } } : {}) }); };
const J = (x) => JSON.stringify(x);
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => (b ? new TextDecoder().decode(b) : null);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const H = async (s) => hex(await crypto.subtle.digest("SHA-256", typeof s === "string" ? enc(s) : s));
const NS_A = "a".repeat(32) + ":1:" + "0123456789abcdef", NS_B = "b".repeat(32) + ":1:" + "0123456789abcdef";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (db, store, k) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).get(k); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const all = (db, store) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const put = (db, store, v, k) => new Promise((ok, no) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(v, k); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
const pinsOf = async (w, fid) => (await all(w.ws, "pins")).filter((p) => p.id === fid);
const pinBytes = async (w) => (await get(w.ws, "meta", "sync:pinBytes")) ?? 0;
// (the invariant: the total is what pins keep of their own, apart or orphaned)
const totalRight = async (w) => (await pinBytes(w)) === (await all(w.ws, "pins")).filter((p) => "version" in p.storage || p.orphan).reduce((t, p) => t + p.size, 0);
const fails = async (p) => { try { await p; return null; } catch (e) { return e; } };
const token = () => W.reserve(W.LEGACY_MAX * W.COPIES);
async function on(w, ns = NS_A) {
  const lease = await W.switchTo(w, ns), ob = new W.Outbox(w, lease);
  await ob.begin(await w.lastSeq());
  return ob;
}
const was = { pins: { ...W.PINS }, outbox: { ...W.OUTBOX } };
const restore = () => { Object.assign(W.PINS, was.pins); Object.assign(W.OUTBOX, was.outbox); };

async function pinning() {
  const w = await fresh();
  const ob = await on(w);
  const f = await w.create("/f.bin", { content: "c0" });
  let ps = await pinsOf(w, f.fid);
  check(ps.length === 1 && ps[0].sha256 === (await H("c0")) && ps[0].skey === "f:" + f.fid && J(ps[0].storage) === J({ fileBytes: f.fid }) && (await get(w.ws, "meta", "sync:cur:" + f.fid)) === ps[0].seq && (await get(w.ws, "pending", f.fid))?.latest?.seq === ps[0].seq, "a data file made with sync on: its bytes pinned in that change, pointed to as its present ones, and its pending latest noted: " + J(ps));
  await w.write("/f.bin", "a1");
  ps = await pinsOf(w, f.fid);
  const v = (await all(w.ws, "versions")).find((x) => x.fid === f.fid);
  const hc0 = await H("c0"), c0 = ps.find((p) => p.sha256 === hc0);
  check(c0 && "version" in c0.storage && c0.storage.version === v?.id && v.pinned && (await pinBytes(w)) === 2 && (await totalRight(w)), "written over: the bytes it replaced, still pinned, kept apart as a pinned version, charged: " + J({ c0, v }));
  await w.write("/f.bin", "a1");
  check((await pinsOf(w, f.fid)).length === 2, "the same bytes again: no new pin (one per storage)");
  await w.write("/f.bin", "b2");
  await w.write("/f.bin", "", { keepEmpty: false });
  ps = await pinsOf(w, f.fid);
  check(ps.length === 4 && (await pinBytes(w)) === 6 && (await totalRight(w)), "emptied, keepEmpty false: the pinned bytes it replaced kept apart all the same: " + J(ps.map((p) => [p.sha256.slice(0, 6), p.storage])));
  await ob.scan();
  const recs = await ob.records();
  const shas = [await H("c0"), await H("a1"), await H("b2"), await H("")];
  check(recs.length === 4 && J(recs.map((r) => r.op.sha256)) === J(shas) && recs[0].op.base === undefined && recs[1].op.base === shas[0] && recs[2].op.base === shas[1] && recs[3].op.base === shas[2], "scanned: one record per change of bytes (not the repeat), each based on the one before it (allocated), each pin handed over: " + J(recs.map((r) => [r.op.op, r.op.base?.slice(0, 6) ?? null, r.op.sha256.slice(0, 6)])));
  const owned = (await pinsOf(w, f.fid)).every((p) => p.owner?.ns === NS_A);
  const t = await token();
  const got = [];
  for (const r of recs) got.push(dec(await W.bytesFor(w, r, t)));
  t();
  check(owned && J(got) === J(["c0", "a1", "b2", ""]), "each record's bytes read back exactly: present ones, and those kept apart: " + J(got));
  await ob.acked([{ dseq: 1, seq: 11 }]);
  const kept = (await pinsOf(w, f.fid)).length;
  await ob.confirmed([1]);
  const after = await pinsOf(w, f.fid), v0 = await get(w.ws, "versions", v.id);
  check(kept === 4 && after.length === 3 && !v0.pinned && (await pinBytes(w)) === 4 && (await totalRight(w)), "an ack keeps the pin until the echo; confirmed, the pin goes, its version no longer exempt, the total down");
  await ob.acked([{ dseq: 2, code: "missing" }]);
  check((await pinsOf(w, f.fid)).length === 2 && (await totalRight(w)), "refused: its pin released at once");
  w.close();
}

async function exemptions() {
  const w = await fresh({ maxVersions: 1 });
  const ob = await on(w);
  const f = await w.create("/e.bin", { content: "e0" });
  for (const x of ["e1", "e2", "e3"]) await w.write("/e.bin", x);
  const vs = (await all(w.ws, "versions")).filter((v) => v.fid === f.fid);
  check(vs.length === 3 && vs.every((v) => v.pinned), "pruning (a file's latest 1 version) passes over pinned versions: " + vs.length);
  await w.dropVersions("/e.bin");
  check((await all(w.ws, "versions")).filter((v) => v.fid === f.fid).length === 3, "dropVersions leaves pinned versions");
  await ob.scan();
  const t = await w.remove("/e.bin");
  await w.emptyTrash([t.path]);
  const bytesLeft = await get(w.ws, "fileBytes", f.fid);
  const orphan = (await pinsOf(w, f.fid)).find((p) => p.orphan);
  check(!(await w.stat(t.path)) && dec(bytesLeft) === "e3" && orphan && (await pinBytes(w)) === 8 && (await totalRight(w)) && (await all(w.ws, "versions")).filter((v) => v.fid === f.fid).length === 3, "emptying Trash: the entry gone; its present bytes, pinned, kept (orphaned, charged), its pinned versions kept: " + J({ orphan }));
  const recs = await ob.records(), tk = await token();
  const he3 = await H("e3"), last = recs.find((r) => r.op.sha256 === he3);
  const viaPin = dec(await W.bytesFor(w, last, tk));
  tk();
  check(viaPin === "e3", "…and its record's bytes read through the pin's storage (no entry), its hash checked");
  await ob.confirmed(recs.map((r) => r.dseq));
  check((await get(w.ws, "fileBytes", f.fid)) === undefined && (await pinBytes(w)) === 0 && (await all(w.ws, "pins")).length === 0 && (await all(w.ws, "versions")).filter((v) => v.fid === f.fid).every((v) => !v.pinned), "every record confirmed: the pins gone, the orphaned bytes deleted with the last one, the versions ordinary again");
  w.close();
}

async function lifecycle() {
  const nm = names();
  localStorage.clear();
  let w = await W.Workspace.open(nm);
  let ob = await on(w);
  const f = await w.create("/l.bin", { content: "l0" });
  await w.write("/l.bin", "l1");
  await ob.scan();
  // (a reconnect: a new generation, not a lifecycle change: pins and ownership kept, bytes and decisions work)
  const before = await all(w.ws, "pins");
  const re = await W.switchTo(w, NS_A);
  ob = new W.Outbox(w, re);
  await W.cleanPins(w);
  const recs = await ob.records(), tk = await token();
  const back = [];
  for (const r of recs) back.push(dec(await W.bytesFor(w, r, tk)));
  tk();
  check(J(await all(w.ws, "pins")) === J(before) && J(back) === J(["l0", "l1"]), "a reconnect (a new generation, the same namespace): every pin and its ownership kept, the bytes read back: " + J(back));
  // (off: pins purged, records kept (unpinned, said), nothing noted while off; on again: resumed)
  const ep = (await get(w.ws, "meta", "sync:epoch")) ?? 0;
  await W.syncOff(w);
  await W.cleanPins(w);
  const skipped = await get(w.ws, "meta", "sync:skipped");
  check((await all(w.ws, "pins")).length === 0 && (await pinBytes(w)) === 0 && (await get(w.ws, "meta", "sync:epoch")) === ep + 1 && (await ob.status()).count === 2 && skipped?.count >= 1, "sync off: every pin released (records kept, now unpinned, said in sync:skipped), the total 0, the epoch moved on: " + J(skipped));
  const pend = J(await get(w.ws, "pending", f.fid));
  await w.write("/l.bin", "off");
  check((await all(w.ws, "pins")).length === 0 && J(await get(w.ws, "pending", f.fid)) === pend, "while off: no pin, no pending note");
  const fenced = await fails(ob.records());
  const on2 = await W.switchTo(w, NS_A);
  ob = new W.Outbox(w, on2);
  const st = await ob.status();
  await ob.scan();
  const r3 = await ob.records();
  // (its records unpinned by the purge: the change made while off held until the newest is decided, then sent as
  // the current state, once)
  await ob.acked([{ dseq: 2, seq: 2 }]);
  await ob.scan();
  const r4 = await ob.records();
  check(fenced instanceof W.Fenced && st.count === 2 && r3.length === 2 && r4.length === 3 && r4.at(-1).op.sha256 === (await H("off")) && r4.at(-1).op.base === (await H("l1")), "on again (the same namespace): the old lease fenced, its outbox resumed; the change made while off held behind its unpinned record, then sent once, as the current state: " + J(r4.map((r) => r.op.sha256.slice(0, 6))));
  // (off then on before the purge has run: the new lease's pins survive it)
  await W.syncOff(w);
  const on3 = await W.switchTo(w, NS_A);
  ob = new W.Outbox(w, on3);
  await w.write("/l.bin", "new");
  const hnew = await H("new"), fresh = (await pinsOf(w, f.fid)).find((p) => p.sha256 === hnew);
  await W.cleanPins(w);
  check(fresh && (await pinsOf(w, f.fid)).some((p) => p.seq === fresh.seq), "off then on, the old purge not yet run: the new lease's pin survives it (its epoch is newer)");
  // (another namespace: the old one's pins purged, the new one inherits nothing)
  const g = await w.create("/m.bin", { content: "m0" });
  const lb = await W.switchTo(w, NS_B);
  await W.cleanPins(w);
  const obB = new W.Outbox(w, lb);
  await obB.begin(await w.lastSeq());
  await w.write("/m.bin", "m1");
  await obB.scan();
  const rb = await obB.records();
  const pg = await get(w.ws, "pending", g.fid);
  check(!(await pinsOf(w, f.fid)).length && rb.length === 1 && rb[0].op.base === (await H("m0")) && pg.byNs?.[NS_B]?.allocated?.dseq === 1, "a switch to another namespace: the old one's pins purged; the new one's first write based on its own state (the op's base), inheriting no base or bit: " + J({ base: rb[0]?.op.base?.slice(0, 6), byNs: Object.keys(pg.byNs ?? {}) }));
  w.close();
}

// (a record left unpinned (a tiny cap), then writes held until it is decided, then its successor)
async function heldSetup(nm, capBytes = 1) {
  localStorage.clear();
  const w = await W.Workspace.open(nm);
  const ob = await on(w);
  const f = await w.create("/h.bin", { content: "h0" });
  await ob.scan();
  W.PINS.capBytes = capBytes;
  await w.write("/h.bin", "hA");
  await ob.scan();
  await w.write("/h.bin", "hB");
  await ob.scan();
  return { w, ob, f };
}

async function held() {
  try {
    // (accepted: the successor based on A's hash, exactly one record of the current state)
    let { w, ob, f } = await heldSetup(names());
    let recs = await ob.records(), p = await get(w.ws, "pending", f.fid), st = p.byNs[NS_A];
    const skipped = await get(w.ws, "meta", "sync:skipped");
    check(recs.length === 1 && st.held && !st.allocated.pinned && skipped?.count >= 1, "past the cap: the record's pin let go (it is unpinned, said), and later writes held, not sent: " + J({ recs: recs.length, st, skipped }));
    await ob.acked([{ dseq: 1, seq: 1 }]);
    p = await get(w.ws, "pending", f.fid);
    check(p.byNs[NS_A].successor?.base === (await H("h0")) && !p.byNs[NS_A].held, "its record accepted: the successor scheduled, based on its hash (the ack itself allocates nothing)");
    await ob.scan();
    recs = await ob.records();
    check(recs.length === 2 && recs[1].op.sha256 === (await H("hB")) && recs[1].op.base === (await H("h0")) && recs[1].pin !== undefined, "the scan then sends the current state, once, based on the accepted hash, its present bytes pinned for it: " + J(recs.map((r) => [r.op.sha256.slice(0, 6), r.op.base?.slice(0, 6) ?? null])));
    await w.write("/h.bin", "hB");
    await ob.scan();
    check((await ob.records()).length === 2, "…a later write of the same (already represented) state sends nothing more");
    w.close();
    // (writes made after the decision and before the scan: the drain sends the current state, and the cutoff it
    // records passes over those writes, already represented)
    ({ w, ob, f } = await heldSetup(names()));
    await ob.acked([{ dseq: 1, seq: 1 }]);
    // (room now: nothing collapsed, so only the cutoff passes over hC)
    W.PINS.capBytes = 2 ** 20;
    await w.write("/h.bin", "hC");
    await w.write("/h.bin", "hD");
    await ob.scan();
    recs = await ob.records();
    check(recs.length === 2 && recs[1].op.sha256 === (await H("hD")) && recs[1].op.base === (await H("h0")), "writes after the decision, before the scan: one record, the current state; the writes before it passed over (its cutoff): " + J(recs.map((r) => [r.op.sha256?.slice(0, 6), r.op.base?.slice(0, 6)])));
    w.close();
    // (refused missing: based on the confirmed state, here none)
    ({ w, ob, f } = await heldSetup(names()));
    await ob.acked([{ dseq: 1, code: "missing" }]);
    await ob.scan();
    recs = await ob.records();
    check(recs.length === 1 && recs[0].op.sha256 === (await H("hB")) && recs[0].op.base === undefined, "its record refused missing: the current state sent, based on the confirmed (here, none)");
    w.close();
    // (the echo before the ack: an acceptance)
    ({ w, ob, f } = await heldSetup(names()));
    await ob.confirmed([1]);
    await ob.acked([{ dseq: 1, seq: 1 }]);
    await ob.scan();
    recs = await ob.records();
    check(recs.length === 1 && recs[0].op.base === (await H("h0")), "the echo before the ack: taken as the acceptance, the successor based on its hash, the late ack finding nothing");
    w.close();
  } finally { restore(); }
}

async function successorGate() {
  const nm = names();
  try {
    let { w, ob, f } = await heldSetup(nm);
    W.OUTBOX.maxRecords = 1;
    await ob.acked([{ dseq: 1, seq: 1 }]);
    await ob.scan();
    for (const x of ["hC", "hD"]) await w.write("/h.bin", x);
    await ob.scan();
    const waiting = (await ob.records()).length;
    w.close();
    w = await W.Workspace.open(nm);
    ob = new W.Outbox(w, await W.currentLease(w));
    W.OUTBOX.maxRecords = 10_000;
    await ob.scan();
    const recs = await ob.records();
    const latest = recs.filter((r) => r.dseq > 1);
    check(waiting === 1 && latest.length === 1 && latest[0].op.sha256 === (await H("hD")) && latest[0].op.base === (await H("h0")), "a successor waiting for room gates its identity's writes; after more writes and a reload, exactly one record, the current state, based on A: " + J(latest.map((r) => [r.op.sha256.slice(0, 6), r.op.base?.slice(0, 6)])));
    w.close();
  } finally { restore(); }
}

async function gone() {
  try {
    // (the current state gone before the decision: nothing made, nothing brought back, no pin left)
    let { w, ob, f } = await heldSetup(names());
    const t = await w.remove("/h.bin");
    await w.emptyTrash([t.path]);
    await ob.acked([{ dseq: 1, seq: 1 }]);
    await ob.scan();
    const recs = await ob.records(), p = await get(w.ws, "pending", f.fid);
    check(!recs.some((r) => r.op.op === "write" && r.dseq > 1) && recs.some((r) => r.op.op === "forget") && !p?.byNs?.[NS_A]?.held && !p?.byNs?.[NS_A]?.successor && !(await w.stat("/h.bin")) && (await pinsOf(w, f.fid)).filter((x) => !x.owner).length === 0, "the file deleted for good before its record's decision: no write made, nothing brought back, the deletion sent, no pin left: " + J(recs.map((r) => r.op.op)));
    w.close();
    // (renamed: the current state at its present path)
    ({ w, ob, f } = await heldSetup(names()));
    await w.rename("/h.bin", "/d/h2.bin");
    await ob.acked([{ dseq: 1, seq: 1 }]);
    await ob.scan();
    const r2 = (await ob.records()).filter((r) => r.op.op === "write");
    const d = await w.stat("/d");
    check(r2.length === 1 && r2[0].op.path === "/d/h2.bin" && r2[0].op.parent === d.fid, "renamed and moved before its record's decision: the current state sent at its present path and folder: " + J(r2.map((r) => [r.op.path, r.op.parent])));
    w.close();
  } finally { restore(); }
}

async function baseEdge() {
  // (Z confirmed; A accepted, not echoed; B unpinned, refused missing; C held: C based on A, never Z)
  try {
    localStorage.clear();
    const w = await W.Workspace.open(names());
    const ob = await on(w);
    const f = await w.create("/z.bin", { content: "Z" });
    await put(w.ws, "syncIndex", { ns: NS_A, id: f.fid, sha256: await H("Z") });
    await ob.scan();
    await ob.acked([{ dseq: 1, seq: 1 }]);
    await ob.confirmed([1]);
    await w.write("/z.bin", "A");
    await ob.scan();
    await ob.acked([{ dseq: 2, seq: 2 }]);
    W.PINS.capBytes = 1;
    await w.write("/z.bin", "B");
    await ob.scan();
    await w.write("/z.bin", "C");
    await ob.scan();
    const before = (await get(w.ws, "pending", f.fid)).byNs[NS_A];
    await ob.acked([{ dseq: 3, code: "missing" }]);
    await ob.scan();
    const last = (await ob.records()).at(-1);
    check(before.held && before.acceptedTip?.dseq === 2 && last.op.sha256 === (await H("C")) && last.op.base === (await H("A")), "Z confirmed, A accepted but not echoed, B refused missing, C held: C based on A (the newest accepted), never on Z: " + J({ base: last?.op.base?.slice(0, 6) }));
    w.close();
  } finally { restore(); }
}

async function quota() {
  const w = await fresh();
  await on(w);
  const f = await w.create("/q.bin", { content: "q0" });
  const before = J({ pins: await all(w.ws, "pins"), v: await all(w.ws, "versions"), t: await pinBytes(w), e: await w.stat("/q.bin") });
  W.PINS.failAfterPin = true;
  const e = await fails(w.write("/q.bin", "q1"));
  W.PINS.failAfterPin = false;
  const after = J({ pins: await all(w.ws, "pins"), v: await all(w.ws, "versions"), t: await pinBytes(w), e: await w.stat("/q.bin") });
  check(e && after === before && dec((await w.read("/q.bin")).content) === "q0", "a save that fails for the quota after its pin: the change refused whole, nothing half-pinned, the version and the total as they were: " + String(e));
  check(f, "(made)");
  w.close();
}

async function cleanup() {
  // (cut part way: every page all or nothing; then it finishes; no pin leaked, the total right, no orphan left)
  const w = await fresh();
  await on(w);
  const fids = [];
  for (let i = 0; i < 6; i++) { const f = await w.create(`/c${i}.bin`, { content: "c" + i }); fids.push(f.fid); await w.write(`/c${i}.bin`, "d" + i); }
  // (a leak, as if left: bytes marked orphaned that no pin names any more; and bytes of an entry not yet given its
  // identity key (from before version 4), which the sweep must never touch)
  await put(w.ws, "fileBytes", enc("leaked"), "deadbeefdeadbeef");
  await put(w.ws, "meta", 1, "sync:orphan:deadbeefdeadbeef");
  await put(w.ws, "entries", { path: "/old.bin", kind: "file", ref: "/old.bin", fid: "0ddba11000000000", migrated: true, size: 3, created: 1, updated: 1, nkey: "/\u0000old.bin" });
  await put(w.ws, "fileBytes", enc("old"), "0ddba11000000000");
  const oldSlice = W.PINS.slice;
  W.PINS.slice = { examine: 2, requests: 400 };
  await W.syncOff(w);
  let pages = 0;
  const realGet = IDBObjectStore.prototype.getAll;
  // (each page cut once at its read: aborted whole)
  let cut = true;
  IDBObjectStore.prototype.getAll = function (...a) { if (cut && this.name === "pins") { cut = false; throw new Error("cut"); } return realGet.apply(this, a); };
  const e = await fails(W.cleanPins(w));
  IDBObjectStore.prototype.getAll = realGet;
  const mid = await totalRight(w);
  await W.cleanPins(w);
  W.PINS.slice = oldSlice;
  check(e && mid && (await all(w.ws, "pins")).length === 0 && (await pinBytes(w)) === 0 && (await get(w.ws, "fileBytes", "deadbeefdeadbeef")) === undefined && dec(await get(w.ws, "fileBytes", "0ddba11000000000")) === "old" && (await Promise.all(fids.map((fid) => get(w.ws, "fileBytes", fid)))).every((b) => b !== undefined), "the cleanup cut part way: nothing half done (the total right), then finished: every pin released, the total 0, the leaked bytes swept, the files' own bytes kept: " + J({ pages }));
  w.close();
}

// (IndexedDB calls made while `f` runs, counted on the stores and indexes)
let lastBreakdown = {}, lastPerTx = 0, lastRecords = 0;
async function counting(f) {
  let calls = 0, records = 0;
  const by = {}, perTx = new Map();
  lastBreakdown = by;
  const saved = [];
  const txOf = (o) => o instanceof IDBCursor ? o.request.transaction : o instanceof IDBIndex ? o.objectStore.transaction : o.transaction;
  const methods = [[IDBObjectStore, ["get", "getAll", "getKey", "getAllKeys", "count", "put", "add", "delete", "openCursor", "openKeyCursor"]], [IDBIndex, ["get", "getAll", "getKey", "getAllKeys", "count", "openCursor", "openKeyCursor"]], [IDBCursor, ["continue", "advance", "update", "delete"]]];
  for (const [C, ms] of methods) for (const m of ms) {
    if (!C.prototype[m]) continue;
    const real = C.prototype[m];
    saved.push([C, m, real]);
    C.prototype[m] = function (...a) {
      calls++;
      const tx = txOf(this);
      perTx.set(tx, (perTx.get(tx) ?? 0) + 1);
      const k = (this instanceof IDBCursor ? "cursor" : this.objectStore ? this.objectStore.name + "." + this.name : this.name) + "." + m + (this.name === "meta" && m === "get" ? ":" + String(a[0]).replace(/:[0-9a-f]{8,}.*/, ":*") : "");
      by[k] = (by[k] ?? 0) + 1;
      const r = real.apply(this, a);
      // (the records a request returns: what it materialises)
      if (m === "getAll" || m === "getAllKeys") r.addEventListener("success", () => { records += r.result.length; });
      else if (m === "get" || m === "openCursor" || m === "openKeyCursor") records++;
      else if (C === IDBCursor && (m === "continue" || m === "advance")) records++;
      return r;
    };
  }
  try { await f(); } finally { for (const [C, m, real] of saved) C.prototype[m] = real; }
  lastPerTx = Math.max(0, ...perTx.values());
  lastRecords = records;
  return calls;
}

// (a collapsing save's own cost: the plain save's, plus the collapse (its pending record, one key range read, at
// most PINS.collapseRelease pins released, each a few calls, the note); a constant, as the plain save's is)
const PLAIN_BOUND = 40, COLLAPSE_BOUND = 64;
/** 200 overwrites of `path` at a 1 MiB cap: each save's IndexedDB calls, apart for the saves that collapsed. */
async function overwrites(w, path) {
  const big = new Uint8Array(64 * 1024);
  const plain = [], collapsing = [], seen = [], runs = [];
  for (let i = 0; i < 200; i++) {
    big[0] = i & 255; big[1] = i >> 8;
    const before = w.pinsCleaning;
    const n = await counting(() => w.write(path, big));
    const collapsed = w.pinsCleaning !== before;
    (collapsed ? collapsing : plain).push(n);
    if ((collapsed ? n > COLLAPSE_BOUND : n > PLAIN_BOUND) && seen.length < 2) seen.push([i, n, lastBreakdown]);
    // (the cleanup a collapsing save begins after it: counted apart, a run at a time)
    if (collapsed) { await counting(() => w.pinsCleaning); runs.push(lastPerTx); }
  }
  return { plain, collapsing, seen, runs };
}
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, min: s[0], median: s[s.length >> 1], max: s.at(-1) }; };

async function tail() {
  // (a long offline tail: 50,000 ops across 1,000 files, then 200 overwrites of one file at a 1 MiB cap: each
  // save at most PLAIN_BOUND IndexedDB calls (COLLAPSE_BOUND for one that collapses), its longest task under
  // 50 ms, each the same as on a workspace with no tail; the cleanup then drains in pages)
  W.PINS.capBytes = 2 ** 20;
  const base = await fresh();
  await on(base);
  await base.create("/t/f0.bin", { content: "t0" });
  let without;
  try { without = await overwrites(base, "/t/f0.bin"); } finally { base.close(); }
  const w = await fresh();
  const ob = await on(w);
  const fids = [];
  for (let i = 0; i < 1000; i++) fids.push((await w.create(`/t/f${i}.bin`, { content: "t" + i })).fid);
  const sample = (await w.ops()).at(-1);
  await new Promise((ok, no) => {
    const tx = w.ws.transaction(["ops"], "readwrite"), st = tx.objectStore("ops");
    for (let i = 0; i < 49_000; i++) { const o = structuredClone(sample); delete o.seq; o.fid = fids[i % 1000]; o.after = { ...o.after, id: o.fid }; st.add(o); }
    tx.oncomplete = ok; tx.onerror = () => no(tx.error);
  });
  W.PINS.capBytes = 2 ** 20;
  let longest = 0, got, late = 0;
  // (long tasks as the browser reports them (it must: the check needs it), and a 10 ms timer's lateness besides)
  const observed = !!PerformanceObserver.supportedEntryTypes?.includes("longtask");
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) longest = Math.max(longest, e.duration); });
  if (observed) obs.observe({ type: "longtask", buffered: false });
  let due = performance.now() + 10;
  const tick = setInterval(() => { const t = performance.now(); late = Math.max(late, t - due); due = t + 10; }, 10);
  try {
    got = await overwrites(w, "/t/f0.bin");
  } finally {
    clearInterval(tick);
    obs.disconnect();
    restore();
  }
  const p = stats(got.plain), c = stats(got.collapsing), p0 = stats(without.plain), c0 = stats(without.collapsing);
  const same = J(p) === J(p0) && J(c) === J(c0);
  check(observed && c.n > 0 && p.max <= PLAIN_BOUND && c.max <= COLLAPSE_BOUND && same && longest < 50 && (await totalRight(w)) && (await pinBytes(w)) <= 2 ** 20, `a 50,000-op tail, then 200 overwrites at a 1 MiB cap: each save at most ${PLAIN_BOUND} IndexedDB calls (${COLLAPSE_BOUND} for one that collapses), the same as with no tail, its longest task under 50 ms, the pinned bytes within the cap: ` + J({ plain: p, collapsing: c, noTail: { plain: p0, collapsing: c0 }, longestTask: Math.round(longest), observed, timerLate: Math.round(late), pinBytes: await pinBytes(w), over: got.seen }));
  // (one identity with many pins (kept apart): a release, and a cleanup page, cost the same few calls)
  const recs = await ob.records();
  await counting(() => W.cleanPins(w));
  check(lastPerTx <= W.PINS.slice.requests, "…a cleanup after, each slice within its requests: " + lastPerTx);
  const r = stats(got.runs);
  // (a run goes slice by slice through the pins, each slice its own transaction within PINS.slice)
  const r0 = stats(without.runs);
  check(r.n === c.n && r.max <= W.PINS.slice.requests && r0.max <= W.PINS.slice.requests, `…the cleanup a collapsing save begins after it: each slice (one transaction) at most ${W.PINS.slice.requests} IndexedDB requests, with the tail and without (its tasks within the 50 ms above): ` + J({ tail: r, noTail: r0 }));
  check(recs.length === 0, "(nothing scanned yet)");
  w.close();
}

async function tipBase() {
  // (A accepted, not yet echoed; B, after it, refused: C's base is A, the newest accepted (not B's local bytes))
  const w = await fresh();
  const ob = await on(w);
  await w.create("/t.bin", { content: "a0" });
  await ob.scan();
  await ob.acked([{ dseq: 1, seq: 1 }]);
  await w.write("/t.bin", "a1");
  await ob.scan();
  await ob.acked([{ dseq: 2, code: "missing" }]);
  await w.write("/t.bin", "a2");
  await ob.scan();
  const recs = await ob.records();
  check(recs.length === 2 && recs.at(-1).op.sha256 === (await H("a2")) && recs.at(-1).op.base === (await H("a0")), "A accepted, B refused, then C: C based on A (the newest accepted), not on B's bytes: " + J(recs.map((r) => [r.dseq, r.op.base?.slice(0, 6)])));
  w.close();
}

async function collapseInSave() {
  // (a collapse frees room in the save itself: the oldest PINS.collapseRelease unowned pins released there,
  // the bytes the save replaces then kept for sync; the cleanup, held back here, does the rest after)
  const kb = (c) => new Uint8Array(1024).fill(c);
  let open;
  try {
    W.PINS.capBytes = 4608;
    W.PINS.cleanAfter = new Promise((r) => (open = r));
    const w = await fresh();
    await on(w);
    const f = await w.create("/c.bin", { content: kb(1) });
    let before, did = false;
    for (let i = 2; i < 12 && !did; i++) {
      before = await pinsOf(w, f.fid);
      const was = w.pinsCleaning;
      await w.write("/c.bin", kb(i));
      did = w.pinsCleaning !== was;
    }
    const after = await pinsOf(w, f.fid), has = (p) => after.some((q) => q.seq === p.seq);
    const old = [...before].sort((x, y) => x.seq - y.seq);
    const cur = old.find((p) => "fileBytes" in p.storage);
    const gone = old.filter((p) => !has(p)).map((p) => p.seq), kept = after.find((p) => p.seq === cur?.seq);
    check(did && gone.length === W.PINS.collapseRelease && J(gone) === J(old.slice(0, W.PINS.collapseRelease).map((p) => p.seq)) && kept && "version" in kept.storage && (await pinBytes(w)) <= 4608 && (await totalRight(w)), "a collapse in the save: the oldest few unowned pins released there, the replaced bytes then kept apart for sync, within the cap: " + J({ did, gone, before: old.length, kept: kept?.storage }));
    open();
    await w.pinsCleaning;
    w.close();
  } finally {
    open?.();
    restore();
  }
}

async function deferredClean() {
  // (the cleanup a collapsing save begins after it (P1): tagged with the save's namespace and epoch, checked in
  // each page's transaction; held back here while sync reconnects, saves, and is turned off and on: nothing
  // owned, and nothing of the new epoch, is taken)
  const kb = (c) => new Uint8Array(1024).fill(c);
  let open;
  const collapseOnce = async (w, path, from) => {
    for (let i = 0; i < 20; i++) {
      const before = w.pinsCleaning;
      await w.write(path, kb(from + i));
      if (w.pinsCleaning !== before) return true;
    }
    return false;
  };
  try {
    W.PINS.capBytes = 2560;
    W.PINS.cleanAfter = new Promise((r) => (open = r));
    const w = await fresh();
    let ob = await on(w);
    await w.create("/d.bin", { content: kb(1) });
    await w.write("/d.bin", kb(2));
    await ob.scan();
    const owned = (await all(w.ws, "pins")).filter((p) => p.owner);
    const did = await collapseOnce(w, "/d.bin", 10);
    // (held back: a reconnect and a later save first)
    ob = new W.Outbox(w, await W.switchTo(w, NS_A));
    await w.write("/d.bin", kb(40));
    open();
    await w.pinsCleaning;
    const left = await all(w.ws, "pins");
    const kept = owned.every((p) => left.some((q) => q.id === p.id && q.seq === p.seq && J(q.owner) === J(p.owner)));
    check(did && owned.length > 0 && kept && (await totalRight(w)), "a collapse's cleanup run after a reconnect and a later save: every owned pin kept, the total right: " + J({ did, owned: owned.length, left: left.length }));
    // (held back again: sync turned off and on, new saves and a scan of the new epoch, then it runs)
    W.PINS.cleanAfter = new Promise((r) => (open = r));
    const did2 = await collapseOnce(w, "/d.bin", 60);
    // (room for the new epoch's pins while the old epoch's are still there, its purge held back too)
    W.PINS.capBytes = 2 ** 20;
    await W.syncOff(w);
    ob = await on(w);
    await w.write("/d.bin", kb(90));
    await w.write("/d.bin", kb(91));
    await ob.scan();
    const ep = (await get(w.ws, "meta", "sync:epoch")) ?? 0;
    const fresh2 = (await all(w.ws, "pins")).filter((p) => p.epoch === ep);
    open();
    await w.pinsCleaning;
    const after = await all(w.ws, "pins");
    const same = fresh2.every((p) => after.some((q) => J(q) === J(p)));
    check(did2 && fresh2.length >= 2 && fresh2.some((p) => p.owner) && same && after.every((p) => p.epoch === ep) && (await totalRight(w)), "…and after sync turned off and on, saves and a scan of the new epoch: nothing of the new epoch taken (owned or not), the old epoch's purged: " + J({ did2, fresh: fresh2.length, after: after.length }));
    w.close();
  } finally {
    open?.();
    restore();
  }
}

async function txCache() {
  // (the lease, the pins' total and the epoch, read once a transaction: a write in it seen by a read after it,
  // and nothing kept past it: a read after the transaction meets it closed)
  const w = await fresh();
  await on(w);
  const tx = w.ws.transaction(["meta"], "readwrite"), meta = tx.objectStore("meta");
  const l0 = await W.liveLease(meta);
  W.metaWrite(meta, "sync:current", { ns: "other", gen: 999 });
  const l1 = await W.liveLease(meta);
  const t0 = await W.pinTotal(meta);
  W.metaWrite(meta, "sync:pinBytes", t0 + 12345);
  const t1 = await W.pinTotal(meta);
  const e0 = await W.epochOf(meta);
  await W.newEpoch(meta);
  const e1 = await W.epochOf(meta);
  const ended = new Promise((r) => (tx.onabort = r));
  tx.abort();
  await ended;
  const late = await fails(W.liveLease(meta)), late2 = await fails(W.pinTotal(meta));
  const kept = await get(w.ws, "meta", "sync:current");
  check(l0?.ns === NS_A && l1?.gen === 999 && l1?.ns === "other" && t1 === t0 + 12345 && e1 === e0 + 1, "a transaction's lease, total and epoch: each written in it seen by a read after in it: " + J({ l1, t0, t1, e0, e1 }));
  check(late?.name === "TransactionInactiveError" && late2?.name === "TransactionInactiveError" && kept?.gen !== 999, "…and none kept past it: a read after it ends meets the closed transaction: " + J([late?.name, late2?.name]));
  w.close();
}

async function pruneStep() {
  // (versions past the age (or the count) go W.PRUNE_STEP a save, oldest first: a backlog of 50 drains, never
  // growing; past the bytes, every one needed goes in the one save)
  const nm = names();
  localStorage.clear();
  let clock = Date.now();
  const w = await W.Workspace.open({ ...nm, now: () => clock, limits: { ...W.LIMITS, maxVersions: 100 } });
  await w.create("/p.txt", { content: "v0" });
  for (let i = 1; i <= 50; i++) { clock += 1000; await w.write("/p.txt", "v" + i); }
  const mine = async () => (await all(w.ws, "versions")).length;
  const start = await mine();
  clock += W.LIMITS.maxVersionAgeMs + 60_000;
  const aged = () => clock - W.LIMITS.maxVersionAgeMs;
  // (the save drops W.PRUNE_STEP and marks the file due; the cleanup it begins after drops the rest, a slice at
  // a time; then each save keeps its own, within the count)
  clock += 1000;
  let open;
  W.PINS.cleanAfter = new Promise((r) => (open = r));
  await w.write("/p.txt", "n0");
  const inSave = start + 1 - (await mine());
  open();
  W.PINS.cleanAfter = null;
  await w.pinsCleaning;
  const afterClean = await mine(), counts = [afterClean];
  for (let k = 1; k < 5; k++) { clock += 1000; await w.write("/p.txt", "n" + k); await w.pinsCleaning; counts.push(await mine()); }
  const old = (await all(w.ws, "versions")).filter((v) => v.t < aged()).length;
  check(start === 50 && inSave === W.PRUNE_STEP && afterClean === 1 && old === 0 && J(counts) === J([1, 2, 3, 4, 5]) && (await get(w.ws, "meta", "versions:due:" + (await w.stat("/p.txt")).fid)) === undefined, `50 versions past the age: ${W.PRUNE_STEP} dropped in the save, the rest by the cleanup after it, none past the age left: ` + J({ start, inSave, counts, old }));
  // (past the bytes: as many as it takes, in the one save)
  for (let i = 0; i < 30; i++) { clock += 1000; await w.write("/p.txt", "x".repeat(100) + i); }
  w.limits = { ...w.limits, maxVersionBytes: 1000 };
  clock += 1000;
  await w.pinsCleaning;
  const n0 = (await all(w.ws, "versions")).length;
  W.PINS.cleanAfter = new Promise((r) => (open = r));
  await w.write("/p.txt", "y".repeat(100));
  const n1 = (await all(w.ws, "versions")).length;
  open();
  W.PINS.cleanAfter = null;
  // (past the bytes: a few in the save (daybreak2's LIMIT-E5C-2), the rest by the cleanup it begins after)
  await w.pinsCleaning;
  const vs = await all(w.ws, "versions"), sum = vs.reduce((t, v) => t + v.size, 0);
  check(n0 + 1 - n1 <= 8 && sum <= 1000 && (await get(w.ws, "meta", "versionBytes")) === sum && (await get(w.ws, "meta", "versions:over")) === undefined, "past the bytes: at most 8 dropped in the save, the rest by the cleanup after it, the total exact: " + J({ inSave: n0 + 1 - n1, sum, n: vs.length }));
  w.close();
}

// (one pin per storage, whatever moved or orphaned them: no storage key named twice)
const onePerStorage = async (w) => { const ks = (await all(w.ws, "pins")).map((p) => p.skey); return new Set(ks).size === ks.length; };

// (the local tree and the server's, as the actual reducer makes it from the records, path for path and identity
// for identity, and the files' bytes)
const reduced = async (w, ob) => {
  const ix = new W.SyncIndex();
  let seq = 1;
  for (const r of await ob.records()) W.reduce(ix, { ...r.op, seq: seq++, device: w.device });
  return ix;
};
const trees = async (w, ob) => {
  const ix = await reduced(w, ob);
  // (in Trash, path and identity: the server keeps a trashed file's last accepted bytes until it is restored,
  // when its successor goes; elsewhere its bytes too)
  const inTrash = (p) => p === "/Trash" || p.startsWith("/Trash/");
  const mine = [...(await w.list("/", { recursive: true })), ...(await w.list("/Trash", { recursive: true }))];
  const local = [...new Map(mine.filter((e) => e.path !== "/Trash" && (e.kind === "file" || e.kind === "folder")).map((e) => [e.path, [e.path, e.fid, e.kind === "file" && !inTrash(e.path) ? e.sha256 : null]])).values()].sort();
  const remote = ix.entries().filter((e) => e.kind === "file" || e.kind === "folder").map((e) => [e.path, e.id, e.kind === "file" && !inTrash(e.path) ? e.sha256 : null]).sort();
  return { same: J(local) === J(remote), local, remote };
};
// (a held identity at `at`: created and scanned (dseq 1 for the create of a file at the root), then, past the
// cap, written twice: its create's pin let go, the writes held)
async function heldAt(nm, at, folders = []) {
  localStorage.clear();
  const w = await W.Workspace.open(nm);
  const ob = await on(w);
  for (const d of folders) await w.mkdir(d);
  const f = await w.create(at, { content: "h0" });
  await ob.scan();
  W.PINS.capBytes = 1;
  await w.write(at, "hA");
  await ob.scan();
  await w.write(at, "hB");
  await ob.scan();
  W.PINS.capBytes = 2 ** 30;
  return { w, ob, f };
}
const dseqOf = async (ob, fid) => (await ob.records()).find((r) => r.id === fid && r.op.op === "create").dseq;
async function reload(w, nm) {
  w.close();
  const w2 = await W.Workspace.open(nm);
  const ob2 = new W.Outbox(w2, await W.switchTo(w2, NS_A));
  return { w: w2, ob: ob2 };
}

async function ordering() {
  // (astra's CORR-E5C-1 and 2, and the schedules around them: a held identity's successor goes after every op
  // before it, of it and of its folders, with the state and place they left; one in Trash isn't brought back;
  // each with a reload in the middle; the local tree and the reduced one the same)
  try {
    // (refused, after a move into a new folder: mkdir, rename, then the write at its new place)
    let nm = names(), { w, ob, f } = await heldAt(nm, "/h.bin");
    await w.rename("/h.bin", "/d/h2.bin");
    ({ w, ob } = await reload(w, nm));
    await ob.acked([{ dseq: await dseqOf(ob, f.fid), code: "missing" }]);
    await ob.scan();
    let t = await trees(w, ob);
    check(t.same, "refused, the file moved into a new folder before the decision (a reload between): the trees the same: " + J({ recs: (await ob.records()).map((r) => [r.op.op, r.op.path, r.op.to ?? null]), ...t }));
    w.close();
    // (removed, and the removal scanned, before an acceptance; then before a refusal; a reload between)
    for (const how of ["accepted", "missing"]) {
      nm = names();
      ({ w, ob, f } = await heldAt(nm, "/h.bin"));
      await w.remove("/h.bin");
      await ob.scan();
      ({ w, ob } = await reload(w, nm));
      const d = await dseqOf(ob, f.fid);
      await ob.acked([how === "accepted" ? { dseq: d, seq: 1 } : { dseq: d, code: "missing" }]);
      await ob.scan();
      t = await trees(w, ob);
      const recs = (await ob.records()).map((r) => [r.op.op, r.op.path]);
      // (refused: the server never had it, so it isn't in the server's Trash either: here only, until it is
      // restored (then it goes) or emptied (nothing the server had is lost); accepted: the same, path for path)
      const same = how === "accepted" ? t.same : J(t.remote) === J([]) && J(t.local) === J([[`/Trash/h.bin`, f.fid, null]]);
      check(same && !recs.some(([op, p]) => op === "write" && p.startsWith("/Trash")), `removed and scanned before it was ${how}: no write brings it back, the trees the same${how === "missing" ? " (but for the file the server never had, in Trash here only)" : ""}: ` + J({ recs, ...t }));
      // (restored: its successor goes then, after the restore, with its bytes)
      await w.restore((await w.list("/Trash")).find((e) => e.fid === f.fid).path);
      await ob.scan();
      t = await trees(w, ob);
      check(t.same, `…restored from Trash: the successor goes after the restore, the trees the same (bytes too): ` + J({ recs: (await ob.records()).map((r) => [r.op.op, r.op.path]), ...t }));
      w.close();
    }
    // (decided first, removed after, before the scan: the removal's record, no write)
    nm = names();
    ({ w, ob, f } = await heldAt(nm, "/h.bin"));
    await ob.acked([{ dseq: await dseqOf(ob, f.fid), seq: 1 }]);
    await w.remove("/h.bin");
    ({ w, ob } = await reload(w, nm));
    await ob.scan();
    t = await trees(w, ob);
    check(t.same, "accepted, then removed before the scan (a reload between): the removal stands, the trees the same: " + J({ recs: (await ob.records()).map((r) => [r.op.op, r.op.path]), ...t }));
    w.close();
    // (a file in a folder put in Trash)
    nm = names();
    ({ w, ob, f } = await heldAt(nm, "/f/h.bin", ["/f"]));
    await w.remove("/f");
    await ob.scan();
    ({ w, ob } = await reload(w, nm));
    await ob.acked([{ dseq: await dseqOf(ob, f.fid), seq: 1 }]);
    await ob.scan();
    t = await trees(w, ob);
    check(t.same, "a file in a folder put in Trash before the decision: not brought out of it, the trees the same: " + J({ recs: (await ob.records()).map((r) => [r.op.op, r.op.path]), ...t }));
    w.close();
    // (a held successor, then its folder renamed: the rename first, the write at the new place)
    nm = names();
    ({ w, ob, f } = await heldAt(nm, "/a/h.bin", ["/a"]));
    await ob.acked([{ dseq: await dseqOf(ob, f.fid), seq: 1 }]);
    await w.rename("/a", "/b");
    ({ w, ob } = await reload(w, nm));
    await ob.scan();
    t = await trees(w, ob);
    check(t.same, "a successor waiting, then its folder renamed (a reload between): the trees the same: " + J({ recs: (await ob.records()).map((r) => [r.op.op, r.op.path, r.op.to ?? null]), ...t }));
    w.close();
    // (then moved into a new folder, then that folder put in Trash: nothing brought back; restored, it goes)
    nm = names();
    ({ w, ob, f } = await heldAt(nm, "/h.bin"));
    await ob.acked([{ dseq: await dseqOf(ob, f.fid), seq: 1 }]);
    await w.rename("/h.bin", "/n/h.bin");
    ({ w, ob } = await reload(w, nm));
    await w.remove("/n");
    await ob.scan();
    t = await trees(w, ob);
    check(t.same && (await ob.records()).every((r) => !(r.op.op === "write" && r.id === f.fid)), "moved into a new folder, then that folder put in Trash: no write, the trees the same: " + J({ recs: (await ob.records()).map((r) => [r.op.op, r.op.path, r.op.to ?? null]), ...t }));
    w.close();
  } finally { restore(); }
}

async function slicedCleanup() {
  // (daybreak2's LIMIT-E5C-1: more than 32,000 tiny pins of collapsed writes, and some of a newer epoch: each slice
  // of the cleanup within its requests and under 50 ms, nothing of the newer epoch taken, all drained by the one
  // cleanup, no reload or save)
  const w = await fresh();
  await on(w);
  const ids = 1000, each = 33;
  await new Promise((ok, no) => {
    const tx = w.ws.transaction(["pins", "pending"], "readwrite"), ps = tx.objectStore("pins"), pd = tx.objectStore("pending");
    for (let i = 0; i < ids; i++) {
      const id = "id" + String(i).padStart(6, "0");
      pd.put({ id, latest: { seq: 1e6, by: "person" }, byNs: { [NS_A]: { collapsed: 1e6 } } });
      for (let k = 0; k < each; k++) { const fid = id + "-" + k; ps.put({ id, seq: k + 1, path: "/x", sha256: "0", size: 1, epoch: 0, storage: { fileBytes: fid }, skey: "f:" + fid }); }
      // (a newer epoch's: never the cleanup's, tagged with epoch 0)
      if (i % 50 === 0) ps.put({ id, seq: 1000, path: "/x", sha256: "0", size: 1, epoch: 1, storage: { fileBytes: id + "-new" }, skey: "f:" + id + "-new" });
    }
    tx.oncomplete = ok; tx.onerror = () => no(tx.error);
  });
  let longest = 0, slices = 0, maxTx = 0;
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) longest = Math.max(longest, e.duration); });
  obs.observe({ type: "longtask", buffered: false });
  const realTx = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...a) { const st = [].concat(a[0]); if (st.includes("pins") && a[1] === "readwrite") slices++; return realTx.apply(this, a); };
  try {
    await counting(() => W.cleanPins(w, { ns: NS_A, epoch: 0 }));
    maxTx = lastPerTx;
  } finally {
    IDBDatabase.prototype.transaction = realTx;
    obs.disconnect();
  }
  const left = await all(w.ws, "pins");
  check(left.length === ids / 50 && left.every((p) => p.epoch === 1) && maxTx <= W.PINS.slice.requests && longest < 50, `33,000 pins of collapsed writes: all released by one cleanup, a slice at a time (each at most ${W.PINS.slice.requests} requests, under 50 ms), the newer epoch's kept: ` + J({ left: left.length, slices, maxTx, longest: Math.round(longest) }));
  w.close();
}

async function versionScale() {
  // (daybreak2's LIMIT-E5C-2: one file with 1,000, 10,000 and 50,000 versions kept for sync: a save reads a
  // bounded few of them, whatever the number, its time and longest task flat, its memory too)
  const out = [];
  let open;
  for (const [n, pinned] of [[1000, true], [10000, true], [50000, true], [50000, false]]) {
    const w = await fresh();
    const f = await w.create("/v.bin", { content: "v" });
    await new Promise((ok, no) => {
      const tx = w.ws.transaction(["versions"], "readwrite"), vs = tx.objectStore("versions");
      for (let i = 0; i < n; i++) vs.add({ fid: f.fid, t: Date.now(), size: 1, sha256: "0", by: "person", device: "d", ...(pinned ? { pinned: true } : { free: f.fid, u: 1 }) });
      tx.oncomplete = ok; tx.onerror = () => no(tx.error);
    });
    // (not pinned: a backlog the cleanup drains after each save; held back here, so a save's own reads are counted)
    W.PINS.cleanAfter = new Promise((r) => (open = r));
    globalThis.gc?.();
    const heap0 = performance.memory?.usedJSHeapSize ?? 0;
    let longest = 0;
    const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) longest = Math.max(longest, e.duration); });
    obs.observe({ type: "longtask", buffered: false });
    const times = [], recs = [], calls = [];
    for (let k = 0; k < 10; k++) {
      const t0 = performance.now();
      calls.push(await counting(() => w.write("/v.bin", "w" + k)));
      times.push(performance.now() - t0);
      recs.push(lastRecords);
    }
    obs.disconnect();
    open();
    W.PINS.cleanAfter = null;
    globalThis.gc?.();
    const heap = Math.max(0, (performance.memory?.usedJSHeapSize ?? 0) - heap0);
    const sorted = [...times].sort((x, y) => x - y);
    out.push({ n, pinned, median: Math.round(sorted[5] * 10) / 10, ms: Math.round(Math.max(...times)), first: Math.round(times[0]), records: Math.max(...recs), calls: Math.max(...calls), longest: Math.round(longest), heapKB: Math.round(heap / 1024) });
    w.close();
  }
  const [a, , c, d] = out;
  check(d.records <= 60 && d.calls <= a.calls + 2 * W.PRUNE_STEP + 1 && d.longest < 50 && c.records <= a.records && c.records <= 60 && c.calls <= a.calls && out.every((x) => x.longest < 50) && c.median < Math.max(10, 3 * a.median) && c.heapKB < 4096, "one file with 1,000 to 50,000 versions kept for sync, or 50,000 not kept (a released backlog): a save reads a bounded few records, its median time, longest task and memory flat: " + J(out));
}

async function bulkDrop() {
  // (astra's CORR-E5C-3: dropVersions("/") with 1,000 versions kept for sync, then droppable ones after them: it
  // ends, each transaction within its requests, the pinned kept, the others gone, the total exact)
  const w = await fresh();
  await on(w);
  await w.create("/bulk.bin", { content: "b0" });
  for (let i = 1; i <= 1000; i++) await w.write("/bulk.bin", "b" + i);
  await W.syncOff(w);
  // (sync off: the next versions aren't pinned)
  await w.create("/free.bin", { content: "f0" });
  for (let i = 1; i <= 300; i++) await w.write("/free.bin", "f" + i);
  const before = await all(w.ws, "versions");
  const n = await counting(() => w.dropVersions("/"));
  const after = await all(w.ws, "versions");
  const sum = after.reduce((t, v) => t + v.size, 0);
  check(after.length === before.filter((v) => v.pinned).length && after.length >= 1000 && after.every((v) => v.pinned) && (await get(w.ws, "meta", "versionBytes")) === sum && lastPerTx <= 400, "dropVersions(\"/\") past 1,000 versions kept for sync: it ends, the pinned kept, every other one gone, the total exact, each transaction within its requests: " + J({ before: before.length, after: after.length, perTx: lastPerTx, calls: n }));
  // (a file's: its newest `keep`, counted with those kept for sync)
  w.close();
}

async function unpinPrunable() {
  // (versions kept for sync, released when their records are confirmed: prunable again, by the count)
  const w = await fresh({ maxVersions: 2 });
  const ob = await on(w);
  await w.create("/u.bin", { content: "u0" });
  for (let i = 1; i <= 6; i++) await w.write("/u.bin", "u" + i);
  const pinned = (await all(w.ws, "versions")).filter((v) => v.pinned).length;
  await ob.scan();
  await ob.confirmed((await ob.records()).map((r) => r.dseq));
  const freed = (await all(w.ws, "versions")).filter((v) => !v.pinned && v.free && v.u === 1).length;
  await w.write("/u.bin", "u7");
  await w.pinsCleaning;
  const left = (await all(w.ws, "versions")).length;
  check(pinned === 6 && freed === 6 && left === 2, "versions kept for sync, released: prunable again (in the prunable indexes), the file back to its count: " + J({ pinned, freed, left }));
  w.close();
}

async function caughtUp() {
  // (the successor waits until a scan has read every op: one page of ops (OUTBOX.page) and then a move into a new
  // folder on the next; the trees the same)
  const nm = names();
  let { w, ob, f } = await heldAt(nm, "/h.bin");
  try {
    // (refused: the server never had it, so the successor's write makes it, where it is: after the mkdir its
    // folder needs)
    await ob.acked([{ dseq: await dseqOf(ob, f.fid), code: "missing" }]);
    W.OUTBOX.page = 4;
    for (let i = 0; i < 6; i++) await w.mkdir("/m" + i);
    await w.rename("/h.bin", "/d/h2.bin");
    await ob.scan();
    const t = await trees(w, ob);
    check(t.same, "a successor waiting while the scan has ops left (pages of 4): it goes after them all, the trees the same: " + J({ recs: (await ob.records()).map((r) => [r.op.op, r.op.path, r.op.to ?? null]), ...t }));
  } finally {
    restore();
    w.close();
  }
}

async function storageInvariant() {
  // (one pin per storage key, after each way pins move or are orphaned: kept apart, collapsed, emptied from
  // Trash (orphaned), drained as a successor, purged)
  const w = await fresh();
  const ob = await on(w);
  const f = await w.create("/s.bin", { content: "s0" });
  const ok = [];
  for (let i = 1; i <= 4; i++) { await w.write("/s.bin", "s" + i); ok.push(await onePerStorage(w)); }
  await ob.scan();
  ok.push(await onePerStorage(w));
  W.PINS.capBytes = 4;
  for (let i = 5; i <= 9; i++) { await w.write("/s.bin", "s" + i); await w.pinsCleaning; ok.push(await onePerStorage(w)); }
  W.PINS.capBytes = 2 ** 30;
  await w.remove("/s.bin");
  await w.emptyTrash();
  ok.push(await onePerStorage(w));
  await W.syncOff(w);
  await W.cleanPins(w);
  ok.push(await onePerStorage(w));
  restore();
  check(ok.every(Boolean) && f, "one pin per storage after every move: kept apart, collapsed, orphaned, purged: " + J(ok));
  w.close();
}

async function manyPins() {
  // (many pins on one identity, and identical-byte writes: one pin per storage; a release's calls constant)
  const cost = async (k) => {
    const w = await fresh();
    const ob = await on(w);
    await w.create("/m.bin", { content: "m" });
    for (let i = 0; i < k; i++) { await w.write("/m.bin", "x" + i); await w.write("/m.bin", "x" + i); }
    await ob.scan();
    const pins = (await all(w.ws, "pins")).length;
    const recs = await ob.records();
    const calls = await counting(() => ob.confirmed([recs[1].dseq]));
    w.close();
    return { pins, calls, recs: recs.length };
  };
  const few = await cost(5), many = await cost(150);
  check(few.pins === 6 && many.pins === 151 && few.recs === 6 && many.recs === 151 && many.calls === few.calls, "identical-byte writes take no second pin (one per storage), and a release costs the same calls with 6 pins as with 151: " + J({ few, many }));
}

async function upgradeV5() {
  // (a version 4 workspace upgraded: every store the same, the pins' index byStorage added)
  const name = `ws-pin-v4-${Math.random().toString(36).slice(2, 8)}`;
  const db4 = await new Promise((ok, no) => {
    const r = indexedDB.open(name, 4);
    r.onupgradeneeded = () => {
      const db = r.result, e = db.createObjectStore("entries", { keyPath: "path" });
      e.createIndex("byRef", ["kind", "ref"]); e.createIndex("byNfc", "nkey"); e.createIndex("byIdent", "ident");
      db.createObjectStore("boards", { keyPath: "id" }); db.createObjectStore("trash");
      db.createObjectStore("ops", { keyPath: "seq", autoIncrement: true });
      const v = db.createObjectStore("versions", { keyPath: "id", autoIncrement: true }); v.createIndex("byFile", ["fid", "t"]); v.createIndex("byTime", "t");
      db.createObjectStore("versionBytes"); db.createObjectStore("meta"); db.createObjectStore("fileBytes");
      const g = db.createObjectStore("grants", { keyPath: ["doc", "scope"] }); g.createIndex("byDoc", "doc"); g.createIndex("lastUsed", "lastUsed");
      db.createObjectStore("outbox", { keyPath: ["ns", "dseq"] }).createIndex("byIdent", ["ns", "id"]);
      db.createObjectStore("syncIndex", { keyPath: ["ns", "id"] });
      db.createObjectStore("adoptJournal", { keyPath: ["ns", "id"] }).createIndex("byParent", ["ns", "parent"]);
      db.createObjectStore("pins", { keyPath: ["id", "seq"] }); db.createObjectStore("pending", { keyPath: "id" });
    };
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
  await put(db4, "entries", { path: "/x.bin", kind: "file", ref: "/x.bin", fid: "0123456789abcdef", ident: "0123456789abcdef", migrated: true, size: 1, sha256: "a".repeat(64), created: 1, updated: 1, nkey: "/\u0000x.bin" });
  await put(db4, "fileBytes", enc("x"), "0123456789abcdef");
  await put(db4, "meta", "0123456789abcdef", "device");
  const dump = async (db) => { const o = {}; for (const s of [...db.objectStoreNames].sort()) o[s] = J([await new Promise((ok) => { const r = db.transaction(s).objectStore(s).getAllKeys(); r.onsuccess = () => ok(r.result); }), (await all(db, s)).map((v) => (v instanceof Uint8Array ? dec(v) : v))]); return o; };
  const before = await dump(db4);
  db4.close();
  const db5 = await W.openWorkspaceDb(name);
  const after = await dump(db5), idx = [...db5.transaction("pins").objectStore("pins").indexNames];
  check(db5.version === 5 && J(after) === J(before) && J(idx) === J(["byStorage"]), "version 4 to 5: every store the same, byte for byte, and the pins' index byStorage added: " + J(idx));
  db5.close();
}

export async function run() {
  for (const f of [pinning, exemptions, lifecycle, held, successorGate, gone, baseEdge, quota, cleanup, tipBase, collapseInSave, deferredClean, txCache, pruneStep, ordering, slicedCleanup, versionScale, unpinPrunable, caughtUp, bulkDrop, storageInvariant, manyPins, upgradeV5, tail]) {
    try { await f(); } catch (e) { check(false, `${f.name} threw: ${e?.stack ?? e}`); } finally { restore(); }
  }
  return results;
}
