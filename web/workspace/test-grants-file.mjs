// ci: web-runner order=292 runner=bun
// The desktop app's file permissions across launches (web/workspace/grants-file.ts, #1565): the record kept in
// grants.json by where each notebook is, and brought back at the next launch under the notebooks' new ids.
//   bun web/workspace/test-grants-file.mjs
import { restoreGrants, grantsToKeep, keepGrants, grantsSync, mergeGrants, reconcileGrants, startGrants, parseGrants, GRANTS_KEY } from "./grants-file.ts";

let fails = 0, checks = 0;
const ok = (c, what) => { checks++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails++; };
const J = JSON.stringify;
const store = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
// (a workspace: path -> entry, with each notebook's id (ref) as this launch made it)
const workspace = (entries) => ({
  stat: async (p) => entries[p],
  pathOf: async (kind, ref) => Object.entries(entries).find(([, e]) => e.kind === kind && e.ref === ref)?.[0],
});
// (grants.json as the app keeps it, disk.rs: read as the record or "" (none, or not a record); written only over what
// the writer last saw (`expect`), else refused as changed by another window)
const files = () => {
  let kept = ""; const calls = [];
  const now = () => (parseGrants(kept) ? kept : "");
  return { invoke: async (c, a) => { calls.push(c); if (c === "grants_read") return now(); if (c === "grants_write") { if (a.expect !== now()) throw new Error("grants.json was changed by another window"); kept = a.json; return null; } throw new Error(c); }, kept: () => kept, set: (t) => (kept = t), calls };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// launch 1: two workspace notebooks and a notebook file allowed; one more id that's no notebook now
const w1 = workspace({ "/a/one.ipynb": { kind: "notebook", ref: "r1" }, "/b/two.ipynb": { kind: "notebook", ref: "r2" }, "/data.csv": { kind: "file", ref: null } });
const rec1 = { v: 1, seq: 9, migrated: 1, docs: { r1: { write: ["/a"], t: 3 }, r2: { write: ["/b/out"], denied: [["write", "/b", 4]], t: 5 }, "file:/Users/x/n.ipynb": { write: ["/"], t: 6 }, gone: { write: ["/z"], t: 7 } } };
const s1 = store({ [GRANTS_KEY]: J(rec1) });
const kept1 = await grantsToKeep(w1, s1);
ok(J(kept1) === J({ v: 1, seq: 9, migrated: 1, docs: { "ws:/a/one.ipynb": rec1.docs.r1, "ws:/b/two.ipynb": rec1.docs.r2, "file:/Users/x/n.ipynb": rec1.docs["file:/Users/x/n.ipynb"] } }), "kept by where each notebook is; a notebook file by its own id; one no longer in the workspace left out: " + J(kept1));

// launch 2: the same notebooks under new ids, one renamed away, one path now a data file
const f = files();
f.set(J({ ...kept1, docs: { ...kept1.docs, "ws:/c/now-a-file.ipynb": { write: ["/c"], t: 8 } } }));
const w2 = workspace({ "/a/one.ipynb": { kind: "notebook", ref: "n1" }, "/b/two.ipynb": { kind: "notebook", ref: "n2" }, "/c/now-a-file.ipynb": { kind: "file", ref: null } });
const s2 = store();
const back = await restoreGrants(w2, f.invoke, s2);
const rec2 = parseGrants(s2.getItem(GRANTS_KEY));
ok(back === 3 && J(Object.keys(rec2.docs).sort()) === J(["file:/Users/x/n.ipynb", "n1", "n2"]) && J(rec2.docs.n1) === J(rec1.docs.r1) && J(rec2.docs.n2) === J(rec1.docs.r2), "brought back under the notebooks' new ids, denials too; a path that isn't a notebook now gives nothing: " + J(rec2));
ok(rec2.seq === 9 && rec2.migrated === 1, "...the record's counter and migration mark kept (no old switch read twice)");

// what this launch already holds wins
const s3 = store({ [GRANTS_KEY]: J({ v: 1, seq: 20, docs: { n1: { write: ["/elsewhere"], t: 20 } } }) });
await restoreGrants(w2, f.invoke, s3);
const rec3 = parseGrants(s3.getItem(GRANTS_KEY));
ok(J(rec3.docs.n1) === J({ write: ["/elsewhere"], t: 20 }) && rec3.seq === 20 && !!rec3.docs.n2, "what this page already holds for a notebook wins over what was kept: " + J(rec3));

// not the page's record: nothing comes back
for (const [bad, why] of [["", "none kept"], ["not json", "not JSON"], [J({ v: 2, docs: {} }), "another version"], [J({ v: 1, docs: [] }), "docs not an object"]]) {
  const fb = files(); fb.set(bad);
  const sb = store();
  ok((await restoreGrants(w2, fb.invoke, sb)) === 0 && sb.getItem(GRANTS_KEY) === null, `nothing comes back from ${why}`);
}

// an entry of grants.json that isn't whole (Codex S14 F2: a string where a list goes, a scope not in its canonical
// form) is left out, the entries beside it kept
{
  const p = parseGrants(J({ v: 1, seq: 3, docs: { "ws:/a.ipynb": { write: "/", t: 1 }, "ws:/b.ipynb": { write: ["/b/../.."], t: 1 }, "ws:/c.ipynb": { write: ["/c"], t: 2 } } }));
  ok(J(p?.docs) === J({ "ws:/c.ipynb": { write: ["/c"], t: 2 } }), "grants.json: an entry that isn't whole is left out, the one beside it kept: " + J(p));
}

// kept at each change, one write at a time, the last one winning
const fk = files(), sk = store({ [GRANTS_KEY]: J(rec1) });
let changed = null;
const k = keepGrants(w1, fk.invoke, (fn) => (changed = fn), sk, 50);
changed();
sk.setItem(GRANTS_KEY, J({ ...rec1, docs: { r1: { write: ["/a", "/a2"], t: 10 } } }));
changed();
await k.flush();
// (two changes in a row: written as one or two writes, the last of them the record as it is after both; a change during
// a write held unfinished making one more is the held-write case below)
const nWrites = fk.calls.filter((c) => c === "grants_write").length;
ok(nWrites >= 1 && nWrites <= 2 && J(parseGrants(fk.kept()).docs) === J({ "ws:/a/one.ipynb": { write: ["/a", "/a2"], t: 10 } }), "kept at each change: the record as it is after the last change is what grants.json holds (" + nWrites + " writes): " + fk.kept());

// the latest change, never lost: a write held unfinished keeps flush() waiting; a write that fails keeps it unwritten,
// flush() rejecting with why, until a write succeeds (tried again by itself, and at the next flush)
{
  let release, mode = "hold", writes = 0, kept = "";
  const invoke = async (c, a) => {
    if (c !== "grants_write") return "";
    writes++;
    if (mode === "hold") await new Promise((r) => (release = r));
    if (mode === "fail") throw new Error("disk full");
    kept = a.json;
  };
  const sh = store({ [GRANTS_KEY]: J(rec1) });
  let changed;
  const g = keepGrants(w1, invoke, (fn) => (changed = fn), sh, 50);
  changed();
  let flushed = false;
  const f1 = g.flush().then(() => (flushed = true));
  await new Promise((r) => setTimeout(r, 100));
  ok(!flushed && g.unwritten, "a write held unfinished: flush() still waits, the change still unwritten");
  // (a denial made while that write is held: the record as it is then is written after it)
  sh.setItem(GRANTS_KEY, J({ ...rec1, docs: { r1: { denied: [["write", "/a", 11]], t: 11 } } }));
  changed();
  mode = "ok"; release();
  await f1;
  ok(flushed && !g.unwritten && J(parseGrants(kept).docs) === J({ "ws:/a/one.ipynb": { denied: [["write", "/a", 11]], t: 11 } }), "...released: flush() resolves only once the latest change (the denial made meanwhile) is in grants.json");
  mode = "fail";
  sh.setItem(GRANTS_KEY, J({ ...rec1, docs: { r1: { write: ["/again"], t: 12 } } }));
  changed();
  const why = await g.flush().then(() => "resolved", (e) => String(e.message));
  ok(why === "grants.json: disk full" && g.unwritten, "a write that fails: flush() rejects, saying why, and the change stays unwritten: " + why);
  const before = writes;
  mode = "ok";
  await new Promise((r) => setTimeout(r, 200));
  ok(writes > before && !g.unwritten && J(parseGrants(kept).docs) === J({ "ws:/a/one.ipynb": { write: ["/again"], t: 12 } }), "...tried again by itself: written once the disk takes it");
  await g.flush();
  ok(!g.unwritten, "...and flush() then resolves");
}

// liveness: a flush with nothing to write, then a change, writes it; and a retry that fires after a successful flush
// (nothing left to write) leaves the next change written too (astra2's two sequences on 5ef00da2)
{
  let writes = 0, fail = false, kept = "";
  const invoke = async (c, a) => { if (c !== "grants_write") return ""; writes++; if (fail) throw new Error("disk full"); kept = a.json; };
  const sl = store({ [GRANTS_KEY]: J(rec1) });
  let changed;
  const g = keepGrants(w1, invoke, (fn) => (changed = fn), sl, 50);
  await g.flush();
  changed();
  await new Promise((r) => setTimeout(r, 30));
  ok(writes === 1 && !g.unwritten, "a clean flush, then a change: the change is written (" + writes + " write)");
  // (a write fails, arming the retry; a flush succeeds before the retry fires; the retry then finds nothing to write)
  fail = true;
  changed();
  await new Promise((r) => setTimeout(r, 10));
  fail = false;
  await g.flush();
  await new Promise((r) => setTimeout(r, 120));
  const before = writes;
  sl.setItem(GRANTS_KEY, J({ ...rec1, docs: { r1: { write: ["/late"], t: 30 } } }));
  changed();
  const done = await Promise.race([g.flush().then(() => "flushed"), new Promise((r) => setTimeout(() => r("stuck"), 1000))]);
  ok(done === "flushed" && writes === before + 1 && !g.unwritten && J(parseGrants(kept).docs) === J({ "ws:/a/one.ipynb": { write: ["/late"], t: 30 } }), "a retry firing after a successful flush: the next change is still written, and flush() resolves: " + J({ done, writes: writes - before }));
}

// the merge, by document: what this page changed since it last saw grants.json kept (made, changed or taken out),
// every other document as grants.json has it
ok(J(mergeGrants({ x: 1, y: 1, z: 1 }, { x: 1, z: 1, w: 1 }, { x: 2, y: 1 })) === J({ x: 2, w: 1 }), "the merge: a change here kept (x), one taken back elsewhere gone (y), one taken out here stays out (z), one made elsewhere comes in (w)");

// two windows of the app (#1541): each its own ids for the same notebooks and its own queue; grants.json written only
// over what its writer last saw (files()).  What one allows or takes back reaches the other, merged by document with
// what that one changed meanwhile; no stale read and no stale write brings a permission back.
{
  const one = { write: ["/a"], t: 1 }, two = { write: ["/b"], t: 2 }, more = { write: ["/a", "/a-more"], t: 9 };
  const wa = workspace({ "/a/one.ipynb": { kind: "notebook", ref: "a1" }, "/b/two.ipynb": { kind: "notebook", ref: "a2" } });
  const wb = workspace({ "/a/one.ipynb": { kind: "notebook", ref: "b1" }, "/b/two.ipynb": { kind: "notebook", ref: "b2" } });
  const docsOf = (st) => parseGrants(st.getItem(GRANTS_KEY))?.docs;
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)));
  const put = (st, docs) => st.setItem(GRANTS_KEY, J({ ...(parseGrants(st.getItem(GRANTS_KEY)) ?? { v: 1, seq: 0 }), docs }));
  // (A allows both notebooks and writes; B starts from that; `binvoke` and `bws`, B's way to the app and workspace)
  const setup = async (binvoke, bws = wb) => {
    const f = files(), sa = store({ [GRANTS_KEY]: J({ v: 1, seq: 4, docs: { a1: one, a2: two } }) }), sb = store();
    const A = grantsSync(wa, f.invoke, sa);
    await A.write();
    const B = grantsSync(bws, binvoke ? binvoke(f) : f.invoke, sb);
    await B.restore();
    // (A then takes two.ipynb's permission back, and writes)
    const revoke = async () => { put(sa, { a1: one }); await A.write(); };
    return { f, sa, sb, A, B, revoke };
  };
  {
    const { f, sb, B, revoke } = await setup();
    put(sb, { ...docsOf(sb), scratch: { write: ["/s"] } });
    await revoke();
    const r = await B.adopt();
    ok(r.changed === 1 && !r.ahead && J(sorted(docsOf(sb))) === J({ b1: one, scratch: { write: ["/s"] } }), "two windows: a permission taken back in one is gone in the other once adopted (by its own ids), what grants.json can't name kept: " + J(docsOf(sb)));
    ok(J((await grantsToKeep(wb, sb)).docs) === J({ "ws:/a/one.ipynb": one }), "two windows: and the other's next write doesn't bring it back");
    ok((await B.adopt()).changed === 0, "two windows: adopting the same grants.json again changes nothing");
    f.set("not json");
    // (read as none, as at launch: nothing stays allowed here but what grants.json can't name; a prompt comes back)
    ok((await B.adopt()).changed === 1 && J(docsOf(sb)) === J({ scratch: { write: ["/s"] } }), "two windows: a grants.json that isn't a record reads as none, as at launch: nothing stays allowed but what it can't name: " + J(docsOf(sb)));
  }
  // (astra2's stale read: an adoption's read of the OLD grants.json held while a newer one, the revocation, is written
  // and adopted: one at a time, so the old read never applies after the newer one)
  {
    let hold = null;
    const { f, sb, B, revoke } = await setup((f) => async (c, a) => { if (c === "grants_read" && hold) { const h = hold, old = f.kept(); hold = null; await h; return old; } return f.invoke(c, a); });
    let release;
    hold = new Promise((r) => (release = r));
    const p1 = B.adopt();
    await sleep(5);
    await revoke();
    const p2 = B.adopt();
    await sleep(5);
    release();
    await Promise.all([p1, p2]);
    ok(J(docsOf(sb)) === J({ b1: one }) && J(parseGrants(f.kept()).docs) === J({ "ws:/a/one.ipynb": one }), "two windows: a read of the old grants.json held while the revocation arrives never brings the permission back: " + J(docsOf(sb)));
  }
  // (a slow workspace during the merge, and the person's Allow made here in the middle of it: merged again, the Allow
  // kept, the revocation taken, and this page left ahead: its write carries both)
  {
    let edit = false;
    const slow = { stat: async (p) => { await sleep(5); return wb.stat(p); }, pathOf: async (k, ref) => { await sleep(5); if (edit) { edit = false; put(sbRef, { ...docsOf(sbRef), b1: more }); } return wb.pathOf(k, ref); } };
    let sbRef;
    const { f, sb, B, revoke } = await setup(undefined, slow);
    sbRef = sb;
    await revoke();
    edit = true;
    const r = await B.adopt();
    ok(J(docsOf(sb)) === J({ b1: more }) && r.ahead, "two windows: the person's Allow made here while a merge waited on the workspace is kept, the revocation taken: " + J(docsOf(sb)));
    await B.write();
    ok(J(parseGrants(f.kept()).docs) === J({ "ws:/a/one.ipynb": more }), "two windows: ...and written, without the permission taken back: " + f.kept());
  }
  // (a stale write: B's Allow, written while A's revocation was already there and B hadn't adopted it; and B's write
  // held in keepGrants while A writes: refused by the app, merged, written again: the revocation stays)
  {
    const { f, sa, sb, A, B, revoke } = await setup();
    put(sb, { ...docsOf(sb), b1: more });
    await revoke();
    await B.write();
    ok(J(parseGrants(f.kept()).docs) === J({ "ws:/a/one.ipynb": more }) && J(docsOf(sb)) === J({ b1: more }), "two windows: a write over a grants.json another window changed is refused, merged, written again: the revocation stays: " + f.kept());
    const r = await A.adopt();
    ok(r.changed === 1 && J(docsOf(sa)) === J({ a1: more }), "two windows: ...and the first window adopts the other's Allow");
  }
  {
    let gate = null;
    const { f, sb, B, revoke } = await setup((f) => async (c, a) => { if (c === "grants_write" && gate) await gate; return f.invoke(c, a); });
    let open, changed;
    gate = new Promise((r) => (open = r));
    const k = keepGrants(wb, null, (fn) => (changed = fn), sb, 50, B);
    put(sb, { ...docsOf(sb), b1: more });
    changed();
    await sleep(10);
    await revoke();
    open();
    gate = null;
    await k.flush();
    ok(!k.unwritten && J(parseGrants(f.kept()).docs) === J({ "ws:/a/one.ipynb": more }), "two windows: a keepGrants write held while the other window revokes: merged and written, the revocation stays: " + f.kept());
  }
}

