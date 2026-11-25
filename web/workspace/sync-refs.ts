// The index's blob references as this device has verified them (e2e PR 5d; design/e2e-encryption.md §4, the "Version
// retention, Trash" row). Every accepted sealed op that names a data file's bytes adds one reference, keyed by its own
// seq; a release op ends some, each by the seq of the add it ends. The server keeps the same adds (web/sync/account.ts
// index_refs) and accepts a release of any live one, since it can't see which bytes are a file's current ones. So
// every device checks each release op against what it has verified before it, and stops at one that would end a
// live file's current bytes.
//
// The ledger, in meta, per index generation, written in the transaction that applies its page (with the rows and the
// cursor), so it is always the ledger of exactly the verified prefix:
//   sync:<gen>:refs:a:<address>:<seq>  -> { fid, rel? }  each add: the data file holding it (null: none, an orphan),
//                                                        and the seq of the release that ended it
//   sync:<gen>:refs:h:<fid>:<seq>      -> address         a file's live adds (its current bytes and its history)
//   sync:<gen>:refs:o:<seq>:<address>  -> 1               the live orphans
//   sync:<gen>:refs:c:<fid>            -> seq             the add holding the file's current bytes (0: bytes a
//                                                        plaintext op wrote, which no index add holds)
// A holder is live or forgotten as the confirmed rows say (Store byId / gone), read for a release op, which runs alone in
// its page (sync-overlay.ts runPage), so what it reads is the state just before it.
//
// No DOM, crypto or E2E code here: the page bundle has it without the sealing module.
import { req } from "./db";
import type { Outcome, SyncOp } from "./sync-reduce";
import type { Store } from "./sync-overlay";

/** A release of one index reference: the blob, and the seq of the op whose add it ends. */
export type RefPair = { address: string; add: number };
/** The op that releases index references: `{ dseq, t, by, op: "release", path: "/", kind: "folder", releases }`. */
export const RELEASE_OP = "release";

/**
 * The blob references an op declares in the clear (the server counts them): as today's plaintext log counts them, a
 * data file's op adds a reference to the blob it names. Only a release op releases: it adds nothing, changes no entry,
 * and names the adds it ends; no other op carries a release, so a race between two devices releasing one add refuses a
 * release, never a person's edit.
 */
export function refsOf(op: { op: string; kind: string; sha256?: string; releases?: readonly RefPair[] }): { adds: string[]; releases: RefPair[] } {
  if (op.op === RELEASE_OP) return { adds: [], releases: (op.releases ?? []).map((r) => ({ address: r.address, add: r.add })) };
  return { adds: op.kind === "file" && op.sha256 !== undefined ? [op.sha256] : [], releases: [] };
}

/** A release op this device can't accept: the pull stops at it, nothing of it or after it applied. */
export class ReleaseHalt extends Error {
  constructor(readonly seq: number, readonly why: string) { super(`sync: the server's release op ${seq} can't be accepted: ${why}`); }
}

const pad = (n: number) => String(n).padStart(16, "0");
const K = {
  add: (gen: string, address: string, seq: number) => `sync:${gen}:refs:a:${address}:${pad(seq)}`,
  held: (gen: string, fid: string, seq: number) => `sync:${gen}:refs:h:${fid}:${pad(seq)}`,
  heldRange: (gen: string, fid: string) => IDBKeyRange.bound(`sync:${gen}:refs:h:${fid}:`, `sync:${gen}:refs:h:${fid};`, false, true),
  orphan: (gen: string, seq: number, address: string) => `sync:${gen}:refs:o:${pad(seq)}:${address}`,
  orphanRange: (gen: string) => IDBKeyRange.bound(`sync:${gen}:refs:o:`, `sync:${gen}:refs:o;`, false, true),
  cur: (gen: string, fid: string) => `sync:${gen}:refs:c:${fid}`,
};
export type AddRow = { fid: string | null; rel?: number };

/** How one live add is held, before an op: by a live file as its current bytes or as its history, by a forgotten one,
 * or by none (an orphan). */
export type Held = "current" | "history" | "forgotten" | "orphan" | "inconsistent";

/** How `pair` is held now (in `meta`'s transaction, the confirmed rows read through `store`), or null if it isn't a live add. */
export async function heldAs(meta: IDBObjectStore, store: Store, gen: string, pair: RefPair): Promise<Held | null> {
  const row = (await req(meta.get(K.add(gen, pair.address, pair.add)))) as AddRow | undefined;
  if (!row || row.rel !== undefined) return null;
  if (row.fid === null) return "orphan";
  if (await store.byId(row.fid)) return ((await req(meta.get(K.cur(gen, row.fid)))) as number | undefined) === pair.add ? "current" : "history";
  if ((await store.gone(row.fid)) !== undefined) return "forgotten";
  // (a holder neither live nor forgotten: the ledger and the rows disagree, which no honest log makes)
  return "inconsistent";
}

