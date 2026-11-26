// Where a page's DocSync gets a notebook's keys under end-to-end encryption (design: e2e-encryption.md §3.1 and §4): a
// DocKeys (doc-seal.ts) over the account's epochs and the sealed index's key declarations.
//
// A document's current generation is the one the index declares for it at the chain's current head, if that
// generation belongs to the current epoch. Otherwise (no generation yet, the declared one retired at this head, or an
// epoch begun since, as a device removal begins one) a new generation is minted under the current epoch: a random
// CEK, wrapped under that epoch's K_wrap (e2e/doc-cek.ts), declared in the index, and used once the index answers with
// the generation that is current after it decides (another device's, if its declaration came first). A pulled patch's
// generation is looked up exactly as its slice names it, and unwrapped under that generation's own epoch.
//
// Each document's current generation is asked for once per chain head, and minted at most once at a time; a
// generation's CEK is unwrapped once. A failure caches nothing, and DocSync stops the notebook on it ("e2e").
import type { DocKeys, KeyGeneration } from "./doc-seal.ts";
import type { EpochKeys } from "./e2e/keys.ts";
import { mintDocCek, unwrapDocCek, type CekPlace } from "./e2e/doc-cek.ts";
import { hex } from "./e2e/bytes.ts";

/** The account's epochs, as the sync client's key provider gives them: the E2E account, the verified chain's head and
 * current epoch, and an epoch's keys. */
export interface AccountEpochs {
  readonly account: string;
  chain(refresh?: boolean): Promise<{ readonly head: string; readonly currentEpoch: number }>;
  epochKeys(n: number): Promise<EpochKeys | null>;
}
/** A document key generation as the sealed index declares it, with the chain head that authorized its declaration (the
 * head its op was sealed under: the index keeps no head of its own, and refuses a key epoch that isn't that head's). */
export type KeyDeclaration = Readonly<{ document: string; cekId: string; keyEpoch: number; wrappedCek: Uint8Array; head: string }>;
/** The sealed index's key declarations. */
export interface DocDeclarations {
  /** the generation `doc`'s new patches are sealed under at `head`: the latest declared that isn't retired at it, or null */
  current(doc: string, head: string): Promise<KeyDeclaration | null>;
  /** exactly the generation (doc, cekId, keyEpoch), or null */
  exact(doc: string, cekId: string, keyEpoch: number): Promise<KeyDeclaration | null>;
  /** declare a new generation; resolves, once the index decides, with the generation current for `doc` after it.
   * Rejects with code "stale" if the chain moved past `head` before it went up (it is then minted again, once) */
  declare(d: KeyDeclaration): Promise<KeyDeclaration>;
}

const NUL = "\u0000";

export function docKeys(src: { epochs: AccountEpochs; declarations: DocDeclarations }): DocKeys {
  const { epochs, declarations } = src, account = epochs.account;
  const current = new Map<string, { head: string; gen: Promise<KeyGeneration> }>();
  const opened = new Map<string, Promise<CryptoKey>>();

  const keysOf = async (n: number): Promise<EpochKeys> => {
    const k = await epochs.epochKeys(n);
    if (!k) throw new Error(`e2e: this device doesn't hold epoch ${n}'s keys`);
    return k;
  };
  const place = (d: { document: string; cekId: string; keyEpoch: number }): CekPlace => ({ account, document: d.document, cekId: d.cekId, keyEpoch: d.keyEpoch });
  // (a declared generation's CEK, unwrapped once; a failure is forgotten, so the next lookup tries again)
  const unwrap = (d: KeyDeclaration): Promise<CryptoKey> => {
    const k = d.document + NUL + d.cekId + NUL + d.keyEpoch;
    let p = opened.get(k);
    if (!p) {
      p = keysOf(d.keyEpoch).then((keys) => unwrapDocCek(keys, place(d), d.wrappedCek));
      opened.set(k, p);
      p.catch(() => { if (opened.get(k) === p) opened.delete(k); });
    }
    return p;
  };
  const resolve = async (doc: string, head: string, epoch: number): Promise<KeyGeneration> => {
    const d = await declarations.current(doc, head);
    if (d && d.keyEpoch === epoch) return { cekId: d.cekId, keyEpoch: d.keyEpoch, cek: await unwrap(d) };
    const cekId = hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const { cek, wrapped } = await mintDocCek(await keysOf(epoch), place({ document: doc, cekId, keyEpoch: epoch }));
    const won = await declarations.declare({ document: doc, cekId, keyEpoch: epoch, wrappedCek: wrapped, head });
    if (won.cekId === cekId && won.keyEpoch === epoch) return { cekId, keyEpoch: epoch, cek };
    // (another generation is current after the index decided: that one, unless it is of an older epoch than ours)
    if (won.keyEpoch !== epoch) throw new Error("e2e: the index's current generation isn't of the current epoch");
    return { cekId: won.cekId, keyEpoch: won.keyEpoch, cek: await unwrap(won) };
  };

  return {
    account,
    async current(doc) {
      const { head, currentEpoch } = await epochs.chain();
      const had = current.get(doc);
      if (had && had.head === head) return had.gen;
      // (a declaration re-sealed under a newer head than it names is refused "stale": the chain read again, once)
      const gen = resolve(doc, head, currentEpoch).catch(async (e) => {
        if ((e as { code?: string })?.code !== "stale") throw e;
        const now = await epochs.chain(true);
        return resolve(doc, now.head, now.currentEpoch);
      });
      const entry = { head, gen };
      current.set(doc, entry);
      gen.catch(() => { if (current.get(doc) === entry) current.delete(doc); });
      return gen;
    },
    async find(doc, cekId, keyEpoch) {
      const d = await declarations.exact(doc, cekId, keyEpoch);
      if (!d) return null;
      if (d.document !== doc || d.cekId !== cekId || d.keyEpoch !== keyEpoch) throw new Error("e2e: the index answered another generation than the one asked for");
      return unwrap(d);
    },
  };
}

/** A page's DocKeys, or undefined while its account has no end-to-end keys: then DocSync carries patches as before.
 * (The account's epochs come from the keys-and-devices page side, the declarations from the sealed index's key
 * declaration; until both exist no page has keys, and this answers undefined.) */
export async function pageDocKeys(): Promise<DocKeys | undefined> {
  return undefined;
}
