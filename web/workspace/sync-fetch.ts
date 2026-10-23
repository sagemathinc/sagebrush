// Downloads (design/sync-client.md C5, L1, L2, D9): the durable fetch queue the view fills (sync-view.ts: one item
// per data file whose confirmed bytes aren't here, `sync:<ns>:fetch:<fid>`), and the install of fetched bytes, by
// compare-and-swap, holding the workspace's lock: only if the entry is still that identity, still `remote`, with
// the fetched hash, at the revision the fetch began with.  Otherwise the bytes are discarded: they never replace
// newer bytes, or clear a newer `remote` state.  The client (sync-client.ts) runs the queue.
import type { Entry, Workspace } from "./api";
import { inTx, req } from "./db";
import { fetchKey } from "./sync-view";

/** A queue item: what to fetch, for which revision; a signed URL once asked for (kept with its expiry, so a retry or a
 * reload never asks again while it is valid: L1). */
export type FetchItem = { fid: string; sha256: string; size: number; rev: number; url?: string; exp?: number };
/** An item that can never be fetched here (too large, D9): kept apart, listed, never retried. */
export const finalKey = (ns: string, fid: string) => `sync:${ns}:fetchFinal:${fid}`;
/** The queue's durable pause (L1: the daily read budget spent): `{until}`. */
export const pauseKey = (ns: string) => `sync:${ns}:fetchPause`;
/** D9: a canonical Content-Length, no leading zeroes. */
export const CANONICAL_LENGTH = /^(0|[1-9]\d{0,11})$/;

/** At most `n` queue items of `ns`, in key order (by fid). */
export async function queued(w: Workspace, ns: string, n: number): Promise<FetchItem[]> {
  const lo = fetchKey(ns, ""), hi = fetchKey(ns, "￿");
  return inTx(w.ws, "meta", "readonly", (tx) => req(tx.objectStore("meta").getAll(IDBKeyRange.bound(lo, hi), n))) as Promise<FetchItem[]>;
}

/** An item's signed URL kept (only if the item is still the same fetch). */
export async function keepUrl(w: Workspace, ns: string, it: FetchItem, url: string | undefined, exp: number | undefined) {
  await inTx(w.ws, "meta", "readwrite", async (tx) => {
    const meta = tx.objectStore("meta"), k = fetchKey(ns, it.fid);
    const cur = (await req(meta.get(k))) as FetchItem | undefined;
    if (!cur || cur.rev !== it.rev || cur.sha256 !== it.sha256) return;
    const next: FetchItem = { fid: cur.fid, sha256: cur.sha256, size: cur.size, rev: cur.rev };
    if (url !== undefined && exp !== undefined) Object.assign(next, { url, exp });
    meta.put(next, k);
  });
}

/** An item that can't be fetched here, moved apart (only if still the same fetch). */
export async function finalize(w: Workspace, ns: string, it: FetchItem, why: string) {
  await inTx(w.ws, "meta", "readwrite", async (tx) => {
    const meta = tx.objectStore("meta"), k = fetchKey(ns, it.fid);
    const cur = (await req(meta.get(k))) as FetchItem | undefined;
    if (!cur || cur.rev !== it.rev || cur.sha256 !== it.sha256) return;
    meta.delete(k);
    meta.put({ ...it, url: undefined, exp: undefined, why }, finalKey(ns, it.fid));
  });
}

export type Installed = "installed" | "stale";

/**
 * `bytes` (checked: their length and SHA-256 are the item's) installed for `it`, by compare-and-swap (C5), holding
 * the workspace's lock, in one transaction: the entry with identity `it.fid`, still `remote`, with hash `it.sha256`,
 * at revision `it.rev`, gets the bytes in fileBytes and loses `remote`.  Otherwise nothing is written ("stale").
 * Either way the queue item goes, if it is still this fetch's; a newer one (a newer remote write) stays.
 */
export async function install(w: Workspace, ns: string, it: FetchItem, bytes: Uint8Array): Promise<Installed> {
  if (bytes.byteLength !== it.size) throw new Error("sync: install given bytes of another length than the item's");
  return w.locked(async () =>
    inTx(w.ws, ["entries", "fileBytes", "meta"], "readwrite", async (tx) => {
      const st = tx.objectStore("entries"), meta = tx.objectStore("meta"), k = fetchKey(ns, it.fid);
      const e = (await req(st.index("byIdent").get(it.fid))) as Entry | undefined;
      const item = (await req(meta.get(k))) as FetchItem | undefined;
      if (item && item.rev === it.rev && item.sha256 === it.sha256) meta.delete(k);
      if (!e || e.kind !== "file" || e.fid !== it.fid || !e.remote || e.sha256 !== it.sha256 || (e.rev ?? 0) !== it.rev) return "stale";
      tx.objectStore("fileBytes").put(bytes, it.fid);
      const n: Entry = { ...e };
      delete n.remote;
      st.put(n);
      return "installed";
    }),
  );
}
