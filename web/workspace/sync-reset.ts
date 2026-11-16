// Reset sync on this browser: the way out of the blocked "older version" state (sync-old.ts) without clearing the
// site's data.  It forgets how this browser was linked to sync:
//
// 1. sync turned off here as "Turn sync off" does (syncOffIf: the lease off, the lifecycle epoch moved on), or, with no
//    live lease, the epoch moved on alone, so every pin is of an older epoch; no pin is taken after that (a save pins
//    only while a lease is live: noteChange);
// 2. the pins released a page at a time by the cleanup (cleanPins' purge), each with what its release implies: a
//    version kept for sync no longer exempt from the normal version cleanup, and bytes or versions kept only for sync
//    (of a file deleted for good) let go;
// 3. what the purge left (pins of no older epoch; an older build's pins without the shape this build reads, deleted;
//    orphan markers) released the same way, a bounded slice a transaction (releaseLeftovers);
// 4. in one transaction, once nothing is left to release: every `sync:` meta key and the sync-only stores
//    (SYNC_ONLY_STORES) cleared but for what fences (fences(): the lease, kept turned off at the next generation, the
//    epoch moved on, and each namespace's counters), then this build's marker (`sync:proto` = PROTO) written, so the
//    detector reads clean and the next enable starts afresh, never at a generation, epoch or dseq used before.
//
// What stays: the entries (files, folders, notebooks, boards, Trash) and their bytes, and both history databases.  What
// sync alone kept goes: bytes and versions held back for upload are released, and the normal version cleanup applies to
// versions from then on.  The history databases are not touched because the journal reads a synced notebook's content
// from its synced rows (`<id>:s<n>`, journal/rows.js): removing them would put a notebook back to what it was before
// sync.  Their sync-only rows stay dormant under the marker (sync-old.ts's accepted risk, OLD10).  Nothing is asked of
// the server and nothing on it is deleted.
//
// The next enable is a first sync for this browser (a new device under the account's generation): the local tree is
// adopted (sync-adopt.ts), and where a local entry and a synced one have the same name, the server's reducer keeps both,
// the one from this browser renamed `name (k)`, listed in the Sync panel as renamed.  Re-runnable: each step is its own
// transactions, and a reset cut short (a reload) is finished by running it again.
import type { Workspace } from "./api";
import { inTx, req } from "./db";
import { PROTO, PROTO_KEY, SYNC_ONLY_STORES } from "./sync-old";
import { PINS, RELEASE_COST, RELEASE_STORES, afterReleases, liveLease, newEpoch, release, scheduleClean, syncOffIf, type Pin } from "./sync-pins";

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

/** (tests) faults by step: "off", "clean" and "forget-before", thrown as that step begins; "slice", after each
 * committed slice of the leftovers' release; "forget", inside the last transaction after its deletes (so it aborts,
 * nothing of it written) */
export const SYNC_RESET_HOOK: { fault?: (step: string) => void } = {};
/** The leftovers' release (step 3): IndexedDB requests one slice's transaction makes at most, as the cleanup's slices
 * (PINS.slice.requests) */
export const RESET = { requests: PINS.slice.requests };

// (a bytes-kept-for-sync marker: sync-pins' ORPHAN; and what sweeping one costs: its entry count, its bytes' delete,
// its own delete)
const ORPHAN = "sync:orphan:";
const ORPHAN_COST = 3;
const wellFormed = (p: Pin | undefined) => !!p && typeof p.storage === "object" && p.storage !== null && ("fileBytes" in p.storage || "version" in p.storage);

/** This browser's sync link forgotten (see above): files and the history databases untouched, nothing sent. */
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
  SYNC_RESET_HOOK.fault?.("forget-before");
  for (;;) {
    // (3) what the purge left (pins of no older epoch, an older build's malformed ones, orphan markers), released a
    // slice at a time
    await releaseLeftovers(w);
    // (4) the link forgotten and the marker written, in one transaction, once nothing is left to release (else (3)
    // again: nothing pins without a live lease, so this ends)
    const done = await inTx(w.ws, ["meta", ...SYNC_ONLY_STORES], "readwrite", async (tx) => {
      const meta = tx.objectStore("meta");
      if (((await req(tx.objectStore("pins").count())) as number) > 0 || ((await req(meta.count(IDBKeyRange.bound(ORPHAN, ORPHAN + "\uffff")))) as number) > 0) return false;
      // (what fences must never go back (a lease taken before, a lifecycle, a dseq, a rebuild's or the ledger's
      // revision): read before the clear and written after it, moved on)
      const kept = await fences(meta);
      await req(meta.delete(IDBKeyRange.bound("sync:", "sync;", false, true)));
      for (const [k, v] of kept) meta.put(v, k);
      for (const s of SYNC_ONLY_STORES) await req(tx.objectStore(s).clear());
      SYNC_RESET_HOOK.fault?.("forget");
      meta.put(PROTO, PROTO_KEY);
      return true;
    });
    if (done) break;
  }
  // (versions released made due: the cleanup begun)
  afterReleases(w);
}

