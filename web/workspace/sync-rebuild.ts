// The rebuild (design/sync-client.md D6 r2–r6, D7 r2; plan-sync-rebuilt r3 §4): when `sync:<ns>:rebuild` is set,
// before anything is sent.  A pass is a sequence of phases recorded in `sync:<ns>:pass`, every phase a series of
// transactions, each writing its own position with its effect:
//
//   clean    the cleanup list (`sync:<ns>:clean`) emptied first, 500 keys a transaction: at most two generations of
//            each store exist at once;
//   stage    a fresh generation `gen`: its staging index under `<ns>#<gen>` in syncIndex, its journal under
//            `<ns>#reissue#<gen>` in adoptJournal, both empty by construction; `n0`, `server_next` recorded once;
//   log      the server's log from seq 0, a page at a time, reduced into the staging index with the pass's own
//            cursor; this device's echoes matched (by the client) and staged in the pass's journal, never applied;
//   capture  the replaced records' identities (and their folders), and earlier journals' undrained records, written
//            to the pass's journal from their present local state; closed at W1, then (scanned, W1] replayed (own
//            intents only, wireOf's rule);
//   done     ONE transaction, a compare-and-swap on the obligation: n still n0, else the pass is discarded (its
//            generations to the cleanup list: pure deletion) and another begins;
//   view     the union of the active index's identities and the entries', in key order, 100 a transaction, the view
//            recomputed and applied (never deleting: kept and listed);
//   retire   staged confirmations applied; the replaced records and the earlier journals' undrained records removed,
//            each pin handed to the journal record of its identity or released;
//   announce `{t: "rebuilt", through: server_next - 1}`, recorded before it is sent; its ack a compare-and-swap that
//            clears the flag only if n is still n0.
//
// Nothing a pass writes is visible to the view, the scanner or the sender until its `done` succeeds.  Sending is halted
// throughout, until the announce's ack.
import type { Entry, Op, Workspace } from "./api";
import { inTx, req, hex } from "./db";
import { entriesOf, D11, RW, MAPS, queueKey, FENCE_READ, type EntriesView, type ERecord } from "./sync-rewrite";
import { markerKey, type Marker } from "./sync-replay";
import { TRASH, nameOf, parentOf } from "./paths";
import { genKey, genPrefix, cursorKey, idbStore, crecordKey, ledgerNs, againNs } from "./sync-confirmed";
import { VIEW_STORES, applyView, type JournalRecord, type ListedWhy } from "./sync-view";
import { rebuildKey, wireOf, recordBytes, chargeOf, type Obligation, type OutboxRecord } from "./sync-outbox";
import { RELEASE_STORES, release, pendingOf, stateOf, putPending, capNow, afterReleases, type Pin } from "./sync-pins";

/** A rebuild page's transaction: each writes its own position with its effect, so a page an OS crash loses (relaxed
 * durability: committed to the browser, not yet flushed) is simply done again; a tab's crash loses nothing committed. */
const RELAXED: IDBTransactionOptions = { durability: "relaxed" };

export const REBUILD = {
  /** records or identities a capture, view or retire transaction takes at most */
  page: 100,
  /** ops a closing replay transaction reads at most */
  replayPage: 500,
  /** keys a cleanup transaction deletes at most */
  cleanPage: 500,
  /** IndexedDB requests a capture or retire transaction makes at most (it stops early to stay under) */
  requests: 400,
  /** (tests: called at each named point of a phase's transaction; throwing there aborts it whole) */
  cut: null as null | ((at: string) => void),
  /** (tests: awaited by the client's driver before each phase it runs, with the phase's name and its page count; and
   * at "rebuilt-ack", inside the announce's answer before it is recorded, with `again`, the driver run once more; and
   * at "halt", between a halt in memory and its flag's write) */
  before: null as null | ((phase: string, ns: string, again?: () => void) => Promise<void>),
};

export type Phase = "stage" | "log" | "capture" | "done" | "view" | "retire" | "announce";
export type Pass = {
  phase: Phase;
  gen: number;
  /** the obligation counter's value this pass services (D7 r2) */
  n0: number;
  /** welcome.next_dseq of the connection that found the divergence: the server's decided prefix */
  serverNext: number;
  /** a capture ran: the scan watermark moves to W1 at `done` */
  captured?: boolean;
  W0?: number;
  W1?: number;
  /** a phase's durable position */
  at?: { step?: string; key?: string; seq?: number; dseq?: number };
  /** the active journal before this pass's `done` (its undrained records are replaced, then cleaned) */
  oldJournal?: string;
  /** announce: through = serverNext - 1 */
  through?: number;
  /** (D11) the view's deferred ranges: debts' confirmed keys */
  deferred?: string[];
  /** counts, for the tests and the foot's progress */
  pages?: { log: number; capture: number; view: number; retire: number; clean: number };
};

