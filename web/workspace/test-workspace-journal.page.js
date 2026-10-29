// The cases of web/workspace/test-workspace-journal.mjs, run in the page (real IndexedDB and Web Locks): the
// journal's activation (plan-sync-slice2-client r4 §1a).  W and S are this build's workspace and notebook
// stores; OW and OS the pinned pre-journal build's (master f8976bfe).  Each case has databases of its own,
// but for the notebooks' history and the boards' history, one each for the whole origin: their fences are
// dropped before each case (in a browser there is only ever one workspace).
import * as W from "./ws.js";
import * as S from "./stores.js";
import * as OW from "./old-ws.js";
import * as OS from "./old-stores.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FENCE = "__sagebrush-workspace__";
let n = 0;
const rawGet = (db, store, key) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const rawPut = (db, store, value, key) => new Promise((ok, no) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(value, key); tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); });
const rawDel = (db, store, key) => new Promise((ok, no) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).delete(key); tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); });
const rawCount = (db, store, range) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).count(range); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const dropDb = (name) => new Promise((ok, no) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = ok; r.onerror = () => no(r.error); r.onblocked = ok; });
const openAt = (name, v, up) => new Promise((ok, no) => {
  const r = indexedDB.open(name, v);
  r.onupgradeneeded = () => up?.(r.result);
  r.onsuccess = () => ok(r.result);
  r.onerror = () => no(r.error);
  r.onblocked = () => no(new Error("blocked"));
});
const named = async () => {
  n++;
  localStorage.clear();
  for (const h of [await W.openHistoryDb(), await W.openBoardHistoryDb()]) if (h) { await rawDel(h, "history", [FENCE, ""]).catch(() => {}); h.close(); }
  return { name: `wsj-${n}`, mainName: `mainj-${n}` };
};
const open = (o) => W.Workspace.open(o);
// the three fences, as each store has it: the notebooks', their history's, the boards' history's
const fences = async (w) => {
  const h = await W.openHistoryDb(), b = await W.openBoardHistoryDb();
  try {
    return [await rawGet(w.main, "notebooks", FENCE), (await rawGet(h, "history", [FENCE, ""]))?.fence, (await rawGet(b, "history", [FENCE, ""]))?.fence];
  } finally {
    h.close();
    b.close();
  }
};
const phases = (fs) => fs.map((f) => f?.phase ?? null);
const marks = (fs) => fs.map((f) => f?.journal ?? null);
const meta = (w, k) => rawGet(w.ws, "meta", k);
// (an owned board's history id of this case's own: the boards' history is one database for the whole origin)
const boardId = () => "board:local:" + n.toString(16).padStart(12, "0");
const rows = (db, id) => rawCount(db, "history", IDBKeyRange.bound([id, ""], [id, "￿"]));
const NOT_ACTIVE = J({ v: 1, active: false }), BEGUN = J({ v: 1, active: false, activating: true }), ACTIVE = J({ v: 1, active: true });

