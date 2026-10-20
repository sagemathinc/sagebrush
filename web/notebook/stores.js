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
// found one, refuses it.  A fence is never deleted.  Which records the workspace owns is decided by
// ownedByWorkspace, never by whether a fence is there)
const fenceRefusal = (f, seen) => {
  if (!f) return seen ? "this browser's record of the workspace is missing: reload this page" : null;
  if (f.quarantined) return "this browser's copy of your workspace was lost or is missing changes: choose what to do first";
  if (f.phase && f.phase !== "ok") return f.phase === "quarantined" ? "this browser's copy of your workspace was lost or is missing changes: choose what to do first" : "this browser's workspace is being reset: wait for it, then reload";
  if (seen === null) return "the workspace was set up after this notebook was opened: reload this page";
  if (seen && (f.workspace !== seen.workspace || f.generation !== seen.generation)) return "the workspace was reset in another tab: reload this page";
  return null;
};
const fenceOf = (f) => (f && typeof f.workspace === "string" ? { workspace: f.workspace, generation: f.generation, primary: typeof f.primary === "string" ? f.primary : undefined } : null);
// (the authority every write to an owned record confirms, besides the fence: the workspace's own meta, in the
// database the fence names (the workspace's, "sagebrush-workspace", where there is no fence yet), read before
// each write.  The write goes only if meta positively says so: the same identity as the fence, nothing
// quarantined, being reset or purged, and this database not marked blocked (its fence couldn't be written, or a
// fence of another generation was found there).  Anything else, an error or a denial included, refuses: a store
// in another copy of this module, another tab, or a page with nothing wired, the same (astra's CORR-2A4-2 and
// CORR-56C-1 on 56c60932))
const PRIMARY = "sagebrush-workspace";
const primaries = new Map();
// (the workspace's database, opened as it is, never made: null if there is none)
function primaryDb(name) {
  let p = primaries.get(name);
  if (!p) {
    p = new Promise((ok, no) => {
      let absent = false;
      const r = indexedDB.open(name);
      r.onupgradeneeded = () => { absent = true; r.transaction.abort(); };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => { db.close(); primaries.delete(name); };
        db.onclose = () => primaries.delete(name);
        ok(db);
      };
      r.onerror = (e) => { e.preventDefault?.(); absent ? ok(null) : no(r.error); };
      r.onblocked = () => no(new Error("the workspace's database is being upgraded"));
    });
    primaries.set(name, p);
    p.then((db) => { if (!db) primaries.delete(name); }, () => primaries.delete(name));
  }
  return p;
}
const readMeta = (db) => new Promise((ok, no) => {
  const tx = db.transaction("meta", "readonly"), st = tx.objectStore("meta"), out = {};
  for (const k of ["identity", "quarantine", "resetting", "purgeMain", "fenceBlocked"]) { const g = st.get(k); g.onsuccess = () => { out[k] = g.result; }; }
  tx.oncomplete = () => ok(out);
  tx.onerror = () => no(tx.error);
  tx.onabort = () => no(tx.error ?? new Error("aborted"));
});
const UNREADABLE = "this browser's record of the workspace couldn't be read: reload this page";
// (an owned write holds the workspace's lock, shared, from its reading of meta until its own transaction has
// ended: what decides a quarantine, a reset or the fence's publication holds it exclusively (web/workspace/api.ts
// locked), so none of them falls between the confirming and the write, whether or not its fence could then be
// written (astra's CORR-2A4-2 on 51106cb6).  `lockHeld`: a caller inside the workspace that holds it already, so
// as not to wait on itself.  Without Web Locks there is no workspace to order against: as before)
// A save, a clear or a drop waits for it at most LOCK_WAIT.ms, then is refused, said (BUSY), as the pages give up
// waiting for it (another tab holding it for good never freezes the editors); a history append waits in its
// queue, holding up nothing
const WORKSPACE_LOCK = "sagebrush-workspace";
export const LOCK_WAIT = { ms: 10_000 };
// (the appends waiting, all history stores together: at most HISTORY_BACKLOG.entries and .bytes, each held as its
// JSON text alone and charged twice its length (UTF-16 code units, 2 bytes each) and ENTRY_OVERHEAD; parsed only at
// its turn, one at a time in a store; one past the bounds is refused, not queued, and said to every
// onHistoryRefused listener, so that a tab stuck holding the lock costs this page bounded memory, never more)
// The contract (design/workspace-durability.md A.3b): the appends waiting hold at most HISTORY_BACKLOG.bytes of
// charge (8 MiB) in at most .entries of them, unconditionally, one entry alone included: an entry larger than
// that (its JSON text past about 4M characters, more than any board, which is at most 5 MiB) is never kept in
// TimeTravel, said; its document is saved all the same, a separate write this never touches (daybreak2's
// LIMIT-C05-1)
export const HISTORY_BACKLOG = { entries: 1000, bytes: 8 * 2 ** 20 };
// (bytes charged for each append beside its JSON text: the queue's closure, its promise, the counters)
export const ENTRY_OVERHEAD = 256;
// (whether `v` would be plain JSON data at all, its size aside: to tell a refusal for size, which is said, from
// one for its shape)
const plainShape = (v) => inertJson(v, Infinity) !== null;
// (an inert copy of `v` and the length of its JSON text, exactly, if `v` is plain JSON data whose text is at most
// `max` characters; else null.  Plain: null, booleans, finite numbers, strings, arrays and plain objects (an
// object's prototype Object.prototype or null); a property that is undefined too, which JSON leaves out
// (patchflow's envelopes have `file: undefined`), and non-enumerable ones, which JSON passes over.  Read through
// property descriptors alone, so no getter or hook ever runs: a getter or a setter, or a function among an
// object's own values (a toJSON, enumerable or not), or a hole in an array, is refused; the copy is what is
// measured and written, never the caller's object (astra's CORR-C05-2).  Walked without recursion, each object
// once: met again on the path being walked, a cycle, refused; met again after its walk (shared, in a DAG), its
// copy and size reused, so the walk is linear in the distinct objects and a DAG is refused before any of it is
// written once its text would pass `max` (daybreak2's LIMIT-7865-1, astra's CORR-786-1))
function inertJson(v, max) {
  const leaf = (x) => {
    if (x === null) return 4;
    if (typeof x === "string") return JSON.stringify(x).length;
    if (typeof x === "boolean") return x ? 4 : 5;
    if (typeof x === "number") return Number.isFinite(x) ? String(x).length : -1;
    return typeof x === "object" ? null : -1;
  };
  const first = leaf(v);
  if (first !== null) return first >= 0 && first <= max ? { size: first, snap: v } : null;
  const done = new WeakMap(), active = new WeakSet();
  // (a frame: the object, its entries to copy ([key, value], read from descriptors), the next, its copy, and
  // its text's length so far; null if it can't be read inertly)
  const open = (x) => {
    const isArray = Array.isArray(x), proto = Object.getPrototypeOf(x);
    if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return null;
    const descs = Object.getOwnPropertyDescriptors(x), entries = [];
    for (const k of Object.getOwnPropertyNames(descs)) {
      const d = descs[k];
      if (d.get || d.set || typeof d.value === "function") return null;
      if (isArray && k === "length") continue;
      if (isArray && !/^(0|[1-9][0-9]*)$/.test(k)) return null;
      if (!d.enumerable || (!isArray && d.value === undefined)) continue;
      entries.push([k, d.value]);
    }
    if (isArray) {
      if (entries.length !== x.length) return null;
      entries.sort((a, b) => a[0] - b[0]);
    }
    let sum = 2 + Math.max(0, entries.length - 1);
    if (!isArray) for (const [k] of entries) sum += JSON.stringify(k).length + 1;
    return { x, isArray, entries, i: 0, copy: isArray ? new Array(entries.length) : Object.create(null), sum };
  };
  const put = (f, k, value) => { if (f.isArray) f.copy[Number(k)] = value; else Object.defineProperty(f.copy, k, { value, enumerable: true, writable: true, configurable: true }); };
  const root = open(v);
  if (!root || root.sum > max) return null;
  active.add(v);
  const stack = [root];
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.i === f.entries.length) {
      stack.pop();
      active.delete(f.x);
      done.set(f.x, f);
      if (stack.length) {
        const p = stack[stack.length - 1];
        put(p, p.entries[p.i - 1][0], f.copy);
        if ((p.sum += f.sum) > max) return null;
      }
      continue;
    }
    const [k, c] = f.entries[f.i++];
    if (f.isArray && c === undefined) return null;
    const l = leaf(c);
    if (l === -1) return null;
    if (l !== null) { put(f, k, c); if ((f.sum += l) > max) return null; continue; }
    if (active.has(c)) return null;
    const d = done.get(c);
    if (d) { put(f, k, d.copy); if ((f.sum += d.sum) > max) return null; continue; }
    const g = open(c);
    if (!g || g.sum > max) return null;
    active.add(c);
    stack.push(g);
  }
  return { size: root.sum, snap: root.copy };
}
/** The length of `v`'s JSON text if it is plain JSON data (inertJson) of at most `max` characters, else -1: for tests. */
export function jsonTextSize(v, max) { const r = inertJson(v, max); return r ? r.size : -1; }
// (no toJSON anywhere JSON.stringify would look for one on the copy, arrays and objects alike: a page that put
// one on Object.prototype or Array.prototype gets no history kept, rather than its hook run)
const prototypesClean = () => !("toJSON" in Object.prototype) && !("toJSON" in Array.prototype);
const backlog = { entries: 0, bytes: 0 };
const refusedSubs = new Set();
/** `f(message)`: called when an append is refused because too many wait (a stuck tab holding the lock). */
export function onHistoryRefused(f) { refusedSubs.add(f); return () => refusedSubs.delete(f); }
/** The appends waiting now: for tests and metrics. */
export const historyBacklog = () => ({ ...backlog });
export const HISTORY_REFUSED = "your files are busy (another tab is changing them), so TimeTravel can't keep up: some of this document's latest history isn't kept";
export const HISTORY_TOO_LARGE = "this version is too large to keep in TimeTravel: the document itself is saved, and TimeTravel goes on from its next version";
const BUSY = "your files are busy (another tab is changing them): not saved yet, tried again with your next change";
const BUSY_DELETE = "your files are busy (another tab is changing them)";
// (a deadline: LOCK_WAIT from when it is made, its signal aborted then unless the lock was had first; made when a
// save, clear or drop is asked for, so the time it spends queued counts too: daybreak2's LIMIT-9D7-1)
function deadlineOf() {
  const d = { ctl: new AbortController(), granted: false, timer: null };
  d.timer = setTimeout(() => { if (!d.granted) d.ctl.abort(); }, LOCK_WAIT.ms);
  return d;
}
// (`wait`: false, as long as it takes; true, a deadline from now; or a deadline made earlier)
function underLock(lockHeld, f, wait = false) {
  const locks = globalThis.navigator?.locks;
  if (lockHeld || !locks || typeof locks.request !== "function") return f();
  if (!wait) return locks.request(WORKSPACE_LOCK, { mode: "shared" }, f);
  const d = wait === true ? deadlineOf() : wait;
  // (had: the deadline stops; aborted first: the request withdrawn, never had, f never run)
  return locks.request(WORKSPACE_LOCK, { mode: "shared", signal: d.ctl.signal }, (l) => { d.granted = true; clearTimeout(d.timer); return f(l); })
    .catch((e) => { if (e?.name === "AbortError") throw Object.assign(new Error(BUSY), { busy: true }); throw e; })
    .finally(() => clearTimeout(d.timer));
}
async function primaryRefusal(db, fence) {
  if (!fence && !["sagebrush", "sagebrush-history", "sagebrush-board-history"].includes(db.name)) return null;
  let m;
  try {
    let pdb = await primaryDb(fence?.primary ?? PRIMARY);
    if (pdb === null) return fence ? "this browser's record of the workspace is missing: reload this page" : null;
    if (!pdb.objectStoreNames.contains("meta")) return UNREADABLE;
    try { m = await readMeta(pdb); }
    catch (e) {
      // (a connection closed under it (an upgrade, a deletion): once more, on a new one)
      if (e?.name !== "InvalidStateError") throw e;
      primaries.delete(fence?.primary ?? PRIMARY);
      pdb = await primaryDb(fence?.primary ?? PRIMARY);
      if (!pdb) return "this browser's record of the workspace is missing: reload this page";
      m = await readMeta(pdb);
    }
  } catch {
    return UNREADABLE;
  }
  const id = m.identity;
  if (!fence) return id ? "the workspace was set up after this was opened: reload this page" : null;
  if (!id || id.workspace !== fence.workspace || id.generation !== fence.generation) return "this browser's record of the workspace doesn't match its notebooks: reload this page";
  if (m.quarantine && (m.quarantine.state === "confirmed" || m.quarantine.state === "suspected")) return "this browser's copy of your workspace was lost or is missing changes: choose what to do first";
  if (m.resetting || m.purgeMain) return "this browser's workspace is being reset: wait for it, then reload";
  if (Array.isArray(m.fenceBlocked) && m.fenceBlocked.includes(db.name)) return "this browser's record of the workspace couldn't be written: reload this page";
  return null;
}
/** Whether the record `id` of the database `name` belongs to the workspace, its fence and its gates governing it
 * (design/workspace-durability.md A.3b): every notebook and its history; of the boards' history only the
 * workspace's own boards' ("local:" and the 12-hex ref): an example's, a board in the address or another site's
 * frame keep theirs whatever the workspace's state, deliberately. */