const passKey = (ns: string) => `sync:${ns}:pass`;
const passCursorKey = (ns: string) => `sync:${ns}:pass:cursor`;
const genNextKey = (ns: string) => `sync:${ns}:genNext`;
export const cleanKey = (ns: string) => `sync:${ns}:clean`;
/** The committed reissue journal draining now (its prefix in adoptJournal), if any. */
export const journalKey = (ns: string) => `sync:${ns}:journal`;
export const floorKey = (ns: string) => `sync:${ns}:floor`;
export const journalPrefix = (ns: string, gen: number) => `${ns}#reissue#${gen}`;
const echoId = (dseq: number) => "e:" + String(dseq).padStart(16, "0");
const isEcho = (id: string) => id.startsWith("e:");
const META = "meta";
const cut = (at: string) => REBUILD.cut?.(at);
const bump = (p: Pass, k: keyof NonNullable<Pass["pages"]>) => {
  p.pages = { log: 0, capture: 0, view: 0, retire: 0, clean: 0, ...(p.pages ?? {}) };
  p.pages[k]++;
};

export async function passOf(w: Workspace, ns: string): Promise<Pass | undefined> {
  return inTx(w.ws, META, "readonly", (tx) => req(tx.objectStore(META).get(passKey(ns)))) as Promise<Pass | undefined>;
}
export async function obligationOf(w: Workspace, ns: string): Promise<Obligation | undefined> {
  return inTx(w.ws, META, "readonly", (tx) => req(tx.objectStore(META).get(rebuildKey(ns)))) as Promise<Obligation | undefined>;
}
/** The pass's own log cursor (its staging index's). */
export async function passCursor(w: Workspace, ns: string): Promise<number> {
  return ((await inTx(w.ws, META, "readonly", (tx) => req(tx.objectStore(META).get(passCursorKey(ns))))) as number | undefined) ?? 0;
}

// ---- clean

/** One cleanup page: at most REBUILD.cleanPage keys of the list's first prefix deleted.  Returns whether any is left. */
export async function cleanStep(w: Workspace, ns: string): Promise<boolean> {
  return inTx(w.ws, [META, "syncIndex", "adoptJournal"], "readwrite", async (tx) => {
    const meta = tx.objectStore(META);
    const list = ((await req(meta.get(cleanKey(ns)))) as string[] | undefined) ?? [];
    if (!list.length) return false;
    const [what, prefix] = [list[0].slice(0, 1), list[0].slice(2)];
    const st = tx.objectStore(what === "i" ? "syncIndex" : "adoptJournal");
    const keys = (await req(st.getAllKeys(IDBKeyRange.bound([prefix, ""], [prefix, "\uffff"]), REBUILD.cleanPage))) as IDBValidKey[];
    for (const k of keys) st.delete(k);
    cut("clean");
    if (keys.length < REBUILD.cleanPage) {
      // (a generation's large-move record goes with it (D11 r2 §5))
      if (what === "i") meta.delete(crecordKey(prefix));
      list.shift();
      if (list.length) meta.put(list, cleanKey(ns));
      else meta.delete(cleanKey(ns));
    }
    return list.length > 0;
  }, RELAXED);
}

// ---- stage

/**
 * A pass begun (or the current one returned): `n0` and `server_next` recorded once, a fresh generation drawn.  Returns
 * "halt" when the server waits for a dseq this device can't produce (a gap in [server_next, local next) with no
 * record: D6 r2), and "clean" while the cleanup list isn't empty (a new pass's stage waits for it, D6 r3).
 */
export async function stage(w: Workspace, ns: string, serverNext: number): Promise<Pass | "halt" | "clean" | "none"> {
  return inTx(w.ws, [META, "outbox"], "readwrite", async (tx) => {
    const meta = tx.objectStore(META);
    const cur = (await req(meta.get(passKey(ns)))) as Pass | undefined;
    if (cur) return cur;
    const flag = (await req(meta.get(rebuildKey(ns)))) as Obligation | undefined;
    if (!flag) return "none";
    if (((await req(meta.get(cleanKey(ns)))) as string[] | undefined)?.length) return "clean";
    const localNext = ((await req(meta.get(`sync:${ns}:dseq`))) as number | undefined) ?? 1;
    // (the server waits at server_next: every dseq from it to the local next must be a record here, sent in order)
    if (serverNext < localNext) {
      const have = (await req(tx.objectStore("outbox").count(IDBKeyRange.bound([ns, serverNext], [ns, localNext - 1])))) as number;
      if (have !== localNext - serverNext) return "halt";
    }
    // (alloc_floor: the next dseq only rises; a device behind the server (a restored older copy) allocates from it)
    if (serverNext > localNext) meta.put(serverNext, `sync:${ns}:dseq`);
    const gen = (((await req(meta.get(genNextKey(ns)))) as number | undefined) ?? (((await req(meta.get(genKey(ns)))) as number | undefined) ?? 0)) + 1;
    meta.put(gen, genNextKey(ns));
    const p: Pass = { phase: "log", gen, n0: flag.n, serverNext, pages: { log: 0, capture: 0, view: 0, retire: 0, clean: 0 } };
    meta.put(p, passKey(ns));
    meta.put(0, passCursorKey(ns));
    return p;
  });
}

