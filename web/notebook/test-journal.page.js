// The cases of web/notebook/test-journal.mjs, run in the page (real IndexedDB and Web Locks): the notebook journal's
// core (journal.js).  W the workspace, N the journal, H the notebook's history (history.js), R sync's rows.  Each case
// has a workspace of its own; the notebooks' history is one database for the whole origin, its fence dropped before
// each case (in a browser there is only ever one workspace), and each case's notebooks have ids of their own.
import { W, N, H, R, B } from "./all.js";

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
    const j = rows.find((x) => x.nb === R.SYNC_NB + r.v.h && x.time === "j");
    measured += R.rowCharge([r.nb, r.time], { h: r.v.h, meta: r.v.meta }) + (j ? R.rowCharge([j.nb, j.time], j.v) : 0);
  }
  return { meta, pend, counted, measured };
}
const close = (...xs) => { for (const x of xs) try { x?.history?.close?.(); x?.close?.(); } catch {} };


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
  close(st, w);
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
  close(st, w);
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
    close(r.st);
    const r2 = await reopen(w, hdb, id), p2 = await persisted(w, hdb, id);
    close(r2.st);
    check(r.row === rowWant && p.codes === want && p.hashOk && p.jOk && p.intents === 0 && r2.row === "consistent" && p2.codes === want, `${what}${tag}: ${r.row}, the document ${p.codes}, hash and j right, nothing left; reopened again, consistent`);
  };
  // the original: an outputs-only save (rev 2), then a stale edit refused: A stays
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    if (paused) await pause(st);
    const d2 = await outputsOnly(st, d);
    const c = await st.save({ ...d2, cells: [{ id: "a", code: "C" }], baseRev: d.rev });
    close(st);
    check(!!c?.conflict, "the stale edit is refused" + tag);
    await check2(id, J([["a", "A"]]), "stamped", "astra's original: the stale edit never becomes the document");
  }
  // repeated stale saves
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    if (paused) await pause(st);
    const d2 = await outputsOnly(st, d);
    for (const x of ["C1", "C2"]) await st.save({ ...d2, cells: [{ id: "a", code: x }], baseRev: d.rev });
    close(st);
    await check2(id, J([["a", "A"]]), "stamped", "repeated stale saves");
  }
  // an isolated interrupted save: the whole B written (astra's 1c)
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    if (paused) await pause(st);
    await t1Only(st, { ...d, cells: [{ id: "a", code: "B" }], baseRev: d.rev });
    close(st);
    await check2(id, J([["a", "B"]]), "rewritten", "an isolated interrupted save: the whole B written");
  }
  // 1a: B interrupted, then a stale C refused: B
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    if (paused) await pause(st);
    const d2 = await outputsOnly(st, d);
    await t1Only(st, { ...d2, cells: [{ id: "a", code: "B" }], baseRev: d2.rev });
    const c = await st.save({ ...d2, cells: [{ id: "a", code: "C" }], baseRev: d.rev });
    close(st);
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
    close(st);
    check(!!c?.conflict && r.j !== undefined, "1b: the stale B refused, the identical retry's T1 an intent of its own" + tag);
    await check2(id, J([["a", "B"]]), "rewritten", "1b: the identical retry, interrupted, is the document");
  }
  close(w);
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
  close(st);
  const mid = await jState(hdb, id);
  check(!!t2?.saved && mid.intents.length === 2, "crash after the outcome's T2, before its prune: the record holds B, both intents left");
  const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
  close(r.st);
  check(r.row === "stamped" && p.codes === J([["a", "B"]]) && p.hashOk && p.jOk && p.intents === 0, "…reopened: B stays, j and hash right, the intents pruned: " + J({ row: r.row, codes: p.codes }));
  const r2 = await reopen(w, hdb, id);
  close(r2.st);
  check(r2.row === "consistent", "…after the prune, consistent");
  close(w);
  hdb.close();
}

