// The cases of web/notebook/test-journal.mjs, run in the page (real IndexedDB and Web Locks): the notebook journal's
// core (journal.js).  W the workspace, N the journal, H the notebook's history (history.js), R sync's rows.  Each case
// has a workspace of its own; the notebooks' history is one database for the whole origin, its fence dropped before
// each case (in a browser there is only ever one workspace), and each case's notebooks have ids of their own.
import { W, N, H, R, B, S } from "./all.js";

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
    else if (r.nb !== R.SYNC_NB && r.time.startsWith("p")) pend += R.rowCharge([r.nb, r.time], r.v);
  }
  // (each document's metadata as charged: its registry row and its j row, measured again)
  const ctr = rows.find((r) => r.nb === R.SYNC_NB && r.time === "n");
  let measured = ctr ? R.rowCharge([ctr.nb, ctr.time], ctr.v) : 0;
  for (const r of rows) if (r.nb === R.SYNC_NB && r.time.startsWith("d:")) {
    // (its j row, and a synced document's start and slot rows (2c-2))
    measured += R.rowCharge([r.nb, r.time], { h: r.v.h, meta: r.v.meta });
    for (const L of ["j", "m", "s"]) { const x = rows.find((y) => y.nb === R.SYNC_NB + r.v.h && y.time === L); if (x) measured += R.rowCharge([x.nb, x.time], x.v); }
  }
  return { meta, pend, counted, measured };
}
// (a store let go (its writer lock with it), a database closed)
const close = async (...xs) => { for (const x of xs) try { if (x?.release) await x.release(); else x?.close?.(); } catch {} };


// (a promise's outcome, or "timeout" after ms)
const within = (p, ms) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), sleep(ms).then(() => "timeout")]);
const fenceRow = (hdb) => rawGet(hdb, "history", [FENCE, ""]);
// (a notebook loaded fresh, and the crash points: T1 alone (the tab gone before T2); T1 and T2 without the prune)
const loadNew = async (w, hdb, cells, extra) => { const id = newId(), st = store(w, hdb, id, doc(cells, extra)); const d = await st.load(); return { id, st, d }; };
const t1Only = (st, d) => st.t1(d);
const reopen = async (w, hdb, id) => { const st = store(w, hdb, id); const d = await st.load(); return { st, d, row: st.recovered.row, catchUp: st.recovered.catchUp }; };
// (the persisted document: its cells' text, its hash right, its j the history's J, no intent left)
async function persisted(w, hdb, id) {
  const rec = await rawGet(w.main, "notebooks", id), js = await jState(hdb, id);
  return { codes: codes(rec), hashOk: rec.hash === (await N.docHash(rec)), jOk: rec.j === js.J, intents: js.intents.length, rec, js };
}
const pause = async (st) => { st.history.refused("refused-for-the-test"); await st.history.rebuilding; };
// (the outputs-only save that takes the record to revision 2 at its first load (astra's repro))
async function outputsOnly(st, d) {
  const out = await st.save({ ...d, cells: d.cells.map((c) => ({ ...c, outputs: [{ text: "o" }] })), baseRev: d.rev });
  return { ...d, cells: d.cells.map((c) => ({ ...c, outputs: [{ text: "o" }] })), rev: out.rev };
}

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
  await close(st, w);
  hdb.close();
}

async function saves() {
  const { w, hdb } = await active();
  const pid = newId(), plain = new W.IdbStore(w.main, pid, doc([]));
  const said = await plain.save(doc([["a", "1"]]));
  check(typeof said === "string" && /doesn't: reload/.test(said) && (await rawGet(w.main, "notebooks", pid)) === undefined, "after activation a plain store's save is refused, nothing written: " + said);
  const { id, st, d } = await loadNew(w, hdb, [["a", "1"], ["b", "2"]]);
  let p = await persisted(w, hdb, id);
  check(st.recovered.row === "new" && p.rec.j === 1 && p.jOk && p.hashOk && p.intents === 0 && codes(d) === p.codes, "a new notebook: T1 (its intent, its version) then T2, j 1, its hash, the intent pruned: " + J({ row: st.recovered.row, j: p.rec.j, intents: p.intents }));
  let rec = p.rec, rev = rec.rev;
  for (const code of ["11", "111"]) { const out = await st.save({ ...rec, cells: [{ id: "a", code }, { id: "b", code: "2" }], baseRev: rev }); rev = out.rev; rec = await rawGet(w.main, "notebooks", id); }
  p = await persisted(w, hdb, id);
  check(p.rec.j === 3 && p.jOk && p.hashOk && p.intents === 0 && J((await histRows(hdb, id)).map((r) => r.j)) === J([1, 2, 3]), "two edits: each a version and an intent at its j, the record at j 3, every intent pruned");
  // an outputs-only save: an intent alone at the next j (every save writes one), no version
  const out = await st.save({ ...rec, cells: [{ id: "a", code: "111", outputs: [{ text: "x" }] }, { id: "b", code: "2" }], baseRev: rev });
  p = await persisted(w, hdb, id);
  check(!!out?.saved && p.rec.j === 4 && p.jOk && p.intents === 0 && (await histRows(hdb, id)).length === 3 && p.rec.cells[0].outputs?.[0]?.text === "x", "an outputs-only save: its intent alone at j 4, no version, the record at j 4");
  rec = p.rec;
  const c = await st.save({ ...rec, cells: [{ id: "a", code: "zzz" }], baseRev: rec.rev - 1 });
  p = await persisted(w, hdb, id);
  check(c?.conflict && p.rec.cells[0].code === "111" && p.intents === 1, "a save from a stale revision: a conflict, the record as it was, its intent left (refused, for recovery's replay to skip)");
  const back = await W.IdbStore.prototype.save.call(st, { ...rec, baseRev: rec.rev }, { journal: { j: 2, hash: rec.hash } });
  check(back?.conflict && (await rawGet(w.main, "notebooks", id)).j === 4, "a T2 at a j earlier than the record's: a conflict, nothing written");
  const bare = await W.IdbStore.prototype.save.call(st, { ...rec, cells: [{ id: "a", code: "bare" }], baseRev: rec.rev });
  const plainJ = await new W.IdbStore(w.main, id).save({ ...rec, cells: [{ id: "a", code: "plain" }], baseRev: rec.rev }, { journal: { j: 9, hash: "x" } });
  check(typeof bare === "string" && /didn't come through sync's journal/.test(bare) && typeof plainJ === "string" && (await rawGet(w.main, "notebooks", id)).cells[0].code === "111", "a journal store's save without the journal's word, and a plain store's with it: refused, nothing written");
  const c1 = await recount(hdb);
  check(c1.meta === c1.counted.meta && c1.measured === c1.meta && c1.pend === c1.counted.pend, "the journal's charges equal a recount of its rows: " + J(c1));
  await close(st, w);
  hdb.close();
}

async function replayModel() {
  // design r4 §3.1's replay, pure: the traces of §5
  const it = (j, srev, value) => ({ j, srev, value });
  const cases = [
    ["original: a stale edit", 2, [it(3, 1, "C")], null],
    ["repeated stale", 2, [it(3, 1, "C1"), it(4, 1, "C2")], null],
    ["isolated interrupted", 2, [it(2, 2, "B")], "B"],
    ["1a: B interrupted, then stale C", 2, [it(2, 2, "B"), it(3, 1, "C")], "B"],
    ["1b: stale B, then an identical retry", 2, [it(2, 1, "B"), it(3, 2, "B'")], "B'"],
    ["two interrupted in order", 2, [it(2, 2, "B"), it(3, 3, "D")], "D"],
    ["an unconditional save", 2, [it(2, null, "N")], "N"],
    ["no record: the last", null, [it(1, null, "X"), it(2, 1, "Y")], "Y"],
  ];
  for (const [name, rev, list, want] of cases) check((N.replay(rev, list)?.value ?? null) === want, `replay: ${name} -> ${want ?? "the record"}`);
}

// (the traces, in the normal path or paused (each save an intent alone), the document checked after reopening, and
// again after a second reopen: "consistent", nothing left)
async function traces(paused) {
  const { w, hdb } = await active(), tag = paused ? " (paused)" : "";
  const check2 = async (id, want, rowWant, what) => {
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    await close(r.st);
    const r2 = await reopen(w, hdb, id), p2 = await persisted(w, hdb, id);
    await close(r2.st);
    check(r.row === rowWant && p.codes === want && p.hashOk && p.jOk && p.intents === 0 && r2.row === "consistent" && p2.codes === want, `${what}${tag}: ${r.row}, the document ${p.codes}, hash and j right, nothing left; reopened again, consistent`);
  };
  // the original: an outputs-only save (rev 2), then a stale edit refused: A stays
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    if (paused) await pause(st);
    const d2 = await outputsOnly(st, d);
    const c = await st.save({ ...d2, cells: [{ id: "a", code: "C" }], baseRev: d.rev });
    await close(st);
    check(!!c?.conflict, "the stale edit is refused" + tag);
    await check2(id, J([["a", "A"]]), "stamped", "astra's original: the stale edit never becomes the document");
  }
  // repeated stale saves
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    if (paused) await pause(st);
    const d2 = await outputsOnly(st, d);
    for (const x of ["C1", "C2"]) await st.save({ ...d2, cells: [{ id: "a", code: x }], baseRev: d.rev });
    await close(st);
    await check2(id, J([["a", "A"]]), "stamped", "repeated stale saves");
  }
  // an isolated interrupted save: the whole B written (astra's 1c)
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    if (paused) await pause(st);
    await t1Only(st, { ...d, cells: [{ id: "a", code: "B" }], baseRev: d.rev });
    await close(st);
    await check2(id, J([["a", "B"]]), "rewritten", "an isolated interrupted save: the whole B written");
  }
  // 1a: B interrupted, then a stale C refused: B
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    if (paused) await pause(st);
    const d2 = await outputsOnly(st, d);
    await t1Only(st, { ...d2, cells: [{ id: "a", code: "B" }], baseRev: d2.rev });
    const c = await st.save({ ...d2, cells: [{ id: "a", code: "C" }], baseRev: d.rev });
    await close(st);
    check(!!c?.conflict, "1a's stale C is refused" + tag);
    await check2(id, J([["a", "B"]]), "rewritten", "1a: an interrupted B then a refused C: B is the document");
  }
  // 1b: a stale B refused, then the identical value retried at the right revision, interrupted: B
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    if (paused) await pause(st);
    const d2 = await outputsOnly(st, d);
    const c = await st.save({ ...d2, cells: [{ id: "a", code: "B" }], baseRev: d.rev });
    const r = await t1Only(st, { ...d2, cells: [{ id: "a", code: "B" }], baseRev: d2.rev });
    await close(st);
    check(!!c?.conflict && r.j !== undefined, "1b: the stale B refused, the identical retry's T1 an intent of its own" + tag);
    await check2(id, J([["a", "B"]]), "rewritten", "1b: the identical retry, interrupted, is the document");
  }
  await close(w);
  hdb.close();
}
const tracesNormal = () => traces(false), tracesPaused = () => traces(true);

async function crashPoints() {
  // 1a's recovery stopped at each point: before its T2 (above), after its T2 before the prune, and after the prune
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  const d2 = await outputsOnly(st, d);
  const b = await t1Only(st, { ...d2, cells: [{ id: "a", code: "B" }], baseRev: d2.rev });
  await st.save({ ...d2, cells: [{ id: "a", code: "C" }], baseRev: d.rev });
  // (T2 of the outcome, without the prune: the record holds B at B's j, both intents still there)
  const bDoc = { ...d2, cells: [{ id: "a", code: "B", outputs: [{ text: "o" }] }] };
  const t2 = await W.IdbStore.prototype.save.call(st, { ...bDoc, baseRev: d2.rev }, { journal: { j: b.j, hash: await N.docHash(bDoc) } });
  await close(st);
  const mid = await jState(hdb, id);
  check(!!t2?.saved && mid.intents.length === 2, "crash after the outcome's T2, before its prune: the record holds B, both intents left");
  const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
  await close(r.st);
  check(r.row === "stamped" && p.codes === J([["a", "B"]]) && p.hashOk && p.jOk && p.intents === 0, "…reopened: B stays, j and hash right, the intents pruned: " + J({ row: r.row, codes: p.codes }));
  const r2 = await reopen(w, hdb, id);
  await close(r2.st);
  check(r2.row === "consistent", "…after the prune, consistent");
  await close(w);
  hdb.close();
}

async function atCapacity() {
  // design r4 §3.4: recovery adds no intent, so it progresses with the intents at their bound or the budget full.
  // 2c-1d-iii §1: a save whose T1 has no room is still written by T2, its j kept, marked; recovery's catch-up then
  // ingests it (one version, unmarked), or, paused, it stays marked
  const { w, hdb } = await active();
  for (const valid of [false, true]) {
    for (const paused of [false, true]) {
      const tag = `${valid ? "an interrupted B, then " : ""}${N.MAX_INTENTS} stale intents${paused ? " (paused)" : ""}`;
      const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
      if (paused) await pause(st);
      const d2 = await outputsOnly(st, d);
      if (valid) await t1Only(st, { ...d2, cells: [{ id: "a", code: "B" }], baseRev: d2.rev });
      // (stale saves, their T2s lost, until the intents are at their bound)
      for (let i = 0; (await jState(hdb, id)).intents.length < N.MAX_INTENTS; i++) await st.save({ ...d2, cells: [{ id: "a", code: "C" + i }], baseRev: d.rev });
      const rec0 = await rawGet(w.main, "notebooks", id), js0 = await jState(hdb, id), rows0 = (await histRows(hdb, id)).length;
      const out = await st.save({ ...d2, cells: [{ id: "a", code: "F" }], baseRev: rec0.rev });
      const rec = await rawGet(w.main, "notebooks", id), js = await jState(hdb, id);
      await close(st);
      check(out?.saved === N.SAVED_UNJOURNALED && out.unjournaled === true && rec.unjournaled === true && rec.j === rec0.j && rec.hash === (await N.docHash(rec)) && codes(rec) === J([["a", "F"]]) && J(js) === J(js0) && (await histRows(hdb, id)).length === rows0, `${tag}: the next save has no room for its T1: written all the same, its j kept, marked, said; nothing of it in the history: ${J(out?.saved)}`);
      const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
      check(r.row === "stamped" && p.codes === J([["a", "F"]]) && p.hashOk && p.jOk && p.intents === 0 && p.rec.unjournaled === undefined && r.catchUp === p.rec.j, `…reopened: the marked value kept (B's T2 lost to it), ingested as one version and unmarked, every intent pruned: ${r.row}`);
      const again = await r.st.save({ ...r.d, cells: [{ id: "a", code: "after" }], baseRev: r.d.rev });
      check(!!again?.saved && again.saved !== N.SAVED_UNJOURNALED, "…and the next save is journaled");
      await close(r.st);
    }
  }
  // the pending budget full: a save written all the same, marked; recovery ingests it, its prune freeing the room
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const d2 = await outputsOnly(st, d);
    await t1Only(st, { ...d2, cells: [{ id: "a", code: "B" }], baseRev: d2.rev });
    const keep = N.JOURNAL_BUDGETS.pendingAll;
    N.JOURNAL_BUDGETS.pendingAll = (await recount(hdb)).counted.pend;
    const out = await st.save({ ...d2, cells: [{ id: "a", code: "C" }], baseRev: d2.rev });
    await close(st);
    N.JOURNAL_BUDGETS.pendingAll = keep;
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    check(out?.saved === N.SAVED_UNJOURNALED && r.row === "stamped" && p.codes === J([["a", "C"]]) && p.intents === 0 && p.rec.unjournaled === undefined && r.catchUp === p.rec.j, "the pending budget full: a save written all the same, marked; recovery ingests it, unmarked, its prune freeing the room: " + J({ saved: out?.saved, row: r.row }));
    await close(r.st);
  }
  await close(w);
  hdb.close();
}