// ---- log

/** Echoes matched by the client in a log page, staged in the pass's journal (D6 r5): `{dseq, seq}`, never applied to
 * the live outbox before `done`.  A failed pass discards them with its generation. */
export async function stageEchoes(w: Workspace, ns: string, p: Pass, echoes: { dseq: number; seq: number }[]) {
  if (!echoes.length) return;
  const jp = journalPrefix(ns, p.gen);
  await inTx(w.ws, "adoptJournal", "readwrite", async (tx) => {
    const st = tx.objectStore("adoptJournal");
    for (const e of echoes) st.put({ ns: jp, id: echoId(e.dseq), dseq: e.dseq, seq: e.seq });
  });
}

/** The log read to its end: on to `capture`. */
export async function logDone(w: Workspace, ns: string) {
  await setPass(w, ns, (p) => ({ ...p, phase: "capture", at: { step: "records", dseq: 0 } }));
}

async function setPass(w: Workspace, ns: string, f: (p: Pass) => Pass) {
  await inTx(w.ws, META, "readwrite", async (tx) => {
    const meta = tx.objectStore(META), p = (await req(meta.get(passKey(ns)))) as Pass | undefined;
    if (p) meta.put(f(p), passKey(ns));
  });
}

// ---- capture

/** A journal record of `e`'s present state (its folder's identity, or "" for the root). */
async function stateRecord(ev: EntriesView, jp: string, e: Entry, n: { requests: number }): Promise<JournalRecord> {
  let parent = "";
  const folder = parentOf(e.trashed ? e.trashed.from : e.path);
  if (folder !== "/" && folder !== TRASH && !e.trashed) {
    n.requests++;
    parent = (await ev.get(folder))?.fid ?? "";
  }
  return { ns: jp, id: e.ident!, parent, name: nameOf(e.path), kind: e.kind, ...(e.kind === "file" ? { sha256: e.sha256, size: e.size } : {}), trashed: !!e.trashed, ...(e.trashed ? { from: e.trashed.from } : {}) };
}

/** `id`'s present state, and its folders', into journal `jp` (an identity already there is left: the walk's record
 * stands until the replay assigns it). */
async function captureId(tx: IDBTransaction, jp: string, id: string, kind: Entry["kind"], n: { requests: number }) {
  const ev = await entriesOf(tx), j = tx.objectStore("adoptJournal");
  n.requests += 2;
  if ((await req(j.getKey([jp, id]))) !== undefined) return;
  const e = await ev.byIdent(id);
  if (!e) {
    n.requests++;
    j.put({ ns: jp, id, parent: "~gone", name: "", kind, trashed: false, gone: true } satisfies JournalRecord);
    return;
  }
  n.requests++;
  j.put(await stateRecord(ev, jp, e, n));
  // (its folders, to the root: a folder made or moved here and not yet confirmed is where its entries go)
  if (e.trashed) return;
  for (let p = parentOf(e.path); p !== "/" && p !== TRASH; p = parentOf(p)) {
    n.requests += 2;
    const f = await ev.get(p);
    if (!f?.ident) break;
    if ((await req(j.getKey([jp, f.ident]))) !== undefined) break;
    n.requests++;
    j.put(await stateRecord(ev, jp, f, n));
  }
}

/**
 * One capture transaction (D6 r3, A3, A4).  Steps, each resumable from its position:
 * - records: the replaced records (dseq < server_next, in dseq order) and their folders;
 * - journals: the earlier journals' undrained records (the active reissue journal, and the first sync's);
 * - close: W1 the latest op, W0 the scan watermark, in one short transaction holding the workspace's lock;
 * - replay: the ops in (W0, W1], 500 a transaction, own intents only (wireOf's rule): each one's identity assigned
 *   from its `after` (null: gone).
 * Returns whether the capture is done.
 */
