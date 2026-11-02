// Change tokens (Stage A layer 1; plan-collab-stage-a r6.4 §2.2, the SOURCE side only; design stage-a-l1 r2.2,
// /scratch/sagebrush-reviews/stage-a-l1-design-r2.2): every save that changes a source (the workspace's entries,
// data files' bytes, boards; the notebooks) writes, IN ITS OWN TRANSACTION, one token naming the identity it changed,
// so that a later layer's router learns of every change without scanning.  INERT in this layer: nothing sets
// `hactive`, so noteToken returns at its first read and no token is ever written; layer 2 adds the reader.
//
// The two stores, in each source database that has them (the workspace's from version 10; a notebooks database only
// once layer 4 upgrades it, so in this layer only the tests' own):
//   htokens  {seq, ident, rev, kind, chain, sz}, keyPath seq
//   hmeta    hseq (the counter), hcount and hbytes (the rows held and the sum of their sz), ovf ({seq}: the overflow
//            witness), hactive (true while history tracks this namespace), exhausted (true: the never-cleared
//            terminal state); each absent until first written
//
// A leaf: it imports only db.ts's `req`, and reads the index through the `getEntry` its caller passes, so that it
// carries nothing of the workspace (design r2.2 Z1).
import { req } from "../workspace/db";

export const HIST_STORES = ["htokens", "hmeta"] as const;
/** The bounds, per source (plan §2.2, §8: 50,000 rows / 16 MiB, half of the namespace's 100,000 / 32 MiB each); a
 * token's own size bound; and the last seq ever used (exhaustion, @sagebrush's final ruling: never a wrap, a reuse or
 * a repeat). */
export const TOKEN_LIMITS = Object.freeze({ rows: 50_000, bytes: 16 * 2 ** 20, rowBytes: 4096, maxSeq: 2 ** 53 - 1 });
/** A chain's most ancestors: web/workspace/paths.ts MAX_DEPTH (32 names) less the identity's own (tree-asserted equal:
 * this module is a leaf, so the constant is its own).  More is a broken chain, never a longer walk (A1.2). */
export const MAX_ANCESTORS = 31;

export type TokenKind = "file" | "folder" | "notebook" | "board";
/** The identity's folder ancestry by fid, root first, after the save; null when it is gone or in Trash; "broken" when
 * a folder above it could not be read with its identity (never a silent null). */
export type Chain = string[] | null | "broken";
export type Token = { seq: number; ident: string; rev: number; kind: TokenKind; chain: Chain; sz: number };
export type TokenInput = { ident: string; rev: number; kind: TokenKind; chain: Chain | (() => Promise<Chain>) };

/** The frozen byte metric (design r2.2 §2 step 3): the UTF-8 length of the canonical JSON of {seq, ident, rev, kind,
 * chain}, its keys sorted, no whitespace (JSON.stringify of these primitives is canonical once the keys are). */
export function tokenSize(t: Omit<Token, "sz">): number {
  const canonical = JSON.stringify({ chain: t.chain, ident: t.ident, kind: t.kind, rev: t.rev, seq: t.seq });
  return new TextEncoder().encode(canonical).length;
}

/** Whether a transaction's scope holds both history stores (a notebooks database without them, in this layer every
 * production one, saves exactly as before). */
export const hasHistoryStores = (tx: IDBTransaction) => HIST_STORES.every((s) => tx.objectStoreNames.contains(s));

/** Whether history is active in this transaction's database (one read): for a writer with work to do before its
 * tokens (several identities, or a lookup per token), so that the inactive case does none of it. */
export async function historyActive(tx: IDBTransaction): Promise<boolean> {
  return hasHistoryStores(tx) && (await req(tx.objectStore("hmeta").get("hactive"))) === true;
}