async function noIntentProducers() {
  // after an interrupted save X, every producer of history rows that isn't a save decides nothing (daybreak3)
  const { w, hdb } = await active();
  const make = async () => { const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]); await t1Only(st, { ...d, cells: [{ id: "a", code: "X" }], baseRev: d.rev }); return { id, st, d }; };
  // an execution-journal patch
  {
    const { id, st } = await make();
    st.history.journal([{ type: "run", id: "s:1", sid: "s", n: 1, t: 1 }]);
    await st.patches.appending;
    await close(st);
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    await close(r.st);
    check(r.row === "rewritten" && p.codes === J([["a", "X"]]) && p.jOk, "an interrupted save, then an execution-journal version: X is the document");
  }
  // a TimeTravel clear's re-record of another value
  {
    const { id, st, d } = await make();
    await st.history.clear({ ...d, cells: [{ id: "a", code: "the clear's" }] });
    await st.patches.appending;
    await close(st);
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    await close(r.st);
    check(r.row === "rewritten" && p.codes === J([["a", "X"]]) && p.jOk && p.hashOk, "…then a TimeTravel clear's re-record: X, never the re-recorded value");
  }
  // Resume from here's copy (index.html: the rows copied to a new id), and an import (bundle.js keepBundle)
  {
    const { id, st } = await make();
    await close(st);
    const rows = await histRows(hdb, id), copy = newId(), imported = newId();
    for (const row of rows) await rawPut(hdb, "history", { nb: copy, time: row.time, env: row.env });
    await B.keepBundle({ history: rows.map((r) => r.env), blobs: {} }, imported, { hdb });
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    await close(r.st);
    const jc = await jState(hdb, copy), ji = await jState(hdb, imported);
    check(r.row === "rewritten" && p.codes === J([["a", "X"]]) && jc.intents.length === 0 && ji.intents.length === 0 && jc.J === 0 && ji.J === 0, "…a Resume copy and an import of its rows: X stays, and neither copy has an intent or a j");
  }
  await close(w);
  hdb.close();
}

async function catchUpInterleaved() {
  // the catch-up's committed j is the record's, whatever else was appended meanwhile (both reviewers)
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  const d2 = await outputsOnly(st, d);
  await st.save({ ...d2, cells: [{ id: "a", code: "C" }], baseRev: d.rev });
  await close(st);
  // (another history of the same notebook, open first, appends an execution-journal version while the catch-up waits)
  // (simulated: under the one-writer lock no other tab appends; a store let past it stands for an append interleaved)
  const other = store(w, hdb, id);
  await other.open();
  other.patches.writerOK = () => true;
  W.JOURNAL_TX_HOOK.beforeTx = async () => {
    W.JOURNAL_TX_HOOK.beforeTx = undefined;
    other.history.journal([{ type: "run", id: "s:9", sid: "s", n: 9, t: 9 }]);
    await other.patches.appending;
  };
  const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
  W.JOURNAL_TX_HOOK.beforeTx = undefined;
  await close(r.st);
  await close(other);
  const r2 = await reopen(w, hdb, id);
  await close(r2.st);
  check(r.row === "stamped" && r.catchUp !== null && p.codes === J([["a", "A"]]) && p.jOk && r2.row === "consistent", "a version appended while the catch-up waited: the record takes the catch-up's committed j, and reopens consistent: " + J({ catchUp: r.catchUp, j: p.rec.j, J: p.js.J }));
  await close(w);
  hdb.close();
}

async function oldCodeWrite() {
  // a page from before the journal saved (its record's j and hash stale): the record's own value, stamped
  const { w, hdb } = await active();
  const { id, st } = await loadNew(w, hdb, [["a", "1"]]);
  await close(st);
  const rec0 = await rawGet(w.main, "notebooks", id);
  await rawPut(w.main, "notebooks", { ...rec0, cells: [{ id: "a", code: "an old page's save" }], rev: rec0.rev + 1 });
  const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
  await close(r.st);
  check(r.row === "stamped" && p.codes === J([["a", "an old page's save"]]) && p.hashOk && p.jOk && p.rec.hash !== rec0.hash, "an old page's save (stale j and hash): its value stamped, with its own hash: " + r.row);
  await close(w);
  hdb.close();
}

async function budgetsAndDrop() {
  const { w, hdb } = await active();
  const before = J(await syncRows(hdb)), keep = N.JOURNAL_BUDGETS.metaAll;
  N.JOURNAL_BUDGETS.metaAll = (await recount(hdb)).counted.meta + 10;
  const id = newId(), st = store(w, hdb, id, doc([["a", "1"]]));
  const why = await st.load().then(() => null, (e) => e?.message ?? String(e));
  const rec1 = await rawGet(w.main, "notebooks", id);
  check(why === null && J(await syncRows(hdb)) === before && rec1?.unjournaled === true && rec1.j === 0 && (await histRows(hdb, id)).length === 0, "the metadata budget full: a new notebook's first save written all the same, marked, nothing in the journal or history: " + J({ why, mark: rec1?.unjournaled }));
  await close(st);
  // (reopened with the budget still full: its catch-up refused, it stays as it is, marked)
  const r0 = await reopen(w, hdb, id);
  N.JOURNAL_BUDGETS.metaAll = keep;
  const rec2 = await rawGet(w.main, "notebooks", id);
  check(r0.row === "consistent" && rec2.rev === rec1.rev && J(await syncRows(hdb)) === before, "…reopened, still no room: consistent, still marked, nothing written: " + J({ row: r0.row, rev: [rec1.rev, rec2.rev], mark: rec2.unjournaled, j: rec2.j, sync: J(await syncRows(hdb)) === before }));
  await close(r0.st);
  // a dropped notebook's journal rows go with it (its intents too), their charges released
  const { id: id2, st: st2, d: d2 } = await loadNew(w, hdb, [["a", "1"]]);
  await st2.save({ ...d2, cells: [{ id: "a", code: "stale" }], baseRev: d2.rev - 1 });
  const c0 = await recount(hdb), reg = (await syncRows(hdb)).find((r) => r.time === "d:local:" + id2), pend0 = (await jState(hdb, id2)).intents.length;
  await st2.patches.drop();
  const c1 = await recount(hdb), left = (await syncRows(hdb)).filter((r) => r.nb === R.SYNC_NB + reg.v.h || r.time === "d:local:" + id2);
  check(reg && pend0 === 1 && left.length === 0 && (await histRows(hdb, id2)).length === 0 && c1.counted.meta === c0.counted.meta - reg.v.meta && c1.meta === c1.counted.meta && c1.pend === c1.counted.pend && c1.counted.pend < c0.counted.pend, "a drop deletes the document's journal rows and intents with its versions, releasing their charges");
  // the workspace's dropContents (emptying Trash) the same
  const { id: id4, st: st4 } = await loadNew(w, hdb, [["a", "1"]]);
  await close(st4);
  const c2 = await recount(hdb), reg4 = (await syncRows(hdb)).find((r) => r.time === "d:local:" + id4);
  await w.dropContents([{ kind: "notebook", ref: id4 }]);
  const c3 = await recount(hdb), left4 = (await syncRows(hdb)).filter((r) => r.nb === R.SYNC_NB + reg4.v.h || r.time === "d:local:" + id4);
  check(reg4 && left4.length === 0 && (await histRows(hdb, id4)).length === 0 && (await rawGet(w.main, "notebooks", id4)) === undefined && c3.counted.meta === c2.counted.meta - reg4.v.meta && c3.meta === c3.counted.meta, "the workspace's dropContents deletes a notebook's journal rows too, releasing their charge");
  // a clear keeps the journal's j: the next save is at a later j
  const { id: id3, st: st3, d: d3 } = await loadNew(w, hdb, [["a", "1"]]);
  await st3.history.clear();
  await st3.save({ ...d3, cells: [{ id: "a", code: "after clear" }], baseRev: d3.rev });
  const rec = await rawGet(w.main, "notebooks", id3);
  check(rec.j === 2 && (await jState(hdb, id3)).J === 2, "a TimeTravel clear keeps jseq: the next save at j 2");
  await close(st2, st3, w);
  hdb.close();
}

async function backlogFull() {
  // the bounded backlog full (entries, then bytes): a journal save neither hangs nor loses T1/T2's agreement
  // (daybreak3's LIMIT-208-DAYBREAK3-1): its patch refused at once, its intent written alone
  const { w, hdb } = await active();
  for (const which of ["entries", "bytes"]) {
    const { id, st, d } = await loadNew(w, hdb, [["a", "1"]]);
    const keep = W.HISTORY_BACKLOG[which];
    W.HISTORY_BACKLOG[which] = which === "entries" ? 0 : 1;
    const r = await within(st.save({ ...d, cells: [{ id: "a", code: "while full" }], baseRev: d.rev }), 3000);
    W.HISTORY_BACKLOG[which] = keep;
    const p = await persisted(w, hdb, id);
    check(r !== "timeout" && r.v?.saved && p.jOk && p.codes === J([["a", "while full"]]) && p.intents === 0 && p.hashOk, `the backlog's ${which} full: the save settles at once (${r === "timeout" ? "timeout" : J(r.v ?? r.e?.message)}), its intent alone, record and journal at the same j`);
    await close(st);
  }
  await close(w);
  hdb.close();
}

async function fencedWrites() {
  // a journal write under the workspace's lock, the fence read in its own transaction (daybreak3's
  // CORR-208-DAYBREAK3-2): the fence changed after the workspace's word refuses it, and nothing changes
  const { w, hdb } = await active();
  const was = await fenceRow(hdb);
  const moveFence = () => { W.JOURNAL_TX_HOOK.beforeTx = async () => { W.JOURNAL_TX_HOOK.beforeTx = undefined; await rawPut(hdb, "history", { ...was, fence: { ...was.fence, generation: was.fence.generation + 1 } }); }; };
  for (const paused of [true, false]) {
    const { id, st, d } = await loadNew(w, hdb, [["a", "1"]]);
    if (paused) await pause(st);
    const before = J(await syncRows(hdb)), rec0 = await rawGet(w.main, "notebooks", id), rows0 = J(await histRows(hdb, id));
    moveFence();
    const out = await within(st.save({ ...d, cells: [{ id: "a", code: "after the fence moved" }], baseRev: d.rev }), 5000);
    W.JOURNAL_TX_HOOK.beforeTx = undefined;
    await rawPut(hdb, "history", was);
    check(out !== "timeout" && typeof out.v === "string" && /reset in another tab/.test(out.v) && J(await syncRows(hdb)) === before && J(await rawGet(w.main, "notebooks", id)) === J(rec0) && J(await histRows(hdb, id)) === rows0, `${paused ? "a paused save's intent" : "a save's version and intent"} whose fence changed after the workspace's word: refused in its transaction, nothing written: ${J(out.v ?? out)}`);
    await close(st);
  }
  await close(w);
  hdb.close();
}

async function dropRefused() {
  // a drop whose journal rows can't be dropped (daybreak3's CORR-208-DAYBREAK3-3): it ends at once, refused, and
  // nothing of it is done
  const { w, hdb } = await active();
  const { id, st } = await loadNew(w, hdb, [["a", "1"]]);
  await close(st);
  const rows = J(await histRows(hdb, id)), sync = J(await syncRows(hdb));
  const bad = new W.IdbPatchStore(hdb, id, { journal: { t1: () => Promise.resolve({ refused: "no" }), drop: () => Promise.reject(new Error("the test's refusal")) } });
  const r = await within(bad.drop(), 3000);
  check(r !== "timeout" && r.e && /couldn't be dropped/.test(r.e.message) && J(await histRows(hdb, id)) === rows && J(await syncRows(hdb)) === sync, "a drop whose journal rows can't be dropped: refused at once (" + (r === "timeout" ? "timeout" : r.e?.message) + "), its versions and journal rows untouched");
  await close(w);
  hdb.close();
}


async function pruneAndConcurrency() {
  const { w, hdb } = await active();
  // a save's prune takes only what its T2 settles: a later save's intent, its T2 not yet run, stays and is recovered
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const x = await t1Only(st, { ...d, cells: [{ id: "a", code: "X" }], baseRev: d.rev });
    const y = await t1Only(st, { ...d, cells: [{ id: "a", code: "Y" }], baseRev: d.rev + 1 });
    const xDoc = { ...d, cells: [{ id: "a", code: "X" }] };
    await W.IdbStore.prototype.save.call(st, { ...xDoc, baseRev: d.rev }, { journal: { j: x.j, hash: await N.docHash(xDoc) } });
    await N.prune(st.patches, x.j);
    const left = (await jState(hdb, id)).intents.map((it) => it.j);
    await close(st);
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    await close(r.st);
    check(J(left) === J([y.j]) && r.row === "rewritten" && p.codes === J([["a", "Y"]]) && p.intents === 0, "a save's prune takes only intents at or below its j: the next save's intent stays, and, its T2 interrupted, is recovered: " + J({ left, row: r.row, codes: p.codes }));
  }
  // an intent at or below the record's j (a prune that hadn't run) never decides, whatever its srev
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const k = await N.writeIntent(st.patches, { srev: d.rev + 1, value: st.textOf({ ...d, cells: [{ id: "a", code: "never" }] }) });
    const dd = { ...d, cells: [{ id: "a", code: "A" }] };
    await W.IdbStore.prototype.save.call(st, { ...dd, baseRev: d.rev }, { journal: { j: k.j, hash: await N.docHash(dd) } });
    await close(st);
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    await close(r.st);
    check(r.row === "consistent" && p.codes === J([["a", "A"]]), "an intent at or below the record's j, its srev the record's revision, decides nothing: " + J({ row: r.row, codes: p.codes }));
  }
  // recovery's T2 is conditional on the record's revision: a save that lands while it runs wins, and recovery replays
  // again from it
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const d2 = await outputsOnly(st, d);
    await st.save({ ...d2, cells: [{ id: "a", code: "C" }], baseRev: d.rev });
    await close(st);
    // (a write that lands while recovery runs: under the lock, only an old page's (a plain record write) can)
    W.JOURNAL_TX_HOOK.beforeTx = async () => {
      W.JOURNAL_TX_HOOK.beforeTx = undefined;
      const cur = await rawGet(w.main, "notebooks", id);
      await rawPut(w.main, "notebooks", { ...cur, cells: [{ id: "a", code: "D, saved meanwhile", outputs: [{ text: "o" }] }], rev: cur.rev + 1 });
    };
    const other = null;
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    W.JOURNAL_TX_HOOK.beforeTx = undefined;
    await close(r.st, other);
    check(p.codes === J([["a", "D, saved meanwhile"]]) && p.hashOk && p.jOk && codes(r.d) === p.codes, "a save that lands while recovery runs wins (recovery's T2 conditional on the revision it read), and recovery replays from it: " + J({ row: r.row, codes: p.codes }));
  }
  await close(w);
  hdb.close();
}


// (a promise that resolves on the store's takeover, or "timeout")
const takeover = (st, ms = 3000) => within(new Promise((ok) => { st.onTakeover(ok); }), ms);

