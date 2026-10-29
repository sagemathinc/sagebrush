// The cases of web/board/test-board-journal.mjs, run in the page (real IndexedDB and Web Locks): the board journal
// (journal.ts, Workspace.journalWrite).  W the workspace, A its api.ts, BJ the
// board journal, BH the board's history, H the history's bundle (web/notebook/history.js), R the journal's rows,
// S the stores.  Each case has a workspace of its own and boards of its own; the boards' history is one database for
// the whole origin, its fence dropped before each case (in a browser there is only ever one workspace).
import { W, A, BJ, BH, H, R, S, SR } from "./all.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const J = JSON.stringify;
const FENCE = "__sagebrush-workspace__";
const canon = (x) => JSON.stringify(x, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const rawGet = (db, store, key) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const rawPut = (db, store, value) => new Promise((ok, no) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(value); tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); });
const rawDel = (db, store, key) => new Promise((ok, no) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).delete(key); tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); });
const rawAll = (db, store, range) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAll(range); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
let n = 0, k = 0;
const named = async () => {
  n++;
  localStorage.clear();
  for (const h of [await W.openHistoryDb(), await W.openBoardHistoryDb()]) if (h) { await rawDel(h, "history", [FENCE, ""]).catch(() => {}); h.close(); }
  return { name: `bj-${n}`, mainName: `mainbj-${n}` };
};
// (a workspace of this case's, the journal active in it, and the boards' history)
async function active() {
  const w = await W.Workspace.open(await named());
  W.registerJournalWriter("notebooks");
  W.registerJournalWriter("boards");
  await w.activateJournal();
  return { w, hdb: await W.openBoardHistoryDb() };
}
// (the journal's classes over this page's stores, as the board page makes them)
const KIT = H.journalStoreClasses({ IdbStore: BJ.BoardRecordStore, IdbPatchStore: W.IdbPatchStore }, BJ.boardKind);
const store = (w, hdb, ref) => new KIT.JournalStore(w, hdb, BJ.journalId(ref), null, H);
const kind = BJ.boardKind(H);
const hashOf = (d) => H.hashOf(kind, d);
const board = (text, extra = {}) => ({ title: "t", nodes: [{ id: "n", x: 0, y: 0, text }], ...extra });
const textOf = (d) => d?.nodes?.[0]?.text;
// (a board of the workspace, made as any other: an old-style row)
async function made(w, d = board("A")) { k++; const e = await w.create(`/b${k}.board.json`, { content: d }); return { ref: e.ref, path: e.path }; }
const row = (w, ref) => rawGet(w.ws, "boards", ref);
const jState = (hdb, ref) => R.readJournal(hdb, BJ.journalId(ref));
const STORE = ["rev", "j", "hash", "unjournaled", "stampOf", "baseRev"];
const ENV = ["j", "hash", "unjournaled", "stampOf"];
// (the row's invariant: an old-style row, or a whole envelope; the journal's fields never in the document)
const coherent = (r) => !!r && !STORE.some((f) => r.doc && f in r.doc) && (ENV.every((f) => !(f in r)) || (Number.isSafeInteger(r.j) && r.j >= 0 && typeof r.hash === "string" && (!("unjournaled" in r) || r.unjournaled === true || r.unjournaled === "too-large") && (!("stampOf" in r) || (Number.isSafeInteger(r.stampOf) && r.stampOf === r.rev - 1))));
const oldStyle = (r) => !!r && ENV.every((f) => !(f in r));
const close = async (...xs) => { for (const x of xs) try { if (x?.release) await x.release(); else x?.close?.(); } catch {} };
const outcome = (p) => p.then((v) => ({ v }), (e) => ({ e: String(e?.message ?? e) }));
// (writes into the stores named refused as out of room while `f` runs)
async function noRoom(names, f) {
  const put = IDBObjectStore.prototype.put, set = new Set([names].flat());
  IDBObjectStore.prototype.put = function (...a) {
    if (!set.has(this.name)) return put.apply(this, a);
    throw new DOMException("out of room (the test's)", "QuotaExceededError");
  };
  try { return await f(); } finally { IDBObjectStore.prototype.put = put; }
}
// (the pending budget's bytes as charged now)
async function pendingBytes(hdb) {
  const rows = await rawAll(hdb, "history", IDBKeyRange.bound([SR.SYNC_NB, ""], [SR.SYNC_NB, "￿"]));
  return rows.find((r) => r.time === "b:p:local")?.v?.bytes ?? 0;
}