export async function captureStep(w: Workspace, ns: string): Promise<boolean> {
  const p0 = await passOf(w, ns);
  if (!p0 || p0.phase !== "capture") return true;
  if (p0.at?.step === "close") {
    // (the boundary: inside the lock, every local change's op is either at most W1 or after it)
    await w.locked(() => inTx(w.ws, [META, "ops"], "readwrite", async (tx) => {
      const meta = tx.objectStore(META), p = (await req(meta.get(passKey(ns)))) as Pass;
      const W1 = await new Promise<number>((ok, no) => { const c = tx.objectStore("ops").openKeyCursor(null, "prev"); c.onsuccess = () => ok((c.result?.key as number | undefined) ?? 0); c.onerror = () => no(c.error); });
      const W0 = ((await req(meta.get(`sync:${ns}:scanned`))) as number | undefined) ?? W1;
      meta.put({ ...p, W0, W1, at: { step: "replay", seq: W0 } }, passKey(ns));
    }));
    return false;
  }
  return inTx(w.ws, [META, "outbox", "entries", "adoptJournal", "ops"], "readwrite", async (tx) => {
    const meta = tx.objectStore(META);
    const p = (await req(meta.get(passKey(ns)))) as Pass;
    const jp = journalPrefix(ns, p.gen), n = { requests: 2 };
    const at = { ...(p.at ?? { step: "records", dseq: 0 }) };
    bump(p, "capture");
    if (at.step === "records") {
      const lo = (at.dseq ?? 0) + 1;
      const recs = lo <= p.serverNext - 1 ? ((await req(tx.objectStore("outbox").getAll(IDBKeyRange.bound([ns, lo], [ns, p.serverNext - 1]), REBUILD.page))) as OutboxRecord[]) : [];
      n.requests++;
      for (const r of recs) {
        if (n.requests > REBUILD.requests - 40) break;
        await captureId(tx, jp, r.id, r.op.kind, n);
        at.dseq = r.dseq;
        p.captured = true;
      }
      if (recs.length === 0 || (recs.length < REBUILD.page && at.dseq === recs[recs.length - 1].dseq)) Object.assign(at, { step: "journals", key: "", dseq: undefined });
    } else if (at.step === "journals") {
      // (the journal still draining, if any: an earlier pass's reissue journal, or the first sync's adoption journal)
      const active = (await req(meta.get(journalKey(ns)))) as string | undefined;
      const prefixes = active ? [active] : [];
      if (!prefixes.length) {
        Object.assign(at, { step: p.captured ? "close" : "skip", key: undefined });
        if (!p.captured) {
          meta.put({ ...p, phase: "done", at: undefined }, passKey(ns));
          cut("capture");
          return true;
        }
        meta.put({ ...p, at }, passKey(ns));
        cut("capture");
        return false;
      }
      const [which, from] = (at.key ?? "").includes("\u0001") ? (at.key as string).split("\u0001") : [prefixes[0], ""];
      const j = tx.objectStore("adoptJournal");
      const recs = (await req(j.getAll(IDBKeyRange.bound([which, from], [which, "\uffff"], true), REBUILD.page))) as JournalRecord[];
      n.requests++;
      let last = from;
      for (const r of recs) {
        if (n.requests > REBUILD.requests - 40) break;
        last = r.id;
        if (isEcho(r.id) || r.sent) continue;
        await captureId(tx, jp, r.id, r.kind, n);
        p.captured = true;
      }
      if (recs.length < REBUILD.page && (recs.length === 0 || last === recs[recs.length - 1].id)) {
        const i = prefixes.indexOf(which);
        if (i + 1 < prefixes.length) at.key = prefixes[i + 1] + "\u0001";
        else Object.assign(at, { step: p.captured ? "close" : "skip", key: undefined });
      } else at.key = which + "\u0001" + last;
      if ((at.step as string) === "skip") {
        // (nothing replaced, nothing undrained: no capture, the watermark stays; straight to done)
        meta.put({ ...p, phase: "done", at: undefined }, passKey(ns));
        cut("capture");
        return true;
      }
    } else if (at.step === "replay") {
      // (an empty (W0, W1]: nothing logged since the watermark)
      const ops = (at.seq ?? 0) < p.W1! ? ((await req(tx.objectStore("ops").getAll(IDBKeyRange.bound(at.seq ?? 0, p.W1!, true, false), REBUILD.replayPage))) as Op[]) : [];
      const j = tx.objectStore("adoptJournal");
      for (const o of ops) {
        at.seq = o.seq;
        // (own intents only: what the server applied, dropVersions, and ops without an identity yet pass (D6 r4))
        if (wireOf(o, 0) === null) continue;
        const id = (o.after?.id ?? o.fid ?? o.ref)!;
        if (o.after === null) {
          j.put({ ns: jp, id, parent: "~gone", name: "", kind: o.kind, trashed: false, gone: true } satisfies JournalRecord);
          continue;
        }
        const a = o.after!;
        let from: string | undefined;
        if (a.trashed) from = (await (await entriesOf(tx)).byIdent(id))?.trashed?.from;
        j.put({ ns: jp, id, parent: a.parent ?? "", name: a.name, kind: a.kind, ...(a.kind === "file" ? { sha256: a.sha256, size: a.size } : {}), trashed: a.trashed, ...(from ? { from } : {}) } satisfies JournalRecord);
      }
      if (ops.length < REBUILD.replayPage || at.seq === p.W1) {
        meta.put({ ...p, phase: "done", at: undefined }, passKey(ns));
        cut("capture");
        return true;
      }
    }
    cut("capture");
    meta.put({ ...p, at }, passKey(ns));
    return false;
  }, RELAXED);
}

