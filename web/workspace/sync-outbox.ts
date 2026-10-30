// The sync client's outbox (design/sync-client.md §3, C1): the ops of the workspace's log that go up, each an
// immutable record with its device sequence number, made by one scan from a durable watermark.
//
// - Every local change records its op in `ops`, in its own transaction, with its identity (step 2a).  A scan
//   page, in one transaction, reads at most OUTBOX.page ops past the watermark `sync:<ns>:scanned`, makes their
//   records with the next `dseq`s (`sync:<ns>:dseq`), and advances the watermark: all of it or none, so a crash
//   leaves the whole page or nothing, and an op is never made into two records nor skipped.
// - The outbox is bounded by count (OUTBOX.maxRecords) and by the bytes of its records' JSON (OUTBOX.maxBytes),
//   kept in `sync:<ns>:outbox` and checked in the page's transaction.  When it is full the page stops there and
//   the watermark stays: the overflow checkpoint.  Local changes still save; the ops past the watermark are
//   found by the next scan, from it, once records are decided.
// - Ops not sent: those applied from the server (`origin: "server"`); those that change no entry or have no
//   identity yet (no `after`: dropVersions, or before ids were kept).  Emptying Trash and deleting a file too
//   large to move go as `forget`, the server's op for an identity removed for good.
// - A record's op is fixed when it is made and never changes; a `dseq` is never reused in its namespace.  A
//   record goes only when it is decided: refused (at once), or accepted and then confirmed (its echo, or the
//   confirmed index's seq: C3).  An ack alone leaves it "accepted, awaiting echo".  Nothing top-level (order,
//   rate, busy, a rebuild, the socket closing) removes a record.
// - The namespace `ns` is the account's hash, its generation and the device (`welcome`'s); each has its own
//   watermark, sequence and records, and one never sends another's.
// - One sender per device and namespace: the tab holding the Web Lock `sagebrush-sync:<ns>` (sender()).
// - dropOps (Workspace) never deletes ops past any namespace's watermark: they haven't been scanned yet.
import { TRASH, within, type Kind } from "./paths";
import type { Entry, Op, Workspace } from "./api";
import { inTx, req } from "./db";
import { entriesOf } from "./sync-rewrite";
import { jsonTextSize } from "../notebook/stores.js";
import { genKey, genPrefix } from "./sync-confirmed";
import { RELEASE_STORES, afterReleases, metaWrite, newEpoch, epochOf, lifeMarkOf, sameLife, type LifeMark, pendingOf, stateOf, putPending, release, pinPresent, pinOfCurrent, type NsState, type Pin } from "./sync-pins";
import { LedgerTx, isWire, queueObsolete, cleanObsoleteStep, hubOf } from "./sync-ledger";
import { PROTO, PROTO_KEY, OLD_SYNC_HOOK, OldSyncError, detectOldSync } from "./sync-old";

export const OUTBOX = {
  /** ops read per scan page */
  page: 500,
  /** records at most, in a namespace's outbox */
  maxRecords: 10_000,
  /** bytes at most of its records' JSON (UTF-8, keys and all) */
  maxBytes: 2 ** 20,
  /** (tests: called at each point of a page's transaction where it awaits (`at`, 0, 1, 2, …): throwing there
   * aborts the page whole, as a tab closed or killed at that point would) */
  cut: null as null | ((at: number) => void),
};
/** A namespace's lease: the generation of the sync state it was taken in (`sync:current`).  Every change to an
 * outbox, and every read of what to send, is made only under the current lease, checked in its own
 * transaction; a switch of namespace (another account, another generation) or a new connection starts a new
 * generation, so nothing taken under an older one, mid-flight across the switch, is ever sent or changes
 * anything (@sagebrush's (4)). */
export type Lease = { ns: string; gen: number };
export class Fenced extends Error {
  constructor(lease: Lease) { super(`sync: the lease for ${lease.ns} (generation ${lease.gen}) is no longer current`); }
}
const CURRENT = "sync:current";

/** An op as the server takes it (design/sync-server.md §5.2's `ops` item). */
export type WireOp = { dseq: number; t: number; by: string; op: string; path: string; to?: string; kind: Kind; ref?: string; fid?: string; parent?: string; sha256?: string; size?: number; base?: string };
/** An outbox record: its op, fixed when made, and its decision so far.  `lseq`: the local op it was made from;
 * `id`: the identity it is for (the index byIdent's key); `accepted`: the server's seq, once acked; `heldSeq`: a
 * successor's, the held write it carries (its ledger row is that one's, task #14). */
export type OutboxRecord = { ns: string; dseq: number; lseq: number; id: string; op: WireOp; accepted?: number; pin?: number; heldSeq?: number };
/** The ledger row a record owns (task #14, CORR-T14-1): a successor's held write, else its own op; none for a
 * journal's (lseq 0). */
export const ownedSeq = (r: OutboxRecord): number | undefined => r.heldSeq !== undefined ? (r.heldSeq > 0 ? r.heldSeq : undefined) : r.lseq > 0 ? r.lseq : undefined;
/** The outbox's totals: `bytes`, what its records hold now; `charged`, what they may come to hold, each at its
 * largest (accepted with the largest seq there is: chargeOf), the sum the bound is kept on, so accepting never
 * takes `bytes` past it (daybreak2's LIMIT-855-1); `full`: when a scan last stopped at a bound, until one goes on
 * (shown: status()). */
type Totals = { count: number; bytes: number; charged: number; full?: { at: number; count: number; bytes: number } };
const NONE: Totals = { count: 0, bytes: 0, charged: 0 };