async function oneWriter() {
  // for the milestone, one writer per notebook per device (William, Oct 27): a second store of it is read-only, says
  // why, writes nothing (no save, no version, no recovery), and takes over when the writer lets go
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  // (the writer's save interrupted before T2: a recovery for whoever writes next)
  await t1Only(st, { ...d, cells: [{ id: "a", code: "B" }], baseRev: d.rev });
  const before = J(await syncRows(hdb)), rec0 = J(await rawGet(w.main, "notebooks", id)), rows0 = J(await histRows(hdb, id));
  const v = store(w, hdb, id), dv = await v.load();
  const said = await v.save({ ...dv, cells: [{ id: "a", code: "from the viewer" }], baseRev: dv.rev });
  v.history.journal([{ type: "run", id: "s:1", sid: "s", n: 1, t: 1 }]);
  await v.patches.appending;
  check(st.writer && !v.writer && v.viewOnly === N.READ_ONLY.other && v.recovered.row === "read-only" && said === "not saved: this notebook is open for editing in another tab of this browser" && J(await syncRows(hdb)) === before && J(await rawGet(w.main, "notebooks", id)) === rec0 && J(await histRows(hdb, id)) === rows0, "a second store of a notebook: read-only, its bar's text, and nothing written (no recovery, no save, no version): " + J({ row: v.recovered.row, said }));
  // the writer lets go: the viewer takes over, loads as the writer, recovers, and saves
  const t = takeover(v);
  await close(st);
  const tk = await t;
  const d2 = tk !== "timeout" ? await v.load() : null, p = await persisted(w, hdb, id);
  const out = d2 ? await v.save({ ...d2, cells: [{ id: "a", code: "the new writer's" }], baseRev: d2.rev }) : null;
  check(tk !== "timeout" && v.writer && v.recovered.row === "rewritten" && p.codes === J([["a", "B"]]) && !!out?.saved, "…the writer lets go: the viewer takes over, recovers the interrupted save (B) first, then saves: " + J({ row: v.recovered.row, saved: !!out?.saved }));
  await close(v, w);
  hdb.close();
}

async function takeoverRace() {
  // two tabs waiting for the lock: exactly one takes over (the first in the lock's queue), the other stays read-only
  const { w, hdb } = await active();
  const { id, st } = await loadNew(w, hdb, [["a", "A"]]);
  const v1 = store(w, hdb, id), v2 = store(w, hdb, id);
  await v1.load(); await v2.load();
  const t1 = takeover(v1, 2000), t2 = takeover(v2, 600);
  await close(st);
  const [r1, r2] = await Promise.all([t1, t2]);
  check(r1 !== "timeout" && r2 === "timeout" && v1.writer && !v2.writer && v2.viewOnly === N.READ_ONLY.other, "two read-only stores waiting: the first in the lock's queue takes over, the other stays read-only");
  const t3 = takeover(v2, 2000);
  await close(v1);
  check((await t3) !== "timeout" && v2.writer, "…and when that one lets go, the other takes over in turn");
  await close(v2, w);
  hdb.close();
}

async function killedHolder() {
  // a tab killed while it holds the lock: the browser frees it, and the next store takes over and recovers.  (The
  // holder here is a frame holding the lock, removed as a tab is closed or crashes)
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  await t1Only(st, { ...d, cells: [{ id: "a", code: "B" }], baseRev: d.rev });
  await close(st);
  const frame = document.createElement("iframe");
  const held = new Promise((ok) => { window.addEventListener("message", function f(e) { if (e.data === "held") { window.removeEventListener("message", f); ok(); } }); });
  frame.srcdoc = `<script>navigator.locks.request(${J(N.writerLockName(id))}, () => { parent.postMessage("held", "*"); return new Promise(() => {}); });<\/script>`;
  document.body.appendChild(frame);
  await within(held, 3000);
  const v = store(w, hdb, id);
  await v.load();
  const ro = !v.writer && v.recovered.row === "read-only";
  const t = takeover(v);
  frame.remove();
  const tk = await t;
  if (tk !== "timeout") await v.load();
  const p = await persisted(w, hdb, id);
  check(ro && tk !== "timeout" && v.writer && v.recovered.row === "rewritten" && p.codes === J([["a", "B"]]), "the lock's holder killed: freed by the browser; the waiting store takes over and recovers (B): " + J({ ro, row: v.recovered.row }));
  await close(v, w);
  hdb.close();
}

async function noWebLocks() {
  // without the Web Locks API: read-only, said, nothing written (fail closed)
  const { w, hdb } = await active();
  const { id, st } = await loadNew(w, hdb, [["a", "A"]]);
  await close(st);
  const before = J(await syncRows(hdb)), rec0 = J(await rawGet(w.main, "notebooks", id));
  Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
  let v, said;
  try {
    v = store(w, hdb, id);
    const dv = await v.load();
    said = await v.save({ ...dv, cells: [{ id: "a", code: "no locks" }], baseRev: dv.rev });
  } finally {
    delete navigator.locks;
  }
  check(!v.writer && v.viewOnly === N.READ_ONLY.nolocks && typeof said === "string" && J(await syncRows(hdb)) === before && J(await rawGet(w.main, "notebooks", id)) === rec0 && typeof navigator.locks?.request === "function", "no Web Locks: read-only, its own text, nothing written");
  await close(v, w);
  hdb.close();
}


async function lockOrderings() {
  // astra's three orderings, with real Web Locks and IndexedDB
  const { w, hdb } = await active();
  // CORR-215-1: the same store reattached at a takeover (the page's switchJournal) keeps its lock and saves
  {
    const { id, st } = await loadNew(w, hdb, [["a", "A"]]);
    const v = store(w, hdb, id);
    await v.load();
    const t = takeover(v);
    await close(st);
    await t;
    const d = await v.load();
    // (the page's startHistory after open(): the same store, kept; then a save, with no load in between)
    const kept = N.switchJournal(v, v);
    const out = await v.save({ ...d, cells: [{ id: "a", code: "after the reattach" }], baseRev: d.rev });
    const other = store(w, hdb, newId());
    const next = N.switchJournal(v, other);
    const freed = await within(v.lockDone ?? Promise.resolve(), 2000);
    check(kept === v && v.writer === false && freed !== "timeout" && next === other && !!out?.saved, "CORR-215-1: the same store reattached keeps its lock and saves; switching to another store lets it go: " + J({ saved: !!out?.saved }));
    await close(other);
  }
  // CORR-215-2: a release before the initial grant: the grant isn't kept, the release settles, the next store writes
  {
    const { id, st } = await loadNew(w, hdb, [["a", "A"]]);
    await close(st);
    const a = store(w, hdb, id), loading = a.load();
    const rel = a.release();
    await loading.catch(() => {});
    const r = await within(rel, 2000), held = a.writer;
    const b = store(w, hdb, id);
    await b.load();
    check(r !== "timeout" && !held && b.writer && b.viewOnly === null, "CORR-215-2: a release before the initial grant: the grant isn't kept, the release settles, the next store is the writer: " + J({ r: r === "timeout" ? r : "ok", held, next: b.writer }));
    await close(a, b);
  }
  // CORR-215-3: the grant arrives while the read-only load is still reading: it loads as the writer, recovering first
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    await t1Only(st, { ...d, cells: [{ id: "a", code: "B" }], baseRev: d.rev });
    const v = store(w, hdb, id), init = v.history.init.bind(v.history);
    let paused = false;
    v.history.init = async () => { if (!paused) { paused = true; await close(st); await sleep(100); } return init(); };
    let told = 0;
    await v.load();
    v.onTakeover(() => { told++; });
    await sleep(50);
    const p = await persisted(w, hdb, id), out = await v.save({ ...(await rawGet(w.main, "notebooks", id)), cells: [{ id: "a", code: "B2" }], baseRev: p.rec.rev });
    check(v.writer && v.viewOnly === null && v.recovered.row === "rewritten" && p.codes === J([["a", "B"]]) && told === 0 && !!out?.saved, "CORR-215-3: granted during the read-only load: loaded as the writer, the interrupted save (B) recovered first, nothing left to tell: " + J({ row: v.recovered.row, told }));
    await close(v);
  }
  // …and granted after the read-only load, before the page asks: told at once when it does (latched)
  {
    const { id, st } = await loadNew(w, hdb, [["a", "A"]]);
    const v = store(w, hdb, id);
    await v.load();
    await close(st);
    await sleep(100);
    const t = takeover(v, 1000);
    check((await t) !== "timeout" && v.writer && v.viewOnly !== null, "a grant before the page asks to be told: told at once (latched), still read-only until its reload");
    await close(v);
  }
  close(w);
  hdb.close();
}

async function takeoverRefusesTheViewersState() {
  // board's B: at a takeover, before its reload, the read-only tab's own state (flushed as the page reattaches) is
  // refused: nothing of it is written; after the reload, the writer saves
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  const v = store(w, hdb, id), dv = await v.load();
  const t = takeover(v);
  await close(st);
  await t;
  const rec0 = J(await rawGet(w.main, "notebooks", id)), sync0 = J(await syncRows(hdb));
  const flushed = await v.save({ ...dv, cells: [{ id: "a", code: "A", outputs: [{ text: "the viewer's run" }] }], name: "renamed in the viewer", baseRev: dv.rev });
  check(flushed === "not saved: this notebook is open for editing in another tab of this browser" && J(await rawGet(w.main, "notebooks", id)) === rec0 && J(await syncRows(hdb)) === sync0, "a save between the grant and the reload (the page's flush at detach): refused, nothing written");
  const d2 = await v.load();
  const out = await v.save({ ...d2, cells: [{ id: "a", code: "the new writer's" }], baseRev: d2.rev });
  check(!!out?.saved && (await rawGet(w.main, "notebooks", id)).name !== "renamed in the viewer", "…after the reload, the writer saves its own");
  await close(v, w);
  hdb.close();
}

async function controls() {
  // board's 1: what the page allows for a store: everything for the writer and a plain store; for a read-only one, no
  // name (no workspace rename), no language, no reproducibility, no rename, no Trash
  const { w, hdb } = await active();
  const { id, st } = await loadNew(w, hdb, [["a", "A"]]);
  const v = store(w, hdb, id);
  await v.load();
  const cw = N.pageControls(st), cv = N.pageControls(v), cp = N.pageControls(new W.IdbStore(w.main, newId()));
  const all = (c) => c.name && c.mode && c.repro && c.rename && c.trash && c.history && !c.readOnly && c.bar === null;
  const none = (c) => !c.name && !c.mode && !c.repro && !c.rename && !c.trash && !c.history && c.readOnly && c.bar === N.READ_ONLY.other;
  check(all(cw) && all(cp) && none(cv) && typeof N.TAKEOVER === "string" && N.TAKEOVER.length > 0, "the page's controls: all for the writer and a plain store; none (and the bar) for a read-only store");
  await close(st, v, w);
  hdb.close();
}


// (B: notebooks' kind (web/journal/store.js): the store's law, withValue(rec, toRecords(rec)) is rec but for the store's
// own fields (rev, j, hash, unjournaled, and baseRev on the way in), for a record of each cell type, outputs,
// attachments and fields of its own;
// its hash is docHash, its lock the writer lock's name, its texts the notebook's, a new notebook as before)
async function kindLaw() {
  const K = N.notebookKind(H), own = ["rev", "j", "hash", "unjournaled", "baseRev"];
  const canon = (v) => J(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((y) => [y, x[y]])) : x));
  const strip = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => !own.includes(k)));
  const recs = [
    { id: "x", name: "t", mode: "python", cells: [] },
    { id: "x", name: "t", mode: "sage", rev: 3, j: 7, hash: "h", unjournaled: true, baseRev: 2, cells: [{ id: "a", code: "1+1", outputs: [{ text: "2" }], collapsed: true }, { id: "b", type: "markdown", code: "# h", attachments: { "p.png": "AA==" } }, { id: "c", type: "raw", code: "r" }] },
    { id: "x", name: "t", mode: "magma", repro: { k: 1 }, cells: [{ id: "a", code: "" }, { id: "b", type: "markdown", code: "no attachments" }] },
  ];
  for (const [i, rec] of recs.entries()) {
    const got = K.withValue(rec, K.toRecords(rec));
    check(canon(strip(got)) === canon(strip(rec)), `notebooks' kind keeps the law for record ${i}: ` + canon(strip(got)).slice(0, 300));
    check((await N.hashOf(K, rec)) === (await N.docHash(rec)), `notebooks' kind hashes record ${i} as docHash`);
  }
  check(K.lockPrefix + "x" === N.writerLockName("x") && K.sync === N.DOC_SYNC && K.noun === "notebook" && K.kind === "notebooks", "notebooks' kind: the writer lock's name, the switch, the noun");
  check(canon(K.empty("i", null)) === canon({ name: "Untitled", mode: "python", cells: [], id: "i" }) && canon(K.empty("i", { name: "n", mode: "sage", cells: [] })) === canon({ name: "n", mode: "sage", cells: [], id: "i" }), "notebooks' kind: a new notebook as before");
  // (a store's texts are its kind's: a read-only store says the notebook's)
  const { w, hdb } = await active();
  const { id, st } = await loadNew(w, hdb, [["a", "A"]]);
  const v = store(w, hdb, id);
  await v.load();
  check(st.kind.noun === "notebook" && v.viewOnly === N.READ_ONLY.other && (await v.save(doc([["a", "B"]]))) === st.T.NOT_WRITER, "a store's texts are its kind's");
  await close(st, v, w);
  hdb.close();
}

// (the notebook page's own functions, as index.html has them, run with what they use given to them: startHistory and
// takeOver (astra's CORR-215-4, board's C))
async function pageFunctions(deps) {
  const src = await (await fetch("./page-src.html")).text();
  const a = src.indexOf("let nbJournal = null, nbHistoryOff = null;"), b = src.indexOf('nb.on("change"', a);
  const t0 = src.indexOf("async function takeOver(store, id) {"), t1 = src.indexOf("\n}\n", t0) + 3;
  if (a < 0 || b < 0 || t0 < 0) throw new Error("the page's journal functions weren't found");
  const make = new Function("deps", `with (deps) {\n${src.slice(a, b)}\n${src.slice(t0, t1)}\nreturn { startHistory, takeOver };\n}`);
  return make(deps);
}
const pageHelpers = () => ({ pageControls: N.pageControls, switchJournal: N.switchJournal, TAKEOVER: N.TAKEOVER, TAKEOVER_FAILED: N.TAKEOVER_FAILED });

async function pageStartHistory() {
  // CORR-215-4: the page's startHistory, run as it is: for a plain store (before activation), and for a journal's store
  // reattached (the takeover's reload): no error, and the writer keeps its lock and saves
  const { w, hdb } = await active();
  const plain = new W.IdbStore(w.main, newId());
  const deps = { nb: { store: plain, snapshot: () => ({ cells: [] }) }, nbHistory: null, historyQueue: [], journalPage: pageHelpers(), kernels: new Map(), ttEl: { hidden: true }, ttRefresh() {}, historyDbReady: Promise.resolve(null), ttUnavailable: "", current: { id: "x" } };
  const f = await pageFunctions(deps);
  const r1 = await f.startHistory("x").then(() => "ok", (e) => String(e));
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  deps.nb.store = st;
  const r2 = await f.startHistory(id).then(() => "ok", (e) => String(e));
  const r3 = await f.startHistory(id).then(() => "ok", (e) => String(e));
  const out = await st.save({ ...d, cells: [{ id: "a", code: "after two starts" }], baseRev: d.rev });
  check(r1 === "ok" && r2 === "ok" && r3 === "ok" && st.writer && !!out?.saved && deps.nbHistory === st.history, "the page's startHistory, run as it is: a plain store, then a journal's store reattached: no error, the writer keeps its lock and saves: " + J({ r1, r2, r3, saved: !!out?.saved }));
  await close(st, w);
  hdb.close();
}