// ---- done

/**
 * `done`: ONE transaction, a compare-and-swap on the obligation (D6 r3, D7 r2).  n still n0: the active generation
 * switches to the pass's, the old one to the cleanup list; the live cursor is the pass's; the scan watermark W1 if a
 * capture ran, and the pass's journal is the active one.  Otherwise the pass's generations go to the cleanup list and
 * the pass is dropped: nothing live was touched, so this is pure deletion.  The flag stays set either way: only the
 * announce's ack clears it.
 */
export async function done(w: Workspace, ns: string): Promise<"committed" | "failed" | "wait"> {
  return inTx(w.ws, [META, "entries"], "readwrite", async (tx) => {
    const meta = tx.objectStore(META), st = tx.objectStore("entries");
    const p = (await req(meta.get(passKey(ns)))) as Pass;
    // (D11 r4 §4: the timed interval starts with no entries record pending: a local large move made since `stage`
    // is waited for (its own 300 s), this compare-and-swap retried after it; a published plan likewise)
    FENCE_READ.add(tx);
    const rw = (await req(st.get(RW))) as ERecord | undefined;
    if (rw && (rw.kind === "local" || rw.published)) return "wait";
    const flag = (await req(meta.get(rebuildKey(ns)))) as Obligation | undefined;
    const clean = ((await req(meta.get(cleanKey(ns)))) as string[] | undefined) ?? [];
    const jp = journalPrefix(ns, p.gen);
    cut("done");
    if (!flag || flag.n !== p.n0) {
      meta.put([...clean, "i:" + genPrefix(ns, p.gen), "j:" + jp], cleanKey(ns));
      meta.delete(passKey(ns));
      meta.delete(passCursorKey(ns));
      return "failed";
    }
    const old = ((await req(meta.get(genKey(ns)))) as number | undefined) ?? 0;
    meta.put(p.gen, genKey(ns));
    // (the replaced generation's view work superseded, in this transaction (r5 §4, N6 §3): its replay marker, its
    // debts, an unpublished plan; this pass's view recomputes every identity)
    const mk = (await req(meta.get(markerKey(ns)))) as Marker | undefined;
    if (mk && mk.gen !== genPrefix(ns, p.gen)) meta.delete(markerKey(ns));
    meta.delete(IDBKeyRange.bound(`sync:${ns}:debt:`, `sync:${ns}:debt;`, false, true));
    meta.delete(`sync:${ns}:moreDebts`);
    if (rw && !rw.published) {
      st.delete(RW);
      st.delete(IDBKeyRange.bound(`${MAPS}${rw.rid}/`, `${MAPS}${rw.rid}0`, false, true));
      st.delete(queueKey(rw.rid));
    }
    // (with it, its large forget's ledgers, if any (N6 §3): cleaned with their generation)
    meta.put([...clean, "i:" + genPrefix(ns, old), "i:" + ledgerNs(genPrefix(ns, old)), "i:" + againNs(genPrefix(ns, old))], cleanKey(ns));
    meta.put((await req(meta.get(passCursorKey(ns)))) ?? 0, cursorKey(ns));
    const next: Pass = { ...p, phase: "view", at: { key: "" } };
    if (p.captured) {
      meta.put(p.W1, `sync:${ns}:scanned`);
      const active = (await req(meta.get(journalKey(ns)))) as string | undefined;
      if (active) next.oldJournal = active;
      meta.put(jp, journalKey(ns));
      // (the drain's position goes with the switch: the new journal is walked from its start (CORR-PR65-IMPL-1))
      meta.delete(journalKey(ns) + ":at");
    }
    meta.put(next, passKey(ns));
    return "committed";
  });
}

// ---- view

