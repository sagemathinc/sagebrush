// The LaTeX editor's drafts (autosave.ts; plan U8 r5): each editor's latest text, kept in this browser until a write
// of the file covers it, so that no edit is lost when the page goes away before its write lands. One record per
// (fid, writerId): a fresh writerId per editor instance, so two tabs never replace each other's draft.
//   - localStorage, written synchronously on every edit (durable before anything else happens), for a draft of up
//     to LS_CHARS characters;
//   - a larger one in IndexedDB ("sagebrush-tex-drafts"), durable when its transaction completes (William: "Never
//     prompt; accept that tiny risk for >2 MB files"). Moving between the two, the new store is written first, and
//     only then is the other store's older record of the same writer removed.
// A removal is conditional, checked at the time of the mutation: only this writer's record, and only if its gen is at
// most the gen acknowledged, so an older acknowledgement never removes a newer draft.
import type { Draft, DraftStore } from "./autosave";
import { EDIT_MAX } from "./save";

export const LS_PREFIX = "sb-tex-draft:";
/** characters (UTF-16 code units: 2 MiB) a draft may have in localStorage */
export const LS_CHARS = 1 << 20;

/** A stored record, if it is a well-formed draft of `fid` (anything else is ignored). */
export function draftOf(v: unknown, fid: string): Draft | null {
  const d = v as Draft;
  if (!d || typeof d !== "object" || d.fid !== fid || typeof d.writerId !== "string" || !/^[0-9a-f]{32}$/.test(d.writerId)) return null;
  if (!Number.isSafeInteger(d.gen) || d.gen < 1 || !Number.isSafeInteger(d.baseRev) || d.baseRev < 0) return null;
  if (typeof d.text !== "string" || d.text.length > EDIT_MAX || typeof d.path !== "string" || typeof d.t !== "number") return null;
  return { fid: d.fid, writerId: d.writerId, gen: d.gen, path: d.path, baseRev: d.baseRev, text: d.text, t: d.t };
}

/** A fresh writer id: 128 random bits, hex. */
export function newWriterId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function browserDrafts(ls: Storage = localStorage, idb: IDBFactory = indexedDB): DraftStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => (db ??= new Promise<IDBDatabase>((res, rej) => {
    const r = idb.open("sagebrush-tex-drafts", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("drafts", { keyPath: ["fid", "writerId"] }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { db = null; rej(r.error); };
  }));
  // (one transaction; resolves when it has completed: the durability point)
  const tx = <T>(mode: IDBTransactionMode, f: (st: IDBObjectStore, out: (v: T) => void) => void) => open().then((d) => new Promise<T>((res, rej) => {
    const t = d.transaction("drafts", mode), st = t.objectStore("drafts");
    let out: T; f(st, (v) => (out = v));
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error ?? new Error("aborted"));
  }));
  const lsKey = (fid: string, w: string) => LS_PREFIX + fid + ":" + w;
  const dropLs = (fid: string, w: string, upTo: number) => {
    const k = lsKey(fid, w), v = ls.getItem(k);
    if (v === null) return;
    let g = Infinity;
    try { g = Number(JSON.parse(v)?.gen); } catch {}
    if (!(g > upTo)) ls.removeItem(k);
  };
  const dropIdb = (fid: string, w: string, upTo: number) => tx<void>("readwrite", (st) => {
    const g = st.get([fid, w]);
    g.onsuccess = () => { const r = g.result as Draft | undefined; if (r && !(r.gen > upTo)) st.delete([fid, w]); };
  });
  return {
    put(d) {
      if (d.text.length <= LS_CHARS) {
        // (throws if the browser's storage is full: the saver's failed state)
        ls.setItem(lsKey(d.fid, d.writerId), JSON.stringify(d));
        // (this writer's older, larger draft in IndexedDB: removed now that this one is durable)
        void dropIdb(d.fid, d.writerId, d.gen - 1).catch(() => {});
        return true;
      }
      return tx<void>("readwrite", (st) => { st.put(d); }).then(() => dropLs(d.fid, d.writerId, d.gen - 1));
    },
    async drop(fid, w, upTo) {
      dropLs(fid, w, upTo);
      await dropIdb(fid, w, upTo).catch(() => {});
    },
    async all(fid) {
      const out: Draft[] = [];
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (!k || !k.startsWith(LS_PREFIX + fid + ":")) continue;
        try { const d = draftOf(JSON.parse(ls.getItem(k) ?? "null"), fid); if (d) out.push(d); } catch {}
      }
      const rows = await tx<Draft[]>("readonly", (st, ret) => {
        const q = st.getAll(IDBKeyRange.bound([fid, ""], [fid, "￿"]));
        q.onsuccess = () => ret((q.result as unknown[]).map((v) => draftOf(v, fid)).filter((d): d is Draft => !!d));
      }).catch(() => [] as Draft[]);
      return out.concat(rows);
    },
  };
}
