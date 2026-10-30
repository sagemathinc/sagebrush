// One device of web/workspace/test-doc-sync.mjs (sync 2c-3), in its own browser context (its own IndexedDB and Web
// Locks): a workspace with the journal active and DEV's docsync on, a notebook store per notebook, and doc-sync.ts's
// DocSync on a minimal account socket to the reference server (hello, welcome, then the document requests).  The
// harness drives two of these, as two devices of one account.
import { W, N, H, DS, P, NB, ST } from "./all.js";

const J = JSON.stringify;
const T = { stores: new Map(), pending: new Map(), req: 0, log: [], warns: [] };
window.T = T;
// (this device's console warnings, as text: a remote change the store didn't merge says why there (store.js remoteArrived))
const warn = console.warn.bind(console);
console.warn = (...a) => { T.warns.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" ")); warn(...a); };
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
  ws.send(J({ t: "hello", v: 2, device: `device-${dev}-0000`, name: dev, index_after: 0 }));
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
/** This device's console warnings from the `from`th on. */
T.warnsFrom = (from) => T.warns.slice(from);
T.hiddenCount = () => T.hidden.length;
T.warnCount = () => T.warns.length;
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
// connection while a request waits, or kick during a flight, deterministically
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
/** The fake DocSync's next history transaction (markSent, recordClaim, applyPage...) held before it runs, until
 * fakeReleaseTx: then run, or failed as a storage refusal would fail it. */
T.fakeGateTx = () => {
  const ds = T.fake.ds, orig = ds.tx.bind(ds);
  T.fake.gated = false;
  T.fake.gate = new Promise((r) => { T.fake.release = r; });
  ds.tx = async (...a) => {
    if (T.fake.gate) {
      const g = T.fake.gate;
      T.fake.gate = null;
      T.fake.gated = true;
      if (await g) throw new Error("the history refused the write (the test's)");
    }
    return orig(...a);
  };
  return true;
};
T.fakeWaitGated = async (ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (T.fake.gated) return true;
  return false;
};
T.fakeReleaseTx = async (fail) => { T.fake.release(!!fail); await new Promise((r) => setTimeout(r, 300)); return true; };
T.fakeState = () => ({ sent: T.fake.sent.slice(), waiting: T.fake.q.map((x) => x.msg.t), stopped: T.fake.ds.stopped.get(T.fake.only)?.code ?? null, held: !!T.fake.ds.held?.has?.(T.fake.only) });

// ---- the notebook page itself (notebook.js createNotebook) on a notebook's store, as index.html attaches it
T.mount = async (id) => {
  const div = document.body.appendChild(document.createElement("div"));
  T.nbDiv = div;
  T.nb = NB.createNotebook(div, {});
  const st = new T.kit.JournalStore(T.w.main, T.hdb, id, null, H);
  await T.nb.attach(st);
  T.stores.set(id, st);
  return codesOf(T.nb.snapshot());
};
T.shown = () => codesOf(T.nb.snapshot());
// ---- P2c (plan-p2c r0): the mounted notebook's editor as a person sees it.  Its cells' texts from their textareas,
// any copy tagged conflict, the notices it said (its "saved" and "conflict" events, from mountWatch on), and the
// focused cell's selection
T.mountWatch = () => {
  T.said = [];
  for (const e of ["saved", "conflict"]) T.nb.on(e, (x) => T.said.push([e, typeof x === "string" ? x : J(x)]));
  return true;
};
const cellsOf = (root) => [...root.querySelectorAll(".sbnb .cells > *")].map((el) => el.cell).filter(Boolean);
T.editor = () => {
  const cs = cellsOf(T.nbDiv);
  const f = cs.find((c) => document.activeElement === c.ta);
  return {
    texts: cs.map((c) => [c.id, c.ta.value]),
    copies: cs.filter((c) => (c.metadata?.tags ?? []).includes("conflict")).length,
    said: (T.said ?? []).slice(),
    sel: f ? { id: f.id, start: f.ta.selectionStart, end: f.ta.selectionEnd, dir: f.ta.selectionDirection } : null,
  };
};
/** A cell typed into but not yet saved: its text set, focused, the selection [start, end] in it, and no input event
 * (the keystroke's save comes 500 ms later: this is the moment before it). */