/** The next identities after `at` in the union of the index generation `gp`'s and the entries', in key order. */
async function nextIds(tx: IDBTransaction, gp: string, at: string, n: number): Promise<string[]> {
  // (two requests: each source's next n, merged; their first n in key order are the union's next n)
  const ix = ((await req(tx.objectStore("syncIndex").getAllKeys(IDBKeyRange.bound([gp, at], [gp, "\uffff"], true), n))) as [string, string][]).map((k) => k[1]);
  const ents = ((await req(tx.objectStore("entries").index("byIdent").getAll(IDBKeyRange.lowerBound(at, true), n))) as Entry[]).map((e) => e.ident!);
  const all = [...new Set([...ix, ...ents])].sort();
  return all.slice(0, n);
}

/** One view page (D6 r4): at most REBUILD.page identities of the union, the view recomputed against the now-active
 * index and applied, never deleting; the position in the same transaction.  Returns whether the walk is done. */
export async function viewStep(w: Workspace, ns: string): Promise<{ done: boolean; ops: Op[]; listed: [string, ListedWhy][] }> {
  const cap = await capNow();
  return w.locked(() => inTx(w.ws, [...new Set([...VIEW_STORES, "syncIndex", META])], "readwrite", async (tx) => {
    const meta = tx.objectStore(META), p = (await req(meta.get(passKey(ns)))) as Pass;
    const gp = genPrefix(ns, p.gen);
    // (one past the page, to know whether this page is the last: so the walk takes exactly ⌈union / page⌉ pages)
    const peek = await nextIds(tx, gp, p.at?.key ?? "", REBUILD.page + 1);
    const ids = peek.slice(0, REBUILD.page);
    // (D11 r4 §4: a lift of more than D11.chunk entries is never made here: a debt (one row), replayed after resume;
    // identities in a deferred range passed over (their confirmed key compared, read only when there are debts))
    const deferred = p.deferred ?? [];
    const inDeferred = (k: string) => deferred.some((d) => k === d || k.startsWith(d + "/"));
    const skip = new Set<string>();
    if (deferred.length) for (const id of ids) {
      const r = (await req(tx.objectStore("syncIndex").get([gp, id]))) as { key?: string } | undefined;
      if (r?.key && inDeferred(r.key)) skip.add(id);
    }
    const debts: string[] = [];
    const v = ids.length ? await applyView({ w, tx, ns, store: idbStore(tx, gp), journalNs: journalPrefix(ns, p.gen), cap, keepGone: true, range: { lo: ids[0], hi: ids[ids.length - 1], prefix: gp }, replacedBelow: p.serverNext, large: { chunk: D11.chunk, debt: (it) => debts.push(it.id), deferred: (id) => skip.has(id) } }, ids) : { ops: [], gone: [], listed: [] };
    if (debts.length) {
      let nd = (await req(meta.count(IDBKeyRange.bound(`sync:${ns}:debt:`, `sync:${ns}:debt;`, false, true)))) as number;
      for (const id of debts) {
        const c = (await req(tx.objectStore("syncIndex").get([gp, id]))) as { key?: string } | undefined;
        if (!c?.key) continue;
        deferred.push(c.key);
        // (at the cap: one "more debts" row, replayed after resume as a walk of the whole generation (r6))
        if (nd < D11.debts) meta.put(c.key, `sync:${ns}:debt:${String(nd++).padStart(4, "0")}`);
        else meta.put(true, `sync:${ns}:moreDebts`);
      }
      p.deferred = deferred;
    }
    bump(p, "view");
    cut("view");
    const fin = peek.length <= REBUILD.page;
    meta.put(fin ? { ...p, phase: "retire", at: { step: "echoes", key: "" } } : { ...p, at: { key: ids[ids.length - 1] } }, passKey(ns));
    return { done: fin, ops: v.ops, listed: v.listed };
  }, RELAXED));
}

// ---- retire

/**
 * One retire transaction (D6 r3, r5): its steps, each a page of at most REBUILD.page records:
 * - echoes: the staged confirmations applied: each matched record removed, its pin released (Outbox semantics);
 * - replaced: the records with dseq < server_next left, removed, each pin handed to the pass's journal record of its
 *   identity when that record wants the same bytes, else released; the identity's pending state cut at W1 (A3);
 * - old: the earlier journals' undrained records removed the same way (their prefix then to the cleanup list).
 * Returns whether retire is done (the phase then `announce`, with through = server_next - 1).
 */