async function viewerHistoryWrites() {
  // daybreak3: a read-only store's TimeTravel can't be cleared or dropped (the storage refuses, whatever the page does);
  // the writer's can
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  await st.save({ ...d, cells: [{ id: "a", code: "v2" }], baseRev: d.rev });
  const v = store(w, hdb, id);
  await v.load();
  const rows0 = J(await histRows(hdb, id)), sync0 = J(await syncRows(hdb));
  const c = await v.history.clear().then(() => "cleared", (e) => e.message);
  const dr = await v.patches.drop().then(() => "dropped", (e) => e.message);
  check(/open for editing in another tab/.test(c) && /open for editing in another tab/.test(dr) && J(await histRows(hdb, id)) === rows0 && J(await syncRows(hdb)) === sync0, "a read-only store's TimeTravel clear and drop: refused, its versions and journal rows byte for byte as they were: " + J({ c, dr }));
  await st.history.clear();
  check((await histRows(hdb, id)).length === 0, "…the writer's clear still clears");
  await close(st, v, w);
  hdb.close();
}

async function takeoverFails() {
  // board's C: a takeover whose reopen fails lets the lock go (said), so another tab can take it
  const { w, hdb } = await active();
  const { id, st } = await loadNew(w, hdb, [["a", "A"]]);
  const v = store(w, hdb, id), x = store(w, hdb, id);
  await v.load(); await x.load();
  const bar = { hidden: true, textContent: "" };
  const deps = { current: { id }, nb: { store: v }, anchorOf: () => null, restoreAnchor() {}, document, open: async () => { throw new Error("the test's failed reopen"); }, writerBar: bar, writerBarHeight() {}, writerBarTimer: null, journalPage: pageHelpers(), statusEl: { textContent: "" } };
  const f = await pageFunctions({ ...deps, nbHistory: null, historyQueue: [], kernels: new Map(), ttEl: { hidden: true }, ttRefresh() {}, historyDbReady: Promise.resolve(null), ttUnavailable: "" });
  const tookOver = new Promise((ok) => v.onTakeover(() => f.takeOver(v, id).then(ok, ok)));
  const xt = takeover(x, 3000);
  await close(st);
  await within(tookOver, 3000);
  const r = await xt;
  check(bar.textContent === N.TAKEOVER_FAILED && !bar.hidden && !v.writer && r !== "timeout" && x.writer, "a takeover whose reopen fails: the lock let go and said; the next waiting store takes over: " + J({ bar: bar.textContent.slice(0, 30), x: x.writer }));
  await close(v, x, w);
  hdb.close();
}


async function takeoverFailsInRecovery() {
  // astra's CORR-215-5: a reload that fails during recovery leaves the store writing nothing (no save, no version) at
  // once, before any release; and the page's takeOver then lets the lock go to the next tab
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  const v = store(w, hdb, id), x = store(w, hdb, id);
  await v.load(); await x.load();
  const grant = takeover(v, 3000);
  await close(st);
  await grant;
  v.recover = async () => { throw new Error("the test's failed recovery"); };
  const failed = await v.load().then(() => null, (e) => e.message);
  const said = await v.save({ ...d, cells: [{ id: "a", code: "after a failed reload" }], baseRev: d.rev });
  const rec = await rawGet(w.main, "notebooks", id);
  check(failed && v.writer && !v.ready && v.viewOnly !== null && said === "not saved: this notebook is open for editing in another tab of this browser" && rec.cells[0].code === "A", "a reload that fails during recovery: it writes nothing more, at once: " + J({ failed, said }));
  const bar = { hidden: true, textContent: "" };
  const f = await pageFunctions({ current: { id }, nb: { store: v }, anchorOf: () => null, restoreAnchor() {}, document, open: async () => { await v.load(); }, writerBar: bar, writerBarHeight() {}, writerBarTimer: null, journalPage: pageHelpers(), statusEl: { textContent: "" }, nbHistory: null, historyQueue: [], kernels: new Map(), ttEl: { hidden: true }, ttRefresh() {}, historyDbReady: Promise.resolve(null), ttUnavailable: "" });
  const xt = takeover(x, 3000);
  await f.takeOver(v, id);
  const r = await xt;
  check(bar.textContent === N.TAKEOVER_FAILED && !v.writer && r !== "timeout" && x.writer, "…the page's takeOver then lets the lock go, said; the next waiting store takes over");
  await close(v, x, w);
  hdb.close();
}


async function releaseWaitsForLoad() {
  // astra's CORR-215-5: a release while the load's recovery is still writing lets go only once those writes are done
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  await t1Only(st, { ...d, cells: [{ id: "a", code: "B" }], baseRev: d.rev });
  await close(st);
  const v = store(w, hdb, id), recover = v.recover.bind(v);
  v.recover = async (rec) => { await sleep(300); return recover(rec); };
  let done = false;
  const loading = v.load().finally(() => { done = true; });
  await sleep(80);
  await v.release();
  const settled = done;
  await loading.catch(() => {});
  const p = await persisted(w, hdb, id);
  check(settled && p.codes === J([["a", "B"]]), "a release during the load's recovery lets go only after its writes (the recovered B committed first): " + J({ settled }));
  close(w);
  hdb.close();
}


async function lifetimeP1P2() {
  const { w, hdb } = await active();
  // daybreak3's P2: while a load's recovery is pending, an ordinary save, a TimeTravel clear and a drop are refused, and
  // a recovery that then fails leaves the notebook, its versions and its journal rows byte for byte as they were
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    await t1Only(st, { ...d, cells: [{ id: "a", code: "B" }], baseRev: d.rev });
    await close(st);
    const v = store(w, hdb, id);
    let open; const gate = new Promise((r) => { open = r; });
    v.recover = async () => { await gate; throw new Error("the test's failed recovery"); };
    const rec0 = J(await rawGet(w.main, "notebooks", id)), rows0 = J(await histRows(hdb, id)), sync0 = J(await syncRows(hdb));
    const loading = v.load().then(() => "loaded", (e) => e.message);
    await sleep(100);
    const said = await v.save({ ...d, cells: [{ id: "a", code: "during recovery" }], baseRev: d.rev });
    const c = await v.history.clear().then(() => "cleared", (e) => e.message);
    const dr = await v.patches.drop().then(() => "dropped", (e) => e.message);
    open();
    const l = await loading;
    check(/failed recovery/.test(l) && said === "not saved: this notebook is open for editing in another tab of this browser" && /open for editing/.test(c) && /open for editing/.test(dr) && J(await rawGet(w.main, "notebooks", id)) === rec0 && J(await histRows(hdb, id)) === rows0 && J(await syncRows(hdb)) === sync0, "P2: during a pending recovery a save, a clear and a drop are refused; the recovery then fails: the notebook, its versions and journal rows byte for byte unchanged: " + J({ said: said.slice(0, 20), c: c.slice(0, 20), dr: dr.slice(0, 20) }));
    await close(v);
  }
  // astra's P1: one drain for every unlock: a save of the load's own (a new notebook's first) finishing while the store
  // is released and its load is still pending doesn't let the lock go; the next store gets it only after the load
  {
    const id = newId(), v = store(w, hdb, id, doc([["a", "first"]])), recover = v.recover.bind(v);
    let open; const gate = new Promise((r) => { open = r; });
    v.recover = async (rec) => { const out = await recover(rec); await gate; return out; };
    // (the load's own save held in its last journal write (its prune), so the release comes while it runs)
    let calls = 0, openSave, inSave; const saveGate = new Promise((r) => { openSave = r; }), reached = new Promise((r) => { inSave = r; });
    W.JOURNAL_TX_HOOK.beforeTx = async () => { if (++calls === 2) { W.JOURNAL_TX_HOOK.beforeTx = undefined; inSave(); await saveGate; } };
    const loading = v.load();
    await within(reached, 3000);
    const x = store(w, hdb, id);
    await x.load();
    const xt = takeover(x, 4000);
    const released = v.release();
    openSave();
    await sleep(200);
    const early = x.writer;
    open();
    await loading.catch(() => {});
    await released;
    const r = await xt;
    check(v.inflight === 0 && !early && r !== "timeout" && x.writer, "P1: released while its load's own save runs and its load is pending: the save ends, and the lock is let go only once the load is done: " + J({ early, later: x.writer }));
    await close(x);
  }
  close(w);
  hdb.close();
}


async function clearCheckedAtItsTurn() {
  // daybreak3's P2: a TimeTravel clear asked for by the writer, queued, and the store released before its turn: refused at
  // its turn, nothing deleted
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  await st.save({ ...d, cells: [{ id: "a", code: "v2" }], baseRev: d.rev });
  const rows0 = J(await histRows(hdb, id));
  let open; const gate = new Promise((r) => { open = r; });
  W.JOURNAL_TX_HOOK.beforeTx = async () => { W.JOURNAL_TX_HOOK.beforeTx = undefined; await gate; };
  const rec = await rawGet(w.main, "notebooks", id);
  const saving = st.save({ ...rec, cells: [{ id: "a", code: "v3" }], baseRev: rec.rev });
  await sleep(50);
  const clearing = st.history.clear().then(() => "cleared", (e) => e.message);
  await sleep(20);
  const releasing = st.release();
  open();
  const [sv, c] = await Promise.all([saving, clearing]);
  await releasing;
  const after = new Set((await histRows(hdb, id)).map((r) => J([r.nb, r.time])));
  check(/open for editing/.test(c) && JSON.parse(rows0).every((r) => after.has(J([r.nb, r.time]))), "a clear queued by the writer, the store released before its turn: refused at its turn, no version deleted: " + J({ c: c.slice(0, 30), saved: typeof sv === "string" ? sv.slice(0, 20) : !!sv?.saved }));
  close(w);
  hdb.close();
}


async function reloadFails() {
  // astra's CORR-215-5: a writer already loaded that loads again: not ready while that recovery runs, and a recovery that
  // fails leaves it writing nothing more
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  let open; const gate = new Promise((r) => { open = r; });
  st.recover = async () => { await gate; throw new Error("the test's failed recovery"); };
  const loading = st.load().then(() => "loaded", (e) => e.message);
  await sleep(50);
  const during = await st.save({ ...d, cells: [{ id: "a", code: "during" }], baseRev: d.rev });
  open();
  const l = await loading;
  const after = await st.save({ ...d, cells: [{ id: "a", code: "after" }], baseRev: d.rev });
  const rec = await rawGet(w.main, "notebooks", id);
  check(/failed recovery/.test(l) && during === "not saved: this notebook is open for editing in another tab of this browser" && after === during && rec.cells[0].code === "A", "a loaded writer loading again: no save while its recovery runs, and none after it fails: " + J({ l, during: String(during).slice(0, 20), after: String(after).slice(0, 20) }));
  await close(st);
  close(w);
  hdb.close();
}


// (writes into the stores named refused as out of room while `f` runs: the history's put throws QuotaExceededError
// (in the journal's write, its transaction stopped); the notebooks' transaction is stopped at its put, as a full
// origin's is at its commit)
async function noRoom(names, f) {
  const put = IDBObjectStore.prototype.put, set = new Set([names].flat());
  IDBObjectStore.prototype.put = function (...a) {
    if (!set.has(this.name)) return put.apply(this, a);
    if (this.name === "notebooks") { this.transaction.abort(); return {}; }
    throw new DOMException("out of room (the test's)", "QuotaExceededError");
  };
  try { return await f(); } finally { IDBObjectStore.prototype.put = put; }
}
// (TimeTravel's bound for one version lowered while `f` runs, so a small value is one that can never be kept)
async function smallBound(f) {
  const keep = S.HISTORY_BACKLOG.bytes;
  S.HISTORY_BACKLOG.bytes = 8192;
  try { return await f(); } finally { S.HISTORY_BACKLOG.bytes = keep; }
}
const big = () => "x".repeat(6000);
const versions = async (hdb, id) => (await histRows(hdb, id)).length;

async function fallbackSaves() {
  // 2c-1d-iii §1, D1: a save whose T1 has no room is written by T2 all the same, its j kept, marked, said; saved only if
  // T2 commits
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  const rec0 = await rawGet(w.main, "notebooks", id), js0 = J(await jState(hdb, id)), v0 = await versions(hdb, id), sync0 = J(await syncRows(hdb));
  const out = await noRoom("history", () => st.save({ ...d, cells: [{ id: "a", code: "B" }], baseRev: rec0.rev }));
  const rec = await rawGet(w.main, "notebooks", id);
  check(out?.saved === N.SAVED_UNJOURNALED && out.unjournaled === true && rec.unjournaled === true && rec.j === rec0.j && rec.rev === rec0.rev + 1 && rec.hash === (await N.docHash(rec)) && codes(rec) === J([["a", "B"]]) && J(await jState(hdb, id)) === js0 && (await versions(hdb, id)) === v0 && J(await syncRows(hdb)) === sync0, "D1: T1 out of room (quota): the record written all the same, its j kept, marked, said; nothing in the history or the journal: " + J(out?.saved));
  // (T1 and T2 both out of room: not saved, said, the record byte for byte as it was)
  const before = J(await rawGet(w.main, "notebooks", id));
  const both = await within(noRoom(["history", "notebooks"], () => st.save({ ...d, cells: [{ id: "a", code: "C" }], baseRev: rec.rev })), 3000);
  check(both !== "timeout" && both.e && J(await rawGet(w.main, "notebooks", id)) === before && J(await jState(hdb, id)) === js0, "D1: T1 and T2 both out of room: not saved (said, never left waiting), the record byte for byte unchanged: " + J(both === "timeout" ? both : both.e?.name ?? both.v));
  // (a refusal that isn't for room (the fence's, the writer's) is the save's own: no fallback)
  check(N.roomRefused({ refused: "anything else" }) === false && N.roomRefused({ refused: "x", quota: true }) === true && N.roomRefused(null) === false, "only a refusal for room (the bound, a budget, the quota) falls back");
  await close(st);
  await close(w);
  hdb.close();
}

async function coalescedVersions() {
  // D2: fallback B, fallback C, then the catch-up (ingestion): exactly one new version, C's; none for B
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  const v0 = await versions(hdb, id);
  let rec = await rawGet(w.main, "notebooks", id);
  await noRoom("history", () => st.save({ ...d, cells: [{ id: "a", code: "B" }], baseRev: rec.rev }));
  rec = await rawGet(w.main, "notebooks", id);
  await noRoom("history", () => st.save({ ...d, cells: [{ id: "a", code: "C" }], baseRev: rec.rev }));
  await close(st);
  const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
  const rows = await histRows(hdb, id), last = rows.find((x) => x.j === p.rec.j);
  const head = last ? codes(r.st.history.docAt(last.time)) : null;
  check(r.row === "stamped" && p.codes === J([["a", "C"]]) && p.rec.unjournaled === undefined && rows.length === v0 + 1 && r.catchUp === p.rec.j && head === J([["a", "C"]]), "D2: fallback B, fallback C, then ingestion: exactly one new version, C's, none for B; unmarked: " + J({ row: r.row, added: rows.length - v0, head }));
  await close(r.st);
  await close(w);
  hdb.close();
}