export function ownedByWorkspace(name, id) {
  if (name === "sagebrush-board-history") return /^(board:)?local:[0-9a-f]{12}(:|$)/.test(String(id));
  return true;
}
// (why a write is refused now by the page: its gate)
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
  /** `opts.lockHeld`: the caller holds the workspace's lock already (the workspace's own verbs). */
  async save(doc, opts = {}) {
    if (!this.db) return "not saved: this browser has no storage";
    // (refused while the page says so: the workspace quarantined, design/workspace-durability.md A.3)
    const gate = refusal();
    if (gate) return `not saved: ${gate}`;
    // (bound first, if it saves before it loaded; then the workspace's own word: CORR-56C-1; the word and the
    // write in one hold of the workspace's lock)
    if (this.fence === undefined) this.fence = fenceOf(await idb(this.db, "notebooks", "readonly", (st) => st.get(FENCE)).catch(() => undefined));
    let out;
    try {
    out = await underLock(opts.lockHeld, async () => {
    const why = await primaryRefusal(this.db, this.fence);
    if (why) return { refused: why };
    // read and write in one transaction: the compare and swap is atomic, and so is the fence's check
    return new Promise((resolve, reject) => {
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
    }, true);
    } catch (e) {
      // (busy: rejected, so the editor keeps the change as not saved, says so, and sends it again with its next
      // flush; nothing was written, and the request for the lock was withdrawn, so nothing will be)
      if (e?.busy) throw Object.assign(new Error(e.message), { busy: true });
      throw e;
    }
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
  constructor(db, id) { this.db = db; this.id = id; this.owned = !db || ownedByWorkspace(db.name, id); }
  // (one queue, in the order they were asked for, for append, clear and drop: none overtakes another, and each
  // tells the other tabs at its turn, so they hear them in that order too: astra's CORR-511-1)
  queue(f) {
    const p = (this.appending ?? Promise.resolve()).then(f);
    this.appending = p.catch(() => {});
    return p;
  }
  // (refused, said, by the page's gate or the fence; a history the workspace doesn't own, never)
  async allowed() {
    if (!this.owned) return;
    if (this.fence === undefined) this.fence = fenceOf((await idb(this.db, "history", "readonly", (st) => st.get([FENCE, ""])).catch(() => undefined))?.fence);
    const why = refusal() || (await primaryRefusal(this.db, this.fence)) || fenceRefusal((await idb(this.db, "history", "readonly", (st) => st.get([FENCE, ""])).catch(() => undefined))?.fence, this.fence);
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
    if (!this.db || (this.owned && refusal())) return false;
    // (bounded: past HISTORY_BACKLOG, refused and said, never queued)
    // (kept while it waits as its JSON text alone, made now: what is charged is what is held, however the caller
    // changes the envelope later, and whatever its shape; parsed only at its turn.  Plain JSON data only: one
    // that isn't (a buffer, a Map, a class's object) would be kept as something else, or cost more than its
    // text: refused.  daybreak2's LIMIT-9D7-2 and LIMIT-5B7-1)
    // (its text's length known first, without writing it: no larger than what the backlog can still take; said,
    // as too large for TimeTravel at all, or as the files being busy)
    const alone = Math.floor((HISTORY_BACKLOG.bytes - ENTRY_OVERHEAD) / 2);
    const room = Math.floor((HISTORY_BACKLOG.bytes - backlog.bytes - ENTRY_OVERHEAD) / 2);
    const inert = prototypesClean() ? inertJson(env, this.owned ? room : alone) : null;
    if (!inert) {
      console.warn("history: an entry that isn't plain JSON data, or too large to wait, not kept");
      if (prototypesClean() && plainShape(env)) {
        const why = inertJson(env, alone) === null ? HISTORY_TOO_LARGE : HISTORY_REFUSED;
        for (const f of refusedSubs) try { f(why); } catch {}
      }
      return false;
    }
    // (the copy written, which no hook can change; its text as long as measured, or not kept)
    let text;
    try { text = JSON.stringify(inert.snap); } catch { return false; }
    if (typeof text !== "string" || text.length !== inert.size) return false;
    env = undefined;
    let size = 0;
    if (this.owned) {
      size = 2 * text.length + ENTRY_OVERHEAD;
      if (backlog.entries + 1 > HISTORY_BACKLOG.entries || backlog.bytes + size > HISTORY_BACKLOG.bytes) {
        for (const f of refusedSubs) try { f(HISTORY_REFUSED); } catch {}
        return false;
      }
      backlog.entries++;
      backlog.bytes += size;
    }
    // (in order, each after the workspace's word on it, for an owned record, the word and the write in one hold
    // of the workspace's lock)
    this.queue(async () => {
      const env = JSON.parse(text);
      getHistoryChannel()?.postMessage({ from: tabId, id: this.id, env });
      if (this.owned && this.fence === undefined) this.fence = fenceOf((await idb(this.db, "history", "readonly", (st) => st.get([FENCE, ""])).catch(() => undefined))?.fence);
      await underLock(!this.owned, async () => {
      if (this.owned && (await primaryRefusal(this.db, this.fence))) return;
      await new Promise((ok) => {
        const tx = this.db.transaction("history", "readwrite"), st = tx.objectStore("history"), f = st.get([FENCE, ""]);
        f.onsuccess = () => {
          if (this.fence === undefined) this.fence = fenceOf(f.result?.fence);
          if (this.owned && fenceRefusal(f.result?.fence, this.fence)) return;
          st.put({ nb: this.id, time: env.time, env });
        };
        tx.oncomplete = () => ok();
        tx.onerror = () => { console.warn("history:", tx.error); ok(); };
      });
      });
    }).catch((e) => console.warn("history:", e)).finally(() => { if (this.owned) { backlog.entries--; backlog.bytes -= size; } });
    return true;
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
  /** `opts.lockHeld`: the caller holds the workspace's lock already. */
  clear(opts = {}) {
    return this.deleteQueued(opts, true);
  }
  /** Forget this notebook's history without telling anyone (the notebook was deleted). */
  drop(opts = {}) {
    return this.deleteQueued(opts, false);
  }
  // (in the queue, in the order asked for; its deadline from when it was asked: refused once it passes, even
  // while still queued behind appends waiting for the lock, and its turn then does nothing, so it can never
  // delete afterwards: daybreak2's LIMIT-9D7-1)
  deleteQueued(opts, tell) {
    const timed = !(opts.lockHeld || !this.owned) && typeof globalThis.navigator?.locks?.request === "function";
    const d = timed ? deadlineOf() : null;
    const turn = this.queue(async () => {
      if (d?.ctl.signal.aborted) return;
      await this.deleteAllowed(opts, d ?? false);
      if (tell) getHistoryChannel()?.postMessage({ from: tabId, id: this.id, clear: true });
    });
    if (!d) return turn;
    const expired = new Promise((_, no) => d.ctl.signal.addEventListener("abort", () => no(new Error(`not done: ${BUSY_DELETE}`)), { once: true }));
    turn.catch(() => {});
    expired.catch(() => {});
    return Promise.race([turn, expired]).finally(() => clearTimeout(d.timer));
  }
  // (asked first, without the lock; then the workspace's word again and the deletion, in one hold of it)
  async deleteAllowed(opts, wait) {
    await this.allowed();
    await underLock(opts.lockHeld || !this.owned, async () => {
      const why = this.owned ? await primaryRefusal(this.db, this.fence) : null;
      if (why) throw new Error(`not done: ${why}`);
      await this.deleteChecked();
    }, wait).catch((e) => { throw e?.busy ? new Error(`not done: ${BUSY_DELETE}`) : e; });
  }
  // (the rows deleted only if the fence, read in the same transaction, still allows it)
  async deleteChecked() {
    if (!this.db) return;
    const why = await new Promise((ok, no) => {
      const tx = this.db.transaction("history", "readwrite"), st = tx.objectStore("history"), f = st.get([FENCE, ""]);
      let refused = null;
      f.onsuccess = () => { refused = this.owned ? fenceRefusal(f.result?.fence, this.fence) : null; if (!refused) st.delete(this.range()); };
      tx.oncomplete = () => ok(refused);
      tx.onerror = () => no(tx.error);
    });
    if (why) throw new Error(`not done: ${why}`);
  }
}
