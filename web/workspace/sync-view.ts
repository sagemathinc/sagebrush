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
import { breather } from "./sync-confirmed";
import { entriesOf, fenceCheck, busyError, type EntriesView } from "./sync-rewrite";
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
const listedKey = (ns: string) => `sync:${ns}:listed`;
/** Paths listed in the Sync panel's list (in a transaction with meta). */
export async function noteListed(meta: IDBObjectStore, ns: string, listed: [string, ListedWhy][]) {
  if (!listed.length) return;
  const was = ((await req(meta.get(listedKey(ns)))) as { count: number; paths: [string, ListedWhy][] } | undefined) ?? { count: 0, paths: [] };
  meta.put({ count: was.count + listed.length, paths: [...listed, ...was.paths].slice(0, LISTED_MAX) }, listedKey(ns));
}
/** Paths kept in the Sync panel's list, at most. */
const LISTED_MAX = 100;

/** An adoption (or reissue) journal record (C3, D6): an identity's state by its parent's identity. */
export type JournalRecord = { ns: string; id: string; parent: string; name: string; kind: Entry["kind"]; sha256?: string; size?: number; trashed: boolean; gone?: true; sent?: true; from?: string };
type State = Pick<OpAfter, "parent" | "name" | "kind" | "sha256" | "size" | "trashed"> | null;
type View = { kind: "entry"; e: SyncEntry } | { kind: "gone" } | { kind: "none" };
/** Why an identity is in the Sync panel's list. */
export type ListedWhy = "kept" | "conflict" | "no-room" | "no-folder" | "not-empty" | "renamed";

/** A page's identities read by range, five requests (the rebuild's view walks identities in key order): their
 * confirmed rows, entries, outbox records, journal records and pending states. */
type Prefetched = { lo: string; hi: string; set?: Set<string>; rows: Map<string, SyncEntry | { gone: string }>; ents: Map<string, Entry>; out: Map<string, OutboxRecord[]>; j: Map<string, JournalRecord>; pend: Map<string, Pending> };
async function prefetch(tx: IDBTransaction, ns: string, prefix: string, journalNs: string, lo: string, hi: string, ev: EntriesView): Promise<Prefetched> {
  const rows = new Map<string, SyncEntry | { gone: string }>(), ents = new Map<string, Entry>(), out = new Map<string, OutboxRecord[]>(), j = new Map<string, JournalRecord>(), pend = new Map<string, Pending>();
  for (const r of (await req(tx.objectStore("syncIndex").getAll(IDBKeyRange.bound([prefix, lo], [prefix, hi])))) as (SyncEntry & { ns: string; key?: string; parentKey?: string; gone?: true; lastPath?: string })[]) {
    if (r.gone) rows.set(r.id, { gone: r.lastPath ?? "" });
    else {
      const { ns: _n, key: _k, parentKey: _p, ...e } = r;
      rows.set(r.id, e as SyncEntry);
    }
  }
  for (const e of await ev.byIdentAll(IDBKeyRange.bound(lo, hi))) ents.set(e.ident!, e);
  for (const r of (await req(tx.objectStore("outbox").index("byIdent").getAll(IDBKeyRange.bound([ns, lo], [ns, hi])))) as OutboxRecord[]) out.set(r.id, [...(out.get(r.id) ?? []), r]);
  for (const r of (await req(tx.objectStore("adoptJournal").getAll(IDBKeyRange.bound([journalNs, lo], [journalNs, hi])))) as JournalRecord[]) j.set(r.id, r);
  for (const p of (await req(tx.objectStore("pending").getAll(IDBKeyRange.bound(lo, hi)))) as Pending[]) pend.set(p.id, p);
  return { lo, hi, rows, ents, out, j, pend };
}
const inRange = (pre: Prefetched | undefined, id: string) => !!pre && (pre.set ? pre.set.has(id) : id >= pre.lo && id <= pre.hi);
/** A page's identities (not a range: D11's replay walks keys) read at once, their five sources each, every request
 * made before any is awaited. */
