// The one consent switch for every measurement this site's pages send (active-users plan r2 §3, r3 §D, r4b, r4c3):
// one module, one entry point (`measure`), one decision (`mayMeasure`).  Today the default is on (William, Oct 31); a
// banner later sets MEASURE_DEFAULT to "ask" and calls setMeasure.  Browsers that send Global Privacy Control are
// never counted (William, Oct 31: "Yes to both").  No other module may send to a MEASURE_PATHS path (a test scans the
// sources and the built assets).  The measurement notes live in their own IndexedDB database (r4c3 §1), which this
// module opens, reads and clears with bounded steps; it never rejects.

/** "on": measure unless told not to; "ask": only after a "yes" (a banner's) */
export const MEASURE_DEFAULT: "on" | "ask" = "on";
/** a browser whose Global Privacy Control is on is not counted, and keeps no note */
export const HONOR_GPC = true;
/** every path a measurement is sent to; only measure() may send to them */
export const MEASURE_PATHS = ["/api/active"] as const;
/** the active-user count's path (active.ts names it only through this) */
export const ACTIVE_PATH = MEASURE_PATHS[0];
/** the notes' database and its one store (keys "a", "b" and the probe "w") */
const NOTE_DB = "sb-active", NOTE_STORE = "notes";
/** each open and each transaction is given up after this long (wall time, plus scheduling delay; r4c3 §2) */
export const IDB_MS = 5_000;
/** r4b's localStorage notes: never shipped, never imported; removed wherever the notes are (r4c3 §1) */
const LEGACY_KEYS = ["sb-active", "sb-active-b"];
const CONSENT_KEY = "sb-consent";

/** Whether a stored consent value (or its absence) permits measuring. */
export function permits(v: string | null): boolean {
  if (v === "yes") return true;
  if (v === "no") return false;
  return MEASURE_DEFAULT === "on";
}

/** Whether this browser may be measured now: its stored choice, the default, and Global Privacy Control.  Any
 * error (storage blocked, say) means no. */
export function mayMeasure(): boolean {
  try {
    if (HONOR_GPC && (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true) return false;
    return permits(localStorage.getItem(CONSENT_KEY));
  } catch {
    return false;
  }
}

/** The notes' database, open, or null: no IndexedDB, an error, blocked, or not open within `ms`.  A success after
 * that closes its connection at once and continues nothing. */
export function openNotes(ms: number): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false;
    const end = (db: IDBDatabase | null) => {
      if (settled) return void db?.close();
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => end(null), ms);
    try {
      const r = indexedDB.open(NOTE_DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(NOTE_STORE);
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => db.close();
        end(db);
      };
      r.onerror = r.onblocked = () => end(null);
    } catch {
      end(null);
    }
  });
}

/** One transaction on the notes: `body` issues its requests and returns how to read the result once committed.
 * Null when it fails, aborts or isn't complete within `ms` (then it is aborted, so it can't commit later). */
export function notesTx<T>(db: IDBDatabase, mode: IDBTransactionMode, ms: number, body: (s: IDBObjectStore) => () => T): Promise<{ v: T } | null> {
  return new Promise((resolve) => {
    let tx: IDBTransaction | undefined;
    const timer = setTimeout(() => {
      try {
        tx?.abort();
      } catch {
        // (already finished)
      }
      resolve(null);
    }, ms);
    const fail = () => {
      clearTimeout(timer);
      resolve(null);
    };
    try {
      tx = db.transaction(NOTE_STORE, mode);
      const read = body(tx.objectStore(NOTE_STORE));
      tx.oncomplete = () => {
        clearTimeout(timer);
        resolve({ v: read() });
      };
      tx.onabort = tx.onerror = fail;
    } catch {
      fail();
    }
  });
}

/** r4b's legacy keys go (they were never shipped; nothing is read from them). */
export function dropLegacy(): void {
  try {
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  } catch {
    // (storage blocked: there is nothing to remove)
  }
}

/** The notes go: on its own connection, opened (IDB_MS) and closed whatever happens, one committed clear (IDB_MS).
 * Outside the count lock (r4c3 §3); never rejects. */
export async function removeNotes(): Promise<void> {
  dropLegacy();
  const db = await openNotes(IDB_MS);
  if (!db) return;
  try {
    await notesTx(db, "readwrite", IDB_MS, (s) => {
      s.clear();
      return () => 0;
    });
  } finally {
    db.close();
  }
}

/** Set when consent is withdrawn, here (setMeasure(false)) or in another tab (the storage listener): a note persisted
 * after it goes again (r4c3a §3); reset by a permitting change.  In memory only. */
let withdrawn = false;
export const wasWithdrawn = () => withdrawn;

/** The page's own choice (a banner's or a setting's, later): false also removes the notes. */
export function setMeasure(v: boolean): void {
  try {
    localStorage.setItem(CONSENT_KEY, v ? "yes" : "no");
  } catch {
    // (storage blocked: measuring stays off, as mayMeasure says)
  }
  withdrawn = !v;
  if (!v) void removeNotes();
}

addEventListener("storage", (e: StorageEvent) => {
  if (e.key !== CONSENT_KEY) return;
  if (permits(e.newValue)) withdrawn = false;
  else {
    withdrawn = true;
    void removeNotes();
  }
});

/** The only way to send a measurement: `run` gets a fetch for `path` alone, and runs only if mayMeasure() says
 * yes now; when it says no, the notes go and nothing runs. */
export async function measure(path: (typeof MEASURE_PATHS)[number], run: (send: (init: RequestInit) => Promise<Response>) => Promise<void>): Promise<void> {
  if (!mayMeasure()) {
    await removeNotes();
    return;
  }
  await run((init) => fetch(path, init));
}