const key = (ns: string, what: "scanned" | "dseq" | "outbox" | "successors") => `sync:${ns}:${what}`;
/** The committed reissue journal draining now (sync-rebuild.ts journalKey). */
const JOURNAL = (ns: string) => `sync:${ns}:journal`;
/** The sender's intent revision (D11 r6 §2): incremented by every transaction of the sender's that changes an intent
 * (an ack, an echo's confirmation with its held and successor bookkeeping, a scan, a journal's drain); a plan's
 * publication requires it unchanged since its pass began.  Local saves don't (they are fenced). */
export const intentRevKey = (ns: string) => `sync:${ns}:intentRev`;
export async function bumpIntents(meta: IDBObjectStore, ns: string) {
  meta.put((((await req(meta.get(intentRevKey(ns)))) as number | undefined) ?? 0) + 1, intentRevKey(ns));
}
const JOURNAL_PAGE = 100;
type JRec = { ns: string; id: string; parent: string; name: string; kind: Kind; sha256?: string; size?: number; trashed: boolean; gone?: true; sent?: true; from?: string };
/** A record's size, as the bound counts it: its JSON text, keys and all, as the workspace's inert JSON writer
 * writes it (notebook/stores.js, as TimeTravel's backlog counts an entry: 2a), two bytes a character, as the page
 * holds it. */
export function recordBytes(r: OutboxRecord): number {
  const n = jsonTextSize(r, Infinity);
  if (n < 0) throw new Error("sync: an outbox record that isn't plain JSON data");
  return 2 * n;
}
/** A record's charge against the bound: its size at its largest, accepted with the largest seq acked() takes
 * (Number.MAX_SAFE_INTEGER: sixteen digits), whether or not it is accepted yet. */
export const chargeOf = (r: OutboxRecord) => recordBytes({ ...r, accepted: Number.MAX_SAFE_INTEGER });
// (a namespace's form: what welcome gives, account hash, generation and device; nothing that could reach
// another's keys)
const NS = /^[0-9a-f]{16,64}:[0-9]{1,15}:[0-9a-f]{16}$/;
function checkNs(ns: string) {
  if (typeof ns !== "string" || !NS.test(ns)) throw new Error(`sync: not a namespace: ${String(ns).slice(0, 80)}`);
}

/** The rebuild's obligation (design/sync-client.md D6, D7 r2): `sync:<ns>:rebuild` = {why, n, at}.  Every write of it
 * increments `n` from a counter that never goes back (`sync:<ns>:rebuildN`, kept when the flag is cleared), in the
 * transaction that records the decision; a rebuild records the `n0` it started from, and only its `done`'s
 * compare-and-swap (n still n0) may clear the flag.  A stronger reason already recorded (invalid, diverged) stays. */
export type Obligation = { why: "refused" | "invalid" | "diverged"; n: number; at: number; detail?: string };
export const rebuildKey = (ns: string) => `sync:${ns}:rebuild`;
export async function obligate(meta: IDBObjectStore, ns: string, why: Obligation["why"], detail?: string): Promise<Obligation> {
  const cur = (await req(meta.get(rebuildKey(ns)))) as Obligation | undefined;
  const n = (((await req(meta.get(`sync:${ns}:rebuildN`))) as number | undefined) ?? cur?.n ?? 0) + 1;
  const keep = cur && cur.why !== "refused" && why === "refused";
  const o: Obligation = { why: keep ? cur!.why : why, n, at: Date.now(), ...(detail ? { detail: detail.slice(0, 300) } : keep && cur!.detail ? { detail: cur!.detail } : {}) };
  meta.put(n, `sync:${ns}:rebuildN`);
  meta.put(o, rebuildKey(ns));
  return o;
}

/** What the server receives for a local op, or null for one not sent. */
export function wireOf(o: Op, dseq: number): WireOp | null {
  // (what goes up as a record of its own: sync-ledger.ts's isWire, which the ledger's classes ask too)
  if (!isWire(o)) return null;
  const op = o.op === "emptyTrash" || o.op === "discard" ? "forget" : o.op;
  const w: WireOp = { dseq, t: o.t, by: o.by, op, path: o.path, kind: o.kind };
  if (o.to !== undefined && op !== "forget") w.to = o.to;
  for (const k of ["ref", "fid", "parent", "sha256", "size", "base"] as const) if (o[k] !== undefined) (w as any)[k] = o[k];
  return w;
}

/** The sync state's current lease: the namespace in use and its generation; a new lease for `ns` (`switchTo`)
 * starts the next generation, in one transaction, so every lease taken before is fenced. */
export async function switchTo(w: Workspace, ns: string): Promise<Lease> {
  return (await switchToIf(w, ns))!;
}
/** switchTo, and with `expect` only as a compare-and-set (step 5, astra3's CORR-PR130-1): if this browser's lifecycle is
 * still the one the action saw, in the same transaction; otherwise nothing is written and null is returned (a late
 * enable never replaces a newer lifecycle).  EXACT-ONLY: refused (OldSyncError, nothing written) where this browser
 * holds sync state from a build before the cutover (sync-old.ts), read afresh; the lease written with this build's
 * marker, in its transaction. */
