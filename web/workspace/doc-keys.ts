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
import { DocKeyError, type DocDeclarations, type KeyDeclaration } from "./sync-dockeys.ts";

/** The account's epochs, as the sync client's key provider gives them: the E2E account, the verified chain's head and
 * current epoch, and an epoch's keys. */
export interface AccountEpochs {
  readonly account: string;
  chain(refresh?: boolean): Promise<{ readonly head: string; readonly currentEpoch: number }>;
  epochKeys(n: number): Promise<EpochKeys | null>;
}
const NUL = "\u0000";
/** The most times one sealing resolves a document's generation (a stale declaration, then epochs begun meanwhile). */
export const RESOLVES = 3;

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
      // (a declaration re-sealed under a newer head than it names is refused "stale": the chain read again, once; and
      //  one confirmed after the chain began a new epoch answers for its own, retired at the new head, so the new
      //  epoch's is resolved instead. At most RESOLVES tries in all, and a generation is used only if it is still of the
      //  current epoch when it is answered: otherwise the sealing fails (closed), never sealed under a retired one)
      const gen = (async () => {
        let view = { head, currentEpoch }, staleSeen = false;
        for (let i = 0; i < RESOLVES; i++) {
          let g: KeyGeneration;
          try {
            g = await resolve(doc, view.head, view.currentEpoch);
          } catch (e) {
            if ((e as { code?: string })?.code !== "stale" || staleSeen) throw e;
            staleSeen = true;
            view = await epochs.chain(true);
            continue;
          }
          const now = await epochs.chain();
          if (now.currentEpoch === g.keyEpoch) return g;
          view = now;
        }
        throw new Error("e2e: the account's epoch kept changing while this notebook's key was declared");
      })();
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

/** Where a page finds its account's keys: its sync owner, whose client options carry the sealing module (with the
 * account's epochs) when the account syncs end to end, and whose running client answers the key declarations. */
export interface KeySource {
  e2eKeys(): AccountEpochs | null;
  readonly client: { docDeclarations(): DocDeclarations } | null;
}

/** A page's DocKeys, or undefined while its account has no end-to-end keys: then DocSync carries patches as before.
 * The declarations are asked of the owner's client at each call: DocSync runs only on the tab whose client runs, and a
 * client made again (a new connection, a lease taken over) answers from the same confirmed ledger. With no client
 * running, every call is refused ("ended"), a generation already resolved included, which stops the notebook (e2e)
 * until the page is reloaded. */
export function pageDocKeys(src: KeySource): DocKeys | undefined {
  const epochs = src.e2eKeys();
  if (!epochs) return undefined;
  const decl = (): DocDeclarations => {
    const c = src.client;
    if (!c) throw new DocKeyError("ended", "no sync client on this page");
    return c.docDeclarations();
  };
  const keys = docKeys({
    epochs,
    declarations: {
      current: async (doc, head) => decl().current(doc, head),
      exact: async (doc, cekId, keyEpoch) => decl().exact(doc, cekId, keyEpoch),
      declare: async (d: KeyDeclaration) => decl().declare(d),
    },
  });
  // (the client asked for on every sealing, not only when the index is: a generation cached at this head is no answer
  // once no client runs. A lookup asks the index every time, so it is refused then already)
  return { ...keys, current: async (doc) => { decl(); return keys.current(doc); } };
}
