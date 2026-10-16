// The cache of code items' outputs beside a board (design/outputs.md,
// section 2).  An item whose time from root is over CACHE_MS keeps its full
// outputs here after it runs, under its output key (the hash of its code, its
// seed, the language and the keys of what it reads: src/notebook-reactive.ts
// keys()), so opening the board again shows them at once, without running it.
//
// One cache per board, named by its host's store beside the board (not by
// anything in the board, which anyone can copy: SEC-B88-1), never shared
// between boards, and dropped when the board is replaced, so
// nothing is counted: a board's entries are collected by mark and sweep (the
// mark: its items' keys now) when it is over DOC_CAP, and the boards of a
// browser used least recently go whole when all are over ALL_CAP.
//
// IdbOutputCache is this browser's (IndexedDB); a host may give another (in
// CoCalc, a file beside the board's).
import { openDb } from "./idb-open";

export interface CachedOutputs {
  key: string;
  outputs: any[];
  /** when computed (ISO 8601), its own time and its time from root, ms */
  at: string;
  ms: number;
  total: number;
  /** the engine that computed it (design/engines.md), if known: recorded, not keyed */
  engine?: string;
  /** where it is kept, for its label (the cache that gave it says, never the entry's source) */
  where?: "file";
}

export interface OutputCache {
  /** the entries among `keys` (and each is marked as used now) */
  get(doc: string, keys: string[]): Promise<Map<string, CachedOutputs>>;
  put(doc: string, entry: CachedOutputs): Promise<void>;
  /** keep the board within DOC_CAP (the marked `live` keys last), and the browser within ALL_CAP */
  sweep(doc: string, live: Set<string>): Promise<void>;
  /** the board is gone: its entries too */
  drop(doc: string): Promise<void>;
}

/** items over this many ms from root keep their outputs here */
export const CACHE_MS = 2000;
/** an entry over this is not kept (a 3D mesh of millions of triangles: its picture is, in the outputs) */
export const ENTRY_MAX = 16 * 1024 * 1024;
export const DOC_CAP = 64 * 1024 * 1024, ALL_CAP = 512 * 1024 * 1024;