async function markRule() {
  // A1 (§2): the mark is cleared only when a version holds the value written
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  let rec = await rawGet(w.main, "notebooks", id);
  await noRoom("history", () => st.save({ ...d, cells: [{ id: "a", code: "B" }], baseRev: rec.rev }));
  // (the history paused (as a refused version leaves it): a save's T1 is its intent alone, its value not the head)
  rec = await rawGet(w.main, "notebooks", id);
  const paused = await st.save({ ...d, cells: [{ id: "a", code: "C" }], baseRev: rec.rev });
  const recP = await rawGet(w.main, "notebooks", id);
  check(!!paused?.saved && paused.saved !== N.SAVED_UNJOURNALED && recP.unjournaled === true && recP.j > rec.j && codes(recP) === J([["a", "C"]]), "A1: after a fallback, an intent-only save (TimeTravel paused) is saved, journaled, and still marked: " + J({ mark: recP.unjournaled, paused: st.history.pauseState?.().paused }));
  await close(st);
  // (reopened: its catch-up a version holding C; then a save with its version, and one unchanged: unmarked)
  const r = await reopen(w, hdb, id);
  const recR = await rawGet(w.main, "notebooks", id);
  const s1 = await r.st.save({ ...r.d, cells: [{ id: "a", code: "D" }], baseRev: recR.rev });
  const rec1 = await rawGet(w.main, "notebooks", id);
  const s2 = await r.st.save({ ...r.d, cells: [{ id: "a", code: "D" }], baseRev: rec1.rev });
  const rec2 = await rawGet(w.main, "notebooks", id);
  check(recR.unjournaled === undefined && !!s1?.saved && rec1.unjournaled === undefined && !!s2?.saved && rec2.unjournaled === undefined && rec2.j > rec1.j, "A1: then a version holding the value clears it, and a save whose value is already the head's stays clear: " + J([recR.unjournaled, rec1.unjournaled, rec2.unjournaled]));
  await close(r.st);
  await close(w);
  hdb.close();
}

async function markTable() {
  // A2, A3 (§3's table): recovery with the mark, each row; "refused": the catch-up out of room
  const { w, hdb } = await active();
  // (a notebook whose record is A, marked `mark` (a fallback save; too large: under a small bound), then, unless
  // `intent` is null, a save B whose T2 never came: with its version, or its intent alone (paused))
  async function setUp({ a = "A", mark = true, intent = null }) {
    const { id, st, d } = await loadNew(w, hdb, [["a", "0"]]);
    let rec = await rawGet(w.main, "notebooks", id);
    if (mark === "too-large") await smallBound(() => noRoom("history", () => st.save({ ...d, cells: [{ id: "a", code: a }], baseRev: rec.rev })));
    else if (mark) await noRoom("history", () => st.save({ ...d, cells: [{ id: "a", code: a }], baseRev: rec.rev }));
    else await st.save({ ...d, cells: [{ id: "a", code: a }], baseRev: rec.rev });
    rec = await rawGet(w.main, "notebooks", id);
    await close(st);
    if (intent) {
      // (a store whose load leaves the record as it is (no recovery), so its history isn't paused by the fallback's
      // refusal; paused for an intent alone)
      const s2 = store(w, hdb, id);
      s2.recover = async (r) => ({ doc: r, row: "the test's" });
      await s2.load();
      if (intent !== "version") await pause(s2);
      // (a stale intent: its srev a revision the record already passed, so the replay never chooses it)
      await t1Only(s2, { ...d, cells: [{ id: "a", code: "B" }], baseRev: intent === "stale" ? rec.rev - 1 : rec.rev });
      await close(s2);
    }
    return { id, rec };
  }
  const rows = [
    { name: "A marked, none, kept", set: {}, want: { codes: "A", row: "stamped", mark: undefined, catchUp: true } },
    { name: "A marked, none, refused", set: {}, refused: true, want: { codes: "A", row: "consistent", mark: true, catchUp: false } },
    { name: "A marked, B with its version", set: { intent: "version" }, want: { codes: "B", row: "rewritten", mark: undefined, catchUp: false } },
    { name: "A marked, B intent only, kept", set: { intent: "paused" }, want: { codes: "B", row: "rewritten", mark: undefined, catchUp: true } },
    { name: "A marked, B intent only, refused", set: { intent: "paused" }, refused: true, want: { codes: "B", row: "rewritten", mark: true, catchUp: false } },
    { name: "A too large, B fits with its version", set: { a: big(), mark: "too-large", intent: "version" }, small: true, want: { codes: "B", row: "rewritten", mark: undefined, catchUp: false } },
    { name: "A too large, none", set: { a: big(), mark: "too-large" }, small: true, want: { codes: "big", row: "consistent", mark: "too-large", catchUp: false } },
    { name: "A too large, only a stale intent above its j", set: { a: big(), mark: "too-large", intent: "stale" }, small: true, want: { codes: "big", row: "stamped", mark: "too-large", catchUp: false } },
    { name: "A unmarked, B intent only, refused", set: { mark: false, intent: "paused" }, refused: true, want: { codes: "B", row: "rewritten", mark: true, catchUp: false } },
    { name: "A too large, B fits intent only, refused", set: { a: big(), mark: "too-large", intent: "paused" }, small: true, refused: true, want: { codes: "B", row: "rewritten", mark: true, catchUp: false } },
    { name: "A too large, B fits intent only, kept", set: { a: big(), mark: "too-large", intent: "paused" }, small: true, want: { codes: "B", row: "rewritten", mark: undefined, catchUp: true } },
  ];
  for (const t of rows) {
    const run = async () => {
      const { id, rec } = await setUp(t.set);
      const v0 = await versions(hdb, id);
      const r = await (t.refused ? noRoom("history", () => reopen(w, hdb, id)) : reopen(w, hdb, id));
      const p = await persisted(w, hdb, id);
      const c = t.want.codes === "big" ? J([["a", big()]]) : J([["a", t.want.codes]]);
      // ("not tried": TimeTravel left as it was, not paused by a version it could never keep)
      const ok = (t.want.mark !== "too-large" || !r.st.history.pauseState().paused) && r.row === t.want.row && p.codes === c && p.hashOk && p.rec.unjournaled === t.want.mark && (t.want.catchUp ? r.catchUp === p.rec.j && (await versions(hdb, id)) === v0 + 1 : r.catchUp == null && (await versions(hdb, id)) === v0) && p.intents === (t.refused ? p.intents : 0) && (rec.unjournaled === (t.set.mark ?? true) || (t.set.mark === false && rec.unjournaled === undefined));
      check(ok, `§3 table: ${t.name}: ${t.want.row}, ${J(t.want.mark ?? "unmarked")}: ` + J({ row: r.row, mark: p.rec.unjournaled, catchUp: r.catchUp, j: p.rec.j, added: (await versions(hdb, id)) - v0, was: rec.unjournaled }));
      await close(r.st);
    };
    await (t.small ? smallBound(run) : run());
  }
  // (a crash between the catch-up and T2: the next load finds the head already the value: no second version, unmarked)
  {
    const { id } = await setUp({});
    const v0 = await versions(hdb, id);
    const s1 = store(w, hdb, id);
    const failed = await noRoom("notebooks", () => s1.load().then(() => "loaded", (e) => e?.message ?? String(e)));
    await close(s1);
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    check(failed !== "loaded" && r.row === "stamped" && p.rec.unjournaled === undefined && r.catchUp === null && (await versions(hdb, id)) === v0 + 1 && p.jOk, "§3: a crash between the catch-up and T2: the next load writes T2 alone, unmarked, no second version: " + J({ failed, row: r.row, added: (await versions(hdb, id)) - v0 }));
    await close(r.st);
  }
  await close(w);
  hdb.close();
}


async function lifetimeWithMarks() {
  // A4 (§5, #215 r4's C1-C4): the fallback's T2 and the ingestion run inside the writer's lifetime: a release waits for
  // them, the next writer is granted only after they committed, and a save meanwhile is refused
  const { w, hdb } = await active();
  // (1) a pending ingestion (a marked record's catch-up held), a release, a waiting tab
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const rec0 = await rawGet(w.main, "notebooks", id);
    await noRoom("history", () => st.save({ ...d, cells: [{ id: "a", code: "M" }], baseRev: rec0.rev }));
    await close(st);
    const v0 = await versions(hdb, id);
    const v = store(w, hdb, id);
    let open, reached; const gate = new Promise((r) => { open = r; }), inTx = new Promise((r) => { reached = r; });
    W.JOURNAL_TX_HOOK.beforeTx = async () => { W.JOURNAL_TX_HOOK.beforeTx = undefined; reached(); await gate; };
    const loading = v.load().then(() => "loaded", (e) => e.message);
    const held = await within(inTx, 3000);
    if (held === "timeout") W.JOURNAL_TX_HOOK.beforeTx = undefined;
    const x = store(w, hdb, id);
    await x.load();
    const xt = takeover(x, 4000);
    const said = await v.save({ ...d, cells: [{ id: "a", code: "meanwhile" }], baseRev: rec0.rev + 1 });
    const released = v.release();
    await sleep(200);
    const early = x.writer;
    open();
    const l = await loading;
    await released;
    const r = await xt, rec = await rawGet(w.main, "notebooks", id), added = (await versions(hdb, id)) - v0;
    // (released while it waited, its catch-up is refused at its turn; its T2 still commits before the lock is let go,
    // and the mark says exactly whether a version holds the value)
    check(held !== "timeout" && !early && r !== "timeout" && x.writer && said === "not saved: this notebook is open for editing in another tab of this browser" && codes(rec) === J([["a", "M"]]) && (rec.unjournaled === undefined) === (added === 1) && rec.hash === (await N.docHash(rec)), "A4: a release while the ingestion is pending: the next tab is granted only after it settled; a save meanwhile refused; the record M, marked unless a version holds it: " + J({ early, l, mark: rec.unjournaled, added }));
    await close(x);
  }
  // (2) a fallback save of the load's own (a new notebook's first, the metadata budget full) held in its T2, a release
  {
    const id = newId(), v = store(w, hdb, id, doc([["a", "first"]]));
    const keep = N.JOURNAL_BUDGETS.metaAll;
    N.JOURNAL_BUDGETS.metaAll = (await recount(hdb)).counted.meta + 10;
    const save = S.IdbStore.prototype.save;
    let open, reached; const gate = new Promise((r) => { open = r; }), inT2 = new Promise((r) => { reached = r; });
    S.IdbStore.prototype.save = async function (doc, opts) { if (opts?.journal?.keep) { S.IdbStore.prototype.save = save; reached(); await gate; } return save.call(this, doc, opts); };
    try {
      const loading = v.load().then(() => "loaded", (e) => e.message);
      const held = await within(inT2, 3000);
      if (held === "timeout") S.IdbStore.prototype.save = save;
      const x = store(w, hdb, id);
      await x.load();
      const xt = takeover(x, 4000);
      const released = v.release();
      await sleep(200);
      const early = x.writer;
      open();
      const l = await loading;
      await released;
      const r = await xt, rec = await rawGet(w.main, "notebooks", id);
      check(held !== "timeout" && !early && r !== "timeout" && x.writer && l === "loaded" && rec?.unjournaled === true && codes(rec) === J([["a", "first"]]), "A4: the load's own fallback save held in its T2 and a release: the lock let go only once it committed (C1, C4); the record written, marked: " + J({ early, l, mark: rec?.unjournaled }));
      await close(x);
    } finally {
      S.IdbStore.prototype.save = save;
      N.JOURNAL_BUDGETS.metaAll = keep;
    }
  }
  // (3) the same as (1), the takeover's reload failing: it lets go, and the next tab takes over, nothing more written
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const rec0 = await rawGet(w.main, "notebooks", id);
    await noRoom("history", () => st.save({ ...d, cells: [{ id: "a", code: "M" }], baseRev: rec0.rev }));
    const x = store(w, hdb, id), y = store(w, hdb, id);
    await x.load(); await y.load();
    const xt = takeover(x, 3000);
    await close(st);
    await xt;
    const before = J(await rawGet(w.main, "notebooks", id)), v0 = await versions(hdb, id);
    x.recover = async () => { throw new Error("the test's failed recovery"); };
    const failed = await x.load().then(() => null, (e) => e.message);
    const said = await x.save({ ...d, cells: [{ id: "a", code: "after" }], baseRev: rec0.rev + 1 });
    const yt = takeover(y, 3000);
    await x.release();
    const r = await yt;
    check(/failed recovery/.test(failed) && said === "not saved: this notebook is open for editing in another tab of this browser" && r !== "timeout" && y.writer && J(await rawGet(w.main, "notebooks", id)) === before && (await versions(hdb, id)) === v0, "A4: the takeover's reload failing: nothing more written, the lock let go, the next tab takes over");
    await close(y);
  }
  await close(w);
  hdb.close();
}


async function clearAgainstTheProof() {
  // astra's CORR-229-1: a TimeTravel clear deletes the versions a mark's proof rests on.  It waits for a save between
  // its proof and its T2, marks the record before it deletes anything, and so, whatever its re-record does, the record
  // is never unmarked without a version holding its value: before reopening and after
  const { w, hdb } = await active();
  // (held saves: B's T2 held after its proof; an ordinary one (its version kept), then a fallback (out of room))
  for (const fallback of [false, true]) {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const before = await rawGet(w.main, "notebooks", id);
    const save = S.IdbStore.prototype.save;
    let resume, reached; const gate = new Promise((r) => { resume = r; }), atT2 = new Promise((r) => { reached = r; });
    S.IdbStore.prototype.save = async function (doc, opts) {
      if (this.id === id && opts?.journal && !opts.journal.markOnly && doc.cells?.[0]?.code === "B") { S.IdbStore.prototype.save = save; reached(); await gate; }
      return save.call(this, doc, opts);
    };
    try {
      // (the fallback's T1 refused by a full pending budget, not by refused puts, so the clear's refused re-record below
      // is the only thing out of room)
      const keep = N.JOURNAL_BUDGETS.pendingAll;
      if (fallback) N.JOURNAL_BUDGETS.pendingAll = (await recount(hdb)).counted.pend;
      const saving = st.save({ ...d, cells: [{ id: "a", code: "B" }], baseRev: before.rev }).finally(() => { N.JOURNAL_BUDGETS.pendingAll = keep; });
      const held = await within(atT2, 3000);
      if (held === "timeout") S.IdbStore.prototype.save = save;
      // (the clear asked for while B is held, its re-record refused (out of room): it waits for B)
      const result = await noRoom("history", async () => {
        const clearing = st.history.clear({ ...d, cells: [{ id: "a", code: "C" }] }).then(() => "cleared", (e) => e.message);
        await sleep(150);
        const waited = (await versions(hdb, id)) > 0;
        resume();
        const out = await saving;
        const c = await clearing;
        await st.patches.appending;
        return { waited, out, c };
      });
      const rec = await rawGet(w.main, "notebooks", id), rows = await versions(hdb, id);
      await close(st);
      const r = await reopen(w, hdb, id);
      const after = await rawGet(w.main, "notebooks", id), rowsAfter = await versions(hdb, id);
      const holds = (x, n) => x.unjournaled !== undefined || n > 0;
      check(held !== "timeout" && result.waited && !!result.out?.saved && result.c === "cleared" && codes(rec) === J([["a", "B"]]) && rec.unjournaled === true && rec.rev === before.rev + 1 && holds(rec, rows) && holds(after, rowsAfter) && after.unjournaled === undefined && rowsAfter >= 1 && codes(after) === J([["a", "B"]]), `CORR-229-1${fallback ? " (a fallback save held)" : ""}: a clear while B is between its proof and T2 waits for it, marks the record before deleting (its revision kept), and its re-record refused leaves B marked; reopened, B is ingested and unmarked: ` + J({ held, waited: result.waited, c: result.c, mark: rec.unjournaled, rows, row: r.row, markAfter: after.unjournaled, rowsAfter }));
      await close(r.st);
    } finally {
      S.IdbStore.prototype.save = save;
    }
  }
  // (a save asked for while a clear runs (held as it marks the record) waits for the clear: its proof read after it.  The
  // invariant, exactly: a record left unmarked is the history head's value, here and after reopening)
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const save = S.IdbStore.prototype.save;
    // (the clear held as it marks; C's T2 held too, until the clear is done: a save that didn't wait for the clear would
    // have proved C on a head the clear then deletes)
    let resume, reached, resumeC; const gate = new Promise((r) => { resume = r; }), atMark = new Promise((r) => { reached = r; }), gateC = new Promise((r) => { resumeC = r; });
    let marks = 0, cs = 0;
    S.IdbStore.prototype.save = async function (doc, opts) {
      if (this.id === id && opts?.journal?.markOnly && !marks++) { reached(); await gate; }
      if (this.id === id && opts?.journal && !opts.journal.markOnly && doc.cells?.[0]?.code === "C" && !cs++) await gateC;
      return save.call(this, doc, opts);
    };
    try {
      const clearing = st.history.clear({ ...d, cells: [{ id: "a", code: "A" }] }).then(() => "cleared", (e) => e.message);
      const held = await within(atMark, 3000);
      if (held === "timeout") S.IdbStore.prototype.save = save;
      const rec1 = await rawGet(w.main, "notebooks", id);
      const saving = st.save({ ...d, cells: [{ id: "a", code: "C" }], baseRev: rec1.rev });
      await sleep(100);
      resume();
      const c = await clearing;
      await st.patches.appending;
      resumeC();
      const out = await saving;
      S.IdbStore.prototype.save = save;
      await st.patches.appending;
      const rec = await rawGet(w.main, "notebooks", id), head = await st.headHash();
      await close(st);
      const r = await reopen(w, hdb, id);
      const after = await rawGet(w.main, "notebooks", id), headAfter = await r.st.headHash();
      check(held !== "timeout" && c === "cleared" && !!out?.saved && codes(rec) === J([["a", "C"]]) && (rec.unjournaled !== undefined || head === rec.hash) && (after.unjournaled !== undefined || headAfter === after.hash), "CORR-229-1: a save asked for while a clear marks the record waits for the clear; a record left unmarked is the head's value, before reopening and after: " + J({ c, mark: rec.unjournaled, headIsValue: head === rec.hash, row: r.row, markAfter: after.unjournaled, headAfterIsValue: headAfter === after.hash }));
      await close(r.st);
    } finally {
      S.IdbStore.prototype.save = save;
    }
  }
  // (a clear while recovery's ingestion is pending: refused (not ready), nothing deleted, the record still marked)
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const rec0 = await rawGet(w.main, "notebooks", id);
    await noRoom("history", () => st.save({ ...d, cells: [{ id: "a", code: "M" }], baseRev: rec0.rev }));
    await close(st);
    const v = store(w, hdb, id);
    let open; const gate = new Promise((r) => { open = r; });
    W.JOURNAL_TX_HOOK.beforeTx = async () => { W.JOURNAL_TX_HOOK.beforeTx = undefined; await gate; };
    const loading = v.load().then(() => "loaded", (e) => e.message);
    await sleep(100);
    const c = await v.history.clear({ ...d, cells: [{ id: "a", code: "M" }] }).then(() => "cleared", (e) => e.message);
    const recMid = await rawGet(w.main, "notebooks", id);
    open();
    const l = await loading;
    const rec = await rawGet(w.main, "notebooks", id);
    check(/open for editing/.test(c) && recMid.unjournaled === true && l === "loaded" && (rec.unjournaled !== undefined || (await versions(hdb, id)) > 0), "CORR-229-1: a clear while a marked ingestion is pending is refused, nothing deleted; the invariant holds after: " + J({ c: c.slice(0, 30), mark: rec.unjournaled }));
    await close(v);
  }
  await close(w);
  hdb.close();
}