T.typeUnsaved = (cid, text, start, end = start, dir = "none") => {
  const c = cellsOf(T.nbDiv).find((x) => x.id === cid);
  if (!c) return false;
  c.ta.value = text;
  c.ta.focus();
  c.ta.setSelectionRange(start, end, dir);
  return true;
};
/** Whether every journal store open here has the editor's merge (the store's mergeText, history.js mergeTextAt): the
 * conflict-copy fallback (notebook.js applyRemote, a store without it) is then never taken while a notebook syncs. */
T.everyJournalStoreMerges = () => {
  const out = [...T.stores.values()].map((s) => [s.id, !!s.journaled, typeof s.mergeText === "function" && s.mergeText === H.mergeTextAt]);
  return { all: out.length > 0 && out.every(([, j, m]) => j && m), stores: out };
};
/** While `on`, the notebook's merges with the history (the real store's mergeRemote) run with one version missing
 * from its live history: the version its record's j names (its journal still records it), hidden from the graph's
 * patches for that merge only, as a version recorded here but not held yet (BASE-1).  Each such merge's hidden time is
 * kept in T.hidden. */
T.hidden = [];
T.hideVersion = (id, on) => {
  const st = T.stores.get(id);
  if (!on) { delete st.mergeRemote; return true; }
  const merge = Object.getPrototypeOf(st).mergeRemote;
  st.mergeRemote = async function (mine) {
    const [rec, js] = [await rawGet(T.w.main, "notebooks", id), await N.readJournal(T.hdb, id)];
    let hidden = null, best = -1;
    for (const [t, j] of js.jOf) if (j <= (rec?.j ?? 0) && j > best) { best = j; hidden = t; }
    const ps = this.history.session?.graph?.patches, has = ps?.has;
    if (!hidden || !has) throw new Error(`hideVersion: nothing to hide (${hidden}, ${!!has})`);
    ps.has = function (t) { return t === hidden ? false : has.call(this, t); };
    T.hidden.push(hidden);
    try { return await merge.call(this, mine); } finally { ps.has = has; }
  };
  return true;
};
/** The history's head value of a notebook (its cells' [id, input], sorted). */
T.head = (id) => { const s = T.stores.get(id)?.history?.session; return s ? J(s.value().get({ type: "cell" }).map((r) => [r.id, r.input]).sort()) : null; };

// ---- the editor alone (notebook.js createNotebook) on a memory store with the journal store's merge (`merge`) or without
// one (a page's local store before the journal, the embed's): what applyRemote does with an incoming document
T.edFake = async (merge, cells) => {
  T.edDiv?.remove();
  const store = new ST.MemoryStore({ name: "f", mode: "python", cells: cells.map(([id, code]) => ({ id, code })) });
  Object.defineProperty(store, "mergeText", { get: () => (merge ? H.mergeTextAt : undefined) });
  T.edDiv = document.body.appendChild(document.createElement("div"));
  T.edNb = NB.createNotebook(T.edDiv, {});
  T.edStore = store;
  T.edSaid = [];
  T.edNb.on("conflict", (x) => T.edSaid.push(J(x)));
  await T.edNb.attach(store);
  return true;
};
/** The fake editor's cells, as T.editor says them, its own root only. */
T.edState = () => {
  const cs = cellsOf(T.edDiv), f = cs.find((c) => document.activeElement === c.ta);
  return { texts: cs.map((c) => [c.id, c.ta.value]), copies: cs.filter((c) => (c.metadata?.tags ?? []).includes("conflict")).length, said: T.edSaid.slice(), sel: f ? { id: f.id, start: f.ta.selectionStart, end: f.ta.selectionEnd, dir: f.ta.selectionDirection } : null };
};
T.edType = (cid, text, start, end = start, dir = "none") => {
  const c = cellsOf(T.edDiv).find((x) => x.id === cid);
  if (!c) return false;
  c.ta.value = text; c.ta.focus(); c.ta.setSelectionRange(start, end, dir);
  return true;
};
/** A cell deleted in the fake editor (as its delete does), not yet saved. */
T.edDelete = (cid) => { const c = cellsOf(T.edDiv).find((x) => x.id === cid); if (!c) return false; c.el.remove(); return true; };
/** A document from elsewhere pushed to the fake editor: its cells, with outputs where given. */
T.edPush = (cells) => {
  T.edStore.push({ ...structuredClone(T.edStore.doc), cells: cells.map(([id, code, outputs]) => ({ id, code, ...(outputs ? { outputs } : {}) })) });
  return true;
};
/** Typing in a cell of the mounted notebook: its text set, and the editor told (as a keystroke tells it). */
T.type = (cid, text) => {
  const cell = [...document.querySelectorAll(".sbnb .cells > *")].map((el) => el.cell).find((c) => c?.id === cid);
  if (!cell) return false;
  cell.ta.value = text;
  cell.ta.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
};