/** "Computed October 13 (12 s), kept in this browser. Run to recompute." */
export function cachedLabel(e: CachedOutputs): string {
  const d = new Date(e.at), s = e.total / 1000;
  const when = isNaN(+d) ? "" : ` ${d.toLocaleDateString(undefined, { month: "long", day: "numeric" })}`;
  return `Computed${when} (${s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.round(s / 60)} min`}), ${e.where === "file" ? "carried in this file" : "kept in this browser"}. Run to recompute.`;
}

const utf8 = new TextEncoder();
export const sizeOf = (outputs: unknown) => utf8.encode(JSON.stringify(outputs)).length;

/**
 * The outputs a downloaded board carries (design/outputs.md, section 3),
 * from its #sb-outputs: the well-formed entries, each at most ENTRY_MAX, at
 * most DOC_CAP in all (the rest dropped), marked as the file's.  They are
 * the file's to say, as its code and previews are: shown as its code's
 * outputs are, through the same bounds.
 */
export function carriedOutputs(json: unknown): CachedOutputs[] {
  const out: CachedOutputs[] = [];
  if (!Array.isArray(json)) return out;
  let total = 0;
  for (const e of json) {
    if (!e || typeof e !== "object" || typeof e.key !== "string" || !/^[0-9a-f]{64}$/.test(e.key) || !Array.isArray(e.outputs)) continue;
    const num = (x: unknown) => (typeof x === "number" && isFinite(x) && x >= 0 ? x : 0);
    const bytes = sizeOf(e.outputs);
    if (bytes > ENTRY_MAX || total + bytes > DOC_CAP) continue;
    total += bytes;
    out.push({ key: e.key, outputs: e.outputs, at: typeof e.at === "string" ? e.at.slice(0, 40) : "", ms: num(e.ms), total: num(e.total), ...(typeof e.engine === "string" ? { engine: e.engine.slice(0, 64) } : {}), where: "file" });
  }
  return out;
}

/**
 * A cache in memory, for a downloaded board: the outputs it carries
 * (carriedOutputs()) are the cache of the first board shown that asks for
 * them, the one the file holds; what runs meanwhile is kept until the page
 * closes.  Another board shown in its place drops them, as any cache's.
 */
export class MemoryOutputCache implements OutputCache {
  private docs = new Map<string, Map<string, CachedOutputs>>();
  constructor(private carried: CachedOutputs[] = []) {}
  private of(doc: string): Map<string, CachedOutputs> {
    let m = this.docs.get(doc);
    if (!m) {
      m = new Map(this.carried.map((e) => [e.key, e]));
      this.carried = [];
      this.docs.set(doc, m);
    }
    return m;
  }
  async get(doc: string, keys: string[]): Promise<Map<string, CachedOutputs>> {
    const m = this.of(doc), out = new Map<string, CachedOutputs>();
    for (const k of keys) if (m.has(k)) out.set(k, m.get(k)!);
    return out;
  }
  async put(doc: string, entry: CachedOutputs): Promise<void> {
    if (sizeOf(entry.outputs) <= ENTRY_MAX) this.of(doc).set(entry.key, { ...entry, where: undefined });
  }
  async sweep(doc: string, live: Set<string>): Promise<void> {
    const m = this.of(doc);
    const entries = [...m.values()].map((e, i) => ({ key: e.key, bytes: sizeOf(e.outputs), used: i }));
    for (const k of sweepOrder(entries, live, DOC_CAP)) m.delete(k);
  }
  async drop(doc: string): Promise<void> {
    this.of(doc);
    this.docs.delete(doc);
  }
}

/** The entries of one board to remove to fit `cap`: unmarked ones, least recently used first; marked ones only if they alone are over it. */
export function sweepOrder(entries: { key: string; bytes: number; used: number }[], live: Set<string>, cap: number): string[] {
  let total = entries.reduce((s, e) => s + e.bytes, 0);
  const out: string[] = [];
  const byUse = (a: { used: number }, b: { used: number }) => a.used - b.used;
  for (const e of [...entries.filter((e) => !live.has(e.key)).sort(byUse), ...entries.filter((e) => live.has(e.key)).sort(byUse)]) {
    if (total <= cap) break;
    total -= e.bytes;
    out.push(e.key);
  }
  return out;
}

/** The boards to remove whole to fit `cap`: least recently used first, never `keep`. */
export function dropOrder(docs: { doc: string; bytes: number; used: number }[], keep: string, cap: number): string[] {
  let total = docs.reduce((s, d) => s + d.bytes, 0);
  const out: string[] = [];
  for (const d of [...docs].filter((d) => d.doc !== keep).sort((a, b) => a.used - b.used)) {
    if (total <= cap) break;
    total -= d.bytes;
    out.push(d.doc);
  }
  return out;
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });

/**
 * This browser's cache, in IndexedDB: `entries` ({doc, key, ...entry,
 * bytes, used}, by [doc, key], indexed by doc) and `docs` ({doc, bytes,
 * used}: each board's total, and when it was last used).
 */
export class IdbOutputCache implements OutputCache {
  private db: Promise<IDBDatabase> | null = null;
  // (each operation after the one before it, in the order asked: a drop
  // asked after a put is never overtaken by it, SEC-975-4)
  private queue: Promise<unknown> = Promise.resolve();
  private inOrder<T>(f: () => Promise<T>): Promise<T> {
    const p = this.queue.then(f);
    this.queue = p.catch(() => {});
    return p;
  }
  /** @param engine the id of the engine computing what is put (recorded with each entry) */
  constructor(readonly engine?: string, readonly name = "sagebrush-outputs", readonly caps = { doc: DOC_CAP, all: ALL_CAP }) {}
  private open(): Promise<IDBDatabase> {
    // (bounded, web/board/idb-open.ts: an open that never answers fails, and
    // the next operation tries again, as one closed for another page's upgrade does)
    if (!this.db) {
      const p: Promise<IDBDatabase> = openDb(this.name, 1, (db) => {
        db.createObjectStore("entries", { keyPath: ["doc", "key"] }).createIndex("doc", "doc");
        db.createObjectStore("docs", { keyPath: "doc" });
      }, () => { if (this.db === p) this.db = null; });
      this.db = p;
      p.catch(() => { if (this.db === p) this.db = null; });
    }
    return this.db;
  }
  get(doc: string, keys: string[]): Promise<Map<string, CachedOutputs>> {
    return this.inOrder(() => this.getNow(doc, keys));
  }
  put(doc: string, entry: CachedOutputs): Promise<void> {
    return this.inOrder(() => this.putNow(doc, entry));
  }
  sweep(doc: string, live: Set<string>): Promise<void> {
    return this.inOrder(() => this.sweepNow(doc, live));
  }
  drop(doc: string): Promise<void> {
    return this.inOrder(() => this.dropNow(doc));
  }
  private async getNow(doc: string, keys: string[]): Promise<Map<string, CachedOutputs>> {
    const out = new Map<string, CachedOutputs>();
    if (!keys.length) return out;
    const db = await this.open(), t = db.transaction(["entries", "docs"], "readwrite"), es = t.objectStore("entries"), now = Date.now();
    for (const key of keys) {
      const e = await req(es.get([doc, key]));
      if (!e) continue;
      const { doc: _d, bytes: _b, used: _u, ...entry } = e;
      out.set(key, entry);
      es.put({ ...e, used: now });
    }
    if (out.size) {
      const ds = t.objectStore("docs"), d = await req(ds.get(doc));
      if (d) ds.put({ ...d, used: now });
    }
    await done(t);
    return out;
  }
  private async putNow(doc: string, entry: CachedOutputs): Promise<void> {
    const bytes = sizeOf(entry.outputs);
    if (bytes > ENTRY_MAX) return;
    const db = await this.open(), t = db.transaction(["entries", "docs"], "readwrite"), es = t.objectStore("entries"), ds = t.objectStore("docs"), now = Date.now();
    const old = await req(es.get([doc, entry.key]));
    es.put({ ...entry, ...(this.engine && !entry.engine ? { engine: this.engine } : {}), doc, bytes, used: now });
    const d = (await req(ds.get(doc))) ?? { doc, bytes: 0, used: now };
    ds.put({ doc, bytes: d.bytes - (old?.bytes ?? 0) + bytes, used: now });
    await done(t);
  }
  private async sweepNow(doc: string, live: Set<string>): Promise<void> {
    const db = await this.open();
    {
      const t = db.transaction(["entries", "docs"], "readwrite"), es = t.objectStore("entries"), ds = t.objectStore("docs");
      const all: any[] = await req(es.index("doc").getAll(doc));
      const gone = new Set(sweepOrder(all, live, this.caps.doc));
      for (const key of gone) es.delete([doc, key]);
      const bytes = all.filter((e) => !gone.has(e.key)).reduce((s, e) => s + e.bytes, 0);
      const d = await req(ds.get(doc));
      if (d || bytes) ds.put({ doc, bytes, used: d?.used ?? Date.now() });
      await done(t);
    }
    const docs: any[] = await req(db.transaction("docs").objectStore("docs").getAll());
    for (const other of dropOrder(docs, doc, this.caps.all)) await this.dropNow(other);
  }
  private async dropNow(doc: string): Promise<void> {
    const db = await this.open(), t = db.transaction(["entries", "docs"], "readwrite"), es = t.objectStore("entries");
    for (const k of await req(es.index("doc").getAllKeys(doc))) es.delete(k);
    t.objectStore("docs").delete(doc);
    await done(t);
  }
}