async function reloadDuringClear() {
  // astra's CORR-229-2: a reload while a clear has marked the record and not yet deleted: the reload's recovery waits for
  // the clear (now refused at its turn, nothing deleted), and the record is never left unmarked without its value as
  // the history's head; the same for a drop
  const { w, hdb } = await active();
  for (const kind of ["clear", "drop"]) {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const mark = st.markRecord.bind(st);
    let resume, reached; const gate = new Promise((r) => { resume = r; }), marked = new Promise((r) => { reached = r; });
    st.markRecord = async () => { await mark(); reached(); await gate; };
    const op = kind === "clear" ? st.history.clear({ ...d, cells: [{ id: "a", code: "C" }] }) : st.patches.drop();
    const doing = op.then(() => "done", (e) => e.message);
    const held = await within(marked, 3000);
    const atMark = await rawGet(w.main, "notebooks", id);
    const loading = st.load().then(() => "loaded", (e) => e.message);
    await sleep(100);
    const early = (await rawGet(w.main, "notebooks", id)).unjournaled;
    const out = await noRoom("history", async () => { resume(); const o = await doing; const l = await loading; await st.patches.appending; return { o, l }; });
    const rec = await rawGet(w.main, "notebooks", id), head = await st.headHash().catch(() => null), rows = await versions(hdb, id);
    await close(st);
    const r = await reopen(w, hdb, id);
    const after = await rawGet(w.main, "notebooks", id), headAfter = await r.st.headHash();
    check(held !== "timeout" && atMark.unjournaled === true && early === true && out.l === "loaded" && /open for editing/.test(out.o) && (rec.unjournaled !== undefined || head === rec.hash) && (after.unjournaled !== undefined || headAfter === after.hash), `CORR-229-2 (${kind}): a reload while it has marked and not deleted waits for it (it is then refused at its turn); a record left unmarked is the head's value, before reopening and after: ` + J({ held, o: String(out.o).slice(0, 30), l: out.l, early, mark: rec.unjournaled, rows, row: r.row, markAfter: after.unjournaled }));
    await close(r.st);
  }
  await close(w);
  hdb.close();
}


// ---- 2c-2: a notebook's synced history, its slot, its l rows and its debt
const lrows = async (hdb, id) => { const js = await jState(hdb, id); const h = (await syncRows(hdb)).find((r) => r.time === "d:local:" + id)?.v?.h; return h ? (await syncRows(hdb)).filter((r) => r.nb === R.SYNC_NB + h && r.time.startsWith("l")) : []; };
const keyRows = (hdb, key) => rawAll(hdb, "history", IDBKeyRange.bound([key, ""], [key, "￿"]));
const debtRow = async (hdb) => (await syncRows(hdb)).find((r) => r.nb === R.SYNC_NB && r.time === "b:d:local")?.v ?? { count: 0, bytes: 0 };
async function synced(f) { N.DOC_SYNC.on = true; try { return await f(); } finally { N.DOC_SYNC.on = false; } }

