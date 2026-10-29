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
/** Sync's own rows in the history databases (plan-sync-slice2-client r4 §4, F1; web/notebook/sync-rows.js) are under
 * nb keys that begin with this character, which no document id may: so no document's range ever holds one. */
export const SYNC_KEY_PREFIX = "\u0001";
/** Whether an nb key is one of sync's (F1's one predicate, for every path that reads the history databases whole). */
export const isSyncKey = (nb) => typeof nb === "string" && nb.startsWith(SYNC_KEY_PREFIX);
/** Why a document id can't be a store's (null if it can): empty, or beginning with a control character, the range
 * sync's reserved keys live in (F1's admission, checked at every store opened and every import). */
export function docIdProblem(id) {
  if (typeof id !== "string" || id === "") return "a document id is a non-empty string";
  return /^[\u0000-\u001f\u007f]/.test(id) ? "a document id can't begin with a control character" : null;
}
const admitId = (id) => {
  const why = docIdProblem(id);
  if (why) throw new TypeError(`stores: ${why}: ${JSON.stringify(String(id).slice(0, 40))}`);
  return id;
};
// (the rules, the same for every write (astra's CORR-2A4-2 on 0eefec71): a store is bound to the fence it found
// when it loaded, read in the same transaction as the document; a write is allowed only if the fence now is that
// same workspace and generation, in phase "ok"; a fence that appeared since a store found none, or went since it
// found one, refuses it.  A fence is never deleted.  Which records the workspace owns is decided by
// ownedByWorkspace, never by whether a fence is there.
// `accept`: the one phase a writer writes in.  Every writer here writes as before the journal, in "ok"; once the
// journal is activated the fences say "journal" (plan-sync-slice2-client r4 §1a), which only the journal's
// writers (2c-1d) accept, so a writer from before it, in an old tab or this one, is refused before it changes
// anything)
export const fenceRefusal = (f, seen, accept = "ok") => {
  if (!f) return seen ? "this browser's record of the workspace is missing: reload this page" : null;
  if (f.quarantined) return "this browser's copy of your workspace was lost or is missing changes: choose what to do first";
  if ((f.phase ?? "ok") !== accept) {
    if (f.phase === "quarantined") return "this browser's copy of your workspace was lost or is missing changes: choose what to do first";
    if (f.phase === "journal") return "this browser now saves notebooks through sync's journal, which this page doesn't: reload this page";
    if (accept === "journal" && (f.phase ?? "ok") === "ok") return "this browser's workspace isn't saving through sync's journal yet: reload this page";
    return "this browser's workspace is being reset: wait for it, then reload";
  }
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
/** For tests: `beforeTx(store)`, awaited in a journal write after the workspace's word and before its transaction. */
export const JOURNAL_TX_HOOK = { beforeTx: undefined };
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
// (one walk's answer: { ok, size, snap }, or why not: too large (it stopped as soon as the text passed `max`, the
// rest unread, so refusing costs no more than `max`: daybreak2's LIMIT-896-1), or not plain JSON data)
const TOO_LARGE = { ok: false, reason: "too-large" }, SHAPE = { ok: false, reason: "shape" };
// (a string as JSON text, written here rather than by JSON.stringify, so that the text and its measured length come
// from this one code, and nothing of the page's can run while it is written (astra's CORR-C05-2): ", \\ and the
// control characters below 0x20 escaped (\\b \\t \\n \\f \\r, else \\u00xx), a lone surrogate as \\udxxx, as
// well-formed JSON.stringify does; everything else as it is)
function jsonString(s) {
  let out = '"', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc = null;
    if (c === 0x22) esc = '\\"';
    else if (c === 0x5c) esc = "\\\\";
    else if (c < 0x20) esc = c === 8 ? "\\b" : c === 9 ? "\\t" : c === 10 ? "\\n" : c === 12 ? "\\f" : c === 13 ? "\\r" : "\\u" + c.toString(16).padStart(4, "0");
    else if (c >= 0xd800 && c <= 0xdfff) {
      if (c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { i++; continue; }
      esc = "\\u" + c.toString(16);
    }
    if (esc !== null) { out += s.slice(start, i) + esc; start = i + 1; }
  }
  return out + s.slice(start) + '"';
}
// (a number as JSON text: finite only, by String, the language's own conversion, never a prototype's; -0 is "0")
const jsonNumber = (n) => String(n);
// (an inert copy (inertJson's: null-prototype objects, plain arrays, strings, finite numbers, booleans, null) as
// JSON text, without recursion, by jsonString and jsonNumber: the same text inertJson measured.  A frame per open
// array or object, walked by index, and the pieces folded into one string every CHUNK of them, so that what it
// holds beside the text is a few frames and a short list, not an entry per element (daybreak2, on d761fdec))
function writeJson(v) {
  const CHUNK = 4096;
  let done = "", parts = [];
  const emit = (t) => { parts.push(t); if (parts.length >= CHUNK) { done += parts.join(""); parts = []; } };
  const scalar = (x) => (x === null ? "null" : typeof x === "string" ? jsonString(x) : typeof x === "number" ? jsonNumber(x) : x ? "true" : "false");
  const open = (x) => {
    if (Array.isArray(x)) { emit("["); return { x, keys: null, n: x.length, i: 0 }; }
    emit("{");
    const keys = Object.keys(x);
    return { x, keys, n: keys.length, i: 0 };
  };
  if (v === null || typeof v !== "object") return scalar(v);
  const stack = [open(v)];
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.i === f.n) { emit(f.keys ? "}" : "]"); stack.pop(); continue; }
    if (f.i) emit(",");
    const c = f.keys ? f.x[f.keys[f.i]] : f.x[f.i];
    if (f.keys) emit(jsonString(f.keys[f.i]) + ":");
    f.i++;
    if (c !== null && typeof c === "object") stack.push(open(c));
    else emit(scalar(c));
  }
  return done + parts.join("");
}
function inertJson(v, max) {
  // (whatever runs while it is read (a Proxy's traps) and throws: refused, never thrown on)
  try { return inertWalk(v, max); } catch { return SHAPE; }
}
function inertWalk(v, max) {
  const leaf = (x) => {
    if (x === null) return 4;
    if (typeof x === "string") return jsonString(x).length;
    if (typeof x === "boolean") return x ? 4 : 5;
    if (typeof x === "number") return Number.isFinite(x) ? jsonNumber(x).length : -1;
    return typeof x === "object" ? null : -1;
  };
  const first = leaf(v);
  if (first !== null) return first < 0 ? SHAPE : first <= max ? { ok: true, size: first, snap: v } : TOO_LARGE;
  const done = new WeakMap(), active = new WeakSet();
  // (a frame: the object, read a property at a time through its descriptors, never a getter or a direct read:
  // an array by its own "length" descriptor and its indices, an object by its own names; its copy, and its
  // text's length so far, an array's commas and brackets counted from the start, so that one too long is refused
  // before any of it is read: daybreak2's LIMIT-896-1, astra's on 89685b0c)
  const open = (x) => {
    if (Array.isArray(x)) {
      if (Object.getPrototypeOf(x) !== Array.prototype || Object.getOwnPropertyDescriptor(x, "toJSON")) return SHAPE;
      const ld = Object.getOwnPropertyDescriptor(x, "length");
      if (!ld || !("value" in ld) || !Number.isInteger(ld.value) || ld.value < 0 || ld.value > 2 ** 32 - 1) return SHAPE;
      const n = ld.value;
      return { x, isArray: true, n, i: 0, copy: [], sum: 2 + Math.max(0, n - 1), least: 2 + Math.max(0, 2 * n - 1) };
    }
    const proto = Object.getPrototypeOf(x);
    if (proto !== Object.prototype && proto !== null) return SHAPE;
    const names = Object.getOwnPropertyNames(x);
    return { x, isArray: false, names, n: names.length, i: 0, kept: 0, copy: Object.create(null), sum: 2, least: 2 };
  };
  // (the frame's next [key, value]; SKIP for a property JSON leaves out; SHAPE for one that can't be read inertly)
  const SKIP = {};
  const next = (f) => {
    const k = f.isArray ? String(f.i) : f.names[f.i];
    f.i++;
    const d = Object.getOwnPropertyDescriptor(f.x, k);
    if (f.isArray) {
      if (!d || d.get || d.set || !("value" in d) || d.value === undefined || typeof d.value === "function") return SHAPE;
      return [k, d.value];
    }
    if (!d || d.get || d.set || typeof d.value === "function") return SHAPE;
    if (!d.enumerable || d.value === undefined) return SKIP;
    f.sum += jsonString(k).length + 1 + (f.kept++ ? 1 : 0);
    return [k, d.value];
  };
  const put = (f, k, value) => { if (f.isArray) f.copy.push(value); else Object.defineProperty(f.copy, k, { value, enumerable: true, writable: true, configurable: true }); };
  const root = open(v);
  if (root === SHAPE) return SHAPE;
  if (root.least > max) return TOO_LARGE;
  active.add(v);
  const stack = [root];
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.i === f.n) {
      stack.pop();
      active.delete(f.x);
      done.set(f.x, f);
      if (stack.length) {
        const p = stack[stack.length - 1];
        put(p, p.pending, f.copy);
        if ((p.sum += f.sum) > max) return TOO_LARGE;
      }
      continue;
    }
    const e = next(f);
    if (e === SHAPE) return SHAPE;
    if (e === SKIP) continue;
    if (f.sum > max) return TOO_LARGE;
    const [k, c] = e;
    const l = leaf(c);
    if (l === -1) return SHAPE;
    if (l !== null) { put(f, k, c); if ((f.sum += l) > max) return TOO_LARGE; continue; }
    if (active.has(c)) return SHAPE;
    const d = done.get(c);
    if (d) { put(f, k, d.copy); if ((f.sum += d.sum) > max) return TOO_LARGE; continue; }
    const g = open(c);
    if (g === SHAPE) return SHAPE;
    if (f.sum + g.least > max) return TOO_LARGE;
    f.pending = k;
    active.add(c);
    stack.push(g);
  }
  return { ok: true, size: root.sum, snap: root.copy };
}
/** The length of `v`'s JSON text if it is plain JSON data (inertJson) of at most `max` characters, else -1: for tests. */
export function jsonTextSize(v, max) { const r = inertJson(v, max); return r.ok ? r.size : -1; }
/** `v`'s JSON text as this module writes it (inertJson's copy, by writeJson), or null: for tests. */
export function jsonText(v, max = Infinity) { const r = inertJson(v, max); return r.ok ? writeJson(r.snap) : null; }
// (no toJSON anywhere JSON.stringify would look for one on the copy, arrays and objects alike: a page that put
// one on Object.prototype or Array.prototype gets no history kept, rather than its hook run)
const prototypesClean = () => !("toJSON" in Object.prototype) && !("toJSON" in Array.prototype);
const backlog = { entries: 0, bytes: 0 };
const refusedSubs = new Set();
/** `f(message)`: called when an append is refused because too many wait (a stuck tab holding the lock). */
export function onHistoryRefused(f) { refusedSubs.add(f); return () => refusedSubs.delete(f); }
/** The appends waiting now: for tests and metrics. */
export const historyBacklog = () => ({ ...backlog });
// (a refusal pauses the document's TimeTravel until a version can be kept whole: notebook/patch-history.js)
export const HISTORY_REFUSED = "your files are busy (another tab is changing them), so TimeTravel paused for this document: it resumes from the next version that can be saved in full. The document itself is saved";
export const HISTORY_TOO_LARGE = "this version is too large to keep in TimeTravel, so TimeTravel paused for this document: it resumes from the next version that can be saved in full. The document itself is saved";
// (said once by a phase-following store whose append the fence refuses for its phase: a board tab open across the
// journal's activation keeps saving the board but no longer its versions (board's note on #227))
export const HISTORY_STOPPED = "TimeTravel stopped recording in this tab: reload the board to keep its versions";
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
  // (sync's rows are the workspace's own in either history database, whatever a board id's pattern says: reset,
  // quarantine and deletion fence and clear them as they do its documents, F1)
  if (isSyncKey(id)) return true;
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
// "sagebrush-share-sent": "records", this browser's records of first uploads whose share request it sent, by
// account|notebook (web/index.html, shareSent): its own database, so that no other one needs a version change.
export const openShareSentDb = ({ onVersionChange } = {}) => open("sagebrush-share-sent", { records: { keyPath: "key" } }, onVersionChange);

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
  /** @param db an IndexedDB database from openDb(); @param id the notebook's id; @param initial its document if it is new;
   * `opts.journal`: the journal's store (web/notebook/journal.js), whose every save carries the journal's {j, hash}
   * and is written only in the phase "journal" (plan-sync-slice2-client r4 §1a, r9 §3.1a's T2) */
  constructor(db, id, initial = null, opts = {}) { this.db = db; this.id = admitId(id); this.initial = initial; this.journal = !!opts.journal; }
  /** The stored record (undefined if none), the store bound to the fence read with it. */
  async loadRecord() {
    // (the document and the fence it belongs with, read in one transaction: the workspace this store writes into)
    const both = this.db ? await new Promise((ok, no) => {
      const tx = this.db.transaction("notebooks", "readonly"), st = tx.objectStore("notebooks"), d = st.get(this.id), f = st.get(FENCE);
      tx.oncomplete = () => ok({ doc: d.result, fence: f.result });
      tx.onerror = () => no(tx.error);
    }) : { doc: undefined, fence: undefined };
    if (this.fence === undefined) this.fence = fenceOf(both.fence);
    return both.doc;
  }
  async load() {
    const doc = await this.loadRecord();
    if (doc) return doc;
    const fresh = { ...(this.initial ?? { name: "Untitled", mode: "python", cells: [] }), id: this.id };
    await this.save(fresh);
    return fresh;
  }
  /** `opts.lockHeld`: the caller holds the workspace's lock already (the workspace's own verbs).  `opts.journal`
   * ({j, hash}, a journal store's only): T2, written only over a stored j no later than `j`; `{keep: true, hash}`
   * instead of j: the stored j kept (a save whose T1 was refused, 2c-1d-iii §1); `unjournaled`: the record's mark
   * (true or "too-large"), written with it, or none. */
  async save(doc, opts = {}) {
    if (!this.db) return "not saved: this browser has no storage";
    // (a journal store writes nothing without the journal's word; any other store, nothing with it)
    const jw = opts.journal;
    if (this.journal !== !!jw || (jw && !((jw.keep === true || (Number.isSafeInteger(jw.j) && jw.j >= 0)) && typeof jw.hash === "string" && [undefined, false, true, "too-large"].includes(jw.unjournaled) && (!jw.markOnly || (jw.keep === true && jw.unjournaled === true))))) return "not saved: this notebook's save didn't come through sync's journal: reload this page";
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
        const why = fenceRefusal(fence.result, this.fence, jw ? "journal" : "ok");
        if (why) result = { refused: why };
      };
      const get = st.get(this.id);
      get.onsuccess = () => {
        if (result?.refused) return;
        // (T2: never over a value the journal has later than this one's, so the store never moves back)
        // (the record marked alone, its value and revision kept (journal.js markRecord): no new revision, nothing told)
        if (jw?.markOnly) {
          if (get.result && !get.result.unjournaled) st.put({ ...get.result, unjournaled: jw.unjournaled });
          result = { marked: true };
          return;
        }
        const { j: _j, hash: _h, unjournaled: _u, ...plain } = doc;
        const j = jw?.keep ? get.result?.j ?? 0 : jw?.j;
        const rec = (jw && (get.result?.j ?? 0) > j) ? null : revise(get.result, { ...plain, id: this.id, updated: Date.now(), ...(jw ? { j, hash: jw.hash, ...(jw.unjournaled ? { unjournaled: jw.unjournaled } : {}) } : {}) });
        if (!rec) result = { conflict: get.result };
        else {
          st.put(rec);
          result = { rec };
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      // (stopped without a request's error (out of room at its commit, or a handler that threw): not saved, said, never
      // a save left waiting (2c-1d-iii D1))
      tx.onabort = () => reject(tx.error ?? new Error("the write was stopped"));
    });
    }, true);
    } catch (e) {
      // (busy: rejected, so the editor keeps the change as not saved, says so, and sends it again with its next
      // flush; nothing was written, and the request for the lock was withdrawn, so nothing will be)
      if (e?.busy) throw Object.assign(new Error(e.message), { busy: true });
      throw e;
    }
    if (out.refused) return `not saved: ${out.refused}`;
    if (out.marked) return { marked: true };
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
/** A patch received from the server and stored (sync 2c-3) told to this notebook's history in every tab, this one's
 * too (the sender may be the writer's tab): `id` is the history key, `env` the patch. */
