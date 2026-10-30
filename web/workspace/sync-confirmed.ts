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
import { inTx, req, hex } from "./db";
import { MAX_DEPTH, MAX_PATH, parentOf } from "./paths";
import { OVERLAY, runPage, rowsOf, Halt, type Hidden, type Overlay, type Store } from "./sync-overlay";
import { D11, RW, type Mapping } from "./sync-rewrite";
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

// ---- large confirmed moves (design/sync-client.md D11 r2–r4, r8 N2)
//
// An op that relocates a folder of more than D11.chunk descendants (or two: a rename or restore whose folder is in a
// large folder in Trash brings that back first) is applied in chunks.  The page is cut before it; first in its page,
// its record is made (`sync:<gen>:rewrite`, the generation's one) and its preflight's pages read each hidden folder's
// subtree for its longest relative path and depth; then it runs alone, those subtrees hidden (sync-overlay.ts), its
// bounds checked from the preflight, and is published in its page's transaction: its rows (the tops, anything it wrote
// beneath them), the record's mappings, the cursor.  Then the rows under each source are rewritten a page at a time to
// their projection (path, key, parentKey, the op's `updated` and `seq`), the source ranges shrinking, and the record
// dropped by the page that finds them empty.  Nothing else is applied to the generation meanwhile (its pages wait):
// the sender is its only writer.

/** A generation's large-move record. */
export type CRecord = {
  rid: string;
  gen: string;
  op: { seq: number; t: number };
  published: boolean;
  /** the folders the op may relocate (hidden), as they were */
  cands: Hidden[];
  /** the preflight's position (which folder, the last key read) and its findings per folder */
  pre: { ci: number; after?: string; done?: boolean; max: Record<string, { len: number; depth: number; path: string }> };
  /** published: the relocations made (at most 2), each owning the rows under its source by longest prefix */
  maps?: Mapping[];
  /** (N6) a forget: its one folder's rows read as gone while published, each made gone with its ledger row */
  forget?: boolean;
  fails: number;
  stuck?: string;
  at: number;
};
export const crecordKey = (gen: string) => `sync:${gen}:rewrite`;
/** (N6) a forget's ledger in syncIndex: one row per identity it made gone, deeper first, until its view replays it */
export const ledgerNs = (gen: string) => `${gen}~forget`;
export const againNs = (gen: string) => `${gen}~forget~again`;
export const ledgerId = (path: string, id: string) => `${String(99 - (path === "/" ? 0 : path.split("/").length - 1)).padStart(2, "0")}:${id}`;
const depthOf = (p: string) => (p === "/" ? 0 : p.split("/").length - 1);
/** The mapping owning a row at `path` (its longest source prefix). */
const ownerOf = (maps: Mapping[], path: string): Mapping | undefined => {
  let best: Mapping | undefined;
  for (const m of maps) if (path.startsWith(m.from + "/") && (!best || m.from.length > best.from.length)) best = m;
  return best;
};
/** A row under a source, as its logical record (r3 §4's confirmed projection). */
function projectRow<T extends SyncEntry>(rec: CRecord, e: T, m: Mapping): T {
  const path = m.to + e.path.slice(m.from.length);
  return { ...e, path, updated: rec.op.t, seq: rec.op.seq };
}

/** A Store (sync-overlay.ts) over one generation of syncIndex, reading through transaction `tx`.  While a large move
 * is published there, every read is through its projection (D11 r2 §4, r7 §1 in direct mode). */
