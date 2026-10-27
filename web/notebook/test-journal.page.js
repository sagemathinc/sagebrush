// The cases of web/notebook/test-journal.mjs, run in the page (real IndexedDB and Web Locks): the notebook journal's
// core (journal.js).  W the workspace, N the journal, H the notebook's history (history.js), R sync's rows.  Each case
// has a workspace of its own; the notebooks' history is one database for the whole origin, its fence dropped before
// each case (in a browser there is only ever one workspace), and each case's notebooks have ids of their own.
import { W, N, H, R } from "./all.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FENCE = "__sagebrush-workspace__";
let n = 0;
const rawGet = (db, store, key) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const rawPut = (db, store, value) => new Promise((ok, no) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(value); tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); });
const rawDel = (db, store, key) => new Promise((ok, no) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).delete(key); tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); });
const rawAll = (db, store, range) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAll(range); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const named = async () => {
  n++;
  localStorage.clear();
  for (const h of [await W.openHistoryDb(), await W.openBoardHistoryDb()]) if (h) { await rawDel(h, "history", [FENCE, ""]).catch(() => {}); h.close(); }
  return { name: `nbj-${n}`, mainName: `mainnbj-${n}` };
};
// (a workspace of this case's, the journal active in it, and the notebooks' history)
async function active() {
  const w = await W.Workspace.open(await named());
  W.registerJournalWriter("notebooks");
  W.registerJournalWriter("boards");
  await w.activateJournal();
  return { w, hdb: await W.openHistoryDb() };
}
const newId = () => crypto.randomUUID();
const doc = (cells, extra = {}) => ({ name: "t", mode: "python", cells: cells.map(([id, code]) => ({ id, code })), ...extra });
const codes = (d) => J((d?.cells ?? []).map((c) => [c.id, c.code]));
// (the journal's classes over this page's stores, as the notebook page makes them)
const KIT = N.journalClasses({ IdbStore: W.IdbStore, IdbPatchStore: W.IdbPatchStore });
const store = (w, hdb, id, initial) => new KIT.JournalStore(w.main, hdb, id, initial, H);
const jState = (hdb, id) => N.readJournal(hdb, id);
const histRows = (hdb, id) => rawAll(hdb, "history", IDBKeyRange.bound([id, ""], [id, "\uffff"]));
const syncRows = (hdb) => rawAll(hdb, "history", IDBKeyRange.bound([R.SYNC_NB, ""], [R.SYNC_NB + "\uffff", "\uffff"]));
// (the journal's charges recounted from its rows: the metadata budget's and the pending budget's)
async function recount(hdb) {
  const rows = await syncRows(hdb);
  let meta = 0, pend = 0, counted = { meta: 0, pend: 0 };
  for (const r of rows) {
    if (r.nb === R.SYNC_NB && r.time.startsWith("d:")) meta += r.v.meta;
    else if (r.nb === R.SYNC_NB && r.time === "n") meta += R.rowCharge([r.nb, r.time], r.v);
    else if (r.nb === R.SYNC_NB && r.time === "b:m:local") counted.meta = r.v.bytes;
    else if (r.nb === R.SYNC_NB && r.time === "b:p:local") counted.pend = r.v.bytes;
    else if (r.time === "p") pend += R.rowCharge([r.nb, r.time], r.v);
  }
  // (each document's metadata as charged: its registry row and its j row, measured again)
  const ctr = rows.find((r) => r.nb === R.SYNC_NB && r.time === "n");
  let measured = ctr ? R.rowCharge([ctr.nb, ctr.time], ctr.v) : 0;
  for (const r of rows) if (r.nb === R.SYNC_NB && r.time.startsWith("d:")) {
    const j = rows.find((x) => x.nb === R.SYNC_NB + r.v.h && x.time === "j");
    measured += R.rowCharge([r.nb, r.time], { h: r.v.h, meta: r.v.meta }) + (j ? R.rowCharge([j.nb, j.time], j.v) : 0);
  }
  return { meta, pend, counted, measured };
}
const close = (...xs) => { for (const x of xs) try { x?.history?.close?.(); x?.close?.(); } catch {} };