async function saves() {
  const { w, hdb } = await active();
  const { ref } = await made(w);
  check((() => { try { new BJ.BoardRecordStore(w, "board:local:nope", null); return false; } catch (e) { return e instanceof TypeError; } })(), "a board journal's id is board:local:<ref>, else refused");
  const st = store(w, hdb, ref);
  const d = await st.load();
  const r0 = await row(w, ref);
  // test 4: stamped by the load, before any edit
  check(st.recovered.row === "stamped" && Number.isSafeInteger(r0.j) && r0.j > 0 && r0.hash === (await hashOf(r0.doc)) && !("unjournaled" in r0) && textOf(r0.doc) === "A" && coherent(r0) && (await jState(hdb, ref)).intents.length === 0, "test 4: an old-style row is stamped by the first journaled load, before any edit: " + J({ row: st.recovered.row, j: r0.j }));
  check(textOf(d) === "A" && st.history.versions().length === 1, "…its value kept as one version (the load's catch-up)");
  // test 1: T1, then T2, then the prune
  const out = await st.save({ ...board("B"), baseRev: d.rev }, { tag: "s:1:" + d.rev });
  const r1 = await row(w, ref), js1 = await jState(hdb, ref);
  check(out?.saved === true && out.rev === d.rev + 1 && r1.rev === out.rev && textOf(r1.doc) === "B" && r1.hash === (await hashOf(board("B"))) && r1.j === js1.J && js1.intents.length === 0 && r1.tag === "s:1:" + d.rev && coherent(r1), "test 1: a save: T1, then T2 (the row's doc, rev, j, hash and tag), its intent pruned: " + J({ out, j: r1.j, J: js1.J }));
  // killed between T1 and T2: the next load replays the intent
  await st.t1({ ...board("C"), baseRev: r1.rev });
  check((await jState(hdb, ref)).intents.length === 1 && (await row(w, ref)).rev === r1.rev, "test 1: T1 alone (the tab gone before T2): its intent written, the row as it was");
  await close(st);
  const st2 = store(w, hdb, ref), d2 = await st2.load(), r2 = await row(w, ref);
  check(textOf(d2) === "C" && textOf(r2.doc) === "C" && st2.recovered.row === "rewritten" && (await jState(hdb, ref)).intents.length === 0 && r2.hash === (await hashOf(board("C"))) && coherent(r2), "test 1: …the next load replays the intent: the board is the save: " + J({ row: st2.recovered.row, text: textOf(d2) }));
  // test 2: every version a save's (its j), and reopening adds none
  const vs = st2.history.versions(), jOf = (await jState(hdb, ref)).jOf;
  check(vs.length === 3 && vs.every((v) => jOf.has(v.time)), "test 2: every version is a save's or the stamp's, each with its j: " + J({ n: vs.length, withJ: vs.filter((v) => jOf.has(v.time)).length }));
  await close(st2);
  const st3 = store(w, hdb, ref);
  await st3.load();
  check(st3.history.versions().length === vs.length && st3.recovered.row === "consistent", "test 2: reopening adds no version, the row consistent: " + J({ n: st3.history.versions().length, row: st3.recovered.row }));
  // test 2b: an old-style row opened, then edited once: 2 versions, as on master
  const b = await made(w, board("before")), s4 = store(w, hdb, b.ref), d4 = await s4.load();
  await s4.save({ ...board("after"), baseRev: d4.rev });
  const v4 = s4.history.versions();
  check(v4.length === 2 && textOf(s4.history.docAt(v4[0].time)) === "before" && textOf(s4.history.docAt(v4[1].time)) === "after", "test 2b: an old-style row opened, then edited once: 2 versions, before and after");
  // test 7 through a store: the record (its own fields beside the document) and the document have one text
  const rec = await s4.loadRecord();
  check("rev" in rec && "j" in rec && s4.textOf(rec) === s4.textOf(board("after")) && (await hashOf(rec)) === (await hashOf(board("after"))), "test 7: loadRecord's record and the plain document: one text, one hash");
  // test 11 (store's part): a T2 the browser refuses is no save
  const r4 = await row(w, b.ref);
  const refused = await outcome(noRoom(["boards"], () => s4.save({ ...board("lost"), baseRev: r4.rev })));
  check((refused.e || typeof refused.v === "string") && J(await row(w, b.ref)) === J(r4), "test 11: a T2 the browser refuses: not saved (refused), the row as it was: " + J(refused));
  await close(st3, s4);
  w.close();
  hdb.close();
}