export function idbStore(tx: IDBTransaction, prefix: string, stats?: { reads: number; rows: number }): Store {
  const st = tx.objectStore("syncIndex");
  let recP: Promise<CRecord | undefined> | undefined;
  const rec = () => (recP ??= tx.objectStoreNames.contains(META) ? (req(tx.objectStore(META).get(crecordKey(prefix))) as Promise<CRecord | undefined>).then((r) => (r?.published ? r : undefined)) : Promise.resolve(undefined));
  const forgotten = (r: CRecord | undefined, path: string) => !!r?.forget && path.startsWith(r.maps![0].from + "/");
  const logical = (r: CRecord | undefined, e: SyncEntry): SyncEntry => {
    if (!r || r.forget) return e;
    const m = ownerOf(r.maps!, e.path);
    return m ? projectRow(r, e, m) : e;
  };
  const listing = async (folderKey: string) => {
    const rows = (await req(st.index("byParent").getAll(IDBKeyRange.only([prefix, folderKey])))) as Row[];
    if (stats) stats.rows += rows.length;
    const out: SyncEntry[] = [];
    for (const r of rows) {
      const e = entryOf(r);
      if (e) out.push(e);
    }
    return out;
  };
  return {
    async byId(id) {
      if (stats) stats.reads++;
      const r = (await req(st.get([prefix, id]))) as Row | undefined;
      const e = r ? entryOf(r) : undefined;
      const x = await rec();
      if (e && forgotten(x, e.path)) return undefined;
      return e ? logical(x, e) : undefined;
    },
    async gone(id) {
      if (stats) stats.reads++;
      const r = (await req(st.get([prefix, id]))) as Row | undefined;
      if (r && !("gone" in r) && forgotten(await rec(), r.path)) return r.path;
      return r && "gone" in r ? r.lastPath : undefined;
    },
    async folder(folderKey) {
      // (a listing is at most the workspace's 10,000 per folder: one request; the batch is the listing the partial
      // index holds next anyway (D10 r3's batch in hand))
      if (stats) stats.reads++;
      const r = await rec();
      if (!r) return listing(folderKey);
      if (r.forget) {
        const fk = keyOf(r.maps![0].from);
        return folderKey === fk || folderKey.startsWith(fk + "/") ? [] : listing(folderKey);
      }
      // (a large move published: the physical listing, without rows that have moved on from it (old aliases), and,
      // under a destination, the source's listing translated, rows owned by another mapping left out)
      const out = new Map<string, SyncEntry>();
      for (const e of await listing(folderKey)) if (!ownerOf(r.maps!, e.path)) out.set(e.id, e);
      let own: Mapping | undefined;
      for (const m of r.maps!) {
        const tk = keyOf(m.to);
        if ((folderKey === tk || folderKey.startsWith(tk + "/")) && (!own || tk.length > keyOf(own.to).length)) own = m;
      }
      if (own) {
        if (stats) stats.reads++;
        const src = keyOf(own.from) + folderKey.slice(keyOf(own.to).length);
        for (const e of await listing(src)) if (ownerOf(r.maps!, e.path) === own) out.set(e.id, projectRow(r, e, own));
      }
      return [...out.values()];
    },
    async childCount(folderKey) {
      if (stats) stats.reads++;
      return (await req(st.index("byParent").count(IDBKeyRange.only([prefix, folderKey])))) as number;
    },
    async keys(keys) {
      // (one round: the requests made at once, awaited together)
      if (stats) stats.reads += keys.length;
      const r = await rec();
      const ix = st.index("byKey");
      const rows = (await Promise.all(keys.map((k) => req(ix.get([prefix, k]))))) as (Row | undefined)[];
      return rows.map((x) => { const e = x ? entryOf(x) : undefined; return e ? logical(r, e) : undefined; });
    },
    async count(folderKey) {
      if (stats) stats.reads++;
      return (await req(st.index("byKey").count(IDBKeyRange.bound([prefix, folderKey + "/"], [prefix, folderKey + "0"], false, true)))) as number;
    },
  };
}

/** The preflight of `gen`'s unpublished record: a page of a hidden folder's subtree a transaction, its longest path and
 * depth relative to the folder kept, with the position.  Returns once done. */