export function tellHistory(id, env) {
  const m = { from: tabId, id, env };
  getHistoryChannel()?.postMessage(m);
  for (const f of historySubs) try { f(m); } catch (e) { console.warn("history:", e); }
}
/** Sync's acknowledgement released history `id`'s debt (2c-3, doc-sync.ts): told to its writer, in whatever tab it is
 * (onAcked), so a history paused for want of room resumes.  No `env`: never a patch to the history's subscribers. */
export function tellAcked(id) {
  const m = { from: tabId, id, acked: true };
  getHistoryChannel()?.postMessage(m);
  for (const f of historySubs) try { f(m); } catch (e) { console.warn("history:", e); }
}
export class IdbPatchStore {
  /** `opts.journal`: the journal's hooks (web/notebook/journal.js): `t1(st, row, intent)`, run in each append's own transaction
   * (the patch's row and the journal's rows written together, T1), and `drop(st)`, in a drop's; with them every write
   * is in the phase "journal" only, and each append's outcome is had from `appended(time)`. */
  constructor(db, id, opts = {}) {
    this.db = db; this.id = admitId(id); this.owned = !db || ownedByWorkspace(db.name, id);
    this.journal = opts.journal ?? null; this.t1s = new Map();
    // (`opts.followPhase`, for a writer whose saves are the same before and after the journal's activation (boards'
    // TimeTravel until 2c-1b, plan-sync-slice2-client r4 §2): its phase is the fence's when it was first read,
    // "journal" or "ok", and stays that: a store bound before the activation is refused after it, as any other)
    this.followPhase = !!opts.followPhase && !this.journal; this.boundPhase = undefined;
  }
  // (the phase this store's writes go in)
  get phase() { return this.journal ? "journal" : this.followPhase ? (this.boundPhase ?? "ok") : "ok"; }
  // (the fence this store is bound to, from the first one read; a phase-following store's phase with it)
  bindFence(f) {
    this.fence = fenceOf(f);
    if (this.followPhase && this.boundPhase === undefined) this.boundPhase = f?.phase === "journal" ? "journal" : "ok";
  }
  // (a phase-following store's append refused because it was bound before the journal's activation, the fence
  // `f` now in "journal": said once, to onHistoryRefused's listeners, never again for this store.  Any other
  // refusal (a reset, a quarantine, storage that couldn't be read) is said by the notices that are for it, not as
  // this one's "reload": board's N1 on 7e4ddd5b)
  stopped(f) {
    if (!this.followPhase || this.stopSaid || this.phase !== "ok" || f?.phase !== "journal") return;
    this.stopSaid = true;
    for (const f of refusedSubs) try { f(HISTORY_STOPPED); } catch {}
  }
  /** A journal store's append's outcome, once its transaction has completed: {j} or {refused}. */
  appended(time) {
    const t = this.t1s.get(time);
    return t ? t.p : Promise.resolve({ refused: "that version wasn't kept" });
  }
  // (the promise of an append's outcome, made when it is asked for, settled when its transaction ends)
  expect(time) {
    if (!this.journal) return null;
    let settle;
    const p = new Promise((ok) => { settle = ok; });
    const t = { p, settle: (v) => { if (this.t1s.get(time) === t) this.t1s.delete(time); settle(v); } };
    this.t1s.set(time, t);
    return t;
  }
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
    if (this.fence === undefined) this.bindFence((await idb(this.db, "history", "readonly", (st) => st.get([FENCE, ""])).catch(() => undefined))?.fence);
    const why = refusal() || (await primaryRefusal(this.db, this.fence)) || fenceRefusal((await idb(this.db, "history", "readonly", (st) => st.get([FENCE, ""])).catch(() => undefined))?.fence, this.fence, this.phase);
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
    if (this.fence === undefined) this.bindFence(both.fence);
    const rows = both.rows ?? [];
    return { patches: rows.map((r) => r.env), hasMore: false };
  }
  append(env) {
    // (not while the page refuses saves, nor when the fence says no, checked in the write's own transaction)
    if (!this.db || (this.owned && refusal())) return false;
    // (a journal store's: one at a time per version)
    if (this.journal && (typeof env?.time !== "string" || this.t1s.has(env.time))) return false;
    // (bounded: past HISTORY_BACKLOG, refused and said, never queued)
    // (kept while it waits as its JSON text alone, made now: what is charged is what is held, however the caller
    // changes the envelope later, and whatever its shape; parsed only at its turn.  Plain JSON data only: one
    // that isn't (a buffer, a Map, a class's object) would be kept as something else, or cost more than its
    // text: refused.  daybreak2's LIMIT-9D7-2 and LIMIT-5B7-1)
    // (its text's length known first, without writing it: no larger than what the backlog can still take; said,
    // as too large for TimeTravel at all, or as the files being busy)
    const alone = Math.floor((HISTORY_BACKLOG.bytes - ENTRY_OVERHEAD) / 2);
    const room = Math.floor((HISTORY_BACKLOG.bytes - backlog.bytes - ENTRY_OVERHEAD) / 2);
    // (one walk, bounded by what the backlog can take; refused too large with something waiting, a second walk,
    // bounded by one entry's limit alone, tells "too large for TimeTravel" from "the files are busy")
    const inert = prototypesClean() ? inertJson(env, this.owned ? room : alone) : SHAPE;
    if (!inert.ok) {
      console.warn("history: an entry that isn't plain JSON data, or too large to wait, not kept");
      if (inert.reason === "too-large") {
        const why = room >= alone || !this.owned || inertJson(env, alone).reason === "too-large" ? HISTORY_TOO_LARGE : HISTORY_REFUSED;
        for (const f of refusedSubs) try { f(why); } catch {}
      }
      return false;
    }
    // (the copy written, which no hook can change; its text as long as measured, or not kept)
    // (the copy written by this module's own writer, not JSON.stringify, so that no hook can run, whatever was put
    // on a prototype while it was read, and the text is what was measured (astra's CORR-C05-2); the prototypes'
    // check before the walk stays as a defence)
    const text = writeJson(inert.snap);
    if (text.length !== inert.size) return false;
    const time = env.time, intent = this.intent;
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
    // (a journal store's: its outcome expected only once it is admitted, so every refusal before is said by the
    // return alone, and nothing waits on an outcome that never comes (daybreak3's LIMIT-208-DAYBREAK3-1)); its T1
    // in journalTx, with the save's intent ({srev, value}, journal.js: set by the store for the one append a save makes)
    if (this.journal) {
      const t1 = this.expect(time);
      this.queue(async () => {
        const env = JSON.parse(text);
        const out = await this.journalTx((st) => this.journal.t1(st, { nb: this.id, time: env.time, env }, intent));
        t1.settle(out);
        // (told to the other tabs only once its T1 has committed)
        if (out.j !== undefined) getHistoryChannel()?.postMessage({ from: tabId, id: this.id, env });
      }).catch((e) => { t1.settle({ refused: `not kept: ${e?.message ?? e}` }); console.warn("history:", e); }).finally(() => { if (this.owned) { backlog.entries--; backlog.bytes -= size; } });
      return true;
    }
    // (in order, each after the workspace's word on it, for an owned record, the word and the write in one hold
    // of the workspace's lock)
    this.queue(async () => {
      const env = JSON.parse(text);
      getHistoryChannel()?.postMessage({ from: tabId, id: this.id, env });
      if (this.owned && this.fence === undefined) this.bindFence((await idb(this.db, "history", "readonly", (st) => st.get([FENCE, ""])).catch(() => undefined))?.fence);
      await underLock(!this.owned, async () => {
      if (this.owned && (await primaryRefusal(this.db, this.fence))) return;
      await new Promise((ok) => {
        const tx = this.db.transaction("history", "readwrite"), st = tx.objectStore("history"), f = st.get([FENCE, ""]);
        f.onsuccess = () => {
          if (this.fence === undefined) this.bindFence(f.result?.fence);
          if (this.owned && fenceRefusal(f.result?.fence, this.fence, this.phase)) return this.stopped(f.result?.fence);
          st.put({ nb: this.id, time: env.time, env });
        };
        tx.oncomplete = () => ok();
        tx.onerror = () => { console.warn("history:", tx.error); ok(); };
      });
      });
    }).catch((e) => console.warn("history:", e)).finally(() => { if (this.owned) { backlog.entries--; backlog.bytes -= size; } });
    return true;
  }
  /** A journal store's write (T1: an append's, or a pending value's, web/notebook/journal.js): `fn(st)` in a history
   * transaction of its own, after the workspace's word, the two in one hold of the workspace's lock, and only if the
   * fence, read in that same transaction, is this store's in the phase "journal" (daybreak3's CORR-208-DAYBREAK3-2).
   * Resolves `fn`'s outcome once the transaction has committed ({j}), or {refused}/{conflict} with nothing written. */
  async journalTx(fn) {
    if (this.owned && this.fence === undefined) this.bindFence((await idb(this.db, "history", "readonly", (st) => st.get([FENCE, ""])).catch(() => undefined))?.fence);
    return underLock(!this.owned, async () => {
      const why = this.owned ? refusal() || (await primaryRefusal(this.db, this.fence)) : null;
      if (why) return { refused: why };
      await JOURNAL_TX_HOOK.beforeTx?.(this);
      let out = null;
      await new Promise((ok) => {
        const tx = this.db.transaction("history", "readwrite"), st = tx.objectStore("history"), f = st.get([FENCE, ""]);
        const stop = () => { try { tx.abort(); } catch {} };
        f.onsuccess = () => {
          if (this.fence === undefined) this.bindFence(f.result?.fence);
          const refused = this.owned ? fenceRefusal(f.result?.fence, this.fence, this.phase) : null;
          if (refused) { out = { refused }; stop(); return; }
          fn(st).then((r) => { out = r; if (r?.j === undefined) stop(); }, (e) => { out = { refused: e?.refusal ?? `not kept: ${e?.message ?? e}`, ...(e?.name === "QuotaExceededError" ? { quota: true } : {}) }; stop(); });
        };
        tx.oncomplete = () => ok();
        // (stopped, or failed: nothing of it written, whatever `fn` had said)
        // (the history database out of room: said as such, so the save's record is still written, marked (2c-1d-iii §1))
        tx.onabort = () => { if (!out || out.j !== undefined) out = { refused: `not kept: ${tx.error?.message ?? "the write was stopped"}`, ...(tx.error?.name === "QuotaExceededError" ? { quota: true } : {}) }; ok(); };
        tx.onerror = () => {};
      });
      return out ?? { refused: "not kept" };
    });
  }
  subscribe(f) {
    const g = (m) => { if (m.id === this.id && m.env) f(m.env); };
    getHistoryChannel();
    historySubs.add(g);
    return () => historySubs.delete(g);
  }
  /** Called when sync's acknowledgement released this history's debt (tellAcked), in any tab. */
  onAcked(f) {
    const g = (m) => { if (m.id === this.id && m.acked) f(); };
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
    return this.deleteQueued(opts, false, true);
  }
  // (in the queue, in the order asked for; its deadline from when it was asked: refused once it passes, even
  // while still queued behind appends waiting for the lock, and its turn then does nothing, so it can never
  // delete afterwards: daybreak2's LIMIT-9D7-1)
  deleteQueued(opts, tell, dropping = false) {
    // (a journal store's history is cleared or dropped only by the notebook's writer here (daybreak3): a read-only tab's
    // never, whatever its page does)
    // (asked when it is asked for, and again at its turn in the queue: it may have changed meanwhile (daybreak3's P2))
    const notWriter = () => this.journal && (this.mutateOK ?? this.writerOK)?.() === false;
    const NOT = "not done: this notebook is open for editing in another tab of this browser";
    if (notWriter()) return Promise.reject(new Error(NOT));
    const timed = !(opts.lockHeld || !this.owned) && typeof globalThis.navigator?.locks?.request === "function";
    const d = timed ? deadlineOf() : null;
    const turn = this.queue(async () => {
      if (d?.ctl.signal.aborted) return;
      if (notWriter()) throw new Error(NOT);
      this.dropping = dropping;
      try { await this.deleteAllowed(opts, d ?? false); } finally { this.dropping = false; }
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
      f.onsuccess = () => {
        refused = this.owned ? fenceRefusal(f.result?.fence, this.fence, this.phase) : null;
        if (refused) return;
        st.delete(this.range());
        // (a journal store's drop takes the document's journal rows with it, charges and all, or nothing goes; a clear
        // keeps them: its jseq only ever rises)
        if (this.journal && this.dropping) this.journal.drop(st).catch((e) => { refused = `its journal's rows couldn't be dropped (${e?.message ?? e})`; try { tx.abort(); } catch {} });
      };
      tx.oncomplete = () => ok(refused);
      // (stopped: nothing of it done, said (daybreak3's CORR-208-DAYBREAK3-3))
      tx.onabort = () => ok(refused ?? `the deletion was stopped (${tx.error?.message ?? "aborted"})`);
      tx.onerror = () => {};
    });
    if (why) throw new Error(`not done: ${why}`);
  }
}