async function conflicts() {
  const { w, hdb } = await active();
  const { ref, path } = await made(w);
  const st = store(w, hdb, ref), d = await st.load();
  // an ordinary write (an agent's) drops the envelope
  await w.write(path, board("other"), {});
  const r0 = await row(w, ref);
  check(oldStyle(r0) && textOf(r0.doc) === "other" && r0.rev === d.rev + 1, "an ordinary write leaves an old-style row (its envelope dropped)");
  // test 3: a stale base
  const out = await st.save({ ...board("mine"), baseRev: d.rev });
  check(!!out?.conflict && textOf(out.conflict) === "other" && out.conflict.rev === r0.rev && J(await row(w, ref)) === J(r0), "test 3: a stale base: {conflict} with the record as it is, nothing written: " + J(out));
  // test 4b: the next load stamps the ordinary writer's value; no older intent replays over it
  await close(st);
  const s2 = store(w, hdb, ref), d2 = await s2.load(), r2 = await row(w, ref);
  check(textOf(d2) === "other" && textOf(r2.doc) === "other" && Number.isSafeInteger(r2.j) && coherent(r2) && s2.recovered.row === "stamped" && (await jState(hdb, ref)).intents.length === 0, "test 4b: an ordinary write between journaled saves: the next load stamps its value, no older intent replayed: " + J({ row: s2.recovered.row, text: textOf(d2) }));
  // test 3a: the Base's contract, against journalWrite
  const r = await row(w, ref);
  const stale = await w.journalWrite(ref, { ...board("x"), baseRev: r.rev }, { journal: { j: r.j - 1, hash: "h" } });
  check(!!stale?.conflict && J(await row(w, ref)) === J(r), "test 3a: a T2 with an older j: {conflict}, the row never moves back");
  const hk = await hashOf(board("k"));
  const kept = await w.journalWrite(ref, { ...board("k"), baseRev: r.rev }, { journal: { keep: true, hash: hk, unjournaled: true } });
  const rk = await row(w, ref);
  check(kept?.saved === true && rk.j === r.j && rk.hash === hk && rk.unjournaled === true && textOf(rk.doc) === "k" && rk.rev === r.rev + 1, "test 3a: keep: the stored j kept, the value and mark written");
  const hm = await hashOf(board("m"));
  await w.journalWrite(ref, { ...board("m"), baseRev: rk.rev }, { journal: { j: rk.j, hash: hm } });
  const before = await row(w, ref);
  const marked = await w.journalWrite(ref, before.doc, { journal: { keep: true, hash: before.hash, unjournaled: true, markOnly: true } });
  const after = await row(w, ref);
  check(marked?.marked === true && !("unjournaled" in before) && J(after) === J({ ...before, unjournaled: true }), "test 3a: markOnly: the mark alone (doc, rev, updated and tag as they were)");
  check((await w.journalWrite(ref, before.doc, { journal: { hash: 1 } })) === A.BOARD_NOT_JOURNALED && (await w.journalWrite(ref, before.doc, { journal: { j: 1, hash: "h", markOnly: true } })) === A.BOARD_NOT_JOURNALED, "test 3a: a journal word that isn't one: refused");
  // test 3b: the entry's step failing after the board's committed: kept all the same, said as late
  const e0 = await rawGet(w.ws, "entries", path);
  A.BOARD_JOURNAL_HOOK.afterBoards = async (x) => { if (x === ref) await rawPut(w.ws, "entries", { ...e0, ref: "000000000000" }); };
  const cur = await row(w, ref);
  const late = await s2.save({ ...board("late"), baseRev: cur.rev });
  A.BOARD_JOURNAL_HOOK.afterBoards = undefined;
  const rl = await row(w, ref);
  await rawPut(w.ws, "entries", e0);
  check(late?.saved === true && typeof late.late === "string" && late.rev === cur.rev + 1 && rl.rev === late.rev && textOf(rl.doc) === "late" && coherent(rl), "test 3b: the entry's step fails after the board's T2: {saved, rev, late}, the row kept: " + J(late));
  const next = await s2.save({ ...board("next"), baseRev: late.rev });
  const e1 = await rawGet(w.ws, "entries", path);
  check(next?.saved === true && e1.updated >= e0.updated && e1.ref === ref, "test 3b: …the next save, on the rev it gave, is no conflict, and updates the entry");
  await close(s2);
  w.close();
  hdb.close();
  // the phase: no journal T2 in a workspace whose journal isn't active
  const w2 = await W.Workspace.open(await named());
  const m2 = await made(w2);
  check((await w2.journalWrite(m2.ref, { ...board("x"), baseRev: 1 }, { journal: { j: 1, hash: "h" } })) === A.BOARD_NOT_JOURNAL_PHASE && oldStyle(await row(w2, m2.ref)), "a journal T2 where the journal isn't active: refused, nothing written");
  w2.close();
}

