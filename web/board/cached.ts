// Open from IndexedDB first (~/notes/board-plan/board-in-cocalc.md): a
// store for a document kept elsewhere (CoCalc's, synced; here a remote
// with a delay in the tests) that keeps a copy in this browser, shows that
// copy at once, and then asks the remote whether it still has the same
// document (its hash):
//
//   the same              nothing changes (edits the copy holds, made
//                         offline, go to the remote)
//   another               the remote's replaces the copy; or, with edits
//                         here meanwhile, the two are merged by records
//                         (merge3: a change on one side is taken, on both
//                         sides ours, and the board says so)
//   unreachable           the copy stays, and edits are kept in it
//
// No copy yet: load() waits for the remote.  Edits go to the copy at once
// and to the remote once it has answered, in order.  A document from
// elsewhere reaches the board through subscribe().

import { canonical, cleanDoc, type BoardDoc } from "./doc";
import { fromRecords, toRecords } from "./history";
import type { BoardStore } from "./mount";

/** A document kept elsewhere: CoCalc's syncdb (later); a fake one in the tests. */
export interface RemoteBoard {
  /** The SHA-256 (hex) of the canonical JSON of the document it has now; null: none yet.  Rejects: unreachable. */
  hash(): Promise<string | null>;
  /** The document it has now; null: none yet. */
  load(): Promise<BoardDoc | null>;
  /** Keep the document as it is now. */
  save(doc: BoardDoc): Promise<void>;
  /** Its changes made elsewhere (another person, another tab): the document then. */
  subscribe?(f: (doc: BoardDoc) => void): () => void;
}

/** A copy kept in this browser: the canonical JSON shown, its hash, and the
 * remote version it is based on (its hash; while it holds edits the remote
 * has not seen, the version itself). */
export interface CachedDoc { key: string; json: string; hash: string; remoteHash: string | null; base?: string; at: number }
export interface DocCache {
  get(key: string): Promise<CachedDoc | null>;
  put(c: CachedDoc): Promise<void>;
}

/** The SHA-256 of a document's canonical JSON, in hex ("" where there is no crypto.subtle: never the same as a remote's). */
export async function docHash(d: BoardDoc): Promise<string> {
  if (!globalThis.crypto?.subtle) return "";
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(d))));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- the copies: IndexedDB --------------------------------------------------

const req = <T>(r: IDBRequest<T>) => new Promise<T>((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });

/** Copies of documents in this browser's IndexedDB (database
 * sagebrush-board-docs), the least recently opened dropped beyond `max`. */
export class IdbDocCache implements DocCache {
  private db: Promise<IDBDatabase> | null = null;
  constructor(private name = "sagebrush-board-docs", private max = 200) {}
  private open() {
    return (this.db ??= new Promise<IDBDatabase>((ok, no) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("docs", { keyPath: "key" }).createIndex("at", "at");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    }));
  }
  async get(key: string): Promise<CachedDoc | null> {
    const db = await this.open();
    const c = (await req(db.transaction("docs").objectStore("docs").get(key))) as CachedDoc | undefined;
    if (!c) return null;
    // (opened now: the last to be dropped)
    db.transaction("docs", "readwrite").objectStore("docs").put({ ...c, at: Date.now() });
    return c;
  }
  async put(c: CachedDoc): Promise<void> {
    const db = await this.open(), t = db.transaction("docs", "readwrite"), st = t.objectStore("docs");
    st.put(c);
    const n = await req(st.count());
    if (n > this.max) {
      // (the least recently opened beyond the limit)
      let extra = n - this.max;
      const cur = st.index("at").openCursor();
      cur.onsuccess = () => { const k = cur.result; if (k && extra-- > 0) { k.delete(); k.continue(); } };
    }
    await new Promise<void>((ok, no) => { t.oncomplete = () => ok(); t.onerror = () => no(t.error); });
  }
}

// ---- merging ----------------------------------------------------------------

/** What both sides changed: kept as ours. */
export interface Conflict { type: string; page: string; id: string; field: string }

