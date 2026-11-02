// History's dynamic census guard (Stage A layer 1; design stage-a-l1 r2.2 §4 [G1, A5, C1, W, GC]) — TEST ONLY, never
// imported by the app (its absence from the built output is asserted).  Installed in a test page before the app's code
// runs, it wraps IndexedDB so that, in every source database the page opens:
//   - history is ACTIVE: hmeta's `hactive` set at each open (unless `inert`), and a notebooks database made with
//     history's stores at its creation (the test-only opener, GC);
//   - every readwrite transaction's MUTATIONS of a source store (put, add, delete, clear; cursor update and delete) are
//     recorded by IDENTITY, and judged at its commit: each identity whose CONTENT changed (or that was added or
//     removed) must have, in the same transaction, a token naming it, the overflow witness, or the exhausted state
//     (set then or before: W).  Content, for each source: an entry's kind, identity, hash, size, its ref and whether it
//     is trashed; a board row's doc and rev; a notebook record's value and rev (its journal marks aside); a data file's
//     bytes (by a checksum).  A path alone is judged by the static census (every site that changes paths writes
//     tokens through log/logServer, or is a large move's physical sweep), so a sweep's physical moves pass here by
//     behaviour, not by name; so do metadata-only writes (the migrator's identities and hashes, a journal mark, the
//     fetch's failure notes) and control rows (a large move's records).
// The verdicts: window.__historyGuard.violations, each {db, ident, store, why}.  `skipOpener(name)`: a notebooks
// database left to the app's own opener (the GC control); `judgeFixtures`: a test page's own transactions judged
// too (the guard's own controls are such transactions).
const SRC = { workspace: new Set(["entries", "fileBytes", "boards"]), notebooks: new Set(["notebooks"]) };
const KINDS = new Set(["file", "folder", "notebook", "board"]);
const FENCE = "__sagebrush-workspace__";