async function atCapacity() {
  // design r4 §3.4: recovery adds no intent, so it progresses with the intents at their bound or the budget full
  const { w, hdb } = await active();
  for (const valid of [false, true]) {
    for (const paused of [false, true]) {
      const tag = `${valid ? "an interrupted B, then " : ""}${N.MAX_INTENTS} stale intents${paused ? " (paused)" : ""}`;
      const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
      if (paused) await pause(st);
      const d2 = await outputsOnly(st, d);
      if (valid) await t1Only(st, { ...d2, cells: [{ id: "a", code: "B" }], baseRev: d2.rev });
      let refused = null;
      for (let i = 0; i < N.MAX_INTENTS + 1 && !refused; i++) {
        const out = await st.save({ ...d2, cells: [{ id: "a", code: "C" + i }], baseRev: d.rev });
        if (typeof out === "string") refused = out;
      }
      const js = await jState(hdb, id);
      close(st);
      check(refused && /too many saves/.test(refused) && js.intents.length === N.MAX_INTENTS, `${tag}: the next save refused, said, nothing written: ${refused}`);
      const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
      const want = valid ? J([["a", "B"]]) : J([["a", "A"]]);
      check(r.row === (valid ? "rewritten" : "stamped") && p.codes === want && p.hashOk && p.jOk && p.intents === 0, `…reopened at capacity: ${r.row}, the document ${p.codes}, every intent pruned`);
      const again = await r.st.save({ ...r.d, cells: [{ id: "a", code: "after" }], baseRev: r.d.rev });
      check(!!again?.saved, "…and the next save is taken");
      close(r.st);
    }
  }
  // the pending budget full: a save refused; recovery still completes, and its prune makes room
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const d2 = await outputsOnly(st, d);
    await t1Only(st, { ...d2, cells: [{ id: "a", code: "B" }], baseRev: d2.rev });
    const keep = N.JOURNAL_BUDGETS.pendingAll;
    N.JOURNAL_BUDGETS.pendingAll = (await recount(hdb)).counted.pend;
    const out = await st.save({ ...d2, cells: [{ id: "a", code: "C" }], baseRev: d2.rev });
    close(st);
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    N.JOURNAL_BUDGETS.pendingAll = keep;
    check(typeof out === "string" && /too large to keep/.test(out) && r.row === "rewritten" && p.codes === J([["a", "B"]]) && p.intents === 0, "the pending budget full: a save refused; recovery completes all the same (B), its prune freeing the room: " + out);
    close(r.st);
  }
  close(w);
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
    close(st);
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    close(r.st);
    check(r.row === "rewritten" && p.codes === J([["a", "X"]]) && p.jOk, "an interrupted save, then an execution-journal version: X is the document");
  }
  // a TimeTravel clear's re-record of another value
  {
    const { id, st, d } = await make();
    await st.history.clear({ ...d, cells: [{ id: "a", code: "the clear's" }] });
    await st.patches.appending;
    close(st);
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    close(r.st);
    check(r.row === "rewritten" && p.codes === J([["a", "X"]]) && p.jOk && p.hashOk, "…then a TimeTravel clear's re-record: X, never the re-recorded value");
  }
  // Resume from here's copy (index.html: the rows copied to a new id), and an import (bundle.js keepBundle)
  {
    const { id, st } = await make();
    close(st);
    const rows = await histRows(hdb, id), copy = newId(), imported = newId();
    for (const row of rows) await rawPut(hdb, "history", { nb: copy, time: row.time, env: row.env });
    await B.keepBundle({ history: rows.map((r) => r.env), blobs: {} }, imported, { hdb });
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    close(r.st);
    const jc = await jState(hdb, copy), ji = await jState(hdb, imported);
    check(r.row === "rewritten" && p.codes === J([["a", "X"]]) && jc.intents.length === 0 && ji.intents.length === 0 && jc.J === 0 && ji.J === 0, "…a Resume copy and an import of its rows: X stays, and neither copy has an intent or a j");
  }
  close(w);
  hdb.close();
}