export async function retireStep(w: Workspace, ns: string): Promise<boolean> {
  const r = await inTx(w.ws, ["outbox", "adoptJournal", ...RELEASE_STORES], "readwrite", async (tx) => {
    const meta = tx.objectStore(META), out = tx.objectStore("outbox"), j = tx.objectStore("adoptJournal"), pins = tx.objectStore("pins");
    const p = (await req(meta.get(passKey(ns)))) as Pass;
    const jp = journalPrefix(ns, p.gen);
    const at = { ...(p.at ?? { step: "echoes", key: "" }) };
    const totalsKey = `sync:${ns}:outbox`;
    const t = { count: 0, bytes: 0, charged: 0, ...((await req(meta.get(totalsKey))) as object | undefined) } as { count: number; bytes: number; charged: number };
    const scanned = (await req(meta.get(`sync:${ns}:scanned`))) as number | undefined;
    bump(p, "retire");
    // (pending states exist only for identities with local changes: their keys read once a page when there are few,
    // so a record without one costs no request for it)
    const npend = (await req(tx.objectStore("pending").count())) as number;
    const pendKeys = npend <= 2_000 ? new Set((await req(tx.objectStore("pending").getAllKeys())) as string[]) : null;
    /** A record removed: its totals, its pin handed to `to` (a journal record wanting its bytes) or released. */
    const remove = async (rec: OutboxRecord, keepFor?: JournalRecord) => {
      out.delete([ns, rec.dseq]);
      t.count--;
      t.bytes -= recordBytes(rec);
      t.charged -= chargeOf(rec);
      if (rec.pin !== undefined) {
        const pin = (await req(pins.get([rec.id, rec.pin]))) as Pin | undefined;
        if (pin && pin.owner?.ns === ns && pin.owner.dseq === rec.dseq) {
          if (keepFor && !keepFor.gone && keepFor.sha256 === pin.sha256) pins.put({ ...pin, owner: { ns: keepFor.ns, dseq: 0 } } satisfies Pin);
          else await release(tx, { ...pin, owner: undefined });
        }
      }
      if (pendKeys && !pendKeys.has(rec.id)) return;
      const pd = await pendingOf(tx, rec.id), st = { ...stateOf(pd, ns) };
      if (st.allocated?.dseq === rec.dseq) delete st.allocated;
      if (st.acceptedTip?.dseq === rec.dseq) delete st.acceptedTip;
      delete st.held;
      delete st.successor;
      if (p.W1 !== undefined) st.cutoff = Math.max(st.cutoff ?? 0, p.W1);
      putPending(tx, pd, ns, st, scanned);
    };
    // (a page takes REBUILD.page items across its steps, in order; each step's read asks for one more than the room
    // left, so a step that ends is passed at once, and a page with no room left only peeks: the walk ends on its
    // last full page, never an empty one)
    let fin = false, room = REBUILD.page;
    while (at.step !== "end") {
      if (at.step === "echoes") {
        const echoes = (await req(j.getAll(IDBKeyRange.bound([jp, at.key || "e:"], [jp, "e:\uffff"], !!at.key), room + 1))) as { id: string; dseq: number; seq: number }[];
        // (their records read by one range: staged in dseq order)
        const page = echoes.slice(0, room);
        const byDseq = new Map(page.length ? ((await req(out.getAll(IDBKeyRange.bound([ns, page[0].dseq], [ns, page[page.length - 1].dseq])))) as OutboxRecord[]).map((r) => [r.dseq, r]) : []);
        for (const e of page) {
          const rec = byDseq.get(e.dseq);
          if (rec) await remove(rec);
          j.delete([jp, e.id]);
          at.key = e.id;
        }
        const took = Math.min(room, echoes.length);
        room -= took;
        if (echoes.length > took) break;
        Object.assign(at, { step: "replaced", dseq: 0, key: undefined });
      } else if (at.step === "replaced") {
        const lo = (at.dseq ?? 0) + 1;
        const recs = lo <= p.serverNext - 1 ? ((await req(out.getAll(IDBKeyRange.bound([ns, lo], [ns, p.serverNext - 1]), room + 1))) as OutboxRecord[]) : [];
        for (const rec of recs.slice(0, room)) {
          // (its journal record read only when it has bytes to hand over)
          const jr = rec.pin !== undefined ? ((await req(j.get([jp, rec.id]))) as JournalRecord | undefined) : undefined;
          await remove(rec, jr);
          at.dseq = rec.dseq;
        }
        const took = Math.min(room, recs.length);
        room -= took;
        if (recs.length > took) break;
        Object.assign(at, { step: p.oldJournal ? "old" : "end", key: "", dseq: undefined });
      } else if (at.step === "old") {
        const old = p.oldJournal!;
        const recs = (await req(j.getAll(IDBKeyRange.bound([old, at.key ?? ""], [old, "\uffff"], !!at.key), room + 1))) as JournalRecord[];
        for (const r of recs.slice(0, room)) {
          // (an undrained record's pin (C3: the journal owns its records' pins until they drain), handed on or released)
          const owned = r.sha256 ? ((await req(pins.getAll(IDBKeyRange.bound([r.id, -Infinity], [r.id, Infinity])))) as Pin[]).filter((x) => x.owner?.ns === old) : [];
          if (owned.length) {
            const mine = (await req(j.get([jp, r.id]))) as JournalRecord | undefined;
            for (const pin of owned) {
              if (mine && !mine.gone && mine.sha256 === pin.sha256) pins.put({ ...pin, owner: { ns: jp, dseq: 0 } } satisfies Pin);
              else await release(tx, { ...pin, owner: undefined });
            }
          }
          j.delete([old, r.id]);
          at.key = r.id;
        }
        const took = Math.min(room, recs.length);
        room -= took;
        if (recs.length > took) break;
        Object.assign(at, { step: "end", key: undefined });
      }
    }
    if (at.step === "end") {
      fin = true;
      const clean = ((await req(meta.get(cleanKey(ns)))) as string[] | undefined) ?? [];
      // (the old journal's prefix to the cleanup list; an uncaptured pass's journal (staged echoes only) too)
      const more = [...(p.oldJournal ? ["j:" + p.oldJournal] : []), ...(!p.captured ? ["j:" + jp] : [])];
      if (more.length) meta.put([...clean, ...more], cleanKey(ns));
      meta.put({ ...p, phase: "announce", at: undefined, through: p.serverNext - 1 }, passKey(ns));
    } else meta.put({ ...p, at }, passKey(ns));
    meta.put(t, totalsKey);
    cut("retire");
    return fin;
  }, RELAXED);
  afterReleases(w);
  return r;
}

