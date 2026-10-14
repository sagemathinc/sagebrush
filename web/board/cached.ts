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
  const baseRecs = toRecords(base);
  const by = (rs: any[]) => new Map(rs.map((r) => [recKey(r), r]));
  const oRecs = aligned(baseRecs, toRecords(ours), "o"), tRecs = aligned(baseRecs, toRecords(theirs), "t");
  // (pages that cannot be told apart: ours, and said so, CORR-EB9-2)
  if (!oRecs || !tRecs) return { doc: cleanDoc(ours), conflicts: [{ type: "page", page: "", id: "", field: "pages" }] };
  const B = by(baseRecs), O = by(oRecs), T = by(tRecs), out: any[] = [], conflicts: Conflict[] = [];
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
            // (changed on both sides: ours, a removal too, CORR-891-4)
            else { x = io; conflicts.push({ type: "doc", page: "", id: "", field: "images." + name }); }
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

// A side's pages without ids (a document from elsewhere: the store gives
// its own pages ids, CORR-EB9-2), keyed as the base's they are: records key
// such a page by its place, which a page put in front of it changes
// (CORR-891-2).  Each is matched, one to one, to the base page (one this
// side does not have by its id) it shares most with: its items, its title,
// and each of its other fields (intro, slide, background, tour, template)
// with the same value.  A page matching none is a page added, if no base
// page is left for it; if some are, which it is cannot be told: null (the
// caller keeps ours, and says so), never a guess.
function aligned(baseRecs: any[], recs: any[], side: string): any[] | null {
  const pagesOf = (rs: any[]) => rs.filter((r) => r.type === "page").sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
  const sp = pagesOf(recs).filter((r) => r.anon === true);
  if (!sp.length) return recs;
  const own = new Set(pagesOf(recs).filter((r) => r.anon !== true).map((r) => r.page));
  const bp = pagesOf(baseRecs).filter((r) => !own.has(r.page));
  const itemsOf = (rs: any[], pid: string) => new Set(rs.filter((r) => r.type === "item" && r.page === pid).map((r) => r.id));
  const bItems = bp.map((p) => itemsOf(baseRecs, p.page)), sItems = sp.map((p) => itemsOf(recs, p.page));
  const fields = (r: any) => Object.entries(r).filter(([k]) => !["type", "page", "id", "pos", "anon", "title"].includes(k));
  const pairs: [number, number, number][] = [];
  sp.forEach((p, j) => bp.forEach((q, i) => {
    let score = 0;
    for (const id of sItems[j]) if (bItems[i].has(id)) score++;
    if (p.title && p.title === q.title) score += 0.5;
    for (const [k, v] of fields(p)) if (k in q && same(v, q[k])) score += 0.25;
    if (score > 0) pairs.push([score, j, i]);
  }));
  pairs.sort((a, b) => b[0] - a[0] || Math.abs(a[1] - a[2]) - Math.abs(b[1] - b[2]));
  const to = new Map<number, number>(), taken = new Set<number>();
  for (const [, j, i] of pairs) if (!to.has(j) && !taken.has(i)) { to.set(j, i); taken.add(i); }
  // (one matching none while a base page is left: which it is cannot be told)
  if (sp.some((_, j) => !to.has(j)) && bp.some((_, i) => !taken.has(i))) return null;
  // (keys: the base page's; a new page's, none any page has)
  const used = new Set([...baseRecs, ...recs].filter((r) => r.type === "page").map((r) => r.page));
  const key = new Map<string, string>();
  sp.forEach((p, j) => {
    const i = to.get(j);
    if (i !== undefined) key.set(p.page, bp[i].page);
    else { let k = `#${side}${j}`; while (used.has(k)) k += "#"; used.add(k); key.set(p.page, k); }
  });
  return recs.map((r) => (key.has(r.page) ? { ...r, page: key.get(r.page) } : r));
}

/** The caption's words for a merge with conflicts. */
export const mergedNotice = (n: number) => `**This board was changed elsewhere while you edited it.** The changes are merged; where both changed the same thing (${n}), yours is kept.`;

// ---- the store --------------------------------------------------------------

/** `d` with an id for each page without one (the file keeps them: a page's
 * identity in a merge, CORR-EB9-2); `d` itself if every page has one. */