/** The counters that fence, kept across a reset (as turning sync off never deletes the lease, so none comes back):
 * the lease, as a lease turned off at the next generation (every lease taken before fenced; the next enable takes
 * the one after it); the lifecycle epoch, moved on (every owner's lifecycle before it fenced); and, for the lease's
 * namespace and those queued for their ledgers' deletion (at most OBSOLETE.max), the dseq allocator (a dseq is never
 * reused in its namespace, so a re-enable of the same namespace sends after what the server has from this device),
 * the rebuild's counter, the sender's intent revision and the ledger's revision.  A few gets, bounded. */
export const KEPT_COUNTERS = ["dseq", "rebuildN", "intentRev", "ledgerRev"] as const;
async function fences(meta: IDBObjectStore): Promise<[string, unknown][]> {
  const out: [string, unknown][] = [];
  const cur = (await req(meta.get("sync:current"))) as { ns?: unknown; gen?: unknown } | undefined;
  const epoch = (await req(meta.get("sync:epoch"))) as unknown;
  out.push(["sync:epoch", (Number.isSafeInteger(epoch) && (epoch as number) >= 0 ? (epoch as number) : 0) + 1]);
  const names = new Set<string>();
  if (cur && typeof cur.ns === "string") {
    out.push(["sync:current", { ns: cur.ns, gen: (Number.isSafeInteger(cur.gen) && (cur.gen as number) >= 0 ? (cur.gen as number) : 0) + 1, off: true }]);
    names.add(cur.ns);
  }
  const queued = (await req(meta.get("sync:obsolete"))) as unknown;
  if (Array.isArray(queued)) for (const n of queued.slice(0, 8)) if (typeof n === "string") names.add(n);
  for (const ns of names) for (const c of KEPT_COUNTERS) {
    const v = await req(meta.get(`sync:${ns}:${c}`));
    if (Number.isSafeInteger(v)) out.push([`sync:${ns}:${c}`, v]);
  }
  return out;
}

/** The leftover pins released, then the leftover orphan markers swept, each a slice a transaction within
 * RESET.requests IndexedDB requests.  Each pin or marker a slice takes is deleted in that slice's transaction (a
 * release deletes its pin; a malformed pin is deleted; a marker is deleted with its sweep), so the stores themselves
 * are the cursor: a reset cut short (a reload) goes on from what is left, and never takes one twice. */
async function releaseLeftovers(w: Workspace): Promise<void> {
  // (each slice: its read of keys and rows (2), then per pin at most a release (RELEASE_COST) or one delete)
  const pinsPer = Math.max(1, Math.floor((RESET.requests - 2) / RELEASE_COST));
  for (;;) {
    const more = await inTx(w.ws, [...RELEASE_STORES], "readwrite", async (tx) => {
      const pins = tx.objectStore("pins");
      const keys = (await req(pins.getAllKeys(null, pinsPer))) as IDBValidKey[], list = (await req(pins.getAll(null, pinsPer))) as Pin[];
      for (let i = 0; i < keys.length; i++) {
        if (wellFormed(list[i])) await release(tx, list[i]);
        else pins.delete(keys[i]);
      }
      return keys.length === pinsPer;
    });
    SYNC_RESET_HOOK.fault?.("slice");
    if (!more) break;
  }
  // (each slice: its read of keys (1), then per marker ORPHAN_COST)
  const orphansPer = Math.max(1, Math.floor((RESET.requests - 1) / ORPHAN_COST));
  for (;;) {
    const more = await inTx(w.ws, ["meta", "entries", "fileBytes"], "readwrite", async (tx) => {
      const meta = tx.objectStore("meta");
      const keys = (await req(meta.getAllKeys(IDBKeyRange.bound(ORPHAN, ORPHAN + "\uffff"), orphansPer))) as string[];
      for (const k of keys) {
        // (bytes kept only for sync, of a file deleted for good: gone with their marker, as the cleanup's sweep does)
        const fid = k.slice(ORPHAN.length);
        if (((await req(tx.objectStore("entries").index("byIdent").count(fid))) as number) === 0) tx.objectStore("fileBytes").delete(fid);
        meta.delete(k);
      }
      return keys.length === orphansPer;
    });
    SYNC_RESET_HOOK.fault?.("slice");
    if (!more) break;
  }
}