export async function preflightConfirmed(w: Workspace, gen: string) {
  for (;;) {
    const done = await inTx(w.ws, ["syncIndex", META], "readwrite", async (tx) => {
      const meta = tx.objectStore(META), rec = (await req(meta.get(crecordKey(gen)))) as CRecord | undefined;
      if (!rec || rec.published || rec.pre.done) return true;
      const pre = { ...rec.pre, max: { ...rec.pre.max } };
      const h = rec.cands[pre.ci];
      if (!h) {
        meta.put({ ...rec, pre: { ...pre, done: true } } satisfies CRecord, crecordKey(gen));
        return true;
      }
      const lo = pre.after === undefined ? [gen, h.fromKey + "/"] : [gen, pre.after];
      const rows = (await req(tx.objectStore("syncIndex").index("byKey").getAll(IDBKeyRange.bound(lo, [gen, h.fromKey + "0"], pre.after !== undefined, true), D11.page))) as (SyncEntry & { key: string })[];
      const mx = pre.max[h.id] ?? { len: 0, depth: 0, path: h.fromPath };
      const d0 = depthOf(h.fromPath);
      for (const e of rows) {
        const len = e.path.length - h.fromPath.length, dep = depthOf(e.path) - d0;
        if (len > mx.len) { mx.len = len; mx.path = e.path; }
        if (dep > mx.depth) mx.depth = dep;
      }
      pre.max[h.id] = mx;
      if (rows.length < D11.page) { pre.ci++; delete pre.after; }
      else pre.after = rows[rows.length - 1].key;
      meta.put({ ...rec, pre } satisfies CRecord, crecordKey(gen));
      return false;
    }, { durability: "relaxed" });
    if (done) return;
    await new Promise((ok) => setTimeout(ok, 0));
  }
}

/** The hidden reduction's bounds (r2 §3, r8 N2): each hidden folder the op relocated, its subtree's longest path and
 * depth at its new place, from the preflight, as the reducer's relocate checks them in order; and the relocations made,
 * the record's mappings.  A failure skips the op whole. */
function boundsCheck(rec: CRecord, found: { maps: Mapping[] }) {
  return (ov: Overlay, outcome: { changed: string[] }): string | undefined => {
    const changed = new Set(outcome.changed), maps: Mapping[] = [];
    for (const h of rec.cands) {
      if (!changed.has(h.id)) continue;
      const cur = ov.curPath(h);
      if (cur === h.fromPath) continue;
      const mx = rec.pre.max[h.id];
      if (mx && (cur.length + mx.len > MAX_PATH || depthOf(cur) + mx.depth > MAX_DEPTH)) return `${mx.path.slice(0, 80)}… would be past the workspace's bounds`;
      maps.push({ i: maps.length, from: h.fromPath, to: cur, top: h.id });
    }
    found.maps = maps;
    return undefined;
  };
}

/** `gen`'s published record rewritten (r2 §2): a page of rows under its outermost sources a transaction, each put at
 * its projection, the record dropped once they are empty; a failure retried from D11.backoffMin, doubling to
 * D11.backoffMax; D11.fails in a row, stuck (a Halt: sync is halted, the person told; a reload tries again). */