export function identified(d: BoardDoc): BoardDoc {
  if (!d.pages?.some((p) => p.id == null)) return d;
  const taken = new Set(d.pages.map((p) => p.id).filter((x) => x != null) as string[]);
  const fresh = () => { let k; do k = "p" + Math.random().toString(36).slice(2, 10); while (taken.has(k)); taken.add(k); return k; };
  return { ...d, pages: d.pages.map((p) => (p.id == null ? { ...p, id: fresh() } : p)) };
}

/** How the store's first load ended, once the remote has answered (or not). */
export type Synced = "fresh" | "same" | "pushed" | "replaced" | "merged" | "offline";

/**
 * A BoardStore for `remote`, its copy in `cache` under `key` (see
 * board-in-cocalc.md: the key names one document, scoped to its site,
 * account and project, or an immutable document id).  `synced`: how the
 * first load ended, once the remote has answered.
 *
 * One queue of steps, each finished before the next starts: an edit, the
 * remote's answer to a question, a change made elsewhere.  No step waits on
 * the remote or the screen: what the remote is asked (its hash, its
 * document, a save) is answered by a step of its own, in the order the
 * answers come, so an edit reaches the copy at once, whatever the remote.
 * One save is on its way at a time: whatever the copy holds that the remote
 * has not seen goes next, the copy as it is then; a change made elsewhere
 * while a save is on its way is merged with the copy before it (and goes
 * with the next one, CORR-C06-1).  The documents given the board are given
 * one at a time, each once the one before is shown (CORR-C06-3).
 */
