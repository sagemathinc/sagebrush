// The confirmed index (design/sync-client.md C3, D5, D10): the shared reducer applied to the server's log in its
// `seq` order, kept in `syncIndex` a page at a time, never whole in memory.  Each page is one readwrite
// transaction on syncIndex and meta: the read sets loaded through the transaction (sync-overlay.ts), the page's ops
// reduced on overlays, then its changed rows and the cursor written, all or none.
//
// - Rows: `{ns, id, key, parentKey, ...entry}` for an entry (`ns` is the index generation's prefix,
//   `<ns>#<gen>`); `{ns, id, gone: true, lastPath}` for an identity forgotten for good (no key: it holds no path).
//   The indexes byKey [ns, key] and byParent [ns, parentKey] (workspace DB v6) answer a key and a folder's listing.
// - Two cursors (D5): `apply_after` is the durable cursor, `sync:<ns>:cursor`; only ops past it are reduced, as one
//   contiguous suffix, in the transaction that writes it.  Ops at or below it (a lowered request, to find this
//   device's echoes) are for echo matching only: never reduced, never moving it.
import type { Workspace } from "./api";
import { inTx, req } from "./db";
import { parentOf } from "./paths";
import { OVERLAY, runPage, rowsOf, type Store } from "./sync-overlay";
import { VIEW_STORES, applyView, type ListedWhy } from "./sync-view";
import { capNow } from "./sync-pins";
import type { Entry, Op } from "./api";
import type { SyncEntry, SyncOp } from "./sync-reduce";

const keyOf = (p: string) => p.normalize("NFC");
const META = "meta";
/** The prefix of a namespace's index generation: the active one is `sync:<ns>:indexGen` (0 before any rebuild). */
export const genPrefix = (ns: string, gen: number) => `${ns}#${gen}`;
export const cursorKey = (ns: string) => `sync:${ns}:cursor`;
export const genKey = (ns: string) => `sync:${ns}:indexGen`;

type Row = SyncEntry & { ns: string; key: string; parentKey: string } | { ns: string; id: string; gone: true; lastPath: string };
const entryOf = (r: Row): SyncEntry | undefined => {
  if ("gone" in r) return undefined;
  const { ns: _ns, key: _k, parentKey: _p, ...e } = r;
  return e as SyncEntry;
};

/** A Store (sync-overlay.ts) over one generation of syncIndex, reading through transaction `tx`. */
export function idbStore(tx: IDBTransaction, prefix: string, stats?: { reads: number; rows: number }): Store {
  const st = tx.objectStore("syncIndex");
  return {
    async byId(id) {
      if (stats) stats.reads++;
      const r = (await req(st.get([prefix, id]))) as Row | undefined;
      return r ? entryOf(r) : undefined;
    },
    async gone(id) {
      if (stats) stats.reads++;
      const r = (await req(st.get([prefix, id]))) as Row | undefined;
      return r && "gone" in r ? r.lastPath : undefined;
    },
    async folder(folderKey) {
      // (a listing is at most the workspace's 10,000 per folder, read by one cursor a row at a time: no batch
      // array beyond the rows taken (D10 r3))
      if (stats) stats.reads++;
      const out: SyncEntry[] = [];
      await new Promise<void>((ok, no) => {
        const c = st.index("byParent").openCursor(IDBKeyRange.only([prefix, folderKey]));
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) return ok();
          const e = entryOf(cur.value as Row);
          if (e) out.push(e);
          if (stats) stats.rows++;
          cur.continue();
        };
        c.onerror = () => no(c.error);
      });
      return out;
    },
  };
}

/** A page's rows written to one generation (in the page's transaction). */
function writeRows(tx: IDBTransaction, prefix: string, put: SyncEntry[], gone: [string, string][], drop: string[]) {
  const st = tx.objectStore("syncIndex");
  for (const e of put) st.put({ ...e, ns: prefix, key: keyOf(e.path), parentKey: keyOf(parentOf(e.path)) });
  for (const [id, lastPath] of gone) st.put({ ns: prefix, id, gone: true, lastPath });
  for (const id of drop) st.delete([prefix, id]);
}

export type Applied = { applied: number; cursor: number; pages: number; changed: string[]; halted?: string };

/**
 * The ops of an `index` page (in seq order) applied to the confirmed index of `ns` (its active generation, or
 * `prefix`), past the durable cursor `cursorAt` (default the namespace's own).  Each page of reduction is one
 * transaction: its rows and the cursor, together.  `onPage` runs inside each transaction, after its rows are
 * written (C3: the view's affected identities recomputed in the same transaction).
 */