export async function drainConfirmed(w: Workspace, gen: string): Promise<"none" | "done"> {
  let did = false;
  for (;;) {
    let r: "none" | "more" | "done" | "stuck";
    try {
      r = await inTx(w.ws, ["syncIndex", META], "readwrite", async (tx) => {
        const meta = tx.objectStore(META), rec = (await req(meta.get(crecordKey(gen)))) as CRecord | undefined;
        if (!rec || !rec.published) return "none";
        if (rec.stuck) return "stuck";
        const st = tx.objectStore("syncIndex"), breathe = breather(tx);
        const maps = rec.maps!;
        for (const m of maps.filter((m) => !maps.some((o) => o !== m && m.from.startsWith(o.from + "/")))) {
          const fk = keyOf(m.from);
          const rows = (await req(st.index("byKey").getAll(IDBKeyRange.bound([gen, fk + "/"], [gen, fk + "0"], false, true), D11.page))) as (SyncEntry & { ns: string; key: string; parentKey: string })[];
          if (!rows.length) continue;
          CONFIRMED_CUT?.(rec);
          if (rec.forget) {
            // (N6: each row made gone, with its ledger row, in this transaction)
            for (const row of rows) {
              st.put({ ns: gen, id: row.id, gone: true, lastPath: row.path });
              st.put({ ns: ledgerNs(gen), id: ledgerId(row.path, row.id) });
              await breathe();
            }
            if (rec.fails) meta.put({ ...rec, fails: 0 } satisfies CRecord, crecordKey(gen));
            return "more";
          }
          for (const row of rows) {
            const { ns: _n, key: _k, parentKey: _p, ...e } = row;
            const o = ownerOf(maps, e.path)!;
            const n = projectRow(rec, e as SyncEntry, o);
            st.put({ ...n, ns: gen, key: keyOf(n.path), parentKey: keyOf(parentOf(n.path)) });
            await breathe();
          }
          if (rec.fails) meta.put({ ...rec, fails: 0 } satisfies CRecord, crecordKey(gen));
          return "more";
        }
        meta.delete(crecordKey(gen));
        return "done";
      }, { durability: "relaxed" });
      if (r === "done") { const l = LARGE_LOG.findLast((x) => x.gen === gen && !x.drained); if (l) l.drained = Date.now(); }
    } catch (e) {
      const rec = await inTx(w.ws, META, "readwrite", async (tx) => {
        const meta = tx.objectStore(META), x = (await req(meta.get(crecordKey(gen)))) as CRecord | undefined;
        if (!x) return undefined;
        const n: CRecord = { ...x, fails: x.fails + 1 };
        if (n.fails >= D11.fails) n.stuck = `a large move couldn't be applied here: ${String((e as Error)?.message ?? e).slice(0, 200)} (reload to try again, or Delete my synced data)`;
        meta.put(n, crecordKey(gen));
        return n;
      });
      if (!rec) throw e;
      if (rec.stuck) throw new Halt(rec.stuck);
      await new Promise((ok) => setTimeout(ok, Math.min(D11.backoffMax, D11.backoffMin * 2 ** (rec.fails - 1))));
      continue;
    }
    if (r === "stuck") {
      // (stuck at an earlier run: a reload tries once more)
      const again = await inTx(w.ws, META, "readwrite", async (tx) => {
        const meta = tx.objectStore(META), x = (await req(meta.get(crecordKey(gen)))) as CRecord | undefined;
        if (!x?.stuck || stuckTried.has(x.rid)) return x?.stuck;
        stuckTried.add(x.rid);
        const n = { ...x, fails: D11.fails - 1 };
        delete n.stuck;
        meta.put(n, crecordKey(gen));
        return undefined;
      });
      if (again) throw new Halt(again);
      continue;
    }
    if (r === "none") return did ? "done" : "none";
    if (r === "done") return "done";
    did = true;
    await new Promise((ok) => setTimeout(ok, 0));
  }
}
/** (tests) what each large op did: its candidates, its skip reason, its mappings (the last 50) */
export const LARGE_LOG: { seq: number; gen: string; cands: string[]; skipped?: string; maps: [string, string][]; published: number; drained?: number; preflight?: number }[] = [];
/** (records stuck at an earlier run, tried once more by this page) */
const stuckTried = new Set<string>();
/** (tests) called inside each confirmed rewrite page's transaction, after its reads; throwing there aborts it */
export let CONFIRMED_CUT: ((rec: CRecord) => void) | null = null;
export const setConfirmedCut = (f: ((rec: CRecord) => void) | null) => { CONFIRMED_CUT = f; };

/** Every BREATHE writes in a transaction, one cheap read awaited: the task ends there (the transaction stays alive),
 * so a page of many writes (a 100,000-entry move) is many short tasks, not one long one (D10 r2's long tasks). */
export const BREATHE = 200;
export const breather = (tx: IDBTransaction) => {
  let n = 0;
  const meta = tx.objectStore(META);
  return async () => {
    if (++n % BREATHE === 0) await req(meta.get("sync:breathe"));
  };
};

/** A page's rows written to one generation (in the page's transaction). */
async function writeRows(tx: IDBTransaction, prefix: string, put: SyncEntry[], gone: [string, string][], drop: string[]) {
  const st = tx.objectStore("syncIndex"), breathe = breather(tx);
  for (const e of put) { st.put({ ...e, ns: prefix, key: keyOf(e.path), parentKey: keyOf(parentOf(e.path)) }); await breathe(); }
  for (const [id, lastPath] of gone) { st.put({ ns: prefix, id, gone: true, lastPath }); await breathe(); }
  for (const id of drop) { st.delete([prefix, id]); await breathe(); }
}

