// A board kept in a CoCalc syncdb (design/board-cocalc-adapter.md): a
// prototype, used by nothing in the page yet, of the two ways a board's
// edits can reach the syncdb that holds its records (history.ts's: keyed
// by type, page and id):
//
//   syncdbRemote(db)       a RemoteBoard for cachedStore (cached.ts): the
//                          syncdb's document as a whole, saved by
//                          compare-and-swap on this browser's replica; the
//                          store merges (merge3) when it is refused
//   syncdbStore(db, ...)   a BoardStore of its own: each edit written with
//                          the document it was made from as its base, so the
//                          syncdb's own merge (CoCalc's, the one every other
//                          replica uses) is the only one; this browser's copy
//                          is for the first paint, and edits made before the
//                          syncdb is open
//
// The tests (test-syncdb.mjs) run both over replicas of real patchflow
// sessions.

import { canonical, cleanDoc, type BoardDoc } from "./doc";
import { fromRecords, toRecords } from "./history";
import { docHash, identified, IdbDocCache, merge3, records, versionOf, type DocCache, type CachedDoc, type RemoteBoard } from "./cached";
import type { BoardStore } from "./mount";

/** The parts of CoCalc's SyncDB (@cocalc/sync/editor/db) the adapter uses,
 * by their names there: the document as JSON lines (one record each) and
 * set from them, and its changes. */
export interface SyncDbLike {
  isReady(): boolean;
  wait_until_ready(): Promise<void>;
  to_str(): string;
  /** With `base` (the document the value was made from), only the value's
   * own changes are applied: the syncdb merges them into what it has now. */
  from_str(value: string, opts?: { base?: string }): void;
  /** The document as set, a patch; false if nothing changed. */
  commit(): boolean;
  on(event: "change", f: () => void): void;
  removeListener(event: "change", f: () => void): void;
}

/** A board as the syncdb's JSON lines. */
export const jsonl = (d: BoardDoc) => toRecords(d).map((r) => JSON.stringify(r)).join("\n");
/** The board in a syncdb's JSON lines; null if they hold none. */
export function boardFrom(lines: string): BoardDoc | null {
  const rs = lines.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  return rs.length ? cleanDoc(fromRecords(records(rs))) : null;
}
/** The board a syncdb holds; null if it holds none. */
export const boardOf = (db: SyncDbLike) => boardFrom(db.to_str());

// ---- a RemoteBoard for cachedStore -----------------------------------------

/**
 * The syncdb as cachedStore's remote.  save(doc, expected) is a
 * compare-and-swap on this browser's replica: its document is read, hashed
 * and, only if that is `expected`, replaced by `doc`, in one synchronous
 * step (nothing else runs on the replica meanwhile); the patch then goes
 * to the others like any.  So the store never writes over a change it has
 * not seen; but a change from elsewhere that has reached the replica makes
 * the save refused, and the store's merge3 (not the syncdb's) settles it.
 */
export function syncdbRemote(db: SyncDbLike): RemoteBoard {
  const now = () => boardOf(db);
  return {
    cas: true,
    async hash() { await db.wait_until_ready(); const d = now(); return d ? docHash(d) : null; },
    async load() { await db.wait_until_ready(); return now(); },
    async save(doc, expected) {
      await db.wait_until_ready();
      // (read once; that reading hashed; then, with no step between, the
      // replica compared with that same reading and written: changed
      // meanwhile, refused, and the store merges and tries again, CORR-B5C-2)
      const read = db.to_str(), d = boardFrom(read), h = d ? await docHash(d) : null;
      if (h !== expected || db.to_str() !== read) return false;
      db.from_str(jsonl(doc));
      db.commit();
      return true;
    },
    subscribe(f) {
      const on = () => { const d = now(); if (d) f(d); };
      db.on("change", on);
      return () => db.removeListener("change", on);
    },
  };
}

// ---- a BoardStore whose merge is the syncdb's ------------------------------

/**
 * A BoardStore over the syncdb itself.  Each edit is written as what it
 * changed: from_str(the edited document, {base: the document it was made
 * from}), so the syncdb applies only that, merged into what it has now by
 * its own merge, as any other replica's patch is.  A change from elsewhere
 * is shown as the syncdb has it.
 *
 * This browser's copy (`cache`, under `key`) is shown at once by load(),
 * before the syncdb is open, and keeps the edits made meanwhile (with the
 * syncdb's last document they were made from, as their base); once it is
 * open they are written to it the same way, and its document shown.
 */