async function catchUpInterleaved() {
  // the catch-up's committed j is the record's, whatever else was appended meanwhile (both reviewers)
  const { w, hdb } = await active();
  const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
  const d2 = await outputsOnly(st, d);
  await st.save({ ...d2, cells: [{ id: "a", code: "C" }], baseRev: d.rev });
  close(st);
  // (another history of the same notebook, open first, appends an execution-journal version while the catch-up waits)
  const other = store(w, hdb, id);
  await other.open();
  W.JOURNAL_TX_HOOK.beforeTx = async () => {
    W.JOURNAL_TX_HOOK.beforeTx = undefined;
    other.history.journal([{ type: "run", id: "s:9", sid: "s", n: 9, t: 9 }]);
    await other.patches.appending;
  };
  const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
  W.JOURNAL_TX_HOOK.beforeTx = undefined;
  close(r.st);
  close(other);
  const r2 = await reopen(w, hdb, id);
  close(r2.st);
  check(r.row === "stamped" && r.catchUp !== null && p.codes === J([["a", "A"]]) && p.jOk && r2.row === "consistent", "a version appended while the catch-up waited: the record takes the catch-up's committed j, and reopens consistent: " + J({ catchUp: r.catchUp, j: p.rec.j, J: p.js.J }));
  close(w);
  hdb.close();
}

async function oldCodeWrite() {
  // a page from before the journal saved (its record's j and hash stale): the record's own value, stamped
  const { w, hdb } = await active();
  const { id, st } = await loadNew(w, hdb, [["a", "1"]]);
  close(st);
  const rec0 = await rawGet(w.main, "notebooks", id);
  await rawPut(w.main, "notebooks", { ...rec0, cells: [{ id: "a", code: "an old page's save" }], rev: rec0.rev + 1 });
  const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
  close(r.st);
  check(r.row === "stamped" && p.codes === J([["a", "an old page's save"]]) && p.hashOk && p.jOk && p.rec.hash !== rec0.hash, "an old page's save (stale j and hash): its value stamped, with its own hash: " + r.row);
  close(w);
  hdb.close();
}

async function budgetsAndDrop() {
  const { w, hdb } = await active();
  const before = J(await syncRows(hdb)), keep = N.JOURNAL_BUDGETS.metaAll;
  N.JOURNAL_BUDGETS.metaAll = (await recount(hdb)).counted.meta + 10;
  const id = newId(), st = store(w, hdb, id, doc([["a", "1"]]));
  const why = await st.load().then(() => null, (e) => e?.message ?? String(e));
  N.JOURNAL_BUDGETS.metaAll = keep;
  check(why !== null && /too many documents/.test(why) && J(await syncRows(hdb)) === before && (await rawGet(w.main, "notebooks", id)) === undefined && (await histRows(hdb, id)).length === 0, "the metadata budget full: refused, said, nothing written: " + why);
  close(st);
  // a dropped notebook's journal rows go with it (its intents too), their charges released
  const { id: id2, st: st2, d: d2 } = await loadNew(w, hdb, [["a", "1"]]);
  await st2.save({ ...d2, cells: [{ id: "a", code: "stale" }], baseRev: d2.rev - 1 });
  const c0 = await recount(hdb), reg = (await syncRows(hdb)).find((r) => r.time === "d:local:" + id2), pend0 = (await jState(hdb, id2)).intents.length;
  await st2.patches.drop();
  const c1 = await recount(hdb), left = (await syncRows(hdb)).filter((r) => r.nb === R.SYNC_NB + reg.v.h || r.time === "d:local:" + id2);
  check(reg && pend0 === 1 && left.length === 0 && (await histRows(hdb, id2)).length === 0 && c1.counted.meta === c0.counted.meta - reg.v.meta && c1.meta === c1.counted.meta && c1.pend === c1.counted.pend && c1.counted.pend < c0.counted.pend, "a drop deletes the document's journal rows and intents with its versions, releasing their charges");
  // the workspace's dropContents (emptying Trash) the same
  const { id: id4, st: st4 } = await loadNew(w, hdb, [["a", "1"]]);
  close(st4);
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
  close(st2, st3, w);
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
    close(st);
  }
  close(w);
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
    close(st);
  }
  close(w);
  hdb.close();
}