export function cachedStore(remote: RemoteBoard, key: string, cache: DocCache = new IdbDocCache()): BoardStore & { synced: Promise<Synced> } {
  let entry: CachedDoc | null = null;
  // (the remote has answered: edits go to it too)
  let online = false;
  let queue: Promise<unknown> = Promise.resolve();
  const step = <T>(f: () => Promise<T>) => { const p = queue.then(f); queue = p.catch((e) => console.warn("board: the store:", e)); return p; };
  let resolveSynced!: (s: Synced) => void;
  const synced = new Promise<Synced>((ok) => (resolveSynced = ok));

  // What the board shows (its edits are made from it): what it loaded, each
  // edit it made (when made), and each document given it, once it says it is
  // shown.  The copy may be ahead of what an edit was made from (documents
  // given and not yet shown, CORR-891-3): the edit is merged with it.
  const listeners = new Set<(d: BoardDoc, notice?: string) => void | Promise<void>>();
  let view: BoardDoc | null = null;
  const unsent: [BoardDoc, string | undefined][] = [];
  let showing: Promise<unknown> = Promise.resolve();
  function present(d: BoardDoc, notice?: string) {
    if (!listeners.size) { unsent.push([d, notice]); return; }
    const to = [...listeners];
    showing = showing.then(() => Promise.all(to.map((f) => f(d, notice)))).then(() => { view = d; }, (e) => console.warn("board: shown:", e));
  }

  // the copy as it is now, based on the remote version `remoteHash` (`base` while they differ)
  async function keep(d: BoardDoc, remoteHash: string | null, base?: string) {
    const json = canonical(d), hash = await docHash(d);
    entry = { key, json, hash, remoteHash, ...(hash !== remoteHash && base !== undefined ? { base } : {}), at: Date.now() };
    await cache.put(entry).catch((e) => console.warn("board: the copy:", e));
  }
  const parse = (json: string) => cleanDoc(JSON.parse(json));
  const dirty = () => !!entry && entry.hash !== entry.remoteHash;
  // (the remote has `d` now: the copy is based on it)
  async function sent(d: BoardDoc, h: string) {
    if (!entry) return;
    entry = entry.hash === h ? (({ base: _b, ...e }) => ({ ...e, remoteHash: h }))(entry) : { ...entry, remoteHash: h, base: canonical(d) };
    await cache.put(entry).catch((e) => console.warn("board: the copy:", e));
  }

  // The copy, if it holds what the remote has not seen, to the remote: one
  // save on its way at a time, the next once it is done (from a step)
  let saving = false;
  function push() {
    if (!online || saving || !dirty()) return;
    saving = true;
    const d = parse(entry!.json);
    remote.save(d).then(
      async () => { const h = await docHash(d); step(async () => { await sent(d, h); saving = false; push(); }); },
      (e) => step(async () => { saving = false; console.warn("board: the remote:", e); }),
    );
  }

  // the remote's document `theirs` (from a step)
  async function arrived(theirs: BoardDoc, theirHash: string): Promise<Synced> {
    let s: Synced;
    // (what the copy is based on, or shows, already: our own save, come back)
    if (entry && (theirHash === entry.remoteHash || theirHash === entry.hash)) {
      if (theirHash === entry.hash && dirty()) await sent(theirs, theirHash);
      s = "same";
    } else if (!entry || !dirty()) {
      // (its pages given ids, if it came without: the copy's, and the remote's next)
      const doc = identified(theirs);
      await keep(doc, theirHash, canonical(theirs));
      present(doc);
      s = "replaced";
    } else {
      // (edits here the remote has not seen, or a save of them on its way: merged)
      const m = merge3(parse(entry.base ?? entry.json), parse(entry.json), theirs), doc = identified(m.doc), conflicts = m.conflicts;
      await keep(doc, theirHash, canonical(theirs));
      present(doc, conflicts.length ? mergedNotice(conflicts.length) : undefined);
      s = "merged";
    }
    push();
    return s;
  }

  // The remote asked whether it has the copy's version: its answers, each a
  // step.  An answer to a question asked before a change made elsewhere
  // came is older than that change: not taken (it, a step of its own, is
  // the remote's newer document, CORR-EB9-1).
  let heard = 0, lastHeard: Synced = "same";
  function ask() {
    const asked = heard;
    const stale = () => {
      if (heard === asked) return false;
      online = true;
      push();
      resolveSynced(lastHeard);
      return true;
    };
    remote.hash().then((h) => step(async () => {
      if (stale()) return;
      online = true;
      if (h !== null && h === entry!.remoteHash) { const was = dirty(); push(); resolveSynced(was ? "pushed" : "same"); return; }
      const loading = heard;
      remote.load().then((t) => step(async () => {
        if (heard !== loading) { stale(); return; }
        // (the remote has none: the copy is its first)
        if (!t) { entry = { ...entry!, remoteHash: null }; push(); resolveSynced("pushed"); return; }
        resolveSynced(await arrived(cleanDoc(t), h ?? (await docHash(t))));
      }), () => step(async () => { if (!stale()) { online = false; resolveSynced("offline"); } }));
    }), () => step(async () => { if (!stale()) resolveSynced("offline"); }));
  }

  // a change made elsewhere: a step (and, as it comes, newer than any answer asked for before it)
  function changed(d: BoardDoc) {
    const doc = cleanDoc(d);
    heard++;
    step(async () => { lastHeard = await arrived(doc, await docHash(doc)); });
  }
  let offRemote: (() => void) | undefined;

  return {
    synced,
    async load() {
      const c = await step(async () => cache.get(key).catch(() => null));
      if (c) {
        await step(async () => {
          entry ??= c;
          // (pages without ids, from before: given them, in the copy)
          const doc = parse(entry.json), withIds = identified(doc);
          if (withIds !== doc) await keep(withIds, entry.remoteHash, entry.hash === entry.remoteHash ? entry.json : entry.base ?? entry.json);
          view = withIds;
        });
        ask();
        return { doc: view! };
      }
      // (no copy: the remote's; a change made elsewhere meanwhile, after it)
      let d: BoardDoc | null;
      try { d = await remote.load(); } catch (e) { resolveSynced("offline"); throw e; }
      return step(async () => {
        online = true;
        if (!entry) {
          if (!d) { resolveSynced("fresh"); return null; }
          const doc = cleanDoc(d), withIds = identified(doc);
          await keep(withIds, await docHash(doc), canonical(doc));
        }
        view = parse(entry!.json);
        resolveSynced("fresh");
        return { doc: view };
      });
    },
    save(d) {
      // (made from what the board showed when it was made)
      const from = view;
      view = d;
      step(async () => {
        const doc = identified(from && entry && entry.json !== canonical(from) ? merge3(from, d, parse(entry.json)).doc : d);
        const base = dirty() ? entry!.base ?? entry!.json : entry?.json;
        await keep(doc, entry?.remoteHash ?? null, base);
        if (doc !== d) present(doc);
        push();
      });
    },
    subscribe(f) {
      listeners.add(f);
      for (const [d, n] of unsent.splice(0)) present(d, n);
      offRemote ??= remote.subscribe?.(changed);
      return () => { listeners.delete(f); if (!listeners.size) { offRemote?.(); offRemote = undefined; } };
    },
  };
}
