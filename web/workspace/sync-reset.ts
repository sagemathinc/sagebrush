// Reset sync on this browser: the way out of the blocked "older version" state (sync-old.ts) without clearing the
// site's data.  It forgets how this browser was linked to sync, and nothing else:
//
// 1. sync turned off here as "Turn sync off" does (syncOffIf: the lease off, the lifecycle epoch moved on), or, with no
//    live lease, the epoch moved on alone, so every pin is of an older epoch; no pin is taken after that (a save pins
//    only while a lease is live: noteChange);
// 2. the pins released a page at a time by the cleanup (cleanPins' purge), each with what its release implies: a
//    version kept for sync no longer exempt, bytes kept only for sync (a file deleted for good) let go;
// 3. in one transaction: any pin still left released the same (one an older build wrote without the shape this build
//    reads, deleted), every `sync:` meta key and the sync-only stores (SYNC_ONLY_STORES) cleared, then this build's
//    marker (`sync:proto` = PROTO) written, so the detector reads clean and the next enable starts afresh.
//
// The entries (files, folders, notebooks, boards, Trash), their bytes, old versions and both history databases are
// left as they are.  The history databases are not touched because the journal reads a synced notebook's content from
// its synced rows (`<id>:s<n>`, journal/rows.js): removing them would put a notebook back to what it was before sync.
// Their sync-only rows stay dormant under the marker (sync-old.ts's accepted risk, OLD10).  Nothing is asked of the
// server and nothing on it is deleted.
//
// The next enable is a first sync for this browser (a new device under the account's generation): the local tree is
// adopted (sync-adopt.ts), and where a local entry and a synced one have the same name, the server's reducer keeps both,
// the one from this browser renamed `name (k)`, listed in the Sync panel as renamed.  Re-runnable: each step is its own
// transaction and each one run again does the same, so a reset cut short (a reload) is finished by running it again.
import type { Workspace } from "./api";
import { inTx, req } from "./db";
import { PROTO, PROTO_KEY, SYNC_ONLY_STORES } from "./sync-old";
import { RELEASE_STORES, afterReleases, liveLease, newEpoch, release, scheduleClean, syncOffIf, type Pin } from "./sync-pins";

/** Why sync can't be turned on in this browser: its sync data is from an older version (a reset clears it), or
 * couldn't be read (reload; no reset offered). */
export type SyncBlockedWhy = "old-format" | "unreadable";
export type SyncBlocked = { why: SyncBlockedWhy; canReset: boolean; line: string };

export const BLOCKED_LINE: Record<SyncBlockedWhy, string> = {
  "old-format": "This browser has sync data from an older version of Sagebrush, so sync can't start here.",
  unreadable: "Couldn't read this browser's sync data. Reload and try again.",
};
export const RESET_BUTTON = "Reset sync on this browser…";
export const RESET_CONFIRM = "Reset sync on this browser? This forgets how this browser was linked to sync. Your files here stay, and nothing on the server is deleted. Afterwards, turn sync on again: this browser joins as a new device, and if a file here and one in your synced files clash, both are kept.";
export const RESET_DONE = "Sync was reset on this browser. Turn sync on to join as a new device.";
export const RENAMED_NOTE = "Some files here had the same name as synced ones: both were kept, the ones from this browser renamed.";

/** (tests) faults by step: "off", "clean" and "forget-before", thrown as that step begins; "forget", inside the last
 * transaction after its deletes (so it aborts, nothing of it written) */
export const SYNC_RESET_HOOK: { fault?: (step: string) => void } = {};

// (a bytes-kept-for-sync marker: sync-pins' ORPHAN)
const ORPHAN = "sync:orphan:";

/** This browser's sync link forgotten (see above): the workspace's entries and the history databases untouched,
 * nothing sent. */
export async function resetSyncHere(w: Workspace): Promise<void> {
  // (1) off: a live lease turned off as the switch does; else the epoch moved on, if there are pins to purge
  SYNC_RESET_HOOK.fault?.("off");
  const live = await inTx(w.ws, "meta", "readonly", async (tx) => !!(await liveLease(tx.objectStore("meta"))));
  if (live) await syncOffIf(w);
  else {
    await inTx(w.ws, ["meta", "pins"], "readwrite", async (tx) => {
      if (((await req(tx.objectStore("pins").count())) as number) > 0) await newEpoch(tx.objectStore("meta"));
    });
    afterReleases(w);
  }
  // (2) the purge run to its end, a slice a transaction
  SYNC_RESET_HOOK.fault?.("clean");
  await scheduleClean(w);
  // (3) what is left released, the link forgotten, the marker written: one transaction
  SYNC_RESET_HOOK.fault?.("forget-before");
  await inTx(w.ws, [...new Set([...RELEASE_STORES, ...SYNC_ONLY_STORES])], "readwrite", async (tx) => {
    const meta = tx.objectStore("meta");
    for (const p of (await req(tx.objectStore("pins").getAll())) as Pin[]) {
      if (p && typeof p.storage === "object" && p.storage && ("fileBytes" in p.storage || "version" in p.storage)) await release(tx, p);
    }
    // (bytes kept only for sync, of a file deleted for good: gone with their marker, as the cleanup's sweep does)
    for (const k of (await req(meta.getAllKeys(IDBKeyRange.bound(ORPHAN, ORPHAN + "￿")))) as string[]) {
      const fid = k.slice(ORPHAN.length);
      if (((await req(tx.objectStore("entries").index("byIdent").count(fid))) as number) === 0) tx.objectStore("fileBytes").delete(fid);
    }
    await req(meta.delete(IDBKeyRange.bound("sync:", "sync;", false, true)));
    for (const s of SYNC_ONLY_STORES) await req(tx.objectStore(s).clear());
    SYNC_RESET_HOOK.fault?.("forget");
    meta.put(PROTO, PROTO_KEY);
  });
  // (versions released in (3) made due: the cleanup begun)
  afterReleases(w);
}