export async function switchToIf(w: Workspace, ns: string, expect?: LifeMark): Promise<Lease | null> {
  checkNs(ns);
  const old = await detectOldSync(w);
  if (old.old) throw new OldSyncError(old.why ?? "", !!old.unreadable);
  await OLD_SYNC_HOOK.between?.();
  for (;;) {
    const r = await inTx(w.ws, "meta", "readwrite", async (tx) => {
      const meta = tx.objectStore("meta"), cur = (await req(meta.get(CURRENT))) as (Lease & { off?: boolean }) | undefined;
      // (step 5: the lifecycle the action saw, checked first in this transaction: a late enable writes nothing, not
      // even the ledger's queue)
      if (expect && !sameLife(await lifeMarkOf(meta), expect)) return { stale: true as const };
      // (EXACT-ONLY: without the marker, any sync meta written since the detection read is old sync state: refused)
      if ((await req(meta.get(PROTO_KEY))) !== PROTO && ((await req(meta.count(IDBKeyRange.bound("sync:", "sync;", false, true)))) as number) > 0) return { old: true as const };
      // (task #14: the namespace left queued for its ledger's deletion, the one taken out of the queue; a full queue:
      // nothing done, one cleanup step, and again (the compare-and-set read again in the next transaction))
      if (!(await queueObsolete(meta, cur?.ns, ns))) return null;
      const lease = { ns, gen: (cur?.gen ?? 0) + 1 };
      metaWrite(meta, CURRENT, lease);
      metaWrite(meta, PROTO_KEY, PROTO);
      OLD_SYNC_HOOK.fault?.("lease");
      // (another namespace: a lifecycle change, the previous one's pins purged (sync-pins: newEpoch); a reconnect,
      // or turning sync on again for the same namespace, isn't: its pins are kept)
      let ended: { ns: string; fromEpoch: number } | null = null;
      if (cur && cur.ns !== ns) {
        const fromEpoch = await epochOf(meta);
        await newEpoch(meta);
        if (!cur.off) ended = { ns: cur.ns, fromEpoch };
      }
      return { lease, ended };
    });
    if (!r) {
      await cleanObsoleteStep(w);
      continue;
    }
    if ("stale" in r) return null;
    if ("old" in r) throw new OldSyncError("meta");
    // (the waits of the namespace left told their epoch ended, by type (task #14))
    if (r.ended) hubOf(w.ws).post({ t: "lifecycle", ns: r.ended.ns, fromEpoch: r.ended.fromEpoch, toEpoch: r.ended.fromEpoch + 1, kind: "switch" });
    // (another namespace: the old one's purge, begun)
    afterReleases(w);
    return r.lease;
  }
}
/** A connection's renewal of its lease (step 5, plan r4 §2.1): a compare-and-set in one transaction.  The lease must
 * still be `ns`'s, not off, and the lifecycle epoch still `epoch`: then its generation is raised (the new holder's
 * token, which fences what an older one took), else Fenced and nothing written.  It never clears `off` and never
 * moves the epoch: only the enable flow (switchTo) does that. */
export async function renewLease(w: Workspace, ns: string, epoch: number): Promise<Lease> {
  checkNs(ns);
  return inTx(w.ws, "meta", "readwrite", async (tx) => {
    const meta = tx.objectStore("meta"), cur = (await req(meta.get(CURRENT))) as (Lease & { off?: boolean }) | undefined;
    const e = ((await req(meta.get("sync:epoch"))) as number | undefined) ?? 0;
    if (!cur || cur.off || cur.ns !== ns || e !== epoch) throw new Fenced({ ns, gen: cur?.gen ?? 0 });
    const lease = { ns, gen: cur.gen + 1 };
    metaWrite(meta, CURRENT, lease);
    return lease;
  });
}
/** The current lease, if any. */
export async function currentLease(w: Workspace): Promise<Lease | undefined> {
  return inTx(w.ws, "meta", "readonly", (tx) => req(tx.objectStore("meta").get(CURRENT))) as Promise<Lease | undefined>;
}
// (the lease checked in `meta`'s transaction: a Fenced error, which aborts it, if it isn't the current one)
async function fence(meta: IDBObjectStore, lease: Lease) {
  const cur = (await req(meta.get(CURRENT))) as Lease | undefined;
  if (!cur || cur.ns !== lease.ns || cur.gen !== lease.gen) throw new Fenced(lease);
}

/** A namespace's outbox in workspace `w`, used under `lease` (its namespace's, and current: checked in every
 * transaction). */
export class Outbox {
  readonly ns: string;
  constructor(readonly w: Workspace, readonly lease: Lease) {
    checkNs(lease.ns);
    this.ns = lease.ns;
  }

  /** The scan's start, for a namespace that has none yet (its first sync's watermark, W1: C3); a later one is
   * left as it is.  Returns the watermark. */
  async begin(at: number): Promise<number> {
    return inTx(this.w.ws, "meta", "readwrite", async (tx) => {
      const meta = tx.objectStore("meta");
      await fence(meta, this.lease);
      const cur = (await req(meta.get(key(this.ns, "scanned")))) as number | undefined;
      if (cur !== undefined) return cur;
      meta.put(at, key(this.ns, "scanned"));
      return at;
    });
  }

  /** The watermark, the next dseq, and the outbox's totals, with `full` when a scan last stopped at a bound (and
   * nothing has gone on since): what the foot and the Sync panel show ("too many changes waiting to sync", §5),
   * so a full outbox is never a silent stall (@sagebrush's (3)).  Readable under any lease. */
  async status(): Promise<{ scanned: number | undefined; nextDseq: number } & Totals> {
    return inTx(this.w.ws, "meta", "readonly", async (tx) => {
      const meta = tx.objectStore("meta");
      const scanned = (await req(meta.get(key(this.ns, "scanned")))) as number | undefined;
      const nextDseq = ((await req(meta.get(key(this.ns, "dseq")))) as number | undefined) ?? 1;
      const t = { ...NONE, ...((await req(meta.get(key(this.ns, "outbox")))) as Totals | undefined) };
      return { scanned, nextDseq, ...t };
    });
  }

