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
// id, patch id]); "sagebrush-blobs" (below).  They are opened at whatever version they have, never
// upgraded: an upgrade waits until every page holding the database closes,
// and a page of an older version of the site (another tab, the installed
// app) would hold it.  New stores go in new databases.  A page lets go of a
// database when a newer page needs it (onVersionChange, e.g. to ask for a
// reload).
// (what refuses every save to the notebooks while it says why: set by the page, design/workspace-durability.md A.3)
let saveGate = null;
/** `f()`: why saves are refused now (a string), or nothing to let them go. */
export function setSaveGate(f) { saveGate = f; }
/** The workspace's fence, a record of its own in the notebooks' store (and in their history's): its identity and
 * whether it is quarantined or being reset, written by the workspace (design/workspace-durability.md A.3).  A
 * notebook's or its history's write reads it in the write's own transaction, and is refused when it says the
 * workspace is quarantined, or names another workspace than the one the store first found: a store opened
 * before a reset (or in a tab whose page knows nothing of it) can't write into the next workspace (astra's
 * CORR-2A4-2).  Every list of notebooks passes it over. */
export const FENCE = "__sagebrush-workspace__";
// (the rules, the same for every write (astra's CORR-2A4-2 on 0eefec71): a store is bound to the fence it found
// when it loaded, read in the same transaction as the document; a write is allowed only if the fence now is that
// same workspace and generation, in phase "ok"; a fence that appeared since a store found none, or went since it
// found one (an unwritable fence is deleted, so that this fails closed), refuses it)
const fenceRefusal = (f, seen) => {
  if (!f) return seen ? "this browser's record of the workspace is missing: reload this page" : null;
  if (f.quarantined) return "this browser's copy of your workspace was lost or is missing changes: choose what to do first";
  if (f.phase && f.phase !== "ok") return f.phase === "quarantined" ? "this browser's copy of your workspace was lost or is missing changes: choose what to do first" : "this browser's workspace is being reset: wait for it, then reload";
  if (seen === null) return "the workspace was set up after this notebook was opened: reload this page";
  if (seen && (f.workspace !== seen.workspace || f.generation !== seen.generation)) return "the workspace was reset in another tab: reload this page";
  return null;
};
const fenceOf = (f) => (f && typeof f.workspace === "string" ? { workspace: f.workspace, generation: f.generation } : null);
// (why a save is refused now by the page: its gate)
const refusal = () => saveGate?.() || null;

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
// "sagebrush-board-history": "history", boards' TimeTravel (web/board/history.ts), by [board id, patch id]: apart from notebooks'.
export const openBoardHistoryDb = ({ onVersionChange } = {}) => open("sagebrush-board-history", { history: { keyPath: ["nb", "time"] } }, onVersionChange);
// "sagebrush-blobs": "blobs", file contents by their hash.  TimeTravel's
// journal keeps only the hashes of the files a session read; replay and the
// portable bundle find the bytes here.
export const openBlobDb = ({ onVersionChange } = {}) => open("sagebrush-blobs", { blobs: null }, onVersionChange);

