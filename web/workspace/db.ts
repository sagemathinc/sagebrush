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
//
// Version 4 (design/sync-client.md §3a, for sync; schema only, as 3 was):
//
//   entries' index byIdent, on each entry's `ident` (its identity: a data
//            file's or folder's fid, a document's ref), written when it is
//            made; entries made before have none until the migrator gives
//            it (the upgrade drops the migration's state, as 3's did)
//   outbox   the operations waiting to go up, by [ns, dseq] (ns, the sync
//            namespace: account hash, generation and device), with an
//            index byIdent on [ns, id]
//   syncIndex  the confirmed index, by [ns, id]
//   adoptJournal  a first sync's captured tree, by [ns, id], with an index
//            byParent on [ns, parent] (the root's parent "": a key can't
//            hold null)
//   pins     bytes committed here and not yet decided, by [id, seq]
//   pending  what is waiting to go up for an identity, by id
//
// Version 5 (design/sync-client.md C2, step 2b-2):
//
//   pins' index byStorage, on each pin's `skey` (where its bytes are: "f:<fid>", a file's fileBytes, or
//   "v:<version id>"): whether any other pin names a storage, one bounded count (the pins are empty until
//   this step)
//   prunable  the versions not kept for sync, by [fid, id] ({fid, id, t, size}: a file's oldest first), with an
//            index byId (everyone's oldest first): a save's pruning, and the cleanup's, read a bounded few from
//            the front, never a file's whole list (daybreak2's LIMIT-E5C-2).  A pinned version has no record
//            here; its release puts one.  A store of its own, made empty, so the upgrade builds no index over
//            the versions already kept, whatever their number: schema only, as every upgrade is, and as quick
//            with 50,000 versions as with none (daybreak2's LIMIT-563-2).  The versions kept before are put here
//            afterwards, a bounded slice at a time, by the cleanup (sync-pins.ts, from the marker
//            `versions:backfill`); until then they are in none, so kept, never wrongly dropped (none was pinned)
//
// Version 7 (task #14, plan-task14-is-op-confirmed r6; schema only):
//
//   syncLedger  each local op's sync state, by [ns, lseq] (sync-ledger.ts), with an index byDecided on
//            [ns, d, lseq] (the oldest decided rows, pruned past the cap).  Made empty: a namespace's existing
//            records are seeded after the open, by its sender, before anything is scanned or sent
//
// Version 8 (plan-sync-slice2-client r4 §1a, the journal's activation; schema only):
//
//   meta's `journal`, {v: 1, active: false}: whether this device's notebooks and boards are written through the
//   journal (sync 2c).  Activation is one way (Workspace.activateJournal); the version itself is half its
//   barrier: an open page of an earlier build is closed by this upgrade (versionchange), and an earlier build
//   opening fresh asks for version 7 and gets a VersionError, so no earlier code writes the workspace again
//
// Version 9 (the board journal's cutover; schema only):
//
//   boards' rows may carry the journal's envelope, flat beside `doc`: `j`, `hash` and `unjournaled` (all or none:
//   api.ts BoardRecord).  Nothing changes in the stores; the version is the barrier: a page of an earlier build, whose
//   board writes keep the rest of a row as it is, is closed by this upgrade (versionchange) before any row can have
//   an envelope, and an earlier build opening fresh gets a VersionError, so no earlier code changes `boards` again
import { openDb } from "../board/idb-open";

export const WS_DB = "sagebrush-workspace";

export const WS_VERSION = 9;
/** meta's `journal` record (version 8): `activating` from activation's first write until every fence says
 * "journal", then `active` (plan-sync-slice2-client r4 §1a). */
export type JournalState = { v: 1; active: boolean; activating?: true };
/** How an open went, for detecting a lost workspace (design/workspace-durability.md A.2): whether it made
 * the database (none was there), and Chrome's report that it deleted a damaged one (`dataLoss: "total"` on
 * the upgradeneeded event: non-standard, in Blink's IDL). */
export type OpenInfo = { fresh: boolean; dataLoss?: string; dataLossMessage?: string };
export function openWorkspaceDb(name = WS_DB, onClose: () => void = () => {}, ms = 3000, info?: OpenInfo): Promise<IDBDatabase> {
  return openDb(name, WS_VERSION, (db, old, tx, ev) => {
    if (info) {
      info.fresh = old === 0;
      const loss = (ev as any)?.dataLoss, message = (ev as any)?.dataLossMessage;
      if (typeof loss === "string" && loss !== "none") info.dataLoss = loss;
      if (typeof message === "string" && message) info.dataLossMessage = message;
    }
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
    if (old < 4) {
      tx.objectStore("entries").createIndex("byIdent", "ident");
      db.createObjectStore("outbox", { keyPath: ["ns", "dseq"] }).createIndex("byIdent", ["ns", "id"]);
      db.createObjectStore("syncIndex", { keyPath: ["ns", "id"] });
      db.createObjectStore("adoptJournal", { keyPath: ["ns", "id"] }).createIndex("byParent", ["ns", "parent"]);
      db.createObjectStore("pins", { keyPath: ["id", "seq"] });
      db.createObjectStore("pending", { keyPath: "id" });
      // (older entries have no ident, and data files written before no sha256: the migrator gives them, so its
      // state from version 3 is dropped and its next run walks the whole index again, as for version 3)
      if (old >= 1) tx.objectStore("meta").delete("migration");
    }
    if (old < 5) {
      // (who names a storage, one bounded count (sync-pins.ts): the pins are empty until this step, so nothing to fill)
      tx.objectStore("pins").createIndex("byStorage", "skey");
      db.createObjectStore("prunable", { keyPath: ["fid", "id"] }).createIndex("byId", "id");
      // (every version kept before is made prunable after the open, from this marker: one write here)
      if (old >= 1) tx.objectStore("meta").put({ after: 0 }, "versions:backfill");
    }
    if (old < 6) {
      // (the confirmed index read a page at a time (design/sync-client.md D10): an entry by its path's key, a
      // folder's listing by its key; gone rows have no key, so neither index holds them.  Schema only: nothing
      // outside dev has written syncIndex)
      const ix = tx.objectStore("syncIndex");
      ix.createIndex("byKey", ["ns", "key"]);
      ix.createIndex("byParent", ["ns", "parentKey"]);
      // (the fetch queue (design/sync-client.md L1, C5): a data file listed from the server whose bytes aren't here
      // carries `fetch`, the SHA-256 to fetch; a sparse index, so queuing one costs no write of its own)
      tx.objectStore("entries").createIndex("byFetch", "fetch");
    }
    if (old < 7) db.createObjectStore("syncLedger", { keyPath: ["ns", "lseq"] }).createIndex("byDecided", ["ns", "d", "lseq"]);
    // (not activated: one write, whatever is in the workspace)
    if (old < 8) tx.objectStore("meta").put({ v: 1, active: false } satisfies JournalState, "journal");
    // (version 9: nothing to change; the upgrade itself closes the pages of earlier builds)
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
export async function inTx<T>(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode, f: (tx: IDBTransaction) => Promise<T>, opts?: IDBTransactionOptions): Promise<T> {
  const tx = opts ? db.transaction(stores, mode, opts) : db.transaction(stores, mode);
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