async function upgradeAndOldBuilds() {
  // a fresh workspace: version 9 (8 the journal's record, 9 the board journal's barrier), the journal recorded and not active, every fence "ok" without the mark
  const o = await named(), w = await open(o);
  check(W.WS_VERSION === 9 && w.ws.version === 9, `the workspace's database at version 9 (${w.ws.version})`);
  check(J(await meta(w, "journal")) === NOT_ACTIVE && (await w.journalActive()) === false, "meta's journal: {v: 1, active: false}, not active");
  const f = await fences(w);
  check(J(phases(f)) === J(["ok", "ok", "ok"]) && J(marks(f)) === J([null, null, null]), "before activation every fence says \"ok\", with no mark: " + J(phases(f)));
  w.close();
  // a version-7 database upgraded: the one write, meta's other records as they were
  const v7 = `wsj-v7-${n}`;
  const db7 = await openAt(v7, 7, (db) => db.createObjectStore("meta"));
  await rawPut(db7, "meta", { x: 1 }, "other");
  db7.close();
  const db9 = await W.openWorkspaceDb(v7);
  check(db9.version === 9 && J(await rawGet(db9, "meta", "journal")) === NOT_ACTIVE && J(await rawGet(db9, "meta", "other")) === J({ x: 1 }), "a version-7 workspace upgraded to 9: meta's journal written, its other records kept");
  // an earlier build opening it fresh: a VersionError, nothing written
  const err = await openAt(v7, 7).then((db) => { db.close(); return "opened"; }, (e) => e?.name ?? String(e));
  check(err === "VersionError", "an earlier build asking for version 7 gets a VersionError: " + err);
  db9.close();
  // a version-8 database upgraded: version 9 writes nothing, so meta's journal (here active) and its other records are as they were
  const v8 = `wsj-v8-${n}`;
  const db8 = await openAt(v8, 8, (db) => db.createObjectStore("meta"));
  await rawPut(db8, "meta", { v: 1, active: true }, "journal");
  await rawPut(db8, "meta", { x: 1 }, "other");
  db8.close();
  const db8to9 = await W.openWorkspaceDb(v8);
  check(db8to9.version === 9 && J(await rawGet(db8to9, "meta", "journal")) === ACTIVE && J(await rawGet(db8to9, "meta", "other")) === J({ x: 1 }), "a version-8 workspace upgraded to 9: nothing written, meta's journal and other records kept");
  const err8 = await openAt(v8, 8).then((db) => { db.close(); return "opened"; }, (e) => e?.name ?? String(e));
  check(err8 === "VersionError", "a version-8 build asking for version 8 gets a VersionError: " + err8);
  db8to9.close();
  // an earlier build's open connection: told by the upgrade (versionchange), and closed
  const v7b = `wsj-v7b-${n}`;
  const held = await openAt(v7b, 7, (db) => db.createObjectStore("meta"));
  let told = false;
  held.onversionchange = () => { told = true; held.close(); };
  const up = await W.openWorkspaceDb(v7b);
  check(told && up.version === 9, "an earlier build's open connection is told of the upgrade (versionchange), and closes");
  up.close();
  // a version-8 build's open connection (the board journal's barrier): told by the upgrade to 9, and closed
  const v8b = `wsj-v8b-${n}`;
  const held8 = await openAt(v8b, 8, (db) => db.createObjectStore("meta"));
  let told8 = false;
  held8.onversionchange = () => { told8 = true; held8.close(); };
  const up8 = await W.openWorkspaceDb(v8b);
  check(told8 && up8.version === 9, "a version-8 build's open connection is told of the upgrade to 9 (versionchange), and closes");
  up8.close();
  // the pinned pre-journal build's own workspace, opening a current (version-9) workspace: it can't, and writes nothing
  const o2 = await named();
  (await open(o2)).close();
  const before = J(await (async () => { const db = await W.openWorkspaceDb(o2.name); const m = await new Promise((ok) => { const r = db.transaction("meta").objectStore("meta").getAllKeys(); r.onsuccess = () => ok(r.result); }); db.close(); return m; })());
  let oldOpen;
  try {
    const ow = await OW.Workspace.open(o2);
    const made = await ow.create("/old.txt", { content: "x" }).then(() => "made", (e) => "refused: " + (e?.code ?? e));
    oldOpen = `opened (${ow.durability?.state}), create ${made}`;
    ow.close();
  } catch (e) {
    oldOpen = "threw: " + (e?.name ?? "") + " " + String(e?.message ?? e).slice(0, 80);
  }
  const db = await W.openWorkspaceDb(o2.name);
  const after = J(await new Promise((ok) => { const r = db.transaction("meta").objectStore("meta").getAllKeys(); r.onsuccess = () => ok(r.result); }));
  const entries = await rawCount(db, "entries");
  db.close();
  check((oldOpen.startsWith("threw") || /create refused/.test(oldOpen)) && before === after && entries === 0, "the pinned pre-journal build can't open a version-9 workspace, nor write it: " + oldOpen);
}

async function beforeActivation() {
  // nothing changes before activation: a notebook saves, its history and an owned board's history append, as on master
  const o = await named(), w = await open(o);
  const e = await w.create("/a.ipynb");
  const st = new W.IdbStore(w.main, e.ref), doc = await st.load();
  const saved = await st.save({ ...doc, name: "changed" });
  check(!!saved?.saved && (await rawGet(w.main, "notebooks", e.ref))?.name === "changed", "before activation a notebook saves: " + J(saved));
  const hdb = await W.openHistoryDb(), bdb = await W.openBoardHistoryDb();
  const bid = boardId(), h = new W.IdbPatchStore(hdb, e.ref), b = new W.IdbPatchStore(bdb, bid);
  await h.append({ time: "2026-10-26T00:00:00.000Z", id: "p1" });
  await b.append({ time: "2026-10-26T00:00:00.000Z", id: "p1" });
  await sleep(100);
  check((await rows(hdb, e.ref)) === 1 && (await rows(bdb, bid)) === 1, "…and a notebook's history and an owned board's history append");
  hdb.close();
  bdb.close();
  w.close();
}