export function syncdbStore(db: SyncDbLike, key: string, cache: DocCache = new IdbDocCache()): BoardStore & { opened: Promise<void> } {
  // the copy: what the board shows, and the syncdb's document it is based on (`base`, while they differ)
  let entry: CachedDoc | null = null;
  let view: BoardDoc | null = null;
  let open = false;
  const listeners = new Set<(d: BoardDoc, notice?: string) => void | Promise<void>>();
  const unsent: BoardDoc[] = [];
  let showing: Promise<unknown> = Promise.resolve();
  let queue: Promise<unknown> = Promise.resolve();
  const step = <T>(f: () => Promise<T>) => { const p = queue.then(f); queue = p.catch((e) => console.warn("board: the syncdb store:", e)); return p; };
  const parse = (json: string) => cleanDoc(JSON.parse(json));

  // The copy written, only over the version read or written last: written,
  // true (null: the cache failed, kept here only); refused, false: another
  // store wrote it since, and its copy is taken (the caller merges what it
  // was writing into it, CORR-78A-2).
  let ver: number | null = null;
  async function keep(d: BoardDoc, base: BoardDoc | null): Promise<boolean | null> {
    const json = canonical(d), hash = await docHash(d), baseHash = base ? await docHash(base) : null;
    const next: CachedDoc = { key, json, hash, remoteHash: baseHash, ...(base && hash !== baseHash ? { base: canonical(base) } : {}), at: Date.now() };
    const ok = await cache.put(next, ver).catch((e) => { console.warn("board: the copy:", e); return null; });
    if (ok === false) { entry = await cache.get(key).catch(() => null); ver = versionOf(entry); return false; }
    entry = next;
    if (ok) ver = (ver ?? 0) + 1;
    return ok;
  }
  // (the copy's edits the syncdb has not seen, another store's taken among them: written into it as what they changed)
  function flushCopy() {
    if (!open || entry?.base === undefined) return;
    db.from_str(jsonl(parse(entry.json)), { base: jsonl(parse(entry.base)) });
    db.commit();
  }
  // (an edit made before the syncdb was open that its copy could not take:
  // written into the syncdb when it opens, from what this store had read)
  let unwritten: { base: BoardDoc; doc: BoardDoc } | null = null;
  // (documents given the board one at a time, each once the one before is shown)
  function present(d: BoardDoc) {
    if (!listeners.size) { unsent.push(d); return; }
    const to = [...listeners];
    showing = showing.then(() => Promise.all(to.map((f) => f(d)))).then(() => { view = d; }, (e) => console.warn("board: shown:", e));
  }
  // the syncdb's document, as it is now, kept and (if not what the board shows) shown
  async function heard() {
    for (let tries = 0; tries < 10; tries++) {
      const d = boardOf(db);
      if (!d) return;
      if ((await keep(d, d)) !== false) { if (!view || canonical(view) !== canonical(d)) present(d); return; }
      // (refused: another store's copy taken; its edits into the syncdb, then again)
      flushCopy();
    }
    console.error("board: this browser's copy could not be written: another store kept writing it");
  }
  const onChange = () => { if (open) step(heard); };

  // (the copy read and taken as one step, queued before anything else: the
  // syncdb, once open, finds a copy's edits already there, CORR-B5C-1)
  const init = step(async () => {
    const c = await cache.get(key).catch(() => null);
    ver = versionOf(c);
    if (c) { entry = c; view = parse(c.json); }
  });
  const opened = (async () => {
    await init;
    await db.wait_until_ready();
    await step(async () => {
      // (edits kept in the copy before it was open: written as what they changed)
      open = true;
      flushCopy();
      if (unwritten) { db.from_str(jsonl(unwritten.doc), { base: jsonl(unwritten.base) }); db.commit(); unwritten = null; }
      db.on("change", onChange);
      await heard();
    });
  })();
  opened.catch((e) => console.warn("board: the syncdb:", e));

  return {
    opened,
    async load() {
      await init;
      if (view) return { doc: view };
      await opened;
      return step(async () => (view ? { doc: view } : null));
    },
    save(d) {
      // (made from what the board showed when it was made)
      const from = view;
      view = d;
      step(async () => {
        if (open) {
          db.from_str(jsonl(d), from ? { base: jsonl(from) } : undefined);
          db.commit();
          // (kept, and, merged with a change from elsewhere, shown as the syncdb has it)
          await heard();
        } else {
          // (before it is open: kept, based on the syncdb's document the copy
          // was; refused, merged into the other store's copy, from what this
          // store had read, and written again, CORR-78A-2)
          let last = entry ? parse(entry.json) : from ?? cleanDoc({}), ours = d;
          for (let tries = 0; ; tries++) {
            const base = entry ? (entry.base !== undefined ? parse(entry.base) : parse(entry.json)) : null;
            if ((await keep(ours, base)) !== false) break;
            const theirs = entry ? parse(entry.json) : cleanDoc({});
            ours = identified(merge3(last, ours, theirs).doc);
            last = theirs;
            if (tries >= 9) { unwritten = { base: last, doc: ours }; console.error("board: an edit could not be kept in this browser's copy: another store kept writing it"); break; }
          }
          if (canonical(ours) !== canonical(d)) present(ours);
        }
      });
    },
    subscribe(f) {
      listeners.add(f);
      for (const d of unsent.splice(0)) present(d);
      return () => { listeners.delete(f); if (!listeners.size) db.removeListener("change", onChange); };
    },
  };
}
