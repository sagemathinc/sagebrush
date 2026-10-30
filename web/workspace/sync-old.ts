// EXACT-ONLY's old-sync detector (plan-exact-only-delta-r1 §5, §5A r2; @sagebrush's Option A): a browser that synced
// with a build before the cutover keeps that sync state (nothing deletes it); it is detected, sync stays off there, and
// the page says to clear the site's data by hand.  Read-only: it never writes, deletes or makes a database.
//
// "Old" is sync state without the new build's marker (`sync:proto` === 2, written only in the lease transaction of the
// new build's first enable, switchToIf): any `sync:` meta key; any of the sync-only stores non-empty; any sync-only row
// family in either history database (the journal-local families, written by every journaled save, are not signals).
import type { Workspace } from "./api";
import { req } from "./db";
import { FAMILIES, SYNC_NB } from "../notebook/sync-rows.js";

/** The new build's marker in the workspace's meta: its value is exactly the number PROTO. */
export const PROTO_KEY = "sync:proto";
export const PROTO = 2;
/** The workspace's stores that only sync writes. */
export const SYNC_ONLY_STORES = ["outbox", "syncIndex", "adoptJournal", "pins", "pending", "syncLedger"] as const;
/** The history databases' row families (sync-rows.js FAMILIES, by letter): those only sync writes (signals), and the
 * journal's own (written by every journaled save, synced or not: never signals).  `a`, the merge mode a synced
 * history asks for, is local: a .sbreplay restore wrote it with sync never on (P2b's keepBundle; sync-docs' ruling).
 * RETIRED: letters no longer in FAMILIES that old browsers may still hold.  SIGNAL ∪ LOCAL = FAMILIES ∪ RETIRED,
 * disjoint. */
export const SIGNAL_FAMILIES = ["l", "m", "s", "k", "c", "o", "x", "z"] as const;
export const LOCAL_FAMILIES = ["j", "p", "r", "g", "a"] as const;
export const RETIRED_FAMILIES = ["a"] as const;
/** The rows under the bare SYNC_NB (the registry's nb), by their time's prefix: sync's debt (a signal), and the
 * journal's own registry, counter and budgets. */
export const SIGNAL_META = ["b:d:"] as const;
export const LOCAL_META = ["d:", "n", "b:m:", "b:p:"] as const;
/** Both history databases: notebooks' and boards'. */
export const HISTORY_DBS = ["sagebrush-history", "sagebrush-board-history"] as const;
/** A synced history's key: `<id>:s<n>`. */
const SYNCED_NB = /:s\d+$/;

export const OLD_SYNC_REASON = "synced with an older Sagebrush";
export const OLD_SYNC_MESSAGE = "This browser synced with an older version of Sagebrush, so sync is off here. To use sync again, clear this site's data in your browser's settings. Download anything you want to keep first, because clearing site data deletes this browser's copy of your files.";

/** The detector's answer: `old` with the first signal found (`why`), or clean. */
export type OldSync = { old: boolean; why?: string };
/** The detector refused an enable: this browser holds old sync state. */
export class OldSyncError extends Error {
  constructor(readonly why: string) { super(OLD_SYNC_MESSAGE); this.name = "OldSyncError"; }
}

/** (tests) faults: a read that throws, by step (and switchToIf's lease transaction, "lease"); `between`, run between
 * switchToIf's detection and its transaction (a signal written late) */
export const OLD_SYNC_HOOK: { fault?: (step: string) => void; between?: () => Promise<void> } = {};

/** Whether this browser holds sync state from a build before the cutover.  Any read that fails: old (fail closed);
 * a history database that doesn't exist: clean. */