async function markRaces() {
  const { w, hdb } = await active();
  // the control: no pause, the row marked, nothing else; the clear runs; the next save unmarks it
  {
    const { ref } = await made(w), st = store(w, hdb, ref), d = await st.load();
    await st.save({ ...board("B"), baseRev: d.rev });
    let seen = null;
    A.BOARD_JOURNAL_HOOK.beforeLock = async (x, word) => { if (x === ref && word.markOnly) seen = await row(w, ref); };
    await st.history.clear();
    A.BOARD_JOURNAL_HOOK.beforeLock = undefined;
    const r = await row(w, ref);
    check(!!seen && J(r) === J({ ...seen, unjournaled: true }) && st.history.versions().length === 0, "test 3c control: no pause: the row marked, nothing else changed; the versions cleared");
    const after = await st.save({ ...board("C"), baseRev: r.rev }), r2 = await row(w, ref);
    check(after?.saved === true && !("unjournaled" in r2) && coherent(r2), "test 3c control: …the next save unmarks it by its proof");
    await close(st);
  }
  // test 3c: an ordinary write, or a retitle, between markRecord's read and its transaction
  for (const how of ["write", "retitle"]) {
    k++;
    const name = `rt${k}`, p = `/${name}.board.json`;
    const e = await w.create(p, { content: { title: name, nodes: [{ id: "n", text: "A" }] } }), ref = e.ref;
    const st = store(w, hdb, ref), d = await st.load();
    await st.save({ title: name, nodes: [{ id: "n", text: "B" }], baseRev: d.rev });
    let raw = null;
    A.BOARD_JOURNAL_HOOK.beforeLock = async (x, word) => {
      if (x !== ref || !word.markOnly) return;
      A.BOARD_JOURNAL_HOOK.beforeLock = undefined;
      if (how === "write") await w.write(p, { title: name, nodes: [{ id: "n", text: "raw" }] }, {});
      else await w.rename(p, `/${name}x.board.json`, { retitle: true });
      raw = await row(w, ref);
    };
    const cleared = await outcome(st.history.clear());
    A.BOARD_JOURNAL_HOOK.beforeLock = undefined;
    const r = await row(w, ref);
    const changed = how === "write" ? textOf(raw?.doc) === "raw" : raw?.doc?.title === name + "x";
    check(!!raw && changed && oldStyle(raw) && J(r) === J(raw) && !cleared.e, `test 3c (${how} in the pause): the row stays as the raw writer left it (doc, rev, updated, tag), old-style, no lone mark; the clear ran: ` + J({ r, cleared }));
    const s = await st.save({ ...r.doc, nodes: [{ id: "n", text: "after" }], baseRev: r.rev });
    await close(st);
    const s2 = store(w, hdb, ref);
    await s2.load();
    const r3 = await row(w, ref);
    check(s?.saved === true && coherent(r3) && Number.isSafeInteger(r3.j) && textOf(r3.doc) === "after", `test 3c (${how}): …a later save and reload: a coherent envelope`);
    await close(s2);
  }
  // test 3d: another journaled T2 (another hash) in the pause: markOnly refused, the clear never runs
  {
    const { ref } = await made(w), st = store(w, hdb, ref), d = await st.load();
    await st.save({ ...board("B"), baseRev: d.rev });
    let other = null;
    A.BOARD_JOURNAL_HOOK.beforeLock = async (x, word) => {
      if (x !== ref || !word.markOnly) return;
      A.BOARD_JOURNAL_HOOK.beforeLock = undefined;
      const cur = await row(w, ref);
      await w.journalWrite(ref, { ...board("other T2"), baseRev: cur.rev }, { journal: { j: cur.j, hash: await hashOf(board("other T2")) } });
      other = await row(w, ref);
    };
    const v0 = st.history.versions().length;
    const cleared = await outcome(st.history.clear());
    A.BOARD_JOURNAL_HOOK.beforeLock = undefined;
    const r = await row(w, ref);
    check(!!other && (cleared.e ?? "").includes("changed while its versions were being cleared") && J(r) === J(other) && !("unjournaled" in r) && (await rawAll(hdb, "history", IDBKeyRange.bound([BJ.journalId(ref), ""], [BJ.journalId(ref), "￿"]))).length >= v0, "test 3d: a changed proof in the pause: markOnly refused, the clear not run, the row and versions as they were: " + J({ cleared, v0 }));
    await close(st);
  }
  w.close();
  hdb.close();
}