async function gated() {
  // (activation waits for both kinds of document to save through the journal in this build: refused, nothing written,
  // until boards' writer says so (2c-1b); the tests below then register both, as this build's pages will)
  const o = await named(), w = await open(o);
  const f0 = await fences(w), m0 = J(await meta(w, "journal"));
  const why = await w.activateJournal().then(() => null, (e) => e?.message ?? String(e));
  check(why !== null && /boards/.test(why) && J(await fences(w)) === J(f0) && J(await meta(w, "journal")) === m0 && (await w.journalActive()) === false, "activateJournal is refused while no board journal writer is registered, and writes nothing: " + why);
  W.registerJournalWriter("notebooks");
  const why2 = await w.activateJournal().then(() => null, (e) => e?.message ?? String(e));
  check(why2 !== null && /boards/.test(why2) && !/notebooks/.test(why2) && J(await meta(w, "journal")) === m0, "…with only notebooks', still refused: " + why2);
  check((() => { try { W.registerJournalWriter("files"); return false; } catch { return true; } })(), "…and a kind that isn't one is refused");
  W.registerJournalWriter("boards");
  w.close();
}

async function activation() {
  const o = await named(), w = await open(o);
  const f0 = await fences(w);
  const ok = await w.activateJournal();
  const f = await fences(w);
  check(ok === true && (await w.journalActive()) === true && J(await meta(w, "journal")) === ACTIVE, "activateJournal: active, meta's journal {v: 1, active: true}");
  check(J(phases(f)) === J(["journal", "journal", "journal"]) && J(marks(f)) === J([1, 1, 1]), "…every fence says \"journal\", with the mark: " + J(phases(f)));
  check(f.every((x) => x.workspace === w.identity.workspace && x.generation === w.identity.generation && x.step > f0[0].step), "…each still naming this workspace and generation, at a later step");
  // again: nothing changes but the step
  check((await w.activateJournal()) === true && J(phases(await fences(w))) === J(["journal", "journal", "journal"]), "activating again: still active, nothing else changed");
  w.close();
  // a reopen keeps it
  const w2 = await open(o);
  check((await w2.journalActive()) && J(phases(await fences(w2))) === J(["journal", "journal", "journal"]), "reopened: still active, every fence \"journal\"");
  w2.close();
}

async function writersRefused() {
  // after activation every writer from before the journal is refused before it changes anything: this build's
  // and the pinned build's, notebooks and their history and an owned board's history alike
  const o = await named(), w = await open(o);
  const e = await w.create("/a.ipynb");
  const id = boardId();
  const st = new W.IdbStore(w.main, e.ref), ost = new OS.IdbStore(w.main, e.ref);
  await st.load();
  await ost.load();
  const hdb = await W.openHistoryDb(), bdb = await W.openBoardHistoryDb();
  const h = new W.IdbPatchStore(hdb, e.ref), oh = new OS.IdbPatchStore(hdb, e.ref), b = new W.IdbPatchStore(bdb, id), ob = new OS.IdbPatchStore(bdb, id);
  for (const x of [h, oh, b, ob]) await x.loadInitial?.().catch(() => {});
  await w.activateJournal();
  const rec0 = J(await rawGet(w.main, "notebooks", e.ref));
  const s1 = await st.save({ ...(await rawGet(w.main, "notebooks", e.ref)), name: "NEW BUILD, BEFORE THE JOURNAL" });
  const s2 = await ost.save({ ...(await rawGet(w.main, "notebooks", e.ref)), name: "PINNED BUILD" });
  check(typeof s1 === "string" && /journal/.test(s1) && typeof s2 === "string" && /not saved/.test(s2), `notebook saves refused: this build's (${s1}), the pinned build's (${s2})`);
  check(J(await rawGet(w.main, "notebooks", e.ref)) === rec0, "…and the notebook's record unchanged");
  // (a fresh store, bound now, the same)
  const s3 = await new W.IdbStore(w.main, "nb-new", { id: "nb-new", name: "n", cells: [] }).save({ id: "nb-new", name: "n", cells: [] });
  check(typeof s3 === "string" && (await rawGet(w.main, "notebooks", "nb-new")) === undefined, "a new notebook's first save refused too, nothing made: " + s3);
  const appended = [];
  for (const [x, what] of [[h, "this build's notebook history"], [oh, "the pinned build's notebook history"], [b, "this build's board history"], [ob, "the pinned build's board history"]]) {
    await Promise.resolve(x.append({ time: "2026-10-26T00:00:01.000Z", id: "p2" })).catch(() => {});
    const cleared = await x.clear().then(() => "cleared", (err) => "refused: " + String(err?.message ?? err).slice(0, 60));
    appended.push([what, cleared]);
  }
  await sleep(200);
  check((await rows(hdb, e.ref)) === 0 && (await rows(bdb, id)) === 0, "nothing appended to a notebook's history or an owned board's history, by either build");
  check(appended.every(([, c]) => c.startsWith("refused")), "…and clearing refused by each: " + J(appended));
  // a history the workspace doesn't own (an example board's) keeps writing, as on master
  const ex = new W.IdbPatchStore(bdb, "board:examples/own-test.json");
  await ex.append({ time: "2026-10-26T00:00:02.000Z", id: "p3" });
  await sleep(100);
  check((await rows(bdb, "board:examples/own-test.json")) === 1, "an example board's history, not the workspace's, still appends");
  await ex.clear().catch(() => {});
  hdb.close();
  bdb.close();
  w.close();
}