async function syncStart() {
  // D6(a): a writer's load starts the synced history: a new key, its root the whole value, from the slot's new client,
  // in one T1 with the start row and the slot; the versions before stay under the old key, untouched
  const { w, hdb } = await active();
  await synced(async () => {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"], ["b", "B"]]);
    const js = await jState(hdb, id), key = N.syncedKey(id, 1), rows = await keyRows(hdb, key), old = await keyRows(hdb, id), l = await lrows(hdb, id);
    const root = rows[0]?.env;
    check(js.start?.n === 1 && js.slot?.client && js.slot.cseq === 2 && rows.length === 1 && (root?.parents ?? []).length === 0 && root.time.endsWith("_" + js.slot.client) && old.length >= 1 && l.length === 1 && l[0].v.cseq === 1 && l[0].v.client === js.slot.client && l[0].v.gen === 1 && Number(l[0].time.slice(1)) === rows[0].j, "D6(a): the start: the synced key's root (no parents) from the slot's client, the start row, the slot and the root's l row (cseq 1, as the server counts) together; the version before it stays under the old key: " + J({ start: js.start, rows: rows.length, old: old.length, l: l.length }));
    // (the root is the whole value)
    check(codes(st.history.docAt(root.time)) === J([["a", "A"], ["b", "B"]]), "…the root holds the whole value");
    // (saves: an l row each, the client's cseq rising, the debt counted exactly)
    let rec = await rawGet(w.main, "notebooks", id);
    for (const c of ["B1", "B2", "B3"]) { await st.save({ ...d, cells: [{ id: "a", code: c }, { id: "b", code: "B" }], baseRev: rec.rev }); rec = await rawGet(w.main, "notebooks", id); }
    const l2 = await lrows(hdb, id), js2 = await jState(hdb, id), debt = await debtRow(hdb), sum = l2.reduce((x, r) => x + r.v.bytes, 0);
    check(l2.map((r) => r.v.cseq).join() === "1,2,3,4" && js2.slot.cseq === 5 && js2.slot.debt.count === 4 && js2.slot.debt.bytes === sum && debt.count >= 4 && rec.unjournaled === undefined, "each save's version: its l row, the client's cseq rising, the debt counted exactly (the slot's and the namespace's): " + J({ cseqs: l2.map((r) => r.v.cseq), debt: js2.slot.debt }));
    // (clear refused while synced; the slot's client and cseq kept across a reload, ids rising with the clock set back)
    const cleared = await st.history.clear({ ...d }).then(() => "cleared", (e) => e.message);
    check(/can't be cleared while this notebook syncs/.test(cleared) && (await keyRows(hdb, key)).length === 4, "astra's pin 1: TimeTravel's Clear refused for a synced notebook; its versions untouched");
    await close(st);
    const now = Date.now;
    Date.now = () => now() - 3600e3;
    try {
      const r = await reopen(w, hdb, id);
      const rec2 = await rawGet(w.main, "notebooks", id);
      await r.st.save({ ...r.d, cells: [{ id: "a", code: "B4" }, { id: "b", code: "B" }], baseRev: rec2.rev });
      const rows3 = await keyRows(hdb, key), l3 = await lrows(hdb, id), last = l3[l3.length - 1].v, prev = l3[l3.length - 2].v;
      check(r.row === "consistent" && last.client === js.slot.client && last.cseq === 5 && last.time > prev.time && rows3.length === 5, "a reload with the clock an hour back: the same client, cseq 5 next, its id after the last one: " + J({ row: r.row, cseq: last.cseq, rising: last.time > prev.time }));
      await close(r.st);
    } finally { Date.now = now; }
    // (pages: at most `max`, in j order; at least one past the bytes bound)
    const all = await N.unsent(hdb, id), two = await N.unsent(hdb, id, { max: 2 }), small = await N.unsent(hdb, id, { maxBytes: 1 }), after = await N.unsent(hdb, id, { after: all[1].j });
    check(all.length === 5 && two.length === 2 && two[1].j < all[2].j && small.length === 1 && after.length === 3 && after[0].j === all[2].j, "unsent: in j order, at most max a page, one at least past maxBytes, after a j");
    // (a read-only tab shows the synced history; a patch not from the slot's client is refused by T1)
    // (another tab holds the writer's lock, so this one is read-only: its history from the load's first read)
    const holder = store(w, hdb, id);
    await holder.load();
    const viewer = store(w, hdb, id);
    await viewer.load();
    const readOnly = !viewer.writer;
    const wrong = await viewer.patches.queue(() => viewer.patches.journalTx((s) => N.t1Write(s, id, { row: { nb: key, time: "000mvr8ccru_not-the-slot-client", env: { time: "000mvr8ccru_not-the-slot-client" } } })));
    check(readOnly && viewer.patches.id === key && viewer.history.session && /not this device's sync client/.test(wrong?.refused ?? "") && (await keyRows(hdb, key)).length === 5, "a read-only tab reads the synced history; a patch from another client is refused by T1, nothing written: " + J(wrong?.refused));
    await close(viewer, holder);
    // (a drop: the synced and the old keys' rows, the l rows and the slot gone, the namespace's debt released)
    const d0 = await debtRow(hdb), mine = (await jState(hdb, id)).slot.debt;
    const s2 = store(w, hdb, id);
    await s2.load();
    await s2.patches.drop();
    const d1 = await debtRow(hdb);
    check((await keyRows(hdb, key)).length === 0 && (await keyRows(hdb, id)).length === 0 && (await lrows(hdb, id)).length === 0 && d1.count === d0.count - mine.count && d1.bytes === d0.bytes - mine.bytes, "a drop takes the synced history, the versions before it, the l rows, and releases the debt: " + J({ d0, d1, mine }));
    await close(s2);
    // (the workspace's dropContents (emptying Trash) the same)
    const n2 = await loadNew(w, hdb, [["a", "A"]]);
    await close(n2.st);
    await w.dropContents([{ kind: "notebook", ref: n2.id }]);
    check((await keyRows(hdb, N.syncedKey(n2.id, 1))).length === 0 && (await keyRows(hdb, n2.id)).length === 0 && (await lrows(hdb, n2.id)).length === 0, "emptying Trash takes a synced notebook's synced history and its rows too");
  });
  await close(w);
  hdb.close();
}

async function syncStartAtomic() {
  // the start is one transaction: refused (out of room), nothing of it is written, the notebook stays local and
  // saves as before; the next load starts it; a second start is refused
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  await close(st);
  await synced(async () => {
    const r = await noRoom("history", () => reopen(w, hdb, id));
    const js = await jState(hdb, id);
    check(js.start === null && js.slot === null && js.lrows === 0 && (await keyRows(hdb, N.syncedKey(id, 1))).length === 0 && !r.st.synced, "a start out of room: no start row, no slot, no l row, no synced key's row");
    const rec = await rawGet(w.main, "notebooks", id);
    const out = await r.st.save({ ...r.d, cells: [{ id: "a", code: "B" }], baseRev: rec.rev });
    check(!!out?.saved && (await keyRows(hdb, id)).length >= 2, "…the notebook saves as before, its versions under its own key");
    await close(r.st);
    const r2 = await reopen(w, hdb, id), js2 = await jState(hdb, id);
    check(js2.start?.n === 1 && js2.lrows === 1, "…its next load starts it");
    const again = await r2.st.startSynced(r2.d).then(() => "started", (e) => e.message);
    // (and T1's own check, asked directly: a start row already there refuses another)
    const raw = await r2.st.patches.queue(() => r2.st.patches.journalTx((s) => N.t1Write(s, id, { start: { n: 2, client: "another-client-1", time: "t" } })));
    check(/already started/.test(again) && /already started/.test(raw?.refused ?? "") && (await jState(hdb, id)).lrows === 1 && (await jState(hdb, id)).start.n === 1, "a second start refused, by the store and by T1 itself, nothing written: " + J([again, raw?.refused]));
    await close(r2.st);
  });
  await close(w);
  hdb.close();
}

async function syncDebt() {
  // r9 §3.8 at its bound: the version refused for room (sync's debt), the save kept (intent, marked); an ack frees the
  // room and the history resumes (astra's pin 3): the next save is a version with its l row, unmarked
  const { w, hdb } = await active();
  await synced(async () => {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const keep = { ...N.SYNC_DEBT };
    N.SYNC_DEBT.docCount = 1;
    try {
      let rec = await rawGet(w.main, "notebooks", id);
      const out = await st.save({ ...d, cells: [{ id: "a", code: "B" }], baseRev: rec.rev });
      rec = await rawGet(w.main, "notebooks", id);
      const js = await jState(hdb, id);
      check(!!out?.saved && rec.unjournaled === true && js.lrows === 1 && st.history.paused, "the debt at its bound: the version refused, the save kept and marked, no l row; the history paused: " + J({ mark: rec.unjournaled, lrows: js.lrows }));
      N.SYNC_DEBT.docCount = keep.docCount;
      const r = await st.ackedUpTo({ gen: js.slot.gen, client: js.slot.client, upTo: 1 });
      const js2 = await jState(hdb, id);
      check(r.n === 1 && js2.lrows === 0 && js2.slot.debt.count === 0 && js2.slot.debt.bytes === 0 && !st.history.paused, "an ack: the l row gone, the debt released, the history resumed");
      const out2 = await st.save({ ...d, cells: [{ id: "a", code: "C" }], baseRev: rec.rev });
      const rec2 = await rawGet(w.main, "notebooks", id), js3 = await jState(hdb, id);
      check(!!out2?.saved && rec2.unjournaled === undefined && js3.lrows === 1 && (await N.unsent(hdb, id))[0].cseq === 2, "…the next save is a version again, with its l row (cseq 2), unmarked");
    } finally { Object.assign(N.SYNC_DEBT, keep); }
    await close(st);
  });
  await close(w);
  hdb.close();
}

async function syncRotation() {
  // astra's pin 2: a rotation keeps the old client's rows addressable by its generation and id; marks and acks of one
  // client never touch another's, and acks are idempotent
  const { w, hdb } = await active();
  await synced(async () => {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    let rec = await rawGet(w.main, "notebooks", id);
    await st.save({ ...d, cells: [{ id: "a", code: "B" }], baseRev: rec.rev });
    const old = (await jState(hdb, id)).slot;
    const next = { slot: await st.rotateClient() }, nc = next.slot.client;
    rec = await rawGet(w.main, "notebooks", id);
    await st.save({ ...d, cells: [{ id: "a", code: "C" }], baseRev: rec.rev });
    const l = await lrows(hdb, id);
    const mk = await st.markSentUpTo({ gen: 2, client: nc, upTo: 5, fgen: 1 });
    const l2 = await lrows(hdb, id);
    const wrong = await st.ackedUpTo({ gen: 2, client: old.client, upTo: 5 });
    const a1 = await st.ackedUpTo({ gen: 1, client: old.client, upTo: 5 }), a2 = await st.ackedUpTo({ gen: 1, client: old.client, upTo: 5 });
    const l3 = await lrows(hdb, id);
    check(next.slot.gen === 2 && next.slot.cseq === 1 && next.slot.rotations === 1 && l.length === 3 && l[2].v.gen === 2 && l[2].v.cseq === 1 && mk.n === 1 && l2.filter((r) => r.v.sent?.fgen === 1).length === 1 && l2.find((r) => r.v.sent?.fgen === 1).v.gen === 2 && wrong.n === 0 && a1.n === 2 && a2.n === 0 && l3.length === 1 && l3[0].v.gen === 2, "a rotation: the new client from cseq 1 (gen 2); the old rows keep gen 1; a mark or an ack of one client never touches another's; acks idempotent: " + J({ l: l.map((r) => [r.v.gen, r.v.cseq]), mk: mk.n, wrong: wrong.n, a1: a1.n, a2: a2.n }));
    await close(st);
  });
  await close(w);
  hdb.close();
}


async function syncIdentity() {
  // astra's CORR-2C2-1: once a notebook's history key is its synced one (<id>:s1), every journal row stays the notebook's
  // own: one registry, one rising J, its intents pruned; an intent-only save (unchanged, or paused) recovered after a
  // crash before its T2
  const { w, hdb } = await active();
  await synced(async () => {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const key = N.syncedKey(id, 1), regOf = async (x) => (await syncRows(hdb)).filter((r) => r.time === "d:local:" + x);
    let rec = await rawGet(w.main, "notebooks", id);
    const js0 = await jState(hdb, id);
    // (a changed save, an unchanged one, then a paused one)
    const outs = [];
    outs.push(await st.save({ ...d, cells: [{ id: "a", code: "B" }], baseRev: rec.rev }));
    rec = await rawGet(w.main, "notebooks", id);
    const js1 = await jState(hdb, id);
    outs.push(await st.save({ ...d, cells: [{ id: "a", code: "B" }], baseRev: rec.rev }));
    rec = await rawGet(w.main, "notebooks", id);
    const js2 = await jState(hdb, id);
    await pause(st);
    outs.push(await st.save({ ...d, cells: [{ id: "a", code: "C" }], baseRev: rec.rev }));
    rec = await rawGet(w.main, "notebooks", id);
    const js3 = await jState(hdb, id);
    check(outs.every((o) => !!o?.saved) && js1.J > js0.J && js2.J > js1.J && js3.J > js2.J && rec.j === js3.J && js3.intents.length === 0 && (await regOf(key)).length === 0 && (await regOf(id)).length === 1 && codes(rec) === J([["a", "C"]]), "CORR-2C2-1: synced, a changed, an unchanged and a paused save: each T2 written, one registry (the notebook's, none for <id>:s1), one J rising, every intent pruned: " + J({ J: [js0.J, js1.J, js2.J, js3.J], recj: rec.j, intents: js3.intents.length, s1: (await regOf(key)).length }));
    // (an intent-only T1 (paused) whose T2 never came: recovered from the notebook's own journal)
    await t1Only(st, { ...d, cells: [{ id: "a", code: "D" }], baseRev: rec.rev });
    const js4 = await jState(hdb, id);
    await close(st);
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    check(js4.intents.length === 1 && js4.J === js3.J + 1 && (await regOf(key)).length === 0 && r.row === "rewritten" && p.codes === J([["a", "D"]]) && p.intents === 0 && p.jOk, "CORR-2C2-1: …an intent-only T1 cut off before its T2 is in the notebook's journal, and a reopen recovers it: " + J({ row: r.row, codes: p.codes }));
    await close(r.st);
  });
  await close(w);
  hdb.close();
}

async function syncGrantDuringLoad() {
  // astra's CORR-2C2-2: B loads read-only while A holds the lock; A starts the synced history (and, the second time,
  // rotates its client) and lets go while B's first load still reads; B, granted then, takes the persisted key and
  // the current client, and its first edit is one l row of that client
  const { w, hdb } = await active();
  for (const rotateToo of [false, true]) {
    const { id, st: a, d } = await loadNew(w, hdb, [["a", "A"]]);
    const b = store(w, hdb, id), load = S.IdbStore.prototype.loadRecord;
    let resume, reached; const gate = new Promise((r) => { resume = r; }), inRead = new Promise((r) => { reached = r; });
    S.IdbStore.prototype.loadRecord = async function () { if (this === b) { S.IdbStore.prototype.loadRecord = load; reached(); await gate; } return load.call(this); };
    try {
      const loading = b.load().then(() => "loaded", (e) => e.message);
      const held = await within(inRead, 3000);
      if (held === "timeout") S.IdbStore.prototype.loadRecord = load;
      // (A starts, and rotates, while B's read-only load waits)
      N.DOC_SYNC.on = true;
      const rec0 = await rawGet(w.main, "notebooks", id);
      await a.startSynced({ ...d, rev: rec0.rev });
      if (rotateToo) await a.rotateClient();
      N.DOC_SYNC.on = false;
      const slot = (await jState(hdb, id)).slot;
      const granted = takeover(b, 3000);
      await close(a);
      await within(granted, 3000);
      resume();
      const l = await loading;
      const rec = await rawGet(w.main, "notebooks", id), before = (await lrows(hdb, id)).length;
      const out = await b.save({ ...d, cells: [{ id: "a", code: "after" }], baseRev: rec.rev });
      const after = await lrows(hdb, id), last = after[after.length - 1]?.v;
      check(held !== "timeout" && l === "loaded" && b.writer && b.patches.id === N.syncedKey(id, 1) && !!out?.saved && after.length === before + 1 && last?.client === slot.client && last?.gen === slot.gen, `CORR-2C2-2${rotateToo ? " (with a rotation)" : ""}: granted during its read-only load, B adopts the persisted synced key and the current client; its first edit is one l row of that client: ` + J({ l, key: b.patches.id === N.syncedKey(id, 1), saved: !!out?.saved, rows: [before, after.length], client: last?.client === slot.client, gen: [last?.gen, slot.gen] }));
      await close(b);
    } finally {
      S.IdbStore.prototype.loadRecord = load;
      N.DOC_SYNC.on = false;
    }
  }
  await close(w);
  hdb.close();
}

// ---- 2c-3: what the wire writes into the journal (journal-rows.js): acks bound to their request, the pull cursor's
// compare and swap (astra's A2), a received patch skipped only when the exact patch is there, claims for the slot's own
// client
async function syncWireRows() {
  const { w, hdb } = await active();
  await synced(async () => {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const jtx = (fn) => st.patches.queue(() => st.patches.journalTx(async (s) => ({ j: 0, out: await fn(s) }))).catch((e) => ({ refused: String(e?.message ?? e) }));
    let rec = await rawGet(w.main, "notebooks", id);
    await st.save({ ...d, cells: [{ id: "a", code: "B" }], baseRev: rec.rev });
    const slot = (await jState(hdb, id)).slot, l0 = await lrows(hdb, id);
    // (acks: A4, only the rows the request carried, in its epoch)
    const mk = await jtx((s) => N.markSent(s, id, { gen: slot.gen, client: slot.client, upTo: 99, fgen: 1, epoch: 1, req: 7 }));
    const otherReq = await jtx((s) => N.acked(s, id, { gen: slot.gen, client: slot.client, upTo: 99, epoch: 1, req: 8 }));
    const otherEpoch = await jtx((s) => N.acked(s, id, { gen: slot.gen, client: slot.client, upTo: 99, epoch: 2, req: 7 }));
    const l1 = await lrows(hdb, id);
    const right = await jtx((s) => N.acked(s, id, { gen: slot.gen, client: slot.client, upTo: 99, epoch: 1, req: 7 }));
    const l2 = await lrows(hdb, id);
    check(l0.length >= 1 && mk.out === l0.length && otherReq.out === 0 && otherEpoch.out === 0 && l1.length === l0.length && l1.every((r) => r.v.sent?.req === 7 && r.v.sent?.epoch === 1) && right.out === l0.length && l2.length === 0, "2c-3 A4: an ack releases only the rows its own request carried, in its epoch: " + J({ l0: l0.length, mk: mk.out, otherReq: otherReq.out, otherEpoch: otherEpoch.out, right: right.out, left: l2.length }));
    // (claims: recorded only for the slot's own generation and client)
    const wrongClaim = await jtx((s) => N.recordClaim(s, id, { gen: slot.gen + 1, client: slot.client, epoch: 1, fgen: 3 }));
    const goodClaim = await jtx((s) => N.recordClaim(s, id, { gen: slot.gen, client: slot.client, epoch: 1, fgen: 3 }));
    const s2 = (await jState(hdb, id)).slot;
    check(wrongClaim.out === false && goodClaim.out === true && s2.claimed?.epoch === 1 && s2.claimed?.client === slot.client && s2.fgen === 3, "2c-3: a claim is recorded for the slot's own generation and client only: " + J({ wrong: wrongClaim.out, claimed: s2.claimed, fgen: s2.fgen }));
    // (the cursor: A2's compare and swap; a page applied once; the exact patch skipped, another under its id refused)
    const key = N.syncedKey(id, 1), k1 = { epoch: 1, after: 1, recv: 10, chain: "a".repeat(64) }, k2 = { epoch: 1, after: 2, recv: 20, chain: "b".repeat(64) };
    const p1 = { time: "zz-remote-1", env: { time: "zz-remote-1", parents: [], v: 1 } }, p2 = { time: "zz-remote-2", env: { time: "zz-remote-2", parents: ["zz-remote-1"], v: 2 } };
    const J0 = (await jState(hdb, id)).J;
    const first = await jtx((s) => N.applyPage(s, id, { expect: null, next: k1, rows: [p1] }));
    const stale = await jtx((s) => N.applyPage(s, id, { expect: null, next: k2, rows: [p2] }));
    const js1 = await jState(hdb, id), had2 = (await keyRows(hdb, key)).some((r) => r.time === p2.time);
    check(first.out?.applied === 1 && first.out?.j === J0 + 1 && stale.out === undefined && J(js1.cursor) === J(k1) && !had2 && js1.J === J0 + 1, "2c-3 A2: a page applies under the cursor it was asked from; one asked from a stale cursor writes nothing (no patch, no cursor, no j): " + J({ first: first.out, stale: stale.out ?? stale.refused ?? null, cursor: js1.cursor, J: js1.J }));
    const again = await jtx((s) => N.applyPage(s, id, { expect: k1, next: k2, rows: [p1, p2] }));
    const js2 = await jState(hdb, id);
    check(again.out?.applied === 1 && js2.J === J0 + 2 && J(js2.cursor) === J(k2), "2c-3: a patch already there exactly is skipped, the new one applied: " + J({ again: again.out, J: js2.J - J0 }));
    const clash = await jtx((s) => N.applyPage(s, id, { expect: k2, next: { ...k2, after: 3 }, rows: [{ time: p2.time, env: { ...p2.env, v: 99 } }] }));
    const js3 = await jState(hdb, id), stored2 = (await keyRows(hdb, key)).find((r) => r.time === p2.time);
    check(clash.out === undefined && J(js3.cursor) === J(k2) && stored2?.env?.v === 2 && js3.J === js2.J, "2c-3: another patch under a stored patch's id is refused, nothing changed: " + J({ clash: clash.out ?? clash.refused ?? null, v: stored2?.env?.v }));
    await close(st);
  });
  await close(w);
  hdb.close();
}

// ---- DEV's switch on the notebook page (astra's DEVSW-2, daybreak3): the page's own reopenJournaled, shownReadOnly and
// docSyncReload, as index.html has them, run with what they use given to them; and the switch over a real workspace
async function switchFunctions(deps) {
  const src = await (await fetch("./page-src.html")).text();
  const a = src.indexOf("// (DEV's switch, after the journal's activation"), b = src.indexOf("let journalKit = null;", a);
  if (a < 0 || b < 0) throw new Error("the page's switch functions weren't found");
  const make = new Function("deps", `with (deps) {\n${src.slice(a, b)}\nreturn { reopenJournaled, shownReadOnly, docSyncReload, ownNotebook, recreating };\n}`);
  return make(deps);
}
const pageNb = (st) => ({ store: st, ro: [], detach() { this.store = null; }, setReadOnly(r) { this.ro.push(r); } });

async function switchReopenFails() {
  // the reopen after activation fails in the new store's open: no store attached (read-only: nowhere to save), the new
  // store and the old one let go, so the next tab's store takes the writer lock; the old one writes nothing more
  const { w, hdb } = await active();
  const { id, st: prev, d } = await loadNew(w, hdb, [["a", "A"]]);
  const x = store(w, hdb, id);
  await x.load();
  const xt = takeover(x, 3000);
  const nb = pageNb(prev);
  let made = null;
  const deps = { current: { id, kind: "browser" }, nb, ws: { quarantined: false }, replaying: false, replayEnded: null, docSwitch: null, docSyncNeedsReload: false,
    storeFor: async (i) => (made = store(w, hdb, i)),
    open: async (s) => { nb.detach(); await s.load(); throw new Error("the test's failed reopen"); } };
  const f = await switchFunctions(deps);
  const r = await f.reopenJournaled();
  const got = await xt;
  const said = await within(prev.save({ ...d, cells: [{ id: "a", code: "after the failed reopen" }], baseRev: d.rev }), 3000);
  const rec = await rawGet(w.main, "notebooks", id);
  check(r === false && nb.store === null && f.shownReadOnly() === true && got !== "timeout" && x.writer && !prev.writer && !made?.writer && prev.released && made?.released && !said?.v?.saved && rec.cells[0].code === "A",
    "switch: a reopen that fails: false, no store attached (read-only), the new store and the old one let go, the next tab's store the writer, the old one saving nothing: " + J({ r, attached: !!nb.store, got: got === "timeout" ? got : "taken", x: x.writer, prev: prev.writer, made: made?.writer, said: said?.v ?? said?.e?.message ?? said, code: rec.cells[0].code }));
  await close(prev, made, x, w);
  hdb.close();
}

async function switchReopenOk() {
  // the reopen after activation: a plain store shown (before activation) opened again through the journal: true, the
  // journal's store attached, the writer, saving; nothing reopened when it already is, or for a file
  const { w, hdb } = await active();
  const { id, st: seed } = await loadNew(w, hdb, [["a", "A"]]);
  await close(seed);
  const plain = new W.IdbStore(w.main, id);
  await plain.load();
  const nb = pageNb(plain);
  let made = null, asked = 0;
  const deps = { current: { id, kind: "browser" }, nb, ws: { quarantined: false }, replaying: false, replayEnded: null, docSwitch: null, docSyncNeedsReload: false,
    storeFor: async (i) => { asked++; return (made = store(w, hdb, i)); },
    open: async (s) => { nb.detach(); await s.load(); nb.store = s; } };
  const f = await switchFunctions(deps);
  const r = await f.reopenJournaled();
  const rec0 = await rawGet(w.main, "notebooks", id);
  const out = await made.save({ name: rec0.name, mode: rec0.mode, id, cells: [{ id: "a", code: "after the reopen" }], baseRev: rec0.rev });
  const rec = await rawGet(w.main, "notebooks", id);
  check(r === true && nb.store === made && made.journaled && made.writer && !!out?.saved && rec.cells[0].code === "after the reopen" && f.shownReadOnly() === false, "switch: a reopen that works: true, the journal's store attached, the writer, saving");
  deps.ws.quarantined = true;
  check(f.shownReadOnly() === true, "switch: shownReadOnly: a quarantined workspace, read-only");
  deps.ws.quarantined = false;
  nb.store = { journaled: true, synced: true, viewOnly: null };
  const r2 = await f.reopenJournaled();
  nb.store = { journaled: true, synced: true, viewOnly: "another tab" };
  const ro2 = f.shownReadOnly();
  deps.current = { id: "file:/x.ipynb", kind: "file" };
  nb.store = plain;
  const r3 = await f.reopenJournaled();
  check(r2 === true && r3 === true && asked === 1 && ro2 === true, "switch: nothing reopened when the journal's synced store is shown, or for a file; shownReadOnly: another tab writing it, read-only");
  await close(made, w);
  hdb.close();
}

async function switchReopenNoStore() {
  // the reopen after activation can't make the journal's store (its storage unavailable), or makes a plain one: false,
  // the old store detached (read-only), nothing left editable
  const { w, hdb } = await active();
  const { id, st: seed } = await loadNew(w, hdb, [["a", "A"]]);
  await close(seed);
  for (const how of ["throws", "plain"]) {
    const plain = new W.IdbStore(w.main, id);
    await plain.load();
    const nb = pageNb(plain);
    const deps = { current: { id, kind: "browser" }, nb, ws: { quarantined: false }, replaying: false, replayEnded: null, docSwitch: null, docSyncNeedsReload: false, replaying: false, replayEnded: null, docSwitch: null, docSyncNeedsReload: false,
      storeFor: async (i) => { if (how === "throws") throw new Error("the test's storage unavailable"); return new W.IdbStore(w.main, i); },
      open: async (s) => { nb.detach(); await s.load(); nb.store = s; } };
    const f = await switchFunctions(deps);
    const r = await f.reopenJournaled();
    check(r === false && nb.store === null && f.shownReadOnly() === true, `switch: a reopen whose store ${how === "throws" ? "can't be made" : "is a plain one"}: false, no store attached, read-only`);
  }
  await close(w);
  hdb.close();
}

async function switchReloadState() {
  // the switch's `reload`: the notebook and the page's controls for it read-only, and said
  const els = { "#ttrepro": { disabled: false }, "#ttclear": { disabled: false }, "#ttrevert": { disabled: false } };
  const nb = pageNb(null);
  const deps = { nb, writerBar: { hidden: true, textContent: "" }, writerBarHeight() {}, writerBarTimer: null, nbName: { readOnly: false }, modeEl: { disabled: false }, $: (q) => els[q], DOC_SYNC_RELOAD: W.DOC_SYNC_RELOAD, current: {}, ws: null, storeFor() {}, open() {}, replaying: false, replayEnded: null, docSwitch: null, docSyncNeedsReload: false };
  const f = await switchFunctions(deps);
  f.docSyncReload();
  check(J(nb.ro) === J([true]) && !deps.writerBar.hidden && deps.writerBar.textContent === W.DOC_SYNC_RELOAD && deps.nbName.readOnly && deps.modeEl.disabled && Object.values(els).every((e) => e.disabled), "switch: reload: the notebook, its name, language, reproducibility and TimeTravel's changes read-only; said in the bar");
}

async function switchReplayOwns() {
  // astra's DEVSW-2-R2: the page's own shownReadOnly and ownNotebook, as index.html has them, with a session being
  // recreated (replaying): read-only whatever else holds; the switch (enableDocSync with the page's functions) waits to
  // own the notebook until the recreation ends: nothing read-only, flushed, activated or reopened meanwhile, and its
  // restore never unlocks the recreation's read-only; a recreation asked while the switch owns it waits for the switch
  const { w, hdb } = await active();
  const { id, st } = await loadNew(w, hdb, [["a", "A"]]);
  let endReplay;
  const nb = pageNb(st);
  const deps = { current: { id, kind: "browser" }, nb, ws: { quarantined: false }, replaying: true, replayEnded: new Promise((r) => { endReplay = r; }), docSwitch: null, docSyncNeedsReload: false, statusEl: { textContent: "" }, journal: { session: null }, DOC_SYNC_RELOAD: W.DOC_SYNC_RELOAD, storeFor: async () => st, open: async () => {} };
  const f = await switchFunctions(deps);
  const ro1 = f.shownReadOnly();
  const log = [];
  const DOC = { on: false, saved: null };
  const switched = W.enableDocSync({ loadHistory: async () => ({ DOC_SYNC: DOC }), makeDocs: () => ({ kick() {} }), makeChannel: () => null, register: W.registerJournalWriter, own: f.ownNotebook, setReadOnly: (r) => { log.push("ro:" + r); nb.setReadOnly(r); }, readOnlyNow: f.shownReadOnly, flush: () => log.push("flush"), saved: async () => {}, activate: async () => { log.push("activate"); return true; }, begun: async () => true, reopen: async () => { log.push("reopen"); return true; }, setDocs: () => log.push("setDocs"), needReload() {}, warn() {} });
  await sleep(100);
  const during = J(log);
  // (the recreation ends as the page's does: replaying false, then its promise resolved)
  deps.replaying = false;
  endReplay();
  const out = await switched;
  check(ro1 === true && during === "[]" && out === "on" && J(log) === J(["ro:true", "flush", "activate", "reopen", "setDocs", "ro:false"]) && deps.docSwitch === null && DOC.on === true,
    "switch: a session being recreated: shownReadOnly read-only; the switch waits for it to end (nothing done meanwhile), then on, and lets the notebook go: " + J({ ro1, during, out, log }));
  // (the switch owning the notebook: the page's recreating (its replay's and recompute's) waits; released, it runs,
  // read-only meanwhile, and sets the read-only back from what holds)
  const release = await f.ownNotebook();
  let replayStarted = false;
  const ro0 = nb.ro.length;
  const replayWaits = f.recreating(async () => { replayStarted = deps.replaying && nb.ro.at(-1) === true; return "ran"; });
  await sleep(50);
  const waited = !replayStarted && nb.ro.length === ro0;
  release();
  const ran = await replayWaits;
  check(waited && replayStarted && ran === "ran" && deps.docSwitch === null && deps.replaying === false && nb.ro.at(-1) === false, "switch: while the switch owns the notebook, the page's recreating waits; released, it runs (read-only meanwhile) and sets the read-only back: " + J({ waited, replayStarted, ran, ro: nb.ro.slice(ro0) }));
  // (a recreation that ends with no store attached: the page's recreating sets the read-only back from shownReadOnly:
  // read-only, nowhere to save)
  const keep = nb.store;
  nb.store = null;
  const ranNoStore = await f.recreating(async () => "ran");
  const roNoStore = nb.ro.at(-1);
  nb.store = keep;
  check(ranNoStore === "ran" && roNoStore === true, "switch: a recreation that ends with no store attached leaves the notebook read-only");
  // (the switch's restore while a recreation still runs (ownership bypassed): read-only kept)
  deps.replaying = true;
  check(f.shownReadOnly() === true, "switch: shownReadOnly with a store, no other tab and no quarantine, but a recreation running: read-only");
  deps.replaying = false;
  DOC.on = false;
  await close(st, w);
  hdb.close();
}

// (f() true within ms)
const until = async (f, ms) => { for (const end = Date.now() + ms; ; await sleep(20)) { if (await f()) return true; if (Date.now() > end) return false; } };
async function switchReloadQueued() {
  // astra's DEVSW-2-R3: a recreation queued behind the switch while the switch ends in `reload` doesn't run, and can't
  // unlock the notebook; the page's own ownNotebook, reopenJournaled, docSyncReload, shownReadOnly and recreating, with
  // enableDocSync, over real stores.  Two ways to reload: (a) the activation done, the reopen failing (no store left
  // attached); (b) the activation begun then refused (the old store kept attached)
  for (const how of ["reopen fails", "activation refused after it began"]) {
    const { w, hdb } = await active();
    const { id, st: seed } = await loadNew(w, hdb, [["a", "A"]]);
    await close(seed);
    const plain = new W.IdbStore(w.main, id);
    await plain.load();
    const nb = pageNb(plain);
    const els = { "#ttrepro": { disabled: false }, "#ttclear": { disabled: false }, "#ttrevert": { disabled: false } };
    let gate, made = null;
    const held = new Promise((r) => { gate = r; });
    const deps = { current: { id, kind: "browser" }, nb, ws: { quarantined: false }, replaying: false, replayEnded: null, docSwitch: null, docSyncNeedsReload: false,
      statusEl: { textContent: "" }, journal: { session: null }, DOC_SYNC_RELOAD: W.DOC_SYNC_RELOAD, writerBar: { hidden: true, textContent: "" }, writerBarHeight() {}, writerBarTimer: null, nbName: { readOnly: false }, modeEl: { disabled: false }, $: (q) => els[q],
      storeFor: async (i) => (made = store(w, hdb, i)),
      open: async (s2) => { nb.detach(); await s2.load(); throw new Error("the test's failed reopen"); } };
    const f = await switchFunctions(deps);
    const DOC = { on: false, saved: null };
    const switched = W.enableDocSync({ loadHistory: async () => ({ DOC_SYNC: DOC }), makeDocs: () => ({ kick() {} }), makeChannel: () => null, register: W.registerJournalWriter, own: f.ownNotebook, setReadOnly: (r) => nb.setReadOnly(r), readOnlyNow: f.shownReadOnly, flush() {}, saved: async () => {},
      activate: async () => { await held; return how === "reopen fails"; }, begun: async () => true, reopen: f.reopenJournaled, setDocs() {}, needReload: f.docSyncReload, warn() {} });
    // (the switch owns the notebook and waits in its activation; a recreation is asked for meanwhile)
    check(await until(() => deps.docSwitch !== null, 3000), `switch reload (${how}): the switch owns the notebook`);
    let ran = false;
    const queued = f.recreating(async () => { ran = true; return "ran"; });
    await sleep(50);
    gate();
    const [out, rec] = await Promise.all([switched, queued]);
    const attached = how === "reopen fails" ? nb.store === null : nb.store === plain;
    check(out === "reload" && rec === null && !ran && deps.replaying === false && nb.ro.at(-1) === true && f.shownReadOnly() === true && deps.docSyncNeedsReload === true && attached && deps.statusEl.textContent === W.DOC_SYNC_RELOAD && deps.writerBar.textContent === W.DOC_SYNC_RELOAD && deps.nbName.readOnly && deps.docSwitch === null,
      `switch reload (${how}): the queued recreation doesn't run; the notebook stays read-only (${how === "reopen fails" ? "no store attached" : "the old store attached"}), reload said: ` + J({ out, rec, ran, ro: nb.ro, attached, status: deps.statusEl.textContent.slice(0, 40) }));
    // (and any recreation asked for later doesn't run either, nor does it unlock it)
    let ran2 = false;
    const rec2 = await f.recreating(async () => { ran2 = true; return "ran"; });
    check(rec2 === null && !ran2 && nb.ro.at(-1) === true && f.shownReadOnly() === true, `switch reload (${how}): a later recreation doesn't run either; still read-only`);
    if (made) await close(made);
    await close(w);
    hdb.close();
  }
}

async function switchActivationFails() {
  // the switch over a real workspace: (1) the history bundle's load rejects: `off`, the journal's activation never
  // begun, DOC_SYNC off, nothing read-only; (2) the activation fails after its first durable write (a fence that can't be
  // written): `reload`, begun and not active (never claimed undone), DOC_SYNC off, no DocSync, read-only and said; the
  // next activation carries it on
  const w = await W.Workspace.open(await named());
  const DOC = { on: false, saved: null };
  const rig = (over) => {
    const t = { ro: [], docs: 0, reload: 0, reopened: 0 };
    return { t, d: { loadHistory: async () => ({ DOC_SYNC: DOC }), makeDocs: () => ({ kick() {} }), makeChannel: () => null, register: W.registerJournalWriter, own: async () => () => {}, setReadOnly: (r) => t.ro.push(r), readOnlyNow: () => false, flush() {}, saved: async () => {}, activate: () => w.activateJournal(), begun: () => w.journalBegun(), reopen: async () => { t.reopened++; return true; }, setDocs: () => { t.docs++; }, needReload: () => { t.reload++; }, warn() {}, ...over } };
  };
  const a = rig({ loadHistory: async () => { throw new Error("the test's failed history load"); } });
  const outA = await W.enableDocSync(a.d);
  check(outA === "off" && !(await w.journalBegun()) && !(await w.journalActive()) && DOC.on === false && a.t.ro.length === 0 && a.t.docs === 0, "switch: the history bundle's load fails: off, the journal's activation never begun, DOC_SYNC off, nothing read-only: " + J({ outA, ro: a.t.ro }));
  w.writeFence = async () => { throw new Error("the test's fence that can't be written"); };
  const b = rig({});
  const outB = await W.enableDocSync(b.d);
  const begun = await w.journalBegun(), act = await w.journalActive();
  check(outB === "reload" && begun && !act && DOC.on === false && DOC.saved === null && b.t.docs === 0 && b.t.reopened === 0 && J(b.t.ro) === J([true, true]) && b.t.reload === 1, "switch: the activation fails after its first durable write: reload (begun, not active, never claimed undone), DOC_SYNC off, no DocSync, read-only and said: " + J({ outB, begun, act, ro: b.t.ro }));
  delete w.writeFence;
  const c = rig({});
  const outC = await W.enableDocSync(c.d);
  check(outC === "on" && (await w.journalActive()) && DOC.on === true && c.t.docs === 1 && J(c.t.ro) === J([true, false]), "switch: …the next load's activation carries it on: on");
  DOC.on = false;
  w.close();
}

const CASES = [inactive, saves, replayModel, tracesNormal, tracesPaused, crashPoints, atCapacity, noIntentProducers, catchUpInterleaved, pruneAndConcurrency, oldCodeWrite, budgetsAndDrop, backlogFull, fencedWrites, dropRefused, oneWriter, takeoverRace, killedHolder, noWebLocks, lockOrderings, takeoverRefusesTheViewersState, controls, kindLaw, pageStartHistory, viewerHistoryWrites, takeoverFails, takeoverFailsInRecovery, releaseWaitsForLoad, lifetimeP1P2, clearCheckedAtItsTurn, reloadFails, fallbackSaves, coalescedVersions, markRule, markTable, lifetimeWithMarks, clearAgainstTheProof, reloadDuringClear, syncStart, syncStartAtomic, syncDebt, syncRotation, syncIdentity, syncGrantDuringLoad, syncWireRows, switchReopenFails, switchReopenOk, switchReopenNoStore, switchReloadState, switchActivationFails, switchReplayOwns, switchReloadQueued];
export async function run() {
  for (const c of CASES) {
    console.log("test: " + c.name);
    try {
      await c();
    } catch (e) {
      check(false, `${c.name} threw: ${e?.stack ?? e}`);
    }
    W.JOURNAL_TX_HOOK.beforeTx = undefined;
  }
  return results;
}
