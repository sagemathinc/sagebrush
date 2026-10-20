// The workspace's own IndexedDB database, "sagebrush-workspace"
// (design/workspace-files.md §2.2), and small promise helpers for it.
//
// An upgrade waits on every page holding the database, an older tab or the
// installed app among them; every connection here closes itself when asked
// (web/board/idb-open.ts), and the page then says the workspace was
// upgraded elsewhere and offers to reload (Workspace's onClosed).  An
// upgrade only adds stores: it moves no data (design/capabilities.md §2b).
//
// Version 1:
//
//   entries  the index: one record per path (keyPath "path"), with an index
//            byRef on [kind, ref], the contents it names
//   boards   boards' documents, by id, with compare-and-swap revisions
//   trash    the bytes of data files in Trash, by their path there (out of
//            "sagebrush"/"files", which every interpreter is sent)
//   ops      the operation log, one record per change (keyPath "seq",
//            counted up): what sync will send (§7.2).  Every change to the
//            entries adds its op in the same transaction, so the latest seq
//            is the index's generation (the migrator's "did anything change
//            during this pass", design/capabilities.md §2b).  The
//            generation never goes down: Workspace.generation() is the
//            latest seq or meta's "opsFloor", whichever is larger, and
//            anything that deletes op records (Workspace.dropOps) first
//            records the highest seq it deletes as opsFloor, in the same
//            transaction
//   versions data files' earlier versions (§2.5): one record each (keyPath
//            "id", counted up), by file id and time (index byFile [fid, t])
//            and by time (index byTime)
//   versionBytes  their bytes, by the version's id (apart, so listing
//            versions reads no bytes)
//   meta     this browser's own values: its device id, when it migrated
//
// Version 2 (design/capabilities.md §2a, §2b):
//
//   fileBytes  data files' bytes, by the file's own id (its fid), beside
//            the index, so a change to a file is one transaction of this
//            database.  An entry marked `migrated` has its bytes here;
//            another, still in "sagebrush"/"files" (or in Trash, in trash),
//            until the migrator moves them (web/workspace/migrator.ts)
//   grants   what each document may do with the person's files (step 3;
//            made now so that no later upgrade is needed): keyPath [doc,
//            scope], with indexes byDoc and lastUsed
//
// Version 3 (design/capabilities.md §3, CORR-CAP-3):
//
//   entries' index byNfc, on each entry's `nkey` (its folder and the NFC
//            form of its name): names that look the same in one folder
//            found by one bounded lookup.  Entries made before have no
//            nkey until the migrator gives them one: the upgrade drops
//            the migration's state, so a migration already done runs
//            again (astra's CORR-D01-1)
import { openDb } from "../board/idb-open";

export const WS_DB = "sagebrush-workspace";

export const WS_VERSION = 3;
export function openWorkspaceDb(name = WS_DB, onClose: () => void = () => {}, ms = 3000): Promise<IDBDatabase> {
  return openDb(name, WS_VERSION, (db, old, tx) => {
    if (old < 1) {
      const entries = db.createObjectStore("entries", { keyPath: "path" });
      entries.createIndex("byRef", ["kind", "ref"]);
      db.createObjectStore("boards", { keyPath: "id" });
      db.createObjectStore("trash");
      db.createObjectStore("ops", { keyPath: "seq", autoIncrement: true });
      const versions = db.createObjectStore("versions", { keyPath: "id", autoIncrement: true });
      versions.createIndex("byFile", ["fid", "t"]);
      versions.createIndex("byTime", "t");
      db.createObjectStore("versionBytes");
      db.createObjectStore("meta");
    }
    // (schema only, no data moved: the upgrade takes no longer than an open)
    if (old < 2) {
      db.createObjectStore("fileBytes");
      const grants = db.createObjectStore("grants", { keyPath: ["doc", "scope"] });
      grants.createIndex("byDoc", "doc");
      grants.createIndex("lastUsed", "lastUsed");
    }
    if (old < 3) {
      tx.objectStore("entries").createIndex("byNfc", "nkey");
      // (entries made before have no nkey, and old folders no id: the migrator gives them both, so its state
      // from version 2, done, paused or a checkpoint, is dropped and its next run walks the whole index again;
      // the key is web/workspace/migrator.ts's)
      if (old >= 1) tx.objectStore("meta").delete("migration");
    }
  }, onClose, ms);
}

/** A request's result. */
export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, no) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}

/** `f` in one transaction, its result once the transaction has committed;
 * if `f` throws, the transaction is aborted (nothing of it written) and the
 * error passed on.  `f` may await only the transaction's own requests. */
export async function inTx<T>(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode, f: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const tx = db.transaction(stores, mode);
  const done = new Promise<void>((ok, no) => {
    tx.oncomplete = () => ok();
    tx.onerror = () => no(tx.error);
    tx.onabort = () => no(tx.error ?? new DOMException("the transaction was aborted", "AbortError"));
  });
  let out: T;
  try {
    out = await f(tx);
  } catch (e) {
    try { tx.abort(); } catch {}
    await done.catch(() => {});
    throw e;
  }
  await done;
  return out;
}

/** Random hex: `n` bytes. */
export const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
