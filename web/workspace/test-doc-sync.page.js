// One device of web/workspace/test-doc-sync.mjs (sync 2c-3), in its own browser context (its own IndexedDB and Web
// Locks): a workspace with the journal active and DEV's docsync on, a notebook store per notebook, and doc-sync.ts's
// DocSync on a minimal account socket to the reference server (hello, welcome, then the document requests).  The
// harness drives two of these, as two devices of one account.
import { W, N, H, DS, P, NB } from "./all.js";

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
T.record = async (id) => { const r = await rawGet(T.w.main, "notebooks", id); return r ? { codes: codesOf(r), mark: r.unjournaled ?? null, j: r.j, hashOk: r.hash === (await N.docHash(r)) } : null; };
T.journal = async (id) => { const js = await N.readJournal(T.hdb, id); return { start: js.start, slot: js.slot, lrows: js.lrows, cursor: js.cursor, J: js.J }; };
T.events = () => T.ds.events.splice(0);
T.stopped = () => Object.fromEntries(T.ds.stopped);
T.close = async (id) => { await T.stores.get(id)?.release(); T.stores.delete(id); return true; };

// ---- sync's local budget (journal-rows.js SYNC_DEBT), lowered for a case and restored
T.setDebt = (k, v) => { T.debtKeep ??= { ...N.SYNC_DEBT }; N.SYNC_DEBT[k] = v; return true; };
T.resetDebt = () => { if (T.debtKeep) Object.assign(N.SYNC_DEBT, T.debtKeep); return true; };

// ---- a DocSync of its own over a deferred link (no server): each request of the notebook `only` waits until the test
// answers it (fakeAnswer); any other notebook's is answered `busy` at once.  Lets a case answer a pull, drop the
// connection while a request waits, or kick during a flight, deterministically (astra's CORR-2C3-1, D3-4c)
T.fakeStart = async (account, only, retryMs = 60_000) => {
  const owner = await P.accountHash(account);
  T.fake = { q: [], sent: [], only, owner, ds: new DS.DocSync({ retryMs, askMs: 60_000 }) };
  T.fake.link = {
    owner,
    reserve: () => ++T.req,
    ask: (req, msg) => new Promise((answer) => {
      if (msg.doc !== T.fake.only) return answer({ t: "error", req, code: "busy", detail: { message: "not this case's" } });
      T.fake.sent.push(msg.t);
      T.fake.q.push({ req, msg, answer });
    }),
  };
  return true;
};
T.fakeConnect = () => { void T.fake.ds.connected(T.fake.link); return true; };
T.fakeKick = () => { T.fake.ds.kick(T.fake.only); return true; };
/** The next waiting request of type `t` (its message), or null after `ms`. */
T.fakeWait = async (t, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) {
    const p = T.fake.q.find((x) => x.msg.t === t);
    if (p) return p.msg;
  }
  return null;
};
/** The waiting request of type `t` answered with `frame` (its req added); then a moment for what follows it. */
T.fakeAnswer = async (t, frame, settle = 150) => {
  const i = T.fake.q.findIndex((x) => x.msg.t === t);
  if (i < 0) return false;
  const [p] = T.fake.q.splice(i, 1);
  p.answer({ ...frame, req: p.req });
  await new Promise((r) => setTimeout(r, settle));
  return true;
};
/** The waiting request of type `t` answered with `frame`, and the connection dropped in the same moment (before
 * the flight goes on): what the flight asks next must wait for a new connection. */
T.fakeAnswerDrop = async (t, frame) => {
  const i = T.fake.q.findIndex((x) => x.msg.t === t);
  if (i < 0) return false;
  const [p] = T.fake.q.splice(i, 1);
  p.answer({ ...frame, req: p.req });
  for (const x of T.fake.q.splice(0)) x.answer({ t: "error", req: x.req, code: "busy", detail: { message: "the connection ended" } });
  T.fake.ds.disconnected();
  await new Promise((r) => setTimeout(r, 300));
  return true;
};
/** The connection dropped as SyncClient drops it: its waiting requests answered `busy`, then DocSync told. */
T.fakeDisconnect = async () => {
  for (const p of T.fake.q.splice(0)) p.answer({ t: "error", req: p.req, code: "busy", detail: { message: "the connection ended" } });
  T.fake.ds.disconnected();
  await new Promise((r) => setTimeout(r, 150));
  return true;
};
T.fakeState = () => ({ sent: T.fake.sent.slice(), waiting: T.fake.q.map((x) => x.msg.t), stopped: T.fake.ds.stopped.get(T.fake.only)?.code ?? null, held: !!T.fake.ds.held?.has?.(T.fake.only) });

// ---- the notebook page itself (notebook.js createNotebook) on a notebook's store, as index.html attaches it
T.mount = async (id) => {
  const div = document.body.appendChild(document.createElement("div"));
  T.nb = NB.createNotebook(div, {});
  const st = new T.kit.JournalStore(T.w.main, T.hdb, id, null, H);
  await T.nb.attach(st);
  T.stores.set(id, st);
  return codesOf(T.nb.snapshot());
};
T.shown = () => codesOf(T.nb.snapshot());
/** Typing in a cell of the mounted notebook: its text set, and the editor told (as a keystroke tells it). */
T.type = (cid, text) => {
  const cell = [...document.querySelectorAll(".sbnb .cells > *")].map((el) => el.cell).find((c) => c?.id === cid);
  if (!cell) return false;
  cell.ta.value = text;
  cell.ta.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
};
window.ready = true;