async function refusalRule() {
  // the rule itself: a writer accepts one phase; the journal's writers (2c-1d) "journal", every other "ok"
  const f = (phase) => ({ workspace: "w".repeat(16), generation: 1, step: 1, phase, primary: "p" });
  const seen = { workspace: "w".repeat(16), generation: 1 };
  const t = [
    [S.fenceRefusal(f("ok"), seen), null, "\"ok\", a writer from before the journal: allowed"],
    [S.fenceRefusal(f(undefined), seen), null, "no phase (an older fence), the same: allowed"],
    [S.fenceRefusal(f("journal"), seen) !== null, true, "\"journal\", a writer from before the journal: refused"],
    [S.fenceRefusal(f("journal"), seen, "journal"), null, "\"journal\", the journal's writer: allowed"],
    [S.fenceRefusal(f("ok"), seen, "journal") !== null, true, "\"ok\", the journal's writer: refused (not activated)"],
    [S.fenceRefusal(f(undefined), seen, "journal") !== null, true, "no phase, the journal's writer: refused"],
    [/lost/.test(S.fenceRefusal(f("quarantined"), seen, "journal")), true, "quarantined, either writer: refused as quarantined"],
    [/being reset/.test(S.fenceRefusal(f("resetting"), seen, "journal")), true, "being reset, either writer: refused as being reset"],
    [/reset in another tab/.test(S.fenceRefusal({ ...f("journal"), generation: 2 }, seen, "journal")), true, "another generation, the journal's writer: refused"],
  ];
  for (const [got, want, what] of t) check(got === want, `fenceRefusal: ${what}`);
}

async function keptByLaterWrites() {
  // the notebooks' fence's counters, and every fence's mark, kept by every later write of the fences: a
  // refresh before and after activation, a reset keeping the workspace, a reset to a new one, a quarantine
  const o = await named();
  let w = await open(o);
  const counters = { unjournaledBytes: 1234, unjournaledCount: 5 };
  await rawPut(w.main, "notebooks", { ...(await rawGet(w.main, "notebooks", FENCE)), ...counters });
  await w.writeFence();
  const k0 = await rawGet(w.main, "notebooks", FENCE);
  check(k0.unjournaledBytes === 1234 && k0.unjournaledCount === 5 && k0.phase === "ok", "a write of the fences before activation keeps the notebooks' fence's counters");
  await w.activateJournal();
  await w.writeFence();
  const k1 = await rawGet(w.main, "notebooks", FENCE);
  check(k1.unjournaledBytes === 1234 && k1.unjournaledCount === 5 && k1.phase === "journal", "…and after it, a refresh: counters kept, \"journal\"");
  const g0 = w.identity.generation;
  await w.reset("keep");
  await w.settled();
  let f = await fences(w);
  check(J(phases(f)) === J(["journal", "journal", "journal"]) && J(marks(f)) === J([1, 1, 1]) && f.every((x) => x.generation === g0 + 1), "a reset keeping the workspace: every fence \"journal\" with its mark, at the next generation: " + J(phases(f)));
  check(J(await meta(w, "journal")) === ACTIVE && f[0].unjournaledBytes === 1234 && f[0].unjournaledCount === 5, "…meta's journal kept by the reset, and the counters");
  const id0 = w.identity.workspace;
  await w.reset("new");
  await w.settled();
  f = await fences(w);
  check(w.identity.workspace !== id0 && J(phases(f)) === J(["journal", "journal", "journal"]) && J(marks(f)) === J([1, 1, 1]), "a reset to a new workspace: every fence \"journal\" with its mark: " + J(phases(f)));
  check(J(await meta(w, "journal")) === ACTIVE && (await w.journalActive()), "…and still active");
  w.close();
  // a quarantine: its fences say so, keep the mark, and the journal comes back with the workspace
  w = await open(o);
  await w.create("/a.txt", { content: "a" });
  w.close();
  await dropDb(o.name);
  w = await open(o);
  f = await fences(w);
  const q = w.durability.state;
  check((q === "confirmed" || q === "suspected") && J(phases(f)) === J(["quarantined", "quarantined", "quarantined"]) && J(marks(f)) === J([1, 1, 1]), `quarantined (${q}): every fence says so, each keeps its mark`);
  check(J(await meta(w, "journal")) === BEGUN && (await w.journalActive()) === false, "…the workspace's database lost with meta's journal: the marks make it begun again, not active while quarantined");
  check(await w.activateJournal().then(() => false, () => true), "activating while quarantined is refused");
  await w.reset("new");
  await w.settled();
  f = await fences(w);
  check(J(phases(f)) === J(["journal", "journal", "journal"]) && (await w.journalActive()), "…once the quarantine is resolved (a new workspace): \"journal\" everywhere, active, never \"ok\": " + J(phases(f)));
  w.close();
  for (const k of Object.keys(localStorage)) if (k.startsWith("sagebrush-quarantined:")) localStorage.removeItem(k);
}

