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
// (a workspace's meta keys that say a reset to a new workspace is under way: "resetting" while its own stores are emptied,
// then "purgeMain" while its notebooks database is.  A NEW lineage: its history's stores are emptied by the same reset
// (census EXEMPT, A1-T8), so what it removes is recorded nowhere, by design)
// A flag left set by a reset that stopped part way (a crash) keeps exempting removals until it is cleared: the app's next
// open resumes that same reset (the flag is its resume state), which finishes emptying the stores and deletes the flag.
const CTL = ["resetting", "purgeMain"];
const TRASH = "/Trash";

export function installGuard({ inert = false, skipOpener = () => false, judgeFixtures = false } = {}) {
  const G = { violations: [], checked: 0, txs: 0, pending: 0, inert, dbs: new Map(), lastWs: null };
  window.__historyGuard = G;
  const classOf = (db) => (db.objectStoreNames.contains("ops") && db.objectStoreNames.contains("entries") ? "workspace" : db.objectStoreNames.contains("notebooks") && db.objectStoreNames.contains("files") ? "notebooks" : null);
  // (each source database's shadow: what the guard knows of its rows, to judge a write a change or not)
  const shadowOf = (db) => {
    let s = G.dbs.get(db.name);
    if (!s) G.dbs.set(db.name, (s = { kind: classOf(db), byPath: new Map(), ent: new Map(), bytes: new Map(), board: new Map(), nb: new Map(), meta: new Map(), ctl: new Map(), trash: new Map(), files: new Map(), pathOf: new Map(), owner: undefined }));
    return s;
  };
  const sum = (b) => { let h = 2166136261 >>> 0; const u = b instanceof Uint8Array ? b : new Uint8Array(b?.buffer ?? b ?? []); for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619) >>> 0; return `${u.length}:${h}`; };
  // (an entry's content, as the shadow keeps it; its identity is the shadow's key)
  const entryOf = (e) => ({ kind: e.kind, ref: e.ref ?? null, sha256: e.sha256 ?? null, size: e.size ?? null, trashed: !!e.trashed, migrated: !!e.migrated });
  // (changed: its kind, document, or Trash; its bytes' hash and size, once a hash was recorded.  With none recorded
  // yet, a hash and size being recorded is the migrator's (fillHash, migrateOne: from the bytes already there, which
  // fileBytes' own judging covers), not a change of content)
  // (a data file's or folder's ref is where its legacy bytes were kept, following its path (a move rewrites it): not its
  // content, which its fid's bytes are; a document's ref IS its identity)
  const contentChanged = (o, n) => o.kind !== n.kind || (o.kind !== "file" && o.kind !== "folder" && o.ref !== n.ref) || o.trashed !== n.trashed || (o.sha256 !== null && (o.sha256 !== n.sha256 || o.size !== n.size));
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
      // (which workspace a notebooks database belongs to: Workspace.open opens the workspace's database, then its
      // notebooks database, with no other source database between.  Two workspaces opened before a notebooks database
      // leave it UNPAIRED (owner null), and an unpaired database is judged closed: no reset exempts it, no legacy bytes are
      // known in it)
      if (k === "workspace") G.lastWs = G.lastWs === null ? db.name : "\u0000ambiguous";
      else {
        // (paired once by Workspace.open's order; a later open of the same database (the app's other stores open it too)
        // keeps that pairing; never paired: unpaired)
        const o = shadowOf(db);
        if (G.lastWs && G.lastWs !== "\u0000ambiguous") o.owner = G.lastWs; else if (o.owner === undefined) o.owner = null;
        G.lastWs = null;
      }
      shadowOf(db);
      if (!db.objectStoreNames.contains("hmeta")) return;
      const s = shadowOf(db);
      // (created now, so queued before any transaction the app makes once it has the connection)
      const stores = [...SRC[k], "hmeta", ...(k === "workspace" ? ["meta", "trash"] : ["files"])].filter((x) => db.objectStoreNames.contains(x));
      const tx = db.transaction(stores, inert ? "readonly" : "readwrite");
      if (!inert) tx.objectStore("hmeta").put(true, "hactive");
      const all = (st, f) => { const c = tx.objectStore(st).openCursor(); c.onsuccess = () => { const x = c.result; if (!x) return; f(x.key, x.value); x.continue(); }; };
      all("hmeta", (key, v) => s.meta.set(key, v));
      if (k === "workspace") {
        all("entries", (key, e) => { if (e && KINDS.has(e.kind)) { const i = identOf(e); s.byPath.set(key, i); s.pathOf.set(i, key); s.ent.set(i, entryOf(e)); } });
        if (db.objectStoreNames.contains("trash")) all("trash", (key, b) => s.trash.set(key, sum(b)));
        all("fileBytes", (key, b) => s.bytes.set(key, sum(b)));
        all("boards", (key, b) => s.board.set(key, JSON.stringify([b?.doc, b?.rev])));
        for (const key of CTL) { const g = tx.objectStore("meta").get(key); g.onsuccess = () => { if (g.result !== undefined) s.ctl.set(key, g.result); }; }
      } else {
        all("notebooks", (key, v) => { if (key !== FENCE) s.nb.set(key, strip(v)); });
        all("files", (key, b) => s.files.set(key, sum(b)));
      }
    });
    return r;
  };

  // (the app's upgrade handler, assigned after open() returns, runs AFTER the listener above: at its creation of the
  // notebooks database's stores, history's are made too, in the same upgrade)
  const cos0 = IDBDatabase.prototype.createObjectStore;
  IDBDatabase.prototype.createObjectStore = function (...a) {
    const st = cos0.apply(this, a);
    const has = (x) => this.objectStoreNames.contains(x);
    if (!skipOpener(this.name) && has("notebooks") && has("files") && !has("htokens")) { cos0.call(this, "htokens", { keyPath: "seq" }); cos0.call(this, "hmeta"); }
    return st;
  };

  // ---- transactions: what each changed, and what it witnessed
  const T = new WeakMap();
  const txState = (tx) => {
    let t = T.get(tx);
    if (!t) {
      t = { changed: new Map(), tokens: new Set(), rows: [], order: [], begin: null, ovf: false, exhausted: false, migrated: new Map(), site: null, judged: true, hmetaGone: false, removedAt: new Map() };
      T.set(tx, t);
      tx.addEventListener("complete", () => judge(tx, t));
    }
    return t;
  };
  const tx0 = IDBDatabase.prototype.transaction;
  // (a FIXTURE: a transaction a test page's own code opens directly (its caller's frame in cases.js, or any frame
  // named fixtureTx), setting up a state to test, never the app's: not judged, but its writes still kept in the shadow,
  // so the app's later writes over them are judged against what is really there)
  const callerFrames = () => (new Error().stack ?? "").split("\n").slice(1).filter((l) => !/guard(-install)?\.js/.test(l) && /:\d+:\d+/.test(l));
  const isFixture = (frames) => /\/cases\.js:|fixtureTx/.test(frames[0] ?? "");
  IDBDatabase.prototype.transaction = function (...a) {
    const frames = a[1] === "readwrite" && classOf(this) ? callerFrames() : null;
    const judged = frames !== null && (judgeFixtures || !isFixture(frames));
    // (the generation it begins with, read by a transaction queued just before it: nothing can commit in between)
    let begin = null;
    if (frames !== null && !judged) { const tx = tx0.apply(this, a); txState(tx).judged = false; return tx; }
    if (judged && classOf(this) === "workspace") {
      const bt = tx0.call(this, ["ops", "meta"], "readonly"), c = bt.objectStore("ops").openKeyCursor(null, "prev"), f = bt.objectStore("meta").get("opsFloor");
      let last = 0;
      c.onsuccess = () => { last = c.result?.key ?? 0; };
      begin = new Promise((ok) => { bt.oncomplete = () => ok(Math.max(last, f.result ?? 0)); bt.onabort = () => ok(null); });
    }
    const tx = tx0.apply(this, a);
    // (where it was made, for a violation's report: the first frames outside the guard)
    if (judged) { const t = txState(tx); t.begin = begin; t.site = frames.slice(0, 3).map((l) => l.trim().replace(/^at /, "").replace(/https?:\/\/[^/]+\//, "")).join(" < "); }
    return tx;
  };
  const judge = (tx, t) => {
    const db = tx.db, s = shadowOf(db);
    // (the shadow's effects of what this transaction removed, now that it committed)
    for (const [i, { store, why }] of t.changed) if (store === "entries" && why === "removed") s.ent.delete(i);
    for (const [i, { store, why }] of t.removedQuiet ?? []) if (store === "entries" && why === "removed") s.ent.delete(i);
    if (!t.judged) return;
    G.txs++;
    // (GC: in a guarded run every notebooks database has history's stores; one without them, changed, fails)
    if (!G.inert && s.kind === "notebooks" && !db.objectStoreNames.contains("htokens")) {
      for (const [ident, { store }] of t.changed) G.violations.push({ db: db.name, ident, store, why: "a notebooks database without history's stores in a guarded run", site: t.site });
      return;
    }
    // (G3: history's state removed outside a reset: the guard (and history) would be switched off silently)
    if (t.hmetaGone) G.violations.push({ db: db.name, ident: "hmeta", store: "hmeta", why: "history state removed outside a reset", site: t.site });
    if (s.meta.get("hactive") !== true) return;
    // (A5, A1.1, A1-T17, astra3: every token's rev EXACTLY, by its WRITER, not its kind alone:
    //   an index token (the event just before it an op its transaction added: log()): that op's own seq;
    //   a content token of a board or notebook row (boardRowWrite, a notebook save or delete): that row's rev, 0 for a
    //   delete;
    //   any other workspace token (a publication's, a fetch's install): the generation at its write point, the last op
    //   its transaction added before it, or, with none, the generation the transaction began with)
    if (t.rows.length) {
      G.pending++;
      Promise.resolve(t.begin).then((begin) => {
        let last = begin, prev = null;
        const rowRev = new Map();
        for (const ev of t.order) {
          if (ev.op) { last = ev.op.result; prev = ev; continue; }
          if (ev.row) { rowRev.set(ev.row.id, ev.row.rev); prev = ev; continue; }
          const r = ev.token;
          let want, writer;
          // (an index token: the op just before it is ITS op, naming the same identity; an unrelated op before a row's
          // token doesn't make it one)
          if (prev?.op && prev.of === r.ident) { want = prev.op.result; writer = "an op's"; }
          else if (r.kind === "board" || r.kind === "notebook") { want = rowRev.get(r.ident); writer = "a row's"; }
          else { want = last; writer = "a no-op"; }
          if (s.kind === "workspace" || writer === "a row's") if (r.rev !== want) G.violations.push({ db: db.name, ident: r.ident, store: "htokens", why: `${writer} token: rev ${r.rev}, want ${want}`, site: t.site });
          prev = ev;
        }
        G.pending--;
      });
    }
    for (const [ident, { store, why }] of t.changed) {
      G.checked++;
      if (t.tokens.has(ident) || t.ovf || t.exhausted || s.meta.get("exhausted") === true) continue;
      // (G1: a data file's bytes put under the fid its entry is given, migrated, in this transaction: the migrator moving
      // a file's bytes (migrateOne), passed only if they ARE the legacy bytes: the same sum as the copy it moved from,
      // in this workspace's Trash store or its own notebooks database's files)
      // (a subtree removed with its top (emptyTrash, a folder's removal): an entry, or its bytes, removed under a folder
      // removed in this transaction whose own token is here; log() names the top, its subtree goes with it)
      if ((why === "removed" || why === "bytes removed") && underRemovedTop(t, t.removedAt.get(ident) ?? s.pathOf.get(ident))) continue;
      if (store === "fileBytes" && t.migrated.has(ident)) {
        const from = t.migrated.get(ident), had = legacySum(s, db.name, from), now = s.bytes.get(ident);
        if (had !== undefined && had === now) continue;
        G.violations.push({ db: db.name, ident, store, why: had === undefined ? `migrated bytes with no legacy copy known (${from.ref})` : "migrated bytes differ from the legacy copy", site: t.site });
        continue;
      }
      G.violations.push({ db: db.name, ident, store, why, site: t.site });
    }
  };
  // (G2: a reset under way, for THIS database: a workspace's own "resetting"; a notebooks database's OWNER's "purgeMain")
  const purging = (s) => (s.kind === "workspace" ? s.ctl.has("resetting") : !!s.owner && !!G.dbs.get(s.owner)?.ctl.has("purgeMain"));
  const mark = (t, ident, store, why, s) => {
    if (s && /removed|cleared/.test(why) && purging(s)) { (t.removedQuiet ??= new Map()).set(ident, { store, why }); return; }
    t.changed.set(ident, { store, why });
  };
  const underRemovedTop = (t, path) => {
    if (typeof path !== "string") return false;
    for (const [i, p] of t.removedAt) if (t.tokens.has(i) && p !== path && path.startsWith(p + "/")) return true;
    return false;
  };
  // (the legacy copy's sum a migrated file was moved from: a trashed one's in the workspace's own Trash store, else
  // in its notebooks database's files; undefined when that database isn't paired, or holds no such copy)
  const legacySum = (s, wsName, from) => {
    if (from.trashed) return s.trash.get(from.ref);
    const main = [...G.dbs.values()].find((x) => x.kind === "notebooks" && x.owner === wsName);
    return main?.files.get(from.ref);
  };

  const storeOf = (x) => (x instanceof IDBObjectStore ? x : x.objectStore);
  const wrap = (proto, name, f) => {
    const orig = proto[name];
    proto[name] = function (...a) {
      const tx = this instanceof IDBCursor ? storeOf(this.source).transaction : this.transaction, t = tx && T.get(tx);
      if (t) f.call(this, t, tx, a);
      const r = orig.apply(this, a);
      // (each op's seq, as the store gives it: A5's exact-rev check, op by op (astra's A1.1 binding))
      if (t && name === "add" && this.name === "ops") t.order.push({ op: r, of: a[0]?.fid ?? a[0]?.ref ?? (a[0]?.path ? `path:${a[0].path}` : null) });
      return r;
    };
  };
  const onWrite = function (t, tx, [value, key], del = false) {
    const st = this, s = shadowOf(tx.db), name = st.name, k = s.kind;
    if (name === "htokens" && !del) { t.tokens.add(value.ident); t.rows.push(value); t.order.push({ token: value }); return; }
    if (name === "hmeta" && !del) { s.meta.set(key, value); if (key === "ovf") t.ovf = true; if (key === "exhausted" && value === true) t.exhausted = true; return; }
    if (name === "meta" && k === "workspace") { if (CTL.includes(key)) { if (del) s.ctl.delete(key); else s.ctl.set(key, value); } return; }
    // (history's state removed: by a reset to a new workspace (it empties hmeta: history inactive here until set again),
    // or, outside one, a violation (G3))
    if (name === "hmeta" && del) {
      if (!purging(s)) t.hmetaGone = true;
      if (key instanceof IDBKeyRange) { for (const x of [...s.meta.keys()]) if (key.includes(x)) s.meta.delete(x); } else s.meta.delete(key);
      return;
    }
    // (the legacy copies a migration may move from: their sums, G1)
    if (k === "workspace" && name === "trash") { if (key instanceof IDBKeyRange) return; if (del) s.trash.delete(key); else s.trash.set(key, sum(value)); return; }
    if (k === "notebooks" && name === "files") { if (key instanceof IDBKeyRange) return; if (del) s.files.delete(key); else s.files.set(key, sum(value)); return; }
    if (!SRC[k]?.has(name)) return;
    if (k === "workspace" && name === "entries") {
      if (del) {
        if (key instanceof IDBKeyRange) return; // (only a large move's control rows are deleted by range)
        const i = s.byPath.get(key);
        s.byPath.delete(key);
        // (the identity now at ANOTHER path (a move that put its new row first): its old row deleted, nothing removed)
        if (i && s.pathOf.get(i) === key) { mark(t, i, name, "removed", s); t.removedAt.set(i, key); s.pathOf.delete(i); }
        return;
      }
      if (!value || !KINDS.has(value.kind)) return; // (a control row: a large move's record, mappings, queue)
      // (Trash's own folder: the workspace's, with no identity and nothing synced (log() writes it no token), as the root)
      if (value.path === TRASH) return;
      const i = identOf(value), n = entryOf(value);
      let was = s.ent.get(i);
      // (an identity GIVEN: the entry at this path had none (named by its path) and has one now, still the same kind and
      // document: the migrator's fillIdentity or migrateOne, the same entry under its identity, not a new one)
      const prev = s.byPath.get(value.path);
      if (was === undefined && prev !== undefined && prev !== i && prev.startsWith("path:") && s.ent.get(prev)?.kind === n.kind && s.ent.get(prev)?.ref === n.ref) {
        was = s.ent.get(prev);
        s.ent.delete(prev);
        t.changed.delete(prev);
      }
      // (a move that deleted its old row first: the identity is back, at its new path: not removed)
      if (t.changed.get(i)?.why === "removed") t.changed.delete(i);
      t.removedAt.delete(i); // (back, so not a removed top for its subtree)
      if (was !== undefined && !was.migrated && n.migrated && value.fid) t.migrated.set(value.fid, { ref: value.ref, trashed: !!value.trashed || value.path === TRASH || value.path.startsWith(TRASH + "/") });
      if (was === undefined) mark(t, i, name, "added", s);
      else if (contentChanged(was, n)) mark(t, i, name, "content", s);
      s.ent.set(i, n);
      s.byPath.set(value.path, i);
      s.pathOf.set(i, value.path);
    } else if (name === "fileBytes") {
      if (del) {
        if (s.ent.has(key)) mark(t, key, name, "bytes removed", s); // (orphans, no entry naming them, pass)
        s.bytes.delete(key);
        return;
      }
      const sg = sum(value);
      if (s.bytes.get(key) !== sg) mark(t, key, name, "bytes", s);
      s.bytes.set(key, sg);
    } else if (name === "boards") {
      const id = del ? key : value?.id, sg = del ? undefined : JSON.stringify([value?.doc, value?.rev]);
      t.order.push({ row: { id, rev: del ? 0 : value?.rev } });
      if (s.board.get(id) !== sg) mark(t, id, name, del ? "removed" : "content", s);
      if (del) s.board.delete(id); else s.board.set(id, sg);
    } else if (name === "notebooks") {
      const id = del ? key : value?.id;
      if (id === FENCE || (!del && key === FENCE)) return;
      const sg = del ? undefined : strip(value);
      t.order.push({ row: { id, rev: del ? 0 : value?.rev } });
      if (s.nb.get(id) !== sg) mark(t, id, name, del ? "removed" : "content", s);
      if (del) s.nb.delete(id); else s.nb.set(id, sg);
    }
  };
  wrap(IDBObjectStore.prototype, "put", function (t, tx, a) { onWrite.call(this, t, tx, [a[0], a[1] ?? (this.keyPath ? a[0]?.[this.keyPath] : undefined)]); });
  wrap(IDBObjectStore.prototype, "add", function (t, tx, a) { onWrite.call(this, t, tx, [a[0], a[1] ?? (this.keyPath ? a[0]?.[this.keyPath] : undefined)]); });
  wrap(IDBObjectStore.prototype, "delete", function (t, tx, a) { onWrite.call(this, t, tx, [undefined, a[0]], true); });
  wrap(IDBObjectStore.prototype, "clear", function (t, tx) {
    // (G3 and the shadow: the clear's own effects)
    const s = shadowOf(tx.db), name = this.name;
    if (name === "hmeta") { if (!purging(s)) t.hmetaGone = true; s.meta.clear(); return; }
    if (s.kind === "workspace" && name === "trash") { s.trash.clear(); return; }
    if (s.kind === "notebooks" && name === "files") { s.files.clear(); return; }
    if (!SRC[s.kind]?.has(name)) return;
    const ids = name === "entries" ? [...s.byPath.values()] : name === "fileBytes" ? [...s.bytes.keys()] : name === "boards" ? [...s.board.keys()] : [...s.nb.keys()];
    for (const i of ids) mark(t, i, name, "cleared", s);
  });
  // (a cursor's writes: judged as the store's, with the cursor's current key; on an index's cursor, its store's)
  wrap(IDBCursor.prototype, "update", function (t, tx, a) { onWrite.call(storeOf(this.source), t, tx, [a[0], this.primaryKey]); });
  wrap(IDBCursor.prototype, "delete", function (t, tx) { onWrite.call(storeOf(this.source), t, tx, [undefined, this.primaryKey], true); });
  return G;
}