/** The workspace index's generation in this transaction (its latest op seq, or meta's opsFloor if larger: the same
 * rule as Workspace.generation, web/workspace/db.ts "ops"): a workspace token's `rev` (design r2.2 A1.1).  The token
 * of an op carries that op's seq, which is the generation after it; a change committed with no op of its own (a
 * confirmed large move's publication, a fetch's install) carries the generation it was committed at.  Not unique, never
 * a key: tokens are told apart and ordered by `seq` alone.  The transaction must have "ops" and "meta" in scope. */
export async function indexGeneration(tx: IDBTransaction): Promise<number> {
  const last = await new Promise<number>((ok, no) => {
    const c = tx.objectStore("ops").openKeyCursor(null, "prev");
    c.onsuccess = () => ok((c.result?.key as number | undefined) ?? 0);
    c.onerror = () => no(c.error);
  });
  const floor = ((await req(tx.objectStore("meta").get("opsFloor"))) as number | undefined) ?? 0;
  return Math.max(last, floor);
}

/** Record one changed identity, in the save's own transaction (`tx`, readwrite, with HIST_STORES in its scope when
 * the database has them).  Returns at once, after one read, unless history is active, before any ancestry walk.
 * Nothing here is caught: a failed request aborts the whole transaction, so the save fails visibly through its
 * existing path, never committing a change no token or witness records (@sagebrush's ruling, design r2.2 §2). */
export async function noteToken(tx: IDBTransaction, t: TokenInput): Promise<void> {
  if (!hasHistoryStores(tx)) return;
  const meta = tx.objectStore("hmeta");
  if ((await req(meta.get("hactive"))) !== true) return;
  // (the terminal state: saves go on, with no token; only a reviewed repair or reset may ever change it)
  if ((await req(meta.get("exhausted"))) === true) return;
  const hseq = ((await req(meta.get("hseq"))) as number | undefined) ?? 0;
  if (hseq >= TOKEN_LIMITS.maxSeq) {
    meta.put(true, "exhausted");
    return;
  }
  const next = hseq + 1;
  const chain = typeof t.chain === "function" ? await t.chain() : t.chain;
  const row = { seq: next, ident: t.ident, rev: t.rev, kind: t.kind, chain };
  const sz = tokenSize(row);
  const count = ((await req(meta.get("hcount"))) as number | undefined) ?? 0;
  const bytes = ((await req(meta.get("hbytes"))) as number | undefined) ?? 0;
  if (sz > TOKEN_LIMITS.rowBytes || count + 1 > TOKEN_LIMITS.rows || bytes + sz > TOKEN_LIMITS.bytes) {
    // (the bounded append: no token, the witness instead, overwritten with this larger seq; never a refusal)
    meta.put({ seq: next }, "ovf");
    meta.put(next, "hseq");
    return;
  }
  // (add, not put: a duplicate seq, impossible by construction, aborts rather than overwrites)
  tx.objectStore("htokens").add({ ...row, sz } satisfies Token);
  meta.put(next, "hseq");
  meta.put(count + 1, "hcount");
  meta.put(bytes + sz, "hbytes");
}

type ChainEntry = { kind: string; fid?: string; trashed?: unknown } | undefined;
/** An identity's chain after a save, read in the save's transaction through the caller's `getEntry` (the workspace's
 * logical read model, so a chunked move's rows are read where they logically are).  `path`: where the identity is
 * now, or null if it is gone; `parentOf` and `trash` as the workspace defines them. */
export async function chainOf(path: string | null, inTrash: boolean, getEntry: (p: string) => Promise<ChainEntry>, parentOf: (p: string) => string): Promise<Chain> {
  if (path === null || inTrash) return null;
  const out: string[] = [];
  // (each folder above, nearest first; the root "/" has no entry and no identity)
  for (let p = parentOf(path), guard = 0; p !== "/"; p = parentOf(p), guard++) {
    if (guard >= MAX_ANCESTORS) return "broken";
    const e = await getEntry(p);
    if (!e || e.kind !== "folder" || !e.fid || e.trashed) return "broken";
    out.push(e.fid);
  }
  return out.reverse();
}