async function stopsCarriedOn() {
  // a stop after each fence write (the hook throws, as a tab closed there would), and after the last of them, just
  // before `active`: activation is left begun, nothing active; the next open carries it on to the end
  for (let k = 1; k <= 3; k++) {
    const o = await named();
    let w = await open(o);
    let seen = 0;
    W.JOURNAL_HOOK.afterFence = () => { if (++seen === k) throw new Error("stopped here (test)"); };
    const threw = await w.activateJournal().then(() => false, () => true);
    W.JOURNAL_HOOK.afterFence = undefined;
    const f = await fences(w);
    const want = ["journal", "journal", "journal"].map((p, i) => (i < k ? p : "ok"));
    check(threw && J(phases(f)) === J(want) && J(await meta(w, "journal")) === BEGUN && (await w.journalActive()) === false, `stopped after fence ${k}: begun, not active, fences ${J(phases(f))}`);
    // (this tab's writers from before the journal are refused at a fence already written)
    const e = await w.create("/n.ipynb").catch(() => null);
    w.close();
    w = await open(o);
    const f2 = await fences(w);
    check(J(phases(f2)) === J(["journal", "journal", "journal"]) && (await w.journalActive()) && J(await meta(w, "journal")) === ACTIVE, `…the next open carries it on: active, every fence "journal"`);
    w.close();
    void e;
  }
  // never begun: an open changes nothing
  const o = await named();
  let w = await open(o);
  w.close();
  w = await open(o);
  check(J(await meta(w, "journal")) === NOT_ACTIVE && J(phases(await fences(w))) === J(["ok", "ok", "ok"]), "never begun: reopening leaves it as it was");
  w.close();
}

async function blockedFence() {
  // a fence that can't be written (one of a later generation in the boards' history): its store blocked, the
  // activation left begun, never active; once the fence can be written, the next write of the fences finishes it
  const o = await named(), w = await open(o);
  const bdb = await W.openBoardHistoryDb();
  await rawPut(bdb, "history", { nb: FENCE, time: "", fence: { workspace: "x".repeat(16), generation: w.identity.generation + 5, step: 1, phase: "ok", primary: "elsewhere" } });
  const ok = await w.activateJournal();
  check(ok === false && J(await meta(w, "journal")) === BEGUN && J(await meta(w, "fenceBlocked")) === J([bdb.name]), "a fence that can't be written: not active, begun, its store blocked: " + J(await meta(w, "fenceBlocked")));
  const id = boardId(), b = new W.IdbPatchStore(bdb, id);
  await Promise.resolve(b.append({ time: "2026-10-26T00:00:03.000Z", id: "p4" })).catch(() => {});
  await sleep(150);
  check((await rows(bdb, id)) === 0, "…writes to the blocked store refused");
  await rawDel(bdb, "history", [FENCE, ""]);
  await w.writeFence();
  check((await w.journalActive()) && J(phases(await fences(w))) === J(["journal", "journal", "journal"]) && (await meta(w, "fenceBlocked")) === undefined, "…once it can be written: the next write of the fences finishes the activation");
  bdb.close();
  w.close();
}

async function markAdopted() {
  // a workspace database that lost meta's journal while the stores kept their marks (not quarantined here: meta
  // put back to "not active" by hand): one write of the fences records it begun and finishes it
  const o = await named(), w = await open(o);
  await w.activateJournal();
  await rawPut(w.ws, "meta", { v: 1, active: false }, "journal");
  await w.writeFence();
  check((await w.journalActive()) && J(phases(await fences(w))) === J(["journal", "journal", "journal"]), "a store's mark with meta's journal lost: one write of the fences makes it active again");
  // …and a stop in the middle of that write: no fence loses its mark, so the next write still knows
  await rawPut(w.ws, "meta", { v: 1, active: false }, "journal");
  let seen = 0;
  W.JOURNAL_HOOK.afterFence = () => { if (++seen === 1) throw new Error("stopped here (test)"); };
  await w.writeFence().catch(() => {});
  W.JOURNAL_HOOK.afterFence = undefined;
  const f = await fences(w);
  check(J(marks(f)) === J([1, 1, 1]) && J(phases(f)) === J(["journal", "journal", "journal"]), "…a stop after its first fence: every fence keeps its mark and says \"journal\": " + J(phases(f)));
  await w.writeFence();
  check(await w.journalActive(), "…and the next write finishes it");
  w.close();
}

