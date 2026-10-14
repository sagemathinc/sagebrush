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
import { docHash, IdbDocCache, records, type DocCache, type CachedDoc, type RemoteBoard } from "./cached";
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
/** The board a syncdb holds; null if it holds none. */
export function boardOf(db: SyncDbLike): BoardDoc | null {
  const rs = db.to_str().split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  return rs.length ? cleanDoc(fromRecords(records(rs))) : null;
}

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
      // (read and hashed, then compared and written, with no other step between:
      // the hash's await is the only one, and the document is read again after it)
      for (;;) {
        const before = db.to_str(), d = now(), h = d ? await docHash(d) : null;
        if (db.to_str() !== before) continue;
        if (h !== expected) return false;
        db.from_str(jsonl(doc));
        db.commit();
        return true;
      }
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

  async function keep(d: BoardDoc, base: BoardDoc | null) {
    const json = canonical(d), hash = await docHash(d), baseHash = base ? await docHash(base) : null;
    entry = { key, json, hash, remoteHash: baseHash, ...(base && hash !== baseHash ? { base: canonical(base) } : {}), at: Date.now() };
    await cache.put(entry).catch((e) => console.warn("board: the copy:", e));
  }
  // (documents given the board one at a time, each once the one before is shown)
  function present(d: BoardDoc) {
    if (!listeners.size) { unsent.push(d); return; }
    const to = [...listeners];
    showing = showing.then(() => Promise.all(to.map((f) => f(d)))).then(() => { view = d; }, (e) => console.warn("board: shown:", e));
  }
  // the syncdb's document, as it is now, kept and (if not what the board shows) shown
  async function heard() {
    const d = boardOf(db);
    if (!d) return;
    await keep(d, d);
    if (!view || canonical(view) !== canonical(d)) present(d);
  }
  const onChange = () => { if (open) step(heard); };

  const opened = (async () => {
    await db.wait_until_ready();
    await step(async () => {
      // (edits kept in the copy before it was open: written as what they changed)
      if (entry?.base !== undefined) {
        db.from_str(jsonl(parse(entry.json)), { base: jsonl(parse(entry.base)) });
        db.commit();
      }
      open = true;
      db.on("change", onChange);
      await heard();
    });
  })();
  opened.catch((e) => console.warn("board: the syncdb:", e));

  return {
    opened,
    async load() {
      const c = await step(async () => cache.get(key).catch(() => null));
      if (c) {
        await step(async () => { entry = c; view = parse(c.json); });
        return { doc: view! };
      }
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
          const now = boardOf(db);
          await keep(now ?? d, now);
          // (merged with a change from elsewhere: shown as the syncdb has it)
          if (now && canonical(now) !== canonical(d)) present(now);
        } else {
          // (before it is open: kept, based on the syncdb's document the copy was)
          const base = entry ? (entry.base !== undefined ? parse(entry.base) : parse(entry.json)) : null;
          await keep(d, base);
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