async function inactive() {
  // before activation: the journal's store writes nothing (its phase isn't there yet); a plain store saves as before,
  // its record without j or hash
  const w = await W.Workspace.open(await named()), hdb = await W.openHistoryDb();
  const id = newId(), plain = new W.IdbStore(w.main, id, doc([["a", "1"]]));
  const d = await plain.load(), saved = await plain.save({ ...d, cells: [{ id: "a", code: "2" }] });
  const rec = await rawGet(w.main, "notebooks", id);
  check(!!saved?.saved && rec.cells[0].code === "2" && !("j" in rec) && !("hash" in rec), "before activation a plain store saves as on master, its record without j or hash: " + J(Object.keys(rec)));
  const id2 = newId(), st = store(w, hdb, id2, doc([["a", "x"]]));
  const why = await st.load().then(() => null, (e) => e?.message ?? String(e));
  check(why !== null && /isn't saving through sync's journal yet/.test(why) && (await rawGet(w.main, "notebooks", id2)) === undefined && (await syncRows(hdb)).every((r) => !r.time.includes(id2)), "…and the journal's store is refused, nothing written: " + why);
  close(st, w);
  hdb.close();
}

async function saves() {
  const { w, hdb } = await active(), id = newId();
  // a plain store is refused now
  const pid = newId(), plain = new W.IdbStore(w.main, pid, doc([]));
  const said = await plain.save(doc([["a", "1"]]));
  check(typeof said === "string" && /doesn't: reload/.test(said) && (await rawGet(w.main, "notebooks", pid)) === undefined, "after activation a plain store's save is refused, nothing written: " + said);
  // a new notebook: its first save journaled (row "new"), j 1, the hash of what it holds
  const st = store(w, hdb, id, doc([["a", "1"], ["b", "2"]]));
  const d0 = await st.load();
  let rec = await rawGet(w.main, "notebooks", id), js = await jState(hdb, id);
  check(st.recovered.row === "new" && rec.j === 1 && js.J === 1 && rec.hash === (await N.docHash(rec)) && codes(d0) === codes(rec), "a new notebook: T1 then T2, record j 1 = jseq, its hash: " + J({ row: st.recovered.row, j: rec.j, J: js.J }));
  const rows0 = await histRows(hdb, id);
  check(rows0.length === 1 && rows0[0].j === 1, "…its version in the history with j 1");
  // edits: each a version at the next j, the record following
  let rev = rec.rev;
  for (const code of ["11", "111"]) {
    const out = await st.save({ ...rec, cells: [{ id: "a", code }, { id: "b", code: "2" }], baseRev: rev });
    rec = await rawGet(w.main, "notebooks", id);
    rev = out.rev;
  }
  js = await jState(hdb, id);
  check(rec.j === 3 && js.J === 3 && rec.cells[0].code === "111" && rec.hash === (await N.docHash(rec)), "two edits: j 3 in both, the record holding the last: " + J({ j: rec.j, J: js.J }));
  const rows = await histRows(hdb, id);
  check(J(rows.map((r) => r.j)) === J([1, 2, 3]), "…each version in the history with its j: " + J(rows.map((r) => r.j)));
  // an output-only save: no version, the same j
  const out = await st.save({ ...rec, cells: [{ id: "a", code: "111", outputs: [{ text: "x" }] }, { id: "b", code: "2" }], baseRev: rev });
  rec = await rawGet(w.main, "notebooks", id);
  check(!!out?.saved && rec.j === 3 && (await jState(hdb, id)).J === 3 && rec.cells[0].outputs?.[0]?.text === "x", "an outputs-only save: written at the same j, no version");
  // a stale base: a conflict, nothing written
  const c = await st.save({ ...rec, cells: [{ id: "a", code: "zzz" }], baseRev: rev });
  check(c?.conflict && (await rawGet(w.main, "notebooks", id)).cells[0].code === "111", "a save from a stale revision: a conflict, the record as it was (T2's compare and swap)");
  // a journal store's save without the journal's {j, hash}, and a plain store's with it: refused, nothing written
  const bare = await W.IdbStore.prototype.save.call(st, { ...rec, cells: [{ id: "a", code: "bare" }], baseRev: rec.rev });
  const plainJ = await new W.IdbStore(w.main, id).save({ ...rec, cells: [{ id: "a", code: "plain" }], baseRev: rec.rev }, { journal: { j: 9, hash: "x" } });
  check(typeof bare === "string" && /didn't come through sync's journal/.test(bare) && typeof plainJ === "string" && (await rawGet(w.main, "notebooks", id)).cells[0].code === "111", "a journal store's save without the journal's word, and a plain store's with it: refused, nothing written: " + bare);
  // the record never moves back: a T2 at an earlier j
  const back = await W.IdbStore.prototype.save.call(st, { ...rec, baseRev: rec.rev }, { journal: { j: 2, hash: rec.hash } });
  check(back?.conflict && (await rawGet(w.main, "notebooks", id)).j === 3, "a T2 at a j earlier than the record's: a conflict, nothing written");
  // the charges: as counted, and as measured again
  const c1 = await recount(hdb);
  check(c1.meta === c1.counted.meta && c1.measured === c1.meta && c1.pend === c1.counted.pend, "the journal's charges equal a recount of its rows: " + J(c1));
  close(st, w);
  hdb.close();
}

async function recoveryRows() {
  const { w, hdb } = await active();
  // row "j = J": consistent
  {
    const id = newId(), st = store(w, hdb, id, doc([["a", "1"]]));
    await st.load(); close(st);
    const again = store(w, hdb, id);
    await again.load();
    check(again.recovered.row === "consistent", "recovery, j = J and the hash right: nothing done (" + again.recovered.row + ")");
    close(again);
  }
  // row "j < J": T1 committed, T2 didn't (the tab gone between)
  {
    const id = newId(), st = store(w, hdb, id, doc([["a", "1"]]));
    const d = await st.load();
    const r = await st.t1({ ...d, cells: [{ id: "a", code: "T1 only" }] });
    close(st);
    const before = await rawGet(w.main, "notebooks", id);
    const again = store(w, hdb, id), d2 = await again.load(), rec = await rawGet(w.main, "notebooks", id);
    check(r.j === 2 && before.j === 1 && again.recovered.row === "rewritten" && d2.cells[0].code === "T1 only" && rec.j === 2 && rec.hash === (await N.docHash(rec)), "recovery, j < J: the record rewritten from the history at J: " + J({ row: again.recovered.row, j: rec.j }));
    close(again);
  }
  // row "hash differs", j = J: a value written by code from before the journal (its record without j or hash)
  {
    const id = newId(), st = store(w, hdb, id, doc([["a", "1"], ["b", "2"]]));
    const d = await st.load(); close(st);
    const { j: _j, hash: _h, ...old } = await rawGet(w.main, "notebooks", id);
    await rawPut(w.main, "notebooks", { ...old, cells: [{ id: "a", code: "old code wrote this" }, { id: "b", code: "2" }], rev: old.rev + 1 });
    const again = store(w, hdb, id), d2 = await again.load(), rec = await rawGet(w.main, "notebooks", id), js = await jState(hdb, id);
    const last = H.fromRecords(again.history.session.value());
    check(again.recovered.row === "journaled" && d2.cells[0].code === "old code wrote this" && rec.j === 2 && js.J === 2 && last.cells[0].code === "old code wrote this", "recovery, the hash wrong at j = J: the record's value journaled (a version at the next j), then written: " + J({ row: again.recovered.row, j: rec.j, J: js.J }));
    close(again);
  }
  // row "hash differs", the hash present but stale: a page from before the journal saves the record it loaded (its j
  // and hash among the fields it keeps) with new cells
  {
    const id = newId(), st = store(w, hdb, id, doc([["a", "1"]]));
    await st.load(); close(st);
    const rec0 = await rawGet(w.main, "notebooks", id);
    await rawPut(w.main, "notebooks", { ...rec0, cells: [{ id: "a", code: "an old page's save" }], rev: rec0.rev + 1 });
    const again = store(w, hdb, id), d2 = await again.load(), rec = await rawGet(w.main, "notebooks", id);
    check(again.recovered.row === "journaled" && d2.cells[0].code === "an old page's save" && rec.j === 2 && rec.hash === (await N.docHash(rec)) && rec.hash !== rec0.hash, "recovery, a stale hash kept by an old page's save at j = J: journaled, then written with its own hash: " + J({ row: again.recovered.row, j: rec.j }));
    close(again);
  }
  // row "hash differs", j < J: the history moved on and the record holds other work: merged three ways
  {
    const id = newId(), st = store(w, hdb, id, doc([["a", "1"], ["b", "2"]]));
    const d = await st.load();
    await st.t1({ ...d, cells: [{ id: "a", code: "history's" }, { id: "b", code: "2" }] });
    close(st);
    const { hash: _h, ...rec0 } = await rawGet(w.main, "notebooks", id);
    await rawPut(w.main, "notebooks", { ...rec0, cells: [{ id: "a", code: "1" }, { id: "b", code: "the record's" }], rev: rec0.rev + 1 });
    const again = store(w, hdb, id), d2 = await again.load(), rec = await rawGet(w.main, "notebooks", id);
    check(again.recovered.row === "journaled" && codes(d2) === J([["a", "history's"], ["b", "the record's"]]) && rec.j === 3 && rec.hash === (await N.docHash(rec)), "recovery, the hash wrong at j < J, different cells: both kept, merged and journaled: " + codes(d2));
    close(again);
  }
  // a clash: the same cell changed both ways: the history's value is the document, the record's kept as a copy
  {
    const id = newId(), st = store(w, hdb, id, doc([["a", "1"]], { name: "mine" }));
    const d = await st.load();
    await st.t1({ ...d, cells: [{ id: "a", code: "history's" }] });
    close(st);
    const { hash: _h, ...rec0 } = await rawGet(w.main, "notebooks", id);
    await rawPut(w.main, "notebooks", { ...rec0, cells: [{ id: "a", code: "the record's" }], rev: rec0.rev + 1 });
    const again = store(w, hdb, id), d2 = await again.load();
    const copy = again.recovered.copy && (await rawGet(w.main, "notebooks", again.recovered.copy));
    check(again.recovered.row === "copied" && codes(d2) === J([["a", "history's"]]) && copy?.cells?.[0]?.code === "the record's" && copy.name === "mine (kept from this browser)" && copy.j === 1 && copy.hash === (await N.docHash(copy)), "recovery, a clash: the history's value kept as the document, the record's whole as a journaled copy: " + J({ row: again.recovered.row, copy: copy?.name }));
    close(again);
  }
  close(w);
  hdb.close();
}

async function pendingValue() {
  // F4: TimeTravel paused (a version it didn't keep), the next save goes to the pending value at the next j
  const { w, hdb } = await active(), id = newId(), st = store(w, hdb, id, doc([["a", "1"]]));
  const d = await st.load();
  st.history.refused("refused-for-the-test");
  await st.history.rebuilding;
  const out = await st.save({ ...d, cells: [{ id: "a", code: "pending" }], baseRev: d.rev });
  let rec = await rawGet(w.main, "notebooks", id), js = await jState(hdb, id);
  check(!!out?.saved && js.pending?.j === 2 && js.J === 2 && rec.j === 2 && rec.cells[0].code === "pending", "paused: the save's T1 is the pending value at the next j, and T2 follows: " + J({ pending: js.pending?.j, J: js.J, j: rec.j }));
  check(H.fromRecords(st.history.codec.fromString(js.pending.value)).cells[0].code === "pending", "…the pending value holds the version");
  // again: replaced, at the next j, conditional on the j the tab saw
  await st.save({ ...rec, cells: [{ id: "a", code: "pending 2" }], baseRev: out.rev });
  js = await jState(hdb, id);
  check(js.pending.j === 3 && js.J === 3, "…a second paused save replaces it at j 3");
  // a pending value from a tab that hadn't seen j 3: a conflict, nothing written
  const stale = await N.writePending(st.patches, "x", 1);
  check(stale.conflict === 3 && (await jState(hdb, id)).pending.j === 3, "a pending value conditional on a j that isn't the document's: a conflict, nothing written");
  // a patch while a pending value waits: refused (the history pauses, F4)
  const other = KIT.journalPatchStore(hdb, id);
  other.append({ time: "0000000000000-zz", parents: [], patch: [] });
  const r = await other.appended("0000000000000-zz");
  check(r.refused === N.PENDING_OPEN && !(await histRows(hdb, id)).some((x) => x.time === "0000000000000-zz"), "a patch while a pending value waits: refused, not written");
  close(st);
  // recovery through the pending value: T1 only, then a load rewrites the record from it
  const st2 = store(w, hdb, id), d2 = await st2.load();
  check(st2.recovered.row === "consistent" && st2.history.paused, "reloaded: consistent, the history still paused while the pending value waits");
  await st2.t1({ ...d2, cells: [{ id: "a", code: "pending, T1 only" }] });
  close(st2);
  const st3 = store(w, hdb, id), d3 = await st3.load();
  rec = await rawGet(w.main, "notebooks", id);
  check(st3.recovered.row === "rewritten" && d3.cells[0].code === "pending, T1 only" && rec.j === 4, "recovery, j < J with a pending value: the record rewritten from it: " + J({ row: st3.recovered.row, j: rec.j }));
  const c = await recount(hdb);
  check(c.pend === c.counted.pend && c.pend > 0 && c.meta === c.counted.meta, "the pending value's charge equals a recount: " + J(c));
  close(st3, w);
  hdb.close();
}

async function budgetsAndDrop() {
  const { w, hdb } = await active();
  // the metadata budget full: a new notebook's first save refused, nothing of it written
  const before = J(await syncRows(hdb)), keep = N.JOURNAL_BUDGETS.metaAll;
  N.JOURNAL_BUDGETS.metaAll = (await recount(hdb)).counted.meta + 10;
  const id = newId(), st = store(w, hdb, id, doc([["a", "1"]]));
  const why = await st.load().then(() => null, (e) => e?.message ?? String(e));
  N.JOURNAL_BUDGETS.metaAll = keep;
  check(why !== null && /too many documents/.test(why) && J(await syncRows(hdb)) === before && (await rawGet(w.main, "notebooks", id)) === undefined && (await histRows(hdb, id)).length === 0, "the metadata budget full: refused, said, nothing written: " + why);
  close(st);
  // a dropped notebook's journal rows go with it, their charges released
  const id2 = newId(), st2 = store(w, hdb, id2, doc([["a", "1"]]));
  await st2.load();
  const c0 = await recount(hdb), reg = (await syncRows(hdb)).find((r) => r.time === "d:local:" + id2);
  await st2.patches.drop();
  const c1 = await recount(hdb), left = (await syncRows(hdb)).filter((r) => r.nb === R.SYNC_NB + reg.v.h || r.time === "d:local:" + id2);
  check(reg && left.length === 0 && (await histRows(hdb, id2)).length === 0 && c1.counted.meta === c0.counted.meta - reg.v.meta && c1.meta === c1.counted.meta, "a drop deletes the document's journal rows with its versions, and releases their charge: " + J({ before: c0.counted.meta, after: c1.counted.meta }));
  // a notebook removed for good by the workspace (emptying Trash): its journal rows go with its versions
  const id4 = newId(), st4 = store(w, hdb, id4, doc([["a", "1"]]));
  await st4.load();
  close(st4);
  const c2 = await recount(hdb), reg4 = (await syncRows(hdb)).find((r) => r.time === "d:local:" + id4);
  await w.dropContents([{ kind: "notebook", ref: id4 }]);
  const c3 = await recount(hdb), left4 = (await syncRows(hdb)).filter((r) => r.nb === R.SYNC_NB + reg4.v.h || r.time === "d:local:" + id4);
  check(reg4 && left4.length === 0 && (await histRows(hdb, id4)).length === 0 && (await rawGet(w.main, "notebooks", id4)) === undefined && c3.counted.meta === c2.counted.meta - reg4.v.meta && c3.meta === c3.counted.meta, "the workspace's dropContents deletes a notebook's journal rows too, releasing their charge: " + J({ reg: !!reg4, left: left4.length, hist: (await histRows(hdb, id4)).length, c2: c2.counted.meta, c3: c3.counted.meta, m: reg4?.v.meta, c3m: c3.meta }));
  // a clear keeps the journal's j: the next version is at a later j
  const id3 = newId(), st3 = store(w, hdb, id3, doc([["a", "1"]]));
  const d3 = await st3.load();
  await st3.history.clear();
  await st3.save({ ...d3, cells: [{ id: "a", code: "after clear" }], baseRev: d3.rev });
  const rec = await rawGet(w.main, "notebooks", id3);
  check(rec.j === 2 && (await jState(hdb, id3)).J === 2, "a TimeTravel clear keeps jseq: the next version at j 2");
  close(st2, st3, w);
  hdb.close();
}

const CASES = [inactive, saves, recoveryRows, pendingValue, budgetsAndDrop];
export async function run() {
  for (const c of CASES) {
    console.log("test: " + c.name);
    try {
      await c();
    } catch (e) {
      check(false, `${c.name} threw: ${e?.stack ?? e}`);
    }
  }
  return results;
}