async function fallbacks() {
  const { w, hdb } = await active();
  const { ref } = await made(w), st = store(w, hdb, ref), d = await st.load();
  // test 5: no room for T1: the row written all the same, marked, said
  await st.t1({ ...board("B"), baseRev: d.rev });
  const keep = R.JOURNAL_BUDGETS.pendingAll;
  R.JOURNAL_BUDGETS.pendingAll = await pendingBytes(hdb);
  const out = await st.save({ ...board("C"), baseRev: d.rev }).finally(() => { R.JOURNAL_BUDGETS.pendingAll = keep; });
  const r = await row(w, ref);
  check(out?.saved === st.T.SAVED_UNJOURNALED && /board/.test(out.saved) && r.unjournaled === true && textOf(r.doc) === "C" && coherent(r), "test 5: no room for T1: SAVED_UNJOURNALED (it says board), the row marked: " + J({ saved: out?.saved, mark: r.unjournaled }));
  // past neverFits: too large ever to be a version
  const keepB = S.HISTORY_BACKLOG.bytes;
  S.HISTORY_BACKLOG.bytes = 8192;
  const big = await st.save({ ...board("x".repeat(6000)), baseRev: r.rev }).finally(() => { S.HISTORY_BACKLOG.bytes = keepB; });
  const rb = await row(w, ref);
  check(big?.saved === st.T.SAVED_TOO_LARGE && /board/.test(big.saved) && rb.unjournaled === "too-large" && coherent(rb), "test 5: too large ever to be a version: SAVED_TOO_LARGE (it says board), marked too-large: " + J({ saved: big?.saved, mark: rb.unjournaled }));
  await close(st);
  w.close();
  hdb.close();
}

async function deletion() {
  const { w, hdb } = await active();
  const { ref, path } = await made(w), st = store(w, hdb, ref), d = await st.load();
  await st.save({ ...board("B"), baseRev: d.rev });
  await st.t1({ ...board("C"), baseRev: d.rev + 1 });
  await close(st);
  const pre = BJ.journalId(ref);
  // (a version from before the journal, under the document's own name)
  await rawPut(hdb, "history", { nb: pre + ":0123456789abcdef0123456789abcdef", time: "legacy", env: { time: "legacy" } });
  const mine = () => rawAll(hdb, "history", IDBKeyRange.bound([pre, ""], [pre + ":￿", "￿"]));
  const before = (await mine()).length, js0 = await jState(hdb, ref);
  await w.remove(path);
  await w.emptyTrash();
  const js1 = await jState(hdb, ref);
  check(before > 2 && js0.intents.length === 1 && (await mine()).length === 0 && js1.intents.length === 0 && js1.J === 0 && !(await row(w, ref)), "test 6: deleting a board (the workspace's) drops its versions, its journal's rows and its versions from before: " + J({ before, after: (await mine()).length, J: js1.J }));
  w.close();
  hdb.close();
}