async function prefetchIds(tx: IDBTransaction, ns: string, prefix: string, journalNs: string, ids: string[], ev: EntriesView, given?: Map<string, SyncEntry>): Promise<Prefetched> {
  const pre: Prefetched = { lo: "", hi: "", set: new Set(ids), rows: new Map(), ents: new Map(), out: new Map(), j: new Map(), pend: new Map() };
  const ix = tx.objectStore("syncIndex"), ob = tx.objectStore("outbox").index("byIdent"), aj = tx.objectStore("adoptJournal"), pd = tx.objectStore("pending");
  // (the intents' stores asked once each how many they hold: an empty one is never asked per identity; pending states,
  // when few, by their keys (as retire reads them): so a page of intent-free identities costs about one request each,
  // within the replay page's 400)
  const [nOut, nJ, nPend] = (await Promise.all([req(ob.count(IDBKeyRange.bound([ns, ""], [ns, "\uffff"]))), req(aj.count(IDBKeyRange.bound([journalNs, ""], [journalNs, "\uffff"]))), req(pd.count())])) as number[];
  const pendKeys = nPend > 0 && nPend <= 2_000 ? new Set((await req(pd.getAllKeys())) as string[]) : null;
  const none = Promise.resolve(undefined);
  await Promise.all(ids.map(async (id) => {
    const [r, e, o, jr, p] = await Promise.all([
      given?.has(id) ? Promise.resolve(given.get(id)) : (req(ix.get([prefix, id])) as Promise<(SyncEntry & { ns: string; key?: string; parentKey?: string; gone?: true; lastPath?: string }) | undefined>),
      // (an identity whose confirmed row is given is most often at that path (a replay's placement, after its
      // sweeps): read there first, by key, its identity checked; else by identity)
      (async () => {
        const g = given?.get(id);
        const at = g && !("gone" in g) && typeof g.path === "string" ? await ev.get(g.path) : undefined;
        return at && at.ident === id ? at : await ev.byIdent(id);
      })(),
      nOut ? (req(ob.getAll([ns, id])) as Promise<OutboxRecord[]>) : Promise.resolve([] as OutboxRecord[]),
      nJ ? (req(aj.get([journalNs, id])) as Promise<JournalRecord | undefined>) : none,
      nPend && (!pendKeys || pendKeys.has(id)) ? (req(pd.get(id)) as Promise<Pending | undefined>) : none,
    ]) as [(SyncEntry & { ns?: string; key?: string; parentKey?: string; gone?: true; lastPath?: string }) | undefined, Entry | undefined, OutboxRecord[], JournalRecord | undefined, Pending | undefined];
    if (r) {
      if (r.gone) pre.rows.set(id, { gone: r.lastPath ?? "" });
      else { const { ns: _n, key: _k, parentKey: _p, ...x } = r; pre.rows.set(id, x as SyncEntry); }
    }
    if (e) pre.ents.set(id, e);
    if (o.length) pre.out.set(id, o);
    if (jr) pre.j.set(id, jr);
    if (p) pre.pend.set(id, p);
  }));
  return pre;
}

/** One identity's local intents (C3's layers, by key): its outbox records, its journal record, its pending state. */
async function intentsOf(tx: IDBTransaction, ns: string, scanned: number | undefined, id: string, journalNs: string, pre?: Prefetched, replacedBelow?: number) {
  const here = inRange(pre, id);
  const out0 = here ? (pre!.out.get(id) ?? []) : ((await req(tx.objectStore("outbox").index("byIdent").getAll([ns, id]))) as OutboxRecord[]);
  const out = replacedBelow === undefined ? out0 : out0.filter((r) => r.dseq >= replacedBelow);
  const j = here ? pre!.j.get(id) : ((await req(tx.objectStore("adoptJournal").get([journalNs, id]))) as JournalRecord | undefined);
  const p = here ? pre!.pend.get(id) : ((await req(tx.objectStore("pending").get(id))) as Pending | undefined);
  const st = p?.byNs?.[ns];
  const unscanned = p?.latest && (scanned === undefined || p.latest.seq > scanned) ? p.latest : undefined;
  const journal = j && !j.sent ? j : undefined;
  const any = out.length > 0 || !!journal || !!st?.held || !!st?.successor || !!unscanned;
  return { out: out.sort((a, b) => a.dseq - b.dseq), journal, unscanned, any };
}

