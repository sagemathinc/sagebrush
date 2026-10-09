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

export class MemoryStore {
  constructor(doc = { mode: "python", cells: [] }) { this.doc = doc; this.subs = new Set(); }
  async load() { return structuredClone(this.doc); }
  async save(doc) { this.doc = structuredClone(doc); return "saved"; }
  /** Simulate a change made elsewhere. */
  push(doc) { this.doc = structuredClone(doc); for (const f of this.subs) f(structuredClone(doc)); }
  subscribe(f) { this.subs.add(f); return () => this.subs.delete(f); }
}

// IndexedDB "sagebrush": object stores "notebooks" (by id) and "files" (by path)
export function openDb(name = "sagebrush") {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("notebooks", { keyPath: "id" }); r.result.createObjectStore("files"); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
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
    const rec = { ...doc, id: this.id, updated: Date.now() };
    await idb(this.db, "notebooks", "readwrite", (st) => st.put(rec));
    getChannel()?.postMessage({ from: tabId, id: this.id, doc: rec });
    return "saved in this browser";
  }
  subscribe(f) {
    if (!getChannel()) return () => {};
    const g = (m) => { if (m.id === this.id) f(m.doc); };
    channelSubs.add(g);
    return () => channelSubs.delete(g);
  }
}