export async function applyOps(
  w: Workspace,
  ns: string,
  ops: SyncOp[],
  opts: { prefix?: string; cursorAt?: string; stores?: string[]; onPage?: (tx: IDBTransaction, changed: string[], prefix: string) => Promise<void> } = {},
): Promise<Applied> {
  const stores = [...new Set(["syncIndex", META, ...(opts.stores ?? [])])];
  let at = 0, pages = 0, carry = 0, cursor = 0;
  const changedAll: string[] = [];
  for (;;) {
    const done = await inTx(w.ws, stores, "readwrite", async (tx) => {
      const meta = tx.objectStore(META);
      const prefix = opts.prefix ?? genPrefix(ns, ((await req(meta.get(genKey(ns)))) as number | undefined) ?? 0);
      const ck = opts.cursorAt ?? cursorKey(ns);
      cursor = ((await req(meta.get(ck))) as number | undefined) ?? 0;
      // (D5: only the suffix past the durable cursor is reduced; anything at or below it is an echo's only)
      while (at < ops.length && ops[at].seq <= cursor) at++;
      if (at >= ops.length) return true;
      const page = await runPage(idbStore(tx, prefix), ops.slice(at, at + 1000), carry);
      const { put, gone, drop } = rowsOf(page.base, page.changed);
      writeRows(tx, prefix, put, gone, drop);
      const taken = page.taken;
      cursor = ops[at + taken - 1].seq;
      meta.put(cursor, ck);
      const changed = [...page.changed];
      if (opts.onPage) await opts.onPage(tx, changed, prefix);
      for (const id of changed) changedAll.push(id);
      at += taken;
      carry = page.carry;
      pages++;
      return at >= ops.length;
    });
    if (done) return { applied: at, cursor, pages, changed: changedAll };
  }
}

/**
 * An `index` page from the server applied as C3 says, holding the workspace's lock: each page of reduction, its
 * rows, the cursor and the view's difference on the entries, in one transaction; then the changes told, and the
 * contents of entries forgotten dropped (after their transaction, as emptying Trash does).
 */
export async function applyConfirmed(w: Workspace, ns: string, ops: SyncOp[]): Promise<Applied & { listed: [string, ListedWhy][] }> {
  const cap = await capNow();
  return w.locked(async () => {
    const told: Op[] = [], gone: Entry[] = [], listed: [string, ListedWhy][] = [];
    const r = await applyOps(w, ns, ops, {
      stores: VIEW_STORES,
      onPage: async (tx, changed, prefix) => {
        const v = await applyView({ w, tx, ns, store: idbStore(tx, prefix), cap }, changed);
        // (kept only once the page's transaction commits: a page that aborts is run again whole)
        tx.addEventListener("complete", () => {
          told.push(...v.ops);
          gone.push(...v.gone);
          listed.push(...v.listed);
        });
      },
    });
    w.tell({ ops: told });
    if (gone.length) await w.dropContents(gone).catch((err) => console.warn("sync: dropping forgotten contents:", err));
    return { ...r, listed };
    // (an ordinary change's hold: refused while quarantined or after a reset elsewhere, and the durability witness
    // brought up to the commit, as every local change's)
  });
}

/** The client's `onIndex` (sync-client.ts) for the confirmed index and its view (step 4). */
export const confirmedIndex = (w: Workspace) => async (page: { ns: string; ops: SyncOp[] }) => {
  await applyConfirmed(w, page.ns, page.ops);
};

/** The durable cursor of `ns` (0 before any page). */
export async function cursorOf(w: Workspace, ns: string): Promise<number> {
  return ((await inTx(w.ws, META, "readonly", (tx) => req(tx.objectStore(META).get(cursorKey(ns))))) as number | undefined) ?? 0;
}

/** One entry of the confirmed index, or its gone path (tests, the view). */
export async function confirmedEntry(w: Workspace, ns: string, id: string): Promise<SyncEntry | { gone: string } | undefined> {
  return inTx(w.ws, ["syncIndex", META], "readonly", async (tx) => {
    const gen = ((await req(tx.objectStore(META).get(genKey(ns)))) as number | undefined) ?? 0;
    const r = (await req(tx.objectStore("syncIndex").get([genPrefix(ns, gen), id]))) as Row | undefined;
    if (!r) return undefined;
    return "gone" in r ? { gone: r.lastPath } : entryOf(r);
  });
}

export { OVERLAY };