export type ViewContext = {
  w: Workspace;
  /** (P0 #1 (b1)) this device's own adopts and creates in the page: identity, the path it asked for.  One the view
   * moves elsewhere (the reducer gave it `name (k)`: another device has that name) is marked renamed and listed */
  ownPlaced?: Map<string, string>;
  tx: IDBTransaction;
  ns: string;
  /** the confirmed index the view is over (the active generation, or a rebuild's just committed) */
  store: Store;
  /** the journal's prefix in adoptJournal (the first sync's `ns`, or a committed reissue generation's) */
  journalNs?: string;
  /** the pins' cap, read before the transaction (capNow) */
  cap: number;
  /** a rebuild's view (D6 r4): nothing is deleted, an entry the view names gone is kept and listed too */
  keepGone?: boolean;
  /** the identities given are every one in [lo, hi] of the union (the rebuild's walk): read by range, `prefix` the
   * confirmed index's generation */
  range?: { lo: string; hi: string; prefix: string };
  /** (D11) the identities given, read at once before the view is computed (the replay's pages) */
  prefetch?: { ids: string[]; prefix: string; rows?: Map<string, SyncEntry> };
  /** a rebuild's view: records below this dseq are the replaced prefix, not intents (their identities' state is in
   * the committed journal, a layer of its own; retire removes them next) */
  replacedBelow?: number;
  /** (D11) large lifts never made in the page: a folder whose view moves it, with more than `chunk` entries under it,
   * is handed to `debt` (r4 §4, r6 §3: replayed later as a logical move of its own) and left where it is; identities
   * `deferred` says are in such a range are passed over */
  large?: { chunk: number; debt: (it: { id: string; e: Entry; to: string }) => void; deferred?: (id: string) => boolean; settled?: (id: string, path: string) => boolean; translate?: (p: string, at: string) => string | undefined };
  /** (N6) a folder the view would forget but that still holds entries: handed here (reconsidered once, after the
   * forget's other identities), not listed yet */
  notEmpty?: (id: string) => void;
  now?: number;
};

/** The view's reads for context `c`, in its transaction (C3): an identity's entry, its view (its confirmed state,
 * or with its local intents reduced on top), and the page's memos.  applyView applies what it computes; D11's plan
 * pass computes the same without writing (sync-replay.ts). */
