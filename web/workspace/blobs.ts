// Data files' and versions' bytes by content (copy-on-write for workspace branches): `blobs` keeps each
// set of bytes once, under its SHA-256, however many entries, versions or pins name it.  The one place that writes the
// blob stores (db.ts version 11); every reference to a blob is changed through these helpers, in the caller's own
// transaction, and a blob is deleted only by dropBlobRef, when nothing names it any more.
//
// The references:
//   - an entry's `blob`, indexed by entries' byBlob;
//   - a version's `blob`, mirrored by its row in versionBlobs, [sha, id]: an exact one-to-one match with the versions
//     on blobs, both sides changed in the same transaction (an application-kept mirror, not an index IndexedDB keeps);
//   - a pin whose storage is "b:" + sha, indexed by pins' byStorage (taken once blob writes are on).
// The rule: dropBlobRef counts all three in the freeing transaction, after the caller's own reference has gone,
// and deletes the blob only on 0/0/0.  The transaction's scope must hold every store the counts read, so no writer of
// those stores, in any tab, comes between the counts and the delete; a failed request aborts it, never reads as zero.
//
// Accounting: meta's `blobBytes` is the blobs' total, changed only when a blob is added or deleted.
//
// Nothing writes blobs yet: the helpers are the contract the blob writes, a later change, will go through.
import { req } from "./db";

/** The stores every blob helper's transaction must hold, readwrite. */
export const BLOB_SCOPE = ["entries", "versions", "versionBlobs", "pins", "blobs", "meta"] as const;
/** meta's key for the blobs' total, in bytes. */
export const BLOB_BYTES = "blobBytes";
const SHA = /^[0-9a-f]{64}$/;

export type BlobErrorCode = "scope" | "invalid" | "missing" | "changed";
export class BlobError extends Error {
  constructor(readonly code: BlobErrorCode, message: string) {
    super(message);
    this.name = "BlobError";
  }
}

/** The stores only this module writes (and a workspace's reset, which empties them). */
export const BLOB_STORES: ReadonlySet<string> = new Set(["blobs", "versionBlobs"]);
/** (tests: whether a blob-store request, or a write of a blob reference, is being made by a helper now (`depth`) or
 * a blob store emptied by a reset's page (`reset`); the test build's guard refuses any made outside them) */
export const BLOB_HOOK = { depth: 0, reset: 0 };
/** `f` making a reset's page of a blob store: the one place the stores are emptied without dropBlobRef (api.ts's
 * cleanup, under its `resetting` state). */
export function inBlobReset<T>(f: () => T): T {
  BLOB_HOOK.reset++;
  try { return f(); } finally { BLOB_HOOK.reset--; }
}
const inHelper = <T>(f: () => T): T => {
  BLOB_HOOK.depth++;
  try { return f(); } finally { BLOB_HOOK.depth--; }
};

/** Whether `s` is a reference's canonical form: 64 lowercase hex characters. */
export const isSha = (s: unknown): s is string => typeof s === "string" && SHA.test(s);
/** A pin's storage key for a blob. */
export const blobSkey = (sha: string) => "b:" + sha;

/** Throws unless `tx` is readwrite and holds every store of BLOB_SCOPE. */
export function assertBlobScope(tx: IDBTransaction): void {
  if (tx.mode !== "readwrite") throw new BlobError("scope", "a blob's references change only in a readwrite transaction");
  for (const s of BLOB_SCOPE) if (!tx.objectStoreNames.contains(s)) throw new BlobError("scope", `a blob's references change only in a transaction that holds ${s}`);
}
const mustSha = (sha: unknown, what: string): string => {
  if (!isSha(sha)) throw new BlobError("invalid", `${what}: not a SHA-256 in its canonical form`);
  return sha;
};
const mustSize = (n: unknown, what: string): number => {
  if (!Number.isSafeInteger(n) || (n as number) < 0) throw new BlobError("invalid", `${what}: not a size`);
  return n as number;
};

async function addTotal(tx: IDBTransaction, delta: number) {
  const meta = tx.objectStore("meta");
  const was = ((await req(meta.get(BLOB_BYTES))) as number | undefined) ?? 0;
  // (a total that would go below zero is a total already wrong: the transaction aborts, nothing is hidden)
  if (!Number.isSafeInteger(was) || was + delta < 0) throw new BlobError("invalid", "the blobs' total would go below zero");
  meta.put(was + delta, BLOB_BYTES);
}