export function installGuard({ inert = false, skipOpener = () => false, judgeFixtures = false } = {}) {
  const G = { violations: [], checked: 0, txs: 0, pending: 0, inert, dbs: new Map() };
  window.__historyGuard = G;
  const classOf = (db) => (db.objectStoreNames.contains("ops") && db.objectStoreNames.contains("entries") ? "workspace" : db.objectStoreNames.contains("notebooks") && db.objectStoreNames.contains("files") ? "notebooks" : null);
  // (each source database's shadow: what the guard knows of its rows, to judge a write a change or not)
  const shadowOf = (db) => {
    let s = G.dbs.get(db.name);
    if (!s) G.dbs.set(db.name, (s = { kind: classOf(db), byPath: new Map(), sig: new Map(), bytes: new Map(), board: new Map(), nb: new Map(), meta: new Map() }));
    return s;
  };
  const sum = (b) => { let h = 2166136261 >>> 0; const u = b instanceof Uint8Array ? b : new Uint8Array(b?.buffer ?? b ?? []); for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619) >>> 0; return `${u.length}:${h}`; };
  const entrySig = (e) => JSON.stringify([e.kind, e.fid ?? null, e.ref ?? null, e.sha256 ?? null, e.size ?? null, !!e.trashed]);
  const identOf = (e) => (e.kind === "file" || e.kind === "folder" ? e.fid : e.ref) ?? `path:${e.path}`;
  const strip = (r) => { if (!r || typeof r !== "object") return r; const { j, hash, unjournaled, updated, stampOf, tag, ...rest } = r; return JSON.stringify(rest); };

  // ---- open: history active, the notebooks' stores made at creation, the shadow seeded before any app transaction
  const open0 = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (...a) {
    const r = open0.apply(this, a);
    r.addEventListener("upgradeneeded", () => {
      const db = r.result;
      if (!skipOpener(db.name) && db.objectStoreNames.contains("notebooks") && db.objectStoreNames.contains("files") && !db.objectStoreNames.contains("htokens")) {
        db.createObjectStore("htokens", { keyPath: "seq" });
        db.createObjectStore("hmeta");
      }
    });
    r.addEventListener("success", () => {
      const db = r.result, k = classOf(db);
      if (!k) return;
      shadowOf(db);
      if (!db.objectStoreNames.contains("hmeta")) return;
      const s = shadowOf(db);
      // (created now, so queued before any transaction the app makes once it has the connection)
      const stores = [...SRC[k], "hmeta"].filter((x) => db.objectStoreNames.contains(x));
      const tx = db.transaction(stores, inert ? "readonly" : "readwrite");
      if (!inert) tx.objectStore("hmeta").put(true, "hactive");
      const all = (st, f) => { const c = tx.objectStore(st).openCursor(); c.onsuccess = () => { const x = c.result; if (!x) return; f(x.key, x.value); x.continue(); }; };
      all("hmeta", (key, v) => s.meta.set(key, v));
      if (k === "workspace") {
        all("entries", (key, e) => { if (e && KINDS.has(e.kind)) { const i = identOf(e); s.byPath.set(key, i); s.sig.set(i, entrySig(e)); } });
        all("fileBytes", (key, b) => s.bytes.set(key, sum(b)));
        all("boards", (key, b) => s.board.set(key, JSON.stringify([b?.doc, b?.rev])));
      } else all("notebooks", (key, v) => { if (key !== FENCE) s.nb.set(key, strip(v)); });
    });
    return r;
  };

  // ---- transactions: what each changed, and what it witnessed
  const T = new WeakMap();
  const txState = (tx) => {
    let t = T.get(tx);
    if (!t) {
      t = { changed: new Map(), tokens: new Set(), rows: [], order: [], begin: null, ovf: false, exhausted: false };
      T.set(tx, t);
      tx.addEventListener("complete", () => judge(tx, t));
    }
    return t;
  };
  const tx0 = IDBDatabase.prototype.transaction;
  // (a FIXTURE: a transaction a test page's own code opens directly (its caller's frame in cases.js, or any frame
  // named fixtureTx), setting up a state to test, never the app's: not judged)
  const isFixture = () => {
    const frames = (new Error().stack ?? "").split("\n").slice(1).filter((l) => !/guard(-install)?\.js/.test(l) && /:\d+:\d+/.test(l));
    return /\/cases\.js:|fixtureTx/.test(frames[0] ?? "");
  };
  IDBDatabase.prototype.transaction = function (...a) {
    const judged = a[1] === "readwrite" && classOf(this) && (judgeFixtures || !isFixture());
    // (the generation it begins with, read by a transaction queued just before it: nothing can commit in between)
    let begin = null;
    if (judged && classOf(this) === "workspace") {
      const bt = tx0.call(this, ["ops", "meta"], "readonly"), c = bt.objectStore("ops").openKeyCursor(null, "prev"), f = bt.objectStore("meta").get("opsFloor");
      let last = 0;
      c.onsuccess = () => { last = c.result?.key ?? 0; };
      begin = new Promise((ok) => { bt.oncomplete = () => ok(Math.max(last, f.result ?? 0)); bt.onabort = () => ok(null); });
    }
    const tx = tx0.apply(this, a);
    if (judged) txState(tx).begin = begin;
    return tx;
  };
  const judge = (tx, t) => {
    const db = tx.db, s = shadowOf(db);
    G.txs++;
    // (GC: in a guarded run every notebooks database has history's stores; one without them, changed, fails)
    if (!G.inert && s.kind === "notebooks" && !db.objectStoreNames.contains("htokens")) {
      for (const [ident, { store }] of t.changed) G.violations.push({ db: db.name, ident, store, why: "a notebooks database without history's stores in a guarded run" });
      return;
    }
    if (s.meta.get("hactive") !== true) return;
    // (A5, A1.1, A1-T17: a workspace token's rev, EXACTLY: the seq of the last op its own transaction added before it
    // (an op's token: its own op), or, with none before it, the generation the transaction began with)
    if (s.kind === "workspace" && t.rows.some((r) => r.kind === "file" || r.kind === "folder")) {
      G.pending++;
      Promise.resolve(t.begin).then((begin) => {
        let last = begin;
        for (const ev of t.order) {
          if (ev.op) { last = ev.op.result; continue; }
          const r = ev.token;
          if ((r.kind === "file" || r.kind === "folder") && r.rev !== last) G.violations.push({ db: db.name, ident: r.ident, store: "htokens", why: `rev ${r.rev}, but the generation at its write point is ${last}` });
        }
        G.pending--;
      });
    }
    for (const [ident, { store, why }] of t.changed) {
      G.checked++;
      if (t.tokens.has(ident) || t.ovf || t.exhausted || s.meta.get("exhausted") === true) continue;
      G.violations.push({ db: db.name, ident, store, why });
    }
  };
  const mark = (t, ident, store, why) => t.changed.set(ident, { store, why });

  const storeOf = (x) => (x instanceof IDBObjectStore ? x : x.objectStore);
  const wrap = (proto, name, f) => {
    const orig = proto[name];
    proto[name] = function (...a) {
      const tx = this instanceof IDBCursor ? storeOf(this.source).transaction : this.transaction, t = tx && T.get(tx);
      if (t) f.call(this, t, tx, a);
      const r = orig.apply(this, a);
      // (each op's seq, as the store gives it: A5's exact-rev check, op by op (astra's A1.1 binding))
      if (t && name === "add" && this.name === "ops") t.order.push({ op: r });
      return r;
    };
  };
  const onWrite = function (t, tx, [value, key], del = false) {
    const st = this, s = shadowOf(tx.db), name = st.name, k = s.kind;
    if (name === "htokens" && !del) { t.tokens.add(value.ident); t.rows.push(value); t.order.push({ token: value }); return; }
    if (name === "hmeta" && !del) { s.meta.set(key, value); if (key === "ovf") t.ovf = true; if (key === "exhausted" && value === true) t.exhausted = true; return; }
    if (!SRC[k]?.has(name)) return;
    if (k === "workspace" && name === "entries") {
      if (del) {
        if (key instanceof IDBKeyRange) return; // (only a large move's control rows are deleted by range)
        const i = s.byPath.get(key);
        if (i) { mark(t, i, name, "removed"); s.byPath.delete(key); s.sig.delete(i); }
        return;
      }
      if (!value || !KINDS.has(value.kind)) return; // (a control row: a large move's record, mappings, queue)
      const i = identOf(value), sig = entrySig(value), was = s.sig.get(i);
      if (was !== sig) mark(t, i, name, was === undefined ? "added" : "content");
      s.sig.set(i, sig);
      s.byPath.set(value.path, i);
    } else if (name === "fileBytes") {
      if (del) {
        const sigs = [...s.sig.entries()];
        if (sigs.some(([i]) => i === key)) mark(t, key, name, "bytes removed"); // (orphans, no entry naming them, pass)
        s.bytes.delete(key);
        return;
      }
      const sg = sum(value);
      if (s.bytes.get(key) !== sg) mark(t, key, name, "bytes");
      s.bytes.set(key, sg);
    } else if (name === "boards") {
      const id = del ? key : value?.id, sg = del ? undefined : JSON.stringify([value?.doc, value?.rev]);
      if (s.board.get(id) !== sg) mark(t, id, name, del ? "removed" : "content");
      if (del) s.board.delete(id); else s.board.set(id, sg);
    } else if (name === "notebooks") {
      const id = del ? key : value?.id;
      if (id === FENCE || (!del && key === FENCE)) return;
      const sg = del ? undefined : strip(value);
      if (s.nb.get(id) !== sg) mark(t, id, name, del ? "removed" : "content");
      if (del) s.nb.delete(id); else s.nb.set(id, sg);
    }
  };
  wrap(IDBObjectStore.prototype, "put", function (t, tx, a) { onWrite.call(this, t, tx, [a[0], a[1] ?? (this.keyPath ? a[0]?.[this.keyPath] : undefined)]); });
  wrap(IDBObjectStore.prototype, "add", function (t, tx, a) { onWrite.call(this, t, tx, [a[0], a[1] ?? (this.keyPath ? a[0]?.[this.keyPath] : undefined)]); });
  wrap(IDBObjectStore.prototype, "delete", function (t, tx, a) { onWrite.call(this, t, tx, [undefined, a[0]], true); });
  wrap(IDBObjectStore.prototype, "clear", function (t, tx) {
    const s = shadowOf(tx.db), name = this.name;
    if (!SRC[s.kind]?.has(name)) return;
    const ids = name === "entries" ? [...s.byPath.values()] : name === "fileBytes" ? [...s.bytes.keys()] : name === "boards" ? [...s.board.keys()] : [...s.nb.keys()];
    for (const i of ids) mark(t, i, name, "cleared");
  });
  // (a cursor's writes: judged as the store's, with the cursor's current key; on an index's cursor, its store's)
  wrap(IDBCursor.prototype, "update", function (t, tx, a) { onWrite.call(storeOf(this.source), t, tx, [a[0], this.primaryKey]); });
  wrap(IDBCursor.prototype, "delete", function (t, tx) { onWrite.call(storeOf(this.source), t, tx, [undefined, this.primaryKey], true); });
  return G;
}
