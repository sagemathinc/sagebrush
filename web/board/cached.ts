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

const recKey = (r: any) => `${r.type}\0${r.page}\0${r.id}`;
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
        if (f === "images" && o.type === "doc") v = { ...(fb ?? {}), ...(ft ?? {}), ...(fo ?? {}) };
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
  const groups = new Set(out.filter((r) => r.type === "item" && r.kind === "group").map((r) => `${r.page}\0${r.id}`));
  for (const r of out) {
    if ((r.type === "item" || r.type === "edge") && paged && !pages.has(r.page)) r.page = first;
    if (r.type === "item" && r.parent && !groups.has(`${r.page}\0${r.parent}`)) r.parent = "";
  }
  return { doc: cleanDoc(fromRecords(records(out))), conflicts };
}

/** The caption's words for a merge with conflicts. */
export const mergedNotice = (n: number) => `**This board was changed elsewhere while you edited it.** The changes are merged; where both changed the same thing (${n}), yours is kept.`;

// ---- the store --------------------------------------------------------------

/** How the store's first load ended, once the remote has answered (or not). */
export type Synced = "fresh" | "same" | "pushed" | "replaced" | "merged" | "offline";

/**
 * A BoardStore for `remote`, its copy in `cache` under `key` (CoCalc's:
 * account, project and path).  `synced`: how the first load ended, once
 * the remote has answered.
 */
export function cachedStore(remote: RemoteBoard, key: string, cache: DocCache = new IdbDocCache()): BoardStore & { synced: Promise<Synced> } {
  let entry: CachedDoc | null = null;
  // (the remote has answered: edits go to it too)
  let online = false;
  let queue: Promise<unknown> = Promise.resolve();
  const later = <T>(f: () => Promise<T>) => { const p = queue.then(f); queue = p.catch(() => {}); return p; };
  const listeners = new Set<(d: BoardDoc, notice?: string) => void>();
  let unsent: [BoardDoc, string | undefined] | null = null;
  const emit = (d: BoardDoc, notice?: string) => { if (listeners.size) for (const f of listeners) f(d, notice); else unsent = [d, notice]; };
  let resolveSynced!: (s: Synced) => void;
  const synced = new Promise<Synced>((ok) => (resolveSynced = ok));

  // the copy as it is now, based on the remote version `remoteHash` (`base` while they differ)
  async function keep(d: BoardDoc, remoteHash: string | null, base?: string) {
    const json = canonical(d), hash = await docHash(d);
    entry = { key, json, hash, remoteHash, ...(hash !== remoteHash && base !== undefined ? { base } : {}), at: Date.now() };
    await cache.put(entry).catch((e) => console.warn("board: the copy:", e));
  }
  const parse = (json: string) => cleanDoc(JSON.parse(json));
  const dirty = () => !!entry && entry.hash !== entry.remoteHash;

  // the remote has a document other than the copy's base: replace, or merge
  async function arrived(theirs: BoardDoc, theirHash: string): Promise<Synced> {
    // (what the copy shows already: our own save, come back)
    if (entry && theirHash && theirHash === entry.hash) { if (dirty()) await keep(theirs, theirHash); return "same"; }
    if (!entry || !dirty()) {
      await keep(theirs, theirHash);
      emit(theirs);
      return "replaced";
    }
    const base = parse(entry.base ?? entry.json), ours = parse(entry.json);
    const { doc, conflicts } = merge3(base, ours, theirs);
    emit(doc, conflicts.length ? mergedNotice(conflicts.length) : undefined);
    await remote.save(doc);
    await keep(doc, await docHash(doc));
    return "merged";
  }

  async function sync(): Promise<Synced> {
    let h: string | null;
    try { h = await remote.hash(); } catch { return "offline"; }
    if (h !== null && h === entry!.remoteHash) {
      if (!dirty()) return "same";
      // (edits the copy holds, made offline: to the remote)
      const d = parse(entry!.json);
      await remote.save(d);
      await keep(d, entry!.hash);
      return "pushed";
    }
    let theirs: BoardDoc | null;
    try { theirs = await remote.load(); } catch { return "offline"; }
    if (!theirs) {
      // (the remote has none: the copy is its first)
      const d = parse(entry!.json);
      await remote.save(d);
      await keep(d, entry!.hash);
      return "pushed";
    }
    return arrived(cleanDoc(theirs), h ?? (await docHash(theirs)));
  }

  return {
    synced,
    async load() {
      const c = await cache.get(key).catch(() => null);
      if (c) {
        entry = c;
        // (the copy now; the remote asked meanwhile, edits waiting for it)
        later(async () => {
          const s = await sync().catch((e) => { console.warn("board: the remote:", e); return "offline" as const; });
          online = s !== "offline";
          resolveSynced(s);
        });
        return { doc: parse(c.json) };
      }
      // (no copy: the remote's)
      const d = await remote.load();
      online = true;
      if (!d) { resolveSynced("fresh"); return null; }
      const doc = cleanDoc(d);
      await keep(doc, await docHash(doc));
      resolveSynced("fresh");
      return { doc };
    },
    save(d) {
      // (in the copy at once; to the remote once it has answered, in order:
      // an edit made before it answered is the merge's, or the push's, not
      // sent again over it)
      const base = dirty() ? entry!.base ?? entry!.json : entry?.json, after = online;
      const p = keep(d, entry?.remoteHash ?? null, base);
      later(async () => {
        await p;
        if (!after || !online) return;
        try {
          await remote.save(d);
          await keep(d, await docHash(d));
        } catch (e) {
          console.warn("board: the remote:", e);
        }
      });
    },
    subscribe(f) {
      listeners.add(f);
      if (unsent) { const [d, n] = unsent; unsent = null; f(d, n); }
      // (the remote's changes made elsewhere, once it has answered)
      const off = remote.subscribe?.((d) => { later(async () => { if (online) await arrived(cleanDoc(d), await docHash(d)); }); });
      return () => { listeners.delete(f); off?.(); };
    },
  };
}