async function dropRefused() {
  // a drop whose journal rows can't be dropped (daybreak3's CORR-208-DAYBREAK3-3): it ends at once, refused, and
  // nothing of it is done
  const { w, hdb } = await active();
  const { id, st } = await loadNew(w, hdb, [["a", "1"]]);
  close(st);
  const rows = J(await histRows(hdb, id)), sync = J(await syncRows(hdb));
  const bad = new W.IdbPatchStore(hdb, id, { journal: { t1: () => Promise.resolve({ refused: "no" }), drop: () => Promise.reject(new Error("the test's refusal")) } });
  const r = await within(bad.drop(), 3000);
  check(r !== "timeout" && r.e && /couldn't be dropped/.test(r.e.message) && J(await histRows(hdb, id)) === rows && J(await syncRows(hdb)) === sync, "a drop whose journal rows can't be dropped: refused at once (" + (r === "timeout" ? "timeout" : r.e?.message) + "), its versions and journal rows untouched");
  close(w);
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
    close(st);
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    close(r.st);
    check(J(left) === J([y.j]) && r.row === "rewritten" && p.codes === J([["a", "Y"]]) && p.intents === 0, "a save's prune takes only intents at or below its j: the next save's intent stays, and, its T2 interrupted, is recovered: " + J({ left, row: r.row, codes: p.codes }));
  }
  // an intent at or below the record's j (a prune that hadn't run) never decides, whatever its srev
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const k = await N.writeIntent(st.patches, { srev: d.rev + 1, value: st.textOf({ ...d, cells: [{ id: "a", code: "never" }] }) });
    const dd = { ...d, cells: [{ id: "a", code: "A" }] };
    await W.IdbStore.prototype.save.call(st, { ...dd, baseRev: d.rev }, { journal: { j: k.j, hash: await N.docHash(dd) } });
    close(st);
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    close(r.st);
    check(r.row === "consistent" && p.codes === J([["a", "A"]]), "an intent at or below the record's j, its srev the record's revision, decides nothing: " + J({ row: r.row, codes: p.codes }));
  }
  // recovery's T2 is conditional on the record's revision: a save that lands while it runs wins, and recovery replays
  // again from it
  {
    const { id, st, d } = await loadNew(w, hdb, [["a", "A"]]);
    const d2 = await outputsOnly(st, d);
    await st.save({ ...d2, cells: [{ id: "a", code: "C" }], baseRev: d.rev });
    close(st);
    const other = store(w, hdb, id);
    await other.open();
    W.JOURNAL_TX_HOOK.beforeTx = async () => {
      W.JOURNAL_TX_HOOK.beforeTx = undefined;
      await other.save({ ...d2, cells: [{ id: "a", code: "D, saved meanwhile", outputs: [{ text: "o" }] }], baseRev: d2.rev });
    };
    const r = await reopen(w, hdb, id), p = await persisted(w, hdb, id);
    W.JOURNAL_TX_HOOK.beforeTx = undefined;
    close(r.st, other);
    check(p.codes === J([["a", "D, saved meanwhile"]]) && p.hashOk && p.jOk && codes(r.d) === p.codes, "a save that lands while recovery runs wins (recovery's T2 conditional on the revision it read), and recovery replays from it: " + J({ row: r.row, codes: p.codes }));
  }
  close(w);
  hdb.close();
}

const CASES = [inactive, saves, replayModel, tracesNormal, tracesPaused, crashPoints, atCapacity, noIntentProducers, catchUpInterleaved, pruneAndConcurrency, oldCodeWrite, budgetsAndDrop, backlogFull, fencedWrites, dropRefused];
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