async function resetKeepsMeta() {
  // a reset to a new workspace empties meta a page at a time, but for what it keeps aside: the journal's record
  // among them, so it is never seen not active meanwhile
  const o = await named(), w = await open(o);
  await w.activateJournal();
  // (a record of meta's that a reset does empty, so that it has a page of meta to empty)
  await rawPut(w.ws, "meta", 1, "test:dropped-by-reset");
  const seen = [];
  W.RESET_HOOK.afterPage = (store) => { if (store === "meta") seen.push(meta(w, "journal")); };
  await w.reset("new");
  await w.settled();
  W.RESET_HOOK.afterPage = undefined;
  const got = (await Promise.all(seen)).map(J);
  check(got.length > 0 && got.every((x) => x === ACTIVE), "a reset's emptying of meta keeps the journal's record, active at every page: " + J(got));
  w.close();
}

async function storeUnopened() {
  // a store whose database couldn't be opened: its fence not written, so the activation stays begun, never active
  const o = await named(), w = await open(o);
  W.JOURNAL_HOOK.unopened = (name) => name === "sagebrush-board-history";
  const ok = await w.activateJournal();
  W.JOURNAL_HOOK.unopened = undefined;
  check(ok === false && J(await meta(w, "journal")) === BEGUN && J(phases(await fences(w))) === J(["journal", "journal", "ok"]), "a store that couldn't be opened: begun, not active, its fence not written");
  await w.writeFence();
  check(await w.journalActive(), "…once it opens, the next write of the fences finishes it");
  w.close();
}

