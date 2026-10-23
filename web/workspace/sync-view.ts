// The view (design/sync-client.md C3): what the person sees is the confirmed index with this device's local intents
// not yet confirmed reduced on top.  After each confirmed page, the identities it changed are recomputed and the
// difference applied to the workspace's entries, in the page's own transaction (entries, syncIndex and meta are one
// database: all of it or none), every change logged as `origin: "server"` (never sent back, no local intent).
//
// - An identity with no local intent takes its confirmed state: made, moved, put in Trash or taken out, a data
//   file's new bytes listed (`remote`, queued for its fetch), forgotten on an explicit gone row.
// - An identity with a local intent (an outbox record, an undrained journal record, a held write, an op past the
//   scan watermark) has its placement from the reducer run over the confirmed index with its intents (and its
//   folders' intents) on top, so a confirmed entry at its path makes it `name (2)` as on every device; its
//   content stays its own until its record is decided (the server's conflict copy then comes down as any entry).
// - Nothing is deleted that the view doesn't name gone: an entry the view no longer has is kept and listed, as a
//   conflict copy if its path is taken.
import type { Entry, Op, OpAfter, Workspace } from "./api";
import { req } from "./db";
import { TRASH, freePath, join, nameOf, parentOf, splitExt, within } from "./paths";
import { PartialIndex, entryIn, runOp, Halt, type Store } from "./sync-overlay";
import type { SyncEntry, SyncOp } from "./sync-reduce";
import type { OutboxRecord } from "./sync-outbox";
import type { Pending } from "./sync-pins";
import { pinOfCurrent, charge, liveLease } from "./sync-pins";
import { GONE } from "./sync-pins";

const keyOf = (p: string) => p.normalize("NFC");
const nkeyOf = (p: string) => parentOf(p) + "\u0000" + nameOf(p).normalize("NFC");
const subtree = (p: string) => (p === "/" ? undefined : IDBKeyRange.bound(p + "/", p + "0", false, true));
/** The view's stores: what a confirmed page's transaction takes when it applies the view. */
export const VIEW_STORES = ["entries", "ops", "outbox", "pending", "pins", "adoptJournal", "fileBytes", "meta", "versions", "versionBytes", "prunable"];
/** The fetch queue's key for a data file (L1, C5: sync-fetch). */
export const fetchKey = (ns: string, fid: string) => `sync:${ns}:fetch:${fid}`;
const listedKey = (ns: string) => `sync:${ns}:listed`;
/** Paths kept in the Sync panel's list, at most. */
const LISTED_MAX = 100;

/** An adoption (or reissue) journal record (C3, D6): an identity's state by its parent's identity. */
export type JournalRecord = { ns: string; id: string; parent: string; name: string; kind: Entry["kind"]; sha256?: string; size?: number; trashed: boolean; gone?: true; sent?: true; from?: string };
type State = Pick<OpAfter, "parent" | "name" | "kind" | "sha256" | "size" | "trashed"> | null;
type View = { kind: "entry"; e: SyncEntry } | { kind: "gone" } | { kind: "none" };
/** Why an identity is in the Sync panel's list. */
export type ListedWhy = "kept" | "conflict" | "no-room" | "no-folder" | "not-empty";

/** One identity's local intents (C3's layers, by key): its outbox records, its journal record, its pending state. */
async function intents(tx: IDBTransaction, ns: string, scanned: number | undefined, id: string, journalNs: string) {
  const out = (await req(tx.objectStore("outbox").index("byIdent").getAll([ns, id]))) as OutboxRecord[];
  const j = (await req(tx.objectStore("adoptJournal").get([journalNs, id]))) as JournalRecord | undefined;
  const p = (await req(tx.objectStore("pending").get(id))) as Pending | undefined;
  const st = p?.byNs?.[ns];
  const unscanned = p?.latest && (scanned === undefined || p.latest.seq > scanned) ? p.latest : undefined;
  const journal = j && !j.sent ? j : undefined;
  const any = out.length > 0 || !!journal || !!st?.held || !!st?.successor || !!unscanned;
  return { out: out.sort((a, b) => a.dseq - b.dseq), journal, unscanned, any };
}

