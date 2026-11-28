// Document key declarations in the sealed index (design: notes e2e-doc-key-declarations r2; e2e-encryption.md §3.1).
// A notebook's or board's patches are sealed under its own content key (CEK), one per document per epoch. A device
// that mints one declares it in the account's sealed log with a doc-key op, which carries the CEK wrapped under the
// epoch's K_wrap (e2e/doc-cek.ts); every device reads the declaration from the log it verifies.
//
//   { dseq, t, by, op: "doc-key", path: "/", kind: "folder", document, cekId, keyEpoch, wrappedCek }
//
// No inner head: the declaration's head is its envelope's authorizing head. Verifying a row (sync-seal.ts verifyRow)
// halts on any other form, and on a keyEpoch newer than its head's epoch (no device holds a future epoch's K_wrap). A
// keyEpoch equal to its head's epoch is unwrapped there, before the page's transaction, and the declaration is
// eligible if its wrap opens; an older keyEpoch is never unwrapped and is never eligible (a device's declaration
// sealed after a removal began a new epoch: void for every device, never a halt). Eligibility is a fact about the
// bytes, computed each time a row is verified and never stored.
//
// The ledger, in meta, per index generation, written in the transaction that applies its page:
//   sync:<gen>:dk:x:<document>:<keyEpoch>:<cekId> -> { wrappedCek, head, seq }   each eligible declaration (the first of
//                                                                                a triple; a later one changes nothing)
//   sync:<gen>:dk:c:<document>:<keyEpoch>         -> cekId                       the document's current declaration in
//                                                                                that epoch: the first eligible one, by
//                                                                                log order
//   sync:<gen>:dk:void                            -> n                           how many declarations were void
// Ops are applied one at a time in log order, so a later op of a page never changes an earlier one's verdict.
//
// No DOM, crypto or E2E code here: the page bundle has it without the sealing module.
import { req } from "./db";
import { isDocId } from "../sync-protocol/protocol";
import type { SyncOp } from "./sync-reduce";

/** The op that declares a document key generation. */
export const DOC_KEY_OP = "doc-key";
/** A wrapped CEK's length (doc-cek.ts WRAPPED_CEK), and its unpadded base64url form's. */
export const WRAPPED_CEK = 60;
const WRAPPED_B64 = 80;
const CEK_ID = /^[0-9a-f]{32}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const FIELDS = "by,cekId,document,dseq,keyEpoch,kind,op,path,t,wrappedCek";
const isNat = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/** A document key generation as the sealed index declares it, with the head that authorized it (its envelope's). */
export type KeyDeclaration = Readonly<{ document: string; cekId: string; keyEpoch: number; wrappedCek: Uint8Array; head: string }>;
/** The sealed index's key declarations, as a page's document keys ask for them (keyed by DocSync's document id). */
export interface DocDeclarations {
  /** the generation `doc`'s new patches are sealed under at `head`: its epoch's first eligible declaration, or null */
  current(doc: string, head: string): Promise<KeyDeclaration | null>;
  /** exactly the generation (doc, cekId, keyEpoch), or null after one catch-up */
  exact(doc: string, cekId: string, keyEpoch: number): Promise<KeyDeclaration | null>;
  /** declare a new generation; resolves, once the op is confirmed, with the generation current for its document in its
   * epoch after it; rejects (`code`) "stale", "refused", "ended" or "halted" */
  declare(d: KeyDeclaration): Promise<KeyDeclaration>;
}
/** A declaration's failure, by code. */
export class DocKeyError extends Error {
  constructor(readonly code: "stale" | "refused" | "ended" | "halted" | "invalid" | "unknown_head", message: string) { super(message); }
}

export const b64urlOf = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const bytesOf = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** Whether an opened op is exactly a declaration's form: those fields, no others, each of its kind. */
export function isDocKeyForm(op: Record<string, unknown>): boolean {
  if (Object.keys(op).sort().join(",") !== FIELDS) return false;
  if (op.op !== DOC_KEY_OP || op.path !== "/" || op.kind !== "folder") return false;
  if (!isDocId(op.document) || typeof op.cekId !== "string" || !CEK_ID.test(op.cekId) || !isNat(op.keyEpoch)) return false;
  return typeof op.wrappedCek === "string" && op.wrappedCek.length === WRAPPED_B64 && B64URL.test(op.wrappedCek);
}