  /** One scan page, in ONE transaction (@sagebrush's (1)): the lease checked; records made for the ops past the
   * watermark, with the next dseqs; the watermark advanced past every op looked at (made or not sent); the
   * next dseq and the totals written; the bounds kept.  A crash at any point of it leaves all of it or none.
   * `full`: it stopped at a bound (said in status() until a page goes on); `more`: ops may remain. */
  async scanPage(): Promise<{ made: number; full: boolean; more: boolean }> {
    const cut = (at: number) => OUTBOX.cut?.(at);
    const r = await inTx(this.w.ws, ["ops", "outbox", "syncIndex", "syncLedger", ...RELEASE_STORES], "readwrite", async (tx) => {
      const meta = tx.objectStore("meta"), out = tx.objectStore("outbox");
      await fence(meta, this.lease);
      await bumpIntents(meta, this.ns);
      // (each local op passed gets its ledger row, in this page's transaction: task #14)
      const lg = new LedgerTx(tx, this.ns);
      cut(0);
      const scanned = (await req(meta.get(key(this.ns, "scanned")))) as number | undefined;
      cut(1);
      if (scanned === undefined) throw new Error(`sync: ${this.ns} has no scan watermark yet (begin)`);
      // (a committed journal still draining: the scanner waits, so the journal's records come before any made for ops
      // after W1 (C3, astra's (b)))
      if ((await req(meta.get(JOURNAL(this.ns)))) !== undefined) return { made: 0, full: false, more: false };
      let dseq = ((await req(meta.get(key(this.ns, "dseq")))) as number | undefined) ?? 1;
      cut(2);
      const t = { ...NONE, ...((await req(meta.get(key(this.ns, "outbox")))) as Totals | undefined) };
      cut(3);
      const ops = (await req(tx.objectStore("ops").getAll(IDBKeyRange.lowerBound(scanned, true), OUTBOX.page))) as Op[];
      cut(4);
      let made = 0, full = false;
      const fits = (r: OutboxRecord) => t.count + 1 <= OUTBOX.maxRecords && t.charged + chargeOf(r) <= OUTBOX.maxBytes;
      const admit = (r: OutboxRecord) => {
        out.add(r);
        t.count++;
        t.bytes += recordBytes(r);
        t.charged += chargeOf(r);
        dseq++;
        made++;
      };
      let at = scanned;
      for (const o of ops) {
        const op = wireOf(o, dseq);
        if (op) {
          const id = (o.after?.id ?? o.fid ?? o.ref)!;
          const r: OutboxRecord = { ns: this.ns, dseq, lseq: o.seq!, id, op };
          if (o.kind === "file" && o.sha256 && (o.op === "create" || o.op === "write" || o.op === "adopt")) {
            const p = await pendingOf(tx, id), st = stateOf(p, this.ns);
            const pin = (await req(tx.objectStore("pins").get([id, o.seq!]))) as Pin | undefined;
            const waiting = st.successor !== undefined || st.held || (st.allocated?.state === "undecided" && !st.allocated.pinned);
            const covered = o.seq! <= (st.collapsed ?? -1) || o.seq! <= (st.cutoff ?? -1);
            // (collapsed or already represented: not sent, its pin let go; while a successor waits or an unpinned
            // record awaits its decision: held, not sent, its pin let go: its state goes as the current one)
            if (covered || waiting) {
              if (pin && !pin.owner) await release(tx, pin, true);
              if (covered) await lg.scanned(o.seq!, "superseded", { reason: "local" });
              else {
                // (held: the identity's newest held write, whose row the successor will own; an earlier held one is
                // superseded by it, its content going with the same successor)
                if (st.heldSeq !== undefined) await lg.supersede(st.heldSeq, "local", o.seq!);
                await lg.scanned(o.seq!, "local");
                putPending(tx, p, this.ns, { ...st, ...(st.successor === undefined ? { held: true } : {}), heldSeq: o.seq! }, o.seq!);
              }
              at = o.seq!;
              continue;
            }
            // (its base: the newest record it follows, undecided or accepted; else the newest accepted, not yet
            // confirmed; else the confirmed index's (its active generation's); else the op's own)
            const gen = ((await req(meta.get(genKey(this.ns)))) as number | undefined) ?? 0;
            const confirmed = (await req(tx.objectStore("syncIndex").get([genPrefix(this.ns, gen), id]))) as { sha256?: string; gone?: true } | undefined;
            const base = (st.allocated && st.allocated.state !== "confirmed" ? st.allocated.sha256 : undefined) ?? st.acceptedTip?.sha256 ?? confirmed?.sha256 ?? o.base;
            // (the same bytes as its base: nothing for the server to do)
            if (o.op === "write" && base === o.sha256) {
              await lg.scanned(o.seq!, "none", { reason: "not-synced" });
              at = o.seq!;
              continue;
            }
            if (base === undefined) delete op.base;
            else op.base = base;
            if (pin) r.pin = pin.seq;
            if (!fits(r)) { full = true; break; }
            if (pin) tx.objectStore("pins").put({ ...pin, owner: { ns: this.ns, dseq } } satisfies Pin);
            putPending(tx, p, this.ns, { ...st, allocated: { dseq, sha256: o.sha256, pinned: !!pin, state: "undecided" } }, o.seq!);
            admit(r);
            await lg.scanned(o.seq!, "local", { dseq: r.dseq });
            at = o.seq!;
            continue;
          }
          if (!fits(r)) { full = true; break; }
          admit(r);
          await lg.scanned(o.seq!, "local", { dseq: r.dseq });
        } else if (o.origin !== "server") await lg.scanned(o.seq!, "none", { reason: "not-synced" });
        at = o.seq!;
      }
      // (then, once this page has read every op logged (caught up, in this transaction), held identities'
      // successors whose records were decided: each the identity's current state, while there is room (C2, astra's
      // schedules 1, 2 and 5).  Only then: every op before it, of the identity and of the folders it is in (a
      // mkdir, a rename, a move, a removal), already has its record, so the successor comes after all of them,
      // with the state and place they left (astra's CORR-E5C-1).  One in Trash (itself, or a folder it is in)
      // waits there: a write would bring it back, and its removal stands (no resurrection, CORR-E5C-2); it goes
      // once restored, or ends as gone if it is deleted for good)
      const succKey = key(this.ns, "successors");
      const succ = ((await req(meta.get(succKey))) as string[] | undefined) ?? [];
      const caughtUp = !full && ops.length < OUTBOX.page;
      const left: string[] = [];
      for (const id of succ) {
        if (full || !caughtUp) { left.push(id); continue; }
        const p = await pendingOf(tx, id), st = stateOf(p, this.ns);
        if (!st.successor) continue;
        const e = await (await entriesOf(tx)).byIdent(id);
        const lseq = p.latest?.seq ?? 0;
        const next: NsState = { ...st, held: false, cutoff: Math.max(st.cutoff ?? 0, lseq) };
        delete next.successor;
        delete next.heldSeq;
        // (its current state gone (a forget or emptying Trash came first): no write made, no identity brought back;
        // the held write's row superseded by the op that took it)
        if (!e || e.kind !== "file" || !e.migrated || !e.sha256 || p.latest?.after === null) {
          if (st.heldSeq !== undefined) await lg.supersede(st.heldSeq, "local", p.latest?.seq);
          putPending(tx, p, this.ns, next, at);
          continue;
        }
        if (e.trashed || within(e.path, TRASH)) { left.push(id); continue; }
        const op: WireOp = { dseq, t: Date.now(), by: p.latest?.by ?? "person", op: "write", path: e.path, kind: "file", fid: e.fid!, sha256: e.sha256, size: e.size ?? 0, ...(st.successor.base ? { base: st.successor.base } : {}), ...(p.latest?.after?.parent ? { parent: p.latest.after.parent } : {}) };
        // (heldSeq always set on a successor: 0 when its held write isn't known (held before task #14): then it owns no
        // row, never its bookkeeping lseq's)
        const r: OutboxRecord = { ns: this.ns, dseq, lseq, id, op, heldSeq: st.heldSeq ?? 0 };
        // (its present bytes pinned for it: the pin on them now, else a new one, owned by this record)
        const cur = await pinOfCurrent(tx, e.fid!, e.sha256);
        r.pin = cur ? cur.seq : lseq;
        if (!fits(r)) { full = true; left.push(id); continue; }
        if (cur) tx.objectStore("pins").put({ ...cur, owner: { ns: this.ns, dseq } } satisfies Pin);
        else await pinPresent(tx, id, lseq, e.path, e.sha256, e.size ?? 0, e.fid!, { ns: this.ns, dseq });
        next.allocated = { dseq, sha256: e.sha256, pinned: true, state: "undecided" };
        admit(r);
        // (the held write's row now this record's: its decisions are that write's)
        if (r.heldSeq) await lg.own(r.heldSeq, r.dseq);
        putPending(tx, p, this.ns, next, at);
      }
      if (succ.length && left.length !== succ.length) meta.put(left, succKey);
      // (a page that stopped at a bound says so, until one goes on)
      if (full) t.full = { at: Date.now(), count: t.count, bytes: t.bytes };
      else delete t.full;
      meta.put(at, key(this.ns, "scanned"));
      meta.put(dseq, key(this.ns, "dseq"));
      meta.put(t, key(this.ns, "outbox"));
      await lg.finish();
      cut(5);
      return { made, full, more: full || ops.length === OUTBOX.page };
    });
    // (a pin released by the scan: its version prunable again, its file due; the cleanup begun)
    afterReleases(this.w);
    return r;
  }

