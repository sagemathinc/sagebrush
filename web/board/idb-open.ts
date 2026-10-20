// indexedDB.open for the board's caches, bounded: the database, or an error
// after `ms`.  An open can stay unanswered for good, with no success, error
// or blocked event: queued behind another page's pending upgrade of the same
// database, which waits for a connection that page (or one kept in the
// back/forward cache) never closes.  A cache that can't be had then counts as
// empty, rather than the board waiting on it (the board's code never ran:
// web/board/test-idb-stall.mjs).  The connection closes itself when another
// page asks for a version change, so this page never holds one up.
export function openDb(name: string, version: number, upgrade: (db: IDBDatabase, oldVersion: number) => void, onClose: () => void = () => {}, ms = 3000): Promise<IDBDatabase> {
  return new Promise((ok, no) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      no(new Error(`IndexedDB ${name} did not open in ${ms / 1000} s`));
    }, ms);
    const r = indexedDB.open(name, version);
    r.onupgradeneeded = (ev) => upgrade(r.result, ev.oldVersion);
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); onClose(); };
      // (opened after its deadline: not used, and not held)
      if (settled) return db.close();
      settled = true;
      clearTimeout(timer);
      ok(db);
    };
    r.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      no(r.error);
    };
  });
}

/** `p`, or `fallback` if `p` hasn't settled within `ms`; the timer is cleared
 * as soon as either wins, so a fast `p` leaves nothing behind (the review's
 * HARD-030-1: test-idb-within.mjs). */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((res) => { timer = setTimeout(() => res(fallback), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