async function law() {
  const docs = [
    board("A"),
    { title: "p", pages: [{ id: "p1", title: "one", nodes: [{ id: "a", text: "x" }], edges: [] }, { nodes: [] }] },
    { format: "sagebrush-board", version: 1, title: "f", tools: { pen: 1 }, nodes: [{ id: "g", kind: "group", children: [{ id: "c", text: "y" }] }, { id: "d", text: "z" }], edges: [{ from: "c", to: "d" }] },
  ];
  const strip = (x) => Object.fromEntries(Object.entries(x).filter(([f]) => !STORE.includes(f)));
  for (const d of docs) {
    const rec = { ...d, rev: 3, j: 2, hash: "h", unjournaled: true, stampOf: 2 };
    check(canon(strip(kind.withValue(rec, kind.toRecords(rec)))) === canon(strip(rec)), "test 7: the law, withValue(rec, toRecords(rec)) is rec but for the store's own fields: " + (d.title ?? ""));
    check((await hashOf(d)) === (await hashOf({ ...d, rev: 1, j: 2, hash: "x", unjournaled: true, stampOf: 0, baseRev: 4 })), "test 7: the store's own fields are in no hash (C3): " + (d.title ?? ""));
    check(canon(kind.versionedOf(d)) === canon(kind.versionedOf({ ...d, baseRev: 9, rev: 8 })), "test 7: …nor in what a version keeps: " + (d.title ?? ""));
    check((await hashOf(kind.fromRecords(kind.toRecords(d)))) === (await hashOf(d)), "test 7: a board and its records back: one hash (a reload adds no version): " + (d.title ?? ""));
  }
  // test 8: the kind's apply, on web/board's merge3 vectors, and a refused merge
  const vec = await (await fetch("./vectors.json")).json();
  for (const c of vec.board) {
    const r = kind.apply(board(c.base), board(c.a), board(c.b), "shown");
    check((c.text === undefined || textOf(r.value) === c.text) && (r.clashes.length > 0) === !!c.overlap, "test 8: apply, " + c.name + ": " + J({ text: textOf(r.value), clashes: r.clashes }));
  }
  const base = board("one"), paged = { title: "t", pages: [{ nodes: [{ id: "n", text: "one" }] }] }, other = board("two");
  const rr = kind.apply(base, paged, other, "shown");
  check(J(rr.value) === J(paged) && rr.clashes.length >= 2, "test 8: a merge refused (paging): the side wins names, every changed record a clash: " + J(rr.clashes));
}

