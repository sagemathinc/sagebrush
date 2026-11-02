// Downloads (design/sync-client.md C5, L1, L2, D9): the durable fetch queue is the entries carrying `fetch` (the
// SHA-256 to fetch; the view sets it, sync-view.ts), read through the sparse index byFetch, so queuing a file costs no
// write of its own.  A fetched blob is installed by compare-and-swap, holding the workspace's lock: only if the entry
// is still that identity, still `remote`, with the fetched hash, at the revision the fetch began with.  Otherwise the
// bytes are discarded: they never replace newer bytes, or clear a newer `remote` state.  The client (sync-client.ts)
// runs the queue.
import type { Entry, Workspace } from "./api";
import { inTx, req } from "./db";
import { entriesOf, fenceCheck } from "./sync-rewrite";

/** A queue item: what to fetch, for which revision; a signed URL once asked for, kept with its expiry, so a retry or a
 * reload never asks again while it is valid (L1). */
export type FetchItem = { fid: string; sha256: string; size: number; rev: number; url?: string; exp?: number };
/** A file that can never be fetched here (too large, D9): set apart, listed, never retried. */
export const finalKey = (ns: string, fid: string) => `sync:${ns}:fetchFinal:${fid}`;
/** The queue's durable pause (L1: the daily read budget spent): `{until}`. */
export const pauseKey = (ns: string) => `sync:${ns}:fetchPause`;
/** A signed URL kept for an item: `{url, exp, sha256, rev}`. */
const urlKey = (ns: string, fid: string) => `sync:${ns}:url:${fid}`;
/** D9: a canonical Content-Length, no leading zeroes. */
export const CANONICAL_LENGTH = /^(0|[1-9]\d{0,11})$/;

/** At most `n` queued files, in the index's order, each with its kept URL if it is still for that fetch. */
export async function queued(w: Workspace, ns: string, n: number): Promise<FetchItem[]> {
  return inTx(w.ws, ["entries", "meta"], "readonly", async (tx) => {
    const ents = await (await entriesOf(tx)).byFetch(n);
    const out: FetchItem[] = [];
    for (const e of ents) {
      if (e.kind !== "file" || !e.fid || !e.fetch) continue;
      const it: FetchItem = { fid: e.fid, sha256: e.fetch, size: e.size ?? 0, rev: e.rev ?? 0 };
      const u = (await req(tx.objectStore("meta").get(urlKey(ns, e.fid)))) as (FetchItem & { url: string; exp: number }) | undefined;
      if (u && u.sha256 === it.sha256 && u.rev === it.rev) Object.assign(it, { url: u.url, exp: u.exp });
      out.push(it);
    }
    return out;
  });
}

/** An item's signed URL kept (`url` undefined: dropped, a fresh one asked for next time). */
export async function keepUrl(w: Workspace, ns: string, it: FetchItem, url: string | undefined, exp: number | undefined) {
  await inTx(w.ws, "meta", "readwrite", async (tx) => {
    const meta = tx.objectStore("meta");
    if (url === undefined || exp === undefined) meta.delete(urlKey(ns, it.fid));
    else meta.put({ fid: it.fid, sha256: it.sha256, size: it.size, rev: it.rev, url, exp }, urlKey(ns, it.fid));
  });
}

/** A file that can't be fetched here, set apart: its `fetch` cleared (it stays `remote`, listed), why recorded. */
export async function finalize(w: Workspace, ns: string, it: FetchItem, why: string) {
  await w.locked(() => inTx(w.ws, ["entries", "meta"], "readwrite", async (tx) => {
    // (by identity, the row where it physically is: a large move's rows keep their fetch (D11 r8 N4); nothing moves)
    await fenceCheck(tx, []);
    const st = tx.objectStore("entries"), meta = tx.objectStore("meta");
    const e = (await req(st.index("byIdent").get(it.fid))) as Entry | undefined;
    if (!e || e.fetch !== it.sha256 || (e.rev ?? 0) !== it.rev) return;
    const n: Entry = { ...e };
    delete n.fetch;
    n.fetchFailed = { why, at: Date.now(), final: true };
    st.put(n);
    meta.delete(urlKey(ns, it.fid));
    meta.put({ ...it, url: undefined, exp: undefined, why }, finalKey(ns, it.fid));
  }));
}

/** A download of `it` that failed and will be tried again: why, on its entry (by identity, while it still waits for
 * these bytes), so its row says so rather than "on another device" (B5, Nov 1 2026); gone once it is installed. */
export async function noteFetchFailed(w: Workspace, ns: string, it: FetchItem, why: string) {
  await w.locked(() => inTx(w.ws, ["entries"], "readwrite", async (tx) => {
    await fenceCheck(tx, []);
    const st = tx.objectStore("entries");
    const e = (await req(st.index("byIdent").get(it.fid))) as Entry | undefined;
    if (!e || e.fetch !== it.sha256 || (e.rev ?? 0) !== it.rev) return;
    st.put({ ...e, fetchFailed: { why: why.slice(0, 200), at: Date.now() } });
  }));
}

export type Installed = "installed" | "stale";

/**
 * `bytes` (checked: their length and SHA-256 are the item's) installed for `it`, by compare-and-swap (C5), holding
 * the workspace's lock, in one transaction: the entry with identity `it.fid`, still `remote`, with hash `it.sha256`,
 * at revision `it.rev`, gets the bytes in fileBytes and loses `remote` and `fetch`.  Otherwise nothing is written
 * ("stale"); a newer fetch the entry carries stays queued.
 */
export async function install(w: Workspace, ns: string, it: FetchItem, bytes: Uint8Array): Promise<Installed> {
  if (bytes.byteLength !== it.size) throw new Error("sync: install given bytes of another length than the item's");
  return w.locked(async () =>
    inTx(w.ws, ["entries", "fileBytes", "meta"], "readwrite", async (tx) => {
      await fenceCheck(tx, []);
      const st = tx.objectStore("entries");
      const e = (await req(st.index("byIdent").get(it.fid))) as Entry | undefined;
      tx.objectStore("meta").delete(urlKey(ns, it.fid));
      if (!e || e.kind !== "file" || e.fid !== it.fid || !e.remote || e.sha256 !== it.sha256 || (e.rev ?? 0) !== it.rev) return "stale";
      tx.objectStore("fileBytes").put(bytes, it.fid);
      const n: Entry = { ...e };
      delete n.remote;
      delete n.fetch;
      delete n.fetchFailed;
      st.put(n);
      return "installed";
    }),
  );
}