// (a record's key: its type, page and id, whatever they hold, CORR-3D2-3)
const recKey = (r: any) => JSON.stringify([r.type, r.page, r.id]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// (records as fromRecords reads them)
const records = (rs: any[]) => {
  const match = (where: any) => (r: any) => Object.entries(where).every(([k, v]) => r[k] === v);
  return { get: (w: object) => rs.filter(match(w)), getOne: (w: object) => rs.find(match(w)), set: () => { throw new Error("read only"); }, delete: () => { throw new Error("read only"); }, isEqual: () => false } as any;
};

/**
 * Three documents merged by records (history.ts: the document, its pages,
 * items and edges, keyed): from `base`, a record or a field changed on one
 * side only takes that side's change, a record added or removed on one side
 * is added or removed; changed on both sides differently, ours is kept and
 * listed.  The pictures' sizes merge by name.
 */
export function merge3(base: BoardDoc, ours: BoardDoc, theirs: BoardDoc): { doc: BoardDoc; conflicts: Conflict[] } {
  const by = (d: BoardDoc) => new Map(toRecords(d).map((r) => [recKey(r), r]));
  const B = by(base), O = by(ours), T = by(theirs), out: any[] = [], conflicts: Conflict[] = [];
  for (const k of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
    const b = B.get(k), o = O.get(k), t = T.get(k);
    let r: any;
    if (same(o, b)) r = t;
    else if (same(t, b) || same(o, t)) r = o;
    // (removed on one side, changed on the other: kept, changed)
    else if (!o || !t) { r = o ?? t; const x = o ?? t; conflicts.push({ type: x.type, page: x.page, id: x.id, field: "" }); }
    else {
      r = {};
      for (const f of new Set([...Object.keys(b ?? {}), ...Object.keys(o), ...Object.keys(t)])) {
        const fb = b?.[f], fo = o[f], ft = t[f];
        let v: unknown;
        if (f === "images" && o.type === "doc") {
          // (by name: added on either side, removed on one, changed on both differently: ours, CORR-3D2-4)
          const out: Record<string, unknown> = {};
          for (const name of new Set([...Object.keys(fb ?? {}), ...Object.keys(fo ?? {}), ...Object.keys(ft ?? {})])) {
            const ib = fb?.[name], io = fo?.[name], it = ft?.[name];
            let x: unknown;
            if (same(io, ib)) x = it;
            else if (same(it, ib) || same(io, it)) x = io;
            else { x = io ?? it; conflicts.push({ type: "doc", page: "", id: "", field: "images." + name }); }
            if (x !== undefined) out[name] = x;
          }
          v = Object.keys(out).length ? out : undefined;
        }
        else if (same(fo, fb)) v = ft;
        else if (same(ft, fb) || same(fo, ft)) v = fo;
        else { v = fo; conflicts.push({ type: o.type, page: o.page, id: o.id, field: f }); }
        if (v !== undefined) r[f] = v;
      }
    }
    if (r) out.push(r);
  }
  // (a page removed on one side: its items, kept by the other, go to the first page; a group removed: its members to the top level)
  const pages = new Set(out.filter((r) => r.type === "page").map((r) => r.page)), paged = out.some((r) => r.type === "doc" && r.paged);
  const first = out.filter((r) => r.type === "page").sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))[0]?.page ?? "";
  const groups = new Set(out.filter((r) => r.type === "item" && r.kind === "group").map((r) => JSON.stringify([r.page, r.id])));
  for (const r of out) {
    if ((r.type === "item" || r.type === "edge") && paged && !pages.has(r.page)) r.page = first;
    if (r.type === "item" && r.parent && !groups.has(JSON.stringify([r.page, r.parent]))) r.parent = "";
  }
  // (no edges where ours had none: the records always give a list)
  const doc = fromRecords(records(out)) as any;
  const bare = (m: any, o: any) => { if (m && Array.isArray(m.edges) && !m.edges.length && !o?.edges) delete m.edges; };
  bare(doc, ours);
  (doc.pages ?? []).forEach((p: any, i: number) => bare(p, ours.pages?.find((q) => q.id !== undefined && q.id === p.id) ?? (p.id === undefined ? ours.pages?.[i] : undefined)));
  return { doc: cleanDoc(doc), conflicts };
}

