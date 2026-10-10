// Stores for notebook documents (web/notebook/types.ts Store): where a
// notebook is kept, and how changes made elsewhere arrive.
//
//   MemoryStore   a document in memory (embeds, tests)
//   IdbStore      a document in this browser's IndexedDB; other tabs with the
//                 same notebook see each other's changes (BroadcastChannel)
//
// A CoCalc store (the Jupyter syncdb of a .ipynb in a project) has the same
// shape: load() reads the cells, save(doc) writes the changed records,
// subscribe() reports remote changes.
//
// Revisions: a stored document has a revision `rev`, one more at each write.
// A save carries `baseRev`, the revision it was made from, and is written
// only if that is still the stored one (compare and swap): {saved, rev};
// otherwise nothing is written and the result is {conflict: the stored
// document}, which the notebook merges (three ways, from the revision both
// started at) and saves again.  So two tabs editing different cells keep both
// edits, and no write is lost to a stale one (the systematic review's
// R2-DOC-F1).  A save without baseRev is written as it is.

// The record to write for doc over cur (the stored one), or null on a conflict.
function revise(cur, doc) {
  const { baseRev, ...rec } = doc;
  if (baseRev !== undefined && cur && (cur.rev ?? 0) !== baseRev) return null;
  return { ...rec, rev: (cur?.rev ?? 0) + 1 };
}

export class MemoryStore {
  constructor(doc = { mode: "python", cells: [] }) { this.doc = doc; this.subs = new Set(); }
  async load() { return structuredClone(this.doc); }
  async save(doc) {
    const rec = revise(this.doc, doc);
    if (!rec) return { conflict: structuredClone(this.doc) };
    this.doc = structuredClone(rec);
    return { saved: "saved", rev: rec.rev };
  }
  /** Simulate a change made elsewhere (a new revision). */
  push(doc) {
    this.doc = { ...structuredClone(doc), rev: (this.doc?.rev ?? 0) + 1 };
    for (const f of this.subs) f(structuredClone(this.doc));
  }
  subscribe(f) { this.subs.add(f); return () => this.subs.delete(f); }
}

// IndexedDB "sagebrush": object stores "notebooks" (by id) and "files" (by
// path); "sagebrush-history": "history" (TimeTravel's patches, by [notebook
// id, patch id]).  They are opened at whatever version they have, never
// upgraded: an upgrade waits until every page holding the database closes,
// and a page of an older version of the site (another tab, the installed
// app) would hold it.  New stores go in new databases.  A page lets go of a
// database when a newer page needs it (onVersionChange, e.g. to ask for a
// reload).
function open(name, stores, onVersionChange) {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open(name);
      r.onupgradeneeded = () => { // only when it is created
        for (const [store, opts] of Object.entries(stores)) if (!r.result.objectStoreNames.contains(store)) r.result.createObjectStore(store, opts ?? undefined);
      };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => { db.close(); onVersionChange?.(); };
        resolve(db);
      };
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}
export const openDb = (name = "sagebrush", { onVersionChange } = {}) => open(name, { notebooks: { keyPath: "id" }, files: null }, onVersionChange);
export const openHistoryDb = ({ onVersionChange } = {}) => open("sagebrush-history", { history: { keyPath: ["nb", "time"] } }, onVersionChange);
export function idb(db, store, mode, f) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve(undefined);
    const tx = db.transaction(store, mode);
    const r = f(tx.objectStore(store));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
  });
}

const tabId = Math.random().toString(36).slice(2);
let channel = null;
const channelSubs = new Set();
function getChannel() {
  if (!channel && typeof BroadcastChannel === "function") {
    channel = new BroadcastChannel("sagebrush-notebooks");
    channel.onmessage = (ev) => { if (ev.data?.from !== tabId) for (const f of channelSubs) f(ev.data); };
  }
  return channel;
}

export class IdbStore {
  /** @param db an IndexedDB database from openDb(); @param id the notebook's id; @param initial its document if it is new */
  constructor(db, id, initial = null) { this.db = db; this.id = id; this.initial = initial; }
  async load() {
    const doc = await idb(this.db, "notebooks", "readonly", (st) => st.get(this.id));
    if (doc) return doc;
    const fresh = { ...(this.initial ?? { name: "Untitled", mode: "python", cells: [] }), id: this.id };
    await this.save(fresh);
    return fresh;
  }
  async save(doc) {
    if (!this.db) return "not saved: this browser has no storage";
    // read and write in one transaction: the compare and swap is atomic
    const out = await new Promise((resolve, reject) => {
      const tx = this.db.transaction("notebooks", "readwrite"), st = tx.objectStore("notebooks");
      let result = null;
      const get = st.get(this.id);
      get.onsuccess = () => {
        const rec = revise(get.result, { ...doc, id: this.id, updated: Date.now() });
        if (!rec) result = { conflict: get.result };
        else {
          st.put(rec);
          result = { rec };
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
    if (out.conflict) return { conflict: out.conflict };
    getChannel()?.postMessage({ from: tabId, id: this.id, doc: out.rec });
    return { saved: "saved in this browser", rev: out.rec.rev };
  }
  subscribe(f) {
    if (!getChannel()) return () => {};
    const g = (m) => { if (m.id === this.id) f(m.doc); };
    channelSubs.add(g);
    return () => channelSubs.delete(g);
  }
}

// TimeTravel's patches for one notebook (a patchflow PatchStore): kept in
// IndexedDB, and passed to the other tabs that have the notebook open.
let historyChannel = null;
const historySubs = new Set();
function getHistoryChannel() {
  if (!historyChannel && typeof BroadcastChannel === "function") {
    historyChannel = new BroadcastChannel("sagebrush-history");
    historyChannel.onmessage = (ev) => { if (ev.data?.from !== tabId) for (const f of historySubs) f(ev.data); };
  }
  return historyChannel;
}
export class IdbPatchStore {
  constructor(db, id) { this.db = db; this.id = id; }
  range() { return IDBKeyRange.bound([this.id, ""], [this.id, "\uffff"]); }
  async loadInitial() {
    const rows = (await idb(this.db, "history", "readonly", (st) => st.getAll(this.range()))) ?? [];
    return { patches: rows.map((r) => r.env), hasMore: false };
  }
  append(env) {
    idb(this.db, "history", "readwrite", (st) => st.put({ nb: this.id, time: env.time, env })).catch((e) => console.warn("history:", e));
    getHistoryChannel()?.postMessage({ from: tabId, id: this.id, env });
  }
  subscribe(f) {
    const g = (m) => { if (m.id === this.id && m.env) f(m.env); };
    getHistoryChannel();
    historySubs.add(g);
    return () => historySubs.delete(g);
  }
  /** Called when another tab clears this notebook's history. */
  onClear(f) {
    const g = (m) => { if (m.id === this.id && m.clear) f(); };
    getHistoryChannel();
    historySubs.add(g);
    return () => historySubs.delete(g);
  }
  async clear() {
    await idb(this.db, "history", "readwrite", (st) => st.delete(this.range()));
    getHistoryChannel()?.postMessage({ from: tabId, id: this.id, clear: true });
  }
  /** Forget this notebook's history without telling anyone (the notebook was deleted). */
  async drop() { await idb(this.db, "history", "readwrite", (st) => st.delete(this.range())); }
}