export type Applied = { applied: number; cursor: number; pages: number; changed: string[]; halted?: string };
/** A page's large move, told to `onPage`: its record's mappings (none: the op was skipped). */
export type LargeApplied = { rec: CRecord; maps: Mapping[]; replay: string[]; forget?: boolean };

/**
 * The ops of an `index` page (in seq order) applied to the confirmed index of `ns` (its active generation, or
 * `prefix`), past the durable cursor `cursorAt` (default the namespace's own).  Each page of reduction is one
 * transaction: its rows and the cursor, together.  `onPage` runs inside each transaction, after its rows are
 * written (C3: the view's affected identities recomputed in the same transaction), with the page's large move if it
 * published one.  `locked`: each page's transaction held in it (the workspace's lock, when the view writes entries);
 * a large move's preflight and rewrite pages are not (they write syncIndex only).
 */
export async function applyOps(
  w: Workspace,
  ns: string,
  ops: SyncOp[],
  opts: { prefix?: string; cursorAt?: string; stores?: string[]; onPage?: (tx: IDBTransaction, changed: string[], prefix: string, large?: LargeApplied) => Promise<void>; locked?: <T>(f: () => Promise<T>) => Promise<T>; afterLarge?: (gen: string) => Promise<void> } = {},
): Promise<Applied> {
  const stores = [...new Set(["syncIndex", META, ...(opts.stores ?? [])])];
  let at = 0, pages = 0, carry = 0, cursor = 0;
  const changedAll: string[] = [];
  const held = opts.locked ?? (<T>(f: () => Promise<T>) => f());
  for (;;) {
    // (D11: this generation's large move, published by an earlier page or a run before a reload, rewritten first: no
    // page is applied over a half-moved generation; then whatever follows it (the view's replay))
    const gen = opts.prefix ?? genPrefix(ns, ((await inTx(w.ws, META, "readonly", (tx) => req(tx.objectStore(META).get(genKey(ns))))) as number | undefined) ?? 0);
    if ((await drainConfirmed(w, gen)) === "done") await opts.afterLarge?.(gen);
    const step = await held(() => inTx(w.ws, stores, "readwrite", async (tx) => {
      const meta = tx.objectStore(META);
      const prefix = opts.prefix ?? genPrefix(ns, ((await req(meta.get(genKey(ns)))) as number | undefined) ?? 0);
      const ck = opts.cursorAt ?? cursorKey(ns);
      cursor = ((await req(meta.get(ck))) as number | undefined) ?? 0;
      // (D5: only the suffix past the durable cursor is reduced; anything at or below it is an echo's only)
      while (at < ops.length && ops[at].seq <= cursor) at++;
      if (at >= ops.length) return "end" as const;
      const rec = (await req(meta.get(crecordKey(prefix)))) as CRecord | undefined;
      if (rec?.published) return "drain" as const;
      const found = { maps: [] as Mapping[] };
      const ready = rec && rec.pre.done && rec.op.seq === ops[at].seq ? { seq: rec.op.seq, hidden: rec.cands, check: boundsCheck(rec, found) } : undefined;
      const page = await runPage(idbStore(tx, prefix), ops.slice(at, at + 1000), carry, { chunk: D11.chunk, ready });
      if (page.large && !page.large.ran && page.taken === 0) {
        // (a large op first in its page: its record made, unless this op's is there, and its preflight next)
        if (!rec || rec.op.seq !== ops[at].seq) {
          const op = ops[at];
          meta.put({ rid: hex(8), gen: prefix, op: { seq: op.seq, t: op.t }, published: false, cands: page.large.cands.map((c) => ({ id: c.id, fromPath: c.path, fromKey: keyOf(c.path) })), pre: { ci: 0, max: {} }, fails: 0, at: Date.now() } satisfies CRecord, crecordKey(prefix));
        }
        return "preflight" as const;
      }
      const { put, gone, drop } = rowsOf(page.base, page.changed);
      await writeRows(tx, prefix, put, gone, drop);
      const taken = page.taken;
      cursor = ops[at + taken - 1].seq;
      meta.put(cursor, ck);
      let large: LargeApplied | undefined;
      if (page.large?.ran) {
        LARGE_LOG.push({ seq: ops[at].seq, gen: prefix, cands: page.large.cands.map((c) => c.path), skipped: page.outcomes[0]?.skipped, maps: found.maps.map((m) => [m.from, m.to]), published: Date.now() });
        if (LARGE_LOG.length > 50) LARGE_LOG.shift();
      }
      if (page.large?.ran && ops[at].op === "forget" && !page.outcomes[0]?.skipped) {
        // (N6: a large forget published: the top's gone row (written above), its ledger row, the record; its
        // descendants made gone by the rewrite pages, each with its ledger row)
        const h = rec!.cands.find((c) => c.id === (ops[at].fid ?? ops[at].ref))!;
        tx.objectStore("syncIndex").put({ ns: ledgerNs(prefix), id: ledgerId(h.fromPath, h.id) });
        const pub: CRecord = { ...rec!, published: true, forget: true, maps: [{ i: 0, from: h.fromPath, to: h.fromPath, top: h.id }] };
        meta.put(pub, crecordKey(prefix));
        large = { rec: pub, maps: pub.maps!, replay: [h.id], forget: true };
      } else if (page.large?.ran) {
        // (published: its mappings, in this transaction with its rows and the cursor; skipped: its record dropped)
        if (found.maps.length && !page.outcomes[0]?.skipped) {
          const pub: CRecord = { ...rec!, published: true, maps: found.maps };
          meta.put(pub, crecordKey(prefix));
          // (the identities the replay recomputes: everything this page wrote at or under a new place)
          const under = (p: string) => found.maps.some((m) => p === m.to || p.startsWith(m.to + "/"));
          large = { rec: pub, maps: found.maps, replay: put.filter((e) => under(e.path)).map((e) => e.id) };
        } else {
          meta.delete(crecordKey(prefix));
          large = { rec: rec!, maps: [], replay: [] };
        }
      }
      const changed = [...page.changed];
      if (opts.onPage) await opts.onPage(tx, changed, prefix, large);
      for (const id of changed) changedAll.push(id);
      at += taken;
      carry = page.carry;
      pages++;
      return at >= ops.length ? ("end" as const) : ("more" as const);
    }));
    if (step === "preflight") {
      await preflightConfirmed(w, gen);
      continue;
    }
    if (step === "end") {
      // (the last page's large move rewritten before returning: the next page finds the generation whole)
      if ((await drainConfirmed(w, gen)) === "done") await opts.afterLarge?.(gen);
      return { applied: at, cursor, pages, changed: changedAll };
    }
  }
}

