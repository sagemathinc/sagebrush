// ci: web-sync.1 order=61 runner=bun
// The index's references (web/workspace/sync-refs.ts, e2e PR 5d): the ledger every device keeps from the verified log,
// and the check of a release op against the state just before it. The real reducer applies each op to an index beside
// an in-memory meta; the ledger is read back after each page. Current bytes by add seq (A -> B -> A, the same bytes
// again), a release op checked whole (a live file's current bytes, an add not live, one named twice: the op halts and
// nothing of it is kept), orphans, forgotten files (a folder's contents too), a plaintext write, a conflict copy, and the
// same ledger whatever the ops' `t` and however the log is cut into pages.
//   bun web/workspace/test-sync-refs.mjs
import { reduce, SyncIndex } from "./sync-reduce.ts";
import { ledgerPage, heldAs, liveAdds, liveOrphans, currentAdd, refsOf, ReleaseHalt, duePairs, historyUnder, REFS, refusalVerdict } from "./sync-refs.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const J = JSON.stringify;

// (IndexedDB's key range, as far as the ledger uses it)
globalThis.IDBKeyRange ??= { bound: (lower, upper, lowerOpen = false, upperOpen = false) => ({ lower, upper, lowerOpen, upperOpen }) };
const inRange = (r, k) => r === undefined || r === null ? true : (r.lowerOpen ? k > r.lower : k >= r.lower) && (r.upperOpen ? k < r.upper : k <= r.upper);
/** An object store's requests over a Map, answered as IndexedDB answers them (after the handler is set). */
function fakeMeta() {
  const m = new Map();
  const reqOf = (f) => {
    const r = { onsuccess: null, onerror: null, result: undefined, error: null };
    queueMicrotask(() => {
      try { r.result = f(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); }
    });
    return r;
  };
  const sorted = (range) => [...m.keys()].filter((k) => inRange(range, k)).sort();
  return {
    map: m,
    get: (k) => reqOf(() => m.get(k)),
    put: (v, k) => { m.set(k, v); return reqOf(() => k); },
    delete: (k) => { m.delete(k); return reqOf(() => undefined); },
    getAllKeys: (range, n) => reqOf(() => sorted(range).slice(0, n ?? Infinity)),
    getAll: (range, n) => reqOf(() => sorted(range).slice(0, n ?? Infinity).map((k) => m.get(k))),
  };
}
/** The confirmed rows as the Store the ledger reads: live entries and what was forgotten. */
const storeOf = (ix) => ({ byId: async (id) => ix.byId.get(id), gone: async (id) => ix.gone.get(id) });
const dump = (meta) => J([...meta.map].filter(([k]) => k.includes(":refs:")).sort());

const GEN = "ns#0", D1 = "d1d1d1d1d1d1d1d1", D2 = "d2d2d2d2d2d2d2d2";
const F = "f0f0f0f0f0f0f0f0", G = "f1f1f1f1f1f1f1f1", DIR = "e0e0e0e0e0e0e0e0", IN = "e1e1e1e1e1e1e1e1";
const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64), E = "e".repeat(64);

/** A device's view: its index, its meta, the ops so far; `apply(ops)` applies one page. */
function device() {
  const ix = new SyncIndex(), meta = fakeMeta();
  return {
    ix, meta,
    async apply(page, sealed = () => true) {
      const outcomes = page.map((op) => reduce(ix, op));
      await ledgerPage(meta, storeOf(ix), GEN, page, outcomes, sealed);
    },
  };
}
let seq = 0;
const op = (o, t) => ({ seq: ++seq, dseq: seq, device: D1, t: t ?? 1000 + seq, by: "person", ...o });
const release = (pairs, t) => op({ op: "release", path: "/", kind: "folder", releases: pairs }, t);
const halts = async (d, o) => {
  const before = dump(d.meta);
  try {
    await d.apply([o]);
    return { halted: false };
  } catch (e) {
    return { halted: e instanceof ReleaseHalt, why: e.message, same: dump(d.meta) === before };
  }
};