// ---- one device, two pages: a board page holding the account connection, carrying notebooks with
// the switch's followDocSync, and the notebook page turning the switch on with enableDocSync, its saves told to the
// board's DocSync on the workspace's channel
/** The workspace, its journal not yet active (the notebook page's switch activates it). */
T.openWs = async (name) => {
  T.w = await W.Workspace.open({ name: `ds-${name}`, mainName: `dsmain-${name}` });
  T.hdb = await W.openHistoryDb();
  T.kit = N.journalClasses({ IdbStore: W.IdbStore, IdbPatchStore: W.IdbPatchStore });
  return await T.w.journalActive();
};
/** The board page's side: followDocSync, its DocSync the one T.connect then connects. */
T.follow = async () => {
  T.followed = 0;
  T.unfollow = await W.followDocSync({
    makeDocs: () => new DS.DocSync({ retryMs: 200, askMs: 5000 }),
    makeChannel: () => new BroadcastChannel(W.docSyncChannel(T.w.ws.name)),
    journalActive: () => T.w.journalActive(),
    setDocs: (d) => { T.ds = d; T.followed++; },
    warn: (...a) => T.log.push("warn: " + a.map(String).join(" ")),
  });
  return T.followed;
};
T.followedCount = () => T.followed ?? 0;
/** The notebook page's side: enableDocSync with this page's pieces, its notebook `id` (made from `cells`) the one shown,
 * reopened through the journal; what it returned, and the read-only it set. */
T.enable = async (id, cells) => {
  T.ro = [];
  T.shownStore = null;
  const out = await W.enableDocSync({
    loadHistory: async () => H,
    makeDocs: () => new DS.DocSync({ retryMs: 200, askMs: 5000 }),
    makeChannel: () => new BroadcastChannel(W.docSyncChannel(T.w.ws.name)),
    register: W.registerJournalWriter,
    own: async () => () => {},
    setReadOnly: (ro) => T.ro.push(ro),
    readOnlyNow: () => !T.shownStore || !!T.shownStore.viewOnly,
    flush() {},
    saved: async () => {},
    activate: () => T.w.activateJournal(),
    begun: () => T.w.journalBegun(),
    reopen: async () => { await T.open(id, cells); T.shownStore = T.stores.get(id); return !!T.shownStore.journaled; },
    setDocs: (d) => { T.ds = d; },
    needReload: () => { T.reload = true; },
    warn: (...a) => T.log.push("warn: " + a.map(String).join(" ")),
  });
  return { out, ro: T.ro, on: H.DOC_SYNC.on, saved: typeof H.DOC_SYNC.saved, synced: !!T.shownStore?.synced, writer: !!T.shownStore?.writer };
};
/** A save as the page makes it: no kick of its own (the switch's DOC_SYNC.saved tells the connection's DocSync). */
T.editOnly = async (id, cells) => {
  const st = T.stores.get(id), rec = await rawGet(T.w.main, "notebooks", id);
  const out = await st.save({ name: rec.name, mode: rec.mode, id, cells: cells.map(([cid, code]) => ({ id: cid, code })), baseRev: rec.rev });
  return typeof out === "string" ? out : !!out?.saved;
};
T.warnings = () => T.log.filter((x) => typeof x === "string" && x.startsWith("warn: "));