/**
 * An `index` page from the server applied as C3 says, holding the workspace's lock: each page of reduction, its
 * rows, the cursor and the view's difference on the entries, in one transaction; then the changes told, and the
 * contents of entries forgotten dropped (after their transaction, as emptying Trash does).
 */
export async function applyConfirmed(w: Workspace, ns: string, ops: SyncOp[], hooks: { onLarge?: (tx: IDBTransaction, large: LargeApplied) => Promise<void>; afterLarge?: (gen: string) => Promise<void> } = {}): Promise<Applied & { listed: [string, ListedWhy][] }> {
  const cap = await capNow();
  return (async () => {
    const told: Op[] = [], gone: Entry[] = [], listed: [string, ListedWhy][] = [];
    // (a page's results kept once it has committed: when the next page begins, or applyOps returns; a page that
    // aborts throws out of applyOps, and its results go with it)
    let last: Awaited<ReturnType<typeof applyView>> | null = null;
    const keep = () => {
      if (!last) return;
      told.push(...last.ops);
      gone.push(...last.gone);
      listed.push(...last.listed);
      last = null;
    };
    // (this device's own adopts and creates, by identity, with the path each asked for: the view says which the
    // reducer put at another name, P0 #1 (b1))
    const ownPlaced = new Map<string, string>();
    for (const o of ops) if (o.device === w.device && (o.op === "adopt" || o.op === "create" || o.op === "mkdir")) {
      const id = o.kind === "file" || o.kind === "folder" ? o.fid : o.ref;
      if (typeof id === "string") ownPlaced.set(id, o.path);
    }
    let r: Applied;
    try {
      r = await applyOps(w, ns, ops, {
        stores: VIEW_STORES,
        // (each page holding the workspace's lock: an ordinary change's hold, refused while quarantined or after a
        // reset elsewhere, the durability witness brought up to its commit; never across a large move's own pages)
        locked: (f) => w.locked(f),
        onPage: async (tx, changed, prefix, large) => {
          keep();
          // (a large move's view: its tops and everything under their new places are the replay's (D11 r4 §3), the
          // rest of the page's view applied as usual)
          if (large && hooks.onLarge) await hooks.onLarge(tx, large);
          const skip = new Set(large?.replay ?? []);
          last = await applyView({ w, tx, ns, store: idbStore(tx, prefix), cap, ownPlaced }, changed.filter((id) => !skip.has(id)));
        },
        afterLarge: hooks.afterLarge,
      });
      keep();
    } finally {
      w.tell({ ops: told });
    }
    if (gone.length) await w.dropContents(gone).catch((err) => console.warn("sync: dropping forgotten contents:", err));
    return { ...r, listed };
  })();
}