// ---- current bytes by add seq; history; the same bytes again; a release op checked whole
{
  seq = 0;
  const d = device();
  const s1 = op({ op: "create", path: "/a.txt", kind: "file", fid: F, sha256: A, size: 1 });
  const s2 = op({ op: "write", path: "/a.txt", kind: "file", fid: F, sha256: B, base: A, size: 1 });
  const s3 = op({ op: "write", path: "/a.txt", kind: "file", fid: F, sha256: A, base: B, size: 1 });
  const s4 = op({ op: "write", path: "/a.txt", kind: "file", fid: F, sha256: A, base: A, size: 1 });
  for (const o of [s1, s2, s3, s4]) await d.apply([o]);
  const how = async (address, add) => heldAs(d.meta, storeOf(d.ix), GEN, { address, add });
  const got = { s1: await how(A, s1.seq), s2: await how(B, s2.seq), s3: await how(A, s3.seq), s4: await how(A, s4.seq), cur: await currentAdd(d.meta, GEN, F) };
  check(J(got) === J({ s1: "history", s2: "history", s3: "current", s4: "orphan", cur: s3.seq }),
    `A -> B -> A: the third add holds the current bytes (by its seq, though the first add named the same bytes), the first two are history; the same bytes again is an orphan: ${J(got)}`);
  check(J(await liveAdds(d.meta, GEN, F)) === J([{ address: A, add: s1.seq }, { address: B, add: s2.seq }, { address: A, add: s3.seq }]) && J(await liveOrphans(d.meta, GEN, 10)) === J([{ add: s4.seq, address: A }]),
    "the file's live adds, oldest first, and the live orphans");

  const cur = await halts(d, release([{ address: A, add: s1.seq }, { address: A, add: s3.seq }]));
  check(cur.halted && /current bytes/.test(cur.why) && cur.same, `a release op naming history and the current bytes: halts, whole (its history pair not released either): ${J(cur)}`);
  const twice = await halts(d, release([{ address: A, add: s1.seq }, { address: A, add: s1.seq }]));
  check(twice.halted && /twice/.test(twice.why) && twice.same, `a release op naming one add twice: halts, nothing kept: ${J(twice)}`);
  const none = await halts(d, release([]));
  check(none.halted && /names no add/.test(none.why) && none.same, `a release op naming nothing: halts: ${J(none)}`);
  const unknown = await halts(d, release([{ address: E, add: s1.seq }]));
  check(unknown.halted && /isn't live/.test(unknown.why) && unknown.same, `a release of an add that never was (the right seq, other bytes): halts: ${J(unknown)}`);
  const future = await halts(d, release([{ address: A, add: seq + 50 }]));
  check(future.halted && /isn't live/.test(future.why) && future.same, `a release of a future add: halts: ${J(future)}`);

  const ok = await halts(d, release([{ address: A, add: s1.seq }, { address: B, add: s2.seq }, { address: A, add: s4.seq }]));
  check(!ok.halted && (await how(A, s1.seq)) === null && (await how(B, s2.seq)) === null && (await how(A, s4.seq)) === null && (await how(A, s3.seq)) === "current" && J(await liveAdds(d.meta, GEN, F)) === J([{ address: A, add: s3.seq }]) && J(await liveOrphans(d.meta, GEN, 10)) === "[]",
    "history and an orphan released: ended, the current bytes' add still live, the file's list and the orphans' updated");
  const again = await halts(d, release([{ address: A, add: s1.seq }]));
  check(again.halted && /isn't live/.test(again.why) && again.same, `the same add released again: halts: ${J(again)}`);

  // (forgotten: every add it held may go, its last current bytes included)
  await d.apply([op({ op: "remove", path: "/a.txt", to: "/Trash/a.txt", kind: "file", fid: F })]);
  check((await how(A, s3.seq)) === "current", "in Trash, a file is live: its current bytes stay current");
  await d.apply([op({ op: "forget", path: "/Trash/a.txt", kind: "file", fid: F })]);
  check((await how(A, s3.seq)) === "forgotten", "forgotten: its current bytes' add is a forgotten file's");
  const fg = await halts(d, release([{ address: A, add: s3.seq }]));
  check(!fg.halted && (await how(A, s3.seq)) === null, "a forgotten file's last add released: accepted");
}

// ---- a folder forgotten with a file in it; a conflict copy; a plaintext write; a document
{
  seq = 0;
  const d = device();
  const mk = op({ op: "mkdir", path: "/d", kind: "folder", fid: DIR });
  const inner = op({ op: "create", path: "/d/x.txt", kind: "file", fid: IN, sha256: A, size: 1 });
  const g1 = op({ op: "create", path: "/g.txt", kind: "file", fid: G, sha256: B, size: 1 });
  const copy = op({ op: "write", path: "/g.txt", kind: "file", fid: G, sha256: C, base: A, size: 1, device: D2 });
  await d.apply([mk, inner, g1, copy]);
  const how = async (address, add) => heldAs(d.meta, storeOf(d.ix), GEN, { address, add });
  const cid = [...d.ix.byId.values()].find((e) => e.sha256 === C)?.id;
  check(cid && cid !== G && (await currentAdd(d.meta, GEN, cid)) === copy.seq && (await how(C, copy.seq)) === "current" && (await how(B, g1.seq)) === "current",
    "a write on another base: the conflict copy holds its bytes, as its current ones; the file keeps its own");
  await d.apply([op({ op: "remove", path: "/d", to: "/Trash/d", kind: "folder", fid: DIR }), op({ op: "forget", path: "/Trash/d", kind: "folder", fid: DIR })]);
  check((await how(A, inner.seq)) === "forgotten", "a folder forgotten: the file in it is forgotten, its add releasable");
  // (a plaintext write: the file's current bytes are now ones no index add holds, so its sealed add is history)
  const plain = op({ op: "write", path: "/g.txt", kind: "file", fid: G, sha256: E, base: B, size: 1 });
  await d.apply([plain], (s) => s !== plain.seq);
  check((await currentAdd(d.meta, GEN, G)) === 0 && (await how(B, g1.seq)) === "history" && (await how(E, plain.seq)) === null,
    "a plaintext write: no index add for its bytes, the file's current add 0, its sealed add now history");
  // (a document's ops name no bytes: no add, nothing to release)
  const before = dump(d.meta);
  await d.apply([op({ op: "create", path: "/n.ipynb", kind: "notebook", ref: "0123456789ab" })]);
  check(dump(d.meta) === before && J(refsOf({ op: "create", kind: "notebook" })) === J({ adds: [], releases: [] }) && J(refsOf({ op: "forget", kind: "board" })) === J({ adds: [], releases: [] }),
    "a document's create (and a board's forget) adds and releases nothing: the ledger unchanged");
}

// ---- the same ledger whatever the ops' t, and however the log is cut into pages
{
  const log = (tOf) => {
    seq = 0;
    const o = [];
    o.push(op({ op: "create", path: "/a.txt", kind: "file", fid: F, sha256: A, size: 1 }, tOf(1)));
    o.push(op({ op: "write", path: "/a.txt", kind: "file", fid: F, sha256: B, base: A, size: 1 }, tOf(2)));
    o.push(op({ op: "write", path: "/a.txt", kind: "file", fid: F, sha256: B, base: B, size: 1 }, tOf(3)));
    o.push(op({ op: "write", path: "/a.txt", kind: "file", fid: F, sha256: C, base: A, size: 1, device: D2 }, tOf(4)));
    o.push(release([{ address: A, add: 1 }, { address: B, add: 3 }], tOf(5)));
    o.push(op({ op: "create", path: "/g.txt", kind: "file", fid: G, sha256: E, size: 1 }, tOf(6)));
    o.push(op({ op: "remove", path: "/g.txt", to: "/Trash/g.txt", kind: "file", fid: G }, tOf(7)));
    o.push(op({ op: "forget", path: "/Trash/g.txt", kind: "file", fid: G }, tOf(8)));
    o.push(release([{ address: E, add: 6 }], tOf(9)));
    return o;
  };
  const run = async (ops, cut) => {
    const d = device();
    let page = [];
    for (const o of ops) {
      // (a release op alone in its page, as runPage cuts it)
      if (o.op === "release") {
        if (page.length) await d.apply(page);
        page = [];
        await d.apply([o]);
        continue;
      }
      page.push(o);
      if (page.length >= cut) { await d.apply(page); page = []; }
    }
    if (page.length) await d.apply(page);
    return dump(d.meta);
  };
  const base = await run(log((i) => 1000 + i), 1);
  const rows = {
    pagesOf3: await run(log((i) => 1000 + i), 3),
    onePage: await run(log((i) => 1000 + i), 100),
    tBackward: await run(log((i) => 9000 - i), 1),
    tFuture: await run(log((i) => 8.64e15 - i), 2),
    tEqual: await run(log(() => 5), 4),
  };
  check(Object.values(rows).every((x) => x === base) && base.includes(":refs:a:"), `the same ledger for pages of 1, 3 or all ops, and for ops' t forward, backward, far in the future or all equal: ${J(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v === base])))}`);
}

// ---- what a sweep may release, and when; what "delete old versions" releases
{
  seq = 0;
  const d = device(), st = storeOf(d.ix);
  const s1 = op({ op: "create", path: "/d/a.txt", kind: "file", fid: F, sha256: A, size: 1 });
  await d.apply([op({ op: "mkdir", path: "/d", kind: "folder", fid: DIR }), s1]);
  const s2 = op({ op: "write", path: "/d/a.txt", kind: "file", fid: F, sha256: B, base: A, size: 1 });
  const s3 = op({ op: "write", path: "/d/a.txt", kind: "file", fid: F, sha256: A, base: B, size: 1 });
  const same = op({ op: "write", path: "/d/a.txt", kind: "file", fid: F, sha256: A, base: A, size: 1 });
  const g1 = op({ op: "create", path: "/g.txt", kind: "file", fid: G, sha256: C, size: 1 });
  const g2 = op({ op: "write", path: "/g.txt", kind: "file", fid: G, sha256: E, base: C, size: 1 });
  await d.apply([s2, s3, same, g1, g2]);
  const hist = async (path) => J(await historyUnder(d.meta, st, GEN, path));
  check((await hist("/d/a.txt")) === J([{ address: A, add: s1.seq }, { address: B, add: s2.seq }]) && (await hist("/d")) === (await hist("/d/a.txt")) && (await hist("/")) === J([{ address: A, add: s1.seq }, { address: B, add: s2.seq }, { address: C, add: g1.seq }]) && (await hist("/x")) === "[]",
    "delete old versions: a file's history (never its current bytes' add, A -> B -> A's third), a folder's files' or everyone's; nothing elsewhere");
  check(J(await historyUnder(d.meta, st, GEN, "/d", 1)) === J([{ address: A, add: s1.seq }]) && J(await historyUnder(d.meta, st, GEN, "/", 5)) === "[]",
    "…keeping each file's newest `keep` old versions: the older ones only");
  // (a sweep: the orphan now, the forgotten file's adds once it is forgotten; first seen only stamps; due a day later)
  const T0 = 1_000_000;
  const at = async (t) => J(await duePairs(d.meta, st, GEN, t, 64));
  check((await at(T0)) === "[]", "a sweep's first sight of a due add only stamps it");
  check((await at(T0 + REFS.dueMs - 1)) === "[]", "…nothing released before REFS.dueMs from its first sight");
  check((await at(T0 + REFS.dueMs)) === J([{ add: same.seq, address: A }]), "…then the orphan (the same bytes again); never a live file's history or current bytes");
  await d.apply([op({ op: "remove", path: "/g.txt", to: "/Trash/g.txt", kind: "file", fid: G })]);
  check((await at(T0 + 2 * REFS.dueMs)) === J([{ add: same.seq, address: A }]), "a file in Trash is live: its adds aren't due");
  await d.apply([op({ op: "forget", path: "/Trash/g.txt", kind: "file", fid: G })]);
  const T1 = T0 + 3 * REFS.dueMs;
  check((await at(T1)) === J([{ add: same.seq, address: A }]), "forgotten: its adds first seen now (stamped), not yet due");
  check((await at(T1 + REFS.dueMs)) === J([{ add: same.seq, address: A }, { address: C, add: g1.seq }, { address: E, add: g2.seq }]), "…a day later, every add it held, its last current bytes too");
  check((await at(T1 + REFS.dueMs)) === (await at(T1 + REFS.dueMs)) && J(await duePairs(d.meta, st, GEN, T1 + REFS.dueMs, 2)) === J([{ add: same.seq, address: A }, { address: C, add: g1.seq }]), "at most n at a time");
  await d.apply([release([{ address: A, add: same.seq }, { address: C, add: g1.seq }, { address: E, add: g2.seq }])]);
  check((await at(T1 + 2 * REFS.dueMs)) === "[]" && ![...d.meta.map.keys()].some((k) => k.includes(":refs:d:")), "released: none due any more, their stamps gone");
}

// ---- "delete old versions" bounded by what the person saw (SEC on 5d-2b): the view's cursor, this device's own ops
// before the request, the files by identity
{
  seq = 0;
  const d = device(), st = storeOf(d.ix);
  const on = (dev, o) => ({ ...op(o), device: dev });
  const s1 = on(D1, { op: "create", path: "/d/f.txt", kind: "file", fid: F, sha256: A, size: 1 });
  await d.apply([op({ op: "mkdir", path: "/d", kind: "folder", fid: DIR }), s1]);
  const s2 = on(D1, { op: "write", path: "/d/f.txt", kind: "file", fid: F, sha256: B, base: A, size: 1 });
  const s3 = on(D1, { op: "write", path: "/d/f.txt", kind: "file", fid: F, sha256: C, base: B, size: 1 });
  await d.apply([s2, s3]);
  const view = s3.seq;
  // (after the person's request, another device writes the file: its add is after the view)
  const s4 = on(D2, { op: "write", path: "/d/f.txt", kind: "file", fid: F, sha256: E, base: C, size: 1 });
  await d.apply([s4]);
  const h = async (bound, keep = 0, path = "/d/f.txt") => J(await historyUnder(d.meta, st, GEN, path, keep, bound));
  check((await h({ view, device: D1, dseqBelow: 1 })) === J([{ address: A, add: s1.seq }, { address: B, add: s2.seq }]) && (await h(undefined)) === J([{ address: A, add: s1.seq }, { address: B, add: s2.seq }, { address: C, add: s3.seq }]),
    "a request made when the third version was current: after another device's write, it releases the first two only (the third, current in the view, is kept); unbounded it would release all three");
  // (asked before its own writes were in the verified index: its own adds before the request are in the view, another's after it aren't)
  check((await h({ view: 0, device: D1, dseqBelow: s3.dseq + 1 })) === J([{ address: A, add: s1.seq }, { address: B, add: s2.seq }]), "asked right after its own writes (the view's cursor before them): its own adds count, the other device's later one doesn't");
  check((await h({ view: 0, device: D1, dseqBelow: s2.dseq + 1 })) === J([{ address: A, add: s1.seq }]), "an own write made after the request isn't in the view: the second becomes the view's current, only the first goes");
  check((await h({ view, device: D1, dseqBelow: 1 }, 1)) === J([{ address: A, add: s1.seq }]), "keep 1 with the bound: the view's current and its newest old version stay");
  // (the files by identity: one moved into the folder after the request isn't released; one moved out still is)
  const g1 = on(D2, { op: "create", path: "/g.txt", kind: "file", fid: G, sha256: A, size: 1 });
  const g2 = on(D2, { op: "write", path: "/g.txt", kind: "file", fid: G, sha256: B, base: A, size: 1 });
  await d.apply([g1, g2]);
  const view2 = g2.seq;
  await d.apply([on(D2, { op: "rename", path: "/g.txt", to: "/d/g.txt", kind: "file", fid: G }), on(D2, { op: "rename", path: "/d/f.txt", to: "/f.txt", kind: "file", fid: F })]);
  check((await h({ view: view2, device: D1, dseqBelow: 1, fids: [F] }, 0, "/d")) === J([{ address: A, add: s1.seq }, { address: B, add: s2.seq }, { address: C, add: s3.seq }]),
    "a folder's request by identity: the file it held (since moved out) keeps its scope; the file moved in after isn't touched");
  check((await h({ view: view2, device: D1, dseqBelow: 1 }, 0, "/")) === J([{ address: A, add: s1.seq }, { address: B, add: s2.seq }, { address: C, add: s3.seq }, { address: A, add: g1.seq }]),
    "the whole workspace's request: each file's history as of the view, each view's current kept");
}

// ---- a refused release's check: stop, or send again what is still live and eligible, once
{
  const P = [{ address: A, add: 1 }, { address: B, add: 2 }, { address: C, add: 3 }];
  const v = (held, person = false, retried = false) => refusalVerdict(held, P, person, retried);
  const rows = {
    race: v(["orphan", "ended", "forgotten"]),
    raceAllEnded: v(["ended", "ended", "ended"]),
    noneEnded: v(["orphan", "forgotten", "orphan"]),
    gone: v(["ended", "gone", "orphan"]),
    current: v(["ended", "current", "orphan"]),
    historySweep: v(["ended", "history", "orphan"]),
    historyPerson: v(["ended", "history", "orphan"], true),
    inconsistent: v(["ended", "inconsistent", "orphan"]),
    retriedRace: v(["orphan", "ended", "forgotten"], false, true),
    retriedNoneEnded: v(["orphan", "forgotten", "orphan"], false, true),
  };
  const kind = (x) => ("halt" in x ? "halt" : J(x));
  const got = Object.fromEntries(Object.entries(rows).map(([k, x]) => [k, kind(x)]));
  const want = {
    race: J({ resend: [P[0], P[2]], dropped: 0 }), raceAllEnded: J({ resend: [], dropped: 0 }), noneEnded: "halt", gone: "halt", current: "halt",
    historySweep: "halt", historyPerson: J({ resend: [P[0], P[1], P[2]].filter((_, i) => i !== 0), dropped: 0 }), inconsistent: "halt",
    retriedRace: J({ resend: [], dropped: 2 }), retriedNoneEnded: "halt",
  };
  check(J(got) === J(want), `a refused release's check: a race sends the rest again; nothing ended, or a pair gone, current, inconsistent, or history not the person's, stops; a resend refused again by a race is never sent a third time (its pairs dropped): ${J(got)}`);
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f.slice(0, 600));
process.exit(fails.length ? 1 : 0);
