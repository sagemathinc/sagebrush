// The workspace's own IndexedDB database, "sagebrush-workspace"
// (design/workspace-files.md §2.2), and small promise helpers for it.
//
// Its stores are made when the database is, and it is never upgraded (the
// rule of web/notebook/stores.js: an upgrade waits on every page holding the
// database, an older tab or the installed app among them), so every store it
// will need is here from version 1:
//
//   entries  the index: one record per path (keyPath "path"), with an index
//            byRef on [kind, ref], the contents it names
//   boards   boards' documents, by id, with compare-and-swap revisions
//   trash    the bytes of data files in Trash, by their path there (out of
//            "sagebrush"/"files", which every interpreter is sent)
//   ops      the operation log, one record per change (keyPath "seq",
//            counted up): what sync will send (§7.2)
//   versions data files' earlier versions (§2.5): one record each (keyPath
//            "id", counted up), by file id and time (index byFile [fid, t])
//            and by time (index byTime)
//   versionBytes  their bytes, by the version's id (apart, so listing
//            versions reads no bytes)
//   meta     this browser's own values: its device id, when it migrated
import { openDb } from "../board/idb-open";

export const WS_DB = "sagebrush-workspace";

export function openWorkspaceDb(name = WS_DB, onClose: () => void = () => {}, ms = 3000): Promise<IDBDatabase> {
  return openDb(name, 1, (db) => {
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