// grants.json that can't be read after another window's write (astra4's SEC hold): fail closed.  The page's real
// permissions (web/notebook/permissions.js, over a localStorage of the test's) set aside: the old write denied, no
// Allow made; a later read that succeeds brings them back (reconcileGrants, as the page calls it)
{
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const { createPermissions } = await import("../notebook/permissions.js");
  const perms = createPermissions();
  const f = files(), w = workspace({ "/n.ipynb": { kind: "notebook", ref: "id1" } });
  let broken = false;
  const invoke = async (c, a) => { if (c === "grants_read" && broken) throw new Error("EACCES: permission denied, open 'grants.json'"); return f.invoke(c, a); };
  const sync = grantsSync(w, invoke, localStorage);
  ok(perms.grant("id1", "write", "/allowed").ok && perms.writeTrees("id1").join() === "/allowed", "fail closed: a notebook allowed in /allowed");
  await sync.write();
  await sync.restore();
  // (another window then writes; this one's read of it fails)
  broken = true;
  const r = await reconcileGrants(sync, perms);
  ok(r.failed && r.changed && perms.writeTrees("id1").length === 0 && perms.may("id1", "files") === false && /couldn't read its file permissions/.test(perms.suspended() ?? ""), "fail closed: a read that fails (EACCES) after another window's write sets the grants aside: the old write is denied, and the page is told (changed): " + J({ r, trees: perms.writeTrees("id1"), why: perms.suspended() }));
  const g = perms.grant("id1", "write", "/more");
  ok(!g.ok && g.why === "suspended" && perms.set("id1", "files", true) === false && perms.may("id1", "files") === false, "fail closed: meanwhile no Allow is made, nor held in this page: " + J(g));
  const r2 = await reconcileGrants(sync, perms);
  ok(r2.failed && !r2.changed && perms.writeTrees("id1").length === 0, "fail closed: still failing: still set aside, nothing new to tell");
  broken = false;
  const r3 = await reconcileGrants(sync, perms);
  ok(!r3.failed && r3.changed && perms.suspended() === null && perms.writeTrees("id1").join() === "/allowed" && perms.may("id1", "files") === false, "fail closed: a later read that succeeds brings the grants back, and the page is told: " + J({ r3, trees: perms.writeTrees("id1") }));
  // (and a revocation written meanwhile by the other window is what comes back: not the old grant)
  broken = true;
  await reconcileGrants(sync, perms);
  f.set(J({ v: 1, seq: 9, docs: {} }));
  broken = false;
  await reconcileGrants(sync, perms);
  ok(perms.suspended() === null && perms.writeTrees("id1").length === 0, "fail closed: a revocation written while the read failed is what comes back, not the old grant: " + J(perms.writeTrees("id1")));
  // (no queued write around it: set aside again while the other window has taken a grant back, this page's write (a
  // narrowing made meanwhile, queued in keepGrants) is refused by the app (it isn't over what this page last saw) and
  // can't merge (the read fails): grants.json keeps the revocation, the grants stay set aside)
  ok(perms.grant("id1", "write", "/again").ok, "fail closed: allowed again (/again) while it could be read");
  await sync.write();
  const sawFile = f.kept();
  broken = true;
  await reconcileGrants(sync, perms);
  f.set(J({ v: 1, seq: 11, docs: {} }));
  let changed;
  const k = keepGrants(w, invoke, (fn) => (changed = fn), localStorage, 30, sync);
  perms.deny("id1", "read", "/x");
  changed();
  const why = await k.flush().then(() => "written", (e) => String(e.message));
  ok(why !== "written" && k.unwritten && J(parseGrants(f.kept()).docs) === J({}) && f.kept() !== sawFile && perms.writeTrees("id1").length === 0, "fail closed: a write queued while set aside doesn't put the old grant back in grants.json: " + J({ why, file: f.kept() }));
  broken = false;
  await reconcileGrants(sync, perms);
  await k.flush();
  ok(!k.unwritten && perms.writeTrees("id1").length === 0 && !JSON.stringify(parseGrants(f.kept()).docs).includes("/again"), "fail closed: ...and once read again, the revocation stands, the narrowing written with it: " + f.kept());
  // (astra2's storage failure: the merge of a revocation can't be stored here (localStorage full); the grants are set
  // aside; a retry of the same grants.json once storage works must merge it again, never take it for done and bring
  // the old grant back.  The oracle: permissions.js's own writeTrees)
  {
    perms.suspend(null);
    ok(perms.grant("id1", "write", "/kept").ok, "storage failure: allowed in /kept");
    await sync.write();
    f.set(J({ v: 1, seq: 20, docs: {} }));
    const real = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = () => { const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; throw e; };
    const r1 = await reconcileGrants(sync, perms);
    globalThis.localStorage.setItem = real;
    ok(r1.failed && perms.writeTrees("id1").length === 0, "storage failure: a merge that can't be stored sets the grants aside: " + J(r1));
    const r2 = await reconcileGrants(sync, perms);
    ok(!r2.failed && perms.suspended() === null && perms.writeTrees("id1").length === 0, "storage failure: the same grants.json tried again is merged again: the revocation holds, the old grant doesn't come back: " + J({ r2, trees: perms.writeTrees("id1") }));
  }
  delete globalThis.localStorage;
}

// at launch (startGrants, Codex S14 F3): every grant set aside first; the listener for another window's change
// registered, and waited for, before grants.json is read; a listener that can't be registered leaves the grants set
// aside, and is tried again.  The oracle: permissions.js's own writeTrees
{
  const launch = async ({ listenFails = 0 } = {}) => {
    const mem = new Map();
    globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
    const { createPermissions } = await import("../notebook/permissions.js");
    const perms = createPermissions();
    const f = files(), w = workspace({ "/n.ipynb": { kind: "notebook", ref: "id1" } });
    // (the last launch's grant, in this page's record and in grants.json)
    perms.grant("id1", "write", "/allowed");
    await grantsSync(w, f.invoke, localStorage).write();
    // (another window takes it back while this launch's first read runs, and says so to whoever listens by then)
    let heard = null, listens = 0, reads = 0, release;
    const registered = new Promise((r) => (release = r));
    const invoke = async (c, a) => {
      if (c === "grants_read" && ++reads === 1) { const old = await f.invoke(c, a); f.set(J({ v: 1, seq: 30, docs: {} })); heard?.(); return old; }
      return f.invoke(c, a);
    };
    const listen = async (fn) => { listens++; await registered; if (listens <= listenFails) throw new Error("event bus not ready"); heard = fn; };
    const told = { n: 0 };
    const sync = grantsSync(w, invoke, localStorage);
    const s = startGrants(sync, perms, listen, { changed: () => told.n++ }, 20, 40);
    return { perms, s, release, told, reads: () => reads, listens: () => listens, f, w, invoke, sync };
  };
  {
    const { perms, s, release, told, reads } = await launch();
    ok(perms.suspended() !== null && perms.writeTrees("id1").length === 0 && told.n === 1, "launch: until the grants are read, every grant is set aside, and the page is told");
    await sleep(10);
    ok(reads() === 0, "launch: grants.json isn't read before the listener is registered");
    release();
    await s.ready;
    await sleep(10);
    ok(perms.suspended() === null && perms.writeTrees("id1").length === 0, "launch: a revocation another window wrote while the first read ran is heard and merged: the old grant doesn't come back: " + J(perms.writeTrees("id1")));
    s.stop();
  }
  {
    const { perms, s, release, listens } = await launch({ listenFails: 1 });
    release();
    await s.ready;
    ok(/can't watch for changes to its file permissions/.test(perms.suspended() ?? "") && perms.writeTrees("id1").length === 0 && !perms.grant("id1", "write", "/more").ok, "launch: a listener that can't be registered leaves every grant set aside, no Allow made (and the launch isn't held up): " + J(perms.suspended()));
    await s.done;
    ok(listens() === 2 && perms.suspended() === null, "launch: ...it is tried again, and once registered the grants come back (as grants.json now says)");
    s.stop();
  }
  // (the listener's first try fails, so the launch goes on, grants.json not yet read; another window has taken the
  // grant back; a change here meanwhile (a denial, of the same notebook) is kept for later, not written: the delay
  // only stops that early write.  What keeps the revocation is the merge: three ways over the grants.json the record
  // here was last merged with (the record's seenFile), and, the notebook changed on both sides, scope by scope)
  {
    const { perms, s, release, f, w, invoke, sync } = await launch({ listenFails: 1 });
    release();
    await s.ready;
    f.set(J({ v: 1, seq: 40, docs: {} }));
    let changed;
    const k = keepGrants(w, invoke, (fn) => (changed = fn), localStorage, 20, sync, s.done);
    perms.deny("id1", "read", "/x", { stored: true });
    changed();
    await sleep(10);
    const early = await k.flush().then(() => "written", (e) => String(e.message));
    ok(J(parseGrants(f.kept()).docs) === J({}) && k.unwritten && /isn't read yet/.test(early), "launch, listener failing: a change before grants.json is read isn't written over another window's revocation (flush says why): " + J({ early, file: f.kept() }));
    await s.done;
    await k.flush();
    ok(!k.unwritten && J(parseGrants(f.kept()).docs["ws:/n.ipynb"]?.denied?.map((x) => x.slice(0, 2))) === J([["read", "/x"]]), "launch, listener failing: ...once grants.json is read and merged, the change held back is written, not lost: " + f.kept());
    ok(!f.kept().includes("/allowed") && perms.writeTrees("id1").length === 0 && !JSON.stringify(parseGrants(localStorage.getItem(GRANTS_KEY))).includes("/allowed"), "launch, listener failing: ...and the grant the other window took back stays gone, here and in grants.json: " + f.kept());
    s.stop();
  }
  delete globalThis.localStorage;
}

// a second window of the same launch opening while the first hasn't yet adopted another window's revocation: the
// record they share still holds the grant, but it was merged with the grants.json that had it (the record's seenFile), so
// the new window's first merge is three ways: the revocation is taken, not undone, and the first window keeps it
{
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const { createPermissions } = await import("../notebook/permissions.js");
  const perms = createPermissions();
  const f = files(), w = workspace({ "/n.ipynb": { kind: "notebook", ref: "id1" } });
  const A = grantsSync(w, f.invoke, localStorage);
  await A.restore();
  ok(perms.grant("id1", "write", "/allowed").ok, "second window: the first allowed /allowed");
  await A.write();
  ok(JSON.parse(localStorage.getItem(GRANTS_KEY)).seenFile === f.kept(), "second window: ...the grants.json it wrote kept beside the record");
  f.set(J({ v: 1, seq: 30, docs: {} }));
  const B = grantsSync(w, f.invoke, localStorage);
  await B.restore();
  ok(perms.writeTrees("id1").length === 0, "second window: opening, it takes the revocation (a three-way first merge): no grant: " + J(perms.writeTrees("id1")));
  await B.write();
  await A.adopt();
  ok(!f.kept().includes("/allowed") && perms.writeTrees("id1").length === 0, "second window: ...it writes, the first adopts: the grant stays gone: " + f.kept());
  // (a merge with no write after it keeps what it merged with too: another window allows /new, the first adopts it;
  // then /new is taken back, and a third window opens before the first adopts that)
  f.set(J({ v: 1, seq: 31, docs: { "ws:/n.ipynb": { write: ["/new"], t: 40 } } }));
  await A.adopt();
  ok(perms.writeTrees("id1").join() === "/new" && JSON.parse(localStorage.getItem(GRANTS_KEY)).seenFile === f.kept(), "second window: a merge (adopt) keeps the grants.json it merged with beside the record");
  f.set(J({ v: 1, seq: 32, docs: {} }));
  await grantsSync(w, f.invoke, localStorage).restore();
  ok(perms.writeTrees("id1").length === 0, "second window: ...so a window opening after /new was taken back takes that too: " + J(perms.writeTrees("id1")));
  delete globalThis.localStorage;
}

// two windows, one record (the windows' shared localStorage) and one grants.json, past their first merge: B allows /a
// and writes; A, which hasn't adopted that, takes /a back and writes. A's write finds B's and merges over the base
// the shared record was last merged with (the record's seenFile: with /a), not A's own (without it): A's revocation is kept
{
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const { createPermissions } = await import("../notebook/permissions.js");
  const perms = createPermissions();
  const f = files(), w = workspace({ "/n.ipynb": { kind: "notebook", ref: "id1" } });
  const A = grantsSync(w, f.invoke, localStorage), B = grantsSync(w, f.invoke, localStorage);
  await A.restore(); await B.restore();
  ok(perms.grant("id1", "write", "/a").ok, "shared base: B allows /a");
  await B.write();
  ok(perms.revoke("id1", "write", "/a") !== false && perms.writeTrees("id1").length === 0, "shared base: A takes /a back");
  await A.write();
  ok(!J(parseGrants(f.kept()).docs).includes("/a") && perms.writeTrees("id1").length === 0, "shared base: A's write merges over the shared base: the revocation is kept, here and in grants.json: " + J({ file: f.kept(), trees: perms.writeTrees("id1") }));
  delete globalThis.localStorage;
}

// the record and its base kept in one write (merges), and a write's end that can't be kept: grants.json written with
// this page's /a, but the record's base can't be moved on (storage fails just then). Another window then takes /a
// back; the next merge doesn't know which base is grants.json's last, so it holds to what both allow: /a stays gone
{
  const mem = new Map();
  let failNext = false;
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { if (failNext) { failNext = false; const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; throw e; } mem.set(k, String(v)); }, removeItem: (k) => mem.delete(k) };
  const { createPermissions } = await import("../notebook/permissions.js");
  const perms = createPermissions();
  const f = files(), w = workspace({ "/n.ipynb": { kind: "notebook", ref: "id1" } });
  let failOnce = true;
  const invoke = async (c, a) => { const r = await f.invoke(c, a); if (c === "grants_write" && failOnce) failNext = !(failOnce = false); return r; };
  f.set(J({ v: 1, seq: 1, docs: {} }));
  const A = grantsSync(w, invoke, localStorage);
  await A.restore();
  const before = JSON.parse(localStorage.getItem(GRANTS_KEY) ?? "{}").seenFile;
  ok(before === f.kept(), "a write's end not kept: the record's base, as restored");
  ok(perms.grant("id1", "write", "/a").ok && perms.grant("id1", "write", "/keep").ok, "a write's end not kept: /a and /keep allowed here");
  await A.write();
  const rec = JSON.parse(localStorage.getItem(GRANTS_KEY));
  ok(f.kept().includes("/a") && rec.seenFile === before && rec.pendingFile === f.kept(), "a write's end not kept: grants.json has /a, the record still its old base, the write marked as begun");
  f.set(J({ v: 1, seq: 9, docs: { "ws:/n.ipynb": { write: ["/keep"], t: 9 } } }));
  await A.adopt();
  const after = JSON.parse(localStorage.getItem(GRANTS_KEY));
  ok(J(perms.writeTrees("id1")) === '["/keep"]' && after.pendingFile === undefined && after.seenFile === f.kept(), "a write's end not kept: ...another window takes /a back: the merge holds to what both bases allow, /a gone, /keep kept, the mark cleared: " + J({ trees: perms.writeTrees("id1"), after }));
  f.set(J({ v: 1, seq: 9, docs: {} }));
  await A.adopt();
  // (a merge's one write failing: the record and its base both as they were, never one without the other)
  const held = localStorage.getItem(GRANTS_KEY);
  f.set(J({ v: 1, seq: 9, docs: { "file:/x/q.ipynb": { write: ["/q"], t: 2 } } }));
  failNext = true;
  const r = await A.adopt();
  ok(r.failed && localStorage.getItem(GRANTS_KEY) === held, "a merge that can't be kept: the record and its base both unchanged (one write)");
  f.set(J({ v: 1, seq: 9, docs: {} }));
  await A.adopt();
  // (a write refused by the app (another window's there) wasn't made: its mark goes before the merge, so this page's
  // own change isn't narrowed away)
  ok(perms.grant("id1", "write", "/b").ok, "a refused write: /b allowed here");
  f.set(J({ v: 1, seq: 10, docs: { "file:/x/o.ipynb": { write: ["/o"], t: 1 } } }));
  await A.write();
  ok(f.kept().includes("/b") && f.kept().includes("/o") && JSON.parse(localStorage.getItem(GRANTS_KEY)).pendingFile === undefined, "a refused write: merged and written again, /b and the other window's /o both in, no mark left: " + f.kept());
  delete globalThis.localStorage;
}

// a notebook changed on both sides since the base, scope by scope: a grant taken back by either is gone, one made by
// either is in, a denial from either kept (the later of two), never more than either side's caps
{
  const base = { "ws:/n": { write: ["/a", "/b"], denied: [["read", "/s", 1]], t: 1 } };
  const file = { "ws:/n": { write: ["/a"], denied: [["read", "/s", 1], ["write", "/z", 5]], t: 5 } };
  const local = { "ws:/n": { write: ["/a", "/b", "/c"], denied: [["write", "/z", 3]], t: 4 } };
  const m = mergeGrants(base, file, local)["ws:/n"];
  ok(J(m.write) === J(["/a", "/c"]) && J(m.denied) === J([["write", "/z", 5]]) && m.t === 5, "both changed: /b taken back (file), /c made (here), /s's denial taken out (here), /z's kept, the later: " + J(m));
  const many = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const big = mergeGrants({ "ws:/n": { write: [], t: 1 } }, { "ws:/n": { write: many("/f", 20), t: 2 } }, { "ws:/n": { write: many("/l", 20), t: 3 } })["ws:/n"];
  ok(big.write.length === 32 && parseGrants(J({ v: 1, docs: { x: big } }))?.docs.x, "both changed, more than a kind may hold: kept within its cap, so the entry stays whole");
  // ("Don't allow file changes" on one side: the other side's new folder goes too, either way round)
  const stop = { "ws:/n": { write: [], denied: [["write", "/", 9]], t: 9 } }, more = { "ws:/n": { write: ["/a", "/new"], t: 3 } }, was = { "ws:/n": { write: ["/a"], t: 1 } };
  ok(J(mergeGrants(was, more, stop)["ws:/n"].write) === "[]" && J(mergeGrants(was, stop, more)["ws:/n"].write) === "[]", "both changed, one side denying every file change: no write grant stays, the other side's new folder included");
  // (a notebook both sides made, the base known but without it: scope by scope too; the first window of a launch, no
  // base known: this page's entry, as before)
  const mineNew = { "ws:/m": { write: ["/l"], t: 2 } }, theirsNew = { "ws:/m": { write: ["/f"], t: 3 } };
  ok(J(mergeGrants({}, theirsNew, mineNew)["ws:/m"].write) === J(["/f", "/l"]) && J(mergeGrants({}, theirsNew, mineNew, false)["ws:/m"]) === J(mineNew["ws:/m"]), "both made one notebook: scope by scope with a base known; with none (a launch's first window), this page's entry");
}

console.log(fails ? `${fails} of ${checks} failed` : `test-grants-file: all ${checks} passed`);
process.exit(fails ? 1 : 0);