/** The SHA-256 of bytes, in hex (a 53-bit hash, "c53:...", where there is no crypto.subtle: not a secure context). */
export async function bytesHash(data) {
  if (globalThis.crypto?.subtle) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h1 = 0xdeadbeef ^ data.length, h2 = 0x41c6ce57 ^ data.length;
  for (let i = 0; i < data.length; i++) { h1 = Math.imul(h1 ^ data[i], 2654435761); h2 = Math.imul(h2 ^ data[i], 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return "c53:" + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/** Keep bytes by their hash; resolves to the hash. */
export async function putBlob(db, data) {
  const hash = await bytesHash(data);
  if (db) {
    const have = await idb(db, "blobs", "readonly", (st) => st.getKey(hash)).catch(() => undefined);
    if (have === undefined) await idb(db, "blobs", "readwrite", (st) => st.put(data, hash)).catch((e) => console.warn("blobs:", e));
  }
  return hash;
}
export const getBlob = (db, hash) => idb(db, "blobs", "readonly", (st) => st.get(hash)).catch(() => undefined);
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
    // (the document and the fence it belongs with, read in one transaction: the workspace this store writes into)
    const both = this.db ? await new Promise((ok, no) => {
      const tx = this.db.transaction("notebooks", "readonly"), st = tx.objectStore("notebooks"), d = st.get(this.id), f = st.get(FENCE);
      tx.oncomplete = () => ok({ doc: d.result, fence: f.result });
      tx.onerror = () => no(tx.error);
    }) : { doc: undefined, fence: undefined };
    if (this.fence === undefined) this.fence = fenceOf(both.fence);
    const doc = both.doc;
    if (doc) return doc;
    const fresh = { ...(this.initial ?? { name: "Untitled", mode: "python", cells: [] }), id: this.id };
    await this.save(fresh);
    return fresh;
  }
  async save(doc) {
    if (!this.db) return "not saved: this browser has no storage";
    // (refused while the page says so: the workspace quarantined, design/workspace-durability.md A.3)
    const gate = refusal();
    if (gate) return `not saved: ${gate}`;
    // read and write in one transaction: the compare and swap is atomic, and so is the fence's check
    const out = await new Promise((resolve, reject) => {
      const tx = this.db.transaction("notebooks", "readwrite"), st = tx.objectStore("notebooks");
      let result = null;
      const fence = st.get(FENCE);
      fence.onsuccess = () => {
        // (a store saving before it loaded binds to the fence it finds now)
        if (this.fence === undefined) this.fence = fenceOf(fence.result);
        const why = fenceRefusal(fence.result, this.fence);
        if (why) result = { refused: why };
      };
      const get = st.get(this.id);
      get.onsuccess = () => {
        if (result?.refused) return;
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
    if (out.refused) return `not saved: ${out.refused}`;
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
  // (refused, said, by the page's gate or the fence)
  async allowed() {
    const why = refusal() || fenceRefusal((await idb(this.db, "history", "readonly", (st) => st.get([FENCE, ""])).catch(() => undefined))?.fence, this.fence);
    if (why) throw new Error(`not done: ${why}`);
  }
  range() { return IDBKeyRange.bound([this.id, ""], [this.id, "\uffff"]); }
  async loadInitial() {
    // (the rows and the fence they belong with, in one transaction)
    const both = this.db ? await new Promise((ok, no) => {
      const tx = this.db.transaction("history", "readonly"), st = tx.objectStore("history"), r = st.getAll(this.range()), f = st.get([FENCE, ""]);
      tx.oncomplete = () => ok({ rows: r.result, fence: f.result?.fence });
      tx.onerror = () => no(tx.error);
    }) : { rows: [], fence: undefined };
    if (this.fence === undefined) this.fence = fenceOf(both.fence);
    const rows = both.rows ?? [];
    return { patches: rows.map((r) => r.env), hasMore: false };
  }
  append(env) {
    // (not while the page refuses saves, nor when the fence says no, checked in the write's own transaction)
    if (refusal() || !this.db) return;
    const tx = this.db.transaction("history", "readwrite"), st = tx.objectStore("history"), f = st.get([FENCE, ""]);
    f.onsuccess = () => {
      if (this.fence === undefined) this.fence = fenceOf(f.result?.fence);
      if (fenceRefusal(f.result?.fence, this.fence)) return;
      st.put({ nb: this.id, time: env.time, env });
    };
    tx.onerror = () => console.warn("history:", tx.error);
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
    await this.allowed();
    await this.deleteChecked();
    getHistoryChannel()?.postMessage({ from: tabId, id: this.id, clear: true });
  }
  /** Forget this notebook's history without telling anyone (the notebook was deleted). */
  async drop() {
    await this.allowed();
    await this.deleteChecked();
  }
  // (the rows deleted only if the fence, read in the same transaction, still allows it)
  async deleteChecked() {
    if (!this.db) return;
    const why = await new Promise((ok, no) => {
      const tx = this.db.transaction("history", "readwrite"), st = tx.objectStore("history"), f = st.get([FENCE, ""]);
      let refused = null;
      f.onsuccess = () => { refused = fenceRefusal(f.result?.fence, this.fence); if (!refused) st.delete(this.range()); };
      tx.oncomplete = () => ok(refused);
      tx.onerror = () => no(tx.error);
    });
    if (why) throw new Error(`not done: ${why}`);
  }
}