async function boardsFollowPhase() {
  // (option (ii), Oct 27: boards keep their save under an active journal; their TimeTravel store follows the fence's
  // phase, bound when it first reads the fence: plan-sync-slice2-client r4 §2 until 2c-1b)
  const o = await named(), w = await open(o);
  const bdb = await W.openBoardHistoryDb();
  const before = boardId() + ":b", after = boardId() + ":a";
  const fpBefore = new W.IdbPatchStore(bdb, before, { followPhase: true });
  await fpBefore.loadInitial();
  check(fpBefore.phase === "ok", "a phase-following board store bound before activation is in \"ok\": " + fpBefore.phase);
  // (refused for another reason, before the activation: a reset in another tab (another generation) is not said as
  // TimeTravel having stopped, board's N1 on 7e4ddd5b)
  const reset = boardId() + ":r", heard = [], off0 = W.onHistoryRefused((m) => heard.push(m));
  const fpReset = new W.IdbPatchStore(bdb, reset, { followPhase: true });
  await fpReset.loadInitial();
  const was = await rawGet(bdb, "history", [FENCE, ""]);
  await rawPut(bdb, "history", { ...was, fence: { ...was.fence, generation: was.fence.generation + 1 } });
  await Promise.resolve(fpReset.append({ time: "2026-10-27T00:00:00.500Z", id: "q0" })).catch(() => {});
  await sleep(150);
  await rawPut(bdb, "history", was);
  off0();
  check(was?.fence?.phase === "ok" && (await rows(bdb, reset)) === 0 && heard.length === 0, "…one refused for a reset, not its phase, writes nothing and doesn't say TimeTravel stopped: " + J(heard));
  await w.activateJournal();
  // bound before: refused after, as any writer from before (a reload binds it again); said once, however many
  // appends are refused (the board page shows it: onHistoryRefused -> showBusyNotice)
  const said = [], off = W.onHistoryRefused((m) => said.push(m));
  await Promise.resolve(fpBefore.append({ time: "2026-10-27T00:00:01.000Z", id: "q1" })).catch(() => {});
  await sleep(150);
  check((await rows(bdb, before)) === 0, "…and after the activation its append is refused, nothing written (reload to bind again)");
  check(typeof S.HISTORY_STOPPED === "string" && J(said) === J([S.HISTORY_STOPPED]), "…and said, that TimeTravel stopped recording in this tab: " + J(said));
  await Promise.resolve(fpBefore.append({ time: "2026-10-27T00:00:01.500Z", id: "q1b" })).catch(() => {});
  await sleep(150);
  check(said.length === 1 && (await rows(bdb, before)) === 0, "…once only: a second refused append writes nothing and says nothing more: " + said.length);
  // (the board page's notice of it (showHistoryNotice): at the top with Reload, which a deletion's progress and its
  // end (showBusyNotice, hideBusyNotice) neither replace nor hide; a pause is still a busy notice)
  const top = () => document.getElementById("sagebrush-reload-notice"), busy = () => document.getElementById("sagebrush-busy-notice");
  top()?.remove();
  W.showHistoryNotice?.(said[0], S.HISTORY_STOPPED);
  W.showBusyNotice("Deleting old versions… 50%");
  W.hideBusyNotice();
  check(!!top() && top().textContent.includes(S.HISTORY_STOPPED) && [...top().querySelectorAll("button")].some((x) => x.textContent === "Reload") && !busy(), "…shown at the top with Reload, kept through a deletion's progress and its end: " + J(top()?.textContent ?? null));
  // (a newer tab closing the database after it: the page's "can't save" is said over it, in the one box; and said
  // first, it isn't replaced by TimeTravel's: board's R1 on 65675b8e)
  W.showReloadNotice();
  check(top()?.textContent.includes(W.RELOAD_TEXT ?? "updated in another tab") && !top().textContent.includes(S.HISTORY_STOPPED) && document.querySelectorAll("#sagebrush-reload-notice").length === 1, "…and a later closing of the database (showReloadNotice()) says the page can't save, in its place: " + J(top()?.textContent ?? null));
  W.showHistoryNotice?.(S.HISTORY_STOPPED, S.HISTORY_STOPPED);
  check(top()?.textContent.includes(W.RELOAD_TEXT ?? "updated in another tab") && !top().textContent.includes(S.HISTORY_STOPPED), "…which TimeTravel's notice, after it, doesn't replace");
  top()?.remove();
  W.showHistoryNotice?.(S.HISTORY_REFUSED, S.HISTORY_STOPPED);
  check(!top() && busy()?.textContent.includes(S.HISTORY_REFUSED), "…while TimeTravel's pause is still a busy notice");
  W.hideBusyNotice();
  // bound after: in "journal", it appends and clears; a store that doesn't follow the phase is still refused
  const fp = new W.IdbPatchStore(bdb, after, { followPhase: true });
  await fp.loadInitial();
  check(fp.phase === "journal", "a phase-following board store bound after activation is in \"journal\": " + fp.phase);
  check(fp.append({ time: "2026-10-27T00:00:02.000Z", id: "q2" }) === true, "…its append is taken");
  await sleep(150);
  check((await rows(bdb, after)) === 1, "…and written: an owned board's TimeTravel keeps working under an active journal");
  const plain = new W.IdbPatchStore(bdb, after);
  await plain.loadInitial();
  await Promise.resolve(plain.append({ time: "2026-10-27T00:00:03.000Z", id: "q3" })).catch(() => {});
  await sleep(150);
  check((await rows(bdb, after)) === 1, "…while a store that doesn't follow the phase (the board page before this build) is still refused");
  off();
  check(said.length === 1, "…and nothing said by the store bound after, nor by one that doesn't follow the phase: " + J(said));
  const cleared = await fp.clear().then(() => "cleared", (e) => "refused: " + String(e?.message ?? e).slice(0, 80));
  check(cleared === "cleared" && (await rows(bdb, after)) === 0, "…and the phase-following store clears its history: " + cleared);
  bdb.close();
  w.close();
}