/** The caption's words for a merge with conflicts. */
export const mergedNotice = (n: number) => `**This board was changed elsewhere while you edited it.** The changes are merged; where both changed the same thing (${n}), yours is kept.`;

// ---- the store --------------------------------------------------------------

/** How the store's first load ended, once the remote has answered (or not). */
export type Synced = "fresh" | "same" | "pushed" | "replaced" | "merged" | "offline";

/**
 * A BoardStore for `remote`, its copy in `cache` under `key` (see
 * board-in-cocalc.md: the key names one document, scoped to its site,
 * account and project, or an immutable document id).  `synced`: how the
 * first load ended, once the remote has answered.
 *
 * Two orders: the copy's writes, in the order they are made (each reads the
 * copy as the one before left it, CORR-3D2-1), and the work with the
 * remote, in order.  Whatever the copy holds that the remote has not seen
 * is pushed, the copy as it is then: never an older edit over a newer one.
 */
export function cachedStore(remote: RemoteBoard, key: string, cache: DocCache = new IdbDocCache()): BoardStore & { synced: Promise<Synced> } {
  let entry: CachedDoc | null = null;
  // (the remote has answered: edits go to it too; the first load is over)
  let online = false, settled = false;
  let copying: Promise<unknown> = Promise.resolve(), queue: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(f: () => Promise<T>) => { const p = copying.then(f); copying = p.catch(() => {}); return p; };
  const later = <T>(f: () => Promise<T>) => { const p = queue.then(f); queue = p.catch(() => {}); return p; };
  let resolveSynced!: (s: Synced) => void;
  const synced = new Promise<Synced>((ok) => (resolveSynced = ok));

  // What the board shows (its edits are made from it), and a document given
  // it and not yet shown: an edit made meanwhile was made from the one before
  const listeners = new Set<(d: BoardDoc, notice?: string) => void | Promise<void>>();
  let shown: BoardDoc | null = null, showing: { from: BoardDoc | null; to: BoardDoc } | null = null;
  let unsent: [BoardDoc, string | undefined] | null = null;
  function give(d: BoardDoc, notice?: string, to = [...listeners]) {
    showing = { from: showing?.from ?? shown, to: d };
    Promise.all(to.map((f) => f(d, notice))).then(() => { if (showing?.to === d) { shown = d; showing = null; } }, (e) => console.warn("board: shown:", e));
  }
  const emit = (d: BoardDoc, notice?: string) => { if (listeners.size) give(d, notice); else unsent = [d, notice]; };

  // the copy as it is now, based on the remote version `remoteHash` (`base` while they differ); in order only
  async function keep(d: BoardDoc, remoteHash: string | null, base?: string) {
    const json = canonical(d), hash = await docHash(d);
    entry = { key, json, hash, remoteHash, ...(hash !== remoteHash && base !== undefined ? { base } : {}), at: Date.now() };
    await cache.put(entry).catch((e) => console.warn("board: the copy:", e));
  }
  const parse = (json: string) => cleanDoc(JSON.parse(json));
  const dirty = () => !!entry && entry.hash !== entry.remoteHash;
  // (the remote has `d` now: the copy is based on it; in order only)
  async function sent(d: BoardDoc, h: string) {
    if (!entry) return;
    entry = entry.hash === h ? (({ base: _b, ...e }) => ({ ...e, remoteHash: h }))(entry) : { ...entry, remoteHash: h, base: canonical(d) };
    await cache.put(entry).catch((e) => console.warn("board: the copy:", e));
  }

  // the copy, if it holds what the remote has not seen: to the remote (with the remote's work)
  async function push(): Promise<boolean> {
    if (!online) return false;
    const d = await inOrder(async () => (dirty() ? parse(entry!.json) : null));
    if (!d) return false;
    await remote.save(d);
    const h = await docHash(d);
    await inOrder(() => sent(d, h));
    return true;
  }

  // the remote has a document other than the copy's base: replace, or merge (with the remote's work)
  async function arrived(theirs: BoardDoc, theirHash: string): Promise<Synced> {
    const r = await inOrder(async () => {
      // (what the copy is based on, or shows, already: our own save, come back)
      if (entry && (theirHash === entry.remoteHash || theirHash === entry.hash)) {
        if (theirHash === entry.hash && dirty()) await sent(theirs, theirHash);
        return { s: "same" as const };
      }
      if (!entry || !dirty()) {
        await keep(theirs, theirHash);
        return { s: "replaced" as const, doc: theirs };
      }
      const { doc, conflicts } = merge3(parse(entry.base ?? entry.json), parse(entry.json), theirs);
      await keep(doc, theirHash, canonical(theirs));
      return { s: "merged" as const, doc, notice: conflicts.length ? mergedNotice(conflicts.length) : undefined };
    });
    if (r.doc) emit(r.doc, r.notice);
    if (r.s === "merged") await push();
    return r.s;
  }

  async function sync(): Promise<Synced> {
    let h: string | null;
    try { h = await remote.hash(); } catch { return "offline"; }
    // (the copy as the edits made before the remote answered left it)
    const known = await inOrder(async () => entry!.remoteHash);
    online = true;
    if (h !== null && h === known) return (await push()) ? "pushed" : "same";
    let theirs: BoardDoc | null;
    try { theirs = await remote.load(); } catch { online = false; return "offline"; }
    // (the remote has none: the copy is its first)
    if (!theirs) { await inOrder(async () => { if (entry) entry = { ...entry, remoteHash: null }; }); await push(); return "pushed"; }
    return arrived(cleanDoc(theirs), h ?? (await docHash(theirs)));
  }

  // the first load over: a change made elsewhere meanwhile, the latest, now (CORR-3D2-2)
  let waiting: BoardDoc | null = null;
  function settle(s: Synced) {
    settled = true;
    resolveSynced(s);
    if (waiting) { const d = waiting; waiting = null; later(async () => { await arrived(d, await docHash(d)); }); }
  }

  return {
    synced,
    async load() {
      const c = await cache.get(key).catch(() => null);
      if (c) {
        entry = c;
        const doc = parse(c.json);
        shown = doc;
        // (the copy now; the remote asked meanwhile, edits waiting for it)
        later(async () => settle(await sync().catch((e) => { console.warn("board: the remote:", e); online = false; return "offline" as const; })));
        return { doc };
      }
      // (no copy: the remote's)
      let d: BoardDoc | null;
      try { d = await remote.load(); } catch (e) { settle("offline"); throw e; }
      online = true;
      if (!d) { settle("fresh"); return null; }
      const doc = cleanDoc(d);
      await inOrder(async () => keep(doc, await docHash(doc)));
      shown = doc;
      settle("fresh");
      return { doc };
    },
    save(d) {
      // (in the copy, in order; made from what the board showed before a
      // document given it was shown: merged with that one, and shown)
      inOrder(async () => {
        let doc = d;
        if (showing?.from) {
          doc = merge3(showing.from, d, showing.to).doc;
          emit(doc);
        }
        const base = dirty() ? entry!.base ?? entry!.json : entry?.json;
        await keep(doc, entry?.remoteHash ?? null, base);
      });
      // (to the remote, once it has answered: the copy as it is then)
      later(() => push().catch((e) => { console.warn("board: the remote:", e); return false; }));
    },
    subscribe(f) {
      listeners.add(f);
      if (unsent) { const [d, n] = unsent; unsent = null; give(d, n, [f]); }
      // (the remote's changes made elsewhere: after the first load, the latest of those made during it)
      const off = remote.subscribe?.((d) => {
        const doc = cleanDoc(d);
        if (!settled) { waiting = doc; return; }
        later(async () => { await arrived(doc, await docHash(doc)); });
      });
      return () => { listeners.delete(f); off?.(); };
    },
  };
}