/** Bytes admitted for keeping: a copy made when they were admitted, and the SHA-256 of that copy. Only the copy is
 * ever stored, and nothing outside this module holds it, so what is kept is exactly what was hashed, whatever the
 * caller's buffer does afterwards. */
export type Admitted = { readonly sha: string; readonly size: number };
const admitted = new WeakMap<Admitted, Uint8Array>();
/** `bytes` admitted for keeping, outside any transaction (hashing awaits WebCrypto, which no IndexedDB transaction
 * may wait for): copied at once, before the first await, then the copy hashed. */
export async function admitBytes(bytes: Uint8Array): Promise<Admitted> {
  const copy = bytes.slice();
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  const a: Admitted = Object.freeze({ sha: [...d].map((b) => b.toString(16).padStart(2, "0")).join(""), size: copy.length });
  admitted.set(a, copy);
  return a;
}

/** The blob `sha` present, put from `bytes` (admitted, for that sha) if it isn't. A blob is never overwritten: one
 * already there stays as it is. Without bytes, a missing blob is an error. */
async function haveBlob(tx: IDBTransaction, sha: string, size: number, bytes?: Admitted): Promise<void> {
  // (checked before the first await: nothing the caller does meanwhile can change what is checked or kept)
  const own = bytes === undefined ? undefined : admitted.get(bytes);
  if (bytes !== undefined && (own === undefined || bytes.sha !== sha || bytes.size !== size)) throw new BlobError("invalid", "the bytes weren't admitted for this reference");
  const st = tx.objectStore("blobs");
  if ((await inHelper(() => req(st.getKey(sha)))) !== undefined) return;
  if (!own) throw new BlobError("missing", "no bytes for a blob that isn't kept");
  inHelper(() => st.add(own, sha));
  await addTotal(tx, size);
}

/** After the caller's own reference to `sha` is gone in `tx`, the blob deleted if nothing else names it: no entry
 * (byBlob), no version (versionBlobs) and no pin ("b:" + sha). `size` is the size the reference recorded: the blob
 * read before it is deleted must be that size (else the transaction aborts), and its own size is what the total
 * loses. */
export async function dropBlobRef(tx: IDBTransaction, sha: string, size: number): Promise<"kept" | "deleted"> {
  assertBlobScope(tx);
  mustSha(sha, "dropBlobRef");
  mustSize(size, "dropBlobRef");
  const range = IDBKeyRange.bound([sha, -Infinity], [sha, Infinity]);
  const [e, v, p] = await Promise.all([
    req(tx.objectStore("entries").index("byBlob").count(sha)),
    inHelper(() => req(tx.objectStore("versionBlobs").count(range))),
    req(tx.objectStore("pins").index("byStorage").count(blobSkey(sha))),
  ]);
  if (e !== 0 || v !== 0 || p !== 0) return "kept";
  const st = tx.objectStore("blobs");
  const b = (await inHelper(() => req(st.get(sha)))) as unknown;
  if (b === undefined) return "kept";
  if (!(b instanceof Uint8Array) || b.length !== size) throw new BlobError("invalid", "a blob isn't the size its reference recorded");
  inHelper(() => st.delete(sha));
  await addTotal(tx, -b.length);
  return "deleted";
}

type BlobEntry = { path: string; kind: string; blob?: string; sha256?: string; size?: number; fid?: string; rev?: number };
// (the row as the caller last read it is the row now: its kind, identity, revision and blob)
const sameRow = (cur: BlobEntry | undefined, was: BlobEntry) => !!cur && cur.kind === was.kind && cur.fid === was.fid && cur.rev === was.rev && cur.blob === was.blob;
const checkEntry = (e: BlobEntry) => {
  if (e.blob === undefined) return;
  mustSha(e.blob, e.path);
  if (e.kind !== "file") throw new BlobError("invalid", `${e.path}: only a data file names a blob`);
  if (e.sha256 !== e.blob) throw new BlobError("invalid", `${e.path}: its blob isn't its SHA-256`);
  mustSize(e.size, e.path);
};

/** An entry written (`next`), in place of `prev` (the same entry before, if any, at its path then): its blob present
 * (put from `bytes` if new), the row written (and `prev`'s path removed if it moved), then `prev`'s blob dropped if
 * it named another. A same-sha write drops nothing. */