// ---- the real owners (case 14): this page's SyncOwner and its SyncClient, on the namespace's
// sender lock (shared by the pages of this browser context), against the reference server through the front (its
// session for this device; /api/share/me answered by the front).  A board page carries notebooks with
// followDocSync; the notebook page turns the switch on with enableDocSync; each page's DocSync is the one its owner's
// client connects, and T.connected counts its connections
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const counted = (d) => { const c = d.connected.bind(d); d.connected = (l) => { T.connected++; return c(l); }; return d; };
/** The workspace `name` and this page's owner, started; `activate`: the journal turned on first (an earlier load of the
 * notebook page). */
T.ownerOpen = async (name, activate) => {
  T.w = await W.Workspace.open({ name: `ds-${name}`, mainName: `dsmain-${name}` });
  T.hdb = await W.openHistoryDb();
  T.kit = N.journalClasses({ IdbStore: W.IdbStore, IdbPatchStore: W.IdbPatchStore });
  if (activate) {
    W.registerJournalWriter("notebooks");
    W.registerJournalWriter("boards");
    await T.w.activateJournal();
  }
  T.connected = 0;
  T.owner = W.SyncOwner.of(T.w, { origin: location.origin });
  T.owner.start();
  return await T.w.journalActive();
};
T.ownerState = () => ({ holder: T.owner.isHolder(), state: T.owner.view().s.state, running: !!T.owner.client, connected: T.connected });
/** (case 14 under cloud) A tracing fetch for this page: each call is numbered "<page>.<n>" (unique: the
 * page's label and this page's own count) and sends it as x-test-call (the harness's front reads it and never passes
 * it on), and its stages go to T.trace: "fetch-rejected <name>" or "fetched <status>"; the body's byte receipt (length
 * and sha256), read from a clone before anything else reads the body; and its json() staged as text() then
 * JSON.parse ("body-read-failed <name>", "json-parse-failed", "parsed"), giving the same value and throwing the same
 * error as the Response's own.  The product code is unchanged: the Sync panel takes it through its opts.fetch. */