export async function viewer(c: ViewContext) {
  const { w, tx, ns } = c;
  const st = tx.objectStore("entries"), meta = tx.objectStore("meta");
  // (the fence (D11 r3 §1): a large move being applied refuses this page's writes under its prefixes, the page aborted
  // whole, `busy`, and applied again once the move has drained; reads through the read model)
  const ev = await fenceCheck(tx, []);
  const guard = (p: string) => { if (ev.ms.conflicts(p)) throw busyError(); };
  const breathe = breather(tx);
  const scanned = (await req(meta.get(`sync:${ns}:scanned`))) as number | undefined;
  const journalNs = c.journalNs ?? ns;
  const now = c.now ?? Date.now();
  const ops: Op[] = [], gone: Entry[] = [], listed: [string, ListedWhy][] = [];
  let synthSeq = 2 ** 52;
  const pre = c.range ? await prefetch(tx, ns, c.range.prefix, journalNs, c.range.lo, c.range.hi, ev) : c.prefetch ? await prefetchIds(tx, ns, c.prefetch.prefix, journalNs, c.prefetch.ids, ev, c.prefetch.rows) : undefined;
  // (an identity's intents read once a page: a folder's are asked for by each of its entries' reductions)
  const seen = new Map<string, Awaited<ReturnType<typeof intentsOf>>>();
  const intents = async (tx: IDBTransaction, ns: string, scanned: number | undefined, id: string, journalNs: string, pre?: Prefetched, below?: number) => {
    if (!seen.has(id)) seen.set(id, await intentsOf(tx, ns, scanned, id, journalNs, pre, below));
    return seen.get(id)!;
  };
  // (the confirmed index doesn't change while a view is applied (the view writes entries): what it answers is kept
  // for the page, an identity in the prefetched range answered from it, so each identity's reduction reads only what
  // no earlier one did)
  const memo = { byId: new Map<string, SyncEntry | undefined>(), gone: new Map<string, string | undefined>(), folder: new Map<string, SyncEntry[]>() };
  const cp = (e: SyncEntry): SyncEntry => ({ ...e, ...(e.trashed ? { trashed: { ...e.trashed } } : {}) });
  const store: Store = {
    async byId(id) {
      if (inRange(pre, id)) { const r = pre!.rows.get(id); return r && !("gone" in r) ? cp(r) : undefined; }
      if (!memo.byId.has(id)) memo.byId.set(id, await c.store.byId(id));
      const e = memo.byId.get(id);
      return e ? cp(e) : undefined;
    },
    async gone(id) {
      if (inRange(pre, id)) { const r = pre!.rows.get(id); return r && "gone" in r ? r.gone : undefined; }
      if (!memo.gone.has(id)) memo.gone.set(id, await c.store.gone(id));
      return memo.gone.get(id);
    },
    async folder(k) {
      if (!memo.folder.has(k)) memo.folder.set(k, await c.store.folder(k));
      return memo.folder.get(k)!.map(cp);
    },
  };

  const entryOf = async (id: string) => (inRange(pre, id) ? pre!.ents.get(id) : await ev.byIdent(id));
  /** The confirmed state of an identity with no intent: its entry, gone, or none. */
  const confirmedOf = async (id: string): Promise<View> => {
    if (inRange(pre, id)) {
      const r = pre!.rows.get(id);
      return r === undefined ? { kind: "none" } : "gone" in r ? { kind: "gone" } : { kind: "entry", e: r };
    }
    const e = await store.byId(id);
    if (e) return { kind: "entry", e };
    return (await store.gone(id)) !== undefined ? { kind: "gone" } : { kind: "none" };
  };
  /** A folder's entry, read once per page. */
  const folders = new Map<string, Entry | null>();
  const folderAt = async (p: string): Promise<Entry | null> => {
    if (!folders.has(p)) folders.set(p, (await ev.get(p)) ?? null);
    return folders.get(p)!;
  };

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
    const mine = await intents(tx, ns, scanned, id, journalNs, pre, c.replacedBelow);
    if (!mine.any) return { v: await confirmedOf(id), intent: false };
    // (its folders' intents first, top-down, then its own: a folder made or moved here and not yet confirmed is
    // where its entries go; each by key, at most the workspace's depth)
    const base = new PartialIndex();
    const chain: [string, Entry | undefined][] = [];
    if (local) {
      for (let p = parentOf(local.path); p !== "/" && p !== TRASH; p = parentOf(p)) {
        const f = await folderAt(p);
        if (f?.ident) chain.unshift([f.ident, f]);
      }
    }
    chain.push([id, local]);
    try {
      for (const [x, e] of chain) {
        const m = x === id ? mine : await intents(tx, ns, scanned, x, journalNs, pre, c.replacedBelow);
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

  return { w, tx, ns, st, meta, ev, guard, breathe, now, ops, gone, listed, store, entryOf, confirmedOf, folders, folderAt, viewOf };
}
export type Viewer = Awaited<ReturnType<typeof viewer>>;
export type ViewOf = Awaited<ReturnType<Viewer["viewOf"]>>;

/**
 * The view of `ids` recomputed and the difference applied to the entries, in `c.tx`.  Returns the ops logged (to
 * tell after the transaction), the entries forgotten (their contents dropped after it: dropContents), and the
 * paths listed.
 */
export async function applyView(c: ViewContext, ids: Iterable<string>): Promise<{ ops: Op[]; gone: Entry[]; listed: [string, ListedWhy][] }> {
  const { w, tx, ns, st, meta, ev, guard, breathe, now, ops, gone, listed, entryOf, folders, folderAt, viewOf } = await viewer(c);
  // ---- the views, computed before anything changes
  type Item = { id: string; e?: Entry; v: View; intent: boolean };
  const items = new Map<string, Item>();
  for (const id of ids) {
    if (items.has(id) || c.large?.deferred?.(id)) continue;
    const e = await entryOf(id);
    const it: Item = { id, e, ...(await viewOf(id, e)) };
    // (D11: a top a plan put at a free `name (k)` beside an occupant that stays is where its view puts it)
    if (e && it.v.kind === "entry" && c.large?.settled?.(id, e.path)) it.v = { kind: "entry", e: { ...it.v.e, path: e.path } };
    // (and what it carries: an entry in it whose view is where the top's view would carry it, where it is (N8: as
    // the one-transaction view's lift carries it); not one moving on its own (CORR-D11-IMPL-1))
    else if (e && it.v.kind === "entry") {
      const t = c.large?.translate?.(it.v.e.path, e.path);
      if (t !== undefined) it.v = { kind: "entry", e: { ...it.v.e, path: t } };
    }
    items.set(id, it);
  }

  // ---- what moves (its old path: it and what is in it lifted out, then put where its view says)
  const lifted = new Map<string, Entry>();
  const tops = new Map<string, { item: Item; to: string }>();
  // (identities lifted (moved, or carried by a folder moved): their entry read again by identity after; folders whose
  // subtree is lifted, so a folder inside one isn't read again)
  const moved = new Set<string>(), subtrees = new Set<string>();
  const underLifted = (p: string) => { for (let a = parentOf(p); a !== "/"; a = parentOf(a)) if (subtrees.has(a)) return true; return false; };
  const lift = async (it: Item, to: string) => {
    const e = it.e!;
    guard(e.path);
    guard(to);
    moved.add(it.id);
    tops.set(e.path, { item: it, to });
    if (!lifted.has(e.path)) {
      lifted.set(e.path, e);
      st.delete(e.path);
      if (e.kind === "folder") folders.set(e.path, null);
    }
    if (e.kind === "folder" && !underLifted(e.path)) {
      subtrees.add(e.path);
      for (const d of (await req(st.getAll(subtree(e.path)))) as Entry[]) {
        lifted.set(d.path, d);
        if (d.ident) moved.add(d.ident);
        if (d.kind === "folder") folders.set(d.path, null);
        st.delete(d.path);
        await breathe();
      }
    }
  };
  // (D11: a large lift is a debt, not lifted here)
  const deferred = new Set<string>();
  const large = async (it: Item) => {
    if (!c.large || it.e!.kind !== "folder" || underLifted(it.e!.path)) return false;
    if (((await req(st.count(subtree(it.e!.path)))) as number) <= c.large.chunk) return false;
    c.large.debt({ id: it.id, e: it.e!, to: (it.v as { e: SyncEntry }).e.path });
    deferred.add(it.id);
    return true;
  };
  for (const it of items.values()) if (it.e && it.v.kind === "entry" && it.v.e.path !== it.e.path && !(await large(it))) await lift(it, it.v.e.path);
  // (a descendant whose new path is exactly where its moved folder takes it is carried by that folder, not placed
  // (or logged) on its own: a remote move of a 100,000-entry folder is one change here, as the workspace's own is)
  for (const [old, t] of [...tops]) {
    for (let a = parentOf(old); a !== "/"; a = parentOf(a)) {
      const up = tops.get(a);
      if (!up) continue;
      if (up.to + old.slice(a.length) === t.to) tops.delete(old);
      break;
    }
  }

  // ---- what is placed: the moved, then the new, shallowest first (a folder before what goes in it)
  const depth = (p: string) => p.split("/").length;
  const queue: { item: Item; to: string; old?: string }[] = [...tops.entries()].map(([old, t]) => ({ ...t, old }));
  for (const it of items.values()) if (!it.e && it.v.kind === "entry") queue.push({ item: it, to: it.v.e.path });
  queue.sort((a, b) => depth(a.to) - depth(b.to));

  const list = (p: string, why: ListedWhy) => listed.push([p, why]);
  let total: number | undefined;
  const inFolder = new Map<string, number>();
  const freeIn = async (p: string) => {
    const folder = parentOf(p), [b, ext] = splitExt(nameOf(p));
    // (the folder's taken names, by their NFC form: a lookalike is taken too; at most its 10,000)
    const names = new Set((ev.active ? await ev.list(folder) : ((await req(st.index("byNfc").getAll(IDBKeyRange.bound(folder + "\u0000", folder + "\u0000\uffff")))) as Entry[])).map((x) => nkeyOf(x.path)));
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
    if (folder !== "/" && folder !== TRASH && !(await folderAt(folder))) {
      if (old) putBack(old);
      list(old ?? to, "no-folder");
      continue;
    }
    guard(to);
    const occ = ev.active ? (await ev.lookalikes(to, 1))[0] : ((await req(st.index("byNfc").get(nkeyOf(to)))) as Entry | undefined);
    if (occ) {
      // (the entry in the way: recomputed (its view may move it on); one that stays makes this one a copy beside it)
      const oid = occ.ident;
      let moved = false;
      if (oid && !items.has(oid)) {
        const it: Item = { id: oid, e: occ, ...(await viewOf(oid, occ)) };
        items.set(oid, it);
        if (it.v.kind === "entry" && keyOf(it.v.e.path) !== keyOf(occ.path)) {
          if (await large(it)) {
            // (a large occupant moving on: a debt; it stays, so this one is placed beside it below)
          } else {
          await lift(it, it.v.e.path);
          const at = queue.findIndex((q, i) => i > qi && depth(q.to) > depth(it.v.kind === "entry" ? it.v.e.path : "/"));
          queue.splice(at < 0 ? queue.length : at, 0, { item: it, to: it.v.e.path, old: occ.path });
          moved = true;
          }
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
      // (counted once a page and kept up to date here: a count is a walk of the store)
      total ??= await ev.count();
      if (!inFolder.has(folder)) inFolder.set(folder, folder === "/" ? -1 : ev.active ? await ev.childCount(folder) : ((await req(st.index("byNfc").count(IDBKeyRange.bound(folder + "\u0000", folder + "\u0000\uffff")))) as number));
      const here = inFolder.get(folder)! < 0 ? total : inFolder.get(folder)!;
      if (total + 1 > w.limits.maxEntries || here + 1 > w.limits.maxFolderEntries) {
        list(to, "no-room");
        continue;
      }
      total++;
      if (inFolder.get(folder)! >= 0) inFolder.set(folder, inFolder.get(folder)! + 1);
      const n: Entry = {
        path: to, kind: v.kind, ref: v.kind === "folder" ? null : v.kind === "file" ? to : v.ref!, created: v.created, updated: v.updated, nkey: nkeyOf(to), ident: item.id,
        ...(v.fid ? { fid: v.fid } : {}),
        ...(v.kind === "file" ? { size: v.size ?? 0, rev: 0, migrated: true, ...(v.sha256 ? { sha256: v.sha256, fetch: v.sha256 } : {}), remote: true } : {}),
        ...(v.kind === "notebook" || v.kind === "board" ? { remote: true } : {}),
        ...(v.trashed ? { trashed: { from: v.trashed.from, at: v.trashed.at } } : {}),
      };
      st.put(n);
      if (n.kind === "folder") folders.set(to, n);
      const pf = folder === "/" || folder === TRASH ? null : ((await folderAt(folder))?.fid ?? null);
      await w.logServer(tx, ops, { op: v.kind === "folder" ? "mkdir" : "create", path: to, kind: v.kind }, n, undefined, pf);
      continue;
    }
    // (a move: it, and what was in it, at the new path; what is in it that moves on its own is placed by its own)
    const e = item.e!;
    const n: Entry = { ...e, path: to, nkey: nkeyOf(to), updated: now, ...(e.kind === "file" && e.ref !== null ? { ref: to } : {}) };
    if (v.trashed) n.trashed = { from: v.trashed.from, at: v.trashed.at };
    else delete n.trashed;
    if (!item.intent) contentOf(n, v);
    // (this device's own, asked for at `old`, placed at another name in the same folder: renamed by the shared reducer
    // (another device has that name), said on the row and listed, P0 #1 (b1).  Known by this device's own adopt or
    // create in the page; or, when the move comes in a later page, by its shape: the same folder
    // and extension, and the name the reducer gives, `name (k)` (a person's rename to
    // exactly that is said the same way))
    const [ob, oe] = splitExt(nameOf(old)), [nb, ne] = splitExt(nameOf(to));
    const suffixed = oe === ne && nb.startsWith(ob + " (") && /^ \(\d+\)$/.test(nb.slice(ob.length));
    // (by shape only for this device's own entry: another device's (`remote`) renamed by its owner to `X (k)` is a
    // rename, not this; sync-docs' N-AD-1)
    if (to !== old && parentOf(to) === parentOf(old) && (c.ownPlaced?.get(item.id) === old || (suffixed && !n.remote))) {
      n.renamed = { from: old, to };
      list(to, "renamed");
    }
    st.put(n);
    if (n.kind === "folder") folders.set(to, n);
    lifted.delete(old);
    for (const [p, d] of [...lifted]) {
      if (!p.startsWith(old + "/")) continue;
      // (its nearest top: this one, or one inside it moving on its own)
      let owner = parentOf(p);
      while (owner !== old && !tops.has(owner) && owner !== "/") owner = parentOf(owner);
      if (owner !== old || tops.has(p)) continue;
      const q = to + p.slice(old.length);
      const placed = { ...d, path: q, nkey: nkeyOf(q), ...(d.kind === "file" && d.ref !== null ? { ref: q } : {}) };
      st.put(placed);
      if (d.kind === "folder") folders.set(q, placed);
      lifted.delete(p);
      await breathe();
    }
    const op = v.trashed && !e.trashed ? "remove" : !v.trashed && e.trashed ? "restore" : "rename";
    await w.logServer(tx, ops, { op, path: old, to, kind: e.kind }, n);
  }
  // (anything still lifted (a move inside a move that couldn't be made): back where it was)
  for (const [, e] of lifted) { st.put(e); await breathe(); }

  // ---- content only (no move), and what goes (deepest first), and what is kept
  const lease = await liveLease(meta);
  const rest = [...items.values()].sort((a, b) => depth(b.e?.path ?? "/") - depth(a.e?.path ?? "/"));
  for (const it of rest) {
    if (!it.e || it.intent || deferred.has(it.id)) continue;
    // (by identity: a moved or carried one's path has changed; one not moved is as read)
    const cur = moved.has(it.id) ? await ev.byIdent(it.id) : it.e;
    if (!cur) continue;
    if (it.v.kind === "entry") {
      // (only where its view put it: one whose move couldn't be made keeps its content as it was too)
      if (it.v.e.path !== cur.path) continue;
      const n = { ...cur };
      if (contentOf(n, it.v.e)) {
        guard(cur.path);
        n.updated = now;
        st.put(n);
        await w.logServer(tx, ops, { op: "write", path: n.path, kind: n.kind }, n);
      }
    } else if (it.v.kind === "gone" && c.keepGone) list(cur.path, "kept");
    else if (it.v.kind === "gone") {
      if (cur.kind === "folder" && ((await req(st.count(subtree(cur.path)))) as number) > 0) {
        if (c.notEmpty) { c.notEmpty(it.id); continue; }
        list(cur.path, "not-empty");
        continue;
      }
      guard(cur.path);
      st.delete(cur.path);
      if (cur.kind === "file" && cur.fid) {
        meta.put(1, GONE + cur.fid);
        if (cur.migrated && !cur.remote) {
          const pin = lease ? await pinOfCurrent(tx, cur.fid, cur.sha256) : undefined;
          if (!pin || !(await charge(tx, pin, { orphan: true }, c.cap))) tx.objectStore("fileBytes").delete(cur.fid);
        }
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
 * fetch queued (L1: `fetch`, the index byFetch).  Returns whether it changed. */
function contentOf(n: Entry, v: SyncEntry): boolean {
  if (n.kind !== "file" || !v.sha256 || v.sha256 === n.sha256) return false;
  n.sha256 = v.sha256;
  n.size = v.size ?? 0;
  n.rev = (n.rev ?? 0) + 1;
  n.remote = true;
  n.fetch = v.sha256;
  return true;
}