// (the notebooks' history as a reset leaves it to be emptied: 650 notebooks' rows, half sorting before the fence's key
// [FENCE, ""] and half after it, so the fence is inside the pages; and sync's rows, its counters among them)
const SYNC_NB = "\u0001s:";
const COUNTERS = [[SYNC_NB, "n"], [SYNC_NB, "b:m:local"], [SYNC_NB, "b:p:local"]];
async function seedHistory(h) {
  await new Promise((ok, no) => {
    const tx = h.transaction("history", "readwrite"), st = tx.objectStore("history");
    for (let i = 0; i < 325; i++) {
      st.put({ nb: "11111111-0000-4000-8000-" + String(i).padStart(12, "0"), time: "t" + i, env: { i } });
      st.put({ nb: "aaaaaaaa-0000-4000-8000-" + String(i).padStart(12, "0"), time: "t" + i, env: { i } });
    }
    for (const [nb, time] of COUNTERS) st.put({ nb, time, v: { bytes: 1, next: 1 } });
    st.put({ nb: SYNC_NB, time: "d:local:x", v: { h: "h1", meta: 1 } });
    st.put({ nb: SYNC_NB + "h1", time: "j", v: { j: 1 } });
    tx.oncomplete = ok; tx.onerror = () => no(tx.error);
  });
}
const allKeys = (h) => new Promise((ok, no) => { const r = h.transaction("history").objectStore("history").getAllKeys(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const isFenceKey = (k) => k[0] === FENCE && k[1] === "";
const counterKey = (k) => COUNTERS.some((c) => c[0] === k[0] && c[1] === k[1]);

async function resetPurgesHistory() {
  // 2c-1d-iii §6 (daybreak3's D3, D4): a reset to a new workspace empties the notebooks' history, every row but its
  // fence: RESET_PAGE keys a page, each by its key (the fence inside the pages kept), the counters last
  {
    const o = await named(), w = await open(o);
    await w.activateJournal();
    const h = await W.openHistoryDb();
    await seedHistory(h);
    const pages = [];
    W.RESET_HOOK.afterPage = (store, n) => { if (store === "history") pages.push([n, allKeys(h)]); };
    await w.reset("new");
    await w.settled();
    W.RESET_HOOK.afterPage = undefined;
    const snaps = await Promise.all(pages.map(([n, p]) => p.then((ks) => ({ n, fence: ks.filter(isFenceKey).length, counters: ks.filter(counterKey).length, left: ks.length }))));
    const last = snaps[snaps.length - 1], keys = await allKeys(h);
    check(snaps.length >= 3 && snaps.every((x) => x.n <= W.RESET_PAGE && x.fence === 1) && snaps.slice(0, -1).every((x) => x.counters === 3) && last.n === 3 && last.counters === 0, "D3: the history emptied RESET_PAGE keys a page at most, the fence inside the pages kept at every page, the counters deleted last: " + J(snaps.map((x) => [x.n, x.counters, x.left])));
    check(keys.length === 1 && isFenceKey(keys[0]) && (await meta(w, "purgeMain")) === undefined && J(phases(await fences(w))) === J(["journal", "journal", "journal"]), "D3/D4: then the history holds exactly its fence, the purge's marker dropped, the fences \"journal\": " + J(keys.length));
    h.close();
    w.close();
  }
  // (killed between pages, then opened again: resumed to the end; the marker and the counters kept meanwhile)
  {
    const o = await named();
    let w = await open(o);
    await w.activateJournal();
    const h = await W.openHistoryDb();
    await seedHistory(h);
    let seen = 0;
    W.RESET_HOOK.afterPage = (store) => { if (store === "history" && ++seen === 1) throw new Error("stopped here (test)"); };
    const threw = await w.reset("new").then(() => false, () => true);
    await w.settled();
    W.RESET_HOOK.afterPage = undefined;
    const mid = await allKeys(h);
    // (the purge runs after the reset proper, in the background: a stop there is noted, not thrown to the reset)
    check(mid.length > 1 && mid.filter(isFenceKey).length === 1 && mid.filter(counterKey).length === 3 && (await meta(w, "purgeMain")) === true, "D3: killed after the history's first page: the purge's marker, the counters and the fence kept: " + J({ threw, left: mid.length }));
    w.close();
    w = await open(o);
    await w.settled();
    const keys = await allKeys(h);
    check(keys.length === 1 && isFenceKey(keys[0]) && (await meta(w, "purgeMain")) === undefined, "D3: …opened again, resumed to the end: exactly the fence left, the marker dropped");
    h.close();
    w.close();
  }
  // (the history database unavailable: the purge unknown, not done; the marker kept, retried at the next open)
  {
    const o = await named();
    let w = await open(o);
    await w.activateJournal();
    const h = await W.openHistoryDb();
    await seedHistory(h);
    W.RESET_HOOK.historyDb = async () => null;
    await w.reset("new").catch(() => {});
    await w.settled();
    const state = w.durability.state, left = (await allKeys(h)).length;
    const wrote = await w.create("/during-the-purge.ipynb").then(() => true, () => false);
    check((await meta(w, "purgeMain")) === true && left > 1 && w.quarantined && !wrote, "D3: the history database unavailable: the purge unknown, its marker kept, nothing deleted, writers refused meanwhile: " + J({ state, left, wrote }));
    W.RESET_HOOK.historyDb = undefined;
    w.close();
    w = await open(o);
    await w.settled();
    const keys = await allKeys(h);
    check(keys.length === 1 && isFenceKey(keys[0]) && (await meta(w, "purgeMain")) === undefined, "D3: …once it can be had, the next open finishes it: exactly the fence left");
    h.close();
    w.close();
  }
}

const CASES = [gated, upgradeAndOldBuilds, beforeActivation, activation, writersRefused, boardsFollowPhase, refusalRule, keptByLaterWrites, stopsCarriedOn, blockedFence, markAdopted, resetKeepsMeta, storeUnopened, resetPurgesHistory];
export async function run() {
  for (const c of CASES) {
    console.log("test: " + c.name);
    try {
      await c();
    } catch (e) {
      check(false, `${c.name} threw: ${e?.stack ?? e}`);
    }
    W.JOURNAL_HOOK.afterFence = undefined;
    W.JOURNAL_HOOK.unopened = undefined;
    W.RESET_HOOK.afterPage = undefined;
    W.RESET_HOOK.historyDb = undefined;
  }
  return results;
}