  /**
   * One page of the committed journal's drain (C3, D6's reissue rules), in ONE transaction under the lease, as the
   * outbox has room.  Journal records are taken in rounds over their key order: a record goes once its folder has
   * gone (or is no journal record, or is the root), so parents go before their children.  Each is diffed against the
   * active confirmed index:
   * - present here, absent there: `mkdir`, or `adopt` (which syncs as a create; a data file with its bytes' pin);
   * - present in both, another folder or name: `rename`, its `parent` the folder's identity;
   * - another hash: `write`, its `base` the index's hash;
   * - in Trash here, not there: `remove`; out of Trash here, in it there: `restore`;
   * - gone here, present there (`forget`), after every present record has gone.
   * Each record is marked sent with its outbox records made, its pin handed to them.  When nothing is left the
   * journal is done: its key cleared and its prefix to the cleanup list; the scanner, idle until then, goes on from
   * the watermark (C3: the journal drains before anything the scanner makes for ops after W1).
   */
  async drainJournal(): Promise<{ made: number; full: boolean; more: boolean }> {
    // (no journal (the usual case, and always without the confirmed index): one read, nothing else)
    if ((await inTx(this.w.ws, "meta", "readonly", (tx) => req(tx.objectStore("meta").get(JOURNAL(this.ns))))) === undefined) return { made: 0, full: false, more: false };
    const r = await inTx(this.w.ws, ["outbox", "adoptJournal", "entries", "syncIndex", ...RELEASE_STORES], "readwrite", async (tx) => {
      const meta = tx.objectStore("meta"), out = tx.objectStore("outbox"), j = tx.objectStore("adoptJournal"), ix = tx.objectStore("syncIndex");
      await fence(meta, this.lease);
      await bumpIntents(meta, this.ns);
      const jp = (await req(meta.get(JOURNAL(this.ns)))) as string | undefined;
      if (!jp) return { made: 0, full: false, more: false };
      const posKey = JOURNAL(this.ns) + ":at";
      // (the position is the journal's own: one recorded for another generation (an earlier journal a rebuild
      // replaced) never applies, astra's CORR-PR65-IMPL-1; the installer also clears it with the switch)
      const fresh = { jp, round: 0, key: "", progress: false, gone: false };
      const saved = (await req(meta.get(posKey))) as typeof fresh | undefined;
      const pos = saved && saved.jp === jp ? saved : fresh;
      const gp = genPrefix(this.ns, ((await req(meta.get(genKey(this.ns)))) as number | undefined) ?? 0);
      let dseq = ((await req(meta.get(key(this.ns, "dseq")))) as number | undefined) ?? 1;
      const t = { ...NONE, ...((await req(meta.get(key(this.ns, "outbox")))) as Totals | undefined) };
      const scanned = (await req(meta.get(key(this.ns, "scanned")))) as number | undefined;
      const recs = (await req(j.getAll(IDBKeyRange.bound([jp, pos.key], [jp, "\uffff"], true), JOURNAL_PAGE))) as JRec[];
      let made = 0, full = false;
      const now = Date.now();
      const fits = (r: OutboxRecord) => t.count + 1 <= OUTBOX.maxRecords && t.charged + chargeOf(r) <= OUTBOX.maxBytes;
      // (a folder's path, here or in the index: where a record's own path is derived from; its `parent` decides)
      const pathOf = async (fid: string): Promise<string | undefined> => ((await (await entriesOf(tx)).byIdent(fid))?.path) ?? (((await req(ix.get([gp, fid]))) as { path?: string } | undefined)?.path);
      for (const jr of recs) {
        const before = pos.key;
        pos.key = jr.id;
        if (jr.id.startsWith("e:") || jr.sent) continue;
        // (gone ones after every present one: a second phase of rounds)
        if (!!jr.gone !== pos.gone) continue;
        const conf = (await req(ix.get([gp, jr.id]))) as (Record<string, unknown> & { path?: string; sha256?: string; trashed?: unknown; gone?: true }) | undefined;
        const live = conf && !conf.gone ? conf : undefined;
        const ops: WireOp[] = [];
        const ident: Partial<WireOp> = jr.kind === "file" || jr.kind === "folder" ? { fid: jr.id } : { ref: jr.id };
        const mk = (op: string, path: string, more: Partial<WireOp> = {}): WireOp => ({ dseq: 0, t: now, by: "person", op, path, kind: jr.kind, ...ident, ...more });
        if (jr.gone) {
          if (live) ops.push(mk("forget", live.path!));
        } else {
          // (its folder first: a parent still unsent in this journal waits for the next round)
          if (jr.parent) {
            const pj = (await req(j.get([jp, jr.parent]))) as (JRec & { skipped?: true }) | undefined;
            // (under a folder in Trash, gone, or itself not adopted: not adopted (C3), so nothing brings it back)
            if (pj && (pj.trashed || pj.gone || pj.skipped)) {
              j.put({ ...jr, sent: true, skipped: true });
              pos.progress = true;
              continue;
            }
            if (pj && !pj.sent) continue;
          }
          const folder = jr.parent ? ((await pathOf(jr.parent)) ?? "/") : "/";
          const placed = (folder === "/" ? "" : folder) + "/" + jr.name;
          const parent = jr.parent ? { parent: jr.parent } : {};
          const content = jr.kind === "file" ? { ...(jr.sha256 ? { sha256: jr.sha256 } : {}), ...(jr.size !== undefined ? { size: jr.size } : {}) } : {};
          const trashTo = TRASH + "/" + jr.name;
          if (!live) {
            const at = jr.trashed ? (jr.from ?? "/" + jr.name) : placed;
            ops.push(mk(jr.kind === "folder" ? "mkdir" : "adopt", at, { ...(jr.trashed ? {} : parent), ...content }));
            if (jr.trashed) ops.push(mk("remove", at, { to: trashTo }));
          } else {
            const inTrash = !!live.trashed;
            if (jr.trashed && !inTrash) ops.push(mk("remove", live.path!, { to: trashTo }));
            else if (!jr.trashed && inTrash) ops.push(mk("restore", live.path!, { to: placed, ...parent }));
            else if (!jr.trashed && live.path!.normalize("NFC") !== placed.normalize("NFC")) ops.push(mk("rename", live.path!, { to: placed, ...parent }));
            if (jr.kind === "file" && jr.sha256 && jr.sha256 !== live.sha256) ops.push(mk("write", jr.trashed ? live.path! : placed, { ...parent, ...content, ...(live.sha256 ? { base: live.sha256 as string } : {}) }));
          }
        }
        // (all of its records fit, or none of them now: the page stops, the record waits for room)
        const made1: OutboxRecord[] = ops.map((op, i) => ({ ns: this.ns, dseq: dseq + i, lseq: 0, id: jr.id, op: { ...op, dseq: dseq + i } }));
        let room = true;
        const tt = { ...t };
        for (const r of made1) {
          if (tt.count + 1 > OUTBOX.maxRecords || tt.charged + chargeOf(r) > OUTBOX.maxBytes) { room = false; break; }
          tt.count++;
          tt.charged += chargeOf(r);
        }
        // (no room: read again from just before it once records are decided)
        if (!room) { full = true; pos.key = before; break; }
        for (const r of made1) {
          // (a data file's bytes: its pin (the journal's, from retire), else its present bytes' if they are the record's)
          if ((r.op.op === "adopt" || r.op.op === "write") && r.op.sha256) {
            const owned = ((await req(tx.objectStore("pins").getAll(IDBKeyRange.bound([jr.id, -Infinity], [jr.id, Infinity])))) as Pin[]).find((x) => x.owner?.ns === jp && x.sha256 === r.op.sha256);
            const pin = owned ?? (await pinOfCurrent(tx, jr.id, r.op.sha256));
            if (pin) {
              r.pin = pin.seq;
              tx.objectStore("pins").put({ ...pin, owner: { ns: this.ns, dseq: r.dseq } } satisfies Pin);
            } else {
              const e = await (await entriesOf(tx)).byIdent(jr.id);
              if (e?.kind === "file" && e.migrated && e.sha256 === r.op.sha256 && !e.remote) {
                const np = await pinPresent(tx, jr.id, scanned ?? 0, e.path, e.sha256, e.size ?? 0, jr.id, { ns: this.ns, dseq: r.dseq });
                r.pin = np.seq;
              }
            }
            const pd = await pendingOf(tx, jr.id), st = stateOf(pd, this.ns);
            putPending(tx, pd, this.ns, { ...st, allocated: { dseq: r.dseq, sha256: r.op.sha256, pinned: r.pin !== undefined, state: "undecided" } }, scanned);
          }
          out.add(r);
          t.count++;
          t.bytes += recordBytes(r);
          t.charged += chargeOf(r);
          made++;
        }
        dseq += made1.length;
        j.put({ ...jr, sent: true });
        pos.progress = true;
      }
      let more = true;
      if (!full && recs.length < JOURNAL_PAGE) {
        // (the end of a round: another, while the last one made progress; then the gone phase; then done)
        if (pos.progress) Object.assign(pos, { round: pos.round + 1, key: "", progress: false });
        else if (!pos.gone) Object.assign(pos, { gone: true, round: 0, key: "", progress: false });
        else {
          // (drained: what is left unsent (under a folder that never went: the server refuses it, or a cycle) is
          // dropped with the journal; the journal's prefix to the cleanup list; the scanner goes on)
          meta.delete(JOURNAL(this.ns));
          meta.delete(posKey);
          const clean = ((await req(meta.get(`sync:${this.ns}:clean`))) as string[] | undefined) ?? [];
          meta.put([...clean, "j:" + jp], `sync:${this.ns}:clean`);
          more = false;
        }
      }
      if (more) meta.put(pos, posKey);
      if (full) t.full = { at: Date.now(), count: t.count, bytes: t.bytes };
      meta.put(dseq, key(this.ns, "dseq"));
      meta.put(t, key(this.ns, "outbox"));
      return { made, full, more };
    });
    return r;
  }