/** The client's `onIndex` (sync-client.ts) for the confirmed index and its view (step 4).  D11: a pending replay (a
 * large move's view) is driven to its end before any later page (r5 §4's barrier); a large move published by a page
 * starts its replay in the same transaction, and the replay runs once its confirmed rewrite has drained.  A page the
 * fence refuses (`busy`: a local large move is being applied under it) waits for that move, then applies. */
export const confirmedIndex = (w: Workspace) => async (page: { ns: string; ops: SyncOp[] }) => {
  const { runReplay, startReplay, startForget } = await import("./sync-replay");
  const { rewriting } = await import("./sync-rewrite");
  for (let tries = 0; ; tries++) {
    try {
      await runReplay(w, page.ns);
      await applyConfirmed(w, page.ns, page.ops, {
        onLarge: async (tx, large) => {
          if (!large.maps.length) return;
          // (the entries' one record reserved for the replay's plan: a local large move pending there makes the
          // page wait for it (r3 §3a's both slots))
          if (large.forget) return startForget(tx, page.ns, large.rec.gen);
          if ((await req(tx.objectStore("entries").getKey(RW))) !== undefined) throw busy();
          await startReplay(tx, page.ns, large.rec.gen, large.maps.map((m) => m.to));
        },
        afterLarge: () => runReplay(w, page.ns),
      });
      return;
    } catch (e) {
      if (!((e as { code?: string })?.code === "busy") || tries > 10_000) throw e;
      // (a local large move holds the entries: its drain awaited, then the page applied again)
      for (;;) {
        const r = await rewriting(w.ws);
        if (!r || r.kind !== "local" || r.stuck) break;
        await new Promise((ok) => setTimeout(ok, 500));
      }
      await new Promise((ok) => setTimeout(ok, 200));
    }
  }
};
const busy = () => Object.assign(new Error("a large move is still being applied here"), { code: "busy" });

/** The durable cursor of `ns` (0 before any page). */
export async function cursorOf(w: Workspace, ns: string): Promise<number> {
  return ((await inTx(w.ws, META, "readonly", (tx) => req(tx.objectStore(META).get(cursorKey(ns))))) as number | undefined) ?? 0;
}

/** One entry of the confirmed index, or its gone path (tests, the view). */
export async function confirmedEntry(w: Workspace, ns: string, id: string): Promise<SyncEntry | { gone: string } | undefined> {
  return inTx(w.ws, ["syncIndex", META], "readonly", async (tx) => {
    const gen = ((await req(tx.objectStore(META).get(genKey(ns)))) as number | undefined) ?? 0;
    // (through the store: a large move being rewritten read at its projection, D11)
    const store = idbStore(tx, genPrefix(ns, gen)), e = await store.byId(id);
    if (e) return e;
    const g = await store.gone(id);
    return g !== undefined ? { gone: g } : undefined;
  });
}

export { OVERLAY };