export async function setEntryBlob<E extends BlobEntry>(tx: IDBTransaction, prev: E | undefined, next: E, bytes?: Admitted): Promise<void> {
  assertBlobScope(tx);
  checkEntry(next);
  if (prev) checkEntry(prev);
  const st = tx.objectStore("entries");
  // (the transaction's own state, read again: `prev` still the row at its path, and the destination free unless it is
  // `prev`'s own; anything else and nothing is written)
  const [atPrev, atNext] = await Promise.all([prev ? req(st.get(prev.path)) : Promise.resolve(undefined), req(st.get(next.path))]) as [BlobEntry | undefined, BlobEntry | undefined];
  if (prev && !sameRow(atPrev, prev)) throw new BlobError("changed", `${prev.path}: not the row it was`);
  if (atNext !== undefined && (!prev || prev.path !== next.path)) throw new BlobError("changed", `${next.path}: already taken`);
  if (next.blob !== undefined && next.blob !== prev?.blob) await haveBlob(tx, next.blob, next.size!, bytes);
  if (prev && prev.path !== next.path) inHelper(() => st.delete(prev.path));
  inHelper(() => st.put(next));
  if (prev?.blob !== undefined && prev.blob !== next.blob) await dropBlobRef(tx, prev.blob, prev.size!);
}

/** An entry removed for good: its row deleted, then its blob dropped. */
export async function clearEntryBlob<E extends BlobEntry>(tx: IDBTransaction, prev: E): Promise<void> {
  assertBlobScope(tx);
  checkEntry(prev);
  if (!sameRow((await req(tx.objectStore("entries").get(prev.path))) as BlobEntry | undefined, prev)) throw new BlobError("changed", `${prev.path}: not the row it was`);
  inHelper(() => tx.objectStore("entries").delete(prev.path));
  if (prev.blob !== undefined) await dropBlobRef(tx, prev.blob, prev.size!);
}

type BlobVersion = { id?: number; fid: string; size: number; sha256: string; blob?: string };
const checkVersion = (v: BlobVersion) => {
  mustSha(v.blob, "a version's blob");
  if (v.sha256 !== v.blob) throw new BlobError("invalid", "a version's blob isn't its SHA-256");
  mustSize(v.size, "a version");
};

/** A version kept on a blob: the blob present (put from `bytes` if new), the version's row, and its mirror row
 * [sha, id], together. Its id. Only ever a new version: one whose id is already kept is refused (a version's bytes
 * never change; replacing one is dropVersionBlob, then this). */
export async function putVersionBlob(tx: IDBTransaction, v: BlobVersion, bytes?: Admitted): Promise<number> {
  assertBlobScope(tx);
  checkVersion(v);
  if (v.id !== undefined) {
    if (!Number.isSafeInteger(v.id)) throw new BlobError("invalid", "a version's id");
    if ((await req(tx.objectStore("versions").getKey(v.id))) !== undefined) throw new BlobError("invalid", "a version already kept can't be put again");
  }
  await haveBlob(tx, v.blob!, v.size, bytes);
  const id = (await inHelper(() => req(tx.objectStore("versions").put(v)))) as number;
  inHelper(() => tx.objectStore("versionBlobs").put({ sha: v.blob, id }));
  return id;
}

/** A version on a blob removed: its row and its mirror row together, then its blob dropped. */
export async function dropVersionBlob(tx: IDBTransaction, v: BlobVersion & { id: number }): Promise<void> {
  assertBlobScope(tx);
  checkVersion(v);
  if (!Number.isSafeInteger(v.id)) throw new BlobError("invalid", "a version's id");
  const cur = (await req(tx.objectStore("versions").get(v.id))) as BlobVersion | undefined;
  if (!cur || cur.blob !== v.blob || cur.fid !== v.fid || cur.size !== v.size) throw new BlobError("changed", "a version not as it was");
  inHelper(() => tx.objectStore("versions").delete(v.id));
  inHelper(() => tx.objectStore("versionBlobs").delete([v.blob!, v.id]));
  await dropBlobRef(tx, v.blob!, v.size);
}

/** Whether blob `sha` is kept, by its key, without reading it. */
export async function blobPresent(tx: IDBTransaction, sha: string): Promise<boolean> {
  mustSha(sha, "blobPresent");
  return (await inHelper(() => req(tx.objectStore("blobs").getKey(sha)))) !== undefined;
}

/** The bytes of blob `sha`, read in `tx` (any mode); a missing blob is a "missing" error, never another's bytes. */
export async function readBlob(tx: IDBTransaction, sha: string): Promise<Uint8Array> {
  mustSha(sha, "readBlob");
  const b = (await inHelper(() => req(tx.objectStore("blobs").get(sha)))) as Uint8Array | undefined;
  if (!(b instanceof Uint8Array)) throw new BlobError("missing", "This file's stored contents are missing.");
  return b;
}