export type ViewContext = {
  w: Workspace;
  tx: IDBTransaction;
  ns: string;
  /** the confirmed index the view is over (the active generation, or a rebuild's just committed) */
  store: Store;
  /** the journal's prefix in adoptJournal (the first sync's `ns`, or a committed reissue generation's) */
  journalNs?: string;
  /** the pins' cap, read before the transaction (capNow) */
  cap: number;
  now?: number;
};

/**
 * The view of `ids` recomputed and the difference applied to the entries, in `c.tx`.  Returns the ops logged (to
 * tell after the transaction), the entries forgotten (their contents dropped after it: dropContents), and the
 * paths listed.
 */
export async function applyView(c: ViewContext, ids: Iterable<string>): Promise<{ ops: Op[]; gone: Entry[]; listed: [string, ListedWhy][] }> {
  const { w, tx, ns, store } = c;
  const st = tx.objectStore("entries"), meta = tx.objectStore("meta");
  const scanned = (await req(meta.get(`sync:${ns}:scanned`))) as number | undefined;
  const journalNs = c.journalNs ?? ns;
  const now = c.now ?? Date.now();
  const ops: Op[] = [], gone: Entry[] = [], listed: [string, ListedWhy][] = [];
  let synthSeq = 2 ** 52;

  const entryOf = async (id: string) => (await req(st.index("byIdent").get(id))) as Entry | undefined;

  /** Synthetic ops putting `id` where `s` (its local state) says, over `base`. */
  const synth = async (base: PartialIndex, id: string, s: State, local: Entry | undefined): Promise<SyncOp[]> => {
    const cur = await entryIn(base, store, id);
    const kind = s?.kind ?? local?.kind ?? cur?.kind;
    if (!kind) return [];
    const ident = kind === "file" || kind === "folder" ? { fid: id } : { ref: id };
    const mk = (op: string, path: string, more: Partial<SyncOp> = {}): SyncOp => ({ seq: synthSeq++, device: w.device, dseq: 0, t: now, by: "person", op, path, kind, ...ident, ...more });
    if (s === null) return cur ? [mk("forget", cur.path)] : [];
    let folder = "/";
    if (s.parent) folder = (await entryIn(base, store, s.parent))?.path ?? (local ? parentOf(local.trashed ? local.trashed.from : local.path) : "/");
    const placed = join(folder, s.name);
    const parent = s.parent ? { parent: s.parent } : {};
    const content = kind === "file" ? { ...(s.sha256 ? { sha256: s.sha256 } : {}), ...(s.size !== undefined ? { size: s.size } : {}) } : {};
    const trashPath = local && within(local.path, TRASH) && local.path !== TRASH ? local.path : join(TRASH, s.name);
    if (!cur) {
      const from = s.trashed ? (local?.trashed?.from ?? join("/", s.name)) : placed;
      const made = mk(kind === "folder" ? "mkdir" : "create", from, { ...(s.trashed ? {} : parent), ...content });
      return s.trashed ? [made, mk("remove", from, { to: trashPath })] : [made];
    }
    if (s.trashed && !cur.trashed) return [mk("remove", cur.path, { to: trashPath })];
    if (!s.trashed && cur.trashed) return [mk("restore", cur.path, { to: placed, ...parent })];
    if (!s.trashed && keyOf(cur.path) !== keyOf(placed)) return [mk("rename", cur.path, { to: placed, ...parent })];
    return [];
  };

  /** The view of `id`: its confirmed state, or (with local intents) its placement with them reduced on top. */
  const viewOf = async (id: string, local: Entry | undefined): Promise<{ v: View; intent: boolean }> => {
    const mine = await intents(tx, ns, scanned, id, journalNs);
    if (!mine.any) {
      const e = await store.byId(id);
      if (e) return { v: { kind: "entry", e }, intent: false };
      return { v: (await store.gone(id)) !== undefined ? { kind: "gone" } : { kind: "none" }, intent: false };
    }
    // (its folders' intents first, top-down, then its own: a folder made or moved here and not yet confirmed is
    // where its entries go; each by key, at most the workspace's depth)
    const base = new PartialIndex();
    const chain: [string, Entry | undefined][] = [];
    if (local) {
      for (let p = parentOf(local.path); p !== "/" && p !== TRASH; p = parentOf(p)) {
        const f = (await req(st.get(p))) as Entry | undefined;
        if (f?.ident) chain.unshift([f.ident, f]);
      }
    }
    chain.push([id, local]);
    try {
      for (const [x, e] of chain) {
        const m = x === id ? mine : await intents(tx, ns, scanned, x, journalNs);
        if (!m.any) continue;
        const layer: SyncOp[] = m.out.map((r) => ({ ...r.op, seq: synthSeq++, device: w.device }) as SyncOp);
        for (const op of layer) await runOp(base, store, op, { alone: true });
        if (m.journal) for (const op of await synth(base, x, m.journal.gone ? null : m.journal, e)) await runOp(base, store, op, { alone: true });
        if (m.unscanned && m.unscanned.after !== undefined && m.unscanned.movedAt !== undefined && (scanned === undefined || m.unscanned.movedAt > scanned)) for (const op of await synth(base, x, m.unscanned.after, e)) await runOp(base, store, op, { alone: true });
      }
    } catch (err) {
      if (!(err instanceof Halt)) throw err;
      return { v: { kind: "none" }, intent: true };
    }
    const e = await entryIn(base, store, id);
    if (e) return { v: { kind: "entry", e }, intent: true };
    return { v: (await store.gone(id)) !== undefined ? { kind: "gone" } : { kind: "none" }, intent: true };
  };

  // ---- the views, computed before anything changes
  type Item = { id: string; e?: Entry; v: View; intent: boolean };
  const items = new Map<string, Item>();
  for (const id of ids) {
    if (items.has(id)) continue;
    const e = await entryOf(id);
    items.set(id, { id, e, ...(await viewOf(id, e)) });
  }

  // ---- what moves (its old path: it and what is in it lifted out, then put where its view says)
  const lifted = new Map<string, Entry>();
  const tops = new Map<string, { item: Item; to: string }>();
  const lift = async (it: Item, to: string) => {
    const e = it.e!;
    tops.set(e.path, { item: it, to });
    if (!lifted.has(e.path)) {
      lifted.set(e.path, e);
      st.delete(e.path);
    }
    if (e.kind === "folder") for (const d of (await req(st.getAll(subtree(e.path)))) as Entry[]) {
      lifted.set(d.path, d);
      st.delete(d.path);
    }
  };
  for (const it of items.values()) if (it.e && it.v.kind === "entry" && it.v.e.path !== it.e.path) await lift(it, it.v.e.path);

  // ---- what is placed: the moved, then the new, shallowest first (a folder before what goes in it)
  const depth = (p: string) => p.split("/").length;
  const queue: { item: Item; to: string; old?: string }[] = [...tops.entries()].map(([old, t]) => ({ ...t, old }));
  for (const it of items.values()) if (!it.e && it.v.kind === "entry") queue.push({ item: it, to: it.v.e.path });
  queue.sort((a, b) => depth(a.to) - depth(b.to));

  const list = (p: string, why: ListedWhy) => listed.push([p, why]);
  const freeIn = async (p: string) => {
    const folder = parentOf(p), [b, ext] = splitExt(nameOf(p));
    // (the folder's taken names, by their NFC form: a lookalike is taken too; at most its 10,000)
    const names = new Set(((await req(st.index("byNfc").getAll(IDBKeyRange.bound(folder + "\u0000", folder + "\u0000￿")))) as Entry[]).map((x) => nkeyOf(x.path)));
    return freePath(folder, b, ext, (x) => names.has(nkeyOf(x)));
  };
  // (the original, put back where it was: a move that can't be made leaves it there, listed)
  const putBack = (old: string) => {
    for (const [p, e] of lifted) if (p === old || p.startsWith(old + "/")) { st.put(e); lifted.delete(p); }
  };

  for (let qi = 0; qi < queue.length; qi++) {
    const { item, old } = queue[qi];
    let to = queue[qi].to;
    const v = (item.v as { e: SyncEntry }).e;
    // (its folder must be there: the view's folders are placed first; one that isn't (it failed a local check)
    // leaves this one where it was, listed)
    const folder = parentOf(to);
    if (folder !== "/" && folder !== TRASH && !(await req(st.get(folder)))) {
      if (old) putBack(old);
      list(old ?? to, "no-folder");
      continue;
    }
    const occ = (await req(st.index("byNfc").get(nkeyOf(to)))) as Entry | undefined;
    if (occ) {
      // (the entry in the way: recomputed (its view may move it on); one that stays makes this one a copy beside it)
      const oid = occ.ident;
      let moved = false;
      if (oid && !items.has(oid)) {
        const it: Item = { id: oid, e: occ, ...(await viewOf(oid, occ)) };
        items.set(oid, it);
        if (it.v.kind === "entry" && keyOf(it.v.e.path) !== keyOf(occ.path)) {
          await lift(it, it.v.e.path);
          const at = queue.findIndex((q, i) => i > qi && depth(q.to) > depth(it.v.kind === "entry" ? it.v.e.path : "/"));
          queue.splice(at < 0 ? queue.length : at, 0, { item: it, to: it.v.e.path, old: occ.path });
          moved = true;
        }
      }
      if (!moved) {
        const free = await freeIn(to);
        if (!free) {
          if (old) putBack(old);
          list(old ?? to, "conflict");
          continue;
        }
        to = free;
        list(to, "conflict");
      }
    }
    if (!old) {
      // (a new entry: room in the workspace and in its folder, as any entry made here)
      const total = (await req(st.count())) as number;
      const inFolder = folder === "/" ? total : ((await req(st.index("byNfc").count(IDBKeyRange.bound(folder + "\u0000", folder + "\u0000￿")))) as number);
      if (total + 1 > w.limits.maxEntries || inFolder + 1 > w.limits.maxFolderEntries) {
        list(to, "no-room");
        continue;
      }
      const n: Entry = {
        path: to, kind: v.kind, ref: v.kind === "folder" ? null : v.kind === "file" ? to : v.ref!, created: v.created, updated: v.updated, nkey: nkeyOf(to), ident: item.id,
        ...(v.fid ? { fid: v.fid } : {}),
        ...(v.kind === "file" ? { size: v.size ?? 0, rev: 0, migrated: true, ...(v.sha256 ? { sha256: v.sha256 } : {}), remote: true } : {}),
        ...(v.kind === "notebook" || v.kind === "board" ? { remote: true } : {}),
        ...(v.trashed ? { trashed: { from: v.trashed.from, at: v.trashed.at } } : {}),
      };
      st.put(n);
      if (v.kind === "file" && v.sha256) meta.put({ fid: v.fid, sha256: v.sha256, size: v.size ?? 0, rev: 0 }, fetchKey(ns, v.fid!));
      await w.logServer(tx, ops, { op: v.kind === "folder" ? "mkdir" : "create", path: to, kind: v.kind }, n);
      continue;
    }
    // (a move: it, and what was in it, at the new path; what is in it that moves on its own is placed by its own)
    const e = item.e!;
    const n: Entry = { ...e, path: to, nkey: nkeyOf(to), updated: now, ...(e.kind === "file" && e.ref !== null ? { ref: to } : {}) };
    if (v.trashed) n.trashed = { from: v.trashed.from, at: v.trashed.at };
    else delete n.trashed;
    if (!item.intent) contentOf(n, v, ns, meta);
    st.put(n);
    lifted.delete(old);
    for (const [p, d] of [...lifted]) {
      if (!p.startsWith(old + "/")) continue;
      // (its nearest top: this one, or one inside it moving on its own)
      let owner = parentOf(p);
      while (owner !== old && !tops.has(owner) && owner !== "/") owner = parentOf(owner);
      if (owner !== old || tops.has(p)) continue;
      const q = to + p.slice(old.length);
      st.put({ ...d, path: q, nkey: nkeyOf(q), ...(d.kind === "file" && d.ref !== null ? { ref: q } : {}) });
      lifted.delete(p);
    }
    const op = v.trashed && !e.trashed ? "remove" : !v.trashed && e.trashed ? "restore" : "rename";
    await w.logServer(tx, ops, { op, path: old, to, kind: e.kind }, n);
  }
  // (anything still lifted (a move inside a move that couldn't be made): back where it was)
  for (const [, e] of lifted) st.put(e);

  // ---- content only (no move), and what goes (deepest first), and what is kept
  const lease = await liveLease(meta);
  const rest = [...items.values()].sort((a, b) => depth(b.e?.path ?? "/") - depth(a.e?.path ?? "/"));
  for (const it of rest) {
    if (!it.e || it.intent) continue;
    const cur = (await req(st.get(it.e.path))) as Entry | undefined;
    if (!cur || cur.ident !== it.id) continue;
    if (it.v.kind === "entry") {
      if (it.v.e.path !== it.e.path) continue;
      const n = { ...cur };
      if (contentOf(n, it.v.e, ns, meta)) {
        n.updated = now;
        st.put(n);
        await w.logServer(tx, ops, { op: "write", path: n.path, kind: n.kind }, n);
      }
    } else if (it.v.kind === "gone") {
      if (cur.kind === "folder" && ((await req(st.count(subtree(cur.path)))) as number) > 0) {
        list(cur.path, "not-empty");
        continue;
      }
      st.delete(cur.path);
      if (cur.kind === "file" && cur.fid) {
        meta.put(1, GONE + cur.fid);
        if (cur.migrated && !cur.remote) {
          const pin = lease ? await pinOfCurrent(tx, cur.fid, cur.sha256) : undefined;
          if (!pin || !(await charge(tx, pin, { orphan: true }, c.cap))) tx.objectStore("fileBytes").delete(cur.fid);
        }
        meta.delete(fetchKey(ns, cur.fid));
      }
      gone.push(cur);
      await w.logServer(tx, ops, { op: "forget", path: cur.path, kind: cur.kind }, null, cur);
    } else list(cur.path, "kept");
  }

  if (listed.length) {
    const was = ((await req(meta.get(listedKey(ns)))) as { count: number; paths: [string, ListedWhy][] } | undefined) ?? { count: 0, paths: [] };
    const paths = [...listed, ...was.paths].slice(0, LISTED_MAX);
    meta.put({ count: was.count + listed.length, paths }, listedKey(ns));
  }
  return { ops, gone, listed };
}

/** A data file's confirmed content on `n` (no local intent): its new SHA-256 listed, `remote` until fetched, the
 * fetch queued (L1).  Returns whether it changed. */
function contentOf(n: Entry, v: SyncEntry, ns: string, meta: IDBObjectStore): boolean {
  if (n.kind !== "file" || !v.sha256 || v.sha256 === n.sha256) return false;
  n.sha256 = v.sha256;
  n.size = v.size ?? 0;
  n.rev = (n.rev ?? 0) + 1;
  n.remote = true;
  meta.put({ fid: n.fid, sha256: v.sha256, size: n.size, rev: n.rev }, fetchKey(ns, n.fid!));
  return true;
}