export async function detectOldSync(w: Workspace): Promise<OldSync> {
  try {
    const ws = w.ws;
    OLD_SYNC_HOOK.fault?.("meta");
    const tx = ws.transaction(["meta", ...SYNC_ONLY_STORES], "readonly"), meta = tx.objectStore("meta");
    if ((await req(meta.get(PROTO_KEY))) === PROTO) return { old: false };
    if (((await req(meta.count(IDBKeyRange.bound("sync:", "sync;", false, true)))) as number) > 0) return { old: true, why: "meta" };
    for (const s of SYNC_ONLY_STORES) {
      OLD_SYNC_HOOK.fault?.("store:" + s);
      if (((await req(tx.objectStore(s).count())) as number) > 0) return { old: true, why: "store:" + s };
    }
    for (const name of HISTORY_DBS) {
      OLD_SYNC_HOOK.fault?.("history:" + name);
      const why = await historySignal(name);
      if (why) return { old: true, why: name + ":" + why };
    }
    return { old: false };
  } catch (e) {
    return { old: true, why: "unreadable: " + ((e as Error)?.message ?? String(e)) };
  }
}

// (a database opened as it is, never made: null if there is none; an upgrade asked for is aborted, which is what
// a missing database reads as (stores.js primaryDb's pattern))
function openAsIs(name: string): Promise<IDBDatabase | null> {
  return new Promise((ok, no) => {
    let absent = false;
    const r = indexedDB.open(name);
    r.onupgradeneeded = () => { absent = true; r.transaction!.abort(); };
    r.onsuccess = () => ok(r.result);
    r.onerror = (e) => { e.preventDefault?.(); absent ? ok(null) : no(r.error); };
    r.onblocked = () => no(new Error(`${name} is being upgraded`));
  });
}

// (the first signal in a history database, or null: one key cursor stepping by distinct nb (each document, each sync
// handle and each synced history visited once, never each row); a sync handle's nb probed once per signal family on
// its composite key [nb, letter…]; the bare registry nb probed for sync's debt; a synced history's nb is itself a
// signal.  The registry isn't trusted: an orphan handle or synced key is found the same.)
async function historySignal(name: string): Promise<string | null> {
  const db = await openAsIs(name);
  if (!db) return null;
  try {
    // (a database that exists has the shape stores.js makes it with: one store, "history", keyed [nb, time]; any other
    // shape isn't one a build wrote, so it isn't read as clean (fail closed, as a malformed marker is): astra3's note,
    // @sagebrush's ruling)
    if (!db.objectStoreNames.contains("history")) return "schema: no history store";
    const st = db.transaction("history", "readonly").objectStore("history");
    if (JSON.stringify(st.keyPath) !== JSON.stringify(["nb", "time"])) return "schema: history keyed " + JSON.stringify(st.keyPath);
    const probe = async (nb: string, prefix: string) => ((await req(st.count(IDBKeyRange.bound([nb, prefix], [nb, prefix + "￿"])))) as number) > 0;
    return await new Promise<string | null>((ok, no) => {
      const c = st.openKeyCursor();
      c.onerror = () => no(c.error);
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return ok(null);
        const nb = (cur.key as [string, string])[0];
        (async () => {
          if (nb === SYNC_NB) {
            for (const p of SIGNAL_META) if (await probe(nb, p)) return "debt";
          } else if (nb.startsWith(SYNC_NB)) {
            for (const L of SIGNAL_FAMILIES) if (await probe(nb, L)) return "family:" + L;
          } else if (SYNCED_NB.test(nb)) return "synced:" + nb;
          return null;
        })().then((hit) => (hit ? ok(hit) : cur.continue([nb + "\u0000"])), no);
      };
    });
  } finally {
    db.close();
  }
}

/** (tests) the classification is complete and disjoint: SIGNAL ∪ LOCAL = FAMILIES ∪ RETIRED. */
export function classificationProblems(families: readonly string[] = Object.values(FAMILIES)): string[] {
  const out: string[] = [];
  const all = new Set([...families, ...RETIRED_FAMILIES]);
  const sig = new Set<string>(SIGNAL_FAMILIES), loc = new Set<string>(LOCAL_FAMILIES);
  for (const L of all) if (!sig.has(L) && !loc.has(L)) out.push("unclassified " + L);
  for (const L of sig) if (loc.has(L)) out.push("both " + L);
  for (const L of [...sig, ...loc]) if (!all.has(L)) out.push("unknown " + L);
  return out;
}