/** A declaration op as this device makes it. */
export const docKeyOp = (dseq: number, t: number, by: string, d: KeyDeclaration) =>
  ({ dseq, t, by, op: DOC_KEY_OP, path: "/", kind: "folder", document: d.document, cekId: d.cekId, keyEpoch: d.keyEpoch, wrappedCek: b64urlOf(d.wrappedCek) });

/** Whether `d` is a declaration this device may send: a document id, a cekId, an epoch and a 60-byte wrap. */
export const isDeclaration = (d: KeyDeclaration): boolean =>
  !!d && isDocId(d.document) && typeof d.cekId === "string" && CEK_ID.test(d.cekId) && isNat(d.keyEpoch) && d.wrappedCek instanceof Uint8Array && d.wrappedCek.length === WRAPPED_CEK;

const pad = (n: number) => String(n).padStart(16, "0");
const K = {
  exact: (gen: string, doc: string, epoch: number, cekId: string) => `sync:${gen}:dk:x:${doc}:${pad(epoch)}:${cekId}`,
  current: (gen: string, doc: string, epoch: number) => `sync:${gen}:dk:c:${doc}:${pad(epoch)}`,
  void: (gen: string) => `sync:${gen}:dk:void`,
};
type ExactRow = { wrappedCek: string; head: string; seq: number };

/** What verifying a declaration's row found: whether it is eligible, and its envelope's head. Never stored. */
export type DocKeyVerdict = Readonly<{ eligible: boolean; head: string }>;

/**
 * A page's declarations applied, in log order, in the page's transaction (after its rows): each sealed doc-key op that
 * its row's verification found eligible is recorded, and becomes its document's current one in its epoch if it has
 * none yet; any other (an older epoch's, a wrap that doesn't open, or one with no verdict) declares nothing.
 */
export async function docKeyPage(meta: IDBObjectStore, gen: string, ops: readonly SyncOp[], verdictOf: (seq: number) => DocKeyVerdict | undefined): Promise<void> {
  let voided = 0;
  for (const raw of ops) {
    if (raw.op !== DOC_KEY_OP) continue;
    const op = raw as SyncOp & { document: string; cekId: string; keyEpoch: number; wrappedCek: string };
    const v = verdictOf(op.seq);
    if (!v?.eligible) {
      voided++;
      continue;
    }
    const xk = K.exact(gen, op.document, op.keyEpoch, op.cekId);
    if ((await req(meta.get(xk))) === undefined) meta.put({ wrappedCek: op.wrappedCek, head: v.head, seq: op.seq } satisfies ExactRow, xk);
    const ck = K.current(gen, op.document, op.keyEpoch);
    if ((await req(meta.get(ck))) === undefined) meta.put(op.cekId, ck);
  }
  if (voided) meta.put((((await req(meta.get(K.void(gen)))) as number | undefined) ?? 0) + voided, K.void(gen));
}

const declOf = (doc: string, epoch: number, cekId: string, row: ExactRow): KeyDeclaration =>
  ({ document: doc, cekId, keyEpoch: epoch, wrappedCek: bytesOf(row.wrappedCek), head: row.head });

/** Exactly the declaration (doc, cekId, keyEpoch) in this ledger, or null. */
export async function exactDecl(meta: IDBObjectStore, gen: string, doc: string, cekId: string, keyEpoch: number): Promise<KeyDeclaration | null> {
  const row = (await req(meta.get(K.exact(gen, doc, keyEpoch, cekId)))) as ExactRow | undefined;
  return row ? declOf(doc, keyEpoch, cekId, row) : null;
}
/** The document's current declaration in `keyEpoch`, or null. */
export async function currentDecl(meta: IDBObjectStore, gen: string, doc: string, keyEpoch: number): Promise<KeyDeclaration | null> {
  const cekId = (await req(meta.get(K.current(gen, doc, keyEpoch)))) as string | undefined;
  return cekId === undefined ? null : exactDecl(meta, gen, doc, cekId, keyEpoch);
}
/** How many declarations this ledger has found void (tests). */
export const voidCount = async (meta: IDBObjectStore, gen: string) => (((await req(meta.get(K.void(gen)))) as number | undefined) ?? 0);
