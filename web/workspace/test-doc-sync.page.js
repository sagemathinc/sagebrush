// One device of web/workspace/test-doc-sync.mjs (sync 2c-3), in its own browser context (its own IndexedDB and Web
// Locks): a workspace with the journal active and DEV's docsync on, a notebook store per notebook, and doc-sync.ts's
// DocSync on a minimal account socket to the reference server (hello, welcome, then the document requests).  The
// harness drives two of these, as two devices of one account.
import { W, N, H, DS, P } from "./all.js";

const J = JSON.stringify;
const T = { stores: new Map(), pending: new Map(), req: 0, log: [] };
window.T = T;
const rawGet = (db, store, key) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const codesOf = (d) => J((d?.cells ?? []).map((c) => [c.id, c.code]));

/** The workspace, its journal active, docsync on. */
T.init = async (name) => {
  T.w = await W.Workspace.open({ name: `ds-${name}`, mainName: `dsmain-${name}` });
  W.registerJournalWriter("notebooks");
  W.registerJournalWriter("boards");
  await T.w.activateJournal();
  T.hdb = await W.openHistoryDb();
  N.DOC_SYNC.on = true;
  T.kit = N.journalClasses({ IdbStore: W.IdbStore, IdbPatchStore: W.IdbPatchStore });
  T.ds = new DS.DocSync({ retryMs: 200, askMs: 5000 });
  return true;
};

/** The account socket (the front adds this device's session), hello, welcome, then DocSync connected on it. */
T.connect = async (dev, account) => {
  const owner = await P.accountHash(account);
  const ws = new WebSocket(`ws://${location.host}/api/sync/v1/account?dev=${dev}`);
  T.ws = ws;
  const welcome = new Promise((ok, no) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      T.log.push(m.t === "error" ? `error:${m.code}` : m.t);
      if (m.t === "welcome") return ok(m);
      if (m.t === "changed") return T.ds.changed(m);
      if (Number.isSafeInteger(m.req) && T.pending.has(m.req)) { const f = T.pending.get(m.req); T.pending.delete(m.req); f(m); }
    };
    ws.onerror = () => no(new Error("socket error"));
    ws.onclose = () => { for (const [, f] of T.pending) f({ t: "error", code: "busy" }); T.pending.clear(); T.ds.disconnected(); };
  });
  await new Promise((ok) => { ws.onopen = ok; });
  ws.send(J({ t: "hello", v: 1, device: `device-${dev}-0000`, name: dev, index_after: 0 }));
  await Promise.race([welcome, new Promise((_, no) => setTimeout(() => no(new Error("no welcome: " + J(T.log))), 10_000))]);
  await T.ds.connected({
    owner,
    reserve: () => ++T.req,
    ask: (req, msg) => new Promise((answer) => { T.pending.set(req, answer); ws.send(J({ ...msg, req })); }),
  });
  return true;
};
T.disconnect = async () => { T.ws?.close(); await new Promise((r) => setTimeout(r, 50)); return true; };

/** A notebook's store, loaded (a new notebook made from `cells`, or the one this device has). */
T.open = async (id, cells) => {
  const doc = cells ? { name: "t", mode: "python", cells: cells.map(([cid, code]) => ({ id: cid, code })) } : null;
  const st = new T.kit.JournalStore(T.w.main, T.hdb, id, doc, H);
  const d = await st.load();
  T.stores.set(id, st);
  return { row: st.recovered?.row, codes: codesOf(d) };
};
/** A save of `cells` (the record's revision as its base), then its patches sent. */
T.edit = async (id, cells) => {
  const st = T.stores.get(id), rec = await rawGet(T.w.main, "notebooks", id);
  const out = await st.save({ name: rec.name, mode: rec.mode, id, cells: cells.map(([cid, code]) => ({ id: cid, code })), baseRev: rec.rev });
  T.ds.kick(id);
  return typeof out === "string" ? out : !!out?.saved;
};
T.kick = (id, startHere = false) => { T.ds.kick(id, startHere); return true; };
/** Settled: DocSync's flights done, and the writer's merge after a remote page (its 50 ms debounce and save). */
T.idle = async () => {
  for (let i = 0; i < 5; i++) { await T.ds.idle(); await new Promise((r) => setTimeout(r, 150)); }
  return true;
};
T.record = async (id) => { const r = await rawGet(T.w.main, "notebooks", id); return r ? { codes: codesOf(r), mark: r.unjournaled ?? null, j: r.j } : null; };
T.journal = async (id) => { const js = await N.readJournal(T.hdb, id); return { start: js.start, slot: js.slot, lrows: js.lrows, cursor: js.cursor, J: js.J }; };
T.events = () => T.ds.events.splice(0);
T.stopped = () => Object.fromEntries(T.ds.stopped);
T.close = async (id) => { await T.stores.get(id)?.release(); T.stores.delete(id); return true; };
window.ready = true;