/**
 * A page's ops applied to the ledger, in the page's transaction, after its rows (each op's outcome from the reducer:
 * `holder`, where its bytes went). Only sealed ops (`sealed(seq)`) touch the ledger: a plaintext op's add has no index
 * reference on the server. A sealed release op (alone in its page) is checked first, whole: every pair live, none twice,
 * each held by an orphan, a forgotten file or a live file's history, never a live file's current bytes; any other
 * throws ReleaseHalt, so the transaction ends with nothing of the page kept.
 */
export async function ledgerPage(meta: IDBObjectStore, store: Store, gen: string, ops: readonly SyncOp[], outcomes: readonly Outcome[], sealed: (seq: number) => boolean): Promise<void> {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as SyncOp & { releases?: RefPair[] }, holder = outcomes[i]?.holder;
    if (!sealed(op.seq)) {
      // (a plaintext op's bytes, now a file's current ones: no index add holds them)
      if (holder !== undefined) meta.put(0, K.cur(gen, holder));
      continue;
    }
    if (op.op === RELEASE_OP) {
      if (ops.length !== 1) throw new ReleaseHalt(op.seq, "a release op not alone in its page");
      const pairs = op.releases ?? [];
      if (!Array.isArray(pairs) || pairs.length === 0) throw new ReleaseHalt(op.seq, "a release op that names no add");
      const seen = new Set<string>(), rows: [RefPair, AddRow][] = [];
      for (const p of pairs) {
        const k = `${p.address}:${p.add}`;
        if (seen.has(k)) throw new ReleaseHalt(op.seq, "a release op naming one add twice");
        seen.add(k);
        const how = await heldAs(meta, store, gen, p);
        if (how === null) throw new ReleaseHalt(op.seq, `it names an add that isn't live (${p.address.slice(0, 12)}… at ${p.add})`);
        if (how === "current") throw new ReleaseHalt(op.seq, `it would end a live file's current bytes (${p.address.slice(0, 12)}… at ${p.add})`);
        if (how === "inconsistent") throw new ReleaseHalt(op.seq, `its add's holder is in neither the index nor what it forgot (${p.address.slice(0, 12)}… at ${p.add})`);
        rows.push([p, (await req(meta.get(K.add(gen, p.address, p.add)))) as AddRow]);
      }
      for (const [p, row] of rows) {
        meta.put({ ...row, rel: op.seq } satisfies AddRow, K.add(gen, p.address, p.add));
        if (row.fid === null) meta.delete(K.orphan(gen, p.add, p.address));
        else meta.delete(K.held(gen, row.fid, p.add));
      }
      continue;
    }
    for (const address of refsOf(op).adds) {
      meta.put({ fid: holder ?? null } satisfies AddRow, K.add(gen, address, op.seq));
      if (holder === undefined) meta.put(1, K.orphan(gen, op.seq, address));
      else meta.put(address, K.held(gen, holder, op.seq));
    }
    if (holder !== undefined) meta.put(refsOf(op).adds.length ? op.seq : 0, K.cur(gen, holder));
  }
}

/** A file's live adds (its current bytes' and its history's), oldest first. */
export async function liveAdds(meta: IDBObjectStore, gen: string, fid: string): Promise<RefPair[]> {
  const keys = (await req(meta.getAllKeys(K.heldRange(gen, fid)))) as string[];
  const vals = (await req(meta.getAll(K.heldRange(gen, fid)))) as string[];
  return keys.map((k, i) => ({ address: vals[i], add: Number(k.slice(k.lastIndexOf(":") + 1)) }));
}
/** The live orphans, oldest first, at most `n`. */
export async function liveOrphans(meta: IDBObjectStore, gen: string, n: number): Promise<RefPair[]> {
  const keys = (await req(meta.getAllKeys(K.orphanRange(gen), n))) as string[];
  return keys.map((k) => {
    const rest = k.slice(`sync:${gen}:refs:o:`.length);
    return { add: Number(rest.slice(0, 16)), address: rest.slice(17) };
  });
}
/** The add holding a file's current bytes (0: a plaintext op's), or undefined. */
export const currentAdd = async (meta: IDBObjectStore, gen: string, fid: string) => (await req(meta.get(K.cur(gen, fid)))) as number | undefined;
