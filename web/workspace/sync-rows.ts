// The file browser's sync icons (sync client step 5, plan-step5-sync-ui r4 §3): for the rows a render drew, which
// are waiting to go up (↑, not yet accepted by the server), which are conflict copies, which are too large to sync.
//
// - The input is the unique identities of the rows drawn: at most ROWICON.max (the tree's 1,000 rows and Recent's 5).
// - Everything is read in one readonly transaction (meta, pending, outbox), with no other await inside it.
// - ↑ for identity `id` in the current namespace (sync on): its latest local op past the scan's watermark, or a held
//   write or a successor waiting, or any record of its own in the outbox not yet accepted, of any op kind (mkdir,
//   rename, remove, restore, create, write: the index byIdent [ns, id], one cursor each, stopping at the first
//   undecided).  At most 10,000 records read in all (each record has one identity), within the outbox's 1 MiB.
// - ⚠ "conflict copy": paths the view listed as conflicts (the capped `listed` note); ⚠ "too large to sync yet": data
//   files whose fetch was finalized so.
import type { Workspace } from "./api";
import { req } from "./db";
import { finalKey } from "./sync-fetch";

export const ROWICON = {
  /** identities read at most per render: MAX_ROWS (1,000) + RECENT (5) */
  max: 1005,
  /** a refresh at most this often, however many changes come */
  minGapMs: 250,
};

export type Icons = { up: Set<string>; tooLarge: Set<string>; conflict: Set<string> };
type NsState = { held?: boolean; successor?: unknown };
type Pending = { id: string; latest?: { seq: number }; byNs?: Record<string, NsState> };

/** The icons of identities `ids` (at most ROWICON.max: the rest ignored) and of paths `paths`, in one transaction. */
export function rowIcons(w: Workspace, ids: string[], paths: string[]): Promise<Icons> {
  const out: Icons = { up: new Set(), tooLarge: new Set(), conflict: new Set() };
  const unique = [...new Set(ids)].slice(0, ROWICON.max);
  return new Promise((ok, no) => {
    const tx = w.ws.transaction(["meta", "pending", "outbox"], "readonly");
    tx.oncomplete = () => ok(out);
    tx.onerror = tx.onabort = () => no(tx.error);
    const meta = tx.objectStore("meta"), pend = tx.objectStore("pending"), byIdent = tx.objectStore("outbox").index("byIdent");
    (async () => {
      const cur = (await req(meta.get("sync:current"))) as { ns: string; off?: boolean } | undefined;
      if (!cur || cur.off || !unique.length) return;
      const ns = cur.ns;
      const scanned = ((await req(meta.get(`sync:${ns}:scanned`))) as number | undefined) ?? Infinity;
      const listed = (await req(meta.get(`sync:${ns}:listed`))) as { paths: [string, string][] } | undefined;
      const want = new Set(paths);
      for (const [p, why] of listed?.paths ?? []) if (why === "conflict" && want.has(p)) out.conflict.add(p);
      for (const id of unique) {
        const p = (await req(pend.get(id))) as Pending | undefined;
        const st = p?.byNs?.[ns];
        if ((p?.latest && p.latest.seq > scanned) || st?.held || st?.successor !== undefined) out.up.add(id);
        else if (await undecided(byIdent, ns, id)) out.up.add(id);
        if ((await req(meta.get(finalKey(ns, id)))) !== undefined) out.tooLarge.add(id);
      }
    })().catch((e) => { try { tx.abort(); } catch {} no(e); });
  });
}
/** Whether `id` has a record in `ns`'s outbox not yet accepted: one cursor, stopping at the first. */
function undecided(byIdent: IDBIndex, ns: string, id: string): Promise<boolean> {
  return new Promise((ok, no) => {
    const c = byIdent.openCursor(IDBKeyRange.only([ns, id]));
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return ok(false);
      if ((cur.value as { accepted?: number }).accepted === undefined) return ok(true);
      cur.continue();
    };
    c.onerror = () => no(c.error);
  });
}