// ---- announce

/**
 * The announce's ack (plan-sync-rebuilt r3 §4), ONE transaction: the acknowledged floor recorded, kept whatever
 * happens next; then, only if the obligation counter is still the `n0` this pass's `done` serviced, the flag cleared
 * and the pass ended (sending resumes).  Otherwise the flag stays, and another pass runs.
 */
export async function acked(w: Workspace, ns: string, floor: number): Promise<"resumed" | "again"> {
  return inTx(w.ws, [META, "entries"], "readwrite", async (tx) => {
    const meta = tx.objectStore(META), p = (await req(meta.get(passKey(ns)))) as Pass | undefined;
    // (D11 r4 §4: the view's debts, replayed after resume as one logical move, its own deadline; a later confirmed
    // page waits for it (r5 §4))
    const debts = (await req(meta.getAll(IDBKeyRange.bound(`sync:${ns}:debt:`, `sync:${ns}:debt;`, false, true)))) as string[];
    const more = (await req(meta.get(`sync:${ns}:moreDebts`))) !== undefined;
    if (p && (debts.length || more) && !(await req(meta.get(markerKey(ns))))) {
      const now = Date.now(), rid = hex(8);
      meta.put({ gen: genPrefix(ns, p.gen), rid, kind: "debts", ranges: more ? ["/"] : debts, phase: "pass", start: now, deadline: now + D11.deadlineMs, times: {} } satisfies Marker, markerKey(ns));
      meta.delete(IDBKeyRange.bound(`sync:${ns}:debt:`, `sync:${ns}:debt;`, false, true));
      meta.delete(`sync:${ns}:moreDebts`);
      FENCE_READ.add(tx);
      const st = tx.objectStore("entries");
      if ((await req(st.getKey(RW))) === undefined) st.put({ path: RW, rid, kind: "reserved", published: false, rev: 1, n: 0, fails: 0, at: now } satisfies ERecord);
    }
    const prev = (await req(meta.get(floorKey(ns)))) as number | undefined;
    meta.put(Math.max(prev ?? 0, floor), floorKey(ns));
    meta.delete(passKey(ns));
    meta.delete(passCursorKey(ns));
    const flag = (await req(meta.get(rebuildKey(ns)))) as Obligation | undefined;
    if (p && flag && flag.n === p.n0) {
      meta.delete(rebuildKey(ns));
      return "resumed";
    }
    return flag ? "again" : "resumed";
  });
}

/** `invalid` on the announce (through >= next_dseq: server_next was stale): the pass is ended, the flag kept, and
 * the next pass starts from `stage` with the newest welcome (its committed index stays). */
export async function announceInvalid(w: Workspace, ns: string) {
  await inTx(w.ws, META, "readwrite", async (tx) => {
    const meta = tx.objectStore(META);
    meta.delete(passKey(ns));
    meta.delete(passCursorKey(ns));
  });
}