  /** Pages scanned until nothing is left past the watermark or the outbox is full. */
  async scan(): Promise<{ made: number; full: boolean }> {
    let made = 0;
    for (;;) {
      const r = await this.scanPage();
      made += r.made;
      if (r.full) return { made, full: true };
      if (!r.more) return { made, full: false };
    }
  }

  /** The records to send, in dseq order, from `from` (at most `n`), read under the lease: what is sent, and
   * resent unchanged after a reconnect (the server answers a resent one with its stored decision).  The lease
   * goes with them: the sender sends them only on its own connection, made under that lease (step 3). */
  async records(from = 1, n = 500): Promise<OutboxRecord[]> {
    return inTx(this.w.ws, ["meta", "outbox"], "readonly", async (tx) => {
      await fence(tx.objectStore("meta"), this.lease);
      return (await req(tx.objectStore("outbox").getAll(IDBKeyRange.bound([this.ns, from], [this.ns, Infinity]), n))) as OutboxRecord[];
    });
  }

  /** An `ack`'s per-op decisions, under the lease, in one transaction: accepted (`seq`), the record kept until
   * it is confirmed (its pin with it), its identity's newest accepted noted (`acceptedTip`, by dseq); refused
   * (`code`), the record removed at once and its pin released.  Either decides a held identity's record: its
   * successor (its current state, based on that answer) is then scheduled for the scan.  A dseq with no record
   * (decided before) is passed over. */
  async acked(results: ({ dseq: number; seq: number } | { dseq: number; code: string })[]): Promise<void> {
    await inTx(this.w.ws, ["outbox", "syncIndex", "syncLedger", ...RELEASE_STORES], "readwrite", async (tx) => {
      const out = tx.objectStore("outbox"), meta = tx.objectStore("meta");
      await fence(meta, this.lease);
      await bumpIntents(meta, this.ns);
      const t = { ...NONE, ...((await req(meta.get(key(this.ns, "outbox")))) as Totals | undefined) };
      const scanned = (await req(meta.get(key(this.ns, "scanned")))) as number | undefined;
      const lg = new LedgerTx(tx, this.ns);
      let refused = false, cuts = 100;
      for (const d of results) {
        OUTBOX.cut?.(cuts++);
        // (what the server says, checked at the boundary: a dseq and a seq are positive safe integers, a code a
        // short string; anything else refused whole, nothing changed)
        if (!Number.isSafeInteger(d.dseq) || d.dseq < 1) throw new Error("sync: an ack for a dseq that isn't a positive safe integer");
        if ("seq" in d ? !Number.isSafeInteger(d.seq) || d.seq < 0 : typeof (d as { code: unknown }).code !== "string" || (d as { code: string }).code.length > 64) throw new Error("sync: an ack whose decision isn't a non-negative safe integer seq (sixteen digits at most) or a short code");
        const r = (await req(out.get([this.ns, d.dseq]))) as OutboxRecord | undefined;
        if (!r) continue;
        if ("seq" in d) {
          if (r.accepted === undefined) {
            // (the record as it is now held, its seq with it: the totals count what it holds)
            const next = { ...r, accepted: d.seq };
            out.put(next);
            t.bytes += recordBytes(next) - recordBytes(r);
            await this.decided(tx, r, "accepted", scanned);
            const own = ownedSeq(r);
            if (own !== undefined) await lg.decide(own, r.dseq, "accepted");
          }
        } else {
          out.delete([this.ns, d.dseq]);
          t.count--;
          t.bytes -= recordBytes(r);
          t.charged -= chargeOf(r);
          await this.decided(tx, r, "refused", scanned);
          const own = ownedSeq(r);
          if (own !== undefined) await lg.decide(own, r.dseq, "refused", { code: d.code.slice(0, 64) });
          refused = true;
        }
      }
      // (a refusal's obligation, the rebuild (design/sync-client.md D6, D7), recorded in the transaction that removes
      // the record: a crash leaves both or neither.  A stronger reason already recorded (invalid, diverged) stays)
      if (refused) await obligate(meta, this.ns, "refused");
      OUTBOX.cut?.(cuts);
      meta.put(t, key(this.ns, "outbox"));
      await lg.finish();
    });
    afterReleases(this.w);
  }