async function stamps() {
  // a pure stamp keeps the old row's tag and records the
  // revision whose exact value it wraps; nothing else makes, keeps or advances it
  const { w, hdb } = await active();
  const { ref, path } = await made(w);
  await w.write(path, board("A"), { tag: "s:1:1" });
  const r0 = await row(w, ref);
  const st = store(w, hdb, ref);
  await st.load();
  const r1 = await row(w, ref), p1 = await w.boardProvenance(ref);
  check(oldStyle(r0) && r1.rev === r0.rev + 1 && r1.stampOf === r0.rev && r1.tag === "s:1:1" && textOf(r1.doc) === "A" && coherent(r1) && J(p1) === J({ rev: r1.rev, tag: "s:1:1", stampOf: r0.rev }), "stampOf: the first load's stamp of an old-style row: rev R+1, stampOf R, its tag kept: " + J({ rev: r1.rev, stampOf: r1.stampOf, tag: r1.tag }));
  await close(st);
  const s2 = store(w, hdb, ref);
  await s2.load();
  check(J(await row(w, ref)) === J(r1) && s2.recovered.row === "consistent", "stampOf: a second load of the stamped row: nothing written, nothing made or advanced");
  // markOnly keeps it (it changes only the mark); a changed T2 drops it and writes its own tag
  await s2.history.clear();
  const rm = await row(w, ref);
  check(rm.stampOf === r0.rev && rm.unjournaled === true && rm.rev === r1.rev, "stampOf: markOnly keeps it (the mark alone)");
  await s2.save({ ...board("B"), baseRev: rm.rev }, { tag: "s:2:" + rm.rev });
  const r2 = await row(w, ref);
  check(!("stampOf" in r2) && r2.tag === "s:2:" + rm.rev && textOf(r2.doc) === "B" && J(await w.boardProvenance(ref)) === J({ rev: r2.rev, tag: r2.tag }), "stampOf: a T2 that changes the board drops it, with its own tag");
  // a forged stampOf (the caller's) neither stamps nor keeps a tag: on an enveloped row, and on an old-style one
  await w.journalWrite(ref, { ...r2.doc, stampOf: 1, baseRev: r2.rev }, { journal: { j: r2.j, hash: r2.hash } });
  const r3 = await row(w, ref);
  check(!("stampOf" in r3) && !("tag" in r3) && !("stampOf" in r3.doc), "stampOf: a caller's own stampOf on an enveloped row: no stamp, the tag not kept");
  await w.write(path, board("C"), { tag: "s:3:9" });
  const r4 = await row(w, ref);
  await w.journalWrite(ref, { ...board("D"), stampOf: r4.rev, baseRev: r4.rev }, { journal: { j: r3.j, hash: await hashOf(board("D")) } });
  const r5 = await row(w, ref);
  check(oldStyle(r4) && !("stampOf" in r5) && !("tag" in r5) && textOf(r5.doc) === "D", "stampOf: a changed body with a forged stampOf on an old-style row: no stamp, the tag not kept");
  await close(s2);
  // an ordinary write, a retitle and a recovered later intent each drop it
  for (const how of ["write", "retitle", "intent"]) {
    k++;
    const name = `st${k}`, p = `/${name}.board.json`;
    const e = await w.create(p, { content: { title: name, nodes: [{ id: "n", text: "A" }] } });
    await w.write(p, { title: name, nodes: [{ id: "n", text: "A" }] }, { tag: "s:1:1" });
    const s = store(w, hdb, e.ref), d = await s.load();
    const before = await row(w, e.ref);
    if (how === "write") await w.write(p, { title: name, nodes: [{ id: "n", text: "raw" }] }, {});
    else if (how === "retitle") await w.rename(p, `/${name}x.board.json`, { retitle: true });
    else await s.t1({ title: name, nodes: [{ id: "n", text: "I" }], baseRev: d.rev });
    await close(s);
    if (how === "intent") { const s3 = store(w, hdb, e.ref); await s3.load(); await close(s3); }
    const after = await row(w, e.ref);
    check(before.stampOf === before.rev - 1 && !("stampOf" in after) && (how === "intent" ? textOf(after.doc) === "I" && !("tag" in after) : oldStyle(after)), `stampOf: ${how === "intent" ? "a recovered later intent" : "an ordinary " + how} drops it: ` + J({ before: before.stampOf, after: after.stampOf, tag: after.tag }));
  }
  // adopt writes an old-style row whatever it is given; a plain row as given
  for (const env of [true, false]) {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
    const given = { id, doc: board("adopted"), rev: 1, updated: 1, ...(env ? { j: 5, hash: "forged", unjournaled: true, stampOf: 0 } : {}) };
    await w.locked(() => w.adopt("/", "adopted-" + id, ".board.json", { kind: "board", ref: id, mode: "python" }, { at: `/adopted-${id}.board.json`, board: given }));
    const r = await row(w, id);
    check(env ? oldStyle(r) && textOf(r.doc) === "adopted" : J(r) === J(given), `adopt ${env ? "of a row carrying an envelope: written old-style" : "of a plain row: written as given"}: ` + J(r));
  }
  w.close();
  hdb.close();
}

async function journalOff() {
  // test 9b: with the journal off, an ordinary write and a deletion are as before (the envelope's drop and dropRows
  // find nothing)
  const w = await W.Workspace.open(await named()), hdb = await W.openBoardHistoryDb();
  const { ref, path } = await made(w);
  await w.write(path, board("B"), { tag: "s:1:1" });
  const r = await row(w, ref);
  check(J(Object.keys(r).sort()) === J(["doc", "id", "rev", "tag", "updated"]) && textOf(r.doc) === "B", "test 9b: journal off, an ordinary write: the row as before: " + J(Object.keys(r).sort()));
  const all0 = (await rawAll(hdb, "history")).length;
  await w.remove(path);
  await w.emptyTrash();
  check(!(await row(w, ref)) && (await rawAll(hdb, "history")).length === all0, "test 9b: journal off, a deletion: nothing else dropped");
  w.close();
  hdb.close();
}

export async function run() {
  for (const f of [saves, conflicts, markRaces, fallbacks, deletion, law, stamps, journalOff]) {
    console.log("test: " + f.name);
    try { await f(); } catch (e) { check(false, `${f.name} threw: ${e?.stack ?? e}`); }
    A.BOARD_JOURNAL_HOOK.beforeLock = undefined;
    A.BOARD_JOURNAL_HOOK.afterBoards = undefined;
  }
  return results;
}