T.trace = [];
let traceN = 0;
T.traceFetch = (page) => async (input, init = {}) => {
  const call = `${page}.${++traceN}`;
  const headers = new Headers(init.headers ?? undefined);
  headers.set("x-test-call", call);
  let r;
  try { r = await fetch(input, { ...init, headers }); }
  catch (e) { T.trace.push({ call, kind: "fetch-rejected", detail: e?.name }); throw e; }
  T.trace.push({ call, kind: "fetched", detail: r.status });
  r.clone().arrayBuffer().then(async (b) => {
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
    T.trace.push({ call, bytes: b.byteLength, sha });
  }, () => {});
  const read = (f) => async () => { try { return await f(); } catch (e) { T.trace.push({ call, kind: "body-read-failed", detail: e?.name }); throw e; } };
  const text = read(r.text.bind(r)), bytes = read(r.arrayBuffer.bind(r));
  r.text = text;
  r.arrayBuffer = bytes;
  r.json = async () => {
    const t = await text();
    let v;
    try { v = JSON.parse(t); } catch (e) { T.trace.push({ call, kind: "json-parse-failed" }); throw e; }
    T.trace.push({ call, kind: "parsed" });
    return v;
  };
  return r;
};
/** The relay control's page side: n traced GETs of `path`, each read as JSON; the calls' ids. */
T.relayProbe = async (path, n) => {
  const f = T.traceFetch(T.pageLabel ?? "R"), calls = [];
  for (let i = 0; i < n; i++) {
    const before = traceN;
    try { await (await f(path, { credentials: "same-origin" })).json(); } catch {}
    calls.push(`${T.pageLabel ?? "R"}.${before + 1}`);
  }
  return calls;
};
/** The traced calls so far: stages and byte receipts. */
T.traceDump = () => T.trace;
/** Sync turned on in this browser, as a person does it: the Sync panel's button; then this page's owner the holder. */
T.turnOn = async () => {
  // (each phase recorded as it completes, with its time, for the harness's diagnostics (T.turnInfo); what the
  // panel says is kept in T.log as "say: ...", which T.warnings doesn't count)
  const t = Date.now(), done = (what) => T.turnPhases.push(`${what} (${Date.now() - t} ms)`);
  T.turnPhases = [];
  const el = (T.turnEl = document.body.appendChild(document.createElement("div")));
  T.section = W.syncSection(T.w, el, { say: (m) => T.log.push("say: panel " + String(m).slice(0, 200)), fail: (e) => T.log.push("warn: panel " + e), usage: () => T.w.usage(), confirm: () => true, prompt: () => "delete" }, { fetch: T.traceFetch(T.pageLabel ?? "D1") });
  done("panel made");
  const button = () => [...el.querySelectorAll("button")].find((b) => /Turn on sync/.test(b.textContent));
  for (let i = 0; i < 200 && !button(); i++) await pause(50);
  if (!button()) return { error: "no Turn on sync: " + el.textContent.slice(0, 200) };
  done("its Turn on sync button shown");
  button().click();
  done("clicked");
  for (let i = 0; i < 400 && !(T.owner.isHolder() && T.owner.view().s.state === "synced"); i++) await pause(50);
  done(T.owner.isHolder() && T.owner.view().s.state === "synced" ? "the holder, synced" : "the wait for the holder, synced, ended without it");
  return T.ownerState();
};
/** The turn-on so far (the harness's diagnostics): its completed phases, the panel's text, what it said or warned. */
T.turnInfo = () => ({
  phases: T.turnPhases ?? null,
  panel: T.turnEl ? T.turnEl.textContent.replace(/\s+/g, " ").slice(0, 300) : null,
  said: T.log.filter((x) => typeof x === "string" && /^(say|warn): /.test(x)).slice(-10),
});
/** The board page's side: followDocSync, its DocSync handed to this page's owner. */
T.boardFollow = async () => {
  T.unfollow = await W.followDocSync({
    makeDocs: () => counted(new DS.DocSync({ retryMs: 200, askMs: 5000 })),
    makeChannel: () => new BroadcastChannel(W.docSyncChannel(T.w.ws.name)),
    journalActive: () => T.w.journalActive(),
    setDocs: (d) => { T.ds = d; T.owner.setDocs(d); },
    warn: (...a) => T.log.push("warn: " + a.map(String).join(" ")),
  });
  return true;
};
T.clientRunning = (ms) => T.owner.clientRunning(ms);
/** A notebook page's `on` on the workspace's channel, as another notebook page that turned the switch on posts it. */
T.postOn = () => { const ch = new BroadcastChannel(W.docSyncChannel(T.w.ws.name)); ch.postMessage({ on: true }); ch.close(); return true; };
/** The notebook page's side: enableDocSync with this page's pieces and its owner, notebook `id` (made from `cells`)
 * the one shown. */
T.nbEnable = async (id, cells) => {
  T.ro = [];
  T.shownStore = null;
  const out = await W.enableDocSync({
    loadHistory: async () => H,
    makeDocs: () => counted(new DS.DocSync({ retryMs: 200, askMs: 5000 })),
    makeChannel: () => new BroadcastChannel(W.docSyncChannel(T.w.ws.name)),
    register: W.registerJournalWriter,
    own: async () => () => {},
    setReadOnly: (ro) => T.ro.push(ro),
    readOnlyNow: () => !T.shownStore || !!T.shownStore.viewOnly,
    flush() {},
    saved: async () => {},
    activate: () => T.w.activateJournal(),
    begun: () => T.w.journalBegun(),
    reopen: async () => { await T.open(id, cells); T.shownStore = T.stores.get(id); return !!T.shownStore.journaled; },
    setDocs: (d) => { T.ds = d; T.owner.setDocs(d); },
    needReload: () => { T.reload = true; },
    warn: (...a) => T.log.push("warn: " + a.map(String).join(" ")),
  });
  return { out, ro: T.ro, on: H.DOC_SYNC.on, synced: !!T.shownStore?.synced, writer: !!T.shownStore?.writer };
};
/** This page closing, as pagehide does it: its owner suspended for good (its client and lock let go), its listeners gone. */
T.closeOwner = () => {
  T.unfollow?.();
  T.section?.dispose();
  T.owner.destroy();
  return true;
};
window.ready = true;