  /** Records confirmed (their echo in an `index`, or the confirmed index past their seq: C3), removed under the
   * lease, in one transaction, their pins released, whether their ack came first or not (an echo first decides a
   * held identity's record as accepted). */
  async confirmed(dseqs: number[]): Promise<void> {
    await inTx(this.w.ws, ["outbox", "syncIndex", "syncLedger", ...RELEASE_STORES], "readwrite", async (tx) => {
      const out = tx.objectStore("outbox"), meta = tx.objectStore("meta");
      await fence(meta, this.lease);
      await bumpIntents(meta, this.ns);
      const t = { ...NONE, ...((await req(meta.get(key(this.ns, "outbox")))) as Totals | undefined) };
      const scanned = (await req(meta.get(key(this.ns, "scanned")))) as number | undefined;
      const lg = new LedgerTx(tx, this.ns);
      for (const dseq of dseqs) {
        const r = (await req(out.get([this.ns, dseq]))) as OutboxRecord | undefined;
        if (!r) continue;
        out.delete([this.ns, dseq]);
        t.count--;
        t.bytes -= recordBytes(r);
        t.charged -= chargeOf(r);
        await this.decided(tx, r, "confirmed", scanned);
        // (an echo first: accepted and confirmed at once; the row moves from local or accepted to confirmed)
        const own = ownedSeq(r);
        if (own !== undefined) await lg.decide(own, r.dseq, "confirmed");
      }
      meta.put(t, key(this.ns, "outbox"));
      await lg.finish();
    });
    afterReleases(this.w);
  }

