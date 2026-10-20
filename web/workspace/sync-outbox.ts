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
import type { Kind } from "./paths";
import type { Op, Workspace } from "./api";
import { inTx, req } from "./db";
import { jsonTextSize } from "../notebook/stores.js";

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
 * `id`: the identity it is for (the index byIdent's key); `accepted`: the server's seq, once acked. */
export type OutboxRecord = { ns: string; dseq: number; lseq: number; id: string; op: WireOp; accepted?: number };
/** The outbox's totals: `bytes`, what its records hold now; `charged`, what they may come to hold, each at its
 * largest (accepted with the largest seq there is: chargeOf), the sum the bound is kept on, so accepting never
 * takes `bytes` past it (daybreak2's LIMIT-855-1); `full`: when a scan last stopped at a bound, until one goes on
 * (shown: status()). */
type Totals = { count: number; bytes: number; charged: number; full?: { at: number; count: number; bytes: number } };
const NONE: Totals = { count: 0, bytes: 0, charged: 0 };

const key = (ns: string, what: "scanned" | "dseq" | "outbox") => `sync:${ns}:${what}`;
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

/** What the server receives for a local op, or null for one not sent. */
export function wireOf(o: Op, dseq: number): WireOp | null {
  if (o.origin === "server" || !("after" in o) || o.after === undefined) return null;
  if (o.op === "dropVersions") return null;
  const op = o.op === "emptyTrash" || o.op === "discard" ? "forget" : o.op;
  const w: WireOp = { dseq, t: o.t, by: o.by, op, path: o.path, kind: o.kind };
  if (o.to !== undefined && op !== "forget") w.to = o.to;
  for (const k of ["ref", "fid", "parent", "sha256", "size", "base"] as const) if (o[k] !== undefined) (w as any)[k] = o[k];
  return w;
}

/** The sync state's current lease: the namespace in use and its generation; a new lease for `ns` (`switchTo`)
 * starts the next generation, in one transaction, so every lease taken before is fenced. */
export async function switchTo(w: Workspace, ns: string): Promise<Lease> {
  checkNs(ns);
  return inTx(w.ws, "meta", "readwrite", async (tx) => {
    const meta = tx.objectStore("meta"), cur = (await req(meta.get(CURRENT))) as Lease | undefined;
    const lease = { ns, gen: (cur?.gen ?? 0) + 1 };
    meta.put(lease, CURRENT);
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
    return inTx(this.w.ws, ["ops", "meta", "outbox"], "readwrite", async (tx) => {
      const meta = tx.objectStore("meta"), out = tx.objectStore("outbox");
      await fence(meta, this.lease);
      cut(0);
      const scanned = (await req(meta.get(key(this.ns, "scanned")))) as number | undefined;
      cut(1);
      if (scanned === undefined) throw new Error(`sync: ${this.ns} has no scan watermark yet (begin)`);
      let dseq = ((await req(meta.get(key(this.ns, "dseq")))) as number | undefined) ?? 1;
      cut(2);
      const t = { ...NONE, ...((await req(meta.get(key(this.ns, "outbox")))) as Totals | undefined) };
      cut(3);
      const ops = (await req(tx.objectStore("ops").getAll(IDBKeyRange.lowerBound(scanned, true), OUTBOX.page))) as Op[];
      cut(4);
      let at = scanned, made = 0, full = false;
      for (const o of ops) {
        const op = wireOf(o, dseq);
        if (op) {
          const r: OutboxRecord = { ns: this.ns, dseq, lseq: o.seq!, id: (o.after?.id ?? o.fid ?? o.ref)!, op };
          // (admitted at its charge, its largest: accepting it later never takes what is held past the bound)
          const c = chargeOf(r);
          if (t.count + 1 > OUTBOX.maxRecords || t.charged + c > OUTBOX.maxBytes) {
            full = true;
            break;
          }
          out.add(r);
          t.count++;
          t.bytes += recordBytes(r);
          t.charged += c;
          dseq++;
          made++;
        }
        at = o.seq!;
      }
      // (a page that stopped at a bound says so, until one goes on)
      if (full) t.full = { at: Date.now(), count: t.count, bytes: t.bytes };
      else delete t.full;
      meta.put(at, key(this.ns, "scanned"));
      meta.put(dseq, key(this.ns, "dseq"));
      meta.put(t, key(this.ns, "outbox"));
      cut(5);
      return { made, full, more: full || ops.length === OUTBOX.page };
    });
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

  /** An `ack`'s per-op decisions, under the lease: accepted (`seq`), the record kept until it is confirmed;
   * refused (`code`), the record removed at once.  In one transaction.  A dseq with no record (decided before)
   * is passed over. */
  async acked(results: ({ dseq: number; seq: number } | { dseq: number; code: string })[]): Promise<void> {
    await inTx(this.w.ws, ["outbox", "meta"], "readwrite", async (tx) => {
      const out = tx.objectStore("outbox"), meta = tx.objectStore("meta");
      await fence(meta, this.lease);
      const t = { ...NONE, ...((await req(meta.get(key(this.ns, "outbox")))) as Totals | undefined) };
      for (const d of results) {
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
          }
        } else {
          out.delete([this.ns, d.dseq]);
          t.count--;
          t.bytes -= recordBytes(r);
          t.charged -= chargeOf(r);
        }
      }
      meta.put(t, key(this.ns, "outbox"));
    });
  }

  /** Records confirmed (their echo in an `index`, or the confirmed index past their seq: C3), removed under the
   * lease, in one transaction, whether their ack came first or not. */
  async confirmed(dseqs: number[]): Promise<void> {
    await inTx(this.w.ws, ["outbox", "meta"], "readwrite", async (tx) => {
      const out = tx.objectStore("outbox"), meta = tx.objectStore("meta");
      await fence(meta, this.lease);
      const t = { ...NONE, ...((await req(meta.get(key(this.ns, "outbox")))) as Totals | undefined) };
      for (const dseq of dseqs) {
        const r = (await req(out.get([this.ns, dseq]))) as OutboxRecord | undefined;
        if (!r) continue;
        out.delete([this.ns, dseq]);
        t.count--;
        t.bytes -= recordBytes(r);
        t.charged -= chargeOf(r);
      }
      meta.put(t, key(this.ns, "outbox"));
    });
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