  // (a record's decision, for its identity's pending state and its pin, in the deciding transaction: C2)
  private async decided(tx: IDBTransaction, r: OutboxRecord, how: "accepted" | "refused" | "confirmed", scanned: number | undefined) {
    const p = await pendingOf(tx, r.id), st: NsState = { ...stateOf(p, this.ns) };
    const mine = st.allocated?.dseq === r.dseq;
    const sha = r.op.sha256;
    // (its pin: kept while accepted (until the echo); released once refused or confirmed, not said as skipped: it
    // was decided)
    if (how !== "accepted" && r.pin !== undefined) {
      const pin = (await req(tx.objectStore("pins").get([r.id, r.pin]))) as Pin | undefined;
      if (pin && pin.owner?.ns === this.ns && pin.owner.dseq === r.dseq) await release(tx, { ...pin, owner: undefined });
    }
    if (how === "accepted") {
      if (mine) st.allocated = { ...st.allocated!, state: "accepted" };
      // (the newest accepted not yet confirmed, by dseq, whatever order acks come in)
      if (sha !== undefined && (!st.acceptedTip || st.acceptedTip.dseq < r.dseq)) st.acceptedTip = { dseq: r.dseq, sha256: sha };
    } else if (how === "confirmed") {
      if (mine) st.allocated = { ...st.allocated!, state: "confirmed" };
      if (st.acceptedTip && st.acceptedTip.dseq <= r.dseq) delete st.acceptedTip;
    } else if (mine) delete st.allocated;
    // (a held identity's record decided: its successor scheduled, based on the answer: this record's hash if it was
    // accepted (an echo first counts so), else the newest accepted, else the confirmed index's)
    if (st.held && mine) {
      const gen = ((await req(tx.objectStore("meta").get(genKey(this.ns)))) as number | undefined) ?? 0;
      const confirmedSha = ((await req(tx.objectStore("syncIndex").get([genPrefix(this.ns, gen), r.id]))) as { sha256?: string } | undefined)?.sha256;
      const base = how === "refused" ? (st.acceptedTip?.sha256 ?? confirmedSha) : sha;
      st.held = false;
      st.successor = base !== undefined ? { base } : {};
      const meta = tx.objectStore("meta"), k = key(this.ns, "successors");
      const list = ((await req(meta.get(k))) as string[] | undefined) ?? [];
      if (!list.includes(r.id)) meta.put([...list, r.id], k);
    }
    putPending(tx, p, this.ns, st, scanned);
  }
}

/** `f` as this device's one sender for `ns`: holding the Web Lock `sagebrush-sync:<ns>` (C1), the only tab with
 * the account socket and the only allocator of dseqs; the lock passes on when this tab closes, and the next
 * holder resumes from the durable state.  `ifAvailable`: not waiting for it (f gets false if another tab has it). */
export async function sender<T>(ns: string, f: (held: boolean) => Promise<T>, opts: { ifAvailable?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  checkNs(ns);
  const locks = (globalThis.navigator as any)?.locks;
  if (!locks?.request) throw new Error("sync: this browser has no Web Locks");
  return locks.request(`sagebrush-sync:${ns}`, { ifAvailable: !!opts.ifAvailable, ...(opts.signal ? { signal: opts.signal } : {}) }, (lock: unknown) => f(!!lock));
}

/** The lowest scan watermark of any namespace in `meta`'s transaction: what dropOps may never pass. */
export async function lowestWatermark(meta: IDBObjectStore): Promise<number | undefined> {
  const keys = (await req(meta.getAllKeys(IDBKeyRange.bound("sync:", "sync:￿")))) as string[];
  let low: number | undefined;
  for (const k of keys) {
    if (!k.endsWith(":scanned")) continue;
    const v = (await req(meta.get(k))) as number | undefined;
    if (typeof v === "number" && (low === undefined || v < low)) low = v;
  }
  return low;
}
